// Drives bridge/requests.mjs against a temp directory. Hermetic: no network,
// no `claude` invocation, no relay. Run: node test/dispatch-harness.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { slugify, canTransition, createStore, SLUG_RE, validateProject } =
  await import(join(ROOT, 'syzygy', 'bridge', 'requests.mjs'))

const dir = mkdtempSync(join(tmpdir(), 'szg-dispatch-'))
// A REAL directory for every scoping test's cwd. A scoping turn checks its
// cwd before spawning, because node reports a missing cwd as `spawn ... ENOENT`
// and that reads exactly like the binary being missing -- so a fixture naming a
// directory nobody created could not catch the bug it stands in for.
const RDIR = join(dir, 'project-root')
mkdirSync(RDIR, { recursive: true })
const file = join(dir, 'dispatch.json')
let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }

// ---- slugs ------------------------------------------------------------------
await ok('slugify lowercases and hyphenates', () => {
  assert.equal(slugify('Add a Dispatch Tab'), 'add-a-dispatch-tab')
})
await ok('slugify collapses punctuation and trims hyphens', () => {
  assert.equal(slugify('  GRID — second pass!! '), 'grid-second-pass')
})
await ok('slugify uniquifies against taken slugs', () => {
  assert.equal(slugify('scoping', ['scoping']), 'scoping-2')
  assert.equal(slugify('scoping', ['scoping', 'scoping-2']), 'scoping-3')
})
await ok('slugify output always satisfies SLUG_RE', () => {
  for (const t of ['../../etc/passwd', '-leading', '9lives', 'ALLCAPS', 'a'.repeat(80), '!!!', '']) {
    assert.match(slugify(t), SLUG_RE, `slugify(${JSON.stringify(t)}) = ${slugify(t)}`)
  }
})

// ---- state machine ----------------------------------------------------------
await ok('legal transitions are allowed', () => {
  assert.equal(canTransition('draft', 'scoped'), true)
  assert.equal(canTransition('queued', 'dispatched'), true)
  assert.equal(canTransition('planned', 'implementing'), true)
})
await ok('illegal transitions are refused', () => {
  assert.equal(canTransition('draft', 'dispatched'), false)
  assert.equal(canTransition('done', 'queued'), false)
  assert.equal(canTransition('queued', 'planned'), false)
})

// ---- store ------------------------------------------------------------------
await ok('create assigns id, slug, state draft and timestamps', () => {
  const s = createStore({ file, now: () => 1000 })
  const r = s.create({ title: 'Add a Dispatch Tab', project: '/repo', ask: 'i want a thing' })
  assert.equal(r.state, 'draft')
  assert.equal(r.slug, 'add-a-dispatch-tab')
  assert.equal(r.ask, 'i want a thing')
  assert.equal(r.createdAt, 1000)
  assert.ok(r.id)
})
await ok('slugs are unique within a project but may repeat across projects', () => {
  const s = createStore({ file: join(dir, 'a.json') })
  s.create({ title: 'Same', project: '/one' })
  const b = s.create({ title: 'Same', project: '/one' })
  const c = s.create({ title: 'Same', project: '/two' })
  assert.equal(b.slug, 'same-2')
  assert.equal(c.slug, 'same')
})
await ok('transition to planned without a plan path is refused', () => {
  const s = createStore({ file: join(dir, 'b.json') })
  const r = s.create({ title: 'x', project: '/repo' })
  s.transition(r.id, 'queued'); s.transition(r.id, 'dispatched')
  assert.throws(() => s.transition(r.id, 'planned'), /planPath/)
  s.transition(r.id, 'planned', { artifacts: { planPath: 'docs/plans/x.md' } })
  assert.equal(s.get(r.id).state, 'planned')
})
await ok('an illegal transition throws and leaves state alone', () => {
  const s = createStore({ file: join(dir, 'c.json') })
  const r = s.create({ title: 'x', project: '/repo' })
  assert.throws(() => s.transition(r.id, 'done'), /draft -> done/)
  assert.equal(s.get(r.id).state, 'draft')
})
await ok('reorder moves the listed ids to the front in order', () => {
  const s = createStore({ file: join(dir, 'd.json') })
  const a = s.create({ title: 'a', project: RDIR })
  const b = s.create({ title: 'b', project: RDIR })
  const c = s.create({ title: 'c', project: RDIR })
  s.reorder([c.id, a.id])
  assert.deepEqual(s.all().map((x) => x.title), ['c', 'a', 'b'])
})

// ---- persistence ------------------------------------------------------------
await ok('flush writes atomically and reloads identically', () => {
  const f = join(dir, 'e.json')
  const s = createStore({ file: f })
  const r = s.create({ title: 'persisted', project: RDIR, ask: 'keep me' })
  s.flush()
  assert.ok(existsSync(f))
  assert.equal(existsSync(f + '.tmp'), false, 'temp file must not survive')
  const again = createStore({ file: f })
  assert.equal(again.get(r.id).ask, 'keep me')
})
await ok('a failed serialize leaves the previous file intact', () => {
  const f = join(dir, 'g.json')
  const s = createStore({ file: f })
  s.create({ title: 'good', project: RDIR })
  s.flush()
  const before = readFileSync(f, 'utf8')
  const bad = s.create({ title: 'bad', project: RDIR })
  bad.self = bad                                  // circular: JSON.stringify throws
  assert.throws(() => s.flush())
  assert.equal(readFileSync(f, 'utf8'), before, 'the good file must survive')
})
await ok('a corrupt file loads as empty rather than throwing', () => {
  const f = join(dir, 'h.json')
  writeFileSync(f, '{ not json')
  const s = createStore({ file: f })
  assert.deepEqual(s.all(), [])
})
// this store is authoritative (see the file header) and the 4 s flush
// timer overwrites the file on the very next tick -- so "load as empty"
// alone is not enough; the ORIGINAL bytes must survive somewhere, or a
// corrupt-on-disk file becomes an empty queue with no way back.
await ok('a corrupt file is moved aside, never destroyed, and a missing file is not treated as corruption', () => {
  const corruptDir = mkdtempSync(join(tmpdir(), 'szg-corrupt-'))
  const f = join(corruptDir, 'dispatch.json')
  writeFileSync(f, '{ not json')
  const origWrite = process.stderr.write
  let stderrText = ''
  process.stderr.write = (chunk) => { stderrText += chunk; return true }
  let s
  try {
    s = createStore({ file: f, now: () => 1234 })
  } finally {
    process.stderr.write = origWrite
  }
  assert.deepEqual(s.all(), [])
  assert.equal(existsSync(f), false, 'the corrupt file no longer sits at the live path')
  const siblings = readdirSync(corruptDir).filter((n) => n.startsWith('dispatch.json.corrupt-'))
  assert.equal(siblings.length, 1, 'exactly one .corrupt-* sibling was written')
  assert.equal(readFileSync(join(corruptDir, siblings[0]), 'utf8'), '{ not json', 'the original bytes are preserved verbatim')
  assert.match(stderrText, /failed to load/)
  assert.match(stderrText, new RegExp(siblings[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'stderr names the moved-aside path')
  rmSync(corruptDir, { recursive: true, force: true })

  // A file that simply does not exist (first run, fresh worktree) is not
  // corruption: nothing to move aside, nothing worth warning about.
  const freshDir = mkdtempSync(join(tmpdir(), 'szg-fresh-'))
  const nf = join(freshDir, 'dispatch.json')
  let stderrText2 = ''
  process.stderr.write = (chunk) => { stderrText2 += chunk; return true }
  let s2
  try {
    s2 = createStore({ file: nf })
  } finally {
    process.stderr.write = origWrite
  }
  assert.deepEqual(s2.all(), [])
  assert.equal(stderrText2, '', 'a merely-missing file must not be reported as corruption')
  rmSync(freshDir, { recursive: true, force: true })
})

// ---- relay endpoint contract ------------------------------------------------
// The relay is not started here; these assert the SHAPE the endpoints must
// return, so the handler and the harness cannot drift apart silently.
await ok('a request serializes to the keys the pane reads', () => {
  const s = createStore({ file: join(dir, 'i.json') })
  const r = s.create({ title: 'shape', project: RDIR, ask: 'a' })
  for (const k of ['id', 'state', 'project', 'title', 'slug', 'ask', 'brief',
                   'scoping', 'dispatch', 'session', 'artifacts', 'error',
                   'createdAt', 'updatedAt']) {
    assert.ok(k in r, `missing key: ${k}`)
  }
})
await ok('update cannot smuggle a state change', () => {
  const s = createStore({ file: join(dir, 'j.json') })
  const r = s.create({ title: 'x', project: RDIR })
  s.update(r.id, { state: 'done', title: 'renamed' })
  assert.equal(s.get(r.id).state, 'draft')
  assert.equal(s.get(r.id).title, 'renamed')
})
await ok('update merges a brief rather than replacing it', () => {
  const s = createStore({ file: join(dir, 'k.json') })
  const r = s.create({ title: 'x', project: RDIR, brief: s.emptyBrief() })
  s.update(r.id, { brief: { goal: 'a goal' } })
  assert.equal(s.get(r.id).brief.goal, 'a goal')
  assert.deepEqual(s.get(r.id).brief.nonGoals, [], 'other brief fields survive')
})

// ---- patch sanitization (prototype pollution) --------------------------------
// A patch is caller-supplied JSON reaching Object.assign; these pin the store's
// own guard against a hostile shape, independent of any endpoint-side check.
await ok('update ignores a __proto__ key in the patch', () => {
  const s = createStore({ file: join(dir, 'l.json') })
  const r = s.create({ title: 'x', project: RDIR })
  const evil = JSON.parse('{"__proto__":{"polluted":true},"title":"renamed"}')
  s.update(r.id, evil)
  assert.equal(Object.getPrototypeOf(s.get(r.id)), Object.prototype)
  assert.equal(({}).polluted, undefined, 'Object.prototype must be untouched')
  assert.equal(s.get(r.id).title, 'renamed', 'the rest of the patch still applies')
})
await ok('update ignores a constructor key in the patch', () => {
  const s = createStore({ file: join(dir, 'm.json') })
  const r = s.create({ title: 'x', project: RDIR })
  s.update(r.id, { constructor: 'evil', title: 'renamed' })
  assert.equal(s.get(r.id).constructor, Object)
  assert.equal(s.get(r.id).title, 'renamed')
})
await ok('update ignores non-object patches without throwing or mutating', () => {
  const s = createStore({ file: join(dir, 'n.json') })
  const r = s.create({ title: 'x', project: RDIR })
  const before = JSON.stringify(s.get(r.id))
  assert.doesNotThrow(() => s.update(r.id, null))
  assert.doesNotThrow(() => s.update(r.id, [1, 2]))
  assert.doesNotThrow(() => s.update(r.id, 'nope'))
  assert.equal(JSON.stringify(s.get(r.id)), before, 'no field, including updatedAt, changed')
})
await ok('transition ignores __proto__ and constructor keys but still moves state', () => {
  const s = createStore({ file: join(dir, 'o.json') })
  const r = s.create({ title: 'x', project: RDIR })
  const evil = JSON.parse('{"__proto__":{"polluted":true},"constructor":"evil"}')
  s.transition(r.id, 'scoped', evil)
  assert.equal(s.get(r.id).state, 'scoped')
  assert.equal(Object.getPrototypeOf(s.get(r.id)), Object.prototype)
  assert.equal(({}).polluted, undefined, 'Object.prototype must be untouched')
  assert.equal(s.get(r.id).constructor, Object)
  assert.throws(() => s.transition(r.id, 'done', evil), /illegal transition/,
    'a malformed patch does not bypass the state table')
})
await ok('transition tolerates non-object patches without throwing or corrupting the record', () => {
  const s = createStore({ file: join(dir, 'p.json') })
  const r = s.create({ title: 'x', project: RDIR })
  assert.doesNotThrow(() => s.transition(r.id, 'scoped', null))
  assert.equal(s.get(r.id).state, 'scoped')
  assert.doesNotThrow(() => s.transition(r.id, 'queued', [1, 2]))
  assert.equal(s.get(r.id).state, 'queued')
  assert.doesNotThrow(() => s.transition(r.id, 'dispatched', 'nope'))
  assert.equal(s.get(r.id).state, 'dispatched')
  assert.equal(s.get(r.id)['0'], undefined, 'a string/array patch must not spray indexed keys')
  assert.throws(() => s.transition(r.id, 'done', null), /illegal transition/,
    'the state table is still enforced with a non-object patch')
})
await ok('a normal patch still merges through update and transition as before', () => {
  const s = createStore({ file: join(dir, 'q.json') })
  const r = s.create({ title: 'x', project: RDIR })
  s.update(r.id, { title: 'renamed', ask: 'updated ask' })
  assert.equal(s.get(r.id).title, 'renamed')
  assert.equal(s.get(r.id).ask, 'updated ask')
  const t = s.transition(r.id, 'scoped', { scoping: { note: 'ok' } })
  assert.equal(t.state, 'scoped')
  assert.equal(s.get(r.id).scoping.note, 'ok')
})

// ---- scoping: the pure halves ----------------------------------------------
const { parseNdjson, scopeArgv, BRIEF_SCHEMA, SCOPING_PREAMBLE } =
  await import(join(ROOT, 'syzygy', 'bridge', 'scoping.mjs'))

await ok('parseNdjson emits complete lines and returns the remainder', () => {
  const seen = []
  const rest = parseNdjson('{"a":1}\n{"b":2}\n{"c":', (o) => seen.push(o))
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }])
  assert.equal(rest, '{"c":')
})
await ok('parseNdjson skips blank lines', () => {
  const seen = []
  parseNdjson('{"a":1}\n\n\n{"b":2}\n', (o) => seen.push(o))
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }])
})
await ok('parseNdjson survives a non-JSON line rather than throwing', () => {
  const seen = []
  assert.doesNotThrow(() => parseNdjson('not json\n{"a":1}\n', (o) => seen.push(o)))
  assert.deepEqual(seen, [{ a: 1 }], 'the good line still arrives')
})
await ok('parseNdjson handles a line split across two chunks', () => {
  const seen = []
  let rest = parseNdjson('{"half":', (o) => seen.push(o))
  rest = parseNdjson(rest + 'true}\n', (o) => seen.push(o))
  assert.deepEqual(seen, [{ half: true }])
  assert.equal(rest, '')
})
await ok('parseNdjson propagates exceptions thrown by onEvent', () => {
  assert.throws(
    () => parseNdjson('{"a":1}\n', () => { throw new Error('consumer error') }),
    /consumer error/
  )
})
await ok('parseNdjson skips malformed lines but still processes good ones', () => {
  const seen = []
  parseNdjson('not json\n{"a":1}\n', (o) => seen.push(o))
  assert.deepEqual(seen, [{ a: 1 }], 'good line reaches onEvent after malformed line')
})
await ok('parseNdjson skips malformed lines even if onEvent would throw on the next good one', () => {
  const seen = []
  assert.throws(
    () => parseNdjson('not json\n{"a":1}\n', (o) => {
      seen.push(o)
      throw new Error('intentional throw')
    }),
    /intentional throw/
  )
  assert.deepEqual(seen, [{ a: 1 }], 'the good line was processed before the throw')
})

