// Git topology for the projects scanner.
//
// A project is keyed by its MAIN worktree root, so every linked worktree of a
// repo lands under one project rather than splitting off. That key is an
// absolute path -- deliberately not `world.projects`' key, which is
// `session.repo || session.cwd` where session.repo is a repo NAME
// (hud.tsx:867 discards the root), so two same-named repos collide there.

import { execFile } from 'node:child_process'
import { basename } from 'node:path'

const TTL_MS = 15_000
const cache = new Map()   // key -> { at, value }

/** execFile, never exec: no shell, so a path with a space is safe. A non-zero
 *  exit or a timeout is not an error here -- it means "not a git repo". */
const git = (args, cwd) =>
  new Promise((res) => {
    try {
      execFile('git', args, { cwd, timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) =>
        res(err ? null : String(stdout)))
    } catch {
      // A cwd that is a file rather than a directory raises ENOTDIR
      // synchronously instead of arriving on the callback. Treat it like every
      // other failure here -- "not a git repo" -- so one unusable cwd cannot
      // abort the scan for every other project.
      res(null)
    }
  })

const cached = async (key, at, make) => {
  const hit = cache.get(key)
  if (hit && at - hit.at < TTL_MS) return hit.value
  const value = await make()
  cache.set(key, { at, value })
  return value
}

export const resetCache = () => cache.clear()

/** `--path-format=absolute` is required: a bare --git-common-dir returns the
 *  relative `.git` when run from the toplevel. Verified on git 2.55.0.
 *
 *  `commonDir` is the PROJECT KEY. It is the same directory for every worktree
 *  of a repo in both layouts, and distinct between two repos, which is all a
 *  key has to be.
 *
 *  It used to be `dirname(commonDir)`, and that was wrong under
 *  `git clone --bare`: there the common dir IS the bare repo, so
 *  `~/repos/alpha.git` and `~/repos/beta.git` both keyed to `~/repos` and the
 *  second was dropped silently, with no `skipped` entry naming it. Harmless
 *  while the key only counted rows; once it drives DOM identity in the pane,
 *  a collision means two projects fighting over one node.
 *
 *  The DISPLAY root is a different question with a different answer -- the
 *  first real worktree, from the worktree list (see topologyOf). */
export const probe = async (cwd) => {
  const out = await git(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], cwd)
  if (!out) return null
  const [commonDir, worktreeRoot] = out.trim().split('\n')
  if (!commonDir || !worktreeRoot) return null
  return { commonDir, worktreeRoot }
}

/** Every worktree of the repo, including ones with no live session -- which is
 *  the point. `cwd` must be a real git directory: pass a session's own
 *  worktree root, never `dirname(commonDir)`, which is not a git directory at
 *  all in the bare layout.
 *
 *  Porcelain lists the main worktree first, and that ordering is the only
 *  thing that identifies it -- but a bare repo is listed first of all, marked
 *  by a lone `bare` line and carrying no working tree. Treating it as main
 *  would diff every real worktree against an empty baseline, so it is parsed
 *  and dropped, and the first NON-bare entry becomes main. */
export const worktreesOf = async (cwd) => {
  const out = await git(['worktree', 'list', '--porcelain'], cwd)
  if (!out) return null
  const list = []
  let cur = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9).trim(), branch: null, head: null, detached: false, locked: false, bare: false, isMain: false }
      list.push(cur)
    } else if (!cur) {
      continue
    } else if (line.trim() === 'bare') {
      cur.bare = true
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5).trim().slice(0, 7)
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
    } else if (line.trim() === 'detached') {
      cur.detached = true
    } else if (line.startsWith('locked')) {
      cur.locked = true
    }
  }
  // `bare` is dropped rather than published: it would be a payload field no
  // consumer reads, and every entry that survives here has a working tree.
  const real = list.filter((w) => !w.bare).map(({ bare, ...w }) => w)
  if (!real.length) return null
  real[0].isMain = true
  return real
}

/** Distinct session cwds -> the projects they belong to. Both git calls are
 *  cached for TTL_MS; worktrees change rarely and these are subprocesses. */
export const topologyOf = async (cwds, at) => {
  const byKey = new Map()
  for (const cwd of [...new Set(cwds.filter(Boolean))]) {
    const p = await cached('probe:' + cwd, at, () => probe(cwd))
    if (!p) {
      if (!byKey.has(cwd)) {
        byKey.set(cwd, {
          key: cwd, name: basename(cwd) || cwd, isGit: false, mainRoot: cwd,
          worktrees: [{ path: cwd, branch: null, head: null, detached: false, locked: false, isMain: true }],
        })
      }
      continue
    }
    if (byKey.has(p.commonDir)) continue
    // Listed from the session's OWN worktree root, which is always a valid git
    // directory. `dirname(commonDir)` is not, under a bare layout, and asking git there
    // fails into the synthetic fallback below -- binding every session in the
    // repo to a container directory that holds no task files at all.
    const worktrees = (await cached('wt:' + p.commonDir, at, () => worktreesOf(p.worktreeRoot)))
      ?? [{ path: p.worktreeRoot, branch: null, head: null, detached: false, locked: false, isMain: true }]
    // The key IS the common dir, because it is stable in both layouts and
    // unique per repo; the DISPLAY root is the first real worktree, because in
    // the bare layout there is no main checkout for it to be.
    const mainRoot = worktrees.find((w) => w.isMain)?.path ?? p.worktreeRoot
    byKey.set(p.commonDir, {
      key: p.commonDir, name: basename(mainRoot) || mainRoot, isGit: true,
      mainRoot, worktrees,
    })
  }
  return [...byKey.values()]
}
