package theme

// The glyph table. Every rune here is asserted single-width by the glyph test,
// and none is in an emoji-presentation range. Note the browser's deny shield
// U+26CA is deliberately replaced by U+2298, which does not shear rows.
const (
	GTick     = "▌" // ▌ panel head tick
	GRule     = "─" // ─ hairline rule
	GBarFull  = "━" // ━ context bar fill
	GBarEmpty = "─" // ─ context bar remainder
	GEllipsis = "…" // …
	GTool     = "⬡" // ⬡
	GTurn     = "◆" // ◆
	GAgent    = "✦" // ✦
	GNote     = "✱" // ✱
	GError    = "✕" // ✕
	GDeny     = "⊘" // ⊘
	GFlag     = "⚑" // ⚑
	GBranch   = "⎇" // ⎇
	GOn       = "●" // ● working / live
	GOff      = "○" // ○ idle
	GConn     = "◌" // ◌ connecting
	GGrip     = "⠿" // ⠿ the drag handle, the browser pane's glyph and idea
	GHere     = "▸" // ▸ this window's session
	GArrow    = "→" // → a link, from one session to another
	GElse     = "↗" // ↗ focused elsewhere
	GBrand    = "◈" // ◈
	GBoxTL    = "┌" // ┌ GRID card corners and sides
	GBoxTR    = "┐" // ┐
	GBoxBL    = "└" // └
	GBoxBR    = "┘" // ┘
	GBoxV     = "│" // │
)

// Spark is the sparkline ramp, low to high.
var Spark = []rune("▁▂▃▄▅▆▇█")

// All is every glyph the pane can draw, for the width assertion.
var All = []string{
	GTick, GRule, GBarFull, GBarEmpty, GEllipsis, GTool, GTurn, GAgent,
	GNote, GError, GDeny, GFlag, GBranch, GOn, GOff, GConn, GGrip, GHere, GArrow, GElse, GBrand,
	GBoxTL, GBoxTR, GBoxBL, GBoxBR, GBoxV,
}
