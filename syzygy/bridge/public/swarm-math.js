/* Pure maths for the presence swarm. No three import, no DOM — so
   test/swarm-harness.mjs can import this under node. Same split as
   hooks/spinner-frames.js. */

/** Mirrors the 2D orb's MOOD table in app.js. The harness pins the names
 *  against that file, because two tables are two things that can drift.
 *  idle and working are both teal deliberately: working is the lit one and
 *  idle the drained one, so the swarm reads presence as brightness rather
 *  than as a hue change. */
export const MOODS = {
  idle:    { a: '#3d7f95', b: '#12262f' },
  working: { a: '#6fc3df', b: '#1b3d4c' },
  happy:   { a: '#45c9a0', b: '#143a31' },
  stuck:   { a: '#ff5670', b: '#45141f' },
  blocked: { a: '#a883e6', b: '#2b1c40' },
}

export const moodColors = (mood) => MOODS[mood] ?? MOODS.idle

export const MAX_SESSIONS = 8

/** Deterministic in i, so a session keeps its orbit across frames. The golden
 *  angle spreads phases without two sessions ever colliding. */
export const sessionOrbit = (i) => ({
  radius: 1.85 + (i % 3) * 0.24,
  inclination: (i % 4) * 0.42 - 0.63,
  phase: (i * 2.399963229728653) % (Math.PI * 2),
})

export const clampSessions = (list) => (list ?? []).slice(0, MAX_SESSIONS)

// the heartbeat trigger needs "is any session
// GENUINELY working" (not merely S.activity above some raw threshold, which
// is the wrong signal: S.activity is a decaying spike model that
// tool-call bursts also ride, so a raw-threshold read would double-fire off
// ordinary tool-call activity rather than the idle -> thinking edge alone).
// app.js already has exactly this predicate (`genuinelyWorking`, `STALL_MS`)
// for the session-card badge, but app.js is a plain classic script and
// swarm.js is an ES module with no shared scope between them — so this is a
// deliberate mirror of app.js's copy, pinned against its real source by the
// harness the same way MOODS is pinned against app.js's MOOD table above
// (two copies are two things that can drift; the pin is what stops that).
export const STALL_MS = 30_000
export const genuinelyWorking = (s) => !!(s && s.working && !(s.progressAt && Date.now() - s.progressAt > STALL_MS))

export const PULSE_SLOTS = 4

export const makePulseRing = () => ({ slots: [], next: 0 })

/** Fixed size because a GLSL uniform array is fixed size. */
export const pushPulse = (ring, now, strength) => {
  const p = { birth: now, strength }
  if (ring.slots.length < PULSE_SLOTS) ring.slots.push(p)
  else {
    let oldest = 0
    for (let i = 1; i < ring.slots.length; i++) {
      if (ring.slots[i].birth < ring.slots[oldest].birth) oldest = i
    }
    ring.slots[oldest] = p
  }
}

export const activePulses = (ring, now, life) =>
  ring.slots
    .map((p) => ({ age01: (now - p.birth) / life, strength: p.strength }))
    .filter((p) => p.age01 >= 0 && p.age01 < 1)

// A mode is not "how a session renders" but "which whole presence LOOK is
// active". MODES takes an arbitrary number of look names — nothing downstream
// assumes a particular count, so a new look slots into this array without
// touching the cycling logic in swarm.js. The cycle order is
// iris -> streams -> shell.
export const MODES = ['iris', 'streams', 'shell', 'shell v2']

// The look a fresh pane opens on, and the fallback for a corrupt or staged
// name. NOT MODES[0]: the cycle order is the order the corner button walks,
// and shell is what a fresh pane should open on without reordering that
// walk. A persisted choice still wins — swarm.js only falls back to this when localStorage says nothing.
export const DEFAULT_MODE = 'shell'

export const normalizeMode = (name) => (MODES.includes(name) ? name : DEFAULT_MODE)

// Two shapes live in LOOKS, by design.
//
// iris/shell are a set of uniform values applied to the ORIGINAL shared
// shader, material, geometry and draw call. The rule is that a look is a
// different force function over the same particle buffer, never a second
// renderer — true of THIS pair. iris is today's settled
// crest capture (uGather 1); shell is the identical curl-advected cloud with
// capture switched off (uGather 0) — both paths already exist in swarm.js's
// VERT, so this mode costs nothing new. `applyLook()` in swarm.js loops
// these keys onto the legacy material's uniforms.
//
// streams is a DIFFERENT shape on purpose: a whole separate shader,
// material and geometry (its own architecture — a separate shader per
// look, one Points, one geometry each, material swap on mode
// change"), because its particle count, blending and transport are
// unrelated to the legacy pipeline. swarm.js never loops `LOOKS.streams`
// onto the legacy material's uniforms the way it does for iris/shell —
// `.p` is a numbered-parameter table, not a uniform-name map, and
// none of its keys collide with a legacy uniform name by construction.
// `.p` is what the streams harness below asserts against directly — "the
// module the pane uses," never a copy.
// Reactive layer — uRipLift/uRipGlow
// ride the SAME "a look is only ever a set of uniform values" mechanism
// applyLook() already has (swarm.js), so iris gets the field ripple's body
// lift/front glow and shell is silenced by construction: shell keeps its
// own pre-existing radial shove (fed separately, gated by mode in swarm.js,
// not by these two) rather than reacting to the field it doesn't have.
// uAlpha — at iris's alpha shell read as a flat grey haze: the
// particles were too dim to make out at all. shell shares iris's material,
// shader and uAlpha uniform
// (no separate `glow` uniform exists on this shared shader — unlike
// streams's uGlow, alpha IS the whole brightness lever here, since
// AdditiveBlending's default (SrcAlpha, One) means each fragment adds
// `color * alpha` straight into the framebuffer: at this sparse, unsaturated
// density that's linear, so doubling alpha doubles each particle's actual
// contribution, not just a perceptual nudge). shell reads dim at the SAME
// 0.17 iris uses because uGather 0 spreads particles as a diffuse cloud
// instead of gathering them onto lattice veins — same per-particle
// brightness, lower local screen density, so it reads as gray haze rather
// than lit points. Point size (aSize/uPointScale) is the other lever
// available, but a bigger sprite at this same density blurs into MORE
// haze, not less — the opposite of reading as lit particles rather than as a
// gray haze — so alpha alone is the fix; point size is untouched.
// iris keeps uAlpha 0.17 — same value swarm.js's material already
// initializes it to (see the uAlpha uniform's own comment there) — but now
// SPELLED OUT here rather than left to the material default: applyLook()
// only ever writes the keys present in the target look's own config and
// never resets an absent key, so once shell's config carries its own
// uAlpha, switching back to iris would silently inherit shell's brighter
// value forever after the first visit to shell unless iris pins its own
// value explicitly right here. shell 0.17 -> 0.34, exactly twice iris's.
// --- the orbiting session clusters -------------------------------
// The little clusters iris and shell draw around the body read as flat dots.
// The fix is far more particles, not bigger ones: density is what makes them
// read as bodies rather than as discs.
//
// They were never flat by construction — they are 60 Fibonacci points on a
// unit sphere. Three separate things made them read as discs, and the first is
// the one that mattered:
//
//   1. contain() was crushing them. It is a tanh squash of any radius past
//      SAFE_RADIUS 1.0481 onto CONTAIN_CEILING 1.1646, and it SATURATES. A
//      cluster orbits at 1.85-2.33, far into saturation, so every one of its
//      points came back at the same radius — 0.000% of the sphere's depth
//      survived. It was being projected onto the containment shell, and a
//      sphere projected onto a shell is a disc.
//   2. Far too sparse: 60 grains over a ~59px disc never touch, so there is no
//      surface for shading or parallax to read on.
//   3. Once (1) was fixed the orbit's own depth (0.6 x radius) was exposed,
//      putting a cluster 1.80 from a camera at 3.2 against 4.60 on the far
//      side — a 2.55x size swing that reads as lunging at the viewer. The
//      flattening had been hiding it.
export const CLUSTER = {
  // Density comes from COUNT, not grain size, and the distinction matters.
  // 60 grains at 3.1px measured 0.04 sprites of overlap per pixel; 12 000 at
  // 2.2px measure 5.9. The grain gets FINER while the surface gets solid.
  particles: 2800,   // 12 000 was "too pixel dense", 2 000 a little thin
  grain: 1.0,        // aSize per point (was 1.4) — finer, and there are far more
  // A cluster has to fit BETWEEN the body and the panel edge, and that gap is
  // narrow: the body reaches 1.027 with relief, the panel half-height is
  // 1.325. At spread 0.16 / bound 1.12 the inner edge was 0.96 and the
  // clusters passed straight THROUGH the side of the core sphere.
  // 0.11 / 1.20 gives an inner edge of
  // 1.09 and an outer of 1.31: clear of both.
  spread: 0.11,      // cluster radius x uRadius, idle (was 0.30)
  spreadWork: 0.09,  // ... while working: still tightens, as it always did
  // Curl drift, as a FRACTION OF THE CLUSTER'S OWN RADIUS. It used to be a
  // flat 0.04 in world units, which was 13% of the old 0.30 spread and 25% of
  // the new one — so a cluster morphed and rippled too much to hold a shape
  // at all. As a fraction it stays honest at any spread.
  drift: 0.10,
  driftRate: 0.08,
  // Accumulated brightness under additive blending is (points overlapping a
  // pixel) x (per-point fade), and the point count went up 30x while the fade
  // stayed where it was for 60 points — so clusters blew out to white. Worse,
  // a working cluster TIGHTENS, which raises density and brightness together,
  // so only the busy ones whited out, each at whatever moment it happened to
  // be working. The per-point fade is now derived from
  // the measured density to hit this accumulated target, and scales with
  // spread^2 so tightening no longer changes total brightness by itself.
  targetAlpha: 0.72,
  workBoost: 0.2,    // the deliberate "this one is working" brightening, on top
  // The centre is clamped, NEVER the points — per-point containment is defect
  // (1) above. Because the clamp scales the whole centre vector, this governs
  // the depth swing too: at 1.20 a cluster sits 3.03-3.38 from the camera, a
  // 1.12x change. Both are uniforms: MCS.setClusterBound / setClusterOrbitZ.
  centreMax: 1.18,   // + the largest spread = 1.319, inside the panel's 1.325
  // Clusters are not all the same size: identical spheres read as a row of
  // dots rather than as separate bodies. Deterministic per SLOT, from
  // the golden ratio, so a session's cluster keeps its size for as long as it
  // owns the band and two neighbours never match. The fade compensation below
  // takes this in, or the smaller ones would read brighter for being denser.
  sizeVarMin: 0.85, sizeVarMax: 1.15,
  // The pointer lean. The body translates toward the cursor by 0.22 x uRadius
  // and the clusters did not move at all, so the body slid straight into
  // them, most visibly at the exact moment the pointer pulled it their way.
  // They take the
  // same translation now. At full deflection the near cluster can graze the
  // panel edge; that is transient and MCS.setClusterPull() dials it.
  pull: 0.22,
  orbitZ: 0.15,
}

export const LOOKS = {
  iris:  { uGather: 1, uRipLift: 0.4, uRipGlow: 0.35, uAlpha: 0.17, uArc: 0, uClusterHide: 0 },
  // shell sets uRipLift/uRipGlow above zero even though it has no crest field
  // to ripple: messaging the focused session has to produce the same slow,
  // large swell here that it does in streams, and the lift and the glow are
  // the only levers that can carry it.
  //
  // THE SCALE HERE IS NOT THE SAME AS IRIS'S, and that is the whole reason
  // two attempts at this changed nothing visible. `beat` in the shader is
  // `sum(B.x * gaussian)`, and B.x is the preset's BEND — so beat peaks at
  // 0.13 for the ask ring and 0.08 for a heartbeat, never at 1. Iris's 0.4
  // therefore buys 0.052 units of radial lift, which iris gets away with
  // because its visible ripple is the BEND acting on the crest field, not
  // the lift. shell has uGather 0, so the bend does nothing at all here: the
  // lift and the glow are its ONLY response, and they have to be scaled
  // against a beat that tops out at 0.13.
  //
  // 1.0 x 0.13 = 0.13 units of lift on a radius-1 sphere, peaking at radius
  // 1.13 against contain()'s 1.1646 ceiling. That is a real swell.
  // `shell v2` is the body on its own, with the orbiting clusters around it.
  'shell v2': { uGather: 0, uRipLift: 1.0, uRipGlow: 0.9, uAlpha: 0.34, uArc: 0, uClusterHide: 0 },
  // `shell` is that same body plus the lightning arcs, and no clusters: the
  // arcs are the thing to look at, and the moons crowd them. Same buffer, same
  // draw call, gated by a uniform rather than by a second renderer — so the
  // two differ in exactly the two keys below and nothing else.
  shell: { uGather: 0, uRipLift: 1.0, uRipGlow: 0.9, uAlpha: 0.34, uArc: 1, uClusterHide: 1 },
  streams: {
    // Retuned 0.12 -> 0.16: streams has to glow more like iris does.
    // The cheap lever within over-blending (blend mode itself untouched —
    // see swarm.js's uGlow, the other half of it): more opacity per
    // grain, still well inside the N*alpha*size^2 rule, which is there to
    // keep a grain from saturating to solid.
    alpha: 0.16,
    // ^ over-blended, N*alpha*size^2 rule
    wrap: Math.PI * 20, // uAngle wraps here: lane factors are tenths, so every
                         // factor*wrap lands on an exact multiple of 2*PI (Rule A)
    p: {
      scaleAlong: 3.6, scaleAcross: 1.0, branchScale: 2.0, branch: 0.20, warp: 0.12,
      gather: 1.0, reach: 0.18, fall: 0.6,
      // Slightly less structure overall, and only slightly: 0.30 -> 0.32, a
      // ~7% widening of the sheath (more particles held short of the core
      // rather than pulled fully onto a crest). Not uGather (LOOKS.streams
      // is harness-pinned as a params table, and uGather is what "streams
      // gathers at all" means — turning that down is a different thing from
      // loosening it) and not uReach (the capture radius, which the JS twin
      // doesn't touch but which governs how much of the shell reads as vein
      // at all, a bigger lever than "barely"). loose is the one knob this
      // look already treats as how tightly the crest is held, so a small bump is
      // the smallest way to read as looser. Picked nearer the current value
      // than the top of its documented range on purpose: err toward too
      // little.
      loose: 0.32,
      relief: 0.04, dustFade: 0.45,
      shimmer: 0.15, stretch: 2.2, shear: 2.0,
      // orbit itself is untouched; ORBIT_IDLE_MUL/
      // ORBIT_BUSY_MUL below are the retuned levers (see their own comment).
      orbit: 0.10, drift: 0.02, morph: 0.025,
    },
  },
}

