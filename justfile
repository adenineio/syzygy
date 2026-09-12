# Syzygy — usage commands (source of truth).

# Recipes that exist only in this checkout live beside this file and are
# imported OPTIONALLY, so a tree without them still runs `just --list`.
import? 'local.just'

plugin_dir := justfile_directory() / "syzygy"
# What `just install` links. Deliberately not "every directory that looks like
# a plugin": see `install-forge` below.
plugins    := "syzygy syzygy-editor"
# forge ships but is OPT-IN -- experimental, and not linked by `just install`.
# It is still validated and still tested, because shipping it untested would be
# the actual risk; what is opt-in is loading it into every session.
optional_plugins := "forge"
skills_dir := env_var('HOME') / ".claude/skills"
link       := env_var('HOME') / ".claude/skills/syzygy"

# Show the command menu.
default:
    @just --list

# Typecheck the hooks module against the generated plugin API declarations.
check:
    ./node_modules/.bin/tsc -p tsconfig.json

# Regenerate .claude/types from the running Claude Code build.
types:
    @echo "Run /plugin-types in a Claude Code session at {{justfile_directory()}}"

# Validate every plugin and report what the engine sees each module hook and call.
#
# RESOLVES ITS OWN BINARY, deliberately. A bare `claude` takes whatever PATH
# resolves first, and installs differ: an old one left earlier in PATH shadows
# a current one further down. An install predating `--strict` fails this gate
# with `unknown option '--strict'`, so `just verify` cannot pass at all.
#
# That failure is loud, which is why it gets found. The same shadowing is
# silent elsewhere: an old build has no `--bg` flag and no `attach` subcommand,
# and bridge/dispatch.mjs and bridge/scoping.mjs both default `claudeBin` to a
# bare 'claude'.
#
# So: pick the first candidate that actually supports the flag, and say which.
# CLAUDE_BIN overrides everything.
# Validate every plugin, and print the hooks and $ calls each module makes.
validate:
    #!/usr/bin/env bash
    set -eu
    bin=""
    for c in "${CLAUDE_BIN:-}" "$HOME/.local/bin/claude" "$(command -v claude || true)"; do
      [ -n "$c" ] && [ -x "$c" ] || continue
      if "$c" plugin validate --help 2>&1 | grep -q -- '--strict'; then bin="$c"; break; fi
    done
    if [ -z "$bin" ]; then
      echo "no claude found supports 'plugin validate --strict'." >&2
      echo "tried: \$CLAUDE_BIN, ~/.local/bin/claude, $(command -v claude || echo 'no claude on PATH')" >&2
      echo "upgrade the CLI, or set CLAUDE_BIN to one that does." >&2
      exit 1
    fi
    echo "validate: using $bin ($("$bin" --version 2>&1 | head -1))"
    for p in {{plugins}} {{optional_plugins}}; do
      echo "=== $p ==="
      "$bin" plugin validate "{{justfile_directory()}}/$p" --strict
    done

# Compile the hooks module to plain JS for the harness.
# spinner-frames.js is already plain JS, so tsc leaves it alone — copy it next
# to the compiled module or the emitted import resolves to nothing.
# Compile the hooks module to plain JS for the harness.
build:
    ./node_modules/.bin/tsc -p tsconfig.build.json
    @cp syzygy/hooks/spinner-frames.js build/spinner-frames.js

