// Drives the syzygy-editor hooks module against a mock $. Modelled on
// test/forge-harness.mjs.
//
// It compiles syzygy-editor/hooks/editor.tsx to plain JS in a temp directory
// (nothing in the repo is written), supplies the JSX globals and a mock $,
// calls register(), and drives the hooks directly.
//
// The load-bearing checks:
//
//   · the reference regex refuses what it must (`e.g.`, `v1.2`, a URL) while
//     catching backticked, `path:line`, absolute and relative forms;
//   · the EXISTENCE filter is what decides, with an injected fs, so a token
//     that merely looks like a path never becomes a button;
//   · the parse is memoised — two renders of one text parse ONCE, which is the
//     whole reason this hook can run ~10×/s per message;
//   · the render tree holds no null child (the engine silently replaces a tree
//     that does not validate, so a harness is the only place this is visible);
//   · the script's argument handling, through its own --dry-run.
//
//   node test/syzygy-editor-harness.mjs

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'syzygy-editor/bin/syzygy-edit')

let checks = 0
const ok = (msg) => { checks++; console.log(`  ✔ ${msg}`) }
const section = (name) => console.log(`\n--- ${name} ---`)

// --- JSX runtime the module was compiled against -----------------------------
globalThis.h = (tag, props, ...children) => ({
  tag: typeof tag === 'function' ? tag.elementName : String(tag),
  props: props ?? {},
  children: children.flat(),
})
globalThis.Fragment = 'Fragment'

// --- compile -----------------------------------------------------------------
const out = mkdtempSync(join(tmpdir(), 'szg-editor-harness-'))
const tsc = spawnSync(
  join(ROOT, 'node_modules/.bin/tsc'),
  [
    '--target', 'es2023', '--lib', 'es2023', '--module', 'esnext',
    '--moduleResolution', 'bundler', '--strict', '--skipLibCheck',
    '--jsx', 'react', '--jsxFactory', 'h', '--jsxFragmentFactory', 'Fragment',
    '--outDir', out,
    join(ROOT, '.claude/types/claude-code.d.ts'),
    join(ROOT, '.claude/types/claude-code-mcp.d.ts'),
    join(ROOT, 'syzygy-editor/hooks/editor.tsx'),
  ],
  { encoding: 'utf8' },
)
assert.equal(tsc.status, 0, `tsc failed:\n${tsc.stdout}${tsc.stderr}`)
const built = join(out, 'editor.js')
assert.ok(existsSync(built), `no compiled module at ${built}`)
console.log(`compiled: syzygy-editor/hooks/editor.tsx → ${built}`)

const mod = await import(pathToFileURL(built).href)
const {
  scanRefs, resolvePath, expandTilde, looksLikePath, parseConfig, editArgv, attachPaneFor,
  label, styleSpans, DEFAULTS, RELATIVE_PATH_RULE, state,
} = mod

const CWD = '/proj'
const HOME = '/home/dev'

// --- 1. the reference regex --------------------------------------------------
section('reference detection')

const paths = (text) => scanRefs(text, CWD, HOME).map((r) => r.rel)

assert.deepEqual(
  paths('The files are src/app/util.js and src/lib/util.js here.'),
  ['src/app/util.js', 'src/lib/util.js'],
  'two relative paths, both kept, in order',
)
ok('relative paths with the same basename are two distinct references')

assert.deepEqual(paths('see `src/lib/util.js` for it'), ['src/lib/util.js'], 'backticked')
ok('a backticked path is found (the backtick is not a path character)')

const withLine = scanRefs('fails at src/app/util.js:42 today', CWD, HOME)
assert.equal(withLine.length, 1)
assert.equal(withLine[0].rel, 'src/app/util.js')
assert.equal(withLine[0].line, 42)
ok('`path:line` splits into a path and a line')

const withCol = scanRefs('at src/a.ts:12:7 exactly', CWD, HOME)
assert.equal(withCol[0].rel, 'src/a.ts')
assert.equal(withCol[0].line, 12)
ok('`path:line:col` keeps the line and drops the column')

assert.deepEqual(paths('open /etc/hosts now'), ['/etc/hosts'], 'absolute')
assert.equal(scanRefs('open /etc/hosts now', CWD, HOME)[0].abs, '/etc/hosts')
ok('an absolute path resolves to itself, not under the working directory')

const tildeRef = scanRefs('look at ~/.claude/settings.json', CWD, HOME)[0]
assert.equal(tildeRef.abs, `${HOME}/.claude/settings.json`, 'the existence check sees the expanded path')
assert.equal(
  tildeRef.rel, `${HOME}/.claude/settings.json`,
  'and so does the argv (.rel) -- never the literal ~, which nothing downstream expands',
)
ok('a leading ~ is expanded ONCE, at extraction, so the check and the argv see the same absolute path')

