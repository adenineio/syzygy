// The peering wire: every byte-level rule two relays have to agree on, and
// nothing else. Pure -- no socket, no file, no timer; the clock and the
// randomness are the only inputs it reaches for on its own, and both can be
// passed in. peer-listener.mjs and peer-link.mjs are the consumers.
//
// A signed request is an HMAC over a canonical string, not over the raw
// request, because the raw request is not stable across a hop: header order,
// header case and query order all change without the meaning changing. The
// canonical string carries the SHA-256 of the body rather than the body
// itself, so the listener can hash the bytes it actually received and never
// has to trust a parsed-and-reserialised copy to match what was signed.
//
// Every check in this file answers a boolean or `null`, never a throw. The
// listener turns every refusal into the same empty 404, and a thrown error
// halfway through a verification is exactly the kind of difference in
// behaviour a prober could time or tell apart.

import { createHmac, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { posix } from 'node:path'

// ---- constants --------------------------------------------------------------

export const PEER_NAME_RE = /^[a-z0-9-]{1,32}$/
export const REPLAY_WINDOW_MS = 120_000
export const NONCE_CACHE_CAP = 10_000
export const PAIR_TOKEN_MS = 15 * 60_000
export const HELLO_MS = 15_000
export const DEFAULT_PEER_PORT = 4318
export const TRUST_TIERS = Object.freeze(['manual', 'sanctioned'])
/** The kinds a sanctioned peer's liaison turn may apply without a click.
 *  `arm_resume` arms a machine-wide behaviour and `peer_ask` can close a loop
 *  between two instances, so neither is ever here. */
export const AUTO_APPLY_KINDS = Object.freeze(['spawn', 'prompt', 'dispatch', 'drop', 'link'])
export const PROPOSAL_KINDS = Object.freeze(['link', 'prompt', 'dispatch', 'spawn', 'drop', 'peer_ask'])
export const MAX_LIVE_CAP = 50
const POLICY_NUM_MAX = 1000
export const DEFAULT_POLICY = Object.freeze({
  asksPerHour: 20, peerAskDailyCapUsd: 2,
  trust: 'manual', autoApply: Object.freeze([]), autoApplyMaxLive: 2, peerAsksPerHour: 6,
})
export const DEFAULT_RETRY_MS = Object.freeze([5000, 15000, 45000])
export const STALL_MS = 24 * 3600_000
export const ASK_KEEP_PER_PEER = 500
export const ASK_TEXT_MAX = 20_000
/** The key-derivation label. A wire constant: both relays must derive with
 *  the same string or a pairing that otherwise succeeds yields two secrets
 *  that never verify each other's requests. */
export const HKDF_INFO = 'szg-peer-v1/secret'
export const PAIR_PREFIX = 'szg1'
export const DROP_FILE_CAP = 2000
export const DROP_BYTE_CAP = 2 * 1024 ** 3
export const FILTER_TIMEOUT_MS = 10 * 60_000
export const FILTER_KILL_GRACE_MS = 5000
export const FILTER_STDERR_MAX = 2048

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const SKEW_WARN_MS = 60_000
const ROSTER_MAX = 100

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---- names and binds --------------------------------------------------------

/** A peer name is a path segment on the loopback routes and a display key in
 *  the pane, so the charset is closed: no dot, no slash, no case to fold. */
export const validName = (s) => typeof s === 'string' && PEER_NAME_RE.test(s)

/** The default name an instance calls itself: the hostname, folded into the
 *  name charset. A hostname with nothing usable in it falls back to a fixed
 *  word rather than an empty name the regex would refuse. */
export const selfNameFrom = (hostname) => {
  const s = String(hostname ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return s || 'syzygy'
}

/** Every spelling of "all interfaces" node will accept: the IPv4 wildcard,
 *  any all-zero IPv6 form, and the IPv4 wildcard mapped into IPv6. */
const isWildcard = (bind) =>
  bind === '0.0.0.0' || (isIP(bind) === 6 && (/^[0:]+$/.test(bind) || /^::ffff:0\.0\.0\.0$/i.test(bind)))

/** The peer listener binds an address, never a hostname: a hostname resolves
 *  to whatever DNS answers at boot, which is not a decision anyone made. A
 *  wildcard exposes the listener on every interface, including ones that did
 *  not exist when it was enabled, so it has to be asked for separately. */
export const validBind = (bind, { allowAny = false } = {}) => {
  if (typeof bind !== 'string' || isIP(bind) === 0) return { ok: false, error: 'bind must be an IP address' }
  if (isWildcard(bind) && !allowAny) return { ok: false, error: 'binding every interface needs SZG_PEER_BIND_ANY=1' }
  return { ok: true }
}

// ---- the canonical string and its signature ---------------------------------

export const sha256hex = (b) => createHash('sha256').update(b ?? '').digest('hex')

/** Pairs sorted by key then value, each side percent-encoded, joined by `&`.
 *  Sorting by value as well as key is what makes a repeated key canonical. */
export const sortedQuery = (q) => {
  const params = q instanceof URLSearchParams ? q : new URLSearchParams(typeof q === 'string' ? q.replace(/^\?/, '') : '')
  return [...params].sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&')
}

/** The `?` is always present, so an empty query and a missing one sign the
 *  same bytes and a query cannot be smuggled in by moving the separator. */
export const canonicalString = ({ method, path, query = '', ts, nonce, bodySha256 }) =>
  `${method}\n${path}?${sortedQuery(query)}\n${ts}\n${nonce}\n${bodySha256}`

/** `body` must be the exact bytes or string that go on the wire: the hash is
 *  taken here, and the listener hashes what it receives. */
export const signRequest = ({ secret, self, method, path, query = '', body = '', now = Date.now(), nonce = randomBytes(16).toString('hex') }) => {
  const bodySha256 = sha256hex(body)
  const ts = String(now)
  const canonical = canonicalString({ method, path, query, ts, nonce, bodySha256 })
  const sig = createHmac('sha256', secret).update(canonical).digest('hex')
  return {
    headers: { 'x-szg-peer': self, 'x-szg-ts': ts, 'x-szg-nonce': nonce, 'x-szg-sig': sig },
    canonical,
    bodySha256,
  }
}

const ZERO = Buffer.alloc(32)
const SIG_RE = /^[0-9a-f]{64}$/

/** The HMAC is ALWAYS computed, against a zero key when there is no usable
 *  secret and against a filler when the signature is not well-formed hex, so
 *  an unknown peer, a malformed header and a wrong signature all cost the same
 *  work. The comparison is `timingSafeEqual` over equal-length buffers; the
 *  cheap checks are folded in only after it. */
export const verifySignature = ({ secret, method, path, query, headers, bodySha256 }) => {
  try {
    const key = Buffer.isBuffer(secret) && secret.length === 32 ? secret : ZERO
    const h = headers ?? {}
    const canonical = canonicalString({
      method, path, query,
      ts: String(h['x-szg-ts'] ?? ''),
      nonce: String(h['x-szg-nonce'] ?? ''),
      bodySha256,
    })
    const expected = createHmac('sha256', key).update(canonical).digest()
    const sig = String(h['x-szg-sig'] ?? '')
    const wellFormed = SIG_RE.test(sig)
    const got = wellFormed ? Buffer.from(sig, 'hex') : Buffer.alloc(32, 0xff)
    return timingSafeEqual(expected, got) && key !== ZERO && wellFormed
  } catch {
    return false
  }
}

// ---- the replay guard -------------------------------------------------------

/** A timestamp outside the window is stale; inside it, a nonce is good once.
 *  A nonce is remembered for twice the window from when it was seen, which
 *  covers the latest timestamp that could still be accepted -- one stamped a
 *  full window in the future stays inside the window for another full window.
 *  The Map's insertion order is arrival order, so both the age sweep and the
 *  cap evict from the front. The caller verifies the signature BEFORE calling
 *  `check`, so a forged request can never burn a real nonce. */
export const createReplayGuard = ({ windowMs = REPLAY_WINDOW_MS, cap = NONCE_CACHE_CAP, now = Date.now } = {}) => {
  const seen = new Map()
  return {
    check(ts, nonce) {
      const tsStr = String(ts ?? '')
      if (!/^\d{1,16}$/.test(tsStr)) return { ok: false, reason: 'ts' }
      const t = now()
      if (Math.abs(Number(tsStr) - t) > windowMs) return { ok: false, reason: 'stale' }
      const n = String(nonce ?? '')
      if (!/^[0-9a-f]{32}$/.test(n)) return { ok: false, reason: 'nonce' }
      if (seen.has(n)) return { ok: false, reason: 'replay' }
      for (const [k, at] of seen) {
        if (t - at > 2 * windowMs) seen.delete(k)
        else break
      }
      while (seen.size >= cap) seen.delete(seen.keys().next().value)
      seen.set(n, t)
      return { ok: true }
    },
    size: () => seen.size,
  }
}

// ---- fingerprints -----------------------------------------------------------

const FP_RE = /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31}$/

/** node's `fingerprint256` form: 32 colon-separated hex pairs. Anything else,
 *  including a fingerprint of some other length, is `null`. */
export const fpBytes = (fp) => (typeof fp === 'string' && FP_RE.test(fp) ? Buffer.from(fp.replace(/:/g, ''), 'hex') : null)

export const fpEqual = (a, b) => {
  const x = fpBytes(a), y = fpBytes(b)
  return !!x && !!y && timingSafeEqual(x, y)
}

// ---- pair codes -------------------------------------------------------------

const B64URL_RE = /^[A-Za-z0-9_-]+$/

/** `szg1.<base64url JSON {host,port,fp}>.<base64url token>`. Encodes whatever
 *  it is given and validates nothing: `parsePairCode` is the one gate, so a
 *  code built from bad parts is refused on the way in rather than here. */
export const formatPairCode = ({ host, port, fp, token }) => {
  const tok = Buffer.isBuffer(token) ? token : Buffer.from(String(token ?? ''))
  return `${PAIR_PREFIX}.${Buffer.from(JSON.stringify({ host, port, fp })).toString('base64url')}.${tok.toString('base64url')}`
}

/** A code is typed or pasted by a person, so surrounding whitespace is
 *  forgiven and nothing else is. */
export const parsePairCode = (code) => {
  if (typeof code !== 'string') return null
  const parts = code.trim().split('.')
  if (parts.length !== 3 || parts[0] !== PAIR_PREFIX) return null
  if (!B64URL_RE.test(parts[1]) || !B64URL_RE.test(parts[2])) return null
  let head
  try {
    head = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!isPlainObject(head)) return null
  const { host, port, fp } = head
  if (typeof host !== 'string' || host.length < 1 || host.length > 253) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (!fpBytes(fp)) return null
  const token = Buffer.from(parts[2], 'base64url')
  if (token.length !== 32) return null
  return { host, port, fp: fp.toUpperCase(), token }
}

// ---- the pairing proof and the shared secret --------------------------------

/** A token that is not 32 bytes keys the HMAC with fresh randomness, so it
 *  produces a proof nothing can ever match rather than a throw or a proof
 *  under a guessable key. */
const tokenKey = (token) => (Buffer.isBuffer(token) && token.length === 32 ? token : randomBytes(32))
const fpText = (fp) => String(fp ?? '').toUpperCase()

/** Sent by the accepting side. Both fingerprints are inside the MAC, in a
 *  fixed order, so a proof made for one pair of certificates is useless for
 *  any other -- which is what stops a relay in the middle from forwarding it. */
export const pairProof = (token, offerFp, acceptFp) =>
  createHmac('sha256', tokenKey(token)).update(`pair|${fpText(offerFp)}|${fpText(acceptFp)}`).digest('hex')

/** Returned by the offering side. A different label and the reverse order, so
 *  a proof can never be reflected back as an ack. */
export const pairAck = (token, acceptFp, offerFp) =>
  createHmac('sha256', tokenKey(token)).update(`pair-ack|${fpText(acceptFp)}|${fpText(offerFp)}`).digest('hex')

const HEX_RE = /^(?:[0-9a-f]{2})+$/i

/** Constant-time for equal lengths; anything that is not even-length hex is
 *  simply unequal. */
export const hexEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !HEX_RE.test(a) || !HEX_RE.test(b) || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

/** HKDF-SHA256 over the pairing token, salted with both certificates'
 *  fingerprints in byte order, so either side derives the same 32 bytes
 *  without agreeing on who is first, and the secret is bound to the two
 *  certificates the pairing actually saw. Bad input answers `null`, which
 *  `verifySignature` treats as no secret at all. */
export const derivePairSecret = (token, fpA, fpB) => {
  const a = fpBytes(fpA), b = fpBytes(fpB)
  if (!a || !b || !Buffer.isBuffer(token) || token.length !== 32) return null
  const salt = Buffer.concat([a, b].sort(Buffer.compare))
  return Buffer.from(hkdfSync('sha256', token, salt, HKDF_INFO, 32))
}

// ---- the certificate --------------------------------------------------------

/** A self-signed certificate the peer pins by fingerprint, so the names in it
 *  matter only to a client that checks them. The bind address goes into the
 *  subject alternative names when it is a real, non-loopback address;
 *  loopback is always there already. */
export const opensslArgv = ({ keyPath, certPath, bind }) => {
  const names = ['DNS:localhost', 'IP:127.0.0.1']
  if (typeof bind === 'string' && isIP(bind) !== 0 && bind !== '127.0.0.1') names.unshift(`IP:${bind}`)
  return [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath, '-out', certPath,
    '-days', '3650', '-nodes',
    '-subj', '/CN=syzygy-peer',
    '-addext', `subjectAltName=${names.join(',')}`,
  ]
}

// ---- the ghost roster -------------------------------------------------------

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null)

