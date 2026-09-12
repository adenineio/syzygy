/* Syzygy — the agent-presence swarm.
   An ES module, unlike its siblings replay.js and projects.js, because it
   imports three. Module bindings are invisible to app.js, so the public
   surface is assigned to window.MCS explicitly. */
import {
  Scene, PerspectiveCamera, WebGLRenderer, BufferGeometry, BufferAttribute,
  Points, ShaderMaterial, AdditiveBlending, NormalBlending, GLSL3,
  Color, Vector2, Vector4,
  // Lift — the occluder: a static, second
  // draw call, one of three mutually exclusive depth cues for a sunken
  // channel (see uSinkFade/uSinkFadeOn below and MCS.setDepthCue), 'fade'
  // the shipped default. Built once in boot(), never touched per frame,
  // disposed in teardown() so boot() stays re-entrant.
  SphereGeometry, Mesh, MeshBasicMaterial,
} from 'three'
import {
  MAX_SESSIONS, moodColors, makePulseRing, pushPulse, activePulses,
  sessionOrbit, clampSessions,
  // Sessions in streams — a session claims a latitude band, not a
  // channel: s = dot(n, FLOW_AXIS) is conserved by every motion the look has,
  // so a band never drifts and needs no attribute and no accumulated angle.
  // Ownership is keyed by session id rather than list position, unlike the
  // orbitals, whose slots jump when a session ends.
  SESSION_BANDS, SESSION, makeClaims, advanceClaims,
  // orb-presence — OKLab ramps, the
  // per-session state machine and burn from token rate. A band's colour is
  // its session's STATE, never the board's mood.
  STATE_ACCENT, sessionState, recentErrorsById, tokenRate, bandBurn,
  makeMoodRamp, advanceMoodRamp, oklabToHex, hexToOklab, BURN, MOOD_RAMP,
  RADIUS_CLAMP_MIN, RADIUS_CLAMP_MAX, SHELL_BLEND, SHELL_THICKNESS,
  // the camera's own vertical field of view / distance
  // (boot() below builds the real camera from these, never hand-copies
  // 45/3.2) and the derived, unconditional containment guarantee applied at
  // the end of every VERT (see CHUNK_RIPPLE's `contain()`, built from
  // SAFE_RADIUS/CONTAIN_CEILING below).
  CAMERA_FOV_DEG, CAMERA_Z, SAFE_RADIUS, CONTAIN_CEILING,
  MODES, DEFAULT_MODE, normalizeMode, LOOKS,
  // The orbiting session clusters' constants.
  CLUSTER, clusterFade,
  SCRIBBLE, scribblePaths, scribbleFade, glf,
  // Streams — the same constants and pure
  // helpers the harness twin asserts against (test/swarm-harness.mjs), so the
  // shader's uniforms and the CPU's angle bookkeeping cannot drift from what
  // is actually tested. fibonacciHomes is the pane's own home math, shared
  // with the harness rather than re-derived.
  freshAngles, advance, fibonacciHomes, rot3,
  // Orchestrator thinking indicator — `easeThinking`
  // smooths orchestrator.busy into a 0..1 level (MCS.frame below); the two
  // mult functions turn that level into the streams look's glow/spin boost.
  easeThinking, thinkingGlowMult, thinkingSpinMult, askRipple, thinkingTint,
  FLOW_AXIS, PREC_AXIS, SHEAR_RATE, BANDS,
  // the heartbeat trigger's own edge detector.
  // A mirror of app.js's genuinelyWorking/STALL_MS (see that export's own
  // comment in swarm-math.js for why this is a mirror, not a shared import).
  genuinelyWorking,
  // Reactive layer —
  // the ripple state machine. One shared `ripples` object (below), fed here
  // and read back as two uniform-row arrays per material; the harness
  // drives the exact same functions with a fixed schedule
  // (test/swarm-harness.mjs). `pointer()` and `toolPulse()` are both gone:
  // first the pointer's field ripple (mouse movement must never ripple the
  // field), then ordinary tool-call pulses (too frequent to read as a rare
  // event — rippling is for genuinely rare events only, which today means
  // the idle->thinking heartbeat and perhaps nothing else). The pointer's LEAN
  // (the `pull` easing below) and shell's own pre-existing tool-call shove
  // are both unrelated and untouched. sessionRippleMultiplier is the
  // concurrency STRENGTH multiplier — see MCS.frame below; it never touches
  // any refractory ("cap the rate regardless of session count").
  RIPPLE_SLOTS, makeRipples, heartbeat, rippleRows, sessionRippleMultiplier, usesBodyPulse, RIPPLE,
  // Lift — the per-channel radial life field.
  // LIFT_MODES/LIFT/AXIS_U/AXIS_V feed the streams material's uniforms
  // directly (never hand-typed numbers); freshLift/advanceLift are the
  // SAME phase bookkeeping the harness twin asserts against — the shader
  // and the twin cannot drift apart the way an independent reimplementation
  // could. Applied to captured grains only (`vein`, in STREAMS_VERT); dust
  // never lifts, so the orb stays the orb.
  LIFT_MODES, LIFT, AXIS_U, AXIS_V, freshLift, advanceLift,
} from './swarm-math.js'

const BODY = 30000
const PER_SESSION = CLUSTER.particles
// The lightning arcs of the shell look ride in the SAME buffer as the body and
// the session clusters, with their own aRole, so they cost the other looks one
// early-out per point and no second draw call.
const ARC_PATHS = scribblePaths()
const ARCS = ARC_PATHS.length * SCRIBBLE.perArc
const TOTAL = BODY + MAX_SESSIONS * PER_SESSION + ARCS

// Streams' own body count — a separate geometry/material/Points from the
// legacy iris/shell one (see the architecture note above STREAMS_VERT below
// for why one shared geometry is not possible here: iris's BODY 30000 is
// pinned as settled and must not be retuned).
// 150k sits in the middle of a usable 100k-250k range; the N*alpha*size^2
// rule keeps the count a knob rather than a limb blowout.
const BODY_STREAMS = 150000

let C = null          // { S } handed over by app.js
let canvas = null
let renderer = null
let scene = null
let camera = null
let material = null       // the legacy (iris/shell) ShaderMaterial
let legacyPoints = null   // the legacy Points — BODY 30000 + sessions, unchanged
let dpr = 1

// Streams — its own material, geometry and Points: a separate shader per
// look, one Points and one geometry per look, and a material swap on a mode
// change. Kept apart from the
// legacy `material`/`legacyPoints` above rather than reusing them, because
// iris's BODY (30000), uAlpha, uPointScale and uFlow are pinned settled and
// streams needs its own count (150k) and blending (over, not additive) —
// see the architecture note above STREAMS_VERT for the full reasoning.
let streamsMaterial = null
let streamsPoints = null
// The look's own accumulated angles (
// freshAngles()/advance() — Rule A: pure accumulation, never rate * uTime).
// Advanced only while streamsPoints is visible — "each look keeps its own
// accumulated angles and advances them only while active" — so a long
// spell on iris does not leave streams's shear phase stale or racing ahead.
let streamsAng = freshAngles()
// Lift — the six lift modes' own
// accumulated phases. Same discipline as streamsAng directly above: pure
// accumulation (Rule A), advanced only while streamsPoints is visible, and
// — like streamsAng — NOT reset in teardown()/boot(), so a WebGL context
// restore resumes each channel's cycle rather than snapping every mode
// back to freshLift()'s fixed starting phases.
let streamsLiftPh = freshLift()
// Lift's occluder. Built once in boot(),
// disposed in teardown(); visible only while BOTH streams is the active
// look AND depthCue === 'occluder' (toggled together in
// setModeImmediate/MCS.setDepthCue).
let occluder = null
// The depth cue for a sunken/risen channel — three mutually exclusive
// states, each individually correct rather than one compromised for
// another, judged by comparing all three live: 'fade' (dims away below
// uSinkFade, the shipped default), 'occluder' (the mesh's depth write
// hides it — fade OFF, since stacking both would double-dim), 'none'
// (neither — fully transparent, reproducing the render from before this
// feature existed, for comparison). A debug affordance, not a user
// preference: not persisted, always back to 'fade' on reload.
let depthCue = 'fade'
const DEPTH_CUES = ['fade', 'occluder', 'none']
let lastNow = null   // previous frame's `now` (seconds) — shared dt basis for actS and streamsAng
// The activity floor's 0.4s low-pass, so a session starting work reads as a
// swell rather than a step — streams-only. Legacy's uActivity stays the
// raw, unfiltered S.activity it has always used; retuning that response is
// exactly the kind of iris change that is out of bounds here, so this is an
// additional, separate signal rather than a change to the existing one.
let actS = 0

// Gravity toward the pointer. Holds the lean the swarm has actually reached,
// not the one it is being pulled to — the target snaps, this eases after it,
// so the body arrives late and settles; the lag is the whole difference
// between something attracted and something aimed.
//
// Distance falloff + gain, so a cursor far from the panel does not pull at
// full strength. The old code normalised the pointer offset by half the WINDOW
// width/height, then clamped to a unit disc and never faded past it — so a
// cursor anywhere past roughly half a window away from an off-centre panel
// was already pinned at max pull and stayed there for the rest of the page.
// pointerLeanTarget below normalises by the PANEL's own radius instead (full
// reach right at the panel edge) and multiplies by a smoothstep that holds
// at 1 out to one panel radius, then fades to PULL_FLOOR by PULL_FALLOFF_RADII
// radii out — the pull never fully lets go, it only weakens far away, so a
// cursor elsewhere on the page still leans the orb toward it, just weakly.
// PULL_GAIN is the overall lean strength, halved from the implicit 1.0
// before — a cursor right beside the orb should still lean it, just gently.
const PULL_FALLOFF_RADII = 2.5
// 0.85 -> 0.57, a 33% cut: the orb chased the cursor harder
// than it should. This scales the TARGET, so the easing
// and the falloff shape are untouched — only how far a given cursor position
// asks the body to lean.
const PULL_GAIN = 0.57
const PULL_FLOOR = 0.8
const pull = { x: 0, y: 0 }

/** Pointer offset (px, from panel centre) -> eased-toward lean target, in
 *  panel-radius units. offX/offY and panelR must be in the same units
 *  (CSS px here). Magnitude saturates to 1 at one panel radius out, then
 *  fades smoothly down to PULL_FLOOR by PULL_FALLOFF_RADII radii out. */
const pointerLeanTarget = (offX, offY, panelR) => {
  const tx = offX / panelR, ty = offY / panelR
  const reach = Math.hypot(tx, ty)
  const unit = reach > 1 ? 1 / reach : 1
  let falloff = 1
  if (reach > 1) {
    const s = Math.min(1, (reach - 1) / (PULL_FALLOFF_RADII - 1))
    const ease = 1 - s * s * (3 - 2 * s) // smoothstep, 1 at s=0 down to 0 at s=1
    falloff = PULL_FLOOR + (1 - PULL_FLOOR) * ease
  }
  const g = unit * falloff * PULL_GAIN
  return { x: tx * g, y: ty * g }
}
const pulses = makePulseRing()

// Sessions in streams — the claim table: which session owns which
// latitude band, plus two eased weights per band. Module scope and advanced
// every frame regardless of the active look, for the same reason actS is:
// switching into streams should open on the claims as they already stand,
// not watch them ease in from nothing. Deliberately not reset on a context
// restore — a session that owned a band before still owns it after.
const claims = makeClaims()

// orb-presence — the per-session sampler.
// Two passes every SAMPLE_MS, never per frame: each session's recent
// error count from S.events, and its message-landing token rate from its
// series. `series[].t` is Date.now() epoch ms from the hud, so the rate is
// taken against Date.now(), not the rAF clock.
const SAMPLE_MS = 500
let sampledAt = -Infinity
let errorsById = new Map()
let rateById = new Map()
const sampleSessions = (S, nowMs) => {
  if (nowMs - sampledAt < SAMPLE_MS) return
  sampledAt = nowMs
  errorsById = recentErrorsById(S.events ?? [])
  const next = new Map()
  const wall = Date.now()
  for (const s of S.sessions ?? []) if (s && s.id != null) next.set(s.id, tokenRate(s.series, wall))
  rateById = next
}
// advanceClaims' injected decisions. idle follows the live theme (--accent-hot);
// the semantic three are the pane's own tokens and do not.
const claimOpts = {
  stateOf: (s) => sessionState(s, errorsById.get(s.id) ?? 0),
  rateOf: (s) => rateById.get(s.id) ?? 0,
  accentOf: (state) => (state === 'idle' ? (window.MCT?.accentHot ?? STATE_ACCENT.idle) : STATE_ACCENT[state]),
}
// The body's mood ramp: two OKLab triples eased toward themedMood(S.mood)
// and written to BOTH materials, so every look fades and none snaps. Seeded in
// boot() from the themed idle so a non-default theme never fades in from teal.
const moodRamp = makeMoodRamp('idle')
const PULSE_LIFE = 1400

// the idle -> thinking heartbeat. Edge-triggered
// on the rising edge of "any session is genuinely working" — the falling
// edge (work stopping) fires nothing. `wasAnyWorking` is what makes this
// "the instant work starts," not "every frame while working."
//
// Reactive layer —
// corrected first to trigger on the RAW floor's rising edge, not the
// smoothed activity: this already was the raw signal (`genuinelyWorking`
// reads `s.working` directly, never `actS`, streams's own 0.4s low-passed
// copy of `S.activity`). It is the plain 0->1 edge and nothing more: the
// refractory (`ripples.lastHeart`, HEART_REFRACTORY_S — a fixed 5.0s,
// swarm-math.js) is never shortened by anything. Concurrency scales the
// STRENGTH of a ripple, never its rate; letting a session count shorten the
// refractory makes ripples fire far too often, at which point they stop
// reading as rare events at all. `heartbeat()`'s own return
// value (did it actually fire, past the refractory) is what gates shell's
// secondary shove below, so the two reactions can never drift out of sync.
let wasAnyWorking = false
// Ordinary tool-call pulses run 0.75 (routine) to 1.4 (a denied call) — see
// app.js's firePulse. 2.4 sits clearly above that whole range so a heartbeat
// is never mistaken for a loud tool call. Shell-only (see MCS.frame): iris/
// streams react through the (now heartbeat-only) field ripple instead.
// Scaled by the concurrency multiplier at the point it is pushed — see
// MCS.frame and MCS.pulse — because shell has no field to ripple, so the rule
// that every look carries the concurrency multiplier becomes, for shell, its
// own heartbeat-triggered shove scaling with the count instead. Shell's
// SEPARATE, ordinary tool-call shove (MCS.pulse, mode==='shell') is NOT scaled
// by this multiplier: it is the existing subtle shockwave, left alone. Only
// the rare heartbeat path carries the concurrency signal, for every look.
const HEARTBEAT_STRENGTH = 2.4

// Strength only, never rate — the concurrency multiplier, read every frame
// in MCS.frame from
// sessionRippleMultiplier(workingCount) and cached here at module scope so
// MCS.heartbeat() (called from app.js's console, off a real event) can use
// the SAME value frame() last computed rather than recomputing its own. 1
// until the first frame runs — no multiplier effect before the swarm is
// actually ticking.
let currentMult = 1
// uRipLift/uRipGlow's documented ranges (CHUNK_RIPPLE: "0.4 (0-0.8)" / "0.35
// (0-1)") are how far intensity is allowed to climb; the cap below is
// exactly base*2.0 for uRipLift (0.4*2=0.8, its ceiling) and comfortably
// under base*2.0 for uRipGlow (0.35*2=0.70 < 1.0) — RIPPLE_MULT_SCALE
// (swarm-math.js) is chosen so mult(12) lands just under this 2.0 cap, so
// intensity is still visibly climbing across the whole 1-12 range this task
// verifies, and only a hypothetical count well past 12 would actually reach
// the cap. Reused for both iris and streams — "the others should carry this
// multiplier rule as well." Every one of these channels only ever matters
// during the rare moment a heartbeat ring is actually live (beat==0 the
// rest of the time regardless of these uniforms' values), so scaling them
// continuously is harmless and exactly right.
const INTENSITY_MULT_CAP = 2.0
const BASE_RIP_LIFT = LOOKS.iris.uRipLift
const BASE_RIP_GLOW = LOOKS.iris.uRipGlow

// Orchestrator thinking indicator. `orchestratorBusy` is
// set by MCS.setBusy (app.js calls it from renderBlurb, which already runs
// on every S.orchestrator change — snapshot, the SSE `orchestrator` frame,
// and sendAsk's own optimistic busy toggles). `thinkingLevel` is the eased
// 0..1 follower MCS.frame advances every frame regardless of which look is
// showing, so switching INTO streams mid-thought never opens on a cold
// start. Read by streams's own block in MCS.frame to scale uGlow and the
// spin handed into advance(); iris/shell never read it — it belongs to the
// streams shader, not to the whole presence sphere.
let orchestratorBusy = false
let thinkingLevel = 0
// Rising-edge latch for the ask swell: the ripple fires once, when the turn
// STARTS, never every frame it stays busy.
let prevOrchestratorBusy = false
const STREAMS_BASE_GLOW = 1.6 // matches the streams material's own uGlow default below
// The legacy (iris/shell) material had no glow multiplier before the thinking
// indicator was ported onto it, so its base is the identity. The swell is the
// SAME thinkingGlowMult streams uses; only the base differs, which means the
// absolute top of the swell is 3.4x here against streams' 5.44x.
const LEGACY_BASE_GLOW = 1


