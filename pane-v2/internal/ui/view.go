package ui

import (
	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// View renders the whole pane.
//
// Model.View returns a tea.View struct rather than a string, and the alternate
// screen, mouse mode and terminal background are fields on it rather than
// program options.
//
// BackgroundColor is deliberately left unset. Setting it paints the alt screen
// with a colour of our own, which is precisely what stops the pane inheriting
// the terminal's scheme; the pane is meant to sit in the window, not on top of
// it. Do not add it back.
func (m Model) View() tea.View {
	v := tea.NewView(m.Render())
	v.AltScreen = true
	// Cell motion, not all motion: it delivers clicks, releases, the wheel and
	// the motion frames of a drag -- everything the pane's gestures are made
	// of -- and stops there. All-motion would add a message for every cell the
	// pointer crosses with no button down, and since the pane draws no hover
	// feedback each of those would be a message it can only discard. Cell
	// motion is also the better-supported of the two.
	v.MouseMode = tea.MouseModeCellMotion
	return v
}

// focusedOrLast returns the session to draw: the live one, else the last known
// copy so a vanished session still shows its final state in grey.
func (m Model) focusedOrLast() (relay.Session, bool) {
	if s, ok := m.focused(); ok {
		return s, true
	}
	if m.hadFocus {
		return m.lastFocused, true
	}
	return relay.Session{}, false
}

// Render is the pure string form of the view, which is what the frame-invariant
// tests and --snapshot use.
func (m Model) Render() string {
	f := m.frame
	if f.W <= 0 || f.H <= 0 {
		return ""
	}
	switch f.BP {
	case BPBlank:
		// Background only. Never a panic at width 0..5.
		return Clamp(nil, f.W, f.H)
	case BPTiny:
		return m.viewTiny(f)
	case BPXS:
		return m.viewStrip(f)
	}

	header := m.header(f)
	last := ""
	if f.ShowLast {
		last = m.lastRow(f)
	}
	footer := m.footer(f)
	budget := m.bodyBudget(f)

	body := m.body(f, budget)
	switch {
	case m.gridForm.Open:
		body = m.viewGridForm(f)
	case m.showHelp:
		body = m.helpBody(f)
	}
	body = m.scrollBody(body, budget)

	rows := make([]string, 0, f.H)
	rows = append(rows, header...)
	rows = append(rows, body...)
	for len(rows) < f.H-len(footer)-boolInt(last != "") {
		rows = append(rows, Blank(f.W))
	}
	rows = append(rows, footer...)
	if last != "" {
		rows = append(rows, last)
	}
	return Clamp(rows, f.W, f.H)
}

// bodyBudget is how many rows the body may draw: the frame less the header,
// the OTHERS footer and the last row. It is one definition rather than two so
// a key handler can ask exactly the question the renderer answers -- a mode
// that scrolls a list of its own has to move by what is actually on screen.
func (m Model) bodyBudget(f Frame) int {
	b := f.H - f.HeaderRows - len(m.footer(f))
	if f.ShowLast {
		b--
	}
	return maxInt(0, b)
}

// scrollBody applies the j/k offset and trims to the budget.
func (m Model) scrollBody(body []string, budget int) []string {
	if len(body) <= budget {
		return body
	}
	return body[clampInt(m.scroll, 0, len(body)-budget):][:budget]
}

// maxScroll is the largest body offset that moves anything: how far the body
// overruns the budget it is drawn into. It is the same question scrollBody
// asks, put to the same rows, so that the wheel cannot bank offset the render
// will never use and then charge the reader that many notches to get back.
func (m Model) maxScroll(f Frame) int {
	budget := m.bodyBudget(f)
	body := m.body(f, budget)
	if m.showHelp {
		body = m.helpBody(f)
	}
	return maxInt(0, len(body)-budget)
}

// bodyKind is which branch body draws. It is asked rather than re-derived
// wherever something outside the renderer has to know whether what is on
// screen is the mode's own body -- the hit regions, chiefly, since a click
// must never resolve against a body the pane is not drawing.
type bodyKind int

const (
	// bodyWaiting is 7.1: the relay has never been up.
	bodyWaiting bodyKind = iota
	// bodyNoSessions is 7.3: the relay is fine, nothing has joined.
	bodyNoSessions
	// bodyUnpinned is 7.4: sessions exist, none of them is provably ours.
	bodyUnpinned
	// bodyMode is the mode's own renderer.
	bodyMode
)

func (m Model) bodyKind() bodyKind {
	switch {
	case !m.everLive:
		return bodyWaiting
	case len(m.sessions) == 0 && !m.hadFocus:
		return bodyNoSessions
	case m.self == "" && m.focus == "":
		return bodyUnpinned
	}
	if _, ok := m.focusedOrLast(); !ok {
		return bodyNoSessions
	}
	return bodyMode
}

// body dispatches to the mode renderer, or to whichever degraded state applies.
// The degraded states take precedence: they are what is true.
//
// budget is how many rows the body may draw. A mode that scrolls a list of its
// own -- FEED and BOARD -- fills the budget itself and leaves scrollBody
// nothing to do; the others return their natural height and let scrollBody
// window it.
func (m Model) body(f Frame, budget int) []string {
	if m.mode == ModeHotkeys {
		// The one mode that is not a view of the relay. It edits two local
		// files, so it works with the relay down, with no session registered
		// and with nothing focused -- and it must, because a pane whose relay
		// has not come up yet is exactly when someone reaches for the config.
		return m.viewHotkeys(f)
	}
	switch m.bodyKind() {
	case bodyWaiting:
		return m.viewWaiting(f)
	case bodyNoSessions:
		return m.viewNoSessions(f)
	case bodyUnpinned:
		return m.viewUnpinned(f)
	}
	s, _ := m.focusedOrLast()
	// 7.5 / 7.6 -- stale: the session vanished, or the relay dropped.
	stale := m.gone() || (m.conn == relay.Down && m.everLive)
	switch m.mode {
	case ModeVitals:
		return m.viewVitals(f, s, stale, budget)
	case ModeFeed:
		return m.viewFeed(f, s, stale, budget)
	case ModeBoard:
		return m.viewBoard(f, stale, budget)
	case ModeGrid:
		return m.viewGrid(f, stale, budget)
	case ModeMine:
		return m.viewMine(f)
	case ModeHotkeys:
		return m.viewHotkeys(f)
	default:
		return m.viewPlaceholder(f)
	}
}

// helpBody is the ? overlay. The rows are built with the Row builder rather
// than help.FullHelpView so the frame invariant holds at every width.
func (m Model) helpBody(f Frame) []string {
	rows := []string{Head(f.W, "HELP", "", theme.SLabel)}
	titles := []string{"MODE", "NAVIGATE", "PANE"}
	for i, group := range m.keys.FullHelp(m.mode) {
		if len(group) == 0 {
			continue
		}
		if i < len(titles) {
			rows = append(rows, NewRow(f.W).Add(theme.SLabel, " "+titles[i]).String())
		}
		for _, b := range group {
			if !b.Enabled() {
				continue
			}
			h := b.Help()
			r := NewRow(f.W)
			r.Add(theme.SBg, "  ")
			r.Add(theme.SWarn, padTo(h.Key, 10))
			r.Add(theme.SBody, h.Desc)
			rows = append(rows, r.String())
		}
	}
	rows = append(rows, para(f.W, "esc or ? closes this", 1, theme.SDim)...)
	return rows
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
