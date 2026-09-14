#!/usr/bin/env node
// Drives bridge/spend.mjs: the pure helpers first, then the store itself
// against real temp directories -- ordering and the t stamp, the digest's
// three windows, the torn-line and rotation recovery paths, and the read
// route's paging -- then a real relay's snapshot key, event and routes.
// Hermetic: everything lives under a fresh temp dir per case, nothing
// touches WORLD_DIR, and the relay binds an OS-assigned port.
//
// Run: node test/spend-harness.mjs   (or `just test-spend`)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const S = await import(join(ROOT, 'syzygy', 'bridge', 'spend.mjs'))
const OR = await import(join(ROOT, 'syzygy', 'bridge', 'orchestrator.mjs'))
const SC = await import(join(ROOT, 'syzygy', 'bridge', 'scoping.mjs'))
const CH = await import(join(ROOT, 'syzygy', 'bridge', 'chains.mjs'))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }
const dir = () => mkdtempSync(join(tmpdir(), 'szg-spend-'))

const DAY = 86_400_000
const NOW = new Date(2031, 4, 14, 15, 0, 0).getTime() // a local afternoon
const frame = {
  type: 'result', subtype: 'success', total_cost_usd: 0.0125, duration_ms: 900,
  usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
}

console.log('spend harness')

// ---- pure helpers -----------------------------------------------------

await ok('KINDS is frozen and normalizeKind falls back to other', async () => {
  assert.deepEqual([...S.KINDS], ['chain', 'pattern', 'orchestrator', 'scoping', 'liaison', 'band', 'other'])
  assert.ok(Object.isFrozen(S.KINDS))
  assert.equal(S.normalizeKind('nope'), 'other')
  assert.equal(S.normalizeKind('band'), 'band')
})

await ok('estimateTokens is four characters a token, and argvModel reads --model', async () => {
  assert.equal(S.estimateTokens('abcde'), 2)
  assert.equal(S.estimateTokens(null), 0)
  assert.equal(S.argvModel(['-p', '--model', 'sonnet', 'x']), 'sonnet')
  assert.equal(S.argvModel(['-p']), '')
})

await ok('sanitizeRecord refuses a non-object and clamps a bad one', async () => {
  assert.equal(S.sanitizeRecord([]), null)
  assert.equal(S.sanitizeRecord('x'), null)
  const s = S.sanitizeRecord({ kind: 'band', site: 'Bad Site!', usd: -1, usage: { input: 3.7, output: -2 } })
  assert.equal(s.site, '')
  assert.equal(s.usd, null)
  assert.deepEqual(s.usage, { input: 3, output: 0, cacheCreate: 0, cacheRead: 0 })
})

await ok('resultRecord reads a successful result frame', async () => {
  const r = S.resultRecord({ kind: 'chain', site: 'refine', model: 'sonnet', frame, startedAt: 0, now: 5 })
  assert.equal(r.usd, 0.0125)
  assert.equal(S.tokensOf(r), 100)
  assert.equal(r.durationMs, 900)
  assert.equal(r.noResult, false)
  assert.equal(r.error, false)
})

await ok('resultRecord records a call that printed no frame, with an elapsed duration', async () => {
  const none = S.resultRecord({ kind: 'orchestrator', site: 'ask', frame: null, startedAt: 100, now: 350 })
  assert.equal(none.usd, null)
  assert.equal(none.noResult, true)
  assert.equal(none.durationMs, 250)
})

await ok('resultRecord flags a non-success subtype as an error', async () => {
  const e = S.resultRecord({ kind: 'pattern', site: 'pass', frame: { ...frame, subtype: 'error_max_budget_usd' } })
  assert.equal(e.error, true)
})

