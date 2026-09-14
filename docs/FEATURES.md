# Features

What Syzygy does, described for somebody who has never seen the code. Where a
choice is surprising, the reason is here too — most of them were surprising for
a reason.

For what changed in a release, see [../CHANGELOG.md](../CHANGELOG.md).

---

## The band above the prompt

**One row, and one row by construction.** `AbovePrompt` is the one persistent,
focusable render site a plugin gets. It **clips a tree taller than `maxRows` and
disarms every hotkey inside it** — so a band that grows by one row does not look
slightly wrong, it stops working. The fit is therefore enforced by a ladder that
drops content, not hoped for.

Above the hotkey row sits a vitals row, also one line, which drops fields by
**priority rather than position**: the least useful thing goes first wherever it
happens to sit, and what it drops spills onto a second row when there is height
for it.

### What it shows

Context used and the real window size, spend, throughput, the active model, the
git branch and its diff, a guardrail count, elapsed time, and a stuck detector.

**The context window is read, not guessed.** Claude Code hands its `statusLine`
command a JSON object containing `context_window.context_window_size`, and that
is the only place the figure is observable from outside a session. The band reads
it from a side-channel drop keyed **by session id** — another session's reading
divided into this session's token count is a confident wrong answer, which is
worse than no answer. Without the side-channel installed it falls back to a
model → window table: right for the common models, silent about the rest.

**Token counts come from the transcript.** `turn.complete` carries no usage at
all — its fields are `answer`, `durationMs`, `aborted`, `turnId` and `reason` —
so the band locates the session's transcript JSONL by session id and reads it
incrementally by byte offset, de-duplicating by `message.id` because the
transcript writes one row per content block and each row carries the whole
message's usage.

### The context pie

Five steps, and **both glyph sets run full to empty as context is consumed**: the
glyph gauges what is *left* while the numbers beside it count what is *used*, the
way a fuel gauge reads. An untouched session shows a full moon and a drained one
shows a new moon.

The moon set carries VARIATION SELECTOR-16 on every phase. Without it the full
moon alone can render as a plain monochrome circle, because some symbol fonts
contain U+1F315 and none of the other four phases — so a font stack listing one
of them ahead of the colour emoji font resolves exactly one glyph of five to a
black-and-white outline. VS16 asks for the colour form and fixes every font stack
rather than asking each user to patch their terminal. It is zero-width, and the
moon still measures two columns.

### Hotkeys

`ButtonProps.hotkey` refuses letters, so a band hotkey is a **single digit** and
there are exactly ten, forever. All ten are spent: `1` toggles the terminal side
pane, `4` asks *what now?*, and `2 3 5 6 7 8 9 0` are **your prompt slots**.

Slots live in `~/.claude/syzygy-hud-hotkeys.json`, overridden per project by
`<worktree>/.claude/syzygy-hud-hotkeys.json`. **An entry with an empty prompt
hides that slot**, which is how a project turns a global slot off in a format
where absence already means "inherit".

A band hotkey cannot take a modifier and fires only on an **empty composer**, so
toggling the side pane mid-prompt needs a tmux key binding instead; the README
has the one to add to your own `tmux.conf`.

### Spinners

Twenty-two, each a **pure function of its frame**: no clock reads, no state
carried between frames, so a repaint at the same frame draws the same thing and
two panes agree. They divide the 10 Hz tick with their own `every`, and 10 fps is
the real ceiling because `$.ui.invalidate` folds calls closer together than
100 ms.

`just spinners` lists them, `just spinner <id>` pins one, and an opt-in picker
row in the band cycles them live.

---

## The browser dashboard

A local relay bound to `127.0.0.1` serves an eight-view dashboard and a live SSE
stream. Every session joins it at `session.start`; the relay starts itself, so
there is nothing to launch.

### Control — the switchboard

One card per live session: name, model, context, spend, what it last said, and
whether it is **waiting on you**.

That last one is the union of two independent signals, deliberately. Claude Code
itself knows when a session is parked at a prompt (`claude agents --json` reports
`status: 'waiting'`), and that is authoritative, so it is read rather than
inferred. The plugin supplies the other half: what a *finished* turn asked for,
classified against a fixed list of phrases — **no model call**, because a
heuristic that costs money to be wrong is a bad trade.

A left rail carries the overview metrics, the presence sphere, the tool feed and
the steering buttons.

### The presence sphere

WebGL, and the particles are real agent state rather than decoration. Three
looks, cycled by a button and remembered per browser:

- **`iris`** — particles Newton-projected onto a lattice's zero set.
- **`streams`** — closed-form differential rotation, over-blended rather than
  additive.
- **`shell`** — the same crest-capture pipeline as `iris` with capture off.

Live sessions render as **orbiting sub-swarms** with their angles accumulated on
the CPU, never `rate * uTime` in the shader — a shader-side rate change makes
every particle jump to a new phase, which reads as a glitch. Colour is per state:
working, waiting, error, idle. The mood **fades** rather than snapping, because a
board that flickers between colours is unreadable at a glance.

A browser with no WebGL2 gets an empty panel. The panel is the shader or nothing:
there is no 2D fallback and no error, because a degraded orb standing in for live
agent state is a picture of nothing. A lost context hides the canvas and stops the
render rather than latching it off for good, and a restored context rebuilds
everything — disposing every prior renderer, material and geometry, and
re-compiling each look so the first mode switch afterwards does not stall.

### The session drawer

Open a card to read its **full** last answer (not the truncated tail the card
shows), reply to it as a prompt, rename it, see its subagents and TODOs, jump to
its terminal, or close it.

**Jump to a session's real terminal** has four cases, because there are four
kinds of session and only three can be reached:

