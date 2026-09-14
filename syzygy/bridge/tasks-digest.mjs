// The projects board as the wire carries it, and as a view fetches it.
//
// The scan keeps every plan copy in every worktree, steps and history
// included, and a board of a dozen worktrees carries every committed plan
// once per worktree. Sending that made the snapshot grow with every step
// anybody wrote, until panes were dropped for not draining it.
//
// The DIGEST is what every pane is sent on every change: counts, flags, the
// efforts sessions have claimed and one line per worktree. Its size follows
// projects, worktrees and claims, never plans, steps or backlog headings. The
// DOCUMENT is one project's digest plus every effort and the folded plans and
// backlog, for a view that is showing that project and asks for it.
//
// Every count is taken over the whole scan, never over the efforts carried,
// so a board with more live work than the digest carries reads the number it
// always did.
//
// Pure: no I/O, and no clock -- `now` is an argument. Nothing here writes to
// the scan. Values nested below the objects built here (a session, a claim
// list, a resolved spec) are shared with the scan rather than copied, since
// the relay only serialises what it is handed.

import { ahead, progress, currentItemText } from './tasks-efforts.mjs'

/** How many claimed efforts ride the digest. The document carries every
 *  effort, claimed or not. */
export const DIGEST_EFFORTS = 12

const DAY_MS = 24 * 60 * 60 * 1000

// The Worktrees card's badges, keyed the way the pane keys them, so a card
// reads the object as it arrives rather than re-keying it.
const DIFF_KINDS = ['only-here', 'removed', 'done-here', 'behind']

const base = (rel) => String(rel).slice(String(rel).lastIndexOf('/') + 1)
const lengthOf = (xs) => (Array.isArray(xs) ? xs.length : 0)
// Code-unit order rather than localeCompare: the digest is compared byte for
// byte between passes, and a locale must not be able to reorder it.
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** The five needs-a-human lists as counts, and their sum. The lists
 *  themselves ride the document. */
export const needsFlags = (proj) => {
  const flags = {
    planCollisions: lengthOf(proj?.planCollisions),
    unresolvedClaims: lengthOf(proj?.unresolvedClaims),
    brokenRefs: lengthOf(proj?.brokenRefs),
    featureCollisions: lengthOf(proj?.featureCollisions),
    malformedShipped: lengthOf(proj?.malformedShipped),
  }
  return { ...flags, total: Object.values(flags).reduce((n, x) => n + x, 0) }
}

// ---- the backlog --------------------------------------------------------------

// A worktree's copy of a heading, from the diff the scan labelled it with.
const BACKLOG_LABEL = new Map([
  ['removed', 'absent'], ['only-here', 'ahead'], ['done-here', 'ahead'], ['behind', 'behind'],
])
const backlogLabel = (it) => (it.absent ? 'absent' : BACKLOG_LABEL.get(it.diff) ?? 'same')

/** Every task file's headings, one record per item id.
 *
 *  Every worktree inherits the same task file, so a pass over every
 *  worktree's items shows each heading once per worktree; this keeps the first
 *  copy seen, in worktree order. A ghost file (`t.absent`) is skipped whole
 *  and a ghost heading (`it.absent`) is skipped too, so neither starts a
 *  record, lends it a claim or reads as a copy of the heading elsewhere --
 *  except that a ghost heading inside a file the worktree does have is that
 *  worktree's copy, labelled `absent`.
 *
 *  `claimedBy` is the union across every copy. A backlog claim lands on
 *  whichever worktree's copy the scanner visited last for that slug, so
 *  reading it off the first copy would drop a real claim depending on scan
 *  order.
 *
 *  Item ids include the file path, so a task file at the root and one under
 *  docs/ never fold into one row: both files' headings are kept, and `authority`
 *  says whether the heading's file is the one its worktree counts. `body` is
 *  the steps written beneath the heading in that first copy, up to the next
 *  heading. */
