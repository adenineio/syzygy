// The session canvas's relay-side logic: positions by session id, the spawn
// ledger, recents, and the two things the canvas can DO -- start a real
// `claude --bg --permission-mode auto` session, and attach to one in tmux.
//
// Everything that decides is pure and exported; the two things that act take
// an injected `run` so the harness never shells out. Same split as
// dispatch.mjs, and it imports parseBackgrounded from there rather than
// re-parsing the one line `claude --bg` prints.
//
// The LIVE COUNT fails CLOSED. Nothing refuses a spawn: the count on the tab
// is the whole guard, so it has to be right. A spawn counts from the moment it is requested and keeps counting
// until a SUCCESSFUL `claude agents --json` listing rules on it -- for at most
// NULL_STATE_MAX_MS, the same day-long window after which the relay's poller
// stops asking. A listing that keeps failing therefore leaves the count high,
// not at a silent zero that would hide sessions nobody is counting.
//
// Position inheritance follows claims-inherit.mjs's two rules exactly -- read
// that file's header.

import { execFile } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, basename, join } from 'node:path'
import { parseBackgrounded } from './dispatch.mjs'
// A cycle (requests.mjs imports validateCwd from here), and a safe one:
// SLUG_RE is read only inside spawnRequest's body, never while this module
// is still evaluating.
import { SLUG_RE } from './requests.mjs'
import { sanitizeForPeer } from './peer.mjs'

// How long a SUCCESSFUL listing may omit a record before settleSpawns infers
// `missing` from that absence. This is the constant's ONE meaning: it is not
// what stops a never-listed record counting -- see NULL_STATE_MAX_MS.
export const SPAWN_GRACE_MS = 60_000
// Fail closed. A record no successful listing has ever ruled on keeps counting
// for this long -- the point at which relay.mjs's poller stops asking about
// it, so nothing will ever rule on it either. Before this, the grace window
// did that job, and a `claude agents` call that failed every time silently
// stopped counting every spawn 60 s after it started: the count fell to zero
// exactly when the relay had lost track of what was running.
export const NULL_STATE_MAX_MS = 24 * 3600_000
// How far a node may be dragged or dropped, at both ends. Far beyond any real
// board, and far short of a coordinate that survives a round trip through JSON
// as scientific notation. relay.mjs's clampPos is built from this.
export const COORD_MAX = 100_000
export const SPAWNED_KEEP = 50
export const RECENTS_MAX = 12
export const NODE_MAX_AGE_MS = 7 * 24 * 3600_000
// A pending node is a promise the spawn made and may never keep. It gets its
// own, much shorter limit rather than immortality: if no listing ever hands its
// spawn a sessionId, movePending can never claim it, and once the record falls
// off slice(-SPAWNED_KEEP) nothing can -- a permanent ghost on the board.
export const PENDING_MAX_AGE_MS = 24 * 3600_000
// What stops a record counting toward the live count.
export const SETTLED = new Set(['done', 'failed', 'stopped', 'missing'])
// What stops settleSpawns re-folding a record. Strictly smaller than SETTLED:
// done/failed/stopped are things a listing OBSERVED, so they are final, but
// `missing` is only ever INFERRED from absence (see settleSpawns). One listing
// that races a live session would otherwise mark it dead for good, drop it out
// of the count, and -- since a latched record never gains a sessionId --
// strand its pending node forever. A later listing that names it revives it.
export const OBSERVED_TERMINAL = new Set(['done', 'failed', 'stopped'])

// The Dispatch tab's defaults (requests.mjs:152). `model` is allowlisted the
// way relay.mjs's /api/request/update comment demands of anything that
// reaches a spawn argv from a browser: aliases, or a full claude-* name.
export const MODELS = ['opus', 'sonnet', 'haiku', 'fable']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const DEFAULT_MODEL = 'opus'
export const DEFAULT_EFFORT = 'high'
export const NAME_MAX = 60
export const PROMPT_MAX = 20_000
// The parked link's note is bounded where /api/link's is not, because this one
// is PERSISTED: it sits in world.json until the child registers, and an
// unbounded note would be an unbounded file.
export const LINK_NOTE_MAX = 4000

const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export const emptyCanvas = () => ({ nodes: {}, spawnedBy: [], recents: [] })

/** A parked link survives a relay restart only if it still makes sense: a
 *  non-empty `from`, and a note that is either null (wire only) or a string.
 *  Anything else is DROPPED rather than repaired -- the same "coerce to the
 *  shape every consumer relies on" contract the rest of sanitizeCanvas keeps,
 *  so nothing downstream has to guard it. A note of the wrong type becomes
 *  null rather than a stringified one: sending `[object Object]` to a session
 *  is worse than sending nothing. */
const sanitizePendingLink = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const from = typeof raw.from === 'string' ? raw.from : ''
  if (!from) return null
  const out = { from, note: typeof raw.note === 'string' ? raw.note.slice(0, LINK_NOTE_MAX) : null }
  // `since` only when it is a finite number: a row parked before it
  // existed simply has none, and resolvePendingLink then skips that check.
  const since = fin(raw.since)
  if (since !== null) out.since = since
  return out
}

/** Coerce whatever world.json held to the shape every consumer relies on, so
 *  nothing downstream guards it. Same role readClaims plays for claims.json.
 *  A spawnSession placeholder has a null shortId, so the dropped-unless-a-string
 *  rule below is also what clears one left behind by a crash mid-spawn. */
