package ui

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// seg is one styled run of a row whose total width has to be measured before
// the first cell is drawn.
type seg struct {
	st lipgloss.Style
	s  string
}

// feedLabelPad is the width the label column is padded to: 7 at L, 6 at M, 5
// at S. A longer label overflows it rather than truncating, because the label
// is the one field of a feed row that is always worth reading in full.
func feedLabelPad(bp BP) int {
	switch bp {
	case BPL:
		return 7
	case BPM:
		return 6
	default:
		return 5
	}
}

// filterFeed is what a user-facing feed may show: one session's events, with
// the plugin's own bookkeeping left out. The order is the relay's, oldest
// first; reversing for display is the widget's job.
func filterFeed(events []relay.Event, sessionID string) []relay.Event {
	if sessionID == "" {
		return nil
	}
	out := make([]relay.Event, 0, len(events))
	for _, e := range events {
		if e.Internal || e.SessionID != sessionID {
			continue
		}
		out = append(out, e)
	}
	return out
}

// feedEvents is the focused session's feed, oldest first.
func (m Model) feedEvents() []relay.Event {
	s, ok := m.focusedOrLast()
	if !ok {
		return nil
	}
	return filterFeed(m.events, s.ID)
}

// feedRows renders at most budget rows from events, newest at the top.
//
// events must be oldest first, and its last element is the row drawn at the
// top: scrolling is expressed by handing the widget a shorter slice rather
// than by an offset it would have to interpret. The budget is a parameter
// rather than FEED's body height so a caller that wants a shorter feed passes
// its own.
func feedRows(f Frame, events []relay.Event, budget int) []string {
	if budget <= 0 || f.W <= 0 {
		return nil
	}
	out := make([]string, 0, budget)
	for i := len(events) - 1; i >= 0 && len(out) < budget; i-- {
		out = append(out, feedRow(f, events[i]))
	}
	if len(out) == 0 {
		out = append(out, NewRow(f.W).Add(theme.SBg, " ").Add(theme.SDim, "no activity yet").String())
	}
	return out
}

// feedRow is one event: timestamp, glyph, label, detail, chip, duration.
func feedRow(f Frame, e relay.Event) string {
	r := NewRow(f.W)

	switch f.BP {
	case BPL:
		r.Add(theme.SDim, fmtx.Clock(e.T.Time())+" ")
	case BPM:
		r.Add(theme.SDim, fmtx.ClockShort(e.T.Time())+" ")
	}

	glyph, gs := feedGlyph(e)
	r.Add(gs, glyph+" ")

	label := feedFlat(e.Label)
	if label == "" {
		label = e.Kind
	}
	r.Add(theme.SName, padTo(label, feedLabelPad(f.BP))+" ")

	chip, chipStyle := feedChip(e)
	dur := fmtx.Ms(int64(e.Ms))
	tail := fmtx.W(chip) + fmtx.W(dur)
	if chip != "" && dur != "" {
		tail += 2
	}
	gap := 0
	if tail > 0 {
		gap = 2
	}

	// The chip and the duration are short, hard facts; the detail is the field
	// that yields when the row runs out of room.
	if detailW := r.Rest() - tail - gap; detailW >= 4 {
		r.Add(theme.SBody, feedDetail(e.Detail, detailW))
	}
	if tail > 0 {
		if pad := r.Rest() - tail; pad > 0 {
			r.Add(theme.SBg, strings.Repeat(" ", pad))
		}
		r.Add(chipStyle, chip)
		if chip != "" && dur != "" {
			r.Add(theme.SBg, "  ")
		}
		r.Add(theme.SDim, dur)
	}
	return r.String()
}

// feedGlyph is the kind glyph in the kind's colour, with error and deny
// overriding both -- what went wrong outranks what was being done.
func feedGlyph(e relay.Event) (string, lipgloss.Style) {
	switch e.Status {
	case "error":
		return theme.GError, theme.SErr
	case "deny":
		return theme.GDeny, theme.SWarn
	}
	switch e.Kind {
	case "turn":
		return theme.GTurn, theme.SValue
	case "agent":
		return theme.GAgent, theme.SAgent
	case "note":
		return theme.GNote, theme.SDim
	default:
		return theme.GTool, theme.SDim
	}
}

// feedChip is the inverted ERR/DENY badge, empty for an ordinary event.
func feedChip(e relay.Event) (string, lipgloss.Style) {
	switch e.Status {
	case "error":
		return "ERR", theme.SChipErr
	case "deny":
		return "DENY", theme.SChipDny
	}
	return "", theme.SBg
}

// feedDetail truncates by shape: a path loses its head so the
// filename survives, a sentence loses its tail.
func feedDetail(s string, w int) string {
	s = feedFlat(s)
	if feedIsPath(s) {
		return fmtx.TruncLeft(s, w)
	}
	return fmtx.TruncRight(s, w)
}

