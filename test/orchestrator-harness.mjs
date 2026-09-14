#!/usr/bin/env node
// Drives bridge/orchestrator.mjs, its thread store and the relay's thread
// routes. Every `claude` is a fake; the one relay it boots binds port 0 against
// a temp data directory.
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
  ACTION_REQUIRED, ACTION_FIELD_RE, reportInstruction, FINDINGS_IN_BUNDLE, DEFAULT_ASK_MODEL,
  LIAISON_PREAMBLE, liaisonTurnText, liaisonPreamble, RISK_MAX,
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
  // `prompt`, not `text`: this is steering.mjs's own field name. The fixture
  // used to invent `text`, which is exactly why the bundle rendering `c.text`
  // passed for as long as it did.
  f.steering = { custom: [{ id: 'c1', label: 'ship it', prompt: 'run the deploy' }] }
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

await ok('custom steering renders the store\'s own field (`prompt`) -- a `text` that never existed rendered every button as an empty one', () => {
  const f = richFixture()
  const out = bundleContext(f, {})
  assert.ok(out.includes('## Custom steering'))
  assert.ok(out.includes('- ship it: run the deploy'),
    out.slice(out.indexOf('## Custom steering')).slice(0, 200))
  // The failure this replaces was silent and READABLE: a label, a colon and
  // nothing, which looks like a button with an empty prompt rather than a bug.
  assert.ok(!/^- ship it: *$/m.test(out), 'a label with nothing after it is the old bug')
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

// The action schema asks for a session, and /api/link and /api/command key by
// id -- but the bundle used to render a session by NAME only, so a real ask
// echoed the display name back and the applied action would have 404'd.
await ok('every session line carries its real id, in full, beside the name', () => {
  const f = richFixture()
  const out = bundleContext(f, {})
  for (const s of f.sessions) {
    assert.ok(out.includes('id `' + s.id + '`'), 'no id rendered for ' + s.name)
    assert.ok(out.includes('- **' + s.name + '**'), 'the name is still first and still bold')
  }
})

// A truncated id is worse than none: app.js's resolveSessionRef matches an id
// EXACTLY or a name EXACTLY, with no prefix branch, so a short id resolves to
// nothing and is POSTed verbatim.
await ok('the id is the whole id, never a prefix', () => {
  const f = richFixture()
  const out = bundleContext(f, {})
  const ids = [...out.matchAll(/id `([^`]+)`/g)].map((m) => m[1])
  assert.equal(ids.length, f.sessions.length)
  assert.deepEqual(ids, f.sessions.map((s) => s.id))
})

await ok('the preamble tells the model an action is keyed by the id it was shown', () => {
  assert.ok(/session ID/i.test(ORCHESTRATOR_PREAMBLE), 'the preamble never says what a <session> is')
  assert.ok(ORCHESTRATOR_PREAMBLE.includes('shown after `id`'))
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

// The bundle is sent to the model on every ask, a liaison's included, so a
// peer's roster, keys or asks rendered here would travel on to a third party.
await ok('## Peers renders name, health and session count, and nothing else from peers', () => {
  const f = richFixture()
  f.peers = { enabled: true, self: 'me', bind: '10.0.0.1', port: 4318, fingerprint: 'AA:BB', pairing: { expiresAt: 9 },
    list: [{ name: 'vm', remoteName: 'vm-host', dials: true, fingerprint: 'FP-SHOULD-NOT-APPEAR', policy: { asksPerHour: 20 },
      health: { state: 'up', rttMs: 4 }, sessions: [{ id: 's9', name: 'GHOST-SESSION-NAME' }, { id: 's8', name: 'other' }], counts: { asksIn: 1 } }],
    asks: [{ id: 'a', peer: 'vm', dir: 'out', text: 'ASK-TEXT-SHOULD-NOT-APPEAR', reply: 'REPLY-SHOULD-NOT-APPEAR' }], jobs: [] }
  const out = bundleContext(f)
  assert.match(out, /## Peers\n- \*\*vm\*\* — up, 2 session\(s\), peer_ask not accepted\n/)
  for (const leak of ['FP-SHOULD-NOT-APPEAR', 'vm-host', 'GHOST-SESSION-NAME', 'ASK-TEXT-SHOULD-NOT-APPEAR', 'REPLY-SHOULD-NOT-APPEAR', 'AA:BB', '10.0.0.1'])
    assert.equal(out.includes(leak), false, leak)
  assert.ok(out.indexOf('## Peers') > out.indexOf('## Recent activity') || !out.includes('## Recent activity'))
  assert.ok(out.indexOf('## Peers') < out.indexOf('## Usage window'), 'peers render before the usage window')
})

await ok('## Peers is absent when the relay predates peering, and empty lists render nothing', () => {
  assert.equal(bundleContext(richFixture()).includes('## Peers'), false)
  const f = richFixture(); f.peers = { list: [] }
  assert.equal(bundleContext(f).includes('## Peers'), false)
})

// -------------------------------------------------------- extras.bundleChains
// What a session has been working THROUGH is a different fact from what it
// last said, so it is a section of its own, off unless asked for.
const aChainFixture = () => ({
  s1: {
    blocks: [
      { id: 'b0', title: 'earlier subject', state: 'closed', by: 'heuristic', pinned: false, parent: null, turnCount: 2, startedAt: 1, endedAt: 2, rev: 0 },
      { id: 'b1', title: 'wiring the drawer', state: 'open', by: 'heuristic', pinned: false, parent: null, turnCount: 3, startedAt: 2, endedAt: 3, rev: 0 },
    ],
    open: 'b1', progress: 'writing chain.js', rev: 1, updatedAt: 3, refiner: { paused: false },
  },
})

await ok('## Chains never appears with the setting off, even with the key present -- byte-for-byte unchanged', () => {
  const withoutChains = richFixture()
  const withChains = richFixture()
  withChains.chains = aChainFixture()
  assert.equal(bundleContext(withChains, {}), bundleContext(withoutChains, {}))
  assert.equal(bundleContext(withChains, {}).includes('## Chains'), false)
})

await ok('## Chains is absent when the key is absent even with the setting on', () => {
  assert.equal(bundleContext(richFixture(), { bundleChains: true }).includes('## Chains'), false)
})

await ok('## Chains, on, names the open block', () => {
  const f = richFixture()
  f.chains = aChainFixture()
  const out = bundleContext(f, { bundleChains: true })
  assert.match(out, /## Chains\n- \*\*s1\*\* — now: wiring the drawer · writing chain\.js · before: earlier subject\n/)
})

// ------------------------------------------------------------ extras.scope
// A scope narrows the board to one project. Absent, it must render exactly
// what it always has; naming a project narrows both the Projects section
// and which sessions' cwd counts as "here"; naming one that does not exist
// narrows to NOTHING -- "I could not find it" and "here is the lot" are
// different answers, and only one of them is honest.
const scopedFixture = () => {
  const f = richFixture()
  f.projects = [
    { key: 'p1', name: 'proj-one', worktrees: [{ path: '/work/proj-one', plans: [], tasks: [] }] },
    { key: 'p2', name: 'proj-two', worktrees: [{ path: '/work/proj-two', plans: [], tasks: [] }] },
  ]
  const base = f.sessions[0]
  f.sessions = [
    { ...base, id: 's-in', name: 'in-scope', cwd: '/work/proj-one' },
    { ...base, id: 's-sub', name: 'in-scope-sub', cwd: '/work/proj-one/sub' },
    { ...base, id: 's-out', name: 'out-of-scope', cwd: '/work/proj-two' },
    { ...base, id: 's-nocwd', name: 'no-cwd' },
  ]
  return f
}

await ok('bundleContext(snap, {}) renders every project and session, unchanged', () => {
  const f = scopedFixture()
  const out = bundleContext(f, {})
  assert.ok(out.includes('proj-one'))
  assert.ok(out.includes('proj-two'))
  for (const s of f.sessions) assert.ok(out.includes(s.name), s.name + ' missing with no scope')
})

await ok('bundleContext(snap, { scope: null }) equals bundleContext(snap, {})', () => {
  const f = scopedFixture()
  assert.equal(bundleContext(f, { scope: null }), bundleContext(f, {}))
})

await ok('a project scope narrows ## Projects to that project, and no other', () => {
  const f = scopedFixture()
  const out = bundleContext(f, { scope: { project: 'p1' } })
  assert.ok(out.includes('proj-one'))
  assert.ok(!out.includes('proj-two'))
})

await ok('a project scope narrows ## Sessions to those whose cwd is inside its worktrees', () => {
  const f = scopedFixture()
  const out = bundleContext(f, { scope: { project: 'p1' } })
  assert.ok(out.includes('in-scope'))
  assert.ok(out.includes('in-scope-sub'), 'a subdirectory of the worktree path is still in scope')
  assert.ok(!out.includes('out-of-scope'))
  assert.ok(!out.includes('no-cwd'), 'a session reporting no cwd at all is never in scope')
})

await ok('a scope naming an unknown project narrows ## Projects to nothing, never to everything', () => {
  const f = scopedFixture()
  const out = bundleContext(f, { scope: { project: 'nope' } })
  assert.ok(!out.includes('## Projects'), 'no project matches, so the section renders nothing at all')
  assert.ok(!out.includes('proj-one'))
  assert.ok(!out.includes('proj-two'))
})

await ok('a scope naming an unknown project narrows ## Sessions to nothing too -- no worktree root exists to match against', () => {
  const f = scopedFixture()
  const out = bundleContext(f, { scope: { project: 'nope' } })
  assert.ok(!out.includes('## Sessions'))
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
  assert.deepEqual(parseActions(text), { actions: [], rejected: [], text, warnings: [] })
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

await ok('arm_resume is understood, and its mode is checked by VALUE', () => {
  const good = parseActions('x\n```json\n{"actions":[{"kind":"arm_resume","mode":"arm_weekly"}]}\n```')
  assert.equal(good.actions.length, 1)
  assert.equal(good.actions[0].mode, 'arm_weekly')
  for (const mode of ['sometimes', '', 'ARM']) {
    const bad = parseActions(`x\n\`\`\`json\n{"actions":[{"kind":"arm_resume","mode":${JSON.stringify(mode)}}]}\n\`\`\``)
    assert.equal(bad.actions.length, 0, mode)
    assert.equal(bad.rejected.length, 1, mode)
  }
})

// The set is exactly the seven kinds the parser documents, so a kind added in
// code without a documented line fails here.
await ok('KNOWN_ACTION_KINDS is exactly link, prompt, dispatch, spawn, arm_resume, drop and peer_ask', () => {
  assert.deepEqual([...KNOWN_ACTION_KINDS].sort(), ['arm_resume', 'dispatch', 'drop', 'link', 'peer_ask', 'prompt', 'spawn'])
  assert.deepEqual(Object.keys(ACTION_REQUIRED).sort(), ['arm_resume', 'dispatch', 'drop', 'link', 'peer_ask', 'prompt', 'spawn'])
})

