#!/usr/bin/env node
// Drives bridge/public/stream.js against a FAKE EventSource.
//
// `stream.js` is a CLASSIC script (like reconcile.js, projects.js, replay.js),
// not an ES module like swarm.js, because that is what the pane loads. It is
// therefore evaluated here through `new Function` rather than imported — the
// same technique test/reconcile-harness.mjs uses — with `window` and a quiet
// `console` passed in, the latter so the module's own error reporting can be
// asserted instead of printed.
//
// The registry is module state by design, so every case gets a FRESH
// evaluation. That is cheap: the file has no I/O and no timers.
//
// There is no backoff to test. The reconnect belongs to the browser's
// EventSource, on the interval the relay dictates with its `retry: 1000` line
// — so what is pinned here is that MCE never closes or recreates the source,
// and never attaches a listener twice across a reconnect.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'syzygy', 'bridge', 'public', 'stream.js')
const src = readFileSync(SRC, 'utf8')

let pass = 0
const ok = (m) => { pass++; process.stdout.write('  ok  ' + m + '\n') }

// --- the fake EventSource ---------------------------------------------------

// `adds` counts addEventListener per name, so "attached exactly once" is a
// measurement rather than a belief — the reconnect-double-fire bug a registry
// invites is invisible any other way.
class FakeSource {
  constructor (url) {
    this.url = url
    this.readyState = 0
    this.closed = false
    this.listeners = new Map()
    this.adds = new Map()
    FakeSource.made.push(this)
  }

  addEventListener (name, fn) {
    this.adds.set(name, (this.adds.get(name) || 0) + 1)
    const l = this.listeners.get(name) || []
    l.push(fn)
    this.listeners.set(name, l)
  }

  close () { this.closed = true; this.readyState = 2 }

  fire (name, ev) { for (const fn of [...(this.listeners.get(name) || [])]) fn(ev) }
  send (name, obj) { this.fire(name, { type: name, data: JSON.stringify(obj) }) }
  sendRaw (name, text) { this.fire(name, { type: name, data: text }) }
  open () { this.readyState = 1; this.fire('open', { type: 'open' }) }
  fail (readyState = 0) { this.readyState = readyState; this.fire('error', { type: 'error' }) }
}
FakeSource.made = []

let logs = []
const quiet = { error: (...a) => logs.push(a.map((x) => String(x)).join(' ')) }
const fresh = () => {
  FakeSource.made = []
  logs = []
  return new Function('window', 'console', src + '\nreturn MCE')({}, quiet)
}

// --- registration -----------------------------------------------------------

{
  const MCE = fresh()
  const seen = []
  MCE.on('sessions', (d) => seen.push(['a', d.n]))
  MCE.on('sessions', (d) => seen.push(['b', d.n]))
  MCE.on('sessions', (d) => seen.push(['c', d.n]))
  const s = MCE.connect('/api/stream', { EventSource: FakeSource })
  s.open()
  s.send('sessions', { n: 1 })
  assert.deepEqual(seen, [['a', 1], ['b', 1], ['c', 1]])
  assert.equal(s.adds.get('sessions'), 1, 'three handlers must share ONE native listener')
  ok('handlers for one event run in registration order, on one parse of the frame')
}

{
  const MCE = fresh()
  const seen = []
  const offA = MCE.on('events', () => seen.push('a'))
  MCE.on('events', () => seen.push('b'))
  const s = MCE.connect('/api/stream', { EventSource: FakeSource })
  s.send('events', [])
  offA()
  s.send('events', [])
  assert.deepEqual(seen, ['a', 'b', 'b'])
  ok('off() removes exactly its own registration and leaves the others')
}

{
  const MCE = fresh()
  const s = MCE.connect('/api/stream', { EventSource: FakeSource })
  s.open()
  let n = 0
  MCE.on('usage', () => { n++ })
  s.send('usage', {})
  assert.equal(n, 1, 'a handler registered after connect must receive the next frame')
  assert.equal(s.adds.get('usage'), 1)
  ok('on() after connect attaches lazily, exactly once')
}

