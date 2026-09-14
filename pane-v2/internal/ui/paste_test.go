package ui

import (
	"strings"
	"testing"
	"time"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/adenineio/syzygy/pane-v2/internal/ident"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
)

func TestPasteTookTheConsoleSlotAndTheStripStaysSeven(t *testing.T) {
	if len(AllModes) != 7 {
		t.Fatalf("AllModes has %d modes, want 7 -- an eighth tab moves the width arithmetic", len(AllModes))
	}
	if ParseMode("paste") != ModePaste || ParseMode("pasteboard") != ModePaste {
		t.Errorf("--mode paste does not select PASTE")
	}
	if ParseMode("console") == ModePaste {
		t.Errorf("console must no longer name a mode")
	}
	cases := map[string]string{
		"label": ModePaste.Label(), "short": ModePaste.Short(), "tiny": ModePaste.Tiny(),
	}
	want := map[string]string{"label": "PASTE", "short": "PASTE", "tiny": "P"}
	for k, got := range cases {
		if got != want[k] {
			t.Errorf("%s caption = %q, want %q", k, got, want[k])
		}
	}
	if len(ModePaste.Short()) > len("CONSOLE") {
		t.Errorf("the short caption grew, which would cost a width tier")
	}
	for _, m := range AllModes {
		if !m.Built() {
			t.Errorf("%v is unbuilt; every mode is built now", m)
		}
	}
}

func TestPasteArmExpiresAfterThreeSeconds(t *testing.T) {
	base := time.Now()
	m := Model{now: base, mode: ModePaste}
	m.arm(Arm{Mode: ModePaste, Key: "x", Target: "e1", Label: "DELETE this stash", NeedsRelay: true})
	if !m.isArmed("x", "e1") {
		t.Errorf("a fresh arm is live")
	}
	if m.isArmed("x", "e2") {
		t.Errorf("an arm is over ONE entry, not over the mode")
	}
	m.now = base.Add(armWindow - time.Millisecond)
	if !m.isArmed("x", "e1") {
		t.Errorf("still live just inside the window")
	}
	m.now = base.Add(armWindow)
	if m.isArmed("x", "e1") {
		t.Errorf("expired exactly at the window")
	}
}

func TestPasteScopeToggles(t *testing.T) {
	if pbSession.Other() != pbGlobal || pbGlobal.Other() != pbSession {
		t.Errorf("t must toggle between the two boards")
	}
	if pbSession.String() != "SESSION" || pbGlobal.String() != "GLOBAL" {
		t.Errorf("the header names the scope")
	}
}

func TestPasteRowsAreScoped(t *testing.T) {
	m := Model{
		pasteboard: []relay.Paste{
			{ID: "a", SessionID: "s1", Text: "mine"},
			{ID: "b", SessionID: "", Text: "ours"},
			{ID: "c", SessionID: "s2", Text: "theirs"},
		},
	}
	m.pb.scope = pbGlobal
	got := m.pbRows()
	if len(got) != 1 || got[0].ID != "b" {
		t.Errorf("the global board is the entries no session owns, got %v", got)
	}
}

func TestPasteCaptionPrefersATitleThenTheFirstRealLine(t *testing.T) {
	cases := []struct {
		in   relay.Paste
		want string
	}{
		{relay.Paste{Title: "argv", Text: "anything"}, "argv"},
		{relay.Paste{Text: "\n\n  the first real line\nsecond"}, "the first real line"},
		{relay.Paste{Text: "   "}, "empty"},
	}
	for _, c := range cases {
		if got := pbCaption(c.in); got != c.want {
			t.Errorf("pbCaption(%q) = %q, want %q", c.in.Text, got, c.want)
		}
	}
}

// pressPaste sends a printable key through Update, the way the terminal does.
func pressPaste(t *testing.T, m Model, s string) Model {
	t.Helper()
	tm, _ := m.Update(tea.KeyPressMsg{Code: []rune(s)[0], Text: s})
	m = tm.(Model)
	m.now = frozen
	return m
}

// pasteModel is a sized, identified model already in PASTE, with two entries
// on the focused session's board and one on the global board.
func pasteModel(t *testing.T, w, h int) (Model, relay.Session) {
	t.Helper()
	st := loadFixture(t)
	self := st.Sessions[0]
	res := ident.Result{ID: self.ID, How: ident.PaneTree}
	m, _ := newModel(t, w, h, res)
	m = feed(t, m, relay.SnapshotMsg(st), IdentResult(res), relay.PasteboardMsg{
		{ID: "e1", SessionID: self.ID, SessionName: self.Name, Text: "first stash", Order: 0},
		{ID: "e2", SessionID: self.ID, SessionName: self.Name, Text: "second stash", Order: 1},
		{ID: "g1", Text: "shared stash", Order: 0},
	})
	m = pressPaste(t, m, "3")
	if m.Mode() != ModePaste {
		t.Fatalf("3 should select PASTE, got %v", m.Mode())
	}
	if n := len(m.pbRows()); n != 2 {
		t.Fatalf("the focused session's board has %d rows, want 2", n)
	}
	return m, self
}

