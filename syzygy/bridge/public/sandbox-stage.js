/* Syzygy -- the sandbox tab's stage: DOM panels and line geometry under one
   camera.

   An ES module, because it imports three and motion. Its top-level bindings
   are invisible to the classic scripts beside it, so the surface is assigned
   to window.MCGS explicitly at the bottom; MCGM and MCX are classic-script
   globals and are read bare. sandbox.js imports this file the first time its
   view is shown.

   The stage belongs to whichever view is showing it. A view that hosts it
   calls boot with its own line canvas every time it is shown: boot on the
   canvas the stage already draws to only resumes the loop, and boot on a
   different canvas moves the one line renderer there. Mounts in a view that
   is not showing stay mounted and draw nothing.

   Every gallery cell that mounts a component gets two layers and one camera.
   The component's DOM is placed in 3D by a CSS3DRenderer whose element lives
   inside the cell's own mount node, so a click on a panel bubbles to the cell
   and the cell clips its own stage. Behind the whole grid, ONE WebGLRenderer
   draws every cell's line scene into that cell's rectangle with a viewport
   and a scissor -- one context for the whole gallery, because browsers cap
   how many live at once and the presence panel already holds one. Each cell
   owns a PerspectiveCamera placed so one world unit is one CSS pixel at
   z = 0, and both of its layers render with that same camera object, so a
   line and a panel agree about where space is.

   World coordinates are y-up with the origin at the cell's centre. MCGM's
   layouts are y-down, the page's way; a body holds layout coordinates and the
   stage negates y when it writes a body onto an object.

   Without WebGL the line canvas stays hidden, `ready` stays false, and the
   DOM layer still renders every frame: this view degrades rather than going
   blank. A lost context hides the canvas and keeps the DOM layer running; a
   restored one boots again. */
import {
  Scene, PerspectiveCamera, WebGLRenderer,
  BufferGeometry, BufferAttribute, LineSegments, LineBasicMaterial,
  CSS3DRenderer, CSS3DObject,
} from 'three'
import { animate } from 'motion'

// ------------------------------------------------------------------ constants
const FOV_DEG = 40
const HALF_FOV_TAN = Math.tan((FOV_DEG * Math.PI) / 180 / 2)
// The float clock's longest step. Separate from the integrator's own clamp:
// drift is a function of time, not of state, so a long frame only has to be
// kept from jumping the phase, not from destabilising anything.
const CLOCK_DT_MAX = 0.1
// How fast a body's float fades in once it comes to rest, and back out when
// it is sent somewhere, per second. Float never fights a settle in progress.
const FLOAT_EASE = 4
const REST_PX = 0.5
const REST_SPEED = 4
const DEFAULT_OMEGA = 12
// Below this many pixels the float is not worth a floatAt call.
const AMP_EPSILON = 0.01

/** The only literal colours in the stage: what a line is drawn in before the
 *  pane has published its theme. Everything else reads col() at draw time. */
const FALLBACK = Object.freeze({
  edge: '#1d3a3f',
  accent: '#35d6c6',
  accentDeep: '#1b6f68',
  grey: '#5b6b6e',
})

/** A theme colour by its window.MCT name, read at the moment it is asked for.
 *  The pane rebuilds MCT in place on a theme change, so a caller that asks
 *  every frame follows the change with no event. */
const col = (name, fallback) => window.MCT?.[name] || fallback

const finite = (v) => typeof v === 'number' && Number.isFinite(v)

// ---------------------------------------------------------------------- state
let renderer = null
let glCanvas = null
let glOn = false
// The renderer's current size in CSS pixels and its pixel ratio, compared
// every frame so setSize runs only when one of them actually changed.
let glW = 0
let glH = 0
let glPr = 0
// The scroll offsets last written onto the canvas, so it stays over the
// visible part of a scrolling wrap without a style write every frame.
let canvasLeft = -1
let canvasTop = -1
const wired = new WeakSet()

const mounts = new Map()   // mount node -> mount
const list = []            // the same mounts in mount order, for the frame loop

let running = false
// Set by the first boot, so a later boot on the same canvas can tell it has
// nothing to build.
let everBooted = false
let rafId = 0
let lastTs = -1
let clock = 0

const calm = { settle: 1, float: 1 }
// The float scale actually applied, eased toward calm.float so a change of
// dial winds drift up or down instead of snapping every panel sideways.
let floatNow = 0
let flyOut = 'slide'
let flyOpen = null
const graph = { input: null, level: 'projects', focus: null }

// ---------------------------------------------------------------------- bodies
/** A point that settles and floats. `tx, ty` is where it is going; `x, vx,
 *  y, vy` is its integrated state; `px, py` is where it is drawn this frame,
 *  float included. All in layout coordinates: CSS pixels from the cell's
 *  centre, y down. `amp` is the float amplitude in pixels before the calm
 *  dial scales it. When `object` is set, the stage writes px and -py onto
 *  its position every frame -- x and y only, never z. */
class Body {
  constructor(seed, o) {
    const x = finite(o.x) ? o.x : 0
    const y = finite(o.y) ? o.y : 0
    this.seed = String(seed)
    this.omega = finite(o.omega) && o.omega > 0 ? o.omega : DEFAULT_OMEGA
    this.amp = finite(o.amp) && o.amp > 0 ? o.amp : 0
    this.object = o.object || null
    this.tx = x
    this.ty = y
    this.x = x
    this.y = y
    this.vx = 0
    this.vy = 0
    this.px = x
    this.py = y
    this.rest = 0
  }

  /** Retarget. Changes where the body is going and nothing else. */
  to(x, y) {
    if (finite(x)) this.tx = x
    if (finite(y)) this.ty = y
  }

  /** Put the body at a point outright, at rest, with no travel. */
  snap(x, y) {
    this.to(x, y)
    this.x = this.tx
    this.y = this.ty
    this.vx = 0
    this.vy = 0
  }
}

/** One frame of one body. With settle off the body is simply at its target;
 *  otherwise each axis takes one critically damped step. The float weight
 *  eases toward 1 at rest and toward 0 while travelling. */
const stepBody = (b, t, dt, h) => {
  if (calm.settle > 0) {
    let s = MCGM.stepCritical(b.x, b.vx, b.tx, b.omega, dt)
    b.x = s.x
    b.vx = s.v
    s = MCGM.stepCritical(b.y, b.vy, b.ty, b.omega, dt)
    b.y = s.x
    b.vy = s.v
  } else {
    b.x = b.tx
    b.y = b.ty
    b.vx = 0
    b.vy = 0
  }
  const still = Math.abs(b.tx - b.x) < REST_PX && Math.abs(b.ty - b.y) < REST_PX &&
    Math.abs(b.vx) + Math.abs(b.vy) < REST_SPEED
  b.rest += ((still ? 1 : 0) - b.rest) * Math.min(1, FLOAT_EASE * h)
  const amp = b.amp * floatNow * b.rest
  if (amp > AMP_EPSILON) {
    const f = MCGM.floatAt(b.seed, t, amp)
    b.px = b.x + f.dx
    b.py = b.y + f.dy
  } else {
    b.px = b.x
    b.py = b.y
  }
  const o = b.object
  if (o) {
    o.position.x = b.px
    o.position.y = -b.py
  }
}

// ------------------------------------------------------------------ the mounts
/** Every line material and geometry a mount holds: the ones it registered,
 *  plus anything found on an object in its line scene, so a component that
 *  adds a line without registering it is still released. */
const glObjectsOf = (m, into) => {
  for (const o of m.gl) into.add(o)
  m.lines.traverse((obj) => {
    if (obj.geometry) into.add(obj.geometry)
    const mat = obj.material
    if (Array.isArray(mat)) for (const x of mat) into.add(x)
    else if (mat) into.add(mat)
  })
}

const report = (m, e) => {
  if (m.faulted) return
  m.faulted = true
  console.error(`sandbox stage: ${m.id} failed`, e)
}

const fit = (m, w, h) => {
  const ctx = m.ctx
  if (w === ctx.w && h === ctx.h) return
  ctx.w = w
  ctx.h = h
  const dist = h / 2 / HALF_FOV_TAN
  ctx.dist = dist
  m.camera.aspect = w / h
  m.camera.near = dist / 100
  m.camera.far = dist * 100
  m.camera.position.set(0, 0, dist)
  m.camera.updateProjectionMatrix()
  m.css.setSize(w, h)
}

const createMount = (node, id, comp) => {
  const camera = new PerspectiveCamera(FOV_DEG, 1, 1, 10000)
  const lines = new Scene()
  const dom = new Scene()
  const css = new CSS3DRenderer()
  css.domElement.classList.add('gcss')
  node.appendChild(css.domElement)

  const m = { node, id, comp, camera, lines, dom, css, gl: new Set(), paints: [], faulted: false, ctx: null }

  const track = (obj) => {
    if (obj && typeof obj.dispose === 'function') m.gl.add(obj)
    return obj
  }
  const releaseOne = (obj) => {
    if (!obj) return
    m.gl.delete(obj)
    for (let i = m.paints.length - 1; i >= 0; i--) if (m.paints[i].material === obj) m.paints.splice(i, 1)
    if (typeof obj.dispose === 'function') obj.dispose()
  }

  const ctx = {
    id,
    node,
    camera,
    lines,
    dom,
    w: 0,
    h: 0,
    dist: 0,
    params: {},
    data: null,
    state: {},
    bodies: [],
    col,
    FALLBACK,
    get calm() { return calm },
    get flyOut() { return flyOut },
    get flyOpen() { return flyOpen },
    get graph() { return graph },
    get glReady() { return glOn },

    /** A new body, stepped by the stage every frame this cell is drawn. */
    body: (seed, opts) => {
      const b = new Body(seed, opts || {})
      ctx.bodies.push(b)
      return b
    },
    dropBody: (b) => {
      const i = ctx.bodies.indexOf(b)
      if (i >= 0) ctx.bodies.splice(i, 1)
    },

    /** Wraps a DOM element as a panel in this cell's CSS3D scene. */
    panel: (element) => {
      const o = new CSS3DObject(element)
      dom.add(o)
      return o
    },

    /** Registers a geometry or material for disposal with this mount. */
    track,

    /** Recolours `material` from col(name, fallback) before every draw. */
    paint: (material, name, fallback) => {
      m.paints.push({ material, name, fallback, last: '' })
      return material
    },

    /** A LineSegments in this cell's line scene over `positions` (three
     *  floats per endpoint, world coordinates), coloured from a theme name
     *  every frame. The array is used in place, not copied: write into it
     *  and call touch(). */
    lineSegments: (positions, name, fallback) => {
      const geometry = track(new BufferGeometry())
      geometry.setAttribute('position', new BufferAttribute(positions, 3))
      const material = track(new LineBasicMaterial({ color: col(name, fallback) }))
      ctx.paint(material, name, fallback)
      const seg = new LineSegments(geometry, material)
      lines.add(seg)
      return seg
    },

    /** After writing into a line object's positions: uploads them again and
     *  refits its bounds, so a resized shape is not culled by a stale one. */
    touch: (obj) => {
      const g = obj?.geometry
      if (!g) return
      const a = g.getAttribute('position')
      if (a) a.needsUpdate = true
      if (g.boundingSphere) g.computeBoundingSphere()
      if (g.boundingBox) g.computeBoundingBox()
    },

    /** Removes a line object from its scene and disposes its geometry and
     *  material, or disposes one geometry or material directly. */
    release: (obj) => {
      if (!obj) return
      if (obj.isObject3D) {
        obj.removeFromParent()
        const found = new Set()
        obj.traverse((o) => {
          if (o.geometry) found.add(o.geometry)
          const mat = o.material
          if (Array.isArray(mat)) for (const x of mat) found.add(x)
          else if (mat) found.add(mat)
        })
        for (const x of found) releaseOne(x)
        return
      }
      releaseOne(obj)
    },
  }
  m.ctx = ctx
  return m
}