// Reactive layer — the ripple
// state machine: the heartbeat is the ONLY trigger now (ordinary tool-call
// pulses no longer ripple the field — see RIPPLE's own comment), six
// uniform slots, shared by streams and iris through the chunk library.
// One `ripples` object; each material gets its own row arrays because each
// looks's centres are converted into that look's own field frame (streams:
// un-precess, un-drift; iris: the identity — see toStreamsField in
// MCS.frame). Allocated once, written in place every frame — no per-frame
// array churn, matching every other fixed-size uniform array here (uPulses,
// uSessions).
const ripples = makeRipples()
const ripA_legacy = Array.from({ length: RIPPLE_SLOTS }, () => new Float32Array(4))
const ripB_legacy = Array.from({ length: RIPPLE_SLOTS }, () => new Float32Array(4))
const ripA_streams = Array.from({ length: RIPPLE_SLOTS }, () => new Float32Array(4))
const ripB_streams = Array.from({ length: RIPPLE_SLOTS }, () => new Float32Array(4))
// iris/shell share the legacy shader with no precession/drift transform to
// convert a ripple centre through (unlike streams — see toStreamsField in
// MCS.frame), so their toField is the identity, same as the harness twin's.
const identityField = (v) => v

// sessions as orbiting sub-swarms. Each slot's orbit ANGLE is
// accumulated here, once per frame, rather than recomputed in the shader as
// phase + uTime * rate: with a rate that depends on `working`, recomputing
// from uTime teleports the cluster the instant a session's working flag
// flips, because the angle at a given uTime jumps to wherever the new rate
// would have put it by now. Accumulating means a rate change only changes
// the angular *speed*, never the position.
//
// Indexed by BAND (claims.owner), not by position in the live list — see
// MCS.frame. It was positional until orb-presence: a departure shifted every
// later session down a slot, onto a different orbit and a different angle,
// which read as a jump. Ownership is keyed by session id,
// so a survivor never moves. Seeded from sessionOrbit(i).phase so sessions
// still fan out across the shell rather than starting stacked.
const sessionAngle = Array.from({ length: MAX_SESSIONS }, (_, i) => sessionOrbit(i).phase)
let lastFrameS = null   // previous frame's uTime, seconds; null until the first frame

// the mode switcher. Module scope, same reason as everything above:
// `$` isn't in play here (this is browser-side, not a hooks module), but
// boot() can run again on a WebGL context restore, so state that must
// survive a re-boot — the current look, whether the click listener is
// already wired — has to live outside boot()'s closure.
const MODE_KEY = 'szg.swarm.look'
let mode = DEFAULT_MODE
let listenerWired = false

// context loss/restoration. Wired at most once, same discipline as
// listenerWired above: attach() itself only ever runs once (app.js's
// swarmTried latch, see the bottom of that file), but the guard is free and
// keeps this file's two "wire once" flags consistent with each other rather
// than one guarded and one not.
let contextListenersWired = false

// Set true by the webglcontextlost handler, cleared by the teardown() it
// leads to. Distinguishes "boot() is re-entering because the context was
// actually lost" from any other re-entrant call: the GPU objects a lost
// context's renderer/materials/geometries reference are already gone at the
// driver level (the WebGL spec: a lost context's resources are considered
// lost, full stop), so calling .dispose() on them post-restore cannot free
// anything real — it only asks the (already-restored, same-identity per
// spec) context object to delete buffer/VAO handles from a prior context
// generation, which logs a harmless but noisy `INVALID_OPERATION: ...
// object does not belong to this context` warning for each one — skipping
// just these four calls in that one case avoids it, while every other
// boot() call, including the very first one, still disposes for real.
let recoveringFromLoss = false

// ~0.4s fade through dark on a mode switch (requirement, not a design
// nicety): the cloud's alpha is multiplied by uFadeMul, eased 1 -> 0 -> 1,
// and the mode swaps at the midpoint — the instant the cloud is fully dark,
// so the swap itself is never seen as a cut. This is deliberately a uniform
// multiplier on top of uAlpha rather than touching uAlpha's settled 0.17, and
// it works for any pair of looks regardless of how differently their force
// functions move particles — which matters because streams and nebula will
// have entirely different transports later.
const FADE_MS = 400
let fadePhase = null       // null | 'out' | 'in'
let fadePhaseStart = 0     // rAF timestamp (ms) the current phase began
let fadeFromMul = 1        // uFadeMul's value when the current phase began
let fadeTarget = null      // mode 'out' is heading toward; cleared once swapped
let nowMs = 0              // updated every frame(); setMode times a fade off this

// ===========================================================================
// Reactive layer — CHUNK_RIPPLE, shared by every look that gathers. Defined
// here, above BOTH the legacy VERT and the streams chunk library below,
// because the legacy shader interpolates it directly into its own template
// literal (`${CHUNK_RIPPLE}`, see VERT) and a `const` referenced before its
// own declaration line runs is a ReferenceError (TDZ) — so this has to exist
// before VERT is evaluated, not merely before STREAMS_VERT is composed from
// its chunks further down. One kernel, ONE profile, ONE trigger now: a
// single slow ring, fired only by the idle->thinking heartbeat — never the
// pointer, and no longer an ordinary tool call either (removed in a second
// pass: rippling on every tool call read as constant churn, not an event).
// The stationary spot that followed the pointer, and its wake rings, are gone
// too (see swarm-math.js's RIPPLE table comment);
// the kernel below still supports a "spot" shape (B.w>=0.5, unipolar about
// its centre) as general capability, but nothing produces one today. A slot
// with bend == kick == 0 is skipped, so an idle frame costs one branch per
// slot and produces the identity — the shipped render with every slot zero
// is bit-for-bit what it was before this layer existed.
const CHUNK_RIPPLE = `
// ---- RIPPLE: the reactive layer, shared by every look that gathers -------
const int RIPPLES = 6;
uniform vec4 uRipA[RIPPLES];   // xyz centre (unit), w front radius (rad); 0 for a spot
uniform vec4 uRipB[RIPPLES];   // x bend (rad), y kick (rad), z sigma (rad), w shape: 0 ring, 1 spot
uniform float uRipLift;        // radial lift per unit ring amplitude — the body's own beat   0.4  (0-0.8)
uniform float uRipGlow;        // brightening at a ring's front                                 0.35 (0-1)

// Evaluates every live ripple at the field-frame point n.
//   bent      the point to SAMPLE the field at; the pattern appears displaced
//             by +disp (so a positive bend pushes channels away from c)
//   kick      added to the field's phase — the in-place morph run forward here
//   gradKick  its gradient on the sphere, for the Newton step
//   beat      summed ring amplitude at n, 0..~0.2, for lift and glow
// A ring's bend is a bipolar wavelet (integral zero: out, back past rest,
// settle); its kick is unipolar on the front. A spot's bend and kick are
// both unipolar about its centre. The tangent direction "away" vanishes at
// the centre, so a spot's displacement is zero there and grows to its
// maximum one sigma out — no singularity under the cursor.
void ripples(vec3 n, out vec3 bent, out float kick, out vec3 gradKick, out float beat) {
  vec3  disp = vec3(0.0);
  vec3  gk   = vec3(0.0);
  float k    = 0.0;
  float b    = 0.0;
  for (int i = 0; i < RIPPLES; i++) {
    vec4 A = uRipA[i];
    vec4 B = uRipB[i];
    if (B.x == 0.0 && B.y == 0.0) continue;
    float cd   = clamp(dot(n, A.xyz), -1.0, 1.0);
    float th   = acos(cd);
    vec3  away = n * cd - A.xyz;                          // tangent, points away from the centre
    float al   = length(away);
    away = al > 1e-5 ? away / al : vec3(0.0);
    float sg   = max(B.z, 1e-3);
    float u    = (th - A.w) / sg;
    float g    = exp(-0.5 * u * u);
    float bend = (B.w < 0.5) ? u * g * 1.6487213 : g;     // ring: bipolar, peak 1 at |u| = 1; spot: unipolar
    disp += away * (B.x * bend);
    k    += B.y * g;
    gk   += away * (B.y * (-u / sg) * g);                 // d(kick)/dtheta * grad(theta), grad(theta) = away
    b    += (B.w < 0.5) ? B.x * g : 0.0;
  }
  bent     = normalize(n - disp);
  kick     = k;
  gradKick = gk;
  beat     = b;
}

// ---- CONTAIN: the camera-derived final position guarantee --------------
// swarm-math.js's softClampRadius(), verbatim: identity below the threshold
// (everything the gather pipeline itself can reach — see RADIUS_CLAMP_MAX's
// own derivation), a smooth compression above it, asymptotic toward the
// ceiling (CONTAIN_CEILING — the camera's true vertical visible bound MINUS
// a point-sprite-radius margin, not the bound itself: the compression is
// asymptotic, so compressing all the way to the literal camera edge would
// leave no room at all for a sprite's own screen-space radius once len is
// pushed hard enough — see CONTAIN_CEILING's own comment, swarm-math.js) —
// so a particle's distance from the origin can approach but can never
// reach, let alone exceed, CONTAIN_CEILING, which itself sits strictly
// inside what the camera can actually show. Applied once,
// at the very end of every VERT below, to the truly final p — after the
// pointer's lean, a pulse shockwave, a ripple's radial lift, or the
// concurrency multiplier on any of those. GLSL ES 1.00 (this shader's own
// version — no glslVersion set, unlike STREAMS_VERT's GLSL3) has no tanh()
// builtin, hence the exp() identity; used here rather than the native
// tanh() in STREAMS_VERT too, so both shaders run bit-for-bit the same math.
vec3 contain(vec3 p) {
  const float THRESH = ${SAFE_RADIUS.toFixed(4)};
  const float CEIL   = ${CONTAIN_CEILING.toFixed(4)};
  float len = length(p);
  if (len <= THRESH) return p;
  float span = CEIL - THRESH;
  float x = (len - THRESH) / span;
  float th = 1.0 - 2.0 / (exp(2.0 * x) + 1.0);   // tanh(x)
  return p * ((THRESH + span * th) / len);
}
`

// The legacy pipeline's simplex noise, its analytic gradient, the potential
// field and curl(). Hoisted out of VERT; kept hoisted because a
// named chunk is easier to share and to compile-check than a wall of inline
// GLSL. It is interpolated into VERT the way CHUNK_RIPPLE is.
const CHUNK_LEGACY_NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

// snoise plus its analytic gradient: vec4(value, d/dx, d/dy, d/dz).
// value = 42·Σ m⁴(g·x), m = max(0.6 − x·x, 0); every corner offset x_i has
// dx_i/dv = I, so d/dv[m⁴(g·x)] = −8 m³ (g·x) x + m⁴ g. About 15% over snoise.
vec4 snoised(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  vec4 m2 = m * m;
  vec4 m4 = m2 * m2;
  vec4 px = vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3));
  vec4 m3px = m2 * m * px;
  vec3 grad = -8.0 * (m3px.x * x0 + m3px.y * x1 + m3px.z * x2 + m3px.w * x3)
            + m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
  return 42.0 * vec4(dot(m4, px), grad);
}

// A vector potential. Taking its curl gives a divergence-free field, which is
// what stops particles clumping into knots or tearing holes in the shell.
vec3 potential(vec3 p, float t) {
  return vec3(
    snoise(p * 1.6 + vec3(0.0,  0.0, t)),
    snoise(p * 1.6 + vec3(31.4, 17.7, t)),
    snoise(p * 1.6 + vec3(-9.2, 43.1, t))
  );
}

// A DIRECTION field for advection, not a magnitude: the step size downstream
// must come from dt (life, uFlow, activity), never from this field's own raw
// scale. It used to return c / (2.0 * e) with e = 0.06 — a bare multiply by
// 1/(2*0.06) = 8.33 baked into every call, unbounded and never normalized —
// and that unbounded length is what pushed
// three Euler steps of advection to several units, four times the intended
// shell radius, so the "Agent presence" panel rendered as a flat rectangular
// field of uniform dust with no visible sphere (the ball was there, just
// ~4x too big for the 280px panel to show anything but its middle).
// normalize(vec3(0)) is undefined, hence the length guard below rather than
// a bare normalize(c) — degenerate only where the potential field is exactly
// flat in every sampled direction at once, which central-difference noise
// essentially never produces, but the guard is free and must not be dropped.
vec3 curl(vec3 p, float t) {
  const float e = 0.06;
  vec3 dx = vec3(e, 0.0, 0.0), dy = vec3(0.0, e, 0.0), dz = vec3(0.0, 0.0, e);
  vec3 px0 = potential(p - dx, t), px1 = potential(p + dx, t);
  vec3 py0 = potential(p - dy, t), py1 = potential(p + dy, t);
  vec3 pz0 = potential(p - dz, t), pz1 = potential(p + dz, t);
  vec3 c = vec3(
    (py1.z - py0.z) - (pz1.y - pz0.y),
    (pz1.x - pz0.x) - (px1.z - px0.z),
    (px1.y - px0.y) - (py1.x - py0.x)
  );
  return c / max(length(c), 1e-5);
}
`

const VERT = `
precision highp float;

${CHUNK_LEGACY_NOISE}

// The evolving crest field on the unit sphere. Two independent simplex
// fields blended as cos/sin of a phase: constant variance (a linear
// crossfade loosens at the midpoint) and evolution IN PLACE — features are
// born, merge and die where they stand. A time offset along an axis, as
// veinField had, slides the pattern over the sphere instead.
// Returns vec4(value, tangential gradient w.r.t. the unit-sphere point n).
vec4 crestField(vec3 n, float scale, vec3 offA, vec3 offB, float phase) {
  vec4 a = snoised(n * scale + offA);
  vec4 b = snoised(n * scale + offB);
  vec4 f = a * cos(phase) + b * sin(phase);
  vec3 g = f.yzw * scale;          // chain rule: d/dn of N(n*scale + off)
  g -= n * dot(g, n);              // keep only the component along the surface
  return vec4(f.x, g);
}

// One Newton step of n toward the zero set of F = f1.x * f2.x — the union
// of both families' zero contours, i.e. the crest set of the two-octave
// ridged field veinField was shading. reach is the capture radius in
// radians: inside 0.6·reach a particle is carried fully onto the crest,
// between 0.6·reach and reach it is released smoothly (a particle sitting
// exactly between two crests is left alone rather than snapped to one —
// that is what stops popping), beyond reach it is untouched. capture
// reports how strongly this particle was held, 0..1, weight included.
vec3 crestStep(vec3 n, vec4 f1, vec4 f2, float reach, float weight, out float capture) {
  float F  = f1.x * f2.x;
  vec3  G  = f2.x * f1.yzw + f1.x * f2.yzw;
  float gl = max(length(G), 1e-4);
  float d  = abs(F) / gl;                              // Newton distance to the crest
  capture  = (1.0 - smoothstep(0.6 * reach, reach, d)) * weight;
  return -sign(F) * min(d, reach) * capture * (G / gl);
}

// Reactive layer — the same overload
// CHUNK_CAPTURE below adds for streams, shaped for THIS crestField's simpler
// (isotropic-scale) signature. gradPhase is the kick's spatial gradient on
// the sphere; the extra term is exact — d/dn[cos φ·a + sin φ·b] picks up
// (b·cos φ − a·sin φ)·∇φ — so the Newton step stays honest under a kick
// whose front is only a few sigma wide. The 5-argument overload above is
// untouched and still compiles; nothing calls it after this change, but
// callers elsewhere are free to.
vec4 crestField(vec3 n, float scale, vec3 offA, vec3 offB, float phase, vec3 gradPhase) {
  vec4 a  = snoised(n * scale + offA);
  vec4 b  = snoised(n * scale + offB);
  float cp = cos(phase), sp = sin(phase);
  vec4 f  = a * cp + b * sp;
  vec3 g  = f.yzw * scale;
  g += (b.x * cp - a.x * sp) * gradPhase;
  g -= n * dot(g, n);
  return vec4(f.x, g);
}

${CHUNK_RIPPLE}

attribute float aSeed;
attribute vec3  aHome;
attribute float aRole;     // 0 = body, 1 = session
attribute float aSession;
attribute vec2  aPath;     // scribble: (arc id, position 0..1 along the whole arc)
attribute vec3  aTan;      // scribble: the spine direction a stream particle darts along
attribute float aSize;

uniform float uTime;
uniform float uRadius;
uniform float uPointScale;   // physical pixels; see boot() — DPR-aware, not a fixed literal
uniform float uFlow;
uniform float uLife;
uniform float uThickness;
uniform float uVeinScale;    // trunk family scale on the unit sphere
uniform float uBranchScale;  // fine family scale, as a multiple of uVeinScale
uniform float uBranch;       // fine-family strength away from trunks; 1 = full lattice
uniform float uGather;       // 0 = today's render (geometry unchanged), 1 = full capture
uniform float uReach;        // capture radius, radians of arc
uniform float uLoose;        // fraction of particles held short of the core (the sheath)
uniform float uMorph;        // phase rate, rad/s; the skeleton evolves in place at this speed
uniform float uRelief;       // captured particles sit this much proud of the shell
uniform float uDustFade;     // brightness of an uncaptured particle, relative
uniform float uBack;         // brightness of the far hemisphere, relative

// State mapping.
// uActivity is 0..1: tool-call pulses ride on top of a floor app.js holds
// while the focused session is genuinely working (not merely parked at a
// permission prompt), so a long tool-free generation still reads as
// thinking instead of decaying to idle between calls.
uniform float uActivity;
uniform vec2  uPull;         // eased pointer lean, already lagged in JS — see the pull object above
uniform vec4  uPulses[4];    // xy = (age01, strength), zw unused; fixed size, GLSL arrays are
uniform int   uPulseCount;

