package ui

import "charm.land/bubbles/v2/key"

// Mode is the pane's mode enum. Every mode but CONSOLE is implemented; that
// one switches and renders a "not built yet" placeholder.
type Mode int

const (
	// ModeVitals is the read-only glanceable mode.
	ModeVitals Mode = iota
	// ModeFeed is the scrolling event feed.
	ModeFeed
	// ModeConsole is not built yet.
	ModeConsole
	// ModeBoard is the switchboard.
	ModeBoard
	// ModeGrid is the patch bay: cards, drag-to-link, the notes form.
	ModeGrid
	// ModeMine is this session's own claims: its plans and claimed backlog
	// sections, filtered by the id ident resolved.
	ModeMine
	// ModeHotkeys edits the AbovePrompt band's eight prompt slots, in the
	// global config file or in this worktree's override.
	ModeHotkeys
)

// Built reports whether a mode has a real implementation yet.
func (m Mode) Built() bool { return m != ModeConsole }

// ListsAll reports whether a mode already shows every session, so the OTHERS
// footer would only repeat the body.
func (m Mode) ListsAll() bool { return m == ModeBoard || m == ModeGrid }

// DrawsAtXS reports whether a mode has anything to say in the vertical strip
// under 30 columns. Only 1 and 2 do, and pressing 3 or 4 there
// shows the two-line notice instead.
func (m Mode) DrawsAtXS() bool { return m == ModeVitals || m == ModeFeed }

// Label is the tab caption at L and M.
func (m Mode) Label() string {
	switch m {
	case ModeFeed:
		return "FEED"
	case ModeConsole:
		return "CONSOLE"
	case ModeBoard:
		return "BOARD"
	case ModeGrid:
		return "GRID"
	case ModeMine:
		return "MINE"
	case ModeHotkeys:
		return "HOTKEYS"
	default:
		return "VITALS"
	}
}

// Short is the tab caption at S.
func (m Mode) Short() string {
	switch m {
	case ModeFeed:
		return "FEED"
	case ModeConsole:
		return "CON"
	case ModeBoard:
		return "BRD"
	case ModeGrid:
		return "GRD"
	case ModeMine:
		return "MINE"
	case ModeHotkeys:
		return "KEYS"
	default:
		return "VIT"
	}
}

// Tiny is the tab caption when even the short captions don't fit every mode
// on the strip -- a single letter, the tab strip's third and last fallback
// tier. A two-tier abbreviation (full, then short) fits five modes; a sixth
// makes the short strip overflow at the narrowest tested width (30
// columns), so tabSpans falls back once more here rather than silently
// truncating a tab off the row.
//
// HOTKEYS made that seventh tab, and it costs the short tier at 41 columns
// too: seven short captions need 43 cells and the user's pane has 41, so the
// strip there is now single letters. That is arithmetic, not a choice -- six
// short captions already totalled exactly the 20 label cells 41 columns can
// hold, so ANY seventh tab drops it a tier. Single letters are the price of
// the tab being on the strip at all; silently truncating one off the row, or
// hiding the mode from the strip while binding a digit to it, are both worse.
func (m Mode) Tiny() string {
	switch m {
	case ModeFeed:
		return "F"
	case ModeConsole:
		return "C"
	case ModeBoard:
		return "B"
	case ModeGrid:
		return "G"
	case ModeMine:
		return "M"
	case ModeHotkeys:
		return "H"
	default:
		return "V"
	}
}

// ParseMode maps the --mode flag.
func ParseMode(s string) Mode {
	switch s {
	case "feed":
		return ModeFeed
	case "console":
		return ModeConsole
	case "board":
		return ModeBoard
	case "grid":
		return ModeGrid
	case "mine":
		return ModeMine
	case "hotkeys", "keys":
		return ModeHotkeys
	default:
		return ModeVitals
	}
}

// AllModes is the tab strip order.
var AllModes = []Mode{
	ModeVitals, ModeFeed, ModeConsole, ModeBoard, ModeGrid, ModeMine, ModeHotkeys,
}

