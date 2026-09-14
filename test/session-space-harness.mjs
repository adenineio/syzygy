#!/usr/bin/env node
// Drives bridge/groups.mjs and bridge/tmux.mjs against temp directories, then
// the relay's group routes against a real relay subprocess and a fake tmux.
// Every store case gets its own mkdtempSync directory, and the relay keeps its
// data and its session registry in temp directories too.
//
// Run: node test/session-space-harness.mjs   (or `just test-session-space`)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const {
  createGroups, readGroups, sanitizeGroup, normalizePaths,
  GROUPS_MAX, KINDS, NAME_MAX, TEXT_MAX, PATHS_MAX, PATH_MAX, MEMBERS_MAX,
} = await import(join(ROOT, 'syzygy', 'bridge', 'groups.mjs'))
const {
  listArgv, listPanes, groupPlan, runGroup, LIST_FORMAT,
} = await import(join(ROOT, 'syzygy', 'bridge', 'tmux.mjs'))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }
const dir = () => mkdtempSync(join(tmpdir(), 'szg-groups-'))
const fresh = (now = () => 1_700_000_000_000) => {
  const file = join(dir(), 'groups.json')
  return { file, store: createGroups({ file, now }) }
}

console.log('session-space harness')

await ok('an absent file is seeded once', async () => {
  const { file, store } = fresh()
  assert.ok(existsSync(file), 'seeding writes the file at construction')
  const all = store.all()
  assert.equal(all.length, 4)
  assert.deepEqual(all.map((g) => g.slot), [1, 2, 3, 4])
  assert.deepEqual(all.map((g) => g.kind).sort(), [...KINDS].sort())
  assert.equal(all.find((g) => g.kind === 'prompt').text, '')
  assert.deepEqual(all.find((g) => g.kind === 'files').paths, [])
})

await ok('a present file is never re-seeded', async () => {
  const file = join(dir(), 'groups.json')
  writeFileSync(file, JSON.stringify({ groups: [] }))
  const store = createGroups({ file, now: () => 1_700_000_000_000 })
  assert.deepEqual(store.all(), [])
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).groups, [])
})

await ok('save mints an id and stamps both clocks', async () => {
  const { store } = fresh()
  const r = store.save({ kind: 'prompt', name: 'x', slot: 5 })
  assert.equal(r.ok, true)
  assert.match(r.group.id, /^g-[a-z0-9]+$/)
  assert.equal(r.group.createdAt, r.group.updatedAt)
  assert.equal(r.group.appliedAt, null)
})

await ok('save is a validated merge on an existing id', async () => {
  let t = 1_700_000_000_000
  const { store } = fresh(() => t)
  const created = store.save({ kind: 'prompt', name: 'original', slot: 5, color: '#e0973c' }).group
  t += 1000
  const r = store.save({ id: created.id, text: 'hi', appliedAt: 999_999_999_999 })
  assert.equal(r.ok, true)
  assert.equal(r.group.name, 'original', 'name is kept')
  assert.equal(r.group.kind, 'prompt', 'kind is kept')
  assert.equal(r.group.slot, 5, 'slot is kept')
  assert.equal(r.group.color, '#e0973c', 'color is kept')
  assert.equal(r.group.createdAt, created.createdAt, 'createdAt is kept')
  assert.equal(r.group.updatedAt, t, 'updatedAt moves')
  assert.equal(r.group.appliedAt, null, 'appliedAt in the patch is ignored')
  assert.equal(r.group.text, 'hi')
})

await ok('an unknown kind is refused, not defaulted', async () => {
  const { store } = fresh()
  const r = store.save({ kind: 'nope', slot: 6 })
  assert.equal(r.ok, false)
  assert.match(r.error, /nope/, 'the error names the field')
})

await ok('a taken slot is refused naming the occupant; slot 0 or 9 is refused; a merge may keep its own slot', async () => {
  const { store } = fresh()
  const a = store.save({ kind: 'prompt', name: 'Alpha', slot: 5 }).group
  const clash = store.save({ kind: 'prompt', name: 'Beta', slot: 5 })
  assert.equal(clash.ok, false)
  assert.match(clash.error, /Alpha/)
  assert.equal(store.save({ kind: 'prompt', name: 'zero', slot: 0 }).ok, false)
  assert.equal(store.save({ kind: 'prompt', name: 'nine', slot: 9 }).ok, false)
  const keep = store.save({ id: a.id, slot: 5, name: 'Alpha still' })
  assert.equal(keep.ok, true)
  assert.equal(keep.group.slot, 5)
})

