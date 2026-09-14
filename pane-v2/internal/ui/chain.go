package ui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// chState is CHAIN's own state. The drawn rows are recomputed per frame from
// the relay mirror, so nothing here can disagree with what arrived. What
// outlives a frame is a block id rather than a row number: a merge or a new
// block moves every row under the cursor.
type chState struct {
	// cursor is the block under the cursor; "" means the newest drawn block.
	cursor string
	// expanded is the set of blocks drawing their summary under their row.
	expanded map[string]bool
	// full draws the cursor block turn by turn over the whole body; turn is
	// the turn cursor inside it, which is what a split cuts at.
	full bool
	turn int
	// hist is history mode. histAt indexes the fetched history; a value
	// outside it means the newest revision.
	hist   bool
	histAt int
	// detail is the full chain per session, detailRev the chain rev it was
	// read for, detailErr why the last read failed, and pending the rev of a
	// read still in flight. A session is read once per rev.
	detail    map[string]relay.ChainDetail
	detailRev map[string]int
	detailErr map[string]string
	pending   map[string]int
}

// chainDetailMsg carries a detail read back to the UI goroutine.
type chainDetailMsg struct {
	sessionID string
	rev       int
	detail    relay.ChainDetail
	err       error
}

// chRow is one drawn block. branch says it follows something other than the
// row directly above it -- a block whose parent IS that row sits flush.
type chRow struct {
	block  relay.ChainBlock
	branch bool
}

// cloneMap copies a map before a write, so a Model copy another caller still
// holds never sees the change.
func cloneMap[K comparable, V any](src map[K]V) map[K]V {
	out := make(map[K]V, len(src)+1)
	for k, v := range src {
		out[k] = v
	}
	return out
}

// chainPath is a chain route for a session, with the id escaped as one path
// segment.
func chainPath(sid, verb string) string {
	p := "/api/chain/" + url.PathEscape(sid)
	if verb != "" {
		p += "/" + verb
	}
	return p
}

// chChain is the focused session's id and compact chain. ok is false when no
// session is focused or it has no chain yet.
func (m Model) chChain() (string, relay.Chain, bool) {
	s, found := m.focusedOrLast()
	if !found {
		return "", relay.Chain{}, false
	}
	ch, ok := m.chains[s.ID]
	return s.ID, ch, ok
}

// chBlocks is the rows CHAIN draws, oldest first. A merged block is not drawn.
func (m Model) chBlocks() []chRow {
	_, ch, ok := m.chChain()
	if !ok {
		return nil
	}
	out := make([]chRow, 0, len(ch.Blocks))
	prev := ""
	for _, b := range ch.Blocks {
		if b.State == "merged" {
			continue
		}
		out = append(out, chRow{block: b, branch: b.Parent != "" && b.Parent != prev})
		prev = b.ID
	}
	return out
}

// chIndex is the row the cursor id names, or the newest row when the id is
// empty or its block has gone.
func chIndex(rows []chRow, id string) int {
	for i, r := range rows {
		if r.block.ID == id {
			return i
		}
	}
	return len(rows) - 1
}

// chCursor is the block id under the cursor, resolved against what is drawn.
func (m Model) chCursor() string {
	rows := m.chBlocks()
	if len(rows) == 0 {
		return ""
	}
	return rows[chIndex(rows, m.ch.cursor)].block.ID
}

// chDetailBlock finds a block in the full chain.
func chDetailBlock(d relay.ChainDetail, id string) (relay.ChainDetailBlock, bool) {
	for _, b := range d.Blocks {
		if b.ID == id {
			return b, true
		}
	}
	return relay.ChainDetailBlock{}, false
}

// chWantDetail marks a read of the focused chain's detail in flight and returns
// the command that performs it -- or nil when the detail for this rev is held
// or already on its way, so a session is never read twice for one rev.
func (m *Model) chWantDetail() tea.Cmd {
	sid, ch, ok := m.chChain()
	if !ok {
		return nil
	}
	if _, held := m.ch.detail[sid]; held && m.ch.detailRev[sid] == ch.Rev {
		return nil
	}
	if rev, inFlight := m.ch.pending[sid]; inFlight && rev == ch.Rev {
		return nil
	}
	m.ch.pending = cloneMap(m.ch.pending)
	m.ch.pending[sid] = ch.Rev
	return chFetchCmd(m.src, sid, ch.Rev)
}

