package ui

import "github.com/adenineio/syzygy/pane-v2/internal/relay"

// wirePt is one corner of a route, in canvas coordinates.
type wirePt struct{ X, Y int }

// wire is one settled link, drawn as a chain of straight runs. Consecutive
// points are one braille segment each, so a turn renders as a chamfer rather
// than a right angle.
type wire struct {
	From, To string
	Pts      []wirePt
	// Direct is set when no channel was free and the route is a single
	// segment across the board. A visible crossing is a fact; a dropped wire
	// would be a lie.
	Direct bool
}

// routeWires fits every link between two visible cards into the gutters and gap
// rows the layout leaves free.
//
// The board is tight by design: at the width this pane actually runs at there
// is one free column between the two card columns and one free row between card
// rows, so two wires wanting the same channel cannot both have it. Routing is
// therefore first-come, in the order the links arrive, over a claimed-cell set
// -- deterministic, and the same twice.
func routeWires(lay gridLayout, top int, index map[string]int, links []relay.Link) []wire {
	if lay.Cols <= 0 || lay.Rows <= 0 {
		return nil
	}
	claimed := map[wirePt]bool{}
	free := func(y, x0, x1 int) bool {
		if y < 0 || y >= lay.CanvasH {
			return false
		}
		if x0 > x1 {
			x0, x1 = x1, x0
		}
		for x := x0; x <= x1; x++ {
			if claimed[wirePt{x, y}] {
				return false
			}
		}
		return true
	}
	claim := func(y, x0, x1 int) {
		if x0 > x1 {
			x0, x1 = x1, x0
		}
		for x := x0; x <= x1; x++ {
			claimed[wirePt{x, y}] = true
		}
	}
	rectOf := func(id string) (gridRect, bool) {
		i, ok := index[id]
		if !ok {
			return gridRect{}, false
		}
		return lay.cardRect(i, top)
	}
	mid := func(r gridRect) int { return r.X + r.W/2 }

	out := make([]wire, 0, len(links))
	for _, l := range links {
		a, okA := rectOf(l.From)
		b, okB := rectOf(l.To)
		if !okA || !okB || (a.X == b.X && a.Y == b.Y) {
			continue
		}
		w := wire{From: l.From, To: l.To}

		// Same card row and next to each other: the one gutter column between
		// them, along the cards' middle row.
		if a.Y == b.Y && absInt(a.X-b.X) == lay.CardW+1 {
			y := a.Y + 1
			x := minInt(a.X, b.X) + lay.CardW
			if free(y, x, x) {
				claim(y, x, x)
				w.Pts = []wirePt{{x, y}, {x, y}}
				out = append(out, w)
				continue
			}
		}

		// Otherwise a gap row: out of the upper card, across, into the lower.
		upper, lower := a, b
		if lower.Y < upper.Y {
			upper, lower = lower, upper
		}
		xu, xl := mid(upper), mid(lower)
		placed := false
		for _, gapY := range gapRows(lay, upper.Y+gridCardH) {
			if gapY >= lower.Y && gapY < lower.Y+gridCardH {
				continue
			}
			if !free(gapY, xu, xl) {
				continue
			}
			claim(gapY, xu, xl)
			w.Pts = []wirePt{{xu, upper.Y + gridCardH - 1}, {xu, gapY}, {xl, gapY}}
			out = append(out, w)
			placed = true
			break
		}
		if placed {
			continue
		}

		// Nothing free: one segment, corner to corner. The drawing skips the
		// cards themselves, so this crosses the board rather than defacing it.
		w.Direct = true
		w.Pts = []wirePt{{mid(a), a.Y + 1}, {mid(b), b.Y + 1}}
		out = append(out, w)
	}
	return out
}

// gapRows lists every one-row channel between card rows, nearest to `start`
// first, going down and then up -- so a displaced wire lands beside the one
// that took its channel rather than at the far end of the board.
func gapRows(lay gridLayout, start int) []int {
	first := gridCardH
	var out []int
	for y := start; y < lay.CanvasH; y += gridPitch {
		out = append(out, y)
	}
	for y := start - gridPitch; y >= first; y -= gridPitch {
		out = append(out, y)
	}
	return out
}