const unmountOne = (m) => {
  try { m.comp.unmount(m.ctx) } catch (e) { report(m, e) }
  const all = new Set()
  glObjectsOf(m, all)
  for (const o of all) o.dispose()
  m.gl.clear()
  m.paints.length = 0
  m.ctx.bodies.length = 0
  m.lines.clear()
  m.dom.clear()
  m.css.domElement.remove()
  mounts.delete(m.node)
  const i = list.indexOf(m)
  if (i >= 0) list.splice(i, 1)
}

const forward = (hook, a, b, c) => {
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    const fn = m.comp[hook]
    if (typeof fn !== 'function') continue
    try { fn(m.ctx, a, b, c) } catch (e) { report(m, e) }
  }
}

// ------------------------------------------------------------------- the GL half
/** Disposes every line material and geometry every mount holds, then the
 *  renderer. The three objects themselves stay in their scenes: the next
 *  renderer uploads them again the first time it draws them. On a lost
 *  context every delete this issues is a no-op, so running it from the loss
 *  handler detaches the dead renderer from those objects without a GL error. */
const teardownGL = () => {
  const all = new Set()
  for (let i = 0; i < list.length; i++) glObjectsOf(list[i], all)
  for (const o of all) o.dispose()
  if (renderer) {
    try { renderer.dispose() } catch (e) { /* a renderer on a dead context */ }
  }
  renderer = null
  glOn = false
  glW = 0
  glH = 0
  glPr = 0
  MCGS.ready = false
}

/** Wired once per canvas. preventDefault on loss is what lets the browser
 *  restore the context at all; without it this would be a permanent
 *  latch-off by omission. */
const wire = (canvas) => {
  if (wired.has(canvas)) return
  wired.add(canvas)
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    if (canvas !== glCanvas) return
    teardownGL()
    canvas.hidden = true
  })
  // A canvas the stage has moved off ignores both events; booting back onto
  // it builds a renderer on whatever context it has by then.
  canvas.addEventListener('webglcontextrestored', () => {
    if (canvas !== glCanvas) return
    hostOn(canvas)
  })
}

/** Puts the line renderer on `canvas`: disposes the renderer and every line
 *  material and geometry every mount holds, then builds a new renderer
 *  there. Mounts, their scenes and their CSS3D renderers stay; the new
 *  renderer uploads each mount's line objects again the first time it draws
 *  them. There is never more than one renderer: the old one is gone before
 *  the new one is made. Leaves the frame loop paused or running as it was. */
const hostOn = (canvas) => {
  teardownGL()
  if (canvas !== glCanvas) {
    // The canvas left behind still holds the last frame drawn on it. Hidden,
    // a view that shows it without booting shows no lines rather than stale
    // ones.
    if (glCanvas) glCanvas.hidden = true
    canvasLeft = -1
    canvasTop = -1
  }
  glCanvas = canvas
  if (canvas) {
    wire(canvas)
    try {
      renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true })
      renderer.autoClear = false
      glOn = true
    } catch (e) {
      renderer = null
      glOn = false
    }
    canvas.hidden = !glOn
  }
  MCGS.ready = glOn
}

/** Keeps an absolutely positioned canvas over the visible part of the
 *  scrolling element that holds it. A no-op for a parent that never scrolls. */
const followScroll = () => {
  const p = glCanvas.parentElement
  if (!p) return
  const left = p.scrollLeft
  const top = p.scrollTop
  if (left !== canvasLeft) {
    glCanvas.style.left = left + 'px'
    canvasLeft = left
  }
  if (top !== canvasTop) {
    glCanvas.style.top = top + 'px'
    canvasTop = top
  }
}

const sizeRenderer = (w, h) => {
  const cw = Math.round(w)
  const ch = Math.round(h)
  const pr = window.devicePixelRatio || 1
  if (cw === glW && ch === glH && pr === glPr) return
  glW = cw
  glH = ch
  glPr = pr
  renderer.setPixelRatio(pr)
  renderer.setSize(cw, ch, false)
}

// ------------------------------------------------------------------- the frame
const draw = (t, dt, h) => {
  const gl = glOn && renderer !== null && glCanvas !== null
  let cl = 0
  let ct = 0
  let cw = window.innerWidth
  let ch = window.innerHeight
  if (gl) {
    followScroll()
    const c = glCanvas.getBoundingClientRect()
    cl = c.left
    ct = c.top
    cw = c.width
    ch = c.height
    sizeRenderer(cw, ch)
    renderer.setScissorTest(false)
    renderer.clear()
  } else {
    const p = glCanvas?.parentElement
    if (p) {
      const c = p.getBoundingClientRect()
      cl = c.left
      ct = c.top
      cw = c.width
      ch = c.height
    }
  }
  const glPass = gl && glW > 0 && glH > 0

  for (let i = list.length - 1; i >= 0; i--) {
    if (!list[i].node.isConnected) unmountOne(list[i])
  }

  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    const r = m.node.getBoundingClientRect()
    // A mount inside a view that is not showing measures a zero rectangle
    // and is skipped here, so the mounts a hidden view keeps cost one
    // measurement a frame and draw nothing, in either layer.
    if (r.width < 1 || r.height < 1) continue
    if (r.right <= cl || r.left >= cl + cw || r.bottom <= ct || r.top >= ct + ch) continue
    try {
      fit(m, r.width, r.height)
      const bodies = m.ctx.bodies
      for (let k = 0; k < bodies.length; k++) stepBody(bodies[k], t, dt, h)
      m.comp.frame(m.ctx, t, dt)

      if (glPass) {
        const paints = m.paints
        for (let k = 0; k < paints.length; k++) {
          const p = paints[k]
          const c = col(p.name, p.fallback)
          if (c !== p.last) {
            p.material.color.set(c)
            p.last = c
          }
        }
        // WebGL's origin is the canvas's bottom-left corner.
        const x = r.left - cl
        const y = glH - (r.top - ct) - r.height
        renderer.setViewport(x, y, r.width, r.height)
        const sx = Math.max(0, x)
        const sy = Math.max(0, y)
        const sw = Math.min(glW, x + r.width) - sx
        const sh = Math.min(glH, y + r.height) - sy
        if (sw > 0 && sh > 0) {
          renderer.setScissor(sx, sy, sw, sh)
          renderer.setScissorTest(true)
          renderer.render(m.lines, m.camera)
        }
      }
      m.css.render(m.dom, m.camera)
    } catch (e) {
      report(m, e)
    }
  }
}

const tick = (ts) => {
  rafId = 0
  if (!running) return
  rafId = requestAnimationFrame(tick)
  const dt = lastTs < 0 ? 0 : Math.max(0, (ts - lastTs) / 1000)
  lastTs = ts
  const h = Math.min(dt, MCGM.DT_MAX)
  clock += Math.min(dt, CLOCK_DT_MAX)
  floatNow += (calm.float - floatNow) * Math.min(1, FLOAT_EASE * h)
  draw(clock, dt, h)
}

// -------------------------------------------------------------- the components
/* The table is keyed by registry id. Each entry is
     mount(ctx)                  build panels, line objects and bodies
     update(ctx, params, data)   called once right after mount, then every
                                 time the same node is mounted again with
                                 the same id
     frame(ctx, t, dt)           once per drawn frame, after the cell's
                                 bodies have stepped and before either layer
                                 renders; t is the stage clock in seconds
     unmount(ctx)                release anything the stage does not own
   and may add openFlyOut(ctx, id), closeFlyOut(ctx),
   setGraph(ctx, input, level, focus) and graphBack(ctx), which the MCGS
   calls of the same names forward to mounts. On unmount the stage disposes
   every line material and geometry the cell holds and removes every panel
   with the cell's CSS3D element. A component draws in whichever layer it
   likes: DOM, lines or both.

   ctx carries the cell's camera, its line scene (`lines`) and CSS3D scene
   (`dom`), the mount node's size in CSS pixels (`w`, `h`) and the camera's
   distance (`dist`), the latest `params` and `data`, a `state` object the
   stage never reads, its `bodies`, the live `calm`, `flyOut`, `flyOpen`,
   `graph` and `glReady`, and the helpers body, dropBody, panel, track,
   paint, lineSegments, touch, release and col. */

// ------------------------------------------------------------ the session card
/* One live session is one panel. The panel's own element carries the whole
   3D transform -- its position from a body, its tilt from the rotations
   written here -- and the line frame is an SVG inside that element, so the
   frame tilts with the panel instead of sliding against it. The frame's
   strokes are CSS variables, which the document re-resolves by itself when
   the theme changes.

   Nothing here ever writes a scale. A data change rewrites text and
   attributes in place; a change to which sessions exist retargets bodies,
   and a body only travels. */

