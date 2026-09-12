#!/usr/bin/env node
// Syzygy relay — the fan-in point between every Claude Code session
// running the plugin and every browser pane watching them.
//
//   session plugin  --POST /api/register,/api/stats-->  relay  --SSE-->  pane
//   session plugin  <--GET /api/commands/:id----------  relay  <--POST--  pane
//
// No dependencies: http + crypto only, Server-Sent Events instead of a
// WebSocket so there is nothing to install. Bound to 127.0.0.1; every write
// endpoint needs the shared token.

import http from 'node:http'
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, renameSync, mkdirSync, realpathSync } from 'node:fs'
import { jumpCase, jumpToSession, tmuxOfPid } from './jump.mjs'
import { extname, join, dirname, resolve, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { createStore, validateProject } from './requests.mjs'
import { createSteeringStore } from './steering.mjs'
import { createCapture } from './capture.mjs'
import { createFindings } from './findings.mjs'
import { createCards, validateColor } from './cards.mjs'
import { createScoper } from './scoping.mjs'
import { createDispatcher, IMPLEMENT_PROMPT } from './dispatch.mjs'
import { probeDispatchOptions } from './dispatch-options.mjs'
import { createScanner, probe } from './tasks.mjs'
import { readClaims, writeClaim, removeClaim, transferClaim } from './claims.mjs'
import { inheritableClaim } from './claims-inherit.mjs'
import { parseUsage, readNewestStatusline, dueEntries, crossings, NOTIFY_THRESHOLDS, DEFAULT_STALE_MS, DEFAULT_POLL_MS } from './usage.mjs'
import { createAfterResetStore, WINDOW_ALIASES } from './after-reset.mjs'
import {
  readAuth, writeAuth, hashPassword, verifyPassword, mintSecret,
  signCookie, verifyCookie, parseCookies, rateLimiter, gate,
} from './auth.mjs'
import {
  emptyCanvas, sanitizeCanvas, inheritPosition, liveSpawnCount, settleSpawns, movePending, pruneNodes,
  pushRecent, spawnSession, attachSession, realRun, validateCwd, completeDirs,
  pickClaudeBin, probeClaudeBin, probeSafeMode, killPlan, killSession,
  OBSERVED_TERMINAL, COORD_MAX, NULL_STATE_MAX_MS, PROMPT_MAX,
} from './canvas.mjs'
import { createVoice, MAX_AUDIO_BYTES, MAX_SECONDS, CHUNK_MS } from './voice.mjs'
// The gear's Spinner control reads/writes the exact same file and the exact
// same id list hud.tsx does -- SPINNERS is imported straight from
// spinner-frames.js (plain JS, no compile step), never a second copy the gear
// could offer an id the band would reject.
import { SPINNERS } from '../hooks/spinner-frames.js'
import { createOrchestrator, DEFAULT_BLURB_MIN_MS } from './orchestrator.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(HERE, 'public')
const LOGIN_HTML = join(PUBLIC, 'login.html')
/** The launch config is read from `SZG_*` and nothing else, with no fallback
 *  to any other spelling. A `--bg` daemon is cold-started once and keeps that
 *  launcher's environment for good, so an ambient variable in a long-lived
 *  daemon is indistinguishable from a deliberate one by the time this file
 *  reads `process.env` -- and honouring it would bind the relay to somebody
 *  else's port and persist the world somewhere nobody chose. `hud.tsx` refuses
 *  a fallback for `SZG_RELAY_PORT` / `SZG_RELAY_TOKEN` for the same reason. */

const PORT = Number(process.env.SZG_PORT || 4317)
const TOKEN = process.env.SZG_TOKEN || 'dev-token'
// The port actually BOUND, which is PORT unless PORT is 0 (OS-assigned, used
// by tests). It is what a spawned session must be told to register with, so it
// has to be the real one, not the requested one. Assigned in the `listen`
// callback; nothing can spawn before the server is listening.
let boundPort = PORT
const SESSION_TTL_MS = 90_000
const EVENT_CAP = 400
const SERIES_CAP = 240
const REPLAY_CAP = 4000
// SSE has no protocol-level backpressure signal back to the relay: a pane that
// stops reading (a backgrounded tab throttled, a laptop lid closed, a pane
// latched offline but still holding the socket) never tells us so, and every
// `res.write` in the meantime just queues in Node's writable buffer. Diagnosed
// one such client, against the ~4s project-scan cadence and its
// 2.6+ MB payload under nine churning worktrees, took the shared relay's heap
// to 4+ GB and OOM in about an hour. Past this many buffered
// bytes a client is not draining, full stop, and is dropped rather than left
// to grow without bound -- a dropped pane just reconnects and gets a fresh
// snapshot (hud.tsx/app.js already do this on their own). A few frames' worth
// of slack for a merely slow-but-alive client.
const SSE_MAX_BUFFERED_BYTES = 8 * 1024 * 1024
// An OPTIONAL state migration, loaded here -- before the first constant that
// names a path, because everything below reads from whatever it leaves in
// place. `./migrate.mjs` is not part of a release: a fresh install has nothing
// to migrate, so the module is absent and this whole block is a no-op. It is
// skipped under SZG_DATA_DIR too, since a test pointed at a temp directory has
// no state to move and must never touch the real one.
if (!process.env.SZG_DATA_DIR) {
  try {
    const m = await import('./migrate.mjs')
    for (const line of m.migrateState()) process.stdout.write(line + '\n')
  } catch (e) {
    // A module that is not there is the normal case and says nothing. Anything
    // else is a real fault, and is reported rather than swallowed -- but it
    // still must not stop the relay coming up.
    if (e?.code !== 'ERR_MODULE_NOT_FOUND') process.stderr.write(`migrate: ${e?.message ?? e}\n`)
  }
}
// Overridable so tests -- and only tests -- can point the relay at an
// isolated directory instead of the real, shared ~/.claude/syzygy.
// world.json and dispatch.json are authoritative user data; a test process
// must never load, mutate or flush the real files.
const WORLD_DIR = process.env.SZG_DATA_DIR || join(homedir(), '.claude', 'syzygy')
const WORLD_FILE = join(WORLD_DIR, 'world.json')
const DISPATCH_FILE = join(WORLD_DIR, 'dispatch.json')
const STEERING_FILE = join(WORLD_DIR, 'steering.json')
const TASKS_FILE = join(WORLD_DIR, 'tasks.json')
const SCAN_INTERVAL_MS = 4000
// Where the statusline wrapper drops the account's rate-limit reading
// per session. Overridable so the
// harness -- and only the harness -- can point at a fixture directory instead
// of the real, shared drop directory; production gets it for free by sitting
// next to WORLD_DIR, which is exactly where the real one already lives.
const STATUSLINE_DIR = process.env.SZG_STATUSLINE_DIR || join(WORLD_DIR, 'statusline')
const AFTER_RESET_FILE = join(WORLD_DIR, 'after-reset.json')
// The same file hud.tsx's loadHotkeys reads and scripts/spinner.py writes --
// NOT under WORLD_DIR, because it is user configuration rather than relay
// state. Overridable the same way, and by the same
// env var scripts/spinner.py honours, so one hermetic fixture serves both a
// relay test and a script test without inventing a second name for it.
const HUD_CONFIG_FILE = process.env.SZG_HUD_CONFIG || join(homedir(), '.claude', 'syzygy-hud-hotkeys.json')
// The findings store. Under
// WORLD_DIR like every other authoritative store, never a hardcoded path.
const FINDINGS_FILE = join(WORLD_DIR, 'findings.json')
// A session card's own outline colour (cards.mjs). Under WORLD_DIR, same as
// FINDINGS_FILE just above, and for the same reason.
const CARDS_FILE = join(WORLD_DIR, 'cards.json')
// Claude Code's own per-pid session registry. Read-only, and the ONE field
// read out of it is `tmux` -- the pane a session is sitting in, which is
// documented nowhere and is a hint rather than a contract (hud.tsx:594 reads
// the same file for names, with the same caveat). Overridable so the harness
// points at a fixture directory instead of the real one.
const SESSIONS_DIR = process.env.SZG_SESSIONS_DIR || join(homedir(), '.claude', 'sessions')
// and. The DEFAULT lives in usage.mjs so there is one source for it;
// this is only the env-var plumbing, matching every other SZG_*_MS constant
// in this file.
const USAGE_POLL_MS = Number(process.env.SZG_USAGE_POLL_MS) > 0 ? Number(process.env.SZG_USAGE_POLL_MS) : DEFAULT_POLL_MS
const USAGE_STALE_MS = Number(process.env.SZG_USAGE_STALE_MS) > 0 ? Number(process.env.SZG_USAGE_STALE_MS) : DEFAULT_STALE_MS
// How many CHANGED readings the telemetry sparkline gets to draw from. Not a
// time window -- a reading that never changes (nobody working overnight)
// costs nothing and pushes nothing, so this is depth, not duration.
const USAGE_RING_CAP = 120

// ---- pane auth ---------------------------
// AUTH_OFF is read once at module scope, not re-read per request: an opt-out
// documented as such, for the harnesses and for a user who wants the
// pane open on loopback. With it set, the gate is a no-op and the static
// handler resumes injecting the real token exactly as before this
// feature existed.
const AUTH_OFF = process.env.SZG_PANE_PASSWORD_DISABLED === '1'
const AUTH_COOKIE = 'szg_auth'
const COOKIE_MAX_AGE_MS = 30 * 24 * 3600 * 1000 // 30 days
// The auth record is loaded once at boot and kept in module state, refreshed
// by every write path (setup/login-rotate/reset) below -- never re-read from
// disk per request.
let auth = readAuth(WORLD_DIR)
// 10 failed logins per remote address per 60s, then 429. In-memory: a
// relay restart clearing it is not a weakness worth a file.
const loginLimiter = rateLimiter({ limit: 10, windowMs: 60_000 })

/** Whether `req` carries a currently-valid session cookie. False whenever no
 *  password is configured at all -- there is no secret yet to check against. */
const cookieValid = (req) => {
  if (!auth) return false
  const cookies = parseCookies(req.headers.cookie)
  return verifyCookie(auth.secret, cookies[AUTH_COOKIE], Date.now(), COOKIE_MAX_AGE_MS)
}

const setAuthCookie = (res, value) => {
  res.setHeader('set-cookie', `${AUTH_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`)
}
const clearAuthCookie = (res) => {
  res.setHeader('set-cookie', `${AUTH_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
}
// The session canvas. Overridable so the harness can point the relay at a
// fake `claude`; production never sets these.
//
// WHICH `claude` is chosen by capability at boot, not taken on faith from
// PATH. Installs differ, and a machine can carry more than one: an older build
// has neither `--bg` nor `attach` and may still win PATH in some shells.
// A relay started from the wrong shell failed every spawn on
// `unknown option '--bg'` and every attach on an unknown subcommand, and
// nothing said why. See canvas.mjs's pickClaudeBin.
//
// SZG_CLAUDE_BIN, when set, is the ONLY candidate. A configured binary that
// does not work is a mistake to report, not one to route around -- and the
// harness depends on it: a fallback to a real `claude` would let a test spawn
// a real session.
const CLAUDE_CANDIDATES = process.env.SZG_CLAUDE_BIN
  ? [process.env.SZG_CLAUDE_BIN]
  : [join(homedir(), '.local', 'bin', 'claude'), 'claude']
const CLAUDE_BIN = await pickClaudeBin(CLAUDE_CANDIDATES, (b) => probeClaudeBin(b, realRun))
// The Dispatch tab's pickers, read from the resolved binary's own --help once
// at boot -- the same shape as pickClaudeBin's capability probe just above,
// and for the same reason: ask the binary, do not assume the machine.
const DISPATCH_OPTIONS = await probeDispatchOptions(CLAUDE_BIN, realRun)
// Does this binary understand `--safe-mode`? Probed the same way and at the
// same moment, and used for the relay's OWN `claude -p` children -- the
// orchestrator's ask and blurb, and a scoping turn. Those are handed their
// whole context in the prompt and have no use for the host's own plugins,
// skills, project instructions or MCP servers; loading them cost the blurb
// session.start before a word of output, and put a card on the switchboard
// nobody started. False on a binary that has never heard of the
// flag, where SZG_HEADLESS in `--settings` is the fallback.
const CLAUDE_SAFE_MODE = await probeSafeMode(CLAUDE_BIN, realRun)
if (CLAUDE_BIN) {
  const v = await realRun(CLAUDE_BIN, ['--version'], { timeout: 8000 }).catch(() => null)
  process.stdout.write(`canvas: using ${CLAUDE_BIN} (${String(v?.stdout ?? '').trim() || 'version unknown'})\n`)
} else {
  // Said once, plainly, at boot. The relay still serves the board -- the canvas
  // is one tab of it -- but the two endpoints that shell out say 503 rather
  // than passing a CLI error nobody asked for back up as a 502.
  process.stderr.write(`canvas: no claude binary with --bg found (tried: ${CLAUDE_CANDIDATES.join(', ')}); /api/spawn and /api/attach are disabled\n`)
}
const NO_CLAUDE = { error: 'no claude binary with --bg was found — see the relay\'s stderr' }

// Voice input: no boot-time resolution at all, and deliberately so.
// The venv and the model are installed through the settings section, not
// found on PATH, so there is nothing to probe for at boot either way: env
// and model presence are plain `existsSync`/`statSync` checks inside
// voice.mjs's own state(), re-read on every request. `SZG_UV_BIN` and
// `SZG_VOICE_WORKER_PY`, when set, are the only candidates -- exactly how
// `SZG_CLAUDE_BIN` is treated above.
const UV_BIN = process.env.SZG_UV_BIN || 'uv'
const VOICE_WORKER_PY = process.env.SZG_VOICE_WORKER_PY || join(HERE, 'voice-worker.py')
const TMUX_BIN = process.env.SZG_TMUX_BIN || 'tmux'
// A DEVELOPMENT knob, unset in production. When set, /api/spawn adds
// `--plugin-dir <dir>` to the child's argv, so the session it starts loads the
// plugin from a checkout other than the installed one -- which is how a relay
// running from a branch spawns sessions that carry that branch's plugin and so
// talk back to IT rather than to the installed plugin's default port.
const SPAWN_PLUGIN_DIR = process.env.SZG_SPAWN_PLUGIN_DIR || null
/** How often the relay asks Claude Code which sessions are parked at a prompt.
 *  Its own interval, and its own subprocess: the canvas's poll is gated on an
 *  unsettled spawn record and so is usually not running at all. */
const NEEDS_POLL_MS = Number(process.env.SZG_NEEDS_POLL_MS) > 0 ? Number(process.env.SZG_NEEDS_POLL_MS) : 6000
const CANVAS_POLL_MS = Number(process.env.SZG_CANVAS_POLL_MS) > 0 ? Number(process.env.SZG_CANVAS_POLL_MS) : 5000
// The orchestrator agent.
// Models are separately configurable because the ask and the blurb are
// deliberately different weights (opus for the ask a human is waiting on,
// sonnet for the unattended summary) -- see orchestrator.mjs's own defaults
// for the budgets and timeouts, which are fixed rather than env-tunable.
const ORCH_MODEL = process.env.SZG_ORCH_MODEL || undefined
const ORCH_BLURB_MODEL = process.env.SZG_ORCH_BLURB_MODEL || undefined
const ORCH_BLURB_MIN_MS = Number(process.env.SZG_ORCH_BLURB_MIN_MS) > 0 ? Number(process.env.SZG_ORCH_BLURB_MIN_MS) : DEFAULT_BLURB_MIN_MS
// How often the relay CHECKS whether a background blurb refresh is due --
// its own cadence, well under the 10-minute floor those checks enforce, so a
// pane connecting or the board changing is noticed promptly without costing
// anything itself (the checks are free; only a refresh that actually runs
// spends a turn).
const ORCH_BLURB_TICK_MS = 60_000
// How far a node may be dragged. One constant, canvas.mjs's, so /api/spawn's
// pre-positioned node and /api/canvas/move cannot disagree about the bounds.
const clampPos = (v) => Math.min(COORD_MAX, Math.max(0, Math.round(v)))
// A spawn record stops being polled for once a listing has OBSERVED it
// terminal -- `missing` is only inferred, so a record wearing it is still
// revivable -- or once it is NULL_STATE_MAX_MS old, whichever comes first.
// Without the age floor one session that vanished for good costs a subprocess
// every 5 s forever. It is deliberately the SAME constant isLiveSpawn stops
// counting a never-listed record at: the moment the relay gives up asking is
// the moment it may stop counting the answer it will never get.
const CANVAS_POLL_MAX_AGE_MS = NULL_STATE_MAX_MS
// The canvas's `home`: where the spawn form's directory field starts when
// there is no recent to start it from. The relay's OWN project root -- its
// cwd, resolved, then widened to the git worktree root if it is inside one --
// because the relay is already running where the user works. Computed once,
// here, rather than per request: it cannot change while the process lives, and
// probe() shells out to git. A relay started outside a repo keeps its cwd,
// which is still a real directory and still a better default than nothing.
const CANVAS_HOME = await (async () => {
  let cwd = process.cwd()
  try { cwd = realpathSync(cwd) } catch {}
  try { return (await probe(cwd))?.worktreeRoot ?? cwd } catch { return cwd }
})()

/** @type {Map<string, any>} */ const sessions = new Map()
/** @type {Map<string, any[]>} */ const commands = new Map()
/** @type {any[]} */ let events = []
/** @type {any[]} */ let questions = []   // ask_human, awaiting an answer
/** @type {any[]} */ let approvals = []   // risky actions awaiting a verdict
/** @type {Map<string, {resolve:(v:any)=>void}>} */ const waiters = new Map()
/** @type {Set<http.ServerResponse>} */ const panes = new Set()
/** @type {any[]} */ let links = []       // wires drawn between sessions
/** @type {any[]} */ let replay = []      // the full session log, for the scrubber

/** The relay's persisted state, kept across sessions and reboots: the session
 *  canvas's node layout. The file is named `world.json` rather than for the
 *  canvas because it is live user state on every installed machine, and
 *  renaming it would buy a migration and no behaviour. */
const emptyWorld = () => ({ version: 1, canvas: emptyCanvas() })
let world = emptyWorld()

const loadWorld = () => {
  try { world = { ...emptyWorld(), ...JSON.parse(readFileSync(WORLD_FILE, 'utf8')) } }
  catch { world = emptyWorld() }
  // An older world.json has no canvas key, and a hand-edited one may hold
  // anything: coerce once here so no consumer guards the shape.
  world.canvas = sanitizeCanvas(world.canvas)
}
let worldDirty = false
const saveWorld = () => {
  if (!worldDirty) return
  worldDirty = false
  try { mkdirSync(WORLD_DIR, { recursive: true }); writeFileSync(WORLD_FILE, JSON.stringify(world)) } catch {}
}
loadWorld()
setInterval(saveWorld, 4000).unref?.()

/** The Dispatch tab's queue. Authoritative, unlike the world: a brief exists
 *  nowhere else until it is dispatched. Saved on the same 4 s cadence. */
const requests = createStore({ file: DISPATCH_FILE })
const steering = createSteeringStore({ file: STEERING_FILE })
setInterval(() => { try { requests.flush() } catch (e) { process.stderr.write(`dispatch save failed: ${e.message}\n`) } }, 4000).unref?.()

/** The orchestrator agent's memory: an append-only log of board actions,
 *  beside the two authoritative
 *  stores above. `append()` never throws -- every call site below still
 *  wraps it in try/catch, per the rule that a capture failure must never
 *  fail the action that caused it. */
const capture = createCapture({ dir: WORLD_DIR })

/** What one session learned that changes another session's work
 *  AUTHORITATIVE like
 *  `requests` above -- a finding exists nowhere else -- so findings.mjs
 *  writes through atomically on every `add` rather than on a timer, and
 *  there is deliberately no flush() on the 4 s tick or in shutdown(): by the
 *  time either could run, the record is already on disk. */
const findings = createFindings({ file: FINDINGS_FILE })

/** A session card's own outline colour, set from the drawer (cards.mjs).
 *  AUTHORITATIVE like `findings` just above and write-through for the same
 *  reason: a colour is picked at human pace, and a relay killed right after
 *  the pick should not lose it waiting on the 4 s world tick. */
const cards = createCards({ file: CARDS_FILE })

/** The after-reset queue: work waiting on the account's 5h/7d usage window to
 *  roll over. Authoritative like `requests` just above, for the same reason
 *  (see after-reset.mjs's header), saved on the same 4 s cadence. */
const afterReset = createAfterResetStore({ file: AFTER_RESET_FILE })
setInterval(() => { try { afterReset.flush() } catch (e) { process.stderr.write(`after-reset save failed: ${e.message}\n`) } }, 4000).unref?.()

/** The projects scanner: task files across every worktree of every project a
 *  session is running in. Its own timer, never the stats path -- /api/stats
 *  fires ~1.2 s per session and this reads files. */
const scanner = createScanner({ registerFile: TASKS_FILE })
let projects = []
let projectsJson = '[]'

// Ordering here has no independent safety net -- each callee must stay
// self-guarded (saveWorld() already swallows its own errors). requests.flush()
// does not, and this is the one path where losing the queue is unrecoverable
// (it is authoritative, not derived -- see requests.mjs's header), so a
// failure here is never silent.
const shutdown = () => {
  scoper.killAll()
  orchestrator.killAll()
  voice.stop()
  saveWorld()
  try { requests.flush() } catch (e) { process.stderr.write(`dispatch save failed on shutdown: ${e.message}\n`) }
  try { afterReset.flush() } catch (e) { process.stderr.write(`after-reset save failed on shutdown: ${e.message}\n`) }
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

const now = () => Date.now()
const uid = () => Math.random().toString(36).slice(2, 10)

const live = () => {
  const cutoff = now() - SESSION_TTL_MS
  for (const [id, s] of sessions) if (s.seenAt < cutoff) sessions.delete(id)
  return [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt)
}

/** What the pane sees: the persisted canvas plus the two things only the relay
 *  can supply. `live` is the count that must never be quiet: nothing refuses
 *  a spawn, so the count is the tab's only guard. `home`
 *  is where the spawn form's directory field starts when nothing better is
 *  known; the pane cannot work it out, since it has no filesystem. */
const canvasPayload = () => ({ ...world.canvas, live: liveSpawnCount(world.canvas.spawnedBy, now()), home: CANVAS_HOME })

// ---- the gear's Spinner control -------------------------------------------
//
// Reads and writes the same ~/.claude/syzygy-hud-hotkeys.json hud.tsx's
// loadHotkeys reads and scripts/spinner.py writes. Tolerates everything that
// file already tolerates -- missing, unparsable, or a settings block that
// isn't there -- the same "hand-editable, degrade rather than throw" contract
// hud.tsx's own parseSettings documents, because this file is genuinely
// hand-edited and a bad key must not cost every other setting in it.
const readHudConfig = () => {
  try {
    const doc = JSON.parse(readFileSync(HUD_CONFIG_FILE, 'utf8'))
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  } catch {
    return {}
  }
}

/** The gear never offers, and never trusts back, an id the band itself would
 *  reject -- `current` is null (not just "whatever the file happens to say")
 *  when the file's value fails the exact same SPINNERS membership check
 *  hud.tsx's resolveSpinnerId applies, so a stale or hand-typo'd id in the
 *  file cannot make the dropdown appear to have a selection it does not. */
const hudPayload = () => {
  const settings = readHudConfig().settings
  const pinned = settings && typeof settings === 'object' ? settings.spinner : undefined
  const current = typeof pinned === 'string' && SPINNERS.some((sp) => sp.id === pinned) ? pinned : null
  return { spinners: SPINNERS.map((sp) => ({ id: sp.id, name: sp.name })), current }
}
// Its own `hud` SSE event, never the whole snapshot -- same discipline as
// `canvasChanged`/`voiceChanged`.
const hudChanged = () => broadcast('hud', hudPayload())

/** Same atomic-write contract as claims.mjs/requests.mjs: serialize, write to
 *  a temp file in the SAME directory, then rename over the target -- a failed
 *  serialize or write leaves the previous file intact. Every field this relay
 *  does not understand (`_readme`, `hotkeys`, any other setting) is carried
 *  through untouched, same as scripts/spinner.py's `set_spinner`; the two
 *  never need to agree on more than the one field they both write. An empty
 *  string CLEARS the pin (deletes the key) rather than writing an id that
 *  would fail every validity check downstream -- the gear's "leave it to the
 *  picker" option. */
const writeHudSpinner = (id) => {
  const doc = readHudConfig()
  const settings = { ...(doc.settings && typeof doc.settings === 'object' ? doc.settings : {}) }
  if (id) settings.spinner = id
  else delete settings.spinner
  const next = { ...doc, settings }
  mkdirSync(dirname(HUD_CONFIG_FILE), { recursive: true })
  const tmp = `${HUD_CONFIG_FILE}.tmp-${process.pid}-${now()}`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameSync(tmp, HUD_CONFIG_FILE)
}

const snapshot = () => ({
  t: now(),
  sessions: live(),
  events: events.slice(-EVENT_CAP),
  questions,
  approvals,
  links,
  projects,
  canvas: canvasPayload(),
  dispatch: { requests: requests.all() },
  dispatchOptions: DISPATCH_OPTIONS,
  // `usage` is the parsed reading itself (usage.mjs's parseUsage shape);
  // `usageHistory` is the ring of changed readings the sparkline draws from;
  // the queue rides under `afterReset` rather than inside `usage`, so a field
  // named `usage` never has to also mean "the whole usage-window feature".
  usage: currentUsage,
  usageHistory,
  afterReset: { queue: afterReset.all() },
  steering: { custom: steering.all() },
  voice: voicePayload(),
  hud: hudPayload(),
  // The orchestrator agent's blurb. `orchestrator` is referenced here only
  // inside this function body,
  // called well after its `const` is assigned below -- same TDZ-safe pattern
  // as `voicePayload()` just above.
  orchestrator: orchestrator.state(),
  viewers: panes.size,
  // The gear's password section reads this rather than getting its own
  // endpoint: `enabled` is false either when no password is configured yet
  // (the pane got here on a valid token, not a cookie) or when AUTH_OFF is
  // set -- both mean "no control here can do anything", so they collapse to
  // one flag rather than two the UI would have to reason about separately.
  auth: { enabled: Boolean(auth) && !AUTH_OFF },
})

/** Removes one SSE client, once, and says why on stderr. Called from the
 *  buffered-bytes check below and from the connection's own close/error
 *  handlers, so it has to be idempotent: `panes.delete` returning false means
 *  someone already dropped this one and there is nothing left to report --
 *  whichever path notices first does the work, silently, for the others.
 *  Broadcasting `viewers` here (not just from the plain-close path, as
 *  before) recurses into `broadcast` -- safe, because `res` is already out of
 *  `panes` by the time it runs, so the nested loop cannot revisit it. */
const dropPane = (res, reason) => {
  if (!panes.delete(res)) return
  process.stderr.write(`sse: dropping a client that stopped draining (${reason})\n`)
  try { res.destroy() } catch {}
  broadcast('viewers', { viewers: panes.size })
}

const broadcast = (type, data) => {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of panes) {
    try {
      res.write(frame)
      // `writableLength` is what is still queued after this write -- the exact
      // quantity that grows without bound while a client never reads. Checked
      // after every frame, not on a timer, so a stalled client is caught the
      // broadcast cycle it falls behind on, not one scan interval later.
      if (res.writableLength > SSE_MAX_BUFFERED_BYTES) {
        dropPane(res, `${res.writableLength} bytes buffered`)
      }
    } catch { dropPane(res, 'write threw') }
  }
}

/** Every canvas write goes through here: the persisted state is dirty, and
 *  the panes hear about it on the `canvas` event, which carries the canvas
 *  alone rather than everything the relay persists. */
const canvasChanged = () => { worldDirty = true; broadcast('canvas', canvasPayload()) }

// The Dispatch tab's scoping engine: spawns and manages headless `claude -p`
// children. Constructed here, after `broadcast`, rather than beside the
// `requests` store above — it closes over `broadcast`, which is a `const`
// declared below that point and is not yet initialised there.
// `claudeBin` is the capability-resolved one, so the Dispatch tab and the
// canvas cannot disagree about which `claude` is meant. Both modules
// already took the parameter; they were simply never given it. `|| 'claude'`
// keeps their own default when nothing resolved -- their failure mode is
// theirs to own, and neither is this branch's file to change.
// Voice input: `ready` is computed HERE, not in voice.mjs --
// createVoice's own state() only knows about voice.json, the venv and the
// model on disk, and the worker's own reported liveness, never how those
// three combine into the one boolean the pane gates everything on.
// `voicePayload` references `voice` only inside its body, not at definition
// time, so this is the same TDZ-safe ordering as `scoper`/`dispatcher` just
// below: `voice` is assigned after `voiceChanged` is handed to createVoice,
// and neither `voicePayload` nor `voiceChanged` is CALLED until well after
// that.
const voicePayload = () => {
  const st = voice.state()
  return {
    ...st,
    ready: !!(st.enabled && st.env.present && st.model.present && st.worker.up),
    engine: 'openai-whisper',
    device: st.worker.device,
    modifier: 'Control',
    maxSeconds: MAX_SECONDS,
    maxBytes: MAX_AUDIO_BYTES,
    chunkMs: CHUNK_MS,
  }
}
// Its own `voice` SSE event, never the whole snapshot -- same discipline as
// canvasChanged broadcasting only `canvas`.
const voiceChanged = () => broadcast('voice', voicePayload())
const voice = createVoice({ dir: WORLD_DIR, uvBin: UV_BIN, workerPy: VOICE_WORKER_PY, broadcast: voiceChanged })

const scoper = createScoper({ store: requests, broadcast, claudeBin: CLAUDE_BIN || 'claude', safeMode: CLAUDE_SAFE_MODE })

// The Dispatch tab's dispatcher: git worktrees and background `claude`
// sessions. Same TDZ reason as `scoper` just above -- it closes over
// `broadcast`, so it is built here, after `broadcast` exists, not beside the
// `requests` store.
const dispatcher = createDispatcher({ store: requests, broadcast, claudeBin: CLAUDE_BIN || 'claude',
  // Read at dispatch time, not now: `boundPort` is assigned in server.listen,
  // long after this line runs. The canvas reads it at call time in its handler
  // for the same reason.
  relayInfo: () => ({ relayPort: boundPort, relayToken: TOKEN }) })
// one subprocess per pass, not one per session.
setInterval(() => {
  dispatcher.poll().catch((e) => process.stderr.write(`dispatch poll failed: ${e?.stack || e}\n`))
}, 5000).unref?.()

// The orchestrator agent. Same TDZ
// reasoning as `scoper`/`dispatcher` just above -- it closes over `broadcast`
// and `capture` -- plus `snapshot` and `panes`, both referenced only INSIDE
// a function body (`snapshot()`/`() => panes.size`) that is not actually
// called until well after every module-level `const` here has run, the same
// lazy-closure trick `voicePayload` already relies on for `voice`.
const orchestrator = createOrchestrator({
  broadcast, capture, findings, claudeBin: CLAUDE_BIN || 'claude', safeMode: CLAUDE_SAFE_MODE,
  snapshot: () => snapshot(), panesSize: () => panes.size,
  askModel: ORCH_MODEL, blurbModel: ORCH_BLURB_MODEL, blurbMinMs: ORCH_BLURB_MIN_MS,
})
// the timer trigger. Its own gates (a pane connected, the board having
// changed, the 10-minute floor) live inside refreshBlurb() itself; this tick
// only has to run often enough that none of those becomes stale by more than
// ORCH_BLURB_TICK_MS, which the loop's own comment above sizes against the
// 10-minute floor it is checking for.
setInterval(() => {
  orchestrator.refreshBlurb().catch((e) => process.stderr.write(`orchestrator blurb tick failed: ${e?.stack || e}\n`))
}, ORCH_BLURB_TICK_MS).unref?.()

// The canvas's spawn ledger: one `claude agents --json --all` per pass, only
// while some record is still worth asking about, folded onto the ledger (spec
// the live count is the relay's to compute, never the pane's guess).
// `live` can also move with no record change -- the grace window expiring --
// so the count is compared too, or a tab could show a stale number until the
// next write.
let lastLive = -1
// A failing listing is the one case where the count stays high on its own (see
// canvas.mjs's isLiveSpawn), so the CAUSE has to be visible or a count that
// never comes down looks like a bug in the canvas. One line per failure
// STREAK, not one every CANVAS_POLL_MS: a binary that has gone missing would
// otherwise write 12 lines a minute forever.
let canvasListFailed = false
// Same guard rescan() carries further down, for the same reason: `realRun`'s
// 30 s timeout is longer than CANVAS_POLL_MS, so a `claude agents` that hangs
// would otherwise stack a new child on the stuck one every pass, and their
// completions would race to fold listings of different ages onto the ledger.
let canvasPolling = false
const canvasTick = async () => {
  if (canvasPolling) return
  canvasPolling = true
  try { await canvasPass() } finally { canvasPolling = false }
}
const canvasPass = async () => {
  const t = now()
  const open = world.canvas.spawnedBy.some((r) =>
    !OBSERVED_TERMINAL.has(r.state) && t - (r.spawnedAt ?? 0) < CANVAS_POLL_MAX_AGE_MS)
  let changed = false
  // No usable binary means no listing to fold. Records keep counting, which is
  // the fail-closed direction, and the boot line on stderr already says why --
  // one more line every 5 s would only bury it.
  if (open && CLAUDE_BIN) {
    const out = await realRun(CLAUDE_BIN, ['agents', '--json', '--all'], {})
    let agents = null
    let why = `exit ${out.code}: ${String(out.stderr || out.stdout || '').trim().slice(0, 200)}`
    if (out.code === 0) {
      try { agents = JSON.parse(out.stdout); why = '' } catch (e) { why = `unparseable JSON: ${e.message}` }
      // Valid JSON that is not an array is not a listing either: settleSpawns
      // ignores it, so it must count as a failure here too, or it would clear
      // the streak flag and a real failure streak would stop being reported.
      if (why === '' && !Array.isArray(agents)) { why = 'not a JSON array'; agents = null }
    }
    if (agents === null && !canvasListFailed) {
      canvasListFailed = true
      process.stderr.write(`canvas: claude agents --json failed (${why}); spawn records stay counted until a listing succeeds\n`)
    } else if (agents !== null) canvasListFailed = false
    const settled = settleSpawns(world.canvas.spawnedBy, agents, now())
    if (settled.changed) { world.canvas.spawnedBy = settled.spawnedBy; changed = true }
    const moved = movePending(world.canvas.nodes, world.canvas.spawnedBy)
    if (moved.changed) { world.canvas.nodes = moved.nodes; changed = true }
  }
  const pruned = pruneNodes(world.canvas.nodes, new Set(sessions.keys()), now())
  if (pruned.changed) { world.canvas.nodes = pruned.nodes; changed = true }
  const liveNow = liveSpawnCount(world.canvas.spawnedBy, now())
  if (changed || liveNow !== lastLive) { lastLive = liveNow; canvasChanged() }
}
setInterval(() => {
  canvasTick().catch((e) => process.stderr.write(`canvas poll failed: ${e?.stack || e}\n`))
}, CANVAS_POLL_MS).unref?.()

// ---- waiting on a human ----------------------------------------------------
// Claude Code already knows when a session is parked at a prompt: `claude
// agents --json --all` reports `status: 'waiting'` with a `waitingFor` string.
// That is authoritative, so it is read rather than inferred -- the plugin
// supplies only the other half, what a finished turn asked for in prose.
//
// Its OWN poll rather than the canvas's, because canvasTick shells out only
// while a spawn record is still unsettled (`open` above), which is almost
// never. Piggybacking would leave this blind nearly all the time.
//
// A failing listing changes nothing: absence of a listing says nothing about
// any session, exactly as settleSpawns treats it. The failure is reported once
// per streak so a missing binary is visible without writing a line every poll.
let needsListFailed = false
// Re-entrancy guard. The listing takes about a quarter of a second against a
// six-second interval, so overlap needs something to go wrong first -- but a
// `claude` that hangs is exactly that something, and without this each tick
// would start another child on top of the stuck one until the box gave out.
// Skipping a tick costs nothing: the next one reads current state anyway.
let needsInFlight = false
const needsTick = async () => {
  if (!CLAUDE_BIN || sessions.size === 0 || needsInFlight) return
  needsInFlight = true
  try {
    await needsPass()
  } finally {
    needsInFlight = false
  }
}
const needsPass = async () => {
  const out = await realRun(CLAUDE_BIN, ['agents', '--json', '--all'], {})
  let agents = null
  let why = `exit ${out.code}: ${String(out.stderr || out.stdout || '').trim().slice(0, 200)}`
  if (out.code === 0) {
    try { agents = JSON.parse(out.stdout); why = '' } catch (e) { why = `unparseable JSON: ${e.message}` }
  }
  if (!Array.isArray(agents)) {
    if (!needsListFailed) {
      needsListFailed = true
      process.stderr.write(`needs: claude agents --json failed (${why}); waiting flags hold their last value\n`)
    }
    return
  }
  needsListFailed = false
  const byId = new Map()
  for (const a of agents) if (a && typeof a.sessionId === 'string') byId.set(a.sessionId, a)
  let changed = false
  for (const [id, s] of sessions) {
    const a = byId.get(id)
    // Absent from a SUCCESSFUL listing means not waiting, which is a fact.
    const waiting = !!a && a.status === 'waiting'
    const waitingFor = waiting && typeof a.waitingFor === 'string' ? a.waitingFor : ''
    // Assigned every pass, broadcast only on a change. Assigning only on a
    // change left the field ABSENT on every session that had never waited,
    // which is most of them -- and an absent field is indistinguishable from a
    // relay that predates this code, which is exactly the confusion a missing
    // payload field causes. Present-and-false is a readable state;
    // missing is not.
    if (waiting !== !!s.waiting || waitingFor !== (s.waitingFor ?? '')) changed = true
    s.waiting = waiting
    s.waitingFor = waitingFor
    // The same listing already says WHAT this session is. Recorded here rather
    // than asked for again at close time: `claude agents` takes about a quarter
    // of a second, and a button that has to shell out before it can decide what
    // it does would have to be disabled until it had.
    const kind = a && typeof a.kind === 'string' ? a.kind : ''
    const shortId = a && typeof a.id === 'string' ? a.id : ''
    if (kind !== (s.kind ?? '') || shortId !== (s.shortId ?? '')) changed = true
    s.kind = kind
    s.shortId = shortId
    // Which of jump.mjs's four cases this session is, computed HERE so the
    // drawer can label its button without the pane guessing and without a
    // round trip before the first click. A payload FIELD, so on a relay that
    // predates this the button simply renders its neutral label rather than
    // the wrong one.
    let alive = false
    try { process.kill(Number(s.pid), 0); alive = true } catch (e) { alive = e.code === 'EPERM' }
    const jc = jumpCase({
      tmux: tmuxOfPid({ pid: s.pid, dir: SESSIONS_DIR, readFile: (f) => readFileSync(f, 'utf8') }),
      kind, pidAlive: alive,
    }).case
    if (jc !== (s.jump ?? '')) changed = true
    s.jump = jc
  }
  if (changed) broadcast('sessions', live())
}
setInterval(() => {
  needsTick().catch((e) => process.stderr.write(`needs poll failed: ${e?.stack || e}\n`))
}, NEEDS_POLL_MS).unref?.()

const pushEvents = (incoming, sessionId) => {
  if (!Array.isArray(incoming) || incoming.length === 0) return
  const stamped = incoming.map((e) => ({ ...e, sessionId, id: e.id ?? uid(), t: e.t ?? now() }))
  events = [...events, ...stamped].slice(-EVENT_CAP)
  replay = [...replay, ...stamped].slice(-REPLAY_CAP)
  broadcast('events', stamped)
}

const enqueue = (sessionId, command) => {
  const q = commands.get(sessionId) ?? []
  q.push({ id: uid(), t: now(), ...command })
  commands.set(sessionId, q)
}

/** The body of /api/implement, factored out so the after-reset scheduler
 *  below can fire the same green
 *  light without going through HTTP. Behaviour is unchanged from when this
 *  lived inline in the route: mutates `requests`, broadcasts `dispatch`, and
 *  returns exactly the `{queued, skipped}` the route always answered with. */
const implementIds = (ids) => {
  const queued = [], skipped = []
  for (const id of ids.map(String)) {
    const r = requests.get(id)
    // only a session we can actually address -- one currently registered
    // with THIS relay, on a request that has a plan. Under the known port
    // limitation a stale or cross-relay sessionId is still truthy
    // here; without the sessions.has() check enqueue() would silently queue
    // the prompt on a session nobody polls, and the request would still move
    // to 'implementing', reporting a go-ahead it never verified reached
    // anyone (never report an outcome we did not verify).
    if (!r || r.state !== 'planned' || !r.session?.sessionId || !sessions.has(r.session.sessionId)) {
      skipped.push(id); continue
    }
    enqueue(r.session.sessionId, { verb: 'prompt', payload: { text: IMPLEMENT_PROMPT } })
    try { requests.transition(id, 'implementing') } catch {}
    queued.push(id)
  }
  broadcast('dispatch', { requests: requests.all() })
  return { queued, skipped }
}

// ---- usage window: poll, publish, broadcast, schedule ----------------------
// poll every USAGE_POLL_MS, broadcast only on an actual change.
// `parseUsage`'s `resetsInMs` ticks down on every single call even when
// nothing real happened, so the comparison below is on the OBSERVED fields
// (pct, resetsAt, stale) rather than the full parsed object -- comparing the
// whole thing would make every tick look "changed" and defeat the point of
// entirely.
let currentUsage = { fiveHour: null, sevenDay: null, observedAt: null, stale: true }
let usageHistory = []      // ring of { t, usage }: changed readings only, for the sparkline
let usageSignature = null  // the last BROADCAST reading's comparable key, not the last computed one

const usageKey = (u) => JSON.stringify({
  stale: u.stale,
  fiveHour: u.fiveHour ? { pct: u.fiveHour.pct, resetsAt: u.fiveHour.resetsAt } : null,
  sevenDay: u.sevenDay ? { pct: u.sevenDay.pct, resetsAt: u.sevenDay.resetsAt } : null,
})

/** GET /api/usage and the `usage` SSE event both carry this bundle,
 *  so the two can never drift into different shapes. The SSE event alone adds
 *  a `crossed` array on top (see usageTick) -- a GET has no "since when" to
 *  compare against, so a crossing is only ever something that just happened
 *  on a broadcast, never a fact a poll can ask for at rest. */
const usagePayload = () => ({ usage: currentUsage, history: usageHistory, queue: afterReset.all() })

// Re-entrancy guard, same reason canvasTick/needsTick carry one: a slow read
// of STATUSLINE_DIR must not stack a second tick on top of a still-running
// one every USAGE_POLL_MS.
let usagePolling = false
const usageTick = () => {
  if (usagePolling) return
  usagePolling = true
  try {
    const t = now()
    const raw = readNewestStatusline(STATUSLINE_DIR, { fs: { readdirSync, statSync, readFileSync } })
    const next = parseUsage(raw, t, USAGE_STALE_MS)
    const key = usageKey(next)
    const changed = key !== usageSignature
    // crossings() does the deciding and app.js only fires: it is computed
    // HERE, against the reading this tick is replacing, and shipped
    // to the browser on the `usage` event -- app.js never reimplements this
    // logic itself. It cannot import usage.mjs to call it directly (app.js is
    // a classic script with no bundler, and usage.mjs's readNewestStatusline
    // half imports node:path, which does not exist in a browser), so the
    // computed RESULT crosses the wire instead of the algorithm.
    const crossed = crossings(currentUsage, next, NOTIFY_THRESHOLDS)
    // Always kept fresh for GET /api/usage and the next snapshot(), whether
    // or not this tick is broadcast-worthy -- a poller that only updated
    // `currentUsage` on a "change" would serve a stale `resetsInMs` between
    // broadcasts even though nothing here is actually cached across calls.
    currentUsage = next
    if (changed) {
      usageSignature = key
      usageHistory = [...usageHistory, { t, usage: next }].slice(-USAGE_RING_CAP)
    }

    // The scheduler: same 15s poll as the reading itself, so a reset is
    // noticed no later than the reading that proves it. usage.mjs's
    // dueEntries does the deciding; this only acts on what it returns.
    const due = dueEntries(afterReset.all(), currentUsage, t)
    let fired = false
    for (const entry of due) {
      fired = true
      try {
        if (entry.kind === 'prompt') {
          if (!entry.target || !sessions.has(entry.target)) {
            throw new Error('target session is not registered with this relay')
          }
          enqueue(entry.target, { verb: 'prompt', payload: { text: String(entry.payload?.text ?? '') } })
        } else if (entry.kind === 'implement') {
          const ids = Array.isArray(entry.payload?.ids) ? entry.payload.ids : []
          if (!ids.length) throw new Error('no ids to implement')
          implementIds(ids)
        } else {
          // refuses 'resume' and every other kind at creation, in both the
          // route and the store -- this branch is unreachable except via a
          // hand-edited after-reset.json, and even then it fails loudly
          // rather than silently doing nothing.
          throw new Error(`unrecognised kind: ${entry.kind}`)
        }
        afterReset.markFired(entry.id, { ok: true })
      } catch (e) {
        afterReset.markFired(entry.id, { ok: false, error: e?.message || String(e) })
      }
    }

    if (changed || fired || crossed.length) broadcast('usage', { ...usagePayload(), crossed })
  } catch (e) {
    process.stderr.write(`usage poll failed: ${e?.stack || e}\n`)
  } finally {
    usagePolling = false
  }
}
setInterval(usageTick, USAGE_POLL_MS).unref?.()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

const readBody = (req) =>
  new Promise((res, rej) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 4_000_000) { rej(new Error('body too large')); req.destroy() }
    })
    req.on('end', () => {
      try { res(raw ? JSON.parse(raw) : {}) } catch (e) { rej(e) }
    })
    req.on('error', rej)
  })

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const redirect = (res, location) => { res.writeHead(302, { location }); res.end() }

