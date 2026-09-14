#!/usr/bin/env node
// The macOS shell's two pure cores, plus a syntax check of the wiring the
// harness cannot import (main.js needs a real Electron runtime) and the icon
// script driven as a subprocess. Hermetic: no network, no ~/.claude read or
// written, no Electron installed or required.
//
// Run: node test/syzygy-app-harness.mjs   (or `just test-app`)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync as write } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const APP = join(ROOT, 'syzygy-app')

let pass = 0
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label) }

console.log('syzygy-app harness')

const SC = await import(join(APP, 'shell-core.js'))

ok('a good config yields both values', () => {
  const c = SC.readRelayConfig('{"token":"abc123","port":4317}')
  assert.equal(c.token, 'abc123')
  assert.equal(c.port, 4317)
})

ok('a missing, empty or unparseable file yields nulls and never throws', () => {
  for (const bad of ['', '   ', 'not json', '[]', 'null', '{"token":""}']) {
    const c = SC.readRelayConfig(bad)
    assert.equal(c.token, null, bad)
    assert.equal(c.port, null, bad)
  }
})

ok('a string port is accepted, a nonsense port is not', () => {
  assert.equal(SC.readRelayConfig('{"token":"t","port":"4319"}').port, 4319)
  for (const p of [0, -1, 65536, 1.5, 'x', null, {}]) {
    assert.equal(SC.readRelayConfig(JSON.stringify({ token: 't', port: p })).port, null, String(p))
  }
})

ok('argv beats env beats the file beats the default', () => {
  const config = { token: 't', port: 4400 }
  assert.deepEqual(
    SC.resolvePort({ argv: ['--port', '4500'], env: { SZG_RELAY_PORT: '4600' }, config }),
    { port: 4500, source: 'argv' })
  assert.deepEqual(
    SC.resolvePort({ argv: [], env: { SZG_RELAY_PORT: '4600' }, config }),
    { port: 4600, source: 'env' })
  assert.deepEqual(SC.resolvePort({ argv: [], env: {}, config }), { port: 4400, source: 'config' })
  assert.deepEqual(SC.resolvePort({ argv: [], env: {}, config: {} }),
    { port: SC.RELAY_PORT_DEFAULT, source: 'default' })
})

ok('a --port with nothing usable after it falls through', () => {
  assert.deepEqual(SC.resolvePort({ argv: ['--port'], env: {}, config: {} }),
    { port: 4317, source: 'default' })
  assert.deepEqual(SC.resolvePort({ argv: ['--port', 'zero'], env: {}, config: { port: 4400 } }),
    { port: 4400, source: 'config' })
})

ok('the token comes from the environment first, then the file, else none', () => {
  assert.deepEqual(SC.resolveToken({ env: { SZG_RELAY_TOKEN: 'e' }, config: { token: 'f' } }),
    { token: 'e', source: 'env' })
  assert.deepEqual(SC.resolveToken({ env: {}, config: { token: 'f' } }), { token: 'f', source: 'config' })
  assert.deepEqual(SC.resolveToken({ env: {}, config: {} }), { token: null, source: 'none' })
})

ok('the url is always 127.0.0.1, never localhost', () => {
  assert.equal(SC.relayUrl(4317, '/api/health'), 'http://127.0.0.1:4317/api/health')
  assert.equal(SC.relayUrl(4327, '/'), 'http://127.0.0.1:4327/')
})

ok('the bridge is looked for in the installed places first, the checkout last', () => {
  const list = SC.bridgeCandidates({ home: '/h', appDir: '/repo/syzygy-app' })
  assert.deepEqual(list, [
    '/h/.claude/skills/syzygy/bridge/relay.mjs',
    '/h/.claude/plugins/cache/syzygy/bridge/relay.mjs',
    '/repo/syzygy/bridge/relay.mjs',
  ])
})

ok('a healthy relay is loaded, whatever the port came from', () => {
  for (const portSource of ['argv', 'env', 'config', 'default']) {
    assert.equal(SC.relayDecision({ healthy: true, portSource, bridgePath: null, token: null }).action, 'load')
  }
})

