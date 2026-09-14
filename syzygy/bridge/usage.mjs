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

/** How long after a published boundary the clock alone counts as proof the
 *  window reset. The reading cannot be waited for: when the limit stops every
 *  session no statusline runs, and the side channel goes dark for exactly the
 *  stretch this exists to cover. The grace absorbs clock skew and the account
 *  rolling the window over a little late. */
export const RESET_GRACE_MS = 90_000

/** Which pending after-reset entries have genuinely fired. `queue` is the
 *  after-reset store's full item list (bridge/after-reset.mjs); only
 *  `state: 'pending'` entries are considered, everything else is already
 *  settled.
 *
 *  An entry armed against a boundary fires on either of two proofs: a FRESH
 *  reading showing this window's boundary has moved past the armed one (not
 *  merely reached it, since `armedResetsAt` and a reading taken exactly at the
 *  old boundary can coincide), or the clock passing `armedResetsAt + graceMs`,
 *  whatever the reading says. The boundary is an absolute time the account
 *  publishes, so once it and the grace have passed the window has reset, even
 *  when no session is left running to report it.
 *
 *  An entry with no armed boundary (hand-added straight into after-reset.json)
 *  has nothing to have moved past and no boundary of its own for the clock to
 *  pass, so it still needs a fresh reading of its window, and fires once the
 *  clock reaches that reading's `resetsAt`. */
export const dueEntries = (queue, usage, now, graceMs = RESET_GRACE_MS) => {
  if (!Array.isArray(queue)) return []
  const fresh = !!usage && !usage.stale
  const due = []
  for (const entry of queue) {
    if (!entry || entry.state !== 'pending') continue
    const win = fresh ? usage[entry.window] : null
    if (Number.isFinite(entry.armedResetsAt)) {
      if ((win && win.resetsAt > entry.armedResetsAt) || now >= entry.armedResetsAt + graceMs) due.push(entry)
    } else if (win && now >= win.resetsAt) {
      due.push(entry)
    }
  }
  return due
}

/** Minutes since local midnight. Its own function, and INJECTABLE at every
 *  call site, so the night-window maths can be driven at a fixed time of day
 *  without a test depending on the runner's timezone. */
export const localMinutes = (ts) => {
  const d = new Date(ts)
  return d.getHours() * 60 + d.getMinutes()
}

/** "HH:MM" -> minutes since midnight, or null. Null is the whole error
 *  channel: a malformed time must read as "not night", never as "always
 *  night" -- a settings file with a typo in it should stop the feature, not
 *  arm a session every fifteen seconds. */
const hhmm = (s) => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(s ?? ''))
  if (!m) return null
  const h = Number(m[1]), min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Is `ts` inside [start, end)? Wraps midnight, which is the normal case
 *  here: 23:00-07:00 is two intervals, and a naive `a <= x && x < b` is false
 *  for all of them. start === end is an empty window, not a whole day -- a
 *  half-edited settings file should do nothing rather than arm all day. */
export const inNightWindow = (ts, window, mins = localMinutes) => {
  const start = hhmm(window?.start), end = hhmm(window?.end)
  if (start === null || end === null || start === end) return false
  const now = mins(ts)
  return start < end ? (now >= start && now < end) : (now >= start || now < end)
}

/** Every plan a night run may pick up, newest first.
 *
 *  Folded by BASENAME, via the scanner's own `efforts[]` -- a plan is
 *  identified by its basename, and a project can carry many worktrees of the
 *  same checkout, so walking worktrees[].plans[] directly would offer the
 *  same plan more than once and would count progress per copy instead of
 *  overall. `foldEfforts` already reports the most advanced copy's counts,
 *  which is exactly the honest answer to "has anyone started this".
 *
 *  The per-copy fields the fold does not carry -- `spec`, `owner`, `mtimeMs`
 *  -- are read off the first PRESENT copy by `rel` (main is listed first); a
 *  copy marked `absent` (removed in that worktree) is skipped so it can
 *  never stand in for a real one.
 *
 *  `at === 'main'` is not a nicety: a night worktree branches from the main
 *  root's current HEAD, so a plan that lives only in some other worktree is
 *  NOT on the branch the session would get. Offering it would point a
 *  session at a file that is not there. Never throws: every failure is an
 *  empty list. */
