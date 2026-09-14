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
  // The Findings panel; see findings.js. Empty is exactly what a relay
  // predating the `findings` snapshot field looks like too, same reasoning
  // as `voice`/`hud` below.
  findings: [],
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
  // `orchTurns` and `orchTranscriptHidden` are client-only: the snapshot
  // carries no turns, only the SSE frames that build them up turn by turn and
  // the one fetch of the current thread after a snapshot (cmdbar.js). A
  // turn's own `pending`/`serverId` is how the ask engine's optimistic echo
  // and the SSE frame that later carries the real turn id find each other
  // without duplicating.
  // `orchTranscriptHidden` is a VIEW toggle only -- dismissing the
  // panel never touches the conversation itself or `S.orchTurns`; that is
  // what makes it different from POST /api/orchestrator/clear.
  orchestrator: undefined,
  orchTurns: [],
  orchTranscriptHidden: false,
  // The persisted conversations (cmdbar.js). `orchThreads` is the payload's
  // bounded header list -- never the turns -- and `orchThreadId` is which one
  // both surfaces are showing. An older relay sends neither, which reads as
  // an empty switcher rather than as a throw.
  orchThreads: [],
  orchThreadId: null,
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
                          // cancels it -- MCW.open runs on every payload.
  pointer: { x: 0.5, y: 0.5 },
  focus: null,            // session id shown in the tiles/charts
  connected: false,
  pasteboard: [],         // stashed prompts; absent on a relay that predates them
  favourites: [],         // favourite session names; absent on a relay that predates them
  chains: {},             // { [sessionId]: compact chain }; see chain.js -- {} is
                          // exactly what a relay predating this feature looks like too
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

/* Corner style: sharp (the deck's original chamfer) or soft (the default,
   app.css). One attribute on <html>, same mechanism as applyTheme --
   [data-corners] rather than [data-theme], persisted per browser under its own
   key. app.css carries the soft VALUES on bare :root, so the only thing this
   needs to guarantee is that a stored 'sharp' preference lands before first
   paint, the same guarantee applyTheme already gives THEME_KEY -- see the call
   beside applyTheme's own at the bottom of this file.

   A third style, 'space', was dropped and
   its tokens are out of app.css. THE MIGRATION IS THIS MAP AND NOTHING ELSE:
   applyCorners resolves any name not in CORNERS to 'soft' and then writes the
   resolved value back under CORNERS_KEY, so a browser holding "space" lands on
   soft on its first load after the merge, once, silently. Do not add an
   `if (stored === 'space')` branch -- it would duplicate a rule this function
   already enforces for every unknown value, and would be a second thing to
   delete later. */
const CORNERS = { sharp: 'Sharp', soft: 'Soft' }
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
  // Who this session is working for, when a peer's ask put it here. Built once
  // and hidden with MCX.show, never added and removed -- this card is reused.
  card.appendChild(el('span', 'peerchip'))
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
  // The same fact at card scale. The chip is an 8.5px label in a bottom
  // corner -- readable when you are looking at one card, invisible when you
  // are scanning twenty -- so the CARD carries the state as one attribute and
  // CSS draws it. `none` is a real value, not a removed attribute: `agents` is
  // an optional payload field, so an ABSENT attribute means "this pane is
  // drawing an older payload" while `none` means "this session has no
  // subagents", and those are different facts.
  //
  // An attribute, never className: this card is reconciled, not rebuilt, and
  // assigning className would wipe .colored/.needs/.stopped out from under
  // MCX. One attribute has exactly one value by construction.
  MCX.setAttr(card, 'data-agents', running ? 'running' : agents.length ? 'idle' : 'none')
  if (agents.length) {
    MCX.setText(chip, agents.length + (agents.length === 1 ? ' agent' : ' agents'))
    MCX.setAttr(chip, 'data-live', running ? '1' : '0')
    MCX.setAttr(chip, 'title', running
      ? `${running} of ${agents.length} subagent${agents.length === 1 ? '' : 's'} running`
      : `${agents.length} subagent${agents.length === 1 ? '' : 's'}, none running`)
  }
  // Which peer's ask put this session to work. The relay adds the key only to
  // a session that has one, so an older relay simply never shows the chip.
  const pchip = card.querySelector('.peerchip')
  const fp = typeof s.forPeer?.peer === 'string' ? s.forPeer : null
  MCX.show(pchip, !!fp)
  if (fp) {
    MCX.setText(pchip, 'for ' + fp.peer)
    MCX.setAttr(pchip, 'title', 'working on an ask from the peer ' + fp.peer)
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
      if (!moved) { if (S.armed) armedClick(from, ev.altKey); else MCW.open(from) }
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

MCE.on('sessions', (d) => {
  S.sessions = d
  if (!S.sessions.find((s) => s.id === S.focus)) S.focus = bestFocus()
  renderCards(); renderTiles(); renderHeat(); recomputeMood(); renderPills(); MCC.render()
  MCW.refreshLastMessage()
})
MCE.on('links', (d) => { S.links = d; layoutWires(); MCC.render() })

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
  // The standing state, on the row it governs, so an armed fleet is visible
  // from the control view without opening Telemetry.
  const r = S.afterReset?.resume ?? null
  if (r?.armed) {
    const both = (r.windows || []).includes('sevenDay')
    const sub = $('s-usage-5h')
    sub.textContent = sub.textContent + (both ? ' · armed · 5h+7d' : ' · armed')
    $('t-usage-5h').dataset.tip += '\nLimit resume is armed: a session this window freezes is prompted to carry on at the reset.'
  }
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
  renderCreateForm()
  renderNight()
  renderResume()
}

/** A queue entry's state as its chip reads it. `pending` reads as `armed`
 *  because that is what the entry is: waiting on a reset, not on anyone. */
const AR_STATE_LABEL = { pending: 'armed', fired: 'fired', failed: 'failed', cancelled: 'cancelled' }
const AR_STATE_CHIP = { pending: 'armed', fired: 'fired', failed: 'err', cancelled: 'deny' }
/** Payload keys only the relay writes. It deletes them from every POST
 *  itself; stripping them here too keeps a duplicate's request honest about
 *  what it is asking for, while the relay's own strip is what keeps it safe. */
const AR_RELAY_KEYS = ['auto', 'spawn', 'skipped', 'stoppedAt', 'stopReason', 'episode', 'reason']

/** ⌥-click on a row: the same window, kind, target and payload, re-armed
 *  against the CURRENT boundary through the ordinary create route. */
const duplicateEntry = async (e) => {
  const payload = { ...(e.payload || {}) }
  for (const k of AR_RELAY_KEYS) delete payload[k]
  const r = await post('/api/after-reset', { window: e.window, kind: e.kind, target: e.target, payload })
  if (r.error) { toast(r.error, { ms: 6000, kind: 'warn' }); return }
  toast(`duplicated — armed for the next ${WINDOW_LABEL[e.window] || e.window} reset`)
}

/** The after-reset queue's list: one card per entry, a remove
 *  button on each. Removing a PENDING entry cancels it (relay.mjs's
 *  afterReset.cancel -- the store's own history, not a delete) and removing
 *  an already-settled one clears it away, so this button never needs two
 *  different labels for the two cases.
 *
 *  A REBUILD on every render, not a keyed reconcile: it holds no inputs, so
 *  there is nothing a rebuild could take out from under the user. The list
 *  element itself persists, which is what lets `.dupmode` live on it. */
