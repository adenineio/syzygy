// Property checks for the swarm's pure math. The shaders are GLSL and are not
// testable here: asserting against a JS reimplementation of the noise would
// test the reimplementation rather than the shader.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  MOODS, moodColors, MAX_SESSIONS, sessionOrbit, clampSessions,
  makePulseRing, pushPulse, activePulses,
  MODES, DEFAULT_MODE, normalizeMode, LOOKS,
  CLUSTER, clusterCoverage, clusterFade, CLUSTER_MIN_COVERAGE, glf,
  BODY_PULSE_LOOKS, usesBodyPulse,
  SCRIBBLE, scribblePaths, scribbleFade, scribbleOnScreen,
  RADIUS_CLAMP_MIN, RADIUS_CLAMP_MAX, SHELL_BLEND, SHELL_THICKNESS, MAX_RELIEF,
  maxBodyRadius, minBodyRadius,
  // the camera/clamp relationship.
  CAMERA_FOV_DEG, CAMERA_Z, VISIBLE_HALF_HEIGHT, SPRITE_MARGIN, CONTAIN_CEILING, CAMERA_MARGIN, SAFE_RADIUS,
  softClampRadius,
  transportStreams, motionMetrics, fibonacciHomes, mulberry32, freshAngles, advance,
  FLOW_AXIS, PREC_AXIS, PREC_RATE, SPIN_MULT_SCALE, SHEAR_RATE, BANDS,
  STALL_MS, genuinelyWorking,
  // Reactive layer —
  // the ripple state machine and its exact-closed-form JS twin, harness-
  // tested the same way the streams transport above is: pure functions,
  // real assertions, no copy. `pointer` and `toolPulse` are both gone — see
  // RIPPLE's own comment for why (the pointer's field ripple, then ordinary
  // tool-call pulses, were both ruled out in turn).
  RIPPLE, RIPPLE_SLOTS, NO_FOLD, HEART_REFRACTORY_S, ASK_RIPPLE_SLOT, askRipple,
  rippleEnvelope, rippleBend, makeRipples, heartbeat, rippleRows,
  RIPPLE_MULT_SCALE, sessionRippleMultiplier,
  // Lift — the per-channel radial life field.
  // liftField/freshLift/advanceLift are the SAME pure functions swarm.js's
  // CPU accumulation and motionMetrics' optional `liftPh` hook both call —
  // no hand-copied field math here, same discipline as everything above.
  LIFT_MODES, LIFT, AXIS_U, AXIS_V, freshLift, advanceLift, liftField,
  // Sessions in streams: a session claims a latitude band. CHANNEL_SPACING is
  // the module's own export, imported by the harness and by the look, rather
  // than restated here.
  SESSION_BANDS, SESSION, liftHeld, makeClaims, advanceClaims, CHANNEL_SPACING,
  // orb-presence — OKLab, the body's
  // mood ramp, per-session state, and burn from token rate.
  hexToOklab, oklabToHex, oklabDist, MOOD_RAMP, makeMoodRamp, advanceMoodRamp,
  STATE_ACCENT, STATE_ACCENT_HOT, needsHuman, sessionState, recentErrorsById,
  ERROR_WINDOW, ERROR_COUNT, BURN, tokenRate, burnOf, burnTarget, bandBurn,
  // Orchestrator thinking indicator — orchestrator.busy
  // (an existing snapshot()/SSE payload field, no new signal) eased into a
  // 0..1 level and turned into the streams look's glow/spin boost.
  THINKING_EASE_TAU, THINKING_GLOW_MULT, THINKING_SPIN_MULT,
  easeThinking, thinkingGlowMult, thinkingSpinMult, thinkingTint, THINKING_RED,
} from '../syzygy/bridge/public/swarm-math.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
let n = 0
const ok = (label, fn) => { fn(); n++; console.log(`  ok  ${label}`) }

ok('every mood has a colour pair', () => {
  for (const [name, m] of Object.entries(MOODS)) {
    assert.match(m.a, /^#[0-9a-f]{6}$/i, `${name}.a is a hex colour`)
    assert.match(m.b, /^#[0-9a-f]{6}$/i, `${name}.b is a hex colour`)
  }
})

ok('moodColors is total — an unknown mood falls back to idle', () => {
  assert.deepEqual(moodColors('working'), MOODS.working)
  assert.deepEqual(moodColors('nonsense'), MOODS.idle)
  assert.deepEqual(moodColors(undefined), MOODS.idle)
})

// The 2D fallback keeps its own MOOD table in app.js. Two tables can drift, so
// the names are pinned against the real file rather than trusted.
ok('mood names match the 2D orb\'s MOOD table in app.js', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/app.js'), 'utf8')
  const block = src.slice(src.indexOf('const MOOD = {'))
  const names = [...block.slice(0, block.indexOf('}\n')).matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1])
  assert.deepEqual(names.sort(), Object.keys(MOODS).sort())
})

// the heartbeat trigger's genuinelyWorking/
// STALL_MS is a deliberate MIRROR of app.js's own copy (swarm.js is an ES
// module, app.js a plain classic script, so there is no shared scope to
// import across) — same pattern as the MOOD-name pin just below. Pinned
// against app.js's real source, not trusted to stay in sync by construction.
ok('genuinelyWorking/STALL_MS mirror app.js\'s real copy, not a drifted one', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/app.js'), 'utf8')
  assert.match(src, /const STALL_MS = 30_000/, 'app.js\'s STALL_MS')
  assert.equal(STALL_MS, 30_000, 'swarm-math.js\'s mirror must match')
  assert.match(
    src,
    /const genuinelyWorking = \(s\) => !!\(s && s\.working && !\(s\.progressAt && Date\.now\(\) - s\.progressAt > STALL_MS\)\)/,
    'app.js\'s genuinelyWorking',
  )
  // Behavioural pin, not just a copy-pasted regex match: the same inputs
  // must produce the same verdict.
  const now = Date.now()
  for (const s of [
    null, undefined, {},
    { working: true },
    { working: true, progressAt: now },
    { working: true, progressAt: now - STALL_MS - 1000 },
    { working: false, progressAt: now },
  ]) {
    assert.equal(
      genuinelyWorking(s),
      !!(s && s.working && !(s.progressAt && Date.now() - s.progressAt > STALL_MS)),
      `genuinelyWorking(${JSON.stringify(s)})`,
    )
  }
})

ok('genuinelyWorking is edge-detectable: true while working and not stalled, false once stalled or idle', () => {
  const now = Date.now()
  assert.equal(genuinelyWorking({ working: true, progressAt: now }), true)
  assert.equal(genuinelyWorking({ working: true }), true, 'no progressAt yet is not a stall')
  assert.equal(genuinelyWorking({ working: true, progressAt: now - STALL_MS - 1 }), false, 'stalled past STALL_MS')
  assert.equal(genuinelyWorking({ working: false, progressAt: now }), false, 'not working at all')
})

ok('session orbits are deterministic and distinct', () => {
  for (let i = 0; i < MAX_SESSIONS; i++) {
    assert.deepEqual(sessionOrbit(i), sessionOrbit(i), 'same index, same orbit')
  }
  const phases = new Set()
  for (let i = 0; i < MAX_SESSIONS; i++) phases.add(sessionOrbit(i).phase)
  assert.equal(phases.size, MAX_SESSIONS, 'no two sessions share a phase')
})

ok('session orbits stay outside the shell', () => {
  for (let i = 0; i < MAX_SESSIONS; i++) {
    assert.ok(sessionOrbit(i).radius > 1, `orbit ${i} is outside the unit shell`)
  }
})

ok('sessions clamp at MAX_SESSIONS', () => {
  assert.equal(clampSessions(new Array(50).fill({})).length, MAX_SESSIONS)
  assert.equal(clampSessions([{}, {}]).length, 2)
  assert.equal(clampSessions([]).length, 0)
})

ok('the pulse ring holds at most four and evicts the oldest', () => {
  const r = makePulseRing()
  for (let i = 0; i < 9; i++) pushPulse(r, i * 100, 1)
  assert.equal(r.slots.length, 4, 'fixed size — GLSL uniform arrays are fixed')
  const births = r.slots.map((s) => s.birth).sort((a, b) => a - b)
  assert.deepEqual(births, [500, 600, 700, 800], 'the four most recent survive')
})

ok('a pulse ages from 0 to 1 and then leaves', () => {
  const r = makePulseRing()
  pushPulse(r, 1000, 1)
  assert.equal(activePulses(r, 1000, 500)[0].age01, 0, 'newborn')
  assert.equal(activePulses(r, 1250, 500)[0].age01, 0.5, 'halfway')
  assert.equal(activePulses(r, 1600, 500).length, 0, 'expired pulses are dropped')
})

// A mode is which whole presence LOOK is active. iris, streams and shell are
// the three the corner button cycles; 'nebula' below stands for a look that is
// not in the registry, which is what normalizeMode has to reject.
ok('normalizeMode accepts the real modes and rejects anything else', () => {
  assert.deepEqual(MODES, ['iris', 'streams', 'shell', 'shell v2'])
  for (const m of MODES) assert.equal(normalizeMode(m), m)
  assert.equal(normalizeMode('nebula'), DEFAULT_MODE, 'an unknown name falls back to the default')
  assert.equal(normalizeMode(''), DEFAULT_MODE)
  assert.equal(normalizeMode(null), DEFAULT_MODE)
})

ok('normalizeMode is idempotent', () => {
  for (const m of [...MODES, 'junk', null]) {
    assert.equal(normalizeMode(normalizeMode(m)), normalizeMode(m))
  }
})

// An arbitrary number of looks, not exactly two: this is the property that
// makes that possible. Nothing in swarm.js branches on a look's name, only on
// whether LOOKS has an entry for it.
ok('every mode has a look config, so the switcher stays total', () => {
  for (const m of MODES) {
    assert.ok(LOOKS[m], `${m} has a LOOKS entry`)
    assert.ok(Object.keys(LOOKS[m]).length > 0, `${m}'s look config sets at least one value`)
  }
})

ok('the shipped looks are crest-capture on (iris) and off (shell) — the two paths swarm.js\'s VERT already has', () => {
  assert.equal(LOOKS.iris.uGather, 1)
  assert.equal(LOOKS.shell.uGather, 0)
})

// Reactive layer — uRipLift/uRipGlow
// ride the same "a look is a set of uniform values" mechanism uGather does:
// applyLook() writes them onto material.uniforms exactly like uGather, so a
// look's value for them is the whole gate. beat*uRipLift and beat*uRipGlow
// are zero at 0 regardless of what is in uRipA/uRipB at the time.
//
// shell has no crest field, so a zero here would multiply the orchestrator's
// ask ring away entirely and leave only the colour shift. Lower than iris
// because shell's grains are twice as opaque and the same lift reads far
// louder on them.
ok('the field ripple\'s body-lift and front-glow are look-gated per look, and every look that uses the legacy material sets both', () => {
  assert.equal(LOOKS.iris.uRipLift, 0.4)
  assert.equal(LOOKS.iris.uRipGlow, 0.35)
  for (const k of ['shell', 'shell v2']) {
    assert.ok('uRipLift' in LOOKS[k] && 'uRipGlow' in LOOKS[k], `${k} must set both or inherit the previous look's`)
  }
  // Every shell-family look must actually RESPOND — a zero here is the bug,
  // not a style choice.
  // BEAT DOES NOT PEAK AT 1, and sizing these as if it did is why two
  // attempts at this changed nothing visible. In the shader beat is
  // sum(B.x * gaussian) and B.x is the preset's BEND, so it tops out at the
  // largest bend across the presets — 0.13 today. A multiplier of 0.3 buys
  // 0.039 units of lift on a radius-1 sphere, which is invisible.
  const beatPeak = Math.max(...Object.values(RIPPLE).filter((v) => v && typeof v === 'object' && 'bend' in v).map((v) => v.bend))
  assert.ok(beatPeak < 0.2, `beat peaks at ${beatPeak} — the multipliers below are sized against THIS, not against 1`)
  for (const k of ['shell', 'shell v2']) {
    // these have uGather 0, so the BEND does nothing here — iris's visible
    // ripple is the bend acting on its crest field. Lift and glow are shell's
    // only response, so they carry the whole effect and must be much larger
    // than iris's, not smaller.
    assert.ok(LOOKS[k].uRipLift * beatPeak > 0.08,
      `${k} lifts by only ${(LOOKS[k].uRipLift * beatPeak).toFixed(3)} units — not a visible swell`)
    assert.ok(LOOKS[k].uRipGlow > 0.5, `${k} glow ${LOOKS[k].uRipGlow} is too faint to read as a front`)
    // ...and must stay inside the containment ceiling, or contain() eats it.
    assert.ok(1 + LOOKS[k].uRipLift * beatPeak < CONTAIN_CEILING,
      `${k} peaks at radius ${(1 + LOOKS[k].uRipLift * beatPeak).toFixed(3)} against a ceiling of ${CONTAIN_CEILING.toFixed(4)}`)
  }
  // The arcs are scaled against the same peak.
  assert.ok(SCRIBBLE.ripple * beatPeak > 0.08, 'the arcs must be swept visibly by a passing ring')
})

// streams is deliberately a DIFFERENT shape — see the comment on LOOKS in
// swarm-math.js. This pins that shape so a future edit cannot quietly fold
// streams back into the flat uniform-override map iris/shell use, which
// would make applyLook() silently do nothing for it (none of `.p`'s keys are
// legacy uniform names, so the wrong shape fails by doing nothing, not by
// throwing — exactly the kind of mistake worth pinning).
ok('streams is a whole separate look (its own params table), not a uniform-override map', () => {
  assert.ok(LOOKS.streams.p, 'has a .p parameter table')
  assert.equal(typeof LOOKS.streams.alpha, 'number')
  assert.equal(LOOKS.streams.wrap, Math.PI * 20, 'lane factors are tenths of uAngle — the wrap must be an exact multiple of 2*PI for every one of them')
  for (const key of ['scaleAlong', 'scaleAcross', 'branchScale', 'branch', 'warp', 'gather', 'reach', 'fall', 'loose', 'relief', 'dustFade', 'shimmer', 'stretch', 'shear', 'orbit', 'drift', 'morph']) {
    assert.equal(typeof LOOKS.streams.p[key], 'number', `.p.${key} is a number`)
  }
})

ok('swarm.js imports the mode switcher from swarm-math.js, not a hand-copied table', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  assert.match(
    src,
    /import\s*\{[^}]*MODES[^}]*normalizeMode[^}]*LOOKS[^}]*\}\s*from\s*'\.\/swarm-math\.js'/s,
    'imports MODES, normalizeMode and LOOKS from swarm-math.js',
  )
})

// --- Body radius envelope — the guard for the unnormalized-curl bug ---
// The bug: curl() in swarm.js's VERT shader was never normalized, so three
// Euler steps of advection could push a body particle's length(p) to
// several units, and `rad = mix(length(p), shellTerm, 0.72)` fed that
// straight into the radius. The panel rendered as a flat rectangular field
// of uniform dust — the sphere was there, just ~4x too big for the 280px
// panel to show anything but its middle. Six diff reviews passed this
// because the code correctly implemented the (wrong) unbounded formula; a
// diff review has no way to catch "this is geometrically unbounded" from
// reading source next to a description that never states a bound either.
//
// The vertex/fragment shaders are GLSL and genuinely cannot be unit-tested
// in node — see the "stated limitation" above, which this does not
// contradict. What CAN be tested is the radius blend's bound, because the
// fix clamps length(p) to [RADIUS_CLAMP_MIN, RADIUS_CLAMP_MAX] BEFORE the
// blend runs, which makes the worst case pure arithmetic over that clamp
// and the blend/thickness/relief constants — no noise involved. swarm.js
// imports these same constants and interpolates them into its shader
// source (see the next check), so this is asserting on the real values,
// not a copy that can drift the way a reimplemented noise field would.
//
// the ORIGINAL version of this test bounded `max`
// against a hand-picked "1.6 leaves real margin" literal. That literal was
// itself the bug: the camera's own visible half-height (VISIBLE_HALF_HEIGHT,
// ≈1.3255 at the shipped FOV/distance) is LESS than 1.6, so a worst-case
// radius that merely cleared 1.6 could still — and did — clip the panel.
// RADIUS_CLAMP_MAX is now derived from VISIBLE_HALF_HEIGHT (see its own
// comment in swarm-math.js), so the bound below is derived too: against
// SAFE_RADIUS (the camera bound with its own documented margin), not a
// number picked to leave some margin under a failure mode that was never
// itself measured against what the camera can show.
ok('the body radius blend fits inside the camera\'s own visible bound, at any activity level', () => {
  const max = maxBodyRadius()
  const min = minBodyRadius()
  assert.ok(max < SAFE_RADIUS, `worst-case body radius ${max} must stay under SAFE_RADIUS=${SAFE_RADIUS} (the camera's own visible bound, margined)`)
  assert.ok(max < VISIBLE_HALF_HEIGHT, `worst-case body radius ${max} must stay under the camera's true visible bound ${VISIBLE_HALF_HEIGHT} — not just the margined one`)
  assert.ok(max > 1.0, 'sanity: the clamp band must still let the shell read as a sphere, not collapse toward a point')
  assert.ok(min > 0.3, `floor ${min} must stay well clear of the origin — a body particle should never collapse to the centre`)
  // maxBodyRadius/minBodyRadius take no uActivity, uFlow or uTime argument
  // at all — that absence is the actual proof that the bound holds at
  // uActivity 1.0 (the case that regresses if only the static size is
  // patched: dt scales with activity right up until the clamp, which sits
  // strictly upstream of it). Calling twice with nothing to vary shows the
  // signature carries no such input to begin with.
  assert.equal(maxBodyRadius(), maxBodyRadius(), 'no hidden activity/time dependence in the bound')
  // The documented tuning ceiling for uRelief (swarm.js: "0-0.08") must not
  // itself be able to blow the bound past the camera either.
  assert.ok(maxBodyRadius(0.08) < SAFE_RADIUS, 'the bound must hold even at uRelief\'s documented ceiling')
})

ok('the camera\'s visible bound is derived from its own FOV/distance, not a hand-typed number', () => {
  // sin(halfFOV) * distance, spelled out independently of swarm-math.js's
  // own arithmetic (a different expression of the same identity), so this
  // is a real check against the geometry, not a restatement of the source.
  // sin, not tan: VISIBLE_HALF_HEIGHT bounds a RADIAL distance from the
  // origin in every direction (softClampRadius clamps length(p), not a
  // z=0-plane coordinate) — the sphere-silhouette identity R <= D*sin(half
  // FOV), not the flat-plane-at-one-depth identity R <= D*tan(halfFOV). An
  // tan passes every one of these tests while still clipping on screen, which
  // is why the identity itself is asserted here and not the numbers it
  // happens to produce.
  const expected = CAMERA_Z * Math.sin((CAMERA_FOV_DEG / 2) * (Math.PI / 180))
  assert.ok(Math.abs(VISIBLE_HALF_HEIGHT - expected) < 1e-9, `VISIBLE_HALF_HEIGHT=${VISIBLE_HALF_HEIGHT} must equal sin(halfFOV)*z=${expected}`)
  const flatPlaneTan = CAMERA_Z * Math.tan((CAMERA_FOV_DEG / 2) * (Math.PI / 180))
  assert.ok(VISIBLE_HALF_HEIGHT < flatPlaneTan, `VISIBLE_HALF_HEIGHT=${VISIBLE_HALF_HEIGHT} must be strictly less than the flat-plane tan() figure ${flatPlaneTan} — sin is the tighter, correct bound for a 3D ball`)
  assert.equal(CAMERA_FOV_DEG, 45, 'sanity: the shipped camera FOV — changing this is a real framing change, not silent drift')
  assert.equal(CAMERA_Z, 3.2, 'sanity: the shipped camera distance')
  assert.ok(CAMERA_MARGIN > 0 && CAMERA_MARGIN < 1, 'sanity: a fraction of the visible bound, not the whole thing or none of it')
  // SPRITE_MARGIN, and CONTAIN_CEILING = VISIBLE_HALF_HEIGHT - SPRITE_MARGIN
  // — compressing all the way to VISIBLE_HALF_HEIGHT itself still touches the
  // panel's own border pixels under a sustained pointer lean:
  // softClampRadius's compression is asymptotic, so a large enough `len`
  // (the lean alone drives this) pushes the output arbitrarily close to
  // whatever it compresses TOWARD, leaving no room at all for a point
  // sprite's own screen-space radius if that target is the camera's literal
  // edge.
  assert.ok(SPRITE_MARGIN > 0, 'sanity: a real, positive margin, not zero')
  assert.ok(Math.abs(CONTAIN_CEILING - (VISIBLE_HALF_HEIGHT - SPRITE_MARGIN)) < 1e-9, 'CONTAIN_CEILING = VISIBLE_HALF_HEIGHT - SPRITE_MARGIN')
  assert.ok(CONTAIN_CEILING < VISIBLE_HALF_HEIGHT, 'the asymptote itself must sit strictly inside the camera\'s true bound')
  assert.ok(Math.abs(SAFE_RADIUS - CONTAIN_CEILING * CAMERA_MARGIN) < 1e-9, 'SAFE_RADIUS = CONTAIN_CEILING * CAMERA_MARGIN')
})

