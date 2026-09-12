// The pane's whole auth decision surface. Pure but for its own file I/O
// (readAuth/writeAuth) -- nothing in this file touches `http`. relay.mjs
// wires these into the request handler.

import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto'

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 }
const KEY_LEN = 32

/** {salt, hash}, both hex. A caller supplies `salt` (hex) to re-derive the
 *  same hash for comparison; otherwise a fresh 16-byte random salt is minted. */
export const hashPassword = (pw, salt) => {
  const saltHex = salt ?? randomBytes(16).toString('hex')
  const hash = scryptSync(String(pw), Buffer.from(saltHex, 'hex'), KEY_LEN, SCRYPT_OPTS).toString('hex')
  return { salt: saltHex, hash }
}

/** timingSafeEqual, and NEVER throws -- a malformed record (missing/short
 *  salt or hash, wrong hex) reads as "wrong password", not a 500. */
export const verifyPassword = (pw, rec) => {
  try {
    if (!rec || typeof rec.salt !== 'string' || typeof rec.hash !== 'string') return false
    const { hash } = hashPassword(pw, rec.salt)
    const a = Buffer.from(hash, 'hex')
    const b = Buffer.from(rec.hash, 'hex')
    if (a.length === 0 || a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** A fresh cookie-signing secret: persisted, not minted per boot -- this
 *  mints it exactly once, at setup, and again at reset). */
export const mintSecret = () => randomBytes(32).toString('hex')

const AUTH_FILE = (dir) => join(dir, 'auth.json')

/** Absent, unreadable or malformed all read as "no password configured" --
 *  the same degrade-to-empty contract as claims.mjs's readClaims, and for the
 *  same reason: a corrupt file must not become a 500 on every request. */
export const readAuth = (dir) => {
  const file = AUTH_FILE(dir)
  if (!existsSync(file)) return null
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    if (!doc || typeof doc !== 'object') return null
    if (typeof doc.salt !== 'string' || typeof doc.hash !== 'string' || typeof doc.secret !== 'string') return null
    return doc
  } catch {
    return null
  }
}

/** Serialize FIRST, write a temp file BESIDE the target, chmod 0600, then
 *  rename over it -- the claims.mjs rule: a failed serialize leaves the
 *  previous file intact. mode 0600 because this file holds a password hash
 *  and the session-cookie secret. */
export const writeAuth = (dir, rec) => {
  const file = AUTH_FILE(dir)
  const tmp = file + '.tmp'
  const text = JSON.stringify(rec, null, 2)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(tmp, text)
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
  return rec
}

/** `<issuedAtMs>.<random sid>.<HMAC-SHA256(secret, issuedAt + "." + sid)>`
 * `now` is the issuedAt timestamp in ms, injected so tests can sign a
 *  cookie in the past without waiting for one to actually expire. */
export const signCookie = (secret, now) => {
  const issuedAt = String(now)
  const sid = randomBytes(9).toString('hex')
  const mac = createHmac('sha256', secret).update(`${issuedAt}.${sid}`).digest('hex')
  return `${issuedAt}.${sid}.${mac}`
}

/** timingSafeEqual on the HMAC; false -- never throws -- on any shape this
 *  does not recognise: wrong part count, non-numeric issuedAt, expired, or a
 *  flipped byte in the mac. */
export const verifyCookie = (secret, value, now, maxAgeMs) => {
  try {
    if (typeof value !== 'string' || typeof secret !== 'string' || !secret) return false
    const parts = value.split('.')
    if (parts.length !== 3) return false
    const [issuedAtStr, sid, mac] = parts
    if (!sid || !mac) return false
    const issuedAt = Number(issuedAtStr)
    if (!Number.isFinite(issuedAt)) return false
    if (now < issuedAt || now - issuedAt > maxAgeMs) return false
    const expected = createHmac('sha256', secret).update(`${issuedAtStr}.${sid}`).digest('hex')
    const a = Buffer.from(mac, 'hex')
    const b = Buffer.from(expected, 'hex')
    if (a.length === 0 || a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** A plain object from a `Cookie` header. Tolerant of surrounding whitespace,
 *  `=` inside a value, and a missing/empty header. */
export const parseCookies = (header) => {
  const out = {}
  if (!header || typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (!k) continue
    out[k] = v
  }
  return out
}

/** `{ hit(key), clear(key) }`. Fixed-window counter, in-memory: a relay
 *  restart clearing it is not a weakness worth a file). `hit` both checks AND
 *  counts the call, so the 11th call inside a window is the one that first
 *  reports `ok:false` -- callers that only want failures to count must call
 *  `clear` on a success themselves (relay.mjs's login route does this). */
export const rateLimiter = ({ limit = 10, windowMs = 60_000 } = {}) => {
  const state = new Map() // key -> { count, resetAt }
  const hit = (key, now = Date.now()) => {
    const rec = state.get(key)
    if (!rec || now >= rec.resetAt) {
      state.set(key, { count: 1, resetAt: now + windowMs })
      return { ok: true }
    }
    if (rec.count < limit) {
      rec.count += 1
      return { ok: true }
    }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((rec.resetAt - now) / 1000)) }
  }
  const clear = (key) => { state.delete(key) }
  return { hit, clear }
}

const AUTH_ROUTES = new Set(['/login', '/setup'])
const isAuthRoute = (path) => AUTH_ROUTES.has(path) || path.startsWith('/api/auth/')

/** A "page load", as opposed to a script consumer (fetch/EventSource): GET or
 *  HEAD, not under /api/, and not a request for a file with an extension
 *  (.js, .css, the vendored bundle, ...). A strict `Accept: text/html` check
 *  alone does not cover this -- both a plain `curl` and `fetch()` send a
 *  wildcard Accept ("*" + "/*") by default, so `curl -sI /` (this feature's
 *  own live check) would misclassify as a script consumer under that check
 *  alone. Treating
 *  `Accept` containing `text/html` as an ADDITIONAL, sufficient signal keeps
 *  real browser navigations working the same way; the path shape is what
 *  makes curl and index.html work as intended. */
const isNavigation = (method, path, accept) => {
  if (method !== 'GET' && method !== 'HEAD') return false
  if (path.startsWith('/api/')) return false
  if (typeof accept === 'string' && accept.includes('text/html')) return true
  return !/\.[^/]+$/.test(path)
}

/** Pure and total. Order matters:
 * disabled -> allow
 * /api/health -> allow, always
 *   /favicon.svg -> allow, always -- the login/setup page's own favicon
 *     request, and an SVG icon discloses nothing
 *   an auth route (/login, /setup, /api/auth/*) -> allow
 * a valid cookie or a valid token -> allow: either credential works)
 *   a navigation with no credential -> setup (nothing configured yet) or
 *     login (something is)
 *   everything else -- /api/*, SSE, .js, .css, and any method that is not a
 * page load (PUT, DELETE, PATCH, ...) -- -> 401
 *  `method` is consulted only to decide "is this a navigation"; every other
 *  verb falls through to the same 401 an unauthenticated GET to a script
 *  path gets. Deliberately: `authed()` alone used to gate exactly one branch
 *  (`POST && path.startsWith('/api/')`), so a PUT/DELETE/PATCH to /api/* fell
 *  through it to the static handler with no check at all. That gap is closed
 *  here, once, rather than by enumerating verbs at each call site -- the
 *  same reason the gate is one check at the top of the handler and not six. */
export const gate = ({ method, path, accept, cookieOk, tokenOk, configured, disabled }) => {
  if (disabled) return { mode: 'allow' }
  if (path === '/api/health') return { mode: 'allow' }
  // The login/setup page's own favicon request, allowed unauthenticated the
  // same way /api/health is: an SVG icon discloses nothing.
  if (path === '/favicon.svg') return { mode: 'allow' }
  if (isAuthRoute(path)) return { mode: 'allow' }
  if (cookieOk || tokenOk) return { mode: 'allow' }
  if (isNavigation(method, path, accept)) return { mode: configured ? 'login' : 'setup' }
  return { mode: '401' }
}