// chFetchCmd reads one chain in full off the UI goroutine. Every failure --
// no credential, a dead relay, a non-200, a body that will not parse -- comes
// back as an error, never as an empty chain.
func chFetchCmd(src relay.Source, sid string, rev int) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		b, status, err := src.Get(ctx, chainPath(sid, ""))
		if err == nil && status != 200 {
			err = relayRefusal(b, status)
		}
		var d relay.ChainDetail
		if err == nil {
			d, err = relay.DecodeChainDetail(b)
		}
		return chainDetailMsg{sessionID: sid, rev: rev, detail: d, err: err}
	}
}

// relayRefusal turns a non-200 answer into the relay's own sentence when it
// sent one.
func relayRefusal(b []byte, status int) error {
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(b, &e) == nil && e.Error != "" {
		return fmt.Errorf("%s (http %d)", e.Error, status)
	}
	return fmt.Errorf("http %d", status)
}

// onChainDetail files a read's outcome under its session. A reply older than
// the detail already held, or than a read still in flight, is dropped: two
// reads can cross when the chain moves between them.
func (m Model) onChainDetail(msg chainDetailMsg) (tea.Model, tea.Cmd) {
	sid := msg.sessionID
	if rev, ok := m.ch.pending[sid]; ok {
		if rev > msg.rev {
			return m, nil
		}
		m.ch.pending = cloneMap(m.ch.pending)
		delete(m.ch.pending, sid)
	}
	if held, ok := m.ch.detailRev[sid]; ok && msg.rev < held {
		return m, nil
	}
	m.ch.detailErr = cloneMap(m.ch.detailErr)
	if msg.err != nil {
		m.ch.detailErr[sid] = msg.err.Error()
		return m, nil
	}
	delete(m.ch.detailErr, sid)
	m.ch.detail = cloneMap(m.ch.detail)
	m.ch.detail[sid] = msg.detail
	m.ch.detailRev = cloneMap(m.ch.detailRev)
	m.ch.detailRev[sid] = msg.rev
	return m, nil
}

// chPostAll sends one write per body, in order, and reports the first refusal.
func (m Model) chPostAll(sid, verb string, bodies []map[string]any, ok string) tea.Cmd {
	src, path := m.src, chainPath(sid, verb)
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for _, b := range bodies {
			if _, err := src.Post(ctx, path, b); err != nil {
				return postMsg{Err: err}
			}
		}
		return postMsg{OK: ok}
	}
}

// chLongPost is a write the relay answers only after a model call has run,
// which can outlast the pane's write timeout. A timeout is not a failure
// there: the relay carries on, and the chain event redraws the mode when the
// result lands. Any refusal the relay does send -- no binary, already refining
// -- is the toast.
func (m Model) chLongPost(sid, verb, ok, running string) tea.Cmd {
	src, path := m.src, chainPath(sid, verb)
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err := src.Post(ctx, path, map[string]any{})
		var ne net.Error
		if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
			return postMsg{OK: running}
		}
		if err != nil {
			return postMsg{Err: err}
		}
		return postMsg{OK: ok}
	}
}

// chainOwns reports whether a key is one of CHAIN's, so a key CHAIN cannot act
// on right now is swallowed rather than falling through to a global binding
// that means something else -- m is MINE and R is reconnect everywhere else.
func chainOwns(k ChainKeys, msg tea.KeyPressMsg) bool {
	return key.Matches(msg, k.Up, k.Down, k.NextBranch, k.PrevBranch, k.Open, k.Full,
		k.Collapse, k.Expand, k.Pin, k.PinBack, k.Merge, k.MergeNext, k.Split,
		k.Refine, k.Rebuild, k.History)
}

