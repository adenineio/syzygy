#!/usr/bin/env node
// The Projects tab's motion core, loaded the way the pane loads it -- a
// classic script under a window shim -- plus two static guards: the geometry
// constants against the stylesheet that has to agree with them, and the
// settings markup the calm dial needs. A harness cannot measure a rect,
// cannot press a key and cannot see a dropped frame: every such claim is
// checked by hand in the browser, not here.
//
// Run: node test/projects-motion-harness.mjs   (or `just test-projects-motion`)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PUB = join(ROOT, 'syzygy', 'bridge', 'public')
const read = (f) => readFileSync(join(PUB, f), 'utf8')

let pass = 0
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label) }

const win = {}
const MCPMO = new Function('window', read('projects-motion-math.js') + '\nreturn MCPMO')(win)

console.log('=== projects-motion (pure core) ===')

ok('the two easings are the pane\'s own, and fade is not a third', () => {
  assert.equal(MCPMO.EASE.structural, 'cubic-bezier(.45, 0, .25, 1)')
  assert.equal(MCPMO.EASE.arrival, 'cubic-bezier(.2, .7, .3, 1)')
  assert.equal(MCPMO.EASE.fade, 'linear')
})

ok('scale: settle 1 passes a duration through, settle 0 flattens it', () => {
  assert.equal(MCPMO.scale(320, { settle: 1, float: 1 }), 320)
  assert.equal(MCPMO.scale(320, { settle: 0, float: 0 }), 0)
  assert.equal(MCPMO.scale(0, { settle: 1, float: 1 }), 0)
})

ok('scale: a missing or unusable calm reads as full motion, never as none', () => {
  assert.equal(MCPMO.scale(200, undefined), 200)
  assert.equal(MCPMO.scale(200, {}), 200)
  assert.equal(MCPMO.scale(200, { settle: NaN }), 200)
})

ok('scale: a fractional settle multiplies and rounds, so a future dial works', () => {
  assert.equal(MCPMO.scale(320, { settle: 0.5 }), 160)
  assert.equal(MCPMO.scale(201, { settle: 0.5 }), 101)
})

ok('staggerDelay: three steps and no more, however many items there are', () => {
  const d = (i) => MCPMO.staggerDelay(i, MCPMO.STAGGER_MS, MCPMO.STAGGER_CAP)
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(d), [0, 40, 80, 120, 120, 120])
})

ok('flipDelta: the offset is from-minus-to, so animating it to zero lands', () => {
  const before = { left: 100, top: 40, width: 600, height: 30 }
  const after = { left: 8, top: 40, width: 180, height: 60 }
  assert.deepEqual(MCPMO.flipDelta(before, after), { dx: 92, dy: 0, sx: 600 / 180, sy: 0.5 })
})

ok('flipDelta: a zero-width target yields scale 1, never Infinity', () => {
  const d = MCPMO.flipDelta({ left: 0, top: 0, width: 10, height: 10 },
                            { left: 0, top: 0, width: 0, height: 0 })
  assert.equal(d.sx, 1)
  assert.equal(d.sy, 1)
})

ok('the card omega matches the stage card it borrows, so the settle bound holds', () => {
  const g = new Function('window', read('sandbox-math.js') + '\nreturn MCGM')({})
  assert.equal(MCPMO.CARD_OMEGA, 12)
  assert.ok(Math.abs(g.settleBound(MCPMO.CARD_OMEGA) - 1.2) < 1e-9,
    'a card is still arriving about a second after the panels have landed')
})

ok('the panel order is the reading order the arrival fans in', () => {
  assert.deepEqual(MCPMO.PANEL_ORDER, ['worktrees', 'todos', 'features', 'graph'])
})

console.log('\n=== the stylesheet agrees with the constants ===')

ok('the rail width in projects.css is the one the timeline measures against', () => {
  const css = read('projects.css')
  const m = css.match(/\.pjrail\s*\{[^}]*flex:\s*0\s*0\s*(\d+)px/)
  assert.ok(m, '.pjrail must declare a fixed flex basis')
  assert.equal(Number(m[1]), MCPMO.RAIL_W)
})

console.log('\n=== the calm dial is reachable from the settings pop ===')

ok('the settings pop carries a calm dial the page-wide sync will find', () => {
  const html = readFileSync(join(PUB, 'index.html'), 'utf8')
  const pop = html.slice(html.indexOf('id="settingspop"'), html.indexOf('id="voicebox"'))
  assert.ok(pop.includes('id="calm"'), 'the settings pop needs the calm dial')
  const tag = pop.match(/<div[^>]*id="calm"[^>]*>/)
  assert.ok(tag, 'the calm dial must be one element in the pop')
  assert.ok(/class="[^"]*\bgcalm\b/.test(tag[0]),
    'without .gcalm the existing page-wide sync never marks its buttons')
  assert.ok(/class="[^"]*\bpicks\b/.test(tag[0]),
    'without .picks it does not look like Corners and Fly-out beside it')
})

ok('buildCalm fills both dials, and sandbox.js exports the live name', () => {
  const src = readFileSync(join(PUB, 'sandbox.js'), 'utf8')
  const at = src.indexOf('const buildCalm = ')
  const build = src.slice(at, at + 400)
  assert.ok(build.includes("'g-calm'"), 'the Sandbox header keeps its mirror')
  assert.ok(build.includes("'calm'"), 'the settings pop gets the dial too')
  assert.ok(/\bcalm\b/.test(src.slice(src.lastIndexOf('return {'))),
    'MCG must export calm() so another view can read the setting')
})

console.log('\n=== the timeline: level 0 and 1 ===')

const FULL = { settle: 1, float: 1 }
const STILL = { settle: 0, float: 0 }
const byId = (steps) => Object.fromEntries(steps.map((s) => [s.id, s]))
const ends = (steps) => Math.max(0, ...steps.map((s) => s.delay + s.duration))

const PAIRS = [[0, 1], [1, 0], [2, 0], [1, 2], [2, 1]]

ok('every step names a known target, property and easing', () => {
  for (const pair of PAIRS) {
    for (const s of MCPMO.timeline(pair[0], pair[1], FULL)) {
      assert.ok(MCPMO.TARGETS.includes(s.target), s.id + ' has an unknown target ' + s.target)
      assert.ok(['accent', 'opacity', 'flip', 'slide'].includes(s.property), s.id + ': ' + s.property)
      assert.ok(Object.values(MCPMO.EASE).includes(s.ease), s.id + ': ' + s.ease)
      assert.equal(typeof s.id, 'string')
    }
  }
})

ok('step ids are unique inside a timeline', () => {
  for (const pair of PAIRS) {
    const ids = MCPMO.timeline(pair[0], pair[1], FULL).map((s) => s.id)
    assert.equal(new Set(ids).size, ids.length, pair.join('->') + ' repeats an id')
  }
})

ok('0 -> 1 finishes at 480ms, the squeeze starting behind the fade', () => {
  const steps = MCPMO.timeline(0, 1, FULL)
  const s = byId(steps)
  assert.deepEqual(
    { d: s['row.light'].duration, delay: s['row.light'].delay }, { d: 80, delay: 0 })
  assert.deepEqual(
    { d: s['metrics.out'].duration, delay: s['metrics.out'].delay }, { d: 120, delay: 0 })
  assert.equal(s['metrics.out'].from, 1)
  assert.equal(s['metrics.out'].to, 0)
  assert.deepEqual(
    { d: s['rail.squeeze'].duration, delay: s['rail.squeeze'].delay }, { d: 320, delay: 40 })
  assert.equal(s['rail.squeeze'].property, 'flip')
  assert.equal(s['rail.squeeze'].ease, MCPMO.EASE.structural)
  assert.deepEqual(
    { d: s['scope.fade'].duration, delay: s['scope.fade'].delay }, { d: 120, delay: 0 })
  assert.deepEqual(
    { d: s['crumb2.in'].duration, delay: s['crumb2.in'].delay }, { d: 200, delay: 160 })
  assert.equal(s['crumb2.in'].from, -12, 'the crumb arrives from the left of rest')
  assert.equal(ends(steps), 480)
})

ok('0 -> 1 fans the four panels in reading order, 40ms apart, capped at three', () => {
  const panels = MCPMO.timeline(0, 1, FULL).filter((s) => s.target === 'panel')
  assert.equal(panels.length, 4)
  assert.deepEqual(panels.map((s) => s.id),
    MCPMO.PANEL_ORDER.map((k) => 'panel.in:' + k))
  assert.deepEqual(panels.map((s) => s.delay), [160, 200, 240, 280])
  assert.deepEqual(panels.map((s) => s.duration), [200, 200, 200, 200])
  assert.deepEqual(panels.map((s) => s.from), [-16, -16, -16, -16],
    'depth runs left to right, so a panel arrives from the left of rest')
  for (const s of panels) assert.equal(s.ease, MCPMO.EASE.arrival)
})

ok('1 -> 0 finishes at 260ms and is unanimous: one exit, not a reversed fan', () => {
  const steps = MCPMO.timeline(1, 0, FULL)
  const s = byId(steps)
  // A departure both drifts and fades, so there are two steps on the panels;
  // what matters is that there is ONE drift for all four, with no stagger.
  const drift = steps.filter((t) => t.target === 'panel' && t.property === 'slide')
  assert.equal(drift.length, 1, 'the panels leave together')
  assert.deepEqual({ d: drift[0].duration, delay: drift[0].delay }, { d: 120, delay: 0 })
  assert.equal(drift[0].to, -8, 'they drift toward the rail, which is on the left')
  assert.deepEqual(
    { d: s['rail.release'].duration, delay: s['rail.release'].delay }, { d: 200, delay: 60 })
  assert.deepEqual(
    { d: s['metrics.in'].duration, delay: s['metrics.in'].delay }, { d: 120, delay: 140 })
  assert.equal(ends(steps), 260)
})

ok('2 -> 0 plays only the outermost step, so a chain never reads as slow', () => {
  assert.deepEqual(MCPMO.timeline(2, 0, FULL), MCPMO.timeline(1, 0, FULL))
})

ok('reduced motion flattens every duration AND every delay to zero', () => {
  for (const pair of [[0, 1], [1, 0], [2, 0]]) {
    const steps = MCPMO.timeline(pair[0], pair[1], STILL)
    assert.ok(steps.length > 0, pair.join('->') + ' must still describe its final state')
    for (const s of steps) {
      assert.equal(s.duration, 0, s.id + ' duration')
      assert.equal(s.delay, 0, s.id + ' delay')
    }
  }
})

