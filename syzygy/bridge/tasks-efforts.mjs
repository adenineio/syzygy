// Folds a project's worktrees into distinct EFFORTS.
//
// A worktree branches from HEAD and inherits every committed plan, so the same
// plan exists in every worktree and a per-worktree count reports one effort
// once per worktree, so a busy project's glance can read three or four times
// the real number, every extra a copy nobody has touched.
//
// Worse, a project can carry the same plan under both docs/plans/ and the
// older docs/superpowers/plans/ layout, and item ids include the file path --
// so a ticked copy at one path and a stale copy at the other are, to
// labelItems, two unrelated plans with no items in common: one plan could read
// fully done and not started at once. That is why identity here is the plan's
// BASENAME and not its `rel`, and why this does not reuse the `diff` labels:
// they are keyed by path and cannot see across the two layouts.
//
// Within one worktree a basename must be unique. A collision there is either a
// half-finished move or two genuinely different plans, and both need a human --
// so it is REPORTED, never silently merged, the same rule the CAPS follow.
// scripts/plan-names.mjs fails the build for it.
//
// Pure: no I/O.

const base = (rel) => rel.slice(rel.lastIndexOf('/') + 1)

const progress = (p) => ({ done: p.done ?? 0, reported: p.reported ?? 0, total: p.total ?? 0 })

/** The most recent tick anywhere in a copy, for "finished today". Read off the
 *  winning copy only: a stale copy in another worktree has older history by
 *  definition and would drag the answer backwards. */
const lastChecked = (p) =>
  (p.items ?? []).reduce((m, i) => Math.max(m, i.history?.checkedAt ?? 0), 0)

/** The winning copy's currently-active step, as text rather than an id --
 *  same resolution the browser Projects tab already does client-side
 *  (public/projects.js: `plan.items.find((i) => i.id === plan.currentItemId)`)
 *  but done once here so a consumer that never sees `items` (pane-v2's MINE
 *  view) still gets it. `null` when the plan has no unchecked step: finished,
 *  empty, or a ghost with `currentItemId` already null. */
const currentItemText = (p) => {
  if (!p.currentItemId) return null
  const item = (p.items ?? []).find((i) => i.id === p.currentItemId)
  return item?.text ?? null
}

/** Is `a` further along than `b`? Verified steps decide it; a reported step
 *  breaks a tie, because a claim beats nothing but never beats a verified one.
 *  Total is the last resort, so a fuller copy of the same plan wins over a
 *  truncated one rather than the order they were scanned in deciding. */
const ahead = (a, b) =>
  a.done !== b.done ? a.done > b.done
    : a.reported !== b.reported ? a.reported > b.reported
      : a.total > b.total

export const foldEfforts = (worktrees) => {
  const groups = new Map()
  const collisions = []

  for (const w of worktrees ?? []) {
    const seenHere = new Map()
    for (const p of (w.plans ?? [])) {
      if (p.absent) continue
      const name = base(p.rel)
      if (seenHere.has(name)) collisions.push({ worktree: w.path, name, rels: [seenHere.get(name), p.rel] })
      else seenHere.set(name, p.rel)
      if (!groups.has(name)) groups.set(name, [])
      groups.get(name).push({ w, p })
    }
  }

  // Claims name work by the same identities the rest of this file uses: a plan
  // by basename, a backlog entry by `docs/TASKS.md#slug`. A claim that matches
  // nothing is REPORTED rather than dropped -- it is usually a typo in a hand
  // edit, and silence would make it unfindable. That includes a typo in `kind`
  // itself: 'plan' and 'backlog' are the only two recognized kinds
  // anywhere in this codebase, so anything else is unambiguously malformed,
  // not a legitimate third category to ignore. This loop visits every claim
  // item exactly once per scan, so it is also the one place that reports a
  // bad kind -- a genuine 'backlog' item is skipped here without reporting
  // (tasks.mjs's resolveBacklogClaims resolves those), and must stay that way
  // so it is not double-reported when it also fails to match there.
  const claimedBy = new Map()
  const unresolvedClaims = []
  for (const w of worktrees ?? []) {
    for (const [sessionId, entry] of Object.entries(w.claims ?? {})) {
      for (const item of (entry.items ?? [])) {
        if (item.kind === 'backlog') continue
        if (item.kind !== 'plan') {
          unresolvedClaims.push({ sessionId, name: entry.name ?? '', kind: item.kind, id: item.id })
          continue
        }
        if (!groups.has(item.id)) {
          unresolvedClaims.push({ sessionId, name: entry.name ?? '', kind: item.kind, id: item.id })
          continue
        }
        if (!claimedBy.has(item.id)) claimedBy.set(item.id, [])
        claimedBy.get(item.id).push({ id: sessionId, name: entry.name || sessionId.slice(0, 8) })
      }
    }
  }

  const efforts = []
  for (const [name, copies] of groups) {
    let best = copies[0]
    for (const c of copies) if (ahead(progress(c.p), progress(best.p))) best = c
    const bp = progress(best.p)
    // A DECLARED `**Shipped:**` line takes the plan out of flight regardless of
    // its counts.
    //
    // Read off ANY copy, NOT the winning one -- the one place in this file that
    // does not follow the winning copy, and deliberately. done/reported/total
    // and checkedAt are MEASUREMENTS of a checkout, so they belong to the most
    // advanced copy. Shipped: is a DECLARATION about the work itself: if any
    // copy carries it, the milestone landed, whichever checkout wins the tie.
    //
    // The failure this guards: a declaration added in one worktree while every
    // copy reads 0/N, so `ahead()` never displaces copies[0] and the effort
    // reports shipped=no while the file on disk plainly declares it.
    //
    // It deliberately does NOT touch done/reported/total: the ticks on disk are
    // still the truth, and inventing progress would be the same lie as folding
    // reported into done. A declared plan keeps its 0/N and simply stops
    // claiming to be in flight -- because what is actually known is
    // "the milestone landed", not "each step was verified".
    const shipped = copies.map((c) => c.p.shipped).find(Boolean) ?? null
    efforts.push({
      name,
      title: best.p.title || name,
      rel: best.p.rel,
      done: bp.done, reported: bp.reported, total: bp.total,
      shipped,
      // A plan with no steps at all is not "unfinished", it is empty.
      live: !shipped && bp.total > 0 && bp.done < bp.total,
      copies: copies.length,
      // How many copies sit behind the most advanced one. This is the drift the
      // old count buried inside "in flight" -- worth showing, worth not adding.
      behind: copies.filter((c) => ahead(bp, progress(c.p))).length,
      // Null for a shipped plan. Every one of the three offenders advertised
      // "Step 1: Write the failing test" as its current step, in every view --
      // which is what made them impossible to ignore.
      currentItemId: shipped ? null : (best.p.currentItemId ?? null),
      currentItem: shipped ? null : currentItemText(best.p),
      checkedAt: lastChecked(best.p),
      at: best.w.isMain ? 'main' : best.w.path,
      claimedBy: claimedBy.get(name) ?? [],
    })
  }
  return { efforts, collisions, unresolvedClaims }
}
