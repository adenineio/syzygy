// The floor under everything this relay sends to a peer. Pure: no socket, no
// file, no clock. `redactionContext` compiles a fixed set of rules once, and
// `redactOutbound` walks a value against them, replacing what it finds with
// `[redacted]` or `~`. Every replacement is built to sit outside every rule's
// own pattern, so running the walk again on its own output finds nothing and
// changes nothing. Keys the wire protocol depends on -- an id a reply must
// echo back, a sequence number, a signature -- are skipped outright: rewriting
// one would break the exchange it rides on, not merely reveal less.

import { isIP } from 'node:net'

export const REDACTED = '[redacted]'
export const REDACTION_KINDS = ['env', 'secret', 'host', 'ip', 'home', 'user']
export const PROTOCOL_KEYS = ['askId', 'dropId', 'seq', 'ackedTo', 'now', 'sha256', 'fp', 'proof', 'ack', 'id', 'offset']

const MAX_DEPTH = 64
const SECRET_KEY_RE = /token|secret|passw(?:or)?d|api[-_]?key|private[-_]?key/i

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const longestFirst = (a, b) => b.length - a.length
const uniq = (list) => [...new Set(list)]

/** Runs `re` (global) over `str`, replacing every match through `replacer`
 *  (never a plain string, so a captured `$` in the input is never read as a
 *  substitution token) and counting how many times it fired. */
const replaceAll = (str, re, replacer) => {
  let count = 0
  const out = str.replace(re, (...args) => { count += 1; return replacer(...args) })
  return { str: out, count }
}

// ---- the six rules, in the order they are applied ---------------------------

const buildEnvRule = (values) => {
  const candidates = uniq(
    (Array.isArray(values) ? values : [])
      .filter((v) => typeof v === 'string' && v.length >= 8 && !/^\d+$/.test(v) && v !== 'true' && v !== 'false' && !/[/\\]/.test(v) && isIP(v) === 0),
  ).sort(longestFirst)
  if (candidates.length === 0) return null
  const re = new RegExp(candidates.map(escapeRe).join('|'), 'g')
  return { kind: 'env', apply: (str) => replaceAll(str, re, () => REDACTED) }
}

const SECRET_SHAPE_RES = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
]
const SECRET_GENERIC_RE = /((?:bearer\s+)|(?:token|key|secret|passw(?:or)?d)[^A-Za-z0-9\n]{1,16})([A-Za-z0-9_+=-]{32,})/gi

const buildSecretRule = () => ({
  kind: 'secret',
  apply: (str) => {
    let out = str
    let total = 0
    for (const re of SECRET_SHAPE_RES) {
      const r = replaceAll(out, re, () => REDACTED)
      out = r.str
      total += r.count
    }
    const generic = replaceAll(out, SECRET_GENERIC_RE, (_m, lead) => lead + REDACTED)
    out = generic.str
    total += generic.count
    return { str: out, count: total }
  },
})

const buildHostRule = (hostname) => {
  if (typeof hostname !== 'string' || hostname.length === 0) return null
  const label = hostname.split('.')[0] ?? ''
  const candidates = []
  if (hostname.length >= 4) candidates.push(hostname)
  if (label.length >= 4 && label !== hostname) candidates.push(label)
  if (candidates.length === 0) return null
  const alt = uniq(candidates).sort(longestFirst).map(escapeRe).join('|')
  const re = new RegExp(`(?<![A-Za-z0-9-])(?:${alt})(?![A-Za-z0-9-])`, 'gi')
  return { kind: 'host', apply: (str) => replaceAll(str, re, () => REDACTED) }
}

const PRIVATE_IPV4_SRC = String.raw`10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}`

const buildIpRule = (addresses) => {
  const own = uniq((Array.isArray(addresses) ? addresses : []).filter((a) => typeof a === 'string' && isIP(a) !== 0))
    .sort(longestFirst)
    .map(escapeRe)
  const alt = [...own, PRIVATE_IPV4_SRC].join('|')
  const re = new RegExp(`(?<![0-9A-Fa-f:.])(?:${alt})(?![0-9A-Fa-f:]|\\.\\d)`, 'g')
  return { kind: 'ip', apply: (str) => replaceAll(str, re, () => REDACTED) }
}