const tildeLine = scanRefs('fails at ~/x.json:7 today', CWD, HOME)[0]
assert.equal(tildeLine.abs, `${HOME}/x.json`)
assert.equal(tildeLine.rel, `${HOME}/x.json`)
assert.equal(tildeLine.line, 7)
ok('a ~-relative path:line reference is still expanded, and still carries its line')

assert.equal(expandTilde(HOME, '~'), HOME, 'bare ~')
assert.equal(expandTilde(HOME, '~/a/b.ts'), `${HOME}/a/b.ts`, '~/ prefix')
assert.equal(expandTilde(HOME, '$HOME'), HOME, 'bare $HOME')
assert.equal(expandTilde(HOME, '$HOME/a/b.ts'), `${HOME}/a/b.ts`, '$HOME/ prefix')
assert.equal(expandTilde(HOME, '~user/x.json'), '~user/x.json', '~user/... is left alone, not supported')
ok('expandTilde covers ~, ~/, $HOME and $HOME/ and leaves ~user/... untouched')

assert.deepEqual(paths('open ~user/x.json now'), ['~user/x.json'], 'left alone -- not a supported form')
assert.equal(
  scanRefs('open ~user/x.json now', CWD, HOME)[0].abs, `${CWD}/~user/x.json`,
  'so it resolves under the cwd, where a literal ~user dir will not exist -- never boxed',
)
ok('~user/... is not expanded, so it is never boxed unless a literal ~user directory exists')

assert.deepEqual(paths('see README.md'), ['README.md'], 'bare filename with a real extension')
ok('a slashless name with a real extension is a candidate')

// the false positives
for (const [text, why] of [
  ['this is e.g. a thing', 'e.g. — a one-character extension'],
  ['upgraded to v1.2 today', 'v1.2 — an extension starting with a digit'],
  ['build 2.1.269 of the CLI', '2.1.269 — same'],
  ['i.e. nothing at all', 'i.e.'],
]) {
  assert.deepEqual(paths(text), [], why)
}
ok('e.g. / i.e. / v1.2 / 2.1.269 are refused with no word list')

assert.deepEqual(paths('see https://example.com/src/app/util.js for it'), [], 'a URL')
assert.deepEqual(paths('at http://localhost:4317/api/state now'), [], 'a localhost URL')
ok("a URL's path half never becomes a reference (URLs are masked before scanning)")

const trailing = scanRefs('it lives in src/app/util.js. Then more.', CWD, HOME)
assert.equal(trailing[0].rel, 'src/app/util.js', 'the sentence stop is not part of the path')
assert.deepEqual(paths('(see src/a.ts), yes'), ['src/a.ts'], 'brackets and commas shed')
ok('trailing prose punctuation is shed')

assert.equal(scanRefs('src/a.ts and src/a.ts again', CWD, HOME).length, 1)
ok('the same path twice in one message is one reference')

