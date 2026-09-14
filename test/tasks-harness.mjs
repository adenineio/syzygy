#!/usr/bin/env node
// Harness for the projects scanner's pure modules.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { slugOf, normalizeTitle, itemId, stripBold, parseItems, parseHeader, parseFeatures }
  from '../syzygy/bridge/tasks-parse.mjs'

let passed = 0
const ok = (label) => { console.log('✔ ' + label); passed++ }

// --- slugs -----------------------------------------------------------------
assert.equal(slugOf('Browser pane — finish the patch bay'), 'browser-pane--finish-the-patch-bay')
assert.equal(slugOf('GRID — second pass'), 'grid--second-pass')
ok('slugOf drops punctuation and keeps the double hyphen an em dash leaves behind')

// --- identity --------------------------------------------------------------
assert.equal(normalizeTitle('**Step 1:  send it**'), 'step 1: send it')
assert.equal(itemId('docs/TASKS.md', '', 'Step 1'), itemId('docs/TASKS.md', '', '**Step 1**'))
assert.notEqual(itemId('docs/TASKS.md', '', 'Step 1'), itemId('docs/plans/a.md', '', 'Step 1'))
assert.notEqual(itemId('docs/plans/a.md', 'Task 1', 'Step 1'),
                itemId('docs/plans/a.md', 'Task 2', 'Step 1'))
ok('itemId is stable across bold and whitespace, and distinct across files and heading scopes')

// A plan template repeats step titles once per task, so a file-wide
// id must not be title-only. Two colliding items share a register key and make
// observe() fire check and uncheck against the same entry every pass.
const repeated = [
  '## Task 1',
  '- [x] **Step 1: Write the failing test**',
  '## Task 2',
  '- [ ] **Step 1: Write the failing test**',
].join('\n')
const rItems = parseItems('docs/plans/p.md', repeated).filter((i) => i.kind === 'step')
assert.equal(rItems.length, 2)
assert.notEqual(rItems[0].id, rItems[1].id,
  'two identically-titled steps under different headings share an id')
ok('a repeated step title under a different heading gets a distinct id')

// And the residual case: the same title twice under the SAME heading.
const twice = ['## Task 1', '- [ ] **Commit**', '- [ ] **Commit**'].join('\n')
const tItems = parseItems('docs/plans/q.md', twice).filter((i) => i.kind === 'step')
assert.notEqual(tItems[0].id, tItems[1].id, 'the ordinal tiebreak did not apply')
ok('a title repeated under one heading is de-collided by its ordinal')

// The ordinal map key must normalize its scope exactly as the hash does, or two
// headings differing only in what normalizeTitle erases take the same hashed
// scope with the same ordinal -- the original collision through a narrower door.
const alike = [
  '## Task ONE', '- [ ] **Commit**',
  '## task  one', '- [ ] **Commit**',
].join('\n')
const aItems = parseItems('docs/plans/a.md', alike).filter((i) => i.kind === 'step')
assert.equal(aItems.length, 2)
assert.notEqual(aItems[0].id, aItems[1].id,
  'headings that normalize alike collided through the ordinal map key')
ok('the ordinal map key normalizes its scope the same way the hash does')

// Cross-worktree stability is the property everything else rests on: the same
// file content in two checkouts must still hash identically.
assert.deepEqual(
  parseItems('docs/plans/p.md', repeated).map((i) => i.id),
  parseItems('docs/plans/p.md', repeated).map((i) => i.id))
ok('ids depend only on file content, so they match across worktrees')

// --- fenced blocks ---------------------------------------------------------
const fenced = [
  '# Title',
  '',
  '- [ ] **Step 1: real**',
  '',
  '```bash',
  '- [ ] not a step, it is an example',
  '## Not a heading either',
  '```',
  '',
  '- [x] **Step 2: also real**',
].join('\n')
const items = parseItems('docs/plans/x.md', fenced)
assert.equal(items.length, 2, 'expected exactly the two real steps, got ' + items.length)
assert.deepEqual(items.map((i) => i.text), ['Step 1: real', 'Step 2: also real'])
assert.deepEqual(items.map((i) => i.checked), [false, true])
ok('parseItems ignores steps and headings inside fenced code blocks')

// --- sections --------------------------------------------------------------
const prose = '## Browser pane — finish the patch bay\n\nsome prose\n\n### FEED findings\n'
const secs = parseItems('docs/TASKS.md', prose)
assert.deepEqual(secs.map((s) => s.kind), ['section', 'section'])
assert.equal(secs[0].checked, null)
assert.equal(secs[0].slug, 'browser-pane--finish-the-patch-bay')
assert.equal(secs[1].depth, 1)
ok('parseItems reads TASKS.md headings as stateless sections with slugs')

// --- the plan header block -------------------------------------------------
const header = [
  '# Pane Spinner Implementation Plan',
  '',
  '**Goal:** A spinner.',
  '**Spec:** `docs/specs/2025-01-03-beta-design.md` — read it first; this plan argues from it.',
  '**Tasks:** docs/TASKS.md#browser-pane--finish-the-patch-bay, docs/TASKS.md#grid--second-pass',
  '',
  '```',
  '**Spec:** this one is inside a fence and must be ignored',
  '```',
].join('\n')
const h = parseHeader(header)
assert.equal(h.title, 'Pane Spinner Implementation Plan')
assert.equal(h.spec, 'docs/specs/2025-01-03-beta-design.md')
assert.deepEqual(h.tasks, [
  'docs/TASKS.md#browser-pane--finish-the-patch-bay',
  'docs/TASKS.md#grid--second-pass',
])
ok('parseHeader reads title, Spec and Tasks, strips backticks, and stops at the first fence')

// Real plans write `**Spec:** `path` — commentary`. Only the path is the value;
// a parser that keeps the prose produces a spec pointer that resolves nowhere.
// This was caught by prototyping the parser against real plans.
assert.ok(!h.spec.includes('read it first'), 'a Spec: line kept its trailing prose: ' + h.spec)
ok('a Spec line with trailing commentary yields only the path')

// A plan may write a qualified label.
const qualified = parseHeader('# P\n\n**Spec (the binding authority):** `docs/specs/x.md`\n')
assert.equal(qualified.spec, 'docs/specs/x.md')
ok('a qualified Spec label is still read')

const none = parseHeader('# Plain\n\nno fields here\n')
assert.equal(none.spec, null)
assert.deepEqual(none.tasks, [])
ok('parseHeader returns null spec and an empty tasks list when a plan declares neither')

// --- git topology ----------------------------------------------------------
import { probe, worktreesOf, topologyOf, resetCache }
  from '../syzygy/bridge/tasks-git.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

const p = await probe(REPO)
assert.ok(p, 'probe returned null for the repo itself')
assert.ok(p.commonDir.startsWith('/'), 'commonDir must be absolute, got ' + p.commonDir)
assert.ok(!dirname(p.commonDir).endsWith('/.git'), 'dirname(commonDir) must be the directory holding .git')
assert.equal(p.mainRoot, undefined, 'probe must no longer carry mainRoot -- it existed only to be the key')
ok('probe resolves an absolute common dir and drops the old mainRoot field')

assert.equal(await probe('/'), null)
ok('probe returns null outside a git repo')

// A cwd that is a file, not a directory, raises ENOTDIR synchronously rather
// than on the callback. It must degrade to "not a git repo", not abort the scan.
assert.equal(await probe(join(REPO, 'package.json')), null)
ok('a cwd that is a file degrades to null instead of throwing')

const wts = await worktreesOf(p.worktreeRoot)
assert.ok(Array.isArray(wts) && wts.length >= 1)
// `isMain` is assigned to the first entry at parse time, so asserting that the
// first entry is flagged -- or that exactly one is -- restates the code and
// cannot fail. The claim worth testing is that porcelain's first non-bare
// entry really IS the main worktree. It is true here and false in the bare
// layout below, which is exactly why it earns its place.
assert.equal(wts[0].path, dirname(p.commonDir), 'the first worktree listed is not the main root')
assert.equal(wts[0].isMain, true, 'the first worktree listed must be flagged main')
assert.equal(wts.filter((w) => w.isMain).length, 1, 'exactly one worktree is main')
assert.ok(wts.every((w) => w.path.startsWith('/')))
ok('worktreesOf lists worktrees with the real main one first and flagged')

// Two DIFFERENT cwds in the same repo must fold into ONE project. Passing the
// same path twice proves nothing -- topologyOf de-duplicates its input with a
// Set before the loop, so the collapse never runs. A subdirectory is a genuinely
// distinct cwd that resolves to the same common dir, and this assertion fails
// if the project key ever regresses from the common dir to cwd.
const projects = await topologyOf([REPO, join(REPO, 'test')], Date.now())
assert.equal(projects.length, 1, 'two cwds in one repo must collapse to one project')
assert.equal(projects[0].key, p.commonDir, 'a project must be keyed by its common dir')
assert.equal(projects[0].mainRoot, dirname(p.commonDir), 'the display root must still be the main worktree')
assert.equal(projects[0].isGit, true)
ok('topologyOf keys a project by its common dir, collapsing distinct cwds in the same repo')

const plain = await topologyOf(['/tmp'], Date.now())
assert.equal(plain[0].isGit, false)
assert.equal(plain[0].key, '/tmp')
assert.equal(plain[0].worktrees.length, 1)
assert.equal(plain[0].worktrees[0].isMain, true)
ok('a non-git cwd becomes a single-worktree project keyed by itself')

// A BARE layout -- `git clone --bare` plus `git worktree add`, a mainstream
// workflow. The common dir IS the bare repo, so dirname(commonDir) is a
// container directory with no working tree in it: listing worktrees there
// fails and the whole project collapses to one synthetic worktree holding no
// task files. Porcelain also lists the bare entry FIRST, so an unfiltered
// parser flags it main and every real worktree diffs against an empty baseline.
// `execFileSync`, `mkdtempSync`, `tmpdir`, `writeFileSync` and `rmSync` are
// imported further down; ESM import bindings are hoisted, so they are live here.
import { existsSync, realpathSync } from 'node:fs'

const rp = (x) => realpathSync(x)
const bareBox = mkdtempSync(join(tmpdir(), 'szg-bare-'))
const gitIn = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'ignore' })
const bareRepo = join(bareBox, 'repo.git')
const bareOne = join(bareBox, 'one')
const bareTwo = join(bareBox, 'two')
execFileSync('git', ['init', '-q', '--bare', bareRepo], { stdio: 'ignore' })
gitIn(['worktree', 'add', '-q', '-b', 'one', bareOne], bareRepo)
writeFileSync(join(bareOne, 'TASKS.md'), '# TASKS\n\n## Something\n')
gitIn(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], bareOne)
gitIn(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'bare fixture'], bareOne)
// The bare repo's HEAD points at a branch that does not exist yet, so the
// second worktree needs an explicit start point rather than defaulting to HEAD.
gitIn(['worktree', 'add', '-q', '-b', 'two', bareTwo, 'one'], bareRepo)

const bareProbe = await probe(bareOne)
assert.ok(bareProbe, 'probe failed inside a bare-repo worktree')
assert.equal(rp(bareProbe.commonDir), rp(bareRepo),
  'the common dir of a bare layout is the bare repo itself')
assert.ok(!existsSync(join(dirname(bareProbe.commonDir), '.git')),
  'this layout is only interesting because dirname(commonDir) is NOT a working tree')

resetCache()
const bareProjects = await topologyOf([bareOne, bareTwo], Date.now())
assert.equal(bareProjects.length, 1, 'two worktrees of one bare repo must collapse to one project')
const bareWts = bareProjects[0].worktrees
assert.equal(bareWts.length, 2, 'expected both worktrees, got ' + JSON.stringify(bareWts.map((w) => w.path)))
assert.ok(!bareWts.some((w) => rp(w.path) === rp(bareRepo)),
  'the bare repo was listed as a worktree')
assert.equal(bareWts.filter((w) => w.isMain).length, 1, 'exactly one worktree is main')
const bareMain = bareWts.find((w) => w.isMain)
assert.ok(existsSync(join(bareMain.path, 'TASKS.md')),
  'the worktree flagged main has no working tree: ' + bareMain.path)
assert.equal(bareProjects[0].mainRoot, bareMain.path,
  'the project display root must be a real worktree, not the bare container')
ok('a bare-repo worktree layout yields one project, both worktrees, and a main with a working tree')

// TWO bare repos side by side. `dirname(commonDir)` is the SHARED parent for
// both, so the old key collided and `if (byKey.has(...)) continue` dropped the
// second silently -- no project, and no `skipped` entry saying so. Cosmetic
// while the key only counted rows; once it drives DOM identity a collision
// means two projects fighting over one node.
const otherRepo = join(bareBox, 'other.git')
const otherOne = join(bareBox, 'other-one')
execFileSync('git', ['init', '-q', '--bare', otherRepo], { stdio: 'ignore' })
gitIn(['worktree', 'add', '-q', '-b', 'solo', otherOne], otherRepo)
writeFileSync(join(otherOne, 'TASKS.md'), '# TASKS\n\n## Other\n')

const probeA = await probe(bareOne)
const probeB = await probe(otherOne)
assert.equal(dirname(probeA.commonDir), dirname(probeB.commonDir),
  'the fixture is pointless unless both bare repos share a parent directory')
assert.notEqual(probeA.commonDir, probeB.commonDir)

resetCache()
const twoBare = await topologyOf([bareOne, otherOne], Date.now())
assert.equal(twoBare.length, 2,
  'two side-by-side bare repos collapsed into one project: ' +
  JSON.stringify(twoBare.map((x) => x.key)))
assert.equal(new Set(twoBare.map((x) => x.key)).size, 2, 'the two projects share a key')
assert.ok(twoBare.every((x) => x.worktrees.length >= 1), 'a project came back with no worktree')
ok('two bare repos in one directory stay two projects with distinct keys')

rmSync(bareBox, { recursive: true, force: true })
resetCache()

// --- discovery, caps and containment ---------------------------------------
import { CAPS, containedIn, discover }
  from '../syzygy/bridge/tasks-discover.mjs'
import { symlinkSync, rmSync, mkdirSync } from 'node:fs'

const MAIN = join(HERE, 'fixtures', 'tasks', 'main')
const WT = join(HERE, 'fixtures', 'tasks', 'wt')

const d = discover(MAIN)
assert.deepEqual(d.tasks.map((f) => f.rel), ['docs/TASKS.md'])
assert.deepEqual(d.plans.map((f) => f.rel), ['docs/plans/alpha.md'])
assert.deepEqual(d.specs.map((f) => f.rel), ['docs/specs/alpha-design.md'])
assert.ok(d.plans[0].bytes > 0 && d.plans[0].mtimeMs > 0)
ok('discover finds the backlog, plans and specs with sizes and mtimes')

assert.equal(d.taskFile, 'docs/TASKS.md', 'the fixture keeps its backlog under docs/')
assert.equal(d.taskAuthority, 'docs', 'and is reported as such')