// GlobalKeys are live in every mode. Every one of them is blind-safe except
// quit, which is harmless but closes the pane.
type GlobalKeys struct {
	Vitals    key.Binding
	Feed      key.Binding
	Console   key.Binding
	Board     key.Binding
	Grid      key.Binding
	Mine      key.Binding
	Hotkeys   key.Binding
	Next      key.Binding
	Prev      key.Binding
	Home      key.Binding
	Help      key.Binding
	Reconnect key.Binding
	Esc       key.Binding
	Quit      key.Binding
}

// VitalsKeys are the mode-1 bindings. Vitals is read-only, so scrolling and
// the spinner picker are all there is. s and S cycle the pane's own spinner;
// neither is bound anywhere else, and both are safe to press blind.
type VitalsKeys struct {
	Up       key.Binding
	Down     key.Binding
	SpinNext key.Binding
	SpinPrev key.Binding
}

// FeedKeys are the mode-2 bindings. The feed draws newest first, so the top of
// the list is the newest event: g goes to the top and re-pins follow, G goes to
// the bottom, which is the oldest event the relay still holds.
type FeedKeys struct {
	Up       key.Binding
	Down     key.Binding
	PageUp   key.Binding
	PageDown key.Binding
	Newest   key.Binding
	Oldest   key.Binding
	Follow   key.Binding
}

// BoardKeys are the mode-4 bindings.
//
// The x kill is deliberately absent: it is specified as an armed action and
// the armed strip does not exist yet. A key that silently does nothing is
// worse than no key, and an unconfirmed kill is worse than either, so x lands
// with the strip rather than before it.
type BoardKeys struct {
	Up    key.Binding
	Down  key.Binding
	Focus key.Binding
	Link  key.Binding
}

// GridKeys are the mode-5 bindings. l is link, as on BOARD, so the right
// arrow alone steps right.
type GridKeys struct {
	Up, Down, Left, Right    key.Binding
	Link, Batch, Undo, Notes key.Binding
}

// MineKeys are the mode-6 bindings. MINE is read-only, like VITALS, so
// scrolling is all there is.
type MineKeys struct {
	Up   key.Binding
	Down key.Binding
}

// HotkeysKeys are the mode-6 bindings. Clear is the one destructive key in
// the pane, so it is a two-press confirm rather than a single stroke: the
// armed strip that would replace it does not exist yet, and an unconfirmed
// destructive key is worse than no key at all.
type HotkeysKeys struct {
	Up, Down      key.Binding
	Edit, Clear   key.Binding
	Scope, Reload key.Binding
}

// FormKeys are live only while the notes form is open; every other key types.
// Fill is the odd one out: it has to be a chord, because a bare key inside a
// text field is a character.
type FormKeys struct {
	Next, Tab, Prev, Close, Fill key.Binding
}

// KeyMaps is the whole set.
type KeyMaps struct {
	Global  GlobalKeys
	Vitals  VitalsKeys
	Feed    FeedKeys
	Board   BoardKeys
	Grid    GridKeys
	Mine    MineKeys
	Hotkeys HotkeysKeys
	Form    FormKeys
}