await ok('digestOf buckets tuples into today, week and all, and byKind omits an empty kind', async () => {
  const tYesterday = S.dayStart(NOW) - 60_000
  const t6 = NOW - 6 * DAY
  const t8 = NOW - 8 * DAY
  const tuples = [
    { t: NOW, k: 'band', usd: 0.01, tok: 10, est: false, nr: false },
    { t: tYesterday, k: 'chain', usd: 0.02, tok: 20, est: false, nr: false },
    { t: t6, k: 'orchestrator', usd: 0.03, tok: 30, est: false, nr: false },
    { t: t8, k: 'scoping', usd: 0.04, tok: 40, est: false, nr: false },
  ]
  const d = S.digestOf(tuples, NOW)
  assert.equal(d.today.calls, 1)
  assert.equal(d.week.calls, 3)
  assert.equal(d.all.calls, 4)
  assert.equal(d.since, t8)
  assert.equal(d.updatedAt, NOW)
  assert.ok(!('chain' in d.today.byKind))
  assert.ok(!('scoping' in d.week.byKind))
  assert.equal(d.all.usd, 0.1)
})

// ---- the store ----------------------------------------------------------

await ok('a record gets a strictly increasing t under a frozen clock, and onChange fires each time', async () => {
  const seen = []
  const store = S.createSpend({ dir: dir(), now: () => NOW, onChange: (dg) => seen.push(dg) })
  const r1 = store.record({ kind: 'band', site: 'submit' })
  const r2 = store.record({ kind: 'band', site: 'submit' })
  assert.equal(r1.t, NOW)
  assert.equal(r2.t, NOW + 1)
  assert.equal(seen.length, 2)
  assert.equal(seen[0].all.calls, 1)
  assert.equal(seen[1].all.calls, 2)
})

await ok('two records land as two lines on disk', async () => {
  const d = dir()
  const store = S.createSpend({ dir: d, now: () => NOW })
  store.record({ kind: 'band', site: 'submit' })
  store.record({ kind: 'band', site: 'submit' })
  const lines = readFileSync(join(d, S.SPEND_FILE), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
})

await ok('unreported and estimatedShare come from the noResult and estimated flags', async () => {
  const store = S.createSpend({ dir: dir(), now: () => NOW })
  store.record({ kind: 'band', site: 'a', noResult: true })
  store.record({ kind: 'band', site: 'b', estimated: true })
  store.record({ kind: 'band', site: 'c' })
  store.record({ kind: 'band', site: 'd' })
  const dg = store.digest()
  assert.equal(dg.unreported, 1)
  assert.equal(dg.estimatedShare, 0.25)
})

await ok('reopening the store on the same dir reproduces the same digest', async () => {
  const d = dir()
  const store1 = S.createSpend({ dir: d, now: () => NOW })
  store1.record({ kind: 'chain', site: 'refine' })
  store1.record({ kind: 'band', site: 'submit', usd: 0.02 })
  const digest1 = store1.digest()
  const store2 = S.createSpend({ dir: d, now: () => NOW })
  const digest2 = store2.digest()
  assert.equal(JSON.stringify(digest1), JSON.stringify(digest2))
})

await ok('a torn final line is skipped and counted, and the file is never rewritten', async () => {
  const d = dir()
  const store1 = S.createSpend({ dir: d, now: () => NOW })
  store1.record({ kind: 'chain', site: 'refine' })
  store1.record({ kind: 'band', site: 'submit' })
  const file = join(d, S.SPEND_FILE)
  appendFileSync(file, '{"t":\n')
  const before = readFileSync(file, 'utf8')
  const store2 = S.createSpend({ dir: d, now: () => NOW })
  const dg = store2.digest()
  assert.equal(dg.skipped, 1)
  assert.equal(dg.all.calls, 2)
  assert.equal(readFileSync(file, 'utf8'), before)
})

await ok('a full file rotates aside on the next record', async () => {
  const d = dir()
  const file = join(d, S.SPEND_FILE)
  const rotated = join(d, S.SPEND_ROTATED)
  const lines = Array.from({ length: S.ROTATE_LINES }, (_, i) => JSON.stringify({ t: i + 1, kind: 'chain' }))
  writeFileSync(file, lines.join('\n') + '\n')
  const store = S.createSpend({ dir: d, now: () => NOW })
  store.record({ kind: 'band', site: 'submit' })
  assert.equal(readFileSync(rotated, 'utf8').trim().split('\n').length, S.ROTATE_LINES)
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1)
  assert.equal(store.digest().all.calls, S.ROTATE_LINES + 1)
})