// --- Streams transport — closed-form, no noise, exact in a JS twin --------
// Position is a pure function of
// (aHome, aSeed, accumulated angles, the look's own parameter table): a
// differential rotation about a fixed axis with a bounded travelling shear
// and a six-lane velocity profile. No lifetime, no re-seed, no noise — which
// is exactly why a JS twin of it is EXACT rather than an approximation that
// can drift (spec's standing "GLSL is not unit-testable" objection is about
// copying NOISE; this copies none). swarm.js imports transportStreams,
// freshAngles and advance from here — same "read the real file" rule as
// MOODS/LOOKS above — so the shader and this twin cannot quietly diverge.

const TAU = Math.PI * 2

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
export const norm3 = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
/** Rodrigues rotation of v about the unit axis a by angle t — the JS twin of
 *  the shader's `rot()`, verbatim in shape. */
export const rot3 = (v, axis, t) => {
  const c = Math.cos(t), s = Math.sin(t)
  const cr = cross3(axis, v)
  const d = dot3(axis, v)
  return [
    v[0] * c + cr[0] * s + axis[0] * d * (1 - c),
    v[1] * c + cr[1] * s + axis[1] * d * (1 - c),
    v[2] * c + cr[2] * s + axis[2] * d * (1 - c),
  ]
}

// Transport shape constants — page-lifetime fixed (Rule A: never retuned
// live, never multiplied by uTime at runtime). FLOW_AXIS off the view axis
// on purpose (~53 deg) so streams reads as zonal bands, not a face-on spin.
export const FLOW_AXIS = norm3([0.30, 0.75, 0.60])
export const PREC_AXIS = [0, 1, 0]
// Whole-sphere rigid rotation (`rot(nrm, uPrecAxis, uPrec)`, the LAST step
// of both STREAMS_VERT's main() and this file's own transportStreams() —
// applied identically to every particle, dust and captured grains alike, on
// top of the differential per-band motion). The orb should always be spinning
// slightly, never fast, and speed up a little as more sessions go active, so
// the rate has to be perceptible: 0.004 rad/s is one turn every ~26 minutes,
// and even 0.02 is one every ~5.2 minutes — a rotation nobody sees. This value
// is still page-lifetime fixed in the sense
// Rule A means (accumulated on the CPU in advance() below, never
// `rate * uTime`, never hand-retuned mid-session) — SPIN_MULT_SCALE is what
// is new: advance()'s own `spinMult` parameter modulates this rate by the
// SAME session multiplier the ripple layer uses (sessionRippleMultiplier),
// damped to a small fraction so it stays a slight speed-up, never a
// spin-up — see advance()'s own comment.
//
// 0.05 is ~2.1 min/turn and still too slow to read as rotation at all.
// Nothing in this range ever reads as too FAST, so the value biases hard
// rather than nudging: the target is one rotation every 30-45 seconds.
//
// Checked against the harness BEFORE picking a value, because that target
// range is not uniformly safe: a sweep of 8 candidate rates (0.10 through
// 0.30) across the same 7-pair robustness sweep the other tuning notes in
// this file use found idle meanSpeedPx climbing roughly linearly with
// PREC_RATE — safely under the existing [30,60] bound through ~45s/turn
// (rate 0.14, idle max 56.5px/s across the sweep) but ALREADY OVER it by
// ~30s/turn (rate 0.20, idle max 61.1px/s > 60) — so the fast half of the
// requested range would have broken the existing bound, not just
// approached it. Landed at the slow edge of the requested range rather
// than the fast one, on purpose: it satisfies the 30-45 second target
// literally and needs no bound change — busy meanSpeedPx max 137.1px/s,
// comfortable under 150. If a period faster than ~40s is wanted after
// seeing this, `meanSpeedPx`'s idle bound would need to widen, or the
// spin excluded from what the transport twin measures — both real
// decisions, not made here.
export const PREC_RATE = 0.14
export const SPIN_MULT_SCALE = 0.3
export const SHEAR_RATE = 0.03
export const BANDS = 3.0

// After a live look at the shipped defaults, idle
// read as barely moving — meanSpeedPx measured 6.01, the
// very floor of the [5,12] idle band it should sit in, not the mid-to-upper
// "9-10" a glance should read as motion. ORBIT_IDLE_MUL/ORBIT_BUSY_MUL are
// the rotation-rate multipliers at activity 0 and 1 (matching the shape of
// iris's own `0.7 -> 2.0`-style reaction table).
// Landed at 1.1/2.1 (idle 9.57px/s, busy 17.82px/s) — kept below as
// history, superseded by the retune below.
//
// The target: idle ≈45px/s (a grain crossing in ~4.5s), busy 2.5-3x that
// (110-135px/s), reached through the orbit rate specifically rather than
// through shear or noise amplitude. That target is UNREACHABLE via this lever
// -- or, by the mechanism below, via any transport-rate lever -- without
// breaking a coherence bound, and a coherence bound is never loosened to buy
// speed. What blocks it:
//
// The six-lane velocity profile (`factor = 1.2 - 0.5*lane` in
// `transportStreams`) means two nearby particles can be rotating at up to a
// 1.7x different rate depending on their (position-independent, seed-hashed)
// lane. ``'s own determinism rule 3 requires
// sampling "at a random offset into a LONG run" (0-600s) rather than from
// t=0, precisely so the harness exercises the travelling shear at every
// phase — but that same long warm-up is what makes lane divergence bite:
// the higher the orbit rate, the more total angle separates a fast lane
// from a slow lane by the time a 0-600s-out sample is taken, and past a
// certain rate that divergence is large enough (many multiples of the
// 20*PI wrap) that screen-neighbouring particles are, on average, no longer
// from nearby lanes at all — coherence13 (`>0.90`) degrades from there,
// measured crossing the line between ORBIT mul 2.5 (0.9101, still passing)
// and 2.7 (0.8997, failing) at BOTH activity levels independently (idle and
// busy each depend on their own MUL alone, since `advance()`'s sqrt(act)
// shaping is exactly 0 or exactly 1 at the two endpoints — there is no
// blending to hide behind). This is a snapshot property, not a windowing
// artifact: it barely moves between a 7s and a 2s sampling window (0.9078
// vs 0.9101 at mul 2.5) — shrinking the window, which WOULD fix
// `pathOverNet`'s own separate, unrelated wall (arc/chord approaches
// pi/2 once a sample window covers close to a half-turn — real geometry,
// not jitter), does nothing for this one. Narrowing the six-lane spread
// itself would fix it, but that is a transport-SHAPE change -- restructuring
// the channels -- rather than a retune, and the six lanes are what make the
// motion read as a river rather than a spinning ball.
//
// So this pass pushes the orbit rate as far as it safely goes while
// keeping real margin on every one of the seven measures (not shipped at
// the coherence13 knife-edge): idle 1.1 -> 1.3 (9.57 -> ~11.3px/s), busy
// 2.1 -> 2.3 (17.82 -> ~19.8px/s) — a real, measured improvement (+18%
// idle, +11% busy, both confirmed at 7 different (seedRng, offsetRng) pairs
// with margin: worst-case coherence13 across all seven pairs is 0.9581
// idle / 0.9154 busy, both comfortably clear of 0.90), but well short of
// the requested 45/110-135. That gap — not a tuning choice, a wall — is
// reported in, not hidden behind a quieter number.
// KEPT AS HISTORY — the retune below found the "wall" above was a broken
// metric, not a property of the transport, so this ceiling was never real.
//
// The "coherence13 wall" was the METRIC, not the motion. `motionMetrics()`'s coherence
// pairing sampled the whole front hemisphere, and `minLegPx` admits or
// excludes limb grains (whose foreshortened screen speed is small)
// DIFFERENTLY depending on orbit rate — so raising the orbit rate silently
// changed which grains coherence13 was measuring, not just how fast they
// moved. Proven by controlled experiment: forcing every lane factor to 1.0
// (no six-lane spread at all) reproduced the SAME coherence13 drop with
// orbit rate (0.886/0.879/0.893 at x1/x2.5/x2.7, all three near-identical
// whether or not lanes existed) — impossible if lane spread were the cause,
// since a lane changes a grain's SPEED, never its DIRECTION, and coherence
// is direction agreement. See `motionMetrics()`'s own doc comment for the
// fix (cone-restricting coherence pairs to the same `centreDeg` cone
// speed/path/turns already use, plus scaling the sampling window AND the
// per-step dt with the orbit rate). With the metric corrected, coherence13
// is FLAT across orbit rate (measured 0.9995 at x1, x2.5 and x4 alike) — the
// six-lane spread was never a coherence ceiling, so this pass ships the
// requested target directly rather than searching for a new wall:
// idle 1.3 -> 5.25 (~11.3 -> ~45.0px/s), busy 2.3 -> 14.5 (~19.8 ->
// ~123.7px/s, a 2.76x idle/busy ratio — inside the requested 2.5-3x). Every
// one of the seven measures still clears its bound with real margin at 7
// different (seedRng, offsetRng) pairs; the lane spread itself is UNTOUCHED — `factor = 1.2 - 0.5 *
// lane` in `transportStreams` below is exactly what it has always been, and
// there was never anything to buy by narrowing it.
export const ORBIT_IDLE_MUL = 5.25
export const ORBIT_BUSY_MUL = 14.5

/** The look's own accumulated-angle state. Every field is a pure rotation or
 * phase — wrapping is exact, precision never decays. */
export const freshAngles = () => ({ time: 0, orbit: 0, drift: 0, prec: 0, phaseA: 0, phaseB: 0 })

/** One frame's worth of angle accumulation. Pure. Rates scale with activity;
 *  angles themselves only ever accumulate — never `rate * uTime` (Rule A),
 *  which is what makes a live rate change (idle <-> busy) change speed from
 *  here on, never teleport the position. `wrap` is the look's own (20*PI for
 *  streams, 2*PI elsewhere).
 *
 *  The orbit rate is shaped by `sqrt(act)`, not `act` directly — the same
 *  front-loading trick iris's own `act = sqrt(uActivity)` uses (swarm.js):
 *  a real tool-call spike decays in under a second, so a sparse, realistic
 *  working cadence mostly sits in the 0.1-0.4 activity range and rarely
 *  reaches 1.0. A linear response there is a real but easy-to-miss change;
 *  sqrt pulls most of the idle-to-busy swing into that realistic range while
 *  still landing on the same ORBIT_BUSY_MUL at act=1 (sqrt(1)=1, so the
 *  activity-1 harness assertions are unaffected by this shaping). Only the
 *  rotation rate is shaped this way — morph keeps the linear response it had.
 *
 *  `spinMult` — the whole-sphere precession rate's
 *  own multiplier, defaulting to 1 (every existing caller, harness included,
 *  gets PREC_RATE exactly — the spin is ALWAYS present, even with nobody
 *  working, which is the point: the sphere is always spinning slightly).
 *  swarm.js passes sessionRippleMultiplier(workingCount) here, the SAME
 *  signal the ripple layer's strength uses, so there is one concurrency
 *  signal rather than two to keep in step.
 *  Damped by SPIN_MULT_SCALE so a large session count buys only a SLIGHT
 *  speed-up, never a fast spin: at the top of the verified
 *  range (mult~2.0 at 12 sessions), the rate rises by at most 30%, still an
 *  unmistakably slow rotation.
 *
 *  `thinkMult` (orchestrator thinking indicator) — a SEPARATE,
 *  UNDAMPED multiplier on both the orbit rate and the precession rate,
 *  deliberately not routed through spinMult's SPIN_MULT_SCALE damping: that
 *  damping is a designed property of the session-count concurrency nudge --
 *  slight, never fast -- and reusing it here would need an enormous
 *  thinkMult before the spin read as faster at all. This is a distinct,
 *  transient feature (only nonzero while `orchestrator.busy` is true, eased
 *  by `easeThinking`/swarm.js's own smoothing) and is allowed a bolder,
 *  directly-multiplicative effect. Defaults to 1 -- the identity -- so every
 *  existing caller and harness assertion that does not pass it is
 *  byte-for-byte unaffected. */
export function advance(ang, p, wrap, act, dt, spinMult = 1, thinkMult = 1) {
  const shaped = Math.sqrt(Math.max(0, Math.min(1, act)))
  const orbit = p.orbit * (ORBIT_IDLE_MUL + (ORBIT_BUSY_MUL - ORBIT_IDLE_MUL) * shaped) * thinkMult
  const morph = p.morph * (1 + 2 * act)
  const precRate = PREC_RATE * (1 + SPIN_MULT_SCALE * (Math.max(1, spinMult) - 1)) * thinkMult
  return {
    time:   ang.time + dt,
    orbit:  (ang.orbit  + orbit * dt) % wrap,
    drift:  (ang.drift  + p.drift * dt) % TAU,
    prec:   (ang.prec   + precRate * dt) % TAU,
    phaseA: (ang.phaseA + morph * dt) % TAU,
    phaseB: (ang.phaseB + morph * 1.37 * dt) % TAU,
  }
}


const clamp01 = (v) => Math.max(0, Math.min(1, v))

/** A GLSL float literal. An integer-valued JS number interpolates into shader
 *  source as `5`, which GLSL types as an int — `pow(x, 5)` then has no
 *  matching overload and the whole program fails to compile. Every constant
 *  interpolated into a chunk goes through this, so a retune to a round number
 *  cannot break the build. Lives here rather than in swarm.js because the
 *  chunk templates are evaluated against THIS module's exports when the
 *  shaders are compile-checked outside the browser — a helper defined next to
 *  the shader would be out of scope there. */
export const glf = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v))

