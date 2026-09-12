package ui

import (
	"context"
	"fmt"
	"time"

	"github.com/charmbracelet/colorprofile"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/hotkeys"
	"github.com/adenineio/syzygy/pane-v2/internal/ident"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
)

// tickMsg drives the clock, ago() and the gone/retry countdowns.
type tickMsg time.Time

// identMsg carries a resolution attempt's result back to the UI goroutine.
type identMsg ident.Result

// IdentResult wraps a resolver result as the message Update expects, so a
// caller outside the package (--snapshot) can drive identification by hand.
func IdentResult(r ident.Result) tea.Msg { return identMsg(r) }

// toastExpiredMsg clears a toast whose seq still matches.
type toastExpiredMsg struct{ Seq int }

// postMsg carries a write's outcome back to the UI goroutine.
type postMsg struct {
	OK  string
	Err error
}

// waitFor is the canonical channel-to-Bubbletea bridge. One outstanding read
// at a time gives natural back-pressure, and a test can push fixtures into a
// channel it owns.
func waitFor(ch <-chan relay.Msg) tea.Cmd {
	return func() tea.Msg {
		msg, ok := <-ch
		if !ok {
			return nil
		}
		return msg
	}
}

func tickCmd() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

// identify runs the resolver off the UI goroutine: it execs tmux and ps.
func (m Model) identify() tea.Cmd {
	live := append([]relay.Session(nil), m.sessions...)
	r := m.resv
	if r == nil {
		return nil
	}
	return func() tea.Msg { return identMsg(r.Resolve(live)) }
}

// maybeIdentify rate-limits identification to once every 2s while unresolved.
func (m *Model) maybeIdentify() tea.Cmd {
	if m.now.Sub(m.lastIdent) < 2*time.Second {
		return nil
	}
	m.lastIdent = m.now
	return m.identify()
}

func (m *Model) setToast(text string, tone Tone) tea.Cmd {
	m.seq++
	seq := m.seq
	m.toast = Toast{Text: text, Tone: tone, Until: m.now.Add(2600 * time.Millisecond), Seq: seq}
	return tea.Tick(2600*time.Millisecond, func(time.Time) tea.Msg { return toastExpiredMsg{Seq: seq} })
}

// postCmd performs a token-authed write off the UI goroutine and turns the
// outcome into a toast. Every write the pane makes goes through here, so the
// read-only case is one path too: Post refuses without a credential and the
// error becomes the toast that says so.
func (m Model) postCmd(path string, body map[string]any, ok string) tea.Cmd {
	src := m.src
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := src.Post(ctx, path, body); err != nil {
			return postMsg{Err: err}
		}
		return postMsg{OK: ok}
	}
}

// spinCmd starts the spinner only while the focused session is working: an
// idle pane must not repaint.
func (m *Model) spinCmd() tea.Cmd {
	s, ok := m.focused()
	want := ok && s.Working && !m.gone()
	if want && !m.spinning {
		m.spinning = true
		return m.spin.Tick
	}
	if !want {
		m.spinning = false
	}
	return nil
}

