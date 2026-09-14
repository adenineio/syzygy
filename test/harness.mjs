// Drives the compiled hooks module against a mock $, with real process calls
// and a real transcript, and checks its token math against an independent pass
// over the same file. Run via `just test` (two synthetic fixtures, hermetic)
// or `just test-live [session]` (a real transcript, for a by-hand check).

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve as resolvePath, basename } from 'node:path'
import { homedir } from 'node:os'
import assert from 'node:assert/strict'
// The real id list, not a hand-copied one -- spinner-frames.js is plain JS and
// needs no compile step to import here.
import { SPINNERS as REAL_SPINNERS } from '../syzygy/hooks/spinner-frames.js'

// --- JSX runtime the module was compiled against -----------------------------
globalThis.h = (tag, props, ...children) => ({
  tag: typeof tag === 'function' ? tag.elementName ?? 'fn' : tag,
  props: props ?? {},
  children: children.flat().filter((c) => c !== undefined && c !== null && c !== false),
})
globalThis.Fragment = 'Fragment'

const el = (name) => {
  const f = (props) => ({ name, props: props ?? {}, children: props?.children ?? [] })
  f.elementName = name
  return f
}
const TERMINAL_ELEMENTS = Object.freeze({
  Box: el('Box'), Text: el('Text'), div: el('div'), span: el('span'), b: el('b'),
  Button: el('Button'), Input: el('Input'), Select: el('Select'), Link: el('Link'),
})

/** Flattens a tree to the text it would draw, for assertions. */
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  const kids = node.children ?? node.props?.children ?? []
  return (Array.isArray(kids) ? kids : [kids]).map(textOf).join(' ')
}

/** Stands in for `<worktree root>/.claude/syzygy-hud-hotkeys.json`. Overrides slot 2,
 *  adds slot 5, turns the spinner picker on and picks the narrow pie. */
// The basename of both config files; the plugin's own HOTKEYS_FILE. Spelt once
// here because the mock $ matches on the argv that carries it.
const HOTKEYS_FILE = 'syzygy-hud-hotkeys.json'

// The worktree root the mocked `git rev-parse --show-toplevel` answers. A path
// that exists nowhere, deliberately: if the plugin ever stops asking git and
// falls back to the cwd, the project fixture below is not served and the merge
// assertions fail, instead of the harness quietly reading the developer's own
// file out of the real checkout.
const HARNESS_ROOT = '/tmp/szg-harness-worktree'

// `~/.claude/<HOTKEYS_FILE>`, as a fixture rather than as whatever the
// developer running the tests happens to keep there. Every value below is the
// OPPOSITE of the project file's, so the merge is genuinely exercised: if the
// precedence ever inverted, the band assertions would read `global two` and
// the moon glyphs instead of failing to notice.
const GLOBAL_CONFIG = JSON.stringify({
  settings: { spinnerPicker: false, pieStyle: 'moon' },
  hotkeys: [
    { key: '2', title: 'global two', short: 'g2', prompt: 'GLOBAL PROMPT TWO' },
    { key: '3', title: 'global three', short: 'g3', prompt: 'GLOBAL PROMPT THREE' },
  ],
})

const PROJECT_CONFIG = JSON.stringify({
  settings: { spinnerPicker: true, pieStyle: 'circle' },
  hotkeys: [
    { key: '2', title: 'harness two', short: 'h2', prompt: 'HARNESS PROMPT TWO' },
    { key: '5', title: 'harness five', short: 'h5', prompt: 'HARNESS PROMPT FIVE' },
  ],
})

// --- the mock $ --------------------------------------------------------------
// `fixtureTranscript`, when set, is the absolute path of a synthetic transcript
// fixture. The module finds its own transcript with one real `find` call
// against `~/.claude/projects` (`findTranscript` in hud.tsx); answering that
// exact call from here, matched on the filename it searches for, means the
// module never touches the real directory at all -- the fixture run reads
// only the file this harness was pointed at.
const makeDollar = ({ sessionId, cwd, model, fixtureTranscript = null }) => {
  const store = new Map()
  const timers = []
  const invalidations = []
  const registered = []
  const calls = []
  const submitted = []
  const filled = []
  const gitRootCalls = []
  const catPaths = []
  const dollarSelf = {
    _store: store, _timers: timers, _invalidations: invalidations,
    _registered: registered, _calls: calls, _submitted: submitted, _filled: filled,
    // The one knob a test flips: `prompt.fill` resolves { isFilled: false }
    // where no box can take the text (a dialog is up, or the session is
    // headless), and that is a real branch the band has to report rather than
    // swallow.
    _fillAnswers: true,
    _gitRootCalls: gitRootCalls, _catPaths: catPaths,
    process: {
      run: async (argv, init = {}) => {
        // Keep the test hermetic: never write the user's relay config and never
        // spawn a relay. Everything else really runs.
        const joined = argv.join(' ')
        if (joined.includes('syzygy-relay.json') || joined.includes('nohup')) {
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        // The two hotkey config reads, answered from fixtures rather than from
        // the disk. Matched on the ARGV the plugin actually builds, so a change
        // to either command line fails these tests instead of silently reading
        // the developer's own `~/.claude/syzygy-hud-hotkeys.json` -- which is
        // what the `$.fs.readFile` stub this replaced could never notice, and
        // is how `$.fs.readFile` stayed mocked green for a build on which it
        // threw. Ordered project-first: the global path ends in the same
        // basename.
        // The band resolves the project override at the worktree ROOT, the way
        // pane-v2's HOTKEYS mode writes it. Answered here so the test does not
        // depend on where the harness happens to be checked out.
        if (argv[0] === 'git' && argv[1] === 'rev-parse' && argv[2] === '--show-toplevel') {
          gitRootCalls.push(init.cwd ?? cwd)
          return { exitCode: 0, stdout: `${HARNESS_ROOT}\n`, stderr: '' }
        }
        // hud.tsx's own transcript lookup: `find <home>/.claude/projects
        // -maxdepth 2 -name <sessionId>.jsonl`. Matched on the filename alone,
        // not the home directory it built the search path from, so this
        // answers the call however the real $HOME resolves on the machine
        // running the test.
        if (fixtureTranscript && argv[0] === 'find' && argv.at(-1) === `${sessionId}.jsonl`) {
          return { exitCode: 0, stdout: `${fixtureTranscript}\n`, stderr: '' }
        }
        if (argv[0] === 'cat' && argv[1] === `${HARNESS_ROOT}/.claude/${HOTKEYS_FILE}`) {
          catPaths.push(argv[1])
          return { exitCode: 0, stdout: PROJECT_CONFIG, stderr: '' }
        }
        if (argv[0] === 'cat' && argv[1] === `.claude/${HOTKEYS_FILE}`) {
          catPaths.push(argv[1])
          return { exitCode: 0, stdout: PROJECT_CONFIG, stderr: '' }
        }
        if (argv[0] === 'cat' && String(argv[1]).endsWith(`/.claude/${HOTKEYS_FILE}`)) {
          return { exitCode: 0, stdout: GLOBAL_CONFIG, stderr: '' }
        }
        const r = spawnSync(argv[0], argv.slice(1), {
          cwd: init.cwd ?? cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        })
        if (r.error) throw r.error
        return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
      },
    },
    // The relay is treated as down, so the plugin exercises its offline path.
    http: { fetch: async () => ({ status: 0, ok: false, headers: {}, text: '' }) },
    tool: {
      register: async (t) => { registered.push(t); return { tool: `mcp__syzygy__${t.name}` } },
      call: async (input) => { calls.push(input); return { result: { text: 'ok' }, text: 'ok' } },
      list: async () => [],
    },
    agent: { list: async () => [{ id: 'ag1', description: 'demo', type: 'Explore', status: 'running' }], spawn: async () => ({ text: '' }) },
    prompt: {
      submit: async (p) => void submitted.push(p),
      fill: async (p) => { filled.push(p); return { isFilled: dollarSelf._fillAnswers } },
    },
    turn: { abort: async () => {} },
    audio: { speak: async () => ({}), play: async () => {} },
    model: { complete: async () => 'Reading the lexer to trace a token bug.', classify: async () => undefined, fork: async () => null },
    mcp: { call: async () => ({ content: [] }) },
    // Nothing reaches `$.fs` any more -- `just validate`'s call inventory is
    // the check -- but the namespace stays here so a future use fails loudly
    // on its RETURN VALUE rather than on a missing method. It deliberately
    // does NOT serve the hotkey fixtures: those come from `process.run` above,
    // which is where the plugin really reads them. See the note there.
    fs: { readFile: async () => '', writeFile: async () => {}, listDir: async () => [], exists: async () => false, stat: async () => ({}), ancestors: async () => [] },
    session: {
      id: async () => sessionId,
      cwd: async () => cwd,
      model: async () => model,
      surface: async () => 'terminal',
      repo: async () => null,
      turnCount: async () => 3,
      messages: async () => [],
    },
    store: {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, JSON.parse(JSON.stringify(v))),
      delete: async (k) => void store.delete(k),
      keys: async () => [...store.keys()],
    },
    clock: {
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      after: (ms, fn) => { const t = setTimeout(fn, ms); timers.push(t); return { cancel: () => clearTimeout(t) } },
      every: (ms, fn) => { const t = setInterval(fn, ms); timers.push(t); return { cancel: () => clearInterval(t) } },
    },
    ui: {
      invalidate: (e) => void invalidations.push(e),
      resolve: async () => TERMINAL_ELEMENTS,
      log: () => {},
      status: () => {},
      toast: () => {},
      notice: () => {},
      ask: async () => '',
    },
  }
  return dollarSelf
}

// --- independent recount, to check the module against ------------------------
const recount = (path) => {
  const seen = new Set()
  const t = { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0 }
  let ctx = 0
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row?.type !== 'assistant') continue
    const u = row.message?.usage, id = row.message?.id
    if (!u || typeof id !== 'string') continue
    if (!row.isSidechain) {
      const c = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
      if (c > 0) ctx = c
    }
    if (seen.has(id)) continue
    seen.add(id)
    t.inTok += u.input_tokens || 0
    t.outTok += u.output_tokens || 0
    t.cacheRead += u.cache_read_input_tokens || 0
    t.cacheWrite += u.cache_creation_input_tokens || 0
  }
  return { ...t, ctx, messages: seen.size }
}

// --- run ---------------------------------------------------------------------
// Two ways in: `--transcript <path>` or a bare path names a fixture on disk
// directly, and the harness never shells out to find anything -- the session
// id is taken from the fixture's own filename, so a fixture named
// `session-alarm.jsonl` runs as session `session-alarm`. Anything else is
// read as a session id and resolved against the real `~/.claude/projects` the
// way this harness always has, for `just test-live`'s by-hand check.
const usage = 'usage: harness.mjs <session-id> | --transcript <path> | <path-to-transcript.jsonl>'
const [arg2, arg3] = process.argv.slice(2)
let sessionId, transcript, fixtureTranscript = null

if (arg2 === '--transcript') {
  if (!arg3) { console.error(usage); process.exit(2) }
  fixtureTranscript = resolvePath(arg3)
  assert.ok(existsSync(fixtureTranscript), `no transcript fixture at ${fixtureTranscript}`)
  sessionId = basename(fixtureTranscript).replace(/\.jsonl$/, '')
  transcript = fixtureTranscript
} else if (arg2 && existsSync(arg2)) {
  fixtureTranscript = resolvePath(arg2)
  sessionId = basename(fixtureTranscript).replace(/\.jsonl$/, '')
  transcript = fixtureTranscript
} else {
  sessionId = arg2
  if (!sessionId) { console.error(usage); process.exit(2) }
  const found = spawnSync('find', [`${homedir()}/.claude/projects`, '-maxdepth', '2', '-name', `${sessionId}.jsonl`], { encoding: 'utf8' })
  transcript = (found.stdout || '').split('\n').find((l) => l.trim())?.trim()
  assert.ok(transcript && existsSync(transcript), `no transcript found for session ${sessionId}`)
}
console.log(`transcript: ${transcript}`)

const {
  register,
  modelKey, windowFor, snapWindow, windowAtLeast, derivedWindow,
  pie, PIE_STEPS, pieStep, pressureOf,
  parseHotkeys, mergeHotkeys, buttonWidth, fitHotkeys, projectHotkeysPath,
  displayWidth, fitVitals, parseSettings, mergeSettings, resolveSpinnerId, paneLabel, needsHuman,
  normalizeMarker, parseStash, stashReason, runCommand,
  lastAnswerOf, planFromToolCall, hasLineEvidence, chainPromptOf,
  bandSpendBody,
} = await import('../build/hud.js')

const hooks = []
register((...args) => {
  const hook = args[args.length - 1]
  const matcher = args.length === 3 ? args[1] : undefined
  hooks.push({ event: args[0], matcher, hook })
}, {})