await ok('scopeArgv builds a first turn with no --resume', () => {
  const a = scopeArgv({ text: 'i want a thing', model: 'opus', budgetUsd: 2 })
  assert.equal(a.includes('--resume'), false)
  assert.deepEqual(a.slice(0, 2), ['-p', '--output-format'])
  assert.ok(a.includes('stream-json'))
  assert.ok(a.includes('--max-budget-usd') && a.includes('2'))
  assert.equal(a[a.length - 1], 'i want a thing', 'the prompt is the last argv element')
})
await ok('scopeArgv resumes when given a session id', () => {
  const a = scopeArgv({ text: 'more', sessionId: 'abc-123' })
  const i = a.indexOf('--resume')
  assert.ok(i > 0)
  assert.equal(a[i + 1], 'abc-123')
})
await ok('scopeArgv in schema mode asks for json, not stream-json', () => {
  const a = scopeArgv({ text: 'emit it', sessionId: 'abc', schema: BRIEF_SCHEMA })
  assert.ok(a.includes('json') && !a.includes('stream-json'))
  const i = a.indexOf('--json-schema')
  assert.ok(i > 0)
  assert.deepEqual(JSON.parse(a[i + 1]), BRIEF_SCHEMA)
})
await ok('scopeArgv never splits the prompt across argv elements', () => {
  const nasty = 'a "quoted" thing; rm -rf /; $(whoami)\nand a newline'
  const a = scopeArgv({ text: nasty })
  assert.equal(a.filter((x) => x === nasty).length, 1)
  assert.equal(a[a.length - 1], nasty)
})
// Same contract as askArgv's, and asserted here too rather than trusted to be
// shared: the two builders are separate functions and a change to one is
// exactly what would silently put a scoping child back on the board.
await ok('scopeArgv always tells the child it is headless, on the argv', () => {
  for (const a of [scopeArgv({ text: 'x' }), scopeArgv({ text: 'x', sessionId: 'z' })]) {
    const i = a.indexOf('--settings')
    assert.ok(i !== -1, 'no --settings on the argv')
    assert.deepEqual(JSON.parse(a[i + 1]), { env: { SZG_HEADLESS: '1' } })
    assert.equal(a[a.length - 1], 'x')
  }
})

await ok('scopeArgv passes --safe-mode only when the binary was probed for it', () => {
  assert.ok(!scopeArgv({ text: 'x' }).includes('--safe-mode'), 'not by default')
  const on = scopeArgv({ text: 'x', safeMode: true })
  assert.ok(on.includes('--safe-mode'))
  assert.equal(on[on.length - 1], 'x', 'the prompt is still the last element')
})

await ok('BRIEF_SCHEMA requires a goal and nothing surprising', () => {
  assert.equal(BRIEF_SCHEMA.type, 'object')
  assert.deepEqual(BRIEF_SCHEMA.required, ['goal'])
  for (const k of ['goal', 'nonGoals', 'constraints', 'research', 'successCriteria', 'openQuestions']) {
    assert.ok(k in BRIEF_SCHEMA.properties, `schema missing ${k}`)
  }
})
await ok('the preamble forbids writing files and demands one question at a time', () => {
  assert.match(SCOPING_PREAMBLE, /one question at a time/i)
  assert.match(SCOPING_PREAMBLE, /do not write/i)
})

// ---- scoping: the child manager --------------------------------------------
const { createScoper } = await import(join(ROOT, 'syzygy', 'bridge', 'scoping.mjs'))

/** A fake child process. Nothing is executed; the test drives stdout by hand. */
const fakeSpawn = (calls) => (bin, argv, opts) => {
  const listeners = { stdout: [], stderr: [], close: [], error: [] }
  const child = {
    killed: false,
    stdout: { setEncoding() {}, on(_e, f) { listeners.stdout.push(f) } },
    stderr: { setEncoding() {}, on(_e, f) { listeners.stderr.push(f) } },
    on(e, f) { if (e === 'close') listeners.close.push(f); else if (e === 'error') listeners.error.push(f) },
    kill() { this.killed = true; for (const f of listeners.close) f(143) },
    emit(text) { for (const f of listeners.stdout) f(text) },
    finish(code = 0) { for (const f of listeners.close) f(code) },
    emitError(err) { for (const f of listeners.error) f(err) },
  }
  calls.push({ bin, argv, opts, child })
  return child
}

