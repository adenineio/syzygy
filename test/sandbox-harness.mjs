#!/usr/bin/env node
// Drives bridge/sandbox.mjs against a temp directory, then its routes against
// a real relay subprocess, then the pane's pure core under a window shim.
// Hermetic: SZG_DATA_DIR points the relay at a temp directory, so nothing
// here touches ~/.claude.
//
// Run: node test/sandbox-harness.mjs   (or `just test-sandbox`)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const {
  createSandbox, readSandbox, sanitizeEntry, nextMark,
  SANDBOX_MAX, MARK_HISTORY_MAX, MARKS, PARAMS_MAX_BYTES,
} = await import(join(ROOT, 'syzygy', 'bridge', 'sandbox.mjs'))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }
const dir = () => mkdtempSync(join(tmpdir(), 'szg-sandbox-'))
const fresh = () => {
  const file = join(dir(), 'sandbox.json')
  return { file, store: createSandbox({ file, now: () => 1_700_000_000_000 }) }
}

console.log('sandbox ledger')

await ok('an unmarked component has no entry until it is marked', async () => {
  const { store } = fresh()
  assert.equal(store.get('session-card'), null)
  assert.deepEqual(store.all(), [])
})

await ok('marking creates the entry and records the history row', async () => {
  const { store } = fresh()
  const r = store.mark('session-card', { mark: 'good' })
  assert.equal(r.ok, true)
  assert.equal(r.entry.component, 'session-card')
  assert.equal(r.entry.mark, 'good')
  assert.deepEqual(r.entry.marks, [{ mark: 'good', at: 1_700_000_000_000 }])
  assert.equal(r.entry.createdAt, 1_700_000_000_000)
})

await ok('the cycle runs none -> good -> near -> potential -> none', async () => {
  assert.equal(nextMark(''), 'good')
  assert.equal(nextMark('good'), 'near')
  assert.equal(nextMark('near'), 'potential')
  assert.equal(nextMark('potential'), '')
  assert.equal(nextMark('nonsense'), 'good')
})

await ok('cycle: true asks the store, not the caller, for the next mark', async () => {
  const { store } = fresh()
  store.mark('session-card', { cycle: true })
  assert.equal(store.get('session-card').mark, 'good')
  store.mark('session-card', { cycle: true })
  assert.equal(store.get('session-card').mark, 'near')
})

await ok('clearing keeps the entry and appends an empty history row', async () => {
  const { store } = fresh()
  store.mark('session-card', { mark: 'good' })
  const r = store.mark('session-card', { mark: '' })
  assert.equal(r.entry.mark, '')
  assert.equal(r.entry.marks.length, 2, 'nothing is ever removed from the history')
  assert.equal(r.entry.marks[1].mark, '')
})

await ok('an unknown mark is refused by name, and nothing is written', async () => {
  const { store } = fresh()
  const r = store.mark('session-card', { mark: 'brilliant' })
  assert.equal(r.ok, false)
  assert.match(r.error, /mark/)
  assert.equal(store.get('session-card'), null)
})

await ok('mark refuses when both a mark and a cycle are asked for, and nothing is written', async () => {
  const { store } = fresh()
  const r = store.mark('session-card', { mark: 'good', cycle: true })
  assert.equal(r.ok, false)
  assert.match(r.error, /mark/)
  assert.match(r.error, /cycle/)
  assert.equal(store.get('session-card'), null)
})

await ok('mark refuses when neither a mark nor a cycle is asked for, and nothing is written', async () => {
  const { store } = fresh()
  const r = store.mark('session-card', {})
  assert.equal(r.ok, false)
  assert.match(r.error, /mark/)
  assert.match(r.error, /cycle/)
  assert.equal(store.get('session-card'), null)
})

await ok('params merge rather than replace', async () => {
  const { store } = fresh()
  store.params('session-card', { hoverFollow: 40 })
  store.params('session-card', { maxTilt: 6 })
  assert.deepEqual(store.get('session-card').params, { hoverFollow: 40, maxTilt: 6 })
})

await ok('params refuses a non-object patch and an oversize merge, and nothing is written either way', async () => {
  const { store } = fresh()
  for (const bad of [null, [], 'nope']) {
    const r = store.params('never-created', bad)
    assert.equal(r.ok, false)
    assert.equal(store.get('never-created'), null)
  }

  store.params('component-x', { small: 1 })
  const before = store.get('component-x').params
  const big = store.params('component-x', { blob: 'x'.repeat(PARAMS_MAX_BYTES) })
  assert.equal(big.ok, false)
  assert.deepEqual(store.get('component-x').params, before)
})

await ok('the history is capped and drops the oldest', async () => {
  const { store } = fresh()
  for (let i = 0; i < MARK_HISTORY_MAX + 5; i++) store.mark('c', { cycle: true })
  assert.equal(store.get('c').marks.length, MARK_HISTORY_MAX)
})

await ok('the store is capped at SANDBOX_MAX entries, oldest first', async () => {
  const { store } = fresh()
  for (let i = 0; i < SANDBOX_MAX + 3; i++) store.mark('c' + i, { mark: 'good' })
  assert.equal(store.all().length, SANDBOX_MAX)
  assert.equal(store.all()[0].component, 'c3')
})

await ok('a write survives a reload byte for byte', async () => {
  const { file, store } = fresh()
  store.mark('session-card', { mark: 'near' })
  store.params('session-card', { maxTilt: 12 })
  const again = createSandbox({ file })
  assert.equal(again.get('session-card').mark, 'near')
  assert.deepEqual(again.get('session-card').params, { maxTilt: 12 })
})

await ok('a garbage entry is dropped on read, not thrown on', async () => {
  const { file } = fresh()
  writeFileSync(file, JSON.stringify({
    version: 1,
    sandbox: [42, { component: 'ok', mark: 'good' }, { mark: 'good' }, null],
  }))
  const items = readSandbox(file)
  assert.equal(items.length, 1)
  assert.equal(items[0].component, 'ok')
  assert.ok(Array.isArray(items[0].marks), 'marks is normalised to an array by the reader')
})

await ok('a file that will not parse is moved aside, never overwritten', async () => {
  const { file, store } = fresh()
  writeFileSync(file, '{ this is not json')
  store.mark('session-card', { mark: 'good' })
  const aside = readdirSync(dirname(file)).filter((n) => n.includes('.corrupt-'))
  assert.equal(aside.length, 1)
  assert.equal(readFileSync(join(dirname(file), aside[0]), 'utf8'), '{ this is not json')
})

await ok('a failed serialize leaves the previous file and the memory intact', async () => {
  const { file, store } = fresh()
  store.mark('session-card', { mark: 'good' })
  const before = readFileSync(file, 'utf8')
  const circular = {}
  circular.self = circular
  assert.throws(() => store.params('session-card', { boom: circular }))
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(store.get('session-card').mark, 'good')
  assert.ok(store.params('session-card', { maxTilt: 3 }).ok, 'the store still works afterwards')
})