ok('softClampRadius: identity below the threshold, strictly under CONTAIN_CEILING (and so under the camera\'s true bound) above it, monotonic', () => {
  // Identity in the region the gather pipeline itself can reach — the WHOLE
  // point of sizing RADIUS_CLAMP_MAX to keep maxBodyRadius() under
  // SAFE_RADIUS (previous test) is that this backstop never touches
  // ordinary geometry, only the pointer lean / pulse shove / ripple lift
  // terms that land on `p` downstream of it.
  assert.equal(softClampRadius(0), 0)
  assert.equal(softClampRadius(0.5), 0.5)
  assert.equal(softClampRadius(SAFE_RADIUS), SAFE_RADIUS, 'still identity exactly AT the threshold')
  // Above the threshold: strictly under CONTAIN_CEILING — not merely under
  // VISIBLE_HALF_HEIGHT, which would be satisfied even by compressing all
  // the way to the camera's own edge (the bug SPRITE_MARGIN fixes) — across
  // every input the shader's own terms (lean, shove, ripple lift, the
  // concurrency multiplier) could plausibly ever produce (realistic worst
  // case is well under 3 — see the report's measured excursions). This is
  // the actual "no particle, INCLUDING its own point-sprite radius, can
  // ever escape the frustum" guarantee.
  for (const len of [1.3, 1.5, 2.0, 2.5, 3.0]) {
    const out = softClampRadius(len)
    assert.ok(out < CONTAIN_CEILING, `softClampRadius(${len})=${out} must stay strictly under CONTAIN_CEILING=${CONTAIN_CEILING}`)
    assert.ok(out < VISIBLE_HALF_HEIGHT, `softClampRadius(${len})=${out} must (a fortiori) stay under VISIBLE_HALF_HEIGHT=${VISIBLE_HALF_HEIGHT}`)
  }
  // Mathematically tanh(x) < 1 for every finite x, so the guarantee above is
  // an equality only in the limit — but float64 rounds tanh's complement to
  // exactly 0 once x is large enough (measured: len >= ~4 here), so a truly
  // pathological input can legitimately round to EXACTLY CONTAIN_CEILING,
  // not just approach it. Still strictly under VISIBLE_HALF_HEIGHT even
  // then, by a full SPRITE_MARGIN — which is the entire point.
  for (const len of [50, 1e6]) {
    const out = softClampRadius(len)
    assert.ok(out <= CONTAIN_CEILING, `softClampRadius(${len})=${out} must never exceed CONTAIN_CEILING=${CONTAIN_CEILING}, even at float64's rounding limit`)
    assert.ok(out < VISIBLE_HALF_HEIGHT, `softClampRadius(${len})=${out} must stay strictly under VISIBLE_HALF_HEIGHT=${VISIBLE_HALF_HEIGHT} with a full SPRITE_MARGIN to spare`)
  }
  // Monotonic — a soft knee compresses, it never reorders.
  let prev = 0
  for (let len = 0; len <= 10; len += 0.1) {
    const out = softClampRadius(len)
    assert.ok(out >= prev, `softClampRadius must be monotonic: len=${len} gave ${out} < previous ${prev}`)
    prev = out
  }
})

ok('swarm.js sources its clamp band AND the camera itself from these constants, not hand-copied numbers', () => {
  // This is what stops the shader and this file drifting apart the way an
  // independent GLSL reimplementation could — same pattern already used
  // above to pin MOOD names against app.js's real MOOD table.
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  assert.match(
    src,
    /import\s*\{[^}]*RADIUS_CLAMP_MIN[^}]*RADIUS_CLAMP_MAX[^}]*SHELL_BLEND[^}]*SHELL_THICKNESS[^}]*\}\s*from\s*'\.\/swarm-math\.js'/s,
    'imports the clamp band, blend weight and shell thickness from swarm-math.js',
  )
  assert.match(
    src,
    /clamp\(length\(p\),\s*\$\{RADIUS_CLAMP_MIN\.toFixed\(4\)\},\s*\$\{RADIUS_CLAMP_MAX\.toFixed\(4\)\}\)/,
    'the shader\'s clamp call is built from the imported constants, not literal numbers that could drift from them',
  )
  assert.ok(RADIUS_CLAMP_MIN < RADIUS_CLAMP_MAX, 'sanity: the clamp band is non-empty')
  assert.ok(SHELL_BLEND > 0 && SHELL_BLEND < 1, 'sanity: a mix() weight')
  assert.ok(SHELL_THICKNESS >= 0 && MAX_RELIEF >= 0, 'sanity: non-negative tuning magnitudes')
  // the camera itself must be built from CAMERA_FOV_DEG/CAMERA_Z,
  // not the literal 45/3.2 that caused this bug: an edit to either constant
  // now moves the ACTUAL camera and the derived clamp/backstop together,
  // which is what "changing one cannot silently reintroduce this" means.
  assert.match(
    src,
    /import\s*\{[^}]*CAMERA_FOV_DEG[^}]*CAMERA_Z[^}]*\}\s*from\s*'\.\/swarm-math\.js'/s,
    'imports the camera\'s FOV/distance from swarm-math.js',
  )
  assert.match(
    src,
    /new PerspectiveCamera\(CAMERA_FOV_DEG,\s*1,\s*0\.1,\s*100\)/,
    'the camera is constructed from CAMERA_FOV_DEG, not a literal 45',
  )
  assert.match(
    src,
    /camera\.position\.set\(0,\s*0,\s*CAMERA_Z\)/,
    'the camera is positioned from CAMERA_Z, not a literal 3.2',
  )
  // Every VERT calls contain(p) — the final backstop — right before building
  // the position it actually projects. TWO call sites: the legacy body path
  // and streams.
  //
  // The ORBITAL path is not one of them any more, and that is deliberate.
  // contain() is a tanh squash onto CONTAIN_CEILING that saturates hard, so
  // applied per point it mapped every point of an orbiting cluster onto one
  // radius and flattened the sphere onto the containment shell — 0.000% of
  // its depth survived. The orbiting clusters clamp their CENTRE instead,
  // which respects the panel without destroying the geometry. Pinned in its
  // own test below, including that per-point contain must never return.
  const containCalls = src.match(/p = contain\(p\);/g) ?? []
  assert.equal(containCalls.length, 2, `expected contain(p) at the two whole-field paths (body, streams), found ${containCalls.length}`)
})

// --- Streams — the harness twin --------
// The streams transport is closed-form with NO noise in it, so this twin is
// EXACT, not an approximation that can drift — the standing "GLSL is not
// unit-testable" objection is about copying noise, and this copies none.
// It is the first thing in this build that tests how a look actually MOVES,
// not only what the code says.
//
// Three determinism requirements, binding:
//  1. Fibonacci homes from swarm-math.js's own fibonacciHomes() (not
//     Math.random, not a re-derivation) + a seeded PRNG for aSeed.
//  2. Assert against LOOKS.streams.p imported from the real module — never
//     a hand-copied table, or this test would keep passing while the
//     shipped look degrades. Checked concretely below, not just claimed.
//  3. Wrap uAngle at LOOKS.streams.wrap (20*PI) and sample the 7s window at
//     a random offset into a long run (0..600s), never from t=0.
//
// seedRng=1, offsetRng=1 is the fixed canonical draw this harness ships —
// picked for a comfortable margin on every one
// of the seven bounds, not a lucky one-in-many roll: a sweep across nine
// different (seedRng, offsetRng) pairs at these same defaults landed every
// metric inside its bound in every trial.

ok('streams: this file never calls the non-deterministic RNG — the harness must stay reproducible', () => {
  const src = readFileSync(join(ROOT, 'test/swarm-harness.mjs'), 'utf8')
  // Built by concatenation so this very check's own source cannot match
  // itself: homes and seeds must come from fibonacciHomes()/mulberry32(),
  // never the non-deterministic call.
  const forbidden = 'Math.' + 'random('
  assert.ok(!src.includes(forbidden), 'this file must draw homes/seeds from fibonacciHomes()/mulberry32() only')
})

ok('streams: fibonacciHomes() is the same formula swarm.js\'s buildGeometry() has always used inline', () => {
  const h = fibonacciHomes(5)
  assert.equal(h.length, 5)
  // k=0 is the pole (y=1); every point is unit length.
  assert.ok(Math.abs(h[0][1] - 1) < 1e-9, 'k=0 sits at the pole')
  for (const p of h) assert.ok(Math.abs(Math.hypot(...p) - 1) < 1e-9, 'every home is a unit vector')
})

ok('streams: mulberry32 is deterministic and NOT Math.random', () => {
  const a = mulberry32(42), b = mulberry32(42)
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()]
  assert.deepEqual(seqA, seqB, 'same seed, same sequence, every run')
  for (const v of seqA) assert.ok(v >= 0 && v < 1)
})

// Determinism, made concrete rather than merely claimed: mutate the
// REAL LOOKS.streams.p (the object swarm.js's own material is built from —
// see the import check further down) and confirm the measured metric moves.
// A test that quietly asserted against a copy would not notice this mutation
// at all; this one must, or the wiring is wrong.
ok('streams: motionMetrics is wired to the live LOOKS.streams.p, not a copy', () => {
  const base = motionMetrics(transportStreams, LOOKS.streams.p, { wrap: LOOKS.streams.wrap, seedRng: 1, offsetRng: 1 })
  const savedOrbit = LOOKS.streams.p.orbit
  try {
    LOOKS.streams.p.orbit = savedOrbit * 3
    const bumped = motionMetrics(transportStreams, LOOKS.streams.p, { wrap: LOOKS.streams.wrap, seedRng: 1, offsetRng: 1 })
    assert.ok(bumped.meanSpeedPx > base.meanSpeedPx * 1.5, 'tripling the live orbit rate must visibly raise the twin\'s own measured speed')
  } finally {
    LOOKS.streams.p.orbit = savedOrbit // restore — this IS the shipped table, shared with every other check below
  }
})

// The seven assertions, run at BOTH activity 0 and activity 1. The shipped
// defaults barely moved, even when thinking.
// Two causes, both fixed in swarm-math.js's
// advance(): idle sat at the very floor of its own [5,12] band (measured
// 6.01), and the orbit-rate reaction was linear in activity, so the
// realistic 0.1-0.4 range a real working session mostly lives in barely
// nudged it. ORBIT_IDLE_MUL/ORBIT_BUSY_MUL were retuned (1.1/2.1, from
// 0.7/2.0) and the response reshaped by sqrt(act) — the same front-loading
// trick iris's own `act = sqrt(uActivity)` already uses — so most of the
// idle-to-busy swing lands inside the activity range a session actually
// spends its time in, not only at the act=1 extreme.
//
// At ORBIT_IDLE_MUL/ORBIT_BUSY_MUL 1.3/2.3, coherence13 appears to hit a wall
// around orbit multiplier 2.5-2.7.
//
// That wall is the METRIC, not
// the motion — see motionMetrics()'s own doc comment in swarm-math.js and
// ORBIT_IDLE_MUL's comment for the full diagnosis (whole-hemisphere
// coherence pairing let a speed-dependent mix of limb grains into the
// sample; a controlled experiment with the six-lane spread forced OFF
// reproduced the identical drop, which is impossible if lanes were the
// cause). With the metric fixed (coherence pairs cone-restricted to the
// same `centreDeg` cone as speed/path/turns; the sampling window AND the
// per-step dt scaled with the orbit rate, in `motionMetrics()`), the
// requested target is fully reachable with real margin — ORBIT_IDLE_MUL/
// ORBIT_BUSY_MUL now 5.25/14.5 (~45.0px/s idle, ~123.7px/s busy — see that
// constant's own comment).
//
// Asserting BOTH activity levels, with the SAME coherence/path/turns/radial
// bounds at each, is the load-bearing part: it encodes "thinking makes it
// faster, never more chaotic" as a checked contract, not a hope. Without
// the activity-1 half, a future tuning pass could buy visible motion by
// reintroducing jitter and nothing here would object — see
// motionMetrics()'s own methodology comment.
//
// LOOKS.streams.p is imported directly rather than copied, and
// coherence@53px is raised from 0.50 to 0.90 (see that assertion's own
// comment below).
const streamsIdle = motionMetrics(transportStreams, LOOKS.streams.p, {
  wrap: LOOKS.streams.wrap, seedRng: 1, offsetRng: 1, act: 0,
})
const streamsBusy = motionMetrics(transportStreams, LOOKS.streams.p, {
  wrap: LOOKS.streams.wrap, seedRng: 1, offsetRng: 1, act: 1,
})

// bounds retuned from [7,14]/[14,24] to
// [30,60]/[90,150] alongside ORBIT_IDLE_MUL/ORBIT_BUSY_MUL going
// 1.3->5.25 / 2.3->14.5, now that the metric fix (see above) shows the
// requested 45/110-135px/s target carries real margin on every guard, not a
// wall. Measured range across the same seven (seedRng, offsetRng) pairs the
// robustness check below uses: idle [38.07, 46.02], busy [105.15, 128.36].
// New bounds are padded on either side of that measured range (not snug
// against it), comparable in relative terms to the old bounds' own margin,
// so a real regression still trips this, not just a return to the exact old
// numbers.
ok('streams: mean screen speed at the disc centre, activity 0, in [30, 60] px/s', () => {
  assert.ok(streamsIdle.meanSpeedPx >= 30 && streamsIdle.meanSpeedPx <= 60,
    `meanSpeedPx=${streamsIdle.meanSpeedPx.toFixed(2)}`)
})

ok('streams: mean screen speed at the disc centre, activity 1, in [90, 150] px/s', () => {
  assert.ok(streamsBusy.meanSpeedPx >= 90 && streamsBusy.meanSpeedPx <= 150,
    `meanSpeedPx=${streamsBusy.meanSpeedPx.toFixed(2)}`)
})

// "7s window" is now a misnomer for the raw constant — motionMetrics()
// scales the sampled window (and the per-step dt) with the orbit rate
// (see its own doc comment), so the true
// window is ~2s at idle and shorter at busy. The assertion's OWN < 1.10
// bound is unchanged; only the sample window that makes it measurable (not
// NaN, not pi/2 from pure half-turn geometry) moved.
ok('streams: path length over net displacement, scaled sampling window, < 1.10 at activity 0 and 1', () => {
  assert.ok(streamsIdle.pathOverNet < 1.10, `idle pathOverNet=${streamsIdle.pathOverNet.toFixed(4)}`)
  assert.ok(streamsBusy.pathOverNet < 1.10, `busy pathOverNet=${streamsBusy.pathOverNet.toFixed(4)}`)
})

// The one assertion with a known breaking point: "bands never reverse"
// holds only while shear * SHEAR_RATE stays under the idle orbit rate.
// raised the idle orbit rate itself (~4x, via
// ORBIT_IDLE_MUL), which moves this margin further away from the shipped
// shear (2.0), not closer — the breaking point's own mechanism (below) is
// unchanged by that, so the finding stands: raising uShear past roughly 2.3
// at the default rates makes the bands genuinely reverse — that failure
// would be CORRECT, not a brittle test. Do not loosen this bound if a
// future tuning pass trips it; look at what changed in LOOKS.streams.p.shear
// or the ORBIT_*_MUL constants instead.
//
// What this harness could and could not confirm empirically while it was
// built: the underlying mechanism is real and closed-form — at shear
// amplitudes past the point where |shear * SHEAR_RATE| exceeds the slowest
// lane's orbit rate, a particle sitting near the flow axis's equator
// (s = dot(home, FLOW_AXIS) close to 0, where cos(BANDS*PI*s) is largest)
// can have its net rotation rate go negative for a stretch of the shear
// cycle. But that stretch is tens of seconds wide against a ~209s shear
// period (2*PI / SHEAR_RATE) and concentrated in a narrow band of latitude
// and lane — an unguided sweep across dozens of (seedRng, offsetRng) pairs
// up to shear 6.0 never landed a random window on it. A targeted
// construction (a home built exactly on the equator, a bank-lane seed, a
// window centred on the shear cycle's zero crossing) confirmed the sign
// flip is real but develops too gradually (order tens of seconds) to
// register as a single >45 degree jump inside any one sampled window
// either. So this harness does not ship a positive-control test that forces
// turnsInWindow > 0 — building one would risk being exactly as fragile
// (dependent on hitting a narrow latitude/phase/window alignment) as the
// flakiness the determinism notes warn against, for a property that is
// already load-bearing physics, not test logic. The breaking point is real
// and documented; it is asserted here only in the sense that
// turnsInWindow == 0 is required at the SHIPPED shear (2.0), at both
// activity levels, with real margin under the ~2.3 threshold.
ok('streams: heading changes > 45deg in the window == 0, at the shipped shear (2.0, under the ~2.3 breaking point), at activity 0 and 1', () => {
  assert.equal(streamsIdle.turnsInWindow, 0, `idle turnsInWindow=${streamsIdle.turnsInWindow}`)
  assert.equal(streamsBusy.turnsInWindow, 0, `busy turnsInWindow=${streamsBusy.turnsInWindow}`)
})

ok('streams: screen-neighbour coherence @ 3px > 0.95 at activity 0 and 1 (the tightest bin — fewest pairs)', () => {
  assert.ok(streamsIdle.coherence3 > 0.95, `idle coherence3=${streamsIdle.coherence3.toFixed(4)}`)
  assert.ok(streamsBusy.coherence3 > 0.95, `busy coherence3=${streamsBusy.coherence3.toFixed(4)}`)
})

ok('streams: screen-neighbour coherence @ 13px > 0.90 at activity 0 and 1', () => {
  assert.ok(streamsIdle.coherence13 > 0.90, `idle coherence13=${streamsIdle.coherence13.toFixed(4)}`)
  assert.ok(streamsBusy.coherence13 > 0.90, `busy coherence13=${streamsBusy.coherence13.toFixed(4)}`)
})

// Raised from 0.50 to 0.90 — 0.50 was sized
// for the OLD, buggy whole-hemisphere pairing (measured ~0.83-0.86 against
// it); cone-restricted, this bin measures ~0.99, so 0.50 was no longer a
// meaningful guard. 0.90 matches the @13px bound and still clears with real
// margin (worst case across the seven-seed sweep below: 0.936).
ok('streams: screen-neighbour coherence @ 53px (across bands) > 0.90 at activity 0 and 1', () => {
  assert.ok(streamsIdle.coherence53 > 0.90, `idle coherence53=${streamsIdle.coherence53.toFixed(4)}`)
  assert.ok(streamsBusy.coherence53 > 0.90, `busy coherence53=${streamsBusy.coherence53.toFixed(4)}`)
})

