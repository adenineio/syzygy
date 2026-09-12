// Package relay mirrors the Syzygy relay's read model and provides
// the SSE client and the token-authed POST helper.
package relay

import (
	"encoding/json"
	"strconv"
	"time"
)

// Millis decodes a millisecond epoch that the relay may send as a number or,
// for pid-adjacent fields, as a numeric string.
type Millis int64

func (m *Millis) UnmarshalJSON(b []byte) error {
	if len(b) == 0 || string(b) == "null" {
		*m = 0
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		if s == "" {
			*m = 0
			return nil
		}
		v, err := strconv.ParseFloat(s, 64)
		if err != nil {
			*m = 0
			return nil
		}
		*m = Millis(v)
		return nil
	}
	var f float64
	if err := json.Unmarshal(b, &f); err != nil {
		*m = 0
		return nil
	}
	*m = Millis(f)
	return nil
}

// Time converts to a wall clock time; the zero epoch stays the zero time.
func (m Millis) Time() time.Time {
	if m == 0 {
		return time.Time{}
	}
	return time.UnixMilli(int64(m))
}

// Diff is the working-tree line delta.
type Diff struct {
	Added   int `json:"added"`
	Removed int `json:"removed"`
}

// Stats is the session's numeric vitals.
type Stats struct {
	Ctx        int64   `json:"ctx"`
	CtxLimit   int64   `json:"ctxLimit"`
	Spend      float64 `json:"spend"`
	Tools      int     `json:"tools"`
	Guardrails int     `json:"guardrails"`
	Errors     int     `json:"errors"`
	Diff       Diff    `json:"diff"`
}

// Agent is one subagent under a session.
type Agent struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Type        string `json:"type"`
	Status      string `json:"status"`
}

// Point is one sample of the session's series.
type Point struct {
	T      Millis  `json:"t"`
	Tokens int64   `json:"tokens"`
	Spend  float64 `json:"spend"`
	Ctx    int64   `json:"ctx"`
}

// Spin is what the Claude Code UI's spinner is doing right now: the engine's
// mode, the word it is showing, and which of the plugin's spinners is selected.
// A session that predates this field, or that has not rendered a Spinner yet,
// sends nothing -- so it is a pointer and every reader must tolerate nil.
type Spin struct {
	Mode string `json:"mode"`
	Word string `json:"word"`
	ID   string `json:"id"`
}

// Session is one live Claude Code session as the relay reports it.
type Session struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	AgentName string  `json:"agentName"`
	Cwd       string  `json:"cwd"`
	Repo      *string `json:"repo"`
	Branch    *string `json:"branch"`
	Model     string  `json:"model"`
	// Pid is a string in the relay's wire format (registerSession sends the
	// output of `echo $PPID`). It is the Claude Code process itself, which is
	// what the identification ladder needs.
	Pid       string  `json:"pid"`
	StartedAt Millis  `json:"startedAt"`
	SeenAt    Millis  `json:"seenAt"`
	Working   bool    `json:"working"`
	Status    string  `json:"status"`
	Spin      *Spin   `json:"spin"`
	Stats     Stats   `json:"stats"`
	Agents    []Agent `json:"agents"`
	Series    []Point `json:"series"`
}

// ParsedPid returns the session's pid as an int, or 0 if it is not a number.
func (s Session) ParsedPid() int {
	n, err := strconv.Atoi(s.Pid)
	if err != nil {
		return 0
	}
	return n
}

// CtxFrac is the context fraction 0..1, guarding a zero limit.
func (s Session) CtxFrac() float64 {
	if s.Stats.CtxLimit <= 0 {
		return 0
	}
	f := float64(s.Stats.Ctx) / float64(s.Stats.CtxLimit)
	if f < 0 {
		return 0
	}
	if f > 1 {
		return 1
	}
	return f
}

// Event is one feed row.
type Event struct {
	ID        string `json:"id"`
	T         Millis `json:"t"`
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"` // tool | turn | agent | note
	Label     string `json:"label"`
	Detail    string `json:"detail"`
	Status    string `json:"status"` // ok | error | deny
	Ms        Millis `json:"ms"`
	// Internal marks plugin bookkeeping. Internal events are never shown in a
	// user-facing feed.
	Internal bool `json:"internal"`
}

