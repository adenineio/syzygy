#!/usr/bin/env node
// plan-progress — keep a plan's checkboxes honest, and graduate its rulings.
//
// Why this exists: subagent-driven development records progress in a git-ignored
// SDD ledger and never touches the plan, so every finished plan reads 0/N in the
// Projects tab and in `git`. The ledger is also one `git clean -fdx` from gone,
// taking its rulings with it.
//
// Three states, because a tick has to mean something. `- [ ]` not started,
// `- [~]` REPORTED (the executor believes it is done), `- [x]` VERIFIED (gates
// passed and a reviewer confirmed it). An executor may never write `[x]` for its
// own work: that is what makes the signal structural rather than a matter of
// discipline. Note `- [~]` renders on GitHub as an unchecked box with a literal
// tilde -- that is expected, do not "fix" it.
//
//   task-reported <plan> <N>  claim task N as done. Cheap, no evidence needed.
//   task-done     <plan> <N>  mark task N VERIFIED. Refuses unless the ledger
//                             already records it complete WITH evidence
//   tick-all      <plan>      verify every step (retroactive; requires --force)
//   check     <plan>       fail if plan ticks and ledger disagree  <- the gate
//   decisions <plan>       extract rulings into docs/decisions/, committed
//
// The gate is the point. Anyone can forget to call task-done; `just verify`
// cannot forget to run check.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'

const FENCE = /^\s*(```|~~~)/
const STEP_TODO = /^(\s*)- \[ \] /
const STEP_REPORTED = /^(\s*)- \[~\] /
const STEP_DONE = /^(\s*)- \[x\] /
const TASK_HEAD = /^###\s+Task\s+(\d+)\b/
// The public-push feature round's flatter plan format (e.g.
// docs/plans/usage-window.md): one numbered, bold checkbox item IS the task,
// directly under a milestone heading -- there is no separate "### Task N"
// line at all. `- [ ] **12. Routes and scheduler.** ...`, not
// "Step 1"/"Step 2": TASK_ITEM requires digits immediately after `**`, which a
// step label never starts with, so the two formats cannot collide.
const TASK_ITEM = /^\s*- \[[ ~x]\] \*\*(\d+)\.\s/

const die = (m) => { process.stderr.write('plan-progress: ' + m + '\n'); process.exit(1) }

/** Split a plan into lines tagged with the task they belong to, skipping fenced
 *  blocks. Fence-awareness is not optional: plan documents demonstrate `- [ ]`
 *  steps inside their own code fences, and ticking one of those would corrupt an
 *  example while claiming work that does not exist.
 *
 *  Two ways a line can carry a task number, and they behave differently on
 *  purpose. A "### Task N" heading is STICKY: it sets `task` for every line
 *  that follows (several "- [ ] **Step M: ...**" lines under one heading all
 *  belong to the same task). A self-numbered checkbox item is
 *  NOT sticky: it names a task for exactly its own line, because the very
 *  next checkbox line in this flatter format names a different task. Checked
 *  after the heading update so the two can never fight over one line. */
const scan = (src) => {
  const lines = src.split('\n')
  const out = []
  let fence = false
  let task = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE.test(line)) { fence = !fence; out.push({ i, line, task, fenced: true }); continue }
    if (!fence) {
      const h = TASK_HEAD.exec(line)
      if (h) task = Number(h[1])
    }
    const item = !fence && TASK_ITEM.exec(line)
    out.push({ i, line, task: item ? Number(item[1]) : task, fenced: fence })
  }
  return { lines, tagged: out }
}

const stepsOf = (tagged, task) =>
  tagged.filter((r) => !r.fenced && r.task === task &&
    (STEP_TODO.test(r.line) || STEP_REPORTED.test(r.line) || STEP_DONE.test(r.line)))

const tasksIn = (tagged) => [...new Set(tagged.filter((r) => !r.fenced && r.task != null).map((r) => r.task))].sort((a, b) => a - b)

/** The progress ledger the subagent-driven development workflow writes, if it
 *  still exists. Absent is normal: that workspace is disposable and may live
 *  in another worktree, and a plan with no ledger is simply not gated. */
const ledgerFor = (planPath, root) => {
  const p = join(root, '.superpowers', 'sdd', basename(planPath).replace(/\.md$/, ''), 'progress.md')
  return existsSync(p) ? p : null
}

const completedInLedger = (ledgerPath) => {
  if (!ledgerPath) return null
  const src = readFileSync(ledgerPath, 'utf8')
  const done = new Set()
  for (const m of src.matchAll(/^Task\s+(\d+):\s*complete\b/gm)) done.add(Number(m[1]))
  return done
}

/** Move a task's steps along the ladder.
 *
 *  Verifying subsumes reporting, so `[ ]` and `[~]` both become `[x]`, while
 *  reporting only ever touches `[ ]` -- it must never walk a verified step
 *  backwards into a claim. */
const mark = (planPath, tasks, { all = false, to }) => {
  const from = to === 'verified' ? [STEP_TODO, STEP_REPORTED] : [STEP_TODO]
  const glyph = to === 'verified' ? '- [x] ' : '- [~] '
  const src = readFileSync(planPath, 'utf8')
  const { lines, tagged } = scan(src)
  let n = 0
  for (const r of tagged) {
    if (r.fenced) continue
    const re = from.find((x) => x.test(r.line))
    if (!re) continue
    if (!all && !tasks.has(r.task)) continue
    lines[r.i] = r.line.replace(re, (m, indent) => indent + glyph)
    n++
  }
  if (n) writeFileSync(planPath, lines.join('\n'))
  return n
}

/** Every ledger line that speaks about task N, plus its indented continuations.
 *  Combined entries are real -- a ledger may write `Tasks 1+2: DONE` -- so a
 *  task's evidence may sit under a heading naming several. */
const blockFor = (src, task) => {
  const head = new RegExp('^Tasks?\\s+(?:\\d+\\s*[+,&]\\s*)*' + task + '\\b')
  const anyHead = /^Tasks?\s+\d/
  const out = []
  let taking = false
  for (const line of src.split('\n')) {
    if (anyHead.test(line)) { taking = head.test(line); if (taking) out.push(line); continue }
    if (taking && /^\s+\S/.test(line)) { out.push(line); continue }
    if (line.trim() === '') continue
    taking = false
  }
  return out.join('\n')
}

/** What a `[x]` has to be backed by. Deliberately lenient about wording and
 *  strict about presence: the point is that the three facts EXIST somewhere in
 *  the task's ledger entry, not that they are phrased a particular way. */
const EVIDENCE = [
  { key: 'a commit range',
    test: (b) => /\b[0-9a-f]{7,40}\s*\.{2,3}\s*[0-9a-f]{7,40}\b/.test(b) ||
                 /\bcommits?\b[^\n]*?\b[0-9a-f]{7,40}\b/i.test(b),
    hint: 'commits `<base>`..`<head>`' },
  { key: 'a verification command and its exit status',
    test: (b) => /\bexit(?:\s*(?:code|status))?\s*[:=]?\s*0\b/i.test(b) &&
                 /(`[^`]*`|\b(?:just|npm|node|go|pnpm|yarn|pytest|cargo|make)\b)/.test(b),
    hint: '`just verify` exit 0' },
  { key: 'a review verdict',
    test: (b) => /\breview\s+clean\b/i.test(b) || /spec\s*\u2705/.test(b) ||
                 /\bquality\s+approved\b/i.test(b) || /\bfindings?\s+parked\b/i.test(b),
    hint: 'review clean \u2014 spec \u2705, quality Approved (or: findings parked with rulings)' },
]

