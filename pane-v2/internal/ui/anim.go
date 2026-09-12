package ui

import (
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/relay"
)

// frameEvery is the animation cadence. The plugin's own spinners are capped at
// 10 fps because $.ui.invalidate folds calls closer than 100ms; the pane is a
// separate process with no such ceiling, which is the whole reason this lives
// here.
const frameEvery = 33 * time.Millisecond

// spinPreviewFor is how long a picker press keeps the animation alive, so an
// idle session still shows what was chosen.
const spinPreviewFor = 6 * time.Second

// frameMsg advances the spinner by one frame. It is deliberately separate from
// tickMsg: the clock ticks once a second whatever is on screen, and this ticks
// thirty times a second only while something is moving.
type frameMsg struct{}

func frameTick() tea.Cmd {
	return tea.Tick(frameEvery, func(time.Time) tea.Msg { return frameMsg{} })
}

// animating reports whether anything on screen is moving. When it is false the
// ticker is not rescheduled and the pane goes quiet -- a side pane that burns a
// core beside an idle session is a worse bug than a stiff animation.
func (m Model) animating() bool {
	if m.mode != ModeVitals || m.frame.BP < BPS || m.showHelp || m.gridForm.Open {
		return false
	}
	if m.now.Before(m.spinPreview) {
		return true
	}
	s, ok := m.focusedOrLast()
	return ok && s.Working
}

// ensureAnim starts the frame ticker if something is animating and it is not
// already running. animOn is what stops two tickers from stacking.
func (m *Model) ensureAnim() tea.Cmd {
	if m.animOn || !m.animating() {
		return nil
	}
	m.animOn = true
	return frameTick()
}

// withAnim applies ensureAnim to a transition that could have started
// something moving -- a relay update, a key, a resize, the clock tick. It takes
// the pair a handler returns so the call site stays one line, and it runs
// ensureAnim before the model is copied out, which a `return m, ...` could not
// do: Go evaluates the first result before the second.
func withAnim(tm tea.Model, cmd tea.Cmd) (tea.Model, tea.Cmd) {
	mm, ok := tm.(Model)
	if !ok {
		return tm, cmd
	}
	a := mm.ensureAnim()
	if a == nil {
		return mm, cmd
	}
	return mm, tea.Batch(cmd, a)
}

// spinState is everything a spinner may read. Spinners are pure functions of
// it: no goroutines, no clock reads, no state of their own.
type spinState struct {
	Frame     int
	W, H      int
	Mode      string
	Word      string
	Working   bool
	Escalated bool
	Agents    int
	Tools     int
	Series    []relay.Point
}

// spinStateOf builds the state from a session, tolerating a nil Spin -- a
// session from an older plugin, or one that has not drawn a Spinner yet.
func (m Model) spinStateOf(s relay.Session, w, h int) spinState {
	st := spinState{
		Frame: m.anim, W: w, H: h,
		Working: s.Working,
		Agents:  len(s.Agents),
		Tools:   s.Stats.Tools,
		Series:  s.Series,
		Mode:    "thinking",
	}
	if s.Spin != nil {
		if s.Spin.Mode != "" {
			st.Mode = s.Spin.Mode
		}
		st.Word = s.Spin.Word
	}
	return st
}

// tintOf maps the engine's spinner mode to a palette role. The band uses
// 24-bit hexes for these; only the roles survive the pane's ANSI-only rule, so
// what travels is the meaning rather than the colour and the user's own
// terminal scheme picks the hue.
func tintOf(mode string, escalated bool) gs {
	if escalated {
		return gsAgent // purple, as the band's escalated tint
	}
	switch mode {
	case "requesting":
		return gsLink
	case "responding":
		return gsValue
	case "tool-input":
		return gsWarn
	case "tool-use":
		return gsErr
	default: // thinking, and anything a newer engine invents
		return gsAgent
	}
}