await ok('start spawns claude with the scoping argv and streams frames out', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'sc1.json') })
  const r = store.create({ title: 'x', project: RDIR })
  const sent = []
  const sc = createScoper({ store, broadcast: (t, d) => sent.push([t, d]), spawn: fakeSpawn(calls) })
  const started = await sc.start(r.id, 'i want a thing', RDIR)
  assert.equal(started.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].opts.cwd, RDIR)
  assert.equal(calls[0].argv[calls[0].argv.length - 1], 'i want a thing')
  calls[0].child.emit('{"type":"system","session_id":"sess-1"}\n')
  calls[0].child.emit('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n')
  assert.ok(sent.some(([t]) => t === 'scope'), 'frames are broadcast')
  assert.equal(store.get(r.id).scoping.sessionId, 'sess-1', 'the session id is captured')
  calls[0].child.finish(0)
})
await ok('a second turn resumes rather than starting fresh', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'sc2.json') })
  const r = store.create({ title: 'x', project: RDIR })
  const sc = createScoper({ store, broadcast: () => {}, spawn: fakeSpawn(calls) })
  await sc.start(r.id, 'first', RDIR)
  calls[0].child.emit('{"type":"system","session_id":"sess-9"}\n')
  calls[0].child.finish(0)
  await sc.start(r.id, 'second', RDIR)
  const i = calls[1].argv.indexOf('--resume')
  assert.ok(i > 0)
  assert.equal(calls[1].argv[i + 1], 'sess-9')
})
await ok('the concurrency cap refuses with 429 rather than queueing', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'sc3.json') })
  const ids = [1, 2, 3, 4].map(() => store.create({ title: 'x', project: RDIR }).id)
  const sc = createScoper({ store, broadcast: () => {}, spawn: fakeSpawn(calls), maxConcurrent: 3 })
  for (const id of ids.slice(0, 3)) assert.equal((await sc.start(id, 't', RDIR)).ok, true)
  const refused = await sc.start(ids[3], 't', RDIR)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 429)
  assert.equal(sc.active(), 3)
})
await ok('a finished child frees its slot', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'sc4.json') })
  const r = store.create({ title: 'x', project: RDIR })
  const sc = createScoper({ store, broadcast: () => {}, spawn: fakeSpawn(calls), maxConcurrent: 1 })
  await sc.start(r.id, 't', RDIR)
  assert.equal(sc.active(), 1)
  calls[0].child.finish(0)
  assert.equal(sc.active(), 0)
})
await ok('killAll kills every live child', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'sc5.json') })
  const a = store.create({ title: 'a', project: RDIR }).id
  const b = store.create({ title: 'b', project: RDIR }).id
  const sc = createScoper({ store, broadcast: () => {}, spawn: fakeSpawn(calls) })
  await sc.start(a, 't', RDIR); await sc.start(b, 't', RDIR)
  sc.killAll()
  assert.ok(calls.every((c) => c.child.killed), 'every child was killed')
  assert.equal(sc.active(), 0)
})
await ok('a rejected brief leaves the request scoped with an error, never half-written', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'sc6.json') })
  const r = store.create({ title: 'x', project: RDIR })
  store.transition(r.id, 'scoped')
  store.update(r.id, { scoping: { sessionId: 'sess-2', turns: [], costUsd: 0 } })
  const sc = createScoper({ store, broadcast: () => {}, spawn: fakeSpawn(calls) })
  const p = sc.bank(r.id, RDIR)
  calls[0].child.emit(JSON.stringify({ type: 'result', result: '{"nonGoals":["no goal key"]}' }) + '\n')
  calls[0].child.finish(0)
  const res = await p
  assert.equal(res.ok, false)
  assert.equal(store.get(r.id).state, 'scoped', 'state is unchanged')
  assert.equal(store.get(r.id).brief, null, 'no half-brief was written')
  assert.match(store.get(r.id).error.message, /goal/)
})
await ok('a valid brief is banked and the request becomes queued', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'sc7.json') })
  const r = store.create({ title: 'x', project: RDIR })
  store.transition(r.id, 'scoped')
  store.update(r.id, { scoping: { sessionId: 'sess-3', turns: [], costUsd: 0 } })
  const sc = createScoper({ store, broadcast: () => {}, spawn: fakeSpawn(calls) })
  const p = sc.bank(r.id, RDIR)
  calls[0].child.emit(JSON.stringify({
    type: 'result',
    result: JSON.stringify({ goal: 'a real goal', successCriteria: ['it works'] }),
  }) + '\n')
  calls[0].child.finish(0)
  const res = await p
  assert.equal(res.ok, true)
  assert.equal(store.get(r.id).state, 'queued')
  assert.equal(store.get(r.id).brief.goal, 'a real goal')
  assert.deepEqual(store.get(r.id).brief.nonGoals, [], 'absent arrays default to empty')
})
// C2: `store.get(requestId).state !== 'queued'` was the only unguarded
// `store.get(...).` dereference in the tree. A request's delete button is
// always enabled, including while its bank turn is in flight (minutes), so
// deleting it mid-turn used to throw a TypeError here -- inside an async
// HTTP handler with no try/catch, which becomes an unhandled rejection and
// exits the whole relay process, taking every session's dashboard down.
await ok('a bank turn whose request is deleted mid-flight resolves without throwing', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'sc7b.json') })
  const r = store.create({ title: 'x', project: RDIR })
  store.transition(r.id, 'scoped')
  store.update(r.id, { scoping: { sessionId: 'sess-3b', turns: [], costUsd: 0 } })
  const sc = createScoper({ store, broadcast: () => {}, spawn: fakeSpawn(calls) })
  const p = sc.bank(r.id, RDIR)
  // Delete the request while the bank turn is still running -- the CLI
  // child has not closed yet, mirroring a user clicking the row's ✕ mid-turn.
  assert.ok(store.remove(r.id), 'the request existed and is now gone')
  calls[0].child.emit(JSON.stringify({
    type: 'result',
    result: JSON.stringify({ goal: 'a real goal for a request that no longer exists' }),
  }) + '\n')
  calls[0].child.finish(0)
  await assert.doesNotReject(p, 'bank() must resolve, never throw or reject, when its request vanishes mid-flight')
  assert.equal(store.get(r.id), null, 'the request stays gone -- nothing resurrects it')
})
await ok('a throwing onFrame (broadcast) does not escape the data handler, and the child can still close', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'sc8.json') })
  const r = store.create({ title: 'x', project: RDIR })
  // start() itself broadcasts a synchronous 'turn-start' event before any
  // frame arrives, and a 'turn-end' event once the child closes; both must
  // succeed so start() and the close handler resolve normally. Only the
  // broadcast made from inside onFrame for the parsed 'system' frame --
  // reached via the stdout 'data' handler -- needs to throw, to prove the
  // data handler survives it.
  const sc = createScoper({
    store,
    broadcast: (t, d) => { if (d?.event?.type === 'system') throw new Error('broadcast blew up') },
    spawn: fakeSpawn(calls),
  })
  const origWrite = process.stderr.write
  let stderrText = ''
  process.stderr.write = (chunk) => { stderrText += chunk; return true }
  try {
    const started = await sc.start(r.id, 'i want a thing', RDIR)
    assert.equal(started.ok, true)
    // This would throw synchronously inside the 'data' listener if unguarded,
    // which Node treats as an uncaught exception and crashes the process.
    assert.doesNotThrow(() => calls[0].child.emit('{"type":"system","session_id":"sess-x"}\n'))
    assert.match(stderrText, new RegExp(r.id), 'stderr names the request id')
    assert.match(stderrText, /broadcast blew up/, 'stderr names the error')
  } finally {
    process.stderr.write = origWrite
  }
  // The child must still be able to close normally afterwards.
  assert.doesNotThrow(() => calls[0].child.finish(0))
  assert.equal(sc.active(), 0)
})
await ok('a spawn error resolves the run as a failure and does not throw out of start()', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'sc9.json') })
  const r = store.create({ title: 'x', project: RDIR })
  const sc = createScoper({ store, broadcast: () => {}, spawn: fakeSpawn(calls) })
  const started = await sc.start(r.id, 't', RDIR)
  assert.equal(started.ok, true, 'start() itself must not throw or refuse')
  // 'error' fires asynchronously in real Node (ENOENT, EACCES, ...), on a
  // path separate from 'close'. With no listener it would re-throw as an
  // uncaught exception; the fake child's synchronous dispatch is enough to
  // prove the listener exists and does not itself throw.
  assert.doesNotThrow(() => calls[0].child.emitError(new Error('spawn ENOENT claude')))
  // The store write happens in start()'s `.then()` on run()'s promise, a
  // microtask away from the synchronous emitError() call above.
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(store.get(r.id).error.message, /spawn failed/)
  assert.match(store.get(r.id).error.message, /ENOENT/)
})
await ok('a spawn error frees its concurrency slot, not permanently consuming it', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'sc10.json') })
  const r = store.create({ title: 'x', project: RDIR })
  const sc = createScoper({ store, broadcast: () => {}, spawn: fakeSpawn(calls), maxConcurrent: 1 })
  await sc.start(r.id, 't', RDIR)
  assert.equal(sc.active(), 1)
  calls[0].child.emitError(new Error('ENOENT'))
  assert.equal(sc.active(), 0, 'the slot is freed synchronously by settle(), not deferred to the close path')
})
await ok("'error' followed by 'close' settles exactly once, keeping the spawn-failure message", async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'sc11.json') })
  const r = store.create({ title: 'x', project: RDIR })
  const sc = createScoper({ store, broadcast: () => {}, spawn: fakeSpawn(calls) })
  await sc.start(r.id, 't', RDIR)
  calls[0].child.emitError(new Error('spawn ENOENT claude'))
  await new Promise((resolve) => setImmediate(resolve))
  const afterError = store.get(r.id).error.message
  assert.match(afterError, /spawn failed/)
  // A 'close' arriving after 'error' must be a no-op on the already-settled
  // promise -- it must not re-run start()'s `.then()` and overwrite the
  // spawn-failure message with an exit-code message.
  assert.doesNotThrow(() => calls[0].child.finish(1))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.get(r.id).error.message, afterError, 'the close path did not re-settle or overwrite the error')
  assert.equal(sc.active(), 0)
})

// ---- dispatch: the pure halves ---------------------------------------------
const {
  parseBackgrounded, renderBrief, worktreePathFor, cardState,
  initialPrompt, IMPLEMENT_PROMPT, ALLOWED_TOOLS,
} = await import(join(ROOT, 'syzygy', 'bridge', 'dispatch.mjs'))

await ok('parseBackgrounded reads the id and name off the real stdout shape', () => {
  const out = [
    'warning: --bg manages the session id; ignoring --session-id (use --resume <id> to continue an existing session)',
    'Starting background service…',
    'backgrounded · 2923cd03 · szg-dispatch-probe',
    '  claude agents             list sessions',
    '  claude attach 2923cd03    open in this terminal',
  ].join('\n')
  assert.deepEqual(parseBackgrounded(out), { shortId: '2923cd03', name: 'szg-dispatch-probe' })
})
await ok('parseBackgrounded returns null when the line never appears', () => {
  assert.equal(parseBackgrounded('some error\nno such flag\n'), null)
})
await ok('parseBackgrounded tolerates a name containing spaces', () => {
  assert.deepEqual(parseBackgrounded('backgrounded · abc12345 · my session'),
    { shortId: 'abc12345', name: 'my session' })
})

await ok('worktreePathFor stays under the project .claude/worktrees', () => {
  assert.equal(worktreePathFor('/repo', 'thing'), '/repo/.claude/worktrees/thing')
})
await ok('worktreePathFor refuses a slug that would escape', () => {
  for (const bad of ['../evil', 'a/b', '/abs', '..', '.', '-lead', 'UPPER', '']) {
    assert.throws(() => worktreePathFor('/repo', bad), /slug/, `accepted ${JSON.stringify(bad)}`)
  }
})

await ok('renderBrief quotes the verbatim ask and every populated field', () => {
  const md = renderBrief({
    title: 'A Thing', slug: 'a-thing', ask: 'i want a thing, badly',
    brief: {
      goal: 'make the thing', nonGoals: ['not that'], constraints: ['no deps'],
      successCriteria: ['it works'], openQuestions: ['which colour?'],
      research: { context7: [{ library: 'react', topic: 'hooks' }], urls: ['https://x.example'], files: ['src/a.js'] },
    },
  })
  assert.match(md, /i want a thing, badly/)
  assert.match(md, /make the thing/)
  assert.match(md, /not that/)
  assert.match(md, /it works/)
  assert.match(md, /which colour\?/)
  assert.match(md, /react/)
  assert.match(md, /https:\/\/x\.example/)
  assert.match(md, /src\/a\.js/)
})
await ok('renderBrief omits empty sections rather than printing empty headings', () => {
  const md = renderBrief({ title: 'T', slug: 't', ask: 'a', brief: { goal: 'g', nonGoals: [], constraints: [], successCriteria: [], openQuestions: [], research: { context7: [], urls: [], files: [] } } })
  assert.equal(/Non-goals/.test(md), false)
  assert.equal(/Open questions/.test(md), false)
})

