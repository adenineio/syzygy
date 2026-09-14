// Package relay mirrors the Syzygy relay's read model and provides
// the SSE client and the token-authed POST helper.
package relay

import (
	"encoding/json"
	"errors"
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
	// Root is the worktree the session reported at registration -- possibly a
	// subdirectory of the real one, which is why nothing keys a claim by it.
	Root string `json:"root"`
	// Files counts how often this session touched each path.
	Files map[string]int `json:"files"`
	// IdleSince is when work STOPPED, which is not what SeenAt measures: the
	// plugin heartbeats about once a second whether or not anything happened.
	IdleSince Millis `json:"idleSince"`
	// Needs is what the last finished turn asked the user for, as the plugin
	// read it; Waiting is Claude Code's own observation that the session is
	// parked at a prompt, and WaitingFor is what it is parked on.
	Needs      string `json:"needs"`
	Waiting    bool   `json:"waiting"`
	WaitingFor string `json:"waitingFor"`
	// LastAnswer is the tail of what this session last said, and when.
	LastAnswer   string `json:"lastAnswer"`
	LastAnswerAt Millis `json:"lastAnswerAt"`
	// Tmux is the tmux session the plugin found itself in, or "" -- a case,
	// not a failure.
	Tmux string `json:"tmux"`
	// Kind and ShortID come from the agents listing: what this session IS, and
	// the short handle the CLI answers to. Jump is which of the four ways
	// there is open. All three are empty when no listing has succeeded.
	Kind    string `json:"kind"`
	ShortID string `json:"shortId"`
	Jump    string `json:"jump"`
	// Color is the card outline the user picked, as #rrggbb, or "". The pane
	// emits no 24-bit colour, so it is carried and not drawn.
	Color string `json:"color"`
}

// ParsedPid returns the session's pid as an int, or 0 if it is not a number.
func (s Session) ParsedPid() int {
	n, err := strconv.Atoi(s.Pid)
	if err != nil {
		return 0
	}
	return n
}

// NeedsNow is what this session is waiting on the user for, or "".
//
// Two independent sources, and the parked-at-a-prompt one wins: Claude Code
// OBSERVES that, while Needs is a heuristic read of what the last finished turn
// asked for. An observation outranks an inference, and it is the more urgent
// case. A relay that sends neither reports "", and nothing lights.
func (s Session) NeedsNow() string {
	if s.Waiting {
		if s.WaitingFor != "" {
			return s.WaitingFor
		}
		return "waiting for input"
	}
	return s.Needs
}

// KillPlan is what closing this session would actually do. `stop` and `signal`
// are different promises and a confirmation must not pretend they are one.
func (s Session) KillPlan() (string, string, bool) {
	if s.Kind == "background" && s.ShortID != "" {
		return "stop", "claude stop " + s.ShortID, true
	}
	if s.ParsedPid() > 1 {
		return "signal", "SIGTERM to pid " + s.Pid, true
	}
	return "", "no pid registered, and not a background agent", false
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
// section, as `{id, name}` on an Effort's or a ClaimedSection's `claimedBy`. The
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
// carries a copy of it. The relay sends only efforts some session has claimed,
// most recently checked first, and caps how many ride each project; a claimed
// plan past the cap is not in the list. CurrentItem is the most advanced
// copy's currently-active step, already resolved to text by the relay, so the
// pane never walks a plan's steps. Only the fields MINE renders are decoded;
// the relay also sends `name`, the effort's identity key, which is not decoded
// because MINE matches by ClaimedBy, never by name.
type Effort struct {
	Title       string    `json:"title"`
	Done        int       `json:"done"`
	Total       int       `json:"total"`
	CurrentItem string    `json:"currentItem"`
	ClaimedBy   []Claimer `json:"claimedBy"`
}

// ClaimedSection is one backlog section heading that at least one session has
// claimed, as it rides a worktree line. Every entry is a section heading, so
// there is no kind to test. MINE renders only the heading's text, filtered by
// ClaimedBy; the relay also sends the task file's path (`rel`) and the
// heading's `slug`, which are not decoded.
type ClaimedSection struct {
	Text      string    `json:"text"`
	ClaimedBy []Claimer `json:"claimedBy"`
}

// Worktree is one worktree of a project. The relay sends a line per worktree
// rather than its parsed plans and backlog: the backlog sections a session
// claims ride here, and a heading nobody claims is not sent at all. Only what
// MINE renders is decoded; the line also carries the path, branch, head,
// sessions, a plan count, diff counts and the task file and its authority.
// A relay that sends no `claimedSections` key decodes to no sections.
type Worktree struct {
	ClaimedSections []ClaimedSection `json:"claimedSections"`
}

// Project is one project (repo) the bridge's scanner found, folded across its
// worktrees. Only Worktrees and Efforts are decoded -- the minimal subset
// MINE renders -- not the whole projects payload (key, name, roll,
// planCollisions, unresolvedClaims, overCap and more).
type Project struct {
	Worktrees []Worktree `json:"worktrees"`
	Efforts   []Effort   `json:"efforts"`
}

// Paste is one stashed prompt as the relay reports it. A SessionID of "" is
// the global board -- the relay sends JSON null there, which decodes to the
// zero string, and that is the only distinction the mode needs.
type Paste struct {
	ID          string `json:"id"`
	SessionID   string `json:"sessionId"`
	SessionName string `json:"sessionName"`
	Text        string `json:"text"`
	Title       string `json:"title"`
	CreatedAt   Millis `json:"createdAt"`
	Order       int    `json:"order"`
}

// CanvasNode is one session's or project's placed position on the canvas.
type CanvasNode struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Name string  `json:"name"`
	T    Millis  `json:"t"`
}