/** How densely a cluster's points cover its own disc on screen, which is what
 *  decides whether it reads as a SURFACE or as a scatter of dots. Returns the
 *  number of point-sprites overlapping a pixel at the centre of the disc.
 *
 *  This exists because two rounds of work on how the thing was SHADED both
 *  failed while it was too sparse to have a surface at all. Pure, so the
 *  harness asserts it without a browser. Defaults are the real shipped values:
 *  a ~260 CSS px panel on a retina display, the legacy material's own
 *  uPointScale, a cluster at the camera's own distance. */
export const clusterCoverage = ({
  dpr = 2, panelCss = 260, pointScale = 5.0,
  camZ = CAMERA_Z, fovDeg = CAMERA_FOV_DEG, working = 0,
} = {}) => {
  const canvasPx = panelCss * dpr
  const pxPerUnit = (canvasPx / 2) / (camZ * Math.tan((fovDeg / 2) * Math.PI / 180))
  const spread = CLUSTER.spread + (CLUSTER.spreadWork - CLUSTER.spread) * clamp01(working)
  const radiusPx = spread * pxPerUnit
  const pointPx = CLUSTER.grain * (pointScale * dpr / camZ) * (0.7 + working * 0.5)
  const overlap = (2 * CLUSTER.particles / (4 * Math.PI * radiusPx * radiusPx)) * Math.PI * (pointPx / 2) ** 2
  return { radiusPx, pointPx, overlap }
}
/** The per-point fade that makes a cluster's ACCUMULATED brightness land on
 *  CLUSTER.targetAlpha, given how densely its points actually overlap. This is
 *  the number that stops a dense cluster clipping to white: under additive
 *  blending the pixel sums every grain, so more grains must each be dimmer. */
export const clusterFade = (opts = {}) => {
  const { overlap } = clusterCoverage(opts)
  return overlap > 0 ? Math.min(1, CLUSTER.targetAlpha / overlap) : CLUSTER.targetAlpha
}
/** Below this many overlapping sprites per pixel a cluster is a scatter of
 *  dots, not a surface. 1.0 is the bare minimum for sprites to touch; 2.0
 *  makes them merge. 5.0 reads as too pixel-dense: density has an upper
 *  bound too, enforced by the clipping test rather than here. */
export const CLUSTER_MIN_COVERAGE = 2.0

// --- the lightning arcs -----------------------------------------
// NAMING. The look these belong to is `shell`, but the table, the generator
// and the harness cases are SCRIBBLE/scribblePaths, because they describe the
// ARCS rather than the look: the arcs are a feature the look uses, and one
// could appear in another look tomorrow. Do not rename these to `shell*` —
// that would collide with the body's own constants, which are a different
// thing entirely.
// What they are for: random, glitchy lightning scribbles around the orb, sat
// almost where a planet's rings would be but drawn midair — dynamic,
// sprawling, crackling, and made of particles as fine as the main shell's.
//
// So: ring-like, but not rings. Each arc belongs to a plane around the orb the
// way a planet's rings do, and then refuses to be a circle — it kinks, forks
// off its own plane, and sprawls. The ring gives it somewhere to be; the
// lightning is what it does there.
//
// Built on the CPU as a polyline and sampled into particles: the jaggedness is
// baked into the geometry, so the shader only sweeps a bright head along an
// already-crooked line and crackles it.
export const SCRIBBLE = {
  // The shell the arcs live in — outside the body (1.027), inside the panel
  // (1.325). Arcs wander radially inside this band rather than sitting on one
  // sphere, which is most of what stops them reading as drawn-on rings.
  rMin: 1.06, rMax: 1.20,   // rMax pulled in from 1.31: it was past the 1.2246 visible bound
  rings: 4,          // distinct orbital planes, spread by the golden angle
  perRing: 7,        // arcs per plane
  // The SPINE is the crooked path; particles do not sit on it, they STREAM
  // along it. `spine` is how finely the path itself is defined; `perArc` is
  // how many particles flow down it. Conflating the two draws a line of dots
  // one particle wide. An arc is not a single-dot line: it is a stream of very
  // many fine particles darting along the spine.
  spine: 96,
  perArc: 700,       // particles streaming along ONE arc
  // Generated at FULL length. Only `spanIdle` of each arc shows at rest; the
  // orchestrator thinking level opens it to all of it: while thinking, each
  // arc reads about twice as long and moves about twice as fast. Baking the
  // long version
  // and revealing more of it means no geometry changes at run time.
  arcMin: 1.4, arcMax: 3.8,   // radians of the ring an arc spans, at FULL length
  spanIdle: 0.5,     // fraction of an arc visible when nothing is thinking
  // Apparent speed doubles two ways, and NEITHER is a rate change. The draw
  // head crosses twice the distance in the same drawS, so it is twice as
  // fast for free; and each dart carries twice as far at the SAME dartRate.
  // Scaling dartRate instead would be rate x time with a moving rate — the
  // teleport defect exists for. Distance is safe; rate is not.
  dartThink: 2.0,
  // Lightning. Every step deviates a little; occasionally it KINKS hard. The
  // kink is the whole character — a smooth wander reads as a wobbly ring, not
  // as a bolt.
  // Measured, not guessed. A step along the arc is ~0.016 units, so the two
  // deviations have to be sized against THAT. A per-step jitter of 0.020 --
  // larger than the step itself -- makes every point a random walk: median
  // turn angle 59 degrees. That is static, not lightning.
  //
  // Lightning is straight runs punctuated by hard sideways jags. So the wander
  // is a damped VELOCITY (tiny, giving nearly straight runs) and the kink is a
  // POSITIONAL jag (large, giving a real corner the path then continues from).
  // Resulting turn angles: median 1.4 deg, p90 17 deg, p99 65 deg, 8% of steps
  // over 45 deg. The harness pins that distribution.
  jitter: 0.0004,    // damped wander velocity — keeps runs straight
  damp: 0.9,
  kinkChance: 0.06,  // how often a step jags instead
  kink: 0.030,       // how far a jag throws it — ~2x the step, so a hard corner
  seed: 11,
  // REPOSITIONED EVERY FIRING. The arc SET is fixed and seeded, so without
  // this the same 28 shapes recur in the same 28 places and the eye learns
  // them fast, and the set reads as repetitive. Each cycle an arc is rotated
  // to a fresh orientation,
  // hashed from (arc, cycle), which turns 28 fixed shapes into effectively
  // unlimited placements for the cost of two sin/cos in the shader. A
  // rotation preserves radius, so the shell bounds still hold exactly.
  reorient: true,
  // The arcs ride the ripple too. Without this the body pulsed under a ring
  // while the lightning around it stayed rigid, which reads as two unrelated
  // things sharing a panel. A ring passing
  // under an arc sweeps it outward and brightens it, so the bolt belongs
  // to the same body the ring is crossing.
  // Scaled against the SAME beat peak of 0.13, not against 1 — see the note
  // on LOOKS.shell. 1.2 x 0.13 = 0.156 units of sweep on the arcs.
  ripple: 3.0,       // radial displacement per unit ring amplitude — walkable: MCS.setArcRipple()
  rippleGlow: 1.4,   // brightening at the front, on top of the body's own
  ringFlare: 0.75,   // how brightly a passing ring REVEALS an arc its own cycle has dark
  // What one full ring counts as. It used to be 0.08 with a hard clamp at 1,
  // which SATURATED on a single ask ring (peak 0.13) — so while one ring was
  // crossing, a second could add nothing at all and the arcs read as
  // unresponsive while they cooled down from the first one. Referenced to
  // the real
  // single-ring peak now, and allowed above 1, so overlapping rings stack.
  ringRef: 0.13,
  ringMax: 2.2,      // headroom for overlaps; a hard 1.0 is what hid them
  // Motion of the STREAM itself. Particles dart along the spine on a recycling
  // sawtooth, eased so they leave fast and arrive slow — that deceleration is
  // the "weight"/inertia, and it is what a constant-velocity slide lacks.
  dartLen: 0.075,    // how far along the spine one dart carries, in units
  dartRate: 1.9,     // darts per second
  dartEase: 3.0,     // higher = more front-loaded, so more of a lunge
  // Crackle: lateral scatter, strongest mid-dart, so the stream frays where it
  // is moving fastest and settles where it lands. This is the "bouncing almost
  // like static" part.
  scatter: 0.022,
  scatterRate: 19.0,
  // The arc's own lifecycle: draws fast, holds while flickering, then decays.
  periodS: 2.6, drawS: 0.28, holdS: 0.5,
  headLen: 0.10,     // the bright leading edge, in s
  tail: 0.55,        // how much of the drawn part stays lit behind the head
  crackle: 0.5,      // per-frame flicker depth along a live arc
  // Brightness, as a 0..1 curve where 1.0 IS the target on-screen alpha. A
  // fade MULTIPLIER that looks reasonable is not evidence: what matters is the
  // final on-screen alpha, which is what scribbleOnScreen computes.
  targetAlpha: 0.95,
  grain: 1.0,        // "as fine as the main shell", whose grain is ~1.2
}

/** The arcs, as polylines. Deterministic (mulberry32 on SCRIBBLE.seed) so the
 *  set is the same every session; which arc is LIVE at any moment is what
 *  varies, and that happens in the shader.
 *
 *  Each arc walks around its ring plane, stepping in the ring's tangent
 *  direction while deviating along the plane's normal and in radius. Pure, so
 *  the harness can assert the lightning character rather than anyone
 *  squinting at it: that arcs stay in the shell, that they actually kink, and
 *  that they are not secretly circles. */
export const scribblePaths = ({
  rings = SCRIBBLE.rings, perRing = SCRIBBLE.perRing, points = SCRIBBLE.spine,
  seed = SCRIBBLE.seed, rMin = SCRIBBLE.rMin, rMax = SCRIBBLE.rMax,
} = {}) => {
  const rng = mulberry32(seed)
  const out = []
  const GOLD = Math.PI * (3 - Math.sqrt(5))
  for (let r = 0; r < rings; r++) {
    // A plane per ring: tilt by inclination, then spin the node line. Spread
    // by the golden angle so no two planes sit near each other.
    const inc = (r / Math.max(1, rings - 1)) * 1.4 - 0.7
    const raan = r * GOLD
    const ci = Math.cos(inc), si = Math.sin(inc)
    const cr = Math.cos(raan), sr = Math.sin(raan)
    // Basis of the ring plane, and its normal.
    const U = [cr, 0, -sr]
    const V = [sr * si, ci, cr * si]
    const N = [sr * ci, -si, cr * ci]
    for (let a = 0; a < perRing; a++) {
      const span = SCRIBBLE.arcMin + rng() * (SCRIBBLE.arcMax - SCRIBBLE.arcMin)
      const th0 = rng() * Math.PI * 2
      let rad = rMin + rng() * (rMax - rMin)
      let off = 0, offV = 0, radV = 0    // drift along the plane normal, and its velocity
      const pts = []
      for (let i = 0; i < points; i++) {
        const t = i / (points - 1)
        const th = th0 + span * t
        // Wander: a damped velocity, so the path runs nearly straight between
        // events rather than jittering every step.
        offV = offV * SCRIBBLE.damp + (rng() * 2 - 1) * SCRIBBLE.jitter
        radV = radV * SCRIBBLE.damp + (rng() * 2 - 1) * SCRIBBLE.jitter
        off += offV
        rad += radV
        // Jag: an instantaneous sideways step. This is the bolt — the path
        // corners hard and then carries on from where it landed.
        if (rng() < SCRIBBLE.kinkChance) {
          off += (rng() * 2 - 1) * SCRIBBLE.kink
          rad += (rng() * 2 - 1) * SCRIBBLE.kink
        }
        rad = Math.min(rMax, Math.max(rMin, rad))
        off = Math.min(0.16, Math.max(-0.16, off))
        const c = Math.cos(th), s = Math.sin(th)
        pts.push([
          (U[0] * c + V[0] * s) * rad + N[0] * off,
          (U[1] * c + V[1] * s) * rad + N[1] * off,
          (U[2] * c + V[2] * s) * rad + N[2] * off,
        ])
      }
      out.push(pts)
    }
  }
  return out
}

/** What a scribble point of brightness `bright` (0..1) reaches ON SCREEN once
 *  its own sampling density, the fade and the material's uAlpha are in. This
 *  is the number that matters: a per-point fade can look perfectly reasonable
 *  while the thing it scales renders at one and a half percent alpha. */
export const scribbleOnScreen = (bright, {
  dpr = 2, panelCss = 260, pointScale = 5.0, camZ = CAMERA_Z, fovDeg = CAMERA_FOV_DEG, uAlpha = 0.34,
} = {}) => {
  const pxPerUnit = (panelCss * dpr / 2) / (camZ * Math.tan((fovDeg / 2) * Math.PI / 180))
  const arcPx = ((SCRIBBLE.arcMin + SCRIBBLE.arcMax) / 2) * ((SCRIBBLE.rMin + SCRIBBLE.rMax) / 2) * pxPerUnit
  const pointPx = SCRIBBLE.grain * (pointScale * dpr / camZ)
  const perPixel = (SCRIBBLE.perArc / Math.max(1, arcPx)) * pointPx
  return bright * scribbleFade({ dpr, panelCss, pointScale, camZ, fovDeg, uAlpha }) * perPixel * uAlpha
}
export const scribbleFade = ({
  dpr = 2, panelCss = 260, pointScale = 5.0, camZ = CAMERA_Z, fovDeg = CAMERA_FOV_DEG, uAlpha = 0.34,
} = {}) => {
  const pxPerUnit = (panelCss * dpr / 2) / (camZ * Math.tan((fovDeg / 2) * Math.PI / 180))
  const arcPx = ((SCRIBBLE.arcMin + SCRIBBLE.arcMax) / 2) * ((SCRIBBLE.rMin + SCRIBBLE.rMax) / 2) * pxPerUnit
  const pointPx = SCRIBBLE.grain * (pointScale * dpr / camZ)
  const perPixel = (SCRIBBLE.perArc / Math.max(1, arcPx)) * pointPx
  return SCRIBBLE.targetAlpha / Math.max(0.001, perPixel * uAlpha)
}