// motionMetrics now scales the per-step dt
// with the orbit rate, the same way it scales the window (see its own doc
// comment). Without that, busy's radialShare measured ~0.054 at the new,
// faster orbit rate — ABOVE the OLD bound — purely because dt=0.1s is a
// coarser ruler at a faster rotation rate (a first-order forward-difference
// error that grows linearly with the angle swept per step), not because
// particles actually left the shell (the closed-form rotation is exactly
// tangent). This finite-difference floor is still in effect — it is why
// the lift-enabled measurement just below is taken on a SEPARATE run
// (`liftPh` supplied) rather than reused from `streamsIdle`/`streamsBusy`
// above, which stay a pure-rotation, no-lift baseline.
//
// Lift — this bound FLIPS with the lift field. Channels that ebb and flow
// individually, growing and sinking beyond the bounds of the overall sphere,
// directly contradict `radialShare < 0.05`, which was this harness's own way
// of asserting adherence to it. `radialShare ∈ [0.08,
// 0.30]` is the replacement: a lower edge is what proves the excursion is
// actually present (guards against someone zeroing the lift and calling it
// tuning), the upper edge that it stays bounded. Measured on a twin with
// EVERY grain lifted (`liftPh: freshLift()`), the worst case — an upper
// bound on the real figure, since dust never lifts in production (LIFT is
// gated by `vein` in the shader).
const streamsIdleLift = motionMetrics(transportStreams, LOOKS.streams.p, {
  wrap: LOOKS.streams.wrap, seedRng: 1, offsetRng: 1, act: 0, liftPh: freshLift(),
})
const streamsBusyLift = motionMetrics(transportStreams, LOOKS.streams.p, {
  wrap: LOOKS.streams.wrap, seedRng: 1, offsetRng: 1, act: 1, liftPh: freshLift(),
})

ok('streams+lift: radial share (motion off the shell surface) is an excursion, present and bounded — [0.08, 0.30] — at activity 0 and 1', () => {
  assert.ok(streamsIdleLift.radialShare >= 0.08 && streamsIdleLift.radialShare <= 0.30,
    `idle radialShare=${streamsIdleLift.radialShare.toFixed(5)}`)
  assert.ok(streamsBusyLift.radialShare >= 0.08 && streamsBusyLift.radialShare <= 0.30,
    `busy radialShare=${streamsBusyLift.radialShare.toFixed(5)}`)
})

// "The motion metrics that separate a river from flies are untouched" (the
// brief) — but that has to be MEASURED under lift, not assumed, since a
// radial excursion up to `out`/`inn` genuinely changes screen-space
// position and so could in principle move these. Same bounds as the
// unlifted checks above, same seed/offset, now with `liftPh` supplied.
ok('streams+lift: the guard survives lift — speed, path/net, turns and coherence all still clear their bounds at activity 0 and 1', () => {
  for (const [label, m, speedLo, speedHi] of [['idle', streamsIdleLift, 30, 60], ['busy', streamsBusyLift, 90, 150]]) {
    assert.ok(m.meanSpeedPx >= speedLo && m.meanSpeedPx <= speedHi, `${label} meanSpeedPx=${m.meanSpeedPx.toFixed(2)}`)
    assert.ok(m.pathOverNet < 1.10, `${label} pathOverNet=${m.pathOverNet.toFixed(4)}`)
    assert.equal(m.turnsInWindow, 0, `${label} turnsInWindow=${m.turnsInWindow}`)
    assert.ok(m.coherence3 > 0.95, `${label} coherence3=${m.coherence3.toFixed(4)}`)
    assert.ok(m.coherence13 > 0.90, `${label} coherence13=${m.coherence13.toFixed(4)}`)
    assert.ok(m.coherence53 > 0.90, `${label} coherence53=${m.coherence53.toFixed(4)}`)
  }
})

ok('streams+lift: the guard and the radialShare band both hold across a spread of other seeds too, at activity 0 and 1', () => {
  for (const [seedRng, offsetRng] of [[24301, 1045991], [7, 13], [42, 4317], [1234, 999], [99, 7001], [555, 8080]]) {
    for (const act of [0, 1]) {
      const m = motionMetrics(transportStreams, LOOKS.streams.p, { wrap: LOOKS.streams.wrap, seedRng, offsetRng, act, liftPh: freshLift() })
      const tag = `seedRng=${seedRng} offsetRng=${offsetRng} act=${act}`
      if (act === 0) assert.ok(m.meanSpeedPx >= 30 && m.meanSpeedPx <= 60, `${tag} meanSpeedPx=${m.meanSpeedPx.toFixed(2)}`)
      else assert.ok(m.meanSpeedPx >= 90 && m.meanSpeedPx <= 150, `${tag} meanSpeedPx=${m.meanSpeedPx.toFixed(2)}`)
      assert.ok(m.pathOverNet < 1.10, `${tag} pathOverNet=${m.pathOverNet.toFixed(4)}`)
      assert.equal(m.turnsInWindow, 0, `${tag} turnsInWindow=${m.turnsInWindow}`)
      assert.ok(m.coherence3 > 0.95, `${tag} coherence3=${m.coherence3.toFixed(4)}`)
      assert.ok(m.coherence13 > 0.90, `${tag} coherence13=${m.coherence13.toFixed(4)}`)
      assert.ok(m.coherence53 > 0.90, `${tag} coherence53=${m.coherence53.toFixed(4)}`)
      assert.ok(m.radialShare >= 0.08 && m.radialShare <= 0.30, `${tag} radialShare=${m.radialShare.toFixed(5)}`)
    }
  }
})

// --- Lift — the field itself: "individually" made testable ----------------
// The testable definition of "individually": neighbours out of phase, no
// periodic banding across latitude, channels at different heights at the same
// instant, and each one actually cycling.
// All four are properties of `liftField`'s raw field `g` (or, for
// the last, its sign) — NOT of `LIFT.out`/`LIFT.inn` — computed directly
// from the shipped LIFT_MODES table, exactly the shader's own uLiftMode
// uniform values (swarm.js builds that uniform from this same array).
//
// Sampling note: an EVENLY SPACED (phi, t) grid aliases against the
// integer longitude wavenumbers (q ∈ {1,2,3}) and the six modes' shared
// rational-ish rate ratios — checked here by comparing against a seeded-
// random (mulberry32) sample of the same size, which does not alias and
// reproduces the expected range almost exactly (−0.23..−0.29 against this
// harness's −0.19..−0.35 across channel latitudes;
// an evenly spaced grid instead swung as wide as −0.56 at some latitudes,
// which is the grid artifact, not the field — do not "simplify" this back
// to a grid). CHANNEL_SPACING (0.19) is imported from swarm-math.js rather
// than restated here.
const TAU = Math.PI * 2

/** count random (phi, ph) draws — phi uniform on the circle, ph a lift
 *  phase state reached by advancing freshLift() by a random idle-rate
 *  offset into a 0..spanS run (the same random-offset-into-a-long-run
 *  discipline the streams transport checks use, via a seeded PRNG). */
function randomFieldSamples(seedRng, count, spanS = 120) {
  const rng = mulberry32(seedRng)
  const out = []
  for (let i = 0; i < count; i++) {
    const phi = -Math.PI + rng() * TAU
    const ph = advanceLift(freshLift(), 0, rng() * spanS)
    out.push({ phi, ph })
  }
  return out
}
const sampleG = (s, samples) => samples.map(({ phi, ph }) => liftField(s, phi, ph).g)
function correlation(a, b) {
  const n = a.length
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n
  let cov = 0, va = 0, vb = 0
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db }
  return cov / Math.sqrt(va * vb)
}
const LIFT_FIELD_SAMPLES = randomFieldSamples(1, 4000)
// A representative spread of channel latitudes, not one arbitrary pick —
// s = dot(n, FLOW_AXIS) ranges over [-1, 1]; kept off the poles where phi
// degenerates.
const CHANNEL_LATITUDES = [-0.76, -0.57, -0.38, -0.19, 0, 0.19, 0.38, 0.57, 0.76]

ok('lift: adjacent-channel correlation |rho(delta s = 0.19)| <= 0.40 at every sampled channel latitude — neighbours are out of phase, a global breathing would score +1.0', () => {
  for (const s0 of CHANNEL_LATITUDES) {
    const rho = correlation(sampleG(s0, LIFT_FIELD_SAMPLES), sampleG(s0 + CHANNEL_SPACING, LIFT_FIELD_SAMPLES))
    assert.ok(Math.abs(rho) <= 0.40, `s0=${s0}: rho=${rho.toFixed(4)}`)
  }
})

ok('lift: max |rho(delta s)| over lags 0.15-1.2 <= 0.80 — no regular banding across latitude (a single-wavenumber ruler pattern scores 1.00 at its own period)', () => {
  const gA = sampleG(0, LIFT_FIELD_SAMPLES)
  let maxAbsRho = 0
  for (let lag = 0.15; lag <= 1.2 + 1e-9; lag += 0.03) {
    maxAbsRho = Math.max(maxAbsRho, Math.abs(correlation(gA, sampleG(lag, LIFT_FIELD_SAMPLES))))
  }
  assert.ok(maxAbsRho <= 0.80, `max |rho| over the lag sweep = ${maxAbsRho.toFixed(4)}`)
})

ok('lift: cross-band spread at a fixed longitude, averaged over many instants, >= 0.35 x LIFT.out — channels sit at different heights at the same moment', () => {
  const bandSs = []
  for (let s = -0.9; s <= 0.9 + 1e-9; s += CHANNEL_SPACING) bandSs.push(s)
  const rng = mulberry32(2)
  const need = 0.35 * LIFT.out
  let sum = 0, n = 200
  for (let i = 0; i < n; i++) {
    const phi = -Math.PI + rng() * TAU
    const ph = advanceLift(freshLift(), 0, rng() * 120)
    const lifts = bandSs.map((s) => liftField(s, phi, ph).lift)
    const mean = lifts.reduce((a, b) => a + b, 0) / lifts.length
    const variance = lifts.reduce((a, b) => a + (b - mean) ** 2, 0) / lifts.length
    sum += Math.sqrt(variance)
  }
  const meanStd = sum / n
  assert.ok(meanStd >= need, `mean cross-band std=${meanStd.toFixed(4)}, need >= ${need.toFixed(4)}`)
})

ok('lift: every channel band changes sign within 25s at idle — each one is actually cycling, not frozen', () => {
  const bandSs = []
  for (let s = -0.9; s <= 0.9 + 1e-9; s += CHANNEL_SPACING) bandSs.push(s)
  const dt = 0.05, totalT = 90
  let ph = freshLift()
  const signs = bandSs.map((s) => Math.sign(liftField(s, 0, ph).g))
  const lastChange = bandSs.map(() => 0)
  let longest = 0, t = 0
  while (t < totalT) {
    t += dt
    ph = advanceLift(ph, 0, dt)
    for (let i = 0; i < bandSs.length; i++) {
      const sign = Math.sign(liftField(bandSs[i], 0, ph).g)
      if (sign !== 0 && sign !== signs[i]) {
        longest = Math.max(longest, t - lastChange[i])
        lastChange[i] = t
        signs[i] = sign
      }
    }
  }
  for (let i = 0; i < bandSs.length; i++) longest = Math.max(longest, totalT - lastChange[i])
  assert.ok(longest < 25, `longest interval without a sign change = ${longest.toFixed(2)}s`)
})

// Degenerate controls — proof the four tests above actually discriminate
// "individually" from its two obvious failure modes, not just numbers that
// happen to clear a bound. A single-wavenumber field still puts neighbours
// out of phase, so it passes the adjacent test, but it is a pattern drawn
// with a ruler and fails the lag sweep: the adjacent-lag test ALONE would
// have passed this pattern, and the lag sweep is what catches it.
ok('lift controls: a global breathing (k_s=0 for every mode) scores +1.0 adjacent-channel correlation — proves the adjacent test discriminates', () => {
  const globalModes = LIFT_MODES.map(([, q, a, r]) => [0, q, a, r])
  const globalG = (s, phi, ph) => globalModes.reduce((acc, [ks, q, a], m) => acc + a * Math.sin(ks * s + q * phi + ph[m]), 0)
  const samples = LIFT_FIELD_SAMPLES
  const gA = samples.map(({ phi, ph }) => globalG(0, phi, ph))
  const gAdj = samples.map(({ phi, ph }) => globalG(CHANNEL_SPACING, phi, ph))
  const rho = correlation(gA, gAdj)
  assert.ok(rho > 0.99, `global-breathing control rho=${rho.toFixed(4)}, expected ~+1.0`)
})

ok('lift controls: a single-wavenumber field scores ~1.00 max |rho| in the lag sweep at its own period — proves the lag sweep catches a "ruler" pattern the adjacent test alone would miss', () => {
  const singleModes = [[19, 1, 1.0, LIFT_MODES[2][3]]]
  const singleG = (s, phi, ph) => singleModes[0][2] * Math.sin(singleModes[0][0] * s + singleModes[0][1] * phi + ph[0])
  const rng = mulberry32(3)
  const samples = []
  for (let i = 0; i < 4000; i++) {
    const phi = -Math.PI + rng() * TAU
    const ph = [(singleModes[0][3] * rng() * 120) % TAU]
    samples.push({ phi, ph })
  }
  const gA = samples.map(({ phi, ph }) => singleG(0, phi, ph))
  let maxAbsRho = 0
  for (let lag = 0.15; lag <= 1.2 + 1e-9; lag += 0.03) {
    const gL = samples.map(({ phi, ph }) => singleG(lag, phi, ph))
    maxAbsRho = Math.max(maxAbsRho, Math.abs(correlation(gA, gL)))
  }
  assert.ok(maxAbsRho > 0.95, `single-wavenumber control max|rho|=${maxAbsRho.toFixed(4)}, expected ~1.00`)
})

// --- Lift's ceiling and the field's own construction bounds --------
ok('lift: the hard ceiling — 1 + LIFT.out + SHELL_THICKNESS/2 + MAX_RELIEF < VISIBLE_HALF_HEIGHT, imported, not hand-typed', () => {
  const sum = 1 + LIFT.out + SHELL_THICKNESS / 2 + MAX_RELIEF
  assert.ok(sum < VISIBLE_HALF_HEIGHT, `1 + LIFT.out + SHELL_THICKNESS/2 + MAX_RELIEF = ${sum.toFixed(4)} must be < VISIBLE_HALF_HEIGHT=${VISIBLE_HALF_HEIGHT.toFixed(4)}`)
})

ok('lift: every longitude wavenumber is an integer — no seam at phi = +/- pi', () => {
  for (const [, q] of LIFT_MODES) assert.ok(Number.isInteger(q), `q=${q} must be an integer`)
})

ok('lift: the six mode amplitudes sum to exactly 1', () => {
  const sum = LIFT_MODES.reduce((s, [, , a]) => s + a, 0)
  assert.ok(Math.abs(sum - 1) < 1e-12, `amplitude sum=${sum}`)
})

ok('lift: LIFT.out/LIFT.inn are asymmetric — channels rise a little, sink a lot — and AXIS_U/AXIS_V/FLOW_AXIS form a right-handed orthonormal frame', () => {
  assert.ok(LIFT.out > 0 && LIFT.out < LIFT.inn, `out=${LIFT.out} must be positive and less than inn=${LIFT.inn}`)
  assert.ok(Math.abs(Math.hypot(...AXIS_U) - 1) < 1e-9, 'AXIS_U is unit')
  assert.ok(Math.abs(Math.hypot(...AXIS_V) - 1) < 1e-9, 'AXIS_V is unit')
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  assert.ok(Math.abs(dot(AXIS_U, FLOW_AXIS)) < 1e-9, 'AXIS_U is perpendicular to FLOW_AXIS')
  assert.ok(Math.abs(dot(AXIS_U, AXIS_V)) < 1e-9, 'AXIS_U is perpendicular to AXIS_V')
})

// Robustness, not just one lucky draw: the same bounds hold across a spread
// of other (seedRng, offsetRng) pairs at the shipped defaults, at both
// activity levels — this is what makes "a current, not flies, and thinking
// speeds it up without degrading it" a real regression test rather than a
// fragile snapshot of one specific random draw.
//
// radialShare is intentionally absent from this loop now — this block is
// the NO-LIFT baseline (transportStreams alone, a pure rotation), and its
// old `< 0.05` reading was the discretization-error floor that assertion
// always meant here; reshaping "radialShare" into an excursion band is
// about the LIFT-ENABLED
// twin, checked in its own robustness sweep further down (`streams+lift:
// the guard and the radialShare band both hold...`) — asserting `< 0.05`
// here AND `∈ [0.08, 0.30]` there, on two different runs of the SAME-named
// metric, would read as contradictory to a future reader even though both
// are individually true of what they each measure.
ok('streams: the bounds hold across a spread of other seeds too, at activity 0 and 1', () => {
  for (const [seedRng, offsetRng] of [[24301, 1045991], [7, 13], [42, 4317], [1234, 999], [99, 7001], [555, 8080]]) {
    for (const act of [0, 1]) {
      const m = motionMetrics(transportStreams, LOOKS.streams.p, { wrap: LOOKS.streams.wrap, seedRng, offsetRng, act })
      const tag = `seedRng=${seedRng} offsetRng=${offsetRng} act=${act}`
      if (act === 0) assert.ok(m.meanSpeedPx >= 30 && m.meanSpeedPx <= 60, `${tag} meanSpeedPx=${m.meanSpeedPx.toFixed(2)}`)
      else assert.ok(m.meanSpeedPx >= 90 && m.meanSpeedPx <= 150, `${tag} meanSpeedPx=${m.meanSpeedPx.toFixed(2)}`)
      assert.ok(m.pathOverNet < 1.10, `${tag} pathOverNet=${m.pathOverNet.toFixed(4)}`)
      assert.equal(m.turnsInWindow, 0, `${tag} turnsInWindow=${m.turnsInWindow}`)
      assert.ok(m.coherence3 > 0.95, `${tag} coherence3=${m.coherence3.toFixed(4)}`)
      assert.ok(m.coherence13 > 0.90, `${tag} coherence13=${m.coherence13.toFixed(4)}`)
      assert.ok(m.coherence53 > 0.90, `${tag} coherence53=${m.coherence53.toFixed(4)}`)
    }
  }
})

ok('streams: transportStreams is a pure rotation — every output stays on the unit sphere', () => {
  const homes = fibonacciHomes(200)
  const rng = mulberry32(7)
  const ang = { time: 123.4, orbit: 3.1, drift: 0.5, prec: 0.2, phaseA: 0, phaseB: 0 }
  for (const home of homes) {
    const p = transportStreams(home, rng(), ang, LOOKS.streams.p)
    assert.ok(Math.abs(Math.hypot(...p) - 1) < 1e-9, 'stays on the unit sphere — no state, no drift')
  }
})

