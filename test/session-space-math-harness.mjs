#!/usr/bin/env node
// Drives the session-space tab's pure core (bridge/public/session-space-math.js)
// under node. Loaded the way voice-math.js is: read the file and `new
// Function` it -- never node:vm, which cannot see a classic script's
// top-level `const`. Hermetic: no DOM, no relay, no filesystem beyond
// reading the module's own source.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const MATH_SRC = join(ROOT, 'syzygy', 'bridge', 'public', 'session-space-math.js')

let pass = 0
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label) }

const MCZM = new Function('window', readFileSync(MATH_SRC, 'utf8') + '\nreturn MCZM')({})

console.log('=== session-space-math (pure core) ===')

// ---- toLayout ----------------------------------------------------------------
await ok('toLayout: at k=1 the rect centre is {0,0}, and y is DOWN', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 }
  const r = MCZM.toLayout({ x: 400, y: 300 }, rect, 1)
  assert.deepEqual(r, { x: 0, y: 0 })
  const r2 = MCZM.toLayout({ x: 440, y: 320 }, rect, 1)
  assert.deepEqual(r2, { x: 40, y: 20 })
})
await ok('toLayout: at k=0.5 the same pointer reads twice as far in layout space', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 }
  const r = MCZM.toLayout({ x: 440, y: 320 }, rect, 0.5)
  assert.deepEqual(r, { x: 80, y: 40 })
})
await ok('toLayout: an offset rect (not anchored at the viewport origin) still centres correctly', () => {
  const rect = { left: 100, top: 50, width: 800, height: 600 }
  const r = MCZM.toLayout({ x: 500, y: 350 }, rect, 1)
  assert.deepEqual(r, { x: 0, y: 0 })
})
await ok('toLayout: k of 0, negative, or non-finite falls back to 1 rather than dividing', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 }
  const pointer = { x: 440, y: 320 }
  assert.deepEqual(MCZM.toLayout(pointer, rect, 0), { x: 40, y: 20 })
  assert.deepEqual(MCZM.toLayout(pointer, rect, -2), { x: 40, y: 20 })
  assert.deepEqual(MCZM.toLayout(pointer, rect, NaN), { x: 40, y: 20 })
  assert.deepEqual(MCZM.toLayout(pointer, rect, Infinity), { x: 40, y: 20 })
  assert.deepEqual(MCZM.toLayout(pointer, rect, undefined), { x: 40, y: 20 })
})

// ---- magnetTargets -------------------------------------------------------------
await ok('magnetTargets: one session ref lands exactly at the pointer', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 }
  const refs = [{ kind: 'session', id: 's1', follow: true }]
  const out = MCZM.magnetTargets(refs, { x: 440, y: 320 }, rect, 1)
  assert.equal(out.length, 1)
  assert.equal(out[0].ref, refs[0])
  assert.deepEqual({ x: out[0].x, y: out[0].y }, { x: 40, y: 20 })
})
await ok('magnetTargets: pane refs are not cards and take no fan position', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 }
  const refs = [{ kind: 'pane', target: 'main:@1.%1', follow: true }, { kind: 'session', id: 's1', follow: true }]
  const out = MCZM.magnetTargets(refs, { x: 400, y: 300 }, rect, 1)
  assert.equal(out.length, 1)
  assert.equal(out[0].ref.kind, 'session')
})
await ok('magnetTargets: two session refs sit 18px apart along a fixed axis, in pick-up order', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 }
  const refs = [{ kind: 'session', id: 'a', follow: true }, { kind: 'session', id: 'b', follow: true }]
  const out = MCZM.magnetTargets(refs, { x: 400, y: 300 }, rect, 1)
  assert.equal(out.length, 2)
  assert.equal(out[0].ref.id, 'a')
  assert.equal(out[1].ref.id, 'b')
  const dx = out[1].x - out[0].x
  const dy = out[1].y - out[0].y
  assert.equal(Math.abs(dx), 18)
  assert.equal(Math.abs(dy), 18)
  assert.equal(dx, dy, 'the fan runs along one fixed diagonal, not an arbitrary angle')
})
await ok('magnetTargets: is deterministic -- the same input always produces the same output', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 }
  const refs = [{ kind: 'session', id: 'a', follow: true }, { kind: 'session', id: 'b', follow: true }, { kind: 'session', id: 'c', follow: true }]
  const pointer = { x: 400, y: 300 }
  const first = MCZM.magnetTargets(refs, pointer, rect, 1)
  const second = MCZM.magnetTargets(refs, pointer, rect, 1)
  assert.deepEqual(first.map((o) => ({ x: o.x, y: o.y })), second.map((o) => ({ x: o.x, y: o.y })))
})
await ok('magnetTargets: eight refs stay inside a bounded fan -- the offset stops growing', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 }
  const refs = Array.from({ length: 8 }, (_, i) => ({ kind: 'session', id: `s${i}`, follow: true }))
  const pointer = { x: 400, y: 300 }
  const out = MCZM.magnetTargets(refs, pointer, rect, 1)
  assert.equal(out.length, 8)
  const base = MCZM.toLayout(pointer, rect, 1)
  const offsets = out.map((o) => Math.hypot(o.x - base.x, o.y - base.y))
  // strictly non-decreasing, and capped -- the last two refs sit at the SAME
  // offset from the base, proving growth stopped rather than merely slowed.
  for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] >= offsets[i - 1])
  assert.equal(offsets[6], offsets[7], 'offset growth is capped well before the 8th card')
  assert.ok(offsets[7] <= 200, `fan offset ${offsets[7]} is not bounded`)
})
await ok('magnetTargets: z grows deeper in pick-up order and, unlike the lateral fan, is never capped', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 }
  const refs = Array.from({ length: 10 }, (_, i) => ({ kind: 'session', id: `s${i}`, follow: true }))
  const out = MCZM.magnetTargets(refs, { x: 400, y: 300 }, rect, 1)
  assert.equal(out[0].z, 0, 'pick-up order zero sits at its own depth')
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].z < out[i - 1].z, `card ${i} is not deeper than card ${i - 1}`)
  }
})

// ---- stackOffsets ---------------------------------------------------------------
await ok('stackOffsets: pick-up order zero has no depth; every later rank is strictly deeper', () => {
  assert.equal(MCZM.stackOffsets(0, 5).z, 0)
  for (const n of [1, 2, 7, 20]) {
    let last = 0
    for (let i = 1; i < n; i++) {
      const z = MCZM.stackOffsets(i, n).z
      assert.ok(z < last, `rank ${i} of ${n} is not deeper than the rank before it`)
      last = z
    }
  }
})
await ok('stackOffsets: the newest pick-up (the last rank) always sits at the largest depth', () => {
  for (const n of [1, 2, 7, 20]) {
    const zs = Array.from({ length: n }, (_, i) => MCZM.stackOffsets(i, n).z)
    const deepest = Math.min(...zs)
    assert.equal(zs[n - 1], deepest, `n=${n}`)
  }
})
await ok('stackOffsets: consecutive ranks are never closer than one card thickness plus a gap, at 1, 2, 7 and 20 cards', () => {
  for (const n of [1, 2, 7, 20]) {
    for (let i = 1; i < n; i++) {
      const gap = MCZM.stackOffsets(i - 1, n).z - MCZM.stackOffsets(i, n).z
      assert.ok(gap >= MCZM.STACK_STEP_PX, `n=${n} rank ${i}: only ${gap}px between ranks`)
    }
  }
})
await ok('stackOffsets: a rank\'s depth never changes as the carried count grows -- order is preserved across additions', () => {
  for (let rank = 0; rank < 7; rank++) {
    const at7 = MCZM.stackOffsets(rank, 7).z
    const at8 = MCZM.stackOffsets(rank, 8).z
    const at20 = MCZM.stackOffsets(rank, 20).z
    assert.equal(at7, at8, `rank ${rank}`)
    assert.equal(at7, at20, `rank ${rank}`)
  }
})
await ok('stackOffsets: releasing one card keeps the others\' relative order, reindexed around the gap', () => {
  // Five cards carried in pick-up order a,b,c,d,e; releasing the middle one
  // (c, rank 2) leaves a,b,d,e -- the survivors' own pick-up order untouched.
  const before = ['a', 'b', 'c', 'd', 'e']
  const beforeZ = new Map(before.map((id, i) => [id, MCZM.stackOffsets(i, before.length).z]))
  const after = before.filter((id) => id !== 'c')
  const afterZ = new Map(after.map((id, i) => [id, MCZM.stackOffsets(i, after.length).z]))
  // a and b, ahead of the gap, are untouched.
  assert.equal(afterZ.get('a'), beforeZ.get('a'))
  assert.equal(afterZ.get('b'), beforeZ.get('b'))
  // d and e close the gap but keep their order relative to each other and to a, b.
  assert.ok(afterZ.get('d') < afterZ.get('b'))
  assert.ok(afterZ.get('e') < afterZ.get('d'))
})
await ok('stackOffsets: never throws on a garbage rank or count, and clamps into range', () => {
  assert.doesNotThrow(() => MCZM.stackOffsets(undefined, undefined))
  assert.doesNotThrow(() => MCZM.stackOffsets(-5, 3))
  assert.equal(MCZM.stackOffsets(-5, 3).z, 0, 'a negative rank clamps to the front')
  assert.equal(MCZM.stackOffsets(99, 3).z, MCZM.stackOffsets(2, 3).z, 'an out-of-range rank clamps to the back')
})

