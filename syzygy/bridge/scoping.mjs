// The Dispatch tab's scoping engine: turns a fuzzy ask into a structured
// handoff brief.
//
// A scoping conversation is ONE live `claude --bg` session per request, which a
// person can also join from a terminal with `claude attach`. The first turn
// spawns it; every later turn reaches it through the relay's command queue;
// its replies are read back off its transcript on disk; `claude stop` ends it.
// Beside it run three short headless `-p` children: the bank call that emits
// the brief, the fan-out call that splits one ask into drafts, and the title
// refine.
//
// Two halves. The pure one -- argv construction, NDJSON parsing, the preamble
// and the schema -- is exported and tested directly. The impure one owns every
// subprocess and is created with an injected `run` and `spawn`, so the harness
// never runs a real `claude`. It lives inside the long-lived relay every
// session's dashboard depends on, so nothing in it rejects or throws outward:
// every method resolves, and every failure is written onto the record it
// belongs to.

import { spawn as realSpawn } from 'node:child_process'
import { existsSync, statSync, readdirSync, openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HEADLESS_SETTINGS, realRun, childEnv, spawnEnvSettings } from './canvas.mjs'
import { parseBackgrounded } from './dispatch.mjs'
import { resultRecord, argvModel } from './spend.mjs'
import {
  scopeSpawnArgv, fanoutArgv, titleArgv, readTranscriptTail, foldTurns, renderThread,
  schemaPayload, proposeTitle, draftAsk, FANOUT_MAX_DRAFTS, TITLE_MAX,
} from './fanout.mjs'

/** Imposes superpowers:brainstorming's discipline without its file-writing
 *  half. The output of this conversation is a brief, never a spec. */
export const SCOPING_PREAMBLE = [
  'You are helping scope one feature into a handoff brief for a different',
  'Claude Code session that has none of this conversation in its context.',
  '',
  'Rules for this conversation:',
  '- Ask ONE question at a time. Never a wall of questions.',
  '- Understand purpose, constraints and success criteria before proposing anything.',
  '- Propose two or three approaches with trade-offs, and say which you recommend.',
  '- Name CONCRETE research methods: context7 library ids and the topic to look up,',
  '  exact documentation URLs, and repo-relative files worth reading first.',
  '  Never write "research it" or "look into the docs".',
  '- Say plainly when something cannot be settled here; it becomes an open question.',
  '',
  'Do NOT write any files. Do NOT write the spec. Do NOT start implementing.',
  'The deliverable is a brief precise enough that a session with no memory of',
  'this conversation could write the right spec from it.',
].join('\n')

/** The contract for the banked brief. A response that fails this is rejected
 *  whole -- a brief that silently loses its non-goals is worse than one that
 *  fails loudly, because the dispatched session will cheerfully build them. */
export const BRIEF_SCHEMA = {
  type: 'object',
  required: ['goal'],
  properties: {
    goal: { type: 'string' },
    nonGoals: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    successCriteria: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    research: {
      type: 'object',
      properties: {
        context7: {
          type: 'array',
          items: {
            type: 'object',
            required: ['library'],
            properties: { library: { type: 'string' }, topic: { type: 'string' } },
          },
        },
        urls: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' } },
      },
    },
  },
}

/** A live scoping session is ended once it is this old, whether or not anyone
 *  is still talking to it: an abandoned conversation otherwise holds a
 *  background session open forever. */
export const SCOPE_MAX_AGE_MS = 24 * 3600_000

/** The kickoff text a restart sends when the person typed nothing. */
const RESTART_DEFAULT = 'Pick up where we left off: say what was settled, then ask the next open question.'

/** How much of a transcript one read may take. A tail larger than this is read
 *  across several passes rather than held in memory at once. */
const TRANSCRIPT_READ_MAX = 8 * 1024 * 1024

/** A session id becomes a file name under the projects directory, so it must
 *  be one plain path segment before it becomes one. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Consume every complete line in `buffer`, hand each parsed object to
 *  `onEvent`, and return what is left over for the next chunk. A line that is
 *  not JSON is dropped silently: the stream is a diagnostic channel, and one
 *  malformed frame must not kill a conversation mid-flight. Exceptions thrown
 *  by `onEvent` are not swallowed and will propagate. */
export const parseNdjson = (buffer, onEvent) => {
  let rest = buffer
  for (;;) {
    const nl = rest.indexOf('\n')
    if (nl < 0) return rest
    const line = rest.slice(0, nl).trim()
    rest = rest.slice(nl + 1)
    if (!line) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    onEvent(obj)
  }
}

