#!/usr/bin/env node
// Drives bridge/canvas.mjs (the relay's canvas core), bridge/public/
// canvas-layout.js (the reset layout) and, at the end, a REAL relay subprocess
// against a fake `claude` binary. Hermetic: SZG_PORT=0, SZG_DATA_DIR in a temp
// dir, SZG_CLAUDE_BIN pointing at a script that prints what `claude --bg`
// prints. No test starts a real session.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, chmodSync, existsSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const C = await import(join(ROOT, 'syzygy', 'bridge', 'canvas.mjs'))
const J = await import(join(ROOT, 'syzygy', 'bridge', 'jump.mjs'))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }
const tmp = () => mkdtempSync(join(tmpdir(), 'szg-canvas-'))

// ---- shape ------------------------------------------------------------------
await ok('emptyCanvas has nodes, spawnedBy and recents', () => {
  assert.deepEqual(C.emptyCanvas(), { nodes: {}, spawnedBy: [], recents: [] })
})

await ok('sanitizeCanvas coerces garbage to the shape and keeps good entries', () => {
  const s = C.sanitizeCanvas({ nodes: { a: { x: 1, y: 2, name: 'n' }, b: 'junk', c: { x: 'x', y: 1 } }, spawnedBy: 'no', recents: ['/a', 3, '/a'] })
  assert.deepEqual(Object.keys(s.nodes), ['a'])
  assert.equal(s.nodes.a.x, 1); assert.equal(s.nodes.a.name, 'n'); assert.equal(typeof s.nodes.a.t, 'number')
  assert.deepEqual(s.spawnedBy, [])
  assert.deepEqual(s.recents, ['/a'])
  assert.deepEqual(C.sanitizeCanvas(undefined), C.emptyCanvas())
})

await ok('sanitizeCanvas drops the three prototype keys instead of writing them into nodes', () => {
  // A hand-edited or corrupted world.json is the other door into the hole
  // /api/canvas/move refuses at the endpoint: `out.nodes['__proto__'] = {...}`
  // sets the PROTOTYPE of a plain object literal, so every later node would
  // silently inherit x/y/name from it.
  const raw = JSON.parse('{"nodes":{"__proto__":{"x":9,"y":9,"name":"evil"},"constructor":{"x":1,"y":1},"prototype":{"x":2,"y":2},"good":{"x":3,"y":4}},"spawnedBy":[],"recents":[]}')
  const out = C.sanitizeCanvas(raw)
  assert.deepEqual(Object.keys(out.nodes), ['good'])
  assert.equal(Object.getPrototypeOf(out.nodes), Object.prototype, 'the nodes map still has a clean prototype')
  assert.equal(out.nodes.good.x, 3)
  assert.equal({}.x, undefined, 'and nothing leaked onto Object.prototype either')
})

// ---- cwd validation ---------------------------------------------
await ok('validateCwd refuses a relative path', () => {
  assert.equal(C.validateCwd('relative/dir').ok, false)
  assert.equal(C.validateCwd('').ok, false)
  assert.equal(C.validateCwd(42).ok, false)
})
await ok('validateCwd refuses a path that does not exist', () => {
  assert.equal(C.validateCwd(join(tmp(), 'nope')).ok, false)
})
await ok('validateCwd refuses a file', () => {
  const d = tmp(); writeFileSync(join(d, 'f'), 'x')
  assert.equal(C.validateCwd(join(d, 'f')).ok, false)
})
await ok('validateCwd resolves a symlink to its real target and refuses a dangling or file-pointing one', () => {
  const d = tmp(); const other = tmp()
  symlinkSync(other, join(d, 'escape'))
  const r = C.validateCwd(join(d, 'escape'))
  assert.equal(r.ok, true)
  assert.equal(r.cwd, realpathSync(other), 'the validated cwd is the REAL directory, never the link')
  writeFileSync(join(d, 'f'), 'x'); symlinkSync(join(d, 'f'), join(d, 'tofile'))
  assert.equal(C.validateCwd(join(d, 'tofile')).ok, false)
  symlinkSync(join(d, 'gone'), join(d, 'dangling'))
  assert.equal(C.validateCwd(join(d, 'dangling')).ok, false)
})
await ok('validateCwd accepts a real directory and returns its realpath', () => {
  const d = tmp()
  assert.deepEqual(C.validateCwd(d), { ok: true, cwd: realpathSync(d) })
})
await ok('validateCwd expands a leading ~ and a bare ~, and leaves ~user alone', () => {
  // What the typeahead offers has to be what the relay then accepts, so both
  // sides expand `~` the same way -- through expandTilde.
  const home = realpathSync(tmp())
  mkdirSync(join(home, 'proj'))
  assert.deepEqual(C.validateCwd('~/proj', home), { ok: true, cwd: join(home, 'proj') })
  assert.deepEqual(C.validateCwd('~', home), { ok: true, cwd: home })
  // ~user is somebody else's home. Rewriting it under OURS would be a silent
  // lie, so it is left alone and fails the absolute-path check.
  assert.equal(C.validateCwd('~root/proj', home).ok, false)
  assert.equal(C.validateCwd('~nope', home).error, 'cwd must be an absolute path')
  assert.equal(C.expandTilde('/already/absolute', home), '/already/absolute', 'nothing else is touched')
  assert.equal(C.expandTilde('a/~/b', home), 'a/~/b', 'only a LEADING tilde')
})

// ---- the directory typeahead -------------------------------------------------
// completeDirs takes an injected `list`, so the tree these run against is made
// up rather than on disk. One live check against a real temp tree sits in the
// relay block at the bottom.
const tree = {
  '/r': [
    { name: 'alpha', isDirectory: true }, { name: 'alps', isDirectory: true }, { name: 'beta', isDirectory: true },
    { name: 'alpha.txt', isDirectory: false }, { name: '.alphahidden', isDirectory: true },
    // A symlink reads as a link, never as a directory: completeDirs does not
    // stat, so this is all a listing can say about one.
    { name: 'alias', isDirectory: false, isSymbolicLink: true },
    { name: 'alpha.md', isDirectory: false, isSymbolicLink: false },
  ],
  '/r/alpha': [{ name: 'one', isDirectory: true }, { name: 'two', isDirectory: true }],
  '/': [{ name: 'r', isDirectory: true }],
}
// The injected `list` stays synchronous on purpose: `await` on a plain value is
// a plain value, so the same tests cover an async real listing and prove the
// pure core does not care which it got.
const listOf = (dir) => { if (!(dir in tree)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e } return tree[dir] }
const comp = (p, o = {}) => C.completeDirs(p, { home: '/home/me', list: listOf, ...o })

await ok('completeDirs offers directories whose name starts with the last segment typed', async () => {
  assert.deepEqual((await comp('/r/al')).dirs, ['/r/alias', '/r/alpha', '/r/alps'])
  assert.deepEqual((await comp('/r/alp')).dirs, ['/r/alpha', '/r/alps'])
  assert.deepEqual((await comp('/r/alph')).dirs, ['/r/alpha'])
  assert.deepEqual((await comp('/r/z')).dirs, [], 'nothing matches, and that is not an error')
})
await ok('completeDirs lists a directory\'s children when the path ends in a slash', async () => {
  assert.deepEqual((await comp('/r/alpha/')).dirs, ['/r/alpha/one', '/r/alpha/two'])
  assert.deepEqual((await comp('/')).dirs, ['/r'], 'the root is its own parent, not the empty string')
})
await ok('completeDirs offers files never, and hidden directories only once a dot is typed', async () => {
  const bare = (await comp('/r/')).dirs
  assert.equal(bare.includes('/r/alpha.txt'), false, 'a file is not a directory to start a session in')
  assert.equal(bare.includes('/r/alpha.md'), false, 'nor is a plain file that is explicitly not a link')
  assert.equal(bare.includes('/r/.alphahidden'), false, 'a bare listing would otherwise be all dotfiles')
  assert.deepEqual((await comp('/r/.al')).dirs, ['/r/.alphahidden'], 'typing the dot asks for them')
})
await ok('completeDirs offers a SYMLINK, because validateCwd accepts one', async () => {
  // Hiding a path the form would have taken is worse than offering one it may
  // refuse. A dangling link is refused at submit, where the realpath happens.
  assert.deepEqual((await comp('/r/ali')).dirs, ['/r/alias'])
  assert.equal((await comp('/r/')).dirs.includes('/r/alias'), true)
})
await ok('completeDirs sorts, and caps the list', async () => {
  const many = { '/big': Array.from({ length: 50 }, (_, i) => ({ name: 'd' + String(i).padStart(2, '0'), isDirectory: true })) }
  const r = await C.completeDirs('/big/', { home: '/home/me', list: (d) => many[d] })
  assert.equal(r.dirs.length, C.COMPLETE_MAX)
  assert.equal(C.COMPLETE_MAX, 20)
  assert.equal(r.dirs[0], '/big/d00', 'sorted, so the cap takes a predictable slice')
  assert.deepEqual((await C.completeDirs('/r/al', { home: '/home/me', list: listOf, max: 1 })).dirs, ['/r/alias'])
})
await ok('completeDirs expands a leading ~ the way validateCwd does', async () => {
  const homed = { '/home/me': [{ name: 'work', isDirectory: true }, { name: 'words', isDirectory: true }] }
  assert.deepEqual((await C.completeDirs('~/wor', { home: '/home/me', list: (d) => homed[d] })).dirs,
    ['/home/me/words', '/home/me/work'])
})
await ok('completeDirs takes an ASYNC list, and a rejection is just an empty answer', async () => {
  // The real one is async: readdir on a directory the user is halfway through
  // typing must not block the relay's single event loop (F2).
  const asyncList = async (d) => listOf(d)
  assert.deepEqual((await C.completeDirs('/r/alph', { home: '/h', list: asyncList })).dirs, ['/r/alpha'])
  assert.deepEqual((await C.completeDirs('/r/', { home: '/h', list: async () => { throw new Error('EACCES') } })).dirs, [],
    'a REJECTED promise is a failure exactly like a synchronous throw, not an unhandled rejection')
})
await ok('completeDirs answers an empty list for anything it cannot do, and never throws', async () => {
  // A path halfway through being typed does not exist yet: ENOENT is the
  // NORMAL case here, not an error worth a 500.
  assert.deepEqual((await comp('/nowhere/at/all')).dirs, [])
  assert.deepEqual((await comp('relative/path')).dirs, [], 'not absolute after expansion')
  assert.deepEqual((await comp('~nobody/x')).dirs, [])
  assert.deepEqual((await comp('')).dirs, [])
  assert.deepEqual((await C.completeDirs(null, { home: '/home/me', list: listOf })).dirs, [])
  assert.deepEqual((await C.completeDirs('/r/', { home: '/h', list: () => { throw new Error('EACCES') } })).dirs, [])
  assert.deepEqual((await C.completeDirs('/r/', { home: '/h', list: () => 'not an array' })).dirs, [])
})

