// Drives the forge hooks module against a mock $. Modelled on test/harness.mjs.
//
// It compiles forge/hooks/forge.tsx to plain JS in a temp directory (nothing in
// the repo is written), supplies the JSX globals and a mock $, calls register(),
// and drives the hooks directly.
//
// The load-bearing check is the restart: the module is imported a SECOND time,
// fresh, and given a new $ that shares the first one's backing store. Its
// session.start hook must put every forged tool back in the listing with no
// create_tool call in between — that is what makes a forged tool a durable
// skill rather than a session trick.
//
//   node test/forge-harness.mjs

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// --- JSX runtime the module was compiled against -----------------------------
// forge draws nothing, but the compiler targets h/Fragment all the same.
globalThis.h = (tag, props, ...children) => ({ tag, props: props ?? {}, children: children.flat() })
globalThis.Fragment = 'Fragment'

// --- compile -----------------------------------------------------------------
const out = mkdtempSync(join(tmpdir(), 'forge-harness-'))
const tsc = spawnSync(
  join(ROOT, 'node_modules/.bin/tsc'),
  [
    '--target', 'es2023', '--lib', 'es2023', '--module', 'esnext',
    '--moduleResolution', 'bundler', '--strict', '--skipLibCheck',
    '--jsx', 'react', '--jsxFactory', 'h', '--jsxFragmentFactory', 'Fragment',
    '--outDir', out,
    join(ROOT, '.claude/types/claude-code.d.ts'),
    join(ROOT, '.claude/types/claude-code-mcp.d.ts'),
    join(ROOT, 'forge/hooks/forge.tsx'),
  ],
  { encoding: 'utf8' },
)
assert.equal(tsc.status, 0, `tsc failed:\n${tsc.stdout}${tsc.stderr}`)
const built = join(out, 'forge.js')
assert.ok(existsSync(built), `no compiled module at ${built}`)
console.log(`compiled: forge/hooks/forge.tsx → ${built}`)

// --- the mock $ --------------------------------------------------------------

/** The tools the mock session already has, as $.tool.list() reports them. */
const SESSION_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Task']

const makeDollar = ({ store, cwd = '/tmp/proj', repo = null }) => {
  const registered = []
  const calls = []
  const logs = []
  const d = {
    _store: store, _registered: registered, _calls: calls, _logs: logs,
    // Set to a function to steer what a step's $.tool.call answers.
    _respond: null,
    tool: {
      list: async () => [
        ...SESSION_TOOLS.map((name) => ({ name, description: name, mcp: false })),
        ...registered.map((t) => ({ name: `mcp__forge__${t.name}`, description: t.description, mcp: true })),
      ],
      register: async (t) => {
        const i = registered.findIndex((r) => r.name === t.name)
        if (i >= 0) registered.splice(i, 1)
        registered.push(t)
        return { tool: `mcp__forge__${t.name}` }
      },
      call: async (input) => {
        calls.push(input)
        if (d._respond) return d._respond(input, calls.length)
        return { ref: 1, result: { ok: true }, text: `ran ${input.tool}` }
      },
    },
    store: {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, JSON.parse(JSON.stringify(v))),
      delete: async (k) => void store.delete(k),
      keys: async () => [...store.keys()],
    },
    session: {
      id: async () => 'sess-1',
      cwd: async () => cwd,
      model: async () => 'Opus 5',
      surface: async () => 'terminal',
      repo: async () => repo,
      turnCount: async () => 1,
      messages: async () => [],
    },
    clock: {
      now: () => 1_760_000_000_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      after: (ms, fn) => ({ cancel: () => clearTimeout(setTimeout(fn, ms)) }),
      every: () => ({ cancel: () => {} }),
    },
    ui: {
      log: (t) => void logs.push(t),
      status: () => {}, toast: () => {}, notice: () => {},
      invalidate: () => {}, ask: async () => '', resolve: async () => ({}),
    },
    // Present so a stray call would be visible rather than a TypeError; the
    // validator's call inventory already proves forge touches none of them.
    model: { complete: async () => assert.fail('forge must make no model calls') },
    fs: { readFile: async () => assert.fail('forge must not touch $.fs') },
    http: { fetch: async () => assert.fail('forge must not touch $.http') },
    process: { run: async () => assert.fail('forge must not touch $.process') },
    agent: { list: async () => [], spawn: async () => ({}) },
    mcp: { call: async () => ({ content: [] }) },
    prompt: { submit: async () => ({}) },
    turn: { abort: async () => {} },
    audio: { play: async () => {}, speak: async () => ({}) },
  }
  return d
}