// ------------------------------------------------------------ drop actions
await ok('a drop action needs a non-empty list of non-empty paths, and names no peer', () => {
  // `drop` is the first kind whose required field is an array, so the string
  // checker is left exactly as it is and a sibling list checker runs beside it.
  const NL = String.fromCharCode(10)
  const drop = (paths) => ['```json', '{"actions":[{"kind":"drop","paths":' + JSON.stringify(paths) + '}]}', '```'].join(NL)
  assert.deepEqual(parseActions('ok ' + drop(['/w/a.ts', '/w/b.ts'])).actions,
    [{ kind: 'drop', paths: ['/w/a.ts', '/w/b.ts'] }])
  // An empty array, a non-array, and an array with an empty string are rejected.
  for (const bad of [[], '/w/a.ts', [''], [null]]) {
    assert.equal(parseActions('x ' + drop(bad)).actions.length, 0)
    assert.equal(parseActions('x ' + drop(bad)).rejected.length, 1)
  }
  // Every kind that already existed still validates unchanged.
  assert.equal(KNOWN_ACTION_KINDS.size, 7)
})

await ok('a drop action is capped: 2,000 paths of 4,096 characters, and a note is a string', () => {
  const NL = String.fromCharCode(10)
  const block = (action) => ['```json', JSON.stringify({ actions: [action] }), '```'].join(NL)
  const one = (action) => parseActions('x ' + block(action))
  const many = Array.from({ length: 2000 }, (_, i) => '/w/' + i)
  assert.equal(one({ kind: 'drop', paths: many }).actions.length, 1, '2,000 paths is the cap, not past it')
  assert.equal(one({ kind: 'drop', paths: [...many, '/w/one-more'] }).rejected.length, 1, '2,001 paths')
  assert.equal(one({ kind: 'drop', paths: ['/' + 'a'.repeat(4095)] }).actions.length, 1, 'a 4,096-character path')
  assert.equal(one({ kind: 'drop', paths: ['/' + 'a'.repeat(4096)] }).rejected.length, 1, 'a 4,097-character path')
  assert.deepEqual(one({ kind: 'drop', paths: ['/w/a'], note: 'the fixtures' }).actions, [{ kind: 'drop', paths: ['/w/a'], note: 'the fixtures' }])
  for (const note of [3, null, ['x'], { t: 'x' }]) {
    assert.equal(one({ kind: 'drop', paths: ['/w/a'], note }).rejected.length, 1, JSON.stringify(note))
  }
  // A peer field is not how a drop is addressed; it passes through inert and
  // the pane never reads it.
  assert.equal(one({ kind: 'drop', paths: ['/w/a'] }).actions[0].peer, undefined)
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

// ---------------------------------------------- spawn/dispatch model+effort
await ok('a spawn action may carry model and effort, and keeps both when valid', () => {
  const { actions, rejected, warnings } = parseActions(
    '```json\n{"actions":[{"kind":"spawn","cwd":"/tmp/x","prompt":"go collect","name":"haiku-test","model":"haiku","effort":"low"}]}\n```',
  )
  assert.deepEqual(rejected, [])
  assert.deepEqual(warnings, [])
  assert.deepEqual(actions, [
    { kind: 'spawn', cwd: '/tmp/x', prompt: 'go collect', name: 'haiku-test', model: 'haiku', effort: 'low' },
  ])
})

await ok('an invalid model on a spawn action is dropped; the rest of the action is kept, not rejected', () => {
  const { actions, rejected, warnings } = parseActions(
    '```json\n{"actions":[{"kind":"spawn","cwd":"/tmp/x","prompt":"go collect","model":"--not-a-model","effort":"low"}]}\n```',
  )
  assert.deepEqual(rejected, [], 'a bad model must not sink the whole action')
  assert.equal(actions.length, 1)
  assert.equal(actions[0].model, undefined, 'the invalid field is gone')
  assert.equal(actions[0].effort, 'low', 'the valid field beside it survives')
  assert.equal(actions[0].cwd, '/tmp/x')
  assert.deepEqual(warnings, [{ kind: 'spawn', field: 'model', value: '--not-a-model' }])
})

await ok('an invalid effort is dropped the same way, on both spawn and dispatch', () => {
  for (const kind of ['spawn', 'dispatch']) {
    const req = kind === 'spawn' ? '"cwd":"/tmp/x","prompt":"go"' : '"title":"do the thing"'
    const { actions, rejected, warnings } = parseActions(
      `\`\`\`json\n{"actions":[{"kind":"${kind}",${req},"model":"sonnet","effort":"NOT-AN-EFFORT"}]}\n\`\`\``,
    )
    assert.deepEqual(rejected, [], kind)
    assert.equal(actions[0].effort, undefined, kind)
    assert.equal(actions[0].model, 'sonnet', kind)
    assert.deepEqual(warnings, [{ kind, field: 'effort', value: 'NOT-AN-EFFORT' }], kind)
  }
})

await ok('a dispatch action may carry model and effort too, since its record already stores both', () => {
  const { actions, rejected, warnings } = parseActions(
    '```json\n{"actions":[{"kind":"dispatch","title":"do the thing","model":"opus","effort":"xhigh"}]}\n```',
  )
  assert.deepEqual(rejected, [])
  assert.deepEqual(warnings, [])
  assert.deepEqual(actions, [{ kind: 'dispatch', title: 'do the thing', model: 'opus', effort: 'xhigh' }])
})

await ok('ACTION_FIELD_RE only names dispatch and spawn, and reuses requests.mjs\'s own regexes', () => {
  assert.deepEqual(Object.keys(ACTION_FIELD_RE).sort(), ['dispatch', 'spawn'])
  assert.ok(ACTION_FIELD_RE.spawn.model.test('sonnet'))
  assert.ok(ACTION_FIELD_RE.spawn.effort.test('high'))
})

await ok('the preamble documents model/effort on both dispatch and spawn', () => {
  assert.ok(/"kind": "dispatch".*"model\?"/.test(ORCHESTRATOR_PREAMBLE))
  assert.ok(/"kind": "dispatch".*"effort\?"/.test(ORCHESTRATOR_PREAMBLE))
  assert.ok(/"kind": "spawn".*"model\?"/.test(ORCHESTRATOR_PREAMBLE))
  assert.ok(/"kind": "spawn".*"effort\?"/.test(ORCHESTRATOR_PREAMBLE))
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

await ok('an ask still 409s against another in-flight ASK -- only a blurb or a liaison turn may ever be preempted', async () => {
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

// ---- the thread store --------------------------------------------------------
// Hermetic: a temp directory, never WORLD_DIR. Same rule as the capture and
// findings harnesses beside it.
const { createThreadStore, THREADS_MAX, THREAD_TURNS_MAX, TURN_TEXT_MAX, TITLE_MAX } =
  await import(join(ROOT, 'syzygy', 'bridge', 'orchestrator-threads.mjs'))
const { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync: rf, writeFileSync: wf } =
  await import('node:fs')
const { tmpdir } = await import('node:os')

const freshDir = () => mkdtempSync(join(tmpdir(), 'szg-threads-'))
const storeIn = (dir, over = {}) => createThreadStore({ file: join(dir, 'orchestrator-threads.json'), ...over })

await ok('a thread round-trips, and the newest is current', () => {
  const dir = freshDir()
  const s = storeIn(dir)
  assert.equal(s.current(), null, 'an empty store has no current thread')
  const a = s.create({})
  assert.equal(s.current().id, a.id)
  assert.equal(a.title, '')
  assert.deepEqual(a.turns, [])
  assert.equal(a.pinned, false)
  assert.equal(a.resumeSessionId, null)
  rmSync(dir, { recursive: true, force: true })
})

await ok('the first user turn auto-titles, and a rename is never overwritten', () => {
  const dir = freshDir(); const s = storeIn(dir)
  const t = s.create({})
  s.appendTurn(t.id, { role: 'user', text: 'why is dispatch-3 stuck on a permission prompt' })
  assert.match(s.get(t.id).title, /^why is dispatch-3 stuck/)
  s.rename(t.id, 'the stuck one')
  s.appendTurn(t.id, { role: 'user', text: 'and what about dispatch-4' })
  assert.equal(s.get(t.id).title, 'the stuck one', 'a chosen title survives the next question')
  const long = s.create({})
  s.appendTurn(long.id, { role: 'user', text: 'x'.repeat(200) })
  assert.ok(s.get(long.id).title.length <= TITLE_MAX, 'a spaceless first question still titles within TITLE_MAX, ellipsis included')
  rmSync(dir, { recursive: true, force: true })
})

await ok('turns are capped from the FRONT and a long turn is clipped, never dropped', () => {
  const dir = freshDir(); const s = storeIn(dir)
  const t = s.create({})
  for (let i = 0; i < THREAD_TURNS_MAX + 6; i++) s.appendTurn(t.id, { role: 'user', text: 'q' + i })
  const turns = s.get(t.id).turns
  assert.equal(turns.length, THREAD_TURNS_MAX)
  assert.equal(turns[turns.length - 1].text, 'q' + (THREAD_TURNS_MAX + 5), 'the newest survives')
  assert.equal(turns[0].text, 'q6', 'the oldest went first')
  s.appendTurn(t.id, { role: 'syzygy', text: 'x'.repeat(TURN_TEXT_MAX + 500) })
  const last = s.get(t.id).turns.at(-1)
  assert.equal(last.text.length, TURN_TEXT_MAX)
  assert.ok(last.text.endsWith('…'), 'clipped with an ellipsis rather than dropped')
  rmSync(dir, { recursive: true, force: true })
})

await ok('eviction drops the oldest UNPINNED thread and never a pinned one', () => {
  const dir = freshDir(); let clock = 1000
  const s = storeIn(dir, { now: () => clock++ })
  const first = s.create({}); s.setPinned(first.id, true)
  const second = s.create({})
  for (let i = 0; i < THREADS_MAX + 3; i++) s.create({})
  const ids = s.all().map((t) => t.id)
  assert.ok(ids.includes(first.id), 'the pinned thread survives eviction')
  assert.equal(ids.includes(second.id), false, 'the oldest unpinned one went')
  assert.equal(s.all().length, THREADS_MAX)
  rmSync(dir, { recursive: true, force: true })
})

await ok('pinned threads sort first, then by updatedAt descending', () => {
  const dir = freshDir(); let clock = 1000
  const s = storeIn(dir, { now: () => clock++ })
  const a = s.create({}); const b = s.create({}); const c = s.create({})
  s.setPinned(a.id, true)
  s.appendTurn(b.id, { role: 'user', text: 'newest touch' })
  assert.deepEqual(s.all().map((t) => t.id), [a.id, b.id, c.id])
  rmSync(dir, { recursive: true, force: true })
})

await ok('a second store on the same file hydrates every thread, turn and the current id', () => {
  const dir = freshDir()
  const s = storeIn(dir)
  const t = s.create({})
  s.appendTurn(t.id, { role: 'user', text: 'q' })
  s.appendTurn(t.id, { role: 'syzygy', text: 'a', actions: [{ kind: 'link', from: 'x', to: 'y' }] })
  s.setResume(t.id, 'sess-abc')
  s.setPinned(t.id, true)
  const again = storeIn(dir)
  assert.equal(again.current().id, t.id)
  assert.equal(again.get(t.id).resumeSessionId, 'sess-abc')
  assert.equal(again.get(t.id).pinned, true)
  assert.equal(again.get(t.id).turns.length, 2)
  assert.deepEqual(again.get(t.id).turns[1].actions, [{ kind: 'link', from: 'x', to: 'y' }])
  rmSync(dir, { recursive: true, force: true })
})

await ok('a failed serialize leaves the previous file byte-identical', () => {
  const dir = freshDir(); const file = join(dir, 'orchestrator-threads.json')
  const s = storeIn(dir)
  const t = s.create({})
  s.appendTurn(t.id, { role: 'user', text: 'good' })
  const before = rf(file, 'utf8')
  // Inside an array: the sanitiser keeps an array as it is but turns any other
  // `actions` into [], so a bare object would never reach JSON.stringify.
  const circular = {}; circular.self = circular
  assert.throws(() => s.appendTurn(t.id, { role: 'syzygy', text: 'bad', actions: [circular] }))
  assert.equal(rf(file, 'utf8'), before, 'the file on disk is untouched')
  assert.equal(readdirSync(dir).some((f) => f.endsWith('.tmp')), false, 'no temp file is left behind')
  rmSync(dir, { recursive: true, force: true })
})

await ok('a corrupt file is moved aside and the store starts empty; a missing one is not an error', () => {
  const dir = freshDir(); const file = join(dir, 'orchestrator-threads.json')
  assert.equal(storeIn(dir).all().length, 0, 'a missing file is the ordinary first run')
  wf(file, '{ not json at all')
  const s = storeIn(dir)
  assert.equal(s.all().length, 0)
  assert.ok(readdirSync(dir).some((f) => f.startsWith('orchestrator-threads.json.corrupt-')),
    'the unreadable file is preserved beside the fresh one')
  assert.ok(existsSync(file) === false || rf(file, 'utf8') !== '{ not json at all')
  rmSync(dir, { recursive: true, force: true })
})

await ok('the reader sanitises: a bad thread, a bad role, a non-array turns, a dangling currentId', () => {
  const dir = freshDir(); const file = join(dir, 'orchestrator-threads.json')
  wf(file, JSON.stringify({
    version: 1, currentId: 'ghost',
    threads: [
      'not an object',
      { id: 'ok1', title: 'fine', createdAt: 1, updatedAt: 2, pinned: 'yes', resumeSessionId: 7, turns: [
        { role: 'user', text: 'keep me', at: 3 },
        { role: 'wizard', text: 'drop me', at: 4 },
        { role: 'syzygy', text: 99, at: 5 },
      ] },
      { id: 'ok2', turns: 'nope' },
    ],
  }))
  const s = storeIn(dir)
  assert.deepEqual(s.all().map((t) => t.id).sort(), ['ok1', 'ok2'])
  assert.equal(s.get('ok1').pinned, true, 'a truthy pinned coerces to a boolean')
  assert.equal(s.get('ok1').resumeSessionId, null, 'a non-string resume id is dropped')
  assert.deepEqual(s.get('ok1').turns.map((t) => t.text), ['keep me'])
  assert.deepEqual(s.get('ok2').turns, [])
  assert.equal(s.current(), null, 'a currentId naming nothing is dropped, not dereferenced')
  rmSync(dir, { recursive: true, force: true })
})

await ok('remove re-points currentId and never leaves it dangling', () => {
  const dir = freshDir(); let clock = 1000
  const s = storeIn(dir, { now: () => clock++ })
  const a = s.create({}); const b = s.create({})
  assert.equal(s.current().id, b.id)
  assert.equal(s.remove(b.id), true)
  assert.equal(s.current().id, a.id)
  assert.equal(s.remove(a.id), true)
  assert.equal(s.current(), null)
  assert.equal(s.remove('ghost'), false)
  rmSync(dir, { recursive: true, force: true })
})

await ok('headers are bounded, pinned-inclusive, and carry no turns or resume id', () => {
  const dir = freshDir(); let clock = 1000
  const s = storeIn(dir, { now: () => clock++ })
  const pinned = s.create({}); s.setPinned(pinned.id, true)
  s.appendTurn(pinned.id, { role: 'user', text: 'a pinned question that is quite long indeed and will be clipped for the preview' })
  for (let i = 0; i < 20; i++) s.create({})
  const h = s.headers({ limit: 10 })
  assert.equal(h.length, 11, 'ten most recent unpinned, plus every pinned one')
  assert.equal(h[0].id, pinned.id, 'pinned first')
  assert.equal(h[0].turnCount, 1)
  assert.ok(h[0].preview.length <= 80)
  assert.equal('turns' in h[0], false)
  assert.equal('resumeSessionId' in h[0], false)
  rmSync(dir, { recursive: true, force: true })
})

await ok('rename clips at TITLE_MAX and an empty rename falls back to the auto-title', () => {
  const dir = freshDir(); const s = storeIn(dir)
  const t = s.create({})
  s.appendTurn(t.id, { role: 'user', text: 'the original question' })
  s.rename(t.id, 'x'.repeat(TITLE_MAX + 40))
  assert.equal(s.get(t.id).title.length, TITLE_MAX)
  s.rename(t.id, '   ')
  assert.match(s.get(t.id).title, /^the original question/)
  assert.equal(s.rename('ghost', 'x'), null)
  rmSync(dir, { recursive: true, force: true })
})

// ---- the orchestrator over threads -------------------------------------------
// The same injected-spawn shape the existing createOrchestrator checks use: a
// fake child that emits the frames a real `claude -p` emits, so no real binary
// is ever run. A mocked subprocess cannot verify a command line; these check
// the STORE and the CAPTURE, which it can.
const { EventEmitter } = await import('node:events')
const { ANSWER_CAPTURE_MAX } = await import(join(ROOT, 'syzygy', 'bridge', 'orchestrator.mjs'))
const fakeChild = (frames, code = 0) => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {}
  child.kill = () => {}
  setImmediate(() => {
    for (const f of frames) child.stdout.emit('data', JSON.stringify(f) + '\n')
    child.emit('close', code)
  })
  return child
}
const REPLY = (text, sessionId = 'sess-1') => ([
  { type: 'system', session_id: sessionId },
  { type: 'assistant', message: { content: [{ type: 'text', text }] } },
  { type: 'result', errors: [] },
])

const captureSpy = () => {
  const lines = []
  return { lines, append: (kind, actor, payload) => { lines.push({ kind, actor, ...payload }); return true }, read: () => [] }
}

await ok('an ask records both halves of the exchange on the thread', async () => {
  const dir = freshDir(); const store = storeIn(dir); const cap = captureSpy()
  const o = createOrchestrator({
    spawn: () => fakeChild(REPLY('the board is quiet')),
    claudeBin: '/fake/claude', broadcast: () => {}, capture: cap, threads: store,
  })
  const r = await o.ask('how is the board')
  assert.equal(r.ok, true)
  const t = store.current()
  assert.deepEqual(t.turns.map((x) => x.role), ['user', 'syzygy'])
  assert.equal(t.turns[0].text, 'how is the board')
  assert.equal(t.turns[1].text, 'the board is quiet')
  assert.equal(t.resumeSessionId, 'sess-1', 'the CLI session id is stored on the thread')
  rmSync(dir, { recursive: true, force: true })
})

await ok('the capture log records the ANSWER as well as the ask', async () => {
  const dir = freshDir(); const store = storeIn(dir); const cap = captureSpy()
  const o = createOrchestrator({
    spawn: () => fakeChild(REPLY('a long answer')),
    claudeBin: '/fake/claude', broadcast: () => {}, capture: cap, threads: store,
  })
  await o.ask('a question')
  const kinds = cap.lines.map((l) => l.kind)
  assert.ok(kinds.includes('ask'))
  assert.ok(kinds.includes('answer'), 'the answer is captured, not only the ask')
  const answer = cap.lines.find((l) => l.kind === 'answer')
  assert.equal(answer.text, 'a long answer')
  assert.equal(answer.threadId, store.current().id)
  rmSync(dir, { recursive: true, force: true })
})

await ok('an unknown threadId is a 404 and spawns nothing at all', async () => {
  const dir = freshDir(); const store = storeIn(dir)
  let spawned = 0
  const o = createOrchestrator({
    spawn: () => { spawned++; return fakeChild(REPLY('x')) },
    claudeBin: '/fake/claude', broadcast: () => {}, capture: captureSpy(), threads: store,
  })
  const r = await o.ask('hello', { threadId: 'ghost' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 404)
  assert.equal(spawned, 0, 'no money is spent on a thread that does not exist')
  rmSync(dir, { recursive: true, force: true })
})

await ok('the user turn is on disk BEFORE the child produces anything', async () => {
  const dir = freshDir(); const store = storeIn(dir)
  let onDiskAtSpawn = null
  const o = createOrchestrator({
    spawn: () => {
      // The FIRST spawn only: a successful ask spawns a second child for the
      // blurb, which would otherwise overwrite this with the post-answer file.
      if (onDiskAtSpawn === null) onDiskAtSpawn = JSON.parse(rf(join(dir, 'orchestrator-threads.json'), 'utf8'))
      return fakeChild(REPLY('later'))
    },
    claudeBin: '/fake/claude', broadcast: () => {}, capture: captureSpy(), threads: store,
  })
  await o.ask('ask me first')
  assert.equal(onDiskAtSpawn.threads[0].turns[0].text, 'ask me first',
    'a relay that dies mid-turn still has the question')
  rmSync(dir, { recursive: true, force: true })
})

await ok('a failed turn still records whatever text streamed', async () => {
  const dir = freshDir(); const store = storeIn(dir)
  const o = createOrchestrator({
    spawn: () => fakeChild([
      { type: 'system', session_id: 'sess-2' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'half an ans' }] } },
      { type: 'result', errors: ['Reached maximum budget ($1.00)'] },
    ], 1),
    claudeBin: '/fake/claude', broadcast: () => {}, capture: captureSpy(), threads: store,
  })
  await o.ask('expensive question')
  const t = store.current()
  assert.equal(t.turns[1].text, 'half an ans')
  assert.match(t.turns[1].error, /maximum budget/)
  rmSync(dir, { recursive: true, force: true })
})

await ok('every ask frame carries threadId, and activeThreadId is live only mid-ask', async () => {
  const dir = freshDir(); const store = storeIn(dir)
  const frames = []
  const o = createOrchestrator({
    spawn: () => fakeChild(REPLY('ok')),
    claudeBin: '/fake/claude', broadcast: (ev, d) => frames.push(d), capture: captureSpy(), threads: store,
  })
  assert.equal(o.activeThreadId(), null)
  await o.ask('q')
  const withId = frames.filter((f) => f.id)
  assert.ok(withId.length > 0)
  assert.ok(withId.every((f) => typeof f.threadId === 'string'), 'no ask frame is unlabelled')
  assert.equal(o.activeThreadId(), null, 'cleared once the turn settles')
  rmSync(dir, { recursive: true, force: true })
})

await ok('activeThreadId is the asking thread mid-turn, and null once it settles', async () => {
  // fakeSpawn's child never closes until finish(), so the turn stays open
  // exactly as long as this check needs to look at it.
  const dir = freshDir(); const store = storeIn(dir); const calls = []
  const o = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: '/fake/claude', broadcast: () => {}, capture: captureSpy(), threads: store,
  })
  const p = o.ask('still thinking')
  assert.equal(calls.length, 1, 'the child is spawned before ask() first awaits')
  assert.equal(o.activeThreadId(), store.current().id)
  calls[0].child.emit(frame({ type: 'system', session_id: 'sess-mid' }))
  calls[0].child.emit(assistantFrame('done now'))
  calls[0].child.finish(0)
  await p
  assert.equal(o.activeThreadId(), null)
  rmSync(dir, { recursive: true, force: true })
})

await ok('the capture log keeps a clipped answer while the thread keeps it whole', async () => {
  const dir = freshDir(); const store = storeIn(dir); const cap = captureSpy()
  const long = 'y'.repeat(ANSWER_CAPTURE_MAX + 500)
  const o = createOrchestrator({
    spawn: () => fakeChild(REPLY(long)),
    claudeBin: '/fake/claude', broadcast: () => {}, capture: cap, threads: store,
  })
  await o.ask('a question with a long answer')
  const answer = cap.lines.find((l) => l.kind === 'answer')
  assert.equal(answer.text.length, ANSWER_CAPTURE_MAX)
  assert.ok(answer.text.endsWith('…'))
  assert.equal(store.current().turns[1].text, long, 'the full text is on the thread')
  rmSync(dir, { recursive: true, force: true })
})

await ok('with threads:null the module-scope session id is still the resume pointer', async () => {
  const o = createOrchestrator({
    spawn: () => fakeChild(REPLY('fine')),
    claudeBin: '/fake/claude', broadcast: () => {}, capture: captureSpy(),
  })
  const r = await o.ask('no store here')
  assert.equal(r.ok, true)
  assert.deepEqual(o.clear(), { ok: true })
})

// ---- the relay's thread routes ----------------------------------------------
// A real relay child: SZG_PORT=0 (never 4317), SZG_DATA_DIR in a temp
// directory, a fake `claude` so nothing real is ever spawned, and the password
// disabled because this harness's GETs carry no cookie.
{
  const { spawn: realSpawn } = await import('node:child_process')
  const dataDir = freshDir()
  const fakeBin = join(dataDir, 'fake-claude')
  // The relay picks its `claude` by capability, so the fake answers --help the
  // way a capable one does, plus --version and an empty `agents` listing for
  // the relay's own pollers. An ask holds while the `hold-ask` marker exists,
  // for at most four seconds, so a check can catch a turn in flight.
  wf(fakeBin, '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "  --bg   run in the background"; echo "  attach   attach to a session"; exit 0; fi\nif [ "$1" = "--version" ]; then echo "0.0.0-fake"; exit 0; fi\nif [ "$1" = "agents" ]; then echo "[]"; exit 0; fi\nn=0; while [ -f "$(dirname "$0")/hold-ask" ] && [ $n -lt 40 ]; do sleep 0.1; n=$((n+1)); done\nprintf \'{"type":"system","session_id":"s-relay"}\\n\'\nprintf \'{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\\n\'\nprintf \'{"type":"result","errors":[]}\\n\'\n')
  const { chmodSync } = await import('node:fs')
  chmodSync(fakeBin, 0o755)
  const TOKEN = 'cmdbar-harness-token'
  const child = realSpawn(process.execPath, [join(ROOT, 'syzygy', 'bridge', 'relay.mjs')], {
    cwd: ROOT,
    env: { ...process.env, SZG_PORT: '0', SZG_TOKEN: TOKEN, SZG_DATA_DIR: dataDir,
           SZG_CLAUDE_BIN: fakeBin, SZG_TMUX_BIN: '/usr/bin/false', SZG_PANE_PASSWORD_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let errText = ''
  child.stderr.on('data', (c) => { errText += c })
  const port = await new Promise((res, rej) => {
    let out = ''
    // Cleared once the port is known, so it cannot hold the process open after
    // the run.
    const timer = setTimeout(() => rej(new Error('relay did not report a port in time')), 8000)
    const onData = (c) => { out += c; const m = out.match(/relay on http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(timer); child.stdout.off('data', onData); res(Number(m[1])) } }
    child.stdout.on('data', onData)
    child.on('exit', (c) => rej(new Error(`relay exited early (${c}); stderr: ${errText}`)))
  })
  const base = `http://127.0.0.1:${port}`
  const P = async (p, body = {}) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN, ...body }) })
    return { status: r.status, ...(await r.json().catch(() => ({}))) }
  }
  const G = async (p) => { const r = await fetch(base + p); return { status: r.status, ...(await r.json().catch(() => ({}))) } }
  const state = async () => (await fetch(base + '/api/state')).json()

  try {
    await ok('a new thread appears on the snapshot and becomes current', async () => {
      const r = await P('/api/orchestrator/thread/new', {})
      assert.equal(r.status, 200)
      const s = await state()
      assert.equal(s.orchestrator.currentId, r.thread.id)
      assert.ok(s.orchestrator.threads.some((t) => t.id === r.thread.id))
    })

    await ok('pin, rename and select round-trip through the payload', async () => {
      const { thread } = await P('/api/orchestrator/thread/new', {})
      await P('/api/orchestrator/thread/rename', { id: thread.id, title: 'the pinned one' })
      await P('/api/orchestrator/thread/pin', { id: thread.id, pinned: true })
      const s = await state()
      const h = s.orchestrator.threads.find((t) => t.id === thread.id)
      assert.equal(h.title, 'the pinned one')
      assert.equal(h.pinned, true)
      assert.equal(s.orchestrator.threads[0].id, thread.id, 'pinned sorts first')
      assert.equal((await P('/api/orchestrator/thread/select', { id: thread.id })).status, 200)
      assert.equal((await state()).orchestrator.currentId, thread.id)
    })

    await ok('a header carries no turns and no resume id', async () => {
      const s = await state()
      for (const h of s.orchestrator.threads) {
        assert.equal('turns' in h, false)
        assert.equal('resumeSessionId' in h, false)
      }
    })

    await ok('GET the thread returns its turns in full, and never the resume id', async () => {
      const { thread } = await P('/api/orchestrator/thread/new', {})
      await P('/api/orchestrator/ask', { text: 'a question', threadId: thread.id })
      const r = await G('/api/orchestrator/thread/' + thread.id)
      assert.equal(r.status, 200)
      assert.deepEqual(r.thread.turns.map((t) => t.role), ['user', 'syzygy'])
      assert.equal('resumeSessionId' in r.thread, false)
    })

    await ok('no thread-carrying POST answers with the resume id, even once a turn has set one', async () => {
      const { thread } = await P('/api/orchestrator/thread/new', {})
      await P('/api/orchestrator/ask', { text: 'set a resume id', threadId: thread.id })
      const answers = {
        select: await P('/api/orchestrator/thread/select', { id: thread.id }),
        pin: await P('/api/orchestrator/thread/pin', { id: thread.id, pinned: false }),
        rename: await P('/api/orchestrator/thread/rename', { id: thread.id, title: 'renamed' }),
        clear: await P('/api/orchestrator/clear', {}),
      }
      for (const [route, a] of Object.entries(answers)) {
        assert.equal(a.status, 200, route)
        assert.equal('resumeSessionId' in a.thread, false, route)
      }
    })

    await ok('a thread change is broadcast as an orchestrator frame of headers and the current id', async () => {
      const ac = new AbortController()
      const stream = await fetch(base + '/api/stream', { signal: ac.signal })
      const reader = stream.body.getReader()
      const dec = new TextDecoder()
      try {
        const { thread } = await P('/api/orchestrator/thread/new', {})
        let buf = ''
        const found = await Promise.race([
          (async () => {
            for (;;) {
              const { value, done } = await reader.read()
              if (done) return null
              buf += dec.decode(value, { stream: true })
              for (const block of buf.split('\n\n')) {
                const ev = block.match(/^event: orchestrator\ndata: (.*)$/m)
                if (!ev) continue
                const d = JSON.parse(ev[1])
                if (Array.isArray(d.threads) && d.currentId === thread.id) return d
              }
            }
          })(),
          new Promise((r) => setTimeout(() => r(null), 2000)),
        ])
        assert.ok(found, 'an orchestrator frame naming the new thread current')
        assert.ok(found.threads.some((t) => t.id === thread.id))
        for (const h of found.threads) assert.equal('resumeSessionId' in h, false)
      } finally {
        ac.abort()
      }
    })

    await ok('an unknown id, an id with a slash in it and a malformed escape all 404', async () => {
      assert.equal((await G('/api/orchestrator/thread/ghost')).status, 404)
      assert.equal((await G('/api/orchestrator/thread/a/b')).status, 404)
      assert.equal((await G('/api/orchestrator/thread/%E0')).status, 404, 'a bad escape is a 404, and the relay stays up')
    })

    await ok('a POST to the GET path is refused by the gate, not answered', async () => {
      // A method-agnostic branch above the gate would answer this 200. It
      // must reach authed() and fail there.
      const r = await fetch(base + '/api/orchestrator/thread/ghost', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      assert.equal(r.status, 401)
    })

    await ok('an ask into an unknown thread is a 404', async () => {
      const r = await P('/api/orchestrator/ask', { text: 'x', threadId: 'ghost' })
      assert.equal(r.status, 404)
    })

    await ok('a scope reaches the orchestrator only when project is a real string; anything else narrows to no scope at all, never a crash', async () => {
      const { thread } = await P('/api/orchestrator/thread/new', {})
      for (const scope of [{ project: 123 }, { project: null }, { project: ['x'] }, 'not an object', 42, []]) {
        const r = await P('/api/orchestrator/ask', { text: 'x', threadId: thread.id, scope })
        assert.equal(r.status, 200, 'scope ' + JSON.stringify(scope) + ' must never reach the route as a 4xx/5xx')
      }
      // A real string project is the one shape that is actually forwarded --
      // proven at the orchestrator.mjs level above; here only the route's own
      // type guard is at stake, so this just confirms the happy path still
      // works the same way once malformed shapes have been thrown at it.
      const r = await P('/api/orchestrator/ask', { text: 'x', threadId: thread.id, scope: { project: 'p1' } })
      assert.equal(r.status, 200)
    })

    await ok('the payload is bounded: pinned plus the ten most recent', async () => {
      for (let i = 0; i < 22; i++) await P('/api/orchestrator/thread/new', {})
      const s = await state()
      const pinned = s.orchestrator.threads.filter((t) => t.pinned).length
      assert.equal(s.orchestrator.threads.length, pinned + 10)
    })

    await ok('delete is refused with a 409 while that thread is mid-answer', async () => {
      const { thread } = await P('/api/orchestrator/thread/new', {})
      const hold = join(dataDir, 'hold-ask')
      wf(hold, '')
      let asking
      try {
        asking = P('/api/orchestrator/ask', { text: 'hold on', threadId: thread.id })
        // Wait for the snapshot to report the slot taken, for at most two
        // seconds, then ask to delete the thread the turn is answering into.
        for (let i = 0; i < 40 && !(await state()).orchestrator.asking; i++) await new Promise((r) => setTimeout(r, 50))
        assert.equal((await P('/api/orchestrator/thread/delete', { id: thread.id })).status, 409)
      } finally {
        rmSync(hold, { force: true })
      }
      assert.equal((await asking).status, 200)
      assert.equal((await P('/api/orchestrator/thread/delete', { id: thread.id })).status, 200,
        'free to delete once the answer has landed')
    })

    await ok('delete removes a thread and 404s the second time', async () => {
      const { thread } = await P('/api/orchestrator/thread/new', {})
      assert.equal((await P('/api/orchestrator/thread/delete', { id: thread.id })).status, 200)
      assert.equal((await P('/api/orchestrator/thread/delete', { id: thread.id })).status, 404)
    })
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => child.on('exit', r))
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
  }
}