// --- Orchestrator thinking indicator -------------------
// The indicator that the orchestrator is thinking: the streams look as a
// whole glows brighter and spins faster while it is.
// `orchestrator.busy` (already a payload field on snapshot()
// and the SSE `orchestrator` frames -- no new signal needed) drives an eased
// 0..1 level; swarm.js reads that level through the two pure mappings below
// to scale the streams look's uGlow uniform and the spin passed into
// advance() above. Pure maths only in this file -- swarm.js owns `now`/`dt`
// and the actual uniform writes.

/** How many seconds the eased level takes to (mostly) catch up to a snapped
 *  on/off target: it has to transition in and out smoothly rather than
 *  snapping. ~3 time constants (1.8s) is a full, visible ramp either way. */
export const THINKING_EASE_TAU = 0.6

/** Exponential approach toward 0 or 1, the same shape moodRamp/actS already
 *  use elsewhere in this file -- one smoothing idiom, not a second one.
 *  Pure: swarm.js supplies `current` (its own kept state) and the frame's
 *  `dt`; at dt=0 this is the identity (returns `current` unchanged), so a
 *  paused/backgrounded tab resuming never jumps. */
export const easeThinking = (current, targetOn, dt) => {
  const target = targetOn ? 1 : 0
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dt) / THINKING_EASE_TAU))
}

// Bold on purpose -- see advance()'s own comment on why thinkMult is NOT
// routed through SPIN_MULT_SCALE's damping. Picked to read as an obvious,
// unambiguous "it's thinking now" at full level (level 1, i.e. busy for at
// least a couple of THINKING_EASE_TAU), never a subtle nudge.
// Raised 1.8 -> 3.4 / 3.2: at 1.8 a real turn produced no
// visible change in the sphere at all. 1.8x on a value that is already small
// reads as nothing once the
// eye has the whole panel to look at — this has to be unmistakable from
// across the room, which was the point of the indicator.
export const THINKING_GLOW_MULT = 3.4
export const THINKING_SPIN_MULT = 3.2

/** level 0 -> 1 (the identity, so an idle/never-asked relay renders exactly
 *  as it always has); level 1 -> the full multiplier above. Linear in level
 *  because `easeThinking` above already supplies the actual S-shaped-in-time
 *  approach -- a second easing curve here would just be double smoothing. */
export const thinkingGlowMult = (level) => 1 + (THINKING_GLOW_MULT - 1) * Math.max(0, Math.min(1, level))
export const thinkingSpinMult = (level) => 1 + (THINKING_SPIN_MULT - 1) * Math.max(0, Math.min(1, level))

/** The streams transport, exactly as shipped in swarm.js's STREAMS_MAIN
 *  chunk: a lane-scaled differential
 *  rotation about FLOW_AXIS with a bounded travelling shear, then a slow
 *  precession. No capture — crest capture needs `snoised`, so it is not in
 * this twin ("how to check it": the twin's numbers are a lower bound
 *  on coherence and an upper bound on speed, since capture only REMOVES
 *  cross-channel motion). */
export function transportStreams(home, seed, ang, p) {
  const h = (seed * 73.17) % 1
  const lane = Math.floor(h * 6) / 5
  const factor = 1.2 - 0.5 * lane
  const s = dot3(home, FLOW_AXIS)
  const shear = p.shear * Math.sin(ang.time * SHEAR_RATE + s * 3.0) * Math.cos(BANDS * Math.PI * s)
  return rot3(rot3(home, FLOW_AXIS, ang.orbit * factor + shear), PREC_AXIS, ang.prec)
}

/** The Fibonacci-sphere scatter, extracted so the streams harness uses the
 *  PANE'S OWN home math rather than a
 *  re-derivation that could quietly drift from buildGeometry()'s. Same
 *  golden-angle formula swarm.js's buildGeometry() has always used inline
 *  for the body block; swarm.js's own body/session geometry is untouched —
 *  this is additive, used by the new streams geometry and the harness only. */
export function fibonacciHomes(n) {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const out = new Array(n)
  for (let k = 0; k < n; k++) {
    const y = 1 - (k / Math.max(1, n - 1)) * 2
    const rad = Math.sqrt(Math.max(0, 1 - y * y))
    const th = golden * k
    out[k] = [Math.cos(th) * rad, y, Math.sin(th) * rad]
  }
  return out
}

/** Deterministic PRNG (mulberry32). aSeed comes from a seeded PRNG here,
 *  never Math.random, or the coherence bins (the
 *  tightest of the seven assertions) flake run to run. Not used by
 *  production geometry (which keeps Math.random(), same as buildGeometry()
 *  always has — production has no determinism requirement); this is for the
 *  harness's own particle set. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// --- Ripples — the reactive layer ------------------------------------------
// Pointer movement is not a ripple trigger at all: a ripple belongs to a
// triggering event, to thinking harder, or to the multiplier of several
// agents thinking at once. There is no stationary spot following the cursor
// and no "wake" ring on fast movement — the pointer(), RIPPLE.spot and
// RIPPLE.wake machinery is removed, not merely disabled. The pointer's LEAN
// (swarm.js's `pull`) is unrelated and untouched.
//
// Rarity alone is not enough, because the failure is a timescale mismatch
// rather than a frequency one: a 220ms two-beat snap on a body drifting at
// tens of px/s reads as a glitch stapled onto a calm scene, no matter how
// rarely it fires. So, on top of that restriction:
//   - ONE ring per heartbeat, not two 220ms apart: a single slow swell,
//     rather than a re-tuned gap that was never the right shape at this
//     body's tempo.
//   - life 1.4s -> 4.0s and front speed 2.8 -> 0.5 rad/s: the front now
//     travels ~2 radians over ~4 seconds — comparable to the idle transport
//     rate (~0.43 rad/s, see meanSpeedPx's own [30,60]px/s/105px-per-rad
//     idle band), not ~6x it. rippleEnvelope's shape is unchanged (it is
//     parameterised by AGE AS A FRACTION of life, not by seconds), so
//     widening life alone widens the attack/decay in real time — an 84ms
//     attack becomes a 240ms one — without touching the proof that recovery
//     is exact at age>=1.
//   - sigma 0.22 -> 0.5 rad: a broad, gentle front rather than a thin line,
//     with less snap to it.
//   - ordinary tool-call pulses do NOT ripple the field at all, for any
//     look: rippling is for genuinely rare events only, and the heartbeat is
//     perhaps the only one there is. A tool-call pulse keeps its existing
//     subtle shockwave instead. toolPulse()
//     and the 'pulse' preset are removed; shell's own pre-existing radial
//     shove (swarm.js, gated on mode==='shell') is what tool calls still
//     drive, exactly as it did before this reactive layer existed —
//     untouched by it.
//   - HEART_REFRACTORY_S 2.5s -> 5.0s, now longer than the ring's own 4.0s
//     life, so a new heartbeat can never overlap (and abruptly cut off) a
//     still-fading one — every ripple fully settles before the next can
//     begin. Heartbeat itself remains the ONLY trigger, and it is already
//     rare BY CONSTRUCTION (edge-triggered on the whole fleet's idle->
//     working transition, not a periodic tick) — the refractory is a floor
//     under that, not the thing making it rare.
export const RIPPLE_SLOTS = 6            // slot 0 heartbeat · slot 1 ask · 2-5 unused (reserved)
export const RIPPLE = {
  heart: { bend: 0.08, kick: 0.30, sigma: 0.5, speed: 0.5, life: 4.0 },
  // The orchestrator ask: a ripple on receiving the message,
  // larger than the normal ripple and slower to cross. Bigger
  // in all three amplitude terms than `heart` and markedly slower to cross,
  // so it reads as a distinct, deliberate event rather than a strong
  // heartbeat. bend stays under NO_FOLD * sigma (0.13 < 0.6*0.72 = 0.432).
  // Two separate defects were tuned out of this preset, in order.
  //
  // 1. It never finished. speed 0.28 x life 7 s reaches 1.96 rad — 62% of the
  //    PI-radian sweep from front to back — so the ring expires mid-crossing
  //    every time, reading as something slow that never arrives.
  // 2. It got STUCK HALF WAY. Once the front passes PI it has left the
  //    sphere, but `th` cannot exceed PI, so the gaussian TAIL parks on the
  //    far pole and fades there. The near half is back to normal while the
  //    far half is still bulged, so the sphere sits in a half-reformed state
  //    instead of recovering — 1.2 s of it at speed 0.55.
  //
  // The cure for (2) is to have the amplitude envelope reach zero at about
  // the moment the front clears the sphere, which means life ~ PI/speed
  // rather than comfortably more than it. speed 0.8 / life 4.2: crosses in
  // 3.9 s, reaches 3.36 rad, and the far-pole tail is down to 0.2 s.
  ask: { bend: 0.13, kick: 0.50, sigma: 0.72, speed: 0.8, life: 4.2 },
}
/** Looks whose BODY carries the shell-style pulse — the occasional shove that
 *  is not the field ripple. It was keyed on the literal string 'shell' in four
 *  places, so every look forked FROM shell silently lost the core sphere's
 *  occasional pulse, with nothing to say it had gone.
 *  A list, so a new shell-family look opts in by name once instead
 *  of by matching a string scattered through the frame loop. */
export const BODY_PULSE_LOOKS = ['shell', 'shell v2']
export const usesBodyPulse = (mode) => BODY_PULSE_LOOKS.includes(mode)

export const ASK_RIPPLE_SLOT = 1
export const HEART_REFRACTORY_S = 5.0
// No-fold bound: bend < NO_FOLD * sigma, or channels displaced by different
// amounts within one front cross and the pattern folds. Wavelet's maximum
// slope is sqrt(e) (checked numerically), so the
// exact bound is bend < 0.6065*sigma; NO_FOLD stays a hair under it.
export const NO_FOLD = 0.6

/** Exactly 0 at age >= 1 — the recovery guarantee lives in this one line.
 *  `1 - smooth(0.35, 1, 1)` is not approximately zero, it IS zero: smooth()
 *  clamps its `t` to [0,1], so at x=1, t=1 and t*t*(3-2*t) = 1 exactly. */
export const rippleEnvelope = (a) => smooth(0, 0.06, a) * (1 - smooth(0.35, 1, a))
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }

export const makeRipples = () => ({
  rings: [],                              // { born, preset, strength, centre (unit vec, look-agnostic frame), slot }
  lastHeart: -Infinity,
})

/** The heartbeat: ONE slow ring from the view axis, refractory. Returns
 *  whether it actually fired (false inside the refractory window) — callers
 *  use this to gate a mode-specific secondary reaction (shell's own shove)
 *  off the SAME clock, rather than keeping a second refractory timer that
 *  could drift out of sync with this one. `strength` (the concurrency
 *  multiplier, capped by the caller — see swarm.js's
 *  INTENSITY_MULT_CAP) scales how PRONOUNCED the swell is; the refractory
 *  itself is fixed — concurrency is never allowed to raise the RATE, only
 *  the strength (see sessionRippleMultiplier's own comment for why). */
export function heartbeat(R, now, strength = 1) {
  if (now - R.lastHeart < HEART_REFRACTORY_S) return false
  R.lastHeart = now
  spawnRing(R, now, 'heart', strength, [0, 0, 1], 0)
  return true
}

/** The orchestrator's "message received" swell. Deliberately NOT refractory
 *  and on its own slot: it is edge-triggered by a human pressing Enter, which
 *  is already rare and is always worth acknowledging — the heartbeat's 5s
 *  floor exists to stop a fleet of sessions ringing the sphere continuously,
 *  which is a different problem. Its own slot means it can overlap a
 *  heartbeat rather than evicting one. */
export function askRipple(R, now, strength = 1) {
  spawnRing(R, now, 'ask', strength, [0, 0, 1], ASK_RIPPLE_SLOT)
  return true
}

// The thinking tint: fade to red while thinking, and fade back
// to normal once the response is finished.
// Mixed in OKLab, the space the mood ramp already lives in, so the blend
// stays perceptually even instead of darkening through the middle the way an
// sRGB lerp toward red does.
export const THINKING_RED = [0.6280, 0.2249, 0.1258]   // sRGB #ff0000 in OKLab
export const THINKING_TINT_MAX = 0.8                   // how far toward red at full thinking

export const thinkingTint = (lab, level) => {
  const k = THINKING_TINT_MAX * Math.max(0, Math.min(1, level))
  return [
    lab[0] + (THINKING_RED[0] - lab[0]) * k,
    lab[1] + (THINKING_RED[1] - lab[1]) * k,
    lab[2] + (THINKING_RED[2] - lab[2]) * k,
  ]
}

function spawnRing(R, born, preset, strength, centre, slot) {
  R.rings = R.rings.filter((r) => r.slot !== slot)
  R.rings.push({ born, preset, strength, centre, slot })
}

// Concurrency multiplier — the body ripples
// on a triggering event, on thinking harder, and on more sessions thinking at
// once, with every ripple carrying the same multiplier rule. Scaling the
// RATE rather than the strength ripples far too often at even three
// sessions, so the rule is to scale strength and to cap the rate regardless
// of session count. So this multiplier touches
// STRENGTH
// ONLY — heartbeat's own refractory (HEART_REFRACTORY_S) is a fixed
// constant, never divided by this — concurrency can make a beat bigger, and
// (via swarm.js's streams spin) can make the whole sphere turn a little
// faster, but it can never make a beat happen sooner. `count` is the number
// of sessions swarm.js finds genuinelyWorking this frame — not clamped to
// MAX_SESSIONS, since the multiplier should keep responding past the 8
// sessions the shell actually draws satellite dots for.
//
// log2, not linear: the first session-to-a-few jump is the steepest part of
// the curve (so "four is obviously more than one" reads at a glance without
// needing a huge count), and it never flattens — log2(1+count) keeps
// climbing at any count, so no two counts ever produce the exact same
// multiplier ("three and eight must not look identical"). RIPPLE_MULT_SCALE
// is picked so mult(12) lands just under 2.0 — the ceiling
// INTENSITY_MULT_CAP below actually uses (see swarm.js) — so the intensity
// channel is still visibly climbing, not flat, across the whole 1-12 range
// this task verifies; only far beyond that does it approach the ceiling.
export const RIPPLE_MULT_SCALE = 0.27
export const sessionRippleMultiplier = (count) =>
  1 + RIPPLE_MULT_SCALE * Math.log2(1 + Math.max(0, count))

