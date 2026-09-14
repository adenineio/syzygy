#!/usr/bin/env node
// Drives bridge/skills-queue.mjs against a temp directory, then, once they
// exist, its routes against a real relay subprocess and the pane module in
// an empty vm context. Hermetic: no network in this half, and no ~/.claude
// anywhere -- SZG_DATA_DIR points the relay at a temp directory, exactly as
// test/canvas-harness.mjs does.
//
// Run: node test/skills-queue-harness.mjs   (or `just test-skills-queue`)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const M = await import(join(ROOT, 'syzygy', 'bridge', 'skills-queue.mjs'))
const {
  createSkillsQueue, readProposals, sanitizeProposal, normalizeKey,
  nextMark, prevMark, MARKS, PROPOSALS_MAX, MARK_HISTORY_MAX, SEEN_MAX,
  TITLE_MAX, TEXT_MAX,
} = M

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }
const dir = () => mkdtempSync(join(tmpdir(), 'szg-skills-'))
const fresh = (now = () => 1_700_000_000_000) => {
  const file = join(dir(), 'skills-queue.json')
  return { file, store: createSkillsQueue({ file, now }) }
}
const writeUp = (over = {}) => ({
  kind: 'skill',
  title: 'Pure core, injected runner, harness under node',
  idea: 'Anything that decides is pure and exported; anything that performs takes its runner as a parameter.',
  methodology: '1. Name the decision. 2. Move it into a pure exported function. 3. Inject the runner.',
  evidence: ['syzygy/bridge/fleet.mjs:226'],
  sessions: ['fleet-broadcast'],
  ...over,
})

console.log('skills-queue harness')

await ok('an ingested proposal carries every field the panes read', async () => {
  const { store } = fresh()
  const r = store.ingest(writeUp(), { source: 'pass' })
  assert.equal(r.ok, true)
  assert.equal(r.merged, false)
  const p = r.proposal
  assert.match(p.id, /^[a-z0-9]+$/)
  assert.equal(p.key, normalizeKey(writeUp().title))
  assert.equal(p.kind, 'skill')
  assert.equal(p.mark, '')
  assert.deepEqual(p.marks, [])
  assert.deepEqual(p.seen, [{ at: 1_700_000_000_000, source: 'pass' }])
  assert.equal(p.requestId, null)
  assert.equal(p.source, 'pass')
  assert.equal(p.createdAt, 1_700_000_000_000)
  assert.equal(p.updatedAt, 1_700_000_000_000)
})

await ok('the three write-up fields are required and a missing one is dropped', async () => {
  for (const field of ['title', 'idea', 'methodology']) {
    assert.equal(sanitizeProposal({ ...writeUp(), [field]: '' }), null, field)
    assert.equal(sanitizeProposal({ ...writeUp(), [field]: undefined }), null, field)
  }
  // evidence is NOT required by the store: a hand edit and an older writer
  // both reach it, and the writers are where specificity is free.
  assert.ok(sanitizeProposal({ ...writeUp(), evidence: [], t: 1 }))
})

await ok('id and both timestamps are the relay\'s, never the caller\'s', async () => {
  const { store } = fresh()
  const r = store.ingest({ ...writeUp(), id: 'forged', createdAt: 1, updatedAt: 2 }, { source: 'human' })
  assert.notEqual(r.proposal.id, 'forged')
  assert.equal(r.proposal.createdAt, 1_700_000_000_000)
})

await ok('an unrecognised kind sanitises to the empty string, never to a real kind', async () => {
  const p = sanitizeProposal({ ...writeUp(), kind: 'skil' })
  assert.equal(p.kind, '')
})

await ok('an unrecognised source sanitises to human rather than to pass', async () => {
  const { store } = fresh()
  const r = store.ingest(writeUp(), { source: 'nonsense' })
  assert.equal(r.proposal.source, 'human')
})