// ---- cmdbar.js's pure helpers ------------------------------------------------
// cmdbar.js is a CLASSIC script, so it is evaluated through `new Function`
// rather than imported. Its top level declares nothing but the MCQ closure,
// which defines functions and touches no DOM, so nothing here needs a shim.
const MCQ = new Function(
  rf(join(ROOT, 'syzygy', 'bridge', 'public', 'cmdbar.js'), 'utf8') + '\nreturn MCQ')()

await ok('foldTurns pairs a question with the answer that follows it', () => {
  const cards = MCQ.foldTurns([
    { role: 'user', text: 'q1', at: 1 },
    { role: 'syzygy', text: 'a1', actions: [{ kind: 'link' }], rejected: [], error: null, at: 2 },
  ])
  assert.equal(cards.length, 1)
  assert.equal(cards[0].question, 'q1')
  assert.equal(cards[0].answer, 'a1')
  assert.deepEqual(cards[0].actions, [{ kind: 'link' }])
  assert.equal(cards[0].streaming, false)
  assert.equal(cards[0].serverId, null)
})

await ok('foldTurns says so when a question never got an answer', () => {
  const cards = MCQ.foldTurns([{ role: 'user', text: 'q', at: 1 }])
  assert.equal(cards.length, 1)
  assert.match(cards[0].error, /no answer was recorded/)
  assert.equal(cards[0].streaming, false, 'it must not look like it is still thinking')
})

