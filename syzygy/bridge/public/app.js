/* Syzygy — the pane. Vanilla, zero dependencies, canvas for everything animated. */
'use strict'

const TOKEN = window.SZG_TOKEN
const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }

// ------------------------------------------------------------------- state
const S = {
  sessions: [], events: [], questions: [], approvals: [], links: [],
  projects: [], linkFrom: null,
  dispatch: { requests: [] },
  steering: { custom: [] },   // the user's own steering buttons; see renderSteer()
  canvas: { nodes: {}, spawnedBy: [], recents: [], live: 0, home: '' },   // the session canvas; see canvas.js
  usage: null,             // { fiveHour, sevenDay, observedAt, stale } or null before the first snapshot -- usage.mjs's parseUsage shape, verbatim
  usageHistory: [],        // ring of { t, usage }: the relay's changed-readings-only sparkline feed
  afterReset: { queue: [] },   // the after-reset queue; the relay is the only writer
  // Voice input; see voice.js. `ready` false and empty env/model/worker is
  // exactly what a relay predating this feature looks like too
  // -- absence must mean off, so this default is
  // deliberately indistinguishable from that case rather than a special
  // "not loaded yet" shape.
  voice: { enabled: false, ready: false, env: {}, model: {}, worker: {} },
  // The gear's Spinner control. Empty spinners is exactly what a relay
  // predating the `hud` snapshot key looks like too --
  // absence must mean "not found here", so this default is deliberately
  // indistinguishable from that case rather than a special "not loaded yet"
  // shape, same reasoning as `voice` just above.
  hud: { spinners: [], current: null },
  auth: { enabled: false },   // the gear's password section; from the snapshot only, see connect()
  // The orchestrator agent.
  // `orchestrator` stays undefined until a payload actually carries the
  // field -- an older relay never sends it, and that must render as the
  // blurb simply being absent, never as an empty one (see renderBlurb()).
  // `orchTurns` and `orchTranscriptHidden` are client-only: the transcript
  // is not part of the relay's snapshot at all, only the SSE frames that
  // build it up turn by turn. A turn's own `pending`/`serverId` is how
  // sendAsk's optimistic echo and the SSE frame that later carries the real
  // turn id find each other without duplicating.
  // `orchTranscriptHidden` is a VIEW toggle only -- dismissing the
  // panel never touches the conversation itself or `S.orchTurns`; that is
  // what makes it different from POST /api/orchestrator/clear.
  orchestrator: undefined,
  orchTurns: [],
  orchTranscriptHidden: false,
  viewers: 1, view: 'control',
  connectedAt: null,      // when this tab's event stream opened, for the clock's tooltip
  peek: null,             // session id hovered on the switchboard
  armed: null,            // a steering command waiting for a target, or null
  marks: [],              // session ids gathered with option-click while armed
  mods: { all: false, add: false },   // A and Option, as held right now
  pinned: null,           // session id whose drawer is open. A pin OUTRANKS a
                          // hover: once you have opened a card you are reading
                          // that session, and sweeping the pointer across the
                          // board on the way to something else must not swap
                          // the rail out from under you. See scoped().
  renaming: null,         // session id whose drawer title is currently a field,
                          // or null. Held so a redraw of the SAME card leaves
                          // a half-typed name alone while a switch to another
                          // cancels it -- openDrawer runs on every payload.
  pointer: { x: 0.5, y: 0.5 },
  focus: null,            // session id shown in the tiles/charts
  connected: false,
  activity: 0,            // 0..1: decays, but held at a floor while work is
                           // genuinely happening (see ACTIVITY_FLOOR below) --
                           // drives the swarm
  mood: 'idle',
  drag: null,             // { from, x, y }
}

const post = async (path, body) => {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mch-token': TOKEN },
      body: JSON.stringify({ token: TOKEN, ...body }),
    })
    return await r.json()
  } catch { return { error: 'unreachable' } }
}

let toastTimer
/** One transient line at the foot of the deck. `kind` picks the treatment
 *  ('warn' for a standing notice); `ms` how long it holds. Any notice that
 *  wants this slot in future goes through here rather than growing a second
 *  notification system. */
const toast = (msg, { ms = 2600, kind = '' } = {}) => {
  const t = $('toast'); t.textContent = msg
  t.className = 'toast show' + (kind ? ' ' + kind : '')
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms)
}
// Clicking it away is always allowed, and cancels the timer that would have
// done it anyway.
$('toast').addEventListener('click', () => { clearTimeout(toastTimer); $('toast').classList.remove('show') })

addEventListener('pointermove', (e) => {
  S.pointer.x = e.clientX / innerWidth
  S.pointer.y = e.clientY / innerHeight
})

// ------------------------------------------------------------- formatting
const compact = (n) => {
  n = Number(n) || 0
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) { const k = n / 1e3; return (k < 100 ? k.toFixed(1) : Math.round(k)) + 'k' }
  const m = n / 1e6; return (m < 100 ? m.toFixed(2) : Math.round(m)) + 'M'
}
const money = (v) => { v = Number(v) || 0; return v >= 100 ? '$' + v.toFixed(0) : v >= 1 ? '$' + v.toFixed(2) : '$' + v.toFixed(3) }
const clockOf = (t) => new Date(t).toLocaleTimeString('en-GB', { hour12: false })
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  return Math.floor(s / 3600) + 'h'
}
/** `ago`'s mirror image, for a boundary still ahead: "3h 20m" style, two
 *  units at most since a usage window resets on the order of hours, not
 *  seconds. `resetsAt` is a real clock reading from usage.mjs (already
 *  converted to ms) — this recomputes against Date.now() on every call, which
 *  is what lets the row keep counting down between relay pushes (see the 4s
 *  renderTiles() tick). */
const until = (resetsAt) => {
  if (!Number.isFinite(resetsAt)) return ''
  const totalMin = Math.max(0, Math.round((resetsAt - Date.now()) / 60000))
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}
const focused = () => S.sessions.find((s) => s.id === S.focus) || S.sessions[0] || null
/** The session worth showing when the user has not picked one: whoever is
 *  working; failing that, whoever has actually done something (a fresh session
 *  with an empty context should not outrank one mid-task); failing that, the
 *  most recent. */
const bestFocus = () => {
  const working = S.sessions.filter((s) => s.working).sort((a, b) => b.seenAt - a.seenAt)[0]
  if (working) return working.id
  const busy = [...S.sessions].sort((a, b) =>
    ((b.stats?.ctx || 0) + (b.stats?.tools || 0) * 1000) - ((a.stats?.ctx || 0) + (a.stats?.tools || 0) * 1000)
    || b.seenAt - a.seenAt)[0]
  return busy?.id ?? null
}

// ================================================================== tooltip
/* The deck's own tooltip, not the browser's. Anything with [data-tip] gets
   one; the first line is the headline and the rest is body. Delegated from
   the document, so nothing has to be re-wired when a node is rebuilt -- the
   session cards and the feed rows are rebuilt constantly.

   Native title= was used for one round and replaced: it renders in the OS's
   chrome rather than the deck's, it arrives on the OS's schedule rather than
   ours, and it cannot carry two weights. */
const TIP_DELAY = 240
let tipTimer = 0
let tipFor = null

const placeTip = (host) => {
  const tip = $('tip')
  const a = host.getBoundingClientRect()
  const t = tip.getBoundingClientRect()
  const gap = 8
  // Below by default, above if there is no room; clamped to the viewport so a
  // tip on a pill at the right edge stays fully on screen.
  let top = a.bottom + gap
  if (top + t.height > innerHeight - gap) top = Math.max(gap, a.top - t.height - gap)
  let left = a.left
  if (left + t.width > innerWidth - gap) left = innerWidth - gap - t.width
  tip.style.left = Math.max(gap, left) + 'px'
  tip.style.top = top + 'px'
}

const showTip = (host) => {
  const text = host.dataset.tip
  if (!text) return
  const tip = $('tip')
  tip.textContent = ''
  const lines = text.split('\n')
  tip.appendChild(el('div', 'tiphead', lines[0]))
  for (const ln of lines.slice(1)) if (ln) tip.appendChild(el('div', 'tipline', ln))
  tip.hidden = false
  placeTip(host)
  tip.classList.add('show')
  tipFor = host
}

const hideTip = () => {
  clearTimeout(tipTimer); tipTimer = 0; tipFor = null
  const tip = $('tip')
  tip.classList.remove('show')
  tip.hidden = true
}

addEventListener('pointerover', (e) => {
  const host = e.target instanceof Element ? e.target.closest('[data-tip]') : null
  if (!host || host === tipFor) return
  hideTip()
  tipTimer = setTimeout(() => showTip(host), TIP_DELAY)
})
addEventListener('pointerout', (e) => {
  const host = e.target instanceof Element ? e.target.closest('[data-tip]') : null
  if (!host) return
  if (e.relatedTarget instanceof Element && e.relatedTarget.closest('[data-tip]') === host) return
  hideTip()
})
// A tip that outlives what it describes is worse than no tip.
addEventListener('pointerdown', hideTip)
addEventListener('scroll', hideTip, true)
addEventListener('blur', hideTip)

// =================================================================== theme
/* Canvas takes no CSS custom properties, so everything drawn to one -- the
   link traces, the sparklines, the context arc, the replay timeline -- needs
   real colour values. They used to be hex literals kept "in step
   with the tokens", which is a promise rather than a mechanism, and which the
   theme picker would have broken outright.
   These are READ OUT of the live stylesheet instead, so a theme change is one
   attribute on <html> and every canvas follows. Resolving is the fiddly part:
   getPropertyValue hands back the authored token (`hsl(var(--hue) ...)`), not
   a colour -- so a probe element takes the value as its `color` and the
   computed style hands back a resolved rgb() triple. */
const THEMES = { teal: 196, red: 356, orange: 28, purple: 276, green: 152 }
const THEME_KEY = 'szg.theme'
/* How the logo's hover resolves. `eclipse` is the default and the fallback
   both, so it must always be present.
     eclipse — a hairline closes around the aligned pair.
     line    — the whole arrangement swings side-on: the stacked bodies spread
               into three discs in a row, near body on the right. */
const MARKS = { eclipse: 'eclipse', line: 'line' }
const markNames = () => Object.keys(MARKS)
const MARK_KEY = 'szg.mark'
const probe = document.createElement('span')
probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
document.documentElement.appendChild(probe)

const resolveVar = (name) => {
  probe.style.color = ''
  probe.style.color = `var(${name})`
  const m = getComputedStyle(probe).color.match(/[\d.]+/g)
  if (!m) return '#000000'
  return '#' + m.slice(0, 3).map((v) => Math.round(Number(v)).toString(16).padStart(2, '0')).join('')
}

/** Live theme colours, as hex. Rebuilt by refreshTheme(); never edited by
 *  hand, and never captured into a closure that outlives a theme change.
 *  Published on window because replay.js and swarm.js draw to canvases too,
 *  and neither of them can see this module's scope. */
const T = {}
window.MCT = T
const refreshTheme = () => {
  for (const [k, v] of Object.entries({
    accent: '--accent', accentHot: '--accent-hot', accentDeep: '--accent-deep',
    accentDim: '--accent-dim', white: '--white', text: '--text', grey: '--grey',
    amber: '--amber', redHot: '--red-hot', green: '--green', purple: '--purple',
    edge: '--edge', bg: '--bg',
  })) T[k] = resolveVar(v)
  WIRE.src = T.accentDeep
  WIRE.mid = T.accent
  WIRE.head = T.accentHot
  WIRE.pulse = T.accentHot
}

const applyTheme = (name) => {
  const theme = name in THEMES ? name : 'teal'
  document.documentElement.dataset.theme = theme
  try { localStorage.setItem(THEME_KEY, theme) } catch {}
  refreshTheme()
  for (const b of document.querySelectorAll('.swatch')) {
    b.setAttribute('aria-pressed', String(b.dataset.theme === theme))
  }
  // Every canvas holds the OLD colours until something redraws it, and some of
  // them only redraw on an event that may not come for minutes.
  renderAll()
  layoutWires()
  window.MCS?.refreshTheme?.()
}

/* The gear. One popover, closed by anything that means "I'm done": a click
   outside it, esc, or the gear again. */
const closeSettings = () => {
  $('settingspop').hidden = true
  $('gear').setAttribute('aria-expanded', 'false')
  $('gear').classList.remove('on')
}
const wireSettings = () => {
  $('gear').onclick = (e) => {
    e.stopPropagation()
    const open = $('settingspop').hidden
    $('settingspop').hidden = !open
    $('gear').setAttribute('aria-expanded', String(open))
    $('gear').classList.toggle('on', open)
  }
  $('settingspop').addEventListener('click', (e) => e.stopPropagation())
  addEventListener('click', closeSettings)
}

/* --------------------------------------------------------- voice input --
   The settings section's state and its two write buttons. Field styles (the
   mic button, the listening states) are voice.js/voice.css's job; this is
   the popover only -- reads S.voice, writes through the same post() every
   other write in this file uses. */
const fmtBytes = (n) => {
  n = Number(n) || 0
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(0) + ' KB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(0) + ' MB'
  return (n / 1024 ** 3).toFixed(2) + ' GB'
}

const renderVoiceSettings = () => {
  const v = S.voice || {}
  const env = v.env || {}
  const m = v.model || {}
  const enableBox = $('voice-enable')
  if (enableBox && enableBox.checked !== !!v.enabled) enableBox.checked = !!v.enabled

  const envPct = Math.round((env.progress || 0) * 100)
  $('voice-envstate').textContent = env.installing
    ? `installing environment… ${envPct}%`
    : env.present ? `environment ready · ${fmtBytes(env.bytes)}`
    : env.error ? 'install failed — ' + env.error
    : 'environment not installed'
  $('voice-envprogressrow').hidden = !env.installing
  $('voice-envprogressbar').style.width = envPct + '%'
  $('voice-envprogresspct').textContent = envPct + '%'
  $('voice-install').disabled = !!env.installing || !!env.present

  const pct = Math.round((m.progress || 0) * 100)
  $('voice-modelstate').textContent = !env.present
    ? 'install the environment first'
    : m.downloading ? `downloading… ${pct}%`
    : m.present ? `model ready · ${fmtBytes(m.bytes)}`
    : m.error ? 'download failed — ' + m.error
    : `not downloaded · ${fmtBytes(m.expectedBytes)} required`
  $('voice-progressrow').hidden = !m.downloading
  $('voice-progressbar').style.width = pct + '%'
  $('voice-progresspct').textContent = pct + '%'
  $('voice-download').disabled = !env.present || !!m.downloading || !!m.present
  $('voice-delete').disabled = !m.present
}

const wireVoice = () => {
  $('voice-enable').addEventListener('change', (e) => { post('/api/voice/toggle', { on: e.target.checked }) })
  $('voice-install').addEventListener('click', () => { post('/api/voice/install', {}) })
  $('voice-download').addEventListener('click', () => { post('/api/voice/download', {}) })
  $('voice-delete').addEventListener('click', () => { post('/api/voice/delete', { what: 'model' }) })
}

/* The gear's Spinner control. `S.hud.spinners` is the same id/name list
   hud.tsx draws from (relay.mjs reads spinner-frames.js directly, never a
   second copy), so this select can never offer an id the band would reject.
   Rebuilding <option>s on every call is fine at 50 entries and keeps this
   from needing its own diffing -- MCX's keyed reconciliation is for payloads
   that redraw many times a second; this redraws on a snapshot or a `hud`
   SSE event, i.e. rarely. */
const renderHudSettings = () => {
  const h = S.hud || { spinners: [], current: null }
  const sel = $('hud-spinner')
  if (!sel) return
  if (!h.spinners.length) {
    sel.innerHTML = '<option value="">— not found on this relay —</option>'
    sel.disabled = true
    return
  }
  sel.disabled = false
  const options = ['<option value="">— leave to the picker —</option>']
  for (const s of h.spinners) options.push(`<option value="${s.id}">${s.name}</option>`)
  const html = options.join('')
  // Avoid clobbering the dropdown mid-interaction: only rebuild when the
  // list itself changed (it never does at runtime, but a relay restart with
  // a renamed spinner is exactly the case this guards).
  if (sel.dataset.built !== html) { sel.innerHTML = html; sel.dataset.built = html }
  sel.value = h.current || ''
}
const wireHud = () => {
  $('hud-spinner').addEventListener('change', (e) => { post('/api/hud/settings', { spinner: e.target.value }) })
}

/* The gear's Password section. A reset needs the CALLER's password, not the
   plugin's shared token; `post()` already carries the session cookie on
   every same-origin fetch, which is what actually authorizes it. */
const authStatus = (msg, kind) => {
  const el = $('authstatus')
  el.textContent = msg || ''
  el.className = 'authstatus' + (kind ? ' ' + kind : '')
}
const renderAuthSection = () => {
  const enabled = !!(S.auth && S.auth.enabled)
  $('authbox').hidden = !enabled
  authStatus(enabled ? '' : 'Password disabled (SZG_PANE_PASSWORD_DISABLED).')
}
const wireAuthSection = () => {
  $('authChange').onclick = async () => {
    const current = $('authCurrent').value
    const pw = $('authNew').value
    const confirm = $('authConfirm').value
    if (!pw || pw.length < 8) { authStatus('New password must be at least 8 characters.', 'err'); return }
    if (pw !== confirm) { authStatus('New passwords do not match.', 'err'); return }
    authStatus('Changing…')
    const r = await post('/api/auth/reset', { current, password: pw, confirm })
    if (r && r.ok) {
      $('authCurrent').value = ''; $('authNew').value = ''; $('authConfirm').value = ''
      authStatus('Password changed.', 'ok')
    } else {
      authStatus('Could not change the password.', 'err')
    }
  }
  $('authLogout').onclick = async () => {
    await post('/api/auth/logout', {})
    location.reload()
  }
}

/* Corner style: sharp (the deck's original chamfer), soft (the default,
   app.css) or space (fully rounded, pill buttons and inputs). One attribute
   on <html>, same mechanism as applyTheme -- [data-corners] rather than
   [data-theme], persisted per browser under its own key. app.css carries the
   soft VALUES on bare :root, so the only thing this needs to guarantee is
   that a stored 'sharp' or 'space' preference lands before first paint, the
   same guarantee applyTheme already gives THEME_KEY -- see the call beside
   applyTheme's own at the bottom of this file. */
const CORNERS = { sharp: 'Sharp', soft: 'Soft', space: 'Space-age' }
const CORNERS_KEY = 'szg.corners'
const applyCorners = (name) => {
  const corners = name in CORNERS ? name : 'soft'
  document.documentElement.dataset.corners = corners
  try { localStorage.setItem(CORNERS_KEY, corners) } catch {}
  for (const b of document.querySelectorAll('#corners button')) {
    b.setAttribute('aria-pressed', String(b.dataset.corners === corners))
  }
}
const buildCorners = () => {
  const box = $('corners')
  for (const [name, label] of Object.entries(CORNERS)) {
    const b = el('button', null, label)
    b.type = 'button'
    b.dataset.corners = name
    b.dataset.tip = {
      sharp: 'Sharp\nSquare corners, the deck\'s original chamfered bevel.',
      soft: 'Soft\nGently rounded corners. The default.',
      space: 'Space-age\nFully rounded, pill-shaped buttons and fields -- no glow.',
    }[name]
    b.onclick = () => applyCorners(name)
    box.appendChild(b)
  }
}