// ---- carry ---------------------------------------------------------------------
await ok('magnetTargets: only a following ref takes a target, and the fan counts only following refs', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 }
  const refs = [
    { kind: 'session', id: 'still' },
    { kind: 'session', id: 'a', follow: true },
    { kind: 'session', id: 'still2', follow: false },
    { kind: 'session', id: 'b', follow: true },
  ]
  const out = MCZM.magnetTargets(refs, { x: 440, y: 320 }, rect, 1)
  assert.deepEqual(out.map((o) => o.ref.id), ['a', 'b'])
  assert.deepEqual({ x: out[0].x, y: out[0].y }, { x: 40, y: 20 }, 'the first follower sits at the pointer, whatever stays put before it')
  assert.deepEqual({ x: out[1].x, y: out[1].y }, { x: 58, y: 38 })
})
await ok('carry: adding a following ref upgrades a present one in place; a plain add never downgrades', () => {
  const carried = [{ kind: 'session', id: 'a' }, { kind: 'session', id: 'b', follow: true }]
  const up = MCZM.carry(carried, { kind: 'session', id: 'a', follow: true }, 'add')
  assert.deepEqual(up, [{ kind: 'session', id: 'a', follow: true }, { kind: 'session', id: 'b', follow: true }])
  assert.equal(carried[0].follow, undefined, 'the input is not mutated')
  assert.deepEqual(MCZM.carry(carried, { kind: 'session', id: 'b' }, 'add'), carried)
  assert.deepEqual(MCZM.carry(carried, { kind: 'session', id: 'b' }, 'toggle'), [{ kind: 'session', id: 'a' }],
    'a toggle removes by id, following or not')
})
await ok('carry: toggle adds an absent session ref, comparing by id', () => {
  const out = MCZM.carry([], { kind: 'session', id: 's1' }, 'toggle')
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 's1')
})
await ok('carry: toggle removes a present session ref, comparing by id', () => {
  const carried = [{ kind: 'session', id: 's1' }, { kind: 'session', id: 's2' }]
  const out = MCZM.carry(carried, { kind: 'session', id: 's1' }, 'toggle')
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 's2')
})
await ok('carry: toggle compares a pane ref by target, not identity', () => {
  const carried = [{ kind: 'pane', target: 'main:@1.%1' }]
  const out = MCZM.carry(carried, { kind: 'pane', target: 'main:@1.%1' }, 'toggle')
  assert.equal(out.length, 0)
})
await ok('carry: a pane ref and a session ref never compare equal, even with overlapping id/target text', () => {
  const carried = [{ kind: 'session', id: 'main:@1.%1' }]
  const out = MCZM.carry(carried, { kind: 'pane', target: 'main:@1.%1' }, 'toggle')
  assert.equal(out.length, 2, 'different kinds are never the same entry')
})
await ok('carry: add mode never removes a present ref', () => {
  const carried = [{ kind: 'session', id: 's1' }]
  const out = MCZM.carry(carried, { kind: 'session', id: 's1' }, 'add')
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 's1')
})
await ok('carry: add mode de-duplicates -- adding twice never doubles the entry', () => {
  let out = MCZM.carry([], { kind: 'session', id: 's1' }, 'add')
  out = MCZM.carry(out, { kind: 'session', id: 's1' }, 'add')
  assert.equal(out.length, 1)
})
await ok('carry: never mutates its input array', () => {
  const carried = [{ kind: 'session', id: 's1' }]
  const frozen = Object.freeze([...carried])
  assert.doesNotThrow(() => MCZM.carry(carried, { kind: 'session', id: 's2' }, 'toggle'))
  assert.deepEqual(carried, frozen)
})
await ok('carry: refuses the 33rd entry, returning the SAME array unchanged rather than truncating', () => {
  const carried = Array.from({ length: MCZM.CARRY_MAX }, (_, i) => ({ kind: 'session', id: `s${i}` }))
  const out = MCZM.carry(carried, { kind: 'session', id: 'overflow' }, 'toggle')
  assert.equal(out, carried, 'must be the identical array reference, not a copy')
  assert.equal(out.length, MCZM.CARRY_MAX)
})
await ok('CARRY_MAX is 32', () => {
  assert.equal(MCZM.CARRY_MAX, 32)
})

// ---- bucketSlots -----------------------------------------------------------------
await ok('bucketSlots: returns exactly 8 rows, slot 1..8', () => {
  const out = MCZM.bucketSlots([])
  assert.equal(out.length, 8)
  assert.deepEqual(out.map((r) => r.slot), [1, 2, 3, 4, 5, 6, 7, 8])
  for (const row of out) assert.equal(row.group, null)
})
await ok('bucketSlots: fills the slot a group names, leaves the rest null', () => {
  const g = { id: 'g1', slot: 3, kind: 'prompt', name: 'send a prompt' }
  const out = MCZM.bucketSlots([g])
  assert.equal(out[2].slot, 3)
  assert.equal(out[2].group, g)
  assert.equal(out[0].group, null)
  assert.equal(out[7].group, null)
})
await ok('bucketSlots: a group whose slot is out of range is ignored, not thrown on', () => {
  const bad = { id: 'g1', slot: 0, kind: 'prompt', name: 'x' }
  const bad2 = { id: 'g2', slot: 9, kind: 'prompt', name: 'y' }
  const out = MCZM.bucketSlots([bad, bad2])
  assert.equal(out.length, 8)
  for (const row of out) assert.equal(row.group, null)
})

// ---- groupTints -----------------------------------------------------------------
await ok('groupTints: a together group tints its members by id', () => {
  const groups = [{ id: 'g1', slot: 1, kind: 'together', name: 'the pair', color: '#e0973c', members: [{ id: 's1', name: 'alpha' }] }]
  const sessions = [{ id: 's1', name: 'alpha' }]
  const r = MCZM.groupTints(groups, sessions)
  assert.deepEqual(r.bySession, { s1: { id: 'g1', name: 'the pair', color: '#e0973c' } })
  assert.deepEqual(r.ambiguous, [])
})
await ok('groupTints: falls back to name when the id is gone and the name is unique', () => {
  const groups = [{ id: 'g1', slot: 1, kind: 'together', name: 'the pair', color: '#e0973c', members: [{ id: 'stale-id', name: 'alpha' }] }]
  const sessions = [{ id: 'new-id', name: 'alpha' }]
  const r = MCZM.groupTints(groups, sessions)
  assert.deepEqual(r.bySession, { 'new-id': { id: 'g1', name: 'the pair', color: '#e0973c' } })
})
await ok('groupTints: two live sessions sharing a name are tinted NEITHER, and the name is reported once as ambiguous', () => {
  const groups = [{ id: 'g1', slot: 1, kind: 'together', name: 'the pair', color: '#e0973c', members: [{ id: 'stale-id', name: 'alpha' }] }]
  const sessions = [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'alpha' }]
  const r = MCZM.groupTints(groups, sessions)
  assert.deepEqual(r.bySession, {})
  assert.deepEqual(r.ambiguous, ['alpha'])
})
await ok('groupTints: a group of another kind contributes nothing', () => {
  const groups = [{ id: 'g1', slot: 1, kind: 'tmux-group', name: 'not together', color: '#e0973c', members: [{ id: 's1', name: 'alpha' }] }]
  const sessions = [{ id: 's1', name: 'alpha' }]
  const r = MCZM.groupTints(groups, sessions)
  assert.deepEqual(r.bySession, {})
  assert.deepEqual(r.ambiguous, [])
})
await ok('groupTints: when a session is in two together groups, the LOWER slot wins', () => {
  const groups = [
    { id: 'high', slot: 5, kind: 'together', name: 'later slot', color: '#a8213f', members: [{ id: 's1', name: 'alpha' }] },
    { id: 'low', slot: 2, kind: 'together', name: 'earlier slot', color: '#45c9a0', members: [{ id: 's1', name: 'alpha' }] },
  ]
  const sessions = [{ id: 's1', name: 'alpha' }]
  const r = MCZM.groupTints(groups, sessions)
  assert.equal(r.bySession.s1.id, 'low')
})