/** Fills the two uniform-row arrays (Float32Array(4) x RIPPLE_SLOTS each).
 *  `toField` maps a world/view-frame unit vector into the look's own field
 *  frame (streams: un-precess, un-drift; iris and the harness twin: the
 *  identity). Expired rings are dropped here, after their envelope hit
 *  exactly zero — nothing is left to relax. Slot 5 is currently always left
 *  zero (see RIPPLE_SLOTS' own comment — it held the pointer spot, which no
 *  longer ripples). Returns the current heartbeat amplitude (max envelope
 *  over any live heartN ring), unused today — no `uPupil` exists on the
 *  shipped iris shader to twitch — but kept as a return value for a future
 *  consumer. */
export function rippleRows(R, now, toField, A, B) {
  for (let i = 0; i < RIPPLE_SLOTS; i++) { A[i].fill(0); B[i].fill(0) }
  R.rings = R.rings.filter((r) => now - r.born < RIPPLE[r.preset].life)
  for (const r of R.rings) {
    const P = RIPPLE[r.preset], age = Math.max(0, (now - r.born) / P.life)
    const env = rippleEnvelope(age) * r.strength
    if (env <= 0) continue
    const c = toField(r.centre)
    A[r.slot][0] = c[0]; A[r.slot][1] = c[1]; A[r.slot][2] = c[2]; A[r.slot][3] = P.speed * (now - r.born)
    B[r.slot][0] = P.bend * env; B[r.slot][1] = P.kick * env; B[r.slot][2] = P.sigma; B[r.slot][3] = 0
  }
  return R.rings.filter((r) => r.preset.startsWith('heart')).reduce((m, r) => Math.max(m, rippleEnvelope((now - r.born) / RIPPLE[r.preset].life) * r.strength), 0)
}

/** The twin's kernel — the exact closed form of the shader's `ripples()`
 * bend, for the captured-grain proxy: `transport(...)` then this.
 *  n and every row's centre are in the same frame. Bit-for-bit identity
 *  when every slot is zero (the common "off" case, and what the harness's
 *  own kernel-property check asserts) — an early return, not a
 *  normalize-of-an-already-unit-vector round trip, which is what makes the
 *  identity exact rather than merely close. */
export function rippleBend(n, A, B) {
  let dx = 0, dy = 0, dz = 0, any = false
  for (let i = 0; i < RIPPLE_SLOTS; i++) {
    if (B[i][0] === 0 && B[i][1] === 0) continue
    const c = A[i], cd = Math.max(-1, Math.min(1, dot3(n, c))), th = Math.acos(cd)
    let ax = n[0] * cd - c[0], ay = n[1] * cd - c[1], az = n[2] * cd - c[2]
    const al = Math.hypot(ax, ay, az)
    if (al < 1e-5) continue
    ax /= al; ay /= al; az /= al
    const sg = Math.max(B[i][2], 1e-3), u = (th - A[i][3]) / sg, g = Math.exp(-0.5 * u * u)
    const bend = B[i][3] < 0.5 ? u * g * 1.6487213 : g
    const amp = B[i][0] * bend
    if (amp === 0) continue
    dx += ax * amp; dy += ay * amp; dz += az * amp; any = true
  }
  if (!any) return n
  return norm3([n[0] + dx, n[1] + dy, n[2] + dz])
}

/** Speed, straightness, heading changes and screen-neighbour coherence over
 *  a sampled window — the harness twin for the motion target table. Pure; it
 *  takes the transport function and parameter table as arguments so it
 *  asserts against whatever `LOOKS.streams.p` actually is, never a
 *  hand-copied table.
 *
 *  Methodology notes (there is no reference implementation to match byte for
 *  byte, so this is a faithful, documented-from-scratch measurement, not a
 *  transcription):
 *   - Screen projection is orthographic along +z at `pxPerRad` px/unit,
 *     matching the pane's own scale -- a 210px disc, ~105px/rad at the
 *     centre -- and its camera looking down +z at a unit sphere.
 *   - "At the disc centre" (speed, path/net, turns, AND coherence — see
 *     below) is a view-axis cone of half-angle `centreDeg`: outside it, a
 *     smoothly orbiting point crosses the limb, where projected 2D speed
 *     passes through zero and "heading" is briefly undefined — a real
 *     projection effect of watching circular motion edge-on, not a turn or
 *     a slowdown in the underlying transport.
 *   - `minLegPx` is a floor on a leg's screen length before its direction
 *     counts toward a turn or a coherence pair: below it there is no
 *     perceptible heading to turn away from or correlate. Neither guard can
 *     manufacture a turn or inflate coherence that was not already there —
 *     both only refuse to score noise (near-zero-speed jitter) as signal.
 *   - "Radial share" is motion along the particle's OWN sphere-local radial
 *     direction (toward/away from the shell's centre — visually, toward or
 *     away from the viewer, off the shell's surface), not screen depth: a
 *     rotation is exactly tangent to the sphere (dot(v, p) == 0 in closed
 *     form), so this measures the twin's own finite-difference discretiza-
 *     tion error, which is genuinely tiny — see the harness for the algebra.
 *   - Coherence is pooled over several frames in the window and restricted
 *     to the SAME `centreDeg` centre cone as speed/path/turns — **not** the
 *     whole front hemisphere. This was a real bug, not a style choice:
 *     pairing across the whole hemisphere
 *     let limb grains into the sample, and `minLegPx` admits or excludes
 *     those limb grains DIFFERENTLY depending on orbit rate (their small
 *     foreshortened screen speed sits below the floor when slow, above it
 *     when fast) — so raising the orbit rate silently changed WHICH grains
 *     the coherence figure was measuring, not just how fast they moved.
 *     Proven by controlled experiment: forcing every lane factor to 1.0
 *     (removing the six-lane spread entirely) reproduced the exact same
 *     coherence13 drop with orbit rate, which is impossible if lane spread
 *     were the cause, since a lane changes a grain's SPEED, never its
 *     DIRECTION, and coherence is direction agreement — a lane-spread
 *     ceiling on coherence was never physically possible. The real cause is
 *     that 13 screen px at the limb is a large arc on the sphere, so those
 *     pairs genuinely disagree, and they were 35% of the 13px sample at
 *     orbit x1 and 49% at x2.5+. Cone-restricting is the smaller of two
 *     defensible fixes (the other being to bin pairs by angular distance on
 *     the sphere instead of screen distance) — chosen because it reuses the
 *     `centreDeg` cone speed/path/turns already apply, rather than adding a
 *     second, differently-shaped notion of "nearby." Do not revert this to
 *     whole-hemisphere pairing for the full
 *     numeric reproduction (0.886/0.879/0.893 at orbit x2.5 across
 *     as-shipped / lanes-forced-to-1.0 / shear-zeroed, all three well below
 *     the 0.90 bound, PROVING the sample was the bug, not the transport).
 *
 *  Sample the returned window at a random offset into a long run, not from
 *  t=0 — the caller advances `ang` before
 *  calling, or passes `offsetRng`/`offsetSpan` to do it here.
 *
 * The window itself is NOT a fixed 7 seconds.
 *  At the shipped idle orbit rate a 7s window sweeps close to a half-turn of
 *  the sphere, where arc/chord approaches pi/2 (~1.57) from pure geometry —
 *  regardless of how straight the path actually is — so `pathOverNet`
 *  cannot pass at any reasonable bound; at the busy rate no grain stays
 *  inside the centre cone for the full 7s at all, so it returns NaN. The
 *  fix is not a bigger cone or a looser bound, it is a shorter window:
 *  `WINDOW_REF_SECONDS` (~2s) at the idle orbit rate, scaled down as the
 *  orbit rate rises so the window's angular sweep — and so its NaN risk and
 *  its arc/chord geometry — stays roughly constant across activity levels,
 *  rather than being hand-tuned per level. Pass `seconds` explicitly to
 *  override this (existing callers that already pass a fixed window keep
 *  their own value). */
const WINDOW_REF_SECONDS = 2
const STEP_REF_SECONDS = 0.1

