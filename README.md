# Syzygy

**A control hub for running several Claude Code sessions at once.**

A band above your prompt that tells you what this session is costing and how
close it is to the context wall. A browser dashboard where every session on the
machine appears as a card you can read, answer, steer, spawn, link and close. A
tmux side pane for the same board without leaving the terminal. And a dispatch
queue that turns a vague ask into a brief, then into a worktree, a branch and a
session of its own.

It is built on **Claude Code function hooks** — a plugin exports
`register(on, options)` and hooks events like `tool.call`, `ui.render`,
`session.start` and `turn.complete`. Nothing here patches Claude Code or scrapes
its screen.

> Function hooks are an **early-access** capability and the surface moves
> between releases. Everything here was verified against build **2.1.269**.
> Regenerate the type declarations (below) before trusting anything.

---

## Five minutes

Function hooks are an early-access surface of Claude Code, off by default. Every
plugin here is built on them, so the switch comes first, in the shell that
starts `claude`:

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

Without it Claude Code starts without the plugins and nothing below appears.

```bash
git clone <this repo> && cd syzygy
npm install                  # typescript, three, esbuild — dev only
just install                 # links the plugins, builds the terminal pane
```

Then in any Claude Code session:

```
/plugin-types                # generate the API declarations for YOUR build
/reload-plugins              # load what just install linked
```