const byEvent = (name) => hooks.find((x) => x.event === name)
// byEvent finds the FIRST hook for an event, which is the right answer
// everywhere it is already used. A test that means every hook on an event, to
// count them, has to say so.
const byEventAll = (name) => hooks.filter((x) => x.event === name)
/** There are now two ui.render hooks; pick the one for a given component. */
const byComponent = (c) => hooks.find((x) => x.event === 'ui.render' && x.matcher?.component === c)
assert.ok(byEvent('session.start'), 'session.start hook registered')
assert.ok(byEvent('*'), '* hook registered')
assert.ok(byComponent('AbovePrompt'), 'AbovePrompt render hook registered')
assert.ok(byComponent('Spinner'), 'Spinner render hook registered')
console.log(`hooks: ${hooks.map((x) => x.event).join(', ')}`)

const $ = makeDollar({ sessionId, cwd: process.cwd(), model: 'Opus 5', fixtureTranscript })
const echo = (e) => Promise.resolve(e)
echo.signal = new AbortController().signal
echo.event = 'session.start'
echo.is = () => false
echo.origin = 'test'

await byEvent('session.start').hook($, { cwd: process.cwd(), surface: 'terminal' }, echo)

// session.start fires refresh in the background; wait for it to land.
//
// Wait for the STORE, not for an invalidation. An invalidation is only a proxy
// for "refresh finished", and it stopped being a true one: boot also resolves
// whether a side tmux pane is open, and invalidates when it finds one -- so on
// a machine with the pane open this loop exited before refresh had persisted
// anything, and the next line failed with a bare `state` of undefined.
const deadline = Date.now() + 60_000
while (Date.now() < deadline && !$._store.get(`hud:${sessionId}`)) {
  await new Promise((r) => setTimeout(r, 100))
}
const state = $._store.get(`hud:${sessionId}`)
assert.ok(state, 'state persisted to $.store')

const expected = recount(transcript)
console.log('module  :', { inTok: state.inTok, outTok: state.outTok, cacheRead: state.cacheRead, cacheWrite: state.cacheWrite5m + state.cacheWrite1h, ctx: state.ctx })
console.log('expected:', { inTok: expected.inTok, outTok: expected.outTok, cacheRead: expected.cacheRead, cacheWrite: expected.cacheWrite, ctx: expected.ctx })

assert.equal(state.inTok, expected.inTok, 'input tokens')
assert.equal(state.outTok, expected.outTok, 'output tokens')
assert.equal(state.cacheRead, expected.cacheRead, 'cache read tokens')
assert.equal(state.cacheWrite5m + state.cacheWrite1h, expected.cacheWrite, 'cache write tokens')
assert.equal(state.ctx, expected.ctx, 'context size')
assert.equal(state.seen.length, expected.messages, 'de-duplicated message count')
console.log(`✔ token math matches an independent pass (${expected.messages} unique messages)`)

// A second ingest must be a no-op: the byte offset means nothing is recounted.
const before = JSON.stringify($._store.get(`hud:${sessionId}`))
$._invalidations.length = 0
const star = byEvent('*')
const starNext = (e) => Promise.resolve(e)
starNext.signal = new AbortController().signal
starNext.event = 'turn.complete'
starNext.is = () => false
starNext.origin = 'test'
await star.hook($, { turnId: 't1', reason: 'answer', answer: 'x', durationMs: 1, aborted: false }, starNext)
await new Promise((r) => setTimeout(r, 3000))
const after = $._store.get(`hud:${sessionId}`)
assert.equal(after.inTok, expected.inTok, 're-ingest did not double count input')
assert.equal(after.cacheRead, expected.cacheRead, 're-ingest did not double count cache reads')
console.log('✔ incremental re-read does not double count')

// Guardrail counting, through the * hook's tool.call branch.
const denyNext = () => Promise.resolve({ deny: 'nope' })
denyNext.signal = new AbortController().signal
denyNext.event = 'tool.call'
denyNext.is = (name) => name === 'tool.call'
denyNext.origin = 'test'
const g0 = $._store.get(`hud:${sessionId}`).guardrails
await star.hook($, { tool: 'Bash', tool_use_id: 'x', command: 'rm -rf /' }, denyNext)
await new Promise((r) => setTimeout(r, 100))
const g1 = $._store.get(`hud:${sessionId}`).guardrails
assert.equal(g1, g0 + 1, 'a denied tool call counts as a guardrail')
console.log(`✔ guardrail count incremented on deny (${g0} → ${g1})`)

// The plugin registers its own tools at session.start.
const toolNames = $._registered.map((t) => t.name).sort()
assert.deepEqual(
  toolNames,
  ['ask_human', 'calc', 'claim_work', 'pane_event', 'propose_pattern', 'recall',
   'release_work', 'remember', 'report_finding', 'think_harder'],
  'registered tools',
)
console.log(`✔ registered tools: ${toolNames.join(', ')}`)

// A registered tool is served by the '*' hook, not by the engine.
const calcNext = () => Promise.reject(new Error('the engine must not see a plugin tool call'))
calcNext.signal = new AbortController().signal
calcNext.event = 'tool.call'
calcNext.is = (name) => name === 'tool.call'
calcNext.origin = 'test'
const calcRes = await star.hook(
  $,
  { tool: 'mcp__syzygy__calc', tool_use_id: 'c1', expression: '(1200*0.15)/3' },
  calcNext,
)
// A plugin tool answers with a PLAIN STRING. On 2.1.270 the engine checks a
// hook's result against the tool's output shape (string | array | undefined)
// and rejects `{ text }`: "tool.call step resolved <tool> with a result that
// does not match its output shape" -- while the tool's side effect still runs.
assert.equal(typeof calcRes.result, 'string', 'a plugin tool answers with a plain string, not { text }')
assert.equal(calcRes.result, '60', 'calc evaluates exactly')
console.log('✔ calc tool served by the plugin, not the engine (60)')

const badCalc = await star.hook(
  $,
  { tool: 'mcp__syzygy__calc', tool_use_id: 'c2', expression: 'process.exit(1)' },
  calcNext,
)
assert.equal(typeof badCalc.result, 'string', 'a refusal is a plain string too')
assert.ok(/error/.test(badCalc.result), 'calc refuses anything that is not arithmetic')
console.log('✔ calc refuses non-arithmetic input')

// --- report_finding ----------------------------------------------------------
// Same `calcNext` shape as above: the engine must never see a plugin tool call.
const findNext = () => Promise.reject(new Error('the engine must not see a plugin tool call'))
findNext.signal = new AbortController().signal
findNext.event = 'tool.call'
findNext.is = (name) => name === 'tool.call'
findNext.origin = 'test'

const noLine = await star.hook($, {
  tool: 'mcp__syzygy__report_finding', tool_use_id: 'f1',
  surprise: 'the flag is variadic', kind: 'constraint',
  evidence: ['syzygy/bridge/dispatch.mjs'],
}, findNext)
assert.equal(typeof noLine.result, 'string', 'a refusal is a plain string')
assert.match(noLine.result, /line number/i,
  'evidence with no line number is refused in the plugin, before any POST')
console.log('✔ report_finding refuses evidence with no line number')

const noSurprise = await star.hook($, {
  tool: 'mcp__syzygy__report_finding', tool_use_id: 'f2',
  kind: 'drift', evidence: ['syzygy/bridge/relay.mjs:738'],
}, findNext)
assert.equal(typeof noSurprise.result, 'string')
assert.match(noSurprise.result, /surprise/i, 'no surprise, no finding')
console.log('✔ report_finding refuses a record with no surprise')

// The mock $'s http.fetch answers ok:false, so the relay is DOWN for this
// harness by construction (see makeDollar). A well-formed call therefore
// exercises the relay path and must come back with the honest message rather
// than throwing. The POST body's own shape is pinned relay-side, in
// test/fleet-harness.mjs, where a real relay answers.
const relayDown = await star.hook($, {
  tool: 'mcp__syzygy__report_finding', tool_use_id: 'f3',
  surprise: '--allowedTools is variadic and swallows the prompt',
  kind: 'constraint', touched: ['syzygy/bridge/dispatch.mjs'],
  evidence: ['syzygy/bridge/dispatch.mjs:167'],
}, findNext)
assert.equal(typeof relayDown.result, 'string')
assert.match(relayDown.result, /relay/i, 'a well-formed finding reaches the relay path')
console.log('✔ report_finding reports honestly when the relay is down')

// --- propose_pattern ---------------------------------------------------------
// Same `findNext` shape as report_finding above: the engine must never see a
// plugin tool call. The relay is down here, so nothing is POSTed.
const ppNoEvidence = await star.hook($, {
  tool: 'mcp__syzygy__propose_pattern', tool_use_id: 'pp1',
  title: 'A pattern', idea: 'an idea', methodology: 'steps', kind: 'skill', evidence: [],
}, findNext)
assert.equal(typeof ppNoEvidence.result, 'string', 'a refusal is a plain string')
assert.match(ppNoEvidence.result, /evidence/)
console.log('✔ propose_pattern refuses a call with no evidence')

const ppNoMethod = await star.hook($, {
  tool: 'mcp__syzygy__propose_pattern', tool_use_id: 'pp2',
  title: 'A pattern', idea: 'an idea', evidence: ['a.mjs:1'],
}, findNext)
assert.equal(typeof ppNoMethod.result, 'string')
assert.match(ppNoMethod.result, /methodology/)
console.log('✔ propose_pattern refuses a write-up missing its methodology')

const ppDown = await star.hook($, {
  tool: 'mcp__syzygy__propose_pattern', tool_use_id: 'pp3',
  title: 'A pattern', idea: 'an idea', methodology: '1. do it', kind: 'skill',
  evidence: ['syzygy/bridge/fleet.mjs:226'],
}, findNext)
assert.equal(typeof ppDown.result, 'string')
assert.match(ppDown.result, /relay/i, 'a well-formed proposal reaches the relay path')
console.log('✔ propose_pattern reports honestly when the relay is down')

// Read the schema off what registerTools actually passed to $.tool.register --
// check the key name it uses before trusting `inputSchema` here.
const ppTool = $._registered.find((t) => t.name === 'propose_pattern')
assert.ok(ppTool, 'propose_pattern is registered')
assert.deepEqual([...ppTool.inputSchema.required].sort(), ['evidence', 'idea', 'methodology', 'title'])
assert.deepEqual(ppTool.inputSchema.properties.kind.enum, ['skill', 'shape', 'kickoff', 'claude-md'])
console.log('✔ propose_pattern is registered with its four required inputs')

// hud.tsx carries its own copy of findings.mjs's hasLineEvidence: the hooks
// module cannot import a bridge module, which pulls in node:fs. The two copies
// are held together here, over one table.
const { hasLineEvidence: storeHasLine } = await import('../syzygy/bridge/findings.mjs')
for (const ev of [['a.js:12'], ['a.js:12:3'], ['README.md', 'a.js:9'], ['a.js'], ['a.js:'],
  [], 'a.js:12', null, [12], ['  a.js:7  '], ['a.js:12x']]) {
  assert.equal(hasLineEvidence(ev), storeHasLine(ev), `the two copies agree on ${JSON.stringify(ev)}`)
}
console.log('✔ hasLineEvidence: the hooks copy agrees with findings.mjs')

// Render.
const renderNext = (e) => Promise.resolve(e)
renderNext.signal = new AbortController().signal
renderNext.event = 'ui.render'
renderNext.is = () => false
renderNext.origin = 'test'
const tree = await byComponent('AbovePrompt').hook(
  $,
  { surface: 'terminal', component: 'AbovePrompt', requestId: 'r1',
    viewport: { columns: 100, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 20 } },
  renderNext,
)
const drawn = textOf(tree)
console.log('\n--- band ---\n' + drawn + '\n------------')
for (const needle of ['█', '/', '%', 'Opus 5', '⎇', '↑', '↓', '$', '⚑']) {
  assert.ok(drawn.includes(needle), `band shows ${JSON.stringify(needle)}`)
}
console.log('✔ band renders every field')

// A survey holding the band must be yielded to.
const yielded = await byComponent('AbovePrompt').hook(
  $,
  { surface: 'terminal', component: 'AbovePrompt', requestId: 'r2',
    viewport: { columns: 100, rows: 40 }, props: { hasSurvey: true, isWorking: false, maxRows: 20 } },
  renderNext,
)
assert.equal(yielded.props.hasSurvey, true, 'yields to a survey by returning next(e)')
console.log('✔ yields the band to a survey')

// Narrow terminal collapses to the meter row alone.
const narrow = textOf(await byComponent('AbovePrompt').hook(
  $,
  { surface: 'terminal', component: 'AbovePrompt', requestId: 'r3',
    viewport: { columns: 40, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 20 } },
  renderNext,
))
assert.ok(!narrow.includes('⎇'), 'narrow band drops the second row')
// Any step of the table counts: past three quarters the pie is the alarm glyph,
// which a fixed list of circles would miss.
assert.ok(PIE_STEPS.some((s) => narrow.includes(s.circle)), 'narrow band keeps the context pie')
console.log('✔ collapses on a narrow terminal')

