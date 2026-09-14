package ui

import (
	"fmt"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
)

// gridModel is mouseModel switched to GRID: pinned to the fixture's first
// session, the snapshot fed, time frozen.
func gridModel(t *testing.T, w, h int) (Model, relay.State) {
	t.Helper()
	m, st := mouseModel(t, w, h)
	tm, _ := m.setMode(ModeGrid)
	return tm.(Model), st
}

func TestGridHoldsTheFrameAndPaletteAtEveryWidth(t *testing.T) {
	for _, sz := range []struct{ w, h int }{{41, 49}, {60, 40}, {80, 40}, {30, 40}, {40, 12}, {41, 8}} {
		m, st := gridModel(t, sz.w, sz.h)
		out := m.Render()
		assertFrame(t, out, sz.w, sz.h)
		assertPaletteOnly(t, out)
		if sz.w < 41 || sz.h < 20 {
			continue
		}
		plain := ansi.Strip(out)
		for _, s := range st.Sessions {
			if !strings.Contains(plain, fmtx.TruncRight(s.Name, 17)) {
				t.Fatalf("%dx%d: no card for %q", sz.w, sz.h, s.Name)
			}
		}
	}
}

// gridSessions grows the fixture's list to n cards, so a viewport that shows
// fewer card rows than there are has something to scroll.
func gridSessions(st relay.State, n int) []relay.Session {
	out := append([]relay.Session(nil), st.Sessions...)
	for i := len(out); i < n; i++ {
		s := st.Sessions[i%len(st.Sessions)]
		s.ID = fmt.Sprintf("synthetic-%02d", i)
		s.Name = fmt.Sprintf("session-%02d", i)
		out = append(out, s)
	}
	return out
}

// GRID's cursor is a session id and its viewport is a card row. j and k step a
// whole row of cards because the grid is two-dimensional, h and the right
// arrow step one card, the viewport follows a cursor driven off the bottom,
// and the wheel moves the viewport underneath without taking the cursor with
// it. The id is what survives a session leaving.
func TestGridCursorStepsAndTheViewportFollowsIt(t *testing.T) {
	m, st := gridModel(t, 41, 24)
	m = feed(t, m, relay.SessionsMsg(gridSessions(st, 12)))

	lay := m.gridLayout()
	if lay.Cols != 2 {
		t.Fatalf("41 columns should lay two cards per row, got %d", lay.Cols)
	}
	if m.gridRowCount(lay) <= lay.Rows {
		t.Fatalf("this size shows all %d card rows, so it proves nothing about scrolling",
			m.gridRowCount(lay))
	}
	if got := m.gridCursorIndex(); got != 0 {
		t.Fatalf("a fresh grid starts on card %d, want 0", got)
	}

	for _, step := range []struct {
		key  tea.KeyPressMsg
		want int
	}{
		{tea.KeyPressMsg{Code: tea.KeyRight}, 1},
		{tea.KeyPressMsg{Code: 'j', Text: "j"}, 1 + lay.Cols},
		{tea.KeyPressMsg{Code: 'k', Text: "k"}, 1},
		{tea.KeyPressMsg{Code: 'h', Text: "h"}, 0},
	} {
		m = feed(t, m, step.key)
		if got := m.gridCursorIndex(); got != step.want {
			t.Fatalf("%v moved the cursor to card %d, want %d", step.key, got, step.want)
		}
	}
	if m.gridTop != 0 {
		t.Fatalf("moving inside the viewport scrolled it to row %d", m.gridTop)
	}

	// Drive the cursor onto a card row the viewport cannot show: it comes
	// along rather than leaving the cursor off screen.
	for i := 0; i < lay.Rows; i++ {
		m = feed(t, m, tea.KeyPressMsg{Code: 'j', Text: "j"})
	}
	row := m.gridCursorIndex() / lay.Cols
	if row < lay.Rows {
		t.Fatalf("the cursor is only on card row %d; it never left the viewport", row)
	}
	if want := row - lay.Rows + 1; m.gridTop != want {
		t.Fatalf("the viewport is on card row %d, want %d", m.gridTop, want)
	}

	// The wheel moves the list under the cursor and leaves the cursor alone,
	// which is BOARD's rule for the same gesture.
	onCard := m.gridCursorIndex()
	m = wheel(t, m, tea.MouseWheelUp, 1)
	if m.gridTop != 0 {
		t.Errorf("a wheel-up notch left the viewport on card row %d, want 0", m.gridTop)
	}
	if got := m.gridCursorIndex(); got != onCard {
		t.Errorf("the wheel moved the cursor from card %d to %d", onCard, got)
	}
	m = wheel(t, m, tea.MouseWheelUp, 4)
	if m.gridTop != 0 {
		t.Errorf("wheeling up at the top drove the viewport to row %d, want 0", m.gridTop)
	}

	// The cursor holds a session, not a card: one leaving ahead of it moves
	// the card under it without moving what the cursor is on.
	was := m.gridCursorID
	m = feed(t, m, relay.SessionsMsg(gridSessions(st, 12)[1:]))
	if got := m.gridCursorIndex(); got != onCard-1 {
		t.Fatalf("the cursor is on card %d after a session ahead of it left, want %d", got, onCard-1)
	}
	if m.gridCursorID != was {
		t.Errorf("the cursor followed the card instead of the session: %q", m.gridCursorID)
	}

	// A cursor whose own session has gone falls back to the first card.
	m.gridCursorID = "gone"
	if got := m.gridCursorIndex(); got != 0 {
		t.Errorf("a cursor on a departed session resolved to %d, want 0", got)
	}
}

