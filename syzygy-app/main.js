// The Electron shell around the pane. This file is WIRING: every decision it
// makes comes from shell-core.js and menu-core.js, which have no Electron in
// them and are tested directly.
import { app, BrowserWindow, Menu, session, screen, shell, dialog, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as SC from './shell-core.js'
import * as MENU from './menu-core.js'

const APP_DIR = dirname(fileURLToPath(import.meta.url))
const OFFLINE_TEMPLATE = join(APP_DIR, 'offline.html')
const HOME = homedir()
const DATA_DIR = process.env.SZG_DATA_DIR || join(HOME, '.claude', 'syzygy')
// The template with its two placeholders filled, written beside the window
// state. A real file rather than a data: URL, so the one file: document this
// window ever loads has an address externalDecision can match exactly.
const OFFLINE_FILE = join(DATA_DIR, 'app-offline.html')
const OFFLINE_URL = pathToFileURL(OFFLINE_FILE).href
const STATE_FILE = join(DATA_DIR, 'app-window.json')
const CONFIG_FILE = join(HOME, '.claude', 'syzygy-relay.json')

const readText = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const readJson = (p) => { try { return JSON.parse(readText(p)) } catch { return null } }

const config = SC.readRelayConfig(readText(CONFIG_FILE))
const { port, source: portSource } = SC.resolvePort({ argv: process.argv.slice(1), env: process.env, config })
const { token } = SC.resolveToken({ env: process.env, config })
const ORIGIN = `http://127.0.0.1:${port}`

let win = null
let mode = 'normal'

const health = async () => {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 1500)
  try {
    const res = await fetch(SC.relayUrl(port, '/api/health'), { signal: ctl.signal })
    return res.ok ? await res.json() : null
  } catch { return null } finally { clearTimeout(t) }
}

const startRelay = (bridgePath) => {
  const node = SC.resolveNode({ env: process.env, home: HOME, execPath: process.execPath, exists: existsSync })
  mkdirSync(DATA_DIR, { recursive: true })
  // Appended, never truncated, and in the relay's own state directory -- not
  // /tmp, which is world-writable and where a planted symlink would have this
  // output overwrite whatever it points at.
  const log = openSync(join(DATA_DIR, 'relay.log'), 'a')
  const child = spawn(node.bin, [bridgePath], {
    detached: true,
    stdio: ['ignore', log, log],
    env: SC.spawnEnv(process.env, { token, port, viaElectron: node.viaElectron }),
  })
  child.unref()
}

const waitForRelay = async () => {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await health()) return true
  }
  return false
}

// A replacer FUNCTION, never a replacement string: String.replace() treats some
// characters in the replacement as special, and the reason text is not ours.
const showOffline = (reason) => {
  const html = readText(OFFLINE_TEMPLATE)
    .replace('__SZG_PORT__', () => String(port))
    .replace('__SZG_REASON__', () => reason)
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(OFFLINE_FILE, html)
    win.loadFile(OFFLINE_FILE)
  } catch {
    win.loadFile(OFFLINE_TEMPLATE)
  }
}

/** The whole relay decision, re-runnable: it is what the window does at start
 *  and what Reconnect does later. The pane latches offline after a relay blip
 *  and will not reconnect on its own, so re-running this is the way back. */
const connect = async () => {
  const live = await health()
  const bridgePath = SC.bridgeCandidates({ home: HOME, appDir: APP_DIR }).find((c) => existsSync(c)) || null
  const d = SC.relayDecision({ healthy: !!live, portSource, bridgePath, token })
  if (d.action === 'load') return win.loadURL(ORIGIN + '/')
  if (d.action === 'refuse') return showOffline(d.reason)
  startRelay(bridgePath)
  if (await waitForRelay()) return win.loadURL(ORIGIN + '/')
  showOffline('the relay was started but never answered; see relay.log')
}

const sendKeys = (action) => {
  const events = MENU.keyEventsFor(action)
  if (!events.length || !win) return
  win.focus()
  for (const e of events) win.webContents.sendInputEvent(e)
}

const runAction = async (action, item) => {
  if (action === 'app:about') {
    const live = await health()
    dialog.showMessageBox(win, {
      type: 'info',
      message: 'Syzygy',
      detail: live
        ? `relay on ${live.port}, build ${live.build?.sha || 'unknown'}, ${live.sessions} sessions`
        : `no relay answering on ${port}`,
    })
    return
  }
  if (action === 'relay:reload') {
    // On the failure page a reload would re-render the same static file, so ⌘R
    // there means what ⌥⌘R means everywhere: ask again whether there is a relay.
    return win.webContents.getURL().startsWith('file:') ? connect() : win.webContents.reload()
  }
  if (action === 'relay:reconnect') return connect()
  if (action === 'window:float') {
    mode = item?.checked ? 'floating' : 'normal'
    win.setAlwaysOnTop(mode === 'floating')
    return
  }
  sendKeys(action)
}