// sessions as orbiting sub-swarms. vec4(radius, inclination,
// ACCUMULATED angle in radians, working 0|1). The angle is accumulated on
// the CPU (swarm.js MCS.frame) and used here directly — never rate * uTime,
// see the aRole branch in main() below.
uniform vec4 uSessions[8];
uniform int  uSessionCount;
// The orbiting clusters' own bound and orbit depth. Their centre
// is clamped to uClusterBound; per-point contain() used to flatten them onto
// the containment shell. uClusterOrbitZ replaces a baked 0.6 that made them
// lunge at the camera once the flattening stopped hiding it.
uniform float uClusterBound;
uniform float uClusterOrbitZ;
uniform float uClusterFade;    // per-point fade, derived from the measured density
uniform float uClusterPull;    // how far a cluster follows the pointer lean
uniform float uArc;            // 1 for the shell look's arcs, 0 elsewhere
uniform float uArcFade;        // per-point fade, derived from the arcs' own density
uniform float uClusterHide;    // 1 where a look draws no orbiting clusters
uniform float uArcSpan;        // fraction of each arc that is visible — opens while thinking
uniform float uArcDart;        // dart DISTANCE multiplier — never a rate
uniform float uArcRipple;      // how far a passing ring sweeps an arc — MCS.setArcRipple()

varying float vFade;
varying float vDepth01;

void main() {
  // Session particles take their own path entirely and return before any of
  // the body pipeline below (life, curl advection, crest capture) runs, so
  // the crest gather never sees them. This must stay the very first thing
  // main does.
  // ---- scribble: freeform lightning arcs ---------------------------------
  // Ring-like but not rings: each arc belongs to a plane around the orb and
  // then refuses to be a circle. The jags are in the geometry (aHome walks an
  // already-crooked polyline), so this only draws the bolt and crackles it.
  if (aRole > 1.5) {
    if (uArc < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vFade = 0.0; return; }
    float pid = aPath.x;
    // Only the first uArcSpan of each arc exists right now. Renormalise so
    // the draw sweep still runs 0..1 over whatever is showing — which is why
    // a longer arc is also a faster one, at no extra cost.
    if (aPath.y > uArcSpan) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vFade = 0.0; return; }
    float sPos = aPath.y / max(0.001, uArcSpan);
    float off = fract(sin(pid * 45.233) * 24634.6345);

    // Constant period, so uTime as a phase cannot teleport: there is no rate
    // here that state can change, which is the whole of the exemption.
    float cyc = floor(uTime / ${glf(SCRIBBLE.periodS)} + off);
    float ph  = fract(uTime / ${glf(SCRIBBLE.periodS)} + off);

    // DRAW: the head races along s. Behind it the bolt stays lit; ahead of it
    // nothing exists yet. That is the "being drawn midair" part.
    float draw = ph / ${glf(SCRIBBLE.drawS / SCRIBBLE.periodS)};
    float drawn = step(sPos, draw);
    float head = exp(-abs(sPos - draw) / ${glf(SCRIBBLE.headLen)}) * step(draw, 1.0);

    // HOLD then DECAY: the bolt lingers, flickering, then goes.
    float life = 1.0 - smoothstep(
      ${glf((SCRIBBLE.drawS + SCRIBBLE.holdS) / SCRIBBLE.periodS)},
      ${glf((SCRIBBLE.drawS + SCRIBBLE.holdS) / SCRIBBLE.periodS + 0.22)}, ph);

    // CRACKLE: a fast per-point flicker, so a live bolt is never steady. This
    // is a noise LOOKUP at a time coordinate, not an integrated phase.
    float cr = fract(sin((sPos * 91.7 + pid * 13.1 + floor(uTime * 22.0)) * 43758.5453) * 1.0);
    float flick = 1.0 - ${glf(SCRIBBLE.crackle)} * cr;

    // A share of arcs sit out each cycle; a busy board runs more of them.
    float roll = fract(sin((pid + cyc * 5.31) * 78.233) * 43758.5453);
    float alive = step(0.35 * (1.0 - 0.6 * uActivity), roll);

    // ---- REORIENT. The arc set is fixed, so without this the same shapes
    // recur in the same places. Rotate the whole arc — position AND tangent,
    // rigidly — to an orientation hashed from (arc, cycle). Radius is
    // preserved, so the shell bounds are untouched.
    float yaw   = fract(sin((pid * 3.71 + cyc * 17.3) * 43758.5453) * 1.0) * 6.2831853;
    float pitch = fract(sin((pid * 9.13 + cyc * 5.77) * 24634.6345) * 1.0) * 6.2831853;
    float cy = cos(yaw), sy = sin(yaw), cp = cos(pitch), sp2 = sin(pitch);
    vec3 hm = aHome, tg = aTan;
    hm = vec3(cy * hm.x + sy * hm.z, hm.y, -sy * hm.x + cy * hm.z);
    hm = vec3(hm.x, cp * hm.y - sp2 * hm.z, sp2 * hm.y + cp * hm.z);
    tg = vec3(cy * tg.x + sy * tg.z, tg.y, -sy * tg.x + cy * tg.z);
    tg = vec3(tg.x, cp * tg.y - sp2 * tg.z, sp2 * tg.y + cp * tg.z);

    // ---- RIPPLE, SAMPLED BEFORE ANYTHING IS CULLED. This used to sit after
    // the visibility cutoff, so only arcs that happened to be mid-draw could
    // ripple — and an arc is lit maybe a third of the time, so a passing ring
    // swept over mostly-dark geometry and the whole layer read as static
    // while the body heaved. The arcs have to ripple with the core sphere, so
    // that they are not static while it expands into them.
    // Now the ring is sampled first, displaces every arc point, and FEEDS
    // BRIGHTNESS — so a ring crossing the sphere lights the arcs it passes
    // through rather than moving invisible ones.
    vec3 rbent; float rkick, rbeat; vec3 rgk;
    ripples(normalize(hm), rbent, rkick, rgk, rbeat);
    // Referenced to ONE full ring, with headroom above it so overlapping
    // rings stack instead of both pinning at the same value. The old
    // clamp(rbeat/0.08, 0, 1) saturated on a single ask ring, so a heartbeat
    // arriving mid-sweep changed nothing the eye could see.
    float ring = min(rbeat / ${glf(SCRIBBLE.ringRef)}, ${glf(SCRIBBLE.ringMax)});

    float bright = drawn * life * alive * (${glf(SCRIBBLE.tail)} * flick + (1.0 - ${glf(SCRIBBLE.tail)}) * head * 2.0);
    // THE RING REVEALS EVERY ARC, with no gate at all. It was multiplied by
    // 'alive', the per-cycle dropout -- so roughly a third of arcs sat out any
    // given ring, fell under the cutoff below, and were discarded before the
    // displacement could touch them. That is the intermittency: a ripple
    // sometimes did not reach the arcs at all. The requirement is that they
    // ripple in sync with the core ALWAYS, and always means the dropout does
    // not get a vote. The dropout still governs each arc's own
    // draw cycle; it no longer suppresses the body's ring.
    bright = max(bright, ring * ${glf(SCRIBBLE.ringFlare)});
    if (bright < 0.004) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vFade = 0.0; return; }

    // ---- the STREAM. A particle does not sit on the spine; it darts along it
    // and recycles. The sawtooth is EASED so it leaves fast and arrives slow —
    // that deceleration is the weight. A constant-velocity slide reads as a
    // texture scrolling; this reads as something thrown.
    float dp = fract(uTime * ${glf(SCRIBBLE.dartRate)} + aSeed * 7.13);
    float eased = 1.0 - pow(1.0 - dp, ${glf(SCRIBBLE.dartEase)});
    vec3 p = hm + tg * (eased - 0.5) * ${glf(SCRIBBLE.dartLen)} * uArcDart;

    // Swept outward by the ring, by MORE than the body swells, so the body
    // never grows through them. uRipLift * beat is the body's own lift.
    p += normalize(hm) * rbeat * uArcRipple;

    // Speed of the dart right now: the derivative of the ease. Scatter rides
    // it, so the stream frays where it is moving fastest and settles where it
    // lands — crackling and bouncing rather than uniformly fuzzy.
    float speed = pow(1.0 - dp, ${glf(SCRIBBLE.dartEase - 1.0)});
    vec3 nrm1 = normalize(cross(tg, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
    vec3 nrm2 = normalize(cross(tg, nrm1));
    float t1 = fract(sin((aSeed * 51.7 + floor(uTime * ${glf(SCRIBBLE.scatterRate)})) * 43758.5453) * 1.0) - 0.5;
    float t2 = fract(sin((aSeed * 19.3 + floor(uTime * ${glf(SCRIBBLE.scatterRate)}) * 3.7) * 24634.6345) * 1.0) - 0.5;
    p += (nrm1 * t1 + nrm2 * t2) * ${glf(SCRIBBLE.scatter)} * (0.35 + speed);

    vec3 adir = vec3(uPull.x, -uPull.y, 0.0);
    float ag = min(1.0, length(adir));
    if (ag > 0.001) p += normalize(adir) * ag * uRadius * uClusterPull;

    // Clamped ABOVE 1 so a second ring is visible as extra brightness rather
    // than being flattened away at the last step.
    vFade = uArcFade * clamp(bright, 0.0, ${glf(SCRIBBLE.ringMax)}) * (1.0 + ${glf(SCRIBBLE.rippleGlow)} * ring);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vDepth01 = clamp((-mv.z - 2.2) / 2.0, 0.0, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.0, aSize * uRadius * (uPointScale / max(0.001, -mv.z)));
    return;
  }

  if (aRole > 0.5) {
    if (uClusterHide > 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vFade = 0.0; return; }
    int idx = int(aSession);
    vec4 s = uSessions[idx];
    // An empty slot is radius 0 (orb-presence): slots are keyed by band
    // ownership now, so occupancy is sparse and the count alone cannot say.
    if (idx >= uSessionCount || s.x <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vFade = 0.0; return; }
    float working = s.w;

    // s.z is the accumulated angle handed in by the CPU, used as-is — see
    // the uSessions declaration above and. A working session's cluster
    // moves faster (the CPU integrates a higher rate for it) but a flip in
    // working only ever changes speed from here on, never position.
    float ang = s.z;
    // Orbit depth is a uniform now. It was 0.6, and with the containment
    // clamp gone that puts a cluster 1.80 from a camera at 3.2 on its near
    // swing against 4.60 on its far one -- a 2.55x size swing that reads as
    // lunging at you. The clamp used to hide it by crushing everything onto
    // one radius; fixing the flattening exposed it. MCS.setClusterOrbitZ().
    vec3 centre = vec3(cos(ang) * s.x, sin(ang) * s.x * 0.42 + s.y * 0.5, sin(ang) * s.x * uClusterOrbitZ);

    // aHome is a unit sphere point, reused here as the cluster's own shape.
    // Each slot gets its own size, deterministically — the golden ratio keeps
    // neighbours apart and keeps a session's cluster the same size for as
    // long as it owns the band.
    float sizeVar = mix(${glf(CLUSTER.sizeVarMin)}, ${glf(CLUSTER.sizeVarMax)}, fract(float(idx) * 0.6180339887));
    float spread = mix(${glf(CLUSTER.spread)}, ${glf(CLUSTER.spreadWork)}, working) * sizeVar;
    float ptf = 0.7 + working * 0.5;   // the point-size factor used below
    // CONTAIN THE CENTRE, not the points. These clusters orbit
    // at 1.85-2.33, far past SAFE_RADIUS, and contain() saturates: applied
    // per point it mapped every point of a cluster onto one radius and
    // flattened the sphere onto the containment shell. That is why the
    // clusters read as flat dots. The centre is
    // clamped instead, so the cluster keeps its shape. uClusterBound is a
    // uniform: MCS.setClusterBound().
    float clen = length(centre);
    vec3 c = clen > uClusterBound ? centre * (uClusterBound / clen) : centre;
    // Follow the pointer lean. The body translates toward the cursor by
    // uRadius * 0.22 (see the body path below); a cluster that stayed put
    // simply got run over by it. Same translation, same eased uPull, so the
    // gap between body and cluster is preserved instead of being closed.
    vec2 pl = uPull;
    vec3 pdir = vec3(pl.x, -pl.y, 0.0);
    float pgrav = min(1.0, length(pdir));
    if (pgrav > 0.001) c += normalize(pdir) * pgrav * uRadius * uClusterPull;
    vec3 p = c + aHome * spread * uRadius;
    // Drift in the cluster's OWN frame, scaled to its own radius. It used to
    // sample curl at the WORLD position p and displace by a flat 0.04. Both
    // were wrong: a flat amount is 25% of this cluster's radius, so it stopped
    // holding its shape; and sampling at the world position means the cluster
    // is dragged through the noise field as it orbits, which threw it onto
    // paths it was not orbiting. Offset per slot so no two drift alike.
    vec3 doff = vec3(float(idx) * 7.31, float(idx) * 3.17, float(idx) * 5.93);
    p += curl(aHome * 1.7 + doff, uTime * ${glf(CLUSTER.driftRate)}) * ${glf(CLUSTER.drift)} * spread * uRadius;

    // Additive blending SUMS every grain along a ray, so the per-point fade
    // has to fall as the points get denser or the cluster clips to white.
    // uClusterFade is calibrated for the idle density; the two ratios cancel
    // the density change from tightening (spread) and from the larger grain
    // (ptf), so brightness no longer rides on those. workBoost is then the
    // deliberate, bounded "this one is working" signal on top.
    float sp0 = ${glf(CLUSTER.spread)};
    float k = (spread / sp0) * (0.7 / ptf);   // spread already carries sizeVar
    vFade = uClusterFade * k * k * (1.0 + ${glf(CLUSTER.workBoost)} * working);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vDepth01 = clamp((-mv.z - 2.2) / 2.0, 0.0, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uRadius * (uPointScale / max(0.001, -mv.z)) * (0.7 + working * 0.5);
    return;
  }

  // Each particle runs a lifetime offset by its seed, so the cloud never
  // pulses in unison. At the end of a life it returns to its home point.
  float life = mod(uTime / uLife + aSeed, 1.0);

  // Three fixed Euler steps along the curl field: real transport away from
  // aHome, not an oscillation around it. Constant loop bound, so the shader
  // compiles on every WebGL2 driver.
  const int STEPS = 3;
  vec3 p = aHome;
  // act is the shaping curve every activity lever below rides on, not
  // uActivity directly. A single real tool call decays in well under a
  // second (S.activity *= 0.972/frame in app.js), so a sparse, realistic
  // working cadence mostly sits in the 0.1–0.4 range and rarely reaches 1.0
  // — a linear response there measures as a real but
  // easy-to-miss change. sqrt front-loads the curve so that range already
  // reads as clearly different, while still topping out at the same place.
  float act = sqrt(uActivity);
  // Thinking speeds the stream, up to 4x at full activity. This is the
  // loudest of the activity levers — faster-moving grains read as
  // turbulence at a glance in a way a static shape change does not.
  float dt = life * uFlow * (1.0 + act * 3.0) / float(STEPS);
  for (int i = 0; i < STEPS; i++) p += curl(p, uTime * 0.08) * dt;

  // Direction and radius, separately: the structure lives in the direction,
  // the volume in the radius. This is the old 72% shell blend, which only
  // ever changed the radius (p and shell are parallel).
  //
  // length(p) is clamped to a sane band BEFORE it
  // reaches the blend. This is the second line of defense behind curl()'s
  // own normalization above, and the one that actually makes the bound
  // provable rather than merely "tuned to look right today": with curl()
  // now a unit vector, a mistuned uFlow or a future activity lever could
  // still, in principle, push length(p) arbitrarily far given enough dt —
  // this clamp is what stops that from ever reaching the panel regardless.
  // RADIUS_CLAMP_MIN/MAX and SHELL_BLEND are imported from swarm-math.js,
  // not hand-copied, so the shader and maxBodyRadius()/minBodyRadius() (the
  // harness assertion in test/swarm-harness.mjs) cannot silently drift
  // apart. Symptom when this band is ever removed or widened past what the
  // panel can show: the sphere fills the panel as a flat rectangle — the
  // silhouette is off-screen, not absent.
  vec3  nrm = normalize(p);
  float rad = mix(clamp(length(p), ${RADIUS_CLAMP_MIN.toFixed(4)}, ${RADIUS_CLAMP_MAX.toFixed(4)}), 1.0 + uThickness * (aSeed - 0.5), ${SHELL_BLEND.toFixed(4)});

  // Crest capture. Runs on the ADVECTED direction, so the curl's tangential
  // motion becomes a slide along the crest and its normal motion is
  // absorbed; a particle whose advected point drifts across the watershed
  // between two crests is released into the dust and recaptured by the
  // next. The projection has no memory, so this is continuous in time.
  // Session particles (aRole 1) are never gathered.
  //
  // Activity retunes the vein network itself — reach widens (more of the
  // shell gets pulled toward a crest) and the sheath tightens (looser
  // particles pack onto the core) — rather than the shell's size. uRadius,
  // uPointScale and uBack define the silhouette and stay fixed on purpose,
  // so shape and mood stay glanceable and only the structure churns.
  float reach = uReach * (1.0 + act * 0.3);    // ×1.3 at full activity
  float loose = uLoose * mix(1.0, 0.5, act);   // ×0.5 — tighter, brighter cores
  float h    = fract(aSeed * 73.17);                        // second hash, decorrelated from life
  float bind = uGather * (1.0 - loose * h) * step(aRole, 0.5);
  float ph1  = uTime * uMorph;
  float ph2  = ph1 * 1.37 + 2.0;
  float vein = 0.0;
  float beat = 0.0;
  // RIPPLE: GATHER 2 -> 4 — the
  // bend's Jacobian is left out of the Newton step (quasi-Newton), so a
  // live ripple's front needs a couple of extra iterations to converge
  // cleanly. softened the ripple (bend/sigma now
  // 0.08/0.5, ~27% of the 0.6 no-fold bound, down from ~77%), so today's
  // margin is even more comfortable than when this was raised — kept at 4
  // rather than dropped back to 2, since cost was never the constraint.
  const int GATHER = 4;
  for (int i = 0; i < GATHER; i++) {
    // RIPPLE: evaluated at the CURRENT iterate, inside the loop, so each
    // Newton step samples the perturbed field at its own position (    // point 2) — sampling once outside the loop would converge to the
    // UNPERTURBED crest instead. Iris's centres are the view axis directly
    // (no precession/drift frame to convert through, unlike streams).
    vec3 nb; float kick; vec3 gk;
    ripples(nrm, nb, kick, gk, beat);
    vec4 f1 = crestField(nb, uVeinScale,
                         vec3( 0.0,  0.0,  0.0), vec3(17.3,  4.1, -9.6), ph1 + kick, gk);
    vec4 f2 = crestField(nb, uVeinScale * uBranchScale,
                         vec3(31.4, 17.7,  8.8), vec3(-9.2, 43.1, 23.5), ph2 + kick * 1.37, gk * 1.37);
    // Branches fade with distance from a trunk: full weight on and near the
    // coarse contour, uBranch of it 1.5·reach away. uBranch 1 is a lattice.
    float dTrunk = abs(f1.x) / max(length(f1.yzw), 1e-4);
    float trunk  = 1.0 - smoothstep(0.0, 1.5 * reach, dTrunk);
    float cap;
    nrm  = normalize(nrm + crestStep(nrm, f1, f2, reach, bind * mix(uBranch, 1.0, trunk), cap));
    vein = cap;
  }

  // RIPPLE: the body's own beat — a ring lifts the shell under its front.
  // Zero for shell (uRipLift is look-gated to 0 there, applyLook/LOOKS.shell
  // in swarm-math.js) — shell keeps its own pre-existing radial shove below
  // instead, the honest reaction of a cloud with no field to ripple.
  rad += uRipLift * beat;

  // Back onto the shell. Relief keeps captured particles slightly proud so
  // the veins read on the limb as well as the face.
  p = nrm * rad * (1.0 + vein * uRelief) * uRadius;

  // --- State mapping: pointer lean, pulses -------------------------------
  // Placed here: after the reassembled shell position
  // (not the raw advected one, so the gather is respected) and before fade /
  // far-hemisphere / project / size. Both are functions of where a particle
  // actually sits on the shell, which only exists now. Activity does NOT
  // touch p here — it retunes the vein network above and the brightness
  // below, never the shell's size (see the silhouette note above).

  // The pull vector arrives already eased by swarm.js's frame — the lag is
  // the whole difference between something attracted and something aimed.
  // The same asymmetry the 2D orb had: the near side swells by
  // pow(along, 1.5), the far side tucks by along².
  vec3 pullDir = vec3(uPull.x, -uPull.y, 0.0);
  float grav = min(1.0, length(pullDir));
  if (grav > 0.001) {
    vec3 axis = normalize(pullDir);
    float along = dot(normalize(p), axis);
    float lean = grav * (along > 0.0
      ? 0.34 * pow(along, 1.5)
      : -0.12 * along * along);
    p *= (1.0 + lean);
    p += axis * grav * uRadius * 0.22;
  }

  // Each pulse is a spherical shockwave that shoves particles outward as its
  // front passes them, then lets them fall back.
  float radial = length(p) / max(0.001, uRadius);
  for (int i = 0; i < 4; i++) {
    if (i >= uPulseCount) break;
    float age = uPulses[i].x;
    float front = 0.6 + age * 2.4;
    float band = 1.0 - smoothstep(0.0, 0.45, abs(radial - front));
    p += normalize(p) * band * uPulses[i].y * (1.0 - age) * 0.30 * uRadius;
  }

  // Fade in and out at the ends of the life so re-seeding is invisible.
  vFade = smoothstep(0.0, 0.15, life) * (1.0 - smoothstep(0.75, 1.0, life));

  // Dust stays visible — the silhouette and the sense of volume need it —
  // but the structure no longer depends on this ratio. It is geometric now.
  // Activity dims it further (×0.6 at full activity): less dust, brighter
  // veins, more contrast — not the shell as a whole getting bigger or paler.
  float dust = uDustFade * mix(1.0, 0.6, act);
  vFade *= mix(dust, 1.0, vein);

  // The far hemisphere is attenuated so the near network is not composited
  // over its own mirror image. Also gives the shell a front and a back.
  float facing = (normalMatrix * nrm).z;
  vFade *= mix(uBack, 1.0, smoothstep(-0.5, 0.35, facing));
  // RIPPLE: a brief brightening at a ring's front. Zero for shell (uRipGlow
  // look-gated to 0 there), same reasoning as uRipLift above.
  vFade *= 1.0 + uRipGlow * clamp(beat / 0.08, 0.0, 1.0);

  // CONTAIN: the truly final p — after the shell blend, the
  // pointer's lean and every active pulse shockwave — never the raw
  // pre-blend length(p) RADIUS_CLAMP_MIN/MAX alone bounds. See contain's
  // own doc comment above (CHUNK_RIPPLE) for why this is a backstop, not a
  // second copy of that clamp's job.
  p = contain(p);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDepth01 = clamp((-mv.z - 2.2) / 2.0, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
  // uPointScale drives point size alone — untouched by activity, same as
  // uRadius and uBack: these three define the silhouette and stay fixed so
  // shape stays glanceable regardless of what the vein network is doing.
  gl_PointSize = aSize * uRadius * (uPointScale / max(0.001, -mv.z)) * (0.85 + vein * 0.3);
}
`

const FRAG = `
precision highp float;

uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uAlpha;
uniform float uActivity;   // same value the vertex stage reads — see its declaration for why
uniform float uFadeMul;    // mode-switch fade, 1 = normal, 0 = fully dark mid-swap
// Orchestrator thinking indicator, the same uniform streams carries. A COLOUR
// multiplier, not an alpha one: this material is additively blended, so
// intensity accumulates past 1 where alpha would simply clamp. Base 1 is the
// exact identity, so an idle iris/shell is unaffected by it.
uniform float uGlow;

varying float vFade;
varying float vDepth01;

void main() {
  // A resolved grain, not a glow: falloff is tight against the sprite edge,
  // and overall opacity is kept low so 30,000 additively-blended grains read
  // as a streaming shell rather than saturating to a solid core.
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.22, r);

  vec3 col = mix(uColorA, uColorB, vDepth01);
  // uAlpha itself is untouched (0.17, tuned by eye) — this is a multiplier on
  // top of it, ×1.35 at full activity, the one place brightness is allowed
  // to move. Same sqrt shaping as the vertex stage: see uActivity there.
  float act = sqrt(uActivity);
  gl_FragColor = vec4(col * uGlow, a * vFade * uAlpha * uFadeMul * (1.0 + act * 0.35));
}
`

// ===========================================================================
// Streams. Closed-form differential
// rotation under crest capture, replacing the VERT/FRAG above's curl
// advection entirely for this look: no lifetime, no re-seed, no fade — a
// grain holds a heading instead of jittering -- without that, the grains read
// as a scatter of insects rather than as a current.
//
// Architecture: a shared chunk library composed into each look's own
// `main` — GLSL has no imports, but shader source is a plain string, so
// the chunks below are JS string constants joined at material-build time.
// iris/shell above are NOT rewritten onto this chunk library: the task brief
// pins iris's shader, geometry (BODY 30000) and tuning as settled and
// forbids retuning it, and a shared geometry across a 30k-particle look and
// a 150k-particle look is not possible without breaking one of the two — so
// this build has TWO geometries/materials/Points (legacy, streams), each
// its own draw call, only one visible at a time (still "one draw call"
// rendered per frame's requirement — just not literally one
// GPU buffer shared by every look, which iris's pin rules out).
//
// glslVersion: GLSL3 is set on this material (the vendored bundle
// already compiles every ShaderMaterial as `#version 300 es`; GLSL3 only
// removes the `pc_fragColor` shim, so these chunks are written directly in
// `in`/`out` syntax rather than `attribute`/`varying`).

// ---- PRELUDE: shared by every look that adopts this chunk library --------
// Trimmed PRELUDE: aRole/aSession are omitted
// here rather than declared-and-unbound -- the looks built on this chunk
// library render sessions through the claim table, not through those
// attributes -- because a declared-and-unbound attribute would otherwise log
// a console attribute warning for every frame. Check the browser console
// before any visual work.
const CHUNK_PRELUDE = `
precision highp float;

in float aSeed;
in vec3  aHome;
in float aSize;

uniform float uTime;         // visible seconds, accumulated; only ever inside slow sinusoids
uniform float uRadius;
uniform float uPointScale;   // physical pixels, DPR-aware — never a bare literal
uniform float uThickness;
uniform float uBack;         // far-hemisphere brightness
uniform float uFade;         // transition: whole-look brightness, 0..1
`

// ---- NOISE: verbatim from the legacy VERT above (mod289 through snoised) -
const CHUNK_NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

vec4 snoised(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  vec4 m2 = m * m;
  vec4 m4 = m2 * m2;
  vec4 px = vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3));
  vec4 m3px = m2 * m * px;
  vec3 grad = -8.0 * (m3px.x * x0 + m3px.y * x1 + m3px.z * x2 + m3px.w * x3)
            + m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
  return 42.0 * vec4(dot(m4, px), grad);
}
`

// ---- CAPTURE: shared by every look that gathers ---------------------------
const CHUNK_CAPTURE = `
// Rodrigues: rotate v about the unit axis a by angle t.
vec3 rot(vec3 v, vec3 a, float t) {
  float c = cos(t), s = sin(t);
  return v * c + cross(a, v) * s + a * (dot(a, v) * (1.0 - c));
}