export const sanitizeCanvas = (raw) => {
  const out = emptyCanvas()
  const r = raw && typeof raw === 'object' ? raw : {}
  for (const [id, n] of Object.entries(r.nodes && typeof r.nodes === 'object' ? r.nodes : {})) {
    // `out.nodes` is a plain object literal, so out.nodes['__proto__'] = {...}
    // sets its PROTOTYPE rather than adding a key -- and a hand-edited or
    // corrupted world.json reaches here with whatever keys it pleases. That is
    // the same hole /api/canvas/move refuses at the endpoint, arriving by the
    // other door: through the file, at load.
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue
    if (!n || typeof n !== 'object') continue
    const x = fin(n.x), y = fin(n.y)
    if (x === null || y === null) continue
    out.nodes[id] = { x, y, name: typeof n.name === 'string' ? n.name : '', t: fin(n.t) ?? Date.now() }
  }
  if (Array.isArray(r.spawnedBy)) {
    out.spawnedBy = r.spawnedBy
      .filter((s) => s && typeof s === 'object' && typeof s.shortId === 'string' && s.shortId)
      .map((s) => {
        const rec = {
          shortId: s.shortId, name: typeof s.name === 'string' ? s.name : '', cwd: typeof s.cwd === 'string' ? s.cwd : '',
          model: typeof s.model === 'string' ? s.model : DEFAULT_MODEL, effort: typeof s.effort === 'string' ? s.effort : DEFAULT_EFFORT,
          spawnedAt: fin(s.spawnedAt) ?? 0, sessionId: typeof s.sessionId === 'string' ? s.sessionId : null,
          state: typeof s.state === 'string' ? s.state : null,
        }
        // Added, never defaulted to null: an ordinary row's shape stays
        // exactly what it was, and `'pendingLink' in row` is a real question.
        const pl = sanitizePendingLink(s.pendingLink)
        if (pl) rec.pendingLink = pl
        // The same rule for which peer's ask started this spawn.
        const fp = sanitizeForPeer(s.forPeer)
        if (fp) rec.forPeer = fp
        return rec
      })
      .slice(-SPAWNED_KEEP)
  }
  if (Array.isArray(r.recents)) {
    for (const c of r.recents) if (typeof c === 'string' && c && !out.recents.includes(c)) out.recents.push(c)
    out.recents = out.recents.slice(0, RECENTS_MAX)
  }
  return out
}

/** `~` and `~/…` mean the home directory, everywhere a path is typed. Only
 *  those two: `~user` is somebody else's home, which this has no way to look
 *  up, and rewriting it to a subdirectory of OUR home would be a silent lie.
 *  Left alone, it simply fails the absolute-path check further on.
 *
 *  Shared by validateCwd and completeDirs on purpose: what the typeahead
 *  offers must be what the relay then accepts. */
export const expandTilde = (p, home = homedir()) => {
  if (typeof p !== 'string') return p
  if (p === '~') return home
  if (p.startsWith('~/')) return home + p.slice(1)
  return p
}

/** absolute, realpath-resolved, exists, is a directory. The value
 *  returned is the REAL path: it is what the child runs in and what recents
 *  record, so a symlink can never disguise where a session actually started. */
export const validateCwd = (raw, home = homedir()) => {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'cwd required' }
  const cwd = expandTilde(raw, home)
  if (!isAbsolute(cwd)) return { ok: false, error: 'cwd must be an absolute path' }
  let real
  try { real = realpathSync(cwd) } catch { return { ok: false, error: 'cwd does not exist' } }
  let st
  try { st = statSync(real) } catch { return { ok: false, error: 'cwd does not exist' } }
  if (!st.isDirectory()) return { ok: false, error: 'cwd is not a directory' }
  return { ok: true, cwd: real }
}

// ---- directory completion (the typeahead behind the cwd field) ---------------

// How many completions the typeahead offers. A datalist longer than this is
// not a menu, it is a wall, and `/Users` on a shared machine is exactly that.
export const COMPLETE_MAX = 20

/** The real directory listing completeDirs runs against. Injected so the
 *  harness can complete a made-up tree without touching the disk -- the same
 *  split `run` gives spawnSession. What an entry IS is reported here rather
 *  than filtered here: the decision belongs in one place, and that place is
 *  completeDirs, which the harness can reach.
 *
 *  ASYNC, and that is not tidiness. The relay is one event loop serving every
 *  pane's SSE stream and every session's heartbeat, and this runs on a path the
 *  user is typing -- so it fires on directories nobody vetted. `readdirSync`
 *  over a huge directory, or one on a stalled network volume, stops the whole
 *  board until it returns. */
export const realList = async (dir) =>
  (await readdir(dir, { withFileTypes: true }))
    .map((d) => ({ name: d.name, isDirectory: d.isDirectory(), isSymbolicLink: d.isSymbolicLink() }))

/** POST /api/canvas/complete. Directory completions for the path typed so far.
 *
 *  The last segment is the PREFIX and everything before it names the directory
 *  to look in, so a trailing `/` (an empty prefix) lists that directory's
 *  children. Hidden directories are offered only once the typed prefix begins
 *  with a dot: otherwise a home directory answers with forty dotfiles and the
 *  real answer is below the fold.
 *
 *  Every failure is an empty list, never a throw and never a 500. A path being
 *  typed is wrong far more often than it is right -- it is wrong on every
 *  keystroke but the last -- so ENOENT and EACCES are the NORMAL cases here,
 *  not exceptional ones.
 *
 *  It only ever reads names -- it never stats -- so a symlink is reported as a
 *  symlink and not as whatever it points at. A symlinked directory is still
 *  OFFERED, because validateCwd accepts one: refusing it here would mean the
 *  typeahead hiding a path the form would have taken, which is worse than
 *  offering one the form may refuse. A dangling link is refused at submit,
 *  where the realpath actually happens, and that is the place that decides.
 *
 *  Async: `list` may do real I/O, and on the relay it does. See realList. */
