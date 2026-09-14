#!/usr/bin/env node
// Drives bridge/public/orbit-model.js under node. Hermetic: no relay, no
// network, no filesystem beyond reading source files to pin mirrored
// constants against their originals.
//
// Run: node test/orbit-harness.mjs   (or `just test-orbit`)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

// A CLASSIC script like canvas-layout.js, evaluated through `new Function`.
const MCO = new Function('window', read('syzygy/bridge/public/orbit-model.js') + '\nreturn MCO')({})

let pass = 0
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label) }

console.log('orbit harness')

// ---- fixtures ---------------------------------------------------------------
const T0 = 1_700_000_000_000
const sess = (over = {}) => ({
  id: 's1', name: 'alpha', cwd: '/repo', root: '/repo',
  startedAt: T0, working: false, needs: '', waiting: false, waitingFor: '',
  stats: {}, ...over,
})
/** One project whose worktrees hold the named session ids. */
const proj = (key, name, worktrees) => ({
  key, name, isGit: true, mainRoot: worktrees[0].path,
  worktrees: worktrees.map((w) => ({
    path: w.path, branch: w.branch ?? null, isMain: w.path === worktrees[0].path,
    sessions: (w.ids ?? []).map((id) => ({ id, name: id, working: false })),
  })),
})

// ---- constants --------------------------------------------------------------
ok('the version and the sentinel are what consumers pin against', () => {
  assert.equal(typeof MCO.VERSION, 'number')
  assert.equal(MCO.UNBOUND, '~unbound')
  assert.equal(MCO.UNBOUND.startsWith('/'), false, 'must not collide with a commonDir')
  assert.deepEqual(MCO.LENSES, ['sessions', 'tokens', 'needs'])
  assert.deepEqual(MCO.STATES, ['waiting', 'error', 'working', 'idle'])
})

// ---- session classification -------------------------------------------------
ok('needsOf is the union of the two signals, with the relay winning', () => {
  assert.equal(MCO.needsOf(null), '')
  assert.equal(MCO.needsOf(sess()), '')
  assert.equal(MCO.needsOf(sess({ needs: 'continue?' })), 'continue?')
  assert.equal(MCO.needsOf(sess({ waiting: true })), 'waiting for input')
  assert.equal(MCO.needsOf(sess({ waiting: true, waitingFor: 'a permission' })), 'a permission')
  assert.equal(MCO.needsOf(sess({ waiting: true, needs: 'continue?' })), 'waiting for input')
})

ok('recentErrorsById counts per session inside its own window', () => {
  const events = []
  for (let i = 0; i < 20; i++) events.push({ sessionId: 's1', status: i < 17 ? 'ok' : 'error' })
  events.push({ sessionId: 's2', status: 'error' })
  events.push({ status: 'error' })            // no sessionId: ignored
  const m = MCO.recentErrorsById(events)
  assert.equal(m.get('s1'), 3)
  assert.equal(m.get('s2'), 1)
  assert.equal(MCO.recentErrorsById(null).size, 0)
})

ok('recentErrorsById forgets errors that fell out of the window', () => {
  const events = [{ sessionId: 's1', status: 'error' }]
  for (let i = 0; i < MCO.ERROR_WINDOW; i++) events.push({ sessionId: 's1', status: 'ok' })
  assert.equal(MCO.recentErrorsById(events).get('s1'), undefined)
})

ok('sessionState is waiting > error > working > idle', () => {
  assert.equal(MCO.sessionState(null, 0), 'idle')
  assert.equal(MCO.sessionState(sess(), 0), 'idle')
  assert.equal(MCO.sessionState(sess({ working: true }), 0), 'working')
  assert.equal(MCO.sessionState(sess({ working: true }), 3), 'error')
  assert.equal(MCO.sessionState(sess({ working: true, waiting: true }), 3), 'waiting')
  assert.equal(MCO.sessionState(sess({ working: true }), 2), 'working', 'two errors is not error')
})