await ok('a missing file is the normal first run', async () => {
  const file = join(dir(), 'never-written.json')
  assert.deepEqual(readSandbox(file), [])
  assert.deepEqual(createSandbox({ file }).all(), [])
})

// ---- live relay -------------------------------------------------------------
// A mocked relay cannot prove a route ladder. The gate, the read route and
// the broadcast are all things only a real process does.
{
  const { spawn } = await import('node:child_process')
  const relay = join(ROOT, 'syzygy', 'bridge', 'relay.mjs')
  const PORT = 4600 + Math.floor(Math.random() * 100)
  const TOKEN = 'test-token-' + Math.random().toString(36).slice(2)
  const DATA = mkdtempSync(join(tmpdir(), 'szg-sandbox-relay-'))

  // SZG_DATA_DIR points the child at an isolated directory instead of the
  // real, shared ~/.claude/syzygy. Without it this test loads and flushes the
  // user's own sandbox.json.
  const child = spawn(process.execPath, [relay], {
    env: {
      ...process.env, SZG_PORT: String(PORT), SZG_TOKEN: TOKEN,
      SZG_DATA_DIR: DATA,
      SZG_PANE_PASSWORD_DISABLED: '1',
    },
    stdio: 'ignore',
  })
  const post = async (path, body, headers = { 'x-mch-token': TOKEN }) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}?token=${TOKEN}`)
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  try {
    for (let i = 0; i < 60; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/api/health`); break } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    // A stale orphan relay already listening on this port would answer the
    // health poll above and silently take the traffic below, turning every
    // assertion into a false pass.
    assert.equal(child.exitCode, null, 'relay child died -- port in use?')

    await ok('an unauthenticated POST is refused', async () => {
      const r = await post('/api/sandbox/mark', { component: 'session-card', mark: 'good' }, {})
      assert.equal(r.status, 401)
    })

    await ok('POST /api/sandbox/mark stores and answers the entry', async () => {
      const r = await post('/api/sandbox/mark', { component: 'session-card', mark: 'good' })
      assert.equal(r.status, 200)
      assert.equal(r.body.entry.mark, 'good')
    })

    await ok('cycle: true advances without the caller naming the next mark', async () => {
      const r = await post('/api/sandbox/mark', { component: 'session-card', cycle: true })
      assert.equal(r.body.entry.mark, 'near')
    })

    await ok('an unknown mark is a 400 with the reason', async () => {
      const r = await post('/api/sandbox/mark', { component: 'session-card', mark: 'brilliant' })
      assert.equal(r.status, 400)
      assert.match(r.body.error, /mark/)
    })

    await ok('a missing component is a 400, never a silent no-op', async () => {
      const r = await post('/api/sandbox/mark', { mark: 'good' })
      assert.equal(r.status, 400)
    })

    await ok('naming both a mark and a cycle is a 400, never a guess at which wins', async () => {
      const r = await post('/api/sandbox/mark', { component: 'session-card', mark: 'good', cycle: true })
      assert.equal(r.status, 400)
    })

    await ok('naming neither a mark nor a cycle is a 400', async () => {
      const r = await post('/api/sandbox/mark', { component: 'session-card' })
      assert.equal(r.status, 400)
    })

    await ok('POST /api/sandbox/params merges', async () => {
      await post('/api/sandbox/params', { component: 'session-card', params: { hoverFollow: 40 } })
      const r = await post('/api/sandbox/params', { component: 'session-card', params: { maxTilt: 6 } })
      assert.deepEqual(r.body.entry.params, { hoverFollow: 40, maxTilt: 6 })
    })

    await ok('a non-object params patch is a 400', async () => {
      const r = await post('/api/sandbox/params', { component: 'session-card', params: 'nope' })
      assert.equal(r.status, 400)
    })

    await ok('the ledger rides the snapshot and the read route', async () => {
      const s = await get('/api/state')
      assert.ok(s.body.sandbox.some((e) => e.component === 'session-card'))
      const d = await get('/api/sandbox')
      assert.ok(d.body.sandbox.some((e) => e.component === 'session-card'))
    })

    await ok('the payload version is at least 7', async () => {
      const h = await get('/api/health')
      assert.ok(h.body.payloadVersion >= 7, 'a pane must be able to tell an older relay apart')
    })
  } finally {
    child.kill()
  }
}

// ---- sandbox-math (pure core) -----------------------------------------------
// Loaded the way the pane loads it: a classic script evaluated with a window
// shim, so anything that only works as a module fails here as well.
console.log('\nsandbox-math (pure core)')

const win = {}
const MCGM = new Function('window', readFileSync(
  join(ROOT, 'syzygy', 'bridge', 'public', 'sandbox-math.js'), 'utf8') + '\nreturn MCGM')(win)

// The published gitGraph shape: branches, each with its commits newest first.
const GITGRAPH_FIXTURE = {
  base: 'main',
  builtAt: 1_700_000_000_000,
  truncated: false,
  branches: [
    { name: 'main', head: 'aaaaaaa', isMain: true, ahead: 0, behind: 0, truncated: false,
      commits: [
        { sha: 'a'.repeat(40), parents: ['b'.repeat(40)], subject: 'the tip', at: 1_700_000_000_000 },
        { sha: 'b'.repeat(40), parents: ['c'.repeat(40), 'd'.repeat(40)], subject: 'a merge', at: 1_699_000_000_000 },
      ] },
    { name: 'feat/thing', head: 'eeeeeee', isMain: false, ahead: 3, behind: 1, truncated: false,
      commits: [
        { sha: 'e'.repeat(40), parents: ['f'.repeat(40)], subject: 'third', at: 1_700_100_000_000 },
        { sha: 'f'.repeat(40), parents: ['0'.repeat(40)], subject: 'second', at: 1_700_090_000_000 },
        { sha: '0'.repeat(40), parents: ['a'.repeat(40)], subject: 'first', at: 1_700_080_000_000 },
      ] },
  ],
}

await ok('the registry holds exactly the session card and the worktree graph', async () => {
  assert.deepEqual(MCGM.REGISTRY.map((c) => c.id), ['session-card', 'git-graph'])
  for (const c of MCGM.REGISTRY) {
    assert.equal(typeof c.title, 'string')
    assert.ok(typeof c.blurb === 'string' && c.blurb.length > 0, `${c.id} has a blurb`)
    assert.equal(c.layer, 'both')
    assert.deepEqual(Object.keys(c.defaults).sort(), Object.keys(c.knobs).sort(),
      `${c.id}: every knob has a default and every default a knob`)
    for (const [k, knob] of Object.entries(c.knobs)) {
      assert.ok(knob.min <= c.defaults[k] && c.defaults[k] <= knob.max, `${c.id}.${k}'s default sits inside its range`)
    }
  }
  const card = MCGM.componentById('session-card')
  assert.equal(card.title, 'Session card')
  assert.deepEqual(card.defaults, { hoverFollow: 50, maxTilt: 8 })
  assert.deepEqual(card.knobs.hoverFollow, { min: 5, max: 200, step: 1, unit: 'rad/s', label: 'Hover follow' })
  assert.deepEqual(card.knobs.maxTilt, { min: 0, max: 20, step: 0.5, unit: '°', label: 'Max tilt' })
  const graph = MCGM.componentById('git-graph')
  assert.equal(graph.title, 'Worktree graph')
  assert.deepEqual(graph.defaults, {})
  assert.deepEqual(graph.knobs, {})
  assert.equal(MCGM.componentById('no-such-component'), null)
})

