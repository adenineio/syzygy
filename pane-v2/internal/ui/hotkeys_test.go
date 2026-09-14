package ui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"

	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/hotkeys"
	"github.com/adenineio/syzygy/pane-v2/internal/ident"
)

// hkGlobal is the shipped global file, trimmed: two live slots and a stub.
const hkGlobal = `{
  "_readme": [
    "Syzygy HUD config. Pressing a hotkey submits its prompt into the session.",
    "An entry with an empty prompt is hidden, so the stubs below are templates."
  ],
  "settings": {"spinnerPicker": false, "pieStyle": "moon"},
  "hotkeys": [
    {"key": "2", "title": "my next steps", "short": "next", "prompt": "what are my next steps"},
    {"key": "3", "title": "step back", "short": "back", "prompt": "step back for a moment"},
    {"key": "5", "title": "", "short": "", "prompt": ""}
  ]
}`

// hkProject claims one slot and turns another off, which is the whole shape
// the merge exists to express.
const hkProject = `{"hotkeys":[
  {"key": "7", "title": "run verify", "short": "verify", "prompt": "run just verify"},
  {"key": "2", "title": "my next steps", "short": "next", "prompt": ""}
]}`

// hkModel builds a model parked in HOTKEYS with both files already loaded.
// Nothing here touches the real ~/.claude: the load message is handed in.
func hkModel(t *testing.T, w, h int, global, project string) Model {
	t.Helper()
	g, err := hotkeys.Parse([]byte(global))
	if err != nil {
		t.Fatalf("global fixture: %v", err)
	}
	p, err := hotkeys.Parse([]byte(project))
	if err != nil {
		t.Fatalf("project fixture: %v", err)
	}
	src := newFakeSource()
	m := New(src, ident.Static{}, Config{
		RelayURL: "http://127.0.0.1:4317", Now: func() time.Time { return frozen },
	})
	m.now = frozen
	tm, _ := m.Update(tea.WindowSizeMsg{Width: w, Height: h})
	m = tm.(Model)
	tm, _ = m.setMode(ModeHotkeys)
	m = tm.(Model)
	return feed(t, m, hkLoadedMsg(hotkeys.Loaded{
		GlobalPath:  "/home/u/.claude/" + hotkeys.FileName,
		ProjectPath: "/repo/.claude/" + hotkeys.FileName,
		Root:        "/repo",
		Global:      g,
		Project:     p,
	}))
}

// TestHotkeysFrameInvariantAtEveryWidth is the pane's one non-negotiable
// rule, applied to every state this mode can be in: the list, the editor, the
// armed confirm and a refused save all measure exactly the frame.
//
// 41 is in the list because it is the user's own pane width -- a quarter of a
// 165-column window -- and it is the width where the tab strip drops to its
// single-letter tier now that HOTKEYS is the seventh tab.
func TestHotkeysFrameInvariantAtEveryWidth(t *testing.T) {
	for _, w := range []int{30, 41, 60, 120} {
		for _, h := range []int{20, 49} {
			m := hkModel(t, w, h, hkGlobal, hkProject)

			for _, scope := range []hotkeys.Scope{hotkeys.Global, hotkeys.Project} {
				m.hk.scope = scope
				out := m.Render()
				assertFrame(t, out, w, h)
				assertPaletteOnly(t, out)
			}

			// Armed: the last row is the confirm.
			m.arm(Arm{Mode: ModeHotkeys, Key: "x", Target: "3", Label: "CLEAR 3"})
			assertFrame(t, m.Render(), w, h)
			assertPaletteOnly(t, m.Render())
			m.disarm()

			// Refused: the last row is the reason.
			m.hk.err = "not saved: `hotkeys` is not an array of objects"
			assertFrame(t, m.Render(), w, h)
			m.hk.err = ""

			// The editor, on a slot with a long prompt.
			tm, _ := m.openHkEditor()
			em := tm.(Model)
			if !em.hk.editor.Open {
				t.Fatalf("%dx%d: the editor did not open", w, h)
			}
			out := em.Render()
			assertFrame(t, out, w, h)
			assertPaletteOnly(t, out)

			// Not yet loaded: the mode is entered before the files arrive.
			blank := hkModel(t, w, h, hkGlobal, hkProject)
			blank.hk.loaded = false
			assertFrame(t, blank.Render(), w, h)
		}
	}
}