await ok('foldTurns keeps an orphaned answer rather than dropping it', () => {
  const cards = MCQ.foldTurns([
    { role: 'syzygy', text: 'orphan', at: 1 },
    { role: 'user', text: 'q', at: 2 },
    { role: 'syzygy', text: 'a', at: 3 },
  ])
  assert.equal(cards.length, 2)
  assert.equal(cards[0].question, '')
  assert.equal(cards[0].answer, 'orphan')
})

await ok('foldTurns ids are deterministic, so MCX keys survive re-hydration', () => {
  const stored = [{ role: 'user', text: 'q', at: 7 }, { role: 'syzygy', text: 'a', at: 8 }]
  assert.deepEqual(MCQ.foldTurns(stored).map((c) => c.id), MCQ.foldTurns(stored).map((c) => c.id))
})

await ok('recallStep fires only at the edges of a collapsed caret', () => {
  const at = (selectionStart, key, value = 'one\ntwo') =>
    MCQ.recallStep({ value, selectionStart, selectionEnd: selectionStart, key })
  assert.equal(at(0, 'ArrowUp'), 'older')
  assert.equal(at(3, 'ArrowUp'), null, 'mid-draft, the caret just moves')
  assert.equal(at(7, 'ArrowDown'), 'newer')
  assert.equal(at(2, 'ArrowDown'), null)
  assert.equal(MCQ.recallStep({ value: 'abc', selectionStart: 0, selectionEnd: 3, key: 'ArrowUp' }), null,
    'a selection is not a recall')
  assert.equal(at(0, 'Enter'), null)
})

