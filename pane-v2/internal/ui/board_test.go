package ui

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"

	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/ident"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// reverseRun matches one reverse-video run and captures its text.
var reverseRun = regexp.MustCompile("\x1b\\[7m([^\x1b]*)\x1b\\[m")

// boardModel is a model sized w x h, pinned to the fixture's first session and
// already in BOARD, reached by the key a user would press.
func boardModel(t *testing.T, w, h int) (Model, relay.State, *fakeSource) {
	t.Helper()
	st := loadFixture(t)
	self := st.Sessions[0].ID
	src := newFakeSource()
	m := New(src, ident.Static{R: ident.Result{ID: self, How: ident.PaneTree}}, Config{
		RelayURL: "http://127.0.0.1:4317",
		Now:      func() time.Time { return frozen },
	})
	m.now = frozen
	tm, _ := m.Update(tea.WindowSizeMsg{Width: w, Height: h})
	m = tm.(Model)
	m = feed(t, m, relay.SnapshotMsg(st), IdentResult(ident.Result{ID: self, How: ident.PaneTree}))
	m = pressBoard(t, m, "4")
	if m.Mode() != ModeBoard {
		t.Fatalf("pressing 4 left the pane in %v", m.Mode())
	}
	return m, st, src
}

func pressBoard(t *testing.T, m Model, s string) Model {
	t.Helper()
	tm, _ := m.Update(tea.KeyPressMsg{Code: []rune(s)[0], Text: s})
	m = tm.(Model)
	m.now = frozen
	return m
}

// pressKey sends a named key (enter, esc) and hands back the command too.
func pressKey(t *testing.T, m Model, code rune) (Model, tea.Cmd) {
	t.Helper()
	tm, cmd := m.Update(tea.KeyPressMsg{Code: code})
	m = tm.(Model)
	m.now = frozen
	return m, cmd
}

