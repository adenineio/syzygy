package ui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/ident"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// mouseModel is a model sized w x h, pinned to the fixture's first session and
// showing the whole board.
func mouseModel(t *testing.T, w, h int) (Model, relay.State) {
	t.Helper()
	st := loadFixture(t)
	self := st.Sessions[0].ID
	m, _ := newModel(t, w, h, ident.Result{ID: self, How: ident.PaneTree})
	m = feed(t, m, relay.SnapshotMsg(st), IdentResult(ident.Result{ID: self, How: ident.PaneTree}))
	return m, st
}

func click(t *testing.T, m Model, x, y int) Model {
	t.Helper()
	tm, _ := m.Update(tea.MouseClickMsg{X: x, Y: y, Button: tea.MouseLeft})
	m = tm.(Model)
	m.now = frozen
	return m
}

func wheel(t *testing.T, m Model, b tea.MouseButton, n int) Model {
	t.Helper()
	for i := 0; i < n; i++ {
		tm, _ := m.Update(tea.MouseWheelMsg{X: 1, Y: 5, Button: b})
		m = tm.(Model)
		m.now = frozen
	}
	return m
}

// lineAt returns one rendered line with the styling stripped.
func lineAt(t *testing.T, m Model, y int) string {
	t.Helper()
	lines := strings.Split(ansi.Strip(m.Render()), "\n")
	if y >= len(lines) {
		t.Fatalf("frame has %d lines, wanted line %d", len(lines), y)
	}
	return lines[y]
}

// columnOf finds the display column a substring starts at. Byte offsets are
// not columns once a row carries a multi-byte glyph.
func columnOf(t *testing.T, line, sub string) int {
	t.Helper()
	i := strings.Index(line, sub)
	if i < 0 {
		t.Fatalf("%q is not in %q", sub, line)
	}
	return fmtx.W(line[:i])
}

// The registry's own arithmetic, with no model in sight.
func TestHitRegionsResolveTheTopmostAndMissByOneCell(t *testing.T) {
	f := NewFrame(60, 30)
	var regs []region
	regs = addRegion(regs, f, region{X: 2, Y: 3, W: 6, H: 2, Act: actMode, Mode: ModeFeed})
	regs = addRegion(regs, f, region{X: 4, Y: 3, W: 6, H: 1, Act: actMode, Mode: ModeBoard})
	if len(regs) != 2 {
		t.Fatalf("registered %d regions, want 2", len(regs))
	}

	cases := []struct {
		name string
		x, y int
		want Mode
		hit  bool
	}{
		{"inside the first", 2, 3, ModeFeed, true},
		{"its far corner", 3, 4, ModeFeed, true},
		{"one cell left", 1, 3, 0, false},
		{"one cell above", 2, 2, 0, false},
		{"one cell right", 10, 3, 0, false},
		{"one cell below", 2, 5, 0, false},
		{"the overlap goes to the topmost", 5, 3, ModeBoard, true},
		{"below the overlap is the first again", 5, 4, ModeFeed, true},
		{"empty space", 40, 20, 0, false},
	}
	for _, tc := range cases {
		got, ok := hitAt(regs, tc.x, tc.y)
		if ok != tc.hit {
			t.Errorf("%s: (%d,%d) hit=%v, want %v", tc.name, tc.x, tc.y, ok, tc.hit)
			continue
		}
		if ok && got.Mode != tc.want {
			t.Errorf("%s: (%d,%d) resolved to %v, want %v", tc.name, tc.x, tc.y, got.Mode, tc.want)
		}
	}

	// A hitbox never extends past what was drawn: a rectangle running off the
	// frame is clipped, and one entirely off it is dropped.
	clipped := addRegion(nil, f, region{X: 56, Y: 1, W: 10, H: 1, Act: actMode, Mode: ModeFeed})
	if len(clipped) != 1 || clipped[0].W != 4 {
		t.Fatalf("a region running off the frame must be clipped to it, got %#v", clipped)
	}
	if _, ok := hitAt(clipped, 60, 1); ok {
		t.Error("a click past the right edge must not resolve to a clipped region")
	}
	if off := addRegion(nil, f, region{X: 61, Y: 1, W: 4, H: 1, Act: actMode}); len(off) != 0 {
		t.Errorf("a region entirely off the frame must be dropped, got %#v", off)
	}
}