const renderUsageQueue = () => {
  const box = $('usage-queue'); box.textContent = ''
  const queue = S.afterReset?.queue ?? []
  $('c-usage-queue').textContent = String(queue.length)
  if (!queue.length) { box.appendChild(el('div', 'empty', 'Nothing queued.')); return }
  for (const e of queue) {
    const p = e.payload || {}
    const row = el('div', 'aritem')
    row.classList.add('st-' + e.state)
    const from = el('div', 'from', `${WINDOW_LABEL[e.window] || e.window} · ${e.kind}`)
    const chip = el('span', 'chip', AR_STATE_LABEL[e.state] || e.state)
    if (AR_STATE_CHIP[e.state]) chip.classList.add(AR_STATE_CHIP[e.state])
    from.appendChild(chip)
    // Its own chip, not a variant of the state chip: "the relay chose this"
    // has to be visible at a glance on a row that is also armed or fired.
    if (p.auto) from.appendChild(el('span', 'chip auto', 'auto-armed'))
    from.appendChild(el('span', 'ardup', '⌥-click duplicates'))
    row.appendChild(from)
    const detail = e.kind === 'prompt' ? (p.text || '(no prompt text)')
      : e.kind === 'plan' ? (p.planTitle || p.planName || e.target || '(no plan)')
      : e.kind === 'resume' ? `${p.sessionName || e.target || '(no session)'} — ${p.reason || 'resumed'}`
      : e.kind === 'spawn' ? (p.prompt || '(no brief)')
      : `ids: ${(p.ids || []).join(', ') || '(none)'}`
    row.appendChild(el('div', 'q', detail))
    // `skipped` is written only when some ids were not green-lit, so its
    // absence on a fired row means all of them were.
    if (e.kind === 'implement' && Array.isArray(p.skipped) && p.skipped.length) {
      const m = (p.ids || []).length
      row.appendChild(el('div', 'arline', `${Math.max(0, m - p.skipped.length)} of ${m} green-lit · skipped ${p.skipped.join(', ')}`))
    }
    if ((e.kind === 'plan' || e.kind === 'spawn') && p.spawn) row.appendChild(spawnLine(p.spawn))
    // Verbatim: a summary of a failure is a second, weaker account of it.
    if (e.error) row.appendChild(el('div', 'arerr', e.error))
    if (p.stopReason) row.appendChild(el('div', 'arerr', `stopped — ${p.stopReason}`))
    const rm = el('button', 'btn no', 'remove')
    rm.onclick = () => post('/api/after-reset/delete', { id: e.id }).then((r) => { if (r.error) toast('remove failed: ' + r.error) })
    row.appendChild(rm)
    row.addEventListener('click', (ev) => {
      if (!ev.altKey || ev.target.closest('button')) return
      ev.preventDefault()
      void duplicateEntry(e)
    })
    box.appendChild(row)
  }
}

/** A fired plan's session: its name, its branch, and its live state read off
 *  the roster by shortId. `waiting` carries the reason, because a night run
 *  parked on a question is the thing worth seeing in the morning. */
const spawnLine = (sp) => {
  const line = el('div', 'arline')
  const s = sp.shortId ? S.sessions.find((x) => x.shortId === sp.shortId) : null
  const name = sp.name || sp.shortId || 'session'
  if (s) {
    const b = el('button', 'arsess', name); b.type = 'button'
    b.onclick = () => MCW.open(s.id)
    line.appendChild(b)
  } else {
    line.appendChild(el('span', null, name))
  }
  if (sp.branch) line.appendChild(el('span', null, sp.branch))
  const state = !s ? 'not live' : s.waiting ? `waiting · ${s.waitingFor || 'no reason reported'}` : s.working ? 'working' : 'idle'
  line.appendChild(el('span', s?.waiting ? 'waiting' : null, state))
  return line
}

// Holding ⌥ paints the duplicate affordance on every queue row. Cleared on
// blur and on a tab switch, since a keyup that happens elsewhere never
// arrives here and the list would otherwise stay in duplicate mode.
const setDupMode = (on) => {
  $('usage-queue').classList.toggle('dupmode', on)
  $('ar-disrupted').classList.toggle('dupmode', on)
}
addEventListener('keydown', (ev) => { if (ev.key === 'Alt') setDupMode(true) })
addEventListener('keyup', (ev) => { if (ev.key === 'Alt') setDupMode(false) })
addEventListener('blur', () => setDupMode(false))
document.addEventListener('visibilitychange', () => setDupMode(false))

// ------------------------------------------------ queue work: the create form
/* The form's markup is static in index.html and wired once below. The panel
   re-renders every few seconds, so a refill happens only when a control's
   source data actually changed, and never to a control that has focus. A
   control the user has changed is refilled only if their choice survives the
   refill; otherwise it is left exactly as they set it. */
const AR = {
  kind: 'prompt', window: 'fiveHour',
  keys: {},            // control id -> JSON key of the data it was last filled from
  edited: new Set(),   // control ids the user has changed since their last fill
  plans: new Map(),    // plan <select> value -> the eligible plan it names, as last filled
  nightKey: null,      // JSON key of the night settings last written into the block
  statusKey: null,     // JSON key of the status line last drawn
}
const AR_FIELD = /^(INPUT|TEXTAREA|SELECT)$/
const AR_KIND_KEYS = { p: 'prompt', i: 'implement', l: 'plan', s: 'spawn' }

/** Refill a <select>. Returns true when it did, so a caller holding a lookup
 *  beside the options can swap that lookup in the same breath. */
const fillArSelect = (sel, options) => {
  const key = JSON.stringify(options)
  if (AR.keys[sel.id] === key || document.activeElement === sel) return false
  const prev = sel.value
  const survives = options.some((o) => o.value === prev)
  if (AR.edited.has(sel.id) && prev && !survives) return false
  sel.textContent = ''
  for (const o of options) { const n = el('option', null, o.label); n.value = o.value; sel.appendChild(n) }
  if (survives) sel.value = prev
  AR.keys[sel.id] = key
  return true
}

const fillArChecks = (rows) => {
  const list = $('ar-implement-list')
  const key = JSON.stringify(rows)
  if (AR.keys[list.id] === key || list.contains(document.activeElement)) return
  const ticked = new Set([...list.querySelectorAll('input:checked')].map((c) => c.value))
  if (AR.edited.has(list.id) && [...ticked].some((id) => !rows.some((r) => r.id === id))) return
  list.textContent = ''
  for (const r of rows) {
    const lab = el('label', 'archeck')
    const box = el('input'); box.type = 'checkbox'; box.value = r.id; box.checked = ticked.has(r.id)
    lab.appendChild(box); lab.appendChild(el('span', null, r.label))
    list.appendChild(lab)
  }
  AR.keys[list.id] = key
}

/** Fill the three kind panes. Every empty choice list is a sentence, never a
 *  blank control. Nothing is filled while the form is closed; opening it
 *  calls this straight away. */
const renderCreateForm = () => {
  if ($('ar-form').hidden) return

  const sessions = S.sessions.map((s) => ({ value: s.id, label: nameOf(s.id) }))
  fillArSelect($('ar-prompt-target'), sessions)
  $('ar-prompt-target').hidden = !sessions.length
  $('ar-prompt-none').hidden = sessions.length > 0

  // Exactly the requests the relay's implement path will act on: planned,
  // with a session, and that session registered here. Anything looser would
  // offer a green light the relay then skips.
  const live = new Set(S.sessions.map((s) => s.id))
  const reqs = (S.dispatch?.requests ?? [])
    .filter((r) => r.state === 'planned' && r.session?.sessionId && live.has(r.session.sessionId))
    .map((r) => ({ id: String(r.id), label: `${r.title} · ${r.slug} · ${nameOf(r.session.sessionId)}` }))
  fillArChecks(reqs)
  $('ar-implement-list').hidden = !reqs.length
  $('ar-implement-none').hidden = reqs.length > 0

  // The relay's own eligibility list, never a second rule computed here. A
  // relay with no `night` field predates plan entries altogether, and says so.
  const night = S.afterReset?.night ?? null
  const eligible = night?.eligible ?? []
  const planOpts = eligible.map((p) => ({ value: p.key, label: `${p.title || p.name} — ${p.project}` }))
  if (fillArSelect($('ar-plan-target'), planOpts)) AR.plans = new Map(eligible.map((p) => [p.key, p]))
  $('ar-plan-old').hidden = night != null
  $('ar-plan-none').hidden = night == null || eligible.length > 0
  $('ar-plan-target').hidden = !eligible.length
  $('ar-plan-budget-label').hidden = !eligible.length
  $('ar-plan-budget').placeholder = night ? `${night.budgetUsd} (night default)` : 'night default'
}

