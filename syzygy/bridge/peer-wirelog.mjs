// The log of every exchange with a paired peer, one JSON line each, appended
// synchronously by the relay and never rewritten in place; a torn final line
// is skipped and counted rather than treated as a reason to stop. Heartbeats
// and repeated dial errors are written only when their content changes, and a
// drop's chunk transfers are rolled up into one line at their commit, and a
// pulled file's later chunks into its drop's next pull line, so an idle or
// busy link does not rotate real rows out from under a slow reader.
//
// The switch store beside it is authoritative, not derived: an exception to
// "redact everything" exists nowhere else, so every write serializes first,
// to a temp file, then is renamed over the target, and a file that will not
// parse is moved aside rather than overwritten -- it fails SAFE, which here
// means every peer reads as on (redacted), never the reverse.
//
// `createWireTap` is the join: it asks the settings store whether a peer is
// on, asks the redactor to do the work when it is, and asks the log
// to remember what happened either way.

import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { redactOutbound, REDACTION_KINDS } from './peer-redact.mjs'

export const WIRE_FILE = 'peer-wire.jsonl'
export const WIRE_ROTATED = 'peer-wire.1.jsonl'
export const WIRE_SETTINGS_FILE = 'peer-wire.json'
export const ROTATE_LINES = 20_000
export const ROTATE_BYTES = 8 * 1024 * 1024
export const BODY_CLIP = 8192
export const READ_LIMIT_DEFAULT = 100
export const READ_LIMIT_MAX = 500
export const WIRE_KINDS = ['pair', 'hello', 'ask', 'reply', 'drop', 'error', 'other']
export const ROUTE_KINDS = {
  '/peer/pair': 'pair',
  '/peer/hello': 'hello',
  '/peer/ask': 'ask',
  '/peer/ask/reply': 'reply',
  '/peer/drop/offer': 'drop',
  '/peer/drop/commit': 'drop',
  '/peer/drop/manifest': 'drop',
  '/peer/drop/pull': 'drop',
  '/peer/drop/chunk': 'chunk',
}

const FP_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0)
const foldWs = (s) => s.replace(/\s+/g, ' ').trim()

/** ≤ 160 characters, whitespace folded to single spaces. The one line a log
 *  row shows without opening its detail. */
export const summarize = ({ route, kind, req, res, error, chunks }) => {
  let line
  if (kind === 'error') {
    line = route === '/peer/ask/reply' ? `reply failed: ${error}` : `${route} failed: ${error}`
  } else if (route === '/peer/pair') {
    line = `pairing: ${(req && req.name) || '?'} ⇄ ${(res && res.name) || '?'}`
  } else if (route === '/peer/hello') {
    const sent = Array.isArray(req && req.roster) ? req.roster.length : 0
    const recv = Array.isArray(res && res.roster) ? res.roster.length : 0
    line = `heartbeat · roster ${sent} sent, ${recv} received`
    const queued = Array.isArray(res && res.outbound) ? res.outbound.length : 0
    if (queued > 0) line += ` · ${queued} queued items`
  } else if (route === '/peer/ask') {
    line = `ask: ${(req && req.text) || ''}`
  } else if (route === '/peer/ask/reply') {
    const n = req && Number.isFinite(req.actionsProposed) ? req.actionsProposed : 0
    line = `reply · ${n} ${n === 1 ? 'action' : 'actions'} proposed · ${(req && req.text) || ''}`
  } else if (route === '/peer/drop/offer') {
    const n = Array.isArray(req && req.files) ? req.files.length : 0
    line = `drop offer · ${n} files · ${(req && req.note) || ''}`
  } else if (route === '/peer/drop/commit') {
    line = `drop commit · ${(chunks && chunks.chunks) || 0} chunks, ${(chunks && chunks.bytes) || 0} bytes`
  } else if (route === '/peer/drop/manifest') {
    line = 'drop manifest request'
  } else if (route === '/peer/drop/pull') {
    const file = req && Number.isInteger(req.file) ? req.file : '?'
    line = `drop pull · file ${file}`
    if (chunks && chunks.chunks) line += ` · ${chunks.chunks} earlier chunks, ${chunks.bytes} bytes`
  } else {
    line = kind || route || 'other'
  }
  return foldWs(String(line)).slice(0, 160)
}

