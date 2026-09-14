#!/usr/bin/env node
// Drives bridge/pasteboard.mjs against a temp directory, then its routes
// against a real relay subprocess. Hermetic: no network in this half,
// no ~/.claude touched anywhere -- SZG_DATA_DIR points the relay at a temp
// directory, exactly as test/claims-harness.mjs does.
//
// Run: node test/pasteboard-harness.mjs   (or `just test-pasteboard`)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const {
  createPasteboard, readPasteboard, sanitizeEntry,
  PASTEBOARD_MAX_PER_SCOPE, PASTEBOARD_MAX_TEXT, PASTEBOARD_MAX_TOTAL,
} = await import(join(ROOT, 'syzygy', 'bridge', 'pasteboard.mjs'))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }
const dir = () => mkdtempSync(join(tmpdir(), 'szg-paste-'))
const fresh = () => {
  const file = join(dir(), 'pasteboard.json')
  return { file, store: createPasteboard({ file, now: () => 1_700_000_000_000 }) }
}
const entryFor = (over = {}) => ({
  sessionId: 's1', sessionName: 'alpha', text: 'hello', scope: 'session', ...over,
})

console.log('pasteboard harness')

await ok('an added entry carries every field the panes read', async () => {
  const { store } = fresh()
  const r = store.add(entryFor())
  assert.equal(r.ok, true)
  assert.match(r.entry.id, /^[a-z0-9]+$/)
  assert.equal(r.entry.sessionId, 's1')
  assert.equal(r.entry.sessionName, 'alpha')
  assert.equal(r.entry.text, 'hello')
  assert.equal('title' in r.entry, false, 'an untitled entry stores NO title -- the caption is derived at render')
  assert.equal(r.entry.createdAt, 1_700_000_000_000)
  assert.equal(typeof r.entry.order, 'number')
  assert.equal(r.index, 0)
  assert.equal(r.count, 1)
})

await ok('an explicit title is kept, trimmed and capped', async () => {
  const { store } = fresh()
  const r = store.add(entryFor({ title: '  ' + 'x'.repeat(80) + '  ' }))
  assert.equal(r.entry.title.length, 60, 'the title cap is 60')
  assert.equal(store.add(entryFor({ title: '   ' })).entry.title, undefined, 'a blank title is no title')
})

await ok('a new stash goes to the FRONT of its scope', async () => {
  const { store } = fresh()
  store.add(entryFor({ text: 'first' }))
  store.add(entryFor({ text: 'second' }))
  const mine = store.all().filter((e) => e.sessionId === 's1')
  assert.deepEqual(mine.map((e) => e.text), ['second', 'first'],
    'the thing you just put down is the thing you are most likely to pick back up')
})

await ok('the global scope is a separate board with its own order', async () => {
  const { store } = fresh()
  store.add(entryFor({ text: 'mine' }))
  const g = store.add(entryFor({ scope: 'global', text: 'ours' }))
  assert.equal(g.entry.sessionId, null, 'a global entry has NO sessionId')
  assert.equal(g.entry.sessionName, 'alpha', '...but still records who stashed it')
  assert.equal(g.index, 0, 'front of the GLOBAL board, not of the whole file')
  assert.equal(g.count, 1, 'and the count is the global board, not the file')
})

await ok('move is scoped and never crosses boards', async () => {
  const { store } = fresh()
  const a = store.add(entryFor({ text: 'a' })).entry
  const b = store.add(entryFor({ text: 'b' })).entry     // b is now first
  store.add(entryFor({ scope: 'global', text: 'g' }))
  assert.equal(store.move(b.id, 'down'), true)
  assert.deepEqual(store.all().filter((e) => e.sessionId === 's1').map((e) => e.text), ['a', 'b'])
  assert.equal(store.move(a.id, 'up'), true)
  assert.deepEqual(store.all().filter((e) => e.sessionId === 's1').map((e) => e.text), ['a', 'b'],
    'a is already at the top: moving up again is a no-op, not a swap with the global board')
  assert.equal(store.all().filter((e) => e.sessionId === null).length, 1, 'the global board is untouched')
  assert.equal(store.move('nope', 'up'), false, 'an unknown id refuses')
})

await ok('reorder sets an explicit order and leaves other scopes alone', async () => {
  const { store } = fresh()
  const a = store.add(entryFor({ text: 'a' })).entry
  const b = store.add(entryFor({ text: 'b' })).entry
  const g = store.add(entryFor({ scope: 'global', text: 'g' })).entry
  assert.equal(store.reorder([a.id, b.id]), true)
  assert.deepEqual(store.all().filter((e) => e.sessionId === 's1').map((e) => e.text), ['a', 'b'])
  assert.equal(store.get(g.id).text, 'g', 'an id left out of reorder keeps its entry')
  assert.equal(store.reorder([]), false, 'an empty list is not an order')
})