1. **In tmux** — the pane is read from Claude Code's per-pid session registry,
   the most recently active tmux client is chosen (a machine with two terminals
   attached has two clients, and switching the one nobody is looking at reads
   exactly like the jump doing nothing), then `switch-client`, `select-pane`, and
   the terminal app is raised. The app is resolved by walking up from the
   client's pid rather than hardcoded, so it works for Ghostty, iTerm, Terminal
   or WezTerm alike.
2. **A background session** — a new tmux window running `claude attach`, then
   case 1 on it. A true attach, not a copy.
3. **A dead process** — a new tmux window running `claude --resume`, then case 1.
   `--resume` starts a *copy* when the session is still running, so this is only
   ever done to a session that has exited.
4. **Live, interactive, and outside tmux** — nothing happens, and the reply says
   why: the only macOS API that raises another application's chosen window is
   Accessibility-gated, and the alternative trades that for an Automation
   prompt. **Neither is acceptable**, so this case reports the tty and the
   command to copy, and the card is marked so the state is visible *before* the
   click.

**Closing a session** uses whichever mechanism actually applies: `claude stop`
for a background or dispatched one, a `SIGTERM` to the pid it registered with for
an interactive one. **Never a pattern kill** — `pkill -f claude` on a machine
running nine sessions takes all nine plus the daemon, and this is offered per
card. The button arms on the first click and acts on a second within five
seconds.

### Steering

Buttons that **arm** a command rather than sending one: press a button, then pick
the session on the switchboard, or hold a key to send to all. Register your own;
they are validated and stored atomically, and a corrupt store is quarantined
rather than overwritten.

### Telemetry, Projects, Canvas

- **Telemetry** — the numbers over time, with a replay scrubber down the
  right-hand column.
- **Projects** — one row per project rather than per worktree, so a project
  checked out into a dozen worktrees still reads as a single line. Opening a
  project collapses the rest into a rail and lays out its worktrees, its two
  todo lists (backlog and plans in flight, never collapsed to a single
  percentage), its shipped features, and its git history by branch. A plan is
  identified by its **basename**, which is the only thing that survives being
  moved; within one worktree no two plans may share one, and a gate enforces
  it. Buttons on the project and on its rows file a plan or an implementation
  request, open its live sessions in Canvas, or scope a question to just that
  project. **A plan's steps load when you open it.** Every worktree inherits
  every committed plan, so sending them all with the board grew it to megabytes
  on a busy project; the board carries each plan's counts and current step, and
  the relay answers for one plan's steps only when that plan is one it scanned.
- **Canvas** — sessions as draggable nodes with the wires between them, a spawn
  form with directory typeahead, and **position inheritance by name** so a
  restarted session lands where its predecessor sat. It never inherits from a
  session that is still live, and never when two stale nodes share a name:
  ambiguity means do nothing, because picking one would move a card that belongs
  to somebody else.

There is **no cap on concurrent spawns** — the live count on the tab is the whole
guard, which is why the count has to be right. A spawn is recorded *before* the
await, and it **fails closed**: a spawn no successful listing has ruled on keeps
counting for up to a day, so a listing that keeps failing leaves the count high
rather than at a silent zero.

### Projects in motion

Drilling into a project is one gesture, repeated. The project list narrows into
the rail down the left, the chosen row stays lit where it already was, and the
four panels fan into the space beside it; going deeper repeats the gesture
inside the work area, where the other panels become a rail of heads, the
worktree cards compress to a strip along the top, and the git graph grows into
what is left. Escape is the literal reversal, and nothing ever leaves the screen.

**Two engines, one dial.** Text and lists are ordinary reconciled DOM animated by
a vendored motion library; the cards and the graph are drawn on the same 3D stage
the sandbox gallery uses, so a card settles under a real integrator and drifts at
rest rather than easing along a curve, always at full size rather than shrunk to
fit a grid. Both read one setting, the same **Motion** dial the gallery scales
its components with, now in the gear beside Corners and Fly-out: two dials for
one feeling is drift. Its lowest setting is zero duration everywhere, a reader
who asked the browser for reduced motion gets that whatever the dial says, and
where the library never loaded a CSS fallback plays the same durations and eases
— never a second, undocumented set of numbers.

**Motion marks a transition of meaning, never a payload tick.** A level change, a
selection, an arrival. Nothing moves because data arrived.

**One layout per level, however you got there.** The deepest level is the same
panel rail whether the library loaded, the browser has no WebGL, or the reader
asked for no motion at all — the three ladders differ in how the layout arrives,
never in where it lands. Without WebGL the cards and the graph are the plain text
list, and the panel head says so.

**The keys follow the space.** Depth is the horizontal axis, so `h` and `l` step
levels while `j`/`k` move within a column; `gg` and `G` jump the ends, and `/`
opens a real filter field over the rail rather than an invisible letter buffer.
Focus in the ask field is a mode that hands it every key, and the mode is one
word beside the lens, so a bare letter is never a surprise.

### Channels between sessions

Drag one card onto another to open a channel. It is a **real** message over
Claude Code's own cross-session messaging bus, not a simulation, and a landed
drag collects one from you to send.

### Usage windows

The account's 5-hour and 7-day rate-limit windows on the board, with a sparkline
of the readings, from the same statusline side-channel as the context figure.
A queue can hold a green light until after a reset. The queue can also hold a
brand-new session — a directory and a first prompt — to start at the reset.

**Resuming what the limit froze.** Claude Code already waits out the usage
limit and continues an interactive session on its own. What it cannot do is
the rest: a session in the background, one whose terminal restarted during the
wait, the weekly window, or a whole fleet at once. Arm **Resume after the
limit** and, when a window is spent, the relay watches for sessions that are
still registered, still alive in `claude agents`, not waiting on you, and
whose numbers stopped while the window was spent and have stayed still. The
moment the window resets — by the clock, since a fleet stopped by the limit
sends no readings at all — each of those gets one prompt to pick up where it
left off, and to stop if it had already finished. A session you closed is never
prompted. Every row on the panel says why it was admitted, a listing that
cannot vouch for a session fires nothing, and ⌥-click excludes a row before
the reset. You can also ask the orchestrator to arm it.


