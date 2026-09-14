#!/usr/bin/env node
// Harness for the projects digest: the shape every pane is sent on every
// change, the document a view fetches for one project, the folds over plans
// and over the backlog, and the content stamp that says which documents moved.
//
// The folds replace derivations the pane used to run over the whole scan, so
// wherever the two overlap this drives projects-model.js (global MCPM) over
// the digest or document built here and holds the relay-side answer to the
// pane's own.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { foldEfforts } from '../syzygy/bridge/tasks-efforts.mjs'
import {
  DIGEST_EFFORTS, projectDigest, digestProjects, projectDocument, documentProjects,
  foldPlans, foldBacklog, needsFlags, stampChanged,
} from '../syzygy/bridge/tasks-digest.mjs'
import * as tasksModule from '../syzygy/bridge/tasks.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MCPM = vm.runInNewContext(
  readFileSync(join(ROOT, 'syzygy', 'bridge', 'public', 'projects-model.js'), 'utf8') + '\n;MCPM', {})

// A value made in the vm realm carries that realm's prototypes and fails
// deepEqual against an outer-realm literal even when every field matches. A
// JSON round-trip leaves only plain data.
const plain = (v) => JSON.parse(JSON.stringify(v))
const sortedKeys = (o) => Object.keys(o).sort()

let passed = 0
const ok = (label, fn) => { fn(); passed++; console.log('✔ ' + label) }

// ---- the fixture scan ---------------------------------------------------------
// Three projects. alpha has three worktrees, main first; four plan basenames,
// two of them in every worktree at different progress, one in main with a
// ghost in each other worktree, one only in a linked worktree; one backlog
// file in every worktree with six sections. empty is one worktree with
// nothing in it. notes is not a git repository.

const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const MAIN = '/Users/someone/tmp/alpha'
const ONE = MAIN + '/.worktrees/feature-one'
const TWO = MAIN + '/.worktrees/feature-two'

const S_MAIN = { id: '00000000-0000-4000-8000-000000000001', name: 'main-session' }
const S_ONE = { id: '00000000-0000-4000-8000-000000000002', name: 'one-session' }
const S_TWO = { id: '00000000-0000-4000-8000-000000000003', name: 'two-session' }

const stepItem = (rel, n, extra = {}) => ({
  id: rel + ':step-' + n, kind: 'step', text: 'Step ' + n + ': an ordinary step', checked: false,
  reported: false, depth: 0, line: n * 2, history: null, diff: 'same', ...extra,
})

const plan = (rel, done, total, extra = {}) => {
  const { itemDiff = 'same', ...rest } = extra
  const items = Array.from({ length: total }, (_, i) =>
    stepItem(rel, i + 1, { checked: i < done, diff: i === 0 ? itemDiff : 'same' }))
  return {
    rel, dir: rel.startsWith('docs/superpowers/') ? 'superpowers-plans' : 'plans',
    title: 'Implementing ' + rel, spec: null, tasks: [], shipped: null, shippedMalformed: null,
    items, currentItemId: items.find((i) => !i.checked)?.id ?? null,
    done, reported: 0, total, owner: null, diff: 'same', mtimeMs: 1_700_000_000_000,
    resolvedTasks: [], resolvedSpec: null, ...rest,
  }
}

// What the scanner leaves in a worktree for a plan main has and it does not.
const ghost = (p) => ({
  ...p, items: p.items.map((i) => ({ ...i, diff: 'removed', absent: true })),
  diff: 'removed', absent: true, owner: null, done: 0, reported: 0, total: 0, currentItemId: null,
})

const A = 'docs/plans/shared-alpha.md'
const B = 'docs/superpowers/plans/shared-beta.md'
const M = 'docs/plans/main-only.md'
const H = 'docs/plans/here-only.md'

const A_REFS = {
  spec: 'docs/specs/shared-alpha-design.md', tasks: ['docs/TASKS.md#backlog-zero'],
  resolvedSpec: { ref: 'docs/specs/shared-alpha-design.md', name: 'shared-alpha-design.md', title: 'Shared alpha design' },
  resolvedTasks: [{ ref: 'docs/TASKS.md#backlog-zero', rel: 'docs/TASKS.md', slug: 'backlog-zero', text: 'Backlog zero' }],
}
const H_REFS = {
  spec: 'docs/specs/nowhere.md', resolvedSpec: { ref: 'docs/specs/nowhere.md', broken: true },
  tasks: ['docs/TASKS.md#nothing'], resolvedTasks: [{ ref: 'docs/TASKS.md#nothing', broken: true }],
}

const T = 'docs/TASKS.md'
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five']
const sectionItem = (rel, n, extra = {}) => ({
  id: rel + '#backlog-' + WORDS[n], kind: 'section', text: 'Backlog ' + WORDS[n], checked: null,
  reported: false, depth: 0, line: n * 10, slug: 'backlog-' + WORDS[n], history: null, diff: 'same', ...extra,
})
const bodyItem = (rel, n, extra = {}) => ({
  id: rel + '#backlog-' + WORDS[n] + ':step', kind: 'step', text: 'A step beneath backlog ' + WORDS[n],
  checked: false, reported: false, depth: 1, line: n * 10 + 1, history: null, diff: 'same', ...extra,
})
const backlogFile = (rel, { sections = {}, steps = {}, ns = [0, 1, 2, 3, 4, 5] } = {}) => ({
  rel, items: ns.flatMap((n) => [sectionItem(rel, n, sections[n]), bodyItem(rel, n, steps[n])]),
})

const wt = (path, branch, isMain, fields) => ({
  path, branch, head: 'abc1234', isMain, detached: false, locked: false,
  sessions: [], plans: [], tasks: [], taskFile: T, taskAuthority: 'docs',
  specs: ['docs/specs/shared-alpha-design.md', 'docs/specs/second-design.md'], skipped: [], claims: {},
  ...fields,
})

const twoTasks = backlogFile(T, { sections: { 3: { claimedBy: [S_TWO] } }, steps: { 4: { diff: 'behind' } }, ns: [0, 1, 2, 3, 4] })
twoTasks.items.push(
  sectionItem(T, 5, { diff: 'removed', absent: true }),
  bodyItem(T, 5, { diff: 'removed', absent: true }),
)

const alphaWorktrees = [
  wt(MAIN, 'main', true, {
    sessions: [{ ...S_MAIN, working: true }],
    plans: [plan(A, 2, 5, A_REFS), plan(B, 1, 4), plan(M, 0, 3, { shippedMalformed: 'soon' })],
    tasks: [backlogFile(T, { sections: { 0: { claimedBy: [S_MAIN] } } })],
    claims: { [S_MAIN.id]: { name: S_MAIN.name, items: [{ kind: 'plan', id: 'shared-alpha.md' }] } },
  }),
  wt(ONE, 'feature/one', false, {
    sessions: [{ ...S_ONE, working: false }],
    plans: [
      plan(A, 3, 5, { ...A_REFS, owner: { ...S_ONE, source: 'claim' } }),
      plan(B, 1, 4, { reported: 1 }),
      plan(H, 1, 2, { ...H_REFS, diff: 'only-here', itemDiff: 'only-here' }),
      ghost(plan(M, 0, 3)),
    ],
    tasks: [backlogFile(T, {
      sections: { 0: { claimedBy: [S_MAIN, S_ONE] }, 2: { diff: 'done-here' } },
      steps: { 1: { diff: 'done-here', checked: true } },
    })],
  }),
  wt(TWO, 'feature/two', false, {
    sessions: [{ ...S_TWO, working: true }],
    plans: [plan(A, 1, 5, { ...A_REFS, itemDiff: 'behind' }), plan(B, 1, 4), ghost(plan(M, 0, 3))],
    tasks: [twoTasks],
  }),
]

const ALPHA = {
  key: MAIN + '/.git', name: 'alpha', isGit: true, mainRoot: MAIN,
  overCap: { projects: 0, worktrees: 1 },
  roll: { onlyHere: 2, removed: 5, doneHere: 2, behind: 1 },
  efforts: foldEfforts(alphaWorktrees).efforts,
  planCollisions: [{ worktree: ONE, name: 'shared-beta.md', rels: [B, 'docs/plans/shared-beta.md'] }],
  features: [
    { name: 'First feature', slug: 'first-feature', date: null, rel: 'docs/FEATURES.md' },
    { name: 'Second feature', slug: 'second-feature', date: null, rel: 'docs/FEATURES.md' },
    { name: 'Third feature', slug: 'third-feature', date: null, rel: 'docs/FEATURES.md' },
  ],
  featureCollisions: [],
  specs: [
    { name: 'shared-alpha-design.md', rel: 'docs/specs/shared-alpha-design.md', title: 'Shared alpha design', mtimeMs: 1 },
    { name: 'second-design.md', rel: 'docs/specs/second-design.md', title: 'Second design', mtimeMs: 2 },
  ],
  brokenRefs: [{ from: H, kind: 'spec', ref: 'docs/specs/nowhere.md' }],
  malformedShipped: [{ rel: M, value: 'soon' }],
  unresolvedClaims: [
    { sessionId: S_ONE.id, name: S_ONE.name, kind: 'plan', id: 'no-such-plan.md' },
    { sessionId: S_TWO.id, name: S_TWO.name, kind: 'backlog', id: 'docs/TASKS.md#no-such-heading' },
  ],
  gitGraph: { branches: [{ name: 'main', isMain: true, head: 'abc1234', commits: [{ sha: 'abc1234def', subject: 'first', at: 1, parents: [] }] }] },
  worktrees: alphaWorktrees,
}

const EMPTY = {
  key: '/Users/someone/tmp/empty/.git', name: 'empty', isGit: true, mainRoot: '/Users/someone/tmp/empty',
  overCap: { projects: 0, worktrees: 0 }, roll: { onlyHere: 0, removed: 0, doneHere: 0, behind: 0 },
  efforts: [], planCollisions: [], features: [], featureCollisions: [], specs: [], brokenRefs: [],
  malformedShipped: [], unresolvedClaims: [], gitGraph: { branches: [] },
  worktrees: [wt('/Users/someone/tmp/empty', 'main', true, { taskFile: null, taskAuthority: null, specs: [] })],
}

const NOTES = {
  key: '/Users/someone/notes', name: 'notes', isGit: false, mainRoot: '/Users/someone/notes',
  overCap: { projects: 0, worktrees: 0 }, roll: { onlyHere: 0, removed: 0, doneHere: 0, behind: 0 },
  efforts: [], planCollisions: [], features: [], featureCollisions: [], specs: [], brokenRefs: [],
  malformedShipped: [], unresolvedClaims: [], gitGraph: null,
  worktrees: [{ ...wt('/Users/someone/notes', null, true, { taskFile: null, taskAuthority: null, specs: [] }), head: null }],
}

