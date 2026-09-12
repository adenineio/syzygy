// One scan pass: sessions in, the `projects` payload out.
//
// The relay's read endpoints are ungated by design, consistent with
// /api/state, /api/replay and /api/stream. This
// payload therefore reaches anything on the host that can open the port, which
// is why tasks-discover.mjs refuses a path that leaves its worktree.

import { readFileSync } from 'node:fs'
import { sep } from 'node:path'
import { topologyOf, probe } from './tasks-git.mjs'
import { discover, CAPS } from './tasks-discover.mjs'
import { parseItems, parseHeader, parseFeatures } from './tasks-parse.mjs'
import { labelItems, rollUp } from './tasks-diff.mjs'
import { foldEfforts } from './tasks-efforts.mjs'
import { buildIndex, resolveRef } from './refs.mjs'
import { observe, historyFor, prune, load, save } from './tasks-register.mjs'
import { readClaims } from './claims.mjs'

// Re-exported so relay.mjs's claims endpoints can resolve a caller-supplied
// root to the real git worktree root before writing -- the same call
// topologyOf already makes -- without importing tasks-git.mjs directly.
// "Only tasks.mjs is imported by relay.mjs" stays true this way.
export { probe }

const OWNER_WINDOW_MS = 15 * 60 * 1000

const under = (root, child) => child === root || child.startsWith(root.endsWith(sep) ? root : root + sep)

/** Longest-prefix wins, so a session inside a nested worktree binds to the
 *  nearest one rather than to the outer checkout.
 *
 *  NOTE: `worktrees` here is the list ALREADY sliced to CAPS.worktreesPerProject,
 *  so a session living in a worktree that fell over the cap has no candidate of
 *  its own and binds to whichever surviving worktree is its nearest ancestor --
 *  usually the main checkout. Its tasks then appear under the wrong worktree
 *  rather than not at all. Left as it is deliberately: passing the unsliced
 *  list would strand such a session with no worktree at all, which is not
 *  obviously better, and the over-cap count is now reported (see scan()) so the
 *  situation is at least visible. */
const sessionsIn = (worktreePath, worktrees, sessions) =>
  sessions.filter((s) => {
    if (!s.cwd || !under(worktreePath, s.cwd)) return false
    const best = worktrees
      .filter((w) => under(w.path, s.cwd))
      .sort((a, b) => b.path.length - a.path.length)[0]
    return best?.path === worktreePath
  })

/** A file that stats fine but will not read parses to zero items, which is
 *  indistinguishable from a file with nothing in it. Report it the way
 *  discover() already reports its own refusals, or the loss is invisible. */
const readText = (file, skipped) => {
  try {
    return readFileSync(file.abs, 'utf8')
  } catch {
    skipped.push({ rel: file.rel, reason: 'unreadable' })
    return ''
  }
}

/** What a session has actually DONE, as one comparable string.
 *
 *  Deliberately excludes `seenAt`: the plugin's clock ticker keeps pushing
 *  while a session sits at a permission prompt, so seenAt advances even when
 *  nothing is happening -- the exact case this has to distinguish. The stats
 *  values do not move without model or tool calls. */
const fingerprintOf = (s) => JSON.stringify(s.stats ?? {})

/** The register fields the pane actually renders.
 *
 *  Deliberately omits `lastSeen`, which observe() rewrites on EVERY pass, and
 *  `text`, which the file already supplies. If either reached the payload the
 *  serialized result would differ on every scan, and relay.mjs's
 *  broadcast-only-on-change check would fire every 4 s forever. */
const publicHistory = (h) => (h ? {
  firstSeen: h.firstSeen, checkedAt: h.checkedAt, checkedBy: h.checkedBy,
  uncheckedAt: h.uncheckedAt, removedAt: h.removedAt,
} : null)

/** What a session looks like in the payload. `fingerprint` is attribution
 *  bookkeeping and changes constantly; publishing it would defeat the same
 *  change check. */
const publicSession = (s) => ({ id: s.id, name: s.name, working: s.working })