// ---- the spawn request and argv ---------------------------------
await ok('spawnRequest applies the Dispatch defaults and cleans the name', () => {
  const r = C.spawnRequest({ prompt: 'go', name: '  my\u0000 sess\u001fion  ' }, '/real')
  assert.equal(r.ok, true)
  assert.equal(r.model, 'opus'); assert.equal(r.effort, 'high')
  assert.equal(r.name, 'my session')
  assert.equal(r.cwd, '/real')
})
await ok('spawnRequest falls back to the cwd basename for a missing name', () => {
  assert.equal(C.spawnRequest({ prompt: 'go' }, '/home/dev/proj').name, 'proj')
})
await ok('spawnRequest refuses an empty prompt, an unknown model and an unknown effort', () => {
  assert.equal(C.spawnRequest({ prompt: '   ' }, '/r').ok, false)
  assert.equal(C.spawnRequest({ prompt: 'x', model: 'gpt-9' }, '/r').ok, false)
  assert.equal(C.spawnRequest({ prompt: 'x', effort: 'ultra' }, '/r').ok, false)
  assert.equal(C.spawnRequest({ prompt: 'x', model: 'claude-opus-5' }, '/r').ok, true, 'a full claude-* model name is allowed')
  assert.equal(C.spawnRequest({ prompt: 'x', model: 'fable', effort: 'max' }, '/r').ok, true)
})
await ok('spawnRequest caps the name and the prompt', () => {
  const r = C.spawnRequest({ prompt: 'p'.repeat(30_000), name: 'n'.repeat(100) }, '/r')
  assert.equal(r.name.length, C.NAME_MAX)
  assert.equal(r.prompt.length, C.PROMPT_MAX)
})
await ok('spawnRequest refuses a prompt beginning with a dash, whatever follows it', () => {
  // Without this a prompt of `--some-flag` starts a session carrying that flag
  // and NO prompt, and a one-word prompt equal to a subcommand name runs the
  // subcommand. `--` in the argv covers it too; this names the mistake.
  for (const p of ['--some-flag', '-n', '  --resume  ', '-']) {
    const r = C.spawnRequest({ prompt: p }, '/r')
    assert.equal(r.ok, false, JSON.stringify(p))
    assert.equal(r.error, 'a kickoff prompt may not begin with "-"', JSON.stringify(p))
  }
  assert.equal(C.spawnRequest({ prompt: 'do the thing --now' }, '/r').ok, true, 'a dash INSIDE the prompt is fine')
})
await ok('spawnArgv is an ARRAY with the prompt behind `--` as its own last element, and no --allowedTools', () => {
  const argv = C.spawnArgv({ name: 'alpha', prompt: 'do the thing --now', model: 'opus', effort: 'high' })
  assert.ok(Array.isArray(argv))
  assert.deepEqual(argv, ['--bg', '-n', 'alpha', '--permission-mode', 'auto', '--model', 'opus', '--effort', 'high', '--', 'do the thing --now'])
  assert.equal(argv.at(-1), 'do the thing --now', 'the prompt is one element, never split')
  assert.equal(argv.at(-2), '--', 'the end-of-options sentinel sits immediately before it')
  assert.equal(argv.includes('--allowedTools'), false, 'variadic; would swallow the prompt (dispatch.mjs:167)')
})
await ok('spawnEnvSettings builds the --settings payload, and is null when there is nothing to say', () => {
  // `--settings` rather than the environment because `claude --bg` does not
  // fork: the session runs in a pre-warmed spare owned by a long-lived daemon
  // and inherits the DAEMON's environment. Argv arrives; the environment does
  // not. Verified live against CLI 2.1.269.
  assert.equal(C.spawnEnvSettings({ relayPort: 4550, relayToken: 'tok' }),
    '{"env":{"SZG_RELAY_PORT":"4550","SZG_RELAY_TOKEN":"tok"}}')
  assert.deepEqual(JSON.parse(C.spawnEnvSettings({ relayPort: 4550, relayToken: 'tok' })).env,
    { SZG_RELAY_PORT: '4550', SZG_RELAY_TOKEN: 'tok' }, 'both values are STRINGS: an environment holds no numbers')
  assert.equal(C.spawnEnvSettings({ relayPort: 4550 }), '{"env":{"SZG_RELAY_PORT":"4550"}}')
  assert.equal(C.spawnEnvSettings({}), null, 'nothing to say, so no --settings at all')
  assert.equal(C.spawnEnvSettings(), null)
})
await ok('childEnv strips EVERY SZG_* variable, by prefix, and keeps everything else', () => {
  // Not hygiene. `claude --bg` hands the request to a daemon that is COLD-
  // STARTED by the first such launch and keeps that launcher's environment for
  // every session afterwards -- so a canvas spawn that happened to start the
  // daemon would teach every later background session on the machine to
  // register with THIS relay -- the very hazard this strip exists to avoid,
  // arriving by the other door and aimed at everyone else.
  //
  // By PREFIX, not by a named list: every SZG_* variable is relay
  // configuration by definition, and a list would rot -- the next knob added
  // to relay.mjs would leak until somebody remembered to name it, with nothing
  // reporting that it had.
  const env = C.childEnv({
    PATH: '/usr/bin', HOME: '/Users/x', TERM: 'xterm', FOO: 'bar', szg_lowercase: 'kept',
    SZG_SOMETHING_ELSE: 'a knob nobody has written yet',
    SZG_RELAY_PORT: '4550', SZG_RELAY_TOKEN: 'tok', SZG_PORT: '4550', SZG_TOKEN: 'dev',
    SZG_DATA_DIR: '/tmp/w', SZG_CLAUDE_BIN: '/fake', SZG_SPAWN_PLUGIN_DIR: '/p',
    SZG_TMUX_BIN: '/usr/bin/false', SZG_CANVAS_POLL_MS: '300',
  })
  for (const k of C.RELAY_ONLY_ENV) assert.equal(k in env, false, k + ' must not reach a child')
  assert.equal('SZG_SOMETHING_ELSE' in env, false, 'a knob this list has never heard of goes too')
  assert.equal(Object.keys(env).some((k) => k.startsWith('SZG_')), false,
    'nothing under the prefix survives at all')
  assert.equal(env.PATH, '/usr/bin'); assert.equal(env.HOME, '/Users/x')
  assert.equal(env.TERM, 'xterm'); assert.equal(env.FOO, 'bar')
  assert.equal(env.szg_lowercase, 'kept', 'case-sensitive: SZG_ is this project\'s prefix, not a spelling')
  assert.equal(C.RELAY_ENV_PREFIX, 'SZG_')
})
await ok('childEnv copies rather than mutating, and defaults to the relay\'s own environment', () => {
  const src = { PATH: '/p', SZG_TOKEN: 'dev' }
  const out = C.childEnv(src)
  assert.equal(src.SZG_TOKEN, 'dev', 'the caller\'s object is untouched')
  assert.equal('SZG_TOKEN' in out, false)
  assert.equal(C.childEnv().PATH, process.env.PATH, 'no argument means process.env')
})
await ok('spawnArgv adds --settings before the sentinel, carrying the relay identity', () => {
  const argv = C.spawnArgv({ name: 'a', prompt: 'go', settings: C.spawnEnvSettings({ relayPort: 4550, relayToken: 'tok' }) })
  assert.equal(argv[argv.indexOf('--settings') + 1], '{"env":{"SZG_RELAY_PORT":"4550","SZG_RELAY_TOKEN":"tok"}}')
  assert.ok(argv.indexOf('--settings') < argv.indexOf('--'), 'an option, so before the sentinel')
  assert.equal(C.spawnArgv({ name: 'a', prompt: 'go' }).includes('--settings'), false)
})
await ok('spawnArgv adds --plugin-dir BEFORE the sentinel when one is given, and nothing when it is null', () => {
  // It is an OPTION. Behind `--` it would arrive as two more words of the
  // prompt and the session would load the installed plugin regardless, with
  // nothing anywhere saying so.
  const argv = C.spawnArgv({ name: 'alpha', prompt: 'go', pluginDir: '/repo/syzygy' })
  assert.deepEqual(argv, ['--bg', '--plugin-dir', '/repo/syzygy', '-n', 'alpha', '--permission-mode', 'auto', '--model', 'opus', '--effort', 'high', '--', 'go'])
  assert.ok(argv.indexOf('--plugin-dir') < argv.indexOf('--'), 'before the end-of-options sentinel')
  assert.deepEqual(C.spawnArgv({ name: 'alpha', prompt: 'go', pluginDir: null }),
    C.spawnArgv({ name: 'alpha', prompt: 'go' }), 'null is production: no trace of it')
})
// ---- which `claude` ----------------------------------------------------------
// Installs differ, and a machine can carry more than one: an older build has
// neither `--bg` nor `attach`, and may still win PATH. Taking `claude` on
// faith made every spawn fail on `unknown option '--bg'` with nothing saying why.
await ok('pickClaudeBin takes the first candidate the probe accepts', async () => {
  const tried = []
  const probe = async (b) => { tried.push(b); return b === '/good/claude' }
  assert.equal(await C.pickClaudeBin(['/old/claude', '/good/claude', '/never/claude'], probe), '/good/claude')
  assert.deepEqual(tried, ['/old/claude', '/good/claude'], 'and stops there: the rest are never probed')
})
await ok('pickClaudeBin answers null when nothing works, and skips empty candidates', async () => {
  assert.equal(await C.pickClaudeBin(['/a', '/b'], async () => false), null)
  assert.equal(await C.pickClaudeBin([], async () => true), null)
  assert.equal(await C.pickClaudeBin(undefined, async () => true), null)
  const tried = []
  await C.pickClaudeBin([null, '', '/a'], async (b) => { tried.push(b); return true })
  assert.deepEqual(tried, ['/a'], 'an unset candidate is not a candidate')
})
await ok('probeClaudeBin demands BOTH --bg and attach, and refuses a non-zero exit', async () => {
  // One without the other would pass a looser check and then fail on the other
  // endpoint -- the confusing half of the bug rather than a fix.
  const help = (text, code = 0) => async () => ({ code, stdout: text, stderr: '' })
  assert.equal(await C.probeClaudeBin('x', help('  --bg  background\n  attach  attach to a session\n')), true)
  assert.equal(await C.probeClaudeBin('x', help('  --bg  background\n')), false, 'no attach')
  assert.equal(await C.probeClaudeBin('x', help('  attach  attach to a session\n')), false, 'no --bg')
  assert.equal(await C.probeClaudeBin('x', help('  --bg\n  attach\n', 1)), false, 'a non-zero exit is not a yes')
  assert.equal(await C.probeClaudeBin('x', async () => { throw new Error('ENOENT') }), false, 'nor is a missing binary')
})

await ok('attachArgv wraps `claude attach` in a detached tmux window', () => {
  assert.deepEqual(C.attachArgv({ shortId: 'ab12', window: 'szg-alpha', cwd: '/r', claudeBin: 'claude' }),
    ['new-window', '-d', '-n', 'szg-alpha', '-c', '/r', 'claude', 'attach', 'ab12'])
})

