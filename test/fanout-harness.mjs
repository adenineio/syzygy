#!/usr/bin/env node
// Drives bridge/fanout.mjs and bridge/fanout-store.mjs under node, then the
// relay's fan-out routes against a real relay subprocess with a fake `claude`.
// Hermetic: SZG_DATA_DIR points every store at a temp directory.
//
// Run: node test/fanout-harness.mjs   (or `just test-fanout`)
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const F = await import(join(ROOT, 'syzygy', 'bridge', 'fanout.mjs'))
const S = await import(join(ROOT, 'syzygy', 'bridge', 'fanout-store.mjs'))

const freshStore = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'szg-fanout-')), 'fanout.json')
  return { file, store: S.createFanoutStore({ file, now: () => 1_700_000_000_000 }) }
}
const startFields = () => ({ ask: 'one\n\ntwo', projects: [{ key: 'k', name: 'n', root: '/r' }] })

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }

console.log('fanout harness')

await ok('paragraphs split on blank lines and keep stable indices', async () => {
  const ask = 'one\n\ntwo\nstill two\n\n\n  \n\nthree'
  assert.deepEqual(F.splitParagraphs(ask), ['one', 'two\nstill two', 'three'])
  assert.deepEqual(F.splitParagraphs(''), [])
  assert.deepEqual(F.splitParagraphs('   \n  '), [])
})

await ok('a draft ask is DERIVED, in original order, never rewritten', async () => {
  const ps = ['a', 'b', 'c']
  assert.equal(F.draftAsk(ps, [2, 0]), 'a\n\nc', 'indices sort into the ask order')
  assert.equal(F.draftAsk(ps, [0, 9]), 'a', 'an out-of-range index is dropped')
  assert.equal(F.draftAsk(ps, []), '')
})

await ok('assign moves, copies and unassigns without losing a paragraph', async () => {
  const drafts = [
    { id: 'x', paragraphs: [0, 1] },
    { id: 'y', paragraphs: [2] },
  ]
  const moved = F.assign(drafts, 'y', 1, 'move')
  assert.deepEqual(moved.find((d) => d.id === 'x').paragraphs, [0], 'move removes from every other draft')
  assert.deepEqual(moved.find((d) => d.id === 'y').paragraphs, [1, 2])
  const copied = F.assign(drafts, 'y', 1, 'copy')
  assert.deepEqual(copied.find((d) => d.id === 'x').paragraphs, [0, 1], 'copy leaves the source alone')
  assert.deepEqual(copied.find((d) => d.id === 'y').paragraphs, [1, 2],
    'a paragraph in two drafts is LEGAL - a shared constraint belongs in both')
  const gone = F.assign(drafts, 'y', 2, 'unassign')
  assert.deepEqual(gone.find((d) => d.id === 'y').paragraphs, [])
  assert.deepEqual(F.assign(drafts, 'nope', 0, 'move'), drafts, 'an unknown draft is a no-op')
})

await ok('unassigned paragraphs are reported, never silently lost', async () => {
  const drafts = [{ id: 'x', paragraphs: [0] }]
  assert.deepEqual(F.unassignedIndices(drafts, 3), [1, 2])
  assert.deepEqual(F.unassignedIndices([], 2), [0, 1])
  assert.deepEqual(F.unassignedIndices([{ id: 'x', paragraphs: [0, 1] }], 2), [])
})

await ok('merging two drafts unions their paragraphs and keeps the first', async () => {
  const drafts = [
    { id: 'x', title: 'X', projectKey: 'p', paragraphs: [0, 1], openQuestions: ['q1'] },
    { id: 'y', title: 'Y', projectKey: 'p', paragraphs: [1, 2], openQuestions: ['q2'] },
  ]
  const out = F.mergeDrafts(drafts, 'x', 'y')
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'x', 'the target survives')
  assert.deepEqual(out[0].paragraphs, [0, 1, 2], 'a union, de-duped and sorted')
  assert.deepEqual(out[0].openQuestions, ['q1', 'q2'])
})

await ok('the project fold offers every project the scanner knows, root-checked', async () => {
  const projects = [
    { key: '/a/.git', name: 'alpha', mainRoot: '/a' },
    { key: '/b/.git', name: 'beta', mainRoot: '/b' },
    { key: '/c/.git', name: 'gone', mainRoot: '/c' },
    { name: 'rootless' },
  ]
  const check = (p) => (p === '/c' ? { ok: false, error: 'no' } : { ok: true, project: p })
  const out = F.fanoutProjects(projects, { check })
  assert.deepEqual(out.map((p) => p.name), ['alpha', 'beta'],
    'a root the check refuses is dropped, and a project with no root never appears')
  assert.deepEqual(out[0], { key: '/a/.git', name: 'alpha', root: '/a' })
  assert.deepEqual(F.fanoutProjects(null, { check }), [], 'a missing payload is an empty set, never a throw')
})

await ok('proposeTitle takes the first clause and strips the filler', async () => {
  assert.equal(F.proposeTitle('ok so i want to add a fan-out box. it should be fuzzy.'),
    'add a fan-out box')
  assert.equal(F.proposeTitle('Can you please make the title automatic?'), 'make the title automatic')
  assert.equal(F.proposeTitle(''), 'untitled')
  assert.equal(F.proposeTitle('   \n '), 'untitled')
  const long = F.proposeTitle('x'.repeat(400))
  assert.ok(long.length <= 60, 'capped at 60')
  const words = F.proposeTitle('alpha beta gamma delta '.repeat(20))
  assert.ok(words.length <= 60 && !words.endsWith(' '), 'cut on a word boundary')
  assert.equal(F.proposeTitle('deploy'), 'deploy', 'a one-word ask is its own title')
})

await ok('every argv is an ARRAY with the prompt last and the flags right', async () => {
  const sp = F.scopeSpawnArgv({ name: 'scope-x', preamble: 'RULES', ask: 'do a thing',
    model: 'opus', settings: '{"env":{}}', budgetUsd: 2 })
  assert.ok(Array.isArray(sp))
  assert.equal(sp[0], '--bg')
  assert.equal(sp[sp.length - 2], '--', 'the prompt sits behind the end-of-options sentinel')
  assert.equal(sp[sp.length - 1], 'RULES\n\ndo a thing')
  const at = sp.indexOf('--allowedTools')
  assert.ok(at > 0 && !sp[at + 1].startsWith('-'), 'allowedTools is ONE argument, not a spread')
  assert.equal(sp.filter((a) => a === '--allowedTools').length, 1)
  const dt = sp.indexOf('--disallowedTools')
  assert.equal(sp.filter((a) => a === '--disallowedTools').length, 1)
  assert.ok(dt > 0 && !sp[dt + 1].startsWith('-'), 'disallowedTools is ONE argument, not a spread')
  assert.equal(sp[dt + 1], F.SCOPE_DENY)

  const fo = F.fanoutArgv({ ask: 'x', projects: [{ key: 'k', name: 'n', root: '/r' }],
    model: 'opus', budgetUsd: 1, safeMode: true })
  assert.equal(fo[0], '-p')
  assert.ok(fo.includes('--json-schema'))
  assert.ok(!fo.includes('--verbose'), 'a json-schema call is not a stream-json call')
  assert.ok(fo.includes('--safe-mode'))
  assert.equal(typeof fo[fo.length - 1], 'string')
  assert.ok(fo[fo.length - 1].includes('/r'), 'the project set travels in the prompt')

  const ti = F.titleArgv({ ask: 'x', model: 'sonnet', budgetUsd: 0.2, safeMode: false })
  assert.ok(ti.includes('--json-schema'))
  assert.ok(!ti.includes('--safe-mode'), 'not passed when the binary was not probed for it')
})

// ---- readTranscriptTail: a real claude --bg transcript's shapes ----

const assistantRow = (uuid, messageId, content) =>
  JSON.stringify({ type: 'assistant', uuid, message: { id: messageId, content } })
const userRow = (uuid, message, origin) =>
  JSON.stringify({ type: 'user', uuid, ...(origin ? { origin } : {}), message })

await ok('an assistant message written as several rows folds to one turn from the text row', async () => {
  const rows = assistantRow('u1', 'm1', [{ type: 'thinking', thinking: 'hmm' }]) + '\n'
    + assistantRow('u2', 'm1', [{ type: 'text', text: 'hello' }]) + '\n'
  const r = F.readTranscriptTail(rows, 0, [])
  assert.deepEqual(r.turns.map((t) => t.text), ['hello'])
  assert.equal(r.turns[0].messageId, 'm1')
  assert.deepEqual(r.seen, ['u1', 'u2'], 'both uuids are recorded even though only one row emitted')
})

await ok('a second read with an already-seen uuid emits only the new row', async () => {
  const first = F.readTranscriptTail(assistantRow('u1', 'm1', [{ type: 'text', text: 'a' }]) + '\n', 0, [])
  const rows = assistantRow('u1', 'm1', [{ type: 'text', text: 'a' }]) + '\n'
    + assistantRow('u3', 'm2', [{ type: 'text', text: 'b' }]) + '\n'
  const r = F.readTranscriptTail(rows, 0, first.seen)
  assert.deepEqual(r.turns.map((t) => t.text), ['b'])
})