ok('an unknown pair is an empty timeline, never a throw', () => {
  assert.deepEqual(MCPMO.timeline(0, 0, FULL), [])
  assert.deepEqual(MCPMO.timeline(null, 7, FULL), [])
})

console.log('\n=== the timeline: level 2, and the chip row ===')

ok('1 -> 2 finishes at 320ms: bodies fade, then one FLIP of four things', () => {
  const steps = MCPMO.timeline(1, 2, FULL)
  const s = byId(steps)
  assert.deepEqual(
    { d: s['body.out'].duration, delay: s['body.out'].delay }, { d: 100, delay: 0 })
  assert.equal(s['body.out'].target, 'panel.body')
  for (const id of ['head.flip', 'graph.grow', 'cards.squeeze']) {
    assert.equal(s[id].property, 'flip', id)
    assert.deepEqual({ d: s[id].duration, delay: s[id].delay }, { d: 260, delay: 60 }, id)
    assert.equal(s[id].ease, MCPMO.EASE.structural, id)
  }
  assert.equal(s['head.flip'].target, 'panel.head')
  assert.equal(s['graph.grow'].target, 'graph.box')
  assert.equal(s['cards.squeeze'].target, 'cards.stage')
  assert.deepEqual(
    { d: s['crumb3.in'].duration, delay: s['crumb3.in'].delay }, { d: 200, delay: 60 })
  assert.equal(s['crumb3.in'].from, -12, 'the crumb arrives from the left of rest')
  assert.equal(ends(steps), 320)
})

ok('2 -> 1 reverses in 200ms with the bodies fading back over its last 120', () => {
  const steps = MCPMO.timeline(2, 1, FULL)
  const s = byId(steps)
  for (const id of ['head.flip', 'graph.shrink', 'cards.expand']) {
    assert.deepEqual({ d: s[id].duration, delay: s[id].delay }, { d: 200, delay: 0 }, id)
  }
  assert.deepEqual(
    { d: s['body.in'].duration, delay: s['body.in'].delay }, { d: 120, delay: 80 })
  assert.equal(ends(steps), 200)
})

ok('level 2 timelines flatten under reduced motion too', () => {
  for (const pair of [[1, 2], [2, 1]]) {
    for (const s of MCPMO.timeline(pair[0], pair[1], STILL)) {
      assert.equal(s.duration, 0, s.id)
      assert.equal(s.delay, 0, s.id)
    }
  }
})

ok('retargetSteps is a cross-fade in place: no flip, no slide', () => {
  const steps = MCPMO.retargetSteps(FULL)
  assert.ok(steps.length > 0)
  for (const s of steps) {
    assert.ok(MCPMO.TARGETS.includes(s.target), s.id + ' has an unknown target ' + s.target)
    assert.equal(s.property, 'opacity', s.id)
    assert.equal(s.duration, 120, s.id)
    assert.equal(s.delay, 0, s.id)
  }
})

ok('chipSlots: equal widths across the strip, in order, at the row height', () => {
  const slots = MCPMO.chipSlots(4, 800)
  assert.equal(slots.length, 4)
  for (const s of slots) { assert.equal(s.h, MCPMO.CHIP_ROW_H); assert.equal(s.w, 195.5) }
  assert.deepEqual(slots.map((s) => s.x), [0, 201.5, 403, 604.5])
})

ok('chipSlots: a strip too narrow for the minimum overflows rather than shrinking', () => {
  const slots = MCPMO.chipSlots(20, 400)
  assert.equal(slots.length, 20)
  for (const s of slots) assert.equal(s.w, 96)
  assert.ok(slots[19].x + slots[19].w > 400, 'the strip scrolls; a chip is never illegible')
})

ok('chipSlots: nothing to lay out is an empty list, never a throw', () => {
  assert.deepEqual(MCPMO.chipSlots(0, 800), [])
  assert.deepEqual(MCPMO.chipSlots(3, 0), [])
  assert.deepEqual(MCPMO.chipSlots(null, null), [])
})

ok('the panel rail and chip row in projects.css agree with the constants', () => {
  const css = read('projects.css')
  const r = css.match(/\.pjpanels\.deep[^{]*\{[^}]*grid-template-columns:\s*(\d+)px/)
  assert.ok(r, '.pjpanels.deep must declare the panel rail width')
  assert.equal(Number(r[1]), MCPMO.PANEL_RAIL_W)
  const c = css.match(/\.pjwtstage\.chips[^{]*\{[^}]*height:\s*(\d+)px/)
  assert.ok(c, '.pjwtstage.chips must declare the chip row height')
  assert.equal(Number(c[1]), MCPMO.CHIP_ROW_H)
})

ok('the old collapse-in-place is gone, so there is one level-2 layout', () => {
  const css = read('projects.css')
  assert.ok(!/\.pjpanel\.collapsed/.test(css), '.collapsed must not survive')
  assert.ok(!/\.pjpanel\.wide/.test(css), '.wide must not survive')
  const js = read('projects.js')
  assert.ok(!/'collapsed'/.test(js) && !/'wide'/.test(js),
    'projects.js must not toggle the retired classes either')
})

console.log('\n=== the stage, on this view ===')

// The surface MCGS really requires of a component, read off the stage itself
// so this list cannot drift from it.
const HOOKS = (() => {
  const src = read('sandbox-stage.js')
  const m = src.match(/ENTRY_HOOKS\s*=\s*Object\.freeze\(\[([^\]]*)\]/)
  assert.ok(m, 'the stage must still declare its entry hooks in one place')
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
})()

const fakeStage = () => {
  const calls = []
  return {
    calls,
    ready: true,
    boot: (o) => { calls.push(['boot', o && o.glCanvas]); return true },
    pause: () => calls.push(['pause']),
    resume: () => calls.push(['resume']),
    register: (n) => { calls.push(['register', n]); return true },
    component: () => null,
    mount: (node, id, p, d) => { calls.push(['mount', id, d]); return true },
    setGraphIn: (node, input, level, focus) => { calls.push(['setGraphIn', level, focus]); return true },
  }
}

const el = (tag) => {
  const set = new Set()
  const n = {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, style: {},
    classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
      toggle: (c, f) => { const on = f === undefined ? !set.has(c) : !!f; if (on) set.add(c); else set.delete(c); return on } },
    appendChild (k) { this.children.push(k); return k },
    querySelector (s) { return this.children.find((k) => k.sel === s) ?? null },
    getBoundingClientRect () { return { left: 0, top: 0, width: 400, height: 240 } },
    setAttribute () {}, addEventListener () {}, removeEventListener () {}, insertAdjacentHTML () {},
  }
  return n
}

const MCGM = new Function('window', read('sandbox-math.js') + '\nreturn MCGM')({})
const MCX_FAKE = { toggle: (n, c, on) => n.classList.toggle(c, on), show: () => {}, reducedMotion: () => false }
// A fresh module each time: what it latches -- registered, failed -- is per
// page load, so a check that needs a clean one builds its own.
const makeMCPS = (mcx) => new Function('window', 'document', 'MCGM', 'MCPMO', 'MCX',
  read('projects-stage.js') + '\nreturn MCPS')(
  win, { createElement: el }, MCGM, MCPMO, mcx || MCX_FAKE)
const MCPS = makeMCPS()

ok('the card factory returns exactly the four functions the stage demands', () => {
  const entry = MCPS.cardFactory()
  for (const h of HOOKS) assert.equal(typeof entry[h], 'function', h + ' must be a function')
  assert.equal(Object.keys(entry).filter((k) => typeof entry[k] === 'function').length >= HOOKS.length, true)
})

// Every hosting path is driven against the fake stage, with the frame hook
// and the canvas injected -- which is the whole reason both are deps.
const wire = (stage, frame) => MCPS.attach({
  toast: () => {}, level: () => ({ level: 1 }), stage: () => stage,
  frame: frame || ((fn) => fn()), canvas: () => 'pj-lines',
})

ok('enter registers the component once, however many times the tab is opened', () => {
  const stage = fakeStage()
  wire(stage)
  MCPS.enter(); MCPS.enter(); MCPS.enter()
  assert.equal(stage.calls.filter((c) => c[0] === 'register').length, 1)
  assert.deepEqual(stage.calls.filter((c) => c[0] === 'register')[0], ['register', 'worktree-card'])
})

ok('every entry boots on this view\'s own canvas, never a bare resume', () => {
  const stage = fakeStage()
  wire(stage)
  MCPS.enter(); MCPS.exit(); MCPS.enter()
  const seq = stage.calls.filter((c) => ['boot', 'pause', 'resume'].includes(c[0])).map((c) => c[0])
  assert.deepEqual(seq, ['boot', 'pause', 'boot'])
  assert.equal(stage.calls.find((c) => c[0] === 'boot')[1], 'pj-lines')
  assert.ok(!seq.includes('resume'), 'a bare resume cannot know which canvas the caller wants')
})

ok('exit pauses at once but enter waits a frame, so pause can never land last', () => {
  const stage = fakeStage()
  let held = null
  wire(stage, (fn) => { held = fn })
  MCPS.enter()
  assert.deepEqual(stage.calls.map((c) => c[0]), ['register'], 'nothing booted yet')
  MCPS.exit()
  assert.deepEqual(stage.calls.map((c) => c[0]), ['register', 'pause'])
  held()
  assert.deepEqual(stage.calls.map((c) => c[0]), ['register', 'pause'],
    'a boot scheduled before the exit must not resurrect a paused stage')
})

ok('another view\'s pause, landing between the enter and the frame, is overtaken', () => {
  const stage = fakeStage()
  let held = null
  wire(stage, (fn) => { held = fn })
  MCPS.enter()
  // The Sandbox reacts to the same tab switch through a MutationObserver --
  // a microtask, which always runs before the next animation frame.
  stage.pause()
  held()
  assert.deepEqual(stage.calls.map((c) => c[0]), ['register', 'pause', 'boot'],
    'the entering view boots last, so the stage is never left stopped')
})

ok('every boot pushes the calm the reader has now, reduced motion included', () => {
  let reduced = false
  const P = makeMCPS({ ...MCX_FAKE, reducedMotion: () => reduced })
  const stage = fakeStage()
  const calms = []
  stage.setCalm = (s) => calms.push(s)
  P.attach({ toast: () => {}, stage: () => stage, frame: (fn) => fn(), canvas: () => 'pj-lines' })
  P.enter()
  reduced = true
  P.exit()
  P.enter()
  assert.deepEqual(calms, [MCGM.calmScale(MCGM.CALM_DEFAULT, false), { settle: 0, float: 0 }])
})

ok('the view redraws once when the stage becomes ready, not on every entry', () => {
  const P = makeMCPS()
  const stage = fakeStage()
  let held = null
  let renders = 0
  P.attach({ toast: () => {}, stage: () => stage, frame: (fn) => { held = fn }, canvas: () => 'pj-lines',
    render: () => { renders++ } })
  P.enter()
  assert.equal(renders, 0, 'the first render runs a frame before the boot, so it cannot be the swap')
  assert.equal(P.ready(), false)
  held()
  assert.equal(renders, 1)
  assert.equal(P.ready(), true)
  P.exit(); P.enter(); held()
  assert.equal(renders, 1, 'a stage that was already ready changes nothing worth a redraw')
})

// Two turns of the event loop: enough for a resolved or rejected import and
// every callback chained on it.
const settled = () => new Promise((r) => setTimeout(r, 0))

{
  const P = makeMCPS()
  const stage = fakeStage()
  let g = null
  let loads = 0
  P.attach({ toast: () => {}, stage: () => g, frame: (fn) => fn(), canvas: () => 'pj-lines',
    load: () => { loads++; g = stage; return Promise.resolve() } })
  P.enter()
  P.enter()
  await settled()
  ok('a view opened before any other imports the stage itself, once', () => {
    assert.equal(loads, 1, 'a second entry while the import is in flight asks for nothing more')
    assert.deepEqual(stage.calls.map((c) => c[0]), ['register', 'boot'])
    assert.equal(P.ready(), true)
  })
}

{
  const P = makeMCPS()
  const stage = fakeStage()
  let g = null
  // A real import publishes the stage only when it lands, never during the
  // call that asked for it.
  P.attach({ toast: () => {}, stage: () => g, frame: (fn) => fn(), canvas: () => 'pj-lines',
    load: () => Promise.resolve().then(() => { g = stage }) })
  P.enter()
  P.exit()
  await settled()
  ok('an import that lands after the view was left boots nothing until the next entry', () => {
    assert.deepEqual(stage.calls.map((c) => c[0]), ['register'],
      'booting now would pull the stage off whichever view is showing')
    P.enter()
    assert.deepEqual(stage.calls.map((c) => c[0]), ['register', 'boot'])
  })
}

{
  const P = makeMCPS()
  const toasts = []
  let loads = 0
  P.attach({ toast: (m) => toasts.push(m), stage: () => null, frame: (fn) => fn(), canvas: () => 'pj-lines',
    load: () => { loads++; return Promise.reject(new Error('refused')) } })
  P.enter()
  await settled()
  P.enter()
  await settled()
  ok('a refused import latches: one toast, one attempt, and the DOM stays', () => {
    assert.equal(loads, 1)
    assert.deepEqual(toasts, ['projects stage unavailable'])
    assert.equal(P.ready(), false)
  })
}

// A mount's context as the stage hands it over, cut down to what the card
// component touches.
const fakeCtx = (w, h) => {
  const ctx = {
    id: 'worktree-card', node: el('div'), w, h, dist: h / 2 / Math.tan(Math.PI / 9),
    state: {}, bodies: [], calm: { settle: 1, float: 1 },
    camera: { position: { z: 0 }, far: 1e9, updateProjectionMatrix () {} },
  }
  ctx.body = (seed, o) => {
    const b = {
      seed, amp: o.amp, omega: o.omega, object: o.object, x: o.x, y: o.y, tx: o.x, ty: o.y,
      to (x, y) { this.tx = x; this.ty = y },
      snap (x, y) { this.x = this.tx = x; this.y = this.ty = y },
    }
    ctx.bodies.push(b)
    return b
  }
  ctx.dropBody = (b) => { ctx.bodies.splice(ctx.bodies.indexOf(b), 1) }
  ctx.panel = (element) => ({ element, rotation: { x: 0, y: 0 }, removeFromParent () {} })
  return ctx
}
const specOf = (filled) => ({ key: (w) => w.k, create: () => el('div'), update: (n, w) => filled.push(w.k) })
const CARD_W = MCPMO.CARD_W

console.log('\n=== the card grid: every card at full size ===')

// The reach a card tilted to the maximum gains, measured rather than derived:
// every corner of the drawn card, under both rotation orders, projected
// through a camera at `dist`, against where that corner sits flat. The
// largest step outward along either axis is the answer.
const tiltReach = (dist) => {
  const aw = MCPMO.CARD_W / 2 + MCPMO.CARD_FRAME
  const ah = MCPMO.CARD_H / 2 + MCPMO.CARD_FRAME
  const t = MCPMO.CARD_TILT * Math.PI / 180
  let out = 0
  for (const a of [-t, 0, t]) for (const b of [-t, 0, t]) for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const x = sx * aw
    const y = sy * ah
    const xFirst = { x: x * Math.cos(b), y: y * Math.cos(a) + x * Math.sin(b) * Math.sin(a),
      z: y * Math.sin(a) - x * Math.sin(b) * Math.cos(a) }
    const yFirst = { x: x * Math.cos(b) + y * Math.sin(a) * Math.sin(b), y: y * Math.cos(a),
      z: -x * Math.sin(b) + y * Math.sin(a) * Math.cos(b) }
    for (const p of [xFirst, yFirst]) {
      const k = dist / (dist - p.z)
      out = Math.max(out, Math.abs(p.x * k) - aw, Math.abs(p.y * k) - ah)
    }
  }
  return out
}
// The stage's camera distance for a mount of this height: the stylesheet's
// floor included, since that is the height it is drawn at.
const distFor = (height) =>
  Math.max(MCPMO.MOUNT_MIN_H, height) / 2 / Math.tan((MCPMO.STAGE_FOV / 2) * Math.PI / 180)