await ok('per-field caps hold', async () => {
  const p = sanitizeProposal({
    ...writeUp(),
    title: 'x'.repeat(TITLE_MAX + 50),
    idea: 'y'.repeat(TEXT_MAX + 50),
    evidence: Array.from({ length: 40 }, (_, i) => 'f.mjs:' + i),
  })
  assert.equal(p.title.length, TITLE_MAX)
  assert.equal(p.idea.length, TEXT_MAX)
  assert.equal(p.evidence.length, 20)
})

await ok('the mark cycle runs none -> good -> near -> potential -> none, both ways', async () => {
  assert.equal(nextMark(''), 'good')
  assert.equal(nextMark('good'), 'near')
  assert.equal(nextMark('near'), 'potential')
  assert.equal(nextMark('potential'), '')
  assert.equal(prevMark(''), 'potential')
  assert.equal(prevMark('good'), '')
  assert.deepEqual(MARKS, ['good', 'near', 'potential'])
  // an unknown value cycles to the FIRST mark rather than throwing
  assert.equal(nextMark('rubbish'), 'good')
})

await ok('a mark appends history, and a clear appends it too', async () => {
  let t = 1_700_000_000_000
  const { store } = fresh(() => t)
  const id = store.ingest(writeUp(), { source: 'pass' }).proposal.id
  t += 1000
  store.mark(id, { mark: 'good' })
  t += 1000
  store.mark(id, { mark: '' })
  const p = store.get(id)
  assert.equal(p.mark, '')
  assert.deepEqual(p.marks.map((m) => m.mark), ['good', ''])
  assert.equal(p.marks[1].at, 1_700_000_002_000)
})

await ok('cycle:true steps forward and cycle:back steps back', async () => {
  const { store } = fresh()
  const id = store.ingest(writeUp(), { source: 'pass' }).proposal.id
  assert.equal(store.mark(id, { cycle: true }).proposal.mark, 'good')
  assert.equal(store.mark(id, { cycle: true }).proposal.mark, 'near')
  assert.equal(store.mark(id, { cycle: 'back' }).proposal.mark, 'good')
})

await ok('re-ingesting the same title merges: seen grows, evidence unions, nothing duplicates', async () => {
  let t = 1_700_000_000_000
  const { store } = fresh(() => t)
  store.ingest(writeUp(), { source: 'pass' })
  t += 1000
  const r = store.ingest(writeUp({
    title: '  Pure CORE, injected runner -- harness under node!  ',
    evidence: ['syzygy/bridge/canvas.mjs:249'],
    sessions: ['canvas-plus-column'],
  }), { source: 'pass' })
  assert.equal(r.merged, true)
  assert.equal(store.all().length, 1)
  const p = store.all()[0]
  assert.equal(p.seen.length, 2)
  assert.deepEqual(p.evidence, ['syzygy/bridge/fleet.mjs:226', 'syzygy/bridge/canvas.mjs:249'])
  assert.deepEqual(p.sessions, ['fleet-broadcast', 'canvas-plus-column'])
})

await ok('a merge refreshes the text while unrated and FREEZES it once marked', async () => {
  const { store } = fresh()
  const id = store.ingest(writeUp(), { source: 'pass' }).proposal.id
  store.ingest(writeUp({ idea: 'a better wording' }), { source: 'pass' })
  assert.equal(store.get(id).idea, 'a better wording')
  store.mark(id, { mark: 'good' })
  store.ingest(writeUp({ idea: 'a third wording' }), { source: 'pass' })
  assert.equal(store.get(id).idea, 'a better wording')
  assert.equal(store.get(id).seen.length, 3)
})

await ok('a prepped-but-unmarked proposal is frozen too', async () => {
  const { store } = fresh()
  const id = store.ingest(writeUp(), { source: 'pass' }).proposal.id
  store.prep(id, { requestId: 'req1' })
  store.ingest(writeUp({ methodology: 'rewritten' }), { source: 'pass' })
  assert.notEqual(store.get(id).methodology, 'rewritten')
  assert.equal(store.get(id).requestId, 'req1')
})

await ok('prep refuses twice for the same proposal', async () => {
  const { store } = fresh()
  const id = store.ingest(writeUp(), { source: 'pass' }).proposal.id
  assert.equal(store.prep(id, { requestId: 'req1' }).ok, true)
  const again = store.prep(id, { requestId: 'req2' })
  assert.equal(again.ok, false)
  assert.match(again.error, /already/)
})