await ok('a trailing partial line is held and the offset advances by exact bytes', async () => {
  const whole = assistantRow('u1', 'm1', [{ type: 'text', text: 'em—dash' }])
  const half = assistantRow('u2', 'm2', [{ type: 'text', text: 'half' }]).slice(0, 10)
  const r = F.readTranscriptTail(whole + '\n' + half, 0, [])
  assert.deepEqual(r.turns.map((t) => t.text), ['em—dash'], 'a partial last line is held for the next read')
  assert.equal(r.offset, Buffer.byteLength(whole, 'utf8') + 1, 'the offset advances past complete lines only')
})

await ok('non-JSON, tool-result, isMeta and command rows yield nothing and never throw', async () => {
  const rows = [
    'not json',
    userRow('u1', { content: [{ type: 'tool_result', content: 'ran it' }] }),
    JSON.stringify({ type: 'user', uuid: 'u2', isMeta: true, message: { content: 'hidden' } }),
    userRow('u3', { content: '<command-name>do-something</command-name>' }),
  ].join('\n') + '\n'
  const r = F.readTranscriptTail(rows, 0, [])
  assert.deepEqual(r.turns, [])
})

await ok('a plugin-origin row is unwrapped; a human-origin row keeps its text', async () => {
  const pluginText = 'The syzygy plugin sent a message:\nSay the word ECHO and stop.\n\n'
    + "This is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn "
    + 'in the user\'s place. Address the message above.'
  const rows = userRow('u1', { content: pluginText }, { kind: 'plugin', name: 'syzygy' }) + '\n'
    + userRow('u2', { content: 'hello there' }, { kind: 'human' }) + '\n'
  const r = F.readTranscriptTail(rows, 0, [])
  assert.equal(r.turns[0].text, 'Say the word ECHO and stop.')
  assert.equal(r.turns[0].origin, 'plugin')
  assert.equal(r.turns[1].text, 'hello there')
  assert.equal(r.turns[1].origin, 'human')
})

// ---- foldTurns ----

await ok('foldTurns joins an assistant turn sharing the last messageId, appends a different one', async () => {
  const stored = [{ role: 'assistant', text: 'first', messageId: 'm1', t: 1 }]
  const a = F.foldTurns(stored, [{ role: 'assistant', text: 'more', messageId: 'm1' }], () => 2)
  assert.equal(a.length, 1)
  assert.equal(a[0].text, 'first\n\nmore')
  const b = F.foldTurns(stored, [{ role: 'assistant', text: 'next', messageId: 'm2' }], () => 2)
  assert.equal(b.length, 2)
  assert.equal(b[1].text, 'next')
})

await ok('foldTurns confirms pane and kickoff turns rather than duplicating them, stored is untouched', async () => {
  const stored = [
    { role: 'user', text: 'draft prompt', via: 'pane', confirmed: false, t: 1 },
    { role: 'user', text: 'kick it off please', kickoff: true, confirmed: false, t: 2 },
  ]
  const before = structuredClone(stored)
  const out = F.foldTurns(stored, [
    { role: 'user', text: 'draft prompt', origin: 'plugin' },
    { role: 'user', text: 'human typed: kick it off please', origin: 'human' },
    { role: 'user', text: 'something else entirely', origin: 'human' },
  ], () => 3)
  assert.equal(out.length, 3, 'no duplicate turns for the two confirmations, one append for the rest')
  const pane = out.find((t) => t.via === 'pane')
  assert.equal(pane.confirmed, true)
  const kickoff = out.find((t) => t.kickoff === true)
  assert.equal(kickoff.confirmed, true)
  const terminal = out.find((t) => t.via === 'terminal')
  assert.equal(terminal.text, 'something else entirely')
  assert.deepEqual(stored, before, 'stored is never mutated')
})

await ok('foldTurns caps at 200, accumulates the marker rather than nesting, and truncates long text', async () => {
  const many = []
  for (let i = 0; i < 205; i++) many.push({ role: 'user', text: `turn ${i}`, origin: 'human' })
  const first = F.foldTurns([], many, () => 1)
  assert.equal(first.length, 200)
  assert.equal(first[0].role, 'marker')
  assert.equal(first[0].text, '6 earlier turns dropped')

  const more = []
  for (let i = 0; i < 5; i++) more.push({ role: 'user', text: `later ${i}`, origin: 'human' })
  const second = F.foldTurns(first, more, () => 2)
  assert.equal(second.length, 200)
  assert.equal(second[0].role, 'marker')
  assert.equal(second[0].text, '11 earlier turns dropped', 'the count accumulates rather than nesting')
  assert.equal(second.filter((t) => t.role === 'marker').length, 1, 'never more than one marker')

  const long = F.foldTurns([], [{ role: 'user', text: 'x'.repeat(20_000), origin: 'human' }], () => 1)
  assert.ok(long[0].text.endsWith('\n…[truncated]'))
  assert.equal(long[0].text.length, F.TURN_TEXT_MAX + '\n…[truncated]'.length)
})

await ok('schemaPayload reads structured_output, falls back to a parsed result, else null', async () => {
  assert.deepEqual(F.schemaPayload({ structured_output: { drafts: [] } }), { drafts: [] })
  assert.deepEqual(F.schemaPayload({ result: '{"title":"x"}' }), { title: 'x' })
  assert.equal(F.schemaPayload({ result: 'not json' }), null)
  assert.equal(F.schemaPayload({ result: '[1,2]' }), null)
  assert.equal(F.schemaPayload({ structured_output: [1, 2] }), null)
  assert.equal(F.schemaPayload(undefined), null)
})

await ok('sanitizeRun accepts only a well-shaped run and recomputes what it can verify', async () => {
  assert.equal(F.sanitizeRun(null), null)
  assert.equal(F.sanitizeRun('nope'), null)
  assert.equal(F.sanitizeRun({ id: '', state: 'running', ask: 'x' }), null, 'a missing id is refused')
  assert.equal(F.sanitizeRun({ id: 'r1', state: 'nope', ask: 'x' }), null, 'a bad state is refused')

  const raw = {
    id: 'r1', state: 'ready', ask: 'a\n\nb', createdAt: 5, extra: 'drop me',
    paragraphs: ['a', 'b'],
    projects: [{ key: 'k', name: 'n', root: '/r' }, { key: 'k2' }],
    drafts: [{ id: 'd1', title: 'T', projectKey: 'k', paragraphs: [0, 0, 9, -1], goal: 'g',
      openQuestions: ['q', 1], reason: 'r', junk: 1 }],
    error: null,
  }
  const run = F.sanitizeRun(raw)
  assert.equal(run.id, 'r1')
  assert.equal(run.createdAt, 5)
  assert.deepEqual(run.projects, [{ key: 'k', name: 'n', root: '/r' }], 'a project missing a field is dropped')
  assert.equal(run.drafts.length, 1)
  assert.deepEqual(run.drafts[0].paragraphs, [0], 'an out-of-range index is dropped and the rest de-duped')
  assert.deepEqual(run.drafts[0].openQuestions, ['q'], 'a non-string is dropped')
  assert.equal(run.drafts[0].junk, undefined, 'an unknown key is dropped')
  assert.deepEqual(run.unassigned, [1], 'unassigned is recomputed, never trusted from disk')
})

await ok('renderThread bounds a long conversation from the END', async () => {
  const turns = [{ role: 'user', text: 'old' }, { role: 'assistant', text: 'x'.repeat(5000) },
    { role: 'user', text: 'newest' }]
  const out = F.renderThread(turns, 200)
  assert.ok(Buffer.byteLength(out, 'utf8') <= 200)
  assert.ok(out.includes('newest'), 'what was settled last is what a bank call is built from')
  assert.equal(F.renderThread([], 200), '')
})

await ok('renderThread skips a marker turn entirely', async () => {
  const turns = [{ role: 'marker', text: '3 earlier turns dropped' }, { role: 'user', text: 'hi' }]
  const out = F.renderThread(turns, 60_000)
  assert.ok(!out.includes('dropped'))
  assert.ok(out.includes('hi'))
})

await ok('fanoutPrompt numbers paragraphs and lists projects; titlePrompt names the cap', async () => {
  const p = F.fanoutPrompt('one\n\ntwo', [{ key: 'k1', name: 'proj', root: '/r' }])
  assert.ok(p.includes('[1]'))
  assert.ok(p.includes('k1 — proj (/r)'))
  assert.ok(p.includes('unknown'))
  const t = F.titlePrompt('do the thing')
  assert.ok(t.includes('60'))
})

// ---- fanout-store.mjs ----