// TestHotkeysListsWhatTheBandWouldSee: the rows are the eight slots, in the
// band's own display order (0 last, not first), each showing the entry the
// SELECTED SCOPE owns -- with the badge that says where it came from.
func TestHotkeysListsWhatTheBandWouldSee(t *testing.T) {
	m := hkModel(t, 60, 30, hkGlobal, hkProject)
	out := ansi.Strip(m.Render())

	if !contains(out, "my next steps") || !contains(out, "step back") {
		t.Fatalf("GLOBAL should list the global file's own slots:\n%s", out)
	}
	if contains(out, "run verify") {
		t.Fatalf("GLOBAL is showing a PROJECT-only slot:\n%s", out)
	}
	// Display order: 2 3 5 6 7 8 9 0, so the 0 row is the last of the eight.
	rows := strings.Split(out, "\n")
	var digits []string
	for _, r := range rows {
		f := strings.Fields(r)
		if len(f) == 0 {
			continue
		}
		// The cursor mark sits directly against the digit -- it costs no
		// column of its own -- so it comes off before the digit is read.
		if d := strings.TrimPrefix(f[0], "\u25b8"); hotkeys.IsSlot(d) {
			digits = append(digits, d)
		}
	}
	if strings.Join(digits, "") != strings.Join(hotkeys.SlotKeys, "") {
		t.Fatalf("rows are in %v, want the band's order %v:\n%s", digits, hotkeys.SlotKeys, out)
	}

	m.hk.scope = hotkeys.Project
	out = ansi.Strip(m.Render())
	if !contains(out, "run verify") {
		t.Fatalf("PROJECT should show the slot this worktree claimed:\n%s", out)
	}
	if !contains(out, "inherited") || !contains(out, "set here") || !contains(out, "hidden") {
		t.Fatalf("PROJECT rows should carry inherited/set here/hidden badges:\n%s", out)
	}
	// Slot 2 is hidden HERE (the project emptied its prompt), so its prompt
	// must not still be on screen as if it were in force.
	if contains(out, "what are my next steps") {
		t.Fatalf("a slot the project turned off is still showing the global prompt:\n%s", out)
	}
}

// TestHotkeysShowsOneLineOfTheReadme is the "explain the format in place"
// requirement: the file documents itself, and the one rule that is not
// visible from the list -- an empty prompt hides a slot -- is on screen.
func TestHotkeysShowsOneLineOfTheReadme(t *testing.T) {
	m := hkModel(t, 60, 30, hkGlobal, hkProject)
	out := ansi.Strip(m.Render())
	if !contains(out, "empty prompt is hidden") {
		t.Fatalf("the mode should carry one line of the file's own _readme:\n%s", out)
	}
}

// TestHotkeysSaysWhichFileItIsAbout: the two files have the same name, so the
// path is the only thing on screen that distinguishes them, and it is the one
// that says what enter will write.
func TestHotkeysNamesTheFileItWillWrite(t *testing.T) {
	m := hkModel(t, 60, 30, hkGlobal, hkProject)
	if out := ansi.Strip(m.Render()); !contains(out, "/home/u/.claude/") {
		t.Fatalf("GLOBAL should name the global path:\n%s", out)
	}
	m.hk.scope = hotkeys.Project
	if out := ansi.Strip(m.Render()); !contains(out, "/repo/.claude/") {
		t.Fatalf("PROJECT should name the worktree path:\n%s", out)
	}
	// No worktree: git named no root, so there is no project file. Saying so
	// is the whole point -- a guessed path would write the override into
	// whatever directory the pane happened to start in.
	m.hk.files.ProjectPath, m.hk.files.Root = "", ""
	out := ansi.Strip(m.Render())
	if !contains(out, "no worktree here") {
		t.Fatalf("PROJECT with no root should say so:\n%s", out)
	}
	if m.hkScopeReady() {
		t.Fatal("PROJECT with no path must not be writable")
	}
	tm, _ := m.openHkEditor()
	if tm.(Model).hk.editor.Open {
		t.Fatal("the editor opened over a scope with no file to write")
	}
}

// TestHotkeysDigitAndTabReachTheMode: 6 is the mode's digit and the strip
// carries a seventh tab.
func TestHotkeysDigitReachesTheMode(t *testing.T) {
	m := hkModel(t, 60, 30, hkGlobal, hkProject)
	m.mode = ModeVitals
	tm, _ := m.Update(tea.KeyPressMsg{Code: '6', Text: "6"})
	if got := tm.(Model).Mode(); got != ModeHotkeys {
		t.Fatalf("6 should switch to HOTKEYS, got %v", got)
	}
	if ParseMode("hotkeys") != ModeHotkeys {
		t.Fatal("--mode hotkeys should select the mode")
	}
	found := false
	for _, mode := range AllModes {
		if mode == ModeHotkeys {
			found = true
		}
	}
	if !found {
		t.Fatal("HOTKEYS is not on the tab strip, so tab and the mouse cannot reach it")
	}
}