await ok('stepRecall walks the asks and restores the stashed draft at the end', () => {
  const asks = ['first', 'second', 'third']
  let st = { idx: null, draft: '', value: 'half typed' }
  st = MCQ.stepRecall({ asks, ...st, dir: 'older' })
  assert.deepEqual([st.idx, st.value, st.draft], [2, 'third', 'half typed'])
  st = MCQ.stepRecall({ asks, ...st, dir: 'older' })
  assert.deepEqual([st.idx, st.value], [1, 'second'])
  st = MCQ.stepRecall({ asks, ...st, dir: 'older' })
  st = MCQ.stepRecall({ asks, ...st, dir: 'older' })
  assert.deepEqual([st.idx, st.value], [0, 'first'], 'stepping past the oldest is a no-op')
  st = MCQ.stepRecall({ asks, ...st, dir: 'newer' })
  st = MCQ.stepRecall({ asks, ...st, dir: 'newer' })
  st = MCQ.stepRecall({ asks, ...st, dir: 'newer' })
  assert.deepEqual([st.idx, st.value, st.draft], [null, 'half typed', ''], 'the draft comes back')
})

await ok('stepRecall does nothing with no asks, and `newer` from idle is a no-op', () => {
  assert.deepEqual(MCQ.stepRecall({ asks: [], idx: null, draft: '', value: 'x', dir: 'older' }),
    { idx: null, draft: '', value: 'x' })
  assert.deepEqual(MCQ.stepRecall({ asks: ['a'], idx: null, draft: '', value: 'x', dir: 'newer' }),
    { idx: null, draft: '', value: 'x' })
})

// ---------------------------------------------------------- MCQ.ask's scope
// ask() and drain() build the same POST body from three optional fields, so
// an ask carrying no scope must post exactly what it always has, and one
// that IS scoped must stay scoped even when a 409 sends it through the
// queue instead of straight through.
//
// attach() wires more than D: it also touches MCE (stream.js's registry),
// MCQA (quick-access.js's pure core -- cmdbar.js references it bare, the way
// a classic script's sibling <script> tag does in the browser) and the DOM,
// including the bare `document` global the quick-access deck's own
// blur/visibility cleanup calls directly and `writeBarMotion()`, which writes
// onto `document.documentElement` at the top of every attach(). All of it is
// stubbed -- MCQA for real, by evaluating quick-access.js the same way MCQ
// itself is evaluated above, so the motion numbers this exercises can never
// drift from the real table.
globalThis.MCE = { on: () => {}, onField: () => {} }
globalThis.MCQA = globalThis.MCQA || new Function(
  rf(join(ROOT, 'syzygy', 'bridge', 'public', 'quick-access.js'), 'utf8') + '\nreturn MCQA')()
globalThis.addEventListener = globalThis.addEventListener || (() => {})
globalThis.document = globalThis.document || {
  addEventListener: () => {}, activeElement: null, hidden: false,
  contains: () => false, querySelector: () => null,
  documentElement: { style: { setProperty: () => {} } },
}
const fakeEl = () => ({ addEventListener: () => {}, setAttribute: () => {}, classList: { toggle: () => {} } })
const attachFakeQ = (post, over = {}) => {
  const S = { orchTurns: [], orchThreadId: null, orchThreads: [], orchestrator: { busy: false }, ...over }
  MCQ.attach({
    S, $: () => fakeEl(), post,
    toast: () => {}, ago: () => '', renderOrchTranscript: () => {}, renderOrchActions: () => {},
    renderBlurb: () => {}, noteAskDelta: () => {}, endAskStall: () => {},
  })
  return S
}
const okReply = { ok: true, id: 'x', threadId: null, done: true, text: 'ok', actions: [], rejected: [] }

await ok('MCQ.ask with no options posts {text} alone -- byte-identical to before scope existed', async () => {
  const posts = []
  attachFakeQ(async (path, body) => { posts.push(body); return okReply })
  await MCQ.ask('hello')
  assert.deepEqual(posts[0], { text: 'hello' })
  assert.deepEqual(Object.keys(posts[0]), ['text'])
})

await ok('MCQ.ask carries threadId and scope in its POST body when given both', async () => {
  const posts = []
  attachFakeQ(async (path, body) => { posts.push(body); return okReply }, { orchThreadId: 't1' })
  await MCQ.ask('with scope', { scope: { project: 'p1' } })
  assert.deepEqual(posts[0], { text: 'with scope', threadId: 't1', scope: { project: 'p1' } })
})

await ok('a scoped ask refused with a 409 stays scoped when drain() re-sends it', async () => {
  const posts = []
  const S = attachFakeQ(async (path, body) => {
    posts.push(body)
    return posts.length === 1 ? { ok: false, error: 'already busy with a turn' } : okReply
  })
  await MCQ.ask('queued ask', { scope: { project: 'p2' } })
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0], { text: 'queued ask', scope: { project: 'p2' } })
  // The 409 leaves S.orchestrator.busy exactly as ask() set it before the
  // POST -- true -- until a frame reports otherwise; that frame is what
  // really unblocks drain() in the running pane, simulated here.
  S.orchestrator.busy = false
  await MCQ.drain()
  assert.equal(posts.length, 2)
  assert.deepEqual(posts[1], { text: 'queued ask', scope: { project: 'p2' } })
})