// ---- the fold ---------------------------------------------------------------
ok('twelve worktrees of one project fold onto ONE body', () => {
  const wts = []
  for (let i = 0; i < 12; i++) wts.push({ path: '/repo/w' + i, ids: ['s' + i] })
  const projects = [proj('/repo/.git', 'repo', wts)]
  const sessions = wts.map((w, i) => sess({ id: 's' + i, cwd: w.path, root: w.path }))
  const bodies = MCO.foldBodies({ sessions, projects })
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].key, '/repo/.git')
  assert.equal(bodies[0].name, 'repo')
  assert.equal(bodies[0].mainRoot, '/repo/w0')
  assert.equal(bodies[0].worktreeCount, 12)
  assert.equal(bodies[0].counts.total, 12)
  assert.equal(bodies[0].unbound, false)
  const newestFirst = [...sessions].reverse()
  assert.deepEqual(
    MCO.foldBodies({ sessions: newestFirst, projects })[0].sessionIds,
    newestFirst.map((s) => s.id),
    'sessionIds follow the payload order, not the worktree order',
  )
})

ok('a session in a SUBDIRECTORY of a worktree still folds', () => {
  // The scanner has already bound it; the id is in the worktree's list even
  // though no path in the payload equals the session's cwd.
  const projects = [proj('/repo/.git', 'repo', [{ path: '/repo', ids: ['s1'] }])]
  const sessions = [sess({ id: 's1', cwd: '/repo/src/deep', root: '/repo/src/deep' })]
  const bodies = MCO.foldBodies({ sessions, projects })
  assert.equal(bodies.length, 1)
  assert.deepEqual(bodies[0].sessionIds, ['s1'])
})

ok('a session no project claims lands on the unbound body', () => {
  const projects = [proj('/repo/.git', 'repo', [{ path: '/repo', ids: ['s1'] }])]
  const sessions = [sess({ id: 's1' }), sess({ id: 'lost', cwd: '', root: '' })]
  const bodies = MCO.foldBodies({ sessions, projects })
  const halo = bodies.find((b) => b.unbound)
  assert.ok(halo, 'the unbound body exists')
  assert.equal(halo.key, MCO.UNBOUND)
  assert.equal(halo.name, 'unbound')
  assert.equal(halo.mainRoot, null)
  assert.deepEqual(halo.sessionIds, ['lost'])
})

ok('an EMPTY unbound body is omitted entirely', () => {
  const projects = [proj('/repo/.git', 'repo', [{ path: '/repo', ids: ['s1'] }])]
  const bodies = MCO.foldBodies({ sessions: [sess({ id: 's1' })], projects })
  assert.equal(bodies.some((b) => b.unbound), false)
})

ok('a project the scanner reports with no live session still gets a body', () => {
  const projects = [proj('/repo/.git', 'repo', [{ path: '/repo', ids: [] }])]
  const bodies = MCO.foldBodies({ sessions: [], projects })
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].counts.total, 0)
  assert.equal(bodies[0].state, 'idle')
})

ok('counts partition the set, and the two needs-me signals are separate', () => {
  const projects = [proj('/repo/.git', 'repo', [{ path: '/repo', ids: ['a', 'b', 'c', 'd', 'e'] }])]
  const sessions = [
    sess({ id: 'a', working: true }),
    sess({ id: 'b', waiting: true }),                   // relay's observation
    sess({ id: 'c', needs: 'which one?' }),             // plugin's inference
    sess({ id: 'd', working: true }),                   // errored below
    sess({ id: 'e' }),
  ]
  const events = []
  for (let i = 0; i < 3; i++) events.push({ sessionId: 'd', status: 'error' })
  const b = MCO.foldBodies({ sessions, projects, events })[0]
  assert.equal(b.counts.total, 5)
  assert.equal(b.counts.working, 1)
  assert.equal(b.counts.waiting, 1, 'relay-observed only')
  assert.equal(b.counts.needs, 1, 'plugin-inferred only')
  assert.equal(b.counts.needsAny, 2, 'the union is what the classifier buckets')
  assert.equal(b.counts.error, 1)
  assert.equal(b.counts.idle, 1)
  assert.equal(b.counts.working + b.counts.needsAny + b.counts.error + b.counts.idle, b.counts.total)
})

ok('a body\'s state is the session precedence over its set', () => {
  const P = [proj('/r/.git', 'r', [{ path: '/r', ids: ['a', 'b'] }])]
  const st = (sessions, events) => MCO.foldBodies({ sessions, projects: P, events })[0].state
  assert.equal(st([sess({ id: 'a' }), sess({ id: 'b' })]), 'idle')
  assert.equal(st([sess({ id: 'a', working: true }), sess({ id: 'b' })]), 'working')
  const errs = [{ sessionId: 'b', status: 'error' }, { sessionId: 'b', status: 'error' }, { sessionId: 'b', status: 'error' }]
  assert.equal(st([sess({ id: 'a', working: true }), sess({ id: 'b' })], errs), 'error')
  assert.equal(st([sess({ id: 'a', waiting: true }), sess({ id: 'b' })], errs), 'waiting')
})

