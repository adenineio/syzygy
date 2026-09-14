// The drop engine: the real filesystem adapter `expandDropPaths` walks with,
// staging -- the copy of a drop's files that every later step reads instead
// of the originals -- and `createDrops`, the factory that turns a validated
// path list into a job on disk, runs the user's own filter script over it, and
// moves the filtered bytes to the other side, where they wait in quarantine
// until that side's own filter has run over them and they land in its inbox.
// Where a received file may be placed is peer-landing.mjs's to decide.
//
// A drop is staged by COPY, never read in place. Filtering a drop may take
// minutes, and the session that made the files keeps working the whole time;
// a drop streamed from the originals would send bytes that changed under it,
// with a checksum that no longer matched them. So each file is copied once to
// `<dir>/peer-staging/<dropId>/in/<relative path>`, and the sha256 on its row
// is taken from that copy on disk, never from the source.
//
// Selection and the copy are two different moments, so the copy checks again
// what it opens: a source is opened without following a link, and must still
// be the regular file an lstat just saw, or the whole stage is refused. A
// stage that copied some files and quietly skipped others would be a drop
// that sent half of what was chosen.
//
// The filter is `<dir>/peer-filter`, when it exists and is executable: one
// well-known path, never one a setting or a peer can name. It reads the
// manifest on stdin, writes what should leave into `--out` and prints the
// amended manifest. Nothing it says about a file is trusted: the relay takes
// only what it finds as a regular file under `--out`, and hashes each one
// itself. Any non-zero exit refuses the drop, because a script that crashed
// and a script that said no both mean the bytes must not move.

import { accessSync, existsSync, lstatSync, readdirSync, realpathSync, statSync, constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import {
  DROP_BYTE_CAP, DROP_FILE_CAP, FILTER_KILL_GRACE_MS, FILTER_STDERR_MAX, FILTER_TIMEOUT_MS, JOB_EDGES,
  expandDropPaths, filterArgv, filterManifest, filterOutPath, isTerminalJob, readFilterManifest, validName,
} from './peer.mjs'
import { childEnv } from './canvas.mjs'
import {
  INBOX_DIR, LANDING_PREFIX, QUARANTINE_DIR, REFUSED_LANDING_PATH,
  copyLanded, inboxPathOf, landDrop, landingClash, layOut, removeLandingScratch,
} from './peer-landing.mjs'
import { MAX_CHUNK_BODY, MAX_MANIFEST_BODY } from './peer-listener.mjs'

export const STAGING_DIR = 'peer-staging'
export { QUARANTINE_DIR }

/** A drop id becomes a directory name, so it is held to lowercase hex before
 *  it touches a path. */
const DROP_ID_RE = /^[0-9a-f]{16,64}$/
/** What staging reads at a time, and the most one pushed chunk or one pulled
 *  answer carries. */
export const CHUNK_BYTES = 1024 * 1024
const NUL = String.fromCharCode(0)

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---- the real filesystem, as expandDropPaths reads it -----------------------

/** lstat-based, so a symlink is reported as a symlink and never walked
 *  through. Every failure is `null`, which the walk turns into a refusal with
 *  a reason rather than a missing file. */
export const dropFs = Object.freeze({
  stat(p) {
    let st
    try { st = lstatSync(p) } catch { return null }
    if (st.isSymbolicLink()) return { symlink: true }
    if (st.isFile()) return { file: true, size: st.size, mode: st.mode & 0o777 }
    if (st.isDirectory()) return { dir: true }
    if (st.isSocket()) return { other: 'socket' }
    if (st.isFIFO()) return { other: 'fifo' }
    if (st.isBlockDevice() || st.isCharacterDevice()) return { other: 'device' }
    return { other: 'special file' }
  },
  readdir(p) {
    try { return readdirSync(p) } catch { return null }
  },
})

// ---- staging ----------------------------------------------------------------

const refusal = (path, reason) => Object.assign(new Error(`${path}: ${reason}`), { path, reason })

/** A relative path staging can place under `in/`: no leading slash, no empty,
 *  `.` or `..` segment, no NUL. */
const stageablePath = (p) =>
  typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.includes(NUL) &&
  !p.split('/').some((s) => s === '' || s === '.' || s === '..')

/** Positional reads from an open handle, so the same handle can be hashed and
 *  then copied without seeking. A chunk is only valid until the next is read. */
async function* chunksOf(fh) {
  const buf = Buffer.allocUnsafe(CHUNK_BYTES)
  let pos = 0
  for (;;) {
    const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, pos)
    if (bytesRead === 0) return
    pos += bytesRead
    yield buf.subarray(0, bytesRead)
  }
}

/** Streamed, never read whole: a drop may be two gigabytes. */
const hashOf = async (fh) => {
  const h = createHash('sha256')
  let size = 0
  for await (const chunk of chunksOf(fh)) {
    h.update(chunk)
    size += chunk.length
  }
  return { size, sha256: h.digest('hex') }
}

/** The size, hash and mode of what is actually on disk at `file`, or null
 *  when no regular file is there. */
const digestFile = async (file) => {
  let fh
  // O_NONBLOCK: a fifo left where a file was expected opens at once and is
  // refused, rather than hanging the read on a writer that never comes.
  try { fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch { return null }
  try {
    const st = await fh.stat()
    return st.isFile() ? { ...(await hashOf(fh)), mode: st.mode & 0o777 } : null
  } finally {
    await fh.close()
  }
}

/** Opened without following a link, and refused unless it is still the same
 *  regular file the lstat saw. O_NONBLOCK is there for a fifo swapped in
 *  between the two: it opens at once and is refused, rather than hanging the
 *  stage waiting for a writer. A regular file ignores the flag. */
const openSource = async (abs) => {
  const before = await lstat(abs).catch(() => null)
  if (!before) throw refusal(abs, 'no longer exists')
  if (before.isSymbolicLink()) throw refusal(abs, 'a symlink is never followed')
  if (!before.isFile()) throw refusal(abs, 'no longer a regular file')
  let fh
  try {
    fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    throw refusal(abs, err?.code === 'ELOOP' ? 'a symlink is never followed' : `could not be opened (${err?.code ?? 'error'})`)
  }
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev) throw refusal(abs, 'it changed while it was being staged')
    return { fh, st }
  } catch (err) {
    await fh.close()
    throw err
  }
}

/** The staged copy's digest when it already holds exactly the source's bytes:
 *  the same size, then the same sha256. Anything else is copied again. */
const alreadyStaged = async (fh, st, dest) => {
  const have = await lstat(dest).catch(() => null)
  if (!have?.isFile() || have.size !== st.size) return null
  const copy = await digestFile(dest)
  if (!copy || copy.size !== st.size) return null
  return (await hashOf(fh)).sha256 === copy.sha256 ? copy : null
}

/** The default copier: the open source into `dest`, which must not exist yet.
 *  Owner-only, since the manifest row carries the source's mode. */
export const copyHandle = async (src, dest) => {
  const out = await open(dest, 'wx', 0o600)
  try {
    for await (const chunk of chunksOf(src)) {
      for (let off = 0; off < chunk.length;) {
        const { bytesWritten } = await out.write(chunk, off, chunk.length - off)
        off += bytesWritten
      }
    }
  } finally {
    await out.close()
  }
}

/** Copies `files` (rows from `expandDropPaths`) under the drop's `in/`
 *  directory, creating it and its parents, and answers one manifest row per
 *  file, in order: `{ path, size, sha256, mode }`, the size and hash read back
 *  from the copy. A copy goes to `tmp/` first and is renamed into place, so an
 *  interrupted one never looks staged. Calling it again with the same drop id
 *  copies only what is missing or differs, which is what lets a relay that
 *  died mid-stage simply stage again.
 *
 *  Any file that cannot be staged safely rejects the whole call with an error
 *  carrying `path` and `reason`; the staged set is either every chosen file
 *  or not a drop. `copy(handle, dest)` is injectable; it receives the source
 *  already opened and checked. */
export const stageDrop = async ({ dir, dropId, files, copy = copyHandle, byteCap = DROP_BYTE_CAP } = {}) => {
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Error('stageDrop: dir must be an absolute path')
  if (typeof dropId !== 'string' || !DROP_ID_RE.test(dropId)) throw new Error('stageDrop: not a drop id')
  if (!Array.isArray(files)) throw new Error('stageDrop: files must be an array')
  const cap = Number.isSafeInteger(byteCap) && byteCap >= 0 ? byteCap : DROP_BYTE_CAP

  const seen = new Set()
  for (const f of files) {
    if (!isPlainObject(f) || !stageablePath(f.path) || typeof f.abs !== 'string' || !isAbsolute(f.abs)) {
      throw refusal(isPlainObject(f) ? f.path : null, 'not a stageable file row')
    }
    if (seen.has(f.path)) throw refusal(f.path, 'two files would both stage here')
    seen.add(f.path)
  }

  const base = join(dir, STAGING_DIR, dropId)
  const inDir = join(base, 'in')
  const tmpDir = join(base, 'tmp')
  await mkdir(inDir, { recursive: true })
  await mkdir(tmpDir, { recursive: true })

  const rows = []
  let bytes = 0
  for (const f of files) {
    const dest = join(inDir, f.path)
    const { fh, st } = await openSource(f.abs)
    let staged
    try {
      staged = await alreadyStaged(fh, st, dest)
      if (!staged) {
        await mkdir(dirname(dest), { recursive: true })
        const part = join(tmpDir, randomBytes(8).toString('hex'))
        try {
          await copy(fh, part)
          await rename(part, dest)
        } catch (err) {
          await rm(part, { force: true })
          throw err
        }
        staged = await digestFile(dest)
        if (!staged) throw refusal(f.path, 'the staged copy could not be read back')
      }
    } finally {
      await fh.close()
    }
    // The cap is held again here: a file can grow between selection and copy.
    bytes += staged.size
    if (bytes > cap) throw refusal(f.path, `too large: more than ${cap} bytes, the byte cap for one drop`)
    rows.push({ path: f.path, size: staged.size, sha256: staged.sha256, mode: st.mode & 0o777 })
  }
  return rows
}

