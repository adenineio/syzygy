package ui

import (
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// gs indexes the canvas's style table. Cells carry an index rather than a
// style so adjacent cells can be compared and emitted as one run.
type gs uint8

const (
	gsBg gs = iota
	gsBox
	gsName
	gsNameSelf
	gsNameHot    // the armed or dragged source
	gsNameTarget // the hovered drop target and the keyboard cursor
	gsDim
	gsOn
	gsOff
	gsPctLow
	gsPctMid
	gsPctHigh
	gsLink
	// gsWire is a settled link between two cards. Dim, so the line that follows
	// a drag -- which is live, and which the reader is steering -- is the one
	// thing on the board in link colour.
	gsWire

	// The plain theme roles, added for the spinners. tintOf maps the engine's
	// five spinner modes onto these; the band tints those with 24-bit hexes
	// and none of that survives the pane's ANSI-only rule, so the tint is a
	// role rather than a colour. gsAgent is the only genuinely new one --
	// purple had no entry in this table at all.
	gsAgent
	gsValue
	gsWarn
	gsErr
)

var gridStyles = [...]lipgloss.Style{
	gsBg:         theme.SBg,
	gsBox:        theme.SRule,
	gsName:       theme.SName,
	gsNameSelf:   theme.SValue,
	gsNameHot:    theme.SWarn,
	gsNameTarget: theme.SCursor,
	gsDim:        theme.SDim,
	gsOn:         theme.SWarn,
	gsOff:        theme.SDim,
	gsPctLow:     theme.On(theme.Teal),
	gsPctMid:     theme.SWarn,
	gsPctHigh:    theme.SErr,
	gsLink:       theme.SLink,
	gsWire:       theme.SDim,
	gsAgent:      theme.SAgent,
	gsValue:      theme.SValue,
	gsWarn:       theme.SWarn,
	gsErr:        theme.SErr,
}

// cell is one display cell: a glyph that measures exactly one column and a
// style index.
type cell struct {
	ch string
	st gs
}

// canvas is a w x h grid of cells. Every row it emits is exactly w cells wide
// because every cell holds exactly one column, which is what lets a line be
// drawn over cards without any row arithmetic.
type canvas struct {
	w, h  int
	cells []cell
}

func newCanvas(w, h int) *canvas {
	w, h = maxInt(w, 0), maxInt(h, 0)
	c := &canvas{w: w, h: h, cells: make([]cell, w*h)}
	for i := range c.cells {
		c.cells[i] = cell{ch: " ", st: gsBg}
	}
	return c
}

// put writes one glyph. Out-of-range writes are dropped, never an error.
func (c *canvas) put(x, y int, ch string, st gs) {
	if x < 0 || y < 0 || x >= c.w || y >= c.h {
		return
	}
	c.cells[y*c.w+x] = cell{ch: ch, st: st}
}

// text writes a string rune by rune. A rune that does not measure one column
// -- a wide glyph, a control byte -- is written as "?" so a row cannot shear.
func (c *canvas) text(x, y int, s string, st gs) {
	for _, r := range s {
		if x >= c.w {
			return
		}
		ch := string(r)
		if fmtx.W(ch) != 1 {
			ch = "?"
		}
		c.put(x, y, ch, st)
		x++
	}
}

func (c *canvas) hline(x, y, n int, ch string, st gs) {
	for i := 0; i < n; i++ {
		c.put(x+i, y, ch, st)
	}
}

// rows serialises the canvas through the Row builder, one Add per run of
// equally styled cells.
func (c *canvas) rows() []string {
	out := make([]string, c.h)
	for y := 0; y < c.h; y++ {
		r := NewRow(c.w)
		row := c.cells[y*c.w : (y+1)*c.w]
		for x := 0; x < c.w; {
			st := row[x].st
			var b strings.Builder
			for x < c.w && row[x].st == st {
				b.WriteString(row[x].ch)
				x++
			}
			r.Add(gridStyles[st], b.String())
		}
		out[y] = r.String()
	}
	return out
}

// brailleDots maps a sub-cell (column 0..1, row 0..3) to its dot bit.
var brailleDots = [2][4]rune{{0x01, 0x02, 0x04, 0x40}, {0x08, 0x10, 0x20, 0x80}}

// line draws a straight line between two cell centres in braille, which gives
// two columns and four rows of dots per cell. Cells for which skip returns
// true are left alone; everything else the line crosses is overwritten.
func (c *canvas) line(x0, y0, x1, y1 int, st gs, skip func(x, y int) bool) {
	sx, sy := x0*2+1, y0*4+2
	ex, ey := x1*2+1, y1*4+2
	dx, dy := absInt(ex-sx), -absInt(ey-sy)
	stepX, stepY := 1, 1
	if sx > ex {
		stepX = -1
	}
	if sy > ey {
		stepY = -1
	}
	err := dx + dy
	dots := map[[2]int]rune{}
	for x, y := sx, sy; ; {
		// Bounds before modulo: a pointer over the header is a negative y.
		if x >= 0 && y >= 0 {
			cx, cy := x/2, y/4
			if cx < c.w && cy < c.h && (skip == nil || !skip(cx, cy)) {
				dots[[2]int{cx, cy}] |= brailleDots[x%2][y%4]
			}
		}
		if x == ex && y == ey {
			break
		}
		e2 := 2 * err
		if e2 >= dy {
			err += dy
			x += stepX
		}
		if e2 <= dx {
			err += dx
			y += stepY
		}
	}
	for k, bits := range dots {
		c.put(k[0], k[1], string(rune(0x2800)|bits), st)
	}
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// dotter accumulates braille sub-cell dots before any of them is written.
//
// It exists because put replaces a cell rather than merging into it: a curve
// plotted straight through put keeps only the last dot to land in each cell
// and reads as scattered specks instead of a line. line already solves this
// for a straight segment by OR-ing into a map and writing once at the end;
// dotter is that same mechanism, opened up so a spinner can plot an arbitrary
// curve one dot at a time.
type dotter struct {
	c   *canvas
	bit map[[2]int]rune
	st  map[[2]int]gs
}

// dots starts an accumulator over the canvas.
func (c *canvas) dots() *dotter {
	return &dotter{c: c, bit: map[[2]int]rune{}, st: map[[2]int]gs{}}
}

// plot lights one sub-cell dot. x counts half-columns and y quarter-rows, so
// the dot grid is 2w wide and 4h tall. Out-of-range dots are dropped, the way
// put drops out-of-range cells.
func (d *dotter) plot(x, y int, st gs) {
	if x < 0 || y < 0 {
		return
	}
	cx, cy := x/2, y/4
	if cx >= d.c.w || cy >= d.c.h {
		return
	}
	k := [2]int{cx, cy}
	d.bit[k] |= brailleDots[x%2][y%4]
	// Last writer wins the cell's colour, so a body plotted over a track
	// takes the tint and the track keeps it everywhere else.
	d.st[k] = st
}

// draw writes every accumulated cell to the canvas.
func (d *dotter) draw() {
	for k, bits := range d.bit {
		d.c.put(k[0], k[1], string(rune(0x2800)|bits), d.st[k])
	}
}
