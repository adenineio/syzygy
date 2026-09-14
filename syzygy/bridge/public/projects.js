/* Syzygy -- the Projects view. Read-only by requirement: every task
   list here is rendered from a file on disk and nothing in this file writes
   one back.

   Three levels in one view. Level 0 is the overview, one row per project.
   Level 1 isolates one project: its siblings shrink into a left rail and its
   panels fill the rest. Level 2 opens one branch's commits. The level is the
   state of a pure reducer (`MCPM.levelReduce`), every row is derived by
   `MCPM`, and this file only draws what those return.

   The overview and the rail draw the DIGEST every pane is sent. An isolated
   project's panels draw its DOCUMENT, its git graph and an opened plan's
   steps, each fetched from a read-only route when shown and fetched again
   when that project's changedAt moves -- drawing what was read before while
   the newer read is in flight.

   Rendered by KEYED RECONCILIATION (`MCX`, reconcile.js). Nothing is torn
   down: a node is reused if its key is still in the payload, moved only if
   its position is actually wrong, and removed only when it genuinely goes
   away.

   Three rules to keep if you edit this file:
     - NEVER assign `node.className`. It would wipe `.gone` and any state class
       out from under `MCX.show`/`MCX.toggle`. Toggle classes individually.
     - Build optional chips unconditionally in `create` and hide them with
       `MCX.show` in `update`. Adding and removing them reintroduces exactly
       the churn reconciliation exists to remove.
     - The level state lives at module scope, never in the DOM. No payload
       carries it, and it has to survive every one of them. */
'use strict'