// --- the snapshot fan-out ---------------------------------------------------

{
  const MCE = fresh()
  const seen = []
  MCE.on('snapshot', (d) => seen.push('whole:' + Object.keys(d).join(',')))
  MCE.onField('projects', (v) => seen.push('projects:' + v.length))
  MCE.onField('peers', (v) => seen.push('peers:' + v.length))
  const s = MCE.connect('/api/stream', { EventSource: FakeSource })
  s.send('snapshot', { projects: [1, 2] })
  assert.deepEqual(seen, ['whole:projects', 'projects:2'],
    'onField must run after the whole-frame handler registered before it')
  seen.length = 0
  s.send('snapshot', { peers: [] })
  assert.deepEqual(seen, ['whole:peers', 'peers:0'],
    'an empty value is a PRESENT key — absence is the only thing onField skips')
  ok('onField fires only for a key the frame carries, in registration order')
}

// --- failure isolation ------------------------------------------------------

{
  const MCE = fresh()
  const s = MCE.connect('/api/stream', { EventSource: FakeSource })
  s.send('sessions', {})                       // a frame nothing listens for
  MCE.on('nothing-sends-this', () => { throw new Error('must not run') })
  s.send('sessions', {})
  assert.equal(logs.length, 0)
  ok('a frame with no handler, and a handler with no frame, are both silent')
}

{
  const MCE = fresh()
  const seen = []
  MCE.on('events', () => { throw new Error('boom') })
  MCE.on('events', () => seen.push('after'))
  const s = MCE.connect('/api/stream', { EventSource: FakeSource })
  s.send('events', [])
  assert.deepEqual(seen, ['after'], 'one feature’s bug must not silence another’s handler')
  assert.equal(logs.length, 1)
  assert.ok(logs[0].includes('events'), 'the log line must name the event')
  ok('a handler that throws is logged and does not stop the next handler')
}

{
  const MCE = fresh()
  let calls = 0
  MCE.on('sessions', () => { calls++ })
  const s = MCE.connect('/api/stream', { EventSource: FakeSource })
  s.sendRaw('sessions', '{not json')
  assert.equal(calls, 0, 'an unparseable frame must reach no handler')
  assert.equal(logs.length, 1)
  s.send('sessions', {})
  assert.equal(calls, 1, 'the next good frame must still be delivered')
  ok('an unparseable frame calls nothing, logs once, and does not poison the stream')
}

// --- connection state -------------------------------------------------------

{
  const MCE = fresh()
  const seen = []
  assert.equal(MCE.state().status, 'idle')
  MCE.on('open', () => seen.push('open:' + MCE.state().status))
  MCE.on('error', () => seen.push('error:' + MCE.state().status))
  const s = MCE.connect('/api/stream', { EventSource: FakeSource })
  assert.equal(MCE.state().status, 'connecting')
  assert.equal(MCE.state().url, '/api/stream')
  s.open()
  assert.equal(MCE.state().status, 'open')
  assert.equal(MCE.state().opens, 1)
  assert.ok(MCE.state().openedAt > 0)
  s.fail()
  assert.equal(MCE.state().status, 'reconnecting')
  assert.equal(MCE.state().error, 'stream error')
  s.open()
  assert.equal(MCE.state().status, 'open')
  assert.equal(MCE.state().opens, 2)
  assert.equal(MCE.state().error, null)
  s.fail(2)
  assert.equal(MCE.state().status, 'closed',
    'a source the browser has given up on is closed, not reconnecting')
  assert.deepEqual(seen, ['open:open', 'error:reconnecting', 'open:open', 'error:closed'],
    'state() must already be correct inside the handler for the event that changed it')
  ok('state() walks idle -> connecting -> open -> reconnecting -> open -> closed')
}