// TestHotkeysCursorAndScopeKeys: j/k move, t toggles scope, and both cancel a
// half-armed clear -- the same rule every other armed gesture in the pane has.
func TestHotkeysCursorAndScopeKeys(t *testing.T) {
	m := hkModel(t, 60, 30, hkGlobal, hkProject)
	if m.hk.row != 0 {
		t.Fatal("the cursor should start on the first slot")
	}
	m, _ = pressKey(t, m, 'j')
	m, _ = pressKey(t, m, 'j')
	if m.hk.row != 2 {
		t.Fatalf("two j presses should be on row 2, got %d", m.hk.row)
	}
	m, _ = pressKey(t, m, 'k')
	if m.hk.row != 1 {
		t.Fatalf("k should move back up, got row %d", m.hk.row)
	}
	for i := 0; i < 20; i++ {
		m, _ = pressKey(t, m, 'j')
	}
	if m.hk.row != len(hotkeys.SlotKeys)-1 {
		t.Fatalf("j should clamp at the last slot, got %d", m.hk.row)
	}

	m, _ = pressKey(t, m, 't')
	if m.hk.scope != hotkeys.Project {
		t.Fatal("t should switch to PROJECT")
	}
	m, _ = pressKey(t, m, 't')
	if m.hk.scope != hotkeys.Global {
		t.Fatal("t should switch back to GLOBAL")
	}

	m.arm(Arm{Mode: ModeHotkeys, Key: "x", Target: "0", Label: "CLEAR 0"})
	m, _ = pressKey(t, m, 'j')
	if m.hasArm {
		t.Fatal("moving the cursor must cancel a half-armed clear")
	}
}

// TestClearingASlotTakesTwoPresses is the destructive-key rule. One x arms and
// says so on the last row; a second x inside the window writes an EMPTY
// PROMPT, which is what "hidden" means in this format -- the entry is not
// deleted, because absence means "inherit" and would bring the global slot
// straight back.
func TestClearingASlotTakesTwoPresses(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, hotkeys.FileName)
	if err := os.WriteFile(path, []byte(hkGlobal), 0o644); err != nil {
		t.Fatal(err)
	}
	m := hkModel(t, 60, 30, hkGlobal, hkProject)
	m.hk.files.GlobalPath = path

	m, cmd := pressKey(t, m, 'x')
	if msg, done := settles(t, cmd); done {
		t.Fatalf("the first x must not write anything, got %#v", msg)
	}
	if !m.isArmed("x", "2") {
		t.Fatalf("the first x should arm slot 2, got armed=%v on %q", m.hasArm, m.armed.Target)
	}
	if out := ansi.Strip(m.Render()); !contains(out, "CLEAR 2") {
		t.Fatalf("the armed row should name what a second press clears:\n%s", out)
	}

	m, cmd = pressKey(t, m, 'x')
	if cmd == nil {
		t.Fatal("the second x should write")
	}
	msg, ok := cmd().(hkSavedMsg)
	if !ok || msg.Err != nil {
		t.Fatalf("clear returned %#v", msg)
	}
	f, err := hotkeys.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	e, found := f.Entry("2")
	if !found {
		t.Fatal("the entry was deleted; an empty prompt is what hides a slot, not absence")
	}
	if e.Prompt != "" {
		t.Fatalf("slot 2's prompt is still %q", e.Prompt)
	}
	if e.Title != "my next steps" {
		t.Fatalf("clearing the prompt should keep the labels, got %q", e.Title)
	}
	if !hotkeys.Merge(f, nil)[0].Hidden() {
		t.Fatal("the cleared slot is not hidden from the band")
	}
}