const dw = discover(WT)
assert.deepEqual(dw.plans.map((f) => f.rel).sort(), ['docs/plans/alpha.md', 'docs/plans/beta.md'])
ok('discover finds a plan that exists only in the worktree')

// --- the four names and which one wins ----------------------------
// The convention: docs/TASKS.md by default, TODO.md equally acceptable, and a
// file at the project ROOT is the
// authority when a project has both. Every match is still read -- a
// docs/TASKS.md that has stopped being the one that counts is worth seeing --
// so this asserts the ORDER and the reported authority, never that anything
// was dropped.
{
  const box = join(HERE, 'fixtures', 'tasks-names')
  const mk = (name, files) => {
    const root = join(box, name)
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(root, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, text)
    }
    return root
  }
  rmSync(box, { recursive: true, force: true })

  const BODY = '## A section\n\n- [ ] a step\n'
  const cases = [
    ['root-tasks', { 'TASKS.md': BODY }, 'TASKS.md', 'root'],
    ['root-todo', { 'TODO.md': BODY }, 'TODO.md', 'root'],
    ['docs-tasks', { 'docs/TASKS.md': BODY }, 'docs/TASKS.md', 'docs'],
    ['docs-todo', { 'docs/TODO.md': BODY }, 'docs/TODO.md', 'docs'],
  ]
  for (const [name, files, rel, authority] of cases) {
    const out = discover(mk(name, files))
    assert.deepEqual(out.tasks.map((f) => f.rel), [rel], `${name}: ${rel} is discovered`)
    assert.equal(out.taskAuthority, authority, `${name}: authority is ${authority}`)
    assert.equal(out.taskFile, rel, `${name}: taskFile names it`)
  }
  ok('all four task-file names are discovered, each reporting where it lives')

  // Both present: root wins, and docs/ is still read rather than hidden.
  const both = discover(mk('both', { 'TASKS.md': BODY, 'docs/TASKS.md': BODY }))
  assert.equal(both.taskFile, 'TASKS.md', 'a root file outranks the docs/ one')
  assert.equal(both.taskAuthority, 'root')
  assert.deepEqual(both.tasks.map((f) => f.rel), ['TASKS.md', 'docs/TASKS.md'],
    'and the docs/ copy is still read, not dropped')
  ok('a root task file is the authority, without hiding the docs/ one')

  // TODO.md at the root beats docs/TASKS.md: precedence is by LOCATION first,
  // not by which of the two names is the "proper" one.
  const mixed = discover(mk('mixed', { 'TODO.md': BODY, 'docs/TASKS.md': BODY }))
  assert.equal(mixed.taskFile, 'TODO.md', 'root TODO.md outranks docs/TASKS.md')
  assert.equal(mixed.taskAuthority, 'root')
  ok('precedence is by location first, then by name')

  // No task file at all is ORDINARY -- most worktrees have none. It must read
  // as absence, never as a refusal, or nearly every project carries a warning.
  const none = discover(mk('none', { 'README.md': 'nothing here\n' }))
  assert.deepEqual(none.tasks, [], 'no task file found')
  assert.equal(none.taskFile, null, 'taskFile is null, not undefined or a guess')
  assert.equal(none.taskAuthority, null, 'and so is the authority')
  assert.deepEqual(none.skipped, [], 'and absence is not reported as a skip')
  ok('a worktree with no task file reports null, not a skip')

  rmSync(box, { recursive: true, force: true })
}

assert.equal(containedIn(MAIN, join(MAIN, 'docs/TASKS.md')), true)
assert.equal(containedIn(MAIN, '/etc/passwd'), false)
ok('containedIn admits a real child and refuses an outside path')

// A symlink escaping the worktree must not be discoverable.
const escape = join(MAIN, 'docs', 'plans', 'escape.md')
rmSync(escape, { force: true })
symlinkSync('/etc/hosts', escape)
try {
  const withLink = discover(MAIN)
  assert.ok(!withLink.plans.some((f) => f.rel.endsWith('escape.md')),
    'a symlink pointing outside the worktree was discovered')
  assert.ok(withLink.skipped.some((s) => s.reason === 'outside-worktree'),
    'the escaping symlink was not reported as skipped')
  ok('a symlink escaping the worktree is refused and reported, not read')
} finally {
  rmSync(escape, { force: true })
}

// A whole plans DIRECTORY symlinked out of the worktree. Refusing each file's
// contents is not enough: the enumeration still happens, and the real
// basenames land in `skipped`, which is published on the ungated endpoint and
// rendered by the pane. That turns an unauthenticated read into a *.md
// directory listing of wherever the link points.
const leakBox = mkdtempSync(join(tmpdir(), 'szg-leak-'))
const leakRoot = join(leakBox, 'worktree')
const leakSecrets = join(leakBox, 'Documents')
mkdirSync(join(leakRoot, 'docs'), { recursive: true })
mkdirSync(leakSecrets, { recursive: true })
writeFileSync(join(leakSecrets, 'salary-review-2026.md'), 'confidential\n')
writeFileSync(join(leakSecrets, 'divorce-notes.md'), 'confidential\n')
symlinkSync(leakSecrets, join(leakRoot, 'docs', 'plans'))
const leaked = discover(leakRoot)
const leakedJson = JSON.stringify(leaked)
assert.ok(!leakedJson.includes('salary-review-2026') && !leakedJson.includes('divorce-notes'),
  'a filename from outside the worktree reached the payload: ' + leakedJson)
assert.equal(leaked.plans.length, 0)
assert.ok(leaked.skipped.some((s) => s.rel === 'docs/plans' && s.reason === 'outside-worktree'),
  'the escaping plans directory was not reported: ' + leakedJson)
ok('a plans directory symlinked out of the worktree is refused without enumerating it')

// The same guard must not turn plain absence into a refusal: nearly every
// project lacks docs/superpowers/plans, and a warning there would drown the
// real ones.
assert.ok(!leaked.skipped.some((s) => s.rel === 'docs/superpowers/plans'),
  'a directory that simply does not exist was reported as skipped')
ok('a plans directory that is merely absent is still not reported as skipped')
rmSync(leakBox, { recursive: true, force: true })

assert.equal(CAPS.fileBytes, 262144)
assert.equal(CAPS.plansPerWorktree, 40)
ok('caps are the values the scanner fixes')

// A directory that happens to be named like a plan is a refusal, not absence.
const notAFile = join(MAIN, 'docs', 'plans', 'notafile.md')
rmSync(notAFile, { recursive: true, force: true })
mkdirSync(notAFile, { recursive: true })
try {
  const d2 = discover(MAIN)
  assert.ok(!d2.plans.some((f) => f.rel.endsWith('notafile.md')))
  assert.ok(d2.skipped.some((s) => s.reason === 'not-a-file'),
    'a directory named like a plan was dropped without a reason')
  ok('a non-file candidate is refused and reported, not silently dropped')
} finally {
  rmSync(notAFile, { recursive: true, force: true })
}

// --- cross-worktree diffing ------------------------------------------------
import { labelItems, rollUp } from '../syzygy/bridge/tasks-diff.mjs'

const mainItems = [
  { id: 'a', text: 'shared unchecked', checked: false, kind: 'step' },
  { id: 'b', text: 'shared checked', checked: true, kind: 'step' },
  { id: 'c', text: 'gone in the worktree', checked: false, kind: 'step' },
]
const hereItems = [
  { id: 'a', text: 'shared unchecked', checked: true, kind: 'step' },
  { id: 'b', text: 'shared checked', checked: false, kind: 'step' },
  { id: 'd', text: 'new in the worktree', checked: false, kind: 'step' },
]
const labelled = labelItems(mainItems, hereItems)
const diffOf = (id) => labelled.find((i) => i.id === id)?.diff

assert.equal(diffOf('a'), 'done-here')
assert.equal(diffOf('b'), 'behind')
assert.equal(diffOf('d'), 'only-here')
assert.equal(diffOf('c'), 'removed')
ok('labelItems assigns done-here, behind, only-here and removed')

const removed = labelled.find((i) => i.id === 'c')
assert.equal(removed.absent, true)
assert.equal(removed.text, 'gone in the worktree', 'a removed item takes its text from main')
assert.equal(labelled[labelled.length - 1].id, 'c', 'removed items sort last')
ok('a removed item carries main text, is flagged absent, and sorts last')

const same = labelItems(mainItems, mainItems)
assert.ok(same.every((i) => i.diff === 'same'))
ok('identical worktrees produce no labels')

const solo = labelItems(null, hereItems)
assert.ok(solo.every((i) => i.diff === 'same'))
assert.equal(solo.length, hereItems.length)
ok('with no baseline every item is unlabelled -- diffing says nothing about one worktree')

// The main worktree's items must not be counted. Passing LABELLED items as the
// main entry is what makes this bite: raw items have no `diff` field, so they
// count zero whether or not the guard exists and the assertion cannot fail.
// With `labelled` on both sides, dropping `if (w.isMain) continue` doubles
// every count.
const roll = rollUp([{ isMain: true, items: labelled }, { isMain: false, items: labelled }])
assert.equal(roll.onlyHere, 1)
assert.equal(roll.removed, 1)
assert.equal(roll.doneHere, 1)
assert.equal(roll.behind, 1)
ok('rollUp counts each label once, skipping the main worktree')

// --- the register ----------------------------------------------------------
import { emptyRegister, observe, historyFor, prune, keyOf }
  from '../syzygy/bridge/tasks-register.mjs'

const WT_PATH = '/tmp/fake-worktree'
const t0 = 1_000_000
const one = [{ id: 'x', text: 'a step', checked: false, kind: 'step' }]
const done = [{ id: 'x', text: 'a step', checked: true, kind: 'step' }]

// Sole session in the worktree gets the credit.
let reg = emptyRegister()
const soloSession = [{ id: 's1', name: 'alpha', working: true, fingerprint: 'f1' }]
observe(reg, WT_PATH, one, soloSession, new Map(), t0)
observe(reg, WT_PATH, done, soloSession, new Map(), t0 + 5000)
let hist = historyFor(reg, WT_PATH, 'x')
assert.equal(hist.checkedAt, t0 + 5000)
assert.deepEqual(hist.checkedBy, { id: 's1', name: 'alpha' })
assert.equal(hist.firstSeen, t0)
ok('the sole session in a worktree is credited with a check')

// Two sessions: the one that was working AND whose stats moved is credited.
reg = emptyRegister()
const twoA = [{ id: 's1', name: 'alpha', working: true, fingerprint: 'a1' },
              { id: 's2', name: 'beta', working: true, fingerprint: 'b2' }]
observe(reg, WT_PATH, one, twoA, new Map(), t0)
observe(reg, WT_PATH, done, twoA, new Map([
  ['s1', { working: true, fingerprint: 'a1' }],   // working flag set, stats frozen
  ['s2', { working: true, fingerprint: 'b1' }],   // working and stats moved
]), t0 + 5000)
assert.deepEqual(historyFor(reg, WT_PATH, 'x').checkedBy, { id: 's2', name: 'beta' })
ok('the session whose stats actually moved is credited, not merely a working one')

// THE REGRESSION THIS GUARDS: a session parked at a permission prompt reports
// working === true forever. It must never collect another session's credit.
reg = emptyRegister()
observe(reg, WT_PATH, one, twoA, new Map(), t0)
observe(reg, WT_PATH, done, twoA, new Map([
  ['s1', { working: true, fingerprint: 'a1' }],   // blocked at a prompt: frozen
  ['s2', { working: false, fingerprint: 'b1' }],  // not flagged working
]), t0 + 5000)
assert.equal(historyFor(reg, WT_PATH, 'x').checkedBy, null,
  'a session stuck at a permission prompt was credited with work it did not do')
ok('a blocked session with a frozen fingerprint is never credited')

// Two sessions, both genuinely active: refuse to guess.
reg = emptyRegister()
observe(reg, WT_PATH, one, twoA, new Map(), t0)
observe(reg, WT_PATH, done, twoA, new Map([
  ['s1', { working: true, fingerprint: 'a0' }],
  ['s2', { working: true, fingerprint: 'b0' }],
]), t0 + 5000)
assert.equal(historyFor(reg, WT_PATH, 'x').checkedBy, null)
ok('with two genuinely active sessions, attribution is null rather than a guess')

// Zero sessions: still records the check, still refuses to attribute it.
reg = emptyRegister()
observe(reg, WT_PATH, one, [], new Map(), t0)
observe(reg, WT_PATH, done, [], new Map(), t0 + 5000)
hist = historyFor(reg, WT_PATH, 'x')
assert.equal(hist.checkedAt, t0 + 5000)
assert.equal(hist.checkedBy, null)
ok('a check with nobody in the worktree is recorded but unattributed')

// Disappearance and text retention.
reg = emptyRegister()
observe(reg, WT_PATH, one, [], new Map(), t0)
observe(reg, WT_PATH, [], [], new Map(), t0 + 5000)
hist = historyFor(reg, WT_PATH, 'x')
assert.equal(hist.removedAt, t0 + 5000)
assert.equal(hist.text, 'a step', 'text is retained so a vanished item still reads')
ok('an item gone from the worktree is stamped removed and keeps its text')

// Keys are per worktree, because the same id has two states in two checkouts.
assert.notEqual(keyOf('/a', 'x'), keyOf('/b', 'x'))
ok('register keys are scoped per worktree')

// Pruning.
reg = emptyRegister()
observe(reg, WT_PATH, one, [], new Map(), t0)
prune(reg, t0 + 31 * 24 * 60 * 60 * 1000)
assert.equal(historyFor(reg, WT_PATH, 'x'), null)
ok('prune drops entries unseen for 30 days')

// A register deleted mid-project must not invent attribution. An item first
// seen ALREADY checked was checked before we ever looked: there is no flip to
// credit and no honest timestamp to give it.
reg = emptyRegister()
observe(reg, WT_PATH, done, soloSession, new Map(), t0)
hist = historyFor(reg, WT_PATH, 'x')
assert.equal(hist.checkedAt, null, 'a first-sight checked item claimed a check time it cannot know')
assert.equal(hist.checkedBy, null, 'a first-sight checked item credited a session that did not do it')
observe(reg, WT_PATH, done, soloSession, new Map(), t0 + 5000)
assert.equal(historyFor(reg, WT_PATH, 'x').checkedBy, null,
  'a still-checked item began crediting a session one pass later')
ok('an item first seen already checked is never credited to whoever was present')

// Undoing a check clears the attribution rather than leaving it stale.
reg = emptyRegister()
observe(reg, WT_PATH, one, soloSession, new Map(), t0)
observe(reg, WT_PATH, done, soloSession, new Map(), t0 + 1000)
assert.deepEqual(historyFor(reg, WT_PATH, 'x').checkedBy, { id: 's1', name: 'alpha' })
observe(reg, WT_PATH, one, soloSession, new Map(), t0 + 2000)
hist = historyFor(reg, WT_PATH, 'x')
assert.equal(hist.checkedAt, null)
assert.equal(hist.checkedBy, null)
assert.equal(hist.uncheckedAt, t0 + 2000)
ok('undoing a check clears its attribution instead of leaving it stale')

