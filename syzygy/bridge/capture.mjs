// The capture log -- an append-only JSONL memory of board actions, and the
// orchestrator agent's only durable record. One JSON object per line:
// `{t, kind, actor, ...payload}`.
//
// Append with O_APPEND, one `write(2)` per line -- no read-modify-write, so a
// crash mid-write can cost only the last line and never an earlier one. No
// fsync: durability here is not worth a synchronous disk round-trip on the
// request path.
//
// The rule: a capture failure must never fail the action that caused it.
// `append` swallows every error and returns false rather than throwing, so a
// call site's `try { capture.append(...) } catch {}` in relay.mjs is a second
// layer of the same rule, not the only one. The log is memory; losing a line
// is a degraded memory. Losing an `/api/link` because the disk was full would
// be a bug.

import { appendFileSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const CAPTURE_FILE = 'capture.jsonl'
export const ROTATE_AT_BYTES = 4 * 1024 * 1024
export const DEFAULT_LIMIT = 200
export const MAX_LIMIT = 1000

/** Rotate the current file to `<file>.1` (one generation kept) when it is at
 *  or past ROTATE_AT_BYTES, checked BEFORE the append that would grow it
 *  further. A rotation failure -- the rename racing something else, a
 *  momentarily unwritable directory -- falls through to a plain append
 *  rather than dropping the line: an oversized file is a cost this trades
 *  for; a lost line is not. `statSync` throwing ENOENT (nothing written yet)
 *  is the common case and not an error at all. */
const rotateIfNeeded = (file) => {
  try {
    if (statSync(file).size < ROTATE_AT_BYTES) return
  } catch {
    return
  }
  try { renameSync(file, file + '.1') } catch {}
}

export const createCapture = ({ dir, now = Date.now }) => {
  const file = join(dir, CAPTURE_FILE)

  return {
    /** Returns true on a written line, false on any failure. Never throws --
     *  see the rule above. `payload` is spread FIRST so `t`/`kind`/`actor`
     *  always win: a call site whose payload happens to carry one of those
     *  three names (an action's own `kind`, say) cannot silently overwrite
     *  the event's own metadata with it. */
    append(kind, actor, payload = {}) {
      try {
        rotateIfNeeded(file)
        const line = JSON.stringify({ ...payload, t: now(), kind, actor })
        appendFileSync(file, line + '\n', { flag: 'a' })
        return true
      } catch {
        return false
      }
    },

    /** Reads the CURRENT file only -- `.1` is forensics, not the API.
     *  `since` is an exclusive lower bound on `t`, so polling with the
     *  last-seen entry's own `t` never re-delivers it. A malformed line
     *  already on disk is skipped, not fatal: one bad line must not fail
     *  every read of the log. Newest last, `limit` default DEFAULT_LIMIT,
     *  hard-capped at MAX_LIMIT either direction (too low, too high, or not
     *  a number at all). */
    read({ since = 0, limit = DEFAULT_LIMIT } = {}) {
      let raw
      try { raw = readFileSync(file, 'utf8') } catch { return [] }
      const sinceMs = Number.isFinite(Number(since)) ? Number(since) : 0
      const n = Number(limit)
      const cap = Number.isFinite(n) && n > 0 ? Math.min(MAX_LIMIT, Math.floor(n)) : DEFAULT_LIMIT
      const entries = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        let obj
        try { obj = JSON.parse(line) } catch { continue }
        if (!obj || typeof obj !== 'object' || typeof obj.t !== 'number') continue
        if (obj.t <= sinceMs) continue
        entries.push(obj)
      }
      return entries.slice(-cap)
    },
  }
}