assert.equal(scanRefs(Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`).join(' '), CWD, HOME).length, 12)
ok('a listing is capped at 12 references')

assert.equal(resolvePath(CWD, HOME, './a/../b/c.ts'), '/proj/b/c.ts')
assert.equal(looksLikePath('a//b'), false, 'a doubled slash is not a path here')
ok('resolvePath collapses . and .. ; looksLikePath refuses //')

const indices = scanRefs('x src/a.ts y', CWD, HOME)[0]
assert.equal('x src/a.ts y'.slice(indices.start, indices.end), 'src/a.ts')
ok('start/end index the ORIGINAL text, so the inline renderer can cut on them')

// --- 1b. attachPaneFor ---------------------------------------------------------
section('attachPaneFor: finding the pane a claude attach is running from')

// A `claude --bg` session's own process has neither TMUX nor TMUX_PANE
// Its user is watching through a SEPARATE `claude attach
// <id>` process, itself in a tmux pane. attachPaneFor is how that pane is
// found from `tmux list-panes -a -F '#{pane_id}\t#{pane_start_command}\t#{pane_current_command}'`.
const SID = 'ab12cd34-e5f6-7890-abcd-fullsessionid'
const SHORT = SID.slice(0, 8)
const panesOf = (...rows) => rows.map((r) => r.join('\t')).join('\n')

assert.equal(
  attachPaneFor(SID, panesOf(['%1', '/bin/bash', 'zsh'], ['%2', `/usr/local/bin/claude attach ${SHORT}`, 'nvim'])),
  '%2',
  "matches the 8-char short id, the form canvas.mjs's attachArgv spells",
)
ok('a single matching attach pane is found by its short id')

assert.equal(
  attachPaneFor(SID, panesOf(['%3', `claude attach ${SID}`, 'nvim'])),
  '%3',
  'matches the full session id too',
)
ok('the full session id form matches as well as the short one')

assert.equal(
  attachPaneFor(SID, panesOf(['%4', `claude attach ${SHORT}`, 'nvim'], ['%9', `claude attach ${SHORT}`, 'nvim'])),
  '%9',
  'a repeat attach always new-windows (attachArgv), so the LAST match sorts most-recent',
)
ok('several matching panes: the last one in list-panes -a order wins')

assert.equal(
  attachPaneFor(SID, panesOf(['%1', '/bin/bash', 'zsh'], ['%2', 'claude attach deadbeef', 'nvim'])),
  '',
  'no pane is running an attach for THIS session',
)
ok('no matching attach pane is an empty string, not a throw')

assert.equal(attachPaneFor(SID, ''), '', 'an empty listing is also no pane')
ok('an empty pane listing resolves to no pane')

// --- 2. the mock $ -----------------------------------------------------------
section('driving the hooks')

/** The terminal element table $.ui.resolve hands out. Each constructor is a
 *  named function so the JSX factory above can record which element it was. */
const elementTable = () => {
  const t = {}
  for (const name of ['Box', 'Text', 'Button', 'Link', 'Input', 'Select', 'div', 'span', 'b']) {
    const f = (props) => ({ type: name, props })
    f.elementName = name
    t[name] = f
  }
  return t
}

const makeDollar = ({
  files, cwd = CWD, home = HOME, now = () => 1000,
  sessionId = 'sess-1', tmuxPane = '%7', panesListing = '',
}) => {
  const runs = []
  const toasts = []
  const store = new Map()
  const registered = []
  const existsCalls = []
  return {
    _runs: runs, _toasts: toasts, _store: store, _registered: registered, _existsCalls: existsCalls,
    plugin: { name: 'syzygy-editor', root: '/plugins/syzygy-editor' },
    session: { cwd: async () => cwd, id: () => sessionId },
    fs: {
      exists: async (p) => { existsCalls.push(p); return files.has(p) },
    },
    clock: { now },
    store: { set: async (k, v) => { store.set(k, v) }, get: async (k) => store.get(k) },
    tool: { register: async (t) => { registered.push(t); return { tool: `mcp__syzygy-editor__${t.name}` } } },
    ui: {
      resolve: async () => elementTable(),
      toast: (text) => toasts.push(text),
      log: () => {},
    },
    process: {
      run: async (argv) => {
        runs.push(argv)
        if (argv[0] === 'printenv' && argv[1] === 'HOME') return { exitCode: 0, stdout: `${home}\n`, stderr: '' }
        if (argv[0] === 'printenv' && argv[1] === 'TMUX_PANE') {
          // A `claude --bg` session's own process has no TMUX_PANE: printenv
          // on an unset variable exits 1 with nothing on stdout.
          return tmuxPane === '' ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: `${tmuxPane}\n`, stderr: '' }
        }
        if (argv[0] === 'tmux' && argv[1] === 'list-panes') return { exitCode: 0, stdout: panesListing, stderr: '' }
        if (argv[0] === 'cat') return { exitCode: 1, stdout: '', stderr: 'no such file' }
        return { exitCode: 0, stdout: 'opened %9\n', stderr: '' }
      },
    },
  }
}

const collect = () => {
  const hooks = []
  const on = (event, a, b) => hooks.push({ event, matcher: b ? a : null, hook: b ?? a })
  mod.register(on, {})
  return hooks
}

const hookFor = (hooks, event) => {
  const found = hooks.find((h) => h.event === event)
  assert.ok(found, `no ${event} hook registered`)
  return found.hook
}

const hooks = collect()
assert.deepEqual(
  hooks.map((h) => h.event),
  ['session.start', 'prompt.context', 'turn.complete', 'tool.call', 'ui.render'],
  'the five hooks, in order',
)
ok('register() adds exactly the five hooks the validator reports')

const FILES = new Set(['/proj/src/app/util.js', '/proj/src/lib/util.js', '/proj/README.md'])
const $ = makeDollar({ files: FILES })

// session.start: discovery and the tool
const next = async (e) => e
await hookFor(hooks, 'session.start')($, { cwd: CWD }, next)
assert.equal(state.cwd, CWD)
assert.equal(state.home, HOME)
assert.equal(state.pane, '%7', 'the session pane came from TMUX_PANE')
assert.equal(state.script, '/plugins/syzygy-editor/bin/syzygy-edit', '$.plugin.root, no symlink walk')
assert.deepEqual($._registered.map((t) => t.name), ['open_in_editor'])
ok('session.start discovers cwd/home/pane/script and registers open_in_editor')

assert.deepEqual(state.cfg, DEFAULTS, 'a missing settings file leaves the defaults')
ok('a missing ~/.claude/syzygy-editor.json is the defaults, not an error')

// --- 2b. discover(): the attach-pane fallback ---------------------------------
section('session.start: the attach-pane fallback for a claude --bg session')

// TMUX_PANE, when it answers, wins outright -- no attach-pane lookup at all.
const withPane = makeDollar({ files: FILES, tmuxPane: '%20', sessionId: 'bgsess01-full' })
await hookFor(hooks, 'session.start')(withPane, { cwd: CWD }, next)
assert.equal(state.pane, '%20', 'TMUX_PANE, when present, still wins outright')
assert.equal(state.sessionId, 'bgsess01-full')
assert.ok(
  !withPane._runs.some((argv) => argv[0] === 'tmux'),
  'no tmux list-panes call at all when TMUX_PANE already answered the question',
)
ok('TMUX_PANE present: no attach-pane lookup is even attempted')

// TMUX_PANE absent (a `claude --bg` session's own process):
// found via the pane a `claude attach <id>` is running from.
const bgSid = 'bgsess02-full-session-id'
const bgShort = bgSid.slice(0, 8)
const found = makeDollar({
  files: FILES, tmuxPane: '', sessionId: bgSid,
  panesListing: panesOf(['%1', '/bin/bash', 'zsh'], ['%5', `claude attach ${bgShort}`, 'nvim']),
})
// A fresh session's pane starts unknown; the previous scenario's success
// (TMUX_PANE present) must not leak in and hide this one -- printenv on an
// absent TMUX_PANE leaves M.pane exactly as it found it, same as production.
state.pane = ''
await hookFor(hooks, 'session.start')(found, { cwd: CWD }, next)
assert.equal(state.pane, '%5', 'the attach pane, found with no TMUX/TMUX_PANE in this process at all')
assert.deepEqual(
  found._runs.find((argv) => argv[0] === 'tmux'),
  ['tmux', 'list-panes', '-a', '-F', '#{pane_id}\t#{pane_start_command}\t#{pane_current_command}'],
  "asks tmux the same format bin/syzygy-edit's own --session fallback parses",
)
ok('TMUX_PANE absent: the pane a claude attach is running the session from is found instead')

// No attach pane either -- state.pane stays empty; openPath (below) is where
// that turns into the honest "no tmux pane is attached to this session".
const notFound = makeDollar({
  files: FILES, tmuxPane: '', sessionId: 'bgsess03-nobody-attached',
  panesListing: panesOf(['%1', '/bin/bash', 'zsh']),
})
state.pane = ''
await hookFor(hooks, 'session.start')(notFound, { cwd: CWD }, next)
assert.equal(state.pane, '', 'no attach pane exists for this session either')
ok('no matching attach pane leaves state.pane empty rather than a stale or wrong guess')

// Restore the shared session.start state the rest of this harness assumes.
await hookFor(hooks, 'session.start')($, { cwd: CWD }, next)
assert.equal(state.pane, '%7')
assert.equal(state.sessionId, 'sess-1')

// --- 3. the existence filter -------------------------------------------------
section('the existence filter')

const render = async (dollar, text, props = {}) =>
  hookFor(hooks, 'ui.render')(
    dollar,
    { surface: 'terminal', component: 'AssistantMessage', requestId: 'm1', props: { text, firstOfReply: true, ...props } },
    async () => ({ type: 'engine', ref: 1 }),
  )

const labelsOf = (node, found = []) => {
  if (node === null || node === undefined) return found
  if (typeof node === 'string') return found
  if (Array.isArray(node)) { for (const c of node) labelsOf(c, found); return found }
  if (node.tag === 'Button') found.push(node.props.label)
  for (const c of node.children ?? []) labelsOf(c, found)
  return found
}

const TEXT = 'See src/app/util.js and src/lib/util.js and src/nope/missing.js and README.md'
const tree1 = await render($, TEXT)
assert.deepEqual(
  labelsOf(tree1),
  ['src/app/util.js', 'src/lib/util.js', 'README.md'],
  'only the paths that exist became buttons',
)
ok('a path-shaped token that does NOT exist on disk is not boxed')

const noRefs = await render($, 'Nothing here but prose about e.g. things.')
assert.deepEqual(noRefs, { type: 'engine', ref: 1 }, 'the engine draws its own')
ok('a message with no live reference passes straight through to the engine')

const desktop = await hookFor(hooks, 'ui.render')(
  $,
  { surface: 'desktop', component: 'AssistantMessage', requestId: 'm2', props: { text: TEXT } },
  async () => ({ type: 'engine', ref: 1 }),
)
assert.deepEqual(desktop, { type: 'engine', ref: 1 })
ok('a non-terminal surface is passed through untouched')

// --- 4. memoisation ----------------------------------------------------------
section('memoisation')

const before = state.parses
await render($, TEXT)
await render($, TEXT)
await render($, TEXT)
assert.equal(state.parses, before, 'three more renders of the same text: zero further parses')
ok('the parse is memoised on the message text (3 renders → 0 new parses)')

const existsBefore = $._existsCalls.length
await render($, TEXT)
assert.equal($._existsCalls.length, existsBefore, 'the path cache answered within its TTL')
ok('path existence is cached with a TTL — no fs call on a repeat render')

const later = makeDollar({ files: FILES, now: () => 1000 + 60_000 })
Object.assign(later, {})
const staleBefore = later._existsCalls.length
await render(later, TEXT)
assert.ok(later._existsCalls.length > staleBefore, 'past the TTL the fs is asked again')
ok('past the TTL the existence question is asked again (a new file becomes pressable)')

// --- 5. the render tree ------------------------------------------------------
section('the render tree')

const walk = (node, visit, path = 'root') => {
  visit(node, path)
  if (node && typeof node === 'object' && Array.isArray(node.children)) {
    node.children.forEach((c, i) => walk(c, visit, `${path}.children[${i}]`))
  }
}

let nodes = 0
walk(tree1, (n, path) => {
  nodes++
  assert.ok(n !== null && n !== undefined, `null child at ${path} — the engine would silently replace this tree`)
  if (typeof n === 'object' && Array.isArray(n.children)) {
    for (const c of n.children) {
      assert.ok(c !== null && c !== undefined, `null child under ${path}`)
    }
  }
})
assert.ok(nodes > 3, 'a real tree')
ok(`no null child anywhere in the row-mode tree (${nodes} nodes)`)

assert.equal(tree1.tag, 'Box')
const engineChild = JSON.stringify(tree1).includes('"ref":1')
assert.ok(engineChild, "the engine's own node is a CHILD in row mode — the markdown is kept")
ok("row mode embeds the engine's drawing and adds a button row beneath it")

const keys = []
walk(tree1, (n) => { if (n && n.tag === 'Button') keys.push(n.props.key) })
assert.equal(new Set(keys).size, keys.length, 'button keys are unique')
ok('every button has a distinct key (ui.press addresses it by key)')

// inline mode
state.cfg = { ...DEFAULTS, box: 'inline' }
const inline = await render($, TEXT)
assert.deepEqual(labelsOf(inline), ['src/app/util.js', 'src/lib/util.js', 'README.md'])
assert.ok(!JSON.stringify(inline).includes('"ref":1'), 'inline mode owns the whole tree')
let inlineNulls = 0
walk(inline, (n) => { if (n === null || n === undefined) inlineNulls++ })
assert.equal(inlineNulls, 0)
ok('inline mode boxes each reference in place, with no null child and no engine node')
state.cfg = { ...DEFAULTS }

assert.deepEqual(styleSpans('a **bold** and `code` here').map((s) => s.text), ['a ', 'bold', ' and ', 'code', ' here'])
assert.equal(styleSpans('a **bold** b')[1].bold, true)
assert.equal(styleSpans('a `c` b')[1].code, true)
assert.deepEqual(styleSpans('a lone ** marker').map((s) => s.text), ['a lone  marker'])
ok('inline mode reconstructs **bold** and `code`, and drops a lone marker')

// --- 6. pressing a button ----------------------------------------------------
section('the press')

const pressed = []
walk(tree1, (n) => { if (n && n.tag === 'Button') pressed.push(n.props.onPress) })
assert.equal(typeof pressed[0], 'function', 'onPress is a closure built inside the render hook')
const runsBefore = $._runs.length
pressed[0]()
await new Promise((r) => setTimeout(r, 5))
const argv = $._runs[runsBefore]
assert.ok(Array.isArray(argv), 'the child is started by ARGV, never a shell string')
assert.deepEqual(
  argv,
  ['/plugins/syzygy-editor/bin/syzygy-edit', '--pane', '%7', '--split', 'below', '--size', '40%', '--', 'src/app/util.js'],
  'the exact argv',
)
ok('pressing a button runs syzygy-edit by argv, with the path behind --')

// A ~-relative reference, end to end: boxed, labelled with ~, opened by the
// absolute path -- this is the reported bug (the box opened a blank file).
const HOME_FILE = `${HOME}/.claude/syzygy-relay.json`
FILES.add(HOME_FILE)
const tildeTree = await render($, 'open ~/.claude/syzygy-relay.json please')
assert.deepEqual(labelsOf(tildeTree), ['~/.claude/syzygy-relay.json'], 'boxed, labelled with ~')
let tildePress
walk(tildeTree, (n) => { if (n && n.tag === 'Button') tildePress = n.props.onPress })
assert.equal(typeof tildePress, 'function')
const tildeRunsBefore = $._runs.length
tildePress()
await new Promise((r) => setTimeout(r, 5))
assert.deepEqual(
  $._runs[tildeRunsBefore],
  ['/plugins/syzygy-editor/bin/syzygy-edit', '--pane', '%7', '--split', 'below', '--size', '40%', '--', HOME_FILE],
  'the argv carries the ABSOLUTE path -- never the literal ~, which nvim (no shell in between) would open as a blank file',
)
ok('pressing a ~-relative reference opens the absolute path, never the literal ~')

assert.deepEqual(
  editArgv('/s/edit', { ...DEFAULTS, editor: 'hx', split: 'right', size: '30%' }, '%2', '', { rel: 'a.ts', line: 9 }),
  ['/s/edit', '--pane', '%2', '--editor', 'hx', '--split', 'right', '--size', '30%', '--line', '9', '--', 'a.ts'],
)
ok('a configured editor, split, size and line all reach the argv')

assert.ok(
  !editArgv('/s/edit', DEFAULTS, '%2', '', { rel: 'a.ts' }).includes('--editor'),
  'the DEFAULT editor is not passed: $VISUAL/$EDITOR must keep their precedence',
)
ok('the default editor is left off the argv so $VISUAL/$EDITOR still win')

assert.deepEqual(editArgv('/s/edit', DEFAULTS, '', '', { rel: 'a.ts' }).includes('--pane'), false)
ok('no pane and no session id means no --pane flag; the script then refuses politely')

assert.deepEqual(
  editArgv('/s/edit', DEFAULTS, '', 'bgsess-full-id', { rel: 'a.ts' }),
  ['/s/edit', '--session', 'bgsess-full-id', '--split', 'below', '--size', '40%', '--', 'a.ts'],
  "no pane, but a known session id: --session instead, for bin/syzygy-edit's own fallback",
)
ok('a known session id with no pane passes --session, never both')

assert.equal(
  editArgv('/s/edit', DEFAULTS, '%9', 'bgsess-full-id', { rel: 'a.ts' }).includes('--session'),
  false,
  'a known pane already answers the question the fallback exists for',
)
ok('a known pane wins over --session -- the fallback is not needed once a pane is in hand')

assert.equal(label(CWD, HOME, { abs: '/proj/src/a.ts', rel: 'src/a.ts', raw: '', start: 0, end: 0 }), 'src/a.ts')
assert.equal(label(CWD, HOME, { abs: '/etc/hosts', rel: '/etc/hosts', raw: '', start: 0, end: 0 }), '/etc/hosts')
assert.equal(label(CWD, HOME, { abs: '/proj/src/a.ts', rel: 'src/a.ts', raw: '', start: 0, end: 0, line: 9 }), 'src/a.ts:9')
ok('a button is labelled relative to the working directory, absolute when outside it')

assert.equal(
  label(CWD, HOME, { abs: `${HOME}/.claude/settings.json`, rel: `${HOME}/.claude/settings.json`, raw: '', start: 0, end: 0 }),
  '~/.claude/settings.json',
  'the label shows ~, even though .rel (the argv VALUE) stays the absolute path',
)
ok('a reference under the home directory but outside the cwd is labelled with ~')

// --- 7. the tool -------------------------------------------------------------
section('open_in_editor')

const callTool = async (input) =>
  (await hookFor(hooks, 'tool.call')($, { tool: 'mcp__syzygy-editor__open_in_editor', tool_use_id: 't1', ...input }, next))
    .result.text

assert.match(await callTool({ path: 'src/app/util.js' }), /opened src\/app\/util\.js/)
ok('open_in_editor opens a file that exists')
assert.match(await callTool({ path: 'src/nope/missing.js' }), /no such file/)
ok('open_in_editor refuses a path that does not exist')
assert.match(await callTool({}), /needs a path/)
ok('open_in_editor with no path says so rather than throwing')

// --- 8. the prompt rule ------------------------------------------------------
section('the relative-path rule')

const ctx = await hookFor(hooks, 'prompt.context')($, { blocks: [{ name: 'claudeMd', text: 'x' }] }, next)
assert.equal(ctx.blocks.length, 2)
assert.equal(ctx.blocks[1].name, 'syzygyEditor')
assert.equal(ctx.blocks[1].text, RELATIVE_PATH_RULE)
assert.match(RELATIVE_PATH_RULE, /relative to the working directory/)
ok('prompt.context appends one block with the rule, keeping the engine\'s own')

state.cfg = { ...DEFAULTS, relativePathRule: false }
const ctxOff = await hookFor(hooks, 'prompt.context')($, { blocks: [{ name: 'claudeMd', text: 'x' }] }, next)
assert.equal(ctxOff.blocks.length, 1)
ok('relativePathRule: false leaves the context exactly as the engine built it')
state.cfg = { ...DEFAULTS }

// --- 9. the config -----------------------------------------------------------
section('the config file')

assert.deepEqual(parseConfig('{}'), DEFAULTS, 'an empty object is the defaults')
assert.deepEqual(parseConfig('not json at all'), DEFAULTS, 'a broken file is the defaults')
assert.deepEqual(parseConfig('[1,2]'), DEFAULTS, 'an array is the defaults')
assert.deepEqual(parseConfig(JSON.stringify({ relativePathRule: false, editor: 'hx', split: 'right', size: '25%', box: 'inline' })), {
  relativePathRule: false, editor: 'hx', split: 'right', size: '25%', box: 'inline',
})
assert.equal(parseConfig(JSON.stringify({ split: 'diagonal' })).split, 'below', 'an unknown split falls back')
assert.equal(parseConfig(JSON.stringify({ size: 'huge' })).size, '40%', 'a nonsense size falls back')
assert.equal(parseConfig(JSON.stringify({ box: 'circle' })).box, 'row', 'an unknown box falls back')
ok('every config failure is the default, never a throw')

// --- 10. the recent-files store ----------------------------------------------
section('turn.complete records the turn\'s files')

await hookFor(hooks, 'turn.complete')($, { answer: TEXT, turnId: 't', durationMs: 1, aborted: false }, next)
const recent = $._store.get('syzygy-editor:sess-1:recent')
assert.deepEqual(recent.paths, ['src/app/util.js', 'src/lib/util.js', 'README.md'])
assert.equal(recent.pane, '%7')
assert.equal(recent.cwd, CWD)
ok('turn.complete stores the turn\'s existing file references under the session id')

// --- 11. the script ----------------------------------------------------------
section('bin/syzygy-edit')

const sh = (args, env = {}) =>
  spawnSync('/bin/sh', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    cwd: ROOT,
  })

