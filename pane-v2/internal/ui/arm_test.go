package ui

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/adenineio/syzygy/pane-v2/internal/ident"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
)

func armed(m Model, key, target string) Model {
	m.arm(Arm{Mode: m.mode, Key: key, Target: target, Label: "KILL demo", Short: "KILL ?"})
	return m
}

// pressCmd presses a key and hands back the command it produced, UNRUN.
//
// Update returns a write as a tea.Cmd rather than performing it, so a test that
// only presses the key sees no post at all. Running it is always the test's own
// decision, because some of those commands are timers -- an arm's expiry, a
// toast's -- and calling one sleeps for its whole window.
func pressCmd(t *testing.T, m Model, s string) (Model, tea.Cmd) {
	t.Helper()
	tm, cmd := m.Update(tea.KeyPressMsg{Code: []rune(s)[0], Text: s})
	md := tm.(Model)
	md.now = frozen
	return md, cmd
}

// settles runs cmd and reports whether it came back at once, with its message.
//
// A first press that only arms still returns a command -- the arm's own expiry
// timer -- so "no command" can no longer stand for "no write". A write against
// a temp file or the fake source returns immediately; a timer waits out its
// whole window. So a command that has not settled well inside armWindow is a
// timer, and cannot have written anything.
func settles(t *testing.T, cmd tea.Cmd) (tea.Msg, bool) {
	t.Helper()
	if cmd == nil {
		return nil, false
	}
	ch := make(chan tea.Msg, 1)
	go func() { ch <- cmd() }()
	select {
	case msg := <-ch:
		return msg, true
	case <-time.After(200 * time.Millisecond):
		return nil, false
	}
}

func TestAnArmIsOverOneTargetAndExpires(t *testing.T) {
	m := Model{now: frozen, mode: ModeBoard}
	m = armed(m, "x", "t1")
	if !m.isArmed("x", "t1") {
		t.Error("a fresh arm is live")
	}
	if m.isArmed("x", "t2") || m.isArmed("X", "t1") {
		t.Error("an arm is over one key and one target, not over the mode")
	}
	m.now = frozen.Add(armWindow - time.Millisecond)
	if !m.isArmed("x", "t1") {
		t.Error("still live just inside the window")
	}
	m.now = frozen.Add(armWindow)
	if m.isArmed("x", "t1") {
		t.Error("expired at the window")
	}
}

func TestLeavingTheModeDisarms(t *testing.T) {
	m := Model{now: frozen, mode: ModeBoard}
	m = armed(m, "x", "t1")
	md, _ := m.setMode(ModeFeed)
	if md.(Model).isArmed("x", "t1") {
		t.Error("an arm belongs to the mode it was started in")
	}
}

func TestADisconnectDisarmsOnlyWhatNeedsTheRelay(t *testing.T) {
	src := newFakeSource()
	m := New(src, ident.Static{}, Config{Now: func() time.Time { return frozen }})
	m.now, m.mode = frozen, ModeBoard
	m.arm(Arm{Mode: ModeBoard, Key: "x", Target: "t1", Label: "KILL demo", NeedsRelay: true})
	md, _ := m.Update(relay.ConnMsg{State: relay.Down})
	if md.(Model).isArmed("x", "t1") {
		t.Error("a gesture that needs the relay must not stay armed while it is down")
	}

	m2 := New(src, ident.Static{}, Config{Now: func() time.Time { return frozen }})
	m2.now, m2.mode = frozen, ModeHotkeys
	m2.arm(Arm{Mode: ModeHotkeys, Key: "x", Target: "3", Label: "CLEAR 3"})
	md2, _ := m2.Update(relay.ConnMsg{State: relay.Down})
	if !md2.(Model).isArmed("x", "3") {
		t.Error("a local file edit still works with the relay down, so its arm survives")
	}
}

func TestTheStripHoldsTheFrameAndIsNotClickable(t *testing.T) {
	for _, w := range []int{30, 41, 60} {
		// boardModel has already fed the snapshot. Feeding it again would read
		// as the relay coming back, and that toast rightly outranks the strip.
		m, st, _ := boardModel(t, w, 40)
		m.arm(Arm{Mode: ModeBoard, Key: "x", Target: st.Sessions[0].ID,
			Label: "KILL demo-project", Short: "KILL ?", Expires: frozen.Add(armWindow)})
		out := m.Render()
		assertFrame(t, out, w, 40)
		assertPaletteOnly(t, out)
		if n := invertRuns(out); n > 3 {
			t.Fatalf("%d columns: %d inverted runs, want <= 3", w, n)
		}
		if !strings.Contains(ansi.Strip(out), "3s") {
			t.Errorf("%d columns: no countdown on the strip:\n%s", w, ansi.Strip(out))
		}
		for _, r := range m.regions() {
			if r.Y == 39 {
				t.Fatalf("%d columns: the armed strip's row is a hit region", w)
			}
		}
	}
}

func TestAnyOtherKeyDisarmsAndFallsThrough(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)
	m = feed(t, m, relay.SnapshotMsg(st))
	m.arm(Arm{Mode: ModeBoard, Key: "x", Target: st.Sessions[0].ID, Label: "KILL demo-project"})
	m = pressBoard(t, m, "2")
	if m.isArmed("x", st.Sessions[0].ID) {
		t.Error("a stray key must disarm")
	}
	if m.Mode() != ModeFeed {
		t.Error("and must still do what it does -- disarm, then fall through")
	}
}

func TestEscDisarms(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)
	m.arm(Arm{Mode: ModeBoard, Key: "x", Target: st.Sessions[0].ID, Label: "KILL demo-project"})
	m, _ = pressKey(t, m, tea.KeyEscape)
	if m.isArmed("x", st.Sessions[0].ID) {
		t.Error("esc cancels anything waiting on a second press")
	}
}
