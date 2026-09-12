// Package ident answers the one genuinely hard question the pane has: which
// live relay session is *this* tmux window's Claude?
//
// The key fact that makes it solvable is that the relay's session.pid is the
// Claude Code process itself (registerSession runs `sh -c 'echo $PPID'`), and
// tmux knows each pane's first process as #{pane_pid}. Claude is a descendant
// of that shell -- a child when launched directly, a grandchild when launched
// through a wrapper. So the session whose pid is a descendant of the target
// pane's pane_pid is this window's Claude.
package ident

import (
	"sort"
	"strings"

	"github.com/adenineio/syzygy/pane-v2/internal/relay"
)

// Method records how the pane decided, so the header can always tell the user
// whether the pane is sure.
type Method int

const (
	// None is UNPINNED: the pane could not decide and will not guess.
	None Method = iota
	// Flag is --session / SZG_SESSION. Always wins.
	Flag
	// PaneTree is the primary mechanism: pane_pid descendant walk.
	PaneTree
	// Ambiguous is PaneTree with more than one hit (a nested launch); the
	// newest session wins and the header says AMBIG.
	Ambiguous
	// SessionsIndex is a corroborating hit from ~/.claude/sessions/<pid>.json.
	SessionsIndex
	// Cwd is the unique-working-directory fallback, used outside tmux.
	Cwd
	// Picked is a user choice made on the board's UNPINNED banner.
	Picked
)

// Tag is the small grey marker shown after the session name at M and L.
// PaneTree is silent: it is the expected case.
func (m Method) Tag() string {
	switch m {
	case Flag:
		return "FLAG"
	case Ambiguous:
		return "AMBIG"
	case SessionsIndex:
		return "IDX"
	case Cwd:
		return "CWD"
	case Picked:
		return "PICKED"
	default:
		return ""
	}
}

func (m Method) String() string {
	switch m {
	case Flag:
		return "flag"
	case PaneTree:
		return "pane-tree"
	case Ambiguous:
		return "pane-tree-ambiguous"
	case SessionsIndex:
		return "sessions-index"
	case Cwd:
		return "cwd"
	case Picked:
		return "picked"
	default:
		return "none"
	}
}

// Result is what a resolution attempt produced.
type Result struct {
	// ID is the resolved session id, empty when UNPINNED.
	ID string
	// How records the path that fired.
	How Method
	// Expected is a session id the pane knows should appear but which has not
	// registered with the relay yet. It turns "no sessions" into
	// "waiting for <name> (<id>) to join the board".
	Expected     string
	ExpectedName string
	// Note carries a one-line explanation for the debug log.
	Note string
	Err  error
}

// Resolver produces a Result from the current live session list.
type Resolver interface {
	Resolve(live []relay.Session) Result
}

// matchByIDOrPrefix finds a session by exact id or by a unique prefix.
func matchByIDOrPrefix(live []relay.Session, want string) (string, bool, bool) {
	if want == "" {
		return "", false, false
	}
	for _, s := range live {
		if s.ID == want {
			return s.ID, true, false
		}
	}
	var hits []string
	for _, s := range live {
		if strings.HasPrefix(s.ID, want) {
			hits = append(hits, s.ID)
		}
	}
	switch len(hits) {
	case 0:
		return "", false, false
	case 1:
		return hits[0], true, false
	default:
		return "", false, true // ambiguous prefix
	}
}

// newest returns the session with the latest startedAt.
func newest(in []relay.Session) relay.Session {
	out := in[0]
	for _, s := range in[1:] {
		if s.StartedAt > out.StartedAt {
			out = s
		}
	}
	return out
}

// sortedIDs is a stable helper for the tests.
func sortedIDs(in []relay.Session) []string {
	ids := make([]string, 0, len(in))
	for _, s := range in {
		ids = append(ids, s.ID)
	}
	sort.Strings(ids)
	return ids
}
