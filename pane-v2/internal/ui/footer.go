package ui

import (
	"fmt"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// footer is the compact list of every other live session, one row each, capped
// by the height ladder. It is scoped to modes 1-3: the modes that
// list every session there is -- BOARD and GRID -- would only repeat the body
// under it, so they spend the rows on the body instead.
func (m Model) footer(f Frame) []string {
	if !f.ShowFooter || f.OtherRows <= 0 || m.mode.ListsAll() {
		return nil
	}
	others := m.others()
	rows := []string{Head(f.W, fmt.Sprintf("OTHERS %d", len(others)), "", theme.SLabel)}
	shown := minInt(len(others), f.OtherRows)
	for i := 0; i < shown; i++ {
		rows = append(rows, m.otherRow(f, others[i]))
	}
	if extra := len(others) - shown; extra > 0 {
		rows = append(rows, NewRow(f.W).Add(theme.SDim, fmt.Sprintf(" +%d more", extra)).String())
	}
	return rows
}

// otherRow: state glyph, name, model (M/L), ctx %, spend (L), age.
func (m Model) otherRow(f Frame, s relay.Session) string {
	r := NewRow(f.W)
	glyph, gs := theme.GOff, theme.SDim
	if s.Working {
		glyph, gs = theme.GOn, theme.SWarn
	}
	r.Add(theme.SBg, " ")
	r.Add(gs, glyph+" ")

	frac := s.CtxFrac()
	pct := fmtx.Pct(frac)
	age := fmtx.Ago(m.now.Sub(s.SeenAt.Time()))
	if !s.Working && f.BP >= BPM {
		age = "idle " + age
	}

	// Reserve the right-hand columns, then give the name whatever is left.
	var reserve int
	switch f.BP {
	case BPL:
		reserve = 10 + 5 + 9 + 9 // model, pct, spend, age
	case BPM:
		reserve = 10 + 5 + 8 // model, pct, age
	default:
		reserve = 5 + 4 // pct, age
	}
	nameW := r.Rest() - reserve
	if nameW < 6 {
		nameW = maxInt(3, r.Rest()/2)
	}
	r.Add(theme.SBody, padTo(fmtx.TruncRight(s.Name, nameW), nameW))

	if f.BP >= BPM {
		r.Add(theme.SDim, "  "+padTo(fmtx.TruncRight(s.Model, 8), 8))
	}
	r.Add(theme.On(theme.CtxColor(frac)), fmt.Sprintf("%5s", pct))
	if f.BP == BPL {
		r.Add(theme.SValue, fmt.Sprintf("%9s", fmtx.Money(s.Stats.Spend)))
	}
	r.Right(theme.SDim, age)
	return r.String()
}

func padTo(s string, w int) string {
	for fmtx.W(s) < w {
		s += " "
	}
	return s
}

// lastRow is the one row every transient claim competes for, and this is the
// only place the order lives. Top wins: the toast, the notes form's legend, the
// armed strip, the leader's hint, the lost relay, the mode's own hint (BOARD's and GRID's link
// hints, HOTKEYS' editor legend or refused save), the read-only notice, and
// last the short help line.
func (m Model) lastRow(f Frame) string {
	if !f.ShowLast {
		return ""
	}
	if m.toast.Active(m.now) {
		st := theme.SWarn
		switch m.toast.Tone {
		case ToneErr:
			st = theme.SErr
		case ToneGood:
			st = theme.On(theme.Green)
		}
		r := NewRow(f.W)
		r.Add(theme.STick, theme.GTick)
		r.Add(st, fmtx.TruncRight(m.toast.Text, r.Rest()))
		return r.String()
	}
	if m.gridForm.Open {
		return m.gridFormHelp(f)
	}
	// The strip outranks the lost relay: a gesture that needs the relay was
	// cancelled when it went down, so an arm still standing is one that can
	// land, and the next keypress acting on it is the thing to say.
	if s := m.armRow(f); s != "" {
		return s
	}
	if s := m.bankRow(f); s != "" {
		return s
	}
	if m.conn == relay.Down && m.everLive {
		// The connection outranks the link hint: a gesture that cannot reach
		// the relay must not be the thing standing where the reason would be.
		r := NewRow(f.W)
		r.Add(theme.SErr, fmtx.TruncRight("relay lost · retry in "+m.retryIn(), r.Rest()))
		return r.String()
	}
	switch m.mode {
	case ModeBoard:
		if hint := m.boardLinkHint(f); hint != "" {
			return hint
		}
	case ModeGrid:
		if hint := m.gridLinkHint(f); hint != "" {
			return hint
		}
	case ModeHotkeys:
		// The editor's legend and a refused save live here, ahead of the
		// short-help row that would otherwise stand where the reason belongs.
		if hint := m.hkLastRow(f); hint != "" {
			return hint
		}
	case ModeChain:
		if hint := m.chLastRow(f); hint != "" {
			return hint
		}
	}
	if m.cfg.ReadOnly && f.BP >= BPM {
		r := NewRow(f.W)
		r.Add(theme.SDim, fmtx.TruncRight("read-only · no token in ~/.claude/syzygy-relay.json", r.Rest()))
		return r.String()
	}
	short := m.help.ShortHelpView(m.keys.ShortHelp(m.mode))
	r := NewRow(f.W)
	r.Add(theme.SBg, "")
	// help already measures itself against the width set on the model.
	if fmtx.W(short) > f.W {
		short = fmtx.TruncRight(short, f.W)
	}
	r.b.WriteString(short)
	r.used += fmtx.W(short)
	return r.String()
}

func (m Model) retryIn() string {
	if m.connRetryAt.IsZero() {
		return "…"
	}
	d := m.connRetryAt.Sub(m.now)
	if d < 0 {
		d = 0
	}
	return fmtx.Ago(d)
}