// The spinner site draws the chosen spinner, not the engine's line.
const spinNext = (e) => Promise.resolve(e)
spinNext.signal = new AbortController().signal
spinNext.event = 'ui.render'
spinNext.is = () => false
spinNext.origin = 'test'
const spinTree = await byComponent('Spinner').hook(
  $,
  { surface: 'terminal', component: 'Spinner', requestId: 's1',
    viewport: { columns: 100, rows: 40 },
    props: { word: 'Sauteing', message: null, mode: 'thinking' } },
  spinNext,
)
const spinText = textOf(spinTree)
// `tide` is DEFAULT_SPINNER. Its braille fog is drawn from DENSITY on every
// frame at every width, so `⣤` is a stable marker for "the default is playing"
// in a way a positional check on a moving animation would not be.
assert.ok(spinText.includes('⣤'), 'the default spinner draws the wraith tide\'s braille fog')
// The caption is drawn as per-character coloured runs, so textOf's join puts
// spaces between them; compare against the de-spaced text.
assert.ok(spinText.replace(/\s+/g, '').includes('Sauteing'), 'the spinner keeps the turn word in its caption')
console.log('✔ spinner site draws the selected spinner with its caption')

// --- the pure maths ----------------------------------------------------------
// Exported from the module for exactly this: assert them directly rather than
// inferring them from a rendered string.

// Model name -> context window.
assert.equal(modelKey('claude-opus-5'), 'opus-5', 'strips the claude- prefix')
assert.equal(modelKey('Opus 5'), 'opus-5', 'a display name normalises to the same key')
assert.equal(modelKey('fable 5.1'), 'fable-5-1', 'dots and spaces both become dashes')

assert.equal(windowFor('claude-opus-5', 'Opus 5'), 1_000_000, 'opus 5 is a 1M window')
assert.equal(windowFor('claude-sonnet-5', ''), 1_000_000, 'sonnet 5 is a 1M window')
assert.equal(windowFor('claude-haiku-4-5', 'Haiku 4.5'), 200_000, 'haiku 4.5 is a 200k window')
assert.equal(windowFor('claude-opus-5-20260101', ''), 1_000_000, 'an unknown suffix hits the longest prefix')
assert.equal(windowFor('', 'Sonnet 4.6 [1m]'), 1_000_000, '[1m] in the label states the window outright')
assert.equal(windowFor('claude-haiku-4-5', 'Haiku 4.5 [1m]'), 1_000_000, '[1m] outranks the table')
assert.equal(windowFor('', ''), 200_000, 'nothing known falls back to 200k')
// The bug this was built for: a fresh opus-5 session, nothing used yet, used to
// open the band at 200k and only correct itself after blowing past it.
assert.equal(windowFor('claude-opus-5', 'Opus 5'), 1_000_000, 'a fresh opus 5 session opens at 1M, not 200k')
console.log('✔ context window resolves from the model, and [1m] still wins')

assert.equal(snapWindow(950_000), 1_000_000, 'just under 1M snaps to 1M')
assert.equal(snapWindow(1_050_000), 1_000_000, 'just over 1M snaps to 1M')
assert.equal(snapWindow(409_091), 500_000, 'a coarse quotient snaps to the window it meant')
assert.equal(snapWindow(0), 200_000, 'a nonsense reading falls back rather than reporting zero')
assert.equal(snapWindow(-5), 200_000, 'a negative reading falls back')
// Far outside every band it is a window this build has not heard of, so it is
// rounded rather than forced down onto the nearest thing we happen to know.
assert.equal(snapWindow(2_000_000), 2_000_000, 'an unknown window reports as itself, not as 1M')
console.log('✔ derived windows snap to known sizes without clamping unknown ones')

assert.equal(windowAtLeast(150_000), 200_000, 'the floor picks the smallest window that fits')
assert.equal(windowAtLeast(210_000), 500_000, 'a ctx past 200k proves the window is bigger')
assert.equal(windowAtLeast(1_200_000), 1_500_000, 'beyond every known window it rounds up')
console.log('✔ the observed-ctx floor never reports a window smaller than the ctx')

assert.equal(derivedWindow(220_000, 22, 1_000), 1_000_000, 'ctx over used% is the window')
assert.equal(derivedWindow(220_000, 4, 1_000), null, 'too little used to divide by')
assert.equal(derivedWindow(220_000, 22, 10 * 60_000), null, 'a stale percentage is refused')
assert.equal(derivedWindow(0, 22, 1_000), null, 'no ctx, no answer')
assert.equal(derivedWindow(220_000, 140, 1_000), null, 'an impossible percentage is refused')
console.log('✔ the statusline fallback refuses to guess rather than guessing')

// The gauge reads what is LEFT, not what is used: untouched is a full moon and
// drained is a new moon. It is the waning sequence, whose lit face shrinks --
// the waxing glyphs are its mirror images and would run the wrong way. The
// sixth step is not a phase: it is the alarm that replaces a gauge with nothing
// left to say.
const VS16 = '\uFE0F'
assert.equal(pie(0), '🌕' + VS16, 'an untouched context is a FULL moon -- the big set is the default')
assert.equal(pie(1), '❗' + VS16, 'a drained context is well past the alarm, not merely dark')

// The table is the contract. Ascending, six steps, and the colour rides beside
// the glyph so the two cannot drift apart.
assert.equal(PIE_STEPS.length, 6, 'six steps: four phases, the held crescent, the alarm')
for (let i = 1; i < PIE_STEPS.length; i += 1) {
  assert.ok(PIE_STEPS[i].from > PIE_STEPS[i - 1].from, 'the table ascends -- the lookup scans it in order')
}
assert.deepEqual(PIE_STEPS.map((s) => s.from), [0, 0.20, 0.35, 0.50, 0.66, 0.75], 'the six thresholds')
assert.deepEqual(PIE_STEPS.map((s) => s.moon), ['🌕', '🌖', '🌗', '🌘', '🌑', '❗'], 'the moon set, then the alarm')
assert.deepEqual(PIE_STEPS.map((s) => s.circle), ['●', '◕', '◑', '◔', '○', '!'], 'the narrow set runs the same way')
assert.deepEqual(
  PIE_STEPS.map((s) => s.pressure),
  ['green', 'green', 'green', 'yellow', 'red', 'red'],
  'yellow with the crescent at 50%, red with the dark moon at 66%',
)
assert.equal(new Set(PIE_STEPS.map((s) => s.moon)).size, 6, 'every moon step is a distinct glyph')
assert.equal(new Set(PIE_STEPS.map((s) => s.circle)).size, 6, 'and so is every circle step')

// Every boundary, from BOTH sides. A threshold table whose order or comparison
// is wrong degrades into the wrong glyph, never into an error.
const BOUNDARIES = [
  { at: 0.20, below: ['🌕', '●'], above: ['🌖', '◕'] },
  { at: 0.35, below: ['🌖', '◕'], above: ['🌗', '◑'] },
  { at: 0.50, below: ['🌗', '◑'], above: ['🌘', '◔'] },
  { at: 0.66, below: ['🌘', '◔'], above: ['🌑', '○'] },
  { at: 0.75, below: ['🌑', '○'], above: ['❗', '!'] },
]
for (const b of BOUNDARIES) {
  assert.equal(pie(b.at - 0.0001), b.below[0] + VS16, `just under ${b.at} still draws ${b.below[0]}`)
  assert.equal(pie(b.at), b.above[0] + VS16, `at exactly ${b.at} the moon steps to ${b.above[0]}`)
  assert.equal(pie(b.at - 0.0001, 'circle'), b.below[1], `just under ${b.at} the narrow set still draws ${b.below[1]}`)
  assert.equal(pie(b.at, 'circle'), b.above[1], `at exactly ${b.at} the narrow set steps to ${b.above[1]}`)
}

// The escalation's three promises, as assertions.
assert.equal(pie(0.55), '🌘' + VS16, 'past half is the last crescent, and it HOLDS there')
assert.equal(pie(0.65), '🌘' + VS16, '...all the way to two thirds')
assert.equal(pie(0.66), '🌑' + VS16, 'dark by two thirds')
assert.equal(pie(0.80), '❗' + VS16, 'and louder than a glyph after three quarters')
assert.equal(pie(-1), '🌕' + VS16, 'out of range clamps full')
assert.equal(pie(9), '❗' + VS16, 'out of range clamps to the alarm')

// Colour comes from the same table, so the border and the glyph change together.
assert.equal(pressureOf(0), 'green', 'a fresh session is green')
assert.equal(pressureOf(0.4999), 'green', 'green right up to half')
assert.equal(pressureOf(0.50), 'yellow', 'yellow arrives WITH the crescent')
assert.equal(pressureOf(0.6599), 'yellow', 'and holds to two thirds')
assert.equal(pressureOf(0.66), 'red', 'red arrives WITH the dark moon')
assert.equal(pressureOf(1), 'red', 'and stays')
for (const s of PIE_STEPS) {
  assert.equal(pressureOf(s.from), s.pressure, `the colour at ${s.from} is the table's own`)
  assert.equal(pieStep(s.from).moon, s.moon, `and so is the glyph at ${s.from}`)
}

// Every moon carries VARIATION SELECTOR-16. Without it the FULL moon alone
// renders as a monochrome circle wherever a symbol font that covers U+1F315 --
// and, oddly, none of the other four phases -- sits ahead of the colour emoji
// font -- an ordinary thing for a terminal's fallback chain to contain, which
// is how the quirk was found.
for (const s of PIE_STEPS) {
  assert.ok(pie(s.from).endsWith(VS16), `the moon at ${s.from * 100}% asks for emoji presentation`)
  assert.equal(displayWidth(pie(s.from)), 2, 'and VS16 costs no columns')
  assert.equal(displayWidth(pie(s.from, 'circle')), 1, 'while the narrow set is one column at every step')
}
assert.ok(!pie(0, 'circle').includes(VS16), 'the one-column set needs no presentation selector')
console.log('✔ the context pie escalates by threshold: dark at 66%, an alarm at 75%')

// --- the band's spend estimate ------------------------------------------------
// Mirrored inline in spend.mjs's estimateTokens, since a hooks module cannot
// import a node module -- the two must agree independently, not by sharing code.
const { estimateTokens: realEstimateTokens } = await import('../syzygy/bridge/spend.mjs')
assert.deepEqual(bandSpendBody('narrate', 'haiku', 'abcd', 'abcdefgh'), {
  kind: 'band', site: 'narrate', model: 'haiku',
  usage: { input: 1, output: 2 }, estimated: true,
}, 'bandSpendBody shapes a band record with estimated tokens')
for (const s of ['', 'a', 'x'.repeat(4001)]) {
  assert.equal(
    bandSpendBody('x', 'm', s, '').usage.input, realEstimateTokens(s),
    `the band's inline estimate agrees with spend.mjs's estimateTokens on a ${s.length}-character string`,
  )
}
console.log("✔ bandSpendBody's estimate matches spend.mjs's estimateTokens")

// --- the pasteboard marker ---------------------------------------------------
// The whole feature turns on one pure function, because a hooks module cannot
// read the composer: the text is first visible at prompt.submit, so the stash
// is a LEADING MARKER the submit hook recognises and swallows.
assert.equal(normalizeMarker(undefined), ',,', 'the default marker is two commas')
assert.equal(normalizeMarker(',,'), ',,')
assert.equal(normalizeMarker(';;'), ';;', 'any short punctuation run is allowed')
assert.equal(normalizeMarker('>'), '>', 'one character is allowed -- it is the user\'s risk to take')
assert.equal(normalizeMarker(''), '', 'the empty string DISABLES the feature, and that is a real setting')
// Rejections all disable rather than silently reverting to the default: a
// substituted default would start eating prompts the user never asked to have
// eaten, which is the wrong failure direction for a mechanism whose job is
// destroying what you typed.
assert.equal(normalizeMarker('aa'), '', 'a letter would eat ordinary prompts')
assert.equal(normalizeMarker('1'), '', 'and so would a digit')
assert.equal(normalizeMarker(', '), '', 'whitespace is out -- a marker must be typeable as one gesture')
assert.equal(normalizeMarker(',,,,,'), '', 'over four characters is not a marker, it is a prefix')
assert.equal(normalizeMarker('/x'), '', 'a leading / is the engine\'s: it runs a command')
assert.equal(normalizeMarker('!x'), '', 'a leading ! is bash mode')
assert.equal(normalizeMarker('#x'), '', 'a leading # is a memory line')
assert.equal(normalizeMarker('@x'), '', 'a leading @ is a file mention')
assert.equal(normalizeMarker(42), '', 'a non-string is not a marker')

assert.deepEqual(parseStash('just a prompt', ',,'), { stash: false }, 'an ordinary prompt is untouched')
assert.deepEqual(parseStash('see a,,b', ',,'), { stash: false }, 'the marker must be LEADING, not contained')
assert.deepEqual(parseStash('  ,,x', ',,'), { stash: false },
  'index 0 exactly: trimming first would make "did this get eaten?" depend on invisible characters')
assert.deepEqual(parseStash(',,hello', ''), { stash: false }, 'a disabled marker matches nothing at all')

assert.deepEqual(parseStash(',,hello there', ',,'),
  { stash: true, text: 'hello there', title: null, scope: 'session' })