const SCAN = [ALPHA, EMPTY, NOTES]
const PRISTINE = structuredClone(SCAN)

// ---- exact shapes -------------------------------------------------------------

const DIGEST_KEYS = ['key', 'name', 'mainRoot', 'isGit', 'changedAt', 'overCap', 'roll', 'counts', 'flags',
  'efforts', 'moreEfforts', 'worktrees']
const COUNT_KEYS = ['plans', 'steps', 'backlogSections', 'backlogItems', 'features', 'specs', 'worktrees', 'inFlight', 'behind', 'fresh']
const FLAG_KEYS = ['planCollisions', 'unresolvedClaims', 'brokenRefs', 'featureCollisions', 'malformedShipped']
const LINE_KEYS = ['path', 'branch', 'head', 'sessions', 'planCount', 'taskFile', 'taskAuthority', 'diff', 'claimedSections']
// A worktree line carries each of these only when it is true.
const LINE_FLAGS = ['isMain', 'locked', 'detached']
const assertLine = (w, label) => {
  assert.deepEqual(sortedKeys(w).filter((k) => !LINE_FLAGS.includes(k)), [...LINE_KEYS].sort(), label)
  for (const k of LINE_FLAGS) if (Object.hasOwn(w, k)) assert.equal(w[k], true, label + ' carries ' + k + ' as ' + w[k])
}
const DIFF_KEYS = ['only-here', 'removed', 'done-here', 'behind']
const CLAIMED_KEYS = ['rel', 'slug', 'text', 'claimedBy']
const EFFORT_KEYS = ['name', 'title', 'done', 'total', 'currentItem', 'claimedBy']
const DOCUMENT_EXTRA = ['plans', 'backlog', 'features', 'featureCollisions', 'specs', 'brokenRefs',
  'planCollisions', 'unresolvedClaims', 'malformedShipped']
const FOLD_PLAN_KEYS = ['name', 'title', 'rel', 'done', 'reported', 'total', 'shipped', 'live', 'currentItem',
  'checkedAt', 'at', 'claimedBy', 'spec', 'resolvedSpec', 'resolvedTasks', 'copies']
const PLAN_COPY_KEYS = ['wt', 'done', 'reported', 'total', 'mtimeMs', 'owner', 'currentItem', 'itemsDiffer', 'label']
const BACKLOG_KEYS = ['id', 'slug', 'text', 'rel', 'authority', 'claimedBy', 'body', 'copies']
const BODY_KEYS = ['k', 'id', 'text', 'checked', 'reported']

// A key that names a fat list may appear in the digest only as a count. A
// structural test rather than a spot check: this is how the whole scan would
// creep back onto the wire.
const FAT_KEY = /"(plans|tasks|features|specs|gitGraph|items)":(?!\d)/

ok('projectDigest returns exactly the digest keys, and nothing else, for every project', () => {
  for (const p of SCAN) {
    const d = projectDigest(p, { now: NOW })
    assert.deepEqual(sortedKeys(d), [...DIGEST_KEYS].sort(), p.name)
    assert.deepEqual(sortedKeys(d.counts), [...COUNT_KEYS].sort(), p.name + ' counts')
    assert.deepEqual(sortedKeys(d.flags), [...FLAG_KEYS].sort(), p.name + ' flags')
    for (const w of d.worktrees) {
      assertLine(w, p.name + ' worktree line')
      assert.deepEqual(sortedKeys(w.diff), [...DIFF_KEYS].sort(), p.name + ' worktree diff')
      for (const c of w.claimedSections) assert.deepEqual(sortedKeys(c), [...CLAIMED_KEYS].sort())
    }
    for (const e of d.efforts) assert.deepEqual(sortedKeys(e), [...EFFORT_KEYS].sort(), p.name + ' effort')
  }
})

ok('a worktree line carries isMain, locked and detached only when true', () => {
  const p = {
    ...EMPTY,
    worktrees: [
      { ...wt('/Users/someone/tmp/flags', 'main', true), locked: true, detached: false },
      { ...wt('/Users/someone/tmp/flags/.worktrees/loose', null, false), locked: false, detached: true },
    ],
  }
  const [main, other] = projectDigest(p, { now: NOW }).worktrees
  assert.equal(main.isMain, true)
  assert.equal(main.locked, true)
  assert.equal(Object.hasOwn(main, 'detached'), false, 'an attached worktree carries detached')
  assert.equal(Object.hasOwn(other, 'isMain'), false, 'a linked worktree carries isMain')
  assert.equal(Object.hasOwn(other, 'locked'), false, 'an unlocked worktree carries locked')
  assert.equal(other.detached, true)
  assertLine(main, 'main')
  assertLine(other, 'linked')
  assert.deepEqual(projectDocument(p, { now: NOW }).worktrees.map(({ plans, ...line }) => line), [main, other],
    'the document\'s worktree lines are the digest\'s')
})

ok('the builder emits changedAt null and carries key, name, mainRoot, isGit, overCap and roll as the scan has them', () => {
  const d = projectDigest(ALPHA, { now: NOW })
  assert.equal(d.changedAt, null)
  assert.equal(d.key, ALPHA.key)
  assert.equal(d.name, 'alpha')
  assert.equal(d.mainRoot, MAIN)
  assert.equal(d.isGit, true)
  assert.deepEqual(d.overCap, { projects: 0, worktrees: 1 })
  assert.deepEqual(d.roll, ALPHA.roll)
  assert.equal(projectDigest(NOTES, { now: NOW }).isGit, false)
  assert.equal(projectDigest({ ...EMPTY, overCap: undefined }, { now: NOW }).overCap, null)
})

ok('digestProjects carries no plans, tasks, features, specs, gitGraph or items list anywhere', () => {
  const json = JSON.stringify(digestProjects(SCAN, { now: NOW }))
  assert.equal(FAT_KEY.test(json), false, 'a fat key reached the digest: ' + json.match(FAT_KEY)?.[0])
  assert.ok(json.includes('"planCount":'), 'the structural test must be looking at real digest output')
  assert.equal(digestProjects(SCAN, { now: NOW }).length, 3)
  assert.deepEqual(digestProjects(null), [])
})

ok('counts: distinct plan basenames, every copy\'s steps, deduped sections, and the scan\'s list lengths', () => {
  const c = projectDigest(ALPHA, { now: NOW }).counts
  // Four basenames across nine records, three of them ghosts.
  assert.equal(c.plans, 4)
  // main 5+4+3, one 5+4+2, two 5+4: every live copy, ghosts carrying none.
  assert.equal(c.steps, 32)
  // Six headings in three worktrees read as six, not eighteen.
  assert.equal(c.backlogSections, 6)
  assert.equal(c.backlogSections, foldBacklog(ALPHA).length)
  // Six headings and the step beneath each, once each: the ghost heading and
  // step in feature-two are the same ids main carries live.
  assert.equal(c.backlogItems, 12)
  assert.equal(c.features, 3)
  assert.equal(c.specs, 2)
  assert.equal(c.worktrees, 3)
  assert.deepEqual(projectDigest(EMPTY, { now: NOW }).counts,
    { plans: 0, steps: 0, backlogSections: 0, backlogItems: 0, features: 0, specs: 0, worktrees: 1, inFlight: 0, behind: 0, fresh: 0 })
})

ok('counts: inFlight and behind come from every effort in the scan', () => {
  const c = projectDigest(ALPHA, { now: NOW }).counts
  // shared-alpha, shared-beta, main-only and here-only are all unfinished.
  assert.equal(c.inFlight, 4)
  assert.equal(c.inFlight, ALPHA.efforts.filter((e) => e.live).length)
  // Two copies behind the most advanced one for each shared plan.
  assert.equal(c.behind, 4)
})

ok('flags are five numbers, and needsFlags sums them', () => {
  const d = projectDigest(ALPHA, { now: NOW })
  for (const k of FLAG_KEYS) assert.equal(typeof d.flags[k], 'number', k)
  assert.deepEqual(d.flags, { planCollisions: 1, unresolvedClaims: 2, brokenRefs: 1, featureCollisions: 0, malformedShipped: 1 })
  const n = needsFlags(ALPHA)
  assert.deepEqual(sortedKeys(n), [...FLAG_KEYS, 'total'].sort())
  assert.equal(n.total, Object.values(d.flags).reduce((a, b) => a + b, 0))
  assert.equal(n.total, 5)
  assert.equal(needsFlags(EMPTY).total, 0)
  assert.deepEqual(needsFlags({}), { planCollisions: 0, unresolvedClaims: 0, brokenRefs: 0, featureCollisions: 0, malformedShipped: 0, total: 0 })
})

ok('a worktree line counts its live plans and carries its task file and authority verbatim', () => {
  const lines = projectDigest(ALPHA, { now: NOW }).worktrees
  assert.deepEqual(lines.map((w) => w.planCount), [3, 3, 2])
  assert.deepEqual(lines.map((w) => w.path), [MAIN, ONE, TWO])
  assert.deepEqual(lines.map((w) => w.taskFile), [T, T, T])
  assert.deepEqual(lines.map((w) => w.taskAuthority), ['docs', 'docs', 'docs'])
  assert.deepEqual(lines[1].sessions, [{ ...S_ONE, working: false }])
  const e = projectDigest(EMPTY, { now: NOW }).worktrees[0]
  assert.equal(e.taskFile, null)
  assert.equal(e.taskAuthority, null)
  assert.equal(e.planCount, 0)
  const n = projectDigest(NOTES, { now: NOW }).worktrees[0]
  assert.equal(n.branch, null)
  assert.equal(n.head, null)
})

ok('a worktree line\'s diff passes through the pane\'s worktreesOf unchanged', () => {
  for (const p of SCAN) {
    const digest = projectDigest(p, { now: NOW })
    const mine = digest.worktrees.map((w) => w.diff)
    const pane = plain(MCPM.worktreesOf(digest)).map((w) => w.diff)
    assert.deepEqual(mine, pane, p.name)
  }
  // Pinned as well, so a change to both sides at once cannot pass unnoticed.
  const lines = projectDigest(ALPHA, { now: NOW }).worktrees
  assert.deepEqual(lines[0].diff, { 'only-here': 0, removed: 0, 'done-here': 0, behind: 0 })
  assert.deepEqual(lines[1].diff, { 'only-here': 1, removed: 1, 'done-here': 2, behind: 0 })
  assert.deepEqual(lines[2].diff, { 'only-here': 0, removed: 3, 'done-here': 0, behind: 1 })
})

