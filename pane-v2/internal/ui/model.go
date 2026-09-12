// Package ui is the Bubbletea program: one model, one store, one renderer per
// mode and one keymap per mode.
package ui

import (
	"log"
	"time"

	"github.com/charmbracelet/colorprofile"

	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/ident"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// Config is what main wires in.
type Config struct {
	// RelayURL is the base URL, for the WAITING panel's text.
	RelayURL string
	// StartMode is --mode.
	StartMode Mode
	// ReadOnly is set when no write credential could be loaded.
	ReadOnly bool
	// ColorForced is true when --color-profile pinned the profile, so the
	// reduced-colour notice is suppressed.
	ColorForced bool
	// Debug shows internal events and logs.
	Debug bool
	// Logger is nil unless --debug.
	Logger *log.Logger
	// Cwd is the directory the pane was launched in, which syzygy-pane.sh sets
	// to the Claude session's own (`split-window -c "$PWD"`). HOTKEYS uses it
	// to find the worktree root when no session is focused yet -- the relay
	// may not be up, and the config files are local either way.
	Cwd string
	// Now is injectable so the goldens can freeze time.
	Now func() time.Time
}

// Tone selects a toast's colour.
type Tone int

const (
	// ToneInfo is the ordinary yellow toast.
	ToneInfo Tone = iota
	// ToneErr is glitch-red.
	ToneErr
	// ToneGood is green, used sparingly.
	ToneGood
)

// Toast is the transient one-row message that replaces the short-help row.
type Toast struct {
	Text  string
	Tone  Tone
	Until time.Time
	Seq   int
}

// Active reports whether the toast should still be drawn.
func (t Toast) Active(now time.Time) bool { return t.Text != "" && now.Before(t.Until) }

// Model owns the relay mirror, identity and focus, connection state, terminal
// size and the few stateful widgets. Update is split by message, not by mode;
// only key messages are routed per mode.
type Model struct {
	src   relay.Source
	resv  ident.Resolver
	cfg   Config
	nowFn func() time.Time

	width, height int
	frame         Frame

	// relay mirror
	conn        relay.ConnState
	connAttempt int
	connRetryAt time.Time
	connErr     error
	everLive    bool
	liveSince   time.Time

	sessions  []relay.Session
	events    []relay.Event
	questions []relay.Question
	approvals []relay.Approval
	links     []relay.Link
	// projects is MINE's own data: the scanner's per-project effort and
	// backlog claims. It arrives on a full snapshot and is then replaced by
	// the relay's incremental `projects` broadcast (relay.ProjectsMsg), which
	// fires on every scan pass whose payload changed -- the relay sends a
	// snapshot only once per SSE connection, so without that handler a claim
	// made after this pane connected never reached MINE. See mine.go.
	projects []relay.Project
	viewers  int

	// lastFocused is the last good snapshot of the pinned session, kept so a
	// vanished session can still be drawn (greyed) rather than blanked.
	lastFocused relay.Session
	hadFocus    bool

	// identity and focus
	self         string
	selfHow      ident.Method
	expected     string
	expectedName string
	focus        string
	goneAt       time.Time
	lastIdent    time.Time
	identNote    string

	// ui
	mode     Mode
	keys     KeyMaps
	help     help.Model
	showHelp bool
	spin     spinner.Model
	spinning bool
	scroll   int
	toast    Toast

	// BOARD's cursor and its list viewport are separate: j/k move the cursor
	// and the wheel moves the list under it.
	//
	// Every pointer that outlives a frame holds a session id rather than a row
	// number. The list moves underneath -- a session leaves whenever one
	// exits, and the relay pushes a new list every 1.2s -- so anything that
	// spans two frames has to remember what it was on, not where it was.
	// cursorID is the row j/k and the pointer moved to; clickID with clickAt
	// counts a double-click, which a terminal reports as two presses and never
	// as a count; dragFrom is the session a press started on; linkFrom is the
	// session the l key marked as a briefing's sender. All are empty when
	// nothing is in flight, and boardTop is a viewport offset rather than a
	// pointer, so it stays a number.
	boardTop int
	cursorID string
	clickID  string
	clickAt  time.Time
	dragFrom string
	linkFrom string

	// GRID. gridCursorID is the card the cursor is on -- an id, like cursorID
	// above, because the list moves underneath; gridTop is a viewport offset
	// in card rows, so it stays a number. The gestures reuse dragFrom and
	// linkFrom. pending is the batch: at most gridPendMax connections,
	// in-memory only. gridDrag is the pointer while a button is down.
	gridCursorID string
	gridTop      int
	gridBatch    bool
	pending      []gridConn
	gridDrag     gridDrag
	// hk is HOTKEYS' own state: the two config files as parsed, the cursor,
	// the scope, the editor and the x arm. Loaded by command on entering the
	// mode and after every save -- never on the render path, because it runs
	// git and reads two files.
	hk hkState

	// gridForm is the notes form. It is open only over a non-empty pending,
	// it replaces the body, and while it is open it owns the keyboard and the
	// pointer -- see onKey and onMouse.
	gridForm gridForm

	// The pane's own spinner, in VITALS. anim is the frame counter, animOn
	// guards against two frame tickers running at once, spinPick indexes
	// spinners, and spinPreview keeps the animation alive briefly after a pick
	// so an idle session still shows what was chosen.
	anim        int
	animOn      bool
	spinPick    int
	spinPreview time.Time

	// feedFollow pins FEED's viewport to the newest event. feedTop is the
	// index, in the focused session's filtered feed, of the row at the top of
	// the viewport; it is consulted only while follow is off, so arriving
	// events never move a viewport the user has parked.
	feedFollow bool
	feedTop    int

	seq int
	now time.Time

	// colour profile
	profile     colorprofile.Profile
	profileSeen bool

	// quit
	quitting bool
}

// New builds the model. src and resv are interfaces so tests substitute a
// channel they own and a scripted resolver -- no network, no tmux, no ps.
func New(src relay.Source, resv ident.Resolver, cfg Config) Model {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	sp := spinner.New(spinner.WithSpinner(spinner.Line))
	sp.Style = theme.SValue
	h := help.New()
	h.ShortSeparator = " · "
	h.Ellipsis = "…"
	h.Styles.ShortKey = theme.SWarn
	h.Styles.ShortDesc = theme.SLabel
	h.Styles.ShortSeparator = theme.SDim
	h.Styles.FullKey = theme.SWarn
	h.Styles.FullDesc = theme.SLabel
	h.Styles.FullSeparator = theme.SDim
	h.Styles.Ellipsis = theme.SDim
	return Model{
		src:        src,
		resv:       resv,
		cfg:        cfg,
		nowFn:      cfg.Now,
		mode:       cfg.StartMode,
		keys:       DefaultKeys(),
		help:       h,
		spin:       sp,
		now:        cfg.Now(),
		conn:       relay.Connecting,
		frame:      NewFrame(0, 0),
		feedFollow: true,
	}
}

// Mode exposes the current mode, for tests.
func (m Model) Mode() Mode { return m.mode }

// Self exposes the pinned session id, for tests.
func (m Model) Self() string { return m.self }

// SelfHow exposes how the pin was decided, for tests.
func (m Model) SelfHow() ident.Method { return m.selfHow }

// IdentNote exposes the resolver's explanation, for the debug log.
func (m Model) IdentNote() string { return m.identNote }

// Sessions exposes the live session list, for --snapshot and tests.
func (m Model) Sessions() []relay.Session { return m.sessions }

// Conn exposes the connection state, for tests.
func (m Model) Conn() relay.ConnState { return m.conn }

// focused returns the session shown in modes 1-3, and whether it exists.
func (m Model) focused() (relay.Session, bool) {
	id := m.focus
	if id == "" {
		id = m.self
	}
	if id == "" {
		return relay.Session{}, false
	}
	for _, s := range m.sessions {
		if s.ID == id {
			return s, true
		}
	}
	return relay.Session{}, false
}

// others returns every live session that is not the focused one, in the
// relay's startedAt order.
func (m Model) others() []relay.Session {
	id := m.focus
	if id == "" {
		id = m.self
	}
	out := make([]relay.Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		if s.ID != id {
			out = append(out, s)
		}
	}
	return out
}

// gone reports whether the pinned session has been missing past the 3s
// debounce. A relay restart drops every session and the plugin re-registers
// within ~1.2s with the same id, so the debounce keeps that invisible.
func (m Model) gone() bool {
	return !m.goneAt.IsZero() && m.now.Sub(m.goneAt) >= 3*time.Second
}

// Init returns the initial batch: the relay read, the 1s tick, the first
// identification attempt, and a request for the RGB/Tc terminfo capabilities.
//
// That last one matters: the colorprofile package deliberately ignores
// $COLORTERM under tmux and screen, so sniffing the environment cannot tell us
// what the terminal can do. RequestCapability asks the terminal itself and
// Bubble Tea sends a fresh ColorProfileMsg, so the pane gets 24-bit colour
// through tmux without the launcher having to lie about the environment.
func (m Model) Init() tea.Cmd {
	cmds := []tea.Cmd{
		waitFor(m.src.Msgs()),
		tickCmd(),
		m.identify(),
		tea.RequestCapability("RGB"),
		tea.RequestCapability("Tc"),
	}
	if m.mode == ModeHotkeys {
		// --mode hotkeys starts IN the mode, so setMode -- which is what
		// normally triggers the read -- is never called. Without this the
		// pane opens on "reading the config…" and stays there.
		cmds = append(cmds, m.hkLoadCmd())
	}
	return tea.Batch(cmds...)
}

// Profile exposes the resolved colour profile, for tests.
func (m Model) Profile() colorprofile.Profile { return m.profile }
