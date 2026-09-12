#!/usr/bin/env node
// Drives bridge/findings.mjs.
// Hermetic: a temp directory, never WORLD_DIR.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { createFindings, readFindings, sanitizeFinding, FINDINGS_MAX, SURPRISE_MAX, LIST_MAX } =
  await import(join(ROOT, 'syzygy', 'bridge', 'findings.mjs'))

let pass = 0
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label) }

const freshDir = () => mkdtempSync(join(tmpdir(), 'szg-findings-'))
const freshFile = () => join(freshDir(), 'findings.json')

const full = (over = {}) => ({
  session: 'worker-a', project: 'proj',
  touched: ['bridge/relay.mjs'], surprise: 'the flag is variadic',
  evidence: ['bridge/dispatch.mjs:167'], ...over,
})

// ------------------------------------------------------------- the schema --
ok('a full record round-trips with every field', () => {
  const file = freshFile()
  const store = createFindings({ file, now: () => 1_700_000_000_000 })
  const rec = store.add(full())
  assert.equal(rec.session, 'worker-a')
  assert.equal(rec.project, 'proj')
  assert.deepEqual(rec.touched, ['bridge/relay.mjs'])
  assert.equal(rec.surprise, 'the flag is variadic')
  assert.deepEqual(rec.evidence, ['bridge/dispatch.mjs:167'])
  assert.equal(rec.t, 1_700_000_000_000)
  assert.ok(rec.id)
  assert.deepEqual(readFindings(file), [rec], 'and is on disk, not only in memory')
})

ok('surprise is the only required field -- everything else may be absent', () => {
  const store = createFindings({ file: freshFile() })
  const rec = store.add({ surprise: 'it was the cache all along' })
  assert.ok(rec)
  assert.equal(rec.session, '')
  assert.equal(rec.project, '')
  assert.deepEqual(rec.touched, [])
  assert.deepEqual(rec.evidence, [])
})

ok('a record with no surprise is refused outright -- it says nothing', () => {
  const store = createFindings({ file: freshFile() })
  assert.equal(store.add({ session: 'a', touched: ['x'] }), null)
  assert.equal(store.add({ surprise: '   ' }), null)
  assert.equal(store.add({ surprise: 42 }), null)
  assert.equal(store.all().length, 0)
})

ok('id and t are the relay\'s to assign; a caller cannot set or reorder them', () => {
  const store = createFindings({ file: freshFile(), now: () => 5000 })
  const rec = store.add(full({ id: 'FORGED', t: 1 }))
  assert.notEqual(rec.id, 'FORGED')
  assert.equal(rec.t, 5000)
})

ok('a bare string touched/evidence is accepted as a one-element list', () => {
  const store = createFindings({ file: freshFile() })
  const rec = store.add(full({ touched: 'relay.mjs', evidence: 'relay.mjs:12' }))
  assert.deepEqual(rec.touched, ['relay.mjs'])
  assert.deepEqual(rec.evidence, ['relay.mjs:12'])
})

ok('per-field caps bound one runaway record', () => {
  const store = createFindings({ file: freshFile() })
  const rec = store.add(full({
    surprise: 'x'.repeat(SURPRISE_MAX + 500),
    touched: Array.from({ length: LIST_MAX + 10 }, (_, i) => 'f' + i),
  }))
  assert.equal(rec.surprise.length, SURPRISE_MAX)
  assert.equal(rec.touched.length, LIST_MAX)
})

ok('control characters are stripped, but newlines and tabs survive', () => {
  const store = createFindings({ file: freshFile() })
  const rec = store.add(full({ surprise: 'line one\nline two\x00\x07' }))
  assert.equal(rec.surprise, 'line one\nline two')
})

// ------------------------------------------------- the sanitising reader --
ok('sanitizeFinding drops a non-object rather than throwing', () => {
  for (const bad of [null, undefined, 42, 'a string', ['an', 'array'], true]) {
    assert.equal(sanitizeFinding(bad), null)
  }
})

ok('readFindings drops malformed entries and keeps the good ones', () => {
  const file = freshFile()
  writeFileSync(file, JSON.stringify({
    version: 1,
    findings: [
      null,
      'a bare string',
      { surprise: 'no timestamp at all' },
      { t: 1, surprise: '' },
      { t: 'not a number', surprise: 'ok' },
      { t: 10, surprise: 'the good one', touched: [null, 'x', 7], evidence: 'y:1' },
    ],
  }))
  const out = readFindings(file)
  assert.equal(out.length, 1, 'five malformed entries dropped, one kept')
  assert.equal(out[0].surprise, 'the good one')
  assert.deepEqual(out[0].touched, ['x'], 'a null and a number inside the list go too')
  assert.deepEqual(out[0].evidence, ['y:1'])
})

