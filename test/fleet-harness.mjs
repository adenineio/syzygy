#!/usr/bin/env node
// Drives bridge/fleet.mjs. The pure half here; the relay half is at the
// bottom, against a real relay subprocess and a fake `claude`.
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { FLEET_MAX, resolveTargets, SWEEP_QUIET_MS, REVIEW_DIR, sweepGate, sweepExport, sweepNames, sweepKickoff, runSweep } =
  await import(join(ROOT, 'syzygy', 'bridge', 'fleet.mjs'))
const { spawnArgv } = await import(join(ROOT, 'syzygy', 'bridge', 'canvas.mjs'))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }

const IDS = ['a', 'b', 'c']

await ok('a single targetId is today\'s path, unchanged', () => {
  const r = resolveTargets({ body: { targetId: 'b' }, ids: IDS })
  assert.deepEqual(r, { ok: true, ids: ['b'], scope: 'one' })
})

await ok('all: true reaches every registered session', () => {
  const r = resolveTargets({ body: { all: true }, ids: IDS })
  assert.equal(r.scope, 'all')
  assert.deepEqual(r.ids, IDS)
})

await ok('targetIds takes a subset, de-duplicated, in the board\'s order', () => {
  const r = resolveTargets({ body: { targetIds: ['c', 'a', 'c'] }, ids: IDS })
  assert.deepEqual(r.ids, ['a', 'c'])
  assert.equal(r.scope, 'subset')
})

await ok('one unknown id refuses the WHOLE request and names it', () => {
  const r = resolveTargets({ body: { targetIds: ['a', 'ghost'] }, ids: IDS })
  assert.equal(r.ok, false)
  assert.equal(r.status, 404)
  assert.match(r.error, /ghost/)
})

await ok('an unknown single targetId is the same 404 it always was', () => {
  const r = resolveTargets({ body: { targetId: 'ghost' }, ids: IDS })
  assert.equal(r.ok, false); assert.equal(r.status, 404)
})

await ok('zero selectors, and two selectors, are both refused with a reason', () => {
  assert.equal(resolveTargets({ body: {}, ids: IDS }).status, 400)
  assert.match(resolveTargets({ body: { all: true, targetId: 'a' }, ids: IDS }).error, /one of/)
  assert.match(resolveTargets({ body: { targetIds: ['a'], targetId: 'a' }, ids: IDS }).error, /one of/)
})

await ok('an empty or non-array targetIds is refused, never treated as "all"', () => {
  assert.equal(resolveTargets({ body: { targetIds: [] }, ids: IDS }).status, 400)
  assert.equal(resolveTargets({ body: { targetIds: 'a' }, ids: IDS }).status, 400)
})

await ok('over the cap is REFUSED, never truncated -- all included', () => {
  const many = Array.from({ length: FLEET_MAX + 1 }, (_, i) => 's' + i)
  const a = resolveTargets({ body: { all: true }, ids: many })
  assert.equal(a.ok, false); assert.match(a.error, new RegExp(String(FLEET_MAX)))
  assert.match(a.error, new RegExp(String(many.length)), 'and names the count')
  assert.equal(resolveTargets({ body: { targetIds: many }, ids: many }).ok, false)
})

await ok('all: true on an empty board is refused, not a silent no-op', () => {
  const r = resolveTargets({ body: { all: true }, ids: [] })
  assert.equal(r.ok, false)
  assert.match(r.error, /no sessions/i)
})

const NOW = 1_700_000_000_000
const DAY = new Date(NOW).toISOString().slice(0, 10)
const idle = (over = {}) => ({ id: 'a', name: 'worker-a', working: false, idleSince: NOW - 60 * 60_000, startedAt: 0, ...over })

await ok('a working session blocks the sweep and is named', () => {
  const g = sweepGate({ sessions: [idle({ working: true })], now: NOW })
  assert.equal(g.ok, false)
  assert.match(g.reason, /worker-a/)
  assert.deepEqual(g.busy, ['worker-a'])
})

await ok('a session parked at a permission prompt is NOT working', () => {
  // relay.mjs's own comment: `working` means a turn is OPEN, and a session at
  // a prompt heartbeats working:true forever. One forgotten prompt must not
  // disable the sweep permanently.
  assert.equal(sweepGate({ sessions: [idle({ working: true, waiting: true })], now: NOW }).ok, true)
})

