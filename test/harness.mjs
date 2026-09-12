// Drives the compiled hooks module against a mock $, with real process calls
// and a real transcript, and checks its token math against an independent pass
// over the same file. Run via `just test`.

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
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

/** Stands in for `<cwd>/.claude/syzygy-hud-hotkeys.json`. Overrides slot 2,
 *  adds slot 5, turns the spinner picker on and picks the narrow pie. */
// The basename of both config files; the plugin's own HOTKEYS_FILE. Spelt once
// here because the mock $ matches on the argv that carries it.
const HOTKEYS_FILE = 'syzygy-hud-hotkeys.json'

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
const makeDollar = ({ sessionId, cwd, model }) => {
  const store = new Map()
  const timers = []
  const invalidations = []
  const registered = []
  const calls = []
  const submitted = []
  return {
    _store: store, _timers: timers, _invalidations: invalidations,
    _registered: registered, _calls: calls, _submitted: submitted,
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
        if (argv[0] === 'cat' && argv[1] === `.claude/${HOTKEYS_FILE}`) {
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
    prompt: { submit: async (p) => void submitted.push(p) },
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
const sessionId = process.argv[2]
if (!sessionId) { console.error('usage: harness.mjs <session-id>'); process.exit(2) }

const found = spawnSync('find', [`${homedir()}/.claude/projects`, '-maxdepth', '2', '-name', `${sessionId}.jsonl`], { encoding: 'utf8' })
const transcript = (found.stdout || '').split('\n').find((l) => l.trim())?.trim()
assert.ok(transcript && existsSync(transcript), `no transcript found for session ${sessionId}`)
console.log(`transcript: ${transcript}`)

const {
  register,
  modelKey, windowFor, snapWindow, windowAtLeast, derivedWindow, pie,
  parseHotkeys, mergeHotkeys, buttonWidth, fitHotkeys,
  displayWidth, fitVitals, parseSettings, mergeSettings, resolveSpinnerId, paneLabel, needsHuman,
  lastAnswerOf, planFromToolCall,
} = await import('../build/hud.js')

const hooks = []
register((...args) => {
  const hook = args[args.length - 1]
  const matcher = args.length === 3 ? args[1] : undefined
  hooks.push({ event: args[0], matcher, hook })
}, {})

const byEvent = (name) => hooks.find((x) => x.event === name)
/** There are now two ui.render hooks; pick the one for a given component. */
const byComponent = (c) => hooks.find((x) => x.event === 'ui.render' && x.matcher?.component === c)
assert.ok(byEvent('session.start'), 'session.start hook registered')
assert.ok(byEvent('*'), '* hook registered')
assert.ok(byComponent('AbovePrompt'), 'AbovePrompt render hook registered')
assert.ok(byComponent('Spinner'), 'Spinner render hook registered')
console.log(`hooks: ${hooks.map((x) => x.event).join(', ')}`)

const $ = makeDollar({ sessionId, cwd: process.cwd(), model: 'Opus 5' })
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
  ['ask_human', 'calc', 'claim_work', 'pane_event', 'recall', 'release_work', 'remember', 'think_harder'],
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
assert.equal(calcRes.result.text, '60', 'calc evaluates exactly')
console.log('✔ calc tool served by the plugin, not the engine (60)')

const badCalc = await star.hook(
  $,
  { tool: 'mcp__syzygy__calc', tool_use_id: 'c2', expression: 'process.exit(1)' },
  calcNext,
)
assert.ok(/error/.test(badCalc.result.text), 'calc refuses anything that is not arithmetic')
console.log('✔ calc refuses non-arithmetic input')

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
assert.ok(/[○◔◑◕●]/.test(narrow), 'narrow band keeps the context pie')
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
// the waxing glyphs are its mirror images and would run the wrong way.
const VS16 = '\uFE0F'
assert.equal(pie(0), '🌕' + VS16, 'an untouched context is a FULL moon -- the big set is the default')
assert.equal(pie(1), '🌑' + VS16, 'a drained context is a new moon')
assert.equal(pie(0.5), '🌗' + VS16, 'half used is the last quarter')
assert.equal(pie(0.2), '🌖' + VS16, 'a fifth used is waning gibbous, not the waxing mirror 🌔')
assert.equal(pie(0.8), '🌘' + VS16, 'four fifths used is waning crescent, not the waxing mirror 🌒')
assert.equal(pie(-1), '🌕' + VS16, 'out of range clamps full')
assert.equal(pie(9), '🌑' + VS16, 'out of range clamps empty')

// Every moon carries VARIATION SELECTOR-16. Without it the FULL moon alone
// renders as a monochrome circle wherever a symbol font that covers U+1F315 --
// and, oddly, none of the other four phases -- sits ahead of the colour emoji
// font -- an ordinary thing for a terminal's fallback chain to contain, which
// is how the quirk was found.
for (const p of [0, 0.25, 0.5, 0.75, 1]) {
  assert.ok(pie(p).endsWith(VS16), `the moon at ${p * 100}% asks for emoji presentation`)
  assert.equal(displayWidth(pie(p)), 2, 'and VS16 costs no columns')
}
assert.ok(!pie(0, 'circle').includes(VS16), 'the one-column set needs no presentation selector')
assert.equal(pie(0, 'circle'), '●', 'the narrow set runs the same way')
assert.equal(pie(1, 'circle'), '○', 'so switching pieStyle never inverts the reading')

// Monotonic, and a guard against anyone "correcting" it back to a filling pie.
const ramp = [0, 0.25, 0.5, 0.75, 1].map((p) => pie(p, 'circle'))
assert.deepEqual(ramp, ['●', '◕', '◑', '◔', '○'], 'the circle set empties as context fills')
assert.equal(new Set(ramp).size, 5, 'and every step is a distinct glyph')
console.log('✔ the context pie is a depletion gauge: full at 0%, empty at 100%')

// A moon is ONE code point and TWO columns. Everything that measures the row
// has to ask displayWidth, or the vitals row is budgeted a column short per
// pie and quietly overflows.
assert.equal(displayWidth('🌖'), 2, 'a moon glyph is two columns wide')
assert.equal('🌖'.length, 2, '...and two UTF-16 units, which is a different number by luck')
assert.equal(displayWidth('○'), 1, 'the narrow pie is one column')
assert.equal(displayWidth('⎇ develop*'), 10, 'the band\'s other non-ASCII is single-width')
assert.equal(displayWidth('↑1.2M ↓3k'), 9, 'so are the arrows')
assert.equal(displayWidth('🌖 316k'), 7, 'mixed content adds up')
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
assert.ok(/[○◔◑◕●]/.test(bandText), 'the band draws the context pie in the configured set')
assert.ok(!/[🌕🌖🌗🌘🌑]/u.test(bandText), 'and not the default moon set, since the project overrode it')

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
  if (argv[0] === 'cat' && String(argv[1]).endsWith(`/.claude/${HOTKEYS_FILE}`)) {
    return { exitCode: 0, stdout: PINNED_CONFIG, stderr: '' }
  }
  if (argv[0] === 'cat' && argv[1] === `.claude/${HOTKEYS_FILE}`) {
    return { exitCode: 0, stdout: '', stderr: '' } // no project override this time
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