// --- orchestration ---------------------------------------------------------
import { createScanner, resolveDeclaredRefs } from '../syzygy/bridge/tasks.mjs'
import { buildIndex } from '../syzygy/bridge/refs.mjs'
import { tmpdir } from 'node:os'
import { cpSync, mkdtempSync } from 'node:fs'

// The committed fixtures live INSIDE this git worktree, so probing them
// returns the repo's main checkout as mainRoot -- not the fixture path. Copy
// them somewhere genuinely outside a repo so the single-worktree, non-git path
// is what actually gets exercised. `os.tmpdir()` was verified to be outside
// any repo.
const sandbox = mkdtempSync(join(tmpdir(), 'szg-tasks-'))
const MAIN_T = join(sandbox, 'main')
const WT_T = join(sandbox, 'wt')
cpSync(MAIN, MAIN_T, { recursive: true })
cpSync(WT, WT_T, { recursive: true })

const regFile = join(sandbox, 'register.json')
const scanner = createScanner({ registerFile: regFile })

const sessions = [
  { id: 's1', name: 'alpha', cwd: MAIN_T, working: true },
  { id: 's2', name: 'beta', cwd: WT_T, working: false },
]
const out = await scanner.scan(sessions, Date.now())

// The copies are not git repos, so each is its own single-worktree project.
const mainProj = out.find((p) => p.key === MAIN_T)
assert.ok(mainProj, 'the main fixture did not become a project')
assert.equal(mainProj.worktrees.length, 1)

const wt = mainProj.worktrees[0]
assert.deepEqual(wt.sessions.map((s) => s.id), ['s1'])
assert.deepEqual(wt.claims, {}, 'a worktree with no claims.json still carries a claims field on the payload')
ok('the payload attaches claims per worktree, not only used for ownerFor')
assert.equal(wt.plans.length, 1)

const plan = wt.plans[0]
assert.equal(plan.title, 'Alpha Plan')
assert.equal(plan.spec, 'docs/specs/alpha-design.md')
assert.deepEqual(plan.tasks, ['docs/TASKS.md#finish-the-patch-bay'])
assert.equal(plan.total, 3)
assert.equal(plan.done, 1)
ok('a scanned plan carries its header block and its step tally')

const current = plan.items.find((i) => i.id === plan.currentItemId)
assert.equal(current.text, 'Step 2: second', 'the current item must be the first unchecked step')
ok('the current item is the first unchecked step in file order')

assert.deepEqual(plan.owner, { id: 's1', name: 'alpha', source: 'sole-session' })
ok('the sole session in the worktree owns its plan')

assert.equal(wt.tasks.length, 1)
assert.ok(wt.tasks[0].items.some((i) => i.slug === 'finish-the-patch-bay'))
ok('the backlog file is parsed into slugged sections')

// Every item everywhere carries a diff, including on a single-worktree project
// with nothing to compare against. Plan and backlog items are cloned before
// labelling, so they do not get it for free -- and the view renders THOSE, not
// the flat worktree.items array. An item that misses the back-fill is an item
// whose badge silently never appears.
assert.ok(plan.items.length > 0 && plan.items.every((i) => i.diff === 'same'),
  'plan items are missing their diff: ' + JSON.stringify(plan.items.map((i) => i.diff)))
assert.ok(wt.tasks[0].items.length > 0 && wt.tasks[0].items.every((i) => i.diff === 'same'),
  'backlog items are missing their diff: ' + JSON.stringify(wt.tasks[0].items.map((i) => i.diff)))
ok('every plan and backlog item carries a diff, not only the flat items array')

// A second pass with nothing changed must produce an identical payload.
const again = await scanner.scan(sessions, Date.now() + 1000)
// Comparing only the project keys proves nothing -- keys are stable almost
// regardless. The property that matters is that an unchanged scan serializes
// IDENTICALLY, because relay.mjs broadcasts only when the payload differs. If
// any per-pass field (a register lastSeen, a session stats fingerprint) leaks
// into the payload, this fails and the relay would otherwise have broadcast to
// every pane every 4 seconds forever.
assert.equal(JSON.stringify(again), JSON.stringify(out),
  'an unchanged scan must serialize identically, or the relay broadcasts every tick')
ok('a repeat scan produces a byte-identical payload')

// The assertion above is right but its fixture cannot violate it: every title
// in it is unique, so a title-only itemId passes anyway. THIS is the fixture
// that bites -- one step title repeated in two DIFFERENT checked states. With
// colliding ids both rows share a register entry, so observe() fires the check
// branch for one and the uncheck branch for the other on every pass, stamping
// a fresh `uncheckedAt` that reaches the payload through publicHistory. The
// relay's `if (json === projectsJson) return` then never fires and it
// broadcasts the whole payload to every pane every 4 seconds forever.
const dupRoot = join(sandbox, 'dup')
mkdirSync(join(dupRoot, 'docs/plans'), { recursive: true })
writeFileSync(join(dupRoot, 'docs/plans/dup.md'), '# Dup Plan\n\n' + repeated + '\n')
const dupScanner = createScanner({ registerFile: join(sandbox, 'dupreg.json') })
const dupSessions = [{ id: 'd1', name: 'alpha', cwd: dupRoot, working: true, stats: {} }]
const dup1 = await dupScanner.scan(dupSessions, 1_700_000_000_000)
const dup2 = await dupScanner.scan(dupSessions, 1_700_000_004_000)
assert.equal(JSON.stringify(dup2), JSON.stringify(dup1),
  'a repeated step title made two consecutive scans differ -- the relay would rebroadcast every 4s')
const dupSteps = dup1[0].worktrees[0].plans[0].items.filter((i) => i.kind === 'step')
assert.equal(new Set(dupSteps.map((i) => i.id)).size, 2, 'the two repeated steps still share an id')
ok('a plan repeating one step title in two checked states still scans to a stable payload')

// A real two-worktree git repo. The copied fixtures are deliberately non-git,
// so this is the one topology they cannot reach -- and it is where `removed`
// routing lives. Nothing else in this suite exercises cross-worktree labelling
// through tasks.mjs end to end.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const g = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'ignore' })

const repo = join(sandbox, 'repo')
cpSync(MAIN, repo, { recursive: true })
g(['init', '-q', '-b', 'main'], repo)
g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], repo)
g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], repo)
const linked = join(sandbox, 'linked')
g(['worktree', 'add', '-q', '-b', 'side', linked], repo)

// Diverge: the linked worktree drops a backlog section that main still has.
writeFileSync(join(linked, 'docs/TASKS.md'), '# TASKS\n\n## Finish the patch bay\n\nDeferred work.\n')

const gScanner = createScanner({ registerFile: join(sandbox, 'greg.json') })
const gout = await gScanner.scan([
  { id: 'g1', name: 'main-sess', cwd: repo, working: false, stats: {} },
  { id: 'g2', name: 'side-sess', cwd: linked, working: false, stats: {} },
], Date.now())

assert.equal(gout.length, 1, 'two worktrees of one repo must collapse to one project')
const side = gout[0].worktrees.find((w) => !w.isMain)
const sideBacklog = side.tasks[0].items
const gone = sideBacklog.filter((i) => i.diff === 'removed')
assert.equal(gone.length, 1, 'the section dropped in the linked worktree was not routed into its backlog file')
assert.equal(gone[0].text, 'Fix the idle timer')
assert.equal(gone[0].absent, true)
assert.equal(sideBacklog[sideBacklog.length - 1].diff, 'removed', 'removed items must sort last within their file')
ok('a removed item is routed into the file it came from, so the view can render it')

// A file main has and this worktree lacks ENTIRELY must still be reported.
// Without a ghost entry its removed items are stranded in the flat array and
// nothing renders them -- and the plan-level diff never sees the file either,
// because it only classifies files that exist here.
rmSync(join(linked, 'docs/plans/alpha.md'), { force: true })
const g2Scanner = createScanner({ registerFile: join(sandbox, 'greg2.json') })
const g2out = await g2Scanner.scan([
  { id: 'g1', name: 'main-sess', cwd: repo, working: false, stats: {} },
  { id: 'g2', name: 'side-sess', cwd: linked, working: false, stats: {} },
], Date.now())
const side2 = g2out[0].worktrees.find((w) => !w.isMain)
const ghost = side2.plans.find((p) => p.rel === 'docs/plans/alpha.md')
assert.ok(ghost, 'a plan main has and this worktree lacks was reported nowhere')
assert.equal(ghost.diff, 'removed')
assert.equal(ghost.absent, true)
assert.ok(ghost.items.length > 0 && ghost.items.every((i) => i.diff === 'removed'),
  'the ghost file carried no removed items')
assert.equal(ghost.done, 0)
assert.equal(ghost.total, 0)
assert.equal(ghost.currentItemId, null)
ok('a file missing from a worktree entirely is reported as a removed ghost')

// --- what the payload carries, and what it must not ------------------------

// The flat per-worktree `items` array is scan-time scaffolding for labelling
// and removed-item routing. Publishing it inflated the payload by a large
// fraction and no consumer read it.
for (const proj of g2out) {
  for (const w of proj.worktrees) {
    assert.equal(w.items, undefined,
      'the flat items array is still published: ' + w.path)
    assert.ok(w.plans.length || w.tasks.length, 'nothing left to render in ' + w.path)
  }
}
ok('the flat per-worktree items array is dropped before the payload is published')

// History must be attached uniformly. Attaching it to plan items only left a
// `- [ ]` in a TASKS.md with its attribution recorded and never displayed --
// and routeRemoved() attaches it to ghost backlog entries anyway, so the shape
// differed WITHIN one array.
const backlogItems = g2out[0].worktrees.flatMap((w) => w.tasks.flatMap((t) => t.items))
assert.ok(backlogItems.length > 0, 'no backlog items to check')
assert.ok(backlogItems.every((i) => 'history' in i),
  'a backlog item reached the payload with no history field')
assert.ok(backlogItems.some((i) => i.history && i.history.firstSeen > 0),
  'every backlog history was null -- the register is not being consulted at all')
ok('backlog items carry history in the same shape plan items do')

// A file that stats fine but will not read parses to zero items. Silently, it
// is indistinguishable from an empty file.
import { chmodSync } from 'node:fs'
if (process.getuid?.() === 0) {
  console.log('… skipped: the unreadable-file check cannot bite as root')
} else {
  const denyBox = mkdtempSync(join(tmpdir(), 'szg-deny-'))
  mkdirSync(join(denyBox, 'docs/plans'), { recursive: true })
  const denied = join(denyBox, 'docs/plans/locked.md')
  writeFileSync(denied, '# Locked\n\n- [ ] **Step 1: unreachable**\n')
  chmodSync(denied, 0o000)
  try {
    const denyScanner = createScanner({ registerFile: join(denyBox, 'reg.json') })
    const denyOut = await denyScanner.scan(
      [{ id: 'x1', name: 'x', cwd: denyBox, working: false, stats: {} }], Date.now())
    const denyWt = denyOut[0].worktrees[0]
    assert.ok(denyWt.skipped.some((s) => s.rel === 'docs/plans/locked.md' && s.reason === 'unreadable'),
      'a plan that stats fine but will not read was reported nowhere: ' + JSON.stringify(denyWt.skipped))
    ok('a file that discovers but will not read is reported as skipped, not parsed to silence')
  } finally {
    chmodSync(denied, 0o600)
    rmSync(denyBox, { recursive: true, force: true })
  }
}

// --- caps are reported, never silently applied (spec 4.1) ------------------

// 41 distinct non-git cwds: one project each, one over the 40-project cap.
const manyBox = mkdtempSync(join(tmpdir(), 'szg-many-'))
const manySessions = []
for (let i = 0; i < CAPS.projects + 1; i++) {
  const dir = join(manyBox, 'p' + i)
  mkdirSync(dir, { recursive: true })
  manySessions.push({ id: 'm' + i, name: 'm' + i, cwd: dir, working: false, stats: {} })
}
resetCache()
const manyScanner = createScanner({ registerFile: join(manyBox, 'reg.json') })
const manyOut = await manyScanner.scan(manySessions, Date.now())
assert.equal(manyOut.length, CAPS.projects, 'the projects cap was not applied')
assert.equal(manyOut[0].overCap.projects, 1,
  'a project over the cap vanished without being counted')
ok('projects over the cap are reported, not silently dropped')
rmSync(manyBox, { recursive: true, force: true })

// And the worktrees cap, on a real repo. `repo` already has main plus `side`.
for (let i = 0; i < CAPS.worktreesPerProject; i++) {
  g(['worktree', 'add', '-q', '-b', 'cap' + i, join(sandbox, 'cap' + i), 'main'], repo)
}
resetCache()
const capScanner = createScanner({ registerFile: join(sandbox, 'capreg.json') })
const capOut = await capScanner.scan(
  [{ id: 'c1', name: 'c1', cwd: repo, working: false, stats: {} }], Date.now())
assert.equal(capOut.length, 1)
assert.equal(capOut[0].worktrees.length, CAPS.worktreesPerProject, 'the worktrees cap was not applied')
assert.equal(capOut[0].overCap.worktrees, 2,
  'worktrees over the cap vanished without being counted, got ' + capOut[0].overCap.worktrees)
ok('worktrees over the cap are reported, not silently dropped')
resetCache()

// --- three states: todo, reported, verified ---------------------------------
// A tick has to mean VERIFIED, not believed. `[~]` is the executor's own claim
// and must never reach a consumer as done: `checked` stays a strict boolean
// with reported counting as FALSE, so a reader that has not learned about
// `reported` under-counts progress instead of over-counting it.
{
  const src = [
    '## Task 1',
    '- [ ] not started',
    '- [~] reported by the executor',
    '- [x] verified by a reviewer',
  ].join('\n')
  const steps = parseItems('docs/plans/p.md', src).filter((i) => i.kind === 'step')

  // Before three states existed the regex was [ xX], so `- [~]` matched nothing
  // at all: the step vanished from the parse and the plan silently got shorter.
  assert.equal(steps.length, 3, 'a reported step must still parse as a step')
  assert.deepEqual(steps.map((i) => i.checked), [false, false, true])
  assert.deepEqual(steps.map((i) => i.reported), [false, true, false])
  ok('`[~]` parses as a step that is reported but NOT checked, and stays in the total')

  const heads = parseItems('docs/plans/p.md', src).filter((i) => i.kind === 'section')
  assert.deepEqual(heads.map((i) => i.reported), [false])
  ok('headings carry `reported` too, so every item has one shape')
}