// Update is split by message. Only key messages are routed per mode.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.frame = NewFrame(msg.Width, msg.Height)
		m.help.SetWidth(msg.Width)
		// A resize can cross the BPS breakpoint or the help overlay's ceiling,
		// which is exactly when the gate flips.
		return withAnim(m, nil)

	case tea.KeyPressMsg:
		return withAnim(m.onKey(msg))

	case tea.MouseMsg:
		// MouseMsg is the interface every mouse message satisfies; onMouse
		// sorts out which one this is. It is gated like a key because a click
		// can switch mode or move focus onto a working session.
		return withAnim(m.onMouse(msg))

	case tickMsg:
		m.now = time.Time(msg)
		return withAnim(m, tea.Batch(tickCmd(), m.reidentifyIfGone()))

	case frameMsg:
		// The one rule that must not be traded away: when nothing is moving,
		// this does not reschedule and the pane stops drawing.
		if !m.animating() {
			m.animOn = false
			return m, nil
		}
		m.anim++
		return m, frameTick()

	case identMsg:
		// Identification is the transition that most often starts the
		// animation: until it lands there is no focused session, so the gate
		// is shut however hard the session is working.
		return withAnim(m.onIdent(ident.Result(msg)))

	case toastExpiredMsg:
		if msg.Seq == m.toast.Seq {
			m.toast = Toast{}
		}
		return m, nil

	case hkLoadedMsg:
		m.hk.files = hotkeys.Loaded(msg)
		m.hk.loaded = true
		m.hk.err = ""
		if msg.GlobalErr != nil {
			m.hk.err = "global config will not parse: " + msg.GlobalErr.Error()
		} else if msg.ProjectErr != nil {
			m.hk.err = "project config will not parse: " + msg.ProjectErr.Error()
		}
		return m, nil

	case hkSavedMsg:
		if msg.Err != nil {
			// A refused save says so and changes nothing -- most often
			// because the file on disk will not parse, which is exactly when
			// overwriting it would destroy the user's work.
			m.hk.err = "not saved: " + msg.Err.Error()
			return m, m.setToast("slot "+msg.Slot+" not saved", ToneErr)
		}
		m.hk.err = ""
		return m, tea.Batch(
			m.hkLoadCmd(),
			m.setToast("slot "+msg.Slot+" saved to "+msg.Scope.String(), ToneGood),
		)

	case postMsg:
		if msg.Err != nil {
			return m, m.setToast("failed: "+msg.Err.Error(), ToneErr)
		}
		return m, m.setToast(msg.OK, ToneInfo)

	case tea.ColorProfileMsg:
		// The pane never refuses to run in fewer colours, but it
		// says so once so the user can fix their tmux.conf.
		m.profile = msg.Profile
		if m.profileSeen || m.cfg.ColorForced {
			return m, nil
		}
		m.profileSeen = true
		if msg.Profile < colorprofile.TrueColor {
			return m, m.setToast(msg.Profile.String()+" · set terminal-features ',*:RGB' in tmux.conf", ToneInfo)
		}
		return m, nil

	case spinner.TickMsg:
		if !m.spinning {
			return m, nil
		}
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		return m, cmd

	case relay.Msg:
		return withAnim(m.onRelay(msg))
	}
	// Anything the pane does not route itself goes to the notes form's input
	// while that form is open. Paste is why: a bracketed terminal paste
	// arrives as tea.PasteMsg, and textinput's own ctrl+v answers with a paste
	// message of its own that is unexported, so neither can be matched here by
	// name and both are lost if this returns nil. The input sanitises what it
	// inserts -- a tab or a newline becomes one space -- so no paste can shear
	// a row. Every other stray message is inert inside textinput.
	if m.gridForm.Open {
		var cmd tea.Cmd
		m.gridForm.in, cmd = m.gridForm.in.Update(msg)
		return m, cmd
	}
	// The slot editor gets the same courtesy, for the same reason: a paste
	// into the prompt field arrives as a message neither of us can match by
	// name, and dropping it would silently eat the paste.
	if m.hk.editor.Open {
		var cmd tea.Cmd
		f := m.hk.editor.Field
		m.hk.editor.in[f], cmd = m.hk.editor.in[f].Update(msg)
		return m, cmd
	}
	return m, nil
}

// reidentifyIfGone re-runs identification every 5s while the pinned session is
// missing, so a Claude restarted in the same pane is picked up.
func (m *Model) reidentifyIfGone() tea.Cmd {
	if m.self == "" && m.conn == relay.Live {
		return m.maybeIdentify()
	}
	if m.goneAt.IsZero() {
		return nil
	}
	if m.now.Sub(m.lastIdent) < 5*time.Second {
		return nil
	}
	m.lastIdent = m.now
	return m.identify()
}

func (m Model) onIdent(r ident.Result) (tea.Model, tea.Cmd) {
	prev := m.self
	m.identNote = r.Note
	m.expected, m.expectedName = r.Expected, r.ExpectedName
	if r.ID != "" {
		m.self, m.selfHow = r.ID, r.How
		if m.focus == "" || m.focus == prev {
			m.focus = r.ID
		}
		if prev != "" && prev != r.ID {
			cmd := m.setToast("followed new session "+shortID(r.ID), ToneInfo)
			m.goneAt = time.Time{}
			return m, tea.Batch(cmd, m.spinCmd())
		}
		m.goneAt = time.Time{}
		m.rememberFocus()
		return m, m.spinCmd()
	}
	// UNPINNED: keep any previous pin only if it is still live.
	if prev != "" {
		if _, ok := m.focused(); ok {
			return m, nil
		}
	}
	m.self, m.selfHow = "", ident.None
	return m, nil
}

