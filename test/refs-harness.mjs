#!/usr/bin/env node
// Harness for the reference resolver. Pure: no I/O, no git, no clock.
import assert from 'node:assert/strict'
import { buildIndex, resolveRef } from '../syzygy/bridge/refs.mjs'

let passed = 0
const ok = (label) => { console.log('✔ ' + label); passed++ }

// A project shaped the way the scanner publishes one. Deliberately minimal --
// only the fields the index reads.
const section = (slug, text) => ({ id: 'x' + slug, kind: 'section', slug, text })
const project = {
  worktrees: [{
    path: '/main', isMain: true,
    tasks: [{ rel: 'docs/TASKS.md', items: [
      section('browser-pane--finish-the-patch-bay', 'Browser pane — finish the patch bay'),
      section('grid--second-pass', 'GRID — second pass'),
    ] }],
    plans: [{ rel: 'docs/plans/2025-01-02-alpha.md', title: 'Alpha Implementation Plan' }],
    specs: ['docs/specs/2025-01-02-alpha-design.md'],
  }],
  features: [{ rel: 'docs/FEATURES.md', name: 'Alpha feature', slug: 'alpha-feature', date: '2025-01-04' }],
}

// --- a declared backlog reference, which is what  /  asked for -----
// `parseHeader` has produced `plan.tasks` since the Projects tab shipped, the
// payload has carried it, and `item.slug` has been computed for every backlog
// section -- and nothing has ever matched one against the other. This is that
// join, and it is the same join the ask->feature mapping needs.
{
  const ix = buildIndex(project)
  const hit = resolveRef(ix, 'backlog', 'docs/TASKS.md#browser-pane--finish-the-patch-bay')
  assert.equal(hit.broken, undefined, 'a real backlog reference resolved as broken')
  assert.equal(hit.kind, 'backlog')
  assert.equal(hit.target.text, 'Browser pane — finish the patch bay')
  ok('resolveRef joins a declared docs/TASKS.md#slug to its section item')
}

// A miss is REPORTED, never dropped: a renamed heading must be visible.
{
  const ix = buildIndex(project)
  const miss = resolveRef(ix, 'backlog', 'docs/TASKS.md#no-such-heading')
  assert.equal(miss.broken, true)
  assert.equal(miss.ref, 'docs/TASKS.md#no-such-heading', 'the broken reference must carry what was written')
  assert.equal(miss.kind, 'backlog')
  ok('a declared reference that resolves nowhere is reported as broken, not dropped')
}

// A plan is keyed by BASENAME, so a reference survives the directory move that
// broke path identity outright once already.
{
  const ix = buildIndex(project)
  const byBase = resolveRef(ix, 'plan', '2025-01-02-alpha.md')
  const byPath = resolveRef(ix, 'plan', 'docs/plans/2025-01-02-alpha.md')
  const byOldPath = resolveRef(ix, 'plan', 'docs/superpowers/plans/2025-01-02-alpha.md')
  assert.equal(byBase.target.title, 'Alpha Implementation Plan')
  assert.deepEqual(byPath.target, byBase.target)
  assert.deepEqual(byOldPath.target, byBase.target, 'a reference written at the OLD path must still resolve')
  ok('a plan reference resolves by basename, from either directory or bare')
}

// THE CASE. This is the whole reason matching is exact.
{
  const ix = buildIndex(project)
  // The GRID plan's title shares almost nothing with the backlog heading that
  // really is its input, while two OTHER headings match it strongly and are
  // both wrong -- they are its output. A fuzzy resolver picks one confidently.
  for (const wrong of ['docs/TASKS.md#grid--second-pass', 'grid--second-pass', 'Alpha Implementation Plan']) {
    const r = resolveRef(ix, 'plan', wrong)
    assert.equal(r.broken, true, 'fuzzy matching resolved ' + wrong + ' to a plan')
  }
  // And the reverse: a plan basename must not resolve as a backlog entry.
  assert.equal(resolveRef(ix, 'backlog', '2025-01-02-alpha.md').broken, true)
  ok('nothing is matched by similarity — the worked example resolves to neither heading')
}