const setArKind = (kind) => {
  AR.kind = kind
  for (const b of $('ar-kind').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.kind === kind))
  for (const k of ['prompt', 'implement', 'plan', 'spawn']) $('ar-pane-' + k).hidden = k !== kind
}
const setArWindow = (w) => {
  AR.window = w
  for (const b of $('ar-window').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.window === w))
}
const openArForm = () => {
  $('ar-form').hidden = false
  $('ar-open').hidden = true
  renderCreateForm()
  // The form itself, not its first field, so the modal keys are live at once.
  $('ar-form').focus()
}
const closeArForm = () => {
  $('ar-form').hidden = true
  $('ar-open').hidden = false
  $('ar-open').focus()
}
const clearArForm = () => {
  $('ar-prompt-text').value = ''
  $('ar-plan-budget').value = ''
  $('ar-spawn-cwd').value = ''
  $('ar-spawn-prompt').value = ''
  $('ar-spawn-name').value = ''
  for (const c of $('ar-implement-list').querySelectorAll('input:checked')) c.checked = false
  AR.edited.clear()
}

/** Arm what the form describes. ⇧ fires it now, through the same function
 *  the scheduler calls; ⌥ keeps the form open with its values for queueing
 *  several in a row. The relay's error is shown verbatim, and the form stays
 *  open on any error so nothing typed is lost. */
const armAfterReset = async ({ shiftKey = false, altKey = false } = {}) => {
  const body = { window: AR.window, kind: AR.kind }
  if (AR.kind === 'prompt') {
    const target = $('ar-prompt-target').value
    const text = $('ar-prompt-text').value.trim()
    if (!target) { toast('no live session to prompt'); return }
    if (!text) { toast('write the prompt first'); return }
    body.target = target
    body.payload = { text }
  } else if (AR.kind === 'implement') {
    const ids = [...$('ar-implement-list').querySelectorAll('input:checked')].map((c) => c.value)
    if (!ids.length) { toast('tick at least one request to green-light'); return }
    body.payload = { ids }
  } else if (AR.kind === 'spawn') {
    const cwd = $('ar-spawn-cwd').value.trim()
    const prompt = $('ar-spawn-prompt').value.trim()
    if (!cwd) { toast('a new session needs a directory'); return }
    if (!prompt) { toast('write the brief first'); return }
    body.payload = { cwd, prompt, name: $('ar-spawn-name').value.trim() }
  } else {
    const plan = AR.plans.get($('ar-plan-target').value)
    if (!plan) { toast('no plan picked'); return }
    body.target = plan.rel
    body.payload = { mainRoot: plan.mainRoot, project: plan.project, planName: plan.name, planTitle: plan.title }
    const budget = $('ar-plan-budget').value.trim()
    if (budget) body.payload.budgetUsd = Number(budget)
  }
  if (shiftKey) body.now = true
  const btn = $('ar-arm'); btn.disabled = true
  const r = await post('/api/after-reset', body)
  btn.disabled = false
  if (r.error) { toast(r.error, { ms: 6000, kind: 'warn' }); return }
  if (r.entry?.state === 'failed') { toast(r.entry.error || 'failed', { ms: 6000, kind: 'warn' }); return }
  toast(shiftKey ? `fired — ${AR_STATE_LABEL[r.entry?.state] || r.entry?.state || 'sent'}` : `armed for the next ${WINDOW_LABEL[AR.window]} reset`)
  if (altKey) return
  clearArForm()
  closeArForm()
}

$('ar-open').addEventListener('click', openArForm)
$('ar-close').addEventListener('click', closeArForm)
$('ar-arm').addEventListener('click', (ev) => { void armAfterReset({ shiftKey: ev.shiftKey, altKey: ev.altKey }) })
for (const b of $('ar-kind').querySelectorAll('button')) b.addEventListener('click', () => setArKind(b.dataset.kind))
for (const b of $('ar-window').querySelectorAll('button')) b.addEventListener('click', () => setArWindow(b.dataset.window))
for (const id of ['ar-prompt-target', 'ar-prompt-text', 'ar-plan-target', 'ar-plan-budget', 'ar-spawn-cwd', 'ar-spawn-prompt', 'ar-spawn-name']) {
  $(id).addEventListener('input', () => AR.edited.add(id))
}
$('ar-implement-list').addEventListener('change', () => AR.edited.add('ar-implement-list'))

// The modal layer, on the form element rather than the document, so it is
// live only while focus is inside the form. Every handled key stops
// propagating: Escape must not also reach the page's Escape router, and Enter
// must not also reach the steering layer's.
$('ar-form').addEventListener('keydown', (ev) => {
  const t = ev.target
  const tag = t instanceof Element ? t.tagName : ''
  if (ev.key === 'Escape') {
    ev.preventDefault(); ev.stopPropagation()
    closeArForm()
    return
  }
  if (ev.key === 'Enter' && !ev.metaKey && !ev.ctrlKey) {
    // In a textarea ⇧Enter stays a line break: firing a prompt the instant
    // someone reaches for a new line would spend the window by accident.
    if (tag === 'TEXTAREA' && ev.shiftKey) return
    // The kind, window and close buttons keep their own Enter.
    if (tag === 'BUTTON' && t.id !== 'ar-arm') return
    ev.preventDefault(); ev.stopPropagation()
    void armAfterReset({ shiftKey: ev.shiftKey, altKey: ev.altKey })
    return
  }
  // Letters are typing inside a field: "plan" typed into the prompt box must
  // not switch the kind three times.
  if (AR_FIELD.test(tag) || ev.metaKey || ev.ctrlKey || ev.altKey) return
  const key = ev.key.toLowerCase()
  if (AR_KIND_KEYS[key]) {
    ev.preventDefault(); ev.stopPropagation()
    setArKind(AR_KIND_KEYS[key])
  } else if (key === 'w') {
    ev.preventDefault(); ev.stopPropagation()
    setArWindow(AR.window === 'fiveHour' ? 'sevenDay' : 'fiveHour')
  } else if (key === 'r') {
    ev.preventDefault(); ev.stopPropagation()
    void armResume({ shiftKey: ev.shiftKey })
  }
})

// ---------------------------------------------------------- queue work: night
const AR_NIGHT_CONTROLS = [
  { id: 'ar-night-enabled', field: 'enabled', read: (c) => c.checked, write: (c, n) => { c.checked = n.enabled === true } },
  { id: 'ar-night-start', field: 'start', read: (c) => c.value, write: (c, n) => { c.value = n.start ?? '' } },
  { id: 'ar-night-end', field: 'end', read: (c) => c.value, write: (c, n) => { c.value = n.end ?? '' } },
  { id: 'ar-night-budget', field: 'budgetUsd', read: (c) => (c.value === '' ? null : Number(c.value)), write: (c, n) => { c.value = n.budgetUsd ?? '' } },
  { id: 'ar-night-hours', field: 'maxHours', read: (c) => (c.value === '' ? null : Number(c.value)), write: (c, n) => { c.value = n.maxHours ?? '' } },
]

const hhmm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })

/** The night block. A relay with no `night` field predates night hours and the
 *  block says exactly that -- reading it as "off" would make "the feature did
 *  not land" and "the relay is older than the page" look identical. */
const renderNight = () => {
  $('ar-night').hidden = false
  const n = S.afterReset?.night ?? null
  $('ar-night-old').hidden = n != null
  $('ar-night-body').hidden = n == null
  $('ar-night-status').hidden = n == null
  if (!n) { $('ar-night-err').hidden = true; return }
  const key = JSON.stringify([n.enabled, n.start, n.end, n.budgetUsd, n.maxHours])
  if (AR.nightKey !== key) {
    let complete = true
    for (const c of AR_NIGHT_CONTROLS) {
      const node = $(c.id)
      if (document.activeElement === node || AR.edited.has(c.id)) { complete = false; continue }
      c.write(node, n)
    }
    if (complete) AR.nightKey = key
  }
  renderNightStatus(n)
}