// boardRows returns the rendered session rows, stripped: everything between
// the SESSIONS head and the DETAIL head.
func boardRows(t *testing.T, m Model) []string {
	t.Helper()
	var out []string
	seen := false
	for _, ln := range strings.Split(ansi.Strip(m.Render()), "\n") {
		if strings.HasPrefix(ln, theme.GTick+"SESSIONS ") {
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
		t.Fatalf("no SESSIONS head in the frame:\n%s", ansi.Strip(m.Render()))
	}
	return out
}

// section returns the rows under one section head, stripped.
func section(t *testing.T, m Model, head string) []string {
	t.Helper()
	var out []string
	seen := false
	for _, ln := range strings.Split(ansi.Strip(m.Render()), "\n") {
		if strings.HasPrefix(ln, theme.GTick+head) {
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
		t.Fatalf("no %s head in the frame:\n%s", head, ansi.Strip(m.Render()))
	}
	return out
}

func TestBoardFrameInvariantAtEveryBreakpoint(t *testing.T) {
	sizes := []struct{ w, h int }{
		{60, 40}, {40, 40}, {30, 40}, // the three mockup widths
		{60, 18}, {60, 11}, {60, 7}, // the height ladder
		{24, 20}, {10, 6}, {4, 3}, // XS, tiny, blank
		{0, 0}, {1, 1}, {120, 60}, // the WindowSizeMsg{0,0} during pane creation
	}
	for _, sz := range sizes {
		m, st, _ := boardModel(t, sz.w, sz.h)
		out := m.Render()
		assertFrame(t, out, sz.w, sz.h)
		assertPaletteOnly(t, out)
		if sz.w >= 30 && strings.Contains(ansi.Strip(out), "not built yet") {
			t.Fatalf("%dx%d: BOARD still renders the placeholder", sz.w, sz.h)
		}
		// A pending link and a cursor off the first row are drawn states too.
		m.cursorID = st.Sessions[2].ID
		m.linkFrom = m.self
		assertFrame(t, m.Render(), sz.w, sz.h)
		assertPaletteOnly(t, m.Render())
	}
}

// Only modes 1 and 2 draw in the vertical strip, and 4 says so
// rather than pretending.
func TestBoardSaysItIsTooNarrowAtXS(t *testing.T) {
	m, _, _ := boardModel(t, 24, 16)
	if out := ansi.Strip(m.Render()); !strings.Contains(out, "too narrow for mode 4") {
		t.Errorf("the XS strip must say mode 4 does not draw there:\n%s", out)
	}
}

// Every session, in the relay's own order, with the marker on this window's.
func TestBoardListsEverySessionInOrderAndMarksOurOwn(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)
	rows := boardRows(t, m)
	if len(rows) != len(st.Sessions) {
		t.Fatalf("BOARD drew %d rows for %d sessions:\n%s",
			len(rows), len(st.Sessions), strings.Join(rows, "\n"))
	}
	for i, s := range st.Sessions {
		name := s.Name
		if !strings.Contains(rows[i], name[:minInt(len(name), 12)]) {
			t.Errorf("row %d is %q, want the session %q", i, rows[i], name)
		}
	}
	// The fixture's own order is startedAt ascending, newest last.
	for i := 1; i < len(st.Sessions); i++ {
		if st.Sessions[i].StartedAt < st.Sessions[i-1].StartedAt {
			t.Fatal("the fixture is not in startedAt order, so this test proves nothing")
		}
	}

	// The marker is on our session and on no other, and the working glyph is
	// a separate cell so both facts read.
	marked := 0
	for i, r := range rows {
		if !strings.HasPrefix(r, theme.GGrip+theme.GHere) {
			continue
		}
		marked++
		if st.Sessions[i].ID != m.Self() {
			t.Errorf("row %d carries %s but is not this window's session", i, theme.GHere)
		}
		if !strings.HasPrefix(r, theme.GGrip+theme.GHere+theme.GOn) &&
			!strings.HasPrefix(r, theme.GGrip+theme.GHere+theme.GOff) {
			t.Errorf("row %d must carry its own state glyph beside the marker: %q", i, r)
		}
	}
	if marked != 1 {
		t.Errorf("%d rows carry the here marker, want exactly 1", marked)
	}

	// Pinned somewhere else, no row is ours.
	m.self = "not-a-session"
	for i, r := range boardRows(t, m) {
		if strings.HasPrefix(r, theme.GGrip+theme.GHere) {
			t.Errorf("row %d is marked as ours when no session is: %q", i, r)
		}
	}
}

func TestBoardCursorMovesAndClampsAtBothEnds(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)
	n := len(st.Sessions)
	if n < 3 {
		t.Fatalf("the fixture has %d sessions; this test needs 3", n)
	}
	if m.boardCursorIndex() != 0 {
		t.Fatalf("a fresh board starts on row %d, want 0", m.boardCursorIndex())
	}

	// k at the top end stays put.
	if m = pressBoard(t, m, "k"); m.boardCursorIndex() != 0 {
		t.Errorf("k at the top moved the cursor to %d", m.boardCursorIndex())
	}
	for i := 1; i < n; i++ {
		m = pressBoard(t, m, "j")
		if got := m.boardCursorIndex(); got != i {
			t.Fatalf("j moved the cursor to %d, want %d", got, i)
		}
	}
	// j at the far end stays put.
	if m = pressBoard(t, m, "j"); m.boardCursorIndex() != n-1 {
		t.Errorf("j at the end moved the cursor to %d, want %d", m.boardCursorIndex(), n-1)
	}
	if m = pressBoard(t, m, "k"); m.boardCursorIndex() != n-2 {
		t.Errorf("k moved the cursor to %d, want %d", m.boardCursorIndex(), n-2)
	}

	// DETAIL follows the cursor, which is the point of moving it.
	want := st.Sessions[n-2]
	detail := strings.Join(section(t, m, "DETAIL"), "\n")
	if !strings.Contains(detail, shortID(want.ID)) {
		t.Errorf("DETAIL does not describe the cursor's session %q:\n%s", want.Name, detail)
	}

	// The cursor holds a session, not a row: one exiting above it moves the
	// row under it without moving what enter and l are aimed at.
	m.cursorID = st.Sessions[n-1].ID
	m = feed(t, m, relay.SessionsMsg(st.Sessions[1:]))
	if got := m.boardCursorIndex(); got != n-2 {
		t.Fatalf("the cursor is on row %d after a session above it left, want %d", got, n-2)
	}
	if s, _ := m.boardSession(); s.ID != st.Sessions[n-1].ID {
		t.Errorf("the cursor moved to %q when the list did", s.ID)
	}
	tm, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if got := tm.(Model).focus; got != st.Sessions[n-1].ID {
		t.Errorf("enter focused %q, want the session the cursor was on", got)
	}

	// A cursor whose own session has gone falls back to the top.
	m.cursorID = "gone"
	if got := m.boardCursorIndex(); got != 0 {
		t.Errorf("a cursor on a departed session resolved to %d, want 0", got)
	}
}

