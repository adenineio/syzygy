#!/usr/bin/env node
// Drives bridge/usage.mjs and bridge/after-reset.mjs directly. Hermetic: no
// relay, no real filesystem beyond a temp dir for the store, and the
// statusline directory is a fake `fs` object handed to readNewestStatusline
// -- never a read of the real ~/.claude/syzygy/statusline. A fixture is a real
// drop's shape, copied in. Run: node test/usage-harness.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { parseUsage, readNewestStatusline, crossings, dueEntries, DEFAULT_STALE_MS } =
  await import(join(ROOT, 'syzygy', 'bridge', 'usage.mjs'))
const { createAfterResetStore } =
  await import(join(ROOT, 'syzygy', 'bridge', 'after-reset.mjs'))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }
const dir = mkdtempSync(join(tmpdir(), 'szg-usage-'))

// A real drop's shape, copied in
// and redacted -- the host path and every session-identifying field a real
// drop carries are replaced with placeholders. Only `rate_limits` and
// `szg_written_at` matter to parseUsage; the rest proves it tolerates a drop
// carrying dozens of fields it does not read.
const REAL_DROP = {
  session_id: 'redacted-session',
  transcript_path: '~/.claude/projects/redacted/redacted.jsonl',
  cwd: '~/redacted-project',
  model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1' },
  version: '2.1.269',
  context_window: { context_window_size: 1_000_000, used_percentage: 37 },
  rate_limits: {
    five_hour: { used_percentage: 23, resets_at: 1789171200 },
    seven_day: { used_percentage: 76, resets_at: 1789261200 },
  },
  szg_written_at: 1789165024,
}

// ======================================================================
// parseUsage
// ======================================================================

await ok('parseUsage reads a real drop\'s two windows, converting seconds to ms', () => {
  const now = 1789165024_000 // exactly szg_written_at, in ms -- freshest possible
  const u = parseUsage(REAL_DROP, now)
  assert.equal(u.stale, false)
  assert.equal(u.observedAt, 1789165024_000)
  assert.deepEqual(u.fiveHour, { pct: 23, resetsAt: 1789171200_000, resetsInMs: 1789171200_000 - now, expired: false })
  assert.deepEqual(u.sevenDay, { pct: 76, resetsAt: 1789261200_000, resetsInMs: 1789261200_000 - now, expired: false })
})

await ok('parseUsage never throws on malformed input: both windows null', () => {
  for (const bad of [null, undefined, 'a string', 42, [], {}]) {
    const u = parseUsage(bad, Date.now())
    assert.equal(u.fiveHour, null, JSON.stringify(bad))
    assert.equal(u.sevenDay, null, JSON.stringify(bad))
    assert.equal(u.stale, true, JSON.stringify(bad))
  }
})

await ok('parseUsage tolerates a missing rate_limits block: both windows null, no throw', () => {
  const u = parseUsage({ szg_written_at: 1000, session_id: 'x' }, 1000_000)
  assert.equal(u.fiveHour, null)
  assert.equal(u.sevenDay, null)
  assert.equal(u.observedAt, 1_000_000)
})

await ok('parseUsage tolerates one window missing while the other is present', () => {
  const u = parseUsage({ szg_written_at: 0, rate_limits: { five_hour: { used_percentage: 10, resets_at: 100 } } }, 0)
  assert.ok(u.fiveHour)
  assert.equal(u.sevenDay, null)
})

await ok('parseUsage: a stamp older than the stale window reads stale', () => {
  const writtenAtMs = 1_000_000
  const drop = { ...REAL_DROP, szg_written_at: writtenAtMs / 1000 }
  assert.equal(parseUsage(drop, writtenAtMs + DEFAULT_STALE_MS + 1, DEFAULT_STALE_MS).stale, true)
  assert.equal(parseUsage(drop, writtenAtMs + DEFAULT_STALE_MS, DEFAULT_STALE_MS).stale, false, 'exactly at the boundary is still fresh')
})

await ok('parseUsage: no szg_written_at at all reads stale, never as fresh-by-default', () => {
  const u = parseUsage({ rate_limits: REAL_DROP.rate_limits }, Date.now())
  assert.equal(u.observedAt, null)
  assert.equal(u.stale, true)
})