// onChainKey is CHAIN's keyboard. The bool says "handled", so anything this
// returns false for falls through to the global bindings.
func (m Model) onChainKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd, bool) {
	k := m.keys.Chain
	if m.ch.hist {
		return m.onChainHistKey(msg)
	}
	s, found := m.focusedOrLast()
	if m.chains == nil || !found {
		return m, nil, chainOwns(k, msg)
	}
	sid := s.ID

	// Refine and rebuild ask about the session, not a block, so they work on
	// a chain that has no blocks yet -- rebuild is how one gets filled.
	switch {
	case key.Matches(msg, k.Refine):
		return m, m.chLongPost(sid, "refine", "refined", "refining · the chain redraws when it lands"), true
	case key.Matches(msg, k.Rebuild):
		if m.isArmed("R", sid) {
			m.disarm()
			return m, m.chLongPost(sid, "rebuild", "rebuilt from the transcript",
				"rebuilding · the chain redraws when it lands"), true
		}
		return m, m.arm(Arm{
			Mode: ModeChain, Key: "R", Target: sid, NeedsRelay: true,
			Label: "REBUILD · discards pins and edits", Short: "REBUILD ?",
		}), true
	}

	rows := m.chBlocks()
	if len(rows) == 0 {
		return m, nil, chainOwns(k, msg)
	}
	i := chIndex(rows, m.ch.cursor)
	cur := rows[i].block
	m.ch.cursor = cur.ID

	if m.ch.full {
		if md, cmd, handled := m.onChainFullKey(msg, sid, cur); handled {
			return md, cmd, true
		}
	}

	switch {
	case key.Matches(msg, k.Down):
		m.ch.cursor, m.ch.turn = rows[clampInt(i+1, 0, len(rows)-1)].block.ID, 0
		return m, nil, true
	case key.Matches(msg, k.Up):
		m.ch.cursor, m.ch.turn = rows[clampInt(i-1, 0, len(rows)-1)].block.ID, 0
		return m, nil, true
	case key.Matches(msg, k.NextBranch):
		for j := i + 1; j < len(rows); j++ {
			if rows[j].branch {
				m.ch.cursor, m.ch.turn = rows[j].block.ID, 0
				break
			}
		}
		return m, nil, true
	case key.Matches(msg, k.PrevBranch):
		for j := i - 1; j >= 0; j-- {
			if rows[j].branch {
				m.ch.cursor, m.ch.turn = rows[j].block.ID, 0
				break
			}
		}
		return m, nil, true
	case key.Matches(msg, k.Open):
		exp := cloneMap(m.ch.expanded)
		if exp[cur.ID] {
			delete(exp, cur.ID)
			m.ch.expanded = exp
			return m, nil, true
		}
		exp[cur.ID] = true
		m.ch.expanded = exp
		return m, m.chWantDetail(), true
	case key.Matches(msg, k.Full):
		m.ch.full, m.ch.turn = true, 0
		return m, m.chWantDetail(), true
	case key.Matches(msg, k.Expand):
		exp := make(map[string]bool, len(rows))
		for _, r := range rows {
			exp[r.block.ID] = true
		}
		m.ch.expanded = exp
		return m, m.chWantDetail(), true
	case key.Matches(msg, k.Collapse):
		m.ch.expanded = nil
		return m, nil, true
	case key.Matches(msg, k.Pin):
		ok := "pinned · the refiner leaves it alone"
		if cur.Pinned {
			ok = "unpinned"
		}
		return m, m.chPostAll(sid, "pin",
			[]map[string]any{{"blockId": cur.ID, "pinned": !cur.Pinned}}, ok), true
	case key.Matches(msg, k.PinBack):
		if i == 0 {
			return m, m.setToast("nothing older than this block to pin", ToneInfo), true
		}
		bodies := make([]map[string]any, 0, i)
		for _, r := range rows[:i] {
			bodies = append(bodies, map[string]any{"blockId": r.block.ID, "pinned": true})
		}
		return m, m.chPostAll(sid, "pin", bodies, fmt.Sprintf("pinned %d older blocks", i)), true
	case key.Matches(msg, k.Merge):
		if i == 0 {
			return m, m.setToast("no block above to merge into", ToneInfo), true
		}
		return m.chMerge(sid, cur.ID, "m", "prev", "MERGE into the block above")
	case key.Matches(msg, k.MergeNext):
		if i == len(rows)-1 {
			return m, m.setToast("no block below to merge into", ToneInfo), true
		}
		return m.chMerge(sid, cur.ID, "M", "next", "MERGE into the block below")
	case key.Matches(msg, k.Split):
		return m, m.setToast("E opens the block · split at a turn from there", ToneInfo), true
	case key.Matches(msg, k.History):
		m.ch.hist, m.ch.histAt, m.ch.full = true, -1, false
		return m, m.chWantDetail(), true
	case key.Matches(msg, m.keys.Global.Esc):
		// Innermost first: an expanded block collapses before esc does its
		// global job.
		if len(m.ch.expanded) > 0 {
			m.ch.expanded = nil
			return m, nil, true
		}
	}
	return m, nil, false
}

