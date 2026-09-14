// The menu as data. No Electron import, no functions in the template: an item
// carries an ACTION STRING and main.js maps that to a function, which is what
// lets the harness assert the whole menu -- above all that it never binds a key
// the page already owns.

export const VIEWS = ['control', 'telemetry', 'projects', 'dispatch', 'canvas', 'sandbox', 'space']

const LABELS = {
  control: 'Control', telemetry: 'Telemetry', projects: 'Projects',
  dispatch: 'Dispatch', canvas: 'Canvas', sandbox: 'Sandbox', space: 'Space',
}

/** One spelling for a chord, so the collision check is a set lookup. */
export const normalizeAccel = (accel) => {
  if (!accel) return ''
  return String(accel).toLowerCase().split('+').map((p) => p.trim()).filter(Boolean)
    .map((p) => {
      if (p === 'command' || p === 'commandorcontrol' || p === 'cmdorctrl') return 'cmd'
      if (p === 'option') return 'alt'
      if (p === 'control' || p === 'ctrl') return 'ctrl'
      if (p === 'enter') return 'return'
      if (p === 'plus') return '+'
      return p
    })
    .join('+')
}

/** The chords the page handles itself. A menu accelerator consumes the key
 *  before the page ever sees it, and on macOS there is no way to display an
 *  accelerator without registering it -- so an item for one of these carries
 *  the chord in its LABEL and no accelerator at all.
 *
 *  The view digits are deliberately absent: the pane's own digit router reads
 *  a bare e.key with no modifier guard, so it already answers those chords, and
 *  the menu item re-delivers the bare digit it reads. Nothing changes.
 *
 *  Bare-modifier gestures (a held Alt for the deck, a held Control for voice,
 *  a double-tapped Alt) cannot be menu accelerators at all, and are listed so
 *  nobody tries. */
/** What Electron binds for the roles this menu uses, on macOS. A role's
 *  accelerator is not spelled in the template, so the collision check cannot
 *  see it without this table -- and a role that quietly took ⌘K would be as
 *  damaging as an explicit accelerator that did. */
export const ROLE_DEFAULTS = {
  close: 'cmd+w', minimize: 'cmd+m', zoom: '', front: '',
  quit: 'cmd+q', hide: 'cmd+h', hideOthers: 'alt+cmd+h', unhide: '',
  resetZoom: 'cmd+0', zoomIn: 'cmd+plus', zoomOut: 'cmd+-',
  togglefullscreen: 'ctrl+cmd+f', toggleDevTools: 'alt+cmd+i',
  editMenu: '',
}

export const PANE_CHORDS = [
  'escape',
  'cmd+shift+return', 'ctrl+shift+return',
  'cmd+shift+k', 'ctrl+shift+k',
  'cmd+k', 'ctrl+k',
  'cmd+return', 'ctrl+return',
  'alt+shift+p',
  'alt+up', 'alt+down',
  'alt+t',
  'alt', 'ctrl', 'shift',
]

export const menuTemplate = ({ appName = 'Syzygy' } = {}) => [
  {
    label: appName,
    submenu: [
      { label: `About ${appName}`, action: 'app:about' },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  },
  { label: 'File', submenu: [{ role: 'close' }] },
  // editMenu is a MENU role: it expands into a whole submenu, so it belongs on
  // the top-level item and never inside one. Without it a packaged app has no
  // working clipboard shortcuts in its renderer at all.
  { label: 'Edit', role: 'editMenu' },
  {
    label: 'View',
    submenu: [
      ...VIEWS.map((v, i) => ({
        label: LABELS[v], accelerator: `CommandOrControl+${i + 1}`, action: `view:${i + 1}`,
      })),
      { type: 'separator' },
      { label: 'Reload', accelerator: 'CommandOrControl+R', action: 'relay:reload' },
      { label: 'Reconnect to the Relay', accelerator: 'Alt+CommandOrControl+R', action: 'relay:reconnect' },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { role: 'toggleDevTools' },
    ],
  },
  {
    label: 'Window',
    submenu: [
      { role: 'minimize' }, { role: 'zoom' },
      { type: 'separator' },
      { label: 'Float Above Other Windows', accelerator: 'Alt+CommandOrControl+T', action: 'window:float',
        type: 'checkbox' },
      { type: 'separator' },
      { role: 'front' },
    ],
  },
  {
    label: 'Help',
    submenu: [
      { label: 'Command Bar  ⌘⇧⏎', action: 'chord:cmdbar' },
      { label: 'Quick Access — hold ⌥ in the command bar', enabled: false },
      { label: 'Pin a Conversation — ⌥⇧P', enabled: false },
      { label: 'Presets — ⌥T on a prompt field', enabled: false },
      { label: 'Dictate — hold ⌃ in a field (browser only)', enabled: false },
      { type: 'separator' },
      { label: 'Views are 1-7, or ⌘1-⌘7', enabled: false },
    ],
  },
]

/** The key events an action delivers to the page, or none. A key event is data;
 *  injected script is code, and the renderer is sandboxed precisely so that no
 *  code goes in. */
export const keyEventsFor = (action) => {
  const view = /^view:([1-7])$/.exec(String(action || ''))
  if (view) {
    return [{ type: 'keyDown', keyCode: view[1] }, { type: 'keyUp', keyCode: view[1] }]
  }
  if (action === 'chord:cmdbar') {
    const mods = ['shift', 'meta']
    return [
      { type: 'keyDown', keyCode: 'Return', modifiers: mods },
      { type: 'keyUp', keyCode: 'Return', modifiers: mods },
    ]
  }
  return []
}
