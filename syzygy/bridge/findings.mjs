// What one session learned that would change another session's work.
// Structured, not prose: who
// learned it, in which project, what they touched, what surprised them, and
// the `file:line` evidence for it.
//
// AUTHORITATIVE, not derived: a finding exists nowhere else, and nothing can
// rebuild one. So every write serializes FIRST, goes to a temp file in the
// same directory, and is renamed over the target -- a failed serialize leaves
// the previous file exactly as it was. Same contract as claims.mjs and
// requests.mjs, for the same reason.
//
// Reading SANITISES rather than throws. The file is small, hand-editable, and
// written over HTTP by whatever a session decides to send; a record that is
// not a plain object, or that carries no `surprise`, is DROPPED here so no
// consumer has to guard it. `bundleContext` reads the result straight into a
// model's context window, which is exactly the wrong place to discover that
// `evidence` was a number.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export const FINDINGS_FILE = 'findings.json'

/** The file is MEMORY, not an archive -- the bundle can only ever show a
 *  page of it, and an unbounded file would grow forever on a relay nobody
 *  restarts. Oldest go first. */
export const FINDINGS_MAX = 200

/** Per-field caps. One runaway record must not be able to eat the bundle's
 * whole 80 KB budget on its own. */
export const SURPRISE_MAX = 2000
export const ITEM_MAX = 300
export const LIST_MAX = 20
export const NAME_MAX = 120

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// Control characters are stripped, not escaped: these strings reach a
// markdown bundle and a JSON file, and a stray NUL in either is noise a
// reader cannot see but a parser can choke on. \t, \n and \r survive -- a
// multi-line `surprise` is normal and worth keeping readable.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

const text = (v, max) => (typeof v === 'string' ? v.replace(CONTROL, '').trim().slice(0, max) : '')

/** A list field survives with only its non-empty string elements. A bare
 *  string is accepted as a one-element list: a session writing `"touched":
 *  "relay.mjs"` means something obvious, and refusing it would lose the
 *  finding over punctuation. Anything else collapses to []. */
const list = (v, max = LIST_MAX) => {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
  return raw.map((x) => text(x, ITEM_MAX)).filter(Boolean).slice(0, max)
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

/** One record, normalised, or `null` if it says nothing.
 *
 * `surprise` is the ONLY required field: it is the whole point
 *  of the record and the rest is attribution, so a reader that also demanded
 *  a `project` would be losing real findings to bookkeeping. `t` must be a
 *  usable timestamp -- every consumer sorts and ages by it -- and a record
 *  whose `t` is absent or nonsense would sort unpredictably rather than
 *  harmlessly, which is why it is dropped rather than defaulted to `now`. */
export const sanitizeFinding = (raw) => {
  if (!isPlainObject(raw)) return null
  const surprise = text(raw.surprise, SURPRISE_MAX)
  if (!surprise) return null
  const t = Number(raw.t)
  if (!Number.isFinite(t) || t <= 0) return null
  return {
    id: text(raw.id, 40) || uid(),
    t,
    session: text(raw.session, NAME_MAX),
    project: text(raw.project, NAME_MAX),
    touched: list(raw.touched),
    surprise,
    evidence: list(raw.evidence),
  }
}

/** Oldest first, newest last -- the order `add` appends in, and the order
 *  `bundleContext` reverses. A missing file is the normal first-run case and
 *  is not an error; a file that exists but is corrupt degrades to "no
 *  findings" here and is moved aside by the next `flush`, never silently
 *  overwritten. */
export const readFindings = (file) => {
  let doc
  try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch { return [] }
  const raw = Array.isArray(doc?.findings) ? doc.findings : []
  const out = []
  for (const r of raw) {
    const f = sanitizeFinding(r)
    if (f) out.push(f)
  }
  return out.slice(-FINDINGS_MAX)
}

/** `createFindings({file, now})`. Write-through: `add` flushes immediately
 *  rather than on a timer like requests.mjs. Findings arrive at human pace --
 *  a handful an hour at most -- so there is no write amplification to batch
 *  away, and a relay killed between an `add` and a 4 s tick would lose the
 *  one thing that cannot be rebuilt. */
export const createFindings = ({ file, now = Date.now }) => {
  let items = readFindings(file)

  const flush = () => {
    // Serialize FIRST. If this throws, nothing has been written and the
    // previous file is still the previous file.
    const body = JSON.stringify({ version: 1, findings: items }, null, 2)
    const tmp = file + '.tmp'
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, body)
      renameSync(tmp, file)
    } catch (err) {
      try { unlinkSync(tmp) } catch {}
      throw err
    }
  }

  return {
    all: () => items,

    /** Newest last, capped. Mirrors capture.read's shape so the orchestrator
     *  reads both the same way. */
    read: ({ limit = FINDINGS_MAX } = {}) => {
      const n = Number(limit)
      const cap = Number.isFinite(n) && n > 0 ? Math.min(FINDINGS_MAX, Math.floor(n)) : FINDINGS_MAX
      return items.slice(-cap)
    },

    /** `id` and `t` are the RELAY's to assign: a caller-supplied `t`
     *  could reorder the log, and a caller-supplied `id` could collide with
     *  or overwrite somebody else's record. Whatever arrives in those two
     *  fields is discarded before sanitising. Returns the stored record, or
     *  `null` when there was no `surprise` to store. */
    add(fields = {}) {
      const rec = sanitizeFinding({ ...(isPlainObject(fields) ? fields : {}), id: uid(), t: now() })
      if (!rec) return null
      items = [...items, rec].slice(-FINDINGS_MAX)
      flush()
      return rec
    },

    remove(id) {
      const next = items.filter((f) => f.id !== id)
      if (next.length === items.length) return false
      items = next
      flush()
      return true
    },

    flush,
  }
}