// chMerge is the armed merge in either direction: the first press arms, and
// the same key again inside the window merges.
func (m Model) chMerge(sid, blockID, k, into, label string) (tea.Model, tea.Cmd, bool) {
	if m.isArmed(k, blockID) {
		m.disarm()
		return m, m.chPostAll(sid, "merge",
			[]map[string]any{{"blockId": blockID, "into": into}}, "merged"), true
	}
	return m, m.arm(Arm{
		Mode: ModeChain, Key: k, Target: blockID, NeedsRelay: true,
		Label: label, Short: "MERGE ?",
	}), true
}

// chTurnIDs is the cursor block's turn ids from the fetched detail.
func (m Model) chTurnIDs(sid, blockID string) []string {
	blk, ok := chDetailBlock(m.ch.detail[sid], blockID)
	if !ok {
		return nil
	}
	return blk.Turns
}

// onChainFullKey is the full view's own keys: j/k move between turns and s
// splits at the turn under the cursor. Everything else acts on the block as it
// does in the list.
func (m Model) onChainFullKey(msg tea.KeyPressMsg, sid string, cur relay.ChainBlock) (tea.Model, tea.Cmd, bool) {
	k := m.keys.Chain
	turns := m.chTurnIDs(sid, cur.ID)
	last := maxInt(0, len(turns)-1)
	switch {
	case key.Matches(msg, k.Down):
		m.ch.turn = clampInt(m.ch.turn+1, 0, last)
		return m, nil, true
	case key.Matches(msg, k.Up):
		m.ch.turn = clampInt(m.ch.turn-1, 0, last)
		return m, nil, true
	case key.Matches(msg, k.Full), key.Matches(msg, m.keys.Global.Esc):
		m.ch.full = false
		return m, nil, true
	case key.Matches(msg, k.Split):
		if len(turns) == 0 {
			return m, m.setToast("the turns have not loaded", ToneInfo), true
		}
		idx := clampInt(m.ch.turn, 0, last)
		if idx == 0 {
			// The cut starts a new block AT the turn, so the first turn would
			// leave the old block empty.
			return m, m.setToast("a split needs a turn before it · j to a later turn", ToneInfo), true
		}
		turn := turns[idx]
		target := cur.ID + " " + turn
		if m.isArmed("s", target) {
			m.disarm()
			return m, m.chPostAll(sid, "split",
				[]map[string]any{{"blockId": cur.ID, "atTurnId": turn}}, "split"), true
		}
		return m, m.arm(Arm{
			Mode: ModeChain, Key: "s", Target: target, NeedsRelay: true,
			Label: "SPLIT the block at this turn", Short: "SPLIT ?",
		}), true
	}
	return m, nil, false
}

// chHistory is the fetched revision list for the focused session.
func (m Model) chHistory() ([]relay.ChainRevision, bool) {
	s, found := m.focusedOrLast()
	if !found {
		return nil, false
	}
	d, ok := m.ch.detail[s.ID]
	return d.History, ok
}

// chHistAt is the revision history mode shows, clamped to a list of n.
func (m Model) chHistAt(n int) int {
	if m.ch.histAt < 0 || m.ch.histAt >= n {
		return n - 1
	}
	return m.ch.histAt
}

// onChainHistKey is history mode's keyboard. The mode is read-only, so every
// other key CHAIN owns is swallowed while it is up.
func (m Model) onChainHistKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd, bool) {
	k := m.keys.Chain
	hist, _ := m.chHistory()
	n := len(hist)
	at := m.chHistAt(n)
	switch {
	case key.Matches(msg, k.Collapse), key.Matches(msg, k.Down):
		m.ch.histAt = clampInt(at-1, 0, maxInt(0, n-1))
		return m, nil, true
	case key.Matches(msg, k.Expand), key.Matches(msg, k.Up):
		m.ch.histAt = clampInt(at+1, 0, maxInt(0, n-1))
		return m, nil, true
	case key.Matches(msg, k.History), key.Matches(msg, m.keys.Global.Esc):
		m.ch.hist = false
		return m, nil, true
	case key.Matches(msg, k.Open):
		// Leave on this revision's newest block, when that block still exists.
		m.ch.hist = false
		if n > 0 {
			rv := hist[at]
			for j := len(rv.Blocks) - 1; j >= 0; j-- {
				id := rv.Blocks[j].ID
				if rows := m.chBlocks(); len(rows) > 0 && rows[chIndex(rows, id)].block.ID == id {
					m.ch.cursor = id
					break
				}
			}
		}
		return m, nil, true
	}
	return m, nil, chainOwns(k, msg)
}

