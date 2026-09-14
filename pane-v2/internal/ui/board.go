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

// boardBarW is the width of a session row's mini context bar: ten cells of the
// same glyphs and the same thresholds as the full-width bar.
const boardBarW = 10

// boardLayout is how BOARD's body budget is divided. The key handler, the
// wheel, the renderer and the hit regions all read it, so a row's y and the
// height of the viewport are one fact rather than four.
type boardLayout struct {
	ListY   int // body-relative row of the first session row
	ListH   int // session rows the viewport can show
	DetailH int // rows under the DETAIL head
	LinksH  int // rows under the LINKS head
}

// boardLayoutFor allocates budget rows across the three panels. What a reader
// can spare first goes first: the detail's tail (the sparkline, then the
// counts), then a second link row, and only then rows off the session list --
// the list is what the mode is for.
func boardLayoutFor(f Frame, budget, sessions, links int) boardLayout {
	detail := 4
	if f.BP == BPL && f.Spark {
		detail = 5
	}
	linkRows := clampInt(links, 1, 3)
	list := maxInt(sessions, 1)

	// Three section heads: SESSIONS, DETAIL, LINKS.
	over := func() int { return 3 + list + detail + linkRows - budget }
	shave := func(v *int, floor int) {
		for over() > 0 && *v > floor {
			*v--
		}
	}
	shave(&detail, 2)
	shave(&linkRows, 1)
	shave(&list, 1)
	shave(&detail, 0)
	shave(&linkRows, 0)

	return boardLayout{
		ListY:   1,
		ListH:   minInt(sessions, list),
		DetailH: detail,
		LinksH:  linkRows,
	}
}

// boardListH is how many session rows are on screen. Everything that needs the
// viewport's height asks this one function; FEED carries a recorded finding
// from two places computing it separately.
func (m Model) boardListH() int {
	f := m.frame
	return boardLayoutFor(f, m.bodyBudget(f), len(m.sessions), len(m.focusLinks())).ListH
}

// boardCursorIndex is the row the cursor is on. The cursor holds the session
// it is on rather than the row it was on, so a session exiting above it moves
// the row without moving the cursor -- which is what keeps enter and the
// second l press aimed at the agent the reader is looking at. A cursor whose
// own session has gone falls back to the top of the list.
func (m Model) boardCursorIndex() int {
	if len(m.sessions) == 0 {
		return -1
	}
	for i, s := range m.sessions {
		if s.ID == m.cursorID {
			return i
		}
	}
	return 0
}

// boardTopIndex is the first session row drawn, clamped so the viewport can
// neither run off the end nor leave blank rows under the last session.
func (m Model) boardTopIndex(listH int) int {
	return clampInt(m.boardTop, 0, maxInt(0, len(m.sessions)-listH))
}

// boardSession is the session the cursor is on, which is what DETAIL draws.
// With no live session left there is still the last known copy of the pinned
// one: stale data stays on screen rather than the panel blanking.
func (m Model) boardSession() (relay.Session, bool) {
	if i := m.boardCursorIndex(); i >= 0 {
		return m.sessions[i], true
	}
	return m.focusedOrLast()
}

// boardMove walks the cursor and scrolls the list the least it can to keep it
// on screen.
func (m *Model) boardMove(delta int) {
	if len(m.sessions) == 0 {
		return
	}
	m.cursorID = m.sessions[clampInt(m.boardCursorIndex()+delta, 0, len(m.sessions)-1)].ID
	m.boardReveal()
}

// boardReveal brings the cursor back into the viewport.
func (m *Model) boardReveal() {
	h := m.boardListH()
	if h <= 0 {
		return
	}
	c := m.boardCursorIndex()
	if c < 0 {
		return
	}
	top := m.boardTopIndex(h)
	if c < top {
		top = c
	}
	if c > top+h-1 {
		top = c - h + 1
	}
	m.boardTop = clampInt(top, 0, maxInt(0, len(m.sessions)-h))
}

// boardScroll is the wheel's path: it moves the list under the cursor and
// leaves the cursor where it is.
func (m *Model) boardScroll(delta int) {
	m.boardTop = clampInt(m.boardTop+delta, 0, maxInt(0, len(m.sessions)-m.boardListH()))
}