const dry = sh(['--dry-run', '--pane', '%9', '--size', '30%', '--editor', 'cat', '--', 'src/a.ts'])
assert.equal(dry.status, 0, dry.stderr)
assert.match(dry.stdout, /^tmux split-window -v -l 30% -t %9 -c .* -- cat src\/a\.ts$/m)
ok('--dry-run prints the tmux command and changes nothing')

const dryTilde = sh(['--dry-run', '--pane', '%9', '--editor', 'cat', '--', '~/x.ts'], { HOME: '/home/fixture' })
assert.equal(dryTilde.status, 0, dryTilde.stderr)
assert.match(dryTilde.stdout, /-- cat \/home\/fixture\/x\.ts$/m, '~/x.ts expands against $HOME before the command is built')
ok('--dry-run shows the ~ already expanded, so a hand run sees exactly what will open')

const dryRight = sh(['--dry-run', '--pane', '%9', '--split', 'right', '--editor', 'cat', '--', 'a.ts'])
assert.match(dryRight.stdout, /split-window -h /, '--split right becomes -h')
ok('--split right becomes tmux -h; below is -v (the default)')

const dryLine = sh(['--dry-run', '--pane', '%9', '--line', '42', '--editor', 'vi', '--', 'a.ts'])
assert.match(dryLine.stdout, /-- vi \+42 a\.ts$/m, 'a line becomes +42 for the vi family')
ok('--line becomes the editor\'s +N argument')