const CARD_W = 214
const CARD_H = 128
// How far the frame reaches past the panel's border on every side, corner
// ticks included. The drawn card is the panel plus this margin all round.
const FRAME_OUT = 12
const DRAWN_W = CARD_W + 2 * FRAME_OUT
const DRAWN_H = CARD_H + 2 * FRAME_OUT
// The drawn card's half-diagonal, which bounds it at any rotation in its own
// plane. The no-contact bound is built on it.
const CARD_R = Math.hypot(DRAWN_W, DRAWN_H) / 2
// The layout's centre-to-centre pitch: two drawn cards, plus the room that
// float and tilt share between them. This is the gallery's own default; a
// mount can ask for a tighter (or looser) clearance via `params.cardGap`,
// read in sessionCard's own update below, without changing this constant or
// the gallery's own look.
const CARD_SEP = 2 * CARD_R + 36
const CARD_OMEGA = 12
// Clear space kept between the outermost card and the edge of its cell.
const FIT_PAD = 16
const TILT_DEFAULT = 8
const FOLLOW_DEFAULT = 50
const TILT_SLEW = 3
const TILT_RAMP_S = 0.12
const TILT_REST = 0.01
const TILT_REST_SPEED = 0.5
// Once the pointer is off the panel's element, the card stays hot until the
// pointer is this far outside its un-tilted rectangle. A tilted panel's hit
// area shrinks away from the pointer, so without the margin a pointer
// resting on an edge would drop the hover and pick it straight back up.
const HOVER_HYST = 6
const DEG = Math.PI / 180
const NO_TILT = Object.freeze({ rx: 0, ry: 0 })

// A subagent's card is a session card scaled down by this fraction on each
// side, with the same frame reach, so it reads as one of the same family.
const KID_FRACTION = 0.6
const KID_W = Math.round(CARD_W * KID_FRACTION)
const KID_H = Math.round(CARD_H * KID_FRACTION)
// The drawn sizes, frame included, that the fly-out's geometry clears.
const CARD_BOX = Object.freeze({ w: DRAWN_W, h: DRAWN_H })
const KID_BOX = Object.freeze({ w: KID_W + 2 * FRAME_OUT, h: KID_H + 2 * FRAME_OUT })
// How fast a child's progress and its place in the fan settle.
const KID_OMEGA = 10
// A leaving child is removed once its progress is this near zero and still,
// and its fade has had time to finish.
const KID_REST = 0.002
const KID_REST_SPEED = 0.02
const KID_FADE_IN_S = 0.35
const KID_FADE_OUT_S = 0.25
// The link buffer's first capacity, in segments; it doubles when outgrown.
const LINK_CAP = 8
// How fast the camera settles when the layout's reach changes.
const CAMERA_OMEGA = 10
const CAMERA_REST = 0.05
const CAMERA_REST_SPEED = 0.5

/** A line frame for a panel whose drawn size, frame included, is w by h: a
 *  rectangle about 7px outside the panel's border, and two corner ticks. */
const frameSvg = (w, h) =>
  `<svg class="gframe" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false">` +
  `<path d="M 5.5 5.5 H ${w - 5.5} V ${h - 5.5} H 5.5 Z"/>` +
  '<path d="M 0.5 13 V 0.5 H 13"/>' +
  `<path d="M ${w - 0.5} ${h - 13} V ${h - 0.5} H ${w - 13}"/>` +
  '</svg>'

// Static markup only: every live value is written with textContent.
const CARD_HTML =
  '<div class="gchead"><span class="gcdot"></span><span class="gcname"></span></div>' +
  '<div class="gcmeta"><span class="gcmodel"></span><span class="gcpct"></span></div>' +
  '<div class="gcbar"><i></i></div>' +
  '<div class="gcline gcbranch"></div>' +
  '<div class="gcline gcpeer"></div>' +
  '<div class="gcline gcstatus"></div>' +
  '<div class="gcfoot"><button type="button" data-g-hit class="gagents"></button><span class="gcstat"></span></div>' +
  frameSvg(DRAWN_W, DRAWN_H)

const KID_HTML =
  '<div class="gchead"><span class="gcdot"></span><span class="gcname"></span></div>' +
  '<div class="gkdesc"></div>' +
  '<div class="gcline gkstatus"></div>' +
  frameSvg(KID_BOX.w, KID_BOX.h)

/** The largest float scale any calm setting applies. A card's amplitude is
 *  the no-contact bound divided by it, so the widest setting spends exactly
 *  that bound and every other setting stays inside it. */
let floatCeilingMemo = 0
const floatCeiling = () => {
  if (!floatCeilingMemo) {
    floatCeilingMemo = Math.max(1, ...MCGM.CALM.map((n) => MCGM.calmScale(n, false).float))
  }
  return floatCeilingMemo
}

const compactCount = (n) => {
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) { const k = n / 1e3; return (k < 100 ? k.toFixed(1) : Math.round(k)) + 'k' }
  const m = n / 1e6
  return (m < 100 ? m.toFixed(2) : Math.round(m)) + 'M'
}
const dollars = (v) => (v >= 100 ? '$' + v.toFixed(0) : v >= 1 ? '$' + v.toFixed(2) : '$' + v.toFixed(3))

const pointerFrom = (s, e) => {
  s.pointer.x = e.clientX
  s.pointer.y = e.clientY
}

/** The hot card stops being hot and springs back to flat. */
const releaseHover = (s) => {
  const c = s.hot
  if (!c) return
  s.hot = null
  c.inside = false
  c.el.classList.remove('hot')
  c.vrx = 0
  c.vry = 0
  c.mode = 'leave'
}

const enterHover = (s, c, e) => {
  if (e.pointerType === 'touch') return
  // A card parked at the edge while another card's fly-out is open takes the
  // pointer but never tilts.
  if (c.parked) return
  pointerFrom(s, e)
  c.inside = true
  if (s.hot === c) return
  releaseHover(s)
  s.hot = c
  c.el.classList.add('hot')
  c.rampT = 0
  // The pointer-driven target starts again from flat. Whatever tilt is still
  // on screen becomes an offset on top of that target, and the enter spring
  // winds the offset out, so the card never jumps and never trails the hand.
  c.tilt = NO_TILT
  c.erx = c.rx
  c.ery = c.ry
  c.verx = c.vrx
  c.very = c.vry
  c.mode = 'enter'
}

const NO_AGENTS = Object.freeze([])

/** Builds one card's DOM, panel and body. Runs once per session id; a data
 *  change never comes back here. */
const makeCard = (ctx, s, id) => {
  const el = document.createElement('div')
  el.classList.add('gcard')
  el.innerHTML = CARD_HTML
  const obj = ctx.panel(el)
  // The panel wrapper turns selection off on its element. A card's text is
  // meant to be selectable.
  el.style.userSelect = 'text'
  el.style.webkitUserSelect = 'text'
  const c = {
    id,
    el,
    obj,
    body: ctx.body(`${ctx.id}:${id}`, { amp: s.amp, omega: CARD_OMEGA, object: obj }),
    name: el.querySelector('.gcname'),
    model: el.querySelector('.gcmodel'),
    pct: el.querySelector('.gcpct'),
    bar: el.querySelector('.gcbar i'),
    branch: el.querySelector('.gcbranch'),
    peerFor: el.querySelector('.gcpeer'),
    status: el.querySelector('.gcstatus'),
    badge: el.querySelector('.gagents'),
    stat: el.querySelector('.gcstat'),
    barWidth: '',
    placed: false,
    // Parked at the edge while another card's fly-out is open.
    parked: false,
    // This session's subagents as last written, and the child cards popped
    // out of this card, by agent key: open ones while its fly-out is open,
    // closing ones until they have gone.
    agents: NO_AGENTS,
    kids: new Map(),
    // Tilt, in degrees, in tiltFor's convention. `tilt` is the slewed
    // target; rx/ry are what is drawn; erx/ery is the offset the enter
    // spring winds out.
    tilt: NO_TILT,
    rx: 0, vrx: 0, ry: 0, vry: 0,
    erx: 0, verx: 0, ery: 0, very: 0,
    mode: 'rest',
    rampT: 0,
    inside: false,
    fade: null,
  }
  c.badge.setAttribute('aria-pressed', 'false')
  c.badge.addEventListener('click', (e) => {
    // A shift- or option-click is the cell's, not the badge's: it does nothing
    // here and bubbles on to the cell's settings and mark gestures. A plain
    // click belongs to the card, and the cell never sees it. It toggles this
    // card's fly-out: a parked card's badge does nothing, and a card with no
    // subagents has nothing to open.
    if (e.shiftKey || e.altKey) return
    e.stopPropagation()
    if (c.parked) return
    if (s.openId === id) window.MCGS?.closeFlyOut?.()
    else if (c.agents.length) window.MCGS?.openFlyOut?.(id)
  })
  el.addEventListener('pointerenter', (e) => enterHover(s, c, e))
  el.addEventListener('pointermove', (e) => { if (s.hot === c) pointerFrom(s, e) })
  el.addEventListener('pointerleave', (e) => {
    if (s.hot !== c) return
    pointerFrom(s, e)
    c.inside = false
  })
  c.fade = MCX.reducedMotion() ? null : animate(el, { opacity: [0, 1] }, { duration: 0.35, ease: 'easeOut' })
  return c
}

/* ------------------------------------------------------------- the fly-out
   A card's fly-out is its subagents as child cards floating beside it, each
   joined to it by a line in the cell's line layer. A child has a progress
   `t` (0 closed, 1 open) and a place across the fan `u` (0 at one end, 1 at
   the other), both stepped by the integrator every frame. Its position and
   scale are flyOutPath's at that progress, measured from where the parent is
   drawn this frame, so a child rides along with its parent's float and
   travel, and never overlaps the parent at any progress. Motion animates a
   child's opacity and nothing else. */

/** An element's opacity now, so a new fade starts from wherever the last one
 *  was stopped. */
const opacityOf = (el) => {
  const v = Number.parseFloat(el.isConnected ? getComputedStyle(el).opacity : el.style.opacity)
  return finite(v) ? v : 0
}

