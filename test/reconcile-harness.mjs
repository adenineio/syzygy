#!/usr/bin/env node
// Drives bridge/public/reconcile.js against a minimal DOM shim.
//
// There is no DOM in these tests and jsdom is not a dependency, so the
// shim below implements exactly the surface the reconciler touches —
// `children`, `insertBefore`, `removeChild`, `classList`, `dataset`,
// `textContent`, `setAttribute`. Same reason `swarm-math.js` and
// `spinner-frames.js` are split out from their consumers: the part worth
// asserting is separable, so separate it and assert it.
//
// `reconcile.js` is a CLASSIC script (like `projects.js` and `replay.js`), not
// an ES module like `swarm.js`, because that is what the pane loads. It is
// therefore evaluated here through `new Function` rather than imported, with
// `window` passed in — which is also how the reduced-motion switch gets
// flipped mid-run.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'syzygy', 'bridge', 'public', 'reconcile.js')

let pass = 0
const ok = (m) => { pass++; process.stdout.write('  ok  ' + m + '\n') }

// --- the DOM shim -----------------------------------------------------------

// Counts every actual write, so "did not touch the DOM" is a measurement
// rather than a belief. This is the property that stopped session cards
// flickering their :hover away once a second (app.js:523).
const W = { text: 0, attr: 0, cls: 0, insert: 0, remove: 0 }
const resetW = () => { for (const k of Object.keys(W)) W[k] = 0 }

class El {
  constructor (tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.dataset = {}
    this.attrs = new Map()
    this._text = ''
    const set = new Set()
    this.classList = {
      contains: (c) => set.has(c),
      add: (c) => { if (!set.has(c)) { W.cls++; set.add(c) } },
      remove: (c) => { if (set.has(c)) { W.cls++; set.delete(c) } },
      toggle: (c, force) => {
        const on = force === undefined ? !set.has(c) : !!force
        if (on) this.classList.add(c); else this.classList.remove(c)
        return on
      },
    }
  }

  get textContent () { return this._text }
  set textContent (v) {
    W.text++
    this._text = String(v)
    for (const c of this.children) c.parentNode = null
    this.children = []
  }

  insertBefore (node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node, true)
    const i = ref == null ? this.children.length : this.children.indexOf(ref)
    if (i < 0) throw new Error('insertBefore: reference node is not a child')
    this.children.splice(i, 0, node)
    node.parentNode = this
    W.insert++
    return node
  }

  appendChild (node) { return this.insertBefore(node, null) }

  removeChild (node, moving) {
    const i = this.children.indexOf(node)
    if (i >= 0) this.children.splice(i, 1)
    node.parentNode = null
    if (!moving) W.remove++
    return node
  }

  remove () { if (this.parentNode) this.parentNode.removeChild(this) }

  setAttribute (n, v) { W.attr++; this.attrs.set(n, String(v)) }
  removeAttribute (n) { if (this.attrs.has(n)) { W.attr++; this.attrs.delete(n) } }
  getAttribute (n) { return this.attrs.has(n) ? this.attrs.get(n) : null }

  querySelector (sel) {
    const cls = sel.replace(/^\./, '')
    for (const c of this.children) {
      if (c.classList.contains(cls)) return c
      const deep = c.querySelector(sel)
      if (deep) return deep
    }
    return null
  }
}

const mk = (tag, cls, text) => {
  const n = new El(tag)
  if (cls) for (const c of String(cls).split(/\s+/).filter(Boolean)) n.classList.add(c)
  if (text != null) n.textContent = text
  return n
}

const keysOf = (parent) => parent.children.map((c) => c.dataset.rkey ?? '?')

// --- load the module --------------------------------------------------------

const media = { reduced: false }
const win = { matchMedia: (q) => ({ matches: media.reduced && /reduce/.test(q) }) }

const src = readFileSync(SRC, 'utf8')
const MCX = new Function('window', src + '\nreturn MCX')(win)

assert.equal(typeof MCX.reconcile, 'function', 'reconcile.js must expose MCX.reconcile')
ok('module loads as a classic script and exposes MCX')