const dryLineUnknown = sh(['--dry-run', '--pane', '%9', '--line', '42', '--editor', 'cat', '--', 'a.ts'])
assert.match(dryLineUnknown.stdout, /-- cat a\.ts$/m, 'an editor that would treat +42 as a filename gets no +N')
ok('an editor with no known +N form is given the file alone')

const outside = sh(['--editor', 'cat', '--', 'a.ts'])
assert.equal(outside.status, 2, 'outside tmux: exit 2')
assert.match(outside.stdout, /tmux split-window/, 'and it prints what it would have run')
assert.match(outside.stderr, /not inside tmux/)
ok('outside tmux the script prints the command it would have run and exits 2')

// --- --session: the attach-pane fallback, against a fake tmux on PATH --------
// This is the bug: a `claude --bg` session's own process has neither TMUX nor
// TMUX_PANE, so it cannot say "not inside tmux" honestly --
// it never was. With --session it looks for the pane a `claude attach <id>`
// is running from instead, exactly like attachPaneFor (editor.tsx) above.
const fakeTmuxDir = mkdtempSync(join(tmpdir(), 'szg-editor-faketmux-'))
const fakeTmuxBin = join(fakeTmuxDir, 'tmux')
writeFileSync(
  fakeTmuxBin,
  [
    '#!/bin/sh',
    '[ -n "${FAKE_TMUX_LOG:-}" ] && printf \'%s\\n\' "$*" >> "$FAKE_TMUX_LOG"',
    'case "$1" in',
    '  list-panes) printf \'%s\\n\' "$FAKE_TMUX_PANES" ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n') + '\n',
)
chmodSync(fakeTmuxBin, 0o755)
const fakeTmuxLog = join(fakeTmuxDir, 'log')

