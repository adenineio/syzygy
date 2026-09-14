// Peering's durable state: two files, kept apart for two different reasons,
// and the certificate the listener serves.
//
// `peers.json` holds the secrets -- every pairing's derived key and pinned
// fingerprint -- at mode 0600. It changes when a pairing, a confirmation or a
// policy changes, which is rarely. `peer-asks.json` holds the ask log, which
// changes every time an ask moves between states. Keeping them apart means
// the secrets file is never rewritten just because an ask was answered.
//
// Both are AUTHORITATIVE, not derived: a pairing secret or an ask exists
// nowhere else. So every write serializes first, goes to a temp file in the
// same directory and is renamed over the target, and a file that exists but
// will not parse is moved aside rather than overwritten by the next write.
// Starting empty is recoverable; destroying the only copy is not.
//
// The certificate is minted by `openssl` the first time peering is enabled
// and never again while both of its files exist, because every paired peer
// has pinned its fingerprint and a new one would silently unpair them all.

import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, existsSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes, X509Certificate } from 'node:crypto'
import {
  validName, selfNameFrom, fpBytes, opensslArgv,
  DEFAULT_POLICY, DEFAULT_PEER_PORT,
  ASK_EDGES, canTransition, isTerminalAsk,
  ASK_KEEP_PER_PEER, STALL_MS, ASK_TEXT_MAX,
} from './peer.mjs'

export const PEERS_FILE = 'peers.json'
export const ASKS_FILE = 'peer-asks.json'
export const KEY_FILE = 'peer-key.pem'
export const CERT_FILE = 'peer-cert.pem'

const SECRET_RE = /^[0-9a-f]{64}$/
const ASK_ID_RE = /^[0-9a-f]{16,64}$/
const POLICY_MAX = 1000

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const strOrNull = (v) => (typeof v === 'string' ? v : null)
const numOrNull = (v) => (Number.isFinite(v) ? v : null)

/** Fingerprints are compared and displayed in node's own uppercase form, so a
 *  hand-edited lowercase one is folded rather than refused. */
const fpOrNull = (fp) => (fpBytes(fp) ? fp.toUpperCase() : null)

/** One stderr line either way. If the rename itself fails the original is
 *  left where it is, and the caller still starts empty. */
const moveAside = (label, file, err, now) => {
  const aside = `${file}.corrupt-${now()}`
  try {
    renameSync(file, aside)
    process.stderr.write(`${label}: ${file} failed to load (${err.message}); moved aside to ${aside} and starting empty\n`)
  } catch (renameErr) {
    process.stderr.write(`${label}: ${file} failed to load (${err.message}); could not move it aside (${renameErr.message}) -- starting empty, original left in place\n`)
  }
}

// ---- peers.json -------------------------------------------------------------

export const emptyPeers = (hostname) => ({
  version: 1,
  self: selfNameFrom(hostname),
  enabled: false,
  bind: null,
  port: DEFAULT_PEER_PORT,
  fingerprint: null,
  peers: [],
})

/** A policy value outside the range is pulled back into it; one of the wrong
 *  type is the default. Either way a consumer always reads two numbers. */
const sanitizePolicy = (p) => {
  const o = isPlainObject(p) ? p : {}
  return {
    asksPerHour: Number.isInteger(o.asksPerHour) ? clamp(o.asksPerHour, 0, POLICY_MAX) : DEFAULT_POLICY.asksPerHour,
    peerAskDailyCapUsd: Number.isFinite(o.peerAskDailyCapUsd) ? clamp(o.peerAskDailyCapUsd, 0, POLICY_MAX) : DEFAULT_POLICY.peerAskDailyCapUsd,
  }
}

const sanitizeAddress = (a) =>
  isPlainObject(a) && typeof a.host === 'string' && a.host.length > 0 && a.host.length <= 253 &&
  Number.isInteger(a.port) && a.port >= 1 && a.port <= 65535
    ? { host: a.host, port: a.port }
    : null

/** A record without a usable name, fingerprint or secret cannot sign or
 *  verify anything, so it is dropped rather than carried as a peer that
 *  looks paired and never works. */