// --- helpers ----------------------------------------------------------------

const SPEC = (extra = {}) => ({
  key: (d) => d.id,
  create: (d) => mk('div', 'row'),
  update: (node, d) => { MCX.setText(node, d.text ?? d.id) },
  ...extra,
})

const data = (...ids) => ids.map((id) => ({ id, text: id }))

// --- identity: the whole feature -------------------------------------------

{
  const p = mk('div')
  MCX.reconcile(p, data('a', 'b', 'c'), SPEC())
  const first = p.children.slice()
  MCX.reconcile(p, data('a', 'b', 'c'), SPEC())
  assert.equal(p.children.length, 3)
  for (let i = 0; i < 3; i++) {
    assert.equal(p.children[i], first[i], 'node ' + i + ' was rebuilt instead of reused')
  }
  ok('a key present in two passes yields the same element object')
}

{
  // ALL FIVE counters, and an `update` that actually exercises each helper --
  // asserting only text/insert/remove would let an attribute or class write
  // through while the sentence everyone relies on says "zero DOM writes".
  const RICH = SPEC({
    update: (node, d) => {
      MCX.setText(node, d.text ?? d.id)
      MCX.setAttr(node, 'title', 'cwd ' + d.id)
      MCX.toggle(node, 'working', d.id === 'b')
      MCX.show(node, d.id !== 'c')
    },
  })
  const p = mk('div')
  MCX.reconcile(p, data('a', 'b', 'c'), RICH)
  resetW()
  MCX.reconcile(p, data('a', 'b', 'c'), RICH)
  for (const k of ['text', 'attr', 'cls', 'insert', 'remove']) {
    assert.equal(W[k], 0, 'an unchanged pass made ' + W[k] + ' ' + k + ' write(s)')
  }
  ok('an unchanged pass touches the DOM zero times — text, attrs, classes, moves and removals')
}

{
  // A hook must never be able to break the render. Both halves of a malformed
  // thenable: a throwing `.then` getter, and a `.then` that throws when called.
  for (const [name, bad] of [
    ['a throwing .then getter', () => ({ get then () { throw new Error('boom') } })],
    ['a .then that throws', () => ({ then () { throw new Error('boom') } })],
  ]) {
    const p = mk('div')
    MCX.reconcile(p, data('a', 'b'), SPEC())
    MCX.reconcile(p, data('a'), SPEC({ exit: bad }))
    assert.deepEqual(keysOf(p), ['a'], name + ' left the node stranded')
    assert.ok(!p.children.some((n) => n.dataset.leaving), name + ' marked a node it never subscribed to')
  }
  ok('a malformed thenable from exit removes the node instead of escaping')
}

{
  const p = mk('div')
  MCX.reconcile(p, data('a', 'b'), SPEC())
  MCX.reconcile(p, data('a'), SPEC({ exit: () => { throw new Error('hook blew up') } }))
  assert.deepEqual(keysOf(p), ['a'], 'a throwing exit hook stranded the node')
  ok('an exit hook that throws outright still removes the node')
}

// --- ordering ---------------------------------------------------------------

{
  const p = mk('div')
  MCX.reconcile(p, data('a', 'b', 'c', 'd', 'e'), SPEC())
  const byKey = new Map(p.children.map((n) => [n.dataset.rkey, n]))
  resetW()
  MCX.reconcile(p, data('e', 'd', 'c', 'b', 'a'), SPEC())
  assert.deepEqual(keysOf(p), ['e', 'd', 'c', 'b', 'a'])
  for (const [k, n] of byKey) assert.equal(p.children[keysOf(p).indexOf(k)], n, k + ' was rebuilt')
  assert.equal(W.remove, 0, 'a reorder removed nodes')
  ok('reversing a list reorders without creating or removing a single node')
}