// --- driving the hooks -------------------------------------------------------

const nextFor = (event, impl) => {
  const fn = impl ?? ((e) => Promise.resolve(e))
  fn.signal = new AbortController().signal
  fn.event = event
  fn.is = (name) => name === event
  fn.origin = 'test'
  return fn
}

/** Imports the module fresh; a new query string defeats the module cache, so a
 *  second load is a genuine restart with no module-scope state carried over. */
const loadRegister = async (tag) => (await import(`${pathToFileURL(built).href}?load=${tag}`)).register

const collect = (register) => {
  const hooks = []
  register((...args) => {
    hooks.push({
      event: args[0],
      matcher: args.length === 3 ? args[1] : undefined,
      hook: args[args.length - 1],
    })
  }, {})
  return {
    all: hooks,
    of: (event) => {
      const found = hooks.find((x) => x.event === event)
      assert.ok(found, `${event} hook registered`)
      return found.hook
    },
  }
}

const boot = async ($, hooks) =>
  hooks.of('session.start')($, { cwd: '/tmp/proj', surface: 'terminal', interactive: true }, nextFor('session.start'))

/** Calls one of forge's tools the way the engine would, with a `next` that
 *  fails: a plugin tool the engine sees is a plugin tool the hook did not
 *  answer, and a call no hook answers fails. */
const callForge = async ($, hooks, name, args) => {
  const next = nextFor('tool.call', () =>
    Promise.reject(new Error(`the engine must never see mcp__forge__${name}`)),
  )
  const res = await hooks.of('tool.call')(
    $,
    { tool: `mcp__forge__${name}`, tool_use_id: `t-${name}`, ...args },
    next,
  )
  assert.ok(res && res.result && typeof res.result.text === 'string', 'forge answers with { result: { text } }')
  return res.result.text
}

const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)

// =============================================================================

const store = new Map()

// --- 1. session.start registers the built-ins --------------------------------
section('session.start')
const register1 = await loadRegister('one')
const hooks1 = collect(register1)
assert.deepEqual(hooks1.all.map((h) => h.event).sort(), ['session.start', 'tool.call'], 'hooks registered')
console.log(`hooks: ${hooks1.all.map((h) => h.event).join(', ')}`)

const $1 = makeDollar({ store, cwd: '/tmp/proj' })
await boot($1, hooks1)
assert.deepEqual(
  $1._registered.map((t) => t.name).sort(),
  ['create_tool', 'forget_tool', 'json_query', 'list_tools', 'regex_test', 'text_diff'],
  'built-in tools registered at session.start',
)
console.log(`✔ built-ins registered: ${$1._registered.map((t) => t.name).sort().join(', ')}`)

// A tool that is not forge's passes down the chain untouched.
const passed = await hooks1.of('tool.call')(
  $1,
  { tool: 'Bash', tool_use_id: 'b1', command: 'ls' },
  nextFor('tool.call'),
)
assert.equal(passed.tool, 'Bash', 'a non-forge tool call is passed to next(e)')
console.log('✔ non-forge tool calls pass through')

// --- 2. create_tool registers and persists -----------------------------------
section('create_tool')
const created = await callForge($1, hooks1, 'create_tool', {
  name: 'verify_file',
  description: 'Read a file and typecheck the project against it.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, secs: { type: 'number' } },
    required: ['path', 'secs'],
  },
  steps: [
    { tool: 'Read', args: { file_path: '{{path}}' } },
    { tool: 'Bash', args: { command: 'just check --for {{path}}', timeout: '{{secs}}' } },
  ],
})
console.log(created)
assert.match(created, /Forged mcp__forge__verify_file\./, 'create_tool returns the full name')
assert.ok(
  $1._registered.some((t) => t.name === 'verify_file'),
  'create_tool called $.tool.register',
)
const stored = store.get('forge:tools:/tmp/proj')
assert.ok(stored && stored.verify_file, 'the definition is persisted under the project key')
assert.equal(stored.verify_file.steps.length, 2, 'both steps persisted')
assert.deepEqual([...store.keys()], ['forge:tools:/tmp/proj'], 'store is keyed by project, nothing else written')
console.log('✔ create_tool registered, and persisted under forge:tools:/tmp/proj')