const sanitizePeer = (p) => {
  if (!isPlainObject(p) || !validName(p.name) || !validName(p.remoteName)) return null
  const fingerprint = fpOrNull(p.fingerprint)
  if (!fingerprint || typeof p.secret !== 'string' || !SECRET_RE.test(p.secret)) return null
  return {
    name: p.name,
    remoteName: p.remoteName,
    address: sanitizeAddress(p.address),
    fingerprint,
    certPem: strOrNull(p.certPem),
    secret: p.secret,
    pairedAt: numOrNull(p.pairedAt),
    confirmedAt: numOrNull(p.confirmedAt),
    policy: sanitizePolicy(p.policy),
  }
}

const sanitizePeers = (raw, hostname) => {
  const peers = []
  const names = new Set()
  for (const p of Array.isArray(raw.peers) ? raw.peers : []) {
    const rec = sanitizePeer(p)
    // The name is a route segment and a lookup key; the first record wins.
    if (!rec || names.has(rec.name)) continue
    names.add(rec.name)
    peers.push(rec)
  }
  return {
    version: 1,
    self: validName(raw.self) ? raw.self : selfNameFrom(hostname),
    enabled: raw.enabled === true,
    bind: strOrNull(raw.bind),
    port: Number.isInteger(raw.port) && raw.port >= 0 && raw.port <= 65535 ? raw.port : DEFAULT_PEER_PORT,
    fingerprint: fpOrNull(raw.fingerprint),
    peers,
  }
}

/** Absent is the ordinary first run. Present but unparseable -- or parseable
 *  but not an object -- is moved aside, so the next `writePeers` cannot
 *  destroy secrets someone may still be able to recover by hand. */
export const readPeers = (dir, { hostname, now = Date.now } = {}) => {
  const file = join(dir, PEERS_FILE)
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!isPlainObject(raw)) throw new Error('peers.json is not an object')
  } catch (err) {
    if (err.code !== 'ENOENT') moveAside('peers store', file, err, now)
    return emptyPeers(hostname)
  }
  return sanitizePeers(raw, hostname)
}

/** Serialize first, so a doc that cannot be stringified never touches the
 *  disk. The temp file is created 0600 and chmodded again, because `mode`
 *  only applies when a file is created and a leftover temp file keeps
 *  whatever mode it already had. */
export const writePeers = (dir, doc) => {
  const file = join(dir, PEERS_FILE)
  const tmp = file + '.tmp'
  const text = JSON.stringify(doc, null, 2)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(tmp, text, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
  return doc
}

// ---- the certificate --------------------------------------------------------

/** Mints only when the pair of files is incomplete. `bind` matters only at
 *  mint time: an existing certificate is served as it is, whatever the bind
 *  is now, because the fingerprint is what peers pin and the names inside it
 *  are never checked. The key is chmodded on every call, so a key someone
 *  loosened is tightened again the next time peering is enabled. */
export const ensureCert = async ({ dir, bind, run, opensslBin = 'openssl' }) => {
  const keyPath = join(dir, KEY_FILE)
  const certPath = join(dir, CERT_FILE)
  let minted = false
  if (!(existsSync(keyPath) && existsSync(certPath))) {
    mkdirSync(dir, { recursive: true })
    const r = await run(opensslBin, opensslArgv({ keyPath, certPath, bind }), { timeout: 60_000 })
    if (r?.code === 'ENOENT') throw new Error('peering needs openssl, and none was found on PATH — install the openssl package')
    if (r?.code !== 0) throw new Error('openssl failed: ' + String(r?.stderr ?? '').slice(0, 400))
    minted = true
  }
  chmodSync(keyPath, 0o600)
  const keyPem = readFileSync(keyPath, 'utf8')
  const certPem = readFileSync(certPath, 'utf8')
  const fingerprint = new X509Certificate(certPem).fingerprint256
  return { certPem, keyPem, fingerprint, minted }
}

// ---- peer-asks.json ---------------------------------------------------------

/** Every state an entry may rest in, per direction: the ones with outgoing
 *  edges, plus the two terminals. */
const STATES = {
  out: [...Object.keys(ASK_EDGES.out), 'answered', 'failed'],
  in: [...Object.keys(ASK_EDGES.in), 'answered', 'failed'],
}

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0)
const bool = (v) => v === true

/** How each patchable field is coerced, shared by load and by every write, so
 *  an entry in memory never holds a value the next load would read back
 *  differently. */