ok('an explicitly named port is never spawned on', () => {
  for (const portSource of ['argv', 'env']) {
    const d = SC.relayDecision({ healthy: false, portSource, bridgePath: '/b/relay.mjs', token: 't' })
    assert.equal(d.action, 'refuse')
    assert.match(d.reason, /port this launch was given/)
  }
})

ok('the default and the config port spawn when a bridge and a token exist', () => {
  for (const portSource of ['config', 'default']) {
    assert.equal(SC.relayDecision({ healthy: false, portSource, bridgePath: '/b/relay.mjs', token: 't' }).action,
      'spawn')
  }
})

ok('no bridge and no token each refuse, and say which', () => {
  const a = SC.relayDecision({ healthy: false, portSource: 'default', bridgePath: null, token: 't' })
  assert.equal(a.action, 'refuse')
  assert.match(a.reason, /relay\.mjs/)
  const b = SC.relayDecision({ healthy: false, portSource: 'default', bridgePath: '/b/relay.mjs', token: null })
  assert.equal(b.action, 'refuse')
  assert.match(b.reason, /token/)
})

ok('every SZG_ variable is deleted from the child environment', () => {
  const e = SC.spawnEnv({
    PATH: '/bin', HOME: '/h',
    SZG_DATA_DIR: '/scratch', SZG_PANE_PASSWORD_DISABLED: '1', SZG_RELAY_PORT: '4327',
  }, { token: 'tok', port: 4317, viaElectron: false })
  assert.equal(e.PATH, '/bin')
  assert.equal(e.HOME, '/h')
  assert.equal(e.SZG_DATA_DIR, undefined)
  assert.equal(e.SZG_PANE_PASSWORD_DISABLED, undefined)
  assert.equal(e.SZG_RELAY_PORT, undefined)
  assert.equal(e.SZG_TOKEN, 'tok')
  assert.equal(e.SZG_PORT, '4317')
  assert.equal(e.ELECTRON_RUN_AS_NODE, undefined)
})

ok('the electron fallback sets the one variable that makes it node', () => {
  const e = SC.spawnEnv({}, { token: 't', port: 4317, viaElectron: true })
  assert.equal(e.ELECTRON_RUN_AS_NODE, '1')
})

ok('node is taken from the first candidate that exists', () => {
  const seen = []
  const exists = (p) => { seen.push(p); return p === '/usr/local/bin/node' }
  const r = SC.resolveNode({ env: { PATH: '/somewhere' }, home: '/h', execPath: '/App/Electron', exists })
  assert.deepEqual(r, { bin: '/usr/local/bin/node', viaElectron: false })
  assert.equal(seen[0], '/opt/homebrew/bin/node')
})

ok('a node on PATH is found after the fixed places', () => {
  const r = SC.resolveNode({
    env: { PATH: '/a:/b' }, home: '/h', execPath: '/App/Electron',
    exists: (p) => p === '/b/node',
  })
  assert.deepEqual(r, { bin: '/b/node', viaElectron: false })
})

ok('with no node anywhere, electron is the node', () => {
  const r = SC.resolveNode({ env: {}, home: '/h', execPath: '/App/Electron', exists: () => false })
  assert.deepEqual(r, { bin: '/App/Electron', viaElectron: true })
})

const DISPLAYS = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]

ok('a saved rectangle on a connected display is kept', () => {
  const s = SC.sanitizeWindowState({ x: 100, y: 80, width: 1200, height: 800, mode: 'floating' }, DISPLAYS)
  assert.deepEqual(s.bounds, { x: 100, y: 80, width: 1200, height: 800 })
  assert.equal(s.mode, 'floating')
})

ok('a rectangle entirely off every display falls back to the default size', () => {
  const s = SC.sanitizeWindowState({ x: 6000, y: 4000, width: 1200, height: 800 }, DISPLAYS)
  assert.equal(s.bounds, null)
  assert.equal(s.mode, 'normal')
})

ok('a window smaller than the minimum is grown, not refused', () => {
  const s = SC.sanitizeWindowState({ x: 0, y: 0, width: 300, height: 200 }, DISPLAYS)
  assert.deepEqual(s.bounds, { x: 0, y: 0, width: SC.MIN_SIZE.width, height: SC.MIN_SIZE.height })
})