const applyMark = (name) => {
  const mark = markNames().includes(name) ? name : 'eclipse'
  document.documentElement.dataset.mark = mark
  try { localStorage.setItem(MARK_KEY, mark) } catch {}
  for (const b of document.querySelectorAll('#marks button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mark === mark))
  }
}

const buildMarks = () => {
  const box = $('marks')
  for (const name of markNames()) {
    const b = el('button', null, name)
    b.type = 'button'
    b.dataset.mark = name
    b.dataset.tip = {
      eclipse: 'Eclipse\nThe hover lands on a hairline closing around the aligned pair. The default.',
      line: 'Line\nThe stack rotates side-on: one eclipse becomes three bodies in a row, nearest on the right.',
    }[name]
    b.onclick = () => applyMark(name)
    box.appendChild(b)
  }
}

const buildSwatches = () => {
  const box = $('swatches')
  for (const [name, hue] of Object.entries(THEMES)) {
    const b = el('button', 'swatch')
    b.type = 'button'
    b.dataset.theme = name
    b.dataset.tip = `${name}\nRecolours the whole deck. Every theme is exactly as dark; only the hue moves.`
    b.setAttribute('aria-label', name)
    // Its own hue, not the active one: a picker whose options all restyle when
    // you pick one tells you nothing about what you are picking.
    b.style.setProperty('--sw', `hsl(${hue} 60% 65%)`)
    b.onclick = () => applyTheme(name)
    box.appendChild(b)
  }
}

// The ground behind the panels is flat --bg, painted by CSS on body: panels
// cover nearly the whole viewport, so anything drawn back there shows only in
// the gutters between them, where continuous motion in the corner of the eye
// reads as a glitch rather than as depth.
//
// The wires need a resize listener.
addEventListener('resize', () => layoutWires())

// ================================================================== mood
/* Mirrored by MOODS in swarm-math.js, which the swarm renders from and the
   harness pins the NAMES of against this table. Keep both in step. All this
   table carries is the label text under the sphere: mood-to-colour lives
   solely in swarm-math.js's MOODS plus swarm.js's own themedMood(). */
const MOOD = {
  idle:    { label: 'idle' },
  working: { label: 'working' },
  happy:   { label: 'green' },
  stuck:   { label: 'stuck' },
  blocked: { label: 'blocked' },
}
const firePulse = (strength = 1) => { S.activity = Math.min(1, S.activity + 0.35 * strength); window.MCS?.pulse(strength) }

// ================================================================ arc gauge
let arcShown = 0
const drawArc = (pct) => {
  const c = $('arc'), x = c.getContext('2d'), w = c.width, cx = w / 2, R = w * 0.36
  arcShown += (pct - arcShown) * 0.09
  x.clearRect(0, 0, w, w)
  x.lineWidth = w * 0.10; x.lineCap = 'round'
  x.beginPath(); x.arc(cx, cx, R, Math.PI * 0.75, Math.PI * 2.25)
  x.strokeStyle = T.edge; x.stroke()
  const col = arcShown >= 0.85 ? T.redHot : arcShown >= 0.65 ? T.amber : T.accent
  x.beginPath(); x.arc(cx, cx, R, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * Math.min(1, arcShown))
  /* No shadowBlur. A 16px glow on a 28px canvas is clipped by the canvas
     bounds on every side, which draws a visible square around the gauge --
     and a glow is not what this deck does anyway: the link traces and the
     sparklines both lost theirs for reading as diffuse rather than as drawn. */
  x.strokeStyle = col; x.stroke()
}

// ================================================================== charts
const sparkline = (canvas, values, color, fill) => {
  const d = Math.min(2, window.devicePixelRatio || 1)
  const box = canvas.getBoundingClientRect()
  const w = Math.max(1, Math.round((box.width || canvas.width / d) * d))
  const h = Math.max(1, Math.round((box.height || canvas.height / d) * d))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const x = canvas.getContext('2d')
  x.clearRect(0, 0, w, h)
  if (!values.length) return
  if (values.length === 1) values = [values[0], values[0]]
  const hi = Math.max(...values), lo = Math.min(...values)
  const flat = hi === lo
  // Baseline from the data, not forced to zero: a series that only varies in
  // its top decile should still show that variation rather than a solid block.
  const min = flat ? hi - 1 : lo - (hi - lo) * 0.25
  const max = flat ? hi + 1 : hi + (hi - lo) * 0.1
  const span = max - min || 1
  const px = (i) => (i / Math.max(1, values.length - 1)) * (w - 4) + 2
  const py = (v) => h - 6 - ((v - min) / span) * (h - 14)
  /* One device-pixel line, no shadow at all, and a wash faint enough to say
     "this is the area under it" without competing with the line that bounds
     it. A thicker line under a wide shadowBlur reads on a black ground as an
     overcast tube rather than as a plotted series, and on a card 120px wide a
     glow that wide is most of the chart. Same reasoning as the link traces: a
     steady halo around a hairline is indistinguishable from an outline on
     it. */
  if (fill) {
    const g = x.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, color + '1c'); g.addColorStop(1, color + '00')
    x.beginPath(); x.moveTo(px(0), h)
    values.forEach((v, i) => x.lineTo(px(i), py(v)))
    x.lineTo(px(values.length - 1), h); x.closePath(); x.fillStyle = g; x.fill()
  }
  x.beginPath()
  values.forEach((v, i) => (i ? x.lineTo(px(i), py(v)) : x.moveTo(px(i), py(v))))
  x.strokeStyle = color; x.lineWidth = d; x.lineJoin = 'round'; x.lineCap = 'round'
  x.stroke()
  // The newest sample, marked rather than lit: a dot the same weight as the
  // line it ends, not a bloom sitting on top of it.
  const lx = px(values.length - 1), ly = py(values[values.length - 1])
  x.beginPath(); x.arc(lx, ly, d * 1.3, 0, Math.PI * 2)
  x.fillStyle = color; x.fill()
}

// ================================================================= sessions
const cardsEl = $('cards')
const wiresEl = $('wires')
const dragEl = $('dragwire')
const dctx = dragEl.getContext('2d')

/** A card's parts, built once. Everything after this is mutation.
 *
 *  Cards are keyed by session id and REUSED across renders. They used to be
 *  destroyed and rebuilt on every pass -- `cardsEl.textContent = ''` -- and
 *  this runs about once a second off the sessions stream, again on every
 *  snapshot, and again on a four-second interval. A replacement node is not
 *  the node the pointer is over, so `:hover` dropped and re-applied about
 *  once a second: a flicker no CSS can reach. It also pulled the drag source,
 *  which is holding the pointer capture, out from under a live gesture. */
const buildCard = (id) => {
  const card = el('div', 'card')
  card.dataset.id = id
  const r1 = el('div', 'row1')
  r1.appendChild(el('span', 'name'))
  r1.appendChild(el('span', 'badge'))
  // Built once and hidden by CSS, never added and removed: a card is reused
  // across renders and rebuilding parts of it drops :hover and live gestures.
  r1.appendChild(el('span', 'needflag', '\u25cf needs you'))
  // The quiet counterpart, same rule: built once, shown by CSS. A hollow ring
  // against the filled dot above it, and no word beside it -- "stopped" is the
  // absence of news, and the badge already reads `idle \u00b7 12m`.
  r1.appendChild(el('span', 'stopflag', '\u25cb'))
  card.appendChild(r1)
  card.appendChild(el('div', 'meta'))
  const bar = el('div', 'bar'); bar.appendChild(el('i')); card.appendChild(bar)
  card.appendChild(el('div', 'stats'))
  const spark = el('canvas', 'spark'); spark.height = 52
  card.appendChild(spark)
  // The presence dot: this session's colour in the orb, in the corner of its
  // card, so a band in the sphere can be matched to a card at a glance. Built
  // once; only its data-state changes. The COLOUR lives entirely in CSS,
  // keyed off that attribute, so the card and the orb read the same four theme
  // tokens and cannot drift apart by one of them being edited alone.
  //
  // Bottom-left: `.grip` holds bottom-right, and the card's clip-path bevels
  // the top-right and bottom-left corners by 9px -- so it is inset past the
  // bevel rather than sat in the notch it would be half-eaten by.
  card.appendChild(el('span', 'statedot'))
  // Subagents, on the face of the card. Display only: `agents` has ridden on
  // every stats push since the band was built, and the drawer's Subagents
  // section already renders the same array -- this is the count of it, so the
  // card answers "is this session running a swarm?" without being opened.
  // Beside the state dot rather than up in row 1, which already carries the
  // name, the badge and both status flags and is tight at 232px.
  card.appendChild(el('span', 'agentchip'))
  card.appendChild(el('div', 'grip', '⠿ drag to link'))
  wireCardEvents(card)
  return card
}

const setText = (node, text) => { if (node.textContent !== text) node.textContent = text }

/** Write a session into an existing card. Only what actually changed is
 *  touched: the two lists that vary in length carry a key of their own
 *  contents, so a card whose numbers are unchanged is left completely alone. */
// STALL_MS is how long a session's numbers may sit still before the board says
// so. `working` only means a turn is OPEN, not that it is moving: a session
// parked at a permission prompt heartbeats working:true forever and would
// otherwise read "live" indefinitely -- the one case an idle indicator most
// needs to surface.
//
// It says "no progress", not "blocked". ctx and outTok come from the
// transcript, written per content block, so a long single-block generation
// looks identical from here. The honest report is the one the user can act on
// either way.
const STALL_MS = 30_000
const badgeOf = (s) => {
  if (!s.working) return 'idle \u00b7 ' + ago(s.idleSince ?? s.seenAt)
  const at = s.progressAt
  if (at && Date.now() - at > STALL_MS) return '\u25cf live \u00b7 no progress ' + ago(at)
  return '\u25cf live'
}

// The same working-but-stalled distinction badgeOf reads for the "no
// progress" label, reused as the presence swarm's activity floor (see
// frame() below). It cannot actually tell "thinking, no tool calls yet"
// apart from "parked at a permission prompt" -- relay.mjs's progressAt
// comment says as much, on purpose: ctx/tools/spend don't move for either
// case. That is fine here: a real generation resolves in seconds, well
// inside STALL_MS, so the floor holds through it and lets go once a stall
// has run long enough to look like a human being waited on rather than a
// turn still in flight.
/** What this session is waiting on you for, or ''.
 *
 *  Two independent sources, and the parked-at-a-prompt one wins: Claude Code
 *  OBSERVES that (`claude agents --json` reports status 'waiting'), while
 *  `needs` is the plugin's heuristic read of what the last finished turn asked
 *  for. An observation outranks an inference, and it is the more urgent case.
 *
 *  Both are payload fields, which is the silently-failing kind: against a relay
 *  that predates them this reads '' and the card simply never lights, which
 *  looks exactly like the feature not working: the pane's static assets
 *  reload on their own, but the relay behind them does not. */
const needsOf = (s) => (s && s.waiting ? (s.waitingFor || 'waiting for input') : ((s && s.needs) || ''))

/** How long a session must sit still before the board calls it stopped. */
const STOPPED_MS = 90_000

/** Has this session simply stopped? Distinct from needsOf, and beneath it.
 *
 *  Three conditions, and the middle one is the whole point: a session that is
 *  waiting on you is ALREADY reported, in amber, and saying "stopped"
 *  over the top of that would replace an urgent signal with a calm one. So
 *  needs-me is checked first and wins outright; this only ever describes a
 *  session nothing else has anything to say about.
 *
 *  90 s, not the first idle second, because `badgeOf` already prints
 *  `idle · 3s` from the moment a turn ends and the gap between two turns of one
 *  ongoing piece of work is idle by that measure. The mark is for settled
 *  stillness -- the session that finished a while ago and is waiting for
 *  somebody to notice -- which is the thing the board could not say before.
 *
 *  `idleSince` and never `seenAt`: seenAt is the heartbeat and moves about once
 *  a second for a session nobody has touched in an hour. A relay predating
 *  `idleSince` sends neither, and the mark simply never appears, which is the
 *  silent-failure mode every payload field shares. */
const stoppedOf = (s, now = Date.now()) => {
  if (!s || s.working) return 0
  if (needsOf(s)) return 0
  const since = s.idleSince
  if (!since || now - since < STOPPED_MS) return 0
  return since
}

/** How many of this session's last fourteen events were errors.
 *
 *  The board's own `stuck` rule (see recomputeMood) scoped to one session --
 *  deliberately the same rule and the same window, so a red dot and a red board
 *  can never disagree about what an error IS, only about what it covers. */
const recentErrorsOf = (id) =>
  S.events.filter((e) => e.sessionId === id).slice(-14).filter((e) => e.status === 'error').length

/** Which of the presence orb's four states a session is in.
 *
 *  The card dot and the orb's band have to agree, so the precedence is the
 *  orb's, not a fresh one: **waiting > error > working > idle**.
 *  Waiting outranks error
 *  because a session that has stopped and asked is actionable now while its
 *  errors are history; error outranks working because a session erroring its
 *  way through a turn is the thing worth seeing.
 *
 *  Note idle is simply "none of the other three", NOT `stoppedOf`. The orb has
 *  four states and no notion of settled stillness, so keying this to the 90 s
 *  rule would make the dot and the band disagree for the first 90 seconds after
 *  every turn -- the exact drift this shares a source to avoid. `stoppedOf`
 *  still drives the hollow ring, which answers a different question.
 *
 *  `swarm-math.js` carries `sessionState`, the same precedence tested there.
 *  This is a second copy rather than a call to it because app.js is a classic
 *  script with no bundler and that module is an ES module. */
const sessionStateOf = (s) => {
  if (!s) return 'idle'
  if (needsOf(s)) return 'waiting'
  if (recentErrorsOf(s.id) >= 3) return 'error'
  if (s.working) return 'working'
  return 'idle'
}

const genuinelyWorking = (s) => !!(s && s.working && !(s.progressAt && Date.now() - s.progressAt > STALL_MS))

const fillCard = (card, s) => {
  const st = s.stats || {}
  card.classList.toggle('working', !!s.working)
  card.classList.toggle('self', s.id === S.focus)
  const needs = needsOf(s)
  card.classList.toggle('needs', !!needs)
  // Stopped is the quiet case and never competes: needsOf already ruled it out
  // above, so at most one of these two classes is ever on a card.
  const stopped = stoppedOf(s)
  card.classList.toggle('stopped', !!stopped)
  // Live, interactive, and outside tmux: there is no promptless way to raise
  // its window on macOS (jump.mjs's header). Marked on the card so the state
  // is visible BEFORE the click rather than as a toast after it -- the whole
  // point, since the answer is "nothing can be done from here".
  card.classList.toggle('nojump', s.jump === 'outside')
  // The hover text is what the session is asking for, so the board answers
  // what it wants without opening anything. A stopped card borrows the same slot, since it
  // has nothing else to say there.
  const tip = needs || (stopped ? 'stopped ' + ago(stopped) + ' ago' : '')
  if (card.title !== tip) card.title = tip

  // An attribute, never a class: MCX.toggle would need one call per state and
  // four classes that can disagree with each other, and assigning className
  // outright would wipe the card's own state classes. One attribute has
  // exactly one value by construction.
  const dot = card.querySelector('.statedot')
  const state = sessionStateOf(s)
  MCX.setAttr(dot, 'data-state', state)
  MCX.setAttr(dot, 'title', 'presence: ' + state)

  // `$.agent.list()` returns the session's agents with their statuses, and the
  // plugin replaces the array wholesale each refresh -- so the COUNT is every
  // subagent this session has, finished ones included, exactly as the drawer's
  // Subagents list shows them. Lit while any is still running, dim once they
  // have all stopped, gone when there were never any. Hidden with MCX.show
  // rather than added and removed: the card is reconciled, not rebuilt.
  const chip = card.querySelector('.agentchip')
  const agents = s.agents || []
  const running = agents.filter((a) => a.status === 'running').length
  MCX.show(chip, agents.length > 0)
  if (agents.length) {
    MCX.setText(chip, agents.length + (agents.length === 1 ? ' agent' : ' agents'))
    MCX.setAttr(chip, 'data-live', running ? '1' : '0')
    MCX.setAttr(chip, 'title', running
      ? `${running} of ${agents.length} subagent${agents.length === 1 ? '' : 's'} running`
      : `${agents.length} subagent${agents.length === 1 ? '' : 's'}, none running`)
  }
  setText(card.querySelector('.name'), s.name || s.repo || s.cwd?.split('/').pop() || s.id.slice(0, 8))
  // `idleSince` is when this session stopped working; seenAt is only when the
  // relay last heard from it, which a heartbeat refreshes about once a second.
  // Falling back to seenAt keeps an older relay working, badly, rather than
  // rendering NaN.
  setText(card.querySelector('.badge'), badgeOf(s))

  const meta = card.querySelector('.meta')
  const bits = [s.model || 'model ?']
  if (s.branch) bits.push('⎇ ' + s.branch)
  const mk = bits.join('\u0000')
  if (meta.dataset.k !== mk) {
    meta.dataset.k = mk; meta.textContent = ''
    for (const b of bits) meta.appendChild(el('span', null, b))
  }

  const pct = Math.min(1, (st.ctx || 0) / (st.ctxLimit || 200000))
  const fill = card.querySelector('.bar i')
  const width = (pct * 100).toFixed(1) + '%'
  if (fill.style.width !== width) fill.style.width = width

  const rows = [[Math.round(pct * 100) + '%', 'ctx'], [money(st.spend), ''], [String(st.tools || 0), 'tools']]
  if (st.guardrails) rows.push([String(st.guardrails), 'blocked'])
  const stats = card.querySelector('.stats')
  const sk = rows.map((r) => r.join(' ')).join('\u0000')
  if (stats.dataset.k !== sk) {
    stats.dataset.k = sk; stats.textContent = ''
    for (const [v, label] of rows) {
      const n = el('span')
      n.appendChild(el('b', null, v))
      if (label) n.appendChild(document.createTextNode('\u00a0' + label))
      stats.appendChild(n)
    }
  }

  const spark = card.querySelector('.spark')
  requestAnimationFrame(() => sparkline(spark, (s.series || []).map((p) => p.tokens || 0).slice(-40), T.accent, true))

  // This session's own outline colour, picked in the drawer (cards.mjs).
  // Drawn by a `::after` ring in CSS (app.css .card.colored::after), not an
  // `outline` or an outer box-shadow -- the card's clip-path chamfer clips
  // both of those, so it has to be its own inset-shadowed box to survive the
  // clip and sit OUTSIDE .needs/.stopped without fighting their box-shadow.
  // The `.colored` class is the actual gate; the custom property is set
  // either way so a stale value left on the node can never leak through once
  // the class is off.
  const color = s.color || ''
  card.classList.toggle('colored', !!color)
  if (color) card.style.setProperty('--card-color', color)
  else card.style.removeProperty('--card-color')
}

/** The board is grouped by tmux session when anybody is in one. `key` is what
 *  the group is reconciled by; `t:` prefixes a real name so it can never
 *  collide with the bucket for sessions that are not in tmux. */
const TMUX_NONE = 'none'
const groupKey = (s) => (s.tmux ? 't:' + s.tmux : TMUX_NONE)

/** Sessions in board order, split into tmux groups -- or `null` when NOT ONE
 *  session reports a tmux session. That null is the point: the board then
 *  renders exactly as it did before this existed, with no headings at all, so
 *  the feature is invisible to anybody not using tmux. Sessions with no tmux
 *  name are never hidden; they collect in one bucket, always last. */
const tmuxGroups = () => {
  if (!S.sessions.some((s) => s.tmux)) return null
  const order = [], by = new Map()
  for (const s of S.sessions) {
    const k = groupKey(s)
    if (!by.has(k)) { by.set(k, []); order.push(k) }
    by.get(k).push(s)
  }
  // Stable sort, so everything but the ungrouped bucket keeps the order it
  // first appeared in and the bucket falls to the end.
  order.sort((a, b) => (a === TMUX_NONE ? 1 : 0) - (b === TMUX_NONE ? 1 : 0))
  return order.map((k) => ({
    key: k,
    label: k === TMUX_NONE ? 'not in tmux' : k.slice(2),
    sessions: by.get(k),
  }))
}

const buildGroup = (key) => {
  const box = el('div', 'cardgroup')
  box.dataset.key = key
  const head = el('div', 'grouphead')
  head.appendChild(el('span', 'gname'))
  head.appendChild(el('span', 'gcount'))
  box.appendChild(head)
  box.appendChild(el('div', 'groupcards'))
  return box
}