/** The argv for one headless scoping call. The prompt is always the final
 *  single element, so no quoting, escaping or shell is involved anywhere. */
export const scopeArgv = ({ text, sessionId, model = 'opus', budgetUsd = 2, schema = null, safeMode = false }) => {
  const argv = ['-p', '--output-format', schema ? 'json' : 'stream-json']
  // The CLI refuses --print --output-format=stream-json without --verbose.
  if (!schema) argv.push('--verbose', '--include-partial-messages')
  // This child is the relay's, not a session anyone is watching. Two
  // layers, because they fail in opposite directions: --safe-mode is the real
  // fix and is absent on an older binary, so it is passed only when the boot
  // probe saw it; SZG_HEADLESS works on every binary and is read by the plugin
  // itself, so it covers the case where the plugin loads anyway.
  if (safeMode) argv.push('--safe-mode')
  argv.push('--settings', HEADLESS_SETTINGS)
  argv.push('--model', String(model))
  argv.push('--max-budget-usd', String(budgetUsd))
  if (schema) argv.push('--json-schema', JSON.stringify(schema))
  else argv.push('--append-system-prompt', SCOPING_PREAMBLE)
  if (sessionId) argv.push('--resume', String(sessionId))
  argv.push(String(text))
  return argv
}

/** Minimal structural check against BRIEF_SCHEMA. The CLI validates against the
 *  schema too; this is the second gate, because a brief is the one artifact the
 *  whole dispatch rests on and it must never be half-written. */
const validateBrief = (b) => {
  if (!b || typeof b !== 'object') return 'brief is not an object'
  if (typeof b.goal !== 'string' || !b.goal.trim()) return 'brief is missing a goal'
  for (const k of ['nonGoals', 'constraints', 'successCriteria', 'openQuestions']) {
    if (k in b && !Array.isArray(b[k])) return `${k} must be an array`
  }
  return null
}

const normaliseBrief = (b) => ({
  goal: b.goal.trim(),
  nonGoals: b.nonGoals ?? [],
  constraints: b.constraints ?? [],
  successCriteria: b.successCriteria ?? [],
  openQuestions: b.openQuestions ?? [],
  research: {
    context7: b.research?.context7 ?? [],
    urls: b.research?.urls ?? [],
    files: b.research?.files ?? [],
  },
})

/** A request's scoping session is live from its spawn until something ends it. */
const liveSession = (r) => {
  const session = r?.scoping?.session
  return session && typeof session === 'object' && !session.endedAt ? session : null
}

const isDirectory = (p) => {
  try { return !!p && existsSync(p) && statSync(p).isDirectory() } catch { return false }
}

/** A subprocess's own words, preferred in the order a person can act on. */
const outputMessage = (out, max) =>
  (String(out?.stderr ?? '').trim() || String(out?.stdout ?? '').trim() || `exit ${out?.code}`).slice(0, max)

/** The exact wording relay.mjs's own 503 routes use for a missing binary, so
 *  a refusal here reads as the same fact rather than a new one. */
const NO_CLAUDE_BIN = "no claude binary with --bg was found — see the relay's stderr"

