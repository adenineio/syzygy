// Landing: where a received drop's files are placed on the local disk. Every
// path written here comes out of `sanitizeLandingPath`, never straight off
// the wire, and every write is made the same way: a directory is created one
// segment at a time and an existing segment is accepted only when it is a real
// directory rather than a link to one, and a file is created exclusively
// without following a link, so nothing already on disk is truncated or
// written through.
//
// A received drop moves through three places, all under the world dir:
// `peer-quarantine/<peer>/<dropId>/files/<index>`, where the transport left
// each verified file under its position in the offer; `.../in/<landing
// path>`, the tree the receive filter reads; and `peer-inbox/<peer>/<dropId>/`,
// where it lands. The inbox directory appears in one rename of a scratch
// directory beside it, so it never holds half a drop.

import { constants, realpathSync, statSync } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, posix } from 'node:path'
import { sanitizeLandingPath, validName } from './peer.mjs'

export const QUARANTINE_DIR = 'peer-quarantine'
export const INBOX_DIR = 'peer-inbox'
export const LANDING_PREFIX = '.landing-'

const DROP_ID_RE = /^[0-9a-f]{16,64}$/
const HEX64_RE = /^[0-9a-f]{64}$/
const READ_BYTES = 1024 * 1024
const REFUSED_PATH_MAX = 300
const CREATE_FLAGS = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW
// O_NONBLOCK lets a fifo left where a file was expected open at once and be
// refused, rather than hang waiting for a writer. A regular file ignores it.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

export const REFUSED_LANDING_PATH = 'not a landing path this relay accepts: absolute, outside the drop, inside .git, or not a plain relative path'

const namesOk = (dir, peer, dropId) =>
  typeof dir === 'string' && isAbsolute(dir) && validName(peer) && typeof dropId === 'string' && DROP_ID_RE.test(dropId)

const parentOf = (rel) => {
  const d = posix.dirname(rel)
  return d === '.' ? '' : d
}

/** The one drop's inbox directory, or null when either name could not be a
 *  directory name here. */
export const inboxPathOf = (dir, peer, dropId) => (namesOk(dir, peer, dropId) ? join(dir, INBOX_DIR, peer, dropId) : null)

/** True when `path` is a real directory, never a link to one; with `create`,
 *  made first when nothing is there. */
const plainDir = async (path, { create = false } = {}) => {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }) } catch (err) { if (err?.code !== 'EEXIST') return false }
  }
  const st = await lstat(path).catch(() => null)
  return !!st && st.isDirectory()
}

/** Creates the directories of `rel` under `base` one segment at a time. A
 *  segment already there must be a real directory: a link, a file or anything
 *  else on the way throws, naming the segment. */
export const makeDirs = async (base, rel, mode = 0o700) => {
  let at = base
  const segs = rel === '' ? [] : rel.split('/')
  for (let i = 0; i < segs.length; i++) {
    at = join(at, segs[i])
    try {
      await mkdir(at, { mode })
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      const st = await lstat(at)
      if (!st.isDirectory()) throw Object.assign(new Error(`${segs.slice(0, i + 1).join('/')} is a link or a file, not a directory`), { code: 'ENOTPLAINDIR' })
    }
  }
}

/** The size and sha256 of the regular file at `file`, reached without
 *  following a link at its last segment, or null. Streamed, never read whole. */
export const digestAt = async (file) => {
  let fh
  try { fh = await open(file, READ_FLAGS) } catch { return null }
  try {
    if (!(await fh.stat()).isFile()) return null
    const h = createHash('sha256')
    const buf = Buffer.allocUnsafe(READ_BYTES)
    let size = 0
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, READ_BYTES, size)
      if (bytesRead === 0) break
      h.update(buf.subarray(0, bytesRead))
      size += bytesRead
    }
    return { size, sha256: h.digest('hex') }
  } finally {
    await fh.close()
  }
}

/** Copies the regular file at `src` to `dest`, which must not exist: opened
 *  without following a link at either end, and created exclusively, so an
 *  existing file, or a link in its place, is an error and never a write. A
 *  copy that fails part way removes the file it created. Answers the sha256 of
 *  the bytes written. */
