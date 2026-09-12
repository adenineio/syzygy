package ui

import (
	"fmt"
	"strings"
	"time"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/hotkeys"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// hkArmed is how long an x press stays armed. It is a 3 s armed
// window, and the two-press confirm stands in for the armed strip until that
// strip ships: clearing a slot is destructive enough that a single blind
// keystroke must not do it, and the confirmation stays KEYBOARD-ONLY -- see
// mouse.go's note about why a destructive confirmation is never a hit region.
const hkArmed = 3 * time.Second

// hkField indexes the editor's three inputs.
type hkField int

const (
	hkTitle hkField = iota
	hkShort
	hkPrompt
	hkFields
)

// hkEditor is the three-field form over one slot. It replaces the list while
// open and owns the keyboard, the way gridForm does.
//
// The prompt is a single-line textinput rather than a textarea, deliberately:
// inputRow is the pane's own text renderer, and it exists because
// textinput.View() emits ANSI-256 defaults the palette test rejects. A
// textarea would need the same treatment written again for a wrapped, scrolled
// field, and a prompt is one paragraph typed once -- inputRow already windows
// a long value around the cursor, so a 900-character prompt edits fine, it
// just shows one line of itself at a time.
type hkEditor struct {
	Open  bool
	Slot  string
	Field hkField
	in    [hkFields]textinput.Model
}

// hkState is HOTKEYS' own state. The two files are kept as parsed, so the
// list can say which of them named a slot; the merged view is recomputed per
// frame from them, never cached, so it cannot disagree with what was loaded.
type hkState struct {
	scope  hotkeys.Scope
	row    int
	editor hkEditor

	loaded bool
	files  hotkeys.Loaded

	// armed is the x confirm: which slot it is over and when it was pressed.
	armed   bool
	armedAt time.Time
	armedOn string

	// err is the last load or save failure, shown on the last row. A parse
	// failure lands here and no save is attempted.
	err string
}

// hkLoadedMsg carries a pass over both config files back to the UI goroutine.
type hkLoadedMsg hotkeys.Loaded

// hkSavedMsg carries a save's outcome back.
type hkSavedMsg struct {
	Scope hotkeys.Scope
	Slot  string
	Err   error
}

// hkLoadCmd reads both files off the UI goroutine: it runs git and touches
// the disk.
//
// The cwd is the FOCUSED session's, with the pane's own as the fallback. The
// pane is launched beside a Claude and inherits its directory at that moment
// (syzygy-pane.sh splits with -c "$PWD"), which is what makes the fallback right
// before the relay is up; but BOARD can point the pane at a session in another
// worktree, and once it has, the project override that matters is the one
// belonging to the session on screen.
func (m Model) hkLoadCmd() tea.Cmd {
	cwd := m.cfg.Cwd
	if s, ok := m.focusedOrLast(); ok && s.Cwd != "" {
		cwd = s.Cwd
	}
	return func() tea.Msg { return hkLoadedMsg(hotkeys.Load(cwd)) }
}

// HotkeysNow reads both config files synchronously and wraps the pass as the
// message Update expects. It exists for --snapshot, which renders exactly one
// frame and never runs a command, so without it the snapshot of this mode is
// forever "reading the config…". Same shape, and same reason, as IdentResult.
func HotkeysNow(cwd string) tea.Msg { return hkLoadedMsg(hotkeys.Load(cwd)) }

// hkSaveCmd writes one slot into the scope's file.
func (m Model) hkSaveCmd(scope hotkeys.Scope, e hotkeys.Entry) tea.Cmd {
	path := m.hkPath(scope)
	return func() tea.Msg {
		return hkSavedMsg{Scope: scope, Slot: e.Key, Err: hotkeys.SaveSlot(path, e)}
	}
}

func (m Model) hkPath(scope hotkeys.Scope) string {
	if scope == hotkeys.Project {
		return m.hk.files.ProjectPath
	}
	return m.hk.files.GlobalPath
}

// hkSlots is the merged view: what the band would see, in its display order.
func (m Model) hkSlots() []hotkeys.Slot {
	return hotkeys.Merge(m.hk.files.Global, m.hk.files.Project)
}

// hkEntry is the value the editor starts from for a row in a scope: what that
// scope's own file says, falling back to the merged value so editing a
// PROJECT override starts from what is actually in force rather than blank.
func (m Model) hkEntry(scope hotkeys.Scope, key string) hotkeys.Entry {
	var f *hotkeys.File
	if scope == hotkeys.Project {
		f = m.hk.files.Project
	} else {
		f = m.hk.files.Global
	}
	if e, ok := f.Entry(key); ok {
		return e
	}
	// Nothing of its own: start from what is in force, so opening a PROJECT
	// override begins at the inherited text rather than at a blank field.
	for _, s := range m.hkSlots() {
		if s.Key == key {
			e := s.Live()
			e.Key = key
			return e
		}
	}
	return hotkeys.Entry{Key: key}
}

// hkScopeReady reports whether the current scope has a file to write. PROJECT
// has none when git could not name a worktree root; the mode says so rather
// than inventing a path.
func (m Model) hkScopeReady() bool { return m.hkPath(m.hk.scope) != "" }

// ------------------------------------------------------------------- keys

// newHkInput is one editor field. Same settings as the notes form's: no
// virtual cursor, so an idle pane does not repaint and inputRow draws the
// cursor cell itself.
func newHkInput(limit int) textinput.Model {
	ti := textinput.New()
	ti.Prompt = ""
	ti.CharLimit = limit
	ti.SetVirtualCursor(false)
	return ti
}

// openHkEditor loads the row's values into the three fields.
func (m Model) openHkEditor() (tea.Model, tea.Cmd) {
	if !m.hk.loaded || !m.hkScopeReady() {
		return m, nil
	}
	slots := m.hkSlots()
	if m.hk.row < 0 || m.hk.row >= len(slots) {
		return m, nil
	}
	slot := slots[m.hk.row].Key
	e := m.hkEntry(m.hk.scope, slot)
	ed := hkEditor{Open: true, Slot: slot}
	ed.in[hkTitle] = newHkInput(60)
	ed.in[hkShort] = newHkInput(24)
	ed.in[hkPrompt] = newHkInput(4000)
	ed.in[hkTitle].SetValue(e.Title)
	ed.in[hkShort].SetValue(e.Short)
	ed.in[hkPrompt].SetValue(e.Prompt)
	for i := range ed.in {
		ed.in[i].CursorEnd()
	}
	m.hk.editor = ed
	m.hk.armed = false
	return m, m.hk.editor.in[hkTitle].Focus()
}

// hkFocus moves the editor's focus, wrapping.
func (m *Model) hkFocus(f hkField) tea.Cmd {
	n := hkField(hkFields)
	f = (f%n + n) % n
	m.hk.editor.in[m.hk.editor.Field].Blur()
	m.hk.editor.Field = f
	return m.hk.editor.in[f].Focus()
}

// onHkEditorKey owns every key while the editor is open. It returns for all
// of them, with no fall-through: q, the mode digits and ? are characters in a
// text field, and a fall-through to the global bindings would quit the pane
// on the q of "quality".
func (m Model) onHkEditorKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	k := m.keys.Form
	switch {
	case key.Matches(msg, k.Close):
		m.hk.editor = hkEditor{}
		return m, nil
	case key.Matches(msg, k.Tab):
		return m, m.hkFocus(m.hk.editor.Field + 1)
	case key.Matches(msg, k.Prev):
		return m, m.hkFocus(m.hk.editor.Field - 1)
	case key.Matches(msg, k.Next):
		return m.hkSave()
	}
	var cmd tea.Cmd
	f := m.hk.editor.Field
	m.hk.editor.in[f], cmd = m.hk.editor.in[f].Update(msg)
	return m, cmd
}