/** Sends the opacity of `rec.el` toward `to`: faded by Motion over `inS`
 *  seconds when rising and `outS` when falling, or set outright under
 *  reduced motion. `rec.fadeEnd` is the stage-clock time the fade is over by.
 *  The stage clock never runs ahead of the page's, and the margin covers the
 *  part of a frame the clock has not yet counted. */
const fadeTo = (s, rec, to, inS, outS) => {
  rec.fade?.stop?.()
  rec.fade = null
  if (MCX.reducedMotion()) {
    rec.el.style.opacity = String(to)
    rec.fadeEnd = s.clock
    return
  }
  const d = to > 0 ? inS : outS
  rec.fade = animate(rec.el, { opacity: [opacityOf(rec.el), to] }, { duration: d, ease: to > 0 ? 'easeOut' : 'easeIn' })
  rec.fadeEnd = s.clock + d + CLOCK_DT_MAX
}

const fadeKid = (s, k, to) => fadeTo(s, k, to, KID_FADE_IN_S, KID_FADE_OUT_S)

/** One child card for one subagent: closed, at place `u` in the fan, fading
 *  in, in the variant the fly-out was opened with. */
const makeKid = (ctx, s, key, u) => {
  const el = document.createElement('div')
  el.classList.add('gcard', 'gkid')
  // Owns its own click: a plain click landing here must not fall through to
  // the cell's expand gesture the way a click on bare card background does.
  el.setAttribute('data-g-hit', '')
  el.innerHTML = KID_HTML
  // Transparent until the fade draws it, so the first frame never shows it
  // at full strength.
  el.style.opacity = '0'
  const obj = ctx.panel(el)
  el.style.userSelect = 'text'
  el.style.webkitUserSelect = 'text'
  const k = {
    key,
    el,
    obj,
    name: el.querySelector('.gcname'),
    desc: el.querySelector('.gkdesc'),
    status: el.querySelector('.gkstatus'),
    variant: s.variant,
    t: 0, vt: 0, goal: 1,
    u, vu: 0, uGoal: u,
    fade: null,
    fadeEnd: 0,
  }
  fadeKid(s, k, 1)
  return k
}

const dropKid = (k) => {
  k.fade?.stop?.()
  k.obj.removeFromParent()
}

/** A child heads back to closed and fades out; the frame removes it once
 *  both are done. */
const closeKid = (s, k) => {
  if (k.goal === 0) return
  k.goal = 0
  fadeKid(s, k, 0)
}

const writeKid = (k, a) => {
  MCX.setText(k.name, a.type ? String(a.type) : 'agent')
  MCX.setText(k.desc, a.description ? String(a.description) : '')
  MCX.setText(k.status, a.status ? String(a.status) : '')
  MCX.toggle(k.el, 'busy', a.status === 'running')
}

/** Brings an open card's children in line with its subagents: a child made
 *  for each subagent that has none, a closing child brought back when its
 *  subagent is back, a child closing for each subagent gone, and every open
 *  child sent to its place in the fan. A child that stays is never rebuilt. */
const syncKids = (ctx, s, c) => {
  const keys = MCGM.agentKeys(c.agents)
  const want = s.want
  want.clear()
  for (let j = 0; j < keys.length; j++) want.add(keys[j].key)
  for (const k of c.kids.values()) if (!want.has(k.key)) closeKid(s, k)
  for (let j = 0; j < keys.length; j++) {
    const u = MCGM.fanFraction(j, keys.length)
    let k = c.kids.get(keys[j].key)
    if (!k) {
      k = makeKid(ctx, s, keys[j].key, u)
      c.kids.set(k.key, k)
    } else if (k.goal === 0) {
      k.goal = 1
      fadeKid(s, k, 1)
    }
    k.uGoal = u
    writeKid(k, keys[j].agent)
  }
  if (c.kids.size) s.flying.add(c)
}

/** Every child of `c` starts closing. */
const closeKids = (s, c) => {
  for (const k of c.kids.values()) closeKid(s, k)
}

const dropCard = (ctx, s, c) => {
  if (s.hot === c) releaseHover(s)
  c.fade?.stop?.()
  for (const k of c.kids.values()) dropKid(k)
  c.kids.clear()
  s.flying.delete(c)
  ctx.dropBody(c.body)
  c.obj.removeFromParent()
}

/** A parked card lets go of the hover, so it winds back to flat, and its
 *  badge stops answering. */
const setParked = (s, c, on) => {
  if (c.parked === on) return
  c.parked = on
  if (on && s.hot === c) releaseHover(s)
  MCX.toggle(c.el, 'parked', on)
}

/** Rewrites what changed on one card, and nothing else. */
const writeCard = (c, x) => {
  const st = x.stats && typeof x.stats === 'object' ? x.stats : {}
  MCX.setText(c.name, x.name ? String(x.name) : String(x.id).slice(0, 8))
  MCX.setText(c.model, x.model ? String(x.model) : 'model ?')
  const used = Number(st.ctx)
  const limit = Number(st.ctxLimit)
  const pct = finite(used) && finite(limit) && limit > 0
    ? Math.max(0, Math.min(100, Math.round((100 * used) / limit)))
    : null
  MCX.setText(c.pct, pct === null ? '' : pct + '%')
  const width = (pct ?? 0) + '%'
  if (width !== c.barWidth) {
    c.bar.style.width = width
    c.barWidth = width
  }
  MCX.setText(c.branch, x.branch ? '⎇ ' + x.branch : '')
  // Empty text rather than hidden: this card has no show/hide pattern.
  MCX.setText(c.peerFor, typeof x.forPeer?.peer === 'string' ? 'for ' + x.forPeer.peer : '')
  MCX.setText(c.status, x.status ? String(x.status) : x.working ? 'working' : 'idle')
  c.agents = Array.isArray(x.agents) ? x.agents : NO_AGENTS
  const n = c.agents.length
  MCX.setText(c.badge, `${n} agent${n === 1 ? '' : 's'}`)
  const spend = Number(st.spend)
  const out = Number(st.outTok)
  let stat = finite(spend) ? dollars(spend) : ''
  if (finite(out) && out > 0) stat += (stat ? ' · ' : '') + compactCount(out) + ' out'
  MCX.setText(c.stat, stat)
  MCX.toggle(c.el, 'busy', !!x.working)
}

/** The camera distance at which the reach `extX` by `extY` fits this cell,
 *  never nearer than the distance where a world unit is one CSS pixel. */
const fitZ = (ctx, s) => {
  const aspect = ctx.h > 0 ? ctx.w / ctx.h : 1
  return Math.max(ctx.dist, s.extY / HALF_FOV_TAN, s.extX / (HALF_FOV_TAN * aspect))
}

/** Sends every card where the order and the fly-out put it, by
 *  flyOutLayout: to its slot while nothing is open; with a fly-out open, the
 *  open card to the centre and every other card to a place past the edge of
 *  the view the camera is settling to. A card seen for the first time is put
 *  there outright; every other card travels. Also measures how far the
 *  layout reaches, for the camera: the slots' reach, and while a fly-out is
 *  open the larger of that and the whole fly-out's around the centre, so
 *  opening one never brings the camera nearer. */
const layoutCards = (ctx, s) => {
  const slots = MCGM.cardSlots(s.order, { w: DRAWN_W, h: DRAWN_H, sep: s.cardSep })
  let mx = 0
  let my = 0
  for (let i = 0; i < slots.length; i++) {
    mx = Math.max(mx, Math.abs(slots[i].x))
    my = Math.max(my, Math.abs(slots[i].y))
  }
  // Every pixel a card can reach at rest: its slot, half the drawn card, the
  // widest drift the separation allows, and a pad.
  const slack = (s.cardSep - 2 * CARD_R) / 2
  s.extX = slots.length ? mx + DRAWN_W / 2 + slack + FIT_PAD : 0
  s.extY = slots.length ? my + DRAWN_H / 2 + slack + FIT_PAD : 0
  if (s.openId !== null) {
    const reach = MCGM.flyOutReach(CARD_BOX, KID_BOX)
    s.extX = Math.max(s.extX, reach.x + slack + FIT_PAD)
    s.extY = Math.max(s.extY, reach.y + slack + FIT_PAD)
  }
  const view = s.view
  view.h = 2 * fitZ(ctx, s) * HALF_FOV_TAN
  view.w = view.h * (ctx.h > 0 ? ctx.w / ctx.h : 1)
  s.layW = ctx.w
  s.layH = ctx.h
  const out = MCGM.flyOutLayout(s.order, s.openId, { w: DRAWN_W, h: DRAWN_H, sep: s.cardSep, viewport: view })
  s.list.length = 0
  for (let i = 0; i < out.length; i++) {
    const p = out[i]
    const c = s.cards.get(p.id)
    s.list.push(c)
    setParked(s, c, p.parked)
    if (c.placed) c.body.to(p.x, p.y)
    else {
      c.body.snap(p.x, p.y)
      c.placed = true
    }
  }
}

/** Settles a cell's camera toward the distance that fits the reach in
 *  `s.extX` and `s.extY`. A resize puts it there outright; a change of reach
 *  eases it there with the integrator, and with settle off it jumps. The
 *  panels keep their CSS size; only the view moves. Keeps its record on `s`
 *  (fitW, fitH, fitX, fitY, zGoal, zNow, zVel) and returns the distance drawn
 *  this frame. */
const easeCamera = (ctx, s, dt) => {
  const cam = ctx.camera
  const sized = s.fitW !== ctx.w || s.fitH !== ctx.h
  if (sized || s.fitX !== s.extX || s.fitY !== s.extY) {
    s.fitW = ctx.w
    s.fitH = ctx.h
    s.fitX = s.extX
    s.fitY = s.extY
    s.zGoal = fitZ(ctx, s)
  }
  if (sized || !finite(s.zNow) || !(ctx.calm.settle > 0)) {
    s.zNow = s.zGoal
    s.zVel = 0
  } else if (s.zNow !== s.zGoal) {
    const a = MCGM.stepCritical(s.zNow, s.zVel, s.zGoal, CAMERA_OMEGA, dt)
    s.zNow = a.x
    s.zVel = a.v
    if (Math.abs(s.zGoal - s.zNow) < CAMERA_REST && Math.abs(s.zVel) < CAMERA_REST_SPEED) {
      s.zNow = s.zGoal
      s.zVel = 0
    }
  }
  const z = s.zNow
  // The stage puts the camera back at its base distance on every resize, so
  // the distance is written whenever it differs, not only when it changes.
  if (cam.position.z !== z) cam.position.z = z
  if (cam.far < z * 10) {
    cam.far = z * 100
    cam.updateProjectionMatrix()
  }
  return z
}