await ok('a started run is running, carries its paragraphs, and blocks a second', async () => {
  const { store } = freshStore()
  const r = store.start(startFields())
  assert.equal(r.ok, true)
  assert.equal(r.run.state, 'running')
  assert.deepEqual(r.run.paragraphs, ['one', 'two'], 'split once, at start, so indices never move')
  assert.deepEqual(r.run.drafts, [])
  const second = store.start(startFields())
  assert.equal(second.ok, false)
  assert.match(second.error, /already/, 'exactly one run may be running')
  store.finish(r.run.id, 'discarded')
  assert.equal(store.start(startFields()).ok, true, 'and a finished run frees the slot')
})

await ok('assign and merge go through the pure core and persist', async () => {
  const { file, store } = freshStore()
  const id = store.start(startFields()).run.id
  store.setDrafts(id, [{ id: 'd1', title: 'A', projectKey: 'k', paragraphs: [0], openQuestions: [] },
                       { id: 'd2', title: 'B', projectKey: 'k', paragraphs: [1], openQuestions: [] }])
  store.assign(id, 'd2', 0, 'move')
  assert.deepEqual(store.get(id).drafts.find((d) => d.id === 'd1').paragraphs, [])
  store.merge(id, 'd1', 'd2')
  assert.equal(store.get(id).drafts.length, 1)
  store.flush()
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).runs.length, 1, 'the write went to disk')
})

await ok('a serialize that throws leaves the previous file byte-identical', async () => {
  const { file, store } = freshStore()
  const id = store.start(startFields()).run.id
  store.flush()
  const before = readFileSync(file, 'utf8')
  const circular = {}; circular.self = circular
  store.update(id, { error: circular })
  assert.throws(() => store.flush())
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(readdirSync(dirname(file)).filter((n) => n.endsWith('.tmp')).length, 0,
    'the temp file is cleaned up after a failed write')
})

await ok('a file that will not parse is moved aside, never overwritten', async () => {
  const { file } = freshStore()
  writeFileSync(file, '{ not json')
  const store = S.createFanoutStore({ file, now: () => 1 })
  assert.deepEqual(store.all(), [])
  assert.equal(readdirSync(dirname(file)).some((n) => n.includes('.corrupt-')), true)
})

await ok('the store keeps at most FANOUT_KEEP runs, newest last', async () => {
  const { store } = freshStore()
  for (let i = 0; i < S.FANOUT_KEEP + 3; i++) {
    const r = store.start({ ...startFields(), ask: 'p' + i })
    store.finish(r.run.id, 'discarded')
  }
  assert.equal(store.all().length, S.FANOUT_KEEP)
  assert.equal(store.all()[S.FANOUT_KEEP - 1].ask, 'p' + (S.FANOUT_KEEP + 2))
})

await ok('a draft carries its derived ask, and the run its unassigned set', async () => {
  const { store } = freshStore()
  const id = store.start(startFields()).run.id
  store.setDrafts(id, [{ id: 'd1', title: 'A', projectKey: 'k', paragraphs: [0], openQuestions: [] }])
  assert.equal(store.get(id).drafts[0].ask, 'one', 'derived at write time, never in the pane')
  assert.deepEqual(store.get(id).unassigned, [1])
  store.assign(id, 'd1', 1, 'copy')
  assert.equal(store.get(id).drafts[0].ask, 'one\n\ntwo')
  assert.deepEqual(store.get(id).unassigned, [])
})

await ok('a running run orphaned by a relay restart is failed at load, freeing the slot', async () => {
  const { file } = freshStore()
  writeFileSync(file, JSON.stringify({
    version: 1,
    runs: [{
      id: 'r1', state: 'running', ask: 'one\n\ntwo', createdAt: 1,
      paragraphs: ['one', 'two'], projects: [], drafts: [], error: null,
    }],
  }))
  const store = S.createFanoutStore({ file, now: () => 2 })
  const r = store.get('r1')
  assert.equal(r.state, 'failed')
  assert.equal(r.error, 'the relay restarted while this run was in flight')
  assert.equal(store.start(startFields()).ok, true, 'the slot is freed')
})

// ---- scoping.mjs: one live session per request ----

const SC = await import(join(ROOT, 'syzygy', 'bridge', 'scoping.mjs'))
const RQ = await import(join(ROOT, 'syzygy', 'bridge', 'requests.mjs'))

/** A fake `-p` child. Nothing is executed; the test drives stdout by hand. */
const fakeSpawn = (calls) => (bin, argv, opts) => {
  const listeners = { stdout: [], stderr: [], close: [], error: [] }
  const child = {
    killed: false,
    stdout: { setEncoding() {}, on(_e, f) { listeners.stdout.push(f) } },
    stderr: { setEncoding() {}, on(_e, f) { listeners.stderr.push(f) } },
    on(e, f) { if (e === 'close') listeners.close.push(f); else if (e === 'error') listeners.error.push(f) },
    kill() { this.killed = true; for (const f of listeners.close) f(143) },
    emit(text) { for (const f of listeners.stdout) f(text) },
    emitStderr(text) { for (const f of listeners.stderr) f(text) },
    finish(code = 0) { for (const f of listeners.close) f(code) },
    emitError(err) { for (const f of listeners.error) f(err) },
  }
  calls.push({ bin, argv, opts, child })
  return child
}

/** An in-memory request store: `update` never changes id/state/slug/createdAt
 *  or titleSource, and `transition` refuses what requests.mjs refuses. */
const memStore = () => {
  const items = []
  const get = (id) => items.find((r) => r.id === id) ?? null
  return {
    seed(r) { items.push({ title: 'untitled', titleSource: 'manual', ask: '', error: null, ...r }); return get(r.id) },
    get,
    all: () => items,
    update(id, patch = {}) {
      const r = get(id)
      if (!r) return null
      const { id: _i, state: _s, slug: _g, createdAt: _c, titleSource: _t, ...rest } = patch
      Object.assign(r, rest)
      return r
    },
    transition(id, to) {
      const r = get(id)
      if (!r) throw new Error(`no such request: ${id}`)
      if (!RQ.canTransition(r.state, to)) throw new Error(`illegal transition: ${r.state} -> ${to}`)
      r.state = to
      return r
    },
    retitle(id, title) {
      const r = get(id)
      if (!r || r.state !== 'draft') return null
      const clean = String(title ?? '').trim()
      if (!clean) return null
      r.title = clean
      r.slug = RQ.slugify(clean, [])
      return r
    },
    remove(id) {
      const i = items.findIndex((r) => r.id === id)
      if (i < 0) return false
      items.splice(i, 1)
      return true
    },
  }
}

const CWD = mkdtempSync(join(tmpdir(), 'szg-scope-cwd-'))
const tick = () => new Promise((res) => setImmediate(res))

/** `over` is an options object, or a function of the harness's own arrays
 *  for options that must record into them. */
const scoper = (over = {}) => {
  const calls = []
  const kids = []
  const sent = []
  const store = memStore()
  const extra = typeof over === 'function' ? over({ calls, kids, sent }) : over
  const s = SC.createScoper({
    store,
    broadcast: (type, data) => sent.push([type, data]),
    run: async (bin, argv, opts) => {
      calls.push({ bin, argv, opts })
      return { code: 0, stdout: 'backgrounded · ab12 · scope-x\n', stderr: '' }
    },
    spawn: () => { throw new Error('no -p child expected on this path') },
    enqueue: (id, cmd) => calls.push({ enqueue: id, cmd }),
    hasSession: () => true,
    relayInfo: () => ({ relayPort: 4341, relayToken: 'tok' }),
    projectsDir: mkdtempSync(join(tmpdir(), 'szg-scope-projects-')),
    now: () => 1_000,
    ...extra,
  })
  return { calls, kids, sent, store, s }
}

const liveSeed = (over = {}) => ({
  id: 'r1', state: 'scoped', slug: 'thing', project: CWD, dispatch: {},
  scoping: {
    turns: [], pending: [], offset: 0, seen: [],
    session: { shortId: 'ab12', sessionId: 'sess-1', spawnedAt: 1_000, state: null, endedAt: null },
  },
  ...over,
})

const pluginWrap = (text) =>
  `The syzygy plugin sent a message:\n${text}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns.`
const transcriptRows = (...rows) => rows.map((r) => JSON.stringify(r) + '\n').join('')
const replyRows = () => transcriptRows(
  { type: 'user', uuid: 'u1', origin: { kind: 'plugin', name: 'syzygy' }, message: { content: pluginWrap('second turn') } },
  { type: 'assistant', uuid: 'u2', message: { id: 'm1', content: [{ type: 'text', text: 'the reply' }] } },
)