await ok('a canvas spawn with a null state is not busy -- the gate fails OPEN', () => {
  assert.equal(sweepGate({ sessions: [idle()], spawnedBy: [{ name: 'x', state: null }], now: NOW }).ok, true)
  assert.equal(sweepGate({ sessions: [idle()], spawnedBy: [{ name: 'x', state: 'working' }], now: NOW }).ok, false)
})

await ok('a dispatched request reports through session.state, never the working flag', () => {
  const busy = sweepGate({ sessions: [idle()], requests: [{ slug: 'r1', session: { state: 'working' } }], now: NOW })
  assert.equal(busy.ok, false); assert.match(busy.reason, /r1/)
  assert.equal(sweepGate({ sessions: [idle()], requests: [{ slug: 'r1', session: { state: 'done' } }], now: NOW }).ok, true)
})

await ok('the board must have been quiet for the whole window', () => {
  const recent = sweepGate({ sessions: [idle({ idleSince: NOW - 60_000 })], now: NOW })
  assert.equal(recent.ok, false)
  assert.match(recent.reason, /quiet/i)
  assert.ok(recent.quietFor < SWEEP_QUIET_MS)
})

await ok('an empty board is quiet', () => {
  assert.equal(sweepGate({ sessions: [], now: NOW }).ok, true)
})

await ok('override short-circuits both refusals and says so', () => {
  const g = sweepGate({ sessions: [idle({ working: true })], now: NOW, override: true })
  assert.equal(g.ok, true)
  assert.match(g.reason, /override/i)
})

// Distinctive surprises, so an assertion on where one lands can never collide
// with a letter in the export's own header.
const FINDINGS = [
  { id: '1', t: NOW - 2000, kind: 'constraint', project: 'p1', session: 's1', surprise: 'surprise-alpha', touched: ['x.js'], evidence: ['x.js:1'] },
  { id: '2', t: NOW - 1000, kind: 'drift', project: 'p1', session: 's2', surprise: 'surprise-bravo', touched: [], evidence: ['y.js:9'] },
  { id: '3', t: NOW - 3000, kind: '', project: 'p2', session: 's3', surprise: 'surprise-charlie', touched: [], evidence: ['no line here'] },
]