await ok('caps refuse, never truncate', async () => {
  const { store } = fresh()
  for (let slot = 5; slot <= GROUPS_MAX; slot++) {
    assert.equal(store.save({ kind: 'prompt', name: 's' + slot, slot }).ok, true)
  }
  assert.equal(store.all().length, GROUPS_MAX, 'the store now holds the max')
  const ninth = store.save({ kind: 'prompt', name: 'one too many', slot: 1 })
  assert.equal(ninth.ok, false)
  assert.equal(ninth.error, 'too many groups')

  const { store: s2 } = fresh()
  assert.equal(s2.save({ kind: 'prompt', name: 'x'.repeat(NAME_MAX + 1), slot: 5 }).ok, false, 'name over the cap')
  assert.equal(s2.save({ kind: 'prompt', text: 'x'.repeat(TEXT_MAX + 1), slot: 5 }).ok, false, 'text over the cap')
  assert.equal(s2.save({
    kind: 'files', slot: 5, paths: Array.from({ length: PATHS_MAX + 1 }, (_, i) => '/p' + i),
  }).ok, false, 'a 21st path')
  assert.equal(s2.save({
    kind: 'together', slot: 5, members: Array.from({ length: MEMBERS_MAX + 1 }, (_, i) => ({ id: 's' + i, name: 'n' + i })),
  }).ok, false, 'a 33rd member')
  assert.equal(s2.save({ kind: 'prompt', slot: 5, color: 'not-a-color' }).ok, false, 'an invalid colour')
  assert.equal(s2.save({ kind: 'tmux-group', slot: 5, tmuxName: 'has space' }).ok, false, 'a tmuxName with a space')
  assert.equal(s2.save({ kind: 'prompt', name: 'x'.repeat(NAME_MAX), slot: 5 }).ok, true, 'exactly at the cap is allowed')
})

await ok('unknown fields are carried through, and non-object members are dropped', async () => {
  const g = sanitizeGroup({
    id: 'g-abc', kind: 'together', slot: 5, name: 'x', note: 'hand-added',
    members: [{ id: 'a', name: 'A' }, 'not an object', 42, { id: 'b', name: 'B' }],
  })
  assert.ok(g)
  assert.equal(g.note, 'hand-added', 'an unknown field survives -- the file stays hand-editable')
  assert.deepEqual(g.members, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
})

await ok('a failed serialize leaves the previous file byte-identical', async () => {
  const { file, store } = fresh()
  const before = readFileSync(file, 'utf8')
  const evil = { kind: 'prompt', slot: 6 }
  Object.defineProperty(evil, 'name', { enumerable: true, get() { throw new Error('boom-name') } })
  assert.throws(() => store.save(evil), /boom-name/)
  assert.equal(readFileSync(file, 'utf8'), before, 'the old file is still the old file')
  assert.equal(store.all().some((g) => g.slot === 6), false, 'the failed save left no trace in memory')
  assert.equal(store.save({ kind: 'prompt', name: 'after', slot: 6 }).ok, true, 'the store still accepts saves afterward')
})

await ok('a file that will not parse is reported, never overwritten', async () => {
  const file = join(dir(), 'groups.json')
  writeFileSync(file, 'not json')
  const read = readGroups(file)
  assert.deepEqual(read.groups, [])
  assert.equal(read.broken, true)
  const store = createGroups({ file, now: () => 1_700_000_000_000 })
  assert.equal(store.broken(), true)
  const r = store.save({ kind: 'prompt', name: 'x', slot: 1 })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes(file), 'the error names the file')
  assert.equal(readFileSync(file, 'utf8'), 'not json', 'the unreadable original is untouched')
})

await ok('normalizePaths expands ~, resolves, dedupes and refuses', async () => {
  const home = '/home/someone'
  const known = new Set(['/home/someone/a', '/home/someone/b'])
  const realpath = (p) => (p === '/home/someone/a' ? '/real/a' : p)
  const exists = (p) => known.has(p)

  const r = normalizePaths(['~/a', '~/b', '/home/someone/a'], { home, realpath, exists })
  assert.equal(r.ok, true)
  assert.deepEqual(r.paths, ['/real/a', '/home/someone/b'], 'the tilde and the literal form resolve to the same real path')

  const rel = normalizePaths(['relative/path'], { home, realpath, exists })
  assert.equal(rel.ok, false)
  assert.ok(rel.error.includes('relative/path'), 'a relative path is refused')

  const missing = normalizePaths(['/home/someone/nope'], { home, realpath, exists })
  assert.equal(missing.ok, false)
  assert.ok(missing.error.includes('/home/someone/nope'), 'the refusal names the path')

  const long = '/' + 'x'.repeat(PATH_MAX)
  const tooLong = normalizePaths([long], { home, realpath, exists: () => true })
  assert.equal(tooLong.ok, false)
  assert.match(tooLong.error, /longer than/)
})