// ---- position inheritance by name (the claims-inherit rules) ---------
await ok('a stored node whose id is gone and whose name uniquely matches transfers its position', () => {
  const nodes = { old1: { x: 10, y: 20, name: 'alpha', t: 1 } }
  const r = C.inheritPosition(nodes, { id: 'new1', name: 'alpha' }, [{ id: 'new1', name: 'alpha' }])
  assert.equal(r.from, 'old1')
  assert.deepEqual(Object.keys(r.nodes), ['new1'])
  assert.equal(r.nodes.new1.x, 10); assert.equal(r.nodes.new1.y, 20); assert.equal(r.nodes.new1.name, 'alpha')
  assert.equal(nodes.old1.x, 10, 'pure: the input is not mutated')
})
await ok('two stale nodes sharing the name: nothing is inherited', () => {
  const nodes = { old1: { x: 1, y: 1, name: 'alpha', t: 1 }, old2: { x: 2, y: 2, name: 'alpha', t: 2 } }
  const r = C.inheritPosition(nodes, { id: 'new1', name: 'alpha' }, [{ id: 'new1', name: 'alpha' }])
  assert.equal(r.from, null)
  assert.deepEqual(r.nodes, nodes)
})
await ok('a LIVE session already wearing the name: nothing is inherited', () => {
  const nodes = { old1: { x: 1, y: 1, name: 'alpha', t: 1 } }
  const live = [{ id: 'new1', name: 'alpha' }, { id: 'other', name: 'alpha' }]
  assert.equal(C.inheritPosition(nodes, { id: 'new1', name: 'alpha' }, live).from, null)
})
await ok('a stale node whose id is still live is never a donor', () => {
  const nodes = { still: { x: 1, y: 1, name: 'alpha', t: 1 } }
  // `still` is live under a different name now -- its position is its own.
  const live = [{ id: 'new1', name: 'alpha' }, { id: 'still', name: 'renamed' }]
  assert.equal(C.inheritPosition(nodes, { id: 'new1', name: 'alpha' }, live).from, null)
})
await ok('an already-positioned session and a nameless one are left alone', () => {
  const nodes = { new1: { x: 5, y: 5, name: 'alpha', t: 1 }, old1: { x: 1, y: 1, name: 'alpha', t: 1 } }
  assert.equal(C.inheritPosition(nodes, { id: 'new1', name: 'alpha' }, [{ id: 'new1', name: 'alpha' }]).from, null)
  assert.equal(C.inheritPosition({ o: { x: 1, y: 1, name: '', t: 1 } }, { id: 'n', name: '' }, [{ id: 'n', name: '' }]).from, null)
})
await ok('a pending spawn node is a stale node like any other, so it transfers by name', () => {
  const nodes = { 'pending:ab12': { x: 300, y: 40, name: 'alpha', t: 1 } }
  const r = C.inheritPosition(nodes, { id: 'sess-1', name: 'alpha' }, [{ id: 'sess-1', name: 'alpha' }])
  assert.equal(r.from, 'pending:ab12')
  assert.equal(r.nodes['sess-1'].x, 300)
})

// ---- the live count ----------------------------------------------------------
// There is no concurrency cap. The live count is the whole guard, so these
// checks are about the count.
const rec = (o) => ({ shortId: 'x', name: 'n', cwd: '/r', model: 'opus', effort: 'high', spawnedAt: 0, sessionId: null, state: null, ...o })
await ok('there is no concurrency cap: canvas.mjs exports no SPAWN_CAP', () => {
  assert.equal('SPAWN_CAP' in C, false, 'nothing may refuse a spawn on a count')
})
await ok('a never-listed record counts until a successful listing rules on it, up to 24 h', () => {
  // Fail closed. `state == null` means NO successful `claude agents --json`
  // has ever ruled on this record. It used to stop counting 60 s after the
  // spawn whether or not any listing ever succeeded, so a listing that failed
  // every time silently dropped every spawn out of the count -- the count fell
  // to zero exactly when the relay had lost track of what was running.
  assert.equal(C.isLiveSpawn(rec({ spawnedAt: 1000 }), 1000 + 5_000), true)
  assert.equal(C.isLiveSpawn(rec({ spawnedAt: 1000 }), 1000 + 61_000), true, 'the old grace window no longer stops it counting')
  assert.equal(C.isLiveSpawn(rec({ spawnedAt: 1000 }), 1000 + C.NULL_STATE_MAX_MS + 1), false, 'but not forever: the poller stops asking at a day')
  assert.equal(C.NULL_STATE_MAX_MS, 24 * 3600_000)
  assert.equal(C.isLiveSpawn(rec({ spawnedAt: 1000, state: 'starting' }), 1000 + 61_000), true, 'a placeholder counts by the not-SETTLED branch')
})
await ok('a `missing` verdict from a successful listing stops the record counting at once', () => {
  // The grace window keeps its ONE remaining meaning, inside settleSpawns:
  // how long a SUCCESSFUL listing may omit a record before absence is read as
  // `missing`. Once it is, it stops counting immediately -- no day-long wait.
  const t = C.SPAWN_GRACE_MS + 1
  const before = [rec({ shortId: 'a1', spawnedAt: 0 })]
  assert.equal(C.liveSpawnCount(before, t), 1, 'still counted while nothing has ruled on it')
  const r = C.settleSpawns(before, [], t)
  assert.equal(r.spawnedBy[0].state, 'missing')
  assert.equal(C.liveSpawnCount(r.spawnedBy, t), 0, 'a listing verdict stops it counting, and only a verdict does')
  assert.equal(C.settleSpawns(before, null, t).spawnedBy[0].state, null, 'a FAILED listing rules on nothing')
  assert.equal(C.liveSpawnCount(C.settleSpawns(before, null, t).spawnedBy, t), 1)
})
await ok('settled states do not count; anything else listed does', () => {
  for (const s of ['done', 'failed', 'stopped', 'missing']) assert.equal(C.isLiveSpawn(rec({ state: s }), 0), false, s)
  for (const s of ['working', 'blocked', 'listed', 'weird']) assert.equal(C.isLiveSpawn(rec({ state: s }), 0), true, s)
  assert.equal(C.liveSpawnCount([rec({ state: 'working' }), rec({ state: 'done' }), rec({ spawnedAt: 0 })], 10), 2)
})
await ok('settleSpawns folds sessionId and state from a listing, marks missing after grace, leaves settled alone', () => {
  const before = [rec({ shortId: 'a1', spawnedAt: 0 }), rec({ shortId: 'b2', spawnedAt: 0 }), rec({ shortId: 'c3', state: 'done', sessionId: 'c-full' })]
  const agents = [{ id: 'a1', sessionId: 'a-full', state: 'working', kind: 'background' }, { id: 'zz', state: 'working' }]
  const r = C.settleSpawns(before, agents, C.SPAWN_GRACE_MS + 1)
  assert.equal(r.changed, true)
  assert.equal(r.spawnedBy[0].sessionId, 'a-full'); assert.equal(r.spawnedBy[0].state, 'working')
  assert.equal(r.spawnedBy[1].state, 'missing')
  assert.equal(r.spawnedBy[2], before[2], 'a settled record is the same object')
  assert.equal(before[0].state, null, 'pure: input untouched')
})
await ok('settleSpawns does nothing on a failed agents call (null) and reports no change when nothing moved', () => {
  const before = [rec({ shortId: 'a1', spawnedAt: 0 })]
  assert.equal(C.settleSpawns(before, null, 10).changed, false)
  const listed = C.settleSpawns(before, [{ id: 'a1', sessionId: 's', state: 'working' }], 10)
  assert.equal(C.settleSpawns(listed.spawnedBy, [{ id: 'a1', sessionId: 's', state: 'working' }], 10).changed, false)
})
await ok('a listed agent with no state field reads as listed (live), not settled', () => {
  const r = C.settleSpawns([rec({ shortId: 'a1' })], [{ id: 'a1', sessionId: 's' }], 10)
  assert.equal(r.spawnedBy[0].state, 'listed')
})
await ok('`missing` is inferred, not observed, so a later listing revives the record', () => {
  const gone = C.settleSpawns([rec({ shortId: 'a1', spawnedAt: 0 })], [], C.SPAWN_GRACE_MS + 1)
  assert.equal(gone.spawnedBy[0].state, 'missing')
  const back = C.settleSpawns(gone.spawnedBy, [{ id: 'a1', sessionId: 'a-full', state: 'working' }], C.SPAWN_GRACE_MS + 2)
  assert.equal(back.changed, true)
  assert.equal(back.spawnedBy[0].state, 'working')
  assert.equal(back.spawnedBy[0].sessionId, 'a-full', 'and it finally learns its session id, so movePending can claim its node')
  // An OBSERVED end is still final: only the inference is revisited.
  for (const s of ['done', 'failed', 'stopped']) {
    const latched = [rec({ shortId: 'a1', state: s })]
    const r = C.settleSpawns(latched, [{ id: 'a1', sessionId: 'a-full', state: 'working' }], 10)
    assert.equal(r.spawnedBy[0], latched[0], s + ' was observed, so it stays final')
    assert.equal(r.changed, false, s)
  }
})
await ok('a record is matched by its full sessionId when the listing omits the short id', () => {
  const before = [rec({ shortId: 'a1', sessionId: 'a-full', state: 'working' })]
  const r = C.settleSpawns(before, [{ sessionId: 'a-full', state: 'done' }], 10)
  assert.equal(r.changed, true)
  assert.equal(r.spawnedBy[0].state, 'done')
})

// ---- pending nodes, pruning, recents -----------------------------------------
await ok('movePending moves a pending node onto the session id once known, or drops it if the session already has one', () => {
  const nodes = { 'pending:a1': { x: 1, y: 1, name: 'n', t: 1 }, 'pending:b2': { x: 2, y: 2, name: 'm', t: 1 }, 'b-full': { x: 9, y: 9, name: 'm', t: 1 } }
  const r = C.movePending(nodes, [rec({ shortId: 'a1', sessionId: 'a-full' }), rec({ shortId: 'b2', sessionId: 'b-full' }), rec({ shortId: 'c3' })])
  assert.equal(r.changed, true)
  assert.deepEqual(Object.keys(r.nodes).sort(), ['a-full', 'b-full'])
  assert.equal(r.nodes['a-full'].x, 1); assert.equal(r.nodes['b-full'].x, 9)
  assert.equal(C.movePending(r.nodes, []).changed, false)
})
await ok('pruneNodes drops only nodes that are neither live nor pending and older than the limit', () => {
  const nodes = { live1: { x: 0, y: 0, name: 'a', t: 0 }, old: { x: 0, y: 0, name: 'b', t: 0 }, recent: { x: 0, y: 0, name: 'c', t: 90 }, 'pending:q': { x: 0, y: 0, name: 'd', t: 0 } }
  const r = C.pruneNodes(nodes, new Set(['live1']), 100, 50)
  assert.deepEqual(Object.keys(r.nodes).sort(), ['live1', 'pending:q', 'recent'])
  assert.equal(r.changed, true)
  assert.equal(C.pruneNodes(r.nodes, new Set(['live1']), 100, 50).changed, false)
})
await ok('a pending node is held for a day and then pruned — it is not immortal', () => {
  const day = C.PENDING_MAX_AGE_MS
  const nodes = { 'pending:young': { x: 0, y: 0, name: 'a', t: 10 }, 'pending:ghost': { x: 0, y: 0, name: 'b', t: 0 } }
  const r = C.pruneNodes(nodes, new Set(), day + 5, C.NODE_MAX_AGE_MS)
  assert.deepEqual(Object.keys(r.nodes), ['pending:young'], 'a spawn that never yielded a sessionId cannot strand a node forever')
  assert.equal(r.changed, true)
})
await ok('pushRecent puts the newest first, dedupes, caps, and reports whether anything changed', () => {
  let r = C.pushRecent([], '/a'); assert.deepEqual(r.recents, ['/a']); assert.equal(r.changed, true)
  r = C.pushRecent(r.recents, '/b'); assert.deepEqual(r.recents, ['/b', '/a'])
  r = C.pushRecent(r.recents, '/a'); assert.deepEqual(r.recents, ['/a', '/b']); assert.equal(r.changed, true)
  r = C.pushRecent(r.recents, '/a'); assert.equal(r.changed, false)
  let many = []
  for (let i = 0; i < 20; i++) many = C.pushRecent(many, '/d' + i).recents
  assert.equal(many.length, C.RECENTS_MAX); assert.equal(many[0], '/d19')
})