export const foldBacklog = (proj) => {
  const byId = new Map()
  const copies = new Map()
  for (const w of proj?.worktrees ?? []) {
    const seenHere = new Set()
    for (const t of (w.tasks ?? [])) {
      if (t.absent) continue
      let body = null
      for (const it of (t.items ?? [])) {
        if (it.kind !== 'section') {
          if (body && !it.absent) {
            body.push({ k: it.id, id: it.id, text: it.text ?? '', checked: it.checked ?? null, reported: !!it.reported })
          }
          continue
        }
        body = null
        if (!seenHere.has(it.id)) {
          seenHere.add(it.id)
          if (!copies.has(it.id)) copies.set(it.id, [])
          copies.get(it.id).push({ wt: w.path ?? null, label: backlogLabel(it) })
        }
        if (it.absent) continue
        let hit = byId.get(it.id)
        if (!hit) {
          hit = {
            id: it.id, slug: it.slug ?? null, text: it.text ?? '', rel: t.rel ?? null,
            authority: !!w.taskFile && t.rel === w.taskFile, claimedBy: [], body: [],
          }
          byId.set(it.id, hit)
          body = hit.body
        }
        for (const c of (it.claimedBy ?? [])) {
          if (!hit.claimedBy.some((x) => x.id === c.id)) hit.claimedBy.push(c)
        }
      }
    }
  }
  return [...byId.values()].map((b) => ({ ...b, copies: copies.get(b.id) }))
}

/** Every distinct item id -- heading or step alike -- across every task file
 *  every worktree carries. Every worktree inherits the same task file, so an
 *  id is counted once however many worktrees carry it; a ghost file and a
 *  ghost item are skipped, since neither has anything behind it. */
const backlogItemCount = (proj) => {
  const ids = new Set()
  for (const w of proj?.worktrees ?? []) {
    for (const t of (w.tasks ?? [])) {
      if (t.absent) continue
      for (const it of (t.items ?? [])) if (!it.absent) ids.add(it.id)
    }
  }
  return ids.size
}

// ---- plans --------------------------------------------------------------------

/** Every plan record in a project grouped by basename -- the identity a plan
 *  keeps across worktrees and across the two plan-directory layouts. For each:
 *  the one copy each worktree carries, in worktree order, and main's live
 *  copy. A worktree holding a basename twice (a collision, reported on the
 *  project) is represented by its first live copy, or by its ghost when it has
 *  no live one. */
const planGroups = (proj) => {
  const groups = new Map()
  for (const w of proj?.worktrees ?? []) {
    for (const p of (w.plans ?? [])) {
      const name = base(p.rel)
      if (!groups.has(name)) groups.set(name, { main: null, byWt: new Map() })
      const g = groups.get(name)
      const had = g.byWt.get(w)
      if (!had || (had.p.absent && !p.absent)) g.byWt.set(w, { w, p })
      if (w.isMain && !p.absent && !g.main) g.main = p
    }
  }
  return groups
}

/** A copy against MAIN's copy, never against the most advanced one: against
 *  the best copy nothing could ever read as ahead, and "this worktree has
 *  moved past main" is the fact a worktree's view needs. A plan main does not
 *  carry at all is ahead by definition. */
const planLabel = (c, mainPlan) => {
  if (c.p.absent) return 'absent'
  if (!mainPlan) return 'ahead'
  if (c.p === mainPlan) return 'same'
  const mine = progress(c.p)
  const theirs = progress(mainPlan)
  return ahead(mine, theirs) ? 'ahead' : ahead(theirs, mine) ? 'behind' : 'same'
}

const planCopy = (c, mainPlan) => {
  const n = progress(c.p)
  return {
    wt: c.w.path ?? null,
    done: n.done, reported: n.reported, total: n.total,
    mtimeMs: c.p.mtimeMs ?? null,
    owner: c.p.owner ?? null,
    currentItem: currentItemText(c.p),
    itemsDiffer: (c.p.items ?? []).some((i) => i.diff && i.diff !== 'same'),
    label: planLabel(c, mainPlan),
  }
}

const foldPlansOver = (proj, groups) => (proj?.efforts ?? []).map((e) => {
  const g = groups.get(e.name)
  const held = g ? [...g.byWt.values()] : []
  // Declared references are facts about the file, the same on every copy, so
  // main's copy is read first and any live copy after it -- the copy the pane
  // has always read them from.
  const refs = g?.main ?? held.find((c) => !c.p.absent)?.p ?? null
  return {
    name: e.name, title: e.title ?? null, rel: e.rel ?? null,
    done: e.done ?? 0, reported: e.reported ?? 0, total: e.total ?? 0,
    shipped: e.shipped ?? null, live: !!e.live, currentItem: e.currentItem ?? null,
    checkedAt: e.checkedAt ?? 0, at: e.at ?? null, claimedBy: e.claimedBy ?? [],
    spec: refs?.spec ?? null, resolvedSpec: refs?.resolvedSpec ?? null, resolvedTasks: refs?.resolvedTasks ?? [],
    copies: held.map((c) => planCopy(c, g.main)),
  }
})

