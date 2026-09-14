// Every decision the shell makes, with no Electron and no I/O in it, so the
// harness can drive all of it under node. main.js does the reading, the
// spawning and the window; this file only decides.

export const RELAY_PORT_DEFAULT = 4317
export const RELAY_HOST = '127.0.0.1'

/** A port is an integer in 1..65535. A numeric string counts: the config file
 *  is hand-editable and "4319" is what a person types. */
export const validPort = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

/** The shared relay config as text. Every failure is a pair of nulls: the file
 *  belongs to the band, which mints and rewrites it, and this process never
 *  writes it -- two writers of one bearer token is how a band and a relay end
 *  up on different secrets. */
export const readRelayConfig = (text) => {
  const none = { token: null, port: null }
  if (typeof text !== 'string' || !text.trim()) return none
  let parsed
  try { parsed = JSON.parse(text) } catch { return none }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return none
  const token = typeof parsed.token === 'string' && parsed.token ? parsed.token : null
  return { token, port: validPort(parsed.port) }
}

export const resolvePort = ({ argv = [], env = {}, config = {} } = {}) => {
  const i = argv.indexOf('--port')
  const fromArgv = i >= 0 ? validPort(argv[i + 1]) : null
  if (fromArgv) return { port: fromArgv, source: 'argv' }
  const fromEnv = validPort(env.SZG_RELAY_PORT)
  if (fromEnv) return { port: fromEnv, source: 'env' }
  const fromFile = validPort(config.port)
  if (fromFile) return { port: fromFile, source: 'config' }
  return { port: RELAY_PORT_DEFAULT, source: 'default' }
}

export const resolveToken = ({ env = {}, config = {} } = {}) => {
  const e = typeof env.SZG_RELAY_TOKEN === 'string' && env.SZG_RELAY_TOKEN ? env.SZG_RELAY_TOKEN : null
  if (e) return { token: e, source: 'env' }
  const f = typeof config.token === 'string' && config.token ? config.token : null
  if (f) return { token: f, source: 'config' }
  return { token: null, source: 'none' }
}

/** Always the address the relay binds. A cookie set on 127.0.0.1 is not sent to
 *  localhost, so one spelling for the life of the app or the password is asked
 *  for again every time the spelling changes. */
export const relayUrl = (port, path) => `http://${RELAY_HOST}:${port}${path}`

/** Where relay.mjs may be. The installed plugin first, exactly as the band
 *  looks for it; the checkout this app sits in last, so a developer running
 *  from source without the plugin installed still works. */
export const bridgeCandidates = ({ home = '', appDir = '' } = {}) => {
  const out = []
  if (home) {
    out.push(`${home}/.claude/skills/syzygy/bridge/relay.mjs`)
    out.push(`${home}/.claude/plugins/cache/syzygy/bridge/relay.mjs`)
  }
  if (appDir) out.push(appDir.replace(/\/syzygy-app\/?$/, '') + '/syzygy/bridge/relay.mjs')
  return out
}

/** load, spawn, or refuse -- and refusing says why, because the failure page
 *  prints the reason. A port this launch was GIVEN is never spawned on: an
 *  explicit port means "attach to that relay", and two relays over one data
 *  directory corrupt each other's stores. A port read from the config file is
 *  the machine's own default, not a per-launch instruction, so it may spawn. */
export const relayDecision = ({ healthy, portSource, bridgePath, token }) => {
  if (healthy) return { action: 'load', reason: 'the relay answered' }
  if (portSource === 'argv' || portSource === 'env') {
    return { action: 'refuse', reason: 'nothing is answering on the port this launch was given' }
  }
  if (!bridgePath) return { action: 'refuse', reason: 'relay.mjs is not installed anywhere this can find' }
  if (!token) return { action: 'refuse', reason: 'no token in ~/.claude/syzygy-relay.json' }
  return { action: 'spawn', reason: 'no relay on the default port' }
}

export const DEFAULT_BOUNDS = { width: 1440, height: 900 }
export const MIN_SIZE = { width: 900, height: 600 }
export const MODES = ['normal', 'floating', 'fullscreen']

/** The relay's environment. Every SZG_ key the app inherited is deleted before
 *  the two it needs are set: a stray SZG_DATA_DIR or SZG_PANE_PASSWORD_DISABLED
 *  from whichever shell opened the app would move the relay's whole world or
 *  turn its password off, and a launch from the Dock has none of them while a
 *  launch from a developer's shell may have all of them. */