await ok('read filters by kind, newest first, and answers empty for an unknown kind', async () => {
  const store = S.createSpend({ dir: dir(), now: () => NOW })
  const kinds = ['band', 'band', 'chain', 'chain', 'orchestrator', 'band', 'chain']
  for (const kind of kinds) store.record({ kind, site: 'x' })
  const bandOnly = store.read({ kind: 'band' })
  assert.equal(bandOnly.items.length, 3)
  assert.ok(bandOnly.items.every((r) => r.kind === 'band'))
  for (let i = 1; i < bandOnly.items.length; i++) assert.ok(bandOnly.items[i - 1].t > bandOnly.items[i].t)
  assert.deepEqual(store.read({ kind: 'nope' }), { items: [], next: null })
})

await ok('read pages with limit and before, visiting every record exactly once', async () => {
  const store = S.createSpend({ dir: dir(), now: () => NOW })
  const kinds = ['band', 'band', 'chain', 'chain', 'orchestrator', 'band', 'chain']
  for (const kind of kinds) store.record({ kind, site: 'x' })
  const seenT = new Set()
  let before, pages = 0
  for (;;) {
    const page = store.read({ limit: 3, before })
    for (const r of page.items) seenT.add(r.t)
    pages += 1
    if (page.next === null) break
    before = page.next
    if (pages > 10) throw new Error('paging did not terminate')
  }
  assert.equal(seenT.size, kinds.length)
  assert.equal(pages, Math.ceil(kinds.length / 3))
})

await ok('since and before filter with t >= since and t < before', async () => {
  const store = S.createSpend({ dir: dir(), now: () => NOW })
  const recs = []
  for (let i = 0; i < 5; i++) recs.push(store.record({ kind: 'band', site: 'x' }))
  const inRange = store.read({ since: recs[2].t, before: recs[4].t })
  assert.equal(inRange.items.length, 2)
  assert.ok(inRange.items.every((r) => r.t >= recs[2].t && r.t < recs[4].t))
})

await ok('limit is clamped to READ_LIMIT_MAX, and an unset limit gives READ_LIMIT_DEFAULT', async () => {
  const d = dir()
  const file = join(d, S.SPEND_FILE)
  const total = S.READ_LIMIT_MAX + 20
  const lines = Array.from({ length: total }, (_, i) => JSON.stringify({ t: i + 1, kind: 'band' }))
  writeFileSync(file, lines.join('\n') + '\n')
  const store = S.createSpend({ dir: d, now: () => NOW })
  assert.equal(store.read({ limit: 1000 }).items.length, S.READ_LIMIT_MAX)
  assert.equal(store.read({}).items.length, S.READ_LIMIT_DEFAULT)
})

await ok('the digest stays small over 10,000 records spread across 30 days', async () => {
  const d = dir()
  const file = join(d, S.SPEND_FILE)
  const kinds = [...S.KINDS]
  const lines = []
  for (let i = 0; i < 10_000; i++) {
    const t = NOW - Math.floor(Math.random() * 30 * DAY)
    lines.push(JSON.stringify({
      t, kind: kinds[i % kinds.length], usd: 0.01,
      usage: { input: 10, output: 10, cacheCreate: 0, cacheRead: 0 },
    }))
  }
  writeFileSync(file, lines.join('\n') + '\n')
  const store = S.createSpend({ dir: d, now: () => NOW })
  const size = JSON.stringify(store.digest()).length
  assert.ok(size < 2048, `digest size was ${size}`)
})

// ---- the pane (MCSP) ---------------------------------------------------
// Loaded the way quick-access-harness.mjs loads quick-access.js: a classic
// script under `new Function`, not node:vm, so its top-level `const` binds
// in the returned scope rather than on a window object.
const SPEND_JS = join(ROOT, 'syzygy', 'bridge', 'public', 'spend.js')
const spendSrc = readFileSync(SPEND_JS, 'utf8')
const MCSP = new Function('window', spendSrc + '\nreturn MCSP')({ SZG_TOKEN: 'pane-harness-token' })