// The widest float any calm setting applies.
const CEIL = Math.max(1, ...MCGM.CALM.map((n) => MCGM.calmScale(n, false).float))

ok('cardGrid: no two slots closer than a card plus the gap on either axis', () => {
  for (const n of [1, 2, 3, 5, 12, 40]) {
    for (const width of [150, 240, 480, 520, 800, 1400]) {
      const g = MCPMO.cardGrid(n, width, CEIL)
      assert.equal(g.slots.length, n)
      assert.ok(g.rows * g.cols >= n)
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = Math.abs(g.slots[i].x - g.slots[j].x)
          const dy = Math.abs(g.slots[i].y - g.slots[j].y)
          assert.ok(dx >= MCPMO.CARD_W + MCPMO.CARD_GAP - 1e-9 || dy >= MCPMO.CARD_H + MCPMO.CARD_GAP - 1e-9,
            n + ' cards at ' + width + 'px: slots ' + i + ' and ' + j)
        }
      }
    }
  }
})

ok('cardGrid: as many columns as the width holds, at least one, never an empty one', () => {
  const pitch = MCPMO.CARD_W + MCPMO.CARD_GAP
  assert.equal(MCPMO.cardGrid(12, pitch * 3, 1).cols, 3)
  assert.equal(MCPMO.cardGrid(12, pitch * 3 - 1, 1).cols, 2)
  assert.equal(MCPMO.cardGrid(12, 10, 1).cols, 1, 'a panel narrower than a card still gets one column')
  assert.equal(MCPMO.cardGrid(2, pitch * 5, 1).cols, 2)
  const g = MCPMO.cardGrid(7, pitch * 3, 1)
  assert.deepEqual({ cols: g.cols, rows: g.rows }, { cols: 3, rows: 3 })
})

ok('cardGrid: the height is the rows plus the padding, and every drawn card stays inside', () => {
  const pad = MCPMO.CARD_GAP / 2
  const width = 3 * (MCPMO.CARD_W + MCPMO.CARD_GAP) + 50
  for (const n of [1, 4, 9]) {
    const g = MCPMO.cardGrid(n, width, CEIL)
    assert.equal(g.height, g.rows * MCPMO.CARD_H + (g.rows - 1) * MCPMO.CARD_GAP + 2 * pad)
    const reach = MCPMO.CARD_FRAME + g.amp * CEIL + tiltReach(distFor(g.height))
    for (const s of g.slots) {
      assert.ok(s.x - MCPMO.CARD_W / 2 - reach >= -1e-9, 'left edge, ' + n + ' cards')
      assert.ok(s.x + MCPMO.CARD_W / 2 + reach <= width + 1e-9, 'right edge, ' + n + ' cards')
      assert.ok(s.y - MCPMO.CARD_H / 2 - reach >= -1e-9, 'top, ' + n + ' cards')
      assert.ok(s.y + MCPMO.CARD_H / 2 + reach <= g.height + 1e-9, 'bottom, ' + n + ' cards')
    }
  }
})

ok('cardGrid: the float can never bring two cards into contact, tilted or not', () => {
  const clear = MCPMO.CARD_GAP - 2 * MCPMO.CARD_FRAME
  for (const n of [1, 2, 6, 30]) {
    const g = MCPMO.cardGrid(n, 600, CEIL)
    assert.ok(g.amp > 0, 'a card at rest still floats, ' + n + ' cards')
    assert.ok(2 * (g.amp * CEIL + tiltReach(distFor(g.height))) <= clear + 1e-9, n + ' cards')
  }
  const a = MCPMO.cardGrid(4, 600, 1).amp
  const b = MCPMO.cardGrid(4, 600, CEIL).amp
  assert.ok(Math.abs(a / CEIL - b) < 1e-9, 'the widest calm setting spends the bound, and every other stays inside it')
})

ok('cardGrid: no cards or no width is an empty grid, never a throw', () => {
  const empty = { cols: 0, rows: 0, slots: [], height: 0, amp: 0 }
  assert.deepEqual(MCPMO.cardGrid(0, 800, 1), empty)
  assert.deepEqual(MCPMO.cardGrid(5, 0, 1), empty)
  assert.deepEqual(MCPMO.cardGrid(null, undefined), empty)
})

ok('chipSpan: the strip is as wide as its chips at their narrowest, so it scrolls', () => {
  const s = MCPMO.chipSlots(9, 1)
  assert.equal(MCPMO.chipSpan(9), s[8].x + s[8].w)
  assert.equal(MCPMO.chipSpan(0), 0)
})