/** Removes one drop's staging area, `<dir>/peer-staging/<dropId>/`, and
 *  nothing else. The id is held to the drop id pattern before any path is
 *  built from it, and a link in its place is removed as a link, never
 *  followed. Answers false, touching nothing, for anything that is not a drop
 *  id under an absolute dir. */
export const removeStaging = async ({ dir, dropId } = {}) => {
  if (typeof dir !== 'string' || !isAbsolute(dir) || typeof dropId !== 'string' || !DROP_ID_RE.test(dropId)) return false
  await rm(join(dir, STAGING_DIR, dropId), { recursive: true, force: true })
  return true
}

/** Removes one received drop's quarantine, `<dir>/peer-quarantine/<peer>/<dropId>/`,
 *  and nothing else. Both names are held to their patterns before a path is
 *  built from them, and the two directories above the drop must be real
 *  directories, so a link planted in either is never walked through. Answers
 *  false, touching nothing, for anything else; true when the drop is gone,
 *  including when there was nothing to remove. */
export const removeQuarantine = async ({ dir, peer, dropId } = {}) => {
  if (typeof dir !== 'string' || !isAbsolute(dir) || !validName(peer) || typeof dropId !== 'string' || !DROP_ID_RE.test(dropId)) return false
  for (const above of [join(dir, QUARANTINE_DIR), join(dir, QUARANTINE_DIR, peer)]) {
    const st = await lstat(above).catch(() => null)
    if (!st) return true
    if (!st.isDirectory()) return false
  }
  await rm(join(dir, QUARANTINE_DIR, peer, dropId), { recursive: true, force: true })
  return true
}

/** Null when every recorded row of a finished stage is still exactly there
 *  under `inDir` -- a regular file, reached through no link, of the recorded
 *  size and sha256 -- or the reason naming the first one that is not. */
const verifyStaged = async (inDir, rows) => {
  const bad = (row) => `the staged copy of ${row.path} changed or is missing`
  if (!Array.isArray(rows) || rows.length === 0) return 'no staged files were recorded for this drop'
  let realIn
  try { realIn = realpathSync(inDir) } catch { return bad(rows[0]) }
  for (const row of rows) {
    if (!stageablePath(row.path) || typeof row.sha256 !== 'string') return bad(row)
    const abs = join(inDir, row.path)
    let real
    try { real = realpathSync(abs) } catch { return bad(row) }
    if (real !== join(realIn, row.path)) return bad(row)
    const d = await digestFile(abs)
    if (!d || d.size !== row.size || d.sha256 !== row.sha256) return bad(row)
  }
  return null
}

// ---- the engine ---------------------------------------------------------------

const JOBS_IN_PAYLOAD = 50
// How many rows of a job's own file list -- and of what it landed -- the
// payload carries; the rest is `fileCount`, a number rather than a list a
// pane would have to page through. Held low on purpose: at the file cap
// (2,000 rows) and a 200-byte path, 50 kept jobs at 50 rows apiece would
// still be over a megabyte on every broadcast, which is the failure this
// bound exists to prevent.
const JOB_FILES_IN_PAYLOAD = 5
const DAY_MS = 86_400_000
// How many refused rows a single POST answers with, or keeps on a job: a
// selection with hundreds of individually-refused paths still answers a
// small, useful body, and `refusedCount` says how many more there were.
const REFUSED_IN_REPLY = 50

const reply = (status, json) => ({ status, json })
const capRefused = (list) => (list.length <= REFUSED_IN_REPLY ? list : list.slice(0, REFUSED_IN_REPLY))
const sumBytes = (rows) => rows.reduce((n, f) => n + f.size, 0)
const errorText = (err) => String(err?.message ?? err).slice(0, 400)

// ---- the transport's pieces -------------------------------------------------------

const HEX64_RE = /^[0-9a-f]{64}$/
const DECIMAL_RE = /^(0|[1-9][0-9]{0,15})$/
const PATH_MAX_BYTES = 4096
const NOTE_MAX = 2000
const REASON_MAX = 2000
// A commit checks every file before it answers, which for a large drop is a
// long silence on the socket.
const COMMIT_TIMEOUT_MS = 5 * 60_000
// How many offer-or-commit passes one loop makes before leaving the rest to
// the next resume: the first, one for a file that failed its sha256 once,
// and a spare.
const ROUNDS = 3
const PROGRESS_BROADCAST_MS = 250
const DELTAS_MAX = 100
const DELTA_RECENT_MS = 3600_000
// A heartbeat's body also carries a roster and asks; the deltas never take
// more than half of it.
const DELTA_BUDGET = 128 * 1024
const SIDE_STATES = Object.freeze({
  send: Object.freeze([...Object.keys(JOB_EDGES.send), 'sent', 'refused', 'failed']),
  recv: Object.freeze([...Object.keys(JOB_EDGES.recv), 'landed', 'refused', 'failed']),
})
/** A receiver in any of these has every byte, verified. */
const DELIVERED = new Set(['verifying', 'filtering', 'landed'])
/** A receive job holding every byte verified, including one that went on to
 *  be refused or to fail after that: what it did with the bytes is its own
 *  record, and the sender's half is done either way. */
const deliveredHere = (e) => DELIVERED.has(e.state) || ((e.state === 'refused' || e.state === 'failed') && e.bytes > 0 && e.sent === e.bytes)

const sumValues = (obj) => Object.values(obj).reduce((n, v) => n + v, 0)
const decimal = (s) => (typeof s === 'string' && DECIMAL_RE.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null)

/** A chunk's query: `drop`, `file` and `offset`, each exactly once, and
 *  nothing else beside them. */
const chunkQueryOf = (query) => {
  if (typeof query !== 'string') return null
  const params = new URLSearchParams(query)
  if ([...params.keys()].sort().join('&') !== 'drop&file&offset') return null
  const dropId = params.get('drop')
  const file = decimal(params.get('file'))
  const offset = decimal(params.get('offset'))
  return DROP_ID_RE.test(dropId ?? '') && file !== null && offset !== null ? { dropId, file, offset } : null
}

/** An offered manifest row, held to exactly what a receiver can check: a path
 *  of at most 4096 bytes, a size, a lowercase sha256 and a mode. */
const offerRow = (f) =>
  isPlainObject(f) && typeof f.path === 'string' && f.path !== '' && Buffer.byteLength(f.path) <= PATH_MAX_BYTES &&
  Number.isSafeInteger(f.size) && f.size >= 0 && typeof f.sha256 === 'string' && HEX64_RE.test(f.sha256) && Number.isInteger(f.mode)
    ? { path: f.path, size: f.size, sha256: f.sha256, mode: f.mode & 0o777 }
    : null
const sameRows = (a, b) =>
  a.length === b.length && a.every((r, i) => r.path === b[i].path && r.size === b[i].size && r.sha256 === b[i].sha256 && r.mode === b[i].mode)
const wireRow = (f) => ({ path: f.path, size: f.size, sha256: f.sha256, mode: f.mode })

/** A reason from the other side, cut to at most 2 KB. */
const reasonText = (v) => {
  if (typeof v !== 'string' || v === '') return null
  let s = v.slice(0, REASON_MAX)
  while (Buffer.byteLength(s) > REASON_MAX) s = s.slice(0, -1)
  return s
}

/** Where file `idx` continues from by the receiver's `have`: anything that is
 *  not a length inside the file reads as the start, and the receiver's next
 *  answer puts it right. */
const offsetIn = (have, idx, size) => {
  const v = isPlainObject(have) ? have[idx] : undefined
  return Number.isSafeInteger(v) && v >= 0 && v <= size ? v : 0
}

/** The length of a partial file, or 0 when no regular file is there. */
const partLength = async (file) => {
  const st = await lstat(file).catch(() => null)
  return st?.isFile() ? st.size : 0
}

/** Appends `buf` to `file`, created owner-only and never through a link, and
 *  answers the file's length afterwards. */
const appendPart = async (file, buf) => {
  const fh = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    for (let off = 0; off < buf.length;) {
      const { bytesWritten } = await fh.write(buf, off, buf.length - off)
      off += bytesWritten
    }
    return (await fh.stat()).size
  } finally {
    await fh.close()
  }
}

/** Up to `length` bytes of `file` from `offset`, never through a link. Fewer
 *  come back only when the file ends first. */
const readPart = async (file, offset, length) => {
  const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await fh.stat()).isFile()) throw new Error('not a regular file')
    const buf = Buffer.alloc(length)
    let got = 0
    while (got < length) {
      const { bytesRead } = await fh.read(buf, got, length - got, offset + got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    return buf.subarray(0, got)
  } finally {
    await fh.close()
  }
}

// ---- the filter child -----------------------------------------------------------

export const FILTER_FILE = 'peer-filter'
// A filter's stdout is its manifest and is read whole, up to this much. A
// filter that prints more has not printed a manifest.
const FILTER_STDOUT_MAX = 8 * 1024 * 1024

const realSpawn = (bin, args, opts) => spawn(bin, args, opts)