ok('streams: advance() only ever accumulates — never recomputes from rate * time (Rule A)', () => {
  // A rate change mid-run must change SPEED from that point on, never the
  // position already reached — the exact bug class 
  // fixed for sessions. The previous version of this test never varied
  // `act` (both trajectories ran act=1 throughout), so it asserted "50
  // steps == 25+25 steps" — true even for a teleporting `orbit = rate(act)
  // * time` implementation, since a constant rate makes recompute and
  // accumulate agree. Proven against a deliberately teleporting advance()
  // built to this exact shape: that impostor passed the old test while
  // jumping 2.46 rad on a single idle->busy frame (see the -
  // fixes report for the before/after of running it here and watching it
  // fail). Real regression case: run idle (act=0), flip to busy (act=1)
  // for exactly one frame, and check that ONE frame's motion is exactly
  // one dt's worth of the busy rate — not the busy rate times the whole
  // elapsed time (which is what a recompute would produce, since the idle
  // time already spent is still baked into `time`).
  const p = LOOKS.streams.p
  const wrap = LOOKS.streams.wrap
  const dt = 0.1
  let a = freshAngles()
  for (let i = 0; i < 25; i++) a = advance(a, p, wrap, 0, dt)   // idle for the first half
  const beforeFlip = a.orbit
  a = advance(a, p, wrap, 1, dt)                                 // flips to busy for exactly one frame
  const afterFlip = a.orbit
  // One dt's worth of pure busy accumulation, computed from a cold start —
  // this is what a single accumulation step at the busy rate looks like,
  // independent of how much idle time came before it.
  const oneBusyStep = advance(freshAngles(), p, wrap, 1, dt).orbit
  const jump = Math.abs(afterFlip - beforeFlip)
  assert.ok(
    Math.abs(jump - oneBusyStep) < 1e-9,
    `single-frame jump at the activity flip must equal exactly one busy-rate step: jump=${jump}, expected=${oneBusyStep} (a teleporting implementation jumps by rate(busy)*2.6s - rate(idle)*2.5s instead)`,
  )
})

// sessionAngle — the ORIGINAL instance of this bug, and the one
// with no executable test at all. It accumulates inline inside MCS.frame
// (swarm.js), a function reachable only through a live WebGL2 boot() — a
// real canvas, a real three.js WebGLRenderer context — which this Node
// harness has no way to fake without a substantial GL-mocking layer, wildly
// disproportionate to this one line of arithmetic (advance() above is
// testable precisely because it was pulled out as a pure exported function;
// sessionAngle never was). So this is a SOURCE pin, not a behavioural test —
// the same limited guarantee this file already gives STALL_MS/
// genuinelyWorking above (pinned against real source, not trusted to stay in
// sync by construction) — and it is honestly weaker than the advance() test:
// it catches `+=` becoming `=` or `dtS` becoming `uTime`, not a subtler
// recompute that keeps that shape. Recorded as a known gap, not a silent one.
ok('sessionAngle (swarm.js MCS.frame) still accumulates against dtS, never uTime — source pin', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  assert.match(
    src,
    /sessionAngle\[b\] \+= \(0\.24 \+ working \* 0\.16\) \* dtS/,
    'sessionAngle must accumulate (+=) against dtS, the previous-frame delta',
  )
  assert.doesNotMatch(
    src,
    /sessionAngle\[b\]\s*=\s*[^+].*uTime/,
    'sessionAngle must never be recomputed from an absolute uTime',
  )
})

// --- Ripples — the reactive layer ------------
// Three layers per: kernel properties (exact, cheap), the steady state
// (unchanged — asserted already, above: every existing check ran with
// `events: []`, which is the ripple layer's off state, and every one still
// passed after this file changed), and the transient.

ok('ripple: rippleEnvelope is 0 at both ends and never exceeds 1', () => {
  assert.equal(rippleEnvelope(0), 0)
  assert.equal(rippleEnvelope(1), 0, 'the recovery guarantee — exactly 0, not approximately')
  let max = 0
  for (let a = 0; a <= 1; a += 0.001) max = Math.max(max, rippleEnvelope(a))
  assert.ok(max <= 1, `max envelope ${max} must not exceed 1`)
  assert.ok(max > 0.9, `sanity: the envelope must actually reach near its ceiling somewhere in [0,1] (max=${max})`)
})

ok('ripple: rippleBend is the identity, bit-for-bit, when every slot is zero', () => {
  const homes = fibonacciHomes(200)
  const A = Array.from({ length: RIPPLE_SLOTS }, () => new Float32Array(4))
  const B = Array.from({ length: RIPPLE_SLOTS }, () => new Float32Array(4))
  for (const h of homes) {
    const bent = rippleBend(h, A, B)
    assert.deepEqual(bent, h, 'an all-zero row set must not perturb n at all')
  }
})

ok('ripple: every ring preset stays under the no-fold bound (bend < NO_FOLD*sigma)', () => {
  for (const [name, P] of Object.entries(RIPPLE)) {
    assert.ok(P.bend < NO_FOLD * P.sigma, `${name}: bend=${P.bend} must be < ${NO_FOLD}*sigma=${NO_FOLD * P.sigma}`)
  }
})

// The pointer's field ripple -- a stationary "spot" preset, plus "wake" rings
// on fast movement -- is gone. Pointer movement is not a ripple trigger; a
// ripple belongs to a triggering event, or to thinking harder, and to nothing
// more frequent than that. An ordinary tool-call pulse keeps its existing
// subtle shockwave without rippling the field, so RIPPLE holds one preset for
// the heartbeat and one for `ask` -- the orchestrator swell, fired when
// Syzygy takes a message, larger than the heartbeat's and slower to cross.
// That is a triggering event rather than a continuous one: a person pressing
// Enter is the rarest trigger on the board. The guard below keeps
// its teeth by naming what must NEVER come back — the pointer-driven
// presets — rather than freezing the count at one.
ok('ripple: only the heartbeat and the ask swell — no pointer spot/wake, no tool-call field ripple', () => {
  assert.deepEqual(Object.keys(RIPPLE), ['heart', 'ask'])
  for (const banned of ['spot', 'wake']) {
    assert.ok(!(banned in RIPPLE), `the pointer-driven '${banned}' preset came back`)
  }
})

ok('ripple: every preset\'s kick stays at or under 0.8 (no seam at the front)', () => {
  for (const [name, P] of Object.entries(RIPPLE)) {
    assert.ok(P.kick <= 0.8, `${name}: kick=${P.kick} must be <= 0.8`)
  }
})

ok('ripple: the wavelet peaks at exactly 1.0 at |u|=1 and its max slope is sqrt(e) — the no-fold bound\'s own derivation', () => {
  let maxG = 0, maxSlope = 0
  const du = 0.0001
  for (let u = -4; u <= 4; u += du) {
    const g = Math.exp(-0.5 * u * u)
    const bend = u * g * 1.6487213
    maxG = Math.max(maxG, Math.abs(bend))
    const u2 = u + du
    const bend2 = u2 * Math.exp(-0.5 * u2 * u2) * 1.6487213
    maxSlope = Math.max(maxSlope, Math.abs((bend2 - bend) / du))
  }
  assert.ok(Math.abs(maxG - 1) < 1e-3, `wavelet peak ${maxG} must be ~1.0 at |u|=1`)
  assert.ok(Math.abs(maxSlope - Math.sqrt(Math.E)) < 1e-3, `max slope ${maxSlope} must be ~sqrt(e)=${Math.sqrt(Math.E)}`)
})

ok('ripple: heartbeat is refractory for 5.0s (longer than the ring\'s own 4.0s life — never overlaps itself), and returns whether it actually fired', () => {
  const R = makeRipples()
  assert.equal(HEART_REFRACTORY_S, 5.0, 'sanity: the refractory is strictly longer than RIPPLE.heart.life (4.0s) — no ring is ever cut off by the next')
  assert.ok(HEART_REFRACTORY_S > RIPPLE.heart.life, 'the refractory must exceed the ring\'s own life')
  assert.equal(heartbeat(R, 0), true, 'first call always fires')
  assert.equal(heartbeat(R, 1), false, 'inside the refractory window')
  assert.equal(heartbeat(R, 4.9), false, 'still inside it')
  assert.equal(heartbeat(R, 5.1), true, 'past the refractory window')
})

// The rule: scale strength rather than rate, and cap the rate regardless of
// session count. Scaling the rate makes ripples fire far too often at even
// three concurrent sessions.
// heartbeat()'s refractory is a plain module constant now — nothing
// in this file lets a caller shorten it. `strength` (the third argument) is
// the ONLY knob concurrency is allowed to touch.
ok('ripple: heartbeat\'s refractory cannot be shortened by anything — only strength is a parameter', () => {
  const R = makeRipples()
  heartbeat(R, 0, 50)          // a huge strength...
  assert.equal(heartbeat(R, 0.5, 50), false, '...still cannot buy an earlier re-fire')
  assert.equal(heartbeat(R, 5.1, 1), true, 'only real elapsed time (>= HEART_REFRACTORY_S) does')
})

// the concurrency multiplier itself. sessionRippleMultiplier must
// be monotonically increasing (more sessions -> more/stronger ripples, never
// less) and never flatten: it must not saturate so that three sessions and
// eight look identical, so no two counts in a wide sweep may produce the same
// value.
ok('sessionRippleMultiplier is exactly 1 + RIPPLE_MULT_SCALE*log2(1+count) — a derived shape, not a lookup table', () => {
  for (const c of [0, 1, 2, 4, 8, 12, 30]) {
    const expected = 1 + RIPPLE_MULT_SCALE * Math.log2(1 + c)
    assert.equal(sessionRippleMultiplier(c), expected, `count=${c}`)
  }
  assert.equal(sessionRippleMultiplier(-5), 1, 'a negative count (should never happen) clamps to the zero-count baseline, not NaN or negative')
})

ok('sessionRippleMultiplier: 1 at zero, strictly increasing, never saturates across a wide sweep', () => {
  assert.equal(sessionRippleMultiplier(0), 1, 'no genuinely-working sessions -> no multiplier effect')
  let prev = sessionRippleMultiplier(0)
  const seen = new Set([prev])
  for (let c = 1; c <= 64; c++) {
    const m = sessionRippleMultiplier(c)
    assert.ok(m > prev, `sessionRippleMultiplier(${c})=${m} must exceed sessionRippleMultiplier(${c - 1})=${prev}`)
    assert.ok(!seen.has(m), `sessionRippleMultiplier(${c})=${m} must not repeat an earlier value — no saturation plateau`)
    seen.add(m); prev = m
  }
})
ok('sessionRippleMultiplier: four sessions reads obviously stronger than one; three and eight are clearly distinct', () => {
  const m1 = sessionRippleMultiplier(1), m3 = sessionRippleMultiplier(3)
  const m4 = sessionRippleMultiplier(4), m8 = sessionRippleMultiplier(8), m12 = sessionRippleMultiplier(12)
  assert.ok(m4 / m1 > 1.2, `four-vs-one ratio ${(m4 / m1).toFixed(3)} must read as an obvious jump`)
  assert.ok((m8 - m3) / m3 > 0.1, `three-vs-eight must differ by more than 10%: got ${(((m8 - m3) / m3) * 100).toFixed(1)}%`)
  assert.ok(m12 > m8, 'twelve must still read stronger than eight — the top of this task\'s own verified range')
  // RIPPLE_MULT_SCALE is chosen (swarm-math.js) so mult(12) sits just under
  // swarm.js's own INTENSITY_MULT_CAP (2.0) — pin the shape, not the exact
  // constant, so a deliberate retune of the scale does not spuriously fail
  // this test as long as it keeps the same property.
  assert.ok(m12 < 2.0, `mult(12)=${m12} should still sit under the intensity ceiling swarm.js caps at, so intensity is still visibly climbing through the whole tested range`)
})

ok('swarm.js sources HEART_REFRACTORY_S from swarm-math.js and never divides it by anything', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  // The FIRST implementation of this task divided HEART_REFRACTORY_S by a
  // live multiplier to shorten it — exactly the rate multiplier that had to be
  // inverted into a strength one. Pin that it is gone: no division of this
  // constant anywhere in swarm.js.
  assert.doesNotMatch(src, /HEART_REFRACTORY_S\s*\//, 'HEART_REFRACTORY_S must never be divided — the refractory is a fixed floor, not a function of concurrency')
})

ok('ripple: a fired heartbeat spawns exactly one ring — no second beat', () => {
  const R = makeRipples()
  heartbeat(R, 0)
  const births = R.rings.filter((r) => r.preset === 'heart').map((r) => r.born)
  assert.deepEqual(births, [0], 'a single slow swell, not a two-beat snap')
})

ok('ripple: every slot is exactly zero once its ring has fully expired (life + epsilon)', () => {
  const R = makeRipples()
  heartbeat(R, 0)
  const A = Array.from({ length: RIPPLE_SLOTS }, () => new Float32Array(4))
  const B = Array.from({ length: RIPPLE_SLOTS }, () => new Float32Array(4))
  rippleRows(R, RIPPLE.heart.life + 0.01, (v) => v, A, B)   // past the ring's own expiry
  assert.equal(R.rings.length, 0, 'expired rings are dropped')
  for (let i = 0; i < RIPPLE_SLOTS; i++) {
    assert.deepEqual(Array.from(A[i]), [0, 0, 0, 0], `row ${i} of uRipA must be zero`)
    assert.deepEqual(Array.from(B[i]), [0, 0, 0, 0], `row ${i} of uRipB must be zero`)
  }
})

ok('ripple: RIPPLE.heart\'s front takes seconds to cross the sphere, not a fifth of a second — the timescale-mismatch fix', () => {
  // Grains drift at ~45px/s at the busy rate (~1.1 rad/s at 105px/rad);
  // idle is ~0.43 rad/s. speed=0.5 rad/s sits in that same order of
  // magnitude, related to the flow it is passing through rather than ten
  // times it — where a 2.8 rad/s front would be roughly 6x the busy rate
  // and life=1.4s made the whole event a fifth of that already-fast pace.
  assert.ok(RIPPLE.heart.speed <= 1.0, `front speed ${RIPPLE.heart.speed} rad/s must be comparable to the transport's own rate, not an order of magnitude faster`)
  assert.ok(RIPPLE.heart.life >= 3.0, `life ${RIPPLE.heart.life}s must be seconds, not a fifth of a second`)
  assert.ok(RIPPLE.heart.sigma >= 0.4, `sigma ${RIPPLE.heart.sigma} rad must be a broad, soft front, not a thin line`)
})

// --- Ripples — the transient: does a ripple actually cost what a ripple
// should cost, and does it recover to equality? A fixed
// heartbeat fired at `at=1.0` into an otherwise-identical run, `events: []`,
// at the SAME seed/offset/activity — `during` = [at, at + RIPPLE.heart.life]
// (the ring's own life, now 4.0s, not 1.4s), `after` = [AFTER_START,
// RIPPLE_SECONDS] (the settled field, from the instant the ring has
// actually expired). The captured-grain proxy is `transport + rippleBend`
// capture itself needs `snoised` and is not twinned, so this is a
// lower bound on the disturbance, per the stated testing limitation.
//
// Starting `after` at the ring's real expiry (RIPPLE_AT + RIPPLE.heart.life,
// exactly) makes the two runs bit-for-bit identical from the first sample
// on — `advance()` never depends on ripple state, and once every row is
// zero in both runs, `rippleBend` takes the identical identity fast path in
// each — so the recovery check asserts real equality, not a relaxation of
// it (carried forward unchanged in spirit
// now that there is only one ring instead of two).
//
// `pathOverNet` is asserted at activity 0 only. At activity 1 the window
// (real seconds, tied to the ripple's own life — not activity-scaled, since
// the ring's duration is fixed regardless of how fast the swarm is
// orbiting) sweeps enough angle at the busy orbit rate that grains routinely
// leave the 40deg centre cone before both window endpoints are visible —
// confirmed by checking the NO-EVENT baseline: `after.pathOverNet` is `NaN`
// there too, with no ripple involved at all. Coherence — the metric the
// design's own measurement actually turns on — has no such gap at either
// activity level.
const RIPPLE_AT = 1.0
const RIPPLE_SECONDS = 7.0
const RIPPLE_STEP = 0.02
const AFTER_START = RIPPLE_AT + RIPPLE.heart.life   // 1.0 + 4.0 = 5.0 — the ring's own expiry, exactly
const RIPPLE_WINDOWS = { during: [RIPPLE_AT, RIPPLE_AT + RIPPLE.heart.life], after: [AFTER_START, RIPPLE_SECONDS] }
const RIPPLE_EVENTS = [{ at: RIPPLE_AT, kind: 'heartbeat' }]

const heartIdleEv = motionMetrics(transportStreams, LOOKS.streams.p, {
  wrap: LOOKS.streams.wrap, seedRng: 1, offsetRng: 1, act: 0, seconds: RIPPLE_SECONDS, step: RIPPLE_STEP, events: RIPPLE_EVENTS, windows: RIPPLE_WINDOWS,
})
const heartIdleNo = motionMetrics(transportStreams, LOOKS.streams.p, {
  wrap: LOOKS.streams.wrap, seedRng: 1, offsetRng: 1, act: 0, seconds: RIPPLE_SECONDS, step: RIPPLE_STEP, events: [], windows: RIPPLE_WINDOWS,
})
const heartBusyEv = motionMetrics(transportStreams, LOOKS.streams.p, {
  wrap: LOOKS.streams.wrap, seedRng: 1, offsetRng: 1, act: 1, seconds: RIPPLE_SECONDS, step: RIPPLE_STEP, events: RIPPLE_EVENTS, windows: RIPPLE_WINDOWS,
})
const heartBusyNo = motionMetrics(transportStreams, LOOKS.streams.p, {
  wrap: LOOKS.streams.wrap, seedRng: 1, offsetRng: 1, act: 1, seconds: RIPPLE_SECONDS, step: RIPPLE_STEP, events: [], windows: RIPPLE_WINDOWS,
})

// Measured (seedRng=1, offsetRng=1): idle during coherence3=0.985,
// coherence13=0.875, pathOverNet ratio=1.46; busy during coherence3=0.988,
// coherence13=0.962. coherence13 is the tight one of the pair, and it sits
// well clear of the 0.80 floor the assertion below pins.
ok('ripple, during a heartbeat, idle: coherence3 >= 0.90, coherence13 >= 0.80 (the tight one)', () => {
  assert.ok(heartIdleEv.during.coherence3 >= 0.90, `coherence3=${heartIdleEv.during.coherence3.toFixed(4)}`)
  assert.ok(heartIdleEv.during.coherence13 >= 0.80, `coherence13=${heartIdleEv.during.coherence13.toFixed(4)}`)
})
ok('ripple, during a heartbeat, busy: coherence3 >= 0.90, coherence13 >= 0.80', () => {
  assert.ok(heartBusyEv.during.coherence3 >= 0.90, `coherence3=${heartBusyEv.during.coherence3.toFixed(4)}`)
  assert.ok(heartBusyEv.during.coherence13 >= 0.80, `coherence13=${heartBusyEv.during.coherence13.toFixed(4)}`)
})
// Widening `during` to the ring's own life (4.0s, up from 1.4s — the
// timescale-mismatch fix) means it now sweeps enough angle, even at the
// IDLE orbit rate, that grains routinely leave the 40deg centre cone before
// both window endpoints are visible: `during.pathOverNet` is NaN in BOTH
// the with-ripple and no-event runs here (confirmed: `heartIdleNo.during.
// pathOverNet` is NaN too, with no ripple involved at all) — the exact same
// real-geometry NaN mode `after.pathOverNet` already had at the busy rate
// (see the doc comment above `RIPPLE_AT`). Assert the ratio only when both
// sides are finite, so this test still catches a REAL "ripple costs path
// and runs away" regression wherever the window happens to admit one,
// without failing on a geometry artifact neither run can avoid.
ok('ripple, during a heartbeat, idle: pathOverNet stays bounded relative to the no-event run where both are finite (a ripple costs path, but does not run away)', () => {
  if (Number.isFinite(heartIdleEv.during.pathOverNet) && Number.isFinite(heartIdleNo.during.pathOverNet)) {
    const ratio = heartIdleEv.during.pathOverNet / heartIdleNo.during.pathOverNet
    assert.ok(ratio <= 2.0, `pathOverNet ratio ${ratio.toFixed(3)} must stay <= 2.0x the no-event run over the same window`)
  } else {
    assert.ok(!Number.isFinite(heartIdleNo.during.pathOverNet), 'if the with-ripple run is non-finite, the no-event run over the SAME window must be too — proving this is a window/cone artifact, not something the ripple itself caused')
  }
})
ok('ripple: no turns bound during the passage — a ripple reverses every grain by construction; turns discriminates nothing here', () => {
  assert.ok(heartIdleEv.during.turnsInWindow > 0, 'sanity: the ripple really is producing coherent reversals, not doing nothing')
  assert.ok(heartBusyEv.during.turnsInWindow > 0, 'sanity: same at the busy rate')
})

