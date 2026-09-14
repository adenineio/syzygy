#!/usr/bin/env node
// The command bar's quick-access deck: its whole pure core, loaded the way the
// pane loads it -- a classic script under a window shim -- plus the favourite
// route against a real relay subprocess on its own port with a temp data
// directory. Hermetic: nothing here touches the shared relay or WORLD_DIR.
// A harness cannot press a key: every claim about what a browser does with
// Option, with e.code under a composed character, or with capture-listener
// ordering is checked by hand in the browser, not here.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'syzygy', 'bridge', 'public', 'quick-access.js')

let pass = 0
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label) }

const win = {}
const MCQA = new Function('window', readFileSync(SRC, 'utf8') + '\nreturn MCQA')(win)

console.log('=== quick-access (pure core) ===')

const needsOf = (s) => (s && s.waiting ? (s.waitingFor || 'waiting for input') : ((s && s.needs) || ''))
const sess = (over) => ({ id: 'i' + (over.name || 'x'), name: 'x', startedAt: 1, ...over })

ok('digitSlot: physical digits only, and Digit0 is slot ten', () => {
  assert.equal(MCQA.digitSlot('Digit1'), 1)
  assert.equal(MCQA.digitSlot('Digit9'), 9)
  assert.equal(MCQA.digitSlot('Digit0'), 10)
  assert.equal(MCQA.digitSlot('KeyA'), null)
  assert.equal(MCQA.digitSlot('Numpad1'), null)
  assert.equal(MCQA.digitSlot(undefined), null)
})

ok('slotBand: the four fixed bands, and nothing outside them', () => {
  assert.equal(MCQA.slotBand(1), 'favourites')
  assert.equal(MCQA.slotBand(4), 'favourites')
  assert.equal(MCQA.slotBand(5), 'templates')
  assert.equal(MCQA.slotBand(7), 'templates')
  assert.equal(MCQA.slotBand(8), 'projects')
  assert.equal(MCQA.slotBand(10), 'suggested')
  assert.equal(MCQA.slotBand(11), null)
  assert.equal(MCQA.slotBand(0), null)
})

ok('deck: an empty bag yields no bands and never throws', () => {
  const d = MCQA.deck({})
  assert.deepEqual(d.bands, [])
  assert.deepEqual(d.bySlot, {})
  assert.equal(d.count, 0)
})

ok('deck: an empty source hides its band, it is never rendered empty', () => {
  const d = MCQA.deck({ favourites: [], templates: [], badges: [], proposals: [], needsOf })
  assert.deepEqual(d.bands.map((b) => b.id), [])
})

ok('deck: favourites sort by name and ignore updatedAt', () => {
  const d = MCQA.deck({
    favourites: [{ name: 'zed', color: '#111111' }, { name: 'alpha', color: '#222222' }],
    needsOf,
  })
  const cards = d.bands[0].cards
  assert.deepEqual(cards.map((c) => c.title), ['alpha', 'zed'])
  assert.deepEqual(cards.map((c) => c.slot), [1, 2])
})

ok('deck: a favourite with no live session is not live and says so', () => {
  const d = MCQA.deck({ favourites: [{ name: 'gone', color: '' }], sessions: [], needsOf })
  const c = d.bySlot[1]
  assert.equal(c.live, false)
  assert.equal(c.meta, 'not running')
  assert.equal(c.id, null)
})

ok('deck: bands are a stable prefix — a new favourite moves no other digit', () => {
  const base = { templates: [{ id: 't1', name: 'review', order: 0 }], badges: [{ key: 'k', name: 'proj', path: '/p', live: true }], needsOf }
  const one = MCQA.deck({ ...base, favourites: [{ name: 'b', color: '' }] })
  const two = MCQA.deck({ ...base, favourites: [{ name: 'a', color: '' }, { name: 'b', color: '' }] })
  assert.equal(one.bySlot[5].id, 't1')
  assert.equal(one.bySlot[8].id, 'k')
  assert.equal(two.bySlot[5].id, 't1', 'the template keeps digit 5')
  assert.equal(two.bySlot[8].id, 'k', 'the project keeps digit 8')
  assert.equal(two.bySlot[1].title, 'a', 'the new favourite takes digit 1')
  assert.equal(two.bySlot[2].title, 'b', 'and pushes the old one to digit 2')
})