/** One line, the relay's own account: armed, off, held with the relay's
 *  reason, or active. Nothing here decides anything. */
const renderNightStatus = (n) => {
  const armed = n.armed ? (S.afterReset?.queue ?? []).find((e) => e.id === n.armed) : null
  let text, cls
  if (armed) {
    const t = armed.armedResetsAt
    const title = armed.payload?.planTitle || armed.payload?.planName || armed.target
    text = `armed — ${title}` + (Number.isFinite(t) ? ` fires at ${hhmm(t)} · in ${until(t)}` : ' fires at the next reset')
    cls = 'armed'
  } else if (!n.enabled) {
    text = 'off'; cls = 'off'
  } else if (n.held) {
    text = `held: ${n.held}`; cls = 'held'
  } else {
    text = n.active ? 'active' : Number.isFinite(n.armsAt) ? `arms for the ${hhmm(n.armsAt)} reset` : 'active'
    cls = 'active'
  }
  const key = JSON.stringify([text, cls, armed?.id ?? null])
  if (AR.statusKey === key) return
  AR.statusKey = key
  const box = $('ar-night-status')
  box.textContent = ''
  box.classList.remove('armed', 'off', 'held', 'active')
  box.classList.add(cls)
  box.appendChild(el('span', null, text))
  if (armed) {
    const b = el('button', 'btn no', 'cancel'); b.type = 'button'
    b.onclick = () => post('/api/after-reset/delete', { id: armed.id }).then((r) => { if (r.error) toast('cancel failed: ' + r.error) })
    box.appendChild(b)
  }
}

/** True while the arm write is in flight, so a redraw leaves the settings
 *  pop's switch on what was clicked until the relay answers. */
let resumeToggling = false

/** The limit-resume block. A relay with no `resume` field predates the feature
 *  and the block says exactly that -- reading it as "disarmed" would make "the
 *  feature did not land" and "the relay is older than the page" identical. */
const renderResume = () => {
  $('ar-resume').hidden = false
  const r = S.afterReset?.resume ?? null
  $('ar-resume-old').hidden = r != null
  $('ar-resume-body').hidden = r == null
  $('ar-resume-status').hidden = r == null
  // The settings pop's switch follows the same field as the arm button. Left
  // alone while its own write is in flight, so it never flickers back to the
  // old value between the click and the relay's answer.
  const sw = $('resume-enable')
  $('resume-old').hidden = r != null
  if (!resumeToggling) {
    sw.checked = !!r?.armed
    sw.disabled = r == null
  }
  if (!r) { $('ar-disrupted').textContent = ''; $('c-ar-disrupted').textContent = '0'; return }
  $('ar-resume-arm').setAttribute('aria-pressed', String(!!r.armed))
  $('ar-resume-arm').textContent = r.armed ? 'armed' : 'arm'
  $('ar-resume-wins').textContent = (r.windows || []).map((w) => WINDOW_LABEL[w] || w).join(' + ')
  const box = $('ar-resume-status')
  box.textContent = ''
  box.classList.remove('armed', 'off', 'held', 'active')
  // Armed with no episode open is the ordinary resting state, not a refusal,
  // and a dark reading no longer holds anything: the clock proves the reset.
  if (!r.armed) { box.classList.add('off'); box.appendChild(el('span', null, 'off — sessions stopped by the limit stay stopped')) }
  else if (!r.episode) { box.classList.add('active'); box.appendChild(el('span', null, 'armed — watching for the limit')) }
  else if (r.held) { box.classList.add('held'); box.appendChild(el('span', null, `held: ${r.held}`)) }
  else { box.classList.add('armed'); box.appendChild(el('span', null, `the window is spent — resuming at ${hhmm(r.episode.resetsAt)}`)) }
  if (r.lastFire) box.appendChild(el('span', null, `last reset: ${r.lastFire.fired} resumed, ${r.lastFire.failed} failed`))
  renderDisrupted(r.disrupted ?? [])
}

/** One row per session the relay believes the limit stopped, with the sentence
 *  that admitted it -- a list with no reasoning on it is a list nobody can
 *  argue with. Rebuilt in full: it holds no input, so there is nothing a
 *  rebuild could take out from under the user, and the list element itself
 *  persists, which is what lets `.dupmode` live on it. */
const renderDisrupted = (rows) => {
  const box = $('ar-disrupted'); box.textContent = ''
  $('c-ar-disrupted').textContent = String(rows.length)
  if (!rows.length) { box.appendChild(el('div', 'empty', 'Nothing frozen by the limit.')); return }
  for (const row of rows) {
    const node = el('div', 'aritem')
    if (row.excluded) node.classList.add('st-cancelled')
    const head = el('div', 'from', row.name || row.id)
    if (row.excluded) head.appendChild(el('span', 'chip deny', 'excluded'))
    else if (!row.eligible) head.appendChild(el('span', 'chip fired', 'resumed'))
    head.appendChild(el('span', 'ardup', '⌥ excludes · ⇧ resumes now'))
    node.appendChild(head)
    node.appendChild(el('div', 'q', row.reason))
    node.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return
      if (ev.altKey) { ev.preventDefault(); void toggleExclude(row) }
      else if (ev.shiftKey) { ev.preventDefault(); void resumeNow(row) }
      else if (S.sessions.some((s) => s.id === row.id)) MCW.open(row.id)
    })
    box.appendChild(node)
  }
}

const resumeErr = (r) => {
  const err = $('ar-resume-err')
  if (r.error) { err.textContent = r.field ? `${r.field}: ${r.error}` : r.error; err.hidden = false; return true }
  err.hidden = true
  return false
}

const toggleExclude = async (row) => {
  const until = S.afterReset?.resume?.episode?.resetsAt ?? (Date.now() + 6 * 3600_000)
  const body = row.excluded ? { include: row.id } : { exclude: { id: row.id, name: row.name, until } }
  const r = await post('/api/resume', body)
  if (!resumeErr(r)) toast(row.excluded ? `${row.name || row.id} will be resumed` : `${row.name || row.id} excluded until the next limit`)
}

const resumeNow = async (row) => {
  const r = await post('/api/resume/fire', { id: row.id })
  if (!resumeErr(r)) toast(`resumed ${row.name || row.id}`)
}

/** click arms the 5-hour window; ⇧ arms the 7-day one beside it; ⌥ arms and
 *  excludes everyone frozen right now, so a standing arm can start from the
 *  NEXT limit rather than re-prompting sessions that froze hours ago. */
const armResume = async ({ shiftKey = false, altKey = false } = {}) => {
  const r0 = S.afterReset?.resume ?? null
  const armed = !(r0?.armed)
  const body = { armed, by: 'toggle' }
  if (armed && shiftKey) body.windows = ['fiveHour', 'sevenDay']
  else if (armed) body.windows = ['fiveHour']
  resumeToggling = true
  $('resume-enable').disabled = true
  const r = await post('/api/resume', body)
  resumeToggling = false
  const failed = resumeErr(r)
  // The settings pop cannot see the Telemetry tab's error line, so it carries
  // its own copy of the same sentence.
  $('resume-setting-err').textContent = failed ? $('ar-resume-err').textContent : ''
  $('resume-setting-err').hidden = !failed
  // Both controls show what the relay holds, never what was clicked: a
  // refusal redraws them back, and a success adopts the relay's answer.
  if (!failed && r.resume && S.afterReset) S.afterReset.resume = r.resume
  renderResume()
  if (failed) return
  if (armed && altKey) {
    const until = r.resume?.episode?.resetsAt ?? (Date.now() + 6 * 3600_000)
    for (const row of r.resume?.disrupted ?? []) {
      await post('/api/resume', { exclude: { id: row.id, name: row.name, until } })
    }
    toast(r.resume?.episode ? 'armed, holding this window' : 'armed — no window is spent, so nothing was held')
    return
  }
  toast(armed ? `armed for ${(body.windows || []).map((w) => WINDOW_LABEL[w] || w).join(' + ')}` : 'disarmed')
}