export function motionMetrics(transport, p, {
  n = 6000, seconds, step, pxPerRad = 105, wrap = TAU * 10, act = 0,
  centreDeg = 40, minLegPx = 0.4, seedRng = 1, offsetRng = 1, offsetSpan = 600,
  // Reactive layer — an optional
  // ripple schedule, deterministic because it is an INPUT to the twin and
  // the kernel has no noise in it. `events` is `[{ at, kind: 'heartbeat',
  // strength? }]` on the simulated-time axis (t=0 at the first sampled
  // frame, after warm-up — the same axis `windows` below uses) — 'pulse' is
  // no longer a kind: ordinary tool-call pulses do not ripple the field at
  // all (see the RIPPLE table's own comment).
  // `windows` is
  // `{ name: [startSec, endSec] }`; when given, every metric is computed
  // independently over each named sub-range of the ONE trajectory computed
  // below and the return becomes `{ [name]: {...}, windowSeconds, t0 }`
  // instead of a flat object. Both default to "off", which is what keeps
  // this an addition: with no events, every ripple row stays zero for the
  // whole run, `rippleBend` takes its identity fast path for every particle
  // at every step (see its own doc comment), and the computed trajectory —
  // so every existing steady-state assertion — is unchanged.
  events = [], windows = null,
  // LIFT — see this option's own doc comment
  // further down, at its first use.
  liftPh = null,
  // SESSION — optional, off by default. `sessions` is
  // [{ s, heat }]: claimed band centres in lattice-frame s, with their heat
  // weight (the claim weight is taken as 1, since a fading claim is not what
  // these assertions are about). With `sessions: null` the lift line below is
  // the identity, so every pre-existing measurement is untouched.
  sessions = null,
} = {}) {
  const homes = fibonacciHomes(n)
  const rng = mulberry32(seedRng)
  const seeds = homes.map(() => rng())

  // Window AND step — see this function's own doc comment for the window
  // half. The step (the sampling dt used for every finite-difference velocity
  // estimate below, including radialShare's) needs the SAME treatment: radial
  // share is, by construction, the twin's own forward-difference error — for
  // a pure rotation by angle theta over one step, that error is `~theta/2`
  // (a first-order Taylor fact: the chord from p(t) dips toward the centre
  // relative to the true tangent by half the angle swept) — so it grows
  // LINEARLY with the angle swept per step, which grows with orbit rate at a
  // fixed dt. At the old, slow orbit rates this was "genuinely tiny"
  // (radialShare ~0.004-0.009); at the busy rate this task ships it is not
  // (~0.054 at dt=0.1s, ABOVE the <0.05 bound) — not because particles
  // actually move off the shell (the closed-form rotation is exactly
  // tangent, dot(v,p)==0), but because dt=0.1s is too coarse a ruler for how
  // fast the shipped motion now is. Scaling `step` by the same
  // ORBIT_IDLE_MUL/orbitMul ratio as the window keeps the swept angle per
  // step — and so this artifact — roughly constant across activity levels
  // (confirmed: busy radialShare drops back to ~0.02, matching idle, once
  // dt shrinks with it), and as a side effect keeps `steps` (window/step,
  // the sample count) constant too, so the twin's resolution doesn't
  // secretly change per activity level either.
  const shapedAct = Math.sqrt(Math.max(0, Math.min(1, act)))
  const orbitMul = ORBIT_IDLE_MUL + (ORBIT_BUSY_MUL - ORBIT_IDLE_MUL) * shapedAct
  const speedScale = ORBIT_IDLE_MUL / Math.max(orbitMul, 1e-6)
  const windowSeconds = seconds ?? (WINDOW_REF_SECONDS * speedScale)
  const dt = step ?? (STEP_REF_SECONDS * speedScale)

  const t0 = mulberry32(offsetRng)() * offsetSpan
  let ang = freshAngles()
  const warm = Math.round(t0 / dt)
  for (let i = 0; i < warm; i++) ang = advance(ang, p, wrap, act, dt)

  const steps = Math.round(windowSeconds / dt)
  const screen = (pos) => [pos[0] * pxPerRad, pos[1] * pxPerRad]
  const cosCone = Math.cos(centreDeg * Math.PI / 180)

  // Ripple state, driven by `events` on the simulated-time axis (tSim = k*dt).
  // `identity` is the right toField here: the
  // heartbeat's centre is the view axis and this twin already works in the
  // view frame, so no frame conversion is needed.
  const R = makeRipples()
  let evI = 0
  const ripA = Array.from({ length: RIPPLE_SLOTS }, () => new Float32Array(4))
  const ripB = Array.from({ length: RIPPLE_SLOTS }, () => new Float32Array(4))
  const identity = (v) => v

  // LIFT — optional, off by default
  // (liftPh null) so every existing caller and every assertion measured
  // before this feature existed is byte-for-byte unaffected — the same
  // "off means identity" discipline `events`/`windows` above and
  // `rippleBend`'s own fast path already use. When a caller passes
  // `liftPh` (a length-6 phase array, `freshLift()`'s own shape), the
  // field is applied to EVERY particle at every step — the worst case, since
  // the shader lifts captured grains only. That upper-bounds what production
  // shows
  // since dust never lifts there (LIFT is gated by `vein` in the shader).
  // liftState advances via advanceLift exactly like every other angle
  // here — never rate*uTime (Rule A) — and is warmed up over the same
  // `warm` steps as `ang`, so it starts at a random point in its own
  // cycle rather than always at freshLift()'s fixed phase.
  let liftState = liftPh ? liftPh.slice() : null
  if (liftState) for (let i = 0; i < warm; i++) liftState = advanceLift(liftState, act, dt)

  const pos3 = Array.from({ length: n }, () => new Array(steps + 1))
  const scr = Array.from({ length: n }, () => new Array(steps + 1))
  let a = ang
  for (let k = 0; k <= steps; k++) {
    const tSim = k * dt
    while (evI < events.length && events[evI].at <= tSim) {
      const ev = events[evI]
      if (ev.kind === 'heartbeat') heartbeat(R, ev.at, ev.strength ?? 1)
      evI++
    }
    rippleRows(R, tSim, identity, ripA, ripB)
    for (let i = 0; i < n; i++) {
      const raw = transport(homes[i], seeds[i], a, p)
      // The captured-grain proxy: transport + the exact closed-form
      // bend. Capture itself needs `snoised`, which is exactly the kind of
      // noise reimplementation the stated testing limitation forbids, so it
      // is not twinned — the kick's effect on grains is bounded by preset
      // instead (harness's kernel-properties layer, below). rippleBend is
      // the identity whenever no ripple is live, by construction (its own
      // doc comment), so this line changes nothing for any `events: []`
      // caller — every existing steady-state assertion is unaffected.
      let pos = rippleBend(raw, ripA, ripB)
      if (liftState) {
        // The shader computes the lift on `nl`, the LATTICE-FRAME point —
        // pre-precession, de-drifted by uLatticeAngle — so the field
        // drifts with the crest lattice, not the world (hook point 2).
        // rot3/PREC_AXIS/FLOW_AXIS/AXIS_U/AXIS_V are this same file's own
        // exports; this is the exact inverse of swarm.js's own
        // `toStreamsField`, which converts a ripple centre INTO this frame.
        const nl = rot3(rot3(pos, PREC_AXIS, -a.prec), FLOW_AXIS, -a.drift)
        const s = dot3(nl, FLOW_AXIS)
        const phi = Math.atan2(dot3(nl, AXIS_V), dot3(nl, AXIS_U))
        const { lift, g } = liftField(s, phi, liftState)
        let L = lift
        // SESSION — identity when `sessions` is null, which is
        // every existing caller, so no steady-state assertion moves. A grain
        // whose lattice-frame latitude falls inside a claimed band gets
        // liftHeld instead of the ordinary lift, through the same soft window
        // the shader uses. Nearest band wins if two overlap.
        if (sessions) {
          let best = 0, wk = 0
          for (const b of sessions) {
            const w = 1 - smooth(SESSION.edge, SESSION.halfWidth, Math.abs(s - b.s))
            if (w > best) { best = w; wk = b.heat }
          }
          L = best * liftHeld(g, wk) + (1 - best) * lift
        }
        pos = [pos[0] * (1 + L), pos[1] * (1 + L), pos[2] * (1 + L)]
      }
      pos3[i][k] = pos
      scr[i][k] = screen(pos)
    }
    if (k < steps) {
      a = advance(a, p, wrap, act, dt)
      if (liftState) liftState = advanceLift(liftState, act, dt)
    }
  }

  // Every metric below, generalised to an arbitrary [kLo, kHi] sub-range of
  // the ONE trajectory computed above (: "the
  // position used for every metric becomes rippleBend(transport(...), A,
  // B)" — that substitution already happened above, once, for the whole
  // trajectory; this is only the windowing). Called once over the full
  // range when `windows` is not given — identical arithmetic to the
  // pre-reactive-layer version, just re-indexed by kLo/kHi instead of a
  // hardcoded 0/steps — and once per named window otherwise, so `during`
  // and `after` (or any other named range) each get their own reading of
  // the same underlying run rather than a separate, re-randomized one.
  function computeOver(kLo, kHi) {
    // Mean screen speed at the disc centre.
    let speedSum = 0, speedN = 0
    for (let i = 0; i < n; i++) for (let k = kLo; k < kHi; k++) {
      const midZ = (pos3[i][k][2] + pos3[i][k + 1][2]) / 2
      if (midZ < cosCone) continue
      speedSum += Math.hypot(scr[i][k + 1][0] - scr[i][k][0], scr[i][k + 1][1] - scr[i][k][1]) / dt
      speedN++
    }

    // Path length over net displacement, particles visible at both endpoints.
    let ratioSum = 0, ratioN = 0
    for (let i = 0; i < n; i++) {
      if (pos3[i][kLo][2] < cosCone || pos3[i][kHi][2] < cosCone) continue
      let path = 0
      for (let k = kLo; k < kHi; k++) path += Math.hypot(scr[i][k + 1][0] - scr[i][k][0], scr[i][k + 1][1] - scr[i][k][1])
      const net = Math.hypot(scr[i][kHi][0] - scr[i][kLo][0], scr[i][kHi][1] - scr[i][kLo][1])
      if (net < 1) continue
      ratioSum += path / net; ratioN++
    }

    // Heading changes > 45 degrees between consecutive steps.
    let turns = 0, turnParticles = 0
    const turnCos = Math.cos(45 * Math.PI / 180)
    for (let i = 0; i < n; i++) {
      if (pos3[i][kLo][2] < cosCone) continue
      turnParticles++
      for (let k = kLo + 1; k < kHi; k++) {
        if (pos3[i][k][2] < cosCone) continue
        const e1 = [scr[i][k][0] - scr[i][k - 1][0], scr[i][k][1] - scr[i][k - 1][1]]
        const e2 = [scr[i][k + 1][0] - scr[i][k][0], scr[i][k + 1][1] - scr[i][k][1]]
        const l1 = Math.hypot(e1[0], e1[1]), l2 = Math.hypot(e2[0], e2[1])
        if (l1 < minLegPx || l2 < minLegPx) continue
        const cosang = (e1[0] * e2[0] + e1[1] * e2[1]) / (l1 * l2)
        if (cosang < turnCos) turns++
      }
    }

    // Screen-neighbour velocity coherence, pooled over several frames within [kLo, kHi].
    function coherenceAt(dist, tolFrac, sampleFrames = 6) {
      let sum = 0, count = 0
      const tol = Math.max(0.6, dist * tolFrac)
      const cell = Math.max(dist + tol, 3)
      const span = kHi - kLo
      for (let f = 1; f <= sampleFrames; f++) {
        // cone-restricted, not "front
        // hemisphere" (pos3[i][k][2] <= 0). See this function's own doc
        // comment for why whole-hemisphere pairing was the actual bug.
        const k = Math.max(kLo + 1, Math.min(kHi - 1, kLo + Math.round(f * span / (sampleFrames + 1))))
        const idx = [], vel = new Map(), posAt = new Map()
        for (let i = 0; i < n; i++) {
          if (pos3[i][k][2] < cosCone) continue
          const v = [scr[i][k + 1][0] - scr[i][k - 1][0], scr[i][k + 1][1] - scr[i][k - 1][1]]
          if (Math.hypot(v[0], v[1]) < minLegPx * 2) continue // central-diff baseline is 2*dt
          idx.push(i); vel.set(i, v); posAt.set(i, scr[i][k])
        }
        const grid = new Map()
        const key = (gx, gy) => gx * 200000 + gy
        for (const i of idx) {
          const s = posAt.get(i)
          const gx = Math.floor(s[0] / cell), gy = Math.floor(s[1] / cell)
          const kk = key(gx, gy)
          if (!grid.has(kk)) grid.set(kk, [])
          grid.get(kk).push(i)
        }
        for (const i of idx) {
          const s = posAt.get(i)
          const gx = Math.floor(s[0] / cell), gy = Math.floor(s[1] / cell)
          for (let ddx = -1; ddx <= 1; ddx++) for (let ddy = -1; ddy <= 1; ddy++) {
            const bucket = grid.get(key(gx + ddx, gy + ddy))
            if (!bucket) continue
            for (const j of bucket) {
              if (j <= i) continue
              const sj = posAt.get(j)
              const d = Math.hypot(s[0] - sj[0], s[1] - sj[1])
              if (Math.abs(d - dist) > tol) continue
              const a1 = vel.get(i), a2 = vel.get(j)
              const l1 = Math.hypot(a1[0], a1[1]), l2 = Math.hypot(a2[0], a2[1])
              sum += (a1[0] * a2[0] + a1[1] * a2[1]) / (l1 * l2); count++
            }
          }
        }
      }
      return count ? sum / count : NaN
    }

    // Radial share: |dot(v, p)| / |v|, in 3D, against the particle's own
    // sphere-local position (see the methodology note above — this is exactly
    // 0 in closed form for a rotation; what is measured is the twin's own
    // finite-difference discretization error, genuinely tiny at this dt).
    let radSum = 0, radN = 0
    for (let i = 0; i < n; i++) for (let k = kLo; k < kHi; k++) {
      const v = [pos3[i][k + 1][0] - pos3[i][k][0], pos3[i][k + 1][1] - pos3[i][k][1], pos3[i][k + 1][2] - pos3[i][k][2]]
      const vlen = Math.hypot(v[0], v[1], v[2])
      if (vlen < 1e-8) continue
      radSum += Math.abs(dot3(v, pos3[i][k])) / vlen
      radN++
    }

    return {
      meanSpeedPx: speedSum / speedN,
      pathOverNet: ratioSum / ratioN,
      // Renamed from turnsPer7s — the window is
      // no longer a fixed 7s, so that name would lie about what is measured.
      // `Math.max(1, turnParticles)` used to mean an empty sample (cone
      // collapsed, turnParticles === 0) silently read as 0 turns — passing
      // every `assert.equal(..., 0)` check whether or not any particle was
      // actually sampled, unlike its siblings above (meanSpeedPx/
      // pathOverNet/coherence3), which all correctly return NaN and fail
      // loudly on an empty sample. This build already hit that collapse at
      // the busy rate — see the report. Divide by the raw
      // count so an empty sample reads as NaN like everything else here.
      turnsInWindow: turnParticles ? turns / turnParticles : NaN,
      coherence3: coherenceAt(3, 0.15),
      coherence13: coherenceAt(13, 0.2),
      coherence53: coherenceAt(53, 0.25),
      radialShare: radSum / radN,
    }
  }

  if (!windows) return { ...computeOver(0, steps), windowSeconds, t0 }

  const out = { windowSeconds, t0 }
  for (const [name, [ws, we]] of Object.entries(windows)) {
    const kLo = Math.max(0, Math.min(steps, Math.round(ws / dt)))
    const kHi = Math.max(kLo, Math.min(steps, Math.round(we / dt)))
    out[name] = computeOver(kLo, kHi)
  }
  return out
}

// --- Camera geometry — the panel's own viewing frustum ---------------------
// iris and shell (RADIUS_CLAMP_MAX's own pipeline —
// see below) were clipped against the panel edges. The camera is
// PerspectiveCamera(CAMERA_FOV_DEG, aspect, 0.1, 100) at z=CAMERA_Z; swarm.js
// imports these same two constants to build it (never hand-copies 45/3.2),
// so the frustum this module reasons about is the one the panel actually
// renders through — same discipline RADIUS_CLAMP_MIN/MAX already used below.
export const CAMERA_FOV_DEG = 45
export const CAMERA_Z = 3.2

// The largest radius, centred on the origin, that fits ENTIRELY inside the
// camera's vertical field of view: sin(halfFOV) * distance — NOT
// tan(halfFOV) * distance. The distinction is easy to get wrong and does not
// show up in a diff review: tan(halfFOV)*distance is the world-space
// half-height of the FLAT PLANE through the origin (z=0) alone; it is the
// right formula for a flat backdrop at that one depth, but the particles
// here fill a genuine 3D BALL around the origin, and points toward the
// camera (larger world z, i.e. SMALLER distance-to-camera) subtend a wider
// angle for the same radial offset than points at z=0 do — a closer plane
// has a narrower visible cross-section. The bound that actually keeps every
// point of a radius-R ball inside the FOV, regardless of which direction
// from the origin it sits in, is the standard "sphere as seen from a point"
// result: the horizon/silhouette of a radius-R sphere viewed from distance D
// subtends asin(R/D) — so the ball fits iff R <= D*sin(halfFOV). At
// CAMERA_Z=3.2, CAMERA_FOV_DEG=45: D*sin(22.5deg) ≈ 1.2246, about 8% tighter
// than the flawed D*tan(22.5deg) ≈ 1.3255 this first read as. Because
// softClampRadius() below clamps `length(p)` — a RADIAL distance from the
// origin, in every direction, not a z=0-plane coordinate — this sin-based
// bound is the one its guarantee actually needs to be correct in every
// direction, not only at the equator. This is a property of the VERTICAL
// field of view alone; camera.aspect — set from the panel's own
// box.width/box.height at every resize(), never a fixed literal — only ever
// WIDENS the horizontal frustum relative to this, never narrows the
// vertical one. The panel is measurably not square (CSS asks for
// aspect-ratio:1, but max-height:100% inside a shorter flex column can
// still produce a wider-than-tall box), so the
// vertical extent is the one that binds.
export const VISIBLE_HALF_HEIGHT = CAMERA_Z * Math.sin(CAMERA_FOV_DEG * Math.PI / 360)

// A point sprite has its own screen-space radius (gl_PointSize/2), so a
// particle CENTRE sitting exactly on the frustum edge still bleeds a few px
// past it — the worst case (aSize up to 1.5, uPointScale up to 5.0*dpr with
// dpr up to 2, at the closest plausible approach) works out to roughly
// 4.5 physical / 2.3 CSS px, ~0.023 world units at this panel's scale (a
// panel half-height of ~118 CSS px maps to VISIBLE_HALF_HEIGHT world
// units). But point-sprite bleed alone does not size SPRITE_MARGIN:
// softClampRadius's compression is asymptotic, so pushing its input far
// enough (a sustained pointer lean alone is enough on its own) drives the
// output arbitrarily close to whatever it compresses TOWARD — meaning
// compressing all the way to VISIBLE_HALF_HEIGHT itself leaves NO real
// margin at all in that limit, however small CAMERA_MARGIN makes the
// threshold below. So the asymptote itself — not just the threshold below
// it — has to sit strictly, meaningfully inside VISIBLE_HALF_HEIGHT:
// CONTAIN_CEILING is that asymptote, and softClampRadius (below) compresses
// toward IT, never toward VISIBLE_HALF_HEIGHT directly. 0.06 is roughly
// 2.5x the calculated point-sprite figure, and at that margin a sustained
// near-maximal pointer lean -- the worst case the lean can produce -- does
// not reach the panel's own border pixels in any of the three looks. The
// shipped value is lower than that: a grain is ~2-3 px, so a few hundredths
// of a unit is already more margin than it needs, and every extra hundredth
// only clips the bounding sphere the core pushes up to under the pointer.
export const SPRITE_MARGIN = 0.045
export const CONTAIN_CEILING = VISIBLE_HALF_HEIGHT - SPRITE_MARGIN