// The cursor row is reverse video: the pane paints no background of its own,
// so the highlight is the terminal's own inverse.
func TestBoardCursorRowIsReverseVideo(t *testing.T) {
	m, _, _ := boardModel(t, 60, 40)
	rows := strings.Split(m.Render(), "\n")
	// Body rows start under the two header rows and the SESSIONS head.
	cursorRow, otherRow := rows[3], rows[4]
	if !strings.Contains(cursorRow, "\x1b[7m") {
		t.Errorf("the cursor row is not reverse video: %q", cursorRow)
	}
	if strings.Contains(otherRow, "\x1b[7m") {
		t.Errorf("a row that is not the cursor's is reverse video: %q", otherRow)
	}
	// The highlight covers every cell of the row, its padding included: the
	// text inside the reverse runs is the whole row and nothing is left out.
	var covered strings.Builder
	for _, run := range reverseRun.FindAllStringSubmatch(cursorRow, -1) {
		covered.WriteString(run[1])
	}
	if got := ansi.Strip(cursorRow); covered.String() != got {
		t.Errorf("the highlight does not cover the whole row:\n got %q\nwant %q", covered.String(), got)
	}

	m = pressBoard(t, m, "j")
	rows = strings.Split(m.Render(), "\n")
	if strings.Contains(rows[3], "\x1b[7m") || !strings.Contains(rows[4], "\x1b[7m") {
		t.Error("the highlight did not follow the cursor down a row")
	}
}

// The 10-cell mini bar is the context bar in miniature: same glyphs, same
// thresholds -- teal below 65%, yellow from 65%, red from 85%.
func TestBoardMiniBarUsesTheThresholdColours(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)
	f := m.frame

	cases := []struct {
		frac  float64
		full  int
		color string
	}{
		{0.50, 5, theme.On(theme.Teal).Render(strings.Repeat(theme.GBarFull, 5))},
		{0.70, 7, theme.On(theme.Yellow).Render(strings.Repeat(theme.GBarFull, 7))},
		{0.90, 9, theme.On(theme.Red).Render(strings.Repeat(theme.GBarFull, 9))},
	}
	for _, tc := range cases {
		s := st.Sessions[1] // not the cursor's row: that one is inverted
		s.Stats.CtxLimit = 1000
		s.Stats.Ctx = int64(tc.frac * 1000)
		row := m.boardRow(f, s, false, false)
		if !strings.Contains(row, tc.color) {
			t.Errorf("at %.0f%% the mini bar is not %d filled cells in its threshold colour:\n%q",
				tc.frac*100, tc.full, row)
		}
		if got := strings.Count(ansi.Strip(row), theme.GBarFull); got != tc.full {
			t.Errorf("at %.0f%% the mini bar has %d filled cells, want %d", tc.frac*100, got, tc.full)
		}
		if got := strings.Count(ansi.Strip(row), theme.GBarEmpty); got != boardBarW-tc.full {
			t.Errorf("at %.0f%% the mini bar has %d empty cells, want %d",
				tc.frac*100, got, boardBarW-tc.full)
		}
	}

	// The bar is an L-only column: 40 and 30 carry the percentage instead.
	for _, w := range []int{40, 30} {
		narrow, _, _ := boardModel(t, w, 40)
		if strings.Contains(ansi.Strip(narrow.Render()), strings.Repeat(theme.GBarFull, 3)) {
			t.Errorf("%d cols must drop the mini bars", w)
		}
	}
}

