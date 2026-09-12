#!/usr/bin/env node
// Drives bridge/orchestrator.mjs's pure half. Hermetic: no relay, no spawn.
// The base fixture (test/fixtures/orchestrator-state.json) is a REAL
// GET /api/state body, captured from an isolated relay carrying invented
// sessions, so the shape here is read off the wire, not invented.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const {
  bundleContext, parseActions, askArgv, ORCHESTRATOR_PREAMBLE, BUNDLE_BUDGET_BYTES, KNOWN_ACTION_KINDS,
  createOrchestrator, clipToWordBoundary, BLURB_MAX_CHARS, DEFAULT_BLURB_MIN_MS,
  ACTION_REQUIRED, reportInstruction, FINDINGS_IN_BUNDLE, DEFAULT_ASK_MODEL,
} = await import(join(ROOT, 'syzygy', 'bridge', 'orchestrator.mjs'))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }

const baseFixture = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'orchestrator-state.json'), 'utf8'))
// A deep-enough clone for these tests: every field this file mutates is a
// plain object/array, never a Map/Set/Date.
const clone = (o) => JSON.parse(JSON.stringify(o))

// A realistic fixture: the real base, PLUS the optional sections populated
// (they are all present-but-empty/null on the real capture, which is not
// enough to prove the render path renders them when they hold something).
const richFixture = () => {
  const f = clone(baseFixture)
  f.usage = { fiveHour: { pct: 42 }, sevenDay: { pct: 10 }, observedAt: 1, stale: false }
  f.afterReset = { queue: [{ id: 'e1', kind: 'prompt', window: 'fiveHour', target: 's1', payload: {} }] }
  f.steering = { custom: [{ id: 'c1', label: 'ship it', text: 'run the deploy' }] }
  f.links = [{ id: 'l1', t: 1, from: f.sessions[0].id, to: f.sessions[0].id, kind: 'brief', note: 'a note' }]
  f.dispatch = { requests: [{ id: 'r1', state: 'queued', title: 'do the thing', project: 'proj' }] }
  f.projects = [{ key: 'p1', name: 'proj', worktrees: [{ path: '/x', plans: [{ id: 'a' }], tasks: [{ id: 'b' }], claims: {} }] }]
  f.canvas = { ...f.canvas, nodes: { [f.sessions[0].id]: { x: 1, y: 2, name: f.sessions[0].name } }, spawnedBy: [{ shortId: 'sh1', name: 'spawned-one', state: 'starting' }] }
  return f
}

// One record, in the shape the store pins.
const aFinding = (over = {}) => ({
  id: 'f1', t: 1_000_000, session: 'worker-a', project: 'proj',
  touched: ['bridge/relay.mjs'], surprise: 'the flag is variadic',
  evidence: ['bridge/dispatch.mjs:167'], ...over,
})