ok('colour comes from the state table, and accentOf can override idle', () => {
  const P = [proj('/r/.git', 'r', [{ path: '/r', ids: ['a'] }])]
  const plain = MCO.foldBodies({ sessions: [sess({ id: 'a' })], projects: P })[0]
  assert.equal(plain.color, MCO.STATE_ACCENT.idle)
  assert.equal(plain.colorHot, MCO.STATE_HOT)
  const themed = MCO.foldBodies({
    sessions: [sess({ id: 'a' })], projects: P,
    accentOf: (st) => (st === 'idle' ? '#123456' : MCO.STATE_ACCENT[st]),
  })[0]
  assert.equal(themed.color, '#123456')
})

ok('a malformed payload folds to nothing and never throws', () => {
  for (const input of [
    {}, { sessions: null, projects: null }, { sessions: [null], projects: [null] },
    { sessions: [{}], projects: [{ key: null }] },
    { projects: [{ key: '/r/.git', worktrees: 'nope' }] },
    { projects: [{ key: '/r/.git', worktrees: [null, { sessions: null }] }] },
  ]) {
    const bodies = MCO.foldBodies(input)
    assert.ok(Array.isArray(bodies), JSON.stringify(input))
  }
})

// ---- the mirror pins --------------------------------------------------------
ok('the state table mirrors swarm-math.js, hex for hex', () => {
  const src = read('syzygy/bridge/public/swarm-math.js')
  for (const [state, hex] of Object.entries(MCO.STATE_ACCENT)) {
    assert.ok(src.includes(`${state}: '${hex}'`), `swarm-math.js must still say ${state}: '${hex}'`)
  }
  assert.match(src, /STATE_ACCENT_HOT = \{ working: '#f4b45c' \}/)
  assert.equal(MCO.STATE_HOT, '#f4b45c')
})

ok('the error window mirrors swarm-math.js', () => {
  const src = read('syzygy/bridge/public/swarm-math.js')
  assert.match(src, /ERROR_WINDOW = 14/)
  assert.match(src, /ERROR_COUNT = 3/)
  assert.equal(MCO.ERROR_WINDOW, 14)
  assert.equal(MCO.ERROR_COUNT, 3)
})

ok('needsOf mirrors app.js\'s real source, behaviourally and by text', () => {
  const src = read('syzygy/bridge/public/app.js')
  assert.match(
    src,
    /const needsOf = \(s\) => \(s && s\.waiting \? \(s\.waitingFor \|\| 'waiting for input'\) : \(\(s && s\.needs\) \|\| ''\)\)/,
    'app.js\'s needsOf',
  )
  const appNeedsOf = (s) => (s && s.waiting ? (s.waitingFor || 'waiting for input') : ((s && s.needs) || ''))
  for (const s of [null, {}, { waiting: true }, { waiting: true, waitingFor: 'x' }, { needs: 'y' },
                   { waiting: true, needs: 'y' }, { waiting: false, needs: '' }]) {
    assert.equal(MCO.needsOf(s), appNeedsOf(s), JSON.stringify(s))
  }
})

// ---- the orbit table --------------------------------------------------------
ok('a slot maps to a ring, an inclination and a golden-angle phase', () => {
  const a = MCO.bodyOrbit(0), b = MCO.bodyOrbit(1), c = MCO.bodyOrbit(3)
  assert.equal(a.radius, MCO.ORBIT.base)
  assert.equal(b.radius, MCO.ORBIT.base + MCO.ORBIT.gap)
  assert.equal(c.radius, MCO.ORBIT.base, 'ring 3 wraps to the innermost')
  assert.equal(a.inclination, MCO.ORBIT.inclBias)
  assert.notEqual(a.phase, b.phase)
  const bad = MCO.bodyOrbit(-1)
  assert.equal(bad.radius, MCO.ORBIT.base, 'a nonsense slot is slot 0, never NaN')
  assert.ok(Number.isFinite(MCO.bodyOrbit(undefined).phase))
})

