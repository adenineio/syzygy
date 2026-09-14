#!/usr/bin/env node
// Drives bridge/usage.mjs and bridge/after-reset.mjs directly. Hermetic: no
// relay, no real filesystem beyond a temp dir for the store, and the
// statusline directory is a fake `fs` object handed to readNewestStatusline
// -- never a read of the real ~/.claude/syzygy/statusline. A fixture is a real
// drop's shape, copied in. Run: node test/usage-harness.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { parseUsage, readNewestStatusline, crossings, dueEntries, DEFAULT_STALE_MS,
        localMinutes, inNightWindow, eligiblePlans, autoArmDecision, DEFAULT_NIGHT,
        limitEpisode, disruptedSessions, LIMIT_PCT, DISRUPT_GRACE_MS, AGENTS_MAX_AGE_MS,
        AGENT_SETTLED, LIMIT_AGENT_STATES, RESUME_PROMPT, DISRUPT_MIN_FROZEN_MS, RESET_GRACE_MS } =
  await import(join(ROOT, 'syzygy', 'bridge', 'usage.mjs'))
const { createAfterResetStore, RESUME_WINDOWS } =
  await import(join(ROOT, 'syzygy', 'bridge', 'after-reset.mjs'))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }
const dir = mkdtempSync(join(tmpdir(), 'szg-usage-'))

// A real drop's shape, copied in
// and redacted -- the host path and every session-identifying field a real
// drop carries are replaced with placeholders. Only `rate_limits` and
// `szg_written_at` matter to parseUsage; the rest proves it tolerates a drop
// carrying dozens of fields it does not read.
const REAL_DROP = {
  session_id: 'redacted-session',
  transcript_path: '~/.claude/projects/redacted/redacted.jsonl',
  cwd: '~/redacted-project',
  model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1' },
  version: '2.1.269',
  context_window: { context_window_size: 1_000_000, used_percentage: 37 },
  rate_limits: {
    five_hour: { used_percentage: 23, resets_at: 1789171200 },
    seven_day: { used_percentage: 76, resets_at: 1789261200 },
  },
  szg_written_at: 1789165024,
}

// ======================================================================
// parseUsage
// ======================================================================

await ok('parseUsage reads a real drop\'s two windows, converting seconds to ms', () => {
  const now = 1789165024_000 // exactly szg_written_at, in ms -- freshest possible
  const u = parseUsage(REAL_DROP, now)
  assert.equal(u.stale, false)
  assert.equal(u.observedAt, 1789165024_000)
  assert.deepEqual(u.fiveHour, { pct: 23, resetsAt: 1789171200_000, resetsInMs: 1789171200_000 - now, expired: false })
  assert.deepEqual(u.sevenDay, { pct: 76, resetsAt: 1789261200_000, resetsInMs: 1789261200_000 - now, expired: false })
})

await ok('parseUsage never throws on malformed input: both windows null', () => {
  for (const bad of [null, undefined, 'a string', 42, [], {}]) {
    const u = parseUsage(bad, Date.now())
    assert.equal(u.fiveHour, null, JSON.stringify(bad))
    assert.equal(u.sevenDay, null, JSON.stringify(bad))
    assert.equal(u.stale, true, JSON.stringify(bad))
  }
})

await ok('parseUsage tolerates a missing rate_limits block: both windows null, no throw', () => {
  const u = parseUsage({ szg_written_at: 1000, session_id: 'x' }, 1000_000)
  assert.equal(u.fiveHour, null)
  assert.equal(u.sevenDay, null)
  assert.equal(u.observedAt, 1_000_000)
})

await ok('parseUsage tolerates one window missing while the other is present', () => {
  const u = parseUsage({ szg_written_at: 0, rate_limits: { five_hour: { used_percentage: 10, resets_at: 100 } } }, 0)
  assert.ok(u.fiveHour)
  assert.equal(u.sevenDay, null)
})

await ok('parseUsage: a stamp older than the stale window reads stale', () => {
  const writtenAtMs = 1_000_000
  const drop = { ...REAL_DROP, szg_written_at: writtenAtMs / 1000 }
  assert.equal(parseUsage(drop, writtenAtMs + DEFAULT_STALE_MS + 1, DEFAULT_STALE_MS).stale, true)
  assert.equal(parseUsage(drop, writtenAtMs + DEFAULT_STALE_MS, DEFAULT_STALE_MS).stale, false, 'exactly at the boundary is still fresh')
})

await ok('parseUsage: no szg_written_at at all reads stale, never as fresh-by-default', () => {
  const u = parseUsage({ rate_limits: REAL_DROP.rate_limits }, Date.now())
  assert.equal(u.observedAt, null)
  assert.equal(u.stale, true)
})

await ok('parseUsage: a stale reading still returns real resetsAt values, not nulled windows', () => {
  const drop = { ...REAL_DROP, szg_written_at: 0 }
  const now = DEFAULT_STALE_MS * 10 // hours stale
  const u = parseUsage(drop, now)
  assert.equal(u.stale, true)
  assert.ok(u.fiveHour, 'the window itself must survive staleness -- only display hides the pct')
  assert.equal(u.fiveHour.pct, 23)
  assert.equal(u.fiveHour.resetsAt, 1789171200_000)
})

await ok('parseUsage marks an already-passed boundary as expired, with a negative resetsInMs', () => {
  const drop = { szg_written_at: 100, rate_limits: { five_hour: { used_percentage: 99, resets_at: 100 } } }
  const u = parseUsage(drop, 200_000) // now is far past resets_at (100s = 100000ms)
  assert.equal(u.fiveHour.expired, true)
  assert.ok(u.fiveHour.resetsInMs < 0)
})

// ======================================================================
// readNewestStatusline
// ======================================================================

/** A fake fs exposing only what readNewestStatusline touches. `files` maps a
 *  FULL path (as usage.mjs's own `join(dir, name)` will build it) to
 *  { mtimeMs, content }, so the test controls mtime order independently of
 *  filesystem write order. */
const fakeFs = (statusDir, files) => ({
  readdirSync: (d) => {
    if (d !== statusDir) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
    return Object.keys(files).map((full) => full.slice(statusDir.length + 1))
  },
  statSync: (full) => {
    if (!(full in files)) throw new Error(`no such file: ${full}`)
    return { mtimeMs: files[full].mtimeMs }
  },
  readFileSync: (full) => {
    if (!(full in files)) throw new Error(`no such file: ${full}`)
    return files[full].content
  },
})

await ok('readNewestStatusline is null when the directory does not exist', () => {
  assert.equal(readNewestStatusline('/nowhere', { fs: fakeFs('/elsewhere', {}) }), null)
})

await ok('readNewestStatusline is null with no fs injected', () => {
  assert.equal(readNewestStatusline('/x', {}), null)
})

await ok('readNewestStatusline: the newest file wins when it is usable', () => {
  const d = '/status'
  const old = join(d, 'old.json'), fresh = join(d, 'fresh.json')
  const fs = fakeFs(d, {
    [old]: { mtimeMs: 1000, content: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 1 } } }) },
    [fresh]: { mtimeMs: 2000, content: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 99, resets_at: 2 } } }) },
  })
  const got = readNewestStatusline(d, { fs })
  assert.equal(got.rate_limits.five_hour.used_percentage, 99)
})

await ok('readNewestStatusline: a newest file with no rate_limits does not blind the board', () => {
  const d = '/status'
  const old = join(d, 'old.json'), fresh = join(d, 'fresh.json')
  const fs = fakeFs(d, {
    [old]: { mtimeMs: 1000, content: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 1 } } }) },
    // The NEWEST drop, but no rate_limits block yet (e.g. a session that has
    // not reported one) -- must fall through to the older, usable file.
    [fresh]: { mtimeMs: 2000, content: JSON.stringify({ session_id: 'x' }) },
  })
  const got = readNewestStatusline(d, { fs })
  assert.equal(got.rate_limits.five_hour.used_percentage, 10)
})

await ok('readNewestStatusline gives up after 5 parses rather than scanning forever', () => {
  const d = '/status'
  const files = {}
  // 6 candidates, newest-to-oldest by mtime, none usable until the 6th (which
  // must never be reached: the cap is 5).
  for (let i = 0; i < 6; i++) {
    const full = join(d, `f${i}.json`)
    const usable = i === 5
    files[full] = {
      mtimeMs: 6000 - i * 100,
      content: usable
        ? JSON.stringify({ rate_limits: { five_hour: { used_percentage: 1, resets_at: 1 } } })
        : JSON.stringify({ no_rate_limits_here: true }),
    }
  }
  const got = readNewestStatusline(d, { fs: fakeFs(d, files) })
  assert.equal(got, null, 'the 6th, usable file must not be reached')
})

await ok('readNewestStatusline ignores non-.json entries and unreadable/unparseable files', () => {
  const d = '/status'
  const files = {
    [join(d, 'note.txt')]: { mtimeMs: 9999, content: 'not json at all' },
    [join(d, 'broken.json')]: { mtimeMs: 5000, content: '{not valid json' },
    [join(d, 'good.json')]: { mtimeMs: 1000, content: JSON.stringify({ rate_limits: { seven_day: { used_percentage: 5, resets_at: 9 } } }) },
  }
  const got = readNewestStatusline(d, { fs: fakeFs(d, files) })
  assert.equal(got.rate_limits.seven_day.used_percentage, 5)
})

// ======================================================================
// crossings
// ======================================================================

const usageAt = (fiveHourPct, sevenDayPct) => ({
  fiveHour: fiveHourPct == null ? null : { pct: fiveHourPct, resetsAt: 1000, resetsInMs: 1000, expired: false },
  sevenDay: sevenDayPct == null ? null : { pct: sevenDayPct, resetsAt: 2000, resetsInMs: 2000, expired: false },
  observedAt: 0, stale: false,
})

await ok('crossings fires once when pct climbs through a threshold', () => {
  const c = crossings(usageAt(80, 10), usageAt(90, 10), [85, 95])
  assert.deepEqual(c, [{ window: 'fiveHour', threshold: 85 }])
})

await ok('crossings does not fire for a threshold not yet reached', () => {
  assert.deepEqual(crossings(usageAt(80, 10), usageAt(84, 10), [85, 95]), [])
})

await ok('crossings does not re-fire while pct sits above an already-crossed threshold', () => {
  assert.deepEqual(crossings(usageAt(90, 10), usageAt(91, 10), [85, 95]), [])
})

await ok('crossings fires both thresholds in one jump', () => {
  const c = crossings(usageAt(10, 10), usageAt(99, 10), [85, 95])
  assert.deepEqual(c, [{ window: 'fiveHour', threshold: 85 }, { window: 'fiveHour', threshold: 95 }])
})

await ok('crossings covers both windows independently', () => {
  const c = crossings(usageAt(10, 10), usageAt(90, 96), [85, 95])
  assert.deepEqual(c, [{ window: 'fiveHour', threshold: 85 }, { window: 'sevenDay', threshold: 85 }, { window: 'sevenDay', threshold: 95 }])
})

await ok('crossings re-arm: a reset that drops pct lets the same threshold fire again', () => {
  // First climb: crosses 85. Window resets (pct falls back down with no
  // special-casing needed -- see the file header). Second climb: crosses 85
  // again, exactly the "re-armed when resetsAt moves" behaviour.
  const first = crossings(usageAt(80, 0), usageAt(90, 0), [85])
  assert.deepEqual(first, [{ window: 'fiveHour', threshold: 85 }])
  const afterReset = usageAt(3, 0) // the window rolled over
  const second = crossings(afterReset, usageAt(86, 0), [85])
  assert.deepEqual(second, [{ window: 'fiveHour', threshold: 85 }])
})

