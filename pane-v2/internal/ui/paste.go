package ui

import (
	"fmt"
	"strings"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// pbScope is which board PASTE is looking at.
type pbScope int

const (
	// pbSession is the focused session's own board.
	pbSession pbScope = iota
	// pbGlobal is the board no session owns.
	pbGlobal
)

func (s pbScope) String() string {
	if s == pbGlobal {
		return "GLOBAL"
	}
	return "SESSION"
}

// Other is the scope the toggle key switches to.
func (s pbScope) Other() pbScope {
	if s == pbGlobal {
		return pbSession
	}
	return pbGlobal
}

// pbState is PASTE's own state. The rows are recomputed per frame from the
// relay mirror, never cached, so they cannot disagree with what arrived.
type pbState struct {
	scope pbScope
	row   int
}

// pbRows is the board PASTE is showing, in the relay's order.
func (m Model) pbRows() []relay.Paste {
	var want string
	if m.pb.scope == pbSession {
		s, ok := m.focusedOrLast()
		if !ok {
			return nil
		}
		want = s.ID
	}
	out := make([]relay.Paste, 0, len(m.pasteboard))
	for _, p := range m.pasteboard {
		if p.SessionID == want {
			out = append(out, p)
		}
	}
	return out
}

// pbCaption is what a row shows. An entry stores a title only when `,,@name `
// gave one; everything else derives its caption here, so a better derivation
// later improves every old entry.
func pbCaption(p relay.Paste) string {
	if p.Title != "" {
		return p.Title
	}
	for _, line := range strings.Split(p.Text, "\n") {
		if s := strings.TrimSpace(line); s != "" {
			return s
		}
	}
	return "empty"
}

// pbCursor is the cursor clamped to a board of n rows. The board changes under
// the cursor -- a delete, a smaller broadcast, a refocus onto another
// session's board -- so the row is corrected where it is used rather than in
// every message that can shrink the board.
func (m Model) pbCursor(n int) int { return clampInt(m.pb.row, 0, maxInt(0, n-1)) }

// onPbKey is PASTE's keyboard. The bool says "handled", so anything this
// returns false for falls through to the global bindings.
func (m Model) onPbKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd, bool) {
	k := m.keys.Paste
	rows := m.pbRows()
	n := len(rows)
	// Every branch below sees a row inside the board, so enter, x, J and K act
	// on the row that is drawn highlighted.
	m.pb.row = m.pbCursor(n)
	switch {
	case key.Matches(msg, k.Down):
		m.pb.row = clampInt(m.pb.row+1, 0, maxInt(0, n-1))
		return m, nil, true
	case key.Matches(msg, k.Up):
		m.pb.row = clampInt(m.pb.row-1, 0, maxInt(0, n-1))
		return m, nil, true
	case key.Matches(msg, k.Scope):
		m.pb.scope, m.pb.row = m.pb.scope.Other(), 0
		return m, nil, true
	case key.Matches(msg, k.MoveDown):
		if n == 0 || m.pb.row >= n {
			return m, nil, true
		}
		id := rows[m.pb.row].ID
		m.pb.row = clampInt(m.pb.row+1, 0, n-1)
		return m, m.postCmd("/api/pasteboard/reorder",
			map[string]any{"id": id, "dir": "down"}, "moved"), true
	case key.Matches(msg, k.MoveUp):
		if n == 0 || m.pb.row >= n {
			return m, nil, true
		}
		id := rows[m.pb.row].ID
		m.pb.row = clampInt(m.pb.row-1, 0, n-1)
		return m, m.postCmd("/api/pasteboard/reorder",
			map[string]any{"id": id, "dir": "up"}, "moved"), true
	case key.Matches(msg, k.Fill):
		if n == 0 || m.pb.row >= n {
			return m, nil, true
		}
		s, ok := m.focusedOrLast()
		if !ok {
			return m, m.setToast("no session focused", ToneErr), true
		}
		// The relay reads the text out of its own store, so this sends an id.
		return m, m.postCmd("/api/pasteboard/fill",
			map[string]any{"id": rows[m.pb.row].ID, "targetId": s.ID},
			"filled "+s.Name+" · its composer was replaced"), true
	case key.Matches(msg, k.Delete):
		if n == 0 || m.pb.row >= n {
			return m, nil, true
		}
		id := rows[m.pb.row].ID
		if m.isArmed("x", id) {
			m.disarm()
			return m, m.postCmd("/api/pasteboard/delete", map[string]any{"id": id}, "deleted"), true
		}
		return m, m.arm(Arm{
			Mode: ModePaste, Key: "x", Target: id, NeedsRelay: true,
			Label: "DELETE this stash", Short: "DELETE ?",
		}), true
	}
	return m, nil, false
}

// viewPaste draws the board.
func (m Model) viewPaste(f Frame) []string {
	w := f.W
	rows := []string{Head(w, "PASTE", m.pb.scope.String(), theme.SValue)}
	if m.pb.scope == pbSession {
		if _, ok := m.focusedOrLast(); !ok {
			rows = append(rows, para(w, "no session focused — press t for the global board", 2, theme.SDim)...)
			return rows
		}
	}
	items := m.pbRows()
	if len(items) == 0 {
		rows = append(rows, para(w,
			"nothing stashed — type the band's marker (,, by default) in front of a prompt and press enter",
			3, theme.SDim)...)
		return rows
	}
	cur := m.pbCursor(len(items))
	for i, p := range items {
		rows = append(rows, m.pbRow(f, p, i == cur))
	}
	rows = append(rows, Blank(w))
	rows = append(rows, para(w, "enter fills the focused session and REPLACES its composer", 2, theme.SDim)...)
	return rows
}

func (m Model) pbRow(f Frame, p relay.Paste, selected bool) string {
	r := NewRow(f.W)
	body := theme.SBody
	if selected {
		r.Ground(theme.SCursor)
		body = theme.SCursor
	}
	mark := " "
	if selected {
		mark = theme.GHere
	}
	r.Add(body, mark)
	badge := fmt.Sprintf("%dc", len(p.Text))
	if p.SessionName != "" && m.pb.scope == pbGlobal {
		badge = p.SessionName + " · " + badge
	}
	reserve := fmtx.W(badge) + 1
	r.Add(body, fmtx.TruncRight(pbCaption(p), maxInt(0, r.Rest()-reserve)))
	st := theme.SDim
	if selected {
		st = theme.SCursor
	}
	r.Right(st, badge)
	return r.String()
}