### Syzygy's own usage

A Telemetry section counts every model call Syzygy makes *for itself*, so you
can see how much of your spend the platform adds on top of the sessions you work
in. One row per kind — the chain refiner, the pattern pass, the orchestrator,
scoping and fan-out, the peering liaison, and the band — and three columns:
today, the last seven days, and everything on disk, each as calls and dollars,
with a total.

**The figures are the CLI's own.** Every relay-side call is a headless child, and
the ledger records the cost, tokens and duration its own final result event
reports — the same number the daily caps already spend against, never a second
estimate. A child interrupted or timed out before reporting still counts as a
call with no figure, and the caveat line says how many there were. The band's two
rows are the exception and say so: the plugin API hands back text only, so those
are tokens estimated from its length and no dollar figure at all.

**Your usage window is account-wide and cannot be split by who spent it**, so
this panel says what the platform spent, not what share of the window it took.
The sessions you work in are yours rather than the platform's, and none of them
appears here.

Click selects a row, ⇧-click opens that kind's calls in place with the site,
model, cost, tokens and duration of each, ⌥-click copies the row as text. The
ledger is one appended line per call in the relay's data directory, rolled over
past 20,000 lines; a last line torn by a crash is skipped and counted.

---

## Dispatch

The workflow the whole thing was built for: a vague ask becomes a brief, a
worktree, a branch and a session, in four steps you each approve.

1. **Queue the ask** against a project. A title is optional — leave it blank
   and one is proposed from what you write below, and a title you type
   always wins. The project must be an **absolute directory** — it becomes a
   working directory and a `tmux new-window -c`, and node reports a missing
   cwd as `spawn … ENOENT`, which reads exactly like the binary being
   missing.
2. **Scope it.** **One live background session** asks **one question at a
   time** until the thing is precise, then emits a structured brief against a
   JSON schema. **Joining it in a terminal is the same conversation**, not a
   fork — turns sent from the dashboard reach the terminal, and turns typed
   in the terminal land in the brief. Writing the brief — a structured call
   over the whole thread — ends the session, and so do cancelling, deleting,
   *end conversation*, or 24 hours passing with nobody home.
3. **Dispatch.** A git worktree and a branch per brief, and a `claude --bg`
   session started in it with the brief.
4. **Read the plan, then green-light the implementation.**

**Fan out a rambling ask.** Type everything at once, and one call splits it
into draft requests, one per project. Each draft **owns whole paragraphs of
what you typed, never a rewrite**, so a wrong boundary is fixed by moving a
paragraph — by hand, or with split mode's keys — a paragraph nobody claimed
is shown rather than dropped, and accepting a draft files it as an ordinary
request.

**`plan ready` is gated on the exact plan path recorded at dispatch time**, never
"the newest markdown in `docs/plans/`". A worktree branches from the project's
current HEAD and inherits every already-committed plan file, so a directory scan
made "no plan written" unreachable and a session that wrote nothing read as
ready.

The card's state is read from Claude Code's own `state`, never the relay's
`working` flag — which is `true` for a session parked at a permission prompt.
"Blocked — needs you" requires a `waitingFor` or a `status: 'waiting'`; a session
that simply finished without writing a plan says exactly that instead.

Model and effort pickers are read from the resolved `claude` binary's own
`--help` at boot. Ask the binary; do not assume the machine.

**A section's title bar toggles it tall.** Clicking the head of any Dispatch
section expands it to a comfortable reading height, so its capped lists — the
scoping thread included — read at full height instead of scrolling in a short
box; clicking again returns it, and ⇧-click makes that section the only tall
one. The set is remembered per browser and restored on load. One delegated
handler covers every section, so one added later behaves the same way, and the
chevron flips instantly rather than animating.

---

## The orchestrator

A field under the presence sphere. Ask a question about the **whole board** and
get an answer that has read it: every session, the canvas layout, the dispatch
queue, the project's worktrees, plans and backlog, and the findings other
sessions have reported.

The bundle is priority-ordered into a fixed 80 KB budget, so what gets cut is
chosen rather than whatever happened to be last.

**It proposes; a human applies.** Four action kinds — link two sessions, prompt
one, queue a brief, spawn a collector — each rendered as a button. Nothing it
says changes anything by itself, and every applied action is appended to a log
that rotates at 4 MB.

A **findings store** lets sessions report what they learned as structured records
with `file:line` evidence, so a collector reads records rather than a truncated
tail of somebody's last message. A record with no `surprise` field is refused
outright: it says nothing.

A **board blurb** summarises everything in one line, refreshed on a timer behind
three gates — a pane must be connected, the board must have changed, and ten
minutes must have passed — so it cannot quietly cost money for nothing.

Its children are started with every customization off and marked headless, so
they do not join the board, do not pay for a plugin load they throw away, and do
not appear as a card you then have to ask about. Measured on one trivial turn:
**$0.07 → $0.006, and 36 s → 1.5 s**.

**Conversations survive a reload and a relay restart.** Each one is kept on
disk with its own `--resume` session id, so a restart resumes the same headless
transcript rather than starting over. A conversation can be pinned (a pinned
one is never evicted), renamed and returned to, and the capture log keeps the
answer beside the question.