await ok('mergeParams layers defaults, stored and patch, clamps to the knobs and drops the rest', async () => {
  assert.deepEqual(MCGM.mergeParams('session-card', undefined, undefined), { hoverFollow: 50, maxTilt: 8 },
    'nothing stored and nothing patched is the defaults')
  assert.deepEqual(MCGM.mergeParams('session-card', { hoverFollow: 40, maxTilt: 6 }, { maxTilt: 99, stray: 1 }),
    { hoverFollow: 40, maxTilt: 20 }, 'an over-max value clamps to max, and an unknown key is dropped')
  assert.equal(MCGM.mergeParams('session-card', { hoverFollow: 40 }, { hoverFollow: -3 }).hoverFollow, 5,
    'an under-min value clamps to min')
  for (const bad of ['90', NaN, Infinity, null, true]) {
    assert.equal(MCGM.mergeParams('session-card', { hoverFollow: 40 }, { hoverFollow: bad }).hoverFollow, 40,
      `a patch value of ${String(bad)} leaves the stored value in place`)
  }
  const stored = { hoverFollow: 40 }
  const merged = MCGM.mergeParams('session-card', stored, { maxTilt: 3 })
  assert.notEqual(merged, stored, 'a new object')
  assert.deepEqual(stored, { hoverFollow: 40 }, 'the stored layer is left alone')
  assert.deepEqual(MCGM.mergeParams('session-card', {}, {}), { hoverFollow: 50, maxTilt: 8 },
    'and so are the defaults')
  assert.deepEqual(MCGM.mergeParams('git-graph', { anything: 1 }, { at: 2 }), {})
  assert.deepEqual(MCGM.mergeParams('no-such-component', { hoverFollow: 40 }, { maxTilt: 3 }), {})
})

await ok('stepCritical never overshoots, for any omega, dt or gap', async () => {
  for (const omega of [4, 12, 50, 200]) {
    for (const dt of [1 / 120, 1 / 60, 1 / 30, MCGM.DT_MAX]) {
      for (const gap of [-500, -1, 0.2, 37, 900]) {
        let s = { x: 0, v: 0 }
        for (let i = 0; i < 2000; i++) {
          s = MCGM.stepCritical(s.x, s.v, gap, omega, dt)
          const over = gap >= 0 ? s.x > gap + 1e-6 : s.x < gap - 1e-6
          assert.ok(!over, `overshot at omega=${omega} dt=${dt} gap=${gap}: ${s.x}`)
        }
      }
    }
  }
})

await ok('stepCritical settles inside the bound it advertises', async () => {
  for (const omega of [4, 12, 50]) {
    const dt = 1 / 60
    let s = { x: 0, v: 0 }
    const steps = Math.ceil(MCGM.settleBound(omega) / dt)
    for (let i = 0; i < steps; i++) s = MCGM.stepCritical(s.x, s.v, 100, omega, dt)
    assert.ok(Math.abs(100 - s.x) <= 1, `omega=${omega} reached ${s.x}`)
  }
})

await ok('a huge dt is clamped rather than teleporting', async () => {
  const a = MCGM.stepCritical(0, 0, 100, 50, 3.5)
  const b = MCGM.stepCritical(0, 0, 100, 50, MCGM.DT_MAX)
  assert.deepEqual(a, b, 'a backgrounded tab returning must not jump every card')
})

await ok('cards at rest never overlap, and float can never bring them into contact', async () => {
  const rng = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  for (let trial = 0; trial < 200; trial++) {
    const r = rng(trial + 1)
    const n = 1 + Math.floor(r() * 24)
    const ids = Array.from({ length: n }, (_, i) => 'c' + i)
    const w = 120 + r() * 160
    const h = 70 + r() * 90
    const sep = Math.hypot(w, h) + 12
    const slots = MCGM.cardSlots(ids, { w, h, sep })
    const rad = Math.hypot(w, h) / 2
    const amp = MCGM.floatAmp(sep, rad)
    assert.ok(amp >= 0, 'amplitude is never negative')
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const d = Math.hypot(slots[i].x - slots[j].x, slots[i].y - slots[j].y)
        assert.ok(d >= sep - 1e-6, `rest separation ${d} < ${sep}`)
        assert.ok(d - 2 * amp >= 2 * rad - 1e-6, 'float can bring two cards into contact')
      }
    }
  }
})

await ok('float gives every element its own phase', async () => {
  const a = MCGM.floatAt('c0', 1.234, 6)
  const b = MCGM.floatAt('c1', 1.234, 6)
  assert.notDeepEqual(a, b, 'nothing moves in unison')
  assert.deepEqual(MCGM.floatAt('c0', 1.234, 6), a, 'and it is deterministic')
  for (const k of ['dx', 'dy', 'dz']) assert.ok(Math.abs(a[k]) <= 6 + 1e-9)
})

await ok('a still calm dial stops everything; reduced motion forces it', async () => {
  assert.deepEqual(MCGM.calmScale('still', false), { settle: 0, float: 0 })
  assert.equal(MCGM.calmScale('settle', false).float, 0)
  assert.ok(MCGM.calmScale('more', false).float > MCGM.calmScale('subtle', false).float)
  assert.deepEqual(MCGM.calmScale('more', true), { settle: 0, float: 0 })
  assert.deepEqual(MCGM.calmScale('nonsense', false), MCGM.calmScale(MCGM.CALM_DEFAULT, false))
})

await ok('tilt follows the pointer directly and is bounded', async () => {
  const rect = { left: 0, top: 0, width: 200, height: 100 }
  assert.deepEqual(MCGM.tiltFor({ x: 100, y: 50 }, rect, 8), { rx: 0, ry: 0 })
  const tl = MCGM.tiltFor({ x: 0, y: 0 }, rect, 8)
  const br = MCGM.tiltFor({ x: 200, y: 100 }, rect, 8)
  assert.ok(Math.abs(tl.rx) <= 8 && Math.abs(tl.ry) <= 8)
  assert.equal(Math.sign(tl.rx), -Math.sign(br.rx))
  const out = MCGM.tiltFor({ x: 9999, y: -9999 }, rect, 8)
  assert.ok(Math.abs(out.rx) <= 8 && Math.abs(out.ry) <= 8, 'a pointer past the edge stays bounded')
})

await ok('the tilt target slews at most 3 degrees a frame and ramps from zero', async () => {
  let cur = { rx: 0, ry: 0 }
  const target = { rx: 8, ry: -8 }
  const seen = []
  for (let i = 0; i < 40; i++) {
    const next = MCGM.slewTilt(cur, target, 3, i / 40)
    seen.push(Math.max(Math.abs(next.rx - cur.rx), Math.abs(next.ry - cur.ry)))
    cur = next
  }
  assert.ok(Math.max(...seen) <= 3 + 1e-9)
  assert.ok(Math.abs(cur.rx - 8) < 0.1, 'and it does arrive')
})

