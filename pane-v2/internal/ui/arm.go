package ui

import (
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// armWindow is how long a destructive key stays armed. The pane never fires
// anything destructive on a single keypress: the first press arms and says what
// the second will do, and the second press inside this window does it.
//
// The strip is keyboard-only. It is never registered as a hit region, and must
// not become one: a blind click confirming a kill or a delete is exactly the
// failure a second press exists to prevent.
const armWindow = 3 * time.Second

// Arm is the one armed gesture the pane can have at a time. Two could never be
// live at once, and a second would be a second set of cancel rules to keep in
// step with this one.
type Arm struct {
	// Mode is where it was started; leaving that mode cancels it.
	Mode Mode
	// Key both arms and confirms. Target is what it acts on -- an entry id, a
	// slot key, a session id -- so an arm is over one thing, never over a mode.
	Key, Target string
	// Label is the strip's sentence; Short is its form under 40 columns.
	Label, Short string
	// NeedsRelay marks a gesture that cannot land while the relay is down, so a
	// disconnect cancels it. A local file edit sets this false and survives.
	NeedsRelay bool
	Seq        int
	Expires    time.Time
}

// armExpiredMsg clears an arm whose seq still matches.
type armExpiredMsg struct{ Seq int }

// arm sets it and schedules its own expiry, rather than leaning on the 1 s
// clock: an expired strip that lingers is a strip claiming a keypress will
// still fire when it will not.
func (m *Model) arm(a Arm) tea.Cmd {
	m.seq++
	a.Seq = m.seq
	a.Expires = m.now.Add(armWindow)
	m.armed = a
	m.hasArm = true
	m.leader = false
	return tea.Tick(armWindow, func(time.Time) tea.Msg { return armExpiredMsg{Seq: a.Seq} })
}

func (m *Model) disarm() { m.armed, m.hasArm = Arm{}, false }

// isArmed reports whether a second press of this key on this target still fires.
func (m Model) isArmed(key, target string) bool {
	return m.hasArm && m.armed.Key == key && m.armed.Target == target &&
		m.armed.Mode == m.mode && m.now.Before(m.armed.Expires)
}

// isArmedKey reports whether this press is the arm's own confirming key.
func (m Model) isArmedKey(msg tea.KeyPressMsg) bool {
	return m.hasArm && msg.String() == m.armed.Key
}

// armRow is the black-on-yellow strip: the one place the pane is loud, because
// the next keypress is irreversible. The countdown is right-aligned.
//
// The sentence, the gap and the countdown are ONE reverse-video run. Every Add
// is its own run, and the frame allows three in all -- the brand, the active
// tab and this -- so a strip built from three Adds would break the frame's own
// budget the moment it appeared.
func (m Model) armRow(f Frame) string {
	if !m.hasArm || !m.now.Before(m.armed.Expires) || m.armed.Mode != m.mode {
		return ""
	}
	text := m.armed.Label + " ? · " + m.armed.Key + " again · esc"
	if f.BP == BPS && m.armed.Short != "" {
		text = m.armed.Short + " · " + m.armed.Key + " · esc"
	}
	left := fmtx.Ago(m.armed.Expires.Sub(m.now))
	r := NewRow(f.W)
	r.Add(theme.STick, theme.GTick)
	room := r.Rest() - fmtx.W(left)
	r.Add(theme.SArmed, padTo(fmtx.TruncRight(text, maxInt(0, room-1)), room)+left)
	return r.String()
}