/** One record per plan basename, in the efforts' order. The progress numbers,
 *  current step and claims are the effort's own, from the most advanced copy;
 *  `copies` is each worktree's own copy with its own numbers, owner and
 *  current step, labelled `same | behind | ahead` against main's copy or
 *  `absent` for a ghost. */
export const foldPlans = (proj) => foldPlansOver(proj, planGroups(proj))

// ---- the digest ---------------------------------------------------------------

// The digest's one reader of efforts is the terminal pane's MINE view, which
// shows a session the plans it has claimed through exactly these six fields;
// the browser pane reads every effort off the document. So the digest carries
// claimed efforts only, trimmed to those fields -- an effort per plan per
// project, sent on every change, was most of the digest's size -- and
// `moreEfforts` counts every effort it leaves out.
const claimedFirst = (a, b) =>
  (b.checkedAt ?? 0) - (a.checkedAt ?? 0) ||
  byName(String(a.name), String(b.name))

const digestEffort = (e) => ({
  name: e.name ?? null, title: e.title ?? null, done: e.done ?? 0, total: e.total ?? 0,
  currentItem: e.currentItem ?? null, claimedBy: e.claimedBy,
})

/** One worktree as the digest carries it. `diff` counts every plan and every
 *  task item whose label is one of the four kinds, ghosts included, because a
 *  ghost is exactly what `removed` counts. `claimedSections` lists only the
 *  headings a claim sits on -- listing every heading would put the backlog
 *  back on the wire once per worktree. `isMain`, `locked` and `detached` are
 *  present only when true: a false default carries no information, and every
 *  reader tests them by truthiness. */
const digestWorktree = (w) => {
  const diff = Object.fromEntries(DIFF_KINDS.map((d) => [d, 0]))
  const tally = (x) => { if (x && Object.hasOwn(diff, x.diff)) diff[x.diff]++ }
  let planCount = 0
  for (const p of (w.plans ?? [])) {
    tally(p)
    if (!p.absent) planCount++
  }
  const claimedSections = []
  for (const t of (w.tasks ?? [])) {
    for (const it of (t.items ?? [])) {
      tally(it)
      if (t.absent || it.absent || it.kind !== 'section' || !it.claimedBy?.length) continue
      claimedSections.push({ rel: t.rel ?? null, slug: it.slug ?? null, text: it.text ?? '', claimedBy: it.claimedBy })
    }
  }
  return {
    path: w.path ?? null, branch: w.branch ?? null, head: w.head ?? null,
    ...(w.isMain === true ? { isMain: true } : {}),
    ...(w.locked === true ? { locked: true } : {}),
    ...(w.detached === true ? { detached: true } : {}),
    sessions: w.sessions ?? [],
    planCount,
    taskFile: w.taskFile ?? null, taskAuthority: w.taskAuthority ?? null,
    diff, claimedSections,
  }
}

/** One project as the wire carries it. `changedAt` is null here; the relay
 *  stamps it. `now` decides which finished efforts read as fresh (finished
 *  within a day, with steps to finish); with no `now`, none do.
 *  `counts.backlogSections` counts the folded backlog's headings;
 *  `counts.backlogItems` counts every distinct item in the task files,
 *  headings and the steps beneath them alike. */
export const projectDigest = (proj, { now } = {}) => {
  const worktrees = proj?.worktrees ?? []
  const efforts = proj?.efforts ?? []

  const names = new Set()
  let steps = 0
  for (const w of worktrees) {
    for (const p of (w.plans ?? [])) {
      if (p.absent) continue
      names.add(base(p.rel))
      steps += p.total ?? 0
    }
  }

  const since = Number.isFinite(now) ? now - DAY_MS : Infinity
  const { total, ...flags } = needsFlags(proj)
  const carried = efforts.filter((e) => e?.claimedBy?.length).sort(claimedFirst)
    .slice(0, DIGEST_EFFORTS).map(digestEffort)

  return {
    key: proj?.key ?? null, name: proj?.name ?? null, mainRoot: proj?.mainRoot ?? null, isGit: proj?.isGit ?? null,
    changedAt: null,
    overCap: proj?.overCap ?? null,
    roll: proj?.roll ?? null,
    counts: {
      plans: names.size,
      steps,
      backlogSections: foldBacklog(proj).length,
      backlogItems: backlogItemCount(proj),
      features: lengthOf(proj?.features),
      specs: lengthOf(proj?.specs),
      worktrees: worktrees.length,
      inFlight: efforts.filter((e) => e.live).length,
      behind: efforts.reduce((n, e) => n + (e.behind ?? 0), 0),
      fresh: efforts.filter((e) => !e.live && (e.total ?? 0) > 0 && (e.checkedAt ?? 0) > since).length,
    },
    flags,
    efforts: carried,
    moreEfforts: efforts.length - carried.length,
    worktrees: worktrees.map(digestWorktree),
  }
}