const renderCards = () => {
  // Not while a gesture is live. The drag source holds the pointer capture;
  // reconciling around it would still touch its classes and its position in
  // the list. Whatever arrives during the drag is picked up when it ends.
  if (S.drag) return

  // Every card ANYWHERE under the board, not just the direct children: with
  // grouping a card sits inside a .groupcards row, and it has to be found and
  // reused wherever it currently is. Rebuilding cards is what used to flicker
  // the :hover off them about once a second.
  const prev = new Map()
  for (const n of cardsEl.querySelectorAll('.card')) if (n.dataset.id) prev.set(n.dataset.id, n)

  if (!S.sessions.length) {
    if (!cardsEl.querySelector('.empty')) {
      cardsEl.textContent = ''
      const e = el('div', 'empty', 'No sessions have reported in. Start a Claude Code session with the plugin loaded.')
      e.style.width = '100%'
      cardsEl.appendChild(e)
    }
    layoutWires(); return
  }
  cardsEl.querySelector('.empty')?.remove()

  const groups = tmuxGroups()
  cardsEl.classList.toggle('grouped', !!groups)

  // Clear the top level of anything that does not belong in the layout about
  // to be built, BEFORE placing anything, so the index arithmetic below counts
  // only the nodes it is placing. Detaching a node does not destroy it: every
  // card is held in `prev` and is re-placed rather than rebuilt.
  for (const n of [...cardsEl.children]) {
    if (!n.classList.contains(groups ? 'cardgroup' : 'card')) n.remove()
  }

  const live = new Set()
  let seq = 0
  const place = (parent, s, at) => {
    let card = prev.get(s.id)
    if (!card) { card = buildCard(s.id); card.style.animationDelay = (seq * 55) + 'ms' }
    fillCard(card, s)
    live.add(s.id)
    seq++
    // Move it into place only if it is not already there; an untouched node
    // keeps its :hover, its capture and its scroll position.
    if (parent.children[at] !== card) parent.insertBefore(card, parent.children[at] || null)
  }

  if (!groups) {
    S.sessions.forEach((s, at) => place(cardsEl, s, at))
  } else {
    const boxes = new Map()
    for (const n of cardsEl.children) boxes.set(n.dataset.key, n)
    const kept = new Set()
    groups.forEach((g, gi) => {
      const box = boxes.get(g.key) ?? buildGroup(g.key)
      setText(box.querySelector('.gname'), g.label)
      setText(box.querySelector('.gcount'), String(g.sessions.length))
      if (cardsEl.children[gi] !== box) cardsEl.insertBefore(box, cardsEl.children[gi] || null)
      const row = box.querySelector('.groupcards')
      g.sessions.forEach((s, at) => place(row, s, at))
      kept.add(g.key)
    })
    // Emptied groups go last, once their live cards have been moved out.
    for (const n of [...cardsEl.children]) if (!kept.has(n.dataset.key)) n.remove()
  }

  for (const [id, node] of prev) if (!live.has(id)) node.remove()
  // A card node can be rebuilt under an armed command; the marks live in S, so
  // repaint them rather than lose them.
  if (S.armed) syncArmed()
  layoutWires()
}

const wireCardEvents = (card) => {
  let moved = false
  /* Hovering a card swaps the rail's metric rows to that session, and leaving
     puts them back on the whole board. Guarded on S.drag: while a wire is
     being pulled the pointer crosses every card between the two ends, and the
     rail flickering through each of them in turn is noise. */
  card.addEventListener('pointerenter', () => {
    if (S.drag || S.peek === card.dataset.id) return
    S.peek = card.dataset.id
    rescope()
  })
  card.addEventListener('pointerleave', () => {
    if (S.peek !== card.dataset.id) return
    S.peek = null
    rescope()
  })
  // The id is read from the node, not closed over: the node outlives any one
  // render now, and dataset.id is what keys it.
  card.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return
    // Cancel the native selection gesture this press would otherwise start;
    // the pointer capture below is the only thing that should own it.
    ev.preventDefault()
    moved = false
    S.drag = { from: card.dataset.id, x: ev.clientX, y: ev.clientY }
    card.classList.add('dragsrc')
    card.setPointerCapture(ev.pointerId)
    layoutDrag()
  })
  card.addEventListener('pointermove', (ev) => {
    if (!S.drag || S.drag.from !== card.dataset.id) return
    moved = true
    S.drag.x = ev.clientX; S.drag.y = ev.clientY
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.card')
    for (const n of document.querySelectorAll('.card.droptgt')) n.classList.remove('droptgt')
    if (over && over.dataset.id !== card.dataset.id) over.classList.add('droptgt')
    // Only the overlay: the cards have not moved, so the settled wires under
    // them have nothing to recompute.
    layoutDrag()
  })
  card.addEventListener('pointerup', async (ev) => {
    if (!S.drag || S.drag.from !== card.dataset.id) return
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.card')
    const from = S.drag.from
    S.drag = null
    card.classList.remove('dragsrc')
    for (const n of document.querySelectorAll('.card.droptgt')) n.classList.remove('droptgt')
    layoutDrag()         // S.drag is null now, so this clears the overlay
    renderCards()        // catch up on everything the drag held off
    if (!moved || !target || target.dataset.id === from) {
      // A click on a card means "send this here" while a command is armed, and
      // "show me this session" the rest of the time.
      if (!moved) { if (S.armed) armedClick(from, ev.altKey); else openDrawer(from) }
      return
    }
    // Landing the drag does NOT send. The brief the target receives is one
    // message and the note goes inside it, so this is the only chance to write
    // it: the connection is pending until the dialog is answered.
    openLinkDialog(from, target.dataset.id)
  })
  card.addEventListener('pointercancel', () => {
    S.drag = null; card.classList.remove('dragsrc')
    for (const n of document.querySelectorAll('.card.droptgt')) n.classList.remove('droptgt')
    layoutDrag(); renderCards()
  })
}

// --------------------------------------------------------------- link dialog
/** A landed drag parks here as a PENDING connection while the note that rides
 *  with it is written. `/api/link` has always taken a `note`, relay.mjs passes
 *  it into the send-message payload and sendBrief() interpolates it under a
 *  `Note:` heading — the board simply never filled it in and dropped every
 *  message on the floor. `null` when no dialog is open. */
let pendingLink = null

const linkModal = $('linkmodal')
const linkNote = $('lm-note')

const openLinkDialog = (from, to) => {
  // Where focus was, so cancelling puts it back rather than dumping the user
  // at the top of the document.
  pendingLink = { from, to, restore: document.activeElement }
  setText($('lm-from'), nameOf(from))
  setText($('lm-to'), nameOf(to))
  linkNote.value = ''
  linkModal.hidden = false
  // Focus lands in the textarea, not on a button: writing the note is the
  // whole reason this opened. After a frame, so the box is laid out first.
  requestAnimationFrame(() => linkNote.focus())
}

const closeLinkDialog = () => {
  if (!pendingLink) return
  const back = pendingLink.restore
  pendingLink = null
  linkModal.hidden = true
  if (back?.isConnected && typeof back.focus === 'function') back.focus()
}

const sendPendingLink = async () => {
  if (!pendingLink) return
  const { from, to } = pendingLink
  const note = linkNote.value.trim()
  // Closed before the round trip: the decision is made, and leaving the panel
  // up over a request that may take a moment reads as if it had not been.
  closeLinkDialog()
  const r = await post('/api/link', { from, to, kind: 'brief', note })
  toast(r.error ? 'brief failed: ' + r.error : `brief sent to ${nameOf(to)}`)
}

$('lm-cancel').addEventListener('click', closeLinkDialog)
$('lm-send').addEventListener('click', () => { void sendPendingLink() })
// A press that lands on the backdrop itself — not on the panel inside it — is a
// click outside, and cancels. mousedown rather than click, so a drag that
// starts in the textarea and ends outside does not dismiss it.
linkModal.addEventListener('mousedown', (ev) => { if (ev.target === linkModal) closeLinkDialog() })
linkNote.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); void sendPendingLink() }
})

const SVGNS = 'http://www.w3.org/2000/svg'

/** A card's centre in the stage's CONTENT coordinates: its offset within the
 *  visible box plus however far the box is scrolled. #wires scrolls with the
 *  content, so this is the space it draws in. */
const centerOf = (id, stage, sx, sy) => {
  const n = cardsEl.querySelector(`.card[data-id="${CSS.escape(id)}"]`)
  if (!n) return null
  const b = n.getBoundingClientRect()
  return { x: b.left - stage.left + sx + b.width / 2, y: b.top - stage.top + sy + b.height / 2 }
}

/** The same point in viewport coordinates, for the overlay. */
const centerInView = (id) => {
  const n = cardsEl.querySelector(`.card[data-id="${CSS.escape(id)}"]`)
  if (!n) return null
  const b = n.getBoundingClientRect()
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
}

/* -------------------------------------------------------------- the route
 *
 *  Both the settled links and the in-flight drag are drawn on the SAME
 *  geometry: a routed trace, the way a signal is routed on a board -- straight
 *  runs with 45-degree chamfers, never a curve, never a sag. It replaced a
 *  simulated rope (26 point masses, gravity, damping, overshoot) on
 *  the physics read as rubbery and the thick glow around it read
 *  as cheap, and neither is what the rest of this deck looks like. Hard
 *  angles, thin lines, and motion that is a signal travelling rather than a
 *  cable swinging.
 */
const STUB = 20        // the straight run a trace leaves and enters a node on

/** a -> b as a polyline: stub out, chamfer, stub in. Horizontal-dominant gets
 *  run / diagonal / run; vertical-dominant gets a chamfered Z. The diagonal is
 *  always exactly 45 degrees, which is the whole look -- the chamfer consumes
 *  as much horizontal as it does vertical, and the straight runs take up
 *  whatever is left over. */
const routeTrace = (a, b) => {
  const out = b.x >= a.x ? 1 : -1
  const p1 = { x: a.x + STUB * out, y: a.y }
  const p3 = { x: b.x - STUB * out, y: b.y }
  const dx = p3.x - p1.x, dy = p3.y - p1.y
  const run = Math.abs(dx), rise = Math.abs(dy)
  // Sign of the MIDDLE section, which is not always the sign of the stubs: two
  // cards less than 2*STUB apart horizontally route back on themselves, and
  // taking `out` here would draw the chamfer the wrong way.
  const sx = Math.sign(dx) || out, sy = Math.sign(dy) || 1
  const mid = []
  if (run >= rise) {
    const flat = (run - rise) / 2
    mid.push({ x: p1.x + sx * flat, y: p1.y })
    mid.push({ x: p1.x + sx * (flat + rise), y: p3.y })
  } else {
    const half = run / 2
    mid.push({ x: p1.x + sx * half, y: p1.y + sy * half })
    mid.push({ x: p1.x + sx * half, y: p3.y - sy * half })
  }
  // Snapped to the half-pixel grid. A 1px stroke centred on a whole pixel
  // straddles two rows, and the renderer resolves that as a bright middle with
  // a dimmer band either side -- which reads as a line with a border around
  // it, not as a thinner line. Most of this route is axis-aligned, so snapping
  // gets nearly all of it crisp; the 45 degree chamfers antialias regardless,
  // and should.
  return [a, p1, ...mid, p3, b].map((q) => ({ x: Math.round(q.x) + 0.5, y: Math.round(q.y) + 0.5 }))
}

const pathOf = (pts) => pts.map((q, i) => (i ? 'L' : 'M') + ' ' + q.x.toFixed(1) + ' ' + q.y.toFixed(1)).join(' ')

const wireDefs = (svg, gid) => {
  const defs = document.createElementNS(SVGNS, 'defs')
  defs.innerHTML = `<linearGradient id="${gid}" x1="0" x2="1">
      <stop offset="0" stop-color="${T.accentDeep}"/><stop offset="1" stop-color="${T.accentHot}"/></linearGradient>`
  svg.appendChild(defs)
}

/** One SETTLED link, in whatever coordinate space `svg` is set up for. `gid`
 *  names the base gradient in that same SVG's defs. Two strokes: a dim
 *  continuous trace that says the route exists, and a soft brightness that
 *  slides along it, source to target, saying it is carrying something. A
 *  marching dash did that job until and read as marching ants.
 *  These stay SVG -- they already track their cards through scroll; only the
 *  in-flight drag is drawn per frame. */
let pulseSeq = 0
const traceWire = (svg, a, b, gid) => {
  const d = pathOf(routeTrace(a, b))
  const base = document.createElementNS(SVGNS, 'path')
  base.setAttribute('d', d)
  base.setAttribute('fill', 'none')
  base.setAttribute('stroke', `url(#${gid})`)
  base.setAttribute('stroke-width', '1')
  base.setAttribute('stroke-linejoin', 'miter')
  base.setAttribute('opacity', '0.38')
  svg.appendChild(base)

  // A three-stop gradient whose stops all slide together: transparent, bright,
  // transparent. Offsets clamp at 0 and 1, so the pulse rises out of the
  // source terminal and fades into the target rather than popping at both.
  const pid = `${gid}-p${pulseSeq++}`
  const band = 0.16, dur = '1.9s'
  const stop = (off, color, opacity) =>
    `<stop offset="${Math.max(0, Math.min(1, off))}" stop-color="${color}" stop-opacity="${opacity}">
       <animate attributeName="offset" values="${[off, off + 1].map((v) => Math.max(0, Math.min(1, v))).join(';')}"
                dur="${dur}" repeatCount="indefinite"/></stop>`
  const g = document.createElementNS(SVGNS, 'linearGradient')
  g.id = pid
  g.setAttribute('gradientUnits', 'objectBoundingBox')
  g.setAttribute('x1', '0'); g.setAttribute('x2', '1')
  g.innerHTML = stop(-band, T.accentHot, '0') + stop(0, T.accentHot, '1') + stop(band, T.accentHot, '0')
  svg.querySelector('defs').appendChild(g)

  const run = document.createElementNS(SVGNS, 'path')
  run.setAttribute('d', d)
  run.setAttribute('fill', 'none')
  run.setAttribute('stroke', `url(#${pid})`)
  // Exactly the base's width. Wider, the dim base showed either side of the
  // bright pulse and read as an outline on it.
  run.setAttribute('stroke-width', '1')
  run.setAttribute('stroke-linejoin', 'miter')
  svg.appendChild(run)

  // A square node at each end: this is a trace between two terminals, and the
  // terminals should look like terminals.
  for (const q of [a, b]) {
    const n = document.createElementNS(SVGNS, 'rect')
    n.setAttribute('x', String(q.x - 2.5)); n.setAttribute('y', String(q.y - 2.5))
    n.setAttribute('width', '5'); n.setAttribute('height', '5')
    n.setAttribute('fill', 'none')
    n.setAttribute('stroke', T.accent)
    n.setAttribute('stroke-width', '1')
    n.setAttribute('opacity', '0.8')
    svg.appendChild(n)
  }
}

/* ------------------------------------------------------- the drag wire
 *
 *  The same routed trace, painted to a canvas every frame because both ends
 *  move. No physics: the route is a pure function of the two endpoints, so
 *  the line is exactly as steady as the pointer is. What moves is the signal
 *  on it -- a marching dash at a constant rate, which is the same idiom the
 *  settled links use.
 *
 *  Canvas colours must be literals -- ctx takes no CSS custom properties -- so
 *  these mirror app.css's :root tokens exactly, the same way swarm.js's own
 *  themedMood() does for the swarm's mood colour. Keep them in step with the
 *  tokens named beside each one.
 */
/** Overwritten by refreshTheme(); these are the teal defaults it starts from. */
const WIRE = {
  src:   '#2f7f9b',            // --accent-deep : the terminal it came out of
  mid:   '#6fc3df',            // --accent      : the run
  head:  '#a9e8ff',            // --accent-hot  : the end under the pointer
  pulse: '#a9e8ff',            // --accent-hot  : the signal on the run
}

/* The signal on the wire is a soft brightness sliding source-to-head, not a
   dash pattern: marching ants read as a selection marquee, and stacking a
   white dash additively over the cyan run washed it out warm. The pulse stays
   strictly inside the teal family and is drawn with normal compositing so it
   cannot clip to white. */
const PULSE_BAND = 0.17   // half-width of the bright band, as a fraction of
                          // the run -- wide enough to read as a glow moving,
                          // narrow enough not to light the whole wire.
const PULSE_MS = 1500     // one traversal, constant. A signal does not travel
                          // faster because you moved the plug.

let dragRAF = 0
let dragPrevT = 0
let pulseT = 0

/** Backing store in device pixels, CSS box in CSS pixels, transform between
 *  them. A canvas ignores CSS for its buffer: without this it stays 300x150
 *  and every client coordinate lands outside it. */
const sizeDragCanvas = () => {
  const d = Math.min(2, window.devicePixelRatio || 1)
  const w = Math.round(innerWidth * d), h = Math.round(innerHeight * d)
  if (dragEl.width !== w) dragEl.width = w
  if (dragEl.height !== h) dragEl.height = h
  if (dragEl.style.width !== innerWidth + 'px') dragEl.style.width = innerWidth + 'px'
  if (dragEl.style.height !== innerHeight + 'px') dragEl.style.height = innerHeight + 'px'
  dctx.setTransform(d, 0, 0, d, 0, 0)
}

const tracePath = (ctx, pts) => {
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
}

/** A reticle, not a plug: four corner ticks around the pointer. It does not
 *  spin -- a rotating element here was the other half of what read as cheap. */
const drawHead = (ctx, x, y, r) => {
  const t = r * 0.45
  ctx.beginPath()
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    ctx.moveTo(x + sx * r, y + sy * r); ctx.lineTo(x + sx * (r - t), y + sy * r)
    ctx.moveTo(x + sx * r, y + sy * r); ctx.lineTo(x + sx * r, y + sy * (r - t))
  }
  ctx.stroke()
}

const drawDrag = (t) => {
  dragRAF = S.drag ? requestAnimationFrame(drawDrag) : 0
  sizeDragCanvas()
  dctx.clearRect(0, 0, innerWidth, innerHeight)
  if (!S.drag) return

  // The source rect is re-read every frame, which is what keeps the tail
  // attached if the board scrolls mid-drag. A card that has gone away leaves
  // the overlay blank rather than the trace anchored at a stale point.
  const a = centerInView(S.drag.from)
  if (!a) return
  const b = { x: S.drag.x, y: S.drag.y }

  const dt = dragPrevT ? Math.min(64, t - dragPrevT) : 16.7
  dragPrevT = t
  pulseT = (pulseT + dt / PULSE_MS) % 1

  const pts = routeTrace(a, b)
  const grad = dctx.createLinearGradient(a.x, a.y, b.x, b.y)
  grad.addColorStop(0, WIRE.src)
  grad.addColorStop(0.55, WIRE.mid)
  grad.addColorStop(1, WIRE.head)

  // The travelling brightness. Three stops around `pulseT`, clamped into
  // [0,1] so the band rises out of the terminal and fades into the head.
  const clamp01 = (v) => Math.max(0, Math.min(1, v))
  const pg = dctx.createLinearGradient(a.x, a.y, b.x, b.y)
  const lo = clamp01(pulseT - PULSE_BAND), hi = clamp01(pulseT + PULSE_BAND)
  const clear = WIRE.pulse + '00'
  pg.addColorStop(0, clear)
  pg.addColorStop(lo, clear)
  pg.addColorStop(clamp01(pulseT), WIRE.pulse)
  pg.addColorStop(hi, clear)
  pg.addColorStop(1, clear)

  dctx.save()
  dctx.lineCap = 'butt'; dctx.lineJoin = 'miter'; dctx.miterLimit = 4
  tracePath(dctx, pts)

  /* One hairline, and nothing concentric with it. Two earlier passes both read
     as a border rather than as glow: a 3.5px dark casing under the line, and
     then a constant 5px bloom around it. A steady halo the whole length of a
     1px line is indistinguishable from an outline -- so the only soft light
     here now is on the travelling pulse, where it moves, and the run itself is
     a single stroke at a single width. */
  dctx.globalCompositeOperation = 'source-over'
  dctx.strokeStyle = grad
  dctx.globalAlpha = 0.8; dctx.lineWidth = 1; dctx.stroke()

  // The pulse: the same 1px width, so it brightens the run rather than
  // widening it, plus its own glow which travels with it.
  dctx.strokeStyle = pg
  dctx.globalAlpha = 1; dctx.lineWidth = 1; dctx.stroke()
  dctx.globalCompositeOperation = 'lighter'
  dctx.globalAlpha = 0.22; dctx.lineWidth = 4; dctx.stroke()
  dctx.globalCompositeOperation = 'source-over'

  // The terminal it came out of, and the reticle hunting for the next one.
  dctx.globalAlpha = 0.85; dctx.lineWidth = 1
  dctx.strokeStyle = WIRE.src
  dctx.strokeRect(Math.round(a.x) - 2.5, Math.round(a.y) - 2.5, 5, 5)
  dctx.strokeStyle = WIRE.head
  drawHead(dctx, Math.round(b.x) + 0.5, Math.round(b.y) + 0.5, 7)
  dctx.fillStyle = WIRE.head
  dctx.fillRect(Math.round(b.x) - 1, Math.round(b.y) - 1, 2, 2)
  dctx.restore()
}

