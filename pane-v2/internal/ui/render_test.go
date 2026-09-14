package ui

import (
	"context"
	"encoding/json"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"
	"github.com/mattn/go-runewidth"

	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/ident"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// fakeSource is a relay.Source the test owns: no network at all.
type fakeSource struct {
	ch     chan relay.Msg
	posts  []string
	bodies []map[string]any
	// postErr, when set, is every write's answer, with a 409 status.
	postErr error
	// gets records the paths read. getBody, getStatus and getErr are what a
	// read answers; a zero status means 200.
	gets      []string
	getBody   string
	getStatus int
	getErr    error
	// reconnects counts Reconnect calls.
	reconnects int
}

func newFakeSource() *fakeSource { return &fakeSource{ch: make(chan relay.Msg, 16)} }

func (f *fakeSource) Msgs() <-chan relay.Msg { return f.ch }
func (f *fakeSource) Post(_ context.Context, path string, body map[string]any) (int, error) {
	f.posts = append(f.posts, path)
	f.bodies = append(f.bodies, body)
	if f.postErr != nil {
		return 409, f.postErr
	}
	return 200, nil
}
func (f *fakeSource) Get(_ context.Context, path string) ([]byte, int, error) {
	f.gets = append(f.gets, path)
	if f.getErr != nil {
		return nil, 0, f.getErr
	}
	status := f.getStatus
	if status == 0 {
		status = 200
	}
	return []byte(f.getBody), status, nil
}
func (f *fakeSource) Reconnect() { f.reconnects++ }

var frozen = time.Date(2026, 9, 6, 12, 1, 44, 0, time.UTC)

func loadFixture(t *testing.T) relay.State {
	t.Helper()
	b, err := os.ReadFile("../../testdata/fixtures/snapshot.json")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	var st relay.State
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	if len(st.Sessions) == 0 {
		t.Fatal("fixture has no sessions")
	}
	return st
}

// newModel builds a model wired to fakes and sized, with time frozen.
func newModel(t *testing.T, w, h int, res ident.Result) (Model, relay.State) {
	t.Helper()
	st := loadFixture(t)
	src := newFakeSource()
	m := New(src, ident.Static{R: res}, Config{
		RelayURL:  "http://127.0.0.1:4317",
		StartMode: ModeVitals,
		Now:       func() time.Time { return frozen },
	})
	m.now = frozen
	tm, _ := m.Update(tea.WindowSizeMsg{Width: w, Height: h})
	m = tm.(Model)
	return m, st
}

func feed(t *testing.T, m Model, msgs ...tea.Msg) Model {
	t.Helper()
	for _, msg := range msgs {
		tm, _ := m.Update(msg)
		m = tm.(Model)
		m.now = frozen
	}
	return m
}

// assertFrame is the invariant every render must satisfy: exactly h lines of
// exactly w cells, no tabs, no wrapped rows.
func assertFrame(t *testing.T, out string, w, h int) {
	t.Helper()
	if w <= 0 || h <= 0 {
		return
	}
	lines := strings.Split(out, "\n")
	if len(lines) != h {
		t.Fatalf("frame has %d lines, want %d", len(lines), h)
	}
	for i, ln := range lines {
		if strings.Contains(ln, "\t") {
			t.Fatalf("line %d contains a tab", i)
		}
		if got := ansi.StringWidth(ln); got != w {
			t.Fatalf("line %d measures %d cells, want %d: %q", i, got, w, ansi.Strip(ln))
		}
	}
}

var (
	truecolorRe = regexp.MustCompile(`[34]8;2;\d+;\d+;\d+`)
	indexedRe   = regexp.MustCompile(`[34]8;5;(\d+)`)
)

// assertPaletteOnly holds the pane to the terminal's own colour scheme. Two
// claims, and the first is the one that matters: the frame must contain no
// 24-bit sequence at all, so every colour the user sees is one their terminal
// theme chose. The second keeps drift out of the indices we do use.
func assertPaletteOnly(t *testing.T, out string) {
	t.Helper()
	if m := truecolorRe.FindString(out); m != "" {
		t.Fatalf("frame emits the 24-bit sequence %q; the pane must inherit the terminal scheme", m)
	}
	allowed := map[int]bool{}
	for _, i := range theme.Indexes {
		allowed[i] = true
	}
	for _, mth := range indexedRe.FindAllStringSubmatch(out, -1) {
		n, err := strconv.Atoi(mth[1])
		if err != nil {
			t.Fatalf("unparseable SGR colour index %q", mth[1])
		}
		if n > 15 {
			t.Fatalf("colour index %d is outside ANSI 0-15, so the terminal scheme does not own it", n)
		}
		if !allowed[n] {
			t.Fatalf("colour index %d is not in the palette", n)
		}
	}
}

// invertRuns counts reverse-video blocks: the brand, the active tab and, while
// a two-press delete or clear is armed, its confirm row. Never more than three.
//
// Reverse is emitted as an attribute ahead of the colour (`1;7;38;5;3`), so it
// is always bracketed -- which is what keeps a colour index of 7 from being
// counted as one.
func invertRuns(out string) int {
	return strings.Count(out, "\x1b[7;") + strings.Count(out, ";7;")
}

func TestVitalsFrameInvariantAtEveryBreakpoint(t *testing.T) {
	sizes := []struct{ w, h int }{
		{60, 40}, {40, 40}, {30, 40}, // the three mockup widths
		{60, 18}, {60, 11}, {60, 7}, // the height ladder
		{24, 20}, {10, 6}, {4, 3}, // XS, tiny, blank
		{0, 0}, {1, 1}, {120, 60}, // the WindowSizeMsg{0,0} during pane creation
	}
	for _, sz := range sizes {
		st := loadFixture(t)
		m, _ := newModel(t, sz.w, sz.h, ident.Result{ID: st.Sessions[0].ID, How: ident.PaneTree})
		m = feed(t, m, relay.SnapshotMsg(st), IdentResult(ident.Result{
			ID: st.Sessions[0].ID, How: ident.PaneTree,
		}))
		out := m.Render()
		assertFrame(t, out, sz.w, sz.h)
		assertPaletteOnly(t, out)
		if n := invertRuns(out); n > 3 {
			t.Fatalf("%dx%d: %d black-on-yellow runs, want <= 3", sz.w, sz.h, n)
		}
	}
}

func TestNoInternalEventsEverRender(t *testing.T) {
	st := loadFixture(t)
	m, _ := newModel(t, 60, 40, ident.Result{ID: st.Sessions[0].ID, How: ident.PaneTree})
	m = feed(t, m, relay.SnapshotMsg(st), IdentResult(ident.Result{ID: st.Sessions[0].ID, How: ident.PaneTree}))
	for _, mode := range AllModes {
		m.mode = mode
		out := ansi.Strip(m.Render())
		if strings.Contains(out, "INTERNAL-SENTINEL-MUST-NOT-RENDER") {
			t.Fatalf("mode %v rendered an internal event", mode)
		}
		if strings.Contains(out, "steered from the pane") {
			t.Fatalf("mode %v rendered an internal event label", mode)
		}
	}
}

func TestDegradedStatesRenderAndHoldTheFrame(t *testing.T) {
	st := loadFixture(t)
	self := st.Sessions[0].ID

	cases := []struct {
		name  string
		build func(t *testing.T) Model
		want  string
	}{
		{
			// 7.1 relay down at start
			name: "wait-relay",
			build: func(t *testing.T) Model {
				m, _ := newModel(t, 40, 30, ident.Result{})
				return feed(t, m, relay.ConnMsg{
					State: relay.Down, Attempt: 2, RetryAt: frozen.Add(4 * time.Second),
				})
			},
			want: "waiting for the relay at",
		},
		{
			// 7.3 relay up, no sessions
			name: "no-sessions",
			build: func(t *testing.T) Model {
				m, _ := newModel(t, 40, 30, ident.Result{})
				return feed(t, m, relay.SnapshotMsg(relay.State{}))
			},
			want: "nothing has joined the board",
		},
		{
			// 7.3 with a sessions-index hint
			name: "expected",
			build: func(t *testing.T) Model {
				m, _ := newModel(t, 40, 30, ident.Result{})
				m = feed(t, m, relay.SnapshotMsg(relay.State{}))
				return feed(t, m, IdentResult(ident.Result{
					Expected: "00000000-dead-beef", ExpectedName: "demo-project",
				}))
			},
			want: "waiting for demo-project",
		},
		{
			// 7.4 sessions exist, none is mine
			name: "unpinned",
			build: func(t *testing.T) Model {
				m, _ := newModel(t, 40, 30, ident.Result{})
				m = feed(t, m, relay.SnapshotMsg(st))
				return feed(t, m, IdentResult(ident.Result{How: ident.None, Note: "2 sessions share cwd"}))
			},
			want: "WHICH SESSION IS YOURS?",
		},
		{
			// 7.5 my session went away, past the 3s debounce
			name: "gone",
			build: func(t *testing.T) Model {
				m, _ := newModel(t, 40, 30, ident.Result{ID: self, How: ident.PaneTree})
				m = feed(t, m, relay.SnapshotMsg(st), IdentResult(ident.Result{ID: self, How: ident.PaneTree}))
				m = feed(t, m, relay.SessionsMsg(st.Sessions[1:]))
				m.goneAt = frozen.Add(-12 * time.Second)
				return m
			},
			want: "GONE",
		},
		{
			// 7.6 relay lost mid-session: the mirror stays, greyed
			name: "relay-lost",
			build: func(t *testing.T) Model {
				m, _ := newModel(t, 40, 30, ident.Result{ID: self, How: ident.PaneTree})
				m = feed(t, m, relay.SnapshotMsg(st), IdentResult(ident.Result{ID: self, How: ident.PaneTree}))
				m = feed(t, m, relay.ConnMsg{State: relay.Down, RetryAt: frozen.Add(2 * time.Second)})
				m.toast = Toast{}
				return m
			},
			want: "relay lost",
		},
		{
			// 7.10 no write credential
			name: "read-only",
			build: func(t *testing.T) Model {
				src := newFakeSource()
				m := New(src, ident.Static{R: ident.Result{ID: self, How: ident.PaneTree}}, Config{
					RelayURL: "http://127.0.0.1:4317", ReadOnly: true,
					Now: func() time.Time { return frozen },
				})
				m.now = frozen
				tm, _ := m.Update(tea.WindowSizeMsg{Width: 60, Height: 30})
				m = tm.(Model)
				return feed(t, m, relay.SnapshotMsg(st), IdentResult(ident.Result{ID: self, How: ident.PaneTree}))
			},
			want: "read-only",
		},
		{
			// 7.7 too narrow: the XS strip
			name: "strip",
			build: func(t *testing.T) Model {
				m, _ := newModel(t, 20, 16, ident.Result{ID: self, How: ident.PaneTree})
				return feed(t, m, relay.SnapshotMsg(st), IdentResult(ident.Result{ID: self, How: ident.PaneTree}))
			},
			want: "MC",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := tc.build(t)
			out := m.Render()
			assertFrame(t, out, m.frame.W, m.frame.H)
			assertPaletteOnly(t, out)
			if !strings.Contains(ansi.Strip(out), tc.want) {
				t.Fatalf("%s: frame does not contain %q\n%s", tc.name, tc.want, ansi.Strip(out))
			}
		})
	}
}