$('ar-resume-arm').addEventListener('click', (ev) => {
  void armResume({ shiftKey: ev.shiftKey, altKey: ev.altKey })
})

// The settings pop's switch is the arm button's plain click, not a second
// write path. A switch already agreeing with the relay only redraws.
$('resume-enable').addEventListener('change', () => {
  if ($('resume-enable').checked === !!S.afterReset?.resume?.armed) { renderResume(); return }
  void armResume()
})

/** One field per POST. A 400 names its field, and the line under the block
 *  says which and why; nothing is kept locally, so a refused value simply
 *  never becomes the relay's. */
const postNight = async (c) => {
  const r = await post('/api/night', { [c.field]: c.read($(c.id)) })
  AR.edited.delete(c.id)
  const err = $('ar-night-err')
  if (r.error) { err.textContent = r.field ? `${r.field}: ${r.error}` : r.error; err.hidden = false; return }
  err.hidden = true
  if (r.night && S.afterReset) S.afterReset.night = r.night
  AR.nightKey = null
  renderNight()
}
for (const c of AR_NIGHT_CONTROLS) {
  const node = $(c.id)
  node.addEventListener('input', () => AR.edited.add(c.id))
  node.addEventListener('change', () => { void postNight(c) })
}

// The relay only sends this on an actual change -- reading, history
// ring, after-reset queue, or a threshold crossing -- so every arrival here
// is real news, never a 15s heartbeat. `d.crossed` is the relay's own
// crossings() output (relay.mjs's usageTick): app.js never recomputes it,
// only fires for what it is told already happened. A relay with no `night`
// field leaves it null, which the night block reads as "predates night hours".
MCE.on('usage', (d) => {
  S.usage = d.usage
  S.usageHistory = d.history ?? []
  S.afterReset = { queue: d.queue ?? [], night: d.night ?? null, resume: d.resume ?? null }
  renderTiles()
  for (const c of d.crossed ?? []) fireUsageAlert(c)
})

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

MCE.on('events', (d) => {
  const incoming = d
  S.events = [...S.events, ...incoming].slice(-400)
  for (const e of incoming) firePulse(e.status === 'deny' ? 1.4 : 0.75)
  renderFeed(); recomputeMood()
})

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

MCE.on('questions', (d) => { S.questions = d; renderInbox() })
MCE.on('approvals', (d) => { S.approvals = d; renderInbox() })

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

/** The broadcast the Findings panel exists to receive. Every clause is
 *  load-bearing: facts not judgements (the evaluator judges), the six kinds,
 *  the line evidence report_finding refuses without, and an explicit licence
 *  to report nothing -- a store padded with non-findings is worse than an
 *  empty one. */
const WRITE_FINDINGS_PROMPT = [
  "Pause and write down what you have learned that would change another session's work — not what you did, what surprised you.",
  '',
  'For each one, call the `report_finding` tool once:',
  '',
  '- `surprise` — one line, the fact itself. Not a judgement, not a recommendation, and never "we should".',
  '- `kind` — one of `constraint`, `drift`, `hazard`, `dead-code`, `duplicate`, `question`.',
  '- `touched` — the files or subsystems it came out of.',
  '- `evidence` — at least one `path:line`. A finding with no line number is refused, and rightly: somebody else has to be able to check it.',
  '',
  'Report facts only. Somebody with the whole picture does the judging, and your job is to give them something they can verify. **If nothing surprised you, report nothing and say so in one line** — an empty answer is a real answer here, and padding the store is worse than leaving it alone.',
].join('\n')