await ok('a flying-out child never crosses the parent and never collapses onto it', async () => {
  const parent = { x: 0, y: 0, w: 200, h: 110 }
  for (const variant of ['slide', 'scale']) {
    for (let n = 1; n <= 6; n++) {
      for (let i = 0; i < n; i++) {
        for (let k = 0; k <= 40; k++) {
          const p = MCGM.flyOutPath(variant, parent, { w: 110, h: 64 }, i, n, k / 40)
          assert.ok(p.scale > 0, `${variant}: a child collapsed to a point`)
          const halfW = (110 * p.scale) / 2 + parent.w / 2
          const halfH = (64 * p.scale) / 2 + parent.h / 2
          const clear = Math.abs(p.x) >= halfW - 1e-6 || Math.abs(p.y) >= halfH - 1e-6
          assert.ok(clear || p.opacity <= 1e-6,
            `${variant}: child ${i}/${n} at t=${k / 40} is inside the parent while visible`)
        }
      }
    }
  }
})

await ok('siblings leave to the edges rather than fading', async () => {
  const out = MCGM.siblingExit({ x: 0, y: 0, w: 200, h: 110 }, { w: 1200, h: 800 }, 0, 4)
  assert.ok(Math.abs(out.x) > 400 || Math.abs(out.y) > 250, 'a sibling ends near an edge')
})

// Size pairs the fly-out has to clear: the session card and its child card as
// drawn (frame included), the pair above, a wide parent with a tall child,
// equal squares, and a parent and child of one shape -- the pair for which
// two half-diagonals add up to exactly the corner distance.
const FLY_PAIRS = [
  [{ w: 238, h: 152 }, { w: 152, h: 101 }],
  [{ w: 200, h: 110 }, { w: 110, h: 64 }],
  [{ w: 300, h: 80 }, { w: 60, h: 200 }],
  [{ w: 120, h: 120 }, { w: 120, h: 120 }],
  [{ w: 238, h: 152 }, { w: 119, h: 76 }],
]

await ok('a child clears the parent at every progress and every place in the fan, whatever its opacity', async () => {
  // The opacity is animated on a clock of its own, so it cannot be what keeps
  // a child off the parent: the position has to, at every t.
  for (const [size, child] of FLY_PAIRS) {
    for (const at of [{ x: 0, y: 0 }, { x: -340, y: 125 }]) {
      const parent = { ...at, ...size }
      for (const variant of ['slide', 'scale']) {
        for (let n = 1; n <= 8; n++) {
          for (let u = 0; u <= 50; u++) {
            const i = MCGM.fanIndex(u / 50, n)
            for (let k = 0; k <= 40; k++) {
              const p = MCGM.flyOutPath(variant, parent, child, i, n, k / 40)
              assert.ok(p.scale > 0, `${variant}: a child collapsed to a point`)
              const halfW = (child.w * p.scale) / 2 + parent.w / 2
              const halfH = (child.h * p.scale) / 2 + parent.h / 2
              const clear = Math.abs(p.x - parent.x) >= halfW - 1e-6 || Math.abs(p.y - parent.y) >= halfH - 1e-6
              assert.ok(clear, `${variant}: ${child.w}x${child.h} beside ${size.w}x${size.h} at fan ${u / 50}, t=${k / 40} overlaps the parent`)
            }
          }
        }
      }
    }
  }
})

await ok('flyOutPath is placed by the fan fraction alone, so a fan can change size without a jump', async () => {
  const parent = { x: 12, y: -30, w: 238, h: 152 }
  const child = { w: 152, h: 101 }
  for (const variant of ['slide', 'scale']) {
    for (let n = 1; n <= 6; n++) {
      for (let i = 0; i < n; i++) {
        const u = MCGM.fanFraction(i, n)
        assert.ok(u > 0 && u < 1, 'a fraction lies inside the fan')
        for (let m = 1; m <= 7; m++) {
          const a = MCGM.flyOutPath(variant, parent, child, i, n, 0.6)
          const b = MCGM.flyOutPath(variant, parent, child, MCGM.fanIndex(u, m), m, 0.6)
          assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && a.scale === b.scale,
            `${variant}: child ${i}/${n} moved when its fraction was handed over as a fan of ${m}`)
        }
      }
    }
  }
})

await ok('flyOutReach bounds the parent and every child of the fly-out', async () => {
  for (const [size, child] of FLY_PAIRS) {
    const parent = { x: 40, y: -25, ...size }
    const reach = MCGM.flyOutReach(parent, child)
    assert.ok(reach.x >= size.w / 2 && reach.y >= size.h / 2, 'the parent is inside its own reach')
    for (const variant of ['slide', 'scale']) {
      for (let n = 1; n <= 8; n++) {
        for (let i = 0; i < n; i++) {
          for (let k = 0; k <= 20; k++) {
            const p = MCGM.flyOutPath(variant, parent, child, i, n, k / 20)
            assert.ok(Math.abs(p.x - parent.x) + (child.w * p.scale) / 2 <= reach.x + 1e-6, `${variant}: past the reach across`)
            assert.ok(Math.abs(p.y - parent.y) + (child.h * p.scale) / 2 <= reach.y + 1e-6, `${variant}: past the reach down`)
          }
        }
      }
    }
  }
})

await ok('flyOutLayout centres the open card and parks every other card outside the view', async () => {
  const opts = { w: 238, h: 152, sep: 318, viewport: { w: 900, h: 700 } }
  const outside = (p) => Math.abs(p.x) - opts.w / 2 >= opts.viewport.w / 2 - 1e-6 ||
    Math.abs(p.y) - opts.h / 2 >= opts.viewport.h / 2 - 1e-6
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']

  const slots = MCGM.cardSlots(ids, opts)
  for (const open of [null, undefined, 'nobody']) {
    assert.deepEqual(MCGM.flyOutLayout(ids, open, opts), slots.map((p) => ({ ...p, parked: false })),
      `closed (${String(open)}): every card at its slot, none parked`)
  }

  for (const open of ids) {
    const out = MCGM.flyOutLayout(ids, open, opts)
    assert.deepEqual(out.map((p) => p.id), ids, 'one entry per id, in order')
    for (const p of out) {
      if (p.id === open) {
        assert.deepEqual([p.x, p.y, p.parked], [0, 0, false], 'the open card is at the centre')
      } else {
        assert.equal(p.parked, true)
        assert.ok(outside(p), `${p.id} parked inside the view with ${open} open`)
      }
    }
  }

  const arrived = MCGM.flyOutLayout([...ids, 'late'], 'c', opts)
  const late = arrived.find((p) => p.id === 'late')
  assert.ok(late.parked && outside(late), 'a card that arrives while open parks with the rest')
  const left = MCGM.flyOutLayout(ids.filter((id) => id !== 'e'), 'c', opts)
  assert.equal(left.length, ids.length - 1, 'a card that leaves drops out')
  assert.ok(left.every((p) => p.id === 'c' || (p.parked && outside(p))))
  assert.deepEqual(MCGM.flyOutLayout(['c'], 'c', opts), [{ id: 'c', x: 0, y: 0, parked: false }],
    'a lone open card has nothing to park')
  assert.deepEqual(MCGM.flyOutLayout(null, 'c', opts), [])
})