// TestAnArmedClearExpires: the arm is a 3 s window, so an x pressed and
// forgotten does not lie in wait for the next one.
func TestAnArmedClearExpires(t *testing.T) {
	m := hkModel(t, 60, 30, hkGlobal, hkProject)
	m, _ = pressKey(t, m, 'x')
	if !m.isArmed("x", "2") {
		t.Fatal("setup: the first x should arm")
	}
	m.now = frozen.Add(armWindow + time.Second)
	if m.isArmed("x", "2") {
		t.Fatal("an arm must lapse rather than wait forever")
	}
	if out := ansi.Strip(m.Render()); contains(out, "CLEAR 2") {
		t.Fatalf("a lapsed arm is still on the last row:\n%s", out)
	}
	// esc disarms too, the way it cancels every other half-made gesture.
	m.now = frozen
	m = feed(t, m, tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.hasArm {
		t.Fatal("esc should cancel the arm")
	}
}

// TestTheEditorOwnsTheKeyboard is the trap every modal in this pane has to
// dodge: onKey checks the MODE bindings and then falls through to the global
// ones, so an editor that did not return for every key would quit the pane on
// the q of "quality" and change mode on a digit.
func TestTheEditorOwnsTheKeyboard(t *testing.T) {
	m := hkModel(t, 60, 30, hkGlobal, hkProject)
	tm, _ := m.openHkEditor()
	m = tm.(Model)
	m.now = frozen

	for _, s := range []string{"q", "6", "?", "x", "j", "t"} {
		tm, _ := m.Update(tea.KeyPressMsg{Code: []rune(s)[0], Text: s})
		m = tm.(Model)
		m.now = frozen
	}
	if m.quitting {
		t.Fatal("typing q into the title field quit the pane")
	}
	if m.Mode() != ModeHotkeys || m.showHelp {
		t.Fatalf("a keystroke escaped the editor: mode %v, help %v", m.Mode(), m.showHelp)
	}
	if got := m.hk.editor.in[hkTitle].Value(); !strings.HasSuffix(got, "q6?xjt") {
		t.Fatalf("the title field should have taken every character, got %q", got)
	}

	// tab walks the three fields and wraps.
	for i, want := range []hkField{hkShort, hkPrompt, hkTitle} {
		m = feed(t, m, tea.KeyPressMsg{Code: tea.KeyTab})
		if m.hk.editor.Field != want {
			t.Fatalf("tab %d left the focus on field %d, want %d", i+1, m.hk.editor.Field, want)
		}
	}
	// esc closes without writing.
	m, cmd := pressKey(t, m, tea.KeyEscape)
	if cmd != nil {
		t.Fatal("esc must not write")
	}
	if m.hk.editor.Open {
		t.Fatal("esc should close the editor")
	}
}

// TestEnterSavesTheEditedSlot is the round trip: open a row, type, enter, and
// the file on disk carries the new value with everything else untouched.
func TestEnterSavesTheEditedSlot(t *testing.T) {
	path := filepath.Join(t.TempDir(), hotkeys.FileName)
	if err := os.WriteFile(path, []byte(hkGlobal), 0o644); err != nil {
		t.Fatal(err)
	}
	m := hkModel(t, 60, 30, hkGlobal, hkProject)
	m.hk.files.GlobalPath = path
	m, _ = pressKey(t, m, 'j') // slot 3
	tm, _ := m.openHkEditor()
	m = tm.(Model)
	m.now = frozen
	if m.hk.editor.Slot != "3" {
		t.Fatalf("the editor opened on slot %q", m.hk.editor.Slot)
	}
	m.hk.editor.in[hkPrompt].SetValue("a brand new prompt")

	m, cmd := pressKey(t, m, tea.KeyEnter)
	if cmd == nil {
		t.Fatal("enter should write")
	}
	if m.hk.editor.Open {
		t.Fatal("enter should close the editor")
	}
	msg, ok := cmd().(hkSavedMsg)
	if !ok || msg.Err != nil {
		t.Fatalf("save returned %#v", msg)
	}
	f, err := hotkeys.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if e, _ := f.Entry("3"); e.Prompt != "a brand new prompt" {
		t.Fatalf("slot 3 reads %q", e.Prompt)
	}
	if e, _ := f.Entry("2"); e.Prompt != "what are my next steps" {
		t.Fatalf("editing slot 3 disturbed slot 2: %q", e.Prompt)
	}
	if len(f.Readme()) != 2 {
		t.Fatal("the save dropped the _readme")
	}
}

// TestARefusedSaveSaysSoAndChangesNothing: a file that will not parse is
// reported on the last row and left exactly as it is. The band falls back to
// its defaults over a broken file, so overwriting it here would destroy the
// only copy of whatever the user was mid-edit.
func TestARefusedSaveSaysSoAndChangesNothing(t *testing.T) {
	path := filepath.Join(t.TempDir(), hotkeys.FileName)
	broken := `{"hotkeys": [{"key": "2", "prompt": "half a fi`
	if err := os.WriteFile(path, []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	m := hkModel(t, 60, 30, hkGlobal, hkProject)
	m.hk.files.GlobalPath = path

	tm, _ := m.openHkEditor()
	m = tm.(Model)
	m.now = frozen
	m.hk.editor.in[hkPrompt].SetValue("should never land")
	m, cmd := pressKey(t, m, tea.KeyEnter)
	if cmd == nil {
		t.Fatal("enter should have attempted a save")
	}
	saved, ok := cmd().(hkSavedMsg)
	if !ok || saved.Err == nil {
		t.Fatalf("the save was not refused: %#v", saved)
	}

	m = feed(t, m, saved)
	if m.hk.err == "" {
		t.Fatal("a refused save must leave a reason on screen")
	}
	if out := ansi.Strip(m.Render()); !contains(out, "not saved") {
		t.Fatalf("the last row should say the save was refused:\n%s", out)
	}
	assertFrame(t, m.Render(), 60, 30)

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != broken {
		t.Fatalf("a refused save rewrote the file:\n%s", b)
	}
}

// TestALoadThatCannotParseIsReportedNotSwallowed: the same refusal on the way
// in. A mode that silently showed eight empty slots over an unreadable file
// would invite the user to "fix" it by typing them all in again.
func TestALoadThatCannotParseIsReported(t *testing.T) {
	m := hkModel(t, 60, 30, hkGlobal, hkProject)
	m = feed(t, m, hkLoadedMsg(hotkeys.Loaded{
		GlobalPath: "/home/u/.claude/" + hotkeys.FileName,
		Global:     &hotkeys.File{},
		Project:    &hotkeys.File{},
		GlobalErr:  os.ErrInvalid,
	}))
	if m.hk.err == "" {
		t.Fatal("a config that will not parse must be reported")
	}
	if out := ansi.Strip(m.Render()); !contains(out, "will not parse") {
		t.Fatalf("the last row should say which file is broken:\n%s", out)
	}
}

// TestClickingASlotRowSelectsAndDoubleClickEdits mirrors BOARD's gesture: the
// hit regions are built from the same layout the renderer drew, so the row a
// click lands on is the row under the pointer.
func TestClickingASlotRowSelectsAndDoubleClickEdits(t *testing.T) {
	m := hkModel(t, 60, 30, hkGlobal, hkProject)
	top := m.frame.HeaderRows + 1 // the HOTKEYS head

	tm, _ := m.Update(tea.MouseClickMsg{X: 4, Y: top + 3, Button: tea.MouseLeft})
	m = tm.(Model)
	if m.hk.row != 3 {
		t.Fatalf("a click on the fourth row selected row %d", m.hk.row)
	}
	if m.hk.editor.Open {
		t.Fatal("one click must not open the editor")
	}
	tm, _ = m.Update(tea.MouseClickMsg{X: 4, Y: top + 3, Button: tea.MouseLeft})
	m = tm.(Model)
	if !m.hk.editor.Open || m.hk.editor.Slot != hotkeys.SlotKeys[3] {
		t.Fatalf("a double-click should edit slot %q, editor=%+v", hotkeys.SlotKeys[3], m.hk.editor)
	}
	// While the editor is open the pointer is swallowed, the way it is over
	// the notes form: what is under it is not what is on screen.
	tm, _ = m.Update(tea.MouseClickMsg{X: 4, Y: top + 1, Button: tea.MouseLeft})
	if got := tm.(Model).hk.row; got != 3 {
		t.Fatalf("a click through the editor moved the cursor to %d", got)
	}
}

// TestHotkeysWorksWithTheRelayDown is the one mode that is not a view of the
// relay: it edits two local files. A pane whose relay has not come up is
// exactly when somebody reaches for the config, so the degraded panels that
// every other mode shows must not stand in front of it.
func TestHotkeysWorksWithTheRelayDown(t *testing.T) {
	m := hkModel(t, 60, 30, hkGlobal, hkProject)
	if m.bodyKind() != bodyWaiting {
		t.Fatalf("setup: with no relay the body kind should be bodyWaiting, got %v", m.bodyKind())
	}
	out := ansi.Strip(m.Render())
	if contains(out, "waiting for the relay") {
		t.Fatalf("HOTKEYS showed the relay panel instead of the slots:\n%s", out)
	}
	if !contains(out, "my next steps") {
		t.Fatalf("HOTKEYS should draw its list with the relay down:\n%s", out)
	}
	assertFrame(t, m.Render(), 60, 30)
}