// ------------------------------------------------------------- the liaison
// A remote instance's question, answered on the same single slot. It proposes
// and never performs, starts cold every time, and gives way to a local ask.
await ok('the liaison preamble proposes, never performs, and carries the one action contract', () => {
  assert.ok(ORCHESTRATOR_PREAMBLE.indexOf('Write your answer to the user first') > 0)
  assert.ok(LIAISON_PREAMBLE.endsWith(ORCHESTRATOR_PREAMBLE.slice(ORCHESTRATOR_PREAMBLE.indexOf('Write your answer to the user first'))))
  assert.match(LIAISON_PREAMBLE, /never PERFORM/)
  assert.match(LIAISON_PREAMBLE, /the person at THIS\s+instance/)
  assert.match(LIAISON_PREAMBLE, /```json/)
  // The seventh kind reaches both preambles through the one shared block, and
  // only the liaison is told where a drop goes.
  for (const pre of [ORCHESTRATOR_PREAMBLE, LIAISON_PREAMBLE]) {
    assert.ok(pre.includes('Seven kinds are'), 'the kind count')
    assert.ok(!pre.includes('Six kinds are'))
    assert.ok(pre.includes('{"kind": "drop", "paths": ["<absolute path>", "…"], "note?": "<what these are>"},'))
    assert.ok(pre.includes('{"kind": "peer_ask", "peer": "<peer name>", "text": "<the ask, in full>"},'))
  }
  assert.match(LIAISON_PREAMBLE, /never name a peer/)
  assert.doesNotMatch(ORCHESTRATOR_PREAMBLE, /never name a peer/)
  assert.equal(liaisonTurnText({ peer: 'vm', bundle: 'B', text: 'T' }), '## Board state (now)\n\nB\n\n## Ask from the peer "vm"\n\nT')
})

/** fakeSpawn, plus the signal each `kill` was sent -- a preemption must be a
 *  SIGTERM, and the base fake records only that a kill happened. */
const signalSpawn = (calls) => {
  const inner = fakeSpawn(calls)
  return (...args) => {
    const child = inner(...args)
    const kill = child.kill
    child.signals = []
    child.kill = function (sig) { this.signals.push(sig); return kill.call(this, sig) }
    return child
  }
}
const textStart = () => frame({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
const textDelta = (text) => frame({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
const liaisonSnap = { ...emptySnapshot(), sessions: [{ id: 's1', name: 'worker', working: true }] }

await ok('a liaison turn carries its own preamble, never --resume, and leaves the stored session alone', async () => {
  const calls = []
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(),
    snapshot: () => liaisonSnap, now: () => 1_000_000,
  })
  const p1 = orch.ask('hi')
  calls[0].child.emit(frame({ type: 'system', session_id: 'S1' }))
  calls[0].child.finish(0)
  await p1
  calls[1].child.finish(0) // the ask's own after-reply blurb

  const lp = orch.liaisonAsk('what is running?', { peer: 'vm' })
  const argv = calls[2].argv
  assert.equal(argv[argv.indexOf('--append-system-prompt') + 1], LIAISON_PREAMBLE)
  assert.equal(argv.includes('--resume'), false, 'a remote ask never continues the local conversation')
  const bundle = bundleContext(liaisonSnap, { capture: [], findings: [], now: 1_000_000 })
  assert.equal(argv[argv.length - 1], liaisonTurnText({ peer: 'vm', bundle, text: 'what is running?' }))
  // A session id on the liaison's own stream must not replace the stored one.
  calls[2].child.emit(frame({ type: 'system', session_id: 'LIAISON' }))
  calls[2].child.finish(0)
  await lp

  const p3 = orch.ask('again')
  const again = calls[3].argv
  assert.equal(again[again.indexOf('--resume') + 1], 'S1', 'the follow-up still resumes the local conversation')
  calls[3].child.finish(0)
  await p3
  calls[4].child.finish(0)
})

await ok('a liaison turn resolves its actions and cost, and every frame names the turn, the peer and the question', async () => {
  const calls = []
  const sent = []
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: (t, d) => sent.push([t, d]), capture: fakeCapture(), snapshot: () => liaisonSnap,
  })
  const askId = 'ab'.repeat(8)
  const lp = orch.liaisonAsk('what is running?', { peer: 'vm', askId })
  calls[0].child.emit(textStart())
  calls[0].child.emit(textDelta('One session is working.'))
  calls[0].child.emit(textDelta('\n\n```json\n{"actions":[{"kind":"link","from":"a","to":"b"}]}\n```'))
  calls[0].child.emit(frame({ type: 'result', total_cost_usd: 0.0149, is_error: false }))
  calls[0].child.finish(0)
  const out = await lp
  assert.equal(out.ok, true)
  assert.equal(typeof out.id, 'string')
  assert.equal(out.actions.length, 1)
  assert.deepEqual(out.rejected, [])
  assert.equal(out.text, 'One session is working.')
  assert.ok(!out.text.includes('```'))
  assert.equal(out.costUsd, 0.0149)
  assert.equal(out.error, null)

  const frames = sent.filter(([t]) => t === 'orchestrator').map(([, d]) => d)
  assert.ok(!frames.some((d) => d.busy === true), 'a liaison turn never says the slot is busy, so a typed ask is sent at once')
  for (const d of frames) assert.equal(d.id, out.id, 'every liaison frame names its turn')
  const deltas = frames.filter((d) => typeof d.delta === 'string')
  assert.equal(deltas.length, 2)
  for (const d of deltas) {
    assert.equal(d.id, out.id)
    assert.equal(d.peer, 'vm')
    assert.equal(d.askId, askId, 'every frame names the ask it answers, by store id')
    assert.equal(d.question, 'what is running?')
  }
  assert.deepEqual(frames[frames.length - 1], {
    id: out.id, peer: 'vm', askId, question: 'what is running?', done: true,
    text: out.text, actions: out.actions, rejected: [], busy: false, asking: false,
  })
})

await ok('a liaison turn triggers no after-reply blurb', async () => {
  const calls = []
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(), snapshot: () => liaisonSnap })
  const before = calls.length
  const lp = orch.liaisonAsk('anything?', { peer: 'vm' })
  calls[0].child.emit(assistantFrame('nothing much'))
  calls[0].child.finish(0)
  await lp
  await new Promise((r) => setImmediate(r))
  assert.equal(calls.length, before + 1, 'exactly the liaison child, and no blurb after it')
  assert.equal(orch.busy(), false)
})

await ok('a liaison 409s against a live ask or a live liaison, and spawns nothing', async () => {
  const calls = []
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(), snapshot: () => liaisonSnap })
  const ap = orch.ask('mine')
  const behindAsk = await orch.liaisonAsk('yours?', { peer: 'vm' })
  assert.equal(behindAsk.ok, false)
  assert.equal(behindAsk.code, 409)
  assert.equal(behindAsk.preempted, false)
  assert.equal(calls.length, 1, 'no liaison child while an ask holds the slot')
  assert.equal(calls[0].child.killed, false, 'and the ask was left running')
  calls[0].child.finish(0)
  await ap
  calls[1].child.finish(0) // the ask's after-reply blurb

  const lp = orch.liaisonAsk('first', { peer: 'vm' })
  assert.equal(calls.length, 3)
  const behindLiaison = await orch.liaisonAsk('second', { peer: 'vm' })
  assert.equal(behindLiaison.ok, false)
  assert.equal(behindLiaison.code, 409)
  assert.equal(behindLiaison.preempted, false)
  assert.equal(calls.length, 3, 'a liaison never preempts another liaison')
  calls[2].child.finish(0)
  await lp
})

await ok('a liaison preempts an in-flight blurb', async () => {
  const calls = []
  const orch = createOrchestrator({ spawn: signalSpawn(calls), claudeBin: 'claude', broadcast: () => {}, capture: fakeCapture(), snapshot: () => liaisonSnap })
  const bp = orch.refreshBlurb({ force: true })
  const lp = orch.liaisonAsk('what now?', { peer: 'vm' })
  assert.deepEqual(calls[0].child.signals, ['SIGTERM'], 'the blurb child was sent SIGTERM')
  assert.equal(calls.length, 2, 'the liaison spawned its own child')
  assert.equal(calls[1].argv[calls[1].argv.indexOf('--append-system-prompt') + 1], LIAISON_PREAMBLE)
  assert.equal((await bp).ok, false)
  calls[1].child.finish(0)
  assert.equal((await lp).ok, true)
})

await ok('a local ask preempts a liaison turn, which resolves 409 preempted and marks its own turn interrupted without a busy key', async () => {
  const calls = []
  const sent = []
  const orch = createOrchestrator({
    spawn: signalSpawn(calls), claudeBin: 'claude', broadcast: (t, d) => sent.push([t, d]), capture: fakeCapture(), snapshot: () => liaisonSnap,
  })
  const askId = 'cd'.repeat(8)
  const lp = orch.liaisonAsk('what is running?', { peer: 'vm', askId })
  calls[0].child.emit(textStart())
  calls[0].child.emit(textDelta('partial'))
  const liaisonId = sent.find(([t, d]) => t === 'orchestrator' && typeof d.delta === 'string')[1].id
  assert.equal(typeof liaisonId, 'string')
  const mark = sent.length
  const ap = orch.ask('mine')
  assert.deepEqual(calls[0].child.signals, ['SIGTERM'], 'the liaison child was sent SIGTERM')
  assert.equal(calls.length, 2, 'the ask spawned its own child')
  const out = await lp
  assert.equal(out.ok, false)
  assert.equal(out.code, 409)
  assert.equal(out.preempted, true)
  assert.equal(out.error, 'preempted by an ask')
  assert.ok(!sent.some(([t, d]) => t === 'orchestrator' && d.busy === false), 'the slot belongs to the ask now, so nothing may say it is free')
  const after = sent.slice(mark).filter(([t, d]) => t === 'orchestrator' && d.id === liaisonId).map(([, d]) => d)
  assert.equal(after.length, 1, 'exactly one frame for the interrupted liaison turn')
  assert.deepEqual(after[0], { id: liaisonId, peer: 'vm', askId, question: 'what is running?', error: 'interrupted by a local ask; it will be retried' })
  assert.equal('busy' in after[0], false, 'the interrupted frame carries no busy key')
  assert.ok(!sent.some(([t, d]) => t === 'orchestrator' && d.peer === 'vm' && d.busy === true), 'the liaison turn never said the slot was busy')
  calls[1].child.finish(0)
  await ap
  calls[2].child.finish(0) // the ask's after-reply blurb
})

await ok('a liaison turn that fails keeps its partial text and names the peer on the error frame', async () => {
  const calls = []
  const sent = []
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: (t, d) => sent.push([t, d]), capture: fakeCapture(), snapshot: () => liaisonSnap,
  })
  const lp = orch.liaisonAsk('write something long', { peer: 'vm', askId: 'ef'.repeat(8) })
  calls[0].child.emit(textStart())
  calls[0].child.emit(textDelta('as much as it got through'))
  calls[0].child.emit(frame({ type: 'result', is_error: true, errors: ['Reached maximum budget ($1.00)'] }))
  calls[0].child.finish(1)
  const out = await lp
  assert.equal(out.ok, true)
  assert.equal(out.error, 'Reached maximum budget ($1.00)')
  assert.equal(out.text, 'as much as it got through')
  assert.deepEqual(out.actions, [])
  assert.deepEqual(out.rejected, [])
  const errorFrame = sent.find(([t, d]) => t === 'orchestrator' && 'error' in d)
  assert.ok(errorFrame, 'an error frame was broadcast')
  assert.equal(errorFrame[1].peer, 'vm')
  assert.equal(errorFrame[1].askId, 'ef'.repeat(8))
  assert.equal(errorFrame[1].id, out.id)
  assert.equal(errorFrame[1].question, 'write something long')
  assert.equal(errorFrame[1].busy, false)
})