{
  const MCE = fresh()
  let arg = 'unset'
  MCE.on('open', (d, ev) => { arg = [d, ev && ev.type] })
  const s = MCE.connect('/api/stream', { EventSource: FakeSource })
  s.open()
  assert.deepEqual(arg, [null, 'open'])
  ok('open and error are raw: nothing to parse, and the native event passes through')
}

// --- reconnection belongs to the browser ------------------------------------

{
  const MCE = fresh()
  let sessions = 0
  MCE.on('sessions', () => { sessions++ })
  const s = MCE.connect('/api/stream', { EventSource: FakeSource })
  s.open()
  s.fail()
  assert.equal(s.closed, false, 'MCE must never close the source on error')
  assert.equal(FakeSource.made.length, 1, 'MCE must not construct a second source on error')
  s.open()
  s.send('sessions', {})
  assert.equal(sessions, 1, 'a reconnect must not double-register the handler')
  assert.equal(s.adds.get('sessions'), 1)
  ok('a reconnect keeps the same source and attaches nothing twice')
}

{
  const MCE = fresh()
  let n = 0
  MCE.on('canvas', () => { n++ })
  const a = MCE.connect('/api/stream', { EventSource: FakeSource })
  const b = MCE.connect('/api/stream', { EventSource: FakeSource })
  assert.equal(a.closed, true, 'the previous source must be closed')
  assert.equal(FakeSource.made.length, 2)
  b.send('canvas', {})
  assert.equal(n, 1)
  assert.equal(b.adds.get('canvas'), 1, 'every handler attaches to the new source exactly once')
  ok('connect() twice closes the first source and re-attaches each handler once')
}

// --- budget-chip.js: the rail's frame chip ------------------------------------
//
// Another classic script, evaluated the same way with every browser global it
// may touch passed in -- window, console, MCE, MCX, localStorage and fetch --
// so each can be counted. Nothing may reach the DOM, fetch, localStorage, a
// timer or MCE before attach(). The real MCE above carries its frames, so
// onField's `name in d` guard is the one production runs.

const CHIP_SRC = join(ROOT, 'syzygy', 'bridge', 'public', 'budget-chip.js')
assert.ok(existsSync(CHIP_SRC), 'budget-chip.js must exist beside stream.js')
const chipSrc = readFileSync(CHIP_SRC, 'utf8')

// A DOM node just rich enough for the chip. Assigning className throws: the
// chip's nodes live beside MCX-reconciled trees, where a className write wipes
// the classes MCX.show and MCX.toggle set.
class FakeNode {
  constructor (tag, cls = '', text) {
    this.tagName = String(tag).toUpperCase()
    this.cls = new Set(String(cls || '').split(/\s+/).filter(Boolean))
    this.textContent = text == null ? '' : String(text)
    this.children = []
    this.parentNode = null
    this.attrs = new Map()
    this.dataset = {}
    this.listeners = new Map()
    const self = this
    this.classList = {
      toggle (c, on) { const v = on === undefined ? !self.cls.has(c) : !!on; if (v) self.cls.add(c); else self.cls.delete(c); return v },
      contains: (c) => self.cls.has(c),
      add: (c) => { self.cls.add(c) },
      remove: (c) => { self.cls.delete(c) },
    }
  }

  get className () { return [...this.cls].join(' ') }
  set className (_) { throw new Error('className assigned') }
  has (c) { return this.cls.has(c) }
  appendChild (n) { n.parentNode = this; this.children.push(n); return n }
  replaceChildren (...ns) { this.children = []; for (const n of ns) this.appendChild(n) }
  getAttribute (k) { return this.attrs.has(k) ? this.attrs.get(k) : null }
  setAttribute (k, v) { this.attrs.set(k, String(v)) }
  removeAttribute (k) { this.attrs.delete(k) }
  addEventListener (name, fn) { const l = this.listeners.get(name) || []; l.push(fn); this.listeners.set(name, l) }
  contains (n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false }
  fire (name, ev = {}) {
    const e = { target: this, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, preventDefault () {}, stopPropagation () {}, ...ev }
    for (const fn of [...(this.listeners.get(name) || [])]) fn(e)
  }
  text () { return this.textContent + this.children.map((c) => c.text()).join(' ') }
}