ok('deck: each band is capped at its own slot count', () => {
  const d = MCQA.deck({
    favourites: ['a', 'b', 'c', 'd', 'e'].map((n) => ({ name: n, color: '' })),
    templates: [1, 2, 3, 4].map((i) => ({ id: 't' + i, name: 't' + i, order: i })),
    badges: [1, 2, 3].map((i) => ({ key: 'k' + i, name: 'p' + i, path: '/p' + i, live: false })),
    needsOf,
  })
  assert.equal(d.bands.find((b) => b.id === 'favourites').cards.length, 4)
  assert.equal(d.bands.find((b) => b.id === 'templates').cards.length, 3)
  assert.equal(d.bands.find((b) => b.id === 'projects').cards.length, 2)
  assert.equal(d.count, 9)
})

ok('suggestion: a waiting session outranks a proposal, oldest first', () => {
  const s1 = sess({ name: 'old', startedAt: 1, needs: 'a question' })
  const s2 = sess({ name: 'new', startedAt: 9, waiting: true, waitingFor: 'permission' })
  const c = MCQA.suggestion({
    sessions: [s2, s1],
    proposals: [{ id: 'p1', title: 'a pattern', mark: '', requestId: null, createdAt: 1 }],
    needsOf,
  })
  assert.equal(c.kind, 'needs')
  assert.equal(c.title, 'old')
  assert.equal(c.meta, 'a question')
})

ok('suggestion: the oldest UNRATED and UNPREPPED proposal, else nothing', () => {
  const proposals = [
    { id: 'rated', title: 'rated', mark: 'good', requestId: null, createdAt: 1 },
    { id: 'prepped', title: 'prepped', mark: '', requestId: 'r1', createdAt: 2 },
    { id: 'open', title: 'open', mark: '', requestId: null, createdAt: 3 },
    { id: 'newer', title: 'newer', mark: '', requestId: null, createdAt: 4 },
  ]
  assert.equal(MCQA.suggestion({ proposals, needsOf }).id, 'open')
  assert.equal(MCQA.suggestion({ proposals: proposals.slice(0, 2), needsOf }), null)
})

ok('actionFor: a live favourite has three actions, a dead one has a toast', () => {
  const live = { kind: 'favourite', id: 's1', title: 'one', live: true, jump: 'tmux' }
  assert.deepEqual(MCQA.actionFor(live, {}), { do: 'drawer', id: 's1' })
  assert.deepEqual(MCQA.actionFor(live, { shift: true }), { do: 'jump', id: 's1' })
  assert.deepEqual(MCQA.actionFor(live, { cmd: true }), { do: 'ring', id: 's1' })
  const dead = { kind: 'favourite', id: null, title: 'gone', live: false }
  assert.deepEqual(MCQA.actionFor(dead, {}), { do: 'toast', text: 'gone is not running' })
  assert.equal(MCQA.actionFor(dead, { shift: true }), null)
  assert.equal(MCQA.actionFor(dead, { cmd: true }), null)
})

ok('actionFor: a favourite outside tmux cannot jump', () => {
  const c = { kind: 'favourite', id: 's1', title: 'one', live: true, jump: 'outside' }
  assert.equal(MCQA.actionFor(c, { shift: true }), null)
})

ok('actionFor: a template applies, fills empty, or applies and queues', () => {
  const c = { kind: 'template', id: 't1', title: 'review', live: true }
  assert.deepEqual(MCQA.actionFor(c, {}), { do: 'template', id: 't1', mode: 'overwrite', submit: false })
  assert.deepEqual(MCQA.actionFor(c, { shift: true }), { do: 'template', id: 't1', mode: 'fill-empty', submit: false })
  assert.deepEqual(MCQA.actionFor(c, { cmd: true }), { do: 'template', id: 't1', mode: 'overwrite', submit: true })
})

ok('actionFor: a project scopes, opens the tab, or copies its path', () => {
  const c = { kind: 'project', id: 'k1', title: 'syzygy', path: '/repo', live: false }
  assert.deepEqual(MCQA.actionFor(c, {}), { do: 'scope', key: 'k1', name: 'syzygy' })
  assert.deepEqual(MCQA.actionFor(c, { shift: true }), { do: 'tab', view: 'projects' })
  assert.deepEqual(MCQA.actionFor(c, { cmd: true }), { do: 'copy', text: '/repo' })
})