await ok('prep does not change the mark', async () => {
  const { store } = fresh()
  const id = store.ingest(writeUp(), { source: 'pass' }).proposal.id
  store.prep(id, { requestId: 'req1' })
  assert.equal(store.get(id).mark, '')
})

await ok('at the cap an UNMARKED unprepped proposal is evicted, oldest first', async () => {
  let t = 1_700_000_000_000
  const { store } = fresh(() => t)
  for (let i = 0; i < PROPOSALS_MAX; i++) { t += 10; store.ingest(writeUp({ title: 'p' + i }), { source: 'pass' }) }
  const oldest = store.all()[0].title
  t += 10
  assert.equal(store.ingest(writeUp({ title: 'the newcomer' }), { source: 'pass' }).ok, true)
  assert.equal(store.all().length, PROPOSALS_MAX)
  assert.ok(!store.all().some((p) => p.title === oldest))
})

await ok('at the cap with every proposal marked, the add REFUSES rather than discarding one', async () => {
  let t = 1_700_000_000_000
  const { store } = fresh(() => t)
  for (let i = 0; i < PROPOSALS_MAX; i++) {
    t += 10
    const id = store.ingest(writeUp({ title: 'p' + i }), { source: 'pass' }).proposal.id
    store.mark(id, { mark: 'potential' })
  }
  const r = store.ingest(writeUp({ title: 'the newcomer' }), { source: 'pass' })
  assert.equal(r.ok, false)
  assert.match(r.error, new RegExp(String(PROPOSALS_MAX)))
  assert.equal(store.all().length, PROPOSALS_MAX)
})

await ok('marks and seen histories are capped', async () => {
  let t = 1_700_000_000_000
  const { store } = fresh(() => t)
  const id = store.ingest(writeUp(), { source: 'pass' }).proposal.id
  for (let i = 0; i < MARK_HISTORY_MAX + 10; i++) { t += 10; store.mark(id, { cycle: true }) }
  for (let i = 0; i < SEEN_MAX + 10; i++) { t += 10; store.ingest(writeUp(), { source: 'pass' }) }
  assert.equal(store.get(id).marks.length, MARK_HISTORY_MAX)
  assert.equal(store.get(id).seen.length, SEEN_MAX)
})

await ok('there is no delete verb on the store', async () => {
  const { store } = fresh()
  assert.equal(typeof store.remove, 'undefined')
  assert.equal(typeof store.delete, 'undefined')
})

await ok('a failed write leaves the previous file byte-identical and the store unchanged', async () => {
  const { file, store } = fresh()
  store.ingest(writeUp({ title: 'first' }), { source: 'pass' })
  const before = readFileSync(file, 'utf8')
  const d = dirname(file)
  chmodSync(d, 0o500)                 // read+execute only: the temp file cannot be written
  try {
    assert.throws(() => store.ingest(writeUp({ title: 'boom' }), { source: 'pass' }))
  } finally {
    chmodSync(d, 0o700)
  }
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.ok(!store.all().some((p) => p.title === 'boom'))
  assert.equal(store.ingest(writeUp({ title: 'after' }), { source: 'pass' }).ok, true)
})

await ok('a caller\'s unknown fields never reach the file', async () => {
  const { file, store } = fresh()
  store.ingest({ ...writeUp(), token: 'the-shared-token', self: 'x' }, { source: 'session' })
  assert.ok(!readFileSync(file, 'utf8').includes('the-shared-token'))
})

await ok('a corrupt file is moved aside, reported, and never overwritten', async () => {
  const d = dir()
  const file = join(d, 'skills-queue.json')
  writeFileSync(file, '{ this is not json')
  const store = createSkillsQueue({ file, now: () => 1_700_000_000_000 })
  assert.deepEqual(store.all(), [])
  store.ingest(writeUp(), { source: 'pass' })
  const aside = readdirSync(d).find((f) => f.includes('.corrupt-'))
  assert.ok(aside, 'the unparseable file was moved aside')
  assert.equal(readFileSync(join(d, aside), 'utf8'), '{ this is not json')
})

