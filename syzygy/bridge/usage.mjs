// The account's 5-hour and 7-day usage windows: reading the account's own
// statusline side-channel, deciding when a reading is too old to trust, and
// deciding when a queued after-reset entry has actually crossed its boundary.
//
// PURE, no I/O beyond an injected `fs` in readNewestStatusline -- every
// function here is called from relay.mjs (real fs, real clock) and from
// test/usage-harness.mjs (a fake fs, a fixed clock) without change. Every
// failure is a `null` or an empty list, never a throw: a malformed or missing
// drop must degrade the usage row to "no reading", not crash the poller that
// reads it every SZG_USAGE_POLL_MS.

import { join } from 'node:path'

/** ten minutes with no fresh drop reads as UNKNOWN, never as zero. While
 *  an interactive session is open its status line re-runs constantly, so a
 *  gap this long means nobody is reporting -- not that usage stopped. */
export const DEFAULT_STALE_MS = 600_000

/** how often the relay re-reads the statusline directory. Named here so
 *  the default is documented in one place; relay.mjs reads
 *  SZG_USAGE_POLL_MS and falls back to this. */
export const DEFAULT_POLL_MS = 15_000

/** colour and notification thresholds are deliberately different scales.
 *  Colour is ambient (matches the context row directly below it in the
 *  rail); a notification is an interrupt, so it fires later. */
export const RAIL_THRESHOLDS = { warn: 65, crit: 85 }
export const NOTIFY_THRESHOLDS = [85, 95]

/** the newest file is tried first, but a newest drop that lacks a usable
 *  rate_limits block must not blind the board -- so parsing keeps walking
 *  older candidates. Capped so one corrupted directory cannot turn a 15s poll
 *  into an unbounded scan. */
const MAX_STATUSLINE_PARSES = 5

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** One window (`rate_limits.five_hour` or `.seven_day`) -> {pct, resetsAt,
 *  resetsInMs, expired}, or null when the block is absent or its two numbers
 *  are not both finite. `resets_at` arrives as an absolute unix epoch in
 *  SECONDS, verified against a live reading; everything downstream works in
 *  milliseconds, so the conversion happens here, once, rather than at every
 *  call site. */
const parseWindow = (raw, now) => {
  if (!isPlainObject(raw)) return null
  const pct = Number(raw.used_percentage)
  const resetsAtSec = Number(raw.resets_at)
  if (!Number.isFinite(pct) || !Number.isFinite(resetsAtSec)) return null
  const resetsAt = resetsAtSec * 1000
  const resetsInMs = resetsAt - now
  return { pct, resetsAt, resetsInMs, expired: resetsInMs <= 0 }
}

/** The statusline drop -> {fiveHour, sevenDay, observedAt, stale}. `now` is
 *  passed in (never Date.now() read here) so a test can hold the clock still
 * while it walks boundary.
 *
 * `stale` covers the whole reading, not each window -- but a stale
 *  reading still returns real `resetsAt` values in each window, because a
 *  reset boundary stays true after the reading that reported it goes stale.
 *  It is the CALLER's job to keep showing the countdown while hiding the
 *  percentage; nulling the windows here would take that choice away. */
export const parseUsage = (json, now, staleMs = DEFAULT_STALE_MS) => {
  if (!isPlainObject(json)) return { fiveHour: null, sevenDay: null, observedAt: null, stale: true }
  const writtenAtSec = Number(json.szg_written_at)
  const observedAt = Number.isFinite(writtenAtSec) ? writtenAtSec * 1000 : null
  // No stamp at all is indistinguishable from an ancient one: both mean
  // "cannot vouch for this", so both read as stale.
  const stale = observedAt === null || (now - observedAt) > staleMs
  const rl = isPlainObject(json.rate_limits) ? json.rate_limits : {}
  return {
    fiveHour: parseWindow(rl.five_hour, now),
    sevenDay: parseWindow(rl.seven_day, now),
    observedAt,
    stale,
  }
}