/** The overlay's on/off switch, and the only thing the gesture handlers call.
 *  The loop runs ONLY while a drag is in flight: a canvas repainting forever
 *  in a background tab is a real cost, and there is nothing to animate when
 *  the wire is not being drawn. */
const layoutDrag = () => {
  if (S.drag) {
    if (!dragRAF) { dragPrevT = 0; dragRAF = requestAnimationFrame(drawDrag) }
    return
  }
  if (dragRAF) { cancelAnimationFrame(dragRAF); dragRAF = 0 }
  pulseT = 0
  sizeDragCanvas()
  dctx.clearRect(0, 0, innerWidth, innerHeight)
}

/** The settled links, inside the stage and in its content coordinates, so they
 *  move, scroll and clip with the cards they connect. */
const layoutWires = () => {
  const stageEl = document.querySelector('.boardstage')
  if (!stageEl) return
  const stage = stageEl.getBoundingClientRect()
  // #wires is absolutely positioned inside .boardstage, so it scrolls with the
  // content. It is therefore sized to the content and drawn in content
  // coordinates. Sized to the visible box and measured against the unscrolled
  // rect -- as it was -- every wire slid by exactly the scroll distance the
  // moment the board scrolled, and any card scrolled out of the first
  // screenful had no overlay over it at all.
  const sx = stageEl.scrollLeft, sy = stageEl.scrollTop
  const w = Math.max(stage.width, stageEl.scrollWidth)
  const h = Math.max(stage.height, stageEl.scrollHeight)
  wiresEl.setAttribute('width', w); wiresEl.setAttribute('height', h)
  wiresEl.setAttribute('viewBox', `0 0 ${w} ${h}`)
  wiresEl.textContent = ''
  wireDefs(wiresEl, 'wg')
  for (const l of S.links) {
    const a = centerOf(l.from, stage, sx, sy), b = centerOf(l.to, stage, sx, sy)
    if (a && b) traceWire(wiresEl, a, b, 'wg')
  }
  layoutDrag()
}

// ================================================================== metrics
/* The rail is an OVERVIEW: by default every row here covers the whole board,
   not the focused session, because "one session's context" is not a fact about
   a board with five sessions on it. Hovering a card on the switchboard beside
   it swaps the rows to that session, and #m-scope says which of the two you
   are reading. `S.peek` is that hover, and nothing else writes it.

   Spend belongs on the Telemetry tab, and blast radius is per-turn and
   per-session by nature with no honest aggregate, so neither is a row here. */

/** Claude Code's own default. Sessions report their real `ctxLimit` and that
 *  is always preferred; this only stands in for a session that has not said.
 *  It was 200k, which is the SMALL window -- most models run 1M, so the rail
 *  read as five times fuller than it was. */
const CTX_LIMIT_DEFAULT = 1_000_000

/** The session the rail is showing, or null for the whole board. A pinned
 *  card (its drawer is open) wins; otherwise whatever the pointer is over. */
const scoped = () => {
  const id = S.pinned || S.peek
  return id ? S.sessions.find((s) => s.id === id) : null
}
const seriesTotal = (s) => (s.series || []).reduce((a, p) => a + (p.tokens || 0), 0)

/** The two usage rows above the context row. ACCOUNT-wide, unlike everything
 *  else in this panel, so `scoped()` is
 *  irrelevant here -- there is only one board's worth of these numbers no
 *  matter which session is peeked or pinned.
 *
 * colour thresholds (65 warn / 85 crit) match the context row directly
 *  below, but are read only from a FRESH reading -- a stale one shows no
 *  colour at all, the same "no reading" treatment as an absent window,
 *  because a percentage nobody can vouch for should not be alarming either.
 * the countdown is the one thing that survives staleness, because
 *  `resetsAt` is a real boundary that stays true after the reading goes
 *  stale; `until()` recomputes it from the wall clock on every call, which is
 *  what keeps it moving between relay pushes on the 4s renderTiles() tick. */
const renderUsageRow = () => {
  const u = S.usage
  const paint = (key, label, win) => {
    const row = $(`t-usage-${key}`), val = $(`v-usage-${key}`), sub = $(`s-usage-${key}`)
    const stale = !!u?.stale
    const countdown = win ? until(win.resetsAt) : ''
    if (!win) {
      val.textContent = '—'
      sub.textContent = 'no reading'
      row.className = 'mrow'
      row.dataset.tip = `${label} usage\nNo reading yet from the account's status line side-channel.`
      return
    }
    val.textContent = stale ? '—' : Math.round(win.pct) + '%'
    sub.textContent = stale
      ? (countdown ? `stale · resets ${countdown}` : 'no reading')
      : (countdown ? `resets ${countdown}` : '—')
    row.className = 'mrow' + (!stale && win.pct >= 85 ? ' crit' : !stale && win.pct >= 65 ? ' warn' : '')
    row.dataset.tip = `${label} usage\nThe account-wide ${label.toLowerCase()} rate limit, read from your own`
      + ' status line (~/.claude/syzygy/statusline). Covers every session on this'
      + ' account, not just this board.'
      + (stale ? ' This reading is over 10 minutes old, so the percentage is hidden — the countdown keeps running because the reset boundary stays true regardless.' : '')
  }
  paint('5h', '5-hour', u?.fiveHour ?? null)
  paint('7d', '7-day', u?.sevenDay ?? null)
}

const renderTiles = () => {
  renderUsageRow()
  const one = scoped()
  const live = S.sessions
  $('m-scope').textContent = one
    ? (one.name || one.id.slice(0, 8)) + (S.pinned ? ' · pinned' : '')
    : live.length ? `all sessions · ${live.length}` : 'no sessions'
  $('m-scope').classList.toggle('peek', !!one)

  // --- context ---------------------------------------------------------
  // Summed, not averaged: the question the rail answers is how much window the
  // board is holding, and a mean would hide one session about to compact.
  const ctxUsed = one ? (one.stats?.ctx || 0) : live.reduce((a, s) => a + (s.stats?.ctx || 0), 0)
  const ctxCap = one
    ? (one.stats?.ctxLimit || CTX_LIMIT_DEFAULT)
    : live.reduce((a, s) => a + (s.stats?.ctxLimit || CTX_LIMIT_DEFAULT), 0)
  const pct = ctxCap ? Math.min(1, ctxUsed / ctxCap) : 0
  $('v-context').textContent = ctxUsed ? compact(ctxUsed) : '—'
  $('s-context').textContent = ctxCap
    ? `of ${compact(ctxCap)} · ${Math.round(pct * 100)}%`
    : 'awaiting a session'
  // Aggregate context can sit at a comfortable mean while one session is
  // already against its wall, so the warn/crit rail reads the WORST session,
  // not the sum. Peeked, it is just that session.
  const worst = one
    ? pct
    : live.reduce((m, s) => Math.max(m, (s.stats?.ctx || 0) / (s.stats?.ctxLimit || CTX_LIMIT_DEFAULT)), 0)
  $('t-context').className = 'mrow' + (worst >= 0.85 ? ' crit' : worst >= 0.65 ? ' warn' : '')

  // --- tokens ----------------------------------------------------------
  const tok = one ? seriesTotal(one) : live.reduce((a, s) => a + seriesTotal(s), 0)
  $('v-tokens').textContent = compact(tok)
  $('s-tokens').textContent = tok
    ? (one ? 'this session' : 'all sessions')
    : 'none yet'
  const tokSeries = one
    ? (one.series || []).map((p) => p.tokens || 0)
    : mergedSeries(live)
  sparkline($('sp-tok'), tokSeries.slice(-50), T.accent, true)

  // --- guardrails ------------------------------------------------------
  const guards = one
    ? (one.stats?.guardrails || 0)
    : live.reduce((a, s) => a + (s.stats?.guardrails || 0), 0)
  $('v-guard').textContent = String(guards)
  $('s-guard').textContent = guards ? 'tool calls refused' : 'nothing blocked'
  $('t-guard').className = 'mrow' + (guards ? ' warn' : '')

  drawArc(pct)
  renderCharts()
  renderUsagePanel()
}

/** The board's throughput over time: every session's series summed into one,
 *  by position from the newest sample back, since the sessions do not share a
 *  clock and the sparkline only needs a shape. */
const mergedSeries = (live) => {
  let n = 0
  for (const s of live) n = Math.max(n, (s.series || []).length)
  const out = new Array(n).fill(0)
  for (const s of live) {
    const ser = s.series || []
    for (let i = 0; i < ser.length; i++) out[n - ser.length + i] += ser[i].tokens || 0
  }
  return out
}

/** The Telemetry tab, which stays per-session: these are one run's curves and
 *  summing them across sessions would say nothing. */
const renderCharts = () => {
  const f = focused()
  const series = f?.series || []
  sparkline($('ch-tok'), series.map((p) => p.tokens || 0), T.accent, true)
  sparkline($('ch-cost'), series.map((p) => p.spend || 0), T.green, true)
  $('cap-tok').textContent = series.length ? compact(series.reduce((a, p) => a + (p.tokens || 0), 0)) + ' total' : '—'
  $('cap-cost').textContent = money(f?.stats?.spend || 0)
}

/** The telemetry tab's usage panel: both windows, their countdowns,
 *  and a sparkline off S.usageHistory -- the relay's ring of CHANGED
 * readings only, so a quiet account draws a short, sparse line rather
 *  than 120 identical samples. Account-wide like renderUsageRow, so there is
 *  no per-session `scoped()`/`focused()` split here at all. Runs from
 *  renderTiles() unconditionally, same as renderCharts() just above it --
 *  drawing into a hidden canvas on another tab is harmless (sparkline()
 *  already falls back to the canvas's own size when getBoundingClientRect()
 *  reports zero), so there is no need to gate this on which view is open. */
const renderUsagePanel = () => {
  const u = S.usage
  const paintCap = (id, win, stale) => {
    const cap = $(id)
    if (!win) { cap.textContent = 'no reading'; return }
    const countdown = until(win.resetsAt)
    cap.textContent = stale
      ? (countdown ? `stale · resets ${countdown}` : 'no reading')
      : Math.round(win.pct) + '%' + (countdown ? ` · resets ${countdown}` : '')
  }
  paintCap('cap-usage-5h', u?.fiveHour ?? null, !!u?.stale)
  paintCap('cap-usage-7d', u?.sevenDay ?? null, !!u?.stale)
  const seriesFor = (key) => S.usageHistory.map((h) => h.usage?.[key]?.pct).filter((v) => typeof v === 'number').slice(-120)
  sparkline($('ch-usage-5h'), seriesFor('fiveHour'), T.accent, true)
  sparkline($('ch-usage-7d'), seriesFor('sevenDay'), T.accent, true)
  renderUsageQueue()
}

/** The after-reset queue's list: one card per entry, a remove
 *  button on each. Removing a PENDING entry cancels it (relay.mjs's
 *  afterReset.cancel -- the store's own history, not a delete) and removing
 *  an already-settled one is a harmless no-op on the relay side, so this
 *  button never needs two different labels for the two cases. */
const renderUsageQueue = () => {
  const box = $('usage-queue'); box.textContent = ''
  const queue = S.afterReset?.queue ?? []
  $('c-usage-queue').textContent = String(queue.length)
  if (!queue.length) { box.appendChild(el('div', 'empty', 'Nothing queued.')); return }
  for (const e of queue) {
    const row = el('div', 'aritem')
    const from = el('div', 'from', `${WINDOW_LABEL[e.window] || e.window} · ${e.kind}`)
    from.appendChild(el('span', 'chip' + (e.state === 'failed' ? ' err' : e.state === 'cancelled' ? ' deny' : ''), e.state))
    row.appendChild(from)
    const detail = e.kind === 'prompt' ? (e.payload?.text || '(no prompt text)') : `ids: ${(e.payload?.ids || []).join(', ') || '(none)'}`
    row.appendChild(el('div', 'q', e.error ? `${detail} — error: ${e.error}` : detail))
    const rm = el('button', 'btn no', 'remove')
    rm.onclick = () => post('/api/after-reset/delete', { id: e.id }).then((r) => { if (r.error) toast('remove failed: ' + r.error) })
    row.appendChild(rm)
    box.appendChild(row)
  }
}

// ================================================================== heatmap
const renderHeat = () => {
  const f = focused()
  const files = Object.entries(f?.files || {}).sort((a, b) => b[1] - a[1]).slice(0, 26)
  const box = $('heat'); box.textContent = ''
  $('cap-heat').textContent = files.length ? files.length + ' files' : '—'
  if (!files.length) { box.appendChild(el('div', 'empty', 'No files touched.')); return }
  const max = Math.max(...files.map((x) => x[1]))
  for (const [path, n] of files) {
    const cell = el('div', 'heatcell')
    const heat = n / max
    // Hex + a two-digit alpha suffix, so these follow the theme like the rest.
    const a2 = (v) => Math.round(v * 255).toString(16).padStart(2, '0')
    cell.style.background = T.accent + a2(0.04 + heat * 0.20)
    cell.style.borderColor = T.accent + a2(0.18 + heat * 0.5)
    cell.style.color = heat > 0.55 ? T.white : ''
    cell.appendChild(document.createTextNode(path.split('/').pop()))
    cell.appendChild(el('span', 'n', String(n)))
    cell.dataset.tip = `${path.split('/').pop()}\n${path}\n${n} edit${n === 1 ? '' : 's'} this session. Click to ask about it.`.slice(0, 400)
    cell.onclick = () => steer('prompt', { text: `Explain what changed in ${path} this session and why.` })
    box.appendChild(cell)
  }
}

// ===================================================================== feed
const ICON = { tool: '⬡', turn: '◆', agent: '✦', deny: '⛊', error: '✕', file: '✎', note: '✱' }
const renderFeed = () => {
  const box = $('feed')
  // Scoped to one session whenever the rail is -- hovering a card on the
  // switchboard filters the feed to that session's calls, and a pinned card
  // holds the filter. Unscoped it is the whole board's, which is why every row
  // carries the session name.
  const one = scoped()
  const all = one ? S.events.filter((e) => e.sessionId === one.id) : S.events
  const rows = all.slice(-90).reverse()
  $('c-feed').textContent = String(all.length)
  box.textContent = ''
  if (!rows.length) {
    box.appendChild(el('div', 'empty', one ? 'Nothing from this session yet.' : 'No activity yet.'))
    return
  }
  rows.forEach((e, i) => {
    const kind = e.status === 'deny' ? 'deny' : e.status === 'error' ? 'err' : e.kind === 'turn' ? 'turn' : e.kind === 'agent' ? 'agent' : 'ok'
    const row = el('div', 'ev ' + kind)
    if (i < 14) row.style.animationDelay = (i * 22) + 'ms'; else row.style.animation = 'none'
    row.appendChild(el('div', 'ts num', clockOf(e.t)))
    const body = el('div', 'body')
    const title = el('div', 'title')
    title.appendChild(el('span', null, ICON[e.kind] || '·'))
    title.appendChild(el('b', null, e.label || e.kind))
    if (e.status === 'deny') title.appendChild(el('span', 'chip deny', 'blocked'))
    if (e.status === 'error') title.appendChild(el('span', 'chip err', 'error'))
    // The detail rides on the SAME line in compact mode -- a feed of bare tool
    // names says almost nothing, and the two-line form is what `detail` is for.
    // It goes in BEFORE whatever claims the right edge.
    if (e.detail) title.appendChild(el('span', 'inline', e.detail))
    // The right edge belongs to the session the call came from: the feed is
    // the whole board's, not one session's, so "which one did this" is the
    // fact a row is otherwise missing. `ms` shares that edge only in the
    // roomiest density -- see .feed.detail/.compact/.dense in app.css.
    if (e.ms) { const n = el('span', 'ms', e.ms + 'ms'); n.style.marginLeft = 'auto'; title.appendChild(n) }
    body.appendChild(title)
    if (e.detail) body.appendChild(el('div', 'detail', e.detail))
    row.appendChild(body)
    // A sibling of .body, not a child of .title: as a child it sat after the
    // (display:none) .ms span and after whatever width the detail text took,
    // so it landed at a different x on every row. A fixed-width last column of
    // .ev is what makes the names line up.
    const who = nameOf(e.sessionId)
    if (who) row.appendChild(el('div', 'who', who))
    box.appendChild(row)
  })
}

// ==================================================================== inbox
const renderInbox = () => {
  const box = $('inbox'); box.textContent = ''
  const openQ = S.questions.filter((q) => q.answer === undefined)
  const openA = S.approvals.filter((a) => a.verdict === undefined)
  const total = openQ.length + openA.length
  $('c-inbox').textContent = String(total)
  if (!total) { box.appendChild(el('div', 'empty', 'Nothing is waiting on you.')); return }

  for (const q of S.questions) {
    if (q.answer !== undefined) continue
    const c = el('div', 'ask')
    c.appendChild(el('div', 'from', 'ask_human · ' + (nameOf(q.sessionId))))
    c.appendChild(el('div', 'q', q.question))
    if (q.context) { const d = el('div', 'detail'); d.style.cssText = 'font-size:10.5px;color:var(--dim);margin-bottom:7px'; d.textContent = q.context; c.appendChild(d) }
    if (q.options?.length) {
      const opts = el('div', 'opts')
      for (const o of q.options) {
        const b = el('button', 'btn key', o)
        b.onclick = () => { post('/api/answer', { questionId: q.id, answer: o }); toast('answered') }
        opts.appendChild(b)
      }
      c.appendChild(opts)
    } else {
      const inp = el('input'); inp.placeholder = 'type an answer, press enter'
      inp.onkeydown = (e) => { if (e.key === 'Enter' && inp.value.trim()) { post('/api/answer', { questionId: q.id, answer: inp.value.trim() }); toast('answered'); inp.value = '' } }
      c.appendChild(inp)
    }
    box.appendChild(c)
  }

  for (const a of S.approvals) {
    if (a.verdict !== undefined) continue
    const c = el('div', 'appr')
    c.appendChild(el('div', 'from', 'approval · ' + nameOf(a.sessionId) + ' · risk ' + a.risk))
    c.appendChild(el('div', 'q', a.tool))
    if (a.detail) { const d = el('div'); d.style.cssText = 'font-family:var(--mono);font-size:10.5px;color:var(--dim);margin-bottom:8px;overflow-wrap:anywhere'; d.textContent = a.detail; c.appendChild(d) }
    const opts = el('div', 'opts')
    const yes = el('button', 'btn go', 'approve'); yes.onclick = () => { post('/api/verdict', { approvalId: a.id, verdict: 'approve' }); toast('approved') }
    const no = el('button', 'btn no', 'deny'); no.onclick = () => { post('/api/verdict', { approvalId: a.id, verdict: 'deny' }); toast('denied') }
    opts.append(yes, no); c.appendChild(opts)
    box.appendChild(c)
  }
}
const nameOf = (id) => S.sessions.find((s) => s.id === id)?.name || (id || '').slice(0, 8)

// ================================================================= steering
/** Unmodal: straight to the focused session. Only the Telemetry tab's file-heat
 *  cells use this -- the Steering panel is modal, see below. */
const steer = async (verb, payload) => {
  const f = focused()
  if (!f) return toast('no session to steer')
  const r = await post('/api/command', { targetId: f.id, verb, payload })
  toast(r.error ? 'failed: ' + r.error : verb + ' → ' + (f.name || f.id.slice(0, 8)))
}
/** `payload` is what the session receives; `label` is what the button and the
 *  mode line call it. Data, not closures, because arming has to carry the
 *  command around until a target is picked. */
const prompt_ = (label, text) => ({ label, verb: 'prompt', payload: { text } })

/** A steering command's identity. `syncArmed()` used to compare button TEXT,
 *  which stops working the moment a button can be named whatever its author
 *  like -- two buttons could light at once, and the `+` affordance is a .btn
 *  as well. Built-ins are keyed by label (they are unique and fixed), customs
 *  by the id the store minted. */
const steerId = (cmd) => (cmd.custom ? 'c:' + cmd.custom : 'b:' + cmd.label)