// chDuration is how long a block ran: to its end, or to now while it is open.
func (m Model) chDuration(b relay.ChainBlock) string {
	if b.StartedAt == 0 {
		return ""
	}
	end := m.now
	if b.EndedAt != 0 {
		end = b.EndedAt.Time()
	}
	d := end.Sub(b.StartedAt.Time())
	if d < 0 {
		return ""
	}
	return fmtx.AgoFine(d)
}

func plural(n int, one string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %ss", n, one)
}

func chTitle(t string) string {
	if strings.TrimSpace(t) == "" {
		return "untitled"
	}
	return t
}

// chWindow keeps the cursor block on screen: when the rows overrun the budget,
// the window slides just far enough to show the cursor block's first line and
// as much of the block as fits.
func chWindow(lines []string, curLine, span, budget int) []string {
	if budget <= 0 {
		return nil
	}
	if len(lines) <= budget {
		return lines
	}
	if span > budget {
		span = budget
	}
	top := maxInt(0, curLine+span-budget)
	top = minInt(top, len(lines)-budget)
	return lines[top : top+budget]
}

// viewChain draws the focused session's chain: one row per block down a spine,
// the expanded blocks' summaries under their rows, or the full view, or history.
func (m Model) viewChain(f Frame) []string {
	w := f.W
	s, found := m.focusedOrLast()
	if m.chains == nil {
		rows := []string{Head(w, "CHAIN", "", theme.SValue)}
		return append(rows, para(w,
			"relay predates chains · a relay that publishes them draws this session's topic chain here",
			3, theme.SDim)...)
	}
	if !found {
		return []string{Head(w, "CHAIN", "", theme.SValue)}
	}
	if m.ch.hist {
		return m.viewChainHistory(f, s.ID)
	}
	rows := m.chBlocks()
	if len(rows) == 0 {
		out := []string{Head(w, "CHAIN", "0 blocks", theme.SValue)}
		return append(out, para(w,
			"no blocks yet · each finished turn in this session adds to the chain, and R rebuilds it from the transcript",
			3, theme.SDim)...)
	}
	cur := chIndex(rows, m.ch.cursor)
	if m.ch.full {
		return m.viewChainFull(f, s.ID, rows[cur])
	}

	head := Head(w, "CHAIN", plural(len(rows), "block"), theme.SValue)
	var lines []string
	curLine, span := 0, 1
	for i, r := range rows {
		start := len(lines)
		lines = append(lines, m.chBlockRow(f, r, i == cur))
		if m.ch.expanded[r.block.ID] {
			lines = append(lines, m.chExpandedRows(f, s.ID, r)...)
		}
		if i == cur {
			curLine, span = start, len(lines)-start
		}
	}
	return append([]string{head}, chWindow(lines, curLine, span, m.bodyBudget(f)-1)...)
}

// chBlockRow is one block: the spine in column 2 -- a tee for a branch, which
// also indents the block two cells -- the state glyph, the title, and the
// pinned and branch marks at the right edge.
func (m Model) chBlockRow(f Frame, r chRow, selected bool) string {
	row := NewRow(f.W)
	spine, body, dim, accent := theme.SRule, theme.SBody, theme.SDim, theme.SWarn
	mark := " "
	if selected {
		row.Ground(theme.SCursor)
		spine, body, dim, accent = theme.SCursor, theme.SCursor, theme.SCursor, theme.SCursor
		mark = theme.GHere
	}
	row.Add(body, mark)
	if r.branch {
		row.Add(spine, theme.GBoxVR+theme.GRule+theme.GRule)
	} else {
		row.Add(spine, theme.GBoxV)
	}
	row.Add(body, " ")
	glyph, gst := theme.GOff, dim
	if r.block.State == "open" {
		glyph, gst = theme.GOn, accent
	}
	row.Add(gst, glyph)
	row.Add(body, " ")
	marks := ""
	if r.block.Pinned {
		marks += theme.GFlag
	}
	if r.branch {
		marks += theme.GBranch
	}
	reserve := 0
	if marks != "" {
		reserve = fmtx.W(marks) + 1
	}
	row.Add(body, fmtx.TruncRight(chTitle(r.block.Title), maxInt(0, row.Rest()-reserve)))
	if marks != "" {
		row.Right(dim, marks)
	}
	return row.String()
}