/** The newest usable drop in `dir`, or null. `fs` is injected (needs
 *  readdirSync, statSync, readFileSync) so the harness can drive this against
 *  a fake directory instead of ~/.claude/syzygy/statusline. A fixture is a
 *  real drop's shape, copied in -- never a live read.
 *
 * candidates are ordered by mtime (one stat call each, cheap), then
 *  parsed NEWEST FIRST until one actually has a rate_limits block. mtime
 *  decides the ORDER to try, not the winner outright -- the newest file can be
 *  a session that has not reported a rate limit yet, and picking it anyway
 *  would blind the board to a perfectly good older reading. */
export const readNewestStatusline = (dir, { fs } = {}) => {
  if (!fs) return null
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null // missing directory, no permission, whatever -- no reading.
  }
  if (!Array.isArray(names)) return null

  const stamped = []
  for (const name of names) {
    if (typeof name !== 'string' || !name.endsWith('.json')) continue
    const full = join(dir, name)
    try {
      stamped.push({ full, mtime: fs.statSync(full).mtimeMs ?? 0 })
    } catch {
      // A file that vanished or cannot be stat'd between readdir and stat is
      // simply not a candidate -- not a reason to fail the whole read.
    }
  }
  stamped.sort((a, b) => b.mtime - a.mtime)

  let attempts = 0
  for (const { full } of stamped) {
    if (attempts >= MAX_STATUSLINE_PARSES) break
    attempts++
    let raw
    try {
      raw = fs.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    let obj
    try {
      obj = JSON.parse(raw)
    } catch {
      continue
    }
    if (isPlainObject(obj) && isPlainObject(obj.rate_limits)) return obj
  }
  return null
}

/** Which (window, threshold) pairs `next` newly crosses relative to `prev` --
 *  so the browser fires a notification exactly once per crossing rather than
 *  once per SSE frame the crossing happens to still be true on.
 *
 *  This is also the whole of the "re-arm when resetsAt moves" behaviour
 * a window reset shows up here as `next.pct` dropping back below
 *  a threshold with no special-casing needed, because the reset is what makes
 *  crossing 85% *possible* again -- the NEXT climb back through 85% is then
 *  just an ordinary prev<threshold<=next transition, the same test that
 *  fired the first time. Nothing here reads `resetsAt` at all. */
export const crossings = (prev, next, thresholds = NOTIFY_THRESHOLDS) => {
  const out = []
  for (const key of ['fiveHour', 'sevenDay']) {
    const p = prev?.[key]
    const n = next?.[key]
    if (!p || !n) continue // no prior reading (or none now) -- nothing to compare.
    for (const t of thresholds) {
      if (p.pct < t && n.pct >= t) out.push({ window: key, threshold: t })
    }
  }
  return out
}

/** Which pending after-reset entries have genuinely fired: proved by
 *  a MOVED boundary, never by the clock alone. `queue` is the after-reset
 *  store's full item list (bridge/after-reset.mjs); only `state: 'pending'`
 *  entries are considered, everything else is already settled.
 *
 *  A stale `usage` returns [] outright -- a stale reading is exactly the
 * night-blind case rationale calls out, and `now >= resetsAt` on a
 *  reading that might be hours old would fire an entry the moment the clock
 *  ticks past a boundary nobody has actually confirmed moved. */
export const dueEntries = (queue, usage, now) => {
  if (!Array.isArray(queue) || !usage || usage.stale) return []
  const due = []
  for (const entry of queue) {
    if (!entry || entry.state !== 'pending') continue
    const win = usage[entry.window]
    if (!win) continue
    if (Number.isFinite(entry.armedResetsAt)) {
      // The documented, normal case: fire only once a FRESH reading shows
      // this window's boundary has moved past the one the entry was armed
      // against -- not merely reached it, since `armedResetsAt` and a
      // reading taken exactly at the old boundary can coincide.
      if (win.resetsAt > entry.armedResetsAt) due.push(entry)
    } else {
      // documented fallback: an entry with no armed boundary (hand-added
      // straight into after-reset.json) has nothing to have "moved past", so
      // this is the one place the clock alone decides -- gated on a fresh
      // reading, same as every other entry.
      if (now >= win.resetsAt) due.push(entry)
    }
  }
  return due
}