// Every mode draws for real now, so none may fall through to the placeholder,
// and Built() is what says so.
func TestEveryModeIsBuilt(t *testing.T) {
	st := loadFixture(t)
	self := st.Sessions[0].ID
	m, _ := newModel(t, 60, 30, ident.Result{ID: self, How: ident.PaneTree})
	m = feed(t, m, relay.SnapshotMsg(st), IdentResult(ident.Result{ID: self, How: ident.PaneTree}))
	for _, mode := range AllModes {
		if !mode.Built() {
			t.Errorf("mode %v is built and must say so", mode)
		}
		m.mode = mode
		out := m.Render()
		if strings.Contains(ansi.Strip(out), "not built yet") {
			t.Errorf("mode %v renders the unbuilt placeholder", mode)
		}
		assertFrame(t, out, 60, 30)
		assertPaletteOnly(t, out)
	}
}

func TestModeKeysSwitchModes(t *testing.T) {
	st := loadFixture(t)
	m, _ := newModel(t, 60, 30, ident.Result{ID: st.Sessions[0].ID})
	m = feed(t, m, relay.SnapshotMsg(st))
	press := func(m Model, s string) Model {
		tm, _ := m.Update(tea.KeyPressMsg{Code: rune(s[0]), Text: s})
		return tm.(Model)
	}
	if m = press(m, "2"); m.Mode() != ModeFeed {
		t.Fatalf("2 should switch to FEED, got %v", m.Mode())
	}
	if m = press(m, "4"); m.Mode() != ModeBoard {
		t.Fatalf("4 should switch to BOARD, got %v", m.Mode())
	}
	if m = press(m, "5"); m.Mode() != ModeGrid {
		t.Fatalf("5 should select GRID, got %v", m.Mode())
	}
	if m = press(m, "1"); m.Mode() != ModeVitals {
		t.Fatalf("1 should switch to VITALS, got %v", m.Mode())
	}
}

