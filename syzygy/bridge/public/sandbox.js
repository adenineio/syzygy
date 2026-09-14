/* Syzygy -- the sandbox tab's shell: the gallery grid, the calm dial, the
 * fly-out setting and the ledger's two stream seams.
 *
 * A CLASSIC script, like pasteboard.js and peers.js: its only top-level
 * binding is `const MCG`, and nothing runs at evaluation time -- `$`, `el`
 * and `post` belong to app.js, which loads afterwards, so every DOM binding
 * happens inside attach(). Referenced BARE everywhere, never window.MCG.
 *
 * The three.js stage that actually draws a cell's line layer and mounts its
 * component lives in sandbox-stage.js, imported dynamically the first time
 * this view is shown -- a reader who never opens the tab never fetches it.
 * This file renders the gallery's cells as plain reconciled DOM; once the
 * stage has booted, every render hands each cell's mount point, its
 * parameters and its live data to the stage, which updates a cell it already
 * holds in place. `window.MCGS` is the one name from that file this module
 * ever touches, and always optionally.
 */
const MCG = (() => {
  let S = null, $ = null, el = null, post = null, toast = null, ago = null, nameOf = null

  // ---------------------------------------------------------------- state
  // The view's own on/off, tracked so the observer in attach() never asks
  // for the same transition twice, and so the stage's dynamic import runs
  // at most once. `stageFailed` latches: one failed import means the pane
  // never asks again this page load. `stageBooted` is true once the stage
  // has loaded and booted, and gates every mount.
  let current = ''
  let stageEntered = false
  let stageFailed = false
  let stageBooted = false
  // The gallery's own two toggles: which cell (at most one) is expanded to a
  // full stage, and which cell (at most one) has its parameter panel open.
  // Both are cell ids, or null. Read by the Escape handler below and by the
  // cell gesture handlers further down.
  const openState = { expandedId: null, panelId: null }

  /** A stored setting, or null when storage is unavailable. */
  const stored = (key) => { try { return localStorage.getItem(key) } catch (e) { return null } }

  // ------------------------------------------------------------- the calm dial
  const CALM_LABEL = { still: 'Still', settle: 'Settle', subtle: 'Subtle', more: 'More' }
  const CALM_TIP = {
    still: 'Still\nNothing moves on its own -- a card only responds to the pointer.',
    settle: 'Settle\nA card eases into a new position and holds still once it arrives.',
    subtle: 'Subtle\nEases into place and drifts gently at rest. The default.',
    more: 'More\nEases into place and drifts more widely at rest.',
  }
  const CALM_KEY = 'szg.sandbox.calm'
  // The live value, so a dial built later -- a cell's parameter panel,
  // opened after the header's own dial already resolved a stored name --
  // has something to sync to without re-reading storage.
  let currentCalm = MCGM.CALM_DEFAULT

  /** Marks the pressed button in EVERY calm dial on the page -- the header's
   *  and every cell's panel -- since they all read and write the one
   *  setting. Never touches storage or the stage; applyCalm below is the
   *  only writer. */
  const syncCalmButtons = () => {
    for (const b of document.querySelectorAll('.gcalm button')) {
      b.setAttribute('aria-pressed', String(b.dataset.calm === currentCalm))
    }
  }

  /** Resolves an unknown name to MCGM.CALM_DEFAULT, writes the resolved name
   *  back so a stored name that no longer exists migrates silently, marks
   *  the pressed button in every dial and hands the live scale to the
   *  stage. */
  const applyCalm = (name) => {
    currentCalm = MCGM.CALM.includes(name) ? name : MCGM.CALM_DEFAULT
    try { localStorage.setItem(CALM_KEY, currentCalm) } catch (e) { /* private mode, full storage */ }
    syncCalmButtons()
    window.MCGS?.setCalm?.(MCGM.calmScale(currentCalm, MCX.reducedMotion()))
  }

  /** Builds one calm dial into `box` -- the header's own, and again inside
   *  every cell's parameter panel, since it is one setting reachable from
   *  two places. */
  const buildCalmButtons = (box) => {
    for (const name of MCGM.CALM) {
      const b = el('button', null, CALM_LABEL[name] || name)
      b.type = 'button'
      b.dataset.calm = name
      b.dataset.tip = CALM_TIP[name] || name
      b.onclick = () => applyCalm(name)
      box.appendChild(b)
    }
  }

  // One setting, two dials: the gallery's header and the pane's settings pop,
  // which is where it belongs now that a second view reads it. Both are
  // marked by the one page-wide sync above.
  const buildCalm = () => {
    for (const id of ['g-calm', 'calm']) {
      const box = $(id)
      if (box) buildCalmButtons(box)
    }
  }

  // ----------------------------------------------------------- the fly-out
  // Not sourced from MCGM: flyOutPath's two variant names are its own
  // parameters, and the setting that picks between them lives here.
  const FLYOUT = ['slide', 'scale']
  const FLYOUT_DEFAULT = 'slide'
  const FLYOUT_LABEL = { slide: 'Slide', scale: 'Scale' }
  const FLYOUT_TIP = {
    slide: 'Slide\nEach subagent travels outward to its slot at full size and fades in. The default.',
    scale: 'Scale\nEach subagent grows in place on its slot from a point.',
  }
  const FLYOUT_KEY = 'szg.flyout'

  const applyFlyOut = (name) => {
    const flyout = FLYOUT.includes(name) ? name : FLYOUT_DEFAULT
    try { localStorage.setItem(FLYOUT_KEY, flyout) } catch (e) { /* private mode, full storage */ }
    for (const b of document.querySelectorAll('#flyout button')) {
      b.setAttribute('aria-pressed', String(b.dataset.flyout === flyout))
    }
    window.MCGS?.setFlyOut?.(flyout)
  }

  const buildFlyOut = () => {
    const box = $('flyout')
    if (!box) return
    for (const name of FLYOUT) {
      const b = el('button', null, FLYOUT_LABEL[name] || name)
      b.type = 'button'
      b.dataset.flyout = name
      b.dataset.tip = FLYOUT_TIP[name] || name
      b.onclick = () => applyFlyOut(name)
      box.appendChild(b)
    }
  }

  // --------------------------------------------------------- the data switch
  // A viewing aid, not a judgement about the component, so it lives per
  // browser (localStorage) rather than in the ledger. Only a component
  // listed here offers the switch at all.
  const SAMPLE = {
    'session-card': () => MCGM.sampleSessions(8, 7),
    'git-graph': () => MCGM.sampleProjects(7),
  }
  const DATA_LABEL = { live: 'Live', sample: 'Sample' }
  const DATA_TIP = {
    live: 'Live\nDraws from the real board.',
    sample: 'Sample\nDraws from generated stand-in data. The choice is kept only in this browser.',
  }
  const dataKey = (id) => `szg.sandbox.data.${id}`
  /** 'sample' only for a component that has one and asked for it; 'live'
   *  otherwise, which is also what a component with no switch at all draws. */
  const dataMode = (id) => (SAMPLE[id] && stored(dataKey(id)) === 'sample' ? 'sample' : 'live')

  const syncDataButtons = (cell, id) => {
    const box = cell.querySelector('.gdata')
    if (!box) return
    const mode = dataMode(id)
    for (const b of box.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.data === mode))
    }
  }

  const applyDataMode = (id, mode) => {
    try { localStorage.setItem(dataKey(id), mode === 'sample' ? 'sample' : 'live') } catch (e) { /* private mode, full storage */ }
    render()
  }

  const buildDataSwitch = (id) => {
    const box = el('div', 'gdata')
    for (const mode of ['live', 'sample']) {
      const b = el('button', null, DATA_LABEL[mode])
      b.type = 'button'
      b.dataset.data = mode
      b.dataset.tip = DATA_TIP[mode]
      b.onclick = () => applyDataMode(id, mode)
      box.appendChild(b)
    }
    return box
  }

  // ---------------------------------------------------- the parameter panel
  /** A knob's live value beside its slider: an integer as itself, anything
   *  else to one decimal place, with its unit appended -- no space before a
   *  symbol unit like `°`, a space before a worded one like `rad/s`. */
  const fmtKnob = (value, unit) => {
    const n = Number(value)
    const num = Number.isInteger(n) ? String(n) : n.toFixed(1)
    if (!unit) return num
    return /^[a-z]/i.test(unit) ? `${num} ${unit}` : `${num}${unit}`
  }

  /** Never overwrites a range input the reader is actively dragging -- the
   *  browser keeps it focused for the whole gesture, so without this an
   *  unrelated render (another session's card updating, say) would fight the
   *  hand mid-drag. */
  const setKnobValue = (input, value) => {
    if (document.activeElement === input) return
    const v = String(value)
    if (input.value !== v) input.value = v
  }

  /** One cell's settings, built once: the calm dial (the same setting the
   *  header's own dial reaches), the component's knobs from MCGM.REGISTRY,
   *  and, for a component with sample data, the live/sample switch. Every
   *  value shown in it is written later, in cellSpec.update, from the
   *  ledger -- never here. */
  const buildParamsPanel = (c) => {
    const panel = el('div', 'gparams')
    MCX.show(panel, false)
    panel.appendChild(el('div', 'gptitle', 'Settings'))

    const calmBox = el('div', 'gcalm gpcalm')
    buildCalmButtons(calmBox)
    panel.appendChild(calmBox)

    const knobs = Object.entries(c.knobs)
    if (!knobs.length) {
      panel.appendChild(el('p', 'gpnote', `${c.title} has no adjustable settings.`))
    } else {
      const box = el('div', 'gpknobs')
      for (const [key, knob] of knobs) {
        const row = el('div', 'gpknob')
        const inputId = `gpk-${c.id}-${key}`
        const label = el('label', 'gpklabel', knob.label)
        label.htmlFor = inputId
        const input = document.createElement('input')
        input.type = 'range'
        input.id = inputId
        input.min = String(knob.min)
        input.max = String(knob.max)
        input.step = String(knob.step)
        input.dataset.knob = key
        const value = el('span', 'gpkval')
        // Live preview only -- the number beside the slider follows the
        // hand; nothing is sent until the gesture ends.
        input.addEventListener('input', () => { MCX.setText(value, fmtKnob(input.value, knob.unit)) })
        input.addEventListener('change', () => {
          const merged = MCGM.mergeParams(c.id, entryOf(c.id)?.params, { [key]: Number(input.value) })
          void post('/api/sandbox/params', { component: c.id, params: merged }).then((r) => {
            if (r?.error) toast(r.error, { kind: 'warn' })
          })
        })
        row.appendChild(label)
        row.appendChild(input)
        row.appendChild(value)
        box.appendChild(row)
      }
      panel.appendChild(box)
    }

    if (SAMPLE[c.id]) panel.appendChild(buildDataSwitch(c.id))
    return panel
  }

  // -------------------------------------------------------------- the grid
  const MARK_LABEL = { '': 'mark', good: 'good', near: 'near', potential: 'potential' }
  const MARK_TIP = {
    '': 'Unmarked\nNo verdict on this component yet. Nothing here is ever deleted.',
    good: 'Good\nThis component earned its place. Nothing here is ever deleted.',
    near: 'Near good\nClose, but not quite there. Nothing here is ever deleted.',
    potential: 'Has potential\nWorth developing further. Nothing here is ever deleted.',
  }
  const entryOf = (id) => (S.sandbox ?? []).find((e) => e.component === id)
  const markOf = (id) => entryOf(id)?.mark ?? ''

  const cellSpec = {
    key: (c) => c.id,
    create: (c) => {
      const n = el('div', 'gcell')
      const head = el('div', 'ghead')
      const row = el('div', 'gtitlerow')
      row.appendChild(el('span', 'gtitle'))
      const mark = el('button', 'gmark')
      mark.type = 'button'
      row.appendChild(mark)
      head.appendChild(row)
      head.appendChild(el('div', 'gblurb'))
      n.appendChild(head)
      // The panel lives INSIDE the stage, not beside it: the stage is
      // already the cell's positioned overlay surface, so covering it there
      // leaves the header -- the title and the mark badge -- visible while
      // the panel is open.
      const stage = el('div', 'gstage')
      stage.appendChild(buildParamsPanel(c))
      n.appendChild(stage)
      return n
    },
    update: (n, c) => {
      MCX.setAttr(n, 'data-component', c.id)
      MCX.setText(n.querySelector('.gtitle'), c.title)
      MCX.setText(n.querySelector('.gblurb'), c.blurb)
      const mark = markOf(c.id)
      const badge = n.querySelector('.gmark')
      MCX.setAttr(badge, 'data-mark', mark)
      MCX.setAttr(badge, 'data-tip', MARK_TIP[mark] ?? MARK_TIP[''])
      MCX.setText(badge, MARK_LABEL[mark] ?? MARK_LABEL[''])

      const params = MCGM.mergeParams(c.id, entryOf(c.id)?.params, {})
      for (const input of n.querySelectorAll('.gpknob input[data-knob]')) {
        const key = input.dataset.knob
        const knob = c.knobs[key]
        if (!knob) continue
        setKnobValue(input, params[key])
        MCX.setText(input.nextElementSibling, fmtKnob(params[key], knob.unit))
      }
      syncDataButtons(n, c.id)
    },
  }

  // ------------------------------------------------------- the live history
  // The board every pane is sent carries no git history. The worktree graph
  // asks the graph route for each project on it, keyed by project key as
  // `{ status, changedAt, gitGraph }` -- only while this view is showing and
  // the graph draws the live board, and again once a project's changedAt
  // moves. A 404 or a failed read is recorded at that changedAt and not asked
  // again until the project moves; the project draws its worktree heads until
  // a read lands, and keeps the last read while a newer one is in flight.
  const graphs = new Map()

  const fetchGraph = (key, changedAt) => {
    const prior = graphs.get(key)
    const entry = { status: 'loading', changedAt }
    if (prior && (prior.status === 'ok' || prior.status === 'loading') && 'gitGraph' in prior) entry.gitGraph = prior.gitGraph
    graphs.set(key, entry)
    fetch('/api/projects/graph?key=' + encodeURIComponent(key))
      .then((r) => {
        if (r.status === 404) return { status: 'missing', changedAt }
        if (!r.ok) return { status: 'error', changedAt }
        return r.json().then((d) => (d && typeof d === 'object' && 'gitGraph' in d
          ? { status: 'ok', changedAt, gitGraph: d.gitGraph }
          : { status: 'error', changedAt }))
      })
      .catch(() => ({ status: 'error', changedAt }))
      .then((next) => {
        // Replaced or evicted while in flight: not the answer awaited.
        if (graphs.get(key) !== entry) return
        graphs.set(key, next)
        render()
      })
  }

  const askGraphs = () => {
    if (current !== 'sandbox' || dataMode('git-graph') !== 'live') return
    const projects = Array.isArray(S.projects) ? S.projects : []
    const { fetch: ask, evict } = MCPM.docPlan(projects, graphs, { want: 'all' })
    for (const key of evict) graphs.delete(key)
    for (const key of ask) fetchGraph(key, projects.find((p) => MCPM.projectKey(p) === key)?.changedAt ?? null)
  }

  /** What each component draws from: sample data when its switch is set
   *  that way, else the live board, read at call time. */
  const dataFor = (id) => {
    if (dataMode(id) === 'sample') return SAMPLE[id]()
    if (id === 'session-card') return S.sessions ?? []
    if (id === 'git-graph') return MCGM.withGraphs(S.projects ?? [], graphs)
    return []
  }

  /** Hands every cell's mount point to the stage, with the component's
   *  stored parameters and its live data. Only once the stage has booted:
   *  before that there is nothing to mount into, and the boot renders once
   *  itself so the first mount never waits for the next frame of data. */
  const mountStage = (host) => {
    if (!stageBooted) return
    for (const cell of host.children) {
      const id = cell.dataset.component
      const stage = id ? cell.querySelector('.gstage') : null
      if (!stage) continue
      window.MCGS?.mount?.(stage, id, MCGM.mergeParams(id, entryOf(id)?.params, {}), dataFor(id))
    }
  }

  const render = () => {
    if (!$) return
    askGraphs()
    const host = $('g-cells')
    if (host) {
      MCX.reconcile(host, MCGM.REGISTRY, cellSpec)
      // A cell's panel is built the first time its cell is, which can be
      // after the calm dial's own value was last resolved -- this is what
      // keeps a freshly built dial from opening one step behind.
      syncCalmButtons()
      mountStage(host)
    }
    const count = $('c-sandbox')
    if (count) MCX.setText(count, String((S.sandbox ?? []).filter((e) => e.mark).length))
  }

  // -------------------------------------------------------- the stage seam
  /** Every entry boots the stage against this view's line canvas. The stage
   *  may have been booted onto another view's canvas since this view was
   *  last shown, and a bare resume would leave the lines drawing there;
   *  boot on the canvas the stage already holds only resumes.
   *
   *  First entry: import the stage, then boot. A missing sandbox-stage.js is
   *  one toast and an otherwise-working gallery of plain cells -- never
   *  latched again after the first failure, so a reader who leaves and
   *  returns is not told twice. Once booted, the stage starts from the stored
   *  calm and fly-out settings and gets its mounts. A later entry before the
   *  import has finished does nothing: the first entry's boot is still to
   *  come, and it checks which view is showing once it has run. */
  const enterStage = async () => {
    if (!stageEntered) {
      stageEntered = true
      if (!stageFailed) {
        try {
          await import('/sandbox-stage.js')
          window.MCGS?.boot?.({ glCanvas: $('g-lines') })
          stageBooted = typeof window.MCGS?.mount === 'function'
        } catch (e) {
          stageFailed = true
          toast('sandbox stage unavailable', { kind: 'warn' })
        }
        if (stageBooted) {
          applyCalm(stored(CALM_KEY))
          applyFlyOut(stored(FLYOUT_KEY))
          render()
          // The view can be left while the import is still in flight, and
          // the pause sent then found no stage to reach.
          if (current !== 'sandbox') window.MCGS?.pause?.()
        }
      }
      return
    }
    if (stageBooted) window.MCGS?.boot?.({ glCanvas: $('g-lines') })
  }

  const exitStage = () => { if (stageBooted) window.MCGS?.pause?.() }

  /** Called from the MutationObserver in attach() with 'sandbox' or '' --
   *  the view's own name for on, empty for anything else. A no-op unless the
   *  state actually changed, so a class flip unrelated to `.on` (or a direct
   *  call with the state already current) never re-enters or re-pauses the
   *  stage. */
  const setView = (name) => {
    const next = name === 'sandbox' ? 'sandbox' : ''
    if (next === current) return
    current = next
    if (next === 'sandbox') { askGraphs(); void enterStage() }
    else exitStage()
  }

  // ------------------------------------------------------- the cell gestures
  // The four settled gestures, read off the click/contextmenu event itself
  // rather than off any keydown state: a plain click on a component's own
  // target (a button, or anything carrying data-g-hit -- the agents badge, a
  // fly-out child, a graph label) is left to that target, and
  // a plain click anywhere else in the cell toggles which cell -- at most
  // one -- is expanded. Shift and option act on the cell wherever the click
  // lands, since no component target uses either modifier. Both delegated
  // from #g-cells, bound once, so a reconcile pass never has to rebind them.

  const applyExpanded = () => {
    const host = $('g-cells')
    if (!host) return
    for (const cell of host.children) {
      cell.classList.toggle('expanded', cell.dataset.component === openState.expandedId)
    }
  }
  const setExpanded = (id) => { openState.expandedId = id; applyExpanded() }

  const applyPanel = () => {
    const host = $('g-cells')
    if (!host) return
    for (const cell of host.children) {
      const panel = cell.querySelector('.gparams')
      if (panel) MCX.show(panel, cell.dataset.component === openState.panelId)
    }
  }
  const setPanel = (id) => {
    openState.panelId = id
    applyPanel()
    // The panel just shown may have been built before the calm dial's value
    // was last resolved; render() keeps it in step from here on, but this is
    // the one moment nothing else is guaranteed to have run since.
    syncCalmButtons()
  }
  const closePanel = () => setPanel(null)

  const postMark = (component, body) => {
    void post('/api/sandbox/mark', { component, ...body }).then((r) => {
      if (r?.error) toast(r.error, { kind: 'warn' })
    })
  }

  const onCellClick = (e) => {
    const cell = e.target.closest('.gcell')
    if (!cell) return
    const id = cell.dataset.component
    if (!id) return
    if (e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      setPanel(id)
      return
    }
    if (e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      postMark(id, { cycle: true })
      return
    }
    if (e.target.closest('button, [data-g-hit]')) return
    setExpanded(openState.expandedId === id ? null : id)
  }

  const onCellContextMenu = (e) => {
    const cell = e.target.closest('.gcell')
    if (!cell) return
    const id = cell.dataset.component
    if (!id) return
    e.preventDefault()
    postMark(id, { mark: '' })
  }

  /** The parameter panel's own idiom, the settings pop's: closed by a
   *  pointerdown anywhere outside it. Pointerdown rather than click so the
   *  gesture is caught at the same point the settings pop catches its own. */
  const onWindowPointerDown = (e) => {
    if (!openState.panelId) return
    if (e.target instanceof Element && e.target.closest('.gparams')) return
    closePanel()
  }

  // ------------------------------------------------------------------ keys
  /** Capture-phase so it runs ahead of every bubble-phase Escape handler
   *  app.js and its siblings already own. It only ever consumes the key --
   *  stopPropagation() -- while this view is showing AND something on it is
   *  open, in order: an open parameter panel first, since it sits above
   *  everything else; then an open agents fly-out, since it sits inside a
   *  cell; then a worktree graph drilled in past its top level, stepped back
   *  out one level per press; then an expanded cell. */
  const onWindowKeydown = (e) => {
    if (e.key !== 'Escape') return
    if (S.view !== 'sandbox') return
    if (openState.panelId) {
      closePanel()
      e.stopPropagation()
      return
    }
    if (window.MCGS?.flyOutOpen?.()) {
      window.MCGS.closeFlyOut()
      e.stopPropagation()
      return
    }
    if (window.MCGS?.graphBack?.()) {
      e.stopPropagation()
      return
    }
    if (!openState.expandedId) return
    setExpanded(null)
    e.stopPropagation()
  }

  // ----------------------------------------------------------------- attach
  const attach = (deps) => {
    S = deps.S; $ = deps.$; el = deps.el; post = deps.post
    toast = deps.toast; ago = deps.ago; nameOf = deps.nameOf

    buildCalm()
    buildFlyOut()
    applyCalm(stored(CALM_KEY))
    applyFlyOut(stored(FLYOUT_KEY))

    MCE.onField('sandbox', (v) => { S.sandbox = v ?? []; render() })
    MCE.on('sandbox', (d) => { S.sandbox = d.sandbox ?? []; render() })

    // The stage draws from the live board. app.js assigns S.sessions and
    // S.projects in handlers registered before these, both from the snapshot
    // and from their own frames, so each of these renders the new value.
    MCE.onField('sessions', () => render())
    MCE.onField('projects', () => render())
    MCE.on('sessions', () => render())
    MCE.on('projects', () => render())

    addEventListener('keydown', onWindowKeydown, true)
    addEventListener('pointerdown', onWindowPointerDown)

    const cells = $('g-cells')
    if (cells) {
      cells.addEventListener('click', onCellClick)
      cells.addEventListener('contextmenu', onCellContextMenu)
    }

    const node = $('view-sandbox')
    if (node) {
      const mo = new MutationObserver(() => {
        setView(node.classList.contains('on') ? 'sandbox' : '')
      })
      mo.observe(node, { attributes: true, attributeFilter: ['class'] })
      if (node.classList.contains('on')) setView('sandbox')
    }

    render()
  }

  /** The resolved calm name, for a view that animates on the same setting
   *  without owning it. Never a stored name that no longer exists. */
  const calm = () => currentCalm

  return { attach, setView, render, calm }
})()