// ---- tmuxRows -------------------------------------------------------------------
await ok('tmuxRows: a pane whose target the withSessionIds fold already claimed is onBoard via sessionId', () => {
  const panes = [{ target: 'main:@4.%12', session: 'main', window: '@4', pane: '%12', windowName: 'work', command: 'vim', path: '/work', sessionId: 'szg-1' }]
  const rows = MCZM.tmuxRows(panes, [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].onBoard, true)
  assert.deepEqual(rows[0], { target: 'main:@4.%12', pane: '%12', label: 'work · vim', session: 'main', onBoard: true })
})
await ok('tmuxRows: a pane matched only by the %N tail of a session\'s tmux string is onBoard too', () => {
  const panes = [{ target: 'main:@4.%12', session: 'main', window: '@4', pane: '%12', windowName: 'work', command: 'vim', path: '/work', sessionId: null }]
  const sessions = [{ id: 's1', name: 'alpha', tmux: 'main:@4.%12' }]
  const rows = MCZM.tmuxRows(panes, sessions)
  assert.equal(rows[0].onBoard, true)
})
await ok('tmuxRows: an absent or empty tmux field never matches -- \'\' does not match \'\'', () => {
  const panes = [{ target: 'main:@4.%12', session: 'main', window: '@4', pane: '%12', windowName: 'work', command: 'vim', path: '/work', sessionId: null }]
  const sessions = [{ id: 's1', name: 'alpha', tmux: '' }, { id: 's2', name: 'beta' }]
  const rows = MCZM.tmuxRows(panes, sessions)
  assert.equal(rows[0].onBoard, false)
})
await ok('tmuxRows: rows are grouped by tmux session name, then by input order', () => {
  const panes = [
    { target: 'zed:@1.%1', session: 'zed', window: '@1', pane: '%1', windowName: 'w1', command: 'a', path: '/x', sessionId: null },
    { target: 'main:@2.%2', session: 'main', window: '@2', pane: '%2', windowName: 'w2', command: 'b', path: '/x', sessionId: null },
    { target: 'main:@3.%3', session: 'main', window: '@3', pane: '%3', windowName: 'w3', command: 'c', path: '/x', sessionId: null },
  ]
  const rows = MCZM.tmuxRows(panes, [])
  assert.deepEqual(rows.map((r) => r.pane), ['%2', '%3', '%1'])
})
await ok('tmuxRows: the label is windowName · command, cut to 40 columns', () => {
  const panes = [{ target: 'main:@1.%1', session: 'main', window: '@1', pane: '%1', windowName: 'a'.repeat(60), command: 'vim', path: '/x', sessionId: null }]
  const rows = MCZM.tmuxRows(panes, [])
  assert.equal(rows[0].label.length, 40)
})

// ---- applyBody --------------------------------------------------------------------
await ok('applyBody: a prompt group takes only session refs, skipping every pane ref', () => {
  const group = { id: 'g1', kind: 'prompt' }
  const carried = [{ kind: 'session', id: 's1' }, { kind: 'pane', target: 'main:@1.%1' }]
  const r = MCZM.applyBody(group, carried, [])
  assert.deepEqual(r.targetIds, ['s1'])
  assert.equal(r.panes.length, 0)
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].why, 'not a session this relay steers')
  assert.equal(r.skipped[0].ref.kind, 'pane')
})
await ok('applyBody: a files group behaves the same as prompt', () => {
  const group = { id: 'g1', kind: 'files' }
  const carried = [{ kind: 'pane', target: 'main:@1.%1' }]
  const r = MCZM.applyBody(group, carried, [])
  assert.deepEqual(r.targetIds, [])
  assert.equal(r.skipped[0].why, 'not a session this relay steers')
})
await ok('applyBody: a tmux-group returns pane refs\' own panes AND the %N from session refs\' tmux fields', () => {
  const group = { id: 'g1', kind: 'tmux-group' }
  const carried = [{ kind: 'pane', target: 'main:@1.%1', pane: '%1' }, { kind: 'session', id: 's1' }]
  const sessions = [{ id: 's1', name: 'alpha', tmux: 'main:@2.%2' }]
  const r = MCZM.applyBody(group, carried, sessions)
  assert.deepEqual(r.targetIds, [])
  assert.deepEqual(r.panes.sort(), ['%1', '%2'])
  assert.equal(r.skipped.length, 0)
})
await ok('applyBody: a tmux-group session ref with no tmux is skipped, naming it', () => {
  const group = { id: 'g1', kind: 'tmux-group' }
  const carried = [{ kind: 'session', id: 's1' }]
  const sessions = [{ id: 's1', name: 'alpha', tmux: '' }]
  const r = MCZM.applyBody(group, carried, sessions)
  assert.equal(r.panes.length, 0)
  assert.equal(r.skipped.length, 1)
  assert.match(r.skipped[0].why, /alpha/)
  assert.match(r.skipped[0].why, /no tmux pane/)
})
await ok('applyBody: a tmux-group session ref not found at all is still skipped, naming the id', () => {
  const group = { id: 'g1', kind: 'tmux-group' }
  const carried = [{ kind: 'session', id: 'ghost' }]
  const r = MCZM.applyBody(group, carried, [])
  assert.equal(r.skipped.length, 1)
  assert.match(r.skipped[0].why, /ghost/)
})
await ok('applyBody: a tmux-group dedupes when two refs resolve to the same pane', () => {
  const group = { id: 'g1', kind: 'tmux-group' }
  const carried = [{ kind: 'pane', target: 'main:@1.%1', pane: '%1' }, { kind: 'session', id: 's1' }]
  const sessions = [{ id: 's1', name: 'alpha', tmux: 'main:@1.%1' }]
  const r = MCZM.applyBody(group, carried, sessions)
  assert.deepEqual(r.panes, ['%1'])
})
await ok('applyBody: a together group returns members and no panes', () => {
  const group = { id: 'g1', kind: 'together' }
  const carried = [{ kind: 'session', id: 's1' }, { kind: 'pane', target: 'main:@1.%1' }]
  const r = MCZM.applyBody(group, carried, [])
  assert.deepEqual(r.targetIds, ['s1'])
  assert.equal(r.panes.length, 0)
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].why, 'not a session this relay steers')
})
await ok('applyBody: sessions defaults to an empty list when omitted', () => {
  const group = { id: 'g1', kind: 'tmux-group' }
  assert.doesNotThrow(() => MCZM.applyBody(group, [{ kind: 'session', id: 's1' }]))
})

