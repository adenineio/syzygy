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
import { jumpCase, jumpToSession, tmuxOfPid, parseTmuxTarget } from './jump.mjs'
import { createGroups, normalizePaths, GROUPS_FILE, MEMBERS_MAX } from './groups.mjs'
import { listArgv, listPanes, groupPlan, runGroup } from './tmux.mjs'
import { extname, join, dirname, resolve, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, hostname as osHostname, userInfo, networkInterfaces } from 'node:os'
import { execFile } from 'node:child_process'
import { createStore, validateProject, SLUG_RE } from './requests.mjs'
import { createTemplates, writePersonas, templateArgv, AGENT_PLUGIN_NAME } from './agent-templates.mjs'
import { createFanoutStore } from './fanout-store.mjs'
import { fanoutProjects, proposeTitle, FANOUT_ASK_MAX } from './fanout.mjs'
import { createSteeringStore } from './steering.mjs'
import { createCapture } from './capture.mjs'
import { createFindings, FINDINGS_IN_SNAPSHOT } from './findings.mjs'
import { createSandbox } from './sandbox.mjs'
import { createSkillsQueue, PROPOSALS_IN_SNAPSHOT, PROPOSALS_MAX, SKILLS_FILE_NAME, prepBrief } from './skills-queue.mjs'
import { resolveTargets, sweepGate, runSweep, SWEEP_QUIET_MS } from './fleet.mjs'
import { createCards, validateColor } from './cards.mjs'
import { createPasteboard } from './pasteboard.mjs'
import { createChains, realSpawn } from './chains.mjs'
import { createSpend } from './spend.mjs'
import { SNAPSHOT_BUDGET_BYTES, shedToBudget } from './snapshot-budget.mjs'
import { createScoper } from './scoping.mjs'
import { createDispatcher, IMPLEMENT_PROMPT } from './dispatch.mjs'
import { probeDispatchOptions } from './dispatch-options.mjs'
import { createScanner, probe, planRecord, backlogRecord, digestProjects, documentProjects, stampChanged } from './tasks.mjs'
import { readClaims, writeClaim, removeClaim, transferClaim } from './claims.mjs'
import { inheritableClaim } from './claims-inherit.mjs'
import { parseUsage, readNewestStatusline, dueEntries, crossings, NOTIFY_THRESHOLDS, DEFAULT_STALE_MS, DEFAULT_POLL_MS, inNightWindow, eligiblePlans, autoArmDecision, limitEpisode, disruptedSessions, RESUME_PROMPT, DISRUPT_MIN_FROZEN_MS, RESET_GRACE_MS } from './usage.mjs'
import { createAfterResetStore, WINDOW_ALIASES } from './after-reset.mjs'
import { createNightRunner } from './night.mjs'
import {
  readAuth, writeAuth, hashPassword, verifyPassword, mintSecret,
  signCookie, verifyCookie, parseCookies, rateLimiter, gate,
} from './auth.mjs'
import {
  emptyCanvas, sanitizeCanvas, inheritPosition, liveSpawnCount, isLiveSpawn, settleSpawns, movePending, pruneNodes,
  pushRecent, spawnSession, attachSession, realRun, validateCwd, completeDirs,
  pickClaudeBin, probeClaudeBin, probeSafeMode, killPlan, killSession,
  resolvePendingLink, dropExpiredLinks,
  OBSERVED_TERMINAL, COORD_MAX, NULL_STATE_MAX_MS, PROMPT_MAX,
} from './canvas.mjs'
import { createVoice, MAX_AUDIO_BYTES, MAX_SECONDS, CHUNK_MS } from './voice.mjs'
// The gear's Spinner control reads/writes the exact same file and the exact
// same id list hud.tsx does -- SPINNERS is imported straight from
// spinner-frames.js (plain JS, no compile step), never a second copy the gear
// could offer an id the band would reject.
import { SPINNERS } from '../hooks/spinner-frames.js'
import { createOrchestrator, DEFAULT_BLURB_MIN_MS } from './orchestrator.mjs'
import { createThreadStore } from './orchestrator-threads.mjs'
import { createPeerLink } from './peer-link.mjs'
import { forPeerIndex, selfNameFrom, applyRequest, livePeerSessions } from './peer.mjs'
import { setWireTap } from './peer-listener.mjs'
import { redactionContext, hostParts } from './peer-redact.mjs'
import { createWireLog, createWireSettings, createWireTap } from './peer-wirelog.mjs'

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
// Configurable for the same reason SZG_CANVAS_POLL_MS is: the expiry sweep's
// behaviour when the board empties is a TIMING property, and a timing property
// the suite cannot reach in under ninety seconds is one that regresses. Both
// default to the production values.
const SESSION_TTL_MS = Number(process.env.SZG_SESSION_TTL_MS) > 0 ? Number(process.env.SZG_SESSION_TTL_MS) : 90_000
const SWEEP_MS = Number(process.env.SZG_SWEEP_MS) > 0 ? Number(process.env.SZG_SWEEP_MS) : 10_000
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
// of slack for a merely slow-but-alive client. The snapshot is now measured
// and shed to its budget before it is written, so this guard is the last resort.
const SSE_MAX_BUFFERED_BYTES = 8 * 1024 * 1024
// The snapshot frame's byte budget. Configurable so a harness or a check by
// hand can force a shed; defaults to the production value, the way
// SZG_SESSION_TTL_MS does.
const SNAPSHOT_BUDGET = Number(process.env.SZG_SNAPSHOT_BUDGET) > 0 ? Number(process.env.SZG_SNAPSHOT_BUDGET) : SNAPSHOT_BUDGET_BYTES
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
// The fan-out runs: one rambling ask split into drafts, awaiting a person's
// accept or discard.
const FANOUT_FILE = join(WORLD_DIR, 'fanout.json')
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
// The proposals store (skills-queue.mjs). Under WORLD_DIR like every other
// authoritative store, never a hardcoded path.
const SKILLS_FILE = join(WORLD_DIR, SKILLS_FILE_NAME)
// Persisted orchestrator conversations. Under WORLD_DIR like every other
// authoritative store, never a hardcoded path.
const ORCH_THREADS_FILE = join(WORLD_DIR, 'orchestrator-threads.json')
// The one-thread GET's path prefix; the id is the single segment after it.
const ORCH_THREAD_PREFIX = '/api/orchestrator/thread/'
const PROJECT_PREFIX = '/api/projects/'
// The one-chain GET's prefix, and the POST sub-router's. The id is the single
// segment after it.
const CHAIN_PREFIX = '/api/chain/'
// A session id names a chain FILE, so one that could leave the chains
// directory -- a slash, decoded from `%2F` or registered as one, or a NUL,
// which the filesystem throws on -- is never handed to the store.
const chainIdOk = (id) => typeof id === 'string' && id !== '' && !/[/\0]/.test(id)
// What a chain records about its session, read from the relay's own record and
// never from a request body: the transcript path is one the relay later reads.
const chainMetaOf = (rec) => {
  const str = (v) => (typeof v === 'string' ? v : '')
  return { name: str(rec?.name), repo: str(rec?.repo), cwd: str(rec?.cwd), root: str(rec?.root), transcript: str(rec?.transcript), startedAt: rec?.startedAt }
}
// A thread as a page may see it. `resumeSessionId` is a Claude Code session
// id: the browser has no use for it and shipping it to a page is surface for
// nothing, so every response that carries a thread goes through here.
const publicThread = (t) => {
  const { resumeSessionId, ...rest } = t
  return rest
}
// A session card's own outline colour (cards.mjs). Under WORLD_DIR, same as
// FINDINGS_FILE just above, and for the same reason.
const CARDS_FILE = join(WORLD_DIR, 'cards.json')
// Prompts typed but deliberately not sent (pasteboard.mjs). Under WORLD_DIR
// like every other authoritative store, never a hardcoded path -- which is
// also what lets SZG_DATA_DIR point the harness at a temp directory.
const PASTEBOARD_FILE = join(WORLD_DIR, 'pasteboard.json')
// Session presets (agent-templates.mjs). Under WORLD_DIR like every other
// authoritative store, for the same reason as PASTEBOARD_FILE just above.
const AGENT_TEMPLATES_FILE = join(WORLD_DIR, 'agent-templates.json')
// Where the generated personas plugin lives. Overridable so a harness points
// it at a temp directory; production never sets it.
const AGENT_PLUGIN_DIR = process.env.SZG_AGENT_PLUGIN_DIR || join(homedir(), '.claude', 'skills', AGENT_PLUGIN_NAME)
// A judgement about each component tried in the gallery. AUTHORITATIVE like
// `findings` and `pasteboard`: it exists nowhere else and nothing can
// rebuild it, so the store writes through on every change rather than
// waiting for a tick. Nothing is ever deleted -- clearing a mark records the
// clearing.
const SANDBOX_FILE = join(WORLD_DIR, 'sandbox.json')
// Claude Code's own per-pid session registry. Read-only, and the ONE field
// read out of it is `tmux` -- the pane a session is sitting in, which is
// documented nowhere and is a hint rather than a contract (hud.tsx:594 reads
// the same file for names, with the same caveat). Overridable so the harness
// points at a fixture directory instead of the real one.
const SESSIONS_DIR = process.env.SZG_SESSIONS_DIR || join(homedir(), '.claude', 'sessions')
// Where Claude Code writes each session's transcript, read-only, which is how
// a live scoping conversation's replies reach the pane. Overridable so the
// harness points at an empty directory instead of the real one.
const CLAUDE_PROJECTS_DIR = process.env.SZG_CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects')
// and. The DEFAULT lives in usage.mjs so there is one source for it;
// this is only the env-var plumbing, matching every other SZG_*_MS constant
// in this file.
const USAGE_POLL_MS = Number(process.env.SZG_USAGE_POLL_MS) > 0 ? Number(process.env.SZG_USAGE_POLL_MS) : DEFAULT_POLL_MS
const USAGE_STALE_MS = Number(process.env.SZG_USAGE_STALE_MS) > 0 ? Number(process.env.SZG_USAGE_STALE_MS) : DEFAULT_STALE_MS
/** How often the night watchdog looks for a runaway session. */
const NIGHT_WATCH_MS = Number(process.env.SZG_NIGHT_WATCH_MS) > 0 ? Number(process.env.SZG_NIGHT_WATCH_MS) : 60_000
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
// A `let`: the agent roster it carries is re-probed after every personas
// write, so the payload's roster never lags the plugin on disk.
let DISPATCH_OPTIONS = await probeDispatchOptions(CLAUDE_BIN, realRun)
// Does a night run's spawn carry --max-budget-usd? The binary's help text
// documents the flag for --print only, but a live run showed a --bg session
// accepts it too, so the probe alone decides. The relay's own watchdog is the
// cap that is enforced either way. Read from the BOOT probe only: a personas
// re-probe changes the roster, never the binary's flags.
const MAX_BUDGET_FLAG = !!DISPATCH_OPTIONS?.maxBudget
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

/** The shape of `snapshot()`. Bumped BY HAND, and only by hand, in the same
 *  change that adds a field -- so a client can say "this relay predates the
 *  feature I need" instead of reading `undefined`, taking some other branch,
 *  and printing a confident wrong answer with nothing in the console. Never
 *  derived from a file hash or a commit count: a version that moves on a
 *  comment edit teaches every reader to ignore it. */
// 19: `projects` became a digest; a project's contents are fetched by route.
// 20: peers.jobs[] and peers.list[].counts.jobsActive/jobsFailed carry real
// drop job rows instead of the earlier placeholders, and a session a peer's
// applied action put to work carries `forPeer`.
// 21: `peerWire` -- the wire log's digest and the redaction switch, its own key
// beside `peers` -- and `peers.asks[].askId`, the wire id an ask is joined on.
// 22: peers.list[].policy carries trust, autoApply, autoApplyMaxLive and peerAsksPerHour; peers.asks[] carries origin and a proposals summary.
const PAYLOAD_VERSION = 22

/** This relay's build, read ONCE at boot from the checkout this file lives in
 *  -- never per request, and never from `process.cwd()`, which is whatever
 *  directory the session that launched the relay happened to be in.
 *
 *  `git` may be absent, HERE may be a plugin cache rather than a checkout, and
 *  neither is worth failing a boot over: both answer 'unknown'. A missing key
 *  would be a third state every reader would have to handle; one string with a
 *  reserved value is one. `realRun` resolves rather than rejects, so the
 *  `.catch` is belt to its braces. */
const BUILD_SHA = await (async () => {
  const r = await realRun('git', ['-C', HERE, 'rev-parse', '--short', 'HEAD'], { timeout: 4000 }).catch(() => null)
  const sha = String(r?.stdout ?? '').trim()
  return r && r.code === 0 && sha ? sha : 'unknown'
})()

/** When this process came up. With BUILD_SHA it answers "is the relay
 *  answering me the one built from the merge I just made?" from a terminal,
 *  with no UI and without restarting anything. */
const STARTED_AT = Date.now()

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
// A test knob: a harness proves a whole limit cycle in about a second, which a
// real five-minute stillness would not allow. Unset, the default holds. Zero is
// a legal value here, unlike the poll knobs beside it.
const MIN_FROZEN_MS = /^\d+$/.test(process.env.SZG_DISRUPT_MIN_FROZEN_MS ?? '')
  ? Number(process.env.SZG_DISRUPT_MIN_FROZEN_MS) : DISRUPT_MIN_FROZEN_MS
// A test knob of the same kind: how long after a boundary the clock alone
// proves the reset, so a harness need not wait out the real grace. Zero is legal.
const RESET_GRACE = /^\d+$/.test(process.env.SZG_RESET_GRACE_MS ?? '') ? Number(process.env.SZG_RESET_GRACE_MS) : RESET_GRACE_MS
const CANVAS_POLL_MS = Number(process.env.SZG_CANVAS_POLL_MS) > 0 ? Number(process.env.SZG_CANVAS_POLL_MS) : 5000
/** How often live scoping conversations are driven: parked turns delivered,
 *  replies read off their transcripts, `busy` settled, old ones ended.
 *  Overridable only so a harness can poll fast. */
const SCOPE_POLL_MS = Number(process.env.SZG_SCOPE_POLL_MS) > 0 ? Number(process.env.SZG_SCOPE_POLL_MS) : 5000
/** How long the board must have been quiet before /api/sweep will start one
 *  without an override. Tunable so a live check need not wait twenty minutes. */
const SWEEP_QUIET = Number(process.env.SZG_SWEEP_QUIET_MS) > 0 ? Number(process.env.SZG_SWEEP_QUIET_MS) : SWEEP_QUIET_MS
// The pattern pass's own knobs, each falling back to orchestrator.mjs's own
// default when unset or unusable -- never a partial value.
const PATTERN_MODEL = process.env.SZG_PATTERN_MODEL || undefined
const PATTERN_BUDGET_USD = Number(process.env.SZG_PATTERN_BUDGET_USD) > 0 ? Number(process.env.SZG_PATTERN_BUDGET_USD) : undefined
const PATTERN_MIN_MS = Number(process.env.SZG_PATTERN_MIN_MS) > 0 ? Number(process.env.SZG_PATTERN_MIN_MS) : undefined
// What pattern passes may spend in one local day, relay-wide.
const PATTERN_DAY_USD = Number(process.env.SZG_PATTERN_DAY_USD) > 0 ? Number(process.env.SZG_PATTERN_DAY_USD) : undefined
// How often the relay checks whether a pass is due. Its own gates (the
// floor, enough new material) live inside patternPass itself, so this only
// has to run often enough that none of them goes stale.
const PATTERN_TICK_MS = Number(process.env.SZG_PATTERN_TICK_MS) > 0 ? Number(process.env.SZG_PATTERN_TICK_MS) : 10 * 60_000
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
// The topic chains' refiner. Unset, each falls through to chains.mjs's own
// default, so those numbers live in exactly one place. CHAIN_DAY_USD is the
// refiner's day cap across every session, not a per-session allowance.
const CHAIN_MODEL = process.env.SZG_CHAIN_MODEL || undefined
const CHAIN_DAY_USD = Number(process.env.SZG_CHAIN_DAY_USD) > 0 ? Number(process.env.SZG_CHAIN_DAY_USD) : undefined
const CHAIN_IDLE_MS = Number(process.env.SZG_CHAIN_IDLE_MS) > 0 ? Number(process.env.SZG_CHAIN_IDLE_MS) : undefined
const CHAIN_EVERY = Number(process.env.SZG_CHAIN_EVERY) > 0 ? Number(process.env.SZG_CHAIN_EVERY) : undefined
// Whether the orchestrator's bundle carries chains at all. Off unless asked
// for: the bundle's budget is already contested, and a chain is a different
// fact from anything the session lines carry.
const CHAIN_BUNDLE = process.env.SZG_CHAIN_BUNDLE === '1'
// How often the relay CHECKS whether a pass is due. Its own cadence, well
// under the idle window those checks enforce: the checks are free and only a
// pass that actually runs spends anything.
const CHAIN_TICK_MS = 15_000
// How often the spend digest is recomputed with no new call, so the day and
// the rolling week roll over on their own. Free: it reads nothing off disk.
const SPEND_TICK_MS = 60_000
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
/** The fan-out runs. Authoritative like `requests`: a run's drafts exist
 *  nowhere else until they are accepted. Saved on the same 4 s cadence, and
 *  written through after every route that changes one. */
