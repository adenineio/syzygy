#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const T = await import(join(ROOT, 'syzygy', 'bridge', 'agent-templates.mjs'))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }
const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'szg-tpl-')), 'agent-templates.json')
  return { file, store: T.createTemplates({ file, now: () => 1_700_000_000_000 }) }
}

console.log('agent-templates harness')

await ok('a created template carries every field a picker reads', async () => {
  const { store } = fresh()
  const r = store.create({ name: 'Review', prompt: 'Review this branch.', model: 'opus', effort: 'high' })
  assert.equal(r.ok, true)
  assert.match(r.template.id, /^[a-z0-9][a-z0-9-]{0,48}$/)
  assert.equal(r.template.name, 'Review')
  assert.deepEqual(r.template.skills, [])
  assert.equal(r.template.agentDef, null)
  assert.equal(r.template.order, 0)
})

await ok('a template with no prompt is refused, not stored', async () => {
  const { store } = fresh()
  const r = store.create({ name: 'Empty', prompt: '   ' })
  assert.equal(r.ok, false)
  assert.match(r.error, /prompt/)
  assert.equal(store.all().length, 0)
})

await ok('an unknown model or effort is refused by name', async () => {
  const { store } = fresh()
  assert.match(store.create({ name: 'a', prompt: 'p', model: 'no such!' }).error, /model/)
  assert.match(store.create({ name: 'a', prompt: 'p', effort: 'HUGE' }).error, /effort/)
})

await ok('a full store refuses rather than evicting', async () => {
  const { store } = fresh()
  for (let i = 0; i < T.TEMPLATES_MAX; i++) assert.equal(store.create({ name: 'n' + i, prompt: 'p' }).ok, true)
  const r = store.create({ name: 'one more', prompt: 'p' })
  assert.equal(r.ok, false)
  assert.equal(store.all().length, T.TEMPLATES_MAX)
})

await ok('update merges and never rewrites the id or createdAt', async () => {
  const { store } = fresh()
  const id = store.create({ name: 'a', prompt: 'p' }).template.id
  const r = store.update(id, { id: 'hijack', createdAt: 1, name: 'b' })
  assert.equal(r.template.id, id)
  assert.equal(r.template.createdAt, 1_700_000_000_000)
  assert.equal(r.template.name, 'b')
})

await ok('unknown fields survive a read and a later write', async () => {
  const { file, store } = fresh()
  const id = store.create({ name: 'a', prompt: 'p' }).template.id
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.items[0].handWritten = 'keep me'
  writeFileSync(file, JSON.stringify(doc))
  const again = T.createTemplates({ file })
  again.update(id, { name: 'b' })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items[0].handWritten, 'keep me')
})

await ok('a file that will not parse is never overwritten', async () => {
  const { file } = fresh()
  writeFileSync(file, '{ this is not json')
  assert.deepEqual(T.readTemplates(file), [])
  const store = T.createTemplates({ file })
  assert.equal(store.create({ name: 'a', prompt: 'p' }).ok, false)
  assert.equal(readFileSync(file, 'utf8'), '{ this is not json')
})

await ok('reorder is a permutation or nothing', async () => {
  const { store } = fresh()
  const a = store.create({ name: 'a', prompt: 'p' }).template.id
  const b = store.create({ name: 'b', prompt: 'p' }).template.id
  assert.equal(store.reorder([b, a]), true)
  assert.deepEqual(store.all().map((t) => t.id), [b, a])
  assert.equal(store.reorder([b]), false)
  assert.deepEqual(store.all().map((t) => t.id), [b, a])
})

const DO = await import(join(ROOT, 'syzygy', 'bridge', 'dispatch-options.mjs'))

const REAL_ROSTER = "--agent '__szg_roster_probe__' not found. Available agents: " +
  'claude, dayshift-planner, episodic-memory:search-conversations, Explore, ' +
  'general-purpose, syzygy-agents:review\n'

await ok('the real refusal message parses to the whole roster', async () => {
  const r = DO.parseAgentRoster(REAL_ROSTER)
  assert.ok(r.includes('Explore'))
  assert.ok(r.includes('syzygy-agents:review'))
  assert.ok(r.includes('episodic-memory:search-conversations'))
  assert.equal(r.includes(''), false)
})