// the card reads `state` plus whether the plan file exists.
await ok('cardState maps all four dispatched combinations', () => {
  assert.equal(cardState({ state: 'dispatched', agent: { state: 'working' }, planPath: null }), 'working')
  assert.equal(cardState({ state: 'dispatched', agent: { state: 'blocked' }, planPath: null }), 'blocked')
  assert.equal(cardState({ state: 'dispatched', agent: { state: 'blocked' }, planPath: 'p.md' }), 'blocked')
  assert.equal(cardState({ state: 'dispatched', agent: { state: 'done' }, planPath: 'p.md' }), 'plan-ready')
  assert.equal(cardState({ state: 'dispatched', agent: { state: 'done' }, planPath: null }), 'no-plan')
})
await ok('an unrecognised agent state is treated as blocked, never as working', () => {
  // a spurious interruption beats a session stalled all morning.
  assert.equal(cardState({ state: 'dispatched', agent: { state: 'wat' }, planPath: null }), 'blocked')
  assert.equal(cardState({ state: 'dispatched', agent: null, planPath: null }), 'blocked')
})
await ok('an undispatched request is queued regardless of agent noise', () => {
  assert.equal(cardState({ state: 'queued', agent: { state: 'working' }, planPath: null }), 'queued')
})

await ok('the initial prompt orders spec then plan then STOP', () => {
  const p = initialPrompt({ slug: 'a-thing', date: '2025-01-04' })
  assert.match(p, /\.claude\/dispatch\/brief\.md/)
  assert.match(p, /superpowers:brainstorming/)
  assert.match(p, /superpowers:writing-plans/)
  assert.match(p, /docs\/specs\/2025-01-04-a-thing-design\.md/)
  assert.match(p, /docs\/plans\/2025-01-04-a-thing\.md/)
  assert.match(p, /context7/)
  assert.match(p, /do not implement/i)
  assert.ok(p.indexOf('superpowers:brainstorming') < p.indexOf('superpowers:writing-plans'))
})
await ok('the implement prompt names executing-plans and demands commits as it goes', () => {
  assert.match(IMPLEMENT_PROMPT, /superpowers:executing-plans/)
  assert.match(IMPLEMENT_PROMPT, /commit/i)
})
await ok('the allowlist covers what a spec-and-plan session needs and no shell wildcard', () => {
  for (const t of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch']) assert.ok(ALLOWED_TOOLS.includes(t), `missing ${t}`)
  assert.ok(ALLOWED_TOOLS.some((t) => t.startsWith('Bash(git commit')), 'git commit must be allowed')
  assert.equal(ALLOWED_TOOLS.includes('Bash'), false, 'bare Bash must NOT be allowlisted')
})

// ---- dispatch: the dispatcher ----------------------------------------------
const { createDispatcher } = await import(join(ROOT, 'syzygy', 'bridge', 'dispatch.mjs'))

/** Records every command and answers from a scripted table. */
const fakeRun = (script, calls) => async (bin, argv, opts) => {
  calls.push({ bin, argv, opts })
  for (const [match, reply] of script) {
    if ([bin, ...argv].join(' ').includes(match)) return reply
  }
  return { code: 0, stdout: '', stderr: '' }
}

await ok('dispatch creates a worktree, writes the brief and spawns claude in order', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'dp1.json') })
  const proj = mkdtempSync(join(tmpdir(), 'szg-proj-'))
  const r = store.create({ title: 'A Thing', project: proj, ask: 'i want it' })
  store.update(r.id, { brief: { goal: 'g', nonGoals: [], constraints: [], successCriteria: ['s'], openQuestions: [], research: { context7: [], urls: [], files: [] } } })
  store.transition(r.id, 'queued')
  const d = createDispatcher({
    store, broadcast: () => {},
    run: fakeRun([['--bg', { code: 0, stdout: 'Starting background service…\nbackgrounded · aa11bb22 · a-thing\n', stderr: '' }]], calls),
  })
  const out = await d.dispatch([r.id])
  assert.equal(out.dispatched.length, 1)
  const order = calls.map((c) => [c.bin, ...c.argv].join(' '))
  assert.ok(order[0].includes('worktree add'), 'worktree first: ' + order[0])
  assert.ok(order.some((c) => c.includes('worktree lock')))
  assert.ok(order[order.length - 1].includes('--bg'), 'claude last')
  const wt = join(proj, '.claude', 'worktrees', 'a-thing')
  assert.ok(existsSync(join(wt, '.claude', 'dispatch', 'brief.md')), 'brief written into the worktree')
  assert.match(readFileSync(join(wt, '.claude', 'dispatch', 'brief.md'), 'utf8'), /i want it/)
  const after = store.get(r.id)
  assert.equal(after.state, 'dispatched')
  assert.equal(after.session.shortId, 'aa11bb22')
  rmSync(proj, { recursive: true, force: true })
})
await ok('the dispatch spawn strips SZG_* from the child environment', async () => {
  // `claude --bg` does not fork. It hands the request to a long-lived daemon,
  // and that daemon is COLD-STARTED by the first background launch on the
  // machine and keeps THAT launcher's environment for every session after it.
  //
  // So a dispatch spawn carrying the relay's own SZG_* keys is not untidy, it
  // is contagious: if a dispatch is ever the launch that starts the daemon,
  // every later background session on the machine -- a hand-run `claude --bg`,
  // anything the session canvas spawns -- inherits this relay's
  // SZG_RELAY_PORT/SZG_RELAY_TOKEN and quietly registers with the wrong board,
  // or reads another relay's world.json through SZG_DATA_DIR. A live daemon
  // has been observed still holding a port from a relay started hours
  // earlier.
  //
  // canvas.mjs's childEnv() exists for exactly this. dispatch must use it too:
  // the canvas closing its own door is no help if this one stays open.
  const calls = []
  const store = createStore({ file: join(dir, 'dpenv.json') })
  const proj = mkdtempSync(join(tmpdir(), 'szg-proj-'))
  const r = store.create({ title: 'Env', project: proj, ask: 'x' })
  store.transition(r.id, 'queued')

  const saved = { port: process.env.SZG_RELAY_PORT, token: process.env.SZG_RELAY_TOKEN, data: process.env.SZG_DATA_DIR }
  process.env.SZG_RELAY_PORT = '4550'
  process.env.SZG_RELAY_TOKEN = 'dev-token'
  process.env.SZG_DATA_DIR = '/tmp/someone-elses-world'
  try {
    const d = createDispatcher({ store, broadcast: () => {}, run: fakeRun([['--bg', { code: 0, stdout: 'backgrounded · ee55 · env\n', stderr: '' }]], calls) })
    await d.dispatch([r.id])
    const spawn = calls.find((c) => c.argv.includes('--bg'))
    assert.ok(spawn, 'no --bg call was made')
    assert.ok(spawn.opts && spawn.opts.env, 'the spawn passed no env at all, so it inherits every SZG_* key')
    const leaked = Object.keys(spawn.opts.env).filter((k) => k.startsWith('SZG_'))
    assert.deepEqual(leaked, [], 'SZG_* keys reached the child: ' + leaked.join(', '))
    // And it must still be a real environment, not an empty one -- a child with
    // no PATH cannot find git or node.
    assert.ok(spawn.opts.env.PATH, 'PATH was stripped along with the SZG_* keys')
  } finally {
    for (const [k, v] of [['SZG_RELAY_PORT', saved.port], ['SZG_RELAY_TOKEN', saved.token], ['SZG_DATA_DIR', saved.data]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
    rmSync(proj, { recursive: true, force: true })
  }
})
await ok('the spawn argv is a fixed template with no browser input on it', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'dp2.json') })
  const proj = mkdtempSync(join(tmpdir(), 'szg-proj-'))
  const r = store.create({ title: 'Safe', project: proj, ask: '`rm -rf /`; $(whoami)' })
  store.transition(r.id, 'queued')
  const d = createDispatcher({ store, broadcast: () => {}, run: fakeRun([['--bg', { code: 0, stdout: 'backgrounded · cc33 · safe\n', stderr: '' }]], calls) })
  await d.dispatch([r.id])
  const spawnCall = calls.find((c) => c.argv.includes('--bg'))
  assert.equal(spawnCall.argv.some((a) => a.includes('rm -rf')), false, 'the ask never reaches argv')
  assert.ok(spawnCall.argv.includes('--allowedTools'))
  assert.equal(spawnCall.argv.includes('--permission-mode'), false, 'settings are inherited')

  // C1: --allowedTools is variadic -- it consumes every following
  // non-option token. Spreading ALLOWED_TOOLS there (`'--allowedTools',
  // ...ALLOWED_TOOLS, initialPrompt(...)`) swallows the prompt as a 13th
  // "allowed tool" and the session gets no prompt at all (verified live
  // against 2.1.269). Pin both halves of the fix: the prompt is the FINAL
  // argv element, and nothing between --allowedTools and the prompt is an
  // individual tool name -- i.e. --allowedTools takes exactly one joined
  // argument. This must fail against the spread form.
  const argv = spawnCall.argv
  assert.equal(argv[argv.length - 1], argv.at(-1), 'sanity: argv is non-empty')
  assert.match(argv[argv.length - 1], /Read `\.claude\/dispatch\/brief\.md`/, 'the prompt is the final argv element')
  const atIdx = argv.indexOf('--allowedTools')
  assert.ok(atIdx >= 0, '--allowedTools must be present')
  assert.equal(argv.length, atIdx + 3, '--allowedTools, its one value, and the prompt -- nothing else follows')
  assert.equal(argv[atIdx + 1], ALLOWED_TOOLS.join(' '), '--allowedTools takes ONE space-joined argument, never one element per tool')
  for (const t of ALLOWED_TOOLS) {
    assert.notEqual(argv[atIdx + 1], t, `individual tool name "${t}" must not appear as its own argv element after --allowedTools`)
  }
  rmSync(proj, { recursive: true, force: true })
})
await ok('a failed spawn marks the request failed and leaves the worktree alone', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'dp3.json') })
  const proj = mkdtempSync(join(tmpdir(), 'szg-proj-'))
  const r = store.create({ title: 'Doomed', project: proj })
  store.transition(r.id, 'queued')
  const d = createDispatcher({ store, broadcast: () => {}, run: fakeRun([['--bg', { code: 1, stdout: 'nope', stderr: 'boom' }]], calls) })
  const out = await d.dispatch([r.id])
  assert.equal(out.dispatched.length, 0)
  assert.equal(store.get(r.id).state, 'failed')
  assert.ok(existsSync(join(proj, '.claude', 'worktrees', 'doomed')), 'the worktree survives as evidence')
  rmSync(proj, { recursive: true, force: true })
})
await ok('dispatch is sequential — the second worktree add follows the first spawn', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'dp4.json') })
  const proj = mkdtempSync(join(tmpdir(), 'szg-proj-'))
  const a = store.create({ title: 'One', project: proj }); store.transition(a.id, 'queued')
  const b = store.create({ title: 'Two', project: proj }); store.transition(b.id, 'queued')
  const d = createDispatcher({ store, broadcast: () => {}, run: fakeRun([['--bg', { code: 0, stdout: 'backgrounded · dd44 · x\n', stderr: '' }]], calls) })
  await d.dispatch([a.id, b.id])
  const flat = calls.map((c) => [c.bin, ...c.argv].join(' '))
  const firstSpawn = flat.findIndex((c) => c.includes('--bg'))
  const secondAdd = flat.findIndex((c, i) => i > firstSpawn && c.includes('worktree add'))
  assert.ok(secondAdd > firstSpawn, 'the second worktree waits for the first spawn')
  rmSync(proj, { recursive: true, force: true })
})
await ok('poll folds agent state on and enters planned only with a plan file', async () => {
  const store = createStore({ file: join(dir, 'dp5.json') })
  const proj = mkdtempSync(join(tmpdir(), 'szg-proj-'))
  const r = store.create({ title: 'Polled', project: proj })
  store.transition(r.id, 'queued')
  store.transition(r.id, 'dispatched', {
    session: { shortId: 'ee55', sessionId: 'ee55-full', spawnedAt: 1 },
    artifacts: {
      planPath: null, specPath: null,
      expectedPlanPath: 'docs/plans/2025-01-04-polled.md',
      expectedSpecPath: 'docs/specs/2025-01-04-polled-design.md',
    },
  })
  const agents = JSON.stringify([{ id: 'ee55', sessionId: 'ee55-full', name: 'polled', kind: 'background', status: 'waiting', state: 'blocked', waitingFor: 'permission prompt' }])
  const d = createDispatcher({ store, broadcast: () => {}, run: async () => ({ code: 0, stdout: agents, stderr: '' }) })
  await d.poll()
  assert.equal(store.get(r.id).session.state, 'blocked')
  assert.equal(store.get(r.id).session.waitingFor, 'permission prompt')
  assert.equal(store.get(r.id).state, 'dispatched', 'blocked never becomes planned')

  // Now the plan file appears and the session finishes.
  const wt = join(proj, '.claude', 'worktrees', 'polled')
  mkdirSync(join(wt, 'docs', 'plans'), { recursive: true })
  writeFileSync(join(wt, 'docs', 'plans', '2025-01-04-polled.md'), '# plan')
  const done = JSON.stringify([{ id: 'ee55', sessionId: 'ee55-full', name: 'polled', kind: 'background', status: 'idle', state: 'done', waitingFor: null }])
  const d2 = createDispatcher({ store, broadcast: () => {}, run: async () => ({ code: 0, stdout: done, stderr: '' }) })
  await d2.poll()
  assert.equal(store.get(r.id).state, 'planned')
  assert.match(store.get(r.id).artifacts.planPath, /2025-01-04-polled\.md/)
  rmSync(proj, { recursive: true, force: true })
})