ok('every radius is normalized and fits strictly inside the camera bound', () => {
  for (let slot = 0; slot < 64; slot++) {
    const o = MCO.bodyOrbit(slot)
    assert.ok(o.radius > 0 && o.radius <= 1, `slot ${slot} radius ${o.radius}`)
    assert.ok(o.radius * MCO.SPHERE_ORBIT_CAP < MCO.SPHERE_VISIBLE_HALF_HEIGHT)
    assert.ok(Math.abs(o.inclination) <= 1, `slot ${slot} inclination`)
    assert.ok(o.phase >= 0 && o.phase < Math.PI * 2)
  }
  const phases = new Set()
  for (let slot = 0; slot < MCO.MAX_BODIES; slot++) phases.add(MCO.bodyOrbit(slot).phase.toFixed(9))
  assert.equal(phases.size, MCO.MAX_BODIES, 'no two of the first twelve share a phase')
})

ok('the recorded camera constants are re-derived from swarm-math.js', () => {
  const src = read('syzygy/bridge/public/swarm-math.js')
  const pick = (name) => {
    const m = new RegExp(`${name}\\s*=\\s*([0-9.]+)`).exec(src)
    assert.ok(m, `swarm-math.js must still define ${name}`)
    return Number(m[1])
  }
  const half = pick('CAMERA_Z') * Math.sin(pick('CAMERA_FOV_DEG') * Math.PI / 360)
  assert.equal(MCO.SPHERE_VISIBLE_HALF_HEIGHT, half)
  assert.equal(MCO.SPHERE_ORBIT_CAP, half - pick('SPRITE_MARGIN'))
})

// ---- recents ----------------------------------------------------------------
const REC_PROJECTS = [
  proj('/a/.git', 'a', [{ path: '/a' }, { path: '/a/wt' }]),
  proj('/b/.git', 'b', [{ path: '/b' }]),
]

ok('recentRank resolves a recents path to a project by exact equality', () => {
  const rank = MCO.recentRank({ recents: ['/b', '/a/wt'] }, REC_PROJECTS)
  assert.equal(rank.get('/b/.git'), 0)
  assert.equal(rank.get('/a/.git'), 1)
})

ok('an unresolvable recents path gives no boost and is not an error', () => {
  const rank = MCO.recentRank({ recents: ['/a/src/deep', '/elsewhere', null, '/a'] }, REC_PROJECTS)
  assert.equal(rank.has('/b/.git'), false)
  assert.equal(rank.get('/a/.git'), 3, 'the exact worktree path at index 3, not the subdirectory at 0')
  assert.equal(MCO.recentRank(null, REC_PROJECTS).size, 0)
  assert.equal(MCO.recentRank({ recents: 'nope' }, null).size, 0)
})

// ---- slots ------------------------------------------------------------------
const NOR = new Map()

ok('a newcomer takes the lowest free slot, deterministically', () => {
  const s1 = MCO.assignSlots(null, ['/b/.git', '/a/.git'], NOR, T0)
  assert.equal(s1['/a/.git'].slot, 0, 'ties break by key, so a cold start is repeatable')
  assert.equal(s1['/b/.git'].slot, 1)
  const s2 = MCO.assignSlots(null, ['/a/.git', '/b/.git'], NOR, T0)
  assert.deepEqual(s2, s1, 'the input order of the same set cannot change the answer')
})

ok('recents order wins over key order among newcomers', () => {
  const rank = MCO.recentRank({ recents: ['/b'] }, REC_PROJECTS)
  const s = MCO.assignSlots(null, ['/a/.git', '/b/.git'], rank, T0)
  assert.equal(s['/b/.git'].slot, 0, 'the project just touched sits on the inner ring')
  assert.equal(s['/a/.git'].slot, 1)
})

ok('a SURVIVOR never moves when an unrelated project vanishes', () => {
  const first = MCO.assignSlots(null, ['/a/.git', '/b/.git', '/c/.git'], NOR, T0)
  assert.equal(first['/b/.git'].slot, 1)
  const after = MCO.assignSlots(first, ['/b/.git'], NOR, T0 + 1000)
  assert.equal(after['/b/.git'].slot, 1, 'still slot 1, not compacted to 0')
})