export const copyExclusive = async (src, dest, mode) => {
  const from = await open(src, READ_FLAGS)
  try {
    if (!(await from.stat()).isFile()) throw new Error('not a regular file')
    const to = await open(dest, CREATE_FLAGS, mode)
    const h = createHash('sha256')
    try {
      const buf = Buffer.allocUnsafe(READ_BYTES)
      for (let pos = 0; ;) {
        const { bytesRead } = await from.read(buf, 0, READ_BYTES, pos)
        if (bytesRead === 0) break
        for (let off = 0; off < bytesRead;) {
          const { bytesWritten } = await to.write(buf, off, bytesRead - off)
          off += bytesWritten
        }
        h.update(buf.subarray(0, bytesRead))
        pos += bytesRead
      }
    } catch (err) {
      await to.close().catch(() => {})
      await rm(dest, { force: true }).catch(() => {})
      throw err
    }
    await to.close()
    return h.digest('hex')
  } finally {
    await from.close()
  }
}

/** Why two landing paths cannot both be written, or null: the same file
 *  twice, or a file that is also a directory above another. Compared without
 *  case, since on a disk that ignores case the two would be one file. */
export const landingClash = (rows) => {
  const seen = new Map()
  for (const r of rows) {
    const key = r.path.toLowerCase()
    if (seen.has(key)) return `two files in the drop would both land at ${r.path}`
    seen.set(key, r.path)
  }
  for (const r of rows) {
    const segs = r.path.toLowerCase().split('/')
    for (let k = 1; k < segs.length; k++) {
      const above = segs.slice(0, k).join('/')
      if (seen.has(above)) return `${seen.get(above)} is a file in the drop and also a directory above ${r.path}`
    }
  }
  return null
}

const clipPath = (p) => (typeof p === 'string' ? p.slice(0, REFUSED_PATH_MAX) : null)

/** Lays a verified drop out for the receive filter: each `files/<index>` in
 *  its quarantine copied to `in/<landing path>`, with `in/` and `out/` cleared
 *  first so a second run starts from the same tree. A row whose path this
 *  machine does not accept is left out and named in `dropped`; files that
 *  would land on each other, or no file left at all, refuse the whole drop.
 *
 *  Answers `{ rows, dropped }` with the laid-out rows in offer order, `{
 *  refuse, dropped }`, or `{ stopped: true }` when `stopped()` turned true on
 *  the way. Throws when the quarantine is not a plain directory or no longer
 *  holds what was verified. */
export const layOut = async ({ dir, peer, dropId, rows, stopped = () => false }) => {
  if (!namesOk(dir, peer, dropId)) throw new Error('this drop cannot name a directory here')
  const dropped = []
  const laid = []
  for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const path = sanitizeLandingPath(row?.path)
    if (path === null) dropped.push({ path: clipPath(row?.path), reason: REFUSED_LANDING_PATH })
    else laid.push({ index, row: { path, size: row.size, sha256: row.sha256, mode: row.mode } })
  }
  const clash = landingClash(laid.map((l) => l.row))
  if (clash) return { refuse: clash, dropped }
  if (laid.length === 0) return { refuse: 'no file in the drop has a path this relay lands a file at', dropped }

  const base = join(dir, QUARANTINE_DIR, peer, dropId)
  for (const p of [join(dir, QUARANTINE_DIR), join(dir, QUARANTINE_DIR, peer), base, join(base, 'files')]) {
    if (!(await plainDir(p))) throw new Error("the drop's quarantine is not a plain directory")
  }
  const inDir = join(base, 'in')
  await rm(inDir, { recursive: true, force: true })
  await rm(join(base, 'out'), { recursive: true, force: true })
  await mkdir(inDir, { mode: 0o700 })
  for (const { index, row } of laid) {
    if (stopped()) return { stopped: true }
    await makeDirs(inDir, parentOf(row.path))
    let sha
    try {
      sha = await copyExclusive(join(base, 'files', String(index)), join(inDir, row.path), 0o600)
    } catch (err) {
      throw new Error(`${row.path} could not be laid out (${err?.code ?? err?.message ?? 'error'})`)
    }
    if (sha !== row.sha256) throw new Error(`the quarantined copy of ${row.path} no longer matches its sha256`)
  }
  return { rows: laid.map((l) => l.row), dropped }
}

/** True when `root` holds exactly `rows` and nothing else: every row a
 *  regular file of its sha256, no other file, and no link or special file
 *  anywhere below. */
