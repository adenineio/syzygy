package ui

import (
	"math"

	"github.com/adenineio/syzygy/pane-v2/internal/relay"
)

// spinDraw draws one frame of a spinner into a canvas of its own. It is a pure
// function of st: no goroutines, no clock reads, no state carried between
// frames, which is what makes a frame reproducible from its number alone.
type spinDraw func(c *canvas, st spinState)

type spinnerDef struct {
	ID   string
	Name string
	Draw spinDraw
}

// spinners is the registry, in the order s and S cycle through.
var spinners = []spinnerDef{
	{ID: "orrery", Name: "Orrery", Draw: orrery},
	{ID: "galvanometer", Name: "Galvanometer", Draw: galvanometer},
}

// orreryTracks is the ceiling on bodies. Past five the tracks stop reading as
// separate orbits and a busy session just becomes noise.
const orreryTracks = 5

// orreryTilt is how far the mechanism is tipped away from the viewer: a track
// is this many times wider than it is tall.
//
// It is a cap, not a shape. Taking the whole width and the whole height
// independently is the naive approach, and in the four rows VITALS
// usually has left over that gives a 5:1 ellipse whose tracks all land within
// a dot-row of each other -- three orbits that read as one smear of dashes.
// Height is the scarce axis, so height sets the size and the tilt sets the
// width from it.
const orreryTilt = 3.0

// orreryTrackDots is the vertical room one track needs to be told apart from
// its neighbour, in braille dots. Below it the mechanism drops an orbit rather
// than drawing two on top of each other.
const orreryTrackDots = 2.0

// orrery draws a brass orbital mechanism: concentric elliptical tracks with a
// body running each one. Track 0 is the turn itself; the rest are one per live
// agent, so the motion is real data rather than decoration.
//
// It works in the canvas's braille dot space -- 2 dots per column, 4 per row --
// through a dotter, because put replaces a whole cell and an ellipse plotted
// that way loses every dot but the last in each cell. The tracks come out wide
// and flat, which is what an orrery looks like seen from near its plane.
func orrery(c *canvas, st spinState) {
	if st.W < 2 || st.H < 1 {
		return
	}
	// The word sits on the bottom row, so the mechanism gives it up rather
	// than drawing an orbit through the text.
	rows := spinRows(st)

	dw, dh := st.W*2, rows*4
	cx, cy := float64(dw)/2, float64(dh)/2
	maxRX, maxRY := float64(dw)/2-2, float64(dh)/2-1
	if maxRX < 1 || maxRY < 1 {
		return
	}

	tint := tintOf(st.Mode, st.Escalated)
	d := c.dots()

	// The centre, the thing everything else turns around.
	blob(d, cx, cy, tint)

	// Only as many orbits as can be told apart in the rows on hand.
	room := clampInt(int(maxRY/orreryTrackDots), 1, orreryTracks)
	bodies := clampInt(1+st.Agents, 1, room)
	tilt := math.Min(orreryTilt, maxRX/maxRY)

	for i := 0; i < bodies; i++ {
		// The innermost track clears the centre body; the outermost reaches
		// the edge, so the mechanism always fills the height it was given.
		scale := 0.75
		if bodies > 1 {
			scale = 0.40 + 0.60*float64(i)/float64(bodies-1)
		}
		ry := maxRY * scale
		rx := math.Min(ry*tilt, maxRX)

		// The track. Sampled at roughly two points per dot so the ellipse
		// reads as a continuous line rather than a dotted one.
		steps := int(4*(rx+ry)) + 16
		for k := 0; k < steps; k++ {
			a := 2 * math.Pi * float64(k) / float64(steps)
			d.plot(int(cx+rx*math.Cos(a)), int(cy+ry*math.Sin(a)), gsDim)
		}

		// The body, one revolution per (90 + 30i) frames, outer tracks slower
		// -- Kepler's direction, if not his arithmetic. Track 0 carries the
		// mode tint; the agents' tracks stay dim so the turn stays legible.
		ang := 2 * math.Pi * float64(st.Frame) / float64(90+30*i)
		bodySt := gsDim
		if i == 0 {
			bodySt = tint
		}
		blob(d, cx+rx*math.Cos(ang), cy+ry*math.Sin(ang), bodySt)
	}
	d.draw()
	spinWord(c, st)
}

// blob lights a 3x3 patch of dots, which is the smallest mark that reads as a
// body rather than as one more dot of the track it sits on.
func blob(d *dotter, x, y float64, st gs) {
	bx, by := int(x), int(y)
	for ox := -1; ox <= 1; ox++ {
		for oy := -1; oy <= 1; oy++ {
			d.plot(bx+ox, by+oy, st)
		}
	}
}

// ---- shared drawing helpers -------------------------------------------

// spinRows is the height a spinner may draw into. Every spinner gives its
// bottom row up to the mode word when the engine sent one, so no drawing ever
// runs through the text.
func spinRows(st spinState) int {
	if st.Word != "" && st.H > 1 {
		return st.H - 1
	}
	return st.H
}

// spinWord writes the mode word on the row spinRows held back.
func spinWord(c *canvas, st spinState) {
	if st.Word != "" && st.H > 1 {
		c.text(1, st.H-1, st.Word, gsDim)
	}
}