/** Settles this cell's camera to the cards' reach -- a session arriving or
 *  leaving, a fly-out opening or closing -- by easeCamera. Then, whenever the
 *  distance or the max tilt changed, the float amplitude for the cards: `g`
 *  bounds how much larger a card tilted by maxTilt projects than it does
 *  flat, so the amplitude leaves room for the tilt, and no drift can bring
 *  two cards into contact on screen. */
const fitCards = (ctx, s, dt) => {
  const z = easeCamera(ctx, s, dt)
  if (s.camZ === z && s.fitTilt === s.maxTilt) return
  s.camZ = z
  s.fitTilt = s.maxTilt
  s.k = z > 0 ? ctx.dist / z : 1
  const lift = CARD_R * Math.sin(s.maxTilt * DEG)
  const g = z > lift ? z / (z - lift) : Infinity
  s.amp = MCGM.floatAmp(s.cardSep, CARD_R * g) / floatCeiling()
  for (let i = 0; i < s.list.length; i++) s.list[i].body.amp = s.amp
}

/* The tilt sign mapping. tiltFor answers in CSS terms, y down: rotateX(rx)
   and rotateY(ry) tip the side nearest the pointer away from the viewer.
   three is y up with z toward the camera, and the CSS3D layer draws its
   rotations as they are in world space.
     rotateX(rx) moves the panel's bottom edge (CSS y = +1) to depth sin(rx);
     rotation.x = a moves the bottom edge (world y = -1) to depth -sin(a);
     so rotation.x = -rx.
     rotateY(ry) moves the right edge (x = +1) to depth -sin(ry), and so does
     rotation.y = ry, so rotation.y = ry.
   A pointer on the lower right therefore gives rx < 0 and ry > 0, and the
   lower-right corner recedes. */
const writeTilt = (c) => {
  const x = -c.rx * DEG
  const y = c.ry * DEG
  if (c.obj.rotation.x !== x) c.obj.rotation.x = x
  if (c.obj.rotation.y !== y) c.obj.rotation.y = y
}

/** One frame of hover. The hot card's target is tiltFor against the card's
 *  un-tilted rectangle on screen, slewed by slewTilt with a ramp that
 *  restarts whenever the hot card changes. Between enter and leave the drawn
 *  tilt IS that target; the spring runs only while an entering card winds
 *  out the tilt it already had, and while a released card returns to flat. */
const hoverFrame = (ctx, s, dt) => {
  const h = Math.min(Math.max(dt, 0), MCGM.DT_MAX)
  const springs = ctx.calm.settle > 0
  const omega = s.follow
  const hot = s.hot
  if (hot) {
    const nr = ctx.node.getBoundingClientRect()
    const R = s.rect
    R.width = CARD_W * s.k
    R.height = CARD_H * s.k
    R.left = nr.left + ctx.w / 2 + hot.body.px * s.k - R.width / 2
    R.top = nr.top + ctx.h / 2 + hot.body.py * s.k - R.height / 2
    const p = s.pointer
    if (!hot.inside && (p.x < R.left - HOVER_HYST || p.x > R.left + R.width + HOVER_HYST ||
      p.y < R.top - HOVER_HYST || p.y > R.top + R.height + HOVER_HYST)) releaseHover(s)
  }
  for (let i = 0; i < s.list.length; i++) {
    const c = s.list[i]
    if (c.mode === 'rest') continue
    if (c === s.hot) {
      c.rampT = Math.min(TILT_RAMP_S, c.rampT + h)
      c.tilt = MCGM.slewTilt(c.tilt, MCGM.tiltFor(s.pointer, s.rect, s.maxTilt), TILT_SLEW, c.rampT / TILT_RAMP_S)
      if (c.mode === 'enter') {
        if (springs) {
          let a = MCGM.stepCritical(c.erx, c.verx, 0, omega, dt)
          c.erx = a.x
          c.verx = a.v
          a = MCGM.stepCritical(c.ery, c.very, 0, omega, dt)
          c.ery = a.x
          c.very = a.v
        }
        if (!springs || (Math.abs(c.erx) < TILT_REST && Math.abs(c.ery) < TILT_REST &&
          Math.abs(c.verx) + Math.abs(c.very) < TILT_REST_SPEED)) {
          c.erx = c.ery = c.verx = c.very = 0
          c.mode = 'follow'
        }
      }
      c.rx = c.tilt.rx + c.erx
      c.ry = c.tilt.ry + c.ery
    } else {
      c.tilt = MCGM.slewTilt(c.tilt, NO_TILT, TILT_SLEW, 1)
      if (springs) {
        let a = MCGM.stepCritical(c.rx, c.vrx, c.tilt.rx, omega, dt)
        c.rx = a.x
        c.vrx = a.v
        a = MCGM.stepCritical(c.ry, c.vry, c.tilt.ry, omega, dt)
        c.ry = a.x
        c.vry = a.v
      } else {
        c.rx = c.tilt.rx
        c.ry = c.tilt.ry
        c.vrx = c.vry = 0
      }
      if (c.tilt.rx === 0 && c.tilt.ry === 0 && Math.abs(c.rx) < TILT_REST && Math.abs(c.ry) < TILT_REST &&
        Math.abs(c.vrx) + Math.abs(c.vry) < TILT_REST_SPEED) {
        c.rx = c.ry = c.vrx = c.vry = 0
        c.mode = 'rest'
      }
    }
    writeTilt(c)
  }
}

/** The link buffer, grown to hold at least `need` segments. Its colour is the
 *  accent, read every frame. */
const growLinks = (ctx, s, need) => {
  let cap = Math.max(LINK_CAP, s.linkCap)
  while (cap < need) cap *= 2
  if (s.links && cap === s.linkCap) return
  if (s.links) ctx.release(s.links)
  s.links = ctx.lineSegments(new Float32Array(cap * 6), 'accent', FALLBACK.accent)
  // Its draw range changes every frame and its ends move with the cards, so
  // no bounding volume is ever allowed to cull it.
  s.links.frustumCulled = false
  s.links.geometry.setDrawRange(0, 0)
  s.linkCap = cap
  s.linksDrawn = 0
}

/** One frame of every fly-out still on screen. Each child is stepped, then
 *  placed and scaled by flyOutPath from where its parent is drawn this frame;
 *  a child that has finished closing is removed. Each child gets one link
 *  from the parent's centre toward its own, reaching it as its progress
 *  reaches 1. The links are in the line layer, behind both panels. */
const kidsFrame = (ctx, s, dt) => {
  const settle = ctx.calm.settle > 0
  let need = 0
  for (const c of s.flying) need += c.kids.size
  if (need > s.linkCap) growLinks(ctx, s, need)
  const pos = s.links.geometry.getAttribute('position').array
  const P = s.parentBox
  let seg = 0
  for (const c of s.flying) {
    P.x = c.body.px
    P.y = c.body.py
    const n = Math.max(1, c.kids.size)
    for (const k of c.kids.values()) {
      if (settle) {
        let a = MCGM.stepCritical(k.t, k.vt, k.goal, KID_OMEGA, dt)
        k.t = a.x
        k.vt = a.v
        a = MCGM.stepCritical(k.u, k.vu, k.uGoal, KID_OMEGA, dt)
        k.u = a.x
        k.vu = a.v
      } else {
        k.t = k.goal
        k.vt = 0
        k.u = k.uGoal
        k.vu = 0
      }
      if (k.goal === 0 && k.t < KID_REST && Math.abs(k.vt) < KID_REST_SPEED && s.clock >= k.fadeEnd) {
        dropKid(k)
        c.kids.delete(k.key)
        continue
      }
      const p = MCGM.flyOutPath(k.variant, P, KID_BOX, MCGM.fanIndex(k.u, n), n, k.t)
      k.obj.position.x = p.x
      k.obj.position.y = -p.y
      if (k.obj.scale.x !== p.scale) k.obj.scale.set(p.scale, p.scale, 1)
      const reach = Math.min(Math.max(k.t, 0), 1)
      if (reach > 0) {
        const i = seg * 6
        pos[i] = P.x
        pos[i + 1] = -P.y
        pos[i + 2] = 0
        pos[i + 3] = P.x + (p.x - P.x) * reach
        pos[i + 4] = -(P.y + (p.y - P.y) * reach)
        pos[i + 5] = 0
        seg++
      }
    }
    if (!c.kids.size) s.flying.delete(c)
  }
  if (seg > 0 || s.linksDrawn > 0) {
    s.links.geometry.setDrawRange(0, seg * 2)
    s.linksDrawn = seg
    if (seg > 0) ctx.touch(s.links)
  }
}