const ASK_STORE_ID_RE = /^[0-9a-f]{16,64}$/

/** The only shape a stored tag may have: a peer name and the store id of the
 *  ask it came from. A forgotten peer's renamed history fails the name rule, so
 *  its asks tag nothing. */
export const sanitizeForPeer = (v) =>
  isPlainObject(v) && validName(v.peer) && typeof v.askId === 'string' && ASK_STORE_ID_RE.test(v.askId)
    ? { peer: v.peer, askId: v.askId }
    : null

/** Which sessions are working on a peer's behalf, by session id, from the tag
 *  each record stored when its action was applied. The origin wins: a session a
 *  peer's spawn started stays that peer's even when a second peer prompts it. */
export const forPeerIndex = ({ spawnedBy = [], requests = [], sessions = [] } = {}) => {
  const out = new Map()
  const put = (sid, tag) => {
    const t = sanitizeForPeer(tag)
    if (typeof sid === 'string' && sid && t && !out.has(sid)) out.set(sid, t)
  }
  for (const r of Array.isArray(spawnedBy) ? spawnedBy : []) put(r?.sessionId, r?.forPeer)
  for (const r of Array.isArray(requests) ? requests : []) put(r?.session?.sessionId, r?.forPeer)
  for (const s of Array.isArray(sessions) ? sessions : []) put(s?.id, s?.forPeer)
  return out
}