ok('an absent project\'s slot is held, then released', () => {
  const first = MCO.assignSlots(null, ['/a/.git', '/b/.git'], NOR, T0)
  const held = MCO.assignSlots(first, ['/b/.git', '/new/.git'], NOR, T0 + MCO.SLOT_HOLD_MS - 1)
  assert.equal(held['/new/.git'].slot, 2, 'slot 0 is still /a/.git\'s while the hold lasts')
  assert.equal(held['/a/.git'].slot, 0)
  const freed = MCO.assignSlots(held, ['/b/.git', '/new/.git', '/third/.git'], NOR, T0 + MCO.SLOT_HOLD_MS + 1)
  assert.equal(freed['/a/.git'], undefined, 'the hold expired and the entry is gone')
  assert.equal(freed['/third/.git'].slot, 0, 'and slot 0 is free again')
})

ok('a present project\'s hold clock is refreshed every frame', () => {
  let s = MCO.assignSlots(null, ['/a/.git'], NOR, T0)
  for (let i = 1; i <= 5; i++) s = MCO.assignSlots(s, ['/a/.git'], NOR, T0 + i * MCO.SLOT_HOLD_MS)
  assert.equal(s['/a/.git'].slot, 0, 'a project that never left keeps its slot forever')
})

ok('a corrupt slot table is ignored entry by entry, never fatal', () => {
  const prev = { '/a/.git': { slot: 'two', seenAt: T0 }, '/b/.git': { slot: -3 }, '/c/.git': null, '/d/.git': { slot: 1, seenAt: T0 } }
  const s = MCO.assignSlots(prev, ['/a/.git', '/d/.git'], NOR, T0)
  assert.equal(s['/d/.git'].slot, 1, 'the one good entry is carried')
  assert.equal(s['/a/.git'].slot, 0, 'the bad one is re-assigned')
})

// ---- the token-rate window --------------------------------------------------
const ring = (...pairs) => pairs.map(([t, outTok]) => ({ t, outTok }))

ok('a rate needs two readings spanning the minimum, else it is 0', () => {
  assert.equal(MCO.rateOf(null), 0)
  assert.equal(MCO.rateOf(ring([T0, 100])), 0, 'one reading is no rate')
  assert.equal(MCO.rateOf(ring([T0, 100], [T0 + MCO.MIN_SPAN_MS - 1, 200])), 0, 'too short a span is no rate')
  assert.equal(MCO.rateOf(ring([T0, 100], [T0 + 10_000, 1100])), 100, '1000 tokens over 10 s')
})

ok('a counter that did not move reads as no output', () => {
  assert.equal(MCO.rateOf(ring([T0, 500], [T0 + 10_000, 500])), 0)
})

ok('nextSamples pushes one reading per frame and trims to the window', () => {
  let s = {}
  for (let i = 0; i <= 30; i++) {
    s = MCO.nextSamples(s, [sess({ id: 'a', stats: { outTok: i * 10 } })], T0 + i * 1000)
  }
  const r = s.a
  assert.ok(r.length <= MCO.SAMPLE_CAP, 'capped')
  assert.ok(T0 + 30_000 - r[0].t <= MCO.ACTIVITY.windowMs, 'and inside the window')
  assert.equal(r[r.length - 1].outTok, 300)
})

ok('a session with no outTok grows no ring, and activity says so', () => {
  const s = MCO.nextSamples({}, [sess({ id: 'a', stats: { ctx: 1000 } })], T0)
  assert.equal(s.a, undefined)
})

ok('a counter that DROPS is a reset, never a negative rate', () => {
  let s = MCO.nextSamples({}, [sess({ id: 'a', stats: { outTok: 5000 } })], T0)
  s = MCO.nextSamples(s, [sess({ id: 'a', stats: { outTok: 9000 } })], T0 + 5000)
  assert.ok(MCO.rateOf(s.a) > 0)
  s = MCO.nextSamples(s, [sess({ id: 'a', stats: { outTok: 12 } })], T0 + 10_000)
  assert.equal(s.a.length, 1, 'the history went with the reset')
  assert.equal(MCO.rateOf(s.a), 0)
})

ok('a session that left the board takes its samples with it', () => {
  let s = MCO.nextSamples({}, [sess({ id: 'a', stats: { outTok: 10 } })], T0)
  s = MCO.nextSamples(s, [sess({ id: 'b', stats: { outTok: 10 } })], T0 + 1000)
  assert.equal(s.a, undefined)
  assert.ok(s.b)
})