ok('a missing, malformed or unknown-mode state is the default, never a throw', () => {
  for (const bad of [null, undefined, 'x', {}, { x: 'a', y: 0, width: 1, height: 1 }]) {
    const s = SC.sanitizeWindowState(bad, DISPLAYS)
    assert.equal(s.bounds, null)
    assert.equal(s.mode, 'normal')
  }
  assert.equal(SC.sanitizeWindowState({ x: 0, y: 0, width: 1000, height: 700, mode: 'space-age' }, DISPLAYS).mode,
    'normal')
})

ok('this origin is internal, http elsewhere opens outside, everything else is denied', () => {
  const at = { origin: 'http://127.0.0.1:4317', offlineUrl: 'file:///repo/syzygy-app/offline.html' }
  assert.equal(SC.externalDecision('http://127.0.0.1:4317/login', at), 'internal')
  assert.equal(SC.externalDecision('http://127.0.0.1:4317/api/state', at), 'internal')
  assert.equal(SC.externalDecision('file:///repo/syzygy-app/offline.html', at), 'internal')
  assert.equal(SC.externalDecision('https://motion.dev/docs', at), 'open')
  assert.equal(SC.externalDecision('http://example.com/x', at), 'open')
  assert.equal(SC.externalDecision('http://localhost:4317/', at), 'open')
  for (const bad of ['file:///etc/passwd', 'data:text/html,x', 'javascript:alert(1)',
    'about:blank', 'ftp://h/x', 'not a url', '']) {
    assert.equal(SC.externalDecision(bad, at), 'deny', bad)
  }
})

const MENU = await import(join(APP, 'menu-core.js'))

ok('the seven views are in the tab strip order', () => {
  assert.deepEqual(MENU.VIEWS,
    ['control', 'telemetry', 'projects', 'dispatch', 'canvas', 'sandbox', 'space'])
})

ok('accelerators normalise to one spelling', () => {
  assert.equal(MENU.normalizeAccel('CommandOrControl+Shift+Return'), 'cmd+shift+return')
  assert.equal(MENU.normalizeAccel('Cmd+Shift+Enter'), 'cmd+shift+return')
  assert.equal(MENU.normalizeAccel('Alt+Command+I'), 'alt+cmd+i')
  assert.equal(MENU.normalizeAccel('Option+Cmd+t'), 'alt+cmd+t')
  assert.equal(MENU.normalizeAccel(''), '')
})

const flatten = (items) => items.flatMap((i) => [i, ...flatten(i.submenu || [])])

ok('no accelerator in the menu is a chord the pane already claims', () => {
  const claimed = new Set(MENU.PANE_CHORDS)
  for (const item of flatten(MENU.menuTemplate({ appName: 'Syzygy' }))) {
    if (!item.accelerator) continue
    const n = MENU.normalizeAccel(item.accelerator)
    assert.equal(claimed.has(n), false, `${item.label || item.role} binds ${n}, which the pane claims`)
  }
})

ok('no ROLE the menu uses binds a chord the pane claims either', () => {
  const claimed = new Set(MENU.PANE_CHORDS)
  for (const item of flatten(MENU.menuTemplate({ appName: 'Syzygy' }))) {
    if (!item.role) continue
    const n = MENU.ROLE_DEFAULTS[item.role]
    if (!n) continue
    assert.equal(claimed.has(n), false, `role ${item.role} binds ${n}, which the pane claims`)
  }
})

ok('the chords the pane claims include every global one', () => {
  for (const c of ['escape', 'cmd+shift+return', 'cmd+shift+k', 'cmd+k',
    'alt+shift+p', 'alt+up', 'alt+down', 'alt+t']) {
    assert.equal(MENU.PANE_CHORDS.includes(c), true, c)
  }
})

ok('the view digits are deliberately NOT in the claimed list', () => {
  for (const n of ['cmd+1', 'cmd+7']) assert.equal(MENU.PANE_CHORDS.includes(n), false, n)
})

