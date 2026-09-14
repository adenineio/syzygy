// The peer listener: the one surface a paired relay on another machine can
// reach, and the dialer that reaches the other side's.
//
// This is a separate HTTPS server with a separate table, on purpose. It shares
// no handler, no middleware and no path prefix with the loopback relay, so a
// route added to the relay can never appear here by accident. The table is
// nine exact paths and nothing else: pairing, the heartbeat, the two ask
// routes, and the five a drop's bytes move over.
//
// A body is capped per route. Only two routes carry more than a heartbeat's
// worth: a chunk, which is a mebibyte of raw bytes and is never parsed as
// JSON, and an offer, which carries a whole drop's manifest. Every other route
// keeps the small cap it always had, so a chunk-sized body cannot reach them.
//
// Every refusal is the same answer: 404, no body. A method other than POST, a
// path off the table, a body too large or not a JSON object, a request that
// fails authentication, a route that declines, a handler that throws -- a
// prober sees the same response for each and cannot map what is here or tell
// why it was turned away. The reason goes to `log` instead. The single
// exception is a route answering 429, which is how a rate limit on the one
// unsigned route tells an honest caller to slow down.
//
// The dialer pins the other side's certificate twice over: the stored PEM is
// the only trust anchor (`ca`), and `checkServerIdentity` compares the
// certificate's SHA-256 fingerprint with the pinned one. node only calls
// `checkServerIdentity` when the chain verifies, which needs that PEM -- and a
// pairing code carries only the fingerprint -- so `fetchPeerCert` exists to
// fetch the PEM on a connection that completes a handshake and writes nothing.

import https from 'node:https'
import tls from 'node:tls'
import { isIP } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { signRequest, fpEqual } from './peer.mjs'

export const PEER_ROUTES = Object.freeze([
  '/peer/pair', '/peer/hello', '/peer/ask', '/peer/ask/reply',
  '/peer/drop/offer', '/peer/drop/chunk', '/peer/drop/commit', '/peer/drop/manifest', '/peer/drop/pull',
])
export const MAX_PEER_BODY = 256 * 1024
/** A chunk is at most a mebibyte; the slack is for nothing but rounding. */
export const MAX_CHUNK_BODY = 1024 * 1024 + 4096
/** A drop's manifest: up to its file cap of rows, each with a path. */
export const MAX_MANIFEST_BODY = 4 * 1024 * 1024

/** The one observer of the wire, set by the relay. Every JSON body a peer is
 *  sent goes through `outbound` first, and every exchange that completes is
 *  handed to `record`; the handler and the dialer below both call it, so a
 *  dial added anywhere is covered without knowing it exists. Raw bytes -- a
 *  chunk sent, a pull answered -- are a file's contents: they are counted,
 *  never rewritten and never copied into the log. An `outbound` that throws
 *  sends nothing: the dialer answers a failure and the handler its 404. */
let wireTap = null
export const setWireTap = (tap) => {
  const prev = wireTap
  wireTap = tap ?? null
  return prev
}
/** What `outbound` would send, without recording anything. */
export const previewOutbound = (route, body, fingerprint = null) =>
  (wireTap ? wireTap.outbound({ route, fingerprint }, body).body : body)

const ROUTE_KEYS = Object.freeze({
  [PEER_ROUTES[0]]: 'pair',
  [PEER_ROUTES[1]]: 'hello',
  [PEER_ROUTES[2]]: 'ask',
  [PEER_ROUTES[3]]: 'askReply',
  [PEER_ROUTES[4]]: 'dropOffer',
  [PEER_ROUTES[5]]: 'dropChunk',
  [PEER_ROUTES[6]]: 'dropCommit',
  [PEER_ROUTES[7]]: 'dropManifest',
  [PEER_ROUTES[8]]: 'dropPull',
})

const ROUTE_CAPS = Object.freeze({ dropOffer: MAX_MANIFEST_BODY, dropChunk: MAX_CHUNK_BODY })
/** Routes whose body is handed over as the bytes that arrived, not parsed. */
const RAW_ROUTES = new Set(['dropChunk'])

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A path or address from the network, made safe for one log line. */
const logSafe = (v) => JSON.stringify(String(v ?? '').slice(0, 200))

const notFound = (res) => {
  try {
    if (!res.headersSent) res.writeHead(404, { 'content-length': 0 })
    res.end()
  } catch {}
}

/** Collects at most `cap` bytes but keeps reading to the end, so the answer to
 *  an oversized body is written after the client has finished sending rather
 *  than into a socket it is still writing to. The server's request timeout
 *  bounds how long that can take. */
