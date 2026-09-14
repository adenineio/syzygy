// The pasteboard: prompts typed but deliberately not sent, ordered, reloadable
// into any live session's composer.
//
// AUTHORITATIVE, not derived: the moment the marker cancelled the submission
// the text existed nowhere else, and nothing can rebuild it. So every write
// serializes FIRST, goes to a temp file in the same directory, and is renamed
// over the target -- a failed serialize leaves the previous file exactly as it
// was. Same contract as findings.mjs, claims.mjs and requests.mjs, for the
// same reason. Write-through rather than on a 4 s tick, also like findings:
// entries arrive at human pace, so there is no write amplification to batch
// away, and a relay killed between a stash and a tick would lose the one thing
// that cannot be rebuilt.
//
// Every mutator builds the array it intends to write (`next`), calls
// `flush(next)`, and only on success assigns `items = next`. `move` and
// `reorder` build NEW entry objects for every changed `order` rather than
// mutating the current ones in place, so a throw during `flush` leaves both
// the file AND the in-memory board exactly as they were -- a cyclic field
// that makes `JSON.stringify` throw must not silently wedge the store into
// rejecting every later write too.
//
// Full boards REFUSE; they never evict. Dropping the oldest entry to make room
// for a new one would silently destroy the only copy of something somebody
// typed. A refusal is recoverable in one keystroke, because hud.tsx puts the
// draft back.
//
// Reading SANITISES rather than throws. The file is small and hand-editable,
// and it is written over HTTP by whatever a session decides to send.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

/** Per scope, not per file: filling one board must never cost you the other. */
export const PASTEBOARD_MAX_PER_SCOPE = 100
/** One entry. A pasted diff is legitimately large; a pasted repository is not. */
export const PASTEBOARD_MAX_TEXT = 32768
/** And a bound across both boards, so 200 maximal entries cannot make a 6 MB
 *  file the relay re-serializes on every stash. */
export const PASTEBOARD_MAX_TOTAL = 2 * 1024 * 1024
export const TITLE_MAX = 60
export const NAME_MAX = 120

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// Control characters are stripped, not escaped -- these strings reach a JSON
// file, a terminal row and a browser row. \t, \n and \r survive in `text`: a
// multi-line stash is the normal case and the whole point.
const CONTROL_ALL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
const CONTROL_LINE = /[\x00-\x1f\x7f]/g

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

/** One stored entry, normalised, or null if it is not one.
 *
 *  `text` is the only required field beyond identity: a row with nothing in it
 *  is not a stash. Unknown fields are KEPT -- the file is documented as
 *  hand-editable, and a note somebody added by hand must survive the next
 *  write. */
export const sanitizeEntry = (raw, fallbackOrder = 0) => {
  if (!isPlainObject(raw)) return null
  const text = typeof raw.text === 'string' ? raw.text.replace(CONTROL_ALL, '') : ''
  if (!text.trim()) return null
  const id = typeof raw.id === 'string' && raw.id ? raw.id.replace(CONTROL_LINE, '').slice(0, 40) : ''
  if (!id) return null
  const createdAt = Number(raw.createdAt)
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null
  const order = Number(raw.order)
  const title = typeof raw.title === 'string'
    ? raw.title.replace(CONTROL_LINE, '').trim().slice(0, TITLE_MAX)
    : ''
  const out = {
    ...raw,
    id,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null,
    sessionName: typeof raw.sessionName === 'string'
      ? raw.sessionName.replace(CONTROL_LINE, '').trim().slice(0, NAME_MAX)
      : '',
    text,
    createdAt,
    order: Number.isFinite(order) ? order : fallbackOrder,
  }
  if (title) out.title = title
  else delete out.title
  return out
}

/** Ascending by order within a scope; the global board after the session ones,
 *  which is only a stable total order for `all()` -- every consumer filters by
 *  scope first. A missing file is the normal first-run case. A file that exists
 *  but is corrupt degrades to "no entries" here and is moved aside by the next
 *  write, never silently overwritten. */
export const readPasteboard = (file) => {
  let doc
  try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch { return [] }
  const raw = Array.isArray(doc?.pasteboard) ? doc.pasteboard : []
  const out = []
  for (let i = 0; i < raw.length; i++) {
    const e = sanitizeEntry(raw[i], i)
    if (e) out.push(e)
  }
  return sortBoard(out)
}

// Global (sessionId === null) sorts as "after every session scope" -- not as
// the empty string, which a plain `scopeOf(a) < scopeOf(b)` comparison would
// place FIRST (`'' < 's1'`), the opposite of what every docstring here and
// the entry order both promise ("the global board after the session ones").
const isGlobal = (e) => e.sessionId === null

const sortBoard = (items) =>
  [...items].sort((a, b) => {
    const ga = isGlobal(a) ? 1 : 0
    const gb = isGlobal(b) ? 1 : 0
    if (ga !== gb) return ga - gb
    if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1
    return a.order - b.order
  })

const corrupt = (file) => {
  if (!existsSync(file)) return false
  try { JSON.parse(readFileSync(file, 'utf8')); return false } catch { return true }
}