assert.deepEqual(parseStash(',,,hello there', ',,'),
  { stash: true, text: 'hello there', title: null, scope: 'global' },
  'one more of the same key is the same action, wider')
assert.deepEqual(parseStash(',,@argv the argv must be an array', ',,'),
  { stash: true, text: 'the argv must be an array', title: 'argv', scope: 'session' })
assert.deepEqual(parseStash(',,,@argv the argv must be an array', ',,'),
  { stash: true, text: 'the argv must be an array', title: 'argv', scope: 'global' },
  'the two modifiers compose')
assert.deepEqual(parseStash(',,@x', ',,'), { stash: true, text: '', title: 'x', scope: 'session' },
  'a title with nothing after it is the empty case, and the hook refuses it')
assert.deepEqual(parseStash(',,@ body', ',,'), { stash: true, text: '@ body', title: null, scope: 'session' },
  'a bare @ names nothing, so it is text rather than an empty title')
assert.equal(parseStash(',,@' + 'z'.repeat(90) + ' body', ',,').title.length, 60, 'the title is capped at 60')
assert.deepEqual(parseStash('finish the harness first,,,', ',,'),
  { stash: true, text: 'finish the harness first', title: null, scope: 'global' }, 'a trailing triple stashes to the global board')
assert.deepEqual(parseStash('finish the harness first,,', ',,'),
  { stash: true, text: 'finish the harness first', title: null, scope: 'session' }, 'a trailing double stashes to this session')
assert.deepEqual(parseStash('finish the harness first ,,,  ', ',,'),
  { stash: true, text: 'finish the harness first', title: null, scope: 'global' }, 'trailing whitespace around a trailing marker is dropped')
assert.deepEqual(parseStash(',,lead wins,,,', ',,'),
  { stash: true, text: 'lead wins,,,', title: null, scope: 'session' }, 'a leading marker wins over a trailing one')
assert.deepEqual(parseStash('a, b, and c,', ',,'), { stash: false }, 'one trailing comma is prose, not a marker')
assert.deepEqual(parseStash(',,,', ',,'), { stash: true, text: '', title: null, scope: 'global' }, 'a bare triple still reads as leading, with nothing to stash')
assert.deepEqual(parseStash(',,', ',,'), { stash: true, text: '', title: null, scope: 'session' })
assert.deepEqual(parseStash(',,,', ',,'), { stash: true, text: '', title: null, scope: 'global' })
// Longest match first, or every global stash lands on the session board with a
// leading comma glued to its text.
assert.equal(parseStash(',,,x', ',,').text, 'x')
assert.equal(parseStash(',,,x', ',,').scope, 'global')
// Multi-line survives: a stash is usually the paragraph you were composing.
assert.equal(parseStash(',,one\ntwo', ',,').text, 'one\ntwo')
// A marker whose own characters repeat must not confuse the triple test.
assert.deepEqual(parseStash(';;;x', ';;'), { stash: true, text: 'x', title: null, scope: 'global' })
console.log('✔ the pasteboard marker parses: three forms, leading only, longest match first')

// The reason string the engine shows where the prompt would have gone. It is
// the only confirmation guaranteed to be seen, so it is a pure function and is
// asserted rather than eyeballed.
assert.match(
  stashReason({ ok: true, index: 0, count: 1, scope: 'session', text: 'hello', attachments: 0, restored: false }),
  /^stashed/,
)
assert.match(
  stashReason({ ok: true, index: 2, count: 7, scope: 'global', text: 'hello', attachments: 0, restored: false }),
  /3 of 7 on the global board/,
  'the index is 1-based for a human',
)
assert.match(
  stashReason({ ok: true, index: 0, count: 1, scope: 'session', text: 'x', attachments: 2, restored: false }),
  /2 attachments were not kept/,
  'a dropped image must be said out loud, not discovered later',
)
assert.match(
  stashReason({ ok: false, error: 'board full', scope: 'session', text: 'x', attachments: 0, restored: true }),
  /your text is back in the composer/,
  'a refused stash must never be a lost draft',
)
assert.ok(
  stashReason({ ok: false, error: 'unreachable', scope: 'session', text: 'a lost thought', attachments: 0, restored: false })
    .includes('a lost thought'),
  'if even the restore failed, the reason is the last copy of the text and carries it verbatim',
)
// The relay owns the cap; the band only reports the length it was handed, so a
// changed limit never leaves a stale number in the sentence.
assert.match(
  stashReason({ ok: false, error: 'too long', scope: 'session', text: 'x'.repeat(41022), attachments: 0, restored: true }),
  /41,022 characters/,
  'a text refused as too long says how long it was',
)
console.log('✔ the drop reason says what happened to the text, every time')

// --- the fill verb -----------------------------------------------------------
// The pane's half of the loop: the relay enqueues { verb: 'fill' }, the band
// drains it and writes the text into the composer. `$.prompt.fill` REPLACES
// what the box held, which is why every surface that offers it says so.
$._filled.length = 0
$._fillAnswers = true
await runCommand($, { verb: 'fill', payload: { text: 'the stash comes back' } })
assert.equal($._filled.length, 1, 'the fill verb calls $.prompt.fill exactly once')
assert.deepEqual($._filled[0], { text: 'the stash comes back' }, '...with the text and nothing else')

$._filled.length = 0
await runCommand($, { verb: 'fill', payload: {} })
assert.equal($._filled.length, 0, 'a fill with no text does nothing at all')

$._filled.length = 0
await runCommand($, { verb: 'fill', payload: { text: 'x' } })
assert.equal($._filled.length, 1)
// A refusal is a real outcome -- a permission dialog holds the keys -- and it
// has to be reported, not swallowed, or the pane looks broken.
$._fillAnswers = false
$._filled.length = 0
await runCommand($, { verb: 'fill', payload: { text: 'refused' } })
assert.equal($._filled.length, 1, 'it still tried')
$._fillAnswers = true
console.log('✔ the fill verb writes a stash back into the composer, and says when it cannot')

// The hook itself. It is NOT in the '*' collector -- that runs for every event
// and is the hot path -- so its own registration is the thing to assert.
assert.ok(byEvent('prompt.submit'), 'the stash hook is registered on prompt.submit')
assert.equal(byEvent('prompt.submit').matcher, undefined,
  'and unfiltered: the origin gate is a line in the hook, not a matcher, because ' +
  'a matcher on e.origin.kind would silently stop matching if the engine added a kind')

// The topic chain notes every prompt's origin on the same event. The engine
// throws on a second registration of one event without a matcher, and a
// matcher would narrow which origins are noted, so the note is a line at the
// top of the stash hook, ahead of its origin gate -- one hook, still unfiltered.
const submitHooks = byEventAll('prompt.submit')
assert.equal(submitHooks.length, 1,
  'one hook on prompt.submit: the chain note is a line in the stash hook, because a repeated ' +
  'registration without a matcher throws')
assert.equal(submitHooks[0].matcher, undefined,
  'and unfiltered: the origin gate is a line in the hook, not a matcher, and the chain note runs ' +
  'before that gate so it sees every origin')
const chainSubmitHook = submitHooks[0]

// The origin match, as a pure function: the head is the turn's own text, and
// the origin is whatever prompt.submit saw for the same head.
{
  const q = [
    { head: 'A', origin: 'composer' },
    { head: 'B', origin: 'bridge' },
    { head: 'C', origin: 'sdk' },
  ]
  assert.deepEqual(chainPromptOf('C', q), { prompt: { head: 'C', origin: 'sdk' }, pending: [] },
    'a match takes its origin and drops every entry queued before it')
  assert.deepEqual(chainPromptOf('B', q),
    { prompt: { head: 'B', origin: 'bridge' }, pending: [{ head: 'C', origin: 'sdk' }] },
    'and keeps every entry queued after it')
  assert.deepEqual(chainPromptOf('Z', q), { prompt: { head: 'Z', origin: 'unknown' }, pending: q },
    'no match says unknown, keeps its own head, and leaves the queue alone')
  assert.notEqual(chainPromptOf('Z', q).pending, q, 'the queue handed back is a copy, never the one passed in')
  assert.equal(q.length, 3, 'and the one passed in is not modified')
  assert.deepEqual(
    chainPromptOf('A', [{ head: 'A', origin: 'composer' }, { head: 'A', origin: 'sdk' }]),
    { prompt: { head: 'A', origin: 'composer' }, pending: [{ head: 'A', origin: 'sdk' }] },
    'two prompts with one head: the first queued is the one matched')
  assert.deepEqual(chainPromptOf('', [{ head: '', origin: 'composer' }]),
    { prompt: { head: '', origin: 'unknown' }, pending: [{ head: '', origin: 'composer' }] },
    'a turn started with no text matches nothing, not even an empty head')
  assert.deepEqual(chainPromptOf(undefined, []), { prompt: { head: '', origin: 'unknown' }, pending: [] },
    'and an absent text does not throw')
  const long = 'x'.repeat(1000)
  assert.equal(chainPromptOf(long, []).prompt.head, long.slice(0, 400), 'the head is cut at 400 characters')
  assert.equal(chainPromptOf(long, [{ head: long.slice(0, 400), origin: 'composer' }]).prompt.origin, 'composer',
    'and a long prompt still matches, head against head')
}
console.log('✔ chainPromptOf matches a turn to its prompt by text, never by position')

// --- the stash hook, driven -----------------------------------------------------
// A fresh `next` per submission, recording whether the prompt was let through.
// It answers the way the engine does for a prompt that entered: `{ text }`.
const submitNext = () => {
  const calls = []
  const next = (e) => { calls.push(e); return Promise.resolve({ text: e.text }) }
  next.calls = calls
  next.signal = new AbortController().signal
  next.event = 'prompt.submit'
  next.is = (name) => name === 'prompt.submit'
  next.origin = 'test'
  return next
}
const submitPrompt = async (e) => {
  const next = submitNext()
  const out = await byEvent('prompt.submit').hook($, { wait: false, ...e }, next)
  return { out, calls: next.calls }
}

$._filled.length = 0
$._fillAnswers = true
{
  const { out, calls } = await submitPrompt({ text: ',,x', origin: { kind: 'plugin', name: 'syzygy' } })
  assert.equal(calls.length, 1, "this plugin's own submitted prompt passes through, marker and all")
  assert.equal($._filled.length, 0, 'and nothing is written back into the composer')
  assert.equal(out?.drop, undefined, 'and nothing is dropped')
}
{
  const { calls } = await submitPrompt({ text: 'just a prompt', origin: { kind: 'composer' } })
  assert.equal(calls.length, 1, 'an ordinary typed prompt passes through')
}
{
  const { out, calls } = await submitPrompt({ text: ',,', origin: { kind: 'composer' } })
  assert.match(out?.drop ?? '', /nothing after the marker/, 'a bare marker is refused by name')
  assert.equal(calls.length, 0, 'and never reaches the model')
  assert.equal($._filled.length, 0, 'and there is nothing to put back')
}
{
  // The relay is down here: the default fetch stub answers ok:false.
  const { out, calls } = await submitPrompt({ text: ',,hello', origin: { kind: 'composer' } })
  assert.equal(calls.length, 0, 'a stash never reaches the model, even a refused one')
  assert.match(out?.drop ?? '', /relay is not answering/, 'a stopped relay is named as the reason')
  assert.match(out?.drop ?? '', /back in the composer/, 'and the reason says the draft survived')
  assert.deepEqual($._filled, [{ text: ',,hello' }], 'the draft is restored exactly as typed, marker included')
}
{
  $._filled.length = 0
  $._fillAnswers = false
  const { out } = await submitPrompt({ text: ',,hello', origin: { kind: 'composer' } })
  assert.ok((out?.drop ?? '').includes('hello'), 'when the restore fails too, the reason carries the text')
  assert.doesNotMatch(out?.drop ?? '', /back in the composer/, 'and does not claim a restore that did not happen')
  $._fillAnswers = true
  $._filled.length = 0
}
console.log('✔ the stash hook swallows only a typed marker, and a refusal never loses the draft')

// --- the chain observer and the turn events, driven --------------------------
// A prompt is submitted through the one prompt.submit hook, which notes it for
// the chain before deciding anything about a stash.
const chainSubmit = async (e) => {
  const next = submitNext()
  const out = await chainSubmitHook.hook($, { wait: false, ...e }, next)
  return { out, calls: next.calls }
}
// A `next` that narrows for the event it is handed, so the '*' hook takes the
// turn branches rather than falling straight through.
const turnNext = (event) => {
  const next = (e) => Promise.resolve(event === 'turn.start' ? { turnId: e.turnId } : { text: e.answer ?? '' })
  next.signal = new AbortController().signal
  next.event = event
  next.is = (name) => name === event
  next.origin = 'test'
  return next
}
const startTurn = (text, turnId) => star.hook($, { text, turnId }, turnNext('turn.start'))
const completeTurn = (turnId, extra = {}) => star.hook(
  $,
  { turnId, reason: 'answer', answer: 'done', durationMs: 1234, isAborted: false, ...extra },
  turnNext('turn.complete'),
)
const settleChain = () => new Promise((r) => setTimeout(r, 50))