console.log('\nspend pane (MCSP)')

await ok('KINDS restates spend.mjs\'s own list, and LABELS covers it with the right words', async () => {
  assert.deepEqual([...MCSP.KINDS], [...S.KINDS])
  assert.deepEqual(Object.keys(MCSP.LABELS), [...S.KINDS])
  assert.deepEqual(MCSP.LABELS, {
    chain: 'chains refiner',
    pattern: 'pattern pass',
    orchestrator: 'orchestrator',
    scoping: 'scoping & fan-out',
    liaison: 'liaison',
    band: 'band',
    other: 'other',
  })
})

await ok('fmtUsd: zero, a fraction of a cent, and a dollar figure', async () => {
  assert.equal(MCSP.fmtUsd(0), '$0')
  assert.equal(MCSP.fmtUsd(0.0042), '$0.0042')
  assert.equal(MCSP.fmtUsd(1.5), '$1.50')
})

await ok('fmtTok: bare, thousands, and millions', async () => {
  assert.equal(MCSP.fmtTok(950), '950')
  assert.equal(MCSP.fmtTok(1234), '1.2k')
  assert.equal(MCSP.fmtTok(2_500_000), '2.5M')
})

await ok('cellText: a missing cell, a dollar cell, and a band cell in tokens', async () => {
  assert.equal(MCSP.cellText(undefined, 'chain'), '—')
  assert.equal(MCSP.cellText({ calls: 3, usd: 0.0421, tokens: 9 }, 'chain'), '3 · $0.0421')
  assert.equal(MCSP.cellText({ calls: 5, usd: 0, tokens: 1234 }, 'band'), '5 · ~1.2k tok')
})

await ok('rowsOf: the six named kinds, then total, and no other on an empty digest', async () => {
  const rows = MCSP.rowsOf(S.digestOf([], NOW))
  assert.deepEqual(rows.map((r) => r.kind), ['chain', 'pattern', 'orchestrator', 'scoping', 'liaison', 'band', 'total'])
})

await ok('rowsOf: a digest with an other call puts other before total', async () => {
  const tuples = [{ t: NOW, k: 'other', usd: 0.01, tok: 10, est: false, nr: false }]
  const rows = MCSP.rowsOf(S.digestOf(tuples, NOW))
  assert.deepEqual(rows.map((r) => r.kind), ['chain', 'pattern', 'orchestrator', 'scoping', 'liaison', 'band', 'other', 'total'])
})

await ok('caveatOf: the CLI attribution sentence and the scoping exclusion always appear', async () => {
  const text = MCSP.caveatOf(S.digestOf([], NOW))
  assert.ok(text.includes("the CLI's own cost figures; your usage window is account-wide and cannot be attributed"))
  assert.ok(text.includes('scoping conversations'))
  assert.ok(!text.includes('no figure'))
  assert.ok(!text.includes('estimated'))
})

await ok('caveatOf: mentions no figure only when unreported, and estimated only when estimatedShare', async () => {
  const noFigure = MCSP.caveatOf(S.digestOf([{ t: NOW, k: 'band', usd: null, tok: 10, est: false, nr: true }], NOW))
  assert.ok(noFigure.includes('no figure'))
  assert.ok(!noFigure.includes('estimated'))

  const estimated = MCSP.caveatOf(S.digestOf([{ t: NOW, k: 'band', usd: 0.01, tok: 10, est: true, nr: false }], NOW))
  assert.ok(estimated.includes('estimated'))
  assert.ok(!estimated.includes('no figure'))
})

await ok('rowText names the label and all three cells', async () => {
  const d = S.digestOf([{ t: NOW, k: 'band', usd: 0.02, tok: 500, est: true, nr: false }], NOW)
  const row = MCSP.rowsOf(d).find((r) => r.kind === 'band')
  const text = MCSP.rowText(row, d.since)
  assert.ok(text.includes(row.label))
  assert.ok(text.includes('today'))
  assert.ok(text.includes('7-day'))
  assert.ok(text.includes(MCSP.sinceLabel(d.since)))
  assert.ok(text.includes(MCSP.cellText(row.today, 'band')))
  assert.ok(text.includes(MCSP.cellText(row.all, 'band')))
})