await ok('every section appears, in priority order, on a realistic fixture', () => {
  const out = bundleContext(richFixture(), {
    capture: [{ t: 1, kind: 'link', actor: 's1' }], findings: [aFinding()],
  })
  const headers = [...out.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  assert.deepEqual(headers, [
    'Sessions', 'Findings', 'Links', 'Canvas', 'Dispatch queue', 'Projects',
    'Recent activity', 'Usage window', 'Scheduled (after reset)', 'Custom steering',
  ])
})

await ok('the output never exceeds the 80 KB budget for a deliberately oversized fixture', () => {
  const f = richFixture()
  const one = f.sessions[0]
  f.sessions = Array.from({ length: 2000 }, (_, i) => ({ ...one, id: `s${i}`, name: `session-${i}`, needs: 'x'.repeat(500) }))
  const bigCapture = Array.from({ length: 2000 }, (_, i) => ({ t: i, kind: 'link', actor: `s${i}` }))
  const out = bundleContext(f, { capture: bigCapture })
  assert.ok(Buffer.byteLength(out, 'utf8') <= BUNDLE_BUDGET_BYTES, `${Buffer.byteLength(out, 'utf8')} > ${BUNDLE_BUDGET_BYTES}`)
})

await ok('truncation emits an explicit "… N more" line and the count is right', () => {
  const f = richFixture()
  const one = f.sessions[0]
  f.sessions = Array.from({ length: 3000 }, (_, i) => ({ ...one, id: `s${i}`, name: `session-${i}`, needs: 'x'.repeat(500) }))
  const out = bundleContext(f, {})
  const m = out.match(/_… (\d+) more sessions omitted \(budget\)_/)
  assert.ok(m, 'expected an explicit omission line')
  const shownLines = (out.match(/^- \*\*session-/gm) || []).length
  assert.equal(shownLines + Number(m[1]), f.sessions.length, 'shown + omitted must equal the total')
})

await ok('a payload with no usage/afterReset/steering omits those sections rather than rendering them empty', () => {
  const f = richFixture()
  delete f.usage
  delete f.afterReset
  delete f.steering
  const out = bundleContext(f, {})
  assert.ok(!out.includes('## Usage window'))
  assert.ok(!out.includes('## Scheduled (after reset)'))
  assert.ok(!out.includes('## Custom steering'))
  // The other sections must still render -- this is a partial older relay,
  // not a broken one.
  assert.ok(out.includes('## Sessions'))
})

await ok('a present-but-empty usage/afterReset/steering (a real, current relay with nothing to report) still renders honestly', () => {
  const f = richFixture()
  f.usage = { fiveHour: null, sevenDay: null, observedAt: null, stale: true }
  f.afterReset = { queue: [] }
  f.steering = { custom: [] }
  const out = bundleContext(f, {})
  assert.ok(out.includes('## Usage window'))
  assert.ok(out.includes('no reading yet'))
  // Nothing scheduled and no custom commands render no misleading content --
  // an empty list is not a "section", it is nothing to say.
  assert.ok(!out.includes('## Scheduled (after reset)'))
  assert.ok(!out.includes('## Custom steering'))
})

// ------------------------------------------------------------ findings
// An answer TAIL is not a finding, so a session's `lastAnswer` is never
// rendered. The first of these pins the intent that outlives it (a section
// with nothing behind it renders NOTHING, never an empty-looking one), and
// the other two pin what carries a session's knowledge instead.
await ok('a session\'s lastAnswer tail is never rendered: a sliced transcript is not a finding', () => {
  const f = richFixture()
  f.sessions[0].lastAnswer = 'all green'
  const out = bundleContext(f, {})
  assert.ok(!out.includes('last said'), 'no answer-tail line')
  assert.ok(!out.includes('all green'), 'and none of its content')
})

await ok('no findings renders no Findings section at all, rather than an empty one', () => {
  assert.ok(!bundleContext(richFixture(), {}).includes('## Findings'))
  assert.ok(!bundleContext(richFixture(), { findings: [] }).includes('## Findings'))
})

await ok('a finding renders its session, project, surprise, touched and evidence', () => {
  const out = bundleContext(richFixture(), { findings: [aFinding()], now: 1_000_000 })
  assert.ok(out.includes('## Findings'))
  assert.ok(out.includes('**worker-a**'))
  assert.ok(out.includes('the flag is variadic'))
  assert.ok(out.includes('touched: bridge/relay.mjs'))
  assert.ok(out.includes('evidence: bridge/dispatch.mjs:167'))
})

await ok('an empty touched/evidence renders no empty label (a claim the record never made)', () => {
  const out = bundleContext(richFixture(), { findings: [aFinding({ touched: [], evidence: [] })] })
  assert.ok(out.includes('the flag is variadic'))
  assert.ok(!out.includes('touched:'))
  assert.ok(!out.includes('evidence:'))
})

await ok('findings render NEWEST FIRST, so budget truncation sheds the oldest', () => {
  const out = bundleContext(richFixture(), {
    findings: [aFinding({ id: 'old', surprise: 'OLDEST' }), aFinding({ id: 'new', surprise: 'NEWEST' })],
  })
  assert.ok(out.indexOf('NEWEST') < out.indexOf('OLDEST'))
})

await ok('the Findings section is capped at FINDINGS_IN_BUNDLE, keeping the newest', () => {
  const many = Array.from({ length: FINDINGS_IN_BUNDLE + 10 }, (_, i) => aFinding({ id: 'f' + i, surprise: 'S' + i }))
  const out = bundleContext(richFixture(), { findings: many })
  const shown = (out.match(/^- \*\*worker-a\*\*/gm) || []).length
  assert.equal(shown, FINDINGS_IN_BUNDLE)
  assert.ok(out.includes('S' + (many.length - 1)), 'the newest survives')
  assert.ok(!out.includes(' S0 ') && !out.includes('· S0'), 'the oldest does not')
})

await ok('dispatchOptions, voice and auth never appear', () => {
  const f = richFixture()
  f.dispatchOptions = { models: ['opus'], marker: 'MUST_NOT_APPEAR' }
  f.voice = { enabled: true, marker: 'MUST_NOT_APPEAR' }
  f.auth = { enabled: true, marker: 'MUST_NOT_APPEAR' }
  const out = bundleContext(f, {})
  assert.ok(!out.includes('MUST_NOT_APPEAR'))
})

await ok('claims are cross-referenced from projects.worktrees onto the owning session', () => {
  const f = richFixture()
  const sid = f.sessions[0].id
  f.projects[0].worktrees[0].claims = { [sid]: { name: 'the-plan', items: [] } }
  const out = bundleContext(f, {})
  assert.ok(out.includes('claim: the-plan'))
})

// -------------------------------------------------------------- parseActions
await ok('parseActions returns [] for a reply with no fenced block', () => {
  const { actions, rejected } = parseActions('just some prose, no block here')
  assert.deepEqual(actions, [])
  assert.deepEqual(rejected, [])
})

await ok('parseActions reads a fenced block and ignores prose around it', () => {
  const text = [
    'Here is my answer to your question.',
    '',
    '```json',
    '{"actions":[{"kind":"link","from":"a","to":"b","note":"pair these up"}]}',
    '```',
    '',
    'Let me know if you want anything else.',
  ].join('\n')
  const { actions, rejected } = parseActions(text)
  assert.equal(rejected.length, 0)
  assert.deepEqual(actions, [{ kind: 'link', from: 'a', to: 'b', note: 'pair these up' }])
})

await ok('parseActions puts an unknown kind in rejected, never in actions', () => {
  const text = '```json\n{"actions":[{"kind":"delete-everything","id":"x"}]}\n```'
  const { actions, rejected } = parseActions(text)
  assert.deepEqual(actions, [])
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].kind, 'delete-everything')
})

await ok('parseActions handles a mix of known and unknown kinds', () => {
  const text = '```json\n{"actions":[{"kind":"prompt","to":"a","text":"hi"},{"kind":"nope"}]}\n```'
  const { actions, rejected } = parseActions(text)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].kind, 'prompt')
  assert.equal(rejected.length, 1)
})