await ok('anything unexpected is an empty roster, never a throw', async () => {
  for (const t of ['', null, undefined, 'Available agents:', 'boom', '{"json":1}', 'Available agents: ,,,'])
    assert.deepEqual(DO.parseAgentRoster(t), [])
})

await ok('the probe reads the roster off a non-zero exit', async () => {
  const run = async (bin, argv) => {
    assert.equal(argv[0], '--agent')
    assert.equal(argv[1], DO.ROSTER_SENTINEL)
    assert.equal(argv.includes('--plugin-dir'), false)
    return { code: 1, stdout: REAL_ROSTER, stderr: '' }
  }
  const r = await DO.probeAgentRoster('claude', run)
  assert.equal(r.agentSource, 'probe')
  assert.ok(r.agents.includes('Explore'))
})

await ok('an unrunnable binary is unavailable, not empty-and-silent', async () => {
  const boom = async () => { throw new Error('ENOENT') }
  assert.deepEqual(await DO.probeAgentRoster('claude', boom), { agents: [], agentSource: 'unavailable' })
  assert.deepEqual(await DO.probeAgentRoster(null, boom), { agents: [], agentSource: 'unavailable' })
})

await ok('an exit 0 means the sentinel somehow existed — unavailable, not truth', async () => {
  const run = async () => ({ code: 0, stdout: 'hello', stderr: '' })
  assert.equal((await DO.probeAgentRoster('claude', run)).agentSource, 'unavailable')
})

await ok('the probe closes stdin and marks the child headless', async () => {
  let seenOpts = null
  const run = async (bin, argv, opts) => { seenOpts = opts; return { code: 1, stdout: REAL_ROSTER, stderr: '' } }
  await DO.probeAgentRoster('claude', run)
  assert.equal(seenOpts.closeStdin, true)
  assert.equal(seenOpts.env.SZG_HEADLESS, '1')
})

const tpl = (over = {}) => ({
  id: 'review', name: 'Review', prompt: 'p', model: null, effort: null,
  skills: [], allowedTools: [], agentDef: 'You review code.', order: 0,
  createdAt: 1, updatedAt: 1, ...over,
})

await ok('the manifest carries an author, or strict validation refuses it', async () => {
  const m = T.manifestFor([tpl()])
  assert.equal(m.name, T.AGENT_PLUGIN_NAME)
  assert.ok(m.author && m.author.name)
  assert.equal(typeof m.description, 'string')
})

await ok('a generated agent file has no model and no tools key', async () => {
  const text = T.agentFileFor(tpl())
  const front = text.split('---')[1]
  assert.match(front, /name:\s*review/)
  assert.match(front, /description:\s*.+/)
  assert.equal(/^\s*model:/m.test(front), false)
  assert.equal(/^\s*tools:/m.test(front), false)
  assert.ok(text.includes('You review code.'))
})

await ok('a template with no persona gets no agent name and no file', async () => {
  assert.equal(T.agentNameFor(tpl({ agentDef: null })), null)
  assert.equal(T.agentNameFor(tpl()), 'syzygy-agents:review')
})

await ok('a failed validation rolls the whole write back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'szg-agents-'))
  const before = { ok: true }
  const run = async () => ({ code: 1, stdout: '', stderr: 'Validation failed' })
  const r = await T.writePersonas({ templates: [tpl()], dir, run, claudeBin: 'claude' })
  assert.equal(r.ok, false)
  assert.match(r.error, /[Vv]alidation/)
  assert.equal(existsSync(join(dir, 'agents', 'review.md')), false)
  assert.ok(before.ok)
})

await ok('no persona anywhere removes the directory entirely', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'szg-agents-'))
  const run = async () => ({ code: 0, stdout: 'Validation passed', stderr: '' })
  assert.equal((await T.writePersonas({ templates: [tpl()], dir, run, claudeBin: 'claude' })).count, 1)
  assert.ok(existsSync(join(dir, 'agents', 'review.md')))
  const r = await T.writePersonas({ templates: [tpl({ agentDef: null })], dir, run, claudeBin: 'claude' })
  assert.equal(r.count, 0)
  assert.equal(existsSync(dir), false)
})