// A dispatched worktree branches from the project's
// current HEAD, so it inherits every docs/plans/*.md already committed
// there. "The newest markdown in the directory" (the old newestMarkdown, now
// deleted) is therefore never empty, `no-plan` becomes unreachable, and a
// session that wrote nothing at all reads as `plan ready`, pointing at a
// plan it never wrote -- a false positive on the most load-bearing rule
// there is here. The gate checks the exact path `initialPrompt` told the
// session to write. This proves the regression is closed in both directions: an
// inherited pre-existing plan does not satisfy the gate, and the exact
// expected path does.
await ok('an inherited pre-existing plan does not satisfy the gate; only the exact expected path does', async () => {
  const store = createStore({ file: join(dir, 'dp6.json') })
  const proj = mkdtempSync(join(tmpdir(), 'szg-proj-'))
  const r = store.create({ title: 'Inherited', project: proj })
  store.transition(r.id, 'queued')
  store.transition(r.id, 'dispatched', {
    session: { shortId: 'ff66', sessionId: 'ff66-full', spawnedAt: 1 },
    artifacts: {
      planPath: null, specPath: null,
      expectedPlanPath: 'docs/plans/2025-01-04-inherited.md',
      expectedSpecPath: 'docs/specs/2025-01-04-inherited-design.md',
    },
  })
  const wt = join(proj, '.claude', 'worktrees', 'inherited')
  mkdirSync(join(wt, 'docs', 'plans'), { recursive: true })
  // A plan this session never wrote -- inherited from the worktree's branch
  // point, the way any already-committed `docs/plans/*.md` would be.
  writeFileSync(join(wt, 'docs', 'plans', '2026-01-01-something.md'), '# not this session\'s plan')

  const done = JSON.stringify([{ id: 'ff66', sessionId: 'ff66-full', name: 'inherited', kind: 'background', status: 'idle', state: 'done', waitingFor: null }])
  const d = createDispatcher({ store, broadcast: () => {}, run: async () => ({ code: 0, stdout: done, stderr: '' }) })
  await d.poll()
  assert.equal(store.get(r.id).artifacts.planPath, null, 'an inherited file must not satisfy the gate')
  assert.equal(store.get(r.id).state, 'dispatched', 'must not enter planned without the exact expected file, even though the agent reports done')

  // Now the exact expected file appears.
  writeFileSync(join(wt, 'docs', 'plans', '2025-01-04-inherited.md'), '# the real plan')
  await d.poll()
  assert.equal(store.get(r.id).artifacts.planPath, 'docs/plans/2025-01-04-inherited.md')
  assert.equal(store.get(r.id).state, 'planned', 'the exact expected file does satisfy the gate')
  rmSync(proj, { recursive: true, force: true })
})

// A failed or garbled `agents --json` response must not
// wipe previously-known session state for every open request -- only a
// session's genuine absence from a SUCCESSFUL response should null it.
await ok('poll leaves session state untouched when the agents call itself fails, but nulls it once the call succeeds and the session is genuinely gone', async () => {
  const store = createStore({ file: join(dir, 'dp7.json') })
  const proj = mkdtempSync(join(tmpdir(), 'szg-proj-'))
  const r = store.create({ title: 'Flaky', project: proj })
  store.transition(r.id, 'queued')
  store.transition(r.id, 'dispatched', {
    session: { shortId: 'gg77', sessionId: 'gg77-full', spawnedAt: 1, status: 'waiting', state: 'blocked', waitingFor: 'permission prompt' },
  })

  // Non-zero exit: the call itself failed. Previously-known state survives.
  const dFailed = createDispatcher({ store, broadcast: () => {}, run: async () => ({ code: 1, stdout: '', stderr: 'boom' }) })
  await dFailed.poll()
  assert.equal(store.get(r.id).session.state, 'blocked', 'a failed CLI call must not wipe known state')
  assert.equal(store.get(r.id).session.waitingFor, 'permission prompt')

  // Exit 0 but unparseable output: same treatment as a failed call.
  const dGarbled = createDispatcher({ store, broadcast: () => {}, run: async () => ({ code: 0, stdout: 'not json', stderr: '' }) })
  await dGarbled.poll()
  assert.equal(store.get(r.id).session.state, 'blocked', 'unparseable output must not wipe known state either')

  // The call succeeds and this session is genuinely absent from the list:
  // NOW nulling its fields is correct.
  const dGone = createDispatcher({ store, broadcast: () => {}, run: async () => ({ code: 0, stdout: '[]', stderr: '' }) })
  await dGone.poll()
  assert.equal(store.get(r.id).session.state, null, 'a successful call with the session genuinely absent must null it')
  assert.equal(store.get(r.id).session.waitingFor, null)
  rmSync(proj, { recursive: true, force: true })
})

// a pane with a brief editor open re-renders (and blanks it) on every
// 'dispatch' broadcast, via MCD.render() -> renderQueue() -> replaceChildren().
// poll() used to set `changed = true` unconditionally whenever anything was
// open, so it broadcast every 5 s pass regardless of whether anything about
// the request actually differed. This pins the fix: an agents snapshot that
// reports EXACTLY what is already on the record must not broadcast, and one
// that reports something different must.
await ok('poll() broadcasts nothing when nothing about the open requests changed', async () => {
  const store = createStore({ file: join(dir, 'dp9.json') })
  const proj = mkdtempSync(join(tmpdir(), 'szg-proj-'))
  const r = store.create({ title: 'Steady', project: proj })
  store.transition(r.id, 'queued')
  store.transition(r.id, 'dispatched', {
    session: { shortId: 'hh88', sessionId: 'hh88-full', spawnedAt: 1, status: 'waiting', state: 'blocked', waitingFor: 'permission prompt' },
    artifacts: { planPath: null, specPath: null, expectedPlanPath: 'docs/plans/x.md', expectedSpecPath: 'docs/specs/x.md' },
  })
  const agents = JSON.stringify([{ id: 'hh88', sessionId: 'hh88-full', name: 'steady', kind: 'background', status: 'waiting', state: 'blocked', waitingFor: 'permission prompt' }])

  let broadcasts = 0
  const d = createDispatcher({ store, broadcast: () => { broadcasts++ }, run: async () => ({ code: 0, stdout: agents, stderr: '' }) })
  await d.poll()
  assert.equal(broadcasts, 0, 'an unchanged agents snapshot must not broadcast, even though a request is open')

  // Confirm the harness would actually catch a regression: a real change
  // (the session goes idle) DOES broadcast.
  const changedAgents = JSON.stringify([{ id: 'hh88', sessionId: 'hh88-full', name: 'steady', kind: 'background', status: 'idle', state: 'blocked', waitingFor: null }])
  const d2 = createDispatcher({ store, broadcast: () => { broadcasts++ }, run: async () => ({ code: 0, stdout: changedAgents, stderr: '' }) })
  await d2.poll()
  assert.equal(broadcasts, 1, 'a genuine change must still broadcast')
  rmSync(proj, { recursive: true, force: true })
})

// second half: scoping.mjs must not broadcast the whole 'dispatch'
// payload per assistant frame ("so a long conversation does not
// re-broadcast the whole queue per token"). The thread panel gets every
// frame via the 'scope' broadcast regardless; only 'dispatch' broadcasts --
// the ones that reach renderQueue()'s replaceChildren() -- are counted here.
await ok('a scoping turn does not broadcast the whole queue once per assistant frame', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'sc12.json') })
  const r = store.create({ title: 'x', project: RDIR })
  let dispatchBroadcasts = 0
  const sc = createScoper({
    store,
    broadcast: (t) => { if (t === 'dispatch') dispatchBroadcasts++ },
    spawn: fakeSpawn(calls),
  })
  const p = sc.start(r.id, 'i want a thing', RDIR)
  await p
  const before = dispatchBroadcasts
  // Five separate assistant-text frames in one turn -- the "per token" case.
  for (let i = 0; i < 5; i++) {
    calls[0].child.emit(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `chunk ${i}` }] } }) + '\n')
  }
  assert.equal(dispatchBroadcasts, before, 'no dispatch broadcast per assistant frame')
  assert.equal(store.get(r.id).scoping.turns.filter((t) => t.role === 'assistant').length, 5, 'the turns are still recorded on the store even without a broadcast')
  calls[0].child.finish(0)
  // start()'s turn-end broadcast fires from the .then() on run()'s promise --
  // a microtask away from the synchronous 'close' dispatch finish() just did.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(dispatchBroadcasts, before + 1, 'exactly one more dispatch broadcast at turn end')
})