await ok('parseUsage: a stale reading still returns real resetsAt values, not nulled windows', () => {
  const drop = { ...REAL_DROP, szg_written_at: 0 }
  const now = DEFAULT_STALE_MS * 10 // hours stale
  const u = parseUsage(drop, now)
  assert.equal(u.stale, true)
  assert.ok(u.fiveHour, 'the window itself must survive staleness -- only display hides the pct')
  assert.equal(u.fiveHour.pct, 23)
  assert.equal(u.fiveHour.resetsAt, 1789171200_000)
})

await ok('parseUsage marks an already-passed boundary as expired, with a negative resetsInMs', () => {
  const drop = { szg_written_at: 100, rate_limits: { five_hour: { used_percentage: 99, resets_at: 100 } } }
  const u = parseUsage(drop, 200_000) // now is far past resets_at (100s = 100000ms)
  assert.equal(u.fiveHour.expired, true)
  assert.ok(u.fiveHour.resetsInMs < 0)
})

// ======================================================================
// readNewestStatusline
// ======================================================================

/** A fake fs exposing only what readNewestStatusline touches. `files` maps a
 *  FULL path (as usage.mjs's own `join(dir, name)` will build it) to
 *  { mtimeMs, content }, so the test controls mtime order independently of
 *  filesystem write order. */
const fakeFs = (statusDir, files) => ({
  readdirSync: (d) => {
    if (d !== statusDir) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
    return Object.keys(files).map((full) => full.slice(statusDir.length + 1))
  },
  statSync: (full) => {
    if (!(full in files)) throw new Error(`no such file: ${full}`)
    return { mtimeMs: files[full].mtimeMs }
  },
  readFileSync: (full) => {
    if (!(full in files)) throw new Error(`no such file: ${full}`)
    return files[full].content
  },
})

await ok('readNewestStatusline is null when the directory does not exist', () => {
  assert.equal(readNewestStatusline('/nowhere', { fs: fakeFs('/elsewhere', {}) }), null)
})

await ok('readNewestStatusline is null with no fs injected', () => {
  assert.equal(readNewestStatusline('/x', {}), null)
})

await ok('readNewestStatusline: the newest file wins when it is usable', () => {
  const d = '/status'
  const old = join(d, 'old.json'), fresh = join(d, 'fresh.json')
  const fs = fakeFs(d, {
    [old]: { mtimeMs: 1000, content: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 1 } } }) },
    [fresh]: { mtimeMs: 2000, content: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 99, resets_at: 2 } } }) },
  })
  const got = readNewestStatusline(d, { fs })
  assert.equal(got.rate_limits.five_hour.used_percentage, 99)
})

await ok('readNewestStatusline: a newest file with no rate_limits does not blind the board', () => {
  const d = '/status'
  const old = join(d, 'old.json'), fresh = join(d, 'fresh.json')
  const fs = fakeFs(d, {
    [old]: { mtimeMs: 1000, content: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 1 } } }) },
    // The NEWEST drop, but no rate_limits block yet (e.g. a session that has
    // not reported one) -- must fall through to the older, usable file.
    [fresh]: { mtimeMs: 2000, content: JSON.stringify({ session_id: 'x' }) },
  })
  const got = readNewestStatusline(d, { fs })
  assert.equal(got.rate_limits.five_hour.used_percentage, 10)
})

await ok('readNewestStatusline gives up after 5 parses rather than scanning forever', () => {
  const d = '/status'
  const files = {}
  // 6 candidates, newest-to-oldest by mtime, none usable until the 6th (which
  // must never be reached: the cap is 5).
  for (let i = 0; i < 6; i++) {
    const full = join(d, `f${i}.json`)
    const usable = i === 5
    files[full] = {
      mtimeMs: 6000 - i * 100,
      content: usable
        ? JSON.stringify({ rate_limits: { five_hour: { used_percentage: 1, resets_at: 1 } } })
        : JSON.stringify({ no_rate_limits_here: true }),
    }
  }
  const got = readNewestStatusline(d, { fs: fakeFs(d, files) })
  assert.equal(got, null, 'the 6th, usable file must not be reached')
})

await ok('readNewestStatusline ignores non-.json entries and unreadable/unparseable files', () => {
  const d = '/status'
  const files = {
    [join(d, 'note.txt')]: { mtimeMs: 9999, content: 'not json at all' },
    [join(d, 'broken.json')]: { mtimeMs: 5000, content: '{not valid json' },
    [join(d, 'good.json')]: { mtimeMs: 1000, content: JSON.stringify({ rate_limits: { seven_day: { used_percentage: 5, resets_at: 9 } } }) },
  }
  const got = readNewestStatusline(d, { fs: fakeFs(d, files) })
  assert.equal(got.rate_limits.seven_day.used_percentage, 5)
})

