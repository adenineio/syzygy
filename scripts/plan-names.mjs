#!/usr/bin/env node
// plan-names — one basename, one plan.
//
// Why this exists: the Projects tab identifies a plan by its BASENAME, because
// that is the only identity that survives a plan file moving between plan
// directories. Item ids include the file path, so main's ticked copy and a
// worktree's stale copy at an older path share no items and read as two
// unrelated plans -- one showing every step done and the other none of them,
// at the same time, with the glance counting each copy as its own effort.
//
// Basename identity fixes that, and buys the fix with one invariant:
//
//   WITHIN a single worktree, no two plan files may share a basename.
//
// Across worktrees a shared basename means the same plan -- that is the whole
// point. Within one it means either a half-finished move (copied rather than
// moved) or two genuinely different plans, and either way two rows would
// silently become one.
//
// This is a gate rather than a rule someone has to remember, for the same
// reason plan-check is one: `just verify` cannot forget, and a person editing
// in an editor is covered as well as an agent editing through a tool.
//
//   plan-names        check this worktree   <- the gate
//
// If two plans genuinely need the same basename, they cannot have it. Rename
// one: the UI shows a plan's title, not its filename.

import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'

const root = process.env.PLAN_NAMES_ROOT || process.cwd()
const DIRS = ['docs/plans', 'docs/superpowers/plans']

if (process.argv[2] === 'help' || process.argv[2] === '--help') {
  process.stdout.write(readFileSync(new URL(import.meta.url)).toString()
    .split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n') + '\n')
  process.exit(0)
}

const seen = new Map()
let files = 0
for (const d of DIRS) {
  const abs = join(root, d)
  if (!existsSync(abs)) continue
  for (const name of readdirSync(abs)) {
    if (!name.endsWith('.md')) continue
    files++
    const key = basename(name)
    if (!seen.has(key)) seen.set(key, [])
    seen.get(key).push(join(d, name))
  }
}

const clashes = [...seen.entries()].filter(([, rels]) => rels.length > 1)
if (clashes.length) {
  process.stderr.write('plan-names: two plan files in this worktree share a basename.\n')
  process.stderr.write('  A plan is identified by its basename, so these would merge into one row.\n')
  for (const [name, rels] of clashes) {
    process.stderr.write(`\n  ${name}\n`)
    for (const r of rels) process.stderr.write(`    ${r}\n`)
  }
  process.stderr.write('\n  If this is a half-finished move, delete the copy at the old path.\n')
  process.stderr.write('  If they are different plans, rename one -- the UI shows the title, not the file.\n')
  process.exit(1)
}

console.log(`plan-names: ${files} plan file(s), ${seen.size} distinct basename(s), no clashes`)