const FIELDS = {
  reply: strOrNull,
  error: strOrNull,
  startedAt: numOrNull,
  answeredAt: numOrNull,
  costUsd: (v) => (Number.isFinite(v) && v >= 0 ? v : 0),
  actionsProposed: count,
  attempts: count,
  nextAttemptAt: numOrNull,
  override: bool,
  delivered: bool,
}
const TRANSITION_KEYS = ['reply', 'error', 'startedAt', 'answeredAt', 'costUsd', 'actionsProposed', 'attempts', 'nextAttemptAt', 'override']
const SET_KEYS = [...TRANSITION_KEYS, 'delivered']

const outSeqOf = (v) => (Number.isInteger(v) && v > 0 ? v : null)

/** An entry a consumer would reach into unguarded -- no id, an unknown
 *  direction, a state that direction cannot be in, no peer -- is dropped.
 *  Everything else is coerced field by field. */
const sanitizeEntry = (e) => {
  if (!isPlainObject(e) || typeof e.id !== 'string' || typeof e.peer !== 'string') return null
  if (!Object.hasOwn(STATES, e.dir) || !STATES[e.dir].includes(e.state)) return null
  const out = {
    id: e.id,
    askId: strOrNull(e.askId),
    peer: e.peer,
    dir: e.dir,
    text: typeof e.text === 'string' ? e.text : '',
    state: e.state,
    t: numOrNull(e.t),
    updatedAt: numOrNull(e.updatedAt),
    outSeq: outSeqOf(e.outSeq),
  }
  for (const k of SET_KEYS) out[k] = FIELDS[k](e[k])
  return out
}

const applyPatch = (e, patch, keys) => {
  if (!isPlainObject(patch)) return
  for (const k of keys) if (Object.hasOwn(patch, k)) e[k] = FIELDS[k](patch[k])
}