// ======================================================================
// crossings
// ======================================================================

const usageAt = (fiveHourPct, sevenDayPct) => ({
  fiveHour: fiveHourPct == null ? null : { pct: fiveHourPct, resetsAt: 1000, resetsInMs: 1000, expired: false },
  sevenDay: sevenDayPct == null ? null : { pct: sevenDayPct, resetsAt: 2000, resetsInMs: 2000, expired: false },
  observedAt: 0, stale: false,
})

await ok('crossings fires once when pct climbs through a threshold', () => {
  const c = crossings(usageAt(80, 10), usageAt(90, 10), [85, 95])
  assert.deepEqual(c, [{ window: 'fiveHour', threshold: 85 }])
})

await ok('crossings does not fire for a threshold not yet reached', () => {
  assert.deepEqual(crossings(usageAt(80, 10), usageAt(84, 10), [85, 95]), [])
})

await ok('crossings does not re-fire while pct sits above an already-crossed threshold', () => {
  assert.deepEqual(crossings(usageAt(90, 10), usageAt(91, 10), [85, 95]), [])
})

await ok('crossings fires both thresholds in one jump', () => {
  const c = crossings(usageAt(10, 10), usageAt(99, 10), [85, 95])
  assert.deepEqual(c, [{ window: 'fiveHour', threshold: 85 }, { window: 'fiveHour', threshold: 95 }])
})

await ok('crossings covers both windows independently', () => {
  const c = crossings(usageAt(10, 10), usageAt(90, 96), [85, 95])
  assert.deepEqual(c, [{ window: 'fiveHour', threshold: 85 }, { window: 'sevenDay', threshold: 85 }, { window: 'sevenDay', threshold: 95 }])
})

await ok('crossings re-arm: a reset that drops pct lets the same threshold fire again', () => {
  // First climb: crosses 85. Window resets (pct falls back down with no
  // special-casing needed -- see the file header). Second climb: crosses 85
  // again, exactly the "re-armed when resetsAt moves" behaviour.
  const first = crossings(usageAt(80, 0), usageAt(90, 0), [85])
  assert.deepEqual(first, [{ window: 'fiveHour', threshold: 85 }])
  const afterReset = usageAt(3, 0) // the window rolled over
  const second = crossings(afterReset, usageAt(86, 0), [85])
  assert.deepEqual(second, [{ window: 'fiveHour', threshold: 85 }])
})

await ok('crossings tolerates a missing prev or next window (no prior reading yet)', () => {
  assert.deepEqual(crossings(usageAt(null, 10), usageAt(90, 10), [85]), [])
  assert.deepEqual(crossings(null, usageAt(90, 10), [85]), [])
  assert.deepEqual(crossings(usageAt(10, 10), null, [85]), [])
})

// ======================================================================
// dueEntries
// ======================================================================

const pendingEntry = (fields) => ({
  id: 'e1', createdAt: 0, window: 'fiveHour', kind: 'prompt', target: 's1', payload: {},
  armedResetsAt: null, state: 'pending', firedAt: null, error: null, ...fields,
})

await ok('dueEntries: fires only once a fresh reading shows the boundary moved PAST the armed one', () => {
  const usage = { fiveHour: { pct: 1, resetsAt: 2000, resetsInMs: 1000, expired: false }, sevenDay: null, stale: false }
  assert.deepEqual(dueEntries([pendingEntry({ armedResetsAt: 1000 })], usage, 5000), [pendingEntry({ armedResetsAt: 1000 })])
  // Armed AT the current resetsAt (not past it) must not fire -- equal is not "moved".
  assert.deepEqual(dueEntries([pendingEntry({ armedResetsAt: 2000 })], usage, 5000), [])
  // Still in the future: no fire.
  assert.deepEqual(dueEntries([pendingEntry({ armedResetsAt: 3000 })], usage, 5000), [])
})

await ok('dueEntries returns [] outright for a stale reading', () => {
  const usage = { fiveHour: { pct: 1, resetsAt: 100, resetsInMs: -900, expired: true }, sevenDay: null, stale: true }
  assert.deepEqual(dueEntries([pendingEntry({ armedResetsAt: 50 })], usage, 999_999), [])
})