await ok('the three caps REFUSE and never evict', async () => {
  const { store } = fresh()
  for (let i = 0; i < PASTEBOARD_MAX_PER_SCOPE; i++) {
    assert.equal(store.add(entryFor({ text: 'e' + i })).ok, true)
  }
  const full = store.add(entryFor({ text: 'one too many' }))
  assert.equal(full.ok, false)
  assert.equal(full.error, 'board full')
  assert.equal(store.all().length, PASTEBOARD_MAX_PER_SCOPE, 'nothing was evicted to make room')
  assert.ok(store.all().some((e) => e.text === 'e0'), 'the OLDEST entry is still there')
  // the global board is a different scope and is not full
  assert.equal(store.add(entryFor({ scope: 'global', text: 'g' })).ok, true)

  const { store: s2 } = fresh()
  const long = s2.add(entryFor({ text: 'x'.repeat(PASTEBOARD_MAX_TEXT + 1) }))
  assert.equal(long.ok, false)
  assert.equal(long.error, 'too long')
  assert.equal(s2.add(entryFor({ text: 'x'.repeat(PASTEBOARD_MAX_TEXT) })).ok, true, 'exactly at the cap is allowed')

  const { store: s3 } = fresh()
  const chunk = 'y'.repeat(PASTEBOARD_MAX_TEXT)
  let refused = null
  for (let i = 0; i < 200 && !refused; i++) {
    const scope = i % 2 === 0 ? 'session' : 'global'
    const r = s3.add(entryFor({ scope, text: chunk }))
    if (!r.ok) refused = r
  }
  assert.equal(refused?.error, 'pasteboard full', 'the total-bytes bound binds across BOTH scopes')
})

await ok('an empty text is refused', async () => {
  const { store } = fresh()
  const r = store.add(entryFor({ text: '   ' }))
  assert.equal(r.ok, false)
  assert.equal(r.error, 'empty')
})

await ok('the write is atomic and write-through', async () => {
  const { file, store } = fresh()
  store.add(entryFor())
  assert.ok(existsSync(file), 'add flushes immediately -- a relay killed after a stash must not lose it')
  const leftovers = readdirSync(dirname(file)).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], 'no temp file survives a successful write')
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(doc.version, 1)
  assert.equal(doc.pasteboard.length, 1)
})

await ok('a failed serialize leaves the previous file byte-identical', async () => {
  const { file, store } = fresh()
  store.add(entryFor({ text: 'keep me' }))
  const before = readFileSync(file, 'utf8')
  // A cycle cannot be stringified. It reaches the store through `add`'s
  // pass-through of an unknown field, which is deliberately preserved.
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(() => store.add(entryFor({ text: 'boom', extra: cyclic })), /circular|cyclic|Converting/i)
  assert.equal(readFileSync(file, 'utf8'), before, 'the old file is still the old file')
  // A throw during flush must not have touched `items` either -- the
  // rejected entry is not in memory, and the store is still usable.
  assert.equal(store.all().some((e) => e.text === 'boom'), false, 'the failed add left no trace in memory')
  assert.equal(store.add(entryFor({ text: 'after' })).ok, true, 'the store still accepts stashes afterward')
})

await ok('reading sanitises rather than throwing', async () => {
  const file = join(dir(), 'pasteboard.json')
  writeFileSync(file, JSON.stringify({
    version: 1,
    pasteboard: [
      null,
      'a bare string',
      { id: 'a', sessionId: 's1', sessionName: 'alpha', text: 'good', createdAt: 1, order: 0 },
      { id: 'b', sessionId: 's1', sessionName: 'alpha', text: 42, createdAt: 1, order: 1 },
      { id: 'c', sessionId: null, sessionName: '', text: 'no order', createdAt: 1, mine: 'kept' },
    ],
  }))
  const items = readPasteboard(file)
  assert.deepEqual(items.map((e) => e.id), ['a', 'c'], 'a non-object and a non-string text are dropped')
  assert.equal(typeof items[1].order, 'number', 'a missing order is filled from position')
  assert.equal(items[1].mine, 'kept', 'an unknown field is carried through -- the file is hand-editable')
  assert.deepEqual(sanitizeEntry({ text: 'x' }), null, 'an entry with no id or timestamp is not an entry')
})

await ok('a corrupt file is moved aside, never overwritten', async () => {
  const file = join(dir(), 'pasteboard.json')
  writeFileSync(file, '{ this is not json')
  const store = createPasteboard({ file, now: () => 777 })
  assert.deepEqual(store.all(), [], 'it degrades to an empty board')
  store.add(entryFor())
  const aside = readdirSync(dirname(file)).filter((f) => f.includes('.corrupt-'))
  assert.equal(aside.length, 1, 'the unparseable original is kept')
  assert.equal(readFileSync(join(dirname(file), aside[0]), 'utf8'), '{ this is not json')
})

await ok('a missing file is the normal first run', async () => {
  const file = join(dir(), 'never-written.json')
  assert.deepEqual(readPasteboard(file), [])
  assert.deepEqual(createPasteboard({ file }).all(), [])
})

