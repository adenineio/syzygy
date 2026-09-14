package ui

import (
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"

	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/ident"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// feedModel is a model sized w x h, pinned to the fixture's first session and
// already in FEED.
func feedModel(t *testing.T, w, h int) (Model, relay.State) {
	t.Helper()
	st := loadFixture(t)
	self := st.Sessions[0].ID
	m, _ := newModel(t, w, h, ident.Result{ID: self, How: ident.PaneTree})
	m = feed(t, m, relay.SnapshotMsg(st), IdentResult(ident.Result{ID: self, How: ident.PaneTree}))
	tm, _ := m.Update(tea.KeyPressMsg{Code: '2', Text: "2"})
	m = tm.(Model)
	m.now = frozen
	if m.Mode() != ModeFeed {
		t.Fatalf("pressing 2 left the pane in %v", m.Mode())
	}
	return m, st
}

// pressFeed sends one single-rune key press.
func pressFeed(t *testing.T, m Model, s string) Model {
	t.Helper()
	tm, _ := m.Update(tea.KeyPressMsg{Code: []rune(s)[0], Text: s})
	m = tm.(Model)
	m.now = frozen
	return m
}

// feedLines returns the rendered feed rows with the styling stripped: every
// line between the FEED section head and whatever section follows it.
func feedLines(t *testing.T, m Model) []string {
	t.Helper()
	var out []string
	seen := false
	for _, ln := range strings.Split(ansi.Strip(m.Render()), "\n") {
		if strings.HasPrefix(ln, theme.GTick+"FEED ") {
			seen = true
			continue
		}
		if !seen {
			continue
		}
		if strings.HasPrefix(ln, theme.GTick) {
			break
		}
		out = append(out, strings.TrimRight(ln, " "))
	}
	if !seen {
		t.Fatalf("no FEED section head in the frame:\n%s", ansi.Strip(m.Render()))
	}
	return out
}

// headFollow returns the FEED section head line, stripped.
func headFollow(t *testing.T, m Model) string {
	t.Helper()
	for _, ln := range strings.Split(ansi.Strip(m.Render()), "\n") {
		if strings.HasPrefix(ln, theme.GTick+"FEED ") {
			return ln
		}
	}
	t.Fatalf("no FEED section head in the frame")
	return ""
}

func TestFeedFrameInvariantAtEveryBreakpoint(t *testing.T) {
	sizes := []struct{ w, h int }{
		{60, 40}, {40, 40}, {30, 40}, // the three mockup widths
		{60, 18}, {60, 11}, {60, 7}, // the height ladder
		{24, 20}, {10, 6}, {4, 3}, // XS, tiny, blank
		{0, 0}, {1, 1}, {120, 60}, // the WindowSizeMsg{0,0} during pane creation
	}
	for _, sz := range sizes {
		m, _ := feedModel(t, sz.w, sz.h)
		out := m.Render()
		assertFrame(t, out, sz.w, sz.h)
		assertPaletteOnly(t, out)
		if strings.Contains(ansi.Strip(out), "not built yet") {
			t.Fatalf("%dx%d: FEED still renders the placeholder", sz.w, sz.h)
		}
	}
}

// The row grammar at each mockup width. The assertions are about the shape a
// reader sees -- where the detail column starts, what the timestamp is worth --
// not about the constants the renderer happens to use.
func TestFeedRowGrammarAtEachWidth(t *testing.T) {
	cases := []struct {
		w          int
		detailCol  int    // column the detail begins in, for a 4-char label
		timeFormat string // regexp the row must open with
	}{
		{60, 19, `^\d\d:\d\d:\d\d `}, // HH:MM:SS · glyph · label padded to 7
		{40, 15, `^\d\d:\d\d `},      // seconds dropped, padding to 6
		{30, 8, `^\S `},              // timestamp dropped entirely, padding to 5
	}
	for _, tc := range cases {
		m, _ := feedModel(t, tc.w, 30)
		lines := feedLines(t, m)
		if len(lines) < 4 {
			t.Fatalf("%d cols: only %d feed rows", tc.w, len(lines))
		}
		open := regexp.MustCompile(tc.timeFormat)
		for i, ln := range lines {
			if !open.MatchString(ln) {
				t.Fatalf("%d cols: row %d %q does not open with %s", tc.w, i, ln, tc.timeFormat)
			}
		}
		if tc.w == 30 && regexp.MustCompile(`^\d`).MatchString(lines[0]) {
			t.Fatalf("30 cols must drop the timestamp, got %q", lines[0])
		}
		if tc.w == 40 && regexp.MustCompile(`^\d\d:\d\d:`).MatchString(lines[0]) {
			t.Fatalf("40 cols must drop the seconds, got %q", lines[0])
		}

		// Every four-character label puts its detail in the same column: that
		// alignment is the whole point of padding the label field.
		measured := 0
		for i, ln := range lines {
			label := "Bash"
			at := strings.Index(ln, label)
			if at < 0 {
				continue
			}
			measured++
			end := at + len(label)
			for end < len(ln) && ln[end] == ' ' {
				end++
			}
			// Byte offsets are not columns: the glyph is three bytes wide.
			if got := fmtx.W(ln[:end]); got != tc.detailCol {
				t.Fatalf("%d cols: row %d %q starts its detail in column %d, want %d",
					tc.w, i, ln, got, tc.detailCol)
			}
		}
		if measured < 2 {
			t.Fatalf("%d cols: only %d rows carried the label under test", tc.w, measured)
		}
		assertPaletteOnly(t, m.Render())
	}
}

// The chip and the duration, against the fixture's one failing Bash call.
func TestFeedChipAndDurationOnTheErrorRow(t *testing.T) {
	m, st := feedModel(t, 60, 30)

	var errEvent relay.Event
	for _, e := range st.Events {
		if e.Status == "error" && e.SessionID == st.Sessions[0].ID {
			errEvent = e
		}
	}
	if errEvent.ID == "" {
		t.Fatal("fixture has no error event for the focused session")
	}

	var row string
	for _, ln := range feedLines(t, m) {
		if strings.Contains(ln, "ERR") {
			row = ln
		}
	}
	if row == "" {
		t.Fatalf("no ERR chip in the feed:\n%s", strings.Join(feedLines(t, m), "\n"))
	}
	if !strings.Contains(row, theme.GError) {
		t.Errorf("the error row must carry the error glyph %q: %q", theme.GError, row)
	}
	want := fmtx.Ms(int64(errEvent.Ms))
	if !strings.HasSuffix(row, want) {
		t.Errorf("the error row must end with its duration %q: %q", want, row)
	}
	if !strings.Contains(want, "s") || strings.Contains(want, "ms") {
		t.Errorf("a %dms call should render as seconds, got %q", errEvent.Ms, want)
	}

	// A sub-second call keeps milliseconds.
	if got := fmtx.Ms(89); got != "89ms" {
		t.Errorf("89ms rendered as %q", got)
	}
}

// Kind glyphs and the two chips, including the shapes the fixture has no
// example of.
func TestFeedGlyphsAndChipsByKind(t *testing.T) {
	f := NewFrame(60, 30)
	cases := []struct {
		kind, status string
		glyph, chip  string
	}{
		{"tool", "ok", theme.GTool, ""},
		{"turn", "", theme.GTurn, ""},
		{"agent", "", theme.GAgent, ""},
		{"note", "", theme.GNote, ""},
		{"tool", "error", theme.GError, "ERR"},
		{"tool", "deny", theme.GDeny, "DENY"},
		{"turn", "deny", theme.GDeny, "DENY"}, // status outranks kind
	}
	for _, tc := range cases {
		e := relay.Event{Kind: tc.kind, Status: tc.status, Label: "Bash", Detail: "rm -rf /"}
		row := ansi.Strip(feedRow(f, e))
		if !strings.Contains(row, tc.glyph) {
			t.Errorf("%s/%s: row %q lacks the glyph %q", tc.kind, tc.status, row, tc.glyph)
		}
		if tc.chip == "" {
			if strings.Contains(row, "ERR") || strings.Contains(row, "DENY") {
				t.Errorf("%s/%s: row %q should carry no chip", tc.kind, tc.status, row)
			}
			continue
		}
		if !strings.Contains(row, tc.chip) {
			t.Errorf("%s/%s: row %q lacks the chip %q", tc.kind, tc.status, row, tc.chip)
		}
	}
}

func TestFeedShowsOnlyTheFocusedSessionsPublicEvents(t *testing.T) {
	m, st := feedModel(t, 60, 40)
	self := st.Sessions[0].ID

	want := 0
	for _, e := range st.Events {
		if e.SessionID == self && !e.Internal {
			want++
		}
	}
	if want == 0 {
		t.Fatal("fixture has no public events for the focused session")
	}
	if got := len(filterFeed(st.Events, self)); got != want {
		t.Fatalf("filterFeed kept %d events, want %d", got, want)
	}
	for _, e := range filterFeed(st.Events, self) {
		if e.Internal {
			t.Fatal("filterFeed kept an internal event")
		}
		if e.SessionID != self {
			t.Fatalf("filterFeed kept another session's event %q", e.ID)
		}
	}
	if head := headFollow(t, m); !strings.Contains(head, "FEED "+strconv.Itoa(want)) {
		t.Errorf("the section head must count the filtered feed: %q", head)
	}
}

func TestFeedIsNewestFirst(t *testing.T) {
	f := NewFrame(60, 30)
	evs := []relay.Event{
		{Kind: "tool", Label: "Read", Detail: "oldest"},
		{Kind: "tool", Label: "Read", Detail: "middle"},
		{Kind: "tool", Label: "Read", Detail: "newest"},
	}
	rows := feedRows(f, evs, 3)
	if len(rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(rows))
	}
	for i, want := range []string{"newest", "middle", "oldest"} {
		if !strings.Contains(ansi.Strip(rows[i]), want) {
			t.Fatalf("row %d is %q, want the %s event", i, ansi.Strip(rows[i]), want)
		}
	}
}