await ok('the first turn SPAWNS, with the relay handoff and the preamble inline', async () => {
  process.env.SZG_LEAK_PROBE = '1'
  try {
    const { calls, store, s } = scoper()
    store.seed({ id: 'r1', state: 'draft', slug: 'thing', project: CWD, dispatch: { model: 'opus' }, scoping: null })
    const out = await s.startScoping('r1', 'do a thing', CWD)
    assert.equal(out.ok, true)
    const spawn = calls.find((c) => c.argv?.[0] === '--bg')
    assert.ok(spawn, 'a --bg session, not a -p child')
    assert.deepEqual(spawn.argv.slice(0, 3), ['--bg', '-n', 'scope-thing'])
    const si = spawn.argv.indexOf('--settings')
    assert.ok(si > 0 && spawn.argv[si + 1].includes('SZG_RELAY_PORT'),
      'the relay handoff is on the argv - a --bg session inherits no environment')
    assert.ok(spawn.argv[si + 1].includes('4341'))
    assert.equal(spawn.argv[spawn.argv.length - 2], '--')
    assert.ok(spawn.argv[spawn.argv.length - 1].startsWith(SC.SCOPING_PREAMBLE))
    assert.equal(spawn.opts.cwd, CWD)
    assert.ok(!Object.keys(spawn.opts.env).some((k) => k.startsWith('SZG_')), 'no SZG_* key reaches the daemon')
    assert.equal(store.get('r1').scoping.session.shortId, 'ab12')
    assert.deepEqual(store.get('r1').scoping.turns.map((t) => t.role), ['user'])
    assert.equal(store.get('r1').state, 'scoped')
    assert.equal(store.get('r1').scoping.busy, true)
    assert.equal(s.liveScopes(), 1)
  } finally {
    delete process.env.SZG_LEAK_PROBE
  }
})

await ok('a later turn ENQUEUES, and one sent too early is parked', async () => {
  const { calls, store, s } = scoper({ hasSession: (id) => id === 'sess-1' })
  store.seed({ id: 'r1', state: 'scoped', slug: 'thing', project: CWD, dispatch: {},
    scoping: { turns: [], session: { shortId: 'ab12', sessionId: null } } })
  const parked = await s.startScoping('r1', 'second turn', CWD)
  assert.deepEqual(parked, { ok: true, parked: true })
  assert.equal(calls.filter((c) => c.enqueue).length, 0, 'nothing to enqueue to yet')
  assert.deepEqual(store.get('r1').scoping.pending, ['second turn'])
  store.update('r1', { scoping: { ...store.get('r1').scoping, session: { shortId: 'ab12', sessionId: 'sess-1' } } })
  assert.equal(await s.drainPending('r1', 'sess-1'), true)
  assert.equal(calls.filter((c) => c.enqueue === 'sess-1').length, 1)
  assert.deepEqual(calls.find((c) => c.enqueue).cmd, { verb: 'prompt', payload: { text: 'second turn' } })
  assert.deepEqual(store.get('r1').scoping.pending, [], 'and the park is emptied exactly once')
  assert.equal(await s.drainPending('r1', 'sess-1'), false)
  const sent = await s.startScoping('r1', 'third turn', CWD)
  assert.deepEqual(sent, { ok: true, parked: false })
  assert.equal(calls.filter((c) => c.enqueue === 'sess-1').length, 2, 'a registered session is enqueued to directly')
})

await ok('ending a conversation stops the session and records why', async () => {
  const { calls, store, s } = scoper()
  store.seed({ id: 'r1', state: 'scoped', slug: 'thing', project: CWD, dispatch: {},
    scoping: { turns: [], session: { shortId: 'ab12', sessionId: 'sess-1' } } })
  await s.endScoping('r1', 'banked')
  const stop = calls.find((c) => c.argv?.[0] === 'stop')
  assert.deepEqual(stop.argv, ['stop', 'ab12'], 'claude stop by the short id, never a pattern kill')
  assert.equal(store.get('r1').scoping.session.endedReason, 'banked')
  assert.ok(store.get('r1').scoping.session.endedAt > 0)
  assert.equal(store.get('r1').scoping.session.stopError, null)
  await s.endScoping('r1', 'banked')
  assert.equal(calls.filter((c) => c.argv?.[0] === 'stop').length, 1, 'ending twice is a no-op')
  assert.equal(s.liveScopes(), 0)
})

await ok('a conversation past the ceiling is ended, not silently restarted', async () => {
  const DAY = 24 * 3600_000
  const { calls, store, s } = scoper({ now: () => DAY * 2 })
  store.seed({ id: 'r1', state: 'scoped', slug: 'thing', project: CWD, dispatch: {},
    scoping: { turns: [], session: { shortId: 'ab12', sessionId: 'sess-1', spawnedAt: 1 } } })
  store.seed({ id: 'r2', state: 'scoped', slug: 'fresh', project: CWD, dispatch: {},
    scoping: { turns: [], session: { shortId: 'cd34', sessionId: 'sess-2', spawnedAt: DAY * 2 - 1 } } })
  await s.sweepExpired()
  assert.equal(store.get('r1').scoping.session.endedReason, 'expired')
  assert.ok(calls.some((c) => c.argv?.[0] === 'stop'))
  assert.equal(store.get('r2').scoping.session.endedAt, undefined, 'a young session is left alone')
  assert.equal(calls.filter((c) => c.argv?.[0] === '--bg').length, 0)
})

await ok('a failed spawn leaves no half-started conversation', async () => {
  const { store, s } = scoper({ run: async () => ({ code: 1, stdout: '', stderr: 'nope' }) })
  store.seed({ id: 'r1', state: 'draft', slug: 'thing', project: CWD, dispatch: {}, scoping: null })
  const out = await s.startScoping('r1', 'do a thing', CWD)
  assert.equal(out.ok, false)
  assert.equal(out.code, 502)
  assert.match(out.error, /nope/)
  assert.equal(store.get('r1').scoping?.session ?? null, null)
  assert.equal(store.get('r1').scoping, null, 'no turn was added either')
  assert.equal(store.get('r1').state, 'draft')
  assert.match(store.get('r1').error.message, /nope/)
})

await ok('a blank turn is refused, and a missing project directory before anything runs', async () => {
  const { calls, store, s } = scoper()
  store.seed({ id: 'r1', state: 'draft', slug: 'thing', project: CWD, dispatch: {}, scoping: null })
  assert.equal((await s.startScoping('nope', 'x', CWD)).code, 404)
  assert.equal((await s.startScoping('r1', '   ', CWD)).code, 400)
  const missing = await s.startScoping('r1', 'x', join(CWD, 'gone'))
  assert.equal(missing.code, 400)
  assert.match(missing.error, /project directory does not exist/)
  assert.equal(calls.length, 0)
})

await ok('a request deleted mid-spawn has its new session stopped, and a turn during the spawn is refused', async () => {
  let release
  const gate = new Promise((res) => { release = res })
  const { calls, store, s } = scoper((c) => ({
    run: async (bin, argv) => {
      c.calls.push({ argv })
      if (argv[0] === '--bg') await gate
      return { code: 0, stdout: 'backgrounded · ab12 · scope-thing\n', stderr: '' }
    },
  }))
  store.seed({ id: 'r1', state: 'draft', slug: 'thing', project: CWD, dispatch: {}, scoping: null })
  const first = s.startScoping('r1', 'do a thing', CWD)
  const second = await s.startScoping('r1', 'and another', CWD)
  assert.equal(second.code, 409, 'two racing turns would start two sessions')
  store.remove('r1')
  release()
  const out = await first
  assert.equal(out.code, 404)
  await tick()
  assert.deepEqual(calls.filter((c) => c.argv[0] === 'stop').map((c) => c.argv), [['stop', 'ab12']])
})

await ok('pass() fills the session id from a listing, and a failed listing writes nothing', async () => {
  let listing = { code: 1, stdout: '', stderr: 'daemon down' }
  const { calls, store, s } = scoper((c) => ({
    run: async (bin, argv) => {
      c.calls.push({ argv })
      return argv[0] === 'agents' ? listing : { code: 0, stdout: '', stderr: '' }
    },
  }))
  store.seed(liveSeed())
  store.get('r1').scoping.session.sessionId = null
  await s.pass()
  assert.equal(store.get('r1').scoping.session.sessionId, null, 'a failed listing fills nothing')
  listing = { code: 0, stdout: JSON.stringify([{ id: 'zz99', sessionId: 'other' },
    { id: 'ab12', sessionId: 'sess-ab12', state: 'working' }]), stderr: '' }
  await s.pass()
  assert.equal(store.get('r1').scoping.session.sessionId, 'sess-ab12')
  assert.equal(store.get('r1').scoping.session.state, 'working')
  listing = { code: 0, stdout: 'not json', stderr: '' }
  await s.pass()
  assert.equal(store.get('r1').scoping.session.sessionId, 'sess-ab12', 'an unparseable listing leaves it untouched')
  assert.equal(store.get('r1').scoping.session.state, 'working')
  assert.ok(calls.filter((c) => c.argv[0] === 'agents').every((c) =>
    JSON.stringify(c.argv) === JSON.stringify(['agents', '--json', '--all'])))

  const idle = scoper((c) => ({ run: async (bin, argv) => { c.calls.push({ argv }); return listing } }))
  await idle.s.pass()
  assert.equal(idle.calls.length, 0, 'no live session, no listing')
})