const spellMs = (ms) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`)

/** An executable regular file, a link the user placed there followed. Anything
 *  else -- nothing, a directory, a file without the execute bit -- is no
 *  filter at all, which is the ordinary first-run state and not an error. */
const filterInstalled = (file) => {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** One filter child, start to end. Resolves, never rejects:
 *  `{ code, signal, stdout, stderr, killedFor, spawnError }`, where `stdout` is
 *  null past its cap and `stderr` is its first `FILTER_STDERR_MAX` bytes.
 *
 *  The clock is the filter's own timeout and nothing else. At it the child
 *  gets SIGTERM, and SIGKILL `graceMs` later if it is still there; `terminate`
 *  is handed to `onStart` so a stop or a cancel ends it the same way. A child
 *  that was killed is over when it exits -- a grandchild still holding its
 *  pipes open is not waited for. */
const runChild = ({ run, argv, input, cwd, timeoutMs, graceMs, onStart }) => new Promise((resolve) => {
  let child
  try {
    child = run(argv[0], argv.slice(1), { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    resolve({ code: null, signal: null, stdout: '', stderr: '', killedFor: null, spawnError: String(err?.message ?? err) })
    return
  }
  const out = []
  const errs = []
  let outBytes = 0
  let errBytes = 0
  let code = null
  let signal = null
  let exited = false
  let done = false
  let killedFor = null
  let spawnError = null
  let deadline = null
  let grace = null

  const finish = () => {
    if (done) return
    done = true
    clearTimeout(deadline)
    clearTimeout(grace)
    child.stdout?.destroy()
    child.stderr?.destroy()
    resolve({
      code, signal, killedFor, spawnError,
      stdout: outBytes > FILTER_STDOUT_MAX ? null : Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(errs).subarray(0, FILTER_STDERR_MAX).toString('utf8'),
    })
  }
  const terminate = (why) => {
    if (done || killedFor) return
    killedFor = why
    if (exited) { finish(); return }
    try { child.kill('SIGTERM') } catch {}
    grace = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, graceMs)
  }

  child.stdout?.on('data', (c) => {
    outBytes += c.length
    if (outBytes <= FILTER_STDOUT_MAX) out.push(c)
    else out.length = 0
  })
  child.stderr?.on('data', (c) => {
    if (errBytes < FILTER_STDERR_MAX) errs.push(c)
    errBytes += c.length
  })
  // A filter that exits without reading its manifest closes the pipe under the write.
  child.stdin?.on('error', () => {})
  child.on('error', (err) => {
    // Only a child that never started ends here; a kill that failed is not an end.
    if (child.pid !== undefined) return
    spawnError = String(err?.message ?? err)
    finish()
  })
  child.on('exit', (c, s) => {
    exited = true
    code = c
    signal = s
    if (killedFor) finish()
  })
  child.on('close', finish)
  deadline = setTimeout(() => terminate('timeout'), timeoutMs)
  onStart?.(terminate)
  child.stdin?.end(input)
})

/** The send side of one drop: validates and expands the paths, creates the
 *  job and flushes it before any await, then stages by copy and filters off
 *  the request.
 *  `paths` is re-resolved with `realpath` here -- the caller may hand a path
 *  that no longer exists, or a symlink one segment of which changed -- and a
 *  path that does not resolve is refused the same way `expandDropPaths`
 *  refuses one.
 *
 *  A refusal is either about ONE path or about the WHOLE input, and the two
 *  are handled oppositely. A path refused for itself -- it does not resolve,
 *  it lies outside every known root, it is the wrong kind, it is inside
 *  `.git` -- is dropped, and the drop goes on without it: its `{path,
 *  reason}` rides both the success answer and the job's own `refusedPaths`.
 *  A refusal of the WHOLE input -- over the file cap, over the byte cap, or a
 *  staging-path collision -- refuses the whole drop instead and creates no
 *  job: truncating it would send only part of what was asked for, silently.
 *  If every path is refused there is nothing left to send, which is a whole
 *  refusal too.
 *
 *  `peerOf(name)` answers `{ confirmed, dials }` for a known peer, or null,
 *  and `dial({ peer, path, query, body, rawBody, rawResponse, maxResponse,
 *  timeoutMs })` makes one signed, pinned request to it and answers the way
 *  `dialPeer` does. Neither ever hands this engine a secret or a certificate.
 *  `chunkBytes` may only be smaller than `CHUNK_BYTES`. */
export const createDrops = ({
  dir, jobs, now = Date.now, log = () => {}, broadcast = () => {}, roots = () => [],
  run = realSpawn,
  filterPath = typeof dir === 'string' ? join(dir, FILTER_FILE) : null,
  filterTimeoutMs = FILTER_TIMEOUT_MS,
  killGraceMs = FILTER_KILL_GRACE_MS,
  fileCap = DROP_FILE_CAP,
  byteCap = DROP_BYTE_CAP,
  peerOf = () => null,
  dial = null,
  chunkBytes = CHUNK_BYTES,
} = {}) => {
  // One filter child at a time on this side: every run waits its turn here,
  // in the order it asked.
  let queue = Promise.resolve()
  let stopped = false
  /** @type {{ jobId: string | null, terminate: (why: string) => void } | null} */
  let current = null

  const serial = (fn) => {
    const p = queue.then(fn)
    queue = p.catch(() => {})
    return p
  }
  const stagingOf = (dropId) => join(dir, STAGING_DIR, dropId)
  /** The job a run was for has ended already -- a cancel reached it while it
   *  waited its turn. A dry run has no job. */
  const ended = (job) => typeof job?.id === 'string' && isTerminalJob(jobs.get(job.id)?.state ?? 'failed')

  /** A flush that runs after the request has gone has nobody to answer, so a
   *  failure is logged rather than thrown into nothing. */
  const save = () => {
    let flushed = true
    try {
      jobs.flush()
    } catch (err) {
      flushed = false
      log(`could not save the drop jobs: ${err?.message ?? err}`)
    }
    broadcast()
    return flushed
  }

  /** A job that has ended keeps no copy of its bytes, once that end is on
   *  disk: a send job that was sent, refused or failed loses its staged copy,
   *  and a receive job that was refused, failed or landed loses its quarantine
   *  and any landing scratch. A landed job's quarantine goes only once the
   *  store is flushed, since until then a restart lands it again from there.
   *  Not while a filter child is still reading the copy -- the run that ends
   *  it removes the copy after the child is gone. */
  const cleanupEnded = async (id) => {
    const e = jobs.get(id)
    if (!e) return
    try {
      if (e.side === 'send' && (e.state === 'sent' || e.state === 'refused' || e.state === 'failed')) {
        if (current && current.jobId === id) return
        await removeStaging({ dir, dropId: e.dropId })
      } else if (e.side === 'recv' && (e.state === 'refused' || e.state === 'failed' || (e.state === 'landed' && !jobs.dirty))) {
        if (current && current.jobId === id) return
        await removeQuarantine({ dir, peer: e.peer, dropId: e.dropId })
        await removeLandingScratch({ dir, peer: e.peer, dropId: e.dropId })
      }
    } catch (err) {
      log(`could not remove the copy of drop ${e.dropId}: ${err?.message ?? err}`)
    }
  }

  const failJob = async (id, error) => {
    const e = jobs.get(id)
    if (!e) return
    if (!isTerminalJob(e.state)) {
      try {
        jobs.transition(id, 'failed', { error, sources: [] })
      } catch (err) {
        log(`drop job ${id} could not be marked failed: ${err?.message ?? err}`)
        return
      }
      if (!save()) return
    }
    await cleanupEnded(id)
  }

  /** A staging refusal names the file by its path inside the drop, never by
   *  where it lives on the local disk. */
  const stageError = (err, sources) => {
    if (typeof err?.reason !== 'string') return errorText(err)
    const row = sources.find((s) => s.abs === err.path || s.path === err.path)
    return (row ? `${row.path}: ${err.reason}` : err.reason).slice(0, 400)
  }

  /** The paths a drop or a dry run was handed, resolved, walked and held to
   *  both caps: `{ files, refused }`, or `{ reply }` when nothing may go. */
  function select(paths) {
    if (!Array.isArray(paths) || paths.length === 0) return { reply: reply(400, { error: 'paths must be a non-empty array' }) }

    const resolved = []
    const dropped = []
    for (const p of paths) {
      if (typeof p !== 'string' || p === '') { dropped.push({ path: typeof p === 'string' ? p : null, reason: 'not a path' }); continue }
      try {
        resolved.push(realpathSync(p))
      } catch {
        dropped.push({ path: p, reason: 'does not resolve' })
      }
    }
    const expanded = expandDropPaths(resolved, { roots: roots(), ...dropFs, fileCap, byteCap })

    const wholeRefusal = expanded.refused.find((r) => r.whole)
    if (wholeRefusal) return { reply: reply(400, { error: 'the drop was refused', refused: [{ path: wholeRefusal.path, reason: wholeRefusal.reason }] }) }

    const refused = [...dropped, ...expanded.refused]
    if (expanded.files.length === 0) return { reply: reply(400, { error: 'every path was refused; nothing to drop', refused: capRefused(refused) }) }
    return { files: expanded.files, refused }
  }

  /** Runs the filter over `inDir` into `outDir` for either side of a drop and
   *  answers what it decided; the caller moves its own job. `job` supplies the
   *  peer, the drop id, the note and the manifest rows of `inDir`. `outDir` is
   *  emptied first, so a run after a crash starts clean.
   *
   *  `outcome` is `accept` (with `files`, `bytes` and the `manifest` that
   *  would go), `refuse` (with `reason`), `fail` (with `error`), or `stopped` /
   *  `cancelled` when this side ended the child itself, or the job had ended
   *  before its turn -- a job in either of those is not this run's to move. */
  function runFilter({ job, direction, inDir, outDir }) {
    return serial(async () => {
      if (stopped) return { outcome: 'stopped' }
      if (ended(job)) return { outcome: 'cancelled' }
      const rows = Array.isArray(job?.files) ? job.files : []
      const manifestOf = (files) => filterManifest({ direction, peer: job.peer, dropId: job.dropId, note: job.note, files })
      if (!filterInstalled(filterPath)) {
        return { ok: true, outcome: 'accept', filtered: false, filterReason: 'no filter', files: rows, bytes: sumBytes(rows), dropped: [], manifest: manifestOf(rows), stderr: '' }
      }

      await rm(outDir, { recursive: true, force: true })
      await mkdir(outDir, { recursive: true })
      const realOut = realpathSync(outDir)
      if (stopped) return { outcome: 'stopped' }
      if (ended(job)) return { outcome: 'cancelled' }
      const res = await runChild({
        run,
        argv: filterArgv({ filterPath, direction, peer: job.peer, dropId: job.dropId, inDir, outDir }),
        input: JSON.stringify(manifestOf(rows)),
        cwd: dirname(outDir),
        timeoutMs: filterTimeoutMs,
        graceMs: killGraceMs,
        onStart: (terminate) => { current = { jobId: job.id ?? null, terminate } },
      })
      current = null

      const ran = { filtered: true, filterReason: null, stderr: res.stderr }
      if (res.killedFor === 'stop') return { outcome: 'stopped', ...ran }
      if (res.killedFor === 'cancel') return { outcome: 'cancelled', ...ran }
      if (res.killedFor === 'timeout') {
        return { ok: false, outcome: 'fail', ...ran, error: `timed out: the filter was still running after ${spellMs(filterTimeoutMs)}` }
      }
      const refuse = (reason) => ({ ok: false, outcome: 'refuse', ...ran, reason })
      if (res.spawnError !== null || res.code !== 0) {
        return refuse(res.stderr.trim() || (res.spawnError !== null ? `the filter could not be started: ${res.spawnError}`
          : res.signal ? `the filter was killed by ${res.signal}` : `the filter exited with code ${res.code}`))
      }

      const listed = readFilterManifest(res.stdout)
      if (!listed) return refuse('the filter printed no valid manifest')
      // A listed row that is not taken is named in `dropped` with why.
      const files = []
      const dropped = []
      const seen = new Set()
      for (const row of listed) {
        const rel = filterOutPath(row.path)
        if (rel === null) { dropped.push({ path: row.path.slice(0, 300), reason: REFUSED_LANDING_PATH }); continue }
        if (seen.has(rel)) continue
        const abs = join(outDir, rel)
        let real
        try { real = realpathSync(abs) } catch { dropped.push({ path: rel, reason: 'the filter listed it, but no file is there' }); continue }
        // The two agree only when no part of the path, `--out` itself
        // included, is a link.
        if (real !== join(realOut, rel)) { dropped.push({ path: rel, reason: 'the filter left it behind a link' }); continue }
        const d = await digestFile(abs)
        if (!d) { dropped.push({ path: rel, reason: 'the filter left something other than a regular file there' }); continue }
        seen.add(rel)
        files.push({ path: rel, size: d.size, sha256: d.sha256, mode: row.mode ?? d.mode })
        if (files.length > fileCap) return refuse(`too many files: more than ${fileCap}, the file cap for one drop`)
      }
      const bytes = sumBytes(files)
      if (bytes > byteCap) return refuse(`too large: more than ${byteCap} bytes, the byte cap for one drop`)
      if (files.length === 0) return refuse('the filter left no files')
      const clash = landingClash(files)
      if (clash) return refuse(clash)
      return { ok: true, outcome: 'accept', ...ran, files, bytes, dropped, manifest: manifestOf(files) }
    })
  }

  /** A send job's filter, from its staged `in/` into `out/`, and the edge the
   *  outcome takes. The job is already `filtering` on disk. */
  async function filterSend(id, rows) {
    const e = jobs.get(id)
    if (!e || e.state !== 'filtering') return
    const base = stagingOf(e.dropId)
    const r = await runFilter({ job: { ...e, files: rows }, direction: 'send', inDir: join(base, 'in'), outDir: join(base, 'out') })
    if (r.outcome === 'stopped') return
    if (r.outcome !== 'cancelled' && jobs.get(id)?.state === 'filtering') {
      if (r.outcome === 'accept') {
        jobs.transition(id, 'offering', { files: r.files, bytes: r.bytes, filtered: r.filtered, filterReason: r.filterReason, sources: [] })
      } else if (r.outcome === 'refuse') {
        jobs.transition(id, 'refused', { reason: r.reason, filtered: true, sources: [] })
      } else {
        jobs.transition(id, 'failed', { error: r.error, filtered: true, sources: [] })
      }
      if (!save()) return
    }
    await cleanupEnded(id)
    // To a peer this side dials, an offer goes now; to one that dials this
    // side, the drop waits in offering to be pulled.
    if (jobs.get(id)?.state === 'offering') driveSend(id)
  }

  /** Brings a send job to its filter: a new one, or one a stopped relay left.
   *
   *  Staging by copy is what freezes a drop. Once a stage has finished, the
   *  staged copy IS the drop: it is verified against the sizes and hashes
   *  recorded when it finished, and a file that is missing or differs fails
   *  the job. The sources are never read for it again, so an edit made after
   *  the stage can never slip into what is sent. Only a job whose stage never
   *  finished is staged from its sources, which copies whatever is missing or
   *  changed. Either way the job is `filtering` on disk before the filter runs. */
  async function stageAndFilter(id) {
    const e = jobs.get(id)
    if (!e || isTerminalJob(e.state)) return
    let rows
    if (e.staged || e.state === 'filtering') {
      const bad = await verifyStaged(join(stagingOf(e.dropId), 'in'), e.files)
      if (bad) {
        await failJob(id, bad)
        return
      }
      rows = e.files
    } else if (e.sources.length === 0) {
      await failJob(id, 'its source files were not recorded, so it cannot be staged again')
      return
    } else {
      try {
        rows = await stageDrop({ dir, dropId: e.dropId, files: e.sources, byteCap })
      } catch (err) {
        await failJob(id, stageError(err, e.sources))
        return
      }
    }
    const state = jobs.get(id)?.state
    if (state === 'queued') {
      jobs.transition(id, 'filtering', { files: rows, staged: true })
      jobs.flush()
      broadcast()
    } else if (state !== 'filtering') {
      // Ended while it staged; a cancel's removal may have raced the copy.
      await cleanupEnded(id)
      return
    }
    await filterSend(id, rows)
  }

  function offer({ peer, paths, note, pinned }) {
    const sel = select(paths)
    if (sel.reply) return sel.reply
    const { files, refused } = sel

    const job = jobs.create({
      peer,
      side: 'send',
      files: files.map((f) => ({ path: f.path, size: f.size, mode: f.mode })),
      bytes: sumBytes(files),
      note,
      pinned,
      refusedPaths: refused,
      refusedCount: refused.length,
      sources: files.map((f) => ({ path: f.path, abs: f.abs })),
    })
    jobs.flush()
    broadcast()

    // Off the request: a drop may be gigabytes and its filter may take
    // minutes, and the HTTP caller already has the jobId it needs to watch the
    // row on the payload.
    stageAndFilter(job.id).catch((err) => failJob(job.id, errorText(err)))

    return reply(200, { ok: true, id: job.id, refused: capRefused(refused) })
  }

  /** At boot: a send job a stopped relay left queued or filtering is staged
   *  again and filtered from `in/`, because the filter must be free to run
   *  twice on the same input. One left offering or sending is offered again
   *  when its peer is one this side dials; the receiver's answer says where to
   *  continue. A receive job left mid-pull, from a peer this side dials,
   *  pulls again from its own partial lengths; one that was pushed waits for
   *  its sender. One left verifying or filtering is checked again from its
   *  quarantine, then laid out, filtered and landed. Every other job is left
   *  as it is. */
  function start() {
    stopped = false
    for (const p of jobs.resumePlan()) {
      if (p.side === 'send' && (p.action === 'requeue' || p.action === 'refilter')) {
        stageAndFilter(p.id).catch((err) => failJob(p.id, errorText(err)))
      } else if (p.side === 'send' && p.action === 'reoffer' && peerOf(p.peer)?.dials) {
        driveSend(p.id)
      } else if (p.side === 'recv' && p.action === 'wait' && peerOf(p.peer)?.dials) {
        drivePull(p.peer, p.dropId, () => pullLoop(p.id))
      } else if (p.side === 'recv' && p.action === 'reverify') {
        land(p.id, { resume: true })
      } else if (p.side === 'send' && p.action === 'reoffer') {
        log(`drop job ${p.id} (send, ${p.state}) waits for ${p.peer} to pull it: reoffer is only for a peer this side dials`)
      } else {
        log(`drop job ${p.id} (${p.side}, ${p.state}) is left as it is: ${p.action} is not resumed here`)
      }
    }
  }

  /** Ends a running filter child the way its timeout would and waits for the
   *  queue to empty, and for every landing under way to stop at its next
   *  file. Its job stays `filtering` on disk for the next boot, and nothing
   *  still queued is started. */
  async function stop() {
    stopped = true
    current?.terminate('stop')
    await queue
    await Promise.allSettled([...landings.values()])
  }

  /** The dry run: the send filter over a throwaway stage of `paths`,
   *  answering what would leave this relay and the filter's stderr. No job
   *  is created and the stage is removed afterwards. It waits its turn for the
   *  one filter child like any drop. */
  async function filterTest({ peer, paths, note } = {}) {
    if (!validName(peer)) return reply(400, { error: 'name a peer' })
    const sel = select(paths)
    if (sel.reply) return sel.reply
    const dropId = randomBytes(8).toString('hex')
    const base = stagingOf(dropId)
    try {
      let rows
      try {
        rows = await stageDrop({ dir, dropId, files: sel.files, byteCap })
      } catch (err) {
        return reply(400, { error: 'the drop could not be staged', refused: [{ path: err?.path ?? null, reason: String(err?.reason ?? errorText(err)) }] })
      }
      const r = await runFilter({ job: { id: null, peer, dropId, note, files: rows }, direction: 'send', inDir: join(base, 'in'), outDir: join(base, 'out') })
      if (r.outcome === 'stopped') return reply(503, { error: 'peering is stopping' })
      return reply(200, {
        ok: r.ok === true,
        filtered: r.filtered,
        filterReason: r.filterReason ?? null,
        manifest: r.ok === true ? r.manifest : null,
        stderr: r.stderr ?? '',
        reason: r.reason ?? r.error ?? null,
        refused: capRefused(sel.refused),
      })
    } finally {
      await removeStaging({ dir, dropId }).catch(() => {})
    }
  }

  /** The pane's armed cancel gesture posts here; a cancel is `failed` with a
   *  fixed error, reachable from every non-terminal state on both ladders. */
  function cancel({ id }) {
    const e = typeof id === 'string' ? jobs.get(id) : null
    if (!e) return reply(404, { error: 'no such job' })
    if (isTerminalJob(e.state)) return reply(409, { error: 'this job has already finished' })
    jobs.transition(e.id, 'failed', { error: 'cancelled', sources: [] })
    jobs.flush()
    broadcast()
    // A running filter is killed first, and the run it belonged to removes the
    // staged copy once the child is gone. Otherwise the copy goes now.
    if (current && current.jobId === e.id) current.terminate('cancel')
    else cleanupEnded(e.id)
    return reply(200, { ok: true })
  }

  /** The row's own toggle; a drop can also arrive already pinned, at `create`
   *  time. */
  function pin({ id, on }) {
    const e = typeof id === 'string' ? jobs.get(id) : null
    if (!e) return reply(404, { error: 'no such job' })
    jobs.pin(e.id, on === true)
    jobs.flush()
    broadcast()
    return reply(200, { ok: true, pinned: jobs.get(e.id).pinned })
  }

  /** The wire projection, `remote` included, and the per-peer counts a job's
   *  own row cannot answer alone. `jobsFailed` counts a `failed` or `refused`
   *  job updated in the last day, so a peer's count empties on its own rather
   *  than needing a clear.
   *
   *  A job still moving, or one pinned to stay listed, is kept ahead of an
   *  old finished job nobody pinned; each of those two groups is newest
   *  first. A job's own `files` and `landed` carry only their first
   *  `JOB_FILES_IN_PAYLOAD` rows -- `fileCount` is the true total -- because a
   *  drop at its file cap turned this payload into tens of megabytes on every
   *  broadcast. */
  function payload() {
    const all = jobs.all()
    const t = now()
    const countsByPeer = {}
    for (const e of all) {
      const c = countsByPeer[e.peer] ?? (countsByPeer[e.peer] = { jobsActive: 0, jobsFailed: 0 })
      if (!isTerminalJob(e.state)) c.jobsActive++
      else if ((e.state === 'failed' || e.state === 'refused') && t - (e.updatedAt ?? 0) < DAY_MS) c.jobsFailed++
    }
    const rank = (e) => (!isTerminalJob(e.state) || e.pinned ? 0 : 1)
    const rows = [...all]
      .sort((a, b) => rank(a) - rank(b) || (b.t ?? 0) - (a.t ?? 0))
      .slice(0, JOBS_IN_PAYLOAD)
      .map((e) => ({
        id: e.id, dropId: e.dropId, peer: e.peer, side: e.side, state: e.state,
        fileCount: e.files.length, files: e.files.slice(0, JOB_FILES_IN_PAYLOAD), bytes: e.bytes, sent: e.sent,
        filtered: e.filtered, filterReason: e.filterReason,
        note: e.note, reason: e.reason, error: e.error, pinned: e.pinned,
        remote: e.remote, t: e.t, updatedAt: e.updatedAt,
        refusedPaths: e.refusedPaths, refusedCount: e.refusedCount,
        // The local inbox path, for this relay's own pane: it never goes on a heartbeat.
        landed: e.landed.slice(0, JOB_FILES_IN_PAYLOAD), inboxPath: e.side === 'recv' && e.state === 'landed' ? inboxPathOf(dir, e.peer, e.dropId) : null,
      }))
    return { jobs: rows, countsByPeer }
  }

  // ---- the transport ------------------------------------------------------------
  //
  // The side that dials drives every byte. When it sends, it pushes: an offer,
  // each file a chunk at a time, then a commit. How much of a file has arrived
  // is the length of the receiver's partial file and nothing else, so a chunk
  // is appended only at that length, and the sender always continues from the
  // offset the receiver answered, whether or not its own chunk was the one
  // appended. A receiver keeps each incoming file under its index in the
  // offer, never under the sender's path, which is a hint for landing to
  // interpret and never a place to write. A commit checks every file's sha256
  // and answers before any filter runs.

  const chunkSize = Number.isSafeInteger(chunkBytes) && chunkBytes > 0 && chunkBytes <= CHUNK_BYTES ? chunkBytes : CHUNK_BYTES
  const quarantineOf = (peer, dropId) => join(dir, QUARANTINE_DIR, peer, dropId)
  const filesDirOf = (peer, dropId) => join(quarantineOf(peer, dropId), 'files')
  const partPath = (e, idx) => join(filesDirOf(e.peer, e.dropId), String(idx))
  const jobOf = (peer, dropId, side) => jobs.all().find((e) => e.peer === peer && e.dropId === dropId && e.side === side) ?? null
  const bytesBefore = (rows, idx) => sumBytes(rows.slice(0, idx))

  /** One chain per drop: an offer, a chunk, a commit and a pulled append for
   *  the same drop never interleave, so two copies of one chunk cannot both
   *  find the file at the offset they name. */
  const locks = new Map()
  const withLock = (key, fn) => {
    const run = (locks.get(key) ?? Promise.resolve()).then(fn)
    const tail = run.catch(() => {})
    locks.set(key, tail)
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
    return run
  }
  const lockKey = (peer, dropId) => `${peer}/${dropId}`

  /** A transfer's progress reaches the pane at most every quarter second; a
   *  state change always does, through `save`. */
  let progressAt = 0
  const progressed = () => {
    const t = performance.now()
    if (t - progressAt < PROGRESS_BROADCAST_MS) return
    progressAt = t
    broadcast()
  }

  /** Runs `fn` unless a loop is already driving the same transfer. Never
   *  rejects. */
  const active = new Set()
  const drive = (key, fn) => {
    if (stopped || active.has(key)) return
    active.add(key)
    Promise.resolve().then(fn)
      .catch((err) => log(`drop transfer ${key} stopped: ${errorText(err)}`))
      .finally(() => active.delete(key))
  }
  const driveSend = (id) => drive(`send:${id}`, () => sendLoop(id))
  const drivePull = (peer, dropId, fn) => drive(`recv:${peer}/${dropId}`, fn)

  /** One request to a peer, as a value: a dialer that throws answers as one
   *  that got no response. */
  const call = (args) => Promise.resolve()
    .then(() => (typeof dial === 'function' ? dial(args) : { ok: false, status: 0, error: 'nothing to dial with' }))
    .catch((err) => ({ ok: false, status: 0, error: errorText(err) }))

  /** Each file's partial length, by index. A partial longer than its row can
   *  only be damage, and is removed so that file starts again. */
  const haveOf = async (e) => {
    const have = {}
    for (let i = 0; i < e.files.length; i++) {
      const file = partPath(e, i)
      let len = await partLength(file)
      if (len > e.files[i].size) {
        await rm(file, { force: true })
        len = 0
      }
      have[i] = len
    }
    return have
  }

  /** `delta` more bytes of file `idx` are on disk, which is now `length` long. */
  const recordReceived = (id, idx, length, delta) => {
    const e = jobs.get(id)
    if (!e) return
    jobs.set(id, { sent: Math.min(e.bytes, e.sent + delta) })
    jobs.progress(id, { fileIdx: idx, offset: length })
    progressed()
  }

  /** What a receiver makes of an offered manifest, pushed or pulled alike:
   *  null when the body names no drop or the peer is unknown, `{ refuse }`
   *  with a reason, `{ job }` for a drop already held from this peer with the
   *  same files, or `{ rows, bytes, note }` for a new one. */
  function admit(peer, body) {
    if (!isPlainObject(body) || typeof body.dropId !== 'string' || !DROP_ID_RE.test(body.dropId)) return null
    const info = validName(peer) ? peerOf(peer) : null
    if (!info) return null
    if (!info.confirmed) return { refuse: 'this side has not confirmed the pairing yet' }
    const { dropId } = body
    if (jobs.all().some((e) => e.dropId === dropId && (e.peer !== peer || e.side !== 'recv'))) {
      return { refuse: 'that drop id is already in use here' }
    }
    if (!Array.isArray(body.files)) return { refuse: "the offer's file list is malformed" }
    if (body.files.length === 0) return { refuse: 'the offer has no files' }
    if (body.files.length > fileCap) return { refuse: `too many files: more than ${fileCap}, the file cap for one drop` }
    const rows = body.files.map(offerRow)
    if (rows.includes(null)) return { refuse: "the offer's file list is malformed" }
    const bytes = sumBytes(rows)
    if (bytes > byteCap) return { refuse: `too large: more than ${byteCap} bytes, the byte cap for one drop` }
    const job = jobOf(peer, dropId, 'recv')
    if (job) return sameRows(job.files, rows) ? { job } : { refuse: 'the drop changed since it was first offered' }
    return { rows, bytes, note: typeof body.note === 'string' ? body.note.slice(0, NOTE_MAX) : null }
  }

  /** `/peer/drop/offer`: `{ accept: true, have }`, each file's partial length
   *  by index, or `{ accept: false, reason }`. A refusal creates nothing; the
   *  sender's own job carries it. */
  async function onOffer({ peer, body }) {
    const a = admit(peer, body)
    if (!a) return null
    if (a.refuse) return reply(200, { accept: false, reason: a.refuse })
    const { dropId } = body
    return withLock(lockKey(peer, dropId), async () => {
      let e = jobOf(peer, dropId, 'recv')
      // Every byte already here and verified: a sender that restarted before
      // it heard the commit answered is told so, whatever came of them since.
      if (e && deliveredHere(e)) return reply(200, { accept: true, have: Object.fromEntries(e.files.map((row, i) => [i, row.size])) })
      if (e?.state === 'refused') return reply(200, { accept: false, reason: e.reason })
      if (e?.state === 'failed') return reply(200, { accept: false, reason: e.error })
      if (!e || e.state === 'offered' || e.state === 'receiving') await mkdir(filesDirOf(peer, dropId), { recursive: true })
      if (!e) {
        e = jobs.create({ peer, side: 'recv', dropId, files: a.rows, bytes: a.bytes, note: a.note })
      }
      if (e.state === 'offered') {
        jobs.transition(e.id, 'receiving')
        save()
      }
      const have = await haveOf(e)
      if (e.state === 'receiving') jobs.set(e.id, { sent: sumValues(have) })
      return reply(200, { accept: true, have })
    })
  }

  /** `/peer/drop/chunk?drop=&file=&offset=`: the raw bytes are appended only
   *  when `offset` is the partial file's length, and written nowhere at all
   *  otherwise. The answer is that length afterwards either way, with
   *  `appended` saying which happened. */
  async function onChunk({ peer, query, body }) {
    const q = chunkQueryOf(query)
    if (!q || !Buffer.isBuffer(body) || body.length === 0 || body.length > CHUNK_BYTES) return null
    if (!peerOf(peer)?.confirmed) return null
    return withLock(lockKey(peer, q.dropId), async () => {
      const e = jobOf(peer, q.dropId, 'recv')
      if (!e || e.state !== 'receiving' || q.file >= e.files.length) return null
      const file = partPath(e, q.file)
      const current = await partLength(file)
      if (q.offset !== current) return reply(200, { offset: current, appended: false })
      if (current + body.length > e.files[q.file].size) return null
      const length = await appendPart(file, body)
      recordReceived(e.id, q.file, length, length - current)
      return reply(200, { offset: length, appended: true })
    })
  }

  /** Checks every partial file of a receiving job against its row; the
   *  caller holds the drop's lock. Answers what a commit answers: `{ ok: true
   *  }` once every file matches and the job has moved on to filtering, with
   *  its landing started off the request; `{ ok: false, have }` when a file
   *  is short, or failed its
   *  sha256 for the first time and was removed to be sent again; `{ ok: false,
   *  error }` once one has failed it twice and the job has failed. */
  async function verifyReceived(id) {
    const e = jobs.get(id)
    const have = await haveOf(e)
    if (e.files.some((row, i) => have[i] !== row.size)) return { ok: false, have }
    // An empty file never has a chunk to append, so its partial file is made here.
    for (let i = 0; i < e.files.length; i++) {
      if (e.files[i].size === 0) await appendPart(partPath(e, i), Buffer.alloc(0))
    }
    const mismatched = []
    for (let i = 0; i < e.files.length; i++) {
      const d = await digestFile(partPath(e, i))
      if (!d || d.size !== e.files[i].size || d.sha256 !== e.files[i].sha256) mismatched.push(i)
    }
    const cur = jobs.get(id)
    if (cur?.state !== 'receiving') return { ok: false, error: cur?.error ?? cur?.reason ?? 'this drop has ended' }
    if (mismatched.length === 0) {
      jobs.transition(id, 'verifying', { sent: cur.bytes })
      save()
      jobs.transition(id, 'filtering')
      save()
      // The commit is answered now; the receive filter and the landing follow.
      land(id)
      return { ok: true }
    }
    const twice = mismatched.find((i) => cur.retried.includes(i))
    if (twice !== undefined) {
      const error = errorText(`${cur.files[twice].path} did not match its sha256 twice`)
      // `sent` counts only what verified, so no reader of this job's delta can
      // take a failed check for a delivered drop.
      jobs.transition(id, 'failed', { error, sent: cur.files.reduce((n, row, i) => (mismatched.includes(i) ? n : n + row.size), 0) })
      save()
      await cleanupEnded(id)
      return { ok: false, error }
    }
    for (const i of mismatched) {
      await rm(partPath(cur, i), { force: true })
      have[i] = 0
    }
    jobs.set(id, { retried: [...cur.retried, ...mismatched], sent: sumValues(have) })
    save()
    return { ok: false, have }
  }

  /** `/peer/drop/commit`: answers once every file has been checked, before
   *  any filter -- `{ ok: true }`, `{ ok: false, have }` to send the rest, or
   *  `{ ok: false, error }` when this side has ended the drop. */
  async function onCommit({ peer, body }) {
    if (!isPlainObject(body) || typeof body.dropId !== 'string' || !DROP_ID_RE.test(body.dropId)) return null
    if (!peerOf(peer)?.confirmed) return null
    return withLock(lockKey(peer, body.dropId), async () => {
      const e = jobOf(peer, body.dropId, 'recv')
      if (!e || e.state === 'offered') return null
      if (deliveredHere(e)) return reply(200, { ok: true })
      if (e.state === 'failed' || e.state === 'refused') return reply(200, { ok: false, error: e.error ?? e.reason })
      if (e.state !== 'receiving') return reply(200, { ok: true })
      return reply(200, await verifyReceived(e.id))
    })
  }

  // ---- landing a received drop --------------------------------------------------
  //
  // A drop whose every file verified is laid out under its quarantine's `in/`
  // by landing path, run through this side's own receive filter, and landed in
  // `peer-inbox/<peer>/<dropId>/`, all off the request that verified it. The
  // sender's paths are hints: a row the receiver refuses is dropped and named
  // on the job, and nothing the filter lists is taken unless it is a regular
  // file under `--out` whose path passes the same rule. However the drop ends,
  // `sent` stays every byte and `files` stays the offer as it came, since the
  // bytes were delivered and a sender asking again is answered from them;
  // what landed is `landed`.

  /** Receive jobs being laid out, filtered or landed, by id, so one is never
   *  started twice and `stop` can wait for them. */
  const landings = new Map()
  const refusedOf = (list) => ({ refusedPaths: capRefused(list), refusedCount: list.length })

  /** Starts landing a verified drop, or at boot resumes one. Never rejects:
   *  anything thrown on the way fails the job with its reason. */
  function land(id, { resume = false } = {}) {
    if (stopped || landings.has(id)) return
    const run = (resume ? resumeLanding(id) : landReceived(id))
      .catch((err) => failJob(id, errorText(err)))
      .finally(() => landings.delete(id))
    landings.set(id, run)
  }

  /** A filtering receive job to its end, and its copy let go. */
  const endLanding = async (id, to, patch) => {
    if (jobs.get(id)?.state !== 'filtering') return
    jobs.transition(id, to, patch)
    save()
    await cleanupEnded(id)
  }

  /** Lays out, filters and lands one receive job that is `filtering` on disk. */
  async function landReceived(id) {
    const e = jobs.get(id)
    if (!e || e.side !== 'recv' || e.state !== 'filtering') return
    const { peer, dropId } = e
    if (!inboxPathOf(dir, peer, dropId)) {
      await failJob(id, "this drop's peer name cannot name a directory here")
      return
    }
    // False once the relay is stopping, or the job has ended under this run.
    const still = () => !stopped && jobs.get(id)?.state === 'filtering'
    const base = quarantineOf(peer, dropId)

    const laid = await layOut({ dir, peer, dropId, rows: e.files, stopped: () => !still() })
    if (!still()) { await cleanupEnded(id); return }
    if (laid.refuse) { await endLanding(id, 'refused', { reason: laid.refuse, ...refusedOf(laid.dropped) }); return }
    jobs.set(id, refusedOf(laid.dropped))

    const r = await runFilter({ job: { ...e, files: laid.rows }, direction: 'receive', inDir: join(base, 'in'), outDir: join(base, 'out') })
    if (r.outcome === 'stopped') return
    if (r.outcome === 'cancelled' || !still()) { await cleanupEnded(id); return }
    const dropped = [...laid.dropped, ...(r.dropped ?? [])]
    if (r.outcome === 'refuse') { await endLanding(id, 'refused', { reason: r.reason, filtered: true, ...refusedOf(dropped) }); return }
    if (r.outcome === 'fail') { await endLanding(id, 'failed', { error: r.error, filtered: true, ...refusedOf(dropped) }); return }
    jobs.set(id, refusedOf(dropped))

    const landed = await landDrop({ dir, peer, dropId, srcDir: join(base, r.filtered ? 'out' : 'in'), rows: r.files, stopped: () => !still() })
    if (landed.stopped) { await cleanupEnded(id); return }
    if (jobs.get(id)?.state !== 'filtering') {
      // Ended while the rename ran: the directory it put in place is this run's to take back.
      if (!landed.recovered) await rm(landed.inboxPath, { recursive: true, force: true })
      await cleanupEnded(id)
      return
    }
    jobs.transition(id, 'landed', { landed: r.files, filtered: r.filtered, filterReason: r.filterReason, ...refusedOf(dropped) })
    if (save()) await cleanupEnded(id)
  }

  /** At boot, a receive job left verifying or filtering. A landing scratch
   *  directory it left is this relay's own and goes first; the quarantine is
   *  checked against every row again, since the relay was down; then it is
   *  laid out, filtered and landed as if it had just verified. */
  async function resumeLanding(id) {
    const e = jobs.get(id)
    if (!e || e.side !== 'recv' || (e.state !== 'verifying' && e.state !== 'filtering')) return
    if (!inboxPathOf(dir, e.peer, e.dropId)) {
      await failJob(id, "this drop's peer name cannot name a directory here")
      return
    }
    await removeLandingScratch({ dir, peer: e.peer, dropId: e.dropId })
    const ready = await withLock(lockKey(e.peer, e.dropId), () => recheckQuarantine(id))
    if (ready) await landReceived(id)
  }

  /** True once a job left verifying or filtering still holds every file
   *  exactly as verified, and is `filtering`; a file that changed or went
   *  missing fails the job, naming it. */
  async function recheckQuarantine(id) {
    const e = jobs.get(id)
    if (!e || (e.state !== 'verifying' && e.state !== 'filtering')) return false
    for (let i = 0; i < e.files.length; i++) {
      const d = await digestFile(partPath(e, i))
      if (!d || d.size !== e.files[i].size || d.sha256 !== e.files[i].sha256) {
        await failJob(id, errorText(`the quarantined copy of ${e.files[i].path} changed or is missing`))
        return false
      }
    }
    if (stopped) return false
    if (jobs.get(id)?.state === 'verifying') {
      jobs.transition(id, 'filtering')
      save()
    }
    return jobs.get(id)?.state === 'filtering'
  }

  /** Copy-into: a landed drop's files, from its inbox directory, under a
   *  directory the person picked. It is the only way a landed drop reaches a
   *  worktree. */
  async function copyInto({ id, dest } = {}) {
    const e = typeof id === 'string' ? jobs.get(id) : null
    if (!e) return reply(404, { error: 'no such job' })
    if (e.side !== 'recv' || e.state !== 'landed') return reply(409, { error: 'only a landed drop can be copied' })
    const r = await copyLanded({ dir, peer: e.peer, dropId: e.dropId, rows: e.landed, dest, roots: roots() })
    return r.error ? reply(400, { error: r.error }) : reply(200, { ok: true, copied: r.copied, skipped: r.skipped })
  }

  /** The dialler sending: offer, each file from the receiver's own offset,
   *  commit. A request that gets no answer ends the loop with the job exactly
   *  where it was, for the next heartbeat or the next boot to start again. A
   *  refused offer refuses the job, and a receiver that has failed the drop
   *  fails it here too. */
  async function sendLoop(id) {
    const first = jobs.get(id)
    if (!first || first.side !== 'send' || !peerOf(first.peer)?.dials) return
    const { peer, dropId } = first
    const live = () => {
      const e = jobs.get(id)
      return !stopped && e && (e.state === 'offering' || e.state === 'sending') ? e : null
    }
    if (!live()) return
    const manifest = { dropId, note: first.note, files: first.files.map(wireRow) }
    if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_MANIFEST_BODY) {
      await failJob(id, 'the list of files is too large to offer')
      return
    }

    const offered = await call({ peer, path: '/peer/drop/offer', body: manifest })
    let e = live()
    if (!e || !offered.ok || !isPlainObject(offered.json)) return
    if (offered.json.accept !== true) {
      const reason = reasonText(offered.json.reason) ?? 'the receiver refused the drop'
      if (e.state === 'offering') jobs.transition(id, 'refused', { reason })
      else jobs.transition(id, 'failed', { error: errorText(`the receiver refused the drop: ${reason}`) })
      save()
      await cleanupEnded(id)
      return
    }
    if (e.state === 'offering') {
      jobs.transition(id, 'sending')
      save()
    }

    const base = join(stagingOf(dropId), e.filtered === true ? 'out' : 'in')
    let have = offered.json.have
    const already = e.files.reduce((n, row, i) => n + offsetIn(have, i, row.size), 0)
    if (already > 0) log(`drop ${dropId}: ${peer} already holds ${already} bytes of it; sending the rest`)
    for (let round = 0; round < ROUNDS; round++) {
      for (let i = 0; i < e.files.length; i++) {
        const row = e.files[i]
        let offset = offsetIn(have, i, row.size)
        let unmoved = 0
        while (offset < row.size) {
          let bytes = null
          if (stageablePath(row.path)) {
            try { bytes = await readPart(join(base, row.path), offset, Math.min(chunkSize, row.size - offset)) } catch {}
          }
          if (!live()) return
          if (!bytes || bytes.length === 0) {
            await failJob(id, errorText(`the copy of ${row.path} waiting to be sent changed or is missing`))
            return
          }
          const res = await call({ peer, path: '/peer/drop/chunk', query: `drop=${dropId}&file=${i}&offset=${offset}`, rawBody: bytes })
          if (!live() || !res.ok || !isPlainObject(res.json)) return
          const next = res.json.offset
          if (!Number.isSafeInteger(next) || next < 0 || next > row.size) return
          // A receiver that keeps answering the same offset is not taking
          // bytes; the next resume asks again rather than spinning here.
          unmoved = next === offset ? unmoved + 1 : 0
          if (unmoved > 2) return
          offset = next
          jobs.set(id, { sent: bytesBefore(e.files, i) + offset })
          jobs.progress(id, { fileIdx: i, offset })
          progressed()
        }
      }
      const committed = await call({ peer, path: '/peer/drop/commit', body: { dropId }, timeoutMs: COMMIT_TIMEOUT_MS })
      e = live()
      if (!e || !committed.ok || !isPlainObject(committed.json)) return
      if (committed.json.ok === true) {
        jobs.transition(id, 'sent', { sent: e.bytes })
        save()
        await cleanupEnded(id)
        return
      }
      if (typeof committed.json.error === 'string') {
        await failJob(id, errorText(`the receiver failed the drop: ${reasonText(committed.json.error)}`))
        return
      }
      have = committed.json.have
    }
  }

  /** After a heartbeat reaches a peer this side dials: every transfer with it
   *  that no loop is driving starts again. */
  function resumeFor(peer) {
    if (!peerOf(peer)?.dials) return
    for (const e of jobs.all()) {
      if (e.peer !== peer) continue
      if (e.side === 'send' && (e.state === 'offering' || e.state === 'sending')) driveSend(e.id)
      else if (e.side === 'recv' && e.state === 'receiving') drivePull(peer, e.dropId, () => pullLoop(e.id))
    }
  }

  // When the side that cannot be dialled sends, its job rests in offering and
  // says so on the heartbeat. The dialler fetches the manifest and pulls each
  // file from its own partial length -- the receiver's offset is still the
  // truth -- then checks every sha256 exactly as a commit does. A pulled
  // answer is not signed; the channel is pinned to the peer's certificate,
  // and the check is what stands between those bytes and anything later.

  /** A send job to `peer` that its dialler may fetch: offering or sending,
   *  and to a peer that dials this side rather than one this side dials. */
  const pullable = (peer, body) => {
    if (!isPlainObject(body) || typeof body.dropId !== 'string' || !DROP_ID_RE.test(body.dropId)) return null
    const info = peerOf(peer)
    if (!info?.confirmed || info.dials) return null
    const e = jobOf(peer, body.dropId, 'send')
    return e && (e.state === 'offering' || e.state === 'sending') ? e : null
  }

  /** `/peer/drop/manifest {dropId}`: the rows a dialler needs to pull this
   *  drop, for that dialler and nobody else. */
  async function onManifest({ peer, body }) {
    const e = pullable(peer, body)
    if (!e) return null
    const manifest = { dropId: e.dropId, note: e.note, files: e.files.map(wireRow) }
    if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_MANIFEST_BODY) {
      await failJob(e.id, 'the list of files is too large to offer')
      return null
    }
    return reply(200, manifest)
  }

  /** `/peer/drop/pull {dropId, file, offset}`: at most one chunk of that file
   *  from `offset`, as raw bytes, read from what the send filter left. An
   *  offset at the end answers no bytes; one past it, nothing at all. */
  async function onPull({ peer, body }) {
    const e = pullable(peer, body)
    if (!e) return null
    const { file, offset } = body
    if (!Number.isSafeInteger(file) || file < 0 || file >= e.files.length || !Number.isSafeInteger(offset) || offset < 0) return null
    const row = e.files[file]
    if (offset > row.size || !stageablePath(row.path)) return null
    const length = Math.min(chunkSize, row.size - offset)
    let bytes = null
    try { bytes = await readPart(join(stagingOf(e.dropId), e.filtered === true ? 'out' : 'in', row.path), offset, length) } catch {}
    const cur = jobs.get(e.id)
    if (!cur || (cur.state !== 'offering' && cur.state !== 'sending')) return null
    if (!bytes || bytes.length !== length) {
      await failJob(e.id, errorText(`the copy of ${row.path} waiting to be sent changed or is missing`))
      return null
    }
    jobs.set(e.id, { sent: bytesBefore(cur.files, file) + offset + length })
    jobs.progress(e.id, { fileIdx: file, offset: offset + length })
    progressed()
    return { status: 200, raw: bytes }
  }

  /** A dialler told of a drop it has no job for: fetch the manifest, admit it
   *  exactly as a pushed offer is admitted, and pull. A manifest this side
   *  refuses still leaves a job, refused with the reason, which is how a
   *  sender nobody can dial hears of it: on the next heartbeat. */
  async function startPull(peer, dropId) {
    const got = await call({ peer, path: '/peer/drop/manifest', body: { dropId }, maxResponse: MAX_MANIFEST_BODY })
    if (stopped || !got.ok || !isPlainObject(got.json) || got.json.dropId !== dropId) return
    const a = admit(peer, got.json)
    if (!a || a.job || !peerOf(peer)?.confirmed || !peerOf(peer)?.dials) return
    const id = await withLock(lockKey(peer, dropId), async () => {
      if (jobOf(peer, dropId, 'recv')) return null
      if (a.refuse) {
        const rows = (Array.isArray(got.json.files) ? got.json.files : []).slice(0, fileCap).map(offerRow).filter(Boolean)
        const note = typeof got.json.note === 'string' ? got.json.note.slice(0, NOTE_MAX) : null
        const e = jobs.create({ peer, side: 'recv', dropId, files: rows, bytes: sumBytes(rows), note })
        jobs.transition(e.id, 'refused', { reason: a.refuse })
        save()
        return null
      }
      await mkdir(filesDirOf(peer, dropId), { recursive: true })
      const e = jobs.create({ peer, side: 'recv', dropId, files: a.rows, bytes: a.bytes, note: a.note })
      jobs.transition(e.id, 'receiving')
      save()
      return e.id
    })
    if (id) await pullLoop(id)
  }

  /** The dialler receiving: each file from its own partial length, a chunk at
   *  a time, then the same check a commit makes. A request that gets no
   *  answer ends the loop with the job where it was; the next heartbeat, or
   *  the next boot, starts it again. */
  async function pullLoop(id) {
    const first = jobs.get(id)
    if (!first || first.side !== 'recv' || !peerOf(first.peer)?.dials) return
    const { peer, dropId } = first
    const key = lockKey(peer, dropId)
    const live = () => {
      const e = jobs.get(id)
      return !stopped && e?.state === 'receiving' ? e : null
    }
    if (first.state === 'offered') {
      jobs.transition(id, 'receiving')
      save()
    }
    if (!live()) return
    await mkdir(filesDirOf(peer, dropId), { recursive: true })
    for (let round = 0; round < ROUNDS; round++) {
      const e = live()
      if (!e) return
      const have = await withLock(key, () => haveOf(e))
      const already = sumValues(have)
      if (round === 0 && already > 0) log(`drop ${dropId}: ${already} bytes are already here; pulling the rest`)
      jobs.set(id, { sent: already })
      for (let i = 0; i < e.files.length; i++) {
        const row = e.files[i]
        let offset = have[i]
        while (offset < row.size) {
          const res = await call({ peer, path: '/peer/drop/pull', body: { dropId, file: i, offset }, rawResponse: true, maxResponse: MAX_CHUNK_BODY })
          if (!live() || !res.ok || !Buffer.isBuffer(res.buf) || res.buf.length === 0 || res.buf.length > CHUNK_BYTES) return
          const next = await withLock(key, async () => {
            if (!live()) return null
            const file = partPath(e, i)
            const current = await partLength(file)
            // The file moved under this loop; what is on disk is where it goes on.
            if (current !== offset) return current <= row.size ? current : null
            if (current + res.buf.length > row.size) return null
            const length = await appendPart(file, res.buf)
            recordReceived(id, i, length, length - current)
            return length
          })
          if (next === null) return
          offset = next
        }
      }
      const v = await withLock(key, () => (live() ? verifyReceived(id) : null))
      if (!v || v.ok === true || typeof v.error === 'string') return
    }
  }

  /** This side's half of every drop with `peer`, as that peer may see it:
   *  states and counts, never a path or a manifest. Jobs still moving come
   *  first, then those that ended within the hour, newest first; at most 100
   *  rows, and never more than a share of a heartbeat's body. */
  function jobDeltasFor(peer) {
    const t = now()
    const ended = (e) => (isTerminalJob(e.state) ? 1 : 0)
    const mine = jobs.all()
      .filter((e) => e.peer === peer && (!isTerminalJob(e.state) || t - (e.updatedAt ?? 0) < DELTA_RECENT_MS))
      .sort((a, b) => ended(a) - ended(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const rows = []
    let size = 2
    for (const e of mine) {
      if (rows.length >= DELTAS_MAX) break
      const row = {
        dropId: e.dropId, side: e.side, state: e.state, files: e.files.length, bytes: e.bytes, sent: e.sent,
        reason: reasonText(e.state === 'failed' ? e.error : e.reason), at: e.updatedAt,
      }
      const n = Buffer.byteLength(JSON.stringify(row)) + 1
      if (size + n > DELTA_BUDGET) break
      rows.push(row)
      size += n
    }
    return rows
  }

  /** The edge, if any, the other side's reported state moves this side's
   *  half of the same drop along. A sender's offer goes to sending once the
   *  receiver is receiving, and to sent once the receiver holds every byte
   *  verified -- including a receiver that went on to refuse or fail after
   *  that, since what it did with the bytes is its own record. A refusal
   *  before any byte moved refuses the offer; any other end fails it. A
   *  receiver fails with a sender that ended the drop before its bytes were
   *  all here. */
  const edgeFromRemote = (e, d, reason) => {
    const tail = reason ? `: ${reason}` : ''
    if (e.side === 'send') {
      if (e.state !== 'offering' && e.state !== 'sending') return null
      if (d.state === 'receiving') return e.state === 'offering' ? { to: 'sending' } : null
      const delivered = DELIVERED.has(d.state) ||
        ((d.state === 'refused' || d.state === 'failed') && e.bytes > 0 && d.sent === e.bytes)
      if (delivered) return { via: e.state === 'offering' ? 'sending' : null, to: 'sent', patch: { sent: e.bytes } }
      if (d.state === 'refused' && e.state === 'offering') return { to: 'refused', patch: { reason: reason ?? 'the receiver refused the drop' } }
      if (d.state === 'refused' || d.state === 'failed') return { to: 'failed', patch: { error: errorText(`the receiver ${d.state} the drop${tail}`) } }
      return null
    }
    if ((e.state === 'offered' || e.state === 'receiving') && d.state === 'failed') {
      return { to: 'failed', patch: { error: errorText(`the sender ended the drop${tail}`) } }
    }
    return null
  }

  /** The other side's `jobDeltas`, heard from `peer`. A row lands only on
   *  this side's own job for the same drop with that same peer -- the other
   *  half of it -- as `remote`, stamped with when it was heard, and moves that
   *  job only along `edgeFromRemote`. A row for a drop this side has no job
   *  for starts a pull, and only when it is an offering send and `peer` is one
   *  this side dials; anything else unknown is ignored. */
  function applyDeltas(peer, deltas) {
    if (!Array.isArray(deltas)) return
    const info = validName(peer) ? peerOf(peer) : null
    if (!info?.confirmed) return
    const ended = []
    let moved = false
    for (const d of deltas.slice(0, DELTAS_MAX)) {
      if (!isPlainObject(d) || typeof d.dropId !== 'string' || !DROP_ID_RE.test(d.dropId)) continue
      if (!Object.hasOwn(SIDE_STATES, d.side) || !SIDE_STATES[d.side].includes(d.state)) continue
      const e = jobOf(peer, d.dropId, d.side === 'send' ? 'recv' : 'send')
      if (!e) {
        if (d.side === 'send' && d.state === 'offering' && info.dials) drivePull(peer, d.dropId, () => startPull(peer, d.dropId))
        continue
      }
      const reason = reasonText(d.reason)
      jobs.set(e.id, { remote: { state: d.state, reason, at: now() } })
      const edge = edgeFromRemote(e, d, reason)
      if (edge) {
        if (edge.via) jobs.transition(e.id, edge.via)
        jobs.transition(e.id, edge.to, edge.patch)
        moved = true
        if (isTerminalJob(edge.to)) ended.push(e.id)
      } else if (e.side === 'recv' && e.state === 'receiving' && info.dials && (d.state === 'offering' || d.state === 'sending')) {
        drivePull(peer, d.dropId, () => pullLoop(e.id))
      }
    }
    if (moved) save()
    for (const id of ended) cleanupEnded(id)
  }

  /** The stall sweep: a job with no progress for a day fails, and then every
   *  ended job whose copy is still on disk -- this sweep's, or one an earlier
   *  removal could not clear -- loses it. Answers how many jobs it failed. */
  async function sweep() {
    const stalled = jobs.sweepStalled()
    if (stalled.length) save()
    for (const e of jobs.all()) {
      if (!isTerminalJob(e.state)) continue
      const leftover = e.side === 'send'
        ? existsSync(stagingOf(e.dropId))
        : validName(e.peer) && (existsSync(quarantineOf(e.peer, e.dropId)) || existsSync(join(dir, INBOX_DIR, e.peer, LANDING_PREFIX + e.dropId)))
      if (leftover) await cleanupEnded(e.id)
    }
    return stalled.length
  }

  return {
    start, stop, offer, filterTest, runFilter, cancel, pin, copyInto, payload, sweep,
    onOffer, onChunk, onCommit, onManifest, onPull, jobDeltasFor, applyDeltas, resumeFor,
  }
}