/** How many sessions run here for one peer: the live sessions carrying its tag,
 *  plus its spawns the ledger still counts as live -- starting, not yet ruled
 *  on, or running before their session registers. A spawn whose session is
 *  already one of the tagged live sessions is counted once, as that session.
 *  The ledger's live rule is passed in, so this file needs nothing of the
 *  canvas. */
export const livePeerSessions = ({ peer, sessions = [], spawnedBy = [], isLiveSpawn, now } = {}) => {
  if (!validName(peer)) return 0
  const counted = new Set()
  let n = 0
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (sanitizeForPeer(s?.forPeer)?.peer !== peer) continue
    n += 1
    if (typeof s.id === 'string' && s.id) counted.add(s.id)
  }
  if (typeof isLiveSpawn !== 'function') return n
  for (const r of Array.isArray(spawnedBy) ? spawnedBy : []) {
    if (!isPlainObject(r) || sanitizeForPeer(r.forPeer)?.peer !== peer) continue
    if (typeof r.sessionId === 'string' && counted.has(r.sessionId)) continue
    if (isLiveSpawn(r, now)) n += 1
  }
  return n
}

/** The only view of a session that crosses the link, in both directions: an
 *  allow-list of eight fields, each clipped. Built by copying named fields
 *  rather than deleting unwanted ones, so a field added to the local session
 *  object later can never leak by default. Applied to an incoming roster too,
 *  because the other relay is a different trust domain. */