await ok('readReplies confirms a pane turn and adds the reply, and a second read adds nothing', async () => {
  const projectsDir = mkdtempSync(join(tmpdir(), 'szg-scope-projects-'))
  mkdirSync(join(projectsDir, '-Users-someone-other'))
  mkdirSync(join(projectsDir, '-Users-someone-proj'))
  const file = join(projectsDir, '-Users-someone-proj', 'sess-1.jsonl')
  writeFileSync(file, replyRows())
  const { store, s } = scoper({ projectsDir })
  const seed = liveSeed()
  seed.scoping.turns = [{ role: 'user', text: 'second turn', via: 'pane', confirmed: false, t: 1 }]
  store.seed(seed)
  assert.equal(s.readReplies('r1'), true)
  const sc = store.get('r1').scoping
  assert.deepEqual(sc.turns.map((t) => [t.role, t.text]), [['user', 'second turn'], ['assistant', 'the reply']])
  assert.equal(sc.turns[0].confirmed, true, 'the pane turn is confirmed in place, not appended again')
  assert.equal(sc.transcriptPath, file, 'the hit is cached')
  assert.equal(sc.offset, Buffer.byteLength(readFileSync(file, 'utf8'), 'utf8'))
  assert.equal(s.readReplies('r1'), false, 'a second read adds nothing')
  assert.equal(store.get('r1').scoping.turns.length, 2)
  appendFileSync(file, transcriptRows(
    { type: 'assistant', uuid: 'u3', message: { id: 'm2', content: [{ type: 'text', text: 'and more' }] } }))
  assert.equal(s.readReplies('r1'), true)
  assert.equal(store.get('r1').scoping.turns.at(-1).text, 'and more')
})

await ok('readReplies never throws: no transcript, a hostile session id, a missing projects dir', async () => {
  const { store, s } = scoper()
  store.seed(liveSeed({ id: 'r1' }))
  store.seed(liveSeed({ id: 'r2' }))
  store.get('r2').scoping.session.sessionId = '../../etc/passwd'
  assert.equal(s.readReplies('r1'), false)
  assert.equal(s.readReplies('r2'), false)
  assert.equal(s.readReplies('nope'), false)
  const gone = scoper({ projectsDir: join(CWD, 'no-such-projects-dir') })
  gone.store.seed(liveSeed())
  const origWrite = process.stderr.write
  process.stderr.write = () => true
  try {
    assert.equal(gone.s.readReplies('r1'), false)
  } finally {
    process.stderr.write = origWrite
  }
})

await ok('busy settles false once the reply is read and the listing says done, broadcasting turn-end', async () => {
  const projectsDir = mkdtempSync(join(tmpdir(), 'szg-scope-projects-'))
  mkdirSync(join(projectsDir, 'p'))
  let listing = [{ id: 'ab12', sessionId: 'sess-1', state: 'working' }]
  const { store, s, sent } = scoper(() => ({
    projectsDir,
    run: async () => ({ code: 0, stdout: JSON.stringify(listing), stderr: '' }),
  }))
  const seed = liveSeed()
  seed.scoping.turns = [{ role: 'user', text: 'second turn', via: 'pane', confirmed: false, t: 1 }]
  seed.scoping.busy = true
  store.seed(seed)
  await s.pass()
  assert.equal(store.get('r1').scoping.busy, true, 'nothing read yet, and the session is working')
  const turnEnds = () => sent.filter(([t, d]) => t === 'scope' && d.event?.type === 'turn-end')
  assert.equal(turnEnds().length, 0)

  writeFileSync(join(projectsDir, 'p', 'sess-1.jsonl'), replyRows())
  listing = [{ id: 'ab12', sessionId: 'sess-1', state: 'done' }]
  sent.length = 0
  await s.pass()
  const sc = store.get('r1').scoping
  assert.equal(sc.busy, false)
  assert.equal(sc.turns.at(-1).text, 'the reply')
  assert.equal(turnEnds().length, 1)
  assert.equal(sent.filter(([t]) => t === 'dispatch').length, 1, 'one dispatch broadcast for the whole pass')

  sent.length = 0
  await s.pass()
  assert.equal(sent.length, 0, 'an unchanged pass broadcasts nothing')
})

await ok('a turn to an ended session is 409; restart spawns with the earlier thread in the kickoff', async () => {
  const { calls, store, s } = scoper()
  store.seed({ id: 'r1', state: 'scoped', slug: 'thing', project: CWD, dispatch: { model: 'sonnet' },
    scoping: {
      turns: [{ role: 'user', text: 'build the widget', via: 'pane', kickoff: true, confirmed: true, t: 1 },
        { role: 'assistant', text: 'which widget?', t: 2 }],
      pending: [], offset: 900, seen: ['u1'], transcriptPath: '/old/path.jsonl', costUsd: 0.5,
      session: { shortId: 'old1', sessionId: 'sess-old', spawnedAt: 1, endedAt: 5, endedReason: 'ended by hand' },
    } })
  const refused = await s.startScoping('r1', 'one more thing', CWD)
  assert.equal(refused.code, 409)
  assert.match(refused.error, /conversation ended/)
  assert.equal(calls.length, 0)

  const out = await s.startScoping('r1', '', CWD, { restart: true })
  assert.equal(out.ok, true)
  const spawn = calls.find((c) => c.argv?.[0] === '--bg')
  const prompt = spawn.argv.at(-1)
  assert.ok(prompt.includes('HUMAN: build the widget\n\nCLAUDE: which widget?'), 'the earlier thread rides the kickoff')
  assert.ok(prompt.endsWith('Now: Pick up where we left off: say what was settled, then ask the next open question.'))
  assert.equal(spawn.argv[spawn.argv.indexOf('--model') + 1], 'sonnet')
  const sc = store.get('r1').scoping
  assert.equal(sc.session.shortId, 'ab12')
  assert.equal(sc.session.endedAt, null)
  assert.equal(sc.offset, 0, 'a new session reads its own transcript from the start')
  assert.deepEqual(sc.seen, [])
  assert.equal(sc.transcriptPath, null)
  assert.equal(sc.costUsd, 0.5)
  assert.equal(sc.turns.length, 3)

  const again = await s.startScoping('r1', 'x', CWD, { restart: true })
  assert.equal(again.code, 409)
  assert.match(again.error, /still live/)

  store.seed({ id: 'r2', state: 'scoped', slug: 'old', project: CWD, dispatch: {},
    scoping: { sessionId: 'resume-me', turns: [{ role: 'user', text: 'hi', t: 1 }] } })
  assert.equal((await s.startScoping('r2', 'hello', CWD)).code, 409, 'an older record is not silently forked')
  assert.equal((await s.startScoping('r2', 'hello', CWD, { restart: true })).ok, true)
  assert.equal(store.get('r2').scoping.sessionId, 'resume-me', 'the older record keeps its own id')
})

await ok('a failed stop is recorded on the session and endScoping still resolves', async () => {
  const { store, s, sent } = scoper({ run: async () => ({ code: 1, stdout: '', stderr: '  no such session: ab12\n' }) })
  const seed = liveSeed()
  seed.scoping.pending = ['parked']
  seed.scoping.busy = true
  store.seed(seed)
  assert.deepEqual(await s.endScoping('r1', 'ended by hand'), { ok: true, stopped: false })
  const sc = store.get('r1').scoping
  assert.equal(sc.session.stopError, 'no such session: ab12')
  assert.equal(sc.session.endedReason, 'ended by hand')
  assert.equal(sc.busy, false)
  assert.deepEqual(sc.pending, [])
  assert.ok(sent.some(([t]) => t === 'dispatch'))

  const throwing = scoper({ run: async () => { throw new Error('runner blew up') } })
  throwing.store.seed(liveSeed())
  await assert.doesNotReject(throwing.s.endScoping('r1', 'deleted'))
  assert.match(throwing.store.get('r1').scoping.session.stopError, /runner blew up/)

  let release
  const gate = new Promise((res) => { release = res })
  const vanishing = scoper({ run: async () => { await gate; return { code: 0, stdout: '', stderr: '' } } })
  vanishing.store.seed(liveSeed())
  const p = vanishing.s.endScoping('r1', 'deleted')
  vanishing.store.remove('r1')
  release()
  assert.deepEqual(await p, { ok: true, stopped: false }, 'a request deleted while its stop runs resolves quietly')
})