await ok('crossings tolerates a missing prev or next window (no prior reading yet)', () => {
  assert.deepEqual(crossings(usageAt(null, 10), usageAt(90, 10), [85]), [])
  assert.deepEqual(crossings(null, usageAt(90, 10), [85]), [])
  assert.deepEqual(crossings(usageAt(10, 10), null, [85]), [])
})

// ======================================================================
// dueEntries
// ======================================================================

const pendingEntry = (fields) => ({
  id: 'e1', createdAt: 0, window: 'fiveHour', kind: 'prompt', target: 's1', payload: {},
  armedResetsAt: null, state: 'pending', firedAt: null, error: null, ...fields,
})

await ok('dueEntries: fires only once a fresh reading shows the boundary moved PAST the armed one', () => {
  const usage = { fiveHour: { pct: 1, resetsAt: 2000, resetsInMs: 1000, expired: false }, sevenDay: null, stale: false }
  assert.deepEqual(dueEntries([pendingEntry({ armedResetsAt: 1000 })], usage, 5000), [pendingEntry({ armedResetsAt: 1000 })])
  // Armed AT the current resetsAt (not past it) must not fire -- equal is not "moved".
  assert.deepEqual(dueEntries([pendingEntry({ armedResetsAt: 2000 })], usage, 5000), [])
  // Still in the future: no fire.
  assert.deepEqual(dueEntries([pendingEntry({ armedResetsAt: 3000 })], usage, 5000), [])
})

await ok('dueEntries: a dark reading still fires an armed entry by the clock, and not before the grace', () => {
  const stale = { fiveHour: { pct: 99, resetsAt: 100, resetsInMs: -900, expired: true }, sevenDay: null, stale: true }
  const dark = { fiveHour: null, sevenDay: null, observedAt: null, stale: true }
  const e = pendingEntry({ armedResetsAt: 50 })
  assert.deepEqual(dueEntries([e], stale, 50 + RESET_GRACE_MS - 1), [])
  assert.deepEqual(dueEntries([e], stale, 50 + RESET_GRACE_MS), [e])
  assert.deepEqual(dueEntries([e], dark, 50 + RESET_GRACE_MS), [e], 'a null window is no reason to wait')
  assert.deepEqual(dueEntries([e], null, 50 + RESET_GRACE_MS), [e])
  assert.deepEqual(dueEntries([pendingEntry({ armedResetsAt: null })], stale, 999_999), [], 'with no armed boundary a fresh reading is still required')
})

await ok('dueEntries: no armed boundary falls back to fresh reading + now >= resetsAt', () => {
  const usage = { fiveHour: { pct: 1, resetsAt: 1000, resetsInMs: 0, expired: true }, sevenDay: null, stale: false }
  assert.deepEqual(dueEntries([pendingEntry({ armedResetsAt: null })], usage, 1000), [pendingEntry({ armedResetsAt: null })])
  assert.deepEqual(dueEntries([pendingEntry({ armedResetsAt: null })], usage, 999), [])
})

await ok('dueEntries ignores non-pending entries and entries for an absent window', () => {
  const usage = { fiveHour: { pct: 1, resetsAt: 100, resetsInMs: -1, expired: true }, sevenDay: null, stale: false }
  assert.deepEqual(dueEntries([pendingEntry({ state: 'fired', armedResetsAt: 0 })], usage, 999), [])
  assert.deepEqual(dueEntries([pendingEntry({ state: 'cancelled', armedResetsAt: 0 })], usage, 999), [])
  assert.deepEqual(dueEntries([pendingEntry({ window: 'sevenDay', armedResetsAt: 0 })], usage, 999), [], 'sevenDay is null in this usage reading')
})

await ok('dueEntries tolerates a non-array queue', () => {
  assert.deepEqual(dueEntries(null, { fiveHour: null, sevenDay: null, stale: false }, 0), [])
  assert.deepEqual(dueEntries(undefined, { fiveHour: null, sevenDay: null, stale: false }, 0), [])
})

// ======================================================================
// night hours: inNightWindow
// ======================================================================
// `mins` is INJECTED in every case here. A night-window test that reads the
// runner's clock passes in London and fails in Sydney, which is not a test.
const at = (h, m = 0) => h * 60 + m
const fixedMins = (v) => () => v

await ok('inNightWindow wraps midnight: 23:00-07:00 is two intervals, not one', () => {
  const w = { start: '23:00', end: '07:00' }
  assert.equal(inNightWindow(0, w, fixedMins(at(22, 59))), false)
  assert.equal(inNightWindow(0, w, fixedMins(at(23, 0))), true, 'start is inclusive')
  assert.equal(inNightWindow(0, w, fixedMins(at(3, 0))), true)
  assert.equal(inNightWindow(0, w, fixedMins(at(6, 59))), true)
  assert.equal(inNightWindow(0, w, fixedMins(at(7, 0))), false, 'end is exclusive')
})

await ok('inNightWindow handles a window that does not wrap', () => {
  const w = { start: '09:00', end: '17:00' }
  assert.equal(inNightWindow(0, w, fixedMins(at(8, 59))), false)
  assert.equal(inNightWindow(0, w, fixedMins(at(9, 0))), true)
  assert.equal(inNightWindow(0, w, fixedMins(at(16, 59))), true)
  assert.equal(inNightWindow(0, w, fixedMins(at(17, 0))), false)
})

await ok('inNightWindow reads a malformed time as false, never as always-night', () => {
  for (const bad of [null, undefined, {}, { start: '23:00' }, { start: 'x', end: '07:00' },
                     { start: '25:00', end: '07:00' }, { start: '23:70', end: '07:00' }]) {
    assert.equal(inNightWindow(0, bad, fixedMins(at(2, 0))), false, JSON.stringify(bad))
  }
})

await ok('inNightWindow with start === end is never night (an empty window, not a whole day)', () => {
  assert.equal(inNightWindow(0, { start: '23:00', end: '23:00' }, fixedMins(at(23, 0))), false)
})

// ======================================================================
// night hours: eligiblePlans
// ======================================================================
// Shaped exactly like the scanner's payload: an effort is the BASENAME fold
// (tasks-efforts.mjs) and the per-copy `spec`/`owner`/`mtimeMs` live on
// worktrees[].plans[]. Eligibility joins the two by `rel`.
const proj = ({ efforts, plans, mainRoot = '/repo' }) => ([{
  key: '/repo/.git', name: 'repo', mainRoot,
  efforts,
  worktrees: [{ path: mainRoot, isMain: true, plans }],
}])

const effort = (o) => ({ name: 'p.md', title: 'P', rel: 'plans/p.md',
  done: 0, reported: 0, total: 4, shipped: null, claimedBy: [], at: 'main', ...o })
const planFile = (o) => ({ rel: 'plans/p.md', spec: 'specs/p-design.md',
  owner: null, mtimeMs: 1000, ...o })

await ok('eligiblePlans accepts a spec-backed, untouched, unowned plan in main', () => {
  const out = eligiblePlans(proj({ efforts: [effort({})], plans: [planFile({})] }))
  assert.equal(out.length, 1)
  assert.equal(out[0].rel, 'plans/p.md')
  assert.equal(out[0].mainRoot, '/repo')
  assert.equal(out[0].total, 4)
})

await ok('eligiblePlans excludes, one reason at a time', () => {
  const cases = [
    ['no Spec: line',        { effort: {},                    plan: { spec: null } }],
    ['no Spec: line (empty)',{ effort: {},                    plan: { spec: '' } }],
    ['a verified step',      { effort: { done: 1 },           plan: {} }],
    ['a reported step',      { effort: { reported: 1 },       plan: {} }],
    ['declared Shipped:',    { effort: { shipped: 'declared' }, plan: {} }],
    ['no steps at all',      { effort: { total: 0 },          plan: {} }],
    ['claimed by a session', { effort: { claimedBy: [{ id: 's1', name: 'a' }] }, plan: {} }],
    ['an owner',             { effort: {},                    plan: { owner: { id: 's1', name: 'a' } } }],
    ['winning copy is not main', { effort: { at: '/repo/.claude/worktrees/x' }, plan: {} }],
  ]
  for (const [label, c] of cases) {
    const out = eligiblePlans(proj({ efforts: [effort(c.effort)], plans: [planFile(c.plan)] }))
    assert.equal(out.length, 0, label + ' should be excluded')
  }
})

await ok('eligiblePlans skips an absent copy and reads fields off the first present one', () => {
  // Main lists the plan as absent there; a linked worktree still has it. The
  // first PRESENT copy by `rel` wins -- never the absent placeholder.
  const out = eligiblePlans([{
    key: '/repo/.git', name: 'repo', mainRoot: '/repo',
    efforts: [effort({})],
    worktrees: [
      { path: '/repo', isMain: true, plans: [{ rel: 'plans/p.md', absent: true }] },
      { path: '/repo/wt-a', plans: [planFile({})] },
    ],
  }])
  assert.equal(out.length, 1)
  assert.equal(out[0].spec, 'specs/p-design.md')
})

await ok('eligiblePlans folds by basename: three copies are one candidate, and progress in ANY copy disqualifies', () => {
  // foldEfforts already reports the most advanced copy's counts, so this is
  // asserted through the effort -- the whole point of using it rather than
  // walking worktrees[].plans[] and counting per copy.
  const one = eligiblePlans([{
    key: '/repo/.git', name: 'repo', mainRoot: '/repo',
    efforts: [effort({ copies: 3 })],
    worktrees: [
      { path: '/repo', isMain: true, plans: [planFile({})] },
      { path: '/repo/wt-a', plans: [planFile({})] },
      { path: '/repo/wt-b', plans: [planFile({})] },
    ],
  }])
  assert.equal(one.length, 1, 'one effort, one candidate')
  const started = eligiblePlans([{
    key: '/repo/.git', name: 'repo', mainRoot: '/repo',
    efforts: [effort({ done: 2 })],
    worktrees: [{ path: '/repo', isMain: true, plans: [planFile({})] }],
  }])
  assert.equal(started.length, 0)
})

await ok('eligiblePlans orders newest mtimeMs first, ties broken by rel ascending', () => {
  const out = eligiblePlans([{
    key: '/repo/.git', name: 'repo', mainRoot: '/repo',
    efforts: [
      effort({ name: 'a.md', rel: 'plans/a.md' }),
      effort({ name: 'b.md', rel: 'plans/b.md' }),
      effort({ name: 'c.md', rel: 'plans/c.md' }),
    ],
    worktrees: [{ path: '/repo', isMain: true, plans: [
      planFile({ rel: 'plans/a.md', mtimeMs: 500 }),
      planFile({ rel: 'plans/b.md', mtimeMs: 900 }),
      planFile({ rel: 'plans/c.md', mtimeMs: 900 }),
    ] }],
  }])
  assert.deepEqual(out.map((p) => p.name), ['b.md', 'c.md', 'a.md'])
})

await ok('eligiblePlans never throws on a malformed payload', () => {
  for (const bad of [null, undefined, {}, [], [null], [{ efforts: null }], [{ efforts: [{}], worktrees: null }]]) {
    assert.deepEqual(eligiblePlans(bad), [], JSON.stringify(bad))
  }
})