// ---- live relay -------------------------------------------------------------
// A mocked relay cannot prove a route ladder. The gate, the enqueue and the
// broadcast are all things only a real process does.
{
  const { spawn } = await import('node:child_process')
  const relay = join(ROOT, 'syzygy', 'bridge', 'relay.mjs')
  const PORT = 4500 + Math.floor(Math.random() * 100)
  const TOKEN = 'test-token-' + Math.random().toString(36).slice(2)
  const DATA = mkdtempSync(join(tmpdir(), 'szg-paste-relay-'))

  // SZG_DATA_DIR points the child at an isolated directory instead of the
  // real, shared ~/.claude/syzygy. Without it this test loads and flushes the
  // user's own pasteboard.json.
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

    await post('/api/register', {
      session: {
        id: 'sess-1', name: 'alpha', agentName: 'main', cwd: ROOT, root: ROOT,
        repo: 'demo', branch: 'develop', model: 'Opus', pid: '1', startedAt: Date.now(),
      },
    })

    await ok('an unauthenticated POST is refused', async () => {
      const r = await post('/api/pasteboard/create', { text: 'x' }, {})
      assert.equal(r.status, 401)
    })

    let first
    await ok('POST /api/pasteboard/create stores and answers the index', async () => {
      const r = await post('/api/pasteboard/create', {
        sessionId: 'sess-1', sessionName: 'alpha', text: 'the first stash', scope: 'session',
      })
      assert.equal(r.status, 200)
      assert.equal(r.body.ok, true)
      assert.equal(r.body.index, 0)
      assert.equal(r.body.count, 1)
      first = r.body.entry
    })

    await ok('create refuses an over-long text by name', async () => {
      const r = await post('/api/pasteboard/create', {
        sessionId: 'sess-1', sessionName: 'alpha', text: 'x'.repeat(PASTEBOARD_MAX_TEXT + 1), scope: 'session',
      })
      assert.equal(r.status, 400)
      assert.equal(r.body.error, 'too long', 'the reason reaches a human as the reason their prompt was dropped')
    })

    await ok('the entry rides the snapshot and the read route', async () => {
      const state = await get('/api/state')
      assert.ok(state.body.payloadVersion >= 2, 'a pasteboard-carrying snapshot bumps the version')
      assert.equal(state.body.pasteboard.length, 1)
      assert.equal(state.body.pasteboard[0].text, 'the first stash')
      const read = await get('/api/pasteboard')
      assert.equal(read.body.pasteboard.length, 1)
    })

    await ok('POST /api/pasteboard/fill enqueues for a live session', async () => {
      const r = await post('/api/pasteboard/fill', { id: first.id, targetId: 'sess-1' })
      assert.equal(r.status, 200)
      const drained = await get(`/api/commands/${encodeURIComponent('sess-1')}`)
      const cmds = drained.body.commands
      assert.equal(cmds.length, 1)
      assert.equal(cmds[0].verb, 'fill')
      assert.equal(cmds[0].payload.text, 'the first stash',
        'the relay reads the text out of its OWN store -- the caller sends an id')
    })

    await ok('fill refuses an unknown session and an unknown entry', async () => {
      assert.equal((await post('/api/pasteboard/fill', { id: first.id, targetId: 'nope' })).status, 404)
      assert.equal((await post('/api/pasteboard/fill', { id: 'nope', targetId: 'sess-1' })).status, 404)
    })

    await ok('reorder takes ids or a direction', async () => {
      const second = (await post('/api/pasteboard/create', {
        sessionId: 'sess-1', sessionName: 'alpha', text: 'the second stash', scope: 'session',
      })).body.entry
      const byIds = await post('/api/pasteboard/reorder', { ids: [first.id, second.id] })
      assert.equal(byIds.status, 200)
      assert.deepEqual((await get('/api/pasteboard')).body.pasteboard.map((e) => e.text),
        ['the first stash', 'the second stash'])
      assert.equal((await post('/api/pasteboard/reorder', { id: second.id, dir: 'up' })).status, 200)
      assert.deepEqual((await get('/api/pasteboard')).body.pasteboard.map((e) => e.text),
        ['the second stash', 'the first stash'])
      assert.equal((await post('/api/pasteboard/reorder', {})).status, 400)
    })

    await ok('delete removes it and 404s the second time', async () => {
      assert.equal((await post('/api/pasteboard/delete', { id: first.id })).status, 200)
      assert.equal((await post('/api/pasteboard/delete', { id: first.id })).status, 404)
    })

    await ok('the store is written through to disk', async () => {
      const before = (await get('/api/pasteboard')).body.pasteboard
      assert.ok(before.length >= 1)
      assert.ok(existsSync(join(DATA, 'pasteboard.json')), 'it is on disk, not in memory')
    })
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 2000) })
  }
}

console.log(`\npasteboard harness: ${pass} checks passed`)
assert.equal(pass, 22, `expected 22 checks, got ${pass} -- a missed await would let a failing check report as passing`)
