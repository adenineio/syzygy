package ui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

const (
	gridCardMin  = 20 // narrowest card: a 17-character name fits
	gridCardMax  = 30
	gridCardH    = 3
	gridPitch    = 4 // three rows of box, one row of gap
	gridPendMax  = 9 // badges are one digit; the form is at most 18 rows
	gridPendRows = 4 // pending rows drawn under the PENDING head
)

// gridConn is one pending connection: from briefs to, with a note.
type gridConn struct{ From, To, Note string }

// gridDrag is the pointer during a press, in frame coordinates. Moved is set
// by the first motion frame, which is what separates a drag from a click.
type gridDrag struct {
	X, Y  int
	Moved bool
}

// gridLayout is how GRID's body budget is divided. Everything that needs a
// card's position reads it, so a hitbox cannot drift from the card it is over.
type gridLayout struct {
	Cols, CardW      int
	CanvasY, CanvasH int // body-relative first row of the canvas, and its height
	Rows             int // card rows the canvas can show
	PendingH         int // rows under the PENDING head
}

func gridLayoutFor(f Frame, budget, pending int) gridLayout {
	cols := clampInt((f.W+1)/(gridCardMin+1), 1, 4)
	cardW := minInt(gridCardMax, (f.W-(cols-1))/cols)
	pendH := minInt(pending, gridPendRows)
	canvasH := maxInt(0, budget-2-pendH) // the GRID head and the PENDING head
	return gridLayout{
		Cols: cols, CardW: cardW,
		CanvasY: 1, CanvasH: canvasH,
		Rows:     (canvasH + 1) / gridPitch,
		PendingH: pendH,
	}
}

// gridRect is a rectangle in canvas coordinates.
type gridRect struct{ X, Y, W, H int }

func (r gridRect) contains(x, y int) bool {
	return x >= r.X && x < r.X+r.W && y >= r.Y && y < r.Y+r.H
}

// cardRect is where card i sits when card row top is the first one shown.
func (l gridLayout) cardRect(i, top int) (gridRect, bool) {
	if l.Cols <= 0 || i < 0 {
		return gridRect{}, false
	}
	row, col := i/l.Cols, i%l.Cols
	if row < top || row >= top+l.Rows {
		return gridRect{}, false
	}
	return gridRect{X: col * (l.CardW + 1), Y: (row - top) * gridPitch, W: l.CardW, H: gridCardH}, true
}

func (m Model) gridLayout() gridLayout {
	f := m.frame
	return gridLayoutFor(f, m.bodyBudget(f), len(m.pending))
}

// gridCursorIndex resolves the cursor's id to a card, falling back to the
// first card when its session has gone, as BOARD's does.
func (m Model) gridCursorIndex() int {
	if len(m.sessions) == 0 {
		return -1
	}
	for i, s := range m.sessions {
		if s.ID == m.gridCursorID {
			return i
		}
	}
	return 0
}

func (m Model) gridRowCount(lay gridLayout) int {
	if lay.Cols <= 0 {
		return 0
	}
	return (len(m.sessions) + lay.Cols - 1) / lay.Cols
}

func (m Model) gridTopRow(lay gridLayout) int {
	return clampInt(m.gridTop, 0, maxInt(0, m.gridRowCount(lay)-lay.Rows))
}

func (m *Model) gridMove(delta int) {
	if len(m.sessions) == 0 {
		return
	}
	m.gridCursorID = m.sessions[clampInt(m.gridCursorIndex()+delta, 0, len(m.sessions)-1)].ID
	m.gridReveal()
}

func (m *Model) gridReveal() {
	lay := m.gridLayout()
	c := m.gridCursorIndex()
	if lay.Rows <= 0 || lay.Cols <= 0 || c < 0 {
		return
	}
	row := c / lay.Cols
	top := m.gridTopRow(lay)
	if row < top {
		top = row
	}
	if row > top+lay.Rows-1 {
		top = row - lay.Rows + 1
	}
	m.gridTop = clampInt(top, 0, maxInt(0, m.gridRowCount(lay)-lay.Rows))
}