// --- 3. a restart re-registers it, unasked -----------------------------------
section('restart')
const register2 = await loadRegister('two') // a fresh module: no state carried over
const hooks2 = collect(register2)
const $2 = makeDollar({ store, cwd: '/tmp/proj' }) // same backing store, new session
await boot($2, hooks2)
assert.ok(
  $2._registered.some((t) => t.name === 'verify_file'),
  'session.start re-registered the forged tool with no create_tool call',
)
assert.equal($2._calls.length, 0, 'the restart called no tools of its own')
assert.match($2._logs.join('\n'), /re-registered 1 forged tool/, 'and said so')
const restoredSpec = $2._registered.find((t) => t.name === 'verify_file')
assert.match(restoredSpec.description, /Read a file and typecheck/, 'the model reads the forged description')
assert.match(restoredSpec.description, /Read → Bash/, 'and the sequence it will run')
assert.deepEqual(restoredSpec.inputSchema.required, ['path', 'secs'], 'and its input schema')
console.log('✔ a second register() re-registered mcp__forge__verify_file from the store, unasked')

// --- 4. running it substitutes {{params}} and calls in order ------------------
section('running a forged tool')
const ran = await callForge($2, hooks2, 'verify_file', { path: 'README.md', secs: 30 })
console.log(ran)
assert.deepEqual(
  $2._calls.map((c) => c.tool),
  ['Read', 'Bash'],
  '$.tool.call ran the steps in order',
)
assert.equal($2._calls[0].file_path, 'README.md', 'a whole-value {{param}} is substituted')
assert.equal($2._calls[1].command, 'just check --for README.md', 'an embedded {{param}} is substituted')
assert.equal($2._calls[1].timeout, 30, 'a whole-value {{param}} keeps its type (number, not "30")')
assert.match(ran, /all ok/, 'the transcript reports success')
assert.match(ran, /--- output of step 2 \(Bash\) ---\nran Bash/, 'and ends with the last step output')
assert.equal(store.get('forge:tools:/tmp/proj').verify_file.runs, 1, 'the run counter persisted')
console.log('✔ steps ran in order with {{params}} substituted, transcript + last output returned')

// --- 5. a failing step stops the run and says which ---------------------------
section('a failing step')
const $3 = makeDollar({ store, cwd: '/tmp/proj' })
const hooks3 = collect(await loadRegister('three'))
await boot($3, hooks3)
await callForge($3, hooks3, 'create_tool', {
  name: 'three_step',
  description: 'Three steps, for the failure path.',
  inputSchema: { type: 'object', properties: {} },
  steps: [
    { tool: 'Read', args: { file_path: 'a.md' } },
    { tool: 'Bash', args: { command: 'just check' } },
    { tool: 'Write', args: { file_path: 'b.md', content: 'x' } },
  ],
})
$3._calls.length = 0
$3._respond = (input) => (input.tool === 'Bash' ? { deny: 'permission refused' } : { result: {}, text: 'ok' })
const failed = await callForge($3, hooks3, 'three_step', {})
console.log(failed)
assert.match(failed, /FAILED at step 2 of 3 \(Bash\)/, 'names the failing step')
assert.match(failed, /3 Write — not run/, 'and says the rest did not run')
assert.match(failed, /permission refused/, 'and passes the reason through')
assert.deepEqual($3._calls.map((c) => c.tool), ['Read', 'Bash'], 'step 3 was never called')
$3._respond = null
console.log('✔ stops at the first failing step and reports which one')

// --- 6. creation-time rejections ---------------------------------------------
section('rejections at creation')
const before6 = JSON.stringify(store.get('forge:tools:/tmp/proj'))
const registeredBefore6 = $3._registered.length