const readBody = (req, cap) => new Promise((resolve) => {
  const chunks = []
  let size = 0
  let oversized = false
  let settled = false
  const done = (error) => {
    if (settled) return
    settled = true
    resolve({ buf: oversized ? null : Buffer.concat(chunks), oversized, error })
  }
  req.on('data', (c) => {
    size += c.length
    if (size > cap) { oversized = true; chunks.length = 0; return }
    if (!oversized) chunks.push(c)
  })
  req.on('end', () => done(null))
  req.on('error', (e) => done(e))
  req.on('close', () => done(req.complete ? null : new Error('request closed before its end')))
})

/**
 * `routes.pair({ body, remoteAddress })` and every other route's `({ peer,
 * body, query, headers, receivedAt })` each answer `{ status: 200, json }`,
 * `{ status: 200, raw }` (a Buffer, sent as bytes), `null`, or -- pair only, in
 * practice -- `{ status: 429, headers }`. A raw route's `body` is the Buffer
 * that arrived; every other body is a parsed JSON object. `query` is the raw
 * query string, without its `?`. `authenticate({ method, path, query, headers,
 * rawBody, receivedAt })` answers the peer record or `null`, and runs before
 * the body is parsed, so a forged request costs the same work whatever its
 * body holds.
 */
export const createPeerHandler = ({ routes, authenticate, log = () => {}, now = Date.now }) => async (req, res) => {
  const receivedAt = now()
  const remoteAddress = req.socket?.remoteAddress ?? null
  const refuse = (reason) => {
    try { log(`peer listener: 404 ${req.method} ${logSafe(req.url)} from ${logSafe(remoteAddress)}: ${reason}`) } catch {}
    try { wireTap?.refused() } catch {}
    notFound(res)
  }
  try {
    const rawUrl = typeof req.url === 'string' ? req.url : ''
    const path = rawUrl.split('?')[0]
    // The cap is chosen from the path before anything is refused, so every
    // refusal below still waits for the whole body the way it always has.
    const capKey = Object.hasOwn(ROUTE_KEYS, path) ? ROUTE_KEYS[path] : null
    const { buf, oversized, error } = await readBody(req, (capKey && ROUTE_CAPS[capKey]) || MAX_PEER_BODY)
    if (error) return refuse(`body: ${error.message}`)

    if (req.method !== 'POST') return refuse('method')
    // Matched against the raw request path, never a normalised one, so the
    // table means exactly its four strings: no trailing slash, no dot segment.
    if (!rawUrl.startsWith('/') || !Object.hasOwn(ROUTE_KEYS, path)) return refuse('not on the table')
    if (oversized) return refuse('body over the limit')
    const key = ROUTE_KEYS[path]
    const query = new URL(rawUrl, 'https://peer').search.slice(1)

    let peer = null
    if (key !== 'pair') {
      peer = await authenticate({ method: req.method, path, query, headers: req.headers, rawBody: buf, receivedAt })
      if (!peer) return refuse('authentication')
    }

    let body
    if (RAW_ROUTES.has(key)) {
      body = buf
    } else {
      try {
        body = JSON.parse(buf.toString('utf8'))
      } catch {
        return refuse('body is not JSON')
      }
      if (!isPlainObject(body)) return refuse('body is not a JSON object')
    }

    const route = routes?.[key]
    if (typeof route !== 'function') return refuse('no route')
    const result = key === 'pair'
      ? await route({ body, remoteAddress })
      : await route({ peer, body, query, headers: req.headers, receivedAt })
    if (!result) return refuse('route declined')

    if (result.status === 429) {
      const headers = isPlainObject(result.headers) ? result.headers : {}
      res.writeHead(429, { ...headers, 'content-length': 0 })
      res.end()
      return
    }
    // Any status but the two a route may answer is a refusal like the rest,
    // so a route cannot widen what a prober is able to tell apart.
    if (result.status !== 200) return refuse(`route answered ${result.status}`)

    // Only the peer's name and fingerprint ever reach the tap: the record
    // itself carries the pairing secret. Raw bytes in either direction are
    // counted, not copied.
    const tap = wireTap
    const recordIn = (answer, resBytes, wire) => {
      if (!tap) return
      try {
        tap.record({
          dir: 'in', route: path, query, peer: peer?.name ?? null, fingerprint: peer?.fingerprint ?? null,
          status: 200, rttMs: null, req: Buffer.isBuffer(body) ? null : body, res: answer,
          reqBytes: buf.length, resBytes, error: null,
          redactions: wire?.redactions ?? null, safeguard: wire?.safeguard ?? 'exempt',
        })
      } catch (e) {
        try { log(`peer listener: the wire log failed: ${e?.message ?? e}`) } catch {}
      }
    }

    if (Object.hasOwn(result, 'raw')) {
      if (!Buffer.isBuffer(result.raw)) return refuse('route answered raw bytes that are not a Buffer')
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
        'content-length': result.raw.length,
      })
      res.end(result.raw)
      recordIn(null, result.raw.length, null)
      return
    }

    let out = result.json ?? {}
    let wire = null
    if (tap) {
      try {
        wire = tap.outbound({ route: path, fingerprint: peer?.fingerprint ?? null }, out)
        out = wire.body
      } catch (e) {
        return refuse(`outbound safeguard failed: ${e?.message ?? e}`)
      }
    }
    const text = JSON.stringify(out ?? {})
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
    recordIn(out, Buffer.byteLength(text), wire)
  } catch (e) {
    refuse(`threw: ${e?.message ?? e}`)
  }
}

