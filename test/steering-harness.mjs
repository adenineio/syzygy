import assert from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSteeringStore, MAX_BUTTONS, MAX_LABEL, MAX_PROMPT } from '../syzygy/bridge/steering.mjs'

const ok = (m) => console.log('✔ ' + m)
const box = () => join(mkdtempSync(join(tmpdir(), 'szg-steer-')), 'steering.json')

// A missing file is a first run, not corruption.
{
  const s = createSteeringStore({ file: box() })
  assert.deepEqual(s.all(), [])
  ok('a missing steering.json loads as an empty list')
}

// The store mints ids and ignores any the client sent.
{
  const s = createSteeringStore({ file: box(), now: () => 1000 })
  const r = s.replace([{ id: 'attacker', label: 'ship it', prompt: 'push to main' }])
  assert.equal(r.ok, true)
  assert.notEqual(r.custom[0].id, 'attacker', 'a client-supplied id was honoured')
  assert.equal(r.custom[0].label, 'ship it')
  assert.equal(r.custom[0].createdAt, 1000)
  ok('replace() mints its own ids and keeps label/prompt/createdAt')
}

// Every bound rejects rather than truncating.
{
  const s = createSteeringStore({ file: box() })
  for (const [bad, why] of [
    [[{ label: '', prompt: 'x' }], 'an empty label'],
    [[{ label: 'a', prompt: '' }], 'an empty prompt'],
    [[{ label: 'a'.repeat(MAX_LABEL + 1), prompt: 'x' }], 'an over-long label'],
    [[{ label: 'a', prompt: 'x'.repeat(MAX_PROMPT + 1) }], 'an over-long prompt'],
    [Array.from({ length: MAX_BUTTONS + 1 }, (_, i) => ({ label: 'b' + i, prompt: 'x' })), 'too many buttons'],
    ['not a list', 'a non-array'],
    [[null], 'a null entry'],
    [[{ label: 5, prompt: 'x' }], 'a non-string label'],
  ]) {
    const r = s.replace(bad)
    assert.equal(r.ok, false, why + ' was accepted')
    assert.equal(typeof r.error, 'string')
  }
  assert.deepEqual(s.all(), [], 'a rejected write changed the list')
  ok('every validation bound rejects, and a rejected write leaves the list alone')
}

// A label is trimmed, and the trimmed length is what is measured.
{
  const s = createSteeringStore({ file: box() })
  const r = s.replace([{ label: '  ship  ', prompt: '  do it  ' }])
  assert.equal(r.ok, true)
  assert.equal(r.custom[0].label, 'ship')
  assert.equal(r.custom[0].prompt, 'do it')
  ok('label and prompt are trimmed')
}

// Unknown fields on a stored button survive a round trip: the file is
// hand-editable, the same rule claims.mjs follows.
{
  const file = box()
  writeFileSync(file, JSON.stringify({
    version: 1,
    custom: [{ id: 'keep-me', label: 'old', prompt: 'p', createdAt: 1, note: 'mine' }],
  }))
  const s = createSteeringStore({ file })
  assert.equal(s.all()[0].note, 'mine', 'an unknown field was dropped on load')
  ok('an unknown field on a stored button is carried through')
}

// Atomic write: serialize first, temp file, rename. No .tmp left behind.
{
  const file = box()
  const s = createSteeringStore({ file })
  s.replace([{ label: 'go', prompt: 'do it' }])
  s.flush()
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.custom[0].label, 'go')
  assert.equal(existsSync(file + '.tmp'), false, 'a .tmp file was left behind')
  ok('flush() writes atomically and leaves no temp file')
}

// A file that EXISTS but will not parse is moved aside, never overwritten:
// this store is authoritative and the only copy.
{
  const file = box()
  writeFileSync(file, '{ not json')
  const s = createSteeringStore({ file, now: () => 77 })
  assert.deepEqual(s.all(), [])
  const aside = readdirSync(join(file, '..')).filter((f) => f.includes('.corrupt-'))
  assert.equal(aside.length, 1, 'a corrupt file was not moved aside')
  ok('a corrupt steering.json is quarantined, not destroyed')
}

// The route, against a REAL relay on an ephemeral port. SZG_PORT=0 so this can
// never collide with a relay a real session is using.
{
  const { spawn } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'szg-steer-relay-'))
  const proc = spawn(process.execPath, ['syzygy/bridge/relay.mjs'], {
    env: { ...process.env, SZG_PORT: '0', SZG_DATA_DIR: dir, SZG_TOKEN: 't',
      // This harness authenticates with the token, never a cookie.
      SZG_PANE_PASSWORD_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let port = 0
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('relay did not report a port in 15s')), 15_000)
    proc.stdout.on('data', (b) => {
      const m = /(?:port|:)(\d{4,5})\b/.exec(String(b))
      if (m) { port = Number(m[1]); clearTimeout(t); resolve() }
    })
  })
  const call = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify({ token: 't', ...body }) : undefined,
    })
    return { status: r.status, json: await r.json() }
  }
  try {
    const empty = await call('/api/state')
    assert.deepEqual(empty.json.steering, { custom: [] }, 'snapshot has no steering field')
    ok('snapshot() carries an empty steering.custom before anything is saved')

    const bad = await call('/api/steering', { custom: [{ label: '', prompt: 'x' }] })
    assert.equal(bad.status, 400)
    ok('POST /api/steering rejects an invalid button with 400 and a reason')

    const good = await call('/api/steering', { custom: [{ label: 'ship', prompt: 'ship it' }] })
    assert.equal(good.status, 200)
    assert.equal(good.json.steering.custom[0].label, 'ship')
    ok('POST /api/steering saves a button and answers with the new list')

    const after = await call('/api/state')
    assert.equal(after.json.steering.custom[0].label, 'ship')
    ok('the saved button is on the next snapshot')

    const noToken = await fetch(`http://127.0.0.1:${port}/api/steering`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ custom: [] }),
    })
    assert.equal(noToken.status, 401, 'the route answered without a token')
    ok('POST /api/steering is token-gated')

    assert.ok(existsSync(join(dir, 'steering.json')), 'nothing was written to disk')
    ok('the button reached WORLD_DIR/steering.json')
  } finally {
    proc.kill()
  }
}

console.log('\nsteering store: all checks passed')