**A command bar asks from anywhere.** ⌘⇧Enter, or ⌘⇧K, opens a bar high in the
middle of the pane. The reply streams into it with the same action buttons the
field under the sphere builds. Enter sends, ⇧Enter adds a newline, ⌘Enter
starts a new conversation, ⌥⇧P pins, ⌘K clears, ↑/↓ recall earlier questions,
⌥↑/⌥↓ switch conversation, and Esc closes — safely, because the conversation is
on disk. The chord is caught on `window` in the capture phase, before any
field's own Enter handler, so pressing it inside a reply box opens the bar
rather than sending the reply.

**Replies render as markdown, and the question shimmers while it waits.** The
bar's answers come through a small renderer written for this pane — headings,
emphasis, inline and fenced code, lists, quotes, and links only where they point
at `http:` or `https:`, so anything else stays plain readable text rather than
becoming a clickable trap. While a sent turn has no text yet the question itself
shimmers, in place of the three dots that used to sit in an empty reply box, and
it stops the instant real text starts arriving rather than on a timer. Under the
Motion dial's calmest setting, or reduced motion, the question dims instead of
sweeping.

**A quick-access deck sits behind the option key.** Hold ⌥ while the bar is
open and its reply area swaps for a deck of up to ten cards: the sessions you
keep coming back to, your session presets, the projects you were last in, and
the one thing waiting on you right now. A digit takes a card, and releasing ⌥
puts the transcript back exactly as it was. The digits are fixed bands rather
than a running count — favourites own 1 to 4, presets 5 to 7, projects 8 and 9,
and the single suggestion owns 0 — so a slot with nothing in it stays dim and
unbound rather than letting the next band slide up and change what a key you
already know does.

**A favourite is a name, not a terminal.** Star a session from its drawer and
it earns a permanent digit, sorted alphabetically; if it isn't running right
now the card still holds its place and says so, rather than renumbering
everything after it. Two taps of ⌥ latch the deck open, so `j`/`k` and `h`/`l`
browse it with the keyboard, enter takes the selection, and shift or command
give a card its second and third action — jump to a terminal, ring it on the
canvas, fill or queue a preset, scope the next question to a project. Nothing
here rates, kills or deletes anything. The deck works the same way over the
Projects tab's own ask field, and its cards sit in real depth — the selected
one stepped forward — whether or not the arrival itself is animated.

**Proposed skills.** A pass looks across sessions for what you keep doing and
writes each pattern up as a candidate skill — the idea, the methodology
somebody else could follow, and `file:line` evidence — in a section of the
Dispatch tab. It runs behind two gates, six hours since the last attempt and
enough new board activity to be worth reading, under a per-pass budget; it
ranks below every other orchestrator turn and never applies anything.
Candidates are rated good, near good or has potential by digit, with a review
mode that advances after each rating, and nothing is ever deleted. A rated
candidate preps into the Dispatch queue as a request whose brief is its
write-up. A session can file a candidate itself through the `propose_pattern`
tool.

---

## The terminal side pane

The same board in a tmux split, in Go and Bubbletea, for when you would rather
not leave the terminal. Modes for the grid, the switchboard, the feed, the patch
bay, MINE, vitals and HOTKEYS.

**It inherits the terminal's colour scheme** rather than painting its own, and
asks the terminal for its RGB capability at startup rather than trusting
`$COLORTERM` — which the Charm v2 stack deliberately ignores when `$TERM` starts
with `tmux` or `screen`.

**It assumes nothing from your `tmux.conf`**: panes are targeted by pane id
rather than index, so `base-index` cannot move them; it sets its own border
styles and `remain-on-exit off` on its own pane, never globally; and it checks
for tmux ≥ 3.1, because `split-window -l` did not take a percentage before that
and an older tmux does not fail — it silently makes a 25-*cell* pane, which reads
as the pane being broken rather than as tmux being old.

VITALS ends in an animated instrument — Orrery or Galvanometer — driven by real
agent counts and the real token series, never by a cumulative lifetime total that
would grow all session and never shrink.

**BOARD flags a session that is waiting on you** with ⚑ where its working dot
would be, and its detail row says what it is waiting for.

**Nothing destructive fires on one keypress.** On BOARD, `x` closes the session
under the cursor and `X` kills its subagents. The first press only puts up a
black-on-yellow strip naming what will happen — `claude stop …` or a SIGTERM to
the session's pid — with a three-second countdown; the second press does it, and
any other key or `esc` cancels. The strip is never clickable, so a stray click
cannot confirm it. HOTKEYS' clear and the pasteboard's delete use the same strip.

**`alt+enter` on BOARD jumps to a session's own terminal** when there is one to
jump to, and says why not when there is not. `J` does the same on a terminal
where Option is not Alt.

**`space` is a leader key**: it opens a second bank of modes without adding a
tab, and `space ?` lists the bank. `space c` opens CHAIN, the focused
session's topic chain.

**GRID draws the links between sessions** as dim braille wires routed through the
gaps between cards. `w` hides them and `W` keeps only the cursor card's.

**Text a session reports cannot break a row**: control characters are replaced
before anything is drawn. In the feed, `f` stops following without moving what
you were reading.

---

## The macOS app shell, built on your own machine

**Nothing prebuilt ships.** There is no `.app`, no disk image and no download:
the release carries the shell's source and the script that packages it, and you
build it on the machine that will run it. `just app` runs it from source;
`just app-build` packages `Syzygy.app` for that machine's own architecture, with
an ad-hoc signature, into the shell's `dist` directory; `just app-install` builds
it and copies it into `~/Applications`, where Launchpad and Spotlight find it —
never `/Applications`, which needs admin, and an app already sitting there that
is not this one is refused rather than replaced.

**What it wraps is the pane the relay already serves**, not a second interface
and not a bundled copy, so the window can never be a version behind the
dashboard. On launch it asks for the relay's health on the configured port
(`~/.claude/syzygy-relay.json`, else 4317); if nothing answers on the machine's
own default port it starts the relay the way a session does, and if the port was
named for this launch it says so on a static page instead of starting a second
relay over the same data directory. Quitting the app never stops the relay.