ok('claimedSections holds only the sections a claim sits on, in the worktree holding the claim', () => {
  const lines = projectDigest(ALPHA, { now: NOW }).worktrees
  assert.deepEqual(lines[0].claimedSections, [{ rel: T, slug: 'backlog-zero', text: 'Backlog zero', claimedBy: [S_MAIN] }])
  assert.deepEqual(lines[1].claimedSections, [{ rel: T, slug: 'backlog-zero', text: 'Backlog zero', claimedBy: [S_MAIN, S_ONE] }])
  // backlog-three is claimed in two only; the same heading elsewhere is not listed.
  assert.deepEqual(lines[2].claimedSections, [{ rel: T, slug: 'backlog-three', text: 'Backlog three', claimedBy: [S_TWO] }])
  assert.deepEqual(projectDigest(EMPTY, { now: NOW }).worktrees[0].claimedSections, [])
})

ok('claimedSections skips a ghost section and every section of a ghost file', () => {
  const p = structuredClone(EMPTY)
  p.worktrees[0].tasks = [
    { rel: 'TODO.md', absent: true, diff: 'removed', items: [sectionItem('TODO.md', 0, { claimedBy: [S_ONE], absent: true, diff: 'removed' })] },
    { rel: T, items: [sectionItem(T, 1, { claimedBy: [S_TWO], absent: true, diff: 'removed' }), sectionItem(T, 2, { claimedBy: [] })] },
  ]
  assert.deepEqual(projectDigest(p, { now: NOW }).worktrees[0].claimedSections, [])
})

// ---- the capped efforts ---------------------------------------------------------

const effort = (name, { live, checkedAt, total = 10, done = live ? 3 : total, behind = 0, claimedBy = [] }) => ({
  name, title: 'Effort ' + name, rel: 'docs/plans/' + name, done, reported: 0, total, shipped: null, live,
  copies: 2, behind, currentItemId: live ? 'docs/plans/' + name + ':step-4' : null,
  currentItem: live ? 'Step 4: an ordinary step' : null, checkedAt, at: 'main', claimedBy,
})

const liveEfforts = Array.from({ length: 14 }, (_, i) =>
  // live-11, live-12 and live-13 tie on checkedAt, so name breaks the tie.
  effort('live-' + String(i).padStart(2, '0') + '.md', { live: true, checkedAt: NOW - Math.min(i, 11) * HOUR, behind: 1 }))
const restEfforts = [
  effort('claimed-old.md', { live: false, checkedAt: NOW - 10 * DAY, behind: 2, claimedBy: [S_TWO] }),
  effort('fresh-a.md', { live: false, checkedAt: NOW - 2 * HOUR }),
  effort('fresh-b.md', { live: false, checkedAt: NOW - 23 * HOUR }),
  effort('fresh-empty.md', { live: false, checkedAt: NOW - HOUR, total: 0 }),
  effort('stale.md', { live: false, checkedAt: NOW - 25 * HOUR }),
  effort('boundary.md', { live: false, checkedAt: NOW - DAY }),
]
// Interleaved, so the order the digest reports is its own and not the input's.
const TWENTY = [...liveEfforts.slice(7).reverse(), ...restEfforts, ...liveEfforts.slice(0, 7)]
const BUSY = { ...EMPTY, key: '/Users/someone/tmp/busy/.git', name: 'busy', efforts: TWENTY }

// Every effort of BUSY claimed by one session, for the cap and the order.
const claimedAll = (list) => list.map((e) => ({ ...e, claimedBy: e.claimedBy.length ? e.claimedBy : [S_ONE] }))

ok('DIGEST_EFFORTS is twelve', () => assert.equal(DIGEST_EFFORTS, 12))

ok('the digest carries only claimed efforts, trimmed to what a session reads of its own work', () => {
  assert.equal(TWENTY.length, 20)
  const d = projectDigest(BUSY, { now: NOW })
  // Fourteen live efforts and five finished ones carry no claim, so none rides.
  assert.deepEqual(d.efforts, [{
    name: 'claimed-old.md', title: 'Effort claimed-old.md', done: 10, total: 10, currentItem: null, claimedBy: [S_TWO],
  }])
  assert.equal(d.moreEfforts, 20 - 1)
  assert.equal(d.efforts.some((e) => e.name.startsWith('live-')), false, 'an unclaimed live effort was carried')
  const live = claimedAll([effort('live-x.md', { live: true, checkedAt: NOW })])
  assert.deepEqual(projectDigest({ ...BUSY, efforts: live }, { now: NOW }).efforts, [{
    name: 'live-x.md', title: 'Effort live-x.md', done: 3, total: 10, currentItem: 'Step 4: an ordinary step', claimedBy: [S_ONE],
  }])
})

ok('past twelve claimed efforts the digest cuts by checkedAt then name, and moreEfforts counts every effort left out', () => {
  const d = projectDigest({ ...BUSY, efforts: claimedAll(TWENTY) }, { now: NOW })
  assert.equal(d.efforts.length, DIGEST_EFFORTS)
  assert.equal(d.moreEfforts, 20 - DIGEST_EFFORTS)
  // A claim no longer outranks anything: every carried effort is claimed, so
  // the newest tick leads and a live effort gets no preference over a finished one.
  assert.deepEqual(d.efforts.map((e) => e.name), [
    'live-00.md', 'fresh-empty.md', 'live-01.md', 'fresh-a.md', 'live-02.md', 'live-03.md',
    'live-04.md', 'live-05.md', 'live-06.md', 'live-07.md', 'live-08.md', 'live-09.md',
  ])
  for (const e of d.efforts) assert.deepEqual(sortedKeys(e), [...EFFORT_KEYS].sort(), e.name)
})

ok('ties on checkedAt fall to the name', () => {
  const d = projectDigest({ ...BUSY, efforts: claimedAll(liveEfforts.slice(10)) }, { now: NOW })
  assert.deepEqual(d.efforts.map((e) => e.name), ['live-10.md', 'live-11.md', 'live-12.md', 'live-13.md'])
})

ok('counts.inFlight, behind and fresh are exact over all twenty, not the twelve carried', () => {
  const c = projectDigest(BUSY, { now: NOW }).counts
  assert.equal(c.inFlight, 14, 'two live efforts sit past the cap and must still count')
  assert.equal(c.behind, 14 + 2)
  // Finished inside a day of now, with steps: fresh-a and fresh-b. Not the
  // empty plan, not the one a day and an hour old, not the one exactly a day old.
  assert.equal(c.fresh, 2)
  assert.equal(projectDigest(BUSY, { now: NOW + 2 * DAY }).counts.fresh, 0)
  assert.equal(projectDigest(BUSY).counts.fresh, 0, 'with no clock nothing reads as finished today')
})

ok('with four claimed efforts nothing is capped, and the newest tick leads', () => {
  const four = claimedAll([
    effort('done-recent.md', { live: false, checkedAt: NOW - HOUR }),
    effort('live-old.md', { live: true, checkedAt: NOW - 5 * DAY }),
    effort('done-older.md', { live: false, checkedAt: NOW - 2 * HOUR }),
    effort('live-new.md', { live: true, checkedAt: NOW - DAY }),
  ])
  const d = projectDigest({ ...BUSY, efforts: four }, { now: NOW })
  assert.equal(d.moreEfforts, 0)
  assert.deepEqual(d.efforts.map((e) => e.name), ['done-recent.md', 'done-older.md', 'live-new.md', 'live-old.md'])
  // With no claim among them, none rides and all four are counted as left out.
  const unclaimed = projectDigest({ ...BUSY, efforts: four.map((e) => ({ ...e, claimedBy: [] })) }, { now: NOW })
  assert.deepEqual(unclaimed.efforts, [])
  assert.equal(unclaimed.moreEfforts, 4)
})

// ---- the document ---------------------------------------------------------------

ok('projectDocument is the digest plus the folded lists, with the full efforts', () => {
  const doc = projectDocument(ALPHA, { now: NOW })
  const d = projectDigest(ALPHA, { now: NOW })
  assert.deepEqual(sortedKeys(doc), [...DIGEST_KEYS, ...DOCUMENT_EXTRA].sort())
  for (const k of DIGEST_KEYS) {
    if (k === 'efforts' || k === 'moreEfforts' || k === 'worktrees') continue
    assert.deepEqual(doc[k], d[k], k)
  }
  assert.deepEqual(doc.worktrees.map(({ plans, ...line }) => line), d.worktrees)
  assert.equal(doc.efforts, ALPHA.efforts, 'the document carries the scan\'s own effort records')
  assert.equal(doc.moreEfforts, 0)
  assert.deepEqual(doc.plans, foldPlans(ALPHA))
  assert.deepEqual(doc.backlog, foldBacklog(ALPHA))
  for (const k of ['features', 'featureCollisions', 'specs', 'brokenRefs', 'planCollisions', 'unresolvedClaims', 'malformedShipped']) {
    assert.deepEqual(doc[k], ALPHA[k], k)
  }
  const busy = projectDocument(BUSY, { now: NOW })
  assert.equal(busy.efforts.length, 20)
  assert.equal(busy.moreEfforts, 0)
  assert.equal('currentItemId' in busy.efforts[0], true, 'the document\'s efforts are foldEfforts\' records untouched')
  assert.equal(documentProjects(SCAN, { now: NOW }).length, 3)
  assert.deepEqual(documentProjects(SCAN, { now: NOW })[0], doc)
  assert.deepEqual(documentProjects(undefined), [])
})

ok('a document worktree lists each plan it carries by basename with that copy\'s label', () => {
  const doc = projectDocument(ALPHA, { now: NOW })
  assert.deepEqual(doc.worktrees[0].plans, [
    { ref: 'shared-alpha.md', label: 'same' }, { ref: 'shared-beta.md', label: 'same' }, { ref: 'main-only.md', label: 'same' },
  ])
  assert.deepEqual(doc.worktrees[1].plans, [
    { ref: 'shared-alpha.md', label: 'ahead' }, { ref: 'shared-beta.md', label: 'ahead' },
    { ref: 'here-only.md', label: 'ahead' }, { ref: 'main-only.md', label: 'absent' },
  ])
  assert.deepEqual(doc.worktrees[2].plans, [
    { ref: 'shared-alpha.md', label: 'behind' }, { ref: 'shared-beta.md', label: 'same' }, { ref: 'main-only.md', label: 'absent' },
  ])
  // Every label agrees with foldPlans' copy for that worktree.
  const fold = foldPlans(ALPHA)
  for (const w of doc.worktrees) {
    for (const { ref, label } of w.plans) {
      assert.equal(fold.find((p) => p.name === ref).copies.find((c) => c.wt === w.path).label, label, w.path + ' ' + ref)
    }
  }
  assert.deepEqual(projectDocument(EMPTY, { now: NOW }).worktrees[0].plans, [])
})