// focusLinks is every link the focused session is an end of.
func (m Model) focusLinks() []relay.Link {
	s, ok := m.focusedOrLast()
	if !ok {
		return nil
	}
	return m.linksFor(s.ID)
}

func (m Model) linksFor(id string) []relay.Link {
	out := make([]relay.Link, 0, len(m.links))
	for _, l := range m.links {
		if l.From == id || l.To == id {
			out = append(out, l)
		}
	}
	return out
}

// sessionName resolves an id for the LINKS panel and the link hint, falling
// back to the short id for a session that has already gone.
func (m Model) sessionName(id string) string {
	for _, s := range m.sessions {
		if s.ID == id {
			return s.Name
		}
	}
	if m.hadFocus && m.lastFocused.ID == id {
		return m.lastFocused.Name
	}
	return shortID(id)
}

// viewBoard is mode 4, the switchboard: every session in the relay's order,
// a detail block for the cursor's, and the focused session's links.
func (m Model) viewBoard(f Frame, stale bool, budget int) []string {
	links := m.focusLinks()
	lay := boardLayoutFor(f, budget, len(m.sessions), len(links))
	rows := make([]string, 0, budget)

	// ---- SESSIONS --------------------------------------------------------
	right := ""
	if f.BP >= BPM && m.viewers > 0 {
		right = fmt.Sprintf("%d viewer", m.viewers)
		if m.viewers != 1 {
			right += "s"
		}
	}
	rows = append(rows, Head(f.W, fmt.Sprintf("SESSIONS %d", len(m.sessions)), right, theme.SDim))
	top := m.boardTopIndex(lay.ListH)
	cursor := m.boardCursorIndex()
	for i := top; i < len(m.sessions) && i < top+lay.ListH; i++ {
		rows = append(rows, m.boardRow(f, m.sessions[i], i == cursor, stale))
	}

	// ---- DETAIL ----------------------------------------------------------
	// The name goes in the head's right-hand value slot rather than beside the
	// label: a panel head's label is uppercase by grammar and a
	// session name is not, so it sits where FEED puts its follow indicator.
	s, ok := m.boardSession()
	name := ""
	if ok && f.BP >= BPM {
		name = fmtx.TruncRight(s.Name, maxInt(0, f.W/2))
	}
	rows = append(rows, Head(f.W, "DETAIL", name, theme.SName))
	if ok {
		rows = append(rows, m.boardDetail(f, s, stale, lay.DetailH)...)
	}

	// ---- LINKS -----------------------------------------------------------
	rows = append(rows, Head(f.W, fmt.Sprintf("LINKS %d", len(links)), "", theme.SDim))
	rows = append(rows, m.boardLinks(f, links, lay.LinksH)...)

	// BOARD fills its own budget, which is what lets the hit regions map a
	// row to a session by arithmetic: with nothing for scrollBody to window,
	// the body's first row is always the frame's first body row.
	if len(rows) > budget {
		rows = rows[:budget]
	}
	return rows
}