const STEER_BUTTONS = [
  prompt_('run tests', 'Run the test suite and report failures.'),
  prompt_('commit', 'Stage and commit the current work with a clear message.'),
  prompt_('review diff', 'Review the current diff for bugs and simplifications.'),
  prompt_('step back', 'Step back: are we solving the right problem, and is there a simpler way?'),
  prompt_('status update', 'hows it going, any updates?'),
  prompt_('spawn reviewer', 'Spawn a subagent to review the work so far and report back.'),
  prompt_('surface rulings', 'Surface the rulings you made while I was away: read your autonomous-run rulings log under docs/decisions/ (the newest *-autonomous-rulings.md) and make your FINAL message a summary of it — every ruling, what you chose, the tradeoff, the alternatives you did not take, and the commit to roll back to. If there is no such log, say so in one line and summarise the decisions from this session instead.'),
  { label: 'go autonomous', verb: 'prompt', payload: null, form: 'goal' },
  { label: 'abort turn', verb: 'abort', payload: {} },
]

/** The built-ins, then the user's own. One list, so a custom button inherits
 *  arming, marking, A-broadcast and the mode line for free rather than
 *  growing a second code path. */
const steerCommands = () => [
  ...STEER_BUTTONS,
  ...(S.steering?.custom ?? []).map((b) => ({ label: b.label, verb: 'prompt', payload: { text: b.prompt }, custom: b.id })),
]
/* ------------------------------------------------------------- modal steering
 *
 *  A steering button does NOT send. It ARMS: the pointer is then carrying that
 *  command, and the session you click is the one that gets it. Modifiers
 *  change the target, never the command:
 *
 *    click a button            arm, then pick one session
 *    A + click a button        skip picking: broadcast to every live session
 *    (armed) click a card      send to that session, and to anything marked
 *    (armed) option-click      mark/unmark a card, without sending
 *    (armed) enter             send to what is marked
 *    (armed) esc               disarm
 *
 *  Nothing here is discoverable by looking at it, which is exactly why the
 *  mode line exists: see renderModeline(). Every state this can be in has a
 *  sentence there saying what the next click does.
 */
const steerTo = async (ids, label, verb, payload) => {
  if (!ids.length) return toast('no session to steer')
  const results = await Promise.all(
    ids.map((id) => post('/api/command', { targetId: id, verb, payload }).catch((e) => ({ error: String(e) }))),
  )
  const failed = results.filter((r) => r?.error).length
  const who = ids.length === 1 ? nameOf(ids[0]) : `${ids.length} sessions`
  toast(failed ? `${label}: ${failed} of ${ids.length} failed` : `${label} → ${who}`)
}

const disarm = () => {
  if (!S.armed && !S.marks.length) return
  S.armed = null
  S.marks = []
  syncArmed()
}

/** Everything that has to agree with S.armed / S.marks, in one place. */
const syncArmed = () => {
  document.body.classList.toggle('armed', !!S.armed)
  for (const n of document.querySelectorAll('.card')) {
    n.classList.toggle('marked', S.marks.includes(n.dataset.id))
  }
  const armedId = S.armed ? steerId(S.armed) : null
  for (const b of document.querySelectorAll('#steer .btn')) {
    b.classList.toggle('on', !!armedId && b.dataset.steerId === armedId)
  }
  renderModeline()
}

/** A card was clicked while a command was armed. Option adds to the selection
 *  and sends nothing; a plain click sends, to the marks plus this one. */
const armedClick = (id, additive) => {
  if (additive) {
    S.marks = S.marks.includes(id) ? S.marks.filter((x) => x !== id) : [...S.marks, id]
    syncArmed()
    return
  }
  const a = S.armed
  const ids = [...new Set([...S.marks, id])]
  disarm()
  void steerTo(ids, a.label, a.verb, a.payload)
}

/* The steering form. `edit` names a custom button's id; `goal` puts it in the
 * mode needs, where an argument is being typed rather than
 * registering anything. `null` when nothing is open, which is what the esc
 * chain tests. */
let steerForm = null
const steerModal = $('steerform')

const openSteerForm = (opts) => {
  const b = opts.edit ? (S.steering?.custom ?? []).find((x) => x.id === opts.edit) : null
  steerForm = { ...opts, restore: document.activeElement }
  const goal = opts.goal
  MCX.show($('sf-labelrow'), !goal)
  MCX.show($('sf-delete'), !!b)
  setText($('sf-title'), goal ? goal.label : b ? 'Edit button' : 'Register a button')
  setText($('sf-promptlabel'), goal ? 'Goal' : 'Prompt')
  setText($('sf-note'), goal ? goal.note : 'It joins the panel after the built-ins and behaves like them: it arms, and the session you click gets the prompt.')
  $('sf-label').value = b?.label ?? ''
  $('sf-prompt').value = b?.prompt ?? ''
  $('sf-prompt').placeholder = goal ? goal.placeholder : 'What should the session be told?'
  steerModal.hidden = false
  // Focus lands where the typing goes: the name for a new button, the prompt
  // when editing one (the name is already right) or asking for a goal.
  requestAnimationFrame(() => (goal || b ? $('sf-prompt') : $('sf-label')).focus())
  renderModeline()
}

const closeSteerForm = () => {
  if (!steerForm) return
  const back = steerForm.restore
  steerForm = null
  steerModal.hidden = true
  if (back?.isConnected && typeof back.focus === 'function') back.focus()
  renderModeline()
}

/** The whole list goes up, every time -- add, edit, delete and reorder are all
 *  "here is the new list". The store validates it; a 400 comes back with a
 *  reason and the form stays open so it can be fixed. */
const saveSteering = async (custom) => {
  const r = await post('/api/steering', { custom })
  if (r.error) { toast('not saved: ' + r.error, { kind: 'warn' }); return false }
  S.steering = r.steering ?? { custom }
  renderSteer(); syncArmed()
  return true
}

const submitSteerForm = async () => {
  if (!steerForm) return
  const f = steerForm
  const text = $('sf-prompt').value.trim()
  if (!text) return void toast('nothing to send')
  if (f.goal) { closeSteerForm(); return void f.goal.then(text) }
  const label = $('sf-label').value.trim()
  if (!label) return void toast('the button needs a name')
  const current = S.steering?.custom ?? []
  const next = f.edit
    ? current.map((b) => (b.id === f.edit ? { ...b, label, prompt: text } : b))
    : [...current, { label, prompt: text }]
  if (await saveSteering(next)) { closeSteerForm(); toast(f.edit ? 'button updated' : 'button registered') }
}

const deleteSteerButton = async () => {
  if (!steerForm?.edit) return
  const id = steerForm.edit
  // Disarm first: the armed command may BE the button being deleted, and the
  // mode line would otherwise keep naming a button that no longer exists.
  if (S.armed && S.armed.custom === id) disarm()
  const next = (S.steering?.custom ?? []).filter((b) => b.id !== id)
  if (await saveSteering(next)) { closeSteerForm(); toast('button removed') }
}

$('sf-cancel').addEventListener('click', closeSteerForm)
$('sf-save').addEventListener('click', () => { void submitSteerForm() })
$('sf-delete').addEventListener('click', () => { void deleteSteerButton() })
steerModal.addEventListener('mousedown', (ev) => { if (ev.target === steerModal) closeSteerForm() })
for (const id of ['sf-label', 'sf-prompt']) {
  $(id).addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); void submitSteerForm() }
  })
}

const renderSteer = () => {
  const box = $('steer')
  MCX.reconcile(box, steerCommands(), {
    key: (cmd) => steerId(cmd),
    create: () => el('button', 'btn'),
    update: (b, cmd) => {
      MCX.setText(b, cmd.label)
      b.dataset.steerId = steerId(cmd)
      MCX.toggle(b, 'custom', !!cmd.custom)
      // `payload` is null on a command that collects an argument first
      // (`go autonomous`), so the tip cannot assume there is text.
      const tip = cmd.payload?.text ?? (cmd.verb === 'abort' ? 'aborts the current turn' : 'asks for a goal first')
      b.dataset.tip = cmd.custom
        ? `${cmd.label}\n${tip}\n\nshift-click to edit or delete`
        : `${cmd.label}\n${tip}`
      b.onclick = (ev) => {
        // Shift opens the editor instead of arming -- shift is the one
        // modifier steering does not already spend (A broadcasts, ⌥ marks).
        if (ev.shiftKey && cmd.custom) return void openSteerForm({ edit: cmd.custom })
        // A command with no payload has to collect one before it can arm --
        // there is nothing to carry until the goal has been stated.
        if (cmd.form === 'goal') return void openSteerForm({ goal: {
          label: 'Go autonomous',
          note: 'The session takes this from spec to plan to implementation in its own worktree, deciding as it goes and logging every ruling with its tradeoffs and a rollback commit. It stops only for something irreversible.',
          placeholder: 'What should it build or fix while you are away?',
          then: (text) => {
            S.armed = { ...cmd, payload: { text: 'Use the autonomous-run skill. Goal: ' + text } }
            S.marks = []
            syncArmed()
          },
        } })
        if (S.mods.all) {          // A is "every session": no target needed.
          const ids = S.sessions.map((x) => x.id)
          disarm()
          return void steerTo(ids, cmd.label, cmd.verb, cmd.payload)
        }
        S.armed = S.armed && steerId(S.armed) === steerId(cmd) ? null : cmd
        if (!S.armed) S.marks = []
        syncArmed()
      }
    },
  })
  // The add affordance, rebuilt only if it is missing: MCX leaves foreign
  // nodes exactly where they are, and this one must stay last.
  let add = box.querySelector('.steeradd')
  if (!add) { add = el('button', 'btn steeradd', '+'); box.appendChild(add) }
  else box.appendChild(add)
  add.dataset.tip = 'Register a button\nA name and a prompt. It joins the panel and behaves like the rest.'
  add.onclick = () => openSteerForm({})
}

// =================================================================== drawer
/** Everything the rail's scope drives. One call so a hover can never move the
 *  metrics without also moving the feed, which would read as a bug. */
const rescope = () => { renderTiles(); renderFeed(); renderModeline() }

/** Paints the drawer's "Last message" section from `s.lastAnswer`/
 *  `lastAnswerAt` alone. Split out of `openDrawer` so a live update can
 *  repaint just this one section into `#d-last` -- built once, in
 *  `openDrawer` -- without touching the rest of `#d-body` (which would cost
 *  its scroll position) and without a close/reopen. `lastAnswer` is a payload
 *  field, so against a relay that predates it this reads undefined and the
 *  empty state shows -- indistinguishable from a session that has not
 *  finished a turn yet: the pane's static assets reload on their own, but the
 *  relay behind them does not. */
const renderLastMessage = (s) => {
  const box = $('d-last'); if (!box) return
  box.textContent = ''
  if (s.lastAnswer) {
    const said = el('div', 'saidbox')
    // textContent, never innerHTML: this is an assistant's prose arriving over
    // the wire and it is displayed, never parsed.
    const pre = el('pre', 'said')
    pre.textContent = s.lastAnswer
    said.appendChild(pre)
    said.appendChild(el('div', 'saidage', s.lastAnswerAt ? ago(s.lastAnswerAt) + ' ago' : ''))
    box.appendChild(said)
  } else box.appendChild(el('div', 'empty', 'No message yet.'))
}

/** Called on every SSE payload that carries fresh session data. While the
 *  drawer is pinned open on a session, its "Last message" section otherwise
 *  only reflects whatever was true at the moment it was opened -- this is
 *  what keeps it live without re-running `openDrawer` (and its scroll-
 *  resetting, rename-cancelling side effects) on every frame. */
const refreshPinnedLastMessage = () => {
  if (!S.pinned) return
  const s = S.sessions.find((x) => x.id === S.pinned)
  if (s) renderLastMessage(s)
}

// --- TODOs: this session's own plans, with a whole-project toggle -----------
/** Whether plan `p` -- already known to live in this session's own worktree --
 *  counts as its OWN work, and by which rule; also the display order (an
 *  explicit claim outranks `checkedBy` outranks a bare diff from main, the
 *  same precedence `tasks.mjs`'s `ownerFor` uses for the claim itself). `null`
 *  means none of the three apply: inherited noise in "this session" mode.
 *
 *  There is no relay field for "differs from main" as such (the per-plan
 *  `diff` only says whether the FILE exists in main, not whether its content
 *  does), so the third rule is derived from what each item already carries:
 *  `tasks.mjs`'s `labelItems` stamps every item 'same' unless this worktree's
 *  copy genuinely outranks or trails main's -- exactly "not identical to
 *  main". `isMainWorktree` is the one case that check cannot see at all:
 *  `labelItems` is never even called against main's own items (there is
 *  nothing to diff main against), so every item there reads 'same' by
 *  construction regardless of real progress. Reported/verified counts on
 *  THIS copy are the fallback signal there -- the only worktree it applies
 *  to, so it cannot reintroduce the inherited-plan noise this filter exists
 *  to remove in a branched worktree, where an untouched inherited plan's
 *  reported count is identical to main's and so already reads 'same'. */
const planIsMine = (p, sessionId, isMainWorktree) => {
  if (p.owner?.source === 'claim' && p.owner.id === sessionId) return 'claim'
  if (p.owner?.source === 'checked' && p.owner.id === sessionId) return 'checked'
  const differs = (p.items || []).some((i) => i.diff && i.diff !== 'same')
  const touched = differs || (isMainWorktree && (p.done > 0 || p.reported > 0))
  return touched ? 'touched' : null
}
const TODO_MINE_ORDER = { claim: 0, checked: 1, touched: 2 }

const TODO_SCOPE_KEY = 'szg.drawer.todoscope'
const readTodoScope = () => {
  try { return localStorage.getItem(TODO_SCOPE_KEY) === 'all' ? 'all' : 'mine' } catch { return 'mine' }
}
const writeTodoScope = (v) => { try { localStorage.setItem(TODO_SCOPE_KEY, v) } catch {} }

/** The drawer's TODOs section: this session's own plans by default -- an
 *  explicit claim, then `checkedBy`, then anything touched in this worktree's
 *  copy that main's does not share -- plus its claimed backlog sections, with
 *  a header toggle to the unfiltered whole-worktree list (the only thing the
 *  section showed before this feature). Rebuilt on demand, from `openDrawer`
 *  and from the toggle's own click, rather than only ever from `openDrawer` --
 *  the same reason `renderLastMessage` is split out: repainting the whole
 *  drawer body would cost scroll position and cancel an in-progress rename.
 *  Re-finds the worktree from `S.projects` each call rather than closing over
 *  it, so a toggle click after a payload has moved on still reads live data.
 *  Rows are MCX-keyed so a hover surviving the mine/whole-project toggle is
 *  free, the same reason `renderSteer` reconciles its button list. */
const renderTodos = (id) => {
  const head = $('d-todos-head'), flag = $('d-todos-flag'), note = $('d-todos-note'), list = $('d-todos-list')
  if (!head || !list || !flag || !note) return
  head.textContent = ''
  head.appendChild(el('span', 'sect', 'TODOs'))

  const wt = (S.projects || [])
    .flatMap((p) => p.worktrees)
    .find((w) => w.sessions.some((x) => x.id === id))

  if (!wt) {
    MCX.show(flag, false)
    MCX.setText(note, 'No task files found for this session’s worktree.')
    MCX.show(note, true)
    MCX.reconcile(list, [], { key: (d) => d.key })
    return
  }

  // The convention is docs/TASKS.md; a file at the project ROOT outranks it.
  // Worth saying out loud, because a project with both has a docs/TASKS.md
  // that is being read and is not the authority -- which is invisible
  // everywhere else and is exactly the sort of thing somebody edits for an
  // hour before noticing.
  if (wt.taskAuthority === 'root') {
    MCX.setText(flag, 'todos: ' + wt.taskFile + ' at the project root takes precedence over docs/')
    MCX.show(flag, true)
  } else MCX.show(flag, false)

  // `!p.shipped` matters as much as the counts here: this list computes
  // "in flight" itself rather than reading `effort.live`, so without it a
  // plan that DECLARES it shipped still appears, captioned "all steps
  // checked" beside a title reading `0/N`. That caption is a false
  // completion claim -- worse than the stale current step it replaced.
  const live = wt.plans.filter((p) => p.done < p.total && !p.shipped)

  if (!live.length) {
    MCX.show(note, false)
    MCX.reconcile(list, [], { key: (d) => d.key })
    list.textContent = ''
    list.appendChild(el('div', 'empty', 'No plans in flight in ' + wt.path + '.'))
    return
  }

  const scope = readTodoScope()
  const mine = live
    .map((p) => ({ p, reason: planIsMine(p, id, wt.isMain) }))
    .filter((x) => x.reason)
    .sort((a, b) => TODO_MINE_ORDER[a.reason] - TODO_MINE_ORDER[b.reason])
    .map((x) => x.p)
  const sections = (wt.tasks || [])
    .flatMap((t) => (t.items || []).map((i) => ({ i, t })))
    .filter(({ i }) => i.kind === 'section' && (i.claimedBy || []).some((c) => c.id === id))

  // Nothing claimed or touched: fall through to the unfiltered list rather
  // than an empty section, so a fresh session is never blank.
  const fallback = scope === 'mine' && mine.length === 0 && sections.length === 0
  const wholeProject = scope === 'all' || fallback
  const shownPlans = wholeProject ? live : mine

  const toggle = el('button', 'btn todoscope', scope === 'all' ? 'whole project' : 'this session')
  toggle.dataset.tip = 'TODOs scope\n"this session" shows only plans this session claimed or has touched, plus its claimed backlog sections.\n"whole project" shows every in-flight plan in the worktree.\n\nClick to switch.'
  toggle.onclick = () => { writeTodoScope(scope === 'all' ? 'mine' : 'all'); renderTodos(id) }
  head.appendChild(toggle)
  head.appendChild(el('span', 'todocount', scope === 'all'
    ? live.length + (live.length === 1 ? ' plan' : ' plans') + ' · whole project'
    : mine.length + ' of ' + live.length + ' plans · this session'))

  MCX.setText(note, 'no plan claimed or touched by this session — showing the project')
  MCX.show(note, fallback)

  const rows = shownPlans.map((p) => ({ key: 'plan:' + p.rel, kind: 'plan', p }))
  if (!wholeProject) for (const { i, t } of sections) rows.push({ key: 'section:' + t.rel + '#' + i.slug, kind: 'section', i })

  MCX.reconcile(list, rows, {
    key: (d) => d.key,
    create: () => {
      const r = el('div', 'ev ok')
      r.appendChild(el('div', 'body'))
      return r
    },
    update: (r, d) => {
      const bd = r.firstElementChild
      bd.textContent = ''
      if (d.kind === 'plan') {
        const cur = d.p.items.find((i) => i.id === d.p.currentItemId)
        bd.appendChild(el('div', 'title', (d.p.title || d.p.rel) + ' · ' + d.p.done + '/' + d.p.total))
        bd.appendChild(el('div', 'detail', cur ? cur.text : 'all steps checked'))
      } else {
        bd.appendChild(el('div', 'title', d.i.text))
        bd.appendChild(el('div', 'detail', 'claimed backlog section'))
      }
    },
  })
}

// --- card colour ---------------------------------------------------------
// A session card's own outline colour, set here and drawn by fillCard/
// canvas.js off `s.color` (cards.mjs). It exists to make one session findable
// at a glance, which is a switchboard-wide concern -- so the picker lives in
// the drawer, one per session, rather than as a global setting.

/** Eight points spread evenly around the wheel, at the same saturation and
 *  lightness `buildSwatches` already uses for the theme picker (hsl(hue 60%
 *  65%)) -- "from the theme family" without literally reusing THEMES' five
 *  hues, which would sit on top of the four semantic presets below (amber
 *  ~30°, green ~165°, purple ~262°, red-hot ~350°). */
const hslToHex = (h, s, l) => {
  s /= 100; l /= 100
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const toHex = (n) => Math.round(255 * f(n)).toString(16).padStart(2, '0')
  return `#${toHex(0)}${toHex(8)}${toHex(4)}`
}
const CARD_WHEEL = [0, 45, 90, 135, 180, 225, 270, 315].map((h) => hslToHex(h, 60, 65))
// The four semantic tokens (app.css :root), spelled out as the literal hex
// they already are rather than resolved from CSS -- the picker needs a real
// #rrggbb to post, not a var() reference.
const CARD_SEMANTIC = ['#e0973c', '#ff5670', '#45c9a0', '#a883e6'] // amber, red-hot, green, purple
const CARD_PRESETS = [...CARD_WHEEL, ...CARD_SEMANTIC]

/** Sets a session's outline colour. Optimistic, same pattern as canvas.js's
 *  node-move drag (finish()): the card and the drawer update immediately,
 *  and only revert if the relay refuses. `s` is mutated in place rather than
 *  replaced, since `S.sessions` is what every render reads. */
