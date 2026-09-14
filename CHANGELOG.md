# Changelog

## 0.2.0 — 2026-09-13

### The band (`syzygy`)

- **The context meter escalates by threshold and ends in an alarm.** Rounding onto
  five glyphs put the dark moon past 87%, long after the answers drift. One table
  now holds six steps — dark at two thirds, a warning glyph past three quarters.
- **A project's hotkey file is read at the worktree root**, from `git rev-parse
  --show-toplevel`. Read beside the session's working directory before, a session in
  a subdirectory read one file while the terminal pane's editor wrote another.
- **A registered tool answers with a plain string.** Claude Code 2.1.270 validates a
  result as a string, a content-block array or nothing; the tools returned a nested
  object, so the side effect ran and the model got a shape error instead.

### The pasteboard

- **Stash a prompt instead of sending it.** A prompt starting with `,,` is never
  sent — it goes onto a pasteboard, reloadable into any session's composer. `,,,`
  uses a global board and `,,@title ` attaches a title.
- **A marker, because the composer cannot be read** — a plugin can fill the box or
  submit it, never read one back. A refusal writes the original straight back, with
  the draft's first 200 characters in the reason in case that fails too.
- **An unusable marker disables the feature** rather than falling back to the
  default, and caps of 100 entries, 32 KB and 2 MB refuse a stash rather than
  dropping an older one — a stashed prompt exists nowhere else.
- **Both panes reach it**: a drawer section and a rail panel in the browser, and
  PASTE on digit `3` in the terminal, where `x` twice deletes.

### The browser dashboard

- **The event stream is a registry and the drawer is its own file.** Any file can
  subscribe by event or by payload field; eighteen handler bodies left one
  `connect()` to register beside the feature they serve. No behaviour change.
- **Subagent state on the card face and the canvas node** — one attribute, three
  values, a bar down the right edge. The left edge is already the working state's,
  so a session can be idle with eight agents running and both edges say so.
- **Two corner styles, and a rule about the tokens.** Space-age comes out, and the
  tool feed now ships collapsed. Every new surface reads `--r-surface` /
  `--r-control` / `--r-input` rather than a hard-coded radius.
- **A payload version and a build stamp on `/api/health`**, so a stale relay and a
  missing feature stop being indistinguishable. That route, because it is the one
  the auth gate allows unconditionally.
- **Spawn a wired session from the canvas's plus column.** Drop a dragged wire on
  the gutter and the form opens with the source, its directory and a message to send
  on link; ⇧ inherits the source's model and effort, ⌥ wires it and sends nothing.
- **A link is promised before the other end exists** and claimed when the child
  registers — never from a session that started first, and two candidates mean do
  nothing and say so.
- **The board emptying is broadcast.** When the *last* session expired no frame
  fired and both panes kept ghosts until a reload; the relay now compares the set of
  ids it last broadcast, immune to which timer pruned.
- **Projects is one row per project.** Opening one collapses the rest into a rail
  and lays out its worktrees, todo lists, features and history by branch, with
  buttons to file a plan or a request, or scope a question to it.
- **The snapshot stopped growing with the board.** Every worktree carried a summary
  of every plan it inherited, so a real board sent megabytes the pane could not
  drain. Plans travel as counts now, and a plan's steps load when it is opened.
- **Sandbox** — a gallery for trying a UI component against the real board or
  generated stand-in data. Its own DOM sits in 3D space, keeping selectable text and
  native clicks, behind one calm dial.
- **Session space** — every live session as a floating card on one 3D stage, and
  eight buckets along the bottom holding a shape you build once and reapply: gather
  the panes into a tmux window, send a saved prompt, name a set of files, mark a set
  as belonging together. ⌥ held picks a card up and it keeps following after the key
  is released, because the hand still has to reach the bucket row.
- **Projects drills in one gesture, repeated.** The list narrows into the rail, the
  panels fan out beside it, and Escape is the literal reversal. Two engines — DOM
  and the 3D stage — behind one Motion dial in the gear, and the deepest level is
  the same layout whether the library loaded, WebGL exists, or motion was refused.
- **Syzygy's own usage.** A Telemetry section counts every model call the platform
  makes for itself — refiner, pattern pass, orchestrator, scoping, liaison, band —
  from each child's own reported cost, never a second estimate. Your usage window is
  account-wide, so it says what the platform spent, not what share of it that took.

### Dispatch

- **Scoping is one live session, not a fork.** Joining it in a terminal is the same
  conversation: turns from the dashboard reach the terminal, turns typed there land
  in the brief. Writing the brief ends it, and so does 24 hours with nobody home.
- **A title proposes itself** from what you wrote below it, and one you type wins.
- **Fan out a rambling ask.** One call splits what you typed into draft requests,
  one per project, each owning whole paragraphs rather than a rewrite — so a wrong
  boundary is fixed by moving a paragraph.
- **A section's title bar toggles it tall**, so a capped list — the scoping thread
  included — reads at full height instead of scrolling in a short box. ⇧-click makes
  it the only tall one, and the set is remembered per browser.

### The orchestrator and the command bar

- **A command bar asks from anywhere.** ⌘⇧Enter, or ⌘⇧K, opens a bar high in the
  pane; ⌘Enter starts a conversation, ⌥⇧P pins, ⌘K clears, ↑/↓ recall questions. The
  chord is caught on `window` in the capture phase, so it works inside a reply box.
- **Conversations survive a reload and a relay restart**, each kept on disk with its
  own resume id, pinnable, renameable and returned to.
- **Replies render as markdown, and the sent question shimmers while it waits** — in
  place of three dots in an empty reply box, stopping the instant real text arrives
  rather than on a timer, and dimming instead of sweeping under the calmest Motion
  setting. Links render only where they point at `http:` or `https:`.
- **A quick-access deck behind the option key** — up to ten cards: favourite
  sessions, presets, recent projects, and the one thing waiting on you. The digits
  are fixed bands, so an empty slot stays dim rather than shifting the rest.
- **One steering click can reach the whole fleet.** ⇧-click broadcasts to every live
  session and ⌥-click opens a subset picker. An oversized set is refused rather than
  truncated — a shortened broadcast is still an instruction some will follow.
- **Findings are a shared, structured store.** `report_finding` writes one fact that
  would change another session's work, never a recommendation. Line evidence is
  *reported* by the store and *enforced* by the tool.
- **The architecture sweep** spawns one fresh session to read every finding across
  every project, ask the two rabbit-hole questions of the whole build rather than one session's
  slice, and report back with one finding call — even a clean sweep makes it.
- **Proposed skills.** A pass writes up what you keep doing as candidate skills —
  the idea, a methodology somebody else could follow, `file:line` evidence — behind
  two gates and a budget, applying nothing. Rated by digit and never deleted.

### Usage windows and the after-reset queue

- **Resuming what the limit froze.** Claude Code waits out a usage limit for an
  interactive session, but not for a background one, a restarted terminal, the weekly
  window or a whole fleet. Armed, the relay prompts each of those once at the reset.
- **The queue takes three kinds.** `prompt` and `implement` are joined by `plan`, in
  a three-tab create form where `w` flips the window, Shift fires an entry now
  through the very function the scheduler calls, and Option duplicates a row.
- **Night hours, off unless you turn them on.** At most one plan per qualifying
  reset, and only one with a spec line, no progress and no owner. The run gets its
  own worktree and branch and is left where it stopped, never merged or deleted.
- **A watchdog in the relay, not only a flag on the argv.** The CLI documents its
  flag for a printing session, so the relay polls an unattended session's spend and
  running time itself; its own two unattended calls stop at $3.00 a day each.

### Session presets

- **Save the kind of session you keep starting** — a kickoff prompt, a model and an
  effort, with optional skills, tools to pre-approve and a persona. Chips over the
  spawn and create forms apply one into fields you can see; what cannot be shown in
  a field stays on the chip.
- **Personas are off unless you turn them on.** The toggle installs every preset
  with a persona as an agent, in a plugin the dashboard writes and validates; one
  that fails to load costs the persona, never the session.

### The topic chain

- **Every session builds a chain of the topics it has been through**, each block a
  title, a short summary and a progress note — the shape of the conversation rather
  than its transcript.
- **Building it costs no model call in the session.** The band sends one small
  record per finished turn, and a fixed rule opens each block: a pivot phrase, half
  an hour of silence, forty turns, or a turn overlapping neither words nor files.
- **The refiner rewrites the recent past, and only that.** A headless child retitles
  and summarises the open block and the three before it, and may move, split or
  merge among them — never touching a block you pinned or edited.
- **Pins, edits, history and rebuild.** CHAIN in the terminal pane pins, merges,
  splits, refines, rebuilds from the transcript and scrubs the chain as it stood
  after each of its last twenty rewrites; `GET /api/chains/export` publishes it.

### Peering

- **Two instances on two machines can pair.** Off until you turn it on: until then
  no listener exists and nothing binds. Pairing is a one-shot code, and until both
  sides compare fingerprints and confirm, each gives that peer its health only.
- **Health, and a read-only roster.** A heartbeat every 15 s turns a peer's dot
  green or down-with-a-reason and reports the round trip and clock difference. A
  confirmed peer's row carries one read-only card per session on the other board.
- **Asks, answered by the other instance's liaison** — a fresh orchestrator turn
  from that board's own state, never a continuation of the other person's
  conversation. Proposed actions are buttons *there*, and only a count comes back.
- **Two caps and a held ask.** Each peer has an asks-an-hour and a dollars-a-day
  cap, and an ask past either runs nothing and sends nothing back until somebody
  lets that one through.
- **Files move too, through a script you write.** A drop is a set of files sent as a
  durable job on disk: only the path list is ever text a model sees, and the bytes go
  relay to relay in resumable chunks, so a restart picks up where it left off.
- **The filtering is yours, at either end.** An executable named `peer-filter` runs
  on every drop, sending and receiving alike, and the relay trusts only what it finds
  under the script's own output, hashed itself.
- **Nothing a peer sends can be read until you say so.** A received drop is
  quarantined, verified byte for byte and filtered before it reaches the inbox;
  copying it into a worktree is one more click, which never overwrites.
- **The Peering tab** (digit `8`) carries the link's controls along the top and,
  below them, every exchange as one row: time, direction, peer, kind, a summary,
  size and redaction count. A row opens the exchange as text, never rendered.
- **A floor under what leaves your computer.** Everything sent to a peer is redacted
  at the two functions every peer byte passes through: a home directory and user name
  become `~`; the hostname, addresses, tokens and keys become `[redacted]`. It fails
  closed, and the Safeguard card counts what was caught.
- **The Jobs region lists every drop in either direction**, its files, and what
  landed or was refused, with the tab's badge counting arrivals nobody has looked at.
  A session started for a peer wears a `for <peer>` chip wherever its card is drawn.

### The terminal side pane

- **BOARD flags a session that is waiting on you** with ⚑ where its working dot
  would be, and its detail row says what it is waiting for.
- **Nothing destructive fires on one keypress.** `x` closes the session under the
  cursor and `X` kills its subagents, but the first press only raises a
  black-on-yellow strip with a three-second countdown, and it is never clickable.
- **`space` is a leader key**, opening a second bank of modes without spending a
  tab; `space ?` lists it and `space c` opens the focused session's chain.
  `alt+enter` on BOARD jumps to a session's own terminal.
- **GRID draws the links between sessions** as dim braille wires routed through the
  gaps between cards, `w` hiding them and `W` keeping only the cursor card's.
  Control characters in what a session reports are replaced before drawing.
- **The pane's Go tests run inside `just test-all`**, so one gate covers both
  languages.

### The macOS app shell

- **Syzygy in the Dock, built on your own machine.** No `.app` and no download ships
  — the release carries the shell's source and its packaging script. `just app` runs
  it from source, `just app-build` packages `Syzygy.app` for that machine with an
  ad-hoc signature, and `just app-install` puts it in `~/Applications`.
- **It shows the pane the relay already serves**, never a bundled copy, so the window
  cannot be a version behind. It finds the relay on the configured port or starts one
  the way a session does, and quitting never stops it. One sandboxed window, no title
  bar, the views on ⌘1-⌘7, and an icon generated from the pane's own mark.

### Open a file named in the chat (`syzygy-editor`)

- **A folder opens in Finder.** A directory reference in Claude's reply is drawn as
  `[ src/app/ ]` — the trailing slash is what tells it from a file — and pressing it
  opens a Finder window. The existence cache stores the kind rather than a boolean.
- **macOS only, detected once with a bare `uname`**, not `uname -a`, which prints
  the hostname too and turns an equality into a substring search a machine called
  `foo-darwin` would pass. Every failure means "not macOS".

## 0.1.0 — 2026-09-12

First public release.

### The band (`syzygy`)

- **One row above the prompt, enforced.** `AbovePrompt` clips a tree taller than
  `maxRows` and disarms every hotkey inside it, so the one-row fit is a
  construction rather than a hope. A vitals row above it drops fields by
  **priority rather than position** and spills what it drops onto a second row
  when there is height.
- **The real context window**, read from the `statusLine` payload's
  `context_window.context_window_size` — the only place it is observable from
  outside a session — keyed by session id, because another session's reading
  divided into this session's tokens is a confident wrong answer. Falls back to
  a model → context-window table.
- **Live spend, throughput, model, branch, diff, guardrail count and a stuck
  detector.** Token counts are read from the session transcript JSONL
  incrementally by byte offset and de-duplicated by `message.id`, because
  `turn.complete` carries no usage at all.
- **A context pie that runs full to empty as context is consumed** — the glyph
  gauges what is left while the numbers count what is used. Two glyph sets, moon
  and circle; the moons carry VARIATION SELECTOR-16 so the full moon renders in
  colour rather than as a monochrome outline on font stacks that contain only
  that one phase.
- **Ten digit hotkeys, and ten is the ceiling** — a band hotkey must be a single
  digit. `1` toggles the terminal side pane, `4` asks *what now?*, and the other
  eight are user prompt slots from `~/.claude/syzygy-hud-hotkeys.json`, with a
  per-worktree override that can also hide a global slot.
- **Twenty-two turn spinners**, pure functions of their frame so a repaint at the
  same frame draws the same thing. `just spinners` lists them, `just spinner
  <id>` pins one, and an opt-in picker row in the band cycles them live.
- **Rename your own session** from the board, through `$.command.run` — the
  sanctioned door, not a slash command typed into the composer.

### The browser dashboard

- **A local relay on loopback** that every session joins on `session.start`, with
  a live SSE stream to every open pane. It starts itself.
- **Control** — the switchboard. One card per session with name, model, context,
  spend, what it last said and whether it is waiting on you. A left rail carries
  the overview metrics, the presence sphere, the tool feed and steering.
- **A WebGL presence sphere** whose particles are real agent state: three looks
  (`iris`, `streams`, `shell`), live sessions as orbiting sub-swarms with angles
  accumulated on the CPU, per-state colour (working, waiting, error, idle) and a
  mood that fades rather than snaps. Falls back to a 2D orb with no WebGL2, and
  rebuilds itself on a lost-and-restored context.
- **A session drawer** — read the full last answer, reply to it, rename it, see
  its subagents and TODOs, jump to its terminal, or close it.
- **Jump to a session's real terminal.** Four cases: in tmux (switch the client,
  select the pane, raise the terminal app resolved from the client's process
  tree), a background session (a new tmux window running `claude attach`), a dead
  process (`claude --resume`), and live-but-outside-tmux, which reports its tty
  and the command to copy because there is no promptless way to raise it.
- **Close a session** — `claude stop` for a background one, a `SIGTERM` to the
  registered pid for an interactive one, never a pattern kill. Two-step armed
  confirm.
- **Steering** — buttons that *arm* a command; you then pick the session, or hold
  a key to send to all. Register your own; a status ping and a go-autonomous
  button ship with it.
- **Telemetry** with a replay scrubber down the right-hand column.
- **Projects** — git topology across worktrees, plans in flight with their
  reported/verified progress, the backlog, and who is working on what.
- **Canvas** — sessions as draggable nodes with their wires, a spawn form with
  directory typeahead, and position inheritance so a restarted session keeps its
  place.
- **Drag one card onto another** to open a channel over Claude Code's own
  cross-session messaging bus. A real message, and a landed drag collects one.
- **Usage windows** — the account's 5-hour and 7-day limits on the board, with a
  sparkline of the readings and a queue that can fire a green light after a reset.
- **Per-session card colours**, five themes, three corner styles, and a tooltip
  system the deck owns.
- **Password-gated**, with scrypt hashing and an HMAC session cookie, both
  compared with `timingSafeEqual`. Every write passes one `authed()` check;
  every read is behind the same gate except `/api/health`.
- **Voice input** — `openai-whisper` in a uv-managed venv, entirely on your
  machine. Installed on request from the gear, never by default.

### Dispatch

- **A queue** of requests, authoritative on disk (temp file then rename, so a
  failed serialize leaves the previous file intact).
- **Scoping** — a `claude -p` conversation that asks one question at a time and
  then emits a structured brief against a JSON schema.
- **Dispatch** — a git worktree and a branch per brief, and a `claude --bg`
  session started in it. `plan ready` is gated on the exact plan path recorded at
  dispatch time, never "the newest markdown in `docs/plans/`" — a worktree
  inherits every already-committed plan file, so a directory scan made "no plan"
  unreachable.
- **Model and effort pickers** read from the resolved binary's own `--help` at
  boot, not assumed.
- **Take over in a terminal**, with the fork that creates made visible rather
  than silent.

### The orchestrator

- **Ask a question about the whole board** and get an answer that has read it:
  every session, the canvas, the queue, the project's plans and backlog, and the
  findings other sessions have reported. Budgeted, capped and priority-ordered
  into 80 KB.
- **It proposes; a human applies.** Four action kinds — link, prompt, dispatch,
  spawn — each applied by a click, never automatically, and every applied action
  is written to an append-only capture log.
- **A findings store** so sessions report what they learned as structured
  records with `file:line` evidence, rather than as a truncated tail of their
  last message.
- **A board blurb** that summarises everything in one line, refreshed on a timer
  with three gates so it cannot cost money for nothing.

### The terminal side pane (`pane-v2`)

- **The same board in a tmux split**, in Go and Bubbletea. Modes for the grid,
  the switchboard, the feed, the patch bay, MINE, vitals and HOTKEYS.
- **It inherits the terminal's colour scheme** rather than painting its own, and
  asks the terminal for its RGB capability rather than trusting `$COLORTERM`
  (which the Charm v2 stack ignores under tmux).
- **It assumes nothing from your `tmux.conf`** — pane ids rather than indices, its
  own border styles and `remain-on-exit` set per pane, and a tmux version check
  that says what it found.
- **Mouse support**, a drag wire drawn as a simulated cable, and two animated
  instruments in VITALS (Orrery and Galvanometer) driven by real agent counts and
  the real token series.

### Open a file from the chat (`syzygy-editor`)

- **A file reference in Claude's reply that exists on disk** is drawn as a
  pressable box in the transcript; a click splits a tmux pane beneath the session
  running your editor. The pane closes itself when the editor exits.
- **Two more routes**, because a mouse is not always there: the `open_in_editor`
  tool, and `syzygy-edit <path>` from any shell inside tmux.
- **Editor precedence** `$SYZYGY_EDITOR` → config → `$VISUAL` → `$EDITOR` → nvim
  → vi, and the vi family reuses one pane with `:e` rather than stacking panes.

### Experimental, opt-in (`forge`)

- **`create_tool`** mints a repeated sequence of tool calls into one named,
  deterministic tool that persists for the project across sessions.
- **`json_query`, `regex_test`, `text_diff`** — exact operations, to replace
  hallucinated parsing.
- Not linked by `just install`; `just install-forge` adds it.

### Tooling

- **`just --list` is the command menu** and the justfile is the single source of
  truth for every command.
- **Three gates**, and `just verify` runs them plus the pane's syntax check and
  the plan gates: `check` (tsc against the generated declarations), `validate`
  (`claude plugin validate --strict`, which prints every `$` call each module
  makes), and `test-all`.
- **`just deps-check`** says what is on the machine and what each missing item
  costs.
- **`just statusline-install`** wraps an existing `statusLine` command rather
  than replacing it.
- **Plan progress in three states** — todo, *reported* by the executor, and
  *verified*, which refuses to be written without a commit range, a verification
  command with its exit status and a review verdict. An executor may never verify
  its own work.