// ---- modeLine ---------------------------------------------------------------------
await ok('modeLine: idle with nothing carried says nothing at all', () => {
  const s = MCZM.modeLine({ mode: '', carried: [] })
  assert.equal(s, '')
})
await ok('modeLine: MAGNET with nothing carried names the collect gesture', () => {
  const s = MCZM.modeLine({ mode: 'magnet', carried: [] })
  assert.equal(typeof s, 'string')
  assert.doesNotMatch(s, /</)
  assert.match(s, /collect/)
})
await ok('modeLine: carrying N, in or out of MAGNET, names the count and every real verb', () => {
  const carried = [{ kind: 'session', id: 's1' }, { kind: 'session', id: 's2' }]
  for (const mode of ['', 'magnet']) {
    const s = MCZM.modeLine({ mode, carried })
    assert.match(s, /^2 carried/, mode)
    assert.match(s, /bucket/, mode)
    assert.match(s, /Esc/, mode)
    assert.match(s, /release/, mode)
  }
})
await ok('modeLine: BUCKET with nothing aimed names the real digits and Esc, not a bucket', () => {
  const s = MCZM.modeLine({ mode: 'bucket', carried: [], aimed: null })
  assert.match(s, /1-8/)
  assert.match(s, /Esc/)
})
await ok('modeLine: aimed at a configured bucket names it, its kind, and what applying does', () => {
  const s = MCZM.modeLine({ mode: 'bucket', carried: [], aimed: 3, groups: [{ slot: 3, name: 'send a prompt', kind: 'prompt' }] })
  assert.match(s, /send a prompt/)
  assert.match(s, /prompt/)
  assert.match(s, /sessions/)
})
await ok('modeLine: aimed at every kind describes what applying it actually does', () => {
  const does = (kind) => MCZM.modeLine({
    mode: 'bucket', carried: [], aimed: 1, groups: [{ slot: 1, name: 'x', kind }],
  })
  assert.match(does('tmux-group'), /tmux window/)
  assert.match(does('prompt'), /sends its prompt/)
  assert.match(does('files'), /names its paths/)
  assert.match(does('together'), /saves this grouping/)
})
await ok('modeLine: aimed at an empty slot says so and names the real verb that opens its editor', () => {
  const s = MCZM.modeLine({ mode: 'bucket', carried: [], aimed: 3 })
  assert.match(s, /3/)
  assert.match(s, /empty/)
  assert.match(s, /Enter/)
})
await ok('modeLine: aiming a bucket outranks carrying something, which outranks a bare Option hold', () => {
  const aiming = MCZM.modeLine({
    mode: 'bucket', carried: [{ kind: 'session', id: 'a' }], aimed: 1, groups: [{ slot: 1, name: 'x', kind: 'prompt' }],
  })
  assert.match(aiming, /^x/)
  const carrying = MCZM.modeLine({ mode: 'magnet', carried: [{ kind: 'session', id: 'a' }] })
  assert.match(carrying, /^1 carried/)
})
await ok('modeLine: every scenario is textually distinct, and none carries markup', () => {
  const lines = [
    MCZM.modeLine({ mode: '', carried: [] }),
    MCZM.modeLine({ mode: 'magnet', carried: [] }),
    MCZM.modeLine({ mode: '', carried: [{ kind: 'session', id: 's1' }] }),
    MCZM.modeLine({ mode: 'bucket', carried: [], aimed: null }),
    MCZM.modeLine({ mode: 'bucket', carried: [], aimed: 2 }),
    MCZM.modeLine({ mode: 'bucket', carried: [], aimed: 1, groups: [{ slot: 1, name: 'x', kind: 'prompt' }] }),
  ]
  assert.equal(new Set(lines).size, lines.length)
  for (const s of lines) assert.doesNotMatch(s, /</)
})
await ok('modeLine: never throws on a state with missing keys, or on undefined', () => {
  assert.doesNotThrow(() => MCZM.modeLine({}))
  assert.doesNotThrow(() => MCZM.modeLine(undefined))
  assert.doesNotThrow(() => MCZM.modeLine({ mode: 'bucket' }))
  assert.doesNotThrow(() => MCZM.modeLine({ mode: 'nonsense', carried: 'not-an-array' }))
})

// ---- the space-cards component (bridge/public/session-space.js) ----------------
// The component wraps the stage's own session-card entry. The stage and the
// base are stubbed; MCZM and MCX are the real modules. A fake card's element
// throws the moment anything assigns its className.
console.log('\n=== session-space (the space-cards component) ===')

const SPACE_SRC = join(ROOT, 'syzygy', 'bridge', 'public', 'session-space.js')
const RECONCILE_SRC = join(ROOT, 'syzygy', 'bridge', 'public', 'reconcile.js')
const MCX = new Function('window', readFileSync(RECONCILE_SRC, 'utf8') + '\nreturn MCX')({})
const loadSpace = (win) =>
  new Function('window', 'MCZM', 'MCX', readFileSync(SPACE_SRC, 'utf8') + '\nreturn MCZ')(win, MCZM, MCX)

const fakeEl = () => {
  const attrs = new Map()
  const classes = new Set()
  const props = new Map()
  const writes = []
  const el = {
    attrs, classes, props, writes,
    getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
    setAttribute: (n, v) => { writes.push(['attr', n, String(v)]); attrs.set(n, String(v)) },
    removeAttribute: (n) => { writes.push(['rmattr', n]); attrs.delete(n) },
    classList: {
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); return !!on },
      contains: (c) => classes.has(c),
    },
    style: {
      setProperty: (n, v) => { writes.push(['prop', n, v]); props.set(n, v) },
      removeProperty: (n) => { writes.push(['rmprop', n]); props.delete(n) },
    },
  }
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: () => { throw new Error('className assigned on a stage card') },
  })
  return el
}

// A body that records every retarget, in the stage-wide call log too.
const fakeBody = (log, id, x, y) => ({
  tx: x, ty: y, calls: [],
  to(nx, ny) { this.calls.push([nx, ny]); log.push(`to:${id}`); this.tx = nx; this.ty = ny },
})

// Lays cards out the way the stage does in the one respect that matters here:
// sorted by id, one slot per index, and every body retargeted only when the id
// set changed.
const SLOT = 100
const makeBase = (log) => ({
  mount(ctx) {
    log.push('base.mount')
    const s = ctx.state
    s.cards = new Map()
    s.order = []
    s.k = 1
    s.baseKeys = null
    s.baseKeys = Object.keys(s)
  },
  update(ctx, params, data) {
    log.push('base.update')
    const s = ctx.state
    const ids = (Array.isArray(data) ? data : []).map((x) => String(x.id)).sort()
    for (const id of [...s.cards.keys()]) if (!ids.includes(id)) s.cards.delete(id)
    const moved = ids.join('\n') !== s.order.join('\n')
    ids.forEach((id, i) => {
      if (!s.cards.has(id)) {
        s.cards.set(id, { id, el: fakeEl(), body: fakeBody(log, id, i * SLOT, 0), obj: { position: { z: 0 } }, placed: true })
      }
      else if (moved) s.cards.get(id).body.to(i * SLOT, 0)
    })
    s.order = ids
    // Stands in for the base's own layoutCards: a made-up reach that grows
    // with the card count, so sizeStage has something real to read.
    s.extY = ids.length ? 40 + ids.length * 10 : 0
  },
  frame() { log.push('base.frame') },
  unmount() { log.push('base.unmount') },
  openFlyOut() {},
  closeFlyOut() {},
})

// register calls the factory once and refuses a taken name or an entry
// missing any of the four hooks, exactly as the stage's does.
const makeStage = (base) => {
  const table = new Map()
  let factoryCalls = 0
  if (base) table.set('session-card', base)
  return {
    table,
    get factoryCalls() { return factoryCalls },
    register(name, factory) {
      if (typeof name !== 'string' || name === '' || table.has(name)) return false
      if (typeof factory !== 'function') return false
      factoryCalls++
      const entry = factory()
      for (const h of ['mount', 'update', 'frame', 'unmount']) if (typeof entry?.[h] !== 'function') return false
      table.set(name, entry)
      return true
    },
    component(name) { return table.get(name) ?? null },
  }
}

const RECT = { left: 100, top: 50, width: 800, height: 600 }
const makeCtx = () => {
  const listeners = new Map()
  return {
    state: {},
    listeners,
    node: {
      addEventListener: (t, f) => listeners.set(t, f),
      removeEventListener: (t, f) => { if (listeners.get(t) === f) listeners.delete(t) },
      getBoundingClientRect: () => RECT,
      style: {},
    },
  }
}

// One mounted space-cards component over the real wrapper.
const rig = (sessions) => {
  const log = []
  const base = makeBase(log)
  const stage = makeStage(base)
  const MCZ = loadSpace({ MCGS: stage })
  assert.equal(MCZ.derive(), true)
  const comp = stage.component('space-cards')
  const ctx = makeCtx()
  comp.mount(ctx)
  const data = sessions.map((id) => ({ id }))
  comp.update(ctx, {}, data)
  return { log, base, stage, comp, ctx, data, card: (id) => ctx.state.cards.get(id) }
}
const S = (id) => ({ kind: 'session', id })
const F = (id) => ({ kind: 'session', id, follow: true })
const held =(...refs) => ({ szgHeld: refs, szgTints: { bySession: {} } })