// cardAt is the frame coordinate of card i's middle row -- its body -- and
// gripAt its grip cell. Both read the layout the renderer reads, so a test
// cannot drift from the frame.
func cardAt(t *testing.T, m Model, i int) (int, int) {
	t.Helper()
	lay := m.gridLayout()
	r, ok := lay.cardRect(i, m.gridTopRow(lay))
	if !ok {
		t.Fatalf("card %d is not on screen", i)
	}
	return r.X + 2, m.frame.HeaderRows + lay.CanvasY + r.Y + 1
}

func gripAt(t *testing.T, m Model, i int) (int, int) {
	t.Helper()
	lay := m.gridLayout()
	r, ok := lay.cardRect(i, m.gridTopRow(lay))
	if !ok {
		t.Fatalf("card %d is not on screen", i)
	}
	return r.X + 1, m.frame.HeaderRows + lay.CanvasY + r.Y + 2
}

// pressGrid sends one typed key; pressKey (board_test.go) sends a named one.
func pressGrid(t *testing.T, m Model, s string) Model {
	t.Helper()
	tm, _ := m.Update(tea.KeyPressMsg{Code: []rune(s)[0], Text: s})
	m = tm.(Model)
	m.now = frozen
	return m
}

// dump asserts the frame invariant and the palette, and logs the plain frame
// so a failing layout can be read rather than guessed at. Layout bugs in this
// pane are caught by looking at frames, so the assertions and the picture stay
// in one call.
func dump(t *testing.T, m Model, w, h int, label string) {
	t.Helper()
	out := m.Render()
	assertFrame(t, out, w, h)
	assertPaletteOnly(t, out)
	t.Logf("---- %s ----", label)
	for i, ln := range strings.Split(ansi.Strip(out), "\n") {
		t.Logf("%2d |%s|", i, ln)
	}
}

func motion(t *testing.T, m Model, x, y int) Model {
	t.Helper()
	tm, _ := m.Update(tea.MouseMotionMsg{X: x, Y: y, Button: tea.MouseLeft})
	m = tm.(Model)
	m.now = frozen
	return m
}

func release(t *testing.T, m Model, x, y int) (Model, tea.Cmd) {
	t.Helper()
	tm, cmd := m.Update(tea.MouseReleaseMsg{X: x, Y: y, Button: tea.MouseLeft})
	m = tm.(Model)
	m.now = frozen
	return m, cmd
}