// Domain warp of a unit-sphere point: a slow vector noise bends where the
// crest field is sampled, so contours bend, hook and pinch instead of
// wiggling evenly. Bounded by amp, so it deforms in place and never scrolls.
// Its Jacobian is left out of the Newton gradient (quasi-Newton); at
// amp <= 0.3 three steps still converge to under a milliradian.
vec3 warpN(vec3 n, float amp, float phase) {
  vec3 w = vec3(
    snoise(n * 1.3 + vec3( 7.1,  2.3, phase)),
    snoise(n * 1.3 + vec3(-3.7, 11.9, phase)),
    snoise(n * 1.3 + vec3(13.3, -8.1, phase)));
  return normalize(n + amp * (w - n * dot(w, n)));
}

// The evolving crest field sampled through an anisotropic map about the
// axis f: the component of n along f is scaled by along, the rest by
// across. along >> across -> channels running AROUND f (streams, f = the
// flow axis); across >> along -> ridges along meridians (iris, f = the view
// axis); equal -> the isotropic lattice. The map is linear, so it is
// continuous everywhere, poles included. cos/sin of two fields: constant
// variance, evolves in place. Returns vec4(value, tangential gradient w.r.t. n).
vec4 crestField(vec3 n, vec3 f, float along, float across, vec3 offA, vec3 offB, float phase) {
  float a  = dot(n, f);
  vec3  q  = (n - f * a) * across + f * (a * along);
  vec4  na = snoised(q + offA);
  vec4  nb = snoised(q + offB);
  vec4  v  = na * cos(phase) + nb * sin(phase);
  vec3  gq = v.yzw;
  vec3  g  = gq * across + f * (dot(f, gq) * (along - across));   // chain rule through the map
  g -= n * dot(g, n);
  return vec4(v.x, g);
}

// Reactive layer — one added overload,
// nothing removed: the 7-argument crestField above still compiles and
// still works for any caller that passes no kick. gradPhase is the kick's
// spatial gradient on the sphere; the extra term is exact — d/dn[cos phi*a +
// sin phi*b] picks up (b*cos phi - a*sin phi)*grad(phi) — so the Newton step
// stays honest under a kick whose front is only a few sigma wide.
vec4 crestField(vec3 n, vec3 f, float along, float across, vec3 offA, vec3 offB,
                float phase, vec3 gradPhase) {
  float a  = dot(n, f);
  vec3  q  = (n - f * a) * across + f * (a * along);
  vec4  na = snoised(q + offA);
  vec4  nb = snoised(q + offB);
  float cp = cos(phase), sp = sin(phase);
  vec4  v  = na * cp + nb * sp;
  vec3  gq = v.yzw;
  vec3  g  = gq * across + f * (dot(f, gq) * (along - across));
  g += (nb.x * cp - na.x * sp) * gradPhase;
  g -= n * dot(g, n);
  return vec4(v.x, g);
}

// One Newton step of n toward the zero set of F = f1.x * f2.x — the union of
// both families' zero contours. Inside fall*reach a particle is carried
// fully onto the crest; between fall*reach and reach it is released
// smoothly (this is what stops popping, and the steepness of this window is
// the "fall": a grain entering it accelerates onto the crest at
// 1/(1-fall) times its approach speed); beyond reach it is untouched.
// capture is how strongly it was held, weight included; tangent is the
// crest direction at n, unoriented.
vec3 crestStep(vec3 n, vec4 f1, vec4 f2, float reach, float fall, float weight,
               out float capture, out vec3 tangent) {
  float F  = f1.x * f2.x;
  vec3  G  = f2.x * f1.yzw + f1.x * f2.yzw;
  float gl = max(length(G), 1e-4);
  float d  = abs(F) / gl;
  capture  = (1.0 - smoothstep(fall * reach, reach, d)) * weight;
  tangent  = normalize(cross(n, G / gl) + vec3(1e-6, 0.0, 0.0));
  return -sign(F) * min(d, reach) * capture * (G / gl);
}
`

// ---- LIFT: per-channel radial life ----------------------------------------
// Composed into STREAMS_VERT after CHUNK_RIPPLE, before the
// streams uniforms/main chunk — iris does not use it. A radial lift
// field in the lattice frame, in (s, phi) about the flow axis: a
// random-phase Fourier synthesis — sines only, exact in the JS twin — with
// latitude wavenumbers spread across one to three channel spacings, so
// adjacent channels are out of phase, and integer longitude wavenumbers,
// so a channel rises in arcs and the field is continuous across
// phi = +/-pi. Mapped through an asymmetric quadratic: channels rise a
// little (uLiftOut) and sink a lot (uLiftIn, into the body). Applied to
// CAPTURED grains only (x vein, in main): dust never lifts, so the orb
// stays the orb. Phases accumulate on the CPU and wrap at 2*pi exactly.
const CHUNK_LIFT = `
const int LIFT_MODES = 6;
uniform vec4  uLiftMode[LIFT_MODES];   // x wavenumber in s, y wavenumber in phi (integer), z amplitude (six sum to 1), w unused
uniform float uLiftPh[LIFT_MODES];     // accumulated phase per mode, rad, wrapped
uniform vec3  uAxisU;                  // static: unit, perpendicular to the flow axis — the longitude origin
uniform vec3  uAxisV;                  // static: cross(axis, uAxisU)
uniform float uLiftOut;                // max rise above the shell, radii      0.12  (0.05-0.14)
uniform float uLiftIn;                 // max sink below it                     0.30  (0.10-0.40)
// Depth-cue uniforms — three mutually exclusive states (MCS.setDepthCue),
// each individually correct rather than one compromised for another:
// fade uSinkFadeOn 1: a sunken channel dims away below uSinkFade.
// occluder uSinkFadeOn 0, the occluder mesh visible + depthTest true:
// a sunken channel is cut off by depth instead of dimmed.
// none uSinkFadeOn 0, occluder hidden: fully transparent, the
// pre-lift rendering exactly — neither term active.
uniform float uSinkFade;               // radius below which a sunken grain has faded out, fade mode only   0.86  (0.80-0.95)
uniform float uSinkFadeOn;             // 1 = apply the fade term, 0 = skip it entirely (occluder/none modes)

// Returns the lift in radii at the lattice-frame point n; g is the raw
// field in [-1, 1], exposed for the harness and for brightness.
float liftField(vec3 n, vec3 axis, out float g) {
  float s   = dot(n, axis);
  float phi = atan(dot(n, uAxisV), dot(n, uAxisU));
  g = 0.0;
  for (int m = 0; m < LIFT_MODES; m++) {
    g += uLiftMode[m].z * sin(uLiftMode[m].x * s + uLiftMode[m].y * phi + uLiftPh[m]);
  }
  float a = 0.5 * (uLiftOut + uLiftIn);
  float b = 0.5 * (uLiftOut - uLiftIn);
  return a * g + b * g * g;
}
`

// ---- STREAMS uniforms + vertex main --------------------------------------
// Transport shape (uAxis, uBands, uShearRate, uPrecAxis) is fixed
// for the page's life; angles are accumulated on the CPU (Rule A) — uAngle
// wraps at 20*PI because lane factors are tenths (LOOKS.streams.wrap). Session
// bands, pointer lean and pulses ride their own uniforms below; iris/shell
// carry the same three through the legacy shader. ---------------------------
const STREAMS_UNIFORMS_MAIN = `
uniform vec3  uAxis;
uniform float uAngle;
uniform float uShear;
uniform float uShearRate;
uniform float uBands;
uniform float uLatticeAngle;
uniform vec3  uPrecAxis;
uniform float uPrec;
uniform float uScaleAlong;
uniform float uScaleAcross;
uniform float uBranchScale;
uniform float uBranch;
uniform float uWarp;
uniform float uGather;
uniform float uReach;
uniform float uFall;
uniform float uLoose;
uniform float uPhaseA;
uniform float uPhaseB;
uniform float uRelief;
uniform float uDustFade;
uniform float uShimmer;
uniform float uTurb;
uniform float uStretch;

