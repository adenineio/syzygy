/* Quick access: the pure half of the command bar's card deck.

   A CLASSIC script with no DOM, no storage and no registration at evaluation
   time, so it can be evaluated standalone under a bare interpreter and still
   hand back a complete MCQA -- the same split voice-math.js, canvas-layout.js
   and swarm-math.js live under. Referenced BARE, never window.MCQA: a classic
   script's top-level const is a lexical global across <script> tags in one
   realm and is NOT a window property.

   DIGITS ARE FIXED BANDS, not a running count. Favourites own 1-4, presets
   5-7, projects 8-9, and the single suggestion owns 0. A band holding fewer
   cards than its slots leaves those digits unbound rather than letting the
   next band slide up: a key whose meaning moves is not quick access, and the
   price of that is a wasted digit now and then. */
'use strict'

const MCQA = (() => {
  const BANDS = Object.freeze([
    Object.freeze({ id: 'favourites', label: 'favourites', slots: Object.freeze([1, 2, 3, 4]) }),
    Object.freeze({ id: 'templates', label: 'presets', slots: Object.freeze([5, 6, 7]) }),
    Object.freeze({ id: 'projects', label: 'projects', slots: Object.freeze([8, 9]) }),
    Object.freeze({ id: 'suggested', label: 'suggested', slots: Object.freeze([10]) }),
  ])

  /** Every duration and distance the bar and its deck move on, in one place, so
   *  the stylesheet and the script can never drift: both halves write these
   *  onto a node as custom properties and read them back.
   *
   *  Grouped by what they belong to rather than by type. The band container
   *  used to rise and tilt flat on arrival; the cards do it themselves now, so
   *  there is no band-level distance here any more, and one swap duration
   *  governs the reply area giving way to the deck AND taking its place back. */
  const MOTION = Object.freeze({
    // the deck
    arriveMs: 140, staggerMs: 30, staggerCap: 4, cardRisePx: 12,
    swapMs: 160, selectMs: 120, forwardPx: 14, commitMs: 90, liftPx: 4,
    hintMs: 90,
    // the bar
    openMs: 180, closeMs: 140, caretMs: 140, sweepMs: 220,
    firstLineMs: 140, firstRisePx: 6, paraMs: 120,
    pinMs: 200, errMs: 120, errBeats: 2, thinkMs: 1600,
  })

  const TAP_MS = 400
  const TAP_HOLD_MS = 250
  const CALM = Object.freeze(['still', 'settle', 'subtle', 'more'])
  const CALM_DEFAULT = 'subtle'
  const CALM_KEY = 'szg.sandbox.calm'

  const arr = (v) => (Array.isArray(v) ? v : [])
  const str = (v) => (typeof v === 'string' ? v : '')

  /** The physical key, never the character: Option plus a digit composes a
   *  different glyph on macOS, so e.key is not the digit. Slot ten is `0`,
   *  which is the one place this differs from the preset strip's own reader --
   *  there are exactly ten bands' worth of slots here and the tenth needs a
   *  key. */
  const digitSlot = (code) => {
    const m = /^Digit([0-9])$/.exec(String(code ?? ''))
    if (!m) return null
    const d = Number(m[1])
    return d === 0 ? 10 : d
  }

  const slotBand = (slot) => BANDS.find((b) => b.slots.includes(slot))?.id ?? null

  const favouriteCards = ({ favourites, sessions, needsOf }, slots) => {
    const byName = new Map()
    for (const s of arr(sessions)) if (s && str(s.name)) if (!byName.has(s.name)) byName.set(s.name, s)
    const rows = arr(favourites)
      .filter((f) => f && str(f.name))
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, slots.length)
    return rows.map((f, i) => {
      const s = byName.get(f.name) ?? null
      const need = s && typeof needsOf === 'function' ? str(needsOf(s)) : ''
      return {
        kind: 'favourite', slot: slots[i], key: 'fav:' + f.name,
        id: s ? s.id : null, title: f.name,
        meta: s ? (need || str(s.status) || 'running') : 'not running',
        color: str(f.color), live: !!s, path: '', jump: s ? str(s.jump) : '',
        tip: s ? f.name + '\nopen the drawer · shift jumps to its terminal · cmd rings it on the canvas'
               : f.name + '\nnot running right now',
      }
    })
  }

  const templateCards = ({ templates }, slots) => arr(templates)
    .filter((t) => t && str(t.id))
    .slice()
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
    .slice(0, slots.length)
    .map((t, i) => ({
      kind: 'template', slot: slots[i], key: 'tpl:' + t.id, id: t.id,
      title: str(t.name) || t.id,
      meta: [str(t.model), str(t.effort)].filter(Boolean).join(' · ') || 'prompt only',
      color: '', live: true, path: '', jump: '',
      tip: (str(t.name) || t.id) + '\napply in Dispatch · shift fills only empty fields · cmd queues it',
    }))

  const projectCards = ({ badges }, slots) => arr(badges)
    .filter((b) => b && str(b.key))
    .slice(0, slots.length)
    .map((b, i) => ({
      kind: 'project', slot: slots[i], key: 'prj:' + b.key, id: b.key,
      title: str(b.name) || b.key,
      meta: b.live ? 'live' : str(b.path),
      color: '', live: !!b.live, path: str(b.path), jump: '',
      tip: str(b.path) + '\nscope the next ask · shift opens Projects · cmd copies the path',
    }))

  /** One slot, and the ranking is a rule rather than a score: a session
   *  waiting on a person is blocked right now, which outranks a write-up
   *  nobody is waiting on. Oldest first in both cases. */
  const suggestion = (input) => {
    const needsOf = typeof input?.needsOf === 'function' ? input.needsOf : () => ''
    const waiting = arr(input?.sessions)
      .filter((s) => s && str(needsOf(s)))
      .slice()
      .sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0))
    if (waiting.length) {
      const s = waiting[0]
      return {
        kind: 'needs', slot: 10, key: 'needs:' + s.id, id: s.id,
        title: str(s.name) || str(s.repo) || String(s.id).slice(0, 8),
        meta: str(needsOf(s)), color: str(s.color), live: true, path: '', jump: str(s.jump),
        tip: 'waiting on you\nopen the drawer with the reply field focused',
      }
    }
    const open = arr(input?.proposals)
      .filter((p) => p && str(p.id) && str(p.mark) === '' && (p.requestId ?? null) === null)
      .slice()
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
    if (!open.length) return null
    const p = open[0]
    return {
      kind: 'proposal', slot: 10, key: 'prop:' + p.id, id: p.id,
      title: str(p.title) || p.id, meta: str(p.kind) || 'unclassified',
      color: '', live: true, path: '', jump: '',
      tip: 'an unrated candidate\nopen the proposals panel in Dispatch',
    }
  }

  const deck = (input) => {
    const bands = []
    const bySlot = {}
    for (const band of BANDS) {
      let cards = []
      if (band.id === 'favourites') cards = favouriteCards(input ?? {}, band.slots)
      else if (band.id === 'templates') cards = templateCards(input ?? {}, band.slots)
      else if (band.id === 'projects') cards = projectCards(input ?? {}, band.slots)
      else { const one = suggestion(input ?? {}); cards = one ? [one] : [] }
      if (!cards.length) continue
      for (const c of cards) bySlot[c.slot] = c
      bands.push({ id: band.id, label: band.label, cards })
    }
    return { bands, bySlot, count: Object.keys(bySlot).length }
  }

  /** What a press does, as a description rather than as a side effect -- so
   *  the whole table is checkable without a DOM, and cmdbar.js holds exactly
   *  one switch over `do`. `null` means the card has nothing for the modifiers
   *  held, which the hint line says out loud. */
  const actionFor = (card, mods) => {
    const shift = !!mods?.shift
    const cmd = !!mods?.cmd
    if (!card) return null
    if (shift && cmd) return null
    switch (card.kind) {
      case 'favourite':
        if (!card.live) return shift || cmd ? null : { do: 'toast', text: card.title + ' is not running' }
        if (shift) return card.jump === 'outside' ? null : { do: 'jump', id: card.id }
        if (cmd) return { do: 'ring', id: card.id }
        return { do: 'drawer', id: card.id }
      case 'template':
        if (shift) return { do: 'template', id: card.id, mode: 'fill-empty', submit: false }
        if (cmd) return { do: 'template', id: card.id, mode: 'overwrite', submit: true }
        return { do: 'template', id: card.id, mode: 'overwrite', submit: false }
      case 'project':
        if (shift) return { do: 'tab', view: 'projects' }
        if (cmd) return card.path ? { do: 'copy', text: card.path } : null
        return { do: 'scope', key: card.id, name: card.title }
      case 'needs':
        return shift || cmd ? null : { do: 'drawer', id: card.id, reply: true }
      case 'proposal':
        return shift || cmd ? null : { do: 'tab', view: 'dispatch', focus: 'skills-panel' }
      default:
        return null
    }
  }

  /** The double tap that latches the mode, read off Option's own keydown and
   *  keyup so no composed character is ever involved. A tap is a press and a
   *  release inside TAP_HOLD_MS; two taps inside TAP_MS latch. A hold, losing
   *  the window, or any other key -- during a press or between two taps --
   *  clears the pending tap, which is what stops a held Option used for
   *  anything else from arming this by accident. */
  // `pressed` and `released` are booleans beside the two timestamps, never
  // inferred from them: a timestamp of 0 is a real reading (the first event of
  // a freshly loaded page) and testing `down > 0` would silently refuse it.
  const FRESH = Object.freeze({ down: 0, pressed: false, lastUp: 0, released: false })
  const tapStep = (state, ev) => {
    const s = state ?? FRESH
    const at = Number(ev?.at) || 0
    if (ev?.type === 'blur') return { state: FRESH, latch: false }
    if (ev?.type === 'keydown') {
      if (ev.key !== 'Alt') return { state: FRESH, latch: false }
      if (s.pressed) return { state: s, latch: false }   // key repeat, not a second press
      return { state: { ...s, down: at, pressed: true }, latch: false }
    }
    if (ev?.type !== 'keyup' || ev.key !== 'Alt') return { state: s, latch: false }
    const tapped = s.pressed && at - s.down <= TAP_HOLD_MS
    if (!tapped) return { state: FRESH, latch: false }
    if (s.released && at - s.lastUp <= TAP_MS) return { state: FRESH, latch: true }
    return { state: { down: 0, pressed: false, lastUp: at, released: true }, latch: false }
  }

  /** The sandbox tab's calm dial, read through its own key with the storage
   *  reader injected: an unknown name, a reader that throws (a private window,
   *  blocked site data) and an absent key all mean the dial's own default,
   *  never a special case. */
  const calmName = (read) => {
    try {
      const v = typeof read === 'function' ? read(CALM_KEY) : null
      return CALM.includes(v) ? v : CALM_DEFAULT
    } catch (e) { return CALM_DEFAULT }
  }

  /** The mark's own rectangle expressed as insets from the panel's four edges,
   *  which is the shape the bar's clip grows out of and shrinks back into.
   *  Every inset is clamped at zero: a mark measured outside its own panel is
   *  not a shape to interpolate toward, and a negative inset would expand the
   *  clip instead of shrinking it. A degenerate box -- either one measured
   *  before layout, or a hidden node -- means no grow at all rather than NaN,
   *  which the caller reads as "show it at once". */
  const growInsets = (panel, mark) => {
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
    const zero = { top: 0, right: 0, bottom: 0, left: 0 }
    if (num(panel?.width) <= 0 || num(panel?.height) <= 0) return zero
    if (num(mark?.width) <= 0 || num(mark?.height) <= 0) return zero
    const px = (v) => Math.round(Math.max(0, v) * 100) / 100
    return {
      top: px(num(mark.top) - num(panel.top)),
      right: px(num(panel.right) - num(mark.right)),
      bottom: px(num(panel.bottom) - num(mark.bottom)),
      left: px(num(mark.left) - num(panel.left)),
    }
  }

  /** A reply's paragraphs, for the transcript's per-paragraph fade. A run of
   *  blank lines is ONE break, because the gap between two paragraphs is a
   *  margin and a longer separator has nothing to be rendered with; a single
   *  newline stays inside its paragraph, which pre-wrap already draws. The
   *  blank-line pattern allows trailing spaces on the blank lines but never
   *  eats the NEXT line's indentation, which would flatten an indented block.
   *  An empty answer is no paragraphs at all rather than one empty one. */
  const paragraphs = (text) => String(text ?? '')
    .split(/\n(?:[ \t]*\n)+/)
    .map((p) => p.replace(/\s+$/, ''))
    .filter((p) => p.length > 0)

  /** How far a row's item has to start from for its move to read as a move.
   *  `prev` is null for an item with no previous position -- new, or scrolled
   *  outside a row that scrolls -- and such an item comes in from the row's own
   *  near edge; a previous position outside the row is clamped to that edge
   *  too, so a chip always arrives from the bar's edge rather than from far
   *  off-screen. An unmeasurable row leaves the previous position alone, and an
   *  unmeasurable destination moves nothing. */
  const flipDx = (prev, next, hostLeft, hostRight) => {
    const to = Number(next)
    if (!Number.isFinite(to)) return 0
    const lo = Number(hostLeft)
    const hi = Number(hostRight)
    const bounded = Number.isFinite(lo) && Number.isFinite(hi) && hi > lo
    const had = Number.isFinite(Number(prev))
    const from = had ? Number(prev) : (bounded ? lo : to)
    const start = bounded ? Math.min(Math.max(from, lo), hi) : from
    return Math.round((start - to) * 100) / 100
  }

  const stillNow = (name, reduced) => !!reduced || name === 'still'

  /** Whether a turn is still waiting on its first visible content: sent and
   *  streaming, with nothing shown yet. Recomputed on every render, so
   *  there is no separate timer to cancel once real text arrives -- the
   *  shimmer this drives on the question line simply stops being true. */
  const isThinking = (streaming, shownText) =>
    !!streaming && String(shownText ?? '').trim().length === 0

  return {
    BANDS, MOTION, TAP_MS, TAP_HOLD_MS, CALM_KEY,
    digitSlot, slotBand, deck, suggestion, actionFor, tapStep, calmName, stillNow,
    growInsets, paragraphs, flipDx, isThinking,
  }
})()