await ok('agentKeys keys each subagent by id, else by position, and skips junk', async () => {
  const a = { id: 'x1', status: 'running' }
  const b = { status: 'done' }
  const c = { id: 7, status: 'done' }
  const keys = MCGM.agentKeys([a, null, b, 'nope', c, { id: 'x1', status: 'done' }])
  assert.deepEqual(keys.map((k) => k.key), ['id:x1', 'at:2', 'id:7'])
  assert.equal(keys[0].agent, a, 'the first entry for a repeated key wins')
  assert.deepEqual(MCGM.agentKeys(undefined), [])
  assert.deepEqual(MCGM.agentKeys([{ id: '' }]).map((k) => k.key), ['at:0'], 'an empty id is no id')
})

await ok('graphLayout reads the published shape and is empty-safe', async () => {
  assert.deepEqual(MCGM.graphLayout(null, 'projects', null), { nodes: [], edges: [] })
  const g = MCGM.graphLayout(GITGRAPH_FIXTURE, 'worktrees', null)
  assert.equal(g.nodes.length, GITGRAPH_FIXTURE.branches.length)
  assert.ok(g.nodes.find((n) => n.id === 'main').main, 'the base branch is marked')
  const c = MCGM.graphLayout(GITGRAPH_FIXTURE, 'commits', 'feat/thing')
  assert.equal(c.nodes.length, 3)
  assert.equal(c.edges.length, 2, 'one rail segment between consecutive commits')
  const merge = MCGM.graphLayout(
    { ...GITGRAPH_FIXTURE, branches: [{ ...GITGRAPH_FIXTURE.branches[0], commits: [] }] },
    'commits', 'main')
  assert.deepEqual(merge.nodes, [], 'a branch with no commits draws nothing and throws nothing')

  // The top level is laid out from the snapshot's projects list, not a graph.
  const projects = MCGM.graphLayout(
    [{ key: 'alpha', name: 'Alpha', worktrees: [] }, { key: 'beta', name: 'Beta', worktrees: [] }],
    'projects', null)
  assert.deepEqual(projects.nodes.map((n) => n.id), ['alpha', 'beta'], 'one node per project, keyed by its key')
  assert.deepEqual(projects.nodes.map((n) => n.name), ['Alpha', 'Beta'])
  assert.deepEqual(projects.edges, [], 'the projects level has no edges')
  assert.deepEqual(MCGM.graphLayout(GITGRAPH_FIXTURE, 'projects', null), { nodes: [], edges: [] },
    'a graph is the wrong shape for the projects level')
  assert.deepEqual(MCGM.graphLayout([{ key: 'alpha' }], 'worktrees', null), { nodes: [], edges: [] },
    'a list is the wrong shape for the worktrees level')
  assert.deepEqual(MCGM.graphLayout('nope', 'commits', 'main'), { nodes: [], edges: [] })
  assert.equal(MCGM.graphLayout(GITGRAPH_FIXTURE, 'commits', 'main').edges.length, 2,
    'a merge commit draws its second parent as a second edge')
})

await ok('an absent or null base is read as "not measured", never as zero', async () => {
  // `base` is an additive key on an otherwise fixed shape: a relay built before
  // it landed sends no key at all, and a project with no main branch sends
  // null. Both must render, and neither may claim a branch is level with a
  // base there is none of. The producer only measures ahead/behind when it HAS
  // a base, so a no-base graph carries nulls there already -- this layout
  // passes those through rather than inventing or erasing a number.
  const unmeasured = GITGRAPH_FIXTURE.branches.map((b) => ({ ...b, ahead: null, behind: null }))
  const { base, ...noKey } = GITGRAPH_FIXTURE
  for (const g of [{ ...noKey, branches: unmeasured }, { ...GITGRAPH_FIXTURE, base: null, branches: unmeasured }]) {
    const out = MCGM.graphLayout(g, 'worktrees', null)
    assert.equal(out.nodes.length, GITGRAPH_FIXTURE.branches.length, 'every branch still draws')
    assert.ok(!out.nodes.some((n) => n.main), 'no branch is marked as the base')
    for (const n of out.nodes) {
      assert.equal(n.ahead, null, 'ahead reads as not measured')
      assert.equal(n.behind, null, 'behind reads as not measured')
    }
    assert.equal(MCGM.graphLayout(g, 'commits', 'feat/thing').nodes.length, 3,
      'drilling into a branch works with no base at all')
  }
})

await ok('ahead and behind are passed through, never defaulted to zero', async () => {
  // A real 0 means "level with the base" and a null means "not measured".
  // Collapsing the two would turn an unanswered question into a claim.
  const out = MCGM.graphLayout(GITGRAPH_FIXTURE, 'worktrees', null)
  const feat = out.nodes.find((n) => n.id === 'feat/thing')
  assert.equal(feat.ahead, 3)
  assert.equal(feat.behind, 1)
  assert.equal(out.nodes.find((n) => n.id === 'main').ahead, 0)
})

await ok('graphFor tells an older relay, a failed read, a graph and an empty graph apart', async () => {
  // `'gitGraph' in project` is the test, because an absent key (a relay that
  // does not publish the field) and a null value (the git call failed) need
  // different sentences, and `?? null` would read them as one.
  const worktrees = [
    { path: '/w/main', branch: 'main', head: 'ccccccc0000', isMain: true },
    { path: '/w/detached', branch: '', head: 'ddddddd0000', isMain: false },
  ]
  const heads = {
    base: null, builtAt: 0, truncated: false,
    branches: [
      { name: 'main', head: 'ccccccc0000', isMain: true, ahead: null, behind: null, commits: [], truncated: false },
      { name: 'ddddddd', head: 'ddddddd0000', isMain: false, ahead: null, behind: null, commits: [], truncated: false },
    ],
  }
  const none = { base: null, builtAt: 0, truncated: false, branches: [] }

  const older = MCGM.graphFor({ key: 'p', worktrees })
  assert.equal(older.state, 'heads')
  assert.deepEqual(older.graph, heads, 'an absent key draws the worktree heads, a detached one by its short head')
  assert.deepEqual(MCGM.graphFor({ key: 'p' }), { graph: none, state: 'empty' },
    'an absent key and no worktrees leaves nothing to draw')

  assert.deepEqual(MCGM.graphFor({ key: 'p', worktrees, gitGraph: null }), { graph: heads, state: 'failed' },
    'a failed read still draws the heads, and says it failed')
  assert.deepEqual(MCGM.graphFor({ key: 'p', worktrees: [], gitGraph: null }), { graph: none, state: 'failed' },
    'with no worktrees too, so the failure is still reported')

  const real = MCGM.graphFor({ key: 'p', worktrees, gitGraph: GITGRAPH_FIXTURE })
  assert.equal(real.state, 'graph')
  assert.equal(real.graph, GITGRAPH_FIXTURE, 'a published graph passes through unchanged')

  for (const g of [{ ...GITGRAPH_FIXTURE, branches: [] }, { base: null, builtAt: 1, truncated: false }]) {
    const e = MCGM.graphFor({ key: 'p', worktrees, gitGraph: g })
    assert.equal(e.state, 'empty')
    assert.equal(e.graph, g, 'an empty graph is still the published object')
  }

  for (const junk of ['nope', 42, [], undefined]) {
    assert.deepEqual(MCGM.graphFor({ key: 'p', worktrees, gitGraph: junk }), { graph: heads, state: 'failed' },
      `a gitGraph of ${JSON.stringify(junk) ?? 'undefined'} reads as a failure`)
  }
  for (const notAProject of [null, undefined, 'p', 7]) {
    assert.deepEqual(MCGM.graphFor(notAProject), { graph: none, state: 'failed' }, 'never a throw')
  }

  const drawn = MCGM.graphLayout(older.graph, 'worktrees', null)
  assert.equal(drawn.nodes.length, 2)
  assert.ok(!drawn.nodes.some((n) => n.main), 'a worktree flagged isMain is not a measured base')
  for (const n of drawn.nodes) {
    assert.equal(n.ahead, null)
    assert.equal(n.behind, null)
  }
})