{
  const p = mk('div')
  MCX.reconcile(p, data('a', 'b', 'd'), SPEC())
  const a = p.children[0], b = p.children[1], d = p.children[2]
  MCX.reconcile(p, data('a', 'b', 'c', 'd'), SPEC())
  assert.deepEqual(keysOf(p), ['a', 'b', 'c', 'd'])
  assert.equal(p.children[0], a); assert.equal(p.children[1], b); assert.equal(p.children[3], d)
  MCX.reconcile(p, data('a', 'd'), SPEC())
  assert.deepEqual(keysOf(p), ['a', 'd'])
  assert.equal(p.children[0], a); assert.equal(p.children[1], d)
  ok('inserting and removing in the middle leaves the surrounding nodes identical')
}

{
  const p = mk('div')
  MCX.reconcile(p, data('a', 'b'), SPEC())
  MCX.reconcile(p, data('c'), SPEC())
  assert.deepEqual(keysOf(p), ['c'])
  MCX.reconcile(p, [], SPEC())
  assert.deepEqual(keysOf(p), [])
  ok('a wholly replaced list, and an emptied list, end in data order')
}

// --- the create/update/insert/enter contract --------------------------------

{
  const p = mk('div')
  const log = []
  MCX.reconcile(p, data('a'), {
    key: (d) => d.id,
    create: (d) => { log.push('create'); return mk('div', 'row') },
    update: (n, d, i, isNew) => {
      log.push('update:' + isNew)
      MCX.setText(n, d.text)
    },
    enter: (n, d) => {
      log.push('enter')
      assert.equal(n.textContent, 'a', 'enter ran before update filled the node')
      assert.equal(n.parentNode, p, 'enter ran before the node was inserted')
    },
  })
  assert.deepEqual(log, ['create', 'update:true', 'enter'])
  ok('order is create -> update -> insert -> enter, and enter sees a filled, parented node')
}

{
  const p = mk('div')
  const seen = []
  const spec = {
    key: (d) => d.id,
    create: () => mk('div', 'row'),
    update: (n, d, i, isNew) => seen.push([d.id, i, isNew]),
  }
  MCX.reconcile(p, data('a', 'b'), spec)
  seen.length = 0
  MCX.reconcile(p, data('b', 'a'), spec)
  assert.deepEqual(seen, [['b', 0, false], ['a', 1, false]], 'update got the wrong index or isNew')
  ok('update receives the data-order index and isNew=false on reuse')
}

// --- exit -------------------------------------------------------------------

{
  const p = mk('div')
  MCX.reconcile(p, data('a', 'b'), SPEC())
  const gone = []
  MCX.reconcile(p, data('a'), SPEC({ exit: (n, k) => { gone.push(k) } }))
  assert.deepEqual(gone, ['b'])
  assert.deepEqual(keysOf(p), ['a'], 'a synchronous exit must remove the node in the same pass')
  ok('exit returning a non-promise removes the node synchronously')
}

{
  const p = mk('div')
  MCX.reconcile(p, data('a', 'b'), SPEC())
  let release
  const held = new Promise((r) => { release = r })
  MCX.reconcile(p, data('a'), SPEC({ exit: () => held }))
  assert.deepEqual(keysOf(p), ['a', 'b'], 'an async exit must hold the node in the DOM')
  assert.equal(p.children[1].dataset.leaving, '1', 'a leaving node must be marked')
  release()
  await held
  await Promise.resolve()
  assert.deepEqual(keysOf(p), ['a'], 'the node was not removed when the exit promise settled')
  ok('exit returning a promise holds the node, marks it, and removes it on settle')
}

{
  const p = mk('div')
  MCX.reconcile(p, data('a', 'b'), SPEC())
  let boom
  const rejected = new Promise((_, r) => { boom = r })
  MCX.reconcile(p, data('a'), SPEC({ exit: () => rejected }))
  boom(new Error('animation blew up'))
  await rejected.catch(() => {})
  await Promise.resolve()
  assert.deepEqual(keysOf(p), ['a'], 'a rejected exit animation leaked its node')
  ok('a rejected exit promise still removes the node rather than leaking it')
}