export const ghostRoster = (sessions, { peer = null } = {}) => {
  if (!Array.isArray(sessions)) return []
  const out = []
  for (const s of sessions) {
    if (out.length >= ROSTER_MAX) break
    if (!isPlainObject(s) || typeof s.id !== 'string' || s.id.length === 0) continue
    out.push({
      id: s.id.slice(0, 64),
      name: clip(s.name, 60),
      model: clip(s.model, 40),
      working: !!s.working,
      needs: typeof s.needs === 'string' ? s.needs.slice(0, 200) : '',
      branch: clip(s.branch, 120),
      root: clip(s.root, 300),
      // Outbound, one boolean per peer: this roster goes to every confirmed
      // peer, and a name on it would tell one peer that another is asking.
      // Inbound there is no peer, and the remote's own boolean is all it keeps.
      forYou: peer ? sanitizeForPeer(s.forPeer)?.peer === peer : s.forYou === true,
    })
  }
  return out
}

// ---- selecting a drop -------------------------------------------------------

const NUL = String.fromCharCode(0)

/** Absolute and already resolved: no empty, `.` or `..` segment and no NUL.
 *  The root check below is a comparison of strings, so a path that still
 *  carried a `..` could name a file outside the root while spelling itself
 *  inside it. */
const resolvedAbs = (p) =>
  typeof p === 'string' && p.startsWith('/') && !p.includes(NUL) &&
  (p === '/' || !p.slice(1).split('/').some((s) => s === '' || s === '.' || s === '..'))

const trimRoot = (r) => (r.length > 1 ? r.replace(/\/+$/, '') : r)

/** Equal to the root, or below it by a whole segment. A bare `startsWith`
 *  would let `/w/appX` pass for `/w/app`. */
const within = (p, root) => p === root || p.startsWith(root === '/' ? '/' : root + '/')

/** The innermost known root, so a file under a root nested in another is
 *  placed relative to the one nearest it. */
const rootOf = (p, roots) => {
  let best = null
  for (const r of roots) if (within(p, r) && (best === null || r.length > best.length)) best = r
  return best
}

const relTo = (p, root) => (p === root ? '' : p.slice(root === '/' ? 1 : root.length + 1))

/** What an injected `stat` answers: `{ file, size, mode }`, `{ dir }`,
 *  `{ symlink }`, `{ other: 'socket' | 'fifo' | 'device' }`, or null. A
 *  symlink is checked first so a descriptor can never be followed by mistake. */
const kindOf = (st) => {
  if (!isPlainObject(st)) return null
  if (st.symlink) return 'symlink'
  if (st.file) return 'file'
  if (st.dir) return 'dir'
  return typeof st.other === 'string' && st.other ? st.other : 'special file'
}

const quietly = (fn, p) => {
  try { return typeof fn === 'function' ? fn(p) : null } catch { return null }
}

/** A drop's files, each relative to the known root it lies in. The caller has
 *  already `realpath`-resolved every input; `stat` must not follow a link and
 *  both it and `readdir` are injected, so this stays free of the disk.
 *
 *  A refused path comes back as `{ path, reason }` beside the files that were
 *  accepted, never silently missing: the caller is free to drop it and send
 *  the rest. Three refusals take the whole input instead, and are marked
 *  `whole: true` so a caller can tell the two apart: more files than the file
 *  cap, more bytes than the byte cap, and two files that would stage at the
 *  same relative path. A drop that quietly sent half its files, or let one
 *  file overwrite another in staging, is worse than one that did not send.
 *  `.git` is left out of a walk at every level. */
