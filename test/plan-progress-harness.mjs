#!/usr/bin/env node
// Drives scripts/plan-progress.mjs. Hermetic: a temp plan and temp ledgers, the
// real CLI as a child process. Run: node test/plan-progress-harness.mjs
//
// The evidence gate is the whole point of the three-state split, and nothing
// else exercises it. A gate that quietly stops discriminating looks exactly
// like a gate that passes -- so each check here asserts the REASON a run was
// refused, not just that it was.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'plan-progress.mjs')
const dir = mkdtempSync(join(tmpdir(), 'szg-plan-'))
let pass = 0
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label) }

const PLAN = [
  '# Plan',
  '',
  '### Task 1 - first',
  '- [ ] alpha',
  '- [ ] beta',
  '',
  '### Task 2 - second',
  '- [ ] gamma',
  '',
  'An example the parser must not touch:',
  '```',
  '- [ ] fenced example',
  '```',
  '',
].join('\n')

const plan = join(dir, 'plan.md')
const write = (t) => writeFileSync(plan, t)
const read = () => readFileSync(plan, 'utf8')
const steps = () => read().split('\n').filter((l) => /^- \[/.test(l))

const ledger = (name, body) => { const p = join(dir, name); writeFileSync(p, body); return p }

const run = (args, led) => {
  const env = { ...process.env }
  if (led) env.PLAN_PROGRESS_LEDGER = led
  else delete env.PLAN_PROGRESS_LEDGER
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, env, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const BARE = ledger('bare.md', 'Task 1: complete (nothing to show for it)\n')
const FULL = ledger('full.md', [
  'Task 1: implementer DONE, `just verify` exit 0.',
  'Task 1: review clean - spec ✅, quality Approved.',
  'Task 1: complete (commits `aaaaaaa`..`bbbbbbb`, review clean)',
  '',
  'Task 2: complete (no evidence here at all)',
].join('\n'))
const NO_EXIT = ledger('noexit.md', [
  'Task 1: review clean - spec ✅, quality Approved.',
  'Task 1: complete (commits `aaaaaaa`..`bbbbbbb`, review clean)',
].join('\n'))

// ---- reported ---------------------------------------------------------------
write(PLAN)
ok('task-reported marks only its own task, and never the fenced example', () => {
  const r = run(['task-reported', 'plan.md', '1'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(steps(), ['- [~] alpha', '- [~] beta', '- [ ] gamma', '- [ ] fenced example'])
})

ok('task-reported never walks a verified step backwards into a claim', () => {
  write(PLAN.replace('- [ ] alpha', '- [x] alpha'))
  assert.equal(run(['task-reported', 'plan.md', '1']).code, 0)
  assert.equal(steps()[0], '- [x] alpha')
  assert.equal(steps()[1], '- [~] beta')
})

// ---- the flatter, self-numbered format (docs/plans/usage-window.md et al) ---
// The public-push feature round's plans have no "### Task N" heading at all --
// one bold-numbered checkbox item under a milestone heading IS the task. This
// must work exactly like the older heading-tagged format above, and the two
// must never bleed into each other on the same file.
const FLAT_PLAN = [
  '# Flat plan',
  '',
  '## M1 — first milestone',
  '',
  '- [ ] **1. `bridge/thing.mjs`.** Some wrapped prose that spills onto a',
  '  second line with no checkbox marker at all.',
  '- [ ] **2. The next task.** One line is enough for this one.',
  '',
  '## M2 — second milestone',
  '',
  '- [ ] **3. A third task, in a different milestone.**',
  '',
  'An example the parser must not touch:',
  '```',
  '- [ ] **9. fenced, must never be reachable**',
  '```',
  '',
].join('\n')

write(FLAT_PLAN)
ok('task-reported recognises a self-numbered checkbox item with no "### Task N" heading', () => {
  const r = run(['task-reported', 'plan.md', '2'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(steps(), [
    '- [ ] **1. `bridge/thing.mjs`.** Some wrapped prose that spills onto a',
    '- [~] **2. The next task.** One line is enough for this one.',
    '- [ ] **3. A third task, in a different milestone.**',
    '- [ ] **9. fenced, must never be reachable**',
  ])
})

ok('a self-numbered task tags only its OWN line, not the wrapped prose after it', () => {
  write(FLAT_PLAN)
  run(['task-reported', 'plan.md', '1'])
  const lines = read().split('\n')
  assert.equal(lines[4], '- [~] **1. `bridge/thing.mjs`.** Some wrapped prose that spills onto a')
  assert.equal(lines[5], '  second line with no checkbox marker at all.', 'the continuation line must be untouched')
})

ok('a task number across a milestone boundary (M1 vs M2) is not confused with the previous one', () => {
  write(FLAT_PLAN)
  run(['task-reported', 'plan.md', '3'])
  assert.deepEqual(steps(), [
    '- [ ] **1. `bridge/thing.mjs`.** Some wrapped prose that spills onto a',
    '- [ ] **2. The next task.** One line is enough for this one.',
    '- [~] **3. A third task, in a different milestone.**',
    '- [ ] **9. fenced, must never be reachable**',
  ])
})

ok('the fenced self-numbered example is never reachable', () => {
  write(FLAT_PLAN)
  const r = run(['task-reported', 'plan.md', '9'])
  assert.equal(r.code, 1)
  assert.match(r.out, /plan has no task 9/)
})

ok('task-reported on an unknown task number in the flat format names both formats it checked', () => {
  write(FLAT_PLAN)
  const r = run(['task-reported', 'plan.md', '42'])
  assert.equal(r.code, 1)
  assert.match(r.out, /### Task 42/)
  assert.match(r.out, /\*\*42\./)
})

// ---- the evidence gate ------------------------------------------------------
write(PLAN)
ok('task-done refuses when there is no ledger at all', () => {
  const r = run(['task-done', 'plan.md', '1'])
  assert.equal(r.code, 1)
  assert.match(r.out, /no ledger/i)
  assert.equal(steps()[0], '- [ ] alpha', 'the plan must be untouched on refusal')
})

ok('task-done refuses a task the ledger does not record complete', () => {
  const r = run(['task-done', 'plan.md', '2'], BARE)
  assert.equal(r.code, 1)
  assert.match(r.out, /does not record/i)
  assert.match(r.out, /may not verify its own work/i)
})

ok('task-done names all three missing facts when the entry is bare', () => {
  const r = run(['task-done', 'plan.md', '1'], BARE)
  assert.equal(r.code, 1)
  assert.match(r.out, /commit range/i)
  assert.match(r.out, /exit status/i)
  assert.match(r.out, /review verdict/i)
})

ok('task-done names ONLY the missing fact when the rest is present', () => {
  const r = run(['task-done', 'plan.md', '1'], NO_EXIT)
  assert.equal(r.code, 1)
  assert.match(r.out, /exit status/i)
  assert.doesNotMatch(r.out, /commit range/i)
  assert.doesNotMatch(r.out, /review verdict/i)
})

ok("task-done does not accept another task's evidence", () => {
  // is recorded complete in FULL, but every fact sits under.
  const r = run(['task-done', 'plan.md', '2'], FULL)
  assert.equal(r.code, 1)
  assert.match(r.out, /commit range/i)
})

ok('task-done verifies when the evidence is all there, promoting [ ] and [~]', () => {
  write(PLAN.replace('- [ ] beta', '- [~] beta'))
  const r = run(['task-done', 'plan.md', '1'], FULL)
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(steps(), ['- [x] alpha', '- [x] beta', '- [ ] gamma', '- [ ] fenced example'])
})

// ---- the gate ---------------------------------------------------------------
ok('check fails when the ledger claims complete but the steps are only reported', () => {
  write(PLAN.replace('- [ ] alpha', '- [~] alpha').replace('- [ ] beta', '- [~] beta'))
  const r = run(['check', 'plan.md'], BARE)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /only reported/i)
})

ok('check passes once those same steps are verified', () => {
  write(PLAN.replace('- [ ] alpha', '- [x] alpha').replace('- [ ] beta', '- [x] beta'))
  const r = run(['check', 'plan.md'], BARE)
  assert.equal(r.code, 0, r.out)
})

// ---- plan-names: one basename, one plan -------------------------------------
// The gate behind basename identity. Across worktrees a shared basename is the
// same plan; within one it merges two rows, so the build has to refuse it
// rather than trusting anyone to remember.
{
  const NAMES = join(ROOT, 'scripts', 'plan-names.mjs')
  const mk = (files) => {
    const r = mkdtempSync(join(tmpdir(), 'szg-names-'))
    for (const f of files) {
      mkdirSync(join(r, dirname(f)), { recursive: true })
      writeFileSync(join(r, f), '# plan\n')
    }
    return r
  }
  const names = (r) => {
    const res = spawnSync(process.execPath, [NAMES], {
      env: { ...process.env, PLAN_NAMES_ROOT: r }, encoding: 'utf8',
    })
    return { code: res.status, out: (res.stdout || '') + (res.stderr || '') }
  }

  ok('plan-names passes when every basename is distinct', () => {
    const r = names(mk(['docs/plans/a.md', 'docs/plans/b.md', 'docs/superpowers/plans/c.md']))
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /3 plan file\(s\), 3 distinct/)
  })

  ok('plan-names fails on a basename shared across the two plan directories', () => {
    const r = names(mk(['docs/plans/dup.md', 'docs/superpowers/plans/dup.md', 'docs/plans/ok.md']))
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /dup\.md/)
    assert.match(r.out, /docs\/superpowers\/plans\/dup\.md/)
    assert.doesNotMatch(r.out, /ok\.md/)
  })

  ok('plan-names is happy with no plan directories at all', () => {
    assert.equal(names(mkdtempSync(join(tmpdir(), 'szg-names-empty-'))).code, 0)
  })
}

rmSync(dir, { recursive: true, force: true })
console.log(`\nplan-progress harness: ${pass} checks passed`)