for (const [label, ev, no] of [['idle', heartIdleEv, heartIdleNo], ['busy', heartBusyEv, heartBusyNo]]) {
  ok(`ripple, after a heartbeat (${label}): the steady bounds hold and turnsInWindow == 0`, () => {
    assert.equal(ev.after.turnsInWindow, 0, `turnsInWindow=${ev.after.turnsInWindow}`)
    assert.ok(ev.after.coherence3 > 0.95, `coherence3=${ev.after.coherence3.toFixed(4)}`)
    assert.ok(ev.after.coherence13 > 0.90, `coherence13=${ev.after.coherence13.toFixed(4)}`)
    assert.ok(ev.after.coherence53 > 0.90, `coherence53=${ev.after.coherence53.toFixed(4)}`)
    assert.ok(ev.after.radialShare < 0.05, `radialShare=${ev.after.radialShare.toFixed(5)}`)
    if (label === 'idle') assert.ok(ev.after.pathOverNet < 1.10, `pathOverNet=${ev.after.pathOverNet.toFixed(4)}`)
  })

  ok(`ripple: RECOVERY — after a heartbeat (${label}), every metric equals the no-event run over the same window EXACTLY (the envelope's own zero, not a relaxation)`, () => {
    // Real equality, not a tolerance — see AFTER_START's own comment above
    // for why this is exact rather than approximate: `after` starts at the
    // ring's actual expiry, so both runs are bit-for-bit identical over the
    // whole window (advance() never depends on ripple state, and every row
    // is zero in both runs from here on).
    for (const key of ['meanSpeedPx', 'coherence3', 'coherence13', 'coherence53', 'radialShare']) {
      assert.equal(ev.after[key], no.after[key], `${key}: with-ripple=${ev.after[key]} no-event=${no.after[key]}`)
    }
    // pathOverNet only when finite on both sides — see the doc comment
    // above on why it goes NaN at the busy rate even with no ripple at all.
    if (Number.isFinite(ev.after.pathOverNet) && Number.isFinite(no.after.pathOverNet)) {
      assert.equal(ev.after.pathOverNet, no.after.pathOverNet, `pathOverNet: with-ripple=${ev.after.pathOverNet} no-event=${no.after.pathOverNet}`)
    }
  })
}

// Robustness — the same shape holds across other seeds too, not one lucky
// draw. A smaller sweep than the streams motion checks' own seven-pair one
// (this run is far more expensive per pair — four motionMetrics calls, not
// one), but still real, independent evidence.
ok('ripple: the during/after bounds hold across a spread of other seeds too, at activity 0 and 1', () => {
  for (const [seedRng, offsetRng] of [[24301, 1045991], [1234, 999], [555, 8080]]) {
    for (const act of [0, 1]) {
      const tag = `seedRng=${seedRng} offsetRng=${offsetRng} act=${act}`
      const ev = motionMetrics(transportStreams, LOOKS.streams.p, { wrap: LOOKS.streams.wrap, seedRng, offsetRng, act, seconds: RIPPLE_SECONDS, step: RIPPLE_STEP, events: RIPPLE_EVENTS, windows: RIPPLE_WINDOWS })
      const no = motionMetrics(transportStreams, LOOKS.streams.p, { wrap: LOOKS.streams.wrap, seedRng, offsetRng, act, seconds: RIPPLE_SECONDS, step: RIPPLE_STEP, events: [], windows: RIPPLE_WINDOWS })
      assert.ok(ev.during.coherence3 >= 0.90, `${tag} during coherence3=${ev.during.coherence3.toFixed(4)}`)
      assert.ok(ev.during.coherence13 >= 0.80, `${tag} during coherence13=${ev.during.coherence13.toFixed(4)}`)
      assert.equal(ev.after.turnsInWindow, 0, `${tag} after turnsInWindow=${ev.after.turnsInWindow}`)
      assert.ok(ev.after.coherence3 > 0.95, `${tag} after coherence3=${ev.after.coherence3.toFixed(4)}`)
      assert.ok(ev.after.coherence13 > 0.90, `${tag} after coherence13=${ev.after.coherence13.toFixed(4)}`)
      for (const key of ['meanSpeedPx', 'coherence3', 'coherence13', 'coherence53', 'radialShare']) {
        assert.equal(ev.after[key], no.after[key], `${tag} after.${key}: with-ripple=${ev.after[key]} no-event=${no.after[key]}`)
      }
    }
  }
})

// --- Sessions in streams: a claimed channel is distinguishable ------------
ok('session: a working session\'s channel stands above each neighbouring channel — margin >= 0.25 x out on >= 70% of instants, mean margin >= 0.70 x out, above at all >= 88% — at every band', () => {
  for (const s0 of SESSION_BANDS) for (const s1 of [s0 - CHANNEL_SPACING, s0 + CHANNEL_SPACING]) {
    let frac = 0, above = 0, sum = 0
    for (const { phi, ph } of LIFT_FIELD_SAMPLES) {
      const m = (liftHeld(liftField(s0, phi, ph).g, 1) - liftField(s1, phi, ph).lift) / LIFT.out
      if (m >= 0.25) frac++
      if (m > 0) above++
      sum += m
    }
    const n = LIFT_FIELD_SAMPLES.length
    assert.ok(frac / n >= 0.70, `band ${s0.toFixed(2)} vs ${s1.toFixed(2)}: frac=${(frac / n).toFixed(3)}`)
    assert.ok(sum / n >= 0.70, `band ${s0.toFixed(2)} vs ${s1.toFixed(2)}: mean margin=${(sum / n).toFixed(3)} x out`)
    assert.ok(above / n >= 0.88, `band ${s0.toFixed(2)} vs ${s1.toFixed(2)}: above=${(above / n).toFixed(3)}`)
  }
})

ok('session controls: an ordinary channel (identity remap) and a never-sinks-but-not-held remap (floor 0) both FAIL the margin test — it discriminates a HELD channel, not just a lifted one', () => {
  const run = (remap) => {
    let frac = 0, sum = 0, n = 0
    for (const s0 of SESSION_BANDS) for (const s1 of [s0 - CHANNEL_SPACING, s0 + CHANNEL_SPACING]) for (const { phi, ph } of LIFT_FIELD_SAMPLES) {
      const A = liftField(s0, phi, ph)
      const m = (remap(A) - liftField(s1, phi, ph).lift) / LIFT.out
      if (m >= 0.25) frac++
      sum += m; n++
    }
    return { frac: frac / n, mean: sum / n }
  }
  const identity = run((A) => A.lift)
  assert.ok(identity.frac < 0.55, `identity control frac=${identity.frac.toFixed(3)}, expected ~0.40`)
  assert.ok(Math.abs(identity.mean) < 0.20, `identity control mean margin=${identity.mean.toFixed(3)}, expected ~0`)
  const floor0 = run((A) => LIFT.out * (0.5 + 0.5 * A.g))
  assert.ok(floor0.frac < 0.70, `floor-0 control frac=${floor0.frac.toFixed(3)}, expected ~0.63 — the hold is what passes the 0.70 bound, not merely never sinking`)
})

ok('session: a claimed channel never sinks and never exceeds the shared ceiling — liftHeld(-1) = floor x out > 0, liftHeld(+1) = LIFT.out exactly; SESSION.relief inside MAX_RELIEF', () => {
  for (const work of [0, 1]) {
    const f = SESSION.floorIdle + (SESSION.floorWork - SESSION.floorIdle) * work
    assert.ok(f > 0 && Math.abs(liftHeld(-1, work) - f * LIFT.out) < 1e-12, `floor at work=${work}`)
    assert.ok(Math.abs(liftHeld(1, work) - LIFT.out) < 1e-12, 'peak = LIFT.out — the ceiling assertion covers it unchanged')
  }
  assert.ok(SESSION.floorWork > SESSION.floorIdle && SESSION.floorWork <= 0.8, 'held higher while working; at least 20% of the envelope left to cycle in')
  assert.ok(SESSION.relief <= MAX_RELIEF, 'relief inside the asserted worst case')
  // Still alive: liftHeld crosses its own midpoint exactly when g changes sign,
  // so the "every band changes sign within 25s" assertion covers it.
  const mid = (w) => { const f = SESSION.floorIdle + (SESSION.floorWork - SESSION.floorIdle) * w; return LIFT.out * (f + (1 - f) * 0.5) }
  for (const g of [-0.7, -0.1, 0.1, 0.7]) assert.equal(Math.sign(liftHeld(g, 1) - mid(1)), Math.sign(g))
})

ok('session: a working session\'s channel core never enters the sink fade — 1 + floorWork x out - busy core thickness > uSinkFade + ramp (source-pinned ratios)', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  assert.match(src, /uThickness\.value = 0\.10 \* \(1 \+ 0\.6 \* actS\)/, 'busy thickness is 1.6x — source pin')
  assert.match(src, /uThickness \* \(aSeed - 0\.5\) \* \(0\.4 \+ 0\.6 \* lane\)/, 'the core lane carries 0.4 of it — source pin')
  const radCore = 1 + SESSION.floorWork * LIFT.out - SHELL_THICKNESS * 1.6 * 0.5 * 0.4
  assert.ok(radCore > LIFT.sinkFade + 0.08, `${radCore.toFixed(4)} must clear the ramp top ${(LIFT.sinkFade + 0.08).toFixed(3)}`)
})

ok('session bands: derived from CHANNEL_SPACING, one channel apart, nine >= MAX_SESSIONS, off the poles, the first five two spacings apart', () => {
  assert.ok(SESSION_BANDS.length >= MAX_SESSIONS, 'every clamped session can hold a band')
  const sorted = [...SESSION_BANDS].sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++) assert.ok(Math.abs(sorted[i] - sorted[i - 1] - CHANNEL_SPACING) < 1e-9, 'one channel apart')
  assert.ok(Math.max(...SESSION_BANDS.map(Math.abs)) <= 0.8, 'off the poles, where phi degenerates')
  assert.equal(SESSION_BANDS[0], 0, 'the first session takes the equator — a great circle, never mostly hidden')
  const first5 = SESSION_BANDS.slice(0, 5)
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) assert.ok(Math.abs(first5[i] - first5[j]) >= 2 * CHANNEL_SPACING - 1e-9, 'an unclaimed neighbour on both sides')
})

const isW = (s) => !!s.working
const stepClaims = (C, live, frames, dt = 1 / 60) => { for (let i = 0; i < frames; i++) advanceClaims(C, live, dt, isW); return C }
const sess = (id, working = false) => ({ id, working })

ok('claims: a session keeps its band while others arrive, leave and reorder — stable by id, not by list position', () => {
  const C = stepClaims(makeClaims(), [sess('a'), sess('b'), sess('c')], 120)
  assert.deepEqual(C.owner.slice(0, 3), ['a', 'b', 'c'], 'claim order = SESSION_BANDS order')
  stepClaims(C, [sess('c'), sess('a'), sess('d')], 120)   // b leaves, d arrives, list reordered
  assert.equal(C.owner[0], 'a'); assert.equal(C.owner[2], 'c')
  assert.equal(C.owner[3], 'd', 'd took the next FREE band, not b\'s still-fading one')
})
ok('claims: with clampSessions in front, eight are represented, the ninth is not until one leaves — then it claims the free band at once', () => {
  const live = Array.from({ length: 9 }, (_, i) => sess('s' + i))
  const C = stepClaims(makeClaims(), clampSessions(live), 60)
  const owned = C.owner.filter((o) => o !== null)
  assert.equal(new Set(owned).size, owned.length, 'no two sessions share a band')
  assert.ok(owned.length === 8 && !C.owner.includes('s8') && C.owner[8] === null)
  stepClaims(C, clampSessions(live.filter((s) => s.id !== 's0')), 1)
  assert.equal(C.owner[8], 's8', 'the ninth band was free; no wait for s0\'s fade')
  stepClaims(C, clampSessions(live.filter((s) => s.id !== 's0')), 600)
  assert.equal(C.owner[0], null, 's0\'s band freed after its fade')
})
ok('claims: a band is not reassigned until its claim has decayed to exactly 0; a returning owner resumes it mid-fade', () => {
  const C = stepClaims(makeClaims(), [sess('a')], 120)
  stepClaims(C, [], 10)
  assert.ok(C.owner[0] === 'a' && C.claim[0] > 0 && C.claim[0] < 1, 'fading, still owned')
  stepClaims(C, [sess('b')], 1);            assert.equal(C.owner[1], 'b', 'b took band 1, not the fading band 0')
  stepClaims(C, [sess('b'), sess('a')], 1); assert.equal(C.owner[0], 'a', 'a resumed band 0')
  stepClaims(C, [sess('b')], 600);          assert.ok(C.owner[0] === null && C.claim[0] === 0, 'fully faded => free')
})
ok('claims: easing never snaps — per-frame change <= dt/tau; heat reaches 0.9 in under 0.8s (a swell), claim fades out in 1.5-4.5s', () => {
  let C = makeClaims(), prev = 0
  for (let i = 0; i < 120; i++) { advanceClaims(C, [sess('a', true)], 1 / 60, isW); assert.ok(C.claim[0] - prev <= (1 / 60) / SESSION.tauIn + 1e-9); prev = C.claim[0] }
  C = makeClaims(); let t = 0
  while (C.heat[0] < 0.9) { advanceClaims(C, [sess('a', true)], 1 / 60, isW); t += 1 / 60 }
  assert.ok(t < 0.8, `heat 0->0.9 in ${t.toFixed(2)}s`)
  t = 0
  while (C.claim[0] > 0) { advanceClaims(C, [], 1 / 60, isW); t += 1 / 60 }
  assert.ok(t > 1.5 && t < 4.5, `claim 1->0 in ${t.toFixed(2)}s`)
})

ok('session: streams declares NO session attributes — membership is a uniform of the field; CHUNK_SESSION is composed after CHUNK_LIFT; claims advance every frame', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  const prelude = src.slice(src.indexOf('const CHUNK_PRELUDE = `'), src.indexOf('const CHUNK_NOISE = `'))
  assert.doesNotMatch(prelude, /aRole|aSession/, 'a declared-and-unbound attribute warns every frame')
  // Bounded by the NEXT declaration, not by STREAMS_UNIFORMS_MAIN:
  // CHUNK_SESSION is declared after that literal, so slicing to it runs
  // backwards and yields '' every time. Where the chunk sits in the FILE is
  // irrelevant anyway; the composition order that matters is the STREAMS_VERT
  // array, pinned two assertions below.
  const session = src.slice(src.indexOf('const CHUNK_SESSION = `'), src.indexOf('const STREAMS_VERT = ['))
  assert.doesNotMatch(session, /\bin (float|vec[234]) a[A-Z]/, 'CHUNK_SESSION declares no attributes')
  assert.match(session, /const int SESS = \$\{SESSION_BANDS\.length\};/, 'the band count is interpolated, not hand-typed')
  const geom = src.slice(src.indexOf('const buildStreamsGeometry ='), src.indexOf('const buildStreamsMaterial ='))
  assert.deepEqual([...geom.matchAll(/setAttribute\('(\w+)'/g)].map((m) => m[1]).sort(), ['aHome', 'aSeed', 'aSize', 'position'])
  assert.match(src, /STREAMS_VERT = \[CHUNK_PRELUDE, CHUNK_NOISE, CHUNK_CAPTURE, CHUNK_RIPPLE, CHUNK_LIFT, CHUNK_SESSION, STREAMS_UNIFORMS_MAIN\]/)
  // `dtS` is the real variable in MCS.frame, not `dt`. Pinned to what the
  // code passes rather than to the plausible-looking name, and left open at
  // the arity, since the exact call shape is pinned by a stronger assertion
  // below.
  assert.match(src, /advanceClaims\(claims, liveSessions, dtS/, 'from the clamped live list, every frame')
})

const withSessions = (act, count) => motionMetrics(transportStreams, LOOKS.streams.p, {
  wrap: LOOKS.streams.wrap, seedRng: 1, offsetRng: 1, act, liftPh: freshLift(),
  sessions: SESSION_BANDS.slice(0, count).map((s) => ({ s, heat: 1 })),
})
ok('streams+lift+sessions: with one and four working sessions the seven guards AND the radialShare band hold; with eight the guards and the upper edge hold — the lower edge is not asserted at full occupancy, because holding channels up IS removing their excursion', () => {
  for (const count of [1, 4, 8]) for (const [label, act, lo, hi] of [['idle', 0, 30, 60], ['busy', 1, 90, 150]]) {
    const m = withSessions(act, count), tag = `${count} sessions ${label}`
    assert.ok(m.meanSpeedPx >= lo && m.meanSpeedPx <= hi, `${tag} meanSpeedPx=${m.meanSpeedPx.toFixed(2)}`)
    assert.ok(m.pathOverNet < 1.10, `${tag} pathOverNet=${m.pathOverNet.toFixed(4)}`)
    assert.equal(m.turnsInWindow, 0, `${tag} turnsInWindow=${m.turnsInWindow}`)
    assert.ok(m.coherence3 > 0.95 && m.coherence13 > 0.90 && m.coherence53 > 0.90, `${tag} coherence`)
    assert.ok(m.radialShare <= 0.30, `${tag} radialShare=${m.radialShare.toFixed(4)} upper edge`)
    if (count < 8) assert.ok(m.radialShare >= 0.08, `${tag} radialShare=${m.radialShare.toFixed(4)} — the excursion is still present`)
  }
})

// --- orb-presence: colour, state, burn ----
const hueOf = (lab) => ((Math.atan2(lab[2], lab[1]) * 180 / Math.PI) + 360) % 360
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d }
// app.css's hsl() tokens, resolved the way the browser does — for the default theme accent only.
const hsl2hex = (h, s, l) => {
  s /= 100; l /= 100
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return '#' + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
}

ok('oklab: white is L=1 with no chroma, black is 0, every token colour round-trips within 1/255, distance is symmetric', () => {
  const w = hexToOklab('#ffffff')
  assert.ok(Math.abs(w[0] - 1) < 1e-3 && Math.abs(w[1]) < 1e-3 && Math.abs(w[2]) < 1e-3, `white -> ${w}`)
  for (const v of hexToOklab('#000000')) assert.ok(Math.abs(v) < 1e-9)
  for (const hex of [...Object.values(STATE_ACCENT), ...Object.values(MOODS).flatMap((m) => [m.a, m.b])]) {
    const back = oklabToHex(hexToOklab(hex)), n = parseInt(hex.slice(1), 16)
    for (const sh of [16, 8, 0]) assert.ok(Math.abs(((back >> sh) & 255) - ((n >> sh) & 255)) <= 1, `${hex} channel @${sh}`)
  }
  const x = hexToOklab('#e0973c'), y = hexToOklab('#a8e8ff')
  assert.equal(oklabDist(x, y), oklabDist(y, x))
})