// DefaultKeys builds the bindings.
func DefaultKeys() KeyMaps {
	return KeyMaps{
		Global: GlobalKeys{
			Vitals:    key.NewBinding(key.WithKeys("1"), key.WithHelp("1-5,m", "mode")),
			Feed:      key.NewBinding(key.WithKeys("2"), key.WithHelp("2", "feed")),
			Console:   key.NewBinding(key.WithKeys("3"), key.WithHelp("3", "steer")),
			Board:     key.NewBinding(key.WithKeys("4"), key.WithHelp("4", "board")),
			Grid:      key.NewBinding(key.WithKeys("5"), key.WithHelp("5", "grid")),
			Mine:      key.NewBinding(key.WithKeys("m"), key.WithHelp("m", "mine")),
			Hotkeys:   key.NewBinding(key.WithKeys("6"), key.WithHelp("6", "hotkeys")),
			Next:      key.NewBinding(key.WithKeys("tab"), key.WithHelp("tab", "next mode")),
			Prev:      key.NewBinding(key.WithKeys("shift+tab"), key.WithHelp("shift+tab", "prev mode")),
			Home:      key.NewBinding(key.WithKeys("0", "home"), key.WithHelp("0", "home")),
			Help:      key.NewBinding(key.WithKeys("?"), key.WithHelp("?", "help")),
			Reconnect: key.NewBinding(key.WithKeys("R"), key.WithHelp("R", "reconnect")),
			Esc:       key.NewBinding(key.WithKeys("esc"), key.WithHelp("esc", "cancel")),
			Quit:      key.NewBinding(key.WithKeys("q", "ctrl+c"), key.WithHelp("q", "quit")),
		},
		Vitals: VitalsKeys{
			Up:       key.NewBinding(key.WithKeys("k", "up"), key.WithHelp("j/k", "scroll")),
			Down:     key.NewBinding(key.WithKeys("j", "down"), key.WithHelp("j/k", "scroll")),
			SpinNext: key.NewBinding(key.WithKeys("s"), key.WithHelp("s", "spinner")),
			SpinPrev: key.NewBinding(key.WithKeys("S")),
		},
		Feed: FeedKeys{
			Up:       key.NewBinding(key.WithKeys("k", "up"), key.WithHelp("j/k", "scroll")),
			Down:     key.NewBinding(key.WithKeys("j", "down"), key.WithHelp("j/k", "scroll")),
			PageUp:   key.NewBinding(key.WithKeys("pgup", "u"), key.WithHelp("d/u", "page")),
			PageDown: key.NewBinding(key.WithKeys("pgdown", "d"), key.WithHelp("d/u", "page")),
			Newest:   key.NewBinding(key.WithKeys("g"), key.WithHelp("g/G", "ends")),
			Oldest:   key.NewBinding(key.WithKeys("G"), key.WithHelp("g/G", "ends")),
			Follow:   key.NewBinding(key.WithKeys("f"), key.WithHelp("f", "follow")),
		},
		Board: BoardKeys{
			Up:    key.NewBinding(key.WithKeys("k", "up"), key.WithHelp("j/k", "move")),
			Down:  key.NewBinding(key.WithKeys("j", "down"), key.WithHelp("j/k", "move")),
			Focus: key.NewBinding(key.WithKeys("enter"), key.WithHelp("enter", "focus")),
			Link:  key.NewBinding(key.WithKeys("l"), key.WithHelp("l", "link")),
		},
		Grid: GridKeys{
			Up:    key.NewBinding(key.WithKeys("k", "up"), key.WithHelp("j/k", "move")),
			Down:  key.NewBinding(key.WithKeys("j", "down"), key.WithHelp("j/k", "move")),
			Left:  key.NewBinding(key.WithKeys("h", "left"), key.WithHelp("h/→", "step")),
			Right: key.NewBinding(key.WithKeys("right"), key.WithHelp("h/→", "step")),
			Link:  key.NewBinding(key.WithKeys("l"), key.WithHelp("l", "link")),
			Batch: key.NewBinding(key.WithKeys("b"), key.WithHelp("b", "batch")),
			Undo:  key.NewBinding(key.WithKeys("u"), key.WithHelp("u", "undo")),
			Notes: key.NewBinding(key.WithKeys("enter"), key.WithHelp("enter", "notes")),
		},
		Mine: MineKeys{
			Up:   key.NewBinding(key.WithKeys("k", "up"), key.WithHelp("j/k", "scroll")),
			Down: key.NewBinding(key.WithKeys("j", "down"), key.WithHelp("j/k", "scroll")),
		},
		Hotkeys: HotkeysKeys{
			Up:     key.NewBinding(key.WithKeys("k", "up"), key.WithHelp("j/k", "move")),
			Down:   key.NewBinding(key.WithKeys("j", "down"), key.WithHelp("j/k", "move")),
			Edit:   key.NewBinding(key.WithKeys("enter"), key.WithHelp("enter", "edit")),
			Clear:  key.NewBinding(key.WithKeys("x"), key.WithHelp("x", "clear")),
			Scope:  key.NewBinding(key.WithKeys("t"), key.WithHelp("t", "scope")),
			Reload: key.NewBinding(key.WithKeys("r"), key.WithHelp("r", "reload")),
		},
		Form: FormKeys{
			Next:  key.NewBinding(key.WithKeys("enter")),
			Tab:   key.NewBinding(key.WithKeys("tab")),
			Prev:  key.NewBinding(key.WithKeys("shift+tab")),
			Close: key.NewBinding(key.WithKeys("esc")),
			// alt+enter is enter with a wider reach: enter commits this note,
			// alt+enter spreads it to every note still empty. Every ctrl chord
			// a mnemonic would want -- ctrl+a, ctrl+f -- is already an editing
			// key inside textinput (line start, forward char); alt+enter is
			// claimed by neither the editor nor the form's other three.
			//
			// ctrl+g rides along for terminals that do not deliver Option as
			// Alt at all (macOS is the usual case: Ghostty's
			// macos-option-as-alt defaults to false, iTerm2 and Terminal.app
			// have their own switches). alt+enter is the documented key and
			// works here; ctrl+g is the escape hatch, and is the one chord in
			// the ctrl range that textinput's keymap does not already claim --
			// it takes a, b, d, e, f, h, k, n, p, u, v and w.
			Fill: key.NewBinding(key.WithKeys("alt+enter", "ctrl+g"), key.WithHelp("alt+enter", "fill")),
		},
	}
}