// brailleCells counts braille-block runes in a frame. Both the drag line and
// every card's grip are drawn from that block, so this is only meaningful as a
// difference: render without a drag, render with one, and the growth is the
// line. Counting absolutely would pass with no line drawn at all.
func brailleCells(out string) int {
	n := 0
	for _, r := range ansi.Strip(out) {
		if r >= 0x2800 && r <= 0x28FF {
			n++
		}
	}
	return n
}

func TestGridDragLandsAPendingConnection(t *testing.T) {
	m, st := gridModel(t, 41, 49)
	m.gridBatch = true
	// The fixture's settled link joins these same two cards through the one
	// gutter cell this hop crosses, so with wires on the drag line would replace
	// that wire's braille rather than add any, and the count below could not
	// tell a drawn line from none. The baseline is the board without wires.
	m.gridWires = false
	gx, gy := gripAt(t, m, 0)
	bx, by := cardAt(t, m, 1)

	grips := brailleCells(m.Render()) // the baseline: every card wears a grip

	m = click(t, m, gx, gy)
	m = motion(t, m, bx, by)
	dump(t, m, 41, 49, "mid-drag: the braille line is on screen")
	// The line itself. Without this, gridDrawDrag and gridHoverID could both be
	// emptied and every other assertion in this file would still pass -- dump
	// measures only frame width and palette.
	if drawn := brailleCells(m.Render()); drawn <= grips {
		t.Fatalf("mid-drag frame has %d braille cells against %d grips: no line was drawn", drawn, grips)
	}
	m, _ = release(t, m, bx, by)
	if len(m.pending) != 1 || m.pending[0].From != st.Sessions[0].ID || m.pending[0].To != st.Sessions[1].ID {
		t.Fatalf("pending = %+v, want %s -> %s", m.pending, shortID(st.Sessions[0].ID), shortID(st.Sessions[1].ID))
	}
	if m.linkFrom != "" || m.dragFrom != "" {
		t.Fatal("a landed drag must clear the armed source and the press")
	}

	// A drag that misses lands nothing and disarms.
	m = click(t, m, gx, gy)
	m = motion(t, m, 40, 48)
	m, _ = release(t, m, 40, 48)
	if len(m.pending) != 1 || m.linkFrom != "" {
		t.Fatalf("a miss changed pending to %d or left %q armed", len(m.pending), m.linkFrom)
	}

	// u pops.
	m = pressGrid(t, m, "u")
	if len(m.pending) != 0 {
		t.Fatal("u should drop the last pending connection")
	}
}

// A drag across a card row draws more line than the adjacent hop above, which
// is a single cell. This is the "pointer at a far corner" case.
func TestGridDragAcrossCardRowsDrawsALongerLine(t *testing.T) {
	m, _ := gridModel(t, 41, 49)
	m.gridBatch = true
	gx, gy := gripAt(t, m, 0)
	nx, ny := cardAt(t, m, 1) // the next card along: a short hop
	fx, fy := cardAt(t, m, 2) // a card row down: a long diagonal

	m = click(t, m, gx, gy)
	m = motion(t, m, nx, ny)
	near := brailleCells(m.Render())
	m = motion(t, m, fx, fy)
	far := brailleCells(m.Render())
	if far <= near {
		t.Fatalf("the longer drag drew no more line: %d cells near, %d far", near, far)
	}
	dump(t, m, 41, 49, "mid-drag across a card row")

	m, _ = release(t, m, fx, fy)
	if len(m.pending) != 1 {
		t.Fatalf("pending = %d, want the far card to have landed", len(m.pending))
	}
}