// The widget takes its height as a parameter, so a caller that wants a
// three-row feed gets exactly three rows.
func TestFeedRowsHonourASmallBudget(t *testing.T) {
	f := NewFrame(60, 30)
	evs := make([]relay.Event, 20)
	for i := range evs {
		evs[i] = relay.Event{Kind: "tool", Label: "Read", Detail: "e"}
	}
	for _, budget := range []int{3, 1, 20, 25} {
		rows := feedRows(f, evs, budget)
		want := minInt(budget, len(evs))
		if len(rows) != want {
			t.Errorf("budget %d produced %d rows, want %d", budget, len(rows), want)
		}
		for i, r := range rows {
			if got := fmtx.W(ansi.Strip(r)); got != 60 {
				t.Errorf("budget %d row %d measures %d cells, want 60", budget, i, got)
			}
		}
	}
	if rows := feedRows(f, evs, 0); rows != nil {
		t.Errorf("a zero budget must draw nothing, got %d rows", len(rows))
	}
	if rows := feedRows(f, nil, 4); len(rows) != 1 || !strings.Contains(ansi.Strip(rows[0]), "no activity yet") {
		t.Errorf("an empty feed must say so, got %#v", rows)
	}
}

func TestFeedFollowPinsAndUnpins(t *testing.T) {
	pinned := theme.GOn
	loose := theme.GOff

	m, _ := feedModel(t, 60, 30)
	top := func(m Model) string { return feedLines(t, m)[0] }

	if h := headFollow(t, m); !strings.Contains(h, "follow "+pinned) {
		t.Fatalf("a fresh feed must be pinned: %q", h)
	}
	newest := top(m)

	// j scrolls toward the older end and un-pins.
	m = pressFeed(t, m, "j")
	if h := headFollow(t, m); !strings.Contains(h, "follow "+loose) {
		t.Fatalf("j must un-pin: %q", h)
	}
	if top(m) == newest {
		t.Fatal("j did not move the viewport")
	}

	// k walks back to the newest and re-pins.
	m = pressFeed(t, m, "k")
	if h := headFollow(t, m); !strings.Contains(h, "follow "+pinned) {
		t.Fatalf("returning to the newest must re-pin: %q", h)
	}
	if top(m) != newest {
		t.Fatal("k did not return to the newest event")
	}

	// G is the far end: the oldest events, un-pinned.
	m = pressFeed(t, m, "G")
	if h := headFollow(t, m); !strings.Contains(h, "follow "+loose) {
		t.Fatalf("G must un-pin: %q", h)
	}
	oldest := top(m)
	if oldest == newest {
		t.Fatal("G did not move the viewport off the newest event")
	}

	// One k from the far end must move one row. It would not if the key handler
	// walked the stored index rather than the one the renderer clamps to.
	if m = pressFeed(t, m, "k"); top(m) == oldest {
		t.Fatal("k after G did not move the viewport")
	}

	// g re-pins from anywhere.
	m = pressFeed(t, m, "g")
	if h := headFollow(t, m); !strings.Contains(h, "follow "+pinned) {
		t.Fatalf("g must re-pin: %q", h)
	}
	if top(m) != newest {
		t.Fatal("g did not return to the newest event")
	}

	// f toggles, and toggling it back on re-pins.
	m = pressFeed(t, m, "f")
	if h := headFollow(t, m); !strings.Contains(h, "follow "+loose) {
		t.Fatalf("f must un-pin a pinned feed: %q", h)
	}
	m = pressFeed(t, m, "d")
	if top(m) == newest {
		t.Fatal("d did not page the viewport")
	}
	m = pressFeed(t, m, "f")
	if h := headFollow(t, m); !strings.Contains(h, "follow "+pinned) {
		t.Fatalf("f must re-pin a loose feed: %q", h)
	}
	if top(m) != newest {
		t.Fatal("re-pinning did not return to the newest event")
	}
}