await ok('bank renders the thread into one headless call: no --resume, stdin closed', async () => {
  const { calls, kids, store, s } = scoper((c) => ({ spawn: fakeSpawn(c.kids) }))
  const seed = liveSeed()
  seed.scoping.turns = [{ role: 'user', text: 'build the widget', t: 1 }, { role: 'assistant', text: 'which widget?', t: 2 }]
  store.seed(seed)
  const p = s.bank('r1', CWD)
  assert.equal(kids.length, 1)
  const { argv, opts } = kids[0]
  assert.equal(argv[0], '-p')
  assert.ok(!argv.includes('--resume'), 'no session is resumed')
  assert.ok(argv.includes('--json-schema'))
  assert.ok(argv.at(-1).includes('HUMAN: build the widget\n\nCLAUDE: which widget?'), 'the rendered thread is the prompt')
  assert.equal(opts.stdio[0], 'ignore')
  assert.equal(opts.cwd, CWD)
  // No trailing newline: the answer is still read when the child closes.
  kids[0].child.emit(JSON.stringify({ type: 'result', structured_output: { goal: 'a widget' } }))
  kids[0].child.finish(0)
  assert.deepEqual(await p, { ok: true })
  assert.equal(store.get('r1').state, 'queued')
  assert.equal(store.get('r1').brief.goal, 'a widget')
  await tick()
  assert.deepEqual(calls.find((c) => c.argv?.[0] === 'stop')?.argv, ['stop', 'ab12'], 'a banked conversation stops its session')
  assert.equal(store.get('r1').scoping.session.endedReason, 'banked')
})

await ok('fanout clears an unknown project with a reason, counts a dropped index, and titles a blank draft', async () => {
  const { store: fstore } = freshStore()
  const run = fstore.start({ ask: 'build the widget\n\npaint the shed', projects: [{ key: 'k1', name: 'one', root: CWD }] }).run
  const { kids, sent, s } = scoper((c) => ({ spawn: fakeSpawn(c.kids), fanoutStore: fstore }))
  const p = s.fanout(run.id, run.ask, run.projects)
  assert.equal(kids.length, 1)
  const { argv, opts } = kids[0]
  assert.ok(argv.includes('--json-schema') && argv.includes('--max-budget-usd'))
  assert.equal(opts.stdio[0], 'ignore')
  kids[0].child.emit(JSON.stringify({ type: 'result', structured_output: { drafts: [
    { title: 'Widget', projectKey: 'k1', paragraphs: [0, 7, -1] },
    { title: '  ', projectKey: 'unknown', paragraphs: [1], reason: 'no project fits' },
  ] } }) + '\n')
  kids[0].child.finish(0)
  assert.deepEqual(await p, { ok: true })
  const r = fstore.get(run.id)
  assert.equal(r.state, 'ready')
  assert.equal(r.drafts[0].projectKey, 'k1')
  assert.deepEqual(r.drafts[0].paragraphs, [0])
  assert.equal(r.drafts[1].projectKey, '')
  assert.equal(r.drafts[1].reason, 'no project fits — project "unknown" is not one this relay knows')
  assert.equal(r.drafts[1].title, 'paint the shed')
  assert.equal(r.error, '2 paragraph indices out of range were dropped')
  assert.ok(sent.some(([t, d]) => t === 'fanout' && Array.isArray(d.runs)))
})

await ok('fanout refuses more drafts than the cap, fails on a failed child, and never overrides a discard', async () => {
  const { store: fstore } = freshStore()
  const { kids, s } = scoper((c) => ({ spawn: fakeSpawn(c.kids), fanoutStore: fstore }))

  const nineRun = fstore.start(startFields()).run
  const p1 = s.fanout(nineRun.id, nineRun.ask, nineRun.projects)
  const nine = Array.from({ length: 9 }, (_, i) => ({ title: 'd' + i, projectKey: 'k', paragraphs: [0] }))
  kids[0].child.emit(JSON.stringify({ type: 'result', structured_output: { drafts: nine } }) + '\n')
  kids[0].child.finish(0)
  assert.deepEqual(await p1, { ok: false })
  assert.equal(fstore.get(nineRun.id).state, 'failed')
  assert.match(fstore.get(nineRun.id).error, /returned 9 drafts; at most 8 are allowed/)
  assert.deepEqual(fstore.get(nineRun.id).drafts, [], 'refused whole, never truncated')

  const badRun = fstore.start(startFields()).run
  const p2 = s.fanout(badRun.id, badRun.ask, badRun.projects)
  kids[1].child.emitStderr('credit balance too low')
  kids[1].child.finish(1)
  assert.deepEqual(await p2, { ok: false })
  assert.equal(fstore.get(badRun.id).state, 'failed')
  assert.match(fstore.get(badRun.id).error, /exit 1.*credit balance too low/)

  const goneRun = fstore.start(startFields()).run
  const p3 = s.fanout(goneRun.id, goneRun.ask, goneRun.projects)
  assert.equal(s.kill('fanout:' + goneRun.id), true)
  fstore.finish(goneRun.id, 'discarded')
  assert.deepEqual(await p3, { ok: false })
  assert.equal(fstore.get(goneRun.id).state, 'discarded', 'a discard made mid-call stands')

  const none = scoper()
  assert.deepEqual(await none.s.fanout('x', 'ask', []), { ok: false }, 'no run store, no call')
})

await ok('proposeAndRefine retitles an auto draft, leaves a manual one alone, and swallows a failed child', async () => {
  const { kids, sent, store, s } = scoper((c) => ({ spawn: fakeSpawn(c.kids) }))
  const ask = 'ok so i want to add a fan-out box to the dispatch tab, and it should be fuzzy about which project each paragraph belongs to'
  const draft = (id, over = {}) => store.seed({ id, state: 'draft', slug: 'add-a-fan-out-box', title: 'add a fan-out box',
    titleSource: 'auto', ask, project: CWD, dispatch: {}, scoping: null, ...over })

  draft('r1')
  const p = s.proposeAndRefine('r1')
  assert.equal(kids.length, 1)
  assert.ok(kids[0].argv.includes('--json-schema'))
  assert.equal(kids[0].opts.stdio[0], 'ignore')
  kids[0].child.emit(JSON.stringify({ type: 'result', structured_output: { title: '  Fuzzy fan-out box  ' } }) + '\n')
  kids[0].child.finish(0)
  assert.deepEqual(await p, { ok: true })
  assert.equal(store.get('r1').title, 'Fuzzy fan-out box')
  assert.equal(store.get('r1').slug, 'fuzzy-fan-out-box')
  assert.ok(sent.some(([t]) => t === 'dispatch'))

  draft('r2', { titleSource: 'manual' })
  assert.deepEqual(await s.proposeAndRefine('r2'), { ok: false })
  draft('r3', { ask: 'short' })
  assert.deepEqual(await s.proposeAndRefine('r3'), { ok: false })
  assert.equal(kids.length, 1, 'a manual title and a short ask start no child')

  draft('r4')
  const p4 = s.proposeAndRefine('r4')
  kids[1].child.emitError(new Error('spawn ENOENT claude'))
  assert.deepEqual(await p4, { ok: false })
  assert.equal(store.get('r4').title, 'add a fan-out box')

  draft('r5')
  const p5 = s.proposeAndRefine('r5')
  store.get('r5').titleSource = 'manual'
  store.get('r5').title = 'typed over it'
  kids[2].child.emit(JSON.stringify({ type: 'result', structured_output: { title: 'refined' } }) + '\n')
  kids[2].child.finish(0)
  assert.deepEqual(await p5, { ok: false })
  assert.equal(store.get('r5').title, 'typed over it', 'a title typed mid-call is never overwritten')
})

// ---- claudeBin: null -- the no-binary hotfix -------------------------------
// A relay with no usable `claude` at all constructs this module with
// `claudeBin: null`, never the bare string 'claude'. Every path that would
// otherwise spawn must refuse instead of falling back to whatever `claude`
// happens to sit on PATH -- the injected `run`/`spawn` here are spies that
// would happily record a call if one reached them, so an empty `calls`/`kids`
// array after each of these is the proof nothing was spawned.
const NO_CLAUDE_MSG = "no claude binary with --bg was found — see the relay's stderr"
/** Runs `fn`, capturing every stderr write instead of letting it print, and
 *  returns `{ result, writes }` -- `fn`'s own resolved value alongside what
 *  it wrote, since several of these assert on both. */
const silenceStderr = async (fn) => {
  const origWrite = process.stderr.write
  const writes = []
  process.stderr.write = (s) => { writes.push(String(s)); return true }
  let result
  try { result = await fn() } finally { process.stderr.write = origWrite }
  return { result, writes }
}

await ok('claudeBin: null refuses pass()\'s listing -- no live session is ever polled', async () => {
  const { calls, store, s } = scoper({ claudeBin: null })
  store.seed(liveSeed())
  const { writes } = await silenceStderr(() => s.pass())
  assert.equal(calls.length, 0, 'pass() must not call run at all with no usable binary')
  assert.ok(writes.some((w) => /no claude binary with --bg was found/.test(w)), 'the refusal reaches stderr')
})

await ok('claudeBin: null refuses the first turn\'s --bg spawn, recording why on the request', async () => {
  const { calls, store, s } = scoper({ claudeBin: null })
  store.seed({ id: 'r1', state: 'draft', slug: 'thing', project: CWD, dispatch: { model: 'opus' }, scoping: null })
  await silenceStderr(() => s.startScoping('r1', 'do a thing', CWD))
  assert.equal(calls.length, 0, 'no --bg spawn without a usable binary')
  const r = store.get('r1')
  assert.match(r.error.message, /no claude binary with --bg was found/)
  assert.equal(r.scoping, null, 'nothing was started')
})