/** Constructs nothing until `start`, so a listener that is never started never
 *  binds. `start` resolves the port actually bound, which is the one to
 *  advertise when `port` was 0. */
export const createPeerListener = ({ keyPem, certPem, bind, port, handler, log = () => {} }) => {
  let server = null
  let bound = null

  const serve = (req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((e) => {
        try { log(`peer listener: handler threw: ${e?.message ?? e}`) } catch {}
        notFound(res)
      })
  }

  return {
    get port() { return bound },

    start() {
      if (server) return Promise.resolve(bound)
      return new Promise((resolve, reject) => {
        let s
        try {
          s = https.createServer({
            key: keyPem,
            cert: certPem,
            minVersion: 'TLSv1.2',
            requestTimeout: 30_000,
            headersTimeout: 15_000,
          }, serve)
        } catch (e) {
          reject(e)
          return
        }
        // A malformed request or a failed handshake gets no answer at all: an
        // error page would be one more thing a prober could fingerprint.
        s.on('clientError', (_err, socket) => { socket.destroy() })
        s.on('tlsClientError', (_err, socket) => { socket.destroy() })
        const onStartError = (e) => { reject(e) }
        s.once('error', onStartError)
        s.listen(port, bind, () => {
          s.off('error', onStartError)
          s.on('error', (e) => { try { log(`peer listener: ${e?.message ?? e}`) } catch {} })
          server = s
          bound = s.address().port
          resolve(bound)
        })
      })
    },

    stop() {
      const s = server
      server = null
      bound = null
      if (!s) return Promise.resolve()
      return new Promise((resolve) => {
        s.close(() => resolve())
        s.closeAllConnections()
      })
    },
  }
}

/** DER bytes to the PEM text node's TLS options and `X509Certificate` read. */
export const certPemFromRaw = (raw) =>
  '-----BEGIN CERTIFICATE-----\n' +
  Buffer.from(raw).toString('base64').match(/.{1,64}/g).join('\n') +
  '\n-----END CERTIFICATE-----\n'

/** Opens a TLS connection that verifies nothing, reads the leaf certificate
 *  and closes the socket without writing a byte of application data -- so an
 *  impostor that completes the handshake learns nothing but that someone
 *  connected. The certificate is returned only if its fingerprint is the
 *  pinned one. Never throws. */
export const fetchPeerCert = ({ host, port, fingerprint, timeoutMs = 5000 }) => new Promise((resolve) => {
  let settled = false
  let socket = null
  let timer = null
  const finish = (result) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try { socket?.destroy() } catch {}
    resolve(result)
  }
  try {
    socket = tls.connect({ host, port, rejectUnauthorized: false, servername: isIP(host) ? undefined : host })
  } catch (e) {
    finish({ ok: false, error: e?.code || e?.message || String(e) })
    return
  }
  // Stays attached after `finish`, so a late error on a destroyed socket is
  // swallowed rather than thrown as an unhandled event.
  socket.on('error', (e) => finish({ ok: false, error: e?.code || e?.message || String(e) }))
  timer = setTimeout(() => finish({ ok: false, error: 'ETIMEDOUT' }), timeoutMs)
  socket.once('secureConnect', () => {
    try {
      const raw = socket.getPeerCertificate(true)?.raw
      socket.destroy()
      if (!Buffer.isBuffer(raw) || raw.length === 0) return finish({ ok: false, error: 'no certificate' })
      const pem = certPemFromRaw(raw)
      const actual = new X509Certificate(pem).fingerprint256
      finish(fpEqual(actual, fingerprint) ? { ok: true, pem } : { ok: false, error: 'fingerprint mismatch' })
    } catch (e) {
      finish({ ok: false, error: e?.code || e?.message || String(e) })
    }
  })
})

const HEX_SECRET_RE = /^[0-9a-f]{64}$/i

