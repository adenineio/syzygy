/* Syzygy -- the session canvas's reset layout.
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

  return { NODE_W, NODE_H, GAP, PAD, GROUP_GAP, groupsOf, defaultLayout }
})()