// ---- foldPlans -------------------------------------------------------------------

ok('foldPlans returns one record per basename, in the efforts\' order, with the effort\'s own numbers', () => {
  const fold = foldPlans(ALPHA)
  assert.equal(fold.length, 4)
  assert.deepEqual(fold.map((p) => p.name), ALPHA.efforts.map((e) => e.name))
  assert.deepEqual(fold.map((p) => p.name), ['shared-alpha.md', 'shared-beta.md', 'main-only.md', 'here-only.md'])
  for (const p of fold) {
    assert.deepEqual(sortedKeys(p), [...FOLD_PLAN_KEYS].sort(), p.name)
    for (const c of p.copies) assert.deepEqual(sortedKeys(c), [...PLAN_COPY_KEYS].sort(), p.name + ' copy')
    const e = ALPHA.efforts.find((x) => x.name === p.name)
    for (const k of ['name', 'title', 'rel', 'done', 'reported', 'total', 'shipped', 'live', 'currentItem', 'checkedAt', 'at', 'claimedBy']) {
      assert.deepEqual(p[k], e[k], p.name + ' ' + k)
    }
  }
  // The best copy's numbers win by the existing ahead rule.
  const alpha = fold[0]
  assert.equal(alpha.done, 3)
  assert.equal(alpha.at, ONE)
  assert.deepEqual(alpha.claimedBy, [{ id: S_MAIN.id, name: S_MAIN.name }])
  assert.equal(fold[1].reported, 1, 'a reported step breaks the tie between equal verified counts')
})

ok('a plan copy is labelled against main\'s copy: ahead, behind, same, absent, and ahead with no main copy', () => {
  const byName = new Map(foldPlans(ALPHA).map((p) => [p.name, p]))
  const labels = (name) => byName.get(name).copies.map((c) => [c.wt, c.label])
  assert.deepEqual(labels('shared-alpha.md'), [[MAIN, 'same'], [ONE, 'ahead'], [TWO, 'behind']])
  assert.deepEqual(labels('shared-beta.md'), [[MAIN, 'same'], [ONE, 'ahead'], [TWO, 'same']])
  assert.deepEqual(labels('main-only.md'), [[MAIN, 'same'], [ONE, 'absent'], [TWO, 'absent']])
  assert.deepEqual(labels('here-only.md'), [[ONE, 'ahead']])
})

ok('a plan copy carries its own numbers, owner, current step and whether any item differs', () => {
  const alpha = foldPlans(ALPHA)[0].copies
  assert.deepEqual(alpha[0], {
    wt: MAIN, done: 2, reported: 0, total: 5, mtimeMs: 1_700_000_000_000, owner: null,
    currentItem: 'Step 3: an ordinary step', itemsDiffer: false, label: 'same',
  })
  assert.deepEqual(alpha[1].owner, { ...S_ONE, source: 'claim' })
  assert.equal(alpha[1].currentItem, 'Step 4: an ordinary step')
  assert.equal(alpha[2].itemsDiffer, true, 'a copy with a behind item differs')
  const mainOnly = foldPlans(ALPHA)[2].copies
  assert.deepEqual(mainOnly[1], {
    wt: ONE, done: 0, reported: 0, total: 0, mtimeMs: 1_700_000_000_000, owner: null,
    currentItem: null, itemsDiffer: true, label: 'absent',
  })
  const noMtime = structuredClone(ALPHA)
  delete noMtime.worktrees[0].plans[0].mtimeMs
  assert.equal(foldPlans(noMtime)[0].copies[0].mtimeMs, null)
})

ok('foldPlans takes spec, resolvedSpec and resolvedTasks from the copy planIndexOf reads', () => {
  const idx = MCPM.planIndexOf(documentProjects([ALPHA], { now: NOW })[0])
  for (const p of foldPlans(ALPHA)) {
    const want = plain(idx.get(p.name))
    assert.deepEqual({ spec: p.spec, resolvedSpec: p.resolvedSpec, resolvedTasks: p.resolvedTasks },
      { spec: want.spec, resolvedSpec: want.resolvedSpec, resolvedTasks: want.resolvedTasks }, p.name)
  }
  const shared = foldPlans(ALPHA)[1]
  assert.equal(shared.spec, null)
  assert.equal(shared.resolvedSpec, null)
  assert.deepEqual(shared.resolvedTasks, [])
})

// ---- foldBacklog ----------------------------------------------------------------

ok('foldBacklog returns each heading once, with its file, body, unioned claims and one copy per worktree', () => {
  const fold = foldBacklog(ALPHA)
  assert.equal(fold.length, 6)
  for (const b of fold) {
    assert.deepEqual(sortedKeys(b), [...BACKLOG_KEYS].sort(), b.id)
    for (const s of b.body) assert.deepEqual(sortedKeys(s), [...BODY_KEYS].sort())
    for (const c of b.copies) assert.deepEqual(sortedKeys(c), ['label', 'wt'])
  }
  assert.deepEqual(fold.map((b) => b.slug), WORDS.map((w) => 'backlog-' + w))
  const zero = fold[0]
  assert.equal(zero.rel, T)
  assert.equal(zero.authority, true)
  assert.equal(zero.text, 'Backlog zero')
  // The same session claiming in two copies is one claim; a second session is a second.
  assert.deepEqual(zero.claimedBy, [S_MAIN, S_ONE])
  assert.deepEqual(fold[3].claimedBy, [S_TWO], 'a claim on one worktree\'s copy lands on the heading')
  assert.deepEqual(zero.body, [{ k: T + '#backlog-zero:step', id: T + '#backlog-zero:step', text: 'A step beneath backlog zero', checked: false, reported: false }])
  const copies = (n) => fold[n].copies.map((c) => [c.wt, c.label])
  assert.deepEqual(copies(0), [[MAIN, 'same'], [ONE, 'same'], [TWO, 'same']])
  assert.deepEqual(copies(2), [[MAIN, 'same'], [ONE, 'ahead'], [TWO, 'same']])
  assert.deepEqual(copies(5), [[MAIN, 'same'], [ONE, 'same'], [TWO, 'absent']])
})

ok('a backlog copy\'s label comes from its item\'s diff', () => {
  const p = structuredClone(EMPTY)
  const labelled = (diff, extra = {}) => ({ ...wt('/Users/someone/tmp/empty/.worktrees/' + diff, 'x', false, {}), tasks: [{ rel: T, items: [sectionItem(T, 0, { diff, ...extra })] }] })
  p.worktrees = [
    { ...wt('/Users/someone/tmp/empty', 'main', true, {}), tasks: [{ rel: T, items: [sectionItem(T, 0)] }] },
    labelled('only-here'), labelled('done-here'), labelled('behind'), labelled('removed'), labelled('something-else'),
    { ...labelled('ghost'), tasks: [{ rel: T, items: [sectionItem(T, 0, { diff: 'same', absent: true })] }] },
  ]
  assert.deepEqual(foldBacklog(p)[0].copies.map((c) => c.label), ['same', 'ahead', 'ahead', 'behind', 'absent', 'same', 'absent'])
})

ok('foldBacklog agrees with the pane\'s todosOf wherever the two overlap', () => {
  for (const p of SCAN) {
    const doc = documentProjects([p], { now: NOW })[0]
    const mine = foldBacklog(p).map(({ id, slug, text, claimedBy, rel, body }) => ({ id, slug, text, claimedBy, rel, body }))
    const pane = plain(MCPM.todosOf(doc).backlog).map(({ id, slug, text, claimedBy, rel, body }) => ({ id, slug, text, claimedBy, rel, body }))
    assert.deepEqual(mine, pane, p.name)
  }
})

// ---- foldBacklog: the pane's old dedupeBacklogSections cases, now that the
// dedupe itself moved off the pane and onto the relay -----------------------

ok('foldBacklog collapses one TASKS.md shared by every worktree', () => {
  const items = [
    { id: 'a', kind: 'section', text: 'Section A' },
    { id: 'b', kind: 'section', text: 'Section B' },
  ]
  const wt = [
    { isMain: true, tasks: [{ rel: 'docs/TASKS.md', items }] },
    { tasks: [{ rel: 'docs/TASKS.md', items }] },
    { tasks: [{ rel: 'docs/TASKS.md', items }] },
  ]
  // 6 if a naive pass renders every worktree's copy; 2 is the honest count.
  const out = foldBacklog({ worktrees: wt })
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((s) => s.id), ['a', 'b'], 'first-seen order is preserved')
})

ok('foldBacklog ignores step items, only section headings count', () => {
  const wt = [{ tasks: [{ rel: 'docs/TASKS.md', items: [
    { id: 'a', kind: 'section', text: 'Heading' },
    { id: 'b', kind: 'step', text: 'a checkbox, not a backlog section' },
  ] }] }]
  assert.deepEqual(foldBacklog({ worktrees: wt }).map((s) => s.id), ['a'])
})

ok('foldBacklog skips ghosts at file level and at item level', () => {
  const wt = [
    { tasks: [{ rel: 'docs/TASKS.md', absent: true, items: [{ id: 'ghostfile', kind: 'section', text: 'x' }] }] },
    { tasks: [{ rel: 'docs/TASKS.md', items: [
      { id: 'real', kind: 'section', text: 'Real section' },
      { id: 'ghostitem', kind: 'section', text: 'gone', absent: true },
    ] }] },
  ]
  assert.deepEqual(foldBacklog({ worktrees: wt }).map((s) => s.id), ['real'])
})

ok('foldBacklog unions claimedBy across duplicate copies of the same item, never duplicating one claimant', () => {
  const wt = [
    { tasks: [{ rel: 'docs/TASKS.md', items: [{ id: 'a', kind: 'section', text: 'Shared' }] }] },
    { tasks: [{ rel: 'docs/TASKS.md', items: [{ id: 'a', kind: 'section', text: 'Shared', claimedBy: [{ id: 's1', name: 'agent-1' }] }] }] },
  ]
  const out = foldBacklog({ worktrees: wt })
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].claimedBy, [{ id: 's1', name: 'agent-1' }])

  const claim = [{ id: 's1', name: 'agent-1' }]
  const wt2 = [
    { tasks: [{ rel: 'docs/TASKS.md', items: [{ id: 'a', kind: 'section', text: 'Shared', claimedBy: claim }] }] },
    { tasks: [{ rel: 'docs/TASKS.md', items: [{ id: 'a', kind: 'section', text: 'Shared', claimedBy: claim }] }] },
  ]
  assert.equal(foldBacklog({ worktrees: wt2 })[0].claimedBy.length, 1, 'the same claimant seen on two copies is not duplicated')
})