// feedIsPath recognises the one detail shape worth shortening from the left:
// a lone absolute or relative path, as a Read or a Write reports it.
func feedIsPath(s string) bool {
	if !strings.Contains(s, "/") || strings.ContainsAny(s, " \t") {
		return false
	}
	return strings.HasPrefix(s, "/") || strings.HasPrefix(s, "~/") || strings.HasPrefix(s, "./")
}

// feedFlat collapses an event's text to a single line. Details carry whatever
// the tool was given -- a heredoc in a Bash command arrives with newlines and
// tabs in it -- and either would shear the frame.
func feedFlat(s string) string {
	if !strings.ContainsAny(s, " \t\n\v\f\r") {
		return s
	}
	return strings.Join(strings.Fields(s), " ")
}

// feedTopIndex is the index, in the oldest-first slice, of the event drawn at
// the top of the viewport. Following always means the newest; otherwise the
// stored index is clamped so the viewport can neither run off either end nor
// leave blank rows below the oldest event.
func (m Model) feedTopIndex(n, budget int) int {
	if n <= 0 {
		return -1
	}
	if m.feedFollow {
		return n - 1
	}
	top := m.feedTop
	if budget > 0 && top < budget-1 {
		top = budget - 1
	}
	if top > n-1 {
		top = n - 1
	}
	if top < 0 {
		top = 0
	}
	return top
}

// feedScroll moves the viewport delta rows toward the older end (a negative
// delta moves back toward the newest) and un-pins follow. Landing on the newest
// event re-pins it, which is what keeps the indicator honest.
//
// It starts from the index the renderer would actually draw at this budget, not
// from the stored one, so a key press always moves what is on screen.
func (m *Model) feedScroll(n, budget, delta int) {
	top := m.feedTopIndex(n, budget)
	if top < 0 {
		return
	}
	top -= delta
	if top > n-1 {
		top = n - 1
	}
	if top < 0 {
		top = 0
	}
	m.feedTop = top
	m.feedFollow = top >= n-1
}

// feedBudget is how many rows the feed widget gets in FEED: the body less the
// strip and the section head.
func (m Model) feedBudget() int { return maxInt(0, m.bodyBudget(m.frame)-2) }

// feedStrip is the one row the vitals collapse to in FEED: the context bar,
// then the percentage and the spend, and the tool and guardrail counts at L.
func (m Model) feedStrip(f Frame, s relay.Session, stale bool) string {
	w := f.W
	frac := s.CtxFrac()

	pctStyle := theme.On(theme.CtxColor(frac))
	if stale {
		pctStyle = theme.SDim
	}
	right := []seg{{pctStyle, fmtx.Pct(frac)}}
	if f.BP >= BPM {
		right = append(right,
			seg{theme.SBg, "  "},
			seg{dimIf(theme.SValue, stale), fmtx.Money(s.Stats.Spend)})
	}
	if f.BP == BPL {
		guardStyle := dimIf(theme.SValue, stale)
		if s.Stats.Guardrails > 0 {
			guardStyle = dimIf(theme.SWarn, stale)
		}
		right = append(right,
			seg{theme.SBg, "  "},
			seg{dimIf(theme.SValue, stale), fmt.Sprintf("T%d", s.Stats.Tools)},
			seg{theme.SBg, "  "},
			seg{guardStyle, fmt.Sprintf("G%d", s.Stats.Guardrails)})
	}

	rightW := 0
	for _, c := range right {
		rightW += fmtx.W(c.s)
	}

	r := NewRow(w)
	if barW := w - rightW - 2; barW >= 1 {
		if stale {
			r.Fill(theme.SDim, theme.GBarEmpty, barW)
		} else {
			r.b.WriteString(Bar(barW, frac))
			r.used += barW
		}
		r.Add(theme.SBg, "  ")
	}
	for _, c := range right {
		r.Add(c.st, c.s)
	}
	return r.String()
}

// viewFeed is mode 2. The vitals collapse to one strip so the feed gets the
// height, and the section head carries the follow indicator.
func (m Model) viewFeed(f Frame, s relay.Session, stale bool, budget int) []string {
	evs := filterFeed(m.events, s.ID)
	rows := []string{m.feedStrip(f, s, stale)}

	follow, fs := "follow "+theme.GOff, theme.SDim
	if m.feedFollow {
		follow, fs = "follow "+theme.GOn, theme.SValue
	}
	rows = append(rows, Head(f.W, fmt.Sprintf("FEED %d", len(evs)), follow, fs))

	body := budget - len(rows)
	top := m.feedTopIndex(len(evs), body)
	if top < 0 {
		return append(rows, feedRows(f, nil, body)...)
	}
	return append(rows, feedRows(f, evs[:top+1], body)...)
}
