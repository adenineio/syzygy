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

// QuestionsMsg is the whole question list, replaced.
type QuestionsMsg []Question

// ApprovalsMsg is the whole approval list, replaced.
type ApprovalsMsg []Approval

// LinksMsg is the whole link list, replaced.
type LinksMsg []Link

// ViewersMsg is the viewer count.
type ViewersMsg int

func (ConnMsg) relayMsg()      {}
func (SnapshotMsg) relayMsg()  {}
func (SessionsMsg) relayMsg()  {}
func (EventsMsg) relayMsg()    {}
func (ProjectsMsg) relayMsg()  {}
func (QuestionsMsg) relayMsg() {}
func (ApprovalsMsg) relayMsg() {}
func (LinksMsg) relayMsg()     {}
func (ViewersMsg) relayMsg()   {}