ok('actionFor: a suggestion has exactly one action, and never rates', () => {
  assert.deepEqual(MCQA.actionFor({ kind: 'needs', id: 's9' }, {}), { do: 'drawer', id: 's9', reply: true })
  assert.equal(MCQA.actionFor({ kind: 'needs', id: 's9' }, { shift: true }), null)
  assert.deepEqual(MCQA.actionFor({ kind: 'proposal', id: 'p1' }, {}),
    { do: 'tab', view: 'dispatch', focus: 'skills-panel' })
  assert.equal(MCQA.actionFor({ kind: 'proposal', id: 'p1' }, { cmd: true }), null)
  assert.equal(MCQA.actionFor(null, {}), null)
})

ok('tapStep: two taps inside the window latch', () => {
  let r = MCQA.tapStep(undefined, { type: 'keydown', key: 'Alt', at: 1000 })
  r = MCQA.tapStep(r.state, { type: 'keyup', key: 'Alt', at: 1080 })
  assert.equal(r.latch, false)
  r = MCQA.tapStep(r.state, { type: 'keydown', key: 'Alt', at: 1200 })
  assert.equal(r.latch, false)
  r = MCQA.tapStep(r.state, { type: 'keyup', key: 'Alt', at: 1260 })
  assert.equal(r.latch, true)
})

ok('tapStep: a timestamp of zero is a real reading, not an absent one', () => {
  let r = MCQA.tapStep(undefined, { type: 'keydown', key: 'Alt', at: 0 })
  r = MCQA.tapStep(r.state, { type: 'keyup', key: 'Alt', at: 60 })
  r = MCQA.tapStep(r.state, { type: 'keydown', key: 'Alt', at: 200 })
  r = MCQA.tapStep(r.state, { type: 'keyup', key: 'Alt', at: 260 })
  assert.equal(r.latch, true, 'the first press at t=0 still counted as a tap')
})

ok('tapStep: a key pressed between the taps is not a tap', () => {
  let r = MCQA.tapStep(undefined, { type: 'keydown', key: 'Alt', at: 1000 })
  r = MCQA.tapStep(r.state, { type: 'keydown', key: '5', at: 1020 })
  r = MCQA.tapStep(r.state, { type: 'keyup', key: 'Alt', at: 1060 })
  assert.equal(r.latch, false)
  r = MCQA.tapStep(r.state, { type: 'keydown', key: 'Alt', at: 1100 })
  r = MCQA.tapStep(r.state, { type: 'keyup', key: 'Alt', at: 1140 })
  assert.equal(r.latch, false, 'the dirty tap was discarded, so this is a first tap again')
})

ok('tapStep: a key between two finished taps is not a double tap', () => {
  let r = MCQA.tapStep(undefined, { type: 'keydown', key: 'Alt', at: 1000 })
  r = MCQA.tapStep(r.state, { type: 'keyup', key: 'Alt', at: 1060 })
  assert.equal(r.latch, false)
  r = MCQA.tapStep(r.state, { type: 'keydown', key: '5', at: 1100 })
  r = MCQA.tapStep(r.state, { type: 'keydown', key: 'Alt', at: 1150 })
  r = MCQA.tapStep(r.state, { type: 'keyup', key: 'Alt', at: 1200 })
  assert.equal(r.latch, false, 'the key reset the first tap, so this is a first tap again')
})

ok('tapStep: a long hold is not a tap, and the next tap does not latch on it', () => {
  let r = MCQA.tapStep(undefined, { type: 'keydown', key: 'Alt', at: 1000 })
  r = MCQA.tapStep(r.state, { type: 'keyup', key: 'Alt', at: 1900 })
  assert.equal(r.latch, false)
  r = MCQA.tapStep(r.state, { type: 'keydown', key: 'Alt', at: 1950 })
  r = MCQA.tapStep(r.state, { type: 'keyup', key: 'Alt', at: 2000 })
  assert.equal(r.latch, false, 'a hold clears the pending tap')
})

