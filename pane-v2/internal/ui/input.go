package ui

import (
	"github.com/adenineio/syzygy/pane-v2/internal/fmtx"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// inputRow draws one text-input line with the Row builder: the prefix, a
// window of the value that keeps the cursor on screen, and the cursor cell in
// reverse video. The textinput model is the editor; this is the renderer,
// because textinput.View() carries ANSI-256 defaults the palette test
// rejects and TruncRight cannot measure styled text. A blurred row shows its
// value, or the placeholder.
func inputRow(w int, prefix, value string, pos int, focused bool, placeholder string) string {
	r := NewRow(w)
	pst := theme.SDim
	if focused {
		pst = theme.SWarn
	}
	r.Add(pst, prefix)
	win := r.Rest()
	if win <= 0 {
		return r.String()
	}
	if !focused {
		if value == "" {
			r.Add(theme.SDim, fmtx.TruncRight(placeholder, win))
		} else {
			r.Add(theme.SBody, fmtx.TruncRight(value, win))
		}
		return r.String()
	}
	rs := []rune(value)
	pos = clampInt(pos, 0, len(rs))
	off := maxInt(0, pos-(win-1))
	r.Add(theme.SBody, string(rs[off:pos]))
	under := " "
	if pos < len(rs) {
		under = string(rs[pos])
	}
	r.Add(theme.SCursor, under)
	if pos+1 < len(rs) {
		r.Add(theme.SBody, string(rs[pos+1:])) // Row truncates the tail
	}
	return r.String()
}