ok('burn mirrors the presence swarm\'s curve, converted to tokens per second', () => {
  const src = read('syzygy/bridge/public/swarm-math.js')
  const pick = (k) => Number(new RegExp(`${k}: (\\d+)`).exec(src)[1])
  assert.equal(MCO.ACTIVITY.r0 * 60, pick('r0'), 'r0 is BURN.r0 per second')
  assert.equal(MCO.ACTIVITY.rmax * 60, pick('rmax'), 'rmax is BURN.rmax per second')
  assert.match(src, /windowMs: 24_000/)
  assert.equal(MCO.ACTIVITY.windowMs, 24_000)
  assert.equal(MCO.burn(0), 0)
  assert.equal(MCO.burn(-5), 0)
  assert.equal(MCO.burn(MCO.ACTIVITY.rmax), 1)
  assert.equal(MCO.burn(1e9), 1, 'clamped, never over 1')
  assert.ok(MCO.burn(MCO.ACTIVITY.r0) > 0.2 && MCO.burn(MCO.ACTIVITY.r0) < 0.3)
})

// ---- the lens ---------------------------------------------------------------
ok('an unknown lens falls back to sessions, with no migration anywhere', () => {
  assert.equal(MCO.resolveLens('tokens'), 'tokens')
  assert.equal(MCO.resolveLens('needs'), 'needs')
  for (const bad of [undefined, null, '', 'orbit', 42, {}]) assert.equal(MCO.resolveLens(bad), 'sessions')
})

// ---- projectBodies ----------------------------------------------------------
const FRAME = (over = {}) => ({
  now: T0,
  sessions: [sess({ id: 'a', working: true }), sess({ id: 'b' })],
  projects: [proj('/repo/.git', 'repo', [{ path: '/repo', ids: ['a', 'b'] }])],
  ...over,
})

ok('the result carries the version, a core, bodies and both carry-forwards', () => {
  const r = MCO.projectBodies(FRAME())
  assert.equal(r.version, MCO.VERSION)
  assert.equal(r.bodies.length, 1)
  assert.equal(typeof r.samples, 'object')
  assert.equal(typeof r.slots, 'object')
  assert.equal(r.slots['/repo/.git'].slot, 0)
  const b = r.bodies[0]
  for (const field of ['key', 'name', 'mainRoot', 'unbound', 'slot', 'orbit', 'state',
                       'color', 'colorHot', 'activity', 'rate', 'tokensAvailable',
                       'magnitude', 'focused', 'counts', 'worktreeCount', 'sessionIds']) {
    assert.ok(field in b, `a body must carry ${field}`)
  }
  assert.deepEqual(b.orbit, MCO.bodyOrbit(0))
  assert.equal(b.state, 'working')
})

ok('the core reads the orchestrator, and says null when it never blurbed', () => {
  const idle = MCO.projectBodies(FRAME()).core
  assert.equal(idle.state, 'idle')
  assert.equal(idle.busy, false)
  assert.equal(idle.blurbAgeMs, null, 'never a nine-digit age computed from zero')
  assert.equal(idle.live, 2)
  assert.equal(idle.bodies, 1)
  assert.equal(idle.overflow, 0)
  const busy = MCO.projectBodies(FRAME({ orchestrator: { busy: true, asking: false, blurbAt: T0 - 4000 } })).core
  assert.equal(busy.state, 'busy')
  assert.equal(busy.blurbAgeMs, 4000)
  const asking = MCO.projectBodies(FRAME({ orchestrator: { busy: true, asking: true, blurbAt: 0 } })).core
  assert.equal(asking.state, 'asking')
  assert.equal(asking.blurbAgeMs, null)
})

ok('core.live counts every live session, bound or not', () => {
  const r = MCO.projectBodies(FRAME({
    sessions: [sess({ id: 'a' }), sess({ id: 'b' }), sess({ id: 'lost', cwd: '', root: '' })],
  }))
  assert.equal(r.core.live, 3)
  assert.equal(r.bodies.length, 2)
  const halo = r.bodies[r.bodies.length - 1]
  assert.equal(halo.unbound, true, 'the unbound body is always last')
  assert.equal(halo.slot, null)
  assert.deepEqual(halo.orbit, { radius: 1, inclination: 0, phase: 0 })
})