// Headroom below CONTAIN_CEILING, for the "first line of defense" clamp
// (RADIUS_CLAMP_MAX, below) to size itself against, so ordinary gather
// geometry sits well clear of the compression zone entirely (see
// RADIUS_CLAMP_MAX's own derivation) rather than riding its edge.
// Raised with SPRITE_MARGIN trimmed alongside it, "increase the
// bounding sphere the core pushes up to when mouse pointer moves? it gets
// clipped a bit too fast". Compression starts at 5.9% above unit radius now
// against 4.8%.
//
// That is LESS than was asked for, and the limit is not arbitrary:
// SAFE_RADIUS also sets maxBodyRadius, the largest body the clamp permits,
// and the orbiting clusters must fit BETWEEN that and the visible bound of
// 1.2246. Pushing the body's envelope further evicts them. The other half of
// the fix is the 33% pull-gain cut, which reduces how far the body travels
// in the first place.
export const CAMERA_MARGIN = 0.898
export const SAFE_RADIUS = CONTAIN_CEILING * CAMERA_MARGIN

// --- Body-particle radius envelope ----------------------------------------
// The vertex shader
// blends an advected particle's raw distance from origin with a near-unit
// "shell" term to get its final radius. Before that fix, that blend read
//   rad = mix(length(p), 1.0 + uThickness * (aSeed - 0.5), 0.72)
// with `length(p)` UNBOUNDED, because curl() (also in swarm.js's VERT) was
// never normalized — three Euler steps of it could push length(p) to
// several units, so the "Agent presence" panel rendered as a flat
// rectangular field of dust: a sphere ~4x too big for the 280px panel to
// show anything but its middle, not a missing sphere.
//
// The fix clamps length(p) to a sane band BEFORE the blend:
//   rad = mix(clamp(length(p), RADIUS_CLAMP_MIN, RADIUS_CLAMP_MAX),
//             1.0 + uThickness * (aSeed - 0.5), SHELL_BLEND)
//
// swarm.js imports these four constants and interpolates them directly into
// its VERT template literal (and uses SHELL_THICKNESS as uThickness's own
// default) — it does not hand-copy a second set of numbers — so this file
// and the actual GLSL source cannot silently drift apart. That is also what
// makes maxBodyRadius()/minBodyRadius() below a genuine guard rather than a
// GLSL reimplementation of the kind already declines to write for the
// curl-noise field: there is no noise in this formula. The clamp bounds
// length(p) before the blend runs, so the worst case is closed-form
// arithmetic over these constants alone — independent of uActivity, uFlow,
// uTime, or anything the noise computes, which is exactly the property that
// was missing (the panel-overflow bug got WORSE as activity rose, because
// dt — and so length(p) — scales with activity right up until this clamp).
//
// that property was never wrong, but
// RADIUS_CLAMP_MAX=2.0 was never CHECKED against the camera that has to
// display it — 2.0 world units is ~51% outside VISIBLE_HALF_HEIGHT (≈1.33).
// It went unnoticed because a low uFlow meant almost nothing reached the
// ceiling; uFlow has since risen (1.5 -> 2.4 -> 2.8), filling that range in.
// RADIUS_CLAMP_MAX is now DERIVED, not chosen: it is the largest ceiling for
// which maxBodyRadius() — the worst case at uRelief's documented ceiling —
// still lands strictly inside SAFE_RADIUS, solved from maxBodyRadius's own
// formula. A 0.98 headroom factor keeps it a hair under SAFE_RADIUS rather
// than exactly on it, so ordinary gather geometry never even reaches
// softClampRadius()'s compression zone (below) — that backstop is reserved
// for what THIS clamp cannot see: the pointer's lean, a pulse shockwave, a
// ripple's radial lift, and the concurrency multiplier on any of
// those, all of which land on `p` downstream of this blend.
export const RADIUS_CLAMP_MIN = 0.5
export const SHELL_THICKNESS = 0.10   // also uThickness's shipped default
export const SHELL_BLEND = 0.72       // weight on the shell term; GLSL mix()'s 3rd arg
// uRelief's documented tuning ceiling (swarm.js: "0-0.08"), applied to a
// captured particle AFTER the shell blend (`p *= 1.0 + vein * uRelief`,
// vein maxing at 1). Using the ceiling rather than the shipped default (0.04)
// makes the bound below true for the whole documented tuning range, not only
// today's setting.
export const MAX_RELIEF = 0.08
const RADIUS_CLAMP_HEADROOM = 0.98
export const RADIUS_CLAMP_MAX =
  ((SAFE_RADIUS * RADIUS_CLAMP_HEADROOM) / (1 + MAX_RELIEF) - SHELL_BLEND * (1 + SHELL_THICKNESS * 0.5)) / (1 - SHELL_BLEND)

/** The provable worst-case body-particle radius, in units of uRadius. A
 *  closed-form function of the constants above — not of the curl-noise
 *  field — because the clamp already bounds length(p) before this formula
 *  ever runs. Takes no uActivity/uFlow/uTime argument by construction: that
 *  absence IS the proof that the bound holds at any activity level,
 *  including uActivity 1.0 — the case that fixing only the static size
 *  leaves unbounded. */
export const maxBodyRadius = (relief = MAX_RELIEF) => {
  const shellHi = 1.0 + SHELL_THICKNESS * 0.5   // aSeed maxes at 1 -> (aSeed - 0.5) = 0.5
  const rad = (1 - SHELL_BLEND) * RADIUS_CLAMP_MAX + SHELL_BLEND * shellHi
  return rad * (1 + relief)
}

/** The floor, for the same reason: nothing upstream of the blend can push a
 *  body particle's radius below this either. */
export const minBodyRadius = () => {
  const shellLo = 1.0 - SHELL_THICKNESS * 0.5   // aSeed = 0 -> (aSeed - 0.5) = -0.5
  return (1 - SHELL_BLEND) * RADIUS_CLAMP_MIN + SHELL_BLEND * shellLo
}

// --- Final containment — the camera-derived backstop ---------------------
// RADIUS_CLAMP_MAX above bounds the GATHER pipeline alone — everything
// upstream of the shell blend. It says nothing about what happens to `p`
// AFTER that: the pointer's body lean, a pulse shockwave (shell's own radial
// shove), a ripple's `uRipLift * beat`, or the concurrency multiplier
// scaling any of those. Enumerating every one of those terms' worst case by
// hand is exactly the kind of bookkeeping that lets changing one term
// silently reintroduce the bug — so instead,
// softClampRadius() is the actual, unconditional guarantee, applied once, in
// both shaders, to the truly final `p`, right before gl_Position:
//   - identity below SAFE_RADIUS (nothing the gather pipeline itself
//     produces is ever touched — see RADIUS_CLAMP_MAX's own derivation);
//   - a smooth (tanh) compression above it, asymptotic toward
//     CONTAIN_CEILING — VISIBLE_HALF_HEIGHT minus SPRITE_MARGIN, not
//     VISIBLE_HALF_HEIGHT directly (see CONTAIN_CEILING's own comment for
//     why: the compression is asymptotic, so compressing all the way to the
//     camera's literal edge leaves no room at all for a point sprite's own
//     screen-space radius once `len` is pushed hard enough — the pointer's
//     sustained lean alone is enough — however small SAFE_RADIUS's own
//     margin is) — so distance from the origin can approach but can NEVER
//     reach, let alone exceed, CONTAIN_CEILING, which itself sits strictly
//     inside what the camera can actually show.
// tanh(x) < 1 for every finite x, so `threshold + span*tanh(...)` is
// strictly < ceiling always: a closed-form proof, not a tuned-to-look-right
// number. A soft knee (identity, THEN compression), not a hard
// min(len, ceiling): a hard clamp would pile every over-driven particle onto
// the exact same radius, reading as a flat wall; this eases them toward the
// boundary instead. Shell's heartbeat shove reaches past the panel on its
// own, and further again once the concurrency multiplier scales it, so it is
// the term this backstop is most often catching.
export const softClampRadius = (len, threshold = SAFE_RADIUS, ceiling = CONTAIN_CEILING) => {
  if (len <= threshold) return len
  const span = ceiling - threshold
  return threshold + span * Math.tanh((len - threshold) / span)
}

// --- Lift field — per-channel radial life -----------------------------
// The channels were too adherent to the spherical structure: they should ebb
// and flow individually, growing and sinking beyond the bounds of the overall
// sphere. A radial lift field in the lattice frame —
// six sine modes in (latitude `s`, longitude `phi`) about the flow axis,
// applied to CAPTURED grains only (vein, gated in the shader/twin caller) so
// dust never lifts and the orb stays the orb. Latitude wavenumbers spread
// 5-31 (one to three of the ~0.19 channel spacings, non-commensurate) is
// what decorrelates neighbouring channels — "individually," not a whole-shell
// breathing; integer longitude wavenumbers keep the field continuous across
// phi = ±pi and make a lifted channel rise in one to three arcs rather than
// as a whole ring. The quadratic map (see liftField below) is asymmetric:
// channels rise a little and sink a lot, into the body, where the occluder
// (swarm.js) hides them.
export const LIFT_MODES = [
  // [k_s, q_phi (integer), amplitude, rate rad/s] — amplitudes sum to 1.
  [ 9, 1, 0.22,  0.36],
  [14, 2, 0.20, -0.27],
  [19, 1, 0.18,  0.44],
  [24, 3, 0.14, -0.22],
  [ 5, 2, 0.14,  0.31],
  [31, 1, 0.12,  0.52],
]

// hard ceiling — checked against the REAL, imported camera constants
// above, not hand-typed arithmetic: `1 + uLiftOut + SHELL_THICKNESS/2 +
// MAX_RELIEF` must stay under VISIBLE_HALF_HEIGHT. A tan()-based
// VISIBLE_HALF_HEIGHT would be ~1.3255 (SAFE_RADIUS ~1.193), and against
// that a hand-picked uLiftOut of 0.10 clears the sum comfortably. The camera
// here uses the corrected, tighter sin()-based bound (see
// VISIBLE_HALF_HEIGHT's own comment above) — VISIBLE_HALF_HEIGHT ~1.2246,
// SAFE_RADIUS ~1.048 — and at 0.10 the sum is 1.23 > 1.2246, so it clips.
// So uLiftOut is DERIVED here, with headroom, the same discipline
// RADIUS_CLAMP_MAX/CONTAIN_CEILING/SAFE_RADIUS above already use, rather
// than a second hand-picked literal — a later camera change moves this
// too, instead of silently clipping again the way an unbounded
// RADIUS_CLAMP_MAX would. LIFT_OUT_HEADROOM 0.98 — the SAME headroom factor
// RADIUS_CLAMP_MAX above uses — takes as much of the real ceiling as the
// assertion allows: at headroom 0.85 the rise (out ~0.080) is too subtle to
// read as a rise at all.
// 0.98 leaves a thin but real, non-zero margin under the hard
// assertion (~0.0019 radii, ~0.15% of VISIBLE_HALF_HEIGHT) rather than
// riding the edge exactly — softClampRadius()'s tanh backstop is what
// actually guarantees no particle reaches the frustum regardless.
const LIFT_OUT_HEADROOM = 0.98
const LIFT_OUT_CEILING = VISIBLE_HALF_HEIGHT - SHELL_THICKNESS / 2 - MAX_RELIEF - 1
export const LIFT = {
  out: LIFT_OUT_CEILING * LIFT_OUT_HEADROOM,   // ~0.093 radii here
  inn: 0.30,                                    // unaffected by the camera ceiling
  sinkFade: 0.86,   // the default (occluder off): a sunken channel dims away below this radius
}

// The lift field's own longitude frame: a unit basis perpendicular to
// FLOW_AXIS. AXIS_U is an arbitrary but fixed choice of "longitude zero";
// AXIS_V completes a right-handed (AXIS_U, AXIS_V, FLOW_AXIS) frame so
// atan2(dot(n,AXIS_V), dot(n,AXIS_U)) is a well-defined longitude for any n.
export const AXIS_U = norm3(cross3(FLOW_AXIS, [0, 0, 1]))
export const AXIS_V = cross3(FLOW_AXIS, AXIS_U)

/** The lift's own phase state — six accumulated phases, one per mode,
 *  seeded apart (m*1.3) so the modes never start in lockstep. */
export const freshLift = () => LIFT_MODES.map((_, m) => m * 1.3)

/** Rule A: accumulate, wrap exactly — each phase enters its sine additively,
 *  never `rate * uTime`. `act` doubles every rate at full activity, the same
 *  thinking-speeds-it-up shape every other streams reaction uses. */
export const advanceLift = (ph, act, dt) => ph.map((p, m) => (p + LIFT_MODES[m][3] * (1 + act) * dt) % TAU)

/** The twin's lift field, exactly the shader's `liftField()` (CHUNK_LIFT,
 *  swarm.js): six sine modes summed into a raw field `g` in [-1, 1], then
 *  mapped through an asymmetric quadratic (`a*g + b*g*g`, `a` the mean of
 *  out/in, `b` the half-difference) so the field rises by at most `out` and
 *  sinks by at most `inn`. `s` is the sine of latitude about the flow axis
 *  (`dot(n, FLOW_AXIS)`, invariant under any rotation ABOUT that axis — the
 *  transport, shear and lattice drift all are, which is what makes a
 *  "channel" a fixed `s` band rather than something that has to be tracked);
 *  `phi` is the longitude, `atan2(dot(n,AXIS_V), dot(n,AXIS_U))`. Returns
 *  `g` alongside `lift`, exposed for the harness's field-only assertions
 *  (adjacent-channel correlation, the lag sweep, cross-band spread), which
 *  are properties of `g` alone and do not depend on `out`/`inn` at all. */
export function liftField(s, phi, ph) {
  const g = LIFT_MODES.reduce((acc, [ks, q, a], m) => acc + a * Math.sin(ks * s + q * phi + ph[m]), 0)
  const a = 0.5 * (LIFT.out + LIFT.inn), b = 0.5 * (LIFT.out - LIFT.inn)
  return { lift: a * g + b * g * g, g }
}

// --- Sessions in streams — a session claims a latitude band -------------
// A channel in streams is a fixed band of s = dot(n, FLOW_AXIS): see
// liftField's own comment for why s is invariant under every rotation about
// the flow axis, which the transport, the shear, the lanes and the lattice
// drift all are. A session claims one such band, and the crest matter
// flowing through it is "the session's channel". No attribute and no
// accumulated angle are needed — every grain already computes its own s.
//
// This is the correction that made the feature cheap. "A session claims a
// channel" sounds like owning matter; a channel is not a thing that
// persists, it is
// whatever matter is passing through a latitude right now. Claiming the
// LATITUDE is free, because s is conserved; claiming the matter would have
// needed identity, state and an attribute.
export const CHANNEL_SPACING = 0.19   // measured channel spacing in s