await ok('space: evaluating the script runs nothing and exposes derive', () => {
  const touched = []
  const win = new Proxy({}, { get: (t, k) => { touched.push(k); return undefined } })
  const MCZ = loadSpace(win)
  assert.deepEqual(touched, [], 'nothing reads window at evaluation time')
  assert.equal(typeof MCZ.derive, 'function')
})
await ok('space: derive answers false with no stage, or with no session-card entry to wrap', () => {
  assert.equal(loadSpace({}).derive(), false)
  assert.equal(loadSpace({ MCGS: makeStage(null) }).derive(), false)
})
await ok('space: derive registers space-cards through the factory, carrying all four hooks and the base extras', () => {
  const log = []
  const stage = makeStage(makeBase(log))
  const MCZ = loadSpace({ MCGS: stage })
  assert.equal(MCZ.derive(), true)
  const entry = stage.component('space-cards')
  assert.ok(entry)
  for (const h of ['mount', 'update', 'frame', 'unmount']) assert.equal(typeof entry[h], 'function', h)
  assert.equal(typeof entry.openFlyOut, 'function')
  assert.equal(typeof entry.closeFlyOut, 'function')
  assert.equal(stage.factoryCalls, 1)
  assert.equal(MCZ.derive(), true, 'a second derive finds the component already there')
  assert.equal(stage.factoryCalls, 1, 'and does not build it again')
})
await ok('space: mount calls the base first and adds only szg-prefixed keys', () => {
  const log = []
  const stage = makeStage(makeBase(log))
  loadSpace({ MCGS: stage }).derive()
  const ctx = makeCtx()
  stage.component('space-cards').mount(ctx)
  assert.deepEqual(log, ['base.mount'])
  const added = Object.keys(ctx.state).filter((k) => !ctx.state.baseKeys.includes(k)).sort()
  assert.deepEqual(added, ['szgGroupOf', 'szgHeld', 'szgHome', 'szgLeave', 'szgMove', 'szgPointer', 'szgSeen', 'szgTints'])
  for (const k of added) assert.match(k, /^szg/)
  assert.equal(ctx.listeners.get('pointermove'), ctx.state.szgMove)
  assert.equal(ctx.listeners.get('pointerleave'), ctx.state.szgLeave)
})
await ok('space: update grows the mount node\'s own height to the layout\'s reach, and shrinks it back down with the grid', () => {
  const r = rig(['a', 'b', 'c'])
  assert.equal(r.ctx.node.style.height, MCZM.layoutHeight(r.ctx.state.extY) + 'px')
  const fewer = [{ id: 'a' }]
  r.comp.update(r.ctx, held(), fewer)
  assert.equal(r.ctx.node.style.height, MCZM.layoutHeight(r.ctx.state.extY) + 'px')
  const more = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]
  r.comp.update(r.ctx, held(), more)
  const grown = r.ctx.node.style.height
  r.comp.update(r.ctx, held(), fewer)
  assert.ok(parseInt(grown, 10) > parseInt(r.ctx.node.style.height, 10), 'a bigger grid asked for more height than a smaller one')
})
await ok('space: update writes data-space-id on every card, and carried plus a home on the held one only', () => {
  const r = rig(['a', 'b', 'c'])
  r.comp.update(r.ctx, held(S('b'), { kind: 'pane', target: 'main:@1.%1', pane: '%1' }), r.data)
  for (const id of ['a', 'b', 'c']) assert.equal(r.card(id).el.getAttribute('data-space-id'), id)
  assert.equal(r.card('b').el.classes.has('carried'), true)
  assert.equal(r.card('a').el.classes.has('carried'), false)
  assert.equal(r.card('c').el.classes.has('carried'), false)
  assert.deepEqual(r.ctx.state.szgHome.get('b'), { x: SLOT, y: 0 })
  assert.equal(r.ctx.state.szgHome.size, 1, 'a pane ref is never a card and records no home')
  const idWrites = r.card('a').el.writes.filter((w) => w[1] === 'data-space-id').length
  r.comp.update(r.ctx, held(S('b')), r.data)
  assert.equal(r.card('a').el.writes.filter((w) => w[1] === 'data-space-id').length, idWrites, 'written once')
})
await ok('space: a held ref with no card yet is kept, and gets its home when its card arrives', () => {
  const r = rig(['a'])
  r.comp.update(r.ctx, held(S('late')), r.data)
  assert.equal(r.ctx.state.szgHome.has('late'), false)
  assert.deepEqual(r.ctx.state.szgHeld, [S('late')])
  const data = [{ id: 'a' }, { id: 'late' }]
  r.comp.update(r.ctx, held(S('late')), data)
  assert.deepEqual(r.ctx.state.szgHome.get('late'), { x: SLOT, y: 0 })
  assert.equal(r.card('late').el.classes.has('carried'), true)
})
await ok('space: frame runs the base frame BEFORE retargeting, to toLayout\'s answer for the pointer', () => {
  const r = rig(['a', 'b'])
  r.comp.update(r.ctx, held(F('b')), r.data)
  r.ctx.listeners.get('pointermove')({ clientX: 640, clientY: 420 })
  r.log.length = 0
  r.comp.frame(r.ctx, 1, 0.016)
  assert.deepEqual(r.log, ['base.frame', 'to:b'])
  const want = MCZM.toLayout({ x: 640, y: 420 }, RECT, r.ctx.state.k)
  assert.deepEqual(r.card('b').body.calls.at(-1), [want.x, want.y])
  assert.equal(r.card('a').body.calls.length, 0, 'an uncarried card is never retargeted')
  assert.equal(r.card('b').obj.position.z, 0, 'pick-up order zero has no depth')
})
await ok('space: a second following card sits deeper than the first, and neither\'s depth is ever reset by the base', () => {
  const r = rig(['a', 'b'])
  r.comp.update(r.ctx, held(F('a'), F('b')), r.data)
  r.ctx.listeners.get('pointermove')({ clientX: 640, clientY: 420 })
  r.comp.frame(r.ctx, 1, 0.016)
  assert.equal(r.card('a').obj.position.z, 0)
  assert.ok(r.card('b').obj.position.z < 0, 'the second pick-up is deeper')
})
await ok('space: releasing a following card resets its depth to 0, since the base never touches z', () => {
  const r = rig(['a', 'b'])
  r.comp.update(r.ctx, held(F('a'), F('b')), r.data)
  r.ctx.listeners.get('pointermove')({ clientX: 640, clientY: 420 })
  r.comp.frame(r.ctx, 1, 0.016)
  assert.ok(r.card('b').obj.position.z < 0)
  r.comp.update(r.ctx, held(), r.data)
  assert.equal(r.card('b').obj.position.z, 0)
  assert.equal(r.card('a').obj.position.z, 0)
})
await ok('space: the magnet uses the base\'s projection scale, and stands still with no pointer', () => {
  const r = rig(['a'])
  r.comp.update(r.ctx, held(F('a')), r.data)
  r.ctx.state.k = 0.5
  r.ctx.listeners.get('pointermove')({ clientX: 540, clientY: 380 })
  r.comp.frame(r.ctx, 1, 0.016)
  const want = MCZM.toLayout({ x: 540, y: 380 }, RECT, 0.5)
  assert.deepEqual(r.card('a').body.calls.at(-1), [want.x, want.y])
  r.ctx.listeners.get('pointerleave')({})
  assert.equal(r.ctx.state.szgPointer, null)
  const n = r.card('a').body.calls.length
  r.comp.frame(r.ctx, 2, 0.016)
  assert.equal(r.card('a').body.calls.length, n)
})
await ok('space: releasing a card sends it to its recorded home and clears carried', () => {
  const r = rig(['a', 'b'])
  r.comp.update(r.ctx, held(F('b')), r.data)
  r.ctx.listeners.get('pointermove')({ clientX: 640, clientY: 420 })
  r.comp.frame(r.ctx, 1, 0.016)
  r.comp.update(r.ctx, held(), r.data)
  assert.deepEqual(r.card('b').body.calls.at(-1), [SLOT, 0])
  assert.equal(r.card('b').el.classes.has('carried'), false)
  assert.equal(r.ctx.state.szgHome.has('b'), false)
})
await ok('space: a relayout moves a held card\'s home to its new slot; a plain update does not', () => {
  const r = rig(['a', 'c'])
  r.comp.update(r.ctx, held(F('c')), r.data)
  assert.deepEqual(r.ctx.state.szgHome.get('c'), { x: SLOT, y: 0 })
  r.ctx.listeners.get('pointermove')({ clientX: 640, clientY: 420 })
  r.comp.frame(r.ctx, 1, 0.016)
  r.comp.update(r.ctx, held(F('c')), r.data)
  assert.deepEqual(r.ctx.state.szgHome.get('c'), { x: SLOT, y: 0 }, 'the magnet\'s target is not a home')
  const data = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  r.comp.update(r.ctx, held(F('c')), data)
  assert.deepEqual(r.ctx.state.szgHome.get('c'), { x: 2 * SLOT, y: 0 })
  r.comp.update(r.ctx, held(), data)
  assert.deepEqual(r.card('c').body.calls.at(-1), [2 * SLOT, 0])
})
await ok('space: tints paint data-space-group and --szg-grp, only on change, and clear when gone', () => {
  const r = rig(['a', 'b'])
  const tint = { id: 'g1', name: 'the pair', color: '#e0973c' }
  r.comp.update(r.ctx, { szgHeld: [], szgTints: { bySession: { a: tint } } }, r.data)
  assert.equal(r.card('a').el.getAttribute('data-space-group'), 'g1')
  assert.equal(r.card('a').el.props.get('--szg-grp'), '#e0973c')
  assert.equal(r.card('b').el.getAttribute('data-space-group'), null)
  assert.equal(r.card('b').el.props.has('--szg-grp'), false)
  const before = r.card('a').el.writes.length
  const beforeB = r.card('b').el.writes.length
  r.comp.update(r.ctx, { szgHeld: [], szgTints: { bySession: { a: { ...tint } } } }, r.data)
  assert.equal(r.card('a').el.writes.length, before, 'an unchanged tint writes nothing')
  assert.equal(r.card('b').el.writes.length, beforeB, 'an untinted card stays unwritten')
  r.comp.update(r.ctx, { szgHeld: [] }, r.data)
  assert.equal(r.card('a').el.getAttribute('data-space-group'), null)
  assert.equal(r.card('a').el.props.has('--szg-grp'), false)
})
await ok('space: a card carried without follow is ringed and homed but never retargeted by the magnet', () => {
  const r = rig(['a', 'b'])
  r.comp.update(r.ctx, held(S('b')), r.data)
  assert.equal(r.card('b').el.classes.has('carried'), true)
  assert.deepEqual(r.ctx.state.szgHome.get('b'), { x: SLOT, y: 0 })
  r.ctx.listeners.get('pointermove')({ clientX: 640, clientY: 420 })
  r.log.length = 0
  r.comp.frame(r.ctx, 1, 0.016)
  assert.deepEqual(r.log, ['base.frame'], 'it keeps its slot and its float')
  assert.equal(r.card('b').body.calls.length, 0)
})
await ok('space: a swept card and a click-added card in one set -- only the swept one follows, first in the fan', () => {
  const r = rig(['a', 'b'])
  r.comp.update(r.ctx, held(S('a'), F('b')), r.data)
  r.ctx.listeners.get('pointermove')({ clientX: 640, clientY: 420 })
  r.comp.frame(r.ctx, 1, 0.016)
  const want = MCZM.toLayout({ x: 640, y: 420 }, RECT, r.ctx.state.k)
  assert.deepEqual(r.card('b').body.calls.at(-1), [want.x, want.y])
  assert.equal(r.card('a').body.calls.length, 0)
  assert.equal(r.card('a').el.classes.has('carried'), true)
})
await ok('space: a swept card keeps following after Option comes up', () => {
  let st = MCZM.nextState({ mode: '', carried: [], aimed: null, editing: null }, { type: 'alt-down' })
  st = MCZM.nextState(st, { type: 'hover-card', ref: S('a') })
  st = MCZM.nextState(st, { type: 'alt-up' })
  assert.equal(st.mode, '')
  const r = rig(['a'])
  r.comp.update(r.ctx, held(...st.carried), r.data)
  r.ctx.listeners.get('pointermove')({ clientX: 640, clientY: 420 })
  r.comp.frame(r.ctx, 1, 0.016)
  const want = MCZM.toLayout({ x: 640, y: 420 }, RECT, r.ctx.state.k)
  assert.deepEqual(r.card('a').body.calls.at(-1), [want.x, want.y])
})
await ok('space: nothing assigns className, whatever update, frame and release do', () => {
  const r = rig(['a', 'b'])
  assert.doesNotThrow(() => {
    r.comp.update(r.ctx, { szgHeld: [S('a')], szgTints: { bySession: { b: { id: 'g', name: 'g', color: '#fff' } } } }, r.data)
    r.ctx.listeners.get('pointermove')({ clientX: 500, clientY: 300 })
    r.comp.frame(r.ctx, 1, 0.016)
    r.comp.update(r.ctx, { szgHeld: [], szgTints: { bySession: {} } }, r.data)
  })
})
await ok('space: unmount removes both listeners and then runs the base\'s unmount', () => {
  const r = rig(['a'])
  r.log.length = 0
  r.comp.unmount(r.ctx)
  assert.equal(r.ctx.listeners.size, 0)
  assert.deepEqual(r.log, ['base.unmount'])
})