ok('activity is the SUM of a project\'s session rates', () => {
  const rate = (n) => {
    const projects = [proj('/repo/.git', 'repo', [{ path: '/repo', ids: Array.from({ length: n }, (_, i) => 'z' + i) }])]
    const at = (t, tok) => Array.from({ length: n }, (_, i) => sess({ id: 'z' + i, working: true, stats: { outTok: tok } }))
    let r = MCO.projectBodies({ now: T0, sessions: at(T0, 0), projects })
    r = MCO.projectBodies({ now: T0 + 10_000, sessions: at(T0 + 10_000, 1000), projects, samples: r.samples, slots: r.slots })
    return r.bodies[0].rate
  }
  assert.equal(rate(1), 100)
  assert.equal(rate(4), 400, 'four sessions at one rate read four times as hot')
  assert.ok(MCO.burn(rate(4)) > MCO.burn(rate(1)))
})

ok('tokensAvailable is false when nothing reports the field, and activity is 0', () => {
  const r = MCO.projectBodies(FRAME())
  assert.equal(r.bodies[0].tokensAvailable, false)
  assert.equal(r.bodies[0].activity, 0)
  assert.equal(r.bodies[0].rate, 0)
  const withTok = MCO.projectBodies(FRAME({ sessions: [sess({ id: 'a', stats: { outTok: 12 } }), sess({ id: 'b' })] }))
  assert.equal(withTok.bodies[0].tokensAvailable, true)
})

ok('the lens chooses magnitude and every raw measure stays on the record', () => {
  const sessions = [sess({ id: 'a', working: true }), sess({ id: 'b', waiting: true }), sess({ id: 'c' })]
  const projects = [proj('/repo/.git', 'repo', [{ path: '/repo', ids: ['a', 'b', 'c'] }])]
  const at = (lens) => MCO.projectBodies({ now: T0, sessions, projects, lens }).bodies[0]
  assert.equal(at('sessions').magnitude, 3 / MCO.SESSIONS_FULL)
  assert.equal(at('tokens').magnitude, 0, 'no outTok, so the tokens lens is flat')
  assert.equal(at('needs').magnitude, 1 / 3)
  assert.equal(at(undefined).magnitude, at('sessions').magnitude)
  const b = at('needs')
  assert.equal(b.counts.total, 3, 'the counts are there whatever the lens says')
  assert.equal(typeof b.activity, 'number')
})

ok('the sessions lens saturates rather than exceeding 1', () => {
  const ids = Array.from({ length: 20 }, (_, i) => 'q' + i)
  const r = MCO.projectBodies({
    now: T0,
    sessions: ids.map((id) => sess({ id })),
    projects: [proj('/repo/.git', 'repo', [{ path: '/repo', ids }])],
  })
  assert.equal(r.bodies[0].magnitude, 1)
})

ok('an empty project\'s needs lens is 0, not a division by zero', () => {
  const r = MCO.projectBodies({
    now: T0, sessions: [], lens: 'needs',
    projects: [proj('/repo/.git', 'repo', [{ path: '/repo', ids: [] }])],
  })
  assert.equal(r.bodies[0].magnitude, 0)
})

ok('focus is echoed, normalized, and marks exactly one body', () => {
  const hit = MCO.projectBodies(FRAME({ focus: '/repo/.git' }))
  assert.equal(hit.core.focus, '/repo/.git')
  assert.equal(hit.bodies.filter((b) => b.focused).length, 1)
  const stale = MCO.projectBodies(FRAME({ focus: '/gone/.git' }))
  assert.equal(stale.core.focus, null, 'a focus naming no body is dropped')
  assert.equal(stale.bodies.some((b) => b.focused), false)
})

ok('bodies are ordered by slot, and a survivor does not jump when one ends', () => {
  const three = ['/a/.git', '/b/.git', '/c/.git']
  const projects = three.map((k, i) => proj(k, 'p' + i, [{ path: '/p' + i, ids: ['s' + i] }]))
  const sessions = three.map((_, i) => sess({ id: 's' + i, cwd: '/p' + i, root: '/p' + i }))
  const first = MCO.projectBodies({ now: T0, sessions, projects })
  assert.deepEqual(first.bodies.map((b) => b.slot), [0, 1, 2])
  const second = MCO.projectBodies({
    now: T0 + 2000, samples: first.samples, slots: first.slots,
    sessions: [sessions[2]], projects: [projects[2]],
  })
  assert.equal(second.bodies.length, 1)
  assert.equal(second.bodies[0].key, '/c/.git')
  assert.equal(second.bodies[0].slot, 2, 'still slot 2 -- the survivor never moves')
  assert.deepEqual(second.bodies[0].orbit, MCO.bodyOrbit(2))
})