// ShortHelp is the last row's binding list for a mode, ordered by usefulness
// so the ellipsis drops the right ones first.
func (k KeyMaps) ShortHelp(m Mode) []key.Binding {
	if m == ModeFeed {
		// FEED's footer. The feed's own three keys earn the row, so the
		// mode digits and the board tab give way rather than let the ellipsis
		// eat `q quit` off the end.
		return []key.Binding{
			k.Feed.Down, k.Feed.Newest, k.Feed.Follow, k.Global.Console, k.Global.Quit,
		}
	}
	if m == ModeBoard {
		// BOARD's footer. The board's own four keys earn the row.
		return []key.Binding{
			k.Board.Down, k.Board.Focus, k.Global.Home, k.Board.Link, k.Global.Quit,
		}
	}
	if m == ModeGrid {
		// Ordered so the ellipsis at 41 columns keeps move, link, batch, quit.
		return []key.Binding{k.Grid.Down, k.Grid.Link, k.Grid.Batch, k.Global.Quit, k.Grid.Notes, k.Grid.Undo}
	}
	if m == ModeMine {
		return []key.Binding{k.Mine.Down, k.Global.Vitals, k.Global.Quit}
	}
	if m == ModeHotkeys {
		// Ordered so the ellipsis at 41 columns keeps move, edit, scope, quit
		// -- the three that change something and the one that leaves.
		return []key.Binding{
			k.Hotkeys.Down, k.Hotkeys.Edit, k.Hotkeys.Scope, k.Global.Quit,
			k.Hotkeys.Clear, k.Hotkeys.Reload,
		}
	}
	base := []key.Binding{k.Global.Vitals}
	switch m {
	case ModeVitals:
		base = append(base, k.Vitals.Down)
	}
	return append(base, k.Global.Console, k.Global.Board, k.Global.Quit)
}

// FullHelp is the ? overlay's groups.
func (k KeyMaps) FullHelp(m Mode) [][]key.Binding {
	mode := []key.Binding{}
	switch m {
	case ModeVitals:
		mode = append(mode, k.Vitals.Down, k.Vitals.SpinNext)
	case ModeFeed:
		mode = append(mode, k.Feed.Down, k.Feed.PageDown, k.Feed.Newest, k.Feed.Follow)
	case ModeBoard:
		mode = append(mode, k.Board.Down, k.Board.Focus, k.Board.Link)
	case ModeMine:
		mode = append(mode, k.Mine.Down)
	case ModeHotkeys:
		mode = append(mode, k.Hotkeys.Down, k.Hotkeys.Edit, k.Hotkeys.Clear,
			k.Hotkeys.Scope, k.Hotkeys.Reload)
	case ModeGrid:
		mode = append(mode, k.Grid.Down, k.Grid.Left, k.Grid.Link, k.Grid.Batch, k.Grid.Notes, k.Grid.Undo)
	}
	return [][]key.Binding{
		mode,
		{k.Global.Vitals, k.Global.Next, k.Global.Home},
		{k.Global.Help, k.Global.Reconnect, k.Global.Quit},
	}
}
