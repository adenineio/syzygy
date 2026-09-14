// The drop job store: one durable record per side of a drop
// (`WORLD_DIR/peer-jobs.json`). A job churns on every chunk a transfer moves,
// so it lives in its own file rather than beside the pairing secrets or the
// ask log in peers-store.mjs -- one churning store must never carry the other
// two's rewrite cost.
//
// AUTHORITATIVE, not derived: a drop's job exists nowhere else, so every write
// serializes first, goes to a temp file in the same directory and is renamed
// over the target, and a file that exists but will not parse is moved aside
// rather than overwritten by the next flush.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { JOB_EDGES, canJobTransition, isTerminalJob, STALL_MS, DROP_FILE_CAP } from './peer.mjs'

export const JOBS_FILE = 'peer-jobs.json'

const DROP_ID_RE = /^[0-9a-f]{16,64}$/
const HEX64_RE = /^[0-9a-f]{64}$/
const JOB_KEEP_PER_PEER = 500
const REFUSED_MAX = 50

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const strOrNull = (v) => (typeof v === 'string' ? v : null)
const numOrNull = (v) => (Number.isFinite(v) ? v : null)
const bool = (v) => v === true
const numNonNeg = (v) => (Number.isFinite(v) && v >= 0 ? v : 0)
const triState = (v) => (v === true ? true : v === false ? false : null)

/** One stderr line either way. If the rename itself fails the original is
 *  left where it is, and the caller still starts empty. */
const moveAside = (label, file, err, now) => {
  const aside = `${file}.corrupt-${now()}`
  try {
    renameSync(file, aside)
    process.stderr.write(`${label}: ${file} failed to load (${err.message}); moved aside to ${aside} and starting empty\n`)
  } catch (renameErr) {
    process.stderr.write(`${label}: ${file} failed to load (${err.message}); could not move it aside (${renameErr.message}) -- starting empty, original left in place\n`)
  }
}

/** A manifest row, coerced field by field: an unreadable size or a malformed
 *  hash is dropped rather than trusted, the same way a bad ask entry is. */
const sanitizeFileRow = (f) =>
  isPlainObject(f) && typeof f.path === 'string' && f.path.length > 0 && Number.isSafeInteger(f.size) && f.size >= 0
    ? { path: f.path, size: f.size, sha256: typeof f.sha256 === 'string' && HEX64_RE.test(f.sha256) ? f.sha256 : null, mode: Number.isInteger(f.mode) ? f.mode & 0o777 : null }
    : null
const filesOf = (v) => (Array.isArray(v) ? v.map(sanitizeFileRow).filter(Boolean) : [])

/** The other side's last reported state, carried across on a heartbeat: a
 *  label, a reason and when it was heard, never trusted further than that. */
const remoteOf = (v) =>
  isPlainObject(v) && typeof v.state === 'string' && v.state
    ? { state: v.state.slice(0, 32), reason: typeof v.reason === 'string' ? v.reason.slice(0, 2000) : null, at: numOrNull(v.at) }
    : null

/** The resume bookmark a chunked transfer records on every chunk: which file,
 *  and how many bytes of it are already accounted for. */
const progressOf = (v) =>
  isPlainObject(v) && Number.isSafeInteger(v.fileIdx) && v.fileIdx >= 0 && Number.isSafeInteger(v.offset) && v.offset >= 0
    ? { fileIdx: v.fileIdx, offset: v.offset }
    : null

/** A path dropped from the drop rather than sent: named with why, never with
 *  the whole selection it came from. Capped so one drop with hundreds of
 *  refusals cannot bloat every later read of the job; `refusedCount` (below)
 *  is the true total, so a row past the cap is still counted. */
const sanitizeRefusedRow = (r) =>
  isPlainObject(r) && (typeof r.path === 'string' || r.path === null) && typeof r.reason === 'string'
    ? { path: r.path, reason: r.reason.slice(0, 500) }
    : null
const refusedPathsOf = (v) => (Array.isArray(v) ? v.map(sanitizeRefusedRow).filter(Boolean).slice(0, REFUSED_MAX) : [])
const refusedCountOf = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0)

/** Where each file of a send job was selected from, so a relay that restarts
 *  before the filter has run can stage the drop again. It stays on this
 *  machine: no payload row and no manifest carries it, and it is emptied once
 *  the filter has run. */
const sourceRowOf = (r) =>
  isPlainObject(r) && typeof r.path === 'string' && r.path.length > 0 && typeof r.abs === 'string' && r.abs.startsWith('/')
    ? { path: r.path, abs: r.abs }
    : null
const sourcesOf = (v) => (Array.isArray(v) ? v.map(sourceRowOf).filter(Boolean).slice(0, DROP_FILE_CAP) : [])