await ok('markApplied sets appliedAt from the injected clock and changes nothing else', async () => {
  let t = 1_700_000_000_000
  const { store } = fresh(() => t)
  const g = store.save({ kind: 'prompt', name: 'x', slot: 5 }).group
  t += 5000
  const r = store.markApplied(g.id)
  assert.equal(r.ok, true)
  assert.equal(r.group.appliedAt, t)
  const { appliedAt: _before, ...rest1 } = g
  const { appliedAt: _after, ...rest2 } = r.group
  assert.deepEqual(rest1, rest2, 'nothing else changed')
})

// ---- tmux.mjs -----------------------------------------------------------

const LIST = [
  'main\t@4\t%12\tsyzygy\tclaude\t/Users/x/tmp/some-project',
  'main\t@4\t%13\tsyzygy\tzsh\t/Users/x/tmp/some-project',
  'work\t@9\t%31\tmy notes\tnvim\t/Users/x/note dir',
  '',
  'garbage line with no tabs',
].join('\n')

await ok('listPanes parses real tmux output, dropping the blank and garbage lines', async () => {
  const panes = listPanes(LIST)
  assert.equal(panes.length, 3)
  assert.deepEqual(panes.map((p) => p.pane), ['%12', '%13', '%31'])
  assert.equal(panes[0].target, 'main:@4.%12')
  const notes = panes.find((p) => p.pane === '%31')
  assert.equal(notes.windowName, 'my notes')
  assert.equal(notes.path, '/Users/x/note dir')
})

await ok('listArgv is exactly the list-panes invocation', async () => {
  assert.deepEqual(listArgv(), ['list-panes', '-a', '-F', LIST_FORMAT])
})

await ok('groupPlan with a new destination creates a window from the first member and joins every member', async () => {
  const known = listPanes(LIST)
  const plan = groupPlan({ want: ['%12', '%31'], known, name: 'szg-group' })
  assert.equal(plan.window, null)
  assert.equal(plan.steps.length, 4)
  assert.equal(plan.steps[0].kind, 'new-window')
  assert.deepEqual(plan.steps[0].argv, [
    'new-window', '-d', '-t', 'main:', '-n', 'szg-group',
    '-c', '/Users/x/tmp/some-project', '-P', '-F', '#{session_name}:#{window_id}.#{pane_id}',
  ])
  assert.equal(plan.steps[1].kind, 'join-pane')
  assert.deepEqual(plan.steps[1].argv, ['join-pane', '-s', '%12', '-t', ''])
  assert.deepEqual(plan.steps[2].argv, ['join-pane', '-s', '%31', '-t', ''])
  assert.deepEqual(plan.steps[3].argv, ['select-layout', '-t', '', 'tiled'])
  assert.deepEqual(plan.skipped, [])
})

await ok('groupPlan with an existing destination skips panes already in that window', async () => {
  const known = listPanes(LIST)
  const plan = groupPlan({ want: ['%12', '%13', '%31'], known, name: 'syzygy' })
  assert.equal(plan.window, 'main:@4')
  assert.equal(plan.steps.some((s) => s.kind === 'new-window'), false)
  assert.deepEqual(plan.skipped, [
    { ref: '%12', why: 'already in that window' },
    { ref: '%13', why: 'already in that window' },
  ])
  const join = plan.steps.find((s) => s.kind === 'join-pane')
  assert.deepEqual(join.argv, ['join-pane', '-s', '%31', '-t', 'main:@4'])

  // a window of that name in a DIFFERENT tmux session is not a match
  const crossSession = groupPlan({ want: ['%31'], known, name: 'syzygy' })
  assert.equal(crossSession.window, null)
  assert.equal(crossSession.steps[0].kind, 'new-window')
  assert.equal(crossSession.steps[0].argv[3], 'work:')
})