const unknownStep = await callForge($3, hooks3, 'create_tool', {
  name: 'bad_step',
  description: 'Names a tool that does not exist.',
  inputSchema: { type: 'object', properties: {} },
  steps: [{ tool: 'Read', args: { file_path: 'a.md' } }, { tool: 'Teleport', args: {} }],
})
console.log(unknownStep)
assert.match(unknownStep, /step 2 names "Teleport", which is not a tool in this session/, 'unknown tool rejected')
assert.match(unknownStep, /Nothing was created/, 'and nothing was created')

const ownTool = await callForge($3, hooks3, 'create_tool', {
  name: 'recursive',
  description: 'Tries to call one of forge\'s own tools.',
  inputSchema: { type: 'object', properties: {} },
  steps: [{ tool: 'mcp__forge__verify_file', args: {} }],
})
assert.match(ownTool, /one of forge's own tools/, "forge's own tools are refused as steps")

const badName = await callForge($3, hooks3, 'create_tool', {
  name: 'Bad-Name',
  description: 'An invalid name.',
  steps: [{ tool: 'Read', args: {} }],
})
assert.match(badName, /is not a usable name/, 'the name pattern is enforced')

const undeclared = await callForge($3, hooks3, 'create_tool', {
  name: 'loose_param',
  description: 'Uses a placeholder it never declares.',
  inputSchema: { type: 'object', properties: {} },
  steps: [{ tool: 'Read', args: { file_path: '{{nowhere}}' } }],
})
assert.match(undeclared, /use \{\{nowhere\}\}/, 'an undeclared placeholder is rejected')

const tooMany = await callForge($3, hooks3, 'create_tool', {
  name: 'too_many',
  description: 'More steps than the cap allows.',
  steps: Array.from({ length: 13 }, () => ({ tool: 'Read', args: { file_path: 'a.md' } })),
})
assert.match(tooMany, /the cap is 12/, 'the 12-step cap is enforced')

assert.equal(JSON.stringify(store.get('forge:tools:/tmp/proj')), before6, 'no rejected tool reached the store')
assert.equal($3._registered.length, registeredBefore6, 'and none reached $.tool.register')
console.log('✔ unknown tool, own tool, bad name, undeclared placeholder and >12 steps all rejected cleanly')

// --- 7. list_tools and forget_tool -------------------------------------------
section('list_tools / forget_tool')
const listed = await callForge($3, hooks3, 'list_tools', {})
console.log(listed)
assert.match(listed, /2 tools forged for \/tmp\/proj/, 'lists this project\'s tools')
assert.match(listed, /mcp__forge__verify_file — Read a file and typecheck/, 'with descriptions')
assert.match(listed, /2 steps, run 1×, parameters: path, secs/, 'with step counts and parameters')

const forgot = await callForge($3, hooks3, 'forget_tool', { name: 'three_step' })
assert.match(forgot, /Forgot mcp__forge__three_step/, 'forget_tool removes one')
assert.equal(store.get('forge:tools:/tmp/proj').three_step, undefined, 'and it leaves the store')
const gone = await callForge($3, hooks3, 'three_step', {})
assert.match(gone, /no longer exists for this project/, 'calling a forgotten tool explains itself')
console.log('✔ list_tools reads the project, forget_tool removes one')

// --- 8. the key follows the repository, not the session ----------------------
section('project scope')
const repoStore = new Map()
const $repo = makeDollar({
  store: repoStore,
  cwd: '/tmp/proj/packages/app',
  repo: { root: '/tmp/repo', remote: null, internal: false, name: null },
})
const hooksRepo = collect(await loadRegister('four'))
await boot($repo, hooksRepo)
await callForge($repo, hooksRepo, 'create_tool', {
  name: 'repo_scoped',
  description: 'Stored against the repository root.',
  inputSchema: { type: 'object', properties: {} },
  steps: [{ tool: 'Read', args: { file_path: 'a.md' } }],
})
assert.deepEqual([...repoStore.keys()], ['forge:tools:/tmp/repo'], '$.session.repo() wins over $.session.cwd()')
console.log('✔ tools are keyed by the repository root when there is one, the cwd otherwise')

// --- 9. json_query -----------------------------------------------------------
section('json_query')
const doc = JSON.stringify({
  users: [{ name: 'ada', tags: ['x', 'y'] }, { name: 'bob' }],
  meta: { 'odd key': { value: 42 } },
})
assert.equal(await callForge($3, hooks3, 'json_query', { json: doc, path: 'users[0].tags[1]' }), '"y"')
assert.equal(await callForge($3, hooks3, 'json_query', { json: doc, path: 'users[-1].name' }), '"bob"')
assert.equal(await callForge($3, hooks3, 'json_query', { json: doc, path: '$.meta["odd key"].value' }), '42')
const miss = await callForge($3, hooks3, 'json_query', { json: doc, path: 'users[0].email' })
console.log(miss)
assert.match(miss, /no "email" at users\[0\]\. The keys there are: name, tags\./, 'a miss names the keys that were there')
const badJson = await callForge($3, hooks3, 'json_query', { json: '{oops', path: 'a' })
assert.match(badJson, /not valid JSON/, 'invalid JSON is an error string, not a throw')
console.log('✔ json_query walks paths, handles negative indexes and quoted keys, explains misses')

// --- 10. regex_test ----------------------------------------------------------
section('regex_test')
const rx = await callForge($3, hooks3, 'regex_test', {
  pattern: '(\\w+)@(\\w+)\\.com',
  flags: 'g',
  text: 'ada@example.com and bob@test.com',
})
console.log(rx)
assert.match(rx, /— 2 matches/, 'reports every match under the g flag')
assert.match(rx, /1\. index 0-15 "ada@example\.com"/, 'with the match and its span')
assert.match(rx, /\$1 \[0-3\] "ada"/, 'and each capture group with its indices')
assert.match(rx, /\$2 \[4-11\] "example"/, 'group 2')
assert.match(rx, /2\. index 20-32 "bob@test\.com"/, 'the second match')

const named = await callForge($3, hooks3, 'regex_test', {
  pattern: '(?<key>\\w+)=(?<val>\\d+)',
  text: 'timeout=30 retries=2',
})
assert.match(named, /\?<key> "timeout"/, 'named groups are reported')
assert.match(named, /first match/, 'without g, only the first match')

const noMatch = await callForge($3, hooks3, 'regex_test', { pattern: 'zzz', text: 'abc' })
assert.match(noMatch, /no match\./, 'a clean miss')

const malformed = await callForge($3, hooks3, 'regex_test', { pattern: '([unclosed', text: 'abc' })
console.log(malformed)
assert.match(malformed, /^regex_test: invalid pattern/, 'a malformed pattern is an error string')
assert.doesNotMatch(malformed, /forge__regex_test failed/, 'and was never allowed to throw')

const tooLong = await callForge($3, hooks3, 'regex_test', { pattern: '(a+)+$', text: 'a'.repeat(200_001) })
assert.match(tooLong, /the cap is 200000/, 'the text cap guards catastrophic backtracking')
console.log('✔ regex_test: matches, groups, named groups, misses, invalid patterns, length cap')

// --- 11. text_diff -----------------------------------------------------------
section('text_diff')
const diff = await callForge($3, hooks3, 'text_diff', {
  before: 'one\ntwo\nthree\nfour\nfive',
  after: 'one\ntwo\nTHREE\nfour\nfive',
})
console.log(diff)
assert.equal(
  diff,
  [
    '--- before',
    '+++ after',
    '@@ -1,5 +1,5 @@',
    ' one',
    ' two',
    '-three',
    '+THREE',
    ' four',
    ' five',
    '1 insertion(+), 1 deletion(-)',
  ].join('\n'),
  'unified diff, exactly',
)
assert.match(
  await callForge($3, hooks3, 'text_diff', { before: 'same', after: 'same' }),
  /identical/,
  'identical texts say so',
)
const far = await callForge($3, hooks3, 'text_diff', {
  before: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'),
  after: [...Array.from({ length: 30 }, (_, i) => `line ${i}`).slice(0, 10), 'inserted', ...Array.from({ length: 30 }, (_, i) => `line ${i}`).slice(10)].join('\n'),
})
assert.match(far, /@@ -8,6 \+8,7 @@/, 'one hunk, three context lines either side of the change')
assert.match(far, /\+inserted/, 'the inserted line')
assert.match(far, /1 insertion\(\+\), 0 deletions\(-\)/, 'and the summary')
console.log('✔ text_diff produces unified output with context and a summary')

// --- done --------------------------------------------------------------------
rmSync(out, { recursive: true, force: true })
console.log('\n✔ all forge harness checks passed')