// enter points modes 1-3 at the cursor's session; 0 brings them home.
func TestBoardEnterFocusesAndZeroReturnsHome(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)
	self, other := st.Sessions[0], st.Sessions[2]

	m = pressBoard(t, m, "j")
	m = pressBoard(t, m, "j")
	m, _ = pressKey(t, m, tea.KeyEnter)
	if m.focus != other.ID {
		t.Fatalf("enter focused %q, want %q", m.focus, other.ID)
	}

	// What modes 1-3 draw follows the focus.
	m.mode = ModeVitals
	vitals := ansi.Strip(m.Render())
	if !strings.Contains(vitals, other.Name) {
		t.Errorf("VITALS does not show the focused session %q:\n%s", other.Name, vitals)
	}
	m.mode = ModeFeed
	if head := headFollow(t, m); !strings.Contains(head, "FEED "+"0") {
		// The fixture's third session has no events of its own, which is what
		// makes this a real check that the feed changed session.
		t.Errorf("FEED did not follow the focus: %q", head)
	}

	// The header says so, and says it in cyan.
	if !strings.Contains(ansi.Strip(m.Render()), theme.GElse+" focused elsewhere") {
		t.Errorf("the header must carry the focused-elsewhere tag:\n%s", ansi.Strip(m.Render()))
	}
	if !strings.Contains(m.Render(), theme.SLink.Render(theme.GElse+" focused elsewhere")) {
		t.Error("the focused-elsewhere tag must be cyan")
	}

	// 0 goes home, and the tag goes with it.
	m = pressBoard(t, m, "0")
	if m.focus != self.ID {
		t.Fatalf("0 left the focus on %q, want %q", m.focus, self.ID)
	}
	if strings.Contains(ansi.Strip(m.Render()), "focused elsewhere") {
		t.Error("the focused-elsewhere tag outlived the return home")
	}
	if got := ansi.Strip(m.Render()); !strings.Contains(got, self.Name) {
		t.Errorf("the header does not name our own session again:\n%s", got)
	}
}

// The tag shrinks to the bare arrow where a sentence does not fit, and is
// absent entirely when there is no home to return to.
func TestFocusedElsewhereTagShrinksAndDisappears(t *testing.T) {
	for _, w := range []int{40, 30} {
		m, st, _ := boardModel(t, w, 40)
		m.focus = st.Sessions[2].ID
		out := ansi.Strip(m.Render())
		if !strings.Contains(out, theme.GElse) {
			t.Errorf("%d cols: no focused-elsewhere mark:\n%s", w, out)
		}
		if strings.Contains(out, "focused elsewhere") {
			t.Errorf("%d cols: the tag must shrink to the arrow:\n%s", w, out)
		}
	}
	m, st, _ := boardModel(t, 60, 40)
	m.self, m.focus = "", st.Sessions[2].ID
	if strings.Contains(ansi.Strip(m.Render()), "focused elsewhere") {
		t.Error("with no session of our own there is no elsewhere to be")
	}
}

func TestBoardLinksPanelAndItsEmptyState(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)

	// The fixture links session 0 to session 1, and 0 is what we are focused on.
	rows := section(t, m, "LINKS")
	if len(rows) == 0 || !strings.Contains(rows[0], st.Sessions[0].Name) ||
		!strings.Contains(rows[0], st.Sessions[1].Name) {
		t.Fatalf("the LINKS panel does not show the fixture's link:\n%s", strings.Join(rows, "\n"))
	}
	if !strings.Contains(ansi.Strip(m.Render()), theme.GTick+"LINKS 1") {
		t.Error("the LINKS head must count them")
	}

	// Focused on a session with no links, the panel says how to make one.
	m.focus = st.Sessions[2].ID
	empty := strings.Join(section(t, m, "LINKS"), "\n")
	if !strings.Contains(empty, "none · l on a row links the focused session to it") {
		t.Errorf("the empty links state is missing:\n%s", empty)
	}
	if !strings.Contains(ansi.Strip(m.Render()), theme.GTick+"LINKS 0") {
		t.Error("the LINKS head must count zero")
	}
}