await ok('graphFor reads a folder that is not a git repository as its own state, before a null reads as a failure', async () => {
  // The scanner sends gitGraph: null both for a plain folder and when the git
  // call fails. Only the project's own isGit tells the two apart.
  const none = { base: null, builtAt: 0, truncated: false, branches: [] }
  const plain = [{ path: '/w/plain', branch: null, head: null, isMain: true }]
  assert.deepEqual(MCGM.graphFor({ key: '/w/plain', isGit: false, worktrees: plain, gitGraph: null }),
    { graph: none, state: 'nogit' }, 'a plain folder is not a failed read')
  assert.deepEqual(MCGM.graphFor({ key: '/w/plain', isGit: false, worktrees: plain }),
    { graph: none, state: 'nogit' }, 'with or without the key')
  const repo = [{ path: '/w/main', branch: 'main', head: 'ccccccc', isMain: true }]
  for (const isGit of [true, undefined]) {
    const p = { key: 'p', worktrees: repo, gitGraph: null }
    if (isGit !== undefined) p.isGit = isGit
    const r = MCGM.graphFor(p)
    assert.equal(r.state, 'failed', `a null on a project whose isGit is ${String(isGit)} is still a failed read`)
    assert.equal(r.graph.branches.length, 1, 'and still draws its heads')
  }
  assert.equal(MCGM.GRAPH_SENTENCE.nogit, 'not a git repository')
  assert.equal(MCGM.GRAPH_SENTENCE.failed, 'the git history could not be read')
})

// Two labels overlap when their boxes cross on both axes.
const overlapping = (nodes) => {
  const shown = nodes.filter((n) => !n.parked)
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i]
      const b = shown[j]
      if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-6 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 1e-6) return [a.id, b.id]
    }
  }
  return null
}
const withinReach = (scene) => scene.nodes.every((n) => n.parked ||
  (Math.abs(n.x) + n.w / 2 <= scene.reach.x + 1e-6 && Math.abs(n.y) + n.h / 2 <= scene.reach.y + 1e-6))

await ok('graphScene lays out every project, and falls back a level when a focus names nothing', async () => {
  const projects = MCGM.sampleProjects(7)
  const s = MCGM.graphScene(projects, 'projects', null)
  assert.equal(s.level, 'projects')
  assert.deepEqual(s.focus, { project: null, branch: null })
  const grid = MCGM.graphLayout(projects, 'projects')
  assert.deepEqual(s.nodes.map((n) => [n.id, n.kind, n.x, n.y, n.parked]),
    grid.nodes.map((n) => ['p:' + n.id, 'project', n.x, n.y, false]), 'one label per project, on the grid')
  assert.deepEqual(s.edges, [])
  assert.deepEqual(s.nodes.map((n) => n.sub),
    ['3 branches', MCGM.GRAPH_SENTENCE.heads, MCGM.GRAPH_SENTENCE.nogit], 'each project says what it has')
  assert.ok(withinReach(s))

  const lost = MCGM.graphScene(projects, 'worktrees', { project: 'nope' })
  assert.equal(lost.level, 'projects')
  assert.equal(lost.focus.project, null)
  const noBranch = MCGM.graphScene(projects, 'commits', { project: projects[0].key, branch: 'nope' })
  assert.equal(noBranch.level, 'worktrees')
  assert.deepEqual(noBranch.focus, { project: projects[0].key, branch: null })
  assert.equal(MCGM.graphScene(projects, 'banana', { project: projects[0].key }).level, 'projects')
  assert.deepEqual(MCGM.graphScene(null, 'commits', null).nodes, [])
  assert.deepEqual(MCGM.graphScene(null, 'commits', null).reach, { x: 0, y: 0 })
})