// CanvasSpawn is one background session started from the canvas, tracked
// until its own registration replaces the placeholder or it is judged gone.
type CanvasSpawn struct {
	ShortID   string  `json:"shortId"`
	Name      string  `json:"name"`
	Cwd       string  `json:"cwd"`
	Model     string  `json:"model"`
	Effort    string  `json:"effort"`
	SpawnedAt Millis  `json:"spawnedAt"`
	SessionID *string `json:"sessionId"`
	State     string  `json:"state"`
}

// Canvas is the session canvas's placement and spawn-tracking state. Nothing
// draws it yet; it is decoded so the stream contract does not have to be
// reopened for the rung that does.
type Canvas struct {
	Nodes     map[string]CanvasNode `json:"nodes"`
	SpawnedBy []CanvasSpawn         `json:"spawnedBy"`
	Recents   []string              `json:"recents"`
	Live      int                   `json:"live"`
	Home      string                `json:"home"`
}

// Dispatch is the dispatch queue. Its entries are opaque here: nothing reads
// past the fact that the queue exists.
type Dispatch struct {
	Requests []json.RawMessage `json:"requests"`
}

// DispatchOptions is the resolved model/effort choices the dispatch pickers
// would offer, and whether they came from the binary's own help text or a
// baked-in fallback.
type DispatchOptions struct {
	Models  []string `json:"models"`
	Efforts []string `json:"efforts"`
	Source  string   `json:"source"`
}

// AfterReset is the after-reset queue: pending entries plus the night-run
// state, both opaque here.
type AfterReset struct {
	Queue []json.RawMessage `json:"queue"`
	Night json.RawMessage   `json:"night"`
}

// SteerButton is one custom steering button a user has defined.
type SteerButton struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Prompt string `json:"prompt"`
}

// Steering carries the custom steering buttons; the built-in ones are not
// part of the payload.
type Steering struct {
	Custom []SteerButton `json:"custom"`
}

// Voice is voice input's readiness and its live-transcription chunk size.
type Voice struct {
	Ready   bool `json:"ready"`
	ChunkMs int  `json:"chunkMs"`
}

// SpinnerRef names one spinner the HUD offers.
type SpinnerRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Hud is the HUD's spinner catalogue and the one currently selected.
type Hud struct {
	Spinners []SpinnerRef `json:"spinners"`
	Current  string       `json:"current"`
}

// Orchestrator is the orchestrator agent's status plus its conversation
// headers -- never the turns, which are fetched per-thread on demand.
type Orchestrator struct {
	Threads   []json.RawMessage `json:"threads"`
	CurrentID string            `json:"currentId"`
}

// Auth reports whether a pane password gates writes. It carries no secret.
type Auth struct {
	Enabled bool `json:"enabled"`
}

// Peers is peering's state for the pane: whether it is on, this relay's own
// peer name, and the roster, asks and jobs, all opaque here.
type Peers struct {
	Enabled bool              `json:"enabled"`
	Self    string            `json:"self"`
	List    []json.RawMessage `json:"list"`
	Asks    []json.RawMessage `json:"asks"`
}