await ok('groupPlan refuses invalid ids as named skips and never throws', async () => {
  const known = listPanes(LIST)
  const plan = groupPlan({ want: ['%99', 'nonsense', '%12'], known, name: 'other-group' })
  assert.deepEqual(plan.skipped, [
    { ref: '%99', why: 'no such pane' },
    { ref: 'nonsense', why: 'not a pane id' },
  ])
  const joins = plan.steps.filter((s) => s.kind === 'join-pane')
  assert.equal(joins.length, 1)
  assert.equal(joins[0].argv[2], '%12')
})

await ok('groupPlan with nothing joinable emits no steps at all', async () => {
  const known = listPanes(LIST)
  const plan = groupPlan({ want: ['%12', '%13'], known, name: 'syzygy' })
  assert.equal(plan.window, 'main:@4')
  assert.deepEqual(plan.steps, [])
  assert.deepEqual(plan.skipped, [
    { ref: '%12', why: 'already in that window' },
    { ref: '%13', why: 'already in that window' },
  ])

  const none = groupPlan({ want: ['nonsense', '%404'], known, name: 'anything' })
  assert.deepEqual(none, {
    window: null,
    steps: [],
    skipped: [
      { ref: 'nonsense', why: 'not a pane id' },
      { ref: '%404', why: 'no such pane' },
    ],
  })
})

await ok('runGroup fills the empty -t slot from the window new-window prints, and skips new-window for an already-known destination', async () => {
  const known = listPanes(LIST)
  const plan = groupPlan({ want: ['%12', '%31'], known, name: 'szg-group' })
  const calls = []
  const run = async (bin, argv) => {
    calls.push(argv)
    if (argv[0] === 'new-window') return { code: 0, stdout: 'main:@7.%40\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const result = await runGroup({ plan, run })
  assert.equal(result.ok, true)
  assert.equal(result.window, 'main:@7')
  assert.deepEqual(result.joined, ['%12', '%31'])
  assert.deepEqual(result.skipped, [])
  const joins = calls.filter((a) => a[0] === 'join-pane')
  assert.deepEqual(joins, [
    ['join-pane', '-s', '%12', '-t', 'main:@7'],
    ['join-pane', '-s', '%31', '-t', 'main:@7'],
  ])
  const layout = calls.find((a) => a[0] === 'select-layout')
  assert.deepEqual(layout, ['select-layout', '-t', 'main:@7', 'tiled'])

  const existingPlan = groupPlan({ want: ['%12', '%31'], known, name: 'syzygy' })
  assert.equal(existingPlan.window, 'main:@4')
  const calls2 = []
  const run2 = async (bin, argv) => { calls2.push(argv); return { code: 0, stdout: '', stderr: '' } }
  const result2 = await runGroup({ plan: existingPlan, run: run2 })
  assert.equal(result2.ok, true)
  assert.equal(result2.window, 'main:@4')
  assert.equal(calls2.some((a) => a[0] === 'new-window'), false)
  assert.deepEqual(result2.joined, ['%31'])
})

await ok('runGroup treats a failed join-pane as a skip, not a failure', async () => {
  const known = listPanes(LIST)
  const plan = groupPlan({ want: ['%12', '%31'], known, name: 'szg-group' })
  const run = async (bin, argv) => {
    if (argv[0] === 'new-window') return { code: 0, stdout: 'main:@7.%40\n', stderr: '' }
    if (argv[0] === 'join-pane' && argv[2] === '%31') return { code: 1, stdout: '', stderr: "can't find pane\n" }
    return { code: 0, stdout: '', stderr: '' }
  }
  const result = await runGroup({ plan, run })
  assert.equal(result.ok, true)
  assert.deepEqual(result.joined, ['%12'])
  assert.deepEqual(result.skipped, [{ ref: '%31', why: "can't find pane" }])
})

await ok('runGroup treats a failed new-window as fatal and never runs join-pane', async () => {
  const known = listPanes(LIST)
  const plan = groupPlan({ want: ['%12', '%31'], known, name: 'szg-group' })
  const calls = []
  const run = async (bin, argv) => {
    calls.push(argv)
    return { code: 1, stdout: '', stderr: 'no server running on socket\n' }
  }
  const result = await runGroup({ plan, run })
  assert.equal(result.ok, false)
  assert.match(result.error, /no server running on socket/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'new-window')
})

await ok('runGroup never rejects', async () => {
  const known = listPanes(LIST)
  const plan = groupPlan({ want: ['%12'], known, name: 'szg-group' })
  const run = async () => { throw new Error('boom') }
  const result = await runGroup({ plan, run })
  assert.equal(result.ok, false)
})

// ---- the relay's routes -------------------------------------------------
// The routes live in relay.mjs's HTTP handler, so they are driven against the
// real relay rather than a copy that could drift. Isolated on every axis:
// SZG_PORT=0 (OS-assigned), SZG_DATA_DIR and SZG_SESSIONS_DIR in temp dirs,
// SZG_CLAUDE_BIN a binary that fails every probe, and SZG_TMUX_BIN a small node
// script that records its argv and answers a canned listing. Nothing here
// reaches a real tmux server. Every SZG_* variable in the calling shell is
// dropped first, so a developer's own settings never leak into the relay.

const { spawn } = await import('node:child_process')
const TOKEN = 'space-harness-token'
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SZG_')))

const bootRelay = async (env) => {
  const child = spawn(process.execPath, [join(ROOT, 'syzygy', 'bridge', 'relay.mjs')], {
    cwd: ROOT,
    env: {
      ...cleanEnv, SZG_PORT: '0', SZG_TOKEN: TOKEN,
      SZG_CLAUDE_BIN: '/usr/bin/false', SZG_TMUX_BIN: '/usr/bin/false',
      SZG_SESSIONS_DIR: mkdtempSync(join(tmpdir(), 'szg-space-sessions-')),
      SZG_PANE_PASSWORD_DISABLED: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (c) => { stderr += c })
  const port = await new Promise((resolvePort, reject) => {
    let out = ''
    const onData = (c) => {
      out += c
      const m = out.match(/relay on http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { child.stdout.off('data', onData); resolvePort(Number(m[1])) }
    }
    child.stdout.on('data', onData)
    child.on('exit', (code) => reject(new Error(`relay exited early (${code}): ${stderr}`)))
    setTimeout(() => reject(new Error('relay did not report a port in time')), 10_000)
  })
  const base = `http://127.0.0.1:${port}`
  const post = async (path, body = {}) => {
    const r = await fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN, ...body }),
    })
    const j = await r.json().catch(() => ({}))
    return { status: r.status, ...j }
  }
  const get = async (path) => {
    const r = await fetch(base + path)
    const j = await r.json().catch(() => ({}))
    return { status: r.status, ...j }
  }
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const gone = new Promise((r) => child.on('exit', r))
    child.kill('SIGTERM')
    await gone
  }
  return { base, post, get, stop }
}

