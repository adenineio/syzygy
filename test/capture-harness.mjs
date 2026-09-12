#!/usr/bin/env node
// Drives bridge/capture.mjs against a temp directory. Hermetic: never
// WORLD_DIR, never a relay.
import assert from 'node:assert/strict'
import { mkdtempSync, chmodSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { createCapture, CAPTURE_FILE, ROTATE_AT_BYTES, DEFAULT_LIMIT, MAX_LIMIT } =
  await import(join(ROOT, 'syzygy', 'bridge', 'capture.mjs'))

let pass = 0
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label) }
const dir = () => mkdtempSync(join(tmpdir(), 'szg-capture-'))

ok('a line is one JSON object with t/kind/actor', () => {
  const d = dir()
  let t = 1000
  const cap = createCapture({ dir: d, now: () => t })
  assert.equal(cap.append('link', 's1', { from: 'a', to: 'b' }), true)
  const raw = readFileSync(join(d, CAPTURE_FILE), 'utf8')
  const lines = raw.split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  const obj = JSON.parse(lines[0])
  assert.equal(obj.t, 1000)
  assert.equal(obj.kind, 'link')
  assert.equal(obj.actor, 's1')
  assert.equal(obj.from, 'a')
  assert.equal(obj.to, 'b')
})

ok('a payload field named kind/actor/t cannot shadow the event\'s own', () => {
  const d = dir()
  const cap = createCapture({ dir: d, now: () => 999 })
  cap.append('link', 's1', { kind: 'brief', actor: 'nobody', t: 1 })
  const obj = JSON.parse(readFileSync(join(d, CAPTURE_FILE), 'utf8').split('\n')[0])
  assert.equal(obj.kind, 'link')
  assert.equal(obj.actor, 's1')
  assert.equal(obj.t, 999)
})

ok('two appends leave two lines and the first is byte-identical afterwards', () => {
  const d = dir()
  let t = 0
  const cap = createCapture({ dir: d, now: () => t })
  t = 100
  cap.append('link', 's1', { n: 1 })
  const firstLine = readFileSync(join(d, CAPTURE_FILE), 'utf8').split('\n')[0]
  t = 200
  cap.append('unlink', 's1', { n: 2 })
  const raw = readFileSync(join(d, CAPTURE_FILE), 'utf8')
  const lines = raw.split('\n').filter(Boolean)
  assert.equal(lines.length, 2)
  assert.equal(lines[0], firstLine)
})

ok('read honours since', () => {
  const d = dir()
  let t = 0
  const cap = createCapture({ dir: d, now: () => t })
  t = 10; cap.append('a', 's1', {})
  t = 20; cap.append('b', 's1', {})
  t = 30; cap.append('c', 's1', {})
  const back = cap.read({ since: 15 })
  assert.deepEqual(back.map((e) => e.kind), ['b', 'c'])
})

ok('limit caps at 1000 with a default of 200', () => {
  const d = dir()
  let t = 0
  const cap = createCapture({ dir: d, now: () => t })
  for (let i = 0; i < 1200; i++) { t = i; cap.append('e', 's1', { i }) }
  const withNoLimit = cap.read({})
  assert.equal(withNoLimit.length, DEFAULT_LIMIT)
  assert.equal(withNoLimit[withNoLimit.length - 1].i, 1199)
  const withHugeLimit = cap.read({ limit: 999999 })
  assert.equal(withHugeLimit.length, MAX_LIMIT)
  assert.equal(withHugeLimit[withHugeLimit.length - 1].i, 1199)
})

ok('a malformed line already in the file is skipped, not fatal', () => {
  const d = dir()
  let t = 0
  const cap = createCapture({ dir: d, now: () => t })
  t = 10; cap.append('a', 's1', {})
  writeFileSync(join(d, CAPTURE_FILE), readFileSync(join(d, CAPTURE_FILE), 'utf8') + 'not json at all\n')
  t = 20; cap.append('b', 's1', {})
  const back = cap.read({})
  assert.deepEqual(back.map((e) => e.kind), ['a', 'b'])
})

ok('rotation past the 4 MB cap leaves capture.jsonl.1 and a fresh file', () => {
  const d = dir()
  let t = 0
  const cap = createCapture({ dir: d, now: () => t })
  // One append with a payload just over the cap, so the NEXT append rotates
  // (rotation is checked before an append, never after).
  const big = 'x'.repeat(ROTATE_AT_BYTES + 10)
  t = 1; cap.append('big', 's1', { big })
  t = 2; cap.append('small', 's1', { n: 1 })
  const rotated = readFileSync(join(d, CAPTURE_FILE + '.1'), 'utf8')
  assert.ok(rotated.includes('"kind":"big"'))
  const fresh = readFileSync(join(d, CAPTURE_FILE), 'utf8').split('\n').filter(Boolean)
  assert.equal(fresh.length, 1)
  assert.equal(JSON.parse(fresh[0]).kind, 'small')
})

if (platform() !== 'win32' && process.getuid && process.getuid() !== 0) {
  ok('an unwritable directory makes append return false rather than throw', () => {
    const d = dir()
    chmodSync(d, 0o500) // read+execute, no write
    try {
      const cap = createCapture({ dir: d, now: () => 1 })
      let threw = false
      let result
      try { result = cap.append('a', 's1', {}) } catch { threw = true }
      assert.equal(threw, false, 'append must never throw')
      assert.equal(result, false)
    } finally {
      chmodSync(d, 0o700) // so the temp-dir cleanup (if any) can remove it
    }
  })
} else {
  console.log('  skip  an unwritable directory makes append return false rather than throw (root or win32)')
}

console.log(`capture-harness: ${pass} passed`)