The band appears above your prompt. The relay starts itself and the dashboard is
at <http://localhost:4317> — press `1` in the band to open it, or run `just
pane`. The first visit asks you to choose a password.

`just install` symlinks rather than copies, so your edits take effect on the
next `/reload-plugins` with no re-install. `just --list` is the command menu and
the justfile is the source of truth for every command in this document.

---

## The band

One row above the prompt, and it is one row **by construction** — `AbovePrompt`
clips a tree taller than `maxRows` and disarms every hotkey inside it, so the fit
is enforced rather than hoped for.

It shows the real context window (read from the status line, not guessed), spend,
throughput, the active model, the git branch and diff, a guardrail count and a
stuck detector. A context pie runs **full to empty as context is consumed** — the
glyph gauges what is left while the numbers beside it count what is used.

Ten digit hotkeys, and that is the hard ceiling: a band hotkey must be a single
digit. `1` opens and closes the side pane, `4` asks *what now?*, and the other
eight are **your own prompt slots**, edited in
`~/.claude/syzygy-hud-hotkeys.json` or from the terminal pane's HOTKEYS mode. A
project can override or hide any slot from `<worktree>/.claude/`.

Twenty-two turn spinners. `just spinners` lists them; `just spinner <id>` pins
one.

## The dashboard

Eight views, served by a local relay on loopback.

- **Control** — the switchboard. Every live session as a card: name, model,
  context, spend, what it last said, whether it is waiting on you. A left rail
  carries the overview metrics, a WebGL presence sphere whose particles are your
  sessions, the tool feed, and steering buttons. Open a card's drawer to read its
  last answer, reply to it, rename it, see its subagents and TODOs, **jump to its
  real terminal**, or close it.
- **Telemetry** — the numbers over time, with a replay scrubber down the right.
- **Projects** — git topology across worktrees, the plans in flight, the backlog,
  and who is working on what.
- **Dispatch** — the queue. Below.
- **Canvas** — sessions as draggable nodes with the wires between them, and a
  spawn form that starts a new session in a directory you choose.
- **Sandbox** — a gallery where new components are tried on live board data
  before any of them earns a place on a real view.
- **Space** — every session as a card in 3D, with buckets along the bottom
  that group them, send them a prompt, or expose files to them.
- **Peering** — pairing with a second Syzygy on another machine, its health,
  the asks between the two liaisons, file drops, and the wire log.

Drag one card onto another to open a channel over Claude Code's own cross-session
messaging bus. It is a real message, not a simulation.

## The macOS app

The dashboard can run as a real app instead of a browser tab:

```
just app-install             # builds Syzygy.app and puts it in ~/Applications
```

It opens the same pane the relay serves, keeps the login across launches,
switches views on ⌘1 to ⌘7 and carries the pane's chords in its menu. If no
relay answers it starts one the way the band does; quitting the app leaves
the relay running, since sessions depend on it. The build is ad-hoc signed,
so macOS asks once before the first launch.

## The terminal side pane

The same board in a tmux split, in Go and Bubbletea, for when you would rather
not leave the terminal. `1` in the band toggles it; `just tui2` opens it by hand.
It assumes **nothing** from your `tmux.conf`: panes are targeted by pane id
rather than index, so `base-index` cannot move them; it sets its own border
styles and `remain-on-exit off` on its own pane, never globally; and it needs
tmux **3.1 or newer**, because `split-window -l` did not take a percentage
before that.

A band hotkey fires only on an empty composer, so to toggle the pane
mid-prompt bind it in your own `tmux.conf`:

```
bind -n M-p run-shell -b '/path/to/syzygy/pane-v2/syzygy-pane.sh --toggle'
```

Run outside tmux, `syzygy-pane.sh` creates a session called `syzygy` with
Claude on the left and the pane on the right, then attaches.

## Dispatch

The workflow this was built for.

1. **Write down the ask**, however vaguely, against a project.
2. **Scope it.** A `claude -p` conversation asks you one question at a time until
   there is something precise, then writes a structured brief.
3. **Green-light it.** Dispatch creates a worktree and a branch and starts a
   background session in it with the brief.
4. **Read the plan** it writes, and green-light the implementation.

Each step is a click you make. Nothing dispatches itself.

## Parallel implementation

`syzygy:multi-worktree-coordinator` is a skill rather than a tab. Hand a
planning session several independent features and it proposes a split into
right-sized plans, writes one plan document per feature and commits them — a
worktree branches from committed state, so an uncommitted plan would not exist
inside the session meant to read it. Then its own launcher,
`syzygy/skills/multi-worktree-coordinator/scripts/mwc.sh`, which needs nothing
but `bash`, `git` and `tmux`, opens ONE tmux window holding a merge-coordinator
pane plus a tiled pane per worker, each a named Claude Code session in its own
git worktree on `feature/<name>`.

Workers implement and report `DONE` or `BLOCKED` over Claude Code's own
cross-session messaging. The merge coordinator checks each branch on disk rather
than taking a report's word for it, **asks you for approval in its own pane**,
and only then merges into the base one branch at a time, running the tests after
each, before removing the worktrees and the branches. Nothing merges until you
say so in that pane.

Every session starts with the orchestrating session's identity variables
stripped from its environment, or a worker would write into that session's
transcript. Workers default to `--model opus --permission-mode
bypassPermissions` — full autonomy inside an isolated worktree, reviewed at
merge time. Pass `--permission-mode acceptEdits` to `mwc.sh launch` to tighten
that.

## The orchestrator

A field under the presence sphere: ask a question about the *whole board* and get
an answer that has read it — every session, the canvas, the queue, the project's
plans and backlog, and what other sessions have reported learning.

It may **propose** actions — link two sessions, prompt one, queue a brief, spawn a
collector. It may never perform one: a human clicks to apply, and every applied
action is written to a log.

## Voice

Hold a modifier in the pane's composer and talk. Transcription is
`openai-whisper` running **entirely on your machine** — no audio and no text
leaves it.

Not installed until you ask, from the pane's gear. The one-time cost, measured:
`uv` on PATH, a venv pinned to Python 3.12 (~748 MB), and
`large-v3-turbo.pt` at 1,617,941,637 bytes fetched by the package itself from
OpenAI's CDN under OpenAI's own SHA-256 check.

## Open a file from the chat

`syzygy-editor` is a separate plugin. A file reference in Claude's reply **that
exists on disk** is drawn as a pressable box; clicking it splits a tmux pane
beneath the session running your editor. There is a tool (`open_in_editor`) and a
CLI (`syzygy-edit <path>`) for when there is no mouse.

## Experimental: forge

`forge` ships but is **not linked by `just install`**. `create_tool` mints a
repeated sequence of tool calls into one named, deterministic tool that persists
for the project across sessions, plus exact `json_query` / `regex_test` /
`text_diff` to replace hallucinated parsing.

```bash
just install-forge     # then /reload-plugins
```

It is validated and tested whether it is linked or not; what is opt-in is loading
a tool-minting capability into every session, not its quality.

---

## Requirements

`just deps-check` prints this for your machine and says what each missing item
would cost you.

| | | |
|---|---|---|
| **`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`** | required | the function-hooks surface every plugin is built on |
| **node ≥ 22** | required | the relay and the browser dashboard |
| **python3** | required | the install scripts and the statusline side-channel |
| **tmux ≥ 3.1** | optional | the terminal side pane, and jumping to a session |
| **Go** | optional | builds the terminal side pane; `just install` does it if Go is there |
| **uv** | optional | voice input only |

## The password

Loopback is not a boundary on a machine you share, and the board carries every
session's transcript tail — so the dashboard is password-gated.

- **First visit** redirects to `/setup`.
- **From a shell:** `just pane-password` prompts twice, silently, and never takes
  the password as an argument. A running relay picks it up on its next restart.
- **Logout** clears the cookie on that browser; a **reset** rotates the server
  secret, logging out every other browser.
- **Lost it:** delete `auth.json` in the relay's state directory
  (`~/.claude/syzygy/`), restart the relay, set it again. There is no recovery
  path and there should not be — that file is the whole store.
- **Off:** `SZG_PANE_PASSWORD_DISABLED=1` in the relay's environment. Only on a
  machine nobody else can reach.

**What is deliberately accepted.** The relay is reachable by anything already
running under your own account; the password is a lock on the browser, not a
sandbox. A session's own bearer token is stored in your home directory,
mode 0600. Nothing is encrypted at rest, because the machine's own account
boundary is the boundary being relied on.

## The statusline side-channel

Claude Code hands its `statusLine` command a JSON object containing
`context_window.context_window_size` and the account's rate-limit windows.
**That is the only place either is observable from outside the session**, so the
band's real context figure and the usage windows come from there.

```bash
just statusline-install
```

It **wraps** your existing `statusLine.command` rather than replacing it: the
original keeps running byte-for-byte, and the wrapper drops a copy of the JSON,
keyed by session id, into the relay's state directory. Every failure in the
side-channel half is swallowed — a status line renders every turn and must never
be breakable by this.

Skip it and nothing breaks: the band falls back to a model → context-window
table, which is right for the common models and silent about the rest.

---

## Generate the type declarations first

`.claude/types/` is **not** in this repo. Those declarations are generated from
*your* Claude Code build and are specific to its version. Make your own:

```
/plugin-types
```

in a session at the repo root. It writes `claude-code.d.ts` (the plugin API,
every event's input and result, every method on `$`) and `claude-code-mcp.d.ts`
(your connected MCP tools). **Those files are the authority** — do not guess at
an API; if it is not in there, it does not exist. Regenerate after every Claude
Code update, on the day: the cost of regenerating is entirely in the call sites
it exposes, so putting it off makes it worse rather than better.

## The three gates

```bash
just check      # tsc against the generated declarations — proves every API used is real
just validate   # claude plugin validate --strict
just test-all   # every harness
just verify     # all of the above, plus the pane's syntax and the plan gates
```

`just validate` prints the hooks a module registers **and every `$` call it
makes**. That inventory is how you prove a property rather than assert it — and
it is only as good as the sentence you attach to it. forge's shows no
`$.process.run`, no `$.fs`, no `$.http` and no `$.model.*`, which means a forged
tool reaches the shell only through the same permission check and hooks as any
other tool call. It does **not** mean a forged tool cannot run code.

## How it is built

Function hooks, with the constraints the engine enforces at load time. The ones
that bite hardest:

- **`$` may never be bound.** Not assigned, passed to a non-top-level function,
  spread, or returned. Only ever `$.noun.verb(...)` at a call site.
- **Helpers taking `$` must be declared at the top level of the file** — so
  mutable plugin state goes in a module-scope object, not a closure inside
  `register()`.
- **`turn.complete` carries no token usage.** Real main-thread numbers have to be
  read from the session transcript.
- **`$.ui.invalidate` folds calls closer than 100 ms** — 10 fps is the ceiling
  for any animation.
- **A hooks module may import sibling files**, even though `hooks.json` names one
  module. That is how 700 lines of spinner frame maths stay out of the hooks
  module proper.

## Layout

```
syzygy/                band, spinners, relay + browser dashboard
syzygy-editor/         open a file named in the chat
forge/                 experimental, opt-in
pane-v2/               the Go tmux side pane
docs/FEATURES.md       what each feature is and why it works that way
test/                  one harness per plugin and per module
```

### The editor plugin's settings

`~/.claude/syzygy-editor.json`, read once at `session.start`. The file is
optional and every field falls back to its default, so a half-typed one costs
you nothing.

```json
{
  "relativePathRule": true,
  "editor": "nvim",
  "split": "below",
  "size": "40%",
  "box": "row"
}
```

- **`relativePathRule`** — append the one-line instruction asking the model to
  write paths relative to the working directory. `false` turns it off.
- **`editor`** — the editor the split runs. Left at `nvim` (the default) it is
  **not** passed through, so `$SYZYGY_EDITOR`, `$VISUAL` and `$EDITOR` keep
  their usual precedence. Set to anything else and that choice is passed
  explicitly, beating `$VISUAL`/`$EDITOR` but still below `$SYZYGY_EDITOR`.
- **`split`** — `below` (the reserved editor pane) or `right`.
- **`size`** — as tmux takes it: `40%`, or a cell count.
- **`box`** — **`row`** (default) keeps the engine's own drawing of the reply
  and puts the boxes on a dim row underneath it; **`inline`** draws the box
  around each reference where it stands, which is prettier for the reference
  and costs the reply's markdown.

### The vendored three.js

`syzygy/bridge/public/vendor/three.slim.min.js` is three.js **0.186.0**, pinned
exactly in `package.json`, MIT, Copyright 2010-2026 Three.js Authors. It is
generated — do not hand-edit it. The upstream `@license` banner and its SPDX
identifier stay in the bundle: both that licence and this project's Apache-2.0
require attribution notices to be preserved.

`just vendor-three` rebuilds it, running esbuild over `scripts/three-entry.js`.
three 0.186.0 ships no minified build and its `three.module.js` imports from
`three.core.js`, so vendoring the raw files would mean two files and 2.2 MB;
this bundle is one self-contained file at about 532 KB.

**The export list is the contract.** The bundle contains only the symbols
`scripts/three-entry.js` re-exports. Using a three class that is not among them
fails at run time with `undefined`, and nothing in the error names the bundle.
To add one: edit `scripts/three-entry.js`, run `just vendor-three`, commit
both.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