const STEER_BUTTONS = [
  prompt_('run tests', 'Run the test suite and report failures.'),
  prompt_('commit', 'Stage and commit the current work with a clear message.'),
  prompt_('review diff', 'Review the current diff for bugs and simplifications.'),
  prompt_('step back', 'Step back: are we solving the right problem, and is there a simpler way?'),
  prompt_('write findings', WRITE_FINDINGS_PROMPT),
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
/** ONE request, however many targets. The relay validates the whole set before
 *  it enqueues anything, so a partial fan-out is not a state that exists --
 *  and "queued", never "sent": a command sits in a Map until the target's own
 *  poll drains it. */
const steerTo = async (ids, label, verb, payload) => {
  if (!ids.length) return toast('no session to steer')
  const r = await post('/api/command', { targetIds: ids, verb, payload, label })
  if (r.error) return toast(`${label}: ${r.error}`, { kind: 'warn' })
  const who = r.n === 1 ? (r.queued[0]?.name || 'a session') : `${r.n} sessions`
  toast(`${label} → queued to ${who}`)
}

/** ⇧ and the held `A` both land here: no target step at all, and one code path
 *  so the two gestures cannot drift. The relay resolves "all" against its own
 *  live registry, so a card that expired between the render and the click
 *  cannot 404 the whole broadcast. */
const steerAll = async (label, verb, payload) => {
  const r = await post('/api/command', { all: true, verb, payload, label })
  if (r.error) return toast(`${label}: ${r.error}`, { kind: 'warn' })
  toast(`${label} → queued to all ${r.n} sessions`)
}

/* A subset is remembered by NAME, per button, per browser: session ids change
   on every restart, and a name is the stable handle claims-inherit.mjs and
   inheritPosition already build on. localStorage can throw and can come back
   with anything, so every read is guarded and a bad value is "nothing
   remembered" -- the same rule FOLD_KEY and DENSITY_KEY follow. */
const FLEET_KEY = (id) => 'szg.fleet.' + id
const fleetRemembered = (id) => {
  try {
    const v = JSON.parse(localStorage.getItem(FLEET_KEY(id)) || '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch { return [] }
}
const rememberFleet = (id, names) => {
  try { localStorage.setItem(FLEET_KEY(id), JSON.stringify(names.slice(0, 64))) } catch {}
}

/** Which live sessions a remembered name list pre-checks. A name matching TWO
 *  live sessions checks NEITHER -- claims-inherit.mjs's rule, applied where
 *  guessing means sending a prompt into a session nobody picked. */
const fleetPreselect = (names, sessions) => {
  const byName = new Map()
  for (const s of sessions) {
    const n = s.name || ''
    byName.set(n, byName.has(n) ? null : s.id)     // null marks an ambiguous name
  }
  const ids = [], ambiguous = [], missing = []
  for (const n of names) {
    if (!byName.has(n)) { missing.push(n); continue }
    const id = byName.get(n)
    if (id == null) ambiguous.push(n)
    else ids.push(id)
  }
  return { ids, ambiguous, missing }
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

/* The fleet picker. `cmd` is the steering command an option-click armed;
 * `null` when the modal is closed, which is what the esc chain and the mode
 * line test. Sending from here does NOT arm -- a subset has already been
 * chosen, and a second targeting step would be a trap. */
let fleetForm = null
const fleetModal = $('fleetform')
const FLEET_HINT = '<kbd>esc</kbd> cancels &middot; <kbd>&#8984;</kbd>/<kbd>ctrl</kbd> + <kbd>enter</kbd> sends'

const fleetCheckedBoxes = () => Array.from($('ff-list').querySelectorAll('input[type=checkbox]:checked'))
const fleetCheckedIds = () => fleetCheckedBoxes().map((cb) => cb.dataset.id)
const fleetCheckedNames = () => fleetCheckedBoxes().map((cb) => cb.dataset.name)

/** The live checked count, recomputed on every checkbox change and on
 *  all/none -- the title is the only place that count is shown. */
const updateFleetTitle = () => {
  if (!fleetForm) return
  setText($('ff-title'), `${fleetForm.cmd.label} → ${fleetCheckedIds().length} of ${S.sessions.length} sessions`)
}

const openFleetForm = (cmd) => {
  fleetForm = { cmd, restore: document.activeElement }
  const { ids, ambiguous, missing } = fleetPreselect(fleetRemembered(steerId(cmd)), S.sessions)
  MCX.reconcile($('ff-list'), S.sessions, {
    key: (s) => s.id,
    create: () => {
      const row = el('label', 'fleetrow')
      const cb = el('input')
      cb.type = 'checkbox'
      row.appendChild(cb)
      row.appendChild(el('span', 'fleetname'))
      row.appendChild(el('span', 'fleetproj'))
      row.appendChild(el('span', 'statedot'))
      return row
    },
    update: (row, s) => {
      const cb = row.querySelector('input')
      cb.dataset.id = s.id
      cb.dataset.name = s.name || ''
      // Rows persist in the list across opens, so a row reused from a prior
      // open still carries that button's checked state -- this callback only
      // runs at open time, so it must set the box unconditionally to reflect
      // this button's own remembered set rather than trusting `isNew`.
      cb.checked = ids.includes(s.id)
      cb.onchange = updateFleetTitle
      setText(row.querySelector('.fleetname'), s.name || s.id.slice(0, 8))
      // Sessions carry no `project` field: the display name, or the last
      // segment of its worktree root/cwd -- the same fallback the card uses.
      setText(row.querySelector('.fleetproj'), s.repo || (s.root || s.cwd || '').split('/').pop() || '')
      const dot = row.querySelector('.statedot')
      const state = sessionStateOf(s)
      MCX.setAttr(dot, 'data-state', state)
      MCX.setAttr(dot, 'title', 'presence: ' + state)
    },
  })
  // The ambiguity and missing counts go ahead of the key hints, and only
  // when there is something to say -- a clean remembered set says nothing.
  const bits = []
  if (ambiguous.length) bits.push(`${ambiguous.length} remembered name${ambiguous.length === 1 ? '' : 's'} match${ambiguous.length === 1 ? 'es' : ''} more than one session and ${ambiguous.length === 1 ? 'was' : 'were'} left unchecked`)
  if (missing.length) bits.push(`${missing.length} remembered name${missing.length === 1 ? '' : 's'} ${missing.length === 1 ? 'is' : 'are'} not on the board`)
  $('ff-note').innerHTML = [...bits, FLEET_HINT].join(' &middot; ')
  updateFleetTitle()
  fleetModal.hidden = false
  renderModeline()
}

const closeFleetForm = () => {
  if (!fleetForm) return
  const back = fleetForm.restore
  fleetForm = null
  fleetModal.hidden = true
  if (back?.isConnected && typeof back.focus === 'function') back.focus()
  renderModeline()
}

const submitFleetForm = () => {
  if (!fleetForm) return
  const { cmd } = fleetForm
  const ids = fleetCheckedIds()
  rememberFleet(steerId(cmd), fleetCheckedNames())
  closeFleetForm()
  void steerTo(ids, cmd.label, cmd.verb, cmd.payload)
}

$('ff-cancel').addEventListener('click', closeFleetForm)
$('ff-all').addEventListener('click', () => {
  for (const cb of $('ff-list').querySelectorAll('input[type=checkbox]')) cb.checked = true
  updateFleetTitle()
})
$('ff-none').addEventListener('click', () => {
  for (const cb of $('ff-list').querySelectorAll('input[type=checkbox]')) cb.checked = false
  updateFleetTitle()
})
$('ff-send').addEventListener('click', submitFleetForm)
fleetModal.addEventListener('mousedown', (ev) => { if (ev.target === fleetModal) closeFleetForm() })
fleetModal.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); submitFleetForm() }
})

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
      b.dataset.tip = (cmd.custom
        ? `${cmd.label}\n${tip}\n\nright-click to edit or delete`
        : `${cmd.label}\n${tip}`) + '\n\nshift-click — all sessions · option-click — pick a subset'
      b.onclick = (ev) => {
        // ⇧ — every live session, no target step. The custom-button editor
        // is on the context menu below: ⇧ belongs to the fleet on EVERY
        // button, and a gesture that means two things depending on which
        // button it lands on is a rule nobody retains.
        if (ev.shiftKey) {
          if (cmd.form === 'goal') return void toast('state the goal first', { kind: 'warn' })
          disarm()
          return void steerAll(cmd.label, cmd.verb, cmd.payload)
        }
        // ⌥ — the subset picker for this button, with its remembered set.
        if (ev.altKey) {
          if (cmd.form === 'goal') return void toast('state the goal first', { kind: 'warn' })
          return void openFleetForm(cmd)
        }
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
        if (S.mods.all) {          // A is "every session": the same path as ⇧.
          disarm()
          return void steerAll(cmd.label, cmd.verb, cmd.payload)
        }
        S.armed = S.armed && steerId(S.armed) === steerId(cmd) ? null : cmd
        if (!S.armed) S.marks = []
        syncArmed()
      }
      // Right-click (⌃-click on macOS) opens a custom button's editor. ⇧ is
      // the fleet's; contextmenu costs no modifier and both a mouse and the
      // keyboard can reach it.
      b.oncontextmenu = (ev) => {
        if (!cmd.custom) return
        ev.preventDefault()
        openSteerForm({ edit: cmd.custom })
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

MCE.on('steering', (d) => { S.steering = d; renderSteer(); syncArmed() })

// ============================================================ scope and keys
// The drawer itself lives in drawer.js (global MCW). What stays here is the
// rail's scope -- shared with the card-hover handlers in wireCardEvents -- and
// the page's Escape router, whose middle branches reach five things that are
// this file's alone.
/** Everything the rail's scope drives. One call so a hover can never move the
 *  metrics without also moving the feed, which would read as a bug. */
const rescope = () => { renderTiles(); renderFeed(); renderModeline() }

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  // A half-typed reply is the innermost thing of all. Escape steps out of the
  // field and leaves the drawer open; closing it here would discard what the
  // user had written, and the field is the one place in the drawer where esc
  // has something of its own to mean.
  if (MCW.escapeFromReply()) return
  // The link dialog is the innermost thing open, so esc answers that first and
  // leaves the drawer where it is.
  if (!$('settingspop').hidden) { closeSettings(); return }
  if (fleetForm) { closeFleetForm(); return }
  if (steerForm) { closeSteerForm(); return }
  if (pendingLink) { closeLinkDialog(); return }
  // An armed command is the innermost thing open after the dialog: esc should
  // put the pointer down before it starts closing panels.
  if (S.armed) { disarm(); return }
  // Budget mode is a lens over the whole page, entered from the rail's frame
  // chip. Leaving it moves nothing else, so it answers before any view closes.
  if (MCBG.mode() === 'budget') { MCBG.setMode('off'); return }
  // the SECOND Escape (or one pressed with the field never focused,
  // since `#orb-ask`'s own handler already stopped propagation on the
  // first) collapses the transcript -- a VIEW action, guarded on there
  // being something open at all so an already-closed transcript never eats
  // an Escape another view still needs.
  if (S.orchTurns.length > 0 && !S.orchTranscriptHidden) { S.orchTranscriptHidden = true; renderOrchTranscript(); return }
  S.linkFrom = null
  MCW.close()
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
 *  the ask engine's own optimistic busy toggles all call this), so it is the
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
    // Park the visible turn too: both transcripts' trailing "…" is the same
    // claim as the glow and would otherwise contradict it.
    for (const t of S.orchTurns) if (t.streaming) t.streaming = false
    MCQ.renderAll()
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
    // A drop goes to this turn's own peer. A turn with none renders a button
    // that cannot be pressed: never a guess, and never "the only peer", which
    // stops being true the moment a second one is paired.
    const dropPaths = Array.isArray(a.paths) ? a.paths : []
    const noPeer = a.kind === 'drop' && !t.peer
    // `a.model` reaches this label already validated (orchestrator.mjs's
    // parseActions drops a shaped-wrong one before it ever gets here), so
    // showing it needs no check of its own beyond "is it set".
    const modelTag = a.model ? ` · ${a.model}` : ''
    const label = a.kind === 'link' ? `link ${nameOf(from)} → ${nameOf(to)}`
      : a.kind === 'prompt' ? `send to ${nameOf(to)}` + (reportTo ? ` ↩ ${nameOf(reportTo)}` : '')
      : a.kind === 'dispatch' ? `queue brief: ${a.title}${modelTag}`
      : a.kind === 'spawn' ? `spawn ${a.name || 'collector'}${modelTag} in ${shortPath(a.cwd)}`
      : a.kind === 'arm_resume' ? (a.mode === 'disarm' ? 'disarm limit resume'
        : a.mode === 'arm_weekly' ? 'arm limit resume (5h + 7d)' : 'arm limit resume')
      : a.kind === 'drop' ? (noPeer ? 'drop: no peer on this turn' : `drop ${dropPaths.length} file(s) to ${t.peer}`)
      : a.kind
    const btn = el('button', 'orchact' + (applied ? ' applied' : ''), (applied ? '✓ ' : '') + label)
    btn.type = 'button'
    btn.disabled = !!applied || noPeer
    const detail = a.kind === 'drop' ? [a.note, ...dropPaths].filter(Boolean).join(String.fromCharCode(10))
      : a.note || a.text || a.prompt || a.ask || ''
    if (detail) btn.title = detail
    if (!applied && !noPeer) {
      btn.addEventListener('click', async (ev) => {
        // A drop's modifiers open the Peering panel's composer, filled from
        // this proposal and aimed at this turn's peer: ⇧ to strike a path or
        // write a note first, ⌥ to see what the filter would let leave. Neither
        // sends anything, so neither marks the action applied. Read off this
        // click, never off a held-key flag.
        if (a.kind === 'drop' && (ev.shiftKey || ev.altKey)) {
          MCN.openDropComposer({ peer: t.peer, paths: dropPaths, note: a.note || '', dryRun: ev.altKey && !ev.shiftKey })
          return
        }
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
        // A liaison turn's apply names its ask, and the relay stores which peer it
        // was for on whatever record the apply creates. The pane never names the
        // peer itself.
        const forAsk = t.askId ? { forAsk: t.askId } : {}
        const r = a.kind === 'link'
          ? await post('/api/link', { from, to, note: a.note || '' })
          : a.kind === 'prompt'
            ? await post('/api/command', { targetId: to, verb: 'prompt', payload: { text: a.text || '' }, ...forAsk })
          : a.kind === 'dispatch'
            ? await post('/api/request/create', {
                title: a.title, project: a.project || '', ask: a.ask || '', brief: a.brief || null,
                model: a.model, effort: a.effort, ...forAsk,
              })
          : a.kind === 'spawn'
            ? await post('/api/spawn', {
                cwd: a.cwd, name: a.name || '', prompt: a.prompt,
                model: a.model, effort: a.effort, ...forAsk,
              })
          : a.kind === 'drop'
            ? await post('/api/peer/' + encodeURIComponent(t.peer) + '/drop', { paths: dropPaths, note: a.note || '' })
          : a.kind === 'arm_resume'
            ? await post('/api/resume', {
                armed: a.mode !== 'disarm', by: 'orchestrator',
                ...(a.mode === 'disarm' ? {} : { windows: a.mode === 'arm_weekly' ? ['fiveHour', 'sevenDay'] : ['fiveHour'] }),
              })
            : { error: 'unknown action kind' }
        if (r.error) { restore(); toast('could not apply: ' + r.error, { kind: 'warn' }); return }
        t.appliedIdx = t.appliedIdx || new Set()
        t.appliedIdx.add(i)
        renderOrchActions(box, t)
        // The relay re-checks every path and leaves out the ones it refuses
        // rather than failing the drop, so say how many did not go.
        const left = a.kind === 'drop' && Array.isArray(r.refused) ? r.refused.length : 0
        if (left) toast(`applied; ${left} ${left === 1 ? 'path was' : 'paths were'} left out`, { kind: 'warn' })
        else toast('applied')
      })
    }
    box.appendChild(btn)
  }
}