// ---- nextState: the two modes and every gesture ---------------------------------
// The reducer the view's key layer and pointer handlers feed. The DOM half --
// hit-testing, the editor's fields -- is not here; every transition is.
console.log('\n=== session-space-math (the modes and gestures) ===')

const ST = (over = {}) => ({ mode: '', carried: [], aimed: null, editing: null, ...over })
const SREF = (id) => ({ kind: 'session', id })
const PREF = (target, pane) => ({ kind: 'pane', target, pane })
const FREF = (id) => ({ kind: 'session', id, follow: true })
const KEY = (key, over = {}) => ({ type: 'key', key, ...over })
const next = (s, e) => MCZM.nextState(s, e)

await ok('nextState: alt down enters MAGNET, alt up leaves it and keeps the carried set', () => {
  let s = next(ST(), { type: 'alt-down' })
  assert.equal(s.mode, 'magnet')
  assert.equal(s.consumed, false, 'Option is observed, never swallowed')
  s = next(s, { type: 'hover-card', ref: SREF('a') })
  s = next(s, { type: 'alt-up' })
  assert.equal(s.mode, '')
  assert.deepEqual(s.carried, [FREF('a')])
  assert.equal(s.consumed, false)
})
await ok('nextState: alt down while typing, in BUCKET mode or with the editor open does not enter MAGNET', () => {
  assert.equal(next(ST(), { type: 'alt-down', typing: true }).mode, '')
  assert.equal(next(ST({ mode: 'bucket' }), { type: 'alt-down' }).mode, 'bucket')
  assert.equal(next(ST({ editing: 2 }), { type: 'alt-down' }).mode, '')
})
await ok('nextState: leave-magnet (blur, visibilitychange) leaves MAGNET and keeps the set; BUCKET is untouched', () => {
  const s = next(ST({ mode: 'magnet', carried: [SREF('a'), SREF('b')] }), { type: 'leave-magnet' })
  assert.equal(s.mode, '')
  assert.deepEqual(s.carried, [SREF('a'), SREF('b')])
  assert.equal(next(ST({ mode: 'bucket', aimed: 3 }), { type: 'leave-magnet' }).mode, 'bucket')
  assert.equal(next(ST({ mode: 'bucket', aimed: 3 }), { type: 'alt-up' }).aimed, 3)
})
await ok('nextState: a sweep in MAGNET adds a card once, and a second card as well', () => {
  let s = next(ST({ mode: 'magnet' }), { type: 'hover-card', ref: SREF('a') })
  assert.deepEqual(s.carried, [FREF('a')])
  s = next(s, { type: 'hover-card', ref: SREF('a') })
  assert.deepEqual(s.carried, [FREF('a')], 'sweeping the same card again does not duplicate it')
  s = next(s, { type: 'hover-card', ref: SREF('b') })
  assert.deepEqual(s.carried, [FREF('a'), FREF('b')])
})
await ok('nextState: a hover outside MAGNET carries nothing, and a pane ref is never swept', () => {
  assert.deepEqual(next(ST(), { type: 'hover-card', ref: SREF('a') }).carried, [])
  assert.deepEqual(next(ST({ mode: 'bucket' }), { type: 'hover-card', ref: SREF('a') }).carried, [])
  assert.deepEqual(next(ST({ mode: 'magnet' }), { type: 'hover-card', ref: PREF('w:@1.%2', '%2') }).carried, [])
})
await ok('nextState: bare b enters BUCKET only with no field focused and no modifier held', () => {
  const s = next(ST(), KEY('b'))
  assert.equal(s.mode, 'bucket')
  assert.equal(s.consumed, true)
  for (const over of [{ typing: true }, { shift: true }, { alt: true }, { meta: true }, { ctrl: true }]) {
    const t = next(ST(), KEY('b', over))
    assert.equal(t.mode, '', JSON.stringify(over))
    assert.equal(t.consumed, false, JSON.stringify(over))
  }
  assert.equal(next(ST(), KEY('B')).mode, '')
  assert.equal(next(ST({ editing: 1 }), KEY('b')).mode, '')
})
await ok('nextState: b inside BUCKET leaves the mode and clears the aim', () => {
  const s = next(ST({ mode: 'bucket', aimed: 2 }), KEY('b'))
  assert.equal(s.mode, '')
  assert.equal(s.aimed, null)
  assert.equal(s.consumed, true)
})
await ok('nextState: in BUCKET a digit aims and is consumed, so it never switches tabs; 9 and 0 aim nothing', () => {
  let s = next(ST({ mode: 'bucket' }), KEY('3'))
  assert.equal(s.aimed, 3)
  assert.equal(s.consumed, true)
  assert.deepEqual(s.effects, [], 'an aim sends nothing')
  s = next(s, KEY('7'))
  assert.equal(s.aimed, 7)
  assert.equal(s.consumed, true, 'the digit that is this tab still aims rather than switching')
  for (const k of ['9', '0']) {
    const t = next(s, KEY(k))
    assert.equal(t.aimed, 7, k)
    assert.equal(t.consumed, true, k)
  }
  const typed = next(ST({ mode: 'bucket' }), KEY('3', { typing: true }))
  assert.equal(typed.aimed, null)
  assert.equal(typed.consumed, false, 'a digit typed in a field is typing')
  assert.equal(next(ST({ mode: 'bucket' }), KEY('3', { meta: true })).consumed, false)
})
await ok('nextState: a digit outside BUCKET is left alone -- it is the tab switch', () => {
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8']) {
    const s = next(ST({ carried: [SREF('a')] }), KEY(k))
    assert.equal(s.consumed, false, k)
    assert.equal(s.aimed, null, k)
    assert.equal(s.mode, '', k)
  }
  assert.equal(next(ST({ mode: 'magnet' }), KEY('2', { alt: true })).consumed, false)
})
await ok('nextState: Enter in BUCKET applies the aimed bucket, opens an unconfigured one\'s editor, and is consumed even unaimed', () => {
  const aimed = ST({ mode: 'bucket', aimed: 2, carried: [SREF('a')] })
  const s = next(aimed, KEY('Enter', { configured: true }))
  assert.deepEqual(s.effects, [{ type: 'apply', slot: 2, all: false }])
  assert.equal(s.consumed, true)
  const e = next(aimed, KEY('Enter', { configured: false }))
  assert.equal(e.editing, 2)
  assert.deepEqual(e.effects, [{ type: 'open-editor', slot: 2 }])
  assert.equal(e.consumed, true)
  const bare = next(ST({ mode: 'bucket' }), KEY('Enter', { configured: true }))
  assert.equal(bare.consumed, true, 'a focused chip must not also be pressed')
  assert.deepEqual(bare.effects, [])
  assert.equal(next(ST({ carried: [SREF('a')] }), KEY('Enter')).consumed, false, 'outside the mode Enter is not ours')
})
await ok('nextState: Esc leaves BUCKET, a second Esc drops the set, and a third passes through', () => {
  let s = next(ST({ mode: 'bucket', carried: [SREF('a')] }), KEY('Escape'))
  assert.equal(s.mode, '')
  assert.deepEqual(s.carried, [SREF('a')])
  assert.equal(s.consumed, true)
  s = next(s, KEY('Escape'))
  assert.deepEqual(s.carried, [])
  assert.equal(s.consumed, true)
  s = next(s, KEY('Escape'))
  assert.equal(s.consumed, false)
})
await ok('nextState: Esc is innermost-first -- editor, aim, BUCKET, fly-out, carried set, then through', () => {
  let s = ST({ mode: 'bucket', aimed: 4, editing: 4, carried: [SREF('a')] })
  s = next(s, KEY('Escape', { flyOut: true }))
  assert.equal(s.editing, null)
  assert.deepEqual(s.effects, [{ type: 'close-editor' }])
  assert.equal(s.aimed, 4)
  assert.equal(s.consumed, true)
  s = next(s, KEY('Escape', { flyOut: true }))
  assert.equal(s.aimed, null)
  assert.equal(s.mode, 'bucket')
  assert.deepEqual(s.effects, [])
  assert.equal(s.consumed, true)
  s = next(s, KEY('Escape', { flyOut: true }))
  assert.equal(s.mode, '')
  assert.deepEqual(s.carried, [SREF('a')])
  assert.equal(s.consumed, true)
  s = next(s, KEY('Escape', { flyOut: true }))
  assert.deepEqual(s.effects, [{ type: 'close-flyout' }])
  assert.deepEqual(s.carried, [SREF('a')], 'the fly-out closes before the set drops')
  assert.equal(s.consumed, true)
  s = next(s, KEY('Escape', { flyOut: false }))
  assert.deepEqual(s.carried, [])
  assert.deepEqual(s.effects, [])
  assert.equal(s.consumed, true)
  s = next(s, KEY('Escape', { flyOut: false }))
  assert.equal(s.consumed, false, 'with nothing of this view open the key belongs to the page')
  assert.deepEqual(s.effects, [])
})
await ok('nextState: the editor\'s Esc closes it from inside its own field; any other Esc in a field passes through', () => {
  const s = next(ST({ editing: 3, carried: [SREF('a')] }), KEY('Escape', { typing: true }))
  assert.equal(s.editing, null)
  assert.equal(s.consumed, true)
  const t = next(ST({ carried: [SREF('a')] }), KEY('Escape', { typing: true }))
  assert.equal(t.consumed, false)
  assert.deepEqual(t.carried, [SREF('a')])
})
await ok('nextState: while the editor is open, bare keys do nothing', () => {
  const s = next(ST({ editing: 2 }), KEY('b'))
  assert.equal(s.mode, '')
  assert.equal(s.consumed, false)
  const t = next(ST({ mode: 'bucket', editing: 2 }), KEY('5'))
  assert.equal(t.aimed, null)
  assert.equal(t.consumed, false)
})
await ok('nextState: shift-click and alt-click on a card both toggle it; a plain click opens the drawer', () => {
  const click = (over) => ({ type: 'click-card', ref: SREF('a'), ...over })
  let s = next(ST(), click({ shift: true }))
  assert.deepEqual(s.carried, [SREF('a')])
  assert.deepEqual(s.effects, [])
  assert.equal(s.consumed, true)
  s = next(s, click({ shift: true }))
  assert.deepEqual(s.carried, [])
  s = next(s, click({ alt: true }))
  assert.deepEqual(s.carried, [SREF('a')])
  s = next(s, click({ alt: true }))
  assert.deepEqual(s.carried, [])
  const plain = next(ST({ carried: [SREF('b')] }), click({}))
  assert.deepEqual(plain.effects, [{ type: 'open-drawer', id: 'a' }])
  assert.deepEqual(plain.carried, [SREF('b')])
  assert.deepEqual(next(ST(), click({ hit: true })).effects, [], 'a control inside the card answers its own click')
  assert.deepEqual(next(ST(), click({ meta: true })).effects, [])
})
await ok('nextState: a plain click on empty stage drops the set; a modified one keeps it', () => {
  const held = ST({ carried: [SREF('a'), SREF('b')] })
  assert.deepEqual(next(held, { type: 'click-stage' }).carried, [])
  assert.deepEqual(next(held, { type: 'click-stage', shift: true }).carried, held.carried)
  assert.deepEqual(next(held, { type: 'click-stage', alt: true }).carried, held.carried)
})
await ok('nextState: a tmux row click toggles its pane; shift-click carries every row of that tmux session', () => {
  const p1 = PREF('w:@1.%1', '%1')
  const p2 = PREF('w:@1.%2', '%2')
  let s = next(ST(), { type: 'click-row', ref: p1 })
  assert.deepEqual(s.carried, [p1])
  s = next(s, { type: 'click-row', ref: p1, alt: true })
  assert.deepEqual(s.carried, [])
  s = next(s, { type: 'click-row', ref: p1, shift: true, refs: [p1, p2] })
  assert.deepEqual(s.carried, [p1, p2])
  s = next(s, { type: 'click-row', ref: p2, shift: true, refs: [p1, p2] })
  assert.deepEqual(s.carried, [p1, p2], 'the whole session is added, never toggled away or duplicated')
})
await ok('nextState: a bucket click applies to the carried set; shift-click applies to every session on the board', () => {
  const held = ST({ carried: [SREF('a')] })
  const s = next(held, { type: 'click-bucket', slot: 1, configured: true })
  assert.deepEqual(s.effects, [{ type: 'apply', slot: 1, all: false }])
  assert.equal(s.editing, null)
  const all = next(held, { type: 'click-bucket', slot: 1, shift: true, configured: true })
  assert.deepEqual(all.effects, [{ type: 'apply', slot: 1, all: true }])
})
await ok('nextState: alt-click, right-click and an unconfigured bucket all open its editor', () => {
  for (const over of [{ alt: true, configured: true }, { right: true, configured: true }, { configured: false }, { shift: true, configured: false }]) {
    const s = next(ST({ carried: [SREF('a')] }), { type: 'click-bucket', slot: 6, ...over })
    assert.equal(s.editing, 6, JSON.stringify(over))
    assert.deepEqual(s.effects, [{ type: 'open-editor', slot: 6 }], JSON.stringify(over))
  }
  assert.deepEqual(next(ST(), { type: 'click-bucket', slot: 9, configured: true }).effects, [], 'no such slot')
})
await ok('nextState: + opens the editor on the slot it names; close-editor closes it through one effect', () => {
  let s = next(ST(), { type: 'add-bucket', slot: 5 })
  assert.equal(s.editing, 5)
  assert.deepEqual(s.effects, [{ type: 'open-editor', slot: 5 }])
  s = next(s, { type: 'close-editor' })
  assert.equal(s.editing, null)
  assert.deepEqual(s.effects, [{ type: 'close-editor' }])
  assert.deepEqual(next(ST(), { type: 'add-bucket', slot: null }).effects, [])
})
await ok('nextState: a successful apply drops the carried set and clears the aim, and BUCKET stays latched', () => {
  const s = next(ST({ mode: 'bucket', aimed: 3, carried: [SREF('a')] }), { type: 'applied' })
  assert.deepEqual(s.carried, [])
  assert.equal(s.aimed, null)
  assert.equal(s.mode, 'bucket')
})
await ok('nextState: effects are fresh on every call, and a malformed state or event never throws', () => {
  const s = next(ST(), { type: 'click-bucket', slot: 2, configured: true })
  s.effects.push({ type: 'stray' })
  assert.deepEqual(next(s, KEY('x')).effects, [])
  assert.doesNotThrow(() => next(null, null))
  const odd = next({ mode: 'nope', carried: 'x', aimed: 'y', editing: {}, swept: 'z' }, { type: 'nope' })
  assert.deepEqual(odd.swept, [])
  assert.equal(odd.mode, '')
  assert.deepEqual(odd.carried, [])
  assert.equal(odd.aimed, null)
  assert.equal(odd.editing, null)
  assert.equal(odd.consumed, false)
})
await ok('nextState: the carried set is never mutated, and a sweep at CARRY_MAX refuses', () => {
  const carried = Object.freeze([SREF('a')])
  const s = next(ST({ mode: 'magnet', carried }), { type: 'hover-card', ref: SREF('b') })
  assert.equal(carried.length, 1)
  assert.deepEqual(s.carried, [SREF('a'), FREF('b')])
  const full = Array.from({ length: MCZM.CARRY_MAX }, (_, i) => SREF('s' + i))
  const t = next(ST({ mode: 'magnet', carried: full }), { type: 'hover-card', ref: SREF('extra') })
  assert.equal(t.carried.length, MCZM.CARRY_MAX)
  assert.deepEqual(t.swept, [], 'a refused sweep picked nothing up')
})
await ok('nextState: the sweep adds a following ref; a modifier-click and a tmux row add refs that stay put', () => {
  assert.deepEqual(next(ST({ mode: 'magnet' }), { type: 'hover-card', ref: SREF('a') }).carried, [FREF('a')])
  assert.deepEqual(next(ST(), { type: 'click-card', ref: SREF('a'), shift: true }).carried, [SREF('a')])
  assert.deepEqual(next(ST(), { type: 'click-card', ref: FREF('a'), alt: true }).carried, [SREF('a')],
    'a click never carries a follow flag in')
  const row = next(ST(), { type: 'click-row', ref: { ...PREF('w:@1.%1', '%1'), follow: true } })
  assert.deepEqual(row.carried, [PREF('w:@1.%1', '%1')])
  const rows = next(ST(), { type: 'click-row', ref: PREF('w:@1.%1', '%1'), shift: true, refs: [{ ...PREF('w:@1.%1', '%1'), follow: true }] })
  assert.deepEqual(rows.carried, [PREF('w:@1.%1', '%1')])
})
await ok('nextState: a swept card keeps its follow flag after alt up and after leave-magnet', () => {
  const s = next(next(ST(), { type: 'alt-down' }), { type: 'hover-card', ref: SREF('a') })
  assert.deepEqual(next(s, { type: 'alt-up' }).carried, [FREF('a')])
  assert.deepEqual(next(s, { type: 'leave-magnet' }).carried, [FREF('a')])
})
await ok('nextState: a sweep over a click-added card upgrades it to follow without counting it as this hold\'s pick-up', () => {
  let s = next(ST({ carried: [SREF('a')] }), { type: 'alt-down' })
  s = next(s, { type: 'hover-card', ref: SREF('a') })
  assert.deepEqual(s.carried, [FREF('a')])
  assert.deepEqual(s.swept, [])
  s = next(s, { type: 'click-card', ref: SREF('a'), alt: true })
  assert.deepEqual(s.carried, [], 'it was carried before the hold, so the click removes it')
})
await ok('nextState: an alt-click on a card this hold swept in leaves it carried, and is consumed', () => {
  let s = next(ST(), { type: 'alt-down' })
  s = next(s, { type: 'hover-card', ref: SREF('a') })
  assert.deepEqual(s.swept, ['a'])
  s = next(s, { type: 'click-card', ref: SREF('a'), alt: true })
  assert.deepEqual(s.carried, [FREF('a')])
  assert.equal(s.consumed, true)
  assert.deepEqual(s.effects, [])
})
await ok('nextState: an alt-click on a card carried before the hold removes it', () => {
  let s = next(ST({ carried: [SREF('a'), SREF('b')] }), { type: 'alt-down' })
  s = next(s, { type: 'hover-card', ref: SREF('c') })
  s = next(s, { type: 'click-card', ref: SREF('b'), alt: true })
  assert.deepEqual(s.carried, [SREF('a'), FREF('c')])
  assert.equal(s.consumed, true)
})
await ok('nextState: a hold\'s swept ids clear when Option goes down again, comes up, or the window loses it', () => {
  const hold = next(next(ST(), { type: 'alt-down' }), { type: 'hover-card', ref: SREF('a') })
  for (const type of ['alt-down', 'alt-up', 'leave-magnet']) assert.deepEqual(next(hold, { type }).swept, [], type)
  let s = next(hold, { type: 'alt-up' })
  s = next(s, { type: 'alt-down' })
  s = next(s, { type: 'click-card', ref: SREF('a'), alt: true })
  assert.deepEqual(s.carried, [], 'a card swept in by an earlier hold toggles like any other')
})
await ok('isConfigured: a prompt needs text, files need paths, tmux and together always apply, nothing is not a bucket', () => {
  assert.equal(MCZM.isConfigured({ kind: 'prompt', text: 'go' }), true)
  assert.equal(MCZM.isConfigured({ kind: 'prompt', text: '' }), false)
  assert.equal(MCZM.isConfigured({ kind: 'prompt', text: '  \n ' }), false)
  assert.equal(MCZM.isConfigured({ kind: 'prompt' }), false)
  assert.equal(MCZM.isConfigured({ kind: 'files', paths: ['/tmp/a'] }), true)
  assert.equal(MCZM.isConfigured({ kind: 'files', paths: [] }), false)
  assert.equal(MCZM.isConfigured({ kind: 'tmux-group', tmuxName: '' }), true)
  assert.equal(MCZM.isConfigured({ kind: 'together', members: [] }), true)
  assert.equal(MCZM.isConfigured(null), false)
  assert.equal(MCZM.isConfigured({ kind: 'mystery' }), false)
})