// iris's pointer lean, ported into streams. Same uniform name, same shape as
// the legacy VERT above, fed from the SAME JS-side state (swarm.js's pull
// vector) — never a second easing.
//
// Feeding the legacy radial shove here made grains puff outward with the
// pattern static, so uPulses is fed only for shell: uPulses/uPulseCount are GONE from
// this shader — the old radial shockwave they drove is superseded here by
// the field ripple (uRipA/uRipB, declared in CHUNK_RIPPLE, composed in
// above this chunk); the legacy shockwave code stays, feeding only the
// legacy material now, for shell — see MCS.frame.
uniform vec2  uPull;

out float vFade;
out float vShade;
out vec2  vDir;
out float vStretch;
out float vAccent;    // SESSION: accent mix handed to the fragment stage
out vec3 vAccentCol;   // SESSION: the band's accent colour

void main() {
  // ---- 1. Transport: closed-form differential rotation with lanes.
  float h      = fract(aSeed * 73.17);
  float lane   = floor(h * 6.0) / 5.0;
  float factor = 1.2 - 0.5 * lane;
  float s      = dot(aHome, uAxis);
  float shear  = uShear * sin(uTime * uShearRate + s * 3.0) * cos(uBands * 3.14159265 * s);
  vec3  nrm    = rot(aHome, uAxis, uAngle * factor + shear);

  // ---- 2. Into the lattice frame (rigid drift about the flow axis).
  vec3 nl = rot(nrm, uAxis, -uLatticeAngle);
  vec3 f  = uAxis;

  // ---- 3. Crest capture through the rippled, warped, zonally stretched
  // field. RIPPLE: the bend and kick are evaluated at the CURRENT iterate so
  // the sampled field is the perturbed field at that point; the kick's
  // gradient rides into the Newton step through the 8-argument crestField.
  // GATHER 3 -> 4: the bend's
  // Jacobian is left out of the step (quasi-Newton); the extra iteration
  // buys back the residual near a live ripple's front — cost is not a
  // constraint here. (softened the ripple further —
  // bend/sigma now 0.08/0.5 — so today's margin is even more comfortable
  // than when this was raised; see the legacy VERT's own comment above.)
  float bind = uGather * (1.0 - uLoose * (0.7 * lane + 0.3 * h));
  float vein = 0.0;
  float beat = 0.0;
  vec3  tangent = vec3(1.0, 0.0, 0.0);
  const int GATHER = 4;
  for (int i = 0; i < GATHER; i++) {
    vec3 nb; float kick; vec3 gk;
    ripples(nl, nb, kick, gk, beat);
    vec3 nwp = warpN(nb, uWarp, uTime * 0.02);
    vec4 f1 = crestField(nwp, f, uScaleAlong, uScaleAcross,
                         vec3( 0.0,  0.0,  0.0), vec3(17.3,  4.1, -9.6), uPhaseA + kick, gk);
    vec4 f2 = crestField(nwp, f, uScaleAlong * uBranchScale, uScaleAcross * uBranchScale,
                         vec3(31.4, 17.7,  8.8), vec3(-9.2, 43.1, 23.5), uPhaseB + kick * 1.37, gk * 1.37);
    float dTrunk = abs(f1.x) / max(length(f1.yzw), 1e-4);
    float trunk  = 1.0 - smoothstep(0.0, 1.5 * uReach, dTrunk);
    float cap;
    vec3 stp = crestStep(nl, f1, f2, uReach, uFall, bind * mix(uBranch, 1.0, trunk), cap, tangent);
    nl   = normalize(nl + stp);
    vein = cap;
  }

  // ---- 4. Turbulence on the captured position, activity-driven.
  float lift = 0.0;
  if (uTurb > 0.0005) {
    vec4 tn = snoised(nl * 2.5 + vec3(5.0, -3.0, uTime * 0.15));
    vec3 gt = tn.yzw - nl * dot(tn.yzw, nl);
    nl   = normalize(nl + cross(nl, gt) * uTurb);
    lift = tn.x * uTurb * 1.5;
  }

  // ---- 5. Out of the lattice frame; a ribbon with a cross-section.
  // RIPPLE: the body's own beat — a ring lifts the shell under its front.
  // LIFT: captured grains rise and sink with their channel's own field;
  // dust (vein 0) stays on the shell, so the body is the body.
  // ---- 4b. SESSION: which claimed band, if any, holds this grain's channel.
  // Evaluated after capture (nl is on the crest, so its latitude is the
  // channel's) and gated by vein — dust is never anyone's channel.
  float heat, burn; vec3 accent;
  float sessP = sessionBand(nl, uAxis, heat, burn, accent) * vein;          // SESSION
  float sessB = sessP * burn;                                                // SESSION: the brightness weight

  float gLift;
  float liftOrd = liftField(nl, uAxis, gLift);                              // LIFT
  // SESSION: a claimed channel keeps the same field, the same clock and the
  // same arcs — remapped into the TOP of the envelope rather than given a
  // taller one. Never below the shell, held higher while working. liftHeld is
  // <= uLiftOut always, so ceiling assertion is untouched. Rise had to
  // work this way: contain compresses from SAFE_RADIUS (~1.048), which is
  // already below the lift's own peak, so there is no headroom by height.
  float floorS  = mix(uSessFloorIdle, uSessFloorWork, heat);                // SESSION
  float liftHeld = uLiftOut * (floorS + (1.0 - floorS) * (0.5 + 0.5 * gLift));
  float liftR   = mix(liftOrd, liftHeld, sessP) * vein;                     // LIFT + SESSION
  nrm = rot(nl, uAxis, uLatticeAngle);
  float rad = 1.0 + uThickness * (aSeed - 0.5) * (0.4 + 0.6 * lane)
            + mix(uRelief, uSessRelief, sessP * heat) * vein * (1.0 - lane) + lift // SESSION: core stands prouder while working
            + uRipLift * beat
            + liftR;                                                        // LIFT
  vec3 nw = rot(nrm, uPrecAxis, uPrec);
  vec3 p  = nw * rad * uRadius;

  // ---- 5b. Pointer lean — ported verbatim from iris/legacy's own pointer
  // response (see the "State mapping: pointer lean, pulses" block in the
  // legacy VERT above). uPull arrives already eased by swarm.js's frame
  // the SAME pull vector, the SAME 0.045/frame easing as iris — so this
  // is a lookup, not a second easing; the lag (the target
  // snaps, the body eases after it) is what reads as attracted rather than
  // aimed, and that lag lives entirely on the JS side. This is the BODY
  // lean — the only pointer reaction left's field ripple under the
  // cursor is removed (see swarm-math.js's RIPPLE table comment and the
  // spec amendment).
  // Placed after the reassembled shell position (p, above) and before flow
  // direction / color / project / size, same ordering rule
  // gives iris: the gather must be respected first, the lean only ever
  // nudges the result.
  vec3 pullDir = vec3(uPull.x, -uPull.y, 0.0);
  float grav = min(1.0, length(pullDir));
  if (grav > 0.001) {
    vec3 axis = normalize(pullDir);
    float along = dot(normalize(p), axis);
    float lean = grav * (along > 0.0
      ? 0.34 * pow(along, 1.5)
      : -0.12 * along * along);
    p *= (1.0 + lean);
    p += axis * grav * uRadius * 0.22;
  }

  // ---- 6. Flow direction on screen: zonal for dust, the crest tangent
  // oriented downstream for captured grains.
  vec3 zonalL = cross(uAxis, nl);
  vec3 tanL   = tangent * sign(dot(tangent, zonalL) + 1e-6);
  vec3 dirW   = rot(rot(normalize(mix(zonalL, tanL, vein)), uAxis, uLatticeAngle), uPrecAxis, uPrec);
  vec3 dirV   = normalMatrix * dirW;
  float flat_ = length(dirV.xy);
  vDir     = flat_ > 1e-4 ? dirV.xy / flat_ : vec2(1.0, 0.0);
  vStretch = mix(1.0, uStretch, smoothstep(0.0, 0.5, flat_));

  // CONTAIN: the truly final p, after the shell thickness/relief/
  // lift blend and the pointer lean. See contain's own doc comment
  // (CHUNK_RIPPLE, above) — vDir was already derived from nl/tangent above,
  // not from p, so containment here changes only where the grain projects,
  // never its rendered flow direction.
  p = contain(p);

  // ---- 7. Brightness and colour. No lifetime envelope: a slow breath only.
  // RIPPLE: a brief brightening at a ring's front.
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth01 = clamp((-mv.z - 2.2) / 2.0, 0.0, 1.0);
  float shimmer = 1.0 - uShimmer * 0.5 * (1.0 + sin(uTime * 0.9 + aSeed * 37.0));
  float facing  = (normalMatrix * nw).z;
  vFade  = uFade * shimmer * mix(uDustFade, 1.0, vein) * mix(uBack, 1.0, smoothstep(-0.5, 0.35, facing));
  vFade *= 1.0 + uRipGlow * clamp(beat / 0.08, 0.0, 1.0);
  // LIFT: the fade depth cue — a risen channel is brighter, a sunken one
  // dims away, EXACTLY the pre-lift render when uSinkFadeOn is 0 (mix's
  // first arg, 1.0, is the identity). Three mutually exclusive states,
  // MCS.setDepthCue: 'fade' (uSinkFadeOn 1, this term active, the shipped
  // default), 'occluder' (0 — the mesh's depth write hides a sunken
  // channel instead, so stacking this term on top would double-dim),
  // 'none' (0, occluder hidden too — fully transparent, reproducing the
  // render from before this feature existed). Keyed on rad, the
  // pre-contain radius in shell units, not length(p), so the pointer lean
  // and contain can never fade a grain that has not actually sunk.
  vFade *= mix(1.0, (1.0 + 1.5 * liftR) * smoothstep(uSinkFade, uSinkFade + 0.08, rad), uSinkFadeOn);   // LIFT
  vFade *= 1.0 + uSessBright * sessB;                                       // SESSION: burn, not a flag
  vShade = clamp(0.5 * lane + 0.4 * (1.0 - vein) + 0.3 * depth01, 0.0, 1.0);
  // SESSION: a claimed channel's BANKS are lit toward colour A, where every
  // other channel's banks are dark — that contrast is most of why the ribbon
  // reads as the loudest structure on the orb. The 0.5 is a documented
  // literal, not a uniform; drop it to 0.3 if the ribbon reads flat.
  vShade *= 1.0 - 0.5 * sessP;                                              // SESSION
  vAccent = uSessTint * sessP * mix(0.5, 1.0, heat);                        // SESSION: half-strength while idle
  vAccentCol = accent;                                                      // SESSION

  gl_Position  = projectionMatrix * mv;
  float size   = aSize * uRadius * (uPointScale / max(0.001, -mv.z)) * (1.0 - 0.25 * lane);
  gl_PointSize = max(1.5, size * sqrt(vStretch) * (1.0 + uSessSize * sessB));   // SESSION: coverage
}
`

// ---- SESSION: a session claims a latitude band ----------------------------
// A channel in streams is a fixed band of s = dot(n, uAxis), conserved by the
// transport, the shear and the lattice drift (all rotations about the flow
// axis), so a claimed band never drifts and needs no accumulated angle.
// Membership is a soft window on the POST-CAPTURE latitude — the channel's,
// not the grain's home — and is gated by `vein` in main, so dust is never
// anyone's channel. Claims are eased on the CPU and keyed by session id
// (advanceClaims, swarm-math.js). No new attribute: every grain already
// computes its own s.
const CHUNK_SESSION = `
const int SESS = ${SESSION_BANDS.length};
uniform vec4  uSess[SESS];        // x band centre s (lattice frame), y claim 0..1, z heat 0..1 (working|waiting|error), w burn 0..1
uniform vec3  uSessColor[SESS];   // the band's eased accent — its session's STATE colour, written every frame
uniform float uSessOn;         // master gate: 0 = bit-identical to the pre-session render        1
uniform float uSessHalfWidth;  // band half-width in s                                            0.11 (0.09-0.19)
uniform float uSessEdge;       // full weight inside this |ds|, feathering to 0 at the half-width  0.06 (0.03-halfWidth)
uniform float uSessFloorIdle;  // held channel's lift floor, x uLiftOut, claimed and idle          0.15 (0.05-0.35)
uniform float uSessFloorWork;  // ... claimed and working                                          0.55 (0.40-0.75)
uniform float uSessRelief;     // core relief on a working session's channel                       0.08 (uRelief-MAX_RELIEF)
uniform float uSessBright;     // vFade boost while working                                        0.5  (0-1)
uniform float uSessSize;       // point-size boost while working                                   0.25 (0-0.5)
uniform float uSessTint;       // accent mix on a claimed channel (x0.5 idle, x1 working)          0.55 (0.3-0.8)

// Membership of the lattice-frame point n in the strongest claimed band.
// Returns band * claim (0..1) and hands back that band's heat, burn and accent.
float sessionBand(vec3 n, vec3 axis, out float heat, out float burn, out vec3 accent) {
  float sc = dot(n, axis);
  float best = 0.0;
  heat = 0.0; burn = 0.0; accent = vec3(0.0);
  for (int i = 0; i < SESS; i++) {
    vec4 S = uSess[i];
    if (S.y <= 0.0) continue;
    float b = (1.0 - smoothstep(uSessEdge, uSessHalfWidth, abs(sc - S.x))) * S.y;
    if (b > best) { best = b; heat = S.z; burn = S.w; accent = uSessColor[i]; }
  }
  return best * uSessOn;
}
`

const STREAMS_VERT = [CHUNK_PRELUDE, CHUNK_NOISE, CHUNK_CAPTURE, CHUNK_RIPPLE, CHUNK_LIFT, CHUNK_SESSION, STREAMS_UNIFORMS_MAIN].join('\n')

// ---- STREAMS fragment: an elongated grain, over-blended -------------------
// Over-blending (matter), not additive (light, iris's own): the material's
// `blending: NormalBlending`
// below is what makes that true — this shader has no blend-mode opinion of
// its own, same as any three ShaderMaterial.
const STREAMS_FRAG = `
precision highp float;

uniform vec3  uColorA;
uniform vec3  uColorB;
uniform float uAlpha;
// Glow — streams has to glow more like iris does.
// iris glows because it is ADDITIVE (overlapping grains sum toward white);
// streams is deliberately OVER-blended ("matter, not light") and that is not
// changing here — this is
// the cheap lever WITHIN over-blending: a brightness multiplier on the
// mixed colour, pushed past 1.0 so a grain's core can clip toward white
// the way a bright highlight does, without switching the blend mode. What
// this CANNOT reach: iris's actual bloom, which comes from many additive
// layers summing unboundedly bright wherever grains overlap — no
// per-grain multiplier reproduces an effect that depends on overlap
// count. The blend mode stays over-blending because the lift, the ripple
// and the depth cue are all tuned against it; closing that gap means a
// bloom pass or an additive blend, and either retunes all three.
uniform float uGlow;
in float vFade;
in float vShade;
in vec2  vDir;
in float vStretch;
in float vAccent;   // SESSION
in vec3 vAccentCol;   // SESSION: the band's own accent, per grain

out vec4 outColor;