const fanoutStore = createFanoutStore({ file: FANOUT_FILE })
setInterval(() => { try { fanoutStore.flush() } catch (e) { process.stderr.write(`fanout save failed: ${e.message}\n`) } }, 4000).unref?.()

/** The orchestrator agent's memory: an append-only log of board actions,
 *  beside the two authoritative
 *  stores above. `append()` never throws -- every call site below still
 *  wraps it in try/catch, per the rule that a capture failure must never
 *  fail the action that caused it. */
const capture = createCapture({ dir: WORLD_DIR })

/** "Since the last sweep" is the newest `sweep` entry in the capture log, not a
 *  new file for one timestamp. A marker lost to rotation, or older than the
 *  newest thousand entries, widens the window: the export over-includes, which
 *  for a review is the safe direction to be wrong in. */
const lastSweepAt = () => capture.read({ limit: 1000 }).filter((e) => e.kind === 'sweep').at(-1)?.t ?? 0

/** What one session learned that changes another session's work
 *  AUTHORITATIVE like
 *  `requests` above -- a finding exists nowhere else -- so findings.mjs
 *  writes through atomically on every `add` rather than on a timer, and
 *  there is deliberately no flush() on the 4 s tick or in shutdown(): by the
 *  time either could run, the record is already on disk. */
const findings = createFindings({ file: FINDINGS_FILE })

/** The pattern pass's memory: proposals waiting to be rated or prepped
 *  (skills-queue.mjs). AUTHORITATIVE like `findings` just above, for the same
 *  reason -- a write-up exists nowhere else. Created before `createOrchestrator`
 *  below, which reads `skills.lastPassAt()` at construction. */
const skills = createSkillsQueue({ file: SKILLS_FILE })

/** A session card's own outline colour, set from the drawer (cards.mjs).
 *  AUTHORITATIVE like `findings` just above and write-through for the same
 *  reason: a colour is picked at human pace, and a relay killed right after
 *  the pick should not lose it waiting on the 4 s world tick. */
const cards = createCards({ file: CARDS_FILE })

/** The pasteboard. AUTHORITATIVE like `findings` and `cards` above, and
 *  write-through for the same reason and then some: the moment the band
 *  cancelled the submission, the relay held the only copy of something a
 *  person had typed. */
const pasteboard = createPasteboard({ file: PASTEBOARD_FILE })

/** The sandbox gallery's ledger. AUTHORITATIVE like `pasteboard` just above
 *  and write-through for the same reason: a judgement typed at human pace
 *  has nowhere else it lives. */
const sandbox = createSandbox({ file: SANDBOX_FILE })

/** Session-space buckets. AUTHORITATIVE like `sandbox` just above and
 *  write-through for the same reason: a saved shape has nowhere else it
 *  lives. `pushGroups` reaches `broadcast` only when called, well after it is
 *  assigned below. */
const GROUPS_PATH = join(WORLD_DIR, GROUPS_FILE)
const groupsStore = createGroups({ file: GROUPS_PATH })
const pushGroups = () => broadcast('groups', { groups: groupsStore.all() })

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
/** What the panes are SENT: one digest per project, sized by projects and
 *  worktrees rather than by plans or steps. Everything in this process reads
 *  `projects`; only the snapshot and the `projects` frame read the digest, and
 *  only the document routes read `projectsDocs`. */
let projectsDigest = []
let projectsDocs = []
/** The change stamp's own previous result, handed back to it every pass so a
 *  project whose document did not change keeps its `changedAt`. */
let projectsStamp = null

// Ordering here has no independent safety net -- each callee must stay
// self-guarded (saveWorld() already swallows its own errors). requests.flush()
// does not, and this is the one path where losing the queue is unrecoverable
// (it is authoritative, not derived -- see requests.mjs's header), so a
// failure here is never silent.
const shutdown = () => {
  scoper.killAll()
  orchestrator.killAll()
  // A refine child left running would go on spending after the relay exits.
  chains.killAll()
  voice.stop()
  saveWorld()
  try { requests.flush() } catch (e) { process.stderr.write(`dispatch save failed on shutdown: ${e.message}\n`) }
  try { fanoutStore.flush() } catch (e) { process.stderr.write(`fanout save failed on shutdown: ${e.message}\n`) }
  try { orchThreads.flush() } catch (e) { process.stderr.write(`orchestrator threads save failed on shutdown: ${e.message}\n`) }
  try { afterReset.flush() } catch (e) { process.stderr.write(`after-reset save failed on shutdown: ${e.message}\n`) }
  try { peerLink.flush() } catch (e) { process.stderr.write(`peer asks save failed on shutdown: ${e.message}\n`) }
  try { chains.flush() } catch (e) { process.stderr.write(`chain save failed on shutdown: ${e.message}\n`) }
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

/** The session list as it leaves the relay: each session a peer's applied
 *  action put to work carries `forPeer`, read from the tag the ledger row, the
 *  request or the session record stored at apply time. */
const withForPeer = (list) => {
  const idx = forPeerIndex({ spawnedBy: world.canvas.spawnedBy, requests: requests.all(), sessions: list })
  return idx.size ? list.map((s) => (idx.has(s.id) ? { ...s, forPeer: idx.get(s.id) } : s)) : list
}

/** The tag an apply stores, resolved from the ask the pane named through the
 *  peering engine's own log -- the pane never names a peer. A tag is a label:
 *  one that resolves to nothing is said once on stderr, and the action still
 *  applies, untagged. */
const forPeerOf = (body, route) => {
  const forPeer = typeof body.forAsk === 'string' && body.forAsk ? peerLink.tagFor(body.forAsk) : null
  if (body.forAsk !== undefined && !forPeer) {
    process.stderr.write(`${route}: forAsk names no incoming ask; applied untagged\n`)
  }
  return forPeer
}

// ---- the tmux listing -------------------------------------------------------

/** How long GET /api/tmux holds one listing, so a pane polling it does not
 *  fork tmux on every read. An apply never reads the held one: it takes its
 *  own listing inside the request that acts on it. */
const TMUX_CACHE_MS = 2000
let tmuxCache = { at: 0, panes: [] }

/** A fresh `tmux list-panes -a`, or [] when tmux is absent or has no server:
 *  "no tmux here" is a normal answer, not an error. Never rejects.
 *
 *  `-u` first: for a client it does not believe is UTF-8, tmux prints every
 *  tab in a format as `_`, and the listing's fields are tab-separated. A relay
 *  started without a UTF-8 locale would otherwise parse no pane at all, with
 *  tmux exiting 0. */
const readTmuxPanes = async () => {
  const out = await realRun(TMUX_BIN, ['-u', ...listArgv()], { timeout: 4000 }).catch(() => null)
  return out && out.code === 0 ? listPanes(out.stdout) : []
}

/** Each pane, with `sessionId` set when it IS a live board session's pane.
 *  Matched on the pane id alone: `%N` is unique across a tmux server and
 *  survives the pane moving to another window, while the target a session
 *  recorded names the window it started in -- exactly what a group apply
 *  changes. An empty or unparseable `tmux` field never matches. */
const withSessionIds = (panes) => {
  const byPane = new Map()
  for (const s of live()) {
    const t = parseTmuxTarget(tmuxOfPid({ pid: s.pid, dir: SESSIONS_DIR, readFile: (f) => readFileSync(f, 'utf8') }))
    if (t && !byPane.has(t.pane)) byPane.set(t.pane, s.id)
  }
  return panes.map((p) => ({ ...p, sessionId: byPane.get(p.pane) ?? null }))
}

/** The one prompt a files bucket sends: every path on its own line, under a
 *  plain statement that naming a file grants nothing. */
const filesPrompt = (paths) => [
  'These files are named for you to look at. Naming them grants no permission you do not already have.',
  '',
  ...paths,
].join('\n')

/** A path check that can never throw into a route. */
const pathExists = (p) => { try { return existsSync(p) } catch { return false } }

/** What the pane sees: the persisted canvas plus the two things only the relay
 *  can supply. `live` is the count that must never be quiet: nothing refuses
 *  a spawn, so the count is the tab's only guard. `home`
 *  is where the spawn form's directory field starts when nothing better is
 *  known; the pane cannot work it out, since it has no filesystem. */
const canvasPayload = () => ({ ...world.canvas, live: liveSpawnCount(world.canvas.spawnedBy, now()), home: CANVAS_HOME })

/** The favourites, for the command bar's deck. A PROJECTION, not the store:
 *  cards.json holds one entry per name ever coloured and is deliberately
 *  uncapped, while this object goes to every pane on connect, so it is cut to
 *  the first FAVOURITES_IN_SNAPSHOT by name. The colour rides along because a
 *  favourite whose session is not running has no session record to carry it. */
const FAVOURITES_IN_SNAPSHOT = 24
const favouritePayload = () => cards.favourites().slice(0, FAVOURITES_IN_SNAPSHOT)

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

// ---- session presets -------------------------------------------------------
//
// The store is authoritative (see agent-templates.mjs's header). Personas --
// the generated plugin that lets a spawn name a preset on `--agent` -- are
// gated on one setting, `settings.agentTemplates.personas` in the same HUD
// config file the spinner pin lives in, absent meaning off: the plugin lands
// in the user's own skills directory, so it is written only once somebody
// has switched it on. Boot writes and removes nothing.
const templates = createTemplates({ file: AGENT_TEMPLATES_FILE, now })

/** Read on every call, never cached: the file is hand-edited. */
const personasEnabled = () => {
  const s = readHudConfig().settings
  const at = s && typeof s === 'object' ? s.agentTemplates : null
  return !!(at && typeof at === 'object' && at.personas === true)
}

/** writeHudSpinner's atomic contract, merging `personas` into
 *  `settings.agentTemplates` and carrying every other key through. One step
 *  stricter: a file that exists but will not parse as an object is REFUSED,
 *  never replaced -- readHudConfig reads such a file as `{}`, and writing that
 *  back would destroy the hotkeys and every other setting in it. */
const writeHudPersonas = (enabled) => {
  if (existsSync(HUD_CONFIG_FILE)) {
    let raw
    try { raw = JSON.parse(readFileSync(HUD_CONFIG_FILE, 'utf8')) } catch { raw = null }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `${HUD_CONFIG_FILE} would not parse; refusing to overwrite it` }
    }
  }
  const doc = readHudConfig()
  const settings = { ...(doc.settings && typeof doc.settings === 'object' ? doc.settings : {}) }
  const cur = settings.agentTemplates
  settings.agentTemplates = { ...(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}), personas: enabled === true }
  const next = { ...doc, settings }
  mkdirSync(dirname(HUD_CONFIG_FILE), { recursive: true })
  const tmp = `${HUD_CONFIG_FILE}.tmp-${process.pid}-${now()}`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameSync(tmp, HUD_CONFIG_FILE)
  return { ok: true }
}

/** How many personas are on disk right now: the agent files under a directory
 *  whose manifest names this plugin, else 0. Read from the disk rather than
 *  from the last write's answer, because a refused or rolled-back write leaves
 *  the previous plugin exactly where it was. */
const countPersonas = (dir) => {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))
    if (manifest?.name !== AGENT_PLUGIN_NAME) return 0
    return readdirSync(join(dir, 'agents')).filter((n) => n.endsWith('.md')).length
  } catch { return 0 }
}

/** What the pane reads. Replaced whole on every change, never mutated. */
let personaState = { enabled: personasEnabled(), dir: AGENT_PLUGIN_DIR, count: countPersonas(AGENT_PLUGIN_DIR), error: null }

/** The part of the template list the personas plugin is generated from. Two
 *  lists with the same signature produce the same plugin, so a write that
 *  leaves it unchanged (a rename of a persona-less preset, a reorder) never
 *  pays for a rewrite and a validation. */
const personaSignature = (list) => JSON.stringify((list ?? [])
  .filter((t) => typeof t?.agentDef === 'string' && t.agentDef.trim())
  .map((t) => [t.id, t.name, t.agentDef]))

// One personas write at a time: two overlapping writes would each remove and
// rename the same directory, and the loser's rename fails half-way.
let personasQueue = Promise.resolve()

/** Generate (or, with an empty list, remove) the personas plugin, record the
 *  outcome, and on success re-probe the roster so a spawn made next can name
 *  an agent that has just appeared. A throw is recorded, never raised. */
const syncPersonas = (list) => {
  const job = personasQueue.then(async () => {
    let out
    try {
      out = await writePersonas({ templates: list, dir: AGENT_PLUGIN_DIR, run: realRun, claudeBin: CLAUDE_BIN })
    } catch (err) {
      out = { ok: false, error: String(err?.message ?? err) }
    }
    if (out.ok) {
      try { DISPATCH_OPTIONS = await probeDispatchOptions(CLAUDE_BIN, realRun) } catch {}
    }
    personaState = { enabled: personasEnabled(), dir: AGENT_PLUGIN_DIR, count: countPersonas(AGENT_PLUGIN_DIR), error: out.ok ? null : String(out.error ?? 'personas write failed') }
  })
  personasQueue = job.catch(() => {})
  return job
}

/** After a create, update or delete: rewrite the plugin only when the setting
 *  is on AND the persona set actually changed. */
const personasAfterWrite = async (before) => {
  if (personasEnabled() && personaSignature(templates.all()) !== before) await syncPersonas(templates.all())
}