const sessionCard = {
  mount(ctx) {
    const s = ctx.state
    s.cards = new Map()   // session id -> card
    s.list = []           // the cards in layout order
    s.order = []          // their ids, sorted
    s.ids = []            // scratch, reused by every update
    s.byId = new Map()    // scratch, reused by every update
    s.maxTilt = TILT_DEFAULT
    s.follow = FOLLOW_DEFAULT
    s.cardSep = CARD_SEP
    s.amp = 0
    s.k = 1
    s.extX = 0
    s.extY = 0
    s.camZ = NaN
    s.zNow = NaN          // the camera's distance as drawn, easing toward zGoal
    s.zGoal = 0
    s.zVel = 0
    s.fitW = s.fitH = s.fitX = s.fitY = s.fitTilt = NaN
    s.view = { w: 0, h: 0 }   // the view parked cards were last placed outside of
    s.layW = s.layH = NaN     // the cell size that view was measured for
    s.hot = null
    s.pointer = { x: 0, y: 0 }
    s.rect = { left: 0, top: 0, width: 0, height: 0 }
    s.openId = null           // the session whose fly-out is open
    s.variant = 'slide'       // the variant it was opened with
    s.flying = new Set()      // cards with children, open or closing
    s.want = new Set()        // scratch, reused by syncKids
    s.parentBox = { x: 0, y: 0, w: CARD_BOX.w, h: CARD_BOX.h }
    s.clock = 0
    s.links = null
    s.linkCap = 0
    s.linksDrawn = 0
    growLinks(ctx, s, LINK_CAP)
    s.onNodeMove = (e) => { if (s.hot && !s.hot.inside) pointerFrom(s, e) }
    s.onNodeLeave = () => releaseHover(s)
    ctx.node.addEventListener('pointermove', s.onNodeMove)
    ctx.node.addEventListener('pointerleave', s.onNodeLeave)
  },

  /** Runs on every sessions frame, so it is a diff: cards are made only for
   *  ids not seen before and dropped only for ids gone, the layout is redone
   *  only when the set of ids changed, and each card rewrites only the text
   *  that changed. While a fly-out is open the layout holds it: a session
   *  that arrives parks with the other cards, one that leaves is dropped, the
   *  open card's children follow its subagents, and if the open card's own
   *  session leaves, the fly-out closes. */
  update(ctx, params, data) {
    const s = ctx.state
    const tilt = Number(params?.maxTilt)
    s.maxTilt = finite(tilt) && tilt >= 0 ? tilt : TILT_DEFAULT
    const follow = Number(params?.hoverFollow)
    s.follow = finite(follow) && follow > 0 ? follow : FOLLOW_DEFAULT
    // A mount-level override of the gallery's own clearance (see CARD_SEP,
    // above): the extra room beyond two cards' half-diagonals touching, not
    // the full pitch, so a caller never has to know CARD_R to ask for a
    // tighter or looser layout. Absent or invalid, the gallery's own default
    // stands. A change forces a relayout below even when the id set did not
    // move, since the pitch it lays out by just did.
    const gap = Number(params?.cardGap)
    const sep = finite(gap) && gap >= 0 ? 2 * CARD_R + gap : CARD_SEP
    const sepChanged = s.cardSep !== sep
    s.cardSep = sep

    const list = Array.isArray(data) ? data : []
    const ids = s.ids
    const byId = s.byId
    ids.length = 0
    byId.clear()
    for (let i = 0; i < list.length; i++) {
      const x = list[i]
      if (!x || typeof x !== 'object' || x.id == null) continue
      const id = String(x.id)
      if (byId.has(id)) continue
      byId.set(id, x)
      ids.push(id)
    }
    // By id, so a card keeps its slot however the relay orders its list.
    ids.sort()

    const lost = s.openId !== null && !byId.has(s.openId)
    if (lost) s.openId = null

    for (const [id, c] of s.cards) {
      if (!byId.has(id)) {
        dropCard(ctx, s, c)
        s.cards.delete(id)
      }
    }
    let moved = lost || ids.length !== s.order.length
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      if (!s.cards.has(id)) s.cards.set(id, makeCard(ctx, s, id))
      if (s.order[i] !== id) moved = true
    }
    if (moved) {
      s.order.length = 0
      for (let i = 0; i < ids.length; i++) s.order.push(ids[i])
    }
    if (moved || sepChanged) layoutCards(ctx, s)
    for (let i = 0; i < s.list.length; i++) writeCard(s.list[i], byId.get(s.list[i].id))
    if (s.openId !== null) syncKids(ctx, s, s.cards.get(s.openId))
    // The stage keeps its own record of what is open, which Escape reads; a
    // fly-out that closed because its session left clears that record too.
    if (lost) MCGS.closeFlyOut()
  },

  /** Opens `id`'s fly-out, closing any other first: the card settles to the
   *  centre, every other card parks past the edge of the view, and its
   *  subagents pop out in the variant set at this moment. An id with no card
   *  here opens nothing and closes the stage's record again. */
  openFlyOut(ctx, id) {
    const s = ctx.state
    const key = id == null ? null : String(id)
    const c = key === null ? null : s.cards.get(key)
    if (!c) {
      MCGS.closeFlyOut()
      return
    }
    if (s.openId === key) return
    const prev = s.openId === null ? null : s.cards.get(s.openId)
    if (prev) {
      closeKids(s, prev)
      prev.badge.setAttribute('aria-pressed', 'false')
    }
    s.openId = key
    s.variant = ctx.flyOut
    c.badge.setAttribute('aria-pressed', 'true')
    layoutCards(ctx, s)
    syncKids(ctx, s, c)
  },

  /** Closes the open fly-out: its children close, and every card travels
   *  back to its slot. */
  closeFlyOut(ctx) {
    const s = ctx.state
    if (s.openId === null) return
    const c = s.cards.get(s.openId)
    s.openId = null
    if (c) {
      closeKids(s, c)
      c.badge.setAttribute('aria-pressed', 'false')
    }
    layoutCards(ctx, s)
  },

  frame(ctx, t, dt) {
    const s = ctx.state
    s.clock = t
    // A resized cell shows a different view, so parked cards are placed
    // outside the new one.
    if (s.openId !== null && (s.layW !== ctx.w || s.layH !== ctx.h)) layoutCards(ctx, s)
    fitCards(ctx, s, dt)
    hoverFrame(ctx, s, dt)
    kidsFrame(ctx, s, dt)
  },

  unmount(ctx) {
    const s = ctx.state
    ctx.node.removeEventListener('pointermove', s.onNodeMove)
    ctx.node.removeEventListener('pointerleave', s.onNodeLeave)
    for (const c of s.cards.values()) {
      c.fade?.stop?.()
      for (const k of c.kids.values()) k.fade?.stop?.()
    }
    s.hot = null
  },
}

/* --------------------------------------------------------- the worktree graph
   Every project, then one project's branches, then one branch's commits:
   three levels of one scene, re-laid in place. MCGM.graphScene decides which
   labels a level holds, where each belongs and which are parked; this
   component moves bodies, fades labels and draws the lines between them.

   Each label is a panel riding a body, so a change of level settles the way
   every other move here does, and its float, x and y only, follows the calm
   dial. A label arriving spreads out from its parent's label and fades in; a
   label leaving travels back into its parent, fades out and is removed. A
   label the level keeps but does not focus -- a project or a branch other
   than the one opened -- is parked: it travels past the edge of the view at full opacity,
   the way a sibling card does for a fly-out. Motion animates label opacity
   and nothing else.

   The lines are rebuilt from the bodies every frame into two LineSegments,
   each coloured from the theme at draw time: branch links and the commit
   rail in one, merge edges and commit marks in the other. A line to a parked
   label is not drawn. When a level is left, the lines to the labels leaving
   are kept until those labels are gone, so they shrink with them.

   The level and its focus live in this mount's own state, so two mounts
   never share one. A plain click on a project or branch label drills into
   it, or back out of it when it is the one in focus; a shift- or
   option-click does nothing here and bubbles on to the cell. */

const GRAPH_OMEGA = 10
// How far a label drifts at rest before the calm dial scales it. The tightest
// space between two labels at rest is the 14px between commit rows, and two
// labels drifting toward each other at the widest dial close less than that.
const GRAPH_FLOAT = 2.5
// Clear space kept between the outermost label and the edge of its cell.
const GRAPH_PAD = 24
const GRAPH_FADE_IN_S = 0.3
const GRAPH_FADE_OUT_S = 0.22
// Each line buffer's first capacity, in segments; it doubles when outgrown.
const GRAPH_LINE_CAP = 32
// Half the width of the diamond that marks a commit on the rail.
const GRAPH_MARK = 3.5

const GRAPH_CLASS = Object.freeze({ project: 'gnproj', branch: 'gnbranch', commit: 'gncommit', note: 'gnnote' })
// Static markup only: every live value is written with textContent.
const GRAPH_HTML = Object.freeze({
  project: '<div class="gnname"></div><div class="gnsub"></div>',
  branch: '<div class="gnname"></div><div class="gnrow"><span class="gnsha"></span><span class="gncount"></span><span class="gnab"></span></div>',
  commit: '<span class="gnsha"></span><span class="gnsubj"></span>',
  note: '<span class="gnsubj"></span>',
})

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

const edgeKey = (e) => `${e.kind}:${e.from}>${e.to ?? ''}`

/** Moves this mount's graph to a level and focus, and re-lays the scene. */
const goGraph = (ctx, s, level, project, branch) => {
  s.level = level
  s.focus.project = project
  s.focus.branch = branch
  relayGraph(ctx, s)
}

/** A label's own click. Only a plain click, on a label that is not parked,
 *  and never the click that ends a text selection made inside the label. A
 *  project label drills into its branches, or back out to every project
 *  when it is the one already open; a branch label drills into its commits,
 *  or back out to the branches when it is the one already open. */
const onNodeClick = (ctx, s, n, e) => {
  if (e.shiftKey || e.altKey) return
  e.stopPropagation()
  if (n.phase !== 'shown') return
  const sel = typeof window.getSelection === 'function' ? window.getSelection() : null
  if (sel && !sel.isCollapsed && sel.anchorNode && n.el.contains?.(sel.anchorNode)) return
  if (n.kind === 'project') {
    if (s.level === 'worktrees' && s.focus.project === n.key) goGraph(ctx, s, 'projects', null, null)
    else goGraph(ctx, s, 'worktrees', n.key, null)
  } else if (n.kind === 'branch') {
    if (s.level === 'commits' && s.focus.branch === n.key) goGraph(ctx, s, 'worktrees', s.focus.project, null)
    else goGraph(ctx, s, 'commits', s.focus.project, n.key)
  }
}

/** Builds one label's DOM, panel and body. Runs once per scene id while the
 *  label lives; a data change or a change of level never comes back here. */
const makeNode = (ctx, s, sn) => {
  const el = document.createElement('div')
  el.classList.add('gnode', GRAPH_CLASS[sn.kind])
  // Owns its plain click, so a click on a label never reaches the cell's
  // expand gesture.
  el.setAttribute('data-g-hit', '')
  el.innerHTML = GRAPH_HTML[sn.kind]
  // Transparent until the fade draws it.
  el.style.opacity = '0'
  const obj = ctx.panel(el)
  // The panel wrapper turns selection off on its element; a label's text is
  // meant to be selectable.
  el.style.userSelect = 'text'
  el.style.webkitUserSelect = 'text'
  const n = {
    id: sn.id,
    kind: sn.kind,
    key: sn.key,
    parent: sn.parent,
    el,
    obj,
    body: ctx.body(`${ctx.id}:${sn.id}`, { amp: GRAPH_FLOAT, omega: GRAPH_OMEGA, object: obj }),
    name: el.querySelector('.gnname'),
    sub: el.querySelector('.gnsub'),
    sha: el.querySelector('.gnsha'),
    count: el.querySelector('.gncount'),
    ab: el.querySelector('.gnab'),
    subj: el.querySelector('.gnsubj'),
    // 'shown', 'parked', or 'leaving' until it has faded and gone.
    phase: 'shown',
    fade: null,
    fadeEnd: 0,
  }
  if (sn.kind === 'project' || sn.kind === 'branch') {
    el.addEventListener('click', (e) => onNodeClick(ctx, s, n, e))
  }
  return n
}