await ok('dueEntries: no armed boundary falls back to fresh reading + now >= resetsAt', () => {
  const usage = { fiveHour: { pct: 1, resetsAt: 1000, resetsInMs: 0, expired: true }, sevenDay: null, stale: false }
  assert.deepEqual(dueEntries([pendingEntry({ armedResetsAt: null })], usage, 1000), [pendingEntry({ armedResetsAt: null })])
  assert.deepEqual(dueEntries([pendingEntry({ armedResetsAt: null })], usage, 999), [])
})

await ok('dueEntries ignores non-pending entries and entries for an absent window', () => {
  const usage = { fiveHour: { pct: 1, resetsAt: 100, resetsInMs: -1, expired: true }, sevenDay: null, stale: false }
  assert.deepEqual(dueEntries([pendingEntry({ state: 'fired', armedResetsAt: 0 })], usage, 999), [])
  assert.deepEqual(dueEntries([pendingEntry({ state: 'cancelled', armedResetsAt: 0 })], usage, 999), [])
  assert.deepEqual(dueEntries([pendingEntry({ window: 'sevenDay', armedResetsAt: 0 })], usage, 999), [], 'sevenDay is null in this usage reading')
})

await ok('dueEntries tolerates a non-array queue', () => {
  assert.deepEqual(dueEntries(null, { fiveHour: null, sevenDay: null, stale: false }, 0), [])
  assert.deepEqual(dueEntries(undefined, { fiveHour: null, sevenDay: null, stale: false }, 0), [])
})

// ======================================================================
// bridge/after-reset.mjs — the store
// ======================================================================

await ok('create assigns id, state pending and the given fields', () => {
  const s = createAfterResetStore({ file: join(dir, 'a.json'), now: () => 1000 })
  const e = s.create({ window: 'fiveHour', kind: 'prompt', target: 's1', payload: { text: 'go' }, armedResetsAt: 5000 })
  assert.equal(e.state, 'pending')
  assert.equal(e.createdAt, 1000)
  assert.equal(e.armedResetsAt, 5000)
  assert.ok(e.id)
  assert.equal(s.get(e.id).payload.text, 'go')
})

await ok("create refuses kind 'resume', naming the kind and the reason", () => {
  const s = createAfterResetStore({ file: join(dir, 'b.json') })
  assert.throws(() => s.create({ window: 'fiveHour', kind: 'resume', target: 's1' }), /resume/)
})

await ok('create refuses an unknown window or kind', () => {
  const s = createAfterResetStore({ file: join(dir, 'c.json') })
  assert.throws(() => s.create({ window: 'nope', kind: 'prompt' }), /window/)
  assert.throws(() => s.create({ window: 'fiveHour', kind: 'nope' }), /kind/)
})

await ok('markFired moves pending -> fired or failed, and refuses a non-pending entry', () => {
  const s = createAfterResetStore({ file: join(dir, 'd.json'), now: () => 42 })
  const ok1 = s.create({ window: 'fiveHour', kind: 'implement', payload: { ids: ['x'] } })
  const bad = s.create({ window: 'sevenDay', kind: 'prompt', target: 's1' })
  s.markFired(ok1.id, { ok: true })
  assert.equal(s.get(ok1.id).state, 'fired')
  assert.equal(s.get(ok1.id).firedAt, 42)
  assert.equal(s.get(ok1.id).error, null)
  s.markFired(bad.id, { ok: false, error: 'boom' })
  assert.equal(s.get(bad.id).state, 'failed')
  assert.equal(s.get(bad.id).error, 'boom')
  // Already settled: a second markFired call is a no-op, not a state flip.
  assert.equal(s.markFired(ok1.id, { ok: false, error: 'late' }), null)
  assert.equal(s.get(ok1.id).state, 'fired')
})

await ok('cancel moves a pending entry to cancelled and leaves a settled one alone', () => {
  const s = createAfterResetStore({ file: join(dir, 'e.json') })
  const pending = s.create({ window: 'fiveHour', kind: 'prompt', target: 's1' })
  const fired = s.create({ window: 'fiveHour', kind: 'prompt', target: 's1' })
  s.markFired(fired.id, { ok: true })
  assert.equal(s.cancel(pending.id), true)
  assert.equal(s.get(pending.id).state, 'cancelled')
  assert.equal(s.cancel(fired.id), true, 'a known but already-settled id is still a successful no-op')
  assert.equal(s.get(fired.id).state, 'fired', 'settled state is not overwritten')
  assert.equal(s.cancel('no-such-id'), false)
})