func (m *Model) gridScroll(delta int) {
	lay := m.gridLayout()
	m.gridTop = clampInt(m.gridTop+delta, 0, maxInt(0, m.gridRowCount(lay)-lay.Rows))
}

// gridName is the session's name with every rune that does not measure one
// column replaced, so the canvas and TruncRight agree about its width.
func gridName(s relay.Session) string {
	var b strings.Builder
	for _, r := range s.Name {
		if fmtx.W(string(r)) == 1 {
			b.WriteRune(r)
		} else {
			b.WriteByte('?')
		}
	}
	if b.Len() == 0 {
		return shortID(s.ID)
	}
	return b.String()
}

func (m Model) gridHeadRight() (string, lipgloss.Style) {
	if m.gridBatch {
		return "BATCH · b", theme.SLink
	}
	return "b batch", theme.SDim
}

func (m Model) gridPendingRight(f Frame) (string, lipgloss.Style) {
	if len(m.pending) > 0 {
		return "enter · u undo", theme.SLink
	}
	if f.BP == BPL {
		return "drag a card's " + theme.GGrip + " onto another", theme.SDim
	}
	return "drag " + theme.GGrip + " to a card", theme.SDim
}

// viewGrid is mode 5: the GRID head, the canvas of cards, the PENDING panel.
func (m Model) viewGrid(f Frame, stale bool, budget int) []string {
	lay := gridLayoutFor(f, budget, len(m.pending))
	rows := make([]string, 0, budget)
	right, rs := m.gridHeadRight()
	rows = append(rows, Head(f.W, fmt.Sprintf("GRID %d", len(m.sessions)), right, rs))

	c := newCanvas(f.W, lay.CanvasH)
	top := m.gridTopRow(lay)
	cursor := m.gridCursorIndex()
	hover := m.gridHoverID()
	for i, s := range m.sessions {
		r, ok := lay.cardRect(i, top)
		if !ok {
			continue
		}
		hot := s.ID == m.linkFrom || s.ID == m.dragFrom
		m.gridCard(c, r, s, i == cursor, hot, s.ID == hover, stale)
	}
	m.gridDrawDrag(c, lay, f)
	rows = append(rows, c.rows()...)
	rows = append(rows, m.gridPendingRows(f, lay)...)
	if len(rows) > budget {
		rows = rows[:budget]
	}
	return rows
}

// gridCard draws one card: row A the name, row B the vitals, row C the grip
// and the badges. cursor and target reverse row A; hot colours the name
// yellow.
func (m Model) gridCard(c *canvas, r gridRect, s relay.Session, cursor, hot, target, stale bool) {
	in := r.W - 2

	// ---- row A --------------------------------------------------------
	boxA, nameSt := gsBox, gsName
	if s.ID == m.self {
		nameSt = gsNameSelf
	}
	if hot {
		nameSt = gsNameHot
	}
	markSt := boxA
	mark := theme.GRule
	if s.ID == m.self {
		mark, markSt = theme.GHere, gsNameSelf
	}
	if cursor || target {
		boxA, nameSt, markSt = gsNameTarget, gsNameTarget, gsNameTarget
	}
	name := fmtx.TruncRight(gridName(s), in-1)
	c.put(r.X, r.Y, theme.GBoxTL, boxA)
	c.put(r.X+1, r.Y, mark, markSt)
	c.text(r.X+2, r.Y, name, nameSt)
	c.hline(r.X+2+fmtx.W(name), r.Y, in-1-fmtx.W(name), theme.GRule, boxA)
	c.put(r.X+r.W-1, r.Y, theme.GBoxTR, boxA)

	// ---- row B --------------------------------------------------------
	y := r.Y + 1
	c.put(r.X, y, theme.GBoxV, gsBox)
	glyph, gst := theme.GOff, gsOff
	switch {
	case stale:
		glyph = theme.GConn
	case s.Working:
		glyph, gst = theme.GOn, gsOn
	}
	c.put(r.X+1, y, glyph, gst)
	frac := s.CtxFrac()
	pst := gsPctLow
	switch {
	case stale:
		pst = gsDim
	case frac >= 0.85:
		pst = gsPctHigh
	case frac >= 0.65:
		pst = gsPctMid
	}
	c.text(r.X+3, y, fmt.Sprintf("%3s", fmtx.Pct(frac)), pst)
	modelW := in - 10
	c.text(r.X+7, y, padTo(fmtx.TruncRight(s.Model, modelW), modelW), gsDim)
	c.text(r.X+7+modelW, y, fmt.Sprintf("%4s", fmtx.Ago(m.now.Sub(s.SeenAt.Time()))), gsDim)
	c.put(r.X+r.W-1, y, theme.GBoxV, gsBox)

	// ---- row C --------------------------------------------------------
	y = r.Y + 2
	c.put(r.X, y, theme.GBoxBL, gsBox)
	c.hline(r.X+1, y, in, theme.GRule, gsBox)
	c.put(r.X+r.W-1, y, theme.GBoxBR, gsBox)
	// The grip is the one cell a drag can start from (see gridRegions). Dim:
	// it is an affordance, not data.
	c.put(r.X+1, y, theme.GGrip, gsDim)
	c.text(r.X+2, y, fmtx.TruncRight(m.gridBadges(s.ID), in-2), gsLink)
}

