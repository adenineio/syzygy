// Which session is working on what, per worktree.
//
// AUTHORITATIVE, not derived: a claim exists nowhere else, so every write
// serializes first, goes to a temp file in the same directory, and is renamed
// over the target. A failed serialize leaves the previous file intact. Same
// contract as requests.mjs, for the same reason.
//
// Only the RELAY calls the write paths. It is a single process, so two
// sessions in one worktree cannot interleave a read-modify-write -- which is
// the entire case this feature exists for. The plugin never writes this file.
//
// A session only ever writes its own key, and unknown fields are carried
// through untouched, so the file stays editable by hand.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const CLAIMS_REL = '.claude/claims.json'

export const claimsPathFor = (worktreeRoot) => join(worktreeRoot, CLAIMS_REL)

const EMPTY = () => ({ version: 1, claims: {} })

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** Missing or non-array -> no items. An array survives with only its
 *  well-formed (object) elements -- a null or a bare string slipped in by a
 *  hand edit is dropped rather than carried through to a consumer that reads
 *  `.kind`/`.id` off every element unguarded. */
const sanitizeItems = (items) => (Array.isArray(items) ? items.filter(isPlainObject) : [])

/** Absence is normal -- a worktree with no claims is the usual state, not an
 *  error. A corrupt file is also not fatal: the scanner must keep working, so
 *  it degrades to "no claims" and the bad file is moved aside on next write
 *  rather than being silently overwritten.
 *
 *  claims.json is documented as hand-editable, so valid-JSON-but-malformed
 *  data reaches here too, two levels deep: `{"claims":{"s2":null}}` parses
 *  fine but has no `.items` to read, and `{"claims":{"s2":{"items":[null]}}}`
 *  parses fine and HAS an `.items` array, but one that throws the moment a
 *  consumer reads `.kind` off its null element. Every consumer (ownerFor,
 *  foldEfforts, the backlog matcher in tasks.mjs) reaches into `entry.items`
 *  the same way, so this is the one place to establish "every value in
 *  `claims` is an object, and its `items` is an array of objects" for all of
 * them at once, rather than guarding it redundantly in each.
 *  Dropping the bad entry/element is consistent with the file-level degrade
 *  above: corrupt in, no claim out, never a throw. */
export const readClaims = (worktreeRoot) => {
  const file = claimsPathFor(worktreeRoot)
  if (!existsSync(file)) return EMPTY()
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    if (!doc || typeof doc !== 'object' || typeof doc.claims !== 'object' || !doc.claims) return EMPTY()
    const claims = {}
    for (const [id, entry] of Object.entries(doc.claims)) {
      if (!isPlainObject(entry)) continue
      claims[id] = { ...entry, items: sanitizeItems(entry.items) }
    }
    return { version: 1, ...doc, claims }
  } catch {
    return EMPTY()
  }
}

const corrupt = (worktreeRoot) => {
  const file = claimsPathFor(worktreeRoot)
  if (!existsSync(file)) return false
  try { JSON.parse(readFileSync(file, 'utf8')); return false } catch { return true }
}

/** `now` is injectable only so the `.corrupt-*` name is deterministic under
 *  test -- the aside has to be blockable at a known path to prove the throw
 *  below is real. Every caller but writeClaim takes the default. */
const flush = (worktreeRoot, doc, now = Date.now) => {
  const file = claimsPathFor(worktreeRoot)
  // Serialize FIRST. If this throws, nothing has been written.
  const text = JSON.stringify(doc, null, 2)
  const tmp = file + '.tmp'
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (corrupt(worktreeRoot)) {
      // NOT swallowed. If the aside cannot be made, the contract this exists
      // for -- "moved aside, not silently overwritten" -- is unsatisfiable,
      // and falling through to the rename below would destroy the very file
      // the aside was protecting. Failing leaves it on disk to be recovered
      // by hand, which is the same bargain as "a failed serialize leaves the
      // previous file intact".
      renameSync(file, file + '.corrupt-' + now())
    }
    writeFileSync(tmp, text)
    renameSync(tmp, file)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
  return doc
}

/** Merge ONE session's entry. Every other key is carried through byte-for-byte,
 *  and so is anything unknown at the top level or inside the entry. */
export const writeClaim = (worktreeRoot, sessionId, entry, now = Date.now) => {
  const doc = readClaims(worktreeRoot)
  const prior = doc.claims[sessionId]
  doc.claims[sessionId] = {
    ...prior,
    ...entry,
    // claimedAt is when this session FIRST claimed, and must survive updates.
    claimedAt: prior?.claimedAt ?? now(),
    updatedAt: now(),
  }
  return flush(worktreeRoot, doc, now)
}

export const removeClaim = (worktreeRoot, sessionId) => {
  const doc = readClaims(worktreeRoot)
  if (!(sessionId in doc.claims)) return doc
  delete doc.claims[sessionId]
  return flush(worktreeRoot, doc)
}

/** Moves ONE session's claim to a different session id, as a single
 *  read-modify-flush -- not a writeClaim+removeClaim pair, which are two
 * independent read-modify-flush cycles: if the write half succeeded
 *  and the remove half then threw, the file would be left with both the new
 *  entry and the orphaned original, silently violating "inherit means
 *  transfer, never duplicate." Used by claim inheritance (claims-inherit.mjs)
 *  for exactly that reason -- every other caller still writes and removes
 *  its own key independently via writeClaim/removeClaim.
 *
 *  A missing `from` key is a no-op: nothing to transfer, so nothing is
 *  written and the doc comes back exactly as read. */
export const transferClaim = (worktreeRoot, fromSessionId, toSessionId, extra = {}) => {
  const doc = readClaims(worktreeRoot)
  const prior = doc.claims[fromSessionId]
  if (!prior) return doc
  delete doc.claims[fromSessionId]
  doc.claims[toSessionId] = { ...prior, ...extra }
  return flush(worktreeRoot, doc)
}
