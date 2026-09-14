package ui

import (
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// leaderWindow is how long the prefix waits for its second keystroke.
const leaderWindow = 3 * time.Second

// bankEntry is one mode reachable through the leader rather than through a
// digit. The seven digits are spent and the tab strip is full at the width the
// pane actually runs at, so a new mode nests here instead of taking an eighth
// tab and dropping every caption another tier.
type bankEntry struct {
	// Key is the second keystroke. Caption is what the hint row calls it.
	Key, Caption string
	// Mode is where it goes -- meaningful only when Reserved is empty.
	Mode Mode
	// Reserved says what the mode WILL be. A key that explains itself is
	// better than one that silently does nothing.
	Reserved string
}

// ModeBank is the second bank. Adding a mode is one row; building a reserved
// one is clearing its Reserved and naming its Mode.
var ModeBank = []bankEntry{
	{Key: "c", Caption: "CHAIN", Mode: ModeChain},
	{Key: "o", Caption: "CONSOLE", Reserved: "the inbox and steer mode is not built yet"},
}

// bankCaption is the header's lit caption for a mode reached through the
// leader, and whether the mode is one. A reserved row names no mode, so it can
// never light one.
func bankCaption(md Mode) (string, bool) {
	for _, e := range ModeBank {
		if e.Reserved == "" && e.Mode == md {
			return md.Tiny(), true
		}
	}
	return "", false
}

// bankRow is the hint the leader puts up. Yellow TEXT, not the armed strip's
// black-on-yellow block: nothing here is destructive, and the loud treatment is
// reserved for the keypress you cannot take back.
func (m Model) bankRow(f Frame) string {
	if !m.leader || !m.now.Before(m.leaderUntil) {
		return ""
	}
	parts := make([]string, 0, len(ModeBank)+2)
	for _, e := range ModeBank {
		parts = append(parts, e.Key+" "+e.Caption)
	}
	parts = append(parts, "?", "esc")
	text := "LEADER · " + strings.Join(parts, " · ")
	if f.BP == BPS {
		short := make([]string, 0, len(ModeBank))
		for _, e := range ModeBank {
			short = append(short, e.Key)
		}
		text = "LEADER " + strings.Join(short, "") + " ? esc"
	}
	r := NewRow(f.W)
	r.Add(theme.STick, theme.GTick)
	r.Add(theme.SWarn, fmtx.TruncRight(text, r.Rest()))
	return r.String()
}

// bankBody is the full listing, over the body, for the leader's own ?.
func (m Model) bankBody(f Frame) []string {
	rows := []string{Head(f.W, "MODES", "", theme.SLabel)}
	for _, e := range ModeBank {
		r := NewRow(f.W)
		r.Add(theme.SBg, "  ")
		r.Add(theme.SWarn, padTo("space "+e.Key, 10))
		r.Add(theme.SName, padTo(e.Caption, 9))
		rows = append(rows, r.String())
		if e.Reserved != "" {
			// Its own paragraph under the caption: the reason is the useful
			// part, and a truncated one explains nothing.
			rows = append(rows, para(f.W, e.Reserved, 4, theme.SDim)...)
		}
	}
	rows = append(rows, para(f.W, "the seven digits are spent; these nest behind the leader", 2, theme.SDim)...)
	rows = append(rows, para(f.W, "esc or ? closes this", 1, theme.SDim)...)
	return rows
}

// onLeaderKey owns the keystroke after the prefix. It always returns: the
// leader is spent either way, so a bank key and a stray key differ only in
// whether the stray one also does its own job.
func (m Model) onLeaderKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd, bool) {
	m.leader = false
	s := msg.String()
	if s == "?" {
		m.showBank = true
		return m, nil, true
	}
	for _, e := range ModeBank {
		if e.Key != s {
			continue
		}
		if e.Reserved != "" {
			return m, m.setToast(e.Caption+": "+e.Reserved, ToneInfo), true
		}
		md, cmd := m.setMode(e.Mode)
		return md, cmd, true
	}
	// Not in the bank: cancelled, and the key still does whatever it does.
	return m, nil, false
}