// l marks the focused session as the sender, and the second press on another
// row queues the briefing the relay turns into send-message.
func TestBoardLinkKeyQueuesTheBriefing(t *testing.T) {
	m, st, src := boardModel(t, 60, 40)

	m = pressBoard(t, m, "l")
	if m.linkFrom != st.Sessions[0].ID {
		t.Fatalf("l marked %q as the sender, want the focused session %q", m.linkFrom, st.Sessions[0].ID)
	}
	hint := ansi.Strip(m.Render())
	if !strings.Contains(hint, "LINK "+st.Sessions[0].Name+" "+theme.GArrow+" ? · move and press l · esc") {
		t.Errorf("the link hint is missing:\n%s", hint)
	}
	if len(src.posts) != 0 {
		t.Fatalf("the first l press wrote to the relay: %v", src.posts)
	}

	// On the sender's own row it waits rather than linking a session to itself.
	m2 := pressBoard(t, m, "l")
	if len(src.posts) != 0 || m2.linkFrom == "" {
		t.Errorf("l on the sender's own row should still be waiting: posts %v, from %q",
			src.posts, m2.linkFrom)
	}

	// Move and press again: that is the briefing.
	m = pressBoard(t, m, "j")
	tm, cmd := m.Update(tea.KeyPressMsg{Code: 'l', Text: "l"})
	m = tm.(Model)
	if cmd == nil {
		t.Fatal("the second l press produced no write")
	}
	msg := cmd()
	if len(src.posts) != 1 || src.posts[0] != "/api/link" {
		t.Fatalf("the second l press posted %v, want one /api/link", src.posts)
	}
	body := src.bodies[0]
	if body["from"] != st.Sessions[0].ID || body["to"] != st.Sessions[1].ID || body["kind"] != "brief" {
		t.Errorf("the link body is %v", body)
	}
	if m.linkFrom != "" {
		t.Error("the pending link outlived the write")
	}
	// The outcome comes back as a toast.
	m = feed(t, m, msg)
	if !strings.Contains(ansi.Strip(m.Render()), "link queued") {
		t.Errorf("a queued link must say so:\n%s", ansi.Strip(m.Render()))
	}

	// esc cancels a pending link and its hint.
	m = pressBoard(t, m, "l")
	m, _ = pressKey(t, m, tea.KeyEscape)
	if m.linkFrom != "" {
		t.Error("esc did not cancel the pending link")
	}
	if strings.Contains(ansi.Strip(m.Render()), "move and press l") {
		t.Error("the link hint outlived esc")
	}

	// So does leaving the switchboard: no other mode can finish it.
	m = pressBoard(t, m, "l")
	m = pressBoard(t, m, "1")
	if m.linkFrom != "" {
		t.Error("a pending link survived leaving BOARD")
	}
	if strings.Contains(ansi.Strip(m.Render()), "move and press l") {
		t.Errorf("the link hint is up in %v", m.Mode())
	}
}

// A disconnect cancels a link waiting on its second press -- the armed
// family's rule, for the same reason -- and the connection state
// owns the last row while it is down.
func TestADisconnectCancelsAPendingLinkAndOwnsTheLastRow(t *testing.T) {
	m, _, _ := boardModel(t, 60, 30)
	m = pressBoard(t, m, "l")
	if m.linkFrom == "" {
		t.Fatal("l did not arm a link")
	}

	m = feed(t, m, relay.ConnMsg{State: relay.Down, RetryAt: frozen.Add(4 * time.Second)})
	m.toast = Toast{}
	if m.linkFrom != "" {
		t.Error("a pending link survived the relay dropping")
	}
	out := ansi.Strip(m.Render())
	if !strings.Contains(out, "relay lost") {
		t.Errorf("the last row must say the relay is down:\n%s", out)
	}

	// Armed while already down, the hint still yields to the reason it cannot
	// be finished.
	m.linkFrom = m.self
	out = ansi.Strip(m.Render())
	if strings.Contains(out, "move and press l") {
		t.Errorf("the link hint stood where the relay-lost notice belongs:\n%s", out)
	}
	if !strings.Contains(out, "relay lost") {
		t.Errorf("the relay-lost notice is missing:\n%s", out)
	}
}

// ---- the mouse, which is what the switchboard is for ----------------------

// boardRowY is the screen row a session's row is drawn on, taken from the
// frame rather than from the layout the regions are built from. It matches on
// the head of the name, which is all a row wide enough to truncate keeps.
func boardRowY(t *testing.T, m Model, name string) int {
	t.Helper()
	head := name
	if len(head) > 10 {
		head = head[:10]
	}
	for y, ln := range strings.Split(ansi.Strip(m.Render()), "\n") {
		if strings.Contains(ln, head) && strings.HasPrefix(ln, theme.GGrip) {
			return y
		}
	}
	t.Fatalf("no session row for %q:\n%s", name, ansi.Strip(m.Render()))
	return -1
}