export const expandDropPaths = (paths, { roots, stat, readdir, fileCap, byteCap } = {}) => {
  const maxFiles = Number.isSafeInteger(fileCap) && fileCap >= 0 ? fileCap : DROP_FILE_CAP
  const maxBytes = Number.isSafeInteger(byteCap) && byteCap >= 0 ? byteCap : DROP_BYTE_CAP
  const known = (Array.isArray(roots) ? roots : [])
    .filter((r) => typeof r === 'string' && r.startsWith('/'))
    .map(trimRoot)
    .filter(resolvedAbs)
  const whole = (path, reason) => ({ files: [], refused: [{ path, reason, whole: true }] })
  const files = []
  const refused = []
  const taken = new Set()
  const walked = new Set()
  let bytes = 0

  for (const input of Array.isArray(paths) ? paths : []) {
    if (!resolvedAbs(input)) {
      refused.push({ path: typeof input === 'string' ? input : null, reason: 'not an absolute, resolved path' })
      continue
    }
    const root = rootOf(input, known)
    if (root === null) {
      refused.push({ path: input, reason: 'outside every known worktree root' })
      continue
    }
    if (relTo(input, root).split('/').includes('.git')) {
      refused.push({ path: input, reason: 'inside .git, which is never dropped' })
      continue
    }
    const queue = [input]
    for (let i = 0; i < queue.length; i++) {
      const abs = queue[i]
      const st = quietly(stat, abs)
      const kind = kindOf(st)
      if (kind === null) {
        refused.push({ path: abs, reason: 'does not exist' })
      } else if (kind === 'file') {
        if (taken.has(abs)) continue
        const rel = relTo(abs, root)
        if (rel === '') { refused.push({ path: abs, reason: 'a worktree root is a directory, not a file' }); continue }
        if (!Number.isSafeInteger(st.size) || st.size < 0) { refused.push({ path: abs, reason: 'its size could not be read' }); continue }
        taken.add(abs)
        files.push({ root, path: rel, abs, size: st.size, mode: Number.isInteger(st.mode) ? st.mode & 0o777 : null })
        bytes += st.size
        if (files.length > maxFiles) return whole(input, `too many files: more than ${maxFiles}, the file cap for one drop`)
        if (bytes > maxBytes) return whole(input, `too large: more than ${maxBytes} bytes, the byte cap for one drop`)
      } else if (kind === 'dir') {
        if (walked.has(abs)) continue
        walked.add(abs)
        const entries = quietly(readdir, abs)
        if (!Array.isArray(entries)) { refused.push({ path: abs, reason: 'the directory could not be read' }); continue }
        const names = entries.filter((n) => typeof n === 'string').sort()
        for (const name of names) {
          if (name === '.git') continue
          const child = (abs === '/' ? '/' : abs + '/') + name
          if (name === '.' || name === '..' || name === '' || name.includes('/') || name.includes(NUL)) {
            refused.push({ path: child, reason: 'not a plain file name' })
            continue
          }
          queue.push(child)
        }
      } else {
        refused.push({ path: abs, reason: `a ${kind} is never dropped` })
      }
    }
  }

  // Staging lays every file out under one directory by its relative path, so a
  // path used twice, or used as both a file and a directory, would overwrite.
  const byPath = new Map()
  for (const f of files) {
    if (byPath.has(f.path)) return whole(f.abs, `two selected files would both stage as ${f.path}`)
    byPath.set(f.path, f)
  }
  for (const f of files) {
    const segs = f.path.split('/')
    for (let k = 1; k < segs.length; k++) {
      const dir = segs.slice(0, k).join('/')
      if (byPath.has(dir)) return whole(f.abs, `${dir} is a file in one selection and a directory in another`)
    }
  }
  return { files, refused }
}

// ---- ask states -------------------------------------------------------------

/** `out` is an ask this side sent; `in` is one it is answering. `answering`
 *  may fall back to `queued` because a local ask can take the model slot away
 *  from a remote one, which then waits its turn again. */
export const ASK_EDGES = Object.freeze({
  out: Object.freeze({
    queued: Object.freeze(['sent', 'answered', 'failed']),
    sent: Object.freeze(['answered', 'failed']),
  }),
  in: Object.freeze({
    received: Object.freeze(['answering', 'held', 'failed']),
    queued: Object.freeze(['answering', 'held', 'failed']),
    held: Object.freeze(['received', 'failed']),
    answering: Object.freeze(['answered', 'failed', 'queued']),
  }),
})

export const canTransition = (dir, from, to) => {
  if (!Object.hasOwn(ASK_EDGES, dir)) return false
  const edges = ASK_EDGES[dir]
  return Object.hasOwn(edges, from) && edges[from].includes(to)
}

export const isTerminalAsk = (state) => state === 'answered' || state === 'failed'

// ---- job states -------------------------------------------------------------

/** A drop is two records, one per side, never one state machine spanning two
 *  machines: each side can only ever know its own half while the link is
 *  down. `send` is the side offering bytes; `recv` is the side taking them.
 *  `failed` reaches back from every non-terminal state on both ladders, so a
 *  job that dies mid-step always has somewhere to go; `refused`, `sent` and
 *  `landed` close off the rest. */
export const JOB_EDGES = Object.freeze({
  send: Object.freeze({
    queued: Object.freeze(['filtering', 'failed']),
    filtering: Object.freeze(['offering', 'refused', 'failed']),
    offering: Object.freeze(['sending', 'refused', 'failed']),
    sending: Object.freeze(['sent', 'failed']),
  }),
  recv: Object.freeze({
    offered: Object.freeze(['receiving', 'refused', 'failed']),
    receiving: Object.freeze(['verifying', 'failed']),
    verifying: Object.freeze(['filtering', 'failed']),
    filtering: Object.freeze(['landed', 'refused', 'failed']),
  }),
})