// gridBadges is "1→" for every pending connection the session sends and "→1"
// for every one it receives, in pending order.
func (m Model) gridBadges(id string) string {
	var parts []string
	for i, p := range m.pending {
		if p.From == id {
			parts = append(parts, fmt.Sprintf("%d%s", i+1, theme.GArrow))
		}
		if p.To == id {
			parts = append(parts, fmt.Sprintf("%s%d", theme.GArrow, i+1))
		}
	}
	return strings.Join(parts, " ")
}

// gridPendingRows is the PENDING head and up to gridPendRows rows.
func (m Model) gridPendingRows(f Frame, lay gridLayout) []string {
	right, rs := m.gridPendingRight(f)
	rows := []string{Head(f.W, fmt.Sprintf("PENDING %d", len(m.pending)), right, rs)}
	for i := 0; i < len(m.pending) && i < lay.PendingH; i++ {
		p := m.pending[i]
		r := NewRow(f.W)
		r.Add(theme.SDim, fmt.Sprintf(" %d ", i+1))
		r.Add(theme.SLink, fmtx.TruncRight(m.sessionName(p.From), maxInt(3, (r.Rest()-11)/2)))
		r.Add(theme.SDim, " "+theme.GArrow+" ")
		r.Add(theme.SLink, fmtx.TruncRight(m.sessionName(p.To), maxInt(3, r.Rest()-8)))
		if p.Note != "" {
			r.Right(theme.SWarn, theme.GNote)
		} else {
			r.Right(theme.SDim, "no note")
		}
		rows = append(rows, r.String())
	}
	if extra := len(m.pending) - lay.PendingH; extra > 0 && lay.PendingH > 0 {
		rows[len(rows)-1] = NewRow(f.W).Add(theme.SDim, fmt.Sprintf(" +%d more", extra+1)).String()
	}
	return rows
}

// gridRegions gives every visible card a hit region the size of its box, and
// the two head buttons the width of their right-hand value. The strings are
// the ones the renderer draws, from the same functions.
func (m Model) gridRegions(f Frame, regs []region) []region {
	lay := m.gridLayout()
	top := m.gridTopRow(lay)
	y0 := f.HeaderRows + lay.CanvasY
	for i := range m.sessions {
		r, ok := lay.cardRect(i, top)
		if !ok {
			continue
		}
		regs = addRegion(regs, f, region{X: r.X, Y: y0 + r.Y, W: r.W, H: r.H, Act: actGridCard, Index: i})
		// The grip is registered after the card so the topmost rule puts it
		// on top. It is one cell on purpose: a drag that could start anywhere
		// on the box would fire whenever someone reached for a text selection
		// and forgot the shift. Do not widen it.
		regs = addRegion(regs, f, region{X: r.X + 1, Y: y0 + r.Y + 2, W: 1, H: 1, Act: actGridGrip, Index: i})
	}
	if right, _ := m.gridHeadRight(); right != "" {
		w := fmtx.W(right)
		regs = addRegion(regs, f, region{X: f.W - w, Y: f.HeaderRows, W: w, H: 1, Act: actGridBatch})
	}
	if len(m.pending) > 0 {
		right, _ := m.gridPendingRight(f)
		w := fmtx.W(right)
		regs = addRegion(regs, f, region{X: f.W - w, Y: y0 + lay.CanvasH, W: w, H: 1, Act: actGridNotes})
	}
	return regs
}