func TestClickingASessionRowMovesTheCursor(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)
	y := boardRowY(t, m, st.Sessions[2].Name)

	m = click(t, m, 20, y)
	if got := m.boardCursorIndex(); got != 2 {
		t.Fatalf("clicking row 2 moved the cursor to %d", got)
	}
	if m.focus != st.Sessions[0].ID {
		t.Errorf("a single click changed the focus to %q", m.focus)
	}
	detail := strings.Join(section(t, m, "DETAIL"), "\n")
	if !strings.Contains(detail, shortID(st.Sessions[2].ID)) {
		t.Errorf("DETAIL did not follow the click:\n%s", detail)
	}

	// A click below the last row is over nothing.
	below := boardRowY(t, m, st.Sessions[2].Name) + 1
	if got := click(t, m, 20, below).boardCursorIndex(); got != 2 {
		t.Errorf("a click past the last row moved the cursor to %d", got)
	}
}

func TestDoubleClickingASessionRowFocusesIt(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)
	y := boardRowY(t, m, st.Sessions[1].Name)

	// The clock is frozen, so a second click lands inside the window.
	m = click(t, m, 4, y)
	if m.focus != st.Sessions[0].ID {
		t.Fatal("the first click of a double-click already focused")
	}
	m = click(t, m, 4, y)
	if m.focus != st.Sessions[1].ID {
		t.Fatalf("a double-click focused %q, want %q", m.focus, st.Sessions[1].ID)
	}

	// Two clicks further apart than the window are two single clicks.
	m2, st2, _ := boardModel(t, 60, 40)
	y2 := boardRowY(t, m2, st2.Sessions[1].Name)
	m2 = click(t, m2, 4, y2)
	m2.clickAt = frozen.Add(-time.Second)
	m2 = click(t, m2, 4, y2)
	if m2.focus != st2.Sessions[0].ID {
		t.Errorf("two clicks a second apart focused %q; that is not a double-click", m2.focus)
	}

	// Two clicks on different rows are not a double-click either.
	m3, st3, _ := boardModel(t, 60, 40)
	m3 = click(t, m3, 4, boardRowY(t, m3, st3.Sessions[1].Name))
	m3 = click(t, m3, 4, boardRowY(t, m3, st3.Sessions[2].Name))
	if m3.focus != st3.Sessions[0].ID {
		t.Errorf("clicks on two different rows focused %q", m3.focus)
	}
}

func TestClickingTheFocusedElsewhereTagGoesHome(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)
	m.focus = st.Sessions[2].ID

	line := lineAt(t, m, 0)
	x := columnOf(t, line, theme.GElse)
	m = click(t, m, x, 0)
	if m.focus != st.Sessions[0].ID {
		t.Fatalf("clicking the tag left the focus on %q", m.focus)
	}
	if strings.Contains(ansi.Strip(m.Render()), theme.GElse) {
		t.Error("the tag survived the click that made it untrue")
	}

	// One cell to the left of the tag is the session name, not the tag.
	m2, st2, _ := boardModel(t, 60, 40)
	m2.focus = st2.Sessions[2].ID
	if got := click(t, m2, x-1, 0).focus; got != st2.Sessions[2].ID {
		t.Errorf("a click one cell off the tag went home anyway")
	}
}

// boardGripX is the column the drag handle occupies: the row's first cell.
const boardGripX = 0

