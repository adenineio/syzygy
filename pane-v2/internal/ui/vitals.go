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

// dimIf greys a style out when the data behind it is stale -- the last known
// state is still information, so it stays on screen in grey.
func dimIf(st lipgloss.Style, stale bool) lipgloss.Style {
	if stale {
		return theme.SDim
	}
	return st
}

type statCol struct {
	label string
	value string
	style lipgloss.Style
}

// statGrid lays label and value rows out over n columns.
func statGrid(w int, cols []statCol) []string {
	if len(cols) == 0 || w <= 0 {
		return nil
	}
	widths := make([]int, len(cols))
	base := w / len(cols)
	for i := range widths {
		widths[i] = base
	}
	widths[len(widths)-1] += w - base*len(cols)

	head := NewRow(w)
	vals := NewRow(w)
	for i, c := range cols {
		cw := widths[i]
		cell := NewRow(cw)
		cell.Add(theme.STick, theme.GTick)
		cell.Add(theme.SLabel, fmtx.TruncRight(c.label, cw-1))
		head.Add(theme.SBg, "")
		head.b.WriteString(cell.String())
		head.used += cw

		vcell := NewRow(cw)
		vcell.Add(theme.SBg, " ")
		vcell.Add(c.style, fmtx.TruncRight(c.value, cw-1))
		vals.b.WriteString(vcell.String())
		vals.used += cw
	}
	return []string{head.String(), vals.String()}
}

// pairRow renders two label+value pairs side by side, which is how the stats
// read at 30 columns without losing their labels.
func pairRow(w int, a, b statCol) string {
	r := NewRow(w)
	half := w / 2
	left := NewRow(half)
	left.Add(theme.STick, theme.GTick)
	left.Add(theme.SLabel, a.label+" ")
	left.Add(a.style, fmtx.TruncRight(a.value, left.Rest()))
	r.b.WriteString(left.String())
	r.used += half
	right := NewRow(w - half)
	right.Add(theme.STick, theme.GTick)
	right.Add(theme.SLabel, b.label+" ")
	right.Add(b.style, fmtx.TruncRight(b.value, right.Rest()))
	r.b.WriteString(right.String())
	r.used += w - half
	return r.String()
}

