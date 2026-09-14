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
import { DEFAULT_NIGHT } from './usage.mjs'

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

/** The scheduled kinds. `resume` prompts a session THIS relay still has
 *  registered, through the same queued command a `prompt` entry uses -- it
 *  never reaches for a transcript, and resuming a session that is gone is
 *  still not a thing this queue does. `spawn` starts a new session in a
 *  directory through the canvas's own spawn path. The route above the store
 *  is still where a 400 for anything else comes from. */
export const KINDS = ['prompt', 'implement', 'plan', 'resume', 'spawn']

/** The windows a standing resume arm may watch. */
export const RESUME_WINDOWS = ['fiveHour', 'sevenDay']

export const STATES = ['pending', 'fired', 'failed', 'cancelled']

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** "HH:MM", hour 00-23, minute 00-59. A bad time must be REFUSED, not
 *  coerced: a night-window check reads a malformed window as "never night",
 *  so a silently-coerced value would leave night hours quietly off. */
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const inRange = (v, lo, hi) => Number.isFinite(Number(v)) && Number(v) > lo && Number(v) <= hi

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
  // Out of the try so both `items` and `settingsRaw` below can read it: a
  // genuine parse failure never assigns it (the throw happens before the
  // assignment completes), so both fall back to empty exactly when the
  // existing .corrupt-<t> quarantine below kicks in.
  let raw

  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
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

  /** Held whole and written back whole, so a key this build does not know --
   *  one a later branch added -- survives our save. Only `settings.night` is
   *  interpreted here. */
  let settingsRaw = isPlainObject(raw?.settings) ? raw.settings : {}

  const get = (id) => items.find((e) => e.id === id) ?? null

  /** Always complete: a field absent from disk reads as its default, so no
   *  consumer ever has to guard. Its own closure rather than a method call,
   *  so setNight can read the current, validated block without going
   *  through the returned object. */
  const readNight = () => {
    const n = isPlainObject(settingsRaw.night) ? settingsRaw.night : {}
    return {
      enabled: n.enabled === true,
      start: TIME_RE.test(n.start) ? n.start : DEFAULT_NIGHT.start,
      end: TIME_RE.test(n.end) ? n.end : DEFAULT_NIGHT.end,
      budgetUsd: inRange(n.budgetUsd, 0, 500) ? Number(n.budgetUsd) : DEFAULT_NIGHT.budgetUsd,
      maxHours: inRange(n.maxHours, 0, 24) ? Number(n.maxHours) : DEFAULT_NIGHT.maxHours,
    }
  }

  /** One exclusion, sanitised. `until` is the reset it was made against, so an
   *  exclusion dies with its episode: one that outlived it would silently
   *  suppress a later reset, which is this feature's worst failure. */
  const cleanExclusion = (e) => (
    isPlainObject(e) && typeof e.id === 'string' && Number.isFinite(e.until)
      ? { id: e.id, name: typeof e.name === 'string' ? e.name : '', until: Number(e.until) }
      : null
  )

  const cleanEpisode = (e) => (
    isPlainObject(e) && WINDOWS.includes(e.window)
      && Number.isFinite(e.resetsAt) && Number.isFinite(e.spentAt)
      ? { window: e.window, resetsAt: Number(e.resetsAt), spentAt: Number(e.spentAt), pct: Number(e.pct) || 0 }
      : null
  )

  /** Always complete: a field absent from disk reads as its default, so no
   *  consumer ever has to guard. Expired exclusions are dropped AS READ, the
   *  same drop-or-coerce invariant sanitizeEntry establishes for items. */
  const readResume = () => {
    const r = isPlainObject(settingsRaw.resume) ? settingsRaw.resume : {}
    const windows = Array.isArray(r.windows)
      ? r.windows.filter((w) => WINDOWS.includes(w))
      : []
    return {
      armed: r.armed === true,
      since: Number.isFinite(r.since) ? Number(r.since) : null,
      by: r.by === 'toggle' || r.by === 'orchestrator' ? r.by : null,
      windows: windows.length ? windows : ['fiveHour'],
      excluded: (Array.isArray(r.excluded) ? r.excluded : [])
        .map(cleanExclusion).filter((e) => e && e.until > now()),
      episode: cleanEpisode(r.episode),
    }
  }

  const writeResume = (next) => {
    settingsRaw = { ...settingsRaw, resume: { ...(isPlainObject(settingsRaw.resume) ? settingsRaw.resume : {}), ...next } }
    dirty = true
  }

  const flush = () => {
    if (!dirty) return
    // Serialize FIRST. If this throws, nothing has been written and the
    // previous file is still the previous file.
    const text = JSON.stringify({ version: 1, items, settings: settingsRaw })
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
    markFired(id, { ok, error = null, payload = null } = {}) {
      const e = get(id)
      if (!e || e.state !== 'pending') return null
      e.state = ok ? 'fired' : 'failed'
      e.firedAt = now()
      e.error = ok ? null : String(error ?? 'unknown error')
      // MERGED, never replaced. The entry shape is fixed, and everything the
      // fire path learns -- a spawn record, the ids an implement could not
      // green-light -- rides in `payload`, alongside what create() put there.
      if (isPlainObject(payload)) e.payload = { ...e.payload, ...payload }
      dirty = true
      return e
    },

    /** A later write into an entry's payload, on an entry in ANY state --
     *  unlike markFired, this is not a state transition, so it never checks
     *  `pending` first. Used for facts that only become known well after an
     *  entry fired, such as when its spawned session actually stopped and
     *  why. Returns null for an unknown id or a patch that is not a plain
     *  object, so a caller can tell "nothing happened" from "it happened". */
    annotate(id, payloadPatch) {
      const e = get(id)
      if (!e || !isPlainObject(payloadPatch)) return null
      e.payload = { ...e.payload, ...payloadPatch }
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

    /** Always complete: a field absent from disk reads as its default, so no
     *  consumer ever has to guard. */
    settings() {
      return { night: readNight(), resume: readResume() }
    },

    /** A VALIDATED merge, the way requests.mjs validates its `dispatch`
     *  patch rather than Object.assign-ing it: every one of these becomes an
     *  argv token or a kill threshold. A rejected field names ITSELF and
     *  nothing is persisted -- a night policy someone believes they set and
     *  did not is the worst failure this feature could have. */
    setNight(patch = {}) {
      const next = { ...readNight() }
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue
        if (k === 'enabled') { next.enabled = v === true; continue }
        if (k === 'start' || k === 'end') {
          if (!TIME_RE.test(v)) return { ok: false, field: k, error: `${k} must be "HH:MM" between 00:00 and 23:59` }
          next[k] = String(v); continue
        }
        if (k === 'budgetUsd') {
          if (!inRange(v, 0, 500)) return { ok: false, field: k, error: 'budgetUsd must be a number above 0 and at most 500' }
          next.budgetUsd = Number(v); continue
        }
        if (k === 'maxHours') {
          if (!inRange(v, 0, 24)) return { ok: false, field: k, error: 'maxHours must be a number above 0 and at most 24' }
          next.maxHours = Number(v); continue
        }
        return { ok: false, field: k, error: `unknown night setting ${JSON.stringify(k)}` }
      }
      settingsRaw = { ...settingsRaw, night: { ...(isPlainObject(settingsRaw.night) ? settingsRaw.night : {}), ...next } }
      dirty = true
      return { ok: true, night: next }
    },

    /** A VALIDATED merge, the way setNight is: every field here decides
     *  whether a session gets prompted, and a policy someone believes they set
     *  and did not is the worst failure this feature could have. `since` is
     *  stamped by the arm itself and is never taken from a patch. */
    setResume(patch = {}) {
      const next = { ...readResume() }
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue
        if (k === 'armed') {
          const on = v === true
          if (on && !next.armed) next.since = now()
          if (!on) { next.since = null; next.by = null }
          next.armed = on
          continue
        }
        if (k === 'by') {
          if (v !== 'toggle' && v !== 'orchestrator') return { ok: false, field: k, error: 'by must be toggle or orchestrator' }
          next.by = v; continue
        }
        if (k === 'windows') {
          if (!Array.isArray(v) || !v.length || v.some((w) => !WINDOWS.includes(w))) {
            return { ok: false, field: k, error: `windows must be a non-empty list of ${RESUME_WINDOWS.join(', ')}` }
          }
          next.windows = [...new Set(v)]; continue
        }
        if (k === 'exclude') {
          const e = cleanExclusion(v)
          if (!e) return { ok: false, field: k, error: 'exclude needs { id, until }' }
          next.excluded = [...next.excluded.filter((x) => x.id !== e.id), e]
          continue
        }
        if (k === 'include') {
          if (typeof v !== 'string') return { ok: false, field: k, error: 'include must be a session id' }
          next.excluded = next.excluded.filter((x) => x.id !== v)
          continue
        }
        return { ok: false, field: k, error: `unknown resume setting ${JSON.stringify(k)}` }
      }
      writeResume(next)
      return { ok: true, resume: next }
    },

    /** The relay's own write. The open episode is persisted because a restart
     *  between the limit and the reset is the ordinary case at three in the
     *  morning, and an episode lost is a fleet never resumed. */
    setEpisode(episode) {
      writeResume({ ...readResume(), episode: cleanEpisode(episode) })
      return readResume().episode
    },

    flush,
  }
}