// ---- counts.backlogItems: the Dispatch glance's backlog chip -------------------
// The glance reads this count off the digest: every distinct item id, heading
// or step, in every task file the worktrees carry. It once read `w.backlog`, a
// key no payload ever had, and showed 0 beside a task file full of sections;
// then a pass over every worktree showed one shared file once per worktree.

const sec = (id, extra = {}) => ({ id, kind: 'section', text: 'Section ' + id, ...extra })
const stepUnder = (id, extra = {}) => ({ id, kind: 'step', text: 'Step ' + id, checked: false, ...extra })

ok('counts.backlogItems counts distinct items of every kind across every task file and worktree, never a ghost', () => {
  const count = (worktrees) => projectDigest({ worktrees }).counts.backlogItems
  // A heading and the steps beneath it all count.
  assert.equal(count([{ tasks: [{ rel: 'docs/TASKS.md', items: [sec('a'), stepUnder('a:1'), stepUnder('a:2')] }] }]), 3)
  // Every task file a worktree carries is counted.
  assert.equal(count([{ tasks: [
    { rel: 'TASKS.md', items: [sec('TASKS.md#a')] },
    { rel: 'docs/TASKS.md', items: [sec('docs/TASKS.md#b'), stepUnder('docs/TASKS.md#b:1')] },
  ] }]), 3)
  // A `backlog` key on a worktree is not where the backlog lives.
  assert.equal(count([{ backlog: [{ id: 'x' }, { id: 'y' }] }]), 0)
  // One TASKS.md shared by three worktrees is its own items, once.
  const shared = [sec('a'), stepUnder('a:1'), sec('b')]
  assert.equal(count([
    { isMain: true, tasks: [{ rel: 'docs/TASKS.md', items: shared }] },
    { tasks: [{ rel: 'docs/TASKS.md', items: shared }] },
    { tasks: [{ rel: 'docs/TASKS.md', items: shared }] },
  ]), 3)
  // An item one worktree adds is counted.
  assert.equal(count([
    { isMain: true, tasks: [{ rel: 'docs/TASKS.md', items: [sec('a')] }] },
    { tasks: [{ rel: 'docs/TASKS.md', items: [sec('a'), stepUnder('only-here', { diff: 'only-here' })] }] },
  ]), 2)
  // A ghost file and a ghost item are not work.
  assert.equal(count([
    { tasks: [{ rel: 'docs/TASKS.md', absent: true, diff: 'removed', items: [sec('ghostfile'), stepUnder('ghostfile:1')] }] },
    { tasks: [{ rel: 'docs/TASKS.md', items: [
      sec('real'), sec('ghostitem', { absent: true, diff: 'removed' }), stepUnder('ghoststep', { absent: true, diff: 'removed' }),
    ] }] },
  ]), 1)
  // Nothing to read is zero, never a throw.
  assert.equal(count([]), 0)
  assert.equal(count(undefined), 0)
  assert.equal(count([{}]), 0)
  assert.equal(count([{ tasks: [{ rel: 'docs/TASKS.md' }] }]), 0)
  assert.equal(projectDigest(undefined).counts.backlogItems, 0)
})

ok('counts.backlogSections counts headings only, where backlogItems counts the steps beneath them too', () => {
  const worktrees = [
    { isMain: true, tasks: [{ rel: 'docs/TASKS.md', items: [sec('a'), stepUnder('a:1'), sec('b'), stepUnder('b:1'), stepUnder('b:2')] }] },
    { tasks: [{ rel: 'docs/TASKS.md', absent: true, diff: 'removed', items: [sec('gone')] }] },
  ]
  const c = projectDigest({ worktrees }).counts
  assert.equal(c.backlogSections, 2)
  assert.equal(c.backlogItems, 5)
  assert.equal(projectDigest(undefined).counts.backlogSections, 0)
})

ok('foldBacklog tolerates absent, empty and malformed input', () => {
  assert.deepEqual(foldBacklog({ worktrees: [] }), [])
  assert.deepEqual(foldBacklog(undefined), [])
  assert.deepEqual(foldBacklog(null), [])
  assert.deepEqual(foldBacklog({}), [])
  assert.deepEqual(foldBacklog({ worktrees: [{}] }), [])
  assert.deepEqual(foldBacklog({ worktrees: [{ tasks: [{ rel: 'docs/TASKS.md' }] }] }), [])
})

// A project with a root TASKS.md beside a docs/TASKS.md, main listed SECOND,
// a TODO.md that one worktree lost, and a plan whose copies disagree about
// its declared spec.
const ROOTED_MAIN = '/Users/someone/tmp/rooted'
const ROOTED_WT = ROOTED_MAIN + '/.worktrees/side'
const rootedTasks = () => ({
  rel: 'TASKS.md',
  items: [sectionItem('TASKS.md', 0), bodyItem('TASKS.md', 0), sectionItem('TASKS.md', 1)],
})
const docsTasks = () => ({ rel: T, items: [sectionItem(T, 2), bodyItem(T, 2, { reported: true })] })
const ROOTED = {
  ...EMPTY, key: ROOTED_MAIN + '/.git', name: 'rooted', mainRoot: ROOTED_MAIN,
  worktrees: [
    wt(ROOTED_WT, 'side', false, {
      taskFile: 'TASKS.md', taskAuthority: 'root',
      plans: [plan('docs/plans/moved.md', 4, 4, {
        spec: 'docs/specs/side-copy.md', resolvedSpec: { ref: 'docs/specs/side-copy.md', broken: true }, resolvedTasks: [],
      })],
      tasks: [
        rootedTasks(), docsTasks(),
        { rel: 'TODO.md', absent: true, diff: 'removed', items: [sectionItem('TODO.md', 3, { absent: true, diff: 'removed', claimedBy: [S_ONE] })] },
      ],
    }),
    wt(ROOTED_MAIN, 'main', true, {
      taskFile: 'TASKS.md', taskAuthority: 'root',
      plans: [plan('docs/superpowers/plans/moved.md', 1, 4, {
        spec: 'docs/specs/main-copy.md',
        resolvedSpec: { ref: 'docs/specs/main-copy.md', name: 'main-copy.md', title: 'Main copy' },
        resolvedTasks: [{ ref: 'TASKS.md#backlog-zero', rel: 'TASKS.md', slug: 'backlog-zero', text: 'Backlog zero' }],
      })],
      tasks: [rootedTasks(), { rel: 'TODO.md', items: [sectionItem('TODO.md', 3)] }, docsTasks()],
    }),
  ],
}
ROOTED.efforts = foldEfforts(ROOTED.worktrees).efforts

ok('with a root TASKS.md and a docs/TASKS.md, both files\' sections are present and only the authority is marked', () => {
  const fold = foldBacklog(ROOTED)
  assert.deepEqual(fold.map((b) => [b.rel, b.slug, b.authority]), [
    ['TASKS.md', 'backlog-zero', true],
    ['TASKS.md', 'backlog-one', true],
    [T, 'backlog-two', false],
    ['TODO.md', 'backlog-three', false],
  ])
  assert.deepEqual(fold[2].body, [{ k: T + '#backlog-two:step', id: T + '#backlog-two:step', text: 'A step beneath backlog two', checked: false, reported: true }])
  // The worktree that lost TODO.md has no copy of its heading, and the claim
  // recorded on the ghost is not a claim.
  assert.deepEqual(fold[3].copies, [{ wt: ROOTED_MAIN, label: 'same' }])
  assert.deepEqual(fold[3].claimedBy, [])
  assert.deepEqual(fold[0].copies, [{ wt: ROOTED_WT, label: 'same' }, { wt: ROOTED_MAIN, label: 'same' }])
  const mine = fold.map(({ id, slug, text, claimedBy, rel, body }) => ({ id, slug, text, claimedBy, rel, body }))
  const rootedDoc = documentProjects([ROOTED], { now: NOW })[0]
  const pane = plain(MCPM.todosOf(rootedDoc).backlog).map(({ id, slug, text, claimedBy, rel, body }) => ({ id, slug, text, claimedBy, rel, body }))
  assert.deepEqual(mine, pane)
})

ok('main\'s copy supplies the declared references even when main is not the first worktree', () => {
  const [moved] = foldPlans(ROOTED)
  assert.equal(moved.spec, 'docs/specs/main-copy.md')
  assert.deepEqual(moved.resolvedSpec, { ref: 'docs/specs/main-copy.md', name: 'main-copy.md', title: 'Main copy' })
  const want = plain(MCPM.planIndexOf(documentProjects([ROOTED], { now: NOW })[0]).get('moved.md'))
  assert.deepEqual({ spec: moved.spec, resolvedSpec: moved.resolvedSpec, resolvedTasks: moved.resolvedTasks },
    { spec: want.spec, resolvedSpec: want.resolvedSpec, resolvedTasks: want.resolvedTasks })
  // Copies stay in worktree order; the side copy is further along than main's.
  assert.deepEqual(moved.copies.map((c) => [c.wt, c.label]), [[ROOTED_WT, 'ahead'], [ROOTED_MAIN, 'same']])
  assert.equal(moved.copies[0].currentItem, null, 'a finished copy has no current step')
})

// ---- stampChanged -----------------------------------------------------------------

ok('stampChanged: with no stamps yet, every project is stamped and moves', () => {
  const docs = documentProjects(SCAN, { now: NOW })
  const first = stampChanged(new Map(), docs, 1000)
  assert.ok(first.changedAt instanceof Map)
  assert.deepEqual([...first.changedAt], docs.map((d) => [d.key, 1000]))
  assert.deepEqual(first.moved, docs.map((d) => d.key))
  assert.deepEqual(stampChanged(null, docs, 1000).moved, first.moved)
})

ok('stampChanged: the same documents again move nothing and keep their stamps', () => {
  const docs = documentProjects(SCAN, { now: NOW })
  const first = stampChanged(undefined, docs, 1000)
  const second = stampChanged(first, documentProjects(structuredClone(SCAN), { now: NOW }), 2000)
  assert.deepEqual(second.moved, [])
  assert.deepEqual([...second.changedAt], docs.map((d) => [d.key, 1000]))
})

ok('stampChanged: one changed document moves only its own key', () => {
  const first = stampChanged(undefined, documentProjects(SCAN, { now: NOW }), 1000)
  const edited = structuredClone(SCAN)
  edited[0].worktrees[2].plans[0].done = 4
  const docs = documentProjects(edited, { now: NOW })
  const next = stampChanged(first, docs, 3000)
  assert.deepEqual(next.moved, [ALPHA.key])
  assert.equal(next.changedAt.get(ALPHA.key), 3000)
  assert.equal(next.changedAt.get(EMPTY.key), 1000)
  assert.equal(next.changedAt.get(NOTES.key), 1000)
  assert.deepEqual(stampChanged(next, docs, 4000).moved, [])
})