// ======================================================================
// night hours: autoArmDecision
// ======================================================================
// Every refusal carries a REASON. A bare `false` would make "night is off",
// "no plan qualifies" and "a session is waiting" indistinguishable on the
// panel, which is the confident-wrong-answer shape this codebase refuses.
const NIGHT_ON = { enabled: true, start: '23:00', end: '07:00', budgetUsd: 25, maxHours: 6 }
const FRESH = { stale: false, fiveHour: { pct: 10, resetsAt: 2_000_000, resetsInMs: 1000, expired: false }, sevenDay: null }
const base = {
  usage: FRESH, queue: [], settings: { night: NIGHT_ON }, sessions: [],
  projects: proj({ efforts: [effort({})], plans: [planFile({})] }),
  now: 1_000_000, mins: fixedMins(at(2, 0)),
}

await ok('DEFAULT_NIGHT starts disabled', () => {
  assert.equal(DEFAULT_NIGHT.enabled, false)
  assert.equal(DEFAULT_NIGHT.start, '23:00')
  assert.equal(DEFAULT_NIGHT.end, '07:00')
})

await ok('autoArmDecision arms one plan when the next 5h reset lands inside night hours', () => {
  const d = autoArmDecision(base)
  assert.equal(d.arm, true)
  assert.equal(d.plan.rel, 'plans/p.md')
})

await ok('autoArmDecision refuses with a reason, one cause at a time', () => {
  const cases = [
    ['disabled',      { settings: { night: { ...NIGHT_ON, enabled: false } } }, /off|disabled/i],
    ['stale reading', { usage: { ...FRESH, stale: true } },                     /stale|no reading/i],
    ['no 5h window',  { usage: { stale: false, fiveHour: null, sevenDay: null } }, /no .*reading|five/i],
    ['daytime reset', { mins: fixedMins(at(12, 0)) },                           /night/i],
    ['no plan',       { projects: proj({ efforts: [], plans: [] }) },           /no .*plan|eligible/i],
    ['already armed', { queue: [{ id: 'x', kind: 'plan', state: 'pending' }] }, /already|pending/i],
  ]
  for (const [label, patch, re] of cases) {
    const d = autoArmDecision({ ...base, ...patch })
    assert.equal(d.arm, false, label)
    assert.match(d.reason, re, label)
  }
})

await ok('autoArmDecision refuses while a night session is still live, and says which', () => {
  const fired = { id: 'e1', kind: 'plan', state: 'fired',
    payload: { spawn: { shortId: 'ab12', name: 'night-p' } } }
  const live = autoArmDecision({ ...base, queue: [fired],
    sessions: [{ id: 's9', shortId: 'ab12', name: 'night-p', waiting: false }] })
  assert.equal(live.arm, false)
  assert.match(live.reason, /night-p/)
})

await ok('autoArmDecision refuses while a night session is WAITING on a human -- a parked permission prompt is exactly what auto-arm must never create', () => {
  const fired = { id: 'e1', kind: 'plan', state: 'fired',
    payload: { spawn: { shortId: 'ab12', name: 'night-p' } } }
  const d = autoArmDecision({ ...base, queue: [fired],
    sessions: [{ id: 's9', shortId: 'ab12', name: 'night-p', waiting: true, waitingFor: 'permission to run git push' }] })
  assert.equal(d.arm, false)
  assert.match(d.reason, /waiting/i)
  assert.match(d.reason, /permission to run git push/)
})

await ok('autoArmDecision refuses when no project is being scanned', () => {
  const d = autoArmDecision({ ...base, projects: [] })
  assert.equal(d.arm, false)
  assert.match(d.reason, /no project is being scanned/)
})

await ok('autoArmDecision never retries a plan that already had a night run', () => {
  const failed = { id: 'e0', kind: 'plan', state: 'failed', target: 'plans/p.md', payload: { mainRoot: '/repo' } }
  const refused = autoArmDecision({ ...base, queue: [failed] })
  assert.equal(refused.arm, false)
  assert.match(refused.reason, /already had a night run/)

  const twoPlans = [{
    key: '/repo/.git', name: 'repo', mainRoot: '/repo',
    efforts: [
      effort({ rel: 'plans/p.md' }),
      effort({ name: 'a.md', rel: 'plans/a.md' }),
    ],
    worktrees: [{ path: '/repo', isMain: true, plans: [
      planFile({ rel: 'plans/p.md', mtimeMs: 2000 }),
      planFile({ rel: 'plans/a.md', mtimeMs: 1000 }),
    ] }],
  }]
  const armed = autoArmDecision({ ...base, projects: twoPlans, queue: [failed] })
  assert.equal(armed.arm, true)
  assert.equal(armed.plan.rel, 'plans/a.md')
})

await ok('autoArmDecision gives a just-started night session a startup grace period', () => {
  const fired = (firedAt) => ({ id: 'e1', kind: 'plan', state: 'fired', firedAt,
    payload: { spawn: { shortId: 'ab12', name: 'night-p', spawnedAt: firedAt } } })
  const justStarted = autoArmDecision({ ...base, now: 1_000_000,
    queue: [fired(1_000_000 - 60_000)], sessions: [] })
  assert.equal(justStarted.arm, false)
  assert.match(justStarted.reason, /night-p/)
  assert.match(justStarted.reason, /just started/)

  const longGone = autoArmDecision({ ...base, now: 1_000_000,
    queue: [fired(1_000_000 - 20 * 60_000)], sessions: [] })
  assert.equal(longGone.arm, true)
})

await ok('autoArmDecision never auto-arms off the SEVEN-DAY window', () => {
  // One reset a week is not the wasted hours a night run is meant to catch,
  // and a weekly boundary landing at 02:00 once would be a surprise, not a
  // policy.
  const d = autoArmDecision({ ...base,
    usage: { stale: false, fiveHour: null, sevenDay: { pct: 5, resetsAt: 2_000_000, resetsInMs: 1000, expired: false } } })
  assert.equal(d.arm, false)
})

await ok('autoArmDecision never throws on a malformed input', () => {
  for (const bad of [{}, { usage: null }, { settings: null }, { queue: 'x' }, { projects: 7 }]) {
    const d = autoArmDecision({ ...base, ...bad })
    assert.equal(typeof d.arm, 'boolean', JSON.stringify(bad))
    if (!d.arm) assert.equal(typeof d.reason, 'string')
  }
})

// ======================================================================
// bridge/after-reset.mjs — the store
// ======================================================================

await ok('create assigns id, state pending and the given fields', () => {
  const s = createAfterResetStore({ file: join(dir, 'a.json'), now: () => 1000 })
  const e = s.create({ window: 'fiveHour', kind: 'prompt', target: 's1', payload: { text: 'go' }, armedResetsAt: 5000 })
  assert.equal(e.state, 'pending')
  assert.equal(e.createdAt, 1000)
  assert.equal(e.armedResetsAt, 5000)
  assert.ok(e.id)
  assert.equal(s.get(e.id).payload.text, 'go')
})

await ok('create refuses an unknown window or kind', () => {
  const s = createAfterResetStore({ file: join(dir, 'c.json') })
  assert.throws(() => s.create({ window: 'nope', kind: 'prompt' }), /window/)
  assert.throws(() => s.create({ window: 'fiveHour', kind: 'nope' }), /kind/)
})

await ok('markFired moves pending -> fired or failed, and refuses a non-pending entry', () => {
  const s = createAfterResetStore({ file: join(dir, 'd.json'), now: () => 42 })
  const ok1 = s.create({ window: 'fiveHour', kind: 'implement', payload: { ids: ['x'] } })
  const bad = s.create({ window: 'sevenDay', kind: 'prompt', target: 's1' })
  s.markFired(ok1.id, { ok: true })
  assert.equal(s.get(ok1.id).state, 'fired')
  assert.equal(s.get(ok1.id).firedAt, 42)
  assert.equal(s.get(ok1.id).error, null)
  s.markFired(bad.id, { ok: false, error: 'boom' })
  assert.equal(s.get(bad.id).state, 'failed')
  assert.equal(s.get(bad.id).error, 'boom')
  // Already settled: a second markFired call is a no-op, not a state flip.
  assert.equal(s.markFired(ok1.id, { ok: false, error: 'late' }), null)
  assert.equal(s.get(ok1.id).state, 'fired')
})

await ok('cancel moves a pending entry to cancelled and leaves a settled one alone', () => {
  const s = createAfterResetStore({ file: join(dir, 'e.json') })
  const pending = s.create({ window: 'fiveHour', kind: 'prompt', target: 's1' })
  const fired = s.create({ window: 'fiveHour', kind: 'prompt', target: 's1' })
  s.markFired(fired.id, { ok: true })
  assert.equal(s.cancel(pending.id), true)
  assert.equal(s.get(pending.id).state, 'cancelled')
  assert.equal(s.cancel(fired.id), true, 'a known but already-settled id is still a successful no-op')
  assert.equal(s.get(fired.id).state, 'fired', 'settled state is not overwritten')
  assert.equal(s.cancel('no-such-id'), false)
})

await ok('flush writes atomically and reloads identically, sanitising a hand-edited entry', () => {
  const f = join(dir, 'f.json')
  const s = createAfterResetStore({ file: f })
  const e = s.create({ window: 'sevenDay', kind: 'implement', payload: { ids: ['a', 'b'] } })
  s.flush()
  assert.ok(existsSync(f))
  assert.equal(existsSync(f + '.tmp'), false, 'temp file must not survive')
  const again = createAfterResetStore({ file: f })
  assert.deepEqual(again.get(e.id).payload, { ids: ['a', 'b'] })
})

await ok('a non-object entry in the file is dropped rather than crashing the load', () => {
  const f = join(dir, 'g.json')
  writeFileSync(f, JSON.stringify({ version: 1, items: [null, 'garbage', { id: 'ok1', window: 'fiveHour', kind: 'prompt', state: 'pending' }, { window: 'no-id-field' }] }))
  const s = createAfterResetStore({ file: f })
  assert.deepEqual(s.all().map((e) => e.id), ['ok1'])
})

await ok('a corrupt file is moved aside rather than silently overwritten', () => {
  const f = join(dir, 'h.json')
  writeFileSync(f, '{not json')
  const s = createAfterResetStore({ file: f, now: () => 777 })
  assert.deepEqual(s.all(), [])
  assert.ok(existsSync(f + '.corrupt-777'))
  assert.equal(readFileSync(f + '.corrupt-777', 'utf8'), '{not json')
})

await ok("the store accepts kind 'plan'", () => {
  const f = join(dir, 'ar-plan.json')
  const s = createAfterResetStore({ file: f, now: () => 1 })
  const e = s.create({ window: 'fiveHour', kind: 'plan', target: 'plans/p.md',
    payload: { mainRoot: '/repo', planName: 'p.md' } })
  assert.equal(e.kind, 'plan')
  assert.equal(e.state, 'pending')
})

await ok('markFired merges a payload rather than replacing it', () => {
  const f = join(dir, 'ar-merge.json')
  const s = createAfterResetStore({ file: f, now: () => 1 })
  const e = s.create({ window: 'fiveHour', kind: 'plan', target: 'plans/p.md',
    payload: { mainRoot: '/repo', planName: 'p.md' } })
  const after = s.markFired(e.id, { ok: true, payload: { spawn: { shortId: 'ab12' } } })
  assert.equal(after.state, 'fired')
  assert.equal(after.payload.mainRoot, '/repo', 'the create-time payload survives')
  assert.equal(after.payload.spawn.shortId, 'ab12')
  // still refuses a non-pending entry
  assert.equal(s.markFired(e.id, { ok: true }), null)
})

