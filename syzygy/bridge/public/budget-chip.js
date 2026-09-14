/* The rail's frame chip. A classic script, global MCBG, attached by app.js
   beside MCF.

   The relay measures every snapshot frame against a byte budget and, when the
   frame is over it, sheds whole optional sections in a fixed order. The frame
   carries `shed` rows naming what this pane is missing; GET /api/health
   carries the last frame's size, the budget, the rows, each top-level key's
   bytes and how many panes were dropped for not draining. The chip says so,
   stays hidden while there is nothing to say, and is a diagnostic only: every
   failure in here leaves the board exactly as it was.

   A section that can be fetched in full registers a loader with register().
   loadAll() runs every registered loader whose section the frame shed, and a
   section pinned in localStorage under `szg.shed.pin` (a JSON array of
   section names) loads itself whenever a snapshot sheds it.

   Plain click opens a pop listing the health block. Shift-click toggles
   budget mode, which labels every panel carrying `data-section` with that
   payload key's bytes and dims the ones the frame shed; Escape leaves it
   through app.js's page Escape router. Option-click does nothing here.

   Never assign node.className: optional nodes are built once and hidden with
   MCX.show. Nothing runs at evaluation time -- no DOM, no fetch, no
   localStorage, no timer, no MCE until attach(). test/stream-harness.mjs
   evaluates this file with window, console, MCE, MCX, localStorage and fetch
   passed in, and counts every touch. */
'use strict'