await ok('parseActions degrades to empty on malformed JSON inside the fence, rather than throwing', () => {
  const text = '```json\n{ this is not json\n```'
  assert.deepEqual(parseActions(text), { actions: [], rejected: [], text })
})

// ------------------------------------------------- parseActions text
await ok('parseActions returns the text unchanged when there is no fenced block', () => {
  const text = 'just some prose, no block here'
  assert.equal(parseActions(text).text, text)
})

await ok('parseActions strips a valid trailing action block from the returned text, keeping the prose', () => {
  const text = [
    'Here is my answer to your question.',
    '',
    '```json',
    '{"actions":[{"kind":"link","from":"a","to":"b","note":"pair these up"}]}',
    '```',
  ].join('\n')
  const { text: out } = parseActions(text)
  assert.equal(out, 'Here is my answer to your question.')
  assert.ok(!out.includes('```'), 'the fence delimiters must be gone too, not just re-labelled')
  assert.ok(!out.includes('"actions"'), 'the raw JSON must never remain visible')
})

await ok('parseActions returns empty text (never a lone blank bubble) for a reply that is ONLY an action block', () => {
  const text = '```json\n{"actions":[{"kind":"prompt","to":"a","text":"hi"}]}\n```'
  const { text: out, actions } = parseActions(text)
  assert.equal(out, '')
  assert.equal(actions.length, 1)
})

await ok('parseActions leaves an earlier, unrelated fenced code block untouched -- only the LAST (action) fence is stripped', () => {
  const text = [
    'Example config:',
    '```json',
    '{"unrelated": true}',
    '```',
    'Now the actions:',
    '```json',
    '{"actions":[{"kind":"link","from":"a","to":"b"}]}',
    '```',
  ].join('\n')
  const { text: out } = parseActions(text)
  assert.ok(out.includes('{"unrelated": true}'), 'the earlier, unrelated fence must survive')
  assert.ok(!out.includes('"actions"'), 'only the action fence is removed')
})

await ok('parseActions leaves the text fully visible when the fenced block fails to parse -- the only evidence of what went wrong', () => {
  const text = 'My proposal:\n```json\n{ not valid json at all\n```'
  const { text: out, actions, rejected } = parseActions(text)
  assert.equal(out, text)
  assert.deepEqual(actions, [])
  assert.deepEqual(rejected, [])
})

await ok('parseActions reads the LAST fenced block when more than one is present', () => {
  const text = '```json\n{"actions":[{"kind":"link","from":"x","to":"y"}]}\n```\nthen more thinking\n```json\n{"actions":[{"kind":"prompt","to":"z","text":"hi"}]}\n```'
  const { actions } = parseActions(text)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].kind, 'prompt')
})

// The set is exactly the four kinds the parser documents, so a kind added in
// code without a documented line fails here.
await ok('KNOWN_ACTION_KINDS is exactly link, prompt, dispatch and spawn', () => {
  assert.deepEqual([...KNOWN_ACTION_KINDS].sort(), ['dispatch', 'link', 'prompt', 'spawn'])
  assert.deepEqual(Object.keys(ACTION_REQUIRED).sort(), ['dispatch', 'link', 'prompt', 'spawn'])
})

// ---------------------------------------------- dispatch and spawn actions
await ok('a dispatch action needs only a title, and passes through unchanged', () => {
  const { actions, rejected } = parseActions('```json\n{"actions":[{"kind":"dispatch","title":"do the thing","ask":"in full"}]}\n```')
  assert.deepEqual(rejected, [])
  assert.deepEqual(actions, [{ kind: 'dispatch', title: 'do the thing', ask: 'in full' }])
})

await ok('a spawn action needs a cwd and a prompt', () => {
  const good = parseActions('```json\n{"actions":[{"kind":"spawn","cwd":"/tmp/x","prompt":"go collect"}]}\n```')
  assert.equal(good.actions.length, 1)
  assert.equal(good.rejected.length, 0)
  const bad = parseActions('```json\n{"actions":[{"kind":"spawn","cwd":"/tmp/x"}]}\n```')
  assert.deepEqual(bad.actions, [])
  assert.equal(bad.rejected.length, 1, 'a known kind missing a required field is rejected, never a button')
})

await ok('a known kind whose required field is present but blank is rejected too', () => {
  const { actions, rejected } = parseActions('```json\n{"actions":[{"kind":"link","from":"a","to":"   "}]}\n```')
  assert.deepEqual(actions, [])
  assert.equal(rejected.length, 1)
})

// ---------------------------------------------------------- report_to
await ok('a prompt with no report_to is byte-for-byte what it was', () => {
  const { actions } = parseActions('```json\n{"actions":[{"kind":"prompt","to":"a","text":"hi"}]}\n```')
  assert.deepEqual(actions, [{ kind: 'prompt', to: 'a', text: 'hi' }])
})

await ok('report_to folds the report instruction into the enqueued prompt text', () => {
  const { actions } = parseActions('```json\n{"actions":[{"kind":"prompt","to":"a","text":"look at X","report_to":"lead"}]}\n```')
  assert.equal(actions.length, 1)
  assert.ok(actions[0].text.startsWith('look at X'), 'the original prompt is still the head of it')
  assert.ok(actions[0].text.includes('"lead"'), 'and names the session to report to')
  assert.ok(actions[0].text.includes('SendMessage'))
  assert.equal(actions[0].text, 'look at X' + reportInstruction('lead'))
  assert.equal(actions[0].report_to, 'lead', 'kept on the action so the button can label it')
})

