package ui

import "charm.land/bubbles/v2/key"

// Mode is the pane's mode enum. Every mode is implemented.
type Mode int

const (
	// ModeVitals is the read-only glanceable mode.
	ModeVitals Mode = iota
	// ModeFeed is the scrolling event feed.
	ModeFeed
	// ModePaste is the pasteboard: prompts stashed with the band's marker,
	// reloadable into a session's composer. It takes the digit CONSOLE held
	// and never built, so the strip stays at seven tabs -- an eighth would
	// move the width arithmetic again, the way HOTKEYS did.
	ModePaste
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
	// ModeChain is the focused session's topic chain: its blocks down a spine,
	// their summaries and turns, and the chain's revisions. It is reached
	// through the leader, never a digit, and is on no tab. Appended last so
	// every mode above keeps its value.
	ModeChain
)

// Built reports whether a mode has a real implementation yet. Every one does
// since PASTE took the CONSOLE slot; the method stays because --mode and the
// tab strip both ask, and the next unbuilt mode will want it.
func (m Mode) Built() bool { return true }

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
	case ModePaste:
		return "PASTE"
	case ModeBoard:
		return "BOARD"
	case ModeGrid:
		return "GRID"
	case ModeMine:
		return "MINE"
	case ModeHotkeys:
		return "HOTKEYS"
	case ModeChain:
		return "CHAIN"
	default:
		return "VITALS"
	}
}

// Short is the tab caption at S.
func (m Mode) Short() string {
	switch m {
	case ModeFeed:
		return "FEED"
	case ModePaste:
		return "PASTE"
	case ModeBoard:
		return "BRD"
	case ModeGrid:
		return "GRD"
	case ModeMine:
		return "MINE"
	case ModeHotkeys:
		return "KEYS"
	case ModeChain:
		return "CHAIN"
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
	case ModePaste:
		return "P"
	case ModeBoard:
		return "B"
	case ModeGrid:
		return "G"
	case ModeMine:
		return "M"
	case ModeHotkeys:
		return "H"
	case ModeChain:
		// Three cells, not one: a bank mode never reaches layTabs, so this is
		// read only by the header's lit block, where 41 columns leave room.
		return "CHN"
	default:
		return "V"
	}
}

// ParseMode maps the --mode flag.
func ParseMode(s string) Mode {
	switch s {
	case "feed":
		return ModeFeed
	case "paste", "pasteboard":
		return ModePaste
	case "board":
		return ModeBoard
	case "grid":
		return ModeGrid
	case "mine":
		return ModeMine
	case "hotkeys", "keys":
		return ModeHotkeys
	case "chain":
		return ModeChain
	default:
		return ModeVitals
	}
}

// AllModes is the tab strip order.
var AllModes = []Mode{
	ModeVitals, ModeFeed, ModePaste, ModeBoard, ModeGrid, ModeMine, ModeHotkeys,
}