// boardRow is one session: the drag grip, the here marker and the working
// glyph in separate cells so every fact reads, the name, and whatever columns
// the width affords.
func (m Model) boardRow(f Frame, s relay.Session, cursor, stale bool) string {
	r := NewRow(f.W)

	// The cursor row is reverse video rather than a background: the pane
	// paints no background at all, so the highlight is the terminal's own
	// inverse. That costs the row its threshold colours, which is why the
	// glyphs -- the bar's fill against its remainder -- still carry the fact.
	st := func(x lipgloss.Style) lipgloss.Style { return x }
	if cursor {
		r.Ground(theme.SCursor)
		st = func(lipgloss.Style) lipgloss.Style { return theme.SCursor }
	}

	// The grip is the browser pane's glyph and its idea: the drag starts here
	// and nowhere else, so it has to be visible. Dim, because it is an
	// affordance rather than data, and it must not compete with the marker and
	// the status dot beside it.
	r.Add(st(theme.SDim), theme.GGrip)

	here, hs := " ", theme.SBg
	if s.ID == m.self {
		here, hs = theme.GHere, theme.SValue
	}
	glyph, gs := theme.GOff, theme.SDim
	switch {
	case s.NeedsNow() != "" && !stale:
		// Needs-me outranks working: a session parked on a question has
		// finished its turn, and where the two disagree the urgent one wins.
		glyph, gs = theme.GFlag, theme.SWarn
	case s.Working && !stale:
		glyph, gs = theme.GOn, theme.SWarn
	}
	r.Add(st(hs), here)
	r.Add(st(gs), glyph)
	r.Add(st(theme.SBg), " ")

	frac := s.CtxFrac()
	pctStyle := theme.On(theme.CtxColor(frac))
	if stale {
		pctStyle = theme.SDim
	}

	// Reserve the right-hand columns, then give the name what is left.
	var reserve int
	switch f.BP {
	case BPL:
		reserve = 10 + 2 + boardBarW + 5 + 9 + 4 // model, bar, pct, spend, age
	case BPM:
		reserve = 10 + 5 + 5 // model, pct, age
	default:
		reserve = 5 + 6 // pct, age
	}
	nameW := r.Rest() - reserve
	if nameW < 6 {
		nameW = maxInt(3, r.Rest()/2)
	}
	r.Add(st(theme.SName), padTo(fmtx.TruncRight(s.Name, nameW), nameW))

	if f.BP >= BPM {
		r.Add(st(theme.SDim), "  "+padTo(fmtx.TruncRight(s.Model, 8), 8))
	}
	if f.BP == BPL {
		r.Add(st(theme.SBg), "  ")
		full := BarFill(boardBarW, frac)
		r.Add(st(pctStyle), strings.Repeat(theme.GBarFull, full))
		r.Add(st(theme.SRule), strings.Repeat(theme.GBarEmpty, boardBarW-full))
	}
	r.Add(st(pctStyle), fmt.Sprintf("%5s", fmtx.Pct(frac)))
	if f.BP == BPL {
		r.Add(st(dimIf(theme.SValue, stale)), fmt.Sprintf("%9s", fmtx.Money(s.Stats.Spend)))
	}
	r.Right(st(theme.SDim), fmtx.Ago(m.now.Sub(s.SeenAt.Time())))
	return r.String()
}

// boardDetail is the cursor's session in full, cut to n rows. The order is
// what a reader gives up last first, because a short pane keeps only the head
// of this list.
func (m Model) boardDetail(f Frame, s relay.Session, stale bool, n int) []string {
	if n <= 0 {
		return nil
	}
	w := f.W
	body := dimIf(theme.SBody, stale)
	var rows []string

	// --- identity ---
	r := NewRow(w)
	r.Add(theme.SBg, " ")
	switch f.BP {
	case BPL:
		r.Add(theme.SLabel, "id ")
		r.Add(body, shortID(s.ID))
		r.Add(theme.SLabel, "   pid ")
		r.Add(body, s.Pid)
		r.Add(theme.SLabel, "   agent ")
		r.Add(body, s.AgentName)
		r.Add(theme.SLabel, "   ")
		r.Add(body, theme.GBranch+" "+boardBranch(s))
	case BPM:
		r.Add(body, shortID(s.ID))
		r.Add(theme.SDim, " · pid ")
		r.Add(body, s.Pid)
		r.Add(theme.SDim, " · ")
		r.Add(body, s.AgentName)
		r.Add(theme.SDim, " · ")
		r.Add(dimIf(theme.SValue, stale), fmtx.Money(s.Stats.Spend))
	default:
		r.Add(body, shortID(s.ID))
		r.Add(theme.SDim, " · ")
		r.Add(body, fmtx.TruncRight(s.Model, 8))
		r.Add(theme.SDim, " · ")
		r.Add(dimIf(theme.SValue, stale), fmtx.Money(s.Stats.Spend))
	}
	rows = append(rows, r.String())

	// --- cwd, shortened from the left so the leaf survives ---
	r = NewRow(w)
	r.Add(theme.SBg, " ")
	if f.BP == BPL {
		r.Add(theme.SLabel, "cwd ")
	}
	r.Add(theme.SDim, fmtx.TruncLeft(s.Cwd, r.Rest()))
	rows = append(rows, r.String())

	// --- the narration line ---
	r = NewRow(w)
	r.Add(theme.SBg, " ")
	r.Add(body, fmtx.TruncRight(feedFlat(s.Status), r.Rest()))
	rows = append(rows, r.String())

	// What it is waiting for, when it is waiting for anything. Its own row
	// rather than a column: the sentence is the useful part.
	if need := s.NeedsNow(); need != "" {
		r = NewRow(w)
		r.Add(theme.SBg, " ")
		r.Add(theme.SWarn, theme.GFlag+" ")
		r.Add(dimIf(theme.SWarn, stale), fmtx.TruncRight(feedFlat(need), r.Rest()))
		rows = append(rows, r.String())
	}

	// --- counts ---
	seen := fmtx.Ago(m.now.Sub(s.SeenAt.Time()))
	counts := fmt.Sprintf("agents %d · links %d", len(s.Agents), len(m.linksFor(s.ID)))
	switch f.BP {
	case BPL:
		counts += fmt.Sprintf(" · tools %d · guard %d · seen %s ago",
			s.Stats.Tools, s.Stats.Guardrails, seen)
	case BPM:
		counts += " · seen " + seen
	default:
		counts += " · " + seen
	}
	r = NewRow(w)
	r.Add(theme.SBg, " ")
	r.Add(theme.SDim, fmtx.TruncRight(counts, r.Rest()))
	rows = append(rows, r.String())

	// --- the sparkline, at L only ---
	if f.BP == BPL {
		vals := make([]int64, 0, len(s.Series))
		for _, p := range s.Series {
			vals = append(vals, p.Tokens)
		}
		r = NewRow(w)
		r.Add(theme.SBg, " ")
		if stale {
			r.Fill(theme.SDim, theme.GRule, r.Rest())
		} else {
			r.b.WriteString(Spark(r.Rest(), vals))
			r.used = w
		}
		rows = append(rows, r.String())
	}

	if len(rows) > n {
		rows = rows[:n]
	}
	return rows
}