const shWithFakeTmux = (args, panes, env = {}) =>
  sh(args, { PATH: `${fakeTmuxDir}:${process.env.PATH}`, FAKE_TMUX_PANES: panes, FAKE_TMUX_LOG: fakeTmuxLog, ...env })

const BGSID = 'bgsid001-full-session-id'
const BGSHORT = BGSID.slice(0, 8)

writeFileSync(fakeTmuxLog, '')
const drySession = shWithFakeTmux(
  ['--dry-run', '--session', BGSID, '--editor', 'cat', '--', 'a.ts'],
  panesOf(['%1', '/bin/bash', 'zsh'], ['%7', `claude attach ${BGSHORT}`, 'nvim']),
)
assert.equal(drySession.status, 0, drySession.stderr)
assert.match(drySession.stdout, /-t %7 /, 'the resolved attach pane, not "<no pane>"')
ok('--session resolves the attach pane when --pane and TMUX_PANE are both absent')

assert.equal(
  readFileSync(fakeTmuxLog, 'utf8').trim(),
  'list-panes -a -F #{pane_id}\t#{pane_start_command}\t#{pane_current_command}',
  "the script asks tmux the exact format attachPaneFor (editor.tsx) parses the same way",
)
ok('bin/syzygy-edit asks tmux for pane_id/pane_start_command/pane_current_command, tab-separated')

