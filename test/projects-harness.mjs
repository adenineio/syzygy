// Drives the Projects tab's pure core (projects-model.js, global MCPM) under
// node, the way test/dispatch-harness.mjs drives MCD -- a classic script with
// no DOM, evaluated with vm.runInNewContext against a bare {} context. The
// fixture is a real /api/state capture, neutralised: see
// test/fixtures/projects/state.json. The model reads the relay's DIGEST and
// DOCUMENT (tasks-digest.mjs), never the fat scan, so both are built from the
// fixture once here and handed to every test below.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestProjects, documentProjects } from '../syzygy/bridge/tasks-digest.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const vm = await import('node:vm')

const src = readFileSync(join(ROOT, 'syzygy', 'bridge', 'public', 'projects-model.js'), 'utf8')
const MCPM = vm.runInNewContext(src + '\n;MCPM', {})

// Values crossing a vm realm carry that realm's prototypes and fail
// deepEqual against outer-realm literals (verified: `vm.runInNewContext('[]',
// {})` fails deepEqual against a literal `[]`, even though every value
// matches). A JSON round-trip discards which realm made the object and
// leaves only plain data, so deepEqual can be used at all here.
const plain = (v) => JSON.parse(JSON.stringify(v))

const STATE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'projects', 'state.json'), 'utf8'))
const P = STATE.projects[0]
const CLEAN = STATE.projects[1]

const NOW = 1_700_500_000_000
const DIGEST = plain(digestProjects(STATE.projects, { now: NOW }))
const DOCUMENT = plain(documentProjects(STATE.projects, { now: NOW }))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }

// ---- reference implementations, pinned from before the model moved onto the
// digest and document -- harness-only, used only to check the new digest- and
// document-reading functions against the old fat-scan derivations they
// replace. Never call these from the model itself. ---------------------------

const refBase = (rel) => String(rel).slice(String(rel).lastIndexOf('/') + 1)

const refDedupeBacklogSections = (worktrees) => {
  const byId = new Map()
  const order = []
  for (const w of worktrees ?? []) {
    for (const t of (w.tasks ?? [])) {
      if (t.absent) continue
      for (const it of (t.items ?? [])) {
        if (it.kind !== 'section' || it.absent) continue
        let hit = byId.get(it.id)
        if (!hit) {
          hit = { id: it.id, text: it.text, slug: it.slug ?? null, claimedBy: [] }
          byId.set(it.id, hit)
          order.push(it.id)
        }
        for (const c of (it.claimedBy ?? [])) {
          if (!hit.claimedBy.some((x) => x.id === c.id)) hit.claimedBy.push(c)
        }
      }
    }
  }
  return order.map((id) => byId.get(id))
}

const refInFlightCount = (p) => {
  const efforts = p.efforts ?? null
  if (efforts) return efforts.filter((e) => e.live).length
  const plans = (p.worktrees ?? []).flatMap((w) => (w.plans ?? []).filter((pl) => !pl.absent))
  return plans.filter((pl) => pl.done < pl.total && !pl.shipped).length
}

const refProjectKey = (p) => p?.key ?? p?.name ?? p?.mainRoot ?? 'project'