export const completeDirs = async (path, { home = homedir(), list = realList, max = COMPLETE_MAX } = {}) => {
  if (typeof path !== 'string') return { dirs: [] }
  const full = expandTilde(path.trim(), home)
  if (!isAbsolute(full)) return { dirs: [] }
  const cut = full.lastIndexOf('/')
  const dir = cut === 0 ? '/' : full.slice(0, cut)
  const prefix = full.slice(cut + 1)
  let entries
  // `await` inside the try, not after it: a rejected promise from an async
  // `list` is a failure exactly like a synchronous throw, and awaiting outside
  // would let it escape as an unhandled rejection and 500 the endpoint.
  try { entries = await list(dir) } catch { return { dirs: [] } }
  if (!Array.isArray(entries)) return { dirs: [] }
  const hits = []
  for (const e of entries) {
    const name = e && typeof e.name === 'string' ? e.name : null
    if (!name || !(e.isDirectory || e.isSymbolicLink)) continue
    if (name.startsWith('.') && !prefix.startsWith('.')) continue
    if (!name.startsWith(prefix)) continue
    hits.push(join(dir, name))
  }
  hits.sort()
  return { dirs: hits.slice(0, max) }
}

const CONTROL = /[\u0000-\u001f\u007f]/g
const cleanName = (name, fallback) => {
  const n = String(name ?? '').replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
  return n || fallback
}
const modelOk = (m) => MODELS.includes(m) || /^claude-[a-z0-9.-]+$/.test(m)

/** The optional `link` on a spawn request: wire the new session to an existing
 *  one and, unless the note is null, brief it.
 *
 *  `hasSession` is INJECTED rather than imported, so this stays pure and the
 *  harness can drive it with a Set -- the relay passes
 *  `(id) => sessions.has(id)`. It defaults to refusing everything: a caller
 *  that forgets the predicate gets no links rather than unchecked ones.
 *
 *  `note === null` means "draw the wire and send nothing", which an empty
 *  string cannot say -- /api/link's empty note still costs the SOURCE a queued
 *  command, a tool call and a turn. An ABSENT note defaults to null for the
 *  same reason: the quiet direction is the safe one to get wrong. */
export const linkOnSpawn = (raw, hasSession = () => false) => {
  if (raw === null || raw === undefined) return { ok: true, link: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'link must be an object' }
  const from = String(raw.from ?? '')
  if (!from) return { ok: false, error: 'link.from is required' }
  if (!hasSession(from)) return { ok: false, error: 'link.from does not name a session registered with this relay' }
  const note = raw.note === null || raw.note === undefined ? null : String(raw.note).slice(0, LINK_NOTE_MAX)
  return { ok: true, link: { from, note } }
}

/** The validated, defaulted spawn request. `cwd` has already passed validateCwd. */
export const spawnRequest = (body, cwd, { hasSession = () => false } = {}) => {
  const b = body && typeof body === 'object' ? body : {}
  const prompt = String(b.prompt ?? '').trim().slice(0, PROMPT_MAX)
  if (!prompt) return { ok: false, error: 'a kickoff prompt is required' }
  // Belt to spawnArgv's braces. `--` stops the CLI reading the prompt as an
  // option, but a prompt that begins with `-` is a mistake worth naming rather
  // than quietly running: nobody means to kick a session off with `--resume`.
  if (prompt[0] === '-') return { ok: false, error: 'a kickoff prompt may not begin with "-"' }
  const model = b.model == null || b.model === '' ? DEFAULT_MODEL : String(b.model)
  if (!modelOk(model)) return { ok: false, error: `unknown model ${JSON.stringify(model)}` }
  const effort = b.effort == null || b.effort === '' ? DEFAULT_EFFORT : String(b.effort)
  if (!EFFORTS.includes(effort)) return { ok: false, error: `unknown effort ${JSON.stringify(effort)}` }
  const name = cleanName(b.name, basename(cwd) || 'session')
  const lk = linkOnSpawn(b.link, hasSession)
  if (!lk.ok) return { ok: false, error: lk.error }
  // Refused rather than dropped: a picker that sends a malformed id has a bug
  // worth surfacing, and a silently untemplated spawn hides it.
  let templateId = null
  if (b.templateId != null && b.templateId !== '') {
    if (typeof b.templateId !== 'string' || !SLUG_RE.test(b.templateId)) return { ok: false, error: 'templateId must be a slug' }
    templateId = b.templateId
  }
  return { ok: true, name, prompt, model, effort, cwd, link: lk.link, templateId }
}

/** 2, verbatim. An ARRAY. The prompt is its own element, behind the
 *  end-of-options sentinel `--`: without it a prompt beginning with `-` is
 *  read as an option and a one-word prompt equal to a subcommand name
 *  (`update`, `stop`, `doctor`) is read as that subcommand -- either way a
 *  session starts with no prompt at all and nothing says so. Verified live
 *  against claude 2.1.269: the prompt arrives verbatim, `--` does not.
 *  `--allowedTools` goes as ONE argument -- it is variadic and otherwise
 *  swallows the prompt -- and is placed so a non-variadic option (`--agent`,
 *  else `--model`) always follows it.
 *
 *  `pluginDir` (SZG_SPAWN_PLUGIN_DIR, a dev knob -- see spawnSession) inserts
 *  `--plugin-dir <dir>` BEFORE the `--` sentinel: it is an option, and behind
 *  the sentinel it would arrive as two more words of the prompt. `null` omits
 *  it, which is production.
 *
 *  `settings` is a JSON string handed to `--settings`, and it is THE way to set
 *  an environment variable in a `--bg` session. See spawnEnvSettings.
 *
 *  `budgetUsd` inserts `--max-budget-usd <n>` BEFORE the sentinel, the same
 *  reason `--plugin-dir` does: it is an option, and behind `--` it would
 *  arrive as two more words of the prompt. A falsy value (null, 0, undefined)
 *  omits it entirely. On CLI 2.1.270 `--help` describes the flag as "only
 *  works with --print", so on a `--bg` session it is likely advisory rather
 *  than enforced -- the cap that actually holds is the relay's own watchdog. */