writeFileSync(fakeTmuxLog, '')
const drySeveral = shWithFakeTmux(
  ['--dry-run', '--session', BGSID, '--editor', 'cat', '--', 'a.ts'],
  panesOf(['%2', `claude attach ${BGSHORT}`, 'nvim'], ['%8', `claude attach ${BGSHORT}`, 'nvim']),
)
assert.match(drySeveral.stdout, /-t %8 /, 'the LAST matching pane wins, same tie-break as attachPaneFor')
ok('--session with several attach panes picks the last one')

const noAttach = shWithFakeTmux(['--session', BGSID, '--editor', 'cat', '--', 'a.ts'], panesOf(['%1', '/bin/bash', 'zsh']))
assert.equal(noAttach.status, 2, 'no attach pane for this session: exit 2')
assert.match(noAttach.stdout, /tmux split-window/, 'still prints what it would have run')
assert.match(noAttach.stderr, /no tmux pane is attached to this session/, 'never "not inside tmux" -- this process never was')
assert.match(noAttach.stderr, new RegExp(`claude attach ${BGSID}`), 'names the exact claude attach hint')
ok('a session id with no matching attach pane gets the honest message and the claude attach hint')

writeFileSync(fakeTmuxLog, '')
const dryPaneWins = shWithFakeTmux(
  ['--dry-run', '--pane', '%3', '--session', BGSID, '--editor', 'cat', '--', 'a.ts'],
  panesOf(['%9', `claude attach ${BGSHORT}`, 'nvim']),
)
assert.match(dryPaneWins.stdout, /-t %3 /, '--pane wins outright over --session')
assert.equal(readFileSync(fakeTmuxLog, 'utf8').trim(), '', 'no tmux list-panes call at all: --pane already answered it')
ok('--pane, when given, wins outright -- --session is only the fallback')