// The one global gesture: the tab strip, whose hitboxes move as the header
// narrows and its labels shorten.
func TestClickingAModeTabSwitchesModeAtEveryBreakpoint(t *testing.T) {
	for _, w := range []int{60, 40, 30} {
		for _, want := range AllModes {
			m, _ := mouseModel(t, w, 30)
			m.mode = ModeVitals
			if want == ModeVitals {
				m.mode = ModeBoard // so a switch to VITALS is a change
			}
			strip := lineAt(t, m, 1)
			// The strip abbreviates whenever five full labels and the ? do
			// not both fit, so the caption to aim at comes from the same
			// layout the renderer drew rather than from the breakpoint.
			label := want.Label()
			for _, sp := range tabSpans(m.frame) {
				if sp.mode == want {
					label = sp.label
				}
			}
			x := columnOf(t, strip, label)
			if got := click(t, m, x, 1).Mode(); got != want {
				t.Errorf("%d cols: clicking %q at column %d left the pane in %v, want %v",
					w, label, x, got, want)
			}
			// The tab's padding cell is part of its block.
			if got := click(t, m, x-1, 1).Mode(); got != want {
				t.Errorf("%d cols: clicking the pad before %q left the pane in %v, want %v",
					w, label, got, want)
			}
		}
	}
}

func TestClicksOffTheTabStripAreIgnored(t *testing.T) {
	m, _ := mouseModel(t, 60, 30)
	m.mode = ModeVitals
	strip := lineAt(t, m, 1)
	x := columnOf(t, strip, "BOARD")

	// The same column one row up is the session name, not a tab.
	if got := click(t, m, x, 0).Mode(); got != ModeVitals {
		t.Errorf("a click on the header's first row switched to %v", got)
	}
	// The same column one row down is the body.
	if got := click(t, m, x, 2).Mode(); got != ModeVitals {
		t.Errorf("a click on the body switched to %v", got)
	}
	// The right-hand end of the strip is `? help`, which is not a tab.
	after := click(t, m, 58, 1)
	if after.Mode() != ModeVitals || after.showHelp {
		t.Errorf("a click past the last tab did something: mode %v, help %v", after.Mode(), after.showHelp)
	}
	// A click that resolves to nothing leaves the frame exactly as it was.
	if before := m.Render(); after.Render() != before {
		t.Error("a click on empty space changed the frame")
	}
}

func TestWheelScrollsTheFeedAndRePinsFollow(t *testing.T) {
	m, _ := feedModel(t, 60, 30)
	newest := feedLines(t, m)[0]

	m = wheel(t, m, tea.MouseWheelDown, 1)
	if got := feedLines(t, m)[0]; got == newest {
		t.Fatal("a wheel-down notch did not move the feed")
	}
	if h := headFollow(t, m); !strings.Contains(h, "follow "+theme.GOff) {
		t.Fatalf("scrolling away from the newest must un-pin follow: %q", h)
	}

	// Back up one notch: the viewport returns to the newest event and re-pins.
	m = wheel(t, m, tea.MouseWheelUp, 1)
	if got := feedLines(t, m)[0]; got != newest {
		t.Fatalf("a wheel-up notch did not return to the newest event:\n got %q\nwant %q", got, newest)
	}
	if h := headFollow(t, m); !strings.Contains(h, "follow "+theme.GOn) {
		t.Fatalf("returning to the newest must re-pin follow: %q", h)
	}

	// Two rows of slack and a three-row notch: wheeling up near the top
	// overshoots, clamps to the newest and re-pins, which is what g does.
	m = pressFeed(t, m, "j")
	m = pressFeed(t, m, "j")
	m = wheel(t, m, tea.MouseWheelUp, 1)
	if h := headFollow(t, m); !strings.Contains(h, "follow "+theme.GOn) {
		t.Fatalf("wheeling up near the top must re-pin follow: %q", h)
	}

	// The far end clamps: past the oldest event the viewport stops.
	m = wheel(t, m, tea.MouseWheelDown, 200)
	oldest := feedLines(t, m)[0]
	m = wheel(t, m, tea.MouseWheelDown, 5)
	if got := feedLines(t, m)[0]; got != oldest {
		t.Errorf("the feed scrolled past its oldest event:\n got %q\nwant %q", got, oldest)
	}
	if got := feedLines(t, m)[0]; got == newest {
		t.Error("scrolling to the far end left the viewport on the newest event")
	}
}