const normalizeRedactions = (r) => {
  const kinds = {}
  if (r && r.kinds && typeof r.kinds === 'object' && !Array.isArray(r.kinds)) {
    for (const [k, v] of Object.entries(r.kinds)) {
      if (REDACTION_KINDS.includes(k) && Number.isInteger(v) && v >= 0) kinds[k] = v
    }
  }
  return { n: r && Number.isInteger(r.n) && r.n >= 0 ? r.n : 0, kinds }
}

/** A row read back off disk, coerced field by field; anything that does not
 *  look like a row at all (not an object, a bad `t`, a `dir` or `kind` this
 *  version does not know) is refused entirely, letting the caller count it as
 *  torn rather than carry a record nothing downstream can trust. */
const sanitizeRow = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!Number.isFinite(raw.t) || raw.t <= 0) return null
  if (raw.dir !== 'in' && raw.dir !== 'out') return null
  if (typeof raw.kind !== 'string' || !WIRE_KINDS.includes(raw.kind)) return null
  const clip = (s) => (typeof s === 'string' ? s.slice(0, BODY_CLIP) : null)
  return {
    t: raw.t,
    dir: raw.dir,
    peer: typeof raw.peer === 'string' ? raw.peer : null,
    route: typeof raw.route === 'string' ? raw.route : '',
    kind: raw.kind,
    status: Number.isFinite(raw.status) ? raw.status : null,
    rttMs: Number.isFinite(raw.rttMs) ? raw.rttMs : null,
    reqBytes: count(raw.reqBytes),
    resBytes: count(raw.resBytes),
    req: clip(raw.req),
    res: clip(raw.res),
    reqClipped: raw.reqClipped === true,
    resClipped: raw.resClipped === true,
    redactions: normalizeRedactions(raw.redactions),
    safeguard: raw.safeguard === 'off' || raw.safeguard === 'exempt' ? raw.safeguard : 'on',
    summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 160) : '',
    repeats: count(raw.repeats),
    error: typeof raw.error === 'string' ? raw.error.slice(0, 400) : null,
    chunks: raw.chunks && typeof raw.chunks === 'object' && !Array.isArray(raw.chunks)
      ? { chunks: count(raw.chunks.chunks), bytes: count(raw.chunks.bytes) }
      : null,
  }
}

const headOf = (row) => { const { req, res, ...head } = row; return head }

const dropIdOf = (req, query) => {
  if (req && typeof req === 'object' && typeof req.dropId === 'string') return req.dropId
  if (typeof query === 'string' && query) {
    try { return new URLSearchParams(query).get('drop') ?? '' } catch { return '' }
  }
  return ''
}

const stripTop = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v
  const out = {}
  for (const [k, val] of Object.entries(v)) if (k !== 'now' && k !== 'ackedTo') out[k] = val
  return out
}
const helloContentOf = (req, res) => JSON.stringify([stripTop(req), stripTop(res)])

/** A Buffer or null is null text with its byte size, since neither is a
 *  request or answer this log can show as JSON. Anything else is stringified
 *  once, clipped to BODY_CLIP with a flag, and its true byte length kept
 *  regardless of the clip. */
const halfOf = (v) => {
  if (v === undefined || v === null) return { text: null, clipped: false, bytes: 0 }
  if (Buffer.isBuffer(v)) return { text: null, clipped: false, bytes: v.length }
  let text
  try { text = JSON.stringify(v) } catch { text = undefined }
  if (typeof text !== 'string') return { text: null, clipped: false, bytes: 0 }
  const bytes = Buffer.byteLength(text, 'utf8')
  return text.length > BODY_CLIP ? { text: text.slice(0, BODY_CLIP), clipped: true, bytes } : { text, clipped: false, bytes }
}