export const createScoper = ({
  store, broadcast,
  // `-p` children only: the bank call, the fan-out call and the title refine.
  spawn = realSpawn,
  // An execFile-shaped runner for `--bg`, `stop` and `agents`; resolves
  // { code, stdout, stderr } and is never expected to reject.
  run = realRun,
  // Hands a command to a registered session through the relay's queue.
  enqueue = () => {},
  // Whether a session id is registered with this relay right now.
  hasSession = () => false,
  // Read at spawn time, not construction time: the relay's bound port is only
  // known once it is listening.
  relayInfo = () => ({}),
  projectsDir = join(homedir(), '.claude', 'projects'),
  fanoutStore = null,
  claudeBin = 'claude',
  // Whether the resolved binary understands `--safe-mode`, probed once at the
  // relay's boot (canvas.mjs's probeSafeMode). Defaults false so a caller that
  // has not probed never passes a flag its binary might refuse.
  safeMode = false,
  budgetUsd = 2,
  timeoutMs = 600_000,
  // Rides the scoping session's argv. On a `--bg` session the CLI treats it as
  // advisory; the age ceiling is the enforced bound.
  scopeBudgetUsd = 5,
  now = Date.now,
  // The spend ledger (spend.mjs). Optional and duck-typed exactly like every
  // other store here: a caller with none simply records nothing.
  spend = null,
}) => {
  /** key -> { child, timer }, for the `-p` children only. Keys are
   *  `bank:<requestId>`, `fanout:<runId>` and `title:<requestId>`. */
  const live = new Map()
  /** Request ids whose `--bg` spawn is awaiting its answer. */
  const spawning = new Set()
  /** Request ids whose `claude stop` is awaiting its answer. */
  const ending = new Set()
  let passing = false

  /** A broadcast that throws is a bug in a listener, never a reason for a
   *  scoping call to reject into an HTTP handler. */
  const emit = (type, data) => {
    try { broadcast(type, data) } catch (err) {
      process.stderr.write(`[scoping] broadcast ${type} threw: ${err?.stack || err}\n`)
    }
  }
  // The client learns about request changes only through 'dispatch'
  // snapshots -- the 'scope' event carries no turn text -- so every write that
  // changes what the thread panel renders is paired with one of these.
  const pushDispatch = () => emit('dispatch', { requests: store.all() })

  const runOut = async (argv, opts) => {
    // No usable binary was resolved at boot: refuse rather than fall back to
    // whatever `claude` happens to sit on PATH -- a tick calling this on an
    // unattended relay must never spend against a binary nobody chose.
    if (!claudeBin) {
      process.stderr.write(`[scoping] refusing to spawn: ${NO_CLAUDE_BIN}\n`)
      return { code: -1, stdout: '', stderr: NO_CLAUDE_BIN }
    }
    try {
      const out = await run(claudeBin, argv, opts)
      return out && typeof out === 'object' ? out : { code: -1, stdout: '', stderr: 'no result from the runner' }
    } catch (err) {
      return { code: -1, stdout: '', stderr: String(err?.message ?? err) }
    }
  }

  const finish = (key) => {
    const entry = live.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    live.delete(key)
  }

  /** Run one `-p` child. `onFrame` sees every parsed stdout object. Resolves
   *  with the exit code once the child closes -- or, on a spawn failure, with
   *  a synthetic non-zero code so every caller's existing "code !== 0"
   *  handling covers this path too, with no separate error branch. */
  const runChild = (key, argv, cwd, onFrame) =>
    new Promise((resolve) => {
      // Same refusal as runOut, at the one other place this module spawns a
      // child directly rather than through the injected `run`.
      if (!claudeBin) {
        process.stderr.write(`[scoping ${key}] refusing to spawn: ${NO_CLAUDE_BIN}\n`)
        return resolve({ code: -1, errText: NO_CLAUDE_BIN, outHead: '' })
      }
      const startedAt = now()
      let resultFrame = null
      let spawned = false
      // 'error' and 'close' are independent events -- a failed spawn can fire
      // 'error' alone, or (rarely) both -- so resolve must run exactly once
      // regardless of which arrives first. `settle` is that single gate.
      let settled = false
      const settle = (result) => {
        if (settled) return
        settled = true
        // Only a call that actually spawned a child spent anything -- the
        // cwd check just below settles with no child at all.
        if (spawned) {
          try { spend?.record(resultRecord({ kind: 'scoping', site: String(key).split(':')[0], model: argvModel(argv), frame: resultFrame, startedAt, now: now() })) } catch {}
        }
        finish(key)
        resolve(result)
      }

      // Check the cwd BEFORE spawning. node reports a missing cwd as
      // `spawn <bin> ENOENT` -- indistinguishable from the BINARY being
      // missing -- and that is exactly what a request carrying a bare repo
      // name produced: an error naming `claude` for a fault in the project
      // field. The message has to say which of the two it is.
      if (!isDirectory(cwd)) {
        return settle({ code: 1, errText: `project directory does not exist: ${cwd || '(none)'}`, outHead: '' })
      }

      let child
      try {
        // stdin is closed: the prompt always travels on the argv, and an open
        // stdin costs the CLI a fixed wait for input that never comes.
        child = spawn(claudeBin, argv, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
        spawned = true
      } catch (err) {
        // spawn() can throw synchronously for a malformed options/argv shape
        // (distinct from ENOENT, which arrives asynchronously as 'error'
        // below). Guarded for the same reason as 'error': a spawn failure
        // must never become an uncaught exception inside the relay.
        return settle({ code: -1, errText: `spawn threw: ${err?.message ?? err}`, outHead: '' })
      }

      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try { child.kill('SIGTERM') } catch {}
      }, timeoutMs)
      timer.unref?.()
      live.set(key, { child, timer })

      let buf = ''
      let outHead = ''
      const onEach = (frame) => { if (frame?.type === 'result') resultFrame = frame; return onFrame(frame) }
      const frames = (text) => {
        // parseNdjson lets a consumer's (onFrame's) exception propagate --
        // correct for the parser, but this runs inside a stream event, where
        // an uncaught exception is fatal to the whole process. The boundary
        // guards here, so one bad frame fails one call instead of the relay.
        try {
          buf = parseNdjson(buf + text, onEach)
        } catch (err) {
          buf = ''
          process.stderr.write(`[scoping ${key}] onFrame threw: ${err?.stack || err}\n`)
        }
      }
      try {
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
          if (outHead.length < 2000) outHead += String(chunk).slice(0, 2000 - outHead.length)
          frames(chunk)
        })
        child.stderr.setEncoding('utf8')
      } catch (err) {
        try { child.kill('SIGTERM') } catch {}
        return settle({ code: -1, errText: `spawn failed: ${err?.message ?? err}`, outHead: '' })
      }
      let errText = ''
      child.stderr.on('data', (chunk) => { errText += chunk })

      // A spawn failure (wrong claudeBin, ENOENT, EACCES, ...) surfaces here,
      // asynchronously, on a path separate from 'close'. With no 'error'
      // listener, EventEmitter re-throws it as an uncaught exception -- fatal
      // to the relay. Resolve rather than reject: every caller already treats
      // a non-zero code as an ordinary failure.
      child.on('error', (err) => {
        settle({ code: -1, errText: `spawn failed: ${err?.message ?? err}`, outHead })
      })
      child.on('close', (code) => {
        // A `--output-format json` answer can arrive with no trailing newline,
        // and would otherwise never reach onFrame.
        if (!settled && buf.trim()) frames('\n')
        const prefix = timedOut ? `timed out after ${timeoutMs} ms` : ''
        settle({ code, errText: [prefix, errText].filter(Boolean).join(': '), outHead })
      })
    })

  /** Spawn a fresh `--bg` session for a request, or restart one that ended. */
  const spawnScope = async (r, text, cwd, restart) => {
    const id = r.id
    const s = r.scoping
    const kickoffAsk = restart
      ? `This continues an earlier scoping conversation. Here it is so far, oldest first:\n\n${renderThread(s?.turns ?? [], 30_000)}\n\nNow: ${text}`
      : text
    let settings = null
    try { settings = spawnEnvSettings(relayInfo() ?? {}) } catch { settings = null }
    const name = ('scope-' + r.slug).slice(0, 60)
    const argv = scopeSpawnArgv({
      name, preamble: SCOPING_PREAMBLE, ask: kickoffAsk,
      model: r.dispatch?.model ?? 'opus', settings, budgetUsd: scopeBudgetUsd,
    })

    spawning.add(id)
    let out
    try {
      out = await runOut(argv, { cwd, env: childEnv(), timeout: 60_000 })
    } finally {
      spawning.delete(id)
    }
    const parsed = out.code === 0 ? parseBackgrounded(out.stdout) : null

    const cur = store.get(id)
    if (!cur) {
      // Deleted while the spawn was in flight: nothing will ever track this
      // session, so it is stopped rather than left running unowned.
      if (parsed) void runOut(['stop', parsed.shortId], { timeout: 10_000 })
      return { ok: false, code: 404, error: 'unknown request' }
    }
    if (!parsed) {
      const message = outputMessage(out, 400)
      store.update(id, { error: { at: now(), phase: 'scoping', message } })
      pushDispatch()
      return { ok: false, code: 502, error: message }
    }

    const cs = cur.scoping
    const session = {
      shortId: parsed.shortId, sessionId: null, name, spawnedAt: now(),
      state: null, endedAt: null, endedReason: null,
    }
    const turns = foldTurns(
      [...(cs?.turns ?? []), { role: 'user', text, t: now(), via: 'pane', kickoff: true, confirmed: false }],
      [], now)
    // A new session writes a new transcript, so the read position, the seen
    // set and the cached path all start over. Any older record's own
    // `sessionId` is carried through untouched.
    const scoping = {
      ...(cs ?? {}), turns, session, pending: [], offset: 0, seen: [], transcriptPath: null,
      busy: true, costUsd: cs?.costUsd ?? 0,
    }
    store.update(id, { scoping, error: null })
    if (store.get(id)?.state === 'draft') {
      try { store.transition(id, 'scoped') } catch {}
    }
    emit('scope', { requestId: id, event: { type: 'turn-start' } })
    pushDispatch()
    return { ok: true, shortId: parsed.shortId }
  }

  const drainPending = (requestId, sessionId) => {
    try {
      const r = store.get(requestId)
      const pending = Array.isArray(r?.scoping?.pending) ? r.scoping.pending : []
      if (!pending.length || !sessionId || !hasSession(sessionId)) return false
      let sent = 0
      for (const text of pending) {
        try { enqueue(sessionId, { verb: 'prompt', payload: { text } }) } catch (err) {
          process.stderr.write(`[scoping ${requestId}] enqueue threw: ${err?.stack || err}\n`)
          break
        }
        sent++
      }
      if (!sent) return false
      const cur = store.get(requestId)
      if (cur?.scoping) store.update(requestId, { scoping: { ...cur.scoping, pending: pending.slice(sent) } })
      return true
    } catch (err) {
      process.stderr.write(`[scoping ${requestId}] drain failed: ${err?.stack || err}\n`)
      return false
    }
  }

  const findTranscript = (s, sessionId) => {
    if (typeof s.transcriptPath === 'string' && s.transcriptPath && existsSync(s.transcriptPath)) return s.transcriptPath
    if (!SESSION_ID_RE.test(sessionId)) return null
    const file = `${sessionId}.jsonl`
    for (const dir of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, dir, file)
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  const readReplies = (requestId) => {
    try {
      const r = store.get(requestId)
      const session = liveSession(r)
      if (!session || typeof session.sessionId !== 'string' || !session.sessionId) return false
      const s = r.scoping
      const path = findTranscript(s, session.sessionId)
      if (!path) return false

      let offset = Number.isInteger(s.offset) && s.offset >= 0 ? s.offset : 0
      let text = ''
      let len = 0
      const fd = openSync(path, 'r')
      try {
        const size = fstatSync(fd).size
        // A file shorter than the stored position was replaced or truncated.
        if (size < offset) offset = 0
        len = Math.min(size - offset, TRANSCRIPT_READ_MAX)
        if (len > 0) {
          const buf = Buffer.alloc(len)
          const got = readSync(fd, buf, 0, len, offset)
          len = got
          text = buf.subarray(0, got).toString('utf8')
        }
      } finally {
        closeSync(fd)
      }

      const res = readTranscriptTail(text, offset, s.seen ?? [])
      let nextOffset = res.offset
      // One row larger than a whole read would otherwise pin the position
      // forever; skipping into it is safe, because its remainder is not JSON
      // and the next read drops it.
      if (nextOffset === offset && len >= TRANSCRIPT_READ_MAX) nextOffset = offset + len
      const before = Array.isArray(s.turns) ? s.turns : []
      const turns = foldTurns(before, res.turns, now)
      const changed = JSON.stringify(turns) !== JSON.stringify(before)
      // Written whenever the read moved anything, so the offset advances even
      // past rows that produced no turn; an idle tick writes nothing.
      const moved = nextOffset !== s.offset || path !== s.transcriptPath
        || JSON.stringify(res.seen) !== JSON.stringify(s.seen ?? [])
      if (changed || moved) {
        store.update(requestId, {
          scoping: { ...s, turns, offset: nextOffset, seen: res.seen, transcriptPath: path },
        })
      }
      return changed
    } catch (err) {
      process.stderr.write(`[scoping ${requestId}] transcript read failed: ${err?.message ?? err}\n`)
      return false
    }
  }

  const endScoping = async (requestId, reason) => {
    try {
      const r = store.get(requestId)
      const session = liveSession(r)
      if (!session || ending.has(requestId)) return { ok: true, stopped: false }
      ending.add(requestId)
      let out
      try {
        out = session.shortId
          ? await runOut(['stop', String(session.shortId)], { timeout: 10_000 })
          : { code: 1, stdout: '', stderr: 'no session id to stop' }
      } finally {
        ending.delete(requestId)
      }
      const cur = store.get(requestId)
      const cs = cur?.scoping
      // Deleted, or already replaced by another session, while the stop ran.
      if (!cs?.session || cs.session.endedAt || cs.session.shortId !== session.shortId) {
        return { ok: true, stopped: false }
      }
      const stopped = out.code === 0
      store.update(requestId, {
        scoping: {
          ...cs,
          session: {
            ...cs.session, endedAt: now(), endedReason: String(reason ?? 'ended'),
            stopError: stopped ? null : outputMessage(out, 200),
          },
          busy: false,
          pending: [],
        },
      })
      pushDispatch()
      return { ok: true, stopped }
    } catch (err) {
      process.stderr.write(`[scoping ${requestId}] end failed: ${err?.stack || err}\n`)
      return { ok: true, stopped: false }
    }
  }

  const sweepExpired = async () => {
    try {
      const expired = store.all()
        .filter((r) => {
          const session = liveSession(r)
          return session && Number.isFinite(session.spawnedAt) && now() - session.spawnedAt > SCOPE_MAX_AGE_MS
        })
        .map((r) => r.id)
      for (const id of expired) await endScoping(id, 'expired')
    } catch (err) {
      process.stderr.write(`[scoping] expiry sweep failed: ${err?.stack || err}\n`)
    }
  }

  /** One agents listing, or null when the listing failed. */
  const listAgents = async () => {
    const out = await runOut(['agents', '--json', '--all'], { timeout: 30_000 })
    if (out.code !== 0) return null
    try {
      const rows = JSON.parse(String(out.stdout ?? ''))
      return Array.isArray(rows) ? rows : null
    } catch {
      return null
    }
  }

  return {
    active: () => live.size,

    liveScopes: () => store.all().filter((r) => liveSession(r)).length,

    async startScoping(requestId, text, cwd, { restart = false } = {}) {
      try {
        const r = store.get(requestId)
        if (!r) return { ok: false, code: 404, error: 'unknown request' }
        let clean = String(text ?? '').trim()
        if (!clean) {
          if (!restart) return { ok: false, code: 400, error: 'text required' }
          clean = RESTART_DEFAULT
        }

        if (!isDirectory(cwd)) {
          const message = `project directory does not exist: ${cwd || '(none)'}`
          store.update(requestId, { error: { at: now(), phase: 'scoping', message } })
          pushDispatch()
          return { ok: false, code: 400, error: message }
        }

        // Two turns racing the first spawn would start two sessions, one of
        // which nothing would ever track.
        if (spawning.has(requestId)) return { ok: false, code: 409, error: 'this conversation is still starting' }

        const s = r.scoping
        const session = s?.session ?? null
        const isLive = !!session && !session.endedAt
        const legacy = !!s?.sessionId && !session
        if (restart && isLive) return { ok: false, code: 409, error: 'this conversation is still live' }
        if (!restart && ((session && session.endedAt) || legacy)) {
          return { ok: false, code: 409, error: 'conversation ended' }
        }

        if (!session || restart) return await spawnScope(r, clean, cwd, restart)

        const turns = foldTurns(
          [...(s.turns ?? []), { role: 'user', text: clean, t: now(), via: 'pane', confirmed: false }],
          [], now)
        let parked = !session.sessionId || !hasSession(session.sessionId)
        if (!parked) {
          try {
            enqueue(session.sessionId, { verb: 'prompt', payload: { text: clean } })
          } catch (err) {
            process.stderr.write(`[scoping ${requestId}] enqueue threw: ${err?.stack || err}\n`)
            parked = true
          }
        }
        const pending = parked ? [...(Array.isArray(s.pending) ? s.pending : []), clean] : (s.pending ?? [])
        // `busy` rides on the REQUEST, not only on the `scope` broadcast, so a
        // pane that missed the event still shows the turn as in flight.
        store.update(requestId, { scoping: { ...s, turns, pending, busy: true }, error: null })
        emit('scope', { requestId, event: { type: 'turn-start' } })
        pushDispatch()
        return { ok: true, parked }
      } catch (err) {
        process.stderr.write(`[scoping ${requestId}] start failed: ${err?.stack || err}\n`)
        return { ok: false, code: 500, error: String(err?.message ?? err) }
      }
    },

    drainPending,
    readReplies,
    endScoping,
    sweepExpired,

    /** One tick: learn each live session's id and state from one listing,
     *  deliver parked turns, read replies, and settle `busy`. */
    async pass() {
      if (passing) return
      passing = true
      try {
        const liveIds = store.all().filter((r) => liveSession(r)).map((r) => r.id)
        if (!liveIds.length) return
        const before = new Map(liveIds.map((id) => [id, JSON.stringify(store.get(id)?.scoping ?? null)]))
        const wasBusy = new Map(liveIds.map((id) => [id, store.get(id)?.scoping?.busy === true]))

        const rows = await listAgents()

        for (const id of liveIds) {
          try {
            let r = store.get(id)
            let session = liveSession(r)
            if (!session) continue
            if (rows) {
              const row = rows.find((x) => x && typeof x === 'object' && (
                (session.shortId && x.id === session.shortId)
                || (session.sessionId && x.sessionId === session.sessionId)))
              const sessionId = typeof row?.sessionId === 'string' && row.sessionId ? row.sessionId : session.sessionId
              const state = typeof row?.state === 'string' ? row.state : null
              if (sessionId !== session.sessionId || state !== (session.state ?? null)) {
                store.update(id, { scoping: { ...r.scoping, session: { ...session, sessionId, state } } })
                r = store.get(id)
                session = liveSession(r)
              }
            }
            drainPending(id, session.sessionId)
            readReplies(id)

            r = store.get(id)
            const s = r?.scoping
            if (!s) continue
            const busy = (Array.isArray(s.pending) && s.pending.length > 0)
              || (s.turns ?? []).some((t) => t?.role === 'user' && t.via === 'pane' && t.confirmed === false)
              || s.session?.state === 'working'
            if ((s.busy === true) !== busy) store.update(id, { scoping: { ...s, busy } })
            if (wasBusy.get(id) && !busy) emit('scope', { requestId: id, event: { type: 'turn-end', code: 0 } })
          } catch (err) {
            process.stderr.write(`[scoping ${id}] pass failed: ${err?.stack || err}\n`)
          }
        }

        const changed = liveIds.some((id) => JSON.stringify(store.get(id)?.scoping ?? null) !== before.get(id))
        if (changed) pushDispatch()
        await sweepExpired()
      } catch (err) {
        process.stderr.write(`[scoping] pass failed: ${err?.stack || err}\n`)
      } finally {
        passing = false
      }
    },

    /** One headless call asking for the brief under BRIEF_SCHEMA, built from
     *  the stored thread rather than from any session's memory. */
    async bank(requestId, cwd) {
      try {
        const r = store.get(requestId)
        if (!r) return { ok: false, error: 'unknown request', code: 404 }
        const turns = Array.isArray(r.scoping?.turns) ? r.scoping.turns : []
        if (!turns.some((t) => t?.role === 'user' || t?.role === 'assistant')) {
          return { ok: false, error: 'nothing has been scoped yet', code: 409 }
        }
        const key = `bank:${requestId}`
        if (live.has(key)) return { ok: false, error: 'a bank is already running', code: 409 }

        const argv = scopeArgv({
          text: 'Here is a scoping conversation, oldest first. Emit the handoff brief for everything it settled.\n\n'
            + renderThread(turns, 60_000),
          sessionId: null, budgetUsd, schema: BRIEF_SCHEMA, safeMode,
        })
        let payload = null
        const { code, errText } = await runChild(key, argv, cwd, (frame) => {
          if (frame?.type === 'result') payload = schemaPayload(frame)
        })
        if (code !== 0) {
          const message = (errText || `exit ${code}`).slice(0, 400)
          store.update(requestId, { error: { at: now(), phase: 'bank', message } })
          return { ok: false, error: message }
        }

        const bad = validateBrief(payload)
        if (bad) {
          store.update(requestId, { error: { at: now(), phase: 'bank', message: bad } })
          emit('scope', { requestId, event: { type: 'bank-failed', message: bad } })
          return { ok: false, error: bad }
        }

        store.update(requestId, { brief: normaliseBrief(payload), error: null })
        // The request can be deleted while this call was in flight (a bank runs
        // for minutes and the row's delete button is always enabled), so every
        // read here tolerates it being gone; transition() throws for a missing
        // id and that throw is caught.
        if (store.get(requestId)?.state !== 'queued') {
          try { store.transition(requestId, 'queued') } catch {}
        }
        emit('scope', { requestId, event: { type: 'banked' } })
        // A banked conversation has done its job; its session need not idle.
        void endScoping(requestId, 'banked').catch(() => {})
        return { ok: true }
      } catch (err) {
        process.stderr.write(`[scoping bank:${requestId}] bank failed: ${err?.stack || err}\n`)
        return { ok: false, error: String(err?.message ?? err) }
      }
    },

    /** One headless call splitting an ask into drafts, validated before any of
     *  it reaches the run. Resolves { ok }, never rejects. */
    async fanout(runId, ask, projects) {
      if (!fanoutStore) return { ok: false }
      const key = `fanout:${runId}`
      const stillRunning = () => fanoutStore.get(runId)?.state === 'running'
      const fail = (message) => {
        if (!stillRunning()) return { ok: false }
        fanoutStore.update(runId, { error: message })
        fanoutStore.finish(runId, 'failed')
        emit('fanout', { runs: fanoutStore.all() })
        return { ok: false }
      }
      try {
        if (live.has(key)) return { ok: false }
        const set = Array.isArray(projects) ? projects : []
        let payload = null
        const { code, errText, outHead } = await runChild(key,
          fanoutArgv({ ask, projects: set, budgetUsd, safeMode }), process.cwd(), (frame) => {
            if (frame?.type === 'result') payload = schemaPayload(frame)
          })
        // Discarded while the call ran: the person's decision stands.
        if (!stillRunning()) return { ok: false }
        const said = (String(errText ?? '').trim() || String(outHead ?? '').trim()).slice(0, 400)
        if (code !== 0) return fail(`the fan-out call failed (exit ${code})${said ? `: ${said}` : ''}`)
        if (!payload) return fail(`the fan-out call returned no answer${said ? `: ${said}` : ''}`)
        if (!Array.isArray(payload.drafts)) return fail('the fan-out answer has no drafts array')
        if (payload.drafts.length > FANOUT_MAX_DRAFTS) {
          return fail(`the fan-out returned ${payload.drafts.length} drafts; at most ${FANOUT_MAX_DRAFTS} are allowed`)
        }

        const keys = new Set(set.map((p) => p?.key).filter((k) => typeof k === 'string' && k))
        const paragraphs = fanoutStore.get(runId)?.paragraphs ?? []
        let dropped = 0
        const drafts = payload.drafts.filter((d) => d && typeof d === 'object' && !Array.isArray(d)).map((d) => {
          const givenKey = typeof d.projectKey === 'string' ? d.projectKey.trim() : ''
          const known = givenKey !== 'unknown' && keys.has(givenKey)
          const givenReason = typeof d.reason === 'string' ? d.reason.trim() : ''
          const reason = known
            ? givenReason
            : [givenReason, `project "${givenKey}" is not one this relay knows`].filter(Boolean).join(' — ')
          const raw = Array.isArray(d.paragraphs) ? d.paragraphs : []
          const kept = raw.filter((i) => Number.isInteger(i) && i >= 0 && i < paragraphs.length)
          dropped += raw.length - kept.length
          const title = typeof d.title === 'string' && d.title.trim()
            ? d.title.trim()
            : proposeTitle(draftAsk(paragraphs, kept))
          return {
            title, projectKey: known ? givenKey : '', paragraphs: kept, reason,
            goal: typeof d.goal === 'string' ? d.goal : '',
            openQuestions: Array.isArray(d.openQuestions) ? d.openQuestions : [],
          }
        })

        fanoutStore.setDrafts(runId, drafts)
        if (dropped) fanoutStore.update(runId, { error: `${dropped} paragraph indices out of range were dropped` })
        fanoutStore.finish(runId, 'ready')
        emit('fanout', { runs: fanoutStore.all() })
        return { ok: true }
      } catch (err) {
        process.stderr.write(`[scoping ${key}] fan-out failed: ${err?.stack || err}\n`)
        try { return fail(`the fan-out failed: ${String(err?.message ?? err).slice(0, 400)}`) } catch { return { ok: false } }
      }
    },

    /** Replaces an automatic title with a better one while nobody has typed
     *  over it. Silent: every failure leaves the automatic title in place. */
    async proposeAndRefine(requestId) {
      try {
        const r = store.get(requestId)
        const ask = String(r?.ask ?? '')
        if (!r || r.titleSource !== 'auto' || r.state !== 'draft' || ask.length < 80 || !claudeBin) return { ok: false }
        const key = `title:${requestId}`
        if (live.has(key)) return { ok: false }
        let title = ''
        const { code } = await runChild(key, titleArgv({ ask, safeMode }), process.cwd(), (frame) => {
          if (frame?.type === 'result') title = String(schemaPayload(frame)?.title ?? '').trim().slice(0, TITLE_MAX)
        })
        if (code !== 0 || !title) return { ok: false }
        const cur = store.get(requestId)
        if (!cur || cur.titleSource !== 'auto' || cur.state !== 'draft') return { ok: false }
        if (!store.retitle(requestId, title)) return { ok: false }
        pushDispatch()
        return { ok: true }
      } catch (err) {
        process.stderr.write(`[scoping title:${requestId}] refine failed: ${err?.stack || err}\n`)
        return { ok: false }
      }
    },

    /** Kills a `-p` child by its key; a bare request id reaches that request's
     *  bank and title children too. */
    kill(key) {
      let killed = false
      for (const k of [key, `bank:${key}`, `title:${key}`]) {
        const entry = live.get(k)
        if (!entry) continue
        try { entry.child.kill('SIGTERM') } catch {}
        finish(k)
        killed = true
      }
      return killed
    },

    killAll() {
      for (const [, entry] of [...live]) {
        clearTimeout(entry.timer)
        try { entry.child.kill('SIGTERM') } catch {}
      }
      live.clear()
    },
  }
}
