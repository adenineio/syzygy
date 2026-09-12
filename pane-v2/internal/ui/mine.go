package ui

import (
	"fmt"
	"strings"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// mineEmptyMsg is what MINE says when this session has claimed nothing: it
// names the tool that fixes it, rather than leaving a blank panel.
const mineEmptyMsg = "nothing claimed yet -- run claim_work to pick something up"

// mineEffort is one claimed plan's progress row. CurrentItem is the plan's
// currently-active step, already resolved to text bridge-side
// (tasks-efforts.mjs's currentItemText) -- empty when the plan has no
// unchecked step (finished, empty, or a stale currentItemId).
type mineEffort struct {
	Title       string
	Done, Total int
	CurrentItem string
}

// mineSection is one claimed backlog heading.
type mineSection struct {
	Text string
}

// claimedByID reports whether sessionID is among cs. Matching is by ID only
// -- never by name, cwd or anything else that merely looks like this session
// -- which is what keeps this safe from the trap below:
// `/api/register` stores a session's raw, possibly-subdirectory root, while
// the claims file on disk is keyed by the resolved worktree root, so those
// two never reliably agree. A claim's id and this session's own id (from
// ident) are the one pair of values both sides mean the same thing by.
func claimedByID(cs []relay.Claimer, sessionID string) bool {
	if sessionID == "" {
		return false
	}
	for _, c := range cs {
		if c.ID == sessionID {
			return true
		}
	}
	return false
}

// mineClaims filters the payload down to sessionID's own claims: its plans
// (efforts[].claimedBy) and its claimed backlog sections
// (worktrees[].tasks[].items[].claimedBy, kind=="section" only -- a claimed
// step is not a section and is not shown here). Folded across every project
// the relay reports, since a session's claim is scoped to a worktree, not to
// whichever project happens to be listed first.
func mineClaims(st relay.State, sessionID string) (efforts []mineEffort, sections []mineSection) {
	for _, proj := range st.Projects {
		for _, e := range proj.Efforts {
			if claimedByID(e.ClaimedBy, sessionID) {
				efforts = append(efforts, mineEffort{
					Title: e.Title, Done: e.Done, Total: e.Total, CurrentItem: e.CurrentItem,
				})
			}
		}
		for _, w := range proj.Worktrees {
			for _, tf := range w.Tasks {
				for _, it := range tf.Items {
					if it.Kind == "section" && claimedByID(it.ClaimedBy, sessionID) {
						sections = append(sections, mineSection{Text: it.Text})
					}
				}
			}
		}
	}
	return efforts, sections
}

// renderMine is the pure, testable core of the MINE view: sessionID's
// claimed plans (as "title  done/total", each followed by its current step
// when the plan has one) and its claimed backlog sections, one per line.
// viewMine wraps this same data into styled frame rows; this form exists so
// the filter itself is checkable without a Frame.
func renderMine(st relay.State, sessionID string) string {
	efforts, sections := mineClaims(st, sessionID)
	var lines []string
	for _, e := range efforts {
		lines = append(lines, fmt.Sprintf("%s  %d/%d", e.Title, e.Done, e.Total))
		if e.CurrentItem != "" {
			lines = append(lines, "  "+e.CurrentItem)
		}
	}
	for _, s := range sections {
		lines = append(lines, s.Text)
	}
	if len(lines) == 0 {
		return mineEmptyMsg
	}
	return strings.Join(lines, "\n")
}

// viewMine is MINE's renderer: this session's own claims, filtered by the id
// ident already resolved (m.self) -- never by m.focused()'s session, since
// MINE is about this window's own session regardless of what BOARD/GRID has
// focused elsewhere.
func (m Model) viewMine(f Frame) []string {
	w := f.W
	efforts, sections := mineClaims(relay.State{Projects: m.projects}, m.self)
	rows := []string{Head(w, "MINE", "", theme.SLabel)}

	if len(efforts) == 0 && len(sections) == 0 {
		rows = append(rows, para(w, mineEmptyMsg, 2, theme.SDim)...)
		return rows
	}

	if len(efforts) > 0 {
		rows = append(rows, Head(w, fmt.Sprintf("PLANS %d", len(efforts)), "", theme.SLabel))
		for _, e := range efforts {
			r := NewRow(w)
			r.Add(theme.SBg, " ")
			prog := fmt.Sprintf("%d/%d", e.Done, e.Total)
			r.Add(theme.SBody, fmtx.TruncRight(e.Title, maxInt(1, r.Rest()-fmtx.W(prog)-1)))
			r.Right(theme.SValue, prog)
			rows = append(rows, r.String())
			if e.CurrentItem != "" {
				cr := NewRow(w)
				cr.Add(theme.SBg, "   ")
				cr.Add(theme.SDim, fmtx.TruncRight("→ "+e.CurrentItem, cr.Rest()))
				rows = append(rows, cr.String())
			}
		}
	}

	if len(sections) > 0 {
		rows = append(rows, Head(w, fmt.Sprintf("BACKLOG %d", len(sections)), "", theme.SLabel))
		for _, s := range sections {
			rows = append(rows, para(w, s.Text, 1, theme.SBody)...)
		}
	}

	return rows
}