export const digestProjects = (projects, { now } = {}) =>
  (projects ?? []).map((p) => projectDigest(p, { now }))

// ---- the document -------------------------------------------------------------

/** One project's document: the digest, with every effort rather than the
 *  capped list, plus the folded plans and backlog and the lists the digest
 *  only counts. Each worktree line gains `plans`, one `{ ref, label }` per
 *  basename that worktree carries, ghosts included, labelled as foldPlans
 *  labels that worktree's copy. */
export const projectDocument = (proj, { now } = {}) => {
  const digest = projectDigest(proj, { now })
  const groups = planGroups(proj)
  const worktrees = proj?.worktrees ?? []
  const plansIn = (w) => {
    const out = []
    const seen = new Set()
    for (const p of (w?.plans ?? [])) {
      const ref = base(p.rel)
      if (seen.has(ref)) continue
      seen.add(ref)
      const g = groups.get(ref)
      out.push({ ref, label: planLabel(g.byWt.get(w), g.main) })
    }
    return out
  }
  return {
    ...digest,
    efforts: proj?.efforts ?? [],
    moreEfforts: 0,
    plans: foldPlansOver(proj, groups),
    backlog: foldBacklog(proj),
    features: proj?.features ?? [],
    featureCollisions: proj?.featureCollisions ?? [],
    specs: proj?.specs ?? [],
    brokenRefs: proj?.brokenRefs ?? [],
    planCollisions: proj?.planCollisions ?? [],
    unresolvedClaims: proj?.unresolvedClaims ?? [],
    malformedShipped: proj?.malformedShipped ?? [],
    worktrees: digest.worktrees.map((line, i) => ({ ...line, plans: plansIn(worktrees[i]) })),
  }
}

export const documentProjects = (projects, { now } = {}) =>
  (projects ?? []).map((p) => projectDocument(p, { now }))

// ---- the change stamp -----------------------------------------------------------

// A document as compared between passes: without its own stamp, and without
// any worktree's sessions. A session's working flag flips every few seconds;
// stamping a document for it would send every view showing that project back
// for the whole document on every flip, while nothing a document adds reads
// sessions -- a view reads sessions off the digest, which still carries them.
const printOf = (doc) => JSON.stringify({
  ...doc,
  changedAt: null,
  worktrees: (doc?.worktrees ?? []).map(({ sessions, ...w }) => w),
})

/** `changedAt` as a content stamp. `prev` is this function's own previous
 *  result, `{ changedAt, prints }`; anything else -- nothing, an empty Map --
 *  starts from no stamps at all. A project whose document compares
 *  differently from the previous pass, or that the previous pass did not
 *  have, is stamped `at` and listed in `moved`; every other project keeps its
 *  stamp; a project no longer in `documents` is dropped. Returns `{ changedAt, prints, moved }`, all new:
 *  nothing passed in is written to. */
export const stampChanged = (prev, documents, at) => {
  const stamps = prev?.changedAt instanceof Map ? prev.changedAt : new Map()
  const prints = prev?.prints instanceof Map ? prev.prints : new Map()
  const changedAt = new Map()
  const nextPrints = new Map()
  const moved = []
  for (const doc of documents ?? []) {
    const key = doc?.key
    const print = printOf(doc)
    nextPrints.set(key, print)
    if (stamps.has(key) && prints.get(key) === print) {
      changedAt.set(key, stamps.get(key))
    } else {
      changedAt.set(key, at)
      moved.push(key)
    }
  }
  return { changedAt, prints: nextPrints, moved }
}