await ok('report_to asks for the four fields a findings record is made of', () => {
  const line = reportInstruction('lead')
  for (const bit of ['what you did', 'what you touched', 'surprised you', 'file:line']) {
    assert.ok(line.includes(bit), `missing: ${bit}`)
  }
})

await ok('a blank report_to is ignored rather than folding an empty name in', () => {
  const { actions } = parseActions('```json\n{"actions":[{"kind":"prompt","to":"a","text":"hi","report_to":"  "}]}\n```')
  assert.deepEqual(actions, [{ kind: 'prompt', to: 'a', text: 'hi', report_to: '  ' }])
})

// ------------------------------------------------------------------ askArgv
await ok('askArgv puts the prompt last', () => {
  const argv = askArgv({ text: 'hello there' })
  assert.equal(argv[argv.length - 1], 'hello there')
})

await ok('askArgv always includes --verbose', () => {
  const argv = askArgv({ text: 'x' })
  assert.ok(argv.includes('--verbose'))
})

await ok('askArgv includes --resume only when a session id is given', () => {
  const without = askArgv({ text: 'x' })
  assert.ok(!without.includes('--resume'))
  const withId = askArgv({ text: 'x', sessionId: 'abc123' })
  const i = withId.indexOf('--resume')
  assert.ok(i !== -1)
  assert.equal(withId[i + 1], 'abc123')
})

// The relay's own children must not join the switchboard. Two layers, and the
// harness asserts both: --settings carries SZG_HEADLESS on EVERY child (the
// plugin reads it and skips the whole relay handshake), and --safe-mode is
// added only when the boot probe saw the flag on the resolved binary.
await ok('askArgv always tells the child it is headless, on the argv', () => {
  const argv = askArgv({ text: 'x' })
  const i = argv.indexOf('--settings')
  assert.ok(i !== -1, 'no --settings on the argv')
  assert.deepEqual(JSON.parse(argv[i + 1]), { env: { SZG_HEADLESS: '1' } })
  assert.ok(argv.indexOf('--settings') < argv.length - 1, 'the prompt is still last')
  assert.equal(argv[argv.length - 1], 'x')
})

await ok('askArgv passes --safe-mode only when the binary was probed for it', () => {
  assert.ok(!askArgv({ text: 'x' }).includes('--safe-mode'), 'not by default')
  assert.ok(!askArgv({ text: 'x', safeMode: false }).includes('--safe-mode'))
  const on = askArgv({ text: 'x', safeMode: true })
  assert.ok(on.includes('--safe-mode'))
  assert.equal(on[on.length - 1], 'x', 'the prompt is still the last element')
})

await ok('askArgv carries model, budget and the append-system-prompt', () => {
  const argv = askArgv({ text: 'x', model: 'sonnet', budgetUsd: 0.05, preamble: 'PRE' })
  assert.ok(argv.includes('--model'))
  assert.equal(argv[argv.indexOf('--model') + 1], 'sonnet')
  assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '0.05')
  assert.equal(argv[argv.indexOf('--append-system-prompt') + 1], 'PRE')
})

await ok('askArgv is a plain array of strings -- no shell string anywhere', () => {
  const argv = askArgv({ text: 'x; rm -rf /', sessionId: 'a b' })
  assert.ok(Array.isArray(argv))
  for (const a of argv) assert.equal(typeof a, 'string')
})

await ok('ORCHESTRATOR_PREAMBLE says the agent may propose but never perform', () => {
  assert.ok(/propose/i.test(ORCHESTRATOR_PREAMBLE))
  assert.ok(/never/i.test(ORCHESTRATOR_PREAMBLE))
})

// -------------------------------------------------------------- clipToWordBoundary
await ok('clipToWordBoundary leaves a short line alone', () => {
  assert.equal(clipToWordBoundary('short line'), 'short line')
})

await ok('clipToWordBoundary cuts on a word boundary, never mid-word', () => {
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')
  const out = clipToWordBoundary(long, 40)
  assert.ok(out.length <= 41, `${out.length} > 41`) // 40 + the ellipsis char
  assert.ok(out.endsWith('…'))
  assert.ok(!/word\d+…$/.test(out) || long.slice(0, out.length - 1).endsWith(out.slice(0, -1).split(' ').pop()))
  // The clipped text, minus the ellipsis, must be a PREFIX of the original
  // that ends exactly at a space boundary in the source (or at the very end).
  const body = out.slice(0, -1)
  assert.ok(long.startsWith(body))
  const nextChar = long[body.length]
  assert.ok(nextChar === undefined || nextChar === ' ', 'must not cut mid-word')
})

// ---------------------------------------------------- createOrchestrator (impure)
/** A fake child process -- identical shape to test/dispatch-harness.mjs's
 *  fakeSpawn for scoping.mjs's createScoper, since createOrchestrator's `run`
 *  mirrors createScoper's `run` exactly. */