// boardLinks is the focused session's links, and the empty state that says how
// to make one.
func (m Model) boardLinks(f Frame, links []relay.Link, n int) []string {
	if n <= 0 {
		return nil
	}
	if len(links) == 0 {
		switch f.BP {
		case BPL:
			return []string{NewRow(f.W).
				Add(theme.SBg, " ").
				Add(theme.SDim, "none · l on a row links the focused session to it").
				String()}
		case BPM:
			return []string{NewRow(f.W).Add(theme.SBg, " ").Add(theme.SDim, "none").String()}
		default:
			return []string{Blank(f.W)}
		}
	}
	rows := make([]string, 0, n)
	for i := 0; i < len(links) && i < n; i++ {
		l := links[i]
		r := NewRow(f.W)
		r.Add(theme.SBg, " ")
		r.Add(theme.SLink, fmtx.TruncRight(m.sessionName(l.From), maxInt(3, (r.Rest()-3)/2)))
		r.Add(theme.SDim, " "+theme.GArrow+" ")
		r.Add(theme.SLink, fmtx.TruncRight(m.sessionName(l.To), r.Rest()))
		if f.BP == BPL {
			r.Right(theme.SDim, l.Kind)
		}
		rows = append(rows, r.String())
	}
	if extra := len(links) - len(rows); extra > 0 && len(rows) > 0 {
		rows[len(rows)-1] = NewRow(f.W).Add(theme.SDim, fmt.Sprintf(" +%d more", extra+1)).String()
	}
	return rows
}

func boardBranch(s relay.Session) string {
	if s.Branch != nil && *s.Branch != "" {
		return *s.Branch
	}
	return "—"
}