One window, with a persistent cookie partition so the pane's password survives a
relaunch, and a renderer that is sandboxed and context-isolated — the preload
hands the page two version strings and takes back only the name of the accent it
is showing. There is no title bar and there are no window buttons: it is only the
pane, dragged by the empty space in the pane's own top bar. A native menu carries
the views on ⌘1-⌘7 and spells the pane's own chords in labels that bind no key,
because a macOS accelerator cannot be shown without being registered. External
links leave for the default browser, and the window's position and float persist.

**What building it needs**: macOS, Node and npm, and the system Python 3. Electron
and the packager install into the shell's own `node_modules` — the root package
declares no workspaces, so an install at the root never descends into it — and the
first run downloads Electron. The icon is generated at build time from the pane's
own mark by a stdlib Python rasteriser, because `sips` cannot read SVG: one icon
per accent the pane offers, and the Dock follows whichever accent is selected.

---

## Open a file named in the chat

A separate plugin, `syzygy-editor`.

A file reference in Claude's reply **that exists on disk** is drawn as a
pressable box in the transcript. Clicking it splits a tmux pane beneath the
session running your editor, and the pane closes itself when the editor exits —
because a pane running a *command* ends with that command.

The click is a terminal `Button` drawn inside the `AssistantMessage` tree, which
is an intended use of the API. Two other routes exist because a mouse is not
always there: the `open_in_editor` tool, and `syzygy-edit <path>` from any shell
inside tmux.

Editor precedence is `$SYZYGY_EDITOR` → `--editor` → `$VISUAL` → `$EDITOR` →
`nvim` → `vi`. The config's choice sits *under* the environment variable because
the variable is the user saying so right now. For the vi family the pane is
**reused** with `:e`, which is safe on a modified buffer (it stops with E37 and
loses nothing); any other editor gets the pane replaced, because stacking panes
shrinks the session's own pane away after three files.

The existence filter matters more than it sounds: without it every `e.g.` and
`v1.2` in a reply became a box.

---

## Peering: two Syzygy instances

Two Syzygy instances on two machines can pair once, then see each other's
health and a read-only roster of each other's sessions, and put questions to
each other's board. It is **off until you turn it on**: until then no listener
exists and nothing binds.

**Turning it on.** The Peering tab (digit `8`) carries the link's controls
along its top and asks for a name for this instance (lowercase letters, digits and dashes, at
most 32), an IP address to listen on and a port (4318 by default). Enable mints
a self-signed certificate with `openssl` the first time — `openssl` has to be on
`PATH`, and the error says so when it is not — and shows its fingerprint. A
wildcard address such as `0.0.0.0` is refused unless `SZG_PEER_BIND_ANY=1` is
set; `SZG_PEER_BIND` and `SZG_PEER_PORT` override the pane's choice without
being saved.

**Pairing is a code and a fingerprint comparison.** Pair shows a long `szg1.`
code with a 15:00 countdown; it works once. Paste it into the other instance's
accept form with the name you want to call that peer. Both panes then list the
peer with **two fingerprints and a Confirm button**. Compare them on both
screens and confirm on **each** side: until a side confirms, it gives that peer
its health and nothing else — no roster, and no asks in either direction. The
side that accepted the code is the one that connects; the side that offered it
never dials out and answers on the other side's heartbeat instead, so an
instance nothing can reach can still be paired as long as it can reach the
other one.

**Health and clock skew.** A heartbeat every 15 s turns each peer's dot from
grey `never` to green `up`, or `down` with the reason, and shows the round trip
and the clock difference between the machines. Signed requests are refused past
120 s of difference, so past 60 s the row warns. The dot is a flat colour;
nothing pulses.

**Ghost rosters.** A confirmed peer's row carries one small card per session on
the other board — name, model, a working dot, a `needs` badge, the branch. They
are read-only: no click, hover or drag. Only those fields cross, in either
direction.