await ok('annotate merges a patch into a fired entry\'s payload, on disk and back', () => {
  const f = join(dir, 'ar-annotate.json')
  const s = createAfterResetStore({ file: f, now: () => 1 })
  const e = s.create({ window: 'fiveHour', kind: 'plan', target: 'plans/p.md',
    payload: { mainRoot: '/repo', planName: 'p.md' } })
  s.markFired(e.id, { ok: true, payload: { spawn: { shortId: 'ab12' } } })
  const annotated = s.annotate(e.id, { stoppedAt: 999, stopReason: 'idle' })
  assert.equal(annotated.payload.stoppedAt, 999)
  assert.equal(annotated.payload.stopReason, 'idle')
  assert.equal(annotated.payload.mainRoot, '/repo', 'the create-time payload survives')
  s.flush()
  const reloaded = createAfterResetStore({ file: f, now: () => 1 })
  const back = reloaded.get(e.id)
  assert.equal(back.payload.stoppedAt, 999)
  assert.equal(back.payload.spawn.shortId, 'ab12', 'the fire-time payload also survives')
  // the two refusals: an unknown id, and a patch that is not a plain object
  assert.equal(s.annotate('no-such-id', { stoppedAt: 1 }), null)
  assert.equal(s.annotate(e.id, 'not an object'), null)
})

await ok('settings() always returns a complete night block, defaults filled', () => {
  const s = createAfterResetStore({ file: join(dir, 'ar-set.json'), now: () => 1 })
  assert.deepEqual(s.settings().night, { ...DEFAULT_NIGHT })
})

await ok('setNight validates each field and names the one it rejected', () => {
  const s = createAfterResetStore({ file: join(dir, 'ar-val.json'), now: () => 1 })
  for (const [patch, field] of [
    [{ start: '24:00' }, 'start'], [{ start: 'x' }, 'start'], [{ end: '07:60' }, 'end'],
    [{ budgetUsd: 0 }, 'budgetUsd'], [{ budgetUsd: 'lots' }, 'budgetUsd'], [{ budgetUsd: 10_000 }, 'budgetUsd'],
    [{ maxHours: -1 }, 'maxHours'], [{ maxHours: 99 }, 'maxHours'],
  ]) {
    const r = s.setNight(patch)
    assert.equal(r.ok, false, JSON.stringify(patch))
    assert.equal(r.field, field, JSON.stringify(patch))
  }
  assert.deepEqual(s.settings().night, { ...DEFAULT_NIGHT }, 'a rejected patch persists nothing')
})

await ok('setNight round-trips through disk and preserves an unknown settings key', () => {
  const f = join(dir, 'ar-rt.json')
  const s = createAfterResetStore({ file: f, now: () => 1 })
  s.setNight({ enabled: true, start: '22:30', budgetUsd: 40 })
  s.flush()
  // a key some later branch added, that this build knows nothing about
  const raw = JSON.parse(readFileSync(f, 'utf8'))
  raw.settings.somethingElse = { keep: 'me' }
  writeFileSync(f, JSON.stringify(raw))
  const s2 = createAfterResetStore({ file: f, now: () => 1 })
  assert.equal(s2.settings().night.enabled, true)
  assert.equal(s2.settings().night.start, '22:30')
  assert.equal(s2.settings().night.budgetUsd, 40)
  assert.equal(s2.settings().night.end, DEFAULT_NIGHT.end, 'an unset field falls back to the default')
  s2.setNight({ enabled: false })
  s2.flush()
  const back = JSON.parse(readFileSync(f, 'utf8'))
  assert.deepEqual(back.settings.somethingElse, { keep: 'me' }, 'an unknown key survives our write')
})

// ======================================================================
// night.mjs -- the runner, against an injected `run`
// ======================================================================
// EVERY assertion in this section proves only that OUR FAKE accepted OUR
// argv. A harness that mocks the subprocess cannot verify a real command
// line -- that still has to be checked by hand against a real `git` and a
// real `claude`, separately from whatever runs green here.
const { createNightRunner, nightSlug, nightBranch, nightPrompt } =
  await import(join(ROOT, 'syzygy', 'bridge', 'night.mjs'))
const { SLUG_RE } = await import(join(ROOT, 'syzygy', 'bridge', 'requests.mjs'))

// Built from a local Date's own fields at run time, never typed as a literal
// -- the fixed clock below sits at 02:00 local on one fixed day, and the
// expected slug/branch have to carry whatever calendar day that actually is
// wherever this runs, not a string baked in when this file was written.
const NIGHT_NOW = new Date(2026, 8, 12, 2, 0)
const pad2 = (n) => String(n).padStart(2, '0')
const nightDate = `${NIGHT_NOW.getFullYear()}-${pad2(NIGHT_NOW.getMonth() + 1)}-${pad2(NIGHT_NOW.getDate())}`
const planTarget = 'plans/p.md'
const expectedSlug = nightSlug(planTarget, nightDate)
const expectedBranch = nightBranch(planTarget, nightDate)
const nightMainRoot = mkdtempSync(join(tmpdir(), 'szg-night-main-'))

const mkRunner = (opts = {}) => {
  const calls = []
  const run = async (bin, argv, o = {}) => {
    calls.push({ bin, argv, opts: o })
    if (bin === 'git') return { code: opts.gitCode ?? 0, stdout: '', stderr: opts.gitErr ?? '' }
    return { code: opts.spawnCode ?? 0, stdout: opts.spawnOut ?? 'backgrounded · ab12 · night-p', stderr: '' }
  }
  const canvas = { nodes: {}, spawnedBy: [], recents: [] }
  return { calls, canvas, runner: createNightRunner({
    run, canvas, claudeBin: '/bin/claude', now: () => NIGHT_NOW.getTime(),
    relayInfo: () => ({ relayPort: 4399, relayToken: 'tok' }),
  }) }
}
const planEntry = () => ({
  id: 'e1', kind: 'plan', state: 'pending', target: planTarget,
  payload: { mainRoot: nightMainRoot, planTitle: 'P' },
})

await ok('nightSlug and nightBranch are SLUG_RE-safe and dated', () => {
  assert.equal(expectedSlug, `night-p-${nightDate}`)
  assert.equal(expectedBranch, `night/p-${nightDate}`)
  assert.equal(nightSlug('plans/Not A Slug!.md', nightDate), `night-not-a-slug-${nightDate}`,
    'normalises rather than refusing')
  const longBase = 'a'.repeat(53)
  assert.ok(SLUG_RE.test(nightSlug(`plans/${longBase}.md`, nightDate)), 'a long basename still yields a safe slug')
  assert.throws(() => nightSlug('plans/!!!.md', nightDate), /slug/i, 'nothing usable is left, so this one refuses')
})

await ok('fire() creates the worktree, locks it, and spawns with the right argv', async () => {
  const { calls, runner } = mkRunner()
  const out = await runner.fire(planEntry(), { budgetUsd: 25, maxBudgetFlag: true })
  assert.equal(out.ok, true)
  assert.equal(out.spawn.shortId, 'ab12')

  const add = calls.find((c) => c.bin === 'git' && c.argv[0] === 'worktree' && c.argv[1] === 'add')
  assert.ok(add, 'git worktree add ran')
  assert.equal(add.opts.cwd, nightMainRoot, 'in the MAIN root, never a linked worktree')
  assert.equal(add.argv[3], '-b')
  assert.equal(add.argv[4], expectedBranch)
  assert.ok(add.argv[2].endsWith('/.claude/worktrees/' + expectedSlug))
  assert.ok(calls.some((c) => c.bin === 'git' && c.argv[1] === 'lock'), 'the worktree is locked')

  const spawn = calls.find((c) => c.bin === '/bin/claude')
  assert.equal(spawn.argv[0], '--bg')
  assert.ok(spawn.argv.includes('--permission-mode') && spawn.argv[spawn.argv.indexOf('--permission-mode') + 1] === 'auto')
  const b = spawn.argv.indexOf('--max-budget-usd')
  assert.ok(b > 0 && spawn.argv[b + 1] === '25')
  assert.ok(b < spawn.argv.indexOf('--'), 'before the sentinel')
  assert.equal(spawn.argv.includes('--allowedTools'), false)
  assert.equal(spawn.argv[spawn.argv.length - 2], '--')
  assert.match(spawn.argv[spawn.argv.length - 1], /plans\/p\.md/, 'the prompt is last and names the plan')
  assert.ok(spawn.opts.cwd.endsWith('/' + expectedSlug), "the spawn cwd ends with the slug -- macOS prefixes /private")

  const si = spawn.argv.indexOf('--settings')
  assert.ok(si > 0)
  assert.deepEqual(JSON.parse(spawn.argv[si + 1]), { env: { SZG_RELAY_PORT: '4399', SZG_RELAY_TOKEN: 'tok' } })
  assert.ok(Object.keys(spawn.opts.env).every((k) => !k.startsWith('SZG_')), 'childEnv strips every SZG_ key')
})

await ok('fire() omits --max-budget-usd when the flag is not proven', async () => {
  const { calls, runner } = mkRunner()
  await runner.fire(planEntry(), { budgetUsd: 25, maxBudgetFlag: false })
  assert.equal(calls.find((c) => c.bin === '/bin/claude').argv.includes('--max-budget-usd'), false)
})

await ok('a failing git worktree add fails the entry and never reaches claude', async () => {
  const { calls, runner } = mkRunner({ gitCode: 1, gitErr: 'fatal: already exists' })
  const out = await runner.fire(planEntry(), { budgetUsd: 25, maxBudgetFlag: true })
  assert.equal(out.ok, false)
  assert.match(out.error, /already exists/)
  assert.equal(calls.some((c) => c.bin === '/bin/claude'), false)
})

await ok('a failing spawn leaves the worktree in place -- it is the evidence', async () => {
  const { calls, runner } = mkRunner({ spawnCode: 1, spawnOut: '' })
  const out = await runner.fire(planEntry(), { budgetUsd: 25, maxBudgetFlag: true })
  assert.equal(out.ok, false)
  assert.equal(calls.some((c) => c.bin === 'git' && c.argv.includes('remove')), false)
  assert.equal(calls.some((c) => c.argv?.includes?.('merge') || c.argv?.includes?.('push')), false)
})

await ok('nightPrompt carries the contract that makes an unreviewed run safe', () => {
  const p = nightPrompt({ planRel: planTarget, planTitle: 'P', branch: expectedBranch, budgetUsd: 25 })
  assert.match(p, /plans\/p\.md/)
  assert.match(p, /superpowers:executing-plans/)
  assert.match(p, /plan-reported/)
  assert.match(p, /never.*\[x\]/i)
  assert.match(p, /commit/i)
  assert.match(p, /never merge|do not merge/i)
  assert.match(p, /\.claude\/night\/report\.md/)
  assert.match(p, /just deps/)
  assert.doesNotMatch(p, /authored-by/i)
})