// With batch off a landing opens the notes form over the one pending
// connection, and enter on its only row sends it. Nothing was typed, so no
// note is posted -- the form is skippable, not compulsory.
func TestGridClickClickLandsAndTheFormSends(t *testing.T) {
	m, st := gridModel(t, 41, 49)
	ax, ay := cardAt(t, m, 0)
	gx, gy := gripAt(t, m, 0)
	bx, by := cardAt(t, m, 2)
	m = click(t, m, ax, ay)
	if m.linkFrom != "" || m.dragFrom != "" {
		t.Fatal("a press on a card's body must not arm: that is where a text selection starts")
	}
	if m.gridCursorID != st.Sessions[0].ID {
		t.Fatal("a press on a card's body should move the cursor to it")
	}
	m = click(t, m, gx, gy)
	if m.linkFrom != st.Sessions[0].ID {
		t.Fatal("a press on the grip should arm the card")
	}
	tm, _ := m.Update(tea.MouseClickMsg{X: bx, Y: by, Button: tea.MouseLeft})
	m = tm.(Model)
	if !m.gridForm.Open || len(m.pending) != 1 {
		t.Fatalf("landing with batch off should open the form over one pending: %+v", m.pending)
	}
	m, cmd := pressKey(t, m, tea.KeyEnter)
	if cmd == nil {
		t.Fatal("enter on the form's last row should send")
	}
	if msg, ok := cmd().(postMsg); !ok || msg.Err != nil {
		t.Fatalf("send returned %#v", msg)
	}
	src := m.src.(*fakeSource)
	if len(src.posts) != 1 || src.posts[0] != "/api/link" {
		t.Fatalf("posts = %v", src.posts)
	}
	b := src.bodies[0]
	if b["from"] != st.Sessions[0].ID || b["to"] != st.Sessions[2].ID || b["kind"] != "brief" {
		t.Fatalf("body = %v", b)
	}
	if _, has := b["note"]; has {
		t.Fatal("no note was collected, so none should be posted")
	}
}

