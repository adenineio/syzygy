package relay

import "time"

// ConnState is the stream's connection state.
type ConnState int

const (
	// Connecting is the state before the first snapshot of an attempt.
	Connecting ConnState = iota
	// Live means a snapshot has landed and the body is open.
	Live
	// Down means the stream failed and a retry is scheduled.
	Down
)

func (c ConnState) String() string {
	switch c {
	case Live:
		return "live"
	case Down:
		return "down"
	default:
		return "connecting"
	}
}

// Msg is the marker for every message the relay client produces. It exists so
// Update can re-arm the channel read for any of them in one branch.
type Msg interface{ relayMsg() }

// ConnMsg reports a connection state change.
type ConnMsg struct {
	State   ConnState
	Attempt int
	RetryAt time.Time
	Err     error
}

// SnapshotMsg replaces the whole mirror.
type SnapshotMsg State

// SessionsMsg is the whole live session list, replaced.
type SessionsMsg []Session

// EventsMsg is only the new batch, to be appended.
type EventsMsg []Event

// ProjectsMsg is the whole projects payload, replaced. The relay writes a
// `snapshot` exactly once per SSE connection and then broadcasts `projects`
// on its own 4s scan cadence whenever the payload changes -- so without this
// message a claim made after the pane connected would not reach MINE until
// the next reconnect.
type ProjectsMsg []Project

// PasteboardMsg is the whole pasteboard, replaced. It exists for the same
// reason ProjectsMsg does: the relay writes a `snapshot` exactly once per SSE
// connection and broadcasts `pasteboard` on every change, so without this a
// stash made after the pane connected would not appear until a reconnect.
type PasteboardMsg []Paste

// CanvasMsg is the whole canvas payload, replaced. Same reason ProjectsMsg
// exists: the snapshot lands once per connection and the relay broadcasts
// `canvas` on every change, so without this a node moved after the pane
// connected would not arrive until a reconnect.
type CanvasMsg Canvas

// QuestionsMsg is the whole question list, replaced.
type QuestionsMsg []Question

// ApprovalsMsg is the whole approval list, replaced.
type ApprovalsMsg []Approval

// LinksMsg is the whole link list, replaced.
type LinksMsg []Link

// ViewersMsg is the viewer count.
type ViewersMsg int

// ChainMsg is one session's compact chain, replaced. It exists for the same
// reason PasteboardMsg does: the relay writes a `snapshot` exactly once per SSE
// connection and broadcasts `chain` on every change, so without this a block
// opened after the pane connected would not appear until a reconnect.
type ChainMsg struct {
	SessionID string `json:"sessionId"`
	Chain     Chain  `json:"chain"`
}

func (ConnMsg) relayMsg()       {}
func (SnapshotMsg) relayMsg()   {}
func (SessionsMsg) relayMsg()   {}
func (EventsMsg) relayMsg()     {}
func (ProjectsMsg) relayMsg()   {}
func (PasteboardMsg) relayMsg() {}
func (QuestionsMsg) relayMsg()  {}
func (ApprovalsMsg) relayMsg()  {}
func (LinksMsg) relayMsg()      {}
func (ViewersMsg) relayMsg()    {}
func (CanvasMsg) relayMsg()     {}
func (ChainMsg) relayMsg()      {}
