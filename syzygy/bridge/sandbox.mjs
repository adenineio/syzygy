// The sandbox ledger: a judgement about one gallery component -- its mark
// and every knob a viewer nudged -- that exists nowhere else and cannot be
// rebuilt from anything the running program still holds. So every write
// serializes FIRST, moves a corrupt file aside with a stderr line naming
// both paths, writes a temp file in the same directory and renames it over
// the target -- a failed serialize leaves the previous file exactly as it
// was. Nothing is ever removed except by the two caps below, oldest first.
// The reader sanitises so no consumer has to guard a hand-edited or
// half-written file.
//
// Every mutator builds the array it intends to write (`next`), calls
// `flush(next)`, and only on success assigns `items = next` -- a throw
// during `flush` (a circular field in a params patch, say) leaves both the
// file and the in-memory store exactly as they were.
//
// `mark` and `params` never change a component's identity: looking a
// component up by name finds the same entry every time, and only its marks
// history and its params object grow. Clearing a mark is still a mark -- it
// appends `{ mark: '', at }` to the history rather than erasing anything.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

/** The whole ledger, oldest entry first. A component registry is a fixed,
 *  small set -- this bounds a runaway caller, not real usage. */
export const SANDBOX_MAX = 200
/** Per entry. A judgement's history is a log, not the judgement itself, so
 *  it is bounded the same way a runaway caller could not exhaust it. */
export const MARK_HISTORY_MAX = 50
/** `''` is unmarked and is not one of these -- it is what a clear sets. */
export const MARKS = ['good', 'near', 'potential']
/** A component's params object, serialized. Nothing here bounds an
 *  individual field, so the cap is on the whole merged object. */
export const PARAMS_MAX_BYTES = 4096

const COMPONENT_MAX = 64

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// Control characters are stripped, not escaped -- these strings reach a JSON
// file and a browser row, never a place a newline would be meaningful.
const CONTROL_LINE = /[\x00-\x1f\x7f]/g

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

/** `'' -> good -> near -> potential -> ''`. Anything unrecognised (a
 *  hand-edited file, a stale client) is treated as `''` so the cycle can
 *  never wedge on a value it does not know. */
export const nextMark = (mark) => {
  const i = MARKS.indexOf(mark)
  if (i === -1) return MARKS[0]
  return MARKS[i + 1] ?? ''
}

const sanitizeComponent = (raw) => {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(CONTROL_LINE, '').trim().slice(0, COMPONENT_MAX)
  return cleaned || null
}

const sanitizeMark = (raw) => (typeof raw === 'string' && MARKS.includes(raw) ? raw : '')

const sanitizeMarkRow = (raw) => {
  if (!isPlainObject(raw)) return null
  const at = Number(raw.at)
  if (!Number.isFinite(at) || at <= 0) return null
  return { mark: sanitizeMark(raw.mark), at }
}

/** One stored entry, normalised, or null if it is not one. `component` is
 *  the only field a valid entry cannot do without -- there is nothing to
 *  key it by otherwise. Every other field degrades to a safe default rather
 *  than dropping the entry, so a partially hand-written row still loads. */
export const sanitizeEntry = (raw) => {
  if (!isPlainObject(raw)) return null
  const component = sanitizeComponent(raw.component)
  if (!component) return null
  const id = typeof raw.id === 'string' && raw.id ? raw.id.replace(CONTROL_LINE, '').slice(0, 40) : uid()
  const marks = Array.isArray(raw.marks) ? raw.marks.map(sanitizeMarkRow).filter(Boolean) : []
  const createdAt = Number(raw.createdAt)
  const updatedAt = Number(raw.updatedAt)
  return {
    id,
    component,
    mark: sanitizeMark(raw.mark),
    marks,
    params: isPlainObject(raw.params) ? raw.params : {},
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
  }
}

/** A missing file is the normal first run. A file that exists but is
 *  corrupt degrades to "no entries" here and is moved aside by the next
 *  write, never silently overwritten. */
export const readSandbox = (file) => {
  let doc
  try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch { return [] }
  const raw = Array.isArray(doc?.sandbox) ? doc.sandbox : []
  const out = []
  for (const r of raw) {
    const e = sanitizeEntry(r)
    if (e) out.push(e)
  }
  return out
}

const corrupt = (file) => {
  if (!existsSync(file)) return false
  try { JSON.parse(readFileSync(file, 'utf8')); return false } catch { return true }
}