// Reads login.html fresh each call rather than caching it -- this route is
// nowhere near the hot path, and it keeps the file editable without a relay
// restart the way every other static asset already is.
const renderAuthPage = (res, mode) => {
  const tpl = String(readFileSync(LOGIN_HTML))
  const html = tpl.replace('__SZG_AUTH_MODE__', () => mode) // replacer FUNCTION -- see the comment beside the token substitution below
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

// Valid cookie OR the existing token check -- so the pane's own POSTs,
// which carry only the cookie once a password is set, keep working through
// exactly the same gate the plugin's token-bearing POSTs always used.
// Nothing else about this changes: same signature, same three token sources.
const authed = (req, url, body) =>
  (body?.token ?? url.searchParams.get('token') ?? req.headers['x-mch-token']) === TOKEN ||
  cookieValid(req)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  // ---- auth gate -------------------------------------------------------
  // Deliberately method-agnostic for every verb except POST: a GET, HEAD,
  // PUT, DELETE or PATCH with no valid cookie or token is refused the same
  // way, closing the gap where only `POST && path.startsWith('/api/')` was
  // ever checked below and a PUT/DELETE/PATCH to /api/* fell straight through
  // to the static handler with no check at all. POST is exempted HERE (not
  // inside gate() itself, which is pure and knows nothing about this) because
  // the plugin's shared token travels only in the POST body (never a header
  // or query param), which is not yet read at this point in the handler;
  // POST keeps its existing protection below, `authed()`, now cookie-aware.
  //
  // That exemption is narrow ON PURPOSE, and the narrowness is the whole
  // point: it covers ONLY a POST to /api/, which is the one path `authed()`
  // actually guards. Exempting every POST instead left two holes wide open,
  // both measured against a real relay before this line was written:
  // `POST /app.js` and `POST /` served the pane's source to an
  // unauthenticated caller, and -- far worse -- `POST /api/state`,
  // `/api/replay` and `/api/stream` answered 200 with the full
  // snapshot, because those branches sit ABOVE the `authed()` branch and
  // never looked at the method. Reading the board was a one-word change from
  // GET to POST. The read-only branches below are GET/HEAD-only for the same
  // reason; a POST to one now falls through to `authed()`.
  if (!(req.method === 'POST' && path.startsWith('/api/'))) {
    const tokenOk = (url.searchParams.get('token') ?? req.headers['x-mch-token']) === TOKEN
    const decision = gate({
      method: req.method,
      path,
      accept: req.headers.accept,
      cookieOk: cookieValid(req),
      tokenOk,
      configured: Boolean(auth),
      disabled: AUTH_OFF,
    })
    if (decision.mode === 'setup') { res.writeHead(302, { location: '/setup' }); return res.end() }
    if (decision.mode === 'login') { res.writeHead(302, { location: '/login' }); return res.end() }
    if (decision.mode === '401') return json(res, 401, { error: 'auth required' })
  }

  // GET/HEAD only, every read-only branch below. A POST to any of them used to
  // answer 200 before ever reaching `authed()` -- see the gate's comment above.
  const reading = req.method === 'GET' || req.method === 'HEAD'

  // ---- live stream to the panes -------------------------------------------
  if (reading && path === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write(`retry: 1000\n\n`)
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`)
    panes.add(res)
    broadcast('viewers', { viewers: panes.size })
    const beat = setInterval(() => { try { res.write(': beat\n\n') } catch {} }, 15_000)
    // Both ends: `close` is the normal case (pane navigated away, tab closed),
    // `error` is what an async write failure -- as opposed to one `res.write`
    // throws synchronously -- surfaces as, and an unhandled 'error' on a
    // stream is an uncaught exception that would take the whole relay down.
    // `dropPane` is idempotent, so whichever fires first (including a
    // buffered-bytes drop from `broadcast` itself) does the work once.
    const onGone = () => { clearInterval(beat); dropPane(res, 'connection closed') }
    req.on('close', onGone)
    res.on('error', onGone)
    return
  }

  // `boundPort`, not PORT: with SZG_PORT=0 they differ, and a health check that
  // reports the port it was ASKED for rather than the one it is answering on is
  // worse than no port at all.
  if (reading && path === '/api/health') return json(res, 200, { ok: true, port: boundPort, sessions: sessions.size })
  if (reading && path === '/api/state') return json(res, 200, snapshot())
  if (reading && path === '/api/replay') return json(res, 200, { events: replay })
  // The orchestrator agent's memory (capture.mjs). GET/HEAD-only, below the
  // auth gate, beside the other read-only branches -- a method-agnostic
  // `path ===` check above the gate would re-open the hole pane-auth closed
  // since/limit are validated by
  // capture.read() itself; anything malformed just falls back to its defaults.
  if (reading && path === '/api/capture') {
    return json(res, 200, {
      entries: capture.read({ since: Number(url.searchParams.get('since')), limit: Number(url.searchParams.get('limit')) }),
    })
  }
  // The findings store. Same read-only, below-the-gate placement and
  // the same reasoning as /api/capture just above -- a method-agnostic
  // `path ===` check here would intercept the POST further down that WRITES
  // a finding, and answer it 200 without ever reaching authed().
  if (reading && path === '/api/findings') {
    return json(res, 200, { findings: findings.read({ limit: Number(url.searchParams.get('limit')) }) })
  }
  // The orchestrator's blurb. Same read-only, below-the-gate placement as
  // /api/capture just above. "With no CLAUDE_BIN, every route here answers
  // 503" applies even to this GET: there is no binary to ever
  // produce a blurb, so a cached empty one would be a confident wrong answer
  // rather than an honest "this cannot work here".
  if (reading && path === '/api/orchestrator/blurb') {
    if (!CLAUDE_BIN) return json(res, 503, NO_CLAUDE)
    return json(res, 200, orchestrator.state())
  }
  // Reads, unauthenticated -- consistent with the four just above on a relay
  // bound to 127.0.0.1 only. Guarded by method, not just path: a bare
  // `path === '/api/after-reset'` check here would also intercept the POST
  // below that creates an entry, since this runs before the POST block.
  if (reading && path === '/api/usage') return json(res, 200, usagePayload())
  if (req.method === 'GET' && path === '/api/after-reset') return json(res, 200, { queue: afterReset.all() })

  // ---- voice transcription --------------------------------------------------
  // Its OWN raw-body reader, ahead of the generic POST block below: readBody
  // parses JSON and caps at 4 MB, and this body is raw `audio/wav`, capped at
  // MAX_AUDIO_BYTES instead. Its own authed call too, for the
  // same reason -- this path never reaches the block that gates every other
  // POST endpoint.
  if (req.method === 'POST' && path === '/api/voice/transcribe') {
    if (!authed(req, url, null)) return json(res, 401, { error: 'bad token' })
    // Drains fully rather than destroying the socket once over cap: a client
    // whose upload is cut off mid-stream sees a reset connection instead of
    // the 413 this is trying to tell it, which is worse than the cost of
    // reading (and dropping) the rest of an oversized body.
    const chunks = []
    let total = 0, tooBig = false
    await new Promise((resolveBody) => {
      req.on('data', (c) => {
        total += c.length
        if (total > MAX_AUDIO_BYTES) { tooBig = true; return }
        chunks.push(c)
      })
      req.on('end', resolveBody)
      req.on('error', resolveBody)
    })
    if (tooBig) return json(res, 413, { error: `audio body exceeds ${MAX_AUDIO_BYTES} bytes` })
    const buf = Buffer.concat(chunks)
    if (!buf.length) return json(res, 400, { error: 'empty audio body' })
    // the browser posts the whole accumulated utterance while
    // listening, with `?partial=1` -- a partial answers 409 rather than
    // queueing behind whatever is already in flight (voice.mjs's `transcribe`
    // is where that rule actually lives; this just reads the query flag).
    const partial = url.searchParams.get('partial') === '1'
    const out = await voice.transcribe({ buf, partial })
    if (!out.ok) return json(res, out.status ?? 500, { error: out.error })
    return json(res, 200, { ok: true, text: out.text })
  }

  // ---- pane auth: pages -----------------------------------------------------
  // AUTH_OFF: both bounce to '/' -- there is nothing to set up or log into.
  // Otherwise each sends you to whichever of the two actually applies, so a
  // bookmark or a stale link still lands somewhere useful.
  if (req.method === 'GET' && path === '/setup') {
    if (AUTH_OFF) return redirect(res, '/')
    if (auth) return redirect(res, '/login')
    return renderAuthPage(res, 'setup')
  }
  if (req.method === 'GET' && path === '/login') {
    if (AUTH_OFF) return redirect(res, '/')
    if (!auth) return redirect(res, '/setup')
    return renderAuthPage(res, 'login')
  }

  // ---- pane auth: setup / login / logout / reset ---------------------------
  // Its OWN block, before the generic authed()-gated POST branch just below,
  // which would otherwise 401 every one of these: a fresh install has
  // no shared-token holder yet, and reset is authorized by the CALLER'S
  // password plus their cookie, not the plugin's token.
  if (req.method === 'POST' && path.startsWith('/api/auth/')) {
    let body
    try { body = await readBody(req) } catch { return json(res, 400, { error: 'bad json' }) }

    if (path === '/api/auth/setup') {
      if (AUTH_OFF) return json(res, 409, { error: 'password disabled' })
      if (auth) return json(res, 409, { error: 'already configured' })
      const { password, confirm } = body ?? {}
      if (typeof password !== 'string' || password.length < 8 || password !== confirm) {
        return json(res, 400, { error: 'invalid password' })
      }
      const { salt, hash } = hashPassword(password)
      const nowMs = Date.now()
      const rec = { version: 1, salt, hash, secret: mintSecret(), createdAt: nowMs, updatedAt: nowMs }
      writeAuth(WORLD_DIR, rec)
      auth = rec
      setAuthCookie(res, signCookie(auth.secret, nowMs))
      return json(res, 200, { ok: true })
    }

    if (path === '/api/auth/login') {
      if (AUTH_OFF) return json(res, 409, { error: 'password disabled' })
      if (!auth) return json(res, 400, { error: 'not configured' })
      // 10 failures per remote address per 60s. Checked, and counted,
      // before the (expensive, deliberately so) password compare -- once a
      // window is spent, a request does not get to buy another scrypt call.
      const key = req.socket.remoteAddress || 'unknown'
      const { ok, retryAfterSec } = loginLimiter.hit(key)
      if (!ok) {
        res.setHeader('retry-after', String(retryAfterSec))
        return json(res, 429, { error: 'too many attempts' })
      }
      const { password } = body ?? {}
      if (!verifyPassword(password, auth)) return json(res, 401, { error: 'invalid password' })
      loginLimiter.clear(key)
      setAuthCookie(res, signCookie(auth.secret, Date.now()))
      return json(res, 200, { ok: true })
    }

    if (path === '/api/auth/logout') {
      if (AUTH_OFF) return json(res, 409, { error: 'password disabled' })
      clearAuthCookie(res)
      return json(res, 200, { ok: true })
    }

    if (path === '/api/auth/reset') {
      if (AUTH_OFF) return json(res, 409, { error: 'password disabled' })
      if (!auth) return json(res, 400, { error: 'not configured' })
      if (!cookieValid(req)) return json(res, 401, { error: 'auth required' })
      const { current, password, confirm } = body ?? {}
      if (!verifyPassword(current, auth)) return json(res, 401, { error: 'invalid password' })
      if (typeof password !== 'string' || password.length < 8 || password !== confirm) {
        return json(res, 400, { error: 'invalid password' })
      }
      const { salt, hash } = hashPassword(password)
      const nowMs = Date.now()
      // rotating `secret` invalidates every cookie everywhere (a reset IS
      // "log every other browser out"), so the caller doing the reset is
      // reissued a fresh one in this same response rather than being logged
      // out by their own action.
      const rec = { version: 1, salt, hash, secret: mintSecret(), createdAt: auth.createdAt, updatedAt: nowMs }
      writeAuth(WORLD_DIR, rec)
      auth = rec
      setAuthCookie(res, signCookie(auth.secret, nowMs))
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { error: 'no such endpoint' })
  }

  // ---- from the plugin ----------------------------------------------------
  if (req.method === 'POST' && path.startsWith('/api/')) {
    let body
    try { body = await readBody(req) } catch { return json(res, 400, { error: 'bad json' }) }
    if (!authed(req, url, body)) return json(res, 401, { error: 'bad token' })

    // C2: guard everything below. A bug in any endpoint handler (a
    // `store.get(id).x` dereference on a request deleted mid-flight, for
    // instance) would otherwise become an unhandled rejection in this async
    // handler and take the whole relay process down -- every session's
    // dashboard with it. No future handler bug should be able to do that.
    try {
      if (path === '/api/register') {
        const s = body.session ?? {}
        if (!s.id) return json(res, 400, { error: 'session.id required' })
        const prior = sessions.get(s.id)
        sessions.set(s.id, {
          series: [], stats: {}, agents: [], files: {}, status: '', ...prior, ...s,
          seenAt: now(), startedAt: prior?.startedAt ?? s.startedAt ?? now(),
          // Idle from the moment we first hear from it, until it reports work.
          idleSince: prior?.idleSince ?? now(),
        })
        // A restarted terminal inherits its own previous claim. `root` is
        // optional: a session that reports no worktree simply does not
        // inherit. Same validation as /api/claim below: this endpoint
        // is reachable by anything holding the token, and an unvalidated
        // root could resolve against the RELAY's cwd or make writeClaim's
        // mkdirSync create a directory at an unintended location. An invalid
        // root behaves the same as an absent one -- short-circuit silently,
        // never error, since this block's whole contract is "no usable root,
        // no inheritance."
        // `typeof s.root === 'string'` first: isAbsolute(123) THROWS, and this
        // block runs AFTER sessions.set() above, so without it a non-string
        // root left the session registered in the map while the caller got a
        // 500 and never learned it had registered -- a partial write.
        const rootOk = typeof s.root === 'string' && !!s.root && isAbsolute(s.root)
          && existsSync(s.root) && statSync(s.root).isDirectory()
        if (rootOk && s.name) {
          // `s.root` is whatever cwd the plugin happened to report, which
          // may be a subdirectory of the actual worktree (the scanner always
          // reads claims from the git TOPLEVEL, via topologyOf -> probe). Not
          // resolving here means a stray <subdir>/.claude/claims.json that the
          // scanner never finds -- a session that looks unclaimed forever even
          // though the tool reported success. Resolve BEFORE the read, and
          // nothing else awaits between this and the transfer/flush below, so
          // the single-process read-modify-write guarantee is untouched.
          const resolvedRoot = (await probe(s.root))?.worktreeRoot ?? s.root
          const doc = readClaims(resolvedRoot)
          if (!doc.claims[s.id]) {
            const liveIds = new Set([...sessions.keys()].filter((id) => id !== s.id))
            const hit = inheritableClaim(doc.claims, s.name, liveIds)
            if (hit) {
              // ONE atomic transfer, not a writeClaim+removeClaim pair:
              // two independent read-modify-flush cycles could leave a
              // duplicate if the second throws after the first succeeds.
              // updatedAt is refreshed, claimedAt deliberately is not: claimedAt
              // records when the work was FIRST claimed and must survive the
              // transfer, while updatedAt feeds inheritableClaim's tie-break --
              // an inherited claim carrying its predecessor's stamp competes
              // there with an artificially old value.
              transferClaim(resolvedRoot, hit.sessionId, s.id, { inheritedFrom: hit.sessionId, updatedAt: now() })
            }
          }
        }
        // a restarted terminal gets a fresh id, so its canvas
        // position would be orphaned. A stored node whose id is gone and
        // whose name matches THIS session, uniquely, hands its position over.
        // The refusal rules are claims-inherit.mjs's; see canvas.mjs.
        {
          const inh = inheritPosition(world.canvas.nodes, { id: s.id, name: s.name }, live())
          if (inh.from) { world.canvas.nodes = inh.nodes; canvasChanged() }
        }
        // A restarted terminal keeps its own card colour by NAME too
        // (cards.mjs), same refusal rule as the position inheritance just
        // above: never when this name is currently worn by more than one
        // live session. `rec` is the object just stored by sessions.set --
        // mutated in place, not re-set, since it is already the Map's value.
        // Only when this id has no colour of its own: a reconnect of the
        // SAME id already carries its prior colour through the `...prior`
        // spread above, and re-inheriting over it would ignore a colour the
        // human picked for exactly this run.
        {
          const rec = sessions.get(s.id)
          if (rec && !rec.color) {
            const hit = cards.colorFor(s.name, live())
            if (hit) rec.color = hit
          }
        }
        // Recents: every root the relay has seen a session in, newest first.
        if (rootOk) {
          // The REALPATH, as spawnSession records: recents holds 12 entries,
          // and the same directory under two spellings evicts a genuine root.
          // rootOk already proved the directory exists, so this resolves.
          const rec = pushRecent(world.canvas.recents, validateCwd(s.root).cwd ?? s.root)
          if (rec.changed) { world.canvas.recents = rec.recents; canvasChanged() }
        }
        broadcast('sessions', live())
        return json(res, 200, { ok: true, token: undefined })
      }

      if (path === '/api/stats') {
        const s = sessions.get(body.id)
        if (!s) return json(res, 404, { error: 'unknown session' })
        const wasWorking = !!s.working
        const isWorking = body.working ?? false
        Object.assign(s, {
          seenAt: now(),
          stats: { ...s.stats, ...(body.stats ?? {}) },
          agents: body.agents ?? s.agents,
          files: body.files ?? s.files,
          status: body.status ?? s.status,
          // What this session's last finished turn asked the user for, or ''.
          // Classified in the plugin, where the answer text is; the relay only
          // carries it. The OTHER half of "needs me" -- parked at a prompt --
          // the relay learns for itself in needsTick below.
          needs: body.needs ?? s.needs ?? '',
          // The tail of what this session last said, and when. Sticky for the
          // same reason `needs` is: a session on an older plugin sends neither
          // field, and `?? s.lastAnswer` keeps whatever it last reported rather
          // than blanking the drawer on every heartbeat. The plugin never sends
          // an empty string here -- it leaves the previous answer standing --
          // so `??` and not `||` is right: '' would be a deliberate value.
          lastAnswer: body.lastAnswer ?? s.lastAnswer ?? '',
          lastAnswerAt: body.lastAnswerAt ?? s.lastAnswerAt ?? 0,
          // The tmux session the plugin found itself in, if any. Carried
          // through rather than defaulted: a session that is not in tmux
          // sends an empty string and the board groups it under 'no tmux
          // session', which is a case, not a failure.
          tmux: body.tmux ?? s.tmux,
          spin: body.spin ?? s.spin,
          name: body.name ?? s.name,
          branch: body.branch ?? s.branch,
          model: body.model ?? s.model,
          working: body.working ?? false,
        })
        // How long this session has ACTUALLY been idle, which is not what
        // `seenAt` measures. seenAt moves on every push and the plugin
        // heartbeats about once a second, so `ago(seenAt)` was permanently "0s"
        // or "1s" and flickered between the two for a session nobody was
        // touching -- it reported that the relay was alive, not that the session
        // was. This records the moment work STOPPED and then leaves it alone, so
        // the board has a fixed point to count from. seenAt is untouched: the
        // 90-second TTL sweep in live() depends on it.
        if (isWorking) s.idleSince = null
        else if (wasWorking || s.idleSince == null) s.idleSince = now()

        // `working` only means a turn is OPEN, not that it is moving: it is
        // `M.turnStartedAt !== null` in the plugin, and a session parked at a
        // permission prompt never fires turn.complete. So it heartbeats
        // working:true forever and the rule above can never let it accrue idle
        // time -- a session waiting on a human is exactly what the board should
        // surface, and it was the one case it structurally could not.
        //
        // This records when the session's numbers last MOVED. Note what it does
        // not do: it does not claim to know the session is blocked. ctx and
        // outTok come from the transcript, which is written per content block,
        // so a long single-block generation looks just as frozen as a permission
        // prompt. The board reports "no progress for N" -- true either way, and
        // the thing worth knowing -- rather than guessing at a cause.
        const st = s.stats ?? {}
        const fp = `${st.ctx ?? 0}:${st.tools ?? 0}:${Math.round((st.spend ?? 0) * 1000)}`
        if (fp !== s.progressFp) { s.progressFp = fp; s.progressAt = now() }
        else if (s.progressAt == null) s.progressAt = now()

        if (body.point) {
          s.series = [...(s.series ?? []), body.point].slice(-SERIES_CAP)
        }
        pushEvents(body.events, body.id)
        broadcast('sessions', live())
        return json(res, 200, { ok: true })
      }

      if (path === '/api/ask') {           // a session's ask_human tool
        const q = { id: uid(), t: now(), sessionId: body.id, question: body.question, options: body.options ?? [], context: body.context ?? '' }
        questions = [...questions, q]
        broadcast('questions', questions)
        return json(res, 200, { ok: true, questionId: q.id })
      }

      if (path === '/api/ask/poll') {      // the session collects its answer
        const q = questions.find((x) => x.id === body.questionId)
        return json(res, 200, { answered: q?.answer !== undefined, answer: q?.answer })
      }

      if (path === '/api/ask/close') {
        questions = questions.filter((x) => x.id !== body.questionId)
        broadcast('questions', questions)
        return json(res, 200, { ok: true })
      }

      if (path === '/api/approval') {      // a session asks for a verdict
        const a = { id: uid(), t: now(), sessionId: body.id, tool: body.tool, detail: body.detail, risk: body.risk ?? 'medium' }
        approvals = [...approvals, a]
        broadcast('approvals', approvals)
        return json(res, 200, { ok: true, approvalId: a.id })
      }

      if (path === '/api/approval/poll') {
        const a = approvals.find((x) => x.id === body.approvalId)
        return json(res, 200, { decided: a?.verdict !== undefined, verdict: a?.verdict })
      }

      // ---- from the pane ----------------------------------------------------
      if (path === '/api/command') {       // steering: pane → a session
        if (!sessions.has(body.targetId)) return json(res, 404, { error: 'unknown session' })
        enqueue(body.targetId, { verb: body.verb, payload: body.payload ?? {} })
        return json(res, 200, { ok: true })
      }

      // Rename a session for real -- the plugin runs Claude Code's own
      // /rename, so the name this sets is the one the TUI shows and the one
      // `~/.claude/sessions/<pid>.json` records with nameSource 'user'.
      //
      // Its own endpoint rather than a bare /api/command with verb 'rename',
      // because this is the only steering verb that carries a value the relay
      // can meaningfully refuse, and a name refused HERE is refused before it
      // reaches a session at all. What it checks is deliberately thin: empty,
      // over-long (60 is the cap readSessionName already applies when reading
      // the name back, so a longer one could never round-trip), control
      // characters, and a leading slash -- which would otherwise be handed to
      // $.command.run as an argument beginning with the delimiter it strips.
      // Everything else is Claude Code's call, not ours: /rename's own rules
      // were not reverse-engineered, and whatever it refuses comes back to the
      // pane through the session's event feed.
      // Close a session from its drawer. Two mechanisms, chosen by what the
      // session IS (canvas.mjs's killPlan): `claude stop <id>` for a
      // background/dispatched one, a SIGTERM to the registered pid for an
      // interactive one. Never a pattern kill -- see killPlan's header.
      //
      // The body carries an id and nothing else. The pid and the short id are
      // read server-side from the registry and from the agents listing, so
      // there is no path by which a caller names a process to signal.
      // Put the user in front of a session's real terminal (jump.mjs). The
      // body carries an id and nothing else: the pid comes from the session's
      // own registration, the tmux pane from Claude Code's per-pid registry,
      // and the short id from the agents listing the relay already polls. No
      // value a caller supplies reaches an argv.
      if (path === '/api/jump') {
        const s = sessions.get(body.id)
        if (!s) return json(res, 404, { error: 'unknown session' })
        const out = await jumpToSession({
          sess: { ...s, tmux: tmuxOfPid({ pid: s.pid, dir: SESSIONS_DIR, readFile: (f) => readFileSync(f, 'utf8') }) },
          run: realRun, tmuxBin: TMUX_BIN, claudeBin: CLAUDE_BIN,
          pidAlive: (pid) => { try { process.kill(Number(pid), 0); return true } catch (e) { return e.code === 'EPERM' } },
        })
        if (out.status === 200 && out.body.ok) {
          try { capture.append('jump', body.id, { case: out.body.case, target: out.body.target ?? '' }) } catch {}
        }
        return json(res, out.status, out.body)
      }

      if (path === '/api/session/kill') {
        const s = sessions.get(body.id)
        if (!s) return json(res, 404, { error: 'unknown session' })
        const plan = killPlan({ kind: s.kind, shortId: s.shortId, pid: s.pid })
        const out = await killSession({
          plan, claudeBin: CLAUDE_BIN,
          run: realRun,
          signal: (pid, sig) => process.kill(pid, sig),
        })
        if (out.status === 200) {
          try { capture.append('kill', body.id, { mode: out.body.mode, name: s.name ?? '' }) } catch {}
          // Drop it from the board now rather than waiting out the TTL. A card
          // that lingers after a successful close reads as the close not having
          // worked; if the process survives, its next heartbeat re-registers
          // it, which is the honest correction rather than a lie either way.
          sessions.delete(body.id)
          broadcast('sessions', live())
        }
        return json(res, out.status, out.body)
      }

      // A session card's own outline colour, from the drawer's picker.
      // Validated #rrggbb-or-empty (cards.mjs), stored by NAME so a restart
      // keeps it (see the /api/register inheritance above), and mirrored onto
      // the in-memory session record itself so it rides `sessions[].color` on
      // this same broadcast rather than waiting for a second one.
      if (path === '/api/session/color') {
        const s = sessions.get(body.id)
        if (!s) return json(res, 404, { error: 'unknown session' })
        const r = validateColor(body.color)
        if (!r.ok) return json(res, 400, { error: r.error })
        s.color = r.color
        cards.set(s.name, s.id, r.color)
        try { capture.append('color', body.id, { name: s.name ?? '', color: r.color }) } catch {}
        broadcast('sessions', live())
        return json(res, 200, { ok: true, color: r.color })
      }

      if (path === '/api/rename') {
        if (!sessions.has(body.id)) return json(res, 404, { error: 'unknown session' })
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!name) return json(res, 400, { error: 'a name is required' })
        if (name.length > 60) return json(res, 400, { error: 'name is longer than 60 characters' })
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f\x7f]/.test(name)) return json(res, 400, { error: 'name carries control characters' })
        if (name.startsWith('/')) return json(res, 400, { error: 'a name may not begin with /' })
        enqueue(body.id, { verb: 'rename', payload: { name } })
        return json(res, 200, { ok: true, name })
      }

      if (path === '/api/link') {          // drag A → B: A SendMessages B
        const from = sessions.get(body.from)
        const to = sessions.get(body.to)
        if (!from || !to) return json(res, 404, { error: 'unknown session' })
        const link = { id: uid(), t: now(), from: body.from, to: body.to, kind: body.kind ?? 'brief' }
        links = [...links.filter((l) => !(l.from === link.from && l.to === link.to)), link]
        enqueue(body.from, {
          verb: 'send-message',
          payload: { toName: to.agentName || to.name || to.id, toId: to.id, kind: link.kind, note: body.note ?? '' },
        })
        try { capture.append('link', body.from, { to: body.to, linkKind: link.kind }) } catch {}
        broadcast('links', links)
        return json(res, 200, { ok: true, link })
      }

      if (path === '/api/unlink') {
        links = links.filter((l) => l.id !== body.id)
        try { capture.append('unlink', '', { id: body.id }) } catch {}
        broadcast('links', links)
        return json(res, 200, { ok: true })
      }

      if (path === '/api/answer') {        // pane answers an ask_human
        const q = questions.find((x) => x.id === body.questionId)
        if (!q) return json(res, 404, { error: 'unknown question' })
        q.answer = String(body.answer ?? '')
        broadcast('questions', questions)
        return json(res, 200, { ok: true })
      }

      if (path === '/api/verdict') {       // pane approves/denies
        const a = approvals.find((x) => x.id === body.approvalId)
        if (!a) return json(res, 404, { error: 'unknown approval' })
        a.verdict = body.verdict === 'approve' ? 'approve' : 'deny'
        broadcast('approvals', approvals)
        return json(res, 200, { ok: true })
      }

      // ---- the session canvas ----------------------------------------------
      // Positions are persisted in world.json under `canvas` and inherit its
      // 4 s save and its shutdown flush. 4-.
      if (path === '/api/canvas/move') {
        const { id, x, y } = body
        if (typeof id !== 'string' || !id || !Number.isFinite(x) || !Number.isFinite(y)) {
          return json(res, 400, { error: 'id, x and y required' })
        }
        // `nodes` is a plain object literal, so `nodes['__proto__'] = {...}`
        // sets its prototype rather than adding a key: the write answers 200,
        // /api/state shows nothing, and every later node inherits x/y/name
        // from it. A session id is never one of these three; refuse them.
        // Its own message: 'id, x and y required' is a lie here -- all three
        // were supplied -- and it sends whoever reads it hunting the wrong bug.
        if (id === '__proto__' || id === 'constructor' || id === 'prototype') {
          return json(res, 400, { error: 'invalid id' })
        }
        const name = sessions.get(id)?.name ?? world.canvas.nodes[id]?.name ?? ''
        // Clamped at BOTH ends, not floored alone: the pane sends pointer
        // coordinates, and a stored 1e12 puts a card where no scroll can
        // reach it and persists that to world.json.
        world.canvas.nodes[id] = { x: clampPos(x), y: clampPos(y), name, t: now() }
        canvasChanged()
        return json(res, 200, { ok: true })
      }

      if (path === '/api/canvas/reset') {
        // 6 / C5: positions only. Nothing else in the canvas, and
        // nothing outside it, is touched. A node with no stored position is
        // laid out in its default slot by the pane.
        world.canvas.nodes = {}
        canvasChanged()
        return json(res, 200, { ok: true })
      }

      // The spawn form's directory typeahead. Read-only and token-gated like
      // every other write endpoint here -- it lists directory NAMES, which is
      // not nothing, and the token is the one gate this relay has.
      //
      // It never answers 500: completeDirs turns every failure into an empty
      // list, because a path halfway through being typed is a path that does
      // not exist yet, and that is the common case rather than the error case.
      if (path === '/api/canvas/complete') {
        // AWAITED, and completeDirs is async for this reason: the listing is a
        // real `readdir` on a directory the user is halfway through typing, so
        // it may be enormous or on a stalled network volume. Synchronously it
        // would stop this one event loop -- every pane's SSE stream and every
        // session's heartbeat -- until it returned.
        return json(res, 200, await completeDirs(body?.path))
      }

      // A real `claude --bg -n <name> --permission-mode auto`
      // session in a CHOSEN directory. Not dispatch: no worktree, no branch,
      // no git. Everything that decides is in canvas.mjs and tested there;
      // this is the only place a real `claude` is ever run for the canvas.
      if (path === '/api/spawn') {
        if (!CLAUDE_BIN) return json(res, 503, NO_CLAUDE)
        const out = await spawnSession({
          canvas: world.canvas, body, run: realRun, now, claudeBin: CLAUDE_BIN,
          // The port BOUND, never PORT: with SZG_PORT=0 they differ, and the
          // child would be told to register somewhere nothing is listening.
          relayPort: boundPort, relayToken: TOKEN, pluginDir: SPAWN_PLUGIN_DIR,
        })
        if (out.changed) canvasChanged()
        if (out.status === 200) { try { capture.append('spawn', '', { name: out.body.name, cwd: out.body.cwd }) } catch {} }
        return json(res, out.status, out.body)
      }

      // Its own endpoint, not /api/takeover, which looks its
      // subject up in the request store: a canvas node is not a request.
      if (path === '/api/attach') {
        if (!CLAUDE_BIN) return json(res, 503, NO_CLAUDE)
        const out = await attachSession({ canvas: world.canvas, body, run: realRun, tmuxBin: TMUX_BIN, claudeBin: CLAUDE_BIN })
        return json(res, out.status, out.body)
      }

      // ---- the dispatch queue ------------------------------------------------
      const pushDispatch = () => broadcast('dispatch', { requests: requests.all() })

      if (path === '/api/request/create') {
        if (!body.title) return json(res, 400, { error: 'title required' })
        // A project becomes a spawn's cwd and a `tmux new-window -c`. Refused
        // HERE, at creation, with the value named -- not left to fail later as
        // a `spawn ... ENOENT` that reads like a missing binary.
        const vp = validateProject(body.project)
        if (!vp.ok) return json(res, 400, { error: vp.error })
        const r = requests.create({
          title: String(body.title), project: vp.project,
          ask: String(body.ask ?? ''), brief: body.brief ?? null,
          model: body.model, effort: body.effort,
        })
        // Captured because this is now an ACTION apply path (`dispatch`
        // kind), and the invariant is that every applied action is captured.
        // A hand-created request goes through the same route and is captured
        // identically -- the log records what happened, not who asked.
        try { capture.append('request', '', { title: r.title, project: r.project }) } catch {}
        pushDispatch()
        return json(res, 200, { ok: true, request: r })
      }

      if (path === '/api/request/update') {
        // `session`, `artifacts`, `scoping` and `error` are dispatcher-owned:
        // the dispatcher's poll() writes them server-side, and `session.shortId`
        // in particular reaches a `tmux` argv in /api/takeover. A browser has no
        // business setting any of them, so build the patch from an explicit
        // allowlist instead of forwarding body.patch wholesale.
        // `dispatch` is excluded too: dispatch.model reaches the spawn argv in
        // dispatch.mjs, and nothing in the UI edits model or effort today. If it
        // is ever re-admitted it must validate against a fixed set of known
        // model aliases rather than accept free text, and requests.mjs#update()
        // must deep-merge `dispatch` the way it merges `brief` or `branch`/
        // `sessionName` get silently dropped from an already-dispatched request.
        const p = (body.patch && typeof body.patch === 'object') ? body.patch : {}
        const patch = {}
        for (const k of ['title', 'ask', 'project', 'brief']) if (k in p) patch[k] = p[k]
        // Same gate as create's, and for the same reason: this is the route
        // that REPAIRS a bad project, so it must not be a way to write one.
        if ('project' in patch) {
          const vp = validateProject(patch.project)
          if (!vp.ok) return json(res, 400, { error: vp.error })
          patch.project = vp.project
        }
        const r = requests.update(body.id, patch)
        if (!r) return json(res, 404, { error: 'unknown request' })
        pushDispatch()
        return json(res, 200, { ok: true, request: r })
      }

      if (path === '/api/request/delete') {
        if (!requests.remove(body.id)) return json(res, 404, { error: 'unknown request' })
        pushDispatch()
        return json(res, 200, { ok: true })
      }

      if (path === '/api/request/reorder') {
        if (!Array.isArray(body.ids)) return json(res, 400, { error: 'ids required' })
        requests.reorder(body.ids.map(String))
        pushDispatch()
        return json(res, 200, { ok: true })
      }

      if (path === '/api/request/state') {
        // `session`, `artifacts`, `scoping`, `error` and `dispatch` are
        // dispatcher-owned -- set server-side only, same reasoning as
        // /api/request/update just above. A browser has no legitimate patch
        // field to send here at all: the only state moves it drives are
        // draft->queued (the brief editor's save) and queued->cancelled, and
        // neither needs one. Forwarding body.patch used to re-admit
        // everything the allowlist above removed one endpoint over -- worst of
        // all, `artifacts.planPath` reached the store's `planned` guard, which
        // checks that the FIELD is present, never that the file exists, so a
        // browser could assert "plan ready" for a plan that was never written.
        // Passing an empty patch closes that: `planned` now requires
        // artifacts.planPath to already be on the record, which only
        // dispatch.mjs's poll() (an in-process store.transition() call, not
        // this endpoint) ever sets.
        try {
          const r = requests.transition(body.id, String(body.to), {})
          pushDispatch()
          return json(res, 200, { ok: true, request: r })
        } catch (e) {
          return json(res, 409, { error: e.message })
        }
      }

      if (path === '/api/steering') {
        // The whole list, validated in the store. `custom` is the only field a
        // browser may send: ids are minted server-side, the same rule
        // /api/request/update's allowlist follows.
        const r = steering.replace(body.custom)
        if (!r.ok) return json(res, 400, { error: r.error })
        try { steering.flush() } catch (e) { return json(res, 500, { error: 'could not save: ' + e.message }) }
        const payload = { custom: r.custom }
        broadcast('steering', payload)
        return json(res, 200, { ok: true, steering: payload })
      }

      // ---- scoping -----------------------------------------------------------
      if (path === '/api/scope') {
        const r = requests.get(body.id)
        if (!r) return json(res, 404, { error: 'unknown request' })
        if (!body.text) return json(res, 400, { error: 'text required' })
        const out = await scoper.start(r.id, String(body.text), r.project || process.cwd())
        return json(res, out.ok ? 200 : (out.code ?? 400), out)
      }

      if (path === '/api/scope/bank') {
        const r = requests.get(body.id)
        if (!r) return json(res, 404, { error: 'unknown request' })
        const out = await scoper.bank(r.id, r.project || process.cwd())
        broadcast('dispatch', { requests: requests.all() })
        return json(res, out.ok ? 200 : (out.code ?? 400), out)
      }

      if (path === '/api/scope/kill') {
        return json(res, 200, { ok: scoper.kill(body.id) })
      }

      // ---- take-over ---------------------------------------------------------
      // Opens a real interactive session in a new tmux window. Reports success
      // only on a window tmux actually created; the pane always also shows the
      // command, so this failing costs nothing.
      if (path === '/api/takeover') {
        const r = requests.get(body.id)
        if (!r) return json(res, 404, { error: 'unknown request' })
        const sessionId = body.kind === 'session' ? r.session?.shortId : r.scoping?.sessionId
        if (!sessionId) return json(res, 409, { error: 'nothing to take over yet' })
        // CLAUDE_BIN, not a bare `claude`. An older build that wins PATH in
        // some shells has no `attach` subcommand at all, so a bare name here
        // opened a window that died instantly and reported success.
        if (!CLAUDE_BIN) return json(res, 503, NO_CLAUDE)
        // The project is the window's cwd. Validated, and the 409 NAMES the
        // value: `tmux new-window -c <a bare repo name>` fails with a message
        // nobody sees, and the pane showed nothing happening at all.
        const vp = validateProject(r.project)
        if (!vp.ok) return json(res, 409, { error: vp.error })
        const cwd = vp.project || process.cwd()
        const inner = body.kind === 'session'
          ? [CLAUDE_BIN, 'attach', sessionId]
          : [CLAUDE_BIN, '--resume', sessionId]
        const name = `szg-${r.slug}`.slice(0, 60)
        const out = await new Promise((resolve) => {
          execFile('tmux', ['new-window', '-d', '-n', name, '-c', cwd, ...inner],
            { timeout: 6000 }, (err, stdout, stderr) => resolve({ err, stderr: String(stderr || '') }))
        })
        if (out.err) {
          const why = out.stderr.trim().slice(0, 200) || 'tmux is not running'
          return json(res, 409, { error: `${why} — use the command shown instead`, command: inner.join(' ') })
        }
        // Taking over a SCOPING conversation forks it: scoping runs as one-shot
        // `claude -p` calls that exit after each turn, so this resumes the
        // saved transcript into a NEW process and from then on terminal turns
        // never reach the relay and pane turns never reach the terminal. That
        // was silent. Record it so the panel can say so and stop offering
        // turns that would go nowhere. The real fix -- scoping as a live `--bg`
        // session -- is deliberately not built here.
        if (body.kind !== 'session' && r.scoping) {
          requests.update(r.id, { scoping: { ...r.scoping, continuedInTerminal: { at: now(), window: name } } })
          pushDispatch()
        }
        return json(res, 200, { ok: true, window: name, cwd })
      }

      // ---- the green lights ---------------------------------------------------
      if (path === '/api/dispatch') {
        if (!Array.isArray(body.ids) || !body.ids.length) return json(res, 400, { error: 'ids required' })
        const out = await dispatcher.dispatch(body.ids.map(String))
        try { capture.append('dispatch', '', { ids: out.dispatched.map((d) => d.id) }) } catch {}
        return json(res, 200, { ok: true, ...out })
      }

      if (path === '/api/implement') {
        if (!Array.isArray(body.ids) || !body.ids.length) return json(res, 400, { error: 'ids required' })
        // "queued", never "sent": /api/command returns on enqueueing and the
        // session drains on its own poll. implementIds() is the factored
        // body -- the after-reset scheduler calls the same
        // function without going through HTTP.
        const out = implementIds(body.ids)
        try { capture.append('implement', '', { ids: out.queued }) } catch {}
        return json(res, 200, { ok: true, ...out })
      }

      // ---- the after-reset queue ------------------------------------------
      if (path === '/api/after-reset') {
        const { window: rawWindow, kind, target, payload } = body
        // the platform spells these `five_hour`/`seven_day` in
        // `rate_limits`, and the round's Interfaces block documents an entry's
        // `window` that way, so that is what the orchestrator-agent will send.
        // Internally they are `fiveHour`/`sevenDay` -- parseUsage's own keys,
        // kept identical so an entry and a reading compare with no translation
        // layer. Both spellings are accepted at this boundary and normalised
        // inward; neither caller has to know about the other's.
        const window = WINDOW_ALIASES[rawWindow] ?? rawWindow
        // refused HERE, at creation, with a 400 that names the kind and
        // the reason -- recognised, not unknown -- so nothing sits in the
        // queue that could never fire. `claude --bg --resume` cannot be
        // exercised without consuming a usage window -- the very thing this
        // feature exists to protect -- and a mocked subprocess cannot verify a
        // command line either way, so it is not supported in this release.
        if (kind === 'resume') {
          return json(res, 400, {
            error: "kind 'resume' is not supported in this release; use 'prompt' or 'implement'",
          })
        }
        // The store's create() also guards window/kind (defence in depth),
        // but validating here first means a bad request gets a 400 naming
        // the actual problem rather than a 500 from a thrown error.
        if (!['fiveHour', 'sevenDay'].includes(window)) {
          return json(res, 400, { error: 'window must be five_hour or seven_day (fiveHour/sevenDay also accepted)' })
        }
        if (!['prompt', 'implement'].includes(kind)) return json(res, 400, { error: 'kind must be prompt or implement' })
        // Armed against the CURRENT reading's boundary for this window. A
        // reading that is stale or missing that window gets no armed
        // boundary at all -- the same "hand-edited" fallback dueEntries
        // documents for, reached honestly here instead of guessed at.
        const armedResetsAt = !currentUsage.stale ? (currentUsage[window]?.resetsAt ?? null) : null
        const entry = afterReset.create({ window, kind, target, payload, armedResetsAt })
        broadcast('usage', usagePayload())
        return json(res, 200, { ok: true, entry })
      }

      // a POST, not a DELETE. In this file the authed check and the
      // try/catch that turns a throw into a 500 both live inside this single
      // POST block -- a route added outside it would be an unauthenticated
      // write whose throws escape as unhandled rejections. `/api/request/
      // delete` already sets the convention; this follows it.
      if (path === '/api/after-reset/delete') {
        const { id } = body
        if (!id) return json(res, 400, { error: 'id required' })
        // One button, two honest meanings, picked by what the entry still is.
        // A pending entry is CALLED OFF and stays on the list as a record that
        // you called it off; a settled one has nothing left to call off, so it
        // is CLEARED AWAY. cancel() is a deliberate no-op on a settled entry,
        // so without the remove() branch this answered 200 while the row
        // stayed on the list for good -- a button that reported success and
        // did nothing.
        const key = String(id)
        const found = afterReset.remove(key) || afterReset.cancel(key)
        if (!found) return json(res, 404, { error: 'no such entry' })
        broadcast('usage', usagePayload())
        return json(res, 200, { ok: true })
      }

      // ---- voice input ------------------------------------------------------
      // Model state, download and delete. Transcription itself is handled
      // ABOVE this block, in its own raw-body reader -- see /api/voice/
      // transcribe near the top of this handler.
      if (path === '/api/voice/toggle') {
        voice.setEnabled(!!body.on)
        voiceChanged()
        return json(res, 200, { ok: true, voice: voicePayload() })
      }

      if (path === '/api/voice/download') {
        const out = await voice.download()
        voiceChanged()
        return json(res, 200, { ok: true, ...out })
      }

      if (path === '/api/voice/install') {
        const out = await voice.install()
        voiceChanged()
        return json(res, 200, { ok: true, ...out })
      }

      if (path === '/api/voice/delete') {
        voice.remove(body.what)
        voiceChanged()
        return json(res, 200, { ok: true })
      }

      // ---- the gear's Spinner control ----------------------------------
      // Sits under the generic authed()-gated POST branch this whole block is
      // already inside (token OR cookie, same as every other write here) --
      // no new auth path, per the task's "keep the relay edit small and
      // local". `spinner` empty/absent clears the pin (the "leave it to the
      // picker" option); anything else must name a real id or this refuses
      // rather than writing a value the band would silently fall back from.
      if (path === '/api/hud/settings') {
        const { spinner } = body ?? {}
        if (spinner !== undefined && spinner !== '' && typeof spinner !== 'string') {
          return json(res, 400, { error: 'spinner must be a string id, or empty to clear' })
        }
        if (spinner && !SPINNERS.some((sp) => sp.id === spinner)) {
          return json(res, 400, { error: 'unknown spinner id' })
        }
        writeHudSpinner(spinner || '')
        hudChanged()
        return json(res, 200, { ok: true, hud: hudPayload() })
      }

      // ---- session claims -------------------------------------------------
      // The relay is the SOLE writer of claims.json. Two sessions in one
      // worktree post concurrently; because this process serializes them, a
      // read-modify-write cannot interleave and neither claim is lost.
      if (path === '/api/claim') {
        const { sessionId, root, name, items, note, inheritedFrom } = body
        if (!sessionId || !root) return json(res, 400, { error: 'sessionId and root required' })
        // Trust the caller for the root no further than a real, absolute
        // directory: the plugin knows its own worktree, but this endpoint is
        // reachable by anything holding the token. A relative root would
        // resolve against the RELAY's cwd, not the caller's, so two callers
        // sending e.g. "." would silently write to the same file.
        // typeof first: isAbsolute(123) throws, which would turn a caller's bad
        // input into a 500 out of the handler's catch instead of the 400 it is.
        if (typeof root !== 'string' || !isAbsolute(root) || !existsSync(root) || !statSync(root).isDirectory()) {
          return json(res, 400, { error: 'root is not a directory' })
        }
        // a caller may report a subdirectory of its worktree rather than
        // the worktree root itself; the scanner always reads claims from the
        // git toplevel (topologyOf -> probe), so resolve here or the write
        // lands somewhere nothing ever looks. probe() degrades to `root`
        // unchanged when it is not a git directory at all (e.g. these tests'
        // plain temp dirs), so this is a no-op for every caller already
        // passing a real worktree root. The await sits before writeClaim, and
        // nothing else awaits before it, so the single-process
        // read-modify-write stays atomic.
        const resolvedRoot = (await probe(root))?.worktreeRoot ?? root
        const entry = {
          name: typeof name === 'string' ? name.slice(0, 200) : '',
          items: Array.isArray(items) ? items.slice(0, 50) : [],
          note: typeof note === 'string' ? note.slice(0, 500) : '',
          // Clamped like its three siblings. Unclamped, one 4 MB readBody could
          // push claims.json past CAPS.fileBytes (256 KiB), at which point
          // discover()'s describe() reports 'too-large' and EVERY claim in
          // that worktree becomes invisible.
          inheritedFrom: typeof inheritedFrom === 'string' ? inheritedFrom.slice(0, 200) : null,
        }
        // No broadcast: nothing consumes a 'claims' SSE event -- not app.js's
        // switch, not pane-v2's (it hits client.go's default drop) -- and it
        // was the one claims path that bypassed the scanner's containment gate,
        // echoing a caller-supplied root and free-text note onto the ungated
        // stream for a directory containedIn() would never have exposed. The
        // scanner's own `projects` broadcast is what carries claims to a pane.
        const doc = writeClaim(resolvedRoot, sessionId, entry)
        try { capture.append('claim', sessionId, { root: resolvedRoot, name: entry.name }) } catch {}
        return json(res, 200, { ok: true, claims: doc.claims })
      }

      if (path === '/api/release') {
        const { sessionId, root } = body
        if (!sessionId || !root) return json(res, 400, { error: 'sessionId and root required' })
        // The same validation its sibling ten lines above has had since.
        // It was missing here, so a relative root resolved against the RELAY's
        // cwd and a non-string one threw out of probe()/join() as a 500.
        if (typeof root !== 'string' || !isAbsolute(root) || !existsSync(root) || !statSync(root).isDirectory()) {
          return json(res, 400, { error: 'root is not a directory' })
        }
        // same resolution as /api/claim, so a release targets the same
        // file the matching claim actually landed in.
        const resolvedRoot = (await probe(root))?.worktreeRoot ?? root
        removeClaim(resolvedRoot, sessionId)
        try { capture.append('release', sessionId, { root: resolvedRoot }) } catch {}
        return json(res, 200, { ok: true })
      }

      // ---- the orchestrator agent -------------------------------------------
      // A capture('ask', ...) line lives inside orchestrator.mjs's own ask(),
      // not here -- unlike the handlers above it, this route's ONLY
      // job is to call into the module that owns the whole feature.
      if (path === '/api/orchestrator/ask') {
        if (!CLAUDE_BIN) return json(res, 503, NO_CLAUDE)
        const text = typeof body.text === 'string' ? body.text.trim().slice(0, PROMPT_MAX) : ''
        if (!text) return json(res, 400, { error: 'text required' })
        const out = await orchestrator.ask(text)
        return json(res, out.ok ? 200 : (out.code ?? 400), out)
      }

      // ---- findings ---------------------------------------------------
      // `id` and `t` are the store's to assign, never the caller's, so the
      // body is passed through as-is and findings.mjs's add() overwrites
      // both. Everything else it sanitises; a body with no usable `surprise`
      // comes back null and is a 400, because silently storing nothing would
      // read to the caller as a successful write.
      if (path === '/api/findings') {
        const rec = findings.add(body)
        if (!rec) return json(res, 400, { error: 'a finding needs a non-empty `surprise`' })
        try { capture.append('finding', rec.session, { project: rec.project, surprise: rec.surprise.slice(0, 200) }) } catch {}
        broadcast('findings', { findings: findings.all() })
        return json(res, 200, { ok: true, finding: rec })
      }

      if (path === '/api/findings/delete') {
        if (!findings.remove(String(body.id ?? ''))) return json(res, 404, { error: 'unknown finding' })
        broadcast('findings', { findings: findings.all() })
        return json(res, 200, { ok: true })
      }

      if (path === '/api/orchestrator/clear') {
        return json(res, 200, orchestrator.clear())
      }

      if (path === '/api/orchestrator/blurb/refresh') {
        if (!CLAUDE_BIN) return json(res, 503, NO_CLAUDE)
        // force:true -- the ↻ button is one of three unconditional
        // triggers, never gated on a pane being connected, the board having
        // changed, or the 10-minute floor; those three are the PERIODIC
        // TIMER's own gates only (see the setInterval beside `orchestrator`'s
        // construction above).
        const out = await orchestrator.refreshBlurb({ force: true })
        return json(res, out.ok ? 200 : (out.code ?? 400), out)
      }

      return json(res, 404, { error: 'no such endpoint' })
    } catch (err) {
      process.stderr.write(`relay: POST ${path} threw: ${err?.stack || err}\n`)
      return json(res, 500, { error: 'internal error' })
    }
  }

  // ---- command drain (the plugin polls this) -------------------------------
  if (req.method === 'GET' && path.startsWith('/api/commands/')) {
    if (!authed(req, url, null)) return json(res, 401, { error: 'bad token' })
    const id = decodeURIComponent(path.slice('/api/commands/'.length))
    const q = commands.get(id) ?? []
    commands.set(id, [])
    const s = sessions.get(id)
    if (s) s.seenAt = now()
    return json(res, 200, { commands: q })
  }

  // ---- static ---------------------------------------------------------------
  const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
  const file = resolve(PUBLIC, rel)
  // `PUBLIC + sep`, not a bare `startsWith(PUBLIC)`. The bare form also admits
  // a SIBLING whose name merely begins with the same characters: with PUBLIC =
  // ".../bridge/public", the string test passes for ".../bridge/public-notes"
  // as readily as for a real child. There is no such sibling today, and that
  // is exactly the kind of fact that changes without anyone rechecking this
  // line.
  if ((file !== PUBLIC && !file.startsWith(PUBLIC + sep)) || !existsSync(file)) {
    res.writeHead(404); return res.end('not found')
  }
  let body = readFileSync(file)
  // THIS is the line the whole feature exists to close. Any unauthenticated
  // GET of an .html file used to hand back the shared token; now it does that
  // ONLY when the password is off (AUTH_OFF), which is the one mode where that
  // was already the entire security model. A replacer FUNCTION, never a
  // replacement string: String.replace() treats some characters in the
  // REPLACEMENT as special, so a token or empty string handed
  // to the string form would have `$`-sequences in it interpreted specially.
  if (extname(file) === '.html') {
    body = Buffer.from(String(body).replace('__SZG_TOKEN__', () => (AUTH_OFF ? TOKEN : '')))
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  res.end(body)
})