// --- the ladder, which is also the merge rule -------------------------------
// The same plan file exists in every worktree, so ticks diverge. Ranking todo <
// reported < verified is what lets a checkbox conflict resolve mechanically to
// the more advanced state instead of by discarding one side.
{
  const mk = (id, state) => ({ id, kind: 'step', text: id,
    checked: state === 'x', reported: state === '~' })
  const main = [mk('a', ' '), mk('b', '~'), mk('c', 'x'), mk('d', '~')]
  const here = [mk('a', '~'), mk('b', 'x'), mk('c', 'x'), mk('d', ' ')]
  const by = Object.fromEntries(labelItems(main, here).map((i) => [i.id, i.diff]))
  assert.equal(by.a, 'done-here', 'reported here beats todo in main')
  assert.equal(by.b, 'done-here', 'verified here beats reported in main')
  assert.equal(by.c, 'same')
  assert.equal(by.d, 'behind', 'todo here is behind reported in main')
  ok('todo < reported < verified ranks in both directions')
}

// --- one plan is one effort ------------------------------------------------
// A worktree inherits every committed plan, so a per-worktree count reports one
// effort once per worktree. Identity is the BASENAME because that is the only
// thing that survived plans moving out of docs/superpowers/plans/: item ids
// include the path, so main's ticked copy and a worktree's stale copy at the
// old path share no items and read as two unrelated plans.
import { foldEfforts } from '../syzygy/bridge/tasks-efforts.mjs'

{
  const plan = (rel, done, total, extra = {}) =>
    ({ rel, title: 'T', done, total, reported: 0, items: [], ...extra })
  const wt = (path, isMain, plans) => ({ path, isMain, plans })

  const out = foldEfforts([
    wt('/main', true, [plan('docs/plans/a.md', 29, 29)]),
    wt('/w1', false, [plan('docs/superpowers/plans/a.md', 0, 29)]),
    wt('/w2', false, [plan('docs/superpowers/plans/a.md', 0, 29)]),
  ])
  assert.equal(out.efforts.length, 1, 'three copies of one plan are one effort')
  const e = out.efforts[0]
  assert.equal(e.copies, 3)
  assert.equal(e.done, 29, 'the most advanced copy wins')
  assert.equal(e.live, false, 'a finished plan is not in flight because a stale copy is behind')
  assert.equal(e.behind, 2, 'both stale copies are reported as drift')
  ok('a plan under both layouts folds by basename')
}

{
  const plan = (rel, done, total, reported = 0) =>
    ({ rel, title: 'T', done, total, reported, items: [] })
  const out = foldEfforts([
    { path: '/main', isMain: true, plans: [plan('docs/plans/b.md', 0, 36)] },
    { path: '/w1', isMain: false, plans: [plan('docs/plans/b.md', 0, 36)] },
  ])
  assert.equal(out.efforts[0].live, true)
  assert.equal(out.efforts[0].behind, 0, 'two equally unticked copies are not drift')
  ok('an effort no copy has advanced is in flight exactly once')

  // A claim beats nothing, and never beats a verified step.
  const tie = foldEfforts([
    { path: '/main', isMain: true, plans: [plan('docs/plans/c.md', 0, 10, 0)] },
    { path: '/w1', isMain: false, plans: [plan('docs/plans/c.md', 0, 10, 4)] },
  ])
  assert.equal(tie.efforts[0].reported, 4, 'reported breaks a tie on verified')
  const beats = foldEfforts([
    { path: '/main', isMain: true, plans: [plan('docs/plans/d.md', 1, 10, 0)] },
    { path: '/w1', isMain: false, plans: [plan('docs/plans/d.md', 0, 10, 9)] },
  ])
  assert.equal(beats.efforts[0].done, 1, 'a verified step outranks nine reported ones')
  ok('todo < reported < verified decides which copy is the effort')
}

{
  // Never merge two different plans into one row. Report it, the way an
  // over-cap count is reported, and let the gate and the UI say so.
  const out = foldEfforts([{
    path: '/main', isMain: true, plans: [
      { rel: 'docs/plans/x.md', title: 'A', done: 0, total: 3, reported: 0, items: [] },
      { rel: 'docs/superpowers/plans/x.md', title: 'B', done: 0, total: 5, reported: 0, items: [] },
    ],
  }])
  assert.equal(out.collisions.length, 1, 'a basename clash inside one worktree is reported')
  assert.equal(out.collisions[0].name, 'x.md')
  ok('two plans sharing a basename in ONE worktree are reported, not silently merged')

  const ghost = foldEfforts([{
    path: '/main', isMain: true, plans: [
      { rel: 'docs/plans/y.md', absent: true, done: 9, total: 9, reported: 0, items: [] },
    ],
  }])
  assert.equal(ghost.efforts.length, 0, 'a ghost plan is not an effort')
  ok('ghost plans never become efforts')

  const empty = foldEfforts([{
    path: '/main', isMain: true, plans: [
      { rel: 'docs/plans/z.md', done: 0, total: 0, reported: 0, items: [] },
    ],
  }])
  assert.equal(empty.efforts[0].live, false, 'a plan with no steps is empty, not unfinished')
  ok('a plan with no steps is not counted as in flight')
}