await ok('flush writes atomically and reloads identically, sanitising a hand-edited entry', () => {
  const f = join(dir, 'f.json')
  const s = createAfterResetStore({ file: f })
  const e = s.create({ window: 'sevenDay', kind: 'implement', payload: { ids: ['a', 'b'] } })
  s.flush()
  assert.ok(existsSync(f))
  assert.equal(existsSync(f + '.tmp'), false, 'temp file must not survive')
  const again = createAfterResetStore({ file: f })
  assert.deepEqual(again.get(e.id).payload, { ids: ['a', 'b'] })
})

await ok('a non-object entry in the file is dropped rather than crashing the load', () => {
  const f = join(dir, 'g.json')
  writeFileSync(f, JSON.stringify({ version: 1, items: [null, 'garbage', { id: 'ok1', window: 'fiveHour', kind: 'prompt', state: 'pending' }, { window: 'no-id-field' }] }))
  const s = createAfterResetStore({ file: f })
  assert.deepEqual(s.all().map((e) => e.id), ['ok1'])
})

await ok('a corrupt file is moved aside rather than silently overwritten', () => {
  const f = join(dir, 'h.json')
  writeFileSync(f, '{not json')
  const s = createAfterResetStore({ file: f, now: () => 777 })
  assert.deepEqual(s.all(), [])
  assert.ok(existsSync(f + '.corrupt-777'))
  assert.equal(readFileSync(f + '.corrupt-777', 'utf8'), '{not json')
})