await ok('watch() stops on spend, stops on elapsed, never stops blind, and stops exactly once', async () => {
  const { calls, runner } = mkRunner()
  const spawnedAt = NIGHT_NOW.getTime() - 60_000
  const entry = { id: 'e1', kind: 'plan', state: 'fired',
    payload: { spawn: { shortId: 'ab12', name: 'night-p', spawnedAt } } }
  const settings = { night: { budgetUsd: 25, maxHours: 6 } }

  const under = await runner.watch({ entries: [entry], settings, now: () => NIGHT_NOW.getTime(),
    sessions: [{ id: 's1', shortId: 'ab12', stats: { spend: 3 } }] })
  assert.deepEqual(under, [], 'nothing stopped under budget and inside maxHours')

  const orphan = { id: 'e3', kind: 'plan', state: 'fired',
    payload: { spawn: { shortId: 'zz99', name: 'night-z', spawnedAt: NIGHT_NOW.getTime() - 30 * 3600_000 } } }
  const blind = await runner.watch({ entries: [orphan], settings, now: () => NIGHT_NOW.getTime(), sessions: [] })
  assert.deepEqual(blind, [], 'no session found for the spawn -- never stop blind, no matter the elapsed time')

  const over = await runner.watch({ entries: [entry], settings, now: () => NIGHT_NOW.getTime(),
    sessions: [{ id: 's1', shortId: 'ab12', stats: { spend: 40 } }] })
  assert.equal(over.length, 1)
  assert.match(over[0].reason, /budget/)
  assert.equal(over[0].ok, true)
  assert.ok(calls.some((c) => c.argv?.includes?.('stop')), 'stopped through claude stop, never a pattern kill')

  const again = await runner.watch({ entries: [entry], settings, now: () => NIGHT_NOW.getTime(),
    sessions: [{ id: 's1', shortId: 'ab12', stats: { spend: 40 } }] })
  assert.deepEqual(again, [], 'a stopped entry is not stopped a second time')

  const old = { id: 'e2', kind: 'plan', state: 'fired',
    payload: { spawn: { shortId: 'cd34', name: 'night-q', spawnedAt: NIGHT_NOW.getTime() - 7 * 3600_000 } } }
  const timed = await runner.watch({ entries: [old], settings, now: () => NIGHT_NOW.getTime(),
    sessions: [{ id: 's2', shortId: 'cd34' }] })
  assert.equal(timed.length, 1)
  assert.match(timed[0].reason, /time|hours/i)
  assert.equal(timed[0].ok, true)
})

// ---- claudeBin: null -- the no-binary hotfix -------------------------------
// A relay with no usable `claude` at all constructs this module with
// `claudeBin: null`, never the bare string 'claude'. `run` below is a spy
// that would happily record a call if one reached it, so an empty `calls`
// array is the proof nothing was ever spawned -- not `claude`, and not even
// `git`.
const mkRunnerNoBin = () => {
  const calls = []
  const run = async (bin, argv, o = {}) => {
    calls.push({ bin, argv, opts: o })
    return { code: 0, stdout: 'backgrounded · ab12 · night-p', stderr: '' }
  }
  const canvas = { nodes: {}, spawnedBy: [], recents: [] }
  return { calls, canvas, runner: createNightRunner({
    run, canvas, claudeBin: null, now: () => NIGHT_NOW.getTime(),
    relayInfo: () => ({ relayPort: 4399, relayToken: 'tok' }),
  }) }
}

await ok('claudeBin: null refuses fire() before it creates a worktree or spawns anything', async () => {
  const { calls, runner } = mkRunnerNoBin()
  const origWrite = process.stderr.write
  const writes = []
  process.stderr.write = (s) => { writes.push(String(s)); return true }
  let out
  try { out = await runner.fire(planEntry(), { budgetUsd: 25, maxBudgetFlag: true }) } finally { process.stderr.write = origWrite }
  assert.equal(out.ok, false)
  assert.match(out.error, /no claude binary with --bg was found/)
  assert.equal(calls.length, 0, 'no git worktree add and no claude spawn without a usable binary')
  assert.ok(writes.some((w) => /no claude binary with --bg was found/.test(w)), 'the refusal reaches stderr')
})

await ok('claudeBin: null leaves watch() refusing through killSession\'s own 503, never a spawn', async () => {
  const { calls, runner } = mkRunnerNoBin()
  const entry = { id: 'e1', kind: 'plan', state: 'fired',
    payload: { spawn: { shortId: 'ab12', name: 'night-p', spawnedAt: NIGHT_NOW.getTime() - 60_000 } } }
  const settings = { night: { budgetUsd: 1, maxHours: 6 } }
  const out = await runner.watch({ entries: [entry], settings, now: () => NIGHT_NOW.getTime(),
    sessions: [{ id: 's1', shortId: 'ab12', stats: { spend: 5 } }] })
  assert.equal(out.length, 1)
  assert.equal(out[0].ok, false, 'a stop can never succeed with no usable binary')
  assert.match(out[0].error, /no usable claude binary was found/)
  assert.equal(calls.length, 0, 'killSession refuses before ever calling run')
})

// ======================================================================
// limitEpisode / disruptedSessions
// ======================================================================

const T0 = 1_789_000_000_000
const RESETS = T0 + 3 * 3600_000
const reading = (pct, resetsAt, stale = false) => ({
  fiveHour: { pct, resetsAt, resetsInMs: resetsAt - T0, expired: false },
  sevenDay: null, observedAt: T0, stale,
})

await ok('limitEpisode opens once the window is spent, and not before', () => {
  assert.equal(limitEpisode(null, reading(90, RESETS), 'fiveHour', T0), null)
  const e = limitEpisode(null, reading(98, RESETS), 'fiveHour', T0)
  assert.deepEqual(e, { window: 'fiveHour', resetsAt: RESETS, spentAt: T0, pct: 98 })
})

await ok('limitEpisode opens from the last reading even once it is stale, while its boundary is ahead', () => {
  const e = limitEpisode(null, reading(99, RESETS, true), 'fiveHour', T0 + 60_000)
  assert.deepEqual(e, { window: 'fiveHour', resetsAt: RESETS, spentAt: T0, pct: 99 }, 'spentAt is when the reading was taken')
  assert.equal(limitEpisode(null, reading(99, RESETS, true), 'fiveHour', RESETS + RESET_GRACE_MS), null, 'a boundary already past opens nothing')
})

await ok('limitEpisode keeps the FIRST spentAt for one boundary', () => {
  const first = limitEpisode(null, reading(98, RESETS), 'fiveHour', T0)
  const later = limitEpisode(first, reading(100, RESETS), 'fiveHour', T0 + 60_000)
  assert.equal(later.spentAt, T0, 'spentAt is when the limit was first seen spent')
  assert.equal(later.pct, 100, 'pct tracks the latest reading')
})

await ok('limitEpisode closes on a moved boundary, or by the clock after the grace', () => {
  const open = limitEpisode(null, reading(99, RESETS), 'fiveHour', T0)
  assert.ok(limitEpisode(open, reading(99, RESETS), 'fiveHour', RESETS + 1), 'the clock alone closes it only after the grace')
  assert.equal(limitEpisode(open, reading(2, RESETS + 3600_000), 'fiveHour', RESETS + 1), null)
  assert.equal(limitEpisode(open, reading(99, RESETS, true), 'fiveHour', RESETS + RESET_GRACE_MS), null, 'a stale reading and the clock')
  const dark = { fiveHour: null, sevenDay: null, observedAt: null, stale: true }
  assert.deepEqual(limitEpisode(open, dark, 'fiveHour', RESETS + RESET_GRACE_MS - 1), open, 'dark before the grace: still open')
  assert.equal(limitEpisode(open, dark, 'fiveHour', RESETS + RESET_GRACE_MS), null, 'dark after the grace: the reset happened')
})

// disruptedSessions -------------------------------------------------------
const EP = { window: 'fiveHour', resetsAt: RESETS, spentAt: T0, pct: 99 }
const FROZE = T0 + 60_000                    // inside the episode
const sess = (over = {}) => ({ id: 's1', name: 'alpha', shortId: 'aa11',
  progressAt: FROZE, waiting: false, ...over })
const agent = (over = {}) => ({ sessionId: 's1', kind: 'interactive', status: 'idle', ...over })
const call = (over = {}) => disruptedSessions({
  sessions: [sess()], agents: [agent()], agentsAt: RESETS, episode: EP,
  excluded: [], fired: [], now: RESETS + 1000, ...over,
})

await ok('a session frozen inside the episode and still alive is disrupted', () => {
  const { held, rows } = call()
  assert.equal(held, null)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].eligible, true)
  assert.match(rows[0].reason, /stopped moving/)
})

await ok('no episode, no listing and no session each hold with their own reason', () => {
  assert.match(call({ episode: null }).held, /no limit episode/)
  assert.match(call({ agentsAt: 0 }).held, /listing/)
  assert.deepEqual(call({ sessions: [] }).rows, [])
})

await ok('an agents listing older than AGENTS_MAX_AGE_MS fires nothing', () => {
  const r = call({ agentsAt: RESETS - AGENTS_MAX_AGE_MS - 1 })
  assert.match(r.held, /listing/)
  assert.deepEqual(r.rows, [])
})

await ok('every exclusion clause, one at a time', () => {
  // absent from a successful listing -- a fact, not an unknown
  assert.deepEqual(call({ agents: [] }).rows, [])
  // settled in the listing
  for (const state of ['done', 'failed', 'stopped']) {
    assert.deepEqual(call({ agents: [agent({ kind: 'background', state })] }).rows, [], state)
  }
  // parked on a human, both vocabularies
  assert.equal(call({ agents: [agent({ status: 'waiting' })] }).rows.length, 0)
  assert.equal(call({ agents: [agent({ kind: 'background', state: 'blocked' })] }).rows.length, 0)
  // idle by choice, before the grace
  assert.deepEqual(call({ sessions: [sess({ progressAt: T0 - DISRUPT_GRACE_MS - 1 })] }).rows, [])
  // touched after the reset
  assert.deepEqual(call({ sessions: [sess({ progressAt: RESETS + 500 })] }).rows, [])
})

await ok('a running background session is disrupted like an interactive one', () => {
  const r = call({ agents: [agent({ kind: 'background', state: 'running' })] })
  assert.equal(r.rows[0].eligible, true)
})

await ok('the grace boundary is exact on both sides', () => {
  const inside = T0 - DISRUPT_GRACE_MS
  assert.equal(call({ sessions: [sess({ progressAt: inside })] }).rows.length, 1)
  assert.equal(call({ sessions: [sess({ progressAt: inside - 1 })] }).rows.length, 0)
})

await ok('an excluded session is REPORTED but not eligible', () => {
  const r = call({ excluded: [{ id: 's1', name: 'alpha', until: RESETS }] })
  assert.equal(r.rows.length, 1, 'the panel still shows it')
  assert.equal(r.rows[0].excluded, true)
  assert.equal(r.rows[0].eligible, false)
})

await ok('a session already fired for this episode is not eligible again', () => {
  const fired = [{ kind: 'resume', target: 's1', armedResetsAt: RESETS }]
  assert.equal(call({ fired }).rows[0].eligible, false)
  const other = [{ kind: 'resume', target: 's1', armedResetsAt: RESETS - 1 }]
  assert.equal(call({ fired: other }).rows[0].eligible, true, 'a previous episode does not count')
})

await ok('a session still moving moments before the reset is not frozen', () => {
  const recent = sess({ progressAt: RESETS - 60_000 })
  assert.deepEqual(call({ sessions: [recent] }).rows, [])
  assert.equal(call({ sessions: [recent], minFrozenMs: 0 }).rows.length, 1)
  const edge = sess({ progressAt: RESETS + 1000 - DISRUPT_MIN_FROZEN_MS })
  assert.equal(call({ sessions: [edge] }).rows.length, 1, 'exactly the minimum counts')
})

await ok('a resume by hand does not use up the reset\'s own resume', () => {
  const fired = [{ kind: 'resume', target: 's1', armedResetsAt: RESETS, payload: { byHand: true } }]
  assert.equal(call({ fired }).rows[0].eligible, true)
})