// hkSave commits the editor. The write itself happens off the UI goroutine;
// what lands here is the outcome, as a toast and a reload.
func (m Model) hkSave() (tea.Model, tea.Cmd) {
	e := hotkeys.Entry{
		Key:    m.hk.editor.Slot,
		Title:  strings.TrimSpace(m.hk.editor.in[hkTitle].Value()),
		Short:  strings.TrimSpace(m.hk.editor.in[hkShort].Value()),
		Prompt: strings.TrimSpace(m.hk.editor.in[hkPrompt].Value()),
	}
	scope := m.hk.scope
	m.hk.editor = hkEditor{}
	m.hk.err = ""
	return m, m.hkSaveCmd(scope, e)
}

// hkClear is the x key's second press: it writes an EMPTY PROMPT rather than
// deleting the entry. That is the format's own way of saying "not here" -- in
// a file where absence means "inherit", an empty prompt is the only way a
// project can turn a global slot off -- and it keeps the labels, so turning
// the slot back on is a matter of typing a prompt again.
func (m Model) hkClear(slot string) (tea.Model, tea.Cmd) {
	e := m.hkEntry(m.hk.scope, slot)
	e.Key, e.Prompt = slot, ""
	scope := m.hk.scope
	m.hk.armed = false
	m.hk.err = ""
	return m, m.hkSaveCmd(scope, e)
}