{
  const p = mk('div')
  MCX.reconcile(p, data('a', 'b'), SPEC())
  const dying = p.children[1]
  let release
  const held = new Promise((r) => { release = r })
  MCX.reconcile(p, data('a'), SPEC({ exit: () => held }))
  MCX.reconcile(p, data('a', 'b'), SPEC({ exit: () => held }))
  const fresh = p.children.find((n) => n.dataset.rkey === 'b' && !n.dataset.leaving)
  assert.ok(fresh, 'a key that returned mid-exit produced no live node')
  assert.notEqual(fresh, dying, 'a returning key resurrected the node that was dying')
  assert.equal(dying.dataset.leaving, '1', 'the dying node stopped being marked')
  release(); await held; await Promise.resolve()
  assert.deepEqual(keysOf(p), ['a', 'b'])
  assert.equal(p.children[1], fresh, 'settling the old exit removed the live node')
  ok('a key returning mid-exit builds a fresh node and the dying one still departs')
}

{
  // Placement must step over a leaving node rather than counting it, or every
  // live sibling after it lands one slot late.
  const p = mk('div')
  MCX.reconcile(p, data('a', 'b', 'c'), SPEC())
  let release
  const held = new Promise((r) => { release = r })
  MCX.reconcile(p, data('a', 'c'), SPEC({ exit: () => held }))
  const live = p.children.filter((n) => !n.dataset.leaving).map((n) => n.dataset.rkey)
  assert.deepEqual(live, ['a', 'c'], 'live siblings were displaced by a leaving node')
  MCX.reconcile(p, data('c', 'a'), SPEC({ exit: () => held }))
  const live2 = p.children.filter((n) => !n.dataset.leaving).map((n) => n.dataset.rkey)
  assert.deepEqual(live2, ['c', 'a'], 'a reorder around a leaving node went wrong')
  release(); await held; await Promise.resolve()
  assert.deepEqual(keysOf(p), ['c', 'a'])
  ok('a leaving node does not distort the placement of live siblings')
}

{
  media.reduced = true
  const p = mk('div')
  MCX.reconcile(p, data('a', 'b'), SPEC())
  MCX.reconcile(p, data('a'), SPEC({ exit: () => new Promise(() => {}) }))
  assert.deepEqual(keysOf(p), ['a'], 'reduced motion must not wait on an exit promise')
  media.reduced = false
  assert.equal(MCX.reducedMotion(), false, 'reducedMotion must be read live, not cached at load')
  ok('prefers-reduced-motion removes immediately and is read live')
}

// --- nesting ----------------------------------------------------------------

{
  const WT = {
    key: (w) => w.path,
    create: () => mk('div', 'wtree'),
    update: (n, w) => { MCX.setText(n, w.path) },
  }
  const PROJ = {
    key: (p) => p.key,
    create: () => {
      const box = mk('div', 'project')
      box.appendChild(mk('div', 'projbody'))
      return box
    },
    update: (box, p) => { MCX.reconcile(box.querySelector('.projbody'), p.worktrees, WT) },
  }
  const payload = [
    { key: '/a/.git', worktrees: [{ path: 'main' }, { path: 'feat' }] },
    { key: '/b/.git', worktrees: [{ path: 'main' }] },
  ]
  const p = mk('div')
  MCX.reconcile(p, payload, PROJ)
  const aMain = p.children[0].querySelector('.projbody').children[0]
  const bMain = p.children[1].querySelector('.projbody').children[0]
  assert.notEqual(aMain, bMain, 'two parents sharing a child key collided')
  resetW()
  MCX.reconcile(p, payload, PROJ)
  assert.equal(p.children[0].querySelector('.projbody').children[0], aMain, 'a grandchild was rebuilt')
  assert.equal(W.insert, 0, 'a nested no-op pass moved nodes')
  payload[0].worktrees.reverse()
  MCX.reconcile(p, payload, PROJ)
  assert.equal(p.children[0].querySelector('.projbody').children[1], aMain, 'nested reorder lost identity')
  ok('nesting keeps grandchild identity and keys are scoped per parent')
}

// --- hazards ----------------------------------------------------------------

