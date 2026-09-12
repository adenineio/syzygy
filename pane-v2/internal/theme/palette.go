// Package theme holds the Syzygy palette, the derived lipgloss
// styles, and the glyph table. Every colour the pane can emit lives here.
package theme

import (
	"image/color"

	"charm.land/lipgloss/v2"
)

// The palette is the terminal's own, addressed by ANSI index.
//
// The pane emits nothing but ANSI 0-15 and never a 24-bit sequence, so every
// colour is whatever the user's terminal theme says it is: change the Ghostty
// scheme and the pane changes with it. Nothing here paints a background
// either -- the terminal's own ground shows through every cell.
//
// The cyberpunk identity is deliberately not in these values. It lives in the
// glyph and layout grammar -- the phead tick, the section rules, the mini
// bars, the sparkline, the armed strip -- none of which is a colour.
//
// lipgloss's ANSIColor is an ansi.IndexedColor and satisfies image/color.Color,
// so it goes wherever a hex colour would.
var (
	Yellow  = lipgloss.ANSIColor(3)  // interaction, brand, armed strip
	Teal    = lipgloss.ANSIColor(6)  // data / primary numbers
	Cyan    = lipgloss.ANSIColor(14) // links, focused-elsewhere tag
	TealDim = lipgloss.ANSIColor(6)  // labels; SLabel dims it with Faint
	Red     = lipgloss.ANSIColor(1)  // errors
	Purple  = lipgloss.ANSIColor(5)  // agents
	Green   = lipgloss.ANSIColor(2)  // success, sparingly
	Grey    = lipgloss.ANSIColor(8)  // disabled, stale, timestamps
	White   = lipgloss.ANSIColor(15) // session names
	Edge    = lipgloss.ANSIColor(8)  // hairline rules
	Frame   = lipgloss.ANSIColor(8)  // pane frame
)

// Indexes is the closed set of ANSI indices a frame may contain. The palette
// test asserts nothing outside it is emitted, and -- the point of the whole
// exercise -- that no 24-bit sequence is emitted at all.
var Indexes = []int{1, 2, 3, 5, 6, 8, 14, 15}

// CtxColor returns the threshold colour for a context percentage, matching the
// browser's renderTiles: teal below 65%, yellow from 65%, red from 85%.
func CtxColor(pct float64) color.Color {
	switch {
	case pct >= 0.85:
		return Red
	case pct >= 0.65:
		return Yellow
	default:
		return Teal
	}
}