const MCBG = (() => {
  let S = null, $ = null, el = null, toast = null
  let attached = false

  /** A shed section -> the top-level payload key it lives under. */
  const SECTION_KEY = Object.freeze({
    findings: 'findings', proposals: 'skillsQueue', series: 'sessions', events: 'events', efforts: 'projects',
  })
  const POLL_MS = 10_000
  const PIN_KEY = 'szg.shed.pin'

  // The last /api/health `snapshot` block read, normalised, or null before the
  // first successful read.
  let health = null
  // droppedPanes as the previous read saw it; null until one has.
  let lastDropped = null
  let warn = false
  let mode = 'off'
  let popOpen = false
  let inFlight = null
  const loaders = new Map()
  // panel -> its label, built the first time budget mode reaches that panel.
  const labels = new Map()

  const rowsOf = (x) => (Array.isArray(x) ? x.filter((r) => r && typeof r.section === 'string') : [])

  /** What this pane's frame shed: the frame's own rows once a frame carrying
   *  `shed` has arrived, else the last health read's. */
  const shedRows = () => (S && Array.isArray(S.shed) ? rowsOf(S.shed) : rowsOf(health && health.shed))

  const size = (n) => {
    const b = Number(n)
    if (!Number.isFinite(b) || b < 0) return '—'
    if (b < 1024) return Math.round(b) + ' B'
    if (b < 10 * 1024) return (b / 1024).toFixed(1) + ' KB'
    if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB'
    return (b / (1024 * 1024)).toFixed(1) + ' MB'
  }

  // ------------------------------------------------------------------ pins

  const readPins = () => {
    try {
      const v = JSON.parse(localStorage.getItem(PIN_KEY) || '[]')
      return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []
    } catch { return [] }
  }
  const pinned = (section) => readPins().includes(section)
  /** Flip one section's pin. Answers the new state, or null when this browser
   *  would not store it. */
  const togglePin = (section) => {
    const pins = readPins()
    const next = pins.includes(section) ? pins.filter((s) => s !== section) : [...pins, section]
    try { localStorage.setItem(PIN_KEY, JSON.stringify(next)) } catch { return null }
    return next.includes(section)
  }

  // --------------------------------------------------------------- loaders

  /** One loader, absorbed: a loader that throws or rejects reports through its
   *  own module, never through the stream handler that called it. */
  const run = (section) => {
    const fn = loaders.get(section)
    if (!fn) return Promise.resolve()
    try { return Promise.resolve(fn()).catch(() => {}) } catch { return Promise.resolve() }
  }
  const register = (section, fn) => {
    if (typeof section === 'string' && typeof fn === 'function') loaders.set(section, fn)
  }
  const loadAll = () => {
    const sections = []
    for (const r of shedRows()) if (loaders.has(r.section) && !sections.includes(r.section)) sections.push(r.section)
    return Promise.all(sections.map(run)).then(() => {})
  }

  // ---------------------------------------------------------------- render

  const renderPop = () => {
    const pop = $ && $('frame-pop')
    if (!pop) return
    MCX.show(pop, popOpen)
    if (!popOpen || !el) return
    const lines = []
    lines.push(['bgpophead', health
      ? `${size(health.bytes)} of ${size(health.budgetBytes)}` + (health.overBudget ? ' — over budget' : '')
      : 'no health reading yet'])
    const rows = health ? rowsOf(health.shed) : shedRows()
    if (!rows.length) lines.push(['bgpoprow', 'nothing shed'])
    for (const r of rows) lines.push(['bgpoprow', `${r.section}: kept ${r.kept}, dropped ${r.dropped}`])
    lines.push(['bgpoprow', `panes dropped: ${health ? health.droppedPanes : 0}`])
    lines.push(['bgpophint', 'shift-click labels every panel with its bytes'])
    pop.replaceChildren(...lines.map(([cls, text]) => el('div', cls, text)))
  }

  const renderLens = () => {
    const on = mode === 'budget'
    const doc = window.document
    if (!doc) return
    if (doc.body) MCX.toggle(doc.body, 'budgetmode', on)
    const shedKeys = new Set(shedRows().map((r) => SECTION_KEY[r.section]).filter(Boolean))
    const bytes = health ? health.sections : {}
    for (const panel of doc.querySelectorAll('section.panel[data-section]')) {
      const key = panel.dataset.section
      let label = labels.get(panel)
      if (!label && on && el) {
        label = el('span', 'seclabel')
        panel.appendChild(label)
        labels.set(panel, label)
      }
      if (label) {
        const has = Object.prototype.hasOwnProperty.call(bytes, key)
        MCX.setText(label, key + ' · ' + (has ? size(bytes[key]) : 'no reading') + (shedKeys.has(key) ? ' · shed' : ''))
        MCX.show(label, on)
      }
      MCX.toggle(panel, 'sheddim', on && shedKeys.has(key))
    }
  }

  const render = () => {
    const chip = $ && $('t-frame')
    if (!chip) return
    const rows = shedRows()
    const dropped = health ? health.droppedPanes : 0
    const over = !!(health && health.overBudget)
    MCX.show(chip, rows.length > 0 || over || dropped > 0)
    MCX.toggle(chip, 'warn', warn)
    MCX.setText($('v-frame'), health ? size(health.bytes) : '—')
    const panes = `${dropped} pane${dropped === 1 ? '' : 's'} dropped`
    const shedText = 'shed ' + rows.map((r) => `${r.section} (${r.dropped})`).join(', ')
    MCX.setText($('s-frame'), warn ? panes
      : rows.length ? shedText
      : dropped ? panes
      : health ? 'of ' + size(health.budgetBytes)
      : '')
    renderPop()
    if (mode === 'budget') renderLens()
  }

  // ---------------------------------------------------------------- health

  /** One /api/health read. A read already in flight is shared rather than
   *  doubled. Any failure -- the relay down, an older relay with no snapshot
   *  block, a reply that is not JSON -- leaves the chip in its last state. */
  const poll = () => {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const r = await fetch('/api/health', { cache: 'no-store' })
        const d = await r.json()
        const snap = d && typeof d === 'object' ? d.snapshot : null
        if (!snap || typeof snap !== 'object') return
        const dropped = Number(snap.droppedPanes) || 0
        warn = lastDropped !== null && dropped > lastDropped
        lastDropped = dropped
        health = {
          bytes: Number(snap.bytes) || 0,
          budgetBytes: Number(snap.budgetBytes) || 0,
          overBudget: snap.overBudget === true,
          shed: rowsOf(snap.shed),
          sections: snap.sections && typeof snap.sections === 'object' ? { ...snap.sections } : {},
          droppedPanes: dropped,
        }
        render()
      } catch { /* the chip keeps its last state */ }
    })().then(() => { inFlight = null })
    return inFlight
  }

  const sections = () => (health ? { ...health.sections } : {})

  // ------------------------------------------------------------------ mode

  const setMode = (next) => {
    const m = next === 'budget' ? 'budget' : 'off'
    if (m === mode) return mode
    mode = m
    try { renderLens() } catch (e) { console.error('budget chip: the lens did not draw', e) }
    if (mode === 'budget') {
      if (!health) void poll()
      if (toast) toast('budget mode: every panel shows its bytes · esc leaves')
    }
    return mode
  }
  const modeOf = () => mode

  // ---------------------------------------------------------------- stream

  const onShed = (v) => {
    S.shed = v
    const pins = readPins()
    if (pins.length) {
      for (const r of rowsOf(v)) if (pins.includes(r.section) && loaders.has(r.section)) void run(r.section)
    }
    render()
  }

  const onChipClick = (ev) => {
    if (ev.altKey) return
    if (ev.shiftKey) { setMode(mode === 'budget' ? 'off' : 'budget'); return }
    popOpen = !popOpen
    if (popOpen) void poll()
    renderPop()
  }

  const attach = (deps) => {
    if (attached) return
    attached = true
    ;({ S, $, el, toast } = deps)
    MCE.onField('shed', onShed)
    MCE.on('open', () => { void poll() })
    window.setInterval(() => { void poll() }, POLL_MS)
    const chip = $('t-frame')
    if (chip) chip.addEventListener('click', onChipClick)
    // A click anywhere outside the chip and its pop closes the pop.
    window.addEventListener('click', (ev) => {
      if (!popOpen) return
      const t = ev.target
      const pop = $('frame-pop')
      if ((chip && chip.contains(t)) || (pop && pop.contains(t))) return
      popOpen = false
      renderPop()
    })
    render()
  }

  return {
    SECTION_KEY, attach, register, loadAll, poll, sections, pinned, togglePin,
    setMode, mode: modeOf,
  }
})()
