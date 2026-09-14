// A proposed pattern -- something a pass over the capture log, or a person,
// noticed worth turning into a skill -- from the moment it is written up to
// the moment it is either rated into the queue's memory or turned into a
// Dispatch request. AUTHORITATIVE, not derived: a write-up exists nowhere
// else, so every mutator serializes first, writes to a temp file in the same
// directory and renames it over the target -- a failed write leaves the
// previous file exactly as it was, and no in-memory state is assigned until
// the write succeeds. Same contract as claims.mjs, findings.mjs and
// requests.mjs, for the same reason.
//
// Reading SANITISES rather than throws, the way findings.mjs's reader does: a
// record with no id could never be marked or prepped again, so it is dropped
// on read rather than kept in a state nothing can reach. A file that EXISTS
// but will not parse, or has the wrong shape, is renamed aside and reported --
// never silently overwritten, because it may be the only copy of a queue a
// person has been rating for days.
//
// Re-proposing the same idea MERGES rather than duplicating: the record is
// looked up by a key derived from its title, and a hit folds the new sighting
// in (more `seen`, wider `evidence`/`sessions`) rather than adding a look-
// alike beside it. Once a person has rated a proposal, or it has been turned
// into a request, its write-up text is FROZEN -- a later sighting still bumps
// `seen`, but the wording a person judged, or that a request now points at,
// never shifts under them. Nothing here ever deletes a record: a rated
// proposal is memory the pass reads back so it never proposes the same idea
// twice, so the cap on how many can pile up unrated REFUSES a new add rather
// than quietly discarding a rated one.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export const SKILLS_FILE_NAME = 'skills-queue.json'

/** How many unrated, unprepped proposals can queue up before the pass has to
 *  wait for a person. A rated or prepped proposal never counts against this:
 *  it is settled, and only an unsettled one can still be evicted. */
export const PROPOSALS_MAX = 200

/** How many records ride on the snapshot -- smaller than PROPOSALS_MAX on
 *  purpose, the same reason findings.mjs's own snapshot cap is smaller than
 *  its store cap. The full store stays reachable through `read`. */
export const PROPOSALS_IN_SNAPSHOT = 50

/** Per-proposal history caps -- a proposal that sits in the queue for months,
 *  cycled back and forth, or re-sighted every pass, must not grow without
 *  bound. */
export const MARK_HISTORY_MAX = 50
export const SEEN_MAX = 50

/** Per-field text caps, the same shape findings.mjs uses: one runaway
 *  write-up must not be able to eat the snapshot's budget on its own. */
export const TITLE_MAX = 160
export const TEXT_MAX = 4000
export const ITEM_MAX = 300
export const LIST_MAX = 20

/** What a write-up can claim to be. Not a scale of importance -- a session
 *  classifying its own idea by how much it matters is doing the reviewer's
 *  job with the least context of anyone. */
export const PROPOSAL_KINDS = ['skill', 'shape', 'kickoff', 'claude-md']

/** Who wrote the proposal up. Not enforced beyond a closed set: it changes
 *  how a card reads, never what a proposal can do. */
export const SOURCES = ['pass', 'session', 'human']

/** The mark cycle a rating button steps through, none of it a rejection --
 *  clearing a mark is always reachable, and there is no fourth "no" mark. */
export const MARKS = ['good', 'near', 'potential']

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// Control characters are stripped, not escaped -- these strings reach a JSON
// file and, eventually, a Dispatch brief, and a stray NUL in either is noise a
// reader cannot see but a parser can choke on. \t, \n and \r survive: a
// multi-line idea or methodology is normal and worth keeping readable.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

const text = (v, max) => (typeof v === 'string' ? v.replace(CONTROL, '').trim().slice(0, max) : '')

/** A list field survives with only its non-empty string elements. A bare
 *  string is accepted as a one-element list -- a write-up naming one file is
 *  common and refusing it would lose the proposal over punctuation. */