await ok('LIMIT_AGENT_STATES is empty today, and admits on its own once filled', () => {
  assert.deepEqual([...LIMIT_AGENT_STATES], [])
  const fresh = sess({ progressAt: RESETS + 500 })   // would fail clause 4
  const r = disruptedSessions({
    sessions: [fresh], agents: [agent({ kind: 'background', state: 'rate_limited' })],
    agentsAt: RESETS, episode: EP, excluded: [], fired: [], now: RESETS + 1000,
    limitStates: new Set(['rate_limited']),
  })
  assert.equal(r.rows[0].eligible, true)
  assert.match(r.rows[0].reason, /reported/)
})

await ok('AGENT_SETTLED matches the canvas ledger\'s own terminal set', async () => {
  const { OBSERVED_TERMINAL } = await import(join(ROOT, 'syzygy', 'bridge', 'canvas.mjs'))
  assert.deepEqual([...AGENT_SETTLED].sort(), [...OBSERVED_TERMINAL].sort())
})

await ok('RESUME_PROMPT names no project, document or skill', () => {
  // Shapes rather than names: no path, no markdown file, no section sign, no
  // recipe runner, no product or skill name. It reaches any session on the
  // machine, so it may assume nothing about the one it lands in.
  assert.doesNotMatch(RESUME_PROMPT, /\/|\.md\b|\u00a7|\bjust\b|superpowers|Syzygy|plan-reported/)
  assert.ok(RESUME_PROMPT.includes('usage limit'))
})

await ok('the store accepts the two new kinds and still refuses an unknown one', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'szg-ar-')), 'after-reset.json')
  const s = createAfterResetStore({ file, now: () => T0 })
  assert.equal(s.create({ window: 'fiveHour', kind: 'resume', target: 's1' }).kind, 'resume')
  assert.equal(s.create({ window: 'fiveHour', kind: 'spawn', payload: { cwd: '/tmp', prompt: 'go' } }).kind, 'spawn')
  assert.throws(() => s.create({ window: 'fiveHour', kind: 'nope' }), /kind must be one of/)
})

await ok('settings().resume is complete on a first run and defaults to disarmed', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'szg-ar-')), 'after-reset.json')
  const s = createAfterResetStore({ file, now: () => T0 })
  assert.deepEqual(s.settings().resume,
    { armed: false, since: null, by: null, windows: ['fiveHour'], excluded: [], episode: null })
})

await ok('setResume validates, and a rejected field names itself and persists nothing', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'szg-ar-')), 'after-reset.json')
  const s = createAfterResetStore({ file, now: () => T0 })
  assert.deepEqual(s.setResume({ nope: 1 }), { ok: false, field: 'nope', error: 'unknown resume setting "nope"' })
  assert.equal(s.setResume({ windows: ['weekly'] }).ok, false)
  const armed = s.setResume({ armed: true, by: 'toggle' })
  assert.equal(armed.ok, true)
  assert.equal(armed.resume.armed, true)
  assert.equal(armed.resume.since, T0, 'arming stamps `since`')
  assert.equal(armed.resume.by, 'toggle')
  assert.equal(s.settings().resume.armed, true)
})

await ok('disarming clears since and by, and arming twice does not move since', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'szg-ar-')), 'after-reset.json')
  let t = T0
  const s = createAfterResetStore({ file, now: () => t })
  s.setResume({ armed: true, by: 'toggle' })
  t = T0 + 5000
  assert.equal(s.setResume({ armed: true, by: 'orchestrator' }).resume.since, T0)
  assert.deepEqual(
    { since: s.setResume({ armed: false }).resume.since, by: s.settings().resume.by },
    { since: null, by: null },
  )
})

await ok('exclusions round-trip, and an expired one is dropped on read', () => {
  const dirp = mkdtempSync(join(tmpdir(), 'szg-ar-'))
  const file = join(dirp, 'after-reset.json')
  let t = T0
  const s = createAfterResetStore({ file, now: () => t })
  s.setResume({ exclude: { id: 's1', name: 'alpha', until: T0 + 1000 } })
  s.setResume({ exclude: { id: 's2', name: 'beta', until: T0 + 9_000_000 } })
  assert.equal(s.settings().resume.excluded.length, 2)
  s.flush()
  t = T0 + 5000
  const reloaded = createAfterResetStore({ file, now: () => t })
  assert.deepEqual(reloaded.settings().resume.excluded.map((e) => e.id), ['s2'],
    'an exclusion outliving its episode would silently suppress a later reset')
})

await ok('include removes an exclusion by id', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'szg-ar-')), 'after-reset.json')
  const s = createAfterResetStore({ file, now: () => T0 })
  s.setResume({ exclude: { id: 's1', name: 'alpha', until: T0 + 9_000_000 } })
  assert.deepEqual(s.setResume({ include: 's1' }).resume.excluded, [])
})

await ok('setEpisode stores and clears, and an unknown settings key still survives', () => {
  const dirp = mkdtempSync(join(tmpdir(), 'szg-ar-'))
  const file = join(dirp, 'after-reset.json')
  writeFileSync(file, JSON.stringify({ version: 1, items: [], settings: { future: { a: 1 } } }))
  const s = createAfterResetStore({ file, now: () => T0 })
  s.setEpisode({ window: 'fiveHour', resetsAt: RESETS, spentAt: T0, pct: 99 })
  s.flush()
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(raw.settings.future, { a: 1 })
  assert.equal(raw.settings.resume.episode.resetsAt, RESETS)
  s.setEpisode(null)
  assert.equal(s.settings().resume.episode, null)
})