// --- claims.json discovery -------------------------------------------------
// Same containment rule as every other discovered file: the relay's reads are
// ungated, so a symlink out of the worktree must be refused, not followed.
{
  const home = mkdtempSync(join(tmpdir(), 'szg-disc-claims-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'claims.json'), '{"version":1,"claims":{}}')
  assert.equal(discover(home).claims?.rel, '.claude/claims.json')
  ok('discover() finds .claude/claims.json')

  const bare = mkdtempSync(join(tmpdir(), 'szg-disc-bare-'))
  const bareOut = discover(bare)
  assert.equal(bareOut.claims, null, 'absence is not a refusal')
  assert.ok(!bareOut.skipped.some(s => s.rel === '.claude/claims.json'), 'nothing was pushed to skipped for absent claims file')
  ok('a worktree with no claims file reports null, not a skip')

  const evil = mkdtempSync(join(tmpdir(), 'szg-disc-evil-'))
  const outsideParent = mkdtempSync(join(tmpdir(), 'szg-outside-'))
  const outside = join(outsideParent, 'secret.json')
  writeFileSync(outside, '{"claims":{}}')
  mkdirSync(join(evil, '.claude'), { recursive: true })
  symlinkSync(outside, join(evil, '.claude', 'claims.json'))
  const out = discover(evil)
  assert.equal(out.claims, null, 'a symlink out of the worktree was followed')
  assert.ok(out.skipped.some((s) => s.rel === '.claude/claims.json' && s.reason === 'outside-worktree'))
  ok('a claims.json symlinked outside the worktree is refused and reported')

  rmSync(home, { recursive: true, force: true })
  rmSync(bare, { recursive: true, force: true })
  rmSync(evil, { recursive: true, force: true })
  rmSync(outsideParent, { recursive: true, force: true })
}

rmSync(sandbox, { recursive: true, force: true })

// --- scan() end to end with a NON-EMPTY claims.json -------------------------
// Every piece of the claims read path is unit-tested, and the join was not:
// tasks.mjs's `found.claims ? readClaims(w.path).claims : {}` -- the one line
// tying discovery to parsing to the payload -- had never once run against a
// worktree that actually had claims in it. Two sessions live here on purpose,
// so the sole-session fallback returns null and the owner can ONLY come from
// the claim; with the join broken this scan yields `claims: {}` and a null
// owner.
{
  const claimBox = mkdtempSync(join(tmpdir(), 'szg-scan-claims-'))
  const proj = join(claimBox, 'main')
  cpSync(MAIN, proj, { recursive: true })
  mkdirSync(join(proj, '.claude'), { recursive: true })
  writeFileSync(join(proj, '.claude', 'claims.json'), JSON.stringify({
    version: 1,
    claims: {
      s2: {
        name: 'beta',
        items: [
          { kind: 'plan', id: 'alpha.md' },
          { kind: 'backlog', id: 'docs/TASKS.md#finish-the-patch-bay' },
        ],
        claimedAt: 1, updatedAt: 2,
      },
    },
  }))

  const claimScanner = createScanner({ registerFile: join(claimBox, 'reg.json') })
  const claimOut = await claimScanner.scan([
    { id: 's1', name: 'alpha', cwd: proj, working: true },
    { id: 's2', name: 'beta', cwd: proj, working: false },
  ], Date.now())

  const cProj = claimOut.find((x) => x.key === proj)
  assert.ok(cProj, 'the claims fixture did not become a project')
  const cWt = cProj.worktrees[0]
  assert.deepEqual(Object.keys(cWt.claims), ['s2'],
    'a real .claude/claims.json must reach the payload through discover -> readClaims')
  ok('scan() reads a worktree\'s real claims.json onto the payload')

  const cPlan = cWt.plans.find((x) => x.rel.endsWith('alpha.md'))
  assert.deepEqual(cPlan.owner, { id: 's2', name: 'beta', source: 'claim' },
    'with two live sessions the ONLY route to an owner is the claim on disk')
  ok('a claim on disk names the plan owner through a full scan pass')

  const cEffort = cProj.efforts.find((e) => e.name === 'alpha.md')
  assert.deepEqual(cEffort.claimedBy, [{ id: 's2', name: 'beta' }],
    'the effort fold must see the same claims the worktree read')
  ok('a scanned claim resolves onto its effort')

  const cSection = cWt.tasks[0].items.find((i) => i.slug === 'finish-the-patch-bay')
  assert.deepEqual(cSection.claimedBy, [{ id: 's2', name: 'beta' }],
    'the backlog matcher must see the same claims too')
  ok('a scanned backlog claim resolves onto its TASKS.md section')

  rmSync(claimBox, { recursive: true, force: true })
}

// --- an explicit claim beats both inferred owners ---------------------------
{
  const { ownerFor } = await import('../syzygy/bridge/tasks.mjs')
  const plan = { rel: 'docs/plans/a.md' }
  const two = [{ id: 's1', name: 'one' }, { id: 's2', name: 'two' }]

  // The exact shape that returns null today.
  assert.equal(ownerFor(plan, two, null, {}), null)
  ok('with two sessions and no claim, owner is still null (unchanged)')

  const claims = { s2: { name: 'two', items: [{ kind: 'plan', id: 'a.md' }] } }
  assert.deepEqual(ownerFor(plan, two, null, claims), { id: 's2', name: 'two', source: 'claim' })
  ok('an explicit claim names an owner where inference gave up')

  const checked = { id: 's1', name: 'one' }
  assert.equal(ownerFor(plan, two, checked, claims).id, 's2', 'a claim outranks a recent tick')
  ok('an explicit claim outranks the 15-minute checkedBy guess')

  assert.deepEqual(ownerFor(plan, [two[0]], null, {}), { id: 's1', name: 'one', source: 'sole-session' })
  ok('the sole-session fallback still works when nothing is claimed')

  // claims.json is documented as hand-editable, and readClaims's JSON.parse
  // only catches a file that is not valid JSON at all. A malformed `items`
  // entry -- a null element, or `items` not even an array -- is valid JSON
  // and reaches ownerFor unsanitized. Both must degrade to "no claim here",
  // never throw: an uncaught exception here propagates out of scanner.scan()
  // with no per-plan try/catch, and the only catch above it just logs to
  // stderr and leaves the whole board's projects stale.
  assert.doesNotThrow(() => ownerFor(plan, two, null, { s2: { name: 'two', items: [null] } }),
    'a null element in items must not crash the whole scan pass')
  assert.equal(ownerFor(plan, two, null, { s2: { name: 'two', items: [null] } }), null,
    'a null element matches nothing and falls through to the next owner path')
  ok('a null element in a claim\'s items degrades to no match, not a throw')

  assert.doesNotThrow(() => ownerFor(plan, two, null, { s2: { name: 'two', items: 'not-an-array' } }),
    'a non-array items must not crash the whole scan pass')
  assert.equal(ownerFor(plan, two, null, { s2: { name: 'two', items: 'not-an-array' } }), null,
    'non-array items matches nothing and falls through to the next owner path')
  ok('a non-array items degrades to no match, not a throw')

  // Basename, not rel: plans move between plan directories, and a claim's
  // identity survives that move because it names the basename. A regression to rel-based
  // matching that happened to still pass a same-directory fixture would slip
  // past every other case above -- this one uses a DIFFERENT directory on
  // purpose so it can only pass under basename matching.
  const movedPlan = { rel: 'docs/superpowers/plans/a.md' }
  assert.deepEqual(ownerFor(movedPlan, two, null, claims), { id: 's2', name: 'two', source: 'claim' },
    'a claim recorded by basename must still match a plan living in the other plans directory')
  ok('a claim matches by basename across docs/plans/ and docs/superpowers/plans/, not by rel')

  // --- live vs stale claims, all four orderings ----------------------------
  // The store keeps a claim until it is released BY HAND, so a session
  // dead for a week still has an entry in the file. `here` is the worktree's
  // live sessions, so a claimant absent from it is stale. The regression this
  // guards: a stale claim used to outrank both inferred paths permanently, so
  // projects.js showed a week-dead name where it had shown the live ticker
  // before the feature existed.
  //
  // `s2` claims a.md throughout. What changes between the cases is only
  // whether s2 is among the live sessions.
  const soloS1 = [{ id: 's1', name: 'one' }]
  const noneLive = []

  assert.deepEqual(ownerFor(plan, two, checked, claims), { id: 's2', name: 'two', source: 'claim' },
    'a LIVE claim must still outrank checkedBy -- that is what claims are for')
  ok('a live claim beats checkedBy')

  assert.deepEqual(ownerFor(plan, soloS1, checked, claims), { id: 's1', name: 'one', source: 'checked' },
    'a stale claim must not beat a session that ticked an item minutes ago')
  ok('a stale claim loses to checkedBy')

  assert.deepEqual(ownerFor(plan, soloS1, null, claims), { id: 's1', name: 'one', source: 'sole-session' },
    'a stale claim must not beat the only session actually in the worktree')
  ok('a stale claim loses to the sole-session fallback')

  assert.deepEqual(ownerFor(plan, noneLive, null, claims), { id: 's2', name: 'two', source: 'claim-stale' },
    'with nothing live and nothing ticked, the stale claim is the only thing known -- report it, tagged')
  ok('a stale claim still surfaces when nothing else is available, tagged claim-stale')
}

// --- claims resolve onto efforts -------------------------------------------
{
  const plan = (rel, done, total) => ({ rel, title: 'T', done, total, reported: 0, items: [] })
  const out = foldEfforts([{
    path: '/main', isMain: true,
    plans: [plan('docs/plans/a.md', 0, 5), plan('docs/plans/b.md', 0, 5)],
    claims: {
      s1: { name: 'one', items: [{ kind: 'plan', id: 'a.md' }] },
      s2: { name: 'two', items: [{ kind: 'plan', id: 'nope.md' }] },
    },
  }])
  const a = out.efforts.find((e) => e.name === 'a.md')
  const b = out.efforts.find((e) => e.name === 'b.md')
  assert.deepEqual(a.claimedBy, [{ id: 's1', name: 'one' }])
  assert.deepEqual(b.claimedBy, [])
  ok('a plan claim attaches to its effort by basename')

  // Reported, never silently dropped -- a typo in a hand edit must be visible.
  assert.equal(out.unresolvedClaims.length, 1)
  assert.equal(out.unresolvedClaims[0].id, 'nope.md')
  assert.equal(out.unresolvedClaims[0].sessionId, 's2')
  ok('a claim naming work that does not exist is reported, not dropped')
}

// An effort carries its current step's TEXT, not just the id -- resolved here
// (mirroring public/projects.js's client-side `plan.items.find((i) => i.id
// === plan.currentItemId)`) so a consumer that never decodes `items` at all
// (pane-v2's MINE view) still gets the live step to show under the title.
{
  const step = (id, text) => ({ id, kind: 'step', text })
  const withCurrent = foldEfforts([{
    path: '/main', isMain: true,
    plans: [{
      rel: 'docs/plans/e.md', title: 'E', done: 1, total: 2, reported: 0,
      currentItemId: 's2', items: [step('s1', 'first step'), step('s2', 'second step')],
    }],
  }])
  assert.equal(withCurrent.efforts[0].currentItem, 'second step')
  ok('an effort carries its current step\'s text, resolved from currentItemId')

  const finished = foldEfforts([{
    path: '/main', isMain: true,
    plans: [{
      rel: 'docs/plans/f.md', title: 'F', done: 2, total: 2, reported: 0,
      currentItemId: null, items: [step('s1', 'first step'), step('s2', 'second step')],
    }],
  }])
  assert.equal(finished.efforts[0].currentItem, null, 'a finished plan has no current step')
  ok('an effort with no unchecked step carries a null currentItem, not a stale one')

  // currentItemId pointing at an id no longer in items (e.g. the step was
  // edited out from under it) must degrade to null, never throw.
  const stale = foldEfforts([{
    path: '/main', isMain: true,
    plans: [{
      rel: 'docs/plans/g.md', title: 'G', done: 0, total: 1, reported: 0,
      currentItemId: 'gone', items: [step('s1', 'the only step')],
    }],
  }])
  assert.equal(stale.efforts[0].currentItem, null, 'a currentItemId with no matching item is null, not a throw')
  ok('a currentItemId that matches no item degrades to null')
}

// a `kind` that is neither 'plan' nor 'backlog' is the same failure as a
// typo in `id` -- reported, not silently dropped. A genuine 'backlog' item
// must still pass through this loop unreported (tasks.mjs resolves those).
{
  const plan = (rel, done, total) => ({ rel, title: 'T', done, total, reported: 0, items: [] })
  const out = foldEfforts([{
    path: '/main', isMain: true,
    plans: [plan('docs/plans/a.md', 0, 5)],
    claims: {
      s1: { name: 'one', items: [{ kind: 'plann', id: 'a.md' }] }, // typo'd kind
      s2: { name: 'two', items: [{ kind: 'backlog', id: 'docs/TASKS.md#x' }] },
    },
  }])
  const a = out.efforts.find((e) => e.name === 'a.md')
  assert.deepEqual(a.claimedBy, [], 'a malformed-kind claim must not resolve as a plan claim')
  assert.equal(out.unresolvedClaims.length, 1,
    'exactly one report: the malformed kind, not the genuine backlog item too')
  assert.deepEqual(out.unresolvedClaims[0], { sessionId: 's1', name: 'one', kind: 'plann', id: 'a.md' })
  ok('an item whose kind is neither plan nor backlog is reported, not silently dropped')
}

// --- backlog claims resolve onto TASKS.md sections --------------------------
// Extracted into its own exported function (mirroring foldEfforts) so this is
// directly testable without going through the full scanner/fixture files.
{
  const { resolveBacklogClaims } = await import('../syzygy/bridge/tasks.mjs')
  const section = (slug, text) => ({ kind: 'section', id: 'sec-' + slug, text, slug })
  const built = [{
    path: '/main', isMain: true,
    tasks: [{ rel: 'docs/TASKS.md', items: [section('finish-the-patch-bay', 'Finish the patch bay')] }],
    claims: {
      s1: { name: 'one', items: [{ kind: 'backlog', id: 'docs/TASKS.md#finish-the-patch-bay' }] },
      s2: { name: 'two', items: [{ kind: 'backlog', id: 'docs/TASKS.md#nope' }] },
    },
  }]
  const unresolved = resolveBacklogClaims(built)
  const item = built[0].tasks[0].items[0]
  assert.deepEqual(item.claimedBy, [{ id: 's1', name: 'one' }])
  ok('a backlog claim attaches to its section item by docs/TASKS.md#slug')

  assert.equal(unresolved.length, 1)
  assert.equal(unresolved[0].id, 'docs/TASKS.md#nope')
  assert.equal(unresolved[0].sessionId, 's2')
  ok('a backlog claim naming a section that does not exist is reported, not dropped')
}

// --- FEATURES.md -----------------------------------------------------------
// docs/FEATURES.md is the ONLY source of "implemented", and its entries are
// uniformly `## <Name> — <YYYY-MM-DD>`. The date is part of the
// heading, so it must NOT end up in the slug: a claim or a mapping naming
// `alpha-feature` has to keep resolving after someone corrects a date.
{
  const src = [
    '# Features',
    '',
    '## Alpha feature — 2025-01-04',
    '',
    'A session records which plan it is doing.',
    '',
    '## Turn spinners — 2025-01-02',
    '',
    'A registry of them.',
  ].join('\n')
  const feats = parseFeatures('docs/FEATURES.md', src).features
  assert.equal(feats.length, 2, 'expected two features, got ' + feats.length)
  assert.equal(feats[0].name, 'Alpha feature')
  assert.equal(feats[0].date, '2025-01-04')
  assert.equal(feats[0].slug, 'alpha-feature',
    'the date must not leak into the slug')
  ok('parseFeatures reads name, date and a date-free slug from each `## ` heading')
}

// An entry whose heading does not carry a parseable date is KEPT, with a null
// date and the whole heading as its name. Losing a shipped feature because
// someone wrote the date differently is a worse failure than showing one
// without a date -- same direction as a ghost rolling up to done: 0, total: 0.
{
  const src = ['## Undated thing', '', 'body', '', '## Dated — 2025-01-02'].join('\n')
  const feats = parseFeatures('docs/FEATURES.md', src).features
  assert.equal(feats.length, 2, 'an undated entry was dropped')
  assert.equal(feats[0].name, 'Undated thing')
  assert.equal(feats[0].date, null)
  assert.equal(feats[0].slug, 'undated-thing')
  ok('parseFeatures keeps an entry whose heading has no parseable date')
}

// A level-3 heading is BODY, not a feature. The real file has one, and an
// entry's internals must never split its own feature into two.
{
  const src = ['## Real — 2025-01-04', '', '### Known limitations', '', 'text'].join('\n')
  assert.equal(parseFeatures('docs/FEATURES.md', src).features.length, 1,
    'a ### subheading was counted as a feature')
  ok('parseFeatures treats a ### subheading as body, not a feature')
}

// Fence-blindness is the exact defect parseItems already paid for: a document
// that DEMONSTRATES the heading format inside a code fence would otherwise
// invent a phantom feature from its own example. This file's own FEATURES.md
// entry will quote `## <Name> - <date>`, so this is a live risk, not a corner.
{
  const src = [
    '## Real \u2014 2025-01-04',
    '',
    '```md',
    '## Not a feature \u2014 2026-01-01',
    '```',
    '',
    '## Another \u2014 2025-01-05',
  ].join('\n')
  const feats = parseFeatures('docs/FEATURES.md', src).features
  assert.equal(feats.length, 2, 'a fenced example became a feature')
  assert.deepEqual(feats.map((f) => f.name), ['Real', 'Another'])
  ok('parseFeatures ignores a heading inside a code fence')
}

// An exact assertion belongs on a FIXTURE, where the input is pinned.
{
  const src = [
    '# Features', '',
    '## Alpha feature \u2014 2025-01-04', '', 'body', '',
    '## No date at all', '', 'body', '',
  ].join('\n')
  const feats = parseFeatures('docs/FEATURES.md', src).features
  assert.equal(feats.length, 2)
  assert.deepEqual(feats.map((f) => f.slug), ['alpha-feature', 'no-date-at-all'])
  assert.equal(feats[0].date, '2025-01-04')
  assert.equal(feats[0].name, 'Alpha feature')
  assert.equal(feats[1].date, null, 'an undated heading is still an entry, with a null date')
  assert.ok(feats.every((f) => f.rel === 'docs/FEATURES.md'))
  ok('parseFeatures reads the name, the slug and the date, and tolerates a missing date')
}

// And then against the REAL file, because a parser written against a
// description of a shape rather than the live data is a parser that reads
// zero and says nothing about it. About the SHAPE only:
// the exact entries differ between this file's two forms, and an assertion
// naming one of them would be an assertion about which form is on disk rather
// than about the parser.
{
  const real = readFileSync(join(HERE, '..', 'docs', 'FEATURES.md'), 'utf8')
  const feats = parseFeatures('docs/FEATURES.md', real).features
  assert.ok(feats.length >= 5, 'expected at least 5 entries, got ' + feats.length)
  assert.ok(feats.every((f) => f.name && f.slug), 'an entry parsed with no name or slug')
  assert.ok(feats.every((f) => f.rel === 'docs/FEATURES.md'), 'an entry parsed with the wrong rel')
  assert.equal(new Set(feats.map((f) => f.slug)).size, feats.length, 'two entries share a slug')
  // A DATE IS OPTIONAL, and the count of dated entries is not asserted: a
  // journal of decisions dates every entry and a description of behaviour
  // dates none, and both are this file. What is asserted is that a date which
  // parsed parsed into a date -- the fixture above pins the rest exactly.
  const dated = feats.filter((f) => f.date)
  for (const f of dated) {
    assert.match(f.date, /^\d{4}-\d{2}-\d{2}$/, `${f.slug} parsed a date of ${f.date}`)
  }
  ok(`parseFeatures handles the real docs/FEATURES.md (${feats.length} entries, ${dated.length} dated)`)
}

// --- the Shipped: declaration ----------------------------------------------
// A plan can describe work that shipped and is still being extended and yet
// read 0 of N, because it ran before the tick-as-you-go convention existed.
// Its unticked steps then dominate every view, each advertising
// "Step 1: Write the failing test" as the current step.
//
// Backfilling is not available: `just plan-done` demands a commit range, a
// verification command with its exit status and a review verdict per task, and
// the ledger those 97 steps would need was git-ignored scratch that is long
// gone. Faking it would corrupt the one signal the three states exist for.
//
// So the plan DECLARES that it shipped. The claim is deliberately weaker than
// `[x]`: it says the milestone landed, not that each step was reviewed.
{
  const h = parseHeader('# P\n\n**Shipped:** 2025-01-04 \u2014 aaaaaaa\n')
  assert.deepEqual(h.shipped, { date: '2025-01-04', commit: 'aaaaaaa' })
  ok('parseHeader reads a Shipped: declaration as a date and a commit')

  const bare = parseHeader('# P\n\n**Shipped:** 2025-01-04\n')
  assert.deepEqual(bare.shipped, { date: '2025-01-04', commit: null })
  ok('parseHeader accepts a Shipped: date with no commit')

  assert.equal(parseHeader('# P\n\nnothing\n').shipped, null)
  ok('parseHeader returns a null shipped for a plan that declares none')
}

// A declared Shipped: takes the plan out of flight. A plan can sit at 0/12
// with every step unchecked and still have shipped, and `live` is computed as
// `done < total`, so nothing about the counts can rescue it. The declaration
// has to win.
{
  const shipped = {
    rel: 'docs/plans/2025-01-04-gamma.md',
    title: 'Gamma', done: 0, reported: 0, total: 12,
    currentItemId: 'abc123', items: [{ id: 'abc123', text: 'Step 1: Write the failing test' }],
    shipped: { date: '2025-01-04', commit: 'aaaaaaa' },
  }
  const out = foldEfforts([{ path: '/main', isMain: true, plans: [shipped] }])
  const e = out.efforts[0]
  assert.equal(e.live, false, 'a shipped plan is still counted in flight')
  assert.deepEqual(e.shipped, { date: '2025-01-04', commit: 'aaaaaaa' },
    'the effort did not carry its shipped declaration')
  assert.equal(e.done, 0, 'shipped must NOT invent progress -- 0/12 is still the truth on disk')
  assert.equal(e.total, 12)
  ok('a plan declaring Shipped: leaves flight without its counts being falsified')

  // The user's actual complaint: every one of these advertised
  // "Step 1: Write the failing test" as its current step, everywhere.
  assert.equal(e.currentItem, null, 'a shipped effort still advertises a current step')
  assert.equal(e.currentItemId, null)
  ok('a shipped effort advertises no current step')
}

// The Shipped: declaration end to end through scan(), not only through the
// pure fold -- because the per-worktree `plans[]` entry reaches the browser
// too, and the Worktrees subtab reads `plan.currentItemId` directly.
{
  const shipBox = mkdtempSync(join(tmpdir(), 'szg-ship-'))
  const root = join(shipBox, 'proj')
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true })
  writeFileSync(join(root, 'docs', 'plans', 'shipped-thing.md'), [
    '# Shipped thing',
    '',
    '**Spec:** `docs/specs/x.md`',
    '**Shipped:** 2025-01-04 \u2014 aaaaaaa',
    '',
    '## Task 1',
    '- [ ] **Step 1: Write the failing test**',
    '- [ ] **Step 2: Make it pass**',
  ].join('\n'))

  const s = createScanner({ registerFile: join(shipBox, 'reg.json') })
  const projects = await s.scan([{ id: 'z1', name: 'z', cwd: root, working: false }], Date.now())
  const plan = projects[0].worktrees[0].plans[0]

  assert.deepEqual(plan.shipped, { date: '2025-01-04', commit: 'aaaaaaa' })
  assert.equal(plan.total, 2, 'the steps on disk are still counted')
  assert.equal(plan.done, 0, 'shipped must not invent progress')
  assert.equal(plan.currentItemId, null,
    'a shipped plan still names a current step, so the view still shows it')
  ok('scan() carries Shipped: onto the plan and clears its current step')

  assert.equal(projects[0].efforts[0].live, false, 'a shipped plan is still in flight after a scan')
  ok('scan() folds a shipped plan into an effort that is not in flight')

  rmSync(shipBox, { recursive: true, force: true })
}