const fakeSpawn = (calls) => (bin, argv, opts) => {
  const listeners = { stdout: [], stderr: [], close: [], error: [] }
  const child = {
    killed: false,
    stdout: { setEncoding() {}, on(_e, f) { listeners.stdout.push(f) } },
    stderr: { setEncoding() {}, on(_e, f) { listeners.stderr.push(f) } },
    on(e, f) { if (e === 'close') listeners.close.push(f); else if (e === 'error') listeners.error.push(f) },
    kill() { this.killed = true; for (const f of listeners.close) f(143) },
    emit(text) { for (const f of listeners.stdout) f(text) },
    emitErr(text) { for (const f of listeners.stderr) f(text) },
    finish(code = 0) { for (const f of listeners.close) f(code) },
    emitError(err) { for (const f of listeners.error) f(err) },
  }
  calls.push({ bin, argv, opts, child })
  return child
}
const frame = (obj) => JSON.stringify(obj) + '\n'
const assistantFrame = (text) => frame({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
// a REAL captured run of the CLI (2.1.269, `--include-partial-
// messages`), trimmed of bulk irrelevant fields (the `system/init` frame's
// tool/plugin lists, the thinking block's giant signature blob) but every
// field NAME and shape kept verbatim: a mocked subprocess cannot verify a
// frame shape any more than it can verify a command line.
const STREAM_FIXTURE = readFileSync(join(ROOT, 'test', 'fixtures', 'orchestrator-stream-sample.ndjson'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))
const fakeCapture = () => {
  const appended = []
  return { appended, read: () => [], append: (kind, actor, payload) => { appended.push({ kind, actor, payload }); return true } }
}
const emptySnapshot = () => ({ sessions: [], links: [], canvas: {}, dispatch: { requests: [] }, projects: [] })

await ok('a second ask while one is live gets 409 (the concurrency cap of one, shared with the blurb)', async () => {
  const calls = []
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(), snapshot: emptySnapshot })
  const first = orch.ask('hello')
  const second = await orch.refreshBlurb({ force: true })
  assert.equal(second.ok, false)
  assert.equal(second.code, 409)
  const thirdAsk = await orch.ask('another')
  assert.equal(thirdAsk.ok, false)
  assert.equal(thirdAsk.code, 409)
  calls[0].child.finish(0)
  await first
})

// ---------------------------------------------- ask preempts a blurb
await ok('an ask preempts an in-flight blurb rather than getting a 409, and never corrupts the preempted blurb\'s own bookkeeping', async () => {
  const calls = []
  const sent = []
  const snap = { ...emptySnapshot(), sessions: [{ id: 's1', working: true }] }
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: (t, d) => sent.push([t, d]), capture: fakeCapture(),
    snapshot: () => snap, panesSize: () => 1,
  })
  const blurbPromise = orch.refreshBlurb({ force: true }) // never finishes on its own
  assert.equal(calls.length, 1)

  const askPromise = orch.ask('what now')
  // Never refused with 409 -- it spawned its OWN child, and the in-flight
  // blurb's child was killed to free the shared slot for it.
  assert.equal(calls.length, 2, 'the ask spawned its own child rather than being refused')
  assert.equal(calls[0].child.killed, true, 'the in-flight blurb was killed to free the slot')

  const blurbResult = await blurbPromise
  assert.equal(blurbResult.ok, false, 'the preempted blurb never produces a usable result')
  // Never a stale busy:false broadcast out from under the ask that is still
  // running -- the last busy signal sent must remain "busy".
  const busyFrames = sent.filter(([t, d]) => t === 'orchestrator' && !('id' in d) && 'busy' in d)
  assert.ok(busyFrames.length > 0)
  assert.equal(busyFrames[busyFrames.length - 1][1].busy, true, 'busy must still read true while the ask that preempted the blurb keeps running')

  calls[1].child.emit(assistantFrame('the answer'))
  calls[1].child.finish(0)
  const askResult = await askPromise
  assert.equal(askResult.ok, true, 'the ask itself completed normally despite preempting a blurb')

  // The preempted attempt is never recorded as a completed blurb turn: state
  // stays at its construction defaults, so a later periodic tick against the
  // SAME board is still free to try again rather than reading "no change".
  assert.equal(orch.state().blurbAt, 0)
  assert.equal(orch.state().blurb, '')

  calls[2].child.finish(0) // drain the ask's own unconditional after-reply blurb refresh
})

await ok('an ask still 409s against another in-flight ASK -- only a blurb may ever be preempted', async () => {
  const calls = []
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(), snapshot: emptySnapshot })
  const p1 = orch.ask('first')
  assert.equal(calls.length, 1)
  const second = await orch.ask('second')
  assert.equal(second.ok, false)
  assert.equal(second.code, 409)
  assert.equal(calls.length, 1, 'no second child was spawned -- an ask never preempts another ask')
  calls[0].child.finish(0)
  await p1
  calls[1].child.finish(0) // drain the auto blurb
})

await ok('a timeout kills the child', async () => {
  const calls = []
  // The timeout's own timer is unref()'d in production (mirroring
  // scoping.mjs exactly), which is safe there because a REAL spawned child's
  // own I/O handles keep the event loop alive regardless. This fake child has
  // no real I/O at all, so without something else to keep the loop alive,
  // Node can decide there is nothing left to do and exit before an unref'd
  // timer ever fires -- a test artifact, not a production concern.
  const keepAlive = setInterval(() => {}, 20)
  try {
    const orch = createOrchestrator({
      spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(),
      snapshot: emptySnapshot, askTimeoutMs: 5,
    })
    await orch.ask('hello') // the fake child never closes on its own -- only the timeout ends this
    assert.equal(calls[0].child.killed, true)
  } finally {
    clearInterval(keepAlive)
  }
})