// ======================================================================
// relay.mjs — the live routes (a real subprocess, an isolated port/data dir)
// ======================================================================
// every after-reset WRITE is a
// POST inside relay.mjs's single authed()+try/catch POST block, specifically
// because that is a structural guard a route outside it does not inherit.
// The one thing a harness that never starts a real relay cannot prove is
// that the guard is actually wired up on this route -- a bad token must
// still 401 here, not slip through because the path is new. A harness that
// mocks its dependencies cannot verify the wiring, so this section runs the
// real relay.mjs rather than re-implementing its routing.
{
  const { spawn } = await import('node:child_process')
  const relayDataDir = mkdtempSync(join(tmpdir(), 'szg-usage-relay-'))
  const relayPath = join(ROOT, 'syzygy', 'bridge', 'relay.mjs')
  const RELAY_TOKEN = 'usage-harness-token'
  const child = spawn(process.execPath, [relayPath], {
    env: { ...process.env, SZG_PORT: '0', SZG_TOKEN: RELAY_TOKEN, SZG_DATA_DIR: relayDataDir,
      // This harness authenticates with the token, never a cookie.
      SZG_PANE_PASSWORD_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderrText = ''
  child.stderr.on('data', (c) => { stderrText += c })
  const port = await new Promise((resolvePort, reject) => {
    let out = ''
    const onData = (chunk) => {
      out += chunk
      const m = out.match(/relay on http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { child.stdout.off('data', onData); resolvePort(Number(m[1])) }
    }
    child.stdout.on('data', onData)
    child.on('error', reject)
    child.on('exit', (code) => reject(new Error(`relay exited early with code ${code}; stderr: ${stderrText}`)))
    setTimeout(() => reject(new Error('relay did not report a port in time')), 8000)
  })
  const base = `http://127.0.0.1:${port}`
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, ...(await r.json().catch(() => ({}))) }
  }

  await ok('POST /api/after-reset rejects a bad token with 401', async () => {
    const r = await post('/api/after-reset', { token: 'WRONG', window: 'fiveHour', kind: 'prompt', target: 'x' })
    assert.equal(r.status, 401)
  })

  await ok('POST /api/after-reset/delete rejects a bad token with 401 -- the follow-on this design change asked for', async () => {
    const r = await post('/api/after-reset/delete', { token: 'WRONG', id: 'whatever' })
    assert.equal(r.status, 401)
  })

  await ok('POST /api/after-reset with the right token creates a pending entry; GET /api/after-reset is unauthenticated', async () => {
    const created = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fiveHour', kind: 'prompt', target: 's1', payload: { text: 'go' } })
    assert.equal(created.status, 200)
    assert.equal(created.entry.state, 'pending')
    const listed = await (await fetch(base + '/api/after-reset')).json() // no token at all
    assert.equal(listed.queue.length, 1)
    assert.equal(listed.queue[0].id, created.entry.id)
  })

  // This API and the platform's own `rate_limits` both spell these
  // snake_case, so that is what the orchestrator agent sends; the store keeps
  // parseUsage's camelCase so an entry and a reading compare with no
  // translation. A route that rejected the documented spelling would answer a
  // 400. Asserted on the STORED entry, not just the status,
  // because accepting the request and filing it under a null window would pass
  // a status check and still never fire.
  await ok('POST /api/after-reset accepts the documented five_hour/seven_day spelling and normalises it', async () => {
    const a = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'five_hour', kind: 'prompt', target: 's1', payload: { text: 'go' } })
    assert.equal(a.status, 200)
    assert.equal(a.entry.window, 'fiveHour')
    const b = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'seven_day', kind: 'prompt', target: 's1', payload: { text: 'go' } })
    assert.equal(b.status, 200)
    assert.equal(b.entry.window, 'sevenDay')
    // and the camelCase spelling still works, unchanged
    const c = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fiveHour', kind: 'prompt', target: 's1', payload: { text: 'go' } })
    assert.equal(c.entry.window, 'fiveHour')
    // anything else is still a 400 that names both spellings
    const d = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fortnight', kind: 'prompt', target: 's1' })
    assert.equal(d.status, 400)
    assert.match(d.error, /five_hour/)
  })

  await ok("POST /api/after-reset refuses kind 'resume' with 400, naming the kind", async () => {
    const r = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'fiveHour', kind: 'resume', target: 's1' })
    assert.equal(r.status, 400)
    assert.match(r.error, /resume/)
  })

  await ok('POST /api/after-reset/delete with the right token cancels a pending entry', async () => {
    const created = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'sevenDay', kind: 'implement', payload: { ids: ['r1'] } })
    const del = await post('/api/after-reset/delete', { token: RELAY_TOKEN, id: created.entry.id })
    assert.equal(del.status, 200)
    const listed = await (await fetch(base + '/api/after-reset')).json()
    assert.equal(listed.queue.find((e) => e.id === created.entry.id).state, 'cancelled')
  })

  // The pane shows one REMOVE button per row, cancel() is a deliberate no-op
  // on a settled entry, and nothing else prunes the queue -- so REMOVE on a
  // fired or failed row must actually take it off the list rather than answer
  // 200 and leave it there. Asserted on what is LISTED afterwards, not on the
  // status code, which is 200 either way.
  await ok('POST /api/after-reset/delete clears a SETTLED entry off the list, not just a pending one', async () => {
    const created = await post('/api/after-reset', { token: RELAY_TOKEN, window: 'five_hour', kind: 'prompt', target: 'nobody', payload: { text: 'x' } })
    const id = created.entry.id
    // drive it to a settled state the same way the scheduler would
    const before = await (await fetch(base + '/api/after-reset')).json()
    assert.equal(before.queue.find((e) => e.id === id).state, 'pending')
    await post('/api/after-reset/delete', { token: RELAY_TOKEN, id })   // pending: called off, stays
    const mid = await (await fetch(base + '/api/after-reset')).json()
    assert.equal(mid.queue.find((e) => e.id === id).state, 'cancelled', 'a pending entry should be cancelled, not deleted')
    const second = await post('/api/after-reset/delete', { token: RELAY_TOKEN, id }) // settled: cleared away
    assert.equal(second.status, 200)
    const after = await (await fetch(base + '/api/after-reset')).json()
    assert.equal(after.queue.find((e) => e.id === id), undefined, 'a settled entry should leave the list')
    // and an id that never existed is still a 404, not a silent 200
    const ghost = await post('/api/after-reset/delete', { token: RELAY_TOKEN, id: 'no-such-entry' })
    assert.equal(ghost.status, 404)
  })

  await ok('GET /api/usage is unauthenticated and shaped {usage, history, queue}', async () => {
    const u = await (await fetch(base + '/api/usage')).json()
    assert.ok('usage' in u && 'history' in u && 'queue' in u)
  })

  child.kill('SIGTERM')
  rmSync(relayDataDir, { recursive: true, force: true })
}

rmSync(dir, { recursive: true, force: true })
console.log(`\nusage harness: ${pass} checks passed`)