func TestPasteArmIsCancelledByEveryOtherGesture(t *testing.T) {
	cases := []struct {
		name string
		do   func(*testing.T, Model) Model
	}{
		{"j", func(t *testing.T, m Model) Model { return pressPaste(t, m, "j") }},
		{"k", func(t *testing.T, m Model) Model { return pressPaste(t, m, "k") }},
		{"J", func(t *testing.T, m Model) Model { return pressPaste(t, m, "J") }},
		{"K", func(t *testing.T, m Model) Model { return pressPaste(t, m, "K") }},
		{"t", func(t *testing.T, m Model) Model { return pressPaste(t, m, "t") }},
		{"esc", func(t *testing.T, m Model) Model { m, _ = pressKey(t, m, tea.KeyEscape); return m }},
		{"leaving the mode", func(t *testing.T, m Model) Model { return pressPaste(t, m, "2") }},
		{"home", func(t *testing.T, m Model) Model { return pressPaste(t, m, "0") }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, _ := pasteModel(t, 60, 30)
			m = pressPaste(t, m, "x")
			if !m.isArmed("x", "e1") {
				t.Fatalf("x did not arm the entry under the cursor")
			}
			if m = c.do(t, m); m.hasArm {
				t.Errorf("%s left the x arm live", c.name)
			}
		})
	}
}

func TestPasteDeleteNeedsTwoPressesOnTheSameEntry(t *testing.T) {
	m, _ := pasteModel(t, 60, 30)
	src := m.src.(*fakeSource)
	x := tea.KeyPressMsg{Code: 'x', Text: "x"}

	m = pressPaste(t, m, "x")
	if len(src.posts) != 0 {
		t.Fatalf("one x must not write, got %v", src.posts)
	}
	out := m.Render()
	assertFrame(t, out, 60, 30)
	assertPaletteOnly(t, out)
	if !strings.Contains(ansi.Strip(out), "DELETE this stash ?") {
		t.Errorf("the armed confirm is not on the last row\n%s", ansi.Strip(out))
	}

	md, cmd, handled := m.onPbKey(x)
	if !handled || cmd == nil {
		t.Fatalf("the second x did not delete")
	}
	if md.(Model).hasArm {
		t.Errorf("a delete leaves the arm live")
	}
	if msg, ok := cmd().(postMsg); !ok || msg.Err != nil {
		t.Fatalf("delete post failed: %+v", msg)
	}
	if len(src.posts) != 1 || src.posts[0] != "/api/pasteboard/delete" || src.bodies[0]["id"] != "e1" {
		t.Errorf("delete posted %v %v", src.posts, src.bodies)
	}

	// An arm that has run out re-arms instead of deleting.
	m = pressPaste(t, m, "j")
	m = pressPaste(t, m, "x")
	m.now = frozen.Add(armWindow)
	md, cmd, _ = m.onPbKey(x)
	if _, done := settles(t, cmd); done || len(src.posts) != 1 {
		t.Errorf("an expired arm deleted")
	}
	if !md.(Model).isArmed("x", "e2") {
		t.Errorf("an x after the window re-arms the entry under the cursor")
	}
}

func TestPasteEnterFillsTheFocusedSessionAndSaysTheComposerWasReplaced(t *testing.T) {
	m, self := pasteModel(t, 60, 30)
	src := m.src.(*fakeSource)
	_, cmd, handled := m.onPbKey(tea.KeyPressMsg{Code: tea.KeyEnter})
	if !handled || cmd == nil {
		t.Fatalf("enter did not fill")
	}
	msg, ok := cmd().(postMsg)
	if !ok || msg.Err != nil {
		t.Fatalf("fill post failed: %+v", msg)
	}
	if !strings.Contains(msg.OK, "its composer was replaced") {
		t.Errorf("fill toast %q does not say the composer was replaced", msg.OK)
	}
	if len(src.posts) != 1 || src.posts[0] != "/api/pasteboard/fill" ||
		src.bodies[0]["id"] != "e1" || src.bodies[0]["targetId"] != self.ID {
		t.Errorf("fill posted %v %v", src.posts, src.bodies)
	}
}