/** Rewrites what changed on one label, and nothing else. */
const writeNode = (n, sn) => {
  n.parent = sn.parent
  if (sn.kind === 'project') {
    MCX.setText(n.name, sn.name)
    MCX.setText(n.sub, sn.sub)
    MCX.setAttr(n.el, 'data-state', sn.state)
  } else if (sn.kind === 'branch') {
    MCX.setText(n.name, sn.name)
    MCX.setText(n.sha, sn.head)
    const c = sn.commits
    MCX.setText(n.count, c ? `${sn.head ? '· ' : ''}${c}${sn.truncated ? '+' : ''} commit${c === 1 && !sn.truncated ? '' : 's'}` : '')
    MCX.setText(n.ab, sn.measure)
    MCX.toggle(n.el, 'base', sn.main)
  } else if (sn.kind === 'commit') {
    MCX.setText(n.sha, sn.sha7)
    MCX.setText(n.subj, sn.subject)
    MCX.setAttr(n.el, 'data-tip', sn.subject ? `${sn.sha7}\n${sn.subject}` : null)
    MCX.toggle(n.el, 'merge', sn.merge)
  } else {
    MCX.setText(n.subj, sn.text)
  }
  MCX.toggle(n.el, 'focus', sn.focus)
}

const dropNode = (ctx, s, n) => {
  n.fade?.stop?.()
  ctx.dropBody(n.body)
  n.obj.removeFromParent()
  s.nodes.delete(n.id)
}

/** Re-lays this mount's scene from its data, level and focus, touching only
 *  what differs: a label is built only for a scene id it does not hold, a
 *  body is retargeted only when its place changed, and each label rewrites
 *  only the text that changed. The camera is sent to fit the level's reach,
 *  parked labels are placed past the edge of the view it settles to, and a
 *  label the scene no longer holds starts leaving. */
const relayGraph = (ctx, s) => {
  const scene = MCGM.graphScene(s.input, s.level, s.focus)
  s.level = scene.level
  s.focus.project = scene.focus.project
  s.focus.branch = scene.focus.branch

  // Every pixel the level reaches: its labels and lines, the widest drift and
  // a pad.
  const slack = GRAPH_FLOAT * floatCeiling()
  s.extX = scene.nodes.length ? scene.reach.x + slack + GRAPH_PAD : 0
  s.extY = scene.nodes.length ? scene.reach.y + slack + GRAPH_PAD : 0
  const view = s.view
  view.h = 2 * fitZ(ctx, s) * HALF_FOV_TAN
  view.w = view.h * (ctx.h > 0 ? ctx.w / ctx.h : 1)
  s.layW = ctx.w
  s.layH = ctx.h

  const want = s.want
  want.clear()
  let parked = 0
  for (const sn of scene.nodes) if (sn.parked) parked++
  let k = 0
  for (const sn of scene.nodes) {
    want.add(sn.id)
    let x = sn.x
    let y = sn.y
    if (sn.parked) {
      const at = MCGM.siblingExit(sn, view, k++, parked)
      x = at.x
      y = at.y
    }
    let n = s.nodes.get(sn.id)
    if (!n) {
      n = makeNode(ctx, s, sn)
      s.nodes.set(sn.id, n)
      // A label that arrives beside its parent spreads out from it; any other
      // is put in its place outright.
      const from = sn.parked ? null : s.nodes.get(sn.parent)
      if (from) n.body.snap(from.body.x, from.body.y)
      else n.body.snap(x, y)
      fadeTo(s, n, 1, GRAPH_FADE_IN_S, GRAPH_FADE_OUT_S)
    } else if (n.phase === 'leaving') {
      fadeTo(s, n, 1, GRAPH_FADE_IN_S, GRAPH_FADE_OUT_S)
    }
    if (n.body.tx !== x || n.body.ty !== y) n.body.to(x, y)
    n.phase = sn.parked ? 'parked' : 'shown'
    writeNode(n, sn)
  }

  for (const n of s.nodes.values()) {
    if (want.has(n.id) || n.phase === 'leaving') continue
    n.phase = 'leaving'
    MCX.toggle(n.el, 'focus', false)
    const to = n.parent ? s.nodes.get(n.parent) : null
    if (to) n.body.to(to.body.tx, to.body.ty)
    fadeTo(s, n, 0, GRAPH_FADE_IN_S, GRAPH_FADE_OUT_S)
  }

  // The lines of the level just left that reach a leaving label stay until
  // that label is gone, so they shrink back with it.
  const prev = s.edges
  s.edges = scene.edges
  const seen = s.edgeKeys
  seen.clear()
  for (let i = 0; i < scene.edges.length; i++) seen.add(edgeKey(scene.edges[i]))
  const ghosts = []
  for (let L = 0; L < 2; L++) {
    const list = L ? prev : s.ghosts
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      const key = edgeKey(e)
      if (seen.has(key)) continue
      seen.add(key)
      const a = s.nodes.get(e.from)
      const b = e.to === null ? null : s.nodes.get(e.to)
      if (a?.phase === 'leaving' || b?.phase === 'leaving') ghosts.push(e)
    }
  }
  s.ghosts = ghosts
}

/** A line buffer grown to hold at least `need` segments, coloured by its
 *  theme name every frame. */
const growGraphLines = (ctx, buf, need) => {
  let cap = Math.max(GRAPH_LINE_CAP, buf.cap)
  while (cap < need) cap *= 2
  if (buf.seg && cap === buf.cap) return
  if (buf.seg) ctx.release(buf.seg)
  buf.seg = ctx.lineSegments(new Float32Array(cap * 6), buf.name, buf.fallback)
  // Its ends move with the labels every frame, so no bounding volume is ever
  // allowed to cull it.
  buf.seg.frustumCulled = false
  buf.seg.geometry.setDrawRange(0, 0)
  buf.cap = cap
  buf.drawn = 0
}

/** Segment `i` of a line buffer, from layout coordinates (y down). */
const segAt = (p, i, x0, y0, x1, y1) => {
  const j = i * 6
  p[j] = x0; p[j + 1] = -y0; p[j + 2] = 0
  p[j + 3] = x1; p[j + 4] = -y1; p[j + 5] = 0
}

const finishGraphLines = (ctx, buf, n) => {
  if (n === 0 && buf.drawn === 0) return
  buf.seg.geometry.setDrawRange(0, n * 2)
  buf.drawn = n
  if (n > 0) ctx.touch(buf.seg)
}

/** Every line of the scene, from where the bodies are drawn this frame. A
 *  commit's end of a line is its point on the rail. A merge's second edge
 *  bends out into the lane left of the rail and back in to its second
 *  parent; when that parent is not shown it bends out and runs down a full
 *  row, off toward a commit this branch does not list. */
const graphLines = (ctx, s) => {
  const G = MCGM.GRAPH_GEOM
  const rail = MCGM.GRAPH_RAIL_DX
  const nodes = s.nodes
  let wireNeed = 0
  let hotNeed = 0
  for (let L = 0; L < 2; L++) {
    const list = L ? s.ghosts : s.edges
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind === 'merge') hotNeed += 3
      else wireNeed++
    }
  }
  for (const n of nodes.values()) if (n.kind === 'commit') hotNeed += 4
  if (wireNeed > s.wire.cap) growGraphLines(ctx, s.wire, wireNeed)
  if (hotNeed > s.hot.cap) growGraphLines(ctx, s.hot, hotNeed)
  const wp = s.wire.seg.geometry.getAttribute('position').array
  const hp = s.hot.seg.geometry.getAttribute('position').array
  let w = 0
  let h = 0
  for (let L = 0; L < 2; L++) {
    const list = L ? s.ghosts : s.edges
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      const a = nodes.get(e.from)
      if (!a || a.phase === 'parked') continue
      const b = e.to === null ? null : nodes.get(e.to)
      if (e.to !== null && (!b || b.phase === 'parked')) continue
      const ax = a.body.px + (a.kind === 'commit' ? rail : 0)
      const ay = a.body.py
      if (e.kind !== 'merge') {
        segAt(wp, w++, ax, ay, b.body.px + (b.kind === 'commit' ? rail : 0), b.body.py)
        continue
      }
      const lx = ax - G.lane
      if (b) {
        const bx = b.body.px + rail
        const by = b.body.py
        const d = (by - ay) * 0.3
        segAt(hp, h++, ax, ay, lx, ay + d)
        segAt(hp, h++, lx, ay + d, lx, by - d)
        segAt(hp, h++, lx, by - d, bx, by)
      } else {
        const d = G.pitch * 0.3
        segAt(hp, h++, ax, ay, lx, ay + d)
        segAt(hp, h++, lx, ay + d, lx, ay + G.pitch)
      }
    }
  }
  for (const n of nodes.values()) {
    if (n.kind !== 'commit' || n.phase === 'parked') continue
    const x = n.body.px + rail
    const y = n.body.py
    const r = GRAPH_MARK
    segAt(hp, h++, x, y - r, x + r, y)
    segAt(hp, h++, x + r, y, x, y + r)
    segAt(hp, h++, x, y + r, x - r, y)
    segAt(hp, h++, x - r, y, x, y - r)
  }
  finishGraphLines(ctx, s.wire, w)
  finishGraphLines(ctx, s.hot, h)
}