ok('a missing file is the normal first-run case, not an error', () => {
  assert.deepEqual(readFindings(join(freshDir(), 'nope.json')), [])
  const store = createFindings({ file: join(freshDir(), 'nope.json') })
  assert.deepEqual(store.all(), [])
})

ok('a corrupt file degrades to no findings rather than throwing', () => {
  const file = freshFile()
  writeFileSync(file, '{ this is not json at all')
  assert.deepEqual(readFindings(file), [])
  assert.deepEqual(createFindings({ file }).all(), [])
})

ok('a file whose findings key is not an array degrades to no findings', () => {
  const file = freshFile()
  writeFileSync(file, JSON.stringify({ version: 1, findings: { nope: true } }))
  assert.deepEqual(readFindings(file), [])
})

// ------------------------------------------------------------- the store --
ok('records come back oldest first, newest last', () => {
  let t = 1000
  const store = createFindings({ file: freshFile(), now: () => t })
  store.add(full({ surprise: 'first' })); t += 1000
  store.add(full({ surprise: 'second' })); t += 1000
  store.add(full({ surprise: 'third' }))
  assert.deepEqual(store.all().map((f) => f.surprise), ['first', 'second', 'third'])
})

ok('the store is capped at FINDINGS_MAX, oldest dropped first', () => {
  let t = 1000
  const file = freshFile()
  const store = createFindings({ file, now: () => t++ })
  for (let i = 0; i < FINDINGS_MAX + 25; i++) store.add(full({ surprise: 'S' + i }))
  assert.equal(store.all().length, FINDINGS_MAX)
  assert.equal(store.all()[0].surprise, 'S25', 'the first 25 went')
  assert.equal(store.all().at(-1).surprise, 'S' + (FINDINGS_MAX + 24))
  assert.equal(readFindings(file).length, FINDINGS_MAX, 'and the cap is on disk too')
})

ok('read({limit}) returns the newest N, and a junk limit falls back to the cap', () => {
  let t = 1000
  const store = createFindings({ file: freshFile(), now: () => t++ })
  for (let i = 0; i < 10; i++) store.add(full({ surprise: 'S' + i }))
  assert.deepEqual(store.read({ limit: 3 }).map((f) => f.surprise), ['S7', 'S8', 'S9'])
  assert.equal(store.read({ limit: NaN }).length, 10)
  assert.equal(store.read({ limit: -5 }).length, 10)
  assert.equal(store.read().length, 10)
})

ok('remove takes one record out, on disk as well, and 404s an unknown id', () => {
  const file = freshFile()
  const store = createFindings({ file })
  const a = store.add(full({ surprise: 'keep me' }))
  const b = store.add(full({ surprise: 'drop me' }))
  assert.equal(store.remove(b.id), true)
  assert.deepEqual(store.all().map((f) => f.id), [a.id])
  assert.deepEqual(readFindings(file).map((f) => f.id), [a.id])
  assert.equal(store.remove('never-existed'), false)
})

ok('a store reloads exactly what the previous one wrote', () => {
  const file = freshFile()
  const first = createFindings({ file, now: () => 7777 })
  first.add(full({ surprise: 'survives a restart' }))
  const second = createFindings({ file })
  assert.equal(second.all().length, 1)
  assert.equal(second.all()[0].surprise, 'survives a restart')
  assert.equal(second.all()[0].t, 7777)
})

// ------------------------------------------------------ the write itself --
ok('the write is atomic: temp file then rename, and no .tmp is left behind', () => {
  const dir = freshDir()
  const file = join(dir, 'findings.json')
  const store = createFindings({ file })
  store.add(full())
  assert.deepEqual(readdirSync(dir), ['findings.json'], 'the temp file is renamed, never left')
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).findings.length === 1)
})

ok('a write that cannot land throws rather than reporting success, and leaves the previous file intact', () => {
  const dir = freshDir()
  const file = join(dir, 'findings.json')
  const store = createFindings({ file })
  store.add(full({ surprise: 'the good one' }))
  const before = readFileSync(file, 'utf8')
  chmodSync(dir, 0o500) // read + execute, no write
  let threw = false
  try { store.add(full({ surprise: 'cannot land' })) } catch { threw = true }
  chmodSync(dir, 0o700)
  assert.equal(threw, true, 'a failed write is never silent')
  assert.equal(readFileSync(file, 'utf8'), before, 'the previous file is byte-for-byte what it was')
  assert.ok(!existsSync(file + '.tmp'), 'and the temp file is cleaned up')
})

console.log(`findings-harness: ${pass} passed`)