// ---- layoutHeight ---------------------------------------------------------------
await ok('layoutHeight: no reach (no cards yet) is 0', () => {
  assert.equal(MCZM.layoutHeight(0), 0)
})
await ok('layoutHeight: the full height is twice the reach, rounded up', () => {
  assert.equal(MCZM.layoutHeight(300), 600)
  assert.equal(MCZM.layoutHeight(150.2), 301)
})
await ok('layoutHeight: grows as the reach a bigger grid of cards would report grows, and never shrinks it', () => {
  // Stand-ins for what the base layout's own extY reports for a growing
  // number of cards on a fixed pitch -- monotonic in the card count, so the
  // height this derives from it must be too.
  const reachesForGrowingN = [140, 140, 240, 240, 240, 340, 340, 340, 340]
  let last = 0
  for (const reach of reachesForGrowingN) {
    const h = MCZM.layoutHeight(reach)
    assert.ok(h >= last, `height ${h} fell below the previous ${last}`)
    last = h
  }
})
await ok('layoutHeight: a negative or non-finite reach is 0, never a throw', () => {
  assert.equal(MCZM.layoutHeight(-50), 0)
  assert.equal(MCZM.layoutHeight(NaN), 0)
  assert.equal(MCZM.layoutHeight(Infinity), 0)
  assert.equal(MCZM.layoutHeight(undefined), 0)
  assert.equal(MCZM.layoutHeight(null), 0)
  assert.doesNotThrow(() => MCZM.layoutHeight('not a number'))
})

console.log(`\nsession-space-math harness: ${pass} checks passed`)