/** The files of a received drop that have already failed their sha256 once
 *  and been asked for again, by index, each once. Durable, so a restart
 *  between the two attempts cannot grant a third. */
const retriedOf = (v) =>
  Array.isArray(v) ? [...new Set(v.filter((i) => Number.isSafeInteger(i) && i >= 0))].slice(0, DROP_FILE_CAP) : []

/** Every state a side's ladder may rest in: the ones with outgoing edges, plus
 *  that side's terminals. */
const STATES = {
  send: [...Object.keys(JOB_EDGES.send), 'sent', 'refused', 'failed'],
  recv: [...Object.keys(JOB_EDGES.recv), 'landed', 'refused', 'failed'],
}

/** How each patchable field is coerced, shared by load and by every write, so
 *  an entry in memory never holds a value the next load would read back
 *  differently. */
const FIELDS = {
  files: filesOf,
  bytes: numNonNeg,
  sent: numNonNeg,
  filtered: triState,
  filterReason: strOrNull,
  note: strOrNull,
  reason: strOrNull,
  error: strOrNull,
  pinned: bool,
  remote: remoteOf,
  progress: progressOf,
  refusedPaths: refusedPathsOf,
  refusedCount: refusedCountOf,
  staged: bool,
  sources: sourcesOf,
  retried: retriedOf,
  landed: filesOf,
}
const FIELD_KEYS = Object.keys(FIELDS)
// A state transition may carry every field except `pinned`: the row's own
// toggle never rides a state change, so it cannot be reset by one.
const TRANSITION_KEYS = FIELD_KEYS.filter((k) => k !== 'pinned')

/** What should happen to a non-terminal job at boot, state by state. */
const RESUME_ACTION = {
  send: { queued: 'requeue', filtering: 'refilter', offering: 'reoffer', sending: 'reoffer' },
  recv: { offered: 'wait', receiving: 'wait', verifying: 'reverify', filtering: 'reverify' },
}

/** An entry a consumer would reach into unguarded -- no id, no dropId, an
 *  unknown side, or a state that side's ladder cannot be in -- is dropped.
 *  Everything else is coerced field by field. */
const sanitizeEntry = (e) => {
  if (!isPlainObject(e) || typeof e.id !== 'string' || typeof e.dropId !== 'string' || !DROP_ID_RE.test(e.dropId)) return null
  if (typeof e.peer !== 'string' || e.peer === '') return null
  if (!Object.hasOwn(STATES, e.side) || !STATES[e.side].includes(e.state)) return null
  const out = { id: e.id, dropId: e.dropId, peer: e.peer, side: e.side, state: e.state, t: numOrNull(e.t), updatedAt: numOrNull(e.updatedAt) }
  for (const k of FIELD_KEYS) out[k] = FIELDS[k](e[k])
  return out
}

const applyPatch = (e, patch, keys) => {
  if (!isPlainObject(patch)) return
  for (const k of keys) if (Object.hasOwn(patch, k)) e[k] = FIELDS[k](patch[k])
}