ok('stampChanged: a document that differs only in a worktree\'s sessions, or its own changedAt, moves nothing', () => {
  const docs = documentProjects(SCAN, { now: NOW })
  const first = stampChanged(undefined, docs, 1000)
  const flipped = structuredClone(docs)
  flipped[0].worktrees[0].sessions = [{ ...S_MAIN, working: false }, { ...S_ONE, working: true }]
  flipped[1].changedAt = 999
  const next = stampChanged(first, flipped, 2000)
  assert.deepEqual(next.moved, [])
  assert.equal(next.changedAt.get(ALPHA.key), 1000)
})

ok('stampChanged: a project gone from the board is dropped from the map, and nothing passed in is written to', () => {
  const docs = documentProjects(SCAN, { now: NOW })
  const first = stampChanged(undefined, docs, 1000)
  const stamps = [...first.changedAt]
  const prints = [...first.prints]
  const before = JSON.stringify(docs)
  const next = stampChanged(first, docs.slice(1), 2000)
  assert.equal(next.changedAt.has(ALPHA.key), false)
  assert.equal(next.changedAt.size, 2)
  assert.deepEqual(next.moved, [])
  assert.deepEqual([...first.changedAt], stamps, 'the previous stamps were written to')
  assert.deepEqual([...first.prints], prints, 'the previous prints were written to')
  assert.equal(JSON.stringify(docs), before, 'the documents were written to')
  // Coming back is a change like any other.
  assert.deepEqual(stampChanged(next, docs, 3000).moved, [ALPHA.key])
})

// ---- purity -------------------------------------------------------------------

ok('no function mutates the scan it reads', () => {
  digestProjects(SCAN, { now: NOW })
  documentProjects(SCAN, { now: NOW })
  for (const p of SCAN) {
    projectDigest(p, { now: NOW })
    projectDocument(p, { now: NOW })
    foldPlans(p)
    foldBacklog(p)
    needsFlags(p)
  }
  stampChanged(stampChanged(undefined, documentProjects(SCAN, { now: NOW }), 1), documentProjects(SCAN, { now: NOW }), 2)
  assert.deepEqual(SCAN, PRISTINE)
})

ok('tasks-digest.mjs reads no file, no clock and no environment, and imports only tasks-efforts.mjs', () => {
  const src = readFileSync(join(ROOT, 'syzygy', 'bridge', 'tasks-digest.mjs'), 'utf8')
  assert.equal(/readFileSync|Date\.now|process\./.test(src), false)
  const imports = [...src.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['./tasks-efforts.mjs'])
})

ok('tasks.mjs re-exports the digest, so the relay keeps importing one module for the scanner', () => {
  const names = { DIGEST_EFFORTS, projectDigest, digestProjects, projectDocument, documentProjects, foldPlans, foldBacklog, needsFlags, stampChanged }
  for (const [name, value] of Object.entries(names)) assert.equal(tasksModule[name], value, name)
})

// ---- a real capture -----------------------------------------------------------

ok('over a real captured board the digest throws nothing, stays lean, and agrees with the pane', () => {
  const STATE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'projects', 'state.json'), 'utf8'))
  const digest = digestProjects(STATE.projects, { now: NOW })
  const json = JSON.stringify(digest)
  assert.equal(FAT_KEY.test(json), false, 'a fat key reached the digest: ' + json.match(FAT_KEY)?.[0])
  const docs = documentProjects(STATE.projects, { now: NOW })
  assert.equal(docs.length, STATE.projects.length)
  for (const [i, p] of STATE.projects.entries()) {
    const digestOne = projectDigest(p, { now: NOW })
    const doc = docs[i]
    assert.deepEqual(digestOne.worktrees.map((w) => w.diff), plain(MCPM.worktreesOf(digestOne)).map((w) => w.diff), p.name)
    const mine = foldBacklog(p).map(({ id, slug, text, claimedBy, rel, body }) => ({ id, slug, text, claimedBy, rel, body }))
    const pane = plain(MCPM.todosOf(doc).backlog).map(({ id, slug, text, claimedBy, rel, body }) => ({ id, slug, text, claimedBy, rel, body }))
    assert.deepEqual(mine, pane, p.name + ' backlog')
    const idx = MCPM.planIndexOf(doc)
    for (const f of foldPlans(p)) {
      const want = plain(idx.get(f.name))
      assert.deepEqual([f.spec, f.resolvedSpec, f.resolvedTasks], [want.spec, want.resolvedSpec, want.resolvedTasks], f.name)
    }
    assert.equal(digestOne.counts.plans, foldPlans(p).length, p.name + ': one fold per counted basename')
  }
  assert.deepEqual(STATE.projects, JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'projects', 'state.json'), 'utf8')).projects,
    'the captured board was written to')
})

// ---- the budget ---------------------------------------------------------------
// The digest's size follows projects and worktrees. A board of a dozen
// worktrees each carrying forty plans of a hundred and twenty steps, and sixty
// backlog headings, is megabytes as scanned; its digest has to stay small
// enough to send on every change without a second thought.

const DIGEST_BUDGET_BYTES = 64 * 1024
{
  const WORKTREES = 12, PLANS = 40, STEPS = 120, SECTIONS = 60
  const session = { id: '00000000-0000-4000-8000-000000000000', name: 'payload-budget' }
  const history = { firstSeen: 1_700_000_000_000, checkedAt: 1_700_000_100_000, checkedBy: session, uncheckedAt: null, removedAt: null }
  const hex = (n) => n.toString(16).padStart(12, '0')
  let nextId = 0
  const planItems = () => {
    const items = []
    for (let s = 0; s < STEPS; s++) {
      if (s % 12 === 0) {
        items.push({ id: hex(nextId++), kind: 'section', text: 'Task ' + (s / 12 + 1) + ': a heading of an ordinary length', checked: null, reported: false, depth: 0, line: s * 3, slug: 'task-' + (s / 12 + 1) + '-a-heading-of-an-ordinary-length', history, diff: 'same' })
      }
      items.push({ id: hex(nextId++), kind: 'step', text: 'Step ' + (s + 1) + ': write the failing test for an ordinary plan step', checked: s < STEPS / 2, reported: false, depth: 0, line: s * 3 + 1, history, diff: 'same' })
    }
    return items
  }
  const backlog = () => Array.from({ length: SECTIONS }, (_, n) => ({
    id: hex(1_000_000 + n), kind: 'section', text: 'Backlog heading ' + n + ': something deferred that outlives a session', checked: null, reported: false, depth: 0, line: n * 20, slug: 'backlog-heading-' + n + '-something-deferred-that-outlives-a-session', history, diff: 'same',
  }))
  const worktrees = Array.from({ length: WORKTREES }, (_, w) => ({
    path: '/Users/someone/tmp/project/.worktrees/branch-' + w, branch: 'feature/branch-' + w, head: 'abcdef1', isMain: w === 0,
    detached: false, locked: false, sessions: [{ id: session.id, name: session.name, working: false }],
    plans: Array.from({ length: PLANS }, (_, p) => {
      const rel = 'docs/plans/plan-number-' + p + '-an-ordinary-length.md'
      const items = planItems()
      return {
        rel, dir: 'plans', title: 'Plan number ' + p + ' implementation plan', spec: 'docs/specs/plan-number-' + p + '-design.md',
        tasks: ['docs/TASKS.md#backlog-heading-' + p + '-something-deferred-that-outlives-a-session'], shipped: null, shippedMalformed: null,
        items, currentItemId: items.find((i) => i.kind === 'step' && !i.checked).id,
        done: STEPS / 2, reported: 0, total: STEPS, owner: { ...session, source: 'claim' }, diff: 'same', mtimeMs: 1_700_000_000_000.5,
        resolvedTasks: [{ ref: 'docs/TASKS.md#backlog-heading-' + p, rel: 'docs/TASKS.md', slug: 'backlog-heading-' + p, text: 'Backlog heading ' + p }],
        resolvedSpec: { ref: 'docs/specs/plan-number-' + p + '-design.md', name: 'plan-number-' + p + '-design.md', title: 'Plan number ' + p + ' design' },
      }
    }),
    tasks: [{ rel: 'docs/TASKS.md', items: backlog() }],
    taskFile: 'docs/TASKS.md', taskAuthority: 'docs', specs: [], skipped: [],
    claims: { [session.id]: { name: session.name, items: [{ kind: 'plan', id: 'plan-number-0-an-ordinary-length.md' }] } },
  }))
  const board = [{
    key: '/Users/someone/tmp/project/.git', name: 'project', isGit: true, mainRoot: '/Users/someone/tmp/project',
    overCap: { projects: 0, worktrees: 0 }, roll: { onlyHere: 0, removed: 0, doneHere: 0, behind: 0 },
    efforts: foldEfforts(worktrees).efforts, planCollisions: [], features: [], featureCollisions: [],
    specs: [], brokenRefs: [], malformedShipped: [], unresolvedClaims: [], gitGraph: null, worktrees,
  }]

  ok('12 worktrees x 40 plans x 120 steps + 60 backlog sections digest under 64 KB', () => {
    const before = JSON.stringify(board)
    const fullBytes = Buffer.byteLength(before)
    assert.ok(fullBytes > 10 * DIGEST_BUDGET_BYTES, 'the board must be heavy enough that the scan itself fails the budget, got ' + fullBytes)
    const digest = digestProjects(board, { now: NOW })
    const bytes = Buffer.byteLength(JSON.stringify(digest))
    const docBytes = Buffer.byteLength(JSON.stringify(documentProjects(board, { now: NOW })))
    console.log('  projects: ' + fullBytes + ' bytes scanned, ' + bytes + ' bytes digested, ' + docBytes + ' bytes as documents')
    assert.equal(digest[0].counts.steps, WORKTREES * PLANS * STEPS)
    assert.equal(digest[0].counts.plans, PLANS)
    assert.equal(digest[0].counts.backlogSections, SECTIONS)
    assert.ok(bytes < DIGEST_BUDGET_BYTES, 'the digest is ' + bytes + ' bytes, over the ' + DIGEST_BUDGET_BYTES + ' budget')
    assert.equal(JSON.stringify(board), before, 'the digest must not mutate the scan it reads')
  })
}

// ---- the routes, on a real relay ----------------------------------------------
// A mocked relay cannot prove a route ladder. The relay runs as a child on an
// OS-assigned port with a throwaway data directory and no SZG_* variable
// inherited, and its board is made here: a git repository holding one plan and
// one task file, and a plain directory that is not a repository, each the cwd
// of one registered session.

const okAsync = async (label, fn) => { await fn(); passed++; console.log('✔ ' + label) }