func (m Model) hasSession(id string) bool {
	for _, s := range m.sessions {
		if s.ID == id {
			return true
		}
	}
	return false
}

// onGridClick is a press on a card's body. It moves the cursor and does the
// click's own work -- land the armed source on it, disarm it if it is the
// armed one, focus it on a double-click -- but it never arms and never starts
// a drag: a body press is where a text selection would start.
func (m Model) onGridClick(i int) (tea.Model, tea.Cmd) {
	if i < 0 || i >= len(m.sessions) {
		return m, nil
	}
	id := m.sessions[i].ID
	at := m.nowFn()
	again := id == m.clickID && !m.clickAt.IsZero() && at.Sub(m.clickAt) < doubleClick
	m.clickID, m.clickAt = id, at
	m.gridCursorID = id
	m.gridReveal()
	switch {
	case m.linkFrom == "":
		if again {
			return m.gridFocus(i)
		}
		return m, nil
	case m.linkFrom == id:
		m.linkFrom = ""
		if again {
			return m.gridFocus(i)
		}
		return m, nil
	default:
		return m.gridLand(m.linkFrom, id)
	}
}

// onGridGrip is a press on a card's grip: the only press that arms and starts
// a drag. It moves the cursor and never counts toward a double-click.
func (m Model) onGridGrip(i, x, y int) (tea.Model, tea.Cmd) {
	if i < 0 || i >= len(m.sessions) {
		return m, nil
	}
	id := m.sessions[i].ID
	m.clickID, m.clickAt = "", time.Time{}
	m.gridCursorID = id
	m.gridReveal()
	m.linkFrom, m.dragFrom = id, id
	m.gridDrag = gridDrag{X: x, Y: y}
	return m, nil
}

// gridFocus points modes 1-3 at a card's session, as BOARD's enter does.
func (m Model) gridFocus(i int) (tea.Model, tea.Cmd) {
	if i < 0 || i >= len(m.sessions) {
		return m, nil
	}
	m.focus = m.sessions[i].ID
	m.scroll = 0
	m.rememberFocus()
	return m, m.spinCmd()
}

// gridLink is the l key: arm the cursor's card, then land on another.
func (m Model) gridLink() (tea.Model, tea.Cmd) {
	i := m.gridCursorIndex()
	if i < 0 {
		return m, nil
	}
	id := m.sessions[i].ID
	if m.linkFrom == "" {
		m.linkFrom = id
		return m, nil
	}
	if m.linkFrom == id {
		return m, nil
	}
	return m.gridLand(m.linkFrom, id)
}

// gridLand queues from -> to. Either way it joins pending; with batch off the
// notes form opens on it at once, with batch on it waits for enter. A pair
// already pending is replaced rather than queued twice.
func (m Model) gridLand(from, to string) (tea.Model, tea.Cmd) {
	m.linkFrom, m.dragFrom, m.gridDrag = "", "", gridDrag{}
	if from == "" || to == "" || from == to {
		return m, nil
	}
	if !m.hasSession(from) || !m.hasSession(to) {
		return m, m.setToast("session gone", ToneErr)
	}
	kept := make([]gridConn, 0, len(m.pending)+1)
	for _, p := range m.pending {
		if !(p.From == from && p.To == to) {
			kept = append(kept, p)
		}
	}
	if len(kept) >= gridPendMax {
		return m, m.setToast(fmt.Sprintf("%d pending is the cap · enter to note them", gridPendMax), ToneErr)
	}
	m.pending = append(kept, gridConn{From: from, To: to})
	if !m.gridBatch {
		return m.openGridForm()
	}
	return m, m.setToast(fmt.Sprintf("%d pending · enter to note", len(m.pending)), ToneInfo)
}