ok('mood ramp: within dE 0.005 of a new target in <= 2.4s at 60fps, and a mid-fade retarget moves at most dist x (1 - e^(-dt/tau)) per frame — no snap is possible', () => {
  const target = { a: '#ff5670', b: '#45141f' }
  const R = makeMoodRamp('idle'); let t = 0
  while (oklabDist(R.a, hexToOklab(target.a)) > 0.005) { advanceMoodRamp(R, target, 1 / 60); t += 1 / 60; assert.ok(t < 2.4, `took ${t.toFixed(2)}s`) }
  assert.ok(t > 1.0, `a fade, not a cut: ${t.toFixed(2)}s`)
  const ramp2 = makeMoodRamp('idle')
  for (let i = 0; i < 20; i++) advanceMoodRamp(ramp2, target, 1 / 60)
  const before = ramp2.a.slice(), t2 = { a: '#a883e6', b: '#2b1c40' }
  const dist = oklabDist(before, hexToOklab(t2.a))
  advanceMoodRamp(ramp2, t2, 1 / 60)
  assert.ok(oklabDist(before, ramp2.a) <= dist * (1 - Math.exp(-(1 / 60) / MOOD_RAMP.tau)) + 1e-12, 'retarget is continuous')
})

ok('session state: waiting > error > working > idle; genuinelyWorking by default; needsHuman mirrors app.js\'s needsOf (source pin + behaviour)', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/app.js'), 'utf8')
  assert.match(src, /const needsOf = \(s\) => \(s && s\.waiting \? \(s\.waitingFor \|\| 'waiting for input'\) : \(\(s && s\.needs\) \|\| ''\)\)/, 'app.js\'s needsOf')
  for (const s of [null, {}, { waiting: true }, { needs: '' }, { needs: 'x' }, { waiting: false, needs: 'x' }]) assert.equal(needsHuman(s), !!(s && (s.waiting || s.needs)))
  const isW = (s) => !!s.working, now = Date.now()
  assert.equal(sessionState({ id: 'a', working: true, waiting: true }, 5, isW), 'waiting')
  assert.equal(sessionState({ id: 'a', working: true, needs: 'yes?' }, 0, isW), 'waiting')
  assert.equal(sessionState({ id: 'a', working: true }, ERROR_COUNT, isW), 'error')
  assert.equal(sessionState({ id: 'a', working: true }, ERROR_COUNT - 1, isW), 'working')
  assert.equal(sessionState({ id: 'a', working: false }, 0, isW), 'idle')
  assert.equal(sessionState(null), 'idle')
  assert.equal(sessionState({ id: 'a', working: true, progressAt: now - STALL_MS - 1 }), 'idle', 'stalled is not working')
  assert.equal(ERROR_WINDOW, 14, 'the board\'s own window — recomputeMood slices 14')
  assert.equal(ERROR_COUNT, 3, 'the board\'s own count')
})

ok('recentErrorsById: counts a session\'s errors among ITS last 14 events only; no sessionId, no count', () => {
  const ev = []
  for (let i = 0; i < 20; i++) ev.push({ sessionId: 'a', status: i < 4 ? 'error' : 'ok' })   // 4 old errors, then 16 ok
  for (let i = 0; i < 5; i++) ev.push({ sessionId: 'b', status: 'error' })
  ev.push({ status: 'error' })
  const m = recentErrorsById(ev)
  assert.equal(m.get('a') ?? 0, 0, 'a\'s errors fell out of its own last 14')
  assert.equal(m.get('b'), 5)
  const ev2 = [...Array(3).fill({ sessionId: 'c', status: 'error' }), ...Array(11).fill({ sessionId: 'c', status: 'ok' })]
  assert.equal(recentErrorsById(ev2).get('c'), 3, 'the 14th-from-last still counts')
  assert.equal(recentErrorsById([...ev2, { sessionId: 'c', status: 'ok' }]).get('c'), 2, 'the 15th-from-last does not')
})

ok('state accents: the semantic three ARE app.css\'s tokens; pairwise distinguishable (hue >= 25deg or dL >= 0.07); each >= 30deg from the default theme accent; idle is the accent\'s own family, lighter by >= 0.10', () => {
  const css = readFileSync(join(ROOT, 'syzygy/bridge/public/app.css'), 'utf8')
  assert.match(css, /--amber:\s*#e0973c/); assert.match(css, /--amber-hot:\s*#f4b45c/); assert.match(css, /--red-hot:\s*#ff5670/)
  assert.match(css, /--hue:\s*196;/, 'the default theme hue')
  assert.match(css, /--accent:\s*hsl\(var\(--hue\) 60% 65%\)/); assert.match(css, /--accent-hot:\s*hsl\(var\(--hue\) 100% 83%\)/)
  assert.deepEqual(STATE_ACCENT, { idle: '#a8e8ff', working: '#e0973c', waiting: '#f4b45c', error: '#ff5670' })
  assert.equal(STATE_ACCENT_HOT.working, STATE_ACCENT.waiting, 'full burn drifts toward --amber-hot')
  const accent = hexToOklab(hsl2hex(196, 60, 65)), hot = hexToOklab(hsl2hex(196, 100, 83))
  assert.ok(oklabDist(hot, hexToOklab(STATE_ACCENT.idle)) < 0.01, 'the idle fallback IS --accent-hot at the default hue')
  const lab = Object.fromEntries(Object.entries(STATE_ACCENT).map(([k, v]) => [k, hexToOklab(v)]))
  for (const [x, y] of [['working', 'waiting'], ['working', 'error'], ['waiting', 'error']]) {
    const dh = hueDist(hueOf(lab[x]), hueOf(lab[y])), dL = Math.abs(lab[x][0] - lab[y][0])
    assert.ok(dh >= 25 || dL >= 0.07, `${x} vs ${y}: hue ${dh.toFixed(0)}deg, dL ${dL.toFixed(3)}`)
  }
  for (const k of ['working', 'waiting', 'error']) assert.ok(hueDist(hueOf(lab[k]), hueOf(accent)) >= 30, `${k} vs the theme accent`)
  assert.ok(hueDist(hueOf(lab.idle), hueOf(accent)) <= 25 && lab.idle[0] >= accent[0] + 0.10, 'idle: same family, lighter')
})

ok('tokenRate: sums the tokens of messages that LANDED in the window (a change in series[].tokens), ignores older points and repeats; 0 below two points', () => {
  const now = 100_000, pt = (ago, tokens) => ({ t: now - ago, tokens })
  const series = [pt(40_000, 100), pt(38_800, 100), pt(25_000, 500), pt(23_800, 500), pt(20_000, 800), pt(10_000, 800), pt(5_000, 300), pt(3_800, 300)]
  assert.equal(tokenRate(series, now), (800 + 300) / (BURN.windowMs / 60_000), 'the 23.8s point repeats the 25s one — not a landing')
  assert.equal(tokenRate(series, now, 4_000), 0, 'the 3.8s point repeats the 5s one')
  assert.equal(tokenRate([pt(1_000, 5)], now), 0)
  assert.equal(tokenRate(null, now), 0)
})

ok('burnOf: 0 at rest, monotone, exactly 1 at rmax, clamped above; burnTarget floors a working band and never lights an idle one', () => {
  assert.equal(burnOf(0), 0)
  assert.ok(Math.abs(burnOf(BURN.rmax) - 1) < 1e-12 && burnOf(BURN.rmax * 10) === 1)
  let prev = 0
  for (let r = 0; r <= BURN.rmax; r += 100) { const b = burnOf(r); assert.ok(b >= prev); prev = b }
  assert.ok(burnOf(BURN.r0) > 0.2 && burnOf(BURN.r0) < 0.3, 'r0 sits near the quarter point')
  assert.equal(burnTarget('idle', 5000), 0)
  assert.equal(burnTarget('working', 0), BURN.floorWork)
  assert.equal(burnTarget('working', BURN.rmax), 1)
  assert.equal(burnTarget('waiting', 0), BURN.baseWait)
  assert.equal(burnTarget('error', 0), BURN.error)
})

ok('claims with state: a working band heats and burns; a waiting band breathes by >= 0.8 x pulseAmp; an error band goes red; cooling is > 3x slower than warming; a function-shaped 4th argument still works', () => {
  const at = (frames, state, rate = 3000) => {
    const C = makeClaims()
    for (let i = 0; i < frames; i++) advanceClaims(C, [{ id: 'a' }], 1 / 60, { stateOf: () => state, rateOf: () => rate })
    return C
  }
  const W = at(60, 'working')
  assert.ok(W.heat[0] > 0.9 && W.burn[0] >= BURN.floorWork * 0.9, `heat ${W.heat[0].toFixed(3)} burn ${W.burn[0].toFixed(3)}`)
  assert.ok(oklabDist(W.lab[0], hexToOklab(STATE_ACCENT.working)) < 0.08, 'warm: amber, drifting toward amber-hot with rate')
  const X = at(180, 'waiting'); let lo = 9, hi = -9
  for (let i = 0; i < Math.round(BURN.pulsePeriod * 60); i++) {
    advanceClaims(X, [{ id: 'a' }], 1 / 60, { stateOf: () => 'waiting' })
    const v = bandBurn(X, 0); lo = Math.min(lo, v); hi = Math.max(hi, v)
  }
  assert.ok(hi - lo >= 0.8 * BURN.pulseAmp, `pulse swing ${(hi - lo).toFixed(3)}`)
  const E = at(240, 'error')
  assert.ok(oklabDist(E.lab[0], hexToOklab(STATE_ACCENT.error)) < 0.02 && Math.abs(E.burn[0] - BURN.error) < 0.02)
  const C = makeClaims(), idle = hexToOklab(STATE_ACCENT.idle), amber = hexToOklab(STATE_ACCENT.working), D = oklabDist(idle, amber)
  let tw = 0; while (oklabDist(C.lab[0], amber) > 0.1 * D) { advanceClaims(C, [{ id: 'a' }], 1 / 60, { stateOf: () => 'working', rateOf: () => 0 }); tw += 1 / 60 }
  let tc = 0; while (oklabDist(C.lab[0], idle) > 0.1 * D) { advanceClaims(C, [{ id: 'a' }], 1 / 60, { stateOf: () => 'idle' }); tc += 1 / 60 }
  assert.ok(tw < 0.8 && tc > 3 * tw && tc < 7, `warm t90 ${tw.toFixed(2)}s, cool t90 ${tc.toFixed(2)}s`)
  const F = makeClaims(); advanceClaims(F, [{ id: 'a', working: true }], 1 / 60, (s) => !!s.working)
  assert.ok(F.heat[0] > 0, 'a bare isWorking function is still accepted as the 4th argument')
})

ok('orb-presence wiring: per-band colour reaches the shader, uColorS is gone, the body mood is written through the ramp (never snapped), the sampler is throttled', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  assert.match(src, /uniform vec3\s+uSessColor\[SESS\];/)
  assert.match(src, /out vec3 vAccentCol;/); assert.match(src, /in vec3 vAccentCol;/)
  assert.match(src, /col = mix\(col, vAccentCol, vAccent\);/)
  assert.doesNotMatch(src, /uColorS|sessionAccent|SESSION_ACCENT\b/)
  assert.match(src, /float sessP = sessionBand\(nl, uAxis, heat, burn, accent\) \* vein;/)
  assert.match(src, /advanceClaims\(claims, liveSessions, dtS, claimOpts\)/)
  assert.doesNotMatch(src, /uColorA\.value\.set\(m\.a\)|uColorB\.value\.set\(m\.b\)/, 'the snap is gone')
  // Both materials read the RAMP (never a snapped mood colour), and since
  //  BOTH read it through `thinkingTint`. This assertion used to
  // pin the opposite — one tinted, one not — as a tripwire against iris
  // gaining the tint by accident. On the tint became deliberate on
  // both -- the body must react to what is typed at the orchestrator -- so the
  // tripwire is retargeted rather than deleted: NEITHER may read the ramp raw.
  assert.equal((src.match(/\.setHex\(oklabToHex\(moodRamp\.a\)\)/g) ?? []).length, 0, 'no material may read the ramp untinted any more')
  assert.equal((src.match(/\.setHex\(oklabToHex\(thinkingTint\(moodRamp\.a, thinkingLevel\)\)\)/g) ?? []).length, 2, 'both materials read the ramp through the thinking tint')
  assert.match(src, /su\.uSessColor\.value\[b\]\.setHex\(oklabToHex\(claims\.lab\[b\]\)\)/)
  assert.match(src, /claims\.heat\[b\], bandBurn\(claims, b\)\)/)
  assert.match(src, /const SAMPLE_MS = 500/); assert.match(src, /if \(nowMs - sampledAt < SAMPLE_MS\) return/)
})

ok('orbitals are keyed by band ownership, not list position — a departure frees a slot without renumbering the survivors', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  assert.doesNotMatch(src, /sessionAngle\[i\]/)
  assert.doesNotMatch(src, /liveSessions\.forEach\(\(s, i\)/)
  assert.match(src, /const s = claims\.owner\[b\] === null \? undefined : liveById\.get\(claims\.owner\[b\]\)/)
  assert.match(src, /u\.uSessions\.value\[b\]\.set\(0, 0, 0, 0\)/, 'an empty slot is radius 0')
  assert.match(src, /if \(idx >= uSessionCount \|\| s\.x <= 0\.0\)/, 'the shader clips an empty slot like an out-of-count one')
  const before = src.indexOf('advanceClaims(claims, liveSessions, dtS, claimOpts)'), loop = src.indexOf('for (let b = 0; b < MAX_SESSIONS; b++)')
  assert.ok(before > 0 && loop > before, 'claims advance BEFORE the orbital loop reads ownership')
})

// ------------------------------- orchestrator thinking indicator ----
ok('easeThinking approaches the target smoothly, never snaps, and dt=0 is the identity', () => {
  assert.equal(easeThinking(0, false, 0), 0, 'dt=0 changes nothing')
  assert.equal(easeThinking(0.5, true, 0), 0.5, 'dt=0 changes nothing even mid-transition')
  const afterOneTau = easeThinking(0, true, THINKING_EASE_TAU)
  assert.ok(afterOneTau > 0.5 && afterOneTau < 1, 'one time constant in: well underway, not yet snapped to 1')
  let level = 0
  for (let i = 0; i < 200; i++) level = easeThinking(level, true, THINKING_EASE_TAU / 20)
  assert.ok(level > 0.999, 'settles arbitrarily close to 1 given enough time')
  for (let i = 0; i < 200; i++) level = easeThinking(level, false, THINKING_EASE_TAU / 20)
  assert.ok(level < 0.001, 'and back down to 0 once busy goes false')
})

ok('easeThinking never overshoots its target in either direction', () => {
  let level = 0
  for (let i = 0; i < 500; i++) {
    level = easeThinking(level, true, 0.016)
    assert.ok(level >= 0 && level <= 1, `level ${level} left [0,1] while easing toward 1`)
  }
  for (let i = 0; i < 500; i++) {
    level = easeThinking(level, false, 0.016)
    assert.ok(level >= 0 && level <= 1, `level ${level} left [0,1] while easing toward 0`)
  }
})

ok('thinkingGlowMult/thinkingSpinMult are the identity at level 0 -- an idle relay renders exactly as it always has', () => {
  assert.equal(thinkingGlowMult(0), 1)
  assert.equal(thinkingSpinMult(0), 1)
})

ok('thinkingGlowMult/thinkingSpinMult reach their full, documented multiplier at level 1', () => {
  assert.equal(thinkingGlowMult(1), THINKING_GLOW_MULT)
  assert.equal(thinkingSpinMult(1), THINKING_SPIN_MULT)
})

ok('thinkingGlowMult/thinkingSpinMult are monotonic and clamp outside [0,1]', () => {
  assert.equal(thinkingGlowMult(-1), thinkingGlowMult(0))
  assert.equal(thinkingSpinMult(2), thinkingSpinMult(1))
  assert.ok(thinkingGlowMult(0.75) > thinkingGlowMult(0.25))
  assert.ok(thinkingSpinMult(0.75) > thinkingSpinMult(0.25))
})

ok('advance()\'s new thinkMult parameter defaults to 1 -- every call site that omits it is byte-for-byte unaffected', () => {
  const p = LOOKS.streams.p
  const a = advance(freshAngles(), p, LOOKS.streams.wrap, 0.5, 0.1, 1.4)
  const b = advance(freshAngles(), p, LOOKS.streams.wrap, 0.5, 0.1, 1.4, 1)
  assert.deepEqual(a, b, 'an explicit thinkMult of 1 must reproduce the no-argument call exactly')
})

ok('advance()\'s thinkMult scales both the orbit rate and the precession rate directly (undamped, unlike spinMult)', () => {
  const p = LOOKS.streams.p
  const base = advance(freshAngles(), p, LOOKS.streams.wrap, 0.5, 0.1, 1, 1)
  const boosted = advance(freshAngles(), p, LOOKS.streams.wrap, 0.5, 0.1, 1, 2)
  // Both angles started at 0, so the accumulated angle after one step IS the
  // rate*dt term -- the ratio must be exactly thinkMult.
  assert.ok(Math.abs(boosted.orbit / base.orbit - 2) < 1e-9, `orbit ratio ${boosted.orbit / base.orbit} != 2`)
  assert.ok(Math.abs(boosted.prec / base.prec - 2) < 1e-9, `prec ratio ${boosted.prec / base.prec} != 2`)
})

ok('the streams shader\'s uGlow is written every frame from STREAMS_BASE_GLOW * thinkingGlowMult, and the spin passed to advance() carries thinkingSpinMult', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  assert.match(src, /su\.uGlow\.value = STREAMS_BASE_GLOW \* thinkingGlowMult\(thinkingLevel\)/)
  assert.match(src, /const thinkSpin = thinkingSpinMult\(thinkingLevel\)/)
  assert.match(src, /streamsAng = advance\(streamsAng, sp, LOOKS\.streams\.wrap, actS, dt, mult, thinkSpin\)/)
  assert.match(src, /thinkingLevel = easeThinking\(thinkingLevel, orchestratorBusy, dt\)/)
})

ok('MCS.setBusy exists and only ever sets the module-local orchestratorBusy flag; the STREAMS glow write stays inside the streams-visible block', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  assert.match(src, /setBusy\(on\) \{\s*orchestratorBusy = !!on/)
  // This test's label used to end "-- iris/shell never read thinkingLevel".
  // The body never asserted that, and the opposite became true:
  // the indicator was ported onto the shared iris/shell material too. The label is corrected to what is actually enforced here, and the
  // port itself is pinned by its own test below -- rather than leaving a
  // claim no assertion backs, which is how a pin goes stale.
  //
  // What still holds: the STREAMS-specific glow write (su.uGlow, on the
  // streams material) belongs inside the `if (streamsPoints.visible)` span.
  const visibleStart = src.indexOf('if (streamsPoints.visible) {')
  const visibleEnd = src.indexOf('\n    }', visibleStart)
  const glowSite = src.indexOf('su.uGlow.value = STREAMS_BASE_GLOW')
  assert.ok(visibleStart > 0 && glowSite > visibleStart && glowSite < visibleEnd, 'the glow write must live inside the streams-visible block')
})

ok('shell is the default look, and the cycle order is unchanged — a persisted choice still wins (swarm.js reads localStorage first)', () => {
  assert.equal(DEFAULT_MODE, 'shell', 'shell is what a fresh pane opens on')
  assert.ok(MODES.includes(DEFAULT_MODE), 'the default has to be a real mode')
  assert.deepEqual(MODES.slice(0, 3), ['iris', 'streams', 'shell'], 'the corner button still opens on the same three')
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  assert.match(src, /let mode = DEFAULT_MODE/, 'the initial value, before any restore')
  assert.doesNotMatch(src, /let mode = MODES\[0\]/, 'the old MODES[0] default is gone')
  // The restore path must still prefer what the user picked: boot() reads the
  // stored key and hands it to setMode, which normalizes it — so a stored
  // 'iris' survives, and only a null/unknown value falls through to the
  // default. Pinned as the two real lines rather than one clever regex.
  assert.match(src, /saved = localStorage\.getItem\(MODE_KEY\)/, 'boot reads the stored look')
  assert.match(src, /MCS\.setMode\(saved, \{ fade: false \}\)/, 'and it wins over the default')
})