// ======================================================================
// relay.mjs — the live routes (a real subprocess, an isolated port/data dir)
// ======================================================================
// every after-reset WRITE is a
// POST inside relay.mjs's single authed()+try/catch POST block, specifically
// because that is a structural guard a route outside it does not inherit.
// The one thing a harness that never starts a real relay cannot prove is
// that the guard is actually wired up on this route -- a bad token must
// still 401 here, not slip through because the path is new. A harness that
// mocks its dependencies cannot verify the wiring, so this section runs the
// real relay.mjs rather than re-implementing its routing.
{
  const { spawn } = await import('node:child_process')
  const relayDataDir = mkdtempSync(join(tmpdir(), 'szg-usage-relay-'))
  const relayPath = join(ROOT, 'syzygy', 'bridge', 'relay.mjs')
  const RELAY_TOKEN = 'usage-harness-token'
  const child = spawn(process.execPath, [relayPath], {
    env: { ...process.env, SZG_PORT: '0', SZG_TOKEN: RELAY_TOKEN, SZG_DATA_DIR: relayDataDir,
      // Never the machine's real `claude`: the capability probe rejects this
      // one, so no `claude agents` listing is ever run from here.
      SZG_CLAUDE_BIN: '/usr/bin/false',
      // This harness authenticates with the token, never a cookie.
      SZG_PANE_PASSWORD_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderrText = ''
  child.stderr.on('data', (c) => { stderrText += c })
  const port = await new Promise((resolvePort, reject) => {
    let out = ''
    const onData = (chunk) => {
      out += chunk
      const m = out.match(/relay on http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { child.stdout.off('data', onData); resolvePort(Number(m[1])) }
    }
    child.stdout.on('data', onData)
    child.on('error', reject)
    child.on('exit', (code) => reject(new Error(`relay exited early with code ${code}; stderr: ${stderrText}`)))
    setTimeout(() => reject(new Error('relay did not report a port in time')), 8000)
  })
  const base = `http://127.0.0.1:${port}`
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, ...(await r.json().catch(() => ({}))) }
  }

  // A failing assertion below must still tear the relay child and its temp
  // dir down -- otherwise one red check leaves a process and a directory
  // behind for every case that follows it, in this run and the next.
  try {
    await ok('POST /api/after-reset rejects a bad token with 401', async () => {
      const r = await post('/api/after-reset', { token: 'WRONG', window: 'fiveHour', kind: 'prompt', target: 'x' })
      assert.equal(r.status, 401)
    })

    await ok('POST /api/after-reset/delete rejects a bad token with 401 -- the follow-on this design change asked for', async () => {
      const r = await post('/api/after-reset/delete', { token: 'WRONG', id: 'whatever' })
      assert.equal(r.status, 401)
    })

    await ok('POST /api/after-reset with the right token creates a pending entry; GET /api/after-reset is unauthenticated', async () => {
      const created = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fiveHour', kind: 'prompt', target: 's1', payload: { text: 'go' } })
      assert.equal(created.status, 200)
      assert.equal(created.entry.state, 'pending')
      const listed = await (await fetch(base + '/api/after-reset')).json() // no token at all
      assert.equal(listed.queue.length, 1)
      assert.equal(listed.queue[0].id, created.entry.id)
    })

    // This API and the platform's own `rate_limits` both spell these
    // snake_case, so that is what the orchestrator agent sends; the store keeps
    // parseUsage's camelCase so an entry and a reading compare with no
    // translation. A route that rejected the documented spelling would answer a
    // 400. Asserted on the STORED entry, not just the status,
    // because accepting the request and filing it under a null window would pass
    // a status check and still never fire.
    await ok('POST /api/after-reset accepts the documented five_hour/seven_day spelling and normalises it', async () => {
      const a = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'five_hour', kind: 'prompt', target: 's1', payload: { text: 'go' } })
      assert.equal(a.status, 200)
      assert.equal(a.entry.window, 'fiveHour')
      const b = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'seven_day', kind: 'prompt', target: 's1', payload: { text: 'go' } })
      assert.equal(b.status, 200)
      assert.equal(b.entry.window, 'sevenDay')
      // and the camelCase spelling still works, unchanged
      const c = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fiveHour', kind: 'prompt', target: 's1', payload: { text: 'go' } })
      assert.equal(c.entry.window, 'fiveHour')
      // anything else is still a 400 that names both spellings
      const d = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fortnight', kind: 'prompt', target: 's1' })
      assert.equal(d.status, 400)
      assert.match(d.error, /five_hour/)
    })

    await ok("POST /api/after-reset refuses kind 'resume' with 400, naming the kind", async () => {
      const r = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fiveHour', kind: 'resume', target: 's1' })
      assert.equal(r.status, 400)
      assert.match(r.error, /resume/)
    })

    await ok('POST /api/after-reset/delete with the right token cancels a pending entry', async () => {
      const created = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'sevenDay', kind: 'implement', payload: { ids: ['r1'] } })
      const del = await post('/api/after-reset/delete', { token: RELAY_TOKEN, id: created.entry.id })
      assert.equal(del.status, 200)
      const listed = await (await fetch(base + '/api/after-reset')).json()
      assert.equal(listed.queue.find((e) => e.id === created.entry.id).state, 'cancelled')
    })

    // The pane shows one REMOVE button per row, cancel() is a deliberate no-op
    // on a settled entry, and nothing else prunes the queue -- so REMOVE on a
    // fired or failed row must actually take it off the list rather than answer
    // 200 and leave it there. Asserted on what is LISTED afterwards, not on the
    // status code, which is 200 either way.
    await ok('POST /api/after-reset/delete clears a SETTLED entry off the list, not just a pending one', async () => {
      const created = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'five_hour', kind: 'prompt', target: 'nobody', payload: { text: 'x' } })
      const id = created.entry.id
      // drive it to a settled state the same way the scheduler would
      const before = await (await fetch(base + '/api/after-reset')).json()
      assert.equal(before.queue.find((e) => e.id === id).state, 'pending')
      await post('/api/after-reset/delete', { token: RELAY_TOKEN, id })   // pending: called off, stays
      const mid = await (await fetch(base + '/api/after-reset')).json()
      assert.equal(mid.queue.find((e) => e.id === id).state, 'cancelled', 'a pending entry should be cancelled, not deleted')
      const second = await post('/api/after-reset/delete', { token: RELAY_TOKEN, id }) // settled: cleared away
      assert.equal(second.status, 200)
      const after = await (await fetch(base + '/api/after-reset')).json()
      assert.equal(after.queue.find((e) => e.id === id), undefined, 'a settled entry should leave the list')
      // and an id that never existed is still a 404, not a silent 200
      const ghost = await post('/api/after-reset/delete', { token: RELAY_TOKEN, id: 'no-such-entry' })
      assert.equal(ghost.status, 404)
    })

    await ok('GET /api/usage is unauthenticated and shaped {usage, history, queue}', async () => {
      const u = await (await fetch(base + '/api/usage')).json()
      assert.ok('usage' in u && 'history' in u && 'queue' in u)
    })

    await ok("POST /api/after-reset accepts kind 'plan' and stores what the relay chose, not what the client sent", async () => {
      const r = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'five_hour', kind: 'plan',
        target: 'plans/p.md',
        payload: { mainRoot: '/repo', planName: 'p.md', auto: true, spawn: { shortId: 'evil' }, skipped: ['x'] } })
      assert.equal(r.status, 200)
      assert.equal(r.entry.kind, 'plan')
      // auto/spawn/skipped are written by the relay alone, never by a client.
      assert.equal(r.entry.payload.auto, undefined)
      assert.equal(r.entry.payload.spawn, undefined)
      assert.equal(r.entry.payload.skipped, undefined)
      assert.equal(r.entry.payload.mainRoot, '/repo')
    })

    await ok("POST /api/after-reset kind 'plan' names the missing field with a 400", async () => {
      const noTarget = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fiveHour', kind: 'plan', payload: { mainRoot: '/repo' } })
      assert.equal(noTarget.status, 400)
      assert.equal(noTarget.field, 'target')
      const noRoot = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fiveHour', kind: 'plan', target: 'plans/p.md', payload: {} })
      assert.equal(noRoot.status, 400)
      assert.equal(noRoot.field, 'payload.mainRoot')
    })

    await ok('POST /api/after-reset {now:true} fires immediately: the listed entry is settled, not pending', async () => {
      const r = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fiveHour', kind: 'prompt',
        target: 'nobody-registered', payload: { text: 'go' }, now: true })
      assert.equal(r.status, 200)
      const listed = await (await fetch(base + '/api/after-reset')).json()
      const e = listed.queue.find((x) => x.id === r.entry.id)
      assert.notEqual(e.state, 'pending', 'fire-now must settle it on the spot')
      assert.equal(e.state, 'failed', 'and the target is not registered, so it failed honestly')
      assert.match(e.error, /not registered/)
    })

    await ok('an implement entry that green-lights NOTHING is recorded failed, not fired', async () => {
      // relay.mjs used to throw implementIds()'s return value away and record
      // `fired` regardless -- so an entry armed in the evening reported a
      // confident green in the morning having done nothing. At 03:00 the
      // planning session is long gone, so this is the NORMAL case.
      const r = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fiveHour', kind: 'implement',
        payload: { ids: ['no-such-request'] }, now: true })
      const listed = await (await fetch(base + '/api/after-reset')).json()
      const e = listed.queue.find((x) => x.id === r.entry.id)
      assert.equal(e.state, 'failed')
      assert.match(e.error, /no-such-request/)
    })

    await ok('POST /api/night validates, persists, and shows up on GET /api/usage', async () => {
      const bad = await post('/api/night', { token: RELAY_TOKEN, start: '25:00' })
      assert.equal(bad.status, 400)
      assert.equal(bad.field, 'start')
      const good = await post('/api/night', { token: RELAY_TOKEN, enabled: true, start: '22:30', budgetUsd: 40 })
      assert.equal(good.status, 200)
      const u = await (await fetch(base + '/api/usage')).json()
      assert.equal(u.night.enabled, true)
      assert.equal(u.night.start, '22:30')
      assert.equal(u.night.budgetUsd, 40)
      assert.equal(u.night.end, '07:00', 'an unset field keeps its default')
      assert.ok(Array.isArray(u.night.eligible))
      assert.equal(typeof u.night.held, 'string', 'a refusal always carries a reason')
    })

    await ok('POST /api/night rejects a bad token with 401', async () => {
      const r = await post('/api/night', { token: 'WRONG', enabled: true })
      assert.equal(r.status, 401)
    })

    await ok('the snapshot carries a resume block, disarmed, with its reason', async () => {
      const st = await (await fetch(base + '/api/state')).json()
      assert.ok(st.afterReset.resume, 'afterReset.resume must be present')
      assert.equal(st.afterReset.resume.armed, false)
      assert.equal(st.afterReset.resume.held, 'not armed')
      assert.deepEqual(st.afterReset.resume.disrupted, [])
    })

    await ok('the payload version is above the value this branch started from', async () => {
      const st = await (await fetch(base + '/api/state')).json()
      assert.ok(st.payloadVersion > 6, `payloadVersion ${st.payloadVersion} must be bumped past develop's 6`)
    })

    await ok('both resume routes refuse a bad token with 401', async () => {
      assert.equal((await post('/api/resume', { token: 'WRONG', armed: true })).status, 401)
      assert.equal((await post('/api/resume/fire', { token: 'WRONG', id: 'x' })).status, 401)
    })

    await ok('POST /api/resume arms, validates and persists', async () => {
      const bad = await post('/api/resume', { token: RELAY_TOKEN, windows: ['weekly'] })
      assert.equal(bad.status, 400)
      assert.equal(bad.field, 'windows')
      const good = await post('/api/resume', { token: RELAY_TOKEN, armed: true, windows: ['fiveHour', 'sevenDay'] })
      assert.equal(good.status, 200)
      assert.deepEqual(good.resume.windows, ['fiveHour', 'sevenDay'])
      const usage = await (await fetch(base + '/api/usage')).json()
      assert.equal(usage.resume.armed, true)
    })

    await ok('POST /api/after-reset still refuses kind resume, naming what to use instead', async () => {
      const r = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fiveHour', kind: 'resume', target: 's1' })
      assert.equal(r.status, 400)
      assert.match(r.error, /prompt/)
    })

    await ok('an armed relay resumes a frozen session at the reset, exactly once', async () => {
      const sid = 'resume-target-1'
      await post('/api/register', { token: RELAY_TOKEN, session: {
        id: sid, name: 'frozen', cwd: relayDataDir, root: relayDataDir, pid: process.pid, startedAt: Date.now() - 60_000 } })
      await post('/api/stats', { token: RELAY_TOKEN, id: sid, working: true, stats: { ctx: 10, tools: 1, spend: 0.5 } })
      await post('/api/resume', { token: RELAY_TOKEN, armed: true, by: 'toggle' })

      // Fire the one session by hand rather than waiting on a poll: this is
      // the same fireEntry the scheduler calls, reached by its second caller.
      const forced = await post('/api/resume/fire', { token: RELAY_TOKEN, id: sid, force: true })
      assert.equal(forced.status, 200, JSON.stringify(forced))
      assert.equal(forced.entry.kind, 'resume')
      assert.equal(forced.entry.state, 'fired')

      const q = await (await fetch(`${base}/api/commands/${sid}?token=${RELAY_TOKEN}`)).json()
      assert.equal(q.commands.length, 1)
      assert.equal(q.commands[0].verb, 'prompt')
      assert.match(q.commands[0].payload.text, /usage limit/)

      const again = await post('/api/resume/fire', { token: RELAY_TOKEN, id: sid, force: true })
      assert.equal(again.status, 400)
      assert.match(again.error, /already/)
    })

    await ok('resume-now for a session this relay does not know is refused, and records nothing', async () => {
      const r = await post('/api/resume/fire', { token: RELAY_TOKEN, id: 'never-registered', force: true })
      assert.equal(r.status, 400)
      assert.match(r.error, /not registered/)
      const listed = await (await fetch(base + '/api/after-reset')).json()
      assert.equal(listed.queue.some((e) => e.target === 'never-registered'), false)
    })

    await ok('a spawn entry validates its cwd at creation and fires through the canvas spawn path', async () => {
      const bad = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fiveHour', kind: 'spawn', payload: { cwd: 'relative/path', prompt: 'go' } })
      assert.equal(bad.status, 400)
      assert.match(bad.error, /cwd/)
      const noPrompt = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fiveHour', kind: 'spawn', payload: { cwd: relayDataDir } })
      assert.equal(noPrompt.status, 400)
      assert.match(noPrompt.error, /prompt/)
      const good = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fiveHour', kind: 'spawn', payload: { cwd: relayDataDir, prompt: 'collect the notes' } })
      assert.equal(good.status, 200)
      assert.equal(good.entry.state, 'pending')
      // The resolved path, not the typed one: a temp directory reached through
      // a symlink is stored as where it really is.
      assert.equal(good.entry.payload.cwd, realpathSync(relayDataDir))
    })

  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)) }
    rmSync(relayDataDir, { recursive: true, force: true, maxRetries: 5 })
  }
}

