/* Syzygy -- the session canvas's PURE helpers: the reset layout, the plus
   gutter's rectangle, what a modifier held at drop means, and the name to
   suggest for a session spawned from a node.
   A CLASSIC script, like reconcile.js: it assigns one global, MCL, touches no
   DOM at load, and is evaluated under node by test/canvas-harness.mjs through
   `new Function`. It is split out of canvas.js for the same reason
   swarm-math.js is split out of swarm.js -- the part worth asserting is
   separable, so separate it and assert it.

   "Reset view" restores every node to a layout derived from the
   switchboard's grouping, so a reset means something the reader already
   recognises. The grouping is app.js's tmuxGroups(), restated here because
   app.js's scope is not reachable from a sibling script: group by the tmux
   session a session reports, first-seen order, the bucket of sessions not in
   tmux last -- and one flat bucket when nobody is in tmux at all.

   It is a PURE function of the session set and the stage width. Sessions are
   sorted by startedAt (then id) inside, so the order they happened to arrive
   in cannot change the result. */
'use strict'

const MCL = (() => {
  const NODE_W = 232, NODE_H = 126, GAP = 14, PAD = 16, GROUP_GAP = 30
  const NONE = 'none'
  const FALLBACK_COLS = 4

  const groupKey = (s) => (s.tmux ? 't:' + s.tmux : NONE)

  const ordered = (sessions) => (sessions || []).slice().sort((a, b) =>
    ((a.startedAt ?? 0) - (b.startedAt ?? 0)) || String(a.id).localeCompare(String(b.id)))

  const groupsOf = (sessions) => {
    const list = ordered(sessions)
    if (!list.some((s) => s.tmux)) return [{ key: NONE, label: 'not in tmux', sessions: list }]
    const order = [], by = new Map()
    for (const s of list) {
      const k = groupKey(s)
      if (!by.has(k)) { by.set(k, []); order.push(k) }
      by.get(k).push(s)
    }
    // Stable, so everything but the bucket keeps first-seen order.
    order.sort((a, b) => (a === NONE ? 1 : 0) - (b === NONE ? 1 : 0))
    return order.map((k) => ({ key: k, label: k === NONE ? 'not in tmux' : k.slice(2), sessions: by.get(k) }))
  }

  const defaultLayout = (sessions, { width = 0 } = {}) => {
    const cols = width > 0 ? Math.max(1, Math.floor((width - 2 * PAD + GAP) / (NODE_W + GAP))) : FALLBACK_COLS
    const out = {}
    let y = PAD
    for (const g of groupsOf(sessions)) {
      g.sessions.forEach((s, i) => {
        out[s.id] = { x: PAD + (i % cols) * (NODE_W + GAP), y: y + Math.floor(i / cols) * (NODE_H + GAP) }
      })
      y += Math.ceil(g.sessions.length / cols) * (NODE_H + GAP) + GROUP_GAP
    }
    return out
  }

  // ---- the plus gutter -------------------------------------------------------
  // Wide enough for a legend at 8.5px and still obviously a gutter rather than
  // a panel. A third of a node's width.
  const PLUS_W = 92

  /** The gutter's box: the right-hand strip of the stage's VISIBLE band, full
   *  band height, in the stage's SCROLLED coordinates -- an absolutely
   *  positioned child of a scroll container scrolls with its content, so the
   *  left edge is scrollLeft + clientWidth - width and not just clientWidth.
   *  The spawn form's clamp already speaks this space; this is the same
   *  arithmetic, named. */
  const plusRect = ({ scrollLeft = 0, scrollTop = 0, clientWidth = 0, clientHeight = 0, width = PLUS_W } = {}) => {
    const w = Math.min(width, clientWidth)
    return {
      left: Math.round(scrollLeft + clientWidth - w),
      top: Math.round(scrollTop),
      width: Math.round(w),
      height: Math.round(clientHeight),
    }
  }

  /** What was held when the wire was dropped. TWO INDEPENDENT FLAGS, not a
   *  three-way mode: shift inherits the source's model and effort, alt
   *  sends no brief, and holding both does both -- so there is no
   *  precedence rule for anyone to remember or for this to get wrong. */
  const dropMode = ({ shiftKey = false, altKey = false } = {}) => ({ inherit: !!shiftKey, brief: !altKey })

  /** A free name near the source's. Load-bearing rather than polite: a parked
   *  link is matched at /api/register by NAME, and two sessions wearing one
   *  name is exactly the case that refuses to link at all. An existing numeric
   *  suffix is treated as part of the base, so alpha-2 suggests alpha-3 rather
   *  than alpha-2-2. */
  const suggestName = (base, taken = []) => {
    const b = String(base || '').replace(/-\d+$/, '').trim() || 'session'
    const used = new Set((taken || []).filter((n) => typeof n === 'string'))
    if (!used.has(b)) return b
    for (let i = 2; i < 500; i++) { const n = b + '-' + i; if (!used.has(n)) return n }
    return b + '-' + Date.now()
  }

  /** Which of the spawn form's model options a session's reported model is.
   *  An exact option wins; otherwise the label's FAMILY -- its leading letters,
   *  after an optional `claude-` -- when the form offers it. Sessions report a
   *  display label (hud.tsx's shortModel: "opus 5", "fable 5.1") while the form
   *  offers bare aliases, so without this ⇧ could never carry a model over from
   *  a session the canvas did not start. The alias names the family's current
   *  model rather than the exact version, which is what the form can express.
   *  Anything unrecognised is '' -- assigning an absent value empties a select. */
  const modelOption = (label, values = []) => {
    const v = String(label ?? '').trim()
    if (!v) return ''
    const opts = [...(values || [])]
    if (opts.includes(v)) return v
    const m = /^(?:claude-)?([a-z]+)/i.exec(v)
    const family = m ? m[1].toLowerCase() : ''
    return opts.includes(family) ? family : ''
  }

  return { NODE_W, NODE_H, GAP, PAD, GROUP_GAP, PLUS_W, groupsOf, defaultLayout, plusRect, dropMode, suggestName, modelOption }
})()