export const spawnArgv = ({ name, prompt, model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, pluginDir = null, settings = null, budgetUsd = null, agent = null, allowedTools = null }) => [
  '--bg',
  ...(pluginDir ? ['--plugin-dir', String(pluginDir)] : []),
  ...(settings ? ['--settings', String(settings)] : []),
  '-n', name, '--permission-mode', 'auto',
  ...(allowedTools ? ['--allowedTools', String(allowedTools)] : []),
  ...(agent ? ['--agent', String(agent)] : []),
  '--model', model, '--effort', effort,
  ...(Number(budgetUsd) > 0 ? ['--max-budget-usd', String(Number(budgetUsd))] : []),
  '--', prompt,
]

/** The `--settings` payload that tells a spawned session which relay started
 *  it: `{"env":{"SZG_RELAY_PORT":…,"SZG_RELAY_TOKEN":…}}`, or null when there
 *  is nothing to say.
 *
 *  **This exists because setting those two variables in the child's ENVIRONMENT
 *  does not reach the session.** Verified live on CLI 2.1.269:
 *  `claude --bg` does not fork the session. It hands the request to a
 *  long-lived `claude daemon run` process, which claims a pre-warmed
 *  `claude bg-spare` child -- and that spare inherits the DAEMON's environment,
 *  which is whatever the first `--bg` launch of the day happened to carry -- a
 *  live daemon has been observed still holding a port and token from a relay
 *  started hours earlier. Argv, by contrast, is marshalled to the
 *  session over the daemon protocol and arrives intact -- which is why
 *  `--plugin-dir` worked in the same experiment where `printenv SZG_RELAY_PORT`
 *  came back empty.
 *
 *  This is the ONLY channel. The child's environment is not a second one:
 *  see childEnv, which deletes those variables from it.
 *
 *  The token rides on the argv, so it is visible to `ps` -- to this user only,
 *  on darwin, where argv of another user's process is not readable. It is a
 *  loopback-only credential that the relay also serves inside the pane's HTML;
 *  this is not where it stops being secret. */
/** The rule: a variable named `SZG_*` is relay configuration by definition, and
 *  none of it may reach a child. A PREFIX rather than a list, because a list
 *  rots -- the next knob added to relay.mjs would leak until somebody
 *  remembered to name it here, and nothing would report that it had. */
export const RELAY_ENV_PREFIX = 'SZG_'

/** The `SZG_*` variables that exist today. Nothing reads this: `childEnv` goes
 *  by the prefix. It is here so the set is legible, and so a test can name the
 *  ones that actually matter rather than only testing the rule in the
 *  abstract. */
export const RELAY_ONLY_ENV = [
  'SZG_RELAY_PORT', 'SZG_RELAY_TOKEN',
  'SZG_PORT', 'SZG_TOKEN', 'SZG_DATA_DIR',
  'SZG_CLAUDE_BIN', 'SZG_SPAWN_PLUGIN_DIR', 'SZG_TMUX_BIN', 'SZG_CANVAS_POLL_MS',
]

/** The environment a spawned child gets: a copy of the relay's, minus every
 *  `SZG_*` variable. Everything else is carried through untouched -- a child
 *  with no PATH and no HOME is not a child that runs.
 *
 *  **Deleting them is the point, and it is not hygiene.** `claude --bg` does
 *  not fork: it hands the request to a long-lived daemon, and the daemon is
 *  COLD-STARTED by the first `--bg` launch on the machine and keeps that
 *  launcher's environment for every session afterwards. So if a canvas spawn
 *  is ever the launch that starts the daemon, every later background session
 *  -- a hand-run `claude --bg`, anything dispatch.mjs spawns --
 *  inherits this relay's `SZG_RELAY_PORT` and `SZG_RELAY_TOKEN` and quietly
 *  registers with the wrong board -- the very hazard the environment
 *  hand-off exists to avoid, arriving by the other door and aimed at
 *  everyone else.
 *
 *  A live daemon has been observed still holding a port, a token and a data
 *  directory from a relay started hours earlier. Same hazard for
 *  `SZG_DATA_DIR`: a relay the daemon accidentally taught to read another
 *  relay's world.json.
 *
 *  The identity travels on the argv instead, via spawnEnvSettings. */
export const childEnv = (env = process.env) => {
  const out = {}
  // Case-sensitive: this is this project's prefix and nobody else's. A
  // case-insensitive sweep would take somebody's unrelated `szg_foo` with it.
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!k.startsWith(RELAY_ENV_PREFIX)) out[k] = v
  }
  return out
}

/** The `--settings` payload that tells a relay-owned `claude -p` child it is
 *  headless, so `hud.tsx` skips the relay handshake, the registration, the
 *  heartbeat, the command poll and its three discovery subprocesses.
 *
 *  One spelling, exported, because scoping.mjs and orchestrator.mjs both need
 *  it and a second copy would drift the moment either grew a second key. It is
 *  a constant rather than a builder: there is nothing per-child in it, and the
 *  argv is asserted literally by the harnesses. */
export const HEADLESS_SETTINGS = JSON.stringify({ env: { SZG_HEADLESS: '1' } })

export const spawnEnvSettings = ({ relayPort = null, relayToken = null } = {}) => {
  const env = {}
  if (relayPort != null) env.SZG_RELAY_PORT = String(relayPort)
  if (relayToken != null) env.SZG_RELAY_TOKEN = String(relayToken)
  return Object.keys(env).length ? JSON.stringify({ env }) : null
}

