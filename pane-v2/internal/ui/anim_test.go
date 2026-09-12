package ui

import (
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/ident"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
)

// The testing policy for this feature is deliberately narrow: three things
// that break the pane hard and silently, and nothing about how any spinner
// looks. Appearance is verified by rendering frames and reading them, which no
// golden file does honestly.

// workingModel pins the fixture's working session, which is the one with live
// agents, so the spinner has more than one track to draw.
func workingModel(t *testing.T, w, h int) Model {
	t.Helper()
	st := loadFixture(t)
	self := st.Sessions[0].ID
	if !st.Sessions[0].Working {
		t.Fatal("fixture session 0 is not working; the spinner tests need one that is")
	}
	m, _ := newModel(t, w, h, ident.Result{ID: self, How: ident.PaneTree})
	return feed(t, m, relay.SnapshotMsg(st), IdentResult(ident.Result{ID: self, How: ident.PaneTree}))
}

// The shipped set, asserted BY NAME rather than by count. A count alone passes
// a swap -- one spinner removed and another added -- which is exactly the
// accident this guards, since `s` cycles by index and a pane that has been
// left on index 3 silently lands somewhere else.
func TestTheShippedSpinnerSet(t *testing.T) {
	want := []struct{ id, name string }{
		{"orrery", "Orrery"},
		{"galvanometer", "Galvanometer"},
	}
	if len(spinners) != len(want) {
		t.Fatalf("want %d spinners, got %d: %+v", len(want), len(spinners), spinners)
	}
	for i, w := range want {
		if spinners[i].ID != w.id || spinners[i].Name != w.name {
			t.Errorf("spinner %d = %q/%q, want %q/%q", i, spinners[i].ID, spinners[i].Name, w.id, w.name)
		}
		if spinners[i].Draw == nil {
			t.Errorf("spinner %q has no draw function", w.id)
		}
	}
}

// The two invariants that fail invisibly and corrupt the whole pane: a frame
// that is not exactly H lines of exactly W cells, and a colour the terminal's
// own scheme does not own. A braille rune that measured two columns would
// shear every row below it.
func TestSpinnerHoldsTheFrameAndPalette(t *testing.T) {
	for _, w := range []int{60, 41, 30} {
		m := workingModel(t, w, 30)
		// Every spinner, not just whichever one the picker starts on: the
		// invariant is about the frames the pane can emit, and s can put any
		// of them on screen.
		for pick := range spinners {
			m.spinPick = pick
			for i := 0; i < 5; i++ {
				m.anim = i * 7
				out := m.Render()
				assertFrame(t, out, w, 30)
				assertPaletteOnly(t, out)
			}
		}
	}
}

// The constraint that must not be traded away. A leaked 30 fps ticker burns a
// core beside an idle session and no other test in this suite would see it.
func TestTheTickerStopsWhenNothingIsAnimating(t *testing.T) {
	m, _ := newModel(t, 60, 30, ident.Result{})
	m.animOn = true
	if m.animating() {
		t.Fatal("an idle pane with no session reports itself animating")
	}
	tm, cmd := m.Update(frameMsg{})
	if cmd != nil {
		t.Fatal("an idle pane rescheduled the frame ticker")
	}
	if tm.(Model).animOn {
		t.Fatal("animOn stayed set with nothing animating")
	}
	if got := tm.(Model).anim; got != 0 {
		t.Fatalf("the frame counter advanced to %d with nothing animating", got)
	}
}

// spin is optional on the wire: an older plugin, or a session that has not
// rendered a Spinner yet, sends nothing. Every reader tolerates the nil.
func TestASessionWithNoSpinFieldStillRenders(t *testing.T) {
	m := workingModel(t, 60, 30)
	s, ok := m.focusedOrLast()
	if !ok {
		t.Fatal("no focused session")
	}
	if s.Spin != nil {
		t.Fatal("the fixture now carries a spin field; this test needs one without")
	}
	if got := m.spinStateOf(s, 60, 8).Mode; got != "thinking" {
		t.Fatalf("nil Spin fell back to mode %q, want the thinking default", got)
	}
	out := m.Render()
	assertFrame(t, out, 60, 30)
	assertPaletteOnly(t, out)
}

var _ tea.Msg = frameMsg{}