/** The transcript, MCX-reconciled by turn id -- contains no input of its
 * own, so `#orb-ask` living outside it is never at risk from a
 *  re-render here. `.gone`, never removed and re-added: an empty transcript
 *  is the common case (nobody has asked anything yet this session).
 *
 *  visibility is `has turns AND not dismissed` -- `S.orchTranscriptHidden`
 *  is a VIEW toggle only (the × below, and Escape), never a conversation
 *  action; the turns themselves are untouched by it. */
const renderOrchTranscript = () => {
  const box = $('orb-transcript')
  const visible = S.orchTurns.length > 0 && !S.orchTranscriptHidden
  MCX.show(box, visible)
  MCX.show($('orb-transcript-bar'), visible)
  // One renderer for both transcripts (cmdbar.js), so the card markup and the
  // MCX config exist in exactly one place.
  MCQ.renderTurns(box)
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
  if (r?.thread) { S.orchThreadId = r.thread.id }
  renderOrchTranscript()
  toast('started a new conversation with Syzygy')
})

/** Enter (with or without a modifier -- this is a single-line `<input>`, so
 *  there is no newline for a plain Enter to insert either way) sends;
 *  Escape blurs (see the window-level Escape chain below for the SECOND
 *  Escape, or one pressed while the field never had focus, which collapses
 *  the transcript). `stopPropagation` here keeps that window-level handler
 *  from ALSO firing on the SAME keystroke -- the same pattern
 *  `d-titleedit`'s own Escape handler uses.
 *
 *  The engine -- the optimistic echo, the 409 queue, the drain -- lives in
 *  cmdbar.js, because the rail and the command bar must share exactly one
 *  queue: two would 409 against each other. */
const sendAsk = async () => {
  const input = $('orb-ask')
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  await MCQ.ask(text)
}
$('orb-ask').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); void sendAsk() }
  else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); ev.target.blur() }
})

// One event, several shapes (the transport scoping.mjs's own 'scope' event
// already uses): a blurb update carries {blurb, blurbAt, busy} with no
// `id`; an ask-turn frame carries {id, delta|done|error, text?, actions?}
// and may ALSO carry `busy` (both ask() and refreshBlurb() broadcast
// their own busy:true/false around the ONE shared concurrency slot -- see
// orchestrator.mjs); a thread change carries {threads, currentId}. This
// handler owns the busy/blurb half. The ask-turn and thread halves are
// cmdbar.js's own registration on the same event, which runs after this one.
//
// orchestrator.busy is what drives the presence swarm's streams
// look thinking indicator too (swarm-math.js's easeThinking) -- renderBlurb
// runs on every S.orchestrator change (this handler, the snapshot, and
// the ask engine's own optimistic busy toggles), so ONE call site there is
// enough; see renderBlurb's own body for the actual MCS.setBusy call.
MCE.on('orchestrator', (d) => {
  if ('busy' in d || 'blurb' in d) {
    S.orchestrator = { blurb: '', blurbAt: 0, busy: false, ...(S.orchestrator || {}), ...d }
    // A frame that only says busy:true/false never carries a stale
    // `blurb`/`blurbAt` to overwrite the real ones with -- `...d` above is
    // safe here because such a frame simply omits those two keys.
    renderBlurb()
    // the slot just freed -- send whatever was typed while
    // it was held. This is the ONLY drain trigger, so a queued turn can
    // never be released while an ask is still running.
    if (!S.orchestrator.busy) void MCQ.drain()
  }
})

// =================================================================== stream
// The relay's event stream. The DISPATCH lives in stream.js (global MCE); what
// is left here is this file's own handlers, and the ones below are the ones
// with no other section to live in. Everything feature-shaped registers beside
// its feature -- `sessions` in the sessions section, `usage` in metrics, and so
// on -- so a change to one feature's live update is an edit inside that
// feature's own section.
const connect = () => {
  const pill = $('conn')
  pill.dataset.tip = `Connecting\nReaching the relay at ${location.origin}…`
  MCE.connect('/api/stream')
}

