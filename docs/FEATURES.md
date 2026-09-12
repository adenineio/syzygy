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

A local relay bound to `127.0.0.1` serves a five-view dashboard and a live SSE
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

A browser with no WebGL2, or a lost context, drops to a 2D orb. A restored
context rebuilds everything — disposing every prior renderer, material and
geometry, and re-compiling each look so the first mode switch afterwards does not
stall.

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
- **Projects** — git topology across worktrees, the plans in flight with their
  progress, the backlog, and who is working on what. A plan is identified by its
  **basename**, which is the only thing that survives being moved; within one
  worktree no two plans may share one, and a gate enforces it.
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

### Channels between sessions

Drag one card onto another to open a channel. It is a **real** message over
Claude Code's own cross-session messaging bus, not a simulation, and a landed
drag collects one from you to send.

### Usage windows

The account's 5-hour and 7-day rate-limit windows on the board, with a sparkline
of the readings, from the same statusline side-channel as the context figure.
A queue can hold a green light until after a reset.

---

## Dispatch

The workflow the whole thing was built for: a vague ask becomes a brief, a
worktree, a branch and a session, in four steps you each approve.

1. **Queue the ask** against a project. The project must be an **absolute
   directory** — it becomes a working directory and a `tmux new-window -c`, and
   node reports a missing cwd as `spawn … ENOENT`, which reads exactly like the
   binary being missing.
2. **Scope it.** A `claude -p` conversation asks **one question at a time** until
   the thing is precise, then emits a structured brief against a JSON schema.
   Taking that conversation over in a terminal **forks** it — scoping runs as
   one-shot calls, so a resume starts a new process and the two halves stop
   reaching each other. The panel says so rather than letting it happen silently.
3. **Dispatch.** A git worktree and a branch per brief, and a `claude --bg`
   session started in it with the brief.
4. **Read the plan, then green-light the implementation.**

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

## Security

Loopback only, a password with an HMAC cookie, a 0600 bearer token, one
`authed()` check in front of every write, and a gate in front of every read but
`/api/health`. What is deliberately accepted is in the README: the relay is
reachable by anything already running under your own account, and the password
is a lock on the browser rather than a sandbox.