**Asks, answered by the other instance's liaison.** The Asks region sends a
question to a confirmed peer. The other relay answers it with a fresh
orchestrator turn under a liaison prompt, from its own board state; that turn
never continues the other person's own conversation. The answering pane shows
it in its orchestrator transcript as `from <peer>: …`, with any proposed
actions as buttons **there** — the person at the answering instance decides
whether to apply them. The asking side's log shows the reply and `N actions
proposed on <peer>`, never the actions themselves. A person's own typed ask
always takes the orchestrator from a liaison turn, which goes back in line and
retries after 5 s, 15 s and 45 s.

**Held asks and the two caps.** Each peer has `asks / hour` (20 by default)
and `$ / day` (2 by default), counted over rolling windows and editable in its
row. An ask past either cap — or one that found the orchestrator busy through
every retry — is **held**: it runs nothing and sends nothing back, and the log
shows an `Answer` button that lets that one ask through. An ask that sits
unchanged for 24 hours fails as `stalled`.

**Gestures.** In the ask box, `Enter` sends to the selected peer,
`Shift+Enter` sends one ask to every confirmed peer, and `Alt+Enter` is a dry
run: it shows the exact signed request that would go out and sends and records
nothing. The Send button follows the same modifiers and relabels itself while
Shift or Alt is held. With focus on the panel and not in a field: `p` pairs,
`a` jumps to the ask box, `j`/`k` move through the peers, `Enter` opens or
closes the selected peer's roster, and `Esc` leaves.

**Files move too, through a script you write.** A drop is a set of files sent
to a confirmed peer — chosen from a project's own directory, or handed back by a
liaison that has just finished work for a remote ask. Only the list of paths is
ever text a model reads; the bytes go relay to relay, in chunks. A drop is a
durable job on disk from the moment it exists rather than a request whose
lifetime is one HTTP call, so a restart, or a filter that takes minutes, picks
up where it left off instead of losing the send.

**The filtering is yours, and it runs at both ends.** Put an executable named
`peer-filter` in the relay's data directory and it runs on every drop, sending
and receiving alike, as an argv command with no shell in between. It is handed a
manifest and the chosen files staged in a temporary directory, and hands back
whatever it decides should actually leave, or arrive. Nothing it *says* about a
file is trusted: the relay takes only what it finds under the script's own
output directory, and hashes every one of those itself. Redaction cannot see
inside a file, which is why this hook exists: a drop's JSON bodies are rewritten
like any other peer traffic, its file bytes counted and passed untouched.

**Nothing a peer sends can be read until you say so.** A received drop sits
quarantined behind the receiving relay, verified byte for byte against its
manifest, run through that side's own filter, and only then written into an
inbox. Getting it from there into a project is one more click, and a narrow one:
the destination must be an existing directory the board already knows, never the
relay's own data directory, and a file already sitting at a destination path is
skipped and named rather than overwritten.

**The Jobs region** lists every drop in either direction with its state, the
files it carries and what landed or was refused, so a transfer that stalled is
visible rather than silent; the tab's own badge counts the arrivals nobody has
looked at yet. A liaison answering a remote ask may propose handing files back
the same way it proposes anything else — a button naming them, which does nothing
until somebody here clicks it. **A session started on somebody else's behalf
says so**, with a small `for <peer>` chip wherever its card is drawn; one you
started yourself carries no chip.

**The Peering tab's log.** Below the link's controls, every exchange with a
peer is one row, newest first: the time, an arrow for who opened it (`→` this
instance, `←` the peer, `•` something that happened here, such as an ask being
held or a proposed action being applied), the peer, the kind, a one-line
summary, the size, and how many things were redacted from what was sent.
Clicking a row opens the whole exchange beside the log — what was sent and what
came back, the ask and its reply in full — as text, never rendered. Shift-click
pins a row to the top; Alt-click copies the record as JSON. With the log
focused, `j`/`k` move, `Enter` opens, `f` enters a filter mode where a digit
picks a kind (`1` pairing, `2` heartbeat, `3` ask, `4` reply, `5` held, `6`
action, `7` drop, `8` filter, `9` error, `0` all) and `/` filters by peer or
text, and `Esc` backs out one step. A heartbeat is logged when what it carries
changes, not every 15 seconds, and the Telemetry tab keeps one summary line that
opens the tab.

**What leaves your computer.** Everything an instance sends a peer — questions,
replies, error text, the roster's names, branches and folders — is redacted
first, automatically: the home folder and the user name in a path become `~`,
and the computer's name, its local network addresses, the relay's own token and
password hash, `SZG_*` values, and anything shaped like an API key, a GitHub
token, an AWS key, a bearer token or a private key become `[redacted]`. Pairing
itself is never rewritten, because it carries only names, fingerprints and
proofs. The tab's Safeguard card counts what was redacted, has a per-peer switch
to turn redaction off (on by default; turning it off takes two presses), and
says when this instance's own name on the wire is still the computer's name —
that name is sent with every request, so change it before pairing. It is a
floor, not a guarantee: it cannot see a secret of a shape it does not know, the
contents of a file, or a description the other instance's liaison writes in its
own words. The log is how you watch for those.

**Nothing a peer sends runs here.** An ask becomes a liaison turn that may only
propose; a proposed action is a button in this instance's own pane and does
nothing until somebody here clicks it. The asking side is told how many actions
were proposed and nothing else, and any other field in a reply is ignored.

**What the other machine can reach.** A separate HTTPS listener with four
routes; everything else — any other path or method, a bad signature, a stale
timestamp, a replayed nonce — is an empty 404. Every request but pairing is
signed, certificates are pinned by fingerprint on both ends, and the pairing
code's token is never the stored key. Forgetting a peer revokes it. The
orchestrator's board summary names each peer, its health and its session count,
and nothing more. The relay's own listener stays loopback-only and unchanged.

**Files.** `peers.json` (mode 0600: pairings, secrets, pinned certificates and
addresses — none of which ever reaches the pane), `peer-asks.json` (the ask
log), `peer-wire.jsonl` (the exchange log, rotated past 20,000 lines or 8 MB),
`peer-wire.json` (the peers whose redaction is off), `peer-key.pem` and
`peer-cert.pem`, all in the relay's data directory.
`just peer-status` reads the live relay's peering state.

---

## Sandbox: a gallery for trying components on real data

A view for trying a UI component out — against the real board, or against
generated stand-in data — before it moves onto a real tab. Two components
live in it today: a session card and a worktree/branch graph.

**Two layers.** A component's own DOM is placed in 3D space, so it keeps
selectable text, native clicks and the current theme; a line-only layer
draws behind it — edges, connectors, links — never a solid shape. A line
cannot pass in front of a panel, since the two layers are drawn separately.

**A calm dial** scales every component's motion at once: `still`, `settle`,
`subtle` (the default) and `more`. Reduced motion forces `still` regardless
of the dial.

**The agents fly-out.** Clicking a session card's agents badge sends its
neighbours to the edges and pops its subagents out as smaller cards, each
joined to it by a line; the badge again, or Esc, brings everything back. Two
variants are offered as a **Fly-out** setting (`slide`, the default, or
`scale`); neither ever lets a child cross the parent card or collapse onto
it.

**Gestures.** A click expands a cell to fill the view (Esc or a click
returns it) unless it lands on something the component itself handles.
Shift-click opens the cell's settings — the calm dial, the component's own
knobs, and, where offered, a live/sample data switch. Option-click cycles a
mark on the cell — good, near good, has potential, none — and right-click
clears it. Nothing marked is ever deleted; clearing is recorded like any
other mark.

**The worktree graph** drills from every project, to one project's
worktrees, to one branch's commits, stepping back a level at a time on Esc.

---

## Session space

The **Space** tab puts every live session on the same 3D stage the sandbox
gallery uses, as the same floating card, scattered loosely rather than gridded.
Along the bottom sit eight labelled buckets, each holding a shape you build once
and reapply with a click instead of rebuilding it by hand every time.

**Picking cards up.** Hold ⌥ and the card under the pointer follows it, and it
keeps following after the key comes back up — all the way to a bucket, Escape, or
a click on empty stage. The hand has to travel to the bucket row, and a set that
snapped home the moment a finger lifted would be unusable. ⌥-click or ⇧-click
instead adds a card to the carried set where it stands, ringed to show it is
carried; a plain click opens that session's drawer. A bare `b` latches aiming
mode, where digits `1`–`8` aim the carried set at a slot without sending
anything, Enter applies the aim, and Escape backs out one layer at a time — an
open bucket editor, the aim, the mode, the carried set — before it reaches
anything else on the page. A mode line in the corner always says what the next
click will do.

**The four kinds of bucket.** A **tmux group** moves the real panes behind the
carried cards into one window named by the bucket. A **prompt** sends the same
saved text to every carried session. **Files** sends each of them one message
naming a list of absolute paths — it tells a session where to look and grants it
no permission it did not already have. **Together** just remembers which ones
were carried as a named, coloured set; every member wears a thin halo in that
colour wherever it drifts on the stage.

A side list shows the tmux panes nobody has put on the board yet, so an existing
terminal can be carried into a bucket exactly the way a card is.

**The stage scrolls rather than shrinking to fit.** Once the cards outgrow the
view it grows a scrollbar instead of zooming every card down to keep the set in
frame, so a card is the same size on a board of thirty as on a board of three,
and the mode line, the bucket row and the side list stay put underneath.

---

## Experimental: forge

Ships, but **not linked by `just install`** — minting new tools at run time is a
capability worth choosing deliberately rather than inheriting from an install.

`create_tool` turns a repeated sequence of tool calls into one named,
deterministic tool that persists for the project across sessions. Plus exact
`json_query`, `regex_test` and `text_diff`, to replace hallucinated parsing.

Its `$` call inventory shows no `$.process.run`, no `$.fs`, no `$.http` and no
`$.model.*`. Read that for exactly what it says: a forged tool reaches the shell
**only through the same permission check and hooks as any other tool call**.
There is no allowlist on the tool a forged step may call, by decision — that call
goes through the engine's normal path, so the permission prompt and every other
plugin's hooks still apply.

---

## The pasteboard

**Stash a prompt instead of sending it, then reload it from either pane.**
Start a prompt with `,,` and it is never sent: it goes onto a pasteboard
instead, ready to reload into this session's composer or into any other
session's. `,,,` stashes onto a global board that every session shares, and
`,,@title ` stashes with a title attached. The marker itself is
`settings.pasteboardMarker` in `~/.claude/syzygy-hud-hotkeys.json`; an empty
string turns the feature off entirely, and a value that would not work as a
marker — letters or digits in it, any whitespace, more than four characters,
or a leading `/`, `!`, `#` or `@` — disables it outright rather than quietly
falling back to the default, and says so once.