rmSync(fakeTmuxDir, { recursive: true, force: true })

const noPath = sh(['--dry-run'])
assert.equal(noPath.status, 1)
assert.match(noPath.stderr, /usage/)
ok('no path is a usage error, not a split')

const badFlag = sh(['--nope', 'a.ts'])
assert.equal(badFlag.status, 1)
assert.match(badFlag.stderr, /unknown option/)
ok('an unknown option is refused')

const badSplit = sh(['--split', 'sideways', '--dry-run', '--', 'a.ts'])
assert.equal(badSplit.status, 1)
assert.match(badSplit.stderr, /below or right/)
ok('--split takes only below or right')

// The editor precedence, observed through --dry-run.
assert.match(sh(['--dry-run', '--pane', '%1', '--', 'a.ts'], { SYZYGY_EDITOR: 'cat', VISUAL: 'more', EDITOR: 'less' }).stdout, /-- cat a\.ts/)
assert.match(sh(['--dry-run', '--pane', '%1', '--', 'a.ts'], { VISUAL: 'cat', EDITOR: 'less' }).stdout, /-- cat a\.ts/)
assert.match(sh(['--dry-run', '--pane', '%1', '--', 'a.ts'], { EDITOR: 'cat' }).stdout, /-- cat a\.ts/)
assert.match(sh(['--dry-run', '--pane', '%1', '--editor', 'cat', '--', 'a.ts'], { VISUAL: 'more' }).stdout, /-- cat a\.ts/)
assert.match(sh(['--dry-run', '--pane', '%1', '--editor', 'more', '--', 'a.ts'], { SYZYGY_EDITOR: 'cat' }).stdout, /-- cat a\.ts/)
assert.match(sh(['--dry-run', '--pane', '%1', '--editor', 'definitely-not-installed-xyz', '--', 'a.ts'], { EDITOR: 'cat' }).stdout, /-- cat a\.ts/)
ok('$SYZYGY_EDITOR > --editor (the config\'s choice) > $VISUAL > $EDITOR, and an editor that is not installed is skipped')

// --- done --------------------------------------------------------------------
rmSync(out, { recursive: true, force: true })
console.log(`\n✔ all ${checks} syzygy-editor harness checks passed`)