// ======================================================================
// limit resume, end to end: a second relay whose `claude` is a fake and whose
// polls are fast, so real ticks open an episode, close it on a moved
// boundary, and fire -- no route standing in for the scheduler.
// ======================================================================
{
  const { spawn } = await import('node:child_process')
  const dataDir = mkdtempSync(join(tmpdir(), 'szg-resume-relay-'))
  const slDir = join(dataDir, 'statusline')
  mkdirSync(slDir, { recursive: true })
  const agentsFile = join(dataDir, 'agents.json')
  writeFileSync(agentsFile, '[]')
  const fakeBin = join(dataDir, 'claude')
  writeFileSync(fakeBin, [
    '#!/bin/sh',
    // The relay picks its `claude` by capability, so the fake answers --help
    // the way a capable one does.
    'if [ "$1" = "--help" ]; then echo "  --bg   run in the background"; echo "  attach   attach to a session"; exit 0; fi',
    'if [ "$1" = "--version" ]; then echo "0.0.0-fake (usage harness)"; exit 0; fi',
    'if [ "$1" = "agents" ]; then cat "' + agentsFile + '"; exit 0; fi',
    'exit 1',
    '',
  ].join('\n'))
  chmodSync(fakeBin, 0o755)
  const TOKEN = 'resume-harness-token'
  const child = spawn(process.execPath, [join(ROOT, 'syzygy', 'bridge', 'relay.mjs')], {
    env: { ...process.env, SZG_PORT: '0', SZG_TOKEN: TOKEN, SZG_DATA_DIR: dataDir,
      SZG_STATUSLINE_DIR: slDir, SZG_CLAUDE_BIN: fakeBin,
      SZG_USAGE_POLL_MS: '150', SZG_NEEDS_POLL_MS: '150',
      // A whole limit cycle in about a second: the sessions below have been
      // still for moments, not minutes.
      SZG_DISRUPT_MIN_FROZEN_MS: '0',
      // The clock proves a reset this long after its boundary, so a dark
      // reading's reset lands within the case rather than a minute and a half on.
      SZG_RESET_GRACE_MS: '300',
      SZG_PANE_PASSWORD_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderrText = ''
  child.stderr.on('data', (c) => { stderrText += c })
  const port = await new Promise((resolvePort, reject) => {
    let out = ''
    const onData = (chunk) => {
      out += chunk
      const m = out.match(/relay on http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { child.stdout.off('data', onData); resolvePort(Number(m[1])) }
    }
    child.stdout.on('data', onData)
    child.on('error', reject)
    child.on('exit', (code) => reject(new Error(`relay exited early with code ${code}; stderr: ${stderrText}`)))
    setTimeout(() => reject(new Error('relay did not report a port in time')), 8000)
  })
  const base = `http://127.0.0.1:${port}`
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN, ...body }) })
    return { status: r.status, ...(await r.json().catch(() => ({}))) }
  }
  const state = async () => (await fetch(base + '/api/state')).json()
  // One file, overwritten: the newest-by-mtime reader then never has to break
  // a tie between two drops written in the same millisecond.
  const drop = (pct, resetsAtMs) => writeFileSync(join(slDir, 'drop.json'), JSON.stringify({
    rate_limits: { five_hour: { used_percentage: pct, resets_at: Math.floor(resetsAtMs / 1000) } },
    szg_written_at: Math.floor(Date.now() / 1000),
  }))
  const waitFor = async (label, fn, ms = 8000) => {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}; stderr: ${stderrText}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  try {
    await ok('real ticks open an episode at 99%, and resume both frozen sessions once the boundary moves -- a hand resume before it included', async () => {
      const ids = ['frozen-e2e', 'hand-e2e']
      writeFileSync(agentsFile, JSON.stringify([
        { id: 'fz01', sessionId: 'frozen-e2e', kind: 'interactive', status: 'idle' },
        { id: 'hd02', sessionId: 'hand-e2e', kind: 'interactive', status: 'idle' },
      ]))
      for (const sid of ids) {
        await post('/api/register', { session: { id: sid, name: sid, cwd: dataDir, pid: process.pid, startedAt: Date.now() } })
        await post('/api/stats', { id: sid, working: true, stats: { ctx: 10, tools: 1, spend: 0.5 } })
      }
      assert.equal((await post('/api/resume', { armed: true, by: 'toggle' })).status, 200)

      const first = Date.now() + 3600_000
      drop(99, first)
      await waitFor('the episode to open', async () => (await state()).afterReset.resume.episode)
      const armed = await waitFor('both frozen sessions to be listed as disrupted', async () => {
        const r = (await state()).afterReset.resume
        return r.held === null && r.disrupted.length === 2 ? r : null
      })
      assert.deepEqual(armed.disrupted.map((d) => d.id).sort(), [...ids].sort())
      assert.ok(armed.disrupted.every((d) => d.eligible))

      // Pressed into the limit itself, before the reset.
      const hand = await post('/api/resume/fire', { id: 'hand-e2e' })
      assert.equal(hand.status, 200, JSON.stringify(hand))
      assert.equal(hand.entry.payload.byHand, true)
      assert.equal(hand.entry.state, 'fired')
      await (await fetch(`${base}/api/commands/hand-e2e?token=${TOKEN}`)).json()

      drop(3, first + 5 * 3600_000)
      for (const sid of ids) {
        const entry = await waitFor(`a settled auto resume entry for ${sid}`, async () =>
          (await state()).afterReset.queue.find((e) => e.kind === 'resume' && e.target === sid
            && e.payload?.auto === true && e.state !== 'pending'))
        assert.equal(entry.state, 'fired', JSON.stringify(entry))
        assert.equal(entry.armedResetsAt, Math.floor(first / 1000) * 1000)
      }

      for (const sid of ids) {
        const q = await (await fetch(`${base}/api/commands/${sid}?token=${TOKEN}`)).json()
        assert.equal(q.commands.length, 1, `${sid} holds exactly one command`)
        assert.equal(q.commands[0].verb, 'prompt')
        assert.match(q.commands[0].payload.text, /usage limit/)
      }

      await new Promise((r) => setTimeout(r, 900))   // several more ticks
      const after = (await state()).afterReset
      assert.equal(after.queue.filter((e) => e.kind === 'resume').length, 3, 'one by hand, two at the reset, and a later tick fires nothing')
      assert.equal(after.resume.episode, null, 'the episode closed')
      assert.equal(after.resume.lastFire.fired, 2)
      assert.equal(after.resume.lastFire.failed, 0)
    })

    await ok('a reset that resumes nobody still records that it passed', async () => {
      // A boundary the relay has not seen: the previous case left it at
      // first + 5h, which is later than now + 5h.
      const second = (await state()).usage.fiveHour.resetsAt + 3600_000
      drop(99, second)
      const ep = await waitFor('a new episode', async () => (await state()).afterReset.resume.episode)
      for (const id of ['frozen-e2e', 'hand-e2e']) {
        assert.equal((await post('/api/resume', { exclude: { id, name: id, until: ep.resetsAt + 1 } })).status, 200)
      }
      const before = (await state()).afterReset.resume.lastFire
      drop(3, second + 5 * 3600_000)
      const lf = await waitFor('lastFire for the empty reset', async () => {
        const r = (await state()).afterReset.resume
        return r.lastFire && r.lastFire.resetsAt === ep.resetsAt ? r.lastFire : null
      })
      assert.notDeepEqual(lf, before)
      assert.equal(lf.fired, 0)
      assert.equal(lf.failed, 0)
      const left = await waitFor('the exclusions to end with the reset that honoured them', async () => {
        const ex = (await state()).afterReset.resume.excluded
        return ex.length === 0 ? ex : null
      })
      assert.deepEqual(left, [], 'an exclusion outliving its episode would silently suppress a later reset')
    })

    await ok('a reading gone dark still resumes the fleet and fires the queue at the boundary, by the clock', async () => {
      // Enough lead that a loaded machine still turns the reading dark before
      // the clock could prove the reset; the waits below cover it.
      const boundary = Math.ceil((Date.now() + 8000) / 1000) * 1000
      const marks = []
      const mark = (label) => marks.push(`${label} ${Date.now() - boundary}ms`)
      mark('start')
      drop(99, boundary)
      await waitFor('the episode for the near boundary', async () =>
        (await state()).afterReset.resume.episode?.resetsAt === boundary)
      mark('episode')

      // Queued while the reading is still fresh, so it is armed against the boundary.
      const queued = await post('/api/after-reset', { window: 'fiveHour', kind: 'prompt', target: 'frozen-e2e', payload: { text: 'after the dark reset' } })
      assert.equal(queued.status, 200, JSON.stringify(queued))
      assert.equal(queued.entry.armedResetsAt, boundary)
      mark('queued')

      for (const sid of ['frozen-e2e', 'hand-e2e']) {
        await (await fetch(`${base}/api/commands/${sid}?token=${TOKEN}`)).json()
      }
      mark('drained')

      // The limit stops every session, so no statusline runs: the newest drop
      // carries no rate limits at all.
      writeFileSync(join(slDir, 'drop.json'), JSON.stringify({ szg_written_at: Math.floor(Date.now() / 1000) }))
      await waitFor('the reading to go dark', async () => (await state()).usage.fiveHour === null)
      mark('dark')
      assert.equal((await state()).usage.fiveHour, null)
      assert.ok(Date.now() < boundary + 300, `the reading went dark before the clock could prove the reset (${marks.join(', ')})`)

      const resumes = await waitFor('two settled auto resumes for the near boundary', async () => {
        const rs = (await state()).afterReset.queue.filter((e) => e.kind === 'resume'
          && e.payload?.auto === true && e.armedResetsAt === boundary)
        return rs.length === 2 && rs.every((e) => e.state !== 'pending') ? rs : null
      }, 15_000)
      for (const e of resumes) assert.equal(e.state, 'fired', JSON.stringify(e))
      assert.deepEqual(resumes.map((e) => e.target).sort(), ['frozen-e2e', 'hand-e2e'])

      const prompt = await waitFor('the queued prompt to settle', async () =>
        (await state()).afterReset.queue.find((e) => e.id === queued.entry.id && e.state !== 'pending'))
      assert.equal(prompt.state, 'fired', JSON.stringify(prompt))

      const fq = await (await fetch(`${base}/api/commands/frozen-e2e?token=${TOKEN}`)).json()
      assert.equal(fq.commands.length, 2, JSON.stringify(fq.commands))
      assert.ok(fq.commands.every((c) => c.verb === 'prompt'))
      assert.match(fq.commands[0].payload.text, /usage limit/, 'the resume runs before the queue')
      assert.equal(fq.commands[1].payload.text, 'after the dark reset')
      const hq = await (await fetch(`${base}/api/commands/hand-e2e?token=${TOKEN}`)).json()
      assert.equal(hq.commands.length, 1, JSON.stringify(hq.commands))
      assert.match(hq.commands[0].payload.text, /usage limit/)

      const r = (await state()).afterReset.resume
      assert.equal(r.lastFire.resetsAt, boundary)
      assert.equal(r.lastFire.fired, 2)
      assert.equal(r.episode, null)
    })
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)) }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
  }
}

// Static guards on the pane: the settings pop's limit-resume switch is the
// arm button's own path, read from the same field. A harness cannot click it;
// what it can hold is that a merge never quietly unwires it.
console.log('\n=== the pane: limit resume is a switch in the settings pop ===')
{
  const PUB = join(ROOT, 'syzygy', 'bridge', 'public')
  const html = readFileSync(join(PUB, 'index.html'), 'utf8')
  const app = readFileSync(join(PUB, 'app.js'), 'utf8')
  const fn = (name) => {
    const at = app.indexOf(`const ${name} = `)
    assert.ok(at >= 0, `app.js must define ${name}`)
    return app.slice(at, app.indexOf('\n}\n', at))
  }

  await ok('the switch, its hint and its old-relay note sit inside #settingspop', () => {
    const start = html.indexOf('id="settingspop"')
    const pop = html.slice(start, html.indexOf('id="authbox"', start))
    assert.match(pop, /<input type="checkbox" id="resume-enable">/)
    assert.match(pop, /Off by default\./)
    assert.match(pop, /id="resume-old" hidden/)
    assert.match(pop, /id="resume-setting-err" hidden/)
    assert.ok(html.includes('id="ar-resume-arm"'), 'the Telemetry tab keeps its arm button')
  })

  await ok('renderResume sets the switch from the field the arm button reads', () => {
    const body = fn('renderResume')
    assert.ok(body.includes("$('resume-enable')"), 'renderResume must reach the switch')
    assert.match(body, /\.checked = !!r\?\.armed/)
    assert.match(body, /\.disabled = r == null/)
    assert.ok(body.includes("$('resume-old').hidden = r != null"), 'an older relay must say so')
  })

  await ok('the switch reaches armResume, and never posts on its own', () => {
    const at = app.indexOf("$('resume-enable').addEventListener('change'")
    assert.ok(at >= 0, 'the switch needs a change handler')
    const handler = app.slice(at, app.indexOf('\n})\n', at))
    assert.ok(handler.includes('armResume('), 'the handler must run the arm path')
    assert.ok(!handler.includes('post('), 'a second POST would drift from the button')
  })

  await ok('a finished write redraws the switch, and a refusal is shown in the pop', () => {
    const body = fn('armResume')
    assert.ok(body.includes('renderResume()'), 'a refusal must redraw the switch back')
    assert.ok(body.includes("$('resume-setting-err')"), 'the pop needs its own error line')
  })
}

rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
console.log(`\nusage harness: ${pass} checks passed`)