// ---- spawnSession with a fake runner (argv asserted as an array) ------
await ok('spawnSession validates, runs the argv array in the validated cwd, records the spawn, and pre-positions the node', async () => {
  const d = tmp(); const real = realpathSync(d)
  const calls = []
  const run = async (bin, argv, opts) => { calls.push({ bin, argv, opts }); return { code: 0, stdout: 'Starting background service…\nbackgrounded · ab12cd34 · alpha\n', stderr: '' } }
  const canvas = C.emptyCanvas()
  const out = await C.spawnSession({ canvas, body: { cwd: d, name: 'alpha', prompt: 'hello', x: 1e12, y: 80 }, run, now: () => 5000, claudeBin: '/fake/claude' })
  assert.equal(out.status, 200, JSON.stringify(out.body))
  assert.equal(out.changed, true)
  assert.equal(out.body.shortId, 'ab12cd34'); assert.equal(out.body.name, 'alpha'); assert.equal(out.body.cwd, real)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].bin, '/fake/claude')
  assert.ok(Array.isArray(calls[0].argv))
  assert.deepEqual(calls[0].argv, ['--bg', '-n', 'alpha', '--permission-mode', 'auto', '--model', 'opus', '--effort', 'high', '--', 'hello'])
  assert.equal(calls[0].opts.cwd, real)
  assert.equal(canvas.spawnedBy.length, 1)
  assert.deepEqual(canvas.spawnedBy[0], { shortId: 'ab12cd34', name: 'alpha', cwd: real, model: 'opus', effort: 'high', spawnedAt: 5000, sessionId: null, state: null })
  assert.deepEqual(canvas.recents, [real])
  // Clamped at both ends, like /api/canvas/move: an unclamped 1e12 puts the
  // pending card where no scroll reaches it, and persists that to world.json.
  assert.deepEqual(canvas.nodes['pending:ab12cd34'], { x: C.COORD_MAX, y: 80, name: 'alpha', t: 5000 })
  assert.equal(C.COORD_MAX, 100_000)
})
await ok('spawnSession tells the child WHICH relay started it, and passes a plugin dir through to the argv', async () => {
  // Without this the spawned session's plugin registers with its hardcoded
  // default port and never appears on the canvas that started it.
  const d = tmp()
  const calls = []
  const run = async (bin, argv, opts) => { calls.push({ bin, argv, opts }); return { code: 0, stdout: 'backgrounded · ab12cd34 · alpha\n', stderr: '' } }
  const out = await C.spawnSession({
    canvas: C.emptyCanvas(), body: { cwd: d, name: 'alpha', prompt: 'hello' }, run, now: () => 0,
    claudeBin: 'c', relayPort: 4550, relayToken: 'tok-4550', pluginDir: '/repo/syzygy',
  })
  assert.equal(out.status, 200, JSON.stringify(out.body))
  // On the ARGV, and ONLY there -- that is what reaches a `--bg` session.
  assert.deepEqual(calls[0].argv.slice(0, 5),
    ['--bg', '--plugin-dir', '/repo/syzygy', '--settings', '{"env":{"SZG_RELAY_PORT":"4550","SZG_RELAY_TOKEN":"tok-4550"}}'])
  // NOT in the child's environment: the daemon a `--bg` launch may cold-start
  // would keep it and hand it to every later background session (F1).
  for (const k of C.RELAY_ONLY_ENV) assert.equal(k in calls[0].opts.env, false, k + ' must not reach the child')
  assert.equal(calls[0].opts.env.PATH, process.env.PATH, 'the rest of the environment is carried, not replaced')
  assert.equal(calls[0].opts.cwd, realpathSync(d))
})
await ok('spawnSession with no relay identity adds no argv, and still strips the relay env', async () => {
  const calls = []
  const run = async (bin, argv, opts) => { calls.push({ argv, opts }); return { code: 0, stdout: 'backgrounded · ab12cd34 · alpha\n', stderr: '' } }
  const d = tmp()
  await C.spawnSession({ canvas: C.emptyCanvas(), body: { cwd: d, prompt: 'hello' }, run, now: () => 0, claudeBin: 'c' })
  assert.equal(calls[0].argv.includes('--plugin-dir'), false)
  assert.equal(calls[0].argv.includes('--settings'), false)
  // The stripping is unconditional. A relay always has SZG_* of its own, and
  // whether it chose to name itself on the argv has nothing to do with whether
  // its configuration should leak into a daemon.
  for (const k of C.RELAY_ONLY_ENV) assert.equal(k in calls[0].opts.env, false, k)
  assert.equal(calls[0].opts.env.PATH, process.env.PATH)
})
await ok('spawnSession refuses a prompt beginning with a dash with 400 and never runs anything', async () => {
  let ran = 0
  const out = await C.spawnSession({ canvas: C.emptyCanvas(), body: { cwd: tmp(), prompt: '--dangerously-skip-permissions' }, run: async () => { ran++; return { code: 0, stdout: '', stderr: '' } }, now: Date.now, claudeBin: 'c' })
  assert.equal(out.status, 400); assert.equal(out.body.error, 'a kickoff prompt may not begin with "-"')
  assert.equal(ran, 0, 'no `claude --bg` was run'); assert.equal(out.changed, false)
})
await ok('spawnSession refuses a bad cwd with 400 and never runs anything', async () => {
  let ran = 0
  const out = await C.spawnSession({ canvas: C.emptyCanvas(), body: { cwd: 'nope', prompt: 'x' }, run: async () => { ran++; return { code: 0, stdout: '', stderr: '' } }, now: Date.now, claudeBin: 'c' })
  assert.equal(out.status, 400); assert.equal(ran, 0); assert.equal(out.changed, false)
})
await ok('spawnSession refuses nothing on count alone: there is no cap', async () => {
  // There is no cap. However many
  // are already live, the next spawn runs; only a bad request or a failing
  // `claude --bg` is ever refused.
  const canvas = C.emptyCanvas()
  canvas.spawnedBy = [rec({ shortId: 'a', state: 'working' }), rec({ shortId: 'b', state: 'working' }), rec({ shortId: 'c', state: 'working' }), rec({ shortId: 'd', state: 'working' })]
  let ran = 0
  const run = async () => { ran++; return { code: 0, stdout: 'backgrounded · ee55 · n\n', stderr: '' } }
  const out = await C.spawnSession({ canvas, body: { cwd: tmp(), prompt: 'x' }, run, now: () => 0, claudeBin: 'c' })
  assert.equal(out.status, 200, JSON.stringify(out.body))
  assert.equal(ran, 1)
  assert.equal(C.liveSpawnCount(canvas.spawnedBy, 0), 5, 'the fifth is live and counted, not refused')
})
await ok('spawnSession reports a failed or unparseable `claude --bg` as 502 and records nothing', async () => {
  const canvas = C.emptyCanvas()
  const out = await C.spawnSession({ canvas, body: { cwd: tmp(), prompt: 'x' }, run: async () => ({ code: 1, stdout: '', stderr: 'boom' }), now: () => 0, claudeBin: 'c' })
  assert.equal(out.status, 502); assert.match(out.body.error, /boom/); assert.equal(canvas.spawnedBy.length, 0)
  const out2 = await C.spawnSession({ canvas, body: { cwd: tmp(), prompt: 'x' }, run: async () => ({ code: 0, stdout: 'nothing useful', stderr: '' }), now: () => 0, claudeBin: 'c' })
  assert.equal(out2.status, 502)
})
await ok('an in-flight spawn counts from the moment it is requested, not from the moment claude answers', async () => {
  // The placeholder outlived the cap it was written for. With no cap the count
  // is the tab's only guard, so it has to be right DURING the spawn -- the
  // seconds in which a second click is likeliest. Both spawns run; the point
  // is that the first is counted while the second is being made.
  const d = tmp()
  let release
  const gate = new Promise((r) => { release = r })
  let ran = 0
  const run = async () => { ran++; await gate; return { code: 0, stdout: 'backgrounded · ab12cd3' + ran + ' · alpha\n', stderr: '' } }
  const canvas = C.emptyCanvas()
  const body = { cwd: d, name: 'alpha', prompt: 'hello' }
  const first = C.spawnSession({ canvas, body, run, now: () => 0, claudeBin: 'c' })
  await Promise.resolve()
  assert.equal(C.liveSpawnCount(canvas.spawnedBy, 0), 1, 'the first spawn counts before its `claude --bg` has answered')
  const second = C.spawnSession({ canvas, body, run, now: () => 0, claudeBin: 'c' })
  await Promise.resolve()
  assert.equal(C.liveSpawnCount(canvas.spawnedBy, 0), 2, 'and so does the second')
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(b.status, 200, JSON.stringify(b.body))
  assert.equal(ran, 2, 'nothing refused either of them')
  assert.equal(canvas.spawnedBy.length, 2, 'each placeholder was replaced, not left beside its real record')
  for (const r of canvas.spawnedBy) { assert.equal(typeof r.shortId, 'string'); assert.equal(r.state, null) }
})
await ok('a spawn that fails or throws leaves no placeholder inflating the count', async () => {
  const canvas = C.emptyCanvas()
  const out = await C.spawnSession({ canvas, body: { cwd: tmp(), prompt: 'x' }, run: async () => ({ code: 1, stdout: '', stderr: 'boom' }), now: () => 0, claudeBin: 'c' })
  assert.equal(out.status, 502)
  assert.deepEqual(canvas.spawnedBy, [], 'no `starting` record survives a failure')
  assert.equal(C.liveSpawnCount(canvas.spawnedBy, 0), 0, 'the count is back to zero')
  await assert.rejects(
    C.spawnSession({ canvas, body: { cwd: tmp(), prompt: 'x' }, run: async () => { throw new Error('spawn exploded') }, now: () => 0, claudeBin: 'c' }),
    /spawn exploded/)
  assert.deepEqual(canvas.spawnedBy, [], 'nor one whose runner threw')
})
await ok('attachSession resolves a short or full id, 404s an unknown one, 409s when tmux fails with the command to run', async () => {
  const canvas = C.emptyCanvas()
  canvas.spawnedBy = [rec({ shortId: 'ab12', sessionId: 'ab12-full', name: 'alpha', cwd: '/r' })]
  const calls = []
  const runOk = async (bin, argv, opts) => { calls.push({ bin, argv, opts }); return { code: 0, stdout: '', stderr: '' } }
  let out = await C.attachSession({ canvas, body: { sessionId: 'ab12-full' }, run: runOk, tmuxBin: 'tmux', claudeBin: 'claude' })
  assert.equal(out.status, 200); assert.equal(out.body.command, 'claude attach ab12'); assert.equal(out.body.window, 'szg-alpha')
  assert.equal(calls[0].bin, 'tmux')
  assert.deepEqual(calls[0].argv, ['new-window', '-d', '-n', 'szg-alpha', '-c', '/r', 'claude', 'attach', 'ab12'])
  out = await C.attachSession({ canvas, body: { sessionId: 'ab12' }, run: runOk, tmuxBin: 'tmux', claudeBin: 'claude' })
  assert.equal(out.status, 200)
  out = await C.attachSession({ canvas, body: { sessionId: 'nope' }, run: runOk, tmuxBin: 'tmux', claudeBin: 'claude' })
  assert.equal(out.status, 404); assert.equal(calls.length, 2)
  out = await C.attachSession({ canvas, body: { sessionId: 'ab12' }, run: async () => ({ code: 1, stdout: '', stderr: 'no server' }), tmuxBin: 'tmux', claudeBin: 'claude' })
  assert.equal(out.status, 409); assert.equal(out.body.command, 'claude attach ab12')
})