await ok('killAll() kills it on shutdown', async () => {
  const calls = []
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(), snapshot: emptySnapshot })
  const p = orch.ask('hello') // never resolves on its own -- the fake child never closes
  orch.killAll() // kills the fake child directly, which resolves p via its own 'close' emission
  assert.equal(calls[0].child.killed, true)
  await p
})

await ok('the env handed to spawn contains no SZG_* key', async () => {
  process.env.SZG_TEST_LEAK_CHECK = 'should-never-reach-a-child'
  try {
    const calls = []
    const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(), snapshot: emptySnapshot })
    const p = orch.ask('hello')
    assert.ok(calls[0].opts.env, 'an env was passed')
    assert.ok(!Object.keys(calls[0].opts.env).some((k) => k.startsWith('SZG_')), 'no SZG_* key reached the child')
    calls[0].child.finish(0)
    await p
  } finally {
    delete process.env.SZG_TEST_LEAK_CHECK
  }
})

await ok('the child\'s stdin is closed, never left as an open pipe it will wait on', async () => {
  // The prompt always goes on the argv (askArgv puts it last); the child
  // never reads stdin. Verified LIVE that the default 'pipe' leaves stdin open
  // and the CLI then stalls for seconds waiting for input that will never come
  // before printing "proceeding without it" -- first stdout byte several
  // seconds later than with stdin closed outright. This only guards the
  // regression; the timing claim itself cannot be proven by a harness that
  // mocks the subprocess.
  const calls = []
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(), snapshot: emptySnapshot })
  const p = orch.ask('hello')
  assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe'])
  calls[0].child.finish(0)
  await p
})

await ok('a follow-up carries --resume and clear drops the session id', async () => {
  // Every SUCCESSFUL ask also fires an unconditional force:true blurb refresh
  // ("after every ask reply" trigger) before its own promise settles,
  // which spawns one more fake child sharing the same concurrency slot --
  // `drainAutoBlurb` finishes that extra call so the next deliberate ask()
  // is not itself refused with 409 by a slot the last ask's own side effect
  // is still holding.
  const calls = []
  const drainAutoBlurb = () => { calls[calls.length - 1].child.finish(0) }
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(), snapshot: emptySnapshot })
  const p1 = orch.ask('first')
  calls[0].child.emit(frame({ type: 'system', session_id: 'sess-orch-1' }))
  calls[0].child.finish(0)
  await p1
  drainAutoBlurb() // calls[1]: the auto-triggered blurb after the first ask
  const p2 = orch.ask('second')
  const askCall2 = calls[2]
  const i = askCall2.argv.indexOf('--resume')
  assert.ok(i > 0, '--resume must be present on the follow-up')
  assert.equal(askCall2.argv[i + 1], 'sess-orch-1')
  askCall2.child.finish(0)
  await p2
  drainAutoBlurb() // calls[3]: the auto-triggered blurb after the second ask
  orch.clear()
  const p3 = orch.ask('third')
  assert.ok(!calls[4].argv.includes('--resume'), '--resume must be gone after clear()')
  calls[4].child.finish(0)
  await p3
})

await ok('a non-zero exit becomes an error frame, not an unhandled rejection', async () => {
  const calls = []
  const sent = []
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: (t, d) => sent.push([t, d]), capture: fakeCapture(), snapshot: emptySnapshot })
  const p = orch.ask('hello')
  calls[0].child.emit(assistantFrame('partial'))
  calls[0].child.finish(1)
  const out = await p
  assert.equal(out.ok, true, 'the ROUTE call itself never throws or reports failure')
  const errorFrame = sent.find(([t, d]) => t === 'orchestrator' && 'error' in d)
  assert.ok(errorFrame, 'an error frame was broadcast')
})

// -------------------------------------------------- partial streaming
await ok('partial stream_event text_delta frames stream incrementally, and the completed assistant frame is not doubled (real captured frames, 2.1.269)', async () => {
  const calls = []
  const deltas = []
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: (t, d) => { if (t === 'orchestrator' && typeof d.delta === 'string') deltas.push(d.delta) }, capture: fakeCapture(), snapshot: emptySnapshot,
  })
  const p = orch.ask('say hi')
  for (const f of STREAM_FIXTURE) calls[0].child.emit(frame(f))
  calls[0].child.finish(0)
  const out = await p
  assert.equal(out.ok, true)
  // Real capture: block 0 is `thinking` (must never leak into the visible
  // reply), block 1 is `text` streamed as a delta ("hi there"), THEN a
  // completed `assistant` frame carrying the identical text -- the dedup
  // this fixture exists to prove.
  assert.deepEqual(deltas, ['hi there'], 'exactly one delta, from the partial frame -- the completed assistant frame must not add a second')
})

await ok('the final done frame\'s text is the deduped reply exactly once', async () => {
  const calls = []
  const doneFrames = []
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: (t, d) => { if (t === 'orchestrator' && d.done) doneFrames.push(d) }, capture: fakeCapture(), snapshot: emptySnapshot,
  })
  const p = orch.ask('say hi')
  for (const f of STREAM_FIXTURE) calls[0].child.emit(frame(f))
  calls[0].child.finish(0)
  await p
  assert.equal(doneFrames.length, 1)
  assert.equal(doneFrames[0].text, 'hi there')
})