await ok('graphScene isolates one project above its branches, and never marks or measures a base that is not there', async () => {
  const projects = MCGM.sampleProjects(7)
  const key = projects[0].key
  const s = MCGM.graphScene(projects, 'worktrees', { project: key })
  assert.equal(s.level, 'worktrees')
  assert.equal(s.state, 'graph')
  const grid = MCGM.graphLayout(projects, 'projects')
  const top = s.nodes.find((n) => n.id === 'p:' + key)
  assert.ok(top.focus && !top.parked, 'the focused project stays in view')
  for (const n of s.nodes.filter((n) => n.kind === 'project' && n !== top)) {
    const slot = grid.nodes.find((g) => 'p:' + g.id === n.id)
    assert.ok(n.parked && n.x === slot.x && n.y === slot.y, 'every other project parks from its slot')
  }
  const branches = s.nodes.filter((n) => n.kind === 'branch')
  assert.deepEqual(branches.map((n) => n.id), projects[0].gitGraph.branches.map((b) => 'b:' + b.name))
  for (const b of branches) {
    assert.equal(b.parent, top.id, 'a branch spreads out of its project')
    assert.ok(top.y + top.h / 2 < b.y - b.h / 2, 'the project sits above every branch')
  }
  const shown = s.nodes.filter((n) => !n.parked)
  const lo = Math.min(...shown.map((n) => n.y - n.h / 2))
  const hi = Math.max(...shown.map((n) => n.y + n.h / 2))
  assert.ok(Math.abs(lo + hi) < 1e-6, 'centred vertically on the origin')
  assert.equal(overlapping(s.nodes), null)
  assert.ok(withinReach(s))
  assert.deepEqual(s.edges.map((e) => [e.kind, e.from, e.to]), [
    ['stem', top.id, 'b:main'],
    ...projects[0].gitGraph.branches.slice(1).map((b) => ['base', 'b:main', 'b:' + b.name]),
  ])
  assert.deepEqual(branches.map((n) => n.measure), ['base', '↑3 ↓1', '↑1 ↓4'])

  // The fixture with no base: its main still carries ahead 0 and behind 0,
  // and neither may be shown as a measurement against nothing.
  const { base, ...noKey } = GITGRAPH_FIXTURE
  for (const g of [noKey, { ...GITGRAPH_FIXTURE, base: null }]) {
    const p = [{ key: 'fx', name: 'fx', isGit: true, worktrees: [], gitGraph: g }]
    const w = MCGM.graphScene(p, 'worktrees', { project: 'fx' })
    const bs = w.nodes.filter((n) => n.kind === 'branch')
    assert.equal(bs.length, 2)
    assert.ok(bs.every((n) => !n.main && n.measure === ''), 'no base: nothing marked, the column blank')
    assert.deepEqual(w.edges.map((e) => [e.kind, e.to]), [['stem', 'b:main'], ['stem', 'b:feat/thing']],
      'the project joins every branch directly')
  }
  const withBase = MCGM.graphScene([{ key: 'fx', name: 'fx', isGit: true, worktrees: [], gitGraph: GITGRAPH_FIXTURE }],
    'worktrees', { project: 'fx' })
  assert.deepEqual(withBase.nodes.filter((n) => n.kind === 'branch').map((n) => n.measure), ['base', '↑3 ↓1'])

  const heads = MCGM.graphScene(projects, 'worktrees', { project: projects[1].key })
  assert.equal(heads.state, 'heads')
  const hb = heads.nodes.filter((n) => n.kind === 'branch')
  assert.equal(hb.length, 2)
  assert.ok(hb.every((n) => n.measure === '' && n.commits === 0))
  const plain = MCGM.graphScene(projects, 'worktrees', { project: projects[2].key })
  assert.equal(plain.state, 'nogit')
  assert.equal(plain.nodes.filter((n) => n.kind === 'branch').length, 0)
  const alone = plain.nodes.find((n) => n.focus)
  assert.deepEqual([alone.x, alone.y, alone.sub], [0, 0, 'not a git repository'])
})

await ok('graphScene details one branch: newest commit on top, a rail between neighbours, a merge as a second edge', async () => {
  const projects = MCGM.sampleProjects(7)
  const key = projects[0].key
  const g = projects[0].gitGraph
  const wt = MCGM.graphScene(projects, 'worktrees', { project: key })
  const s = MCGM.graphScene(projects, 'commits', { project: key, branch: 'main' })
  assert.equal(s.level, 'commits')
  assert.deepEqual(s.focus, { project: key, branch: 'main' })
  const proj = s.nodes.find((n) => n.id === 'p:' + key)
  const main = s.nodes.find((n) => n.id === 'b:main')
  assert.ok(main.focus && !main.parked && proj.focus && !proj.parked)
  for (const n of s.nodes.filter((n) => n.kind === 'branch' && n !== main)) {
    const home = wt.nodes.find((w) => w.id === n.id)
    assert.ok(n.parked && n.x === home.x && n.y === home.y, 'a branch out of focus parks from its place under the project')
  }
  const commits = s.nodes.filter((n) => n.kind === 'commit')
  assert.deepEqual(commits.map((n) => n.key), g.branches[0].commits.map((c) => c.sha), 'in the published order')
  for (let k = 1; k < commits.length; k++) assert.ok(commits[k].y > commits[k - 1].y, 'newest at the top')
  assert.ok(proj.y + proj.h / 2 < main.y - main.h / 2 && main.y + main.h / 2 < commits[0].y - commits[0].h / 2)
  const rails = s.edges.filter((e) => e.kind === 'rail')
  assert.deepEqual(rails.map((e) => [e.from, e.to]),
    commits.slice(1).map((c, k) => [commits[k].id, c.id]), 'one rail segment between consecutive commits')
  const merges = s.edges.filter((e) => e.kind === 'merge')
  const mergeCommit = g.branches[0].commits.find((c) => c.parents.length === 2)
  assert.deepEqual(merges, [{ from: 'c:' + mergeCommit.sha, to: 'c:' + mergeCommit.parents[1], kind: 'merge' }],
    'the second parent is a second edge, to a commit shown beside it')
  assert.ok(commits.find((n) => n.key === mergeCommit.sha).merge)
  assert.deepEqual(s.edges.filter((e) => e.kind === 'stem').map((e) => [e.from, e.to]),
    [[proj.id, main.id], [main.id, commits[0].id]])
  assert.equal(overlapping(s.nodes), null)
  assert.ok(withinReach(s))
  assert.ok(s.reach.x >= Math.abs(commits[0].x + MCGM.GRAPH_RAIL_DX - MCGM.GRAPH_GEOM.lane) - 1e-6,
    'the reach covers the merge lane')

  // The fixture's merge names parents that are not among the branch's commits.
  const fx = [{ key: 'fx', name: 'fx', isGit: true, worktrees: [], gitGraph: GITGRAPH_FIXTURE }]
  const fs = MCGM.graphScene(fx, 'commits', { project: 'fx', branch: 'main' })
  const stub = fs.edges.find((e) => e.kind === 'merge')
  assert.deepEqual(stub, { from: 'c:' + 'b'.repeat(40), to: null, kind: 'merge' })
  const stubAt = fs.nodes.find((n) => n.id === stub.from)
  assert.ok(fs.reach.y >= stubAt.y + MCGM.GRAPH_GEOM.pitch - 1e-6, 'the reach covers the merge edge bending down')

  // A branch with nothing to show gets its own reason, never an empty scene.
  const bare = [{ key: 'fx', name: 'fx', isGit: true, worktrees: [],
    gitGraph: { ...GITGRAPH_FIXTURE, branches: [{ ...GITGRAPH_FIXTURE.branches[0], commits: [] }] } }]
  const cases = [
    [bare, 'fx', 'main', MCGM.BRANCH_NOTE.graph],
    [projects, projects[1].key, projects[1].worktrees[0].branch, MCGM.BRANCH_NOTE.heads],
    [[{ key: 'f', name: 'f', isGit: true, worktrees: [{ path: '/f', branch: 'main', head: 'abcdef0', isMain: true }], gitGraph: null }],
      'f', 'main', MCGM.BRANCH_NOTE.failed],
  ]
  for (const [list, project, branch, text] of cases) {
    const n = MCGM.graphScene(list, 'commits', { project, branch })
    assert.equal(n.level, 'commits')
    assert.equal(n.nodes.filter((x) => x.kind === 'commit').length, 0)
    const note = n.nodes.find((x) => x.kind === 'note')
    assert.ok(note, 'a note stands in for the commits')
    assert.equal(note.text, text)
    assert.equal(note.parent, 'b:' + branch)
    assert.deepEqual(n.edges.map((e) => e.kind), ['stem'])
    assert.equal(overlapping(n.nodes), null)
  }
})