// The worktree-add failure guard is easy to leave untested: deleting
// `if (add.code !== 0) { fail(...); return null }` passes every other check
// in this file. This one must fail if that guard is removed.
await ok('a failed worktree add marks the request failed, never spawns claude, and leaves the worktree in place', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'dp8.json') })
  const proj = mkdtempSync(join(tmpdir(), 'szg-proj-'))
  const r = store.create({ title: 'Broken', project: proj })
  store.transition(r.id, 'queued')
  const wt = join(proj, '.claude', 'worktrees', 'broken')
  // Simulate git having partially created the worktree directory before
  // failing -- a real failure mode -- so "left in place" is meaningful to
  // assert even though `run` never touches the real filesystem.
  mkdirSync(wt, { recursive: true })
  const d = createDispatcher({
    store, broadcast: () => {},
    run: fakeRun([['worktree add', { code: 128, stdout: '', stderr: "fatal: '" + wt + "' already exists" }]], calls),
  })
  const out = await d.dispatch([r.id])
  assert.equal(out.dispatched.length, 0)
  assert.equal(store.get(r.id).state, 'failed')
  assert.match(store.get(r.id).error.message, /already exists/, 'the error carries the git stderr')
  assert.equal(calls.some((c) => c.argv.includes('--bg')), false, 'no spawn was attempted after a failed worktree add')
  assert.ok(existsSync(wt), 'the worktree directory is left in place, not cleaned up')
  rmSync(proj, { recursive: true, force: true })
})

// ---- dispatch options -------------------------------------------------------
const { parseClaudeOptions, FALLBACK_MODELS, FALLBACK_EFFORTS } =
  await import(join(ROOT, 'syzygy', 'bridge', 'dispatch-options.mjs'))

// The real shape, copied from `claude --help` on 2.1.269: the parenthesised
// enumeration lands on the WRAPPED continuation line, not beside the flag.
const REAL_HELP = [
  '  --debug [filter]                      Enable debug mode',
  '  --effort <level>                      Effort level for the current session',
  '                                        (low, medium, high, xhigh, max)',
  '  --fallback-model <model>              Enable automatic fallback to specified',
  '                                        model(s) when the default model is',
  '                                        overloaded or not available.',
  "  --model <model>                       Model for the current session. Provide",
  "                                        an alias for the latest model (e.g.",
  "                                        'fable', 'opus', or 'sonnet') or a",
  "                                        model's full name (e.g.",
  "                                        'claude-fable-5').",
  '  -n, --name <name>                     Set a display name for this session',
].join('\n')

await ok('parseClaudeOptions reads the effort levels off the wrapped line', () => {
  assert.deepEqual(parseClaudeOptions(REAL_HELP).efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
})
await ok('parseClaudeOptions reads the model ALIASES and drops the full-name example', () => {
  // `--model` documents examples, not an enumeration. A dashed token like
  // `claude-fable-5` is an illustration of the "full name" form and pinning it
  // into a picker would ship a model id that ages out. Aliases only.
  const models = parseClaudeOptions(REAL_HELP).models
  assert.ok(models.includes('opus') && models.includes('sonnet') && models.includes('fable'))
  assert.ok(!models.some((m) => m.includes('-')), 'a full-name example leaked into the alias list: ' + models.join(','))
})
await ok('parseClaudeOptions does not read --fallback-model as --model', () => {
  // Both lines contain the substring "model". Matching loosely would union the
  // wrong description into the alias list.
  assert.ok(!parseClaudeOptions(REAL_HELP).models.includes('model(s)'))
})
await ok('parseClaudeOptions unions the baked list in, and marks the source', () => {
  const out = parseClaudeOptions(REAL_HELP)
  assert.equal(out.source, 'help')
  for (const m of FALLBACK_MODELS) assert.ok(out.models.includes(m), 'baked model dropped: ' + m)
})
await ok('garbled help degrades to the baked lists, reported as fallback', () => {
  for (const bad of ['', null, undefined, 'not help at all', '--effort <level>']) {
    const out = parseClaudeOptions(bad)
    assert.deepEqual(out.efforts, FALLBACK_EFFORTS)
    assert.deepEqual(out.models, FALLBACK_MODELS)
    assert.equal(out.source, 'fallback', 'a garbled parse claimed source=help')
  }
})
await ok('parseClaudeOptions never throws on hostile input', () => {
  for (const bad of [{}, [], 42, '('.repeat(500)]) assert.doesNotThrow(() => parseClaudeOptions(bad))
})

// ---- the dispatch patch -----------------------------------------------------
await ok('a dispatch patch MERGES, and cannot clear branch or sessionName', () => {
  // update() is a top-level Object.assign, so an unguarded `{dispatch:{model}}`
  // patch REPLACES the object and takes `branch` and `sessionName` with it --
  // the two fields a dispatched request needs to be attachable at all.
  //
  // DEVIATION from the plan's literal test: branch/sessionName are set here
  // via transition(), the way dispatch.mjs actually sets them in production,
  // not via update(). The plan's literal version set them with update() --
  // but the very fix this task makes means update() never writes those two
  // fields at all (see the next test), so that setup could never establish
  // them under the code it was meant to exercise. transition() is the real
  // production path (dispatch.mjs:202) and lets this test verify its actual
  // intent: a later update() patch must not clear what transition() set.
  const s = createStore({ file: join(dir, 'dpatch.json') })
  const r = s.create({ title: 'M', project: '/p' })
  s.transition(r.id, 'queued')
  s.transition(r.id, 'dispatched', { dispatch: { ...s.get(r.id).dispatch, branch: 'worktree-m', sessionName: 'm' } })
  s.update(r.id, { dispatch: { model: 'sonnet', effort: 'low' } })
  assert.deepEqual(s.get(r.id).dispatch, { model: 'sonnet', effort: 'low', branch: 'worktree-m', sessionName: 'm' })
})
await ok('a dispatch patch cannot forge branch or sessionName', () => {
  // Same deviation as above, same reason: branch/sessionName are established
  // via transition() (the real production path), then update() attempts the
  // forge.
  const s = createStore({ file: join(dir, 'dpatch2.json') })
  const r = s.create({ title: 'M', project: '/p' })
  s.transition(r.id, 'queued')
  s.transition(r.id, 'dispatched', { dispatch: { ...s.get(r.id).dispatch, branch: 'x', sessionName: 'y' } })
  s.update(r.id, { dispatch: { branch: '../../etc', sessionName: 'z', model: 'opus' } })
  assert.equal(s.get(r.id).dispatch.branch, 'x')
  assert.equal(s.get(r.id).dispatch.sessionName, 'y')
})
await ok('a junk model or effort is ignored, never stored', () => {
  const s = createStore({ file: join(dir, 'dpatch3.json') })
  const r = s.create({ title: 'M', project: '/p' })
  const before = { ...s.get(r.id).dispatch }
  for (const bad of ['', ' ', 'a'.repeat(200), 'rm -rf /', '--dangerously-skip-permissions', 42, null, {}]) {
    s.update(r.id, { dispatch: { model: bad, effort: bad } })
    assert.equal(s.get(r.id).dispatch.model, before.model, 'stored a junk model: ' + JSON.stringify(bad))
    assert.equal(s.get(r.id).dispatch.effort, before.effort, 'stored a junk effort: ' + JSON.stringify(bad))
  }
})
await ok('a full model NAME is accepted, not only an alias', () => {
  // `--model` takes a full name. The store is not the place to enumerate
  // models -- see requests.mjs.
  const s = createStore({ file: join(dir, 'dpatch4.json') })
  const r = s.create({ title: 'M', project: '/p' })
  s.update(r.id, { dispatch: { model: 'claude-opus-5' } })
  assert.equal(s.get(r.id).dispatch.model, 'claude-opus-5')
})
await ok('a non-object dispatch patch is ignored, not merged', () => {
  const s = createStore({ file: join(dir, 'dpatch5.json') })
  const r = s.create({ title: 'M', project: '/p' })
  const before = { ...s.get(r.id).dispatch }
  for (const bad of [null, 'x', 42, ['a']]) s.update(r.id, { dispatch: bad })
  assert.deepEqual(s.get(r.id).dispatch, before)
})

// ---- project badges ---------------------------------------------------------
// A CLASSIC script like canvas-layout.js, evaluated here through `new Function`.
const MCB = new Function('window',
  readFileSync(join(ROOT, 'syzygy', 'bridge', 'public', 'dispatch-badges.js'), 'utf8') + '\nreturn MCB')({})

const PROJECTS = [
  { key: '/repo/.git', name: 'repo', mainRoot: '/repo', worktrees: [
    { path: '/repo', isMain: true }, { path: '/repo/.worktrees/a', isMain: false }, { path: '/repo/.worktrees/b', isMain: false }] },
  { key: '/other', name: 'other', mainRoot: '/other', worktrees: [{ path: '/other', isMain: true }] },
]

await ok('every worktree of one project collapses onto ONE badge at its main root', () => {
  // A busy repo can carry a dozen worktrees at once, and a badge each is not a
  // picker. And `git worktree add` belongs in the main root, not inside a
  // linked worktree.
  const out = MCB.projectBadges({ projects: PROJECTS, sessions: [
    { root: '/repo/.worktrees/a' }, { root: '/repo/.worktrees/b' }, { root: '/repo' }], recents: [] })
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], { key: '/repo/.git', name: 'repo', path: '/repo', live: true })
})
await ok('a live project sorts ahead of a merely recent one, and is marked live', () => {
  const out = MCB.projectBadges({ projects: PROJECTS, sessions: [{ root: '/other' }], recents: ['/repo'] })
  assert.deepEqual(out.map((b) => [b.name, b.live]), [['other', true], ['repo', false]])
})
await ok('recents keep their order behind the live ones', () => {
  const out = MCB.projectBadges({ projects: PROJECTS, sessions: [], recents: ['/other', '/repo/.worktrees/a'] })
  assert.deepEqual(out.map((b) => b.name), ['other', 'repo'])
})
await ok('a candidate belonging to no known project is DROPPED', () => {
  // The scanner not knowing it means the dispatcher cannot branch in it
  // either, so a badge would be an offer the tab cannot honour.
  const out = MCB.projectBadges({ projects: PROJECTS, sessions: [{ root: '/tmp/scratch/probe-cwd' }], recents: ['/nowhere'] })
  assert.deepEqual(out, [])
})
await ok('a session reporting cwd but no root still resolves', () => {
  const out = MCB.projectBadges({ projects: PROJECTS, sessions: [{ cwd: '/repo/.worktrees/a' }], recents: [] })
  assert.deepEqual(out.map((b) => b.name), ['repo'])
})
await ok('the badge row is capped and the cap keeps the live ones', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ key: '/p' + i, name: 'p' + i, mainRoot: '/p' + i, worktrees: [{ path: '/p' + i, isMain: true }] }))
  const out = MCB.projectBadges({ projects: many, sessions: [{ root: '/p19' }], recents: many.map((p) => p.mainRoot), limit: 8 })
  assert.equal(out.length, 8)
  assert.equal(out[0].name, 'p19')
})
await ok('projectBadges is pure and deterministic', () => {
  const args = { projects: PROJECTS, sessions: [{ root: '/repo' }], recents: ['/other'] }
  assert.deepEqual(MCB.projectBadges(args), MCB.projectBadges(args))
  assert.deepEqual(args.recents, ['/other'], 'projectBadges mutated its input')
})
await ok('projectBadges never throws on a malformed payload', () => {
  for (const bad of [{}, { projects: null, sessions: null, recents: null },
    { projects: [{}], sessions: [null], recents: [null, 42] },
    { projects: [{ worktrees: null }], sessions: [{ root: 42 }], recents: ['/repo'] }]) {
    assert.doesNotThrow(() => MCB.projectBadges(bad))
    assert.ok(Array.isArray(MCB.projectBadges(bad)))
  }
})

