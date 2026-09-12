/* Syzygy -- the Dispatch tab's project badges.
   A CLASSIC script like canvas-layout.js and reconcile.js: it assigns one
   global, MCB, touches no DOM at load, and is evaluated under node by
   test/dispatch-harness.mjs through `new Function`. Load it BEFORE dispatch.js
   in index.html.

   A badge is a PROJECT, not a path. Every candidate -- a live session's root,
   then an entry in canvas.recents -- is resolved through the scanner's
   projects[] and collapsed onto the owning project's mainRoot. Two reasons,
   and the second is correctness, not taste:

     - a busy repo can carry a dozen worktrees at once, and a badge each makes
       a wall rather than a picker;
     - dispatch.mjs runs `git worktree add` in the project root it is handed,
       and the main root is where that belongs.

   A candidate belonging to no known project is DROPPED, never shown as a bare
   path: the scanner not knowing it means the dispatcher cannot branch in it
   either, so the badge would be an offer the tab cannot honour. The empty
   state names the two sources instead, so an empty row reads as "nothing seen
   yet" rather than as a broken feature. */
'use strict'

const MCB = (() => {
  const DEFAULT_LIMIT = 8

  const str = (v) => (typeof v === 'string' && v ? v : null)

  /** path -> project, by exact worktree path and by the project key/mainRoot.
   *  Exact paths only: a prefix test would claim `/repo-two` for `/repo`. */
  const indexProjects = (projects) => {
    const byPath = new Map()
    for (const p of Array.isArray(projects) ? projects : []) {
      if (!p || typeof p !== 'object') continue
      const path = str(p.mainRoot) ?? str(p.key)
      if (!path) continue
      const badge = { key: str(p.key) ?? path, name: str(p.name) ?? path.split('/').filter(Boolean).pop() ?? path, path, live: false }
      for (const w of Array.isArray(p.worktrees) ? p.worktrees : []) {
        const wp = str(w && w.path)
        if (wp && !byPath.has(wp)) byPath.set(wp, badge)
      }
      if (!byPath.has(path)) byPath.set(path, badge)
      const key = str(p.key)
      if (key && !byPath.has(key)) byPath.set(key, badge)
    }
    return byPath
  }

  /** Live session roots first (marked live), then recents in their own order.
   *  Returns a NEW array of NEW objects every call: the badge carries `live`,
   *  which is a property of this render and not of the project. */
  const projectBadges = ({ projects, sessions, recents, limit = DEFAULT_LIMIT } = {}) => {
    const byPath = indexProjects(projects)
    const out = []
    const seen = new Map()

    const take = (path, live) => {
      const hit = byPath.get(path)
      if (!hit) return
      const already = seen.get(hit.key)
      if (already) { if (live) already.live = true; return }
      const badge = { key: hit.key, name: hit.name, path: hit.path, live: !!live }
      seen.set(hit.key, badge)
      out.push(badge)
    }

    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (!s || typeof s !== 'object') continue
      take(str(s.root) ?? str(s.cwd), true)
    }
    for (const c of Array.isArray(recents) ? recents : []) take(str(c), false)

    const n = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT
    return out.slice(0, n)
  }

  return { projectBadges, DEFAULT_LIMIT }
})()

if (typeof window !== 'undefined') window.MCB = MCB