/** the same window shape /api/takeover uses. */
export const attachArgv = ({ shortId, window, cwd, claudeBin = 'claude' }) =>
  ['new-window', '-d', '-n', window, '-c', cwd, claudeBin, 'attach', shortId]

// ---- closing a session from the pane -----------------------------------------
//
// Two mechanisms, because there are two kinds of session and only one of them
// is ours to signal. A `--bg` or dispatched session is owned by Claude Code's
// own daemon, which has a subcommand for exactly this (`claude stop <id>`); an
// interactive session is a process in somebody's terminal, and the only honest
// thing to send it is a SIGTERM to the pid it registered with.
//
// NEVER a pattern kill. `pkill -f claude` on a machine running nine sessions
// takes all nine, plus the daemon, plus whatever else matched -- and the pane
// offers this per card, so a pattern would be a per-card way to end everyone
// else's work. The pid comes from the session's own registration and the short
// id from a `claude agents` listing; neither is ever taken from the request.

/** Pure: what closing this session means. `kind` and `shortId` come from the
 *  agents listing the relay already polls; `pid` from the session's own
 *  registration. Returns a reason rather than throwing, because "we do not
 *  know how to close this one" is a normal answer the pane has to render. */
export const killPlan = ({ kind, shortId, pid } = {}) => {
  if (kind === 'background' && typeof shortId === 'string' && shortId) {
    return { mode: 'stop', argv: ['stop', shortId], label: 'stop' }
  }
  const n = Number(pid)
  if (Number.isInteger(n) && n > 1) return { mode: 'signal', pid: n, label: 'close' }
  // pid 1 and 0 are refused by name: 0 means "this process group" to kill(2)
  // and 1 is init. Neither is ever a Claude session, and both are catastrophic.
  return { mode: 'none', error: 'this session reported no pid and is not a background agent' }
}

/** Impure half. `run` and `signal` are injected so the harness drives the real
 *  decision without a real process anywhere near it. */
export const killSession = async ({ plan, run, signal, claudeBin = 'claude' }) => {
  if (!plan || plan.mode === 'none') return { status: 409, body: { error: plan?.error ?? 'cannot close' } }
  if (plan.mode === 'stop') {
    if (!claudeBin) return { status: 503, body: { error: 'no usable claude binary was found' } }
    const out = await run(claudeBin, plan.argv, { timeout: 10000 }).catch((e) => ({ code: 1, stderr: String(e) }))
    if (out.code !== 0) {
      return { status: 502, body: { error: `claude stop failed: ${String(out.stderr || out.stdout || '').trim().slice(0, 200)}` } }
    }
    return { status: 200, body: { ok: true, mode: 'stop' } }
  }
  try { signal(plan.pid, 'SIGTERM') } catch (e) {
    // ESRCH is the session having already exited, which is the outcome asked
    // for -- report it as done rather than as a failure the pane must explain.
    if (e && e.code === 'ESRCH') return { status: 200, body: { ok: true, mode: 'gone' } }
    return { status: 502, body: { error: `could not signal ${plan.pid}: ${e?.message ?? e}` } }
  }
  return { status: 200, body: { ok: true, mode: 'signal', pid: plan.pid } }
}

// ---- position inheritance by name --------------------------------
// The two rules are claims-inherit.mjs's: never inherit from a session that is
// still live, and inherit nothing when two or more stale nodes share the name.
// displayName() gives every unnamed session in a worktree the same name, so
// the ambiguous case is common, not a corner: picking one would move a card to
// a position that belonged to a different session.

export const inheritablePosition = (nodes, name, liveIds) => {
  if (!name) return null
  let best = null, matches = 0
  for (const [id, n] of Object.entries(nodes ?? {})) {
    if (!n || n.name !== name) continue
    if (liveIds?.has(id)) continue
    matches++
    best = { id, node: n }
  }
  return matches === 1 ? best : null
}

/** Pure. Returns the nodes map to use and which stale id (if any) donated. */
export const inheritPosition = (nodes, session, liveSessions) => {
  const cur = nodes ?? {}
  const none = { nodes: cur, from: null }
  if (!session?.id || !session.name || cur[session.id]) return none
  const others = (liveSessions ?? []).filter((s) => s && s.id !== session.id)
  // the name must match ONE live session. If another live session
  // wears it too, there is no telling which of them is the successor.
  if (others.some((s) => s.name === session.name)) return none
  const hit = inheritablePosition(cur, session.name, new Set(others.map((s) => s.id)))
  if (!hit) return none
  const next = { ...cur }
  delete next[hit.id]
  next[session.id] = { x: hit.node.x, y: hit.node.y, name: session.name, t: hit.node.t }
  return { nodes: next, from: hit.id }
}

// ---- the link a spawn parked for its child -----------------------------------
// A spawn can promise a wire before the far end exists: the child's session id
// is not knowable until the child itself calls /api/register. So the promise
// waits on the ledger row and is claimed here.

/** Which parked link, if any, a newly-registered session should take.
 *
 *  Two doors, in order of certainty:
 *    1. `sessionId` -- a SUCCESSFUL `claude agents --json` listing has already
 *       tied this row to this id (settleSpawns). That is a fact, and no
 *       ambiguity can arise from it.
 *    2. the NAME, under inheritPosition's rules verbatim: never when another
 *       LIVE session wears it, never when two or more parked rows wear it, and
 *       never from a row a listing has already tied to somebody else, and
 *       never to a session that STARTED before the spawn was requested.
 *
 *  `reason: null` with a record means link it. `'expired'` with a record means
 *  drop the promise without keeping it. `'ambiguous'` means say so and do
 *  nothing -- linking the wrong session is worse than linking nothing. */