await ok('readProposals drops what it cannot use rather than throwing', async () => {
  const d = dir()
  const file = join(d, 'skills-queue.json')
  writeFileSync(file, JSON.stringify({ version: 1, proposals: [
    null, 42, 'nope', { title: 'no idea' },
    { ...writeUp(), createdAt: 1, updatedAt: 1 },            // no id: it could never be marked
    { ...writeUp(), id: 'a', createdAt: 1, updatedAt: 1, key: 'k' },
  ] }))
  const out = readProposals(file)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'a')
  // the key is derived from the title, never trusted from the file
  assert.equal(out[0].key, normalizeKey(writeUp().title))
})

await ok('the last pass attempt persists across a restart', async () => {
  const { file, store } = fresh()
  assert.equal(store.lastPassAt(), 0)
  store.recordPass(1_700_000_123_000)
  const again = createSkillsQueue({ file, now: () => 1_700_000_200_000 })
  assert.equal(again.lastPassAt(), 1_700_000_123_000)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pass.at, 1_700_000_123_000)
})

await ok('the pass day spend accumulates, starts over on a new day, and persists across a restart', async () => {
  const { sanitizePassSpend, localDay } = M
  const DAY = localDay(new Date(2026, 8, 13, 12).getTime())
  const NEXT = localDay(new Date(2026, 8, 14, 12).getTime())
  assert.match(localDay(1_700_000_000_000), /^\d{4}-\d{2}-\d{2}$/)
  const { file, store } = fresh()
  assert.deepEqual(store.passSpend(), { day: '', usd: 0 })
  store.recordPassSpend(0.4, DAY)
  const r = store.recordPassSpend(0.25, DAY)
  assert.equal(r.day, DAY)
  assert.ok(Math.abs(r.usd - 0.65) < 1e-9)
  store.recordPass(1_700_000_123_000)
  const again = createSkillsQueue({ file, now: () => 1_700_000_200_000 })
  assert.ok(Math.abs(again.passSpend().usd - 0.65) < 1e-9, 'recordPass keeps the spend, and a restart reads it back')
  assert.equal(again.lastPassAt(), 1_700_000_123_000)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).passSpend.day, DAY)
  assert.deepEqual(again.recordPassSpend(0.1, NEXT), { day: NEXT, usd: 0.1 })
  assert.deepEqual(again.recordPassSpend(-1, NEXT), { day: NEXT, usd: 0.1 }, 'a negative figure adds nothing')
  assert.deepEqual(again.recordPassSpend(Number.NaN, NEXT), { day: NEXT, usd: 0.1 })
  again.passSpend().usd = 99
  assert.equal(again.passSpend().usd, 0.1, 'the reading is a copy')
  assert.deepEqual(sanitizePassSpend(undefined), { day: '', usd: 0 })
})

await ok('a malformed or missing pass spend reads as nothing spent', async () => {
  const DAY = M.localDay(new Date(2026, 8, 13, 12).getTime())
  for (const passSpend of [{ day: 'yesterday', usd: 5 }, { day: DAY, usd: -3 }, 'x', null, undefined]) {
    const d = dir()
    const file = join(d, 'skills-queue.json')
    writeFileSync(file, JSON.stringify({ version: 1, proposals: [], pass: { at: 1 }, passSpend }))
    const store = createSkillsQueue({ file, now: () => 1_700_000_000_000 })
    const got = store.passSpend()
    assert.equal(got.usd, 0, `usd from ${JSON.stringify(passSpend)}`)
    if (passSpend?.day !== DAY) assert.equal(got.day, '')
    assert.ok(!readdirSync(d).some((f) => f.includes('.corrupt-')), 'a bad spend value never moves the file aside')
  }
})

await ok('titles() answers what the pass must not re-propose', async () => {
  const { store } = fresh()
  store.ingest(writeUp({ title: 'one' }), { source: 'pass' })
  store.ingest(writeUp({ title: 'two' }), { source: 'pass' })
  assert.deepEqual(store.titles(), ['one', 'two'])
})