await ok('many small text_delta chunks accumulate to the exact concatenation, with no doubling from the trailing complete assistant frame', async () => {
  const calls = []
  const deltas = []
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: (t, d) => { if (t === 'orchestrator' && typeof d.delta === 'string') deltas.push(d.delta) }, capture: fakeCapture(), snapshot: emptySnapshot,
  })
  const p = orch.ask('spell it out')
  const streamEvent = (event) => frame({ type: 'stream_event', event })
  calls[0].child.emit(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  for (const chunk of ['Hel', 'lo', ', ', 'world', '!']) {
    calls[0].child.emit(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }))
  }
  calls[0].child.emit(streamEvent({ type: 'content_block_stop', index: 0 }))
  // The completed assistant frame the real CLI also sends -- must be
  // ignored now that its text already streamed via deltas above.
  calls[0].child.emit(assistantFrame('Hello, world!'))
  calls[0].child.finish(0)
  const out = await p
  assert.equal(out.ok, true)
  assert.equal(deltas.join(''), 'Hello, world!')
  assert.equal(deltas.length, 5, 'each chunk streamed as its own delta, not batched into one')
})

await ok('with no partial frames at all, the completed assistant frame is still the fallback (an older CLI degrades to this, never to silence)', async () => {
  const calls = []
  const deltas = []
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: (t, d) => { if (t === 'orchestrator' && typeof d.delta === 'string') deltas.push(d.delta) }, capture: fakeCapture(), snapshot: emptySnapshot,
  })
  const p = orch.ask('hello')
  calls[0].child.emit(assistantFrame('a plain reply'))
  calls[0].child.finish(0)
  const out = await p
  assert.equal(out.ok, true)
  assert.deepEqual(deltas, ['a plain reply'])
})

// ------------------------------------------------------- honest errors
await ok('known stdin-warning stderr noise is filtered out of the shown message, never presented as the reason a turn failed', async () => {
  const calls = []
  const sent = []
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: (t, d) => sent.push([t, d]), capture: fakeCapture(), snapshot: emptySnapshot })
  const p = orch.ask('hello')
  calls[0].child.emitErr('Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n')
  calls[0].child.finish(1)
  const out = await p
  assert.equal(out.ok, true)
  const errorFrame = sent.find(([t, d]) => t === 'orchestrator' && 'error' in d)
  assert.ok(errorFrame)
  assert.ok(!/no stdin data/i.test(errorFrame[1].error), 'the noisy warning must never be shown as though it were the failure reason')
  assert.equal(errorFrame[1].error, 'exit 1', 'with the noise filtered and nothing else on stderr, the honest fallback is the exit code')
})

await ok('the terminal result frame\'s own `errors` is the reason shown, preferred over stderr, and any already-streamed text survives the failure', async () => {
  // Verified live: a budget-exhaustion run still streams a
  // complete, usable reply and writes NOTHING useful to stderr at all --
  // the real reason lives on this NDJSON frame, not stderr. Field names and
  // shape are verbatim from that capture.
  const calls = []
  const sent = []
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: (t, d) => sent.push([t, d]), capture: fakeCapture(), snapshot: emptySnapshot })
  const p = orch.ask('write something long')
  calls[0].child.emit(assistantFrame('as much of the essay as it got through'))
  calls[0].child.emitErr('Warning: no stdin data received in 3s, proceeding without it.\n')
  calls[0].child.emit(frame({
    type: 'result', is_error: true, subtype: 'error_max_budget_usd',
    errors: ['Reached maximum budget ($1.00)'], terminal_reason: 'budget_exhausted',
  }))
  calls[0].child.finish(1)
  const out = await p
  assert.equal(out.ok, true)
  const errorFrame = sent.find(([t, d]) => t === 'orchestrator' && 'error' in d)
  assert.ok(errorFrame)
  assert.equal(errorFrame[1].error, 'Reached maximum budget ($1.00)')
  assert.equal(errorFrame[1].text, 'as much of the essay as it got through', 'the text the model DID produce is never discarded just because the turn ended in error')
})

await ok('ask() applies the ask model/budget and puts the bundle + prompt in the user turn, prompt last', async () => {
  const calls = []
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(), snapshot: emptySnapshot })
  const p = orch.ask('what is going on?')
  assert.equal(calls[0].argv[calls[0].argv.length - 1].endsWith('what is going on?'), true)
  assert.ok(calls[0].argv[calls[0].argv.length - 1].includes('## Board state (now)'))
  // sonnet: the ask reads a bundle and answers about it,
  // which does not need
  // the larger model, and every ask is real money. Asserted against the
  // exported default rather than a literal, so changing the default in one
  // place cannot leave this silently pinning the old one -- and one extra
  // check that the default IS sonnet, so a silent flip back to opus fails
  // here rather than on the invoice.
  assert.equal(calls[0].argv[calls[0].argv.indexOf('--model') + 1], DEFAULT_ASK_MODEL)
  assert.equal(DEFAULT_ASK_MODEL, 'sonnet')
  calls[0].child.finish(0)
  await p
})

await ok('ask() bundles the injected findings store into the user turn', async () => {
  const calls = []
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(),
    snapshot: emptySnapshot,
    findings: { read: () => [aFinding({ surprise: 'the daemon keeps the launcher environment' })] },
  })
  const p = orch.ask('what should I know?')
  const turn = calls[0].argv[calls[0].argv.length - 1]
  assert.ok(turn.includes('## Findings'))
  assert.ok(turn.includes('the daemon keeps the launcher environment'))
  calls[0].child.finish(0)
  await p
})