// Reads `path` (utf8), calling `each(row)` for a parseable line and
// `each(null)` for one that is not; answers how many non-blank lines there
// were and the file's byte size, or {n:0, size:0} when it does not exist.
const scan = (path, each) => {
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return { n: 0, size: 0 } }
  let n = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    n += 1
    let row = null
    try { row = sanitizeRow(JSON.parse(line)) } catch {}
    each(row)
  }
  return { n, size: Buffer.byteLength(text, 'utf8') }
}

export const createWireLog = ({ dir, now = Date.now, onAppend = () => {} } = {}) => {
  const currentPath = join(dir, WIRE_FILE)
  const rotatedPath = join(dir, WIRE_ROTATED)

  // The digest's own bookkeeping: one small tuple per retained row, split the
  // same way the two files on disk are, so a rotation just swaps which array
  // is "older" instead of re-reading anything.
  let older = [], current = []
  let lines = 0, bytes = 0, lastT = 0, skipped = 0
  let refusedCount = 0, repeatsTotal = 0

  const tupleOf = (r) => ({ t: r.t, k: r.kind, p: r.peer, rn: r.redactions.n, rk: r.redactions.kinds })

  scan(rotatedPath, (r) => { if (r) older.push(tupleOf(r)); else skipped += 1 })
  const cur = scan(currentPath, (r) => { if (r) current.push(tupleOf(r)); else skipped += 1 })
  lines = cur.n
  bytes = cur.size
  for (const x of older) if (x.t > lastT) lastT = x.t
  for (const x of current) if (x.t > lastT) lastT = x.t

  // Never persisted across a restart: a chunk's byte count lives only in the
  // job record, and a duplicate heartbeat or dial error is only ever compared
  // against what THIS process has already written.
  const chunkAcc = new Map()
  const pullAcc = new Map()
  const lastErrorByKey = new Map()
  const helloByKey = new Map()

  const digest = () => {
    const all = older.concat(current)
    const byKind = {}, byPeer = {}, redByKind = {}
    let redRows = 0, redTotal = 0, since = null, lastAt = null
    for (const x of all) {
      byKind[x.k] = (byKind[x.k] ?? 0) + 1
      if (x.p) byPeer[x.p] = (byPeer[x.p] ?? 0) + 1
      if (x.rn > 0) { redRows += 1; redTotal += x.rn }
      for (const [k, v] of Object.entries(x.rk)) redByKind[k] = (redByKind[k] ?? 0) + v
      if (since === null || x.t < since) since = x.t
      if (lastAt === null || x.t > lastAt) lastAt = x.t
    }
    return {
      count: all.length,
      since, lastAt,
      byKind, byPeer,
      redactions: { rows: redRows, total: redTotal, byKind: redByKind },
      refused: refusedCount,
      repeats: repeatsTotal,
      skipped,
    }
  }

  let modeTightened = false
  const writeRow = (row) => {
    const text = JSON.stringify(row) + '\n'
    const rowBytes = Buffer.byteLength(text, 'utf8')
    try {
      mkdirSync(dir, { recursive: true })
      if (lines >= ROTATE_LINES || bytes >= ROTATE_BYTES) {
        renameSync(currentPath, rotatedPath)
        older = current
        current = []
        lines = 0
        bytes = 0
      }
      // The log carries asks' text and rosters, so it is owner-only like the
      // pairing store. `mode` applies only when the append creates the file,
      // so a log an older build left readable is tightened on the first row.
      appendFileSync(currentPath, text, { mode: 0o600 })
      if (!modeTightened) { chmodSync(currentPath, 0o600); modeTightened = true }
    } catch (err) {
      process.stderr.write(`peer wire log: a row was not recorded: ${err?.message ?? err}\n`)
      return false
    }
    lines += 1
    bytes += rowBytes
    current.push(tupleOf(row))
    try { onAppend(headOf(row), digest()) } catch (err) { process.stderr.write(`peer wire log: onAppend threw: ${err?.stack || err}\n`) }
    return true
  }

  /** Answers the written row, or null when the exchange was folded into an
   *  existing chunk roll-up, suppressed as a repeat, or could not be
   *  written at all. */
  const exchange = (e) => {
    const dir2 = e.dir
    const route = e.route
    const peer = e.peer ?? null
    const errorStr = typeof e.error === 'string' && e.error.length > 0 ? e.error.slice(0, 400) : null
    const status = Number.isFinite(e.status) ? e.status : null
    const kind = errorStr || status !== 200 ? 'error' : (ROUTE_KINDS[route] ?? 'other')
    const key = `${peer ?? ''}\n${dir2}\n${route}`

    // A pull is a chunk fetched rather than pushed. Each file's first pull is
    // written; every later one is counted, and the count rides on the drop's
    // next written pull, so a large file is one row rather than one a mebibyte.
    let pulled = null
    if (route === '/peer/drop/pull' && kind !== 'error') {
      const pullKey = `${dir2}\n${dropIdOf(e.req, e.query)}`
      const acc = pullAcc.get(pullKey) ?? { chunks: 0, bytes: 0 }
      const got = Number.isFinite(e.resBytes) ? e.resBytes : 0
      const offset = e.req && typeof e.req === 'object' ? Number(e.req.offset) : NaN
      if (Number.isFinite(offset) && offset > 0) {
        pullAcc.set(pullKey, { chunks: acc.chunks + 1, bytes: acc.bytes + got })
        return null
      }
      pulled = acc.chunks > 0 ? acc : null
      pullAcc.set(pullKey, { chunks: 1, bytes: got })
    }

    if (kind === 'chunk') {
      const dropId = dropIdOf(e.req, e.query)
      const acc = chunkAcc.get(dropId) ?? { chunks: 0, bytes: 0 }
      acc.chunks += 1
      acc.bytes += Number.isFinite(e.reqBytes) ? e.reqBytes : 0
      chunkAcc.set(dropId, acc)
      return null
    }

    if (kind === 'error') {
      if (lastErrorByKey.get(key) === errorStr) return null
      lastErrorByKey.set(key, errorStr)
    } else {
      lastErrorByKey.delete(key)
    }

    let repeatsForRow = 0
    if (kind === 'hello') {
      const content = helloContentOf(e.req, e.res)
      const prev = helloByKey.get(key)
      if (prev && prev.content === content) {
        prev.repeats += 1
        repeatsTotal += 1
        return null
      }
      repeatsForRow = prev ? prev.repeats : 0
      helloByKey.set(key, { content, repeats: 0 })
    }

    let chunks = pulled
    if (route === '/peer/drop/commit') {
      const dropId = dropIdOf(e.req, e.query)
      if (chunkAcc.has(dropId)) {
        chunks = chunkAcc.get(dropId)
        chunkAcc.delete(dropId)
      }
    }

    const reqHalf = halfOf(e.req)
    const resHalf = halfOf(e.res)
    const reqBytes = Number.isFinite(e.reqBytes) ? e.reqBytes : reqHalf.bytes
    const resBytes = Number.isFinite(e.resBytes) ? e.resBytes : resHalf.bytes
    const summary = summarize({ route, kind, req: e.req, res: e.res, error: errorStr, chunks })

    const t = Math.max(now(), lastT + 1)
    const row = {
      t, dir: dir2, peer, route, kind, status,
      rttMs: Number.isFinite(e.rttMs) ? e.rttMs : null,
      reqBytes, resBytes,
      req: reqHalf.text, res: resHalf.text,
      reqClipped: reqHalf.clipped, resClipped: resHalf.clipped,
      redactions: normalizeRedactions(e.redactions),
      safeguard: e.safeguard === 'off' || e.safeguard === 'exempt' ? e.safeguard : 'on',
      summary, repeats: repeatsForRow, error: errorStr, chunks,
    }

    if (!writeRow(row)) return null
    lastT = t
    return row
  }

  const refused = () => { refusedCount += 1 }

  const read = ({ before = NaN, since = NaN, kind = '', peer = '', q = '', limit = NaN } = {}) => {
    const n = Number.isFinite(limit) && limit > 0 ? Math.min(READ_LIMIT_MAX, Math.floor(limit)) : READ_LIMIT_DEFAULT
    const needle = q ? String(q).toLowerCase() : ''
    const rows = []
    const take = (r) => { if (r) rows.push(r) }
    scan(rotatedPath, take)
    scan(currentPath, take)
    const hits = rows.filter((r) => {
      if (kind && r.kind !== kind) return false
      if (peer && r.peer !== peer) return false
      if (Number.isFinite(since) && r.t < since) return false
      if (Number.isFinite(before) && r.t >= before) return false
      if (needle && !r.summary.toLowerCase().includes(needle)) return false
      return true
    })
    hits.sort((a, b) => b.t - a.t)
    const items = hits.slice(0, n).map(headOf)
    return { items, next: hits.length > n ? items[items.length - 1].t : null }
  }

  const get = (t) => {
    const target = Number(t)
    let found = null
    const take = (r) => { if (r && r.t === target) found = r }
    scan(rotatedPath, take)
    scan(currentPath, take)
    return found
  }

  return { exchange, refused, read, get, digest }
}