{
  const relayPath = join(ROOT, 'syzygy', 'bridge', 'relay.mjs')
  const TOKEN = 'digest-harness-' + Math.random().toString(36).slice(2)
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'szg-digest-relay-')))
  const dataDir = join(scratch, 'data')
  const repo = join(scratch, 'repo')
  const plainDir = join(scratch, 'plain')
  mkdirSync(dataDir)
  mkdirSync(join(repo, 'docs', 'plans'), { recursive: true })
  mkdirSync(join(plainDir, 'docs', 'plans'), { recursive: true })
  // Longer than the largest page, so the default page and the clamp are real
  // slices rather than numbers echoed back.
  const LONG_STEPS = 2100
  writeFileSync(join(plainDir, 'docs', 'plans', 'long.md'),
    '# Long\n\n' + Array.from({ length: LONG_STEPS }, (_, i) => '- [ ] long step ' + i).join('\n') + '\n')
  const fakeClaude = join(scratch, 'claude')
  writeFileSync(fakeClaude, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  const ALPHA_STEPS = 12
  const alphaText = (checked) => '# Alpha\n\n' + Array.from({ length: ALPHA_STEPS }, (_, i) =>
    '- [' + (i < checked ? 'x' : ' ') + '] Step ' + (i + 1) + ': alpha step number ' + (i + 1)).join('\n') + '\n'
  writeFileSync(join(repo, 'docs', 'plans', 'alpha.md'), alphaText(2))
  writeFileSync(join(repo, 'docs', 'TASKS.md'), [
    '# Tasks', '',
    '## First deferred thing', '', '- [ ] a step beneath the first', '',
    '## Second deferred thing', '', '- [ ] a step beneath the second', '',
  ].join('\n'))
  const git = (...args) => execFileSync('git', ['-c', 'user.email=harness@example.invalid', '-c', 'user.name=harness',
    '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', 'docs')
  git('commit', '-q', '-m', 'fixture')

  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SZG_')))
  const child = spawn(process.execPath, [relayPath], {
    cwd: ROOT,
    env: {
      ...baseEnv, SZG_PORT: '0', SZG_TOKEN: TOKEN, SZG_DATA_DIR: dataDir, SZG_PANE_PASSWORD_DISABLED: '1',
      SZG_CLAUDE_BIN: fakeClaude, SZG_TMUX_BIN: '/usr/bin/false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => { stdout += c })
  child.stderr.on('data', (c) => { stderr += c })

  try {
    const port = await new Promise((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error('relay did not report a port; stderr: ' + stderr)), 15_000)
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error('relay exited early, code ' + code + '; stderr: ' + stderr)) })
      const poll = setInterval(() => {
        const m = stdout.match(/relay on http:\/\/127\.0\.0\.1:(\d+)/)
        if (!m) return
        clearInterval(poll); clearTimeout(timer); resolvePort(Number(m[1]))
      }, 50)
    })
    const base = 'http://127.0.0.1:' + port
    const call = async (method, path, body) => {
      const res = await fetch(base + path, {
        method, headers: { 'content-type': 'application/json', 'x-mch-token': TOKEN },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      let parsed = null
      try { parsed = JSON.parse(text) } catch {}
      return { status: res.status, cache: res.headers.get('cache-control'), text, body: parsed }
    }
    const SESSIONS = [
      { id: '00000000-0000-4000-8000-0000000000d1', name: 'digest-repo', cwd: repo },
      { id: '00000000-0000-4000-8000-0000000000d2', name: 'digest-plain', cwd: plainDir },
    ]
    // Re-registered before every long wait, so neither session ages out of the
    // board while the harness is still reading it.
    const beat = async () => {
      for (const session of SESSIONS) {
        const r = await call('POST', '/api/register', { token: TOKEN, session })
        assert.equal(r.status, 200, 'register failed: ' + r.text)
      }
    }
    const pause = (ms) => new Promise((r) => setTimeout(r, ms))
    await beat()

    const byRoot = (list, root) => (list ?? []).find((p) => p.mainRoot === root)
    let state = null
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      state = (await call('GET', '/api/state')).body
      if (byRoot(state?.projects, repo)?.counts?.plans && byRoot(state?.projects, plainDir)) break
      await pause(200)
    }
    const repoDigest = byRoot(state?.projects, repo)
    const plainDigest = byRoot(state?.projects, plainDir)
    assert.ok(repoDigest && plainDigest, 'the relay never scanned both registered cwds; projects: ' +
      JSON.stringify(state?.projects)?.slice(0, 400) + '; stderr: ' + stderr)

    await okAsync('/api/state carries one digest per project, no fat list anywhere, and a numeric changedAt', () => {
      assert.ok(state.payloadVersion > 17, 'the digest ships at a payloadVersion past 17, got ' + state.payloadVersion)
      assert.equal(state.projects.length, 2)
      const json = JSON.stringify(state.projects)
      assert.equal(FAT_KEY.test(json), false, 'a fat key reached /api/state: ' + json.match(FAT_KEY)?.[0])
      for (const p of state.projects) {
        assert.deepEqual(sortedKeys(p), [...DIGEST_KEYS].sort(), p.name)
        assert.equal(typeof p.changedAt, 'number', p.name + ' changedAt')
        for (const w of p.worktrees) assertLine(w, p.name + ' worktree line')
      }
      assert.equal(repoDigest.isGit, true)
      assert.equal(plainDigest.isGit, false)
      assert.equal(repoDigest.counts.plans, 1)
      assert.equal(repoDigest.counts.steps, ALPHA_STEPS)
      assert.equal(repoDigest.counts.backlogSections, 2)
      assert.equal(repoDigest.worktrees[0].planCount, 1)
      // Nothing claims alpha.md, so the digest carries no effort and counts it.
      assert.deepEqual(repoDigest.efforts, [])
      assert.equal(repoDigest.moreEfforts, 1)
    })

    await okAsync('GET /api/projects answers every project\'s document, folds included, with the digest\'s changedAt', async () => {
      const r = await call('GET', '/api/projects')
      assert.equal(r.status, 200, r.text)
      assert.equal(r.cache, 'no-store')
      assert.ok(Array.isArray(r.body.projects))
      assert.equal(r.body.projects.length, 2)
      for (const doc of r.body.projects) {
        assert.deepEqual(sortedKeys(doc), [...DIGEST_KEYS, ...DOCUMENT_EXTRA].sort(), doc.name)
        for (const k of ['plans', 'backlog', 'features', 'specs']) assert.ok(Array.isArray(doc[k]), doc.name + ' ' + k)
        assert.equal(doc.changedAt, state.projects.find((p) => p.key === doc.key).changedAt, doc.name + ' changedAt')
      }
      const doc = byRoot(r.body.projects, repo)
      assert.equal(doc.efforts.length, 1, 'the document carries every effort, claimed or not')
      assert.equal(doc.efforts[0].currentItem, 'Step 3: alpha step number 3')
      assert.deepEqual(doc.plans.map((p) => [p.name, p.done, p.total]), [['alpha.md', 2, ALPHA_STEPS]])
      assert.deepEqual(doc.backlog.map((b) => [b.text, b.body.length]), [['First deferred thing', 1], ['Second deferred thing', 1]])
      assert.deepEqual(doc.worktrees[0].plans, [{ ref: 'alpha.md', label: 'same' }])
      assert.deepEqual(byRoot(r.body.projects, plainDir).plans.map((p) => [p.name, p.done, p.total]), [['long.md', 0, LONG_STEPS]])
    })

    await okAsync('GET /api/projects/<key> answers one document by its encoded key, and 404 for anything else', async () => {
      for (const p of state.projects) {
        const r = await call('GET', '/api/projects/' + encodeURIComponent(p.key))
        assert.equal(r.status, 200, p.key + ': ' + r.text)
        assert.equal(r.cache, 'no-store')
        assert.equal(r.body.project.key, p.key)
        assert.deepEqual(sortedKeys(r.body.project), [...DIGEST_KEYS, ...DOCUMENT_EXTRA].sort())
      }
      assert.ok(repoDigest.key.includes('/'), 'a git project is keyed by a path, so the key must travel encoded')
      for (const bad of ['nope-not-a-key', '', '%E0%A4%A', encodeURIComponent('/nope/.git')]) {
        const r = await call('GET', '/api/projects/' + bad)
        assert.equal(r.status, 404, JSON.stringify(bad) + ' answered ' + r.status)
        assert.deepEqual(r.body, { error: 'unknown project' }, JSON.stringify(bad))
      }
      // An unencoded key is a deeper path, never a lookup.
      const deep = await call('GET', '/api/projects' + repoDigest.key)
      assert.notEqual(deep.status, 200)
      assert.equal(deep.body?.project, undefined)
      assert.equal((await call('GET', '/api/health')).status, 200, 'a malformed escape took the relay down')
    })

    await okAsync('both document routes are GET/HEAD-only', async () => {
      for (const path of ['/api/projects', '/api/projects/' + encodeURIComponent(repoDigest.key)]) {
        const head = await call('HEAD', path)
        assert.equal(head.status, 200, 'HEAD ' + path)
        assert.equal(head.text, '', 'HEAD ' + path + ' sent a body')
        const posted = await call('POST', path, { token: TOKEN })
        assert.notEqual(posted.status, 200, 'POST ' + path + ' was answered by a read route')
        assert.equal(posted.body?.projects, undefined)
        assert.equal(posted.body?.project, undefined)
      }
    })

    // ---- the item routes ----------------------------------------------------
    const ALPHA_REL = 'docs/plans/alpha.md'
    const LONG_REL = 'docs/plans/long.md'
    const TASKS_REL = 'docs/TASKS.md'
    const repoWt = repoDigest.worktrees[0].path
    const plainWt = plainDigest.worktrees[0].path
    const itemsQ = (route) => (wtPath, rel, extra = '') => '/api/projects/' + route +
      '?wt=' + encodeURIComponent(wtPath) + '&path=' + encodeURIComponent(rel) + extra
    const planQ = itemsQ('plan')
    const backlogQ = itemsQ('backlog')
    const graphQ = (key) => '/api/projects/graph?key=' + encodeURIComponent(key)
    const refuses = async (path, status, error) => {
      const r = await call('GET', path)
      assert.equal(r.status, status, path + ' answered ' + r.status + ': ' + r.text)
      assert.deepEqual(r.body, { error }, path)
      assert.equal(r.cache, 'no-store', path)
    }

    await okAsync('GET /api/projects/plan answers one page of a scanned plan, its total and its project\'s changedAt', async () => {
      const r = await call('GET', planQ(repoWt, ALPHA_REL))
      assert.equal(r.status, 200, r.text)
      assert.equal(r.cache, 'no-store')
      assert.deepEqual(sortedKeys(r.body), ['changedAt', 'limit', 'offset', 'plan', 'total'])
      assert.equal(r.body.offset, 0)
      assert.equal(r.body.limit, 500)
      assert.equal(r.body.plan.rel, ALPHA_REL)
      assert.ok(r.body.total >= ALPHA_STEPS)
      assert.equal(r.body.plan.items.length, r.body.total)
      for (const it of r.body.plan.items) {
        assert.ok('diff' in it && 'history' in it, 'a plan item arrived without diff or history: ' + JSON.stringify(it))
      }
      assert.equal(r.body.changedAt, repoDigest.changedAt)
      const long = (await call('GET', planQ(plainWt, LONG_REL))).body
      assert.ok(long.total >= LONG_STEPS)
      assert.equal(long.plan.items.length, 500, 'the default page is 500 items')
      assert.equal(long.changedAt, plainDigest.changedAt)
    })

    await okAsync('offset and limit page a plan: a clamp at 2000, the default for anything unusable, an empty page past the end', async () => {
      const ids = (await call('GET', planQ(repoWt, ALPHA_REL, '&limit=2000'))).body.plan.items.map((i) => i.id)
      const page = (await call('GET', planQ(repoWt, ALPHA_REL, '&offset=2&limit=3'))).body
      assert.deepEqual(page.plan.items.map((i) => i.id), ids.slice(2, 5))
      assert.deepEqual([page.offset, page.limit, page.total], [2, 3, ids.length])
      const floored = (await call('GET', planQ(repoWt, ALPHA_REL, '&offset=2.7&limit=3.9'))).body
      assert.deepEqual(floored.plan.items.map((i) => i.id), ids.slice(2, 5))

      const long = async (extra) => (await call('GET', planQ(plainWt, LONG_REL, extra))).body
      const clamped = await long('&limit=99999')
      assert.equal(clamped.limit, 2000)
      assert.equal(clamped.plan.items.length, 2000)
      for (const bad of ['&limit=0', '&limit=-1', '&limit=lots', '&limit=', '&offset=-4&limit=NaN', '&offset=soon']) {
        const b = await long(bad)
        assert.deepEqual([b.offset, b.limit, b.plan.items.length], [0, 500, 500], bad)
      }
      const rest = await long('&offset=2000&limit=2000')
      assert.equal(clamped.total, rest.total)
      assert.deepEqual([...clamped.plan.items, ...rest.plan.items].map((i) => i.id).length, clamped.total, 'two pages must tile the plan')
      assert.equal(new Set([...clamped.plan.items, ...rest.plan.items].map((i) => i.id)).size, clamped.total)

      const past = await call('GET', planQ(repoWt, ALPHA_REL, '&offset=' + (ids.length + 10)))
      assert.equal(past.status, 200, 'an offset past the end is not an error')
      assert.deepEqual(past.body.plan.items, [])
      assert.equal(past.body.total, ids.length)
    })

    await okAsync('the plan route answers 400 for a worktree or a file the scan does not hold', async () => {
      await refuses(planQ('/nope', ALPHA_REL), 400, 'unknown worktree')
      await refuses('/api/projects/plan?path=' + encodeURIComponent(ALPHA_REL), 400, 'unknown worktree')
      await refuses(planQ('', ALPHA_REL), 400, 'unknown worktree')
      await refuses(planQ(repoWt + '/', ALPHA_REL), 400, 'unknown worktree')
      await refuses('/api/projects/plan?wt=' + encodeURIComponent(repoWt), 400, 'unknown file')
      await refuses(planQ(repoWt, '../../../etc/passwd'), 400, 'unknown file')
      await refuses(planQ(repoWt, join(repoWt, ALPHA_REL)), 400, 'unknown file')
      await refuses(planQ(repoWt, TASKS_REL), 400, 'unknown file')
      await refuses(planQ(plainWt, ALPHA_REL), 400, 'unknown file')
    })

    await okAsync('GET /api/projects/backlog pages a scanned task file the same way, and refuses the same way', async () => {
      const r = await call('GET', backlogQ(repoWt, TASKS_REL))
      assert.equal(r.status, 200, r.text)
      assert.equal(r.cache, 'no-store')
      assert.deepEqual(sortedKeys(r.body), ['changedAt', 'file', 'limit', 'offset', 'total'])
      assert.deepEqual([r.body.offset, r.body.limit], [0, 500])
      assert.equal(r.body.file.rel, TASKS_REL)
      const ids = r.body.file.items.map((i) => i.id)
      assert.equal(r.body.total, ids.length)
      assert.deepEqual(r.body.file.items.filter((i) => i.kind === 'section').map((i) => i.text), ['First deferred thing', 'Second deferred thing'])
      assert.ok(ids.length >= 4)
      for (const it of r.body.file.items) {
        assert.ok('diff' in it && 'history' in it, 'a task item arrived without diff or history: ' + JSON.stringify(it))
      }
      assert.equal(r.body.changedAt, repoDigest.changedAt)

      const page = (await call('GET', backlogQ(repoWt, TASKS_REL, '&offset=1&limit=2'))).body
      assert.deepEqual(page.file.items.map((i) => i.id), ids.slice(1, 3))
      assert.deepEqual([page.offset, page.limit, page.total], [1, 2, ids.length])
      assert.equal((await call('GET', backlogQ(repoWt, TASKS_REL, '&limit=99999'))).body.limit, 2000)
      for (const bad of ['&limit=0', '&limit=-1', '&limit=lots']) {
        assert.equal((await call('GET', backlogQ(repoWt, TASKS_REL, bad))).body.limit, 500, bad)
      }
      const past = (await call('GET', backlogQ(repoWt, TASKS_REL, '&offset=99'))).body
      assert.deepEqual([past.file.items, past.total], [[], ids.length])

      await refuses(backlogQ('/nope', TASKS_REL), 400, 'unknown worktree')
      await refuses('/api/projects/backlog?path=' + encodeURIComponent(TASKS_REL), 400, 'unknown worktree')
      await refuses('/api/projects/backlog?wt=' + encodeURIComponent(repoWt), 400, 'unknown file')
      await refuses(backlogQ(repoWt, '../../../etc/passwd'), 400, 'unknown file')
      await refuses(backlogQ(repoWt, ALPHA_REL), 400, 'unknown file')
    })

    await okAsync('GET /api/projects/graph answers the scan\'s git graph by key, null for a directory that is not a repository', async () => {
      const r = await call('GET', graphQ(repoDigest.key))
      assert.equal(r.status, 200, r.text)
      assert.equal(r.cache, 'no-store')
      assert.deepEqual(sortedKeys(r.body), ['changedAt', 'gitGraph'])
      assert.ok(Array.isArray(r.body.gitGraph?.branches), 'a git project answered no graph: ' + r.text)
      assert.ok(r.body.gitGraph.branches.some((b) => (b.commits ?? []).some((c) => c.subject === 'fixture')),
        'the graph does not hold the fixture commit: ' + r.text)
      assert.equal(r.body.changedAt, repoDigest.changedAt)
      const plain = await call('GET', graphQ(plainDigest.key))
      assert.equal(plain.status, 200, plain.text)
      assert.deepEqual(plain.body, { gitGraph: null, changedAt: plainDigest.changedAt })
      await refuses(graphQ('nope'), 404, 'unknown project')
      await refuses('/api/projects/graph', 404, 'unknown project')
    })

    await okAsync('the three item routes are GET/HEAD-only', async () => {
      for (const path of [planQ(repoWt, ALPHA_REL), backlogQ(repoWt, TASKS_REL), graphQ(repoDigest.key)]) {
        const head = await call('HEAD', path)
        assert.equal(head.status, 200, 'HEAD ' + path)
        assert.equal(head.text, '', 'HEAD ' + path + ' sent a body')
        const posted = await call('POST', path, { token: TOKEN })
        assert.notEqual(posted.status, 200, 'POST ' + path + ' was answered by a read route')
        for (const k of ['plan', 'file', 'gitGraph']) assert.equal(posted.body?.[k], undefined, 'POST ' + path + ' carried ' + k)
      }
    })

    await okAsync('changedAt holds while nothing changes, and an edit moves only its own project and broadcasts the digest', async () => {
      await beat()
      const before = new Map(state.projects.map((p) => [p.key, p.changedAt]))
      // Longer than one scan interval: an unchanged pass must keep every stamp.
      await pause(4_600)
      const still = (await call('GET', '/api/state')).body
      for (const p of still.projects) assert.equal(p.changedAt, before.get(p.key), p.name + ' was restamped by a pass that changed nothing')

      const ac = new AbortController()
      const frames = []
      const streamed = fetch(base + '/api/stream?token=' + TOKEN, { signal: ac.signal }).then(async (res) => {
        const dec = new TextDecoder()
        let buf = ''
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true })
          let at
          while ((at = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, at)
            buf = buf.slice(at + 2)
            const ev = /^event: (\S+)/m.exec(raw), data = /^data: (.*)$/m.exec(raw)
            if (ev && data) frames.push({ type: ev[1], data: data[1] })
          }
        }
      }).catch(() => {})

      writeFileSync(join(repo, 'docs', 'plans', 'alpha.md'), alphaText(3))
      let moved = null
      const until = Date.now() + 15_000
      while (Date.now() < until) {
        moved = (await call('GET', '/api/state')).body
        if (byRoot(moved.projects, repo).changedAt !== before.get(repoDigest.key)) break
        await pause(200)
      }
      await pause(300)
      ac.abort()
      await streamed
      assert.ok(byRoot(moved.projects, repo).changedAt > before.get(repoDigest.key), 'the edited project\'s changedAt never moved')
      assert.equal(byRoot(moved.projects, plainDir).changedAt, before.get(plainDigest.key), 'an untouched project was restamped')
      const doc = (await call('GET', '/api/projects/' + encodeURIComponent(repoDigest.key))).body.project
      assert.equal(doc.plans[0].done, 3)
      assert.equal(doc.changedAt, byRoot(moved.projects, repo).changedAt)
      const sent = frames.filter((f) => f.type === 'projects').map((f) => f.data)
      assert.ok(sent.length >= 1, 'the edit broadcast no projects frame: ' + frames.map((f) => f.type).join(', '))
      for (const data of sent) assert.equal(FAT_KEY.test(data), false, 'a projects frame carried a fat key: ' + data.match(FAT_KEY)?.[0])
      assert.equal(byRoot(JSON.parse(sent.at(-1)), repo).counts.plans, 1)
    })
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((r) => child.once('exit', r))
      child.kill('SIGTERM')
      await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\n✔ all ' + passed + ' tasks-digest checks passed')