export const canJobTransition = (side, from, to) => {
  if (!Object.hasOwn(JOB_EDGES, side)) return false
  const edges = JOB_EDGES[side]
  return Object.hasOwn(edges, from) && edges[from].includes(to)
}

export const isTerminalJob = (state) => state === 'sent' || state === 'landed' || state === 'refused' || state === 'failed'

// ---- the filter script ------------------------------------------------------

/** The user's own filter, run on a drop at either end. An argv array, never a
 *  shell string, with the flags in a fixed order a script can rely on. */
export const filterArgv = ({ filterPath, direction, peer, dropId, inDir, outDir }) =>
  [filterPath, '--direction', direction, '--peer', peer, '--drop', dropId, '--in', inDir, '--out', outDir]

/** What the filter reads on stdin. Each row is copied field by field, so
 *  nothing a caller's row happens to carry -- a source path above all -- ever
 *  reaches the script. */
export const filterManifest = ({ direction, peer, dropId, note, files }) => ({
  version: 1,
  direction,
  peer,
  dropId,
  note: typeof note === 'string' ? note : null,
  files: (Array.isArray(files) ? files : []).filter(isPlainObject).map((f) => ({
    path: f.path,
    size: f.size,
    sha256: typeof f.sha256 === 'string' ? f.sha256 : null,
    mode: Number.isInteger(f.mode) ? f.mode : null,
  })),
})

/** The rows a filter printed on stdout: each listed path, and its mode when it
 *  gave one. Its sizes and hashes are not read at all -- the relay hashes the
 *  files itself. A manifest that is not the stdin shape is `null`, never a
 *  partial read: a filter that printed something else has not said what it
 *  left in `--out`. */
export const readFilterManifest = (text) => {
  if (typeof text !== 'string') return null
  let doc
  try { doc = JSON.parse(text) } catch { return null }
  if (!isPlainObject(doc) || doc.version !== 1 || !Array.isArray(doc.files)) return null
  const rows = []
  for (const f of doc.files) {
    if (!isPlainObject(f) || typeof f.path !== 'string') return null
    rows.push({ path: f.path, mode: Number.isInteger(f.mode) ? f.mode & 0o777 : null })
  }
  return rows
}

/** A listed path when it names a file strictly inside `--out`, otherwise
 *  `null`. The filter is the local relay's own script, so its spelling is tidied
 *  first (`./a`, `a//b`); what comes out is then held to the one rule a landing
 *  path is held to, because a file a filter leaves is either landed here or
 *  sent to be landed there. Whether a file is really there, and not behind a
 *  link, is the caller's check against the disk. */
export const filterOutPath = (p) => (typeof p === 'string' && p !== '' ? sanitizeLandingPath(posix.normalize(p)) : null)

// ---- landing ----------------------------------------------------------------

export const LANDING_PATH_MAX_BYTES = 4096
export const LANDING_SEGMENT_MAX_BYTES = 255
const BACKSLASH = 92

/** Code points some filesystems leave out when they compare names, so a
 *  segment carrying one can still open the same directory as `.git`. */
const ignorable = (cp) => (cp >= 0x200c && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x206a && cp <= 0x206f) || cp === 0xfeff

/** `.git` in any case, with any of those code points, with the trailing dots
 *  and spaces one filesystem drops, or by the short name another gives it. */
const dotGitLike = (seg) => {
  let s = ''
  for (const c of seg.toLowerCase()) if (!ignorable(c.codePointAt(0) ?? 0)) s += c
  s = s.replace(/[. ]+$/, '')
  return s === '.git' || s === 'git~1'
}

/** The relative path a received file lands at, computed by the receiver from
 *  the sender's `path`, which is a hint that shapes the layout and never an
 *  instruction about where to write. Normalised FIRST, then held to every
 *  rule, so no spelling can pass the rules and become something else
 *  afterwards: well-formed text, NFC, at most 4096 bytes, no control
 *  character and no backslash, not absolute, and every segment non-empty, not
 *  made only of dots, not `.git` by any spelling, and at most 255 bytes. What
 *  passes names a file strictly below the drop's own directory. Anything else
 *  is `null`. */
export const sanitizeLandingPath = (hint) => {
  if (typeof hint !== 'string' || hint === '' || !hint.isWellFormed()) return null
  const p = hint.normalize('NFC')
  if (Buffer.byteLength(p) > LANDING_PATH_MAX_BYTES) return null
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i)
    if (c < 32 || c === 127 || c === BACKSLASH) return null
  }
  if (p.startsWith('/')) return null
  for (const seg of p.split('/')) {
    if (seg === '' || /^\.+$/.test(seg) || dotGitLike(seg) || Buffer.byteLength(seg) > LANDING_SEGMENT_MAX_BYTES) return null
  }
  // Held again by the path module's own reading: strictly below a root.
  if (posix.normalize(p) !== p || !posix.join('/drop', p).startsWith('/drop/')) return null
  return p
}

// ---- caps -------------------------------------------------------------------

const num = (v, fallback) => (Number.isFinite(v) ? v : fallback)