// GlobalKeys are live in every mode. Every one of them is blind-safe except
// quit, which is harmless but closes the pane.
type GlobalKeys struct {
	Vitals    key.Binding
	Feed      key.Binding
	Paste     key.Binding
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
	// Leader is space: a prefix whose next keystroke picks from ModeBank, the
	// modes that have no digit and no tab.
	Leader key.Binding
	Quit   key.Binding
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

// BoardKeys are the mode-4 bindings. The destructive pair is a plain/modified
// one: x is about the row -- the session -- and X reaches inside it. Both are
// armed, so the first press only says what the second will do.
type BoardKeys struct {
	Up, Down   key.Binding
	Focus      key.Binding
	Link       key.Binding
	Kill       key.Binding
	KillAgents key.Binding
	Jump       key.Binding
}

// GridKeys are the mode-5 bindings. l is link, as on BOARD, so the right
// arrow alone steps right. w and W are the plain/modified pair for the settled
// wires: w shows or hides them all, W narrows them to the cursor card's own.
type GridKeys struct {
	Up, Down, Left, Right    key.Binding
	Link, Batch, Undo, Notes key.Binding
	Wires, WiresFocus        key.Binding
}

// MineKeys are the mode-6 bindings. MINE is read-only, like VITALS, so
// scrolling is all there is.
type MineKeys struct {
	Up   key.Binding
	Down key.Binding
}

// HotkeysKeys are the mode-6 bindings. Clear is destructive, so it is a
// two-press confirm on the armed strip rather than a single stroke: an
// unconfirmed destructive key is worse than no key at all.
type HotkeysKeys struct {
	Up, Down      key.Binding
	Edit, Clear   key.Binding
	Scope, Reload key.Binding
}

// PasteKeys are the mode-3 bindings. j/k move the cursor and J/K move the
// entry under it -- the modified form of the same gesture, the way a visual
// drag is the modified form of a motion in vim. Delete is the one destructive
// key, so it is a two-press confirm for exactly the reason HotkeysKeys gives.
type PasteKeys struct {
	Up, Down         key.Binding
	MoveUp, MoveDown key.Binding
	Fill, Delete     key.Binding
	Scope            key.Binding
}

// ChainKeys are CHAIN's bindings, reached with space c. Each plain key has a
// modified form one step wider: J/K jump between branches where j/k step one
// block, E opens the block full-screen where enter expands it in place, P pins
// every older block where p pins one, M merges into the block below where m
// merges into the one above, and R rebuilds the whole chain where r refines it.
// m, M, s and R are destructive, so each is a two-press confirm.
//
// R is the global reconnect everywhere else. CHAIN's handler runs before the
// global bindings, so inside this mode it rebuilds; m likewise merges here and
// opens MINE elsewhere.
type ChainKeys struct {
	Up, Down               key.Binding
	NextBranch, PrevBranch key.Binding
	Open, Full             key.Binding
	Collapse, Expand       key.Binding
	Pin, PinBack           key.Binding
	Merge, MergeNext       key.Binding
	Split                  key.Binding
	Refine, Rebuild        key.Binding
	History                key.Binding
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
	Paste   PasteKeys
	Chain   ChainKeys
	Form    FormKeys
}

// DefaultKeys builds the bindings.
func DefaultKeys() KeyMaps {
	return KeyMaps{
		Global: GlobalKeys{
			Vitals:    key.NewBinding(key.WithKeys("1"), key.WithHelp("1-5,m", "mode")),
			Feed:      key.NewBinding(key.WithKeys("2"), key.WithHelp("2", "feed")),
			Paste:     key.NewBinding(key.WithKeys("3"), key.WithHelp("3", "paste")),
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
			Leader:    key.NewBinding(key.WithKeys("space"), key.WithHelp("space", "modes")),
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
			Up:         key.NewBinding(key.WithKeys("k", "up"), key.WithHelp("j/k", "move")),
			Down:       key.NewBinding(key.WithKeys("j", "down"), key.WithHelp("j/k", "move")),
			Focus:      key.NewBinding(key.WithKeys("enter"), key.WithHelp("enter", "focus")),
			Link:       key.NewBinding(key.WithKeys("l"), key.WithHelp("l", "link")),
			Kill:       key.NewBinding(key.WithKeys("x"), key.WithHelp("x", "close")),
			KillAgents: key.NewBinding(key.WithKeys("X")),
			Jump:       key.NewBinding(key.WithKeys("alt+enter", "J"), key.WithHelp("alt+enter", "jump")),
		},
		Grid: GridKeys{
			Up:         key.NewBinding(key.WithKeys("k", "up"), key.WithHelp("j/k", "move")),
			Down:       key.NewBinding(key.WithKeys("j", "down"), key.WithHelp("j/k", "move")),
			Left:       key.NewBinding(key.WithKeys("h", "left"), key.WithHelp("h/→", "step")),
			Right:      key.NewBinding(key.WithKeys("right"), key.WithHelp("h/→", "step")),
			Link:       key.NewBinding(key.WithKeys("l"), key.WithHelp("l", "link")),
			Batch:      key.NewBinding(key.WithKeys("b"), key.WithHelp("b", "batch")),
			Undo:       key.NewBinding(key.WithKeys("u"), key.WithHelp("u", "undo")),
			Notes:      key.NewBinding(key.WithKeys("enter"), key.WithHelp("enter", "notes")),
			Wires:      key.NewBinding(key.WithKeys("w"), key.WithHelp("w", "wires")),
			WiresFocus: key.NewBinding(key.WithKeys("W")),
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
		Paste: PasteKeys{
			Up:       key.NewBinding(key.WithKeys("k", "up"), key.WithHelp("j/k", "move")),
			Down:     key.NewBinding(key.WithKeys("j", "down"), key.WithHelp("j/k", "move")),
			MoveUp:   key.NewBinding(key.WithKeys("K")),
			MoveDown: key.NewBinding(key.WithKeys("J"), key.WithHelp("J/K", "reorder")),
			Fill:     key.NewBinding(key.WithKeys("enter"), key.WithHelp("enter", "fill")),
			Delete:   key.NewBinding(key.WithKeys("x"), key.WithHelp("x", "delete")),
			Scope:    key.NewBinding(key.WithKeys("t"), key.WithHelp("t", "scope")),
		},
		Chain: ChainKeys{
			Up:         key.NewBinding(key.WithKeys("k", "up"), key.WithHelp("j/k", "move")),
			Down:       key.NewBinding(key.WithKeys("j", "down"), key.WithHelp("j/k", "move")),
			NextBranch: key.NewBinding(key.WithKeys("J"), key.WithHelp("J/K", "jump to a branch")),
			PrevBranch: key.NewBinding(key.WithKeys("K")),
			Open:       key.NewBinding(key.WithKeys("enter"), key.WithHelp("enter", "expand the block")),
			Full:       key.NewBinding(key.WithKeys("E"), key.WithHelp("E", "the block full-screen")),
			Collapse:   key.NewBinding(key.WithKeys("h"), key.WithHelp("h/l", "collapse/expand all")),
			Expand:     key.NewBinding(key.WithKeys("l")),
			Pin:        key.NewBinding(key.WithKeys("p"), key.WithHelp("p", "pin")),
			PinBack:    key.NewBinding(key.WithKeys("P"), key.WithHelp("P", "pin every older block")),
			Merge:      key.NewBinding(key.WithKeys("m"), key.WithHelp("m", "merge into the block above")),
			MergeNext:  key.NewBinding(key.WithKeys("M"), key.WithHelp("M", "merge into the block below")),
			Split:      key.NewBinding(key.WithKeys("s"), key.WithHelp("s", "split at a turn")),
			Refine:     key.NewBinding(key.WithKeys("r"), key.WithHelp("r", "refine now")),
			Rebuild:    key.NewBinding(key.WithKeys("R"), key.WithHelp("R", "rebuild; discards pins")),
			History:    key.NewBinding(key.WithKeys("t"), key.WithHelp("t", "history")),
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
			k.Feed.Down, k.Feed.Newest, k.Feed.Follow, k.Global.Paste, k.Global.Quit,
		}
	}
	if m == ModeBoard {
		// BOARD's footer. The board's own keys earn the row.
		return []key.Binding{
			k.Board.Down, k.Board.Focus, k.Global.Home, k.Board.Link, k.Board.Kill, k.Global.Quit,
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
	if m == ModePaste {
		// Ordered so the ellipsis at 41 columns keeps move, fill, scope, quit
		// -- the two that do something, the one that changes what you see, and
		// the one that leaves.
		return []key.Binding{
			k.Paste.Down, k.Paste.Fill, k.Paste.Scope, k.Global.Quit,
			k.Paste.Delete, k.Paste.MoveDown,
		}
	}
	if m == ModeChain {
		// Stands only when CHAIN's own hint row steps aside, which is with no
		// write credential, so the reading keys lead.
		return []key.Binding{k.Chain.Down, k.Chain.Open, k.Chain.History, k.Global.Quit, k.Chain.Full}
	}
	base := []key.Binding{k.Global.Vitals}
	switch m {
	case ModeVitals:
		base = append(base, k.Vitals.Down)
	}
	return append(base, k.Global.Paste, k.Global.Board, k.Global.Quit)
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
		mode = append(mode, k.Board.Down, k.Board.Focus, k.Board.Link,
			k.Board.Kill, k.Board.KillAgents, k.Board.Jump)
	case ModeMine:
		mode = append(mode, k.Mine.Down)
	case ModeHotkeys:
		mode = append(mode, k.Hotkeys.Down, k.Hotkeys.Edit, k.Hotkeys.Clear,
			k.Hotkeys.Scope, k.Hotkeys.Reload)
	case ModePaste:
		mode = append(mode, k.Paste.Down, k.Paste.Fill, k.Paste.Delete,
			k.Paste.Scope, k.Paste.MoveDown)
	case ModeGrid:
		mode = append(mode, k.Grid.Down, k.Grid.Left, k.Grid.Link, k.Grid.Batch, k.Grid.Notes, k.Grid.Undo,
			k.Grid.Wires)
	case ModeChain:
		mode = append(mode, k.Chain.Down, k.Chain.NextBranch, k.Chain.Open, k.Chain.Full,
			k.Chain.Collapse, k.Chain.Pin, k.Chain.PinBack, k.Chain.Merge, k.Chain.MergeNext,
			k.Chain.Split, k.Chain.Refine, k.Chain.Rebuild, k.Chain.History)
	}
	return [][]key.Binding{
		mode,
		{k.Global.Vitals, k.Global.Next, k.Global.Home},
		{k.Global.Leader, k.Global.Help, k.Global.Reconnect, k.Global.Quit},
	}
}