/** `createSandbox({ file, now })`. */
export const createSandbox = ({ file, now = Date.now }) => {
  let items = readSandbox(file)

  /** Writes `next` (defaulting to the current `items`). Serializes FIRST:
   *  if `JSON.stringify` throws, nothing below has run and the previous
   *  file is still the previous file. Callers assign `items = next` only
   *  after this returns -- a throw here must never poison what is held in
   *  memory. */
  const flush = (next = items) => {
    const body = JSON.stringify({ version: 1, sandbox: next }, null, 2)
    const tmp = file + '.tmp'
    try {
      mkdirSync(dirname(file), { recursive: true })
      if (corrupt(file)) {
        // NOT swallowed: if the aside cannot be made, falling through to the
        // rename would destroy the very file the aside was protecting.
        const aside = file + '.corrupt-' + now()
        renameSync(file, aside)
        console.error(`sandbox: ${file} would not parse; moved aside to ${aside}`)
      }
      writeFileSync(tmp, body)
      renameSync(tmp, file)
    } catch (err) {
      try { unlinkSync(tmp) } catch {}
      throw err
    }
  }

  /** Inserts a brand-new entry, evicting the oldest one at a time if the
   *  cap is exceeded -- so a run of unique components fills the ledger from
   *  the front exactly as a FIFO would, one eviction per insert rather than
   *  a single truncation at the end. */
  const insert = (entry) => {
    let next = [...items, entry]
    if (next.length > SANDBOX_MAX) next = next.slice(next.length - SANDBOX_MAX)
    return next
  }

  const replace = (component, entry) => items.map((e) => (e.component === component ? entry : e))

  return {
    all: () => items,
    get: (component) => items.find((e) => e.component === component) ?? null,

    /** Takes exactly one of `mark` or `cycle` -- never both, never neither
     *  -- and refuses by name before anything is created or written.
     *  `mark` may be `''` (a clear); `cycle` asks the store for the next
     *  mark in its own rotation rather than trusting a caller's copy of it.
     *  Every change, including a clear, appends `{ mark, at: now() }` to
     *  the history -- nothing is ever removed from it except by the cap.
     *  Returns `{ ok: true, entry }` or `{ ok: false, error }`, never
     *  throws for a refusal. */
    mark(componentRaw, opts = {}) {
      const o = isPlainObject(opts) ? opts : {}
      const hasMark = o.mark !== undefined
      const hasCycle = o.cycle === true
      if (hasMark && hasCycle) return { ok: false, error: 'give a mark or ask to cycle, not both' }
      if (!hasMark && !hasCycle) return { ok: false, error: 'give a mark or ask to cycle' }

      const component = sanitizeComponent(componentRaw)
      if (!component) return { ok: false, error: 'component is required' }

      const existing = items.find((e) => e.component === component) ?? null

      let markValue
      if (hasCycle) {
        markValue = nextMark(existing ? existing.mark : '')
      } else {
        const m = typeof o.mark === 'string' ? o.mark : String(o.mark)
        if (m !== '' && !MARKS.includes(m)) return { ok: false, error: `unrecognised mark '${m}'` }
        markValue = m
      }

      const at = now()
      const history = [...(existing ? existing.marks : []), { mark: markValue, at }]
      const marks = history.length > MARK_HISTORY_MAX
        ? history.slice(history.length - MARK_HISTORY_MAX)
        : history

      const entry = {
        id: existing ? existing.id : uid(),
        component,
        mark: markValue,
        marks,
        params: existing ? existing.params : {},
        createdAt: existing ? existing.createdAt : at,
        updatedAt: at,
      }

      const next = existing ? replace(component, entry) : insert(entry)
      flush(next)
      items = next
      return { ok: true, entry }
    },

    /** Shallow-merges `patch` onto the component's `params`, creating the
     *  entry if it is absent. Refuses a patch that is not a plain object,
     *  and refuses a merge whose serialized size would exceed
     *  `PARAMS_MAX_BYTES` -- either way nothing is created or written. A
     *  patch containing a value `JSON.stringify` cannot serialize (a
     *  circular reference) throws out of that same size check rather than
     *  being swallowed by it. */
    params(componentRaw, patch) {
      if (!isPlainObject(patch)) return { ok: false, error: 'params must be an object' }
      const component = sanitizeComponent(componentRaw)
      if (!component) return { ok: false, error: 'component is required' }

      const existing = items.find((e) => e.component === component) ?? null
      const merged = { ...(existing ? existing.params : {}), ...patch }
      if (JSON.stringify(merged).length > PARAMS_MAX_BYTES) {
        return { ok: false, error: 'params too large' }
      }

      const at = now()
      const entry = existing
        ? { ...existing, params: merged, updatedAt: at }
        : { id: uid(), component, mark: '', marks: [], params: merged, createdAt: at, updatedAt: at }

      const next = existing ? replace(component, entry) : insert(entry)
      flush(next)
      items = next
      return { ok: true, entry }
    },

    flush,
  }
}