/** Rolling windows rather than calendar ones, so two relays in different
 *  timezones agree on what "today" means. Only asks from this peer that
 *  actually started a turn count -- `startedAt` is set when one does. Both
 *  limits refuse at the limit: with a cap of 20, the twenty-first waits. */
export const capCheck = ({ asks, peer, now = Date.now(), policy } = {}) => {
  const perHour = num(policy?.asksPerHour, DEFAULT_POLICY.asksPerHour)
  const dailyUsd = num(policy?.peerAskDailyCapUsd, DEFAULT_POLICY.peerAskDailyCapUsd)
  let lastHour = 0
  let spend = 0
  for (const a of Array.isArray(asks) ? asks : []) {
    if (!isPlainObject(a) || a.dir !== 'in' || a.peer !== peer || !Number.isFinite(a.startedAt)) continue
    const age = now - a.startedAt
    if (age < HOUR_MS) lastHour++
    if (age < DAY_MS) spend += num(a.costUsd, 0)
  }
  if (lastHour >= perHour) return { ok: false, reason: 'asks per hour cap reached' }
  if (spend >= dailyUsd) return { ok: false, reason: 'daily spend cap reached' }
  return { ok: true }
}

// ---- trust and the agent loop -----------------------------------------------

const wholeIn = (v, max) => Number.isInteger(v) && v >= 0 && v <= max

/** A policy change as the local person sent it. Every field present is checked
 *  and one bad field refuses the whole patch; a field absent is left out of the
 *  patch so the stored value stands; any other key is ignored. */
export const validatePolicyPatch = (body) => {
  const b = isPlainObject(body) ? body : {}
  const patch = {}
  const bad = (field, rule) => ({ ok: false, error: `${field} ${rule}` })
  if (Object.hasOwn(b, 'asksPerHour')) {
    if (!wholeIn(b.asksPerHour, POLICY_NUM_MAX)) return bad('asksPerHour', `must be a whole number from 0 to ${POLICY_NUM_MAX}`)
    patch.asksPerHour = b.asksPerHour
  }
  if (Object.hasOwn(b, 'peerAskDailyCapUsd')) {
    const v = b.peerAskDailyCapUsd
    if (!Number.isFinite(v) || v < 0 || v > POLICY_NUM_MAX) return bad('peerAskDailyCapUsd', `must be a number from 0 to ${POLICY_NUM_MAX}`)
    patch.peerAskDailyCapUsd = v
  }
  if (Object.hasOwn(b, 'trust')) {
    if (!TRUST_TIERS.includes(b.trust)) return bad('trust', `must be one of ${TRUST_TIERS.join(', ')}`)
    patch.trust = b.trust
  }
  if (Object.hasOwn(b, 'autoApply')) {
    if (!Array.isArray(b.autoApply) || b.autoApply.some((k) => !AUTO_APPLY_KINDS.includes(k))) {
      return bad('autoApply', `may list only ${AUTO_APPLY_KINDS.join(', ')}`)
    }
    patch.autoApply = AUTO_APPLY_KINDS.filter((k) => b.autoApply.includes(k))
  }
  if (Object.hasOwn(b, 'autoApplyMaxLive')) {
    if (!wholeIn(b.autoApplyMaxLive, MAX_LIVE_CAP)) return bad('autoApplyMaxLive', `must be a whole number from 0 to ${MAX_LIVE_CAP}`)
    patch.autoApplyMaxLive = b.autoApplyMaxLive
  }
  if (Object.hasOwn(b, 'peerAsksPerHour')) {
    if (!wholeIn(b.peerAsksPerHour, POLICY_NUM_MAX)) return bad('peerAsksPerHour', `must be a whole number from 0 to ${POLICY_NUM_MAX}`)
    patch.peerAsksPerHour = b.peerAsksPerHour
  }
  return { ok: true, patch }
}

/** One decision per proposed action: applied without a click, or a button.
 *  Only this side's own record for the peer feeds it, and a kind is compared
 *  by exact membership, so nothing a peer sends can widen what applies.
 *  A local turn may send a `peer_ask` on its own; a liaison turn never may. */
export const gateActions = ({
  source, trust = 'manual', autoApply = [], confirmed = false,
  peerAskCount = 0, peerAsksPerHour = DEFAULT_POLICY.peerAsksPerHour,
  liveForPeer = 0, autoApplyMaxLive = DEFAULT_POLICY.autoApplyMaxLive, actions = [],
} = {}) => {
  const button = (gateNote = null) => ({ gate: 'button', gateNote })
  const auto = () => ({ gate: 'auto', gateNote: null })
  let asked = peerAskCount
  let live = liveForPeer
  return (Array.isArray(actions) ? actions : []).map((a) => {
    const kind = isPlainObject(a) ? a.kind : null
    if (trust !== 'sanctioned') return button()
    if (source === 'ask') {
      if (kind !== 'peer_ask') return button()
      if (!confirmed) return button('the peer is not confirmed')
      if (asked >= peerAsksPerHour) return button('peer_ask hourly cap reached')
      asked += 1
      return auto()
    }
    if (source !== 'liaison' || !AUTO_APPLY_KINDS.includes(kind) || !Array.isArray(autoApply) || !autoApply.includes(kind)) return button()
    if (kind === 'spawn') {
      if (live >= autoApplyMaxLive) return button('live session cap reached')
      live += 1
    }
    return auto()
  })
}