const list = (v, max = LIST_MAX) => {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
  return raw.map((x) => text(x, ITEM_MAX)).filter(Boolean).slice(0, max)
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

/** `title` -> the key a re-proposed idea is found by. Lower-cased and
 *  collapsed to its letters and digits, so punctuation, spacing and case
 *  drift between two write-ups of the same idea still land on one record. */
export const normalizeKey = (title) =>
  String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** `['', ...MARKS]` cyclically, in both directions. A value not on that list
 *  -- a stale mark from a build that removed one -- is treated as `''`, the
 *  same "typo is not a real value" rule findings.mjs's `kind` follows, so
 *  `nextMark` on it lands on the first real mark rather than throwing. */
const ring = ['', ...MARKS]
const ringIndex = (mark) => {
  const i = ring.indexOf(mark)
  return i < 0 ? 0 : i
}
export const nextMark = (mark) => ring[(ringIndex(mark) + 1) % ring.length]
export const prevMark = (mark) => ring[(ringIndex(mark) - 1 + ring.length) % ring.length]

const isFiniteTime = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0

const sanitizeSeenEntry = (e) => {
  if (!isPlainObject(e) || !isFiniteTime(e.at)) return null
  const source = SOURCES.includes(e.source) ? e.source : 'human'
  return { at: e.at, source }
}

const sanitizeMarkEntry = (e) => {
  if (!isPlainObject(e) || !isFiniteTime(e.at)) return null
  const mark = ring.includes(e.mark) ? e.mark : ''
  return { mark, at: e.at }
}

/** One write-up, normalised, or `null` if it is not usable. Mirrors
 *  findings.mjs's `sanitizeFinding`: strip control characters, trim, slice to
 *  a cap; an unrecognised closed-set value sanitises to its "no real value"
 *  member rather than to a default someone might mistake for chosen.
 *
 *  Only the three write-up fields are REQUIRED -- `title`, `idea` and
 *  `methodology` are the whole point of the record, and `evidence` is not: a
 *  hand edit and an older writer both reach this without it, and the actual
 *  writers are where refusing a vague proposal is free. `id`, `createdAt`
 *  and `updatedAt` pass through only when well-formed -- `ingest` overwrites
 *  them with its own regardless, so a forged one here only matters to
 *  `readProposals`, which drops a record that has none. `key` is never
 *  trusted from the file: it is always recomputed from the (sanitised)
 *  title, so a hand-edited title can never leave a stale key that merges an
 *  unrelated proposal into it. */
export const sanitizeProposal = (raw) => {
  if (!isPlainObject(raw)) return null
  const title = text(raw.title, TITLE_MAX)
  const idea = text(raw.idea, TEXT_MAX)
  const methodology = text(raw.methodology, TEXT_MAX)
  if (!title || !idea || !methodology) return null

  const rawKind = text(raw.kind, 32)
  const kind = PROPOSAL_KINDS.includes(rawKind) ? rawKind : ''
  const rawSource = text(raw.source, 32)
  const source = SOURCES.includes(rawSource) ? rawSource : 'human'
  const mark = ring.includes(raw.mark) ? raw.mark : ''

  const marks = Array.isArray(raw.marks)
    ? raw.marks.map(sanitizeMarkEntry).filter(Boolean).slice(-MARK_HISTORY_MAX)
    : []
  const seen = Array.isArray(raw.seen)
    ? raw.seen.map(sanitizeSeenEntry).filter(Boolean).slice(-SEEN_MAX)
    : []

  const requestId = typeof raw.requestId === 'string' && raw.requestId ? raw.requestId : null

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : undefined,
    key: normalizeKey(title),
    kind,
    title,
    idea,
    methodology,
    evidence: list(raw.evidence),
    sessions: list(raw.sessions),
    mark,
    marks,
    seen,
    requestId,
    source,
    createdAt: isFiniteTime(raw.createdAt) ? raw.createdAt : undefined,
    updatedAt: isFiniteTime(raw.updatedAt) ? raw.updatedAt : undefined,
  }
}