// ---- the reset layout: derived from the switchboard's grouping ----
// canvas-layout.js is a CLASSIC script like reconcile.js, so it is evaluated
// here through `new Function` rather than imported.
const MCL = new Function('window', readFileSync(join(ROOT, 'syzygy', 'bridge', 'public', 'canvas-layout.js'), 'utf8') + '\nreturn MCL')({})

const sess = (id, startedAt, tmux) => ({ id, startedAt, tmux, name: id })
const overlaps = (a, b) => a.x < b.x + MCL.NODE_W && b.x < a.x + MCL.NODE_W && a.y < b.y + MCL.NODE_H && b.y < a.y + MCL.NODE_H

await ok('defaultLayout is deterministic: same sessions, any arrival order, same width, same positions', () => {
  const list = [sess('c', 3, 'work'), sess('a', 1, 'work'), sess('b', 2, ''), sess('d', 4, 'play')]
  const one = MCL.defaultLayout(list, { width: 900 })
  const two = MCL.defaultLayout([...list].reverse(), { width: 900 })
  assert.deepEqual(one, two)
  assert.deepEqual(MCL.defaultLayout(list, { width: 900 }), one)
})
await ok('no two nodes overlap and every node has a slot', () => {
  const list = []
  for (let i = 0; i < 17; i++) list.push(sess('s' + i, i, i % 3 === 0 ? '' : 't' + (i % 2)))
  const out = MCL.defaultLayout(list, { width: 700 })
  assert.equal(Object.keys(out).length, 17)
  const ids = Object.keys(out)
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    assert.equal(overlaps(out[ids[i]], out[ids[j]]), false, ids[i] + ' overlaps ' + ids[j])
  }
})
await ok('groups stack top to bottom in first-seen order, the untmuxed bucket last', () => {
  const list = [sess('a', 1, 'beta'), sess('b', 2, ''), sess('c', 3, 'alpha'), sess('d', 4, 'beta')]
  const g = MCL.groupsOf(list)
  assert.deepEqual(g.map((x) => x.key), ['t:beta', 't:alpha', 'none'])
  assert.deepEqual(g.map((x) => x.label), ['beta', 'alpha', 'not in tmux'])
  const out = MCL.defaultLayout(list, { width: 2000 })
  assert.ok(out.a.y < out.c.y && out.c.y < out.b.y, 'beta above alpha above the bucket')
  assert.equal(out.a.y, out.d.y, 'two sessions in one group share a row')
})
await ok('no tmux anywhere means one flat bucket and a single row until it wraps', () => {
  const list = [sess('a', 1, ''), sess('b', 2, ''), sess('c', 3, '')]
  assert.equal(MCL.groupsOf(list).length, 1)
  const wide = MCL.defaultLayout(list, { width: 2000 })
  assert.equal(wide.a.y, wide.c.y)
  const narrow = MCL.defaultLayout(list, { width: 300 })
  assert.ok(narrow.b.y > narrow.a.y, 'one column at 300px')
  assert.equal(narrow.a.x, narrow.b.x)
})
await ok('an unknown width falls back to four columns and an empty list to an empty map', () => {
  const list = []
  for (let i = 0; i < 5; i++) list.push(sess('s' + i, i, ''))
  const out = MCL.defaultLayout(list, {})
  assert.equal(out.s4.y > out.s0.y, true, 'the fifth wraps')
  assert.equal(out.s3.y, out.s0.y, 'four fit on the first row')
  assert.deepEqual(MCL.defaultLayout([], { width: 500 }), {})
})