const holdsExactly = async (root, rows) => {
  const want = new Map(rows.map((r) => [r.path, r]))
  const found = []
  const walk = async (rel) => {
    for (const ent of await readdir(rel ? join(root, rel) : root, { withFileTypes: true })) {
      const child = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) { if (!(await walk(child))) return false } else if (ent.isFile()) found.push(child)
      else return false
    }
    return true
  }
  try { if (!(await walk(''))) return false } catch { return false }
  if (found.length !== want.size) return false
  for (const p of found) {
    const r = want.get(p)
    const d = r ? await digestAt(join(root, p)) : null
    if (!d || d.sha256 !== r.sha256 || d.size !== r.size) return false
  }
  return true
}

/** Lands `rows`, read from `srcDir` by their paths, at
 *  `<dir>/peer-inbox/<peer>/<dropId>/`. Every file is written into
 *  `.landing-<dropId>` beside it and checked against its row's size and
 *  sha256 once written; only then is that whole directory renamed into place.
 *
 *  Answers `{ inboxPath, recovered }`, where `recovered` means an inbox
 *  directory holding exactly these files was already there -- a landing whose
 *  rename finished before the relay could record it -- or `{ stopped: true }`.
 *  Every other case throws with the reason: an inbox or peer directory that is
 *  a link, a scratch directory already present, a file to land reached through
 *  a link or not matching its row, or a different inbox directory for this
 *  drop already there. A scratch directory this call made never outlives it
 *  unless the rename carried it into place. */
