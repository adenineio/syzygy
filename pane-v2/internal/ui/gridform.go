package ui

import (
	"fmt"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// gridForm is the notes form: one input row per pending connection, one of
// them focused. It replaces the body while open and owns every key.
type gridForm struct {
	Open bool
	Row  int // index into pending
	in   textinput.Model
}

// newGridInput is the editor. The virtual cursor is off, which puts the
// cursor mode at hide, so Focus returns no blink command and an idle pane
// does not repaint; the real cursor is never placed on the view either --
// inputRow draws the cursor cell itself.
func newGridInput() textinput.Model {
	ti := textinput.New()
	ti.Prompt = ""
	ti.CharLimit = 500
	ti.SetVirtualCursor(false)
	return ti
}

// openGridForm opens the form on the first pending row.
func (m Model) openGridForm() (tea.Model, tea.Cmd) {
	if len(m.pending) == 0 {
		return m, nil
	}
	m.gridForm = gridForm{Open: true, in: newGridInput()}
	m.gridFormGo(0)
	return m, m.gridForm.in.Focus()
}

// gridFormStore writes the input's value into the focused row's note. The
// slice is copied, never mutated in place, so an older model copy is intact.
func (m *Model) gridFormStore() {
	if m.gridForm.Row < 0 || m.gridForm.Row >= len(m.pending) {
		return
	}
	p := append([]gridConn(nil), m.pending...)
	p[m.gridForm.Row].Note = m.gridForm.in.Value()
	m.pending = p
}

// gridFormGo moves the focus to a row and loads its note.
func (m *Model) gridFormGo(row int) {
	if len(m.pending) == 0 {
		return
	}
	m.gridForm.Row = clampInt(row, 0, len(m.pending)-1)
	m.gridForm.in.SetValue(m.pending[m.gridForm.Row].Note)
	m.gridForm.in.CursorEnd()
}

// gridFormFill copies the focused row's text into every note that is still
// empty. It is the one-to-many case: type the briefing once, spread it, then
// tweak the rows that want their own wording. A row that already has a note is
// left alone -- this fills the blanks, it does not apply to all -- and the
// focused row is stored first, so what spreads is the text on screen and not
// the value the input held when the row was last left.
func (m *Model) gridFormFill() {
	m.gridFormStore()
	if m.gridForm.Row < 0 || m.gridForm.Row >= len(m.pending) {
		return
	}
	note := m.pending[m.gridForm.Row].Note
	if note == "" {
		return
	}
	p := append([]gridConn(nil), m.pending...)
	for i := range p {
		if p[i].Note == "" {
			p[i].Note = note
		}
	}
	m.pending = p
}

// onGridFormKey is the first thing onKey consults while the form is open:
// enter stores and advances (or sends from the last row), tab and shift+tab
// move, alt+enter fills the empty notes, esc closes and keeps pending, and
// everything else types.
func (m Model) onGridFormKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	k := m.keys.Form
	switch {
	case key.Matches(msg, k.Next):
		m.gridFormStore()
		if m.gridForm.Row >= len(m.pending)-1 {
			conns := m.pending
			m.pending = nil
			m.gridForm = gridForm{}
			return m, m.gridSendCmd(conns)
		}
		m.gridFormGo(m.gridForm.Row + 1)
		return m, nil
	case key.Matches(msg, k.Tab):
		m.gridFormStore()
		m.gridFormGo(m.gridForm.Row + 1)
		return m, nil
	case key.Matches(msg, k.Prev):
		m.gridFormStore()
		m.gridFormGo(m.gridForm.Row - 1)
		return m, nil
	case key.Matches(msg, k.Fill):
		m.gridFormFill()
		return m, nil
	case key.Matches(msg, k.Close):
		m.gridFormStore()
		m.gridForm = gridForm{}
		return m, nil
	}
	var cmd tea.Cmd
	m.gridForm.in, cmd = m.gridForm.in.Update(msg)
	return m, cmd
}

// viewGridForm replaces the body: the NOTES head, a name row and an input
// row per connection, and what a brief is.
func (m Model) viewGridForm(f Frame) []string {
	n := len(m.pending)
	right := "enter next · esc"
	if m.gridForm.Row >= n-1 {
		right = fmt.Sprintf("enter send %d · esc", n)
	}
	rows := []string{Head(f.W, fmt.Sprintf("NOTES %d", n), right, theme.SDim)}
	for i, p := range m.pending {
		r := NewRow(f.W)
		r.Add(theme.SDim, fmt.Sprintf(" %d ", i+1))
		r.Add(theme.SLink, fmtx.TruncRight(m.sessionName(p.From), maxInt(3, (r.Rest()-3)/2)))
		r.Add(theme.SDim, " "+theme.GArrow+" ")
		r.Add(theme.SLink, fmtx.TruncRight(m.sessionName(p.To), r.Rest()))
		rows = append(rows, r.String())
		focused := i == m.gridForm.Row
		value, pos := p.Note, len([]rune(p.Note))
		if focused {
			value, pos = m.gridForm.in.Value(), m.gridForm.in.Position()
		}
		rows = append(rows, inputRow(f.W, " > ", value, pos, focused, "no note · enter skips"))
	}
	rows = append(rows, Blank(f.W))
	rows = append(rows, para(f.W, "each target receives the sender's status and your note as one SendMessage", 2, theme.SDim)...)
	return rows
}

// gridFormHelp is the last row while the form is open. The hints are listed
// in the order they earn their columns, and the row takes as many as fit: at
// 41, the user's pane, that is enter, the fill chord and esc; at 30 it is the
// first two; shift+tab, the one key a tab user already guesses, is the first
// to go and comes back at 58.
func (m Model) gridFormHelp(f Frame) string {
	first := "enter next"
	if m.gridForm.Row >= len(m.pending)-1 {
		first = fmt.Sprintf("enter send %d", len(m.pending))
	}
	text := fitJoin(f.W, first, "alt+enter fill", "esc close", "shift+tab back")
	return NewRow(f.W).Add(theme.SLabel, fmtx.TruncRight(text, f.W)).String()
}

// fitJoin joins the parts with " · " while they still fit in w and drops the
// rest. The first part is always kept; the caller truncates it if even that
// overruns.
func fitJoin(w int, parts ...string) string {
	if len(parts) == 0 {
		return ""
	}
	out, used := parts[0], fmtx.W(parts[0])
	for _, p := range parts[1:] {
		pw := fmtx.W(p)
		if used+3+pw > w {
			break
		}
		out, used = out+" · "+p, used+3+pw
	}
	return out
}