// The mouse is additive and never the only path (global constraint 7), so the
// same three steps -- arm, cancel, land -- have to work from the keyboard with
// no pointer involved at all. b is the batch toggle the head button also has.
func TestGridKeysArmCancelAndLand(t *testing.T) {
	m, st := gridModel(t, 41, 49)

	m = pressGrid(t, m, "l")
	if m.linkFrom != st.Sessions[0].ID {
		t.Fatalf("l armed %q, want the cursor's card", m.linkFrom)
	}
	m = feed(t, m, tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.linkFrom != "" || m.dragFrom != "" {
		t.Fatal("esc must disarm")
	}

	m = pressGrid(t, m, "b")
	if !m.gridBatch {
		t.Fatal("b should turn batch on")
	}
	m = pressGrid(t, m, "l")
	m = feed(t, m, tea.KeyPressMsg{Code: tea.KeyRight})
	m = pressGrid(t, m, "l")
	if len(m.pending) != 1 || m.pending[0].To != st.Sessions[1].ID {
		t.Fatalf("l on a second card with batch on left pending = %+v", m.pending)
	}
	if src := m.src.(*fakeSource); len(src.posts) != 0 {
		t.Fatalf("batch is on, so nothing should have been posted: %v", src.posts)
	}

	// Landing the same pair again replaces it rather than queuing it twice.
	// Landing does not move the cursor, so it is still on card 1: stepping
	// back to card 0 is what makes the second l arm the same sender. Arming
	// card 1 here instead would land 1 -> 0, which is a different connection
	// and would rightly queue a second one.
	m = feed(t, m, tea.KeyPressMsg{Code: tea.KeyLeft})
	m = pressGrid(t, m, "l")
	m = feed(t, m, tea.KeyPressMsg{Code: tea.KeyRight})
	m = pressGrid(t, m, "l")
	if len(m.pending) != 1 || m.pending[0].From != st.Sessions[0].ID || m.pending[0].To != st.Sessions[1].ID {
		t.Fatalf("re-landing a pending pair queued it twice: %+v", m.pending)
	}
}

// typeText drives the form's input the way a person does: one key at a time,
// each carrying its own text.
func typeText(t *testing.T, m Model, s string) Model {
	t.Helper()
	for _, r := range s {
		m = feed(t, m, tea.KeyPressMsg{Code: r, Text: string(r)})
	}
	return m
}

// The batch case: drag one session onto several others,
// then collect every note in one pass and send them together.
func TestGridFormCollectsEveryNoteThenSends(t *testing.T) {
	m, st := gridModel(t, 41, 49)
	m.gridBatch = true
	// l arms card 0; right, l lands 0 -> 1 (the cursor is now on card 1);
	// h back to card 0, l arms it again; right, right, l lands 0 -> 2.
	m = pressGrid(t, m, "l")
	m, _ = pressKey(t, m, tea.KeyRight)
	m = pressGrid(t, m, "l")
	m = pressGrid(t, m, "h")
	m = pressGrid(t, m, "l")
	m, _ = pressKey(t, m, tea.KeyRight)
	m, _ = pressKey(t, m, tea.KeyRight)
	m = pressGrid(t, m, "l")
	if len(m.pending) != 2 || m.pending[1].From != st.Sessions[0].ID {
		t.Fatalf("pending = %+v, want two from %s", m.pending, shortID(st.Sessions[0].ID))
	}
	m, _ = pressKey(t, m, tea.KeyEnter)
	if !m.gridForm.Open || m.gridForm.Row != 0 {
		t.Fatal("enter should open the form on the first row")
	}
	m = typeText(t, m, "alpha")
	m, _ = pressKey(t, m, tea.KeyEnter)
	if m.gridForm.Row != 1 || m.pending[0].Note != "alpha" {
		t.Fatalf("after enter: row %d, note %q", m.gridForm.Row, m.pending[0].Note)
	}
	dump(t, m, 41, 49, "the notes form, second row focused")
	m = typeText(t, m, "beta")
	tm, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = tm.(Model)
	if m.gridForm.Open || len(m.pending) != 0 || cmd == nil {
		t.Fatal("enter on the last row should close the form, clear pending and send")
	}
	if msg, ok := cmd().(postMsg); !ok || msg.Err != nil || msg.OK != "2 briefs queued" {
		t.Fatalf("send returned %#v", msg)
	}
	src := m.src.(*fakeSource)
	if len(src.bodies) != 2 || src.bodies[0]["note"] != "alpha" || src.bodies[1]["note"] != "beta" {
		t.Fatalf("bodies = %v", src.bodies)
	}
	if src.bodies[0]["to"] != st.Sessions[1].ID || src.bodies[1]["to"] != st.Sessions[2].ID {
		t.Fatalf("targets = %v / %v", src.bodies[0]["to"], src.bodies[1]["to"])
	}
}

// While the form is open it owns the keyboard: q must not quit, a digit must
// not switch mode and ? must not open help. They are all just text.
func TestGridFormSwallowsEveryHotkey(t *testing.T) {
	m, _ := gridModel(t, 41, 49)
	m = pressGrid(t, m, "l")
	m, _ = pressKey(t, m, tea.KeyRight)
	m = pressGrid(t, m, "l") // batch is off: the form opens on landing
	if !m.gridForm.Open {
		t.Fatal("landing with batch off should open the form")
	}
	m = pressGrid(t, m, "q")
	m = pressGrid(t, m, "2")
	m = pressGrid(t, m, "?")
	if m.quitting || m.Mode() != ModeGrid || m.showHelp {
		t.Fatal("hotkeys must type into the note while the form is open")
	}
	if got := m.gridForm.in.Value(); got != "q2?" {
		t.Fatalf("note = %q, want %q", got, "q2?")
	}
	// A terminal paste is not a key press: it arrives as its own message and
	// has to reach the input anyway. Its tab and newline land as spaces, so a
	// pasted paragraph is one note and never a sheared row.
	m = feed(t, m, tea.PasteMsg{Content: "one\ttwo\nthree"})
	if got := m.gridForm.in.Value(); got != "q2?one two three" {
		t.Fatalf("after a paste the note is %q", got)
	}
	// A note wider than the pane keeps the frame.
	m = typeText(t, m, strings.Repeat("x", 60))
	dump(t, m, 41, 49, "a note wider than the pane")
	// esc closes the form and keeps the pending connection and its note.
	m, _ = pressKey(t, m, tea.KeyEscape)
	if m.gridForm.Open || len(m.pending) != 1 || m.pending[0].Note == "" {
		t.Fatalf("esc should close the form and keep pending: %+v", m.pending)
	}
}

// The one-to-many case: one briefing typed once, spread with alt+enter to the
// rows still blank, leaving a row that already has its own note untouched.
func TestGridFormFillSpreadsTheNoteToEmptyRowsOnly(t *testing.T) {
	m, st := gridModel(t, 41, 49)
	a, b, c := st.Sessions[0].ID, st.Sessions[1].ID, st.Sessions[2].ID
	m.pending = []gridConn{
		{From: a, To: b},
		{From: b, To: c, Note: "keep this one"},
		{From: c, To: a},
	}
	tm, _ := m.openGridForm()
	m = tm.(Model)
	m = typeText(t, m, "status check")
	m = feed(t, m, tea.KeyPressMsg{Code: tea.KeyEnter, Mod: tea.ModAlt})

	want := []string{"status check", "keep this one", "status check"}
	for i, w := range want {
		if m.pending[i].Note != w {
			t.Fatalf("note %d = %q, want %q", i, m.pending[i].Note, w)
		}
	}
	if !m.gridForm.Open || m.gridForm.Row != 0 {
		t.Fatalf("fill should stay put: open %v, row %d", m.gridForm.Open, m.gridForm.Row)
	}
	dump(t, m, 41, 49, "after alt+enter fill")
}

// A settled link between two visible cards is drawn, in grey braille, and the
// frame still measures exactly what it should at the pane's real width.
func TestGridDrawsSettledWires(t *testing.T) {
	m, st := gridModel(t, 41, 49)
	st.Links = []relay.Link{{ID: "l1", From: st.Sessions[0].ID, To: st.Sessions[1].ID, Kind: "brief"}}
	m = feed(t, m, relay.SnapshotMsg(st))
	out := m.Render()
	assertFrame(t, out, 41, 49)
	assertPaletteOnly(t, out)
	// Every card already wears a braille grip, so presence proves nothing: the
	// wire is the braille this board does not have once its links are gone.
	withWires := brailleCells(out)
	st.Links = nil
	m = feed(t, m, relay.SnapshotMsg(st))
	if without := brailleCells(m.Render()); withWires <= without {
		t.Fatalf("%d braille cells with a link, %d without: no wire was drawn", withWires, without)
	}
}

// w turns them off; the cards are untouched either way.
func TestWToggleTurnsWiresOff(t *testing.T) {
	m, st := gridModel(t, 41, 49)
	st.Links = []relay.Link{{ID: "l1", From: st.Sessions[0].ID, To: st.Sessions[1].ID, Kind: "brief"}}
	m = feed(t, m, relay.SnapshotMsg(st))
	with := ansi.Strip(m.Render())
	m = pressGrid(t, m, "w")
	without := ansi.Strip(m.Render())
	if with == without {
		t.Fatal("w changed nothing")
	}
	if !strings.Contains(without, st.Sessions[0].Name) {
		t.Error("turning wires off must not disturb the cards")
	}
	assertFrame(t, m.Render(), 41, 49)
}

// W narrows to the cursor card's own links.
func TestShiftWNarrowsToTheCursorCard(t *testing.T) {
	m, st := gridModel(t, 41, 49)
	st.Links = []relay.Link{{ID: "l1", From: st.Sessions[1].ID, To: st.Sessions[2].ID, Kind: "brief"}}
	m = feed(t, m, relay.SnapshotMsg(st))
	all := ansi.Strip(m.Render())
	m = pressGrid(t, m, "W")
	only := ansi.Strip(m.Render())
	if all == only {
		t.Fatal("W changed nothing with the cursor away from both ends")
	}
	assertFrame(t, m.Render(), 41, 49)
}