func TestGoneIsDebouncedForThreeSeconds(t *testing.T) {
	st := loadFixture(t)
	self := st.Sessions[0].ID
	m, _ := newModel(t, 60, 30, ident.Result{ID: self, How: ident.PaneTree})
	m = feed(t, m, relay.SnapshotMsg(st), IdentResult(ident.Result{ID: self, How: ident.PaneTree}))
	m = feed(t, m, relay.SessionsMsg(st.Sessions[1:]))
	if m.gone() {
		t.Fatal("a session missing for 0s must not read as GONE")
	}
	m.now = frozen.Add(4 * time.Second)
	if !m.gone() {
		t.Fatal("a session missing for 4s must read as GONE")
	}
	// It comes back with the same id, as it does after a relay restart.
	m = feed(t, m, relay.SessionsMsg(st.Sessions))
	if m.gone() {
		t.Fatal("a returning session must clear GONE")
	}
}

// The sparkline takes its baseline from the data, the way the
// browser pane does. A flat series must not read as maxed out, and one that
// varies only in its top decile -- the ordinary shape of a token counter --
// must show that variation.
func TestSparkTakesItsBaselineFromTheData(t *testing.T) {
	flat := make([]int64, 12)
	for i := range flat {
		flat[i] = 4210
	}
	row := []rune(ansi.Strip(Spark(12, flat)))
	if strings.ContainsRune(string(row), '█') {
		t.Errorf("a flat series must not read as a solid block: %q", string(row))
	}
	if strings.Count(string(row), string(row[0])) != len(row) {
		t.Errorf("a flat series must sit at one level: %q", string(row))
	}

	got := ansi.Strip(Spark(6, []int64{4200, 4210, 4190, 4300, 4250, 4180}))
	levels := map[rune]bool{}
	for _, r := range got {
		levels[r] = true
	}
	if len(levels) < 3 {
		t.Errorf("a series varying in its top decile must vary on screen: %q", got)
	}
}