**Why a marker and not a button.** A plugin has no way to read what is
sitting in the composer while you type — it can fill the box, suggest a
completion, or submit it, but never read one back — so the text only becomes
visible the instant Enter is pressed. The stash works by catching that
instant: it looks at what was just submitted, and if it starts with the
marker, stores the text and cancels the send with a reason, which Claude Code
displays where the prompt would otherwise have gone. Only your own Enter is
ever caught this way — a prompt sent by another session, or by the plugin
itself, goes through untouched.

**A refused stash never costs you the draft.** Cancelling a submission clears
the composer, so a refusal has to put the text back or it has just destroyed
what you typed. A board that is full, a relay that is not running, and a
session the board does not know about yet all refuse the same way: the
original text, marker included, is written straight back into the composer,
and the reason says so. On the rare chance that fails too, the reason itself
carries the first 200 characters of the draft, because at that point it is
the only copy left.

**The board.** Stashes live in `~/.claude/syzygy/pasteboard.json`, written by
the relay alone, one complete rewrite at a time, so a crash mid-write can
never leave it half-written. Every session gets its own board, and there is
one global board besides; a new stash always lands at the front, and entries
can be reordered from there afterward. Its caps — 100 entries per board,
32 KB per entry, 2 MB across the whole file — refuse a stash that would break
them rather than quietly dropping an older entry to make room, because a
stashed prompt exists nowhere else.

**Reloading replaces whatever the composer already holds**, rather than
inserting alongside it, and every place offering a reload says so before you
press it. The browser pane sends only an entry's id; the relay looks up the
text itself and delivers it through the same channel the band above the
prompt already uses for other commands.

**Two panes, two ways in.** The browser dashboard adds a pasteboard section
to the session drawer, for that session's own board, and a foldable panel to
the left rail in Control, for the global one: click an entry to reload it,
shift-click to send it to whichever session has focus, alt-click to delete
it, and drag it or use the arrow buttons to reorder. The terminal pane gets
its own mode, on digit `3`: `j`/`k` move the cursor between entries, `J`/`K`
move the selected entry up or down, `enter` fills the focused session, `t`
switches between the session board and the global one, and `x` twice within
three seconds deletes.

A stash, a refusal, and an unusable marker all report themselves the same
way: a one-line notice in the band above the prompt, shown when there is a
row to spare, which clears itself at the next turn or after 20 seconds,
whichever comes first.

