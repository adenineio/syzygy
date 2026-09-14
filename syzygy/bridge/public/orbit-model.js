/* Syzygy -- the orbit data model: the board's live state folded into one core
   and one body per project, for a 3D view to render. Nothing here renders.

   A CLASSIC script like canvas-layout.js and dispatch-badges.js: it assigns
   one global, MCO, touches no DOM at load, and is evaluated under node by
   test/orbit-harness.mjs through `new Function`.

   A body is a PROJECT, not a worktree and not a path. A busy repo carries a
   dozen worktrees at once and a body each would be a wall rather than a
   system. The fold is the relay scanner's own -- every published worktree
   already lists the sessions bound to it by longest-prefix containment -- so a
   session sitting in a subdirectory is not lost, which an exact path match
   loses. A session no project claims lands on the unbound body rather than
   being dropped: the live count and the bodies have to agree.

   Pure. Everything that must persist between frames -- the token-rate window
   and the slot table -- goes in as an argument and comes back out in the
   result, so two callers on one page cannot hold diverging copies. */
'use strict'

const MCO = (() => {
  const VERSION = 1
  const UNBOUND = '~unbound'
  const MAX_BODIES = 12
  const SESSIONS_FULL = 6
  const SLOT_HOLD_MS = 90_000
  const SAMPLE_CAP = 32
  const MIN_SPAN_MS = 2_000
  const ACTIVITY = { windowMs: 24_000, r0: 10, rmax: 150 }
  const ERROR_WINDOW = 14
  const ERROR_COUNT = 3
  const STATES = ['waiting', 'error', 'working', 'idle']
  const LENSES = ['sessions', 'tokens', 'needs']

  // A deliberate mirror of the presence swarm's table, which is an ES module
  // and so unreachable from a classic script. The harness pins every hex
  // against that file's real source: two copies are two things that can drift.
  const STATE_ACCENT = { idle: '#a8e8ff', working: '#e0973c', waiting: '#f4b45c', error: '#ff5670' }
  const STATE_HOT = '#f4b45c'

  const TAU = Math.PI * 2

  // The camera bound the presence panel draws inside, RECORDED rather than
  // imported: that module's exports are unreachable from a classic script.
  // The harness re-derives both numbers from its real source and fails on
  // drift, so recording them is not the same as letting them rot.
  const SPHERE_VISIBLE_HALF_HEIGHT = 1.2245869835682874
  const SPHERE_ORBIT_CAP = 1.1795869835682875

  // Three rings, four inclinations and the golden angle, so no two bodies
  // share a phase and the set reads as a system rather than a row. Radius is
  // NORMALIZED: a renderer scales it by whatever radial budget it has, and
  // SPHERE_ORBIT_CAP is that budget for one drawing in the panel's units.
  const ORBIT = {
    rings: 3, base: 0.42, gap: 0.19,
    inclinations: 4, inclStep: 0.42, inclBias: -0.63,
    golden: 2.399963229728653,
  }
  // Where the unbound body sits: the cap exactly, flat and unphased, so it
  // reads as a distant halo rather than as another planet.
  const HALO_ORBIT = { radius: 1, inclination: 0, phase: 0 }

  const str = (v) => (typeof v === 'string' && v ? v : null)
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const arr = (v) => (Array.isArray(v) ? v : [])
  const clamp01 = (v) => Math.max(0, Math.min(1, v))

  /** What a session is asking a person for, or ''. The relay's own
   *  observation outranks the plugin's inference: one is a fact about a
   *  prompt on screen, the other a reading of what a turn said. */
  const needsOf = (s) => (s && s.waiting ? (s.waitingFor || 'waiting for input') : ((s && s.needs) || ''))

  /** Per session id: how many of ITS last `window` events carry status
   *  'error'. One backward pass; events without a sessionId are ignored. */
  const recentErrorsById = (events, window = ERROR_WINDOW) => {
    const seen = new Map(), out = new Map()
    const list = arr(events)
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]
      if (!e || e.sessionId == null) continue
      const id = String(e.sessionId)
      const n = seen.get(id) ?? 0
      if (n >= window) continue
      seen.set(id, n + 1)
      if (e.status === 'error') out.set(id, (out.get(id) ?? 0) + 1)
    }
    return out
  }

  /** waiting > error > working > idle. An observation outranks a count. */
  const sessionState = (s, errorCount = 0) => {
    if (!s) return 'idle'
    if (needsOf(s)) return 'waiting'
    if (errorCount >= ERROR_COUNT) return 'error'
    return s.working ? 'working' : 'idle'
  }

  /** projectKey -> the body's identity, and sessionId -> the project that
   *  claims it, both read from the scanner's fold. The first project to claim
   *  an id keeps it, so a session that somehow appears under two projects is
   *  counted once. */
  const indexProjects = (projects) => {
    const byKey = new Map()
    const ownerOf = new Map()
    for (const p of arr(projects)) {
      if (!p || typeof p !== 'object') continue
      const key = str(p.key)
      if (!key || byKey.has(key)) continue
      const worktrees = arr(p.worktrees)
      byKey.set(key, {
        key,
        name: str(p.name) ?? key,
        mainRoot: str(p.mainRoot),
        worktreeCount: worktrees.length,
      })
      for (const w of worktrees) {
        if (!w || typeof w !== 'object') continue
        for (const s of arr(w.sessions)) {
          const id = str(s && s.id)
          if (id && !ownerOf.has(id)) ownerOf.set(id, key)
        }
      }
    }
    return { byKey, ownerOf }
  }

  /** The counts, the dominant state and the colour intent for one set. The
   *  four exclusive buckets sum to `total`; `waiting` and `needs` are the two
   *  underlying signals, reported beside it because they fail differently. */
  const measure = (sessions, errorsById, accentOf) => {
    const counts = { total: 0, working: 0, waiting: 0, needs: 0, needsAny: 0, error: 0, idle: 0 }
    for (const s of sessions) {
      counts.total++
      if (s.waiting) counts.waiting++
      if (str(s.needs)) counts.needs++
      const st = sessionState(s, errorsById.get(String(s.id)) ?? 0)
      counts[st === 'waiting' ? 'needsAny' : st]++
    }
    const state = counts.needsAny ? 'waiting' : counts.error ? 'error' : counts.working ? 'working' : 'idle'
    return { counts, state, color: accentOf(state), colorHot: STATE_HOT }
  }

  const defaultAccent = (state) => STATE_ACCENT[state] ?? STATE_ACCENT.idle

  /** Deterministic in the slot, so a body keeps its orbit across frames. */
  const bodyOrbit = (slot) => {
    const i = Number.isInteger(slot) && slot >= 0 ? slot : 0
    return {
      radius: ORBIT.base + (i % ORBIT.rings) * ORBIT.gap,
      inclination: (i % ORBIT.inclinations) * ORBIT.inclStep + ORBIT.inclBias,
      phase: (i * ORBIT.golden) % TAU,
    }
  }

  /** projectKey -> its position in the canvas's recents, so a project just
   *  touched ranks inner. EXACT path equality only, against the project key,
   *  its main root and each worktree path: a prefix test would claim
   *  `/repo-two` for `/repo`, and an unmatched path simply gives no boost. */
  const recentRank = (canvas, projects) => {
    const owner = new Map()
    for (const p of arr(projects)) {
      const key = str(p && p.key)
      if (!key) continue
      for (const v of [key, str(p.mainRoot)]) if (v && !owner.has(v)) owner.set(v, key)
      for (const w of arr(p.worktrees)) {
        const wp = str(w && w.path)
        if (wp && !owner.has(wp)) owner.set(wp, key)
      }
    }
    const rank = new Map()
    const list = arr(canvas && canvas.recents)
    for (let i = 0; i < list.length; i++) {
      const k = owner.get(str(list[i]))
      if (k && !rank.has(k)) rank.set(k, i)
    }
    return rank
  }

  /** The slot table, carried across frames.
   *
   *  A project present this frame KEEPS the slot it holds, unconditionally --
   *  that is the whole point, and it is why an unrelated project or session
   *  coming or going can never move a body that is still there. A newcomer
   *  takes the lowest integer no present project holds and no recently absent
   *  project still holds; an absent project's slot is held for SLOT_HOLD_MS,
   *  matching how long the board keeps a session it has stopped hearing from,
   *  so a blink cannot reshuffle the sky. Newcomers are ordered by recency
   *  then by key, so a cold start and a reload agree. */
  const assignSlots = (prev, presentKeys, rank, now) => {
    const present = new Set(arr(presentKeys).filter((k) => str(k)))
    const next = new Map()
    const held = new Set()
    const table = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}
    for (const key of Object.keys(table)) {
      const rec = table[key]
      const slot = num(rec && rec.slot)
      if (slot === null || !Number.isInteger(slot) || slot < 0) continue
      if (present.has(key)) { next.set(key, { slot, seenAt: now }); held.add(slot); continue }
      const seenAt = num(rec && rec.seenAt) ?? 0
      if (now - seenAt < SLOT_HOLD_MS) { next.set(key, { slot, seenAt }); held.add(slot) }
    }
    const rankOf = (k) => (rank && rank.get && rank.has(k) ? rank.get(k) : Number.MAX_SAFE_INTEGER)
    const newcomers = [...present].filter((k) => !next.has(k))
      .sort((a, b) => rankOf(a) - rankOf(b) || (a < b ? -1 : a > b ? 1 : 0))
    for (const key of newcomers) {
      let slot = 0
      while (held.has(slot)) slot++
      held.add(slot)
      next.set(key, { slot, seenAt: now })
    }
    const out = {}
    for (const [k, v] of next) out[k] = v
    return out
  }

  /** The token-rate window, carried across frames: one ring of readings per
   *  live session, trimmed to the window and to the live set.
   *
   *  A reading is taken every frame even when the counter has not moved --
   *  pushing only on a change would leave the last two changed readings in
   *  the window forever and report a session that stopped talking as still
   *  producing. A counter that goes DOWN is a reset, not a negative rate: a
   *  restarted relay or an id a restarted terminal reused. The history goes
   *  with it rather than becoming one enormous spike. */
  const nextSamples = (prev, sessions, now) => {
    const out = {}
    const old = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}
    for (const s of arr(sessions)) {
      const id = str(s && s.id)
      if (!id) continue
      const tok = num(s.stats && s.stats.outTok)
      let ring = arr(old[id]).filter((p) => p && num(p.t) !== null && num(p.outTok) !== null
        && p.t <= now && now - p.t <= ACTIVITY.windowMs)
      if (tok === null) { if (ring.length) out[id] = ring; continue }
      const last = ring[ring.length - 1]
      if (last && tok < last.outTok) ring = []
      const tail = ring[ring.length - 1]
      if (!tail || tail.t !== now) ring = [...ring, { t: now, outTok: tok }]
      out[id] = ring.slice(-SAMPLE_CAP)
    }
    return out
  }

  /** Output tokens per second across a ring, or 0 when it cannot be known. */
  const rateOf = (ring) => {
    const list = arr(ring)
    if (list.length < 2) return 0
    const a = list[0], b = list[list.length - 1]
    const span = b.t - a.t
    if (span < MIN_SPAN_MS) return 0
    const d = b.outTok - a.outTok
    return d > 0 ? d / (span / 1000) : 0
  }

  // The presence swarm's own log curve, with its thresholds converted from
  // tokens per minute to tokens per second, so a body and a session band at
  // one real rate read the same brightness. Pinned against that file by the
  // harness rather than trusted to stay in step.
  const burn = (rate) =>
    clamp01(Math.log2(1 + Math.max(0, num(rate) ?? 0) / ACTIVITY.r0) / Math.log2(1 + ACTIVITY.rmax / ACTIVITY.r0))

  /** An unknown name is the first lens, through this branch and no other --
   *  a stored preference for a lens that no longer exists needs no migration
   *  code, and must not grow any. */
  const resolveLens = (lens) => (LENSES.indexOf(lens) >= 0 ? lens : LENSES[0])

  const magnitudeOf = (lens, body) =>
    lens === 'tokens' ? body.activity
    : lens === 'needs' ? (body.counts.total ? body.counts.needsAny / body.counts.total : 0)
    : clamp01(body.counts.total / SESSIONS_FULL)

  /** The orchestrator at the centre: whether it is thinking, how long since
   *  it last said anything, and how many sessions are alive around it. A
   *  blurb age of null means it has never spoken -- an age measured from zero
   *  would be a confident wrong answer in the tens of thousands of hours. */
  const coreOf = (orch, live, bodies, overflow, lens, focus, now) => {
    const o = orch && typeof orch === 'object' ? orch : {}
    const busy = !!o.busy
    const asking = !!o.asking
    const blurbAt = num(o.blurbAt) ?? 0
    return {
      state: asking ? 'asking' : busy ? 'busy' : 'idle',
      busy,
      asking,
      blurbAgeMs: blurbAt > 0 ? Math.max(0, now - blurbAt) : null,
      live,
      bodies: bodies.length,
      overflow,
      lens,
      focus,
    }
  }

  /** One frame. Everything a renderer needs and nothing it has to derive.
   *  `samples` and `slots` come back out: hand them straight back next frame
   *  and the rates and the orbits stay continuous. */
  const projectBodies = (input) => {
    const inp = input && typeof input === 'object' ? input : {}
    const now = num(inp.now) ?? Date.now()
    const live = arr(inp.sessions).filter((s) => s && typeof s === 'object' && str(s.id))
    const lens = resolveLens(inp.lens)
    const samples = nextSamples(inp.samples, live, now)
    const byId = new Map(live.map((s) => [String(s.id), s]))
    const folded = foldBodies({
      sessions: live, projects: inp.projects, events: inp.events, accentOf: inp.accentOf,
    })
    const slots = assignSlots(
      inp.slots,
      folded.filter((b) => !b.unbound).map((b) => b.key),
      recentRank(inp.canvas, inp.projects),
      now,
    )

    const built = []
    for (const b of folded) {
      let rate = 0
      let tokensAvailable = false
      for (const id of b.sessionIds) {
        if (num(byId.get(id) && byId.get(id).stats && byId.get(id).stats.outTok) !== null) tokensAvailable = true
        rate += rateOf(samples[id])
      }
      const slot = b.unbound ? null : (slots[b.key] ? slots[b.key].slot : null)
      const body = {
        ...b,
        slot,
        orbit: slot === null ? { ...HALO_ORBIT } : bodyOrbit(slot),
        activity: burn(rate),
        rate,
        tokensAvailable,
        magnitude: 0,
        focused: false,
      }
      body.magnitude = magnitudeOf(lens, body)
      built.push(body)
    }

    const planets = built.filter((b) => !b.unbound).sort((a, b) => a.slot - b.slot)
    const halo = built.filter((b) => b.unbound)
    const overflow = Math.max(0, planets.length - MAX_BODIES)
    const bodies = [...planets.slice(0, MAX_BODIES), ...halo]

    const asked = str(inp.focus)
    const focus = asked && bodies.some((b) => b.key === asked) ? asked : null
    for (const b of bodies) b.focused = focus !== null && b.key === focus

    return {
      version: VERSION,
      core: coreOf(inp.orchestrator, live.length, bodies, overflow, lens, focus, now),
      bodies,
      samples,
      slots,
    }
  }

  /** One body per project, plus the unbound body when anything needs it.
   *  A body's sessions keep the payload's own order, oldest first, whichever
   *  worktree each sits in. Slots, orbits and activity are added by
   *  projectBodies. */
  const foldBodies = ({ sessions, projects, events, accentOf = defaultAccent } = {}) => {
    const live = arr(sessions).filter((s) => s && typeof s === 'object' && str(s.id))
    const errorsById = recentErrorsById(events)
    const { byKey, ownerOf } = indexProjects(projects)
    const accent = typeof accentOf === 'function' ? accentOf : defaultAccent

    const out = []
    for (const p of byKey.values()) {
      const mine = live.filter((s) => ownerOf.get(String(s.id)) === p.key)
      out.push({
        key: p.key, name: p.name, mainRoot: p.mainRoot, unbound: false,
        worktreeCount: p.worktreeCount,
        sessionIds: mine.map((s) => String(s.id)),
        ...measure(mine, errorsById, accent),
      })
    }
    const loose = live.filter((s) => !ownerOf.has(String(s.id)))
    if (loose.length) {
      out.push({
        key: UNBOUND, name: 'unbound', mainRoot: null, unbound: true,
        worktreeCount: 0,
        sessionIds: loose.map((s) => String(s.id)),
        ...measure(loose, errorsById, accent),
      })
    }
    return out
  }

  return {
    VERSION, UNBOUND, MAX_BODIES, SESSIONS_FULL, SLOT_HOLD_MS, SAMPLE_CAP,
    MIN_SPAN_MS, ACTIVITY, ERROR_WINDOW, ERROR_COUNT, STATES, LENSES,
    STATE_ACCENT, STATE_HOT, ORBIT, SPHERE_VISIBLE_HALF_HEIGHT,
    SPHERE_ORBIT_CAP, HALO_ORBIT,
    needsOf, recentErrorsById, sessionState, foldBodies,
    bodyOrbit, recentRank, assignSlots,
    nextSamples, rateOf, burn, resolveLens, projectBodies,
  }
})()

if (typeof window !== 'undefined') window.MCO = MCO