// gridUndo drops the last pending connection. The slice is copied rather than
// resliced so an older copy of the model never sees the change.
func (m *Model) gridUndo() {
	if n := len(m.pending); n > 0 {
		m.pending = append([]gridConn(nil), m.pending[:n-1]...)
	}
}

// gridSendCmd posts every connection in order inside one command, so the
// outcome is one toast. A failure stops the run and says how far it got.
func (m Model) gridSendCmd(conns []gridConn) tea.Cmd {
	src := m.src
	return func() tea.Msg {
		sent := 0
		for _, c := range conns {
			body := map[string]any{"from": c.From, "to": c.To, "kind": "brief"}
			if c.Note != "" {
				body["note"] = c.Note
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_, err := src.Post(ctx, "/api/link", body)
			cancel()
			if err != nil {
				return postMsg{Err: fmt.Errorf("%d of %d queued · %w", sent, len(conns), err)}
			}
			sent++
		}
		if sent == 1 {
			return postMsg{OK: "brief queued"}
		}
		return postMsg{OK: fmt.Sprintf("%d briefs queued", sent)}
	}
}

// gridHoverID is the card under the pointer during a moved drag, if it is not
// the source. It is what the renderer highlights and the line avoids.
func (m Model) gridHoverID() string {
	if m.mode != ModeGrid || m.dragFrom == "" || !m.gridDrag.Moved {
		return ""
	}
	r, ok := hitAt(m.regions(), m.gridDrag.X, m.gridDrag.Y)
	if !ok || (r.Act != actGridCard && r.Act != actGridGrip) || r.Index >= len(m.sessions) {
		return ""
	}
	if id := m.sessions[r.Index].ID; id != m.dragFrom {
		return id
	}
	return ""
}

// gridDrawDrag draws the braille line from the source card's centre to the
// pointer, skipping the source's and the hovered target's own cells.
func (m Model) gridDrawDrag(c *canvas, lay gridLayout, f Frame) {
	if m.dragFrom == "" || !m.gridDrag.Moved {
		return
	}
	top := m.gridTopRow(lay)
	var src, tgt gridRect
	hasSrc, hasTgt := false, false
	hover := m.gridHoverID()
	for i, s := range m.sessions {
		if s.ID == m.dragFrom {
			src, hasSrc = lay.cardRect(i, top)
		}
		if hover != "" && s.ID == hover {
			tgt, hasTgt = lay.cardRect(i, top)
		}
	}
	if !hasSrc {
		return
	}
	px, py := m.gridDrag.X, m.gridDrag.Y-f.HeaderRows-lay.CanvasY
	c.line(src.X+src.W/2, src.Y+1, px, py, gsLink, func(x, y int) bool {
		return src.contains(x, y) || (hasTgt && tgt.contains(x, y))
	})
}

// gridLinkHint is the last row while a source is armed or a drag is moving.
func (m Model) gridLinkHint(f Frame) string {
	if m.linkFrom == "" && m.dragFrom == "" {
		return ""
	}
	from := m.linkFrom
	if from == "" {
		from = m.dragFrom
	}
	tail := "click a card or l · esc"
	if m.gridDrag.Moved {
		tail = "drop · esc"
	}
	text := fmt.Sprintf("LINK %s %s ? · %s", m.sessionName(from), theme.GArrow, tail)
	if f.BP == BPS {
		text = "LINK " + theme.GArrow + " ? · " + tail
	}
	r := NewRow(f.W)
	r.Add(theme.STick, theme.GTick)
	r.Add(theme.SWarn, fmtx.TruncRight(text, r.Rest()))
	return r.String()
}