const {
  passGate, passTurnText, parseProposals, prepBrief, PATTERN_PREAMBLE,
  PASS_MIN_MS, PASS_MIN_CAPTURE, PASS_MIN_FINDINGS, PASS_BUDGET_BYTES,
  PASS_MAX_PROPOSALS,
} = M

const NOW = 1_700_000_000_000

await ok('the gate refuses inside the floor, naming the wait', async () => {
  const g = passGate({ lastPassAt: NOW - 60_000, newCapture: 999, newFindings: 99, now: NOW })
  assert.equal(g.ok, false)
  assert.match(g.reason, /\d+ h/)
})

await ok('the gate refuses on thin material, naming what it counted', async () => {
  const g = passGate({ lastPassAt: NOW - PASS_MIN_MS - 1, newCapture: 3, newFindings: 0, now: NOW })
  assert.equal(g.ok, false)
  assert.match(g.reason, /3/)
})

await ok('enough capture alone opens the gate, and enough findings alone do too', async () => {
  const base = { lastPassAt: NOW - PASS_MIN_MS - 1, now: NOW }
  assert.equal(passGate({ ...base, newCapture: PASS_MIN_CAPTURE, newFindings: 0 }).ok, true)
  assert.equal(passGate({ ...base, newCapture: 0, newFindings: PASS_MIN_FINDINGS }).ok, true)
})

await ok('a never-run pass is not held back by the floor', async () => {
  const g = passGate({ lastPassAt: 0, newCapture: PASS_MIN_CAPTURE, newFindings: 0, now: NOW })
  assert.equal(g.ok, true)
  assert.equal(g.reason, '')
})