await ok('claudeBin: null refuses claude stop, but still records the conversation as ended', async () => {
  const { calls, store, s } = scoper({ claudeBin: null })
  store.seed({ id: 'r1', state: 'scoped', slug: 'thing', project: CWD, dispatch: {},
    scoping: { turns: [], session: { shortId: 'ab12', sessionId: 'sess-1' } } })
  await silenceStderr(() => s.endScoping('r1', 'ended by hand'))
  assert.equal(calls.length, 0, 'no claude stop without a usable binary')
  const session = store.get('r1').scoping.session
  assert.ok(session.endedAt > 0)
  assert.match(session.stopError, /no claude binary with --bg was found/)
})

await ok('claudeBin: null refuses bank\'s headless child before it ever spawns', async () => {
  const { kids, store, s } = scoper((c) => ({ claudeBin: null, spawn: fakeSpawn(c.kids) }))
  const seed = liveSeed()
  seed.scoping.turns = [{ role: 'user', text: 'build the widget', t: 1 }]
  store.seed(seed)
  const { result: out } = await silenceStderr(() => s.bank('r1', CWD))
  assert.equal(kids.length, 0, 'no -p child without a usable binary')
  assert.deepEqual(out, { ok: false, error: NO_CLAUDE_MSG })
  assert.match(store.get('r1').error.message, /no claude binary with --bg was found/)
})

await ok('claudeBin: null refuses fanout\'s headless child, filing the run as failed', async () => {
  const { store: fstore } = freshStore()
  const run = fstore.start(startFields()).run
  const { kids, s } = scoper((c) => ({ claudeBin: null, spawn: fakeSpawn(c.kids), fanoutStore: fstore }))
  const { result: out } = await silenceStderr(() => s.fanout(run.id, run.ask, run.projects))
  assert.equal(kids.length, 0, 'no -p child without a usable binary')
  assert.deepEqual(out, { ok: false })
  assert.equal(fstore.get(run.id).state, 'failed')
  assert.match(fstore.get(run.id).error, /no claude binary with --bg was found/)
})

await ok('claudeBin: null still refuses proposeAndRefine\'s title child (already gated; locked here too)', async () => {
  const { kids, store, s } = scoper((c) => ({ claudeBin: null, spawn: fakeSpawn(c.kids) }))
  const ask = 'ok so i want to add a fan-out box to the dispatch tab, and it should be fuzzy about which project each paragraph belongs to'
  store.seed({ id: 'r1', state: 'draft', slug: 'add-a-fan-out-box', title: 'add a fan-out box',
    titleSource: 'auto', ask, project: CWD, dispatch: {}, scoping: null })
  const out = await s.proposeAndRefine('r1')
  assert.equal(kids.length, 0)
  assert.deepEqual(out, { ok: false })
})

// ---- the live relay: real subprocess, fake `claude` ------------------------
// The routes live in relay.mjs's HTTP handler, so they are driven against the
// REAL relay. Isolated on every axis: SZG_PORT=0 (OS-assigned, never 4317),
// SZG_DATA_DIR and SZG_CLAUDE_PROJECTS_DIR (throwaway directories), and
// SZG_CLAUDE_BIN (a script that answers the way `claude` does). No real
// session is ever started.
{
  const { spawn } = await import('node:child_process')
  const { chmodSync, existsSync, realpathSync, unlinkSync } = await import('node:fs')
  const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'szg-fanout-relay-')))
  const dataDir = tmp()
  const fakeDir = tmp()
  const projectsDir = tmp()
  const agentsFile = join(fakeDir, 'agents.json')
  const stopsFile = join(fakeDir, 'stops.txt')
  const bgFile = join(fakeDir, 'bg-argv.txt')
  const holdFile = join(fakeDir, 'hold')
  writeFileSync(agentsFile, '[]')

  const draftsAnswer = JSON.stringify({ type: 'result', subtype: 'success', structured_output: { drafts: [
    { title: 'Alpha', projectKey: 'unknown', paragraphs: [0] },
    { title: 'Beta', projectKey: 'unknown', paragraphs: [1] },
  ] } })
  const titleAnswer = JSON.stringify({ type: 'result', structured_output: { title: 'refined' } })
  const briefAnswer = JSON.stringify({ type: 'result', structured_output: { goal: 'g' } })
  const fakeBin = join(fakeDir, 'claude')
  writeFileSync(fakeBin, [
    '#!/bin/sh',
    // The relay picks its `claude` by capability, so the fake answers --help
    // the way a capable one does.
    'if [ "$1" = "--help" ]; then echo "  --bg   run in the background"; echo "  attach   attach to a session"; exit 0; fi',
    'if [ "$1" = "--version" ]; then echo "0.0.0-fake (fanout harness)"; exit 0; fi',
    'if [ "$1" = "agents" ]; then cat "' + agentsFile + '"; exit 0; fi',
    'if [ "$1" = "stop" ]; then echo "$2" >> "' + stopsFile + '"; exit 0; fi',
    'if [ "$1" = "--bg" ]; then',
    '  printf "%s\\n" "$@" >> "' + bgFile + '"',
    '  name=""; prev=""',
    '  for a in "$@"; do if [ "$prev" = "-n" ]; then name="$a"; break; fi; prev="$a"; done',
    '  echo "backgrounded · ab12 · $name"',
    '  exit 0',
    'fi',
    'if [ "$1" = "-p" ]; then',
    // While the hold file exists the call stays in flight, so a run stays
    // `running` for exactly as long as a case needs it to.
    '  i=0',
    '  while [ -f "' + holdFile + '" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done',
    '  case "$*" in',
    "    *'\"drafts\"'*) echo '" + draftsAnswer + "' ;;",
    "    *'\"title\"'*) echo '" + titleAnswer + "' ;;",
    "    *) echo '" + briefAnswer + "' ;;",
    '  esac',
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(fakeBin, 0o755)

  const RELAY_TOKEN = 'fanout-harness-token'
  const child = spawn(process.execPath, [join(ROOT, 'syzygy', 'bridge', 'relay.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, SZG_PORT: '0', SZG_TOKEN: RELAY_TOKEN, SZG_DATA_DIR: dataDir, SZG_CLAUDE_BIN: fakeBin,
      SZG_TMUX_BIN: '/usr/bin/false', SZG_PANE_PASSWORD_DISABLED: '1', SZG_SCOPE_POLL_MS: '300',
      SZG_CLAUDE_PROJECTS_DIR: projectsDir,
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
    setTimeout(() => reject(new Error('relay did not report a port in time')), 8000)
  })
  const base = `http://127.0.0.1:${port}`
  const post = async (path, body = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: RELAY_TOKEN, ...body }) })
    const j = await r.json().catch(() => ({}))
    return { status: r.status, ...j }
  }
  const get = async (path) => (await fetch(base + path)).json()
  // Poll rather than sleep: a child answers when it answers, and a fixed sleep
  // is either slow or flaky.
  const until = async (fn, ms = 5000) => {
    const stop = Date.now() + ms
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > stop) throw new Error('timed out waiting')
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  const requestById = async (id) => (await get('/api/state')).dispatch.requests.find((x) => x.id === id)
  const scopeDir = tmp()

  try {
    await ok('relay: POST /api/fanout starts exactly one run and refuses a second', async () => {
      writeFileSync(holdFile, '')
      const a = await post('/api/fanout', { ask: 'one\n\ntwo' })
      assert.equal(a.status, 200)
      assert.equal(a.ok, true)
      assert.equal(a.run.state, 'running')
      const b = await post('/api/fanout', { ask: 'three' })
      assert.equal(b.status, 409, 'one fan-out child at a time')
      const state = await get('/api/state')
      assert.equal(state.fanout.runs.length, 1)
      assert.ok(state.payloadVersion >= 8, 'the payload version moved with the new key')
      unlinkSync(holdFile)
    })

    await ok('relay: an over-long ask is refused before any child is spawned', async () => {
      const r = await post('/api/fanout', { ask: 'x'.repeat(F.FANOUT_ASK_MAX + 1) })
      assert.equal(r.status, 400)
      assert.match(r.error, /20000/, 'the refusal names the limit')
      assert.equal((await post('/api/fanout', { ask: '  \n ' })).status, 400, 'a blank ask is refused too')
    })

    await ok('relay: accept turns drafts into ordinary requests, grouped', async () => {
      const run = await until(async () => {
        const s = await get('/api/state')
        const r = s.fanout.runs[s.fanout.runs.length - 1]
        return r?.state === 'ready' ? r : null
      })
      assert.equal(run.drafts.length, 2)
      for (const d of run.drafts) {
        assert.equal(d.projectKey, '', 'an unknown project is cleared')
        assert.ok(d.reason, 'and the draft says why')
      }
      const r = await post('/api/fanout/accept', { runId: run.id, draftIds: run.drafts.map((d) => d.id).reverse() })
      assert.equal(r.status, 200)
      assert.equal(r.ok, true)
      const s = await get('/api/state')
      const made = s.dispatch.requests.filter((x) => x.fanout)
      assert.equal(made.length, 2)
      assert.equal(made[0].fanout.id, run.id, 'the group id is the run id')
      assert.equal(made[0].fanout.id, made[1].fanout.id, 'one group')
      assert.deepEqual(made.map((x) => x.fanout.n).sort(), [1, 2])
      assert.equal(made.find((x) => x.fanout.n === 1).title, 'Alpha', 'n follows run order, not the order ids were sent in')
      assert.equal(made[0].fanout.of, 2)
      for (const m of made) {
        assert.equal(m.state, 'draft')
        assert.equal(m.titleSource, 'auto')
        assert.equal(m.project, '')
      }
      assert.equal(made.find((x) => x.title === 'Beta').ask, 'two', 'a draft ask is its own paragraphs')
      assert.equal(s.fanout.runs.find((x) => x.id === run.id).state, 'accepted')
    })

    await ok('relay: a finished run refuses assign and discard; an unknown one is 404', async () => {
      const s = await get('/api/state')
      const run = s.fanout.runs.find((x) => x.state === 'accepted')
      const a = await post('/api/fanout/assign', { runId: run.id, draftId: run.drafts[0].id, index: 1, mode: 'copy' })
      assert.equal(a.status, 409)
      assert.equal((await post('/api/fanout/discard', { runId: run.id })).status, 409)
      assert.equal((await post('/api/fanout/discard', { runId: 'nope' })).status, 404)
      assert.equal((await post('/api/fanout/accept', { runId: run.id, draftIds: [run.drafts[0].id] })).status, 409)
    })

    await ok('relay: a browser cannot forge a fanout group on a hand-made request', async () => {
      const r = await post('/api/request/create', { title: 't', ask: 'x', fanout: { id: 'forged', n: 1, of: 1 } })
      assert.equal(r.status, 200)
      assert.equal(r.request.fanout, null, 'the group id is minted by the relay from a run')
      assert.equal(r.request.titleSource, 'manual')
    })

    await ok('relay: create derives a title from the ask when none is typed', async () => {
      const r = await post('/api/request/create', { ask: 'ok so i want to add a fan-out box' })
      assert.equal(r.status, 200)
      assert.equal(r.request.title, 'add a fan-out box')
      assert.equal(r.request.titleSource, 'auto')
      const blank = await post('/api/request/create', { ask: '' })
      assert.equal(blank.status, 400, 'a request with neither a title nor an ask is still refused')
    })

    await ok('relay: update accepts relatesTo and still refuses the dispatcher-owned keys', async () => {
      const r = await post('/api/request/create', { title: 't2', ask: 'x' })
      const u = await post('/api/request/update', { id: r.request.id, patch: {
        relatesTo: { kind: 'plan', ref: 'x.md' },
        session: { shortId: 'evil' },
      } })
      assert.equal(u.status, 200)
      const got = await requestById(r.request.id)
      assert.deepEqual(got.relatesTo, { kind: 'plan', ref: 'x.md' })
      assert.equal(got.session, null, 'session stays dispatcher-owned')
    })

    await ok('relay: /api/scope starts a live session and /api/scope/end stops it', async () => {
      const c = await post('/api/request/create', { title: 'scope me', ask: 'x', project: scopeDir })
      const id = c.request.id
      const s = await post('/api/scope', { id, text: 'hi' })
      assert.equal(s.status, 200, `scope refused: ${s.error}`)
      assert.equal(s.ok, true)
      assert.equal((await requestById(id)).scoping.session.shortId, 'ab12')
      assert.ok(readFileSync(bgFile, 'utf8').split('\n').includes('--bg'), 'the scoping session was spawned with --bg')
      const e = await post('/api/scope/end', { id })
      assert.equal(e.status, 200)
      assert.equal(e.ok, true)
      assert.ok(readFileSync(stopsFile, 'utf8').split('\n').includes('ab12'), 'claude stop was run on the session')
      assert.equal((await requestById(id)).scoping.session.endedReason, 'ended by hand')
      assert.equal((await post('/api/scope/end', { id: 'nope' })).status, 404)
    })

    await ok('relay: taking over a live scoping session attaches rather than resuming', async () => {
      const c = await post('/api/request/create', { title: 'take me', ask: 'x', project: scopeDir })
      const id = c.request.id
      assert.equal((await post('/api/scope', { id, text: 'hi' })).ok, true)
      const t = await post('/api/takeover', { id })
      assert.equal(t.status, 409, 'SZG_TMUX_BIN is /usr/bin/false, so no window opens')
      assert.ok(t.command.endsWith('attach ab12'), `command was: ${t.command}`)
      const got = await requestById(id)
      assert.equal('continuedInTerminal' in got.scoping, false, 'a failed take-over records nothing')
    })

    await ok('relay: the scoping poller fills the session id from the listing', async () => {
      writeFileSync(agentsFile, JSON.stringify([{ id: 'ab12', sessionId: 'sess-ab12', state: 'working' }]))
      const c = await post('/api/request/create', { title: 'poll me', ask: 'x', project: scopeDir })
      const id = c.request.id
      assert.equal((await post('/api/scope', { id, text: 'hi' })).ok, true)
      const got = await until(async () => {
        const r = await requestById(id)
        return r?.scoping?.session?.sessionId === 'sess-ab12' ? r : null
      })
      assert.equal(got.scoping.session.state, 'working')
    })
  } catch (e) {
    process.stderr.write(`relay stderr:\n${stderrText}\n`)
    throw e
  } finally {
    try { if (existsSync(holdFile)) unlinkSync(holdFile) } catch {}
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)) }
  }
}