Claude Code's own single-draft stash is still the right tool for holding one
prompt for a few seconds — one keystroke, one slot, gone once the session
ends. This is the other kind: persistent across restarts, ordered, and
reachable from any session rather than only the one that typed it.

A relay that started before this existed simply has no routes for any of it;
restarting it and reloading the pane picks the feature up like any other
addition to what the relay serves.

---

## The topic chain

**Every session builds a chain of the topics it has been through.** Each block
is a topic the conversation moved through, with a title, a short summary and a
progress note, and the chain is rewritten as the session goes until each block
says what its topic actually was — the shape of the conversation rather than
its transcript.

**Building it costs no model call in the session.** When a turn finishes, the
band above the prompt sends the relay one small record: the first 400
characters of the prompt, the last 400 of the answer — where a turn says what it
did — the files that turn edited, and a tool count. A relay that is not running
leaves a gap in the chain and nothing else. A turn run by a subagent is counted
inside its parent's turn, never as a topic of its own.

**What opens a new block** is a fixed rule the relay applies to each record: a
prompt beginning with a pivot phrase such as `ok now`, `next up` or `switching
to`; half an hour since the block's last turn; a block that already holds forty
turns; or a turn whose words barely overlap the block's and which touched none
of its files. A short turn — "ok", "thanks" — always joins the block it follows.
A new block is titled with the prompt that opened it.

**The refiner rewrites the recent past, and only that.** On idle, every eight
turns, or on request, the relay asks a headless `claude -p` child — no tools,
its own instructions, a structured answer — to retitle and summarise the open
block and the three before it. It may move turns between those blocks, split
one, merge two neighbours once per pass, and note progress. It may not touch a
block you pinned or edited by hand, and anything it proposes outside those rules
is thrown away and counted while the rest still applies, so the chain never
shifts under you further back than you can see. Each call is capped at $0.15
and each session at $1.50 a day; past that the rule-based chain keeps growing
and both panes say the refiner is paused. The model, the daily cap, the idle
delay and the turn cadence are all environment settings.

**Pins, edits and history.** In the terminal pane's CHAIN mode — `space c` —
`j`/`k` move between blocks, `J`/`K` jump between branches, `enter` expands a
block's summary and turns, `E` opens it full-screen, `h`/`l` collapse or expand
every block, `p` pins it, `P` pins everything older, `m`/`M` merge it into the
block above or below, `s` splits it at a turn in the full-screen view, `r`
refines now, `R` rebuilds the chain from the session's transcript, and `t`
scrubs the chain as it stood after each of its last twenty rewrites. Merge,
split and rebuild go through the same armed strip as every other destructive
key. The browser drawer shows the same chain read-only; click a block for its
summary and turns.

**Rebuild starts again from the transcript.** It discards pins, hand edits and
summaries, then the refiner rewrites the recent blocks once. A chain file that
cannot be read is moved aside and a fresh chain starts, because the transcript
can always rebuild it.

**A restarted terminal keeps its chain** when it carries the same explicit name
in the same directory as exactly one ended session. A session nobody named never
inherits, since every unnamed session in a folder shares its name.

**Other features can read it.** `GET /api/chains/export` returns every chain's
blocks in a versioned shape whose fields are only ever added, never renamed.
The orchestrator can carry the chains in its context too, off unless
`SZG_CHAIN_BUNDLE=1`.

A relay that started before this existed has no chain routes and sends no
chains; restarting it and reloading the pane picks the feature up.

---

## Session presets

**Save the kind of session you keep starting, then start it in one click.** A
preset is a kickoff prompt, a model and an effort, with optional skills, a
list of tools to pre-approve, and a persona. Presets live in the gear's
Session presets section: click one to edit it, alt-click to duplicate it.

**Applying fills fields you can see.** On the canvas spawn form and the
Dispatch create box, a row of chips sits above the prompt. Clicking a chip
writes the preset's prompt, model and effort into the form, where they stay
editable; skills arrive as a line in the prompt. The tool list and the
persona cannot be shown in a field, so the applied chip stays marked, its
tooltip names both, and its `✕` detaches them. Shift-click fills only the
fields you have not typed in; alt-click opens the preset in the editor;
command-click (ctrl-click elsewhere) applies it and starts or queues at once,
still refused if the form is incomplete. `+ save as preset` turns whatever the
form holds into a new preset. From the keyboard, alt-T enters a preset mode
where a digit picks the Nth preset, shift plus a digit fills only empty
fields, and escape leaves; digits pressed there never switch tabs. A line
under the chips always says what a click will do with the keys you are
holding.

**Pre-approving is not forbidding.** The tool list lets a session use those
tools without stopping to ask; it does not stop the session using others.

**Personas are off unless you turn them on.** The toggle in the same section
installs every preset that has a persona as a Claude Code agent, in a plugin
the dashboard writes, checks with Claude Code's own plugin validator, and
removes again when the toggle goes off. Once it is on, every Claude session on
the computer can see those agents, which is why it is a choice rather than a
default. A persona is only requested when Claude Code's own list of agents
already contains it; otherwise the session starts without it and the dashboard
says so. The prompt always carries the preset, so a persona that fails to load
costs the persona, never the session.

A relay that started before this existed has no preset routes; restarting it
and reloading the pane picks them up.

---

## Security

The relay's own listener is loopback only, with a password with an HMAC cookie,
a 0600 bearer token, one `authed()` check in front of every write, and a gate in
front of every read but `/api/health`. Peering, when you turn it on, adds a
separate HTTPS listener that shares none of that: four signed routes, pinned
certificates, an empty 404 for everything else, and redaction of what this instance sends before it leaves (see Peering above). What is deliberately accepted is in the README: the relay is
reachable by anything already running under your own account, and the password
is a lock on the browser rather than a sandbox.