/** Who owns this plan, in strict precedence order:
 *
 *    1. a LIVE claim        -- source 'claim'
 *    2. checkedBy           -- source 'checked'
 *    3. the sole session    -- source 'sole-session'
 *    4. a STALE claim       -- source 'claim-stale'
 *
 *  A live claim wins outright: it is the only statement of ownership anybody
 *  actually made, and it is what claims exist for -- the two inferred paths
 *  below it are guesses (`checkedBy` credits whoever last ticked an item
 *  within OWNER_WINDOW_MS, and the sole-session fallback assumes the only
 *  session in a worktree owns everything in it, returning null the moment two
 *  sessions share one).
 *
 *  A claim whose session is not among `here` is STALE -- the store keeps
 *  claims until they are released by hand, so a session dead for a week still
 *  has an entry in the file. Ranking that above the inferred paths made a dead
 *  name outrank a session ticking items right now, permanently, on a surface
 *  (projects.js's plan owner) that showed the live ticker before this feature
 *  existed. It is still REPORTED rather than dropped, at the bottom of the
 *  order and tagged so a reader can tell the two apart: information the file
 *  holds is not lost, it just stops beating evidence of present activity. */
export const ownerFor = (plan, here, checkedBy, claims) => {
  const base = plan.rel.slice(plan.rel.lastIndexOf('/') + 1)
  const liveHere = new Set((here ?? []).map((s) => s.id))
  let stale = null
  for (const [id, entry] of Object.entries(claims ?? {})) {
    // claims.json is documented as hand-editable, and readClaims's JSON.parse
    // only catches a file that isn't valid JSON at all -- a malformed `items`
    // entry (not an array, or an array with a non-object element) is valid
    // JSON and sails through untouched. Without this guard that reaches
    // .some() here and throws, and scan() has no per-plan try/catch: the
    // exception propagates out of scanner.scan() to relay.mjs's top-level
    // rescan catch, which only logs to stderr -- so one worktree's typo
    // silently freezes live updates for every project on the board.
    if (!Array.isArray(entry.items) || !entry.items.some((i) => i && i.kind === 'plan' && i.id === base)) continue
    const owner = { id, name: entry.name || id.slice(0, 8) }
    if (liveHere.has(id)) return { ...owner, source: 'claim' }
    // First stale match wins among stale matches, matching the first-match
    // rule the live scan above uses.
    if (!stale) stale = { ...owner, source: 'claim-stale' }
  }
  if (checkedBy) return { ...checkedBy, source: 'checked' }
  if (here.length === 1) return { id: here[0].id, name: here[0].name, source: 'sole-session' }
  return stale
}

/** Resolves `kind: 'backlog'` claims onto the `docs/TASKS.md#slug` section
 *  item they name, across every worktree in `built`. Matched here rather than
 *  in `foldEfforts` because sections live on `w.tasks[].items[]`, outside the
 *  effort fold -- `foldEfforts` handles `kind: 'plan'` and already reports any
 *  OTHER kind as unresolved, so this loop only ever sees genuine 'backlog'
 *  items and does not need to report anything else.
 *
 *  Extracted as its own exported, pure(ish) function -- mirroring how
 *  `foldEfforts` is tested -- so a hit and a miss are directly testable
 *  without going through the full scanner. It does mutate the matched item
 *  in place (`claimedBy`): that item is the same object instance the payload
 *  ships under `worktrees[].tasks[].items[]`, not a copy. */
export const resolveBacklogClaims = (built) => {
  const bySlug = new Map()
  for (const w of built ?? []) {
    for (const t of (w.tasks ?? [])) {
      for (const i of (t.items ?? [])) {
        if (i.kind === 'section' && i.slug) bySlug.set(t.rel + '#' + i.slug, i)
      }
    }
  }
  const unresolvedClaims = []
  for (const w of built ?? []) {
    for (const [sessionId, entry] of Object.entries(w.claims ?? {})) {
      for (const item of (entry.items ?? [])) {
        if (item.kind !== 'backlog') continue
        const hit = bySlug.get(item.id)
        if (!hit) { unresolvedClaims.push({ sessionId, name: entry.name ?? '', kind: 'backlog', id: item.id }); continue }
        hit.claimedBy = [...(hit.claimedBy ?? []), { id: sessionId, name: entry.name || sessionId.slice(0, 8) }]
      }
    }
  }
  return unresolvedClaims
}