// Shipped: must be read off ANY copy, not the winning one. The failure this
// pins: the declaration added in one worktree while every copy reads 0/N, so
// `ahead()` never displaces copies[0], and the effort reads shipped=no while
// the file on disk plainly declares it.
//
// The distinction is real rather than a patch. done/reported/total and
// checkedAt are MEASUREMENTS of a checkout, so they belong to the most
// advanced copy. Shipped: is a DECLARATION about the work itself -- if any
// copy carries it, the milestone landed, whichever checkout happens to win.
{
  const copy = (extra = {}) =>
    ({ rel: 'docs/plans/m.md', title: 'M', done: 0, reported: 0, total: 36,
       currentItemId: 'i1', items: [{ id: 'i1', text: 'Step 1: Write the failing test' }], ...extra })
  const out = foldEfforts([
    // the copy that wins the tie declares nothing
    { path: '/main', isMain: true, plans: [copy()] },
    // only this one declares it
    { path: '/w1', isMain: false, plans: [copy({ shipped: { date: '2025-01-04', commit: 'aaaaaaa' } })] },
  ])
  const e = out.efforts[0]
  assert.deepEqual(e.shipped, { date: '2025-01-04', commit: 'aaaaaaa' },
    'a declaration in a non-winning copy was ignored')
  assert.equal(e.live, false, 'the effort stayed in flight despite a declared Shipped:')
  assert.equal(e.currentItem, null)
  ok('Shipped: declared in any copy takes the effort out of flight')
}


// F2: a Shipped: value with no parseable date is MALFORMED, not a declaration.
// Gating on bare truthiness lets `**Shipped:** no` produce
// {date:null, commit:null} -- truthy -- and silently retire a live plan from
// every in-flight count with no error anywhere. A gate that ignores the EMPTY
// value while honouring the word "no" is accidental rather than designed. A declaration this weak has to be legible or it is worse than
// none: it is an undo button nobody can see.
{
  for (const bad of ['no', 'not yet', 'TBD', 'not yet, pending review', 'soon — aaaaaaa']) {
    const h = parseHeader('# P\n\n**Shipped:** ' + bad + '\n')
    assert.equal(h.shipped, null, JSON.stringify(bad) + ' was accepted as a shipped declaration')
    assert.equal(h.shippedMalformed, bad, 'a malformed declaration must be reported, not just dropped')
  }
  // A real one still parses, and a well-formed declaration reports nothing.
  const good = parseHeader('# P\n\n**Shipped:** 2025-01-04 — aaaaaaa\n')
  assert.deepEqual(good.shipped, { date: '2025-01-04', commit: 'aaaaaaa' })
  assert.equal(good.shippedMalformed, null)
  // And absence is not malformed.
  assert.equal(parseHeader('# P\n\nnothing\n').shippedMalformed, null)
  ok('a Shipped: value with no date is reported as malformed, never honoured')
}

// F4: a bare `##` must not become a nameless feature. parseItems guards this
// at two places; parseFeatures did not, so `##` yielded {name:'', slug:''} --
// an index key of '' that every other malformed heading would collide with.
//
// This test exists because the assertion that was SUPPOSED to cover it could
// not fail: it ran `feats.every(f => f.name && f.slug)` against the real file,
// which has no such line, over code with no guard. It encoded an invariant
// nothing enforced.
{
  const src = ['## Real — 2025-01-04', '##', '##   ', '## Another — 2025-01-02'].join('\n')
  const feats = parseFeatures('docs/FEATURES.md', src).features
  assert.deepEqual(feats.map((f) => f.name), ['Real', 'Another'], 'a nameless heading became a feature')
  assert.ok(feats.every((f) => f.name && f.slug), 'a feature parsed with no name or slug')
  ok('parseFeatures skips a heading with no name rather than emitting an empty slug')
}

// F3: two entries whose names slug identically are REPORTED, never silently
// deduped. Not hypothetical: until 2025-01-05 docs/FEATURES.md carried
// `## Syzygy: the rename, five themes, and the deck's own tooltip — 2025-01-05`
// at two different lines, from a partially duplicated append; the scanner
// reported it and the duplicate was then removed by hand.
//
// It matters because makes the slug the feature index key and is
// exact-match-only, so a Map keeps one row and "Extend this" on one card maps
// onto the other. The house rule everywhere else is to refuse or report
// ambiguity rather than pick: foldEfforts reports basename collisions, and
// claims-inherit refuses an ambiguous inheritance outright.
{
  // These two collide because slugOf lowercases and strips punctuation. Note
  // it does NOT collapse whitespace runs -- `Same  thing` slugs to
  // `same--thing` and would not collide, which is the same 1:1 space mapping
  // that makes an em dash leave a double hyphen behind.
  const dup = ['## Same Thing — 2025-01-04', 'a', '## Same thing! — 2025-01-05', 'b'].join('\n')
  const out = parseFeatures('docs/FEATURES.md', dup)
  assert.equal(out.features.length, 2, 'both entries are still returned')
  assert.deepEqual(out.collisions, [{ slug: 'same-thing', names: ['Same Thing', 'Same thing!'] }],
    'a slug collision was not reported')
  // The real file: the invariant is that it carries NO duplicate heading, so a
  // re-appended entry is caught here rather than surfacing as a phantom
  // collision chip in the pane.
  const real = parseFeatures('docs/FEATURES.md', readFileSync(join(HERE, '..', 'docs', 'FEATURES.md'), 'utf8'))
  assert.equal(real.collisions.length, 0,
    'docs/FEATURES.md has a duplicated heading: ' + real.collisions.map((c) => c.slug).join(', '))
  ok('parseFeatures reports a slug collision instead of silently keeping one')
}


// A malformed Shipped: has to REACH somebody. parseHeader reporting it is not
// reporting: the field has to be on the payload, or "reported" means a value
// computed and dropped -- which is the same defect as plan.tasks being parsed
// and transported and matched against nothing for a week.
//
// This test exists because I first checked for malformed declarations with a
// live scan that read `pl.shippedMalformed` before anything set it. The count
// was 0 and could never have been anything else.
{
  const box = mkdtempSync(join(tmpdir(), 'szg-mal-'))
  const root = join(box, 'proj')
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true })
  writeFileSync(join(root, 'docs', 'plans', 'wishful.md'), [
    '# Wishful', '', '**Shipped:** not yet, blocked on review', '',
    '## Task 1', '- [ ] **Step 1**', '- [x] **Step 2**',
  ].join('\n'))

  const sc = createScanner({ registerFile: join(box, 'reg.json') })
  const projects = await sc.scan([{ id: 'm1', name: 'm', cwd: root, working: false }], Date.now())
  const plan = projects[0].worktrees[0].plans[0]

  assert.equal(plan.shipped, null, 'an undateable value was honoured as a declaration')
  assert.equal(plan.shippedMalformed, 'not yet, blocked on review',
    'the malformed declaration never reached the payload')
  assert.deepEqual(projects[0].malformedShipped,
    [{ rel: 'docs/plans/wishful.md', value: 'not yet, blocked on review' }],
    'the project did not report its malformed declaration')
  // And the plan is still in flight, which is the whole point.
  assert.equal(projects[0].efforts[0].live, true, 'a malformed declaration retired a live plan')
  assert.equal(projects[0].efforts[0].currentItem, 'Step 1', 'the current step was cleared anyway')
  ok('a malformed Shipped: reaches the payload and leaves the plan in flight')

  rmSync(box, { recursive: true, force: true })
}


// --- C1: docs/FEATURES.md is discovered, with its OWN byte cap -------------
// It is the only source of "implemented", and until now it was in no discovery
// list at all: parseFeatures was exported, tested, and called by nothing.
//
// The cap is separate from `fileBytes` on measured grounds, not taste.
// FEATURES.md is an append-only log that can reach a large fraction of
// fileBytes and keeps growing -- while the plans and task files
// that cap was sized for do not grow monotonically. One constant standing for
// two budgets means neither can be tuned, which is the defect the Projects tab
// spec already logged for specs borrowing `plansPerWorktree`.
{
  const box = mkdtempSync(join(tmpdir(), 'szg-feat-'))
  mkdirSync(join(box, 'docs'), { recursive: true })
  writeFileSync(join(box, 'docs', 'FEATURES.md'), '# Features\n\n## A — 2025-01-04\n\nbody\n')

  const found = discover(box)
  assert.ok(found.features, 'discover() returned no features entry at all')
  assert.equal(found.features.rel, 'docs/FEATURES.md')
  assert.ok(found.features.bytes > 0)
  ok('discover finds docs/FEATURES.md')

  // Absence is absence, not a refusal -- the same rule TASKS.md follows, or
  // every project without the file would carry a warning.
  const bare = mkdtempSync(join(tmpdir(), 'szg-nofeat-'))
  const none = discover(bare)
  assert.equal(none.features, null)
  assert.equal(none.skipped.some((x) => x.rel === 'docs/FEATURES.md'), false,
    'a missing FEATURES.md was reported as a refusal')
  ok('a project with no FEATURES.md reports absence, not a refusal')
  rmSync(bare, { recursive: true, force: true })

  // THE SEPARATE CAP. A file over featuresBytes but comfortably under
  // fileBytes must be refused -- that is what proves the new constant is
  // actually wired rather than merely declared.
  assert.ok(CAPS.featuresBytes > 0, 'CAPS.featuresBytes is not defined')
  assert.notEqual(CAPS.featuresBytes, CAPS.fileBytes,
    'featuresBytes is the same number as fileBytes, so it buys nothing')
  // The cap is LARGER than fileBytes, because the point is headroom for a log
  // that only grows. So the proof runs the other way round: a file OVER
  // fileBytes but UNDER featuresBytes must be ACCEPTED. That can only pass if
  // the new constant is genuinely the one being applied.
  assert.ok(CAPS.featuresBytes > CAPS.fileBytes,
    'featuresBytes is meant to give a monotonically growing log headroom')
  const mid = mkdtempSync(join(tmpdir(), 'szg-midfeat-'))
  mkdirSync(join(mid, 'docs'), { recursive: true })
  writeFileSync(join(mid, 'docs', 'FEATURES.md'), 'x'.repeat(CAPS.fileBytes + 4096))
  const accepted = discover(mid)
  assert.ok(accepted.features,
    'a FEATURES.md over fileBytes was refused, so fileBytes is still the cap in force')
  assert.equal(accepted.skipped.some((x) => x.rel === 'docs/FEATURES.md'), false)
  ok('docs/FEATURES.md over fileBytes is accepted — featuresBytes is the cap in force')
  rmSync(mid, { recursive: true, force: true })

  // And the new cap still bites, or it would not be a cap.
  const big = mkdtempSync(join(tmpdir(), 'szg-bigfeat-'))
  mkdirSync(join(big, 'docs'), { recursive: true })
  writeFileSync(join(big, 'docs', 'FEATURES.md'), 'x'.repeat(CAPS.featuresBytes + 1024))
  const over = discover(big)
  assert.equal(over.features, null)
  assert.deepEqual(over.skipped.filter((x) => x.rel === 'docs/FEATURES.md'),
    [{ rel: 'docs/FEATURES.md', reason: 'too-large' }],
    'an oversized FEATURES.md was not refused as too-large')
  ok('docs/FEATURES.md past featuresBytes is refused as too-large')
  rmSync(big, { recursive: true, force: true })
  rmSync(box, { recursive: true, force: true })
}


// --- C1 payload: features reach the browser, folded to one per PROJECT -----
// Every worktree inherits docs/FEATURES.md, so a per-worktree list would
// report every entry once per worktree -- the same inflation the effort fold
// prevents, in a new place. MAIN's copy is canonical: it is
// the shipped record, and a worktree's copy is whatever that branch happens
// to hold mid-flight.
{
  const box = mkdtempSync(join(tmpdir(), 'szg-fpay-'))
  const root = join(box, 'proj')
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'FEATURES.md'), [
    '# Features', '',
    '## Alpha feature — 2025-01-04', '', 'body one', '',
    '## Turn spinners — 2025-01-02', '', 'body two', '',
    '## Alpha Feature! — 2025-01-01', '', 'a name that slugs the same', '',
  ].join('\n'))

  const sc = createScanner({ registerFile: join(box, 'reg.json') })
  const projects = await sc.scan([{ id: 'f1', name: 'f', cwd: root, working: false }], Date.now())
  const p = projects[0]

  assert.ok(Array.isArray(p.features), 'the project carries no features array')
  assert.equal(p.features.length, 3)
  assert.deepEqual(p.features.map((f) => f.slug),
    ['alpha-feature', 'turn-spinners', 'alpha-feature'])
  assert.equal(p.features[0].date, '2025-01-04')
  assert.equal(p.features[0].rel, 'docs/FEATURES.md')
  ok('scan() puts docs/FEATURES.md on the project as `features`')

  // A collision is carried to the browser, not just computed. The slug is the
  // reference index key, so an unreported collision would make a mapping
  // resolve to the wrong entry silently.
  assert.deepEqual(p.featureCollisions,
    [{ slug: 'alpha-feature', names: ['Alpha feature', 'Alpha Feature!'] }],
    'a feature slug collision did not reach the payload')
  ok('a feature slug collision is reported on the project')

  rmSync(box, { recursive: true, force: true })
}

// A project with no FEATURES.md carries an empty list, not a missing key --
// so the view can distinguish "no features yet" from "an older relay that
// never sent the field". A client reading a field the server does not send
// fails SILENTLY.
{
  const box = mkdtempSync(join(tmpdir(), 'szg-nofpay-'))
  const root = join(box, 'p')
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true })
  writeFileSync(join(root, 'docs', 'plans', 'a.md'), '# A\n\n## T\n- [ ] **S**\n')
  const sc = createScanner({ registerFile: join(box, 'reg.json') })
  const p = (await sc.scan([{ id: 'n1', name: 'n', cwd: root, working: false }], Date.now()))[0]
  assert.deepEqual(p.features, [])
  assert.deepEqual(p.featureCollisions, [])
  ok('a project with no FEATURES.md carries an empty features list, not a missing key')
  rmSync(box, { recursive: true, force: true })
}