// ---- the live relay: real subprocess, fake `claude` ------------------
// The endpoints live in relay.mjs's HTTP handler, so they are tested against
// the REAL relay rather than a re-implementation that could drift. Isolated on
// three axes: SZG_PORT=0 (OS-assigned -- never 4317/4319/4321), SZG_DATA_DIR
// (a throwaway dir -- never ~/.claude/syzygy) and SZG_CLAUDE_BIN (a
// script that prints what `claude --bg` prints and records its argv). No test
// here starts a real session.
{
  const { spawn } = await import('node:child_process')
  const dataDir = tmp()
  const fakeDir = tmp()
  const argvFile = join(fakeDir, 'argv.txt'), cwdFile = join(fakeDir, 'cwd.txt'), countFile = join(fakeDir, 'count.txt'), agentsFile = join(fakeDir, 'agents.json')
  const agentsCountFile = join(fakeDir, 'agents-count.txt'), slowFile = join(fakeDir, 'slow')
  const envFile = join(fakeDir, 'env.txt'), relayEnvFile = join(fakeDir, 'relay-env.txt')
  writeFileSync(agentsFile, '[]')
  // The name is the argument after `-n`, which is not a fixed position once
  // `--plugin-dir` may precede it -- so it is scanned for rather than read off
  // `$3`. Each spawn gets a fresh short id from the counter. `agents` prints
  // whatever the harness last wrote to agents.json. The two SZG_RELAY_*
  // variables are recorded because they are the whole of item 1: a session
  // that cannot see them registers with the wrong relay.
  const fakeBin = join(fakeDir, 'claude')
  writeFileSync(fakeBin, [
    '#!/bin/sh',
    // The relay picks its `claude` by capability now, so the fake must answer
    // --help the way a capable one does or the relay disables both endpoints.
    // FIRST branch: --version is asked right after, and only on success.
    'if [ "$1" = "--help" ]; then echo "  --bg   run in the background"; echo "  attach   attach to a session"; exit 0; fi',
    'if [ "$1" = "--version" ]; then echo "0.0.0-fake (canvas harness)"; exit 0; fi',
    // The listing branch counts its own invocations (so a test can prove the
    // poller asked exactly as often as it should) and, while the slow marker
    // exists, takes a whole second -- longer than the harness's 300 ms poll --
    // so a missing re-entrancy guard shows up as stacked invocations.
    'if [ "$1" = "agents" ]; then a=$(cat "' + agentsCountFile + '" 2>/dev/null || echo 0); echo $((a+1)) > "' + agentsCountFile + '"; [ -f "' + slowFile + '" ] && sleep 1; cat "' + agentsFile + '"; exit 0; fi',
    'n=$(cat "' + countFile + '" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "' + countFile + '"',
    'printf "%s\\n" "$@" > "' + argvFile + '"',
    'pwd -P > "' + cwdFile + '"',
    '{ printenv SZG_RELAY_PORT; printenv SZG_RELAY_TOKEN; } > "' + envFile + '"',
    '{ printenv SZG_PORT; printenv SZG_TOKEN; printenv SZG_DATA_DIR; printenv SZG_CLAUDE_BIN; printenv SZG_SPAWN_PLUGIN_DIR; } > "' + relayEnvFile + '"',
    'name=""; prev=""',
    'for a in "$@"; do if [ "$prev" = "-n" ]; then name="$a"; break; fi; prev="$a"; done',
    'echo "Starting background service…"',
    'echo "backgrounded · fake000$n · $name"',
    '',
  ].join('\n'))
  chmodSync(fakeBin, 0o755)
  // Seed world.json BEFORE the relay starts: loadWorld() reads it once, at
  // boot, and a stale node is by definition one whose session is not live --
  // which a running relay can never produce inside a test's lifetime
  // (SESSION_TTL_MS is 90 s). Three stale nodes: one unique name, two sharing.
  // Stamped NOW, not long ago: the poller prunes a stale node older
  // than NODE_MAX_AGE_MS, and it must not eat these before the checks run.
  writeFileSync(join(dataDir, 'world.json'), JSON.stringify({
    version: 1, projects: {},
    canvas: { nodes: {
      'old-omega': { x: 300, y: 200, name: 'omega', t: Date.now() },
      'dup-a': { x: 10, y: 10, name: 'delta', t: Date.now() },
      'dup-b': { x: 20, y: 20, name: 'delta', t: Date.now() },
    }, spawnedBy: [], recents: [] },
  }))
  const rootDir = realpathSync(tmp())
  const RELAY_TOKEN = 'canvas-harness-token'
  // The dev knob's value for this relay. Any absolute path does: the fake
  // `claude` only records the argv it was handed.
  const PLUGIN_DIR = join(ROOT, 'syzygy')
  const relayPath = join(ROOT, 'syzygy', 'bridge', 'relay.mjs')
  const child = spawn(process.execPath, [relayPath], {
    // Started inside a git worktree, deliberately: the relay derives the
    // canvas's `home` from its own cwd (widened to the git worktree root),
    // and the check below asserts that value.
    cwd: ROOT,
    env: {
      ...process.env, SZG_PORT: '0', SZG_TOKEN: RELAY_TOKEN, SZG_DATA_DIR: dataDir, SZG_CLAUDE_BIN: fakeBin,
      SZG_TMUX_BIN: '/usr/bin/false', SZG_CANVAS_POLL_MS: '300', SZG_SPAWN_PLUGIN_DIR: PLUGIN_DIR,
      SZG_PANE_PASSWORD_DISABLED: '1', // this harness's own GETs (state()) carry no cookie
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
  const state = async () => (await fetch(base + '/api/state')).json()
  const register = (id, name, extra = {}) => post('/api/register', { session: { id, name, cwd: rootDir, root: rootDir, ...extra } })

  try {
    await ok('the snapshot carries the canvas -- the seeded nodes, the live count, home, and no cap', async () => {
      const s = await state()
      assert.deepEqual(Object.keys(s.canvas.nodes).sort(), ['dup-a', 'dup-b', 'old-omega'])
      assert.deepEqual(s.canvas.spawnedBy, []); assert.deepEqual(s.canvas.recents, [])
      assert.equal(s.canvas.live, 0)
      assert.equal('cap' in s.canvas, false, 'the payload carries no cap')
      // `home` is where the spawn form starts when there is no recent to start
      // it from. The relay runs from a checkout, so it is that worktree's root.
      assert.equal(s.canvas.home, realpathSync(ROOT), 'home is the relay\'s own git worktree root')
    })

    await ok('POST /api/canvas/complete lists real directories, hides files and dotfiles, and needs the token', async () => {
      // One live check against a real tree: the pure ones above inject `list`,
      // so nothing there proves readdir is ever actually called.
      const treeDir = realpathSync(tmp())
      for (const d of ['apple', 'apricot', 'banana', '.hidden']) mkdirSync(join(treeDir, d))
      writeFileSync(join(treeDir, 'apex.txt'), 'x')
      assert.deepEqual((await post('/api/canvas/complete', { path: join(treeDir, 'ap') })).dirs,
        [join(treeDir, 'apple'), join(treeDir, 'apricot')])
      assert.deepEqual((await post('/api/canvas/complete', { path: treeDir + '/' })).dirs,
        [join(treeDir, 'apple'), join(treeDir, 'apricot'), join(treeDir, 'banana')], 'no file, no dotfile')
      assert.deepEqual((await post('/api/canvas/complete', { path: join(treeDir, '.h') })).dirs, [join(treeDir, '.hidden')])
      // Never a 500, whatever is typed at it.
      const gone = await post('/api/canvas/complete', { path: join(treeDir, 'nope', 'deeper') })
      assert.equal(gone.status, 200); assert.deepEqual(gone.dirs, [])
      const noToken = await fetch(`${base}/api/canvas/complete`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: treeDir + '/' }),
      })
      assert.equal(noToken.status, 401, 'directory names are not free to anything that can reach the port')
      rmSync(treeDir, { recursive: true, force: true })
    })

    await ok('POST /api/canvas/move stores a position and the session name; bad input is 400', async () => {
      await register('s1', 'alpha')
      assert.equal((await post('/api/canvas/move', { id: 's1', x: 40.6, y: 12 })).status, 200)
      const n = (await state()).canvas.nodes.s1
      assert.equal(n.x, 41); assert.equal(n.y, 12); assert.equal(n.name, 'alpha'); assert.equal(typeof n.t, 'number')
      assert.equal((await post('/api/canvas/move', { id: 's1', x: 'no', y: 1 })).status, 400)
      assert.equal((await post('/api/canvas/move', { x: 1, y: 1 })).status, 400)
    })

    await ok('POST /api/canvas/move refuses the three prototype keys, writing nothing', async () => {
      // `world.canvas.nodes` is a plain object literal, so nodes['__proto__']
      // = {...} sets its PROTOTYPE instead of adding a key: the endpoint
      // answered 200, /api/state showed no such node, and every later node
      // silently inherited x/y/name from it.
      for (const id of ['__proto__', 'constructor', 'prototype']) {
        const r = await post('/api/canvas/move', { id, x: 5, y: 5 })
        assert.equal(r.status, 400, id)
        // Not 'id, x and y required' -- all three WERE supplied, and that
        // message sends whoever reads it hunting the wrong bug.
        assert.equal(r.error, 'invalid id', id)
      }
      const c = (await state()).canvas
      for (const id of ['__proto__', 'constructor', 'prototype']) {
        assert.equal(Object.prototype.hasOwnProperty.call(c.nodes, id), false, id)
      }
    })

    await ok('POST /api/canvas/move clamps a position to the canvas bounds at both ends', async () => {
      assert.equal((await post('/api/canvas/move', { id: 'clamp-me', x: 1e12, y: -50 })).status, 200)
      const n = (await state()).canvas.nodes['clamp-me']
      assert.equal(n.x, 100000, 'clamped from above, not stored as 1e12')
      assert.equal(n.y, 0, 'and still floored at zero')
    })

    await ok('a registering session inherits the SEEDED stale node by name, and the donor key is gone', async () => {
      // world.json was seeded before the relay started with a stale node
      // named 'omega' at (300, 200) under an id no live session has.
      await register('n1', 'omega')
      const c = (await state()).canvas
      assert.deepEqual({ x: c.nodes.n1.x, y: c.nodes.n1.y, name: c.nodes.n1.name }, { x: 300, y: 200, name: 'omega' })
      assert.equal(c.nodes['old-omega'], undefined, 'the stale key is retired, not duplicated')
    })

    await ok('two stale nodes sharing a name: the registering session inherits nothing', async () => {
      await register('n2', 'delta')
      const c = (await state()).canvas
      assert.equal(c.nodes.n2, undefined)
      assert.ok(c.nodes['dup-a'] && c.nodes['dup-b'], 'both stale nodes are left exactly where they were')
    })

    await ok('a live session already wearing the name: the newcomer inherits nothing', async () => {
      // s1 is live and named 'alpha' with a stored position (moved above).
      // A second live 'alpha' cannot be told apart from it.
      await register('s2', 'alpha')
      const c = (await state()).canvas
      assert.equal(c.nodes.s2, undefined)
      assert.equal(c.nodes.s1.x, 41, 's1 keeps its own position')
    })

    await ok('a registering session pushes its root onto recents, newest first', async () => {
      const c = (await state()).canvas
      assert.equal(c.recents[0], rootDir)
    })

    await ok('POST /api/canvas/reset empties positions and touches nothing else', async () => {
      const before = (await state()).canvas
      assert.ok(Object.keys(before.nodes).length > 0)
      assert.equal((await post('/api/canvas/reset')).status, 200)
      const after = (await state()).canvas
      assert.deepEqual(after.nodes, {})
      assert.deepEqual(after.spawnedBy, before.spawnedBy)
      assert.deepEqual(after.recents, before.recents)
      assert.equal((await state()).sessions.length, 4, 'reset never removes a session')
    })

    await ok('POST /api/spawn refuses a bad cwd, an empty prompt, a dash-leading prompt and an unknown model with 400, running nothing', async () => {
      assert.equal((await post('/api/spawn', { cwd: 'rel', prompt: 'x' })).status, 400)
      assert.equal((await post('/api/spawn', { cwd: rootDir, prompt: '' })).status, 400)
      assert.equal((await post('/api/spawn', { cwd: rootDir, prompt: 'x', model: 'gpt' })).status, 400)
      const dash = await post('/api/spawn', { cwd: rootDir, prompt: '--dangerously-skip-permissions' })
      assert.equal(dash.status, 400); assert.equal(dash.error, 'a kickoff prompt may not begin with "-"')
      assert.equal(existsSync(argvFile), false, 'the fake claude was never invoked')
    })

    await ok('POST /api/spawn runs the fake claude with the argv ARRAY, in the validated cwd, and records the spawn', async () => {
      const r = await post('/api/spawn', { cwd: rootDir, name: 'alpha', prompt: 'plan the thing', x: 400, y: 300 })
      assert.equal(r.status, 200, JSON.stringify(r))
      assert.equal(r.shortId, 'fake0001'); assert.equal(r.name, 'alpha'); assert.equal(r.cwd, rootDir)
      const argv = readFileSync(argvFile, 'utf8').split('\n').filter((l, i, a) => i < a.length - 1)
      // SZG_SPAWN_PLUGIN_DIR is set for this relay, so --plugin-dir is here --
      // before the sentinel, where an option belongs. Item 1, end to end: the
      // child is told the port this relay ACTUALLY bound (SZG_PORT=0, so it is
      // nothing like the requested one) and this relay's token. A session that
      // cannot read those two joins the wrong board and never appears on the
      // canvas that started it.
      const settings = JSON.stringify({ env: { SZG_RELAY_PORT: String(port), SZG_RELAY_TOKEN: RELAY_TOKEN } })
      assert.deepEqual(argv, ['--bg', '--plugin-dir', PLUGIN_DIR, '--settings', settings, '-n', 'alpha', '--permission-mode', 'auto', '--model', 'opus', '--effort', 'high', '--', 'plan the thing'])
      assert.equal(readFileSync(cwdFile, 'utf8').trim(), rootDir, 'the child ran IN the validated cwd')
      // And NOWHERE ELSE. The child's environment carries none of the relay's
      // own SZG_* variables: a `--bg` launch can cold-start the daemon that
      // every later background session on the machine then inherits from (F1).
      // `printenv` of an unset name prints nothing, so both lines are empty.
      assert.equal(readFileSync(envFile, 'utf8').trim(), '',
        'SZG_RELAY_PORT and SZG_RELAY_TOKEN are unset in the child')
      assert.equal(readFileSync(relayEnvFile, 'utf8').trim(), '',
        'and so are SZG_PORT, SZG_TOKEN, SZG_DATA_DIR, SZG_CLAUDE_BIN and SZG_SPAWN_PLUGIN_DIR')
      const c = (await state()).canvas
      assert.equal(c.spawnedBy.length, 1)
      assert.equal(c.spawnedBy[0].shortId, 'fake0001'); assert.equal(c.spawnedBy[0].state, null)
      assert.equal(c.live, 1, 'a fresh spawn counts until a successful listing rules on it')
      assert.deepEqual({ x: c.nodes['pending:fake0001'].x, y: c.nodes['pending:fake0001'].y, name: c.nodes['pending:fake0001'].name }, { x: 400, y: 300, name: 'alpha' })
      assert.equal(c.recents[0], rootDir)
    })

    await ok('a second and a third live spawn are started, not refused, and the live count follows', async () => {
      assert.equal((await post('/api/spawn', { cwd: rootDir, name: 'beta', prompt: 'x' })).status, 200)
      const r = await post('/api/spawn', { cwd: rootDir, name: 'gamma', prompt: 'x' })
      assert.equal(r.status, 200, JSON.stringify(r))
      const c = (await state()).canvas
      assert.equal(c.spawnedBy.length, 3)
      assert.equal(c.live, 3, 'the count, not a cap, is what says how many are running')
    })

    await ok('POST /api/attach: unknown id is 404; a known one reports the command', async () => {
      assert.equal((await post('/api/attach', { sessionId: 'nope' })).status, 404)
      // tmux may or may not be running where the tests run, and the test must not
      // open a window either way: SZG_TMUX_BIN is pointed at /usr/bin/false
      // for the relay under test, so the only reachable outcome is 409.
      const r = await post('/api/attach', { sessionId: 'fake0001' })
      assert.equal(r.status, 409)
      // Built from the RESOLVED binary, not a bare `claude`: on a machine with
      // two installs the bare name is the one command that does not work, and
      // this string is shown to somebody about to paste it.
      assert.equal(r.command, `${fakeBin} attach fake0001`)
    })

    await ok('/api/health reports the port it actually BOUND', async () => {
      // SZG_PORT=0 here, so a health check echoing the requested port would say
      // 0 -- a number nothing is listening on.
      const h = await (await fetch(base + '/api/health')).json()
      assert.equal(h.ok, true)
      assert.equal(h.port, port, 'the bound port, never the requested one')
      assert.notEqual(h.port, 0)
    })

    await ok('the poller folds `claude agents --json` onto the ledger, moves the pending node, and brings the count down', async () => {
      writeFileSync(agentsFile, JSON.stringify([
        { id: 'fake0001', sessionId: 'sess-alpha', kind: 'background', state: 'working' },
        { id: 'fake0002', sessionId: 'sess-beta', kind: 'background', state: 'done' },
        { id: 'fake0003', sessionId: 'sess-gamma', kind: 'background', state: 'done' },
      ]))
      // SZG_CANVAS_POLL_MS=300 for the relay under test; wait for two passes.
      let c
      for (let i = 0; i < 40; i++) {
        c = (await state()).canvas
        if (c.spawnedBy[1]?.state === 'done') break
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.equal(c.spawnedBy[0].sessionId, 'sess-alpha'); assert.equal(c.spawnedBy[0].state, 'working')
      assert.equal(c.spawnedBy[1].state, 'done')
      assert.equal(c.live, 1, 'the two done sessions no longer count')
      assert.equal(c.nodes['pending:fake0001'], undefined, 'the pending node moved onto the session id')
      assert.equal(c.nodes['sess-alpha'].x, 400)
    })

    await ok('a failing `claude agents --json` says so on stderr ONCE per streak, and keeps the records counted', async () => {
      // The one case where the cap stays shut on its own, so the cause has to
      // be visible or `cap reached` looks like a bug in the canvas. The fake
      // binary `cat`s agents.json, so invalid JSON there is a listing that
      // exits 0 and cannot be parsed -- the second of the two failure shapes.
      const lines = () => stderrText.split('\n').filter((l) => l.startsWith('canvas: claude agents --json failed')).length
      const until = async (want, ms = 6000) => {
        for (let i = 0; i < ms / 100; i++) { if (lines() >= want) return; await new Promise((r) => setTimeout(r, 100)) }
      }
      assert.equal(lines(), 0, 'nothing yet: every listing so far succeeded')
      const liveBefore = (await state()).canvas.live
      writeFileSync(agentsFile, 'not json at all')
      await until(1)
      assert.equal(lines(), 1, 'the failure is reported')
      await new Promise((r) => setTimeout(r, 1500))   // five more poll passes
      assert.equal(lines(), 1, 'and reported ONCE per streak, not every 300 ms')
      assert.equal((await state()).canvas.live, liveBefore, 'a failed listing rules on nothing, so nothing stops counting')
      writeFileSync(agentsFile, JSON.stringify([{ id: 'fake0001', sessionId: 'sess-alpha', kind: 'background', state: 'working' }]))
      await new Promise((r) => setTimeout(r, 1500))   // let a listing succeed
      assert.equal(lines(), 1, 'a success writes nothing')
      writeFileSync(agentsFile, 'not json again')
      await until(2)
      assert.equal(lines(), 2, 'a success clears the flag, so the NEXT streak is reported too')
      writeFileSync(agentsFile, JSON.stringify([{ id: 'fake0001', sessionId: 'sess-alpha', kind: 'background', state: 'working' }]))
      await new Promise((r) => setTimeout(r, 1500))   // let a listing succeed again
      // Valid JSON that is not an array is not a listing: settleSpawns ignores
      // it, so the poller must report it as a failure rather than let it clear
      // the streak flag and silence a real streak.
      writeFileSync(agentsFile, JSON.stringify({ agents: [] }))
      await until(3)
      assert.equal(lines(), 3, 'a JSON object where an array was expected is reported as a failure')
      assert.match(stderrText, /not a JSON array/)
      writeFileSync(agentsFile, JSON.stringify([{ id: 'fake0001', sessionId: 'sess-alpha', kind: 'background', state: 'working' }]))
      await new Promise((r) => setTimeout(r, 1000))
    })

    await ok('the poller never overlaps itself: a listing slower than the poll interval is asked once at a time', async () => {
      // Same hazard rescan() guards against in relay.mjs: realRun's timeout is
      // longer than the cadence, so an unguarded setInterval stacks a new
      // `claude agents` on a stuck one every pass. With the fake taking 1 s
      // and a 300 ms poll, an unguarded poller asks ~5 times in 1.6 s; a
      // guarded one asks at most twice.
      const count = () => Number(readFileSync(agentsCountFile, 'utf8').trim() || 0)
      writeFileSync(slowFile, '')
      await new Promise((r) => setTimeout(r, 350))     // let any in-flight fast pass finish
      const before = count()
      await new Promise((r) => setTimeout(r, 1600))
      const asked = count() - before
      rmSync(slowFile, { force: true })
      assert.ok(asked >= 1, 'the poller kept asking while slow (' + asked + ')')
      assert.ok(asked <= 2, 'but never stacked a new listing on a stuck one (' + asked + ' in 1.6 s)')
      await new Promise((r) => setTimeout(r, 1200))    // let the last slow pass drain
    })

    await ok('SIGINT flushes the canvas to world.json', async () => {
      // n1 inherited 'omega' at (300, 200) earlier, but the reset check above
      // empties nodes -- so put a plain moved node back, to prove the flush
      // carries a position keyed by a LIVE session id and not only the
      // spawn-derived ones. n1 is still registered, so the name comes from it.
      await post('/api/canvas/move', { id: 'n1', x: 300, y: 200 })
      child.kill('SIGINT')
      await new Promise((r) => child.on('exit', r))
      const w = JSON.parse(readFileSync(join(dataDir, 'world.json'), 'utf8'))
      assert.equal(w.canvas.spawnedBy.length, 3)
      assert.equal(w.canvas.nodes['sess-alpha'].x, 400)
      assert.equal(w.canvas.nodes.n1.name, 'omega')
    })
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)) }
  }
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(fakeDir, { recursive: true, force: true })
}