// Nine one-channel bands off the poles, in CLAIM order: the equator first (a
// great circle, so never mostly hidden), then two spacings out on each side
// so the first five each keep an unclaimed neighbour on both sides, then the
// gaps between. Contrast against a neighbour is the whole signal, so the
// early claims are spread rather than packed.
export const SESSION_BANDS = [0, 2, -2, 4, -4, 1, -1, 3, -3].map((k) => k * CHANNEL_SPACING)

export const SESSION = {
  halfWidth: 0.11,    // band half-width in s                                   (0.09–0.19)
  edge: 0.06,         // full weight inside this |ds|, feathering to 0 at halfWidth
  floorIdle: 0.15,    // held channel's lift floor, x LIFT.out, claimed and idle
  floorWork: 0.55,    // ... claimed and working
  relief: MAX_RELIEF, // core relief while working; <= MAX_RELIEF, inside the asserted sum
  bright: 0.68,       // vFade boost, x burn (0.5 until a notch too dim to read)
  size: 0.34,         // point-size boost, x burn (0.25 until the same pass)
  tint: 0.55,         // accent mix on a claimed channel (x0.5 idle, x1 working)
  tauIn: 0.45, tauOut: 0.8,          // claim easing, seconds
  tauWorkIn: 0.25, tauWorkOut: 1.5,  // the cool-down: 95% back in 4.5 s — a hot thing cooling, slower than it warmed
  reuseBelow: 0.02,   // a fading weight snaps to exactly 0 below this; only a 0 band is reusable
}

/** The twin of the shader's liftHeld: the same field g, the same clock, the
 *  same arcs — remapped into the TOP of the existing envelope rather than
 *  given a taller one. It never sinks below the shell, and is held higher
 * while its session works. The peak is LIFT.out exactly, so ceiling
 *  assertion is untouched.
 *
 *  Rise had to work this way: contain() begins compressing at SAFE_RADIUS
 *  (~1.048), which is BELOW the lift's own peak (~1.093), so every lifted arc
 *  is already inside the compression zone. There is no headroom by height and
 * there would be none if margin were ten times wider. Persistence is
 *  the axis that was still free. */
export const liftHeld = (g, work) => {
  const f = SESSION.floorIdle + (SESSION.floorWork - SESSION.floorIdle) * work
  return LIFT.out * (f + (1 - f) * (0.5 + 0.5 * g))
}

/** The claim table: an owner per band plus two eased weights.
 *
 *  Keyed by session id, NEVER by position in the live list. The orbitals
 *  index positionally, which is why a cluster jumps orbits when an earlier
 *  session ends — every later session
 *  shifts down an index and inherits a different orbit. A channel must not
 *  jump latitudes for the same reason, so ownership is by identity. */
// --- Colour: OKLab (Björn Ottosson, 2020) ------------------------------------
// Every colour ramp in the swarm eases in OKLab on
// the CPU: a straight line there is perceptually even and never passes through
// a third hue (the OKLCH arc from the teal accent to amber crosses H~146°, 23°
// from --green, so a warming band would flash "success"). Written back to the
// uniforms as sRGB hex through Color.setHex() — the exact path Color.set('#…')
// takes today — so a settled colour is bit-identical to the shipped render.
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const hexInt = (hex) => (typeof hex === 'number' ? hex : parseInt(String(hex).replace('#', ''), 16))
export const hexToOklab = (hex) => {
  const n = hexInt(hex)
  const r = srgbToLinear(((n >> 16) & 255) / 255), g = srgbToLinear(((n >> 8) & 255) / 255), b = srgbToLinear((n & 255) / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ]
}
export const oklabToHex = ([L, a, b]) => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  const ch = (v) => Math.round(Math.max(0, Math.min(1, linearToSrgb(v))) * 255)
  return (ch(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) << 16)
       | (ch(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) << 8)
       |  ch(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
}
export const oklabDist = (x, y) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
/** Exponential ease of an OKLab triple toward `target`, in place. A retarget
 *  mid-fade is just a new `target`: continuity is a property of the formula,
 *  so no snap is constructible. Mutates `cur`, never `target`. */
export const easeLab = (cur, target, dt, tau) => {
  const k = 1 - Math.exp(-dt / tau)
  cur[0] += (target[0] - cur[0]) * k
  cur[1] += (target[1] - cur[1]) * k
  cur[2] += (target[2] - cur[2]) * k
  return cur
}
const mixLab = (x, y, t) => [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]
// hex -> OKLab, memoised: the theme has a dozen colours and this runs per frame.
// The returned array is SHARED — pass it as a target, never mutate it.
const LAB_CACHE = new Map()
export const labOf = (hex) => {
  const k = hexInt(hex)
  let v = LAB_CACHE.get(k)
  if (!v) { v = hexToOklab(k); LAB_CACHE.set(k, v) }
  return v
}

// --- The body's mood ramp ----------------------------------------------
// Why the mood change was invisible (measured): the classifier lives in
// idle/working >= 90% of the time, those two are the SAME hue by design (only
// lightness differs, and lightness is the activity channel), and the colour
// snapped. The ramp fixes the snap for every look; the semantic hues moved to
// the session bands below, which is where they belong. MOODS is unchanged.
export const MOOD_RAMP = { tau: 0.5 }   // s: 63% at 0.5 s, 95% at 1.5 s — a fade, never a second behind
export const makeMoodRamp = (mood = 'idle') => { const m = moodColors(mood); return { a: hexToOklab(m.a), b: hexToOklab(m.b) } }
/** One frame: ease both body colours toward `target` ({ a, b } as hex). */
export const advanceMoodRamp = (R, target, dt) => {
  easeLab(R.a, labOf(target.a), dt, MOOD_RAMP.tau)
  easeLab(R.b, labOf(target.b), dt, MOOD_RAMP.tau)
  return R
}

// --- Session state and its accent ---------------------------------
export const SESSION_STATES = ['idle', 'working', 'waiting', 'error']
// idle is --accent-hot at the default hue — swarm.js passes the LIVE theme value
// through advanceClaims' accentOf. The other three are app.css's semantic tokens
// and do not follow the theme: a thing that means "error" cannot change colour
// because you picked a skin. Pinned against app.css by the harness. Keyed by
// SESSION STATE, not by the board's mood: a per-mood table cannot hold its own
// hue rule across a palette change.
export const STATE_ACCENT = { idle: '#a8e8ff', working: '#e0973c', waiting: '#f4b45c', error: '#ff5670' }
export const STATE_ACCENT_HOT = { working: '#f4b45c' }   // what a working band drifts toward at full burn: --amber-hot
/** Mirror of app.js's needsOf(), reduced to a boolean: parked at a prompt
 *  (observed by the relay) or asked something at the end of a turn (inferred
 *  by the plugin). Pinned against app.js's real source by the harness, the
 *  same way genuinelyWorking is. */
export const needsHuman = (s) => !!(s && (s.waiting || s.needs))
// The board's own rule (app.js recomputeMood: three errors in the last 14
// events), scoped to ONE session's events — so a red band and a red orb can
// never disagree about what an error is, only about scope.
export const ERROR_WINDOW = 14
export const ERROR_COUNT = 3
/** waiting > error > working > idle. An observation (waiting) outranks a count. */
export const sessionState = (s, recentErrors = 0, isWorking = genuinelyWorking) => {
  if (!s) return 'idle'
  if (needsHuman(s)) return 'waiting'
  if (recentErrors >= ERROR_COUNT) return 'error'
  return isWorking(s) ? 'working' : 'idle'
}
/** Per session id: how many of ITS last `window` events carry status 'error'.
 *  One backward pass over the board's event list; events without a sessionId
 *  are ignored. Called every 500 ms by swarm.js, never per frame. */
export const recentErrorsById = (events, window = ERROR_WINDOW) => {
  const seen = new Map(), out = new Map()
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const e = events[i]
    if (!e || e.sessionId == null) continue
    const n = seen.get(e.sessionId) ?? 0
    if (n >= window) continue
    seen.set(e.sessionId, n + 1)
    if (e.status === 'error') out.set(e.sessionId, (out.get(e.sessionId) ?? 0) + 1)
  }
  return out
}

// --- Burn: brightness from token rate -----------------------------------
// The payload carries no output-token counter, so the input is series[].tokens:
// each point (every 1.2 s) repeats the LAST assistant message's token total
// until a new message lands. tokenRate sums the tokens of the messages that
// landed inside the window — tokens per minute. Known and accepted: two
// consecutive messages with identical totals register once; a cache rebuild
// lands as one spike, which the log map below tames to <= 1 step.
export const BURN = {
  windowMs: 24_000,        // rate window                                   (12 000–60 000)
  r0: 600, rmax: 9000,     // tokens/min at burn ~0.24 and burn 1.0 — NOT calibrated on real sessions yet; walk live via MCS.setBurn
  tau: 0.8,                // burn easing, s
  floorWork: 0.45,         // a working band never reads cold (0.35 until too dim at a low rate)
  baseWait: 0.5, pulseAmp: 0.35, pulsePeriod: 2.4,   // the needs-you breath
  error: 0.8,
}
export const tokenRate = (series, now, windowMs = BURN.windowMs) => {
  if (!Array.isArray(series) || series.length < 2) return 0
  let sum = 0
  for (let i = 1; i < series.length; i++) {
    const p = series[i], q = series[i - 1]
    if (!p || !q || p.t < now - windowMs) continue
    if (p.tokens !== q.tokens) sum += p.tokens || 0
  }
  return sum / (windowMs / 60_000)
}
export const burnOf = (rate) =>
  Math.min(1, Math.max(0, Math.log2(1 + Math.max(0, rate) / BURN.r0) / Math.log2(1 + BURN.rmax / BURN.r0)))
export const burnTarget = (state, rate) =>
  state === 'working' ? BURN.floorWork + (1 - BURN.floorWork) * burnOf(rate)
  : state === 'waiting' ? BURN.baseWait
  : state === 'error' ? BURN.error
  : 0

// --- The claim table, extended -------------------------------------------
// table (owner, claim) plus: heat — its `work`, renamed, now "active":
// working, waiting or error, driving the lift floor and relief; wait — gates the
// pulse; burn — brightness; phase — the pulse's phase, ACCUMULATED (Rule A);
// lab — the band's eased OKLab accent.
export const makeClaims = () => {
  const n = SESSION_BANDS.length
  return {
    owner: SESSION_BANDS.map(() => null),
    claim: new Float64Array(n), heat: new Float64Array(n), wait: new Float64Array(n),
    burn: new Float64Array(n), phase: new Float64Array(n),
    lab: SESSION_BANDS.map(() => hexToOklab(STATE_ACCENT.idle)),
  }
}

const ease = (v, target, dt, tau, snap) => {
  const n = v + (target - v) * (1 - Math.exp(-dt / tau))
  return target === 0 && n < snap ? 0 : n
}

/** One frame. `live` is the CLAMPED live list. Ownership: a
 *  session keeps its band while it lives and until its claim has fully faded;
 *  a newcomer takes the first FREE band. Every decision is injected —
 *  `isWorking`, `stateOf(s)`, `rateOf(s)` (tokens/min), `accentOf(state)` (hex)
 *  — so the harness drives this without Date.now(), S.events or window.MCT.
 *  A bare function as the 4th argument is taken as `isWorking`. Mutates and
 *  returns C. */
export function advanceClaims(C, live, dt, opts = {}) {
  if (typeof opts === 'function') opts = { isWorking: opts }
  const {
    isWorking = genuinelyWorking,
    stateOf = (s) => sessionState(s, 0, isWorking),
    rateOf = () => 0,
    accentOf = (state) => STATE_ACCENT[state],
  } = opts
  const ids = new Map()
  for (const s of live) if (s && s.id != null) ids.set(s.id, s)
  for (const id of ids.keys()) {
    if (C.owner.includes(id)) continue
    const b = C.owner.indexOf(null)
    if (b >= 0) C.owner[b] = id
  }
  for (let b = 0; b < C.owner.length; b++) {
    const s = C.owner[b] === null ? undefined : ids.get(C.owner[b])
    const state = s ? stateOf(s) : 'idle'
    const tp = s ? 1 : 0, active = state !== 'idle' ? 1 : 0, tw = state === 'waiting' ? 1 : 0
    C.claim[b] = ease(C.claim[b], tp, dt, tp ? SESSION.tauIn : SESSION.tauOut, SESSION.reuseBelow)
    C.heat[b]  = ease(C.heat[b], active, dt, active ? SESSION.tauWorkIn : SESSION.tauWorkOut, SESSION.reuseBelow)
    C.wait[b]  = ease(C.wait[b], tw, dt, tw ? SESSION.tauWorkIn : SESSION.tauWorkOut, SESSION.reuseBelow)
    C.phase[b] = (C.phase[b] + dt * TAU / BURN.pulsePeriod) % TAU
    const rate = state === 'working' ? rateOf(s) : 0
    C.burn[b]  = ease(C.burn[b], burnTarget(state, rate), dt, BURN.tau, SESSION.reuseBelow)
    // The accent: the state's colour, and for a working band a drift toward the
    // lighter --amber-hot with burn — lightness is the only way a band reads as
    // more dominant under over-blending's opacity ceiling.
    const hot = state === 'working' ? burnOf(rate) : 0
    const target = hot > 0 ? mixLab(labOf(accentOf('working')), labOf(STATE_ACCENT_HOT.working), hot) : labOf(accentOf(state))
    easeLab(C.lab[b], target, dt, active ? SESSION.tauWorkIn : SESSION.tauWorkOut)
    if (!s && C.claim[b] === 0) C.owner[b] = null   // fully faded: free again
  }
  return C
}
/** The brightness the shader gets for band b: the eased burn plus the needs-you
 *  breath, added AFTER the ease (easing a 2.4 s sinusoid through tau 0.8 s would
 *  halve it). */
export const bandBurn = (C, b) => C.burn[b] + BURN.pulseAmp * C.wait[b] * (0.5 + 0.5 * Math.sin(C.phase[b]))