func TestGlyphsAreSingleWidth(t *testing.T) {
	runewidth.DefaultCondition.EastAsianWidth = false
	all := append([]string{}, theme.All...)
	for _, r := range theme.Spark {
		all = append(all, string(r))
	}
	for _, g := range all {
		for _, r := range g {
			if w := runewidth.RuneWidth(r); w != 1 {
				t.Fatalf("glyph %q (U+%04X) measures %d cells, want 1", string(r), r, w)
			}
		}
		if w := ansi.StringWidth(g); w != 1 {
			t.Fatalf("glyph %q measures %d cells by ansi.StringWidth, want 1", g, w)
		}
	}
}

// A question older than the plugin's 60s ASK_TIMEOUT_MS is dim and
// says the agent moved on; a younger one is not.
func TestStaleQuestionsSayTheAgentMovedOn(t *testing.T) {
	st := loadFixture(t)
	self := st.Sessions[0].ID
	mk := func(ageSec int) string {
		st2 := st
		st2.Questions = []relay.Question{{
			ID: "q1", SessionID: self, Question: "Which module path should the pane use?",
			T: relay.Millis(frozen.Add(-time.Duration(ageSec) * time.Second).UnixMilli()),
		}}
		m, _ := newModel(t, 60, 40, ident.Result{ID: self, How: ident.PaneTree})
		m = feed(t, m, relay.SnapshotMsg(st2), IdentResult(ident.Result{ID: self, How: ident.PaneTree}))
		out := m.Render()
		assertFrame(t, out, 60, 40)
		return ansi.Strip(out)
	}
	if young := mk(12); strings.Contains(young, "agent moved on") {
		t.Error("a 12s-old question must not be marked stale")
	}
	if old := mk(120); !strings.Contains(old, "agent moved on") {
		t.Errorf("a 120s-old question must be marked stale:\n%s", old)
	}
	if !strings.Contains(mk(12), "INBOX 1") {
		t.Error("an open question must show in the inbox count")
	}
}