// onHkKey is the list's keyboard.
func (m Model) onHkKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd, bool) {
	k := m.keys.Hotkeys
	n := len(hotkeys.SlotKeys)
	switch {
	case key.Matches(msg, k.Down):
		m.hk.row, m.hk.armed = clampInt(m.hk.row+1, 0, n-1), false
		return m, nil, true
	case key.Matches(msg, k.Up):
		m.hk.row, m.hk.armed = clampInt(m.hk.row-1, 0, n-1), false
		return m, nil, true
	case key.Matches(msg, k.Edit):
		md, cmd := m.openHkEditor()
		return md, cmd, true
	case key.Matches(msg, k.Scope):
		m.hk.scope, m.hk.armed = m.hk.scope.Other(), false
		m.hk.err = ""
		return m, nil, true
	case key.Matches(msg, k.Clear):
		slots := m.hkSlots()
		if !m.hk.loaded || !m.hkScopeReady() || m.hk.row < 0 || m.hk.row >= len(slots) {
			return m, nil, true
		}
		slot := slots[m.hk.row].Key
		if m.hkIsArmed(slot) {
			md, cmd := m.hkClear(slot)
			return md, cmd, true
		}
		m.hk.armed, m.hk.armedAt, m.hk.armedOn = true, m.now, slot
		return m, nil, true
	case key.Matches(msg, k.Reload):
		m.hk.err = ""
		return m, m.hkLoadCmd(), true
	}
	return m, nil, false
}

// hkIsArmed reports whether an x press on this slot is still live.
func (m Model) hkIsArmed(slot string) bool {
	return m.hk.armed && m.hk.armedOn == slot && m.now.Sub(m.hk.armedAt) < hkArmed
}

// ------------------------------------------------------------------- view

// hkBadgeShort is the badge at 30 columns, where the words do not fit.
func hkBadgeShort(b string) string {
	switch b {
	case "inherited":
		return "inh"
	case "set here":
		return "here"
	case "hidden":
		return "off"
	case "unset":
		return "—"
	}
	return ""
}

// hkRow renders one slot: the digit, its labels, its prompt, and the badge
// saying where the value came from.
func (m Model) hkRow(f Frame, s hotkeys.Slot, selected bool) string {
	r := NewRow(f.W)
	body, badgeStyle := theme.SBody, theme.SDim
	if selected {
		r.Ground(theme.SCursor)
		body, badgeStyle = theme.SCursor, theme.SCursor
	}
	mark := " "
	if selected {
		mark = theme.GHere
	}
	r.Add(body, mark)
	keyStyle := theme.SWarn
	if selected {
		keyStyle = theme.SCursor
	}
	r.Add(keyStyle, s.Key)
	r.Add(body, " ")

	badge := hotkeys.Badge(s, m.hk.scope)
	if f.BP <= BPS {
		badge = hkBadgeShort(badge)
	}
	reserve := 0
	if badge != "" {
		reserve = fmtx.W(badge) + 1
	}

	// The row shows the entry THIS SCOPE owns, not the merged one: it is what
	// enter opens and what x clears, and a row that showed a project override
	// while GLOBAL was selected would be describing a different file from the
	// one the next keystroke writes.
	e := s.In(m.hk.scope)
	label := e.Title
	if e.Short != "" && e.Short != e.Title {
		label += " · " + e.Short
	}
	text := label
	switch {
	case label == "" && e.Prompt == "":
		text = "empty"
	case label == "":
		text = e.Prompt
	case e.Prompt != "":
		text += " · " + e.Prompt
	}
	st := body
	if s.HiddenIn(m.hk.scope) && !selected {
		st = theme.SDim
	}
	r.Add(st, fmtx.TruncRight(text, maxInt(0, r.Rest()-reserve)))
	if badge != "" {
		r.Right(badgeStyle, badge)
	}
	return r.String()
}