func (m Model) onRelay(msg relay.Msg) (tea.Model, tea.Cmd) {
	rearm := waitFor(m.src.Msgs())
	switch v := msg.(type) {

	case relay.ConnMsg:
		prev := m.conn
		m.conn = v.State
		m.connAttempt, m.connRetryAt, m.connErr = v.Attempt, v.RetryAt, v.Err
		if v.State == relay.Down {
			// The armed family's rule, and the link hint earns
			// it for the same reason: a disconnect cancels anything waiting on
			// a second press, rather than inviting one that cannot land.
			m.linkFrom = ""
		}
		if v.State == relay.Down && prev == relay.Live {
			// The mirror stays on screen in grey: stale data is still data.
			return m, tea.Batch(rearm, m.setToast("relay lost", ToneErr))
		}
		return m, rearm

	case relay.SnapshotMsg:
		st := relay.State(v)
		wasLive := m.everLive
		m.conn = relay.Live
		m.everLive = true
		m.liveSince = m.now
		m.sessions = st.Sessions
		m.events = capEvents(st.Events)
		m.questions, m.approvals, m.links = st.Questions, st.Approvals, st.Links
		m.projects = st.Projects
		m.viewers = st.Viewers
		m.lastIdent = time.Time{}
		cmds := []tea.Cmd{rearm, m.maybeIdentify()}
		if wasLive {
			cmds = append(cmds, m.setToast(fmt.Sprintf("relay back · %d sessions", len(st.Sessions)), ToneGood))
		}
		m.rememberFocus()
		cmds = append(cmds, m.spinCmd())
		return m, tea.Batch(cmds...)

	case relay.SessionsMsg:
		m.sessions = []relay.Session(v)
		var cmds []tea.Cmd
		cmds = append(cmds, rearm)
		if m.self != "" {
			if _, ok := m.focused(); ok {
				m.goneAt = time.Time{}
			} else if m.goneAt.IsZero() {
				m.goneAt = m.now
			}
		}
		if m.self == "" || !m.goneAt.IsZero() {
			cmds = append(cmds, m.maybeIdentify())
		}
		m.rememberFocus()
		cmds = append(cmds, m.spinCmd())
		return m, tea.Batch(cmds...)

	case relay.ProjectsMsg:
		// The relay writes a `snapshot` exactly once per SSE connection and
		// then broadcasts `projects` on every scan whose payload changed. MINE
		// is built from m.projects, so without this the view froze at whatever
		// was claimed when the pane connected.
		m.projects = []relay.Project(v)
		return m, rearm

	case relay.EventsMsg:
		m.events = capEvents(append(m.events, []relay.Event(v)...))
		return m, rearm

	case relay.QuestionsMsg:
		m.questions = []relay.Question(v)
		return m, rearm

	case relay.ApprovalsMsg:
		m.approvals = []relay.Approval(v)
		return m, rearm

	case relay.LinksMsg:
		m.links = []relay.Link(v)
		return m, rearm

	case relay.ViewersMsg:
		m.viewers = int(v)
		return m, rearm
	}
	return m, rearm
}

// rememberFocus keeps the last good copy of the pinned session so it can
// still be drawn in grey after it vanishes.
func (m *Model) rememberFocus() {
	if s, ok := m.focused(); ok {
		m.lastFocused, m.hadFocus = s, true
	}
}

func capEvents(in []relay.Event) []relay.Event {
	if len(in) <= relay.EventCap {
		return in
	}
	return in[len(in)-relay.EventCap:]
}

