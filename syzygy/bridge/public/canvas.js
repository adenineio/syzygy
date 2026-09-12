/* Syzygy -- the session canvas. Attached by app.js, which owns the shared
   state S and the event stream; this file owns the tab.

   Rendered by KEYED RECONCILIATION (MCX, reconcile.js), keyed on session id.
   Two rules from its contract, both of which have cost real time:
     - NEVER assign `node.className`. It wipes `.gone` and every state class
       out from under MCX.show/MCX.toggle. Toggle classes one at a time.
     - Build optional elements unconditionally in `create`, hide them with
       MCX.show in `update`.

   Positions: a node with a stored position (S.canvas.nodes[id], persisted by
   the relay) sits there; one without sits in its DEFAULT SLOT, computed by
   MCL.defaultLayout from the switchboard's grouping. "Reset view" is
   therefore just the relay forgetting every stored position -- it moves
   nodes and can do nothing else.

   Wires are S.links, drawn on ONE canvas overlay -- not a DOM node per wire.
   A wire is drawn by its `kind`; today every kind is a channel, and
   nothing here assumes that will stay true.

   No animation lives here, and no animation library is vendored. */
'use strict'

const MCC = (() => {
  let C = null            // { S, post, toast, el, ago, openDrawer, openLinkDialog }
  let active = false
  let stage, nodesEl, wiresEl, wctx, form, emptyEl
  let slots = {}          // the default layout for the current session set
  let drag = null         // { kind: 'move', id, dx, dy, x, y, sx, sy, moved } | { kind: 'wire', from, x, y }

  const $ = (id) => document.getElementById(id)
  const S = () => C.S
  const NODE_W = MCL.NODE_W, NODE_H = MCL.NODE_H

  // Canvas takes no CSS custom properties; app.js publishes the live theme on
  // window.MCT. This is the teal fallback for the frames before it has.
  const CP = { accent: '#6fc3df', accentHot: '#a9e8ff', accentDeep: '#2f7f9b', amber: '#e0973c' }
  const col = (n) => window.MCT?.[n] || CP[n]

  const tail = (p) => (p ? String(p).replace(/\/+$/, '') : '')
  const spawnOf = (id) => (S().canvas.spawnedBy || []).find((r) => r.sessionId === id) || null
  const sessionOf = (id) => S().sessions.find((s) => s.id === id) || null

  /** Where a node is: mid-gesture position, else stored, else its default slot. */
  const posOf = (s) => {
    if (drag && drag.kind === 'move' && drag.id === s.id) return { x: drag.x, y: drag.y }
    return S().canvas.nodes?.[s.id] ?? slots[s.id] ?? { x: MCL.PAD, y: MCL.PAD }
  }

  // --- the node spec ----------------------------------------------------------

  const NODE = {
    key: (s) => s.id,
    create: (s) => {
      const n = C.el('div', 'cnode')
      n.dataset.id = s.id
      const r1 = C.el('div', 'crow1')
      r1.appendChild(C.el('span', 'cname'))
      r1.appendChild(C.el('span', 'cbadge'))
      // Built once and hidden with MCX.show, never added and removed -- this
      // node is reconciled, not rebuilt.
      r1.appendChild(C.el('span', 'cneed', '\u25cf needs you'))
      // The stopped ring, same rule as .cneed: built once here, toggled with
      // MCX.show in update. The switchboard draws the identical glyph.
      r1.appendChild(C.el('span', 'cstop', '\u25cb'))
      n.appendChild(r1)
      n.appendChild(C.el('div', 'cmeta'))
      n.appendChild(C.el('div', 'ccwd'))
      const row = C.el('div', 'cbtns')
      const att = C.el('button', 'btn cattach', 'attach')
      att.type = 'button'
      att.dataset.tip = 'Attach\nOpens this session in a new tmux window with `claude attach`. Only a session the canvas started can be attached to.'
      att.addEventListener('click', (ev) => { ev.stopPropagation(); void attachTo(n.dataset.id) })
      row.appendChild(att)
      n.appendChild(row)
      const grip = C.el('div', 'cgrip', '⠿ wire')
      grip.dataset.tip = 'Wire\nDrag onto another node to open a channel: one message, sent now, with a note you write.'
      n.appendChild(grip)
      wireNode(n)
      return n
    },
    update: (n, s) => {
      const sp = spawnOf(s.id)
      MCX.setText(n.querySelector('.cname'), s.name || s.id.slice(0, 8))
      MCX.setText(n.querySelector('.cbadge'), s.working ? '● live' : 'idle · ' + C.ago(s.idleSince ?? s.seenAt))
      MCX.toggle(n, 'working', !!s.working)
      MCX.toggle(n, 'spawned', !!sp)
      // Same rule as the switchboard, via the same helper: duplicating the
      // two-source union here would drift the moment either source changed.
      const need = C.needsOf(s)
      MCX.toggle(n, 'needs', !!need)
      MCX.show(n.querySelector('.cneed'), !!need)
      // Same helper as the switchboard, for the same reason as needsOf: two
      // copies of this rule would drift apart the first time either changed.
      const stopped = C.stoppedOf ? C.stoppedOf(s) : 0
      MCX.toggle(n, 'stopped', !!stopped)
      MCX.show(n.querySelector('.cstop'), !!stopped)
      MCX.setAttr(n, 'title', need || (stopped ? 'stopped ' + C.ago(stopped) + ' ago' : ''))
      const bits = [s.model || 'model ?']
      if (s.branch) bits.push('⎇ ' + s.branch)
      if (sp) bits.push('auto · ' + sp.shortId)
      MCX.setText(n.querySelector('.cmeta'), bits.join(' · '))
      MCX.setText(n.querySelector('.ccwd'), tail(s.cwd))
      MCX.setAttr(n.querySelector('.ccwd'), 'title', s.cwd || '')
      MCX.show(n.querySelector('.cattach'), !!sp)
      // This session's own outline colour (cards.mjs), drawn by canvas.css's
      // `.cnode.colored::after` ring -- same rule as the switchboard's
      // fillCard, and the same reason it is a `::after` and not `outline`:
      // the clip-path chamfer clips both outline and an outer box-shadow.
      // `.colored` is the actual gate, so a stale custom property left on
      // the node from a previous colour can never leak through once it is
      // off. Plain style/classList mutation, not className -- the header's
      // rule is about wholesale replacement, and this only ever touches its
      // own property and its own class.
      const color = s.color || ''
      MCX.toggle(n, 'colored', !!color)
      if (color) n.style.setProperty('--card-color', color)
      else n.style.removeProperty('--card-color')
      const p = posOf(s)
      const l = p.x + 'px', t = p.y + 'px'
      if (n.style.left !== l) n.style.left = l
      if (n.style.top !== t) n.style.top = t
    },
  }

  // --- geometry ---------------------------------------------------------------

  /** The content box grows to the furthest node so the stage can scroll to it. */
  const sizeStage = () => {
    let w = 0, h = 0
    for (const s of S().sessions) { const p = posOf(s); w = Math.max(w, p.x + NODE_W); h = Math.max(h, p.y + NODE_H) }
    const W = Math.max(stage.clientWidth, w + 40), H = Math.max(stage.clientHeight, h + 40)
    if (nodesEl.style.width !== W + 'px') nodesEl.style.width = W + 'px'
    if (nodesEl.style.height !== H + 'px') nodesEl.style.height = H + 'px'
  }

  const centerOf = (id) => {
    const s = sessionOf(id)
    if (!s) return null
    const p = posOf(s)
    return { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 }
  }

  /** One canvas, every wire: never a DOM node per wire. Drawn in
   *  the content box's coordinates, the same ones posOf() speaks. Looked up
   *  by `kind` so each kind can be drawn differently without touching the
   *  loop. */
  const WIRE_LOOK = { brief: ['accentDeep', 'accent'] }
  // hasOwn, not `WIRE_LOOK[kind] || ...`: a link whose kind is an Object.prototype
  // key ('constructor', 'toString') would otherwise resolve to a function, the
  // destructure below would throw, and the throw takes every wire with it.
  const lookOf = (kind) => (Object.hasOwn(WIRE_LOOK, kind) ? WIRE_LOOK[kind] : WIRE_LOOK.brief)

  const trace = (a, b, c0, c1, alpha) => {
    const g = wctx.createLinearGradient(a.x, a.y, b.x, b.y)
    g.addColorStop(0, c0); g.addColorStop(1, c1)
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5)
    wctx.beginPath()
    wctx.moveTo(a.x, a.y)
    wctx.bezierCurveTo(a.x + dx, a.y, b.x - dx, b.y, b.x, b.y)
    // One hairline, no halo -- app.js's link traces arrived at the same rule.
    wctx.strokeStyle = g; wctx.globalAlpha = alpha; wctx.lineWidth = 1; wctx.stroke()
    wctx.globalAlpha = 1
    wctx.fillStyle = c0; wctx.fillRect(Math.round(a.x) - 2, Math.round(a.y) - 2, 4, 4)
    wctx.fillStyle = c1; wctx.fillRect(Math.round(b.x) - 2, Math.round(b.y) - 2, 4, 4)
  }

  const drawWires = () => {
    const d = Math.min(2, window.devicePixelRatio || 1)
    const w = nodesEl.offsetWidth, h = nodesEl.offsetHeight
    const pw = Math.round(w * d), ph = Math.round(h * d)
    if (wiresEl.width !== pw || wiresEl.height !== ph) { wiresEl.width = pw; wiresEl.height = ph }
    // Both dimensions, independently. sizeStage() grows W and H separately, so
    // a node dragged below the fold grows the HEIGHT alone -- and keying this
    // guard on the width skipped both assignments, leaving the element's CSS
    // height stale while the line above had already grown the bitmap. Every
    // wire then drew at the ratio of the two heights, out of register with the
    // nodes. .cwires carries no width or height in CSS: this is its only sizing.
    if (wiresEl.style.width !== w + 'px' || wiresEl.style.height !== h + 'px') {
      wiresEl.style.width = w + 'px'; wiresEl.style.height = h + 'px'
    }
    wctx.setTransform(d, 0, 0, d, 0, 0)
    wctx.clearRect(0, 0, w, h)
    wctx.lineCap = 'round'; wctx.lineJoin = 'round'
    for (const l of S().links) {
      const a = centerOf(l.from), b = centerOf(l.to)
      if (!a || !b) continue
      const [c0, c1] = lookOf(l.kind)
      trace(a, b, col(c0), col(c1), 0.85)
    }
    if (drag && drag.kind === 'wire') {
      const a = centerOf(drag.from)
      if (a) trace(a, { x: drag.x, y: drag.y }, col('accent'), col('accentHot'), 1)
    }
  }

  // --- render -----------------------------------------------------------------

  const renderCount = () => {
    const c = S().canvas
    const live = c.live ?? 0
    const tab = $('c-canvas-tab')
    MCX.setText(tab, String(live))
    MCX.toggle(tab, 'busy', live > 0)
    const pill = $('c-canvas-live')
    MCX.setText(pill, live + ' auto-mode session' + (live === 1 ? '' : 's') + ' live')
    MCX.toggle(pill, 'busy', live > 0)
    MCX.setText($('c-canvas'), String(S().sessions.length))
  }

  const render = () => {
    if (!C) return
    renderCount()
    // Not while a gesture is live: the drag source holds the pointer capture
    // and its position is mid-flight. Whatever arrives is picked up on release.
    if (!active || drag) return
    slots = MCL.defaultLayout(S().sessions, { width: stage.clientWidth })
    MCX.reconcile(nodesEl, S().sessions, NODE)
    MCX.show(emptyEl, S().sessions.length === 0)
    sizeStage()
    drawWires()
  }

  // --- gestures: move and wire ------------------------------------------------

  const stagePoint = (ev) => {
    const b = nodesEl.getBoundingClientRect()
    return { x: ev.clientX - b.left, y: ev.clientY - b.top }
  }

  const clearTargets = () => { for (const o of nodesEl.querySelectorAll('.cnode.target')) o.classList.remove('target') }

  const wireNode = (n) => {
    n.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || drag) return
      if (ev.target.closest('button')) return
      ev.preventDefault()
      const id = n.dataset.id
      const p = stagePoint(ev)
      if (ev.target.closest('.cgrip')) {
        drag = { kind: 'wire', from: id, x: p.x, y: p.y }
        n.classList.add('wiring')
      } else {
        const s = sessionOf(id)
        const at = s ? posOf(s) : { x: 0, y: 0 }
        drag = { kind: 'move', id, dx: p.x - at.x, dy: p.y - at.y, x: at.x, y: at.y, sx: ev.clientX, sy: ev.clientY, moved: false }
        n.classList.add('dragging')
      }
      n.setPointerCapture(ev.pointerId)
    })
    /** Is the live gesture THIS node's? `drag` is module state shared by every
     *  node, and a pointer event can reach a node that did not start the
     *  gesture -- so without this, a second node's pointermove would drive the
     *  first node's drag, and its pointerup would finish it. A move drag is
     *  keyed by `id`, a wire drag by `from`. The switchboard guards the same
     *  way (`S.drag.from !== card.dataset.id`, app.js). */
    const mine = () => !!drag && (drag.kind === 'move' ? drag.id : drag.from) === n.dataset.id

    n.addEventListener('pointermove', (ev) => {
      if (!mine()) return
      const p = stagePoint(ev)
      if (drag.kind === 'move') {
        if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) > 3) drag.moved = true
        drag.x = Math.max(0, Math.round(p.x - drag.dx))
        drag.y = Math.max(0, Math.round(p.y - drag.dy))
        n.style.left = drag.x + 'px'
        n.style.top = drag.y + 'px'
      } else {
        drag.x = p.x; drag.y = p.y
        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.cnode')
        clearTargets()
        if (over && over !== n) over.classList.add('target')
      }
      drawWires()
    })
    /** Async only in its tail: everything that touches the DOM or `drag` runs
     *  before the first await, so a caller that does not await it (none does)
     *  still sees the gesture ended synchronously. */
    const finish = async (ev, cancelled) => {
      if (!drag) return
      const d = drag
      drag = null
      n.classList.remove('dragging'); n.classList.remove('wiring')
      clearTargets()
      let pending = null      // the move to post, once the DOM is settled
      if (d.kind === 'move') {
        if (!cancelled && d.moved) {
          // Optimistic: the relay's `canvas` broadcast will confirm it. `??=`
          // because a relay that has forgotten every position (reset view)
          // sends no `nodes` object at all, and the first drag after that
          // would otherwise throw on the way to the POST.
          ;(S().canvas.nodes ??= {})[d.id] = { x: d.x, y: d.y, name: sessionOf(d.id)?.name ?? '', t: Date.now() }
          pending = d
        } else if (!cancelled) {
          C.openDrawer(d.id)
        }
      } else if (!cancelled) {
        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.cnode')
        // Landing the drag does NOT send: the note is written in the dialog,
        // exactly as on the switchboard.
        if (over && over.dataset.id !== d.from) C.openLinkDialog(d.from, over.dataset.id)
      }
      render()
      if (!pending) return
      // The optimistic entry is a promise the relay has not kept yet. If it
      // refuses, say so and drop the entry, so the next render puts the node
      // back where the relay actually has it instead of lying quietly.
      const r = await C.post('/api/canvas/move', { id: pending.id, x: pending.x, y: pending.y })
      if (!r.error) return
      C.toast('move not saved: ' + r.error, { kind: 'warn' })
      if (S().canvas.nodes) delete S().canvas.nodes[pending.id]
      render()
    }
    n.addEventListener('pointerup', (ev) => { if (mine()) void finish(ev, false) })
    n.addEventListener('pointercancel', (ev) => { if (mine()) void finish(ev, true) })
    // A capture lost without a pointerup or pointercancel -- the element
    // removed, or the browser taking the pointer back -- would otherwise leave
    // `drag` set forever, and render() returns early while it is, so the tab
    // would freeze for the life of the page. Fires after pointerup too, where
    // finish() has already cleared `drag` and mine() is false.
    n.addEventListener('lostpointercapture', (ev) => { if (mine()) void finish(ev, true) })
  }

  /** The relay answers 409 with the command when tmux is not
   *  running; that is shown, not swallowed, exactly as the Dispatch tab does. */
  const attachTo = async (id) => {
    const s = sessionOf(id)
    const r = await C.post('/api/attach', { sessionId: id, cwd: s?.cwd })
    if (r.ok) C.toast('attached — tmux window ' + r.window)
    else if (r.command) C.toast('tmux is not running — run by hand: ' + r.command, { ms: 9000, kind: 'warn' })
    else C.toast(r.error || 'attach failed', { ms: 6000, kind: 'warn' })
  }

  // --- the spawn form ---------------------------------------------
  // Right-click on empty canvas, or ⌥-click. A small form: cwd (a picker over
  // recents plus free entry), the kickoff prompt, an optional name. Model and
  // effort default to the Dispatch tab's defaults. NOTHING is started until it
  // is submitted; the relay validates the cwd. Nothing limits how many sessions
  // may be live -- the live count on the tab is the whole guard.
  //
  // modifier-paging scrubber is an input GESTURE over this same
  // form, not a different data model -- adding it plainly is not blocked.

  /** Recents the relay persisted, then every live session's cwd, then the
   *  relay's own project root. `home` last and always: on a fresh relay it is
   *  the ONLY entry, which is exactly the case the user hit -- an empty picker
   *  on a demo board with no history behind it. */
  const recentsList = () => {
    const seen = new Set(), out = []
    for (const c of [...(S().canvas.recents || []), ...S().sessions.map((s) => s.cwd), S().canvas.home]) {
      if (c && !seen.has(c)) { seen.add(c); out.push(c) }
    }
    return out.slice(0, 20)
  }

  /** The datalist is completions first, then the static list, deduped: what
   *  the relay just said about the path being typed is more relevant than any
   *  recent, and a browser renders a datalist in document order. */
  const fillDatalist = (completions) => {
    const dl = $('cs-recents')
    dl.textContent = ''
    const seen = new Set()
    for (const c of [...(completions || []), ...recentsList()]) {
      if (!c || seen.has(c)) continue
      seen.add(c)
      const o = document.createElement('option')
      o.value = c
      dl.appendChild(o)
    }
  }

  // The typeahead, debounced and serialised. ONE request in flight at a time:
  // a directory listing per keystroke over a slow directory would queue behind
  // itself and answer in whatever order the responses happened to land.
  // Anything typed DURING a request is remembered in `completeNext` and sent
  // the moment that one resolves, so the last thing typed is always the last
  // thing asked about, and never more than one request is outstanding.
  //
  // An answer the field has already moved past is DROPPED rather than
  // rendered, because a datalist rebuilt from a path the user has typed past
  // is worse than no datalist: the browser holds its dropdown open over it.
  // The test is the FIELD's value at render time, not `completeNext`: a
  // keystroke that lands during the 120 ms debounce leaves `completeNext` null
  // and still makes the in-flight answer stale.
  const COMPLETE_DEBOUNCE_MS = 120
  let completeTimer = null, completing = false, completeNext = null
  const sendComplete = (value) => {
    if (completing) { completeNext = value; return }
    completing = true
    const done = () => {
      completing = false
      const next = completeNext
      completeNext = null
      if (next !== null) sendComplete(next)
    }
    void C.post('/api/canvas/complete', { path: value }).then((r) => {
      const fresh = form && !form.hidden && $('cs-cwd').value === value
      if (fresh) fillDatalist(Array.isArray(r?.dirs) ? r.dirs : [])
      done()
    }, done)
  }
  const requestComplete = (value) => {
    clearTimeout(completeTimer)
    completeTimer = setTimeout(() => sendComplete(value), COMPLETE_DEBOUNCE_MS)
  }

  const openSpawn = (p) => {
    const x = Math.max(0, Math.round(p.x)), y = Math.max(0, Math.round(p.y))
    // The NODE lands on the click point, so the dataset keeps it un-clamped.
    form.dataset.x = String(x); form.dataset.y = String(y)
    fillDatalist(null)
    const recents = recentsList()
    // The last directory typed is kept across opens; otherwise the newest
    // recent seeds it, and on a relay with no history at all the relay's own
    // project root does. An empty field is never the right answer here -- it
    // makes the commonest case (start one where I already am) the most typing.
    if (!$('cs-cwd').value) $('cs-cwd').value = recents[0] || ''
    $('cs-name').value = ''
    $('cs-prompt').value = ''
    $('cs-model').value = 'opus'
    $('cs-effort').value = 'high'
    // Unhidden BEFORE it is positioned: a hidden element measures 0, and the
    // clamp below needs the panel's real size. Both happen in this one task,
    // so the browser never paints it at the previous open's position.
    form.hidden = false
    // The PANEL is clamped into the stage's VISIBLE band. The stage clips and
    // scrolls, so a click near an edge would otherwise open the form part-way
    // outside it -- and `elementFromPoint` over the clipped part returns #app,
    // i.e. the START button is not merely ugly but unclickable. MEASURED, not
    // a constant: the width is canvas.css's 340px and the height depends on
    // the rendered rows, and both would drift from a number written here.
    const vx = stage.scrollLeft, vy = stage.scrollTop
    const px = Math.max(vx, Math.min(x, vx + stage.clientWidth - form.offsetWidth))
    const py = Math.max(vy, Math.min(y, vy + stage.clientHeight - form.offsetHeight))
    form.style.left = Math.round(px) + 'px'; form.style.top = Math.round(py) + 'px'
    requestAnimationFrame(() => $('cs-cwd').focus())
  }

  // The debounce timer is cancelled with the form: a completion that lands
  // after it closes would rebuild a datalist nothing is showing, and would do
  // it against the path from the last time it was open.
  const closeSpawn = () => { clearTimeout(completeTimer); completeTimer = null; form.hidden = true }

  const submitSpawn = async (ev) => {
    ev.preventDefault()
    const cwd = $('cs-cwd').value.trim()
    const prompt = $('cs-prompt').value.trim()
    const name = $('cs-name').value.trim()
    if (!cwd || !prompt) { C.toast('a directory and a kickoff prompt are both required', { kind: 'warn' }); return }
    const go = $('cs-go')
    go.disabled = true
    const r = await C.post('/api/spawn', {
      cwd, name, prompt, model: $('cs-model').value, effort: $('cs-effort').value,
      x: Number(form.dataset.x), y: Number(form.dataset.y),
    })
    go.disabled = false
    if (!r.ok) { C.toast(r.error || 'spawn failed', { ms: 8000, kind: 'warn' }); return }
    closeSpawn()
    C.toast('started ' + r.name + ' · ' + r.shortId + ' in auto mode — it appears here once it reports in', { ms: 7000 })
  }

  // --- attach / view --------------------------------------------------------

  const attach = (deps) => {
    C = deps
    stage = $('cstage'); nodesEl = $('cnodes'); wiresEl = $('cwires'); wctx = wiresEl.getContext('2d')
    form = $('cspawn'); emptyEl = $('cempty')
    $('c-reset').addEventListener('click', async () => {
      const r = await C.post('/api/canvas/reset')
      C.toast(r.error ? 'reset failed: ' + r.error : 'view reset — every node is back in the switchboard layout')
    })
    // Empty canvas only: a right-click on a node or on the form is theirs.
    stage.addEventListener('contextmenu', (ev) => {
      if (ev.target.closest('.cnode, .cspawn')) return
      ev.preventDefault()
      openSpawn(stagePoint(ev))
    })
    // ⌥-click is the keyboard route. (app.js also tracks ⌥ for its steering
    // marks and shows a mode line about it; that is harmless here.)
    stage.addEventListener('click', (ev) => {
      if (!ev.altKey || ev.target.closest('.cnode, .cspawn')) return
      ev.preventDefault()
      openSpawn(stagePoint(ev))
    })
    $('cs-cancel').addEventListener('click', closeSpawn)
    form.addEventListener('submit', submitSpawn)
    // The directory field completes against the real filesystem, through the
    // relay -- the pane has none of its own. `input`, not `keyup`: it fires for
    // a paste and for a datalist pick too, and picking one entry is usually
    // how the NEXT segment gets typed.
    $('cs-cwd').addEventListener('input', (ev) => requestComplete(ev.target.value))
    // ⌘/ctrl + enter starts, from anywhere in the form -- the link dialog's
    // gesture, on the one form here that has a multi-line field. requestSubmit,
    // not submit(): it runs the `submit` handler above AND the browser's own
    // `required` validation, so an empty prompt is refused the same way the
    // button refuses it. A bare enter is left alone: it is a newline in the
    // prompt, and the browser's implicit submission on the single-line fields.
    form.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || !(ev.metaKey || ev.ctrlKey)) return
      ev.preventDefault()
      form.requestSubmit()
    })
    // While the form is open, esc closes it and goes no further -- app.js's own
    // esc would otherwise also close the drawer behind it.
    //
    // CAPTURE, deliberately. Listener order on `window` decides which esc wins,
    // and this one is registered LAST: app.js binds its esc at its top level
    // (the closeDrawer handler) and only calls MCC.attach on its final line, so
    // in the bubble phase app.js has already run and stopImmediatePropagation
    // here would be too late. A capture-phase listener on window runs before
    // every bubble-phase one regardless of registration order, so this is the
    // one place the precedence is actually ours to state.
    //
    // But the innermost thing still closes first. Two of app.js's own overlays
    // can sit ON TOP of this form -- the link dialog, which a wire drag opens
    // over it, and the settings popover, opened by the gear. While either is
    // up, esc is theirs and this listener must fall through to app.js.
    addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || !form || form.hidden) return
      if (!document.getElementById('linkmodal').hidden) return
      if (!document.getElementById('settingspop').hidden) return
      closeSpawn(); ev.stopImmediatePropagation()
    }, true)
    addEventListener('resize', () => { if (active) render() })
  }

  const setView = (name) => {
    active = name === 'canvas'
    if (!active && form) form.hidden = true
    // Leaving the tab mid-gesture ends the gesture. The pointer is captured by
    // a node that is no longer on screen, so no pointerup is coming here, and
    // render() returns early while `drag` is set -- the tab would be dead on
    // return. A move that had not been posted is simply not posted; the classes
    // come off now and the next render fixes the rest.
    if (!active && drag) {
      drag = null
      for (const o of nodesEl.querySelectorAll('.cnode.dragging, .cnode.wiring, .cnode.target')) {
        o.classList.remove('dragging'); o.classList.remove('wiring'); o.classList.remove('target')
      }
    }
    if (active) render()
  }

  return { attach, setView, render }
})()