func TestPasteShiftMovesTheEntryAndTheCursorWithIt(t *testing.T) {
	m, _ := pasteModel(t, 60, 30)
	src := m.src.(*fakeSource)
	md, cmd, _ := m.onPbKey(tea.KeyPressMsg{Code: 'J', Text: "J"})
	if cmd == nil {
		t.Fatalf("J did not reorder")
	}
	cmd()
	if md.(Model).pb.row != 1 {
		t.Errorf("the cursor stays on the moved entry, row = %d", md.(Model).pb.row)
	}
	if len(src.posts) != 1 || src.posts[0] != "/api/pasteboard/reorder" ||
		src.bodies[0]["id"] != "e1" || src.bodies[0]["dir"] != "down" {
		t.Errorf("J posted %v %v", src.posts, src.bodies)
	}
}

func TestPasteBindsNoRefreshKey(t *testing.T) {
	k := DefaultKeys().Paste
	for _, b := range []key.Binding{k.Up, k.Down, k.MoveUp, k.MoveDown, k.Fill, k.Delete, k.Scope} {
		for _, s := range b.Keys() {
			if s == "r" {
				t.Errorf("PASTE binds r; the view redraws on every relay message")
			}
		}
	}
	m, _ := pasteModel(t, 60, 30)
	if _, _, handled := m.onPbKey(tea.KeyPressMsg{Code: 'r', Text: "r"}); handled {
		t.Errorf("r is handled in PASTE")
	}
}

func TestPasteRendersInsideTheFrameAtEveryWidth(t *testing.T) {
	for _, w := range []int{30, 41, 60, 90} {
		m, _ := pasteModel(t, w, 30)
		for _, scope := range []pbScope{pbSession, pbGlobal} {
			m.pb.scope = scope
			out := m.Render()
			assertFrame(t, out, w, 30)
			assertPaletteOnly(t, out)
			plain := ansi.Strip(out)
			if !strings.Contains(plain, scope.String()) {
				t.Errorf("width %d: the head does not name %s\n%s", w, scope, plain)
			}
		}
	}
}

func TestPasteCursorFollowsTheBoardItIndexes(t *testing.T) {
	cases := []struct {
		name  string
		row   int
		board func(self relay.Session) relay.PasteboardMsg // nil keeps the two-entry board
		// want is the entry the cursor lands on; "" means the board is empty.
		want, caption string
	}{
		{name: "past the end of two entries", row: 5, want: "e2", caption: "second stash"},
		{name: "negative", row: -3, want: "e1", caption: "first stash"},
		{
			name: "the board shrank under it", row: 1,
			board: func(self relay.Session) relay.PasteboardMsg {
				return relay.PasteboardMsg{
					{ID: "e1", SessionID: self.ID, Text: "first stash"},
					{ID: "o1", SessionID: "someone-else", Text: "not this board"},
				}
			},
			want: "e1", caption: "first stash",
		},
		{
			name: "the board emptied under it", row: 4,
			board: func(relay.Session) relay.PasteboardMsg { return relay.PasteboardMsg{} },
		},
	}
	keys := map[string]tea.KeyPressMsg{
		"x":     {Code: 'x', Text: "x"},
		"enter": {Code: tea.KeyEnter},
		"J":     {Code: 'J', Text: "J"},
		"K":     {Code: 'K', Text: "K"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, self := pasteModel(t, 60, 30)
			if c.board != nil {
				m = feed(t, m, c.board(self))
			}
			m.pb.row = c.row
			src := m.src.(*fakeSource)

			out := m.Render()
			assertFrame(t, out, 60, 30)
			assertPaletteOnly(t, out)
			if c.want != "" && !strings.Contains(ansi.Strip(out), "▸"+c.caption) {
				t.Errorf("the highlighted row is not %q\n%s", c.caption, ansi.Strip(out))
			}

			md, _, _ := m.onPbKey(keys["x"])
			armed := md.(Model)
			switch {
			case c.want == "" && armed.hasArm:
				t.Errorf("x armed something on an empty board")
			case c.want != "" && !armed.isArmed("x", c.want):
				t.Errorf("x did not arm %s (armed on %q)", c.want, armed.armed.Target)
			}

			for _, name := range []string{"enter", "J", "K"} {
				before := len(src.posts)
				_, cmd, handled := m.onPbKey(keys[name])
				if !handled {
					t.Errorf("%s is not handled in PASTE", name)
				}
				if c.want == "" {
					if cmd != nil {
						t.Errorf("%s wrote on an empty board", name)
					}
					continue
				}
				if cmd == nil {
					t.Errorf("%s did nothing with the cursor past the board", name)
					continue
				}
				cmd()
				if len(src.posts) != before+1 || src.bodies[before]["id"] != c.want {
					t.Errorf("%s posted %v %v, want id %s", name, src.posts[before:], src.bodies[before:], c.want)
				}
			}
		})
	}
}