await ok('a directory that is not ours is refused, never written into', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'szg-agents-'))
  writeFileSync(join(dir, 'PLEASE-KEEP'), 'someone else lives here')
  const run = async () => ({ code: 0, stdout: 'Validation passed', stderr: '' })
  const r = await T.writePersonas({ templates: [tpl()], dir, run, claudeBin: 'claude' })
  assert.equal(r.ok, false)
  assert.match(r.error, /not/)
  assert.ok(existsSync(join(dir, 'PLEASE-KEEP')))
})

const ROSTER = ['claude', 'Explore', 'syzygy-agents:review']

await ok('a persona in the roster becomes an --agent name', async () => {
  const r = T.templateArgv(tpl(), { roster: ROSTER })
  assert.equal(r.agent, 'syzygy-agents:review')
  assert.equal(r.skipped, null)
})

await ok('a persona NOT in the roster is skipped and says so', async () => {
  const r = T.templateArgv(tpl({ id: 'ghost' }), { roster: ROSTER })
  assert.equal(r.agent, null)
  assert.match(r.skipped, /ghost/)
})

await ok('an empty roster skips every persona rather than guessing', async () => {
  assert.equal(T.templateArgv(tpl(), { roster: [] }).agent, null)
})

await ok('allowedTools is ONE space-joined argument', async () => {
  const r = T.templateArgv(tpl({ allowedTools: ['Read', 'Bash(git log:*)'] }), { roster: ROSTER })
  assert.equal(r.allowedTools, 'Read Bash(git log:*)')
  assert.equal(T.templateArgv(tpl(), { roster: ROSTER }).allowedTools, null)
})

await ok('personas switched off select no agent and report no skip, but keep the tools', async () => {
  const r = T.templateArgv(tpl({ allowedTools: ['Read', 'Glob'] }), { roster: ROSTER, personas: false })
  assert.deepEqual(r, { agent: null, allowedTools: 'Read Glob', skipped: null })
  assert.equal(T.templateArgv(tpl({ id: 'ghost' }), { roster: ROSTER, personas: false }).skipped, null)
})

const C = await import(join(ROOT, 'syzygy', 'bridge', 'canvas.mjs'))

await ok('spawnArgv keeps the prompt last, behind the sentinel', async () => {
  const a = C.spawnArgv({ name: 'n', prompt: 'go', agent: 'syzygy-agents:review',
    allowedTools: 'Read Edit' })
  assert.equal(a[a.length - 2], '--')
  assert.equal(a[a.length - 1], 'go')
  assert.equal(a.filter((x) => x === '--allowedTools').length, 1)
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'Read Edit')
})

await ok('a non-variadic option always follows --allowedTools', async () => {
  for (const extra of [{}, { agent: 'syzygy-agents:review' }, { budgetUsd: 5 }]) {
    const a = C.spawnArgv({ name: 'n', prompt: 'go', allowedTools: 'Read', ...extra })
    const next = a[a.indexOf('--allowedTools') + 2]
    assert.ok(next && next.startsWith('--') && next !== '--', `bad neighbour ${next}`)
  }
})

await ok('no template means the argv is byte-identical to before', async () => {
  assert.deepEqual(
    C.spawnArgv({ name: 'n', prompt: 'go' }),
    ['--bg', '-n', 'n', '--permission-mode', 'auto', '--model', 'opus', '--effort', 'high', '--', 'go'])
})

await ok('spawnRequest carries a slug templateId and refuses anything else', async () => {
  const okr = C.spawnRequest({ prompt: 'p', templateId: 'review' }, '/tmp')
  assert.equal(okr.templateId, 'review')
  assert.equal(C.spawnRequest({ prompt: 'p', templateId: 'Not A Slug!' }, '/tmp').ok, false)
  assert.equal(C.spawnRequest({ prompt: 'p' }, '/tmp').templateId, null)
})

const R = await import(join(ROOT, 'syzygy', 'bridge', 'requests.mjs'))

