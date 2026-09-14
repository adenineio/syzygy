package ui

import (
	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/hotkeys"
)

// wheelStep is how many rows one wheel notch moves. Three is what a pager
// gives a detent, and it is what makes "wheel up near the top" re-pin FEED's
// follow rather than needing the very last row to be hit exactly.
const wheelStep = 3

// act is what landing on a hit region does. Every act has a keyboard
// equivalent that keeps working: the mouse is additive here and is never the
// only way to reach a function.
type act int

const (
	// actNone is the zero value and is never registered.
	actNone act = iota
	// actMode switches to region.Mode, the way the digits and tab do.
	actMode
	// actBoardRow moves BOARD's cursor to region.Index. A second click inside
	// the double-click window focuses that session (what enter does), and a
	// press on one row released on another links them (what l does).
	actBoardRow
	// actBoardGrip is a session row's leading grip cell, and the only place a
	// link drag can start. See boardRegions for why it is not the whole row.
	actBoardGrip
	// actFocusHome returns modes 1-3 to this window's own session, the way 0
	// does. It is the "focused elsewhere" tag in the header.
	actFocusHome
	// actGridCard is a GRID card's body: click, double-click, drop target.
	actGridCard
	// actGridGrip is the card's grip cell, and the only place a GRID drag can
	// start. See gridRegions for why it is one cell.
	actGridGrip
	// actGridBatch toggles batch: the GRID head's right-hand value.
	actGridBatch
	// actGridNotes opens the notes form: the PENDING head's right-hand value.
	actGridNotes
	// actHkRow is a HOTKEYS slot row: click to select, double-click to edit.
	// There is deliberately no region for the x confirm -- see the note on
	// onMouse.
	actHkRow
)

// region is a rectangle of the frame and what pointing at it does.
//
// Regions are a pure function of the model the last frame was rendered from --
// no goroutines, no cache, nothing that outlives the call. They are rebuilt
// from scratch for every mouse message, so a region can never describe a frame
// that is no longer on screen. The geometry itself is never duplicated: a
// region and the renderer that owns it read the same layout function (tabSpans
// for the tab strip), so a hitbox cannot drift from the thing it is over.
type region struct {
	X, Y, W, H int
	Act        act
	Mode       Mode // actMode: the mode to switch to
	Index      int  // actBoardRow: the session's index in the relay's order
}

// contains is a half-open test on both axes: a click one cell past the right
// or the bottom edge belongs to whatever is there, not to this region.
func (r region) contains(x, y int) bool {
	return x >= r.X && x < r.X+r.W && y >= r.Y && y < r.Y+r.H
}

// addRegion appends a region clipped to the frame. A renderer may hand over a
// rectangle that runs off a narrow pane -- a tab strip wider than the pane is
// drawn truncated -- and a hitbox must never extend past what was drawn.
func addRegion(regs []region, f Frame, r region) []region {
	if r.Act == actNone || r.W <= 0 || r.H <= 0 {
		return regs
	}
	if r.X < 0 {
		r.W += r.X
		r.X = 0
	}
	if r.Y < 0 {
		r.H += r.Y
		r.Y = 0
	}
	if r.X+r.W > f.W {
		r.W = f.W - r.X
	}
	if r.Y+r.H > f.H {
		r.H = f.H - r.Y
	}
	if r.W <= 0 || r.H <= 0 {
		return regs
	}
	return append(regs, r)
}

// hitAt resolves a point to at most one region. Regions are registered in
// painting order, so the last one that contains the point is the topmost, and
// a point over nothing resolves to nothing -- never to an error.
func hitAt(regs []region, x, y int) (region, bool) {
	for i := len(regs) - 1; i >= 0; i-- {
		if regs[i].contains(x, y) {
			return regs[i], true
		}
	}
	return region{}, false
}

// regions is the hit table for the frame as it stands. The header's tab strip
// and the focused-elsewhere tag are the gestures every mode has; a mode adds
// its own.
func (m Model) regions() []region {
	f := m.frame
	if f.W <= 0 || f.H <= 0 || f.BP < BPS {
		// XS and below draw a strip with no chrome to point at.
		return nil
	}
	var regs []region
	if f.HeaderRows >= 2 {
		for _, sp := range tabSpans(f) {
			regs = addRegion(regs, f, region{X: sp.x, Y: 1, W: sp.w, H: 1, Act: actMode, Mode: sp.mode})
		}
	}
	if tag, ok := m.focusTagRegion(f); ok {
		regs = addRegion(regs, f, tag)
	}
	// A degraded body is not the mode's, so its rows are not the mode's
	// either -- except HOTKEYS, which never draws a degraded body because it
	// is not a view of the relay at all (see view.go's body()).
	if m.bodyKind() == bodyMode || m.mode == ModeHotkeys {
		switch m.mode {
		case ModeBoard:
			regs = m.boardRegions(f, regs)
		case ModeGrid:
			regs = m.gridRegions(f, regs)
		case ModeHotkeys:
			regs = m.hkRegions(f, regs)
		}
	}
	return regs
}