{
  // Noting a prompt for the chain changes nothing about it: a prompt that is
  // not a stash comes back as exactly what next(e) resolved to, and the event
  // forwarded is the one received, nothing rewritten, nothing added.
  const answered = { text: 'passes through' }
  const forwarded = []
  const next = (ev) => { forwarded.push(ev); return Promise.resolve(answered) }
  Object.assign(next, { signal: new AbortController().signal, event: 'prompt.submit', is: (n) => n === 'prompt.submit', origin: 'test' })
  const e = { wait: false, text: 'passes through', origin: { kind: 'composer' } }
  const out = await chainSubmitHook.hook($, e, next)
  assert.equal(out, answered, 'the chain observer returns exactly what next(e) resolved to')
  assert.equal(forwarded.length, 1, 'and calls next once')
  assert.equal(forwarded[0], e, 'with the very event it received')
  assert.deepEqual(e, { wait: false, text: 'passes through', origin: { kind: 'composer' } },
    'which it has not added to or changed')
  const plain = await chainSubmit({ text: 'a typed prompt', origin: { kind: 'composer' } })
  assert.deepEqual(plain.out, { text: 'a typed prompt' }, 'a prompt that entered passes through unchanged')
  assert.equal(plain.calls.length, 1)
}
{
  // The relay is down here: the default fetch stub answers ok:false, so the
  // band never marked it up. A finished turn must not even try.
  const fetchBefore = $.http.fetch
  const chainFetches = []
  $.http.fetch = async (url, init) => {
    if (String(url).includes('/api/chain')) chainFetches.push(String(url))
    return fetchBefore(url, init)
  }
  await chainSubmit({ text: 'offline prompt', origin: { kind: 'composer' } })
  await startTurn('offline prompt', 'off1')
  await assert.doesNotReject(completeTurn('off1'), 'a finished turn with the relay down does not throw')
  await settleChain()
  $.http.fetch = fetchBefore
  assert.deepEqual(chainFetches, [], 'and makes no chain call at all')
}
console.log('✔ noting a prompt for the chain changes nothing, and a turn with the relay down posts nothing')

// A moon is ONE code point and TWO columns. Everything that measures the row
// has to ask displayWidth, or the vitals row is budgeted a column short per
// pie and quietly overflows.
assert.equal(displayWidth('🌖'), 2, 'a moon glyph is two columns wide')
assert.equal('🌖'.length, 2, '...and two UTF-16 units, which is a different number by luck')
assert.equal(displayWidth('○'), 1, 'the narrow pie is one column')
assert.equal(displayWidth('⎇ develop*'), 10, 'the band\'s other non-ASCII is single-width')
assert.equal(displayWidth('↑1.2M ↓3k'), 9, 'so are the arrows')
assert.equal(displayWidth('🌖 316k'), 7, 'mixed content adds up')
// The alarm is the case a .length measure gets wrong in the OTHER direction
// from the moons: one UTF-16 unit, two columns.
assert.equal(displayWidth('❗'), 2, 'the warning glyph is two columns like the moons it replaces')
assert.equal('❗'.length, 1, '...and ONE UTF-16 unit, where a moon is two')
assert.equal(displayWidth('❗ 940k / 1.00M'), 15, 'so a warning row is budgeted correctly')
assert.equal(displayWidth('!'), 1, 'the narrow set warns in one column')
console.log('✔ display width counts columns, not code units')

// The vitals row drops by PRIORITY, not by position: what sits rightmost is
// not what matters least.
const V = [
  { key: 'pie', text: '🌖', prio: 0 },        // 2 cols
  { key: 'meter', text: '316k / 1.00M', prio: 0 }, // 12
  { key: 'model', text: 'Opus 5', prio: 2 },  // 6
  { key: 'trend', text: '▁▂▃▄', prio: 8 },    // 4  <- least useful, sits in the middle
  { key: 'branch', text: '⎇ main', prio: 3 }, // 6
]
const roomy2 = fitVitals(V, 100, 1)
assert.equal(roomy2.dropped.length, 0, 'everything fits when there is room')
assert.deepEqual(roomy2.kept.map((v) => v.key), ['pie', 'meter', 'model', 'trend', 'branch'])

const squeezed = fitVitals(V, 30, 1)
assert.deepEqual(squeezed.dropped.map((v) => v.key), ['trend'],
  'the middle item goes first because its priority is worst, not its position')
assert.deepEqual(squeezed.kept.map((v) => v.key), ['pie', 'meter', 'model', 'branch'],
  'and the survivors keep their reading order')

const tighter = fitVitals(V, 20, 1)
assert.deepEqual(tighter.dropped.map((v) => v.key), ['model', 'trend', 'branch'],
  'dropped items come back in display order, ready to spill onto a second row')
assert.deepEqual(tighter.kept.map((v) => v.key), ['pie', 'meter'])

const hopeless = fitVitals(V, 1, 1)
assert.equal(hopeless.kept.length, 1, 'the first item is never dropped')
assert.equal(hopeless.kept[0].key, 'pie')
assert.equal(hopeless.dropped.length, 4, 'and everything else is reported as dropped')
assert.deepEqual(fitVitals([], 80, 1), { kept: [], dropped: [] }, 'no vitals, no row')
console.log('✔ the vitals row drops by priority and reports what it dropped')

// Band settings.
assert.equal(parseSettings('not json'), null, 'unparseable settings fall back')
assert.equal(parseSettings('{"hotkeys":[]}'), null, 'a file with no settings block has none')
assert.deepEqual(parseSettings('{"settings":{"spinnerPicker":true}}'), { spinnerPicker: true })
assert.deepEqual(parseSettings('{"settings":{"pieStyle":"circle"}}'), { pieStyle: 'circle' })
assert.deepEqual(parseSettings('{"settings":{"pieStyle":"hexagon","spinnerPicker":"yes"}}'), {},
  'a wrong-typed or unknown value is ignored, not fatal to the rest of the block')
assert.deepEqual(parseSettings('{"settings":{"spinner":"wisp"}}'), { spinner: 'wisp' },
  'a spinner id is parsed the same as any other setting -- validity is checked at use time, not here')
assert.deepEqual(parseSettings('{"settings":{"spinner":""}}'), {},
  'an empty string is not a real id, so it is dropped rather than carried as a pin to nothing')
assert.deepEqual(parseSettings('{"settings":{"spinner":7}}'), {}, 'a wrong-typed spinner is ignored, not fatal')

assert.equal(mergeSettings(null, null).spinnerPicker, false,
  'the spinner picker is OFF by default -- it is set once and then looked at forever')
assert.equal(mergeSettings(null, null).pieStyle, 'moon', 'and the big pie is the default')
assert.equal(mergeSettings(null, null).spinner, undefined, 'no default spinner -- absence defers to $.store')
assert.equal(mergeSettings({ spinnerPicker: true }, null).spinnerPicker, true, 'global turns it on')
assert.equal(mergeSettings({ spinnerPicker: true }, { spinnerPicker: false }).spinnerPicker, false,
  'and the project wins over the global')
assert.equal(mergeSettings({ pieStyle: 'circle' }, {}).pieStyle, 'circle',
  'a setting the project omits keeps the global')
assert.equal(mergeSettings({ spinner: 'wisp' }, {}).spinner, 'wisp',
  'a project file that omits spinner inherits the global pin')
assert.equal(mergeSettings({ spinner: 'wisp' }, { spinner: 'orrery' }).spinner, 'orrery',
  'a project file that names one overrides the global pin')
console.log('✔ band settings merge defaults, global, then project')

// Which spinner actually plays: file, then $.store, then the shipped default.
// REAL_SPINNERS stands in for "some real id" without hard-coding one that
// might be renamed out from under this test; DEFAULT_SPINNER itself is not
// exported, so 'tide' is asserted directly -- it is documented in
// docs/FEATURES.md's Spinners table and in the SPIN_MS/DEFAULT_SPINNER pair
// in hud.tsx, so a rename there is a deliberate, visible edit.
const REAL_ID_A = REAL_SPINNERS[0].id
const REAL_ID_B = REAL_SPINNERS[1].id
assert.notEqual(REAL_ID_A, REAL_ID_B, 'fixture sanity: two distinct real ids')
assert.equal(resolveSpinnerId(undefined, undefined), 'tide', 'neither source has an opinion -> the shipped default')
assert.equal(resolveSpinnerId(undefined, REAL_ID_B), REAL_ID_B, 'file silent -> the store is the picker\'s live choice')
assert.equal(resolveSpinnerId(REAL_ID_A, REAL_ID_B), REAL_ID_A, 'file names a real id -> the file wins over the store')
assert.equal(resolveSpinnerId('not-a-real-id', REAL_ID_B), REAL_ID_B,
  'an unknown id in the file falls through to the store rather than sticking or throwing')
assert.equal(resolveSpinnerId('not-a-real-id', 'also-not-real'), 'tide',
  'unknown in both sources -> the shipped default, not a crash')
assert.equal(resolveSpinnerId('not-a-real-id', undefined), 'tide', 'unknown file id, no store value -> the default')
assert.equal(resolveSpinnerId(undefined, 42), 'tide', 'a non-string store value is not trusted either')
console.log('✔ resolveSpinnerId: config file pins, $.store is the live fallback, then the shipped default')

// The pane button's three states.
assert.deepEqual(paneLabel(true, false), { label: 'open pane', short: 'pane' }, 'in tmux, closed')
assert.deepEqual(paneLabel(true, true), { label: 'close pane', short: 'close' }, 'in tmux, open -- it toggles')
assert.deepEqual(paneLabel(false, false), { label: 'pane needs tmux', short: 'no tmux' }, 'no tmux, no pane')
assert.deepEqual(paneLabel(false, true), { label: 'pane needs tmux', short: 'no tmux' },
  'and tmux-lessness wins over a stale open flag, so the button never lies')
for (const [a, b] of [[true, false], [true, true], [false, false]]) {
  const { label, short } = paneLabel(a, b)
  assert.ok(short.length < label.length, `${label} has a shorter form for a narrow row`)
}
console.log('✔ the pane button toggles its label and degrades without tmux')

// --- does this finished turn need the user? ----------------------------------
// Only a turn that ENDED WITH AN ANSWER can be waiting on anybody.
for (const reason of ['aborted', 'error', 'refusal']) {
  assert.equal(needsHuman('Shall I proceed?', reason), '',
    `a turn that ended by ${reason} is not waiting on a human -- they are already here`)
}
assert.equal(needsHuman('', 'answer'), '', 'a silent turn asks nothing')
assert.equal(needsHuman('   ', 'answer'), '', 'and neither does whitespace')
assert.equal(needsHuman(null, 'answer'), '', 'a missing answer does not throw')

// A question at the end.
assert.equal(needsHuman('Done. Want me to commit it?', 'answer'), 'Want me to commit it?')
// A phrase, with no question mark anywhere.
assert.equal(needsHuman('All green. Let me know if you want the tmux binding too.', 'answer'),
  'Let me know if you want the tmux binding too.')
assert.equal(needsHuman('This needs your review before it merges.', 'answer'),
  'This needs your review before it merges.')
assert.equal(needsHuman('Blocked until you confirm the deletion.', 'answer'),
  'Blocked until you confirm the deletion.')

// A turn that simply reports is NOT waiting on anybody -- the common case, and
// the one a noisy classifier would get wrong all day.
assert.equal(needsHuman('Fixed the race and re-ran the gate. All 96 checks pass.', 'answer'), '',
  'a plain report asks for nothing')
assert.equal(needsHuman('I removed the button because it never worked.', 'answer'), '',
  'a statement about the past is not a request')

// Two asks: the LAST one is what it is waiting on.
assert.equal(needsHuman('Should I use tmux? Actually, which terminal do you use?', 'answer'),
  'Actually, which terminal do you use?', 'the last ask wins, not the first')

// Only the TAIL is examined: an agent that says "let me know" mid-report and
// then carries on working is not waiting on anybody.
const buried = 'Let me know if that looks wrong. ' + 'Then I carried on and did the work. '.repeat(20)
assert.ok(buried.length > 400, 'fixture is longer than the tail window')
assert.equal(needsHuman(buried, 'answer'), '', 'an ask buried before the tail does not count')

// Markdown is stripped, since a turn's last line usually wears some.
assert.equal(needsHuman('- **Should I** push it?', 'answer'), 'Should I push it?',
  'bullets, bold and stray punctuation come off')
assert.equal(needsHuman('#### Ready. Want `--force`?', 'answer'), 'Want --force?')

// And it is capped, because it goes on a card.
const long = 'Do you want me to ' + 'keep going '.repeat(25) + '?'
assert.ok(long.length < 400, 'the fixture sits INSIDE the tail window, so the cap is what is under test')
const got = needsHuman(long, 'answer')
assert.ok(got.length <= 140, `the reason is capped for a card, got ${got.length}`)
assert.ok(got.startsWith('Do you want me to'), 'and it is capped from the end, keeping the ask itself')