/** Oldest first. A missing file is the normal first-run case and is silent; a
 *  file that EXISTS but will not parse, or whose `proposals` is not an array,
 *  degrades to "no proposals" here -- the caller (the constructor) is the one
 *  that renames it aside, because only it knows the path to rename to. A
 *  record with no `id`, or without a well-formed `createdAt`/`updatedAt`, is
 *  dropped: it could never be marked or prepped again, and every consumer
 *  sorts and ages by those two fields. */
export const readProposals = (file) => {
  let doc
  try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch { return [] }
  const raw = Array.isArray(doc?.proposals) ? doc.proposals : []
  const out = []
  for (const r of raw) {
    const p = sanitizeProposal(r)
    if (!p) continue
    if (!p.id || !isFiniteTime(p.createdAt) || !isFiniteTime(p.updatedAt)) continue
    out.push(p)
  }
  return out
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** The local calendar day a spend is booked against, `YYYY-MM-DD`. */
export const localDay = (ms) => {
  const d = new Date(ms)
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')
}

/** The pattern pass's spend for one local day, `{ day, usd }`, or the empty
 *  reading when the file's value is not usable. A malformed day or a
 *  negative, non-finite figure reads as nothing spent on no day, never as a
 *  number someone might mistake for a real total. */
export const sanitizePassSpend = (raw) => {
  if (!isPlainObject(raw) || typeof raw.day !== 'string' || !DAY_RE.test(raw.day)) return { day: '', usd: 0 }
  const usd = typeof raw.usd === 'number' && Number.isFinite(raw.usd) && raw.usd >= 0 ? raw.usd : 0
  return { day: raw.day, usd }
}

/** `createSkillsQueue({file, now})`. */
export const createSkillsQueue = ({ file, now = Date.now }) => {
  let items = []
  let passAt = 0
  let passSpend = { day: '', usd: 0 }

  let raw = null
  try { raw = readFileSync(file, 'utf8') } catch { /* missing file: normal first run, silent */ }

  if (raw !== null) {
    let doc
    try { doc = JSON.parse(raw) } catch { doc = undefined }
    if (isPlainObject(doc) && Array.isArray(doc.proposals)) {
      items = readProposals(file)
      passAt = isFiniteTime(doc?.pass?.at) ? doc.pass.at : 0
      passSpend = sanitizePassSpend(doc?.passSpend)
    } else {
      // The file exists but is not usable. This store is authoritative (see
      // the file header), so the next write would otherwise silently
      // overwrite the only copy -- move it aside instead, and say so.
      const aside = `${file}.corrupt-${now()}`
      try {
        renameSync(file, aside)
        process.stderr.write(`skills queue: ${file} failed to load; moved aside to ${aside} and starting empty\n`)
      } catch (renameErr) {
        process.stderr.write(`skills queue: ${file} failed to load; could not move it aside (${renameErr.message}) -- starting empty, original left in place\n`)
      }
    }
  }

  // Serialize FIRST. If this throws, nothing has been written and the
  // previous file is still the previous file -- neither `items`, `passAt`
  // nor `passSpend` is touched until the caller sees this return.
  const write = (nextItems, nextPassAt, nextPassSpend = passSpend) => {
    const body = JSON.stringify({ version: 1, proposals: nextItems, pass: { at: nextPassAt }, passSpend: nextPassSpend }, null, 2)
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

  /** Takes the array to write. No mutator assigns `items` before the write
   *  succeeds: build `next` with new objects for every changed record, call
   *  `flush(next)`, and only on success is `items` replaced. */
  const flush = (next) => {
    write(next, passAt)
    items = next
  }

  const get = (id) => items.find((p) => p.id === id) ?? null

  const frozen = (p) => p.mark !== '' || p.requestId !== null

  return {
    all: () => items,
    get,

    /** Newest `limit` records, still oldest-first order -- the shape
     *  findings.mjs's `read` gives, so a consumer paging either store reads
     *  it the same way. */
    read: ({ limit = PROPOSALS_MAX } = {}) => {
      const n = Number(limit)
      const cap = Number.isFinite(n) && n > 0 ? Math.min(PROPOSALS_MAX, Math.floor(n)) : PROPOSALS_MAX
      return items.slice(-cap)
    },

    titles: () => items.map((p) => p.title),

    lastPassAt: () => passAt,

    /** Writes through the same atomic write path so the pass's floor
     *  survives a relay restart. In-memory `passAt` is assigned only after
     *  the write succeeds, like every other mutator here. */
    recordPass(at) {
      write(items, at)
      passAt = at
    },

    /** The pass's spend so far on the day it names -- a copy, so a caller
     *  cannot move the store's own figure without a write. */
    passSpend: () => ({ ...passSpend }),

    /** Adds `usd` to `day`'s total, starting again from zero when `day` is
     *  not the day already held. Same atomic write path as `recordPass`, so
     *  the day cap survives a relay restart. Returns the new reading. */
    recordPassSpend(usd, day) {
      const add = typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? usd : 0
      const base = passSpend.day === day ? passSpend.usd : 0
      const next = sanitizePassSpend({ day, usd: base + add })
      write(items, passAt, next)
      passSpend = next
      return { ...next }
    },

    /** `ingest(fields, {source})`. `id`, `createdAt` and `updatedAt` are
     *  always the store's -- a caller-supplied one is discarded before
     *  sanitising. A hit merges into the existing record (more `seen`, wider
     *  `evidence`/`sessions`) and refreshes the write-up text only while it
     *  is neither marked nor prepped, since a person may already have judged
     *  those words or a request may already point at them. A miss appends,
     *  evicting the single oldest unmarked/unprepped record when the queue
     *  is at PROPOSALS_MAX, or refusing when there is nothing evictable. */
    ingest(fields, { source } = {}) {
      const sanitizedSource = SOURCES.includes(source) ? source : 'human'
      const s = sanitizeProposal({
        ...(isPlainObject(fields) ? fields : {}),
        id: undefined, createdAt: undefined, updatedAt: undefined,
      })
      if (!s) return { ok: false, error: 'a proposal needs title, idea and methodology' }

      const at = now()
      const existing = items.find((p) => p.key === s.key)

      if (existing) {
        const seen = [...existing.seen, { at, source: sanitizedSource }].slice(-SEEN_MAX)
        const evidence = [...existing.evidence]
        for (const e of s.evidence) if (!evidence.includes(e)) evidence.push(e)
        const sessions = [...existing.sessions]
        for (const sess of s.sessions) if (!sessions.includes(sess)) sessions.push(sess)
        const refreshable = !frozen(existing)
        const merged = {
          ...existing,
          evidence,
          sessions,
          seen,
          updatedAt: at,
          ...(refreshable ? { idea: s.idea, methodology: s.methodology, kind: s.kind } : {}),
        }
        flush(items.map((p) => (p.id === existing.id ? merged : p)))
        return { ok: true, merged: true, proposal: merged }
      }

      let base = items
      if (base.length >= PROPOSALS_MAX) {
        const evictIdx = base.findIndex((p) => !frozen(p))
        if (evictIdx < 0) {
          return {
            ok: false,
            error: `the queue holds ${PROPOSALS_MAX} rated proposals; rate or prep one before adding another`,
          }
        }
        base = [...base.slice(0, evictIdx), ...base.slice(evictIdx + 1)]
      }

      const proposal = {
        ...s,
        id: uid(),
        mark: '',
        marks: [],
        seen: [{ at, source: sanitizedSource }],
        requestId: null,
        source: sanitizedSource,
        createdAt: at,
        updatedAt: at,
      }
      flush([...base, proposal])
      return { ok: true, merged: false, proposal }
    },

    /** `mark(id, {mark, cycle})`. `cycle: true` steps forward, `cycle:
     *  'back'` steps back, otherwise an explicit `mark` which must be `''` or
     *  in MARKS. Appends to `marks` and caps its history. */
    mark(id, { mark, cycle } = {}) {
      const p = get(id)
      if (!p) return { ok: false, error: 'unknown proposal' }

      let value
      if (cycle === true) value = nextMark(p.mark)
      else if (cycle === 'back') value = prevMark(p.mark)
      else {
        if (mark !== '' && !MARKS.includes(mark)) return { ok: false, error: `unknown mark: ${mark}` }
        value = mark
      }

      const at = now()
      const marks = [...p.marks, { mark: value, at }].slice(-MARK_HISTORY_MAX)
      const updated = { ...p, mark: value, marks, updatedAt: at }
      flush(items.map((r) => (r.id === id ? updated : r)))
      return { ok: true, proposal: updated }
    },

    /** `prep(id, {requestId})`. Sets `requestId` once, from `null`; refuses
     *  an id the store does not hold, and refuses a second prep rather than
     *  overwriting the first request it named. Never touches `mark`. */
    prep(id, { requestId } = {}) {
      const p = get(id)
      if (!p) return { ok: false, error: 'unknown proposal' }
      if (p.requestId !== null) return { ok: false, error: `already prepped as ${p.requestId}` }
      const updated = { ...p, requestId, updatedAt: now() }
      flush(items.map((r) => (r.id === id ? updated : r)))
      return { ok: true, proposal: updated }
    },

    flush,
  }
}

// -- The pass's pure half --------------------------------------------------
//
// Everything below is what decides whether a pass should run, what it reads,
// and what it does with what comes back -- no store, no clock, no network. A
// pass is a scheduled model turn read against the board's own capture log and
// findings, so all of it takes its inputs as plain arguments and is driven
// entirely by the harness.

/** A pass waits at least this long since the last one, `lastPassAt` of 0
 *  (never run) excepted. */
export const PASS_MIN_MS = 6 * 60 * 60_000

/** Past the floor, either threshold alone is enough to justify running: a
 *  quiet stretch with a few sharp findings, or a busy one with none reported,
 *  both count. Neither reaching either means there is nothing new enough to
 *  look at yet. */
export const PASS_MIN_CAPTURE = 40
export const PASS_MIN_FINDINGS = 3

/** How many of the most recent capture-log entries a pass ever reads. A pass
 *  looks for a shape repeated across sessions, not a full history, and
 *  reading everything captured to date would cost more than it could find. */
export const PASS_CAPTURE_WINDOW = 400

/** The turn text's byte ceiling, measured with Buffer.byteLength like every
 *  other budgeted section in this codebase -- never `.length`, since a board
 *  full of multi-byte names and paths must not silently blow past what a
 *  model turn can hold. */
export const PASS_BUDGET_BYTES = 48 * 1024

/** However many candidates a reply names, only this many are ever filed. A
 *  reply proposing dozens at once is a reply that stopped discriminating. */
export const PASS_MAX_PROPOSALS = 5

/** `passGate({lastPassAt, newCapture, newFindings, now, minMs})` -- whether a
 *  pass is worth running right now. `lastPassAt` of 0 means a pass has never
 *  run and skips the floor outright; otherwise it must have been at least
 *  `minMs` since the last one. Once the floor has passed, either enough new
 *  board traffic or enough new findings opens the gate -- reaching just one
 *  of the two is enough. Every refusal names what it counted or waited on, so
 *  a person reading the reason never has to go look it up. */
export const passGate = ({
  lastPassAt = 0, newCapture = 0, newFindings = 0, now = Date.now(), minMs = PASS_MIN_MS,
} = {}) => {
  if (lastPassAt > 0) {
    const sinceMs = now - lastPassAt
    if (sinceMs < minMs) {
      const ranHoursAgo = Math.round(sinceMs / 3_600_000)
      const waitsHours = Math.round(minMs / 3_600_000)
      return { ok: false, reason: `the last pass ran ${ranHoursAgo} h ago; a pass waits ${waitsHours} h` }
    }
  }
  if (newCapture < PASS_MIN_CAPTURE && newFindings < PASS_MIN_FINDINGS) {
    return {
      ok: false,
      reason: `${newCapture} new board entries and ${newFindings} new findings since the last pass; `
        + `a pass wants ${PASS_MIN_CAPTURE} or ${PASS_MIN_FINDINGS}`,
    }
  }
  return { ok: true, reason: '' }
}

const byteLen = (s) => Buffer.byteLength(s, 'utf8')

/** One budgeted section, trimmed oldest-first with an explicit omission line
 *  -- the same shape orchestrator.mjs's `bundleContext` uses for its own
 *  sections, reimplemented here rather than imported so this module stays
 *  free of that one. `items` must already be in the order this section wants
 *  to show them (newest first); trimming always sheds off the end. */
const passSection = ({ header, items, renderItem, noun, remaining }) => {
  if (!items.length) return { text: '', used: 0 }
  const reserve = byteLen(`_… ${items.length} more ${noun} omitted (budget)_\n`)
  const headerCost = byteLen(header + '\n')
  if (headerCost + reserve > remaining) return { text: '', used: 0 }
  let out = header + '\n'
  let shown = 0
  for (const item of items) {
    const rendered = renderItem(item)
    if (rendered == null) continue
    const withNl = rendered + '\n'
    if (byteLen(out) + byteLen(withNl) > remaining - reserve) break
    out += withNl
    shown++
  }
  const omitted = items.length - shown
  if (omitted > 0) out += `_… ${omitted} more ${noun} omitted (budget)_\n`
  return { text: out, used: byteLen(out) }
}

const renderPassFinding = (f) => {
  const line = `- ${f?.kind || 'unclassified'} · ${f?.session || 'unattributed'}: ${f?.surprise ?? ''}`
  const evidence = Array.isArray(f?.evidence) ? f.evidence.filter(Boolean) : []
  return evidence.length ? `${line}\n  evidence: ${evidence.join(', ')}` : line
}

const renderPassCapture = (c) => `- ${c?.kind ?? ''} ${c?.actor ?? ''}`

/** `passTurnText({capture, findings, titles, budget})` -- the turn text a
 *  pass reads. Three sections, in this order: `## Already proposed` first and
 *  never trimmed (the titles are the cheapest thing here and the most
 *  load-bearing -- losing one means proposing it again), `## Findings` next,
 *  newest first, then `## Recent activity` last, newest first, each capture
 *  line reduced to its kind and actor only so one fat entry can never eat the
 *  budget on its own. The whole return value, headings and omission lines
 *  included, stays inside `budget`. */
export const passTurnText = ({ capture = [], findings = [], titles = [], budget = PASS_BUDGET_BYTES } = {}) => {
  let text = ''
  if (titles.length) {
    text += '## Already proposed\n'
    for (const t of titles) text += `- ${t}\n`
    text += '\n'
  }

  let used = byteLen(text)
  const remaining = () => budget - used
  const add = (built) => {
    if (!built.text) return
    text += built.text
    used += built.used
  }

  if (remaining() > 0) {
    add(passSection({
      header: '## Findings',
      items: [...findings].reverse(),
      noun: 'findings',
      remaining: remaining(),
      renderItem: renderPassFinding,
    }))
  }

  if (remaining() > 0) {
    add(passSection({
      header: '## Recent activity',
      items: [...capture].reverse(),
      noun: 'entries',
      remaining: remaining(),
      renderItem: renderPassCapture,
    }))
  }

  return text
}

/** What a pass is asked to do and the exact shape it must answer in. Shown
 *  verbatim in the turn, so its wording is the whole instruction -- there is
 *  no separate system prompt underneath it. */
export const PATTERN_PREAMBLE = [
  "You are a pass over one person's Claude Code board, looking for what they",
  'do repeatedly across sessions -- the same shape of fix, the same manual',
  'steps, the same workaround -- rather than any single thing that merely',
  'happened once.',
  '',
  'A candidate is something worth turning into a reusable skill: a pattern',
  'somebody else could follow end to end, not an observation about this',
  'board. Finding nothing is a normal and expected answer.',
  '',
  'Never propose a title already listed under `## Already proposed` -- that',
  'idea has already been captured.',
  '',
  'Finish with one fenced json block and nothing after it:',
  '',
  '```json',
  '{"proposals":[{"kind":"skill|shape|kickoff|claude-md","title":"one line",',
  '"idea":"what the pattern is","methodology":"the ordered steps somebody else could follow",',
  '"evidence":["session or file:line"],"sessions":["which sessions"]}]}',
  '```',
  '',
  'At most five. Every field is required; an entry missing one is discarded.',
  'Propose nothing rather than padding: an empty list is a real answer.',
].join('\n')

/** `parseProposals(text)` -- the last fenced ```json block in a pass's reply,
 *  turned into proposals. The LAST block, because a model may quote the
 *  shape from the preamble before it answers, so the last one is the answer.
 *  Never throws: a missing fence, unparsable JSON, or a `proposals` that is
 *  not an array all answer an empty result rather than raise.
 *
 *  Each entry needs a non-empty `title`, `idea` and `methodology`, and at
 *  least one non-empty `evidence` string -- checked here, before
 *  `sanitizeProposal` ever sees it, so the rejection names the actual missing
 *  field rather than the sanitizer's generic "not usable". An entry that
 *  passes is still run through `sanitizeProposal`, so a `kind` typo lands on
 *  the unclassified `''` rather than being trusted as a real one. At most
 *  `PASS_MAX_PROPOSALS` are ever returned. */
export const parseProposals = (text) => {
  const proposals = []
  const rejected = []
  if (typeof text !== 'string') return { proposals, rejected }

  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
  if (!fences.length) return { proposals, rejected }

  let body
  try { body = JSON.parse(fences[fences.length - 1][1]) } catch { return { proposals, rejected } }

  const raw = Array.isArray(body?.proposals) ? body.proposals : []
  for (const entry of raw) {
    if (!isPlainObject(entry)) { rejected.push({ entry, why: 'not an object' }); continue }

    const title = typeof entry.title === 'string' ? entry.title.trim() : ''
    const idea = typeof entry.idea === 'string' ? entry.idea.trim() : ''
    const methodology = typeof entry.methodology === 'string' ? entry.methodology.trim() : ''
    const evidence = Array.isArray(entry.evidence)
      ? entry.evidence.filter((e) => typeof e === 'string' && e.trim())
      : []

    if (!title) { rejected.push({ entry, why: 'missing title' }); continue }
    if (!idea) { rejected.push({ entry, why: 'missing idea' }); continue }
    if (!methodology) { rejected.push({ entry, why: 'missing methodology' }); continue }
    if (!evidence.length) { rejected.push({ entry, why: 'missing evidence' }); continue }

    const sanitized = sanitizeProposal(entry)
    if (!sanitized) { rejected.push({ entry, why: 'not usable' }); continue }
    proposals.push(sanitized)
  }

  return { proposals: proposals.slice(0, PASS_MAX_PROPOSALS), rejected }
}

/** `prepBrief(proposal)` -- the Dispatch write-up for a proposal, in
 *  `emptyBrief()`'s exact shape. `ask` strips any leading run of dashes and
 *  whitespace from the idea (a prompt beginning with `-` is refused
 *  downstream); `goal` keeps the idea in full. `constraints` is the
 *  methodology split on newlines, trimmed, with empties dropped.
 *  `research.files` is the evidence verbatim; `context7` and `urls` start
 *  empty, since a pass never resolves either. `successCriteria` is the one
 *  line every skill dispatch shares. */
export const prepBrief = (proposal) => {
  const idea = typeof proposal?.idea === 'string' ? proposal.idea : ''
  const methodology = typeof proposal?.methodology === 'string' ? proposal.methodology : ''
  const evidence = Array.isArray(proposal?.evidence) ? proposal.evidence : []
  const ask = idea.replace(/^[-\s]+/, '')
  const constraints = methodology.split('\n').map((line) => line.trim()).filter(Boolean)

  return {
    title: typeof proposal?.title === 'string' ? proposal.title : '',
    ask,
    brief: {
      goal: idea,
      nonGoals: [],
      constraints,
      research: { context7: [], urls: [], files: evidence },
      successCriteria: ['the skill exists, is invoked by its description, and its methodology is followed end to end'],
      openQuestions: [],
    },
  }
}