// Every other mode moves the body offset, which is what j/k do, and the
// offset cannot go negative.
func TestWheelMovesTheBodyAndStopsAtTheTop(t *testing.T) {
	// A short pane, so the vitals body genuinely overflows its budget and the
	// movement is visible rather than only recorded.
	m, _ := mouseModel(t, 60, 18)
	top := lineAt(t, m, 2)

	max := m.maxScroll(m.frame)
	if max < 1 {
		t.Fatal("the body fits its budget at this size, so this test proves nothing")
	}

	m = wheel(t, m, tea.MouseWheelDown, 1)
	if want := minInt(wheelStep, max); m.scroll != want {
		t.Errorf("a wheel-down notch moved the offset to %d, want %d", m.scroll, want)
	}
	if got := lineAt(t, m, 2); got == top {
		t.Errorf("a wheel-down notch did not move the body: still %q", got)
	}
	assertFrame(t, m.Render(), 60, 18)

	// The far end clamps to what the render can use. A flick that banked 20
	// notches of unusable offset would make the reader wheel most of them
	// back before a single row moved.
	flicked := wheel(t, m, tea.MouseWheelDown, 20)
	if flicked.scroll != max {
		t.Errorf("a 20-notch flick banked an offset of %d, want the ceiling %d", flicked.scroll, max)
	}
	end := lineAt(t, flicked, 2)
	if back := wheel(t, flicked, tea.MouseWheelUp, 1); lineAt(t, back, 2) == end {
		t.Error("one notch up after a flick did not move the body")
	}

	m = wheel(t, m, tea.MouseWheelUp, 1)
	if m.scroll != 0 {
		t.Errorf("a wheel-up notch left the offset at %d, want 0", m.scroll)
	}
	if got := lineAt(t, m, 2); got != top {
		t.Errorf("a wheel-up notch did not return the body:\n got %q\nwant %q", got, top)
	}

	m = wheel(t, m, tea.MouseWheelUp, 4)
	if m.scroll != 0 {
		t.Errorf("wheeling up at the top drove the offset to %d, want 0", m.scroll)
	}
	if got := lineAt(t, m, 2); got != top {
		t.Errorf("wheeling up at the top moved the body to %q", got)
	}
}

// The wheel is the one gesture the help overlay keeps, because the overlay is
// the thing being scrolled.
func TestWheelScrollsTheHelpOverlayWhicheverModeItIsOver(t *testing.T) {
	m, _ := feedModel(t, 60, 18)
	m.showHelp = true
	before := m.feedTop

	m = wheel(t, m, tea.MouseWheelDown, 1)
	if m.scroll != wheelStep {
		t.Errorf("the wheel moved the overlay to %d, want %d", m.scroll, wheelStep)
	}
	if m.feedTop != before {
		t.Errorf("the wheel moved the feed underneath the overlay: %d -> %d", before, m.feedTop)
	}
}

func TestTheMouseIsOnInCellMotion(t *testing.T) {
	m, _ := mouseModel(t, 60, 30)
	if got := m.View().MouseMode; got != tea.MouseModeCellMotion {
		t.Fatalf("the view asks for mouse mode %v, want cell motion", got)
	}
}

// What the pane does not use, it drops: motion frames and the other buttons
// leave the model exactly as it was, so they cost no repaint.
func TestMotionAndOtherButtonsChangeNothing(t *testing.T) {
	m, _ := mouseModel(t, 60, 30)
	m.mode = ModeVitals
	strip := lineAt(t, m, 1)
	x := columnOf(t, strip, "BOARD")
	before := m.Render()

	for _, msg := range []tea.Msg{
		tea.MouseMotionMsg{X: x, Y: 1, Button: tea.MouseLeft},
		tea.MouseMotionMsg{X: x, Y: 1},
		tea.MouseClickMsg{X: x, Y: 1, Button: tea.MouseRight},
		tea.MouseWheelMsg{X: x, Y: 5, Button: tea.MouseWheelLeft},
	} {
		tm, cmd := m.Update(msg)
		got := tm.(Model)
		if got.Mode() != ModeVitals || got.scroll != 0 {
			t.Errorf("%T changed the model: mode %v, scroll %d", msg, got.Mode(), got.scroll)
		}
		if cmd != nil {
			t.Errorf("%T returned a command", msg)
		}
		if got.Render() != before {
			t.Errorf("%T changed the frame", msg)
		}
	}
}