// A parked viewport must not drift when new events arrive: that is the whole
// difference between following and not.
func TestFeedHoldsItsPlaceWhileUnpinned(t *testing.T) {
	m, st := feedModel(t, 60, 30)
	m = pressFeed(t, m, "j")
	m = pressFeed(t, m, "j")
	parked := feedLines(t, m)[0]

	m = feed(t, m, relay.EventsMsg([]relay.Event{{
		ID: "brand-new", T: relay.Millis(frozen.UnixMilli()), SessionID: st.Sessions[0].ID,
		Kind: "tool", Label: "Bash", Detail: "echo just arrived", Status: "ok", Ms: 5,
	}}))
	if got := feedLines(t, m)[0]; got != parked {
		t.Errorf("an unpinned viewport moved when an event arrived:\n got %q\nwant %q", got, parked)
	}

	// Following, the same arrival is what the reader should be looking at.
	m = pressFeed(t, m, "g")
	if got := feedLines(t, m)[0]; !strings.Contains(got, "just arrived") {
		t.Errorf("a pinned viewport must show the newest event, got %q", got)
	}
}

// The degraded states are the model's, not the mode's: the ones that
// replace the body still take precedence in FEED, and the two that only mark
// the mirror stale leave the feed on screen.
func TestFeedKeepsTheDegradedStatesWorking(t *testing.T) {
	st := loadFixture(t)

	cases := []struct {
		name  string
		build func(t *testing.T) Model
		want  string
	}{
		{
			// 7.4 sessions exist, none is mine: the body is the model's, not FEED's.
			name: "unpinned",
			build: func(t *testing.T) Model {
				m, _ := newModel(t, 60, 30, ident.Result{})
				m = feed(t, m, relay.SnapshotMsg(st))
				m = feed(t, m, IdentResult(ident.Result{How: ident.None}))
				m.mode = ModeFeed
				return m
			},
			want: "WHICH SESSION IS YOURS?",
		},
		{
			// 7.5 the session vanished: the last feed it left stays, greyed.
			name: "gone",
			build: func(t *testing.T) Model {
				m, _ := feedModel(t, 60, 30)
				m = feed(t, m, relay.SessionsMsg(st.Sessions[1:]))
				m.goneAt = frozen.Add(-12 * time.Second)
				return m
			},
			want: "GONE",
		},
		{
			// 7.6 the relay dropped: same mirror, same feed.
			name: "relay-lost",
			build: func(t *testing.T) Model {
				m, _ := feedModel(t, 60, 30)
				m = feed(t, m, relay.ConnMsg{State: relay.Down, RetryAt: frozen.Add(2 * time.Second)})
				m.toast = Toast{}
				return m
			},
			want: "relay lost",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := tc.build(t)
			out := m.Render()
			assertFrame(t, out, 60, 30)
			assertPaletteOnly(t, out)
			if !strings.Contains(ansi.Strip(out), tc.want) {
				t.Fatalf("frame does not contain %q\n%s", tc.want, ansi.Strip(out))
			}
			if tc.name != "unpinned" && !strings.Contains(ansi.Strip(out), "FEED ") {
				t.Fatalf("a stale mirror must keep the feed on screen\n%s", ansi.Strip(out))
			}
		})
	}
}