export const resolvePendingLink = (spawnedBy, session, liveSessions, now, maxAgeMs = PENDING_MAX_AGE_MS) => {
  const none = { record: null, reason: 'none' }
  if (!session?.id) return none
  const parked = (spawnedBy ?? []).filter((r) => r && r.pendingLink)
  if (!parked.length) return none
  const fresh = (r) => now - (r.spawnedAt ?? 0) <= maxAgeMs
  const exact = parked.find((r) => r.sessionId && r.sessionId === session.id)
  if (exact) return { record: exact, reason: fresh(exact) ? null : 'expired' }
  if (!session.name) return none
  const others = (liveSessions ?? []).filter((s) => s && s.id !== session.id)
  if (others.some((s) => s.name === session.name)) return { record: null, reason: 'ambiguous' }
  // A session that started before the spawn was requested cannot be its child.
  // Skipped, not failed, when either side has no time to compare.
  const tooOld = (r) => Number.isFinite(session.startedAt) && Number.isFinite(r.pendingLink.since)
    && session.startedAt < r.pendingLink.since
  const byName = parked.filter((r) => !r.sessionId && r.name === session.name && !tooOld(r))
  if (byName.length > 1) return { record: null, reason: 'ambiguous' }
  if (byName.length === 0) return none
  return { record: byName[0], reason: fresh(byName[0]) ? null : 'expired' }
}

/** A parked link is a promise the spawn made and may never keep -- exactly the
 *  shape of the pending NODE, so it gets exactly the same limit, measured from
 *  the same `spawnedAt`. Node and link for one spawn therefore die together.
 *  The ROW is left alone: whether it still counts toward the live count is
 *  isLiveSpawn's question, not this one's. */
export const dropExpiredLinks = (spawnedBy, now, maxAgeMs = PENDING_MAX_AGE_MS) => {
  let changed = false
  const next = (spawnedBy ?? []).map((r) => {
    if (!r || !r.pendingLink || now - (r.spawnedAt ?? 0) <= maxAgeMs) return r
    changed = true
    const copy = { ...r }
    delete copy.pendingLink
    return copy
  })
  return { spawnedBy: changed ? next : spawnedBy, changed }
}

// ---- the spawn ledger and the live count ---------------------------

/** Fail closed. `state == null` means no SUCCESSFUL listing has ever ruled on
 *  this record, so it keeps counting -- until NULL_STATE_MAX_MS, the age at
 *  which relay.mjs's poller stops asking and nothing ever will rule on it.
 *  A `starting` placeholder is not null and not SETTLED, so it counts by the
 *  other branch, which is what makes the count right from the moment a spawn
 *  is requested rather than from the moment `claude --bg` answers. */
export const isLiveSpawn = (r, now, maxMs = NULL_STATE_MAX_MS) =>
  r.state == null ? (now - (r.spawnedAt ?? 0)) < maxMs : !SETTLED.has(r.state)

export const liveSpawnCount = (spawnedBy, now) => (spawnedBy ?? []).filter((r) => isLiveSpawn(r, now)).length

/** Fold one `claude agents --json --all` listing onto the ledger. `agents`
 *  null means the call failed: that says nothing about any session, so
 *  nothing changes (dispatch.mjs's poll() makes the same distinction).
 *
 *  Only an OBSERVED terminal state short-circuits. `missing` is this function's
 *  own inference from absence, never a fact a listing reported, so a record
 *  wearing it is re-folded on every later listing and revived the moment one
 *  names it. Matching is dispatch.mjs:240's: the short id, or the full session
 *  id once we know it, since a listing may carry only one of the two. */
export const settleSpawns = (spawnedBy, agents, now, graceMs = SPAWN_GRACE_MS) => {
  if (!Array.isArray(agents)) return { spawnedBy, changed: false }
  let changed = false
  const next = spawnedBy.map((r) => {
    if (r.state != null && OBSERVED_TERMINAL.has(r.state)) return r
    const a = agents.find((x) => x && (x.id === r.shortId || (r.sessionId && x.sessionId === r.sessionId)))
    let state = r.state, sessionId = r.sessionId
    if (a) { state = typeof a.state === 'string' ? a.state : 'listed'; sessionId = typeof a.sessionId === 'string' ? a.sessionId : sessionId }
    else if (now - (r.spawnedAt ?? 0) > graceMs) state = 'missing'
    if (state === r.state && sessionId === r.sessionId) return r
    changed = true
    return { ...r, state, sessionId }
  })
  return { spawnedBy: next, changed }
}

/** A spawn's node is keyed 'pending:<shortId>' until its session id is known.
 *  Once it is, move it -- unless the session already has a position (it
 *  registered first and inherited by name), in which case the pending one is
 *  simply retired. */
export const movePending = (nodes, spawnedBy) => {
  let changed = false
  const next = { ...nodes }
  for (const r of spawnedBy ?? []) {
    if (!r.sessionId) continue
    const key = 'pending:' + r.shortId
    if (!(key in next)) continue
    if (!next[r.sessionId]) next[r.sessionId] = next[key]
    delete next[key]
    changed = true
  }
  return { nodes: next, changed }
}

/** world.json would otherwise keep a position for every session that ever
 *  existed. Live nodes are live; a pending node is held for its spawn to claim,
 *  but only for PENDING_MAX_AGE_MS, not forever -- a spawn that never yields a
 *  sessionId would otherwise leave a node no code path can ever remove.
 *  Anything else goes after maxAgeMs. */
export const pruneNodes = (nodes, liveIds, now, maxAgeMs = NODE_MAX_AGE_MS) => {
  let changed = false
  const next = {}
  for (const [id, n] of Object.entries(nodes ?? {})) {
    const limit = id.startsWith('pending:') ? PENDING_MAX_AGE_MS : maxAgeMs
    const keep = liveIds.has(id) || now - (n.t ?? 0) <= limit
    if (keep) next[id] = n; else changed = true
  }
  return { nodes: next, changed }
}