ok('tapStep: a second tap outside the window starts over rather than latching', () => {
  let r = MCQA.tapStep(undefined, { type: 'keydown', key: 'Alt', at: 1000 })
  r = MCQA.tapStep(r.state, { type: 'keyup', key: 'Alt', at: 1060 })
  r = MCQA.tapStep(r.state, { type: 'keydown', key: 'Alt', at: 1600 })
  r = MCQA.tapStep(r.state, { type: 'keyup', key: 'Alt', at: 1660 })
  assert.equal(r.latch, false, '600ms apart is past TAP_MS')
  assert.equal(MCQA.TAP_MS, 400)
  assert.equal(MCQA.TAP_HOLD_MS, 250)
})

ok('tapStep: key repeat on Alt does not count as a second press', () => {
  let r = MCQA.tapStep(undefined, { type: 'keydown', key: 'Alt', at: 1000 })
  r = MCQA.tapStep(r.state, { type: 'keydown', key: 'Alt', at: 1040 })
  r = MCQA.tapStep(r.state, { type: 'keyup', key: 'Alt', at: 1080 })
  assert.equal(r.latch, false)
})

ok('tapStep: blur forgets everything', () => {
  let r = MCQA.tapStep(undefined, { type: 'keydown', key: 'Alt', at: 1000 })
  r = MCQA.tapStep(r.state, { type: 'keyup', key: 'Alt', at: 1060 })
  r = MCQA.tapStep(r.state, { type: 'blur', at: 1070 })
  r = MCQA.tapStep(r.state, { type: 'keydown', key: 'Alt', at: 1100 })
  r = MCQA.tapStep(r.state, { type: 'keyup', key: 'Alt', at: 1140 })
  assert.equal(r.latch, false)
})

ok('calmName: an unknown name, a throwing reader and an absent key all mean subtle', () => {
  assert.equal(MCQA.calmName(() => 'more'), 'more')
  assert.equal(MCQA.calmName(() => 'space'), 'subtle')
  assert.equal(MCQA.calmName(() => null), 'subtle')
  assert.equal(MCQA.calmName(() => { throw new Error('blocked') }), 'subtle')
  assert.equal(MCQA.calmName(undefined), 'subtle')
  assert.equal(MCQA.CALM_KEY, 'szg.sandbox.calm')
})

ok('stillNow: reduced motion or the still dial means no motion', () => {
  assert.equal(MCQA.stillNow('subtle', false), false)
  assert.equal(MCQA.stillNow('subtle', true), true)
  assert.equal(MCQA.stillNow('still', false), true)
})

ok('MOTION carries every duration and distance the bar and the deck move on', () => {
  const M = MCQA.MOTION
  // the deck
  assert.equal(M.arriveMs, 140)
  assert.equal(M.staggerMs, 30)
  assert.equal(M.staggerCap, 4)
  assert.equal(M.cardRisePx, 12)
  assert.equal(M.swapMs, 160)
  assert.equal(M.selectMs, 120)
  assert.equal(M.forwardPx, 14)
  assert.equal(M.commitMs, 90)
  assert.equal(M.liftPx, 4)
  assert.equal(M.hintMs, 90)
  // the bar
  assert.equal(M.openMs, 180)
  assert.equal(M.closeMs, 140)
  assert.equal(M.caretMs, 140)
  assert.equal(M.sweepMs, 220)
  assert.equal(M.firstLineMs, 140)
  assert.equal(M.firstRisePx, 6)
  assert.equal(M.paraMs, 120)
  assert.equal(M.pinMs, 200)
  assert.equal(M.errMs, 120)
  assert.equal(M.errBeats, 2)
  assert.equal(M.thinkMs, 1600)
  // retired: the band-level rise and the deck's own departure number
  assert.equal('departMs' in M, false)
  assert.equal('risePx' in M, false)
  assert.equal('tiltDeg' in M, false)
  assert.throws(() => { MCQA.BANDS.push({}) })
})

ok('isThinking: true only while streaming with no visible content yet', () => {
  assert.equal(MCQA.isThinking(true, ''), true)
  assert.equal(MCQA.isThinking(true, '   \n  '), true, 'whitespace-only is not content')
  assert.equal(MCQA.isThinking(true, 'hello'), false)
  assert.equal(MCQA.isThinking(false, ''), false, 'not streaming is never thinking')
  assert.equal(MCQA.isThinking(false, 'hello'), false)
})

