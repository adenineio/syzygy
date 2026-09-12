// The Dispatch tab's scoping engine: a streamed, resumable headless Claude
// conversation that turns a fuzzy ask into a structured handoff brief.
//
// Two halves. The pure one -- argv construction, NDJSON parsing, the preamble
// and the schema -- is exported and tested directly. The impure one owns child
// processes and is created with an injected `spawn` so the harness never runs
// a real `claude`.

import { spawn as realSpawn } from 'node:child_process'
import { HEADLESS_SETTINGS } from './canvas.mjs'
import { existsSync, statSync } from 'node:fs'

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

/** The argv for one scoping turn. The prompt is always the final single
 *  element, so no quoting, escaping or shell is involved anywhere. */
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

export const createScoper = ({
  store, broadcast,
  spawn = realSpawn,
  claudeBin = 'claude',
  // Whether the resolved binary understands `--safe-mode`, probed once at the
  // relay's boot (canvas.mjs's probeSafeMode). Defaults false so a caller that
  // has not probed never passes a flag its binary might refuse.
  safeMode = false,
  maxConcurrent = 3,
  budgetUsd = 2,
  timeoutMs = 600_000,
  now = Date.now,
}) => {
  /** requestId -> { child, timer } */
  const live = new Map()

  const finish = (requestId) => {
    const entry = live.get(requestId)
    if (!entry) return
    clearTimeout(entry.timer)
    live.delete(requestId)
  }

  /** Run one turn. `onFrame` sees every parsed stdout object. Resolves with the
   *  exit code once the child closes -- or, on a spawn failure, with a
   *  synthetic non-zero code so every caller's existing "code !== 0" handling
   *  covers this path too, with no separate error branch to maintain. */
  const run = (requestId, argv, cwd, onFrame) =>
    new Promise((resolve) => {
      // 'error' and 'close' are independent events -- a failed spawn can fire
      // 'error' alone, or (rarely) both -- so resolve must run exactly once
      // regardless of which arrives first. `settle` is that single gate.
      let settled = false
      const settle = (result) => {
        if (settled) return
        settled = true
        finish(requestId)
        resolve(result)
      }

      // Check the cwd BEFORE spawning. node reports a missing cwd as
      // `spawn <bin> ENOENT` -- indistinguishable from the BINARY being
      // missing -- and that is exactly what a request carrying a bare repo
      // name produced: an error naming `claude` for a fault in the project
      // field. The message has to say which of the two it is.
      if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
        return settle({ code: 1, errText: `project directory does not exist: ${cwd || '(none)'}` })
      }

      let child
      try {
        child = spawn(claudeBin, argv, { cwd, env: process.env })
      } catch (err) {
        // node:child_process's spawn() can throw synchronously for a
        // malformed options/argv shape (distinct from ENOENT, which arrives
        // asynchronously as 'error' below). scopeArgv always returns an
        // array of strings and cwd is a caller-supplied string, so this is
        // not expected on this code path today -- guarded anyway, for the
        // same reason as 'error': a spawn failure must never become an
        // uncaught exception inside the long-lived relay process every
        // session's dashboard depends on.
        resolve({ code: -1, errText: `spawn threw: ${err?.message ?? err}` })
        return
      }

      const timer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch {}
        store.update(requestId, { error: { at: now(), phase: 'scoping', message: `timed out after ${timeoutMs} ms` } })
      }, timeoutMs)
      timer.unref?.()
      live.set(requestId, { child, timer })

      let buf = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        // parseNdjson now lets a consumer's (onFrame's) exception propagate --
        // correct for the parser, but this callback runs inside a stream
        // 'data' event, where an uncaught exception is fatal to the whole
        // process. The boundary guards here, not the parser, so one bad frame
        // takes down one scoping conversation instead of the entire relay
        // (and every session's dashboard with it).
        try {
          buf = parseNdjson(buf + chunk, onFrame)
        } catch (err) {
          process.stderr.write(`[scoping ${requestId}] onFrame threw: ${err?.stack || err}\n`)
        }
      })
      let errText = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { errText += chunk })

      // A spawn failure (wrong claudeBin, ENOENT, EACCES, ...) surfaces here,
      // asynchronously, on a path separate from 'close'. With no 'error'
      // listener, EventEmitter's default behaviour re-throws it as an
      // uncaught exception -- fatal to this long-lived relay process, taking
      // down every session's dashboard over one misconfigured or missing
      // `claude` binary. Resolve rather than reject: every caller of run()
      // already treats a non-zero code as an ordinary failure via the same
      // branch 'close' uses, and a rejection here would surface instead as
      // an unhandled rejection in the HTTP handler.
      child.on('error', (err) => {
        settle({ code: -1, errText: `spawn failed: ${err.message}` })
      })
      child.on('close', (code) => {
        settle({ code, errText })
      })
    })

  return {
    active: () => live.size,

    async start(requestId, text, cwd) {
      const r = store.get(requestId)
      if (!r) return { ok: false, error: 'unknown request', code: 404 }
      if (live.has(requestId)) return { ok: false, error: 'a turn is already running', code: 409 }
      if (live.size >= maxConcurrent) {
        return { ok: false, error: `at most ${maxConcurrent} scoping conversations at once`, code: 429 }
      }

      // The request store is mutated as frames arrive, but the client only
      // learns about it through 'dispatch' snapshots -- the 'scope' event
      // carries no turn text. Every store.update
      // that changes what the thread panel renders must be paired with one
      // of these, or the panel sits frozen on stale turns until some other,
      // unrelated 'dispatch' broadcast happens to fire.
      const pushDispatch = () => broadcast('dispatch', { requests: store.all() })

      const scoping = r.scoping ?? { sessionId: null, turns: [], costUsd: 0 }
      scoping.turns = [...scoping.turns, { role: 'user', text, t: now() }]
      // `busy` rides on the REQUEST, not only on the `scope` broadcast. The
      // pane's "…thinking" used to be a local flag set on `turn-start` and
      // cleared on `turn-end`, so a completion that arrived as a request
      // update rather than as a stream frame left it spinning forever --
      // observed live on request 07108me2vxp9, which reached state `scoped`
      // with its answer stored while the pane still said thinking. State the
      // fact where the state already is.
      scoping.busy = true
      store.update(requestId, { scoping, error: null })
      broadcast('scope', { requestId, event: { type: 'turn-start' } })
      pushDispatch()

      const argv = scopeArgv({ text, sessionId: scoping.sessionId, budgetUsd, safeMode })
      run(requestId, argv, cwd, (frame) => {
        // The first system frame carries the session id, which is what makes
        // the next turn a resume and what the take-over command needs.
        if (frame.type === 'system' && frame.session_id) {
          const s = store.get(requestId)?.scoping ?? scoping
          store.update(requestId, { scoping: { ...s, sessionId: frame.session_id } })
          pushDispatch()
        }
        if (frame.type === 'assistant') {
          const text = (frame.message?.content ?? [])
            .filter((c) => c.type === 'text').map((c) => c.text).join('')
          if (text) {
            const s = store.get(requestId)?.scoping ?? scoping
            store.update(requestId, { scoping: { ...s, turns: [...s.turns, { role: 'assistant', text, t: now() }] } })
            // no `dispatch` (whole-queue) broadcast per
            // assistant frame -- a long conversation would re-broadcast the
            // whole queue per token, and on the pane that reaches
            // renderQueue()'s replaceChildren() and blanks an open brief
            // editor. The 'scope' broadcast just below still fires every
            // frame for the thread panel; the queue only needs a `dispatch`
            // broadcast at turn end (below, in .then()) and on bank
            // (relay.mjs's /api/scope/bank).
          }
        }
        if (frame.type === 'result' && typeof frame.total_cost_usd === 'number') {
          const s = store.get(requestId)?.scoping ?? scoping
          store.update(requestId, { scoping: { ...s, costUsd: frame.total_cost_usd } })
        }
        broadcast('scope', { requestId, event: frame })
      }).then(({ code, errText }) => {
        // Cleared FIRST, and unconditionally: whatever else this turn did or
        // failed to do, it is over.
        const s = store.get(requestId)?.scoping
        if (s) store.update(requestId, { scoping: { ...s, busy: false } })
        if (code !== 0) {
          store.update(requestId, { error: { at: now(), phase: 'scoping', message: (errText || `exit ${code}`).slice(0, 400) } })
        } else if (store.get(requestId)?.state === 'draft') {
          try { store.transition(requestId, 'scoped') } catch {}
        }
        broadcast('scope', { requestId, event: { type: 'turn-end', code } })
        pushDispatch()
      })

      return { ok: true }
    },

    /** One resumed turn asking for the brief under BRIEF_SCHEMA. */
    async bank(requestId, cwd) {
      const r = store.get(requestId)
      if (!r) return { ok: false, error: 'unknown request', code: 404 }
      const sessionId = r.scoping?.sessionId
      if (!sessionId) return { ok: false, error: 'nothing has been scoped yet', code: 409 }

      const argv = scopeArgv({
        text: 'Emit the handoff brief for everything we settled.',
        sessionId, budgetUsd, schema: BRIEF_SCHEMA, safeMode,
      })
      let payload = null
      const { code, errText } = await run(requestId, argv, cwd, (frame) => {
        if (frame.type === 'result') payload = frame.result ?? frame.structured ?? null
      })
      if (code !== 0) {
        const message = (errText || `exit ${code}`).slice(0, 400)
        store.update(requestId, { error: { at: now(), phase: 'bank', message } })
        return { ok: false, error: message }
      }

      let brief = payload
      if (typeof brief === 'string') { try { brief = JSON.parse(brief) } catch { brief = null } }
      const bad = validateBrief(brief)
      if (bad) {
        store.update(requestId, { error: { at: now(), phase: 'bank', message: bad } })
        broadcast('scope', { requestId, event: { type: 'bank-failed', message: bad } })
        return { ok: false, error: bad }
      }

      store.update(requestId, { brief: normaliseBrief(brief), error: null })
      // C2: the request can be deleted while this turn was in flight (a bank
      // turn runs for minutes and the queue row's delete button is always
      // enabled) -- store.get(requestId) then returns null, and `.state` on
      // it was the only unguarded `store.get(...).` dereference in the tree,
      // throwing a TypeError inside an async HTTP handler with no try/catch
      // and taking the whole relay process down. `?.` makes this a no-op:
      // the store.transition() call below already throws "no such request"
      // for a deleted id, already caught by its own try/catch.
      if (store.get(requestId)?.state !== 'queued') {
        try { store.transition(requestId, 'queued') } catch {}
      }
      broadcast('scope', { requestId, event: { type: 'banked' } })
      return { ok: true }
    },

    kill(requestId) {
      const entry = live.get(requestId)
      if (!entry) return false
      try { entry.child.kill('SIGTERM') } catch {}
      finish(requestId)
      return true
    },

    killAll() {
      for (const [, entry] of live) {
        clearTimeout(entry.timer)
        try { entry.child.kill('SIGTERM') } catch {}
      }
      live.clear()
    },
  }
}