const MCP = (() => {
  let S = null, post = null, toast = null, el = null, ago = null, needsOf = null
  let active = false

  // The view's own business, which no payload carries: which level, which
  // project, which branch, which lens.
  let L = MCPM.initialState()
  // The isolated project's display name, kept beside `L` so the toast can
  // name a project that has already left the payload.
  let lastName = null
  // The project the stripe's next ask is about, or null for the whole board.
  // `by` says who set it: a scope isolating a project set ends when the view
  // steps back to the overview, while one asked for explicitly stays until
  // escape or a click clears it.
  let scope = null
  // What the Graph panel's head says it is showing, beside its title: empty
  // while the stage draws the scene, else why the text list is standing in.
  let graphNote = ''
  // The last project isolated. Its row keeps the light after stepping back
  // out, so the overview still says where the reader was.
  let litKey = null
  // The worktree selected at the middle level, by branch. The graph follows
  // it without anything travelling; pressing it again goes deeper.
  let selected = null
  // The keyboard's cursor: a project's key at the overview, a worktree's key
  // inside a project. Nothing seats it until a key has moved it, so a reader
  // who never uses the keys never sees it; once they have, it follows them in
  // and out.
  let cursorKey = null
  let keyed = false
  // A half-typed key sequence: `g`, waiting to find out whether it is `gg`.
  let keyPending = ''
  // The project rows' name filter, lower-cased. Empty is no filter.
  let filter = ''
  // Every project's document at once, for the triage walk, which visits the
  // needs-a-human cards of the whole board: `{ status, at, documents }`, `at`
  // the newest changedAt among them. Read when the walk starts, and again once
  // a project on the digest has moved past `at`; while a read is in flight the
  // documents read before it are kept.
  let board = null
  // The walk's direction while the board is being read, so the step lands once
  // it has been. A later press overwrites it: only the latest intent steps.
  let pendingDir = 0

  const DIFF_LABEL = {
    'only-here': 'only here',
    'removed': 'removed',
    'done-here': 'done here',
    'behind': 'behind',
  }
  const DIFF_KINDS = Object.keys(DIFF_LABEL)

  const byId = (id) => document.getElementById(id)
  const projectsOf = () => S.projects || []
  const projectByKey = (key) => projectsOf().find((p) => MCPM.projectKey(p) === key) ?? null

  const plural = (n, word) => n + ' more ' + word + (n === 1 ? '' : 's') + ' over the cap are not shown.'

  // --- motion ----------------------------------------------------------------

  // The Motion bundle, once, on the tab's first show. `null` means not yet
  // asked, `false` means asked and refused -- a refusal latches, so a reader
  // who opens the tab twenty times is not made to re-fetch a bundle that is
  // not there, and the CSS fallback takes over for the rest of the page load.
  let lib = null

  const wantLib = () => {
    if (lib !== null) return
    lib = false
    import('/projects-motion.js')
      .then(() => { lib = window.MCPMO_LIB || false })
      // Marked on the view, which holds every node the fallback moves -- the
      // crumb and the scope chip sit outside the stage. The timing itself is
      // set per step, on the nodes, as each phase starts.
      .catch(() => { MCX.toggle(byId('view-projects'), 'pjfall', true) })
  }

  /** The calm scale as it stands right now, for both engines: the stored dial
   *  name, and the reader's reduced-motion setting read live rather than
   *  cached at load. */
  const calmNow = () => {
    if (typeof MCGM === 'undefined') return { settle: MCX.reducedMotion() ? 0 : 1, float: 0 }
    const name = typeof MCG !== 'undefined' && typeof MCG.calm === 'function' ? MCG.calm() : MCGM.CALM_DEFAULT
    return MCGM.calmScale(name, MCX.reducedMotion())
  }

  /** Motion reads a cubic bezier as four numbers and quietly ignores the CSS
   *  string, so the timeline's stylesheet easings are converted here, where
   *  the library is called, and stay CSS for the fallback path. */
  const easeOf = (css) => {
    const m = /^cubic-bezier\(([^)]*)\)$/.exec(css || '')
    return m ? m[1].split(',').map(Number) : (css || 'linear')
  }

  // Which steps start at once, on the layout being left: an exit has to be
  // seen where it was, and a light or a fade whose node survives the render
  // starts with the press rather than after it. Every other step waits for
  // the render.
  const PHASE_ONE = new Set(['row.light', 'metrics.out', 'scope.fade', 'panel.out', 'panel.out.fade', 'body.out'])

  // Flip targets whose box changes size between the two layouts, and which
  // sides travel. A size animates as a size; nothing here ever scales.
  const SIZED = { rows: ['width'], 'graph.box': ['width', 'height'], 'cards.stage': ['width', 'height'] }

  // Flip targets clipped to their own travelling box, so content already laid
  // out for the far size does not spill over a neighbour on the way.
  const CLIP = new Set(['graph.box', 'cards.stage'])

  // Containers whose overflow opens while a flip on this target runs, so a
  // box still wider than its new home is not clipped mid-flight.
  const LOOSEN = { rows: () => [byId('pj-rail')] }

  // Grids whose tracks keep the sizes the render gave them while a flip on
  // this target runs: a box still drawn at its old size would otherwise
  // resize a row or a column under its neighbours as it travels.
  const panelGrid = () => [byId('pj-panels')]
  const FREEZE = { 'panel.head': panelGrid, 'graph.box': panelGrid, 'cards.stage': panelGrid }

  // Nodes held on screen where they were while a first-phase step on this
  // target plays out -- the render would otherwise hide them before their
  // exit could be seen. A container is pinned to the page; a panel's body is
  // pinned inside its own panel, so it fades out travelling with its head.
  const HOLD = {
    panel: { nodes: () => [byId('pj-panels')], inParent: false },
    'panel.body': { nodes: (ctx) => nodesFor('panel.body', ctx), inParent: true },
  }

  // How far past a step's end its clean-up waits, so its last frame lands.
  const FRAME_SLACK = 32

  // The level change in flight, or null. It records every node and property
  // it wrote, every animation it started, every timer it set and every
  // container it holds, so finishing it early and letting it settle are one
  // and the same clean-up.
  let tr = null

  const put = (t, node, prop, value) => {
    if (!node) return
    let props = t.touched.get(node)
    if (!props) { props = new Set(); t.touched.set(node, props) }
    props.add(prop)
    node.style[prop] = value
  }

  /** One more `transition` part on a node, beside any other step's. */
  const addTransition = (t, node, part) => {
    const was = node.style.transition
    put(t, node, 'transition', was ? was + ', ' + part : part)
  }

  // A step id's suffix names the one node of a group the step plays on.
  const partOf = (s) => {
    const i = s.id.indexOf(':')
    return i < 0 ? null : s.id.slice(i + 1)
  }

  const panelOf = (k) => Array.prototype.slice.call(byId('pj-panels').children)
    .find((n) => n.classList.contains('pj-' + k)) ?? null

  // Where each of the timeline's symbolic targets lives in this view. Asked
  // per phase, because the panels and rows are reconciled nodes and the set
  // of them changes across the render.
  const nodesFor = (target, ctx, part) => {
    if (target === 'rows') return ctx.rows.filter((n) => n.isConnected)
    if (target === 'row.pressed') return ctx.pressed ? [ctx.pressed] : []
    if (target === 'row.metrics') {
      return nodesFor('rows', ctx).map((r) => r.querySelector('.pjcounts')).filter(Boolean)
    }
    if (target === 'panel') {
      const panels = Array.prototype.slice.call(byId('pj-panels').children)
      return part ? panels.filter((n) => n.classList.contains('pj-' + part)) : panels
    }
    if (target === 'panel.head') {
      // Todos and Features fold to their heads and travel whole. The
      // worktrees panel stays in its cell and only its title moves, into the
      // strip; the graph's title rides inside the graph's own box.
      const wt = panelOf('worktrees')
      return [panelOf('todos'), panelOf('features'), wt && wt.querySelector('h3')].filter(Boolean)
    }
    if (target === 'panel.body') {
      return [panelOf('todos'), panelOf('features')].map((n) => n && n.querySelector('.pjbody')).filter(Boolean)
    }
    if (target === 'graph.box') return [panelOf('graph')].filter(Boolean)
    if (target === 'graph.list') {
      const list = panelOf('graph')?.querySelector('.pjlist')
      return list && !list.classList.contains('gone') ? [list] : []
    }
    if (target === 'cards.stage') {
      // The worktrees panel's own body box: its stage while that is drawing,
      // else the text list standing in for it. Never the first stage in the
      // panels, which under the git lens is the graph's.
      const wt = panelOf('worktrees')
      const stage = wt?.querySelector('.pjwtstage')
      if (stage && !stage.classList.contains('gone')) return [stage]
      const list = wt?.querySelector('.pjlist')
      return list ? [list] : []
    }
    if (target === 'crumb2') return [crumb.proj].filter(Boolean)
    if (target === 'crumb3') return [crumb.branch].filter(Boolean)
    if (target === 'scopechip') return ctx.scoped ? [byId('pj-scope')].filter(Boolean) : []
    return []
  }

  const endOf = (steps) => Math.max(0, ...steps.map((s) => s.delay + s.duration))

  // A style read that makes the browser compute what was just written, so a
  // CSS transition set afterwards starts from it.
  const flush = () => { void document.body.offsetWidth }

  /** A step's starting state, written before anything paints, so a delayed
   *  step shows nothing ahead of its delay. A slide that comes to rest is an
   *  arrival and fades in beside it; one that leaves rest is a drift whose
   *  fade is a step of its own. A flip has no starting state until both of
   *  its rects are known, and a light has none at all. */
  const prime = (t, s) => {
    if (s.property !== 'opacity' && s.property !== 'slide') return
    for (const n of nodesFor(s.target, t.ctx, partOf(s))) {
      if (s.property === 'opacity') { put(t, n, 'opacity', String(s.from)); continue }
      put(t, n, 'transform', 'translateX(' + s.from + 'px)')
      if (s.to === 0) put(t, n, 'opacity', '0')
    }
  }

  /** A flip's starting state: the node drawn where it was, at the size it
   *  was, while laid out where it now is. */
  const invert = (t, s) => {
    if (s.property !== 'flip') return
    for (const n of nodesFor(s.target, t.ctx, partOf(s))) {
      const a = t.ctx.before.get(n), b = t.ctx.after.get(n)
      if (!a || !b) continue
      const d = MCPMO.flipDelta(a, b)
      put(t, n, 'transform', 'translate(' + d.dx + 'px, ' + d.dy + 'px)')
      for (const side of SIZED[s.target] || []) put(t, n, side, a[side] + 'px')
      if (CLIP.has(s.target)) put(t, n, 'overflow', 'hidden')
    }
  }

  /** Plays one step, its delay counted from the start of its phase. With the
   *  library every property animates from its starting state to its end;
   *  without it the end is written at once -- a resized box at its far size in
   *  pixels, since a transition cannot run to an automatic size -- and the CSS
   *  transition `fallback` set on the node carries it there. The settle clears
   *  all of it, so every path ends on the stylesheet's own final state. */
  const run = (t, s, at) => {
    const M = lib || null
    const delay = Math.max(0, s.delay - at)
    const opts = { duration: s.duration / 1000, delay: delay / 1000, ease: easeOf(s.ease) }
    for (const n of nodesFor(s.target, t.ctx, partOf(s))) {
      if (s.property === 'accent') {
        // A class change carried by a transition, the same with or without
        // the library, because the colours live in the stylesheet.
        if (s.duration) {
          const timing = ' ' + s.duration + 'ms ' + s.ease + (delay ? ' ' + delay + 'ms' : '')
          addTransition(t, n, 'border-color' + timing)
          addTransition(t, n, 'background-color' + timing)
        }
        MCX.toggle(n, 'lit', s.to > 0)
        continue
      }
      if (s.property === 'flip') {
        const a = t.ctx.before.get(n), b = t.ctx.after.get(n)
        if (!a || !b) continue
        const sides = SIZED[s.target] || []
        if (!M) {
          put(t, n, 'transform', '')
          for (const side of sides) put(t, n, side, b[side] + 'px')
          continue
        }
        const kf = { transform: [n.style.transform, 'translate(0px, 0px)'] }
        for (const side of sides) kf[side] = [a[side] + 'px', b[side] + 'px']
        t.anims.push(M.animate(n, kf, opts))
        continue
      }
      const arrive = s.property === 'slide' && s.to === 0
      if (!M) {
        if (s.property === 'opacity') put(t, n, 'opacity', s.to === 1 ? '' : String(s.to))
        else put(t, n, 'transform', s.to ? 'translateX(' + s.to + 'px)' : '')
        if (arrive) put(t, n, 'opacity', '')
        continue
      }
      const kf = s.property === 'opacity'
        ? { opacity: [s.from, s.to] }
        : { transform: ['translateX(' + s.from + 'px)', 'translateX(' + s.to + 'px)'] }
      if (arrive) kf.opacity = [0, 1]
      t.anims.push(M.animate(n, kf, opts))
    }
  }

  /** Without the library, the CSS transition that carries one step to its end
   *  on the same numbers, its delay counted from the start of its phase. Set
   *  once the step's starting state has been computed and before its end is
   *  written, and cleared by the settle with every other inline style, so it
   *  never fires again on a later payload. One step at a time: a group's steps
   *  each name their own node, and a map folded across the whole group would
   *  hand every panel every delay. */
  const fallback = (t, s, at) => {
    const css = MCPMO.cssFallback([{ ...s, delay: Math.max(0, s.delay - at) }], SIZED)[s.target]
    if (!css) return
    for (const n of nodesFor(s.target, t.ctx, partOf(s))) addTransition(t, n, css)
  }

  /** Pins a held node over the spot it occupies, at its measured box, so the
   *  render beneath it can hide it without the reader seeing that. Held
   *  inside its parent, it is placed against the parent's padding box, and
   *  goes wherever the parent's own flip carries it. */
  const pin = (t, box, inParent) => {
    const r = box.getBoundingClientRect()
    const up = inParent ? box.parentNode : null
    const o = up ? up.getBoundingClientRect() : { left: 0, top: 0 }
    put(t, box, 'left', (r.left - o.left - (up?.clientLeft || 0)) + 'px')
    put(t, box, 'top', (r.top - o.top - (up?.clientTop || 0)) + 'px')
    put(t, box, 'width', r.width + 'px')
    put(t, box, 'height', r.height + 'px')
    MCX.toggle(box, 'pjhold', true)
  }

  const unpin = (box) => {
    MCX.toggle(box, 'pjhold', false)
    for (const p of ['left', 'top', 'width', 'height']) box.style[p] = ''
  }

  /** Every container a table names for these steps' targets, once each. */
  const boxesFor = (table, steps) => {
    const out = new Set()
    for (const s of steps) for (const box of (table[s.target] ? table[s.target]() : [])) if (box) out.add(box)
    return out
  }

  /** Holds a grid's tracks at the sizes it is using right now. */
  const freeze = (t, box) => {
    const cs = getComputedStyle(box)
    put(t, box, 'gridTemplateColumns', cs.gridTemplateColumns)
    put(t, box, 'gridTemplateRows', cs.gridTemplateRows)
  }

  /** Ends a level change at its final state, early or on time: stops every
   *  animation it started, draws the render it was still holding back, lets
   *  go of whatever it held and clears every inline style it wrote, so the
   *  stylesheet is the only thing left deciding how the view looks. */
  const settle = (t) => {
    if (!t || tr !== t) return
    tr = null
    for (const id of t.timers) clearTimeout(id)
    for (const a of t.anims) { try { a.cancel() } catch (e) { /* already gone */ } }
    if (t.phase === 1) draw()
    for (const h of t.holds) MCX.toggle(h.box, 'pjhold', false)
    for (const [node, props] of t.touched) for (const p of props) node.style[p] = ''
  }

  /** One level change, in two phases. At once: every starting state is
   *  written and the first-phase steps play on the layout being left. At the
   *  first flip's delay: the render, the second measurement, and the rest of
   *  the steps, their delays counted from there. When the last step ends,
   *  the settle. */
  const play = (steps, ctx) => {
    const flips = steps.filter((s) => s.property === 'flip')
    const one = steps.filter((s) => PHASE_ONE.has(s.id))
    const two = steps.filter((s) => !PHASE_ONE.has(s.id))
    const t = {
      ctx, phase: 1, anims: [], timers: [], touched: new Map(), holds: [],
      at: flips.length ? Math.min(...flips.map((s) => s.delay)) : 0,
    }
    tr = t
    const later = (ms, fn) => { t.timers.push(setTimeout(fn, ms)) }
    // Scheduled before anything can throw: a change that never settles would
    // hold every later render back for good.
    later(endOf(steps) + FRAME_SLACK, () => settle(t))

    for (const s of steps) prime(t, s)
    // Without the library each step's transition goes on only after its
    // starting state has been computed, or the starting state would animate.
    if (!lib) { flush(); for (const s of one) fallback(t, s, 0) }
    for (const s of one) run(t, s, 0)

    for (const target of Object.keys(HOLD)) {
      const end = endOf(one.filter((s) => s.target === target))
      // Held only when its exit outlasts the render that would hide it.
      if (end <= t.at) continue
      for (const box of HOLD[target].nodes(ctx).filter(Boolean)) {
        t.holds.push({ box, inParent: HOLD[target].inParent })
        later(end + FRAME_SLACK, () => { if (tr === t) unpin(box) })
      }
    }

    const second = () => {
      if (tr !== t) return
      t.phase = 2
      for (const h of t.holds) pin(t, h.box, h.inParent)
      draw()
      for (const s of flips) {
        for (const n of nodesFor(s.target, ctx, partOf(s))) {
          if (ctx.before.has(n)) ctx.after.set(n, n.getBoundingClientRect())
        }
      }
      for (const box of boxesFor(FREEZE, flips)) freeze(t, box)
      // Starting states again, for the nodes the render has only now built.
      for (const s of two) prime(t, s)
      for (const box of boxesFor(LOOSEN, flips)) put(t, box, 'overflow', 'visible')
      for (const s of two) invert(t, s)
      if (!lib) { flush(); for (const s of two) fallback(t, s, t.at) }
      for (const s of two) run(t, s, t.at)
    }
    if (t.at > 0) later(t.at, second); else second()
  }

  /** What isolating a project changes beyond the level: its row takes the
   *  light, which it keeps as the last one visited, and the stripe's ask is
   *  scoped to it without taking focus from wherever the reader is. Returns
   *  whether the scope chip changed, which is what its cross-fade plays on. */
  const isolated = (key) => {
    litKey = key
    const p = projectByKey(key)
    if (!p || scope?.project === key) return false
    setScope(p, 'isolate')
    return true
  }

  const dispatchAction = (action) => {
    const next = MCPM.levelReduce(L, action)
    // Reference equality, which `levelReduce` guarantees for a no-op: an
    // action that changed nothing must not cost a render.
    if (next === L) return
    // The selection belongs to one project's middle level: another project or
    // the overview forgets it, and opening a branch selects that branch, so
    // stepping back out still shows which one it was.
    if (next.project !== L.project || next.level === 0) selected = null
    if (next.level === 2) selected = next.branch
    const from = L.level
    if (keyed && (from !== next.level || next.project !== L.project)) cursorKey = seatFor(L, next)
    const entering = !!next.project && next.project !== L.project
    if (entering) lastName = projectByKey(next.project)?.name ?? null
    if (from !== next.level) {
      // A level change arriving while another is in flight lands that one at
      // its final state first.
      settle(tr)
      wantLib()
    }
    const steps = from === next.level ? [] : MCPMO.timeline(from, next.level, calmNow())
    // Nothing to travel -- the same level, a hidden view, or the dial at still
    // -- is the final state at once: no timer, no animation, no inline style.
    if (!active || !steps.some((s) => s.duration > 0 || s.delay > 0)) {
      L = next
      if (entering) isolated(next.project)
      render()
      return
    }
    // Every node a flip in this timeline names -- the rows, the panel heads,
    // the graph's box, the cards' box -- measured in the layout it is
    // leaving, before anything is written or rendered.
    const ctx = { before: new Map(), after: new Map(), rows: [], pressed: null, scoped: false }
    const leaving = byId(from >= 1 ? 'pj-rail' : 'projlist')
    ctx.rows = Array.prototype.slice.call(leaving.children).filter((n) => MCX.keyOf(n) !== undefined)
    for (const s of steps) {
      if (s.property !== 'flip') continue
      for (const n of nodesFor(s.target, ctx, partOf(s))) ctx.before.set(n, n.getBoundingClientRect())
    }
    L = next
    if (entering) {
      ctx.pressed = ctx.rows.find((n) => MCX.keyOf(n) === next.project) ?? null
      ctx.scoped = isolated(next.project)
      for (const n of ctx.rows) if (n !== ctx.pressed) MCX.toggle(n, 'lit', false)
    }
    play(steps, ctx)
  }

  /** Selects a worktree at the middle level: its card lights and the graph
   *  follows that branch, while nothing travels. Going deeper is a second
   *  press on the same card, never this. */
  const selectWorktree = (branch) => {
    selected = branch
    // A level change in flight draws the selection when it lands; a fade laid
    // over it would take its record and leave its styles behind.
    if (tr && !tr.ctx.retarget) { render(); return }
    settle(tr)
    const steps = MCPMO.retargetSteps(calmNow())
    if (!active || !steps.some((s) => s.duration > 0 || s.delay > 0)) { render(); return }
    play(steps, { before: new Map(), after: new Map(), rows: [], pressed: null, scoped: false, retarget: true })
  }

  // --- session chips ---------------------------------------------------------

  // A chip is a session that is present right now. Clicking one starts or
  // completes a channel between two sessions, the same gesture the board uses.
  const CHIP = {
    key: (c) => c.s.id,
    create: (c) => {
      const id = c.s.id
      const b = el('button', 'schip')
      b.onclick = () => {
        if (S.linkFrom && S.linkFrom !== id) {
          post('/api/link', { from: S.linkFrom, to: id, kind: 'brief', note: '' })
          // "queued", not "sent": sendBrief reports on queueing, not delivery.
          toast('channel queued — ' + S.linkFrom.slice(0, 6) + ' → ' + b.textContent)
          S.linkFrom = null
        } else {
          S.linkFrom = id
          S.focus = id
          toast('pick another session to open a channel, or press esc')
        }
        render()
      }
      return b
    },
    update: (b, c) => {
      MCX.setText(b, c.s.name)
      MCX.toggle(b, 'working', c.s.working)
      // The payload's copy of a session carries no waiting state; the board's
      // own session does, and `needsOf` is the one place that reads it.
      const live = needsOf ? (S.sessions || []).find((x) => x.id === c.s.id) : null
      MCX.toggle(b, 'needs', !!(live && needsOf(live)))
      MCX.setAttr(b, 'title', 'cwd ' + c.wt.path)
    },
  }

  // --- the project list: the overview, and the same rows as the rail ----------

  const COUNTS = [
    { field: 'inFlight', cls: 'pjc-flight', label: (n) => n + ' in flight' },
    { field: 'backlog', cls: 'pjc-backlog', label: (n) => n + ' backlog' },
    { field: 'behind', cls: 'pjc-behind', label: (n) => n + ' behind' },
    { field: 'worktrees', cls: 'pjc-wt', label: (n) => n + (n === 1 ? ' worktree' : ' worktrees') },
    { field: 'needs', cls: 'pjc-needs', label: (n) => n + (n === 1 ? ' needs' : ' need') + ' a human' },
  ]

  // Plain isolates; shift opens the project in the canvas, alt scopes the
  // stripe's ask to it, and command starts a plan request for it in the
  // stripe, all without leaving the current level.
  const onProjectClick = (ev, key) => {
    // A session chip inside the row is its own control.
    if (ev.target.closest('.schip')) return
    const p = projectByKey(key)
    if (p && ev.metaKey) { ev.preventDefault(); planTemplate(p); return }
    if (p && ev.shiftKey) { ev.preventDefault(); openInCanvas(p); return }
    if (p && ev.altKey) { ev.preventDefault(); askAbout(p); return }
    dispatchAction({ type: 'isolate', project: key })
  }

  // One spec for both containers. A project's row in the rail is the same
  // element it was in the overview, carried across and re-laid by a class.
  const PROW = {
    key: (r) => r.k,
    create: (r) => {
      if (r.kind === 'empty') return el('div', 'empty')
      if (r.kind === 'overcap') return el('div', 'overcap')
      const key = r.key
      const row = el('div', 'pjrow')
      row.appendChild(el('span', 'pjname'))
      row.appendChild(el('span', 'pjroot'))
      row.appendChild(el('span', 'pjsess'))
      const counts = el('span', 'pjcounts')
      for (const c of COUNTS) counts.appendChild(el('span', 'pjchip ' + c.cls))
      counts.lastChild.classList.add('needs')
      row.appendChild(counts)
      row.addEventListener('click', (ev) => onProjectClick(ev, key))
      return row
    },
    update: (row, r) => {
      if (r.kind !== 'project') return MCX.setText(row, r.text)
      MCX.toggle(row, 'inrail', r.inRail)
      MCX.toggle(row, 'active', !!r.active)
      MCX.toggle(row, 'lit', r.key === litKey)
      MCX.toggle(row, 'at', L.level === 0 && r.key === cursorKey)
      MCX.setText(row.querySelector('.pjname'), r.name)
      const root = row.querySelector('.pjroot')
      MCX.setText(root, r.root)
      MCX.show(root, !!r.root)
      MCX.reconcile(row.querySelector('.pjsess'), r.sessions.map((s) => ({ s, wt: { path: s.cwd } })), CHIP)
      for (const c of COUNTS) {
        const chip = row.querySelector('.' + c.cls)
        const n = r[c.field] ?? 0
        MCX.setText(chip, c.label(n))
        MCX.show(chip, n > 0)
      }
    },
  }

  const listRows = (projects, inRail) => {
    if (!projects.length) {
      return [{ k: 'empty', kind: 'empty', text: 'No projects yet. They appear as sessions report in.' }]
    }
    const rows = []
    // Over a cap is reported, never silently dropped. The count is the same
    // on every project, so the first one carries it for all.
    const over = projects[0].overCap ? projects[0].overCap.projects : 0
    if (over) rows.push({ k: 'overcap', kind: 'overcap', text: plural(over, 'project') })
    const data = inRail
      ? MCPM.railRows(projects, L.project, { lens: L.lens })
      : MCPM.overviewRows(projects, { lens: L.lens })
    // The filter narrows by name, and never hides the project the reader is in.
    const shown = filter
      ? data.filter((r) => r.key === L.project || String(r.name).toLowerCase().includes(filter))
      : data
    for (const r of shown) rows.push({ ...r, kind: 'project', inRail })
    if (!shown.length) rows.push({ k: 'nomatch', kind: 'empty', text: 'No project matches "' + filter + '".' })
    return rows
  }

  // Moves every row this module reconciled out of one container into the
  // other, before the reconcile runs, so `MCX` finds each project's node by
  // its key in the new place and reuses it rather than building a twin.
  const carry = (from, to) => {
    for (const n of Array.prototype.slice.call(from.children)) {
      if (MCX.keyOf(n) !== undefined) to.appendChild(n)
    }
  }

  const renderList = (projects) => {
    const list = byId('projlist'), rail = byId('pj-rail')
    const inRail = L.level >= 1
    if (inRail) carry(list, rail); else carry(rail, list)
    MCX.reconcile(inRail ? rail : list, listRows(projects, inRail), PROW)
    MCX.show(rail, inRail)
    MCX.show(list, !inRail)
  }

  // --- the crumb and the lens label ------------------------------------------

  const crumb = { all: null, sep1: null, proj: null, sep2: null, branch: null }

  const crumbButton = (to) => {
    const b = el('button', 'pjcr')
    b.type = 'button'
    b.addEventListener('click', () => dispatchAction({ type: 'crumb', to }))
    return b
  }

  const buildCrumb = () => {
    const nav = byId('pj-crumb')
    crumb.all = crumbButton(0)
    crumb.all.textContent = 'all projects'
    crumb.sep1 = el('span', 'pjsep', '›')
    crumb.proj = crumbButton(1)
    crumb.sep2 = el('span', 'pjsep', '›')
    crumb.branch = crumbButton(2)
    for (const n of [crumb.all, crumb.sep1, crumb.proj, crumb.sep2, crumb.branch]) nav.appendChild(n)
  }

  const renderCrumb = (p) => {
    MCX.setText(crumb.proj, p ? p.name : '')
    MCX.setText(crumb.branch, L.branch || '')
    MCX.show(crumb.sep1, L.level >= 1)
    MCX.show(crumb.proj, L.level >= 1)
    MCX.show(crumb.sep2, L.level === 2)
    MCX.show(crumb.branch, L.level === 2)
    MCX.toggle(crumb.all, 'here', L.level === 0)
    MCX.toggle(crumb.proj, 'here', L.level === 1)
    MCX.toggle(crumb.branch, 'here', L.level === 2)
  }

  // The active lens, and while triage runs, where the walk is. A label, not a
  // control: the keys are the interface and the tooltip names them.
  const renderLens = (cards) => {
    const lens = byId('pj-lens')
    let text = 'lens · ' + L.lens
    if (pendingDir) {
      text = 'triage · reading the board… · ' + text
    } else if (L.triage) {
      text = (cards.length
        ? 'triage ' + (Math.min(L.triageAt, cards.length - 1) + 1) + '/' + cards.length
        : 'triage · nothing needs a human') + ' · ' + text
    }
    MCX.setText(lens, text)
    MCX.toggle(lens, 'triage', L.triage || !!pendingDir)
  }

  // --- the scope of the stripe's ask ------------------------------------------

  const clearScope = () => {
    scope = null
    const chip = byId('pj-scope')
    MCX.setText(chip, '')
    MCX.show(chip, false)
  }

  // Never takes focus: isolating a project scopes the ask too, and must not
  // pull the reader out of wherever they are.
  const setScope = (p, by) => {
    scope = { project: MCPM.projectKey(p), by }
    const chip = byId('pj-scope')
    MCX.setText(chip, 'about ' + p.name)
    MCX.show(chip, true)
  }

  // --- the verbs -----------------------------------------------------------------

  const current = () => (L.project ? projectByKey(L.project) : null)

  const openTab = (view) => document.querySelector('.tab[data-view="' + view + '"]')?.click()

  // A request just filed opens where it can be written up.
  const openRequest = (res, what) => {
    if (!res || res.error || !res.request) {
      toast('could not queue it: ' + (res?.error || 'no request came back'), { kind: 'warn' })
      return
    }
    toast(what + ' queued in Dispatch')
    openTab('dispatch')
    MCD.openThread(res.request.id)
  }

  /** Plan this: a backlog heading or a spec becomes a request to plan it.
   *  The mapping back to the heading travels in the ask text. */
  const planThis = async (p, { rel, slug, text }) => {
    const ask = MCPM.planAsk({ rel, slug, text })
    if (!ask) { toast('nothing to plan against: no file is named', { kind: 'warn' }); return }
    const res = await post('/api/request/create', { title: MCPM.requestTitle(text), project: p.mainRoot, ask })
    openRequest(res, 'plan')
  }

  /** Implement this: an existing plan becomes a request to build it as
   *  written. Refused while a session present on the board holds its claim,
   *  unless forced; a claim left by a session that has ended blocks nothing. */
  const implementThis = async (p, e, force) => {
    const live = MCPM.liveClaims(e.claimedBy, S.sessions)
    if (live.length && !force) {
      toast('claimed by ' + live.map((c) => c.name).join(', ') + ' — shift-click to file anyway',
            { kind: 'warn', ms: 6000 })
      return
    }
    const ask = MCPM.implementAsk(e)
    if (!ask) { toast('this plan has no path to implement', { kind: 'warn' }); return }
    const res = await post('/api/request/create', { title: MCPM.requestTitle(e.title || e.name), project: p.mainRoot, ask })
    openRequest(res, 'implementation')
  }

  /** Ask about this project: the stripe's field, scoped to it and focused. */
  const askAbout = (p) => {
    setScope(p, 'ask')
    byId('pj-ask').focus()
  }

  /** Open in Canvas: that tab, with this project's live sessions ringed. */
  const openInCanvas = (p) => {
    const ids = MCPM.liveSessionIds(p)
    openTab('canvas')
    // On the next frame: the canvas's nodes measure zero while its view is
    // still hidden.
    requestAnimationFrame(() => MCC.spotlight(ids))
    if (!ids.length) toast(p.name + ' has no live session on the canvas')
  }

  const copy = (text, what) => {
    const done = () => toast('copied ' + what)
    const fail = () => toast('could not copy ' + what, { kind: 'warn' })
    try { navigator.clipboard.writeText(text).then(done, fail) } catch { fail() }
  }

  const renderHead = (p) => {
    MCX.show(byId('pj-head'), !!p)
    MCX.setText(byId('pj-h-name'), p ? p.name : '')
    MCX.setText(byId('pj-h-root'), p ? p.mainRoot : '')
  }

  // --- needs-a-human cards -------------------------------------------------------

  // Which needs-a-human cards are opened out. Collapsed, a card is one line
  // in a grid; open, it shows where and how to fix. Keyed by the card's own
  // key so the choice survives a re-render; a plain click toggles one card,
  // a shift-click opens or closes them all together.
  const openCards = new Set()
  // The latest row each node was drawn from (shared with the panels below).
  const dataOf = new WeakMap()

  const CARD = {
    key: (c) => c.k,
    create: (c) => {
      const card = el('div', 'pjcard')
      card.appendChild(el('div', 'pjwhat'))
      card.appendChild(el('div', 'pjwhere'))
      card.appendChild(el('div', 'pjfix'))
      card.addEventListener('click', (ev) => {
        const k = dataOf.get(card)?.k
        if (!k) return
        if (ev.shiftKey) {
          const all = Array.from(byId('pj-cards').children).map((n) => dataOf.get(n)?.k).filter(Boolean)
          const allOpen = all.every((x) => openCards.has(x))
          for (const x of all) { if (allOpen) openCards.delete(x); else openCards.add(x) }
        } else if (openCards.has(k)) openCards.delete(k)
        else openCards.add(k)
        renderCards(lastCardsDoc, lastCardsCursor)
      })
      return card
    },
    update: (card, c) => {
      dataOf.set(card, c)
      MCX.toggle(card, 'at', c.at)
      MCX.toggle(card, 'open', openCards.has(c.k))
      MCX.setText(card.querySelector('.pjwhat'), c.what)
      const where = card.querySelector('.pjwhere')
      MCX.setText(where, c.where ? 'where: ' + c.where : '')
      MCX.show(where, !!c.where)
      MCX.setText(card.querySelector('.pjfix'), c.fix)
    },
  }

  let lastCardsDoc = null
  let lastCardsCursor = null
  const renderCards = (doc, cursorKey) => {
    lastCardsDoc = doc; lastCardsCursor = cursorKey
    const box = byId('pj-cards')
    const cards = doc ? MCPM.needsHumanCards(doc) : []
    MCX.show(box, cards.length > 0)
    MCX.reconcile(box, cards.map((c) => ({ ...c, at: c.k === cursorKey })), CARD)
  }

  // --- inside a project: four panels -----------------------------------------

  // The latest row each node was drawn from. A click reads it here rather than
  // closing over the row `create` saw, which a later payload has replaced.

  // Opened-out backlog headings and efforts. Keyed by project AND row, since
  // two projects can carry a heading or a plan of the same name.
  const openBacklog = new Set()
  const expanded = new Set()
  const openKey = (row) => (L.project ?? '') + '\u0000' + row.k

  const note = (k, text) => ({ k, kind: 'note', text })

  const claimText = (claimedBy) => {
    const live = MCPM.liveClaims(claimedBy, S.sessions)
    return live.length ? 'claimed: ' + live.map((c) => c.name).join(', ') : ''
  }

  const setChip = (node, text) => { MCX.setText(node, text); MCX.show(node, !!text) }

  // A checkbox step, beneath a backlog heading or inside an effort.
  const STEP = {
    key: (r) => r.k,
    create: (r) => {
      if (r.kind === 'note') return el('div', 'plannote')
      const row = el('div', 'titem')
      row.appendChild(el('span', 'tbox'))
      row.appendChild(el('span', 'ttext'))
      return row
    },
    update: (row, r) => {
      if (r.kind === 'note') return MCX.setText(row, r.text)
      const it = r.item
      MCX.toggle(row, 'current', !!it.current)
      MCX.setText(row.querySelector('.tbox'), it.reported ? '[~]' : it.checked === true ? '[x]' : it.checked === false ? '[ ]' : '')
      MCX.setText(row.querySelector('.ttext'), it.text)
    },
  }

  const stepRows = (items, empty) => items.length
    ? items.map((it) => ({ k: 'i:' + it.k, kind: 'item', item: it }))
    : [note('note', empty)]

  // --- the fetched halves of a project --------------------------------------
  // One cache per route, keyed so a project that moves on is asked for again:
  //   docs    project key -> { status, changedAt, project }     its document
  //   graphs  project key -> { status, changedAt, gitGraph }    its git graph
  //   steps   [key, worktree, plan] -> { status, changedAt, plan }   one plan
  // Every entry is recorded at the changedAt it was asked for, never the
  // answer's own, so an answer newer than this pane's digest is not asked for
  // again on every render until the next frame arrives.
  const docs = new Map()
  const graphs = new Map()
  const steps = new Map()
  const stepKey = (key, wt, rel) => JSON.stringify([key, wt, rel])

  /** What an entry read before a newer read began, carried into the loading
   *  entry so it stays drawn. A 404 or a failure carries nothing forward. */
  const readBefore = (entry, field) =>
    (entry && (entry.status === 'ok' || entry.status === 'loading') && entry[field] !== undefined
      ? { [field]: entry[field] }
      : {})

  /** One GET into one cache entry. `entry` is the loading entry; `read` turns
   *  a 200's body into the fields an ok entry adds, or null for a body that is
   *  not one. A 404 settles `missing` and any other failure `error`. An answer
   *  is dropped when its entry was replaced or evicted while it was in flight. */
  const load = (cache, k, entry, url, read) => {
    cache.set(k, entry)
    fetch(url)
      .then((r) => {
        if (r.status === 404) return 'missing'
        if (!r.ok) return 'error'
        return r.json().then((d) => read(d) ?? 'error')
      })
      .catch(() => 'error')
      .then((got) => {
        if (cache.get(k) !== entry) return
        cache.set(k, typeof got === 'string' ? { ...entry, status: got } : { ...entry, ...got, status: 'ok' })
        if (active) render()
      })
  }

  /** Asks for the isolated project's document and git graph when the caches do
   *  not hold them at its changedAt, and drops every entry belonging to a
   *  project no longer on the board. With nothing isolated it only drops: the
   *  overview reads the digest alone. */
  const ask = (projects, p) => {
    const key = p ? MCPM.projectKey(p) : null
    const at = p?.changedAt ?? null
    const want = key ? [key] : []
    const d = MCPM.docPlan(projects, docs, { want })
    for (const k of d.evict) docs.delete(k)
    for (const k of d.fetch) {
      load(docs, k, { status: 'loading', changedAt: at, ...readBefore(docs.get(k), 'project') },
        '/api/projects/' + encodeURIComponent(k),
        (body) => (body?.project ? { project: body.project } : null))
    }
    const g = MCPM.docPlan(projects, graphs, { want })
    for (const k of g.evict) graphs.delete(k)
    for (const k of g.fetch) {
      load(graphs, k, { status: 'loading', changedAt: at, ...readBefore(graphs.get(k), 'gitGraph') },
        '/api/projects/graph?key=' + encodeURIComponent(k),
        (body) => (body && typeof body === 'object' && 'gitGraph' in body ? { gitGraph: body.gitGraph } : null))
    }
    const onBoard = new Set(projects.map(MCPM.projectKey))
    for (const k of [...steps.keys()]) if (!onBoard.has(JSON.parse(k)[0])) steps.delete(k)
  }

  /** A project's document as its panels draw it, and the sentence to show
   *  when there is none. Reads the cache; asks for nothing. */
  const docOf = (p) => (p ? MCPM.docNeed(p, docs.get(MCPM.projectKey(p))) : { need: null, note: null, project: null })

  /** The Graph panel's text rows: the branches with `branch` null, one
   *  branch's commits otherwise. A null graph -- not a repository, or git
   *  could not be asked -- passes through as null; a relay without the route
   *  answers 404, and graphRows has a sentence for each. */
  const graphRowsFor = (p, branch) => {
    const g = graphs.get(MCPM.projectKey(p))
    if (g && 'gitGraph' in g && (g.status === 'ok' || g.status === 'loading')) return MCPM.graphRows(g.gitGraph, branch)
    if (g?.status === 'missing') return MCPM.graphRows(undefined, branch)
    if (g?.status === 'error') return [note('note', 'history could not be read')]
    return [note('note', 'loading…')]
  }

  const fetchSteps = (key, at, { wt, rel }) => {
    const k = stepKey(key, wt, rel)
    load(steps, k, { status: 'loading', changedAt: at, ...readBefore(steps.get(k), 'plan') },
      '/api/projects/plan?wt=' + encodeURIComponent(wt ?? '') + '&path=' + encodeURIComponent(rel),
      (d) => (d?.plan ? { plan: d.plan } : null))
  }

  // An opened plan's steps, fetched from the plan route: neither the digest
  // nor the document carries them. Cached by project key and changedAt, so a
  // plan is read again after a scan moves its project on, and its steps read
  // before that stay drawn until the newer read lands.
  const effortRows = (p, e) => {
    const key = MCPM.projectKey(p)
    const at = p.changedAt ?? null
    const look = () => MCPM.effortStepsView(p, e, (wt, rel) => {
      const entry = steps.get(stepKey(key, wt, rel))
      if (!entry || entry.changedAt !== at) return undefined
      if (entry.status === 'loading' && entry.plan) return { status: 'ok', plan: entry.plan }
      return entry
    })
    let view = look()
    if (view.need) {
      fetchSteps(key, at, view.need)
      view = look()
    }
    return view.steps ? stepRows(view.steps, 'no checkbox steps') : [note('note', view.note)]
  }

  // --- Worktrees ---

  // Plain selects at the middle level and opens the branch once selected;
  // shift jumps to the worktree's live session; alt copies its path.
  const onWorktreeHead = (ev, card) => {
    const w = dataOf.get(card)
    if (!w) return
    if (ev.shiftKey) {
      ev.preventDefault()
      const s = w.sessions[0]
      if (!s) { toast('no live session in this worktree'); return }
      post('/api/jump', { id: s.id }).then((r) => { if (r?.error) toast('could not jump: ' + r.error, { kind: 'warn' }) })
      return
    }
    if (ev.altKey) { ev.preventDefault(); copy(w.path, 'path'); return }
    if (w.detached || !w.branch) return
    if (L.level === 1 && selected !== w.branch) { selectWorktree(w.branch); return }
    dispatchAction({ type: 'branch', branch: w.branch })
  }

  const WTCARD = {
    key: (w) => w.k,
    create: () => {
      const card = el('div', 'pjwt')
      const head = el('div', 'pjwthead')
      head.appendChild(el('span', 'wtbadge', 'main'))
      head.appendChild(el('span', 'wtbranch'))
      head.appendChild(el('span', 'wthash'))
      head.appendChild(el('span', 'pjchip pjlocked', 'locked'))
      head.addEventListener('click', (ev) => onWorktreeHead(ev, card))
      card.appendChild(head)
      card.appendChild(el('div', 'pjwtpath'))
      const chips = el('div', 'pjwtchips')
      chips.appendChild(el('span', 'pjsess'))
      for (const d of DIFF_KINDS) chips.appendChild(el('span', 'tdiff ' + d))
      card.appendChild(chips)
      return card
    },
    update: (card, w) => {
      dataOf.set(card, w)
      const head = card.querySelector('.pjwthead')
      MCX.toggle(card, 'main', w.isMain)
      MCX.toggle(card, 'detached', w.detached || !w.branch)
      MCX.toggle(card, 'lit', !!selected && w.branch === selected)
      MCX.toggle(card, 'at', L.level >= 1 && w.k === cursorKey)
      MCX.show(head.querySelector('.wtbadge'), w.isMain)
      MCX.setText(head.querySelector('.wtbranch'), w.branch || (w.detached ? 'detached' : '—'))
      MCX.setText(head.querySelector('.wthash'), w.head)
      MCX.show(head.querySelector('.pjlocked'), w.locked)
      MCX.setText(card.querySelector('.pjwtpath'), w.path)
      MCX.reconcile(card.querySelector('.pjsess'), w.sessions.map((s) => ({ s, wt: w })), CHIP)
      for (const d of DIFF_KINDS) {
        const n = w.diff[d] ?? 0
        setChip(card.querySelector('.tdiff.' + d), n ? n + ' ' + DIFF_LABEL[d] : '')
      }
    },
  }

  // --- Todos ---

  const planBacklog = (b) => {
    const p = current()
    if (p) planThis(p, { rel: b.rel, slug: b.slug, text: b.label })
  }

  // Plain opens the heading; shift plans it; alt copies its slug.
  const onBacklog = (ev, box) => {
    const b = dataOf.get(box)
    if (!b || ev.target.closest('.pjbtn')) return
    if (ev.shiftKey) { ev.preventDefault(); planBacklog(b); return }
    if (ev.altKey) {
      ev.preventDefault()
      if (b.slug) copy(b.slug, 'slug'); else toast('this heading has no slug')
      return
    }
    const key = openKey(b)
    if (openBacklog.has(key)) openBacklog.delete(key); else openBacklog.add(key)
    render()
  }

  const BACKLOG = {
    key: (r) => r.k,
    create: (r) => {
      if (r.kind === 'note') return el('div', 'plannote')
      const box = el('div', 'pjbl')
      const head = el('div', 'pjblhead')
      head.appendChild(el('span', 'plancaret'))
      head.appendChild(el('span', 'pjbltext'))
      head.appendChild(el('span', 'pjchip pjclaim'))
      const plan = el('button', 'pjbtn pjplan', 'plan this')
      plan.type = 'button'
      plan.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const b = dataOf.get(box)
        if (b) planBacklog(b)
      })
      head.appendChild(plan)
      head.addEventListener('click', (ev) => onBacklog(ev, box))
      box.appendChild(head)
      box.appendChild(el('div', 'pjblbody'))
      return box
    },
    update: (box, b) => {
      if (b.kind === 'note') return MCX.setText(box, b.text)
      dataOf.set(box, b)
      const open = openBacklog.has(openKey(b))
      MCX.toggle(box, 'struck', b.struck)
      MCX.setText(box.querySelector('.plancaret'), open ? '▾' : '▸')
      MCX.setText(box.querySelector('.pjbltext'), b.label)
      MCX.setAttr(box.querySelector('.pjbltext'), 'title', b.rel && b.slug ? b.rel + '#' + b.slug : null)
      setChip(box.querySelector('.pjclaim'), claimText(b.claimedBy))
      const body = box.querySelector('.pjblbody')
      MCX.show(body, open)
      MCX.reconcile(body, open ? stepRows(b.body, 'nothing written beneath this heading') : [], STEP)
    },
  }

  // A declared `Tasks:` reference, drawn under the effort that declared it.
  // Clicking one opens that heading in the backlog beside it.
  const TASKCHIP = {
    key: (c) => c.k,
    create: () => {
      const chip = el('span', 'pjtask')
      chip.addEventListener('click', () => {
        const c = dataOf.get(chip)
        const p = L.project ? projectByKey(L.project) : null
        const doc = p ? docOf(p).project : null
        const hit = c && doc ? MCPM.todosOf(doc).backlog.find((b) => b.slug === c.slug) : null
        if (!hit) return
        openBacklog.add(openKey({ k: 'b:' + hit.k }))
        render()
      })
      return chip
    },
    update: (chip, c) => {
      dataOf.set(chip, c)
      MCX.setText(chip, c.text)
      MCX.setAttr(chip, 'title', c.ref)
    },
  }

  // Plain expands the steps; shift implements even when claimed; alt plans
  // against the effort's own spec.
  const onEffort = (ev, box) => {
    const e = dataOf.get(box)
    if (!e || ev.target.closest('.pjbtn')) return
    const p = current()
    if (p && ev.shiftKey) { ev.preventDefault(); implementThis(p, e, true); return }
    if (p && ev.altKey) {
      ev.preventDefault()
      if (e.spec) planThis(p, { rel: e.spec, slug: null, text: e.specTitle || e.title })
      else toast('this plan names no spec to plan against')
      return
    }
    const key = openKey(e)
    if (expanded.has(key)) expanded.delete(key); else expanded.add(key)
    render()
  }

  const EFFORT = {
    key: (r) => r.k,
    create: (r) => {
      if (r.kind === 'note') return el('div', 'plannote')
      const box = el('div', 'pjeff')
      const head = el('div', 'pjeffhead')
      head.appendChild(el('span', 'plancaret'))
      head.appendChild(el('span', 'planname'))
      head.appendChild(el('span', 'plancount'))
      head.appendChild(el('span', 'pjchip pjshipped'))
      head.appendChild(el('span', 'pjchip pjbehind'))
      head.appendChild(el('span', 'pjchip pjclaim'))
      const impl = el('button', 'pjbtn pjimpl', 'implement this')
      impl.type = 'button'
      impl.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const e = dataOf.get(box), p = current()
        if (e && p) implementThis(p, e, ev.shiftKey)
      })
      head.appendChild(impl)
      head.addEventListener('click', (ev) => onEffort(ev, box))
      box.appendChild(head)
      box.appendChild(el('div', 'pjon'))
      box.appendChild(el('div', 'pjtaskchips'))
      box.appendChild(el('div', 'planbody'))
      return box
    },
    update: (box, e) => {
      if (e.kind === 'note') return MCX.setText(box, e.text)
      dataOf.set(box, e)
      const open = expanded.has(openKey(e))
      const head = box.querySelector('.pjeffhead')
      MCX.setText(head.querySelector('.plancaret'), open ? '▾' : '▸')
      MCX.setText(head.querySelector('.planname'), e.title)
      MCX.setAttr(head.querySelector('.planname'), 'title', e.rel)
      // Three states, never a percentage: reported is a claim and verified is
      // a review, and adding them together is the lie the states exist to stop.
      MCX.setText(head.querySelector('.plancount'), e.progress)
      setChip(head.querySelector('.pjshipped'),
        e.shipped ? 'shipped ' + e.shipped.date + (e.shipped.commit ? ' · ' + e.shipped.commit : '') : '')
      setChip(head.querySelector('.pjbehind'), e.behind ? 'behind ' + e.behind : '')
      setChip(head.querySelector('.pjclaim'), claimText(e.claimedBy))
      setChip(box.querySelector('.pjon'), e.current ? 'on: ' + e.current : '')
      // A reference that did not resolve is a needs-a-human card, not a chip.
      MCX.reconcile(box.querySelector('.pjtaskchips'),
        e.taskChips.filter((c) => !c.broken).map((c) => ({ ...c, k: c.ref })), TASKCHIP)
      const body = box.querySelector('.planbody')
      MCX.show(body, open)
      const p = open && L.project ? projectByKey(L.project) : null
      MCX.reconcile(body, p ? effortRows(p, e) : [], STEP)
    },
  }

  // --- Features ---

  const FEATURE = {
    key: (r) => r.k,
    create: (r) => {
      if (r.kind === 'note') return el('div', 'plannote')
      const row = el('div', r.kind === 'spec' ? 'pjspec' : 'pjfeat')
      row.appendChild(el('span', 'pjfname'))
      row.appendChild(el('span', 'pjfmeta'))
      // A spec no plan names yet is intent waiting for a plan: clicking it
      // files one.
      if (r.kind === 'spec') {
        row.setAttribute('title', 'plan this')
        row.addEventListener('click', () => {
          const s = dataOf.get(row), p = current()
          if (s && p) planThis(p, { rel: s.rel, slug: null, text: s.title || s.name })
        })
      }
      return row
    },
    update: (row, r) => {
      if (r.kind === 'note') return MCX.setText(row, r.text)
      dataOf.set(row, r)
      MCX.setText(row.querySelector('.pjfname'), r.kind === 'spec' ? (r.title || r.name) : r.name)
      MCX.setText(row.querySelector('.pjfmeta'), r.kind === 'spec' ? r.rel : (r.date || 'undated'))
    },
  }

  // --- Graph ---

  const commitNode = () => {
    const row = el('div', 'pjcommit')
    row.appendChild(el('span', 'pjsha'))
    row.appendChild(el('span', 'pjsubj'))
    row.appendChild(el('span', 'pjmerge', 'merge'))
    row.appendChild(el('span', 'pjago'))
    return row
  }

  const commitUpdate = (row, c) => {
    MCX.toggle(row, 'head', c.head)
    MCX.setText(row.querySelector('.pjsha'), c.sha7)
    const subj = row.querySelector('.pjsubj')
    MCX.setText(subj, c.subject)
    MCX.setAttr(subj, 'title', c.subject)
    MCX.show(row.querySelector('.pjmerge'), c.merge)
    MCX.setText(row.querySelector('.pjago'), c.at ? ago(c.at) : '')
  }

  const COMMIT = { key: (c) => c.k, create: commitNode, update: commitUpdate }

  const onBranch = (ev, box) => {
    const b = dataOf.get(box)
    if (b) dispatchAction({ type: 'branch', branch: b.name })
  }

  const GRAPH = {
    key: (r) => r.k,
    create: (r) => {
      if (r.kind === 'note') return el('div', 'plannote')
      if (r.kind === 'commit') return commitNode()
      const box = el('div', 'pjbr')
      const head = el('div', 'pjbrhead')
      head.appendChild(el('span', 'pjbrname'))
      head.appendChild(el('span', 'wtbadge', 'main'))
      head.appendChild(el('span', 'wthash'))
      head.appendChild(el('span', 'pjab'))
      box.appendChild(head)
      box.appendChild(el('div', 'pjrecent'))
      box.appendChild(el('div', 'pjmore'))
      box.addEventListener('click', (ev) => onBranch(ev, box))
      return box
    },
    update: (node, r) => {
      if (r.kind === 'note') return MCX.setText(node, r.text)
      if (r.kind === 'commit') return commitUpdate(node, r)
      dataOf.set(node, r)
      MCX.toggle(node, 'lit', !!r.lit)
      MCX.toggle(node, 'main', r.isMain)
      MCX.setText(node.querySelector('.pjbrname'), r.name)
      MCX.show(node.querySelector('.wtbadge'), r.isMain)
      MCX.setText(node.querySelector('.wthash'), r.head)
      const counted = !r.isMain && r.ahead != null && r.behind != null
      setChip(node.querySelector('.pjab'), counted ? '↑' + r.ahead + ' ↓' + r.behind : '')
      MCX.reconcile(node.querySelector('.pjrecent'), r.recent, COMMIT)
      setChip(node.querySelector('.pjmore'), r.more)
    },
  }

  // --- the panels themselves ---

  const PANEL_TITLE = { worktrees: 'Worktrees', todos: 'Todos', features: 'Features', graph: 'Graph' }

  const subList = (body, title, cls) => {
    body.appendChild(el('h4', 'pjsub', title))
    body.appendChild(el('div', 'pjlist ' + cls))
  }

  // The worktrees mount's height is set only at render, from the card count
  // and the mount's width at that moment; a width change with no payload in
  // between -- the panel rail resizing, the window itself -- would otherwise
  // leave a row clipped until the next one. One observer per mount, reading
  // the count its own last render left on it rather than closing over a
  // project a later render may have replaced; it only ever touches the
  // custom property, never a render, so nothing here runs from a stage frame.
  const wtCountOf = new WeakMap()
  const wtResizers = new WeakMap()
  const observeWtResize = (stage) => {
    if (wtResizers.has(stage) || typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(() => {
      stage.style.setProperty('--pj-wt-h', MCPMO.cardGrid(wtCountOf.get(stage) || 0, stage.clientWidth).height + 'px')
    })
    ro.observe(stage)
    wtResizers.set(stage, ro)
  }

  // Each panel draws from its row: `p` the digest project, `doc` its document
  // or null, `note` what to say while there is no document. The Worktrees
  // panel reads the digest alone; Todos and Features wait for the document,
  // and the Graph for the project's fetched history.
  const PANEL_BODY = {
    // On the stage while it is ready, as cards that settle and float, and as a
    // strip of chips at the deepest level; otherwise the reconciled list. The
    // same card spec draws both.
    worktrees: (body, r) => {
      const list = MCPM.worktreesOf(r.p)
      const stage = body.querySelector('.pjwtstage')
      const text = body.querySelector('.pjlist')
      const on = MCPS.ready()
      MCX.show(stage, on)
      MCX.show(text, !on)
      MCX.toggle(stage, 'chips', L.level === 2)
      if (on) {
        MCPS.nodes.set('worktrees', stage)
        // The mount is sized to what it holds: tall enough for every row of
        // full-size cards, and in the strip as wide as its chips at their
        // narrowest, so they scroll rather than being cut off. Custom
        // properties, because a level change clears the inline sizes it
        // animates on this node when it settles.
        wtCountOf.set(stage, list.length)
        observeWtResize(stage)
        stage.style.setProperty('--pj-wt-h', MCPMO.cardGrid(list.length, body.clientWidth).height + 'px')
        stage.style.setProperty('--pj-chips-w', MCPMO.chipSpan(list.length) + 'px')
        window.MCGS?.mount?.(stage, 'worktree-card', { spec: cardSpec(), chips: L.level === 2 }, list)
      } else {
        MCX.reconcile(text, list, WTCARD)
      }
    },
    todos: (body, r) => {
      const waiting = r.doc ? null : [note('note', r.note ?? 'loading…')]
      const { backlog, efforts } = MCPM.todosOf(r.doc)
      MCX.reconcile(body.querySelector('.pj-backlog'), waiting ?? (backlog.length
        ? backlog.map((b) => ({ ...b, k: 'b:' + b.k, kind: 'backlog' }))
        : [note('note', 'no backlog headings')]), BACKLOG)
      MCX.reconcile(body.querySelector('.pj-efforts'), waiting ?? (efforts.length
        ? efforts.map((e) => ({ ...e, k: 'e:' + e.k, kind: 'effort' }))
        : [note('note', 'no plans')]), EFFORT)
    },
    features: (body, r) => {
      const waiting = r.doc ? null : [note('note', r.note ?? 'loading…')]
      const { shipped } = MCPM.featuresOf(r.doc)
      MCX.reconcile(body.querySelector('.pj-shipped'), waiting ?? (shipped.length
        ? shipped.map((f) => ({ ...f, k: 'f:' + f.k, kind: 'feature' }))
        : [note('note', 'nothing recorded as shipped')]), FEATURE)
      const { planned, brokenSpec } = MCPM.plannedOf(r.doc?.specs, MCPM.planIndexOf(r.doc))
      const rows = [
        ...planned.map((s) => ({ ...s, k: 's:' + s.k, kind: 'spec' })),
        ...brokenSpec.map((b) => note('x:' + b.k, b.plan + ' names a spec that does not resolve')),
      ]
      MCX.reconcile(body.querySelector('.pj-planned'), waiting ?? (rows.length ? rows : [note('note', 'every spec has a plan')]), FEATURE)
    },
    // On the stage while it can draw one: the isolated project's own scene,
    // at the level and branch this view is at, never the graph's own Escape.
    // The digest carries no history, so the history read for this project is
    // laid over it, and until a read lands the scene is the worktrees' heads.
    // The plain text list is the fallback, and keeps its own way of
    // following a selection at the middle level -- leading with the branch
    // and lighting it -- since a stage graph re-lays under its own
    // integrator instead. The branches and one branch's commits are two
    // lists, each drawn only at its own level and left as it was at the
    // other, so stepping between the levels shows rows that are already
    // there rather than building them again.
    graph: (body, r) => {
      const stage = body.querySelector('.pjwtstage')
      const text = body.querySelector('.pjlist')
      const commits = body.querySelector('.pjcommits')
      const p = MCGM.withGraphs([r.p], graphs)[0]
      const read = MCGM.graphFor(p)
      const drawable = read.state !== 'nogit' && read.state !== 'failed'
      const on = drawable && MCPS.sync(stage, 'graph', p, L, selected)
      const deep = L.level === 2
      MCX.show(stage, on)
      MCX.show(text, !on && !deep)
      MCX.show(commits, !on && deep)
      if (!on && deep) {
        MCX.reconcile(commits, graphRowsFor(r.p, L.branch), GRAPH)
      } else if (!on) {
        const rows = graphRowsFor(r.p, null)
        const focus = L.level === 1 ? selected : null
        const lead = focus ? rows.filter((row) => row.kind === 'branch' && row.name === focus) : []
        const rest = rows.filter((row) => !lead.includes(row))
        MCX.reconcile(text, [...lead.map((row) => ({ ...row, lit: true })), ...rest], GRAPH)
      }
      const unread = read.state === 'failed' || graphs.get(MCPM.projectKey(r.p))?.status === 'error'
      graphNote = on ? '' : (read.state === 'nogit' ? 'not a git repository'
        : unread ? 'history could not be read' : 'drawn as text')
    },
  }

  const PANEL = {
    key: (r) => r.k,
    create: (r) => {
      const sec = el('section', 'pjpanel')
      sec.classList.add('pj-' + r.k)
      const h = el('h3', null, PANEL_TITLE[r.k])
      // At the deepest level every panel but the graph is down to its title,
      // in the rail or beside the strip, and the title is the way back up. At
      // the middle level the Graph's title opens the branch it is following.
      h.addEventListener('click', () => {
        if (L.level === 2 && r.k !== 'graph') dispatchAction({ type: 'back' })
        else if (L.level === 1 && r.k === 'graph' && selected) dispatchAction({ type: 'branch', branch: selected })
      })
      sec.appendChild(h)
      const body = el('div', 'pjbody')
      if (r.k === 'todos') { subList(body, 'Backlog', 'pj-backlog'); subList(body, 'Efforts', 'pj-efforts') }
      else if (r.k === 'features') { subList(body, 'Shipped', 'pj-shipped'); subList(body, 'Planned', 'pj-planned') }
      else {
        body.appendChild(el('div', 'pjwtstage gone'))
        body.appendChild(el('div', 'pjlist'))
        if (r.k === 'graph') body.appendChild(el('div', 'pjlist pjcommits gone'))
      }
      sec.appendChild(body)
      return sec
    },
    update: (sec, r) => {
      // With no project the section is left exactly as it was: hidden at the
      // overview it draws nothing, and on the way out it is still fading where
      // it stood, so neither its layout nor its content may change beneath it.
      if (!r.p) return
      // The deepest level makes Todos and Features heads in the rail and the
      // worktrees panel the strip of chips. The same nodes, re-laid by the
      // grid; the flip carries them there.
      MCX.toggle(sec, 'head-only', L.level === 2 && (r.k === 'todos' || r.k === 'features'))
      MCX.toggle(sec, 'strip', L.level === 2 && r.k === 'worktrees')
      PANEL_BODY[r.k](sec.querySelector('.pjbody'), r)
      // The Graph panel's head says which it is showing, once its own body
      // has decided.
      if (r.k === 'graph') MCX.setAttr(sec.querySelector('h3'), 'data-note', graphNote)
    },
  }

  // Hidden at the overview, never absent: the four sections are reconciled at
  // every level, so isolating a project reuses them rather than building them.
  const renderPanels = (p, doc, docNote) => {
    const box = byId('pj-panels')
    MCX.show(box, !!p)
    // Only with a project, for the same reason a panel keeps its classes
    // without one: on the way out to the overview the panels are still held
    // fading where they stood, in whichever layout they had.
    if (p) MCX.toggle(box, 'deep', L.level === 2)
    MCX.reconcile(box, MCPM.panelOrder(L.lens).map((k) => ({ k, p, doc, note: docNote })), PANEL)
  }

  // --- the whole view ----------------------------------------------------------

  const draw = () => {
    if (!active) return
    if (!byId('projlist')) return
    const projects = projectsOf()
    MCX.setText(byId('c-projects'), String(projects.length))
    // A project that vanished while isolated: drop to the overview and say
    // which one, rather than rendering an empty detail pane forever.
    const before = L
    L = MCPM.levelReduce(L, { type: 'vanish', keys: projects.map(MCPM.projectKey) })
    if (L !== before && before.project) toast((lastName || 'that project') + ' is no longer reporting')
    // A scope that isolating a project set ends with the isolation, however
    // the view came back out.
    if (L.level === 0 && scope?.by === 'isolate') clearScope()
    const p = L.project ? projectByKey(L.project) : null
    ask(projects, p)
    const { project: doc, note: docNote } = docOf(p)
    let cards = []
    let walked = null
    if (L.triage) {
      if (boardStale(projects)) fetchBoard()
      const documents = boardDocs(projects)
      cards = documents ? MCPM.boardCards(documents, { lens: L.lens }) : []
      walked = documents && L.project ? documents.find((d) => MCPM.projectKey(d) === L.project) ?? null : null
    }
    const cursorKey = cards.length ? cards[Math.min(L.triageAt, cards.length - 1)].k : null
    renderCrumb(p)
    renderHead(p)
    renderLens(cards)
    renderMode()
    renderList(projects)
    renderPanels(p, doc, docNote)
    // The walk's own board holds the card it landed on before the isolated
    // project's own document has been read.
    renderCards(doc ?? walked, cursorKey)
  }

  // --- the triage walk -----------------------------------------------------------

  /** The board's documents for the projects the digest still carries. */
  const boardDocs = (projects) => {
    if (!board?.documents) return null
    const onBoard = new Set(projects.map(MCPM.projectKey))
    return board.documents.filter((d) => onBoard.has(MCPM.projectKey(d)))
  }

  /** Whether the board has to be read (again): never read, or a project on the
   *  digest has moved past the newest document read. Never while a read is in
   *  flight. */
  const boardStale = (projects) => {
    if (board?.status === 'loading') return false
    if (board?.status !== 'ok') return true
    return projects.some((p) => (p.changedAt ?? 0) > board.at)
  }

  /** One step of the walk over a board's documents. */
  const walk = (dir, documents) => {
    const cards = MCPM.boardCards(documents, { lens: L.lens })
    if (cards.length) {
      const before = L
      dispatchAction({ type: 'triageStep', dir, cards })
      if (L !== before) return
    } else {
      toast('nothing on the board needs a human')
    }
    render()
  }

  /** Reads every document once. A step waiting on the read lands when it does;
   *  a failed read says so and leaves triage off. */
  const fetchBoard = () => {
    if (board?.status === 'loading') return
    const mine = { status: 'loading', at: board?.at ?? 0, documents: board?.documents ?? null }
    board = mine
    fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((d) => {
        if (board !== mine) return
        const dir = pendingDir
        pendingDir = 0
        if (!Array.isArray(d?.projects)) {
          board = null
          toast('could not read the board for triage', { kind: 'warn' })
          L = MCPM.levelReduce(L, { type: 'triage', on: false })
          render()
          return
        }
        const documents = d.projects
        board = { status: 'ok', at: documents.reduce((n, x) => Math.max(n, x?.changedAt ?? 0), 0), documents }
        if (dir) walk(dir, boardDocs(projectsOf()))
        else render()
      })
  }

  /** `n` / `p`: step now over a current board, or wait for it to be read. */
  const step = (dir) => {
    const projects = projectsOf()
    const documents = boardDocs(projects)
    if (!documents || board.status !== 'ok' || boardStale(projects)) {
      pendingDir = dir
      fetchBoard()
      render()
      return
    }
    walk(dir, documents)
  }

  // A level change holds the layout it is leaving until its structural moves
  // begin, so a render asked for in that window -- a payload, a fetched plan
  // -- is not drawn early: the change draws it when it lets go.
  const render = () => {
    if (tr && tr.phase === 1) return
    draw()
  }

  // Something that sits above this view and answers keys first: the command
  // popup or its quick-access deck, the settings pop, the link dialog, the
  // session drawer, a channel being picked, or an armed command.
  const overlayOpen = () => {
    if (MCQ.isOpen() || MCQ.deckOpen()) return true
    if (S.linkFrom || S.armed) return true
    const pop = byId('settingspop'), modal = byId('linkmodal'), drawer = byId('drawer')
    return !!((pop && !pop.hidden) || (modal && !modal.hidden) || (drawer && drawer.classList.contains('open')))
  }

  const typing = () => {
    const a = document.activeElement
    return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)
  }

  // --- the keys --------------------------------------------------------------

  /** The mode follows focus: the stripe's field is ASK, the filter is FILTER,
   *  nothing focused is NORMAL, and any other field is typing that is none of
   *  this view's business. */
  const modeNow = () => {
    const a = document.activeElement
    if (a && a === byId('pj-ask')) return 'ask'
    if (a && a === byId('pj-filter')) return 'filter'
    return typing() ? null : 'normal'
  }

  const renderMode = () => {
    const n = byId('pj-mode')
    if (!n) return
    const mode = modeNow() || 'normal'
    MCX.setText(n, mode.toUpperCase())
    MCX.toggle(n, 'filter', mode === 'filter')
    MCX.toggle(n, 'ask', mode === 'ask')
  }

  const worktreeByKey = (key) => MCPM.worktreesOf(current()).find((w) => w.k === key) ?? null

  /** What the cursor walks, as data in drawing order: the overview's project
   *  rows as the filter leaves them, or inside a project its worktrees -- the
   *  cards at the middle level, the chip strip at the deepest. Data rather
   *  than a container's children, because a card on the stage belongs to no
   *  list. */
  const columnKeys = () => (L.level >= 1
    ? MCPM.worktreesOf(current()).map((w) => w.k)
    : listRows(projectsOf(), false).filter((r) => r.kind === 'project').map((r) => r.key))

  /** Where the cursor lands when the level or the project changes under it:
   *  at the overview, on the project just left; inside a project, on the
   *  branch being opened or the one just left, else the first worktree. */
  const seatFor = (was, next) => {
    if (next.level === 0) return was.project ?? cursorKey
    const list = MCPM.worktreesOf(projectByKey(next.project))
    const branch = next.level === 2 ? next.branch : (was.project === next.project ? was.branch : null)
    const hit = branch ? list.find((w) => w.branch === branch) : null
    return (hit ?? list[0])?.k ?? null
  }

  /** Scrolls the cursor's row into view when a list draws it. A card on the
   *  stage is always inside its own mount. */
  const reveal = () => {
    const box = L.level >= 1 ? panelOf('worktrees')?.querySelector('.pjlist') : byId('projlist')
    if (!box || box.classList.contains('gone')) return
    const n = Array.prototype.find.call(box.children, (c) => MCX.keyOf(c) === cursorKey)
    n?.scrollIntoView?.({ block: 'nearest' })
  }

  /** Plan this, from command-Enter or a command-click: the stripe's next ask
   *  is scoped to the project and its field holds the start of a plan request
   *  with the caret at its end, so the reader finishes the ask rather than
   *  firing one blind. */
  const planTemplate = (p) => {
    setScope(p, 'ask')
    const field = byId('pj-ask')
    field.value = 'Plan the next piece of work in ' + (p.name || p.mainRoot) + ': '
    field.focus()
    field.setSelectionRange?.(field.value.length, field.value.length)
  }

  /** Shows the filter with the caret in it and its text selected, so typing
   *  replaces a filter already applied. */
  const openFilter = () => {
    const f = byId('pj-filter')
    MCX.show(f, true)
    f.focus()
    f.select?.()
  }

  /** Clears the filter, whether it is being typed or was accepted earlier:
   *  every row comes back, with no motion, and the field closes. */
  const clearFilter = () => {
    const f = byId('pj-filter')
    filter = ''
    f.value = ''
    f.blur()
    MCX.show(f, false)
    render()
  }

  /** One of the key table's actions, on what this view already has. Returns
   *  whether it did anything, so a key that changed nothing keeps its
   *  default. */
  const runKey = (action) => {
    if (action.startsWith('lens:')) { dispatchAction({ type: 'lens', lens: action.slice(5) }); return true }
    // The walk visits the whole board's documents, which the digest does not
    // carry: a step lands now over a current read, or once the read lands.
    if (action === 'triage:next' || action === 'triage:prev') { step(action === 'triage:next' ? 1 : -1); return true }
    // `refresh` reads the isolated project's document again; `refresh:all`
    // its git graph and its opened plans' steps too.
    if (action === 'refresh' || action === 'refresh:all') {
      if (L.level < 1 || !L.project) return false
      docs.delete(L.project)
      if (action === 'refresh:all') {
        graphs.delete(L.project)
        for (const k of [...steps.keys()]) if (JSON.parse(k)[0] === L.project) steps.delete(k)
      }
      render()
      return true
    }
    keyed = true
    const keys = columnKeys()
    const at = keys.indexOf(cursorKey)
    const seat = (i) => {
      if (!keys.length) return false
      cursorKey = keys[Math.max(0, Math.min(i, keys.length - 1))]
      render()
      reveal()
      return true
    }
    if (action === 'next') return seat(at < 0 ? 0 : at + 1)
    if (action === 'prev') return seat(at < 0 ? keys.length - 1 : at - 1)
    if (action === 'first') return seat(0)
    if (action === 'last') return seat(keys.length - 1)
    if (action === 'out') { dispatchAction({ type: 'back' }); return true }
    if (action === 'filter') { openFilter(); return true }
    if (action === 'filter:accept') { byId('pj-filter').blur(); return true }
    if (action === 'plan') {
      const p = L.level >= 1 ? current() : (at >= 0 ? projectByKey(cursorKey) : null)
      if (!p) return false
      planTemplate(p)
      return true
    }
    if (at < 0) return false
    if (action === 'in' && L.level === 0) { dispatchAction({ type: 'isolate', project: cursorKey }); return true }
    // Opening a branch and selecting one belong to the middle level. At the
    // deepest the cursor still walks the strip, and these do nothing.
    const w = L.level === 1 ? worktreeByKey(cursorKey) : null
    if (!w || w.detached || !w.branch) return false
    if (action === 'in') { dispatchAction({ type: 'branch', branch: w.branch }); return true }
    if (action === 'select') { if (selected !== w.branch) selectWorktree(w.branch); return true }
    return false
  }

  // Every listener, bound once from attach and never at evaluation time: the
  // DOM and `el` both belong to app.js, which loads after this file.
  const wire = () => {
    buildCrumb()
    // The stripe's ask: it lands on the same persisted threads the command
    // bar uses, and its answer shows up there too -- a second transcript in
    // the stripe would only drift from it.
    const send = (newThread) => {
      const field = byId('pj-ask')
      const { text, opts } = MCPM.askScoped(field.value, scope)
      if (!text.trim()) return
      field.value = ''
      void MCQ.ask(text, { ...opts, newThread })
      MCQ.open()
    }
    // The stripe's form has no action, so an unhandled submit would reload
    // the whole pane.
    byId('pj-ask-form').addEventListener('submit', (ev) => { ev.preventDefault(); send(false) })
    byId('pj-ask').addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || ev.shiftKey) return       // shift+enter is a newline
      ev.preventDefault()
      send(ev.altKey)                                     // alt+enter starts a new thread
    })
    MCPS.attach({ toast, level: () => L, render })
    // A click on the scope chip clears it, the same as esc at the overview.
    byId('pj-scope').addEventListener('click', clearScope)
    byId('pj-ask-about').addEventListener('click', () => { const p = current(); if (p) askAbout(p) })
    byId('pj-open-canvas').addEventListener('click', () => { const p = current(); if (p) openInCanvas(p) })

    // The mode word follows focus, however focus moved: a key, a click, tab,
    // or "ask about this project".
    const filterBox = byId('pj-filter')
    for (const f of [byId('pj-ask'), filterBox]) {
      f.addEventListener('focus', renderMode)
      f.addEventListener('blur', renderMode)
    }
    // Narrowing is a render and nothing more: no row travels. A cursor on a
    // row the filter took away moves to the first row it left.
    filterBox.addEventListener('input', () => {
      filter = filterBox.value.trim().toLowerCase()
      if (keyed && L.level === 0) {
        const keys = columnKeys()
        if (!keys.includes(cursorKey)) cursorKey = keys[0] ?? null
      }
      render()
    })
    // An empty filter closes with its field; one still narrowing the rows
    // keeps the field showing, which is how the reader can tell.
    filterBox.addEventListener('blur', () => { if (!filter) MCX.show(filterBox, false) })

    // The keys, from the one table. Nothing acts while anything sits above
    // this view or while a field that is not this view's own has focus.
    // Escape is never read here: the capture listener below answers it.
    addEventListener('keydown', (ev) => {
      if (!active || ev.key === 'Escape') return
      const mode = modeNow()
      if (mode === null || overlayOpen()) return
      // A focused button answers Enter and Space itself; acting on the cursor
      // as well would press two things at once.
      if ((ev.key === 'Enter' || ev.key === ' ') && document.activeElement?.tagName === 'BUTTON') return
      const r = MCPMO.keyAction(ev, { mode, level: L.level, pending: keyPending })
      keyPending = r.pending
      if (r.action && runKey(r.action)) ev.preventDefault()
    })

    // Escape, in the CAPTURE phase, stopping the event only when this view
    // actually acted. app.js's own escape router runs in the bubble phase and
    // ends by closing the drawer, so without the stop one press would step
    // back a level AND close the drawer behind it. Anything open above the
    // view answers first, the innermost-first order app.js's router follows.
    // Then, from the inside out: the stripe's field lets go of the keys; a
    // filter, being typed or already accepted, clears; a half-typed `g`
    // disarms; triage ends; a level steps back; a scope clears. A focused
    // field of this view's own is not typing here -- escape is how the reader
    // leaves it. At the overview with none of these, escape belongs to
    // somebody else and falls through untouched.
    addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || !active || overlayOpen()) return
      const a = document.activeElement
      if (a && a === byId('pj-ask')) a.blur()
      else if ((a && a === filterBox) || filter) clearFilter()
      else if (keyPending) keyPending = ''
      else if (pendingDir) {
        // A step still waiting on the board's read: the walk ends before it
        // ever lands.
        pendingDir = 0
        L = MCPM.levelReduce(L, { type: 'triage', on: false })
        render()
      } else if (L.triage) dispatchAction({ type: 'triage', on: false })
      else if (L.level >= 1) dispatchAction({ type: 'back' })
      else if (scope) clearScope()
      else return
      ev.stopImmediatePropagation()
    }, true)
  }

  const attach = (deps) => {
    S = deps.S; post = deps.post; toast = deps.toast; el = deps.el; ago = deps.ago
    needsOf = typeof deps.needsOf === 'function' ? deps.needsOf : null
    wire()
  }
  // Leaving the tab lands any level change at its final state, so nothing is
  // held or half-drawn when the reader comes back.
  // The stage is booted on the way in and paused on the way out, and only on
  // a real change: every tab switch reaches this, not just this view's.
  const setView = (name) => {
    const was = active
    active = name === 'projects'
    if (!active) {
      settle(tr)
      if (was) MCPS.exit()
      return
    }
    wantLib()
    if (!was) MCPS.enter()
    render()
  }

  /** The worktree card, as one definition: the same builder the DOM list
   *  reconciles and the same one the stage's panels are written through, so a
   *  card cannot come to mean two different things. Only callable after
   *  attach -- it closes over the injected element builder. */
  const cardSpec = () => WTCARD

  return { attach, setView, render, cardSpec }
})()
