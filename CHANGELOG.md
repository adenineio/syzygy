# Changelog

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