const refNeedsCards = (project) => {
  const projName = project?.name ?? project?.key ?? null
  const pkey = project ? refProjectKey(project) : null
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

const refOverviewRowOf = (p) => {
  const key = refProjectKey(p)
  const worktrees = p.worktrees ?? []
  const sessions = worktrees.flatMap((w) => (w.sessions ?? []).map((s) => ({ ...s, cwd: w.path ?? null })))
  const efforts = p.efforts ?? null
  return {
    k: key, key, name: p.name ?? key, root: p.mainRoot ?? null,
    sessions, live: sessions.length,
    inFlight: refInFlightCount(p),
    backlog: refDedupeBacklogSections(worktrees).length,
    behind: efforts ? efforts.reduce((n, e) => n + (e.behind ?? 0), 0) : 0,
    worktrees: worktrees.length,
    needs: refNeedsCards(p).length,
  }
}

const REF_LENS_KEY = {
  sessions: (r) => r.live,
  todos: (r) => r.backlog,
  efforts: (r) => r.inFlight,
  git: (r) => r.behind,
}

const refOverviewRows = (projects, { lens = 'sessions' } = {}) => {
  const rows = (projects ?? []).map(refOverviewRowOf)
  const key = REF_LENS_KEY[lens] ?? REF_LENS_KEY.sessions
  return rows.sort((a, b) =>
    key(b) - key(a) || b.live - a.live || b.inFlight - a.inFlight ||
    String(a.name).localeCompare(String(b.name)) || String(a.k).localeCompare(String(b.k)))
}

const refBoardCards = (projects, { lens = 'sessions' } = {}) => {
  const byKey = new Map((projects ?? []).map((p) => [refProjectKey(p), p]))
  return refOverviewRows(projects, { lens }).flatMap((r) => refNeedsCards(byKey.get(r.key)))
}

const refPlanIndexOf = (project) => {
  const idx = new Map()
  const worktrees = project?.worktrees ?? []
  const ordered = [...worktrees.filter((w) => w.isMain), ...worktrees.filter((w) => !w.isMain)]
  for (const w of ordered) {
    for (const p of (w.plans ?? [])) {
      if (p.absent) continue
      const name = refBase(p.rel)
      if (idx.has(name)) continue
      idx.set(name, {
        rel: p.rel, basename: name, title: p.title ?? null, spec: p.spec ?? null,
        resolvedSpec: p.resolvedSpec ?? null, resolvedTasks: p.resolvedTasks ?? [],
        absent: false,
      })
    }
  }
  return idx
}

const REF_STRUCK = /^~~(.*)~~$/

const refBacklogDetail = (worktrees) => {
  const out = new Map()
  for (const w of worktrees ?? []) {
    for (const t of (w.tasks ?? [])) {
      if (t.absent) continue
      let cur = null
      for (const it of (t.items ?? [])) {
        if (it.kind === 'section') {
          cur = null
          if (it.absent || out.has(it.id)) continue
          cur = { rel: t.rel ?? null, body: [] }
          out.set(it.id, cur)
        } else if (cur && !it.absent) {
          cur.body.push({ k: it.id, id: it.id, text: it.text ?? '', checked: it.checked ?? null, reported: !!it.reported })
        }
      }
    }
  }
  return out
}

const refTodos = (project) => {
  const worktrees = project?.worktrees ?? []
  const detail = refBacklogDetail(worktrees)
  const backlog = refDedupeBacklogSections(worktrees).map((b) => {
    const struck = REF_STRUCK.exec(String(b.text ?? '').trim())
    const d = detail.get(b.id)
    return {
      ...b, k: b.id, rel: d?.rel ?? null,
      struck: !!struck, label: struck ? struck[1].trim() : b.text, body: d?.body ?? [],
    }
  })
  const planIndex = refPlanIndexOf(project)
  const efforts = (project?.efforts ?? []).map((e) => {
    const plan = planIndex.get(e.name)
    const taskChips = (plan?.resolvedTasks ?? []).map((t) =>
      t.broken ? { broken: true } : { ref: t.ref, slug: t.slug, text: t.text, broken: false })
    const rs = plan?.resolvedSpec
    const specOk = !!(rs && !rs.broken)
    return {
      k: e.name, name: e.name, title: e.title || e.name, rel: e.rel, at: e.at ?? null,
      progress: MCPM.effortProgress(e), current: e.currentItem ?? null,
      behind: e.behind ?? 0, shipped: e.shipped ?? null,
      claimedBy: e.claimedBy ?? [], taskChips,
      spec: specOk ? (rs.ref ?? plan.spec ?? null) : null,
      specTitle: specOk ? (rs.title ?? null) : null,
    }
  })
  return { backlog, efforts }
}

const refWorktreeDiff = (w) => {
  const diff = Object.fromEntries(['only-here', 'removed', 'done-here', 'behind'].map((d) => [d, 0]))
  const count = (x) => { if (x && Object.prototype.hasOwnProperty.call(diff, x.diff)) diff[x.diff]++ }
  for (const p of (w.plans ?? [])) count(p)
  for (const t of (w.tasks ?? [])) for (const it of (t.items ?? [])) count(it)
  return diff
}

// ---- levelReduce ------------------------------------------------------------
// Pure state machine, no project shape involved.

await ok('isolate sets level 1 and the project', () => {
  const s0 = MCPM.initialState()
  const s1 = MCPM.levelReduce(s0, { type: 'isolate', project: 'alpha' })
  assert.equal(s1.level, 1)
  assert.equal(s1.project, 'alpha')
  assert.deepEqual(plain(s0), plain(MCPM.initialState()), 'the input state must not be mutated')
})

await ok('branch from level 1 sets level 2 and the branch', () => {
  const s1 = { ...MCPM.initialState(), level: 1, project: 'alpha' }
  const before = plain(s1)
  const s2 = MCPM.levelReduce(s1, { type: 'branch', branch: 'main' })
  assert.equal(s2.level, 2)
  assert.equal(s2.branch, 'main')
  assert.deepEqual(plain(s1), before, 'the input state must not be mutated')
})

await ok('branch is a no-op outside level 1', () => {
  const s0 = MCPM.initialState()
  const out = MCPM.levelReduce(s0, { type: 'branch', branch: 'main' })
  assert.equal(out, s0, 'a no-op must return the SAME object')
})

await ok('back from 2 returns to 1, keeping project and clearing branch', () => {
  const s2 = { ...MCPM.initialState(), level: 2, project: 'alpha', branch: 'main' }
  const before = plain(s2)
  const s1 = MCPM.levelReduce(s2, { type: 'back' })
  assert.equal(s1.level, 1)
  assert.equal(s1.project, 'alpha')
  assert.equal(s1.branch, null)
  assert.deepEqual(plain(s2), before, 'the input state must not be mutated')
})

await ok('back from 1 returns to 0, clearing project', () => {
  const s1 = { ...MCPM.initialState(), level: 1, project: 'alpha' }
  const s0 = MCPM.levelReduce(s1, { type: 'back' })
  assert.equal(s0.level, 0)
  assert.equal(s0.project, null)
})

await ok('back from 0 returns the SAME object', () => {
  const s0 = MCPM.initialState()
  const out = MCPM.levelReduce(s0, { type: 'back' })
  assert.equal(out, s0, 'the view\'s render skip depends on reference equality')
})

await ok('crumb to 0 from level 2 lands at 0', () => {
  const s2 = { ...MCPM.initialState(), level: 2, project: 'alpha', branch: 'main' }
  const before = plain(s2)
  const out = MCPM.levelReduce(s2, { type: 'crumb', to: 0 })
  assert.equal(out.level, 0)
  assert.equal(out.project, null)
  assert.equal(out.branch, null)
  assert.deepEqual(plain(s2), before, 'the input state must not be mutated')
})

await ok('lens only changes lens', () => {
  const s1 = { ...MCPM.initialState(), level: 1, project: 'alpha', branch: null }
  const before = plain(s1)
  const out = MCPM.levelReduce(s1, { type: 'lens', lens: 'todos' })
  assert.equal(out.lens, 'todos')
  assert.equal(out.level, s1.level)
  assert.equal(out.project, s1.project)
  assert.deepEqual(plain(s1), before, 'the input state must not be mutated')
})

await ok('lens is a no-op when it names the current lens', () => {
  const s0 = MCPM.initialState()
  const out = MCPM.levelReduce(s0, { type: 'lens', lens: s0.lens })
  assert.equal(out, s0, 'a no-op must return the SAME object')
})

await ok('an unknown action type returns the SAME object', () => {
  const s0 = MCPM.initialState()
  const out = MCPM.levelReduce(s0, { type: 'not-a-real-action' })
  assert.equal(out, s0)
})

await ok('vanish drops to level 0 when the isolated project is gone', () => {
  const s1 = { ...MCPM.initialState(), level: 1, project: 'alpha' }
  const before = plain(s1)
  const out = MCPM.levelReduce(s1, { type: 'vanish', keys: ['beta'] })
  assert.equal(out.level, 0)
  assert.equal(out.project, null)
  assert.deepEqual(plain(s1), before, 'the input state must not be mutated')
})

await ok('vanish changes nothing when the isolated project is still in the key list', () => {
  const s1 = { ...MCPM.initialState(), level: 1, project: 'alpha' }
  const out = MCPM.levelReduce(s1, { type: 'vanish', keys: ['alpha', 'beta'] })
  assert.equal(out, s1, 'a no-op must return the SAME object')
})

await ok('triageStep wraps at both ends of the card array', () => {
  const cards = [{ k: 'a' }, { k: 'b' }, { k: 'c' }]
  const s0 = { ...MCPM.initialState(), triage: true, triageAt: 0 }
  const forward = MCPM.levelReduce(s0, { type: 'triageStep', dir: 1, cards })
  assert.equal(forward.triageAt, 1)
  const backward = MCPM.levelReduce(s0, { type: 'triageStep', dir: -1, cards })
  assert.equal(backward.triageAt, 2, 'stepping back from 0 wraps to the last card')
  const atEnd = { ...s0, triageAt: 2 }
  const wrapsForward = MCPM.levelReduce(atEnd, { type: 'triageStep', dir: 1, cards })
  assert.equal(wrapsForward.triageAt, 0, 'stepping forward from the last card wraps to the first')
})

await ok('triageStep is a no-op on an empty card array', () => {
  const s0 = MCPM.initialState()
  const out = MCPM.levelReduce(s0, { type: 'triageStep', dir: 1, cards: [] })
  assert.equal(out, s0, 'a no-op must return the SAME object')
})

await ok('triageStep from the last card lands on the first and isolates that card\'s project', () => {
  const cards = [{ k: 'a', projectKey: 'pa' }, { k: 'b', projectKey: 'pb' }]
  const s = { ...MCPM.initialState(), triage: true, triageAt: 1, level: 1, project: 'pb' }
  const out = MCPM.levelReduce(s, { type: 'triageStep', dir: 1, cards })
  assert.equal(out.triageAt, 0)
  assert.equal(out.level, 1)
  assert.equal(out.project, 'pa')
  assert.equal(out.branch, null)
  assert.equal(out.triage, true)
})

await ok('triageStep backwards from the first card lands on the last and isolates its project', () => {
  const cards = [{ k: 'a', projectKey: 'pa' }, { k: 'b', projectKey: 'pb' }]
  const s = { ...MCPM.initialState(), triage: true, triageAt: 0, level: 2, project: 'pa', branch: 'main' }
  const out = MCPM.levelReduce(s, { type: 'triageStep', dir: -1, cards })
  assert.equal(out.triageAt, 1)
  assert.equal(out.project, 'pb')
  assert.equal(out.level, 1)
  assert.equal(out.branch, null)
})

await ok('the first step into triage lands on the first card forward and the last card back', () => {
  const cards = [{ k: 'a', projectKey: 'pa' }, { k: 'b', projectKey: 'pb' }, { k: 'c', projectKey: 'pc' }]
  const s0 = MCPM.initialState()
  const fwd = MCPM.levelReduce(s0, { type: 'triageStep', dir: 1, cards })
  assert.deepEqual([fwd.triage, fwd.triageAt, fwd.level, fwd.project], [true, 0, 1, 'pa'])
  const back = MCPM.levelReduce(s0, { type: 'triageStep', dir: -1, cards })
  assert.deepEqual([back.triage, back.triageAt, back.project], [true, 2, 'pc'])
})

await ok('triageStep on a board that shrank beneath the cursor stays inside it', () => {
  const cards = [{ k: 'a', projectKey: 'pa' }]
  const s = { ...MCPM.initialState(), triage: true, triageAt: 4, level: 1, project: 'gone' }
  const out = MCPM.levelReduce(s, { type: 'triageStep', dir: 1, cards })
  assert.equal(out.triageAt, 0)
  assert.equal(out.project, 'pa')
})

await ok('triage off clears triage without changing the level', () => {
  const s = { ...MCPM.initialState(), triage: true, triageAt: 2, level: 2, project: 'pa', branch: 'main' }
  const out = MCPM.levelReduce(s, { type: 'triage', on: false })
  assert.equal(out.triage, false)
  assert.equal(out.level, 2)
  assert.equal(out.project, 'pa')
  assert.equal(out.branch, 'main')
})

// ---- overviewRows, against the digest -----------------------------------

await ok('overviewRows returns one row per project with a unique k and a numeric needs', () => {
  const rows = MCPM.overviewRows(DIGEST, { lens: 'sessions' })
  assert.equal(rows.length, DIGEST.length)
  const ks = new Set(rows.map((r) => r.k))
  assert.equal(ks.size, rows.length, 'every row key must be unique')
  for (const r of rows) assert.equal(typeof r.needs, 'number')
})

await ok('the four lenses reorder the same set of rows', () => {
  const orders = MCPM.LENSES.map((lens) => MCPM.overviewRows(DIGEST, { lens }).map((r) => r.k))
  const sets = orders.map((o) => [...o].sort())
  for (let i = 1; i < sets.length; i++) assert.deepEqual(sets[i], sets[0], 'every lens must show the same projects')
})

await ok('overviewRows gives the identical order on two consecutive calls over one payload', () => {
  for (const lens of MCPM.LENSES) {
    const a = MCPM.overviewRows(DIGEST, { lens }).map((r) => r.k)
    const b = MCPM.overviewRows(DIGEST, { lens }).map((r) => r.k)
    assert.deepEqual(b, a, `lens ${lens} must not reorder between calls`)
  }
})

await ok('overviewRows does not reorder when a working flag flickers', () => {
  const flipped = JSON.parse(JSON.stringify(DIGEST))
  for (const p of flipped) for (const w of p.worktrees) for (const s of w.sessions) s.working = !s.working
  assert.deepEqual(
    MCPM.overviewRows(flipped).map((r) => r.k),
    MCPM.overviewRows(DIGEST).map((r) => r.k),
  )
})

await ok('overviewRows sorts live sessions, then in flight, then name', () => {
  const mk = (key, name, sessions, live) => ({
    key, name, efforts: Array.from({ length: live }, (_, i) => ({ name: key + i, live: true })),
    worktrees: [{ path: '/w/' + key, sessions: Array.from({ length: sessions }, (_, i) => ({ id: key + i, name: 'n' })) }],
  })
  const board = digestProjects([
    mk('c', 'zeta', 0, 5), mk('a', 'beta', 1, 0), mk('b', 'alpha', 0, 5), mk('d', 'gamma', 2, 0),
  ], { now: NOW })
  const rows = MCPM.overviewRows(board)
  assert.deepEqual(rows.map((r) => r.k), ['d', 'a', 'b', 'c'])
  // A lens puts its own column first and falls back to the same chain.
  const byEfforts = MCPM.overviewRows(board, { lens: 'efforts' })
  assert.deepEqual(byEfforts.map((r) => r.k), ['b', 'c', 'd', 'a'])
})

await ok('an overview row keeps each session\'s worktree path', () => {
  const row = MCPM.overviewRows(DIGEST).find((r) => r.key === P.key)
  assert.equal(row.sessions.length, 1)
  assert.equal(row.sessions[0].cwd, P.worktrees[0].path)
})

await ok('railRows carries the overview\'s keys in the overview\'s order, marking the isolated one', () => {
  const over = MCPM.overviewRows(DIGEST).map((r) => r.k)
  const rail = MCPM.railRows(DIGEST, CLEAN.key)
  assert.deepEqual(rail.map((r) => r.k), over)
  assert.deepEqual(rail.filter((r) => r.active).map((r) => r.k), [CLEAN.key])
})

await ok('overviewRows(DIGEST) matches refOverviewRows(STATE.projects) row for row, key for key', () => {
  assert.deepEqual(plain(MCPM.overviewRows(DIGEST)), plain(refOverviewRows(STATE.projects)))
  for (const lens of MCPM.LENSES) {
    assert.deepEqual(plain(MCPM.overviewRows(DIGEST, { lens })), plain(refOverviewRows(STATE.projects, { lens })), lens)
  }
})

await ok('worktreesOf(DIGEST[0]) carries the same diff counts as a reference count over the fat scan\'s plans and tasks', () => {
  const rows = MCPM.worktreesOf(DIGEST[0])
  assert.equal(rows.length, P.worktrees.length)
  assert.deepEqual(plain(rows.map((r) => r.diff)), P.worktrees.map(refWorktreeDiff))
})

await ok('needsCount(DIGEST[0]) matches refNeedsCards(STATE.projects[0]).length', () => {
  assert.equal(MCPM.needsCount(DIGEST[0]), refNeedsCards(P).length)
})

await ok('needsCount tolerates a digest missing flags entirely', () => {
  const clone = plain(DIGEST[0])
  delete clone.flags
  assert.equal(MCPM.needsCount(clone), 0)
  assert.equal(MCPM.needsCount(undefined), 0)
  assert.equal(MCPM.needsCount(null), 0)
})

// ---- needsHumanCards / boardCards, against the document --------------------

await ok('needsHumanCards(DOCUMENT[0]) folds all five sources with a unique k each, and matches refNeedsCards', () => {
  const cards = MCPM.needsHumanCards(DOCUMENT[0])
  const kinds = new Set(cards.map((c) => c.kind))
  for (const k of ['planCollision', 'unresolvedClaim', 'brokenRef', 'featureCollision', 'malformedShipped']) {
    assert.ok(kinds.has(k), `expected a ${k} card in the fixture`)
  }
  const ks = new Set(cards.map((c) => c.k))
  assert.equal(ks.size, cards.length, 'every card key must be unique')
  assert.deepEqual(plain(cards), plain(refNeedsCards(P)), 'the cards themselves, from the document')
})

await ok('needsHumanCards returns [] for a project with none', () => {
  assert.deepEqual(plain(MCPM.needsHumanCards(DOCUMENT[1])), [])
})

await ok('every card names the project key it belongs to', () => {
  for (const c of MCPM.needsHumanCards(DOCUMENT[0])) assert.equal(c.projectKey, P.key)
})

await ok('boardCards(DOCUMENT) matches the reference over STATE.projects', () => {
  const twinDoc = { ...JSON.parse(JSON.stringify(DOCUMENT[0])), key: '/work/twin', name: 'twin' }
  const twinFat = { ...JSON.parse(JSON.stringify(P)), key: '/work/twin', name: 'twin' }
  const docs = [DOCUMENT[1], DOCUMENT[0], twinDoc]
  const fats = [CLEAN, P, twinFat]
  const cards = MCPM.boardCards(docs)
  assert.deepEqual(plain(cards), plain(refBoardCards(fats)))
  const perProject = MCPM.needsHumanCards(DOCUMENT[0]).length
  assert.equal(cards.length, perProject * 2)
  assert.equal(new Set(cards.map((c) => c.k)).size, cards.length, 'the same fact in two projects is two cards')
})

// ---- effortProgress ---------------------------------------------------------
// Pure, no project shape involved.

await ok('effortProgress reproduces the three-state ladder when something is reported', () => {
  assert.equal(MCPM.effortProgress({ done: 12, reported: 3, total: 36 }), '12 verified · 3 reported · 21 to do')
})

await ok('effortProgress reads plain done/total when nothing is reported', () => {
  assert.equal(MCPM.effortProgress({ done: 12, reported: 0, total: 36 }), '12/36')
})

// ---- todosOf, against the document -------------------------------------------

await ok('todosOf returns two arrays and never a percentage', () => {
  const { backlog, efforts } = MCPM.todosOf(DOCUMENT[0])
  assert.ok(Array.isArray(backlog))
  assert.ok(Array.isArray(efforts))
  for (const e of efforts) assert.ok(!String(e.progress).includes('%'))
})

await ok('todosOf(DOCUMENT[0]) returns the same backlog rows, in the same order, as refTodos(STATE.projects[0])', () => {
  const mine = MCPM.todosOf(DOCUMENT[0]).backlog
    .map(({ id, rel, struck, label, body, claimedBy }) => ({ id, rel, struck, label, body, claimedBy }))
  const ref = refTodos(P).backlog
    .map(({ id, rel, struck, label, body, claimedBy }) => ({ id, rel, struck, label, body, claimedBy }))
  assert.deepEqual(plain(mine), plain(ref))
})

await ok('todosOf reports an empty claimedBy as [], not null', () => {
  const { efforts } = MCPM.todosOf(DOCUMENT[0])
  const shared = efforts.find((e) => e.name === 'shared-plan.md')
  assert.ok(shared)
  assert.deepEqual(plain(shared.claimedBy), [])
})

await ok('todosOf carries the shipped badge onto its effort row', () => {
  const { efforts } = MCPM.todosOf(DOCUMENT[0])
  const shipped = efforts.find((e) => e.name === 'shipped-plan.md')
  assert.ok(shipped)
  assert.deepEqual(plain(shipped.shipped), { date: '2026-01-02', commit: 'aa11bb2' })
})

await ok('todosOf draws taskChips from the matching plan\'s resolvedTasks, keeping a broken entry', () => {
  const { efforts } = MCPM.todosOf(DOCUMENT[0])
  const broken = efforts.find((e) => e.name === 'broken-plan.md')
  assert.ok(broken)
  const chips = broken.taskChips
  assert.equal(chips.length, 2)
  assert.deepEqual(plain(chips.find((c) => c.broken === true)), { broken: true })
  assert.ok(chips.some((c) => c.broken === false && c.text === 'Backlog item one'))
})

await ok('an effort that exists in more than one worktree reports behind', () => {
  const { efforts } = MCPM.todosOf(DOCUMENT[0])
  const shared = efforts.find((e) => e.name === 'shared-plan.md')
  assert.equal(shared.behind, 1)
})

await ok('todosOf gives each backlog row its file, a key, and no strike for a plain heading', () => {
  const { backlog } = MCPM.todosOf(DOCUMENT[0])
  assert.deepEqual(plain(backlog.map((b) => [b.k, b.rel, b.struck, b.label])), [
    ['backlog-one', 'docs/TASKS.md', false, 'Backlog item one'],
    ['backlog-two', 'docs/TASKS.md', false, 'Backlog item two'],
  ])
})

await ok('todosOf strikes a struck heading and gives it the steps beneath it', () => {
  const [doc] = documentProjects([{
    worktrees: [{
      path: '/w', tasks: [{ rel: 'TASKS.md', items: [
        { id: 'a', kind: 'section', text: '~~Old idea~~' },
        { id: 'a1', kind: 'step', text: 'first', checked: false },
        { id: 'a2', kind: 'step', text: 'second', checked: true },
        { id: 'b', kind: 'section', text: 'Next idea' },
      ] }],
    }],
  }], { now: NOW })
  const { backlog } = MCPM.todosOf(plain(doc))
  assert.equal(backlog[0].struck, true)
  assert.equal(backlog[0].label, 'Old idea')
  assert.deepEqual(plain(backlog[0].body.map((i) => i.id)), ['a1', 'a2'])
  assert.deepEqual(plain(backlog[1].body), [])
})

await ok('todosOf carries an effort\'s declared spec so it can be planned against', () => {
  const { efforts } = MCPM.todosOf(DOCUMENT[0])
  const alpha = efforts.find((e) => e.name === 'alpha-plan.md')
  assert.equal(alpha.spec, 'docs/specs/alpha-spec.md')
  assert.equal(alpha.specTitle, 'Alpha spec')
  const broken = efforts.find((e) => e.name === 'broken-plan.md')
  assert.equal(broken.spec, null, 'a spec that does not resolve is not something to plan against')
})

await ok('todosOf tolerates a document missing backlog entirely', () => {
  const clone = plain(DOCUMENT[0])
  delete clone.backlog
  assert.deepEqual(plain(MCPM.todosOf(clone).backlog), [])
  assert.deepEqual(plain(MCPM.todosOf(undefined)), { backlog: [], efforts: [] })
})

// ---- planIsMine ---------------------------------------------------------------

await ok('planIsMine reads touched from itemsDiffer, and null for no copy or an absent one', () => {
  const fold = { copies: [{ wt: '/w', itemsDiffer: true, done: 0, reported: 0, label: 'ahead' }] }
  assert.equal(MCPM.planIsMine(fold, 's1', false, '/w'), 'touched')

  const same = { copies: [{ wt: '/w', itemsDiffer: false, done: 0, reported: 0, label: 'same' }] }
  assert.equal(MCPM.planIsMine(same, 's1', false, '/w'), null)

  const noCopy = { copies: [{ wt: '/other', itemsDiffer: true, label: 'ahead' }] }
  assert.equal(MCPM.planIsMine(noCopy, 's1', false, '/w'), null)

  const absent = { copies: [{ wt: '/w', label: 'absent', itemsDiffer: true }] }
  assert.equal(MCPM.planIsMine(absent, 's1', false, '/w'), null)
})

await ok('planIsMine reads touched from reported or verified progress, but only in the main worktree', () => {
  const fold = { copies: [{ wt: '/w', itemsDiffer: false, done: 1, reported: 0, label: 'same' }] }
  assert.equal(MCPM.planIsMine(fold, 's1', true, '/w'), 'touched')
  assert.equal(MCPM.planIsMine(fold, 's1', false, '/w'), null)
})

await ok('planIsMine\'s claim and checked precedence outranks a diff, whatever the copies say', () => {
  const claimed = { copies: [{ wt: '/w', itemsDiffer: false, done: 0, reported: 0, label: 'same', owner: { id: 's1', source: 'claim' } }] }
  assert.equal(MCPM.planIsMine(claimed, 's1', false, '/w'), 'claim')
  const checked = { copies: [{ wt: '/w', itemsDiffer: false, done: 0, reported: 0, label: 'same', owner: { id: 's1', source: 'checked' } }] }
  assert.equal(MCPM.planIsMine(checked, 's1', false, '/w'), 'checked')
  const others = { copies: [{ wt: '/w', itemsDiffer: false, done: 0, reported: 0, label: 'same', owner: { id: 's9', source: 'claim' } }] }
  assert.equal(MCPM.planIsMine(others, 's1', false, '/w'), null)
})

await ok('planIsMine tolerates a missing fold or missing copies', () => {
  assert.equal(MCPM.planIsMine(undefined, 's1', false, '/w'), null)
  assert.equal(MCPM.planIsMine({}, 's1', false, '/w'), null)
  assert.equal(MCPM.planIsMine({ copies: [] }, 's1', true, '/w'), null)
})

// ---- plannedOf, against the document -------------------------------------------

await ok('plannedOf excludes a spec a plan already names, and includes the rest', () => {
  const { planned } = MCPM.plannedOf(DOCUMENT[0].specs, MCPM.planIndexOf(DOCUMENT[0]))
  const names = planned.map((s) => s.name)
  assert.ok(!names.includes('alpha-spec.md'), 'alpha-spec.md is named by alpha-plan.md\'s resolvedSpec')
  assert.ok(names.includes('beta-spec.md'), 'beta-spec.md is not named by any plan')
})

await ok('plannedOf reports a plan whose resolvedSpec is broken', () => {
  const { brokenSpec } = MCPM.plannedOf(DOCUMENT[0].specs, MCPM.planIndexOf(DOCUMENT[0]))
  assert.ok(brokenSpec.some((b) => b.plan === 'broken-plan.md'))
})

// ---- graphRows ------------------------------------------------------------------
// Unrelated to the digest/document split: still takes the scan's own raw
// gitGraph object, which is fetched on its own paged route.

await ok('graphRows with no branch returns branch rows, main first', () => {
  const rows = MCPM.graphRows(P.gitGraph, null)
  assert.ok(rows.length >= 2)
  assert.equal(rows.every((r) => r.kind === 'branch'), true)
  assert.equal(rows[0].isMain, true)
})

await ok('graphRows for a real branch returns commit rows, sha7 exactly 7 chars, merge flagged', () => {
  const rows = MCPM.graphRows(P.gitGraph, 'main')
  assert.ok(rows.length >= 1)
  for (const r of rows) {
    assert.equal(r.kind, 'commit')
    assert.equal(r.sha7.length, 7)
  }
  assert.ok(rows.some((r) => r.merge === true), 'the merge commit in the fixture must be flagged')
  assert.ok(rows.some((r) => r.merge === false), 'a single-parent commit must not be flagged')
})

await ok('graphRows(null, ...) is a single note row and does not throw', () => {
  assert.deepEqual(plain(MCPM.graphRows(null, null)), [{ k: 'note', kind: 'note', text: 'history needs a relay restart' }])
})

await ok('graphRows(undefined, ...) behaves like null', () => {
  assert.deepEqual(plain(MCPM.graphRows(undefined, null)), [{ k: 'note', kind: 'note', text: 'history needs a relay restart' }])
})

await ok('graphRows with no branches is a distinct note from an absent graph', () => {
  assert.deepEqual(plain(MCPM.graphRows({ branches: [] }, null)), [{ k: 'note', kind: 'note', text: 'no branches to show' }])
})

// ---- askScoped ----------------------------------------------------------------

await ok('askScoped with no scope carries no opts', () => {
  assert.deepEqual(plain(MCPM.askScoped('hi', null)), { text: 'hi', opts: {} })
})

await ok('askScoped with a project scope nests it under opts.scope', () => {
  assert.deepEqual(plain(MCPM.askScoped('hi', { project: 'k' })), { text: 'hi', opts: { scope: { project: 'k' } } })
})

// ---- the four panels ----------------------------------------------------------

await ok('panelOrder brings the lens\'s own panel first and keeps the rest in place', () => {
  assert.deepEqual(plain(MCPM.panelOrder('sessions')), ['worktrees', 'todos', 'features', 'graph'])
  assert.deepEqual(plain(MCPM.panelOrder('todos')), ['todos', 'worktrees', 'features', 'graph'])
  assert.deepEqual(plain(MCPM.panelOrder('efforts')), ['todos', 'worktrees', 'features', 'graph'])
  assert.deepEqual(plain(MCPM.panelOrder('git')), ['graph', 'worktrees', 'todos', 'features'])
  assert.deepEqual(plain(MCPM.panelOrder('nonsense')), ['worktrees', 'todos', 'features', 'graph'])
})

await ok('worktreesOf flags a locked worktree and leaves an unlocked one unflagged', () => {
  const rows = MCPM.worktreesOf(DIGEST[0])
  assert.equal(rows.length, P.worktrees.length)
  const locked = rows.find((r) => r.path === '/work/demo/.worktrees/feature-x')
  const main = rows.find((r) => r.isMain)
  assert.equal(locked.locked, true)
  assert.equal(main.locked, false)
  assert.equal(new Set(rows.map((r) => r.k)).size, rows.length, 'every worktree key must be unique')
})

await ok('worktreesOf counts each diff kind across a worktree\'s plans and task items', () => {
  const digest = digestProjects([{
    worktrees: [{
      path: '/w', branch: 'b', head: 'h', isMain: false, locked: false, sessions: [],
      plans: [
        { rel: 'docs/plans/a.md', diff: 'only-here' },
        { rel: 'docs/plans/b.md', diff: 'removed', absent: true },
        { rel: 'docs/plans/c.md', diff: 'same' },
      ],
      tasks: [{ rel: 'TASKS.md', items: [{ id: 'x', diff: 'only-here' }, { id: 'y', diff: 'behind' }, { id: 'z' }] }],
    }],
  }], { now: NOW })
  const [row] = MCPM.worktreesOf(digest[0])
  assert.deepEqual(plain(row.diff), { 'only-here': 2, 'removed': 1, 'done-here': 0, 'behind': 1 })
})

await ok('worktreesOf reads a detached worktree as detached, with no branch', () => {
  const [row] = MCPM.worktreesOf({ worktrees: [{ path: '/w', branch: null, detached: true, head: 'h' }] })
  assert.equal(row.detached, true)
  assert.equal(row.branch, null)
  assert.deepEqual(plain(row.sessions), [])
})

await ok('worktreesOf falls back to an all-zero diff for a worktree line predating the field', () => {
  const [row] = MCPM.worktreesOf({ worktrees: [{ path: '/w' }] })
  assert.deepEqual(plain(row.diff), { 'only-here': 0, removed: 0, 'done-here': 0, behind: 0 })
})

await ok('featuresOf lists shipped features newest first, each under a unique key', () => {
  const { shipped } = MCPM.featuresOf(DOCUMENT[0])
  assert.deepEqual(plain(shipped.map((f) => f.date)), ['2026-01-06', '2026-01-05', null])
  assert.equal(new Set(shipped.map((f) => f.k)).size, shipped.length, 'two features sharing a slug must not share a key')
})

const branchOf = (commits, extra = {}) => ({
  branches: [{ name: 'b', head: 'c0ffee0', isMain: false, ahead: 1, behind: 2, commits, truncated: false, ...extra }],
})
const commit = (i, parents = 1) => ({
  sha: String(i).repeat(40).slice(0, 40), parents: Array.from({ length: parents }, (_, j) => 'p' + j), subject: 's' + i, at: 1000 - i,
})

await ok('a branch row carries its newest three commits and says how many more there are', () => {
  const [row] = MCPM.graphRows(branchOf([1, 2, 3, 4, 5].map((i) => commit(i))), null)
  assert.deepEqual(plain(row.recent.map((c) => c.subject)), ['s1', 's2', 's3'])
  assert.equal(row.more, '2 more')
  const [short] = MCPM.graphRows(branchOf([commit(1)]), null)
  assert.equal(short.more, '')
})

await ok('a truncated branch says its count is a floor, in both panels', () => {
  const g = branchOf([1, 2, 3, 4, 5].map((i) => commit(i)), { truncated: true })
  const [row] = MCPM.graphRows(g, null)
  assert.equal(row.more, '2+ more')
  const rows = MCPM.graphRows(g, 'b')
  const last = rows[rows.length - 1]
  assert.equal(last.kind, 'note')
  assert.equal(last.text, 'older commits are not loaded')
  assert.equal(rows.filter((r) => r.kind === 'commit').length, 5)
})

await ok('a branch\'s commit list marks the commit its worktree has checked out', () => {
  const g = branchOf([commit(1), { ...commit(2), sha: 'c0ffee0' + '9'.repeat(33) }])
  const rows = MCPM.graphRows(g, 'b')
  assert.deepEqual(plain(rows.map((r) => r.head)), [false, true])
})

// ---- the verbs' request text --------------------------------------------------
// These strings are what the dispatcher reads; a typo here is a request that
// scopes when it should not. Built from fixture rows, pinned as literals.

await ok('planAsk names a backlog heading by its own file and slug', () => {
  const [b] = MCPM.todosOf(DOCUMENT[0]).backlog
  assert.equal(MCPM.planAsk({ rel: b.rel, slug: b.slug, text: b.label }),
    'Plan docs/TASKS.md#backlog-item-one: Backlog item one')
})

await ok('planAsk names a planned spec by its path and title', () => {
  const { planned } = MCPM.plannedOf(DOCUMENT[0].specs, MCPM.planIndexOf(DOCUMENT[0]))
  const beta = planned.find((s) => s.name === 'beta-spec.md')
  assert.equal(MCPM.planAsk({ rel: beta.rel, slug: null, text: beta.title }),
    'Plan a change described by docs/specs/beta-spec.md: Beta spec')
})

await ok('planAsk refuses to build an ask with no file to name', () => {
  assert.equal(MCPM.planAsk({ rel: null, slug: 'x', text: 'y' }), null)
})

await ok('implementAsk uses the effort\'s own path, exactly', () => {
  const alpha = MCPM.todosOf(DOCUMENT[0]).efforts.find((e) => e.name === 'alpha-plan.md')
  assert.equal(MCPM.implementAsk(alpha),
    'Implement docs/plans/alpha-plan.md exactly as written; the plan and its spec already exist — bank without scoping')
  assert.equal(MCPM.implementAsk({ rel: 'plans/elsewhere.md' }),
    'Implement plans/elsewhere.md exactly as written; the plan and its spec already exist — bank without scoping')
  assert.equal(MCPM.implementAsk({ rel: null }), null)
})

await ok('requestTitle trims to the title cap and never sends an empty title', () => {
  assert.equal(MCPM.requestTitle('  Backlog item one  '), 'Backlog item one')
  assert.equal(MCPM.requestTitle('x'.repeat(200)).length, 80)
  assert.equal(MCPM.requestTitle(''), 'untitled')
  assert.equal(MCPM.requestTitle(null), 'untitled')
})

await ok('liveSessionIds lists every session present in a project\'s worktrees', () => {
  assert.deepEqual(plain(MCPM.liveSessionIds(DIGEST[0])), ['s1'])
  assert.deepEqual(plain(MCPM.liveSessionIds(DIGEST[1])), [])
  assert.deepEqual(plain(MCPM.liveSessionIds(null)), [])
})

await ok('liveClaims keeps only claims held by a session that is present', () => {
  const claims = [{ id: 's1', name: 'one' }, { id: 's9', name: 'ghost' }]
  assert.deepEqual(plain(MCPM.liveClaims(claims, [{ id: 's1' }, { id: 's2' }])), [{ id: 's1', name: 'one' }])
  assert.deepEqual(plain(MCPM.liveClaims(claims, [])), [])
  assert.deepEqual(plain(MCPM.liveClaims(undefined, undefined)), [])
})

// ---- effortStepsView ------------------------------------------------------------
// Neither the digest nor the document ever carries a plan's steps, so this
// is exercised over a digest-shaped project -- no `plans` on its worktrees --
// with the effort itself carrying `rel`.

await ok('effortStepsView names the one plan to fetch, resolving the worktree by path or by "main"', () => {
  const project = {
    worktrees: [
      { path: '/w', isMain: true },
      { path: '/w/wt', isMain: false },
    ],
  }
  const e = { name: 'x.md', at: '/w/wt', rel: 'docs/plans/x.md' }
  const asked = []
  const cold = MCPM.effortStepsView(project, e, (wt, rel) => { asked.push([wt, rel]); return undefined })
  assert.deepEqual(plain(asked), [['/w/wt', 'docs/plans/x.md']])
  assert.deepEqual(plain(cold.need), { wt: '/w/wt', rel: 'docs/plans/x.md' })
  assert.equal(cold.steps, null)
  assert.equal(cold.note, 'loading steps…')

  const askedMain = []
  MCPM.effortStepsView(project, { name: 'y.md', at: 'main', rel: 'docs/plans/y.md' },
    (wt, rel) => { askedMain.push([wt, rel]); return undefined })
  assert.deepEqual(plain(askedMain), [['/w', 'docs/plans/y.md']])

  const loading = MCPM.effortStepsView(project, e, () => ({ status: 'loading' }))
  assert.equal(loading.need, null)
  assert.equal(loading.note, 'loading steps…')

  const fetched = { currentItemId: 'w2', items: [{ id: 'w1', text: 'a' }, { id: 'w2', text: 'b' }] }
  const ready = MCPM.effortStepsView(project, e, () => ({ status: 'ok', plan: fetched }))
  assert.equal(ready.need, null)
  assert.equal(ready.note, null)
  assert.deepEqual(plain(ready.steps.map((s) => [s.k, s.current])), [['w1', false], ['w2', true]])

  const missing = MCPM.effortStepsView(project, e, () => ({ status: 'missing' }))
  assert.equal(missing.steps, null)
  assert.equal(missing.note, 'steps unavailable on this relay')
  const failed = MCPM.effortStepsView(project, e, () => ({ status: 'error' }))
  assert.equal(failed.steps, null)
  assert.equal(failed.note, 'steps could not be read')

  const noWt = MCPM.effortStepsView(project, { name: 'nope.md', at: 'no-such-worktree', rel: 'x' }, () => { throw new Error('must not ask') })
  assert.deepEqual(plain(noWt), { need: null, steps: [], note: null })

  const noRel = MCPM.effortStepsView(project, { name: 'nope2.md', at: 'main', rel: null }, () => { throw new Error('must not ask') })
  assert.deepEqual(plain(noRel), { need: null, steps: [], note: null })

  assert.deepEqual(plain(MCPM.effortStepsView(undefined, undefined, () => { throw new Error('must not ask') })),
    { need: null, steps: [], note: null })
})

// ---- docNeed ----------------------------------------------------------------

await ok('docNeed says which key to fetch when nothing is cached yet', () => {
  const d = MCPM.docNeed(DIGEST[0], undefined)
  assert.deepEqual(plain(d), { need: MCPM.projectKey(DIGEST[0]), note: 'loading…', project: null })
})

await ok('docNeed needs nothing once the cache is at the digest\'s own changedAt', () => {
  const digest = { ...DIGEST[0], changedAt: 500 }
  const entry = { status: 'ok', changedAt: 500, project: DOCUMENT[0] }
  const d = MCPM.docNeed(digest, entry)
  assert.equal(d.need, null)
  assert.equal(d.note, null)
  assert.equal(d.project, entry.project)
})

await ok('docNeed asks again, but still draws the stale document, when the cache is behind the digest\'s changedAt', () => {
  const digest = { ...DIGEST[0], changedAt: 700 }
  const entry = { status: 'ok', changedAt: 500, project: DOCUMENT[0] }
  const d = MCPM.docNeed(digest, entry)
  assert.equal(d.need, MCPM.projectKey(digest))
  assert.equal(d.note, null)
  assert.equal(d.project, entry.project, 'a view must never blank while it refetches')
})

await ok('docNeed reads loading, missing and error entries, and a loading entry with a prior project needs nothing', () => {
  const loadingCold = MCPM.docNeed(DIGEST[0], { status: 'loading' })
  assert.deepEqual(plain(loadingCold), { need: null, note: 'loading…', project: null })
  const loadingWarm = MCPM.docNeed(DIGEST[0], { status: 'loading', project: DOCUMENT[0] })
  assert.deepEqual(plain(loadingWarm), { need: null, note: null, project: DOCUMENT[0] })
  const missing = MCPM.docNeed(DIGEST[0], { status: 'missing' })
  assert.deepEqual(plain(missing), { need: null, note: 'unavailable on this relay', project: null })
  const errored = MCPM.docNeed(DIGEST[0], { status: 'error', project: DOCUMENT[0] })
  assert.deepEqual(plain(errored), { need: null, note: 'could not be read', project: DOCUMENT[0] })
  const erroredCold = MCPM.docNeed(DIGEST[0], { status: 'error' })
  assert.equal(erroredCold.project, null)
})

// ---- docPlan: which documents a view fetches and which it drops --------------
// Each view keeps its own cache of the project route, keyed by project key.
// The rule for what to ask for next lives here so every view asks the same
// way; the views only hold the Map and run the requests.

{
  const DIG = [{ key: '/a', changedAt: 2 }, { key: '/b', changedAt: 5 }, { key: '/c', changedAt: 7 }]
  const planOf = (cache, want) => plain(MCPM.docPlan(DIG, cache, { want }))

  await ok('docPlan fetches a wanted key the cache does not hold', () => {
    assert.deepEqual(planOf(new Map(), ['/b']), { fetch: ['/b'], evict: [] })
  })

  await ok('docPlan leaves a wanted key cached at the digest\'s changedAt alone', () => {
    const cache = new Map([['/b', { status: 'ok', changedAt: 5, project: { key: '/b' } }]])
    assert.deepEqual(planOf(cache, ['/b']), { fetch: [], evict: [] })
  })

  await ok('docPlan fetches a wanted key cached at an older changedAt', () => {
    const cache = new Map([['/b', { status: 'ok', changedAt: 4, project: { key: '/b' } }]])
    assert.deepEqual(planOf(cache, ['/b']), { fetch: ['/b'], evict: [] })
  })

  await ok('docPlan never fetches a key already loading, whatever its changedAt', () => {
    const cache = new Map([['/b', { status: 'loading', changedAt: 4, project: null }]])
    assert.deepEqual(planOf(cache, ['/b']), { fetch: [], evict: [] })
  })

  await ok('docPlan evicts a cached key the digest no longer carries, and does not fetch it', () => {
    const cache = new Map([['/gone', { status: 'ok', changedAt: 1, project: { key: '/gone' } }]])
    assert.deepEqual(planOf(cache, ['/gone', '/a']), { fetch: ['/a'], evict: ['/gone'] })
  })

  await ok('docPlan with want: all fetches every digest key not already current, in digest order', () => {
    const cache = new Map([
      ['/a', { status: 'ok', changedAt: 2, project: { key: '/a' } }],
      ['/b', { status: 'ok', changedAt: 3, project: { key: '/b' } }],
    ])
    assert.deepEqual(planOf(cache, 'all'), { fetch: ['/b', '/c'], evict: [] })
  })

  await ok('docPlan does not re-ask a settled failure at the same changedAt, and asks again once it moves', () => {
    const same = new Map([
      ['/a', { status: 'missing', changedAt: 2, project: null }],
      ['/b', { status: 'error', changedAt: 5, project: null }],
    ])
    assert.deepEqual(planOf(same, 'all'), { fetch: ['/c'], evict: [] })
    const older = new Map([
      ['/a', { status: 'missing', changedAt: 1, project: null }],
      ['/b', { status: 'error', changedAt: 4, project: null }],
    ])
    assert.deepEqual(planOf(older, ['/a', '/b']), { fetch: ['/a', '/b'], evict: [] })
  })

  await ok('docPlan ignores a wanted key off the digest, asks for a key once, tolerates junk and writes nothing', () => {
    assert.deepEqual(planOf(new Map(), ['/nowhere', '/a', '/a']), { fetch: ['/a'], evict: [] })
    assert.deepEqual(plain(MCPM.docPlan(undefined, undefined, {})), { fetch: [], evict: [] })
    assert.deepEqual(plain(MCPM.docPlan(null, null)), { fetch: [], evict: [] })
    assert.deepEqual(planOf(new Map(), undefined), { fetch: [], evict: [] })
    // A digest from a relay that stamps nothing matches an entry recorded at null.
    const unstamped = [{ key: '/u' }]
    const held = new Map([['/u', { status: 'ok', changedAt: null, project: { key: '/u' } }]])
    assert.deepEqual(plain(MCPM.docPlan(unstamped, held, { want: 'all' })), { fetch: [], evict: [] })
    const cache = new Map([['/b', { status: 'ok', changedAt: 4 }], ['/gone', { status: 'ok', changedAt: 1 }]])
    const before = JSON.stringify([...cache])
    MCPM.docPlan(DIG, cache, { want: 'all' })
    assert.equal(JSON.stringify([...cache]), before)
  })
}

// ---- the pane's dedupe and detail folds have moved to the relay --------------

await ok('MCPM.dedupeBacklogSections and MCPM.backlogDetail are undefined: they moved to the relay', () => {
  assert.equal(MCPM.dedupeBacklogSections, undefined)
  assert.equal(MCPM.backlogDetail, undefined)
  assert.equal(MCPM.effortSteps, undefined)
})

console.log(`\nprojects harness: ${pass} checks passed`)