const setCardColor = async (id, color) => {
  const s = S.sessions.find((x) => x.id === id)
  const prior = s ? s.color : undefined
  if (s) s.color = color
  renderCards()
  if (S.pinned === id) renderColor(id)
  const r = await post('/api/session/color', { id, color })
  if (!r || r.error) {
    toast((r && r.error) || 'could not set colour', { kind: 'warn' })
    if (s) s.color = prior
    renderCards()
    if (S.pinned === id) renderColor(id)
  }
}

/** Rebuilt on every call rather than kept as a stable container (unlike
 *  #d-last/#d-todos): nothing here needs a partial SSE repaint mid-drawer,
 *  so the plain rebuild openDrawer already does for most sections is enough. */
const renderColor = (id) => {
  const box = $('d-color')
  if (!box) return
  const s = S.sessions.find((x) => x.id === id)
  box.textContent = ''
  if (!s) return

  const row = el('div', 'cswatches')
  for (const hex of CARD_PRESETS) {
    const b = el('button', 'swatch')
    b.type = 'button'
    b.style.setProperty('--sw', hex)
    b.setAttribute('aria-label', hex)
    b.setAttribute('aria-pressed', String((s.color || '') === hex))
    b.onclick = () => setCardColor(id, hex)
    row.appendChild(b)
  }
  box.appendChild(row)

  const pickrow = el('div', 'cpickrow')
  const input = el('input')
  input.type = 'color'
  input.value = /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : '#6fc3df'
  input.title = 'custom colour'
  input.oninput = () => setCardColor(id, input.value)
  pickrow.appendChild(input)

  const clear = el('button', 'btn no', 'clear')
  clear.type = 'button'
  clear.disabled = !s.color
  clear.onclick = () => setCardColor(id, '')
  pickrow.appendChild(clear)
  box.appendChild(pickrow)
}

const openDrawer = (id) => {
  const s = S.sessions.find((x) => x.id === id); if (!s) return
  S.focus = id
  S.pinned = id
  // a pinned card reveals the per-session narration underneath the
  // blurb, the same as hovering the panel does (app.css's .orb-pinned rules).
  MCX.toggle(document.querySelector('.orbpanel'), 'orb-pinned', true)
  rescope()
  const st = s.stats || {}
  // openDrawer re-runs on every payload, so a rename left half-typed would
  // otherwise survive a switch to a different card and commit against the
  // wrong session. Only a change of session cancels it; a refresh of the same
  // one leaves the field alone, or typing a name would be impossible.
  if (S.renaming !== id) { stopRenaming(); S.renaming = null }
  $('d-title').textContent = s.name || s.repo || id.slice(0, 12)
  const b = $('d-body'); b.textContent = ''
  const asking = needsOf(s)
  if (asking) {
    const box = el('div', 'needbox')
    box.appendChild(el('div', 'needhead', '\u25cf waiting on you'))
    box.appendChild(el('div', 'needwhat', asking))
    box.appendChild(el('div', 'needsrc', s.waiting ? 'parked at a prompt' : 'asked at the end of its last turn'))
    b.appendChild(box)
  }

  // A colour for this card, so it is findable at a glance -- above Last
  // message: it is the thing to reach for before reading anything else.
  b.appendChild(el('div', 'sect', 'Card colour'))
  const colorBox = el('div'); colorBox.id = 'd-color'
  b.appendChild(colorBox)
  renderColor(id)

  // What it last said, and when. Given its own stable container (`d-last`)
  // rather than built inline here, so `refreshPinnedLastMessage` (SSE handlers,
  // below) can repaint just this section while the drawer stays open, instead
  // of requiring a close/reopen to see a new answer -- see `renderLastMessage`.
  b.appendChild(el('div', 'sect', 'Last message'))
  const lastBox = el('div'); lastBox.id = 'd-last'
  b.appendChild(lastBox)
  renderLastMessage(s)

  const dl = el('dl', 'kv')
  const kv = (k, v) => { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, String(v ?? '—'))) }
  kv('session', s.id); kv('agent name', s.agentName || '—'); kv('cwd', s.cwd); kv('repo', s.repo || '—')
  kv('branch', s.branch || '—'); kv('model', s.model); kv('pid', s.pid); kv('uptime', ago(s.startedAt))
  kv('context', compact(st.ctx || 0) + ' / ' + compact(st.ctxLimit || 200000))
  kv('spend', money(st.spend)); kv('tool calls', st.tools || 0); kv('guardrails', st.guardrails || 0)
  b.appendChild(dl)

  b.appendChild(el('div', 'sect', 'Subagents'))
  if (s.agents?.length) {
    for (const a of s.agents) {
      const r = el('div', 'ev ' + (a.status === 'running' ? 'agent' : 'ok'))
      const bd = el('div', 'body')
      bd.appendChild(el('div', 'title', a.description || a.type))
      bd.appendChild(el('div', 'detail', a.type + ' · ' + a.status))
      r.appendChild(bd)
      const kill = el('button', 'btn no', 'kill'); kill.style.alignSelf = 'center'
      kill.onclick = () => { post('/api/command', { targetId: s.id, verb: 'kill-agent', payload: { agentId: a.id } }); toast('kill sent') }
      r.appendChild(kill)
      b.appendChild(r)
    }
  } else b.appendChild(el('div', 'empty', 'No subagents.'))

  // Built as stable containers (see renderTodos, above): the toggle repaints
  // just this section, without the scroll-resetting, rename-cancelling cost
  // of a full openDrawer re-run.
  const todosHead = el('div', 'secthead'); todosHead.id = 'd-todos-head'
  b.appendChild(todosHead)
  const todosFlag = el('div', 'taskflag'); todosFlag.id = 'd-todos-flag'
  b.appendChild(todosFlag)
  const todosNote = el('div', 'tdnote'); todosNote.id = 'd-todos-note'
  b.appendChild(todosNote)
  const todosList = el('div'); todosList.id = 'd-todos-list'
  b.appendChild(todosList)
  renderTodos(id)

  b.appendChild(el('div', 'sect', 'Recent activity'))
  const mine = S.events.filter((e) => e.sessionId === id).slice(-18).reverse()
  if (mine.length) for (const e of mine) {
    const r = el('div', 'ev ' + (e.status === 'deny' ? 'deny' : 'ok'))
    r.appendChild(el('div', 'ts num', clockOf(e.t)))
    const bd = el('div', 'body'); bd.appendChild(el('div', 'title', e.label || e.kind))
    if (e.detail) bd.appendChild(el('div', 'detail', e.detail))
    r.appendChild(bd); b.appendChild(r)
  } else b.appendChild(el('div', 'empty', 'Nothing recorded.'))

  b.appendChild(el('div', 'sect', 'Links'))
  const mylinks = S.links.filter((l) => l.from === id || l.to === id)
  if (mylinks.length) for (const l of mylinks) {
    const r = el('div', 'ev ok')
    const bd = el('div', 'body')
    bd.appendChild(el('div', 'title', (l.from === id ? '→ ' : '← ') + nameOf(l.from === id ? l.to : l.from)))
    r.appendChild(bd)
    const cut = el('button', 'btn no', 'unlink')
    cut.onclick = () => { post('/api/unlink', { id: l.id }); toast('unlinked') }
    r.appendChild(cut); b.appendChild(r)
  } else b.appendChild(el('div', 'empty', 'No channels open. Drag this card onto another.'))

  // --- jump to this session's terminal ---------------------------------------
  b.appendChild(el('div', 'sect', 'Terminal'))
  b.appendChild(renderJump(s))

  // Its own stable container, like the TODOs and Last message sections above:
  // arming has to survive the payload repaints that re-run openDrawer, or the
  // button would disarm itself two seconds after being armed.
  b.appendChild(el('div', 'sect', 'Close'))
  const killBox = el('div'); killBox.id = 'd-kill'
  b.appendChild(killBox)
  renderKill(id)

  $('drawer').classList.add('open')
  renderCards()
}
// --- jumping to a session's terminal -----------------------------------------
/** The four cases, by the name the relay put on the payload. A relay that
 *  predates the field sends nothing, and the button then reads "jump to
 *  terminal" and lets the relay answer -- a neutral label is the right
 *  degradation, where guessing a case would be a confident wrong one
 *  A client reading a missing payload field fails SILENTLY. */
const JUMP = {
  tmux: { label: 'jump to terminal', detail: 'switches the tmux client and raises the terminal' },
  background: { label: 'attach', detail: 'opens a tmux window and attaches to this background session' },
  resume: { label: 'resume', detail: 'the process has exited; opens a tmux window and resumes it' },
  outside: { label: 'outside tmux', detail: 'live in a terminal outside tmux — nothing can raise it without a macOS permission prompt' },
}
const renderJump = (s) => {
  const c = JUMP[s.jump] || JUMP.tmux
  const row = el('div', 'ev' + (s.jump === 'outside' ? ' deny' : ''))
  const bd = el('div', 'body')
  bd.appendChild(el('div', 'title', c.label))
  bd.appendChild(el('div', 'detail', c.detail))
  row.appendChild(bd)
  const btn = el('button', 'btn', c.label)
  btn.disabled = s.jump === 'outside'
  btn.onclick = async () => {
    const out = await post('/api/jump', { id: s.id })
    if (out && out.ok) {
      toast(out.case === 'tmux' ? 'jumped' : `opened ${out.window || 'a tmux window'}`)
      if (out.note) toast(out.note, { ms: 5000, kind: 'warn' })
    } else if (out && out.case === 'outside') {
      toast(`outside tmux${out.tty ? ' on ' + out.tty : ''} — run: ${out.command}`, { ms: 8000, kind: 'warn' })
    } else {
      toast((out && out.error) || 'could not jump', { ms: 5000, kind: 'warn' })
    }
  }
  row.appendChild(btn)
  return row
}

// --- closing a session -------------------------------------------------------
/** Two steps, and the second one expires. The pane-v2 spec's armed-confirmation
 *  idiom in browser form: the first click arms, the second within ARM_MS does
 *  it, and anything else -- five seconds passing, opening another drawer --
 *  disarms. A confirm() dialog would have done the same job and blocked the
 *  whole board, which on a page carrying a live SSE stream is worse than the
 *  problem. */
const KILL_ARM_MS = 5000
let killArmed = null      // { id, until, timer }
const disarmKill = () => {
  if (killArmed?.timer) clearTimeout(killArmed.timer)
  killArmed = null
}
/** What closing this session would actually do. Mirrors canvas.mjs's killPlan,
 *  and deliberately says WHICH mechanism: "stop" and "SIGTERM" are different
 *  promises and the button should not pretend they are one. */
const killModeOf = (s) => {
  if (s.kind === 'background' && s.shortId) return { can: true, what: 'claude stop ' + s.shortId }
  if (Number(s.pid) > 1) return { can: true, what: 'SIGTERM to pid ' + s.pid }
  return { can: false, what: 'no pid registered, and not a background agent' }
}
const renderKill = (id) => {
  const box = $('d-kill')
  if (!box) return
  const s = S.sessions.find((x) => x.id === id)
  box.textContent = ''
  if (!s) return
  const mode = killModeOf(s)
  const row = el('div', 'ev')
  const bd = el('div', 'body')
  bd.appendChild(el('div', 'title', mode.can ? 'End this session' : 'Cannot end this session'))
  bd.appendChild(el('div', 'detail', mode.what))
  row.appendChild(bd)
  if (mode.can) {
    const armed = killArmed && killArmed.id === id && Date.now() < killArmed.until
    const btn = el('button', 'btn no', armed ? 'click again to confirm' : 'close session')
    btn.onclick = async () => {
      if (!(killArmed && killArmed.id === id && Date.now() < killArmed.until)) {
        disarmKill()
        killArmed = { id, until: Date.now() + KILL_ARM_MS, timer: setTimeout(() => { disarmKill(); renderKill(id) }, KILL_ARM_MS) }
        renderKill(id)
        return
      }
      disarmKill()
      const out = await post('/api/session/kill', { id })
      if (out && out.ok) { toast('session closed'); closeDrawer() }
      else toast((out && out.error) || 'could not close the session')
    }
    row.appendChild(btn)
  }
  box.appendChild(row)
}

const closeDrawer = () => {
  disarmKill()
  $('drawer').classList.remove('open')
  S.pinned = null
  MCX.toggle(document.querySelector('.orbpanel'), 'orb-pinned', false)
  rescope()
}
$('d-close').onclick = closeDrawer

// --- the reply field ---------------------------------------------------------
/** Send what is typed to the pinned session, as a prompt.
 *
 *  `S.pinned` and not `S.focus`: focus follows the pointer across the board, so
 *  addressing focus would send the reply to whichever card the mouse drifted
 *  over between typing and hitting send. The pin is the session whose drawer is
 *  open, which is the one the field is visibly attached to.
 *
 *  The toast says QUEUED, never "sent". `/api/command` returns once the verb is
 *  on the session's queue; the session collects it on its next poll and only
 *  then does `$.prompt.submit` run. Reporting "sent" would be a claim this code
 *  cannot make: the relay answers on enqueue, not on delivery. */
const sendReply = async () => {
  const box = $('d-replytext')
  const text = box.value.trim()
  const id = S.pinned
  if (!text || !id) return
  // Cleared BEFORE the await, so a second Enter on a slow relay cannot enqueue
  // the same reply twice; restored on failure, because losing what somebody
  // typed is worse than a duplicate they can see and delete.
  box.value = ''
  const r = await post('/api/command', { targetId: id, verb: 'prompt', payload: { text } })
  if (r.error) { box.value = text; toast(r.error, { kind: 'warn' }); return }
  toast('queued for ' + nameOf(id))
}
// --- rename ------------------------------------------------------------------
/** The drawer title becomes a field, and back again.
 *
 *  Nothing here writes the name: it posts, and the name arrives the long way
 *  round -- the relay queues the verb, the session runs Claude Code's own
 *  /rename on its next poll, and its next /api/stats push carries the new name
 *  onto the payload, about a second later. So the title is never assigned
 *  locally even for a moment. A title that changed instantly and then reverted
 *  because /rename refused the name would be a lie the board told itself. */
const stopRenaming = () => {
  S.renaming = null
  MCX.show($('d-titleedit'), false)
  MCX.show($('d-renamehint'), false)
  MCX.show($('d-title'), true)
}
const startRenaming = () => {
  const s = S.sessions.find((x) => x.id === S.pinned)
  if (!s) return
  const box = $('d-titleedit')
  S.renaming = s.id
  box.value = s.name || ''
  MCX.show($('d-title'), false)
  MCX.show(box, true)
  MCX.show($('d-renamehint'), true)
  box.focus()
  box.select()
}
const commitRename = async () => {
  const box = $('d-titleedit')
  const name = box.value.trim()
  const id = S.pinned
  stopRenaming()
  if (!id || !name) return
  const r = await post('/api/rename', { id, name })
  toast(r.error ? 'rename refused: ' + r.error : 'rename queued', r.error ? { kind: 'warn' } : undefined)
}
$('d-rename').onclick = () => {
  if ($('d-titleedit').classList.contains('gone')) startRenaming()
  else void commitRename()
}
$('d-titleedit').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); void commitRename() }
  // Handled here rather than in the drawer's Escape listener so it can stop
  // the event: cancelling the rename must not also close the drawer.
  else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); stopRenaming() }
})

$('d-reply').addEventListener('submit', (ev) => { ev.preventDefault(); void sendReply() })
$('d-replytext').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); void sendReply() }
})
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  // A half-typed reply is the innermost thing of all. Escape steps out of the
  // field and leaves the drawer open; closing it here would discard what the
  // user had written, and the field is the one place in the drawer where esc
  // has something of its own to mean.
  if (document.activeElement === $('d-replytext')) { $('d-replytext').blur(); return }
  // The link dialog is the innermost thing open, so esc answers that first and
  // leaves the drawer where it is.
  if (!$('settingspop').hidden) { closeSettings(); return }
  if (steerForm) { closeSteerForm(); return }
  if (pendingLink) { closeLinkDialog(); return }
  // An armed command is the innermost thing open after the dialog: esc should
  // put the pointer down before it starts closing panels.
  if (S.armed) { disarm(); return }
  // the SECOND Escape (or one pressed with the field never focused,
  // since `#orb-ask`'s own handler already stopped propagation on the
  // first) collapses the transcript -- a VIEW action, guarded on there
  // being something open at all so an already-closed transcript never eats
  // an Escape another view still needs.
  if (S.orchTurns.length > 0 && !S.orchTranscriptHidden) { S.orchTranscriptHidden = true; renderOrchTranscript(); return }
  S.linkFrom = null
  closeDrawer()
})

// ===================================================================== mood
const recomputeMood = () => {
  const f = focused()
  const recent = S.events.slice(-14)
  if (recent.some((e) => e.status === 'deny')) S.mood = 'blocked'
  else if (recent.filter((e) => e.status === 'error').length >= 3) S.mood = 'stuck'
  else if (f?.working) S.mood = 'working'
  else if (recent.some((e) => e.kind === 'turn' && /pass|green|success/i.test(e.detail || ''))) S.mood = 'happy'
  else S.mood = 'idle'
  $('orb-mood').textContent = (MOOD[S.mood] || MOOD.idle).label
  const line = f?.status || (S.sessions.length ? 'Session idle. Nothing running.' : 'Waiting for a session to report in.')
  if ($('orb-line').textContent !== line) $('orb-line').textContent = line
}

// ============================================================ orchestrator
// The field is static markup in index.html (see its comment there); everything below only reads it and
// renders around it -- reconciliation never touches the input itself.

// Stale once older than twice the refresh interval (10 minutes).
const ORCH_BLURB_STALE_MS = 2 * 10 * 60_000

/** The blurb replaces .orb-line by default; hover or a pinned card reveals
 *  the narration underneath instead (app.css's .has-blurb/.orb-pinned rules
 *  do the actual swap). This only has to keep the text, the age and the
 *  busy state of the refresh button honest -- and, per the older-relay
 *  rule, do nothing that LOOKS like a blurb when `S.orchestrator` itself is
 *  absent rather than merely empty.
 *
 *  this is also the one place `orchestrator.busy` is read every time
 *  it can possibly change (the snapshot, the SSE `orchestrator` frame, and
 *  sendAsk's own optimistic busy toggles all call this), so it is the
 *  natural single call site for telling the presence swarm to glow/spin up
 *  while Syzygy is thinking. `window.MCS` may not exist yet (the swarm's ES
 *  module loads after this classic script) or the swarm may never become
 *  ready (no WebGL2) -- optional chaining makes both a silent no-op; the
 *  next busy change tries again. */
/** the stream-stall watchdog. A `claude -p` child stays alive after
 *  its last text frame (final bookkeeping, the terminal `result` frame), so
 *  the relay honestly reports `asking: true` while nothing more is coming.
 *  That reads as the sphere being stuck, so a pause of more than about three
 *  seconds after streamed text turns the thinking animation off.
 *  It is deliberately a CLIENT-side, display-only rule — the turn is
 *  not cancelled, the child is not killed, `busy` is untouched (so the ask
 *  queue still knows the slot is held), and a delta arriving later revives
 *  the animation. It only ever arms AFTER the first delta: the wait before
 *  any text is real thinking and must keep glowing. */
const ASK_STALL_MS = 3000
let askStalled = false
let lastDeltaAt = 0
let stallTimer = null

const endAskStall = () => {
  clearTimeout(stallTimer); stallTimer = null
  lastDeltaAt = 0
  if (askStalled) { askStalled = false; renderBlurb() }
}

const noteAskDelta = () => {
  lastDeltaAt = Date.now()
  const wasStalled = askStalled
  askStalled = false
  clearTimeout(stallTimer)
  stallTimer = setTimeout(() => {
    askStalled = true
    // Park the visible turn too: the transcript's trailing "…" is the same
    // claim as the glow and would otherwise contradict it.
    for (const t of S.orchTurns) if (t.streaming) t.streaming = false
    renderOrchTranscript()
    renderBlurb()
  }, ASK_STALL_MS)
  if (wasStalled) renderBlurb()
}