/** The per-peer redaction switch: exceptions only, so absence means on. No
 *  peer route can reach it -- only the relay's own `/api/peer-wire/redact`
 *  writes here. */
export const createWireSettings = ({ dir, now = Date.now } = {}) => {
  const file = join(dir, WIRE_SETTINGS_FILE)
  let redactOff = new Set()

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('peer-wire.json is not an object')
    for (const v of Array.isArray(raw.redactOff) ? raw.redactOff : []) {
      const fp = typeof v === 'string' ? v.toUpperCase() : ''
      if (FP_RE.test(fp)) redactOff.add(fp)
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      const aside = `${file}.corrupt-${now()}`
      try {
        renameSync(file, aside)
        process.stderr.write(`peer wire settings: ${file} failed to load (${err.message}); moved aside to ${aside} and starting with every peer on\n`)
      } catch (renameErr) {
        process.stderr.write(`peer wire settings: ${file} failed to load (${err.message}); could not move it aside (${renameErr.message}) -- starting with every peer on, original left in place\n`)
      }
    }
    redactOff = new Set()
  }

  const flush = () => {
    const text = JSON.stringify({ version: 1, redactOff: [...redactOff].sort() })
    const tmp = file + '.tmp'
    mkdirSync(dir, { recursive: true })
    try {
      writeFileSync(tmp, text)
      renameSync(tmp, file)
    } catch (err) {
      try { unlinkSync(tmp) } catch {}
      throw err
    }
  }

  return {
    isOn: (fp) => !(typeof fp === 'string' && redactOff.has(fp.toUpperCase())),
    set: (fpRaw, on) => {
      const fp = typeof fpRaw === 'string' ? fpRaw.toUpperCase() : ''
      if (!FP_RE.test(fp)) throw new Error('not a valid peer fingerprint')
      if (on) redactOff.delete(fp)
      else redactOff.add(fp)
      flush()
      return [...redactOff].sort()
    },
    off: () => [...redactOff].sort(),
  }
}

/** Joins the log and the switch store to the redactor: every body a peer is
 *  about to receive goes through `outbound` first, and every exchange that
 *  completes -- whatever `outbound` decided -- is handed to `record`. */
export const createWireTap = ({ log, settings, context, peerNameOf, redact = redactOutbound }) => ({
  outbound({ route, fingerprint }, body) {
    if (route === '/peer/pair') return { body, redactions: { n: 0, kinds: {} }, safeguard: 'exempt' }
    if (!settings.isOn(fingerprint)) return { body, redactions: { n: 0, kinds: {} }, safeguard: 'off' }
    const r = redact(body, context())
    return { body: r.value, redactions: { n: r.n, kinds: r.kinds }, safeguard: 'on' }
  },
  record(e) {
    let peer = e.peer ?? (peerNameOf ? peerNameOf(e.fingerprint ?? null) : null)
    if (!peer && e.route === '/peer/pair') {
      peer = e.dir === 'out' ? (e.res && e.res.name) : (e.req && e.req.name)
    }
    const { fingerprint, ...rest } = e
    return log.exchange({ ...rest, peer: peer ?? '?' })
  },
  refused() {
    log.refused()
  },
})