await ok('a parked label sent by siblingExit sits wholly outside the view the level fits', async () => {
  const projects = [...MCGM.sampleProjects(7), ...MCGM.sampleProjects(11).map((p) => ({ ...p, key: p.key + ':b' }))]
  for (const [level, focus] of [['worktrees', { project: projects[0].key }], ['commits', { project: projects[0].key, branch: 'main' }]]) {
    const s = MCGM.graphScene(projects, level, focus)
    const view = { w: 2 * (s.reach.x + 24), h: 2 * (s.reach.y + 24) }
    const parked = s.nodes.filter((n) => n.parked)
    assert.ok(parked.length >= 5)
    parked.forEach((n, k) => {
      const at = MCGM.siblingExit(n, view, k, parked.length)
      assert.ok(Math.abs(at.x) - n.w / 2 >= view.w / 2 - 1e-6 || Math.abs(at.y) - n.h / 2 >= view.h / 2 - 1e-6,
        `${level}: ${n.id} parked inside the view`)
    })
  }
})

await ok('sampleSessions is seeded, shaped like a real session, and has subagents', async () => {
  const a = MCGM.sampleSessions(5, 7)
  assert.equal(a.length, 5)
  assert.deepEqual(a, MCGM.sampleSessions(5, 7))
  assert.ok(a.some((s) => (s.agents || []).length > 0), 'the fly-out needs a card that has some')
  for (const s of a) {
    assert.equal(typeof s.id, 'string')
    assert.ok(Array.isArray(s.agents))
    for (const g of s.agents) assert.ok(['running', 'done'].includes(g.status))
  }
})

await ok('sampleProjects is seeded, shaped like the snapshot, and reaches the graph, heads and not-a-repository states', async () => {
  const a = MCGM.sampleProjects(7)
  assert.deepEqual(a, MCGM.sampleProjects(7), 'the same seed gives the same projects')
  assert.notDeepEqual(a, MCGM.sampleProjects(8))
  assert.equal(a.length, 3)
  const keys = (o) => Object.keys(o).sort()
  for (const p of a) {
    assert.equal(typeof p.key, 'string')
    assert.equal(typeof p.name, 'string')
    assert.equal(typeof p.isGit, 'boolean')
    assert.ok(Array.isArray(p.worktrees) && p.worktrees.length > 0)
    for (const w of p.worktrees) {
      assert.deepEqual(keys(w), ['branch', 'head', 'isMain', 'path'])
      assert.equal(typeof w.path, 'string')
      assert.ok(w.branch === null || typeof w.branch === 'string')
      assert.ok(w.head === null || typeof w.head === 'string')
      assert.equal(typeof w.isMain, 'boolean')
    }
  }
  assert.equal(new Set(a.map((p) => p.key)).size, 3, 'keys are unique')
  assert.deepEqual(a.map((p) => MCGM.graphFor(p).state), ['graph', 'heads', 'nogit'])
  assert.ok(!('gitGraph' in a[1]), 'the heads project has no key at all')
  assert.equal(a[2].isGit, false)

  const g = a[0].gitGraph
  assert.deepEqual(keys(g), keys(GITGRAPH_FIXTURE), 'the graph carries exactly the published fields')
  assert.ok(g.branches.length >= 2)
  assert.ok(g.branches.some((b) => b.name === g.base), 'the base is one of the branches')
  for (const b of g.branches) {
    assert.deepEqual(keys(b), keys(GITGRAPH_FIXTURE.branches[0]))
    assert.equal(b.head, b.commits[0].sha.slice(0, 7))
    b.commits.forEach((c, k) => {
      assert.deepEqual(keys(c), keys(GITGRAPH_FIXTURE.branches[0].commits[0]))
      assert.match(c.sha, /^[0-9a-f]{40}$/)
      assert.ok(Array.isArray(c.parents) && typeof c.subject === 'string' && Number.isFinite(c.at))
      if (k) assert.ok(c.at < b.commits[k - 1].at, 'newest first')
    })
  }
  const all = g.branches.flatMap((b) => b.commits)
  const merge = all.find((c) => c.parents.length === 2)
  assert.ok(merge, 'a merge commit with two parents')
  const base = g.branches.find((b) => b.name === g.base)
  assert.ok(base.commits.some((c) => c.sha === merge.parents[1]), 'its second parent is listed on the base')
})

await ok('withGraphs lays a read graph over its project, keeps it while a newer read is in flight, and leaves the rest untouched', async () => {
  const graph = { branches: [{ name: 'main', head: 'abc1234', isMain: true, ahead: null, behind: null, commits: [], truncated: false }] }
  const wts = [{ path: '/w/p', branch: 'main', head: 'abc1234', isMain: true }]
  const projects = ['/ok', '/older', '/refetch', '/first', '/missing', '/error', '/nogit', '/absent'].map((key) => (
    { key, name: key.slice(1), changedAt: 5, worktrees: wts, ...(key === '/nogit' ? { isGit: false } : {}) }))
  const graphs = new Map([
    ['/ok', { status: 'ok', changedAt: 5, gitGraph: graph }],
    // An older read still draws until the newer one is asked for and lands.
    ['/older', { status: 'ok', changedAt: 3, gitGraph: graph }],
    ['/refetch', { status: 'loading', changedAt: 5, gitGraph: graph }],
    ['/first', { status: 'loading', changedAt: 5 }],
    ['/missing', { status: 'missing', changedAt: 5 }],
    ['/error', { status: 'error', changedAt: 5 }],
    ['/nogit', { status: 'ok', changedAt: 5, gitGraph: null }],
  ])
  const before = JSON.stringify(projects)
  const out = MCGM.withGraphs(projects, graphs)
  const at = (key) => out[projects.findIndex((p) => p.key === key)]
  const own = (key) => projects.find((p) => p.key === key)
  assert.equal(out.length, projects.length)
  for (const key of ['/ok', '/older', '/refetch']) {
    assert.equal(at(key).gitGraph, graph, key)
    assert.equal(at(key).name, own(key).name, key + ' keeps the digest\'s own fields')
    assert.equal(MCGM.graphFor(at(key)).state, 'graph', key)
  }
  // Nothing read yet, a 404 and a failed read: the digest's project, untouched,
  // so graphFor draws the worktree heads.
  for (const key of ['/first', '/missing', '/error', '/absent']) {
    assert.equal(at(key), own(key), key)
    assert.equal(MCGM.graphFor(at(key)).state, 'heads', key)
  }
  // A null graph is a fact of its own and passes through as null.
  assert.equal(at('/nogit').gitGraph, null)
  assert.equal(MCGM.graphFor(at('/nogit')).state, 'nogit')
  assert.equal(JSON.stringify(projects), before, 'never writes a project')
  assert.notEqual(out, projects, 'always a new array')
  // Junk in, never a throw.
  assert.deepEqual(MCGM.withGraphs(undefined, graphs), [])
  assert.deepEqual(MCGM.withGraphs(null, null), [])
  assert.deepEqual(MCGM.withGraphs(projects, null), projects)
  assert.deepEqual(MCGM.withGraphs([null, 7, 'x'], graphs), [null, 7, 'x'])
})

console.log(`\n${pass} checks passed`)