// Details arrive with whatever the tool was given -- a heredoc in a Bash
// command carries newlines and tabs -- and neither may reach the frame.
func TestFeedDetailNeverShearsTheFrame(t *testing.T) {
	f := NewFrame(60, 30)
	e := relay.Event{
		Kind: "tool", Label: "Bash", Status: "ok", Ms: 12,
		Detail: "cat <<'EOF'\n\tpackage ui\n\nfunc main() {}\nEOF",
	}
	row := feedRow(f, e)
	if strings.ContainsAny(ansi.Strip(row), "\n\t") {
		t.Fatalf("the row carries raw whitespace: %q", ansi.Strip(row))
	}
	if got := fmtx.W(ansi.Strip(row)); got != 60 {
		t.Fatalf("the row measures %d cells, want 60", got)
	}
}

// Paths shorten from the left so the filename survives; sentences from the
// right.
func TestFeedDetailTruncatesFromTheRightEndForEachShape(t *testing.T) {
	path := "/home/dev/demo/bridge/public/app.js"
	if got := feedDetail(path, 24); !strings.HasPrefix(got, "…") || !strings.HasSuffix(got, "app.js") {
		t.Errorf("a path must keep its tail: %q", got)
	}
	sentence := "remember: the palette lives in palette.go and nowhere else"
	if got := feedDetail(sentence, 24); !strings.HasPrefix(got, "remember:") || !strings.HasSuffix(got, "…") {
		t.Errorf("a sentence must keep its head: %q", got)
	}
}