ok('growInsets: the mark\'s rectangle as insets from the panel\'s edges', () => {
  const panel = { top: 100, right: 780, bottom: 500, left: 100, width: 680, height: 400 }
  const mark = { top: 114, right: 139, bottom: 139, left: 113, width: 26, height: 25 }
  assert.deepEqual(MCQA.growInsets(panel, mark), { top: 14, right: 641, bottom: 361, left: 13 })
  // A box measured before layout: no grow rather than NaN.
  assert.deepEqual(MCQA.growInsets(panel, { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }),
    { top: 0, right: 0, bottom: 0, left: 0 })
  assert.deepEqual(MCQA.growInsets({ width: 0, height: 0 }, mark),
    { top: 0, right: 0, bottom: 0, left: 0 })
  assert.deepEqual(MCQA.growInsets(undefined, undefined),
    { top: 0, right: 0, bottom: 0, left: 0 })
  // A mark somehow outside the panel clamps to zero, never negative.
  const out = MCQA.growInsets(panel, { top: 80, right: 800, bottom: 520, left: 90, width: 26, height: 25 })
  assert.deepEqual(out, { top: 0, right: 0, bottom: 0, left: 0 })
})

ok('paragraphs: a reply split for the per-paragraph fade', () => {
  assert.deepEqual(MCQA.paragraphs(''), [])
  assert.deepEqual(MCQA.paragraphs(undefined), [])
  assert.deepEqual(MCQA.paragraphs('one'), ['one'])
  assert.deepEqual(MCQA.paragraphs('one\n\ntwo'), ['one', 'two'])
  // A run of blank lines is ONE break: the gap is a margin, so there is
  // nothing for a longer separator to be rendered with.
  assert.deepEqual(MCQA.paragraphs('one\n\n\n\ntwo'), ['one', 'two'])
  // A streaming tail that has just ended a paragraph is not an empty one.
  assert.deepEqual(MCQA.paragraphs('one\n\n'), ['one'])
  assert.deepEqual(MCQA.paragraphs('\n\n\none'), ['one'])
  // A single newline is inside a paragraph, which pre-wrap renders.
  assert.deepEqual(MCQA.paragraphs('a\nb'), ['a\nb'])
  // The next paragraph's own indentation survives the split.
  assert.deepEqual(MCQA.paragraphs('one\n\n    indented'), ['one', '    indented'])
  // Trailing spaces on a blank line still make it blank.
  assert.deepEqual(MCQA.paragraphs('one\n   \ntwo'), ['one', 'two'])
})

ok('flipDx: where a chip has to start from to look like it moved', () => {
  // Moved right: it starts to the left of where it now is.
  assert.equal(MCQA.flipDx(100, 160, 90, 400), -60)
  // Moved left: it starts to the right.
  assert.equal(MCQA.flipDx(200, 120, 90, 400), 80)
  // Already where it belongs.
  assert.equal(MCQA.flipDx(160, 160, 90, 400), 0)
  // No previous position -- new, or scrolled out of the row: it comes in from
  // the row's own near edge, never from far off-screen.
  assert.equal(MCQA.flipDx(null, 160, 90, 400), -70)
  assert.equal(MCQA.flipDx(undefined, 160, 90, 400), -70)
  // A previous position outside the row clamps to that same edge.
  assert.equal(MCQA.flipDx(-900, 160, 90, 400), -70)
  assert.equal(MCQA.flipDx(9000, 160, 90, 400), 240)
  // An unmeasurable row leaves the previous position alone.
  assert.equal(MCQA.flipDx(100, 160, NaN, NaN), -60)
  // An unmeasurable destination moves nothing.
  assert.equal(MCQA.flipDx(100, NaN, 90, 400), 0)
})