ok('the card, its frame and its mount in projects.css agree with the constants', () => {
  const css = read('projects.css')
  const card = css.match(/\.pjwtcard\s*\{[^}]*width:\s*(\d+)px;\s*height:\s*(\d+)px/)
  assert.ok(card, '.pjwtcard must declare its width and height')
  assert.deepEqual([Number(card[1]), Number(card[2])], [MCPMO.CARD_W, MCPMO.CARD_H])
  const frame = css.match(/\.pjwtframe\s*\{[^}]*left:\s*-(\d+)px;\s*top:\s*-(\d+)px/)
  assert.ok(frame, '.pjwtframe must sit past the border')
  assert.deepEqual([Number(frame[1]), Number(frame[2])], [MCPMO.CARD_FRAME + 1, MCPMO.CARD_FRAME + 1],
    'the frame reach, plus the one-pixel border it is measured from')
  const mount = css.match(/\.pjwtstage\s*\{[^}]*min-height:\s*(\d+)px/)
  assert.ok(mount, '.pjwtstage must keep its floor')
  assert.equal(Number(mount[1]), MCPMO.MOUNT_MIN_H)
  assert.ok(/\.pjwtstage\s*\{[^}]*height:\s*var\(--pj-wt-h/.test(css), 'the mount takes its height from the grid')
  assert.ok(/\.pjwtstage\.chips[^{]*\{[^}]*width:\s*var\(--pj-chips-w/.test(css), 'and in the strip its width from the chips')
  const js = read('projects.js')
  assert.ok(js.includes("setProperty('--pj-wt-h'") && js.includes("setProperty('--pj-chips-w'"),
    'custom properties: a level change clears the inline sizes it wrote')
  const fov = read('sandbox-stage.js').match(/const FOV_DEG = (\d+)/)
  assert.equal(Number(fov[1]), MCPMO.STAGE_FOV, 'the tilt reach is taken through the stage\'s own camera')
})

ok('a new stage card is filled as it is built, and starts at the mount\'s left edge', () => {
  const entry = MCPS.cardFactory()
  const ctx = fakeCtx(800, 400)
  const filled = []
  entry.mount(ctx)
  entry.update(ctx, { spec: specOf(filled), chips: false }, [{ k: 'a' }, { k: 'b' }])
  assert.deepEqual(filled, ['a', 'b'], 'a card left empty until the next payload is a blank box')
  assert.equal(ctx.bodies.length, 2)
  for (const b of ctx.bodies) {
    assert.equal(b.x, -ctx.w / 2 - CARD_W / 2, 'it settles in from the rail\'s side')
    assert.equal(b.y, 0)
    assert.equal(b.omega, MCPMO.CARD_OMEGA)
  }
  assert.equal(ctx.bodies[0].tx, -ctx.bodies[1].tx, 'and heads for a slot on the centred grid')
  assert.ok(ctx.bodies[0].tx > ctx.bodies[0].x)
  entry.update(ctx, { spec: specOf(filled), chips: false }, [{ k: 'a' }, { k: 'b' }])
  assert.equal(ctx.bodies.length, 2, 'a card seen before is rewritten in place, never rebuilt')
  assert.equal(ctx.bodies[0].x, -ctx.w / 2 - CARD_W / 2, 'and does not jump back to the edge')
  ctx.camera.position.z = ctx.dist
  entry.frame(ctx, 0, 1 / 60)
  assert.equal(ctx.camera.position.z, ctx.dist, 'the camera stays at one pixel a unit')
  assert.ok(!/\.camera\b/.test(read('projects-stage.js')),
    'nothing in this view moves the camera, so no card is ever drawn shrunk')
  const g = MCPMO.cardGrid(2, ctx.w, CEIL)
  assert.ok(ctx.bodies.every((b) => b.amp === g.amp && b.amp > 0), 'at rest they float, inside the grid\'s bound')
})

ok('at the middle level the cards lie on the card grid, centred on the mount', () => {
  const entry = MCPS.cardFactory()
  const ctx = fakeCtx(560, 400)
  const list = [1, 2, 3, 4, 5].map((i) => ({ k: 'w' + i }))
  entry.mount(ctx)
  entry.update(ctx, { spec: specOf([]), chips: false }, list)
  const g = MCPMO.cardGrid(5, 560, CEIL)
  assert.ok(g.rows > 1, 'enough cards to need a second row')
  assert.deepEqual(ctx.bodies.map((b) => [b.tx, b.ty]), g.slots.map((s) => [s.x - 280, s.y - g.height / 2]))
})

ok('at the deepest level the cards lie on the chip slots, sized by a class, never scaled', () => {
  const entry = MCPS.cardFactory()
  const ctx = fakeCtx(800, 28)
  const filled = []
  const list = [{ k: 'a' }, { k: 'b' }, { k: 'c' }, { k: 'd' }]
  entry.mount(ctx)
  entry.update(ctx, { spec: specOf(filled), chips: false }, list)
  entry.update(ctx, { spec: specOf(filled), chips: true }, list)
  const slots = MCPMO.chipSlots(4, 800)
  assert.deepEqual(ctx.bodies.map((b) => b.tx), slots.map((s) => s.x + s.w / 2 - 400),
    'measured from the mount\'s left edge, as the strip is')
  assert.ok(ctx.bodies.every((b) => b.ty === 0))
  ctx.bodies.forEach((b, i) => {
    assert.ok(b.object.element.classList.contains('chip'))
    assert.equal(b.object.element.style.width, slots[i].w + 'px')
  })
  entry.frame(ctx, 0, 1 / 60)
  assert.ok(ctx.bodies.every((b) => b.amp === 0), 'a strip of chips does not drift')
  entry.update(ctx, { spec: specOf(filled), chips: false }, list)
  for (const b of ctx.bodies) {
    assert.ok(!b.object.element.classList.contains('chip'), 'flipping back re-lays at once')
    assert.equal(b.object.element.style.width, '')
  }
  assert.ok(!/\.scale\b/.test(read('projects-stage.js')), 'nothing in the card component writes a scale')
})

ok('the stage forwards a graph level to one mount, and leaves the stage-wide record alone', () => {
  const src = read('sandbox-stage.js')
  const at = src.indexOf('setGraphIn(node, input, level, focus) {')
  assert.ok(at > 0, 'MCGS.setGraphIn must exist')
  const body = src.slice(at, src.indexOf('\n  },', at))
  assert.ok(body.includes('mounts.get(node)'))
  assert.ok(!/graph\.(input|level|focus)\s*=/.test(body), 'the gallery\'s own level must not move')
})

console.log('\n=== the graph panel ===')

const PROJ = { key: 'p1', name: 'one', isGit: true, gitGraph: { base: 'main', branches: [] }, worktrees: [] }
const at = (stage, L, selected) => { wire(stage); MCPS.enter(); return MCPS.sync(el('div'), 'graph', PROJ, L, selected) }

ok('level 1 puts this view\'s graph at the worktrees level, for this project only', () => {
  const stage = fakeStage()
  assert.equal(at(stage, { level: 1, project: 'p1', branch: null }), true)
  const m = stage.calls.find((c) => c[0] === 'mount')
  assert.deepEqual([m[0], m[1]], ['mount', 'git-graph'])
  assert.deepEqual(m[2], [PROJ], 'the isolated project goes through unreshaped')
  assert.deepEqual(stage.calls.find((c) => c[0] === 'setGraphIn'),
    ['setGraphIn', 'worktrees', { project: 'p1', branch: null }])
})

ok('level 2 drives it to commits for the chosen branch', () => {
  const stage = fakeStage()
  at(stage, { level: 2, project: 'p1', branch: 'feat/x' })
  assert.deepEqual(stage.calls.find((c) => c[0] === 'setGraphIn'),
    ['setGraphIn', 'commits', { project: 'p1', branch: 'feat/x' }])
})

ok('level 2 with no branch chosen stays at the worktrees level', () => {
  const stage = fakeStage()
  at(stage, { level: 2, project: 'p1', branch: null })
  assert.equal(stage.calls.find((c) => c[0] === 'setGraphIn')[1], 'worktrees')
})

ok('level 1 with a selection forwards commits for it', () => {
  const stage = fakeStage()
  assert.equal(at(stage, { level: 1, project: 'p1', branch: null }, 'feat/x'), true)
  assert.deepEqual(stage.calls.find((c) => c[0] === 'setGraphIn'),
    ['setGraphIn', 'commits', { project: 'p1', branch: 'feat/x' }])
})

ok('changing the selection forwards the graph once more', () => {
  const stage = fakeStage()
  wire(stage)
  MCPS.enter()
  const node = el('div')
  const L = { level: 1, project: 'p1', branch: null }
  MCPS.sync(node, 'graph', PROJ, L, 'feat/x')
  MCPS.sync(node, 'graph', PROJ, L, 'feat/y')
  const calls = stage.calls.filter((c) => c[0] === 'setGraphIn')
  assert.equal(calls.length, 2, 'a changed selection re-lays once more')
  assert.deepEqual(calls[1], ['setGraphIn', 'commits', { project: 'p1', branch: 'feat/y' }])
})

ok('the same state twice forwards the graph nothing new', () => {
  const stage = fakeStage()
  wire(stage)
  MCPS.enter()
  const node = el('div')
  const L = { level: 1, project: 'p1', branch: null }
  MCPS.sync(node, 'graph', PROJ, L, 'feat/x')
  const took = MCPS.sync(node, 'graph', PROJ, L, 'feat/x')
  assert.equal(took, true, 'the mount still takes it, through update-in-place')
  assert.equal(stage.calls.filter((c) => c[0] === 'setGraphIn').length, 1,
    'an unchanged triple reaches the graph only through mount')
})

ok('the per-mount forward is used, never the stage-wide one', () => {
  const stage = fakeStage()
  stage.setGraph = () => { throw new Error('stage-wide setGraph would walk the gallery\'s graph too') }
  assert.equal(at(stage, { level: 1, project: 'p1', branch: null }), true)
})

ok('a stage that is not ready, or too old to place one mount, takes nothing', () => {
  const cold = fakeStage()
  cold.ready = false
  assert.equal(at(cold, { level: 1, project: 'p1', branch: null }), false)
  assert.equal(cold.calls.filter((c) => c[0] === 'mount').length, 0)
  const old = fakeStage()
  delete old.setGraphIn
  assert.equal(at(old, { level: 1, project: 'p1', branch: null }), false)
})

ok('the graph mount has a floor of its own, not the cards\' custom property', () => {
  const css = read('projects.css')
  const floor = css.match(/\.pj-graph \.pjwtstage\s*\{[^}]*height:\s*(\d+)px/)
  assert.ok(floor, 'the graph mount needs a fixed height, never the cards\' variable')
  const h = Number(floor[1])
  assert.ok(h >= 300 && h <= 360, 'a sensible minimum for a scene, not a card grid\'s floor')
})

ok('the deepest level lets the graph mount fill the panel\'s own grid area', () => {
  const css = read('projects.css')
  assert.ok(css.includes('.pjpanels.deep > .pj-graph > .pjbody > .pjwtstage,') &&
    css.includes('.pjpanels.deep > .pj-graph > .pjbody > .pjlist { flex: 1;'),
    'the mount and its text fallback both take the panel\'s leftover height there')
})

ok('the graph mount is never sized with an inline style, which a settle would clear', () => {
  const js = read('projects.js')
  const start = js.indexOf('graph: (body, r) => {')
  const end = js.indexOf('\n  }\n\n  const PANEL = {')
  assert.ok(start > 0 && end > start, 'PANEL_BODY.graph must still close just above PANEL')
  assert.ok(!js.slice(start, end).includes('.style.'), 'its sizing lives in the stylesheet instead')
})

ok('a width change with no payload keeps the worktrees mount right, without a render', () => {
  const js = read('projects.js')
  const m = js.match(/new ResizeObserver\(\(\) => \{([\s\S]*?)\}\)/)
  assert.ok(m, 'an observer keeps --pj-wt-h current between renders')
  assert.ok(m[1].includes('--pj-wt-h') && m[1].includes('cardGrid'), 'it re-applies the grid height')
  assert.ok(!/\brender\(|\bdraw\(/.test(m[1]), 'never a render from inside the observer')
  assert.ok(!/ResizeObserver/.test(read('projects-stage.js')), 'and never from inside a stage frame')
})

ok('the graph panel\'s head says which it is showing, when it has something to say', () => {
  const css = read('projects.css')
  assert.ok(css.includes('.pjpanel.pj-graph > h3[data-note]:not([data-note=""])::after'),
    'the note styling reaches the graph\'s own head only')
  const js = read('projects.js')
  assert.ok(js.includes("if (r.k === 'graph') MCX.setAttr(sec.querySelector('h3'), 'data-note', graphNote)"),
    'every path through PANEL_BODY.graph sets graphNote before this line runs')
})

console.log('\n=== reduced motion, and the fallback ladder ===')

// A transition shorthand's parts: split on the commas between them, never on
// the ones inside an easing's own parentheses.
const partsOf = (css) => css.split(/,(?![^(]*\))/).map((s) => s.trim())

ok('cssFallback carries the same numbers the library path uses', () => {
  const css = MCPMO.cssFallback(MCPMO.timeline(0, 1, FULL))
  assert.equal(css.rows, 'transform 320ms cubic-bezier(.45, 0, .25, 1) 40ms')
  assert.ok(css.panel.includes('200ms'))
  assert.ok(css.panel.includes(MCPMO.EASE.arrival))
  assert.ok(css['row.metrics'].startsWith('opacity 120ms linear'))
})

ok('cssFallback at zero duration is no transition at all, not a 0ms one', () => {
  assert.deepEqual(MCPMO.cssFallback(MCPMO.timeline(0, 1, STILL)), {})
  assert.deepEqual(MCPMO.cssFallback([]), {})
})

ok('cssFallback folds several steps on one target into one shorthand', () => {
  const css = MCPMO.cssFallback(MCPMO.timeline(1, 0, FULL))
  assert.deepEqual(partsOf(css.panel),
    ['transform 120ms cubic-bezier(.45, 0, .25, 1)', 'opacity 120ms linear'],
    'a departure both drifts and fades')
})

ok('cssFallback: an arrival fades in beside its travel, and a resized box carries its sides', () => {
  const arrive = MCPMO.timeline(0, 1, FULL).find((s) => s.id === 'panel.in:todos')
  assert.equal(MCPMO.cssFallback([arrive]).panel,
    'transform 200ms cubic-bezier(.2, .7, .3, 1) 200ms, opacity 200ms cubic-bezier(.2, .7, .3, 1) 200ms')
  const drift = MCPMO.timeline(1, 0, FULL).find((s) => s.id === 'panel.out')
  assert.equal(MCPMO.cssFallback([drift]).panel, 'transform 120ms cubic-bezier(.45, 0, .25, 1)',
    'a drift away from rest has a fade of its own')
  const grow = MCPMO.timeline(1, 2, FULL)
  assert.deepEqual(partsOf(MCPMO.cssFallback(grow, { 'graph.box': ['width', 'height'] })['graph.box']), [
    'transform 260ms cubic-bezier(.45, 0, .25, 1) 60ms',
    'width 260ms cubic-bezier(.45, 0, .25, 1) 60ms',
    'height 260ms cubic-bezier(.45, 0, .25, 1) 60ms',
  ])
  assert.equal(MCPMO.cssFallback(grow)['graph.box'], 'transform 260ms cubic-bezier(.45, 0, .25, 1) 60ms')
})

ok('the calm dial is read live, not captured at load', () => {
  const js = read('projects.js')
  assert.ok(/MCX\.reducedMotion\(\)/.test(js),
    'the transition must ask the media query, never a cached answer')
  assert.ok(!/const\s+reduced\s*=\s*MCX\.reducedMotion\(\)/.test(js),
    'a module-scope capture would outlive the reader changing the setting')
})

ok('the view never reaches the Motion bundle except through the parked names', () => {
  const js = read('projects.js')
  assert.ok(!/from 'motion'/.test(js), 'a classic script cannot import a bare specifier')
  assert.ok(/window\.MCPMO_LIB/.test(js))
})

ok('the stylesheet declares no transition on anything a level change moves', () => {
  const css = read('projects.css').replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '')
  const moved = /pjfall|\.pj(row|panel|panels|cr|scope|counts|body|list|wtstage|wt)\b|\bh3\b/
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!moved.test(m[1])) continue
    assert.ok(!/transition/.test(m[2]), m[1].trim() + ' declares a transition: standing on the node, ' +
      'it would animate each starting state as the script writes it, and a FLIP would start where it lands')
  }
})

console.log('\n=== the key table ===')

const NORMAL = { mode: 'normal', level: 1, pending: '' }
const act = (key, over, st) => MCPMO.keyAction({ key, shiftKey: false, altKey: false,
  metaKey: false, ctrlKey: false, ...over }, st || NORMAL)

ok('h and l move along depth; j and k move within the column', () => {
  assert.equal(act('l').action, 'in')
  assert.equal(act('Enter').action, 'in')
  assert.equal(act('h').action, 'out')
  assert.equal(act('j').action, 'next')
  assert.equal(act('ArrowDown').action, 'next')
  assert.equal(act('k').action, 'prev')
  assert.equal(act('ArrowUp').action, 'prev')
  assert.equal(act(' ').action, 'select')
})

ok('g arms, gg is the first item, and g then anything else is the git lens', () => {
  const first = act('g')
  assert.equal(first.action, null)
  assert.equal(first.pending, 'g')
  assert.equal(MCPMO.keyAction({ key: 'g' }, { ...NORMAL, pending: 'g' }).action, 'first')
  const resolved = MCPMO.keyAction({ key: 'j' }, { ...NORMAL, pending: 'g' })
  assert.equal(resolved.action, 'lens:git', 'the lens key still works')
  assert.equal(resolved.pending, '')
  assert.equal(MCPMO.keyAction({ key: 'Escape' }, { ...NORMAL, pending: 'g' }).action, null,
    'escape disarms without acting')
  assert.equal(act('G', { shiftKey: true }).action, 'last')
})

ok('the other lens and triage keys are unchanged', () => {
  assert.equal(act('s').action, 'lens:sessions')
  assert.equal(act('t').action, 'lens:todos')
  assert.equal(act('e').action, 'lens:efforts')
  assert.equal(act('n').action, 'triage:next')
  assert.equal(act('p').action, 'triage:prev')
})

ok('r reads the isolated project again and shift-R its graph and steps too, only inside a project', () => {
  assert.equal(act('r').action, 'refresh')
  assert.equal(act('R', { shiftKey: true }).action, 'refresh:all')
  assert.equal(act('R', { shiftKey: true }, { mode: 'normal', level: 2, pending: '' }).action, 'refresh:all')
  assert.equal(act('R', { shiftKey: true, altKey: true }).action, null, 'alt keeps its pointer meaning')
  const top = { mode: 'normal', level: 0, pending: '' }
  assert.equal(act('r', {}, top).action, null, 'the overview reads the digest and fetches nothing')
  assert.equal(act('R', { shiftKey: true }, top).action, null)
  assert.equal(MCPMO.keyAction({ key: 'r' }, { mode: 'filter', level: 1, pending: '' }).action, null)
  assert.equal(MCPMO.keyAction({ key: 'r' }, { mode: 'ask', level: 1, pending: '' }).action, null)
})

ok('slash enters FILTER, and FILTER swallows the letters that are modes outside it', () => {
  const f = act('/')
  assert.equal(f.action, 'filter')
  assert.equal(f.mode, 'filter')
  const inFilter = { mode: 'filter', level: 1, pending: '' }
  assert.equal(MCPMO.keyAction({ key: 's' }, inFilter).action, null)
  assert.equal(MCPMO.keyAction({ key: 'j' }, inFilter).action, null)
  const esc = MCPMO.keyAction({ key: 'Escape' }, inFilter)
  assert.equal(esc.action, 'filter:clear')
  assert.equal(esc.mode, 'normal')
})

ok('accepting a filter hands the keys back: the mode is NORMAL again', () => {
  const accept = MCPMO.keyAction({ key: 'Enter' }, { mode: 'filter', level: 0, pending: '' })
  assert.equal(accept.action, 'filter:accept')
  assert.equal(accept.mode, 'normal')
  assert.equal(MCPMO.keyAction({ key: 'j' }, { mode: accept.mode, level: 0, pending: '' }).action, 'next')
})

ok('ASK mode yields every key to the field, Escape apart', () => {
  const ask = { mode: 'ask', level: 1, pending: '' }
  for (const k of ['j', 'k', 'l', 'h', 'g', '/', ' ', 'Enter', 's', 'n']) {
    assert.equal(MCPMO.keyAction({ key: k }, ask).action, null, k + ' must reach the field')
  }
  assert.equal(MCPMO.keyAction({ key: 'Enter', metaKey: true }, ask).action, null)
  const esc = MCPMO.keyAction({ key: 'Escape' }, ask)
  assert.equal(esc.action, 'blur')
  assert.equal(esc.mode, 'normal')
})

ok('the digits are the tab switcher\'s and are never claimed here', () => {
  for (const k of ['1', '2', '3', '4', '5', '6', '7']) {
    assert.equal(act(k).action, null, k)
    assert.equal(act(k, {}, { mode: 'normal', level: 0, pending: '' }).action, null, k + ' at the overview')
  }
})

ok('command-Enter is Plan this; command-shift-Enter is the global bar, not ours', () => {
  assert.equal(act('Enter', { metaKey: true }).action, 'plan')
  assert.equal(act('Enter', { metaKey: true, shiftKey: true }).action, null)
  assert.equal(act('j', { metaKey: true }).action, null)
})

ok('a control chord is never ours, whatever the key or the mode', () => {
  for (const k of ['j', 'l', 'g', '/', 'Enter', 'Escape']) {
    assert.equal(act(k, { ctrlKey: true }).action, null, k)
    assert.equal(act(k, { ctrlKey: true }, { mode: 'filter', level: 1, pending: '' }).action, null, k + ' in FILTER')
  }
})

ok('the modified row gestures are the pointer\'s, never a keystroke\'s', () => {
  for (const k of ['j', 'l', 'Enter', ' ']) {
    assert.equal(act(k, { shiftKey: true }).action, null, 'shift ' + k)
    assert.equal(act(k, { altKey: true }).action, null, 'alt ' + k)
  }
})

ok('h and Escape at the overview yield, so they can belong to somebody else', () => {
  const top = { mode: 'normal', level: 0, pending: '' }
  assert.equal(MCPMO.keyAction({ key: 'Escape' }, top).action, null)
  assert.equal(MCPMO.keyAction({ key: 'h' }, top).action, null)
  assert.equal(MCPMO.keyAction({ key: 'Escape' }, { mode: 'normal', level: 2, pending: '' }).action, 'out')
})

ok('an unusable state reads as NORMAL at the overview, never a throw', () => {
  assert.deepEqual(MCPMO.keyAction({ key: 'j' }, null), { action: 'next', pending: '', mode: 'normal' })
  assert.equal(MCPMO.keyAction({ key: 'h' }, { mode: 'bogus', level: 'x' }).action, null)
  assert.equal(MCPMO.keyAction(null, NORMAL).action, null)
})

console.log('\n=== the view itself, under a DOM shim ===')

// projects.js loaded the way the pane loads it, beside the real reconcile.js,
// projects-model.js and projects-stage.js, and driven only through the
// listeners it binds: a row click, presses on a worktree card's head, Escape
// on the window's capture listener. The stage's import is refused and so is
// the Motion bundle's, so this is the page load with neither.
{
  // Every inline style write, in order, with each style read that makes a
  // browser compute them logged between as 'flush'.
  const log = []
  class DomEl {
    constructor (tag) {
      this.tagName = String(tag).toUpperCase()
      this.children = []; this.parentNode = null; this.dataset = {}; this.attrs = new Map()
      this.listeners = {}; this._text = ''; this.id = ''; this.hidden = false
      const self = this
      this.style = new Proxy({}, { set (o, k, v) { o[k] = v; log.push([self, k, v]); return true } })
      const set = new Set()
      this.classes = set
      this.classList = {
        contains: (c) => set.has(c),
        add: (c) => { set.add(c) },
        remove: (c) => { set.delete(c) },
        toggle: (c, force) => {
          const on = force === undefined ? !set.has(c) : !!force
          if (on) set.add(c); else set.delete(c)
          return on
        },
      }
    }
    get textContent () { return this._text }
    set textContent (v) { this._text = String(v); for (const c of this.children) c.parentNode = null; this.children = [] }
    get lastChild () { return this.children[this.children.length - 1] ?? null }
    get isConnected () { let n = this; while (n.parentNode) n = n.parentNode; return !!n.root }
    insertBefore (node, ref) {
      if (node.parentNode) node.parentNode.removeChild(node)
      const i = ref == null ? this.children.length : this.children.indexOf(ref)
      if (i < 0) throw new Error('insertBefore: the reference is not a child')
      this.children.splice(i, 0, node)
      node.parentNode = this
      return node
    }
    appendChild (n) { return this.insertBefore(n, null) }
    removeChild (n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null; return n }
    remove () { if (this.parentNode) this.parentNode.removeChild(this) }
    setAttribute (n, v) { this.attrs.set(n, String(v)) }
    removeAttribute (n) { this.attrs.delete(n) }
    getAttribute (n) { return this.attrs.has(n) ? this.attrs.get(n) : null }
    addEventListener (type, fn) { (this.listeners[type] ||= []).push(fn) }
    // Focus moves the way a browser moves it: the element losing it hears
    // blur, then the one gaining it hears focus.
    focus () {
      const was = document.activeElement
      if (was === this) return
      if (was) was.blur()
      document.activeElement = this
      for (const fn of this.listeners.focus || []) fn({ target: this })
    }
    blur () {
      if (document.activeElement !== this) return
      document.activeElement = null
      for (const fn of this.listeners.blur || []) fn({ target: this })
    }
    matches (sel) {
      const m = /^([a-z0-9]*)((?:\.[\w-]+)*)$/i.exec(sel)
      if (!m) throw new Error('the shim cannot match ' + sel)
      if (m[1] && this.tagName !== m[1].toUpperCase()) return false
      return m[2].split('.').filter(Boolean).every((c) => this.classes.has(c))
    }
    closest (sel) { for (let n = this; n; n = n.parentNode) if (n.matches(sel)) return n; return null }
    querySelector (sel) {
      for (const c of this.children) { if (c.matches(sel)) return c; const d = c.querySelector(sel); if (d) return d }
      return null
    }
    // A project row in the overview or in the rail. Nothing else is measured
    // on the paths driven here.
    getBoundingClientRect () {
      const p = this.parentNode
      const i = p ? p.children.indexOf(this) : 0
      if (p && p.id === 'pj-rail') return { left: 6, top: 40 + i * 50, width: 188, height: 48 }
      if (p && p.id === 'projlist') return { left: 214, top: 40 + i * 38, width: 800, height: 36 }
      return { left: 0, top: 0, width: 0, height: 0 }
    }
  }
  const mk = (tag, cls, text) => {
    const n = new DomEl(tag)
    for (const c of String(cls || '').split(/\s+/).filter(Boolean)) n.classList.add(c)
    if (text != null) n.textContent = text
    return n
  }
  const add = (parent, tag, cls, id) => { const n = parent.appendChild(mk(tag, cls)); n.id = id || ''; return n }
  const top = mk('html')
  top.root = true
  const body = add(top, 'body')
  Object.defineProperty(body, 'offsetWidth', { get: () => { log.push('flush'); return 1000 } })
  const view = add(body, 'section', 'view on', 'view-projects')
  add(view, 'span', 'count', 'c-projects')
  add(view, 'nav', 'pjcrumb', 'pj-crumb')
  add(view, 'span', 'pjlens', 'pj-lens')
  add(view, 'input', 'pjfilter gone', 'pj-filter')
  add(view, 'span', 'pjmode', 'pj-mode')
  const stageBox = add(view, 'div', 'pjstage', 'pj-stage')
  add(stageBox, 'canvas', '', 'pj-lines')
  add(stageBox, 'div', 'pjrail gone', 'pj-rail')
  const main = add(stageBox, 'div', 'pjmain')
  const head = add(main, 'div', 'pjhead gone', 'pj-head')
  add(head, 'span', 'pjhname', 'pj-h-name')
  add(head, 'span', 'pjhroot', 'pj-h-root')
  add(head, 'button', 'pjbtn', 'pj-ask-about')
  add(head, 'button', 'pjbtn', 'pj-open-canvas')
  add(main, 'div', 'pjcards gone', 'pj-cards')
  add(main, 'div', 'projlist', 'projlist')
  add(main, 'div', 'pjpanels gone', 'pj-panels')
  const form = add(view, 'form', 'pjask', 'pj-ask-form')
  add(form, 'span', 'pjscope gone', 'pj-scope')
  add(form, 'textarea', 'pjfield', 'pj-ask')
  add(body, 'div', '', 'settingspop').hidden = true
  add(body, 'div', '', 'linkmodal').hidden = true
  add(body, 'div', '', 'drawer')
  const find = (n, id) => {
    if (n.id === id) return n
    for (const c of n.children) { const d = find(c, id); if (d) return d }
    return null
  }
  const $id = (id) => find(top, id)
  const document = { getElementById: $id, body, activeElement: null, querySelector: () => null, createElement: (t) => mk(t) }
  const all = (n = top, out = []) => { out.push(n); for (const c of n.children) all(c, out); return out }
  const styled = () => all().filter((n) => Object.values(n.style).some((v) => v !== ''))

  const media = { reduced: true }
  const window = { matchMedia: (q) => ({ matches: media.reduced && /prefers-reduced-motion/.test(q) }) }
  let now = 0
  let seq = 0
  let timersSet = 0
  const timers = []
  const later = (fn, ms) => { timersSet++; const id = ++seq; timers.push({ id, at: now + (ms || 0), fn }); return id }
  const cancel = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) }
  const advance = (ms) => {
    const end = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id)
      const t = timers[0]
      if (!t || t.at > end) break
      timers.shift()
      now = t.at
      t.fn()
    }
    now = end
  }
  const winListeners = []

  const MCX = new Function('window', read('reconcile.js') + '\nreturn MCX')(window)
  const MCPM = new Function(read('projects-model.js') + '\nreturn MCPM')()
  // The real stage half, its import refused: `ready` stays false by its own
  // rule, `sync` refuses by its own rule, and the view's DOM is what draws.
  const stageHalf = new Function('window', 'document', 'MCGM', 'MCPMO', 'MCX',
    read('projects-stage.js') + '\nreturn MCPS')(window, document, MCGM, MCPMO, MCX)
  const stageless = {
    ...stageHalf,
    attach: (deps) => stageHalf.attach({ ...deps, load: () => Promise.reject(new Error('no stage on this page')) }),
  }
  // The command bar, with a switch standing for anything open above the view.
  const bar = { over: false, isOpen: () => bar.over, deckOpen: () => false, ask: () => {}, open: () => {} }
  const LOADER = "import('/projects-motion.js')"
  const viewSrc = read('projects.js')
  assert.equal(viewSrc.split(LOADER).length, 2, 'the view asks for the Motion bundle in exactly one place')
  // The board as the relay sends it: a digest on the stream, and each
  // project's document and history from their own read-only routes, which
  // the view asks for when it shows that project.
  const digest = (key, name) => ({
    key, name, mainRoot: '/work/' + key, isGit: true, changedAt: 1,
    counts: { inFlight: 1, backlogSections: 1, behind: 0 },
    worktrees: [
      { path: '/work/' + key, branch: 'main', head: 'a1b2c3d', isMain: true, sessions: [] },
      { path: '/work/' + key + '-feat', branch: 'feat', head: 'e4f5a6b', sessions: [] },
    ],
  })
  const documentOf = (key, name) => ({
    key, name, mainRoot: '/work/' + key, isGit: true, changedAt: 1,
    backlog: [{ id: key + ':tidy', text: 'Tidy the rail', slug: 'tidy-the-rail', rel: 'todo.md',
      body: [{ k: key + ':narrow', id: key + ':narrow', text: 'narrow the rows', checked: false, reported: false }] }],
    plans: [{ name: 'rail.md', rel: 'rail.md', title: 'The rail' }],
    efforts: [{ name: 'rail.md', title: 'The rail', rel: 'rail.md', at: 'main', done: 1, total: 3, live: true }],
    specs: [{ name: 'rail-notes.md', rel: 'rail-notes.md', title: 'Rail notes' }],
    features: [{ rel: 'CHANGES.md', slug: 'the-rail', name: 'The rail' }],
  })
  const history = () => ({ base: 'main', branches: [
    { name: 'main', isMain: true, head: 'a1b2c3d',
      commits: [{ sha: 'a1b2c3d4e5', subject: 'land the rail', at: 1, parents: ['0'] }] },
    { name: 'feat', head: 'e4f5a6b', ahead: 1, behind: 0,
      commits: [{ sha: 'e4f5a6b7c8', subject: 'narrow the rows', at: 2, parents: ['a1b2c3d4e5'] }] },
  ] })
  const NAMES = { alpha: 'Alpha', beta: 'Beta' }
  const asked = []
  const answer = (status, body) => Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(body) })
  const fetchRoute = (url) => {
    const u = String(url)
    asked.push(u)
    if (/^\/api\/projects\/graph\?key=(alpha|beta)$/.test(u)) return answer(200, { gitGraph: history() })
    const one = /^\/api\/projects\/(alpha|beta)$/.exec(u)
    if (one) return answer(200, { project: documentOf(one[1], NAMES[one[1]]) })
    return answer(404, null)
  }

  const MCP = new Function('window', 'document', 'addEventListener', 'requestAnimationFrame', 'fetch',
    'setTimeout', 'clearTimeout', 'getComputedStyle',
    'MCX', 'MCPM', 'MCPMO', 'MCPS', 'MCQ', 'MCC', 'MCD', 'MCG', 'MCGM',
    viewSrc.replace(LOADER, "Promise.reject(new Error('no bundle on this page'))") + '\nreturn MCP')(
    window, document, (type, fn, capture) => winListeners.push({ type, fn, capture: capture === true }),
    () => 0, fetchRoute, later, cancel,
    () => ({ gridTemplateColumns: 'none', gridTemplateRows: 'none' }),
    MCX, MCPM, MCPMO, stageless, bar,
    { spotlight: () => {} }, { openThread: () => {} }, { calm: () => MCGM.CALM_DEFAULT }, MCGM)

  const S = { projects: [digest('alpha', 'Alpha'), digest('beta', 'Beta')], sessions: [] }
  const toasts = []

  // Every reconcile, wherever it runs, reports what it had to build.
  const built = []
  const reconcile = MCX.reconcile
  MCX.reconcile = (parent, data, spec) => {
    const res = reconcile(parent, data, spec)
    if (res.entered.length) built.push((parent.id || [...parent.classes].join('.')) + ' +' + res.entered.length)
    return res
  }

  MCP.attach({ S, post: async () => ({}), toast: (m) => toasts.push(m), el: mk, ago: () => 'just now', needsOf: () => false })
  MCP.setView('projects')
  await settled()

  const panels = $id('pj-panels')
  const sections = [...panels.children]
  const rows = (id) => $id(id).children.filter((n) => MCX.keyOf(n) !== undefined)
  const rowOf = (key) => [...rows('projlist'), ...rows('pj-rail')].find((n) => MCX.keyOf(n) === key)
  const panel = (k) => panels.children.find((n) => n.classes.has('pj-' + k))
  const bodyOf = (k) => panel(k).querySelector('.pjbody')
  const cardOf = (branch) => bodyOf('worktrees').querySelector('.pjlist').children
    .find((c) => c.querySelector('.wtbranch').textContent === branch)
  const click = (n) => n.listeners.click[0]({ target: n, shiftKey: false, altKey: false, metaKey: false, preventDefault () {} })
  const escape = () => {
    let acted = false
    for (const l of winListeners) {
      if (l.type === 'keydown' && l.capture) l.fn({ key: 'Escape', stopImmediatePropagation () { acted = true } })
    }
    return acted
  }
  const crumbAt = (i) => $id('pj-crumb').children[i]
  let checkedSections = 0
  const sameSections = (when) => {
    assert.deepEqual([...panels.children], sections, 'the four panel sections were replaced ' + when)
    checkedSections++
  }

  ok('at the overview the four panels are already there, hidden, before anything is isolated', () => {
    assert.equal(rows('projlist').length, 2)
    assert.deepEqual(sections.map((s) => [...s.classes].find((c) => c.startsWith('pj-'))),
      MCPM.panelOrder('sessions').map((k) => 'pj-' + k))
    assert.ok(panels.classes.has('gone'))
  })

  ok('a refused Motion bundle marks the view, and a stage that never readies says so once', () => {
    assert.ok($id('view-projects').classes.has('pjfall'), 'the mark goes on the view, which holds the crumb and the chip')
    assert.deepEqual(toasts, ['projects stage unavailable'])
  })

  // In and out once: a row click to the middle level, a press that selects a
  // worktree and a second that opens its branch, then Escape twice.
  const walk = async (key) => {
    click(rowOf(key))
    assert.ok(!panels.classes.has('gone') && !$id('pj-rail').classes.has('gone'), 'a row click isolates ' + key)
    sameSections('by the isolate')
    // Whatever the isolate asked the routes for lands before the walk goes on.
    await settled()
    sameSections('once the project\'s document and history have landed')
    click(cardOf('feat').querySelector('.pjwthead'))
    assert.ok(cardOf('feat').classes.has('lit') && crumbAt(4).classes.has('gone'), 'the first press only selects')
    sameSections('by the selection')
    click(cardOf('feat').querySelector('.pjwthead'))
    assert.ok(panels.classes.has('deep') && !crumbAt(4).classes.has('gone'), 'the second press opens the branch')
    sameSections('going deeper')
    assert.ok(escape(), 'escape steps back from the branch')
    assert.ok(!panels.classes.has('deep') && !panels.classes.has('gone'), 'back at the middle level')
    sameSections('coming back up')
    assert.ok(escape(), 'escape steps back to the overview')
    assert.ok(panels.classes.has('gone') && $id('pj-rail').classes.has('gone') && rows('projlist').length === 2,
      'back at the overview')
    sameSections('at the overview again')
  }

  built.length = 0
  log.length = 0
  asked.length = 0
  await walk('alpha')
  const first = built.slice()
  const firstAsked = asked.slice()

  ok('a first run in and out builds that project\'s own rows, the first time its data is drawn', () => {
    assert.ok(first.length > 0, 'the recorder sees what is built, so an empty second run is a measurement')
  })

  ok('the first isolate asks for the project\'s document and history, and the overview asks for nothing', () => {
    assert.deepEqual([...firstAsked].sort(), ['/api/projects/alpha', '/api/projects/graph?key=alpha'])
    const backlog = bodyOf('todos').querySelector('.pj-backlog').children
    assert.ok(backlog.some((n) => n.classes.has('pjbl')), 'the document\'s backlog is what Todos draws')
  })

  ok('with no stage the worktrees draw as a list, and the graph says it is drawn as text', () => {
    assert.ok(bodyOf('worktrees').querySelector('.pjwtstage').classes.has('gone'))
    assert.equal(bodyOf('worktrees').querySelector('.pjlist').children.length, 2)
    assert.equal(panel('graph').querySelector('h3').getAttribute('data-note'), 'drawn as text')
  })

  built.length = 0
  asked.length = 0
  await walk('alpha')

  ok('a second run in and out on the same project builds nothing: every reconcile enters nothing', () => {
    assert.deepEqual(built, [])
  })

  ok('a second run on a project read at its current changedAt asks the routes for nothing', () => {
    assert.deepEqual(asked, [])
  })

  ok('the four panel sections are the same nodes through both runs', () => {
    assert.equal(checkedSections, 12)
    assert.deepEqual([...panels.children], sections)
  })

  ok('under reduced motion every change is synchronous: no timer, no inline style written', () => {
    assert.equal(timersSet, 0)
    assert.deepEqual(log.filter((w) => w !== 'flush').map((w) => w[1] + '=' + w[2]), [])
  })

  // One node's inline writes since `from`, as `prop=value`, with every style
  // read that makes a browser compute them shown as '|'.
  const trace = (n, from) => log.slice(from).filter((w) => w === 'flush' || w[0] === n)
    .map((w) => (w === 'flush' ? '|' : w[1] + '=' + w[2]))
  const STRUCT = MCPMO.EASE.structural
  const ARRIVE = MCPMO.EASE.arrival

  media.reduced = false
  timersSet = 0
  const t0 = log.length
  click(rowOf('beta'))
  const counts = rowOf('alpha').querySelector('.pjcounts')

  ok('without the library, a first-phase fade gets its transition after its start is computed', () => {
    assert.deepEqual(trace(counts, t0), ['opacity=1', '|', 'transition=opacity 120ms linear', 'opacity=0'])
  })

  const t40 = log.length
  advance(40)

  ok('without the library, the render\'s steps get theirs on the same numbers, from the left of rest', () => {
    assert.deepEqual(trace(rowOf('alpha'), t40), [
      'transform=translate(208px, 0px)', 'width=800px', '|',
      'transition=transform 320ms ' + STRUCT + ', width 320ms ' + STRUCT,
      'transform=', 'width=188px',
    ], 'a squeezed row travels and narrows, to its size in pixels')
    assert.deepEqual(trace(panel('worktrees'), t40), [
      'transform=translateX(-16px)', 'opacity=0', '|',
      'transition=transform 200ms ' + ARRIVE + ' 120ms, opacity 200ms ' + ARRIVE + ' 120ms',
      'transform=', 'opacity=',
    ], 'the delay is counted from the render, which lands 40ms in')
    assert.deepEqual(trace(crumbAt(2), t40), [
      'transform=translateX(-12px)', 'opacity=0', '|',
      'transition=transform 200ms ' + ARRIVE + ' 120ms, opacity 200ms ' + ARRIVE + ' 120ms',
      'transform=', 'opacity=',
    ])
  })

  ok('without the library, the settle clears every transition, on the one timer it already had', () => {
    assert.equal(timers.length, 1, 'only the settle is pending once the render has landed')
    advance(1000)
    assert.equal(timers.length, 0)
    assert.deepEqual(styled().map((n) => n.id || [...n.classes].join('.')), [])
    assert.ok(rowOf('beta').classes.has('active') && rows('pj-rail').length === 2)
  })

  ok('without the library, the way out drifts and fades the panels on one shorthand, then settles clean', () => {
    const out = log.length
    assert.ok(escape())
    assert.deepEqual(trace(panel('todos'), out), [
      'transform=translateX(0px)', 'opacity=1', '|',
      'transition=transform 120ms ' + STRUCT,
      'transition=transform 120ms ' + STRUCT + ', opacity 120ms linear',
      'transform=translateX(-8px)', 'opacity=0',
    ])
    advance(1000)
    assert.equal(timers.length, 0)
    assert.deepEqual(styled().map((n) => n.id || [...n.classes].join('.')), [])
    assert.equal(rows('projlist').length, 2)
    assert.deepEqual([...panels.children], sections)
  })

  // The keys, delivered the way a browser delivers one: the window's capture
  // listeners in order, then its bubble listeners, until one stops it.
  media.reduced = true
  const ask = $id('pj-ask'), filterBox = $id('pj-filter'), modeWord = $id('pj-mode')
  const press = (key, mods) => {
    const ev = {
      key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mods,
      stopped: false, prevented: false,
      stopImmediatePropagation () { this.stopped = true },
      preventDefault () { this.prevented = true },
    }
    for (const capture of [true, false]) {
      for (const l of winListeners) if (l.type === 'keydown' && l.capture === capture && !ev.stopped) l.fn(ev)
    }
    return ev
  }
  const typeInto = (field, text) => { field.value = text; for (const fn of field.listeners.input || []) fn({ target: field }) }
  const depth = () => (panels.classes.has('gone') ? 0 : panels.classes.has('deep') ? 2 : 1)
  const keysIn = (id) => rows(id).map((n) => MCX.keyOf(n))
  const cursorIn = (id) => rows(id).filter((n) => n.classes.has('at')).map((n) => MCX.keyOf(n))
  const cardCursor = () => bodyOf('worktrees').querySelector('.pjlist').children
    .filter((c) => c.classes.has('at')).map((c) => c.querySelector('.wtbranch').textContent)

  ok('j, k, gg and G walk the overview\'s rows, and no cursor shows until a key moves it', () => {
    assert.equal(depth(), 0)
    assert.deepEqual(cursorIn('projlist'), [], 'clicks alone never draw the cursor')
    assert.ok(press('j').prevented)
    assert.deepEqual(cursorIn('projlist'), ['alpha'])
    press('j')
    assert.deepEqual(cursorIn('projlist'), ['beta'])
    press('j')
    assert.deepEqual(cursorIn('projlist'), ['beta'], 'the last row holds the cursor')
    press('k')
    assert.deepEqual(cursorIn('projlist'), ['alpha'])
    press('G', { shiftKey: true })
    assert.deepEqual(cursorIn('projlist'), ['beta'])
    assert.equal(press('g').prevented, false, 'a lone g waits for its second half')
    press('g')
    assert.deepEqual(cursorIn('projlist'), ['alpha'])
    assert.equal($id('pj-lens').textContent, 'lens · sessions', 'gg is not the git lens')
    assert.equal(press('3').prevented, false, 'a digit is the tab switcher\'s')
    assert.equal(depth(), 0)
  })

  ok('l opens the row under the cursor; inside, j walks the worktrees, space selects and l opens the branch', () => {
    assert.ok(press('l').prevented)
    assert.equal(depth(), 1)
    assert.ok(rowOf('alpha').classes.has('active'))
    assert.deepEqual(cardCursor(), ['main'], 'the cursor seats on the first worktree')
    press('j')
    assert.deepEqual(cardCursor(), ['feat'])
    assert.ok(press(' ').prevented)
    assert.ok(cardOf('feat').classes.has('lit') && depth() === 1, 'space selects without drilling')
    press('l')
    assert.equal(depth(), 2)
    assert.equal(crumbAt(4).textContent, 'feat')
    assert.deepEqual(cardCursor(), ['feat'], 'the strip keeps the cursor on the open branch')
    assert.equal(press(' ').prevented, false, 'selecting belongs to the middle level')
    assert.equal(press('l').prevented, false, 'there is nothing deeper')
    assert.equal(depth(), 2)
    press('k')
    assert.deepEqual(cardCursor(), ['main'], 'j and k still walk the strip')
    press('h')
    assert.equal(depth(), 1)
    assert.deepEqual(cardCursor(), ['feat'], 'stepping out lands on the branch just left')
    press('h')
    assert.equal(depth(), 0)
    assert.deepEqual(cursorIn('projlist'), ['alpha'], 'and out again, on the project just left')
    assert.deepEqual([...panels.children], sections)
  })

  ok('Escape with the stripe\'s field focused lets go of the field and steps nothing', () => {
    press('l')
    assert.equal(depth(), 1)
    assert.equal(modeWord.textContent, 'NORMAL')
    ask.focus()
    assert.equal(modeWord.textContent, 'ASK')
    assert.ok(modeWord.classes.has('ask'))
    assert.equal(press('j').prevented, false, 'j types into the field')
    assert.deepEqual(cardCursor(), ['main'])
    const esc = press('Escape')
    assert.ok(esc.stopped, 'this view answered it')
    assert.notEqual(document.activeElement, ask)
    assert.equal(depth(), 1, 'the first escape only leaves the field')
    assert.equal(modeWord.textContent, 'NORMAL')
    press('Escape')
    assert.equal(depth(), 0, 'the next one steps back')
  })

  ok('slash opens the filter, typing narrows the rows with no motion, and Enter hands j and k back', () => {
    assert.ok(press('/').prevented, 'the slash never lands in the field')
    assert.ok(!filterBox.classes.has('gone'))
    assert.equal(document.activeElement, filterBox)
    assert.equal(modeWord.textContent, 'FILTER')
    assert.equal(press('j').prevented, false, 'letters type into the filter')
    media.reduced = false
    const writes = log.length, timed = timersSet
    typeInto(filterBox, 'BET')
    assert.deepEqual(keysIn('projlist'), ['beta'])
    assert.deepEqual(cursorIn('projlist'), ['beta'], 'a cursor the filter hid moves to the first row left')
    typeInto(filterBox, 'zz')
    assert.deepEqual(keysIn('projlist'), ['nomatch'], 'no match says so rather than showing nothing')
    typeInto(filterBox, 'bet')
    assert.equal(timersSet, timed, 'narrowing starts nothing, with motion on')
    assert.deepEqual(log.slice(writes).filter((w) => w !== 'flush'), [], 'and writes no style')
    media.reduced = true
    assert.ok(press('Enter').prevented)
    assert.notEqual(document.activeElement, filterBox)
    assert.equal(modeWord.textContent, 'NORMAL')
    assert.ok(!filterBox.classes.has('gone'), 'an applied filter keeps its field showing')
    assert.deepEqual(keysIn('projlist'), ['beta'])
    assert.ok(press('j').prevented)
    assert.deepEqual(cursorIn('projlist'), ['beta'])
    assert.ok(press('Escape').stopped)
    assert.deepEqual(keysIn('projlist'), ['alpha', 'beta'])
    assert.ok(filterBox.classes.has('gone'))
    assert.equal(depth(), 0)
  })

  ok('an accepted filter is cleared by the first Escape, and only the second steps a level', () => {
    click(rowOf('alpha'))
    assert.equal(depth(), 1)
    press('/')
    typeInto(filterBox, 'zz')
    assert.deepEqual(keysIn('pj-rail'), ['alpha'], 'the rail narrows, and never loses the project the reader is in')
    press('Enter')
    assert.ok(press('Escape').stopped)
    assert.equal(depth(), 1, 'the first escape clears the filter')
    assert.deepEqual(keysIn('pj-rail'), ['alpha', 'beta'])
    assert.ok(filterBox.classes.has('gone'))
    assert.ok(press('Escape').stopped)
    assert.equal(depth(), 0, 'the second steps back')
  })

  ok('command-Enter and a command-click start a plan request for the project in the stripe, and drill nothing', () => {
    assert.deepEqual(cursorIn('projlist'), ['alpha'])
    assert.ok(press('Enter', { metaKey: true }).prevented)
    assert.equal(depth(), 0)
    assert.equal(document.activeElement, ask)
    assert.ok(ask.value.startsWith('Plan ') && ask.value.includes('Alpha'), ask.value)
    assert.equal($id('pj-scope').textContent, 'about Alpha')
    assert.equal(modeWord.textContent, 'ASK')
    press('Escape')
    assert.ok(press('Escape').stopped, 'the scope is an explicit one, and the next escape clears it')
    assert.ok($id('pj-scope').classes.has('gone'))
    ask.value = ''
    const row = rowOf('beta')
    row.listeners.click[0]({ target: row, shiftKey: false, altKey: false, metaKey: true, preventDefault () {} })
    assert.equal(depth(), 0, 'a command-click never isolates')
    assert.ok(ask.value.includes('Beta'), ask.value)
    assert.equal($id('pj-scope').textContent, 'about Beta')
    press('Escape')
    press('Escape')
    ask.value = ''
    assert.ok($id('pj-scope').classes.has('gone'))
  })

  ok('Enter and Space on a focused button are the button\'s, and a field that is not this view\'s takes every key', () => {
    const crumbAll = crumbAt(0)
    crumbAll.focus()
    assert.equal(press('Enter').prevented, false)
    assert.equal(press(' ').prevented, false)
    assert.equal(depth(), 0)
    assert.ok(press('j').prevented, 'the other keys still walk')
    crumbAll.blur()
    const other = add(body, 'input', '', 'elsewhere')
    other.focus()
    for (const k of ['j', 'l', '/', 'Enter']) assert.equal(press(k).prevented, false, k)
    assert.equal(press('Escape').stopped, false, 'at the overview with nothing to undo, escape falls through')
    other.blur()
    other.remove()
  })

  ok('at the middle level the Graph panel\'s title opens the branch it follows, once one is selected', () => {
    click(rowOf('alpha'))
    const title = panel('graph').querySelector('h3')
    title.listeners.click[0]({})
    assert.equal(depth(), 1, 'with nothing selected there is no branch to open')
    click(cardOf('feat').querySelector('.pjwthead'))
    title.listeners.click[0]({})
    assert.equal(depth(), 2)
    assert.equal(crumbAt(4).textContent, 'feat')
    escape()
    escape()
    assert.equal(depth(), 0)
  })

  ok('with anything open above the view no key acts, Escape included', () => {
    press('l')
    assert.equal(depth(), 1)
    const was = cardCursor()
    bar.over = true
    for (const k of ['j', 'l', 'h', '/', ' ']) assert.equal(press(k).prevented, false, k)
    assert.equal(press('Escape').stopped, false)
    assert.equal(depth(), 1)
    assert.deepEqual(cardCursor(), was)
    bar.over = false
    press('h')
    assert.equal(depth(), 0)
  })
}

console.log('\n' + pass + ' checks passed')