// A drag starts on the grip and links the two sessions. The grip has to be
// drawn where the region is, or the gesture is invisible.
func TestDraggingOneRowOntoAnotherLinksThem(t *testing.T) {
	m, st, src := boardModel(t, 60, 40)
	from := boardRowY(t, m, st.Sessions[1].Name)
	to := boardRowY(t, m, st.Sessions[2].Name)

	// The handle is drawn where the gesture starts; an invisible one would be
	// a gesture nobody could find.
	for _, row := range boardRows(t, m) {
		if !strings.HasPrefix(row, theme.GGrip) {
			t.Fatalf("a session row has no drag handle: %q", row)
		}
	}

	m = click(t, m, boardGripX, from)
	tm, _ := m.Update(tea.MouseMotionMsg{X: 20, Y: to, Button: tea.MouseLeft})
	m = tm.(Model)
	tm, cmd := m.Update(tea.MouseReleaseMsg{X: 20, Y: to, Button: tea.MouseLeft})
	m = tm.(Model)
	if cmd == nil {
		t.Fatal("a drag from one row to another produced no write")
	}
	cmd()
	if len(src.posts) != 1 || src.posts[0] != "/api/link" {
		t.Fatalf("the drag posted %v, want one /api/link", src.posts)
	}
	body := src.bodies[0]
	if body["from"] != st.Sessions[1].ID || body["to"] != st.Sessions[2].ID {
		t.Errorf("the drag linked %v, want %q -> %q", body, st.Sessions[1].ID, st.Sessions[2].ID)
	}

	// A release on the row the press started on is an ordinary click.
	m2, _, src2 := boardModel(t, 60, 40)
	y := boardRowY(t, m2, st.Sessions[1].Name)
	m2 = click(t, m2, boardGripX, y)
	tm, cmd = m2.Update(tea.MouseReleaseMsg{X: 30, Y: y, Button: tea.MouseLeft})
	m2 = tm.(Model)
	if cmd != nil || len(src2.posts) != 0 {
		t.Errorf("a release on the row the press started on wrote %v", src2.posts)
	}

	// So is a release over nothing.
	m3, _, src3 := boardModel(t, 60, 40)
	m3 = click(t, m3, boardGripX, boardRowY(t, m3, st.Sessions[1].Name))
	tm, cmd = m3.Update(tea.MouseReleaseMsg{X: 10, Y: 0, Button: tea.MouseLeft})
	if cmd != nil || len(src3.posts) != 0 {
		t.Errorf("a release over the header wrote %v", src3.posts)
	}
	_ = tm
}

// The list moves under a gesture -- the relay pushes a fresh list every 1.2s
// and a session leaves whenever one exits -- so a drag remembers which session
// it started on, not which row.
func TestADragSurvivesTheListMovingUnderIt(t *testing.T) {
	m, st, src := boardModel(t, 60, 40)
	m = click(t, m, boardGripX, boardRowY(t, m, st.Sessions[1].Name))

	// The first session exits: every row below it moves up one.
	m = feed(t, m, relay.SessionsMsg(st.Sessions[1:]))
	tm, cmd := m.Update(tea.MouseReleaseMsg{
		X: 10, Y: boardRowY(t, m, st.Sessions[2].Name), Button: tea.MouseLeft,
	})
	m = tm.(Model)
	if cmd == nil {
		t.Fatal("the drag was lost when the list moved under it")
	}
	cmd()
	if len(src.bodies) != 1 {
		t.Fatalf("the drag posted %d writes, want 1", len(src.bodies))
	}
	if body := src.bodies[0]; body["from"] != st.Sessions[1].ID || body["to"] != st.Sessions[2].ID {
		t.Errorf("the drag linked %v, want %q -> %q", body, st.Sessions[1].ID, st.Sessions[2].ID)
	}
}

// Press-move-release over a row is how a terminal selects text, so only the
// grip starts a link. Everywhere else on the row keeps the click it had.
func TestADragOffTheGripDoesNotLink(t *testing.T) {
	m, st, src := boardModel(t, 60, 40)
	from := boardRowY(t, m, st.Sessions[1].Name)
	to := boardRowY(t, m, st.Sessions[2].Name)

	m = click(t, m, boardGripX+8, from)
	tm, cmd := m.Update(tea.MouseReleaseMsg{X: boardGripX + 8, Y: to, Button: tea.MouseLeft})
	m = tm.(Model)
	if cmd != nil || len(src.posts) != 0 {
		t.Fatalf("a drag that began off the grip linked something: %v", src.posts)
	}

	// The press is still the click it always was.
	if got := m.boardCursorIndex(); got != 1 {
		t.Errorf("the press left the cursor on row %d, want 1", got)
	}
	if m.focus != st.Sessions[0].ID {
		t.Errorf("the press changed the focus to %q", m.focus)
	}
}

