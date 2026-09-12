package ui

import (
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// pill is the connection indicator: teal LIVE, red WAIT, grey CONN, red GONE.
func (m Model) pill() (string, lipgloss.Style) {
	if m.gone() {
		return theme.GOn + " GONE " + fmtx.Ago(m.now.Sub(m.goneAt)), theme.SErr
	}
	switch m.conn {
	case relay.Live:
		return theme.GOn + " LIVE", theme.On(theme.Teal)
	case relay.Down:
		if m.everLive {
			return theme.GOn + " WAIT", theme.SErr
		}
		return theme.GOn + " WAIT", theme.SErr
	default:
		return theme.GConn + " CONN", theme.SDim
	}
}

// headerName is what row 1 says the pane is looking at.
func (m Model) headerName() string {
	if s, ok := m.focused(); ok {
		return s.Name
	}
	if m.hadFocus && m.self != "" {
		return m.lastFocused.Name
	}
	if m.expected != "" && m.expectedName != "" {
		return m.expectedName
	}
	return "—"
}

// header renders rows 1 and 2 (or just row 1 at HLTiny).
func (m Model) header(f Frame) []string {
	rows := []string{m.headerRow1(f)}
	if f.HeaderRows >= 2 {
		rows = append(rows, m.headerRow2(f))
	}
	return rows
}

// focusedElsewhere reports whether modes 1-3 are pointed at a session other
// than this window's own. With no session of our own there is no home to
// return to, so there is nothing to say.
func (m Model) focusedElsewhere() bool {
	return m.self != "" && m.focus != "" && m.focus != m.self
}

// focusTag is the cyan mark that says so, and clicking it is 0. It shrinks to
// the bare arrow below 56 columns, where the header has no room for a
// sentence.
func (m Model) focusTag(f Frame) string {
	if !m.focusedElsewhere() {
		return ""
	}
	if f.BP == BPL {
		return theme.GElse + " focused elsewhere"
	}
	return theme.GElse
}

// focusTagRegion is where that tag landed on the header's first row. The row
// is built and asked rather than measured a second time: the tag follows a
// name whose width depends on everything else on the row, and two pieces of
// arithmetic for one position is how a hitbox drifts off the thing it is over.
func (m Model) focusTagRegion(f Frame) (region, bool) {
	_, reg, ok := m.headerRow1Tagged(f)
	return reg, ok
}

func (m Model) headerRow1(f Frame) string {
	row, _, _ := m.headerRow1Tagged(f)
	return row
}

// headerRow1Tagged renders the brand, the focused session's name, the
// focused-elsewhere tag and the connection pill, and reports the tag's
// rectangle.
func (m Model) headerRow1Tagged(f Frame) (string, region, bool) {
	r := NewRow(f.W)
	brand := " " + theme.GBrand + " MC "
	if f.BP <= BPS {
		brand = " MC "
	}
	r.Add(theme.SBrand, brand)

	pillText, pillStyle := m.pill()
	right := pillText
	switch f.BP {
	case BPL:
		right = pillText + "  " + fmtx.Clock(m.now)
	case BPM:
		right = pillText + " " + fmtx.ClockShort(m.now)
	}

	// tags: how the session was identified, and read-only
	var tags []string
	if t := m.selfHow.Tag(); t != "" && f.BP >= BPM {
		tags = append(tags, t)
	}
	if m.cfg.ReadOnly && f.BP >= BPM {
		tags = append(tags, "RO")
	}
	tag := ""
	if len(tags) > 0 {
		tag = " " + strings.Join(tags, " ")
	}
	focus := m.focusTag(f)

	// The name yields first, then the dim tags, and the focus tag last: it is
	// the one that says the pane is not showing what the header implies.
	nameWidth := r.Rest() - fmtx.W(right) - fmtx.W(tag) - fmtx.W(focus) - 2
	if nameWidth < 3 && tag != "" {
		tag = ""
		nameWidth = r.Rest() - fmtx.W(right) - fmtx.W(focus) - 2
	}
	if nameWidth < 3 {
		focus = ""
		nameWidth = 3
	}
	nameStyle := theme.SName
	if m.gone() {
		nameStyle = theme.SDim
	}
	r.Add(theme.SBg, " ")
	r.Add(nameStyle, fmtx.TruncRight(m.headerName(), nameWidth))

	reg, ok := region{}, false
	if focus != "" {
		r.Add(theme.SBg, " ")
		at := r.used
		r.Add(theme.SLink, focus)
		if w := r.used - at; w > 0 {
			reg, ok = region{X: at, Y: 0, W: w, H: 1, Act: actFocusHome}, true
		}
	}
	if tag != "" {
		r.Add(theme.SDim, tag)
	}
	r.Right(pillStyle, right)
	return r.String(), reg, ok
}

// tabSpan is where one mode tab sits on the strip: x is its first cell and w
// its width, the label plus the one padding cell each side that makes the
// active tab a block. The renderer draws from these and the hit regions are
// built from the same list, so a tab's hitbox is its tab at every width.
type tabSpan struct {
	mode  Mode
	label string
	x, w  int
}

// tabTier picks which of a mode's three captions (Label, Short, Tiny) a tab
// wears -- 0, 1 or 2 -- so layTabs and its callers name the same three states
// by number rather than reintroducing a bool per tier.
const (
	tierFull = iota
	tierShort
	tierTiny
)

// tabSpans lays the strip out for a width. Six full labels do not fit
// anywhere narrow, so the strip abbreviates in steps -- full, then short,
// then the single-letter tier -- a six-tab short strip still overflows at 30
// columns -- trying the next tier only when the previous still runs past the
// width. Because the hit
// regions are built from this same list, they abbreviate with it.
//
// It is geometry only: whether a tab is the active one is the renderer's
// business.
func tabSpans(f Frame) []tabSpan {
	tier := tierFull
	if f.BP == BPS {
		tier = tierShort
	}
	spans := layTabs(tier)
	for tier < tierTiny && !tabsFit(spans, f.W) {
		tier++
		spans = layTabs(tier)
	}
	return spans
}

// tabsFit reports whether the laid-out strip leaves room for the ? at the
// right edge.
func tabsFit(spans []tabSpan, w int) bool {
	if len(spans) == 0 {
		return true
	}
	last := spans[len(spans)-1]
	return last.x+last.w <= w-1
}

func layTabs(tier int) []tabSpan {
	spans := make([]tabSpan, 0, len(AllModes))
	x := 0
	for i, mode := range AllModes {
		label := mode.Label()
		switch tier {
		case tierShort:
			label = mode.Short()
		case tierTiny:
			label = mode.Tiny()
		}
		w := fmtx.W(label) + 2
		spans = append(spans, tabSpan{mode: mode, label: label, x: x, w: w})
		x += w
		if i < len(AllModes)-1 {
			x++ // one ground cell between blocks
		}
	}
	return spans
}

func (m Model) headerRow2(f Frame) string {
	r := NewRow(f.W)
	for i, sp := range tabSpans(f) {
		if i > 0 {
			r.Add(theme.SBg, " ")
		}
		st := theme.STabOff
		if sp.mode == m.mode {
			st = theme.STab
		}
		r.Add(st, " "+sp.label+" ")
	}
	// The long caption only when the strip actually leaves room for it: the
	// seventh tab took most of the slack at 56-63 columns, and `? help`
	// truncated is `? …`, which reads as a bug rather than as a narrow pane.
	help := "?"
	if f.BP == BPL && r.Rest() >= fmtx.W("? help")+1 {
		help = "? help"
	}
	r.Right(theme.SLabel, help)
	return r.String()
}