// viewVitals is mode 1: read-only and glanceable at every breakpoint. budget
// is how many rows the body may draw; the spinner block takes whatever is left
// over after the panels above it, and nothing when that is too little.
func (m Model) viewVitals(f Frame, s relay.Session, stale bool, budget int) []string {
	w := f.W
	var rows []string

	frac := s.CtxFrac()
	ctxCol := theme.CtxColor(frac)
	if stale {
		ctxCol = theme.Grey
	}

	// ---- CONTEXT ---------------------------------------------------------
	ctxLabel := "CONTEXT"
	if f.BP == BPS {
		ctxLabel = "CTX"
	}
	ctxRight := fmt.Sprintf("%s / %s  %s",
		fmtx.Compact(s.Stats.Ctx), fmtx.Compact(s.Stats.CtxLimit), fmtx.Pct(frac))
	if f.BP == BPS {
		ctxRight = fmt.Sprintf("%s/%s  %s",
			fmtx.Compact(s.Stats.Ctx), fmtx.Compact(s.Stats.CtxLimit), fmtx.Pct(frac))
	}
	rows = append(rows, Head(w, ctxLabel, ctxRight, theme.On(ctxCol)))
	if stale {
		rows = append(rows, NewRow(w).Fill(theme.SDim, theme.GBarEmpty, w).String())
	} else {
		rows = append(rows, Bar(w, frac))
	}

	// ---- the stats grid --------------------------------------------------
	guardStyle := dimIf(theme.SValue, stale)
	if s.Stats.Guardrails > 0 {
		guardStyle = dimIf(theme.SWarn, stale)
	}
	errStyle := dimIf(theme.SValue, stale)
	if s.Stats.Errors > 0 {
		errStyle = dimIf(theme.SErr, stale)
	}
	diffL := fmt.Sprintf("+%d / −%d", s.Stats.Diff.Added, s.Stats.Diff.Removed)
	diffS := fmt.Sprintf("+%d/−%d", s.Stats.Diff.Added, s.Stats.Diff.Removed)

	spend := statCol{"SPEND", fmtx.Money(s.Stats.Spend), dimIf(theme.SValue, stale)}
	tools := statCol{"TOOLS", fmt.Sprint(s.Stats.Tools), dimIf(theme.SValue, stale)}
	guard := statCol{"GUARD", fmt.Sprint(s.Stats.Guardrails), guardStyle}
	errs := statCol{"ERRORS", fmt.Sprint(s.Stats.Errors), errStyle}
	uptime := statCol{"UP", fmtx.AgoFine(m.now.Sub(s.StartedAt.Time())), dimIf(theme.SValue, stale)}

	switch f.BP {
	case BPL:
		rows = append(rows, statGrid(w, []statCol{
			spend, tools, guard, errs, {"DIFF", diffL, dimIf(theme.SValue, stale)},
		})...)
	case BPM:
		errs.label = "ERR"
		rows = append(rows, statGrid(w, []statCol{
			spend, tools, guard, errs, {"DIFF", diffS, dimIf(theme.SValue, stale)},
		})...)
	default: // BPS: two columns of label+value pairs over three rows
		errs.label = "ERR"
		rows = append(rows,
			pairRow(w, spend, tools),
			pairRow(w, guard, errs),
			pairRow(w, statCol{"DIFF", diffS, dimIf(theme.SValue, stale)}, uptime),
		)
	}

	// ---- model / branch / uptime ----------------------------------------
	branch := "—"
	if s.Branch != nil && *s.Branch != "" {
		branch = theme.GBranch + " " + *s.Branch
	}
	switch f.BP {
	case BPL:
		r := NewRow(w)
		third := w / 3
		r.b.WriteString(kv(third, "MODEL", s.Model, stale))
		r.used += third
		r.b.WriteString(kv(third, "BRANCH", branch, stale))
		r.used += third
		r.b.WriteString(kv(w-2*third, "UPTIME", fmtx.AgoFine(m.now.Sub(s.StartedAt.Time())), stale))
		r.used += w - 2*third
		rows = append(rows, r.String())
	case BPM:
		r := NewRow(w)
		half := w / 2
		r.b.WriteString(kv(half, "MODEL", s.Model, stale))
		r.used += half
		r.b.WriteString(kv(w-half, "BRANCH", branch, stale))
		r.used += w - half
		rows = append(rows, r.String())
	default:
		r := NewRow(w)
		r.Add(theme.STick, theme.GTick)
		r.Add(dimIf(theme.SBody, stale), fmtx.TruncRight(s.Model+" · "+branch, r.Rest()))
		rows = append(rows, r.String())
	}

	// ---- STATUS ----------------------------------------------------------
	if f.StatusLines > 0 {
		word := "idle"
		wordStyle := dimIf(theme.SLabel, stale)
		if s.Working && !stale {
			word = "working " + m.spin.View()
			wordStyle = theme.SWarn
		}
		rows = append(rows, Head(w, "STATUS", word, wordStyle))
		for _, line := range fmtx.Wrap(s.Status, w-1, f.StatusLines) {
			r := NewRow(w)
			r.Add(theme.SBg, " ")
			r.Add(dimIf(theme.SBody, stale), line)
			rows = append(rows, r.String())
		}
	}

	// ---- TOK/TURN --------------------------------------------------------
	if f.Spark {
		last := int64(0)
		vals := make([]int64, 0, len(s.Series))
		for _, p := range s.Series {
			vals = append(vals, p.Tokens)
		}
		if len(vals) > 0 {
			last = vals[len(vals)-1]
		}
		right := fmtx.Compact(last)
		if f.BP >= BPM {
			right += " last"
		}
		rows = append(rows, Head(w, "TOK/TURN", right, dimIf(theme.SValue, stale)))
		r := NewRow(w)
		r.Add(theme.SBg, " ")
		if stale {
			r.Fill(theme.SDim, theme.GRule, r.Rest())
		} else {
			r.b.WriteString(Spark(r.Rest(), vals))
			r.used = w
		}
		rows = append(rows, r.String())
	}

	// ---- AGENTS ----------------------------------------------------------
	if f.FoldAgents {
		if len(s.Agents) > 0 {
			r := NewRow(w)
			r.Add(theme.SAgent, " "+theme.GAgent+" ")
			r.Add(dimIf(theme.SBody, stale), fmt.Sprintf("%d agent(s) running", len(s.Agents)))
			rows = append(rows, r.String())
		}
	} else if f.AgentRows > 0 {
		rows = append(rows, Head(w, fmt.Sprintf("AGENTS %d", len(s.Agents)), "", theme.SLabel))
		shown := minInt(len(s.Agents), f.AgentRows)
		for i := 0; i < shown; i++ {
			rows = append(rows, agentRow(w, f.BP, s.Agents[i], stale))
		}
		if extra := len(s.Agents) - shown; extra > 0 {
			r := NewRow(w)
			r.Add(theme.SDim, fmt.Sprintf(" +%d more", extra))
			rows = append(rows, r.String())
		}
	}

	// ---- INBOX -----------------------------------------------------------
	n := 0
	for _, q := range m.questions {
		if q.SessionID == s.ID && q.Answer == nil {
			n++
		}
	}
	for _, a := range m.approvals {
		if a.SessionID == s.ID && a.Verdict == nil {
			n++
		}
	}
	right := ""
	if n == 0 && f.BP >= BPM {
		right = "nothing waiting"
	}
	rows = append(rows, Head(w, fmt.Sprintf("INBOX %d", n), right, theme.SDim))
	for i := 0; i < n && i < 2; i++ {
		// The inbox is rendered read-only in this pass; answering lives in
		// CONSOLE, which is not built yet.
		for _, q := range m.questions {
			if q.SessionID != s.ID || q.Answer != nil {
				continue
			}
			// ask_human polls for 60s (ASK_TIMEOUT_MS) and then
			// gives up, but the relay keeps the question forever. Past 60s the
			// row dims and says so, because answering it will not reach anyone.
			age := m.now.Sub(q.T.Time())
			stale60 := age > 60*time.Second
			body := theme.SBody
			if stale60 {
				body = theme.SDim
			}
			r := NewRow(w)
			r.Add(theme.SAgent, " "+theme.GFlag+" ")
			r.Add(theme.SDim, fmtx.Ago(age)+" ")
			suffix := ""
			if stale60 && f.BP >= BPM {
				suffix = " · agent moved on"
			}
			r.Add(body, fmtx.TruncRight(q.Question, maxInt(0, r.Rest()-fmtx.W(suffix))))
			if suffix != "" {
				r.Add(theme.SDim, suffix)
			}
			rows = append(rows, r.String())
			break
		}
		break
	}

	rows = append(rows, m.viewSpinner(f, s, budget-len(rows))...)
	return rows
}