const evidenceFor = (ledgerPath, task) =>
  EVIDENCE.filter((e) => !e.test(blockFor(readFileSync(ledgerPath, 'utf8'), task)))

// ---------------------------------------------------------------- commands
const cmd = process.argv[2]
const planArg = process.argv[3]
const root = process.env.PLAN_PROGRESS_ROOT || process.cwd()

if (!cmd || cmd === 'help' || cmd === '--help') {
  process.stdout.write(readFileSync(new URL(import.meta.url)).toString()
    .split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n') + '\n')
  process.exit(0)
}
if (!planArg) die(`usage: plan-progress ${cmd} <plan.md> [args]`)
const planPath = existsSync(planArg) ? planArg : join(root, planArg)
if (!existsSync(planPath)) die(`no such plan: ${planArg}`)

// A ledger may live in another worktree — the plan merges to the main checkout
// while its SDD workspace stays where the work was done. Allow an explicit path
// rather than guessing.
const ledgerPath = process.env.PLAN_PROGRESS_LEDGER
  ? (existsSync(process.env.PLAN_PROGRESS_LEDGER) ? process.env.PLAN_PROGRESS_LEDGER
     : die(`no such ledger: ${process.env.PLAN_PROGRESS_LEDGER}`))
  : ledgerFor(planPath, root)

if (cmd === 'task-reported') {
  const task = Number(process.argv[4])
  if (!Number.isInteger(task)) die('usage: plan-progress task-reported <plan.md> <task-number>')
  const { tagged } = scan(readFileSync(planPath, 'utf8'))
  if (!tasksIn(tagged).includes(task)) die(`plan has no task ${task} (no "### Task ${task}" heading and no "- [ ] **${task}." checkbox item)`)
  const n = mark(planPath, new Set([task]), { to: 'reported' })
  console.log(`task ${task}: reported ${n} step(s)${n ? '' : ' (nothing left to report)'} \u2014 ` +
              '`[~]` is a claim; task-done writes `[x]` once a reviewer has confirmed it')
  process.exit(0)
}

if (cmd === 'task-done') {
  const task = Number(process.argv[4])
  if (!Number.isInteger(task)) die('usage: plan-progress task-done <plan.md> <task-number>')
  const { tagged } = scan(readFileSync(planPath, 'utf8'))
  if (!tasksIn(tagged).includes(task)) die(`plan has no task ${task} (no "### Task ${task}" heading and no "- [ ] **${task}." checkbox item)`)

  // This command READS the ledger and never writes it. A command that
  // appended `Task N: complete` itself and then ticked against it would make
  // the gate circular: the evidence produced by the very action it authorises.
  if (!ledgerPath) die(
    `no ledger for ${basename(planPath)}.\n` +
    '  `[x]` means verified, and the ledger is where the verdict lives. Record the\n' +
    '  review there first, or use `task-reported` to claim the task as reported.')
  const done = completedInLedger(ledgerPath)
  if (!done.has(task)) die(
    `the ledger does not record "Task ${task}: complete".\n` +
    '  An executor may not verify its own work -- the reviewing step writes that\n' +
    '  line. Use `task-reported` to claim it in the meantime.')
  const missing = evidenceFor(ledgerPath, task)
  if (missing.length) {
    process.stderr.write(
      `plan-progress: task ${task} is recorded complete, but its ledger entry is missing:\n`)
    for (const m of missing) process.stderr.write(`  - ${m.key}  e.g. ${m.hint}\n`)
    process.stderr.write(
      '  `[x]` asserts that someone checked. Add the evidence to the ledger entry,\n' +
      '  then re-run. `task-reported` records the claim without it.\n')
    process.exit(1)
  }
  const n = mark(planPath, new Set([task]), { to: 'verified' })
  console.log(`task ${task}: verified ${n} step(s)${n ? '' : ' (already verified)'}`)
  process.exit(0)
}

if (cmd === 'tick-all') {
  if (!process.argv.includes('--force')) {
    die('tick-all rewrites every checkbox in the plan. Re-run with --force if that is what you mean.')
  }
  const n = mark(planPath, null, { all: true, to: 'verified' })
  console.log(`ticked ${n} step(s) in ${basename(planPath)}`)
  process.exit(0)
}

if (cmd === 'check') {
  const { tagged } = scan(readFileSync(planPath, 'utf8'))
  const tasks = tasksIn(tagged)
  const ledgerDone = completedInLedger(ledgerPath)
  if (!ledgerDone) {
    console.log(`${basename(planPath)}: no ledger — not gated`)
    process.exit(0)
  }
  const drift = []
  let reportedTasks = 0
  for (const t of tasks) {
    const steps = stepsOf(tagged, t)
    if (!steps.length) continue
    const ticked = steps.every((s) => STEP_DONE.test(s.line))
    const anyReported = steps.some((s) => STEP_REPORTED.test(s.line))
    if (!ticked && anyReported) reportedTasks++
    const claimed = ledgerDone.has(t)
    // Reported is NOT verified. A task the ledger calls complete whose steps are
    // only `[~]` is exactly the drift worth catching: someone believed it.
    if (claimed && !ticked) drift.push(`task ${t}: ledger says complete, plan still has ` +
      (anyReported ? 'steps only reported `[~]`, never verified `[x]`' : 'unticked steps'))
    if (!claimed && ticked) drift.push(`task ${t}: plan is fully ticked, ledger does not record it complete`)
  }
  if (drift.length) {
    process.stderr.write(`${basename(planPath)}: plan and ledger disagree\n`)
    for (const d of drift) process.stderr.write('  ' + d + '\n')
    process.stderr.write('  fix with: just plan-done <plan> <task>\n')
    process.exit(1)
  }
  console.log(`${basename(planPath)}: ${ledgerDone.size} task(s) complete, plan agrees` +
              (reportedTasks ? `, ${reportedTasks} reported not yet verified` : ''))
  process.exit(0)
}

if (cmd === 'decisions') {
  if (!ledgerPath) die(`no ledger for ${basename(planPath)} — nothing to graduate`)
  const src = readFileSync(ledgerPath, 'utf8')

  // Two ledger shapes are in use: `Ruling:` prose lines, and a `## Rulings`
  // section of bullets. Handle both rather than assume one.
  const rulings = []
  for (const line of src.split('\n')) {
    if (/^Ruling[\s(:]/.test(line)) rulings.push(line.trim())
  }
  const section = /^##\s+Rulings\s*$([\s\S]*?)(?=^##\s|\Z)/m.exec(src)
  if (section) {
    for (const b of section[1].split(/\n(?=- )/)) {
      const t = b.trim()
      if (t.startsWith('- ')) rulings.push(t)
    }
  }
  if (!rulings.length) die('no rulings found in the ledger')

  const stem = basename(planPath).replace(/\.md$/, '')
  const outDir = join(root, 'docs', 'decisions')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${stem}-decisions.md`)
  const body = [
    `# Decisions — ${stem}`,
    '',
    `Graduated from the SDD ledger by \`plan-progress decisions\`. The ledger it`,
    `came from lives in git-ignored scratch and may be deleted; this file is the`,
    `committed record. Plan: \`${planArg}\`.`,
    '',
    `${rulings.length} ruling(s).`,
    '',
    '---',
    '',
    ...rulings.map((r) => r + '\n'),
  ].join('\n')
  writeFileSync(outPath, body)
  console.log(`wrote ${outPath} — ${rulings.length} ruling(s)`)
  process.exit(0)
}

die(`unknown command: ${cmd}`)