// A ghost is not a reference target. `routeRemoved` gives an absent plan
// plan-shaped fields, so an index that did not filter would resolve a
// reference to a plan this worktree does not have.
{
  const ghosted = { worktrees: [{ path: '/w1', plans: [
    { rel: 'docs/plans/only-a-ghost.md', title: 'Ghost', absent: true },
  ], tasks: [], specs: [] }], features: [] }
  assert.equal(resolveRef(buildIndex(ghosted), 'plan', 'only-a-ghost.md').broken, true)
  ok('a ghost plan is not indexed as a resolvable target')
}

// One plan in eight worktrees is one entry. Every worktree inherits every
// committed plan; which checkout it was read from is not part of its identity.
{
  const many = { worktrees: [1, 2, 3].map((n) => ({
    path: '/w' + n, plans: [{ rel: 'docs/plans/same.md', title: 'Same', n }], tasks: [], specs: [],
  })), features: [] }
  const ix = buildIndex(many)
  assert.equal(ix.plan.size, 1, 'three copies of one plan produced ' + ix.plan.size + ' entries')
  ok('the same plan in several worktrees is one index entry')
}

// A spec and a feature, and the feature's date-free identity.
{
  const ix = buildIndex(project)
  assert.equal(resolveRef(ix, 'spec', 'docs/specs/2025-01-02-alpha-design.md').target.rel,
    'docs/specs/2025-01-02-alpha-design.md')
  assert.equal(resolveRef(ix, 'feature', 'alpha-feature').target.date, '2025-01-04')
  assert.equal(resolveRef(ix, 'feature', 'alpha-feature--2025-01-04').broken, true,
    'a feature must not be referenceable by a slug carrying its date')
  ok('a spec resolves by basename and a feature by its date-free slug')
}

// A malformed kind is broken, not a crash. A hand-edited `relatesTo` can carry
// anything, and the same rule already governs a claim with a bad `kind`.
{
  const ix = buildIndex(project)
  for (const bad of ['plans', 'Backlog', '', null, undefined, '__proto__']) {
    const r = resolveRef(ix, bad, 'docs/TASKS.md#grid--second-pass')
    assert.equal(r.broken, true, 'kind ' + JSON.stringify(bad) + ' did not report broken')
  }
  assert.equal(resolveRef(ix, 'backlog', null).broken, true)
  assert.equal(resolveRef(undefined, 'backlog', 'x').broken, true)
  ok('an unknown kind, an empty reference and a missing index all report broken')
}


// The scanner now folds specs at PROJECT level, with titles, so the index
// should prefer that over re-deriving them from every worktree's path list --
// otherwise a `Spec:` reference resolves to a bare {rel} with no title and the
// planned-features view has nothing to show.
{
  const proj = {
    specs: [{ name: '2025-01-05-thing-design.md', rel: 'docs/specs/2025-01-05-thing-design.md', title: 'The Thing' }],
    worktrees: [{ path: '/main', isMain: true, plans: [], tasks: [], specs: ['docs/specs/ignored.md'] }],
    features: [],
  }
  const ix = buildIndex(proj)
  const hit = resolveRef(ix, 'spec', 'docs/specs/2025-01-05-thing-design.md')
  assert.equal(hit.broken, undefined)
  assert.equal(hit.target.title, 'The Thing', 'the folded spec title did not reach the index')
  // The per-worktree list is still honoured when no folded list is present,
  // so an older payload keeps resolving.
  const legacy = buildIndex({ worktrees: proj.worktrees, features: [] })
  assert.equal(resolveRef(legacy, 'spec', 'ignored.md').broken, undefined)
  ok('buildIndex prefers the project-level folded specs and still accepts the old shape')
}

console.log('\n✔ all ' + passed + ' refs checks passed')