await ok('mergeDispatch validates templateId and never takes branch', async () => {
  const base = { model: 'opus', effort: 'high', branch: null, sessionName: null, templateId: null }
  assert.equal(R.mergeDispatch(base, { templateId: 'review' }).templateId, 'review')
  assert.equal(R.mergeDispatch(base, { templateId: '../etc' }).templateId, null)
  assert.equal(R.mergeDispatch(base, { branch: 'evil' }).branch, null)
  assert.equal(R.mergeDispatch({ ...base, templateId: 'review' }, { templateId: null }).templateId, null)
})

await ok('a created request carries templateId through the merge', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'szg-tpl-req-')), 'dispatch.json')
  const store = R.createStore({ file })
  assert.equal(store.create({ title: 't', templateId: 'review' }).dispatch.templateId, 'review')
  assert.equal(store.create({ title: 'u' }).dispatch.templateId, null)
  assert.equal(store.create({ title: 'v', templateId: 'Bad Id' }).dispatch.templateId, null)
})

// ---- template-apply.js: the pure browser half --------------------------------
// A CLASSIC script, evaluated the same way canvas-layout.js is in
// test/canvas-harness.mjs: through `new Function`, since a classic script's
// top-level `const` is not a property of a `vm` context and would read back
// undefined there.
const MCTA = new Function('window',
  readFileSync(join(ROOT, 'syzygy', 'bridge', 'public', 'template-apply.js'), 'utf8') + '\nreturn MCTA')({})
assert.ok(MCTA, 'template-apply.js must define a top-level MCTA')

await ok('overwrite replaces every field the template names', async () => {
  const next = MCTA.applyTemplate(
    { prompt: 'mine', model: 'sonnet', effort: 'low', name: 'keep' },
    tpl({ prompt: 'theirs', model: 'opus', effort: 'max' }), 'overwrite')
  assert.equal(next.prompt.startsWith('theirs'), true)
  assert.equal(next.model, 'opus')
  assert.equal(next.effort, 'max')
  assert.equal(next.name, 'keep')
})

await ok('fill-empty never overwrites what is already typed', async () => {
  const typed = { prompt: 'mine', model: 'sonnet', effort: 'low', name: 'n' }
  assert.deepEqual(MCTA.applyTemplate(typed, tpl({ prompt: 'theirs', model: 'opus' }), 'fill-empty'), typed)
})

await ok('fill-empty does fill a blank field', async () => {
  const next = MCTA.applyTemplate({ prompt: '   ', model: '', effort: '', name: '' },
    tpl({ prompt: 'theirs', model: 'opus', effort: 'max' }), 'fill-empty')
  assert.equal(next.prompt.startsWith('theirs'), true)
  assert.equal(next.model, 'opus')
})

await ok('a field the template leaves null is left alone in both modes', async () => {
  for (const mode of ['overwrite', 'fill-empty']) {
    const next = MCTA.applyTemplate({ prompt: '', model: 'sonnet', effort: 'low', name: '' },
      tpl({ model: null, effort: null }), mode)
    assert.equal(next.model, 'sonnet')
    assert.equal(next.effort, 'low')
  }
})

await ok('skills reach the prompt as a line, identically to the relay', async () => {
  const t = tpl({ prompt: 'Do it.', skills: ['review-notes', 'code-review'] })
  assert.equal(MCTA.renderKickoff(t), T.renderKickoff(t))
  assert.ok(MCTA.renderKickoff(t).includes('review-notes'))
})

await ok('digits come from ev.code, so shift does not change the slot', async () => {
  assert.equal(MCTA.digitSlot('Digit3'), 3)
  assert.equal(MCTA.digitSlot('Digit0'), null)
  assert.equal(MCTA.digitSlot('KeyT'), null)
  assert.equal(MCTA.digitSlot('!'), null)
})

await ok('a chip title names the two things no field shows', async () => {
  const s = MCTA.chipTitle(tpl({ allowedTools: ['Read'] }))
  assert.ok(s.includes('syzygy-agents:review'))
  assert.ok(s.includes('Read'))
  assert.equal(MCTA.chipTitle(tpl({ agentDef: null, allowedTools: [] })).length > 0, true)
})