await ok('sinceLabel: all time for null, a local date otherwise', async () => {
  assert.equal(MCSP.sinceLabel(null), 'all time')
  assert.equal(MCSP.sinceLabel(new Date(2031, 4, 6, 3, 0, 0).getTime()), 'since ' + ['2031', '05', '06'].join('-'))
})

await ok('callText: the clock, site, model, cost, tokens and error all show up', async () => {
  const t = new Date(2031, 4, 14, 9, 5, 3).getTime()
  const item = {
    t, kind: 'band', site: 'narrate', model: 'haiku', usd: 0.0042,
    usage: { input: 100, output: 200, cacheCreate: 0, cacheRead: 0 },
    durationMs: 1500, estimated: true, noResult: false, error: false,
  }
  const text = MCSP.callText(item)
  assert.ok(text.includes('09:05:03'))
  assert.ok(text.includes('narrate'))
  assert.ok(text.includes('haiku'))
  assert.ok(text.includes('$0.0042'))
  assert.ok(text.includes('~300 tok'))
  assert.ok(text.includes('1.5s'))

  const noFigure = MCSP.callText({ ...item, usd: null, site: '', noResult: true })
  assert.ok(noFigure.includes('no figure'))
  assert.ok(noFigure.includes('band'), 'falls back to kind when site is blank')

  const errored = MCSP.callText({ ...item, error: true })
  assert.ok(errored.trim().endsWith('error'))
})

// ---- the three relay-side call sites -----------------------------------