// A name carrying an escape byte can never shear a row or smuggle in a colour
// the theme did not choose.
func TestARowSanitisesWhatItIsGiven(t *testing.T) {
	r := NewRow(20)
	r.Add(theme.SBody, "a\x1b[31mb")
	out := r.String()
	if strings.Contains(out, "\x1b[31mb") {
		t.Error("an escape byte survived into the row")
	}
	if ansi.StringWidth(out) != 20 {
		t.Errorf("the row measures %d cells, want 20", ansi.StringWidth(out))
	}
	assertPaletteOnly(t, out)

	bell := NewRow(20)
	bell.Add(theme.SBody, "bell\x07")
	if bellOut := bell.String(); strings.ContainsRune(bellOut, '\x07') {
		t.Error("a bell byte survived into the row")
	}
}

// f freezes the viewport where the reader is looking, rather than throwing it
// to the far end of the feed.
func TestFollowOffLeavesTheViewportWhereItWas(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)
	m = feed(t, m, relay.SnapshotMsg(st))
	m = pressBoard(t, m, "2")
	before := ansi.Strip(m.Render())
	m = pressBoard(t, m, "f")
	if m.feedFollow {
		t.Fatal("f did not un-pin follow")
	}
	after := ansi.Strip(m.Render())
	beforeRows := strings.Split(before, "\n")
	afterRows := strings.Split(after, "\n")
	// The follow indicator itself changes; the feed rows under it must not.
	if strings.Join(beforeRows[4:], "\n") != strings.Join(afterRows[4:], "\n") {
		t.Errorf("f moved the viewport:\nbefore\n%s\nafter\n%s", before, after)
	}
}
