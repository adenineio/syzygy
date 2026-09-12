package ui

import (
	"fmt"
	"strings"
	"time"

	"charm.land/lipgloss/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// para renders an indented wrapped paragraph in a panel body.
func para(w int, text string, max int, st lipgloss.Style) []string {
	var out []string
	for _, line := range fmtx.Wrap(text, w-1, max) {
		r := NewRow(w)
		r.Add(theme.SBg, " ")
		r.Add(st, line)
		out = append(out, r.String())
	}
	return out
}

// viewWaiting: the relay is not up. The pane never exits
// because the relay is absent -- it paints this and retries with backoff.
func (m Model) viewWaiting(f Frame) []string {
	w := f.W
	host := strings.TrimPrefix(m.cfg.RelayURL, "http://")
	host = strings.TrimPrefix(host, "https://")

	rows := []string{Head(w, "RELAY", "", theme.SLabel)}
	rows = append(rows, para(w, "waiting for the relay at", 1, theme.SDim)...)
	rows = append(rows, para(w, host, 1, theme.SDim)...)
	rows = append(rows, para(w,
		fmt.Sprintf("retry in %s · attempt %d", m.retryIn(), m.connAttempt+1), 1, theme.SDim)...)
	if f.HL >= HLMed {
		rows = append(rows, Head(w, "WHY", "", theme.SLabel))
		rows = append(rows, para(w,
			"the syzygy plugin starts it on session.start; open Claude in the pane beside this one",
			5, theme.SDim)...)
	}
	return rows
}

// viewNoSessions: the relay is fine, the session is what is
// missing. The pill stays LIVE.
func (m Model) viewNoSessions(f Frame) []string {
	w := f.W
	rows := []string{Head(w, "SESSIONS 0", "", theme.SLabel)}
	if m.expected != "" {
		name := m.expectedName
		if name == "" {
			name = "a session"
		}
		rows = append(rows, para(w,
			fmt.Sprintf("waiting for %s (%s) to join", name, shortID(m.expected)), 3, theme.SDim)...)
		if !m.liveSince.IsZero() && m.now.Sub(m.liveSince) > 30*time.Second {
			rows = append(rows, para(w, "is the syzygy plugin loaded there?", 3, theme.SWarn)...)
		}
		return rows
	}
	rows = append(rows, para(w, "nothing has joined the board", 2, theme.SDim)...)
	rows = append(rows, para(w,
		"start Claude with the plugin loaded in the pane beside this one", 4, theme.SDim)...)
	return rows
}

// viewUnpinned: sessions exist but none of them is provably
// this window's. The pane never guesses.
func (m Model) viewUnpinned(f Frame) []string {
	w := f.W
	rows := []string{
		NewRow(w).
			Add(theme.STick, theme.GTick).
			Add(theme.SWarn, fmtx.TruncRight("WHICH SESSION IS YOURS?", w-1)).
			String(),
	}
	rows = append(rows, para(w,
		"the pane could not prove which session is this window's, and will not guess", 3, theme.SDim)...)
	rows = append(rows, Head(w, fmt.Sprintf("SESSIONS %d", len(m.sessions)), "", theme.SLabel))
	for i, s := range m.sessions {
		if i >= 6 {
			break
		}
		r := NewRow(w)
		glyph, gs := theme.GOff, theme.SDim
		if s.Working {
			glyph, gs = theme.GOn, theme.SWarn
		}
		r.Add(theme.SBg, " ")
		r.Add(gs, glyph+" ")
		r.Add(theme.SDim, shortID(s.ID)+" ")
		r.Add(theme.SBody, fmtx.TruncRight(s.Name, r.Rest()))
		rows = append(rows, r.String())
	}
	rows = append(rows, Head(w, "PIN IT", "", theme.SLabel))
	rows = append(rows, para(w,
		"re-run with --session <id>; picking from the board lands with BOARD", 3, theme.SDim)...)
	if m.identNote != "" && f.BP >= BPM {
		rows = append(rows, para(w, "why: "+m.identNote, 2, theme.SDim)...)
	}
	return rows
}

// viewPlaceholder is what an unbuilt mode renders. The mode key works so the
// pane's shape is honest about what exists.
func (m Model) viewPlaceholder(f Frame) []string {
	w := f.W
	rows := []string{Head(w, m.mode.Label(), "", theme.SLabel)}
	rows = append(rows, para(w, "not built yet", 1, theme.SWarn)...)
	rows = append(rows, para(w, "this pass ships VITALS only; press 1", 3, theme.SDim)...)
	return rows
}

// viewStrip: under 30 columns the pane becomes a vertical strip
// that still says the few things worth a glance. The launcher never creates
// this, but a user can drag the divider.
func (m Model) viewStrip(f Frame) string {
	w := f.W
	var rows []string
	pillText, pillStyle := m.pill()

	r := NewRow(w)
	r.Add(theme.SBrand, " MC ")
	r.Add(theme.SBg, " ")
	r.Right(pillStyle, fmtx.TruncRight(pillText, r.Rest()))
	rows = append(rows, r.String())

	s, ok := m.focusedOrLast()
	if !ok {
		rows = append(rows, para(w, "no session", 2, theme.SDim)...)
		return Clamp(rows, w, f.H)
	}
	stale := m.gone() || (m.conn == relay.Down && m.everLive)
	frac := s.CtxFrac()
	rows = append(rows, Bar(w, frac))
	rows = append(rows, NewRow(w).
		Add(theme.On(theme.CtxColor(frac)), fmtx.Pct(frac)+" ").
		Add(dimIf(theme.SValue, stale), fmtx.Compact(s.Stats.Ctx)).String())
	rows = append(rows, NewRow(w).Add(dimIf(theme.SValue, stale), fmtx.Money(s.Stats.Spend)).String())
	rows = append(rows, NewRow(w).
		Add(dimIf(theme.SValue, stale), fmt.Sprintf("T%d ", s.Stats.Tools)).
		Add(dimIf(theme.SWarn, stale), fmt.Sprintf("G%d", s.Stats.Guardrails)).String())
	word := "idle"
	ws := theme.SDim
	if s.Working && !stale {
		word, ws = "working "+m.spin.View(), theme.SWarn
	}
	rows = append(rows, NewRow(w).Add(ws, word).String())

	if others := m.others(); len(others) > 0 {
		rows = append(rows, NewRow(w).Fill(theme.SRule, theme.GRule, w).String())
		working := 0
		for _, o := range others {
			if o.Working {
				working++
			}
		}
		glyph, gs := theme.GOff, theme.SDim
		if working > 0 {
			glyph, gs = theme.GOn, theme.SWarn
		}
		rows = append(rows, NewRow(w).
			Add(gs, glyph+" ").
			Add(theme.SDim, fmt.Sprintf("+%d", len(others))).String())
	}
	if !m.mode.DrawsAtXS() {
		rows = append(rows, para(w, fmt.Sprintf("too narrow for mode %d", int(m.mode)+1), 2, theme.SDim)...)
	}
	return Clamp(rows, w, f.H)
}

// viewTiny is 6..11 columns: the brand and the percentage, nothing else.
func (m Model) viewTiny(f Frame) string {
	rows := []string{NewRow(f.W).Add(theme.SBrand, "MC").String()}
	if s, ok := m.focusedOrLast(); ok {
		frac := s.CtxFrac()
		rows = append(rows, NewRow(f.W).Add(theme.On(theme.CtxColor(frac)), fmtx.Pct(frac)).String())
	}
	return Clamp(rows, f.W, f.H)
}