await ok('every module that reads a child result frame records its spend', async () => {
  const BRIDGE = join(ROOT, 'syzygy', 'bridge')
  const READS_RESULT = /type === 'result'|isResultFrame\(|total_cost_usd/
  const readers = readdirSync(BRIDGE)
    .filter((f) => f.endsWith('.mjs') && f !== 'spend.mjs')
    .filter((f) => READS_RESULT.test(readFileSync(join(BRIDGE, f), 'utf8'))).sort()
  assert.deepEqual(readers, ['chains.mjs', 'orchestrator.mjs', 'scoping.mjs'],
    'a module that reads a child result frame records its spend: add spend?.record( there and name it here')
  for (const f of readers) {
    assert.match(readFileSync(join(BRIDGE, f), 'utf8'), /spend\?\.record\(/, `${f} reads a result frame and records no spend`)
  }
})

await ok('every $.model.complete in the band records its spend', async () => {
  const hud = readFileSync(join(ROOT, 'syzygy', 'hooks', 'hud.tsx'), 'utf8')
  const completions = (hud.match(/\$\.model\s*\.complete\(/g) ?? []).length
  assert.ok(completions > 0)
  assert.equal((hud.match(/recordBandSpend\(\$,/g) ?? []).length, completions,
    'every $.model.complete in the band records its spend')
})

/** A fake child process, the same shape test/orchestrator-harness.mjs's and
 *  test/fanout-harness.mjs's own fakeSpawn give createOrchestrator and
 *  createScoper -- neither harness is importable from here. */
const fakeChildSpawn = (calls) => (bin, argv, opts) => {
  const listeners = { stdout: [], stderr: [], close: [], error: [] }
  const child = {
    killed: false,
    stdout: { setEncoding() {}, on(_e, f) { listeners.stdout.push(f) } },
    stderr: { setEncoding() {}, on(_e, f) { listeners.stderr.push(f) } },
    on(e, f) { if (e === 'close') listeners.close.push(f); else if (e === 'error') listeners.error.push(f) },
    kill() { this.killed = true; for (const f of listeners.close) f(143) },
    emit(text) { for (const f of listeners.stdout) f(text) },
    finish(code = 0) { for (const f of listeners.close) f(code) },
  }
  calls.push({ bin, argv, opts, child })
  return child
}

await ok('createOrchestrator records a blurb, a liaison turn, and a child that printed no frame', async () => {
  const got = []
  const calls = []
  const orch = OR.createOrchestrator({
    spawn: fakeChildSpawn(calls), claudeBin: 'claude', broadcast: () => {},
    capture: { append() {}, read: () => [] }, spend: { record: (r) => got.push(r) },
  })

  const blurbPromise = orch.refreshBlurb({ force: true })
  calls[0].child.emit(JSON.stringify(frame) + '\n')
  calls[0].child.finish(0)
  await blurbPromise
  assert.equal(got.length, 1)
  assert.equal(got[0].kind, 'orchestrator')
  assert.equal(got[0].site, 'blurb')
  assert.equal(got[0].usd, 0.0125)
  assert.equal(got[0].model, calls[0].argv[calls[0].argv.indexOf('--model') + 1])

  const liaisonPromise = orch.liaisonAsk('q', { peer: 'p' })
  calls[1].child.emit(JSON.stringify(frame) + '\n')
  calls[1].child.finish(0)
  await liaisonPromise
  assert.equal(got.length, 2)
  assert.equal(got[1].kind, 'liaison')

  const failPromise = orch.refreshBlurb({ force: true })
  calls[2].child.finish(1)
  await failPromise
  assert.equal(got.length, 3)
  assert.equal(got[2].noResult, true)
})

await ok('createScoper records spend on a bank call, and nothing when the cwd is missing', async () => {
  const got = []
  const calls = []
  const items = new Map()
  items.set('r1', { id: 'r1', state: 'scoped', scoping: { turns: [{ role: 'user', text: 'scope this' }] } })
  const store = {
    get: (id) => items.get(id) ?? null,
    update(id, patch) { const cur = items.get(id); if (!cur) return null; Object.assign(cur, patch); return cur },
    transition() {},
    all: () => [...items.values()],
  }
  const cwd = dir()
  const s = SC.createScoper({
    store, broadcast: () => {}, spawn: fakeChildSpawn(calls),
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    spend: { record: (r) => got.push(r) },
  })

  const bankPromise = s.bank('r1', cwd)
  calls[0].child.emit(JSON.stringify({ ...frame, structured_output: { goal: 'build the thing' } }) + '\n')
  calls[0].child.finish(0)
  const out = await bankPromise
  assert.equal(out.ok, true, out.error)
  assert.equal(got.length, 1)
  assert.equal(got[0].kind, 'scoping')
  assert.equal(got[0].site, 'bank')
  assert.equal(got[0].usd, 0.0125)

  const missing = await s.bank('r1', join(cwd, 'does-not-exist'))
  assert.equal(missing.ok, false)
  assert.equal(got.length, 1, 'a missing cwd spawns no child and records nothing')
})

// A tiny real node script standing in for `claude`, the same trick
// test/chain-harness.mjs uses for the refiner.
const fakeDir = mkdtempSync(join(tmpdir(), 'szg-spend-fake-'))
let fakeSeq = 0
const fakeScript = (src) => {
  const p = join(fakeDir, `fake-${fakeSeq++}.mjs`)
  writeFileSync(p, src)
  return p
}
const printing = (obj) => fakeScript(`process.stdout.write(${JSON.stringify(JSON.stringify(obj) + '\n')})\n`)
const fakeRun = (scriptFor) => (bin, argv, opts) => spawn(process.execPath, [scriptFor()], opts)

await ok('createChains records the refiner\'s spend on a real refine, and nothing when the spawn throws', async () => {
  const got = []
  const T = 1_700_000_000_000
  const turnFor = (over = {}) => ({
    id: 't1', at: T, durationMs: 500, reason: 'ok', origin: 'typed',
    promptHead: 'Rewrite the relay so the pane stops flickering', answerHead: 'Done, fixed the flicker',
    files: ['/a/relay.mjs'], tools: 1, subturns: 0,
    ...over,
  })

  let script = ''
  const store = CH.createChains({ dir: dir(), now: () => T, run: fakeRun(() => script), spend: { record: (r) => got.push(r) } })
  store.turn('s1', turnFor())
  const openId = store.get('s1').blocks.find((b) => b.state === 'open').id
  script = printing({
    type: 'result',
    result: { blocks: [{ id: openId, title: 'Relay flicker', summary: 'Fixed the redraw.' }], progress: 'done' },
    total_cost_usd: 0.012,
  })
  const r = await store.refine('s1')
  assert.equal(r.ok, true, r.error)
  assert.equal(got.length, 1)
  assert.equal(got[0].kind, 'chain')
  assert.equal(got[0].site, 'refine')
  assert.equal(got[0].usd, store.get('s1').refiner.spentUsd)

  const store2 = CH.createChains({ dir: dir(), now: () => T, run: () => { throw new Error('boom') }, spend: { record: (r) => got.push(r) } })
  store2.turn('s2', turnFor({ id: 't2' }))
  const r2 = await store2.refine('s2')
  assert.equal(r2.ok, false)
  assert.equal(got.length, 1, 'a spawn that throws records nothing')
})

// ---- the live relay ----------------------------------------------------
// The snapshot key, the event, the two routes and the gate are things only a
// real relay process does. Isolated on every axis: SZG_PORT=0 (OS-assigned),
// a temp SZG_DATA_DIR and SZG_HUD_CONFIG, and SZG_CLAUDE_BIN a fake that
// refuses everything, so no real `claude` runs. The password is left
// unconfigured rather than disabled, so a read with no token is refused.
{
  const http = await import('node:http')
  const { chmodSync } = await import('node:fs')
  const TMP = mkdtempSync(join(tmpdir(), 'szg-spend-relay-'))
  const DATA = join(TMP, 'data')
  const FAKE = join(TMP, 'claude')
  writeFileSync(FAKE, '#!/bin/sh\nexit 1\n')
  chmodSync(FAKE, 0o755)
  const TOKEN = 'spend-harness-' + Math.random().toString(36).slice(2)
  // Every inherited SZG_* key is dropped: a harness run from inside a live
  // session must not hand the child that session's relay or data dir.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SZG_')))

  const boot = () => new Promise((resolveBoot, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'syzygy', 'bridge', 'relay.mjs')], {
      cwd: ROOT,
      env: {
        ...inherited, SZG_PORT: '0', SZG_TOKEN: TOKEN, SZG_DATA_DIR: DATA, SZG_HUD_CONFIG: join(TMP, 'hud.json'),
        SZG_CLAUDE_BIN: FAKE, SZG_TMUX_BIN: '/usr/bin/false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stderr.on('data', (c) => { err += c })
    const timer = setTimeout(() => reject(new Error('relay did not report a port in time')), 8000)
    const onData = (chunk) => {
      out += chunk
      const m = out.match(/relay on http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { clearTimeout(timer); child.stdout.off('data', onData); resolveBoot({ child, port: Number(m[1]) }) }
    }
    child.stdout.on('data', onData)
    child.on('error', reject)
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`relay exited early with code ${code}; stderr: ${err}`)) })
  })
  const stop = async (child) => {
    if (child.exitCode !== null) return
    const gone = new Promise((r) => { child.once('exit', r); setTimeout(r, 3000) })
    child.kill('SIGTERM')
    await gone
  }

  let relay = null
  try {
    relay = await boot()
    const base = () => `http://127.0.0.1:${relay.port}`
    const getJson = async (path, headers = { 'x-mch-token': TOKEN }, method = 'GET') => {
      const res = await fetch(base() + path, { method, headers })
      return { status: res.status, body: method === 'HEAD' ? null : await res.json().catch(() => null) }
    }
    const post = async (path, body, headers = { 'x-mch-token': TOKEN }) => {
      const res = await fetch(base() + path, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const state = async () => (await getJson('/api/state')).body

    await ok('the relay stamps a payload version that carries spend', async () => {
      const h = await getJson('/api/health')
      assert.equal(h.status, 200)
      assert.ok(h.body.payloadVersion >= 18, `payloadVersion was ${h.body.payloadVersion}`)
    })

    await ok('a fresh relay reports an empty spend digest in the snapshot', async () => {
      const s = await state()
      assert.ok(s.spend, 'the snapshot carries spend')
      assert.equal(s.spend.all.calls, 0)
      assert.equal(s.spend.since, null)
    })

    await ok('POST /api/spend needs the token, records a band call, and refuses an array', async () => {
      const band = { kind: 'band', site: 'narrate', model: 'haiku', usage: { input: 10, output: 5 }, estimated: true }
      assert.equal((await post('/api/spend', band, {})).status, 401)
      const r = await post('/api/spend', band)
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, { ok: true })
      const s = await state()
      assert.equal(s.spend.all.calls, 1)
      assert.equal(s.spend.all.byKind.band.tokens, 15)
      assert.equal(s.spend.estimatedShare, 1)
      assert.equal((await post('/api/spend', [band])).status, 400)
      assert.equal((await state()).spend.all.calls, 1, 'a refused body records nothing')
    })

    await ok('an open stream receives a spend event carrying the new digest', async () => {
      const frame = await new Promise((resolveFrame, reject) => {
        let buf = '', posted = false
        const req = http.get(`${base()}/api/stream?token=${TOKEN}`, (res) => {
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            buf += chunk
            // The stream is registered by the time its first bytes arrive, so
            // the second call is made only after that.
            if (!posted) { posted = true; post('/api/spend', { kind: 'chain', site: 'refine', usd: 0.01 }).catch(reject) }
            let at
            while ((at = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, at)
              buf = buf.slice(at + 2)
              if (block.startsWith('event: spend\n')) {
                clearTimeout(timer)
                req.destroy()
                resolveFrame(JSON.parse(block.slice(block.indexOf('data: ') + 6)))
                return
              }
            }
          })
        })
        req.on('error', (e) => { if (!req.destroyed) reject(e) })
        const timer = setTimeout(() => { req.destroy(); reject(new Error('no spend event within 3 s')) }, 3000)
      })
      assert.equal(frame.all.calls, 2)
    })

    await ok('GET /api/spend pages newest first, filters by kind, answers HEAD, and refuses no token', async () => {
      const first = await getJson(`/api/spend?token=${TOKEN}&limit=1`, {})
      assert.equal(first.status, 200)
      assert.equal(first.body.items.length, 1)
      assert.equal(first.body.items[0].kind, 'chain')
      assert.notEqual(first.body.next, null)
      const older = await getJson(`/api/spend?token=${TOKEN}&limit=1&before=${first.body.next}`, {})
      assert.equal(older.body.items.length, 1)
      assert.equal(older.body.items[0].kind, 'band')
      assert.ok(older.body.items[0].t < first.body.items[0].t)
      const band = await getJson(`/api/spend?token=${TOKEN}&kind=band`, {})
      assert.equal(band.body.items.length, 1)
      assert.ok(band.body.items.every((r) => r.kind === 'band'))
      assert.equal((await getJson(`/api/spend?token=${TOKEN}`, {}, 'HEAD')).status, 200)
      assert.equal((await fetch(base() + '/api/spend')).status, 401)
    })

    await ok('POST /api/spend refuses a body with no kind, and records an unknown kind as other', async () => {
      const before = (await state()).spend.all.calls
      for (const bad of [{}, { kind: '' }, { site: 'narrate' }, null, 7, 'band']) {
        const r = await post('/api/spend', bad)
        assert.equal(r.status, 400, `${JSON.stringify(bad)} was not refused`)
        assert.equal(r.body.error, 'a spend record must be an object with a kind')
      }
      assert.equal((await state()).spend.all.calls, before, 'a refused body records nothing')
      const r = await post('/api/spend', { kind: 'mystery', site: 'probe' })
      assert.equal(r.status, 200)
      const s = (await state()).spend
      assert.equal(s.all.calls, before + 1)
      assert.equal(s.all.byKind.other.calls, 1)
      const newest = (await getJson(`/api/spend?token=${TOKEN}&limit=1`, {})).body.items[0]
      assert.equal(newest.kind, 'other')
      assert.equal(newest.site, 'probe')
    })

    await ok('a relay restarted on the same data dir reports the same calls', async () => {
      await stop(relay.child)
      relay = await boot()
      assert.equal((await state()).spend.all.calls, 3)
    })
  } finally {
    if (relay) await stop(relay.child)
  }
}

console.log(`\n${pass} checks passed`)