MCE.on('open', () => {
  S.connected = true
  S.connectedAt = Date.now()
  const pill = $('conn')
  pill.className = 'pill ok'; pill.lastElementChild.textContent = 'live'
  pill.dataset.tip = `Live\nSubscribed to the relay's event stream at ${location.origin}.\n`
    + 'Sessions, events, questions and project scans all arrive over this one connection.'
})
MCE.on('error', () => {
  S.connected = false
  S.connectedAt = null
  const pill = $('conn')
  pill.className = 'pill down'; pill.lastElementChild.textContent = 'reconnecting'
  pill.dataset.tip = `Reconnecting\nThe relay at ${location.origin} stopped answering.\n`
    + 'The browser retries on its own; nothing here needs a reload. Numbers on screen are the last ones received.'
  MCD.onDisconnect()
})

// ONE handler, deliberately: its statement order is load-bearing (S.projects is
// rendered before S.dispatch is even assigned; renderAll must precede
// MCW.refreshLastMessage), so per-field handlers would reorder it and "no
// behaviour change" could not be proved. The seam for a NEW field is
// MCE.onField('thing', fn) from that feature's own file, which runs after all
// of this because it registers after it.
MCE.on('snapshot', (d) => {
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
  MCW.refreshLastMessage()
  renderVoiceSettings()
  renderHudSettings()
  MCV.refresh()
})

// A relay predating this field sends no `pasteboard` key at all, so the
// fan-out's `name in d` guard leaves S.pasteboard undefined and every reader
// takes it with `?? []`.
MCE.onField('pasteboard', (v) => { S.pasteboard = v; MCK.render(); MCW.refreshPasteboard() })
MCE.on('pasteboard', (d) => { S.pasteboard = d.pasteboard ?? []; MCK.render(); MCW.refreshPasteboard() })

MCE.on('dispatch', (d) => { S.dispatch = d; MCD.render() })
MCE.on('scope', (d) => { MCD.onScope(d) })
// The projects event carries the DIGEST, the same shape as the snapshot's
// `projects`: counts and one line per worktree. A view showing a project's
// contents fetches its document when that project's changedAt moves.
MCE.on('projects', (d) => { S.projects = d; MCP.render(); MCD.render() })
MCE.on('canvas', (d) => { S.canvas = d; MCC.render() })
// Its own event, never the whole snapshot -- same discipline as `canvas`.
// `MCV.refresh()` re-runs discovery immediately rather than waiting for an
// unrelated DOM mutation, so a toggle in another tab removes or adds every
// mic button here within one SSE round trip.
MCE.on('voice', (d) => {
  S.voice = d
  renderVoiceSettings()
  MCV.refresh()
  renderModeline()
})
// Its own event, never the whole snapshot -- same discipline as `voice`.
// Fires when this tab's own gear writes a pin, and when another tab (or
// `just spinner`, or a hand edit) does -- so two open panes stay in sync.
MCE.on('hud', (d) => { S.hud = d; renderHudSettings() })
MCE.on('viewers', (d) => { S.viewers = d.viewers; renderPills() })

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
  // Before the next frame, so resize() measures the box the orb is actually
  // in. The worst case if it ever ran after is one frame at the old size.
  hostSwarmIn(SWARM_HOSTS[name])
  // The board lives on the control tab now, and was display:none until this
  // moment, so every card measured zero. Rebuild it (which resizes the card
  // sparkline canvases) and re-lay the wires over it.
  if (name === 'control') { renderTiles(); renderCards() }
  // Same problem, same fix: the charts measured zero while the tab was hidden.
  if (name === 'telemetry') renderTiles()
}
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => setView(b.dataset.view))
addEventListener('keydown', (e) => {
  const map = { '1': 'control', '2': 'telemetry', '3': 'projects', '4': 'dispatch', '5': 'canvas', '6': 'sandbox', '7': 'space', '8': 'peering' }
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
  } else if (fleetForm) {
    html = `choose who gets <b>${escHtml(fleetForm.cmd.label)}</b> — ${KEY('⌘')}${KEY('enter')} sends · ${KEY('esc')} cancels`
  } else if (S.armed) {
    const what = `<b>${escHtml(S.armed.label)}</b>`
    const tail = marked ? ` · ${marked} marked · ${KEY('enter')} sends them · ${KEY('esc')} cancels`
                        : ` · ${KEY('esc')} cancels`
    if (over && S.mods.add) html = `${KEY('⌥')}click — mark <b>${overName}</b> for ${what}, without sending${tail}`
    else if (over) html = `click — send ${what} to <b>${overName}</b>${marked ? ` and ${marked} marked` : ''} · ${KEY('⌥')}click marks instead${tail}`
    else html = `${what} is armed — pick a session on the switchboard · ${KEY('⌥')}click marks several${tail}`
  } else if (S.mods.all) {
    html = n
      ? `${KEY('A')} — a steering button now sends to <b>all ${n} session${n === 1 ? '' : 's'}</b> at once · ${KEY('⇧')}click does the same on one button`
      : `${KEY('A')} — broadcast, but no sessions are on the board`
  } else if (S.mods.add) {
    html = `${KEY('⌥')} — marks several sessions once armed · ${KEY('⌥')}click a steering button picks a subset · ${KEY('⌥')}click the sweep button runs it past its gate`
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

const SECTION = { feed: 'sec-feed', inbox: 'sec-inbox', steer: 'sec-steer', pasteboard: 'sec-pasteboard' }
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
MCP.attach({ S, post, toast, el, ago, needsOf })
// Before MCD, whose create box mounts a preset strip, and before MCQ and MCC, whose capture-phase key listeners must register after this one's.
MCT.attach({ S, $, el, post, toast })
MCD.attach({ S, post, toast, el, compact, ago })
MCW.attach({ S, $, el, post, toast, ago, compact, money, clockOf, nameOf, needsOf, rescope, renderCards })
// Before MCC: canvas.js registers a capture-phase Escape listener on `window`
// inside its attach, and capture listeners on one target run in registration
// order.
MCQ.attach({ S, $, el, post, toast, ago, needsOf, nameOf, renderOrchTranscript, renderOrchActions,
             renderBlurb, noteAskDelta, endAskStall })
// The pasteboard's rail panel, wired from its own module so this file only attaches it.
MCK.attach({ S, $, el, post, toast, ago, nameOf })
MCC.attach({ S, post, toast, el, ago, openDrawer: MCW.open, openLinkDialog, needsOf, stoppedOf })
// Before MCF and MCSQ: both register a loader with it from their own attach,
// and its `shed` handler must set S.shed before their snapshot handlers draw.
MCBG.attach({ S, $, el, toast })
MCF.attach({ S, $, el, post, toast, ago })
MCTC.attach({ S, $, el, post, toast, ago })
MCSQ.attach({ S, $, el, post, toast, ago })
MCV.attach({ state: S, redrawModeline: renderModeline, toast })
MCN.attach({ S, post, toast, el, ago, fmtBytes, focused, renderOrchTranscript, setView })
MCPR.attach({ S, $, el, post, toast, ago })
MCSP.attach({ S, post, toast, el, ago })
MCG.attach({ S, $, el, post, toast, ago, nameOf })
MCZ.attach({ S, $, el, post, toast, ago, nameOf, openDrawer: MCW.open })
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

/* WHICH VIEWS MAY BORROW THE ORB. One renderer and one WebGL context exist,
   ever: the panel is the shader or nothing, and a second context on one
   machine's compositor is the failure the context-loss handling exists to
   survive. Moving a DOM node destroys neither the element nor its context,
   boot() re-queries the canvas by id, and the two context listeners are on
   the node itself -- so a view borrows the orb by taking the node and gives
   it back by leaving. Adding a tab to this map and a positioned host element
   with that id is the whole cost of putting the orb somewhere else. */
const SWARM_HOSTS = { projects: 'pj-orb' }
const swarmHome = () => document.querySelector('.orbpanel > .orbstage')
const hostSwarmIn = (hostId) => {
  const host = (hostId && document.getElementById(hostId)) || swarmHome()
  const c = document.getElementById('swarm')
  if (!host || !c || c.parentElement === host) return
  host.appendChild(c)
  const b = document.getElementById('swarm-mode')
  if (b) host.appendChild(b)
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
  if ((S.view === 'control' || SWARM_HOSTS[S.view]) && swarmReady()) window.MCS.frame(t)
  MCR.frame(t)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