// hkRegions is one region per slot row. The rows start directly under the
// HOTKEYS head, which is the first body row, and there are exactly
// len(SlotKeys) of them -- the list never scrolls, because eight rows fit
// every frame the pane draws a body in.
func (m Model) hkRegions(f Frame, regs []region) []region {
	if !m.hk.loaded || m.hk.editor.Open {
		return regs
	}
	top := f.HeaderRows + 1 // the head
	for i := range hotkeys.SlotKeys {
		regs = addRegion(regs, f, region{X: 0, Y: top + i, W: f.W, H: 1, Act: actHkRow, Index: i})
	}
	return regs
}

// onMouse routes a mouse message. It mirrors onKey's order: the help overlay
// first, then the mode, then the global gestures.
//
// NOTE for a later reader: the armed strip (arm.go) is deliberately not in the
// region table and must never be added to it. A blind click confirming a kill
// or an abort is exactly the failure the armed strip exists to prevent, so a
// destructive confirmation stays keyboard-only by design.
func (m Model) onMouse(msg tea.MouseMsg) (tea.Model, tea.Cmd) {
	if m.gridForm.Open || m.hk.editor.Open {
		// The form swallows the pointer for the reason the help overlay does:
		// what is under it is not what is on screen.
		return m, nil
	}
	switch e := msg.(type) {
	case tea.MouseWheelMsg:
		return m.onWheel(e.Button)
	case tea.MouseClickMsg:
		if e.Button != tea.MouseLeft {
			return m, nil
		}
		return m.onClick(e.X, e.Y)
	case tea.MouseReleaseMsg:
		if e.Button != tea.MouseLeft {
			return m, nil
		}
		return m.onRelease(e.X, e.Y)
	case tea.MouseMotionMsg:
		// Motion matters in exactly one place: a GRID drag, where the line
		// follows the pointer. Every other motion frame is dropped, so an
		// unchanged view is not repainted.
		//
		// Whether a terminal delivers these at all is not something the pane
		// can rely on: MouseModeCellMotion asks for motion while a button is
		// held, and a multiplexer in between may or may not forward it.
		//
		// Without motion the feature degrades rather than breaks, but not by
		// the press/release pair landing on its own -- onRelease returns early
		// when Moved is false, so a grip press released over another card
		// lands nothing and the arm persists. What lands it then is the third
		// gesture: a click on the target, which is the click-click path and is
		// tested. Moved decides both whether a line is drawn while the button
		// is down and whether a release counts as a drag at all.
		if e.Button == tea.MouseLeft && m.mode == ModeGrid && m.dragFrom != "" && !m.showHelp {
			m.gridDrag = gridDrag{X: e.X, Y: e.Y, Moved: true}
		}
		return m, nil
	}
	return m, nil
}

// onClick resolves a press to at most one action. It also forgets any drag
// still recorded: a press always starts a new one, or none.
func (m Model) onClick(x, y int) (tea.Model, tea.Cmd) {
	m.dragFrom = ""
	if m.showHelp || m.showBank {
		// Either overlay swallows the keyboard; it swallows clicks for the same
		// reason -- what is under them is not what is on screen.
		return m, nil
	}
	r, ok := hitAt(m.regions(), x, y)
	if !ok {
		// A click on empty space is ignored, never an error -- except that on
		// GRID it disarms, the way esc does.
		if m.mode == ModeGrid {
			m.linkFrom = ""
		}
		return m, nil
	}
	switch r.Act {
	case actMode:
		return m.setMode(r.Mode)
	case actBoardRow:
		return m.onBoardClick(r.Index)
	case actBoardGrip:
		return m.onBoardGrip(r.Index)
	case actFocusHome:
		return m.focusHome()
	case actGridCard:
		return m.onGridClick(r.Index)
	case actGridGrip:
		return m.onGridGrip(r.Index, x, y)
	case actGridBatch:
		m.gridBatch = !m.gridBatch
		return m, nil
	case actGridNotes:
		return m.openGridForm()
	case actHkRow:
		return m.onHkClick(r.Index)
	}
	return m, nil
}