// ---- closing a session ------------------------------------------------------
// The decision is pure and the two mechanisms are genuinely different
// promises, so it is asserted by mechanism rather than by "it did something".

await ok('killPlan stops a background session by its short id', () => {
  assert.deepEqual(C.killPlan({ kind: 'background', shortId: 'abc123', pid: 999 }),
    { mode: 'stop', argv: ['stop', 'abc123'], label: 'stop' })
})

await ok('killPlan signals an interactive session by the pid it registered', () => {
  assert.deepEqual(C.killPlan({ kind: '', pid: 4242 }), { mode: 'signal', pid: 4242, label: 'close' })
  assert.deepEqual(C.killPlan({ kind: 'interactive', pid: '4242' }), { mode: 'signal', pid: 4242, label: 'close' })
})

await ok('killPlan refuses rather than guessing when it has neither', () => {
  for (const bad of [{}, { kind: 'background' }, { pid: 0 }, { pid: 1 }, { pid: -3 }, { pid: 'x' }, { pid: 1.5 }]) {
    assert.equal(C.killPlan(bad).mode, 'none', JSON.stringify(bad) + ' was not refused')
  }
  // pid 1 and 0 by name: 0 means "this whole process group" to kill(2) and 1 is
  // init. Neither is ever a Claude session and both are catastrophic.
  assert.equal(C.killPlan({ pid: 1 }).mode, 'none')
  assert.equal(C.killPlan({ pid: 0 }).mode, 'none')
})

await ok('killPlan prefers `claude stop` over the pid for a background session', () => {
  assert.equal(C.killPlan({ kind: 'background', shortId: 's1', pid: 77 }).mode, 'stop')
  // ...and falls back to the pid when the listing gave no short id.
  assert.equal(C.killPlan({ kind: 'background', shortId: '', pid: 77 }).mode, 'signal')
})

await ok('killSession runs `claude stop` by ARGV and never a shell string', async () => {
  const calls = []
  const out = await C.killSession({
    plan: C.killPlan({ kind: 'background', shortId: 'zz9' }),
    claudeBin: '/fake/claude',
    run: async (bin, argv, opts) => { calls.push({ bin, argv, opts }); return { code: 0, stdout: '', stderr: '' } },
    signal: () => { throw new Error('must not signal a background session') },
  })
  assert.equal(out.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].bin, '/fake/claude')
  assert.deepEqual(calls[0].argv, ['stop', 'zz9'])
  assert.ok(Array.isArray(calls[0].argv), 'the argv must be an array')
})

await ok('killSession reports a failed `claude stop` as 502 with the reason', async () => {
  const out = await C.killSession({
    plan: C.killPlan({ kind: 'background', shortId: 'zz9' }),
    claudeBin: '/fake/claude',
    run: async () => ({ code: 1, stdout: '', stderr: 'no such agent' }),
    signal: () => {},
  })
  assert.equal(out.status, 502)
  assert.match(out.body.error, /no such agent/)
})

await ok('killSession with no claude binary answers 503, never a signal', async () => {
  const out = await C.killSession({
    plan: C.killPlan({ kind: 'background', shortId: 'zz9' }),
    claudeBin: null,
    run: async () => { throw new Error('must not run') },
    signal: () => { throw new Error('must not signal') },
  })
  assert.equal(out.status, 503)
})

await ok('killSession sends exactly one SIGTERM to exactly the registered pid', async () => {
  const sent = []
  const out = await C.killSession({
    plan: C.killPlan({ pid: 4242 }),
    run: async () => { throw new Error('must not run a command for an interactive session') },
    signal: (pid, sig) => sent.push([pid, sig]),
  })
  assert.equal(out.status, 200)
  assert.deepEqual(sent, [[4242, 'SIGTERM']])
})

await ok('killSession treats ESRCH as done, not as a failure', async () => {
  const gone = Object.assign(new Error('no such process'), { code: 'ESRCH' })
  const out = await C.killSession({
    plan: C.killPlan({ pid: 4242 }),
    run: async () => {},
    signal: () => { throw gone },
  })
  assert.equal(out.status, 200)
  assert.equal(out.body.mode, 'gone')
})

await ok('killSession answers 409 for a plan it cannot make, and touches nothing', async () => {
  const out = await C.killSession({
    plan: C.killPlan({}),
    run: async () => { throw new Error('must not run') },
    signal: () => { throw new Error('must not signal') },
  })
  assert.equal(out.status, 409)
  assert.match(out.body.error, /no pid/)
})

// ---- probeSafeMode ----------------------------------------------------------
await ok('probeSafeMode reads the binary\'s own --help, and defaults to false', async () => {
  const help = async () => ({ code: 0, stdout: '  --safe-mode   Start with all customizations disabled\n', stderr: '' })
  assert.equal(await C.probeSafeMode('/fake/claude', help), true)
  assert.equal(await C.probeSafeMode('/fake/claude', async () => ({ code: 0, stdout: '  --bg\n', stderr: '' })), false)
  assert.equal(await C.probeSafeMode('/fake/claude', async () => ({ code: 1, stdout: '', stderr: 'boom' })), false)
  assert.equal(await C.probeSafeMode('/fake/claude', async () => { throw new Error('ENOENT') }), false)
  assert.equal(await C.probeSafeMode(null, async () => { throw new Error('must not run') }), false)
})