export const createAsksStore = ({ file, now = Date.now }) => {
  /** @type {any[]} */ let items = []
  let seq = 0
  let dirty = false

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(raw?.items)) {
      items = raw.items.map(sanitizeEntry).filter(Boolean)
      seq = Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0
    } else {
      throw new Error('peer-asks.json has no items array')
    }
  } catch (err) {
    items = []
    seq = 0
    // A missing file is the ordinary first run. A file that EXISTS but failed
    // to parse is moved aside rather than silently overwritten by the next
    // flush.
    if (err.code !== 'ENOENT') moveAside('peer asks store', file, err, now)
  }
  // A counter behind an entry that already carries a sequence number would
  // hand the next outbound entry a number the peer has already acknowledged,
  // and it would never be delivered.
  for (const e of items) if (e.outSeq !== null && e.outSeq > seq) seq = e.outSeq

  const get = (id) => items.find((e) => e.id === id) ?? null
  const find = (peer, dir, askId) => items.find((e) => e.peer === peer && e.dir === dir && e.askId === askId) ?? null

  const must = (id) => {
    const e = get(id)
    if (!e) throw new Error(`no such ask ${id}`)
    return e
  }

  const freshId = () => {
    let id
    do id = randomBytes(8).toString('hex')
    while (get(id))
    return id
  }

  /** Keeps the newest entries for one peer by `t`, a later position breaking
   *  a tie. Only a terminal entry is ever dropped: one still in flight stays,
   *  even past the limit, because a reply may yet arrive for it. */
  const prune = (peer) => {
    const mine = items.map((e, i) => [e, i]).filter(([e]) => e.peer === peer)
    if (mine.length <= ASK_KEEP_PER_PEER) return []
    mine.sort(([a, ai], [b, bi]) => (b.t ?? 0) - (a.t ?? 0) || bi - ai)
    const drop = new Set(mine.slice(ASK_KEEP_PER_PEER).map(([e]) => e).filter((e) => isTerminalAsk(e.state)))
    if (drop.size === 0) return []
    items = items.filter((e) => !drop.has(e))
    dirty = true
    return [...drop]
  }

  const flush = () => {
    if (!dirty) return
    // Serialize FIRST. If this throws, nothing has been written and the
    // previous file is still the previous file.
    const text = JSON.stringify({ version: 1, seq, items })
    const tmp = file + '.tmp'
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, text)
      renameSync(tmp, file)
      dirty = false
    } catch (err) {
      try { unlinkSync(tmp) } catch {}
      throw err
    }
  }

  return {
    get dirty() { return dirty },
    all: () => items,
    get,
    find,

    /** An outgoing ask mints its own wire id; an incoming one must carry the
     *  sender's, because that id is how the reply finds its way back. The
     *  same ask recorded twice would be answered twice, so a repeat of a
     *  (peer, dir, askId) is refused here -- a receiver checks `find` first
     *  and treats a repeat as already accepted. */
    create({ peer, dir, askId, text } = {}) {
      if (typeof peer !== 'string' || peer === '') throw new Error('an ask needs a peer')
      if (dir !== 'out' && dir !== 'in') throw new Error('an ask must go out or come in')
      if (typeof text !== 'string' || text.length === 0 || text.length > ASK_TEXT_MAX) {
        throw new Error(`ask text must be 1 to ${ASK_TEXT_MAX} characters`)
      }
      if (dir === 'out' && (askId === undefined || askId === null)) askId = randomBytes(8).toString('hex')
      if (typeof askId !== 'string' || !ASK_ID_RE.test(askId)) throw new Error('an askId must be 16 to 64 lowercase hex characters')
      if (find(peer, dir, askId)) throw new Error(`ask ${askId} from ${peer} is already recorded`)
      const t = now()
      const e = {
        id: freshId(),
        askId, peer, dir, text,
        reply: null,
        error: null,
        state: dir === 'out' ? 'queued' : 'received',
        t,
        updatedAt: t,
        startedAt: null,
        answeredAt: null,
        costUsd: 0,
        actionsProposed: 0,
        attempts: 0,
        nextAttemptAt: null,
        override: false,
        outSeq: null,
        delivered: false,
      }
      items.push(e)
      dirty = true
      prune(peer)
      return e
    },

    /** The only path that changes `state`. An edge the direction does not
     *  have throws before anything is touched, patch included. */
    transition(id, to, patch = {}) {
      const e = must(id)
      if (!canTransition(e.dir, e.state, to)) throw new Error(`illegal ask transition ${e.dir} ${e.state} -> ${to}`)
      applyPatch(e, patch, TRANSITION_KEYS)
      e.state = to
      e.updatedAt = now()
      dirty = true
      return e
    },

    /** Bookkeeping that is not a state change. `updatedAt` is left alone, so a
     *  retry counter ticking over does not reset the stall clock. */
    set(id, patch = {}) {
      const e = must(id)
      applyPatch(e, patch, SET_KEYS)
      dirty = true
      return e
    },

    /** Puts an entry on the queue the other side collects with its next
     *  heartbeat. Sequence numbers are per store, not per peer, and only ever
     *  grow, so an acknowledgement up to N can never cover an entry queued
     *  after it. */
    enqueueOutbound(id) {
      const e = must(id)
      seq += 1
      e.outSeq = seq
      e.delivered = false
      dirty = true
      return seq
    },

    outboundFor(peer, afterSeq) {
      const after = Number.isFinite(afterSeq) ? afterSeq : 0
      return items
        .filter((e) => e.peer === peer && e.outSeq !== null && e.outSeq > after && e.delivered === false)
        .sort((a, b) => a.outSeq - b.outSeq)
    },

    ackOutbound(peer, uptoSeq) {
      if (!Number.isFinite(uptoSeq)) return []
      const acked = items.filter((e) => e.peer === peer && e.outSeq !== null && e.outSeq <= uptoSeq)
      for (const e of acked) {
        if (e.delivered) continue
        e.delivered = true
        dirty = true
      }
      return acked
    },

    /** The history stays; the name is changed to one no live peer can carry
     *  (a space is outside the name charset), so pairing again under the same
     *  name starts a clean log. */
    markForgotten(name) {
      const moved = items.filter((e) => e.peer === name)
      for (const e of moved) e.peer = `${name} (forgotten)`
      if (moved.length) dirty = true
      return moved
    },

    prune,

    /** Every non-terminal state has an edge to `failed`, so this assigns the
     *  state directly rather than going through `transition`. */
    sweepStalled() {
      const t = now()
      const moved = []
      for (const e of items) {
        if (isTerminalAsk(e.state) || t - (e.updatedAt ?? 0) <= STALL_MS) continue
        e.state = 'failed'
        e.error = 'stalled'
        e.updatedAt = t
        moved.push(e)
      }
      if (moved.length) dirty = true
      return moved
    },

    flush,
  }
}