// boardRegions gives every visible session row a full-width hit region for the
// click and the double-click, and its leading grip cell a second, narrower one
// on top for the drag.
//
// The drag is confined to the grip on purpose. Press-move-release over a row is
// the same gesture a terminal uses to select text, so a whole-row drag would
// brief another agent whenever someone reached for a selection and forgot the
// shift that hands selection back while mouse reporting is on -- with a toast
// as the only notice and nothing to undo it. Do not widen this back to the row.
func (m Model) boardRegions(f Frame, regs []region) []region {
	lay := boardLayoutFor(f, m.bodyBudget(f), len(m.sessions), len(m.focusLinks()))
	// BOARD's body always fits its budget, so the generic body offset is zero
	// here and the list's own offset is the only one in play.
	y := f.HeaderRows + lay.ListY
	top := m.boardTopIndex(lay.ListH)
	for i := top; i < len(m.sessions) && i < top+lay.ListH; i++ {
		regs = addRegion(regs, f, region{
			X: 0, Y: y + (i - top), W: f.W, H: 1, Act: actBoardRow, Index: i,
		})
		// Registered after the row, so the topmost rule puts the grip on top
		// of it. Below 30 columns no region is registered at all and BOARD
		// draws no rows, so there is no width at which the grip is invisible
		// and the drag is live.
		regs = addRegion(regs, f, region{
			X: 0, Y: y + (i - top), W: 1, H: 1, Act: actBoardGrip, Index: i,
		})
	}
	return regs
}

// doubleClick is how close two clicks on the same row must fall to read as
// one double-click. Terminals report presses, not click counts, so the pane
// counts them itself.
const doubleClick = 400 * time.Millisecond

// onBoardClick moves the cursor to a row. A second click on the same row
// inside the double-click window focuses that session, which is what enter
// does; the press is also remembered so that a release on another row reads
// as the drag that links them.
func (m Model) onBoardClick(i int) (tea.Model, tea.Cmd) {
	if i < 0 || i >= len(m.sessions) {
		return m, nil
	}
	id := m.sessions[i].ID
	at := m.nowFn()
	again := id == m.clickID && !m.clickAt.IsZero() && at.Sub(m.clickAt) < doubleClick
	m.clickID, m.clickAt = id, at
	m.cursorID = id
	m.boardReveal()
	if again {
		return m.boardFocus()
	}
	return m, nil
}

// onBoardGrip starts a link drag. It moves the cursor as any press on the row
// does, but it is the only press that arms a drag, and it never counts toward
// a double-click: the grip is for dragging.
func (m Model) onBoardGrip(i int) (tea.Model, tea.Cmd) {
	if i < 0 || i >= len(m.sessions) {
		return m, nil
	}
	m.dragFrom = m.sessions[i].ID
	m.clickID, m.clickAt = "", time.Time{}
	m.cursorID = m.sessions[i].ID
	m.boardReveal()
	return m, nil
}

// boardFocus points modes 1-3 at the cursor's session.
func (m Model) boardFocus() (tea.Model, tea.Cmd) {
	s, ok := m.boardSession()
	if !ok {
		return m, nil
	}
	m.focus = s.ID
	m.scroll = 0
	m.rememberFocus()
	return m, m.spinCmd()
}

// boardJump puts the user in front of the cursor session's own terminal.
//
// The case is decided here, from what the relay already reported, rather than
// by posting and reading the answer: two of the four cases are completed by a
// command this pane cannot run, and a toast that said "jumping" for them would
// be a lie.
func (m Model) boardJump() (tea.Model, tea.Cmd) {
	s, ok := m.boardSession()
	if !ok {
		return m, nil
	}
	switch s.Jump {
	case "tmux", "background":
		return m, m.postCmd("/api/jump", map[string]any{"id": s.ID}, "jumping to "+s.Name)
	case "resume":
		return m, m.setToast("resume: that process is gone — the browser drawer has the command", ToneErr)
	case "outside":
		return m, m.setToast("outside tmux — the browser drawer has the command", ToneErr)
	default:
		return m, m.setToast("nothing to jump to yet", ToneErr)
	}
}

// boardKill is the x key: arm on the cursor's session, then close it. The
// strip names the mechanism the relay will use, from what the session IS.
func (m Model) boardKill() (tea.Model, tea.Cmd) {
	s, ok := m.boardSession()
	if !ok {
		return m, nil
	}
	_, what, can := s.KillPlan()
	if !can {
		return m, m.setToast(what, ToneErr)
	}
	if m.isArmed("x", s.ID) {
		m.disarm()
		return m, m.postCmd("/api/session/kill", map[string]any{"id": s.ID}, "session closed")
	}
	return m, m.arm(Arm{
		Mode: ModeBoard, Key: "x", Target: s.ID, NeedsRelay: true,
		Label: "KILL " + s.Name + " · " + what,
		Short: "KILL " + shortID(s.ID),
	})
}