const renderBlurb = () => {
  const panel = document.querySelector('.orbpanel')
  const o = S.orchestrator
  const has = !!(o && o.blurb)
  // while the watchdog has a turn parked as stalled, the sphere stays
  // off no matter what the payload says — the child is still alive (so the
  // relay still reports asking:true) but it has stopped producing anything
  // anyone can see, and that does not read as "thinking".
  if (askStalled) { window.MCS?.setBusy?.(false); return }
  // `asking`, NOT `busy`: the shared slot is also taken by the after-reply
  // blurb, which is invisible work. Driving the sphere off `busy` left it
  // thinking for up to blurbTimeoutMs after the answer had already finished,
  // so the sphere lingered with nothing left to show for it. An older relay
  // sends no
  // `asking` key at all, so fall back to `busy` there rather than showing
  // no indicator whatsoever.
  window.MCS?.setBusy?.(o && 'asking' in o ? !!o.asking : !!o?.busy)
  MCX.toggle(panel, 'has-blurb', has)
  MCX.show($('orb-blurbline'), has)
  if (has) {
    MCX.setText($('orb-blurbtext'), o.blurb)
    const stale = Date.now() - (o.blurbAt || 0) > ORCH_BLURB_STALE_MS
    MCX.show($('orb-blurbage'), stale)
    if (stale) MCX.setText($('orb-blurbage'), '· ' + ago(o.blurbAt))
  }
  const btn = $('orb-blurbrefresh')
  MCX.toggle(btn, 'busy', !!o?.busy)
  btn.disabled = !!o?.busy
}
$('orb-blurbrefresh').addEventListener('click', async () => {
  if (S.orchestrator?.busy) return
  const r = await post('/api/orchestrator/blurb/refresh', {})
  if (!r.ok) toast('Syzygy: ' + (r.error || 'could not refresh the summary'), { kind: 'warn' })
})

/** bundleContext (orchestrator.mjs) shows the model each session's NAME,
 *  never its raw id -- so a proposed action's `from`/`to` verified live to
 *  come back holding the display name, not the id `/api/link` and
 *  `/api/command` actually key sessions by. Resolves a name to its live
 *  session's id when `ref` is not already a known id; passes anything else
 *  through unchanged so a genuine miss still surfaces the server's own
 *  "unknown session" honestly rather than being masked here. */
const resolveSessionRef = (ref) => {
  if (S.sessions.some((s) => s.id === ref)) return ref
  return S.sessions.find((s) => s.name === ref)?.id ?? ref
}

/** Shortens a path for a button face: the last two segments, which is
 *  enough to tell two worktrees apart without the button wrapping. */
const shortPath = (p) => String(p || '').split('/').filter(Boolean).slice(-2).join('/')

/** One action button per proposed action (/: never applied without
 *  a click). Rebuilt in full on every render rather than routed through MCX --
 *  unlike the turn cards above it, this list is set ONCE per turn (when
 *  `done` arrives) and never churns again afterward beyond a click marking
 *  one applied, so there is no hover/focus state here worth the extra
 *  bookkeeping MCX exists to preserve.
 *
 *  Every apply path is an endpoint that ALREADY existed, and deliberately so
 *  -- `spawn` in particular goes through /api/spawn, which is canvas.mjs's
 *  spawnSession: argv array, prompt last behind `--`, childEnv(), the
 *  relay's own coordinates via --settings. None of that is reimplemented
 *  here, and none of it may be. */
const renderOrchActions = (box, t) => {
  box.textContent = ''
  for (const [i, a] of (t.actions || []).entries()) {
    const applied = t.appliedIdx?.has(i)
    const from = resolveSessionRef(a.from)
    const to = resolveSessionRef(a.to)
    // The instruction itself is already folded into `a.text` server-side
    // (parseActions), so this resolves the ref for the LABEL only -- the
    // tooltip shows exactly the text that will be enqueued.
    const reportTo = a.report_to ? resolveSessionRef(a.report_to) : null
    const label = a.kind === 'link' ? `link ${nameOf(from)} → ${nameOf(to)}`
      : a.kind === 'prompt' ? `send to ${nameOf(to)}` + (reportTo ? ` ↩ ${nameOf(reportTo)}` : '')
      : a.kind === 'dispatch' ? `queue brief: ${a.title}`
      : a.kind === 'spawn' ? `spawn ${a.name || 'collector'} in ${shortPath(a.cwd)}`
      : a.kind
    const btn = el('button', 'orchact' + (applied ? ' applied' : ''), (applied ? '✓ ' : '') + label)
    btn.type = 'button'
    btn.disabled = !!applied
    const detail = a.note || a.text || a.prompt || a.ask || ''
    if (detail) btn.title = detail
    if (!applied) {
      btn.addEventListener('click', async () => {
        // A spawn takes seconds and used to give NOTHING back until it
        // finished, so it was pressed three times and started three
        // real sessions. Disable and relabel FIRST, synchronously, before
        // the await -- an action that costs money must never look inert.
        // `inflight` also makes a repeat click impossible even if the
        // disable is somehow missed (a queued second event on the same
        // tick), because the money is spent by the time a retry would help.
        if (btn.dataset.inflight === '1') return
        btn.dataset.inflight = '1'
        btn.disabled = true
        const original = btn.textContent
        btn.textContent = '⋯ ' + label
        const restore = () => {
          delete btn.dataset.inflight
          btn.disabled = false
          btn.textContent = original
        }
        const r = a.kind === 'link'
          ? await post('/api/link', { from, to, note: a.note || '' })
          : a.kind === 'prompt'
            ? await post('/api/command', { targetId: to, verb: 'prompt', payload: { text: a.text || '' } })
          : a.kind === 'dispatch'
            ? await post('/api/request/create', {
                title: a.title, project: a.project || '', ask: a.ask || '', brief: a.brief || null,
              })
          : a.kind === 'spawn'
            ? await post('/api/spawn', {
                cwd: a.cwd, name: a.name || '', prompt: a.prompt,
                model: a.model, effort: a.effort,
              })
            : { error: 'unknown action kind' }
        if (r.error) { restore(); toast('could not apply: ' + r.error, { kind: 'warn' }); return }
        t.appliedIdx = t.appliedIdx || new Set()
        t.appliedIdx.add(i)
        renderOrchActions(box, t)
        toast('applied')
      })
    }
    box.appendChild(btn)
  }
}

/** while a reply is still streaming, the server has not yet had a
 *  chance to strip a trailing action fence (`parseActions` only runs once
 *  the whole turn is done) -- so the raw ```json block would otherwise
 *  flash into view character by character as the model types it, then
 *  vanish the instant `d.text` replaces it on `done`. Chosen fix: buffer a
 *  trailing UNCLOSED fence (an odd count of "```" markers) out of what is
 *  shown, holding everything from the last opening marker onward until it
 *  either closes (parity flips back to even -- a legitimate code sample the
 *  model included, shown in full) or the turn ends and the server's own
 *  cleaned text takes over entirely. Only ever trims a SUFFIX, so it never
 *  hides prose that came before the fence. */
const visibleWhileStreaming = (answer) => {
  // Actions always arrive as a TRAILING fenced json block, so hide it for the
  // whole of streaming -- closed as well as open. Hiding only an unclosed
  // fence (the odd-count rule below) meant that the moment the model wrote
  // its closing ``` the count went even and the raw JSON became visible, and
  // it then sat there until the server's `done` frame arrived with the
  // cleaned text -- seconds later, because the child lives on past its last
  // text frame -- so the raw payload sat in the transcript and only slowly
  // turned into a button.
  const open = answer.lastIndexOf('```json')
  if (open >= 0) return answer.slice(0, open).replace(/\s+$/, '')
  // Any other unclosed fence: hide the incomplete block, as before.
  const fences = (answer.match(/```/g) || []).length
  if (fences % 2 === 0) return answer
  return answer.slice(0, answer.lastIndexOf('```')).replace(/\s+$/, '')
}

/** The transcript, MCX-reconciled by turn id -- contains no input of its
 * own, so `#orb-ask` living outside it is never at risk from a
 *  re-render here. `.gone`, never removed and re-added: an empty transcript
 *  is the common case (nobody has asked anything yet this session).
 *
 *  the answer and the failure reason are now two SEPARATE
 *  elements, `.orcha` and `.orcherr` -- a turn that streamed a real, partial
 *  answer before hitting e.g. a budget cap keeps showing that answer, with
 *  the reason it stopped underneath it, rather than the error blanking the
 *  whole bubble. `.orcha` itself hides when there is neither real text nor
 *  an in-progress "…" ('s "a reply that is ONLY an action block must
 *  not render an empty bubble").
 *
 *  visibility is `has turns AND not dismissed` -- `S.orchTranscriptHidden`
 *  is a VIEW toggle only (the × below, and Escape), never a conversation
 *  action; the turns themselves are untouched by it. */
const renderOrchTranscript = () => {
  const box = $('orb-transcript')
  const visible = S.orchTurns.length > 0 && !S.orchTranscriptHidden
  MCX.show(box, visible)
  MCX.show($('orb-transcript-bar'), visible)
  MCX.reconcile(box, S.orchTurns, {
    key: (t) => t.id,
    create: () => {
      const card = el('div', 'orchturn')
      card.appendChild(el('div', 'orchq'))
      card.appendChild(el('div', 'orcha'))
      card.appendChild(el('div', 'orcherr'))
      card.appendChild(el('div', 'orchacts'))
      return card
    },
    update: (node, t) => {
      MCX.setText(node.querySelector('.orchq'), t.question)
      const shown = t.streaming ? visibleWhileStreaming(t.answer) : t.answer
      const answerEl = node.querySelector('.orcha')
      MCX.show(answerEl, t.streaming || shown.trim().length > 0)
      MCX.setText(answerEl, shown + (t.streaming ? ' …' : ''))
      // a queued turn is WAITING, not failed. It reads as a status
      // line rather than a ⚠, and carries no `errored` class, because the
      // human did nothing wrong and nothing has been lost -- it goes out by
      // itself the moment the slot frees.
      const errEl = node.querySelector('.orcherr')
      MCX.show(errEl, !!t.error || !!t.queued)
      if (t.queued) MCX.setText(errEl, '⋯ queued — will send when Syzygy is free')
      else if (t.error) MCX.setText(errEl, '⚠ ' + t.error)
      MCX.toggle(node, 'streaming', !!t.streaming)
      MCX.toggle(node, 'queued', !!t.queued)
      MCX.toggle(node, 'errored', !!t.error && !t.queued)
      renderOrchActions(node.querySelector('.orchacts'), t)
    },
  })
}

$('orb-transcript-close').addEventListener('click', () => {
  S.orchTranscriptHidden = true
  renderOrchTranscript()
})
/** POST /api/orchestrator/clear -- a CONVERSATION action, distinct from the
 *  × above: it drops the stored `--resume` session id server-side so the
 *  next ask starts fresh, and clears the visible transcript to match (the
 *  old turns are from a conversation that no longer exists server-side). */
$('orb-transcript-new').addEventListener('click', async () => {
  const r = await post('/api/orchestrator/clear', {})
  if (r?.ok === false) { toast('Syzygy: could not start a new conversation', { kind: 'warn' }); return }
  S.orchTurns = []
  renderOrchTranscript()
  toast('started a new conversation with Syzygy')
})

/** Enter (with or without a modifier -- this is a single-line `<input>`, so
 *  there is no newline for a plain Enter to insert either way) sends;
 *  Escape blurs (see the window-level Escape chain below for the SECOND
 *  Escape, or one pressed while the field never had focus, which collapses
 *  the transcript). `stopPropagation` here keeps that window-level handler
 *  from ALSO firing on the SAME keystroke -- the same pattern
 *  `d-titleedit`'s own Escape handler uses. */
const sendAsk = async () => {
  const input = $('orb-ask')
  const text = input.value.trim()
  if (!text) return
  // NO client-side busy guard. The server is the only thing that can
  // arbitrate the shared slot: `ask()` PREEMPTS an in-flight blurb and
  // 409s only behind another real ask. A guard here refused to send while the
  // invisible after-reply blurb held the slot, so the preemption it exists to
  // trigger could never run and the pane just showed "still answering" for a
  // turn they could not see. A genuine 409 comes back through the `!r.ok`
  // path below, which keeps the echoed prompt and attaches the reason to it.
  input.value = ''
  // echo the prompt into the transcript IMMEDIATELY, optimistically,
  // before the request has even landed -- the old code waited for the
  // first SSE frame to create the turn, which is exactly why a prompt sat
  // invisible until the whole thing finished or errored. `pending`/
  // `serverId: null` marks it as not yet claimed by a real server turn id;
  // the SSE handler below finds and claims this SAME object (never a
  // second, duplicate turn) the instant the server's first frame arrives.
  const turn = {
    id: 'pending-' + Math.random().toString(36).slice(2), serverId: null, pending: true,
    question: text, answer: '', streaming: true, actions: [], rejected: [], error: null,
  }
  S.orchTurns = [...S.orchTurns, turn].slice(-20)
  S.orchTranscriptHidden = false
  renderOrchTranscript()
  S.orchestrator = { blurb: '', blurbAt: 0, ...(S.orchestrator || {}), busy: true, asking: true }
  renderBlurb()
  const r = await post('/api/orchestrator/ask', { text })
  if (!r.ok) {
    // a turn refused because something else holds the slot is
    // QUEUED, never dropped. It was previously shown as an error and then
    // forgotten, so a message typed at the wrong moment was gone for good
    // with no way to retry it but retyping. It keeps its place in the
    // transcript and is marked queued; `drainAskQueue` re-sends it the
    // moment busy clears. Any OTHER failure (503, network) still surfaces
    // as an error on the echoed prompt -- those are not worth retrying
    // blindly, and a silent retry loop against a dead relay is worse than
    // an honest failure.
    if (isBusyRefusal(r.error)) {
      turn.pending = false
      turn.streaming = false
      turn.queued = true
      askQueue.push({ turn, text })
      renderOrchTranscript()
      return
    }
    turn.pending = false
    turn.streaming = false
    turn.error = r.error || 'could not ask'
    renderOrchTranscript()
    toast('Syzygy: ' + (r.error || 'could not ask'), { kind: 'warn' })
    S.orchestrator = { ...(S.orchestrator || {}), busy: false, asking: false }
    renderBlurb()
  }
}

/** A 409 from `ask()` -- the only refusal worth holding onto, since it means
 *  "later would work". Matched on the message the relay actually sends. */
const isBusyRefusal = (err) => typeof err === 'string' && /already busy with a turn|^busy$/i.test(err)

/** Queued turns, oldest first. Drained one at a time: the server still only
 *  runs one ask at a time, so releasing them all at once would just make
 *  every one but the first 409 again. */
const askQueue = []
let draining = false

const drainAskQueue = async () => {
  if (draining || !askQueue.length) return
  if (S.orchestrator?.busy) return
  draining = true
  try {
    while (askQueue.length && !S.orchestrator?.busy) {
      const next = askQueue[0]
      const r = await post('/api/orchestrator/ask', { text: next.text })
      if (!r.ok) {
        // Still busy -- leave it at the head of the queue and wait for the
        // next busy:false. Anything else is a real failure: surface it on
        // the turn and drop it from the queue rather than spinning.
        if (isBusyRefusal(r.error)) break
        askQueue.shift()
        next.turn.queued = false
        next.turn.error = r.error || 'could not ask'
        renderOrchTranscript()
        continue
      }
      askQueue.shift()
      next.turn.queued = false
      next.turn.pending = true
      next.turn.streaming = true
      next.turn.serverId = null
      renderOrchTranscript()
      S.orchestrator = { blurb: '', blurbAt: 0, ...(S.orchestrator || {}), busy: true, asking: true }
      renderBlurb()
    }
  } finally { draining = false }
}
$('orb-ask').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); void sendAsk() }
  else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); ev.target.blur() }
})

// ====================================================================== SSE
const connect = () => {
  const src = new EventSource('/api/stream')
  const pill = $('conn')
  pill.dataset.tip = `Connecting\nReaching the relay at ${location.origin}…`
  src.addEventListener('open', () => {
    S.connected = true
    S.connectedAt = Date.now()
    pill.className = 'pill ok'; pill.lastElementChild.textContent = 'live'
    pill.dataset.tip = `Live\nSubscribed to the relay's event stream at ${location.origin}.\n`
      + 'Sessions, events, questions and project scans all arrive over this one connection.'
  })
  src.addEventListener('error', () => {
    S.connected = false
    S.connectedAt = null
    pill.className = 'pill down'; pill.lastElementChild.textContent = 'reconnecting'
    pill.dataset.tip = `Reconnecting\nThe relay at ${location.origin} stopped answering.\n`
      + 'The browser retries on its own; nothing here needs a reload. Numbers on screen are the last ones received.'
    MCD.onDisconnect()
  })
  src.addEventListener('snapshot', (m) => {
    const d = JSON.parse(m.data)
    S.sessions = d.sessions; S.events = d.events; S.questions = d.questions
    S.approvals = d.approvals; S.links = d.links
    S.viewers = d.viewers ?? 1
    S.projects = d.projects ?? []
    MCP.render()
    S.dispatch = d.dispatch ?? { requests: [] }
    S.steering = d.steering ?? { custom: [] }
    // The bootstrap renderSteer() call ran before the stream connected, against
    // the default empty list -- a page load (or a reconnect) is exactly when a
    // custom button already on disk needs to appear.
    renderSteer(); syncArmed()
    S.canvas = d.canvas ?? S.canvas
    // snapshot()'s shape (relay.mjs) differs on purpose from the `usage` SSE
    // event's below: snapshot carries `usage`/`usageHistory`/`afterReset.queue`
    // as three top-level fields (see relay.mjs's snapshot() comment), while
    // the `usage` event and GET /api/usage both carry the bundled
    // {usage, history, queue} shape defines for those two.
    S.usage = d.usage ?? null
    S.usageHistory = d.usageHistory ?? []
    S.afterReset = d.afterReset ?? { queue: [] }
    S.voice = d.voice ?? S.voice
    S.hud = d.hud ?? S.hud
    // Whether a password is configured (and not SZG_PANE_PASSWORD_DISABLED)
    // doesn't change over a connection's lifetime outside a relay restart, so
    // reading it only off the snapshot -- never the lighter deltas below --
    // is enough.
    S.auth = d.auth ?? { enabled: false }
    renderAuthSection()
    warnIfReadsAreOpen()
    // No `?? default` here on purpose (the older-relay rule, /): an
    // older relay sends no `orchestrator` key at all, and `d.orchestrator`
    // then reads `undefined`, which renderBlurb() already treats as "no
    // blurb" without needing a distinct sentinel.
    S.orchestrator = d.orchestrator
    renderBlurb()
    if (!S.focus && S.sessions.length) S.focus = bestFocus()
    renderAll()
    refreshPinnedLastMessage()
    renderVoiceSettings()
    renderHudSettings()
    MCV.refresh()
  })
  src.addEventListener('sessions', (m) => {
    S.sessions = JSON.parse(m.data)
    if (!S.sessions.find((s) => s.id === S.focus)) S.focus = bestFocus()
    renderCards(); renderTiles(); renderHeat(); recomputeMood(); renderPills(); MCC.render()
    refreshPinnedLastMessage()
  })
  src.addEventListener('events', (m) => {
    const incoming = JSON.parse(m.data)
    S.events = [...S.events, ...incoming].slice(-400)
    for (const e of incoming) firePulse(e.status === 'deny' ? 1.4 : 0.75)
    renderFeed(); recomputeMood()
  })
  src.addEventListener('questions', (m) => { S.questions = JSON.parse(m.data); renderInbox() })
  src.addEventListener('approvals', (m) => { S.approvals = JSON.parse(m.data); renderInbox() })
  src.addEventListener('links', (m) => { S.links = JSON.parse(m.data); layoutWires(); MCC.render() })
  src.addEventListener('dispatch', (m) => { S.dispatch = JSON.parse(m.data); MCD.render() })
  src.addEventListener('steering', (m) => { S.steering = JSON.parse(m.data); renderSteer(); syncArmed() })
  src.addEventListener('scope', (m) => { MCD.onScope(JSON.parse(m.data)) })
  src.addEventListener('projects', (m) => { S.projects = JSON.parse(m.data); MCP.render(); MCD.render() })
  src.addEventListener('canvas', (m) => { S.canvas = JSON.parse(m.data); MCC.render() })
  // Its own event, never the whole snapshot -- same discipline as `canvas`.
  // `MCV.refresh()` re-runs discovery immediately rather than waiting for an
  // unrelated DOM mutation, so a toggle in another tab removes or adds every
  // mic button here within one SSE round trip.
  src.addEventListener('voice', (m) => {
    S.voice = JSON.parse(m.data)
    renderVoiceSettings()
    MCV.refresh()
    renderModeline()
  })
  // Its own event, never the whole snapshot -- same discipline as `voice`.
  // Fires when this tab's own gear writes a pin, and when another tab (or
  // `just spinner`, or a hand edit) does -- so two open panes stay in sync.
  src.addEventListener('hud', (m) => { S.hud = JSON.parse(m.data); renderHudSettings() })
  src.addEventListener('viewers', (m) => { S.viewers = JSON.parse(m.data).viewers; renderPills() })
  // One event, two shapes (the transport scoping.mjs's own 'scope' event
  // already uses): a blurb update carries {blurb, blurbAt, busy} with no
  // `id`; an ask-turn frame carries {id, delta|done|error, text?, actions?}
  // and may ALSO carry `busy` (both ask() and refreshBlurb() broadcast
  // their own busy:true/false around the ONE shared concurrency slot -- see
  // orchestrator.mjs). Either half may be present alone or together, so both
  // branches below are unconditional on what the frame actually carries.
  //
  // orchestrator.busy is what drives the presence swarm's streams
  // look thinking indicator too (swarm-math.js's easeThinking) -- renderBlurb
  // runs on every S.orchestrator change (this handler, the snapshot, and
  // sendAsk's own optimistic busy toggles), so ONE call site there is enough;
  // see renderBlurb's own body for the actual MCS.setBusy call.
  src.addEventListener('orchestrator', (m) => {
    const d = JSON.parse(m.data)
    if ('busy' in d || 'blurb' in d) {
      S.orchestrator = { blurb: '', blurbAt: 0, busy: false, ...(S.orchestrator || {}), ...d }
      // A frame that only says busy:true/false never carries a stale
      // `blurb`/`blurbAt` to overwrite the real ones with -- `...d` above is
      // safe here because such a frame simply omits those two keys.
      renderBlurb()
      // the slot just freed -- send whatever was typed while
      // it was held. This is the ONLY drain trigger, so a queued turn can
      // never be released while an ask is still running.
      if (!S.orchestrator.busy) void drainAskQueue()
    }
    if (d.id) {
      // claim the optimistic turn sendAsk() already echoed into the
      // transcript, rather than creating a second, duplicate one -- there
      // is at most one pending, unclaimed turn at a time (the shared
      // concurrency slot allows only one ask in flight), so the FIRST frame
      // carrying a real server id binds to it and keeps its `id` (the MCX
      // key) stable for the rest of the turn's life.
      let t = S.orchTurns.find((x) => x.serverId === d.id)
      if (!t) {
        const pending = S.orchTurns.find((x) => x.pending && x.serverId == null)
        if (pending) { pending.serverId = d.id; pending.pending = false; t = pending }
      }
      if (!t) {
        // Defensive fallback only -- e.g. a page load that missed sendAsk's
        // own echo (a reload mid-turn). Still renders something rather than
        // silently dropping frames for a turn nothing here is tracking.
        t = { id: 'srv-' + d.id, serverId: d.id, question: '', answer: '', streaming: true, actions: [], rejected: [], error: null }
        S.orchTurns = [...S.orchTurns, t].slice(-20)
      }
      if (typeof d.delta === 'string') {
        t.answer += d.delta
        // a delta resets the stall watchdog below. It also REVIVES a
        // turn the watchdog already parked — the child can go quiet for a
        // while and then resume, and a turn that started streaming again
        // must look like it.
        t.streaming = true
        noteAskDelta()
      }
      // the server's own cleaned text (parseActions, with a parsed
      // action fence already stripped) replaces whatever raw text streamed
      // in via deltas above -- identical to it whenever no fence was found,
      // so this is a no-op for the common case, and sent on BOTH `done` and
      // `error` (an errored turn keeps whatever real text the model
      // produced before it stopped).
      if (typeof d.text === 'string') t.answer = d.text
      if (d.done) { t.streaming = false; t.actions = d.actions || []; t.rejected = d.rejected || [] }
      if (d.error) { t.streaming = false; t.error = d.error }
      if (d.done || d.error) endAskStall()
      renderOrchTranscript()
    }
  })
  // The relay only sends this on an actual change -- reading, history
  // ring, after-reset queue, or a threshold crossing -- so every arrival here
  // is real news, never a 15s heartbeat. `d.crossed` is the relay's own
  // crossings() output (relay.mjs's usageTick): app.js never recomputes it,
  // only fires for what it is told already happened.
  src.addEventListener('usage', (m) => {
    const d = JSON.parse(m.data)
    S.usage = d.usage
    S.usageHistory = d.history ?? []
    S.afterReset = { queue: d.queue ?? [] }
    renderTiles()
    for (const c of d.crossed ?? []) fireUsageAlert(c)
  })
}