server.listen(PORT, '127.0.0.1', () => {
  // server.address().port equals PORT unless PORT is 0 (OS-assigned -- used
  // by tests to avoid colliding with a real relay), in which case this is
  // the only place the actual bound port is ever learned. /api/spawn hands it
  // to every child it starts, so it is kept, not only printed.
  boundPort = server.address().port
  process.stdout.write(`syzygy relay on http://127.0.0.1:${boundPort}\n`)
})
server.on('error', (e) => { process.stderr.write(`relay failed: ${e.message}\n`); process.exit(1) })

// Expire dead sessions so the board does not accumulate ghosts.
setInterval(() => {
  const before = sessions.size
  live()
  if (sessions.size !== before) broadcast('sessions', live())
}, 10_000).unref?.()


// Scan project task files on their own cadence and broadcast only on change.
// A pass that finds nothing new must cost the panes nothing.
// A scan can outlast its own interval -- every git call carries a 5s timeout,
// which is longer than the 4s cadence, so one hung subprocess is enough to
// overlap two passes. Without this guard their completions race to set
// `projects` and the later-resolving one wins regardless of which was issued
// later, so the payload can go backwards.
let scanning = false
const rescan = async () => {
  if (scanning) return
  scanning = true
  try {
    const next = await scanner.scan(live(), now())
    const json = JSON.stringify(next)
    if (json === projectsJson) return
    projects = next
    projectsJson = json
    broadcast('projects', next)
  } catch (e) {
    process.stderr.write('projects scan failed: ' + e.message + '\n')
  } finally {
    scanning = false
  }
}
setInterval(rescan, SCAN_INTERVAL_MS).unref?.()
rescan()