export const eligiblePlans = (projects) => {
  const out = []
  for (const p of Array.isArray(projects) ? projects : []) {
    const worktrees = Array.isArray(p?.worktrees) ? p.worktrees : []
    const byRel = new Map()
    for (const w of worktrees) for (const pl of (Array.isArray(w?.plans) ? w.plans : [])) {
      if (pl && !pl.absent && typeof pl.rel === 'string' && !byRel.has(pl.rel)) byRel.set(pl.rel, pl)
    }
    for (const e of (Array.isArray(p?.efforts) ? p.efforts : [])) {
      if (!e || e.at !== 'main') continue
      if (e.shipped) continue
      if (!(Number(e.total) > 0)) continue
      if (Number(e.done) !== 0 || Number(e.reported) !== 0) continue
      if (Array.isArray(e.claimedBy) && e.claimedBy.length) continue
      const copy = byRel.get(e.rel)
      if (!copy) continue
      if (copy.owner) continue
      if (typeof copy.spec !== 'string' || !copy.spec.trim()) continue
      out.push({
        key: p.key ?? null, project: p.name ?? null, mainRoot: p.mainRoot ?? null,
        name: e.name, title: e.title || e.name, rel: e.rel,
        spec: copy.spec, total: Number(e.total), mtimeMs: Number(copy.mtimeMs) || 0,
      })
    }
  }
  // Newest first: a plan written today is the one somebody just decided to
  // build. `rel` breaks ties so the auto-arm's choice is reproducible rather
  // than dependent on directory order.
  out.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

/** The night policy's defaults. `enabled: false` is the important one:
 *  nothing spawns until somebody turns it on. */
export const DEFAULT_NIGHT = Object.freeze({
  enabled: false, start: '23:00', end: '07:00', budgetUsd: 25, maxHours: 6,
})

/** A just-fired session has not necessarily registered with the relay yet --
 *  a background launch returns before the child has reported in, and a
 *  listing taken in that gap would read as "not running" and let auto-arm
 *  fire a second copy on top of the first. Ten minutes is generous cover for
 *  that gap without letting a session that genuinely died hold the slot
 *  forever. A module-level constant rather than an option: nothing external
 *  should be tuning this. */
const STARTUP_GRACE_MS = 10 * 60_000

/** Is this queue entry a night run that has not finished? A fired `plan`
 *  entry counts as running either because its spawned session is still
 *  registered with the relay, or -- within the startup grace window, only
 *  when no session has matched it yet and it has not been marked stopped --
 *  because it was fired too recently to have registered at all. `now` is
 *  needed only for that second case. */
const liveNightRun = (queue, sessions, now) => {
  const ss = Array.isArray(sessions) ? sessions : []
  for (const e of Array.isArray(queue) ? queue : []) {
    if (!e || e.kind !== 'plan' || e.state !== 'fired') continue
    const spawn = e.payload?.spawn
    if (!spawn) continue
    const s = ss.find((x) => x && (x.shortId === spawn.shortId || x.name === spawn.name))
    if (s) return { entry: e, session: s, name: spawn.name || s.name || spawn.shortId, starting: false }
    if (e.payload?.stoppedAt) continue
    const since = Number(e.firedAt ?? spawn.spawnedAt)
    if (Number.isFinite(since) && Number.isFinite(now) && now - since < STARTUP_GRACE_MS) {
      return { entry: e, session: null, name: spawn.name || spawn.shortId, starting: true }
    }
  }
  return null
}

/** The whole auto-arm decision, one object in, one object out, and a reason
 *  on every refusal. relay.mjs publishes the reason as `night.held`, so the
 *  panel can say why nothing is armed instead of looking broken.
 *
 *  Only the five-hour window arms: one reset a week is not the wasted hours
 *  a night run is meant to catch. A stale reading never arms -- arming off a
 *  reading nobody can vouch for is exactly the confident wrong answer this
 *  whole decision exists to avoid.
 *
 *  A plan already fired or failed once is never picked again on its own: a
 *  failed run left something for somebody to look at, and a successful one
 *  already used its night. Both wait for a person, not for the queue entry
 *  to clear itself. */
export const autoArmDecision = ({ usage, queue, settings, projects, sessions, now, mins = localMinutes } = {}) => {
  const night = settings?.night
  if (!night || !night.enabled) return { arm: false, reason: 'night hours are off' }
  if (!usage || usage.stale) return { arm: false, reason: 'no fresh usage reading — nothing is armed while the account reading is stale' }
  const win = usage.fiveHour
  if (!win || !Number.isFinite(win.resetsAt)) return { arm: false, reason: 'no five-hour reading to arm against' }
  if (!inNightWindow(win.resetsAt, night, mins)) {
    return { arm: false, reason: `the next five-hour reset is not inside night hours (${night.start}–${night.end})` }
  }
  const q = Array.isArray(queue) ? queue : []
  const pending = q.find((e) => e?.kind === 'plan' && e.state === 'pending')
  if (pending) return { arm: false, reason: 'a plan is already armed and pending' }
  const running = liveNightRun(q, sessions, now)
  if (running) {
    if (running.starting) {
      return { arm: false, reason: `${running.name} was just started and has not registered yet` }
    }
    return {
      arm: false,
      reason: running.session.waiting
        ? `${running.name} is waiting on a human — ${running.session.waitingFor || 'no reason reported'}`
        : `${running.name} is still running`,
    }
  }
  if (!Array.isArray(projects) || projects.length === 0) {
    return { arm: false, reason: 'no project is being scanned — night hours choose only from projects with an open session' }
  }
  const elig = eligiblePlans(projects)
  if (elig.length === 0) {
    return { arm: false, reason: 'no plan is eligible — a plan needs a Spec: line, no ticked or reported steps, no owner, and a copy in the project’s main checkout' }
  }
  const alreadyRun = q.filter((e) => e && e.kind === 'plan' && (e.state === 'fired' || e.state === 'failed'))
  const retryable = elig.filter((p) => !alreadyRun.some((e) => e.target === p.rel && e.payload?.mainRoot === p.mainRoot))
  if (retryable.length === 0) {
    return { arm: false, reason: 'every eligible plan has already had a night run — clear its queue entry, or ⌥-click it to run it again' }
  }
  return { arm: true, plan: retryable[0] }
}

/** The reading at which a window counts as SPENT. Not 100: the account's own
 *  used_percentage can plateau just under, and the grace below is what covers
 *  the rest. */
export const LIMIT_PCT = 98

/** How far BEFORE the limit was observed spent a session may have frozen and
 *  still count. The reading is a side channel with its own staleness bound on
 *  top of the poll, so a session can stop before the number proves it. */
export const DISRUPT_GRACE_MS = 15 * 60_000

/** A listing older than this cannot vouch for any session being alive, so
 *  nothing fires on it. Failing closed: a fleet left un-prompted with a reason
 *  beats a fleet prompted on a guess. */
export const AGENTS_MAX_AGE_MS = 5 * 60_000

/** How long a session's numbers must have been still before it counts as
 *  frozen. A session the limit stopped has not moved for minutes or hours; one
 *  that moved seconds before the reset was working, and telling it that the
 *  limit stopped its turn would be a confident wrong answer. */
export const DISRUPT_MIN_FROZEN_MS = 5 * 60_000

/** Background states that mean the session is over. Mirrors the canvas
 *  ledger's own terminal set deliberately, and the harness holds the two
 *  equal, so this file needs no import and stays pure. */
export const AGENT_SETTLED = new Set(['done', 'failed', 'stopped'])

/** Listing values that mean "stopped by the usage limit". Empty: the installed
 *  CLI has no such value in either its interactive or its background
 *  vocabulary. A later observation adds the string here and nothing else
 *  changes. */
export const LIMIT_AGENT_STATES = Object.freeze([])

/** What a resumed session is told. One constant, and it assumes nothing about
 *  the session: this reaches any session on the machine, not only one of
 *  ours. "Do not start anything new" is load-bearing -- a resumed session that
 *  invents work spends the window this exists to reclaim. */
export const RESUME_PROMPT = [
  'Your last turn was stopped by the Claude usage limit, not by anything you',
  'or your tools did. The limit has now reset.',
  '',
  'Pick up exactly where you left off. First re-read what you were part-way',
  'through and check nothing was left half-written -- a file, an edit, a command',
  'whose output you never saw. Finish that, then carry on with the task you',
  'were on.',
  '',
  'If you were already finished, say so in one line and stop. Do not start',
  'anything new.',
].join('\n')

/** The open limit episode for one window, or null.
 *
 *  Opened by the window's reading at or past LIMIT_PCT -- even a stale one, as
 *  long as its boundary plus the grace is still ahead, because the limit that
 *  stops every session also stops the statusline that would have kept the
 *  reading fresh. `spentAt` is when that reading was taken (the window's own
 *  `observedAt` when it carries one, else the usage object's), never later
 *  than `now`, and it never moves once the episode is open.
 *
 *  Closed by the same two proofs a queued entry's fire uses: a fresh reading
 *  showing this window's boundary has moved PAST the recorded one, or the clock
 *  passing `resetsAt + graceMs`, whatever the reading says.
 *
 *  `pct` tracks a fresh reading of the same boundary, so a panel can show it
 *  climbing; a stale or missing reading leaves the episode as it was. */
export const limitEpisode = (prev, usage, window, now, graceMs = RESET_GRACE_MS) => {
  const win = usage?.[window] ?? null
  const fresh = !!usage && !usage.stale
  if (prev && prev.window === window) {
    if (now >= prev.resetsAt + graceMs) return null
    if (fresh && win && Number.isFinite(win.resetsAt) && win.resetsAt > prev.resetsAt) return null
    if (fresh && win && win.resetsAt === prev.resetsAt && Number.isFinite(Number(win.pct))) return { ...prev, pct: Number(win.pct) }
    return prev
  }
  if (!win || !Number.isFinite(win.resetsAt) || win.resetsAt + graceMs <= now) return null
  if (!(Number(win.pct) >= LIMIT_PCT)) return null
  const seen = Number.isFinite(win.observedAt) ? win.observedAt
    : Number.isFinite(usage?.observedAt) ? usage.observedAt : now
  return { window, resetsAt: win.resetsAt, spentAt: Math.min(seen, now), pct: Number(win.pct) }
}

const agentRow = (agents, id) => {
  for (const a of Array.isArray(agents) ? agents : []) {
    if (a && a.sessionId === id) return a
  }
  return null
}

/** Which registered sessions were stopped by the limit and are still there.
 *
 *  Every row is returned with an `eligible` flag rather than filtered out,
 *  because the panel shows an excluded or already-fired session too -- a row
 *  that silently vanished would be indistinguishable from one that was never
 *  noticed. `held` carries a sentence whenever nothing can fire at all.
 *
 *  Pure: no clock, no fs, no listing of its own. */
export const disruptedSessions = ({
  sessions, agents, agentsAt, episode, excluded = [], fired = [], now,
  limitStates = LIMIT_AGENT_STATES, minFrozenMs = DISRUPT_MIN_FROZEN_MS,
} = {}) => {
  if (!episode) return { held: 'no limit episode is open', rows: [] }
  if (!Array.isArray(agents) || !Number.isFinite(agentsAt) || (now - agentsAt) > AGENTS_MAX_AGE_MS) {
    return { held: 'no agent listing newer than five minutes — nothing fires while aliveness cannot be vouched for', rows: [] }
  }
  const limit = limitStates instanceof Set ? limitStates : new Set(limitStates)
  const from = episode.spentAt - DISRUPT_GRACE_MS
  const excludedIds = new Set(excluded.map((e) => e && e.id).filter(Boolean))
  const firedIds = new Set(
    fired.filter((e) => e && e.kind === 'resume' && e.armedResetsAt === episode.resetsAt
      && !(e.payload && e.payload.byHand))
      .map((e) => e.target),
  )
  const rows = []
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s.id !== 'string') continue
    const a = agentRow(agents, s.id)
    if (!a) continue                                   // absent from a good listing is a fact
    if (typeof a.state === 'string' && AGENT_SETTLED.has(a.state)) continue
    const reported = limit.has(a.state) || limit.has(a.status)
    if (!reported) {
      if (a.status === 'waiting' || a.state === 'blocked' || s.waiting) continue
      const at = Number(s.progressAt)
      if (!Number.isFinite(at) || at < from || at > episode.resetsAt) continue
      if (now - at < minFrozenMs) continue
    }
    const isExcluded = excludedIds.has(s.id)
    rows.push({
      id: s.id,
      name: s.name ?? '',
      shortId: s.shortId ?? '',
      progressAt: Number(s.progressAt) || 0,
      reason: reported
        ? 'the agent listing reported it stopped by the usage limit'
        : 'its numbers stopped moving while the window was spent, and have not moved since',
      excluded: isExcluded,
      eligible: !isExcluded && !firedIds.has(s.id),
    })
  }
  return { held: null, rows }
}