ok('every view has a menu item, an accelerator and an action', () => {
  const items = flatten(MENU.menuTemplate({ appName: 'Syzygy' }))
  MENU.VIEWS.forEach((v, i) => {
    const hit = items.find((x) => x.action === `view:${i + 1}`)
    assert.ok(hit, v)
    assert.equal(MENU.normalizeAccel(hit.accelerator), `cmd+${i + 1}`)
    assert.match(hit.label.toLowerCase(), new RegExp(v))
  })
})

ok('the pane chord items show the chord in the label and bind nothing', () => {
  const items = flatten(MENU.menuTemplate({ appName: 'Syzygy' }))
  const bar = items.find((x) => x.action === 'chord:cmdbar')
  assert.ok(bar)
  assert.equal(bar.accelerator, undefined)
  assert.match(bar.label, /⌘⇧/)
})

ok('the shell actions are all present', () => {
  const actions = new Set(flatten(MENU.menuTemplate({ appName: 'Syzygy' })).map((x) => x.action))
  for (const a of ['relay:reload', 'relay:reconnect', 'window:float', 'chord:cmdbar', 'app:about']) {
    assert.equal(actions.has(a), true, a)
  }
})

ok('the six top-level menus are in the macOS order', () => {
  assert.deepEqual(MENU.menuTemplate({ appName: 'Syzygy' }).map((m) => m.label),
    ['Syzygy', 'File', 'Edit', 'View', 'Window', 'Help'])
})

ok('a view action becomes one bare digit down and up', () => {
  assert.deepEqual(MENU.keyEventsFor('view:3'), [
    { type: 'keyDown', keyCode: '3' },
    { type: 'keyUp', keyCode: '3' },
  ])
})

ok('the command bar action becomes the chord itself', () => {
  assert.deepEqual(MENU.keyEventsFor('chord:cmdbar'), [
    { type: 'keyDown', keyCode: 'Return', modifiers: ['shift', 'meta'] },
    { type: 'keyUp', keyCode: 'Return', modifiers: ['shift', 'meta'] },
  ])
})

ok('an action with no key route gives no events', () => {
  for (const a of ['relay:reload', 'window:float', 'view:9', 'nonsense', '']) {
    assert.deepEqual(MENU.keyEventsFor(a), [], a)
  }
})

