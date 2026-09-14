/* Syzygy -- the sandbox gallery's pure core.
   A CLASSIC script, like voice-math.js and canvas-layout.js: it assigns one
   global, MCGM, touches no DOM at load, and is evaluated under node by
   test/sandbox-harness.mjs through `new Function`. The component registry,
   the integrator every card moves by, the card layout and its no-overlap
   guarantee, float, tilt, the agents fly-out's geometry, the worktree graph's
   layout and scene, and the sample sessions and projects all live here, so
   the harness can drive each of them exactly.

   Every function is a function of its arguments: no DOM, no three, no
   motion, no clock. A caller that wants an answer for a moment in time
   passes the time.

   Positions are CSS pixels centred on the origin, with y growing downward
   the way the page's does. A y-up renderer negates y. */
'use strict'

const MCGM = (() => {
  const TAU = Math.PI * 2
  const finite = (v) => typeof v === 'number' && Number.isFinite(v)
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
  /** A length: a positive finite number, else 0. */
  const dim = (v) => (finite(v) && v > 0 ? v : 0)
  const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

  // ---- the registry ---------------------------------------------------------

  const deepFreeze = (o) => {
    for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v)
    return Object.freeze(o)
  }

  /** Every component the gallery can show, in the order it shows them. A
   *  descriptor is shared by every cell and every call, so it is frozen: a
   *  caller that writes into one throws at the write instead of quietly
   *  changing the defaults for everyone after it. */
  const REGISTRY = deepFreeze([
    {
      id: 'session-card',
      title: 'Session card',
      blurb: 'A live session as a floating card that settles into place, tilts under the pointer and fans its subagents out around itself.',
      layer: 'both',
      defaults: { hoverFollow: 50, maxTilt: 8 },
      knobs: {
        hoverFollow: { min: 5, max: 200, step: 1, unit: 'rad/s', label: 'Hover follow' },
        maxTilt: { min: 0, max: 20, step: 0.5, unit: '°', label: 'Max tilt' },
      },
    },
    {
      id: 'git-graph',
      title: 'Worktree graph',
      blurb: 'Every project, then one project\'s worktrees, then one branch\'s commits, each level re-laid in the same scene.',
      layer: 'both',
      defaults: {},
      knobs: {},
    },
  ])

  const componentById = (id) => REGISTRY.find((c) => c.id === id) || null

  /** A component's parameters: its defaults, overlaid by what the ledger
   *  stored, overlaid by a patch. Only the component's own knob keys come
   *  back, each clamped to its knob's range. A value that is not a finite
   *  number is skipped, so the layer beneath it stands -- a stray string in
   *  a hand-edited ledger cannot blank a knob. Always a new object; an
   *  unknown component has no knobs and gets `{}`. */
  const mergeParams = (id, stored, patch) => {
    const c = componentById(id)
    const out = {}
    if (!c) return out
    const layers = [c.defaults, stored, patch]
    for (const [key, knob] of Object.entries(c.knobs)) {
      let value = knob.min
      for (const layer of layers) {
        if (isRecord(layer) && finite(layer[key])) value = layer[key]
      }
      out[key] = clamp(value, knob.min, knob.max)
    }
    return out
  }

  // ---- the calm dial --------------------------------------------------------

  const CALM = Object.freeze(['still', 'settle', 'subtle', 'more'])
  const CALM_DEFAULT = 'subtle'
  const CALM_SCALE = { still: [0, 0], settle: [1, 0], subtle: [1, 1], more: [1, 2.2] }

  /** `settle` is whether a position change travels (1) or does not animate
   *  at all (0); `float` multiplies the drift amplitude. An unknown name is
   *  the default, and reduced motion is `still` whatever the dial says. */
  const calmScale = (name, reduced) => {
    if (reduced) return { settle: 0, float: 0 }
    const [settle, float] = CALM_SCALE[CALM.includes(name) ? name : CALM_DEFAULT]
    return { settle, float }
  }

  // ---- the integrator -------------------------------------------------------

  /** One critically damped step toward `target`. Semi-implicit: the velocity
   *  is integrated first and the position from the NEW velocity, which is what
   *  keeps it stable at a stiff omega and a long frame instead of ringing.
   *  dt is clamped first: a tab returning from the background hands the loop a
   *  dt measured in seconds, and an unclamped step would teleport every card
   *  across the stage in one frame.
   *
   *  The denominator is never zero for omega >= 0 and dt >= 0, so there is no
   *  division guard to forget. Both eigenvalues of the step are exactly
   *  1 / (1 + omega*dt), so from rest the gap after n steps is
   *  gap * (1 + n*u/(1+u)) / (1+u)^n with u = omega*dt: it shrinks without
   *  ever changing sign, which is why a card started from rest arrives and
   *  stops rather than passing its slot and coming back. */
  const DT_MAX = 0.05
  const stepCritical = (x, v, target, omega, dt) => {
    const h = Math.min(Math.max(dt, 0), DT_MAX)
    const w = Math.max(omega, 0)
    const f = 1 + w * h
    const den = f * f                      // (1 + w*h)^2, the critically damped denominator
    const gap = x - target
    const nv = (v - gap * (w * w * h)) / den
    return { x: x + nv * h, v: nv }
  }

  /** Seconds for a step from rest to come within 1% of its gap, for omega
   *  from 1 to 200 rad/s and any frame from 1/240 s to DT_MAX. The discrete
   *  step decays more slowly than the equation it approximates, so the
   *  continuous answer, 6 / omega, is too short at every omega; 12 / omega
   *  covers the decay. The flat 0.2 covers a stiff omega on a frame at
   *  DT_MAX, where one step is already several time constants wide and no
   *  multiple of 1 / omega describes how many steps it takes. */
  const settleBound = (omega) => 12 / Math.max(omega, 1e-6) + 0.2

  // ---- the card layout and float --------------------------------------------

  /** `n` positions on a centred grid, row-major, `px` apart across and `py`
   *  apart down. A short last row is centred under the rows above it, which
   *  only ever moves a card half a pitch sideways against a full pitch
   *  down, so no two positions are closer than min(px, py). */
  const gridAt = (n, px, py) => {
    if (!(n > 0)) return []
    const cols = Math.ceil(Math.sqrt(n))
    const rows = Math.ceil(n / cols)
    const out = []
    for (let k = 0; k < n; k++) {
      const row = Math.floor(k / cols)
      const inRow = row < rows - 1 ? cols : n - cols * (rows - 1)
      out.push({ x: ((k % cols) - (inRow - 1) / 2) * px, y: (row - (rows - 1) / 2) * py })
    }
    return out
  }

  /** Card centres on the tightest grid whose neighbour distance is at least
   *  `sep`, row-major, centred on the origin, one per id in the order given.
   *  With no usable `sep` the pitch is the card's diagonal. */
  const cardSlots = (ids, opts) => {
    const list = Array.isArray(ids) ? ids : []
    const o = opts || {}
    const pitch = dim(o.sep) || Math.hypot(dim(o.w), dim(o.h))
    return gridAt(list.length, pitch, pitch).map((p, k) => ({ id: list[k], x: p.x, y: p.y }))
  }

  /** The largest float amplitude that cannot bring two cards into contact.
   *  Two cards `sep` apart, each drifting at most `amp` in the card plane,
   *  can close the gap by at most 2 * amp, which leaves 2 * r -- and `r`,
   *  the half-diagonal, bounds a card at any rotation. Never negative. */
  const floatAmp = (sep, r) => {
    const amp = (sep - 2 * r) / 2
    return amp > 0 ? amp : 0
  }

  /** FNV-1a over the string form of `seed`. Cheap, and stable across reloads. */
  const hash = (seed) => {
    const s = String(seed)
    let x = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
      x ^= s.charCodeAt(i)
      x = Math.imul(x, 0x01000193)
    }
    return x >>> 0
  }

  /** A seeded sequence in [0, 1): the same seed always yields the same run. */
  const seeded = (seed) => {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const FLOAT_PERIOD_MIN = 6
  const FLOAT_PERIOD_MAX = 10

  /** The drift of the element named `seed` at `t` seconds. Three periods and
   *  three phases come from the seed's hash, so no two elements move
   *  together and one element moves the same way on every reload. dx and dy
   *  each carry a factor of 1/sqrt(2), so the drift across the card plane
   *  never exceeds `amp` in any direction -- the bound floatAmp is derived
   *  from. dz moves along the view axis, not across that plane, and takes
   *  the whole amplitude. */
  const floatAt = (seed, t, amp) => {
    const a = dim(amp)
    if (!a) return { dx: 0, dy: 0, dz: 0 }
    const time = finite(t) ? t : 0
    const next = seeded(hash(seed))
    const wave = () => {
      const period = FLOAT_PERIOD_MIN + next() * (FLOAT_PERIOD_MAX - FLOAT_PERIOD_MIN)
      const phase = next() * TAU
      return Math.sin(phase + (TAU / period) * time)
    }
    const sx = wave()
    const sy = wave()
    const sz = wave()
    return { dx: a * Math.SQRT1_2 * sx, dy: a * Math.SQRT1_2 * sy, dz: a * sz }
  }

  // ---- tilt -----------------------------------------------------------------

  /** The tilt, in degrees, for a pointer over `rect` (anything with left,
   *  top, width and height, a DOMRect included). Each axis is the pointer's
   *  offset from the centre over the half-extent, clamped to [-1, 1] and
   *  scaled by `maxTilt`, so the tilt follows the hand with no lag of its
   *  own and a pointer past the edge stays bounded. In CSS rotateX/rotateY
   *  terms the side nearest the pointer tips away from the viewer. The `+ 0`
   *  turns a negated zero into a plain one, so a centred pointer compares
   *  equal to no tilt at all. */
  const tiltFor = (pointer, rect, maxTilt) => {
    const p = pointer || {}
    const b = rect || {}
    const m = dim(maxTilt)
    const axis = (at, start, size) => {
      const half = dim(size) / 2
      if (!half || !finite(at) || !finite(start)) return 0
      return clamp((at - (start + half)) / half, -1, 1)
    }
    const nx = axis(p.x, b.left, b.width)
    const ny = axis(p.y, b.top, b.height)
    return { rx: m * -ny + 0, ry: m * nx + 0 }
  }

  const smoothstep = (k) => k * k * (3 - 2 * k)

  /** One frame of tilt: each axis moves toward `target` scaled by the eased
   *  `ramp`, by at most `maxPerFrame` degrees. A caller runs `ramp` from 0
   *  to 1 over about 120 ms when the hot card changes, so a sweep across
   *  several cards is one continuous motion rather than a jump per card. The
   *  ease reaches the full target as `ramp` nears 1 and starts from a
   *  standstill at 0. */
  const slewTilt = (cur, target, maxPerFrame, ramp) => {
    const c = cur || {}
    const g = target || {}
    const limit = maxPerFrame > 0 ? maxPerFrame : 0
    const k = ramp > 0 ? smoothstep(Math.min(ramp, 1)) : 0
    const axis = (from, to) => {
      const at = finite(from) ? from : 0
      const goal = (finite(to) ? to : 0) * k
      return at + clamp(goal - at, -limit, limit)
    }
    return { rx: axis(c.rx, g.rx), ry: axis(c.ry, g.ry) }
  }

  // ---- the agents fly-out ---------------------------------------------------

  const FLY_GAP = 18
  const box = (b) => ({ x: finite(b?.x) ? b.x : 0, y: finite(b?.y) ? b.y : 0, w: dim(b?.w), h: dim(b?.h) })
  /** The ring every child sits on: both half-diagonals plus a gap, so a child
   *  at ANY angle clears the parent's corner rather than only its edges. A
   *  ring sized from the half-width would clear the parent's sides and let a
   *  child cut across a corner. */
  const ringR = (parent, child) =>
    Math.hypot(parent.w, parent.h) / 2 + Math.hypot(child.w, child.h) / 2 + FLY_GAP
  /** `n` children fanned across 216 degrees centred straight above the parent. */
  const angleOf = (i, n) => (-Math.PI / 2) + ((i + 0.5) / n - 0.5) * (Math.PI * 1.2)
  const countOf = (n) => Math.max(1, Math.floor(n) || 1)

  /** How far from the parent's centre, along angle `a`, a child's centre has
   *  to be before the two rectangles stop overlapping. Never more than the
   *  distance to the corner of the rectangle both half-sizes add up to, which
   *  is itself never more than the two half-diagonals together. */
  const clearanceAt = (a, parent, child) => {
    const c = Math.abs(Math.cos(a))
    const s = Math.abs(Math.sin(a))
    const across = c > 1e-12 ? (parent.w + child.w) / 2 / c : Infinity
    const down = s > 1e-12 ? (parent.h + child.h) / 2 / s : Infinity
    return Math.min(across, down)
  }

  /** Child `i` of `n`'s place across the fan, from 0 at one end to 1 at the
   *  other. flyOutPath's angle depends on this fraction alone, so a caller
   *  easing a child from one fan to another eases the fraction and hands
   *  flyOutPath `fanIndex(fraction, n)` as `i`. */
  const fanFraction = (i, n) => ((finite(i) ? i : 0) + 0.5) / countOf(n)
  const fanIndex = (fraction, n) => (finite(fraction) ? fraction : 0.5) * countOf(n) - 0.5

  /** Where child `i` of `n` is at progress `t` (0 closed, 1 open): its centre
   *  in the parent's coordinates, its scale and its opacity. Neither variant
   *  ever brings a child's rectangle onto the parent's, at any progress and
   *  whatever its opacity, and neither ever brings its scale to zero, so a
   *  child never overlaps the parent's rectangle and never collapses to a
   *  point on it. `i` may be fractional (see fanIndex). */
  const flyOutPath = (variant, parentRect, childRect, i, n, t) => {
    const parent = box(parentRect)
    const child = box(childRect)
    const count = countOf(n)
    const k = t > 0 ? Math.min(t, 1) : 0
    const R = ringR(parent, child)
    const a = angleOf(finite(i) ? i : 0, count)
    if (variant === 'slide') {
      // Final size from the start; it travels outward and fades in. The inner
      // end of that travel is the ring pulled in by 8%, but never nearer than
      // half a gap outside the point where the rectangles would meet along
      // this direction -- the opacity may be animated on a clock of its own,
      // so the position alone has to keep the child off the parent.
      const inner = Math.max(R * 0.92, clearanceAt(a, parent, child) + FLY_GAP / 2)
      const r = inner + (R - inner) * k
      return { x: parent.x + Math.cos(a) * r, y: parent.y + Math.sin(a) * r, z: 0, scale: 1, opacity: k }
    }
    // Grows in place on the ring. The radius never moves, so nothing can
    // cross the parent no matter how small the child starts.
    return { x: parent.x + Math.cos(a) * R, y: parent.y + Math.sin(a) * R, z: 0, scale: 0.25 + 0.75 * k, opacity: k }
  }

  const EXIT_MARGIN = 24

  /** Where a sibling card goes while a fly-out is open: straight out from the
   *  viewport's centre until the whole card sits past the nearest edge it is
   *  heading for, plus a margin. `viewport` is centred on the origin like
   *  every position here. A card exactly at the centre has no direction of
   *  its own, so `i` of `n` spreads those around the circle, starting from
   *  straight up. A card already past an edge stays where it is. */
  const siblingExit = (rect, viewport, i, n) => {
    const r = box(rect)
    const vw = dim(viewport?.w) / 2
    const vh = dim(viewport?.h) / 2
    let dx = r.x
    let dy = r.y
    const len = Math.hypot(dx, dy)
    if (len < 1) {
      const count = Math.max(1, Math.floor(n) || 1)
      const a = -Math.PI / 2 + TAU * ((finite(i) ? i : 0) / count)
      dx = Math.cos(a)
      dy = Math.sin(a)
    } else {
      dx /= len
      dy /= len
    }
    const reach = (at, d, half, halfView) =>
      d === 0 ? Infinity : (Math.sign(d) * (halfView + half + EXIT_MARGIN) - at) / d
    const s = Math.max(0, Math.min(reach(r.x, dx, r.w / 2, vw), reach(r.y, dy, r.h / 2, vh)))
    return { x: r.x + dx * s, y: r.y + dy * s }
  }

  /** How far from the parent's centre any part of the fly-out can reach on
   *  each axis -- the parent itself and every child, in either variant, at
   *  any progress and any place in the fan. A camera that keeps this much in
   *  view around the parent keeps the whole fly-out in view. */
  const flyOutReach = (parentRect, childRect) => {
    const parent = box(parentRect)
    const child = box(childRect)
    const R = ringR(parent, child)
    return { x: Math.max(parent.w / 2, R + child.w / 2), y: Math.max(parent.h / 2, R + child.h / 2) }
  }

  /** Where every card goes for the fly-out on `openId`: one `{ id, x, y,
   *  parked }` per id, in the order given. Closed -- `openId` null, or not
   *  among `ids` -- every card is at its cardSlots slot and none is parked.
   *  Open, the open card is at the origin and every other card is parked:
   *  sent by siblingExit from the slot it would hold, so it sits wholly
   *  outside `viewport`. A card that arrives while the fly-out is open is
   *  just another id here, so it parks with the rest, and a card that leaves
   *  simply drops out. `opts` is cardSlots' `{ w, h, sep }` plus
   *  `viewport: { w, h }`. */
  const flyOutLayout = (ids, openId, opts) => {
    const o = opts || {}
    const slots = cardSlots(ids, o)
    const open = openId == null ? -1 : slots.findIndex((p) => p.id === openId)
    if (open < 0) return slots.map((p) => ({ id: p.id, x: p.x, y: p.y, parked: false }))
    const siblings = slots.length - 1
    let k = 0
    return slots.map((p, j) => {
      if (j === open) return { id: p.id, x: 0, y: 0, parked: false }
      const at = siblingExit({ x: p.x, y: p.y, w: o.w, h: o.h }, o.viewport, k++, siblings)
      return { id: p.id, x: at.x, y: at.y, parked: true }
    })
  }

  /** One key per subagent, in the order given, for keeping a child card
   *  across updates: its `id` as a string, else its position in the list.
   *  A non-object entry has no card and no key, and a repeated key keeps
   *  only its first entry. `{ key, agent }` pairs. */
  const agentKeys = (agents) => {
    const out = []
    const seen = new Set()
    const list = Array.isArray(agents) ? agents : []
    for (let j = 0; j < list.length; j++) {
      const a = list[j]
      if (!isRecord(a)) continue
      const key = a.id != null && a.id !== '' ? 'id:' + String(a.id) : 'at:' + j
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ key, agent: a })
    }
    return out
  }

  // ---- the worktree graph ---------------------------------------------------

  const PROJECT_PITCH_X = 180
  const PROJECT_PITCH_Y = 110
  const BRANCH_PITCH_X = 200
  const BRANCH_PITCH_Y = 110
  const COMMIT_PITCH = 44

  const empty = () => ({ nodes: [], edges: [] })

  /** Items with a non-empty string under `key`, the first of each value only,
   *  since a node id has to be unique for the scene to key on it. */
  const uniqueBy = (list, key) => {
    const seen = new Set()
    const out = []
    for (const item of list) {
      if (!isRecord(item)) continue
      const id = item[key]
      if (typeof id !== 'string' || !id || seen.has(id)) continue
      seen.add(id)
      out.push(item)
    }
    return out
  }

  /** `{ nodes, edges }` for one level of the graph.
   *
   *  'projects' takes the snapshot's projects list: one node per project,
   *  `{ id: key, name, x, y }`, on a centred grid, with no edges.
   *
   *  'worktrees' takes a gitGraph: one node per branch,
   *  `{ id: name, main, head, ahead, behind, x, y }`, the base first and
   *  alone on the top row when there is one, the rest on a grid beneath it,
   *  and an edge from the base to every other branch, the relation ahead and
   *  behind are counted along. `base` may be absent or null, and both mean
   *  there is nothing to measure against: no node is `main` and there are no
   *  edges. Never inferred from isMain, a branch's name or its position.
   *  `ahead` and `behind` are passed through, never defaulted: a 0 says
   *  "level with the base" and a null says "not measured".
   *
   *  'commits' takes a gitGraph and the branch name in `focus`: one node per
   *  commit, `{ id: sha, sha7, subject, at, x, y }`, in the order published,
   *  which is newest first, so the newest is at the top. One `rail` edge joins
   *  each commit to the one after it, and every parent past the first is a
   *  `merge` edge -- whose far end usually lies outside this branch's
   *  commits and so is not a node here.
   *
   *  Input of the wrong shape for its level, an unknown level, a missing
   *  branch or a branch with no commits gives no nodes and no edges, never a
   *  throw. */
  const graphLayout = (input, level, focus) => {
    if (level === 'projects') {
      if (!Array.isArray(input)) return empty()
      const projects = uniqueBy(input, 'key')
      const at = gridAt(projects.length, PROJECT_PITCH_X, PROJECT_PITCH_Y)
      return {
        nodes: projects.map((p, k) => ({
          id: p.key, name: typeof p.name === 'string' ? p.name : p.key, x: at[k].x, y: at[k].y,
        })),
        edges: [],
      }
    }
    if (level !== 'worktrees' && level !== 'commits') return empty()
    if (!isRecord(input) || !Array.isArray(input.branches)) return empty()
    const branches = uniqueBy(input.branches, 'name')

    if (level === 'worktrees') {
      const base = typeof input.base === 'string' && input.base ? input.base : null
      const baseBranch = base === null ? null : branches.find((b) => b.name === base) || null
      const rest = branches.filter((b) => b !== baseBranch)
      const grid = gridAt(rest.length, BRANCH_PITCH_X, BRANCH_PITCH_Y)
      const restRows = rest.length ? Math.ceil(rest.length / Math.ceil(Math.sqrt(rest.length))) : 0
      const drop = baseBranch ? BRANCH_PITCH_Y / 2 : 0
      const nodeOf = (b, x, y) => ({
        id: b.name,
        main: b === baseBranch,
        head: typeof b.head === 'string' ? b.head : null,
        ahead: b.ahead ?? null,
        behind: b.behind ?? null,
        x,
        y,
      })
      const nodes = []
      if (baseBranch) nodes.push(nodeOf(baseBranch, 0, -(restRows / 2) * BRANCH_PITCH_Y))
      rest.forEach((b, k) => nodes.push(nodeOf(b, grid[k].x, grid[k].y + drop)))
      const edges = baseBranch ? rest.map((b) => ({ from: baseBranch.name, to: b.name, kind: 'base' })) : []
      return { nodes, edges }
    }

    const branch = typeof focus === 'string' ? branches.find((b) => b.name === focus) : null
    if (!branch || !Array.isArray(branch.commits)) return empty()
    const commits = uniqueBy(branch.commits, 'sha')
    const mid = (commits.length - 1) / 2
    const nodes = commits.map((c, k) => ({
      id: c.sha,
      sha7: c.sha.slice(0, 7),
      subject: typeof c.subject === 'string' ? c.subject : '',
      at: finite(c.at) ? c.at : null,
      x: 0,
      y: (k - mid) * COMMIT_PITCH,
    }))
    const edges = []
    for (let k = 1; k < commits.length; k++) {
      edges.push({ from: commits[k - 1].sha, to: commits[k].sha, kind: 'rail' })
    }
    for (const c of commits) {
      const parents = Array.isArray(c.parents) ? c.parents : []
      for (const p of parents.slice(1)) {
        if (typeof p === 'string' && p) edges.push({ from: c.sha, to: p, kind: 'merge' })
      }
    }
    return { nodes, edges }
  }

  /** A graph of worktree heads, for a project whose history is not published:
   *  one branch per worktree, named by its branch or, when detached, by its
   *  short head, with no commits and nothing measured. */
  const headsOf = (worktrees) => ({
    base: null,
    builtAt: 0,
    truncated: false,
    branches: (Array.isArray(worktrees) ? worktrees : []).filter(isRecord).map((w) => ({
      name: w.branch || String(w.head || '').slice(0, 7),
      head: w.head,
      isMain: !!w.isMain,
      ahead: null,
      behind: null,
      commits: [],
      truncated: false,
    })),
  })

  /** The graph to draw for a project, and which of five situations it is:
   *  'graph'  -- gitGraph is an object with branches; it passes through as is.
   *  'empty'  -- gitGraph is an object with no branches, or the key is absent
   *              and the project has no worktrees: nothing to draw.
   *  'heads'  -- the key is absent, as from a relay that does not publish
   *              it: the worktree heads stand in, with no commit rails.
   *  'nogit'  -- the project says it is not a git repository (`isGit` is
   *              false): an empty graph, whatever gitGraph holds. The scanner
   *              sends a null gitGraph for such a folder too, so this is
   *              decided before a null is read as a failure.
   *  'failed' -- gitGraph is null (the history could not be read) or any
   *              other non-object on a project that is, or may be, a git
   *              repository, or `project` is not an object: the heads stand
   *              in where there are any, and the failure is reported even
   *              when there are none.
   *  The test is `'gitGraph' in project` rather than `?? null`, because an
   *  absent key and a null value need different sentences. Never throws. */
  const graphFor = (project) => {
    if (!isRecord(project)) return { graph: headsOf([]), state: 'failed' }
    if (project.isGit === false) return { graph: headsOf([]), state: 'nogit' }
    if (!('gitGraph' in project)) {
      const graph = headsOf(project.worktrees ?? [])
      return { graph, state: graph.branches.length ? 'heads' : 'empty' }
    }
    const g = project.gitGraph
    if (isRecord(g)) return { graph: g, state: Array.isArray(g.branches) && g.branches.length ? 'graph' : 'empty' }
    return { graph: headsOf(project.worktrees), state: 'failed' }
  }

  /** The board as the worktree graph draws it. The digest every pane is sent
   *  carries no git history; a graph read from the graph route is laid over
   *  its project here. `graphs` maps a project key to `{ status, changedAt,
   *  gitGraph }`: an `ok` entry is laid over whatever changedAt it was read
   *  at, and a `loading` entry that carries the read before it is laid over
   *  too, so a project keeps its history while a newer read is in flight
   *  rather than dropping to its heads and back. Nothing read yet, a 404 and
   *  a failed read leave the project untouched -- no key at all, so graphFor
   *  draws the worktree heads -- and a null graph passes through as null.
   *  Always a new array; never writes a project or the cache. */
  const withGraphs = (projects, graphs) => {
    const readable = graphs && typeof graphs.get === 'function'
    return (Array.isArray(projects) ? projects : []).map((p) => {
      if (!isRecord(p) || !readable) return p
      const entry = graphs.get(p.key)
      const held = isRecord(entry) && (entry.status === 'ok' || entry.status === 'loading') && 'gitGraph' in entry
      return held ? { ...p, gitGraph: entry.gitGraph } : p
    })
  }

  // ---- the worktree graph's scene -------------------------------------------

  /** The drawn size of each kind of label in the graph's scene, in CSS pixels;
   *  the space kept between a label and the one stacked beneath it; the
   *  commit pitch; and the rail's geometry: the rail runs `railGap` to the
   *  left of a commit's label, and a merge's second edge bends out a further
   *  `lane` to the left of the rail. The stylesheet holds the same sizes. */
  const GRAPH_GEOM = deepFreeze({
    project: { w: 164, h: 62 },
    branch: { w: 176, h: 46 },
    commit: { w: 260, h: 30 },
    note: { w: 260, h: 30 },
    gap: 22,
    pitch: COMMIT_PITCH,
    railGap: 16,
    lane: 22,
  })
  /** Where the rail crosses a commit's row, across from its label's centre. */
  const GRAPH_RAIL_DX = -(GRAPH_GEOM.commit.w / 2 + GRAPH_GEOM.railGap)

  /** What a project says about itself in every graphFor situation but
   *  'graph', where it counts its branches instead. */
  const GRAPH_SENTENCE = Object.freeze({
    heads: 'this relay publishes no commit history, so branches are shown without rails',
    failed: 'the git history could not be read',
    empty: 'nothing to draw',
    nogit: 'not a git repository',
  })
  /** Why a branch drilled into has no commits to show, by its project's
   *  graphFor situation. */
  const BRANCH_NOTE = Object.freeze({
    heads: 'this relay publishes no commit history for this branch',
    failed: 'the git history could not be read, so this branch has none to show',
    graph: 'git logged no commits for this branch',
  })

  /** A branch's ahead/behind column. Blank whenever nothing is measured: no
   *  base at all, or a count that is not a number. The base itself reads
   *  `base`. A 0 is written only when a base exists and the count is 0. */
  const measureOf = (node, hasBase) => {
    if (!hasBase) return ''
    if (node.main) return 'base'
    return finite(node.ahead) && finite(node.behind) ? `↑${node.ahead} ↓${node.behind}` : ''
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

  /** Every label of the graph's scene at one level, where it belongs, and the
   *  lines between them. `projects` is the snapshot's list; `focus` is
   *  `{ project, branch }` -- a project key, and a branch name within it.
   *
   *  'projects'  -- one label per project on graphLayout's grid.
   *  'worktrees' -- the focused project above its branches (graphLayout's
   *                 worktrees level), the pair centred on the origin; every
   *                 other project is parked.
   *  'commits'   -- the focused project, the focused branch beneath it and
   *                 that branch's commits beneath that, newest at the top, all
   *                 centred on the origin; every other project and every other
   *                 branch is parked. A branch with no commits gets a `note`
   *                 label saying why instead.
   *  A focus that names no project falls back to 'projects', and one that
   *  names no branch of it to 'worktrees'; the answer says which level and
   *  focus it settled on.
   *
   *  A node is `{ id, kind, key, parent, x, y, w, h, parked, focus }` plus
   *  what its label shows. Ids are prefixed by kind (`p:`, `b:`, `c:`, and
   *  `note`) so a branch named like a project key cannot collide with it.
   *  `parent` is the id a label spreads out from and returns to. A parked
   *  node's x and y are where it would sit at the level that shows it -- a
   *  project's grid slot, a branch's place under its project -- for
   *  siblingExit to send it out from.
   *
   *  Edges are `{ from, to, kind }`: 'stem' joins a project to its base
   *  branch (or to every branch, when there is no base) and a focused branch
   *  to its newest commit; 'base' joins the base to each other branch; 'rail'
   *  joins consecutive commits; 'merge' joins a merge commit to its second
   *  parent, with `to` null when that parent is not among the commits shown.
   *  A commit's end of any line is its point on the rail, GRAPH_RAIL_DX
   *  across from its label.
   *
   *  `reach` is how far the labels and lines that are not parked extend from
   *  the origin on each axis. Never throws. */
  const graphScene = (projects, level, focus) => {
    const G = GRAPH_GEOM
    const list = Array.isArray(projects) ? projects : []
    const top = graphLayout(list, 'projects')
    const byKey = new Map()
    for (const p of uniqueBy(list, 'key')) byKey.set(p.key, p)
    const f = isRecord(focus) ? focus : {}
    let lv = level === 'worktrees' || level === 'commits' ? level : 'projects'
    const project = lv !== 'projects' && typeof f.project === 'string' ? byKey.get(f.project) || null : null
    if (!project) lv = 'projects'
    const read = project ? graphFor(project) : null
    const pid = project ? 'p:' + project.key : null

    // The focused project's worktrees level: the project above its branches,
    // the pair centred vertically on the origin.
    let wt = null
    if (project) {
      const layout = graphLayout(read.graph, 'worktrees')
      let lo = Infinity
      let hi = -Infinity
      for (const n of layout.nodes) {
        lo = Math.min(lo, n.y - G.branch.h / 2)
        hi = Math.max(hi, n.y + G.branch.h / 2)
      }
      const py = layout.nodes.length ? lo - G.gap - G.project.h / 2 : 0
      const bottom = layout.nodes.length ? hi : py + G.project.h / 2
      const shift = -((py - G.project.h / 2) + bottom) / 2
      wt = { layout, py: py + shift, shift, hasBase: layout.nodes.some((n) => n.main) }
    }

    const branch = lv === 'commits' && typeof f.branch === 'string'
      ? wt.layout.nodes.find((n) => n.id === f.branch) || null
      : null
    if (lv === 'commits' && !branch) lv = 'worktrees'

    const raw = new Map()
    if (read && Array.isArray(read.graph.branches)) {
      for (const b of uniqueBy(read.graph.branches, 'name')) raw.set(b.name, b)
    }

    // The commits level: project, branch, then the commits or the note, the
    // whole stack centred vertically on the origin, and the rail and its
    // merge lane centred with the labels across.
    let cm = null
    if (branch) {
      const layout = graphLayout(read.graph, 'commits', branch.id)
      const by = G.project.h / 2 + G.gap + G.branch.h / 2
      const below = by + G.branch.h / 2 + G.gap
      const first = layout.nodes.length ? layout.nodes[0].y : 0
      const rows = layout.nodes.map((n) => ({ n, y: below + G.commit.h / 2 + (n.y - first) }))
      const last = rows.length ? rows[rows.length - 1].y + G.commit.h / 2 : below + G.note.h
      const shift = -((-G.project.h / 2) + last) / 2
      cm = {
        layout, rows, shift,
        py: shift, by: by + shift, noteY: below + G.note.h / 2 + shift,
        x: (G.railGap + G.lane) / 2,
      }
    }

    const nodes = []
    const edges = []

    for (const n of top.nodes) {
      const p = byKey.get(n.id)
      const isFocus = p === project
      const r = isFocus ? read : graphFor(p)
      const count = r.state === 'graph' ? uniqueBy(r.graph.branches, 'name').length : 0
      const placed = lv === 'projects' || !isFocus
      nodes.push({
        id: 'p:' + n.id, kind: 'project', key: n.id, parent: null,
        name: n.name,
        state: r.state,
        sub: r.state === 'graph' ? plural(count, 'branch', 'branches') : GRAPH_SENTENCE[r.state],
        x: placed ? n.x : 0,
        y: placed ? n.y : lv === 'commits' ? cm.py : wt.py,
        w: G.project.w, h: G.project.h,
        parked: lv !== 'projects' && !isFocus,
        focus: lv !== 'projects' && isFocus,
      })
    }

    if (lv !== 'projects') {
      for (const n of wt.layout.nodes) {
        const b = raw.get(n.id)
        const isFocus = branch !== null && n.id === branch.id
        nodes.push({
          id: 'b:' + n.id, kind: 'branch', key: n.id, parent: pid,
          name: n.id,
          head: typeof n.head === 'string' ? n.head.slice(0, 7) : '',
          commits: b && Array.isArray(b.commits) ? uniqueBy(b.commits, 'sha').length : 0,
          truncated: !!(b && b.truncated),
          main: n.main,
          measure: measureOf(n, wt.hasBase),
          x: isFocus ? 0 : n.x,
          y: isFocus ? cm.by : n.y + wt.shift,
          w: G.branch.w, h: G.branch.h,
          parked: lv === 'commits' && !isFocus,
          focus: isFocus,
        })
      }
    }

    if (lv === 'worktrees') {
      const base = wt.layout.nodes.find((n) => n.main)
      if (base) {
        edges.push({ from: pid, to: 'b:' + base.id, kind: 'stem' })
        for (const e of wt.layout.edges) edges.push({ from: 'b:' + e.from, to: 'b:' + e.to, kind: 'base' })
      } else {
        for (const n of wt.layout.nodes) edges.push({ from: pid, to: 'b:' + n.id, kind: 'stem' })
      }
    }

    if (cm) {
      const bid = 'b:' + branch.id
      edges.push({ from: pid, to: bid, kind: 'stem' })
      const shown = new Set(cm.rows.map((r) => r.n.id))
      const merges = new Set()
      for (const e of cm.layout.edges) {
        if (e.kind === 'rail') edges.push({ from: 'c:' + e.from, to: 'c:' + e.to, kind: 'rail' })
        else {
          merges.add(e.from)
          edges.push({ from: 'c:' + e.from, to: shown.has(e.to) ? 'c:' + e.to : null, kind: 'merge' })
        }
      }
      if (cm.rows.length) edges.push({ from: bid, to: 'c:' + cm.rows[0].n.id, kind: 'stem' })
      for (const { n, y } of cm.rows) {
        nodes.push({
          id: 'c:' + n.id, kind: 'commit', key: n.id, parent: bid,
          sha7: n.sha7, subject: n.subject, at: n.at, merge: merges.has(n.id),
          x: cm.x, y, w: G.commit.w, h: G.commit.h,
          parked: false, focus: false,
        })
      }
      if (!cm.rows.length) {
        nodes.push({
          id: 'note', kind: 'note', key: 'note', parent: bid,
          text: BRANCH_NOTE[read.state] || BRANCH_NOTE.graph,
          x: 0, y: cm.noteY, w: G.note.w, h: G.note.h,
          parked: false, focus: false,
        })
      }
    }

    let rx = 0
    let ry = 0
    for (const n of nodes) {
      if (n.parked) continue
      rx = Math.max(rx, Math.abs(n.x) + n.w / 2)
      ry = Math.max(ry, Math.abs(n.y) + n.h / 2)
      if (n.kind === 'commit') {
        rx = Math.max(rx, Math.abs(n.x + GRAPH_RAIL_DX - G.lane))
        // A merge whose second parent is not shown bends down a full pitch.
        if (n.merge) ry = Math.max(ry, Math.abs(n.y + G.pitch))
      }
    }

    return {
      level: lv,
      focus: { project: project ? project.key : null, branch: branch ? branch.id : null },
      state: read ? read.state : null,
      nodes,
      edges,
      reach: { x: rx, y: ry },
    }
  }

  // ---- sample sessions ------------------------------------------------------

  const SAMPLE_MAX = 64
  const SAMPLE_EPOCH = 1_700_000_000_000
  const SAMPLE_NAMES = ['atlas', 'borealis', 'cinder', 'drift', 'ember', 'fathom',
    'gale', 'harbor', 'kestrel', 'lumen', 'meridian', 'nimbus']
  const SAMPLE_MODELS = ['opus', 'sonnet', 'haiku']
  const SAMPLE_BRANCHES = ['main', 'feat/relay-routes', 'fix/band-width', 'feat/card-frame', 'chore/readme']
  const SAMPLE_TYPES = ['Explore', 'general-purpose', 'Plan']
  const SAMPLE_TASKS = ['Survey the relay routes', 'Draft the card styles', 'Check the layout bound',
    'Trace the settle loop', 'Read the worktree list', 'Review the last commit']

  /** `n` sessions shaped like the relay's own -- id, name, model, branch,
   *  working, status, startedAt, stats and an agents array of
   *  `{ id, description, type, status }` -- drawn from `seed`, so the same
   *  arguments always give the same sessions. The first session always has
   *  three subagents, two running and one done, so the fly-out has a card to
   *  open whatever the seed; the rest have up to three each. */
  const sampleSessions = (n, seed) => {
    const count = clamp(Math.floor(n) || 0, 0, SAMPLE_MAX)
    const next = seeded(hash('sample:' + String(seed)))
    const pick = (list) => list[Math.floor(next() * list.length)]
    const nameStart = Math.floor(next() * SAMPLE_NAMES.length)
    const out = []
    for (let k = 0; k < count; k++) {
      const id = `sample-${k + 1}`
      const lap = Math.floor(k / SAMPLE_NAMES.length)
      const name = SAMPLE_NAMES[(nameStart + k) % SAMPLE_NAMES.length] + (lap ? `-${lap + 1}` : '')
      const agentCount = k === 0 ? 3 : Math.floor(next() * 4)
      const agents = []
      for (let j = 0; j < agentCount; j++) {
        const running = k === 0 ? j < 2 : next() < 0.5
        agents.push({ id: `${id}-agent-${j + 1}`, description: pick(SAMPLE_TASKS), type: pick(SAMPLE_TYPES), status: running ? 'running' : 'done' })
      }
      const working = agents.some((g) => g.status === 'running') || next() < 0.4
      out.push({
        id,
        name,
        model: pick(SAMPLE_MODELS),
        branch: pick(SAMPLE_BRANCHES),
        working,
        status: working ? 'Working…' : 'Idle.',
        startedAt: SAMPLE_EPOCH + k * 60_000,
        stats: {
          ctx: 20_000 + Math.floor(next() * 150_000),
          ctxLimit: 200_000,
          outTok: Math.floor(next() * 40_000),
          spend: Math.round(next() * 800) / 100,
          tools: Math.floor(next() * 120),
          guardrails: 0,
          errors: Math.floor(next() * 3),
          diff: { added: Math.floor(next() * 400), removed: Math.floor(next() * 150) },
        },
        agents,
      })
    }
    return out
  }

  // ---- sample projects ------------------------------------------------------

  const SAMPLE_PROJECT_NAMES = ['harbor-deck', 'lumen-kit', 'nimbus-api', 'kestrel-cli', 'meridian-web', 'fathom-docs']
  const SAMPLE_FEATURES = ['feat/rail-labels', 'feat/level-fade', 'feat/branch-spread']
  const SAMPLE_FIXES = ['fix/merge-stub', 'fix/detached-head', 'fix/scan-cache']
  const SAMPLE_SUBJECTS = ['Tighten the relay handshake', 'Draw the rail between commits',
    'Read the worktree list once', 'Settle labels on the integrator', 'Trim the snapshot payload',
    'Guard the scanner against a bare repo', 'Fade labels between levels', 'Name the merge edge']

  /** Three projects shaped like the snapshot's own -- key, name, isGit,
   *  worktrees of `{ path, branch, head, isMain }` and, where the relay would
   *  send one, gitGraph -- drawn from `seed`, so the same seed always gives
   *  the same projects. In order:
   *    a git repository with a full graph: a base, three branches, and a
   *      merge commit whose second parent is among the base's own commits;
   *    a git repository with no gitGraph key at all, as from a relay that
   *      does not publish one;
   *    a folder that is not a git repository, with the null gitGraph the
   *      scanner sends for one. */
  const sampleProjects = (seed) => {
    const next = seeded(hash('projects:' + String(seed)))
    const pick = (l) => l[Math.floor(next() * l.length)]
    const sha = () => {
      let s = ''
      for (let i = 0; i < 40; i++) s += Math.floor(next() * 16).toString(16)
      return s
    }
    const start = Math.floor(next() * SAMPLE_PROJECT_NAMES.length)
    const nameAt = (k) => SAMPLE_PROJECT_NAMES[(start + k) % SAMPLE_PROJECT_NAMES.length]
    const feat = pick(SAMPLE_FEATURES)
    const fix = pick(SAMPLE_FIXES)

    // Oldest first, so every parent exists before its child names it.
    let at = SAMPLE_EPOCH
    const commit = (parents, subject) => {
      at += 60_000 * (20 + Math.floor(next() * 400))
      return { sha: sha(), parents: parents.map((c) => c.sha), subject: subject || pick(SAMPLE_SUBJECTS), at }
    }
    const m4 = commit([])
    const m3 = commit([m4])
    const m2 = commit([m3])
    const h0 = commit([m3])
    const f1 = commit([m2])
    const m1 = commit([m2, f1], `Merge branch '${feat}'`)
    const g2 = commit([m1])
    const g1 = commit([g2])
    const m0 = commit([m1])
    const g0 = commit([g1])
    const short = (c) => c.sha.slice(0, 7)

    const one = nameAt(0)
    const graph = {
      base: 'main',
      builtAt: at + 60_000,
      truncated: false,
      branches: [
        { name: 'main', head: short(m0), isMain: true, ahead: 0, behind: 0, truncated: false,
          commits: [m0, m1, f1, m2, m3, m4] },
        { name: feat, head: short(g0), isMain: false, ahead: 3, behind: 1, truncated: false,
          commits: [g0, g1, g2, m1, f1, m2, m3, m4] },
        { name: fix, head: short(h0), isMain: false, ahead: 1, behind: 4, truncated: false,
          commits: [h0, m3, m4] },
      ],
    }

    const two = nameAt(1)
    const three = nameAt(2)
    return [
      {
        key: `/sample/${one}/.git`, name: one, isGit: true,
        worktrees: [
          { path: `/sample/${one}`, branch: 'main', head: short(m0), isMain: true },
          { path: `/sample/${one}-${feat.slice(5)}`, branch: feat, head: short(g0), isMain: false },
          { path: `/sample/${one}-${fix.slice(4)}`, branch: fix, head: short(h0), isMain: false },
        ],
        gitGraph: graph,
      },
      {
        key: `/sample/${two}/.git`, name: two, isGit: true,
        worktrees: [
          { path: `/sample/${two}`, branch: 'main', head: sha().slice(0, 7), isMain: true },
          { path: `/sample/${two}-work`, branch: pick(SAMPLE_FEATURES), head: sha().slice(0, 7), isMain: false },
        ],
      },
      {
        key: `/sample/${three}`, name: three, isGit: false,
        worktrees: [{ path: `/sample/${three}`, branch: null, head: null, isMain: true }],
        gitGraph: null,
      },
    ]
  }

  return {
    REGISTRY, componentById, mergeParams,
    CALM, CALM_DEFAULT, calmScale,
    DT_MAX, stepCritical, settleBound,
    cardSlots, floatAmp, floatAt,
    tiltFor, slewTilt,
    flyOutPath, siblingExit, fanFraction, fanIndex, flyOutReach, flyOutLayout, agentKeys,
    graphLayout, graphFor, withGraphs,
    GRAPH_GEOM, GRAPH_RAIL_DX, GRAPH_SENTENCE, BRANCH_NOTE, graphScene,
    sampleSessions, sampleProjects,
  }
})()