// State is the /api/state and SSE `snapshot` payload. Every top-level key the
// relay sends has a field here, so a key that appears and is never decoded
// fails a test instead of vanishing; nested shapes go only as deep as
// something reads.
type State struct {
	PayloadVersion int        `json:"payloadVersion"`
	T              Millis     `json:"t"`
	Sessions       []Session  `json:"sessions"`
	Events         []Event    `json:"events"`
	Questions      []Question `json:"questions"`
	Approvals      []Approval `json:"approvals"`
	Links          []Link     `json:"links"`
	Projects       []Project  `json:"projects"`
	// Pasteboard is PASTE's own data. One field, because one mode renders it:
	// the struct's rule is that a field nobody draws stays undecoded.
	Pasteboard      []Paste           `json:"pasteboard"`
	Viewers         int               `json:"viewers"`
	Canvas          Canvas            `json:"canvas"`
	Dispatch        Dispatch          `json:"dispatch"`
	DispatchOptions DispatchOptions   `json:"dispatchOptions"`
	Usage           json.RawMessage   `json:"usage"`
	UsageHistory    []json.RawMessage `json:"usageHistory"`
	AfterReset      AfterReset        `json:"afterReset"`
	Steering        Steering          `json:"steering"`
	Findings        []json.RawMessage `json:"findings"`
	SweepQuietMs    int64             `json:"sweepQuietMs"`
	Voice           Voice             `json:"voice"`
	Hud             Hud               `json:"hud"`
	Orchestrator    Orchestrator      `json:"orchestrator"`
	Auth            Auth              `json:"auth"`
	Peers           Peers             `json:"peers"`
	// Chains is CHAIN's own data, keyed by session id: each session's compact
	// topic chain. A relay that predates chains sends no key, so this stays a
	// nil map, and a reader must tell that apart from a session with no chain.
	Chains map[string]Chain `json:"chains"`
}

// ChainBlock is one block of a compact chain: what a row of CHAIN draws.
type ChainBlock struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// State is open, closed or merged. A merged block is not drawn.
	State  string `json:"state"`
	By     string `json:"by"`
	Pinned bool   `json:"pinned"`
	// Parent is a string, not a pointer: the relay's null decodes to "" and
	// the only question asked of it is whether it names the block above.
	Parent    string `json:"parent"`
	TurnCount int    `json:"turnCount"`
	StartedAt Millis `json:"startedAt"`
	EndedAt   Millis `json:"endedAt"`
	Rev       int    `json:"rev"`
}

// ChainRefiner is the refiner's state as the payload carries it.
type ChainRefiner struct {
	Paused bool `json:"paused"`
}

// Chain is the compact chain the snapshot and the `chain` event carry. It has
// titles and states only: summaries and turn heads come from Get.
type Chain struct {
	Blocks    []ChainBlock `json:"blocks"`
	Open      string       `json:"open"`
	Progress  string       `json:"progress"`
	Rev       int          `json:"rev"`
	UpdatedAt Millis       `json:"updatedAt"`
	Refiner   ChainRefiner `json:"refiner"`
}

// ChainTurn is one turn of the full chain. AnswerHead is the END of the answer,
// never its opening, so whatever draws it marks it as a tail.
type ChainTurn struct {
	PromptHead string   `json:"promptHead"`
	AnswerHead string   `json:"answerHead"`
	Files      []string `json:"files"`
	At         Millis   `json:"at"`
	DurationMs Millis   `json:"durationMs"`
}

// ChainDetailBlock is a block of the full chain, reduced to what CHAIN draws.
type ChainDetailBlock struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Summary string   `json:"summary"`
	Turns   []string `json:"turns"`
}

// ChainRevision is the chain as it stood after one structural change: titles
// and states only.
type ChainRevision struct {
	At     Millis           `json:"at"`
	Rev    int              `json:"rev"`
	Blocks []ChainBlockStub `json:"blocks"`
}

// ChainBlockStub is a block as a revision remembers it.
type ChainBlockStub struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	State string `json:"state"`
}

// ChainDetail is the full chain as GET /api/chain/<id> answers it. Only the
// fields CHAIN draws: the summaries, the turn heads and the revision list.
type ChainDetail struct {
	Blocks  []ChainDetailBlock   `json:"blocks"`
	Turns   map[string]ChainTurn `json:"turns"`
	History []ChainRevision      `json:"history"`
}

// errNoChain is an answer that parsed but carried no chain.
var errNoChain = errors.New("the answer carried no chain")

// DecodeChainDetail reads GET /api/chain/<id>'s { chain } body. A body that
// will not parse, or parses to no chain, is an error rather than an empty
// chain, so a caller never draws a blank as though it were the answer.
func DecodeChainDetail(b []byte) (ChainDetail, error) {
	var w struct {
		Chain *ChainDetail `json:"chain"`
	}
	if err := json.Unmarshal(b, &w); err != nil {
		return ChainDetail{}, err
	}
	if w.Chain == nil {
		return ChainDetail{}, errNoChain
	}
	return *w.Chain, nil
}

// EventCap matches the relay's own EVENT_CAP.
const EventCap = 400