export const pushRecent = (recents, cwd, max = RECENTS_MAX) => {
  const cur = recents ?? []
  if (cur[0] === cwd) return { recents: cur, changed: false }
  return { recents: [cwd, ...cur.filter((c) => c !== cwd)].slice(0, max), changed: true }
}

// ---- the two actions ---------------------------------------------------------

// The 30 s timeout is load-bearing, not tidiness. spawnSession's placeholder
// sits on the ledger across this await, and settleSpawns rewrites a still-
// unmatched record into a NEW object once it is SPAWN_GRACE_MS (60 s) old --
// which would break the `r === placeholder` identity the swap back relies on,
// leaving a phantom `missing` row beside the real one. 30 s is half that
// window, so a listing can never re-create the placeholder under a live spawn.
export const realRun = (bin, argv, opts = {}) =>
  new Promise((resolve) => {
    // `closeStdin` is opt-in and consumed here, never forwarded to execFile:
    // a probe that reads its refusal off argv alone still gets a stdin left
    // open, and a child waiting on a pipe that will never write and never
    // close sits there for the full timeout instead of exiting at once.
    const { closeStdin, ...rest } = opts
    const child = execFile(bin, argv, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...rest }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
    if (closeStdin) child.stdin?.end()
  })

// ---- which `claude` ----------------------------------------------------------
//
// There can be more than one on a machine, and the wrong one is not obviously
// wrong. Installs differ: an older build may have neither `--bg` nor the
// `attach` subcommand, and which build wins PATH depends on the shell the
// relay happened to be started from. Taking `claude` on faith means every
// spawn dies on `unknown option '--bg'` and every attach on an unknown
// subcommand, with the failure surfacing as a 502 that names a CLI error
// nobody asked for. So the binary is chosen by CAPABILITY, once, at boot.

/** Does this binary have what the canvas needs? `--bg` AND `attach`: a build
 *  with one and not the other would pass a looser check and then fail on the
 *  other endpoint, which is the confusing half of the bug rather than a fix. */
export const probeClaudeBin = async (bin, run = realRun) => {
  const out = await run(bin, ['--help'], { timeout: 8000 }).catch(() => null)
  if (!out || out.code !== 0) return false
  const text = String(out.stdout || '') + String(out.stderr || '')
  return text.includes('--bg') && /(^|\s)attach(\s|$|,)/m.test(text)
}

/** Pure: the first candidate `probe` accepts, or null. Candidates are tried in
 *  order and the first success wins, so the caller's ordering IS the policy --
 *  an explicitly configured binary is a list of one, never a preference among
 *  several, because a configured binary that does not work is a mistake to
 *  report rather than one to route around. */
/** Does this binary understand `--safe-mode`? Asked once at boot, the same
 *  shape and for the same reason as `probeClaudeBin` above: ask the binary,
 *  never assume the machine.
 *
 *  `--safe-mode` starts a session with every customization off — project
 *  instructions, skills, plugins, hooks, MCP servers, commands, agents —
 *  while auth, model
 *  selection, the built-in tools and permissions work normally. That is
 *  exactly what a relay-owned `claude -p` child wants: it is handed its whole
 *  context in the prompt and has no use for the host's own configuration, and
 *  loading the plugin cost it a full session.start it then threw away.
 *
 *  NOT `--bare`, which also skips hooks and plugin sync but forces
 *  ANTHROPIC_API_KEY / apiKeyHelper auth and never reads OAuth or the keychain
 *  — so on a Max account every child would simply fail to authenticate. And
 *  not `--restricted`, which takes Bash away as well. */
export const probeSafeMode = async (bin, run = realRun) => {
  if (!bin) return false
  const out = await run(bin, ['--help'], { timeout: 8000 }).catch(() => null)
  if (!out || out.code !== 0) return false
  const text = String(out.stdout || '') + String(out.stderr || '')
  return /(^|\s)--safe-mode(\s|$|,)/m.test(text)
}

export const pickClaudeBin = async (candidates, probe) => {
  for (const bin of candidates ?? []) {
    if (!bin) continue
    if (await probe(bin)) return bin
  }
  return null
}

/** POST /api/spawn. Mutates `canvas` only on success; the caller persists and
 *  broadcasts when `changed` is true. This is NOT dispatch: no worktree, no
 *  branch, no git. The cwd is chosen, not built.
 *
 *  `relayPort`/`relayToken` are THIS relay's, handed to the child as
 *  `SZG_RELAY_PORT` / `SZG_RELAY_TOKEN`. Without them the spawned session's own
 *  plugin registers with its hardcoded default port and never appears on the
 *  canvas that started it.
 *
 *  `pluginDir` is a development knob (`SZG_SPAWN_PLUGIN_DIR`), unset in
 *  production: it makes the child load the plugin from a checkout other than
 *  the installed one, so a relay running from a branch can spawn sessions
 *  carrying that branch's plugin and therefore talking back to it.
 *
 *  `budgetUsd` is an OPTION, not a `body` field: it is never destructured out
 *  of `spawnRequest`, so a browser's `/api/spawn` request can never set it. A
 *  budget is a kill threshold, and only a caller inside the relay itself --
 *  never a request body -- may name one.
 *
 *  `agent` and `allowedTools` are a template's contribution, already resolved
 *  by the caller (see agent-templates.mjs's templateArgv). They are options
 *  for the same reason `budgetUsd` is: a body carries at most a `templateId`,
 *  and this function never reads the template store itself.
 *
 *  `forPeer` is an option for the same reason: the relay resolves which peer's
 *  ask a spawn serves from its own ask log, and a body never names a peer. */
