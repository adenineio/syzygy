/* The Projects view's half of the shared stage.

   A CLASSIC script. The stage itself is an ES module that imports three and
   Motion and publishes window.MCGS, so it is reached only through that name
   and always optionally. This view imports it on its own first entry, the way
   the other hosting views do, rather than waiting for one of them to have
   been opened; if the import is refused, or there is no WebGL, `ready` stays
   false and the view's own reconciled DOM stays showing.

   Two things live here. The hosting rule: this view boots the stage on its
   own line canvas on every entry, because a bare resume cannot know which
   canvas its caller expects, and it boots on the NEXT FRAME while pausing at
   once -- another hosting view reacts to the same tab switch through a
   microtask, and a pause that landed after a boot would leave the stage
   stopped on the tab that just asked for it. And the worktree card: a
   registered component whose panels are built through the view's own card
   spec, so the card the stage draws shows exactly what the list showed.

   MCGM, MCPMO, MCX and MCG are read when called, never at evaluation: this
   file loads before the sandbox's scripts. */
const MCPS = (() => {
  let toast = null, levelOf = null, stageOf = null, frameOf = null, canvasOf = null
  let renderOf = null, loadOf = null
  const registered = new WeakSet()
  let booted = false
  let failed = false
  let loading = false
  let entered = false
  // Readiness as of the last boot, so the view is redrawn when it changes and
  // not on every entry.
  let wasReady = false
  // Which panel key each mount node belongs to, so a rect can be handed back
  // to the choreography without the view knowing the stage's shape.
  const nodes = new Map()

  const stage = () => (stageOf ? stageOf() : window.MCGS) || null

  // -------------------------------------------------------------- the card
  // Every size is MCPMO's, read when a card is built or laid out, so the grid,
  // the stylesheet and this component share one set of numbers. This view
  // never moves the stage's camera: a world unit stays a CSS pixel, and a card
  // is always drawn at the size the stylesheet gives it.

  // The most one frame may add to a tilt, in degrees, and how long the ramp
  // from a standstill takes.
  const TILT_SLEW = 3
  const TILT_RAMP_S = 0.12
  // A tilted card's hit area shrinks away from the pointer, so a card stays
  // hot until the pointer is this far outside its flat rectangle.
  const HOVER_HYST = 6
  const DEG = Math.PI / 180
  const FLAT = Object.freeze({ rx: 0, ry: 0 })

  // The line frame: a rectangle just outside the border and two corner ticks,
  // reaching CARD_FRAME past it. Static markup, built once from constants.
  let frameSvg = ''
  const frameMarkup = () => {
    if (frameSvg) return frameSvg
    const f = MCPMO.CARD_FRAME
    const w = MCPMO.CARD_W + 2 * f
    const h = MCPMO.CARD_H + 2 * f
    const inset = f / 2 + 0.5
    const tick = 2 * f + 3
    frameSvg =
      `<svg class="pjwtframe" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false">` +
      `<path d="M ${inset} ${inset} H ${w - inset} V ${h - inset} H ${inset} Z"/>` +
      `<path d="M 0.5 ${tick} V 0.5 H ${tick}"/>` +
      `<path d="M ${w - 0.5} ${h - tick} V ${h - 0.5} H ${w - tick}"/>` +
      '</svg>'
    return frameSvg
  }

  /** The largest float scale any calm setting applies. The grid's amplitude
   *  is divided by it, so the widest setting spends exactly the no-contact
   *  bound and every other one stays inside it. */
  let ceiling = 0
  const floatCeiling = () => {
    if (!ceiling) ceiling = Math.max(1, ...MCGM.CALM.map((n) => MCGM.calmScale(n, false).float))
    return ceiling
  }

  const pointerFrom = (s, e) => {
    s.pointer.x = e.clientX
    s.pointer.y = e.clientY
  }

  const release = (s) => {
    const c = s.hot
    if (!c) return
    s.hot = null
    c.inside = false
    MCX.toggle(c.box, 'hot', false)
  }

  const hover = (s, c, e) => {
    // A chip in the strip is ground, and a touch has no hover.
    if (e.pointerType === 'touch' || s.chips) return
    pointerFrom(s, e)
    c.inside = true
    if (s.hot === c) return
    release(s)
    s.hot = c
    c.ramp = 0
    MCX.toggle(c.box, 'hot', true)
  }

  const makeCard = (ctx, s, w, spec, key) => {
    const box = document.createElement('div')
    box.classList.add('pjwtcard')
    const inner = spec.create(w)
    box.appendChild(inner)
    box.insertAdjacentHTML('beforeend', frameMarkup())
    const obj = ctx.panel(box)
    // The panel wrapper turns selection off on its element; a card's text is
    // meant to be readable and selectable.
    box.style.userSelect = 'text'
    box.style.webkitUserSelect = 'text'
    const c = {
      key,
      box,
      inner,
      obj,
      // Born just past the mount's left edge, so its first settle comes in
      // from the rail's side rather than out of the middle.
      body: ctx.body(ctx.id + ':' + key,
        { x: -ctx.w / 2 - MCPMO.CARD_W / 2, y: 0, amp: s.chips ? 0 : s.amp, omega: MCPMO.CARD_OMEGA, object: obj }),
      // The tilt as drawn, in degrees, and how far through its ramp it is.
      // Both live on the card, never recomputed from a clock.
      tilt: FLAT,
      ramp: 0,
      inside: false,
    }
    box.addEventListener('pointerenter', (e) => hover(s, c, e))
    box.addEventListener('pointermove', (e) => { if (s.hot === c) pointerFrom(s, e) })
    box.addEventListener('pointerleave', (e) => {
      if (s.hot !== c) return
      pointerFrom(s, e)
      c.inside = false
    })
    return c
  }

  /** Where every card goes. At the deepest level a strip of chips, each box
   *  sized to its slot by a class and a width, measured from the mount's left
   *  edge; otherwise the card grid, centred on the mount, whose amplitude
   *  every card floats by. Positions only: a data change is a nudge at most,
   *  and nothing here ever scales a card. */
  const layout = (ctx, s) => {
    s.layW = ctx.w
    s.layH = ctx.h
    const n = s.order.length
    const chip = s.chips ? MCPMO.chipSlots(n, ctx.w) : null
    const grid = s.chips ? null : MCPMO.cardGrid(n, ctx.w, floatCeiling())
    s.amp = grid ? grid.amp : 0
    for (let i = 0; i < n; i++) {
      const c = s.cards.get(s.order[i])
      if (!c) continue
      c.body.amp = s.amp
      MCX.toggle(c.box, 'chip', !!chip)
      if (chip) {
        const slot = chip[i]
        c.box.style.width = slot ? slot.w + 'px' : ''
        if (slot) c.body.to(slot.x + slot.w / 2 - ctx.w / 2, 0)
      } else {
        const slot = grid.slots[i]
        c.box.style.width = ''
        if (slot) c.body.to(slot.x - ctx.w / 2, slot.y - grid.height / 2)
      }
    }
  }

  /** One frame of hover. The hot card leans toward the pointer against its
   *  flat rectangle on screen, slewed, with a ramp that restarts whenever the
   *  hot card changes, so a sweep across several cards is one continuous
   *  motion; every other card slews back to flat. */
  const tiltFrame = (ctx, s, dt) => {
    const h = Math.min(Math.max(dt, 0), MCGM.DT_MAX)
    const hot = s.hot
    if (hot) {
      const nr = ctx.node.getBoundingClientRect()
      const R = s.rect
      R.width = MCPMO.CARD_W
      R.height = MCPMO.CARD_H
      R.left = nr.left + ctx.w / 2 + hot.body.px - R.width / 2
      R.top = nr.top + ctx.h / 2 + hot.body.py - R.height / 2
      const p = s.pointer
      if (s.chips || (!hot.inside && (p.x < R.left - HOVER_HYST || p.x > R.left + R.width + HOVER_HYST ||
        p.y < R.top - HOVER_HYST || p.y > R.top + R.height + HOVER_HYST))) release(s)
    }
    for (const c of s.cards.values()) {
      if (c === s.hot) {
        c.ramp = Math.min(TILT_RAMP_S, c.ramp + h)
        c.tilt = MCGM.slewTilt(c.tilt, MCGM.tiltFor(s.pointer, s.rect, MCPMO.CARD_TILT), TILT_SLEW, c.ramp / TILT_RAMP_S)
      } else if (c.tilt.rx !== 0 || c.tilt.ry !== 0) {
        c.tilt = MCGM.slewTilt(c.tilt, FLAT, TILT_SLEW, 1)
      } else {
        continue
      }
      // tiltFor answers in CSS terms, y down; the world is y up, so the
      // rotation about x changes sign and the one about y does not.
      const x = -c.tilt.rx * DEG
      const y = c.tilt.ry * DEG
      if (c.obj.rotation.x !== x) c.obj.rotation.x = x
      if (c.obj.rotation.y !== y) c.obj.rotation.y = y
    }
  }

  /** The registered component. Built by MCGS.register, which calls this once
   *  and refuses an entry missing any of its four hooks. */
  const cardFactory = () => ({
    mount (ctx) {
      const s = ctx.state
      s.cards = new Map()
      s.order = []
      s.chips = false
      s.amp = 0
      s.layW = s.layH = NaN
      s.hot = null
      s.pointer = { x: 0, y: 0 }
      s.rect = { left: 0, top: 0, width: 0, height: 0 }
      s.onMove = (e) => { if (s.hot && !s.hot.inside) pointerFrom(s, e) }
      s.onLeave = () => release(s)
      ctx.node.addEventListener('pointermove', s.onMove)
      ctx.node.addEventListener('pointerleave', s.onLeave)
    },
    /** A diff, run on every render: a card is built only for a key not seen
     *  before, dropped only for a key that has gone, and rewritten in place
     *  through the card's own update every time, as it is built too. The
     *  layout is redone when the set or order of keys changes, or the strip
     *  comes or goes. */
    update (ctx, params, data) {
      const s = ctx.state
      const spec = params && params.spec
      if (!spec) return
      const chips = !!params.chips
      const list = Array.isArray(data) ? data : []
      let moved = chips !== s.chips
      s.chips = chips
      const keys = []
      const seen = new Set()
      for (let i = 0; i < list.length; i++) {
        const key = spec.key(list[i])
        if (seen.has(key)) continue
        seen.add(key)
        let c = s.cards.get(key)
        if (!c) { c = makeCard(ctx, s, list[i], spec, key); s.cards.set(key, c); moved = true }
        spec.update(c.inner, list[i])
        // The card's update lights the row it draws and marks the keyboard's
        // cursor on it; on the stage the box around it carries both, where a
        // border and an outline can show them.
        MCX.toggle(c.box, 'lit', c.inner.classList.contains('lit'))
        MCX.toggle(c.box, 'at', c.inner.classList.contains('at'))
        if (s.order[keys.length] !== key) moved = true
        keys.push(key)
      }
      if (keys.length !== s.order.length) moved = true
      for (const [key, c] of s.cards) {
        if (seen.has(key)) continue
        if (s.hot === c) release(s)
        ctx.dropBody(c.body)
        c.obj.removeFromParent()
        s.cards.delete(key)
        moved = true
      }
      if (moved) {
        s.order = keys
        layout(ctx, s)
      }
    },
    frame (ctx, t, dt) {
      const s = ctx.state
      if (s.layW !== ctx.w || s.layH !== ctx.h) layout(ctx, s)
      tiltFrame(ctx, s, dt)
    },
    unmount (ctx) {
      const s = ctx.state
      ctx.node.removeEventListener('pointermove', s.onMove)
      ctx.node.removeEventListener('pointerleave', s.onLeave)
      s.hot = null
      s.cards.clear()
    },
  })

  // ------------------------------------------------------------ the hosting
  // Once per stage: the stage refuses a name already taken, and there is only
  // ever one stage in a page load.
  const ensure = (g) => {
    if (registered.has(g)) return
    registered.add(g)
    if (typeof g.register === 'function') g.register('worktree-card', cardFactory)
  }

  // This view's own line canvas. Injected so the harness can name it without
  // a document; in the pane it is the element itself, because `boot` moves the
  // one line renderer onto whatever canvas it is handed.
  const canvas = () => (canvasOf ? canvasOf() : document.getElementById('pj-lines'))

  // The calm dial's stored name, when the sandbox that owns it has loaded.
  const calmName = () => (typeof MCG !== 'undefined' && typeof MCG.calm === 'function' ? MCG.calm() : MCGM.CALM_DEFAULT)

  const bootNow = () => {
    const g = stage()
    if (!g || typeof g.boot !== 'function') return
    try {
      g.boot({ glCanvas: canvas() })
      // `boot` returns the stage's own `ready`, which is false without WebGL
      // -- and the DOM layer still draws then, so a mountable stage counts as
      // booted and `ready()` below is what decides whether the cards show.
      booted = typeof g.mount === 'function'
      // The stage keeps whatever calm the last hosting view pushed, and the
      // reader may have turned on reduced motion since.
      if (typeof g.setCalm === 'function') g.setCalm(MCGM.calmScale(calmName(), MCX.reducedMotion()))
    } catch (e) {
      failed = true
      booted = false
      toast?.('projects stage unavailable', { kind: 'warn' })
    }
    // The view's first render ran a frame before this boot, so a change of
    // readiness is what swaps the list for the stage without a payload.
    const now = ready()
    if (now !== wasReady) {
      wasReady = now
      renderOf?.()
    }
  }

  const host = (g) => {
    ensure(g)
    const run = frameOf || ((fn) => requestAnimationFrame(fn))
    run(() => { if (entered) bootNow() })
  }

  const fail = () => {
    loading = false
    if (failed) return
    failed = true
    toast?.('projects stage unavailable', { kind: 'warn' })
  }

  /** Enters the view. With the stage already loaded this registers and boots
   *  on the next frame; otherwise it imports the stage, once, and does the
   *  same when that lands -- unless the view was left meanwhile, when the boot
   *  waits for the next entry rather than pulling the stage off whichever view
   *  is showing. A refused import is one toast for the page load. */
  const enter = () => {
    if (failed) return
    entered = true
    // An entry while the import is in flight leaves the boot to it: the stage
    // can already be there, another view's import having landed first.
    if (loading) return
    const g = stage()
    if (g) { host(g); return }
    loading = true
    let p
    try { p = Promise.resolve(loadOf()) } catch (e) { p = Promise.reject(e) }
    p.then(() => {
      const next = stage()
      if (!next) throw new Error('the stage published nothing')
      loading = false
      if (entered) host(next); else ensure(next)
    }).catch(fail)
  }

  const exit = () => {
    entered = false
    stage()?.pause?.()
  }

  const ready = () => !failed && booted && !!stage()?.ready

  const rectOf = (key) => {
    const n = nodes.get(key)
    return n && typeof n.getBoundingClientRect === 'function' ? n.getBoundingClientRect() : null
  }

  // ------------------------------------------------------------- the graph
  // What this mount last had the stage's graph draw, so a payload tick never
  // re-lays it: only a level, project or selection that actually changed
  // does, once, through this mount alone.
  const graphAt = new WeakMap()

  /** One panel's stage half, given the panel's own mount node. Returns
   *  whether the stage took it; `false` means the caller's own reconciled DOM
   *  is what the reader sees, which is the honest answer without WebGL,
   *  before the stage has booted, and on a stage too old to place one mount
   *  at a time. Mounting is idempotent: the same node with the same id
   *  updates its params and data in place rather than rebuilding. */
  const sync = (node, key, project, L, selected) => {
    if (!node || typeof node.appendChild !== 'function') return false
    const g = stage()
    if (!ready() || !g || typeof g.mount !== 'function') return false
    if (key !== 'graph') return false
    // A graph must be TOLD its level: a fresh mount starts at the top and
    // reads nothing from the stage's own record. And it is told through the
    // per-mount forward, never the stage-wide one, which would walk every
    // other hosting view's graph to this view's level behind the reader.
    if (typeof g.setGraphIn !== 'function') return false
    if (!g.mount(node, 'git-graph', {}, [project])) return false
    nodes.set('graph', node)
    // At level 2 with a branch committed to, that branch; at level 1 with a
    // worktree selected, that one instead, so a plain press retargets the
    // scene without anything travelling; otherwise the project's own level.
    const branch = L && L.level === 2 ? (L.branch || null) : (L && L.level === 1 ? (selected || null) : null)
    const level = branch ? 'commits' : 'worktrees'
    const focus = { project: (project && project.key) || null, branch }
    const at = graphAt.get(node)
    if (at && at.level === level && at.project === focus.project && at.branch === focus.branch) return true
    const took = g.setGraphIn(node, [project], level, focus)
    if (took) graphAt.set(node, { level, project: focus.project, branch: focus.branch })
    return took
  }

  const attach = (deps) => {
    toast = deps.toast || null
    levelOf = deps.level || null
    stageOf = deps.stage || null
    frameOf = deps.frame || null
    canvasOf = deps.canvas || null
    renderOf = deps.render || null
    loadOf = deps.load || (() => import('/sandbox-stage.js'))
  }

  return { attach, enter, exit, ready, rectOf, sync, cardFactory, nodes }
})()