// viewHotkeys is the mode's body: the eight slots, the scope, one line of the
// file's own readme, and the path being edited.
func (m Model) viewHotkeys(f Frame) []string {
	if m.hk.editor.Open {
		return m.viewHkEditor(f)
	}
	w := f.W
	rows := []string{Head(w, "HOTKEYS", m.hk.scope.String(), theme.SValue)}
	if !m.hk.loaded {
		rows = append(rows, para(w, "reading the config…", 1, theme.SDim)...)
		return rows
	}
	slots := m.hkSlots()
	for i, s := range slots {
		rows = append(rows, m.hkRow(f, s, i == m.hk.row))
	}

	rows = append(rows, Blank(w))
	if m.hk.scope == hotkeys.Project && !m.hkScopeReady() {
		rows = append(rows, para(w,
			"no worktree here — git could not name a root for this session, so there is no project file to write",
			3, theme.SWarn)...)
	} else {
		rows = append(rows, Head(w, "FILE", "", theme.SLabel))
		rows = append(rows, para(w, hkShortPath(m.hkPath(m.hk.scope)), 2, theme.SDim)...)
	}
	if help := hotkeys.ReadmeHelp(m.hk.files.Global.Readme()); help != "" && f.HL >= HLShort {
		rows = append(rows, para(w, help, 3, theme.SDim)...)
	}
	return rows
}

// viewHkEditor replaces the body while a slot is open.
func (m Model) viewHkEditor(f Frame) []string {
	w := f.W
	ed := m.hk.editor
	rows := []string{Head(w, "SLOT "+ed.Slot, m.hk.scope.String(), theme.SValue)}
	names := [hkFields]string{"title", "short", "prompt"}
	holds := [hkFields]string{"the wide label", "the narrow label", "empty · this slot is hidden"}
	for i := hkField(0); i < hkFields; i++ {
		lab := NewRow(w)
		lab.Add(theme.SLabel, " "+names[i])
		rows = append(rows, lab.String())
		focused := i == ed.Field
		rows = append(rows, inputRow(w, " > ", ed.in[i].Value(), ed.in[i].Position(), focused, holds[i]))
	}
	rows = append(rows, Blank(w))
	rows = append(rows, para(w,
		"enter saves to "+m.hk.scope.String()+" · an empty prompt hides the slot", 3, theme.SDim)...)
	return rows
}

// hkShortPath is the path the mode says it is editing, or the reason there is
// none. It is shown in full (para wraps it over two rows) rather than elided:
// this is the one row that tells the user which of two identically-named
// files their next keystroke writes, so the part that differs must be visible.
func hkShortPath(p string) string {
	if p == "" {
		return "no file for this scope"
	}
	return p
}

// hkLastRow is HOTKEYS' claim on the last row: the armed confirmation, then a
// load or save failure, then the mode's own legend.
func (m Model) hkLastRow(f Frame) string {
	if m.hk.editor.Open {
		text := fitJoin(f.W, "enter save", "tab field", "esc cancel")
		return NewRow(f.W).Add(theme.SLabel, fmtx.TruncRight(text, f.W)).String()
	}
	if m.hk.armed && m.hkIsArmed(m.hk.armedOn) {
		text := fmt.Sprintf("CLEAR %s in %s ? · x again · esc", m.hk.armedOn, m.hk.scope)
		if f.BP == BPS {
			text = "CLEAR " + m.hk.armedOn + " ? · x · esc"
		}
		r := NewRow(f.W)
		r.Add(theme.STick, theme.GTick)
		r.Add(theme.SArmed, fmtx.TruncRight(text, r.Rest()))
		return r.String()
	}
	if m.hk.err != "" {
		r := NewRow(f.W)
		r.Add(theme.SErr, fmtx.TruncRight(m.hk.err, r.Rest()))
		return r.String()
	}
	return ""
}