const gitGraph = {
  mount(ctx) {
    const s = ctx.state
    s.input = []
    s.level = 'projects'
    s.focus = { project: null, branch: null }
    s.nodes = new Map()      // scene id -> label, leaving labels included
    s.want = new Set()       // scratch, reused by every re-lay
    s.edges = []             // the current level's lines
    s.ghosts = []            // the last level's lines to labels still leaving
    s.edgeKeys = new Set()   // scratch, reused by every re-lay
    s.view = { w: 0, h: 0 }  // the view parked labels were last placed outside of
    s.layW = s.layH = NaN    // the cell size that view was measured for
    s.extX = 0
    s.extY = 0
    s.zNow = NaN
    s.zGoal = 0
    s.zVel = 0
    s.fitW = s.fitH = s.fitX = s.fitY = NaN
    s.clock = 0
    s.wire = { seg: null, cap: 0, drawn: 0, name: 'accentDeep', fallback: FALLBACK.accentDeep }
    s.hot = { seg: null, cap: 0, drawn: 0, name: 'accent', fallback: FALLBACK.accent }
    growGraphLines(ctx, s.wire, GRAPH_LINE_CAP)
    growGraphLines(ctx, s.hot, GRAPH_LINE_CAP)
  },

  /** Runs on every projects frame, so it is a diff: see relayGraph. The level
   *  and focus hold across it; a focus whose project or branch has gone falls
   *  back a level. */
  update(ctx, params, data) {
    const s = ctx.state
    s.input = Array.isArray(data) ? data : []
    relayGraph(ctx, s)
  },

  /** Puts this mount's graph at `level`. `focus` is `{ project, branch }`,
   *  or a string: a branch name at 'commits', within the project already in
   *  focus, and a project key at any other level. `input`, when it is an
   *  array, stands in for the projects list until the next update. */
  setGraph(ctx, input, level, focus) {
    const s = ctx.state
    if (Array.isArray(input)) s.input = input
    let project = s.focus.project
    let branch = null
    if (isObj(focus)) {
      project = typeof focus.project === 'string' ? focus.project : null
      branch = typeof focus.branch === 'string' ? focus.branch : null
    } else if (typeof focus === 'string') {
      if (level === 'commits') branch = focus
      else project = focus
    }
    goGraph(ctx, s, level, project, branch)
  },

  /** One level back out: commits to branches, branches to every project.
   *  Whether it moved. */
  graphBack(ctx) {
    const s = ctx.state
    if (s.level === 'commits') {
      goGraph(ctx, s, 'worktrees', s.focus.project, null)
      return true
    }
    if (s.level === 'worktrees') {
      goGraph(ctx, s, 'projects', null, null)
      return true
    }
    return false
  },

  frame(ctx, t, dt) {
    const s = ctx.state
    s.clock = t
    // A resized cell shows a different view, so parked labels are placed
    // outside the new one.
    if (s.layW !== ctx.w || s.layH !== ctx.h) relayGraph(ctx, s)
    easeCamera(ctx, s, dt)
    let dropped = false
    for (const n of s.nodes.values()) {
      if (n.phase === 'leaving' && s.clock >= n.fadeEnd) {
        dropNode(ctx, s, n)
        dropped = true
      }
    }
    if (dropped) s.ghosts = s.ghosts.filter((e) => s.nodes.has(e.from) && (e.to === null || s.nodes.has(e.to)))
    graphLines(ctx, s)
  },

  unmount(ctx) {
    for (const n of ctx.state.nodes.values()) n.fade?.stop?.()
  },
}

const COMPONENTS = new Map([
  ['session-card', sessionCard],
  ['git-graph', gitGraph],
])
// The four functions every entry in the table must carry.
const ENTRY_HOOKS = Object.freeze(['mount', 'update', 'frame', 'unmount'])

// -------------------------------------------------------------------- surface
const MCGS = {
  ready: false,

  /** The hosting call: a view that hosts the stage calls this with its own
   *  line canvas every time it is shown, and it always leaves the frame loop
   *  running.
   *
   *  On the canvas the stage already draws to, it rebuilds and allocates
   *  nothing, and only resumes. That holds whether the renderer there is
   *  alive, never started because WebGL is unavailable, or lost and waiting
   *  for its context back, which the restore event rebuilds on its own.
   *
   *  On a different canvas, it moves the stage there: the renderer and every
   *  line material and geometry are disposed, a new renderer is built on the
   *  new canvas, and every mount's line objects are uploaded to it again. The
   *  canvas left behind is hidden. Without WebGL the new canvas is hidden
   *  instead, `ready` stays false, and the DOM layer keeps rendering. Mounts
   *  survive either. Returns `ready`. */
  boot(opts) {
    const canvas = opts && opts.glCanvas ? opts.glCanvas : null
    if (!everBooted || canvas !== glCanvas) hostOn(canvas)
    everBooted = true
    MCGS.resume()
    return MCGS.ready
  },

  /** Adds a component to the table under `name`. `factory` is called once,
   *  here, and must return an entry with mount, update, frame and unmount
   *  functions; the entry is what mount() looks up by name from then on.
   *  Refuses, changing nothing and returning false, a name that is not a
   *  non-empty string or is already taken (the built-in ones included), a
   *  factory that is not a function or that throws, and an entry missing any
   *  of the four. Returns true once the component is added. */
  register(name, factory) {
    if (typeof name !== 'string' || name === '' || COMPONENTS.has(name)) return false
    if (typeof factory !== 'function') return false
    let entry
    try {
      entry = factory()
    } catch (e) {
      console.error(`sandbox stage: component ${name} could not be built`, e)
      return false
    }
    if (!entry || (typeof entry !== 'object' && typeof entry !== 'function')) return false
    for (let i = 0; i < ENTRY_HOOKS.length; i++) {
      if (typeof entry[ENTRY_HOOKS[i]] !== 'function') return false
    }
    COMPONENTS.set(name, entry)
    return true
  },

  /** The entry registered under `name`, or null. */
  component(name) {
    return COMPONENTS.get(name) ?? null
  },

  /** Mounts `componentId` into `stageEl`, which may be any element in any
   *  view: the stage reads nothing from the page but that element and the
   *  canvas it was booted on. A mount is drawn while its rectangle meets
   *  that canvas's box (its parent's box without WebGL), so a hosting view
   *  keeps its mounts inside the canvas it boots with. The same node mounted
   *  again with the same id updates its params and data in place; a
   *  different id replaces what was there. An id with no entry in the table
   *  leaves the node empty. Returns whether the node now holds a component. */
  mount(stageEl, componentId, params, data) {
    if (!stageEl || typeof stageEl.appendChild !== 'function') return false
    const p = params && typeof params === 'object' ? params : {}
    const d = data ?? null
    let m = mounts.get(stageEl)
    if (m && m.id === componentId) {
      m.ctx.params = p
      m.ctx.data = d
      try { m.comp.update(m.ctx, p, d) } catch (e) { report(m, e) }
      return true
    }
    if (m) unmountOne(m)
    const comp = COMPONENTS.get(componentId)
    if (!comp) return false
    m = createMount(stageEl, componentId, comp)
    mounts.set(stageEl, m)
    list.push(m)
    const r = stageEl.getBoundingClientRect()
    if (r.width >= 1 && r.height >= 1) fit(m, r.width, r.height)
    m.ctx.params = p
    m.ctx.data = d
    try {
      comp.mount(m.ctx)
      comp.update(m.ctx, p, d)
    } catch (e) {
      report(m, e)
    }
    return true
  },

  unmountAll() {
    for (let i = list.length - 1; i >= 0; i--) unmountOne(list[i])
  },

  pause() {
    running = false
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
    lastTs = -1
  },

  /** Restarts the frame loop and nothing else: it never checks or changes
   *  which canvas the lines are drawn on. A view that hosts the stage calls
   *  boot on entry, never a bare resume, because resume cannot know which
   *  canvas its caller expects the lines on. */
  resume() {
    if (running) return
    running = true
    lastTs = -1
    rafId = requestAnimationFrame(tick)
  },

  /** `settle` above 0 makes a retargeted body travel; 0 puts it at its
   *  target at once. `float` scales every body's drift. With settle off
   *  nothing eases, so the drift stops at once too. */
  setCalm(scale) {
    const settle = Number(scale?.settle)
    const float = Number(scale?.float)
    calm.settle = Number.isFinite(settle) && settle > 0 ? settle : 0
    calm.float = Number.isFinite(float) && float > 0 ? float : 0
    if (!(calm.settle > 0)) floatNow = calm.float
  },

  setFlyOut(name) {
    if (name === 'slide' || name === 'scale') flyOut = name
  },

  openFlyOut(cardId) {
    flyOpen = cardId ?? null
    forward('openFlyOut', flyOpen)
  },

  closeFlyOut() {
    flyOpen = null
    forward('closeFlyOut')
  },

  /** Whether a fly-out is open on a mounted component that can hold one. */
  flyOutOpen() {
    if (flyOpen === null) return false
    for (let i = 0; i < list.length; i++) if (typeof list[i].comp.openFlyOut === 'function') return true
    return false
  },

  /** Puts every mounted graph at `level` with `focus`; see the worktree
   *  graph's own setGraph for what the arguments mean. */
  setGraph(input, level, focus) {
    graph.input = input ?? null
    graph.level = typeof level === 'string' ? level : 'projects'
    graph.focus = focus ?? null
    forward('setGraph', graph.input, graph.level, graph.focus)
  },

  /** Puts ONE mount's graph at `level` with `focus`, and says whether a mount
   *  at that node took it. Stage-wide setGraph reaches every mounted graph in
   *  every hosting view, which is right for the gallery and wrong for a view
   *  that owns its own level: this leaves the stage's own record alone. */
  setGraphIn(node, input, level, focus) {
    const m = mounts.get(node)
    if (!m) return false
    const fn = m.comp.setGraph
    if (typeof fn !== 'function') return false
    try { fn(m.ctx, input, level, focus) } catch (e) { report(m, e); return false }
    return true
  },

  /** Steps each graph that can be seen back out one level, and says whether
   *  any moved. A graph in a view that is not showing measures a zero
   *  rectangle and keeps its level, so an Escape pressed in one view never
   *  walks back a graph in another. */
  graphBack() {
    let stepped = false
    for (let i = 0; i < list.length; i++) {
      const m = list[i]
      const fn = m.comp.graphBack
      if (typeof fn !== 'function') continue
      const r = m.node.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      try {
        if (fn(m.ctx) === true) stepped = true
      } catch (e) {
        report(m, e)
      }
    }
    return stepped
  },
}

window.MCGS = MCGS