export const createJobsStore = ({ file, now = Date.now }) => {
  /** @type {any[]} */ let items = []
  let dirty = false

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(raw?.items)) {
      items = raw.items.map(sanitizeEntry).filter(Boolean)
    } else {
      throw new Error('peer-jobs.json has no items array')
    }
  } catch (err) {
    items = []
    // A missing file is the ordinary first run. A file that EXISTS but failed
    // to parse is moved aside rather than silently overwritten by the next
    // flush.
    if (err.code !== 'ENOENT') moveAside('peer jobs store', file, err, now)
  }

  const get = (id) => items.find((e) => e.id === id) ?? null
  const find = (dropId, side) => items.find((e) => e.dropId === dropId && (side === undefined || e.side === side)) ?? null

  const must = (id) => {
    const e = get(id)
    if (!e) throw new Error(`no such job ${id}`)
    return e
  }

  const freshId = () => {
    let id
    do id = randomBytes(8).toString('hex')
    while (get(id))
    return id
  }

  /** Keeps the newest jobs for one peer by `t`, a later position breaking a
   *  tie. Only a TERMINAL job is ever dropped: one still moving stays, even
   *  past the cap, because it is the only record of bytes in flight. */
  const prune = (peer) => {
    const mine = items.map((e, i) => [e, i]).filter(([e]) => e.peer === peer)
    if (mine.length <= JOB_KEEP_PER_PEER) return []
    mine.sort(([a, ai], [b, bi]) => (b.t ?? 0) - (a.t ?? 0) || bi - ai)
    const drop = new Set(mine.slice(JOB_KEEP_PER_PEER).map(([e]) => e).filter((e) => isTerminalJob(e.state)))
    if (drop.size === 0) return []
    items = items.filter((e) => !drop.has(e))
    dirty = true
    return [...drop]
  }

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
    find,

    /** Mints a job for one side of a drop. The send side starts `queued`; the
     *  receive side starts `offered`, because a record only exists there once
     *  the sender has already offered it something to accept or refuse.
     *  `dropId` joins the two sides' records: the sender mints a fresh one
     *  when it does not have one yet, and the receiver is always handed the
     *  sender's. */
    create({ peer, side, dropId, files, bytes, note, pinned, refusedPaths, refusedCount, sources } = {}) {
      if (typeof peer !== 'string' || peer === '') throw new Error('a job needs a peer')
      if (side !== 'send' && side !== 'recv') throw new Error('a job must be send or recv')
      const drop = typeof dropId === 'string' && DROP_ID_RE.test(dropId) ? dropId : randomBytes(8).toString('hex')
      const t = now()
      const e = {
        id: freshId(),
        dropId: drop,
        peer,
        side,
        state: side === 'send' ? 'queued' : 'offered',
        files: filesOf(files),
        bytes: numNonNeg(bytes),
        sent: 0,
        filtered: null,
        filterReason: null,
        note: strOrNull(note),
        reason: null,
        error: null,
        pinned: bool(pinned),
        remote: null,
        progress: null,
        // The true count comes from the caller when given (the caller may
        // have capped the rows before this ever sees them); otherwise it is
        // just how many rows are here.
        refusedPaths: refusedPathsOf(refusedPaths),
        refusedCount: refusedCountOf(refusedCount ?? (Array.isArray(refusedPaths) ? refusedPaths.length : 0)),
        // True once staging has finished: from then on the staged copy is the
        // drop, and the sources are never read for it again.
        staged: false,
        sources: side === 'send' ? sourcesOf(sources) : [],
        retried: [],
        // What landed in the inbox, once a receive job has. Its `files` stay
        // the offer as it came, which is what a sender asking again is
        // answered from.
        landed: [],
        t,
        updatedAt: t,
      }
      items.push(e)
      dirty = true
      prune(peer)
      return e
    },

    /** The only path that changes `state`. An edge the side does not have
     *  throws before anything is touched, patch included; `refused` and
     *  `failed` each require the field that names why. */
    transition(id, to, patch = {}) {
      const e = must(id)
      if (!canJobTransition(e.side, e.state, to)) throw new Error(`illegal job transition ${e.side} ${e.state} -> ${to}`)
      if (to === 'refused' && !(isPlainObject(patch) && typeof patch.reason === 'string' && patch.reason)) {
        throw new Error('a refused job needs a reason')
      }
      if (to === 'failed' && !(isPlainObject(patch) && typeof patch.error === 'string' && patch.error)) {
        throw new Error('a failed job needs an error')
      }
      applyPatch(e, patch, TRANSITION_KEYS)
      e.state = to
      e.updatedAt = now()
      dirty = true
      return e
    },

    /** A chunk's resume bookmark, recorded on every chunk so a restart resumes
     *  from what was actually written, never from what the sender believed.
     *  Not a state change, but it is progress, so it holds off the stall
     *  sweep for a transfer that is simply long. */
    progress(id, p) {
      const e = must(id)
      e.progress = progressOf(p)
      e.updatedAt = now()
      dirty = true
      return e
    },

    /** Bookkeeping a transfer records as it goes -- bytes moved, the other
     *  side's last report, files asked for again -- without a state change.
     *  Neither `state` nor `pinned` is ever taken from it. */
    set(id, patch) {
      const e = must(id)
      applyPatch(e, patch, TRANSITION_KEYS)
      dirty = true
      return e
    },

    /** The row's own toggle; never a state change. */
    pin(id, on) {
      const e = must(id)
      e.pinned = bool(on)
      dirty = true
      return e
    },

    prune,

    /** Every non-terminal state has an edge to `failed`, so this assigns the
     *  state directly rather than going through `transition`. */
    sweepStalled() {
      const t = now()
      const moved = []
      for (const e of items) {
        if (isTerminalJob(e.state) || t - (e.updatedAt ?? 0) <= STALL_MS) continue
        e.state = 'failed'
        e.error = 'stalled'
        e.updatedAt = t
        moved.push(e)
      }
      if (moved.length) dirty = true
      return moved
    },

    /** What should happen to every non-terminal job at boot, computed and
     *  never performed: the store decides, the engine acts. A terminal job
     *  needs nothing done and is left out of the plan entirely. */
    resumePlan() {
      const plan = []
      for (const e of items) {
        if (isTerminalJob(e.state)) continue
        const action = RESUME_ACTION[e.side]?.[e.state]
        if (!action) continue
        plan.push({ id: e.id, dropId: e.dropId, peer: e.peer, side: e.side, state: e.state, action })
      }
      return plan
    },

    flush,
  }
}