// onRelease finishes a drag. On BOARD a press on one row's grip released on
// another row links them. On GRID a press on one card's grip, moved, and
// released on another card lands a connection; released anywhere else it is
// a cancel, and released without ever moving it was a click, which the press
// has already handled. Only a grip press arms either, so a press-move-release
// over a body -- a reach for a text selection -- ends here doing nothing.
func (m Model) onRelease(x, y int) (tea.Model, tea.Cmd) {
	from, drag := m.dragFrom, m.gridDrag
	m.dragFrom, m.gridDrag = "", gridDrag{}
	if from == "" || m.showHelp || m.showBank {
		return m, nil
	}
	r, ok := hitAt(m.regions(), x, y)
	switch m.mode {
	case ModeBoard:
		if !ok || (r.Act != actBoardRow && r.Act != actBoardGrip) {
			return m, nil
		}
		return m.linkDrag(from, r.Index)
	case ModeGrid:
		if !drag.Moved {
			return m, nil
		}
		onCard := ok && (r.Act == actGridCard || r.Act == actGridGrip)
		if !onCard || r.Index >= len(m.sessions) || m.sessions[r.Index].ID == from {
			m.linkFrom = "" // a drag that misses is a cancel
			return m, nil
		}
		return m.gridLand(from, m.sessions[r.Index].ID)
	}
	return m, nil
}

// onWheel scrolls whatever the current mode scrolls. FEED owns a viewport of
// its own; everything else -- and the help overlay, whichever mode it is over
// -- moves the body offset the way j/k do.
func (m Model) onWheel(b tea.MouseButton) (tea.Model, tea.Cmd) {
	delta := 0
	switch b {
	case tea.MouseWheelDown:
		delta = wheelStep
	case tea.MouseWheelUp:
		delta = -wheelStep
	default:
		// The pane has no horizontal axis: rows truncate rather than scroll.
		return m, nil
	}
	if !m.showHelp && !m.showBank {
		switch m.mode {
		case ModeFeed:
			// Landing within a notch of the newest event re-pins follow, which
			// is feedScroll's own rule and what g does from anywhere.
			m.feedScroll(len(m.feedEvents()), m.feedBudget(), delta)
			return m, nil
		case ModeBoard:
			// The list moves; the cursor stays on the session it is on.
			m.boardScroll(delta)
			return m, nil
		case ModeGrid:
			// One notch is one card row; the cursor stays on its card.
			if delta > 0 {
				m.gridScroll(1)
			} else {
				m.gridScroll(-1)
			}
			return m, nil
		}
	}
	m.scroll = clampInt(m.scroll+delta, 0, m.maxScroll(m.frame))
	return m, nil
}

// setMode is the one definition of switching mode, for the digits, tab and the
// tab strip alike.
func (m Model) setMode(mode Mode) (tea.Model, tea.Cmd) {
	was := m.mode
	m.mode, m.scroll = mode, 0
	// A half-made link belongs to the mode it was started in; leaving
	// abandons it rather than leaving its hint up over a mode that cannot
	// finish it. Pending connections are not a half-made link: they stay.
	m.linkFrom, m.dragFrom, m.gridDrag = "", "", gridDrag{}
	if was != mode {
		// An arm and a half-typed slot belong to the mode they were started in,
		// exactly as a half-made link does.
		m.disarm()
		m.leader = false
		if was == ModeHotkeys {
			m.hk.editor = hkEditor{}
		}
	}
	if mode == ModeHotkeys && was != ModeHotkeys {
		// Re-read on every entry rather than once: both files are hand-edited
		// and the band itself rewrites neither, so what is on disk now is the
		// only truth worth showing.
		return m, tea.Batch(m.spinCmd(), m.hkLoadCmd())
	}
	return m, m.spinCmd()
}

// onHkClick selects a slot row; a second click inside the double-click window
// opens its editor, which is what enter does.
func (m Model) onHkClick(i int) (tea.Model, tea.Cmd) {
	if i < 0 || i >= len(hotkeys.SlotKeys) {
		return m, nil
	}
	id := "hk:" + hotkeys.SlotKeys[i]
	at := m.nowFn()
	again := id == m.clickID && !m.clickAt.IsZero() && at.Sub(m.clickAt) < doubleClick
	m.clickID, m.clickAt = id, at
	// A click is not the confirming key, so it cancels an arm the way any
	// other key would.
	m.hk.row = i
	m.disarm()
	if again {
		return m.openHkEditor()
	}
	return m, nil
}

// focusHome points modes 1-3 back at this window's own session.
func (m Model) focusHome() (tea.Model, tea.Cmd) {
	m.focus = m.self
	m.scroll = 0
	// Refocusing swaps PASTE's session board out from under the cursor, so an
	// x arm over an entry on the old board is cancelled rather than left
	// showing a confirm for a row that is no longer on screen. The focus tag
	// reaches here by a click as well as by the 0 key, so this cannot lean on
	// the key path's own cancel.
	m.disarm()
	return m, nil
}