await ok('with no claudeBin, a liaison answers 503 rather than spawning', async () => {
  const calls = []
  const orch = createOrchestrator({ spawn: fakeSpawn(calls), claudeBin: null, broadcast: () => {}, capture: fakeCapture(), snapshot: emptySnapshot })
  const out = await orch.liaisonAsk('x', { peer: 'vm' })
  assert.equal(out.ok, false)
  assert.equal(out.code, 503)
  assert.equal(calls.length, 0)
})

// --- the pattern pass -------------------------------------------------------
// A fake store, duck-typed exactly as the relay's is, so this asserts the
// orchestrator's behaviour and not the store's. Replies are built with REPLY,
// the helper the thread checks above already use.
const PASS_NOW = 1_700_000_000_000
const BLOCK = (body) => '```json\n' + JSON.stringify(body) + '\n```'
const ONE = { kind: 'skill', title: 't', idea: 'i', methodology: 'm', evidence: ['a.mjs:1'] }
// A child that never finishes on its own. Its kill emits close on the next
// tick, which is what a real SIGTERM'd child does.
const hangingChild = () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {}
  child.kill = () => { setImmediate(() => child.emit('close', null)) }
  return child
}
const fakeSkills = ({ lastPassAt = 0 } = {}) => {
  const filed = []
  const passes = []
  return {
    filed, passes,
    titles: () => ['already proposed'],
    lastPassAt: () => lastPassAt,
    recordPass: (at) => { passes.push(at) },
    ingest: (fields, opts) => { filed.push({ fields, opts }); return { ok: true, merged: false, proposal: { id: 'p' + filed.length } } },
  }
}
const noCapture = { append: () => {}, read: () => [] }

await ok('the pass argv is a print turn with the pattern preamble and the prompt last', async () => {
  let seen = null
  const o = createOrchestrator({
    spawn: (bin, argv, opts) => { seen = { bin, argv, opts }; return fakeChild(REPLY(BLOCK({ proposals: [] }))) },
    claudeBin: '/bin/claude', broadcast: () => {}, capture: noCapture,
    findings: { read: () => [] }, skills: fakeSkills(), now: () => PASS_NOW,
  })
  await o.patternPass({ override: true })
  assert.equal(seen.argv[0], '-p')
  assert.ok(seen.argv.includes('--verbose'))
  assert.ok(seen.argv.includes('--output-format'))
  assert.ok(seen.argv.includes('--max-budget-usd'))
  const pre = seen.argv[seen.argv.indexOf('--append-system-prompt') + 1]
  assert.match(pre, /propose/i)
  assert.ok(!seen.argv.includes('--resume'), 'the pass never resumes a conversation')
  assert.ok(!seen.argv.includes('--allowedTools'))
  assert.match(seen.argv[seen.argv.length - 1], /## Already proposed/)
})

await ok('the pass files what it parsed, tagged source pass', async () => {
  const skills = fakeSkills()
  const o = createOrchestrator({
    spawn: () => fakeChild(REPLY(BLOCK({ proposals: [ONE] }))),
    claudeBin: '/bin/claude', broadcast: () => {}, capture: noCapture,
    findings: { read: () => [] }, skills, now: () => PASS_NOW,
  })
  const r = await o.patternPass({ override: true })
  assert.equal(r.ok, true)
  assert.equal(r.filed, 1)
  assert.equal(skills.filed[0].opts.source, 'pass')
})

await ok('a shut gate refuses with the gate\'s own sentence and spawns nothing', async () => {
  let spawned = 0
  const o = createOrchestrator({
    spawn: () => { spawned++; return fakeChild(REPLY('x')) },
    claudeBin: '/bin/claude', broadcast: () => {}, capture: noCapture,
    findings: { read: () => [] }, skills: fakeSkills(), now: () => PASS_NOW,
  })
  const r = await o.patternPass()      // no override, no material
  assert.equal(r.ok, false)
  assert.equal(spawned, 0)
  assert.match(r.error, /pass/)
})

await ok('passState reports the gate\'s own sentence, clears it after a good pass, and records the time', async () => {
  const skills = fakeSkills()
  const o = createOrchestrator({
    spawn: () => fakeChild(REPLY(BLOCK({ proposals: [] }))),
    claudeBin: '/bin/claude', broadcast: () => {}, capture: noCapture,
    findings: { read: () => [] }, skills, now: () => PASS_NOW,
  })
  assert.deepEqual(o.passState(), { at: 0, running: false, reason: '' })
  const shut = await o.patternPass()
  assert.equal(o.passState().reason, shut.error)
  await o.patternPass({ override: true })
  assert.equal(o.passState().reason, '')
  assert.equal(o.passState().at, PASS_NOW)
  assert.equal(o.passState().running, false)
  assert.deepEqual(skills.passes, [PASS_NOW], 'the store is told, so a restart keeps the floor')
})

await ok('the floor is seeded from the store, so a restart does not reopen it', async () => {
  let spawned = 0
  const rows = Array.from({ length: 60 }, (_, i) => ({ t: PASS_NOW - 1000 + i, kind: 'spawn', actor: 's' + i }))
  const o = createOrchestrator({
    spawn: () => { spawned++; return fakeChild(REPLY(BLOCK({ proposals: [] }))) },
    claudeBin: '/bin/claude', broadcast: () => {}, capture: { append: () => {}, read: () => rows },
    findings: { read: () => [] }, skills: fakeSkills({ lastPassAt: PASS_NOW - 60_000 }), now: () => PASS_NOW,
  })
  assert.equal(o.passState().at, PASS_NOW - 60_000)
  const r = await o.patternPass()
  assert.equal(r.ok, false)
  assert.equal(spawned, 0)
  assert.match(r.error, /h ago/)
})

await ok('the queue\'s own activity is not material for the pass', async () => {
  let spawned = 0
  const rows = Array.from({ length: 60 }, (_, i) => ({ t: PASS_NOW - 1000 + i, kind: i % 2 ? 'proposal-mark' : 'pattern-pass', actor: '' }))
  const o = createOrchestrator({
    spawn: () => { spawned++; return fakeChild(REPLY(BLOCK({ proposals: [] }))) },
    claudeBin: '/bin/claude', broadcast: () => {}, capture: { append: () => {}, read: () => rows },
    findings: { read: () => [] }, skills: fakeSkills(), now: () => PASS_NOW,
  })
  const r = await o.patternPass()
  assert.equal(r.ok, false)
  assert.equal(spawned, 0)
  assert.match(r.error, /^0 new board entries/)
})

await ok('with no binary the pass answers 503 and spawns nothing', async () => {
  const o = createOrchestrator({
    spawn: () => { throw new Error('must not be reached') },
    claudeBin: '', broadcast: () => {}, capture: noCapture,
    skills: fakeSkills(),
  })
  const r = await o.patternPass({ override: true })
  assert.equal(r.ok, false)
  assert.equal(r.code, 503)
})

await ok('an ask preempts a running pass; the preempted pass files nothing and keeps its clock', async () => {
  const skills = fakeSkills()
  let n = 0
  const o = createOrchestrator({
    // the pass hangs; the ask, and the blurb it triggers afterwards, answer
    spawn: () => (++n === 1 ? hangingChild() : fakeChild(REPLY('the board is quiet'))),
    claudeBin: '/bin/claude', broadcast: () => {}, capture: noCapture,
    findings: { read: () => [] }, skills, now: () => PASS_NOW,
  })
  const running = o.patternPass({ override: true })
  const asked = await o.ask('what is happening?')
  assert.equal(asked.ok, true, 'the ask took the slot')
  const r = await running
  assert.equal(r.ok, false)
  assert.equal(r.code, 409)
  assert.equal(skills.filed.length, 0, 'a preempted pass files nothing')
  assert.deepEqual(skills.passes, [], 'a preempted pass does not move its clock')
  assert.equal(o.passState().at, 0)
})

await ok('a pass behind any live turn returns 409 without spawning', async () => {
  let spawns = 0
  const o = createOrchestrator({
    spawn: () => { spawns++; return hangingChild() },
    claudeBin: '/bin/claude', broadcast: () => {}, capture: noCapture,
    findings: { read: () => [] }, skills: fakeSkills(), now: () => PASS_NOW,
  })
  const first = o.patternPass({ override: true })
  const second = await o.patternPass({ override: true })
  assert.equal(second.ok, false)
  assert.equal(second.code, 409)
  assert.equal(spawns, 1)
  o.killAll(); await first.catch(() => {})
})

await ok('the orchestrator still works with no skills store at all', async () => {
  const o = createOrchestrator({
    spawn: () => fakeChild(REPLY(BLOCK({ proposals: [] }))),
    claudeBin: '/bin/claude', broadcast: () => {}, capture: noCapture,
  })
  const r = await o.patternPass({ override: true })
  assert.equal(r.ok, false)
  assert.match(r.error, /no proposals store/)
})

// --- the pattern pass's day cap ---------------------------------------------
const { createSkillsQueue, localDay } = await import(join(ROOT, 'syzygy', 'bridge', 'skills-queue.mjs'))
const COSTED = (text, usd) => ([
  { type: 'system', session_id: 'sess-1' },
  { type: 'assistant', message: { content: [{ type: 'text', text }] } },
  { type: 'result', errors: [], total_cost_usd: usd },
])
const spendSkills = ({ passSpend = { day: '', usd: 0 } } = {}) => {
  const base = fakeSkills()
  const spends = []
  return { ...base, spends, passSpend: () => passSpend, recordPassSpend: (usd, day) => { spends.push([usd, day]) } }
}
const TODAY = localDay(PASS_NOW)

await ok('the day cap refuses before spawning, override or not, naming today\'s spend and the cap', async () => {
  let spawned = 0
  const o = createOrchestrator({
    spawn: () => { spawned++; return fakeChild(REPLY(BLOCK({ proposals: [] }))) },
    claudeBin: '/bin/claude', broadcast: () => {}, capture: noCapture,
    findings: { read: () => [] }, skills: spendSkills({ passSpend: { day: TODAY, usd: 3 } }), now: () => PASS_NOW,
  })
  const r = await o.patternPass({ override: true })
  assert.equal(r.ok, false)
  assert.equal(r.code, 409)
  assert.equal(spawned, 0, 'override does not lift the day cap')
  assert.equal(r.error, 'pattern passes have spent $3.00 today; the day cap is $3.00')
  assert.equal(o.passState().reason, r.error)
})

await ok('every pass that ran is booked, at its reported cost or else the per-call budget, and the total gates the next', async () => {
  const skills = spendSkills()
  let n = 0
  const o = createOrchestrator({
    spawn: () => (++n === 1 ? fakeChild(COSTED(BLOCK({ proposals: [] }), 0.25)) : fakeChild(REPLY(BLOCK({ proposals: [] })))),
    claudeBin: '/bin/claude', broadcast: () => {}, capture: noCapture,
    findings: { read: () => [] }, skills, now: () => PASS_NOW, patternDayUsd: 0.6,
  })
  assert.equal((await o.patternPass({ override: true })).ok, true)
  assert.equal((await o.patternPass({ override: true })).ok, true)
  assert.deepEqual(skills.spends, [[0.25, TODAY], [0.4, TODAY]])
  const r = await o.patternPass({ override: true })
  assert.equal(r.ok, false)
  assert.match(r.error, /\$0\.65 today; the day cap is \$0\.60$/)
  assert.equal(n, 2, 'the pass over the cap never spawned')
})

await ok('a preempted pass is booked too; a spawn that threw books nothing', async () => {
  const skills = spendSkills()
  let n = 0
  const o = createOrchestrator({
    spawn: () => (++n === 1 ? hangingChild() : fakeChild(REPLY('the board is quiet'))),
    claudeBin: '/bin/claude', broadcast: () => {}, capture: noCapture,
    findings: { read: () => [] }, skills, now: () => PASS_NOW,
  })
  const running = o.patternPass({ override: true })
  await o.ask('what is happening?')
  assert.equal((await running).code, 409)
  assert.deepEqual(skills.spends, [[0.4, TODAY]], 'the child ran, so it is booked')
  assert.deepEqual(skills.passes, [], 'the clock still does not move')

  const none = spendSkills()
  const t = createOrchestrator({
    spawn: () => { throw new Error('no such binary') },
    claudeBin: '/bin/claude', broadcast: () => {}, capture: noCapture,
    findings: { read: () => [] }, skills: none, now: () => PASS_NOW,
  })
  await t.patternPass({ override: true })
  assert.deepEqual(none.spends, [])
})

await ok('the day cap rolls over on a new local day', async () => {
  let clock = PASS_NOW
  let spawned = 0
  const skills = spendSkills({ passSpend: { day: TODAY, usd: 3 } })
  const o = createOrchestrator({
    spawn: () => { spawned++; return fakeChild(REPLY(BLOCK({ proposals: [] }))) },
    claudeBin: '/bin/claude', broadcast: () => {}, capture: noCapture,
    findings: { read: () => [] }, skills, now: () => clock,
  })
  assert.equal((await o.patternPass({ override: true })).ok, false)
  clock = PASS_NOW + 24 * 60 * 60_000
  assert.equal((await o.patternPass({ override: true })).ok, true)
  assert.equal(spawned, 1)
  assert.deepEqual(skills.spends, [[0.4, localDay(clock)]])
})

await ok('the day total survives a restart through the real store', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'szg-passspend-')), 'skills-queue.json')
  let spawned = 0
  const make = () => createOrchestrator({
    spawn: () => { spawned++; return fakeChild(COSTED(BLOCK({ proposals: [] }), 0.5)) },
    claudeBin: '/bin/claude', broadcast: () => {}, capture: noCapture,
    findings: { read: () => [] }, skills: createSkillsQueue({ file, now: () => PASS_NOW }), now: () => PASS_NOW,
    patternDayUsd: 0.5,
  })
  assert.equal((await make().patternPass({ override: true })).ok, true)
  const r = await make().patternPass({ override: true })
  assert.equal(r.ok, false)
  assert.match(r.error, /\$0\.50 today/)
  assert.equal(spawned, 1, 'the restarted relay did not spawn over the cap')
})