// onKey routes a key press: the help overlay first, then the mode's bindings,
// then the global set.
func (m Model) onKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	k := m.keys
	if m.gridForm.Open {
		// The form owns the keyboard: q, digits and ? all type into the note.
		// This is ahead of the help overlay because the two are never open at
		// once and the form is the more modal of the pair.
		return m.onGridFormKey(msg)
	}
	if m.showHelp {
		switch {
		case key.Matches(msg, k.Global.Help), key.Matches(msg, k.Global.Esc), key.Matches(msg, k.Global.Quit):
			m.showHelp = false
		}
		return m, nil
	}

	// Mode bindings.
	switch m.mode {
	case ModeVitals:
		switch {
		case key.Matches(msg, k.Vitals.Down):
			// The same ceiling the wheel clamps to: two input paths for one
			// action must not disagree about where the body ends.
			m.scroll = minInt(m.scroll+1, m.maxScroll(m.frame))
			return m, nil
		case key.Matches(msg, k.Vitals.Up):
			if m.scroll > 0 {
				m.scroll--
			}
			return m, nil
		case key.Matches(msg, k.Vitals.SpinNext):
			return m.pickSpinner(1)
		case key.Matches(msg, k.Vitals.SpinPrev):
			return m.pickSpinner(-1)
		}
	case ModeFeed:
		n, budget := len(m.feedEvents()), m.feedBudget()
		page := maxInt(1, budget/2)
		switch {
		case key.Matches(msg, k.Feed.Down):
			m.feedScroll(n, budget, 1)
			return m, nil
		case key.Matches(msg, k.Feed.Up):
			m.feedScroll(n, budget, -1)
			return m, nil
		case key.Matches(msg, k.Feed.PageDown):
			m.feedScroll(n, budget, page)
			return m, nil
		case key.Matches(msg, k.Feed.PageUp):
			m.feedScroll(n, budget, -page)
			return m, nil
		case key.Matches(msg, k.Feed.Newest):
			m.feedFollow, m.feedTop = true, 0
			return m, nil
		case key.Matches(msg, k.Feed.Oldest):
			m.feedScroll(n, budget, n) // past the far end, which clamps to the oldest
			return m, nil
		case key.Matches(msg, k.Feed.Follow):
			m.feedFollow = !m.feedFollow
			if m.feedFollow {
				m.feedTop = 0
			}
			return m, nil
		}
	case ModeBoard:
		switch {
		case key.Matches(msg, k.Board.Down):
			m.boardMove(1)
			return m, nil
		case key.Matches(msg, k.Board.Up):
			m.boardMove(-1)
			return m, nil
		case key.Matches(msg, k.Board.Focus):
			return m.boardFocus()
		case key.Matches(msg, k.Board.Link):
			return m.boardLink()
		}
	case ModeGrid:
		lay := m.gridLayout()
		switch {
		case key.Matches(msg, k.Grid.Down):
			m.gridMove(lay.Cols)
			return m, nil
		case key.Matches(msg, k.Grid.Up):
			m.gridMove(-lay.Cols)
			return m, nil
		case key.Matches(msg, k.Grid.Left):
			m.gridMove(-1)
			return m, nil
		case key.Matches(msg, k.Grid.Right):
			m.gridMove(1)
			return m, nil
		case key.Matches(msg, k.Grid.Link):
			return m.gridLink()
		case key.Matches(msg, k.Grid.Batch):
			m.gridBatch = !m.gridBatch
			return m, nil
		case key.Matches(msg, k.Grid.Undo):
			m.gridUndo()
			return m, nil
		case key.Matches(msg, k.Grid.Notes):
			return m.openGridForm()
		}
	case ModeHotkeys:
		if m.hk.editor.Open {
			// The editor owns the keyboard the way the notes form does: every
			// key is a character in a text field, and this never falls
			// through to the global bindings.
			return m.onHkEditorKey(msg)
		}
		if md, cmd, handled := m.onHkKey(msg); handled {
			return md, cmd
		}
	case ModeMine:
		switch {
		case key.Matches(msg, k.Mine.Down):
			m.scroll = minInt(m.scroll+1, m.maxScroll(m.frame))
			return m, nil
		case key.Matches(msg, k.Mine.Up):
			if m.scroll > 0 {
				m.scroll--
			}
			return m, nil
		}
	}

	switch {
	case key.Matches(msg, k.Global.Quit):
		m.quitting = true
		return m, tea.Quit
	case key.Matches(msg, k.Global.Help):
		m.showHelp = true
		return m, nil
	case key.Matches(msg, k.Global.Esc):
		m.showHelp = false
		m.linkFrom = ""
		m.dragFrom, m.gridDrag = "", gridDrag{}
		// The armed family's rule: esc cancels anything
		// waiting on a second press.
		m.hk.armed = false
		return m, nil
	case key.Matches(msg, k.Global.Reconnect):
		m.src.Reconnect()
		return m, m.setToast("reconnecting", ToneInfo)
	case key.Matches(msg, k.Global.Home):
		return m.focusHome()
	case key.Matches(msg, k.Global.Vitals):
		return m.setMode(ModeVitals)
	case key.Matches(msg, k.Global.Feed):
		return m.setMode(ModeFeed)
	case key.Matches(msg, k.Global.Console):
		return m.setMode(ModeConsole)
	case key.Matches(msg, k.Global.Board):
		return m.setMode(ModeBoard)
	case key.Matches(msg, k.Global.Grid):
		return m.setMode(ModeGrid)
	case key.Matches(msg, k.Global.Mine):
		return m.setMode(ModeMine)
	case key.Matches(msg, k.Global.Hotkeys):
		return m.setMode(ModeHotkeys)
	case key.Matches(msg, k.Global.Next):
		return m.setMode(Mode((int(m.mode) + 1) % len(AllModes)))
	case key.Matches(msg, k.Global.Prev):
		return m.setMode(Mode((int(m.mode) + len(AllModes) - 1) % len(AllModes)))
	}
	return m, nil
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// pickSpinner steps the VITALS spinner choice and previews it. The preview is
// what lets a pick animate beside an idle session: without it the gate would
// close on the very next frame and the user would see one still image of
// whatever they just chose.
func (m Model) pickSpinner(step int) (tea.Model, tea.Cmd) {
	if n := len(spinners); n > 0 {
		m.spinPick = ((m.spinPick+step)%n + n) % n
	}
	m.spinPreview = m.now.Add(spinPreviewFor)
	return m, m.ensureAnim()
}