export const spawnSession = async ({ canvas, body, run, now = Date.now, claudeBin = 'claude', relayPort = null, relayToken = null, pluginDir = null, budgetUsd = null, agent = null, allowedTools = null, hasSession = () => false, forPeer = null }) => {
  const v = validateCwd(body?.cwd)
  if (!v.ok) return { status: 400, body: { error: v.error }, changed: false }
  const req = spawnRequest(body, v.cwd, { hasSession })
  if (!req.ok) return { status: 400, body: { error: req.error }, changed: false }
  // Nothing refuses here, but the record is still written BEFORE the await. The live count is the tab's only
  // guard now, and a count that only learns about a spawn once `claude --bg`
  // has answered is wrong for as long as the spawn takes -- exactly the window
  // in which a second click is likely. `starting` is not SETTLED, so
  // isLiveSpawn counts the placeholder from the moment of the request.
  const placeholder = { shortId: null, name: req.name, cwd: v.cwd, model: req.model, effort: req.effort, spawnedAt: now(), sessionId: null, state: 'starting' }
  // On the PLACEHOLDER as well as the record, because the relay is one event
  // loop: the child can register while the `await` below is outstanding, and
  // the only row on the ledger at that moment is this one.
  // `since` is the REQUEST's time, stamped before `claude --bg` runs: the
  // record's own spawnedAt is taken after the await, and a child can start
  // during it. resolvePendingLink's name door will not hand the link to a
  // session that started before this.
  if (req.link) placeholder.pendingLink = { ...req.link, since: placeholder.spawnedAt }
  const tag = sanitizeForPeer(forPeer)
  if (tag) placeholder.forPeer = tag
  canvas.spawnedBy = [...canvas.spawnedBy, placeholder]
  const drop = () => { canvas.spawnedBy = canvas.spawnedBy.filter((r) => r !== placeholder) }
  let out
  // Told WHICH relay started it, on the ARGV and only there -- `--settings` is
  // what actually reaches a `--bg` session. The child's environment has every
  // SZG_* variable STRIPPED, because the daemon a `--bg` launch may cold-start
  // keeps that launcher's environment for every later session on the machine.
  // See childEnv and spawnEnvSettings; between them they are the whole fix.
  const settings = spawnEnvSettings({ relayPort, relayToken })
  // A throwing runner must not leave the placeholder behind -- `starting` is
  // not SETTLED, so a stranded one would inflate the count for good.
  try { out = await run(claudeBin, spawnArgv({ ...req, pluginDir, settings, budgetUsd, agent, allowedTools }), { cwd: v.cwd, env: childEnv() }) } catch (err) { drop(); throw err }
  const parsed = out.code === 0 ? parseBackgrounded(out.stdout) : null
  if (!parsed) {
    drop()
    const why = String(out.stderr || out.stdout || `exit ${out.code}`).trim().slice(0, 400)
    return { status: 502, body: { error: 'claude --bg failed: ' + why }, changed: false }
  }
  const t = now()
  const record = { shortId: parsed.shortId, name: req.name, cwd: v.cwd, model: req.model, effort: req.effort, spawnedAt: t, sessionId: null, state: null }
  // Taken from the PLACEHOLDER, never rebuilt from `req`: if the child
  // registered during the await, the link has already been resolved and
  // deleted, and rebuilding it here would resurrect a promise already kept.
  if (placeholder.pendingLink) record.pendingLink = placeholder.pendingLink
  if (placeholder.forPeer) record.forPeer = placeholder.forPeer
  // Replace the placeholder in place, so a spawn that resolved second does not
  // jump ahead of one that resolved first.
  canvas.spawnedBy = (canvas.spawnedBy.includes(placeholder)
    ? canvas.spawnedBy.map((r) => (r === placeholder ? record : r))
    : [...canvas.spawnedBy, record]).slice(-SPAWNED_KEEP)
  canvas.recents = pushRecent(canvas.recents, v.cwd).recents
  const x = fin(body.x), y = fin(body.y)
  // Clamped at BOTH ends, like /api/canvas/move: the pane sends pointer
  // coordinates, and a stored 1e12 puts the pending card where no scroll can
  // reach it and persists that to world.json.
  const clamp = (v) => Math.min(COORD_MAX, Math.max(0, Math.round(v)))
  if (x !== null && y !== null) canvas.nodes['pending:' + parsed.shortId] = { x: clamp(x), y: clamp(y), name: req.name, t }
  return { status: 200, body: { ok: true, shortId: parsed.shortId, name: req.name, cwd: v.cwd }, changed: true }
}

/** POST /api/attach. Only a session this canvas started can be attached to:
 *  `claude attach` takes the short id `--bg` printed, and that is the only
 *  place it is known. 409 carries the command to run by hand, as
 *  /api/takeover does -- built from the RESOLVED binary, because on a machine
 *  with two installs a bare `claude attach` is the very command that does not
 *  work (pickClaudeBin exists for that reason), and this string is shown to
 *  somebody about to paste it. */
export const attachSession = async ({ canvas, body, run, tmuxBin = 'tmux', claudeBin = 'claude' }) => {
  const id = String(body?.sessionId ?? '')
  const r = id ? canvas.spawnedBy.find((x) => x.shortId === id || (x.sessionId && x.sessionId === id)) : null
  if (!r) return { status: 404, body: { error: 'not a session this canvas started' } }
  const v = validateCwd(body?.cwd ?? r.cwd)
  const cwd = v.ok ? v.cwd : r.cwd
  const command = `${claudeBin} attach ${r.shortId}`
  const window = ('szg-' + r.name).slice(0, 60)
  const out = await run(tmuxBin, attachArgv({ shortId: r.shortId, window, cwd, claudeBin }), { timeout: 6000 })
  if (out.code !== 0) return { status: 409, body: { error: 'tmux is not running — use the command shown instead', command } }
  return { status: 200, body: { ok: true, window, command } }
}
