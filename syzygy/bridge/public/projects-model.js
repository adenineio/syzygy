/* Syzygy -- the Projects tab's PURE core: the drill-down level reducer, the
   overview and rail row derivations, the two todo lists, planned features,
   the graph panel's rows and the needs-a-human fold. A CLASSIC script, like
   canvas-layout.js: it assigns one global, MCPM, touches no DOM at load, and
   is evaluated under node by test/projects-harness.mjs. It is split out of
   the view for the same reason canvas-layout.js and swarm-math.js are split
   out of their views -- the part worth asserting is separable, so separate
   it and assert it.

   Every function here reads the DIGEST every pane is sent on every change,
   or the DOCUMENT one project's own view fetches for it -- never the full
   scan; the relay folds both (tasks-digest.mjs) so there is exactly one
   derivation of each count, each fold and each label. Every function
   tolerates a payload missing any of its fields: an older relay omits a key
   entirely, and that must read as absent, never throw. */
'use strict'

const MCPM = (() => {
  const LENSES = ['sessions', 'todos', 'efforts', 'git']

  const projectKey = (p) => p?.key ?? p?.name ?? p?.mainRoot ?? 'project'

  // ---- moved verbatim from dispatch.js, so the glance and this tab share
  // one implementation rather than two that can drift -------------------------

  /** "12 verified · 3 reported · 21 to do" -- mirrors projects.js's planhead
   *  count exactly (same three-state ladder, same wording). NEVER COLLAPSE
   *  REPORTED INTO DONE: `[~]` is what an executor believes, `[x]` is what a
   *  reviewer confirmed, and adding them is the lie the three states exist to
   *  remove. With nothing reported the plain done/total form is unchanged. */
  const effortProgress = (e) => {
    const total = e?.total ?? 0
    const done = e?.done ?? 0
    const reported = e?.reported ?? 0
    if (!reported) return done + '/' + total
    return done + ' verified · ' + reported + ' reported · ' +
      Math.max(0, total - done - reported) + ' to do'
  }

  // ---- plan and spec derivations ---------------------------------------------

  /** Every plan in a document, indexed by basename -- the identity a plan
   *  keeps across worktrees and across the two plan-directory layouts. The
   *  document already carries one folded record per basename (main's copy
   *  winning where more than one worktree has it, foldPlans on the relay);
   *  this just re-keys that list into the Map `plannedOf` wants. */
  const planIndexOf = (doc) => {
    const idx = new Map()
    for (const p of (doc?.plans ?? [])) {
      idx.set(p.name, {
        rel: p.rel, basename: p.name, title: p.title ?? null, spec: p.spec ?? null,
        resolvedSpec: p.resolvedSpec ?? null, resolvedTasks: p.resolvedTasks ?? [],
        absent: false,
      })
    }
    return idx
  }

  /** The two todo lists: the backlog (one row per folded heading, from the
   *  document's own `backlog`) and the efforts (one row per plan basename,
   *  folded already by foldEfforts on the relay). taskChips flattens each
   *  effort's declared `Tasks:` references, drawn from the matching plan's
   *  own `resolvedTasks` -- a broken reference arrives as `{ broken: true }`
   *  rather than the ref it could not resolve, since the view has nothing
   *  useful to link a broken chip to. */
  const STRUCK = /^~~(.*)~~$/

  const todosOf = (doc) => {
    const backlog = (doc?.backlog ?? []).map((b) => {
      const struck = STRUCK.exec(String(b.text ?? '').trim())
      return {
        ...b, k: b.id, rel: b.rel ?? null,
        struck: !!struck, label: struck ? struck[1].trim() : b.text, body: b.body ?? [],
      }
    })
    const planIndex = planIndexOf(doc)
    const efforts = (doc?.efforts ?? []).map((e) => {
      const plan = planIndex.get(e.name)
      const taskChips = (plan?.resolvedTasks ?? []).map((t) =>
        t.broken ? { broken: true } : { ref: t.ref, slug: t.slug, text: t.text, broken: false })
      // A declared spec that resolved is something to plan against; one that
      // did not is a card, never a verb aimed at nothing.
      const rs = plan?.resolvedSpec
      const specOk = !!(rs && !rs.broken)
      return {
        k: e.name, name: e.name, title: e.title || e.name, rel: e.rel, at: e.at ?? null,
        progress: effortProgress(e), current: e.currentItem ?? null,
        behind: e.behind ?? 0, shipped: e.shipped ?? null,
        claimedBy: e.claimedBy ?? [], taskChips,
        spec: specOk ? (rs.ref ?? plan.spec ?? null) : null,
        specTitle: specOk ? (rs.title ?? null) : null,
      }
    })
    return { backlog, efforts }
  }

  /** The claims held by a session present on the board right now. A claim
   *  recorded by a session that has since ended says nothing about who is
   *  working on a thing. */
  const liveClaims = (claimedBy, sessions) => {
    const present = new Set((sessions ?? []).map((s) => s.id))
    return (claimedBy ?? []).filter((c) => present.has(c.id))
  }

  /** Whether a folded plan -- already known to live in the worktree at
   *  `wtPath` -- counts as that worktree's OWN work, and by which rule; also
   *  the display order an explicit claim outranks `checked` outranks a bare
   *  diff from main. `null` means none of the three apply: inherited noise in
   *  "this worktree" mode.
   *
   *  A copy's own `itemsDiffer` is the fold's answer to "differs from main",
   *  everywhere but main itself: main's copy is never diffed against
   *  anything, so it reads `itemsDiffer: false` by construction regardless of
   *  real progress. Reported/verified counts on THIS copy are the fallback
   *  signal there -- the only worktree it applies to, so it cannot
   *  reintroduce the inherited-plan noise this filter exists to remove in a
   *  branched worktree, where an untouched inherited plan's reported count is
   *  identical to main's and so already reads `itemsDiffer: false`. A copy
   *  labelled `absent` -- the plan is a ghost here -- is never "mine". */
  const planIsMine = (fold, sessionId, isMainWorktree, wtPath) => {
    const copy = (fold?.copies ?? []).find((c) => c.wt === wtPath)
    if (!copy || copy.label === 'absent') return null
    if (copy.owner?.source === 'claim' && copy.owner.id === sessionId) return 'claim'
    if (copy.owner?.source === 'checked' && copy.owner.id === sessionId) return 'checked'
    const touched = copy.itemsDiffer || (isMainWorktree && (copy.done > 0 || copy.reported > 0))
    return touched ? 'touched' : null
  }

  const stepsOf = (plan) => (plan?.items ?? []).map((it) => ({ ...it, k: it.id, current: it.id === plan.currentItemId }))

  const STEPS_LOADING = 'loading steps…'

  /** An effort's steps as the view draws them. Neither the digest nor the
   *  document ever carries a plan's steps -- only, per worktree, which
   *  basenames it holds -- so they always come from `lookup(wt, rel)`, the
   *  view's own cache of the plan route, as `{ status: 'loading' | 'ok' |
   *  'missing' | 'error', plan }`. `wt` is resolved from the effort's own
   *  `at` ('main' names the digest's own main worktree; anything else is
   *  matched by path) and `rel` from the effort's own `rel`; either missing
   *  draws nothing and asks for nothing. `need` names the one plan to fetch
   *  when the cache holds nothing for it yet. Never throws. */
  const effortStepsView = (project, effort, lookup) => {
    const worktrees = project?.worktrees ?? []
    const at = effort?.at
    const home = at === 'main' ? worktrees.find((w) => w.isMain) : worktrees.find((w) => w.path === at)
    const wt = home?.path ?? null
    const rel = effort?.rel ?? null
    if (!wt || !rel) return { need: null, steps: [], note: null }
    const entry = lookup(wt, rel)
    if (!entry) return { need: { wt, rel }, steps: null, note: STEPS_LOADING }
    if (entry.status === 'ok') return { need: null, steps: stepsOf(entry.plan), note: null }
    if (entry.status === 'missing') return { need: null, steps: null, note: 'steps unavailable on this relay' }
    if (entry.status === 'error') return { need: null, steps: null, note: 'steps could not be read' }
    return { need: null, steps: null, note: STEPS_LOADING }
  }

  // ---- the Worktrees panel, and which panel a lens brings first ---------------

  const DIFF_KINDS = ['only-here', 'removed', 'done-here', 'behind']
  const zeroDiff = () => Object.fromEntries(DIFF_KINDS.map((d) => [d, 0]))

  /** One card per worktree. The digest already counted every plan and every
   *  task item in that worktree by diff kind (`digestWorktree`, on the
   *  relay); this carries it straight through, falling back to all-zero for
   *  a worktree line from a relay that predates the field. */
  const worktreesOf = (d) => (d?.worktrees ?? []).map((w) => ({
    k: 'w:' + w.path, path: w.path ?? null, branch: w.branch ?? null, detached: !!w.detached,
    head: w.head ?? '', isMain: !!w.isMain, locked: !!w.locked, sessions: w.sessions ?? [],
    diff: w.diff ?? zeroDiff(),
  }))

  const PANELS = ['worktrees', 'todos', 'features', 'graph']
  const LENS_PANEL = { sessions: 'worktrees', todos: 'todos', efforts: 'todos', git: 'graph' }

  /** The four panels in order, the lens's own panel first. */
  const panelOrder = (lens) => {
    const first = LENS_PANEL[lens] ?? PANELS[0]
    return [first, ...PANELS.filter((p) => p !== first)]
  }

  /** Specs not yet claimed by any plan's declared `Spec:` line, plus the
   *  plans whose declared spec reference did not resolve. A spec a plan names
   *  is no longer an idea waiting to be planned -- it already has one. */
  const plannedOf = (specs, planIndex) => {
    const claimed = new Set()
    const brokenSpec = []
    for (const p of planIndex.values()) {
      const rs = p.resolvedSpec
      if (!rs) continue
      if (rs.broken) brokenSpec.push({ k: p.basename + '|' + rs.ref, plan: p.basename, ref: rs.ref })
      else if (rs.name) claimed.add(rs.name)
    }
    const planned = (specs ?? [])
      .filter((s) => !claimed.has(s.name))
      .map((s) => ({ k: s.name, name: s.name, rel: s.rel, title: s.title ?? null }))
    return { planned, brokenSpec }
  }

  /** docs/FEATURES.md's entries, folded at project level by the relay
   *  already -- newest first, undated last, each under a key of its own. Two
   *  entries CAN share a slug (that is what a feature collision is), so the
   *  slug alone is not a key. */
  const featuresOf = (project) => ({
    shipped: (project?.features ?? [])
      .map((f) => ({ k: (f.rel ?? '') + '|' + f.slug + '|' + f.name, rel: f.rel, name: f.name, date: f.date ?? null }))
      .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))),
    collisions: (project?.featureCollisions ?? []).map((c) => ({ k: c.slug, slug: c.slug, names: c.names ?? [] })),
  })

  // ---- the Graph panel ---------------------------------------------------------

  /** Branch rows (no branch chosen) or commit rows (one chosen). Absent and
   *  empty are different facts: an absent graph means the relay has not built
   *  one yet, an empty branch list means it built one and there is nothing to
   *  draw. */
  const RECENT = 3
  const OLDER = 'older commits are not loaded'

  const commitRow = (b) => (c) => ({
    k: 'commit:' + c.sha, kind: 'commit', sha7: String(c.sha).slice(0, 7),
    subject: c.subject ?? '', at: c.at ?? 0, merge: (c.parents ?? []).length > 1,
    // The worktree's `head` is the short sha it has checked out.
    head: !!(b.head && String(c.sha).startsWith(b.head)),
  })

  const graphRows = (gitGraph, branch) => {
    if (!gitGraph) return [{ k: 'note', kind: 'note', text: 'history needs a relay restart' }]
    const branches = gitGraph.branches ?? []
    if (!branches.length) return [{ k: 'note', kind: 'note', text: 'no branches to show' }]
    if (!branch) {
      return [...branches]
        .sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0))
        .map((b) => {
          const commits = b.commits ?? []
          const hidden = Math.max(0, commits.length - RECENT)
          return {
            k: 'branch:' + b.name, kind: 'branch', name: b.name, isMain: !!b.isMain,
            head: b.head ?? '', ahead: b.ahead ?? null, behind: b.behind ?? null,
            truncated: !!b.truncated,
            recent: commits.slice(0, RECENT).map(commitRow(b)),
            // A truncated branch has more history than was loaded, so its
            // count is a floor rather than a total.
            more: hidden ? hidden + (b.truncated ? '+' : '') + ' more' : (b.truncated ? OLDER : ''),
          }
        })
    }
    const b = branches.find((x) => x.name === branch)
    if (!b) return [{ k: 'note', kind: 'note', text: 'branch not found' }]
    const rows = (b.commits ?? []).map(commitRow(b))
    if (b.truncated) rows.push({ k: 'note:older', kind: 'note', text: OLDER })
    return rows
  }

  // ---- the needs-a-human fold ---------------------------------------------------

  /** Every fact a project's scan surfaced that a person, not a scan, has to
   *  resolve -- a fact, never a judgement. Folds all five payload sources into
   *  one array so the view renders one list rather than five. */
  const needsHumanCards = (project) => {
    const projName = project?.name ?? project?.key ?? null
    // Every card carries the key of the project it belongs to, and its own
    // key starts with it: the same fact in two projects is two cards, and a
    // walk across the whole board has to know where each one lives.
    const pkey = project ? projectKey(project) : null
    const cards = []
    const push = (card) => cards.push({ ...card, k: pkey + '\u0000' + card.k, projectKey: pkey })
    for (const c of (project?.planCollisions ?? [])) {
      push({
        k: 'planCollision:' + c.worktree + '|' + c.name, kind: 'planCollision', project: projName,
        what: 'two plans share the name "' + c.name + '"', where: c.worktree,
        fix: 'rename one of ' + (c.rels ?? []).join(' or '),
      })
    }
    for (const c of (project?.unresolvedClaims ?? [])) {
      push({
        k: 'unresolvedClaim:' + c.sessionId + '|' + c.kind + '|' + c.id, kind: 'unresolvedClaim', project: projName,
        what: (c.name || 'a session') + ' claims ' + c.kind + ' "' + c.id + '", which does not exist',
        where: c.id, fix: 'fix the claim entry or remove it',
      })
    }
    for (const r of (project?.brokenRefs ?? [])) {
      push({
        k: 'brokenRef:' + r.from + '|' + r.kind + '|' + r.ref, kind: 'brokenRef', project: projName,
        what: r.from + ' names a ' + r.kind + ' reference that does not resolve',
        where: r.ref, fix: 'fix or drop the reference in ' + r.from,
      })
    }
    for (const c of (project?.featureCollisions ?? [])) {
      push({
        k: 'featureCollision:' + c.slug, kind: 'featureCollision', project: projName,
        what: 'two features share one name: ' + (c.names ?? []).join(' / '),
        where: c.slug, fix: 'rename one of ' + (c.names ?? []).join(' or '),
      })
    }
    for (const m of (project?.malformedShipped ?? [])) {
      push({
        k: 'malformedShipped:' + m.rel, kind: 'malformedShipped', project: projName,
        what: m.rel + ' declares a Shipped line with no date',
        where: m.rel, fix: 'write a dated Shipped line or remove it',
      })
    }
    return cards
  }

  /** Every card on the board, project by project in the overview's order, so
   *  the triage walk visits them in the order a person sees the rows. */
  const boardCards = (projects, { lens = 'sessions' } = {}) => {
    const byKey = new Map((projects ?? []).map((p) => [projectKey(p), p]))
    return overviewRows(projects, { lens }).flatMap((r) => needsHumanCards(byKey.get(r.key)))
  }

  // ---- the verbs' request text ------------------------------------------------
  // What the dispatcher reads. Every path comes from the payload row the verb
  // was aimed at, never a directory spelled out here, so a project that keeps
  // its plans or its backlog somewhere else still gets an ask naming the file
  // that exists.

  const REQUEST_TITLE_MAX = 80

  const requestTitle = (text) => String(text ?? '').trim().slice(0, REQUEST_TITLE_MAX) || 'untitled'

  /** Plan a backlog heading (`rel` + `slug`) or a spec (`rel` alone). Null
   *  when there is no file to name. */
  const planAsk = ({ rel, slug, text } = {}) => {
    if (!rel) return null
    return slug ? 'Plan ' + rel + '#' + slug + ': ' + text : 'Plan a change described by ' + rel + ': ' + text
  }

  /** Implement an existing plan as written, with no scoping pass. */
  const implementAsk = (effort) => (effort?.rel
    ? 'Implement ' + effort.rel + ' exactly as written; the plan and its spec already exist — bank without scoping'
    : null)

  /** Every session present in a project's worktrees. */
  const liveSessionIds = (project) =>
    (project?.worktrees ?? []).flatMap((w) => (w.sessions ?? []).map((s) => s.id))

  // ---- scoping an ask to a project --------------------------------------------

  const askScoped = (text, scope) => ({
    text, opts: scope?.project ? { scope: { project: scope.project } } : {},
  })

  // ---- overview and rail rows --------------------------------------------------

  /** In-flight effort count, off the digest's own exact tally -- never the
   *  capped `efforts` list the digest also carries, which undercounts once a
   *  board has more live effort than the cap. */
  const inFlightCount = (p) => p?.counts?.inFlight ?? 0

  /** The five needs-a-human counts, summed. `0` for a digest predating the
   *  field. */
  const FLAG_KEYS = ['planCollisions', 'unresolvedClaims', 'brokenRefs', 'featureCollisions', 'malformedShipped']
  const needsCount = (d) => {
    const flags = d?.flags
    if (!flags) return 0
    return FLAG_KEYS.reduce((n, k) => n + (flags[k] ?? 0), 0)
  }

  const overviewRowOf = (p) => {
    const key = projectKey(p)
    const worktrees = p?.worktrees ?? []
    // Each session keeps the worktree it sits in, so a chip can say where.
    const sessions = worktrees.flatMap((w) => (w.sessions ?? []).map((s) => ({ ...s, cwd: w.path ?? null })))
    return {
      k: key, key, name: p?.name ?? key, root: p?.mainRoot ?? null,
      sessions, live: sessions.length,
      inFlight: inFlightCount(p),
      backlog: p?.counts?.backlogSections ?? 0,
      behind: p?.counts?.behind ?? 0,
      worktrees: worktrees.length,
      needs: needsCount(p),
    }
  }

  const LENS_KEY = {
    sessions: (r) => r.live,
    todos: (r) => r.backlog,
    efforts: (r) => r.inFlight,
    git: (r) => r.behind,
  }

  /** One row per project, reordered by lens -- the same set of projects every
   *  time, so switching lenses never hides or invents a row.
   *
   *  The lens's own column first, then live sessions, then in flight, then
   *  name, then key. Nothing the comparator reads flickers inside a payload
   *  tick: `live` counts sessions PRESENT, never sessions whose `working` flag
   *  happens to be true this instant, so a row does not hop while an agent
   *  starts and stops. The key is last so two projects sharing a name still
   *  sort the same way every time. */
  const overviewRows = (projects, { lens = 'sessions' } = {}) => {
    const rows = (projects ?? []).map(overviewRowOf)
    const key = LENS_KEY[lens] ?? LENS_KEY.sessions
    return rows.sort((a, b) =>
      key(b) - key(a) || b.live - a.live || b.inFlight - a.inFlight ||
      String(a.name).localeCompare(String(b.name)) || String(a.k).localeCompare(String(b.k)))
  }

  /** The sidebar: the overview shrunk. The SAME rows, in the same order and
   *  under the same keys, with the isolated project marked -- so the view can
   *  carry each overview node into the rail rather than build a second set. */
  const railRows = (projects, activeKey, { lens = 'sessions' } = {}) =>
    overviewRows(projects, { lens }).map((r) => ({ ...r, active: r.key === activeKey }))

  // ---- fetching a project's document -------------------------------------------

  /** Which project document a view needs to fetch next, and what to say
   *  while it waits -- pure, no fetch: the view owns the request and keeps
   *  the answer in its own cache, keyed by project key, as
   *  `{ status: 'loading' | 'ok' | 'missing' | 'error', changedAt, project }`.
   *  A cached document at the digest's own `changedAt` needs nothing; one at
   *  an older stamp is asked for again, but its stale document is still
   *  handed back so a view never blanks while the refetch is in flight. */
  const docNeed = (digestProject, entry) => {
    const key = projectKey(digestProject)
    if (!entry) return { need: key, note: 'loading…', project: null }
    if (entry.status === 'ok') {
      if (entry.changedAt === digestProject?.changedAt) return { need: null, note: null, project: entry.project }
      return { need: key, note: null, project: entry.project }
    }
    if (entry.status === 'loading') {
      return entry.project
        ? { need: null, note: null, project: entry.project }
        : { need: null, note: 'loading…', project: null }
    }
    if (entry.status === 'missing') return { need: null, note: 'unavailable on this relay', project: null }
    if (entry.status === 'error') return { need: null, note: 'could not be read', project: entry.project ?? null }
    return { need: key, note: 'loading…', project: null }
  }

  /** Which documents a view must fetch, and which cached ones to drop, given
   *  the digest it just received and the cache it holds (a Map from project
   *  key to `{ status, changedAt, ... }`). `want` is an array of keys, or
   *  `'all'` for every project on the digest. A wanted key is fetched when
   *  the cache holds nothing for it, or holds a settled entry -- a document,
   *  a 404 or a failure -- recorded at a different changedAt; one already
   *  loading is never fetched twice, and a settled failure is not re-asked
   *  until the project moves, so a relay that answers 404 is asked once per
   *  change rather than on every render. A wanted key the digest does not
   *  carry is not fetched; a cached key the digest does not carry is evicted.
   *  Pure: reads the cache, never writes it. */
  const docPlan = (digest, cache, { want } = {}) => {
    const stamps = new Map()
    for (const p of (Array.isArray(digest) ? digest : [])) stamps.set(projectKey(p), p?.changedAt ?? null)
    const keys = want === 'all' ? [...stamps.keys()] : (Array.isArray(want) ? want : [])
    // Duck-typed rather than `instanceof Map`: a Map made in another realm is
    // still a Map to read.
    const held = cache && typeof cache.get === 'function' && typeof cache.keys === 'function' ? cache : new Map()
    const fetch = []
    for (const key of keys) {
      if (!stamps.has(key) || fetch.includes(key)) continue
      const entry = held.get(key)
      if (entry?.status === 'loading') continue
      if (entry && (entry.changedAt ?? null) === stamps.get(key)) continue
      fetch.push(key)
    }
    const evict = [...held.keys()].filter((key) => !stamps.has(key))
    return { fetch, evict }
  }

  // ---- the drill-down level reducer --------------------------------------------

  const initialState = () => ({ level: 0, project: null, branch: null, lens: 'sessions', triage: false, triageAt: 0 })

  /** Level 0 is the overview, 1 is one isolated project, 2 is one branch
   *  within it. A change returns a NEW object; a no-op returns the SAME
   *  object, which is what lets the view skip a render on an action that
   *  changed nothing. Never mutates its argument. */
  const levelReduce = (state, action) => {
    switch (action?.type) {
      case 'isolate': {
        if (state.level === 1 && state.project === action.project && state.branch === null) return state
        return { ...state, level: 1, project: action.project, branch: null }
      }
      case 'branch':
        return state.level === 1 ? { ...state, level: 2, branch: action.branch } : state
      case 'back':
        if (state.level === 2) return { ...state, level: 1, branch: null }
        if (state.level === 1) return { ...state, level: 0, project: null }
        return state
      case 'crumb': {
        const to = action.to
        if (to >= state.level) return state
        if (to === 0) return { ...state, level: 0, project: null, branch: null }
        return { ...state, level: 1, branch: null }
      }
      case 'lens':
        return action.lens === state.lens ? state : { ...state, lens: action.lens }
      case 'vanish': {
        if (!state.project) return state
        return (action.keys ?? []).includes(state.project) ? state : { ...state, level: 0, project: null, branch: null }
      }
      case 'triage': {
        const on = !!action.on
        return on === !!state.triage ? state : { ...state, triage: on, triageAt: 0 }
      }
      case 'triageStep': {
        // The walk turns triage on, lands on a card, and isolates that card's
        // project. The first step lands on the first card going forward and
        // the last going back, so no card is skipped on the way in; after
        // that it wraps at both ends. A board that shrank beneath the cursor
        // clamps before stepping.
        const cards = action.cards ?? []
        const n = cards.length
        if (!n) return state
        const dir = action.dir < 0 ? -1 : 1
        const from = Math.min(Math.max(0, state.triageAt ?? 0), n - 1)
        const at = state.triage ? ((from + dir) % n + n) % n : (dir < 0 ? n - 1 : 0)
        const key = cards[at]?.projectKey ?? null
        const next = key
          ? { ...state, triage: true, triageAt: at, level: 1, project: key, branch: null }
          : { ...state, triage: true, triageAt: at }
        const same = next.triage === state.triage && next.triageAt === state.triageAt &&
          next.level === state.level && next.project === state.project && next.branch === state.branch
        return same ? state : next
      }
      default:
        return state
    }
  }

  return {
    LENSES,
    projectKey,
    initialState,
    levelReduce,
    overviewRows,
    railRows,
    effortProgress,
    planIndexOf,
    todosOf,
    liveClaims,
    planIsMine,
    effortStepsView,
    worktreesOf,
    panelOrder,
    plannedOf,
    featuresOf,
    graphRows,
    needsCount,
    needsHumanCards,
    boardCards,
    docNeed,
    docPlan,
    requestTitle,
    planAsk,
    implementAsk,
    liveSessionIds,
    askScoped,
  }
})()