// The two limits compose in the order they are applied: the tail window cuts
// first, so an ask that STARTS before the window is gone entirely rather than
// arriving truncated. That is the honest result -- half an ask on a card is
// worse than none.
const overlong = 'Do you want me to ' + 'keep going and going '.repeat(30) + '?'
assert.ok(overlong.length > 400, 'this one starts outside the window')
assert.ok(!needsHuman(overlong, 'answer').startsWith('Do you want me to'),
  'an ask beginning before the tail window is not reported from its middle')
console.log('✔ needsHuman flags turns that hand work back, and ignores plain reports')

// --- what the session last said ----------------------------------------------
// lastAnswerOf is needsHuman's opposite number: same input, no classification.
// It exists so the drawer can show the text and it can be answered.
assert.equal(lastAnswerOf('  Done. Tests pass.  '), 'Done. Tests pass.', 'trimmed, otherwise verbatim')
assert.equal(lastAnswerOf(''), '', 'no answer is no message')
assert.equal(lastAnswerOf(undefined), '', 'and an absent answer does not throw')
// Nothing is stripped: unlike needsHuman, this is the message, markdown and
// all. A drawer that silently ate the backticks out of a code suggestion would
// be worse than one that shows them.
assert.equal(lastAnswerOf('- **Run** `just verify`'), '- **Run** `just verify`',
  'markdown survives -- this is the text, not a classification of it')
// Capped from the END, the same direction as NEEDS_TAIL and for the same
// reason: a long answer loses its opening, never its conclusion.
const said = 'A'.repeat(3000) + 'THE CONCLUSION'
const capped = lastAnswerOf(said)
assert.ok(capped.length <= 2049, `capped to 2 KB plus the marker, got ${capped.length}`)
assert.ok(capped.endsWith('THE CONCLUSION'), 'and the end is what survives')
assert.ok(capped.startsWith('…'), 'an elision marker says the start was dropped')
// The marker appears ONLY when the cap actually bit, or every short message
// would wear one and it would stop meaning anything.
assert.ok(!lastAnswerOf('short').startsWith('…'), 'a message under the cap carries no marker')
console.log('✔ lastAnswerOf keeps the tail of what a turn said, uncapped by meaning')

// --- which tool calls count as "working on a plan" ---------------------------
assert.equal(planFromToolCall('Edit', { file_path: 'docs/plans/x.md' }), 'x.md',
  'editing a plan under docs/plans/ claims it by basename')
assert.equal(planFromToolCall('Write', { file_path: 'docs/superpowers/plans/y.md' }), 'y.md',
  'the older docs/superpowers/plans/ location is recognised too')
assert.equal(planFromToolCall('Edit', { file_path: 'docs/plans/README.md' }), null,
  'README.md is an index, not a plan')
assert.equal(planFromToolCall('Edit', { file_path: 'src/index.ts' }), null,
  'an unrelated path claims nothing')
assert.equal(planFromToolCall('Bash', { command: 'just plan-reported docs/plans/x.md 3' }), 'x.md',
  'reporting a task in a plan claims it by basename too')
assert.equal(planFromToolCall('Bash', { command: 'just plan-done docs/plans/x.md 3' }), 'x.md',
  'so does marking one verified')
assert.equal(planFromToolCall('Bash', { command: 'just verify' }), null,
  'an unrelated bash command claims nothing')
assert.equal(planFromToolCall('Read', { file_path: 'docs/plans/x.md' }), null,
  'reading a plan is not working on it')
console.log('✔ planFromToolCall identifies a plan edit or a plan-reported/plan-done by basename')

// Hotkey config parsing.
assert.equal(parseHotkeys('not json'), null, 'unparseable config falls back rather than clearing')
assert.equal(parseHotkeys('{}'), null, 'a file with no hotkeys array is not a config')
assert.deepEqual(parseHotkeys('{"hotkeys":[]}'), [], 'an empty array is somebody clearing every slot')
const parsed = parseHotkeys(JSON.stringify({ hotkeys: [
  { key: '2', title: 'alpha', short: 'a', prompt: 'PA' },
  { key: '1', title: 'reserved', prompt: 'nope' },   // built-in, refused
  { key: '4', title: 'reserved', prompt: 'nope' },   // built-in, refused
  { key: 'x', title: 'letter', prompt: 'nope' },     // not a slot
  { key: '2', title: 'dupe', prompt: 'nope' },       // first wins
  'garbage', null, 42,                               // non-objects
  { key: '5', title: 'beta', prompt: 'PB' },         // short falls back to title
] }))
assert.equal(parsed.length, 2, 'reserved keys, letters, duplicates and junk are all dropped')
assert.deepEqual(parsed[0], { key: '2', title: 'alpha', short: 'a', prompt: 'PA' })
assert.equal(parsed[1].short, 'beta', 'a missing short label falls back to the title')
console.log('✔ hotkey config drops bad entries instead of throwing on them')

// Global + project merge.
const globals = [
  { key: '2', title: 'g-two', short: 'g2', prompt: 'G2' },
  { key: '3', title: 'g-three', short: 'g3', prompt: 'G3' },
  { key: '9', title: 'g-nine', short: 'g9', prompt: 'G9' },
]
const merged = mergeHotkeys(globals, [
  { key: '3', title: 'p-three', short: 'p3', prompt: 'P3' },   // overrides
  { key: '5', title: 'p-five', short: 'p5', prompt: 'P5' },    // adds
  { key: '9', title: 'off', short: 'off', prompt: '' },        // hides
])
assert.deepEqual(merged.map((h) => h.key), ['2', '3', '5'], 'slots come back in display order')
assert.equal(merged.find((h) => h.key === '2').prompt, 'G2', 'a slot the project omits keeps the global')
assert.equal(merged.find((h) => h.key === '3').prompt, 'P3', 'the project wins its own slot')
assert.ok(!merged.some((h) => h.key === '9'), 'an empty prompt turns a global slot off')
assert.deepEqual(mergeHotkeys([], []), [], 'no config, no slots')
console.log('✔ project hotkeys override the global ones slot by slot')

// WHERE the project file is read from. pane-v2's HOTKEYS mode writes
// <worktree root>/.claude/<file> (git -C <cwd> rev-parse --show-toplevel); the
// band read <session cwd>/.claude/<file>, so a session started in a
// subdirectory edited one file in the pane and read another in the band, with
// nothing reporting it.
assert.equal(
  projectHotkeysPath('/w/t'), `/w/t/.claude/${HOTKEYS_FILE}`,
  'inside a worktree the override is read at the ROOT',
)
assert.equal(
  projectHotkeysPath(''), `.claude/${HOTKEYS_FILE}`,
  'outside git the cwd-relative read stands -- no root is not an error',
)
assert.ok(
  $._catPaths.includes(`${HARNESS_ROOT}/.claude/${HOTKEYS_FILE}`),
  `the band read the project file at the git root; it read: ${$._catPaths.join(', ')}`,
)
assert.ok(
  !$._catPaths.includes(`.claude/${HOTKEYS_FILE}`),
  'and never by the bare relative path while a root is known',
)
assert.ok($._gitRootCalls.length >= 1, 'the root really was asked of git')
assert.ok(
  $._gitRootCalls.length <= 2,
  `the root is memoised, not re-asked every turn boundary (asked ${$._gitRootCalls.length} times)`,
)
console.log(`✔ the project hotkeys file is resolved at the git root (${$._gitRootCalls.length} git call(s))`)

// The one-row fit ladder. A wrapped row is not a cosmetic problem: AbovePrompt
// clips a tall tree and disarms every hotkey in it.
const row = [
  { key: '1', label: 'open pane', short: 'pane' },
  { key: '2', label: 'my next steps', short: 'next' },
  { key: '3', label: 'step back', short: 'back' },
  { key: '4', label: 'what now?', short: 'now?' },
]
assert.equal(buttonWidth('1', 'open pane'), 12, 'a plain button draws as "<key>: <label>"')
const FULL = 58   // 12 + 16 + 12 + 12, plus 2 of gap between each pair
const SHORT = 34  // 7 * 4, plus the same 6 of gap

const wide = fitHotkeys(row, FULL, 2)
assert.equal(wide.hidden, 0, 'everything fits at full width')
assert.deepEqual(wide.shown.map((b) => b.label), ['open pane', 'my next steps', 'step back', 'what now?'])

const medium = fitHotkeys(row, FULL - 1, 2)
assert.equal(medium.hidden, 0, 'one column short of full, every slot survives on short labels')
assert.deepEqual(medium.shown.map((b) => b.label), ['pane', 'next', 'back', 'now?'])

assert.equal(fitHotkeys(row, SHORT, 2).hidden, 0, 'short labels fit exactly at their own width')

const tight = fitHotkeys(row, SHORT - 1, 2)
assert.equal(tight.hidden, 1, 'one column short of the short labels, the last slot goes')
assert.deepEqual(tight.shown.map((b) => b.key), ['1', '2', '3'], 'dropping starts from the right')

const cramped = fitHotkeys(row, 10, 2)
assert.equal(cramped.shown.length, 1, 'at the extreme only the first button is kept')
assert.equal(cramped.hidden, 3, 'and the marker says how many went')

const impossible = fitHotkeys(row, 1, 2)
assert.equal(impossible.shown.length, 1, 'the first button is never dropped, however narrow')
assert.equal(impossible.shown[0].key, '1', 'and it is always open pane')

assert.deepEqual(fitHotkeys([], 80, 2), { shown: [], hidden: 0 }, 'no slots, no row')
console.log('✔ the action row fits one line, shortening then dropping from the right')

// --- the band, end to end ----------------------------------------------------
/** Like textOf, but keeps rows apart and renders a Button's label -- enough to
 *  assert WHICH row a field landed on, which textOf cannot answer. */
const draw2 = (n) => {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(draw2).join('')
  const p = n.props ?? {}
  if (n.tag === 'Button') return `${p.hotkey ?? '·'}: ${p.label ?? ''}`
  if (n.tag === 'Link') return p.label ?? p.href ?? ''
  if (n.tag === 'Select') return `[${p.label}: ${p.value}]`
  const kids = (n.children ?? []).map(draw2).filter((x) => x !== '')
  if (n.tag === 'Box' && p.flexDirection !== 'column') return kids.join(' '.repeat(p.gap ?? 0))
  return kids.join('\n')
}

const buttonsIn = (node, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) buttonsIn(n, out); return out }
  if (node.tag === 'Button') out.push(node.props ?? {})
  for (const k of node.children ?? []) buttonsIn(k, out)
  return out
}
const bandTree = await byComponent('AbovePrompt').hook(
  $,
  { surface: 'terminal', component: 'AbovePrompt', requestId: 'r4',
    viewport: { columns: 140, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 20 } },
  renderNext,
)
const bandText = textOf(bandTree)
const bandButtons = buttonsIn(bandTree)
const hotkeysDrawn = bandButtons.map((b) => b.hotkey).filter(Boolean)

assert.ok(hotkeysDrawn.includes('1'), 'hotkey 1 still opens the pane')
assert.ok(hotkeysDrawn.includes('4'), 'hotkey 4 is still what now?')
assert.equal(new Set(hotkeysDrawn).size, hotkeysDrawn.length, 'no digit is bound twice')
for (const k of hotkeysDrawn) assert.ok(/^[0-9]$/.test(k), `hotkey ${k} is a digit -- letters are refused`)
// Against the button LABELS, not the flattened text: textOf does not descend
// into a Button's label prop, so asserting on bandText here would pass for any
// label at all.
//
// The band's buttons are the pane toggle, `what now?` and the configured
// prompt slots. A spinner picker is opt-in and off by default, and the stuck
// row carries no button: each of the three below would cost a permanent row
// for something a hotkey or a lapse already does.
const labelsDrawn = bandButtons.map((b) => b.label)
for (const absent of ['next spinner', 'prev', 'dismiss']) {
  assert.ok(!labelsDrawn.includes(absent), `the band draws no "${absent}" button by default`)
}
// Hotkey 1 now opens and closes the side TUI pane rather than the browser --
// the pane URL is already a click away on the right of the row. Which of the
// three labels it wears depends on live tmux state, so assert membership here
// and the mapping itself in the pure test below.
const paneBtn = bandButtons.find((b) => b.hotkey === '1')
assert.ok(paneBtn, 'hotkey 1 is drawn')
assert.ok(['open pane', 'close pane', 'pane needs tmux'].includes(paneBtn.label),
  `the pane button wears a known label, got ${JSON.stringify(paneBtn.label)}`)