await ok('HEADLESS_SETTINGS is the one spelling both spawners use', () => {
  assert.deepEqual(JSON.parse(C.HEADLESS_SETTINGS), { env: { SZG_HEADLESS: '1' } })
})

// ---- jumping to a session's terminal ----------------------------------------

await ok('parseTmuxTarget takes the pid file\'s field apart, or refuses it', () => {
  assert.deepEqual(J.parseTmuxTarget('work:@3.%17'), { session: 'work', window: '@3', pane: '%17' })
  for (const bad of ['', null, undefined, 'work', 'work:3.17', 'work:@3', '@3.%17', 'a:b:@3.%1', 42]) {
    assert.equal(J.parseTmuxTarget(bad), null, JSON.stringify(bad) + ' was parsed')
  }
})

await ok('tmuxOfPid reads the field server-side, and degrades to "" on everything', () => {
  const files = { '/reg/4242.json': JSON.stringify({ tmux: 'work:@3.%17', other: 1 }) }
  const readFile = (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f] }
  assert.equal(J.tmuxOfPid({ pid: 4242, dir: '/reg', readFile }), 'work:@3.%17')
  assert.equal(J.tmuxOfPid({ pid: 9, dir: '/reg', readFile }), '', 'no such file')
  assert.equal(J.tmuxOfPid({ pid: 1, dir: '/reg', readFile }), '', 'pid 1 is never asked for')
  assert.equal(J.tmuxOfPid({ pid: 'x', dir: '/reg', readFile }), '')
  files['/reg/7.json'] = 'not json'
  assert.equal(J.tmuxOfPid({ pid: 7, dir: '/reg', readFile }), '')
  files['/reg/8.json'] = JSON.stringify({ tmux: 17 })
  assert.equal(J.tmuxOfPid({ pid: 8, dir: '/reg', readFile }), '', 'a non-string field is not a target')
})

await ok('jumpCase covers the four cases, and being IN tmux always wins', () => {
  assert.equal(J.jumpCase({ tmux: 'w:@1.%2', kind: '', pidAlive: true }).case, 'tmux')
  // A background session that is nevertheless sitting in a tmux pane is jumped
  // to where it already is, rather than attached to a second time.
  assert.equal(J.jumpCase({ tmux: 'w:@1.%2', kind: 'background', pidAlive: true }).case, 'tmux')
  assert.equal(J.jumpCase({ tmux: '', kind: 'background', pidAlive: true }).case, 'background')
  assert.equal(J.jumpCase({ tmux: '', kind: '', pidAlive: false }).case, 'resume')
  assert.equal(J.jumpCase({ tmux: '', kind: '', pidAlive: true }).case, 'outside')
  assert.equal(J.jumpCase({}).case, 'resume', 'nothing known at all is not a live terminal')
  assert.equal(typeof J.jumpCase({}).label, 'string')
})

await ok('pickClient takes the MOST RECENTLY ACTIVE client, not the first', () => {
  const text = '/dev/ttys004 1789000000 501\n/dev/ttys009 1789999999 777\n/dev/ttys011 1788000000 99\n'
  assert.deepEqual(J.pickClient(text), { name: '/dev/ttys009', activity: 1789999999, pid: 777 })
  assert.equal(J.pickClient(''), null)
  assert.equal(J.pickClient('garbage without numbers'), null)
  assert.equal(J.pickClient(null), null)
})

await ok('appOfTree finds the bundle by walking up, and refuses to guess', () => {
  assert.equal(J.appOfTree(['tmux', '-zsh', 'login', '/Applications/Ghostty.app/Contents/MacOS/ghostty']),
    '/Applications/Ghostty.app')
  assert.equal(J.appOfTree(['/Applications/iTerm.app']), '/Applications/iTerm.app')
  assert.equal(J.appOfTree(['tmux', 'zsh', 'login']), null, 'no bundle means no `open -a`')
  assert.equal(J.appOfTree([]), null)
  assert.equal(J.appOfTree(undefined), null)
})

await ok('ancestorCommands walks ppids and cannot loop forever', async () => {
  const tree = { 100: [50, 'tmux'], 50: [10, 'login'], 10: [1, '/Applications/Ghostty.app/Contents/MacOS/ghostty'] }
  const run = async (_bin, argv) => {
    const pid = Number(argv[argv.length - 1])
    if (!(pid in tree)) return { code: 1, stdout: '', stderr: '' }
    return { code: 0, stdout: `  ${tree[pid][0]} ${tree[pid][1]}\n`, stderr: '' }
  }
  assert.deepEqual(await J.ancestorCommands({ pid: 100, run }),
    ['tmux', 'login', '/Applications/Ghostty.app/Contents/MacOS/ghostty'])
  // A self-parenting process would otherwise spin until the timeout.
  const loop = async () => ({ code: 0, stdout: '  7 spinner\n', stderr: '' })
  assert.deepEqual(await J.ancestorCommands({ pid: 7, run: loop }), ['spinner'])
})

await ok('case 1 switches the client, selects the pane, and raises the app by ARGV', async () => {
  const calls = []
  const run = async (bin, argv) => {
    calls.push([bin, ...argv].join(' '))
    if (argv[0] === 'list-clients') return { code: 0, stdout: '/dev/ttys009 99 777\n', stderr: '' }
    if (bin === 'ps') return { code: 0, stdout: '  1 /Applications/Ghostty.app/Contents/MacOS/ghostty\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const out = await J.jumpToSession({
    sess: { id: 's1', pid: 4242, tmux: 'work:@3.%17' }, run, tmuxBin: 'tmux', claudeBin: '/fake/claude',
    pidAlive: () => true,
  })
  assert.equal(out.status, 200)
  assert.equal(out.body.case, 'tmux')
  assert.equal(out.body.app, '/Applications/Ghostty.app')
  assert.ok(calls.includes('tmux switch-client -c /dev/ttys009 -t work:@3'), calls.join(' | '))
  assert.ok(calls.includes('tmux select-pane -t %17'), calls.join(' | '))
  assert.ok(calls.includes('open -a /Applications/Ghostty.app'), calls.join(' | '))
  // No AppleScript, no osascript, no Accessibility -- the standing rule.
  assert.ok(!calls.some((c) => /osascript|System Events|AXUIElement/i.test(c)), calls.join(' | '))
})

await ok('case 1 answers 409 when the pane has gone, rather than claiming success', async () => {
  const run = async (_bin, argv) => {
    if (argv[0] === 'list-clients') return { code: 0, stdout: '/dev/ttys009 99 777\n', stderr: '' }
    if (argv[0] === 'select-pane') return { code: 1, stdout: '', stderr: "can't find pane" }
    return { code: 0, stdout: '', stderr: '' }
  }
  const out = await J.jumpToSession({ sess: { id: 's1', pid: 1, tmux: 'w:@1.%2' }, run, pidAlive: () => true })
  assert.equal(out.status, 409)
  assert.match(out.body.error, /no longer in tmux/)
})

await ok('case 2 attaches a background session in a new window, by ARGV', async () => {
  const calls = []
  const run = async (bin, argv) => {
    calls.push({ bin, argv })
    if (argv[0] === 'new-window') return { code: 0, stdout: 'work:@9.%40\n', stderr: '' }
    if (argv[0] === 'list-clients') return { code: 0, stdout: '/dev/ttys009 99 777\n', stderr: '' }
    return { code: 0, stdout: '  1 zsh\n', stderr: '' }
  }
  const out = await J.jumpToSession({
    sess: { id: 'sess-1', shortId: 'ab12', kind: 'background', name: 'worker', cwd: '/tmp' },
    run, claudeBin: '/fake/claude', pidAlive: () => false,
  })
  assert.equal(out.status, 200)
  assert.equal(out.body.case, 'background')
  const nw = calls.find((c) => c.argv[0] === 'new-window')
  assert.ok(Array.isArray(nw.argv), 'the argv must be an array')
  assert.deepEqual(nw.argv.slice(-3), ['/fake/claude', 'attach', 'ab12'])
  assert.ok(nw.argv.includes('-P'), 'without -P -F the new window cannot then be focused')
  assert.equal(out.body.target, 'work:@9.%40')
})

await ok('case 3 resumes a DEAD session, never a live one', async () => {
  const calls = []
  const run = async (bin, argv) => {
    calls.push(argv)
    if (argv[0] === 'new-window') return { code: 0, stdout: 'work:@9.%41\n', stderr: '' }
    if (argv[0] === 'list-clients') return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const out = await J.jumpToSession({
    sess: { id: 'dead-1', name: 'gone', cwd: '/tmp' }, run, claudeBin: '/fake/claude', pidAlive: () => false,
  })
  assert.equal(out.body.case, 'resume')
  assert.deepEqual(calls.find((a) => a[0] === 'new-window').slice(-3), ['/fake/claude', '--resume', 'dead-1'])
  // The same session with a LIVE pid must never take this branch: `--resume`
  // on a running session starts a COPY, which is the one outcome nobody wants.
  const live = await J.jumpToSession({
    sess: { id: 'dead-1', name: 'gone', cwd: '/tmp' }, run, claudeBin: '/fake/claude', pidAlive: () => true,
  })
  assert.equal(live.body.case, 'outside')
})

await ok('case 4 is a 200 with what a human can act on, and spawns nothing', async () => {
  const calls = []
  const run = async (bin, argv) => {
    calls.push([bin, ...argv].join(' '))
    if (bin === 'ps') return { code: 0, stdout: 'ttys031\n', stderr: '' }
    throw new Error('case 4 must not run anything but ps')
  }
  const out = await J.jumpToSession({
    sess: { id: 'sess-9', pid: 555 }, run, claudeBin: '/fake/claude', pidAlive: () => true,
  })
  assert.equal(out.status, 200)
  assert.equal(out.body.ok, false)
  assert.equal(out.body.case, 'outside')
  assert.equal(out.body.tty, 'ttys031')
  assert.equal(out.body.command, '/fake/claude --resume sess-9')
  assert.deepEqual(calls, ['ps -o tty= -p 555'])
})

await ok('cases 2 and 3 answer 409 with the command when there is no tmux server', async () => {
  const run = async (_bin, argv) => {
    if (argv[0] === 'new-window') return { code: 1, stdout: '', stderr: 'no server running' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const out = await J.jumpToSession({
    sess: { id: 's', shortId: 'z1', kind: 'background', cwd: '/tmp' },
    run, claudeBin: '/fake/claude', pidAlive: () => false,
  })
  assert.equal(out.status, 409)
  assert.equal(out.body.command, '/fake/claude attach z1')
})

await ok('cases 2 and 3 answer 503 with no claude binary, and open nothing', async () => {
  const out = await J.jumpToSession({
    sess: { id: 's', shortId: 'z1', kind: 'background', cwd: '/tmp' },
    run: async () => { throw new Error('must not run') }, claudeBin: null, pidAlive: () => false,
  })
  assert.equal(out.status, 503)
})

console.log(`\ncanvas harness: ${pass} checks passed`)