// --- C3: specs are read for their titles and FOLDED by basename ------------
// `wt.specs` was a list of paths that nothing ever read. A spec needs a title
// to be shown as a planned feature, and it has to be folded for the same
// reason plans are: every worktree inherits every committed spec, so a
// per-worktree list reports one spec once per worktree -- the same inflation
// the effort fold prevents.
//
// Folding by BASENAME rather than `rel`, because the scanner reads both
// docs/specs and docs/superpowers/specs and a spec that moved between them is
// the same document.
{
  const box = mkdtempSync(join(tmpdir(), 'szg-specs-'))
  const mk = (root, dir, name, title) => {
    mkdirSync(join(root, ...dir.split('/')), { recursive: true })
    writeFileSync(join(root, ...dir.split('/'), name), '# ' + title + '\n\nbody\n')
  }
  const root = join(box, 'proj')
  mk(root, 'docs/specs', '2025-01-05-thing-design.md', 'The Thing — design')
  mk(root, 'docs/specs', 'README.md', 'Specs')
  mk(root, 'docs/superpowers/specs', '2025-01-02-older-design.md', 'Older — design')
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true })
  writeFileSync(join(root, 'docs', 'plans', 'p.md'), '# P\n\n## T\n- [ ] **S**\n')

  const sc = createScanner({ registerFile: join(box, 'reg.json') })
  const p = (await sc.scan([{ id: 's1', name: 's', cwd: root, working: false }], Date.now()))[0]

  assert.ok(Array.isArray(p.specs), 'the project carries no specs array')
  const byName = Object.fromEntries(p.specs.map((x) => [x.name, x]))
  assert.deepEqual(Object.keys(byName).sort(),
    ['2025-01-02-older-design.md', '2025-01-05-thing-design.md'])
  assert.equal(byName['2025-01-05-thing-design.md'].title, 'The Thing — design',
    'a spec title was not read from its `# ` heading')
  assert.equal(byName['2025-01-05-thing-design.md'].rel, 'docs/specs/2025-01-05-thing-design.md')
  ok('scan() reads each spec title and puts specs on the project, folded by basename')

  // README.md is not a spec: a README would otherwise list at 0/0, so the
  // spec list excludes it.
  assert.equal(p.specs.some((x) => x.name === 'README.md'), false,
    'README.md was listed as a spec')
  ok('README.md is excluded from specs')

  rmSync(box, { recursive: true, force: true })
}


// --- C2: a plan's DECLARED references are resolved -------------------------
// of the Projects tab design and its have never been
// honoured. `parseHeader` has produced `plan.tasks` since that tab shipped,
// the payload has carried it, `item.slug` has been computed for every backlog
// heading, and no code has ever matched one against the other -- so
// `claim_work`'s description had a sentence struck for claiming the join
// existed. This is that join, at the payload level.
{
  const box = mkdtempSync(join(tmpdir(), 'szg-refs-'))
  const root = join(box, 'proj')
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true })
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'TASKS.md'), [
    '# TASKS', '',
    '## Browser pane — finish the patch bay', '', 'prose', '',
    '## GRID — second pass', '', 'more prose', '',
  ].join('\n'))
  writeFileSync(join(root, 'docs', 'specs', '2025-01-02-grid-design.md'), '# GRID — design\n')
  writeFileSync(join(root, 'docs', 'plans', '2025-01-02-grid.md'), [
    '# Alpha Implementation Plan', '',
    '**Spec:** `docs/specs/2025-01-02-grid-design.md`',
    '**Tasks:** docs/TASKS.md#browser-pane--finish-the-patch-bay, docs/TASKS.md#no-such-heading',
    '', '## Task 1', '- [ ] **Step 1**',
  ].join('\n'))

  const sc = createScanner({ registerFile: join(box, 'reg.json') })
  const p = (await sc.scan([{ id: 'r1', name: 'r', cwd: root, working: false }], Date.now()))[0]
  const plan = p.worktrees[0].plans.find((x) => x.rel.endsWith('2025-01-02-grid.md'))

  assert.ok(plan.resolvedTasks, 'the plan carries no resolvedTasks')
  assert.equal(plan.resolvedTasks.length, 2)

  const good = plan.resolvedTasks[0]
  assert.equal(good.broken, undefined)
  assert.equal(good.text, 'Browser pane — finish the patch bay',
    'a declared Tasks: reference did not resolve to its heading')
  assert.equal(good.rel, 'docs/TASKS.md')

  // A DANGLING reference renders as broken rather than being dropped, so a
  // renamed heading is visible instead of silent. asks for this.
  const bad = plan.resolvedTasks[1]
  assert.equal(bad.broken, true)
  assert.equal(bad.ref, 'docs/TASKS.md#no-such-heading')
  ok('a plan\'s declared Tasks: references resolve, and a dangling one is broken')

  // The declared Spec: pointer resolves too -- that is what gives the planned
  // features list its identity, and it was another transported-but-unread field.
  assert.equal(plan.resolvedSpec.broken, undefined)
  // Flattened, like resolvedTasks: the name and title, not the whole spec
  // object. The project already carries `specs`, so duplicating it onto every
  // plan cost 25 KB of payload for nothing -- measured, 81 plan rows.
  assert.deepEqual(plan.resolvedSpec,
    { ref: 'docs/specs/2025-01-02-grid-design.md', name: '2025-01-02-grid-design.md', title: 'GRID — design' })
  ok('a plan\'s declared Spec: pointer resolves to the document it names')

  // And the project collects every broken reference, so the view has one
  // place to render them from rather than walking every plan.
  assert.deepEqual(p.brokenRefs,
    [{ from: 'docs/plans/2025-01-02-grid.md', kind: 'backlog', ref: 'docs/TASKS.md#no-such-heading' }],
    'the project did not collect its broken references')
  ok('the project reports every broken declared reference')

  // whole point: nothing is inferred. `## GRID — second pass` matches the
  // plan's title strongly and is its OUTPUT, not its input -- it must not be
  // linked to anything.
  assert.equal(plan.resolvedTasks.some((r) => r.slug === 'grid--second-pass'), false,
    'a reference was inferred rather than declared')
  ok('an undeclared but similar heading is never linked')

  rmSync(box, { recursive: true, force: true })
}


// A `Tasks:` line that says "none" in prose declares NO references.
// Found by a live scan, not by reading: a plan may write
// `**Tasks:** none — this is new work, not a `docs/TASKS.md` backlog entry.`
// The comma-split produced "none" and "not" as references, and both were then
// faithfully reported as broken links -- a page of broken references that are
// words from a sentence.
//
// The rule: a backlog reference is `<file>#<slug>`, so an entry with no `#`
// is not a reference. Prose is ignored rather than reported, because
// "reported" only means something if the report is worth reading.
{
  const prose = parseHeader('# P\n\n**Tasks:** none — this is new work, not a `docs/TASKS.md` backlog entry.\n')
  assert.deepEqual(prose.tasks, [], 'prose in a Tasks: line was parsed as references')
  ok('a Tasks: line with no reference in it declares none')

  // A real one still parses, including alongside trailing commentary.
  const real = parseHeader('# P\n\n**Tasks:** `docs/TASKS.md#projects-tab--follow-ups-from-the-build` (the key fix)\n')
  assert.deepEqual(real.tasks, ['docs/TASKS.md#projects-tab--follow-ups-from-the-build'])
  // And several, comma-separated.
  const many = parseHeader('# P\n\n**Tasks:** docs/TASKS.md#a, docs/TASKS.md#b\n')
  assert.deepEqual(many.tasks, ['docs/TASKS.md#a', 'docs/TASKS.md#b'])
  ok('a Tasks: line still parses real references, with commentary and commas')
}

// A `Tasks:` value may wrap onto following lines, but only while the line
// before it ends in a comma -- a comma-separated list wrapped for readability
// is still one value, while a value with no trailing comma ends at its own
// line and a prose paragraph beneath the field is never absorbed into it.
{
  const wrapped = parseHeader(
    '# P\n\n**Tasks:** docs/TASKS.md#a,\ndocs/TASKS.md#b,\ndocs/TASKS.md#c\n\nSome prose after the field.\n')
  assert.deepEqual(wrapped.tasks, ['docs/TASKS.md#a', 'docs/TASKS.md#b', 'docs/TASKS.md#c'],
    'every wrapped reference must be read')
  ok('a Tasks: list wrapped after a comma yields every reference')

  // The first line has no trailing comma, so the line after it -- itself a
  // real reference followed by a comma -- must never be pulled in. If it
  // were, its own comma would split off `docs/TASKS.md#c` as a THIRD, bogus
  // reference: proof the guard is doing real work, not just leaving a
  // single-line value alone by construction.
  const notWrapped = parseHeader(
    '# P\n\n**Tasks:** docs/TASKS.md#a\ndocs/TASKS.md#b, docs/TASKS.md#c\n')
  assert.deepEqual(notWrapped.tasks, ['docs/TASKS.md#a'],
    'a line following a comma-less value must not be absorbed into it')
  ok('a following prose line after a comma-less value is not absorbed')
}

// brokenRefs is deduped across worktrees. Driven directly through
// `resolveDeclaredRefs` rather than `scan()`, because scan() cannot exercise
// this path: a healthy project has no broken reference at all, so a live scan
// reports 0 and proves nothing.
//
// A fixture with a SINGLE worktree cannot fail this test: there is nothing to
// deduplicate, so the assertion passes with the dedupe deleted outright while
// its label still claims "however many worktrees carry the plan". That is why
// the fixture below carries three.
{
  const plan = (rel) => ({
    rel, title: 'P', done: 0, reported: 0, total: 1, items: [],
    tasks: ['docs/TASKS.md#nope'], spec: 'docs/specs/missing-design.md',
  })
  // Three worktrees carrying the same plan, and one of them at the OLD path --
  // which is why the dedupe keys on basename and not on `rel`.
  const built = [
    { path: '/main', isMain: true, plans: [plan('docs/plans/p.md')], tasks: [], specs: [] },
    { path: '/w1', isMain: false, plans: [plan('docs/plans/p.md')], tasks: [], specs: [] },
    { path: '/w2', isMain: false, plans: [plan('docs/superpowers/plans/p.md')], tasks: [], specs: [] },
  ]
  const broken = resolveDeclaredRefs(built, buildIndex({ worktrees: built, features: [], specs: [] }))

  assert.equal(broken.length, 2,
    'expected one backlog and one spec reference, got ' + JSON.stringify(broken))
  assert.deepEqual(broken.map((b) => b.kind).sort(), ['backlog', 'spec'])
  assert.equal(broken.filter((b) => b.ref === 'docs/TASKS.md#nope').length, 1,
    'the backlog reference was reported once per worktree')
  ok('brokenRefs deduplicates a reference carried by three worktrees, including one at the old path')

  // Every copy still gets its own annotation -- the dedupe is about the
  // REPORT, not about skipping work the payload needs.
  for (const w of built) {
    assert.equal(w.plans[0].resolvedTasks.length, 1)
    assert.equal(w.plans[0].resolvedTasks[0].broken, true)
    assert.equal(w.plans[0].resolvedSpec.broken, true)
  }
  ok('every copy of a plan is still annotated, however the report is deduped')
}

// --- graphOf: bounded commit history per branch -----------------------------
import { graphOf, headsKey, GRAPH_COMMITS_PER_BRANCH, GRAPH_BRANCHES_PER_PROJECT,
  GRAPH_SUBJECT_MAX, GRAPH_RETRY_MS } from '../syzygy/bridge/tasks-git.mjs'

// headsKey is pure -- no repo needed.
{
  const a = headsKey('/repo', [{ branch: 'main', head: 'aaa' }, { branch: 'feature', head: 'bbb' }])
  const b = headsKey('/repo', [{ branch: 'feature', head: 'bbb' }, { branch: 'main', head: 'aaa' }])
  assert.equal(a, b, 'headsKey must be stable under reordering')
  const c = headsKey('/repo', [{ branch: 'main', head: 'aaa' }, { branch: 'feature', head: 'ccc' }])
  assert.notEqual(a, c, 'headsKey must change when one head moves')
  ok('headsKey is stable under reordering and changes when a head moves')
}