await ok('the turn text carries both sections, the existing titles, and nothing else', async () => {
  const text = passTurnText({
    capture: [{ t: NOW, kind: 'link', actor: 'alpha' }, { t: NOW, kind: 'dispatch', actor: 'beta' }],
    findings: [{ t: NOW, kind: 'constraint', session: 'alpha', surprise: 'the flag binds', evidence: ['a.mjs:1'] }],
    titles: ['already proposed'],
  })
  assert.match(text, /## Recent activity/)
  assert.match(text, /## Findings/)
  assert.match(text, /## Already proposed/)
  assert.match(text, /already proposed/)
  assert.match(text, /link/)
  assert.match(text, /the flag binds/)
})

await ok('the turn text stays inside its budget and says what it dropped', async () => {
  const capture = Array.from({ length: 4000 }, (_, i) => ({ t: NOW + i, kind: 'spawn', actor: 'session-' + i }))
  const text = passTurnText({ capture, findings: [], titles: [] })
  assert.ok(Buffer.byteLength(text, 'utf8') <= PASS_BUDGET_BYTES, 'inside the budget')
  assert.match(text, /omitted \(budget\)/)
})

await ok('a real fenced block parses, and the fence itself is not in the text', async () => {
  const reply = [
    'Three sessions did the same thing this week.',
    '',
    '```json',
    JSON.stringify({ proposals: [{
      kind: 'skill',
      title: 'Pure core, injected runner',
      idea: 'split deciding from performing',
      methodology: '1. name it 2. export it 3. inject the runner',
      evidence: ['syzygy/bridge/fleet.mjs:226'],
      sessions: ['fleet-broadcast'],
    }] }),
    '```',
  ].join('\n')
  const { proposals, rejected } = parseProposals(reply)
  assert.equal(proposals.length, 1)
  assert.equal(rejected.length, 0)
  assert.equal(proposals[0].title, 'Pure core, injected runner')
})

await ok('a reply with no fence yields nothing and throws nothing', async () => {
  const out = parseProposals('I looked and found no repeated pattern worth a skill.')
  assert.deepEqual(out.proposals, [])
  assert.deepEqual(out.rejected, [])
})

await ok('a malformed fence yields nothing and throws nothing', async () => {
  const out = parseProposals('```json\n{ not json at all\n```')
  assert.deepEqual(out.proposals, [])
})

await ok('an entry missing methodology is rejected with a reason, never filed', async () => {
  const body = { proposals: [{ kind: 'skill', title: 't', idea: 'i', evidence: ['a.mjs:1'] }] }
  const { proposals, rejected } = parseProposals('```json\n' + JSON.stringify(body) + '\n```')
  assert.equal(proposals.length, 0)
  assert.equal(rejected.length, 1)
  assert.match(rejected[0].why, /methodology/)
})

await ok('an entry with no evidence is rejected AT THE PARSER', async () => {
  const body = { proposals: [{ kind: 'skill', title: 't', idea: 'i', methodology: 'm', evidence: [] }] }
  const { proposals, rejected } = parseProposals('```json\n' + JSON.stringify(body) + '\n```')
  assert.equal(proposals.length, 0)
  assert.match(rejected[0].why, /evidence/)
})

await ok('a kind typo survives as unclassified rather than becoming a real kind', async () => {
  const body = { proposals: [{ kind: 'skil', title: 't', idea: 'i', methodology: 'm', evidence: ['a.mjs:1'] }] }
  const { proposals } = parseProposals('```json\n' + JSON.stringify(body) + '\n```')
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0].kind, '')
})

await ok('the parser never returns more than the per-pass ceiling', async () => {
  const one = (i) => ({ kind: 'skill', title: 't' + i, idea: 'i', methodology: 'm', evidence: ['a.mjs:1'] })
  const body = { proposals: Array.from({ length: PASS_MAX_PROPOSALS + 4 }, (_, i) => one(i)) }
  const { proposals } = parseProposals('```json\n' + JSON.stringify(body) + '\n```')
  assert.equal(proposals.length, PASS_MAX_PROPOSALS)
})

await ok('the preamble says the pass proposes, and shows the reply shape', async () => {
  assert.match(PATTERN_PREAMBLE, /propose/i)
  assert.match(PATTERN_PREAMBLE, /never/i)
  assert.ok(PATTERN_PREAMBLE.includes('"proposals"'), 'it shows the reply shape')
})

await ok('prepBrief is the write-up, field by field', async () => {
  const proposal = {
    id: 'p1', kind: 'skill',
    title: 'Pure core, injected runner',
    idea: 'Split deciding from performing.',
    methodology: '1. Name the decision.\n2. Export it pure.\n3. Inject the runner.',
    evidence: ['syzygy/bridge/fleet.mjs:226', 'syzygy/bridge/canvas.mjs:249'],
    sessions: ['fleet-broadcast'],
  }
  const out = prepBrief(proposal)
  assert.equal(out.title, 'Pure core, injected runner')
  assert.equal(out.ask, 'Split deciding from performing.')
  assert.equal(out.brief.goal, 'Split deciding from performing.')
  assert.deepEqual(out.brief.constraints, [
    '1. Name the decision.', '2. Export it pure.', '3. Inject the runner.',
  ])
  assert.deepEqual(out.brief.research.files, [
    'syzygy/bridge/fleet.mjs:226', 'syzygy/bridge/canvas.mjs:249',
  ])
  assert.deepEqual(out.brief.research.context7, [])
  assert.deepEqual(out.brief.research.urls, [])
  assert.equal(out.brief.successCriteria.length, 1)
  assert.match(out.brief.successCriteria[0], /invoked by its description/)
  assert.deepEqual(out.brief.nonGoals, [])
  assert.deepEqual(out.brief.openQuestions, [])
})

await ok('prepBrief never begins its ask with a dash', async () => {
  const out = prepBrief({ title: 't', idea: '--force everywhere', methodology: 'm', evidence: [] })
  assert.ok(!out.ask.startsWith('-'))
})

// ---- the four routes: a real relay, a fake `claude` ----------------------
// The routes live in relay.mjs's HTTP handler, so they are tested against the
// REAL relay, in test/fleet-harness.mjs's own shape (inline, not an
// importable helper): SZG_PORT=0 (OS-assigned), SZG_DATA_DIR a throwaway
// directory, and SZG_CLAUDE_BIN a fake that answers --help like a capable
// `claude`. SZG_PANE_PASSWORD_DISABLED is deliberately NOT set -- with it set
// an unauthenticated GET answers 200 and the first check below could not
// pass -- so every read here carries the token as a query param too.
{
  const { spawn } = await import('node:child_process')
  const { rmSync } = await import('node:fs')
  const dataDir = dir()
  const fakeDir = dir()

  // One valid proposal -- kind, title, idea, methodology, evidence -- is the
  // pass's whole reply, shaped like test/fixtures/orchestrator-stream-sample.
  // ndjson: a system frame, one streamed text delta carrying the fenced
  // block, then a result frame. Written to its own node script rather than
  // built inline in the shell wrapper below, so the fence's own backticks
  // never have to survive a layer of shell quoting.
  const passReplyText = 'Found one repeated pattern.\n\n```json\n' + JSON.stringify({
    proposals: [{
      kind: 'skill',
      title: 'Fake pattern-pass proposal',
      idea: 'the same fix keeps getting redone by hand across sessions',
      methodology: '1. notice the repeat. 2. write it up.',
      evidence: ['a.mjs:1'],
    }],
  }) + '\n```\n'
  const passFrames = [
    { type: 'system', subtype: 'init', session_id: 'fake-pass-session' },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: passReplyText } } },
    { type: 'result', subtype: 'success', is_error: false, result: passReplyText },
  ]
  const passScript = join(fakeDir, 'pass-frames.mjs')
  writeFileSync(passScript, passFrames.map((f) => `process.stdout.write(${JSON.stringify(JSON.stringify(f))} + "\\n")`).join('\n') + '\n')

  const fakeBin = join(fakeDir, 'claude')
  writeFileSync(fakeBin, [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "  --bg   run in the background"; echo "  attach   attach to a session"; exit 0; fi',
    'if [ "$1" = "--version" ]; then echo "0.0.0-fake (skills-queue harness)"; exit 0; fi',
    'if [ "$1" = "agents" ]; then echo "[]"; exit 0; fi',
    'if [ "$1" = "-p" ]; then exec "' + process.execPath + '" "' + passScript + '"; fi',
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(fakeBin, 0o755)

  const RELAY_TOKEN = 'skills-queue-harness-token'
  const child = spawn(process.execPath, [join(ROOT, 'syzygy', 'bridge', 'relay.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, SZG_PORT: '0', SZG_TOKEN: RELAY_TOKEN, SZG_DATA_DIR: dataDir, SZG_CLAUDE_BIN: fakeBin,
      SZG_TMUX_BIN: '/usr/bin/false', SZG_SPAWN_PLUGIN_DIR: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderrText = ''
  child.stderr.on('data', (c) => { stderrText += c })

  try {
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
      setTimeout(() => reject(new Error('relay did not report a port in time')), 8000).unref()
    })
    const base = `http://127.0.0.1:${port}`
    const get = async (path) => {
      const sep = path.includes('?') ? '&' : '?'
      const r = await fetch(base + path + sep + 'token=' + RELAY_TOKEN)
      const body = await r.json().catch(() => ({}))
      return { status: r.status, body }
    }
    const post = async (path, obj = {}) => {
      const r = await fetch(base + path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: RELAY_TOKEN, ...obj }),
      })
      const body = await r.json().catch(() => ({}))
      return { status: r.status, body }
    }

    await ok('every skills route refuses without the token', async () => {
      for (const p of ['/api/skills', '/api/skills/propose', '/api/skills/mark', '/api/skills/prep', '/api/skills/pass']) {
        const r = await fetch(base + p, { method: p === '/api/skills' ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: p === '/api/skills' ? undefined : '{}' })
        assert.equal(r.status, 401, p)
      }
    })

    await ok('propose files a write-up and broadcasts the bounded list', async () => {
      const r = await post('/api/skills/propose', writeUp())
      assert.equal(r.status, 200)
      assert.equal(r.body.proposal.title, writeUp().title)
      const got = await get('/api/skills')
      assert.equal(got.body.proposals.length, 1)
    })

    await ok('propose refuses a flag rather than a write-up', async () => {
      const r = await post('/api/skills/propose', { title: 'only a title' })
      assert.equal(r.status, 400)
      assert.match(r.body.error, /idea|methodology/)
    })

    await ok('mark cycles on the relay, and the pane need not know the order', async () => {
      const id = (await post('/api/skills/propose', writeUp({ title: 'to rate' }))).body.proposal.id
      assert.equal((await post('/api/skills/mark', { id, cycle: true })).body.proposal.mark, 'good')
      assert.equal((await post('/api/skills/mark', { id, cycle: 'back' })).body.proposal.mark, '')
      assert.equal((await post('/api/skills/mark', { id, mark: 'potential' })).body.proposal.mark, 'potential')
      assert.equal((await post('/api/skills/mark', { id, mark: 'nonsense' })).status, 400)
      assert.equal((await post('/api/skills/mark', { id: 'nope', cycle: true })).status, 404)
    })

    await ok('prep creates a real request from the write-up and links it back', async () => {
      const id = (await post('/api/skills/propose', writeUp({ title: 'to prep' }))).body.proposal.id
      const r = await post('/api/skills/prep', { id })
      assert.equal(r.status, 200)
      const reqId = r.body.request.id
      assert.equal(r.body.proposal.requestId, reqId)
      assert.equal(r.body.request.state, 'draft')
      assert.equal(r.body.request.title, 'to prep')
      assert.equal(r.body.request.brief.goal, writeUp().idea)
      const state = await get('/api/state')
      assert.ok(state.body.dispatch.requests.some((q) => q.id === reqId))
    })

    await ok('prep with queue:true leaves the request queued', async () => {
      const id = (await post('/api/skills/propose', writeUp({ title: 'to queue' }))).body.proposal.id
      const r = await post('/api/skills/prep', { id, queue: true })
      assert.equal(r.body.request.state, 'queued')
    })

    await ok('prep refuses an unusable project by name rather than failing later', async () => {
      const id = (await post('/api/skills/propose', writeUp({ title: 'bad project' }))).body.proposal.id
      const r = await post('/api/skills/prep', { id, project: 'not-a-path' })
      assert.equal(r.status, 400)
      assert.match(r.body.error, /directory/)
    })

    await ok('prep twice refuses', async () => {
      const id = (await post('/api/skills/propose', writeUp({ title: 'once only' }))).body.proposal.id
      await post('/api/skills/prep', { id })
      assert.equal((await post('/api/skills/prep', { id })).status, 409)
    })

    await ok('the pass route refuses when the gate is shut and runs under override', async () => {
      const shut = await post('/api/skills/pass', {})
      assert.equal(shut.status, 409)
      assert.match(shut.body.error, /pass/)
      const run = await post('/api/skills/pass', { override: true })
      assert.equal(run.status, 200)
      assert.equal(typeof run.body.filed, 'number')
    })
  } finally {
    try { child.kill('SIGTERM') } catch {}
    try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
    try { rmSync(fakeDir, { recursive: true, force: true }) } catch {}
  }
}

// ---- the pane's restated mark cycle, evaluated in an empty vm context -----
// The panel cannot import skills-queue.mjs (a classic script, loaded by the
// browser), so it restates MARKS/nextMark/prevMark; this holds that copy to
// the store's own the way test/fleet-harness.mjs does for findings.js.
await ok('the panel restates the mark cycle exactly as the store defines it', async () => {
  const vm = await import('node:vm')
  const src = readFileSync(join(ROOT, 'syzygy', 'bridge', 'public', 'skills.js'), 'utf8')
  const ctx = vm.createContext({})
  // Nothing may run at evaluation time: no DOM, no localStorage, no MCE.
  vm.runInContext(src + '\n;globalThis.__MCO = MCSQ', ctx)
  const MCSQ = ctx.__MCO
  for (const m of ['', 'good', 'near', 'potential', 'rubbish']) {
    assert.equal(MCSQ.nextMark(m), nextMark(m), 'next ' + m)
    assert.equal(MCSQ.prevMark(m), prevMark(m), 'prev ' + m)
  }
})

console.log(`\n${pass} checks passed`)