/* Each of these is a number with no units and no context, which is fine until
   you wonder what it counts. The tooltips are where that lives -- and they are
   rebuilt with the numbers, so they can never drift from them. */
const renderPills = () => {
  $('c-board').textContent = String(S.sessions.length)
  const n = S.sessions.length
  const working = S.sessions.filter((x) => x.working).length
  const p = $('sesscount')
  p.className = 'pill' + (working ? ' busy' : n ? ' ok' : '')
  p.lastElementChild.textContent = n + (n === 1 ? ' session' : ' sessions')
  p.dataset.tip = n
    ? `Sessions\n${n} registered with the relay, `
      + (working ? `${working} working right now.` : 'none working right now.')
      + `\n${S.sessions.map((x) => '· ' + nameOf(x.id)).join('\n')}`
      + '\nOne drops off the board after about 90s of silence.'
    : 'Sessions\nNothing has reported in. Start a Claude Code session with the plugin installed and it appears here.'

  const v = $('viewers')
  v.className = 'pill' + (S.viewers > 1 ? ' ok' : '')
  v.lastElementChild.textContent = S.viewers + (S.viewers === 1 ? ' viewer' : ' viewers')
  v.dataset.tip = `Viewers\n${S.viewers} browser tab${S.viewers === 1 ? '' : 's'} watching this board`
    + (S.viewers > 1 ? ' — someone else has it open too.' : '.')
    + '\nCounted by the relay as live subscribers to its event stream.'
}

const renderAll = () => {
  renderCards(); renderTiles(); renderFeed(); renderHeat(); renderInbox(); recomputeMood(); renderPills(); MCC.render()
}

// ==================================================================== views
const setView = (name) => {
  S.view = name
  for (const n of document.querySelectorAll('.view')) n.classList.toggle('on', n.id === 'view-' + name)
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.view === name)
  MCR.setView(name)
  MCP.setView(name)
  MCD.setView(name)
  MCC.setView(name)
  // The board lives on the control tab now, and was display:none until this
  // moment, so every card measured zero. Rebuild it (which resizes the card
  // sparkline canvases) and re-lay the wires over it.
  if (name === 'control') { renderTiles(); renderCards() }
  // Same problem, same fix: the charts measured zero while the tab was hidden.
  if (name === 'telemetry') renderTiles()
}
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => setView(b.dataset.view))
addEventListener('keydown', (e) => {
  const map = { '1': 'control', '2': 'telemetry', '3': 'projects', '4': 'dispatch', '5': 'canvas' }
  if (map[e.key] && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) setView(map[e.key])
})

// ================================================================ mode line
/* The only place that says what the next click does. Every branch below is a
   state the interaction can actually be in -- if a state is reachable and has
   no sentence here, the feature is undiscoverable, which is the whole reason
   this exists. */
const KEY = (k) => `<kbd>${k}</kbd>`
/** The mode line is the only innerHTML in the steering path, and a custom
 *  button's label is text a user typed. Escaped, not sanitised: the label
 *  is never markup. */
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const renderModeline = () => {
  const box = $('modeline')
  // Voice takes precedence over everything else while it has something to
  // say -- listening, held outside a field, or transcribing -- and falls
  // through to the existing chain otherwise (of the voice-input plan).
  const voiceHtml = MCV.modeline() || ''
  if (voiceHtml) { box.innerHTML = voiceHtml; box.hidden = false; return }
  const over = S.peek ? S.sessions.find((x) => x.id === S.peek) : null
  // ESCAPED, like the steering label beside it. A session's name is not the
  // user's own text: it arrives on /api/register from whatever registered,
  // and the relay stores it unfiltered there (only /api/rename validates), so
  // this is the one place a name reaches innerHTML and the one place it can
  // be markup. Escaping is the whole fix -- a name is never markup.
  const overName = over ? escHtml(over.name || over.id.slice(0, 8)) : null
  const n = S.sessions.length
  const marked = S.marks.length
  let html = ''

  if (steerForm) {
    html = steerForm.goal
      ? `type the goal, then ${KEY('⌘')}${KEY('enter')} — the run arms next, and the session you click starts it · ${KEY('esc')} cancels`
      : `${steerForm.edit ? 'editing' : 'registering'} a steering button — ${KEY('⌘')}${KEY('enter')} saves · ${KEY('esc')} cancels`
  } else if (S.armed) {
    const what = `<b>${escHtml(S.armed.label)}</b>`
    const tail = marked ? ` · ${marked} marked · ${KEY('enter')} sends them · ${KEY('esc')} cancels`
                        : ` · ${KEY('esc')} cancels`
    if (over && S.mods.add) html = `${KEY('⌥')}click — mark <b>${overName}</b> for ${what}, without sending${tail}`
    else if (over) html = `click — send ${what} to <b>${overName}</b>${marked ? ` and ${marked} marked` : ''} · ${KEY('⌥')}click marks instead${tail}`
    else html = `${what} is armed — pick a session on the switchboard · ${KEY('⌥')}click marks several${tail}`
  } else if (S.mods.all) {
    html = n
      ? `${KEY('A')} — a steering button now sends to <b>all ${n} session${n === 1 ? '' : 's'}</b> at once`
      : `${KEY('A')} — broadcast, but no sessions are on the board`
  } else if (S.mods.add) {
    html = `${KEY('⌥')} — marks several sessions, once a steering button is armed`
  }

  box.innerHTML = html
  box.hidden = !html
}

/* A and Option, tracked as held state rather than read off each event: the
   mode line has to be right between clicks, not only during one. A key that
   goes down inside a text field is typing, not a modifier -- and `blur` clears
   everything, because a key released while the window is not focused never
   reaches us and the line would otherwise stick. */
const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')
addEventListener('keydown', (e) => {
  if (e.key === 'Alt') { S.mods.add = true; renderModeline(); return }
  if ((e.key === 'a' || e.key === 'A') && !typing() && !e.metaKey && !e.ctrlKey) {
    S.mods.all = true; renderModeline(); return
  }
  if (e.key === 'Enter' && S.armed && S.marks.length && !typing()) {
    const a = S.armed, ids = [...S.marks]
    disarm()
    void steerTo(ids, a.label, a.verb, a.payload)
  }
})
addEventListener('keyup', (e) => {
  if (e.key === 'Alt') { S.mods.add = false; renderModeline() }
  if (e.key === 'a' || e.key === 'A') { S.mods.all = false; renderModeline() }
})
addEventListener('blur', () => { S.mods.all = false; S.mods.add = false; renderModeline() })

// ================================================================ the rail
/* Two independent axes, both per-browser and both remembered: whether a rail
   section is folded shut, and how much of each tool call the feed prints.
   localStorage can throw (private windows, blocked site data) and can come
   back with anything, so every read is guarded and validated -- a bad value
   falls back to the default rather than leaving the rail in a state no button
   can get it out of. */
const FOLD_KEY = 'szg.rail.folds'
const DENSITY_KEY = 'szg.feed.density'
const DENSITIES = ['detail', 'compact', 'dense']

const readFolds = () => {
  try {
    const v = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}
const writeFolds = (v) => { try { localStorage.setItem(FOLD_KEY, JSON.stringify(v)) } catch {} }

const SECTION = { feed: 'sec-feed', inbox: 'sec-inbox', steer: 'sec-steer' }
const applyFolds = () => {
  const folds = readFolds()
  for (const [name, id] of Object.entries(SECTION)) {
    const panel = $(id)
    if (!panel) continue
    // The markup carries the default, so a key that was never written keeps it.
    const shut = name in folds ? !!folds[name] : panel.classList.contains('collapsed')
    panel.classList.toggle('collapsed', shut)
    panel.querySelector('.phead.fold')?.setAttribute('aria-expanded', String(!shut))
  }
}
for (const head of document.querySelectorAll('.phead.fold')) {
  head.addEventListener('click', () => {
    const name = head.dataset.fold
    const panel = head.closest('.panel')
    const shut = !panel.classList.contains('collapsed')
    panel.classList.toggle('collapsed', shut)
    head.setAttribute('aria-expanded', String(!shut))
    writeFolds({ ...readFolds(), [name]: shut })
    // Opening the feed changes how much room the board has beside it only in
    // the stacked layout, but the wires are cheap to re-lay and wrong if we
    // don't.
    layoutWires()
  })
}

// `dense` by default. The feed is a glance surface -- what
// the session is touching, not a transcript -- and at `compact` a busy session
// pushed everything else in the rail off the bottom. A stored preference still
// wins, so anyone who has ever pressed the button keeps their own choice; this
// only changes what a browser that has never been told sees.
const DEFAULT_DENSITY = 'dense'
const readDensity = () => {
  try {
    const v = localStorage.getItem(DENSITY_KEY)
    return DENSITIES.includes(v) ? v : DEFAULT_DENSITY
  } catch { return DEFAULT_DENSITY }
}
const applyDensity = (d) => {
  const feed = $('sec-feed')
  feed.classList.remove(...DENSITIES)
  feed.classList.add(d)
  $('feed-density').textContent = d
}
$('feed-density').addEventListener('click', () => {
  const next = DENSITIES[(DENSITIES.indexOf(readDensity()) + 1) % DENSITIES.length]
  try { localStorage.setItem(DENSITY_KEY, next) } catch {}
  applyDensity(next)
})
applyFolds()
applyDensity(readDensity())

// ---- usage window: the notify toggle ----------------------------
// Off by default, on only once the bell is clicked -- never asked on
// load, which is the one hard rule here. `Notification.requestPermission()`
// is a no-op outside a user gesture in most browsers anyway, so asking
// anywhere else would silently fail as well as break that rule.
const USAGE_NOTIFY_KEY = 'szg.usage.notify'
const WINDOW_LABEL = { fiveHour: '5-hour', sevenDay: '7-day' }
const usageNotifyEnabled = () => {
  try { return localStorage.getItem(USAGE_NOTIFY_KEY) === '1' } catch { return false }
}
const applyUsageNotifyButton = () => {
  const btn = $('usage-notify')
  const on = usageNotifyEnabled()
  btn.classList.toggle('on', on)
  btn.setAttribute('aria-pressed', String(on))
  btn.dataset.tip = on
    ? 'Usage alerts\nOn: a toast and a browser notification fire once when 5h or 7d usage crosses 85% then 95%. Click to turn off.'
    : 'Usage alerts\nOff by default. Click to turn on -- the browser asks for notification permission right here, never on its own.'
}
$('usage-notify').addEventListener('click', () => {
  const next = !usageNotifyEnabled()
  try { next ? localStorage.setItem(USAGE_NOTIFY_KEY, '1') : localStorage.removeItem(USAGE_NOTIFY_KEY) } catch {}
  if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }
  applyUsageNotifyButton()
})
applyUsageNotifyButton()

/** Fires once per crossing the relay already detected (usage.mjs's
 *  crossings(), run in relay.mjs -- this never recomputes it). Gated entirely
 *  on the one toggle above: off means neither channel fires, not just that
 *  permission was never asked. A `Notification` that fails (permission
 *  revoked after the toggle was turned on, a browser that lacks the API) is
 *  silent -- the toast still lands either way, so the crossing is never lost
 *  to a permission the user cannot see from here. */
const fireUsageAlert = ({ window, threshold }) => {
  if (!usageNotifyEnabled()) return
  const label = WINDOW_LABEL[window] || window
  const msg = `${label} usage just crossed ${threshold}%`
  toast(msg, { kind: 'warn', ms: 6000 })
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try { new Notification('Syzygy', { body: msg }) } catch {}
  }
}

// hud.tsx's own narrate() writes the one-line text status per turn, which is
// what the band shows and what the sphere's caption in the rail reads from. It
// has nothing to do with speech.

// ====================================================================== run
buildSwatches()
buildMarks()
applyMark((() => { try { return localStorage.getItem(MARK_KEY) } catch { return null } })())
buildCorners()
applyCorners((() => { try { return localStorage.getItem(CORNERS_KEY) } catch { return null } })())
wireSettings()
wireVoice()
renderVoiceSettings()
wireHud()
renderHudSettings()
wireAuthSection()

applyTheme((() => { try { return localStorage.getItem(THEME_KEY) } catch { return null } })())
MCR.attach({ S, steer, toast, el, compact, money, clockOf })
MCP.attach({ S, post, toast, el, ago })
MCD.attach({ S, post, toast, el, compact, ago })
MCC.attach({ S, post, toast, el, ago, openDrawer, openLinkDialog, needsOf, stoppedOf })
MCV.attach({ state: S, redrawModeline: renderModeline, toast })
renderSteer()
connect()

// swarm.js is a deferred ES module, so it evaluates after this classic script.
// Attach on the first frame instead, once. If the module never arrives or
// WebGL2 is unavailable, swarmReady() just stays false and frame() below
// renders nothing for the panel -- the shader or nothing, no fallback.
let swarmTried = false
const swarmReady = () => {
  if (!swarmTried && window.MCS) { swarmTried = true; window.MCS.attach({ S }) }
  return !!window.MCS?.ready
}

// The notice is conditional on the thing it describes, never on the feature
// being present. An unconditional version would tell you that you are exposed
// while a password stands in front of the pane -- a confident wrong answer,
// and worse than silence. It fires when reads really are open, which means
// exactly one case: SZG_PANE_PASSWORD_DISABLED, the documented opt-out. (A relay with no
// password CONFIGURED cannot get here at all -- the gate sends you to /setup
// before the deck ever loads.)
//
// Driven off the snapshot rather than a timer, because that is when the
// answer is actually known; the short delay lets the deck paint first, so the
// line arrives as a notice rather than as chrome. Said once per connection.
let openWarned = false
const warnIfReadsAreOpen = () => {
  if (openWarned || S.auth?.enabled) return
  openWarned = true
  setTimeout(() => toast(
    'Relay reads are not gated — SZG_PANE_PASSWORD_DISABLED is set, so anything that can reach the relay can read session data and project task files. Unset it and restart the relay to require a password.',
    { ms: 9000, kind: 'warn' },
  ), 900)
}
setInterval(() => {
  $('clock').textContent = clockOf(Date.now())
  // Wall clock, plus how long this tab has been attached -- which is the thing
  // you actually want when a number on screen looks stale.
  $('clock').dataset.tip = S.connectedAt
    ? `Clock\nLocal time. This tab has been attached to the relay for ${ago(S.connectedAt)}.`
    : 'Clock\nLocal time. This tab is not connected to the relay.'
}, 1000)
setInterval(() => { renderTiles(); renderCards(); renderBlurb() }, 4000)

// S.activity is a spike model on its own -- firePulse bumps it, this decays
// it -- so a session thinking through a long, tool-free generation decays
// straight to idle between calls and the panel goes calm exactly when it
// should be churning. The floor holds it up while any session is genuinely
// working (see genuinelyWorking above); tool-call spikes still ride on top
// of it toward 1. 0.4 is comfortably past the swarm's sqrt(x) shaping knee
// (sqrt(0.4) ≈ 0.63) without sitting at the same level a real burst
// reaches, so a burst still reads as more than steady thinking.
//
// S.activity is SHARED, GLOBAL state -- see its declaration above. The swarm
// is its only consumer.
const ACTIVITY_FLOOR = 0.4

const frame = (t) => {
  S.activity *= 0.972
  // Any session, not just the focused one: firePulse's spikes are already
  // global (it fires on every incoming event, whichever session it came
  // from -- see the `events` SSE handler above), so the floor keeps that
  // same scope rather than narrowing to what happens to be on screen.
  if (S.sessions.some(genuinelyWorking)) S.activity = Math.max(S.activity, ACTIVITY_FLOOR)
  if (S.view === 'control' && swarmReady()) window.MCS.frame(t)
  MCR.frame(t)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
