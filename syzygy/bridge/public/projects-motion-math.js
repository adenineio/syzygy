/* The Projects tab's motion, as numbers.

   A CLASSIC script, like projects-model.js and canvas-layout.js: its only
   top-level binding is `const MCPMO`, referenced bare by projects.js and
   projects-stage.js, and it touches no DOM and reads no window, so a node
   harness can assert every duration directly.

   The choreography is DATA, not literals scattered through the view: a
   transition is a list of steps, each naming a symbolic target the view
   resolves to nodes. That is what lets the durations, the stagger cap and
   the flattening under reduced motion be measured rather than believed. */
const MCPMO = (() => {
  const finite = (v) => typeof v === 'number' && Number.isFinite(v)

  // Both easings already exist in the pane's stylesheet: the structural one
  // for a box moving between resting places, the arrival one for something
  // coming into view. `fade` is not a third easing -- it is the absence of
  // one, for a step that only changes opacity.
  const EASE = Object.freeze({
    structural: 'cubic-bezier(.45, 0, .25, 1)',
    arrival: 'cubic-bezier(.2, .7, .3, 1)',
    fade: 'linear',
  })

  const RAIL_W = 200          // .pjrail's fixed basis
  const PANEL_RAIL_W = 150    // the deepest level's panel rail
  const CHIP_ROW_H = 28       // the deepest level's worktree chip row
  const STAGGER_MS = 40
  const STAGGER_CAP = 3
  // The stage card's own stiffness, restated so the harness can check that a
  // card's settle really is slower than the panels' arrival.
  const CARD_OMEGA = 12

  const PANEL_ORDER = Object.freeze(['worktrees', 'todos', 'features', 'graph'])

  const TARGETS = Object.freeze([
    'row.pressed', 'row.metrics', 'rows', 'panel', 'panel.head', 'panel.body',
    'graph.box', 'graph.list', 'cards.stage', 'crumb2', 'crumb3', 'scopechip',
  ])

  /** A duration under the calm dial. `settle` 0 means the final state is set
   *  with no animation at all; anything unusable reads as full motion, never
   *  as none, so a dial that has not resolved yet cannot silently kill the
   *  view's feedback. */
  const scale = (ms, calm) => {
    const s = finite(calm?.settle) ? calm.settle : 1
    const n = finite(ms) ? ms : 0
    return Math.max(0, Math.round(n * s))
  }

  /** The delay of the i-th item in a staggered group, capped so a long group
   *  reads as a fan rather than a queue. */
  const staggerDelay = (i, step, cap) => {
    const k = finite(i) && i > 0 ? Math.floor(i) : 0
    const c = finite(cap) && cap >= 0 ? Math.floor(cap) : STAGGER_CAP
    return (finite(step) ? step : 0) * Math.min(k, c)
  }

  /** The FLIP offset: where the node WAS relative to where it now IS. The
   *  view sets this transform and animates it to identity, so the node
   *  appears to travel from its old rect without ever being laid out there.
   *  A zero-sized target yields scale 1 rather than Infinity -- a panel
   *  measured while its view was hidden is the normal case. */
  const flipDelta = (before, after) => ({
    dx: (before?.left ?? 0) - (after?.left ?? 0),
    dy: (before?.top ?? 0) - (after?.top ?? 0),
    sx: after?.width ? (before?.width ?? 0) / after.width : 1,
    sy: after?.height ? (before?.height ?? 0) / after.height : 1,
  })

  const step = (id, target, property, from, to, duration, delay, ease, calm) => ({
    id, target, property, from, to,
    duration: scale(duration, calm),
    delay: scale(delay, calm),
    ease,
  })

  // Going in: the row lights and the metric columns clear first so nothing
  // wraps while the rail narrows; the work area is already laid out at its
  // final size behind opacity 0, and the panels fan in over it.
  const enter1 = (calm) => {
    const out = [
      step('row.light', 'row.pressed', 'accent', 0, 1, 80, 0, EASE.arrival, calm),
      step('metrics.out', 'row.metrics', 'opacity', 1, 0, 120, 0, EASE.fade, calm),
      step('scope.fade', 'scopechip', 'opacity', 0, 1, 120, 0, EASE.fade, calm),
      step('rail.squeeze', 'rows', 'flip', null, null, 320, 40, EASE.structural, calm),
    ]
    for (let i = 0; i < PANEL_ORDER.length; i++) {
      // From the left of rest: depth runs left to right, so whatever arrives
      // deeper travels rightward, and the exit's drift is its reversal.
      out.push(step('panel.in:' + PANEL_ORDER[i], 'panel', 'slide', -16, 0, 200,
        160 + staggerDelay(i, STAGGER_MS, STAGGER_CAP), EASE.arrival, calm))
    }
    out.push(step('crumb2.in', 'crumb2', 'slide', -12, 0, 200, 160, EASE.arrival, calm))
    return out
  }

  // Coming back out: one move, not a reversed fan. The panels leave together
  // toward the rail, the rail widens behind them, and the columns come back
  // over the tail of the widening so they never fade in over a moving box.
  const leave1 = (calm) => [
    step('panel.out', 'panel', 'slide', 0, -8, 120, 0, EASE.structural, calm),
    step('panel.out.fade', 'panel', 'opacity', 1, 0, 120, 0, EASE.fade, calm),
    step('rail.release', 'rows', 'flip', null, null, 200, 60, EASE.structural, calm),
    step('metrics.in', 'row.metrics', 'opacity', 0, 1, 120, 140, EASE.fade, calm),
  ]

  // Going deeper: the bodies clear first, then everything that is still on
  // screen travels at once -- the panel heads into a rail, the cards into a
  // strip, the graph's box out to fill what is left. One FLIP of nodes that
  // already exist, which is why nothing here creates or destroys anything.
  const enter2 = (calm) => [
    step('body.out', 'panel.body', 'opacity', 1, 0, 100, 0, EASE.fade, calm),
    step('head.flip', 'panel.head', 'flip', null, null, 260, 60, EASE.structural, calm),
    step('cards.squeeze', 'cards.stage', 'flip', null, null, 260, 60, EASE.structural, calm),
    step('graph.grow', 'graph.box', 'flip', null, null, 260, 60, EASE.structural, calm),
    // From the left, like every arrival deeper.
    step('crumb3.in', 'crumb3', 'slide', -12, 0, 200, 60, EASE.arrival, calm),
  ]

  const leave2 = (calm) => [
    step('head.flip', 'panel.head', 'flip', null, null, 200, 0, EASE.structural, calm),
    step('cards.expand', 'cards.stage', 'flip', null, null, 200, 0, EASE.structural, calm),
    step('graph.shrink', 'graph.box', 'flip', null, null, 200, 0, EASE.structural, calm),
    step('body.in', 'panel.body', 'opacity', 0, 1, 120, 80, EASE.fade, calm),
  ]

  /** Choosing a different worktree at the middle level retargets and does not
   *  travel: the graph's scene re-lays under its own integrator, and the text
   *  list standing in for it fades its re-laid rows in where they stand. */
  const retargetSteps = (calm) => [
    step('graph.retarget', 'graph.list', 'opacity', 0, 1, 120, 0, EASE.fade, calm),
  ]

  const CHIP_MIN_W = 96
  const CHIP_GAP = 6

  /** The chip row's slots: `n` equal chips across `width`, in order, each at
   *  least CHIP_MIN_W wide. Too many for the strip and they overflow rather
   *  than shrinking below that floor -- a chip narrower than its branch name
   *  is not a chip. */
  const chipSlots = (n, width) => {
    const count = finite(n) && n > 0 ? Math.floor(n) : 0
    const w = finite(width) && width > 0 ? width : 0
    if (!count || !w) return []
    const each = Math.max(CHIP_MIN_W, (w - CHIP_GAP * (count - 1)) / count)
    const out = []
    for (let i = 0; i < count; i++) out.push({ x: i * (each + CHIP_GAP), w: each, h: CHIP_ROW_H })
    return out
  }

  /** How wide the strip is with every chip at its narrowest. The strip is
   *  never narrower, so chips that do not fit the panel scroll rather than
   *  being cut off. */
  const chipSpan = (n) => {
    const count = finite(n) && n > 0 ? Math.floor(n) : 0
    return count ? count * CHIP_MIN_W + (count - 1) * CHIP_GAP : 0
  }

  // The worktree card at the middle level, in CSS pixels. It is always drawn
  // at this size -- the grid makes room, the card never shrinks -- and small
  // enough that a half-width panel holds two across.
  const CARD_W = 208
  const CARD_H = 96
  const CARD_GAP = 32        // between two cards; half of it at the mount's edge
  const CARD_FRAME = 4       // how far the line frame reaches past the border
  const CARD_TILT = 5        // the most a hovered card leans, in degrees, per axis
  const STAGE_FOV = 40       // the stage camera's vertical field of view, degrees
  const MOUNT_MIN_H = 220    // the cards' mount is never drawn shorter

  /** The middle level's card grid for `n` cards across `width`: as many
   *  columns as fit on a pitch of a card plus the gap -- at least one, and no
   *  more than there are cards -- the block centred across the width and the
   *  rows running down from half a gap below the top, so the mount's edge
   *  keeps the clearance two cards keep. `slots` are card centres from the
   *  mount's top-left corner; `height` is what the rows need.
   *
   *  `amp` is the float amplitude. The camera sits at one CSS pixel a world
   *  unit for a mount drawn at `height` (never below MOUNT_MIN_H), and a card
   *  tilted to CARD_TILT on both axes reaches past its flat outline by at most
   *  `reach` through it; `amp` is half the clearance between two drawn cards,
   *  frame included, less that reach, so no two cards can touch however they
   *  drift or lean. It is divided by `floatMax`, the widest float the calm
   *  dial applies, so that setting spends the bound exactly. */
  const cardGrid = (n, width, floatMax) => {
    const count = finite(n) && n > 0 ? Math.floor(n) : 0
    const w = finite(width) && width > 0 ? width : 0
    if (!count || !w) return { cols: 0, rows: 0, slots: [], height: 0, amp: 0 }
    const px = CARD_W + CARD_GAP
    const py = CARD_H + CARD_GAP
    const cols = Math.max(1, Math.min(count, Math.floor(w / px)))
    const rows = Math.ceil(count / cols)
    const left = (w - cols * px) / 2
    const slots = []
    for (let i = 0; i < count; i++) {
      slots.push({ x: left + px / 2 + (i % cols) * px, y: py / 2 + Math.floor(i / cols) * py })
    }
    const height = rows * py
    // A point (x, y) of the drawn card, tilted by t about both axes in either
    // order, comes at most (|x| + |y|) sin t nearer the camera, and moves along
    // one axis by at most the other half-extent times sin^2 t before the
    // projection magnifies it.
    const aw = CARD_W / 2 + CARD_FRAME
    const ah = CARD_H / 2 + CARD_FRAME
    const sin = Math.sin((CARD_TILT * Math.PI) / 180)
    const dist = Math.max(MOUNT_MIN_H, height) / 2 / Math.tan((STAGE_FOV / 2) * Math.PI / 180)
    const m = dist / (dist - (aw + ah) * sin)
    const reach = Math.max(aw * (m - 1) + ah * sin * sin * m, ah * (m - 1) + aw * sin * sin * m)
    const clear = Math.min(px - 2 * aw, py - 2 * ah)
    const f = finite(floatMax) && floatMax > 1 ? floatMax : 1
    return { cols, rows, slots, height, amp: Math.max(0, clear / 2 - reach) / f }
  }

  /** The steps of one level change, already scaled. An unknown pair is empty:
   *  the view then sets the final state and animates nothing, which is what a
   *  level change that is not a level change should cost. Jumping two levels
   *  plays only the outermost step -- the inner state snaps behind opacity 0,
   *  because a chain of transitions reads as slowness. */
  const timeline = (from, to, calm) => {
    if (from === 0 && to === 1) return enter1(calm)
    if ((from === 1 || from === 2) && to === 0) return leave1(calm)
    if (from === 1 && to === 2) return enter2(calm)
    if (from === 2 && to === 1) return leave2(calm)
    return []
  }

  // What each kind of step changes on screen. An accent is a class change the
  // view carries on a colour transition of its own, so it adds nothing here.
  const CSS_PROP = { accent: null, flip: 'transform', slide: 'transform', opacity: 'opacity' }

  /** The same timeline as CSS `transition` shorthands, one per target, for the
   *  page load where the Motion bundle did not arrive. A slide that comes to
   *  rest is an arrival and fades in beside its travel, so it carries opacity
   *  too; a flip on a target `sized` names carries the sides its box resizes
   *  on. A zero-duration step contributes nothing: "no transition" and "a
   *  transition of 0ms" look the same on screen but only the first one leaves
   *  getAnimations() empty. */
  const cssFallback = (steps, sized) => {
    const out = {}
    for (const s of (Array.isArray(steps) ? steps : [])) {
      const prop = s && CSS_PROP[s.property]
      if (!prop || !(s.duration > 0)) continue
      const props = [prop]
      if (s.property === 'slide' && s.to === 0) props.push('opacity')
      if (s.property === 'flip' && sized && Array.isArray(sized[s.target])) props.push(...sized[s.target])
      const timing = ' ' + s.duration + 'ms ' + s.ease + (s.delay > 0 ? ' ' + s.delay + 'ms' : '')
      const one = props.map((p) => p + timing).join(', ')
      out[s.target] = out[s.target] ? out[s.target] + ', ' + one : one
    }
    return out
  }

  const LENS = { s: 'sessions', t: 'todos', e: 'efforts', g: 'git' }
  const DIGIT = /^[0-9]$/

  /** The whole key table for this view, as a function of the event and the
   *  view's mode. Pure, so every row is asserted rather than pressed.
   *
   *  Depth is the horizontal axis: h and l move along it, j and k move within
   *  a column. `pending` carries a half-typed sequence (only `g` today). A
   *  null action means the key is not ours -- the digits belong to the tab
   *  switcher, every control chord belongs to the terminal or the browser, in
   *  FILTER every key but Enter types into the filter, and in ASK everything
   *  but Escape belongs to the stripe's field.
   *
   *  The Escape rows say what Escape means in each mode; the view answers
   *  Escape from one capture-phase listener, innermost first, in that same
   *  order. */
  const keyAction = (ev, state) => {
    const mode = state?.mode === 'filter' || state?.mode === 'ask' ? state.mode : 'normal'
    const level = finite(state?.level) ? state.level : 0
    const pending = typeof state?.pending === 'string' ? state.pending : ''
    const key = ev?.key
    const out = (action, next) => ({ action, pending: next ?? '', mode })
    const to = (action, m) => ({ action, pending: '', mode: m })

    if (ev?.ctrlKey) return out(null)

    if (mode === 'ask') return key === 'Escape' ? to('blur', 'normal') : out(null)

    if (mode === 'filter') {
      // Accepting keeps the narrowed rows and hands the keys back, so j and k
      // walk what the filter left.
      if (key === 'Enter') return to('filter:accept', 'normal')
      if (key === 'Escape') return to('filter:clear', 'normal')
      return out(null)
    }

    if (ev?.metaKey) return out(key === 'Enter' && !ev.shiftKey ? 'plan' : null)
    if (ev?.altKey || ev?.shiftKey) {
      // The modified actions belong to the item under the pointer, not to a
      // keystroke, with two exceptions: shift-G is the last item, and shift-R
      // inside a project reads everything its panels show again.
      if (key === 'G' || (key === 'g' && ev.shiftKey)) return out('last')
      if (!ev.altKey && (key === 'R' || (key === 'r' && ev.shiftKey))) return out(level >= 1 ? 'refresh:all' : null)
      return out(null)
    }

    // `g` is both a lens key and the first half of `gg`. It arms, and a second
    // `g` is the first item while anything else resolves it as the lens it
    // always was, so the old key still works. That one case is the only way a
    // sequence consumes the key that interrupts it. Escape disarms without
    // acting.
    if (pending === 'g') {
      if (key === 'g') return out('first')
      if (key === 'Escape') return out(null)
      return out('lens:git')
    }

    if (key === 'g') return out(null, 'g')
    if (key === 'l' || key === 'ArrowRight' || key === 'Enter') return out('in')
    if (key === 'h' || key === 'ArrowLeft') return out(level >= 1 ? 'out' : null)
    if (key === 'Escape') return out(level >= 1 ? 'out' : null)
    if (key === 'j' || key === 'ArrowDown') return out('next')
    if (key === 'k' || key === 'ArrowUp') return out('prev')
    if (key === ' ') return out('select')
    if (key === '/') return to('filter', 'filter')
    if (key === 'n') return out('triage:next')
    if (key === 'p') return out('triage:prev')
    if (key === 'r') return out(level >= 1 ? 'refresh' : null)
    if (key === 's' || key === 't' || key === 'e') return out('lens:' + LENS[key])
    if (typeof key === 'string' && DIGIT.test(key)) return out(null)
    return out(null)
  }

  return {
    EASE, RAIL_W, PANEL_RAIL_W, CHIP_ROW_H, STAGGER_MS, STAGGER_CAP,
    CARD_OMEGA, PANEL_ORDER, TARGETS,
    CARD_W, CARD_H, CARD_GAP, CARD_FRAME, CARD_TILT, STAGE_FOV, MOUNT_MIN_H,
    scale, staggerDelay, flipDelta, timeline, retargetSteps, chipSlots, chipSpan, cardGrid, cssFallback,
    keyAction,
  }
})()