assert.ok(labelsDrawn.includes('what now?'), 'what now? is still drawn')
// Deterministic thanks to PROJECT_CONFIG: slot 2 is overridden, slot 5 added.
assert.ok(labelsDrawn.includes('harness two'), 'the project config overrides slot 2')
assert.ok(labelsDrawn.includes('harness five'), 'and adds slot 5')
// Both files are really read, and the project one really wins. This is the
// assertion that `$.fs.readFile` could not carry: it was mocked to return the
// project fixture, so it passed on a build where the call threw and NEITHER
// file was read. Slot 3 proves the global file arrived at all; slot 2 proves
// the project beat it rather than replacing the whole list.
assert.ok(labelsDrawn.includes('global three'), 'the global config supplies slot 3')
assert.ok(!labelsDrawn.includes('global two'), 'and does not win slot 2, which the project names too')
assert.ok(hotkeysDrawn.includes('5'), 'hotkey 5 is a prompt slot now, not next-spinner')
// PROJECT_CONFIG asks for the narrow set, so this is the circle glyphs and is
// also proof that settings.pieStyle is threaded through to the render.
// Past three quarters either set draws its alarm glyph, so both checks read the
// whole table: some circle step is drawn, and no moon step is.
assert.ok(PIE_STEPS.some((s) => bandText.includes(s.circle)), 'the band draws the context pie in the configured set')
assert.ok(!PIE_STEPS.some((s) => bandText.includes(s.moon)), 'and not the default moon set, since the project overrode it')

// The vitals are ONE row now: the model, branch and diff moved up beside the
// context meter, off the second line they used to own.
const bandRows = draw2(bandTree).split('\n').filter((l) => l.trim())
const vitalsRow = bandRows.find((l) => l.includes('/'))
assert.ok(vitalsRow, 'a vitals row is drawn')
for (const piece of ['Opus 5', '⎇', '+', '−']) {
  assert.ok(vitalsRow.includes(piece), `the vitals row carries ${piece} on line one`)
}
assert.ok(bandRows.filter((l) => l.includes('⎇')).length === 1, 'the branch is drawn once, not on two rows')
// `█` alone proves nothing: it is also the top glyph of the throughput
// sparkline. The bar was 8-26 columns of block, so a RUN of them is the tell,
// as is `░`, which nothing else ever drew.
assert.ok(!bandText.includes('░'), 'no empty-bar glyph anywhere')
assert.ok(!/█{4,}/.test(bandText), 'and no run of block glyphs where the bar used to be')
console.log(`✔ band draws hotkeys ${hotkeysDrawn.join(', ')} with the spinner buttons removed`)

// Pressing a configured slot submits its prompt.
const slotButton = bandButtons.find((b) => b.hotkey && !['1', '4'].includes(b.hotkey))
if (slotButton) {
  const before = $._submitted.length
  slotButton.onPress()
  assert.equal($._submitted.length, before + 1, 'a prompt hotkey submits exactly one prompt')
  assert.ok(typeof $._submitted.at(-1).text === 'string' && $._submitted.at(-1).text.length > 0,
    'and the prompt it submits is not empty')
  console.log(`✔ pressing hotkey ${slotButton.hotkey} submits its prompt`)
} else {
  console.log('… no configured prompt slots here; press path not exercised')
}

// The Select survives: it is the whole spinner picker now.
const selects = []
const selectsIn = (node) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) selectsIn(n); return }
  if (node.tag === 'Select') selects.push(node.props ?? {})
  for (const k of node.children ?? []) selectsIn(k)
}
selectsIn(bandTree)
// PROJECT_CONFIG turns the picker on; mergeSettings' test above covers the
// default being off, which is what an unconfigured band gets.
assert.equal(selects.length, 1, 'the spinner Select renders when settings ask for it')
assert.ok(selects[0].options.length > 1, 'and it still lists every spinner')
// Neither fixture config names settings.spinner, and no $.store entry was
// ever written in this run, so resolveSpinnerId(undefined, undefined) is
// exercised for real here too: the Select's own value is the shipped
// default, not a stale or empty selection.
assert.equal(selects[0].value, 'tide', 'with no pin anywhere, the live Select shows the shipped default')
console.log('✔ the spinner picker is opt-in, and renders when opted into')

// --- auto-claim fires once per plan, and only while the relay is up ---------
// The rest of this file treats the relay as down (the http.fetch stub above
// always answers ok:false) so the plugin's offline path gets exercised. This
// stub instead answers everything ok, which flips `M.relayUp` true the next
// time boot() runs, and separately records every POST to /api/claim.
const claimCalls = []
const realFetch = $.http.fetch
$.http.fetch = async (url, init) => {
  if (url.includes('/api/claim') && init?.body) claimCalls.push(JSON.parse(init.body))
  return { status: 200, ok: true, headers: {}, text: '{}' }
}

// Re-run session.start: boot() only ever sets M.relayUp inside itself, and
// this also clears M.autoClaimed for what the plugin sees as a fresh session.
await byEvent('session.start').hook($, { cwd: process.cwd(), surface: 'terminal' }, echo)
await new Promise((r) => setTimeout(r, 300))

const planEditNext = () => Promise.resolve({ result: { text: 'ok' } })
planEditNext.signal = new AbortController().signal
planEditNext.event = 'tool.call'
planEditNext.is = (name) => name === 'tool.call'
planEditNext.origin = 'test'

await star.hook(
  $,
  { tool: 'Edit', tool_use_id: 'p1', file_path: 'docs/plans/auto-claim-test.md', old_string: 'a', new_string: 'b' },
  planEditNext,
)
await new Promise((r) => setTimeout(r, 300))
assert.equal(claimCalls.length, 1, 'the first edit of a plan claims it')
assert.deepEqual(claimCalls[0].items, [{ kind: 'plan', id: 'auto-claim-test.md' }],
  'claiming the plan just edited, kind plan only -- never a backlog entry')
assert.equal(claimCalls[0].note, 'auto: first edit', 'an automatic claim is marked as such')

await star.hook(
  $,
  { tool: 'Edit', tool_use_id: 'p2', file_path: 'docs/plans/auto-claim-test.md', old_string: 'b', new_string: 'c' },
  planEditNext,
)
await new Promise((r) => setTimeout(r, 300))
assert.equal(claimCalls.length, 1, 'a second edit of the same plan does not claim it again')
console.log('✔ a session auto-claims a plan on its first edit, and only once')

$.http.fetch = realFetch

// --- a stash reaches the relay, and a refusal is named ----------------------
// M.relayUp is still true from the block above. Every other route answers ok,
// so a heartbeat landing mid-check cannot flip the relay down underneath it.
{
  const fetchBefore = $.http.fetch
  const stashPosts = []
  let answer = { status: 200, ok: true, headers: {}, text: '{"ok":true,"index":0,"count":1}' }
  $.http.fetch = async (url, init) => {
    if (url.includes('/api/pasteboard/create') && init?.body) {
      stashPosts.push(JSON.parse(init.body))
      return answer
    }
    return { status: 200, ok: true, headers: {}, text: '{}' }
  }

  const stored = await submitPrompt({ text: ',,,@t body', origin: { kind: 'composer' } })
  assert.equal(stored.calls.length, 0, 'a stash never reaches the model')
  assert.equal(stashPosts.length, 1, 'one submission, one POST')
  assert.equal(stashPosts[0].scope, 'global', 'the triple marker files on the global board')
  assert.equal(stashPosts[0].sessionId, null, 'and a global stash carries no session id')
  assert.equal(stashPosts[0].title, 't', 'the @ word is the title')
  assert.equal(stashPosts[0].text, 'body', 'and the rest is the text, marker and title stripped')
  assert.match(stored.out?.drop ?? '', /^stashed as "t"/, 'the reason confirms the stash by its title')
  assert.match(stored.out?.drop ?? '', /on the global board/, 'and says which board')

  answer = { status: 400, ok: false, headers: {}, text: '{"error":"board full"}' }
  const full = await submitPrompt({ text: ',,,@t body', origin: { kind: 'composer' } })
  assert.match(full.out?.drop ?? '', /board is full/, "the relay's refusal is named, not collapsed into unreachable")

  $.http.fetch = fetchBefore
  $._filled.length = 0
}
console.log('✔ a typed stash posts to the relay, and a full board says so')

{
  const fetchBefore = $.http.fetch
  const posts = []
  $.http.fetch = async (url, init) => {
    if (String(url).includes('/api/skills/propose')) posts.push(JSON.parse(init.body))
    return { status: 200, ok: true, headers: {}, text: '{"ok":true}' }
  }
  const out = await star.hook($, {
    tool: 'mcp__syzygy__propose_pattern', tool_use_id: 'pp4',
    title: 'A pattern', idea: 'an idea', methodology: '1. do it', kind: 'skill',
    evidence: ['syzygy/bridge/fleet.mjs:226'], session: 'somebody-else', project: 'not-mine',
  }, findNext)
  $.http.fetch = fetchBefore
  assert.equal(typeof out.result, 'string')
  assert.equal(posts.length, 1)
  assert.notEqual(posts[0].session, 'somebody-else')
  assert.notEqual(posts[0].project, 'not-mine')
  assert.equal(posts[0].source, 'session')
  assert.deepEqual(posts[0].sessions, [posts[0].session])
  console.log('✔ propose_pattern posts the plugin\'s session and project, never the model\'s')
}