/** `createPasteboard({ file, now })`. */
export const createPasteboard = ({ file, now = Date.now }) => {
  let items = readPasteboard(file)

  /** Writes `next` (defaulting to the current `items`, so `flush()` with no
   *  argument still just persists the board as it stands). Serializes FIRST:
   *  if `JSON.stringify` throws, nothing below has run and the previous file
   *  is still the previous file. Callers assign `items = next` only after
   *  this returns -- a throw here must never poison what is held in
   *  memory. */
  const flush = (next = items) => {
    const body = JSON.stringify({ version: 1, pasteboard: next }, null, 2)
    const tmp = file + '.tmp'
    try {
      mkdirSync(dirname(file), { recursive: true })
      if (corrupt(file)) {
        // NOT swallowed: if the aside cannot be made, falling through to the
        // rename would destroy the very file the aside was protecting.
        const aside = file + '.corrupt-' + now()
        renameSync(file, aside)
        console.error(`pasteboard: ${file} would not parse; moved aside to ${aside}`)
      }
      writeFileSync(tmp, body)
      renameSync(tmp, file)
    } catch (err) {
      try { unlinkSync(tmp) } catch {}
      throw err
    }
  }

  const inScope = (sessionId) => items.filter((e) => e.sessionId === sessionId)
  const totalBytes = () => items.reduce((n, e) => n + e.text.length, 0)

  return {
    all: () => items,
    get: (id) => items.find((e) => e.id === id) ?? null,

    /** `{ sessionId, sessionName, text, title?, scope }`. `id`, `createdAt`
     *  and `order` are the store's to assign: a caller-supplied order could
     *  reorder somebody else's board, and a caller-supplied id could overwrite
     *  another entry. Returns `{ ok: true, entry, index, count }` or
     *  `{ ok: false, error }` -- never throws for a refusal, because the
     *  refusal reason reaches a human as the reason their prompt was dropped.
     *  Builds `next` and flushes it before touching `items`: a throw
     *  from `flush` (a cyclic field, say) leaves the board exactly as it was,
     *  not holding an entry that can never be written. */
    add(fields = {}) {
      const f = isPlainObject(fields) ? fields : {}
      const text = typeof f.text === 'string' ? f.text.replace(CONTROL_ALL, '') : ''
      if (!text.trim()) return { ok: false, error: 'empty' }
      if (text.length > PASTEBOARD_MAX_TEXT) return { ok: false, error: 'too long' }
      const sessionId = f.scope === 'global' ? null : (typeof f.sessionId === 'string' && f.sessionId ? f.sessionId : null)
      if (inScope(sessionId).length >= PASTEBOARD_MAX_PER_SCOPE) return { ok: false, error: 'board full' }
      if (totalBytes() + text.length > PASTEBOARD_MAX_TOTAL) return { ok: false, error: 'pasteboard full' }

      const board = inScope(sessionId)
      const front = board.length ? Math.min(...board.map((e) => e.order)) - 1 : 0
      const entry = sanitizeEntry({
        ...f,
        id: uid(),
        sessionId,
        sessionName: f.sessionName,
        text,
        title: f.title,
        createdAt: now(),
        order: front,
      }, front)
      if (!entry) return { ok: false, error: 'empty' }
      // `scope` was the wire's word for what `sessionId` now says; keeping it
      // would be a second, drifting copy of the same fact.
      delete entry.scope
      const next = sortBoard([...items, entry])
      flush(next)
      items = next
      const after = inScope(sessionId)
      return { ok: true, entry, index: after.findIndex((e) => e.id === entry.id), count: after.length }
    },

    remove(id) {
      const next = items.filter((e) => e.id !== id)
      if (next.length === items.length) return false
      flush(next)
      items = next
      return true
    },

    /** Swap with the neighbour IN THE SAME SCOPE. At an end it is a no-op that
     *  still reports true: the caller asked for a legal move of a real entry
     *  and got the board it asked for. The two swapped entries are replaced
     *  with NEW objects carrying the swapped `order` -- the current
     *  ones are never mutated, so a throw during flush leaves `items`
     *  (and every entry in it) untouched. */
    move(id, dir) {
      const e = items.find((x) => x.id === id)
      if (!e || (dir !== 'up' && dir !== 'down')) return false
      const board = inScope(e.sessionId)
      const i = board.findIndex((x) => x.id === id)
      const j = dir === 'up' ? i - 1 : i + 1
      if (j < 0 || j >= board.length) return true
      const left = board[i]
      const right = board[j]
      const leftNext = { ...left, order: right.order }
      const rightNext = { ...right, order: left.order }
      const next = sortBoard(items.map((x) => (
        x.id === left.id ? leftNext : x.id === right.id ? rightNext : x
      )))
      flush(next)
      items = next
      return true
    },

    /** An explicit order for the ids given. Every id must name a real entry in
     *  ONE scope; anything else refuses whole, because a half-applied reorder
     *  is worse than none. Entries not listed keep their own order (and their
     *  own object identity). Every entry whose `order` changes is replaced
     *  with a NEW object, never mutated in place. */
    reorder(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return false
      const found = ids.map((id) => items.find((e) => e.id === String(id)))
      if (found.some((e) => !e)) return false
      const scopes = new Set(found.map((e) => e.sessionId))
      if (scopes.size !== 1) return false
      const base = Math.min(...inScope(found[0].sessionId).map((e) => e.order))
      const changed = new Map(found.map((e, i) => [e.id, { ...e, order: base + i }]))
      const next = sortBoard(items.map((x) => changed.get(x.id) ?? x))
      flush(next)
      items = next
      return true
    },

    flush,
  }
}