{
  // The p.key collision this work fixes upstream is exactly this shape, so the
  // client must not corrupt itself when it meets one.
  const p = mk('div')
  const warn = console.warn
  let warned = 0
  console.warn = () => { warned++ }
  try {
    MCX.reconcile(p, [{ id: 'a', text: 'first' }, { id: 'a', text: 'second' }, { id: 'b' }], SPEC())
  } finally { console.warn = warn }
  assert.deepEqual(keysOf(p), ['a', 'b'], 'a duplicate key corrupted the list')
  assert.equal(p.children[0].textContent, 'first', 'the duplicate won instead of the first')
  assert.ok(warned > 0, 'a duplicate key must be reported, never silently dropped')
  ok('a duplicate key keeps the first, drops the rest, and warns')
}

{
  const p = mk('div')
  const stat = mk('div', 'static', 'header')
  p.appendChild(stat)
  MCX.reconcile(p, data('a', 'b'), SPEC())
  assert.equal(p.children[0], stat, 'an unkeyed child was moved')
  assert.deepEqual(p.children.slice(1).map((n) => n.dataset.rkey), ['a', 'b'])
  MCX.reconcile(p, data('b'), SPEC())
  assert.equal(p.children[0], stat, 'an unkeyed child was removed')
  assert.deepEqual(p.children.slice(1).map((n) => n.dataset.rkey), ['b'])
  ok('an unkeyed child is left alone and does not distort placement')
}

{
  // The DOM is the source of truth: a subtree cleared by anything else must
  // not be resurrected from a cached map.
  const p = mk('div')
  MCX.reconcile(p, data('a', 'b'), SPEC())
  const old = p.children[0]
  p.textContent = ''
  MCX.reconcile(p, data('a', 'b'), SPEC())
  assert.equal(p.children.length, 2, 'a cleared parent was not rebuilt')
  assert.notEqual(p.children[0], old, 'a detached node was resurrected from a stale map')
  ok('a parent cleared behind the reconciler rebuilds instead of resurrecting')
}

// --- the small helpers ------------------------------------------------------

{
  const n = mk('span')
  resetW()
  MCX.setText(n, 'x'); MCX.setText(n, 'x'); MCX.setText(n, 'y')
  assert.equal(W.text, 2, 'setText wrote when the text was unchanged')

  MCX.setAttr(n, 'title', 'hello')
  assert.equal(n.getAttribute('title'), 'hello')
  resetW()
  MCX.setAttr(n, 'title', 'hello')
  assert.equal(W.attr, 0, 'setAttr wrote an unchanged attribute')
  MCX.setAttr(n, 'title', null)
  assert.equal(n.getAttribute('title'), null, 'setAttr(null) must remove the attribute')

  MCX.toggle(n, 'on', true); assert.equal(n.classList.contains('on'), true)
  MCX.toggle(n, 'on', 0); assert.equal(n.classList.contains('on'), false, 'toggle must coerce to boolean')

  MCX.show(n, false); assert.equal(n.classList.contains('gone'), true, 'show(false) must add .gone')
  MCX.show(n, true); assert.equal(n.classList.contains('gone'), false)
  ok('setText, setAttr, toggle and show write only when something changed')
}

{
  const p = mk('div')
  const r = MCX.reconcile(p, data('a', 'b'), SPEC())
  assert.equal(r.nodes.get('a'), p.children[0])
  assert.deepEqual([...r.nodes.keys()], ['a', 'b'], 'nodes must be in data order')
  assert.equal(r.entered.length, 2)
  assert.equal(r.exited.length, 0)
  assert.equal(MCX.keyOf(p.children[0]), 'a')
  assert.equal(MCX.keyOf(mk('div')), undefined, 'keyOf on a foreign node must be undefined')
  const r2 = MCX.reconcile(p, data('a'), SPEC())
  assert.equal(r2.entered.length, 0)
  assert.deepEqual(r2.exited.map((n) => MCX.keyOf(n)), ['b'])
  ok('the return value reports nodes in data order, plus entered and exited')
}

process.stdout.write('\nreconcile harness: ' + pass + ' checks passed\n')