{
  const dataDir = mkdtempSync(join(tmpdir(), 'szg-space-data-'))
  const fakeDir = mkdtempSync(join(tmpdir(), 'szg-space-fake-'))
  const sessionsDir = mkdtempSync(join(tmpdir(), 'szg-space-sessions-'))
  const LOG = join(fakeDir, 'argv.jsonl')
  const LISTING = [
    'main\t@4\t%12\tagents\tclaude\t/work/alpha',
    'main\t@4\t%13\tagents\tzsh\t/work/alpha',
    'side\t@9\t%31\tnotes\tnvim\t/work/beta',
    '',
  ].join('\n')
  // The fake answers the listing the way real tmux does for a client it does
  // not believe is UTF-8 -- a relay started without a UTF-8 locale is one --
  // printing every tab in the format as `_`, unless the call leads with `-u`.
  const fakeTmux = join(fakeDir, 'tmux')
  writeFileSync(fakeTmux, [
    '#!' + process.execPath,
    "const fs = require('node:fs')",
    'const raw = process.argv.slice(2)',
    `fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(raw) + '\\n')`,
    "const utf8 = raw[0] === '-u'",
    'const argv = utf8 ? raw.slice(1) : raw',
    `if (argv[0] === 'list-panes') { const text = ${JSON.stringify(LISTING)}; process.stdout.write(utf8 ? text : text.replace(/\\t/g, '_')); process.exit(0) }`,
    "if (argv[0] === 'new-window') { const t = argv[argv.indexOf('-t') + 1] || ''; process.stdout.write(t.replace(/:$/, '') + ':@77.%900\\n'); process.exit(0) }",
    'process.exit(0)',
    '',
  ].join('\n'))
  chmodSync(fakeTmux, 0o755)
  const calls = () => (existsSync(LOG)
    ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [])
  const verb = (c) => (c[0] === '-u' ? c[1] : c[0])

  // A session registered with this pid runs in pane %12, as far as the relay
  // can tell -- recorded in a window the pane has since left, which is the
  // normal state right after a group has moved it.
  const PID = 99990
  writeFileSync(join(sessionsDir, `${PID}.json`), JSON.stringify({ tmux: 'main:@1.%12' }))

  const relay = await bootRelay({ SZG_DATA_DIR: dataDir, SZG_TMUX_BIN: fakeTmux, SZG_SESSIONS_DIR: sessionsDir })
  const { base, post, get } = relay
  const drain = async (id) =>
    (await (await fetch(`${base}/api/commands/${encodeURIComponent(id)}?token=${TOKEN}`)).json()).commands
  const bucket = async (kind) => (await get('/api/state')).groups.find((g) => g.kind === kind)

  try {
    await ok('the snapshot carries the four seeded buckets and a payload version past 13', async () => {
      const s = await get('/api/state')
      assert.ok(Array.isArray(s.groups), 'groups is on the snapshot')
      assert.equal(s.groups.length, 4)
      assert.deepEqual(s.groups.map((g) => g.slot), [1, 2, 3, 4])
      assert.ok(s.payloadVersion > 13, `payloadVersion ${s.payloadVersion} is not past 13`)
    })

    await ok('GET /api/tmux parses the listing, marks no session, and holds it for two seconds', async () => {
      const a = await get('/api/tmux')
      assert.equal(a.status, 200)
      assert.equal(a.ok, true)
      assert.deepEqual(a.panes.map((p) => p.pane), ['%12', '%13', '%31'])
      assert.deepEqual(a.panes[0], {
        target: 'main:@4.%12', session: 'main', window: '@4', pane: '%12',
        windowName: 'agents', command: 'claude', path: '/work/alpha', sessionId: null,
      })
      assert.ok(a.panes.every((p) => p.sessionId === null), 'no session is registered yet')
      const b = await get('/api/tmux')
      assert.equal(b.at, a.at, 'the second read is the held one')
      assert.equal(calls().filter((c) => verb(c) === 'list-panes').length, 1, 'tmux ran once for two reads')
    })

    let goId = ''
    await ok('POST /api/groups/save creates a bucket and the snapshot then carries five', async () => {
      const r = await post('/api/groups/save', { group: { kind: 'prompt', name: 'go', slot: 5, text: 'status?' } })
      assert.equal(r.status, 200)
      assert.equal(r.ok, true)
      assert.equal(r.group.slot, 5)
      goId = r.group.id
      assert.equal((await get('/api/state')).groups.length, 5)
    })

    await ok('POST /api/groups/save refuses an unknown kind with 400 naming the field', async () => {
      const r = await post('/api/groups/save', { group: { kind: 'nope', name: 'bad', slot: 6 } })
      assert.equal(r.status, 400)
      assert.match(r.error, /kind/)
      assert.equal((await get('/api/state')).groups.length, 5, 'nothing was written')
    })

    await ok('POST /api/groups/delete removes a bucket, and a second delete is a 404', async () => {
      const r = await post('/api/groups/delete', { id: goId })
      assert.equal(r.status, 200)
      assert.equal(r.ok, true)
      assert.equal((await get('/api/state')).groups.some((g) => g.id === goId), false)
      assert.equal((await post('/api/groups/delete', { id: goId })).status, 404)
    })

    await ok('POST /api/groups/apply on a prompt bucket queues its text for each named session', async () => {
      await post('/api/register', { session: { id: 'sess-a', name: 'alpha', pid: PID } })
      await post('/api/register', { session: { id: 'sess-b', name: 'beta' } })
      await drain('sess-a'); await drain('sess-b')
      const prompt = await bucket('prompt')
      const empty = await post('/api/groups/apply', { id: prompt.id, targetIds: ['sess-a'] })
      assert.equal(empty.status, 400, 'a prompt bucket with no text is refused')
      assert.match(empty.error, /text/)
      assert.equal((await post('/api/groups/save', { group: { id: prompt.id, text: 'status?' } })).ok, true)
      const r = await post('/api/groups/apply', { id: prompt.id, targetIds: ['sess-a'], kind: 'tmux-group' })
      assert.equal(r.status, 200)
      assert.equal(r.ok, true)
      assert.equal(r.kind, 'prompt', 'the stored kind decides, never the body')
      assert.deepEqual(r.applied, [{ id: 'sess-a', name: 'alpha' }])
      const cmds = await drain('sess-a')
      assert.equal(cmds.length, 1)
      assert.equal(cmds[0].verb, 'prompt')
      assert.equal(cmds[0].payload.text, 'status?')
      assert.deepEqual(await drain('sess-b'), [], 'a session not named gets nothing')
      assert.ok((await bucket('prompt')).appliedAt > 0, 'the apply is recorded')
    })

    await ok('an unknown target refuses the whole apply with 404 and queues nothing', async () => {
      const prompt = await bucket('prompt')
      const r = await post('/api/groups/apply', { id: prompt.id, targetIds: ['sess-a', 'nobody'] })
      assert.equal(r.status, 404)
      assert.match(r.error, /nobody/)
      assert.deepEqual(await drain('sess-a'), [])
    })

    await ok('a files bucket refuses a missing path by name, and otherwise queues one prompt naming every path', async () => {
      const files = await bucket('files')
      const none = await post('/api/groups/apply', { id: files.id, targetIds: ['sess-a'] })
      assert.equal(none.status, 400, 'a files bucket with no paths is refused')
      assert.match(none.error, /path/)
      const real = mkdtempSync(join(tmpdir(), 'szg-space-paths-'))
      const one = join(real, 'one.txt'), two = join(real, 'two.txt'), missing = join(real, 'absent.txt')
      writeFileSync(one, 'one')
      writeFileSync(two, 'two')
      assert.equal((await post('/api/groups/save', { group: { id: files.id, paths: [one, missing] } })).ok, true)
      const bad = await post('/api/groups/apply', { id: files.id, targetIds: ['sess-a'] })
      assert.equal(bad.status, 400)
      assert.ok(bad.error.includes(missing), `the refusal names the missing path: ${bad.error}`)
      assert.deepEqual(await drain('sess-a'), [], 'nothing was queued')
      assert.equal((await post('/api/groups/save', { group: { id: files.id, paths: [one, two] } })).ok, true)
      const good = await post('/api/groups/apply', { id: files.id, targetIds: ['sess-a'] })
      assert.equal(good.status, 200)
      assert.equal(good.kind, 'files')
      const cmds = await drain('sess-a')
      assert.equal(cmds.length, 1)
      assert.equal(cmds[0].verb, 'prompt')
      assert.ok(cmds[0].payload.text.includes(realpathSync(one)), 'the first path is named')
      assert.ok(cmds[0].payload.text.includes(realpathSync(two)), 'the second path is named')
      rmSync(real, { recursive: true, force: true })
    })

    await ok('a tmux-group bucket takes a fresh listing, opens a window beside its first member and joins the pane', async () => {
      const tg = await bucket('tmux-group')
      const before = calls().length
      const r = await post('/api/groups/apply', { id: tg.id, panes: ['%12'] })
      assert.equal(r.status, 200)
      assert.equal(r.ok, true)
      assert.equal(r.kind, 'tmux-group')
      assert.equal(r.window, 'main:@77')
      assert.deepEqual(r.applied.map((a) => a.id), ['%12'])
      const ran = calls().slice(before)
      assert.deepEqual(ran.map(verb), ['list-panes', 'new-window', 'join-pane', 'select-layout'])
      assert.deepEqual(ran[1].slice(0, 8), ['new-window', '-d', '-t', 'main:', '-n', 'szg-group', '-c', '/work/alpha'])
      assert.deepEqual(ran[2], ['join-pane', '-s', '%12', '-t', 'main:@77'])
      assert.deepEqual(ran[3], ['select-layout', '-t', 'main:@77', 'tiled'])
    })

    await ok('a pane tmux did not list, or no pane id at all, is skipped and never reaches an argv', async () => {
      const tg = await bucket('tmux-group')
      const before = calls().length
      const empty = await post('/api/groups/apply', { id: tg.id, panes: [] })
      assert.equal(empty.status, 400, 'an empty pane list is refused')
      const r = await post('/api/groups/apply', { id: tg.id, panes: ['%777'] })
      assert.equal(r.status, 200)
      assert.equal(r.ok, true)
      assert.deepEqual(r.skipped, [{ ref: '%777', why: 'no such pane' }])
      const hostile = '; rm -rf /'
      const r2 = await post('/api/groups/apply', { id: tg.id, panes: [hostile] })
      assert.equal(r2.ok, true)
      assert.deepEqual(r2.skipped, [{ ref: hostile, why: 'not a pane id' }])
      const ran = calls().slice(before)
      assert.deepEqual(ran.map(verb), ['list-panes', 'list-panes'], 'one listing each, and nothing else ran')
      assert.equal(ran.flat().some((a) => a.includes('%777') || a.includes('rm -rf')), false)
    })

    await ok('a together bucket records its members, broadcasts, and runs no subprocess', async () => {
      const tg = await bucket('together')
      const before = calls().length
      const frames = []
      const ac = new AbortController()
      const stream = await fetch(`${base}/api/stream?token=${TOKEN}`, { signal: ac.signal })
      const reader = stream.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      const pump = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let cut
            while ((cut = buf.indexOf('\n\n')) !== -1) {
              const raw = buf.slice(0, cut); buf = buf.slice(cut + 2)
              const ev = /^event: (.+)$/m.exec(raw), data = /^data: (.*)$/m.exec(raw)
              if (ev && data) frames.push({ type: ev[1], data: JSON.parse(data[1]) })
            }
          }
        } catch { /* aborted */ }
      })()
      const r = await post('/api/groups/apply', { id: tg.id, targetIds: ['sess-a', 'sess-b'] })
      assert.equal(r.status, 200)
      assert.equal(r.kind, 'together')
      const pairs = [{ id: 'sess-a', name: 'alpha' }, { id: 'sess-b', name: 'beta' }]
      assert.deepEqual(r.applied, pairs)
      const seen = (f) => f.type === 'groups' && f.data.groups.some((g) => g.id === tg.id && g.members.length === 2 && g.appliedAt > 0)
      const deadline = Date.now() + 2000
      while (Date.now() < deadline && !frames.some(seen)) await new Promise((res) => setTimeout(res, 50))
      ac.abort(); await pump
      assert.ok(frames.some(seen), 'the change was broadcast as a groups frame')
      const stored = await bucket('together')
      assert.deepEqual(stored.members, pairs)
      assert.ok(stored.appliedAt > 0)
      assert.equal(calls().length, before, 'no subprocess ran')
    })

    await ok('a GET to a write route and a POST to the listing are both refused', async () => {
      const neighbour = await fetch(base + '/api/pasteboard/create')
      for (const p of ['/api/groups/save', '/api/groups/delete', '/api/groups/apply']) {
        const r = await fetch(base + p)
        assert.equal(r.status, neighbour.status, `GET ${p} answers what a GET to a neighbouring write route answers`)
        assert.notEqual(r.status, 200)
      }
      const before = calls().length
      const r = await post('/api/tmux')
      assert.equal(r.status, 404)
      assert.equal(r.error, 'no such endpoint')
      assert.equal(calls().length, before, 'a POST never runs tmux')
    })

    await ok('GET /api/tmux marks the pane a registered session runs in, by its pane id', async () => {
      await new Promise((res) => setTimeout(res, 2100))
      const r = await get('/api/tmux')
      const byPane = Object.fromEntries(r.panes.map((p) => [p.pane, p.sessionId]))
      assert.equal(byPane['%12'], 'sess-a', 'matched although the session recorded the window it started in')
      assert.equal(byPane['%13'], null)
      assert.equal(byPane['%31'], null, 'a session with no tmux field matches nothing')
    })
  } finally {
    await relay.stop()
  }
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(fakeDir, { recursive: true, force: true })
  rmSync(sessionsDir, { recursive: true, force: true })
}