ok('the orchestrator thinking indicator reaches BOTH materials — same eased level, same red shift, same glow swell; level 0 is the exact identity on each', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  // streams, as it already shipped
  assert.match(src, /streamsMaterial\.uniforms\.uColorA\.value\.setHex\(oklabToHex\(thinkingTint\(moodRamp\.a, thinkingLevel\)\)\)/)
  assert.match(src, /su\.uGlow\.value = STREAMS_BASE_GLOW \* thinkingGlowMult\(thinkingLevel\)/)
  // legacy (iris/shell), ported  — one material, so both looks get it
  assert.match(src, /u\.uColorA\.value\.setHex\(oklabToHex\(thinkingTint\(moodRamp\.a, thinkingLevel\)\)\)/)
  assert.match(src, /u\.uGlow\.value = LEGACY_BASE_GLOW \* thinkingGlowMult\(thinkingLevel\)/)
  assert.match(src, /uniform float uGlow;/, 'the legacy fragment declares it')
  assert.match(src, /gl_FragColor = vec4\(col \* uGlow,/, 'and multiplies COLOUR, not alpha — the material is additive')
  // The maths itself: identity at rest, the full multiplier at level 1, and
  // the tint is a real shift toward red rather than a no-op.
  assert.equal(thinkingGlowMult(0), 1, 'idle must be byte-for-byte the shipped render')
  assert.ok(Math.abs(thinkingGlowMult(1) - THINKING_GLOW_MULT) < 1e-12)
  const teal = hexToOklab('#3d7f95')
  assert.deepEqual(thinkingTint(teal, 0), teal, 'level 0 returns the ramp untouched')
  const hot = thinkingTint(teal, 1)
  assert.ok(hot[1] > teal[1], 'a-axis moves toward red at full level')
  assert.ok(oklabDist(hot, THINKING_RED) < oklabDist(teal, THINKING_RED), 'and ends nearer red than it started')
})







ok('every CLUSTER constant emits a valid GLSL float, so a retune to a round number cannot break the shader', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  // glf lives in swarm-math.js, not here: a compile check outside the browser
  // evaluates the chunk templates against that module's exports, so a helper
  // defined beside the shader is out of scope there.
  const mathSrc = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm-math.js'), 'utf8')
  assert.match(mathSrc, /export const glf = /, 'the formatter must be an export of the maths module')
  assert.match(src, /SCRIBBLE, scribblePaths, scribbleFade, glf,/, 'and swarm.js imports it')
  // No raw ${CLUSTER.x} interpolation may survive: an integer-valued one emits
  // `5`, GLSL types it as int, and pow(float, int) has no overload.
  const raw = src.match(/\$\{CLUSTER\.[A-Za-z]+\}/g) ?? []
  assert.deepEqual(raw, [], `these bypass glf() and will break on a round value: ${raw.join(', ')}`)
  // And the formatter does the job it claims.
  assert.equal(glf(5), '5.0'); assert.equal(glf(0.34), '0.34'); assert.equal(glf(1), '1.0')
})



ok('a session cluster is contained BY ITS CENTRE, never per point — per-point containment is what flattened it onto the shell, at 0.000% depth surviving', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  const branch = src.slice(src.indexOf('if (aRole > 0.5) {'), src.indexOf('// Each particle runs a lifetime'))
  assert.match(branch, /vec3 c = clen > uClusterBound \? centre \* \(uClusterBound \/ clen\) : centre;/, 'the CENTRE is clamped')
  assert.match(branch, /vec3 p = c \+ aHome \* spread \* uRadius;/, 'and the sphere is built around the clamped centre')
  assert.doesNotMatch(branch, /p = contain\(p\)/, 'per-point contain() is exactly the defect — it must never come back here')
  assert.match(branch, /sin\(ang\) \* s\.x \* uClusterOrbitZ/, 'orbit depth is tunable, not a baked 0.6 that lunges')

  // THE MEASUREMENT that found it, kept so the number cannot quietly return.
  // contain() is a tanh squash onto CONTAIN_CEILING and saturates hard; a
  // cluster orbits far past SAFE_RADIUS, so every point lands on one radius.
  const T = SAFE_RADIUS, C = CONTAIN_CEILING
  const contain = (len) => {
    if (len <= T) return len
    const span = C - T, x = (len - T) / span
    return T + span * (1 - 2 / (Math.exp(2 * x) + 1))
  }
  for (const orbit of [1.85, 2.09, 2.33]) {
    const r = CLUSTER.spread
    const depth = contain(orbit + r) - contain(orbit - r)
    assert.ok(depth / (2 * r) < 0.01,
      `per-point contain leaves ${(depth / (2 * r) * 100).toFixed(3)}% of a cluster's depth at orbit ${orbit} — this is the flattening`)
  }

  // The depth swing the flattening had been hiding. The clamp scales the whole
  // centre vector, so the bound governs this too.
  const swing = (z, bound) => {
    let near = Infinity, far = 0
    for (let i = 0; i < MAX_SESSIONS; i++) {
      const o = sessionOrbit(i)
      for (let a = 0; a < Math.PI * 2; a += 0.05) {
        const d = CAMERA_Z - Math.sin(a) * o.radius * z * (bound / 2.40)
        near = Math.min(near, d); far = Math.max(far, d)
      }
    }
    return { near, ratio: far / near }
  }
  const now = swing(CLUSTER.orbitZ, CLUSTER.centreMax)
  assert.ok(now.ratio < 1.25, `a cluster's near/far size swing is ${now.ratio.toFixed(2)}x — it lunges at the camera`)
  assert.ok(now.near > 2.9, `a cluster comes within ${now.near.toFixed(2)} of the camera`)
  // The control: the orbit's own 0.6 at the old bound must fail it.
  assert.ok(swing(0.6, 2.40).ratio > 2.4, 'the unmodified orbit depth must be shown to lunge')

  // And it has to stay near the panel. See the overhang note in the
  // containment test below: the clusters exceed the visible bound by ~5%,
  // a pre-existing fact this file hid until its tan/sin error was fixed.
  const halfH = VISIBLE_HALF_HEIGHT
  assert.ok(CLUSTER.centreMax + CLUSTER.spread < halfH * 1.10,
    `a cluster reaches ${(CLUSTER.centreMax + CLUSTER.spread).toFixed(3)} against a visible bound of ${halfH.toFixed(3)}`)
})

ok('a session cluster is DENSE enough to read as a surface — density from COUNT, not grain size', () => {
  const c = clusterCoverage()
  // Two rounds of work on how the thing was SHADED failed while it was too
  // sparse to have a surface at all. 60 grains gave 0.04 sprites of overlap
  // per pixel: the dots never touched.
  assert.ok(c.overlap >= CLUSTER_MIN_COVERAGE,
    `overlap ${c.overlap.toFixed(2)} sprites/px — below ${CLUSTER_MIN_COVERAGE} it is a scatter, not a surface`)
  assert.ok(clusterCoverage({ working: 1 }).overlap >= CLUSTER_MIN_COVERAGE, 'and while working too, where it tightens')
  // More particles, not bigger ones: the grain must stay FINER than the 1.4
  // it replaced.
  assert.ok(CLUSTER.grain < 1.4, `grain ${CLUSTER.grain} is not finer than the 1.4 it replaced`)
  assert.ok(c.pointPx < 3.1, `grain is ${c.pointPx.toFixed(2)}px on screen — no coarser than before`)
  // The control: the count that shipped for a year must fail the check.
  const before = { ...CLUSTER }
  try {
    CLUSTER.particles = 60; CLUSTER.grain = 1.4
    assert.ok(clusterCoverage().overlap < 1, 'the original 60-point cluster must be shown to be a scatter')
  } finally { Object.assign(CLUSTER, before) }
  assert.ok(CLUSTER.particles * MAX_SESSIONS <= 150000, `budget ${CLUSTER.particles * MAX_SESSIONS} points`)
})

ok('a cluster cannot clip to white: accumulated brightness stays under 1 in BOTH states, and tightening no longer raises it by itself', () => {
  // Additive blending SUMS every grain along a ray. The point count went up
  // 30x while the per-point fade stayed where it was for 60 points, so the
  // clusters blew out — and because a WORKING cluster tightens, raising
  // density, only the busy ones did, each at whatever moment it happened to
  // be working.
  const f0 = clusterFade()
  const acc = (working) => {
    const cov = clusterCoverage({ working })
    const sp = CLUSTER.spread + (CLUSTER.spreadWork - CLUSTER.spread) * working
    const ptf = 0.7 + working * 0.5
    const k = (sp / CLUSTER.spread) * (0.7 / ptf)
    return cov.overlap * f0 * k * k * (1 + CLUSTER.workBoost * working)
  }
  const idle = acc(0), work = acc(1)
  assert.ok(idle < 1, `idle accumulates ${idle.toFixed(2)} — over 1 clips to white`)
  assert.ok(work < 1, `working accumulates ${work.toFixed(2)} — over 1 clips to white`)
  assert.ok(idle > 0.4, `idle accumulates ${idle.toFixed(2)} — too dim to read`)
  // The difference between them must be the DELIBERATE boost, not a density
  // accident: within a few percent of workBoost, not the 4x it used to be.
  const ratio = work / idle
  assert.ok(Math.abs(ratio - (1 + CLUSTER.workBoost)) < 0.05,
    `working is ${ratio.toFixed(2)}x idle; only workBoost (${1 + CLUSTER.workBoost}x) should separate them`)
  // The control: without the k^2 compensation, working blows past 1.
  const uncompensated = clusterCoverage({ working: 1 }).overlap * f0
  assert.ok(uncompensated > 1.5, `uncompensated working accumulates ${uncompensated.toFixed(2)} — the white-out must be reproducible`)
})

ok('a cluster clears the body it orbits and stays inside the panel — it was passing straight through the core', () => {
  const halfH = VISIBLE_HALF_HEIGHT
  // Measured against the LARGEST cluster: they are no longer all one size, so
  // the biggest is the one that has to clear the body and fit the panel.
  const big = CLUSTER.spread * CLUSTER.sizeVarMax + CLUSTER.drift * CLUSTER.spread * CLUSTER.sizeVarMax
  const inner = CLUSTER.centreMax - big
  const outer = CLUSTER.centreMax + big
  assert.ok(inner > maxBodyRadius(),
    `a cluster's inner edge ${inner.toFixed(2)} must clear the body's ${maxBodyRadius().toFixed(3)} — below that it phases through the core`)
  // KNOWN AND NOT FIXED HERE: the clusters overhang the visible bound by ~5%.
  // It only surfaced when this file's panel bound was corrected on
  //  — every check here used CAMERA_Z*tan(fov/2), the frustum
  // half-height at the origin plane, where the module's own
  // VISIBLE_HALF_HEIGHT is CAMERA_Z*sin(fov/2), the largest fully-visible
  // SPHERE radius. The tan form is ~8% too generous, so the clusters
  // measured as fitting while they do not.
  //
  // Closing it means roughly halving the clusters: the band between the
  // body's permitted envelope and the visible bound is 0.157 wide and a
  // cluster is 0.278 across. That is a look decision, not a correctness one,
  // so it is recorded as a measured fact with a bound that fails if it gets
  // WORSE — rather than deleted, or quietly widened until it passes.
  assert.ok(outer < halfH * 1.10, `a cluster reaches ${outer.toFixed(3)} against a visible bound of ${halfH.toFixed(3)}`)
  // The control: the configuration that was seen passing through the body.
  assert.ok(1.12 - 0.16 < maxBodyRadius(), 'the reported bad case must be shown to intersect')
  // Following the pointer lean is what stops the BODY sliding into them, and
  // it must match the body's own translation or the gap still closes.
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  const bodyPull = src.match(/p \+= axis \* grav \* uRadius \* ([0-9.]+);/)
  assert.ok(bodyPull, 'found the body\'s own lean translation')
  assert.equal(CLUSTER.pull, Number(bodyPull[1]),
    `clusters follow the pointer by ${CLUSTER.pull} while the body moves ${bodyPull[1]} — the gap closes on a lean`)
  const branch = src.slice(src.indexOf('if (aRole > 0.5) {'), src.indexOf('// Each particle runs a lifetime'))
  assert.match(branch, /c \+= normalize\(pdir\) \* pgrav \* uRadius \* uClusterPull;/, 'and it is applied to the CENTRE')
})

ok('cluster drift is LOCAL and scaled to the cluster — it was sampled at the world position and flung the cluster off its orbit', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  const branch = src.slice(src.indexOf('if (aRole > 0.5) {'), src.indexOf('// Each particle runs a lifetime'))
  // Sampling curl at p (the WORLD position) drags the cluster through the
  // noise field as it orbits, and a cluster is thrown onto a path it was
  // never orbiting.
  assert.doesNotMatch(branch, /curl\(p,/, 'drift must not be sampled at the world position')
  assert.match(branch, /curl\(aHome \* 1\.7 \+ doff,/, 'sampled in the cluster\'s own frame, offset per slot')
  // And scaled to the cluster's radius, not a flat world amount: 0.04 was 25%
  // of this spread, which is why it stopped holding its shape.
  assert.match(branch, /\* spread \* uRadius;/, 'drift scales with the cluster')
  assert.ok(CLUSTER.drift <= 0.15, `drift ${CLUSTER.drift} of the radius is enough to lose the shape`)
})

ok('clusters are not all the same size, and the differing sizes do not change their brightness', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  assert.match(src, /float sizeVar = mix\(\$\{glf\(CLUSTER\.sizeVarMin\)\}, \$\{glf\(CLUSTER\.sizeVarMax\)\}, fract\(float\(idx\) \* 0\.6180339887\)\);/)
  assert.ok(CLUSTER.sizeVarMin < 1 && CLUSTER.sizeVarMax > 1, 'the variation must straddle the nominal size')
  // Deterministic per SLOT, and neighbours must actually differ — a golden
  // ratio step is chosen for exactly that; a round step would repeat.
  const sizes = []
  for (let i = 0; i < MAX_SESSIONS; i++) {
    const f = (i * 0.6180339887) % 1
    sizes.push(CLUSTER.sizeVarMin + (CLUSTER.sizeVarMax - CLUSTER.sizeVarMin) * f)
  }
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(Math.abs(sizes[i] - sizes[i - 1]) > 0.05, `slots ${i - 1} and ${i} are the same size`)
  }
  assert.ok(Math.max(...sizes) / Math.min(...sizes) > 1.15, 'the spread of sizes must be visible, not a rounding difference')
  // Brightness must NOT ride on size: a smaller cluster is denser, so without
  // the compensation it would read brighter purely for being small. `spread`
  // carries sizeVar into the k^2 term, which cancels it.
  assert.match(src, /float spread = mix\([\s\S]*?\) \* sizeVar;/, 'sizeVar folds into spread, so the fade compensation sees it')
})

ok('shell (lightning arcs): they are LIGHTNING — nearly straight runs punctuated by hard jags, not a random walk and not a wobbly ring', () => {
  const P = scribblePaths()
  assert.equal(P.length, SCRIBBLE.rings * SCRIBBLE.perRing)
  const ang = []
  for (const arc of P) {
    assert.equal(arc.length, SCRIBBLE.spine)
    for (const pt of arc) {
      const r = Math.hypot(...pt)
      // The arcs share the same narrow shell everything else fights for.
      assert.ok(r > maxBodyRadius(), `an arc point at ${r.toFixed(3)} is inside the body`)
      assert.ok(r < VISIBLE_HALF_HEIGHT, `an arc point at ${r.toFixed(3)} is off the panel`)
    }
    for (let i = 2; i < arc.length; i++) {
      const u = arc[i - 1].map((v, k) => v - arc[i - 2][k])
      const w = arc[i].map((v, k) => v - arc[i - 1][k])
      const du = Math.hypot(...u), dw = Math.hypot(...w)
      if (du < 1e-12 || dw < 1e-12) continue
      const d = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (du * dw)
      ang.push(Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI)
    }
  }
  ang.sort((a, b) => a - b)
  const q = (f) => ang[Math.floor(ang.length * f)]
  // THE SHAPE OF THE DISTRIBUTION IS THE LOOK. Lightning is straight runs with
  // hard corners: a low median AND a high tail. A per-step jitter larger than
  // the step itself produces a median turn of 59 degrees — that is static, and
  // no amount of tuning brightness makes it read as a bolt.
  assert.ok(q(0.5) < 6, `median turn ${q(0.5).toFixed(1)} deg — the runs must be nearly straight, not a random walk`)
  assert.ok(q(0.99) > 45, `p99 turn ${q(0.99).toFixed(1)} deg — without hard jags it is a wobbly ring, not lightning`)
  const sharp = ang.filter((a) => a > 45).length / ang.length
  assert.ok(sharp > 0.03 && sharp < 0.2, `${(sharp * 100).toFixed(1)}% of steps are sharp — too few reads smooth, too many reads as noise`)
  // The control: a jitter near the step size must fail the median test.
  assert.ok(SCRIBBLE.jitter < 0.005, 'a per-step jitter near the step size is the random-walk failure')
  assert.ok(SCRIBBLE.kink > SCRIBBLE.jitter * 10, 'the jag must dominate the wander, or there are no corners')
  // Deterministic, so the arc SET is stable and only which one is live varies.
  assert.deepEqual(scribblePaths(), P, 'the arcs are seeded, not random per load')
})