// boardKillAgents is the X key: every subagent of the cursor's session, as one
// named action. Which agent is a choice the drawer makes, where the list is
// actually drawn; here there is no agent cursor to make it with.
func (m Model) boardKillAgents() (tea.Model, tea.Cmd) {
	s, ok := m.boardSession()
	if !ok {
		return m, nil
	}
	if len(s.Agents) == 0 {
		return m, m.setToast("no subagents on "+s.Name, ToneErr)
	}
	if m.isArmed("X", s.ID) {
		m.disarm()
		return m, m.killAgentsCmd(s.ID, s.Agents)
	}
	return m, m.arm(Arm{
		Mode: ModeBoard, Key: "X", Target: s.ID, NeedsRelay: true,
		Label: fmt.Sprintf("KILL %d SUBAGENTS of %s", len(s.Agents), s.Name),
		Short: fmt.Sprintf("KILL %d AGENTS", len(s.Agents)),
	})
}

// killAgentsCmd posts one command per agent, in order, inside one command so
// the outcome is one toast. A failure stops the run and says how far it got.
func (m Model) killAgentsCmd(id string, agents []relay.Agent) tea.Cmd {
	src := m.src
	return func() tea.Msg {
		sent := 0
		for _, a := range agents {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_, err := src.Post(ctx, "/api/command", map[string]any{
				"targetId": id, "verb": "kill-agent", "payload": map[string]any{"agentId": a.ID},
			})
			cancel()
			if err != nil {
				return postMsg{Err: fmt.Errorf("%d of %d killed · %w", sent, len(agents), err)}
			}
			sent++
		}
		return postMsg{OK: fmt.Sprintf("%d killed", sent)}
	}
}

// boardLink is the l key. The first press marks the focused session as the
// briefing's sender and puts the hint up; the second, on another row, queues
// it.
func (m Model) boardLink() (tea.Model, tea.Cmd) {
	cur, ok := m.boardSession()
	if !ok {
		return m, nil
	}
	if m.linkFrom == "" {
		s, ok := m.focusedOrLast()
		if !ok {
			return m, nil
		}
		m.linkFrom = s.ID
		return m, nil
	}
	if m.linkFrom == cur.ID {
		// A link needs two different sessions; the hint stays up saying so.
		return m, nil
	}
	return m.sendLink(m.linkFrom, cur.ID)
}

// linkDrag is the drag gesture: a press on one session released on another.
// from is the session the press was over, which is why a list that moved in
// between cannot send the briefing to the wrong agent.
func (m Model) linkDrag(from string, to int) (tea.Model, tea.Cmd) {
	if from == "" || to < 0 || to >= len(m.sessions) {
		return m, nil
	}
	dest := m.sessions[to].ID
	if dest == from {
		return m, nil
	}
	return m.sendLink(from, dest)
}

// sendLink queues the briefing. The relay turns it into the send-message verb
// on the sender's own plugin, which is where the browser pane's
// drag-to-brief gesture already goes.
func (m Model) sendLink(from, to string) (tea.Model, tea.Cmd) {
	m.linkFrom = ""
	return m, m.postCmd("/api/link", map[string]any{
		"from": from, "to": to, "kind": "brief",
	}, "link queued")
}

// boardLinkHint is the row the l key puts up while it waits for its second
// press. It is not the armed strip: nothing here is destructive, so it is
// yellow text rather than the black-on-yellow block.
func (m Model) boardLinkHint(f Frame) string {
	if m.linkFrom == "" {
		return ""
	}
	text := fmt.Sprintf("LINK %s %s ? · move and press l · esc",
		m.sessionName(m.linkFrom), theme.GArrow)
	if f.BP == BPS {
		text = "LINK " + theme.GArrow + " ? · l · esc"
	}
	r := NewRow(f.W)
	r.Add(theme.STick, theme.GTick)
	r.Add(theme.SWarn, fmtx.TruncRight(text, r.Rest()))
	return r.String()
}