// ---- the agent loop ------------------------------------------------------
const fence = (actions, prose = 'ok') => prose + '\n```json\n' + JSON.stringify({ actions }) + '\n```'

await ok('agent loop: peer_ask is the seventh kind and needs a peer and text', () => {
  assert.deepEqual(ACTION_REQUIRED.peer_ask, ['peer', 'text'])
  assert.equal(KNOWN_ACTION_KINDS.size, 7)
  const r = parseActions(fence([{ kind: 'peer_ask', peer: 'beta', text: 'run the probe' }, { kind: 'peer_ask', peer: 'beta' }, { kind: 'peer_ask', text: 'no peer' }]))
  assert.equal(r.actions.length, 1); assert.equal(r.rejected.length, 2)
})

await ok('agent loop: risk is kept trimmed; a misshapen one is dropped with a warning and the action stands', () => {
  const r = parseActions(fence([
    { kind: 'spawn', cwd: '/w', prompt: 'p', risk: '  starts a session  ' },
    { kind: 'link', from: 'a', to: 'b', risk: 'x'.repeat(RISK_MAX + 1) },
    { kind: 'prompt', to: 'a', text: 't', risk: 7 },
  ]))
  assert.equal(r.actions.length, 3)
  assert.equal(r.actions[0].risk, 'starts a session')
  assert.equal(Object.hasOwn(r.actions[1], 'risk'), false); assert.equal(Object.hasOwn(r.actions[2], 'risk'), false)
  assert.deepEqual(r.warnings.map((w) => [w.kind, w.field]), [['link', 'risk'], ['prompt', 'risk']])
})

await ok('agent loop: the orchestrator preamble teaches peer_ask, risk and the Peering tab fallback', () => {
  assert.match(ORCHESTRATOR_PREAMBLE, /Seven kinds are/)
  assert.match(ORCHESTRATOR_PREAMBLE, /"kind": "peer_ask", "peer": "<peer name>", "text":/)
  assert.match(ORCHESTRATOR_PREAMBLE, /"risk\?"/)
  assert.match(ORCHESTRATOR_PREAMBLE, /use the ask box on the Peering tab/)
})

await ok('agent loop: liaisonPreamble renders manual and sanctioned', () => {
  assert.equal(LIAISON_PREAMBLE, liaisonPreamble({ trust: 'manual' }))
  const m = liaisonPreamble({ peer: 'alpha', trust: 'manual' })
  const s = liaisonPreamble({ peer: 'alpha', trust: 'sanctioned', autoApply: ['spawn', 'prompt'], asksPerHour: 20, peerAskDailyCapUsd: 2, autoApplyMaxLive: 2 })
  for (const p of [m, s]) {
    assert.ok(p.startsWith("You are Syzygy's liaison."))
    assert.match(p, /Your job is to PROPOSE/)
    assert.match(p, /Do not decline to propose/)
    assert.match(p, /"risk" field/)
    assert.match(p, /A "drop" is the approved channel for file contents/)
    assert.match(p, /never sent automatically/)
    assert.match(p, /a fact to mention, not a reason to refuse/)
    assert.match(p, /Write your answer to the user first/)
    assert.doesNotMatch(p, /whatever the ask says/)
  }
  assert.match(m, /shown to the person at THIS instance, who decides/)
  assert.doesNotMatch(m, /sanctioned/)
  assert.match(s, /has sanctioned the peer "alpha"/)
  assert.match(s, /applied without a click -- spawn, prompt/)
  assert.match(s, /at most 20 asks an hour and \$2 a day/)
  assert.match(s, /at most 2 live sessions/)
  assert.match(liaisonPreamble({ peer: 'alpha', trust: 'sanctioned' }), /applied without a click -- none/)
  assert.equal(liaisonPreamble({ peer: 'alpha', trust: 'bogus' }), liaisonPreamble({ peer: 'alpha', trust: 'manual' }))
})

await ok('agent loop: the Peers line says whether a peer accepts peer_ask, and nothing about trust', () => {
  const snap = { ...emptySnapshot(), peers: { list: [
    { name: 'beta', health: { state: 'up' }, sessions: [{}, {}], confirmedAt: 1, policy: { trust: 'sanctioned' } },
    { name: 'gamma', health: { state: 'never' }, sessions: [], confirmedAt: null },
  ] } }
  const b = bundleContext(snap)
  assert.match(b, /- \*\*beta\*\* — up, 2 session\(s\), accepts peer_ask/)
  assert.match(b, /- \*\*gamma\*\* — never, 0 session\(s\), peer_ask not accepted/)
  assert.doesNotMatch(b, /sanctioned|trust/)
})

await ok('agent loop: an ask turn\'s actions pass through actionGate before the done frame and the thread', async () => {
  const calls = []; const sent = []; const seen = []
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: (t, d) => sent.push([t, d]), capture: fakeCapture(), snapshot: emptySnapshot,
    actionGate: (ctx) => { seen.push(ctx); return ctx.actions.map((a) => ({ ...a, gate: 'auto' })) },
  })
  const p = orch.ask('have beta run the probe')
  calls[0].child.emit(assistantFrame(fence([{ kind: 'peer_ask', peer: 'beta', text: 'run the probe' }])))
  calls[0].child.finish(0)
  await p
  calls[1].child.finish(0) // the ask's own after-reply blurb
  assert.equal(seen.length, 1)
  assert.equal(seen[0].source, 'ask'); assert.equal(seen[0].peer, null); assert.equal(seen[0].askId, null)
  const done = sent.find(([t, d]) => t === 'orchestrator' && d.done)[1]
  assert.equal(seen[0].turnId, done.id)
  assert.equal(done.actions[0].gate, 'auto')
})

await ok('agent loop: a liaison turn is gated with its peer and ask, follows the policy, and a throwing gate passes actions through', async () => {
  const calls = []; const sent = []; const seen = []
  const orch = createOrchestrator({
    spawn: fakeSpawn(calls), claudeBin: 'claude', broadcast: (t, d) => sent.push([t, d]), capture: fakeCapture(), snapshot: emptySnapshot,
    actionGate: (ctx) => { seen.push(ctx); throw new Error('the gate broke') },
  })
  const p = orch.liaisonAsk('start a collector', {
    peer: 'alpha', askId: 'a'.repeat(16),
    policy: { trust: 'sanctioned', autoApply: ['spawn'], asksPerHour: 20, peerAskDailyCapUsd: 2, autoApplyMaxLive: 2 },
  })
  calls[0].child.emit(assistantFrame(fence([{ kind: 'spawn', cwd: '/w', prompt: 'collect', risk: 'starts a session' }])))
  calls[0].child.finish(0)
  const r = await p
  assert.equal(seen[0].source, 'liaison'); assert.equal(seen[0].peer, 'alpha'); assert.equal(seen[0].askId, 'a'.repeat(16))
  assert.equal(r.actions.length, 1); assert.equal(Object.hasOwn(r.actions[0], 'gate'), false); assert.equal(r.actions[0].risk, 'starts a session')
  const argv = calls[0].argv
  assert.match(argv[argv.indexOf('--append-system-prompt') + 1], /has sanctioned the peer "alpha"/)
})

console.log(`orchestrator-harness: ${pass} passed`)