// A groups file that will not parse: its own relay, since the store reads the
// file once, at boot.
{
  const dataDir = mkdtempSync(join(tmpdir(), 'szg-space-broken-'))
  const file = join(dataDir, 'groups.json')
  writeFileSync(file, 'not json')
  const relay = await bootRelay({ SZG_DATA_DIR: dataDir })
  try {
    await ok('a groups file that will not parse blocks every write with 409 naming the file', async () => {
      const writes = [
        ['/api/groups/save', { group: { kind: 'prompt', name: 'x', slot: 1 } }],
        ['/api/groups/delete', { id: 'g-x' }],
        ['/api/groups/apply', { id: 'g-x', targetIds: ['s'] }],
      ]
      for (const [p, body] of writes) {
        const r = await relay.post(p, body)
        assert.equal(r.status, 409, p)
        assert.ok(String(r.error).includes(file), `${p} names the file: ${r.error}`)
      }
      assert.equal(readFileSync(file, 'utf8'), 'not json', 'the unreadable original is untouched')
      assert.deepEqual((await relay.get('/api/state')).groups, [])
    })
  } finally {
    await relay.stop()
  }
  rmSync(dataDir, { recursive: true, force: true })
}

console.log(`\nsession-space harness: ${pass} checks passed`)
assert.equal(pass, 36, `expected 36 checks, got ${pass} -- a missed await would let a failing check report as passing`)