/** Resolves every plan's DECLARED `Tasks:` and `Spec:` lines against `index`,
 *  annotating each plan with `resolvedTasks` and `resolvedSpec`, and returns
 *  the broken references deduped by (plan basename, kind, reference).
 *
 *  Exported and taking `built` directly -- mirroring `resolveBacklogClaims`
 *  and `foldEfforts` -- so the DEDUPE is testable. It cannot be exercised
 *  through `scan()` against a healthy project, because nothing there has a
 *  broken reference: the only way to prove the path is to hand it two
 *  worktrees carrying the same broken plan. A test that cannot fail is worse
 *  than no test, and a single-worktree fixture gives exactly that: nothing to
 *  deduplicate, so the assertion holds with the dedupe deleted.
 *
 *  It mutates the plans in place, like `resolveBacklogClaims`: those objects
 *  are the same instances the payload ships.
 *
 *  DEDUPED BY BASENAME, not `rel`. Every worktree inherits every committed
 *  plan, so walking `built` reports each broken reference once per worktree,
 *  several times the real count -- and a worktree may hold its copy under the
 *  older docs/superpowers/plans/ layout, so `rel` would not collapse the pair
 *  either. This
 *  is the inflation the effort fold exists to prevent; a new list does not get
 *  to inherit it. */
export const resolveDeclaredRefs = (built, index) => {
  const seen = new Set()
  const brokenRefs = []
  const report = (from, kind, ref) => {
    const k = from.slice(from.lastIndexOf('/') + 1) + '|' + kind + '|' + ref
    if (seen.has(k)) return
    seen.add(k)
    brokenRefs.push({ from, kind, ref })
  }

  for (const w of built ?? []) {
    for (const pl of (w.plans ?? [])) {
      pl.resolvedTasks = (pl.tasks ?? []).map((ref) => {
        const r = resolveRef(index, 'backlog', ref)
        if (r.broken) {
          report(pl.rel, 'backlog', ref)
          return { ref, broken: true }
        }
        // Flattened: the view wants the heading's text and where it lives, not
        // the whole item with its history attached.
        return { ref, rel: r.key.slice(0, r.key.lastIndexOf('#')), slug: r.target.slug, text: r.target.text }
      })

      // Flattened for the same reason. The project already carries the full
      // `specs` list to look anything else up in; carrying the whole target on
      // every plan measured 25 KB across 114 rows for nothing.
      if (!pl.spec) {
        pl.resolvedSpec = null
        continue
      }
      const r = resolveRef(index, 'spec', pl.spec)
      if (r.broken) {
        report(pl.rel, 'spec', pl.spec)
        pl.resolvedSpec = { ref: pl.spec, broken: true }
      } else {
        pl.resolvedSpec = { ref: pl.spec, name: r.key, title: r.target.title ?? null }
      }
    }
  }
  return brokenRefs
}