/** One POST to a paired peer, pinned to its certificate and fingerprint, signed
 *  when `secret` is given (a 32-byte Buffer, or its 64-character hex form as
 *  the store keeps it). Answers `{ ok, status, json, rttMs, error }` and never
 *  throws: `status` is 0 when no response arrived, `rttMs` is null then, and
 *  `ok` is true only for a 200 whose body parses as JSON. `rttMs` is measured
 *  on the monotonic clock, not on `now`, which only stamps the signature.
 *
 *  `rawBody`, a Buffer, is sent as it is instead of `body` and signed over
 *  exactly those bytes; `path` may carry a query either way. With
 *  `rawResponse` the answer is `{ ok, status, buf, rttMs, error }`, the body
 *  unparsed. A response larger than `maxResponse` bytes is abandoned.
 *
 *  A JSON body passes the wire tap before it is serialised, so what is signed
 *  is what is sent; raw bytes pass untouched. The exchange is recorded exactly
 *  once, however it ends. */
export const dialPeer = ({
  host, port, fingerprint, certPem, path, body, rawBody = null, rawResponse = false, maxResponse = MAX_PEER_BODY,
  secret = null, self = null, timeoutMs = 10_000, now = Date.now,
}) =>
  new Promise((resolve) => {
    const started = performance.now()
    const pathText = String(path)
    const q = pathText.indexOf('?')
    const route = q === -1 ? pathText : pathText.slice(0, q)
    const query = q === -1 ? '' : pathText.slice(q + 1)
    const raw = Buffer.isBuffer(rawBody)
    const tap = wireTap
    let sent = body ?? {}
    let wire = null
    let reqBytes = raw ? rawBody.length : 0
    let settled = false
    const finish = ({ status = 0, json = null, buf = null, error = null, resBytes = 0 }) => {
      if (settled) return
      settled = true
      const okay = status === 200 && error === null
      const rttMs = status ? Math.round(performance.now() - started) : null
      const result = rawResponse
        ? { ok: okay, status, buf: okay ? buf : null, rttMs, error: okay ? null : error }
        : { ok: okay, status, json: okay ? json : null, rttMs, error: okay ? null : error }
      if (tap) {
        try {
          // A body the safeguard refused was never sent, so it is not logged.
          tap.record({
            dir: 'out', route, query, peer: null, fingerprint, status, rttMs,
            req: raw || !wire ? null : sent, res: rawResponse ? null : result.json, reqBytes, resBytes,
            error: result.error, redactions: wire?.redactions ?? null,
            safeguard: raw ? 'exempt' : (wire?.safeguard ?? 'on'),
          })
        } catch {}
      }
      resolve(result)
    }

    if (tap && !raw) {
      try {
        wire = tap.outbound({ route, fingerprint }, sent)
        sent = wire.body
      } catch {
        finish({ error: 'outbound safeguard failed' })
        return
      }
    }

    let req
    try {
      const bodyText = raw ? rawBody : JSON.stringify(sent ?? {})
      if (!raw) reqBytes = Buffer.byteLength(bodyText)
      const headers = raw
        ? { 'content-type': 'application/octet-stream', 'content-length': rawBody.length }
        : { 'content-type': 'application/json', 'content-length': reqBytes }
      if (secret) {
        const key = typeof secret === 'string' && HEX_SECRET_RE.test(secret) ? Buffer.from(secret, 'hex') : secret
        const signed = signRequest({
          secret: key,
          self,
          method: 'POST',
          path: route,
          query,
          body: bodyText,
          now: now(),
        })
        Object.assign(headers, signed.headers)
      }
      req = https.request({
        host,
        port,
        path,
        method: 'POST',
        agent: false,
        ca: [certPem],
        checkServerIdentity: (_host, cert) =>
          fpEqual(cert?.fingerprint256, fingerprint) ? undefined : new Error('fingerprint mismatch'),
        headers,
        timeout: timeoutMs,
      }, (res) => {
        const status = res.statusCode ?? 0
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          if (settled) return
          size += c.length
          if (size > maxResponse) {
            finish({ status, error: 'response over the limit', resBytes: size })
            req.destroy()
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          if (status !== 200) return finish({ status, error: `HTTP ${status}`, resBytes: size })
          if (rawResponse) return finish({ status, buf: Buffer.concat(chunks), resBytes: size })
          try {
            finish({ status, json: JSON.parse(Buffer.concat(chunks).toString('utf8')), resBytes: size })
          } catch {
            finish({ status, error: 'response is not JSON', resBytes: size })
          }
        })
        res.on('error', (e) => finish({ status, error: e?.code || e?.message || String(e), resBytes: size }))
        res.on('close', () => finish({ status, error: 'response closed before its end', resBytes: size }))
      })
      req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })))
      req.on('error', (e) => finish({ error: e?.code || e?.message || String(e) }))
      req.end(bodyText)
    } catch (e) {
      try { req?.destroy() } catch {}
      finish({ error: e?.code || e?.message || String(e) })
    }
  })