const buildHomeRule = (home, realHome) => {
  const candidates = uniq([home, realHome].filter((v) => typeof v === 'string' && v.length > 1)).sort(longestFirst)
  if (candidates.length === 0) return null
  const alt = candidates.map(escapeRe).join('|')
  const re = new RegExp(`(?:${alt})(?![A-Za-z0-9._-])`, 'g')
  return { kind: 'home', apply: (str) => replaceAll(str, re, () => '~') }
}

const buildUserRule = (user) => {
  if (typeof user !== 'string' || user.length < 2) return null
  const re = new RegExp(`(?<=${String.raw`[/\\]`})${escapeRe(user)}(?![A-Za-z0-9._-])`, 'g')
  return { kind: 'user', apply: (str) => replaceAll(str, re, () => '~') }
}

/** Compiled once per boot (or once per minute, at the caller's discretion):
 *  the six rules above, built from the parts a caller collected with
 *  `hostParts`. A part that is empty simply contributes no rule. */
export const redactionContext = ({ home = '', realHome = '', user = '', hostname = '', addresses = [], values = [] } = {}) => {
  const rules = [
    buildEnvRule(values),
    buildSecretRule(),
    buildHostRule(hostname),
    buildIpRule(addresses),
    buildHomeRule(home, realHome),
    buildUserRule(user),
  ].filter(Boolean)
  return { rules }
}

const walkValue = (v, key, depth, ctx, state) => {
  if (depth > MAX_DEPTH) throw new Error('value too deep to redact')
  if (typeof v === 'string') {
    if (typeof key === 'string' && SECRET_KEY_RE.test(key) && v.length >= 16) {
      state.n += 1
      state.kinds.secret = (state.kinds.secret ?? 0) + 1
      return REDACTED
    }
    let out = v
    for (const rule of ctx.rules) {
      const r = rule.apply(out)
      out = r.str
      if (r.count > 0) {
        state.n += r.count
        state.kinds[rule.kind] = (state.kinds[rule.kind] ?? 0) + r.count
      }
    }
    return out
  }
  if (Array.isArray(v)) return v.map((item) => walkValue(item, key, depth + 1, ctx, state))
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      out[k] = PROTOCOL_KEYS.includes(k) ? val : walkValue(val, k, depth + 1, ctx, state)
    }
    return out
  }
  return v
}

/** Deep over strings, arrays and plain objects; never mutates `value`. Answers
 *  the redacted value plus how many replacements ran and of which kinds --
 *  `kinds` carries only the ones that actually fired. */
export const redactOutbound = (value, ctx) => {
  const state = { n: 0, kinds: {} }
  const out = walkValue(value, null, 0, ctx, state)
  return { value: out, n: state.n, kinds: state.kinds }
}

/** What a caller collects at boot (and again on a timer) to build a context.
 *  Every call against `os` is guarded on its own, so one missing capability
 *  -- a sandboxed `userInfo()`, a platform with no network interfaces -- costs
 *  that one part rather than the whole context. */
export const hostParts = ({ env = {}, token = null, auth = null, os = {}, realpath = (x) => x } = {}) => {
  const guard = (fn, fallback) => { try { return fn() } catch { return fallback } }
  const home = guard(() => os.homedir?.(), '') || ''
  const realHome = home ? (guard(() => realpath(home), home) || home) : ''
  const userInfo = guard(() => os.userInfo?.(), null)
  const user = userInfo && typeof userInfo.username === 'string' ? userInfo.username : ''
  const hostname = guard(() => os.hostname?.(), '') || ''
  const ifaces = guard(() => os.networkInterfaces?.(), null) || {}
  const addresses = []
  for (const list of Object.values(ifaces)) {
    if (!Array.isArray(list)) continue
    for (const a of list) {
      if (!a || a.internal || typeof a.address !== 'string') continue
      addresses.push(a.address.replace(/%.*$/, ''))
    }
  }
  const values = []
  const push = (v) => { if (typeof v === 'string' && v) values.push(v) }
  push(token)
  if (env && typeof env === 'object') for (const [k, v] of Object.entries(env)) if (k.startsWith('SZG_')) push(v)
  push(auth?.hash)
  push(auth?.salt)
  push(auth?.secret)
  return { home, realHome, user, hostname, addresses, values }
}