// ---- relay-level: CLAUDE_BIN reaches every construction site as null ------
// pickClaudeBin already answers null for an incapable binary; that is not
// what broke. What broke was relay.mjs's OWN construction sites papering over
// that null with a `|| 'claude'` literal, so the scoper, the dispatcher and
// the night runner spawned against whatever `claude` happened to be on PATH
// instead of refusing. Grep-based, per the exported-table alternative: pin
// each construction site's exact source line so the fallback cannot come
// back unnoticed, then boot a real relay against /usr/bin/false and read its
// own 503 as proof CLAUDE_BIN really does resolve to null end to end.
await ok('relay.mjs forwards CLAUDE_BIN bare to the scoper, the dispatcher and the night runner', () => {
  const src = readFileSync(join(ROOT, 'syzygy', 'bridge', 'relay.mjs'), 'utf8')
  const sites = {
    scoper: 'store: requests, broadcast, claudeBin: CLAUDE_BIN, safeMode: CLAUDE_SAFE_MODE,',
    dispatcher: 'const dispatcher = createDispatcher({ store: requests, broadcast, claudeBin: CLAUDE_BIN,',
    nightRunner: 'run: realRun, canvas: world.canvas, claudeBin: CLAUDE_BIN, now,',
  }
  for (const [label, line] of Object.entries(sites)) {
    assert.ok(src.includes(line), `${label}'s construction site must read exactly: ${line}`)
    assert.ok(!src.includes(line.replace('claudeBin: CLAUDE_BIN', "claudeBin: CLAUDE_BIN || 'claude'")),
      `${label} must never fall back to the bare string 'claude'`)
  }
})

await ok('relay: with SZG_CLAUDE_BIN=/usr/bin/false, CLAUDE_BIN is null and the scoper-gated routes 503', async () => {
  const { spawn } = await import('node:child_process')
  const { realpathSync, rmSync } = await import('node:fs')
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'szg-nobin-relay-')))
  const RELAY_TOKEN = 'nobin-harness-token'
  const child = spawn(process.execPath, [join(ROOT, 'syzygy', 'bridge', 'relay.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, SZG_PORT: '0', SZG_TOKEN: RELAY_TOKEN, SZG_DATA_DIR: dataDir,
      SZG_CLAUDE_BIN: '/usr/bin/false', SZG_TMUX_BIN: '/usr/bin/false', SZG_PANE_PASSWORD_DISABLED: '1',
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
      setTimeout(() => reject(new Error('relay did not report a port in time')), 8000)
    })
    const base = `http://127.0.0.1:${port}`
    const post = async (path, body = {}) => {
      const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: RELAY_TOKEN, ...body }) })
      const j = await r.json().catch(() => ({}))
      return { status: r.status, ...j }
    }
    // /api/fanout is gated on `!CLAUDE_BIN` before the scoper is ever asked to
    // do anything -- the same fact the scoper's own createScoper(claudeBin)
    // now refuses on internally, proven directly above.
    const out = await post('/api/fanout', { ask: 'a'.repeat(20) })
    assert.equal(out.status, 503)
    assert.match(String(out.error ?? ''), /no claude binary with --bg was found/)
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)) }
    rmSync(dataDir, { recursive: true, force: true })
  }
})

console.log(`fanout: ${pass} ok`)