// ---- the relay handoff ------------------------------------------------------
const initialPromptFor = (r) => initialPrompt({ slug: r.slug, date: new Date().toISOString().slice(0, 10) })

await ok('the dispatch spawn tells the child which relay started it', async () => {
  // Without this the session registers with the default relay on 4317, and the
  // implement green light -- enqueue(sessionId, IMPLEMENT_PROMPT) on THIS
  // relay's queue -- lands on a queue that session never polls. Silent on the
  // default port; silent everywhere else too, which is the problem.
  const calls = []
  const store = createStore({ file: join(dir, 'dphand.json') })
  const proj = mkdtempSync(join(tmpdir(), 'szg-proj-'))
  const r = store.create({ title: 'Handoff', project: proj, ask: 'x' })
  store.transition(r.id, 'queued')
  const d = createDispatcher({
    store, broadcast: () => {},
    run: fakeRun([['--bg', { code: 0, stdout: 'backgrounded · hh77 · handoff\n', stderr: '' }]], calls),
    relayInfo: () => ({ relayPort: 4999, relayToken: 'tok' }),
  })
  await d.dispatch([r.id])
  const argv = calls.find((c) => c.argv.includes('--bg')).argv
  const i = argv.indexOf('--settings')
  assert.ok(i >= 0, 'no --settings on the dispatch argv')
  assert.deepEqual(JSON.parse(argv[i + 1]), { env: { SZG_RELAY_PORT: '4999', SZG_RELAY_TOKEN: 'tok' } })
  // Ordering is not cosmetic: --allowedTools is VARIADIC and eats every
  // following non-option token, and the prompt is positional.
  assert.ok(i < argv.indexOf('--allowedTools'), '--settings fell behind the variadic --allowedTools')
  assert.equal(argv[argv.length - 1], initialPromptFor(r), 'the prompt is no longer last')
  rmSync(proj, { recursive: true, force: true })
})
await ok('a dispatcher with no relay identity omits --settings entirely', async () => {
  // Never `--settings {}`: an empty env object is a claim about the relay, and
  // a child told to register with port `undefined` is worse than one left to
  // its own default.
  const calls = []
  const store = createStore({ file: join(dir, 'dphand2.json') })
  const proj = mkdtempSync(join(tmpdir(), 'szg-proj-'))
  const r = store.create({ title: 'Bare', project: proj, ask: 'x' })
  store.transition(r.id, 'queued')
  const d = createDispatcher({ store, broadcast: () => {}, run: fakeRun([['--bg', { code: 0, stdout: 'backgrounded · bb88 · bare\n', stderr: '' }]], calls) })
  await d.dispatch([r.id])
  assert.ok(!calls.find((c) => c.argv.includes('--bg')).argv.includes('--settings'))
  rmSync(proj, { recursive: true, force: true })
})
await ok('a throwing relayInfo does not take the dispatch down', async () => {
  const calls = []
  const store = createStore({ file: join(dir, 'dphand3.json') })
  const proj = mkdtempSync(join(tmpdir(), 'szg-proj-'))
  const r = store.create({ title: 'Throws', project: proj, ask: 'x' })
  store.transition(r.id, 'queued')
  const d = createDispatcher({
    store, broadcast: () => {},
    run: fakeRun([['--bg', { code: 0, stdout: 'backgrounded · tt99 · throws\n', stderr: '' }]], calls),
    relayInfo: () => { throw new Error('boom') },
  })
  await d.dispatch([r.id])
  assert.equal(store.get(r.id).state, 'dispatched')
  rmSync(proj, { recursive: true, force: true })
})

// ---- relay: the HTTP endpoint contract (integration, isolated) ------------
// and live in relay.mjs's HTTP handlers, not in a pure/exported
// function, so they are tested against a REAL relay subprocess rather than a
// re-implementation that could silently drift from the real one. Isolated on
// two axes so this can never touch anything real: SZG_PORT=0 (OS-assigned --
// never the shared 4317/4319/4321 relays) and SZG_DATA_DIR (a throwaway temp
// dir -- never ~/.claude/syzygy, which is real, shared, authoritative
// data a test process must never load, mutate or flush).
{
  const { spawn } = await import('node:child_process')
  const dataDir = mkdtempSync(join(tmpdir(), 'szg-relay-'))
  const RELAY_TOKEN = 'harness-token'
  const relayPath = join(ROOT, 'syzygy', 'bridge', 'relay.mjs')

  // fixture has to be seeded BEFORE the relay starts: createStore
  // loads the file once, at construction, and a request in `planned` is --
  // correctly, after the fix below -- unreachable over HTTP any more. So
  // reach it the only way the real system does: an in-process
  // store.transition() call, the same one dispatch.mjs's poll() makes, done
  // here against the file the relay subprocess will read at startup.
  const seedStore = createStore({ file: join(dataDir, 'dispatch.json') })
  const orphan = seedStore.create({ title: 'orphan brief', project: RDIR })
  seedStore.transition(orphan.id, 'queued')
  seedStore.transition(orphan.id, 'dispatched', { session: { shortId: 'zz99', sessionId: 'zz99-full', spawnedAt: 1 } })
  seedStore.transition(orphan.id, 'planned', {
    artifacts: { planPath: 'docs/plans/x.md', specPath: null, expectedPlanPath: 'docs/plans/x.md', expectedSpecPath: null },
  })
  const addressed = seedStore.create({ title: 'addressed brief', project: RDIR })
  seedStore.transition(addressed.id, 'queued')
  seedStore.transition(addressed.id, 'dispatched', { session: { shortId: 'aa11', sessionId: 'aa11-full', spawnedAt: 1 } })
  seedStore.transition(addressed.id, 'planned', {
    artifacts: { planPath: 'docs/plans/y.md', specPath: null, expectedPlanPath: 'docs/plans/y.md', expectedSpecPath: null },
  })
  seedStore.flush()

  const child = spawn(process.execPath, [relayPath], {
    env: {
      ...process.env, SZG_PORT: '0', SZG_TOKEN: RELAY_TOKEN, SZG_DATA_DIR: dataDir,
      SZG_PANE_PASSWORD_DISABLED: '1', // this harness's own GETs carry no cookie
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
    const r = await fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: RELAY_TOKEN, ...body }),
    })
    const j = await r.json().catch(() => ({}))
    return { status: r.status, ...j }
  }
  const get = async (path) => (await fetch(base + path)).json()

  try {
    await ok('POST /api/request/state strips a browser-supplied patch, so `planned` can never be faked', async () => {
      const created = await post('/api/request/create', { title: 'probe brief', project: RDIR })
      const id = created.request.id
      await post('/api/request/state', { id, to: 'queued' })
      await post('/api/request/state', { id, to: 'dispatched' })
      const faked = await post('/api/request/state', {
        id, to: 'planned', patch: { artifacts: { planPath: 'docs/plans/fake.md' } },
      })
      assert.equal(faked.status, 409, '`planned` must be refused with no server-recorded plan path')
      assert.match(faked.error, /planPath/)
      const after = await post('/api/request/state', {
        id, to: 'failed',
        patch: { artifacts: { planPath: 'docs/plans/fake.md' }, session: { shortId: 'smuggled' } },
      })
      assert.equal(after.status, 200)
      assert.equal(after.request.artifacts, null, 'artifacts must be untouched by a browser patch even on an allowed transition')
      assert.equal(after.request.session, null, 'session must be untouched too')
    })

    await ok('POST /api/implement skips a request whose session is not registered, without transitioning it', async () => {
      const res = await post('/api/implement', { ids: [orphan.id] })
      assert.equal(res.status, 200)
      assert.deepEqual(res.queued, [])
      assert.deepEqual(res.skipped, [orphan.id])
      const state = await get('/api/state')
      const r = state.dispatch.requests.find((x) => x.id === orphan.id)
      assert.equal(r.state, 'planned', 'an unaddressable session must not move the request to implementing')
    })

    await ok('POST /api/implement queues a request whose session IS registered', async () => {
      await post('/api/register', { session: { id: 'aa11-full', name: 'addressed' } })
      const res = await post('/api/implement', { ids: [addressed.id] })
      assert.equal(res.status, 200)
      assert.deepEqual(res.skipped, [])
      assert.deepEqual(res.queued, [addressed.id])
      const state = await get('/api/state')
      const r = state.dispatch.requests.find((x) => x.id === addressed.id)
      assert.equal(r.state, 'implementing')
    })
  } finally {
    child.kill('SIGTERM')
    await new Promise((r2) => { child.once('exit', r2); setTimeout(r2, 2000) })
    rmSync(dataDir, { recursive: true, force: true })
  }
}