// chExpandedRows is what an expanded block draws under its row, keeping the
// spine: the summary once the detail has landed, a line saying where it is
// while it has not, and the block's counts either way.
func (m Model) chExpandedRows(f Frame, sid string, r chRow) []string {
	pad := "   "
	if r.branch {
		pad = "     "
	}
	width := maxInt(1, f.W-2-len(pad))
	var out []string
	add := func(st lipgloss.Style, text string) {
		row := NewRow(f.W)
		row.Add(theme.SBg, " ")
		row.Add(theme.SRule, theme.GBoxV)
		row.Add(theme.SBg, pad)
		row.Add(st, text)
		out = append(out, row.String())
	}
	det, has := m.ch.detail[sid]
	blk, found := chDetailBlock(det, r.block.ID)
	errText := m.ch.detailErr[sid]
	_, loading := m.ch.pending[sid]
	switch {
	case errText != "":
		for _, ln := range fmtx.Wrap("detail could not be read · "+errText, width, 2) {
			add(theme.SDim, ln)
		}
	case has && found && strings.TrimSpace(blk.Summary) != "":
		for _, ln := range fmtx.Wrap(blk.Summary, width, 3) {
			add(theme.SBody, ln)
		}
	case has && found:
		add(theme.SDim, fmtx.TruncRight("no summary yet · r asks the refiner", width))
	case loading:
		add(theme.SDim, fmtx.TruncRight("summary loading…", width))
	default:
		add(theme.SDim, fmtx.TruncRight("enter loads the summary", width))
	}
	parts := []string{plural(r.block.TurnCount, "turn")}
	if has && found {
		files := map[string]bool{}
		for _, id := range blk.Turns {
			for _, p := range det.Turns[id].Files {
				files[p] = true
			}
		}
		parts = append(parts, plural(len(files), "file"))
	}
	if d := m.chDuration(r.block); d != "" {
		parts = append(parts, d)
	}
	add(theme.SDim, fmtx.TruncRight(strings.Join(parts, " · "), width))
	return out
}

// viewChainFull draws one block turn by turn: each prompt head, then the
// answer's excerpt marked as its end, then the turn's files and duration.
func (m Model) viewChainFull(f Frame, sid string, r chRow) []string {
	w := f.W
	det := m.ch.detail[sid]
	blk, found := chDetailBlock(det, r.block.ID)
	right := plural(r.block.TurnCount, "turn")
	if found && len(blk.Turns) > 0 {
		right = fmt.Sprintf("turn %d/%d", clampInt(m.ch.turn, 0, len(blk.Turns)-1)+1, len(blk.Turns))
	}
	head := Head(w, "CHAIN", right, theme.SValue)
	lines := para(w, chTitle(r.block.Title), 2, theme.SName)
	if !found {
		_, loading := m.ch.pending[sid]
		switch {
		case m.ch.detailErr[sid] != "":
			lines = append(lines, para(w, "detail could not be read · "+m.ch.detailErr[sid], 2, theme.SDim)...)
		case loading:
			lines = append(lines, para(w, "turns loading…", 1, theme.SDim)...)
		default:
			lines = append(lines, para(w, "no turns recorded for this block", 1, theme.SDim)...)
		}
		return append([]string{head}, lines...)
	}
	cur := clampInt(m.ch.turn, 0, maxInt(0, len(blk.Turns)-1))
	curLine, span := 0, 1
	for i, id := range blk.Turns {
		t := det.Turns[id]
		start := len(lines)
		mark, mst := " ", theme.SBg
		if i == cur {
			mark, mst = theme.GHere, theme.SWarn
		}
		prompt := t.PromptHead
		if strings.TrimSpace(prompt) == "" {
			prompt = "no prompt recorded"
		}
		for j, ln := range fmtx.Wrap(prompt, maxInt(1, w-2), 2) {
			row := NewRow(w)
			if j == 0 {
				row.Add(mst, mark)
			} else {
				row.Add(theme.SBg, " ")
			}
			row.Add(theme.SBg, " ")
			row.Add(theme.SBody, ln)
			lines = append(lines, row.String())
		}
		if a := strings.TrimSpace(t.AnswerHead); a != "" {
			for j, ln := range fmtx.Wrap(a, maxInt(1, w-3), 2) {
				prefix := "  " + theme.GEllipsis
				if j > 0 {
					prefix = "   "
				}
				lines = append(lines, NewRow(w).Add(theme.SDim, prefix+ln).String())
			}
		}
		var meta []string
		if len(t.Files) > 0 {
			meta = append(meta, plural(len(t.Files), "file"))
		}
		if d := fmtx.Ms(int64(t.DurationMs)); d != "" {
			meta = append(meta, d)
		}
		if len(meta) > 0 {
			lines = append(lines, NewRow(w).Add(theme.SDim, "  "+strings.Join(meta, " · ")).String())
		}
		if i == cur {
			curLine, span = start, len(lines)-start
		}
	}
	return append([]string{head}, chWindow(lines, curLine, span, m.bodyBudget(f)-1)...)
}

