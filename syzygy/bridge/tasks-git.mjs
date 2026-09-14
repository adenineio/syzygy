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

// Keyed by commonDir: { key, value, until }. `key` is the heads string the
// value was built for, so a clean graph is served until a worktree head
// moves rather than on a fixed TTL -- a short TTL would re-run a batch of
// subprocesses on every scan on a machine with many worktrees of one repo,
// forever, for a graph that had not changed. A build where a git call
// failed gets a short `until` instead, so one bad timeout cannot freeze a
// branch empty until its next commit.
const graphCache = new Map()

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

export const resetCache = () => { cache.clear(); graphCache.clear() }

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

export const GRAPH_COMMITS_PER_BRANCH = 30
export const GRAPH_BRANCHES_PER_PROJECT = 20
export const GRAPH_SUBJECT_MAX = 120
export const GRAPH_RETRY_MS = 60_000

const US = '\x1f'

/** The recompute gate. Every worktree's (branch, head) sorted into one
 *  string: history can only have changed if one of them moved, so between
 *  commits the scan pays nothing at all. */
export const headsKey = (commonDir, worktrees) =>
  commonDir + '|' + (worktrees ?? [])
    .map((w) => (w.branch || '(detached)') + '@' + (w.head || ''))
    .sort()
    .join(',')

const parseLog = (out) => {
  const rows = []
  for (const line of String(out).split('\n')) {
    if (!line) continue
    const [sha, parents, subject, at] = line.split(US)
    if (!sha) continue
    rows.push({
      sha,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      subject: String(subject ?? '').slice(0, GRAPH_SUBJECT_MAX),
      at: Number(at) * 1000 || 0,
    })
  }
  return rows
}

/** Commit history per branch, for the Projects tab's Graph panel and the
 *  sandbox's line graph. Bounded three ways and recomputed only when a head
 *  moves. Every failure is `null` -- never a throw, and never a stale graph
 *  belonging to a different project, which is why the cache is keyed by the
 *  common dir and validated against the heads it was built for. A build in
 *  which any git call itself failed is still cached, but only briefly, so a
 *  single bad subprocess cannot pin a branch empty for good. */
export const graphOf = async (commonDir, worktrees, { now = Date.now } = {}) => {
  const list = worktrees ?? []
  const main = list.find((w) => w.isMain) ?? list[0]
  if (!main?.path) return null

  const key = headsKey(commonDir, list)
  const hit = graphCache.get(commonDir)
  if (hit && hit.key === key && now() < hit.until) return hit.value

  const names = []
  for (const w of list) {
    if (!w.branch) continue          // detached: no ref to log
    if (!names.includes(w.branch)) names.push(w.branch)
  }
  // Main first, so the panel's first row is the one everything else is
  // measured against.
  const base = main.branch || null
  if (base) names.sort((a, b) => (a === base ? -1 : b === base ? 1 : 0))
  const kept = names.slice(0, GRAPH_BRANCHES_PER_PROJECT)
  const droppedBranches = names.length - kept.length

  const branches = []
  let cut = false
  let failed = false
  for (const name of kept) {
    const out = await git(
      ['log', '--no-color', `--format=%H${US}%P${US}%s${US}%at`,
       '-n', String(GRAPH_COMMITS_PER_BRANCH + 1), name, '--'],
      main.path,
    )
    if (out === null) failed = true
    // A branch git will not log is reported as an empty branch rather than
    // dropped: the worktree exists, and a missing row would read as a
    // worktree that is not there.
    const rows = out === null ? [] : parseLog(out)
    const truncated = rows.length > GRAPH_COMMITS_PER_BRANCH
    if (truncated) cut = true
    let ahead = null, behind = null
    if (base && name !== base) {
      const counts = await git(['rev-list', '--left-right', '--count', `${base}...${name}`], main.path)
      if (counts === null) failed = true
      if (counts) {
        const [b, a] = counts.trim().split(/\s+/).map(Number)
        if (Number.isFinite(b) && Number.isFinite(a)) { behind = b; ahead = a }
      }
    } else if (base && name === base) {
      ahead = 0; behind = 0
    }
    branches.push({
      name,
      head: list.find((w) => w.branch === name)?.head ?? (rows[0]?.sha.slice(0, 7) ?? ''),
      isMain: name === base,
      ahead, behind,
      commits: rows.slice(0, GRAPH_COMMITS_PER_BRANCH),
      truncated,
    })
  }

  // No branch at all (every worktree detached, or a bare repo) is not a
  // failure -- it is a project with nothing to draw. `null` is reserved for
  // "the question could not be asked".
  const value = { base, branches, builtAt: now(), truncated: cut || droppedBranches > 0 }
  graphCache.set(commonDir, { key, value, until: failed ? now() + GRAPH_RETRY_MS : Infinity })
  return value
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