# Drive the compiled hooks against a mock $ and a real transcript.
# Defaults to the newest session in ~/.claude/projects.
# Drive the compiled hooks against a mock $ and a real transcript.
test session="": build
    #!/usr/bin/env bash
    set -eu
    id="{{session}}"
    if [ -z "$id" ]; then
      newest=$(ls -t ~/.claude/projects/*/*.jsonl 2>/dev/null | head -1 || true)
      test -n "$newest" || { echo "no transcript found; pass a session id"; exit 1; }
      id=$(basename "$newest" .jsonl)
    fi
    node test/harness.mjs "$id"

# Install dev dependencies (typescript).
deps:
    npm install

# Rebuild the pinned, tree-shaken three.js bundle from scripts/three-entry.js.
# Only needed when bumping the three version or adding an export to the entry.
vendor-three:
    #!/usr/bin/env bash
    set -eu
    ./node_modules/.bin/esbuild scripts/three-entry.js \
      --bundle --format=esm --minify \
      --outfile=syzygy/bridge/public/vendor/three.slim.min.js
    ls -la syzygy/bridge/public/vendor/three.slim.min.js

# Run the projects scanner's harness.
test-tasks:
    node test/tasks-harness.mjs

# The reference resolver: a plan's declared `Tasks:` and `Spec:` lines, and a
# request's `relatesTo`, matched against the thing they name. Exact-match only:
# a miss is reported as broken, never guessed at.
# Declared references, resolved.
test-refs:
    node test/refs-harness.mjs

# The three checkbox states, the evidence gate behind `[x]`, and the drift
# check that fails a plan whose ticks disagree with its ledger.
# Three states, the evidence gate behind `[x]`, and the drift check.
test-plans:
    node test/plan-progress-harness.mjs

# The per-worktree claims store: atomic writes, one session per key.
test-claims:
    node test/claims-harness.mjs

# A session card's own outline colour: atomic writes, name-keyed inheritance
# and its two-live-sessions refusal, validation.
# The per-card colour store.
test-cards:
    node test/cards-harness.mjs

# The pane password: hashing, cookies, rate limiting and gate() unit-level,
# then setup/login/reset/logout, the cookie gate, SSE and the token bypass
# against a real relay subprocess -- plus SZG_PANE_PASSWORD_DISABLED proving
# the gate is fully off.
# The pane password: hashing, cookies, rate limiting, and the routes.
test-auth:
    node test/auth-harness.mjs

# The pane's keyed DOM reconciliation, against a counting DOM shim -- node
# identity across passes, minimal moves, the enter/exit seams, and that an
# unchanged pass writes to the DOM exactly zero times.
# Keyed DOM reconciliation for the browser pane.
test-reconcile:
    node test/reconcile-harness.mjs

# The session canvas: cwd validation, the spawn argv (asserted as an ARRAY),
# position inheritance by name with its refusal, the concurrency cap, the
# reset layout's determinism, and the relay's four endpoints against a real
# relay subprocess with a fake `claude`. No test starts a real session.
# The session canvas's harness.
test-canvas:
    node test/canvas-harness.mjs

# Voice input's pure core (voice-math.js), the relay's voice module against
# an injected `run` (small real node scripts stand in for uv/python/the
# worker), and the relay's routes against a real subprocess with a fake
# `python3` planted at the exact path voice.mjs computes. No test here runs
# the real venv, model or worker -- that is verified by hand.
# The voice input harness.
test-voice:
    node test/voice-harness.mjs

# The Projects tab identifies a plan by its BASENAME, which is the only stable
# identity across a directory move. Across worktrees a shared basename IS the
# same plan, which is the point; within ONE worktree it is a half-finished move
# or two different plans, and either way two rows would silently become one.
# The gate: fail if two plan files in this worktree share a basename.
plan-names:
    node scripts/plan-names.mjs

# THE PLAN WORKFLOW. A plan's checkbox has three states, and which of them a
# line carries says who put it there:
#
#   - [ ]  not started
#   - [~]  REPORTED -- whoever did the work believes it is finished
#   - [x]  VERIFIED -- the gates passed and somebody else confirmed it
#
# Whoever implements a task may write `[~]` for their own work and may never
# write `[x]` for it. That is what makes the tick structural rather than a
# matter of discipline. `- [~]` renders on GitHub as an unchecked box with a
# literal tilde; that is expected, not a bug to fix.
#
# The evidence behind `[x]` comes from the progress ledger the subagent-driven
# development workflow writes, at `.superpowers/sdd/<plan>/progress.md`. A plan
# with no ledger is simply not gated.
#
# An executor's own claim: cheap, needs no evidence, and asserts nothing about
# verification -- which is exactly why an executor may run it on its own work.
# Claim a plan's task as reported, not verified.
plan-reported plan task:
    node scripts/plan-progress.mjs task-reported {{plan}} {{task}}

# Refuses unless the ledger already records the task complete WITH evidence: a
# commit range, a verification command and its exit status, and a review
# verdict. Belongs to the reviewing step, never to the implementer.
# Mark a plan's task verified, if the ledger proves it.
plan-done plan task:
    node scripts/plan-progress.mjs task-done {{plan}} {{task}}

# The ledger is git-ignored and one `git clean -fdx` from gone, taking the
# rulings recorded in it with it. This copies them into a tracked file.
# Graduate a plan's rulings out of git-ignored scratch into docs/decisions/.
plan-decisions plan:
    node scripts/plan-progress.mjs decisions {{plan}}

# A plan with no ledger is not gated. Runs inside `just verify` so forgetting to
# tick fails the build rather than relying on anyone remembering.
#
# Watch the incentive that creates. If ticking is the only route to a green
# suite, the pressure is to tick BEFORE doing the work -- which converts the
# whole signal into noise. That is why `[~]` exists: reporting is cheap and
# honest, verifying is gated on evidence, so the path of least resistance is
# also the truthful one. Do not "simplify" the two states back into one.
# The gate: fail if any plan's checkboxes disagree with its SDD ledger.
plan-check:
    #!/usr/bin/env bash
    set -eu
    rc=0
    for p in docs/plans/*.md docs/superpowers/plans/*.md; do
      [ -f "$p" ] || continue
      node scripts/plan-progress.mjs check "$p" || rc=1
    done
    exit $rc

# Run every plugin's harness.
test-all: build
    #!/usr/bin/env bash
    set -eu
    just test
    echo "=== spinner frames ==="
    node test/spinner-frames-harness.mjs
    echo "=== dispatch store ==="
    node test/dispatch-harness.mjs
    echo "=== steering store ==="
    node test/steering-harness.mjs
    for h in {{optional_plugins}} syzygy-editor; do
      echo "=== $h harness ==="
      node "test/$h-harness.mjs"
    done
    echo "=== tasks-parse harness ==="
    node test/tasks-harness.mjs
    node test/refs-harness.mjs
    echo "=== plan-progress harness ==="
    node test/plan-progress-harness.mjs
    echo "=== swarm harness ==="
    node test/swarm-harness.mjs
    echo "=== claims harness ==="
    node test/claims-harness.mjs
    echo "=== cards harness ==="
    node test/cards-harness.mjs
    echo "=== reconcile harness ==="
    node test/reconcile-harness.mjs
    echo "=== canvas harness ==="
    node test/canvas-harness.mjs
    echo "=== usage harness ==="
    node test/usage-harness.mjs
    echo "=== statusline harness ==="
    node test/statusline-harness.mjs
    echo "=== voice harness ==="
    node test/voice-harness.mjs
    echo "=== auth harness ==="
    node test/auth-harness.mjs
    echo "=== spinner.py harness ==="
    node test/spinner-script-harness.mjs
    echo "=== capture harness ==="
    node test/capture-harness.mjs
    echo "=== orchestrator harness ==="
    node test/orchestrator-harness.mjs
    echo "=== findings harness ==="
    node test/findings-harness.mjs

# Drive the Dispatch tab's request store against a temp directory. Hermetic.
test-dispatch:
    node test/dispatch-harness.mjs

# Hermetic: a fake fs for the statusline read, a temp dir for the store, no
# relay.
# The usage window's pure maths and the after-reset queue's atomic store.
test-usage:
    node test/usage-harness.mjs

# Hermetic: SZG_SETTINGS_FILE and SZG_STATUSLINE_DIR mean this never touches
# your real settings.json or statusline directory.
# The statusline wrapper (a real subprocess) and the settings.json installer.
test-statusline:
    node test/statusline-harness.mjs

# Hermetic: SZG_HUD_CONFIG points every run at a temp file, never your real
# ~/.claude/syzygy-hud-hotkeys.json.
# `just spinner`'s script: invalid id refused, other keys preserved, atomic.
test-spinner:
    node test/spinner-script-harness.mjs

# Preserves the existing command as the thing the wrapper execs into; refuses
# rather than clobbering if one is already wrapped, or if there is no
# statusLine.command to wrap in the first place.
# Wire scripts/statusline-syzygy.sh into ~/.claude/settings.json.
statusline-install:
    node scripts/statusline-install.mjs
# The Steering panel's custom-button store: validation bounds, atomic writes,
# a corrupt file quarantined rather than overwritten. Hermetic.
# Drive the custom-button store against a temp directory.
test-steering:
    node test/steering-harness.mjs

# The append-only capture log: one JSON object per line, O_APPEND, rotation
# at 4 MB, a capture failure that returns false rather than throwing. Hermetic
# -- a temp directory, never WORLD_DIR.
# The orchestrator agent's capture log.
test-capture:
    node test/capture-harness.mjs

# bundleContext's priority-ordered sections and 80 KB budget (against a real
# /api/state fixture), the older-relay omission rule, parseActions's fenced
# JSON block, and askArgv. All pure -- no relay, no spawn.
# The orchestrator agent's context bundle and action parser.
test-orchestrator:
    node test/orchestrator-harness.mjs

# The findings store: the record schema, the sanitising reader that drops
# malformed entries rather than throwing, the FINDINGS_MAX cap, and the atomic
# temp-file-then-rename write. Hermetic -- a temp directory, never WORLD_DIR.
# The orchestrator agent's findings store.
test-findings:
    node test/findings-harness.mjs


# Typecheck, validate and run every harness.
verify: check check-pane validate test-all plan-check plan-names


# The pane's browser scripts are loaded by the browser and never by a harness,
# so a merge that unbalances a brace blanks the whole board with no gate
# failing -- which is exactly what the pane-auth merge did.
# Syntax-check every browser script the relay serves.
check-pane:
    #!/usr/bin/env bash
    set -eu
    for f in syzygy/bridge/public/*.js; do node --check "$f"; done
    echo "check-pane: every pane script parses"

# The shipped copy of ~/.claude/syzygy-hud-hotkeys.json is written on install;
# scripts/spinner.py --ensure is the one place that default is spelled out, and
# it never overwrites a file already there.
# Install: link the default plugins, build the terminal pane, report what is
# missing. It NEVER fails on a missing optional dependency -- the band and the
# browser pane work with node alone, and a hard failure here would make an
# install look broken when only an extra is absent.
# Install: link the plugins, build the terminal pane, check the dependencies.
install: deps-check
    #!/usr/bin/env bash
    set -eu
    for p in {{plugins}}; do
      ln -sfn "{{justfile_directory()}}/$p" "{{skills_dir}}/$p"
      echo "linked $p"
    done
    python3 "{{justfile_directory()}}/scripts/spinner.py" --ensure
    if command -v go >/dev/null 2>&1; then
      echo "building the terminal pane..."
      (cd "{{justfile_directory()}}/pane-v2" && go build -o bin/syzygy-pane ./cmd/syzygy-pane)
      echo "built pane-v2/bin/syzygy-pane"
    else
      echo "go is not on PATH: the terminal side pane is not built."
      echo "  install Go, then: just tui2-build"
    fi
    echo
    echo "/reload-plugins loads the plugins now."
    echo "forge is experimental and opt-in: 'just install-forge' adds it."

# Run on its own to see the same report without installing anything.
# What is installed here, and what each missing thing would cost you.
deps-check:
    #!/usr/bin/env bash
    set -u
    say() { printf '  %-8s %-9s %s\n' "$1" "$2" "$3"; }
    have() { command -v "$1" >/dev/null 2>&1 && echo present || echo MISSING; }
    node_v=$(node --version 2>/dev/null || echo none)
    node_major=$(printf '%s' "$node_v" | sed 's/^v//' | cut -d. -f1)
    echo "dependencies:"
    if [ "${node_major:-0}" -ge 22 ] 2>/dev/null; then
      say node "$node_v" "the relay and the browser pane"
    else
      say node "${node_v} !" "REQUIRED, and must be >= 22 -- the relay will not start"
    fi
    say tmux "$(have tmux)" "the terminal side pane, and jumping to a session"
    say go "$(have go)" "builds the terminal side pane (pane-v2)"
    say uv "$(have uv)" "voice input only; a one-time ~2.4 GB install on first use"
    say python3 "$(have python3)" "the install scripts and the statusline side-channel"
    echo
    echo "Nothing but node is required. Each missing item costs exactly the"
    echo "feature named beside it and nothing else."

# Experimental, and off by default: it mints new tools at run time, which is a
# capability worth choosing deliberately rather than inheriting from an
# install. Everything else about it is ordinary -- validated by `just validate`
# and tested by `just test-all` whether it is linked or not.
# Link the experimental forge plugin as well.
install-forge:
    #!/usr/bin/env bash
    set -eu
    for p in {{optional_plugins}}; do
      ln -sfn "{{justfile_directory()}}/$p" "{{skills_dir}}/$p"
      echo "linked $p"
    done
    echo "/reload-plugins loads it now."

# Remove the links. Leaves the source tree alone.
uninstall:
    #!/usr/bin/env bash
    set -eu
    for p in {{plugins}} {{optional_plugins}}; do rm -f "{{skills_dir}}/$p"; echo "unlinked $p"; done

# Show whether the plugin is installed and enabled.
status:
    @ls -l {{link}} 2>/dev/null || echo "not linked"
    @claude plugin list 2>/dev/null | grep -i syzygy || echo "not listed"

# Headless load check: starts a session with the plugin and reports load errors.
smoke:
    ./scripts/smoke.sh

# Open the Syzygy browser pane.
pane:
    @open http://localhost:4317/ || xdg-open http://localhost:4317/

# Read straight from spinner-frames.js (the band's own source), never a
# hand-copied list, so it can't name an id `just spinner` would then refuse.
# List every turn-spinner's id and name.
spinners:
    @node scripts/spinner-ids.mjs --pretty

# Writes settings.spinner into the global config file
# (~/.claude/syzygy-hud-hotkeys.json), which wins over the band's own live
# picker (see hud.tsx's resolveSpinnerId).
# Takes effect at the next turn boundary in any running session -- no
# restart, no /reload-plugins.
# Pin the HUD's turn-spinner. `just spinners` lists valid ids.
spinner id:
    @python3 scripts/spinner.py {{id}}

# /api/state needs the stored token now that it is gated -- read the same way
# relay-dev reads it. /api/health is left alone: it stays open.
# Is the relay up, and who has joined the board?
relay-status:
    #!/usr/bin/env bash
    curl -s -m 2 http://127.0.0.1:4317/api/health || echo "relay not running (it starts itself on session.start)"
    echo
    tok=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude/syzygy-relay.json')))['token'])" 2>/dev/null || echo dev-token)
    curl -s -m 2 "http://127.0.0.1:4317/api/state?token=$tok" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); [print(' ', s['id'][:8], s.get('name'), s.get('model'), '·', (s.get('stats') or {}).get('ctx',0), 'ctx')  for s in d['sessions']]" 2>/dev/null || true

# Stop the relay. It restarts on the next session.start.
relay-stop:
    @pkill -f "bridge/relay.mjs" && echo "relay stopped" || echo "no relay running"

# Set (or change) the pane's password without going through the browser.
# Prompts twice, silently -- never echoed, never taken as an argument -- and
# writes straight through bridge/auth.mjs's own atomic writer. A RUNNING relay
# does not pick this up until its next restart: auth.json is read once at boot
# read once at boot.
# Set or change the pane's password. Prompts twice, silently.
pane-password:
    #!/usr/bin/env bash
    set -eu
    read -r -s -p "New pane password: " SZG_PANE_PW; echo
    read -r -s -p "Confirm: " confirm; echo
    if [ "$SZG_PANE_PW" != "$confirm" ]; then echo "passwords do not match" >&2; exit 1; fi
    if [ "${#SZG_PANE_PW}" -lt 8 ]; then echo "password must be at least 8 characters" >&2; exit 1; fi
    export SZG_PANE_PW
    export SZG_PANE_DIR="${SZG_DATA_DIR:-$HOME/.claude/syzygy}"
    node --input-type=module <<'JS'
    import { hashPassword, writeAuth, readAuth, mintSecret } from './syzygy/bridge/auth.mjs'
    const dir = process.env.SZG_PANE_DIR
    const prior = readAuth(dir)
    const { salt, hash } = hashPassword(process.env.SZG_PANE_PW)
    const nowMs = Date.now()
    writeAuth(dir, { version: 1, salt, hash, secret: mintSecret(), createdAt: prior ? prior.createdAt : nowMs, updatedAt: nowMs })
    JS
    echo "password set. a running relay picks it up on its next restart."

# Run the relay in the foreground with the stored token (for debugging).
relay-dev:
    #!/usr/bin/env bash
    set -eu
    tok=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude/syzygy-relay.json')))['token'])" 2>/dev/null || echo dev-token)
    SZG_TOKEN="$tok" SZG_PORT=4317 node syzygy/bridge/relay.mjs

# Model/effort come from the request store (SZG_DATA_DIR, else
# ~/.claude/syzygy), matched onto each agent by session shortId --
# absent, that column is just blank, same as before this was added.
# What has the Dispatch tab started, and what is each one doing?
dispatch-status:
    @claude agents --json 2>/dev/null | python3 -c "import sys,json,os; agents=[a for a in json.load(sys.stdin) if a.get('kind')=='background']; p=os.path.join(os.environ.get('SZG_DATA_DIR') or os.path.expanduser('~/.claude/syzygy'),'dispatch.json'); items=(json.load(open(p)).get('items') or []) if os.path.exists(p) else []; d={r.get('session',{}).get('shortId'):(r.get('dispatch') or {}) for r in items if r.get('session')}; [print(f\"  {a['id']}  {a['name']:24s} {a.get('state','?'):8s} {a.get('waitingFor') or ''}{'  ' + '/'.join(x for x in (d.get(a['id'],{}).get('model'), d.get(a['id'],{}).get('effort')) if x) if d.get(a['id']) else ''}\") for a in agents]" || echo "no background sessions"

# Run an interactive session with the plugin loaded from this directory (no install).
dev:
    claude --plugin-dir {{plugin_dir}} --debug

# Tail the newest debug log for lines this plugin produced.
logs:
    @f=$(ls -t ~/.claude/logs/*.log 2>/dev/null | head -1); \
     test -n "$f" && tail -n 200 "$f" | grep -iE "syzygy|hud|ui.render" || echo "no debug log yet — run: just dev"

# ---- pane-v2 (Charm v2 terminal pane) ----------------------------------------

# Build the terminal pane binary.
tui2-build:
    cd pane-v2 && go build -o bin/syzygy-pane ./cmd/syzygy-pane

# Run the terminal pane's tests.
tui2-test:
    cd pane-v2 && go test ./...

# Print one frame of the pane at a size and mode, against the live relay.
tui2-snapshot width="41" height="49" mode="grid": tui2-build
    ./pane-v2/bin/syzygy-pane --snapshot --width {{width}} --height {{height}} --mode {{mode}}

# Split the pane beside the current tmux pane, starting in a mode.
tui2 mode="grid": tui2-build
    SZG_MODE={{mode}} ./pane-v2/syzygy-pane.sh

# Close this window's side pane.
tui2-close:
    ./pane-v2/syzygy-pane.sh --close

# Close the side pane if it is open, open it if it is not.
# This is what the band's hotkey 1 runs, and what a tmux root binding should
# call: `bind -n M-p run-shell -b '<repo>/pane-v2/syzygy-pane.sh --toggle'`.
# Open or close this window's side pane, whichever it is not.
tui2-toggle:
    ./pane-v2/syzygy-pane.sh --toggle

# ---- syzygy-editor ----------------------------------------------------------

# The reference regex (backticked, path:line, absolute, relative, and the false
# positives `e.g.` / `v1.2` / a URL that must NOT match), the existence filter
# against an injected fs, the memoisation (two renders of one text = one parse),
# the render tree's shape, the config's defaults, and the script's arguments
# through its own --dry-run. Hermetic: no tmux pane is split and no editor runs.
# Drive the syzygy-editor plugin's harness.
test-editor:
    node test/syzygy-editor-harness.mjs

# The same script the boxes in the transcript press. Outside tmux it prints the
# command it would have run and exits 2.
# Open a file in the editor pane by hand.
edit path:
    ./syzygy-editor/bin/syzygy-edit {{path}}

# Close this window's editor pane (an editor that exits closes it by itself).
edit-close:
    ./syzygy-editor/bin/syzygy-edit --close