await ok('sweepExport groups by project, newest first, and segregates vague findings', () => {
  const md = sweepExport(FINDINGS, { since: 0, now: NOW })
  assert.match(md, /## p1/); assert.match(md, /## p2/)
  assert.ok(md.indexOf('surprise-bravo') < md.indexOf('surprise-alpha'), 'newest first inside a group')
  assert.match(md, /no line evidence/i)
  assert.match(md, /3 findings/)
  assert.match(md, /^# Architecture sweep export/, 'the header says what the export is')
})

await ok('sweepExport stamps every finding with its own time, never an ago against the wall clock', () => {
  const md = sweepExport(FINDINGS, { since: 0, now: NOW })
  for (const f of FINDINGS) assert.ok(md.includes(`- at: ${new Date(f.t).toISOString()}`), f.surprise)
  // The same store exported at a later `now` is the same text: nothing in it is relative.
  assert.equal(sweepExport(FINDINGS, { since: 0, now: NOW + 3600_000 }), md)
})

await ok('sweepExport carries EVERY project, whichever one the review lands in', () => {
  // The chosen project decides only where the worktree and the review live;
  // the evaluator's value is the whole fleet's picture.
  const md = sweepExport(FINDINGS, { since: 0, now: NOW, project: '/repos/p1' })
  assert.match(md, /## p2/); assert.ok(md.includes('surprise-charlie'))
})

await ok('sweepExport keeps only findings after `since`', () => {
  const md = sweepExport(FINDINGS, { since: NOW - 1500, now: NOW })
  assert.match(md, /1 finding\b/)
  assert.equal(md.includes('## p2'), false)
})

await ok('sweepExport says so plainly when the store is empty', () => {
  assert.match(sweepExport([], { since: 0, now: NOW }), /no findings/i)
})

await ok('a second sweep on one date takes the next free suffix', () => {
  const taken = new Set([`/p/.claude/worktrees/sweep-${DAY}`])
  const n = sweepNames({ project: '/p', date: DAY, exists: (p) => taken.has(p) })
  assert.equal(n.slug, `sweep-${DAY}-2`)
  assert.equal(n.branch, `sweep/${DAY}-2`)
  assert.ok(n.worktree.endsWith(`sweep-${DAY}-2`))
})

await ok('the kickoff names the skill, the export, the review path and the null verdict', () => {
  const reviewPath = `${REVIEW_DIR}/${DAY}-architecture-sweep.md`
  const k = sweepKickoff({ date: DAY, exportPath: '.claude/sweep/findings.md', reviewPath, count: 7, since: 0 })
  assert.match(k, /architecture-sweep skill/)
  assert.ok(k.includes('.claude/sweep/findings.md'))
  assert.ok(k.includes(reviewPath), 'the review path, built from REVIEW_DIR')
  assert.match(k, /nothing to change/i)
  assert.match(k, /report_finding/)
  assert.equal(k.startsWith('-'), false, 'a prompt may not begin with "-" (canvas.mjs spawnRequest)')
})

await ok('the kickoff ends on exactly one report_finding, a question, even for a clean sweep', () => {
  const reviewPath = `${REVIEW_DIR}/${DAY}-architecture-sweep.md`
  const k = sweepKickoff({ date: DAY, exportPath: '.claude/sweep/findings.md', reviewPath, count: 0, since: 0 })
  assert.match(k, /exactly one `report_finding` call/)
  assert.match(k, /`kind: 'question'`/)
  assert.match(k, /even when the verdict is that nothing needs to change/)
  assert.equal(/for anything new/.test(k), false, 'never an open invitation to report more than once')
})

await ok('the sweep argv is canvas.mjs spawnArgv: prompt last behind --, no budget flag, no --allowedTools', () => {
  // The kickoff is multi-line; it must arrive as ONE argv entry.
  const prompt = sweepKickoff({ date: DAY, exportPath: '.claude/sweep/findings.md', reviewPath: `${REVIEW_DIR}/${DAY}-architecture-sweep.md`, count: 7, since: 0 })
  const argv = spawnArgv({ name: `sweep-${DAY}`, prompt, model: 'opus', effort: 'high', settings: '{"env":{}}' })
  assert.deepEqual(argv, ['--bg', '--settings', '{"env":{}}', '-n', `sweep-${DAY}`, '--permission-mode', 'auto',
    '--model', 'opus', '--effort', 'high', '--', prompt])
  assert.equal(argv.includes('--max-budget-usd'), false, 'it binds only a --print session; a sweep is --bg')
  assert.equal(argv.includes('--allowedTools'), false, 'variadic; it would swallow the prompt')
})

const recordingRun = (calls) => async (bin, argv, opts) => {
  calls.push({ bin, argv, opts })
  return bin === 'git' ? { code: 0, stdout: '', stderr: '' }
                       : { code: 0, stdout: 'Starting background service…\nbackgrounded · abc123 · sweep\n', stderr: '' }
}
const sweepInputs = (over = {}) => ({
  project: '/p', findings: [], since: 0, gate: { ok: true }, now: () => NOW, date: DAY,
  exists: () => false, writeFile: () => {}, mkdir: () => {},
  claudeBin: 'claude', relayPort: 4550, relayToken: 'tok', ...over,
})

await ok('runSweep hands claude spawnArgv exactly: prompt last behind --, no budget flag, no --allowedTools', async () => {
  const calls = [], files = {}
  const out = await runSweep(sweepInputs({ run: recordingRun(calls), writeFile: (p, s) => { files[p] = s } }))
  assert.equal(out.status, 200)
  assert.deepEqual(calls.filter((c) => c.bin === 'git').map((c) => c.argv.slice(0, 2)), [['worktree', 'add'], ['worktree', 'lock']])
  const spawn = calls.find((c) => c.bin === 'claude')
  const settings = '{"env":{"SZG_RELAY_PORT":"4550","SZG_RELAY_TOKEN":"tok"}}'
  assert.deepEqual(spawn.argv, ['--bg', '--settings', settings, '-n', `sweep-${DAY}`, '--permission-mode', 'auto',
    '--model', 'opus', '--effort', 'high', '--', spawn.argv.at(-1)])
  assert.match(spawn.argv.at(-1), /architecture-sweep skill/)
  assert.equal(spawn.argv.includes('--max-budget-usd'), false)
  assert.equal(spawn.argv.includes('--allowedTools'), false)
  assert.equal(spawn.opts.cwd, out.body.worktree)
  assert.equal(Object.keys(spawn.opts.env).some((k) => k.startsWith('SZG_')), false, 'childEnv strips every SZG_ key')
  assert.ok(Object.keys(files).some((p) => p.endsWith(join('.claude', 'sweep', 'findings.md'))), 'the export is a file')
})

await ok('runSweep refuses a closed gate and a bad model before running anything', async () => {
  const calls = []
  assert.equal((await runSweep(sweepInputs({ run: recordingRun(calls), gate: { ok: false, reason: 'busy' } }))).status, 409)
  assert.equal((await runSweep(sweepInputs({ run: recordingRun(calls), model: 'gpt' }))).status, 400)
  assert.equal((await runSweep(sweepInputs({ run: recordingRun(calls), effort: 'eleven' }))).status, 400)
  assert.equal(calls.length, 0)
})

// findings.js restates findings.mjs's line-evidence rule for the browser, which
// cannot import an ES module. Nothing in it runs at evaluation time, so an
// empty vm context is enough to hold the copy to the source of truth.
const { readFileSync } = await import('node:fs')
const vm = await import('node:vm')
const { hasLineEvidence } = await import(join(ROOT, 'syzygy', 'bridge', 'findings.mjs'))
const MCF = vm.runInNewContext(readFileSync(join(ROOT, 'syzygy', 'bridge', 'public', 'findings.js'), 'utf8') + '\n;MCF', {})

await ok('findings.js hasLine agrees with findings.mjs hasLineEvidence', () => {
  for (const ev of [['a.js:12'], ['a.js:12:3'], ['README.md', 'a.js:9'], ['a.js'], ['a.js:'],
    [], 'a.js:12', null, [12], ['  a.js:7  '], ['a.js:12x']]) {
    assert.equal(MCF.hasLine(ev), hasLineEvidence(ev), JSON.stringify(ev))
  }
})

await ok('findings.js gateOf agrees with fleet.mjs sweepGate on the session half', () => {
  const Q = 10 * 60_000
  const boards = [
    [], [idle()], [idle({ working: true })], [idle({ working: true, waiting: true })],
    [idle({ idleSince: NOW - 60_000 })], [idle({ idleSince: null, startedAt: NOW - 30 * 60_000 })],
    [idle(), idle({ id: 'b', name: 'worker-b', working: true })],
  ]
  for (const sessions of boards) {
    assert.equal(MCF.gateOf(sessions, Q, NOW).ok, sweepGate({ sessions, now: NOW, quietMs: Q }).ok, JSON.stringify(sessions))
  }
})

// ---- the live relay: real subprocess, fake `claude` ------------------
// The routes live in relay.mjs's HTTP handler, so they are tested against the
// REAL relay. Isolated on three axes, as test/canvas-harness.mjs is: SZG_PORT=0
// (OS-assigned, never a shared port), SZG_DATA_DIR in a throwaway dir, and
// SZG_CLAUDE_BIN pointing at a script that answers --help like a capable
// `claude`, prints what `claude --bg` prints and records its argv as JSON.
// agents.json stays `[]`, so the relay's waiting poll never marks a session
// waiting. No case here starts a real session.
{
  const { spawn } = await import('node:child_process')
  const { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, realpathSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const tmp = () => mkdtempSync(join(tmpdir(), 'szg-fleet-'))
  const dataDir = tmp()
  const fakeDir = tmp()
  const argvFile = join(fakeDir, 'argv.json'), agentsFile = join(fakeDir, 'agents.json'), countFile = join(fakeDir, 'count.txt')
  writeFileSync(agentsFile, '[]')
  const fakeBin = join(fakeDir, 'claude')
  writeFileSync(fakeBin, [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "  --bg   run in the background"; echo "  attach   attach to a session"; exit 0; fi',
    'if [ "$1" = "--version" ]; then echo "0.0.0-fake (fleet harness)"; exit 0; fi',
    'if [ "$1" = "agents" ]; then cat "' + agentsFile + '"; exit 0; fi',
    'n=$(cat "' + countFile + '" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "' + countFile + '"',
    // JSON, not one arg per line: a multi-line prompt must come back whole.
    '"' + process.execPath + '" -e \'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))\' "' + argvFile + '" "$@"',
    'name=""; prev=""',
    'for a in "$@"; do if [ "$prev" = "-n" ]; then name="$a"; break; fi; prev="$a"; done',
    'echo "Starting background service…"',
    'echo "backgrounded · fake000$n · $name"',
    '',
  ].join('\n'))
  chmodSync(fakeBin, 0o755)
  const rootDir = realpathSync(tmp())
  // A real repository: only `claude` is faked, and /api/sweep runs a real
  // `git worktree add` in the project it resolves.
  const { execFileSync } = await import('node:child_process')
  const git = (...args) => execFileSync('git', args, { cwd: rootDir, stdio: 'ignore' })
  git('init', '-q')
  git('-c', 'user.name=harness', '-c', 'user.email=harness@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture')
  const RELAY_TOKEN = 'fleet-harness-token'
  const child = spawn(process.execPath, [join(ROOT, 'syzygy', 'bridge', 'relay.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, SZG_PORT: '0', SZG_TOKEN: RELAY_TOKEN, SZG_DATA_DIR: dataDir, SZG_CLAUDE_BIN: fakeBin,
      SZG_TMUX_BIN: '/usr/bin/false', SZG_SPAWN_PLUGIN_DIR: '', SZG_SWEEP_QUIET_MS: '600000',
      SZG_PANE_PASSWORD_DISABLED: '1', // this harness's own GETs carry no cookie; writes still need the token
    },
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
    // Unref'd so a relay that answered in time does not hold the harness open
    // for the rest of the eight seconds after the last case.
    setTimeout(() => reject(new Error('relay did not report a port in time')), 8000).unref()
  })
  const base = `http://127.0.0.1:${port}`
  const post = async (path, body = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: RELAY_TOKEN, ...body }) })
    const j = await r.json().catch(() => ({}))
    return { status: r.status, ...j }
  }
  // The drain needs the token too: SZG_PANE_PASSWORD_DISABLED does not bypass authed().
  const drain = async (id) => (await fetch(`${base}/api/commands/${id}?token=${RELAY_TOKEN}`)).json()
  const capture = async () => (await fetch(base + '/api/capture')).json()
  const state = async () => (await fetch(base + '/api/state')).json()
  const register = (id, name, extra = {}) => post('/api/register', { session: { id, name, cwd: rootDir, root: rootDir, ...extra } })

  try {
    await ok('a single-target command still answers ok, and is now captured', async () => {
      await register('s1', 'worker-a'); await register('s2', 'worker-b')
      const r = await post('/api/command', { targetId: 's1', verb: 'prompt', payload: { text: 'hi' }, label: 'run tests' })
      assert.equal(r.status, 200); assert.equal(r.scope, 'one'); assert.equal(r.n, 1)
      assert.deepEqual(r.queued.map((q) => q.name), ['worker-a'])
      const line = (await capture()).entries.filter((e) => e.kind === 'command').at(-1)
      assert.equal(line.scope, 'one'); assert.equal(line.label, 'run tests')
    })

    await ok('all: true queues one command per session and captures ONE line', async () => {
      const before = (await capture()).entries.length
      const r = await post('/api/command', { all: true, verb: 'prompt', payload: { text: 'findings please' } })
      assert.equal(r.status, 200); assert.equal(r.scope, 'all'); assert.equal(r.n, 2)
      const cap = await capture()
      assert.equal(cap.entries.length, before + 1, 'one entry for the fan-out, not one per target')
      assert.equal(cap.entries.at(-1).n, 2)
    })

    await ok('an unknown id in targetIds refuses and queues NOTHING', async () => {
      // Empty both queues first: the two cases above queued to each.
      await drain('s1'); await drain('s2')
      const r = await post('/api/command', { targetIds: ['s1', 'ghost'], verb: 'prompt', payload: { text: 'x' } })
      assert.equal(r.status, 404)
      assert.equal((await drain('s1')).commands.length, 0, 's1 got nothing from the refused request')
    })

    await ok('a session drains what the broadcast queued', async () => {
      await post('/api/command', { all: true, verb: 'prompt', payload: { text: 'broadcast body' } })
      assert.equal((await drain('s2')).commands.at(-1).payload.text, 'broadcast body')
    })

    // The POST body report_finding sends, against a REAL relay -- which is where
    // it is pinned, since the plugin harness runs with the relay down by
    // construction (test/harness.mjs's makeDollar).
    await ok('a finding POSTs with a kind, and rides the bounded snapshot field', async () => {
      const r = await post('/api/findings', {
        session: 'worker-a', project: 'proj', kind: 'constraint',
        touched: ['syzygy/bridge/dispatch.mjs'],
        surprise: '--allowedTools is variadic and swallows the prompt',
        evidence: ['syzygy/bridge/dispatch.mjs:167'],
        id: 'client-supplied', t: 1,
      })
      assert.equal(r.status, 200)
      assert.equal(r.finding.kind, 'constraint')
      assert.notEqual(r.finding.id, 'client-supplied', 'the relay assigns the id')
      assert.notEqual(r.finding.t, 1, 'and the timestamp')
      const s = await state()
      assert.equal(s.findings.at(-1).kind, 'constraint', 'newest last, like events')
    })

    await ok('the snapshot field is bounded well below the store cap', async () => {
      for (let i = 0; i < 60; i++) await post('/api/findings', { surprise: 'S' + i, evidence: ['a.js:1'] })
      const s = await state()
      assert.equal(s.findings.length, 50)
      const full = await (await fetch(base + '/api/findings?limit=200')).json()
      assert.ok(full.findings.length > 50, 'the whole store is still reachable')
    })

    const waitFor = async (pred, ms = 12_000) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (await pred()) return true
        await new Promise((r) => setTimeout(r, 200))
      }
      return false
    }

    await ok('the relay publishes its quiet window, and the scanner lists the fixture repo', async () => {
      assert.equal((await state()).sweepQuietMs, 600_000)
      // projects fill on the relay's periodic scan of registered roots.
      assert.ok(await waitFor(async () => (await state()).projects.some((p) => p.mainRoot === rootDir)),
        'the fixture repo appears in projects')
    })

    await ok('the sweep is refused while a session is working, with the reason', async () => {
      await post('/api/stats', { id: 's1', working: true })
      const r = await post('/api/sweep', { project: rootDir })
      assert.equal(r.status, 409)
      assert.match(r.error, /working/)
    })

    await ok('override runs it anyway and captures that it was forced', async () => {
      const r = await post('/api/sweep', { project: rootDir, override: true })
      assert.equal(r.status, 200, JSON.stringify(r))
      assert.match(r.branch, /^sweep\//)
      const line = (await capture()).entries.filter((e) => e.kind === 'sweep').at(-1)
      assert.equal(line.override, true)
      assert.equal(line.branch, r.branch)
    })

    await ok('the fake claude was handed the sweep argv, prompt last behind --, no budget flag', async () => {
      // Recorded as JSON: the kickoff is multi-line.
      const argv = JSON.parse(readFileSync(argvFile, 'utf8'))
      assert.equal(argv.includes('--allowedTools'), false)
      assert.equal(argv.includes('--max-budget-usd'), false)
      assert.equal(argv.at(-2), '--')
      assert.match(argv.at(-1), /architecture-sweep skill/)
      assert.equal(argv[argv.indexOf('--settings') + 1],
        JSON.stringify({ env: { SZG_RELAY_PORT: String(port), SZG_RELAY_TOKEN: RELAY_TOKEN } }), 'the bound port, never 4317')
    })

    await ok('a project that is not a directory is refused before anything is created', async () => {
      assert.equal((await post('/api/sweep', { project: 'proj', override: true })).status, 400)
    })
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)) }
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(fakeDir, { recursive: true, force: true })
    rmSync(rootDir, { recursive: true, force: true })
  }
}

console.log(`fleet-harness: ${pass} passed`)
