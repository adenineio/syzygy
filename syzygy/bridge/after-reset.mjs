// The after-reset queue: work that fires once the account's 5-hour or 7-day
// usage window rolls over. Modelled on requests.mjs -- same file, same
// reasoning: AUTHORITATIVE, not derived. A brief here exists nowhere else, so
// every write serializes first, goes to a temp file in the same directory,
// and is renamed over the target; a serialize that throws leaves the
// previous file untouched.
//
// What lives here is the API and the store: the scheduler in relay.mjs is
// the only consumer that fires an entry today, and the orchestrator agent
// drives it from the UI side.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

/** The two windows an entry can be armed against -- the same keys
 *  usage.mjs's parseUsage returns, kept identical on purpose so a queue entry
 *  and a usage reading can be compared with no translation layer. */
export const WINDOWS = ['fiveHour', 'sevenDay']

/** The platform's own spelling, accepted at the HTTP boundary and normalised
 * inward. `rate_limits` uses `five_hour`/`seven_day`, and this API documents
 *  an entry's `window` the same way, so a caller following either sends
 *  snake_case. Rejecting it would
 *  be a 400 on the documented shape; translating internally would put a
 *  mapping between an entry and a reading that are otherwise directly
 *  comparable. Mapping once, at the edge, costs neither. Identity entries are
 *  deliberate: one lookup handles both spellings with no `includes` first. */
export const WINDOW_ALIASES = {
  five_hour: 'fiveHour', seven_day: 'sevenDay',
  fiveHour: 'fiveHour', sevenDay: 'sevenDay',
}

/** `resume` is a RECOGNISED kind, not an unknown one refuses it at
 *  creation with a 400 that names it, precisely so it never reaches here.
 *  It is deliberately absent from this list: the store's own guard (below)
 *  is a backstop, not the place the user-facing reason lives. */
export const KINDS = ['prompt', 'implement']

export const STATES = ['pending', 'fired', 'failed', 'cancelled']

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A non-object entry, or one with a window/kind/state outside the known
 *  sets, is dropped or coerced rather than carried to a consumer that reaches
 *  into `.window`/`.state` unguarded -- the same invariant claims.mjs's
 *  readClaims establishes for its own entries, so a hand-edited
 *  after-reset.json degrades instead of taking the scheduler down with it. */
const sanitizeEntry = (e) => {
  if (!isPlainObject(e) || typeof e.id !== 'string') return null
  return {
    id: e.id,
    createdAt: Number.isFinite(e.createdAt) ? e.createdAt : 0,
    window: WINDOWS.includes(e.window) ? e.window : null,
    kind: KINDS.includes(e.kind) ? e.kind : null,
    target: typeof e.target === 'string' ? e.target : null,
    payload: isPlainObject(e.payload) ? e.payload : {},
    // Absent/non-numeric is the documented fallback in usage.mjs's
    // dueEntries: an entry with no armed boundary, e.g. one added by hand.
    armedResetsAt: Number.isFinite(e.armedResetsAt) ? e.armedResetsAt : null,
    state: STATES.includes(e.state) ? e.state : 'pending',
    firedAt: Number.isFinite(e.firedAt) ? e.firedAt : null,
    error: typeof e.error === 'string' ? e.error : null,
  }
}

export const createAfterResetStore = ({ file, now = Date.now }) => {
  /** @type {any[]} */ let items = []
  let dirty = false

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(raw?.items)) items = raw.items.map(sanitizeEntry).filter(Boolean)
    else throw new Error('after-reset.json has no items array')
  } catch (err) {
    items = []
    // a missing file is the ordinary first-run case and
    // costs nothing. A file that EXISTS but failed to parse is different --
    // this store is authoritative, so it is moved aside rather than silently
    // overwritten by the next flush.
    if (err.code !== 'ENOENT') {
      const aside = `${file}.corrupt-${now()}`
      try {
        renameSync(file, aside)
        process.stderr.write(`after-reset store: ${file} failed to load (${err.message}); moved aside to ${aside} and starting empty\n`)
      } catch (renameErr) {
        process.stderr.write(`after-reset store: ${file} failed to load (${err.message}); could not move it aside (${renameErr.message}) -- starting empty, original left in place\n`)
      }
    }
  }

  const get = (id) => items.find((e) => e.id === id) ?? null

  const flush = () => {
    if (!dirty) return
    // Serialize FIRST. If this throws, nothing has been written and the
    // previous file is still the previous file.
    const text = JSON.stringify({ version: 1, items })
    const tmp = file + '.tmp'
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, text)
      renameSync(tmp, file)
      dirty = false
    } catch (err) {
      try { unlinkSync(tmp) } catch {}
      throw err
    }
  }

  return {
    get dirty() { return dirty },
    all: () => items,
    get,

    /** `window`/`kind` are validated here too, as a backstop -- relay.mjs's
     *  route is where the 400 and its user-facing reason actually come from
     * but the store must never persist what the route failed to
     *  reject, in case a future caller reaches this directly. */
    create({ window, kind, target = null, payload = {}, armedResetsAt = null } = {}) {
      if (!WINDOWS.includes(window)) throw new Error(`window must be one of ${WINDOWS.join(', ')}`)
      if (kind === 'resume') throw new Error("kind 'resume' is not supported in this release; use 'prompt' or 'implement'")
      if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`)
      const e = {
        id: uid(),
        createdAt: now(),
        window, kind,
        target: typeof target === 'string' ? target : null,
        payload: isPlainObject(payload) ? payload : {},
        armedResetsAt: Number.isFinite(armedResetsAt) ? armedResetsAt : null,
        state: 'pending',
        firedAt: null,
        error: null,
      }
      items.push(e)
      dirty = true
      return e
    },

    /** The scheduler's own write, and the ONLY path that ever sets `fired` or
     *  `failed`. Refuses anything but a currently-pending entry, so a
     *  just-cancelled entry can never be resurrected by a due-check that
     *  raced the cancel. */
    markFired(id, { ok, error = null } = {}) {
      const e = get(id)
      if (!e || e.state !== 'pending') return null
      e.state = ok ? 'fired' : 'failed'
      e.firedAt = now()
      e.error = ok ? null : String(error ?? 'unknown error')
      dirty = true
      return e
    },

    /** The queue UI's remove button. A still-pending entry moves to
     *  'cancelled' rather than being deleted outright -- this store is
     *  authoritative history, not a scratch list, and 'cancelled' is one of
     *  the four states for exactly this transition. An entry that has already
     *  settled (fired, failed, or already cancelled) is left as it is: there
     *  is nothing left to cancel. Returns false only when the id is unknown. */
    cancel(id) {
      const e = get(id)
      if (!e) return false
      if (e.state === 'pending') {
        e.state = 'cancelled'
        e.firedAt = now()
        dirty = true
      }
      return true
    },

    /** Take a SETTLED entry off the list for good. `cancel` deliberately
     *  leaves a settled entry alone -- there is nothing left to call off --
     *  but the pane shows one REMOVE button per row, and on a fired or failed
     *  row that made it answer 200 and do nothing, which is the "confident
     *  wrong answer" this codebase refuses everywhere else. Cancelling is for
     *  work that has not happened; removing is for a record you are finished
     *  reading. A pending entry is never removed here -- it is cancelled
     *  first, so the scheduler cannot race a delete. */
    remove(id) {
      const i = items.findIndex((e) => e.id === id)
      if (i < 0 || items[i].state === 'pending') return false
      items.splice(i, 1)
      dirty = true
      return true
    },

    flush,
  }
}