for (const f of ['main.js', 'preload.cjs', 'shell-core.js', 'menu-core.js', 'pack.mjs']) {
  ok(`${f} parses`, () => {
    const r = spawnSync(process.execPath, ['--check', join(APP, f)], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  })
}

ok('the failure page carries no script and names the port placeholder', () => {
  const html = readFileSync(join(APP, 'offline.html'), 'utf8')
  assert.equal(/<script/i.test(html), false, 'offline.html must have no script')
  assert.match(html, /__SZG_PORT__/)
  assert.match(html, /__SZG_REASON__/)
})

ok('the preload exposes exactly one key, and its only ipc is sending the theme name', () => {
  const src = readFileSync(join(APP, 'preload.cjs'), 'utf8')
  assert.match(src, /exposeInMainWorld\('szg'/)
  assert.equal((src.match(/exposeInMainWorld\(/g) || []).length, 1, 'one key exposed to the page')
  assert.deepEqual([...new Set(src.match(/ipcRenderer\.\w+/g) || [])], ['ipcRenderer.send'], 'send only: no on, once, invoke or sendSync')
  assert.equal((src.match(/ipcRenderer\.send\(/g) || []).length, 1, 'one send site')
  assert.match(src, /ipcRenderer\.send\('szg:theme'/)
  assert.equal(/exposeInMainWorld\([^)]*ipcRenderer/.test(src), false, 'ipcRenderer is never handed to the page')
})

ok('main.js never posts to the relay and reads no token into the renderer', () => {
  const src = readFileSync(join(APP, 'main.js'), 'utf8')
  assert.equal(/method:\s*'POST'/.test(src), false)
  assert.equal(/executeJavaScript/.test(src), false)
  assert.match(src, /\/api\/health/)
})

ok('main.js never awaits at the top level, which would deadlock Electron startup', () => {
  const src = readFileSync(join(APP, 'main.js'), 'utf8')
  assert.equal(/^\s{0,2}await\b/m.test(src), false, 'a top-level await in main.js waits for a ready event that cannot fire')
})

const ICON = join(APP, 'make-icon.py')
const GOOD = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
  '  <rect width="64" height="64" fill="#70bfdb"/>',
  '  <circle cx="32" cy="32" r="25.6" fill="#010101"/>',
  '  <circle cx="38.84" cy="25.6" r="15.85" fill="#70bfdb"/>',
  '</svg>',
].join('\n')

const runIcon = (svg, extra = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'szg-icon-'))
  const src = join(dir, 'mark.svg')
  write(src, svg)
  const r = spawnSync('python3', [ICON, '--svg', src, '--out', dir, ...extra], { encoding: 'utf8' })
  return { dir, r }
}

ok('the real mark still has exactly the three primitives the script expects', () => {
  const svg = readFileSync(join(ROOT, 'syzygy', 'bridge', 'public', 'favicon.svg'), 'utf8')
  const out = mkdtempSync(join(tmpdir(), 'szg-icon-'))
  const r = spawnSync('python3', [ICON, '--svg', '-', '--out', out, '--theme', 'green', '--png-only'], { input: svg, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

ok('a good mark yields a 1024 square RGBA png for the theme asked for', () => {
  const { dir, r } = runIcon(GOOD, ['--theme', 'green', '--png-only'])
  assert.equal(r.status, 0, r.stderr)
  const png = readFileSync(join(dir, 'themes', 'green.png'))
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(png.readUInt32BE(16), 1024)
  assert.equal(png.readUInt32BE(20), 1024)
  assert.equal(png[24], 8, 'bit depth')
  assert.equal(png[25], 6, 'colour type RGBA')
})

ok('on the dark plate the mark is flipped, in the colours app.css gives the theme', () => {
  const { dir, r } = runIcon(GOOD, ['--theme', 'green', '--png-only', '--probe'])
  assert.equal(r.status, 0, r.stderr)
  const p = JSON.parse(readFileSync(join(dir, 'probe.json'), 'utf8'))
  assert.deepEqual(p.corner, [0, 0, 0, 0], 'outside the rounded body')
  assert.deepEqual(p.border, [...p.accentRgb, 255], 'the border is the accent')
  assert.deepEqual(p.lit, [...p.accentRgb, 255], 'the far body is lit in the accent')
  assert.deepEqual(p.plate, [...p.plateRgb, 255], 'the plate')
  assert.deepEqual(p.covered, [...p.plateRgb, 255], 'the covering disc is the plate colour')
  assert.notDeepEqual(p.plateRgb, p.accentRgb)
  // The colours themselves, recomputed here from the stylesheet's own numbers.
  const css = readFileSync(join(ROOT, 'syzygy', 'bridge', 'public', 'app.css'), 'utf8')
  const hue = Number(css.match(/:root\[data-theme="green"\]\s*\{\s*--hue:\s*(\d+)/)[1])
  const surface = css.match(/--surface:\s*hsl\(var\(--hue\)\s+([\d.]+)%\s+([\d.]+)%\)/).slice(1).map(Number)
  const accent = css.match(/--accent:\s*hsl\(var\(--hue\)\s+([\d.]+)%\s+([\d.]+)%\)/).slice(1).map(Number)
  const hslToRgb = (h, s, l) => {
    const c = (1 - Math.abs(2 * (l / 100) - 1)) * (s / 100)
    const hp = h / 60
    const x = c * (1 - Math.abs((hp % 2) - 1))
    const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
    const m = l / 100 - c / 2
    return [r1, g1, b1].map((v) => Math.round((v + m) * 255))
  }
  const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1)
  assert.ok(near(p.plateRgb, hslToRgb(hue, ...surface)), `plate ${p.plateRgb} is not --surface at hue ${hue}`)
  assert.ok(near(p.accentRgb, hslToRgb(hue, ...accent)), `accent ${p.accentRgb} is not --accent at hue ${hue}`)
})

ok('a fourth primitive is refused, loudly, with nothing written', () => {
  const { dir, r } = runIcon(GOOD.replace('</svg>', '  <path d="m0 0h1v1z"/>\n</svg>'), ['--png-only'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /cannot draw: path/)
  assert.equal(existsSync(join(dir, 'themes')), false)
})

ok('a mark with no rect, or a missing file, is refused the same way', () => {
  const { r } = runIcon('<svg viewBox="0 0 64 64"></svg>', ['--png-only'])
  assert.notEqual(r.status, 0)
  const m = spawnSync('python3', [ICON, '--svg', '/nope/mark.svg', '--png-only'], { encoding: 'utf8' })
  assert.notEqual(m.status, 0)
})

ok('the shell knows exactly the themes app.js offers and app.css styles', () => {
  const js = readFileSync(join(ROOT, 'syzygy', 'bridge', 'public', 'app.js'), 'utf8')
  const css = readFileSync(join(ROOT, 'syzygy', 'bridge', 'public', 'app.css'), 'utf8')
  const fromJs = [...js.match(/const THEMES = \{([^}]*)\}/)[1].matchAll(/(\w+):/g)].map((m) => m[1])
  const fromCss = [...css.matchAll(/:root\[data-theme="([a-z]+)"\]/g)].map((m) => m[1])
  assert.deepEqual(SC.THEME_NAMES, fromJs, 'app.js THEMES')
  assert.deepEqual(SC.THEME_NAMES, fromCss, 'app.css data-theme rules')
  assert.equal(SC.THEME_NAMES.includes(SC.BUNDLE_THEME), true)
})

ok('the Dock icon for a theme is a known file, from source or from the bundle, and nothing for any other name', () => {
  const where = { appDir: '/r/syzygy-app', resourcesPath: '/b/Resources' }
  assert.equal(SC.dockIconFor('green', { ...where, packaged: false }), '/r/syzygy-app/dist/icon/themes/green.png')
  assert.equal(SC.dockIconFor('red', { ...where, packaged: true }), '/b/Resources/themes/red.png')
  for (const bad of ['', 'mint', '../green', 'constructor', null, undefined, 3]) {
    assert.equal(SC.dockIconFor(bad, { ...where, packaged: false }), null, String(bad))
  }
})

ok('main.js hears the theme on one channel, never answers, and checks the name', () => {
  const src = readFileSync(join(APP, 'main.js'), 'utf8')
  assert.match(src, /ipcMain\.on\('szg:theme'/)
  assert.equal((src.match(/ipcMain\.\w+\(/g) || []).length, 1, 'one ipcMain registration')
  assert.equal(/ipcMain\.(handle|handleOnce)\(/.test(src), false, 'no request and response channel')
  assert.match(src, /THEME_NAMES\.includes\(/)
})

ok('the drag stylesheet marks the top bar and its spacer, frees every other child, and is only presentation', () => {
  const css = SC.DRAG_CSS
  assert.match(css, /\.topbar \{ -webkit-app-region: drag; \}/)
  assert.match(css, /\.topbar > \* \{ -webkit-app-region: no-drag; \}/)
  assert.match(css, /\.topbar > \.spacer \{ -webkit-app-region: drag; \}/)
  assert.ok(css.indexOf('> *') < css.indexOf('.spacer'), 'the spacer rule comes after, so it wins')
  for (const bad of ['url(', '@import', 'expression', 'javascript:', 'content:']) {
    assert.equal(css.includes(bad), false, bad)
  }
})

ok('the window has no title bar, hides its buttons, and gives both pages a drag region', () => {
  const src = readFileSync(join(APP, 'main.js'), 'utf8')
  assert.match(src, /titleBarStyle: 'hidden'/)
  assert.match(src, /setWindowButtonVisibility\(false\)/)
  assert.match(src, /insertCSS\(SC\.DRAG_CSS\)/)
  assert.equal((src.match(/insertCSS\(/g) || []).length, 1, 'one stylesheet, the drag one')
  const html = readFileSync(join(APP, 'offline.html'), 'utf8')
  assert.match(html, /-webkit-app-region: drag/)
})

console.log(pass + ' passed')
