package ui

import (
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// BP is the width breakpoint. The three mockup widths -- 30, 40, 60 -- are
// what a quarter of a 120-, 160- and 240-column window actually yields.
type BP int

const (
	// BPBlank is under 6 columns: background only.
	BPBlank BP = iota
	// BPTiny is 6..11: the brand and the percentage, nothing else.
	BPTiny
	// BPXS is 12..29: the vertical degraded strip.
	BPXS
	// BPS is 30..39.
	BPS
	// BPM is 40..55.
	BPM
	// BPL is 56 and up.
	BPL
)

// BPOf classifies a width.
func BPOf(w int) BP {
	switch {
	case w < 6:
		return BPBlank
	case w < 12:
		return BPTiny
	case w < 30:
		return BPXS
	case w < 40:
		return BPS
	case w < 56:
		return BPM
	default:
		return BPL
	}
}

// HL is the height ladder.
type HL int

const (
	// HLStrip is under 8 rows.
	HLStrip HL = iota
	// HLTiny is 8..11: header collapses to one row, no footer.
	HLTiny
	// HLShort is 12..17: no sparkline, agents folded into a count, others 1 row.
	HLShort
	// HLMed is 18..29: status wraps to 2 lines, agents <= 2, others <= 2.
	HLMed
	// HLFull is 30 and up: everything.
	HLFull
)

// HLOf classifies a height.
func HLOf(h int) HL {
	switch {
	case h < 8:
		return HLStrip
	case h < 12:
		return HLTiny
	case h < 18:
		return HLShort
	case h < 30:
		return HLMed
	default:
		return HLFull
	}
}

// Frame is the width/height budget for one render. It is recomputed on every
// WindowSizeMsg so View never does arithmetic on the fly and the goldens stay
// deterministic.
type Frame struct {
	W, H        int
	BP          BP
	HL          HL
	HeaderRows  int  // 2, or 1 at HLTiny
	OtherRows   int  // OTHERS rows the footer may draw
	StatusLines int  // rows the STATUS sentence may wrap over
	AgentRows   int  // rows the AGENTS panel may draw
	Spark       bool // draw the sparkline
	FoldAgents  bool // agents become a count on the stats row
	ShowFooter  bool
	ShowLast    bool // the short-help / toast / armed row
}

// NewFrame computes the budget for a size.
func NewFrame(w, h int) Frame {
	f := Frame{W: w, H: h, BP: BPOf(w), HL: HLOf(h)}
	f.HeaderRows = 2
	f.ShowFooter = true
	f.ShowLast = true
	switch f.HL {
	case HLFull:
		f.OtherRows, f.StatusLines, f.AgentRows, f.Spark = 4, 3, 4, true
	case HLMed:
		f.OtherRows, f.StatusLines, f.AgentRows, f.Spark = 2, 2, 2, true
	case HLShort:
		f.OtherRows, f.StatusLines, f.AgentRows, f.Spark = 1, 1, 0, false
		f.FoldAgents = true
	case HLTiny:
		f.HeaderRows = 1
		f.OtherRows, f.StatusLines, f.AgentRows, f.Spark = 0, 1, 0, false
		f.FoldAgents = true
		f.ShowFooter = false
	default: // HLStrip
		f.HeaderRows = 1
		f.ShowFooter = false
		f.ShowLast = false
		f.StatusLines = 0
	}
	if f.BP == BPS {
		// At 30 columns the status wraps rather than truncating.
		if f.StatusLines > 2 {
			f.StatusLines = 2
		}
	}
	return f
}

// Row builds one line of exactly W cells with the pane background painted on
// every one of them. It is the single place widths are enforced, which is what
// makes the frame invariant testable.
type Row struct {
	w      int
	used   int
	ground lipgloss.Style
	b      strings.Builder
}

// NewRow starts a row of width w.
func NewRow(w int) *Row {
	if w < 0 {
		w = 0
	}
	return &Row{w: w, ground: theme.SBg}
}

// Ground sets the style the row's own padding is drawn in. It defaults to the
// pane's plain ground; BOARD's cursor row sets it to reverse video so the
// highlight runs to the right edge rather than stopping at the last word.
func (r *Row) Ground(st lipgloss.Style) *Row {
	r.ground = st
	return r
}

// Rest is the number of cells still free.
func (r *Row) Rest() int {
	if r.used > r.w {
		return 0
	}
	return r.w - r.used
}

// Add appends styled text, truncating it to what is left. Control characters
// are replaced first, so nothing a session reports can shear a row or emit a
// colour the theme did not choose.
func (r *Row) Add(st lipgloss.Style, s string) *Row {
	s = fmtx.Plain(s)
	if s == "" || r.Rest() == 0 {
		return r
	}
	s = fmtx.TruncRight(s, r.Rest())
	if s == "" {
		return r
	}
	r.b.WriteString(st.Render(s))
	r.used += fmtx.W(s)
	return r
}

// AddPlain appends unstyled text on the pane background.
func (r *Row) AddPlain(s string) *Row { return r.Add(theme.SBg, s) }

// Fill repeats a single-cell glyph n times in the given style.
func (r *Row) Fill(st lipgloss.Style, glyph string, n int) *Row {
	if n <= 0 {
		return r
	}
	if n > r.Rest() {
		n = r.Rest()
	}
	return r.Add(st, strings.Repeat(glyph, n))
}

// Right pushes text to the right edge, padding with background first. Anything
// that does not fit is dropped rather than wrapped.
func (r *Row) Right(st lipgloss.Style, s string) *Row {
	if s == "" {
		return r
	}
	need := fmtx.W(s)
	if need > r.Rest() {
		s = fmtx.TruncRight(s, r.Rest())
		need = fmtx.W(s)
	}
	if pad := r.Rest() - need; pad > 0 {
		r.Add(r.ground, strings.Repeat(" ", pad))
	}
	return r.Add(st, s)
}

// String pads the row out to its full width and returns it.
func (r *Row) String() string {
	if pad := r.Rest(); pad > 0 {
		r.b.WriteString(r.ground.Render(strings.Repeat(" ", pad)))
		r.used = r.w
	}
	return r.b.String()
}

// Blank is an empty row of the frame's width.
func Blank(w int) string { return NewRow(w).String() }

// Head renders the browser's .phead treatment: a yellow tick, a dim uppercase
// teal label, a hairline rule, and an optional right-aligned value. It costs
// zero columns of chrome, which is why it survives at 30.
func Head(w int, label, right string, rs lipgloss.Style) string {
	r := NewRow(w)
	r.Add(theme.STick, theme.GTick)
	r.Add(theme.SLabel, strings.ToUpper(label))
	rw := 0
	if right != "" {
		rw = fmtx.W(right) + 1
	}
	fill := r.Rest() - rw
	if fill < 1 {
		fill = 0
	}
	if fill >= 2 {
		r.Add(theme.SRule, " ")
		r.Fill(theme.SRule, theme.GRule, fill-1)
	} else if fill == 1 {
		r.Add(theme.SRule, " ")
	}
	if right != "" && r.Rest() > 0 {
		if r.Rest() > fmtx.W(right) {
			r.Add(theme.SBg, " ")
		}
		r.Right(rs, right)
	}
	return r.String()
}

// BarFill is how many of a w-cell bar's cells are filled at frac. The context
// bar and BOARD's 10-cell mini bar share it, so the same percentage reads the
// same in both.
func BarFill(w int, frac float64) int {
	if w <= 0 {
		return 0
	}
	if frac < 0 {
		frac = 0
	}
	if frac > 1 {
		frac = 1
	}
	full := int(frac*float64(w) + 0.5)
	if full > w {
		full = w
	}
	return full
}

// Bar renders the flat one-row context bar: fill in the threshold colour,
// remainder in edge colour. No gradient, no animation.
func Bar(w int, frac float64) string {
	if w <= 0 {
		return ""
	}
	full := BarFill(w, frac)
	r := NewRow(w)
	r.Fill(theme.On(theme.CtxColor(frac)), theme.GBarFull, full)
	r.Fill(theme.SRule, theme.GBarEmpty, w-full)
	return r.String()
}

// Spark renders a one-row sparkline of the last w values, teal.
//
// The baseline comes from the data rather than being forced to zero, which is
// the browser pane's rule in sparkline (app.js:306, the baseline itself at
// :321-323), and this pane is bound to it: a series that only varies
// in its top decile -- the ordinary shape of a token counter -- must show that
// variation rather than read as a solid block, and a perfectly flat series
// sits in the middle rather than pegged at the top. The 0.25 below and 0.1
// above are the browser's, so the two panes draw the same series the same way.
func Spark(w int, vals []int64) string {
	if w <= 0 {
		return ""
	}
	r := NewRow(w)
	if len(vals) == 0 {
		r.Fill(theme.SDim, theme.GRule, w)
		return r.String()
	}
	if len(vals) > w {
		vals = vals[len(vals)-w:]
	}
	lo, hi := vals[0], vals[0]
	for _, v := range vals {
		if v < lo {
			lo = v
		}
		if v > hi {
			hi = v
		}
	}
	base, span := float64(hi)-1, 2.0 // flat: centred, not pegged
	if hi != lo {
		d := float64(hi - lo)
		base = float64(lo) - d*0.25
		span = float64(hi) + d*0.1 - base
	}
	top := len(theme.Spark) - 1
	var b strings.Builder
	for _, v := range vals {
		idx := int((float64(v)-base)/span*float64(top) + 0.5)
		b.WriteRune(theme.Spark[clampInt(idx, 0, top)])
	}
	r.Add(theme.SValue, b.String())
	return r.String()
}

// Clamp forces the rendered rows to exactly h lines of exactly w cells. It is
// the single choke point that makes the frame invariant hold at every size,
// including the WindowSizeMsg{0,0} that arrives during pane creation.
func Clamp(rows []string, w, h int) string {
	if w <= 0 || h <= 0 {
		return ""
	}
	out := make([]string, 0, h)
	for i := 0; i < h; i++ {
		if i < len(rows) {
			out = append(out, rows[i])
		} else {
			out = append(out, Blank(w))
		}
	}
	return strings.Join(out, "\n")
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
