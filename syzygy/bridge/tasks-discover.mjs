// Which files the scanner is allowed to read, and how many.
//
// The relay's reads are ungated by the user's explicit decision, so
// containment here is the only thing between an unauthenticated endpoint and
// arbitrary file contents. A symlinked docs/plans/x.md -> /etc/passwd must
// never be read. Everything REFUSED is reported in `skipped` with a reason --
// over a cap, outside the worktree, not a file, or unreadable. Absence is NOT
// a refusal: a worktree with no TASKS.md yields an empty list, because a
// "not found" entry per candidate path would warn on nearly every project
// and bury the real ones.

import { readdirSync, statSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { CLAIMS_REL } from './claims.mjs'

export const CAPS = {
  fileBytes: 256 * 1024,
  // docs/FEATURES.md gets its OWN budget, on measured grounds. It is an
  // append-only log, and a busy project's can pass a third of fileBytes and
  // add tens of kilobytes in a day -- while the plans and task files
  // fileBytes was sized for do not grow monotonically. One constant standing
  // for two budgets means neither can be tuned; the Projects tab spec already
  // logged that exact defect for specs borrowing `plansPerWorktree`.
  featuresBytes: 1024 * 1024,
  plansPerWorktree: 40,
  worktreesPerProject: 12,
  projects: 40,
}

/** The task files a project may keep, in PRECEDENCE order.
 *
 *  The convention: a project's backlog lives at `docs/TASKS.md`, `TODO.md` is
 *  an equally acceptable name,
 *  and **a file at the project root outranks one under `docs/`** when a project
 *  has both. Root first is therefore not cosmetic ordering; it is the rule.
 *
 *  Every match is still read and still published — nothing is hidden, because a
 *  `docs/TASKS.md` that has quietly stopped being the one that counts is worth
 *  seeing. The order decides only which file is NAMED as the authority, and
 *  that is what the drawer flags. */
const TASK_FILES = ['TASKS.md', 'TODO.md', 'docs/TASKS.md', 'docs/TODO.md']

/** Where the winning task file lives, for the pane to say so. `'root'` is the
 *  case worth flagging: it means a `docs/TASKS.md` may exist and not be the
 *  authority. `null` is a worktree with no task file at all, which is ordinary
 *  and must not read as a failure. */
const authorityOf = (rel) => (rel ? (rel.includes('/') ? 'docs' : 'root') : null)
/** One known path, never a scan -- the same containment rule as everything
 *  else here. Absence is absence: a project without the file gets an empty
 *  Features view, not a warning. */
const FEATURES_FILE = 'docs/FEATURES.md'
const PLAN_DIRS = ['docs/plans', 'docs/superpowers/plans']
const SPEC_DIRS = ['docs/specs', 'docs/superpowers/specs']

/** True only if `candidate` really lives under `root` once every symlink on
 *  both paths is resolved. */
export const containedIn = (root, candidate) => {
  try {
    const realRoot = realpathSync(root)
    const real = realpathSync(candidate)
    return real === realRoot || real.startsWith(realRoot + sep)
  } catch { return false }
}

const describe = (root, rel, skipped, maxBytes = CAPS.fileBytes) => {
  const abs = join(root, rel)
  let st
  try {
    st = statSync(abs)
  } catch (e) {
    // ENOENT is absence, not refusal. A worktree with no TASKS.md reports an
    // empty list, and pushing a "not found" entry for every candidate path
    // would put warnings on nearly every project and drown the real ones.
    // Anything else -- a permissions denial, an I/O error -- IS a refusal and
    // must be visible, or it reads to the consumer as simple absence.
    if (e.code !== 'ENOENT') skipped.push({ rel, reason: 'unreadable' })
    return null
  }
  if (!containedIn(root, abs)) { skipped.push({ rel, reason: 'outside-worktree' }); return null }
  if (!st.isFile()) { skipped.push({ rel, reason: 'not-a-file' }); return null }
  if (st.size > maxBytes) { skipped.push({ rel, reason: 'too-large' }); return null }
  return { rel, abs, bytes: st.size, mtimeMs: st.mtimeMs }
}

/** Direct children only -- never recursive. A plans directory is a flat list
 *  by convention, and recursion would multiply both the cap and the risk.
 *
 *  Containment is checked BEFORE the directory is enumerated, not only per
 *  file. describe() would refuse each file's contents anyway, but the
 *  enumeration would already have happened and the real basenames would land
 *  in `skipped` -- which is published on the ungated endpoint and rendered by
 *  the pane. A repo with docs/plans symlinked to ~/Documents would turn an
 *  unauthenticated read into a *.md directory listing. */
const listDir = (root, dir, skipped, cap) => {
  const out = []
  const abs = join(root, dir)
  // Resolve first, so "simply not there" stays absence rather than becoming a
  // refusal on every project that has no docs/plans -- the noise the header
  // above warns about. containedIn() cannot make that distinction on its own:
  // it returns false for a missing path too.
  try { realpathSync(abs) }
  catch (e) {
    if (e.code !== 'ENOENT') skipped.push({ rel: dir, reason: 'unreadable' })
    return out
  }
  if (!containedIn(root, abs)) {
    // Report the directory we were asked for, never a name from inside it.
    skipped.push({ rel: dir, reason: 'outside-worktree' })
    return out
  }
  let names
  try { names = readdirSync(abs) }
  catch (e) {
    // Same rule as describe(): a plans directory that is simply not there is
    // absence; one we cannot read is a refusal.
    if (e.code !== 'ENOENT') skipped.push({ rel: dir, reason: 'unreadable' })
    return out
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue
    if (out.length >= cap) { skipped.push({ rel: join(dir, name), reason: 'too-many' }); continue }
    const f = describe(root, join(dir, name), skipped)
    if (f) out.push(f)
  }
  return out
}

export const discover = (worktreeRoot) => {
  const skipped = []
  const tasks = []
  for (const rel of TASK_FILES) {
    const f = describe(worktreeRoot, rel, skipped)
    if (f) tasks.push(f)
  }
  const plans = []
  for (const dir of PLAN_DIRS) {
    plans.push(...listDir(worktreeRoot, dir, skipped, CAPS.plansPerWorktree - plans.length))
  }
  const specs = []
  for (const dir of SPEC_DIRS) {
    specs.push(...listDir(worktreeRoot, dir, skipped, CAPS.plansPerWorktree - specs.length))
  }
  // The shipped-features record. Its own cap, not fileBytes -- see CAPS.
  const features = describe(worktreeRoot, FEATURES_FILE, skipped, CAPS.featuresBytes)
  // Who is working on what, in this worktree. One known path, never a scan,
  // and refused by the same containment rule as everything else here.
  const claims = describe(worktreeRoot, CLAIMS_REL, skipped)
  // `tasks` is built in TASK_FILES order and describe() drops what is absent,
  // so the first survivor is the highest-precedence file that actually exists.
  const taskFile = tasks[0]?.rel ?? null
  return { tasks, taskFile, taskAuthority: authorityOf(taskFile), plans, specs, features, claims, skipped }
}