// The wheel moves the list; the cursor stays on the session it was on.
func TestWheelScrollsTheBoardListAndLeavesTheCursor(t *testing.T) {
	// A pane too short to show every session, so there is something to scroll.
	st := loadFixture(t)
	// Short, distinct names: the point of the test is which row is on top, and
	// three long names that truncate to the same cells would not show it.
	many := make([]relay.Session, 0, 12)
	for i := 0; i < 12; i++ {
		s := st.Sessions[i%len(st.Sessions)]
		s.ID = fmt.Sprintf("sess-%02d", i)
		s.Name = fmt.Sprintf("sess-%02d", i)
		many = append(many, s)
	}
	// 18 rows is short enough that the list needs a viewport of its own.
	m, _, _ := boardModel(t, 60, 18)
	m = feed(t, m, relay.SessionsMsg(many))

	h := m.boardListH()
	if h <= 0 || h >= len(many) {
		t.Fatalf("the viewport shows %d of %d sessions; this test needs it smaller", h, len(many))
	}
	first := boardRows(t, m)[0]

	m = wheel(t, m, tea.MouseWheelDown, 1)
	if got := boardRows(t, m)[0]; got == first {
		t.Fatalf("the wheel did not scroll the list: still %q", got)
	}
	if m.boardCursorIndex() != 0 {
		t.Errorf("the wheel moved the cursor to %d", m.boardCursorIndex())
	}

	// It clamps at both ends.
	m = wheel(t, m, tea.MouseWheelDown, 50)
	last := boardRows(t, m)
	if got := last[len(last)-1]; !strings.Contains(got, many[len(many)-1].Name) {
		t.Errorf("scrolling to the end stops on %q, want the last session", got)
	}
	m = wheel(t, m, tea.MouseWheelDown, 5)
	if got := boardRows(t, m); got[len(got)-1] != last[len(last)-1] {
		t.Error("the list scrolled past its last session")
	}
	m = wheel(t, m, tea.MouseWheelUp, 50)
	if got := boardRows(t, m)[0]; got != first {
		t.Errorf("scrolling back to the top gives %q, want %q", got, first)
	}

	// j from the last visible row scrolls the list to keep the cursor on screen.
	for i := 0; i < h; i++ {
		m = pressBoard(t, m, "j")
	}
	if m.boardCursorIndex() != h {
		t.Fatalf("the cursor is on %d after %d presses of j", m.boardCursorIndex(), h)
	}
	rows := boardRows(t, m)
	if !strings.Contains(rows[len(rows)-1], many[h].Name) {
		t.Errorf("the cursor ran off the viewport:\n%s", strings.Join(rows, "\n"))
	}
}

// The degraded states are the model's, not the mode's, and BOARD must
// not have broken them.
func TestBoardKeepsTheDegradedStatesWorking(t *testing.T) {
	st := loadFixture(t)
	cases := []struct {
		name  string
		build func(t *testing.T) Model
		want  string
	}{
		{
			name: "unpinned",
			build: func(t *testing.T) Model {
				m, _ := newModel(t, 60, 30, ident.Result{})
				m = feed(t, m, relay.SnapshotMsg(st))
				m = feed(t, m, IdentResult(ident.Result{How: ident.None}))
				m.mode = ModeBoard
				return m
			},
			want: "WHICH SESSION IS YOURS?",
		},
		{
			name: "relay-lost",
			build: func(t *testing.T) Model {
				m, _, _ := boardModel(t, 60, 30)
				m = feed(t, m, relay.ConnMsg{State: relay.Down, RetryAt: frozen.Add(2 * time.Second)})
				m.toast = Toast{}
				return m
			},
			want: "relay lost",
		},
		{
			name: "waiting",
			build: func(t *testing.T) Model {
				m, _ := newModel(t, 60, 30, ident.Result{})
				m.mode = ModeBoard
				return feed(t, m, relay.ConnMsg{State: relay.Down, Attempt: 1})
			},
			want: "waiting for the relay at",
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
			// A click cannot resolve against a body the pane is not drawing.
			if tc.name != "relay-lost" {
				for _, r := range m.regions() {
					if r.Act == actBoardRow {
						t.Fatalf("a degraded body still registered a session row: %#v", r)
					}
				}
			}
		})
	}
}

// The x kill is deliberately absent until the armed strip lands: a key that
// silently does nothing is worse than no key.
func TestBoardHasNoKillKeyYet(t *testing.T) {
	m, _, src := boardModel(t, 60, 40)
	before := m.Render()
	m = pressBoard(t, m, "x")
	if len(src.posts) != 0 {
		t.Fatalf("x wrote to the relay: %v", src.posts)
	}
	if m.Render() != before {
		t.Error("x changed the frame")
	}
	if strings.Contains(ansi.Strip(before), "x kill") {
		t.Error("the footer offers a kill key that does not exist")
	}
}