// --- the topic chain: one record per finished turn ---------------------------
// A fresh boot against a relay that answers, so the band marks it up and every
// turn field starts empty. Records the chain POSTs, the register body and the
// heartbeat's body.
{
  const fetchBefore = $.http.fetch
  const chainPosts = []
  const registers = []
  const pushes = []
  $.http.fetch = async (url, init) => {
    const u = String(url)
    const body = init?.body ? JSON.parse(init.body) : null
    if (body && u.includes('/api/chain/turn')) chainPosts.push(body)
    if (body && u.includes('/api/register')) registers.push(body)
    if (body && u.includes('/api/stats')) pushes.push(body)
    return { status: 200, ok: true, headers: {}, text: '{}' }
  }
  await byEvent('session.start').hook($, { cwd: process.cwd(), surface: 'terminal' }, echo)
  await new Promise((r) => setTimeout(r, 300))
  const turnsOf = () => chainPosts.map((p) => p.turn)

  // The transcript path, in the register body and on the heartbeat.
  assert.ok(registers.length >= 1, 'boot registered with the relay')
  assert.ok('transcript' in registers.at(-1).session, 'the register body carries a transcript key')
  assert.equal(typeof registers.at(-1).session.transcript, 'string', 'as a string, never null')
  for (const until = Date.now() + 5_000; Date.now() < until && pushes.length === 0;) {
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.ok(pushes.length >= 1, 'the heartbeat pushed stats')
  assert.ok('transcript' in pushes.at(-1), 'the heartbeat body carries a transcript key too')
  assert.equal(pushes.at(-1).transcript, transcript, 'naming the file the band reads')

  // One turn: the record's shape, both heads cut, this turn's own files.
  const longPrompt = 'p'.repeat(1000)
  // Longer than the drawer's 2048-character cap, and different at each end, so
  // an excerpt taken from the wrong end or through that cap cannot pass.
  const longAnswer = '  ' + Array.from({ length: 320 }, (_, i) => `step ${i}.`).join(' ') + '\n'
  await chainSubmit({ text: longPrompt, origin: { kind: 'composer' } })
  await startTurn(longPrompt, 'ch1')
  await star.hook($, { tool: 'Edit', tool_use_id: 'ce1', file_path: '/tmp/szg-chain-a.ts', old_string: 'a', new_string: 'b' }, planEditNext)
  await star.hook($, { tool: 'Bash', tool_use_id: 'ce2', command: 'true' }, planEditNext)
  await completeTurn('ch1', { answer: longAnswer, durationMs: 4321 })
  await settleChain()
  assert.equal(chainPosts.length, 1, 'one finished turn, one POST to /api/chain/turn')
  assert.deepEqual(Object.keys(chainPosts[0]).sort(), ['sessionId', 'token', 'turn'],
    'the body is the session id and the turn, beside the token every POST carries')
  assert.equal(chainPosts[0].sessionId, sessionId)
  const [first] = turnsOf()
  assert.deepEqual(Object.keys(first).sort(),
    ['answerHead', 'at', 'durationMs', 'files', 'id', 'origin', 'promptHead', 'reason', 'subturns', 'tools'],
    'the turn record carries exactly these fields')
  assert.equal(first.id, 'ch1', 'the id is the turn id')
  assert.equal(typeof first.at, 'number')
  assert.equal(first.durationMs, 4321)
  assert.equal(first.reason, 'answer')
  assert.equal(first.origin, 'composer')
  assert.equal(first.promptHead, longPrompt.slice(0, 400), 'the prompt head is cut at 400 characters')
  assert.ok(longAnswer.trim().length > 2048, 'the answer is longer than the drawer keeps')
  assert.equal(first.answerHead, longAnswer.trim().slice(-400),
    'the answer excerpt is the last 400 characters of the trimmed answer, where a turn says what it did')
  assert.ok(!first.answerHead.includes('…'), 'with no elision marker')
  assert.deepEqual(first.files, ['/tmp/szg-chain-a.ts'], 'the file edited during the turn')
  assert.equal(first.tools, 2, 'every tool call during the turn is counted')
  assert.equal(first.subturns, 0)

  // Two prompts queued before either turn starts: each turn reports its own
  // head and origin, in order, and its own files rather than the session's.
  chainPosts.length = 0
  await chainSubmit({ text: 'first prompt', origin: { kind: 'composer' } })
  await chainSubmit({ text: 'second prompt', origin: { kind: 'sdk' } })
  await startTurn('first prompt', 'ch2')
  await star.hook($, { tool: 'Write', tool_use_id: 'ce3', file_path: '/tmp/szg-chain-b.ts', content: 'x' }, planEditNext)
  await completeTurn('ch2')
  await startTurn('second prompt', 'ch3')
  await completeTurn('ch3')
  await settleChain()
  assert.deepEqual(turnsOf().map((t) => [t.id, t.promptHead, t.origin]),
    [['ch2', 'first prompt', 'composer'], ['ch3', 'second prompt', 'sdk']],
    'each turn reports its own prompt head and origin, in order')
  assert.deepEqual(turnsOf()[0].files, ['/tmp/szg-chain-b.ts'],
    'a turn reports the file it edited, not the one an earlier turn edited')
  assert.deepEqual(turnsOf()[1].files, [], 'and a turn that edited nothing reports no files')
  assert.equal(turnsOf()[1].tools, 0, 'nor any tool calls')

  // A prompt delivered into a running turn starts no turn of its own, and must
  // not shift the turn after it.
  chainPosts.length = 0
  await chainSubmit({ text: 'prompt A', origin: { kind: 'composer' } })
  await chainSubmit({ text: 'prompt B', origin: { kind: 'bridge' } })
  await chainSubmit({ text: 'prompt C', origin: { kind: 'sdk' } })
  await startTurn('prompt C', 'ch4')
  await completeTurn('ch4')
  await startTurn('prompt A', 'ch5')
  await completeTurn('ch5')
  await startTurn('prompt B', 'ch6')
  await completeTurn('ch6')
  await settleChain()
  assert.deepEqual(turnsOf().map((t) => [t.promptHead, t.origin]),
    [['prompt C', 'sdk'], ['prompt A', 'unknown'], ['prompt B', 'unknown']],
    'the turn for C reports C, and A and B, queued before it, were dropped with the match')

  // No match: an honest unknown, the turn's own head, and the queue untouched.
  chainPosts.length = 0
  await chainSubmit({ text: 'queued prompt', origin: { kind: 'sdk' } })
  await startTurn('rewritten on the way down', 'ch7')
  await completeTurn('ch7')
  await startTurn('queued prompt', 'ch8')
  await completeTurn('ch8')
  await startTurn('', 'ch9')
  await completeTurn('ch9')
  await settleChain()
  assert.deepEqual(turnsOf().map((t) => [t.id, t.promptHead, t.origin]), [
    ['ch7', 'rewritten on the way down', 'unknown'],
    ['ch8', 'queued prompt', 'sdk'],
    ['ch9', '', 'unknown'],
  ], 'an unmatched turn says unknown and leaves the queue alone; an empty text is an empty head')

  // The queue is capped, oldest out first.
  chainPosts.length = 0
  for (let i = 0; i < 10; i++) await chainSubmit({ text: `burst ${i}`, origin: { kind: 'bridge' } })
  await startTurn('burst 0', 'ch10')
  await completeTurn('ch10')
  await startTurn('burst 2', 'ch11')
  await completeTurn('ch11')
  await settleChain()
  assert.deepEqual(turnsOf().map((t) => t.origin), ['unknown', 'bridge'],
    'the queue keeps the newest eight prompts, so the oldest has aged out')

  // A subagent's turn is counted into its parent's record and never posted.
  chainPosts.length = 0
  await startTurn('', 'ch12')
  await completeTurn('sub1', { agentId: 'agent-1' })
  await completeTurn('sub2', { agentId: 'agent-1' })
  await settleChain()
  assert.equal(chainPosts.length, 0, "a subagent's turn posts nothing")
  await completeTurn('ch12')
  await settleChain()
  assert.equal(chainPosts.length, 1, 'the parent turn posts once')
  assert.equal(turnsOf()[0].subturns, 2, 'and reports both subagent turns')
  await startTurn('', 'ch13')
  await completeTurn('ch13')
  await settleChain()
  assert.equal(turnsOf()[1].subturns, 0, 'the count starts again at the next turn')

  // A fresh boot inherits no turn in flight.
  chainPosts.length = 0
  await chainSubmit({ text: 'before the reboot', origin: { kind: 'composer' } })
  await startTurn('before the reboot', 'ch14')
  await star.hook($, { tool: 'Edit', tool_use_id: 'ce4', file_path: '/tmp/szg-chain-c.ts', old_string: 'a', new_string: 'b' }, planEditNext)
  await completeTurn('sub3', { agentId: 'agent-2' })
  await chainSubmit({ text: 'queued before the reboot', origin: { kind: 'composer' } })
  await byEvent('session.start').hook($, { cwd: process.cwd(), surface: 'terminal' }, echo)
  await new Promise((r) => setTimeout(r, 300))
  await completeTurn('ch14')
  await startTurn('queued before the reboot', 'ch15')
  await completeTurn('ch15')
  await settleChain()
  assert.deepEqual(turnsOf().map((t) => [t.promptHead, t.origin, t.files, t.tools, t.subturns]), [
    ['', 'unknown', [], 0, 0],
    ['queued before the reboot', 'unknown', [], 0, 0],
  ], 'boot clears the running prompt, the queue, the files and both counts')

  $.http.fetch = fetchBefore
}
console.log('✔ the band posts one chain record per finished turn, heads only, matched by text')

// --- settings.spinner reaches the real band, end to end ---------------------
// A scoped fixture swap rather than adding a pin to GLOBAL_CONFIG/
// PROJECT_CONFIG above: those two are shared by every assertion in this file,
// including "the default spinner draws the wraith tide's fog" and the
// Select's own value just asserted -- layering a spinner pin onto them would
// change what those are actually testing rather than adding new coverage.
// This exercises the same resolveSpinnerId precedence through the real
// session.start -> loadHotkeys path, not just the pure function above.
const realRun = $.process.run
const PINNED_CONFIG = JSON.stringify({ settings: { spinner: 'orrery' } })
$.process.run = async (argv, init) => {
  // Project first, at either spelling: the global matcher below is an endsWith
  // on the same basename and would otherwise answer the project read as well,
  // which would pass this check on a pin the GLOBAL file never supplied.
  if (argv[0] === 'cat' &&
      (argv[1] === `${HARNESS_ROOT}/.claude/${HOTKEYS_FILE}` || argv[1] === `.claude/${HOTKEYS_FILE}`)) {
    return { exitCode: 0, stdout: '', stderr: '' } // no project override this time
  }
  if (argv[0] === 'cat' && String(argv[1]).endsWith(`/.claude/${HOTKEYS_FILE}`)) {
    return { exitCode: 0, stdout: PINNED_CONFIG, stderr: '' }
  }
  return realRun(argv, init)
}
await byEvent('session.start').hook($, { cwd: process.cwd(), surface: 'terminal' }, echo)
await new Promise((r) => setTimeout(r, 300))

const pinnedSpin = textOf(await byComponent('Spinner').hook(
  $,
  { surface: 'terminal', component: 'Spinner', requestId: 's2',
    viewport: { columns: 100, rows: 40 },
    props: { word: 'Simmering', message: null, mode: 'thinking' } },
  spinNext,
))
assert.ok(!pinnedSpin.includes('⣤'), 'settings.spinner replaces the default wraith tide with the pinned one')
assert.ok(pinnedSpin.includes('◎'), "and what plays is the pinned orrery, sun and all")
assert.ok(pinnedSpin.replace(/\s+/g, '').includes('Simmering'), 'and still keeps the turn word in its caption')
console.log('✔ settings.spinner in the global config pins the live band, through the real session.start path')

$.process.run = realRun

// --- an unusable pasteboard marker turns stashing off, and says so once -----
// The same scoped fixture swap as above, so the shared configs stay untouched.
// A letter marker would eat ordinary prompts, so it disables the feature rather
// than falling back to `,,` -- and the warning reaches the feed through the
// relay push, which is the only place a note is observable from outside.
{
  const runBefore = $.process.run
  const fetchBefore = $.http.fetch
  const BAD_MARKER_CONFIG = JSON.stringify({ settings: { pasteboardMarker: 'aa' } })
  const pushed = []
  $.process.run = async (argv, init) => {
    if (argv[0] === 'cat' &&
        (argv[1] === `${HARNESS_ROOT}/.claude/${HOTKEYS_FILE}` || argv[1] === `.claude/${HOTKEYS_FILE}`)) {
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (argv[0] === 'cat' && String(argv[1]).endsWith(`/.claude/${HOTKEYS_FILE}`)) {
      return { exitCode: 0, stdout: BAD_MARKER_CONFIG, stderr: '' }
    }
    return runBefore(argv, init)
  }
  $.http.fetch = async (url, init) => {
    if (url.includes('/api/stats') && init?.body) pushed.push(...(JSON.parse(init.body).events ?? []))
    return { status: 200, ok: true, headers: {}, text: '{}' }
  }
  await byEvent('session.start').hook($, { cwd: process.cwd(), surface: 'terminal' }, echo)

  // The config is read inside a background refresh: submit until the default
  // marker stops being honoured, which is the moment the file has landed.
  let through = null
  for (const until = Date.now() + 10_000; Date.now() < until;) {
    const probe = await submitPrompt({ text: ',,hello', origin: { kind: 'composer' } })
    if (probe.calls.length === 1) { through = probe; break }
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.ok(through, 'with an unusable marker configured, a ",," prompt passes straight through')
  assert.equal(through.out?.drop, undefined, 'and is not dropped')
  const again = await submitPrompt({ text: ',,hello', origin: { kind: 'composer' } })
  assert.equal(again.calls.length, 1, 'every time, not only the first')

  const warned = () => pushed.filter((ev) => ev.label === 'pasteboard marker ignored')
  for (const until = Date.now() + 5_000; Date.now() < until && warned().length === 0;) {
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.equal(warned().length, 1, 'the unusable marker is reported once, not once per prompt')
  assert.ok(warned()[0].detail.includes('"aa"'), 'and the report names the value it refused')

  $.process.run = runBefore
  $.http.fetch = fetchBefore
}
console.log('✔ an unusable pasteboard marker disables stashing and is reported once')

// --- SZG_HEADLESS: a relay-owned child pays for nothing --------------------
// The orchestrator's ask and blurb turns, and every scoping turn, are
// `claude -p` children of the relay. They load the installed plugin like any
// other session, so before SZG_HEADLESS existed they ran the whole boot:
// three discovery subprocesses, the relay handshake, a registration that put
// a card on the switchboard, and then a heartbeat and a command poll for as
// long as they lived -- a card named after the project, with no explanation of
// what it was.
//
// Asserted as "no HTTP at all", which is the property that matters: if the
// plugin talks to the relay even once, it is on the board.
{
  const runBefore = $.process.run
  const fetchBefore = $.http.fetch
  const argvs = []
  const fetches = []
  $.process.run = async (argv, init) => {
    argvs.push(argv)
    if (argv[0] === 'printenv' && argv[1] === 'SZG_HEADLESS') {
      return { exitCode: 0, stdout: '1\n', stderr: '' }
    }
    return runBefore(argv, init)
  }
  $.http.fetch = async (url, init) => {
    fetches.push(url)
    return { status: 200, ok: true, headers: {}, text: '{}' }
  }

  await byEvent('session.start').hook($, { cwd: process.cwd(), surface: 'terminal' }, echo)
  await new Promise((r) => setTimeout(r, 400))

  // Nor does a finished turn reach the topic chain. A headless boot never
  // clears a relay an earlier boot marked up, so when one did, the headless
  // check is the only thing keeping this silent.
  await chainSubmit({ text: 'a headless prompt', origin: { kind: 'sdk' } })
  await startTurn('a headless prompt', 'hl1')
  await star.hook($, { tool: 'Edit', tool_use_id: 'hl-e', file_path: '/tmp/szg-chain-h.ts', old_string: 'a', new_string: 'b' }, planEditNext)
  await completeTurn('hl1')
  await new Promise((r) => setTimeout(r, 100))

  assert.deepEqual(fetches, [], `a headless session made ${fetches.length} HTTP call(s): ${fetches.join(', ')}`)
  const ran = argvs.map((a) => a.join(' '))
  assert.equal(ran.filter((c) => c === 'printenv SZG_HEADLESS').length, 1,
    'the flag is read exactly once per boot')
  for (const forbidden of ['printenv SZG_RELAY_PORT', 'printenv SZG_RELAY_TOKEN']) {
    assert.ok(!ran.includes(forbidden), `a headless session still ran: ${forbidden}`)
  }
  assert.ok(!ran.some((c) => c.startsWith('tmux ')), 'a headless session probed tmux')
  console.log(`\u2714 SZG_HEADLESS: no HTTP, no relay handshake; subprocesses seen: ${[...new Set(ran)].join(' | ') || 'none'}`)

  $.process.run = runBefore
  $.http.fetch = fetchBefore
}

for (const t of $._timers) { clearInterval(t); clearTimeout(t) }
console.log('\n✔ all harness checks passed')