/** Agent asks this side sent a peer in the last rolling hour, clicked or
 *  automatic alike, against the peer's hourly allowance. */
export const peerAskCap = ({ asks, peer, now = Date.now(), perHour } = {}) => {
  let count = 0
  for (const a of Array.isArray(asks) ? asks : []) {
    if (!isPlainObject(a) || a.peer !== peer || a.dir !== 'out' || a.origin !== 'agent') continue
    if (Number.isFinite(a.t) && now - a.t < HOUR_MS) count++
  }
  return { ok: count < num(perHour, DEFAULT_POLICY.peerAsksPerHour), count }
}

const resolveSessionRef = (ref, sessions) => {
  if (typeof ref !== 'string' || !ref) return null
  const list = Array.isArray(sessions) ? sessions : []
  if (list.some((s) => s?.id === ref)) return ref
  const named = list.filter((s) => s?.name === ref)
  return named.length === 1 ? named[0].id : null
}

/** The loopback route and body an applied action posts: exactly what the
 *  pane's button sends for a click, so an automatic apply is validated,
 *  tagged and captured the same way. */
export const applyRequest = (action, { peer = null, forAsk = null, sessions = [] } = {}) => {
  const a = isPlainObject(action) ? action : {}
  const tag = typeof forAsk === 'string' && forAsk ? { forAsk } : {}
  switch (a.kind) {
    case 'link': {
      const from = resolveSessionRef(a.from, sessions)
      const to = resolveSessionRef(a.to, sessions)
      return from && to ? { path: '/api/link', body: { from, to, note: a.note || '' } } : { error: 'no such session' }
    }
    case 'prompt': {
      const to = resolveSessionRef(a.to, sessions)
      return to ? { path: '/api/command', body: { targetId: to, verb: 'prompt', payload: { text: a.text || '' }, ...tag } } : { error: 'no such session' }
    }
    case 'dispatch':
      return { path: '/api/request/create', body: { title: a.title, project: a.project || '', ask: a.ask || '', brief: a.brief || null, model: a.model, effort: a.effort, ...tag } }
    case 'spawn':
      return { path: '/api/spawn', body: { cwd: a.cwd, name: a.name || '', prompt: a.prompt, model: a.model, effort: a.effort, ...tag } }
    case 'drop':
      return validName(peer) ? { path: `/api/peer/${peer}/drop`, body: { paths: a.paths, note: a.note || '' } } : { error: 'no peer on this turn' }
    case 'peer_ask':
      return validName(a.peer) ? { path: `/api/peer/${a.peer}/ask`, body: { text: a.text, origin: 'agent', ...tag } } : { error: 'not a peer name' }
    default:
      return { error: `${String(a.kind)} is never applied automatically` }
  }
}

// ---- health -----------------------------------------------------------------

/** Only one side of a pair dials, so only that side has a request to time.
 *  The dialer is `up` when its latest heartbeat succeeded and `down` when its
 *  latest one failed. The dialled side has no request of its own: it is `up`
 *  while the last verified heartbeat it received is younger than three
 *  intervals, which forgives two lost in a row. Neither side has heard
 *  anything yet: `never`. */
export const healthOf = ({ dials, lastOkAt, lastErrAt, lastErr, lastInboundAt, rttMs, skewMs, now = Date.now(), helloMs = HELLO_MS } = {}) => {
  const skew = Number.isFinite(skewMs) ? skewMs : null
  const base = { skewMs: skew, skewWarn: skew !== null && Math.abs(skew) > SKEW_WARN_MS }
  if (dials) {
    const ok = Number.isFinite(lastOkAt) ? lastOkAt : null
    const err = Number.isFinite(lastErrAt) ? lastErrAt : null
    const lastSeenAt = ok
    const rtt = Number.isFinite(rttMs) ? rttMs : null
    if (ok === null && err === null) return { state: 'never', lastSeenAt, rttMs: rtt, error: null, ...base }
    if (err !== null && (ok === null || err > ok)) {
      return { state: 'down', lastSeenAt, rttMs: rtt, error: typeof lastErr === 'string' ? lastErr : null, ...base }
    }
    return { state: 'up', lastSeenAt, rttMs: rtt, error: null, ...base }
  }
  const inbound = Number.isFinite(lastInboundAt) ? lastInboundAt : null
  if (inbound === null) return { state: 'never', lastSeenAt: null, rttMs: null, error: null, ...base }
  const state = now - inbound < 3 * helloMs ? 'up' : 'down'
  return { state, lastSeenAt: inbound, rttMs: null, error: null, ...base }
}

// ---- the retry ladder -------------------------------------------------------

/** A comma list of positive integers, in milliseconds. Anything else -- unset,
 *  empty, a stray word, a zero -- is the production ladder, never a partial
 *  parse of a typo. */
export const retryLadder = (envValue) => {
  if (typeof envValue === 'string' && envValue.trim() !== '') {
    const parts = envValue.split(',').map((p) => p.trim())
    if (parts.every((p) => /^[1-9]\d*$/.test(p))) return parts.map(Number)
  }
  return [...DEFAULT_RETRY_MS]
}