// ---- the glance's backlog count ---------------------------------------------
// REGRESSION. The chip read 0 from its first day because renderGlance asked for
// `w.backlog`, a key the Projects payload has never had, while the real backlog
// hangs off `w.tasks[].items[]`. Nothing here covered the view, so a green
// suite said nothing about it. dispatch.js is browser code, but its IIFE only
// DEFINES its renderers -- attach() is what touches the DOM -- so it evaluates
// in Node with no shim, and the counter is reachable as a pure function.
{
  const vm = await import('node:vm')
  const src = readFileSync(join(ROOT, 'syzygy', 'bridge', 'public', 'dispatch.js'), 'utf8')
  const { backlogCount, effortProgress, dedupeBacklogSections } = vm.runInNewContext(src + '\n;MCD', {})
  // Objects/arrays returned from a DIFFERENT vm context carry that context's
  // own Array/Object prototypes -- structurally identical to the outer
  // realm's but not reference-equal to them, which fails assert.deepEqual
  // even when every value matches (verified: `vm.runInNewContext('[]', {})`
  // fails deepEqual against a literal `[]`). A JSON round-trip discards which
  // realm made the object and leaves only plain data, so deepEqual can be
  // used at all here. backlogCount sidesteps this by returning a bare number.
  const plain = (v) => JSON.parse(JSON.stringify(v))

  await ok('backlogCount counts items across the task files of a worktree', () => {
    const wt = [{ tasks: [{ rel: 'docs/TASKS.md', items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }] }]
    assert.equal(backlogCount(wt), 3)
  })
  await ok('backlogCount ignores the w.backlog key that never existed', () => {
    // The exact shape the old code believed in. It must contribute nothing.
    assert.equal(backlogCount([{ backlog: [{ id: 'x' }, { id: 'y' }] }]), 0)
  })
  await ok('backlogCount de-duplicates one TASKS.md shared by every worktree', () => {
    const items = [{ id: 'a' }, { id: 'b' }]
    const wt = [
      { isMain: true, tasks: [{ rel: 'docs/TASKS.md', items }] },
      { tasks: [{ rel: 'docs/TASKS.md', items }] },
      { tasks: [{ rel: 'docs/TASKS.md', items }] },
    ]
    // 6 if summed per worktree; 2 is the honest number of distinct entries.
    assert.equal(backlogCount(wt), 2)
  })
  await ok('backlogCount counts an entry a single worktree adds', () => {
    const wt = [
      { isMain: true, tasks: [{ rel: 'docs/TASKS.md', items: [{ id: 'a' }] }] },
      { tasks: [{ rel: 'docs/TASKS.md', items: [{ id: 'a' }, { id: 'only-here' }] }] },
    ]
    assert.equal(backlogCount(wt), 2)
  })
  await ok('backlogCount skips ghosts at file level and at item level', () => {
    const wt = [
      { tasks: [{ rel: 'docs/TASKS.md', absent: true, diff: 'removed', items: [{ id: 'ghostfile' }] }] },
      { tasks: [{ rel: 'docs/TASKS.md', items: [{ id: 'real' }, { id: 'ghostitem', absent: true, diff: 'removed' }] }] },
    ]
    assert.equal(backlogCount(wt), 1)
  })
  await ok('backlogCount tolerates absent, empty and malformed input', () => {
    assert.equal(backlogCount([]), 0)
    assert.equal(backlogCount(undefined), 0)
    assert.equal(backlogCount([{}]), 0)
    assert.equal(backlogCount([{ tasks: [{ rel: 'docs/TASKS.md' }] }]), 0)
  })

  // ---- the glance drilldown: effort progress -------------------------------
  await ok('effortProgress uses the plain done/total form when nothing is reported', () => {
    assert.equal(effortProgress({ done: 5, reported: 0, total: 12 }), '5/12')
  })
  await ok('effortProgress never collapses reported into done', () => {
    // The load-bearing distinction: this must read as three numbers, not
    // "17 done" -- a reader cannot tell what is verified from that.
    assert.equal(effortProgress({ done: 12, reported: 3, total: 36 }), '12 verified · 3 reported · 21 to do')
  })
  await ok('effortProgress clamps "to do" at zero rather than going negative', () => {
    // done + reported can exceed total on a stale/racing copy; the UI must
    // not print "-2 to do".
    assert.equal(effortProgress({ done: 10, reported: 5, total: 12 }), '10 verified · 5 reported · 0 to do')
  })
  await ok('effortProgress tolerates missing fields', () => {
    assert.equal(effortProgress({}), '0/0')
  })

  // ---- the glance drilldown: backlog de-duplication ------------------------
  await ok('dedupeBacklogSections collapses one TASKS.md shared by every worktree', () => {
    const items = [
      { id: 'a', kind: 'section', text: 'Section A' },
      { id: 'b', kind: 'section', text: 'Section B' },
    ]
    const wt = [
      { isMain: true, tasks: [{ rel: 'docs/TASKS.md', items }] },
      { tasks: [{ rel: 'docs/TASKS.md', items }] },
      { tasks: [{ rel: 'docs/TASKS.md', items }] },
    ]
    // 6 if a naive pass renders every worktree's copy; 2 is the honest count.
    const out = dedupeBacklogSections(wt)
    assert.equal(out.length, 2)
    assert.deepEqual(plain(out).map((s) => s.id), ['a', 'b'], 'first-seen order is preserved')
  })
  await ok('dedupeBacklogSections ignores step items, only section headings count', () => {
    const wt = [{ tasks: [{ rel: 'docs/TASKS.md', items: [
      { id: 'a', kind: 'section', text: 'Heading' },
      { id: 'b', kind: 'step', text: 'a checkbox, not a backlog section' },
    ] }] }]
    assert.deepEqual(plain(dedupeBacklogSections(wt)).map((s) => s.id), ['a'])
  })
  await ok('dedupeBacklogSections skips ghosts at file level and at item level', () => {
    const wt = [
      { tasks: [{ rel: 'docs/TASKS.md', absent: true, items: [{ id: 'ghostfile', kind: 'section', text: 'x' }] }] },
      { tasks: [{ rel: 'docs/TASKS.md', items: [
        { id: 'real', kind: 'section', text: 'Real section' },
        { id: 'ghostitem', kind: 'section', text: 'gone', absent: true },
      ] }] },
    ]
    assert.deepEqual(plain(dedupeBacklogSections(wt)).map((s) => s.id), ['real'])
  })
  await ok('dedupeBacklogSections unions claimedBy across duplicate copies of the same item', () => {
    // resolveBacklogClaims (tasks.mjs) attaches a claim to whichever
    // worktree's copy of a shared slug it happens to visit last -- so the
    // claim can land on ANY copy, not necessarily the first one a naive
    // dedupe would keep. This must not silently drop it.
    const wt = [
      { tasks: [{ rel: 'docs/TASKS.md', items: [{ id: 'a', kind: 'section', text: 'Shared' }] }] },
      { tasks: [{ rel: 'docs/TASKS.md', items: [{ id: 'a', kind: 'section', text: 'Shared', claimedBy: [{ id: 's1', name: 'agent-1' }] }] }] },
    ]
    const out = dedupeBacklogSections(wt)
    assert.equal(out.length, 1)
    assert.deepEqual(plain(out[0].claimedBy), [{ id: 's1', name: 'agent-1' }])
  })
  await ok('dedupeBacklogSections does not duplicate the same claimant seen on two copies', () => {
    const claim = [{ id: 's1', name: 'agent-1' }]
    const wt = [
      { tasks: [{ rel: 'docs/TASKS.md', items: [{ id: 'a', kind: 'section', text: 'Shared', claimedBy: claim }] }] },
      { tasks: [{ rel: 'docs/TASKS.md', items: [{ id: 'a', kind: 'section', text: 'Shared', claimedBy: claim }] }] },
    ]
    assert.equal(dedupeBacklogSections(wt)[0].claimedBy.length, 1)
  })
  await ok('dedupeBacklogSections tolerates absent, empty and malformed input', () => {
    assert.deepEqual(plain(dedupeBacklogSections([])), [])
    assert.deepEqual(plain(dedupeBacklogSections(undefined)), [])
    assert.deepEqual(plain(dedupeBacklogSections([{}])), [])
    assert.deepEqual(plain(dedupeBacklogSections([{ tasks: [{ rel: 'docs/TASKS.md' }] }])), [])
  })
}

// ---- the project field ------------------------------------------------------
// A request can arrive carrying the repo NAME as its project rather than its
// path: the orchestrator's own action schema shows the field as "<repo>".
// scoping.mjs would then spawn with that name as the cwd, and node reports a
// missing cwd as `spawn ... ENOENT`, which reads like the BINARY being
// missing. The validation is what stops that reaching a spawn at all.

// ---- the scoping `busy` flag rides on the request --------------------------
await ok('a scoping turn marks the REQUEST busy, and clears it when the turn ends', async () => {
  const { createScoper } = await import(join(ROOT, 'syzygy', 'bridge', 'scoping.mjs'))
  const calls = []
  const store = createStore({ file: join(dir, 'busy.json') })
  const r = store.create({ title: 'x', project: RDIR })
  const sc = createScoper({ store, broadcast: () => {}, spawn: fakeSpawn(calls) })
  await sc.start(r.id, 'hello', RDIR)
  assert.equal(store.get(r.id).scoping.busy, true, 'busy is set where the pane can read it')
  calls[0].child.finish(0)
  await new Promise((res) => setImmediate(res))
  assert.equal(store.get(r.id).scoping.busy, false, 'and cleared when the turn ends')
})

await ok('a FAILED scoping turn clears busy too -- it is over either way', async () => {
  const { createScoper } = await import(join(ROOT, 'syzygy', 'bridge', 'scoping.mjs'))
  const calls = []
  const store = createStore({ file: join(dir, 'busy2.json') })
  const r = store.create({ title: 'x', project: RDIR })
  const sc = createScoper({ store, broadcast: () => {}, spawn: fakeSpawn(calls) })
  await sc.start(r.id, 'hello', RDIR)
  calls[0].child.finish(3)
  await new Promise((res) => setImmediate(res))
  assert.equal(store.get(r.id).scoping.busy, false)
  assert.ok(store.get(r.id).error, 'and the failure is still recorded')
})

await ok('validateProject refuses a bare repo name, and NAMES the value', () => {
  const r = validateProject('demo-project')
  assert.equal(r.ok, false)
  assert.match(r.error, /demo-project/, 'the error must name the value it refused')
  assert.match(r.error, /absolute/i)
})

await ok('validateProject accepts an existing absolute directory, realpath-resolved', () => {
  const r = validateProject(dir)
  assert.equal(r.ok, true)
  assert.ok(r.project.startsWith('/'))
})

await ok('validateProject treats the empty string as "no project", not as an error', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.deepEqual(validateProject(v), { ok: true, project: '' }, JSON.stringify(v))
  }
})

await ok('validateProject refuses a path that does not exist, and a file', () => {
  assert.equal(validateProject(join(dir, 'nope')).ok, false)
  const f = join(dir, 'a-file')
  writeFileSync(f, 'x')
  assert.equal(validateProject(f).ok, false, 'a file is not a working directory')
})

await ok('validateProject is canvas.mjs\'s validateCwd, not a second implementation', async () => {
  const { validateCwd } = await import(join(ROOT, 'syzygy', 'bridge', 'canvas.mjs'))
  // The proof that matters: the same input gives the same resolved answer.
  assert.equal(validateProject(dir).project, validateCwd(dir).cwd)
})

// ---- the scoping child refuses a missing cwd before it spawns ---------------
await ok('a scoping turn with a missing project says WHICH thing is missing', async () => {
  const { createScoper } = await import(join(ROOT, 'syzygy', 'bridge', 'scoping.mjs'))
  const store = createStore({ file: join(dir, 'scope-cwd.json') })
  const r = store.create({ title: 'x', project: 'demo-project' })
  const scoper = createScoper({
    store, broadcast: () => {},
    // If this ever runs, the cwd check did not happen first.
    spawn: () => { throw new Error('spawn must not be reached for a missing cwd') },
    claudeBin: '/fake/claude',
  })
  const out = await scoper.start(r.id, 'hello', 'demo-project')
  const err = store.get(r.id)?.error?.message ?? out.error ?? ''
  assert.match(String(err), /project directory does not exist: demo-project/,
    `expected a message naming the directory, got: ${JSON.stringify(err)}`)
  assert.ok(!/ENOENT/.test(String(err)), 'never the raw ENOENT, which names the binary')
})

rmSync(dir, { recursive: true, force: true })
console.log(`\ndispatch harness: ${pass} checks passed`)
