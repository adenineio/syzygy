package theme

import (
	"image/color"

	"charm.land/lipgloss/v2"
)

// Base is the ground every style is built on. It paints no background at all,
// so the terminal's own ground shows through every cell the pane emits and the
// pane sits in the window rather than on top of it.
func Base() lipgloss.Style { return lipgloss.NewStyle() }

// On returns a foreground style.
func On(c color.Color) lipgloss.Style { return Base().Foreground(c) }

// Bold returns a bold foreground style.
func Bold(c color.Color) lipgloss.Style { return Base().Foreground(c).Bold(true) }

// Dim returns a faint foreground style. Once the colour itself belongs to the
// terminal there is no dimmer variant to reach for, so the dimming is an
// attribute and the scheme still chooses the hue.
func Dim(c color.Color) lipgloss.Style { return Base().Foreground(c).Faint(true) }

// Invert puts the colour behind the text instead of in it: the brand block,
// the active mode tab, the armed-confirmation strip and the chips.
//
// It uses reverse video rather than an explicit background/foreground pair,
// so the text takes the terminal's own background colour. That is what keeps
// the block legible on a light scheme as well as a dark one -- an explicit
// near-black foreground would vanish into a light terminal's ground.
func Invert(c color.Color) lipgloss.Style {
	return Base().Foreground(c).Reverse(true).Bold(true)
}

// The named styles the views use.
var (
	SBg      = Base()
	STick    = On(Yellow)   // the phead tick, U+258C
	SLabel   = Dim(TealDim) // dim uppercase panel label
	SRule    = On(Edge)     // hairline rule
	SValue   = On(Teal)     // primary numbers
	SBody    = Base()       // body text: the terminal's default foreground
	SName    = Bold(White)  // session names
	SDim     = On(Grey)     // disabled / stale / timestamps
	SWarn    = On(Yellow)
	SErr     = On(Red)
	SAgent   = On(Purple)
	SOK      = On(Green)
	SLink    = On(Cyan)
	SBrand   = Invert(Yellow)
	STab     = Invert(Yellow)
	STabOff  = Dim(TealDim)
	SArmed   = Invert(Yellow)
	SChipErr = Invert(Red)
	SChipDny = Invert(Yellow)
	// SCursor marks BOARD's cursor row. The first design called for a panel
	// background #141b23, which predates the pane inheriting the terminal's
	// scheme: nothing here paints a background any more. So the cursor row is
	// reverse video, the way the brand block and the tabs are -- but with no
	// colour of its own, so it swaps the terminal's own ground and foreground
	// and stays legible on a light scheme as well as a dark one.
	SCursor = Base().Reverse(true)
)