void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  vec2 e = vec2(dot(d, vDir), dot(d, vec2(-vDir.y, vDir.x)) * vStretch);
  float r = length(e);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.22, r) * vFade * uAlpha;
  // SESSION: vAccent is 0 for every unclaimed grain, so mix's first arg is
  // the exact identity and the render is bit-for-bit the pre-session one
  // whenever no band is claimed or uSessOn is 0.
  vec3 col = mix(uColorA, uColorB, vShade);
  col = mix(col, vAccentCol, vAccent);                                      // SESSION
  outColor = vec4(col * uGlow, a);
}
`

/** Streams' own Fibonacci-sphere geometry (BODY_STREAMS, no session slots —
 * session support is a hook point, not part of this task). Vertex
 * order shuffled once at build: unsorted
 * over-blending's only systematic residue is the Fibonacci buffer's
 * top-to-bottom order, and a one-time shuffle turns that into noise. */
const buildStreamsGeometry = () => {
  const n = BODY_STREAMS
  const homes = fibonacciHomes(n)
  const order = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0
    ;[order[i], order[j]] = [order[j], order[i]]
  }

  const home = new Float32Array(n * 3)
  const seed = new Float32Array(n)
  const size = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    const slot = order[k]
    home[slot * 3 + 0] = homes[k][0]
    home[slot * 3 + 1] = homes[k][1]
    home[slot * 3 + 2] = homes[k][2]
    seed[slot] = Math.random()
    size[slot] = 0.9 + Math.random() * 0.6
  }

  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(home.slice(), 3)) // three requires it
  g.setAttribute('aHome', new BufferAttribute(home, 3))
  g.setAttribute('aSeed', new BufferAttribute(seed, 1))
  g.setAttribute('aSize', new BufferAttribute(size, 1))
  return g
}

/** Streams' own material: glslVersion GLSL3, over-blending, its own uniform
 * set built from LOOKS.streams — never hand-copied numbers (the harness
 * asserts against this same LOOKS.streams.p, so a drift here would show up
 * as the harness testing a copy). */
const buildStreamsMaterial = (mood) => {
  const look = LOOKS.streams
  const p = look.p
  return new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: STREAMS_VERT,
    fragmentShader: STREAMS_FRAG,
    transparent: true,
    depthWrite: false,
    // Lift — depthTest starts false (the
    // 'fade'/'none' depth-cue states: nothing else in the scene writes
    // depth while the occluder is hidden, so this is a no-op, stated
    // rather than assumed, same as before this feature existed).
    // MCS.setDepthCue('occluder') flips it true so the occluder's depth
    // write actually does something; every other state flips it back.
    depthTest: false,
    blending: NormalBlending,   // over — matter, not light; iris keeps additive
    uniforms: {
      uTime: { value: 0 }, uRadius: { value: 1.0 },
      // 3.6*dpr's N*alpha*size^2 rule at 150k/0.12 — a different
      // number from legacy's 5.0*dpr on purpose, own material, own uniform.
      uPointScale: { value: 3.6 * dpr },
      uThickness: { value: 0.10 }, uBack: { value: 0.3 }, uFade: { value: 1 },
      uColorA: { value: new Color(mood.a) }, uColorB: { value: new Color(mood.b) },
      uAlpha: { value: look.alpha },
      // Glow — the cheap "read as glowing, not matte" lever within
      // over-blending: 1.6x colour intensity, walkable live via
      // MCS.setStreams('uGlow', x). 1.0 = no boost, the unlit look.
      // MCS.frame multiplies this base by thinkingGlowMult every frame, so
      // the value here matters only before the first frame runs its own
      // write (or if streams never becomes visible at all).
      uGlow: { value: STREAMS_BASE_GLOW },
      uAxis: { value: FLOW_AXIS.slice() }, uAngle: { value: 0 }, uShear: { value: p.shear },
      uShearRate: { value: SHEAR_RATE }, uBands: { value: BANDS }, uLatticeAngle: { value: 0 },
      uPrecAxis: { value: PREC_AXIS.slice() }, uPrec: { value: 0 },
      uScaleAlong: { value: p.scaleAlong }, uScaleAcross: { value: p.scaleAcross },
      uBranchScale: { value: p.branchScale }, uBranch: { value: p.branch }, uWarp: { value: p.warp },
      uGather: { value: p.gather }, uReach: { value: p.reach }, uFall: { value: p.fall },
      uLoose: { value: p.loose }, uPhaseA: { value: 0 }, uPhaseB: { value: 0 }, uRelief: { value: p.relief },
      uDustFade: { value: p.dustFade }, uShimmer: { value: p.shimmer }, uTurb: { value: 0 },
      uStretch: { value: p.stretch },
      // pointer lean, ported in from iris.
      // Written every frame in MCS.frame from the same `pull` vector the
      // legacy material's own uPull gets — see that write site's comment.
      uPull: { value: new Vector2(0, 0) },
      // Reactive layer — the field ripple.
      // uRipA/uRipB are written every frame from the shared `ripples` state,
      // converted into streams's own field frame (toStreamsField in
      // MCS.frame). Defaults match iris's own (table): 0.4/0.35.
      uRipA: { value: Array.from({ length: RIPPLE_SLOTS }, () => new Vector4()) },
      uRipB: { value: Array.from({ length: RIPPLE_SLOTS }, () => new Vector4()) },
      uRipLift: { value: 0.4 }, uRipGlow: { value: 0.35 },
      // Lift — uLiftMode/uAxisU/uAxisV are
      // static (built once from LIFT_MODES/AXIS_U/AXIS_V, the SAME table
      // the harness's field-only assertions run against); uLiftPh is
      // written every frame from streamsLiftPh (MCS.frame, below).
      uLiftMode: { value: LIFT_MODES.map(([ks, q, a]) => new Vector4(ks, q, a, 0)) },
      uLiftPh: { value: new Float32Array(6) },
      // Sessions — a session claims a latitude band. uSess is
      // rewritten every frame from `claims`; the rest are SESSION's own
      // defaults, walkable live via MCS.setStreams('uSessTint', x) etc.
      // uSessOn 0 makes the render bit-identical to the pre-session one.
      uSess: { value: Array.from({ length: SESSION_BANDS.length }, () => new Vector4(0, 0, 0, 0)) },
      uSessOn: { value: 1 },
      uSessHalfWidth: { value: SESSION.halfWidth }, uSessEdge: { value: SESSION.edge },
      uSessFloorIdle: { value: SESSION.floorIdle }, uSessFloorWork: { value: SESSION.floorWork },
      uSessRelief: { value: SESSION.relief }, uSessBright: { value: SESSION.bright },
      uSessSize: { value: SESSION.size }, uSessTint: { value: SESSION.tint },
      uSessColor: { value: Array.from({ length: SESSION_BANDS.length }, () => new Color(STATE_ACCENT.idle)) },
      uAxisU: { value: AXIS_U.slice() }, uAxisV: { value: AXIS_V.slice() },
      uLiftOut: { value: LIFT.out }, uLiftIn: { value: LIFT.inn },
      // Depth cue — 'fade' is the shipped default: the term is
      // active (uSinkFadeOn 1). MCS.setDepthCue flips uSinkFadeOn (and
      // depthTest/occluder.visible, above/below) for the other two states.
      uSinkFade: { value: LIFT.sinkFade }, uSinkFadeOn: { value: 1 },
    },
  })
}
// ===========================================================================

/** Fibonacci sphere — an even scatter with no polar clumping. */
const buildGeometry = () => {
  const home = new Float32Array(TOTAL * 3)
  const seed = new Float32Array(TOTAL)
  const role = new Float32Array(TOTAL)
  const session = new Float32Array(TOTAL)
  const size = new Float32Array(TOTAL)
  const golden = Math.PI * (3 - Math.sqrt(5))

  const arc = new Float32Array(TOTAL * 2)
  const tan = new Float32Array(TOTAL * 3)   // scribble: the spine direction a stream particle darts along
  const SESSION_END = BODY + MAX_SESSIONS * PER_SESSION
  for (let i = 0; i < TOTAL; i++) {
    if (i >= SESSION_END) {
      // A lightning arc point. Its aHome is its place on an already-crooked
      // polyline, so every jag is baked in and the shader only sweeps a head
      // along it and crackles.
      // A STREAM particle. It is not a point ON the spine — it is one of many
      // flowing ALONG it, so it carries the local tangent and darts down it.
      // Stratified in s with a jitter, so the stream is dense and even rather
      // than clumping the way pure random placement would.
      const c = i - SESSION_END
      const pid = Math.floor(c / SCRIBBLE.perArc)
      const k = c % SCRIBBLE.perArc
      const spine = ARC_PATHS[pid]
      const u = Math.min(0.9999, (k + Math.random()) / SCRIBBLE.perArc)
      const f = u * (spine.length - 1)
      const li = Math.min(spine.length - 2, Math.floor(f))
      const ft = f - li
      const a0 = spine[li], a1 = spine[li + 1]
      for (let z = 0; z < 3; z++) home[i * 3 + z] = a0[z] + (a1[z] - a0[z]) * ft
      // The tangent: which way "along the spine" points here. Taken across the
      // neighbouring segment so a particle sitting exactly on a jag inherits
      // the direction it is heading, not the corner's own degenerate one.
      const b0 = spine[Math.max(0, li - 1)], b1 = spine[Math.min(spine.length - 1, li + 2)]
      let tx = b1[0] - b0[0], ty = b1[1] - b0[1], tz = b1[2] - b0[2]
      const tl = Math.hypot(tx, ty, tz) || 1
      tan[i * 3 + 0] = tx / tl; tan[i * 3 + 1] = ty / tl; tan[i * 3 + 2] = tz / tl
      arc[i * 2 + 0] = pid
      arc[i * 2 + 1] = u
      seed[i] = Math.random()
      role[i] = 2
      session[i] = -1
      size[i] = SCRIBBLE.grain * (0.75 + Math.random() * 0.5)
      continue
    }
    const isBody = i < BODY
    const n = isBody ? BODY : PER_SESSION
    const k = isBody ? i : (i - BODY) % PER_SESSION
    const y = 1 - (k / Math.max(1, n - 1)) * 2
    const rad = Math.sqrt(Math.max(0, 1 - y * y))
    const th = golden * k
    home[i * 3 + 0] = Math.cos(th) * rad
    home[i * 3 + 1] = y
    home[i * 3 + 2] = Math.sin(th) * rad
    seed[i] = Math.random()
    role[i] = isBody ? 0 : 1
    session[i] = isBody ? -1 : Math.floor((i - BODY) / PER_SESSION)
    size[i] = isBody ? 0.9 + Math.random() * 0.6 : CLUSTER.grain * (0.85 + Math.random() * 0.3)
  }

  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(home.slice(), 3)) // three requires it
  g.setAttribute('aHome', new BufferAttribute(home, 3))
  g.setAttribute('aSeed', new BufferAttribute(seed, 1))
  g.setAttribute('aRole', new BufferAttribute(role, 1))
  g.setAttribute('aSession', new BufferAttribute(session, 1))
  g.setAttribute('aPath', new BufferAttribute(arc, 2))
  g.setAttribute('aTan', new BufferAttribute(tan, 3))
  g.setAttribute('aSize', new BufferAttribute(size, 1))
  return g
}

// Cached, not re-probed: boot calls this every time it runs, including
// every webglcontextlost/webglcontextrestored cycle (see the listener wired
// in attach below), and a real webgl2 context opened just to test support
// is itself a live context — browsers cap how many of those exist at once
// and evict the oldest to make room, so probing fresh on every boot
// competed with the renderer's own context for that budget. WebGL2 support
// is a property of the browser/GPU, not something that changes between
// boots within a session, so the answer only needs computing once.
let supportedCache = null
const supported = () => {
  if (supportedCache !== null) return supportedCache
  try {
    const c = document.createElement('canvas')
    supportedCache = !!c.getContext('webgl2')
  } catch { supportedCache = false }
  return supportedCache
}

const resize = () => {
  const box = canvas.getBoundingClientRect()
  if (!box.width || !box.height) return
  const w = Math.round(box.width), h = Math.round(box.height)
  // Compare in integer device pixels, not w*h*dpr floats: three's own
  // setSize does canvas.width = Math.floor(w * dpr) (verified against the
  // vendored bundle), so at a fractional dpr (1.25, 1.5, 1.75 — standard
  // Windows display scaling) canvas.width is a floor'd integer while
  // w*h*dpr is a float that can never equal it for most panel widths. That
  // made this guard fail open every frame, forever, on those displays.
  // Same idiom as replay.js's fit: floor the target to device pixels
  // (matching setSize's own rounding exactly, not just "an" integer) and
  // compare integers to integers.
  const pw = Math.floor(w * dpr), ph = Math.floor(h * dpr)
  if (canvas.width === pw && canvas.height === ph) return
  renderer.setPixelRatio(dpr)
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

// apply one look's uniform values. Never a second material,
// geometry or draw call: a look is only ever a set of uniform writes onto
// the one shared shader (LOOKS in swarm-math.js). Looping the config's own
// keys, rather than naming uGather here, is what lets a later look (say,
// streams) add uniforms of its own without this function growing a branch.
const applyLook = (name) => {
  if (!material) return
  const cfg = LOOKS[name]
  if (!cfg) return
  for (const key in cfg) {
    if (material.uniforms[key]) material.uniforms[key].value = cfg[key]
  }
}

const updateButtonLabel = () => {
  const btn = document.getElementById('swarm-mode')
  if (btn) btn.textContent = mode
}

// The mode-switch branch point: is this look rendered by the separate streams material/geometry,
// or the legacy shared one? The one branch point the mode switcher needs
// now that a look is not always "a set of uniform values on one shader."
const isStreamsMode = (name) => name === 'streams'

// Lift's depth cue — applies `depthCue`'s current value to the
// occluder's visibility and the streams material's depthTest/uSinkFadeOn,
// each of the three states individually correct rather than one
// compromised for another:
// fade occluder hidden, depthTest false (nothing else writes
// depth), uSinkFadeOn 1 (the dim-away term is active).
// occluder occluder visible (while streams is also the active look),
// depthTest true (so its depth write does something),
// uSinkFadeOn 0 (the fade would double-dim on top of it).
// none occluder hidden, depthTest false, uSinkFadeOn 0 — fully
// transparent, the exact pre-lift render.
// Called from setModeImmediate (a mode switch can change whether the
// occluder should be visible at all) and from MCS.setDepthCue directly
// (switching cue without switching mode).
const applyDepthCue = () => {
  const showOccluder = depthCue === 'occluder' && isStreamsMode(mode)
  if (occluder) occluder.visible = showOccluder
  if (streamsMaterial) {
    streamsMaterial.depthTest = depthCue === 'occluder'
    streamsMaterial.uniforms.uSinkFadeOn.value = depthCue === 'fade' ? 1 : 0
  }
}

// The non-fading half of a mode switch: apply the uniforms (legacy) or just
// leave the streams material's own state as it already is, flip which
// Points is visible, persist, relabel the button, return the mode actually
// set. Called directly for an unfaded switch (boot restoring the saved
// mode) and from the fade's midpoint (MCS.frame) for a faded one — see
// fadePhase above. Deliberately does NOT touch either family's fade uniform
// 'out' already drove the outgoing one to 0 by the time this runs, and
// leaving it there is exactly what makes the incoming look's 'in' phase
// start from dark rather than flashing to full brightness for a frame.
const setModeImmediate = (name) => {
  mode = normalizeMode(name)
  const toStreams = isStreamsMode(mode)
  if (legacyPoints) legacyPoints.visible = !toStreams
  if (streamsPoints) streamsPoints.visible = toStreams
  applyDepthCue()
  if (!toStreams) applyLook(mode)
  try { localStorage.setItem(MODE_KEY, mode) } catch { /* private mode: storage throws */ }
  updateButtonLabel()
  return mode
}

// tear down every per-look GPU resource from a previous boot
// before rebuilding. boot runs again on a WebGL context restore (the
// listeners wired in attach below), so without this a second boot leaks
// the first boot's renderer and BOTH materials/geometries — legacy and
// streams — rather than replacing them. Unconditional at the top of boot:
// on the very first call everything here is still null and every guard is a
// no-op, so this is safe whether or not a previous boot ever ran.
//
// Fade state is reset too. A mode switch's fade lives entirely in module
// scope (fadePhase/fadeTarget/fadeFromMul — see their declarations above) so
// it can survive a re-render, but that means it would ALSO survive a reboot
// if left alone: a fade caught mid-flight by a context loss would resume on
// the next frame driving brand-new materials' fresh uniforms off a stale
// fadePhaseStart timestamp, snapping instantly to whatever phase it was
// heading toward instead of landing cleanly on the restored (unfaded) mode
// boot sets up below. Clearing it here is what keeps "a page load — or a
// restore — lands directly on the restored look, never a visible fade" true
// for a restore as well as the original boot.
const teardown = () => {
  // See recoveringFromLoss's declaration: a lost context has already taken
  // every GPU resource these objects reference with it, so disposing them
  // here cannot free anything real — only renderer.dispose still earns its
  // keep in that case, for the JS-side cleanup of removing ITS OWN
  // webglcontextlost/webglcontextrestored listeners from the canvas (the
  // ones three.js's WebGLRenderer registers internally), which is what stops
  // an orphaned listener accumulating on every future loss/restore cycle.
  if (!recoveringFromLoss) {
    if (legacyPoints) legacyPoints.geometry.dispose()
    if (material) material.dispose()
    if (streamsPoints) streamsPoints.geometry.dispose()
    if (streamsMaterial) streamsMaterial.dispose()
    // Lift's occluder — same disposal discipline as everything
    // else here, so a WebGL context restore does not leak one occluder
    // per boot. Disposed regardless of the current depthCue — it exists
    // (hidden or not) from the moment boot creates it.
    if (occluder) { occluder.geometry.dispose(); occluder.material.dispose() }
  }
  if (renderer) renderer.dispose()
  renderer = null; scene = null; camera = null
  material = null; legacyPoints = null
  streamsMaterial = null; streamsPoints = null
  occluder = null
  fadePhase = null; fadeTarget = null; fadeFromMul = 1
  recoveringFromLoss = false
}

/* The two moods that are the ACCENT rather than a semantic follow the theme,
   and so do the other three's semantic colours -- app.js resolves all of them
   out of the live stylesheet and publishes them on window.MCT. swarm-math.js's
   MOODS stays the teal fallback (and stays importable under node, where there
   is no stylesheet to read). This is read per frame, which is also why a theme
   change needs no resync here. */
const themedMood = (mood) => {
  const base = moodColors(mood)
  const t = window.MCT
  if (!t) return base
  const a = { idle: t.accentDeep, working: t.accent, happy: t.green, stuck: t.redHot, blocked: t.purple }[mood]
  return a ? { a, b: base.b } : base
}

const boot = () => {
  teardown()
  canvas = document.getElementById('swarm')
  if (!canvas || !supported()) return false

  dpr = Math.min(window.devicePixelRatio || 1, 2)
  renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true })
  renderer.setClearColor(0x000000, 0)

  scene = new Scene()
  // CAMERA_FOV_DEG/CAMERA_Z imported from swarm-math.js, not hand-copied —
  // that module derives RADIUS_CLAMP_MAX and the softClampRadius backstop
  // from exactly these two numbers, so the camera actually built
  // here can never silently drift from the frustum that math reasons about.
  camera = new PerspectiveCamera(CAMERA_FOV_DEG, 1, 0.1, 100)
  camera.position.set(0, 0, CAMERA_Z)

  // themedMood, not moodColors: these are only the uniforms' initial values --
  // the frame loop overwrites them below -- but under a non-default accent the
  // unthemed table would paint one teal frame before the first tick.
  const m = themedMood('idle')
  // orb-presence — seed the ramp from the THEMED idle, so a non-default accent
  // never fades in from teal on the first frames.
  moodRamp.a = hexToOklab(m.a); moodRamp.b = hexToOklab(m.b)
  material = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    uniforms: {
      uTime:       { value: 0 },
      uRadius:     { value: 1.0 },
      uColorA:     { value: new Color(m.a) },
      uColorB:     { value: new Color(m.b) },
      // Orchestrator thinking indicator (ported from streams).
      // LEGACY_BASE_GLOW is 1, the identity, so nothing changes until the
      // orchestrator is actually answering.
      uGlow:       { value: LEGACY_BASE_GLOW },
      uClusterBound: { value: CLUSTER.centreMax },
      uClusterFade: { value: clusterFade({ dpr }) },
      uClusterPull: { value: CLUSTER.pull },
      uArc: { value: 0 },
      uArcFade: { value: scribbleFade({ dpr }) },
      uClusterHide: { value: 0 },
      uArcSpan: { value: SCRIBBLE.spanIdle },
      uArcDart: { value: 1 },
      uArcRipple: { value: SCRIBBLE.ripple },
      uClusterOrbitZ: { value: CLUSTER.orbitZ },
      // Physical pixels, DPR-aware — gl_PointSize is always physical pixels,
      // so a fixed literal here is wrong on retina regardless of tuning.
      // dpr is fixed once here and never changes on this canvas, so this
      // uniform needs no refresh from resize. Tuned by eye against the
      // live panel.
      uPointScale: { value: 5.0 * dpr },
      // 0.17, not the 0.13 this started from — settled by eye against the
      // live panel: 0.13 made the network too faint to read at this screen
      // size, and 0.2 held structure clearly with no visible glow either.
      uAlpha:      { value: 0.17 },
      // the mode-switch fade multiplier. 1 in steady state; eased to
      // 0 and back by MCS.frame while a mode switch is in flight — see
      // fadePhase above. Never written outside that transition.
      uFadeMul:    { value: 1 },
      // curl is normalized now (a unit direction field, see VERT above), so
      // uFlow is the actual step size rather than a multiplier on an
      // unbounded field magnitude. The unnormalized field averaged ~8-9x
      // this, with per-sample extremes from 0.05 to 4.78, so no value tuned
      // against it carries across: a step matched to that mean would read as
      // teleporting rather than flowing.
      //
      // 2.8 is bounded on both sides. At or above 3.0 the lattice dissolves
      // and reforms rather than flowing; below about 1.5 the motion is
      // imperceptible, barely moving even while thinking. In between it
      // reconfigures frame to frame while staying legible as the same
      // branching structure, at both uActivity 0 and 1. `shell` shares the
      // shader and the uniform, so it takes the same value.
      uFlow:      { value: 2.8 },
      uLife:      { value: 7.0 },
      // SHELL_THICKNESS imported from swarm-math.js — it is also the exact
      // value maxBodyRadius/minBodyRadius use for the shell-term half of
      // the radius bound, so this default and that bound cannot drift apart.
      uThickness: { value: SHELL_THICKNESS },
      // Crest capture. Settled values, walked to live with the MCS.set console
      // helper below, without a reload.
      uVeinScale:   { value: 2.6 },     // 2.0–3.5: cells across the disc
      uBranchScale: { value: 2.2 },     // 1.8–3.0
      uBranch:      { value: 0.35 },    // 0–1: 0 = trunks only, 1 = full lattice
      uGather:      { value: 1.0 },     // 0–1: 0 reproduces today's geometry
      uReach:       { value: 0.22 },    // 0.15–0.5 rad: the vein : dust split
      uLoose:       { value: 0.35 },    // 0–0.8: sheath width around the core
      uMorph:       { value: 0.042 },   // 0.01–0.1 rad/s
      uRelief:      { value: 0.04 },    // 0–0.08
      uDustFade:    { value: 0.45 },    // 0.25–0.7 once gathering is on
      uBack:        { value: 0.3 },     // 0.15–1.0; 1.0 = today's far side
      // State mapping.
      uActivity:   { value: 0 },
      uPull:       { value: new Vector2(0, 0) },
      // Shell-only now: fed
      // live pulses only while mode is shell — see MCS.frame. Iris reacts
      // through the field ripple below instead; the shove code in VERT is
      // unchanged, just fed zero (uPulseCount 0) while iris is on screen.
      uPulses:     { value: [0, 1, 2, 3].map(() => new Vector4(0, 0, 0, 0)) },
      uPulseCount: { value: 0 },
      // Reactive layer — the field ripple.
      // Written every frame from the shared `ripples` state (identity frame
      // iris has no precession/drift to convert through, see MCS.frame).
      // uRipLift/uRipGlow are look-gated (LOOKS.iris/LOOKS.shell in
      // swarm-math.js, applied by applyLook) rather than written here:
      // this initial value is overwritten by MCS.setMode at the end of
      // boot before a frame ever renders.
      uRipA: { value: Array.from({ length: RIPPLE_SLOTS }, () => new Vector4()) },
      uRipB: { value: Array.from({ length: RIPPLE_SLOTS }, () => new Vector4()) },
      uRipLift: { value: 0.4 }, uRipGlow: { value: 0.35 },
      // sessions as orbiting sub-swarms. vec4(radius, inclination,
      // accumulated angle, working). Rewritten positionally every frame from
      // `S.sessions`; see MCS.frame and the sessionAngle comment above.
      uSessions:     { value: Array.from({ length: MAX_SESSIONS }, () => new Vector4(0, 0, 0, 0)) },
      uSessionCount: { value: 0 },
    },
  })

  legacyPoints = new Points(buildGeometry(), material)
  scene.add(legacyPoints)


  // Streams's own material, geometry and Points. Added to the
  // scene now (hidden until selected) rather than built lazily on first
  // switch: renderer.compile below needs both in the scene graph to
  // compile both materials up front — see the comment on that call.
  streamsMaterial = buildStreamsMaterial(m)
  streamsPoints = new Points(buildStreamsGeometry(), streamsMaterial)
  streamsPoints.visible = false
  scene.add(streamsPoints)

  // Lift's occluder: the one sanctioned exception to the one-draw-call rule,
  // because it adds a GPU draw and zero per-frame CPU work, which is not what
  // that rule was defending against.
  // A sphere slightly inside the shell, colourWrite false so it is invisible
  // itself, depthWrite true so it writes depth first — that is what makes a
  // sunken channel vanish INTO the body (when MCS.setDepthCue('occluder')
  // also flips streamsMaterial.depthTest true) rather than dim through
  // uSinkFade, and shows a far-side channel only where it rises above the
  // limb. Built once here, never touched per frame; disposed in teardown
  // so boot stays re-entrant. Streams-only AND depth-cue-gated — visible
  // only when both toStreams and depthCue === 'occluder' hold (set in
  // setModeImmediate/MCS.setDepthCue). Starts hidden: 'fade' is the
  // shipped default, not persisted across a reload.
  occluder = new Mesh(
    new SphereGeometry(0.965, 32, 24),
    new MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true }),
  )
  occluder.renderOrder = -1
  occluder.visible = false
  scene.add(occluder)

  // Compile every look's material now, not on first render. three compiles
  // a ShaderMaterial lazily the first time it is actually drawn, so without
  // this an uncompiled look costs a 50-200ms main-thread stall on the FIRST
  // press of the switcher — precisely the stutter the "no per-frame CPU
  // work" constraint exists to prevent. WebGLRenderer.compile walks the
  // scene with `scene.traverse` (not traverseVisible) to find materials to
  // prepare, so streamsPoints being hidden here does not exempt it.
  renderer.compile(scene, camera)

  canvas.hidden = false

  // the mode button. Only revealed here, once the swarm actually
  // boots: index.html declares it hidden by default, and a browser that
  // can't run WebGL2 (or a lost context) never reaches this line, so it just
  // stays hidden — the panel is the shader or nothing, with no fallback
  // control to show instead. The click listener is wired at most once —
  // boot can run again on a WebGL context restore, and adding the
  // listener unconditionally would stack handlers so one click skipped two
  // modes, then three.
  const btn = document.getElementById('swarm-mode')
  if (btn) {
    btn.hidden = false
    if (!listenerWired) {
      listenerWired = true
      btn.addEventListener('click', () => {
        // Cycle from whatever mode a fade is already heading toward, not
        // from whatever is still on screen mid-fade — see MCS.setMode.
        // That is what keeps rapid clicking advancing one step per click
        // instead of getting stuck retargeting the same swap.
        const from = fadeTarget ?? mode
        const i = MODES.indexOf(from)
        MCS.setMode(MODES[(i + 1) % MODES.length])
      })
    }
  }

  // Restore the saved look. normalizeMode falls back to MODES[0] for a
  // missing or corrupt value, and this call never fades — a page load
  // should land directly on the restored look, not visibly cross-fade into
  // it the instant the panel appears.
  let saved = null
  try { saved = localStorage.getItem(MODE_KEY) } catch { /* private mode: storage throws */ }
  MCS.setMode(saved, { fade: false })

  return true
}

const MCS = {
  ready: false,

  attach(ctx) {
    C = ctx
    MCS.ready = boot()

    // Context loss and restoration. Deliberately NOT a permanent latch-off:
    // going offline for good after one blip is a defect wherever it appears,
    // and this must not reproduce it for a lost WebGL context. Wired here, at most
    // once (contextListenersWired), rather than inside boot — boot is
    // the thing that re-runs on every restore, and re-adding these same two
    // listeners on every re-boot would stack them on the one canvas element
    // (never replaced across a context loss) exactly the way an unguarded
    // click listener would, per the mode button's own comment in boot.
    if (canvas && !contextListenersWired) {
      contextListenersWired = true

      canvas.addEventListener('webglcontextlost', (e) => {
        // preventDefault is what tells the browser this context is allowed
        // to come back; without it the browser never fires
        // webglcontextrestored at all and this would be a latch-off by
        // omission.
        e.preventDefault()
        MCS.ready = false
        recoveringFromLoss = true
        canvas.hidden = true
        const btn = document.getElementById('swarm-mode')
        if (btn) btn.hidden = true
      })

      canvas.addEventListener('webglcontextrestored', () => {
        // boot directly, not attach: attach is the one-time entry
        // point app.js's swarmTried latch calls, and re-running it would
        // just reassign C to the same ctx and re-check the guard above for
        // no benefit. boot alone is what a restore needs — it disposes
        // the dead renderer and both materials (teardown, above), rebuilds
        // and recompiles every look, and restores the persisted mode.
        MCS.ready = boot()
      })
    }

    return MCS.ready
  },

  frame(t) {
    if (!MCS.ready || document.hidden) return
    resize()
    nowMs = t
    const now = t * 0.001
    const dt = lastNow === null ? 0 : Math.min(0.1, Math.max(0, now - lastNow))
    lastNow = now

    // Orchestrator thinking indicator — advanced every frame,
    // regardless of which look is showing, so a switch INTO streams
    // mid-thought opens already at the right level rather than a cold 0.
    thinkingLevel = easeThinking(thinkingLevel, orchestratorBusy, dt)

    // The ask swell — one big slow ring the moment Syzygy takes the message,
    // on the rising edge only. Not gated on `mode`: the ripple state is
    // shared and look-agnostic, and streams is where it is rendered.
    if (orchestratorBusy && !prevOrchestratorBusy) askRipple(ripples, now, 1)
    prevOrchestratorBusy = orchestratorBusy

    const S = C.S
    sampleSessions(S, t)

    // the idle -> thinking heartbeat: edge-
    // triggered on the rising edge of "any session is genuinely working"
    // (the falling edge fires nothing). The reactive layer takes the raw
    // signal: `genuinelyWorking` reads `s.working` directly, never `actS`
    // (streams's own 0.4s low-passed copy of S.activity). `heartbeat` (swarm-math.js) owns the ONE refractory clock —
    // a FIXED 5.0s, never shortened by anything (see HEART_REFRACTORY_S's
    // own comment: the rate is capped regardless of session count).
    // Its return value — did it actually fire, past the refractory — is
    // what gates shell's OWN secondary reaction below: the pre-existing
    // radial shove, kept because shell has no field to ripple across (/
    // "shell keeps its existing shove — the honest reaction of a cloud
    // with no structure"). One clock, not two, so the two reactions can
    // never drift out of sync.
    //
    // `workingCount` (not clamped to MAX_SESSIONS, unlike the
    // satellite dots below) drives sessionRippleMultiplier, cached in
    // `currentMult`. It touches STRENGTH only: shell's heartbeat shove
    // below, iris/streams's uRipLift/uRipGlow, and (a small, damped
    // fraction of it) streams's own whole-sphere spin rate — never the
    // refractory. The rule that every look carries the multiplier of however
    // many agents are thinking is satisfied through the rare heartbeat path
    // alone, rather than by making ripples fire more often.
    const workingCount = (S.sessions ?? []).reduce((n, s) => n + (genuinelyWorking(s) ? 1 : 0), 0)
    const mult = sessionRippleMultiplier(workingCount)
    currentMult = mult
    const anyWorking = workingCount > 0
    if (anyWorking && !wasAnyWorking) {
      const fired = heartbeat(ripples, now, Math.min(mult, INTENSITY_MULT_CAP))
      if (fired && usesBodyPulse(mode)) pushPulse(pulses, t, HEARTBEAT_STRENGTH * mult)
    }
    wasAnyWorking = anyWorking

    const box = canvas.getBoundingClientRect()

    // Same easing idiom throughout: the target snaps, this follows it late.
    // This LEAN is the only pointer reaction left
    // field ripple under the cursor and its wake rings are gone: pointer
    // movement is not a ripple trigger. See swarm-math.js's RIPPLE table. Offset is in
    // panel-radius units with distance falloff — see pointerLeanTarget above.
    const offX = S.pointer.x * innerWidth - (box.left + box.width / 2)
    const offY = S.pointer.y * innerHeight - (box.top + box.height / 2)
    const panelR = Math.max(1, Math.min(box.width, box.height) / 2)
    const lean = pointerLeanTarget(offX, offY, panelR)
    pull.x += (lean.x - pull.x) * 0.045
    pull.y += (lean.y - pull.y) * 0.045

    advanceMoodRamp(moodRamp, themedMood(S.mood), dt)
    const u = material.uniforms
    u.uTime.value = t * 0.001
    u.uActivity.value = S.activity
    u.uPull.value.set(pull.x, pull.y)
    // Orchestrator thinking indicator (ported from streams): the
    // same eased level, the same red shift, the same brightness swell, on the
    // shared iris/shell material. thinkingTint(_, 0) and thinkingGlowMult(0)
    // are both the exact identity, so a relay nobody has asked anything
    // renders byte-for-byte as it did. iris gets it too — one material.
    u.uColorA.value.setHex(oklabToHex(thinkingTint(moodRamp.a, thinkingLevel)))
    u.uColorB.value.setHex(oklabToHex(thinkingTint(moodRamp.b, thinkingLevel)))
    u.uGlow.value = LEGACY_BASE_GLOW * thinkingGlowMult(thinkingLevel)
    // scribble — the arcs grow and quicken while the orchestrator answers.
    // Both are DISTANCES, not rates: a longer arc means the draw head covers
    // more ground in the same drawS, and a longer dart means more travel at
    // the same dartRate. Nothing integrates a changing rate, so nothing can
    // jump when the level moves.
    u.uArcSpan.value = SCRIBBLE.spanIdle + (1 - SCRIBBLE.spanIdle) * thinkingLevel
    u.uArcDart.value = 1 + (SCRIBBLE.dartThink - 1) * thinkingLevel

    // intensity. uRipLift/uRipGlow scaled by the (capped)
    // concurrency multiplier.
    //
    // READ FROM THE LOOK. This used to hardcode `mode === 'shell' ? 0 : base`
    // and stamp it over the uniforms EVERY FRAME, which made LOOKS' own
    // values for these two a fiction: applyLook wrote them on the mode change
    // and this overwrote them a frame later. Raising LOOKS.shell.uRipLift did
    // nothing at all, and the ripple stayed missing.
    const ripMult = Math.min(mult, INTENSITY_MULT_CAP)
    const look = LOOKS[mode] ?? LOOKS[DEFAULT_MODE]
    u.uRipLift.value = (look.uRipLift ?? BASE_RIP_LIFT) * ripMult
    u.uRipGlow.value = (look.uRipGlow ?? BASE_RIP_GLOW) * ripMult

    // Reactive layer — the field ripple, legacy material (iris and shell
    // share it). Identity frame: neither has a precession/drift transform
    // to convert a centre through, unlike streams below.
    rippleRows(ripples, now, identityField, ripA_legacy, ripB_legacy)
    for (let i = 0; i < RIPPLE_SLOTS; i++) {
      u.uRipA.value[i].fromArray(ripA_legacy[i])
      u.uRipB.value[i].fromArray(ripB_legacy[i])
    }

    // Shell-only now (see the VERT comment on uPulses above): the legacy
    // shove renders only while shell is the active look; iris reacts
    // through the field ripple just written above instead.
    const live = activePulses(pulses, t, PULSE_LIFE)
    if (usesBodyPulse(mode)) {
      u.uPulseCount.value = live.length
      live.forEach((p, i) => u.uPulses.value[i].set(p.age01, p.strength, 0, 0))
    } else {
      u.uPulseCount.value = 0
    }

    // Sessions as orbiting sub-swarms. dt is the wall-clock gap
    // since the previous frame's uTime, clamped so a backgrounded tab
    // resuming doesn't hand a session's orbit a huge, jump-inducing step —
    // it only ever slows the *rate* at which the angle integrates.
    const dtS = lastFrameS === null ? 0 : Math.min(u.uTime.value - lastFrameS, 0.1)
    lastFrameS = u.uTime.value
    const liveSessions = clampSessions(S.sessions)

    // Sessions in streams — claim bookkeeping, keyed by session id
    // rather than by position in the live list. Never gated on which look is
    // visible, for the same reason actS is not: a switch into streams should
    // open on the claims as they stand. Nothing here integrates a rate, so
    // teleport class does not apply — there is no angle to jump.
    // Advanced BEFORE the orbital loop, which now reads its ownership.
    advanceClaims(claims, liveSessions, dtS, claimOpts)

    // Orbitals keyed by band (orb-presence): slot b shows the session that
    // OWNS band b in `claims`, so a departure frees a slot without renumbering
    // the survivors — the positional loop this replaces made a cluster jump
    // orbits whenever an earlier session ended. Bands 0-7 map
    // to the eight slots; band 8's owner has no orbital (reachable only with
    // eight live and one still fading — the ninth session's own edge). A
    // departed session's slot goes dark at once while its band's claim fades,
    // so nothing can take that slot for ~3 s.
    const liveById = new Map()
    for (const s of liveSessions) if (s && s.id != null) liveById.set(s.id, s)
    u.uSessionCount.value = MAX_SESSIONS
    for (let b = 0; b < MAX_SESSIONS; b++) {
      const s = claims.owner[b] === null ? undefined : liveById.get(claims.owner[b])
      if (!s) { u.uSessions.value[b].set(0, 0, 0, 0); continue }
      const o = sessionOrbit(b)
      const working = s.working ? 1 : 0
      // Accumulate, don't recompute from uTime. working only changes the rate.
      sessionAngle[b] += (0.24 + working * 0.16) * dtS
      u.uSessions.value[b].set(o.radius, o.inclination, sessionAngle[b], working)
    }


    // Streams. Activity's 0.4s low-pass always
    // tracks S.activity, streams-only — legacy's own u.uActivity above stays
    // the raw, unfiltered signal it has always used; this is an ADDITIONAL
    // signal, not a change to that one. Kept live even while streams is
    // hidden so a switch INTO it never opens on a stale reaction.
    const act = Math.max(0, Math.min(1, S.activity ?? 0))
    actS += (act - actS) * (1 - Math.exp(-dt / 0.4))
    // Angles/uniforms advance only while streamsPoints is actually visible:
    // each look keeps its own accumulated angles and advances them only while
    // active, so a long spell on iris does not leave streams's shear phase
    // stale or racing to catch up the moment it is shown again.
    if (streamsPoints.visible) {
      const sp = LOOKS.streams.p
      // The whole sphere must always be spinning slightly, never fast, with a
      // slight speed-up as concurrent sessions compound. The rigid rotation
      // already existed (uPrec/PREC_AXIS, the LAST step of both this transport
      // and STREAMS_VERT's main) but at PREC_RATE's old 0.004 rad/s it was
      // imperceptible — one turn every ~26 minutes. `mult` (the SAME
      // concurrency signal driving the ripple layer's strength) is passed
      // here as advance's `spinMult`; SPIN_MULT_SCALE (swarm-math.js)
      // damps its effect so this is a SLIGHT speed-up on top of an
      // always-present, unmistakably slow base rate, never a fast spin.
      //
      // `thinkSpin` is the orchestrator thinking
      // indicator's own, UNDAMPED multiplier (thinkingSpinMult, swarm-
      // math.js): the whole streams look spins faster while
      // orchestrator.busy is true. Composed with `mult` rather than
      // replacing it, so the two effects (session concurrency, orchestrator
      // thinking) simply add rather than one silently overriding the other.
      const thinkSpin = thinkingSpinMult(thinkingLevel)
      streamsAng = advance(streamsAng, sp, LOOKS.streams.wrap, actS, dt, mult, thinkSpin)
      const su = streamsMaterial.uniforms
      su.uTime.value = streamsAng.time
      su.uAngle.value = streamsAng.orbit
      su.uLatticeAngle.value = streamsAng.drift
      su.uPrec.value = streamsAng.prec
      su.uPhaseA.value = streamsAng.phaseA
      su.uPhaseB.value = streamsAng.phaseB
      // The reaction (table): bounded parameters only, off the SAME
      // shipped p.* the harness twin asserts against — rates were already
      // handled inside advance above.
      su.uReach.value = sp.reach * (1 + 0.3 * actS)
      su.uLoose.value = sp.loose * (1 - 0.5 * actS)
      su.uDustFade.value = sp.dustFade * (1 - 0.4 * actS)
      su.uAlpha.value = LOOKS.streams.alpha * (1 + 0.35 * actS)
      su.uShimmer.value = sp.shimmer + 0.35 * actS
      su.uTurb.value = 0.03 * actS * actS
      su.uThickness.value = 0.10 * (1 + 0.6 * actS)
      su.uStretch.value = sp.stretch * (1 + 0.6 * actS)
      // The whole look glows brighter while orchestrator.busy.
      // thinkingGlowMult(0) is the identity (1), so this is byte-for-byte
      // STREAMS_BASE_GLOW whenever nobody has asked Syzygy anything.
      su.uGlow.value = STREAMS_BASE_GLOW * thinkingGlowMult(thinkingLevel)
      // Lift — the six modes' own phases,
      // accumulated on the CPU exactly like streamsAng above (Rule A: never
      // rate*uTime). `actS` is the SAME low-passed activity signal every
      // other streams reaction here uses, so thinking speeds up the ebb and
      // flow on the same shaping as everything else in this block.
      streamsLiftPh = advanceLift(streamsLiftPh, actS, dt)
      for (let m = 0; m < 6; m++) su.uLiftPh.value[m] = streamsLiftPh[m]
      // Sessions — nine band rows: (centre s, claim, heat, burn), plus the
      // band's eased accent. A row with claim 0 is skipped by sessionBand,
      // so an unclaimed band costs the shader a compare and nothing else.
      // Every row is written every frame: a uniform array left partly unwritten
      // is the "uSessColor missing" failure: a band with no colour at all.
      for (let b = 0; b < SESSION_BANDS.length; b++) {
        su.uSess.value[b].set(SESSION_BANDS[b], claims.claim[b], claims.heat[b], bandBurn(claims, b))
        su.uSessColor.value[b].setHex(oklabToHex(claims.lab[b]))
      }
      // pointer lean, ported from iris. `pull` is
      // the SAME eased vector the legacy material reads above (one easing,
      // read twice).
      su.uPull.value.set(pull.x, pull.y)
      // intensity, streams. Streams always "has a field" (never
      // shell), so no LOOKS-based gating is needed here — reuse iris's own
      // base (0.4/0.35), same idiom, same cap: "the others should carry
      // this multiplier rule as well."
      su.uRipLift.value = BASE_RIP_LIFT * ripMult
      su.uRipGlow.value = BASE_RIP_GLOW * ripMult
      // Reactive layer — the field ripple, converted into streams's own
      // field frame: un-precess, then un-drift (toStreamsField — the
      // exact inverse, in reverse order, of steps 4-5 in streams's own
      // main: nl -rot(uAxis,+uLatticeAngle)-> nrm -rot(uPrecAxis,+uPrec)->
      // nw). One ripples state, read into both materials' own frames —
      // so the (now heartbeat-only) ripple shows up on whichever look is
      // on screen, converted correctly for that look's own geometry.
      const toStreamsField = (v) => rot3(rot3(v, PREC_AXIS, -streamsAng.prec), FLOW_AXIS, -streamsAng.drift)
      rippleRows(ripples, now, toStreamsField, ripA_streams, ripB_streams)
      for (let i = 0; i < RIPPLE_SLOTS; i++) {
        su.uRipA.value[i].fromArray(ripA_streams[i])
        su.uRipB.value[i].fromArray(ripB_streams[i])
      }
    }
    // Mood colours go to every look every frame, streams included, so a
    // switch never needs a resync (matches the legacy uColorA/B write above).
    // …and, on STREAMS ONLY, bent toward red by the thinking level: fade to
    // red while thinking, fade back once the response is finished.
    // `thinkingLevel` is already eased
    // both ways by easeThinking, so the fade in AND the fade back are free —
    // there is no separate recovery path to get wrong. iris and shell are
    // deliberately untouched: their uColorA/B write is the one above.
    // thinkingTint at level 0 returns the ramp unchanged, so an idle streams
    // is byte-for-byte what it was before this landed.
    streamsMaterial.uniforms.uColorA.value.setHex(oklabToHex(thinkingTint(moodRamp.a, thinkingLevel)))
    streamsMaterial.uniforms.uColorB.value.setHex(oklabToHex(thinkingTint(moodRamp.b, thinkingLevel)))

    // step the mode-switch fade, if one is in flight. A pure
    // uniform write, same budget class as everything above it: no buffer
    // touched, no geometry rebuilt. 'out' rides the OUTGOING look's own fade
    // uniform down from wherever it already was (so a retargeted fade —
    // rapid clicking — never jumps) to 0, swaps the mode (and which Points
    // is visible) the instant it gets there, then 'in' rides the INCOMING
    // look's fade uniform back up to 1. Legacy's fade lives on uFadeMul
    // (fragment stage, multiplying uAlpha); streams's lives on uFade
    // (vertex stage, folded into vFade) — different pipeline stage, same
    // "whole-look brightness, eased through dark" contract either way.
    if (fadePhase === 'out') {
      const p = Math.max(0, Math.min(1, (nowMs - fadePhaseStart) / (FADE_MS / 2)))
      const val = fadeFromMul * (1 - p)
      if (isStreamsMode(mode)) streamsMaterial.uniforms.uFade.value = val
      else u.uFadeMul.value = val
      if (p >= 1) {
        setModeImmediate(fadeTarget)
        fadeTarget = null
        fadePhase = 'in'
        fadePhaseStart = nowMs
      }
    } else if (fadePhase === 'in') {
      const p = Math.max(0, Math.min(1, (nowMs - fadePhaseStart) / (FADE_MS / 2)))
      if (isStreamsMode(mode)) streamsMaterial.uniforms.uFade.value = p
      else u.uFadeMul.value = p
      if (p >= 1) fadePhase = null
    }

    renderer.render(scene, camera)
  },

  // Called by app.js's firePulse. Ordinary tool-call pulses do not ripple the
  // field at all, for any look: they are far too frequent, and a fast punchy
  // ripple over a body that is otherwise drifting reads as a glitch stapled
  // onto a calm scene. Rippling is for genuinely rare events only; a tool-call
  // pulse keeps its existing subtle shockwave instead. So this is shell-only, with
  // its ORIGINAL (pre-reactive-layer) strength, UNSCALED by the concurrency
  // multiplier — that multiplier rides the rare heartbeat path only (see
  // MCS.frame); this is deliberately left exactly as subtle as it always was.
  // iris/streams get no reaction at all to an ordinary tool call now.
  pulse(strength = 1) {
    if (!MCS.ready) return
    if (usesBodyPulse(mode)) pushPulse(pulses, performance.now(), strength)
  },

  // Orchestrator thinking indicator. Called from
  // app.js's renderBlurb, which already runs on every S.orchestrator change
  // (the snapshot, the SSE `orchestrator` frame, sendAsk's own optimistic
  // busy toggles) — orchestrator.busy is an EXISTING payload field, not a
  // new signal. Deliberately callable and safe before MCS.ready (even
  // before attach has run at all, since `orchestratorBusy` is a plain
  // module binding, not gated on boot): app.js may call this before the
  // swarm has finished loading, and the value just sits there until
  // MCS.frame starts reading it, rather than being lost.
  setBusy(on) {
    orchestratorBusy = !!on
  },

  // Reactive layer — fires a heartbeat on demand, the same path MCS.frame's own
  // idle->thinking trigger uses (ONE refractory clock, shared — see that
  // trigger's comment). Returns whether it actually fired (false inside the
  // fixed 5.0s refractory — concurrency scales STRENGTH here too, never the
  // rate). Console: `MCS.heartbeat`.
  heartbeat() {
    if (!MCS.ready) return false
    const nowS = performance.now() * 0.001
    const fired = heartbeat(ripples, nowS, Math.min(currentMult, INTENSITY_MULT_CAP))
    if (fired && usesBodyPulse(mode)) pushPulse(pulses, performance.now(), HEARTBEAT_STRENGTH * currentMult)
    return fired
  },

  // the mode switcher. normalizeMode makes this total: an unknown
  // or corrupt name falls back to MODES[0] rather than throwing. `fade:
  // false` (boot restoring the saved look) applies immediately; the default
  // path (the button) starts the ~0.4s fade-through-dark in frame instead
  // and only swaps material state at its midpoint — see fadePhase above.
  // Returns the mode actually set, same as the stale brief's contract.
  setMode(name, { fade = true } = {}) {
    const next = normalizeMode(name)
    if (!fade || !material) return setModeImmediate(next)
    fadeTarget = next
    // Read the fade level off whichever family is CURRENTLY showing, not
    // always the legacy material — see setModeImmediate's comment on why
    // 'out' must ride down from wherever it already was.
    fadeFromMul = isStreamsMode(mode) ? streamsMaterial.uniforms.uFade.value : material.uniforms.uFadeMul.value
    fadePhase = 'out'
    fadePhaseStart = nowMs
    return next
  },

  mode() { return mode },

  // Dev-only: tune a LEGACY (iris/shell) uniform live from the console
  // without a reload, e.g. MCS.set('uReach', 0.3). Not part of the
  // state-mapping contract — it exists to walk the crest-capture tuning
  // ladder against the live panel.
  set(name, value) { if (material?.uniforms[name]) material.uniforms[name].value = value },

  // The streams equivalent, deliberately a SEPARATE method rather
  // than folding into set above: several uniform NAMES are shared between
  // the two shaders (uReach, uRelief, uDustFade, uBack, uAlpha, ...), so a
  // single set writing to both materials whenever a name matches would
  // silently retune iris while walking the streams ladder — and iris is
  // settled: it must not be retuned. e.g.
  // MCS.setStreams('uShear', 2.3) — walks
  setStreams(name, value) { if (streamsMaterial?.uniforms[name]) streamsMaterial.uniforms[name].value = value },

  // orb-presence — walk the burn map and the mood fade live, no reload:
  // MCS.setBurn('r0', 1500), MCS.setMoodRamp(0.35). Both tables live in
  // swarm-math.js; these mutate the imported objects in place.
  setBurn(key, value) { if (key in BURN) BURN[key] = value; return BURN[key] },
  // iris/shell's flat clusters had the same flattening. 0 is NOT a revert —
  // it would collapse them to the origin; set it low (1.2) to pull them in.
  setClusterBound(v) { if (material) material.uniforms.uClusterBound.value = v; return v },
  setClusterOrbitZ(v) { if (material) material.uniforms.uClusterOrbitZ.value = v; return v },
  // The per-point fade. Raising it without lowering the point count is how
  // a dense cluster clips to white — see uClusterFade's own comment.
  setClusterFade(v) { if (material) material.uniforms.uClusterFade.value = v; return v },
  // How far the clusters follow the pointer. The body uses 0.22; matching it
  // is what stops the body sliding through them on a lean.
  setClusterPull(v) { if (material) material.uniforms.uClusterPull.value = v; return v },
  // Fire the orchestrator's ask ring by hand — the slow, big, 7-second one.
  // For checking the ripple without having to type into the agent field:
  // MCS.ask. Returns nothing useful; watch the orb.
  ask(strength = 1) { askRipple(ripples, nowMs * 0.001, strength); return strength },
  // Walk the ask ring live: MCS.setRipple('speed', 0.8), or 'life', 'bend',
  // 'sigma', 'kick'. Mutates the shared preset, so the next ring fired picks
  // it up — rings already in flight keep the values they were born with.
  setRipple(key, value) { if (key in RIPPLE.ask) RIPPLE.ask[key] = value; return RIPPLE.ask[key] },
  // How hard a passing ring sweeps the lightning arcs. The body lifts by
  // LOOKS[mode].uRipLift per unit beat; this must be at least that or the
  // body grows through them. MCS.setArcRipple(4) to exaggerate.
  setArcRipple(v) { if (material) material.uniforms.uArcRipple.value = v; return v },
  setMoodRamp(tau) { MOOD_RAMP.tau = tau; return MOOD_RAMP.tau },

  // Lift's depth cue — console-driven, live, no reload, so the
  // three ways of hiding a sunken channel can be compared directly:
  // MCS.setDepthCue('fade' | 'occluder' | 'none'). Total, like
  // normalizeMode: an unknown name falls back to 'fade', the shipped
  // default, rather than throwing. Not persisted — always 'fade' again on
  // reload (a debug affordance, not a user preference). Returns the value
  // actually set, same contract as setMode.
  setDepthCue(name) {
    depthCue = DEPTH_CUES.includes(name) ? name : 'fade'
    applyDepthCue()
    return depthCue
  },

  depthCue() { return depthCue },
}

window.MCS = MCS
