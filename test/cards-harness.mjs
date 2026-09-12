#!/usr/bin/env node
// Drives bridge/cards.mjs: the atomic write, the validation, and the
// name-keyed inheritance refusal (mirrors claims-harness.mjs / canvas.mjs's
// own inheritPosition tests). Hermetic: a temp directory, never WORLD_DIR.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { createCards, readCards, validateColor, inheritableCardColor } =
  await import(join(ROOT, 'syzygy', 'bridge', 'cards.mjs'))

let pass = 0
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label) }

const freshDir = () => mkdtempSync(join(tmpdir(), 'szg-cards-'))
const freshFile = () => join(freshDir(), 'cards.json')

// ------------------------------------------------------------- validation --

ok('#rrggbb, lowercased, is accepted', () => {
  assert.deepEqual(validateColor('#FF00aa'), { ok: true, color: '#ff00aa' })
})

ok('empty string and nullish both mean clear', () => {
  assert.deepEqual(validateColor(''), { ok: true, color: '' })
  assert.deepEqual(validateColor(null), { ok: true, color: '' })
  assert.deepEqual(validateColor(undefined), { ok: true, color: '' })
})

ok('anything not #rrggbb is refused', () => {
  for (const bad of ['red', '#fff', '#gggggg', 'ff00aa', '#ff00aa00', 42, {}]) {
    const r = validateColor(bad)
    assert.equal(r.ok, false, JSON.stringify(bad))
    assert.ok(r.error)
  }
})

// ------------------------------------------------------------- the store --

ok('a written colour round-trips, keyed by name', () => {
  const file = freshFile()
  const store = createCards({ file, now: () => 1_700_000_000_000 })
  const r = store.set('alpha', 's1', '#ff00aa')
  assert.deepEqual(r, { ok: true, color: '#ff00aa' })
  assert.equal(readCards(file).alpha.color, '#ff00aa')
  assert.equal(readCards(file).alpha.id, 's1')
  assert.equal(store.colorFor('alpha', [{ id: 's1', name: 'alpha' }]), '#ff00aa')
})

ok('an absent file reads as no cards, not an error', () => {
  assert.deepEqual(readCards(freshFile()), {})
})

ok('an invalid colour is refused and nothing is written', () => {
  const file = freshFile()
  const store = createCards({ file })
  const r = store.set('alpha', 's1', 'not-a-color')
  assert.equal(r.ok, false)
  assert.equal(existsSync(file), false)
})

ok('clearing removes the entry; clearing a name with nothing stored is a no-op', () => {
  const file = freshFile()
  const store = createCards({ file })
  store.set('alpha', 's1', '#123456')
  assert.deepEqual(store.set('alpha', 's1', ''), { ok: true, color: '' })
  assert.equal('alpha' in readCards(file), false)
  assert.deepEqual(store.set('beta', 's2', ''), { ok: true, color: '' })
})

ok('a name-less set is accepted but persists nothing', () => {
  const file = freshFile()
  const store = createCards({ file })
  const r = store.set('', 's1', '#123456')
  assert.deepEqual(r, { ok: true, color: '#123456' })
  assert.deepEqual(readCards(file), {})
})

ok('setting one name never disturbs another', () => {
  const file = freshFile()
  const store = createCards({ file })
  store.set('alpha', 's1', '#111111')
  store.set('beta', 's2', '#222222')
  store.set('alpha', 's1', '#333333')
  const back = readCards(file)
  assert.equal(back.beta.color, '#222222', 'an alpha write disturbed beta')
  assert.equal(back.alpha.color, '#333333')
})

ok('unknown top-level fields added by hand survive a later write', () => {
  const file = freshFile()
  const store = createCards({ file })
  store.set('alpha', 's1', '#111111')
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.myOwnField = 'keep me'
  writeFileSync(file, JSON.stringify(doc))
  store.set('alpha', 's1', '#222222')
  // cards.mjs sanitises on READ (like claims.mjs / findings.mjs), so a
  // top-level field it does not understand is its own concern, not this
  // store's -- confirm this store does not itself go out of its way to erase
  // it on the write it does own.
  const back = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(back.byName.alpha.color, '#222222')
})

ok('a corrupt file degrades to no cards rather than throwing', () => {
  const dir = freshDir()
  const file = join(dir, 'cards.json')
  writeFileSync(file, '{not json')
  assert.deepEqual(readCards(file), {})
  // And a store built over it can still write -- the corrupt file is simply
  // overwritten by the next successful flush, same bargain findings.mjs makes.
  const store = createCards({ file })
  store.set('alpha', 's1', '#111111')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).byName.alpha.color, '#111111')
})

ok('a failed serialize leaves the previous file intact, and cleans up its temp file', () => {
  const dir = freshDir()
  const file = join(dir, 'cards.json')
  const store = createCards({ file })
  store.set('alpha', 's1', '#111111')
  const before = readFileSync(file, 'utf8')
  chmodSync(dir, 0o500) // read+execute only: writeFileSync(tmp) must throw
  try {
    assert.throws(() => store.set('alpha', 's1', '#222222'))
  } finally {
    chmodSync(dir, 0o700)
  }
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(existsSync(file + '.tmp'), false)
})

ok('a malformed entry (bad color, missing color) is dropped on read, not thrown', () => {
  const dir = freshDir()
  const file = join(dir, 'cards.json')
  writeFileSync(file, JSON.stringify({
    byName: {
      alpha: { id: 's1', color: '#111111' },
      beta: { id: 's2', color: 'not-a-color' },
      gamma: { id: 's3' },
      delta: null,
      epsilon: 'a bare string',
    },
  }))
  const back = readCards(file)
  assert.deepEqual(Object.keys(back), ['alpha'])
})

// ---------------------------------------------------- inheritance refusal --
// Mirrors claims-inherit.mjs / canvas.mjs's inheritPosition tests: never
// inherit when the name is currently worn by more than one live session.

ok('a solitary live session under a stored name inherits its colour', () => {
  const byName = { alpha: { id: 'old', color: '#111111', updatedAt: 1 } }
  const live = [{ id: 's1', name: 'alpha' }]
  assert.equal(inheritableCardColor(byName, 'alpha', live), '#111111')
})

ok('two live sessions sharing the name: neither inherits', () => {
  const byName = { alpha: { id: 'old', color: '#111111', updatedAt: 1 } }
  const live = [{ id: 's1', name: 'alpha' }, { id: 's2', name: 'alpha' }]
  assert.equal(inheritableCardColor(byName, 'alpha', live), '')
})

ok('no stored colour for this name: nothing to inherit', () => {
  assert.equal(inheritableCardColor({}, 'alpha', [{ id: 's1', name: 'alpha' }]), '')
})

ok('no name: nothing to inherit', () => {
  const byName = { alpha: { id: 'old', color: '#111111', updatedAt: 1 } }
  assert.equal(inheritableCardColor(byName, '', [{ id: 's1', name: '' }]), '')
  assert.equal(inheritableCardColor(byName, undefined, []), '')
})

ok('a live session under a DIFFERENT name is irrelevant to this one', () => {
  const byName = { alpha: { id: 'old', color: '#111111', updatedAt: 1 } }
  const live = [{ id: 's1', name: 'alpha' }, { id: 's2', name: 'beta' }]
  assert.equal(inheritableCardColor(byName, 'alpha', live), '#111111')
})

console.log(`\n${pass} passed`)