// Question is an open ask_human.
type Question struct {
	ID        string   `json:"id"`
	T         Millis   `json:"t"`
	SessionID string   `json:"sessionId"`
	Question  string   `json:"question"`
	Options   []string `json:"options"`
	Context   string   `json:"context"`
	Answer    *string  `json:"answer"`
}

// Approval is a pending tool approval. Nothing posts these today.
type Approval struct {
	ID        string  `json:"id"`
	T         Millis  `json:"t"`
	SessionID string  `json:"sessionId"`
	Tool      string  `json:"tool"`
	Detail    string  `json:"detail"`
	Risk      string  `json:"risk"`
	Verdict   *string `json:"verdict"`
}

// Link is a queued briefing between two sessions.
type Link struct {
	ID   string `json:"id"`
	T    Millis `json:"t"`
	From string `json:"from"`
	To   string `json:"to"`
	Kind string `json:"kind"`
}

// Claimer is one session that has explicitly claimed a plan or a backlog
// section, as `{id, name}` on an Effort's or a BacklogItem's `claimedBy`. The
// pane matches this session's own claims by ID -- the id ident already
// resolved -- and never by a session's cwd/root: `/api/register` stores the
// caller's raw, possibly-subdirectory root, while the claims file on disk is
// keyed by the resolved worktree root, so the two do not agree. ID is the
// only field here both sides mean the same thing by.
type Claimer struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Effort is one distinct plan, folded across every worktree of a project that
// carries a copy of it (syzygy/bridge/tasks-efforts.mjs).
// CurrentItem is the winning copy's currently-active step, already resolved
// to text bridge-side (tasks-efforts.mjs's currentItemText) from
// currentItemId against that plan's items -- the pane never decodes the
// plans/items tree itself, which is why `currentItemId` alone is not enough
// here and `Name` (the effort's identity key, used only for matching
// upstream) is not decoded at all: MINE matches by ClaimedBy, never by name.
// Only the fields MINE renders are decoded; the payload carries more (name,
// rel, reported, copies, behind, currentItemId, checkedAt, at, live) that
// nothing here uses.
type Effort struct {
	Title       string    `json:"title"`
	Done        int       `json:"done"`
	Total       int       `json:"total"`
	CurrentItem string    `json:"currentItem"`
	ClaimedBy   []Claimer `json:"claimedBy"`
}

// BacklogItem is one row parsed from a worktree's backlog file (docs/TASKS.md
// and alike): a step or a section heading. Only a claimed section heading --
// `kind == "section"` -- is rendered by MINE, so nothing else off this shape
// is decoded.
type BacklogItem struct {
	Kind      string    `json:"kind"`
	Text      string    `json:"text"`
	ClaimedBy []Claimer `json:"claimedBy"`
}

// TaskFile is one backlog file's parsed items, under a worktree's `tasks`.
type TaskFile struct {
	Items []BacklogItem `json:"items"`
}

// Worktree is one worktree of a project. Only its backlog files are decoded
// here; the payload carries far more (plans, sessions, the raw claims map,
// diff labels) that the pane does not render.
type Worktree struct {
	Tasks []TaskFile `json:"tasks"`
}

// Project is one project (repo) the bridge's scanner found, folded across its
// worktrees. Only Worktrees and Efforts are decoded -- the minimal subset
// MINE renders -- not the whole projects payload (key, name, roll,
// planCollisions, unresolvedClaims, overCap and more).
type Project struct {
	Worktrees []Worktree `json:"worktrees"`
	Efforts   []Effort   `json:"efforts"`
}

// State is the /api/state and SSE `snapshot` payload. Only the fields MINE and
// the grid render are decoded; `dispatch`, `canvas`, `usage` and the rest are
// deliberately absent, so encoding/json skips them without allocating.
type State struct {
	T         Millis     `json:"t"`
	Sessions  []Session  `json:"sessions"`
	Events    []Event    `json:"events"`
	Questions []Question `json:"questions"`
	Approvals []Approval `json:"approvals"`
	Links     []Link     `json:"links"`
	Projects  []Project  `json:"projects"`
	Viewers   int        `json:"viewers"`
}

// EventCap matches the relay's own EVENT_CAP.
const EventCap = 400