// dline draws a straight line in the dotter's sub-cell space.
//
// canvas.line is the same Bresenham walk but its endpoints are cell centres,
// which is too coarse for a rune eight cells tall: every stroke would snap to
// a cell and the shape would come out as a staircase. This one takes dot
// coordinates, so an endpoint lands on any of the 2x4 dots in a cell, and it
// goes through the dotter so crossing strokes merge instead of erasing each
// other.
func dline(d *dotter, x0, y0, x1, y1 int, st gs) {
	dx, dy := absInt(x1-x0), -absInt(y1-y0)
	stepX, stepY := 1, 1
	if x0 > x1 {
		stepX = -1
	}
	if y0 > y1 {
		stepY = -1
	}
	err := dx + dy
	for x, y := x0, y0; ; {
		d.plot(x, y, st)
		if x == x1 && y == y1 {
			return
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
}

func clampF(v, lo, hi float64) float64 {
	return math.Max(lo, math.Min(hi, v))
}

// spinFreq is how many wave cycles a mode puts across the trace, and how fast
// it scrolls. Divining is slow and long; conjuring is fast and tight.
func spinFreq(mode string) float64 {
	switch mode {
	case "requesting":
		return 2.5
	case "responding":
		return 3.5
	case "tool-input":
		return 4.5
	case "tool-use":
		return 5.5
	default: // thinking
		return 1.75
	}
}

// seriesEnvelope resamples the token series to n values in 0..1.
//
// The normalisation is Spark's, deliberately: the baseline comes from the data
// rather than from zero, and a flat run sits centred at half rather than
// pegged. Forcing zero is what made the sparkline render as a solid block, and
// it would make this trace a flat-topped square wave in exactly the same way.
func seriesEnvelope(pts []relay.Point, n int) []float64 {
	out := make([]float64, maxInt(n, 0))
	for i := range out {
		out[i] = 0.5
	}
	if len(pts) == 0 || n <= 0 {
		return out
	}
	lo, hi := pts[0].Tokens, pts[0].Tokens
	for _, p := range pts {
		if p.Tokens < lo {
			lo = p.Tokens
		}
		if p.Tokens > hi {
			hi = p.Tokens
		}
	}
	base, span := float64(hi)-1, 2.0 // flat: centred, not pegged
	if hi != lo {
		d := float64(hi - lo)
		base = float64(lo) - d*0.25
		span = float64(hi) + d*0.1 - base
	}
	for i := range out {
		j := 0
		if n > 1 {
			j = i * (len(pts) - 1) / (n - 1)
		}
		out[i] = clampF((float64(pts[j].Tokens)-base)/span, 0, 1)
	}
	return out
}

// ---- the Galvanometer -------------------------------------------------

// galvanometer draws a phosphor oscilloscope trace: a carrier whose frequency
// is the mode, modulated by the real token throughput, scrolling right to left
// under a bright beam head.
//
// The trace is continuous. Each dot column is joined to the one before it by a
// vertical fill, because a scope that plots one dot per column and leaves the
// jumps between them empty draws scattered specks -- which is precisely the
// bug the band's oscilloscope shipped with.
//
// Decay is drawn in the two things the palette leaves: colour and thickness.
// Only ANSI 8 is available as a second tint, so the recent quarter of the
// trace is drawn two dots thick in the mode's colour, the middle thin in the
// same colour, and the old tail thin and grey.
func galvanometer(c *canvas, st spinState) {
	rows := spinRows(st)
	if st.W < 4 || rows < 1 {
		return
	}
	dw, dh := st.W*2, rows*4
	cy := dh / 2
	amp := float64(dh)/2 - 1
	if amp < 1 {
		amp = 1
	}

	tint := tintOf(st.Mode, st.Escalated)
	d := c.dots()

	// The zero line, so a small trace still reads as a deflection from rest.
	for x := 0; x < dw; x += 4 {
		d.plot(x, cy, gsDim)
	}

	// The carrier is the mode; the envelope is the throughput. The envelope
	// keeps a floor of its own so a quiet stretch still deflects: a real
	// series that sits flat and then jumps would otherwise draw a hairline
	// followed by a wall, which reads as a glitch rather than as a signal.
	env := seriesEnvelope(st.Series, dw)
	freq := spinFreq(st.Mode)
	phase := float64(st.Frame) * 0.06 * freq
	ys := make([]int, dw)
	for x := range ys {
		e := 0.35 + 0.65*env[x]
		v := math.Sin(2*math.Pi*freq*float64(x)/float64(dw) - phase)
		ys[x] = clampInt(cy+int(e*amp*v), 0, dh-1)
	}

	prev := -1
	for x, y := range ys {
		age := dw - 1 - x
		style, thick := gsDim, false
		switch {
		case age < dw/4:
			style, thick = tint, true
		case age < dw/2:
			style = tint
		}

		lo, hi := y, y
		if prev >= 0 {
			lo, hi = minInt(prev, y), maxInt(prev, y)
		}
		for py := lo; py <= hi; py++ {
			d.plot(x, py, style)
			if thick {
				d.plot(x, py+1, style)
			}
		}
		prev = y
	}

	// The beam head, the one mark bright enough to find at a glance.
	blob(d, float64(dw-2), float64(ys[dw-1]), tint)
	d.draw()
	spinWord(c, st)
}