/** The data template becomes real menu items here, and only here. */
const buildMenu = () => {
  const wire = (items) => items.map((i) => {
    const out = { ...i }
    if (out.submenu) out.submenu = wire(out.submenu)
    if (out.action) { const a = out.action; out.click = (item) => { runAction(a, item).catch(() => {}) }; delete out.action }
    return out
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(wire(MENU.menuTemplate({ appName: 'Syzygy' }))))
}

const saveState = () => {
  if (!win || win.isDestroyed()) return
  const b = win.getNormalBounds()
  const next = { x: b.x, y: b.y, width: b.width, height: b.height, mode: win.isFullScreen() ? 'fullscreen' : mode }
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const tmp = STATE_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2))
    renameSync(tmp, STATE_FILE)
  } catch { /* a window position is not worth an error */ }
}

let saveTimer = null
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 800) }

const createWindow = () => {
  const state = SC.sanitizeWindowState(readJson(STATE_FILE), screen.getAllDisplays())
  mode = state.mode === 'fullscreen' ? 'normal' : state.mode
  win = new BrowserWindow({
    ...(state.bounds || SC.DEFAULT_BOUNDS),
    minWidth: SC.MIN_SIZE.width,
    minHeight: SC.MIN_SIZE.height,
    title: 'Syzygy',
    show: false,
    backgroundColor: '#0b0f12',
    // No title bar: the window is only the pane. The buttons are hidden once the
    // window exists, and the pane's own top bar becomes the drag handle.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' } : {}),
    webPreferences: {
      preload: join(APP_DIR, 'preload.cjs'),
      partition: 'persist:syzygy',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })
  if (state.mode === 'fullscreen') win.setFullScreen(true)
  if (mode === 'floating') win.setAlwaysOnTop(true)
  if (process.platform === 'darwin') win.setWindowButtonVisibility(false)
  // With no title bar there is nothing to drag the window by, so the pane's top
  // bar is marked as the handle. insertCSS is presentation, never script, and it
  // goes only into the relay's own page; the failure page carries its own.
  win.webContents.on('did-finish-load', () => {
    if (SC.externalDecision(win.webContents.getURL(), { origin: ORIGIN }) !== 'internal') return
    win.webContents.insertCSS(SC.DRAG_CSS).catch(() => {})
  })
  win.once('ready-to-show', () => win.show())
  win.on('resize', saveSoon)
  win.on('move', saveSoon)
  win.on('close', saveState)
  win.on('closed', () => { win = null })

  const out = (url) => { if (SC.externalDecision(url, { origin: ORIGIN, offlineUrl: OFFLINE_URL }) === 'open') shell.openExternal(url) }
  win.webContents.setWindowOpenHandler(({ url }) => { out(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, url) => {
    if (SC.externalDecision(url, { origin: ORIGIN, offlineUrl: OFFLINE_URL }) !== 'internal') { e.preventDefault(); out(url) }
  })
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) showOffline(`the relay stopped answering (${desc})`)
  })
  // The failure page first, reading as "connecting", so the window appears at
  // once even while a relay is being started; connect() replaces it. A failed
  // loadURL rejects, and did-fail-load has already drawn the failure page.
  showOffline('connecting')
  connect().catch(() => {})
}

/** The Dock icon for a theme, when its PNG exists; the default otherwise. */
const setDockIcon = (theme) => {
  if (process.platform !== 'darwin') return
  const icon = SC.dockIconFor(theme, { packaged: app.isPackaged, appDir: APP_DIR, resourcesPath: process.resourcesPath })
  if (icon && existsSync(icon)) app.dock.setIcon(icon)
}

/** The preload's one message: the accent the pane is showing. Taken only from
 *  this window's top frame while it shows the relay's own pane, and only for a
 *  theme the shell knows; there is no reply. */
const onTheme = (e, name) => {
  if (!win || e.sender !== win.webContents) return
  const frame = e.senderFrame
  if (!frame || frame.parent) return
  if (SC.externalDecision(frame.url, { origin: ORIGIN }) !== 'internal') return
  if (SC.THEME_NAMES.includes(name)) setDockIcon(name)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setName('Syzygy')
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })
  app.on('window-all-closed', () => { /* darwin: the app stays in the Dock */ })
  app.on('activate', () => { if (!win) createWindow() })
  // Chained, never awaited at the top level: Electron finishes evaluating this
  // module before it starts the browser loop, and ready cannot fire until that
  // loop runs, so a top-level await here waits for itself and no window opens.
  app.whenReady().then(() => {
    // A run from source takes its Dock icon from the Electron binary, and the
    // built app starts on the icon in its own bundle. From source, start on the
    // bundle's theme too; either way the pane's own accent replaces it once the
    // page reports which one it is showing.
    if (!app.isPackaged) setDockIcon(SC.BUNDLE_THEME)
    ipcMain.on('szg:theme', onTheme)
    // Named so the login cookie has a home that survives a quit, and so that
    // forgetting the login is one deletable directory.
    session.fromPartition('persist:syzygy')
    buildMenu()
    createWindow()
  })
}
