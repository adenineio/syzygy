package ui

import (
	"testing"

	"github.com/adenineio/syzygy/pane-v2/internal/relay"
)

// lay41 is the user's real pane: two 20-cell cards and one gutter column.
func lay41(t *testing.T) gridLayout {
	t.Helper()
	l := gridLayoutFor(NewFrame(41, 49), 44, 0)
	if l.Cols != 2 || l.CardW != 20 {
		t.Fatalf("41 columns should be two 20-cell cards, got %d x %d", l.Cols, l.CardW)
	}
	return l
}

func idx(ids ...string) map[string]int {
	m := map[string]int{}
	for i, id := range ids {
		m[id] = i
	}
	return m
}

func TestASideBySidePairRoutesThroughTheGutter(t *testing.T) {
	lay := lay41(t)
	w := routeWires(lay, 0, idx("a", "b"), []relay.Link{{From: "a", To: "b"}})
	if len(w) != 1 {
		t.Fatalf("want one wire, got %d", len(w))
	}
	if w[0].Direct {
		t.Error("a side-by-side pair has a gutter and must not fall back")
	}
	if len(w[0].Pts) != 2 {
		t.Fatalf("a straight run is two points, got %v", w[0].Pts)
	}
	if w[0].Pts[0].Y != w[0].Pts[1].Y {
		t.Errorf("the run is not horizontal: %v", w[0].Pts)
	}
	if w[0].Pts[0].X != lay.CardW || w[0].Pts[1].X != lay.CardW {
		t.Errorf("the run does not sit in the gutter column %d: %v", lay.CardW, w[0].Pts)
	}
}

func TestACrossRowPairRoutesThroughTheGapRow(t *testing.T) {
	lay := lay41(t)
	w := routeWires(lay, 0, idx("a", "b", "c"), []relay.Link{{From: "a", To: "c"}})
	if len(w) != 1 || w[0].Direct {
		t.Fatalf("want one routed wire, got %+v", w)
	}
	if len(w[0].Pts) != 3 {
		t.Fatalf("a cross-row route is three points, got %v", w[0].Pts)
	}
	if w[0].Pts[1].Y != gridCardH {
		t.Errorf("the middle run is not on the first gap row: %v", w[0].Pts)
	}
}

func TestASecondWireWantingTheSameGapRowTakesTheNext(t *testing.T) {
	lay := lay41(t)
	ids := idx("a", "b", "c", "d")
	// Crossing links: both horizontal runs cover the same cells of the first
	// gap row, so the second cannot have it. Links whose runs are disjoint may
	// share a row, and do.
	w := routeWires(lay, 0, ids, []relay.Link{{From: "a", To: "d"}, {From: "b", To: "c"}})
	if len(w) != 2 {
		t.Fatalf("want two wires, got %d", len(w))
	}
	if w[0].Pts[1].Y == w[1].Pts[1].Y && !w[1].Direct {
		t.Errorf("two wires share one gap row: %v and %v", w[0].Pts, w[1].Pts)
	}
}

func TestAFullBoardFallsBackToADirectSegment(t *testing.T) {
	lay := gridLayoutFor(NewFrame(41, 16), 9, 0) // two card rows, one gap row
	ids := idx("a", "b", "c", "d")
	links := []relay.Link{{From: "a", To: "c"}, {From: "b", To: "d"}, {From: "a", To: "d"}}
	w := routeWires(lay, 0, ids, links)
	last := w[len(w)-1]
	if !last.Direct {
		t.Errorf("with every channel claimed the last wire must give up and go direct: %+v", last)
	}
	if len(last.Pts) != 2 {
		t.Errorf("a direct segment is two points: %v", last.Pts)
	}
}

func TestALinkToAnOffScreenCardIsSkipped(t *testing.T) {
	lay := lay41(t)
	if w := routeWires(lay, 0, idx("a"), []relay.Link{{From: "a", To: "gone"}}); len(w) != 0 {
		t.Errorf("a link with an unknown end must be skipped, got %+v", w)
	}
	if w := routeWires(lay, 99, idx("a", "b"), []relay.Link{{From: "a", To: "b"}}); len(w) != 0 {
		t.Errorf("a link whose cards are scrolled away must be skipped, got %+v", w)
	}
}

func TestRoutingIsDeterministic(t *testing.T) {
	lay := lay41(t)
	ids := idx("a", "b", "c", "d")
	links := []relay.Link{{From: "a", To: "c"}, {From: "b", To: "d"}}
	first := routeWires(lay, 0, ids, links)
	for i := 0; i < 20; i++ {
		got := routeWires(lay, 0, ids, links)
		for j := range first {
			if got[j].Direct != first[j].Direct || len(got[j].Pts) != len(first[j].Pts) {
				t.Fatalf("run %d differs at wire %d: %+v vs %+v", i, j, got[j], first[j])
			}
			for k := range first[j].Pts {
				if got[j].Pts[k] != first[j].Pts[k] {
					t.Fatalf("run %d differs at wire %d point %d", i, j, k)
				}
			}
		}
	}
}