// viewSpinner draws the pane's own spinner into whatever rows VITALS has left.
// Below 4 rows or 20 columns it draws nothing and VITALS renders exactly as it
// did before, which is the whole of its claim on the layout.
func (m Model) viewSpinner(f Frame, s relay.Session, budget int) []string {
	if budget < 4 || f.W < 20 || len(spinners) == 0 {
		return nil
	}
	def := spinners[m.spinPick%len(spinners)]

	// The picker caption takes a row of its own, and only when there is one
	// to spare over the four the drawing needs. A spinner that lost a row to
	// a label it did not have room for would be the wrong trade: the drawing
	// is the point and the label only says how to change it.
	draw := budget
	if budget >= 5 {
		draw--
	}
	c := newCanvas(f.W, draw)
	def.Draw(c, m.spinStateOf(s, f.W, draw))
	rows := c.rows()
	if draw < budget {
		rows = append(rows, spinPickRow(f, def))
	}
	return rows
}

// spinPickRow names the spinner on screen and the key that cycles it. At the
// narrow breakpoint only the name survives, which is what the rest of the pane
// does with a label and its detail.
func spinPickRow(f Frame, def spinnerDef) string {
	label := def.Name
	if f.BP > BPS {
		label += " · s"
	}
	r := NewRow(f.W)
	r.Add(theme.SBg, " ")
	r.Add(theme.SDim, fmtx.TruncRight(label, r.Rest()))
	return r.String()
}

func kv(w int, label, value string, stale bool) string {
	r := NewRow(w)
	r.Add(theme.STick, theme.GTick)
	r.Add(theme.SLabel, label+" ")
	r.Add(dimIf(theme.SBody, stale), fmtx.TruncRight(value, r.Rest()))
	return r.String()
}

func agentRow(w int, bp BP, a relay.Agent, stale bool) string {
	r := NewRow(w)
	r.Add(theme.SBg, " ")
	r.Add(dimIf(theme.SAgent, stale), theme.GAgent+" ")
	status := a.Status
	typ := ""
	if bp == BPL {
		typ = fmtx.TruncRight(a.Type, 10)
	}
	rightW := fmtx.W(status) + 2
	if typ != "" {
		rightW += fmtx.W(typ) + 2
	}
	descW := r.Rest() - rightW
	if descW < 4 {
		descW = r.Rest()
		typ, status = "", ""
	}
	r.Add(dimIf(theme.SBody, stale), fmtx.TruncRight(a.Description, descW))
	if typ != "" {
		r.Add(theme.SBg, strings.Repeat(" ", 2))
		r.Add(theme.SDim, typ)
	}
	if status != "" {
		st := theme.SDim
		if status == "running" && !stale {
			st = theme.On(theme.Green)
		}
		r.Right(st, status)
	}
	return r.String()
}