// ---- live relay --------------------------------------------------------------
{
  const { spawn } = await import('node:child_process')
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, realpathSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')

  // Isolated on every axis, test/agent-templates-harness.mjs's way: an
  // OS-assigned port read off the child's own stdout, a temp data dir and HUD
  // config, every inherited SZG_* key dropped, and a fake `claude` so the
  // relay's boot probes never reach the real CLI.
  const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'szg-qa-relay-')))
  const DATA = join(TMP, 'data')
  mkdirSync(DATA)
  const HUD = join(TMP, 'hud.json')
  writeFileSync(HUD, '{}')
  const FAKE = join(TMP, 'claude')
  writeFileSync(FAKE, [
    '#!' + process.execPath,
    'const a = process.argv.slice(2)',
    "const say = (text, code) => { process.exitCode = code; if (text) process.stdout.write(text + '\\n') }",
    "if (a[0] === '--help') say('  --bg  run in the background\\n  attach  attach to a background session', 0)",
    "else if (a[0] === '--version') say('2.1.270 (Claude Code)', 0)",
    "else if (a[0] === '--agent') say(\"--agent '__szg_roster_probe__' not found. Available agents: claude\", 1)",
    "else if (a[0] === 'agents') say('[]', 0)",
    "else say('', 0)",
    '',
  ].join('\n'))
  chmodSync(FAKE, 0o755)

  const TOKEN = 'qa-harness-' + Math.random().toString(36).slice(2)
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SZG_')))
  const child = spawn(process.execPath, [join(ROOT, 'syzygy', 'bridge', 'relay.mjs')], {
    cwd: ROOT,
    env: {
      ...inherited, SZG_PORT: '0', SZG_TOKEN: TOKEN, SZG_DATA_DIR: DATA, SZG_HUD_CONFIG: HUD,
      SZG_CLAUDE_BIN: FAKE, SZG_TMUX_BIN: '/usr/bin/false', SZG_PANE_PASSWORD_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderrText = ''
  child.stderr.on('data', (c) => { stderrText += c })

  try {
    const PORT = await new Promise((resolvePort, reject) => {
      let out = ''
      // Kept so a passing run clears it: a pending 15 s timer would otherwise
      // hold the process open long after the last check.
      const timer = setTimeout(() => reject(new Error('relay did not report a port in time; stderr: ' + stderrText)), 15_000)
      const onData = (chunk) => {
        out += chunk
        const m = out.match(/relay on http:\/\/127\.0\.0\.1:(\d+)/)
        if (m) { clearTimeout(timer); child.stdout.off('data', onData); resolvePort(Number(m[1])) }
      }
      child.stdout.on('data', onData)
      child.on('error', (err) => { clearTimeout(timer); reject(err) })
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`relay exited early with code ${code}; stderr: ${stderrText}`)) })
    })
    const base = `http://127.0.0.1:${PORT}`
    const post = (path, body) => fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-mch-token': TOKEN },
      body: JSON.stringify(body),
    }).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, json: j })))
    const state = () => fetch(`${base}/api/state?token=${TOKEN}`).then((r) => r.json())

    console.log('=== favourite route ===')

    await (async () => {
      const r = await post('/api/session/favourite', { id: 'nope', favourite: true })
      assert.equal(r.status, 404)
      assert.equal(r.json?.error, 'unknown session')
      pass++; console.log('  ok  an unknown session is a 404')
    })()

    await post('/api/register', { session: { id: 'qa1', name: 'starred', startedAt: Date.now() } })

    await (async () => {
      const r = await post('/api/session/favourite', { id: 'qa1', favourite: 'yes' })
      assert.equal(r.status, 400)
      assert.match(r.json.error, /favourite must be true or false/)
      pass++; console.log('  ok  a non-boolean is a 400 and writes nothing')
    })()

    await (async () => {
      const r = await post('/api/session/favourite', { id: 'qa1', favourite: true })
      assert.equal(r.status, 200)
      assert.equal(r.json.favourite, true)
      const s = await state()
      assert.deepEqual(s.favourites, [{ name: 'starred', color: '' }])
      assert.ok(s.payloadVersion >= 15, 'payloadVersion moved past 14, got ' + s.payloadVersion)
      pass++; console.log('  ok  a favourite round-trips through /api/state')
    })()

    await (async () => {
      const r = await post('/api/session/favourite', { id: 'qa1', favourite: false })
      assert.equal(r.status, 200)
      const s = await state()
      assert.deepEqual(s.favourites, [])
      pass++; console.log('  ok  unstarring empties the payload key')
    })()
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)) }
  }
  rmSync(TMP, { recursive: true, force: true })
}

console.log(`\nquick-access harness: ${pass} checks passed`)