ok('over MAX_BODIES the extra projects are reported, never silently dropped', () => {
  const n = MCO.MAX_BODIES + 3
  const keys = Array.from({ length: n }, (_, i) => '/p' + i + '/.git')
  const projects = keys.map((k, i) => proj(k, 'p' + i, [{ path: '/p' + i, ids: ['s' + i] }]))
  const sessions = keys.map((_, i) => sess({ id: 's' + i, cwd: '/p' + i, root: '/p' + i }))
  const r = MCO.projectBodies({ now: T0, sessions, projects, focus: null })
  assert.equal(r.bodies.length, MCO.MAX_BODIES)
  assert.equal(r.core.overflow, 3)
  assert.deepEqual(r.bodies.map((b) => b.slot), Array.from({ length: MCO.MAX_BODIES }, (_, i) => i))
  assert.equal(r.core.live, n, 'and every session is still counted')
})

ok('the unbound body is never the one the cap drops', () => {
  const n = MCO.MAX_BODIES + 1
  const keys = Array.from({ length: n }, (_, i) => '/p' + i + '/.git')
  const projects = keys.map((k, i) => proj(k, 'p' + i, [{ path: '/p' + i, ids: ['s' + i] }]))
  const sessions = keys.map((_, i) => sess({ id: 's' + i, cwd: '/p' + i, root: '/p' + i }))
  sessions.push(sess({ id: 'lost', cwd: '', root: '' }))
  const r = MCO.projectBodies({ now: T0, sessions, projects })
  assert.equal(r.bodies.filter((b) => b.unbound).length, 1)
  assert.equal(r.bodies.length, MCO.MAX_BODIES + 1)
})

ok('two frames of the same payload are identical, carry-forwards included', () => {
  const one = MCO.projectBodies(FRAME())
  const two = MCO.projectBodies({ ...FRAME(), samples: one.samples, slots: one.slots })
  assert.deepEqual(two.bodies, one.bodies)
  assert.deepEqual(two.slots, one.slots)
})

ok('every degraded input answers a well-formed frame and never throws', () => {
  for (const input of [
    undefined, {}, { sessions: null, projects: null, canvas: null, events: null, orchestrator: null },
    { sessions: [null, {}], projects: [null] },
    { sessions: [sess()], projects: [{ key: '/r/.git', worktrees: [{ path: '/r', sessions: [{ id: 's1' }] }] }], samples: 'nope', slots: 7 },
    { now: 'later', lens: 9, focus: 12 },
  ]) {
    const r = MCO.projectBodies(input)
    assert.equal(r.version, MCO.VERSION, JSON.stringify(input))
    assert.ok(Array.isArray(r.bodies))
    assert.equal(typeof r.core.state, 'string')
    assert.ok(MCO.LENSES.includes(r.core.lens))
    assert.ok(r.core.focus === null || typeof r.core.focus === 'string')
  }
})

// ---- the payload field ------------------------------------------------------
// A SOURCE pin, and deliberately not more: the plugin's POST is mocked in
// test/harness.mjs and no relay is running here, so the only honest claim is
// that the field is in the body the band builds. The wire itself is checked by
// hand against a live relay.
ok('the band sends outTok in its stats body', () => {
  const src = read('syzygy/hooks/hud.tsx')
  const at = src.indexOf("'/api/stats'")
  assert.ok(at > 0, 'hud.tsx must still POST /api/stats')
  const block = src.slice(at, at + 1400)
  assert.match(block, /stats: \{[^}]*outTok: s\.outTok/s, 'outTok in the stats object')
  assert.match(block, /stats: \{[^}]*ctx: s\.ctx/s, 'beside the fields already there')
})

ok('the relay carries a new stats key without knowing its name', () => {
  const src = read('syzygy/bridge/relay.mjs')
  assert.match(src, /stats: \{ \.\.\.s\.stats, \.\.\.\(body\.stats \?\? \{\}\) \}/,
    'the merge is what makes this a one-line change')
  const m = /const PAYLOAD_VERSION = (\d+)/.exec(src)
  assert.ok(m, 'PAYLOAD_VERSION must still be a literal')
  assert.ok(Number(m[1]) >= 7, 'a new payload field bumps it past develop\'s 6')
})

console.log(`\n${pass} checks passed`)