// viewChainHistory draws the chain as it stood at one revision: titles and
// states only, since that is all a revision keeps.
func (m Model) viewChainHistory(f Frame, sid string) []string {
	w := f.W
	det, has := m.ch.detail[sid]
	if !has {
		head := Head(w, "CHAIN", "history", theme.SValue)
		_, loading := m.ch.pending[sid]
		switch {
		case m.ch.detailErr[sid] != "":
			return append([]string{head}, para(w, "history could not be read · "+m.ch.detailErr[sid], 2, theme.SDim)...)
		case loading:
			return append([]string{head}, para(w, "history loading… · t or esc leaves", 2, theme.SDim)...)
		default:
			return append([]string{head}, para(w, "no history read yet · t or esc leaves", 2, theme.SDim)...)
		}
	}
	n := len(det.History)
	if n == 0 {
		head := Head(w, "CHAIN", "history", theme.SValue)
		return append([]string{head}, para(w,
			"no revisions yet · one is kept each time a refinement or an edit reshapes the chain · t or esc leaves",
			3, theme.SDim)...)
	}
	at := m.chHistAt(n)
	rv := det.History[at]
	right := fmt.Sprintf("rev %d · %s", rv.Rev, fmtx.Ago(m.now.Sub(rv.At.Time())))
	rows := []string{Head(w, "CHAIN", right, theme.SValue)}
	for _, b := range rv.Blocks {
		if b.State == "merged" {
			continue
		}
		row := NewRow(w)
		row.Add(theme.SBg, " ")
		row.Add(theme.SRule, theme.GBoxV)
		row.Add(theme.SBg, " ")
		glyph, gst := theme.GOff, theme.SDim
		if b.State == "open" {
			glyph, gst = theme.GOn, theme.SWarn
		}
		row.Add(gst, glyph)
		row.Add(theme.SBg, " ")
		row.Add(theme.SBody, chTitle(b.Title))
		rows = append(rows, row.String())
	}
	rows = append(rows, para(w, fmt.Sprintf("revision %d of %d · h/l steps · esc leaves", at+1, n), 1, theme.SDim)...)
	return rows
}

// chLastRow is CHAIN's claim on the last row: a paused refiner first, then the
// mode's key hints. With no write credential it steps aside for the read-only
// notice, since every hint here is a write.
func (m Model) chLastRow(f Frame) string {
	row := NewRow(f.W)
	if _, ch, ok := m.chChain(); m.chains != nil && ok && ch.Refiner.Paused {
		row.Add(theme.SWarn, "refiner paused")
		row.Add(theme.SDim, fmtx.TruncRight(" · p m s t · R rebuild", row.Rest()))
		return row.String()
	}
	if m.cfg.ReadOnly {
		return ""
	}
	var text string
	switch {
	case m.ch.hist:
		text = fitJoin(f.W, "h/l revision", "enter jump", "esc leave")
	case m.ch.full:
		text = fitJoin(f.W, "j/k turn", "s split", "esc back")
	case f.BP == BPL:
		text = fitJoin(f.W, "p pin", "m merge", "s split", "r refine", "t history", "R rebuild", "enter open", "E full")
	default:
		// R rebuilds inside CHAIN and reconnects everywhere else, so it is
		// named here rather than left to the global help.
		text = fitJoin(f.W, "p m s r t", "R rebuild", "enter open", "E full")
	}
	row.Add(theme.SLabel, fmtx.TruncRight(text, row.Rest()))
	return row.String()
}
