package ui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/adenineio/syzygy/pane-v2/internal/relay"
)

func pressSpace(t *testing.T, m Model) Model {
	t.Helper()
	tm, _ := m.Update(tea.KeyPressMsg{Code: tea.KeySpace})
	md := tm.(Model)
	md.now = frozen
	return md
}

func TestSpaceArmsTheLeaderAndNamesTheBank(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)
	m = feed(t, m, relay.SnapshotMsg(st))
	// The second snapshot raises "relay back", and a toast outranks every other
	// claim on the last row; clear it so the row is the leader's to take.
	m.toast = Toast{}
	m = pressSpace(t, m)
	out := ansi.Strip(m.Render())
	if !strings.Contains(out, "LEADER") {
		t.Fatalf("no leader hint:\n%s", out)
	}
	for _, e := range ModeBank {
		if !strings.Contains(out, e.Caption) {
			t.Errorf("the hint does not offer %s:\n%s", e.Caption, out)
		}
	}
	assertFrame(t, m.Render(), 60, 40)
	assertPaletteOnly(t, m.Render())
	if n := invertRuns(m.Render()); n > 3 {
		t.Errorf("the leader hint is inverted; it must be plain yellow text (%d runs)", n)
	}
}

func TestAReservedBankKeySaysSoAndSwitchesNothing(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)
	m = feed(t, m, relay.SnapshotMsg(st))
	m = pressSpace(t, m)
	m = pressBoard(t, m, "o")
	if m.Mode() != ModeBoard {
		t.Fatalf("a reserved key switched mode to %v", m.Mode())
	}
	if !strings.Contains(ansi.Strip(m.Render()), "not built") {
		t.Errorf("a reserved key must say why it did nothing:\n%s", ansi.Strip(m.Render()))
	}
	if m.leader {
		t.Error("the leader is spent by the second keystroke")
	}
}

func TestAStrayKeyCancelsTheLeaderAndStillActs(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)
	m = feed(t, m, relay.SnapshotMsg(st))
	m = pressSpace(t, m)
	m = pressBoard(t, m, "2")
	if m.leader {
		t.Error("a key outside the bank cancels the leader")
	}
	if m.Mode() != ModeFeed {
		t.Error("and still does what it does")
	}
}

func TestTheLeaderAndAnArmNeverCoexist(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)
	m = feed(t, m, relay.SnapshotMsg(st))
	m = pressSpace(t, m)
	m.arm(Arm{Mode: ModeBoard, Key: "x", Target: "t1", Label: "KILL demo"})
	if m.leader {
		t.Error("arming cancels the leader")
	}
}

func TestSpaceQuestionListsTheBank(t *testing.T) {
	m, st, _ := boardModel(t, 60, 40)
	m = feed(t, m, relay.SnapshotMsg(st))
	m = pressSpace(t, m)
	m = pressBoard(t, m, "?")
	out := ansi.Strip(m.Render())
	for _, e := range ModeBank {
		if !strings.Contains(out, e.Caption) || !strings.Contains(out, e.Reserved) {
			t.Errorf("the bank listing does not explain %s:\n%s", e.Caption, out)
		}
	}
	assertFrame(t, m.Render(), 60, 40)
}

// The strip stays at seven tabs however many modes the bank holds.
func TestTheBankAddsNoTab(t *testing.T) {
	if len(AllModes) != 7 {
		t.Fatalf("AllModes has %d modes, want 7", len(AllModes))
	}
	for _, e := range ModeBank {
		for _, m := range AllModes {
			if e.Reserved == "" && e.Mode == m {
				t.Errorf("%s is in the bank AND on the strip", e.Caption)
			}
		}
	}
}