const MCXStub = {
  setText: (n, t) => { if (n) n.textContent = t == null ? '' : String(t) },
  setAttr: (n, k, v) => { if (!n) return; if (v == null) n.removeAttribute(k); else n.setAttribute(k, String(v)) },
  toggle: (n, c, on) => { if (n) n.classList.toggle(c, !!on) },
  show: (n, on) => { if (n) n.classList.toggle('gone', !on) },
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const KB = 1024

const chipRig = ({ storage } = {}) => {
  const MCE = fresh()
  const touch = { fetch: 0, storage: 0, document: 0, mce: 0, timers: 0, listeners: 0 }
  const fetches = []
  const replies = []
  // A reply is queued per read. With none queued the read rejects, which is
  // what an unreachable relay looks like to fetch.
  const fetchStub = (url) => {
    touch.fetch++
    fetches.push(url)
    const next = replies.length ? replies.shift() : { reject: new Error('unreachable') }
    if (next.reject) return Promise.reject(next.reject)
    return Promise.resolve({ ok: true, status: 200, json: async () => next.body })
  }
  const store = new Map()
  const ls = storage || {
    getItem: (k) => { touch.storage++; return store.has(k) ? store.get(k) : null },
    setItem: (k, v) => { touch.storage++; store.set(k, String(v)) },
  }
  const body = new FakeNode('body')
  const panels = []
  const doc = { body, querySelectorAll: () => panels.filter((p) => p.dataset.section) }
  const timers = []
  const win = {
    get document () { touch.document++; return doc },
    setInterval: (fn, ms) => { touch.timers++; timers.push({ fn, ms }); return timers.length },
    clearInterval: () => {},
    addEventListener: () => { touch.listeners++ },
  }
  const MCEw = {
    on: (...a) => { touch.mce++; return MCE.on(...a) },
    onField: (...a) => { touch.mce++; return MCE.onField(...a) },
    connect: MCE.connect,
    state: MCE.state,
  }
  const MCBG = new Function('window', 'console', 'MCE', 'MCX', 'localStorage', 'fetch', chipSrc + '\nreturn MCBG')(
    win, quiet, MCEw, MCXStub, ls, fetchStub)
  const atEval = { ...touch }

  const nodes = {}
  for (const [id, cls] of [['t-frame', 'mrow budgetchip gone'], ['v-frame', 'mval num'], ['s-frame', 'msub'], ['frame-pop', 'budgetpop gone']]) {
    nodes[id] = new FakeNode('div', cls)
  }
  const S = {}
  const toasts = []
  const deps = { S, $: (id) => nodes[id] || null, el: (tag, cls, text) => new FakeNode(tag, cls, text), toast: (m) => toasts.push(m) }

  let source = null
  const rig = {
    MCBG, S, nodes, touch, atEval, fetches, replies, body, timers, store, toasts,
    attach: () => MCBG.attach(deps),
    // Opens the stream, and lets the read the open starts settle, so a reply
    // queued afterwards is consumed by the read the case itself makes.
    open: async () => {
      source = MCE.connect('/api/stream', { EventSource: FakeSource })
      source.open()
      await tick()
    },
    snapshot: (d) => source.send('snapshot', d),
    health: (snap) => replies.push({ body: { ok: true, snapshot: snap } }),
    panel: (section) => { const p = new FakeNode('section', 'panel'); p.dataset.section = section; panels.push(p); return p },
    chip: () => nodes['t-frame'],
    logs: () => logs,
  }
  return rig
}

const snap = (over = {}) => ({
  bytes: 600 * KB, budgetBytes: 512 * KB, overBudget: true, shed: [], sections: {}, droppedPanes: 0, ...over,
})

{
  const rig = chipRig()
  assert.deepEqual(rig.atEval, { fetch: 0, storage: 0, document: 0, mce: 0, timers: 0, listeners: 0 },
    'evaluating budget-chip.js must touch no DOM, fetch, localStorage, timer or MCE')
  for (const fn of ['attach', 'register', 'loadAll', 'setMode', 'mode', 'sections', 'poll', 'pinned', 'togglePin']) {
    assert.equal(typeof rig.MCBG[fn], 'function', 'MCBG.' + fn)
  }
  assert.deepEqual({ ...rig.MCBG.SECTION_KEY }, {
    findings: 'findings', proposals: 'skillsQueue', series: 'sessions', events: 'events', efforts: 'projects',
  })
  rig.attach()
  assert.ok(rig.touch.mce >= 2, 'attach registers its own stream handlers')
  assert.deepEqual(rig.timers.map((t) => t.ms), [10_000], 'attach starts one ten-second health poll')
  assert.equal(rig.touch.fetch, 0, 'attach itself reads nothing')
  assert.ok(rig.chip().has('gone'), 'the chip starts hidden')
  await rig.open()
  assert.deepEqual(rig.fetches, ['/api/health'], 'the stream opening reads /api/health')
  ok('budget chip: nothing runs at evaluation time; attach registers, polls, and reads on open')
}

{
  const rig = chipRig()
  rig.attach()
  await rig.open()
  rig.snapshot({ sessions: [], findings: [] })
  assert.ok(rig.chip().has('gone'), 'a frame from a relay that predates `shed` leaves the chip hidden')
  assert.equal('shed' in rig.S, false, 'and writes no S.shed')
  assert.equal(rig.logs().length, 0, 'and throws nothing')
  rig.snapshot({ shed: [] })
  assert.ok(rig.chip().has('gone'), 'an empty shed leaves the chip hidden')
  assert.deepEqual(rig.S.shed, [])
  rig.snapshot({ shed: [{ section: 'findings', kept: 0, dropped: 12 }] })
  assert.equal(rig.chip().has('gone'), false, 'a shed row shows the chip')
  assert.deepEqual(rig.S.shed, [{ section: 'findings', kept: 0, dropped: 12 }], 'S.shed is the payload field itself')
  const said = rig.chip().text() + ' ' + rig.nodes['s-frame'].text()
  assert.ok(said.includes('findings') && said.includes('12'), 'the chip names the section and the count: ' + said)
  assert.equal(rig.logs().length, 0)
  ok('budget chip: no shed key and an empty shed stay hidden; a shed row shows and names itself')
}

{
  const rig = chipRig()
  rig.attach()
  assert.deepEqual(rig.MCBG.sections(), {}, 'sections() is {} before any health read')
  await rig.open()
  rig.health(snap({ droppedPanes: 1, sections: { sessions: 90_000, findings: 2048 } }))
  await rig.MCBG.poll()
  assert.equal(rig.chip().has('gone'), false, 'an over-budget health read shows the chip')
  assert.equal(rig.nodes['v-frame'].text(), '600 KB', 'the value is the frame size')
  assert.equal(rig.chip().has('warn'), false, 'the first read has no earlier count to have risen from')
  assert.deepEqual(rig.MCBG.sections(), { sessions: 90_000, findings: 2048 }, 'sections() is the last read\'s byte map')
  rig.health(snap({ droppedPanes: 3 }))
  await rig.MCBG.poll()
  assert.ok(rig.chip().has('warn'), 'droppedPanes rising since the last read adds the warning')
  assert.ok(rig.nodes['s-frame'].text().includes('3 panes dropped'))
  rig.health(snap({ droppedPanes: 3 }))
  await rig.MCBG.poll()
  assert.equal(rig.chip().has('warn'), false, 'the same count twice does not')
  rig.health(snap({ overBudget: false, bytes: 100 * KB, droppedPanes: 0 }))
  await rig.MCBG.poll()
  assert.ok(rig.chip().has('gone'), 'under budget, nothing shed and no pane dropped hides the chip again')
  assert.equal(rig.logs().length, 0)
  ok('budget chip: health reads show it, a rising droppedPanes warns once, sections() tracks the read')
}

{
  const rig = chipRig()
  rig.attach()
  await rig.open()
  rig.health(snap({ bytes: 600 * KB }))
  await rig.MCBG.poll()
  const before = [rig.chip().className, rig.nodes['v-frame'].text(), rig.nodes['s-frame'].text()]
  await rig.MCBG.poll()                                   // nothing queued: fetch rejects
  rig.replies.push({ body: { ok: true } })                // an older relay: no snapshot block
  await rig.MCBG.poll()
  rig.replies.push({ body: null })
  await rig.MCBG.poll()
  assert.deepEqual([rig.chip().className, rig.nodes['v-frame'].text(), rig.nodes['s-frame'].text()], before,
    'a failed read leaves the chip in its last state')
  assert.equal(rig.logs().length, 0, 'and throws nothing')
  ok('budget chip: a rejected fetch or a health reply without a snapshot block changes nothing')
}

{
  const rig = chipRig()
  rig.attach()
  await rig.open()
  const findings = rig.panel('findings')
  const sessions = rig.panel('sessions')
  rig.health(snap({ sections: { findings: 2048, sessions: 90_000 } }))
  await rig.MCBG.poll()
  rig.snapshot({ shed: [{ section: 'findings', kept: 0, dropped: 12 }] })
  assert.equal(rig.MCBG.mode(), 'off')
  rig.MCBG.setMode('budget')
  assert.equal(rig.MCBG.mode(), 'budget')
  assert.ok(rig.body.has('budgetmode'), 'budget mode marks the body')
  const labelOf = (p) => p.children.find((c) => c.has('seclabel'))
  assert.ok(labelOf(findings) && labelOf(sessions), 'every panel carrying data-section gets a label')
  assert.ok(labelOf(sessions).text().includes('88 KB'), 'a label reads its key\'s bytes: ' + labelOf(sessions).text())
  assert.ok(findings.has('sheddim'), 'a panel whose key the frame shed is dimmed')
  assert.equal(sessions.has('sheddim'), false, 'a panel the frame kept is not')
  rig.MCBG.setMode('off')
  assert.equal(rig.MCBG.mode(), 'off')
  assert.equal(rig.body.has('budgetmode'), false)
  assert.equal(findings.has('sheddim'), false, 'leaving the mode undims')
  assert.ok(labelOf(findings).has('gone') && labelOf(sessions).has('gone'), 'and hides every label')
  rig.MCBG.setMode('budget')
  assert.equal(findings.children.filter((c) => c.has('seclabel')).length, 1, 'a label is built once, never twice')
  rig.MCBG.setMode('off')
  ok('budget chip: setMode round-trips, labels panels with bytes and dims the shed ones')
}

{
  const rig = chipRig()
  rig.attach()
  await rig.open()
  rig.snapshot({ shed: [{ section: 'series', kept: 60, dropped: 340 }] })
  rig.chip().fire('click', { altKey: true })
  assert.equal(rig.MCBG.mode(), 'off', 'option-click does nothing')
  assert.ok(rig.nodes['frame-pop'].has('gone'), 'option-click opens no pop')
  rig.chip().fire('click', { shiftKey: true })
  assert.equal(rig.MCBG.mode(), 'budget', 'shift-click enters budget mode')
  rig.chip().fire('click', { shiftKey: true })
  assert.equal(rig.MCBG.mode(), 'off', 'and shift-click again leaves it')
  rig.chip().fire('click')
  assert.equal(rig.nodes['frame-pop'].has('gone'), false, 'a plain click opens the pop')
  assert.ok(rig.nodes['frame-pop'].text().includes('series'), 'the pop lists the shed rows')
  rig.chip().fire('click')
  assert.ok(rig.nodes['frame-pop'].has('gone'), 'a second plain click closes it')
  ok('budget chip: plain click toggles the pop, shift-click the mode, option-click nothing')
}

{
  const rig = chipRig()
  rig.attach()
  const calls = { findings: 0, proposals: 0, events: 0 }
  rig.MCBG.register('findings', () => { calls.findings++ })
  rig.MCBG.register('proposals', async () => { calls.proposals++; throw new Error('loader failed') })
  rig.MCBG.register('events', () => { calls.events++ })
  await rig.open()
  rig.snapshot({ shed: [{ section: 'findings', kept: 0, dropped: 12 }, { section: 'proposals', kept: 0, dropped: 7 }] })
  assert.deepEqual(calls, { findings: 0, proposals: 0, events: 0 }, 'nothing pinned: a shed loads nothing by itself')
  await rig.MCBG.loadAll()
  assert.deepEqual(calls, { findings: 1, proposals: 1, events: 0 },
    'loadAll runs each registered loader for a shed section exactly once, and none for a kept one')
  assert.equal(rig.logs().length, 0, 'a loader that rejects is absorbed')
  ok('budget chip: register and loadAll run each shed section\'s loader once')
}

{
  const rig = chipRig()
  rig.store.set('szg.shed.pin', JSON.stringify(['findings']))
  rig.attach()
  const calls = { findings: 0, proposals: 0 }
  rig.MCBG.register('findings', () => { calls.findings++ })
  rig.MCBG.register('proposals', () => { calls.proposals++ })
  await rig.open()
  rig.snapshot({ shed: [{ section: 'findings', kept: 0, dropped: 12 }, { section: 'proposals', kept: 0, dropped: 7 }] })
  assert.deepEqual(calls, { findings: 1, proposals: 0 }, 'a pinned section loads itself when a snapshot sheds it')
  rig.snapshot({ shed: [] })
  assert.deepEqual(calls, { findings: 1, proposals: 0 }, 'a snapshot that sheds nothing loads nothing')
  assert.equal(rig.MCBG.pinned('findings'), true)
  assert.equal(rig.MCBG.togglePin('proposals'), true)
  assert.deepEqual(JSON.parse(rig.store.get('szg.shed.pin')), ['findings', 'proposals'])
  assert.equal(rig.MCBG.togglePin('findings'), false)
  assert.deepEqual(JSON.parse(rig.store.get('szg.shed.pin')), ['proposals'])
  ok('budget chip: a pinned section loads on a shedding snapshot, and pins toggle in szg.shed.pin')
}

{
  const denied = () => { throw new Error('storage denied') }
  const rig = chipRig({ storage: { getItem: denied, setItem: denied, removeItem: denied } })
  rig.attach()
  let calls = 0
  rig.MCBG.register('findings', () => { calls++ })
  await rig.open()
  rig.snapshot({ shed: [{ section: 'findings', kept: 0, dropped: 12 }] })
  assert.equal(rig.chip().has('gone'), false, 'the chip still shows')
  assert.equal(calls, 0, 'unreadable pins are no pins')
  assert.equal(rig.MCBG.pinned('findings'), false)
  assert.equal(rig.MCBG.togglePin('findings'), null, 'a pin the browser would not store answers null')
  rig.MCBG.setMode('budget')
  rig.MCBG.setMode('off')
  await rig.MCBG.loadAll()
  assert.equal(calls, 1, 'loadAll still works')
  assert.equal(rig.logs().length, 0, 'a localStorage that throws on every call breaks nothing')
  ok('budget chip: localStorage throwing on every call breaks nothing')
}

process.stdout.write('\nstream harness: ' + pass + ' checks passed\n')
