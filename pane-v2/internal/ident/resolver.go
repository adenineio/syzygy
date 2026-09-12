package ident

import (
	"fmt"

	"github.com/adenineio/syzygy/pane-v2/internal/relay"
)

// Config is everything the resolver learns from flags, environment and the
// process it runs in.
type Config struct {
	// SessionFlag is --session / SZG_SESSION: an id or a unique prefix.
	SessionFlag string
	// TargetPane is --target-pane / SZG_TARGET_PANE, the *origin* pane id that
	// the launcher recorded -- the pane where Claude runs.
	TargetPane string
	// TargetPid is SZG_TARGET_PID, the origin pane's shell pid. It lets the
	// pane skip a tmux exec, and it still works if the pane id has changed.
	TargetPid int
	// SelfPane is $TMUX_PANE, this pane. Used to find siblings when the pane
	// was started by hand with no --target-pane.
	SelfPane string
	// Cwd is this pane's working directory (the launcher passes -c "$PWD").
	Cwd string
}

// Deps are the injectable side effects, so the resolver is table-testable
// without tmux, without ps and without a home directory.
type Deps struct {
	Tmux  Tmux
	Procs ProcTable
	Index Index
}

// PaneResolver implements the pane-identification ladder.
type PaneResolver struct {
	Cfg  Config
	Deps Deps
	// MaxDepth bounds the descendant walk.
	MaxDepth int
}

// New builds a resolver with the real tmux, ps and sessions index.
func New(cfg Config) *PaneResolver {
	return &PaneResolver{
		Cfg: cfg,
		Deps: Deps{
			Tmux:  RealTmux{},
			Procs: NewPSTable(),
			Index: DefaultIndex(),
		},
		MaxDepth: 8,
	}
}

// Resolve runs the ladder:
//
//  1. --session / SZG_SESSION, exact or unique prefix. Always wins.
//  2. the target pane's process tree: pane_pid -> ps descendants -> session pid.
//  3. Claude Code's own sessions index, which yields an `expected` id.
//  4. a unique cwd match, only outside tmux or when the tree found nothing.
//  5. UNPINNED -- never a guess.
func (r *PaneResolver) Resolve(live []relay.Session) Result {
	// ---- 1. the flag ------------------------------------------------------
	if want := r.Cfg.SessionFlag; want != "" {
		id, ok, ambiguous := matchByIDOrPrefix(live, want)
		switch {
		case ok:
			return Result{ID: id, How: Flag, Note: "session flag matched " + want}
		case ambiguous:
			return Result{How: None, Note: "session flag " + want + " matches more than one session"}
		default:
			// The flag names a session that has not registered yet. Wait for
			// it rather than falling through to a guess.
			return Result{How: None, Expected: want, Note: "waiting for flagged session " + want}
		}
	}

	// ---- 2. the pane's process tree ---------------------------------------
	roots, note := r.paneRoots()
	var desc map[int]bool
	if len(roots) > 0 {
		table, err := r.Deps.Procs.Table()
		if err == nil && len(table) > 0 {
			desc = Descendants(table, roots, r.maxDepth())
			var hits []relay.Session
			for _, s := range live {
				if pid := s.ParsedPid(); pid > 0 && desc[pid] {
					hits = append(hits, s)
				}
			}
			switch len(hits) {
			case 1:
				return Result{ID: hits[0].ID, How: PaneTree, Note: note}
			case 0:
				// fall through to the index / cwd
			default:
				// Two Claudes under one pane is a nested launch; the newer one
				// is almost certainly the one in front.
				n := newest(hits)
				return Result{
					ID:   n.ID,
					How:  Ambiguous,
					Note: fmt.Sprintf("%d sessions under the pane tree (%v); newest wins", len(hits), sortedIDs(hits)),
				}
			}
		} else if err != nil {
			note = fmt.Sprintf("%s; ps failed: %v", note, err)
		}
	}

	// ---- 3. Claude Code's own pid index -----------------------------------
	if len(desc) > 0 && r.Deps.Index != nil {
		for pid := range desc {
			e, ok := r.Deps.Index.Lookup(pid)
			if !ok {
				continue
			}
			// If the relay already knows that id, the tree walk would have
			// found it; this branch means the plugin has not registered yet.
			if id, ok2, _ := matchByIDOrPrefix(live, e.SessionID); ok2 {
				return Result{ID: id, How: SessionsIndex, Note: "sessions index hit for pid " + fmt.Sprint(pid)}
			}
			name := e.Name
			if name == "" {
				name = baseName(e.Cwd)
			}
			return Result{
				How:          None,
				Expected:     e.SessionID,
				ExpectedName: name,
				Note:         fmt.Sprintf("sessions index names %s (pid %d), not on the board yet", e.SessionID, pid),
			}
		}
	}

	// ---- 4. cwd, only when the tree yielded nothing -----------------------
	if r.Cfg.Cwd != "" {
		var hits []relay.Session
		for _, s := range live {
			if s.Cwd == r.Cfg.Cwd {
				hits = append(hits, s)
			}
		}
		if len(hits) == 1 {
			return Result{ID: hits[0].ID, How: Cwd, Note: "unique cwd match"}
		}
		if len(hits) > 1 {
			// Two sessions in one directory is the normal situation on a busy
			// machine. Never a guess.
			return Result{How: None, Note: fmt.Sprintf("%d sessions share cwd %s", len(hits), r.Cfg.Cwd)}
		}
	}

	// ---- 5. UNPINNED ------------------------------------------------------
	if note == "" {
		note = "no tmux target, no index hint, no unique cwd"
	}
	return Result{How: None, Note: note}
}

func (r *PaneResolver) maxDepth() int {
	if r.MaxDepth <= 0 {
		return 8
	}
	return r.MaxDepth
}

// paneRoots collects the pane pids to walk down from, in order of
// preference: the explicit target pid, the target pane, then every *other*
// pane in this window.
func (r *PaneResolver) paneRoots() ([]int, string) {
	if r.Cfg.TargetPid > 0 {
		return []int{r.Cfg.TargetPid}, fmt.Sprintf("target pid %d", r.Cfg.TargetPid)
	}
	tm := r.Deps.Tmux
	if tm == nil || !tm.Inside() {
		return nil, "not inside tmux"
	}
	if r.Cfg.TargetPane != "" {
		if pid, err := tm.PanePid(r.Cfg.TargetPane); err == nil && pid > 0 {
			return []int{pid}, "target pane " + r.Cfg.TargetPane
		}
		return nil, "target pane " + r.Cfg.TargetPane + " has no pid"
	}
	panes, err := tm.SiblingPanes(r.Cfg.SelfPane)
	if err != nil || len(panes) == 0 {
		return nil, "no sibling panes"
	}
	roots := make([]int, 0, len(panes))
	for _, p := range panes {
		if p.Pid > 0 {
			roots = append(roots, p.Pid)
		}
	}
	return roots, fmt.Sprintf("%d sibling pane(s)", len(roots))
}

func baseName(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' {
			return path[i+1:]
		}
	}
	return path
}

// Static is a resolver that always returns a fixed result. Tests use it; so
// does the --session path once the id is known.
type Static struct{ R Result }

// Resolve implements Resolver.
func (s Static) Resolve([]relay.Session) Result { return s.R }