await ok('a relay with no findings store at all renders no Findings section, never an empty one', async () => {
  const calls = []
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(), snapshot: emptySnapshot,
  })
  const p = orch.ask('what should I know?')
  assert.ok(!calls[0].argv[calls[0].argv.length - 1].includes('## Findings'))
  calls[0].child.finish(0)
  await p
})

await ok('with no claudeBin, ask/refreshBlurb both answer 503 rather than spawning', async () => {
  const calls = []
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: '', broadcast: () => {}, capture: fakeCapture(), snapshot: emptySnapshot })
  const a = await orch.ask('hi')
  assert.equal(a.ok, false)
  assert.equal(a.code, 503)
  const b = await orch.refreshBlurb({ force: true })
  assert.equal(b.ok, false)
  assert.equal(b.code, 503)
  assert.equal(calls.length, 0, 'nothing was ever spawned')
})

// ---- the blurb's three-gate timer trigger ----------------------------------
await ok('the blurb refresh does not fire with no pane connected', async () => {
  const calls = []
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(),
    snapshot: () => ({ ...emptySnapshot(), sessions: [{ id: 's1' }] }), panesSize: () => 0,
  })
  const out = await orch.refreshBlurb()
  assert.equal(out.ok, false)
  assert.equal(calls.length, 0)
})

await ok('the blurb refresh does not fire when the board has not changed', async () => {
  const calls = []
  let snap = { ...emptySnapshot(), sessions: [{ id: 's1', working: true }] }
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(),
    snapshot: () => snap, panesSize: () => 1, blurbMinMs: 0,
  })
  const p1 = orch.refreshBlurb()
  calls[0].child.emit(assistantFrame('a summary'))
  calls[0].child.finish(0)
  const r1 = await p1
  assert.equal(r1.ok, true)
  // Same board, no time constraint (blurbMinMs: 0) -- must still refuse,
  // because nothing actually changed.
  const r2 = await orch.refreshBlurb()
  assert.equal(r2.ok, false)
  assert.equal(calls.length, 1, 'no second child was spawned')
})

await ok('the blurb refresh does not fire twice inside 10 minutes, even when the board changed', async () => {
  const calls = []
  let snap = { ...emptySnapshot(), sessions: [{ id: 's1', working: true }] }
  let t = 1_000_000
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(),
    snapshot: () => snap, panesSize: () => 1, now: () => t, blurbMinMs: DEFAULT_BLURB_MIN_MS,
  })
  const p1 = orch.refreshBlurb()
  calls[0].child.emit(assistantFrame('first summary'))
  calls[0].child.finish(0)
  await p1
  // The board changes AND ten minutes have not passed -- still refused.
  snap = { ...emptySnapshot(), sessions: [{ id: 's1', working: false }] }
  t += 60_000 // one minute later
  const r2 = await orch.refreshBlurb()
  assert.equal(r2.ok, false)
  assert.equal(calls.length, 1)
  // Past the 10-minute floor, with a changed board -- now it fires.
  t += DEFAULT_BLURB_MIN_MS
  const p3 = orch.refreshBlurb()
  calls[1].child.emit(assistantFrame('second summary'))
  calls[1].child.finish(0)
  const r3 = await p3
  assert.equal(r3.ok, true)
  assert.equal(calls.length, 2)
})

await ok('force:true (the ↻ button, and every ask reply) bypasses all three timer-only gates', async () => {
  const calls = []
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(),
    snapshot: emptySnapshot, panesSize: () => 0, // no pane connected at all
  })
  const p = orch.refreshBlurb({ force: true })
  assert.equal(calls.length, 1, 'force:true must spawn even with no pane connected')
  calls[0].child.emit(assistantFrame('forced summary'))
  calls[0].child.finish(0)
  const out = await p
  assert.equal(out.ok, true)
})

await ok('a successful blurb clips to 140 chars on a word boundary and updates state()', async () => {
  const calls = []
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(), snapshot: emptySnapshot })
  const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
  const p = orch.refreshBlurb({ force: true })
  calls[0].child.emit(assistantFrame(long))
  calls[0].child.finish(0)
  await p
  const st = orch.state()
  assert.ok(st.blurb.length <= BLURB_MAX_CHARS + 1)
  assert.equal(st.busy, false)
  assert.ok(st.blurbAt > 0)
})

await ok('refreshBlurb() broadcasts busy:true at its own start, mirroring ask()', async () => {
  const calls = []
  const sent = []
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: (t, d) => sent.push([t, d]), capture: fakeCapture(), snapshot: emptySnapshot })
  const p = orch.refreshBlurb({ force: true })
  assert.ok(sent.some(([t, d]) => t === 'orchestrator' && d.busy === true), 'busy:true was broadcast before the child even finished')
  calls[0].child.emit(assistantFrame('a summary'))
  calls[0].child.finish(0)
  await p
  assert.ok(sent.some(([t, d]) => t === 'orchestrator' && d.busy === false), 'busy:false was broadcast once it settled')
})

await ok('ask() captures kind "ask" to the capture log', async () => {
  const calls = []
  const capture = fakeCapture()
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture, snapshot: emptySnapshot })
  const p = orch.ask('what is happening')
  calls[0].child.finish(0)
  await p
  assert.ok(capture.appended.some((c) => c.kind === 'ask'))
})

console.log(`orchestrator-harness: ${pass} passed`)