ok('shell (lightning arcs): gated on the shared buffer, brightness measured ON SCREEN, phase cannot teleport', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  assert.match(src, /if \(uArc < 0\.5\) \{ gl_Position/, 'the other looks skip the arc points')
  assert.doesNotMatch(src, /new Points\(buildScribble/, 'no second renderer')
  // The lightning look is shell plus the arcs, minus the orbiting clusters.
  const { uArc: a, uClusterHide: ah, ...scribRest } = LOOKS.shell
  const { uArc: b, uClusterHide: bh, ...shellRest } = LOOKS['shell v2']
  assert.deepEqual(scribRest, shellRest, 'the lightning look is shell v2 for every other body uniform')
  assert.equal(ah, 1, 'the lightning look draws no orbiting clusters')
  assert.equal(bh, 0, 'shell v2 still does')
  for (const k of ['iris', 'shell', 'shell v2']) {
    assert.ok('uArc' in LOOKS[k], `${k} must name uArc`)
    assert.ok('uClusterHide' in LOOKS[k], `${k} must name uClusterHide or it inherits the last look's value`)
  }
  assert.match(src, /if \(uClusterHide > 0\.5\) \{ gl_Position/, 'and the shader honours it')

  // REPOSITIONED EVERY FIRING. Without this the fixed arc set recurs in the
  // same places and reads as a loop. The rotation must be hashed from BOTH the arc and the
  // cycle: from the arc alone it is a fixed scramble, from the cycle alone
  // every arc moves together.
  const branch3 = src.slice(src.indexOf('if (aRole > 1.5) {'), src.indexOf('if (aRole > 0.5) {'))
  assert.match(branch3, /float yaw   = fract\(sin\(\(pid \* [0-9.]+ \+ cyc \* [0-9.]+\)/, 'yaw is hashed from arc AND cycle')
  assert.match(branch3, /float pitch = fract\(sin\(\(pid \* [0-9.]+ \+ cyc \* [0-9.]+\)/, 'pitch too')
  // Rigid: the tangent must be rotated by the SAME rotation as the position,
  // or the stream darts off its own spine.
  assert.match(branch3, /tg = vec3\(cy \* tg\.x \+ sy \* tg\.z, tg\.y, -sy \* tg\.x \+ cy \* tg\.z\);/)
  assert.match(branch3, /vec3 p = hm \+ tg \* \(eased - 0\.5\)/, 'and the dart uses the rotated pair, not the raw attributes')
  assert.ok(SCRIBBLE.reorient, 'the table records that this is deliberate')

  // THINKING GROWS AND QUICKENS THE ARCS: while thinking, each arc is about
  // twice as long and darts about twice as far.
  assert.match(branch3, /if \(aPath\.y > uArcSpan\)/, 'only part of each arc shows at rest')
  assert.match(branch3, /float sPos = aPath\.y \/ max\(0\.001, uArcSpan\);/, 'and the sweep renormalises over what shows')
  assert.match(src, /u\.uArcSpan\.value = SCRIBBLE\.spanIdle \+ \(1 - SCRIBBLE\.spanIdle\) \* thinkingLevel/)
  assert.match(src, /u\.uArcDart\.value = 1 \+ \(SCRIBBLE\.dartThink - 1\) \* thinkingLevel/)
  assert.equal(1 / SCRIBBLE.spanIdle, 2, 'an arc must double in length')
  assert.equal(SCRIBBLE.dartThink, 2, 'and the darts must double in reach')

  // BOTH ARE DISTANCES, NOT RATES. Scaling dartRate would be rate x time with
  // a moving rate's teleport defect, and every particle would jump the
  // moment the thinking level moved. This is the assertion that keeps the
  // cheap-looking fix out.
  assert.match(branch3, /\* uArcDart;/, 'the dart multiplier scales DISTANCE')
  assert.doesNotMatch(branch3, /uTime \* [a-z.]*[Rr]ate[^)]*\* u/, 'no uniform may scale a rate against uTime')
  assert.doesNotMatch(branch3, /uArcDart \* uTime|uTime \* uArcDart/, 'and uArcDart must never touch uTime')
  // On-screen alpha, not the multiplier: a per-point fade multiplier can look
  // entirely reasonable while what it scales renders at a couple of percent.
  const full = scribbleOnScreen(1.0)
  assert.ok(full > 0.6 && full <= 1.0, `a live bolt reaches ${full.toFixed(3)} on screen`)
  assert.ok(scribbleOnScreen(0.1) > 0.05, 'and a dim part of a bolt is still visible')

  // A STREAM, not a line of dots: many fine particles darting along the spine,
  // carrying some weight and inertia as they go. Three things have to hold for
  // that.
  const branch2 = src.slice(src.indexOf('if (aRole > 1.5) {'), src.indexOf('if (aRole > 0.5) {'))
  // 1. Many particles per arc, well above the spine's own resolution — the
  //    spine defines the path, the particles are the substance flowing on it.
  assert.ok(SCRIBBLE.perArc >= 5 * SCRIBBLE.spine,
    `perArc ${SCRIBBLE.perArc} against a ${SCRIBBLE.spine}-point spine is a line of dots, not a stream`)
  // 2. They DART along the spine, which needs the local tangent.
  assert.match(src, /attribute vec3  aTan;/)
  assert.match(branch2, /hm \+ tg \* \(eased - 0\.5\)/, 'particles must move ALONG the spine (hm/tg are aHome/aTan after the per-cycle rotation)')
  // 3. With inertia: the dart is eased, so it leaves fast and arrives slow. A
  //    linear sawtooth is a texture scrolling; the ease is the weight.
  assert.match(branch2, /1\.0 - pow\(1\.0 - dp, /, 'the dart must be eased, not linear')
  assert.ok(SCRIBBLE.dartEase > 1, `dartEase ${SCRIBBLE.dartEase} is linear — no deceleration, no weight`)
  // And the scatter rides the dart's own speed, so it frays while moving and
  // settles on arrival — crackling, rather than a uniform fuzz.
  assert.match(branch2, /\* \(0\.35 \+ speed\)/, 'scatter must ride the dart speed')
  assert.ok(SCRIBBLE.scatter > 0 && SCRIBBLE.scatter < SCRIBBLE.dartLen,
    'scatter must be smaller than the dart, or the stream loses its line')
  // Constant period: the exemption, same as the cage.
  const branch = src.slice(src.indexOf('if (aRole > 1.5) {'), src.indexOf('if (aRole > 0.5) {'))
  assert.match(branch, /fract\(uTime \/ \$\{glf\(SCRIBBLE\.periodS\)\} \+ off\)/)
  assert.doesNotMatch(branch, /uTime \/ u[A-Z]/, 'no uniform may set the period')
  assert.match(branch, /uActivity/, 'and it must respond to activity, or it is decoration')
})

ok('shell (lightning arcs): they ride the same rings the body does — the ask ripple reaches the arcs, not just the shell under them', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  const branch = src.slice(src.indexOf('if (aRole > 1.5) {'), src.indexOf('if (aRole > 0.5) {'))
  // Without this the body pulsed under a passing ring while the lightning
  // around it stayed rigid — two unrelated things sharing a panel.
  assert.match(branch, /ripples\(normalize\(hm\), rbent, rkick, rgk, rbeat\);/, 'the arcs must sample the same ring field')
  assert.match(branch, /p \+= normalize\(hm\) \* rbeat \* uArcRipple;/, 'and be displaced by it, through a walkable uniform')
  assert.match(branch, /float ring = min\(rbeat \/ \$\{glf\(SCRIBBLE\.ringRef\)\}, \$\{glf\(SCRIBBLE\.ringMax\)\}\);/, 'and brighten at its front, like the body')
  // OVERLAPPING RINGS MUST STACK. Rings coexist in separate slots and their
  // beats sum in the shader — but the old clamp(rbeat/0.08, 0, 1) pinned at
  // 1.0 for a single ask ring (peak 0.13), so a heartbeat arriving mid-sweep
  // contributed nothing visible while the arcs cooled down from the first
  // ring. Simulated here,
  // because the saturation is invisible in the constants alone.
  const rip2 = makeRipples()
  askRipple(rip2, 0, 1)
  const A2 = Array.from({ length: RIPPLE_SLOTS }, () => new Float32Array(4))
  const B2 = Array.from({ length: RIPPLE_SLOTS }, () => new Float32Array(4))
  const peakBeat = () => {
    let mx = 0
    for (let k = 0; k <= 24; k++) {
      const th = Math.PI * k / 24
      let b = 0
      for (let i = 0; i < RIPPLE_SLOTS; i++) {
        if (B2[i][0] === 0 && B2[i][1] === 0) continue
        const u = (th - A2[i][3]) / Math.max(B2[i][2], 1e-3)
        if (B2[i][3] < 0.5) b += B2[i][0] * Math.exp(-0.5 * u * u)
      }
      mx = Math.max(mx, b)
    }
    return mx
  }
  rippleRows(rip2, 1.2, (v) => v, A2, B2)
  const one = peakBeat()
  heartbeat(rip2, 1.2, 1)
  rippleRows(rip2, 1.6, (v) => v, A2, B2)
  const two = peakBeat()
  assert.ok(two > one, 'a second ring must raise the summed beat at all')
  // The mapping must PASS that increase through rather than clipping it.
  const map = (b) => Math.min(b / SCRIBBLE.ringRef, SCRIBBLE.ringMax)
  assert.ok(map(two) > map(one) * 1.02,
    `the ring mapping saturates: one ring maps to ${map(one).toFixed(3)}, two to ${map(two).toFixed(3)}`)
  assert.ok(SCRIBBLE.ringMax > 1, 'a ceiling of 1 is exactly what hid the second ring')
  assert.ok(Math.abs(SCRIBBLE.ringRef - 0.13) < 0.05, 'the reference should be one real ring, not an arbitrary fraction')
  // THE RING MUST BE SAMPLED BEFORE ANYTHING IS CULLED. It used to sit after
  // the visibility cutoff, so only arcs that happened to be mid-draw could
  // ripple — and an arc is lit about a third of the time, so a ring swept
  // over mostly-dark geometry and the layer read as static while the body
  // heaved. Order is the whole fix, and order is what this asserts.
  assert.ok(branch.indexOf('ripples(normalize(hm)') < branch.indexOf('bright < 0.004'),
    'the ring must be sampled before the visibility cutoff, or dark arcs never ripple')
  // UNGATED. The reveal must not be multiplied by `alive`: that is the
  // per-cycle dropout, and it silenced about a third of the arcs for any
  // given ring — they fell under the cutoff and were discarded before the
  // displacement ran. The arcs must ripple in sync with the core, always.
  assert.match(branch, /bright = max\(bright, ring \* /, 'a passing ring must reveal EVERY arc')
  assert.doesNotMatch(branch, /max\(bright, alive \* ring/, 'the dropout must not suppress the body ring')
  assert.ok(SCRIBBLE.ringFlare > 0 && SCRIBBLE.ringFlare < 1, `ringFlare ${SCRIBBLE.ringFlare} out of range`)
  // The dropout must still exist — it governs the arcs' own draw cycle, and
  // removing it entirely would make every arc fire every time.
  assert.match(branch, /float alive = step\(/, 'the dropout still gates the draw cycle')
  // The arcs must be swept OUTWARD by at least as much as the body swells,
  // or the body grows through them — which is what prompted this.
  assert.ok(SCRIBBLE.ripple >= LOOKS.shell.uRipLift,
    `arcs sweep ${SCRIBBLE.ripple} against a body lift of ${LOOKS.shell.uRipLift} — the body would grow into them`)
  // Sampled at the ROTATED position: the arcs move every cycle, so sampling
  // the raw attribute would ripple them where they used to be.
  assert.doesNotMatch(branch, /ripples\(normalize\(aHome\)/, 'must sample where the arc IS, not where it was authored')
  assert.ok(SCRIBBLE.ripple >= LOOKS.shell.uRipLift && SCRIBBLE.ripple < 8,
    `arc ripple ${SCRIBBLE.ripple} must be at least the body's own lift (${LOOKS.shell.uRipLift}) and not absurd`)
  // The ask preset is slow, big and long-lived. If someone retunes it into a
  // snap, this look loses the whole point of it.
  // "Slow" once meant speed < 0.4, but at 0.28 the ring is too slow to read —
  // it expires at 62% of the way across. The real constraint is that it must COMPLETE its sweep and
  // still be a sweep rather than a flash; the crossing test below owns it.
  assert.ok(RIPPLE.ask.speed * RIPPLE.ask.life > Math.PI, 'the ask ring must complete its crossing')
  assert.ok(RIPPLE.ask.sigma > 0.5, `ask ring sigma ${RIPPLE.ask.sigma} is not a big one`)
  assert.ok(RIPPLE.ask.life > 4, `ask ring life ${RIPPLE.ask.life}s is too brief to cross the sphere`)
})

ok('the per-frame ripple write READS THE LOOK — it used to hardcode shell to zero and stamp over whatever LOOKS said', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  // THE BUG THIS PINS. applyLook writes LOOKS' uRipLift/uRipGlow onto the
  // material when the mode changes, and MCS.frame then wrote its OWN values
  // over them every frame from `mode === 'shell' ? 0 : base`. So LOOKS' values
  // for these two were fiction: raising LOOKS.shell.uRipLift changed nothing,
  // and the ripple stayed missing.
  // Matched on the assignment, not the phrase — the comment above the fix
  // quotes the old code, and a looser regex hits that instead.
  assert.doesNotMatch(src, /const baseLift = /, 'the hardcoded shell silence must not come back')
  assert.doesNotMatch(src, /const baseGlow = /)
  assert.match(src, /u\.uRipLift\.value = \(look\.uRipLift \?\? BASE_RIP_LIFT\) \* ripMult/)
  assert.match(src, /u\.uRipGlow\.value = \(look\.uRipGlow \?\? BASE_RIP_GLOW\) \* ripMult/)
  assert.match(src, /const look = LOOKS\[mode\] \?\? LOOKS\[DEFAULT_MODE\]/, 'and it resolves the CURRENT look')
  // Every look on the legacy material must therefore declare both, or it
  // silently falls back to iris's.
  for (const k of ['iris', 'shell', 'shell v2']) {
    assert.equal(typeof LOOKS[k].uRipLift, 'number', `${k} must declare uRipLift`)
    assert.equal(typeof LOOKS[k].uRipGlow, 'number', `${k} must declare uRipGlow`)
  }
  // And a hand trigger exists, so the ring can be checked without waiting on
  // a real orchestrator turn.
  assert.match(src, /ask\(strength = 1\) \{ askRipple\(ripples, nowMs \* 0\.001, strength\)/)
})

ok('the body pulse follows a LIST of looks, not the literal string "shell" — every look forked from shell silently lost it', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  // THE REGRESSION THIS PINS. pushPulse and the uPulses write were gated on
  // `mode === 'shell'` in four separate places, so a look forked from shell
  // silently lost the core sphere's occasional pulse. A string comparison
  // scattered through the frame loop cannot survive a fork; a list can.
  const gates = src.match(/mode === 'shell'/g) ?? []
  // One survivor is allowed: a comment quoting the old code.
  assert.ok(gates.length <= 1, `${gates.length} literal 'shell' gates remain — they do not survive a fork`)
  assert.doesNotMatch(src, /if \(fired && mode === 'shell'\)/, 'the heartbeat gate must be by list')
  assert.doesNotMatch(src, /if \(mode === 'shell'\) \{/, 'and so must the uPulses write')
  assert.equal((src.match(/usesBodyPulse\(mode\)/g) ?? []).length, 4, 'all four sites go through the predicate')

  // Every shell-family look must be in it. streams has its own body entirely;
  // iris reacts through the field ripple instead, which is the documented
  // split and must not silently change.
  for (const k of ['shell', 'shell v2']) assert.ok(usesBodyPulse(k), `${k} is shell-family and needs the pulse`)
  assert.ok(!usesBodyPulse('iris'), 'iris reacts through the field ripple, not the pulse')
  assert.ok(!usesBodyPulse('streams'), 'streams has its own body')
  // And anything in the list has to be a real look, or the pulse goes nowhere.
  for (const k of BODY_PULSE_LOOKS) assert.ok(LOOKS[k], `${k} is in BODY_PULSE_LOOKS but is not a look`)
})

ok('the ask ring completes its sweep — a ring dying at 62% of the way across reads as slow AND unfinished', () => {
  const a = RIPPLE.ask
  const reach = a.speed * a.life
  // Front-to-back across the sphere is PI radians. A ring that expires short
  // of that never resolves: it reads as working, only slowly.
  assert.ok(reach > Math.PI, `the front reaches ${reach.toFixed(2)} rad in its life, short of the ${Math.PI.toFixed(2)} it needs to cross`)
  assert.ok(Math.PI / a.speed < 8, `a full crossing takes ${(Math.PI / a.speed).toFixed(1)}s — too slow to read as a reaction`)
  assert.ok(a.speed < 1.2, 'but not so fast it becomes a flash rather than a sweep')

  // AND IT MUST NOT GET STUCK HALF WAY. Once the front passes PI it has left
  // the sphere, but th cannot exceed PI — so the gaussian tail parks on the
  // far pole and fades there, leaving the near half normal and the far half
  // still bulged. Simulated against the real rippleRows and the shader's own
  // beat formula, because this is invisible in the preset numbers alone.
  const R = makeRipples()
  askRipple(R, 0, 1)
  const RA = Array.from({ length: RIPPLE_SLOTS }, () => new Float32Array(4))
  const RB = Array.from({ length: RIPPLE_SLOTS }, () => new Float32Array(4))
  let lastVisible = 0, poleStart = null
  for (let t = 0; t <= a.life + 1; t += 0.1) {
    rippleRows(R, t, (v) => v, RA, RB)
    let peak = 0, where = 0
    for (let k = 0; k <= 24; k++) {
      const th = Math.PI * k / 24
      const sg = Math.max(RB[ASK_RIPPLE_SLOT][2], 1e-3)
      const u = (th - RA[ASK_RIPPLE_SLOT][3]) / sg
      const b = RB[ASK_RIPPLE_SLOT][0] * Math.exp(-0.5 * u * u)
      if (b > peak) { peak = b; where = th }
    }
    if (peak > 0.002) lastVisible = t
    if (peak > 0.008 && where > 3.0 && poleStart === null) poleStart = t
  }
  const tail = poleStart === null ? 0 : lastVisible - poleStart
  assert.ok(tail < 0.5, `the ring sits on the far pole for ${tail.toFixed(1)}s after crossing — that is the stuck half-state`)
  // The mechanism: the envelope has to be spent by roughly the time the front
  // clears the sphere. A life much longer than PI/speed is what strands it.
  assert.ok(a.life < 1.5 * (Math.PI / a.speed),
    `life ${a.life}s against a ${(Math.PI / a.speed).toFixed(1)}s crossing leaves the tail stranded on the far side`)
  // It is still the SLOW BIG ring that was asked for, not a snap.
  assert.ok(a.sigma > 0.5, 'and still a broad front')
  assert.ok(a.life > 4, 'and still long-lived')
  // Walkable, so the exact speed stays a live tuning decision.
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  assert.match(src, /setRipple\(key, value\) \{ if \(key in RIPPLE\.ask\)/)
})

ok('no shader template contains a backtick — they are JS template literals, and one in a GLSL comment terminates the string', () => {
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  // Written after doing this three times in one session. A backtick inside a
  // GLSL comment ends the template literal early, and the failure surfaces as
  // a JavaScript SyntaxError pointing at a word in prose — which reads as
  // nonsense and costs minutes every time. A compile check outside the browser
  // is hit even harder: it re-evaluates these literals, so it dies before
  // compiling anything at all.
  const names = [...src.matchAll(/^const ([A-Z_0-9]+) = `/gm)].map((m) => m[1])
  assert.ok(names.length >= 5, `expected several shader templates, found ${names.length}`)
  for (const name of names) {
    const open = src.indexOf('const ' + name + ' = `') + ('const ' + name + ' = `').length
    const close = src.indexOf('\n`', open)
    assert.ok(close > open, `${name} is not closed`)
    const body = src.slice(open, close)
    assert.ok(!body.includes('`'), `${name} contains a backtick — it will terminate the template literal`)
    // Same class: an unescaped ${ that is not a real interpolation would
    // evaluate as one. Every interpolation here should resolve to a value.
    for (const m of body.matchAll(/\$\{([^}]*)\}/g)) {
      assert.ok(m[1].trim().length > 0, `${name} has an empty interpolation`)
    }
  }
})

ok('shell is the body plus the arcs and shell v2 is the body alone — they differ in exactly two uniforms, and both names are selectable', () => {
  assert.equal(DEFAULT_MODE, 'shell')
  assert.equal(LOOKS.shell.uArc, 1, 'shell carries the arcs')
  assert.equal(LOOKS['shell v2'].uArc, 0, 'shell v2 is the body-only look')
  assert.equal(LOOKS.shell.uClusterHide, 1, 'and shell draws no orbiting clusters')
  assert.equal(LOOKS['shell v2'].uClusterHide, 0, 'while shell v2 does')
  // Every BODY uniform is identical: the two are one look plus a gate, never
  // two tunings that can drift apart.
  for (const k of ['uGather', 'uRipLift', 'uRipGlow', 'uAlpha']) {
    assert.equal(LOOKS['shell v2'][k], LOOKS.shell[k], `${k} differs between the two`)
  }
  assert.equal(normalizeMode('shell'), 'shell')
  assert.equal(normalizeMode('shell v2'), 'shell v2', 'a name with a space must be selectable')
  // The label is the raw mode string, so the space has to survive.
  const src = readFileSync(join(ROOT, 'syzygy/bridge/public/swarm.js'), 'utf8')
  assert.match(src, /btn\.textContent = mode/, 'the button shows the mode name verbatim')
})

console.log(`swarm harness: ${n} checks passed`)