export const landDrop = async ({ dir, peer, dropId, srcDir, rows, stopped = () => false }) => {
  if (!namesOk(dir, peer, dropId)) throw new Error('this drop cannot name a directory here')
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('there is nothing to land')
  for (const r of rows) {
    if (sanitizeLandingPath(r?.path) !== r?.path || !Number.isSafeInteger(r.size) || typeof r.sha256 !== 'string' || !HEX64_RE.test(r.sha256)) {
      throw new Error('a row to land is malformed')
    }
  }
  const clash = landingClash(rows)
  if (clash) throw new Error(clash)
  let realSrc
  try { realSrc = realpathSync(srcDir) } catch { throw new Error('the files to land are missing') }

  const peerDir = join(dir, INBOX_DIR, peer)
  if (!(await plainDir(join(dir, INBOX_DIR), { create: true })) || !(await plainDir(peerDir, { create: true }))) {
    throw new Error("this peer's inbox is not a plain directory")
  }
  const scratch = join(peerDir, LANDING_PREFIX + dropId)
  const target = join(peerDir, dropId)
  try {
    await mkdir(scratch, { mode: 0o700 })
  } catch (err) {
    throw new Error(err?.code === 'EEXIST' ? 'a landing directory for this drop is already there' : `the landing directory could not be made (${err?.code ?? 'error'})`)
  }
  let keep = false
  try {
    for (const row of rows) {
      if (stopped()) return { stopped: true }
      const src = join(srcDir, row.path)
      let real = null
      try { real = realpathSync(src) } catch {}
      if (real !== join(realSrc, row.path)) throw new Error(`${row.path} is missing, or reached through a link`)
      await makeDirs(scratch, parentOf(row.path))
      const dest = join(scratch, row.path)
      try {
        await copyExclusive(src, dest, 0o600)
      } catch (err) {
        throw new Error(`${row.path} could not be landed (${err?.code ?? err?.message ?? 'error'})`)
      }
      const d = await digestAt(dest)
      if (!d || d.size !== row.size || d.sha256 !== row.sha256) throw new Error(`${row.path} did not land as it was checked`)
    }
    const there = await lstat(target).catch(() => null)
    if (there) {
      if (there.isDirectory() && (await holdsExactly(target, rows))) return { inboxPath: target, recovered: true }
      throw new Error('an inbox directory for this drop already exists')
    }
    await rename(scratch, target)
    keep = true
    return { inboxPath: target, recovered: false }
  } finally {
    if (!keep) await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

// ---- copy-into ----------------------------------------------------------------

/** Equal to `root`, or below it by a whole segment. */
const within = (p, root) => p === root || p.startsWith(root === '/' ? '/' : root + '/')
const realOrNull = (p) => {
  try { return realpathSync(p) } catch { return null }
}

/** Where a person may copy a landed drop: an absolute path resolving to an
 *  existing directory inside one of `roots`, and outside this relay's own
 *  data directory -- the inbox above all. Answers `{ dest }`, resolved, or
 *  `{ error }`. */
export const copyDestination = ({ dir, dest, roots }) => {
  if (typeof dest !== 'string' || !isAbsolute(dest)) return { error: 'dest must be an absolute path' }
  const real = realOrNull(dest)
  if (real === null) return { error: 'dest does not exist' }
  let st = null
  try { st = statSync(real) } catch {}
  if (!st?.isDirectory()) return { error: 'dest is not a directory' }
  const known = (Array.isArray(roots) ? roots : []).filter((r) => typeof r === 'string' && isAbsolute(r)).map(realOrNull)
  if (!known.some((r) => r !== null && within(real, r))) return { error: 'dest is outside every known worktree root' }
  const inbox = realOrNull(join(dir, INBOX_DIR))
  if (inbox && within(real, inbox)) return { error: 'dest is inside the inbox itself' }
  const world = realOrNull(dir)
  if (world && within(real, world)) return { error: "dest is inside this relay's own data directory" }
  return { dest: real }
}

/** Copies a landed drop's `rows` from its inbox directory under `dest`,
 *  keeping their layout. Each directory on the way is made one segment at a
 *  time and each file created exclusively without following a link, so a
 *  file already at a destination path is skipped and named, never
 *  overwritten; so is a row whose directory on the way is a link or a file,
 *  and a landed copy that no longer matches its sha256. Answers `{ copied,
 *  skipped }`, or `{ error }` when nothing may be copied at all. */
export const copyLanded = async ({ dir, peer, dropId, rows, dest, roots }) => {
  const inbox = inboxPathOf(dir, peer, dropId)
  if (!inbox) return { error: 'this drop cannot name a directory here' }
  const where = copyDestination({ dir, dest, roots })
  if (where.error || !where.dest) return { error: where.error ?? 'dest may not be written' }
  for (const p of [join(dir, INBOX_DIR), join(dir, INBOX_DIR, peer), inbox]) {
    if (!(await plainDir(p))) return { error: "the drop's inbox directory is missing or not a plain directory" }
  }
  const realInbox = realOrNull(inbox)
  if (realInbox === null) return { error: "the drop's inbox directory is missing" }
  const copied = []
  const skipped = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const rel = sanitizeLandingPath(row?.path)
    if (rel === null || rel !== row.path) { skipped.push({ path: clipPath(row?.path), reason: REFUSED_LANDING_PATH }); continue }
    const src = join(inbox, rel)
    if (realOrNull(src) !== join(realInbox, rel)) { skipped.push({ path: rel, reason: 'it is missing from the inbox, or reached through a link there' }); continue }
    try {
      await makeDirs(where.dest, parentOf(rel), 0o755)
    } catch (err) {
      skipped.push({ path: rel, reason: err?.code === 'ENOTPLAINDIR' ? err.message : `its directory could not be made (${err?.code ?? 'error'})` })
      continue
    }
    const to = join(where.dest, rel)
    let sha
    try {
      sha = await copyExclusive(src, to, 0o644)
    } catch (err) {
      skipped.push({ path: rel, reason: err?.code === 'EEXIST' ? 'a file is already there' : `it could not be copied (${err?.code ?? 'error'})` })
      continue
    }
    if (sha !== row.sha256) {
      await rm(to, { force: true })
      skipped.push({ path: rel, reason: 'the landed copy no longer matches its sha256' })
      continue
    }
    copied.push(rel)
  }
  return { copied, skipped }
}

/** Removes one drop's scratch directory, `<dir>/peer-inbox/<peer>/.landing-<dropId>`,
 *  and nothing else: a link in its place is removed as a link. Both names are
 *  held to their patterns first, and the two directories above it must be
 *  real directories, so a link planted in either is never walked through.
 *  Answers false, touching nothing, for anything else; true once it is gone,
 *  including when there was nothing to remove. */
export const removeLandingScratch = async ({ dir, peer, dropId } = {}) => {
  if (!namesOk(dir, peer, dropId)) return false
  for (const above of [join(dir, INBOX_DIR), join(dir, INBOX_DIR, peer)]) {
    const st = await lstat(above).catch(() => null)
    if (!st) return true
    if (!st.isDirectory()) return false
  }
  await rm(join(dir, INBOX_DIR, peer, LANDING_PREFIX + dropId), { recursive: true, force: true })
  return true
}