const snapshot = () => ({
  // First, so `curl /api/state | head -c 40` answers the question without jq.
  payloadVersion: PAYLOAD_VERSION,
  t: now(),
  // What the byte budget shed from this frame; shedToBudget writes it.
  // Declared here so the payload's key list stays in one place.
  shed: [],
  sessions: withForPeer(live()),
  events: events.slice(-EVENT_CAP),
  questions,
  approvals,
  links,
  projects: projectsDigest,
  canvas: canvasPayload(),
  dispatch: { requests: requests.all() },
  fanout: { runs: fanoutStore.all() },
  // Session presets and the personas plugin's state. A relay predating this
  // field serves a pane that reads it, so every client takes it with a default.
  agentTemplates: { items: templates.all(), personas: personaState },
  dispatchOptions: DISPATCH_OPTIONS,
  // `usage` is the parsed reading itself (usage.mjs's parseUsage shape);
  // `usageHistory` is the ring of changed readings the sparkline draws from;
  // the queue rides under `afterReset` rather than inside `usage`, so a field
  // named `usage` never has to also mean "the whole usage-window feature".
  usage: currentUsage,
  usageHistory,
  afterReset: { queue: afterReset.all(), night: nightPayload(), resume: resumePayload() },
  steering: { custom: steering.all() },
  // Bounded, not the whole store: this object goes to every pane on connect
  // and on every /api/state. Oldest-first, like `events`. The full store is
  // GET /api/findings?limit=200.
  findings: findings.read({ limit: FINDINGS_IN_SNAPSHOT }),
  // The quiet window a sweep waits for, as THIS relay resolved it, so the
  // pane's gate line never restates a different number.
  sweepQuietMs: SWEEP_QUIET,
  // Bounded, not the whole store, the same reason `findings` just above is:
  // this object goes to every pane on connect. The full store is one GET
  // (/api/skills). One getter, so the three fields cannot come from three
  // different moments.
  skillsQueue: {
    proposals: skills.read({ limit: PROPOSALS_IN_SNAPSHOT }),
    pass: orchestrator.passState(),
  },
  // The platform's own model calls: a digest of a few hundred bytes, never
  // records. The call list is one GET (/api/spend).
  spend: spend.digest(),
  // Prompts stashed with the band's marker. A relay predating this field
  // serves a pane that reads it, so every client takes it with `?? []`.
  pasteboard: pasteboard.all(),
  // Which session names are favourites, for the command bar's deck. A relay
  // predating this field serves a pane that reads it, so every client takes it
  // with a default.
  favourites: favouritePayload(),
  // The gallery's ledger. A relay predating this field serves a pane that
  // reads it, so every client takes it with `?? []`.
  sandbox: sandbox.all(),
  // Every session's topic chain, compact -- block titles and states, never
  // summaries or turn heads. The full chain is one GET away. Which chains ride
  // here is the store's call: a session that has ended is out of the map within
  // its TTL, and its chain is worth reading for a while after that.
  chains: chains.payload(live().map((s) => s.id)),
  // The session-space buckets. A relay predating this field serves a pane
  // that reads it, so every client takes it with `?? []`.
  groups: groupsStore.all(),
  voice: voicePayload(),
  hud: hudPayload(),
  // The orchestrator agent's blurb, plus the conversation HEADERS -- never the
  // turns. This frame goes in full to every pane that connects, so it must not
  // grow with conversation length; the pane fetches the current thread's turns
  // with one GET after it hydrates. Same TDZ-safe lazy-closure pattern as
  // `voicePayload()` above: `orchestrator` and `orchThreads` are referenced
  // only inside this body, called well after both are assigned below.
  orchestrator: { ...orchestrator.state(), threads: orchThreads.headers(), currentId: orchThreads.currentId() },
  viewers: panes.size,
  // The gear's password section reads this rather than getting its own
  // endpoint: `enabled` is false either when no password is configured yet
  // (the pane got here on a valid token, not a cookie) or when AUTH_OFF is
  // set -- both mean "no control here can do anything", so they collapse to
  // one flag rather than two the UI would have to reason about separately.
  auth: { enabled: Boolean(auth) && !AUTH_OFF },
  // Peering's state for the pane; built field by field, it carries no pairing secret, peer address or pairing code.
  peers: peerLink.payload(),
  // The wire log's digest and the redaction switch. Rows are paged from
  // /api/peer-wire; its own key, because `peers` is replaced whole on every
  // peers event and a field nested there would vanish.
  peerWire: { digest: wireLog.digest(), redactOff: wireSettings.off(), selfIsHostname: selfIsHostname() },
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

/** Panes dropped for not draining what they were sent -- a buffered-bytes drop
 *  or a write that threw, never an ordinary close. /api/health reports it. */
let droppedPanes = 0
/** `{ t, frame }`: the snapshot frame last built, while now() still reads its `t`. */
let frameMemo = null
/** `{ bytes, shed, sections }` of the snapshot frame last built, for /api/health. */
let lastFrame = null

const broadcast = (type, data) => {
  // A change is on its way to the panes, so a frame built before it is stale.
  // `viewers` alone leaves the memo: its own event follows every connect with
  // the count, and clearing on it would re-serialise the snapshot once per
  // pane in a burst of connects.
  if (type !== 'viewers') frameMemo = null
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of panes) {
    try {
      res.write(frame)
      // `writableLength` is what is still queued after this write -- the exact
      // quantity that grows without bound while a client never reads. Checked
      // after every frame, not on a timer, so a stalled client is caught the
      // broadcast cycle it falls behind on, not one scan interval later.
      if (res.writableLength > SSE_MAX_BUFFERED_BYTES) {
        if (panes.has(res)) droppedPanes++
        dropPane(res, `${res.writableLength} bytes buffered`)
      }
    } catch {
      if (panes.has(res)) droppedPanes++
      dropPane(res, 'write threw')
    }
  }
}

/** The snapshot as it leaves this relay: measured, and shed to SNAPSHOT_BUDGET.
 *  `/api/stream`, `/api/state` and `/api/health` all read it through here. The
 *  memo serves a burst of reads inside one millisecond from one serialisation;
 *  a broadcast or a finished write request clears it, since either can change
 *  the state inside that same millisecond. */
const snapshotFrame = () => {
  if (frameMemo && frameMemo.t === now()) return frameMemo.frame
  const frame = shedToBudget(snapshot(), { budget: SNAPSHOT_BUDGET })
  frameMemo = { t: frame.frame.t, frame }
  lastFrame = { bytes: frame.bytes, shed: frame.shed, sections: frame.sections }
  return frame
}

/** The id set of the last `sessions` frame actually sent. The expiry sweep
 *  compares against THIS rather than against sessions.size before and after its
 *  own live() call: rescan() calls live() every 4 s and prunes first, so by the
 *  time the sweep ran the map had already shrunk and the comparison saw nothing
 *  to report. It only ever bit when the board emptied COMPLETELY -- any other
 *  beating session's /api/stats broadcasts anyway -- and then every pane kept
 *  ghosts until a reload. Comparing the set is immune to which caller did the
 *  pruning. */
let lastSessionIds = ''
const idsKey = (list) => list.map((s) => s.id).join(' ')
/** The ONE way a `sessions` frame leaves this relay, so nothing can emit one
 *  without recording what it said. */
const broadcastSessions = () => {
  const list = live()
  lastSessionIds = idsKey(list)
  broadcast('sessions', withForPeer(list))
}

/** Every canvas write goes through here: the persisted state is dirty, and
 *  the panes hear about it on the `canvas` event, which carries the canvas
 *  alone rather than everything the relay persists. */
const canvasChanged = () => { worldDirty = true; broadcast('canvas', canvasPayload()) }

// Its own `agentTemplates` SSE event, never the whole snapshot -- same
// discipline as `canvasChanged` and `hudChanged`.
const templatesChanged = () => broadcast('agentTemplates', { items: templates.all(), personas: personaState })

// The Dispatch tab's scoping engine: spawns and manages headless `claude -p`
// children. Constructed here, after `broadcast`, rather than beside the
// `requests` store above — it closes over `broadcast`, which is a `const`
// declared below that point and is not yet initialised there.
// `claudeBin` is the capability-resolved one, so the Dispatch tab and the
// canvas cannot disagree about which `claude` is meant. It is passed through
// exactly as resolved -- CLAUDE_BIN, never a `|| 'claude'` construction-site
// fallback -- so a missing binary reaches a module as null rather than as a
// bare `claude` off PATH, which a background tick would otherwise spawn for
// real. Each module refuses to spawn on a null claudeBin itself, the same
// outcome its HTTP routes already answer with a 503.
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

// The platform's own model calls. Built after `broadcast`, which its
// change handler closes over, and before the three modules that record
// into it. The tick re-digests so `today` and the rolling week move on
// with no new call, and broadcasts only when the digest actually changed.
let spendJson = ''
const spendChanged = (d) => { spendJson = JSON.stringify(d); broadcast('spend', d) }
const spend = createSpend({ dir: WORLD_DIR, onChange: spendChanged })
spendJson = JSON.stringify(spend.digest())
setInterval(() => {
  try { const d = spend.digest(); if (JSON.stringify(d) !== spendJson) spendChanged(d) } catch (e) { process.stderr.write(`spend tick failed: ${e?.stack || e}\n`) }
}, SPEND_TICK_MS).unref?.()

// The topic chains. Built here, after `broadcast` exists, never up beside
// `findings`, where `broadcast` and `live` are still in the temporal dead
// zone. The store raises its own `chain` event, `{ sessionId, chain }` with the
// chain compact, so `broadcast` is handed over as it is.
// `realSpawn`, never `realRun`: the refiner reads the child's streams and kills
// it on a timeout, and realRun only ever hands back a finished result.
const chains = createChains({
  dir: WORLD_DIR, run: CLAUDE_BIN ? realSpawn : null, claudeBin: CLAUDE_BIN || 'claude', safeMode: CLAUDE_SAFE_MODE,
  model: CHAIN_MODEL, dayUsd: CHAIN_DAY_USD, idleMs: CHAIN_IDLE_MS, everyTurns: CHAIN_EVERY,
  capture, broadcast, spend,
})
// One relay-wide tick. Which chains are due, and whether anything spawns, is
// the store's decision; this only asks often enough.
setInterval(() => {
  try { chains.tick() } catch (e) { process.stderr.write(`chain tick failed: ${e?.stack || e}\n`) }
}, CHAIN_TICK_MS).unref?.()

const scoper = createScoper({
  store: requests, broadcast, claudeBin: CLAUDE_BIN, safeMode: CLAUDE_SAFE_MODE,
  run: realRun,
  // An arrow, not `enqueue` itself: that is a `const` declared further down
  // this file, still uninitialised when this line runs.
  enqueue: (id, cmd) => enqueue(id, cmd),
  hasSession: (id) => sessions.has(id),
  // Read at spawn time, not now: `boundPort` is assigned in server.listen.
  relayInfo: () => ({ relayPort: boundPort, relayToken: TOKEN }),
  projectsDir: CLAUDE_PROJECTS_DIR,
  fanoutStore,
  spend,
})

// The Dispatch tab's dispatcher: git worktrees and background `claude`
// sessions. Same TDZ reason as `scoper` just above -- it closes over
// `broadcast`, so it is built here, after `broadcast` exists, not beside the
// `requests` store.
const dispatcher = createDispatcher({ store: requests, broadcast, claudeBin: CLAUDE_BIN,
  // Read at dispatch time, not now: `boundPort` is assigned in server.listen,
  // long after this line runs. The canvas reads it at call time in its handler
  // for the same reason.
  relayInfo: () => ({ relayPort: boundPort, relayToken: TOKEN }),
  // A request's preset, looked up at dispatch time: the stored template as it
  // is then, the roster as last probed, and the personas setting as the file
  // says now. A preset deleted since the request was made means no preset.
  templateAgent: (r) => {
    const t = templates.get(r.dispatch?.templateId)
    return t ? templateArgv(t, { roster: DISPATCH_OPTIONS?.agents ?? [], personas: personasEnabled() }).agent : null
  },
  templateTools: (r) => templates.get(r.dispatch?.templateId)?.allowedTools ?? [] })

// Night hours' acting half: a worktree, a branch and one background session
// per armed plan, plus the runaway watchdog. `relayInfo` is a thunk for the
// same reason as the dispatcher's just above.
const nightRunner = createNightRunner({
  run: realRun, canvas: world.canvas, claudeBin: CLAUDE_BIN, now,
  relayInfo: () => ({ relayPort: boundPort, relayToken: TOKEN }),
  pluginDir: SPAWN_PLUGIN_DIR,
})
// one subprocess per pass, not one per session.
setInterval(() => {
  dispatcher.poll().catch((e) => process.stderr.write(`dispatch poll failed: ${e?.stack || e}\n`))
}, 5000).unref?.()

// Live scoping conversations: one listing per pass fills each session's id
// and state, parked turns are delivered, replies are read back off the
// transcript, and a conversation past its age ceiling is ended. Its own
// re-entrancy flag, the canvasTick shape: a listing slower than the interval
// must never overlap the one still running.
let scopePolling = false
setInterval(async () => {
  if (scopePolling) return
  scopePolling = true
  try { await scoper.pass() } catch (e) {
    process.stderr.write(`scoping poll failed: ${e?.stack || e}\n`)
  } finally { scopePolling = false }
}, SCOPE_POLL_MS).unref?.()

// Authoritative and write-through: a conversation exists nowhere else once
// its --resume pointer is lost.
const orchThreads = createThreadStore({ file: ORCH_THREADS_FILE })

// The header list, rebroadcast after anything that changes it: the five
// thread routes, an ask (the auto-title, the turn count, a thread created
// when none was current) and clear (a new current thread). Declared once,
// after both `broadcast` and `orchThreads`, and called only from request
// handlers, so no route can reach it before it exists.
const threadsChanged = () => broadcast('orchestrator', { threads: orchThreads.headers(), currentId: orchThreads.currentId() })

// The orchestrator agent. Same TDZ
// reasoning as `scoper`/`dispatcher` just above -- it closes over `broadcast`
// and `capture` -- plus `snapshot` and `panes`, both referenced only INSIDE
// a function body (`snapshot()`/`() => panes.size`) that is not actually
// called until well after every module-level `const` here has run, the same
// lazy-closure trick `voicePayload` already relies on for `voice`.
const orchestrator = createOrchestrator({
  broadcast, capture, findings, skills, claudeBin: CLAUDE_BIN, safeMode: CLAUDE_SAFE_MODE,
  threads: orchThreads,
  snapshot: () => snapshot(), panesSize: () => panes.size,
  askModel: ORCH_MODEL, blurbModel: ORCH_BLURB_MODEL, blurbMinMs: ORCH_BLURB_MIN_MS,
  patternModel: PATTERN_MODEL, patternBudgetUsd: PATTERN_BUDGET_USD, patternMinMs: PATTERN_MIN_MS,
  patternDayUsd: PATTERN_DAY_USD,
  bundleChains: CHAIN_BUNDLE,
  spend,
  // Read at call time, well after `peerLink` below exists -- the same lazy
  // closure `snapshot` relies on.
  actionGate: (ctx) => peerLink.gate(ctx),
})
// the timer trigger. Its own gates (a pane connected, the board having
// changed, the 10-minute floor) live inside refreshBlurb() itself; this tick
// only has to run often enough that none of those becomes stale by more than
// ORCH_BLURB_TICK_MS, which the loop's own comment above sizes against the
// 10-minute floor it is checking for.
setInterval(() => {
  orchestrator.refreshBlurb().catch((e) => process.stderr.write(`orchestrator blurb tick failed: ${e?.stack || e}\n`))
}, ORCH_BLURB_TICK_MS).unref?.()

// The pattern pass's own tick. Its own gates (the floor, enough new
// material, the shared slot) live inside patternPass itself, so this only
// has to run often enough that none of them goes stale.
setInterval(() => {
  orchestrator.patternPass().catch((e) => process.stderr.write(`pattern pass tick failed: ${e?.stack || e}\n`))
}, PATTERN_TICK_MS).unref?.()

// A drop's paths must resolve inside a root this relay already knows: every
// project's main checkout, every one of its worktrees, and every live
// session's own root -- never read at construction time, since only a fresh
// call sees what the scanner and the board currently hold. Each is
// `realpath`-resolved before it becomes a root a path is checked against; one
// that no longer resolves is left out rather than trusted as typed.
const dropRoots = () => {
  const found = new Set()
  for (const p of projects) {
    if (typeof p?.mainRoot === 'string') found.add(p.mainRoot)
    for (const w of p?.worktrees ?? []) if (typeof w?.path === 'string') found.add(w.path)
  }
  for (const s of live()) if (typeof s?.root === 'string') found.add(s.root)
  const resolved = new Set()
  for (const p of found) {
    try { resolved.add(realpathSync(p)) } catch {}
  }
  return [...resolved]
}

// The wire log and its tap: every body sent to a peer is redacted first and
// every exchange is logged, at the two functions any peer byte passes through.
// Registered before the link starts, so its first heartbeat is covered. The
// redaction context is rebuilt when the password changes and once a minute,
// so a new network address is picked up without a restart.
const wireSettings = createWireSettings({ dir: WORLD_DIR })
const wireLog = createWireLog({ dir: WORLD_DIR, onAppend: (row, digest) => broadcast('peerwire', { digest, row }) })
let redactCache = null
const redactContextNow = () => {
  const key = `${auth?.hash ?? ''}|${Math.floor(Date.now() / 60_000)}`
  if (redactCache?.key !== key) {
    redactCache = {
      key,
      ctx: redactionContext(hostParts({ env: process.env, token: TOKEN, auth, os: { homedir, userInfo, hostname: osHostname, networkInterfaces }, realpath: realpathSync })),
    }
  }
  return redactCache.ctx
}
const peerNameByFingerprint = (fp) => {
  try { return peerLink.payload().list.find((p) => p.fingerprint === fp)?.name ?? null } catch { return null }
}
setWireTap(createWireTap({ log: wireLog, settings: wireSettings, context: redactContextNow, peerNameOf: peerNameByFingerprint }))
const selfIsHostname = () => {
  try { return peerLink.payload().self === selfNameFrom(osHostname()) } catch { return false }
}

/** An action applied without a click goes through the same loopback route, and
 *  with the same body, as the pane's button: validation, the forPeer tag, the
 *  capture line and the broadcast all happen exactly as they do for a click.
 *  Never throws: every failure is an answer the engine records. */
const applyAction = async (action, { peer = null, forAsk = null } = {}) => {
  try {
    const req = applyRequest(action, { peer, forAsk, sessions: live() })
    if (req.error) return { ok: false, error: String(req.error).slice(0, 400) }
    const r = await fetch(`http://127.0.0.1:${boundPort}${req.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, ...req.body }),
    })
    const body = await r.json().catch(() => ({}))
    return r.ok ? { ok: true } : { ok: false, error: String(body?.error ?? `HTTP ${r.status}`).slice(0, 400) }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 400) }
  }
}

/** Sessions a peer's asks have running here: live ones carrying its tag, and
 *  every spawn for it the ledger still counts as live, by the same rule the
 *  canvas's own live count uses. */
const liveForPeer = (name) => livePeerSessions({
  peer: name, sessions: withForPeer(live()), spawnedBy: world.canvas.spawnedBy, isLiveSpawn, now: now(),
})

// Peering: a second, TLS-only listener with its own route table, built
// only while peering is enabled. It shares nothing with the server below --
// not the handler, not the gate, not a prefix -- so no route added there can
// ever be reached from it. Same ordering reason as `orchestrator` just above:
// it closes over `broadcast`, `live` and `orchestrator`.
const peerLink = createPeerLink({ dir: WORLD_DIR, run: realRun, sessions: () => withForPeer(live()), broadcast, orchestrator, dropRoots, applyAction, liveForPeer })
peerLink.start().catch((e) => process.stderr.write(`peering failed to start: ${e?.stack || e}\n`))

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
  const unpromised = dropExpiredLinks(world.canvas.spawnedBy, now())
  if (unpromised.changed) { world.canvas.spawnedBy = unpromised.spawnedBy; changed = true }
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
let lastAgents = { at: 0, rows: [] }
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
  // The same listing the waiting flags come from, kept so a decision taken on
  // another timer reads Claude Code's own knowledge without shelling out a
  // second time. Its age is what makes a decision fail closed rather than
  // guess.
  lastAgents = { at: now(), rows: agents }
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
  if (changed) broadcastSessions()
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

/** What opening a channel from A to B IS, in one place. Two callers reach it:
 *  /api/link (a wire landed on an existing node) and /api/register (a wire a
 *  spawn promised, claimed the moment its child reports in). They were written
 *  as one function rather than two so the second can never drift from the
 *  first -- a link that records but does not brief, or briefs but is not
 *  drawn, is the kind of half-state nothing on the board would reveal.
 *
 *  `note === null` means WIRE ONLY: record it, draw it, interrupt nobody. Every
 *  other note -- including '' -- costs the SOURCE a queued command, a tool call
 *  and a turn, which is exactly why the two values are kept apart. */
const openChannel = ({ fromId, toId, kind = 'brief', note = '' }) => {
  const from = sessions.get(fromId), to = sessions.get(toId)
  if (!from || !to) return { ok: false, error: 'unknown session' }
  const link = { id: uid(), t: now(), from: fromId, to: toId, kind }
  links = [...links.filter((l) => !(l.from === fromId && l.to === toId)), link]
  if (note !== null) {
    enqueue(fromId, {
      verb: 'send-message',
      payload: { toName: to.agentName || to.name || to.id, toId: to.id, kind, note },
    })
  }
  try { capture.append('link', fromId, { to: toId, linkKind: kind }) } catch {}
  broadcast('links', links)
  return { ok: true, link }
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
// The last non-null window per key, carrying the reading's own `observedAt`.
let lastSeenWindows = { fiveHour: null, sevenDay: null }
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
const usagePayload = () => ({ usage: currentUsage, history: usageHistory, queue: afterReset.all(), night: nightPayload(), resume: resumePayload() })

/** The night policy as the panel reads it: the stored settings, whether it is
 *  night right now, and -- from the same autoArmDecision the scheduler acts on
 *  -- either when a plan arms or why nothing does. Reads the scanner's cached
 *  `projects` rather than rescanning: this runs on every usage broadcast. */
const nightPayload = () => {
  const settings = afterReset.settings()
  const d = autoArmDecision({
    usage: currentUsage, queue: afterReset.all(), settings,
    projects, sessions: live(), now: now(),
  })
  const win = currentUsage.fiveHour
  return {
    ...settings.night,
    active: inNightWindow(now(), settings.night),
    nextResetAt: win?.resetsAt ?? null,
    armsAt: d.arm ? (win?.resetsAt ?? null) : null,
    armed: afterReset.all().find((e) => e.kind === 'plan' && e.state === 'pending')?.id ?? null,
    held: d.arm ? null : d.reason,
    eligible: eligiblePlans(projects).slice(0, 20),
  }
}

// What the last reset actually did, so the panel can say so after the rows
// have cleared. Declared above its reader: `resumePayload` only reads it when
// called, but a reader above its own declaration is a trap for the next edit.
let lastFire = null
// The disrupted list as it stood at the last broadcast, so a change to it can
// be told apart from a tick where nothing moved.
let lastResumeKey = null

/** The standing resume arm as the panel reads it: the stored settings, the
 *  open episode, and every session the relay currently believes the limit
 *  stopped -- each with the sentence that admitted it. `held` is the relay's
 *  own account of why nothing would fire; a bare false would make "not armed",
 *  "no reading" and "no listing" look identical on the panel. */
const resumePayload = () => {
  const r = afterReset.settings().resume
  const d = disruptedSessions({
    sessions: live(), agents: lastAgents.rows, agentsAt: lastAgents.at,
    episode: r.episode, excluded: r.excluded, fired: afterReset.all(), now: now(),
    minFrozenMs: MIN_FROZEN_MS,
  })
  return {
    ...r,
    disrupted: d.rows.slice(0, 40),
    held: !r.armed ? 'not armed' : d.held,
    lastFire,
  }
}

// Ids fireEntry is part-way through. A plan's fire awaits git and a spawn, and
// the entry stays `pending` until it settles, so without this a scheduler tick
// and a fire-now landing in that gap would each start a session.
const firing = new Set()

/** The ONE firing path. The scheduler calls it for a due entry and the route
 *  calls it for "fire now" -- two callers, never two code paths, because two
 *  paths that must behave identically will not, and the divergence is
 *  invisible until the night it matters. Marks the entry itself, fired or
 *  failed, and never throws. */
const fireEntry = async (entry) => {
  if (firing.has(entry.id)) return
  firing.add(entry.id)
  try {
    if (entry.kind === 'prompt') {
      if (!entry.target || !sessions.has(entry.target)) {
        throw new Error('target session is not registered with this relay')
      }
      enqueue(entry.target, { verb: 'prompt', payload: { text: String(entry.payload?.text ?? '') } })
    } else if (entry.kind === 'resume') {
      // The prompt branch's twin, and deliberately so: a resume reaches a
      // session that is still here, through the queue it already polls. It
      // shells out to nothing.
      if (!entry.target || !sessions.has(entry.target)) {
        throw new Error('target session is not registered with this relay')
      }
      enqueue(entry.target, { verb: 'prompt', payload: { text: RESUME_PROMPT } })
    } else if (entry.kind === 'spawn') {
      if (!CLAUDE_BIN) throw new Error('no usable claude binary was found')
      const p = entry.payload ?? {}
      // The canvas's own spawn path, not a second one: argv array, prompt last
      // behind the end-of-options sentinel, the child's environment stripped,
      // and this relay's own coordinates on --settings. None of that is
      // reimplemented here and none of it may be.
      const out = await spawnSession({
        canvas: world.canvas, run: realRun, now, claudeBin: CLAUDE_BIN,
        relayPort: boundPort, relayToken: TOKEN, pluginDir: SPAWN_PLUGIN_DIR,
        hasSession: (id) => sessions.has(id),
        body: { cwd: p.cwd, prompt: p.prompt, name: p.name ?? '', model: p.model, effort: p.effort },
      })
      if (out.changed) canvasChanged()
      if (out.status !== 200) throw new Error(out.body?.error ?? `spawn failed (${out.status})`)
      afterReset.markFired(entry.id, { ok: true, payload: {
        spawn: { shortId: out.body.shortId, name: out.body.name, cwd: out.body.cwd, spawnedAt: now() },
      } })
      return
    } else if (entry.kind === 'implement') {
      const ids = Array.isArray(entry.payload?.ids) ? entry.payload.ids : []
      if (!ids.length) throw new Error('no ids to implement')
      // implementIds SKIPS a request that is not `planned`, has no sessionId,
      // or whose session is no longer registered here -- which at 03:00 is
      // the normal case, because the planning session is gone. Throwing its
      // answer away and recording `fired` is a confident green for work
      // nothing did.
      const { queued, skipped } = implementIds(ids)
      if (!queued.length) throw new Error(`no request could be green-lit: ${skipped.join(', ')}`)
      if (skipped.length) afterReset.markFired(entry.id, { ok: true, payload: { skipped } })
      else afterReset.markFired(entry.id, { ok: true })
      return
    } else if (entry.kind === 'plan') {
      if (!CLAUDE_BIN) throw new Error('no usable claude binary was found')
      const night = afterReset.settings().night
      const budgetUsd = Number(entry.payload?.budgetUsd) > 0 ? Number(entry.payload.budgetUsd) : night.budgetUsd
      let out
      try {
        out = await nightRunner.fire(entry, { budgetUsd, maxBudgetFlag: MAX_BUDGET_FLAG })
      } finally {
        // A spawn writes the canvas ledger whether or not it succeeds.
        canvasChanged()
      }
      if (!out.ok) throw new Error(out.error)
      afterReset.markFired(entry.id, { ok: true, payload: { spawn: out.spawn, budgetUsd } })
      return
    } else {
      // An unknown kind is refused at creation, in both the route and the
      // store -- this branch is unreachable except via a hand-edited
      // after-reset.json, and even then it fails loudly rather than silently
      // doing nothing.
      throw new Error(`unrecognised kind: ${entry.kind}`)
    }
    afterReset.markFired(entry.id, { ok: true })
  } catch (e) {
    afterReset.markFired(entry.id, { ok: false, error: e?.message || String(e) })
  } finally {
    firing.delete(entry.id)
  }
}

/** Ends the exclusions a reset honoured. An exclusion is made against one
 *  reset, and its `until` alone cannot end it: an episode can close on a moved
 *  boundary before that time comes, and an exclusion left standing would
 *  silently suppress the next reset. Only the exclusions the pass read are
 *  ended -- one set again with a new `until` while the pass awaited stands. */
const endExclusions = (read) => {
  const current = afterReset.settings().resume.excluded
  for (const e of read) {
    if (current.some((c) => c.id === e.id && c.until === e.until)) afterReset.setResume({ include: e.id })
  }
}

/** Create and fire one resume per disrupted session, once per episode.
 *
 *  The entry is the record: it names the episode it answered, so a morning
 *  reading the queue sees which reset prompted whom and what failed. De-dup is
 *  a query over the store's own items rather than new bookkeeping, so it
 *  survives a restart for free. Every exclusion the pass read ends with it,
 *  armed or not. */
const resumePass = async (episode, t) => {
  const r = afterReset.settings().resume
  if (!episode) return false
  try {
    if (!r.armed) return false
    const { rows } = disruptedSessions({
      sessions: live(), agents: lastAgents.rows, agentsAt: lastAgents.at,
      episode, excluded: r.excluded, fired: afterReset.all(), now: t,
      minFrozenMs: MIN_FROZEN_MS,
    })
    const targets = rows.filter((row) => row.eligible)
    // A reset that resumed nobody is still a reset the relay saw: without this
    // the morning panel could not tell "nothing was eligible" from "no reset".
    if (!targets.length) {
      lastFire = { at: t, resetsAt: episode.resetsAt, fired: 0, failed: 0 }
      return true
    }
    let ok = 0, failed = 0
    for (const row of targets) {
      const entry = afterReset.create({
        window: episode.window, kind: 'resume', target: row.id,
        armedResetsAt: episode.resetsAt,
        payload: { auto: true, reason: row.reason, sessionName: row.name, episode },
      })
      await fireEntry(entry)
      if (afterReset.get(entry.id)?.state === 'fired') ok++; else failed++
    }
    lastFire = { at: t, resetsAt: episode.resetsAt, fired: ok, failed }
    return true
  } finally {
    endExclusions(r.excluded)
  }
}

// Re-entrancy guard, same reason canvasTick/needsTick carry one: a slow read
// of STATUSLINE_DIR must not stack a second tick on top of a still-running
// one every USAGE_POLL_MS. It also covers the awaited spawn inside a plan's
// fire, which is why `usagePolling` clears in the `finally`.
let usagePolling = false
const usageTick = async () => {
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
    // When the limit stops every session no statusline runs and the reading
    // goes dark, so the episode is followed from the last window the relay saw
    // for each key, and the clock proves the reset.
    for (const w of ['fiveHour', 'sevenDay']) {
      if (next[w]) lastSeenWindows[w] = { ...next[w], observedAt: next.observedAt }
    }
    const known = {
      ...currentUsage,
      fiveHour: currentUsage.fiveHour ?? lastSeenWindows.fiveHour,
      sevenDay: currentUsage.sevenDay ?? lastSeenWindows.sevenDay,
    }
    if (changed) {
      usageSignature = key
      usageHistory = [...usageHistory, { t, usage: next }].slice(-USAGE_RING_CAP)
    }
    let fired = false

    // One episode at a time, persisted, and closed by the same proofs a
    // queued entry's fire uses: a moved boundary, or the clock. An open episode is
    // followed to its own end; with none open, the armed windows are tried in
    // order, so the five-hour window is preferred when both are armed.
    const res = afterReset.settings().resume
    const watching = res.episode ? [res.episode.window] : res.windows
    let closed = null
    for (const w of watching) {
      const ep = limitEpisode(res.episode, known, w, t, RESET_GRACE)
      if (JSON.stringify(ep ?? null) === JSON.stringify(res.episode ?? null)) continue
      if (ep === null && res.episode) closed = res.episode
      afterReset.setEpisode(ep)
      fired = true
      break
    }
    // A session already mid-task is worth more than a new night run, so the
    // fleet is restarted before anything else is armed on top of it -- which
    // also lets the night decision's "still running" refusal see the truth.
    if (closed && await resumePass(closed, t)) fired = true
    // The disrupted list moves on the needs poll, not on a reading, so a
    // change to it is news of its own; without this the panel keeps showing
    // the list as it stood at the last reading.
    const rp = resumePayload()
    const resumeKey = JSON.stringify([rp.held, rp.disrupted.map((d) => [d.id, d.eligible, d.excluded])])
    if (resumeKey !== lastResumeKey) { lastResumeKey = resumeKey; fired = true }

    // The scheduler: same 15s poll as the reading itself, so a reset is
    // noticed no later than the reading that proves it. usage.mjs's
    // dueEntries does the deciding; this only acts on what it returns.
    const due = dueEntries(afterReset.all(), currentUsage, t, RESET_GRACE)
    for (const entry of due) { fired = true; await fireEntry(entry) }

    // One plan per qualifying reset, never two, and never on top of a session
    // waiting on a human. autoArmDecision does ALL the deciding -- this only
    // acts on what it returns, and nightPayload publishes its refusal reason.
    const settings = afterReset.settings()
    const decision = autoArmDecision({
      usage: currentUsage, queue: afterReset.all(), settings,
      projects, sessions: live(), now: t,
    })
    if (decision.arm) {
      const p = decision.plan
      afterReset.create({
        window: 'fiveHour', kind: 'plan', target: p.rel,
        armedResetsAt: currentUsage.fiveHour?.resetsAt ?? null,
        payload: { mainRoot: p.mainRoot, project: p.project, planName: p.name,
                   planTitle: p.title, auto: true, budgetUsd: settings.night.budgetUsd },
      })
      fired = true
    }

    if (changed || fired || crossed.length) broadcast('usage', { ...usagePayload(), crossed })
  } catch (e) {
    process.stderr.write(`usage poll failed: ${e?.stack || e}\n`)
  } finally {
    usagePolling = false
  }
}
// Nothing awaits the returned promise, and usageTick catches everything
// itself, so an async tick is safe to hand to setInterval.
setInterval(usageTick, USAGE_POLL_MS).unref?.()

// The runaway watchdog: its own interval and its own re-entrancy guard, since
// a stop awaits a subprocess. night.mjs decides and stops; only the relay
// writes the store, recording a successful stop on the entry so the panel
// can say when and why. A failed stop is not recorded -- the next pass tries
// again -- and goes to stderr.
let nightWatching = false
const nightWatchTick = async () => {
  if (nightWatching) return
  nightWatching = true
  try {
    const stopped = await nightRunner.watch({
      entries: afterReset.all(), sessions: live(),
      settings: afterReset.settings(), now,
    })
    for (const s of stopped) {
      if (s.ok) {
        afterReset.annotate(s.id, { stoppedAt: now(), stopReason: s.reason })
        process.stderr.write(`night: stopped ${s.id} — ${s.reason}\n`)
      } else {
        process.stderr.write(`night: failed to stop ${s.id} (${s.reason}): ${s.error}\n`)
      }
    }
    if (stopped.some((s) => s.ok)) broadcast('usage', { ...usagePayload(), crossed: [] })
  } catch (e) {
    process.stderr.write(`night watch failed: ${e?.stack || e}\n`)
  } finally {
    nightWatching = false
  }
}
setInterval(() => { nightWatchTick() }, NIGHT_WATCH_MS).unref?.()

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

const PAGE_DEFAULT = 500
const PAGE_MAX = 2000
/** `offset` and `limit` as a browser sends them. Absent, blank, negative and
 *  non-numeric all mean the default, and an over-large limit clamps rather
 *  than refusing -- a paged read is a convenience, not a gate. An offset past
 *  the end is not an error either: it answers an empty page and the real
 *  total, which is how a caller learns it walked off the end. */
const pageOf = (params) => {
  const num = (raw) => { const x = Number(raw); return Number.isFinite(x) ? Math.floor(x) : null }
  const off = num(params.get('offset'))
  const lim = num(params.get('limit'))
  return {
    offset: off !== null && off > 0 ? off : 0,
    limit: lim !== null && lim > 0 ? Math.min(PAGE_MAX, lim) : PAGE_DEFAULT,
  }
}

/** The plan and backlog routes' one rule: a page of a scanned record's items,
 *  the record's other fields whole, the total, and the stamp of the project
 *  that owns the worktree. `find` matches both parameters against the scan
 *  and builds no path. A worktree the scan does not hold is refused before a
 *  file is looked for, so the caller learns which of the two it got wrong, and
 *  both are a 400: the caller asked wrongly, which a relay with no such route
 *  -- a 404 -- must never be mistaken for. */
const itemsPage = (res, url, find, field) => {
  const wt = url.searchParams.get('wt')
  const owner = wt ? projects.find((p) => (p?.worktrees ?? []).some((w) => w.path === wt)) : null
  if (!owner) return json(res, 400, { error: 'unknown worktree' })
  const record = find(projects, wt, url.searchParams.get('path'))
  if (!record) return json(res, 400, { error: 'unknown file' })
  const { offset, limit } = pageOf(url.searchParams)
  const items = Array.isArray(record.items) ? record.items : []
  return json(res, 200, {
    [field]: { ...record, items: items.slice(offset, offset + limit) },
    offset, limit, total: items.length,
    changedAt: projectsStamp?.changedAt.get(owner.key) ?? null,
  })
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

  // A write can change what the snapshot says inside the millisecond its memo
  // is keyed on, so the memo goes once any write has answered.
  if (req.method !== 'GET' && req.method !== 'HEAD') res.on('finish', () => { frameMemo = null })

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
    res.write(`event: snapshot\ndata: ${snapshotFrame().json}\n\n`)
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
  if (reading && path === '/api/health') {
    // /api/health is the one route auth.mjs's gate() allows unconditionally,
    // so this diagnostic works on a password-protected pane from a terminal
    // with no cookie. That is why the stamp lives here and not on /api/state.
    // `snapshot` is the frame last sent -- its size, the budget, what was shed
    // and what each key cost -- built first when nothing has been sent yet.
    // `droppedPanes` counts panes dropped for not draining, never a close.
    if (!lastFrame) snapshotFrame()
    return json(res, 200, {
      ok: true, port: boundPort, sessions: sessions.size,
      payloadVersion: PAYLOAD_VERSION,
      build: { sha: BUILD_SHA, startedAt: STARTED_AT },
      snapshot: {
        bytes: lastFrame.bytes, budgetBytes: SNAPSHOT_BUDGET,
        overBudget: lastFrame.bytes > SNAPSHOT_BUDGET,
        shed: lastFrame.shed, sections: lastFrame.sections, droppedPanes,
      },
    })
  }
  if (reading && path === '/api/state') {
    const frame = snapshotFrame()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(frame.json)
  }
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
  // The proposals store. Same read-only, below-the-gate placement and the
  // same reasoning as /api/findings just above -- a method-agnostic
  // `path ===` check here would intercept the POSTs further down that WRITE
  // the queue, and answer them 200 without ever reaching authed().
  if (reading && path === '/api/skills') {
    const n = Number(url.searchParams.get('limit'))
    const limit = Number.isFinite(n) && n > 0 ? Math.min(PROPOSALS_MAX, Math.floor(n)) : PROPOSALS_MAX
    return json(res, 200, { proposals: skills.read({ limit }) })
  }
  // The spend ledger's call list. Same read-only, below-the-gate placement
  // and the same reasoning as /api/findings: a method-agnostic check here
  // would intercept the POST further down that records a call.
  if (reading && path === '/api/spend') {
    const num = (k) => { const v = url.searchParams.get(k); return v === null || v === '' ? NaN : Number(v) }
    return json(res, 200, spend.read({ kind: url.searchParams.get('kind') ?? '', since: num('since'), before: num('before'), limit: num('limit') }))
  }
  // The peer wire log. Same read-only, below-the-gate placement and the same
  // reasoning as /api/spend: a method-agnostic check here would intercept the
  // POST further down that flips a peer's redaction switch.
  if (reading && path === '/api/peer-wire') {
    const id = url.searchParams.get('id')
    if (id !== null) {
      const row = wireLog.get(Number(id))
      return row ? json(res, 200, { row }) : json(res, 404, { error: 'no such exchange' })
    }
    const num = (k) => { const v = url.searchParams.get(k); return v === null || v === '' ? NaN : Number(v) }
    const str = (k) => url.searchParams.get(k) ?? ''
    return json(res, 200, wireLog.read({ before: num('before'), since: num('since'), kind: str('kind'), peer: str('peer'), q: str('q'), limit: num('limit') }))
  }
  // The pasteboard. Same read-only, BELOW-the-gate placement and the same
  // reasoning as /api/findings just above: a method-agnostic `path ===` check
  // here would intercept the POSTs further down that WRITE the board, and
  // answer them 200 without ever reaching authed().
  if (reading && path === '/api/pasteboard') {
    return json(res, 200, { pasteboard: pasteboard.all() })
  }
  // The tmux pane listing, derived and never stored. Same read-only,
  // BELOW-the-gate placement and the same reasoning as /api/pasteboard just
  // above: a method-agnostic `path ===` check here would intercept a POST
  // further down, and answer it without ever reaching authed().
  if (reading && path === '/api/tmux') {
    const t = now()
    if (t - tmuxCache.at > TMUX_CACHE_MS) tmuxCache = { at: t, panes: withSessionIds(await readTmuxPanes()) }
    return json(res, 200, { ok: true, at: tmuxCache.at, panes: tmuxCache.panes })
  }
  // The gallery's ledger. Same read-only, BELOW-the-gate placement and the
  // same reasoning as /api/pasteboard just above: a method-agnostic
  // `path ===` check here would intercept the POSTs further down that WRITE a
  // mark, and answer them 200 without ever reaching authed().
  if (reading && path === '/api/sandbox') {
    return json(res, 200, { sandbox: sandbox.all() })
  }
  // The topic chains. Same read-only, BELOW-the-gate placement and the same
  // reasoning as /api/pasteboard just above: a method-agnostic check here
  // would intercept the POSTs further down that WRITE a chain, and answer them
  // 200 without ever reaching authed(). The export is matched first, by its
  // whole path: it does not start with the one-chain prefix, and keeping the
  // two apart means a later reader never confuses them.
  if (reading && path === '/api/chains/export') {
    return json(res, 200, chains.exportAll({ since: Number(url.searchParams.get('since')) }))
  }
  // One chain in full. The id is one path segment: an id carrying a `/` is a
  // 404 rather than a lookup, so this prefix can never shadow a sibling route
  // added later.
  if (reading && path.startsWith(CHAIN_PREFIX)) {
    // A malformed escape is a 404, never a throw: this branch sits outside the
    // POST ladder's try, and an unhandled rejection would take the relay down.
    // The store read is guarded for the same reason.
    let id = ''
    try { id = decodeURIComponent(path.slice(CHAIN_PREFIX.length)) } catch { return json(res, 404, { error: 'unknown session' }) }
    if (!chainIdOk(id)) return json(res, 404, { error: 'unknown session' })
    let chain = null
    try { chain = chains.get(id) } catch (e) {
      process.stderr.write(`chain read failed for ${id}: ${e?.message || e}\n`)
      return json(res, 500, { error: 'unreadable chain' })
    }
    if (!chain) return json(res, 404, { error: 'unknown session' })
    return json(res, 200, { chain })
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
  // Every project's document: the digest's fields with every effort, plus the
  // plan and backlog folds, the features, the specs and the lists the digest
  // only counts. The snapshot carries the digest instead, so a view showing a
  // project's contents asks for them, and asks again when that project's
  // changedAt moves. GET/HEAD-only and below the auth gate, like its siblings;
  // matched whole, ahead of every route beneath the same prefix.
  if (reading && path === '/api/projects') return json(res, 200, { projects: projectsDocs })
  // One page of a scanned plan's steps, or of a scanned task file's items,
  // with their history and diff labels. The digest carries counts and the
  // document carries the folds, so a view asks for the items of the one plan
  // or task file it opens. GET/HEAD-only and below the auth gate, like its
  // siblings. Both parameters must name what the scan already holds -- `wt` a
  // scanned worktree's path, `path` one of that worktree's rels -- so nothing
  // a browser sends is ever turned into a file to read.
  if (reading && path === '/api/projects/plan') return itemsPage(res, url, planRecord, 'plan')
  if (reading && path === '/api/projects/backlog') return itemsPage(res, url, backlogRecord, 'file')
  // One project's git graph, from the full scan. Not paged: it is already
  // bounded by commits per branch and by branches. A null graph is passed
  // through -- the project is not a repository, or git could not be asked --
  // because that is a different fact from a project this relay does not hold.
  if (reading && path === '/api/projects/graph') {
    const key = url.searchParams.get('key')
    const project = key ? projects.find((p) => p?.key === key) : null
    if (!project) return json(res, 404, { error: 'unknown project' })
    return json(res, 200, { gitGraph: project.gitGraph ?? null, changedAt: projectsStamp?.changedAt.get(key) ?? null })
  }
  // One project's document, by key. After every named projects route, so a
  // key can never shadow one. A key is a filesystem path, so it travels
  // encoded as ONE segment: the literal-slash test runs on the raw path, where
  // an encoded slash is still `%2F`, and only then is the key decoded. A
  // malformed escape is a 404, never a throw: this branch sits outside the
  // POST ladder's try, and an unhandled rejection would take the relay down.
  if (reading && path.startsWith(PROJECT_PREFIX) && !path.slice(PROJECT_PREFIX.length).includes('/')) {
    let key = ''
    try { key = decodeURIComponent(path.slice(PROJECT_PREFIX.length)) } catch { return json(res, 404, { error: 'unknown project' }) }
    const project = key ? projectsDocs.find((p) => p.key === key) : null
    if (!project) return json(res, 404, { error: 'unknown project' })
    return json(res, 200, { project })
  }
  // One thread in full. GET/HEAD-only and BELOW the auth gate, beside
  // /api/capture -- a method-agnostic `path.startsWith` here would intercept
  // the five POSTs further down that write, and answer them 200 without ever
  // reaching authed(). The id is one path segment: an id carrying a `/` is a
  // 404 rather than a lookup, so this prefix can never shadow a sibling route
  // added later.
  if (reading && path.startsWith(ORCH_THREAD_PREFIX)) {
    // A malformed escape is a 404, never a throw: this branch sits outside the
    // POST ladder's try, and an unhandled rejection would take the relay down.
    let id = ''
    try { id = decodeURIComponent(path.slice(ORCH_THREAD_PREFIX.length)) } catch { return json(res, 404, { error: 'unknown thread' }) }
    const t = id && !id.includes('/') ? orchThreads.get(id) : null
    if (!t) return json(res, 404, { error: 'unknown thread' })
    return json(res, 200, { thread: publicThread(t) })
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
      // Every peering control route, sub-routed inside peer-link.mjs, so this is one
      // block rather than a branch per route. authed() has already passed above.
      if (path.startsWith('/api/peer/')) {
        const out = await peerLink.local(path.slice('/api/peer/'.length), body)
        return json(res, out.status, out.json)
      }
      // The per-peer redaction switch. Only the local pane can reach this: the
      // peer listener has no route to it. Not under /api/peer/, whose every
      // POST the block above hands to the peering engine.
      if (path === '/api/peer-wire/redact') {
        const fp = typeof body.fingerprint === 'string' ? body.fingerprint : ''
        if (typeof body.redact !== 'boolean' || !/^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31}$/.test(fp)) {
          return json(res, 400, { error: 'a fingerprint and redact (true or false) are required' })
        }
        const redactOff = wireSettings.set(fp, body.redact)
        broadcast('peerwire', { digest: wireLog.digest(), redactOff })
        return json(res, 200, { ok: true, redactOff })
      }
      if (path === '/api/register') {
        // `forPeer` is never taken from a registering session: a tag comes only
        // from an apply the relay resolved. Dropped before the merge, so a tag
        // the record already carries survives a re-registration.
        const { forPeer: _forPeer, ...s } = body.session ?? {}
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
        // A restarted terminal continues its own topic chain. The refusal rules
        // are the claim inheritance's: never from a session that is still live,
        // and never when two stale chains share a name, because every unnamed
        // session in a worktree wears the same one. The store adds its own:
        // never over a chain this id already has, and never under a default
        // name. A failure here is logged and never fails the register, which has
        // already stored the session above. The save raises the `chain` event.
        if (chainIdOk(s.id)) {
          try {
            const inh = chains.inherit(
              { sessionId: s.id, ...chainMetaOf(sessions.get(s.id)) },
              new Set([...sessions.keys()].filter((id) => id !== s.id)),
            )
            if (inh.from) process.stdout.write(`chain: ${s.id} continues the chain of ${inh.from}\n`)
          } catch (e) {
            process.stderr.write(`chain inheritance failed for ${s.id}: ${e?.message || e}\n`)
          }
        }
        // A session the canvas spawned with a link parked on its ledger row
        // claims it here -- the child's id is not knowable anywhere else. The
        // match rules are resolvePendingLink's: the listing's sessionId when
        // it has one, otherwise the name under inheritPosition's two refusals.
        // The promise is attempted ONCE, kept or not: pendingLink is deleted
        // either way, so a source that has since expired cannot make every
        // later registration retry it.
        {
          // The STORED startedAt, which is the first one this relay heard for
          // this id -- a re-registration cannot make a session look younger.
          const claim = resolvePendingLink(world.canvas.spawnedBy,
            { id: s.id, name: s.name, startedAt: sessions.get(s.id)?.startedAt }, live(), now())
          if (claim.reason === 'ambiguous') {
            process.stderr.write(`canvas: a parked link matches more than one candidate for "${s.name}"; linking nothing\n`)
          } else if (claim.record) {
            const parked = claim.record.pendingLink
            delete claim.record.pendingLink
            worldDirty = true
            if (claim.reason !== 'expired') {
              const out = openChannel({ fromId: parked.from, toId: s.id, kind: 'brief', note: parked.note })
              if (!out.ok) process.stderr.write(`canvas: could not open the link parked from ${parked.from}: ${out.error}\n`)
            }
            canvasChanged()
          }
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
        broadcastSessions()
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
          // The path to this session's own transcript, as the band found it.
          // Sticky, and on the heartbeat rather than only in the register body:
          // the band registers before it has looked for the file, and a later
          // empty value must never erase a path already known.
          transcript: (typeof body.transcript === 'string' && body.transcript) || s.transcript || '',
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
        broadcastSessions()
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
      // Steering: pane -> one session, a chosen subset, or every session.
      // resolveTargets (fleet.mjs) owns which, and refuses the whole request
      // rather than fanning out partially -- see its header. enqueue() is a
      // push onto an in-memory Map and cannot fail, so once validation passes
      // there is no partial state and nothing to report per target.
      if (path === '/api/command') {
        // live(), not sessions.keys(): the Map still holds sessions whose TTL
        // has lapsed until live() prunes them, and its insertion order is not
        // the board's. `all` over expired ids would queue commands nobody will
        // ever drain and report them as queued.
        const t = resolveTargets({ body, ids: live().map((s) => s.id) })
        if (!t.ok) return json(res, t.status, { error: t.error })
        const forPeer = forPeerOf(body, path)
        const queued = t.ids.map((id) => {
          enqueue(id, { verb: body.verb, payload: body.payload ?? {} })
          // A prompt a peer's ask sent tags the session it lands on, unless
          // that session already works for someone: the origin wins.
          const rec = sessions.get(id)
          if (body.verb === 'prompt' && forPeer && rec && !rec.forPeer) rec.forPeer = forPeer
          return { id, name: rec?.name ?? '' }
        })
        // ONE entry for the fan-out, not one per target: the orchestrator
        // mines this log, and eight identical lines would read as eight
        // decisions. Captured for a single target too -- /api/request/create's
        // comment states the invariant that every applied action is captured,
        // and the orchestrator's `prompt` action applies through THIS route.
        try {
          const names = queued.map((q) => q.name || q.id.slice(0, 8))
          capture.append('command', '', {
            verb: String(body.verb ?? ''),
            label: String(body.label ?? '').slice(0, 60),
            scope: t.scope, n: queued.length,
            targets: names.length > 12 ? [...names.slice(0, 12), `+${names.length - 12} more`] : names,
            ...(forPeer ? { forPeer } : {}),
          })
        } catch {}
        return json(res, 200, { ok: true, scope: t.scope, n: queued.length, queued })
      }

      // ---- the pasteboard ----------------------------------------------------
      // Inside the ladder, below the gate. A route added ABOVE it re-opens the
      // hole where a POST reached a read-only branch that never checked the
      // caller, so an unauthenticated request was answered.
      const pushPasteboard = () => broadcast('pasteboard', { pasteboard: pasteboard.all() })

      if (path === '/api/pasteboard/create') {
        const r = pasteboard.add({
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
          sessionName: String(body.sessionName ?? ''),
          text: String(body.text ?? ''),
          title: typeof body.title === 'string' ? body.title : undefined,
          scope: body.scope === 'global' ? 'global' : 'session',
        })
        // The error is named, not generic: hud.tsx turns it into the sentence
        // the user reads where their prompt would have gone, and "the board is
        // full" and "that text is too long" want different next actions.
        if (!r.ok) return json(res, 400, { error: r.error })
        pushPasteboard()
        return json(res, 200, { ok: true, entry: r.entry, index: r.index, count: r.count })
      }

      if (path === '/api/pasteboard/delete') {
        if (!pasteboard.remove(String(body.id ?? ''))) return json(res, 404, { error: 'unknown entry' })
        pushPasteboard()
        return json(res, 200, { ok: true })
      }

      if (path === '/api/pasteboard/reorder') {
        const okRe = Array.isArray(body.ids)
          ? pasteboard.reorder(body.ids.map(String))
          : (body.dir === 'up' || body.dir === 'down')
            ? pasteboard.move(String(body.id ?? ''), body.dir)
            : null
        if (okRe === null) return json(res, 400, { error: 'ids, or id and dir, required' })
        if (!okRe) return json(res, 404, { error: 'unknown entry' })
        pushPasteboard()
        return json(res, 200, { ok: true })
      }

      // Reload an entry into a session's composer. The caller sends an ID, not
      // the text: the text then lives in exactly one place, a stale client
      // cannot enqueue arbitrary text under the pasteboard's name, and a large
      // entry never makes a round trip it does not need.
      if (path === '/api/pasteboard/fill') {
        const entry = pasteboard.get(String(body.id ?? ''))
        if (!entry) return json(res, 404, { error: 'unknown entry' })
        if (!sessions.has(body.targetId)) return json(res, 404, { error: 'unknown session' })
        enqueue(body.targetId, { verb: 'fill', payload: { text: entry.text } })
        return json(res, 200, { ok: true })
      }

      // ---- the topic chains ----------------------------------------------------
      // Inside the ladder, below the gate, for the pasteboard's reason: a route
      // added ABOVE the gate re-opens the hole where a POST reached a read-only
      // branch that never checked the caller, so an unauthenticated request was
      // answered. Every write raises the `chain` event from inside the store.
      if (path === '/api/chain/turn') {
        const id = typeof body.sessionId === 'string' ? body.sessionId : ''
        const rec = chainIdOk(id) ? sessions.get(id) : null
        if (!rec) return json(res, 404, { error: 'unknown session' })
        const t = body.turn
        if (!t || typeof t !== 'object' || Array.isArray(t) || typeof t.id !== 'string' || !t.id) {
          return json(res, 400, { error: 'turn.id required' })
        }
        const r = chains.turn(id, { ...t, at: Number.isFinite(t.at) ? t.at : undefined }, chainMetaOf(rec))
        if (!r.ok) return json(res, 400, { error: r.error })
        return json(res, 200, r)
      }
      if (path.startsWith(CHAIN_PREFIX)) {
        // `/api/chain/turn` above is ONE segment; everything here is two, so a
        // session whose id is literally "turn" cannot collide with it.
        const parts = path.slice(CHAIN_PREFIX.length).split('/')
        if (parts.length !== 2) return json(res, 404, { error: 'no such endpoint' })
        let id = ''
        try { id = decodeURIComponent(parts[0]) } catch { return json(res, 404, { error: 'unknown session' }) }
        // Checked AFTER decoding: `%2F` is a real slash by now.
        if (!chainIdOk(id)) return json(res, 404, { error: 'unknown session' })
        const verb = parts[1]
        if (verb === 'refine' || verb === 'rebuild') {
          // The two that need a binary. With none, 503 says this cannot work
          // on this relay at all, which a 400 would misreport as a fault in
          // the chain. A rebuild spawns nothing itself, but the pass that
          // follows it does.
          if (!CLAUDE_BIN) return json(res, 503, NO_CLAUDE)
          if (verb === 'refine' && chains.busy(id)) return json(res, 409, { error: 'already refining' })
          const r = await (verb === 'refine' ? chains.refine(id, { force: true }) : chains.rebuild(id))
          return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.error, ...(r.reason ? { reason: r.reason } : {}) })
        }
        // pin, merge, split and retitle need no binary: a chain can still be
        // reorganised by hand on a relay with no usable `claude`, which is the
        // point of the heuristic layer.
        const edit =
          verb === 'pin' ? () => chains.pin(id, body.blockId, !!body.pinned)
          : verb === 'merge' ? () => chains.merge(id, body.blockId, body.into === 'next' ? 'next' : 'prev')
          : verb === 'split' ? () => chains.split(id, body.blockId, body.atTurnId)
          : verb === 'retitle' ? () => chains.retitle(id, body.blockId, String(body.title ?? ''))
          : null
        if (!edit) return json(res, 404, { error: 'no such endpoint' })
        const r = edit()
        return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.error })
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
          broadcastSessions()
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
        if (cards.all()[s.name]?.favourite) broadcast('favourites', { favourites: favouritePayload() })
        try { capture.append('color', body.id, { name: s.name ?? '', color: r.color }) } catch {}
        broadcastSessions()
        return json(res, 200, { ok: true, color: r.color })
      }

      if (path === '/api/session/favourite') {
        const s = sessions.get(body.id)
        if (!s) return json(res, 404, { error: 'unknown session' })
        const r = cards.setFavourite(s.name, s.id, body.favourite)
        if (!r.ok) return json(res, 400, { error: r.error })
        try { capture.append('favourite', body.id, { name: s.name ?? '', favourite: r.favourite }) } catch {}
        broadcast('favourites', { favourites: favouritePayload() })
        return json(res, 200, { ok: true, favourite: r.favourite })
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
        // `body.note ?? ''`, exactly as before, which can never be null: this
        // route's contract is unchanged to the byte -- a link made here always
        // briefs. Wire-only is /api/spawn's `link.note: null`, and nothing
        // else reaches it (no String(), which would change a non-string).
        const out = openChannel({ fromId: body.from, toId: body.to, kind: body.kind ?? 'brief', note: body.note ?? '' })
        if (!out.ok) return json(res, 404, { error: out.error })
        return json(res, 200, { ok: true, link: out.link })
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

      // ---- session presets ------------------------------------------------
      // Every write answers the store's own refusal as a 400, broadcasts the
      // list on its own event, and -- only when the personas setting is on and
      // the persona set changed -- regenerates the personas plugin first, so
      // the answer already carries the plugin's new state.
      if (path === '/api/templates/create') {
        // `token` is how the plugin authenticates, in the body. The store keeps
        // unknown fields on purpose, so it is taken out before it could be
        // written into a hand-editable file.
        const { token: _token, ...fields } = body ?? {}
        const before = personaSignature(templates.all())
        const out = templates.create(fields)
        if (!out.ok) return json(res, 400, { error: out.error })
        await personasAfterWrite(before)
        templatesChanged()
        return json(res, 200, { ok: true, template: out.template, personas: personaState })
      }
      if (path === '/api/templates/update') {
        const before = personaSignature(templates.all())
        const out = templates.update(String(body.id ?? ''), body.patch)
        if (!out.ok) return json(res, 400, { error: out.error })
        await personasAfterWrite(before)
        templatesChanged()
        return json(res, 200, { ok: true, template: out.template, personas: personaState })
      }
      if (path === '/api/templates/delete') {
        const before = personaSignature(templates.all())
        if (!templates.remove(String(body.id ?? ''))) return json(res, 404, { error: 'no such template' })
        await personasAfterWrite(before)
        templatesChanged()
        return json(res, 200, { ok: true, personas: personaState })
      }
      if (path === '/api/templates/reorder') {
        // Order is not part of a persona, so a reorder never touches the plugin.
        if (!templates.reorder(body.ids)) return json(res, 400, { error: 'ids must name every template exactly once' })
        templatesChanged()
        return json(res, 200, { ok: true, items: templates.all() })
      }
      // `enabled` present switches the setting and brings the plugin in line
      // with it: on writes and validates it, off removes the directory (only
      // if it is this plugin's). Absent is the manual retry: regenerate when
      // the setting is on, otherwise only re-read the setting.
      if (path === '/api/templates/personas') {
        const has = !!body && Object.prototype.hasOwnProperty.call(body, 'enabled')
        if (has && typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be a boolean' })
        if (has) {
          const w = writeHudPersonas(body.enabled)
          if (!w.ok) return json(res, 409, { error: w.error })
          await syncPersonas(body.enabled ? templates.all() : [])
        } else if (personasEnabled()) {
          await syncPersonas(templates.all())
        } else {
          personaState = { ...personaState, enabled: false, count: countPersonas(AGENT_PLUGIN_DIR) }
        }
        templatesChanged()
        return json(res, 200, { ok: true, count: personaState.count, error: personaState.error, personas: personaState })
      }

      // A real `claude --bg -n <name> --permission-mode auto`
      // session in a CHOSEN directory. Not dispatch: no worktree, no branch,
      // no git. Everything that decides is in canvas.mjs and tested there;
      // this is the only place a real `claude` is ever run for the canvas.
      if (path === '/api/spawn') {
        if (!CLAUDE_BIN) return json(res, 503, NO_CLAUDE)
        // A well-formed templateId must name a stored preset; a malformed one
        // is left to spawnRequest, whose refusal says what is wrong with it.
        let preset = { agent: null, allowedTools: null, skipped: null }
        if (typeof body.templateId === 'string' && SLUG_RE.test(body.templateId)) {
          const tpl = templates.get(body.templateId)
          if (!tpl) return json(res, 400, { error: 'unknown template' })
          preset = templateArgv(tpl, { roster: DISPATCH_OPTIONS?.agents ?? [], personas: personasEnabled() })
        }
        const forPeer = forPeerOf(body, path)
        const out = await spawnSession({
          canvas: world.canvas, body, run: realRun, now, claudeBin: CLAUDE_BIN,
          // The port BOUND, never PORT: with SZG_PORT=0 they differ, and the
          // child would be told to register somewhere nothing is listening.
          relayPort: boundPort, relayToken: TOKEN, pluginDir: SPAWN_PLUGIN_DIR,
          // A link may only name a session THIS relay has registered: the
          // send-message it will queue is addressed through this map.
          hasSession: (id) => sessions.has(id),
          agent: preset.agent, allowedTools: preset.allowedTools,
          // An option, never a body field: resolved above from the ask log.
          forPeer,
        })
        if (out.changed) canvasChanged()
        if (out.status === 200) { try { capture.append('spawn', '', { name: out.body.name, cwd: out.body.cwd }) } catch {} }
        // The CLI's own answer to an unknown --agent is a warning nothing reads,
        // so a persona the roster lacks is reported here instead, for the pane.
        if (out.status === 200 && preset.skipped) {
          out.body.warning = 'persona ' + preset.skipped + ' is not in this CLI\'s agent roster yet — started without it'
        }
        return json(res, out.status, out.body)
      }

      // The architecture sweep: one fresh session, its own worktree, the
      // findings store as its brief. 503 with no capable binary, exactly as
      // /api/spawn answers. Gated on the board being quiet -- see
      // fleet.mjs's sweepGate -- and the gate's reason is the 409 body, so a
      // refused sweep always says why.
      if (path === '/api/sweep') {
        if (!CLAUDE_BIN) return json(res, 503, NO_CLAUDE)
        const vp = validateProject(body.project)
        if (!vp.ok || !vp.project) return json(res, 400, { error: vp.error || 'project is required' })
        // Resolved to the project's MAIN root: `git worktree add` runs there,
        // and a path resolving to no known project is refused rather than
        // guessed at (dispatch-badges.js's rule).
        const proj = projects.find((p) => p.mainRoot === vp.project || p.worktrees?.some((w) => w.path === vp.project))
        if (!proj) return json(res, 400, { error: `not a project this relay knows: ${vp.project}` })
        const override = body.override === true
        const since = lastSweepAt()
        const gate = sweepGate({
          sessions: live(), requests: requests.all(), spawnedBy: world.canvas.spawnedBy,
          now: now(), quietMs: SWEEP_QUIET, override,
        })
        const out = await runSweep({
          project: proj.mainRoot, findings: findings.all(), since, override, gate,
          run: realRun, now, exists: existsSync, date: new Date(now()).toISOString().slice(0, 10),
          writeFile: (p, text) => writeFileSync(p, text), mkdir: (p) => mkdirSync(p, { recursive: true }),
          // The port BOUND, never PORT, for the reason /api/spawn gives.
          claudeBin: CLAUDE_BIN, relayPort: boundPort, relayToken: TOKEN, pluginDir: SPAWN_PLUGIN_DIR,
          model: body.model ?? undefined, effort: body.effort ?? undefined,
        })
        if (out.status === 200) {
          try { capture.append('sweep', '', { ...out.body, project: proj.mainRoot }) } catch {}
        }
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
      const pushFanout = () => broadcast('fanout', { runs: fanoutStore.all() })
      const saveFanout = () => {
        try { fanoutStore.flush() } catch (e) { process.stderr.write(`fanout save failed: ${e.message}\n`) }
      }

      if (path === '/api/request/create') {
        // A title may be left blank when there is an ask to derive one from;
        // the derived title is marked automatic so a later refine may replace
        // it, and a typed one never is.
        const typedTitle = String(body.title ?? '').trim()
        const ask = String(body.ask ?? '')
        if (!typedTitle && !ask.trim()) return json(res, 400, { error: 'a title or an ask is required' })
        const title = typedTitle || proposeTitle(ask)
        const titleSource = typedTitle ? 'manual' : 'auto'
        // A project becomes a spawn's cwd and a `tmux new-window -c`. Refused
        // HERE, at creation, with the value named -- not left to fail later as
        // a `spawn ... ENOENT` that reads like a missing binary.
        const vp = validateProject(body.project)
        if (!vp.ok) return json(res, 400, { error: vp.error })
        // Refused here rather than dropped by the store's merge: a request that
        // silently lost its preset would dispatch as a plain session.
        const hasTemplate = body.templateId != null && body.templateId !== ''
        if (hasTemplate && (typeof body.templateId !== 'string' || !SLUG_RE.test(body.templateId))) {
          return json(res, 400, { error: 'templateId must be a slug' })
        }
        if (hasTemplate && !templates.get(body.templateId)) return json(res, 400, { error: 'unknown template' })
        // `body.fanout` is never passed: a fan-out group is minted by
        // /api/fanout/accept from a real run, and a browser must not be able
        // to forge one onto a hand-made request. `forPeer` is the same: the
        // relay resolves it from the ask log, never from the body.
        const forPeer = forPeerOf(body, path)
        const r = requests.create({
          title, titleSource, project: vp.project,
          ask, brief: body.brief ?? null,
          relatesTo: body.relatesTo,
          model: body.model, effort: body.effort,
          templateId: hasTemplate ? body.templateId : undefined,
          forPeer,
        })
        // Captured because this is now an ACTION apply path (`dispatch`
        // kind), and the invariant is that every applied action is captured.
        // A hand-created request goes through the same route and is captured
        // identically -- the log records what happened, not who asked.
        try { capture.append('request', '', { title: r.title, project: r.project }) } catch {}
        pushDispatch()
        json(res, 200, { ok: true, request: r })
        // After the answer, never before: the refine is a model call that
        // takes seconds, and creating a request must not wait on it.
        if (r.titleSource === 'auto') {
          void scoper.proposeAndRefine(r.id)
            .catch((e) => process.stderr.write(`title refine failed: ${e?.stack || e}\n`))
        }
        return
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
        // `relatesTo` is shape-checked by the store, which keeps the previous
        // value when a patch's reference is malformed.
        for (const k of ['title', 'ask', 'project', 'brief', 'relatesTo']) if (k in p) patch[k] = p[k]
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
        // Before the removal: endScoping reads the live session synchronously,
        // before its first await, so the stop still reaches a session whose
        // request is about to disappear. It resolves quietly for an unknown id.
        void scoper.endScoping(body.id, 'deleted')
          .catch((e) => process.stderr.write(`scoping end failed: ${e?.stack || e}\n`))
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
        let r
        try {
          r = requests.transition(body.id, String(body.to), {})
        } catch (e) {
          return json(res, 409, { error: e.message })
        }
        pushDispatch()
        // A request that is banked, cancelled or failed has no more use for
        // its scoping conversation, and a live one would otherwise idle until
        // the age ceiling. Not awaited: `claude stop` is not this answer.
        const to = String(body.to)
        if (to === 'queued' || to === 'cancelled' || to === 'failed') {
          void scoper.endScoping(r.id, to === 'queued' ? 'banked' : to)
            .catch((e) => process.stderr.write(`scoping end failed: ${e?.stack || e}\n`))
        }
        return json(res, 200, { ok: true, request: r })
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
        // A blank turn is refused inside startScoping, which alone knows that a
        // restart may be sent with no text.
        const out = await scoper.startScoping(r.id, String(body.text ?? ''), r.project || process.cwd(),
          { restart: body.restart === true })
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

      // Ends a live scoping conversation by hand: `claude stop`, and the
      // session is marked ended with the reason.
      if (path === '/api/scope/end') {
        const r = requests.get(body.id)
        if (!r) return json(res, 404, { error: 'unknown request' })
        await scoper.endScoping(r.id, 'ended by hand')
        return json(res, 200, { ok: true })
      }

      // ---- fan-out -------------------------------------------------------------
      // One rambling ask, split by one headless call into drafts a person then
      // reshapes, accepts as ordinary requests, or discards. One run at a time.
      if (path === '/api/fanout') {
        const ask = String(body.ask ?? '')
        if (!ask.trim()) return json(res, 400, { error: 'ask required' })
        if (ask.length > FANOUT_ASK_MAX) {
          return json(res, 400, { error: `ask is longer than ${FANOUT_ASK_MAX} characters` })
        }
        if (!CLAUDE_BIN) return json(res, 503, NO_CLAUDE)
        const set = fanoutProjects(projects, { check: validateProject })
        const out = fanoutStore.start({ ask, projects: set })
        if (!out.ok) return json(res, 409, { error: out.error })
        saveFanout()
        pushFanout()
        // Not awaited: the split takes as long as the model does, and the run's
        // own state carries the result. fanout() resolves rather than rejects.
        void scoper.fanout(out.run.id, out.run.ask, out.run.projects)
          .then(() => { saveFanout(); pushFanout() })
          .catch((e) => process.stderr.write(`fanout failed: ${e?.stack || e}\n`))
        return json(res, 200, { ok: true, run: out.run })
      }

      if (path === '/api/fanout/assign') {
        const run = fanoutStore.get(String(body.runId ?? ''))
        if (!run) return json(res, 404, { error: 'unknown run' })
        if (run.state !== 'ready') return json(res, 409, { error: `run is ${run.state}` })
        const next = fanoutStore.assign(run.id, String(body.draftId), Number(body.index), String(body.mode))
        if (!next) return json(res, 400, { error: 'bad assignment' })
        saveFanout()
        pushFanout()
        return json(res, 200, { ok: true, run: next })
      }

      if (path === '/api/fanout/accept') {
        const run = fanoutStore.get(String(body.runId ?? ''))
        if (!run) return json(res, 404, { error: 'unknown run' })
        if (run.state !== 'ready') return json(res, 409, { error: `run is ${run.state}` })
        const ids = Array.isArray(body.draftIds) ? body.draftIds.map(String) : []
        const known = new Set(run.drafts.map((d) => d.id))
        if (!ids.length || !ids.every((id) => known.has(id))) {
          return json(res, 400, { error: 'draftIds must name drafts on this run' })
        }
        // In run order, not click order: `n` is a draft's place in the split.
        const wanted = new Set(ids)
        const accepted = run.drafts.filter((d) => wanted.has(d.id))
        const of = accepted.length
        const made = accepted.map((draft, i) => {
          const entry = run.projects.find((p) => p.key && p.key === draft.projectKey)
          // A root that stopped being a directory since the split becomes no
          // project rather than a request that fails later on its cwd.
          const vp = entry ? validateProject(entry.root) : null
          const project = vp?.ok ? vp.project : ''
          const title = draft.title || proposeTitle(draft.ask)
          const r = requests.create({
            title, titleSource: 'auto', project, ask: draft.ask,
            brief: { ...requests.emptyBrief(), goal: draft.goal ?? '', openQuestions: draft.openQuestions ?? [] },
            fanout: { id: run.id, n: i + 1, of },
          })
          try { capture.append('request', '', { title: r.title, project: r.project }) } catch {}
          return r
        })
        fanoutStore.finish(run.id, 'accepted')
        try { requests.flush() } catch (e) { process.stderr.write(`dispatch save failed: ${e.message}\n`) }
        saveFanout()
        pushDispatch()
        pushFanout()
        return json(res, 200, { ok: true, requests: made })
      }

      if (path === '/api/fanout/discard') {
        const run = fanoutStore.get(String(body.runId ?? ''))
        if (!run) return json(res, 404, { error: 'unknown run' })
        if (run.state !== 'running' && run.state !== 'ready') return json(res, 409, { error: `run is ${run.state}` })
        // The child first, so a split that lands after the discard has nothing
        // left to write into; fanout() also leaves a no-longer-running run alone.
        if (run.state === 'running') scoper.kill('fanout:' + run.id)
        fanoutStore.finish(run.id, 'discarded')
        saveFanout()
        pushFanout()
        return json(res, 200, { ok: true, run })
      }

      // ---- take-over ---------------------------------------------------------
      // Opens a real interactive session in a new tmux window. Reports success
      // only on a window tmux actually created; the pane always also shows the
      // command, so this failing costs nothing.
      if (path === '/api/takeover') {
        const r = requests.get(body.id)
        if (!r) return json(res, 404, { error: 'unknown request' })
        const isSession = body.kind === 'session'
        // A scoping conversation is taken over one of two ways. A live `--bg`
        // scoping session is ATTACHED: the terminal joins the very session the
        // pane talks to, so turns from either side reach the same conversation.
        // An older record that only carries a `sessionId` from a one-shot call
        // has no live session to join, so it is resumed into a new process.
        const scopeSession = !isSession && r.scoping?.session && typeof r.scoping.session === 'object'
          && !r.scoping.session.endedAt && r.scoping.session.shortId ? r.scoping.session : null
        const legacyId = !isSession && !scopeSession ? r.scoping?.sessionId : null
        const target = isSession ? r.session?.shortId : (scopeSession?.shortId ?? legacyId)
        if (!target) return json(res, 409, { error: 'nothing to take over yet' })
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
        const inner = legacyId
          ? [CLAUDE_BIN, '--resume', String(target)]
          : [CLAUDE_BIN, 'attach', String(target)]
        const name = `szg-${r.slug}`.slice(0, 60)
        const out = await new Promise((resolve) => {
          execFile(TMUX_BIN, ['new-window', '-d', '-n', name, '-c', cwd, ...inner],
            { timeout: 6000 }, (err, stdout, stderr) => resolve({ err, stderr: String(stderr || '') }))
        })
        if (out.err) {
          const why = out.stderr.trim().slice(0, 200) || 'tmux is not running'
          return json(res, 409, { error: `${why} — use the command shown instead`, command: inner.join(' ') })
        }
        const cur = requests.get(r.id)
        if (scopeSession && cur?.scoping?.session) {
          // Attaching forks nothing, so nothing is marked as continued
          // elsewhere; the session only records when and where it was joined.
          requests.update(r.id, {
            scoping: { ...cur.scoping, session: { ...cur.scoping.session, attachedAt: now(), window: name } },
          })
          pushDispatch()
        } else if (legacyId && cur?.scoping) {
          // Resuming DOES fork: from here on terminal turns never reach the
          // relay and pane turns never reach the terminal. Recorded so the
          // panel can say so and stop offering turns that would go nowhere.
          requests.update(r.id, { scoping: { ...cur.scoping, continuedInTerminal: { at: now(), window: name } } })
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
        // Recognised, and still refused here: a resume entry's episode, reason
        // and auto flag are facts the relay establishes, so one supplied by a
        // caller would record a decision nobody made. The arm route creates
        // them; `prompt` is the kind for a message you wrote yourself.
        if (kind === 'resume') {
          return json(res, 400, {
            error: "kind 'resume' is created by the relay when a usage limit resets; use 'prompt' to send your own text, or arm resume on the usage panel",
          })
        }
        // The store's create() also guards window/kind (defence in depth),
        // but validating here first means a bad request gets a 400 naming
        // the actual problem rather than a 500 from a thrown error.
        if (!['fiveHour', 'sevenDay'].includes(window)) {
          return json(res, 400, { error: 'window must be five_hour or seven_day (fiveHour/sevenDay also accepted)' })
        }
        if (!['prompt', 'implement', 'plan', 'spawn'].includes(kind)) return json(res, 400, { error: 'kind must be prompt, implement, plan or spawn' })
        // Written by the relay alone. Without this, a duplicate of a fired
        // entry would carry its predecessor's spawn record and the panel
        // would show a night run linked to a session it never started.
        const clean = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : {}
        delete clean.auto; delete clean.spawn; delete clean.skipped; delete clean.stoppedAt; delete clean.stopReason
        delete clean.episode; delete clean.reason; delete clean.byHand
        if (clean.budgetUsd !== undefined) {
          const b = Number(clean.budgetUsd)
          clean.budgetUsd = Number.isFinite(b) && b > 0 && b <= 500 ? b : afterReset.settings().night.budgetUsd
        }
        if (kind === 'plan') {
          if (typeof target !== 'string' || !target.trim()) {
            return json(res, 400, { error: "kind 'plan' needs target: the plan's path inside its project", field: 'target' })
          }
          if (typeof clean.mainRoot !== 'string' || !clean.mainRoot.trim()) {
            return json(res, 400, { error: "kind 'plan' needs payload.mainRoot: the project's main checkout", field: 'payload.mainRoot' })
          }
        }
        if (kind === 'spawn') {
          // Resolved and checked NOW, not at three in the morning: a directory
          // that has moved by then is a failure with a reason on the row, but
          // a relative path typed into the form is a mistake worth refusing
          // while the person is still looking at it.
          const v = validateCwd(clean.cwd)
          if (!v.ok) return json(res, 400, { error: v.error, field: 'payload.cwd' })
          clean.cwd = v.cwd
          if (typeof clean.prompt !== 'string' || !clean.prompt.trim()) {
            return json(res, 400, { error: "kind 'spawn' needs payload.prompt", field: 'payload.prompt' })
          }
        }
        // Armed against the CURRENT reading's boundary for this window. A
        // reading that is stale or missing that window gets no armed
        // boundary at all -- the same "hand-edited" fallback dueEntries
        // documents for, reached honestly here instead of guessed at.
        const armedResetsAt = !currentUsage.stale ? (currentUsage[window]?.resetsAt ?? null) : null
        const entry = afterReset.create({ window, kind, target, payload: clean, armedResetsAt })
        // "Fire now" is a second CALLER of the scheduler's own function,
        // never a second code path.
        if (body.now === true) await fireEntry(entry)
        broadcast('usage', usagePayload())
        return json(res, 200, { ok: true, entry: afterReset.get(entry.id) })
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

      // The night policy. Only the known fields are passed on: the body
      // always carries `token` too, and setNight refuses a key it does not
      // know. A rejected field names itself and nothing is persisted.
      if (path === '/api/night') {
        const { enabled, start, end, budgetUsd, maxHours } = body
        const r = afterReset.setNight({ enabled, start, end, budgetUsd, maxHours })
        if (!r.ok) return json(res, 400, { error: r.error, field: r.field })
        broadcast('usage', usagePayload())
        return json(res, 200, { ok: true, night: nightPayload() })
      }

      // The standing resume arm, and one immediate resume. Both are POSTs
      // inside this block for the reason every other write here is: the authed
      // check and the try/catch that turns a throw into a 500 both live here,
      // and a route outside inherits neither.
      if (path === '/api/resume') {
        const { armed, windows, exclude, include, by } = body
        const r = afterReset.setResume({ armed, windows, exclude, include, by })
        if (!r.ok) return json(res, 400, { error: r.error, field: r.field })
        broadcast('usage', usagePayload())
        return json(res, 200, { ok: true, resume: resumePayload() })
      }

      // "Resume this one now": the entry is still created and still fired by
      // fireEntry, so a hand-picked resume and a scheduled one are one code
      // path and cannot drift.
      if (path === '/api/resume/fire') {
        const id = String(body.id ?? '')
        if (!id) return json(res, 400, { error: 'id required' })
        if (!sessions.has(id)) return json(res, 400, { error: 'that session is not registered with this relay' })
        const r = afterReset.settings().resume
        const episode = r.episode ?? (body.force === true
          ? { window: 'fiveHour', resetsAt: currentUsage.fiveHour?.resetsAt ?? 0, spentAt: now(), pct: 0 }
          : null)
        if (!episode) return json(res, 400, { error: 'no limit episode is open' })
        const already = afterReset.all().some(
          (e) => e.kind === 'resume' && e.target === id && e.armedResetsAt === episode.resetsAt)
        if (already) return json(res, 400, { error: 'that session has already been resumed for this reset' })
        const entry = afterReset.create({
          window: episode.window, kind: 'resume', target: id, armedResetsAt: episode.resetsAt,
          payload: { byHand: true, reason: 'resumed by hand', sessionName: sessions.get(id)?.name ?? '', episode },
        })
        await fireEntry(entry)
        broadcast('usage', usagePayload())
        return json(res, 200, { ok: true, entry: afterReset.get(entry.id) })
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
        const threadId = typeof body.threadId === 'string' && body.threadId ? body.threadId : null
        // Optional and shape-checked: it reaches a bundle builder, so a
        // caller-supplied object is narrowed to the one field that is read.
        const scope = body.scope && typeof body.scope.project === 'string'
          ? { project: body.scope.project }
          : null
        const out = await orchestrator.ask(text, { threadId, scope })
        // An ask moves the headers too: the auto-title, the turn count, and a
        // thread created when none was current.
        if (out.ok) threadsChanged()
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
        // The SAME bounded read snapshot() uses, so the event and the snapshot
        // field can never drift into different shapes -- usagePayload()'s rule.
        // The Findings panel is this event's first listener, which is why
        // narrowing it costs no existing reader anything.
        broadcast('findings', { findings: findings.read({ limit: FINDINGS_IN_SNAPSHOT }) })
        return json(res, 200, { ok: true, finding: rec })
      }

      // A call the band made through the plugin API, which reports no usage:
      // the band sends estimated tokens and no cost. `t` is the ledger's to stamp.
      // A body with no kind is refused rather than recorded: the store would
      // file it as an empty `other` call, a phantom row in a figure read as
      // honest. An unknown but non-empty kind still records, as `other`.
      if (path === '/api/spend') {
        const isRecord = body !== null && typeof body === 'object' && !Array.isArray(body) &&
          typeof body.kind === 'string' && body.kind !== ''
        if (!isRecord) return json(res, 400, { error: 'a spend record must be an object with a kind' })
        const { token: _token, ...rest } = body
        if (!spend.record(rest)) return json(res, 400, { error: 'a spend record must be an object with a kind' })
        return json(res, 200, { ok: true })
      }

      if (path === '/api/findings/delete') {
        if (!findings.remove(String(body.id ?? ''))) return json(res, 404, { error: 'unknown finding' })
        // The SAME bounded read snapshot() uses, so the event and the snapshot
        // field can never drift into different shapes -- usagePayload()'s rule.
        // The Findings panel is this event's first listener, which is why
        // narrowing it costs no existing reader anything.
        broadcast('findings', { findings: findings.read({ limit: FINDINGS_IN_SNAPSHOT }) })
        return json(res, 200, { ok: true })
      }

      // ---- sandbox ------------------------------------------------------
      // `cycle` and `mark` are alternatives: the cycle's order lives in the
      // store so two panes advancing at once cannot disagree about what
      // comes next. A refused mark writes nothing at all -- an entry created
      // and then rejected would leave a component in the ledger nobody judged.
      if (path === '/api/sandbox/mark') {
        const component = String(body.component ?? '')
        if (!component) return json(res, 400, { error: 'component required' })
        const out = sandbox.mark(component, { mark: body.mark, cycle: body.cycle === true })
        if (!out.ok) return json(res, 400, { error: out.error })
        broadcast('sandbox', { sandbox: sandbox.all() })
        return json(res, 200, { ok: true, entry: out.entry })
      }

      if (path === '/api/sandbox/params') {
        const component = String(body.component ?? '')
        if (!component) return json(res, 400, { error: 'component required' })
        const out = sandbox.params(component, body.params)
        if (!out.ok) return json(res, 400, { error: out.error })
        broadcast('sandbox', { sandbox: sandbox.all() })
        return json(res, 200, { ok: true, entry: out.entry })
      }

      // ---- the proposals queue -------------------------------------------
      // Proposals are AUTHORITATIVE and nothing is ever removed, so there is
      // no delete branch here to match findings'.
      const pushSkills = () => broadcast('skillsQueue', {
        proposals: skills.read({ limit: PROPOSALS_IN_SNAPSHOT }),
      })

      if (path === '/api/skills/propose') {
        const out = skills.ingest(body, { source: body.source === 'pass' ? 'pass' : 'session' })
        if (!out.ok) return json(res, /rated proposals/.test(out.error) ? 409 : 400, { error: out.error })
        try { capture.append('proposal', out.proposal.sessions?.[0] ?? '', { title: out.proposal.title, merged: out.merged }) } catch {}
        pushSkills()
        return json(res, 200, { ok: true, proposal: out.proposal, merged: out.merged })
      }

      if (path === '/api/skills/mark') {
        const out = skills.mark(String(body.id ?? ''), { mark: body.mark, cycle: body.cycle })
        // Narrower than /unknown/: the store's OTHER refusal, an unrecognised
        // mark value, is also worded "unknown mark: <value>" and must stay a
        // 400, not a 404 that reads as "no such proposal".
        if (!out.ok) return json(res, /unknown proposal/.test(out.error) ? 404 : 400, { error: out.error })
        try { capture.append('proposal-mark', '', { id: out.proposal.id, mark: out.proposal.mark }) } catch {}
        pushSkills()
        return json(res, 200, { ok: true, proposal: out.proposal })
      }

      if (path === '/api/skills/prep') {
        const p = skills.get(String(body.id ?? ''))
        if (!p) return json(res, 404, { error: 'unknown proposal' })
        if (p.requestId) return json(res, 409, { error: `already prepped as ${p.requestId}` })
        // Refused HERE, with the value named, for the reason
        // /api/request/create gives: a project becomes a spawn's cwd.
        const vp = validateProject(body.project)
        if (!vp.ok) return json(res, 400, { error: vp.error })
        const { title, ask, brief } = prepBrief(p)
        const r = requests.create({ title, project: vp.project, ask, brief })
        // Written now, not on the 4 s tick: the proposal is about to point at
        // this request, and prep refuses twice, so a request lost to a crash
        // would leave the proposal unpreppable forever.
        requests.flush()
        const out = skills.prep(p.id, { requestId: r.id })
        if (!out.ok) return json(res, 409, { error: out.error })
        let request = r
        if (body.queue === true) {
          try { request = requests.transition(r.id, 'queued', {}); requests.flush() }
          catch (e) { return json(res, 409, { error: e.message }) }
        }
        try { capture.append('proposal-prep', '', { id: p.id, requestId: r.id, queued: body.queue === true }) } catch {}
        pushSkills()
        pushDispatch()
        return json(res, 200, { ok: true, proposal: out.proposal, request })
      }

      if (path === '/api/skills/pass') {
        const out = await orchestrator.patternPass({ override: body.override === true })
        if (!out.ok) return json(res, out.code ?? 409, { error: out.error })
        pushSkills()
        return json(res, 200, out)
      }

      if (path === '/api/orchestrator/clear') {
        const out = orchestrator.clear()
        threadsChanged()
        return json(res, 200, out.thread ? { ...out, thread: publicThread(out.thread) } : out)
      }

      // Every one of these broadcasts the new header list afterwards, so a
      // second pane follows along. A no-op rename broadcasts too: the cost is
      // one small frame and the alternative is a divergence nobody can see.
      if (path === '/api/orchestrator/thread/new') {
        const t = orchThreads.create({ title: typeof body.title === 'string' ? body.title : '' })
        threadsChanged()
        return json(res, 200, { ok: true, thread: publicThread(t) })
      }

      if (path === '/api/orchestrator/thread/select') {
        const t = orchThreads.select(String(body.id ?? ''))
        if (!t) return json(res, 404, { error: 'unknown thread' })
        threadsChanged()
        return json(res, 200, { ok: true, thread: publicThread(t) })
      }

      if (path === '/api/orchestrator/thread/pin') {
        const t = orchThreads.setPinned(String(body.id ?? ''), !!body.pinned)
        if (!t) return json(res, 404, { error: 'unknown thread' })
        threadsChanged()
        return json(res, 200, { ok: true, thread: publicThread(t) })
      }

      if (path === '/api/orchestrator/thread/rename') {
        if (typeof body.title !== 'string') return json(res, 400, { error: 'title must be a string' })
        const t = orchThreads.rename(String(body.id ?? ''), body.title)
        if (!t) return json(res, 404, { error: 'unknown thread' })
        threadsChanged()
        return json(res, 200, { ok: true, thread: publicThread(t) })
      }

      if (path === '/api/orchestrator/thread/delete') {
        const id = String(body.id ?? '')
        // Refused mid-answer: the turn in flight is about to append to this
        // thread, and silently appending to one that no longer exists is the
        // confident wrong answer this codebase refuses everywhere else.
        if (orchestrator.activeThreadId?.() === id) return json(res, 409, { error: 'that conversation is mid-answer' })
        if (!orchThreads.remove(id)) return json(res, 404, { error: 'unknown thread' })
        threadsChanged()
        return json(res, 200, { ok: true })
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

      // ---- session space ------------------------------------------------------
      // Inside the ladder, below the gate. A route added ABOVE it re-opens the
      // hole where a POST reached a read-only branch that never checked the
      // caller, so an unauthenticated request was answered.
      //
      // A groups file that would not parse blocks every write here with 409,
      // rather than a fresh store being written over the only copy of it.
      const groupsBroken = () =>
        json(res, 409, { error: `${GROUPS_PATH} would not parse; refusing to write until it is fixed by hand` })

      if (path === '/api/groups/save') {
        if (groupsStore.broken()) return groupsBroken()
        const g = body.group
        if (!g || typeof g !== 'object' || Array.isArray(g)) return json(res, 400, { error: 'group must be an object' })
        const r = groupsStore.save(g)
        if (!r.ok) return json(res, 400, { error: r.error })
        pushGroups()
        return json(res, 200, { ok: true, group: r.group })
      }

      if (path === '/api/groups/delete') {
        if (groupsStore.broken()) return groupsBroken()
        if (!groupsStore.remove(String(body.id ?? ''))) return json(res, 404, { error: 'unknown group' })
        pushGroups()
        return json(res, 200, { ok: true })
      }

      // Re-apply a bucket. What it does is decided by the STORED bucket's kind,
      // never by anything in the body: the body only names what it acts on.
      if (path === '/api/groups/apply') {
        if (groupsStore.broken()) return groupsBroken()
        const group = groupsStore.get(String(body.id ?? ''))
        if (!group) return json(res, 404, { error: 'unknown group' })

        // Every successful apply ends here: the timestamp, one frame, and ONE
        // capture line however many targets it reached. A failure to record
        // the timestamp is logged, not answered: the apply itself has happened.
        const finish = ({ applied, skipped = [], window }) => {
          try { groupsStore.markApplied(group.id) } catch (e) { process.stderr.write(`groups: recording an apply failed: ${e.message}\n`) }
          pushGroups()
          try {
            const names = applied.map((a) => a.name || a.id)
            capture.append('group-apply', '', {
              kind: group.kind, group: group.name, n: applied.length,
              targets: names.length > 12 ? [...names.slice(0, 12), `+${names.length - 12} more`] : names,
            })
          } catch {}
          return json(res, 200, { ok: true, kind: group.kind, applied, skipped, ...(window !== undefined ? { window } : {}) })
        }

        if (group.kind === 'prompt' || group.kind === 'files') {
          let text = group.text
          if (group.kind === 'prompt' && !text) return json(res, 400, { error: `${group.name} has no text to send` })
          if (group.kind === 'files') {
            if (!group.paths.length) return json(res, 400, { error: `${group.name} has no paths to name` })
            const norm = normalizePaths(group.paths, { home: homedir(), realpath: realpathSync, exists: pathExists })
            if (!norm.ok) return json(res, 400, { error: norm.error })
            text = filesPrompt(norm.paths)
          }
          // resolveTargets refuses the whole request on one unknown id, before
          // the first enqueue, so there is never a partial fan-out to report.
          const t = resolveTargets({ body: { targetIds: body.targetIds }, ids: live().map((s) => s.id) })
          if (!t.ok) return json(res, t.status, { error: t.error })
          const applied = t.ids.map((id) => {
            enqueue(id, { verb: 'prompt', payload: { text } })
            return { id, name: sessions.get(id)?.name ?? '' }
          })
          return finish({ applied })
        }

        if (group.kind === 'tmux-group') {
          if (!Array.isArray(body.panes) || body.panes.length === 0) {
            return json(res, 400, { error: '`panes` must be a non-empty array of pane ids' })
          }
          if (body.panes.length > MEMBERS_MAX) return json(res, 400, { error: `too many panes (max ${MEMBERS_MAX})` })
          // A FRESH listing, never the held one: a pane id reaches an argv only
          // if tmux listed it inside this same request, and the destination
          // session and its working directory come from that listing too.
          const known = await readTmuxPanes()
          const plan = groupPlan({ want: body.panes, known, name: group.tmuxName || 'szg-group' })
          const out = await runGroup({ plan, run: realRun, tmuxBin: TMUX_BIN })
          // Whatever ran may have moved panes, so the held listing is stale.
          tmuxCache = { at: 0, panes: [] }
          if (!out.ok) return json(res, 502, { ok: false, kind: group.kind, error: out.error, skipped: out.skipped })
          const byPane = new Map(known.map((p) => [p.pane, p]))
          return finish({
            applied: out.joined.map((id) => ({ id, name: byPane.get(id)?.target ?? id })),
            skipped: out.skipped,
            window: out.window,
          })
        }

        if (group.kind === 'together') {
          const t = resolveTargets({ body: { targetIds: body.targetIds }, ids: live().map((s) => s.id) })
          if (!t.ok) return json(res, t.status, { error: t.error })
          const r = groupsStore.save({ id: group.id, members: t.ids.map((id) => ({ id, name: sessions.get(id)?.name ?? '' })) })
          if (!r.ok) return json(res, 400, { error: r.error })
          return finish({ applied: r.group.members })
        }

        return json(res, 400, { error: `a ${group.kind} group cannot be applied` })
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

// Expire dead sessions so the board does not accumulate ghosts. Compared
// against the ids last BROADCAST, not against sessions.size around live():
// rescan() prunes on its own 4 s cadence, so the size was already current by
// the time this ran and the board emptying was never announced.
setInterval(() => {
  if (idsKey(live()) !== lastSessionIds) broadcastSessions()
}, SWEEP_MS).unref?.()


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
    // The relay's own readers always get the newest scan. The change check is
    // on the digest the panes are sent, never on the full scan: the task
    // register keeps a bounded number of entries, a board of a dozen worktrees
    // carries several times that, and every pass re-creates the evicted ones
    // with a fresh firstSeen -- so the full scan differed on every pass and the
    // whole payload was re-sent every scan interval. The documents are stamped
    // first and the stamp rides the digest, so a document that changed without
    // moving a count -- a step edited, which moves its plan copy's mtimeMs --
    // still changes the digest, and a pane showing that project gets the frame
    // that tells it to refetch. The documents are replaced every pass, since
    // the routes must answer from the newest scan whether or not a frame goes.
    projects = next
    const at = now()
    const docs = documentProjects(next, { now: at })
    projectsStamp = stampChanged(projectsStamp, docs, at)
    const stamps = projectsStamp.changedAt
    for (const d of docs) d.changedAt = stamps.get(d.key) ?? null
    projectsDocs = docs
    const digest = digestProjects(next, { now: at }).map((d) => ({ ...d, changedAt: stamps.get(d.key) ?? null }))
    const json = JSON.stringify(digest)
    if (json === projectsJson) return
    projectsJson = json
    projectsDigest = digest
    broadcast('projects', projectsDigest)
  } catch (e) {
    process.stderr.write('projects scan failed: ' + e.message + '\n')
  } finally {
    scanning = false
  }
}
setInterval(rescan, SCAN_INTERVAL_MS).unref?.()
rescan()