export const spawnEnv = (env = {}, { token, port, viaElectron } = {}) => {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('SZG_')) out[k] = v
  out.SZG_TOKEN = String(token)
  out.SZG_PORT = String(port)
  if (viaElectron) out.ELECTRON_RUN_AS_NODE = '1'
  return out
}

/** A real node if there is one, this binary in node mode if there is not.
 *  A launch from the Dock inherits launchd's minimal PATH, so the band's
 *  `command -v node` finds nothing at all there; the fixed places are tried
 *  first for exactly that case. */
export const resolveNode = ({ env = {}, home = '', execPath = '', exists = () => false } = {}) => {
  const fixed = ['/opt/homebrew/bin/node', '/usr/local/bin/node']
  if (home) fixed.push(`${home}/.local/bin/node`)
  fixed.push('/usr/bin/node')
  const onPath = String(env.PATH || '').split(':').filter(Boolean).map((d) => `${d}/node`)
  for (const c of [...fixed, ...onPath]) if (exists(c)) return { bin: c, viaElectron: false }
  return { bin: execPath, viaElectron: true }
}

const intish = (v) => (Number.isFinite(v) && Number.isInteger(v) ? v : null)

/** The saved geometry, or nulls. Not authoritative: the only thing a bad file
 *  costs is a window position, so it is never an error and never a refusal --
 *  it is the default. An unknown mode name falls back the way an unknown corner
 *  style does, with no migration code. */
export const sanitizeWindowState = (saved, displays = []) => {
  const fallback = { bounds: null, mode: 'normal' }
  if (!saved || typeof saved !== 'object') return fallback
  const x = intish(saved.x)
  const y = intish(saved.y)
  let width = intish(saved.width)
  let height = intish(saved.height)
  if (x === null || y === null || width === null || height === null) return fallback
  width = Math.max(width, MIN_SIZE.width)
  height = Math.max(height, MIN_SIZE.height)
  const visible = displays.some((d) => {
    const a = d?.workArea
    if (!a) return false
    return x + width > a.x + 120 && x < a.x + a.width - 120 &&
      y + height > a.y + 40 && y < a.y + a.height - 40
  })
  if (!visible) return fallback
  const mode = MODES.includes(saved.mode) ? saved.mode : 'normal'
  return { bounds: { x, y, width, height }, mode }
}

/** internal, open, or deny. The scheme is checked HERE and not in the page,
 *  because the pane's one link source is markdown a model wrote: a filter in
 *  the renderer is not a trust boundary. The offline page is the only file:
 *  document this window ever loads, and it is matched exactly. */
export const externalDecision = (url, { origin, offlineUrl } = {}) => {
  let u
  try { u = new URL(url) } catch { return 'deny' }
  if (origin && u.origin === origin) return 'internal'
  if (u.protocol === 'file:') return offlineUrl && u.href === offlineUrl ? 'internal' : 'deny'
  if (u.protocol === 'http:' || u.protocol === 'https:') return 'open'
  return 'deny'
}

/** The pane's accents, by the name app.js stores and sets on <html>. The
 *  harness holds this list equal to app.js's THEMES and app.css's rules. */
export const THEME_NAMES = ['teal', 'red', 'orange', 'purple', 'green']

/** The theme whose icon the bundle itself carries, where Finder and Launchpad
 *  show it; the Dock follows the pane's accent once the pane has loaded. */
export const BUNDLE_THEME = 'green'

/** The Dock icon for a theme, or null for anything that is not one. Packaged,
 *  the PNGs ride in the bundle's Resources; from source they sit where
 *  make-icon.py writes them. */
export const dockIconFor = (name, { packaged = false, appDir = '', resourcesPath = '' } = {}) => {
  if (!THEME_NAMES.includes(name)) return null
  if (packaged) return resourcesPath ? `${resourcesPath}/themes/${name}.png` : null
  return appDir ? `${appDir}/dist/icon/themes/${name}.png` : null
}

/** The window has no title bar, so the pane's top bar is the drag handle: the
 *  bar drags, every direct child of it does not, and the empty spacer does
 *  again. Every control stays clickable, including any added to the bar later.
 *  Presentation only -- this is the one stylesheet the shell ever inserts. */
export const DRAG_CSS = [
  '.topbar { -webkit-app-region: drag; }',
  '.topbar > * { -webkit-app-region: no-drag; }',
  '.topbar > .spacer { -webkit-app-region: drag; }',
].join(' ')