// A single real repo carries every branch shape the rest of the checks need:
// a plain fast-forward, a merge, an oversized subject and an oversized
// history. `graphOf` reads only `main.path` for every git call, so a
// worktree entry never needs its own checkout -- a bare branch name pointing
// into the same repo is enough.
{
  const graphBox = mkdtempSync(join(tmpdir(), 'szg-graph-'))
  const gitc = (args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { cwd: graphBox, stdio: 'ignore' })
  const gitOut = (args) => execFileSync('git', args, { cwd: graphBox }).toString().trim()

  execFileSync('git', ['init', '-q', '-b', 'main', graphBox], { stdio: 'ignore' })
  gitc(['commit', '--allow-empty', '-qm', 'root'])
  gitc(['commit', '--allow-empty', '-qm', 'second'])
  const mainHead = gitOut(['rev-parse', 'HEAD'])

  gitc(['checkout', '-q', '-b', 'feature'])
  gitc(['commit', '--allow-empty', '-qm', 'feature 1'])
  gitc(['commit', '--allow-empty', '-qm', 'feature 2'])
  const featureHead = gitOut(['rev-parse', 'HEAD'])

  gitc(['checkout', '-q', 'main'])
  gitc(['checkout', '-q', '-b', 'longsubj'])
  gitc(['commit', '--allow-empty', '-qm', 'x'.repeat(GRAPH_SUBJECT_MAX + 40)])

  gitc(['checkout', '-q', 'main'])
  gitc(['checkout', '-q', '-b', 'many'])
  for (let i = 0; i < GRAPH_COMMITS_PER_BRANCH + 5; i++) gitc(['commit', '--allow-empty', '-qm', `many ${i}`])

  gitc(['checkout', '-q', 'main'])
  gitc(['checkout', '-q', '-b', 'mbase'])
  gitc(['commit', '--allow-empty', '-qm', 'mbase 1'])
  gitc(['checkout', '-q', '-b', 'mside'])
  gitc(['commit', '--allow-empty', '-qm', 'mside 1'])
  gitc(['checkout', '-q', 'mbase'])
  gitc(['merge', '--no-ff', '-q', '-m', 'merge mside', 'mside'])

  gitc(['checkout', '-q', 'main'])

  const mainWt = { path: graphBox, branch: 'main', head: mainHead, isMain: true }

  // 2: a branch two commits ahead, base main, newest-first commits with a
  // 40-char sha, a parents array and a numeric `at`.
  {
    const g = await graphOf(graphBox, [mainWt, { path: graphBox, branch: 'feature', head: featureHead, isMain: false }])
    assert.equal(g.base, 'main')
    const feat = g.branches.find((br) => br.name === 'feature')
    assert.ok(feat, 'expected a feature branch row')
    assert.equal(feat.ahead, 2)
    assert.equal(feat.behind, 0)
    assert.equal(feat.commits[0].subject, 'feature 2', 'commits must come back newest first')
    assert.equal(feat.commits[0].sha.length, 40)
    assert.ok(Array.isArray(feat.commits[0].parents))
    assert.equal(typeof feat.commits[0].at, 'number')
    ok('graphOf reports ahead/behind and newest-first commits with full shas')
    resetCache()
  }

  // 3: a merge commit carries two parents.
  {
    const g = await graphOf(graphBox, [mainWt, { path: graphBox, branch: 'mbase', head: null, isMain: false }])
    const mbase = g.branches.find((br) => br.name === 'mbase')
    assert.equal(mbase.commits[0].parents.length, 2, 'the newest commit on mbase is the merge')
    ok('a merge commit is reported with two parents')
    resetCache()
  }

  // 4: an oversized subject is cut to exactly GRAPH_SUBJECT_MAX.
  {
    const g = await graphOf(graphBox, [mainWt, { path: graphBox, branch: 'longsubj', head: null, isMain: false }])
    const ls = g.branches.find((br) => br.name === 'longsubj')
    assert.equal(ls.commits[0].subject.length, GRAPH_SUBJECT_MAX)
    ok('a subject longer than GRAPH_SUBJECT_MAX is cut to exactly that length')
    resetCache()
  }

  // 5: more than GRAPH_COMMITS_PER_BRANCH commits truncates the branch to
  // exactly the cap.
  {
    const g = await graphOf(graphBox, [mainWt, { path: graphBox, branch: 'many', head: null, isMain: false }])
    const many = g.branches.find((br) => br.name === 'many')
    assert.equal(many.truncated, true)
    assert.equal(many.commits.length, GRAPH_COMMITS_PER_BRANCH)
    ok('a branch with more than GRAPH_COMMITS_PER_BRANCH commits is truncated to exactly the cap')
    resetCache()
  }

  // 6: more than GRAPH_BRANCHES_PER_PROJECT branches caps the graph itself,
  // main first.
  {
    const extraCount = GRAPH_BRANCHES_PER_PROJECT + 5
    const extras = []
    for (let i = 0; i < extraCount; i++) {
      execFileSync('git', ['branch', `extra-${i}`, 'main'], { cwd: graphBox, stdio: 'ignore' })
      extras.push({ path: graphBox, branch: `extra-${i}`, head: null, isMain: false })
    }
    const g = await graphOf(graphBox, [mainWt, ...extras])
    assert.equal(g.branches.length, GRAPH_BRANCHES_PER_PROJECT)
    assert.equal(g.truncated, true)
    assert.equal(g.branches[0].name, 'main', 'main must sort first once branches are capped')
    ok('more than GRAPH_BRANCHES_PER_PROJECT branches caps the graph and keeps main first')
    resetCache()
  }

  // 10: a detached worktree contributes no branch row and does not fail the call.
  {
    const g = await graphOf(graphBox, [mainWt, { path: graphBox, branch: null, head: null, isMain: false }])
    assert.ok(g, 'a detached worktree must not fail the call')
    assert.equal(g.branches.length, 1, 'a detached worktree must not contribute a branch row')
    assert.equal(g.branches[0].name, 'main')
    ok('a detached worktree contributes no branch row and does not fail the call')
    resetCache()
  }

  // 9: the cache gate. A clean build is served by reference until its heads
  // change; a build carrying a failed git call is served for GRAPH_RETRY_MS
  // on an injected clock and then rebuilt.
  {
    let clockNow = 1_700_000_000_000
    const now = () => clockNow
    const cleanWts = [mainWt, { path: graphBox, branch: 'feature', head: featureHead, isMain: false }]

    const a = await graphOf(graphBox, cleanWts, { now })
    const b = await graphOf(graphBox, cleanWts, { now })
    assert.equal(a, b, 'an unchanged heads key must serve the same object')
    ok('graphOf serves a clean build from cache by reference')

    resetCache()
    const c = await graphOf(graphBox, cleanWts, { now })
    assert.notEqual(c, a, 'resetCache must force a rebuild')
    ok('resetCache clears the graph cache')

    clockNow += 10 * GRAPH_RETRY_MS
    const d = await graphOf(graphBox, cleanWts, { now })
    assert.equal(d, c, 'a clean graph must not be rebuilt by the clock alone')
    ok('a clean graph is cached until a head moves, never on a timer')

    resetCache()
    clockNow = 1_700_000_000_000
    const failWts = [mainWt, { path: graphBox, branch: 'ghost-branch-does-not-exist', head: 'deadbeef', isMain: false }]

    const f1 = await graphOf(graphBox, failWts, { now })
    const ghost = f1.branches.find((br) => br.name === 'ghost-branch-does-not-exist')
    assert.equal(ghost.commits.length, 0, 'a branch git cannot resolve is an empty row, not a throw')

    clockNow += GRAPH_RETRY_MS - 1000
    const f2 = await graphOf(graphBox, failWts, { now })
    assert.equal(f2, f1, 'a failed build is still cached before GRAPH_RETRY_MS elapses')

    clockNow += 2000
    const f3 = await graphOf(graphBox, failWts, { now })
    assert.notEqual(f3, f1, 'a failed build is rebuilt once GRAPH_RETRY_MS elapses')
    ok('a build with a failed git call retries after GRAPH_RETRY_MS, unlike a clean one')
    resetCache()
  }

  rmSync(graphBox, { recursive: true, force: true })
}

// 7: a repo with no commits at all.
{
  const emptyBox = mkdtempSync(join(tmpdir(), 'szg-graph-empty-'))
  execFileSync('git', ['init', '-q', '-b', 'main', emptyBox], { stdio: 'ignore' })
  const g = await graphOf(emptyBox, [{ path: emptyBox, branch: 'main', head: null, isMain: true }])
  assert.ok(g, 'an empty repo must not return null')
  assert.equal(g.branches.length, 1)
  assert.deepEqual(g.branches[0].commits, [])
  ok('a repo with no commits returns a graph with empty commits, never null')
  resetCache()
  rmSync(emptyBox, { recursive: true, force: true })
}

// 8: a path that is not a git directory returns null.
{
  const notGit = mkdtempSync(join(tmpdir(), 'szg-graph-notgit-'))
  const wts = await worktreesOf(notGit)
  assert.equal(wts, null, 'fixture must not itself be a git directory')
  const g = await graphOf(notGit, wts)
  assert.equal(g, null, 'a path that is not a git directory must yield null')
  ok('graphOf returns null for a path that is not a git directory')
  rmSync(notGit, { recursive: true, force: true })
}

// --- plan and task-file lookups: a real record on request --------------------
// The scan keeps every item for the relay's own readers -- the digest and
// document (tasks-digest.mjs) are what leaves the relay on every change and
// on a project fetch; a view opening one plan or one task file's steps asks
// for that record by the worktree path and rel the payload already named.
import * as tasksModule from '../syzygy/bridge/tasks.mjs'
import { spawn } from 'node:child_process'

{
  assert.equal(typeof tasksModule.planRecord, 'function', 'tasks.mjs exports no planRecord lookup')
  const rec = tasksModule.planRecord(out, wt.path, plan.rel)
  assert.ok(rec, 'a scanned plan in a scanned worktree was not found')
  assert.equal(rec.rel, plan.rel)
  assert.deepEqual(rec.items, plan.items)
  assert.equal(tasksModule.planRecord(out, wt.path, 'docs/plans/nope.md'), null)
  assert.equal(tasksModule.planRecord(out, '/not/a/scanned/worktree', plan.rel), null)
  assert.equal(tasksModule.planRecord(out, wt.path, join(wt.path, plan.rel)), null, 'a filesystem path is not a plan rel')
  assert.equal(tasksModule.planRecord(out, wt.path, './' + plan.rel), null)
  assert.equal(tasksModule.planRecord(out, WT_T, plan.rel.replace('alpha', 'nope')), null)
  assert.equal(tasksModule.planRecord(out, undefined, undefined), null)
  assert.equal(tasksModule.planRecord(out, [wt.path], [plan.rel]), null)
  assert.equal(tasksModule.planRecord(null, wt.path, plan.rel), null)
  ok('planRecord finds a plan only by a scanned worktree and one of its scanned rels')
}

{
  assert.equal(typeof tasksModule.backlogRecord, 'function', 'tasks.mjs exports no backlogRecord lookup')
  const file = wt.tasks.find((t) => t.rel === 'docs/TASKS.md')
  assert.ok(file?.items?.length, 'the fixture worktree carries no scanned task file')
  const rec = tasksModule.backlogRecord(out, wt.path, file.rel)
  assert.ok(rec, 'a scanned task file in a scanned worktree was not found')
  assert.equal(rec.rel, file.rel)
  assert.deepEqual(rec.items, file.items)
  assert.equal(tasksModule.backlogRecord(out, wt.path, 'docs/NOPE.md'), null)
  assert.equal(tasksModule.backlogRecord(out, '/not/a/scanned/worktree', file.rel), null)
  assert.equal(tasksModule.backlogRecord(out, wt.path, join(wt.path, file.rel)), null, 'a filesystem path is not a task file rel')
  assert.equal(tasksModule.backlogRecord(out, wt.path, './' + file.rel), null)
  assert.equal(tasksModule.backlogRecord(out, wt.path, '../../../../etc/passwd'), null)
  assert.equal(tasksModule.backlogRecord(out, wt.path, plan.rel), null, 'a plan is not a task file')
  assert.equal(tasksModule.planRecord(out, wt.path, file.rel), null, 'a task file is not a plan')
  assert.equal(tasksModule.backlogRecord(out, undefined, undefined), null)
  assert.equal(tasksModule.backlogRecord(out, [wt.path], [file.rel]), null)
  assert.equal(tasksModule.backlogRecord(null, wt.path, file.rel), null)
  ok('backlogRecord finds a task file only by a scanned worktree and one of its scanned rels')
}

// The route, on a real relay: a mocked relay cannot prove a route ladder.
// Isolated on every axis -- SZG_PORT=0, a throwaway SZG_DATA_DIR, no SZG_*
// variable inherited, and a claude binary that does not exist.
{
  const relayPath = join(HERE, '..', 'syzygy', 'bridge', 'relay.mjs')
  const TOKEN = 'tasks-harness-' + Math.random().toString(36).slice(2)
  const MIN_PAYLOAD_VERSION = 18
  const dataDir = mkdtempSync(join(tmpdir(), 'szg-tasks-relay-data-'))
  const repo = mkdtempSync(join(tmpdir(), 'szg-tasks-relay-repo-'))
  cpSync(MAIN, repo, { recursive: true })
  // More items than the task register keeps, so every pass evicts entries and
  // re-creates them with a fresh firstSeen: the full scan never serialises the
  // same way twice, while nothing a pane is sent has changed.
  writeFileSync(join(repo, 'docs', 'plans', 'zz-many-steps.md'),
    '# Many Steps\n\n' + Array.from({ length: 5200 }, (_, i) => '- [ ] step ' + i).join('\n') + '\n')
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SZG_')))
  const child = spawn(process.execPath, [relayPath], {
    cwd: join(HERE, '..'),
    env: {
      ...baseEnv, SZG_PORT: '0', SZG_TOKEN: TOKEN, SZG_PANE_PASSWORD_DISABLED: '1', SZG_TMUX_BIN: '/usr/bin/false',
      SZG_DATA_DIR: dataDir, SZG_CLAUDE_BIN: join(dataDir, 'no-such-claude'),
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
      return { status: res.status, body: parsed }
    }
    const reg = await call('POST', '/api/register', { token: TOKEN, session: { id: 'tr-1', name: 'tr', cwd: repo } })
    assert.equal(reg.status, 200, 'register failed: ' + JSON.stringify(reg.body))

    let state = null
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      state = (await call('GET', '/api/state')).body
      if (state?.projects?.[0]?.worktrees?.[0]?.planCount) break
      await new Promise((r) => setTimeout(r, 200))
    }
    const rDigest = state?.projects?.[0]
    assert.ok(rDigest?.worktrees?.[0]?.planCount, 'the relay never scanned the registered session\'s plan; stderr: ' + stderr)
    assert.ok(state.payloadVersion >= MIN_PAYLOAD_VERSION, 'the projects digest ships at version ' + MIN_PAYLOAD_VERSION + ' or later')
    assert.equal('plans' in rDigest.worktrees[0], false, '/api/state still carries a worktree\'s plan list')
    // Nothing claims alpha.md, so the digest leaves it out and counts it.
    assert.equal(rDigest.efforts.some((e) => e.name === 'alpha.md'), false, 'the digest carried an unclaimed effort')
    assert.ok(rDigest.moreEfforts >= 1)
    // The plan's rel, current step and current step id come from the project's document.
    const rDoc = (await call('GET', '/api/projects/' + encodeURIComponent(rDigest.key))).body?.project
    assert.ok(rDoc, 'the document route did not answer for a scanned project')
    const rWt = rDoc.worktrees[0]
    const rEffort = rDoc.efforts.find((e) => e.name === 'alpha.md')
    assert.equal(rEffort.currentItem, 'Step 2: second')
    const rPlan = { rel: rEffort.rel, currentItemId: rEffort.currentItemId }
    assert.equal(rPlan.rel, 'docs/plans/alpha.md')
    ok('/api/state carries the projects digest, never a plan list or plan items')

    const q = (wtPath, rel) => '/api/projects/plan?wt=' + encodeURIComponent(wtPath) + '&path=' + encodeURIComponent(rel)
    const got = await call('GET', q(rWt.path, rPlan.rel))
    assert.equal(got.status, 200, 'the plan route refused a scanned plan: ' + JSON.stringify(got.body))
    assert.equal(got.body.plan.rel, rPlan.rel)
    assert.ok(got.body.plan.items.some((i) => i.id === rPlan.currentItemId), 'the plan route returned no items')
    assert.equal((await fetch(base + q(rWt.path, rPlan.rel), { method: 'HEAD', headers: { 'x-mch-token': TOKEN } })).status, 200)
    ok('GET /api/projects/plan returns one scanned plan in full')

    const refused = async (path, error) => {
      const r = await call('GET', path)
      assert.equal(r.status, 400, path + ' answered ' + r.status)
      assert.deepEqual(r.body, { error }, path)
    }
    await refused(q(rWt.path, 'docs/plans/nope.md'), 'unknown file')
    await refused(q('/not/scanned', rPlan.rel), 'unknown worktree')
    await refused(q(rWt.path, join(rWt.path, rPlan.rel)), 'unknown file')
    await refused(q(rWt.path, '../../../../etc/passwd'), 'unknown file')
    await refused('/api/projects/plan', 'unknown worktree')
    const posted = await call('POST', q(rWt.path, rPlan.rel), { token: TOKEN })
    assert.notEqual(posted.status, 200, 'a POST must not read the plan route')
    assert.equal(posted.body?.plan, undefined)
    ok('the plan route refuses anything but a scanned worktree and one of its scanned plans, and is GET/HEAD-only')

    // Nothing on disk changes from here on, so no `projects` frame may follow
    // the snapshot, however the full scan churns beneath it.
    const ac = new AbortController()
    const frames = []
    const streamed = fetch(base + '/api/stream?token=' + TOKEN, { signal: ac.signal }).then(async (res) => {
      const dec = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true })
        let at
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const m = /^event: (\S+)/.exec(buf.slice(0, at))
          if (m) frames.push(m[1])
          buf = buf.slice(at + 2)
        }
      }
    }).catch(() => {})
    await new Promise((r) => setTimeout(r, 9_500))
    ac.abort()
    await streamed
    assert.equal(frames[0], 'snapshot', 'the stream did not open with a snapshot: ' + frames.join(', '))
    assert.equal(frames.filter((f) => f === 'projects').length, 0,
      'an unchanged board was rebroadcast: ' + frames.join(', '))
    ok('an unchanged board sends no projects frame, while the full scan churns beneath it')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((r) => child.once('exit', r))
      child.kill('SIGTERM')
      await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
}

console.log('\n✔ all ' + passed + ' tasks-parse checks passed')