// ---- live relay -------------------------------------------------------------
// The routes, the payload key, the personas setting and the spawn argv are all
// things only a real relay process does. Isolated on every axis: SZG_PORT=0
// (OS-assigned), a temp SZG_DATA_DIR, a temp SZG_HUD_CONFIG, a temp
// SZG_AGENT_PLUGIN_DIR, and SZG_CLAUDE_BIN pointing at a fake `claude` that
// records every argv it is handed. No real `claude` runs here.
{
  const { spawn } = await import('node:child_process')
  const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'szg-tpl-relay-')))
  const DATA = join(TMP, 'data')
  mkdirSync(DATA)
  const HUD = join(TMP, 'hud.json')
  writeFileSync(HUD, JSON.stringify({ _readme: 'keep', settings: { spinner: 'lunar' } }, null, 2))
  // The parent exists and the directory does not: the first personas write
  // has to create it.
  mkdirSync(join(TMP, 'skills'))
  const AGENT_DIR = join(TMP, 'skills', T.AGENT_PLUGIN_NAME)
  const ARGV_LOG = join(TMP, 'argv.log')
  const WORK = join(TMP, 'work')
  mkdirSync(WORK)
  const HELP = [
    '  --bg                 run the session in the background',
    '  attach               attach to a background session',
    '  --effort <level>     Effort level for the session (low, medium, high, xhigh, max)',
    '  --model <model>      Model for the session',
  ].join('\n')
  const ROSTER_LINE = "--agent '__szg_roster_probe__' not found. Available agents: claude, Explore, syzygy-agents:review"
  const FAKE = join(TMP, 'claude')
  // exitCode, never process.exit(): a pipe on darwin is written asynchronously,
  // and exiting at once can drop the very line the relay is waiting to parse.
  writeFileSync(FAKE, [
    '#!' + process.execPath,
    "const fs = require('fs')",
    'const a = process.argv.slice(2)',
    `fs.appendFileSync(${JSON.stringify(ARGV_LOG)}, JSON.stringify(a) + '\\n')`,
    "const say = (text, code) => { process.exitCode = code; if (text) process.stdout.write(text + '\\n') }",
    `if (a[0] === '--help') say(${JSON.stringify(HELP)}, 0)`,
    "else if (a[0] === '--version') say('2.1.270 (Claude Code)', 0)",
    `else if (a[0] === '--agent') say(${JSON.stringify(ROSTER_LINE)}, 1)`,
    "else if (a[0] === 'plugin' && a[1] === 'validate') say('✔ Validation passed', 0)",
    "else if (a[0] === 'agents') say('[]', 0)",
    "else if (a[0] === '--bg') { const nameAt = a.indexOf('-n'); say('backgrounded · abcd1234 · ' + (nameAt >= 0 ? a[nameAt + 1] : ''), 0) }",
    "else say('', 0)",
    '',
  ].join('\n'))
  chmodSync(FAKE, 0o755)

  const TOKEN = 'tpl-harness-' + Math.random().toString(36).slice(2)
  // Every inherited SZG_* key is dropped: a harness run from inside a live
  // session must not hand the child that session's relay, data dir or plugin dir.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SZG_')))
  const child = spawn(process.execPath, [join(ROOT, 'syzygy', 'bridge', 'relay.mjs')], {
    cwd: ROOT,
    env: {
      ...inherited, SZG_PORT: '0', SZG_TOKEN: TOKEN, SZG_DATA_DIR: DATA, SZG_HUD_CONFIG: HUD,
      SZG_AGENT_PLUGIN_DIR: AGENT_DIR, SZG_CLAUDE_BIN: FAKE, SZG_TMUX_BIN: '/usr/bin/false',
      SZG_PANE_PASSWORD_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderrText = ''
  child.stderr.on('data', (c) => { stderrText += c })

  try {
    const PORT = await new Promise((resolvePort, reject) => {
      let out = ''
      const onData = (chunk) => {
        out += chunk
        const m = out.match(/relay on http:\/\/127\.0\.0\.1:(\d+)/)
        if (m) { child.stdout.off('data', onData); resolvePort(Number(m[1])) }
      }
      child.stdout.on('data', onData)
      child.on('error', reject)
      child.on('exit', (code) => reject(new Error(`relay exited early with code ${code}; stderr: ${stderrText}`)))
      setTimeout(() => reject(new Error('relay did not report a port in time; stderr: ' + stderrText)), 15_000)
    })
    const BASE = `http://127.0.0.1:${PORT}`
    // The port came from THIS child's own stdout, so no other process can be
    // answering; still, a child that has died must not let a check pass.
    assert.equal(child.exitCode, null, 'relay child died')

    const post = async (path, body, headers = { 'x-mch-token': TOKEN }) => {
      const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const get = async (path) => {
      const res = await fetch(`${BASE}${path}?token=${TOKEN}`)
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const hud = () => JSON.parse(readFileSync(HUD, 'utf8'))
    const lastSpawn = () => readFileSync(ARGV_LOG, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l)).filter((a) => a[0] === '--bg').at(-1)
    const spawnCount = () => readFileSync(ARGV_LOG, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l)).filter((a) => a[0] === '--bg').length

    await ok('an older client sees the key, a newer relay publishes it', async () => {
      const s = await get('/api/state')
      assert.equal(s.status, 200)
      assert.ok(Array.isArray(s.body.agentTemplates.items))
      assert.ok(Array.isArray(s.body.dispatchOptions.agents))
      assert.ok(['probe', 'unavailable'].includes(s.body.dispatchOptions.agentSource))
      assert.ok(s.body.payloadVersion >= 12)
      assert.ok(s.body.dispatchOptions.agents.includes('syzygy-agents:review'), 'the boot probe read the fake roster')
      assert.deepEqual(s.body.agentTemplates.personas, { enabled: false, dir: AGENT_DIR, count: 0, error: null })
      assert.equal(existsSync(AGENT_DIR), false, 'boot writes nothing')
    })

    await ok('create, update, reorder and delete all round-trip', async () => {
      const c = await post('/api/templates/create', { name: 'Review', prompt: 'Review it.' })
      assert.equal(c.status, 200)
      const id = c.body.template.id
      assert.equal((await post('/api/templates/update', { id, patch: { effort: 'max' } })).body.template.effort, 'max')
      const d = await post('/api/templates/create', { name: 'Plan', prompt: 'Plan it.' })
      assert.equal((await post('/api/templates/reorder', { ids: [d.body.template.id, id] })).status, 200)
      assert.equal((await get('/api/state')).body.agentTemplates.items[0].id, d.body.template.id)
      assert.equal((await post('/api/templates/delete', { id })).status, 200)
      assert.ok(existsSync(join(DATA, 'agent-templates.json')), 'the store lives under the data dir')
    })

    await ok('a create with no prompt is a 400 that names the field', async () => {
      const r = await post('/api/templates/create', { name: 'Nope' })
      assert.equal(r.status, 400)
      assert.match(r.body.error, /prompt/)
    })

    await ok('a token sent in the body authenticates the create and is never stored', async () => {
      const r = await post('/api/templates/create', { token: TOKEN, name: 'Carried', prompt: 'p' }, {})
      assert.equal(r.status, 200)
      assert.equal('token' in r.body.template, false)
      assert.equal(readFileSync(join(DATA, 'agent-templates.json'), 'utf8').includes(TOKEN), false,
        'the store keeps unknown fields, so the credential must be taken out before it is written')
      assert.equal((await post('/api/templates/delete', { id: r.body.template.id })).status, 200)
    })

    await ok('every template route refuses a bad token', async () => {
      for (const p of ['create', 'update', 'delete', 'reorder', 'personas']) {
        const r = await post('/api/templates/' + p, {}, { 'x-mch-token': 'wrong' })
        assert.equal(r.status, 401, p)
      }
    })

    await ok('a GET to a template write route is refused, not served', async () => {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/templates/create?token=${TOKEN}`)
      assert.notEqual(r.status, 200)
    })

    await ok('the personas route answers without a body and is idempotent', async () => {
      const a = await post('/api/templates/personas', {})
      const b = await post('/api/templates/personas', {})
      assert.equal(a.status, 200)
      assert.deepEqual(a.body.count, b.body.count)
      assert.equal(hud().settings.agentTemplates, undefined, 'a retry with no `enabled` writes no setting')
      assert.equal(existsSync(AGENT_DIR), false, 'and, with the setting off, no personas either')
    })

    await ok('a non-boolean enabled is a 400', async () => {
      assert.equal((await post('/api/templates/personas', { enabled: 'yes' })).status, 400)
    })

    await ok('a template write goes out on its own agentTemplates event', async () => {
      const ac = new AbortController()
      const res = await fetch(`${BASE}/api/stream?token=${TOKEN}`, { signal: ac.signal })
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let text = ''
      let pending = null
      // One outstanding read at a time: a read abandoned by a lost race would
      // otherwise swallow the chunk it eventually resolves with.
      const readUntil = async (re, ms = 4000) => {
        const deadline = Date.now() + ms
        while (!re.test(text)) {
          if (Date.now() > deadline) return false
          pending ??= reader.read()
          const r = await Promise.race([pending, new Promise((res2) => setTimeout(() => res2(null), 200))])
          if (!r) continue
          pending = null
          if (r.done) return re.test(text)
          text += dec.decode(r.value, { stream: true })
        }
        return true
      }
      try {
        assert.ok(await readUntil(/\n\n/), 'the stream opened')
        text = ''
        assert.equal((await post('/api/templates/create', { name: 'Streamed', prompt: 'p' })).status, 200)
        assert.ok(await readUntil(/event: agentTemplates\ndata: [^\n]*\n\n/), 'no agentTemplates frame arrived')
        const data = JSON.parse(text.match(/event: agentTemplates\ndata: ([^\n]*)\n/)[1])
        assert.ok(data.items.some((t) => t.id === 'streamed'))
        assert.equal(data.personas.enabled, false)
        assert.equal('payloadVersion' in data, false, 'its own event, never the whole snapshot')
      } finally {
        pending?.catch(() => {})
        ac.abort()
      }
      assert.equal((await post('/api/templates/delete', { id: 'streamed' })).status, 200)
    })

    await ok('an unknown id is a 400 to update, a 404 to delete, and a partial reorder is a 400', async () => {
      assert.equal((await post('/api/templates/update', { id: 'nope', patch: { name: 'x' } })).status, 400)
      const del = await post('/api/templates/delete', { id: 'nope' })
      assert.equal(del.status, 404)
      assert.equal(del.body.error, 'no such template')
      assert.equal((await post('/api/templates/reorder', { ids: ['nope'] })).status, 400)
    })

    await ok('personas on: the plugin is written, validated and the setting lands beside every other key', async () => {
      const c = await post('/api/templates/create', { name: 'Review', prompt: 'p', agentDef: 'You review.' })
      assert.equal(c.status, 200)
      assert.equal(c.body.template.id, 'review')
      assert.equal(existsSync(AGENT_DIR), false, 'with the setting off, a persona-bearing write generates nothing')
      const r = await post('/api/templates/personas', { enabled: true })
      assert.equal(r.status, 200)
      assert.equal(r.body.personas.enabled, true)
      assert.equal(r.body.count, 1)
      assert.equal(r.body.error, null)
      assert.ok(existsSync(join(AGENT_DIR, 'agents', 'review.md')))
      const doc = hud()
      assert.equal(doc._readme, 'keep')
      assert.equal(doc.settings.spinner, 'lunar')
      assert.equal(doc.settings.agentTemplates.personas, true)
      const validated = readFileSync(ARGV_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        .some((a) => a[0] === 'plugin' && a[1] === 'validate' && a.includes('--strict'))
      assert.ok(validated, 'the generated plugin went through plugin validate --strict')
      assert.equal((await get('/api/state')).body.agentTemplates.personas.count, 1)
    })

    await ok('a templated spawn carries --agent before --model, and the prompt last behind --', async () => {
      const r = await post('/api/spawn', { cwd: WORK, prompt: 'go', templateId: 'review' })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.warning, undefined)
      const a = lastSpawn()
      const ag = a.indexOf('--agent')
      assert.ok(ag >= 0, 'no --agent on the argv')
      assert.equal(a[ag + 1], 'syzygy-agents:review')
      assert.ok(ag < a.indexOf('--model'), '--agent must come before --model')
      assert.equal(a.at(-2), '--')
      assert.equal(a.at(-1), 'go')
      assert.equal(a.includes('--allowedTools'), false, 'a template with no tools adds no allowlist')

      assert.equal((await post('/api/templates/update', { id: 'review', patch: { allowedTools: ['Read', 'Glob'] } })).status, 200)
      assert.equal((await post('/api/spawn', { cwd: WORK, prompt: 'go', templateId: 'review' })).status, 200)
      const b = lastSpawn()
      const at = b.indexOf('--allowedTools')
      assert.ok(at >= 0, 'no --allowedTools on the argv')
      assert.equal(b[at + 1], 'Read Glob')
      assert.ok(b[at + 2].startsWith('--') && b[at + 2] !== '--', `bad neighbour ${b[at + 2]}`)
      assert.equal(b.at(-1), 'go')
    })

    await ok('a persona missing from the roster starts without it and says so', async () => {
      const c = await post('/api/templates/create', { name: 'Ghost', prompt: 'p', agentDef: 'You haunt.' })
      assert.equal(c.status, 200)
      assert.ok(existsSync(join(AGENT_DIR, 'agents', 'ghost.md')), 'a changed persona set is rewritten while the setting is on')
      const r = await post('/api/spawn', { cwd: WORK, prompt: 'go', templateId: 'ghost' })
      assert.equal(r.status, 200)
      assert.match(r.body.warning, /ghost/)
      assert.equal(lastSpawn().includes('--agent'), false)
    })

    await ok('personas off: the plugin is removed, the other settings kept, and spawns carry no agent', async () => {
      const r = await post('/api/templates/personas', { enabled: false })
      assert.equal(r.status, 200)
      assert.equal(r.body.personas.enabled, false)
      assert.equal(existsSync(AGENT_DIR), false)
      const doc = hud()
      assert.equal(doc.settings.spinner, 'lunar')
      assert.equal(doc._readme, 'keep')
      assert.equal(doc.settings.agentTemplates.personas, false)
      const s = await post('/api/spawn', { cwd: WORK, prompt: 'go', templateId: 'review' })
      assert.equal(s.status, 200)
      assert.equal(s.body.warning, undefined)
      const a = lastSpawn()
      assert.equal(a.includes('--agent'), false)
      assert.equal(a[a.indexOf('--allowedTools') + 1], 'Read Glob', 'the tools do not depend on the personas setting')
    })

    await ok('an unknown or malformed templateId is a 400 on both spawn paths, and nothing runs', async () => {
      const before = spawnCount()
      const s = await post('/api/spawn', { cwd: WORK, prompt: 'go', templateId: 'nope' })
      assert.equal(s.status, 400)
      assert.match(s.body.error, /template/)
      const bad = await post('/api/spawn', { cwd: WORK, prompt: 'go', templateId: 'Not A Slug!' })
      assert.equal(bad.status, 400)
      assert.match(bad.body.error, /slug/)
      assert.equal(spawnCount(), before, 'a refused spawn never reaches claude')
      const q = await post('/api/request/create', { title: 'T', project: WORK, templateId: 'nope' })
      assert.equal(q.status, 400)
      assert.match(q.body.error, /template/)
      const good = await post('/api/request/create', { title: 'T', project: WORK, templateId: 'review' })
      assert.equal(good.status, 200)
      assert.equal(good.body.request.dispatch.templateId, 'review')
    })

    await ok('a create above the cap is a 400 that names it', async () => {
      const have = (await get('/api/state')).body.agentTemplates.items.length
      for (let i = have; i < T.TEMPLATES_MAX; i++) {
        assert.equal((await post('/api/templates/create', { name: 'filler ' + i, prompt: 'p' })).status, 200)
      }
      const r = await post('/api/templates/create', { name: 'one more', prompt: 'p' })
      assert.equal(r.status, 400)
      assert.match(r.body.error, /too many templates/)
    })
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 2000) })
  }
}

console.log(`\n${pass} assertions passed`)