export const createScanner = ({ registerFile }) => {
  const register = load(registerFile)
  let prevActivity = new Map()
  let dirty = false

  const scan = async (sessions, at) => {
    const live = (sessions ?? []).filter((s) => s.cwd)
    // Spec 4.1: anything over a cap is REPORTED, never silently dropped. These
    // two slices used to drop quietly -- a 13th worktree simply vanished and
    // the tab was indistinguishable from one with 12.
    const allProjects = await topologyOf(live.map((s) => s.cwd), at)
    const projects = allProjects.slice(0, CAPS.projects)
    const projectsOverCap = allProjects.length - projects.length
    const out = []

    for (const proj of projects) {
      const worktrees = proj.worktrees.slice(0, CAPS.worktreesPerProject)
      const worktreesOverCap = proj.worktrees.length - worktrees.length
      const built = []

      for (const w of worktrees) {
        const found = discover(w.path)
        // `found.claims` proves the file passed containment; readClaims does
        // the parsing and the corrupt-file degradation.
        const claims = found.claims ? readClaims(w.path).claims : {}
        const here = sessionsIn(w.path, worktrees, live).map((s) => ({
          id: s.id,
          name: s.name || s.agentName || s.id.slice(0, 8),
          working: !!s.working,
          fingerprint: fingerprintOf(s),
        }))

        const plans = found.plans.map((f) => {
          const src = readText(f, found.skipped)
          const head = parseHeader(src)
          const items = parseItems(f.rel, src)
          const steps = items.filter((i) => i.kind === 'step')
          const first = steps.find((i) => !i.checked)
          return {
            rel: f.rel,
            dir: f.rel.startsWith('docs/superpowers/') ? 'superpowers-plans' : 'plans',
            title: head.title, spec: head.spec, tasks: head.tasks,
            shipped: head.shipped,
            // A present-but-undateable `**Shipped:**` value. Carried so the
            // project can report it: a field computed and dropped is not
            // "reported", it is the same defect as `plan.tasks` being parsed
            // and transported and matched against nothing.
            shippedMalformed: head.shippedMalformed,
            items,
            // A plan that DECLARES it shipped names no current step. Without
            // this, three plans executed before the tick-as-you-go convention
            // each advertised "Step 1: Write the failing test" as their current
            // work, in every view that reads the payload.
            currentItemId: head.shipped ? null : (first?.id ?? null),
            done: steps.filter((i) => i.checked).length,
            // Never folded into `done`. A tick means verified; a reported step
            // is a claim, and the UI has to be able to say which is which.
            reported: steps.filter((i) => i.reported).length,
            total: steps.length,
            owner: null, diff: 'same', mtimeMs: f.mtimeMs,
          }
        })

        const tasks = found.tasks.map((f) => ({ rel: f.rel, items: parseItems(f.rel, readText(f, found.skipped)) }))
        const allItems = [...plans.flatMap((p) => p.items), ...tasks.flatMap((t) => t.items)]

        observe(register, w.path, allItems, here, prevActivity, at)
        // Unconditional, not finer-gated: observe() rewrites `lastSeen` on
        // every worktree every pass regardless of whether anything actually
        // changed, so there is nothing cheaper to check here.
        dirty = true

        for (const p of plans) {
          const recent = p.items
            .map((i) => historyFor(register, w.path, i.id))
            .filter((h) => h?.checkedAt && at - h.checkedAt < OWNER_WINDOW_MS && h.checkedBy)
            .sort((a, b) => b.checkedAt - a.checkedAt)[0]
          p.owner = ownerFor(p, here, recent?.checkedBy ?? null, claims)
          p.items = p.items.map((i) => ({ ...i, history: publicHistory(historyFor(register, w.path, i.id)) }))
        }
        // Backlog items get history too. observe() records it for every item it
        // is given, and routeRemoved() attaches it to ghost backlog entries
        // anyway -- so attaching it only to plan items left the shape differing
        // WITHIN one array, and a `- [ ]` checkbox in a TASKS.md had its
        // attribution recorded and then never displayed.
        for (const t of tasks) {
          t.items = t.items.map((i) => ({ ...i, history: publicHistory(historyFor(register, w.path, i.id)) }))
        }

        built.push({
          path: w.path, branch: w.branch, head: w.head, isMain: w.isMain,
          detached: w.detached, locked: w.locked,
          sessions: here.map(publicSession), plans, tasks,
          // Which task file is the authority here, and where it lives. Carried
          // rather than recomputed in the pane: discover() has the precedence
          // rule and the pane has no filesystem, so a second copy of the order
          // would be a second thing to keep in step. Both are payload fields,
          // so a relay predating them reads undefined and the drawer simply
          // shows no flag, which is the silent-failure mode of every one.
          taskFile: found.taskFile ?? null,
          taskAuthority: found.taskAuthority ?? null,
          // The rel strings stay as they were; refs.mjs accepts either shape.
          specs: found.specs.map((f) => f.rel),
          // The find objects, kept for the project-level fold below so a spec
          // is READ ONCE PER BASENAME rather than once per worktree. With 8
          // worktrees and 40 specs that is the difference between 40 reads a
          // scan and 320. Dropped from the payload with the other scaffolding.
          specFinds: found.specs,
          // Parsed here because `found.features` is a per-worktree find, but
          // FOLDED at project level below: every worktree inherits the same
          // docs/FEATURES.md, so a per-worktree list would report all 39
          // entries once per worktree -- the effort-inflation bug in a new
          // place. Null when the file is absent or was refused.
          features: found.features
            ? parseFeatures(found.features.rel, readText(found.features, found.skipped))
            : null,
          skipped: found.skipped,
          claims,
          items: allItems,
        })
      }

      // Label every non-main worktree against main's items.
      const main = built.find((w) => w.isMain)
      const baseline = built.length > 1 && main ? main.items : null
      for (const w of built) {
        w.items = labelItems(w.isMain || !baseline ? null : baseline, w.items)

        // Back-fill the label onto the nested copies. `p.items` and `t.items`
        // were cloned before labelling (to attach history), so they are
        // different objects from `w.items` and do not get .diff for free.
        // Doing this in BOTH branches keeps one schema: every item everywhere
        // carries a diff, 'same' when there is nothing to compare against.
        // The view renders p.items and t.items, never w.items -- so an item
        // that misses this back-fill is an item whose badge never appears.
        const byId = new Map(w.items.map((i) => [i.id, i.diff]))
        for (const p of w.plans) p.items = p.items.map((i) => ({ ...i, diff: byId.get(i.id) ?? 'same' }))
        for (const t of w.tasks) t.items = t.items.map((i) => ({ ...i, diff: byId.get(i.id) ?? 'same' }))

        if (!w.isMain && baseline) {
          const mainPlans = new Set(main.plans.map((p) => p.rel))
          for (const p of w.plans) p.diff = mainPlans.has(p.rel) ? 'same' : 'only-here'

          // `removed` items live only in the flat array: they are synthesized
          // from main's parse and have no local file entry to back-fill onto.
          // The view renders p.items and t.items, so an unrouted removed item
          // can never appear. Route each into the file it came from, matched
          // by relative path, and append so it sorts last within that file.
          const removedIds = new Set(w.items.filter((i) => i.diff === 'removed').map((i) => i.id))
          const routeRemoved = (mineFiles, mainFiles) => {
            for (const mainFile of mainFiles) {
              const gone = mainFile.items
                .filter((i) => removedIds.has(i.id))
                .map((i) => ({
                  ...i, diff: 'removed', absent: true,
                  // This worktree's record is the one carrying removedAt.
                  history: publicHistory(historyFor(register, w.path, i.id)),
                }))
              if (!gone.length) continue
              const mineFile = mineFiles.find((f) => f.rel === mainFile.rel)
              if (mineFile) {
                const have = new Set(mineFile.items.map((i) => i.id))
                const add = gone.filter((i) => !have.has(i.id))
                if (add.length) mineFile.items = [...mineFile.items, ...add]
              } else {
                // The whole file is gone from this worktree. Without a ghost
                // entry its items stay stranded in the flat array and nothing
                // renders them -- the same failure this routing exists to fix,
                // one level up. The ghost describes the file as main has it,
                // flagged so the view can show it as absent here.
                //
                // done/total are zeroed rather than carried from main: this
                // worktree has no steps in this file because it has no file.
                // It also fails safe -- a consumer that ignores `absent` and
                // buckets on done/total counts a ghost in neither bucket
                // instead of silently inflating one.
                mineFiles.push({
                  ...mainFile, items: gone, diff: 'removed', absent: true,
                  owner: null, done: 0, reported: 0, total: 0, currentItemId: null,
                })
              }
            }
          }
          routeRemoved(w.plans, main.plans)
          routeRemoved(w.tasks, main.tasks)
        }
      }

      const roll = rollUp(built)
      // The flat per-worktree `items` array is scan-time scaffolding: the
      // labelling and the removed-item routing above both need it. Nothing
      // downstream does -- rollUp has just run, and projects.js reads p.items
      // and t.items exclusively -- and it was better than a third of the
      // payload when it was measured. Drop it before it is broadcast.
      // FOLD BEFORE DELETING. Both `items` and `features` are scan-time
      // scaffolding, and the fold below reads `features` -- so the delete has
      // to come after it, not beside the one for `items`.
      //
      // MAIN's copy is canonical: it is the shipped record, while a worktree's
      // copy is whatever that branch happens to hold mid-flight. Falls back to
      // the first worktree that has one, so a bare-repo project or a checkout
      // with no main worktree still shows its features.
      // Specs, folded by BASENAME because the scanner reads two spec
      // directories and a spec that moved between them is one document.
      // Main's copy wins; the first worktree to carry it otherwise.
      //
      // README.md is not a spec and is excluded here.
      const specWinners = new Map()
      for (const w of [...built.filter((x) => x.isMain), ...built.filter((x) => !x.isMain)]) {
        for (const f of (w.specFinds ?? [])) {
          const name = f.rel.slice(f.rel.lastIndexOf('/') + 1)
          if (name === 'README.md') continue
          if (!specWinners.has(name)) specWinners.set(name, { f, w })
        }
      }
      const specs = [...specWinners].map(([name, { f, w }]) => ({
        name,
        rel: f.rel,
        // Header only. A spec has no checkbox steps worth counting, and
        // parsing 40 whole documents per scan buys nothing.
        title: parseHeader(readText(f, w.skipped)).title,
        mtimeMs: f.mtimeMs,
      }))

      const featureSrc = built.find((w) => w.isMain && w.features) ?? built.find((w) => w.features)
      const features = featureSrc?.features?.features ?? []
      const featureCollisions = featureSrc?.features?.collisions ?? []

      for (const w of built) delete w.items
      // Every worktree inherits the same docs/FEATURES.md, so leaving these on
      // would ship all 39 entries once per worktree -- the effort-inflation
      // bug in a new place.
      for (const w of built) delete w.features
      for (const w of built) delete w.specFinds

      // `overCap.projects` is the same number on every project: the payload is
      // an array by contract with app.js, so there is no envelope to hang a
      // whole-payload count on, and replicating one small integer is cheaper
      // than reshaping the transport. The view reads it off the first entry.
      // One plan is one effort however many worktrees carry a copy of it.
      // `planCollisions` is normally empty; when it is not, the view must say
      // so rather than let two different plans quietly share a row.

      // DECLARED references, resolved: a plan's `Tasks:` line names backlog
      // headings and its `Spec:` line names a spec, matched exactly, with a
      // miss reported as broken. Nothing is inferred from titles: a plan is
      // tied to a backlog entry only where it declares one.
      //
      // Built after the features and specs folds because the index reads both,
      // and after the scaffolding deletes, which is safe: it reads `w.tasks`,
      // `w.plans` and `w.specs`, none of which are deleted.
      const brokenRefs = resolveDeclaredRefs(built, buildIndex({ worktrees: built, features, specs }))

      const { efforts, collisions, unresolvedClaims: planUnresolved } = foldEfforts(built)
      const backlogUnresolved = resolveBacklogClaims(built)

      out.push({
        key: proj.key, name: proj.name, isGit: proj.isGit, mainRoot: proj.mainRoot,
        overCap: { projects: projectsOverCap, worktrees: worktreesOverCap },
        roll, efforts, planCollisions: collisions,
        // MAIN's copy is canonical. It is the shipped record; a worktree's
        // copy is whatever that branch happens to hold mid-flight. Falls back
        // to the first worktree that has one, so a bare-repo project or a
        // checkout without a main worktree still shows its features.
        features, featureCollisions, specs, brokenRefs,
        // Reported, never silently ignored -- the rule the CAPS, ghost entries
        // and unresolved claims already follow. A typo in a hand edit should be
        // findable rather than a plan quietly leaving every in-flight count.
        malformedShipped: built.flatMap((w) =>
          (w.plans ?? [])
            .filter((pl) => pl.shippedMalformed)
            .map((pl) => ({ rel: pl.rel, value: pl.shippedMalformed }))),
        unresolvedClaims: [...planUnresolved, ...backlogUnresolved],
        worktrees: built,
      })
    }

    prevActivity = new Map(live.map((s) => [s.id, { working: !!s.working, fingerprint: fingerprintOf(s) }]))
    prune(register, at)
    if (dirty) { save(registerFile, register); dirty = false }
    return out
  }

  return { scan, register }
}
