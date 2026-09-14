#!/usr/bin/env node
// Drives the peering link in three parts: bridge/peer-listener.mjs alone,
// in-process; two peering engines in-process; and two real relays paired over
// TLS. Every part runs on 127.0.0.1 with OS-assigned ports and temp data dirs,
// and the process exits on its own -- a timer, socket or server left open is a
// bug this harness should surface as a hang.
import assert from 'node:assert/strict'
import https from 'node:https'
import { randomBytes, X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, writeFileSync, chmodSync, mkdirSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const L = await import(join(ROOT, 'syzygy', 'bridge', 'peer-listener.mjs'))
const P = await import(join(ROOT, 'syzygy', 'bridge', 'peer.mjs'))
const S = await import(join(ROOT, 'syzygy', 'bridge', 'peers-store.mjs'))
const { realRun } = await import(join(ROOT, 'syzygy', 'bridge', 'canvas.mjs'))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }
const dirs = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'szg-peer-link-')); dirs.push(d); return d }

/** Polls every `everyMs` (100 by default) until `check` returns something truthy, and returns it. */
const until = async (label, check, { timeoutMs = 5000, everyMs = 100, show = async () => '' } = {}) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await check()
    if (got) return got
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs} ms waiting for ${label} ${await show()}`)
    await new Promise((r) => setTimeout(r, everyMs))
  }
}

// ---- the listener alone -----------------------------------------------------

// A prober's request: no pinning, raw method and path.
const probe = (port, method, path, { headers = {}, body = '' } = {}) => new Promise((resolve) => {
  const req = https.request({ host: '127.0.0.1', port, method, path, rejectUnauthorized: false, agent: false, headers }, (res) => {
    let text = ''; res.on('data', (c) => { text += c }); res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }))
  })
  req.on('error', (e) => resolve({ status: 0, text: '', error: e.code }))
  req.end(body)
})

const certDir = tmp()
const cert = await S.ensureCert({ dir: certDir, bind: '127.0.0.1', run: realRun })
const other = await S.ensureCert({ dir: tmp(), bind: '127.0.0.1', run: realRun })
const secret = randomBytes(32)
const NO_CALLS = { pair: 0, hello: 0, ask: 0, askReply: 0, dropOffer: 0, dropChunk: 0, dropCommit: 0, dropManifest: 0, dropPull: 0 }
const calls = { ...NO_CALLS }
/** What the last drop route was handed, so a test can see a raw body arrive as bytes. */
const seenByRoute = {}
const PULL_BYTES = randomBytes(300 * 1024)
const guard = P.createReplayGuard()
const handler = L.createPeerHandler({
  log: () => {},
  authenticate: ({ method, path, query, headers, rawBody }) => {
    if (headers['x-szg-peer'] !== 'bravo') return null
    if (!P.verifySignature({ secret, method, path, query, headers, bodySha256: P.sha256hex(rawBody) })) return null
    return guard.check(headers['x-szg-ts'], headers['x-szg-nonce']).ok ? { name: 'bravo' } : null
  },
  routes: {
    pair: async () => { calls.pair++; return { status: 200, json: { name: 'alpha', ack: 'x' } } },
    hello: async ({ peer }) => { calls.hello++; return { status: 200, json: { roster: [], jobDeltas: [], outbound: [], now: 1, who: peer.name } } },
    ask: async () => { calls.ask++; return { status: 200, json: { accepted: true } } },
    askReply: async () => { calls.askReply++; return { status: 200, json: { ok: true } } },
    dropOffer: async ({ body }) => { calls.dropOffer++; seenByRoute.dropOffer = body; return { status: 200, json: { accept: true, have: {} } } },
    dropChunk: async ({ body, query }) => {
      calls.dropChunk++
      seenByRoute.dropChunk = { isBuffer: Buffer.isBuffer(body), length: body?.length, sha: P.sha256hex(body), query }
      return { status: 200, json: { offset: body.length, appended: true } }
    },
    dropCommit: async () => { calls.dropCommit++; return { status: 200, json: { ok: true } } },
    dropManifest: async () => { calls.dropManifest++; return { status: 200, json: { dropId: 'x', files: [] } } },
    dropPull: async () => { calls.dropPull++; return { status: 200, raw: PULL_BYTES } },
  },
})
const listener = L.createPeerListener({ keyPem: cert.keyPem, certPem: cert.certPem, bind: '127.0.0.1', port: 0, handler, log: () => {} })
const port = await listener.start()
const DROP_PATHS = ['/peer/drop/offer', '/peer/drop/chunk', '/peer/drop/commit', '/peer/drop/manifest', '/peer/drop/pull']

await ok('the table is exactly nine paths', () => {
  assert.deepEqual([...L.PEER_ROUTES], ['/peer/pair', '/peer/hello', '/peer/ask', '/peer/ask/reply', ...DROP_PATHS])
})

await ok('everything off the table is an empty 404', async () => {
  for (const [m, p] of [['GET', '/api/state'], ['POST', '/api/state'], ['GET', '/'], ['GET', '/app.js'], ['GET', '/api/stream'],
    ['GET', '/api/health'], ['GET', '/peer/hello'], ['PUT', '/peer/ask'], ['POST', '/peer/drop'], ['POST', '/peer/drop/offer/'],
    ['GET', '/peer/drop/chunk'], ['POST', '/peer/drop/pull/..'], ['POST', '/peer/hello/']]) {
    const r = await probe(port, m, p)
    assert.equal(r.status, 404, `${m} ${p}`); assert.equal(r.text, '', `${m} ${p} has an empty body`)
  }
  assert.deepEqual(calls, NO_CALLS)
})

await ok('the five drop paths: unsigned or wrongly signed is the same empty 404, and no route runs', async () => {
  for (const p of DROP_PATHS) {
    const body = JSON.stringify({ dropId: 'ab'.repeat(8) })
    const unsigned = await probe(port, 'POST', p, { body, headers: { 'content-type': 'application/json' } })
    assert.equal(unsigned.status, 404, `unsigned ${p}`); assert.equal(unsigned.text, '')
    const bad = P.signRequest({ secret: randomBytes(32), self: 'bravo', method: 'POST', path: p, body })
    const forged = await probe(port, 'POST', p, { body, headers: bad.headers })
    assert.equal(forged.status, 404, `forged ${p}`); assert.equal(forged.text, '')
  }
  // A forged chunk, signed over other bytes than it carries, never reaches the route either.
  const good = P.signRequest({ secret, self: 'bravo', method: 'POST', path: '/peer/drop/chunk', query: 'drop=x&file=0&offset=0', body: Buffer.from('real') })
  assert.equal((await probe(port, 'POST', '/peer/drop/chunk?drop=x&file=0&offset=0', { body: 'fake', headers: good.headers })).status, 404)
  assert.deepEqual(calls, NO_CALLS)
})

await ok('a chunk is raw bytes up to a mebibyte plus slack, a pull answers raw bytes, and every other route keeps its cap', async () => {
  const pin = { host: '127.0.0.1', port, fingerprint: cert.fingerprint, certPem: cert.certPem, secret, self: 'bravo' }
  const chunk = randomBytes(1024 * 1024)
  const sent = await L.dialPeer({ ...pin, path: '/peer/drop/chunk?offset=0&file=2&drop=' + 'ab'.repeat(8), rawBody: chunk })
  assert.equal(sent.ok, true, String(sent.error)); assert.deepEqual(sent.json, { offset: chunk.length, appended: true })
  assert.deepEqual(seenByRoute.dropChunk, { isBuffer: true, length: chunk.length, sha: P.sha256hex(chunk), query: 'offset=0&file=2&drop=' + 'ab'.repeat(8) })

  const pulled = await L.dialPeer({ ...pin, path: '/peer/drop/pull', body: { dropId: 'x', file: 0, offset: 0 }, rawResponse: true, maxResponse: L.MAX_PEER_BODY * 2 })
  assert.equal(pulled.ok, true, String(pulled.error)); assert.equal(Buffer.compare(pulled.buf, PULL_BYTES), 0)
  assert.equal(pulled.json, undefined, 'a raw response is never parsed')
  const capped = await L.dialPeer({ ...pin, path: '/peer/drop/pull', body: { dropId: 'x', file: 0, offset: 0 }, rawResponse: true })
  assert.equal(capped.ok, false, 'the default response cap still holds'); assert.match(String(capped.error), /over the limit/)

  const before = { ...calls }
  const tooBig = randomBytes(L.MAX_CHUNK_BODY + 1)
  assert.equal((await L.dialPeer({ ...pin, path: '/peer/drop/chunk?drop=x&file=0&offset=0', rawBody: tooBig })).status, 404)
  // A JSON route over its own cap is refused, and a chunk-sized body does not get past hello's.
  const bigHello = { roster: [], pad: 'x'.repeat(L.MAX_PEER_BODY) }
  assert.equal((await L.dialPeer({ ...pin, path: '/peer/hello', body: bigHello })).status, 404)
  assert.deepEqual(calls, before, 'no over-cap body reached a route')

  // An offer carries a whole manifest, so its cap is the manifest's.
  const offer = { dropId: 'ab'.repeat(8), files: [], pad: 'x'.repeat(L.MAX_PEER_BODY) }
  assert.equal((await L.dialPeer({ ...pin, path: '/peer/drop/offer', body: offer })).ok, true)
  assert.equal(seenByRoute.dropOffer.pad.length, L.MAX_PEER_BODY)
  assert.equal((await L.dialPeer({ ...pin, path: '/peer/drop/offer', body: { pad: 'x'.repeat(L.MAX_MANIFEST_BODY) } })).status, 404)
  assert.equal(calls.dropOffer, before.dropOffer + 1)
})

await ok('unsigned, wrongly signed and replayed requests are the same 404', async () => {
  const body = JSON.stringify({ roster: [], jobDeltas: [], ackedTo: 0, now: 1 })
  assert.equal((await probe(port, 'POST', '/peer/hello', { body, headers: { 'content-type': 'application/json' } })).status, 404)
  const bad = P.signRequest({ secret: randomBytes(32), self: 'bravo', method: 'POST', path: '/peer/hello', body })
  assert.equal((await probe(port, 'POST', '/peer/hello', { body, headers: bad.headers })).status, 404)
  const good = P.signRequest({ secret, self: 'bravo', method: 'POST', path: '/peer/hello', body })
  const r = await probe(port, 'POST', '/peer/hello', { body, headers: good.headers })
  assert.equal(r.status, 200); assert.equal(JSON.parse(r.text).who, 'bravo')
  assert.equal((await probe(port, 'POST', '/peer/hello', { body, headers: good.headers })).status, 404, 'the same nonce twice')
  assert.equal(calls.hello, 1)
})

await ok('an oversized body is a 404 and never reaches a route', async () => {
  const body = JSON.stringify({ text: 'x'.repeat(L.MAX_PEER_BODY + 10) })
  const signed = P.signRequest({ secret, self: 'bravo', method: 'POST', path: '/peer/ask', body })
  assert.equal((await probe(port, 'POST', '/peer/ask', { body, headers: signed.headers })).status, 404)
  assert.equal(calls.ask, 0)
})

await ok('the probe pins by fingerprint and writes nothing; the dialer refuses a wrong pin before the request', async () => {
  const got = await L.fetchPeerCert({ host: '127.0.0.1', port, fingerprint: cert.fingerprint })
  assert.equal(got.ok, true); assert.equal(new X509Certificate(got.pem).fingerprint256, cert.fingerprint)
  assert.deepEqual(await L.fetchPeerCert({ host: '127.0.0.1', port, fingerprint: other.fingerprint }), { ok: false, error: 'fingerprint mismatch' })
  const before = calls.pair
  const wrongCa = await L.dialPeer({ host: '127.0.0.1', port, fingerprint: cert.fingerprint, certPem: other.certPem, path: '/peer/pair', body: {} })
  assert.equal(wrongCa.ok, false)
  const wrongFp = await L.dialPeer({ host: '127.0.0.1', port, fingerprint: other.fingerprint, certPem: cert.certPem, path: '/peer/pair', body: {} })
  assert.equal(wrongFp.ok, false); assert.match(String(wrongFp.error), /fingerprint mismatch/)
  assert.equal(calls.pair, before, 'neither refused dial reached the route')
  const signedDial = await L.dialPeer({ host: '127.0.0.1', port, fingerprint: cert.fingerprint, certPem: cert.certPem, path: '/peer/hello', body: { roster: [] }, secret, self: 'bravo' })
  assert.equal(signedDial.ok, true); assert.equal(typeof signedDial.rttMs, 'number')
})

await ok('stop closes the listener', async () => {
  await listener.stop()
  assert.equal((await probe(port, 'GET', '/')).status, 0)
})

// ---- two engines in-process -------------------------------------------------

const { createPeerLink } = await import(join(ROOT, 'syzygy', 'bridge', 'peer-link.mjs'))

const ENV = { SZG_PEER_BIND: '127.0.0.1', SZG_PEER_PORT: '0', SZG_PEER_HELLO_MS: '200' }
const links = []
const frames = []
const makeLink = ({ dir, env = ENV, hostname, sessions = () => [], now = Date.now, orchestrator = null, dropRoots = undefined, applyAction = undefined, liveForPeer = undefined }) => {
  const link = createPeerLink({
    dir, env, run: realRun, now, hostname, sessions, orchestrator, log: () => {},
    broadcast: (event, data) => frames.push({ event, data }),
    ...(dropRoots ? { dropRoots } : {}),
    ...(applyAction ? { applyAction } : {}),
    ...(liveForPeer ? { liveForPeer } : {}),
  })
  links.push(link)
  return link
}
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const peerOf = (link, name) => link.payload().list.find((p) => p.name === name)

const dirA = tmp()
const dirB = tmp()
let skewA = 0
// Each side's one session is tagged as working for the other, so a roster
// arriving by either route -- the heartbeat's body and its answer -- says so.
const TAG_ASK = 'c'.repeat(16)
const sessionsA = () => [{ id: 'a1', name: 'alpha-work', cwd: '/secret/a', model: 'opus', forPeer: { peer: 'bravo-host', askId: TAG_ASK } }]
const sessionsB = () => [{ id: 'b1', name: 'bravo-work', cwd: '/secret/b', forPeer: { peer: 'alpha', askId: TAG_ASK } }]
let A = makeLink({ dir: dirA, hostname: 'alpha-host', sessions: sessionsA, now: () => Date.now() + skewA })
const B = makeLink({ dir: dirB, hostname: 'bravo-host', sessions: sessionsB })
let C = null
let fpA, fpB, portA, code, freshCode, pairSecret

await ok('off constructs nothing', async () => {
  await A.start()
  await B.start()
  const pa = A.payload()
  assert.equal(pa.enabled, false); assert.equal(pa.listening, false); assert.equal(pa.fingerprint, null)
  assert.equal(pa.self, 'alpha-host'); assert.equal(pa.pairing, null); assert.equal(pa.error, null)
  assert.deepEqual(pa.list, []); assert.deepEqual(pa.asks, []); assert.deepEqual(pa.jobs, [])
  assert.equal(existsSync(join(dirA, S.CERT_FILE)), false)
  assert.equal(existsSync(join(dirA, S.PEERS_FILE)), false)
})

await ok('a wildcard or a hostname bind is refused before anything is minted or bound', async () => {
  const wildDir = tmp()
  const wild = makeLink({ dir: wildDir, env: { SZG_PEER_BIND: '0.0.0.0', SZG_PEER_PORT: '0' }, hostname: 'wild-host' })
  await wild.start()
  const refused = await wild.local('enable', { enabled: true })
  assert.equal(refused.status, 400); assert.match(refused.json.error, /0\.0\.0\.0/); assert.match(refused.json.error, /SZG_PEER_BIND_ANY=1/)
  assert.equal(wild.payload().listening, false)
  assert.equal(existsSync(join(wildDir, S.CERT_FILE)), false)
  await wild.stop()

  // Allowed, the wildcard passes the bind check. openssl points at nothing, so
  // the enable stops at the certificate and never binds every interface.
  const anyDir = tmp()
  const any = makeLink({
    dir: anyDir,
    env: { SZG_PEER_BIND: '0.0.0.0', SZG_PEER_BIND_ANY: '1', SZG_PEER_PORT: '0', SZG_OPENSSL_BIN: join(anyDir, 'no-openssl') },
    hostname: 'any-host',
  })
  await any.start()
  const allowed = await any.local('enable', { enabled: true })
  assert.equal(allowed.status, 503, JSON.stringify(allowed.json)); assert.match(allowed.json.error, /openssl/)
  assert.equal(any.payload().listening, false); assert.equal(any.payload().error, allowed.json.error)
  assert.equal(existsSync(join(anyDir, S.PEERS_FILE)), false, 'a failed enable persists nothing')
  await any.stop()

  const namedDir = tmp()
  const named = makeLink({ dir: namedDir, env: { SZG_PEER_PORT: '0' }, hostname: 'named-host' })
  await named.start()
  assert.equal((await named.local('enable', { enabled: true, bind: 'localhost' })).status, 400)
  assert.equal(named.payload().listening, false)
  await named.stop()
})

await ok('enabling both binds a listener and writes peers.json at 0600', async () => {
  for (const link of [A, B]) {
    const r = await link.local('enable', { enabled: true })
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.ok, true)
    assert.equal(r.json.peers.listening, true); assert.ok(r.json.peers.port > 0)
    assert.ok(P.fpBytes(r.json.peers.fingerprint))
  }
  for (const d of [dirA, dirB]) {
    assert.equal(statSync(join(d, S.PEERS_FILE)).mode & 0o777, 0o600)
    assert.equal(readJson(join(d, S.PEERS_FILE)).enabled, true)
  }
  fpA = A.payload().fingerprint
  fpB = B.payload().fingerprint
  portA = A.payload().port
  assert.notEqual(fpA, fpB)
})

await ok('pairing: the code crosses once and both sides derive the same secret', async () => {
  const offer = await A.local('pair/offer', {})
  assert.equal(offer.status, 200, JSON.stringify(offer.json)); assert.equal(offer.json.fingerprint, fpA)
  code = offer.json.code
  assert.equal(A.payload().pairing.expiresAt, offer.json.expiresAt)
  assert.equal(JSON.stringify(A.payload()).includes(code.split('.')[2]), false)

  const accepted = await B.local('pair/accept', { code, name: 'alpha' })
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json))
  assert.deepEqual(accepted.json, { ok: true, name: 'alpha', fingerprint: fpA, localFingerprint: fpB })
  // Checked before anything can yield to the heartbeat the accept scheduled.
  assert.equal(peerOf(B, 'alpha').health.state, 'never')

  const [ofA] = A.payload().list
  const [ofB] = B.payload().list
  assert.equal(A.payload().list.length, 1); assert.equal(B.payload().list.length, 1)
  assert.equal(ofA.name, 'bravo-host'); assert.equal(ofA.remoteName, 'bravo-host'); assert.equal(ofA.dials, false)
  assert.equal(ofB.name, 'alpha'); assert.equal(ofB.remoteName, 'alpha-host'); assert.equal(ofB.dials, true)
  assert.equal(ofA.fingerprint, fpB); assert.equal(ofB.fingerprint, fpA)
  assert.equal(ofA.localFingerprint, fpA); assert.equal(ofB.localFingerprint, fpB)
  assert.equal(ofA.confirmedAt, null); assert.equal(ofB.confirmedAt, null)

  const secretA = readJson(join(dirA, S.PEERS_FILE)).peers[0].secret
  const secretB = readJson(join(dirB, S.PEERS_FILE)).peers[0].secret
  assert.match(secretA, /^[0-9a-f]{64}$/); assert.equal(secretA, secretB)
  pairSecret = secretA
  assert.equal(A.payload().pairing, null, 'the code is burned')
})

await ok('health goes never -> up on the first heartbeat, on both sides', async () => {
  await B.tick()
  const h = peerOf(B, 'alpha').health
  assert.equal(h.state, 'up', JSON.stringify(h))
  assert.equal(typeof h.rttMs, 'number'); assert.equal(typeof h.skewMs, 'number')
  assert.equal(peerOf(A, 'bravo-host').health.state, 'up', 'the dialled side counts the inbound heartbeat')
})

await ok('rosters wait for confirmation on both sides, and cross as ghost fields only', async () => {
  assert.deepEqual(peerOf(A, 'bravo-host').sessions, []); assert.deepEqual(peerOf(B, 'alpha').sessions, [])
  assert.equal((await A.local('pair/confirm', { name: 'bravo-host' })).status, 200)
  assert.equal((await B.local('pair/confirm', { name: 'alpha' })).status, 200)
  assert.equal(typeof peerOf(A, 'bravo-host').confirmedAt, 'number')
  await B.tick()
  assert.deepEqual(peerOf(B, 'alpha').sessions, [{ id: 'a1', name: 'alpha-work', model: 'opus', working: false, needs: '', branch: null, root: null, forYou: true }])
  assert.deepEqual(peerOf(A, 'bravo-host').sessions, [{ id: 'b1', name: 'bravo-work', model: null, working: false, needs: '', branch: null, root: null, forYou: true }])
  for (const link of [A, B]) assert.equal(JSON.stringify(link.payload()).includes('/secret/'), false)
  for (const link of [A, B]) assert.equal(JSON.stringify(link.payload().list).includes(TAG_ASK), false, 'the ask id never crosses')
  assert.equal((await A.local('pair/confirm', { name: 'nobody' })).status, 404)
})

await ok('a code is single-use, and a late one is refused', async () => {
  C = makeLink({ dir: tmp(), hostname: 'charlie-host' })
  await C.start()
  assert.equal((await C.local('enable', { enabled: true })).status, 200)
  const reused = await C.local('pair/accept', { code, name: 'alpha' })
  assert.equal(reused.status, 502, JSON.stringify(reused.json))
  assert.equal((await C.local('pair/accept', { code: 'szg1.garbage.code', name: 'alpha' })).status, 400)

  const fresh = await A.local('pair/offer', {})
  assert.equal(fresh.status, 200)
  freshCode = fresh.json.code
  skewA = P.PAIR_TOKEN_MS + 60_000
  assert.equal(A.payload().pairing, null)
  const late = await C.local('pair/accept', { code: freshCode, name: 'alpha' })
  assert.equal(late.status, 502, JSON.stringify(late.json))
  assert.equal(A.payload().list.length, 1); assert.equal(C.payload().list.length, 0)
})

await ok('down within a heartbeat of the other side stopping; up when it restarts', async () => {
  const certFile = join(dirA, S.CERT_FILE)
  const mtime = statSync(certFile).mtimeMs
  await A.stop()
  skewA = 0
  await B.tick()
  const down = peerOf(B, 'alpha').health
  assert.equal(down.state, 'down', JSON.stringify(down)); assert.equal(typeof down.error, 'string'); assert.ok(down.error.length > 0)

  // B dials the address the code carried, so A comes back on the port it had.
  A = makeLink({ dir: dirA, env: { ...ENV, SZG_PEER_PORT: String(portA) }, hostname: 'alpha-host', sessions: sessionsA })
  await A.start()
  const pa = A.payload()
  assert.equal(pa.enabled, true); assert.equal(pa.listening, true, JSON.stringify(pa.error)); assert.equal(pa.error, null)
  assert.equal(pa.port, portA); assert.equal(pa.fingerprint, fpA)
  assert.equal(statSync(certFile).mtimeMs, mtime, 'the certificate is not minted again')
  await B.tick()
  assert.equal(peerOf(B, 'alpha').health.state, 'up', JSON.stringify(peerOf(B, 'alpha').health))
})

await ok('forget is revocation: the dialling side reads refused (404)', async () => {
  assert.equal((await A.local('forget', { name: 'bravo-host' })).status, 200)
  assert.deepEqual(A.payload().list, [])
  assert.deepEqual(readJson(join(dirA, S.PEERS_FILE)).peers, [])
  await B.tick()
  const h = peerOf(B, 'alpha').health
  assert.equal(h.state, 'down'); assert.equal(h.error, 'refused (404)')
  assert.equal((await A.local('forget', { name: 'bravo-host' })).status, 404)
})

await ok('no secret, certificate, address or code in any payload or frame', async () => {
  const stored = readJson(join(dirB, S.PEERS_FILE)).peers[0]
  assert.ok(stored.address && stored.certPem, 'B holds an address and a pinned certificate that could leak')
  const certLines = [dirA, dirB].map((d) => readFileSync(join(d, S.CERT_FILE), 'utf8').split('\n')[1])
  const tokens = [code, freshCode].map((c) => c.split('.')[2])
  const texts = [A, B, C].map((link) => JSON.stringify(link.payload())).concat(frames.map((f) => JSON.stringify(f)))
  assert.ok(frames.length > 0)
  for (const text of texts) {
    assert.equal(text.includes(pairSecret), false)
    for (const line of certLines) assert.equal(text.includes(line), false)
    assert.equal(text.includes('BEGIN CERTIFICATE'), false)
    assert.equal(text.includes('"address"'), false)
    for (const t of tokens) assert.equal(text.includes(t), false)
  }
})

await ok('policy is validated, published and saved', async () => {
  const policy = { ...P.DEFAULT_POLICY, autoApply: [], asksPerHour: 3, peerAskDailyCapUsd: 0.5 }
  const r = await B.local('policy', { name: 'alpha', asksPerHour: 3, peerAskDailyCapUsd: 0.5 })
  assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true, policy })
  assert.deepEqual(peerOf(B, 'alpha').policy, policy)
  assert.deepEqual(readJson(join(dirB, S.PEERS_FILE)).peers[0].policy, policy)
  assert.equal((await B.local('policy', { name: 'alpha', asksPerHour: -1, peerAskDailyCapUsd: 0.5 })).status, 400)
  assert.equal((await B.local('policy', { name: 'nobody', ...policy })).status, 404)
  assert.deepEqual(peerOf(B, 'alpha').policy, policy, 'a refused change changes nothing')
  assert.deepEqual(await B.local('no/such/thing', {}), { status: 404, json: { error: 'no such endpoint' } })
})

await ok('address: the dialling side re-points a peer that moved, and the pinned fingerprint still has to answer there', async () => {
  // A fresh pair with a long heartbeat, so every dial here is one the case asked for.
  const QUIET = { ...ENV, SZG_PEER_HELLO_MS: '60000' }
  const dirD = tmp()
  const dirE = tmp()
  let D = makeLink({ dir: dirD, env: QUIET, hostname: 'delta-host' })
  const E = makeLink({ dir: dirE, env: QUIET, hostname: 'echo-host' })
  for (const link of [D, E]) {
    await link.start()
    assert.equal((await link.local('enable', { enabled: true })).status, 200)
  }
  const offer = await D.local('pair/offer', {})
  assert.equal((await E.local('pair/accept', { code: offer.json.code, name: 'delta' })).status, 200)
  assert.equal((await D.local('pair/confirm', { name: 'echo-host' })).status, 200)
  assert.equal((await E.local('pair/confirm', { name: 'delta' })).status, 200)
  await E.tick()
  assert.equal(peerOf(E, 'delta').health.state, 'up')
  const storedAddress = () => readJson(join(dirE, S.PEERS_FILE)).peers[0].address
  const firstPort = D.payload().port

  // D comes back on a port of the OS's choosing, which the code E accepted never named.
  await D.stop()
  D = makeLink({ dir: dirD, env: QUIET, hostname: 'delta-host' })
  await D.start()
  const movedPort = D.payload().port
  assert.notEqual(movedPort, firstPort)
  await E.tick()
  assert.equal(peerOf(E, 'delta').health.state, 'down')

  const refusals = [
    [E, { name: 'nobody', host: '127.0.0.1', port: movedPort }, 404],
    [D, { name: 'echo-host', host: '127.0.0.1', port: movedPort }, 409],
    [E, { name: 'delta', host: 'example.com', port: movedPort }, 400],
    [E, { name: 'delta', host: '0.0.0.0', port: movedPort }, 400],
    [E, { name: 'delta', host: '127.0.0.1', port: 0 }, 400],
    [E, { name: 'delta', host: '127.0.0.1', port: '4318' }, 400],
  ]
  for (const [link, body, status] of refusals) {
    assert.equal((await link.local('address', body)).status, status, JSON.stringify(body))
  }
  assert.deepEqual(storedAddress(), { host: '127.0.0.1', port: firstPort }, 'a refused change changes nothing')
  assert.equal(readJson(join(dirD, S.PEERS_FILE)).peers[0].address, null, 'the dialled side still holds no address')

  const r = await E.local('address', { name: 'delta', host: '127.0.0.1', port: movedPort })
  assert.deepEqual(r, { status: 200, json: { ok: true } })
  assert.deepEqual(storedAddress(), { host: '127.0.0.1', port: movedPort })
  const kept = readJson(join(dirE, S.PEERS_FILE)).peers[0]
  assert.equal(kept.fingerprint, D.payload().fingerprint); assert.equal(typeof kept.confirmedAt, 'number')
  assert.equal(JSON.stringify(E.payload()).includes('"address"'), false, 'the address never reaches the payload')
  await E.tick()
  assert.equal(peerOf(E, 'delta').health.state, 'up', JSON.stringify(peerOf(E, 'delta').health))

  // Pointed at a listener holding another certificate, the dial fails closed.
  assert.equal((await E.local('address', { name: 'delta', host: '127.0.0.1', port: C.payload().port })).status, 200)
  await E.tick()
  assert.equal(peerOf(E, 'delta').health.state, 'down')
})

for (const link of links) await link.stop()

// ---- asks between two engines in-process ------------------------------------
// A fresh pair, because the one above ended forgotten. Each side's orchestrator
// is a stand-in whose turns a case scripts one at a time; an unscripted turn
// answers at once and proposes one action. The heartbeat interval is long, so
// every heartbeat here is one a case asked for.

const fakeOrchestrator = () => {
  const script = []
  const calls = []
  const orch = {
    script,
    calls,
    lastPolicy: null,
    liaisonAsk: async (text, { peer, askId, policy } = {}) => {
      calls.push({ text, peer, askId })
      orch.lastPolicy = policy
      const turn = script.shift() ?? (() => ({ ok: true, id: 'x', text: 'reply to ' + text, actions: [{ kind: 'link' }], rejected: [], costUsd: 0.01, error: null }))
      return turn(text, peer, { askId, policy })
    },
  }
  return orch
}
const ASK_ENV = { ...ENV, SZG_PEER_HELLO_MS: '60000', SZG_PEER_ASK_RETRY_MS: '50,100,200' }
const askDirA = tmp()
const askDirB = tmp()
const orchA = fakeOrchestrator()
const orchB = fakeOrchestrator()
// Both engines apply through one recorder, whose outcome a case may change,
// and which awaits `onApply` during a call when a case sets one.
const applied = []
let applyOutcome = { ok: true }
let onApply = null
const recordApply = async (action, opts) => {
  applied.push({ action, opts })
  if (onApply) await onApply(action, opts)
  return applyOutcome
}
let A2 = makeLink({ dir: askDirA, env: ASK_ENV, hostname: 'alpha-host', orchestrator: orchA, applyAction: recordApply, liveForPeer: () => 0 })
const B2 = makeLink({ dir: askDirB, env: ASK_ENV, hostname: 'bravo-host', orchestrator: orchB, applyAction: recordApply, liveForPeer: () => 0 })
let askSecret = null

const askOf = (link, dir, text) => link.payload().asks.find((e) => e.dir === dir && e.text === text) ?? null
const showAsks = (link) => async () => JSON.stringify(link.payload().asks)
const storedAsks = (link, dir) => { link.flush(); return readJson(join(dir, S.ASKS_FILE)).items }
const busyTurn = () => ({ ok: false, code: 409, error: 'busy' })
const signedPost = (port, path, { secret: key, self, body }) => {
  const signed = P.signRequest({ secret: Buffer.from(key, 'hex'), self, method: 'POST', path, body })
  return probe(port, 'POST', path, { body, headers: { 'content-type': 'application/json', ...signed.headers } })
}
/** Heartbeats from B until A's copy and B's copy of an ask have both settled. */
const settledBoth = async (text, state = 'answered') => {
  const inA = await until(`A's copy of ${JSON.stringify(text)} to be ${state}`, async () => {
    const e = askOf(A2, 'in', text)
    return e?.state === state && e
  }, { show: showAsks(A2) })
  const out = await until(`B's copy of ${JSON.stringify(text)} to be ${state}`, async () => {
    await B2.tick()
    const e = askOf(B2, 'out', text)
    return e?.state === state && e
  }, { show: showAsks(B2) })
  return { inA, out }
}

await ok('asks: a fresh pair, paired and confirmed on both sides', async () => {
  await A2.start()
  await B2.start()
  for (const link of [A2, B2]) assert.equal((await link.local('enable', { enabled: true })).status, 200)
  const offer = await A2.local('pair/offer', {})
  assert.equal(offer.status, 200, JSON.stringify(offer.json))
  const accepted = await B2.local('pair/accept', { code: offer.json.code, name: 'alpha' })
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json))
  assert.equal((await A2.local('pair/confirm', { name: 'bravo-host' })).status, 200)
  assert.equal((await B2.local('pair/confirm', { name: 'alpha' })).status, 200)
  await B2.tick()
  assert.equal(peerOf(B2, 'alpha').health.state, 'up', JSON.stringify(peerOf(B2, 'alpha').health))
  askSecret = readJson(join(askDirA, S.PEERS_FILE)).peers[0].secret
})

await ok('asks: B asks A directly, and only the count of proposed actions comes back', async () => {
  const r = await B2.local('alpha/ask', { text: '  status?  ' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true); assert.equal(r.json.state, 'queued'); assert.match(r.json.askId, /^[0-9a-f]{16}$/)
  const { inA, out } = await settledBoth('status?')
  assert.equal(out.id, r.json.id); assert.equal(out.peer, 'alpha')
  assert.equal(out.reply, 'reply to status?'); assert.equal(out.actionsProposed, 1); assert.equal(out.error, null)
  assert.equal(inA.peer, 'bravo-host'); assert.equal(inA.costUsd, 0.01); assert.equal(inA.reply, 'reply to status?')
  assert.deepEqual(orchA.calls.at(-1), { text: 'status?', peer: 'bravo-host', askId: inA.id }, 'the turn is told the ask\'s store id')
  for (const link of [A2, B2]) for (const e of link.payload().asks) assert.equal(Object.hasOwn(e, 'actions'), false)
  const actionsKey = JSON.stringify('actions') + ':'
  for (const [link, d] of [[A2, askDirA], [B2, askDirB]]) {
    assert.equal(storedAsks(link, d).some((e) => Object.hasOwn(e, 'actions')), false, 'no entry in the ask log carries actions')
    assert.equal(readFileSync(join(d, S.ASKS_FILE), 'utf8').includes(actionsKey), false, 'no actions anywhere in the ask log')
  }
})

await ok('asks: tagFor answers a tag for an incoming ask only, with the peer name from the log', async () => {
  const inA = askOf(A2, 'in', 'status?')
  const outB = askOf(B2, 'out', 'status?')
  assert.deepEqual(A2.tagFor(inA.id), { peer: 'bravo-host', askId: inA.id })
  assert.equal(B2.tagFor(outB.id), null, 'an ask this side sent puts no work on this board')
  assert.equal(A2.tagFor('f'.repeat(16)), null)
  assert.equal(A2.tagFor(42), null)
  assert.equal(A2.tagFor(undefined), null)
})

await ok('asks: A asks B through the heartbeat, which also carries the acknowledgement', async () => {
  let release
  const gate = new Promise((resolveGate) => { release = resolveGate })
  orchB.script.push(async (text) => {
    await gate
    return { ok: true, id: 'y', text: 'reply to ' + text, actions: [], rejected: [], costUsd: 0.02, error: null }
  })
  const r = await A2.local('bravo-host/ask', { text: 'and you?' })
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.state, 'queued')
  assert.equal(askOf(B2, 'in', 'and you?'), null)
  await B2.tick()
  assert.ok(askOf(B2, 'in', 'and you?'), 'B holds the ask after one heartbeat')
  assert.equal(askOf(A2, 'out', 'and you?').state, 'queued', 'not acknowledged until the next heartbeat')
  await B2.tick()
  assert.equal(askOf(A2, 'out', 'and you?').state, 'sent')
  release()
  const out = await until("A's ask to be answered", async () => {
    const e = askOf(A2, 'out', 'and you?')
    return e?.state === 'answered' && e
  }, { show: showAsks(A2) })
  assert.equal(out.reply, 'reply to and you?'); assert.equal(out.actionsProposed, 0)
  assert.equal(askOf(B2, 'in', 'and you?').state, 'answered')
})

await ok('asks: a dry run returns the signed envelope and records nothing', async () => {
  const count = B2.payload().asks.length
  const framesBefore = frames.length
  const r = await B2.local('alpha/ask', { text: 'x', dryRun: true })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const { envelope } = r.json
  assert.equal(envelope.method, 'POST'); assert.equal(envelope.path, '/peer/ask')
  assert.ok(envelope.canonical.startsWith('POST\n/peer/ask?\n'), envelope.canonical)
  assert.equal(envelope.headers['x-szg-peer'], 'bravo-host')
  assert.equal(envelope.bodySha256, P.sha256hex(envelope.body)); assert.equal(JSON.parse(envelope.body).text, 'x')
  const verifies = P.verifySignature({ secret: Buffer.from(askSecret, 'hex'), method: 'POST', path: '/peer/ask', query: '', headers: envelope.headers, bodySha256: envelope.bodySha256 })
  assert.equal(verifies, true, 'signed with the pair secret')
  assert.equal(JSON.stringify(r.json).includes(askSecret), false)
  assert.equal(B2.payload().asks.length, count); assert.equal(frames.length, framesBefore)
})

await ok('asks: a busy orchestrator is retried on the ladder, and the ask is answered', async () => {
  orchA.script.push(busyTurn, busyTurn)
  assert.equal((await B2.local('alpha/ask', { text: 'busy twice' })).status, 200)
  const { inA } = await settledBoth('busy twice')
  assert.equal(storedAsks(A2, askDirA).find((e) => e.id === inA.id).attempts, 3)
})

await ok('asks: busy for good is held, sends nothing back, and a release answers it', async () => {
  orchA.script.push(busyTurn, busyTurn, busyTurn, busyTurn)
  assert.equal((await B2.local('alpha/ask', { text: 'busy for good' })).status, 200)
  const held = await until("A's copy to be held", async () => {
    const e = askOf(A2, 'in', 'busy for good')
    return e?.state === 'held' && e
  }, { show: showAsks(A2) })
  assert.equal(held.error, 'the orchestrator stayed busy'); assert.equal(orchA.script.length, 0)
  await B2.tick()
  assert.equal(askOf(B2, 'out', 'busy for good').state, 'sent')
  assert.deepEqual(await A2.local('ask/answer', { id: held.id }), { status: 200, json: { ok: true } })
  await settledBoth('busy for good')
  assert.deepEqual(await A2.local('ask/answer', { id: held.id }), { status: 409, json: { error: 'only a held ask can be released' } })
})

await ok('asks: a released ask that meets one more busy slot retries on the full ladder, not straight back to held', async () => {
  orchA.script.push(busyTurn, busyTurn, busyTurn, busyTurn)
  assert.equal((await B2.local('alpha/ask', { text: 'busy after release' })).status, 200)
  const held = await until("A's copy to be held", async () => {
    const e = askOf(A2, 'in', 'busy after release')
    return e?.state === 'held' && e
  }, { show: showAsks(A2) })
  assert.equal(held.error, 'the orchestrator stayed busy'); assert.equal(orchA.script.length, 0)
  orchA.script.push(() => ({ ok: false, code: 409, error: 'busy' }), () => ({ ok: true, id: 'z', text: 'reply to busy after release', actions: [], rejected: [], costUsd: 0.01, error: null }))
  const calls = orchA.calls.length
  assert.deepEqual(await A2.local('ask/answer', { id: held.id }), { status: 200, json: { ok: true } })
  const settled = await until("A's released copy to be answered or held again", async () => {
    const e = askOf(A2, 'in', 'busy after release')
    return (e?.state === 'answered' || (e?.state === 'held' && orchA.calls.length > calls)) && e
  }, { show: showAsks(A2) })
  assert.equal(settled.state, 'answered', `released ask ended ${settled.state}: ${settled.error}`)
  assert.equal(orchA.script.length, 0)
  const { out } = await settledBoth('busy after release')
  assert.equal(out.state, 'answered'); assert.equal(out.reply, 'reply to busy after release')
})

await ok('asks: the hourly cap holds an ask without a turn, and a release answers it past the cap', async () => {
  assert.equal((await A2.local('policy', { name: 'bravo-host', asksPerHour: 0, peerAskDailyCapUsd: 2 })).status, 200)
  const calls = orchA.calls.length
  assert.equal((await B2.local('alpha/ask', { text: 'over the cap' })).status, 200)
  const held = await until("A's copy to be held", async () => {
    const e = askOf(A2, 'in', 'over the cap')
    return e?.state === 'held' && e
  }, { show: showAsks(A2) })
  assert.equal(held.error, 'asks per hour cap reached'); assert.equal(orchA.calls.length, calls, 'no turn was started')
  assert.equal((await A2.local('ask/answer', { id: held.id })).status, 200)
  await settledBoth('over the cap')
  assert.equal((await A2.local('policy', { name: 'bravo-host', asksPerHour: 20, peerAskDailyCapUsd: 2 })).status, 200)
})

await ok('asks: nothing is asked of or accepted from a peer until it is confirmed', async () => {
  const dirD = tmp()
  const dirE = tmp()
  const orchD = fakeOrchestrator()
  const D = makeLink({ dir: dirD, env: ASK_ENV, hostname: 'delta-host', orchestrator: orchD })
  const E = makeLink({ dir: dirE, env: ASK_ENV, hostname: 'echo-host', orchestrator: fakeOrchestrator() })
  try {
    for (const link of [D, E]) { await link.start(); assert.equal((await link.local('enable', { enabled: true })).status, 200) }
    const offer = await D.local('pair/offer', {})
    assert.equal((await E.local('pair/accept', { code: offer.json.code, name: 'delta' })).status, 200)
    const unconfirmed = { status: 409, json: { error: 'confirm the fingerprints first' } }
    assert.deepEqual(await E.local('delta/ask', { text: 'hello?' }), unconfirmed)
    assert.deepEqual(await D.local('echo-host/ask', { text: 'hello?' }), unconfirmed)
    assert.deepEqual(await E.local('delta/ask', { text: 'hello?', dryRun: true }), unconfirmed)

    const secretD = readJson(join(dirD, S.PEERS_FILE)).peers[0].secret
    const portD = D.payload().port
    const askBody = JSON.stringify({ askId: randomBytes(8).toString('hex'), text: 'let me in' })
    const refused = await signedPost(portD, '/peer/ask', { secret: secretD, self: 'echo-host', body: askBody })
    assert.equal(refused.status, 404); assert.equal(refused.text, '')
    // The same secret signs a heartbeat that is answered, so the 404 above is
    // the missing confirmation and not the signature.
    const helloBody = JSON.stringify({ roster: [], jobDeltas: [], ackedTo: 0, now: Date.now() })
    assert.equal((await signedPost(portD, '/peer/hello', { secret: secretD, self: 'echo-host', body: helloBody })).status, 200)
    assert.deepEqual(D.payload().asks, []); assert.deepEqual(E.payload().asks, []); assert.equal(orchD.calls.length, 0)

    assert.deepEqual(await B2.local('nobody/ask', { text: 'x' }), { status: 404, json: { error: 'no such peer' } })
    assert.equal((await B2.local('alpha/ask', { text: '   ' })).status, 400)
    assert.equal((await B2.local('alpha/ask', {})).status, 400)
    assert.equal((await B2.local('alpha/ask', { text: 'x'.repeat(P.ASK_TEXT_MAX + 1) })).status, 400)
  } finally {
    await D.stop()
    await E.stop()
  }
})

await ok('asks: the same askId twice is accepted twice and recorded once; a malformed one is the 404', async () => {
  const portA2 = A2.payload().port
  const askId = randomBytes(8).toString('hex')
  const body = JSON.stringify({ askId, text: 'said twice' })
  for (let i = 0; i < 2; i++) {
    const r = await signedPost(portA2, '/peer/ask', { secret: askSecret, self: 'bravo-host', body })
    assert.equal(r.status, 200, `attempt ${i + 1}`); assert.deepEqual(JSON.parse(r.text), { accepted: true })
  }
  assert.equal(A2.payload().asks.filter((e) => e.dir === 'in' && e.text === 'said twice').length, 1)
  assert.equal(storedAsks(A2, askDirA).filter((e) => e.askId === askId).length, 1)
  const malformed = await signedPost(portA2, '/peer/ask', { secret: askSecret, self: 'bravo-host', body: JSON.stringify({ askId: 'not-hex', text: 'x' }) })
  assert.equal(malformed.status, 404); assert.equal(malformed.text, '')
  await until("A's copy of the repeated ask to be answered", async () => askOf(A2, 'in', 'said twice')?.state === 'answered', { show: showAsks(A2) })
  // Its reply finds no ask on B, which ignores it.
  await B2.tick()
  assert.equal(askOf(B2, 'out', 'said twice'), null)
})

await ok('asks: a turn that ran and failed still replies, with its partial text', async () => {
  orchA.script.push(() => ({ ok: true, id: 'x', text: 'partial', actions: [], rejected: [], costUsd: 0.2, error: 'Reached maximum budget ($1.00)' }))
  assert.equal((await B2.local('alpha/ask', { text: 'too expensive' })).status, 200)
  const { inA, out } = await settledBoth('too expensive', 'failed')
  assert.equal(out.error, 'Reached maximum budget ($1.00)'); assert.equal(out.reply, 'partial'); assert.equal(out.actionsProposed, 0)
  assert.equal(inA.costUsd, 0.2); assert.equal(inA.error, 'Reached maximum budget ($1.00)')
})

await ok('asks: a turn interrupted by a restart is queued again and answered', async () => {
  orchA.script.push(() => new Promise(() => {}))
  const portA2 = A2.payload().port
  assert.equal((await B2.local('alpha/ask', { text: 'across a restart' })).status, 200)
  const answering = await until("A's copy to be answering", async () => {
    const e = askOf(A2, 'in', 'across a restart')
    return e?.state === 'answering' && e
  }, { show: showAsks(A2) })
  await B2.tick()
  assert.equal(askOf(B2, 'out', 'across a restart').state, 'sent')
  await A2.stop()
  assert.equal(readJson(join(askDirA, S.ASKS_FILE)).items.find((e) => e.id === answering.id).state, 'answering')

  const framesBefore = frames.length
  A2 = makeLink({ dir: askDirA, env: { ...ASK_ENV, SZG_PEER_PORT: String(portA2) }, hostname: 'alpha-host', orchestrator: orchA, applyAction: recordApply, liveForPeer: () => 0 })
  await A2.start()
  const { inA } = await settledBoth('across a restart')
  assert.equal(inA.id, answering.id)
  const queuedFrame = frames.slice(framesBefore).some((f) => f.event === 'peers' && f.data.asks.some((e) => e.id === answering.id && e.state === 'queued'))
  assert.ok(queuedFrame, 'the resumed ask was published as queued before it was answered')
  assert.equal(storedAsks(A2, askDirA).find((e) => e.id === answering.id).attempts, 2)
})

await ok('agent loop: the policy route merges, validates each field and keeps the rest', async () => {
  const bad = await A2.local('policy', { name: 'bravo-host', trust: 'review' })
  assert.equal(bad.status, 400); assert.match(bad.json.error, /^trust /)
  assert.equal((await A2.local('policy', { name: 'bravo-host', autoApply: ['arm_resume'] })).status, 400)
  const good = await A2.local('policy', { name: 'bravo-host', trust: 'sanctioned', autoApply: ['link', 'spawn'], extra: true })
  assert.equal(good.status, 200, JSON.stringify(good.json))
  assert.deepEqual(peerOf(A2, 'bravo-host').policy, { asksPerHour: 20, peerAskDailyCapUsd: 2, trust: 'sanctioned', autoApply: ['spawn', 'link'], autoApplyMaxLive: 2, peerAsksPerHour: 6 })
  assert.equal((await A2.local('policy', { name: 'bravo-host', trust: 'manual', autoApply: [] })).status, 200)
})

await ok('agent loop: a hello and an ask carrying policy keys change nothing', async () => {
  const peerPort = A2.payload().port
  const hello = JSON.stringify({ roster: [], jobDeltas: [], ackedTo: 0, policy: { trust: 'sanctioned', autoApply: ['spawn'] }, trust: 'sanctioned', autoApply: ['spawn'] })
  assert.equal((await signedPost(peerPort, '/peer/hello', { secret: askSecret, self: 'bravo-host', body: hello })).status, 200)
  const ask = JSON.stringify({ askId: 'e'.repeat(16), text: 'raise my tier', policy: { trust: 'sanctioned' }, trust: 'sanctioned' })
  assert.equal((await signedPost(peerPort, '/peer/ask', { secret: askSecret, self: 'bravo-host', body: ask })).status, 200)
  const p = peerOf(A2, 'bravo-host').policy
  assert.equal(p.trust, 'manual'); assert.deepEqual(p.autoApply, [])
  // Its turn is answered before a later case scripts one, so it cannot take that turn.
  await until("A's copy of the policy-carrying ask to be answered", async () => askOf(A2, 'in', 'raise my tier')?.state === 'answered', { show: showAsks(A2) })
})

await ok('agent loop: a local turn\'s peer_ask under sanctioned applies without a click; manual and the cap leave it a button', async () => {
  applied.length = 0
  const actions = [{ kind: 'peer_ask', peer: 'alpha', text: 'run the probe' }, { kind: 'spawn', cwd: '/w', prompt: 'p' }]
  let shown = B2.gate({ source: 'ask', turnId: 't-manual', threadId: 'th', peer: null, askId: null, actions })
  assert.deepEqual(shown.map((a) => a.gate), ['button', 'button'])
  assert.equal((await B2.local('policy', { name: 'alpha', trust: 'sanctioned', peerAsksPerHour: 1 })).status, 200)
  frames.length = 0
  shown = B2.gate({ source: 'ask', turnId: 't-auto', threadId: 'th', peer: null, askId: null, actions })
  assert.deepEqual(shown.map((a) => a.gate), ['auto', 'button'])
  await until('the automatic apply to run', async () => applied.length === 1)
  assert.equal(applied[0].action.kind, 'peer_ask'); assert.deepEqual(applied[0].opts, { peer: null, forAsk: null })
  const frame = await until('the applied frame', async () => frames.find((f) => f.event === 'orchestrator' && f.data.id === 't-auto')?.data)
  assert.deepEqual(frame, { id: 't-auto', threadId: 'th', applied: [{ index: 0, ok: true, error: null }] })
  // The recorder never created an ask, so count one the way a real apply would.
  assert.equal((await B2.local('alpha/ask', { text: 'run the probe', origin: 'agent' })).status, 200)
  const refused = await B2.local('alpha/ask', { text: 'and another', origin: 'agent' })
  assert.equal(refused.status, 409); assert.match(refused.json.error, /ask box on the Peering tab/)
  assert.equal((await B2.local('alpha/ask', { text: 'typed by a person' })).status, 200, 'a person\'s ask is not capped')
  assert.equal(B2.payload().asks.find((e) => e.text === 'run the probe').origin, 'agent')
  shown = B2.gate({ source: 'ask', turnId: 't-cap', threadId: 'th', peer: null, askId: null, actions: [actions[0]] })
  assert.deepEqual(shown, [{ ...actions[0], gate: 'button', gateNote: 'peer_ask hourly cap reached' }])
  assert.equal((await B2.local('policy', { name: 'alpha', trust: 'manual', peerAsksPerHour: 6 })).status, 200)
  // Both asks reach A and are answered there before a later case scripts a turn.
  await settledBoth('run the probe')
  await settledBoth('typed by a person')
})

await ok('agent loop: two peer_asks to one peer in one local turn share the hourly allowance', async () => {
  applied.length = 0
  // One agent ask to alpha is already in this hour, so two leaves room for one.
  assert.equal((await B2.local('policy', { name: 'alpha', trust: 'sanctioned', peerAsksPerHour: 2 })).status, 200)
  try {
    const actions = [{ kind: 'peer_ask', peer: 'alpha', text: 'first' }, { kind: 'peer_ask', peer: 'alpha', text: 'second' }]
    const shown = B2.gate({ source: 'ask', turnId: 't-two', threadId: 'th', peer: null, askId: null, actions })
    assert.deepEqual(shown.map((a) => [a.gate, a.gateNote ?? null]), [['auto', null], ['button', 'peer_ask hourly cap reached']])
    const frame = await until('the applied frame', async () => frames.find((f) => f.event === 'orchestrator' && f.data.id === 't-two')?.data)
    assert.deepEqual(frame.applied, [{ index: 0, ok: true, error: null }])
    assert.equal(applied.length, 1); assert.equal(applied[0].action.text, 'first')
  } finally {
    assert.equal((await B2.local('policy', { name: 'alpha', trust: 'manual', peerAsksPerHour: 6 })).status, 200)
  }
})

await ok('agent loop: a liaison turn under sanctioned applies listed kinds, records them on the ask, and holds the live cap', async () => {
  applied.length = 0
  assert.equal((await A2.local('policy', { name: 'bravo-host', trust: 'sanctioned', autoApply: ['spawn'], autoApplyMaxLive: 1 })).status, 200)
  let gatedActions = null
  orchA.script.push((text, peer, { askId, policy }) => {
    assert.equal(policy.trust, 'sanctioned')
    gatedActions = A2.gate({ source: 'liaison', turnId: 'l-1', threadId: null, peer, askId, actions: [
      { kind: 'spawn', cwd: '/w', prompt: 'collect', risk: 'starts a session' },
      { kind: 'spawn', cwd: '/w', prompt: 'a second' },
      { kind: 'peer_ask', peer: 'bravo-host', text: 'loop back' },
    ] })
    return { ok: true, id: 'l-1', text: 'starting', actions: gatedActions, rejected: [], costUsd: 0.01, error: null }
  })
  assert.equal((await B2.local('alpha/ask', { text: 'start a collector' })).status, 200)
  const { inA } = await settledBoth('start a collector')
  assert.deepEqual(gatedActions.map((a) => [a.gate, a.gateNote ?? null]), [['auto', null], ['button', 'live session cap reached'], ['button', null]])
  await until('the spawn to apply', async () => applied.length === 1)
  assert.deepEqual(applied[0].opts, { peer: 'bravo-host', forAsk: inA.id })
  const rec = await until('the proposal to settle', async () => {
    const e = A2.payload().asks.find((x) => x.id === inA.id)
    return e?.proposals?.[0]?.state === 'applied' && e
  })
  assert.deepEqual(rec.proposals, [{ kind: 'spawn', mode: 'auto', state: 'applied', risk: 'starts a session', error: null }])
  assert.equal(applied.some((x) => x.action.kind === 'peer_ask'), false, 'a liaison turn never sends a peer_ask on its own')
  assert.equal((await A2.local('policy', { name: 'bravo-host', trust: 'manual', autoApply: [] })).status, 200)
})

await ok('agent loop: an engine that is not running gates nothing', async () => {
  const idle = makeLink({ dir: tmp(), env: ASK_ENV, hostname: 'idle-host', applyAction: recordApply })
  const actions = [{ kind: 'peer_ask', peer: 'bravo-host', text: 't' }]
  const shown = idle.gate({ source: 'ask', turnId: 'x', actions })
  assert.deepEqual(shown, actions)
  assert.equal(Object.hasOwn(shown[0], 'gate'), false)
})

await ok('agent loop: a failed automatic apply is recorded on the ask and reported in the frame', async () => {
  applied.length = 0
  assert.equal((await A2.local('policy', { name: 'bravo-host', trust: 'sanctioned', autoApply: ['spawn'] })).status, 200)
  applyOutcome = { ok: false, error: 'claude --bg failed' }
  try {
    orchA.script.push((text, peer, { askId }) => {
      const actions = A2.gate({ source: 'liaison', turnId: 'l-fail', threadId: null, peer, askId, actions: [{ kind: 'spawn', cwd: '/w', prompt: 'will not start' }] })
      return { ok: true, id: 'l-fail', text: 'trying', actions, rejected: [], costUsd: 0.01, error: null }
    })
    assert.equal((await B2.local('alpha/ask', { text: 'start one that fails' })).status, 200)
    const { inA } = await settledBoth('start one that fails')
    const rec = await until('the failed proposal to settle', async () => {
      const e = A2.payload().asks.find((x) => x.id === inA.id)
      return e?.proposals?.[0]?.state === 'failed' && e
    }, { show: showAsks(A2) })
    assert.deepEqual(rec.proposals, [{ kind: 'spawn', mode: 'auto', state: 'failed', risk: null, error: 'claude --bg failed' }])
    const frame = await until('the applied frame', async () => frames.find((f) => f.event === 'orchestrator' && f.data.id === 'l-fail')?.data)
    assert.deepEqual(frame.applied, [{ index: 0, ok: false, error: 'claude --bg failed' }])
    assert.equal(frame.peer, 'bravo-host'); assert.equal(frame.askId, inA.id)
  } finally {
    applyOutcome = { ok: true }
    assert.equal((await A2.local('policy', { name: 'bravo-host', trust: 'manual', autoApply: [] })).status, 200)
  }
})

/** A liaison turn on A2 that gates a prompt and then a link. */
const promptThenLink = (turnId) => (text, peer, { askId }) => {
  const actions = A2.gate({ source: 'liaison', turnId, threadId: null, peer, askId, actions: [
    { kind: 'prompt', session: 's1', text: 'go on' },
    { kind: 'link', from: 's1', to: 's2' },
  ] })
  return { ok: true, id: turnId, text: 'on it', actions, rejected: [], costUsd: 0.01, error: null }
}

await ok('agent loop: a policy changed while a turn applies stops the rest of its applies', async () => {
  applied.length = 0
  assert.equal((await A2.local('policy', { name: 'bravo-host', trust: 'sanctioned', autoApply: ['prompt', 'link'] })).status, 200)
  onApply = async () => {
    onApply = null
    assert.equal((await A2.local('policy', { name: 'bravo-host', trust: 'manual' })).status, 200)
  }
  try {
    orchA.script.push(promptThenLink('l-changed'))
    assert.equal((await B2.local('alpha/ask', { text: 'prompt then link' })).status, 200)
    const { inA } = await settledBoth('prompt then link')
    const frame = await until('the applied frame', async () => frames.find((f) => f.event === 'orchestrator' && f.data.id === 'l-changed')?.data)
    assert.deepEqual(frame.applied, [{ index: 0, ok: true, error: null }, { index: 1, ok: false, error: 'policy changed' }])
    assert.equal(applied.length, 1, 'the second apply never ran'); assert.equal(applied[0].action.kind, 'prompt')
    assert.deepEqual(A2.payload().asks.find((x) => x.id === inA.id).proposals, [
      { kind: 'prompt', mode: 'auto', state: 'applied', risk: null, error: null },
      { kind: 'link', mode: 'auto', state: 'failed', risk: null, error: 'policy changed' },
    ])
  } finally {
    onApply = null
    assert.equal((await A2.local('policy', { name: 'bravo-host', trust: 'manual', autoApply: [] })).status, 200)
  }
})

// Stops A2, so it is the last case to use it.
await ok('agent loop: an engine stopped mid-turn applies nothing more, fails what is left and broadcasts nothing', async () => {
  applied.length = 0
  assert.equal((await A2.local('policy', { name: 'bravo-host', trust: 'sanctioned', autoApply: ['prompt', 'link'] })).status, 200)
  let release = () => {}
  const held = new Promise((resolveHeld) => { release = resolveHeld })
  onApply = async () => { onApply = null; await held }
  try {
    orchA.script.push(promptThenLink('l-stopped'))
    assert.equal((await B2.local('alpha/ask', { text: 'stopped midway' })).status, 200)
    const inA = await until("A's copy to be answered with its first apply running", async () => {
      const e = askOf(A2, 'in', 'stopped midway')
      return e?.state === 'answered' && applied.length === 1 && e
    }, { show: showAsks(A2) })
    await A2.stop()
    const self = A2.payload().self
    const framesBefore = frames.length
    release()
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(applied.length, 1, 'nothing more is applied once stopped')
    assert.deepEqual(A2.payload().asks.find((x) => x.id === inA.id).proposals, [
      { kind: 'prompt', mode: 'auto', state: 'applied', risk: null, error: null },
      { kind: 'link', mode: 'auto', state: 'failed', risk: null, error: 'the relay stopped' },
    ])
    const late = frames.slice(framesBefore).filter((f) => (f.event === 'orchestrator' && f.data.id === 'l-stopped') || (f.event === 'peers' && f.data.self === self))
    assert.deepEqual(late, [], 'a stopped engine broadcasts nothing')
  } finally {
    onApply = null
    release()
    assert.equal((await A2.local('policy', { name: 'bravo-host', trust: 'manual', autoApply: [] })).status, 200)
  }
})

for (const link of [A2, B2]) await link.stop()

// ---- the local drop route ----------------------------------------------------

await ok('the local drop route: unknown/unconfirmed peers, bad and refused paths, a staged job, cancel and pin', async () => {
  const src = realpathSync(tmp())
  mkdirSync(join(src, 'sub'))
  writeFileSync(join(src, 'a.ts'), 'hello')
  writeFileSync(join(src, 'sub', 'b.ts'), 'world!')

  // A slow heartbeat: this checks the send side's local route, and a dialler
  // pulling the drop mid-check would move the job on under it.
  const QUIET = { ...ENV, SZG_PEER_HELLO_MS: '60000' }
  const C1 = makeLink({ dir: tmp(), env: QUIET, hostname: 'charlie-host', dropRoots: () => [src] })
  const delta1 = makeLink({ dir: tmp(), env: QUIET, hostname: 'delta-host' })
  await C1.start(); await delta1.start()
  await C1.local('enable', { enabled: true }); await delta1.local('enable', { enabled: true })

  assert.equal((await C1.local('nope/drop', { paths: [src] })).status, 404)

  const off = await C1.local('pair/offer', {})
  assert.equal((await delta1.local('pair/accept', { code: off.json.code, name: 'charlie' })).status, 200)

  // Paired but not yet confirmed.
  assert.equal((await C1.local('delta-host/drop', { paths: [src] })).status, 409)

  await C1.local('pair/confirm', { name: 'delta-host' })
  await delta1.local('pair/confirm', { name: 'charlie' })

  assert.equal((await C1.local('delta-host/drop', { paths: 'nope' })).status, 400)

  const refusedPath = await C1.local('delta-host/drop', { paths: [join(src, 'missing.ts')] })
  assert.equal(refusedPath.status, 400)
  assert.equal(refusedPath.json.refused.length, 1)
  assert.match(refusedPath.json.refused[0].reason, /resolve/)

  // Success answers before staging completes: the job exists on the payload
  // right away, queued, before it ever reaches filtering.
  const drop = await C1.local('delta-host/drop', { paths: [src], note: 'a note', pinned: true })
  assert.equal(drop.status, 200, JSON.stringify(drop.json))
  assert.match(drop.json.id, /^[0-9a-f]{16}$/)
  const queued = C1.payload().jobs.find((j) => j.id === drop.json.id)
  assert.ok(queued, 'the job is on the payload immediately, before staging runs')
  assert.equal(queued.state, 'queued')
  // The job has recorded where its files live; no payload row carries it.
  const shown = JSON.stringify(C1.payload())
  assert.equal(shown.includes(src), false, 'no source path is on the payload')
  assert.equal(shown.includes('"sources"'), false)

  // No filter is installed in this data dir, so the staged job passes through
  // filtering to offering, labelled rather than failed.
  const job = await until('the staged job to reach offering', async () => {
    const j = C1.payload().jobs.find((x) => x.id === drop.json.id)
    return j?.state === 'offering' ? j : null
  })
  assert.equal(job.filtered, false); assert.equal(job.filterReason, 'no filter')
  assert.equal(job.side, 'send'); assert.equal(job.peer, 'delta-host'); assert.equal(job.pinned, true)
  assert.equal(job.note, 'a note'); assert.equal(job.bytes, 11)
  assert.deepEqual(job.files.map((f) => f.path).sort(), ['a.ts', 'sub/b.ts'])
  assert.ok(job.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), 'the manifest carries the staged copy\'s hash')
  assert.equal(C1.payload().list.find((p) => p.name === 'delta-host').counts.jobsActive, 1)

  // The dry run answers what would leave, and no job outlives it.
  const jobsBefore = C1.payload().jobs.length
  assert.equal((await C1.local('filter/test', { peer: 'nope', paths: [src] })).status, 404)
  const dry = await C1.local('filter/test', { peer: 'delta-host', paths: [src] })
  assert.equal(dry.status, 200, JSON.stringify(dry.json))
  assert.deepEqual([dry.json.ok, dry.json.filtered, dry.json.filterReason], [true, false, 'no filter'])
  assert.deepEqual(dry.json.manifest.files.map((f) => f.path).sort(), ['a.ts', 'sub/b.ts'])
  assert.equal(C1.payload().jobs.length, jobsBefore, 'the dry run creates no job')

  const pin = await C1.local('job/pin', { id: drop.json.id, on: false })
  assert.equal(pin.status, 200); assert.equal(pin.json.pinned, false)
  assert.equal(C1.payload().jobs.find((j) => j.id === drop.json.id).pinned, false)

  assert.equal((await C1.local('job/cancel', { id: 'not-a-real-id' })).status, 404)
  assert.equal((await C1.local('job/cancel', { id: drop.json.id })).status, 200)
  const cancelled = C1.payload().jobs.find((j) => j.id === drop.json.id)
  assert.equal(cancelled.state, 'failed'); assert.equal(cancelled.error, 'cancelled')
  assert.equal(C1.payload().list.find((p) => p.name === 'delta-host').counts.jobsActive, 0)
  // A terminal job cannot be cancelled again.
  assert.equal((await C1.local('job/cancel', { id: drop.json.id })).status, 409)

  await C1.stop(); await delta1.stop()
})

await ok('drop refusals: a per-path refusal is dropped and the drop proceeds; a whole refusal or all-refused sends nothing', async () => {
  const root = realpathSync(tmp())
  mkdirSync(join(root, 'keep'))
  writeFileSync(join(root, 'keep', 'a.ts'), 'hello')
  const root2 = realpathSync(tmp())
  mkdirSync(join(root2, 'keep'))
  writeFileSync(join(root2, 'keep', 'a.ts'), 'world')
  const outside = realpathSync(tmp())
  writeFileSync(join(outside, 'b.ts'), 'nope')

  const QUIET = { ...ENV, SZG_PEER_HELLO_MS: '60000' }
  const E1 = makeLink({ dir: tmp(), env: QUIET, hostname: 'echo-host', dropRoots: () => [root, root2] })
  const F1 = makeLink({ dir: tmp(), env: QUIET, hostname: 'foxtrot-host' })
  await E1.start(); await F1.start()
  await E1.local('enable', { enabled: true }); await F1.local('enable', { enabled: true })
  const off = await E1.local('pair/offer', {})
  assert.equal((await F1.local('pair/accept', { code: off.json.code, name: 'echo' })).status, 200)
  await E1.local('pair/confirm', { name: 'foxtrot-host' })
  await F1.local('pair/confirm', { name: 'echo' })

  // Mixed: one path stages fine, the other is refused for itself (outside
  // every known root). The good path still goes -- the drop is not failed
  // for the other one, which is dropped and kept on the job instead.
  const mixed = await E1.local('foxtrot-host/drop', { paths: [join(root, 'keep', 'a.ts'), join(outside, 'b.ts')] })
  assert.equal(mixed.status, 200, JSON.stringify(mixed.json))
  assert.equal(mixed.json.refused.length, 1)
  assert.equal(mixed.json.refused[0].path, join(outside, 'b.ts'))
  assert.match(mixed.json.refused[0].reason, /root/)
  const mixedJob = await until('the mixed drop to record its refused path', async () => {
    const j = E1.payload().jobs.find((x) => x.id === mixed.json.id)
    return j?.files?.length ? j : null
  })
  assert.deepEqual(mixedJob.files.map((f) => f.path), ['keep/a.ts'])
  assert.equal(mixedJob.refusedCount, 1)
  assert.deepEqual(mixedJob.refusedPaths, [{ path: join(outside, 'b.ts'), reason: mixed.json.refused[0].reason }])

  // Every path refused for itself: nothing is left to send, so this is a
  // whole refusal too. 400, and no job is created.
  const beforeAll = E1.payload().jobs.length
  const allRefused = await E1.local('foxtrot-host/drop', { paths: [join(outside, 'b.ts'), join(root, 'keep', 'missing.ts')] })
  assert.equal(allRefused.status, 400)
  assert.equal(allRefused.json.refused.length, 2)
  assert.equal(E1.payload().jobs.length, beforeAll, 'no job is created when every path is refused')

  // A refusal of the WHOLE input -- here, two selections that would both
  // stage at the same relative path across two known roots -- refuses the
  // whole drop rather than sending the one that "won": no job, no partial
  // send, and the response never lists it as a per-path refusal to drop and
  // retry.
  const beforeCollision = E1.payload().jobs.length
  const collision = await E1.local('foxtrot-host/drop', { paths: [join(root, 'keep', 'a.ts'), join(root2, 'keep', 'a.ts')] })
  assert.equal(collision.status, 400)
  assert.equal(collision.json.refused.length, 1)
  assert.match(collision.json.refused[0].reason, /keep\/a\.ts/)
  assert.equal(E1.payload().jobs.length, beforeCollision, 'a whole refusal creates no job')

  await E1.stop(); await F1.stop()
})

// ---- two real relays --------------------------------------------------------
// The peer listener and the loopback relay are two servers in one process, and
// the only proof that they stay apart is to ask each of them for the other's
// routes. So these are real relay subprocesses: OS-assigned ports, a data dir
// each, and a fake `claude`. Every one is stopped through the `child` it was
// started as, never by a pattern, and in a `finally`, so a failed check leaves
// no relay behind.

const fakeDir = tmp()
// One JSON array per `claude -p` invocation, one line each.
const argvFile = join(fakeDir, 'argv.ndjson')
// While this file exists, a `claude -p` turn takes three seconds.
const slowFile = join(fakeDir, 'slow')
const fakeClaudeJs = join(fakeDir, 'fake-claude.mjs')
const FAKE_REPLY = 'Answered from the board.\n\n```json\n{"actions": [{"kind": "link", "from": "x", "to": "y"}]}\n```'
const NL = String.fromCharCode(10)
// While this file exists, a `claude -p` turn proposes handing a file back.
const dropReplyFile = join(fakeDir, 'drop-reply')
const handback = realpathSync(tmp())
writeFileSync(join(handback, 'notes.md'), 'handed back')
const HANDBACK_PATHS = [join(handback, 'notes.md')]
const DROP_REPLY = ['Here are the notes.', '', '```json', JSON.stringify({ actions: [{ kind: 'drop', paths: HANDBACK_PATHS, note: 'the notes' }] }), '```'].join(NL)
// While one of these exists, a local turn (the orchestrator's own preamble) or a
// liaison turn answers with its contents instead of the canned reply.
const replyLocalFile = join(fakeDir, 'reply-local')
const replyLiaisonFile = join(fakeDir, 'reply-liaison')
const fenced = (prose, actions) => [prose, '', '```json', JSON.stringify({ actions }), '```'].join(NL)
writeFileSync(fakeClaudeJs, [
  "import { appendFileSync, existsSync, readFileSync } from 'node:fs'",
  `appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
  `if (existsSync(${JSON.stringify(slowFile)})) await new Promise((r) => setTimeout(r, 3000))`,
  'const argv = process.argv.slice(2)',
  "const pre = String(argv[argv.indexOf('--append-system-prompt') + 1] ?? '')",
  `const scripted = pre.startsWith("You are Syzygy's liaison.") ? ${JSON.stringify(replyLiaisonFile)} : pre.startsWith('You are Syzygy, an orchestrator') ? ${JSON.stringify(replyLocalFile)} : null`,
  `const REPLY = scripted && existsSync(scripted) ? readFileSync(scripted, 'utf8') : existsSync(${JSON.stringify(dropReplyFile)}) ? ${JSON.stringify(DROP_REPLY)} : ${JSON.stringify(FAKE_REPLY)}`,
  'const lines = [',
  "  { type: 'system', subtype: 'init', session_id: '00000000-0000-4000-8000-00000000000a' },",
  "  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },",
  "  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY } } },",
  "  { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: REPLY },",
  ']',
  "for (const line of lines) process.stdout.write(JSON.stringify(line) + '\\n')",
  '',
].join('\n'))
const fakeBin = join(fakeDir, 'claude')
writeFileSync(fakeBin, [
  '#!/bin/sh',
  // The relay picks its `claude` by what --help advertises, so the fake answers
  // the way a capable one does.
  'if [ "$1" = "--help" ]; then echo "  --bg   run in the background"; echo "  attach   attach to a session"; echo "  --safe-mode"; exit 0; fi',
  'if [ "$1" = "--version" ]; then echo "0.0.0-fake (peer link harness)"; exit 0; fi',
  'if [ "$1" = "agents" ]; then echo "[]"; exit 0; fi',
  'for a in "$@"; do if [ "$a" = "--bg" ]; then echo "backgrounded · ab12cd34 · probe"; exit 0; fi; done',
  `if [ "$1" = "-p" ]; then exec "${process.execPath}" "${fakeClaudeJs}" "$@"; fi`,
  'exit 0',
  '',
].join('\n'))
chmodSync(fakeBin, 0o755)

const RELAY = join(ROOT, 'syzygy', 'bridge', 'relay.mjs')
const spawned = []
const running = new Set()

const startRelay = async ({ dataDir, token, extraEnv = {} }) => {
  const child = spawn(process.execPath, [RELAY], {
    cwd: ROOT,
    env: {
      ...process.env, SZG_PORT: '0', SZG_TOKEN: token, SZG_DATA_DIR: dataDir, SZG_CLAUDE_BIN: fakeBin,
      SZG_TMUX_BIN: '/usr/bin/false', SZG_PANE_PASSWORD_DISABLED: '1',
      SZG_PEER_BIND: '127.0.0.1', SZG_PEER_PORT: '0', SZG_PEER_HELLO_MS: '300',
      SZG_PEER_ASK_RETRY_MS: '500,1000,4000', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  spawned.push(child)
  let stderrText = ''
  child.stderr.on('data', (c) => { stderrText += c })
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))

  const stop = async (signal = 'SIGTERM') => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal)
      // A relay that ignores SIGTERM would hang the harness; this is still
      // the same child, never a search for one.
      const hard = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 5000)
      await exited
      clearTimeout(hard)
    }
    running.delete(handle)
  }
  const handle = { stop }
  running.add(handle)

  let port
  try {
    port = await new Promise((resolvePort, reject) => {
      let out = ''
      let found = false
      const timer = setTimeout(() => reject(new Error(`relay did not report a port in time; stderr: ${stderrText}`)), 8000)
      // Drained for the relay's whole life, so a full pipe can never block it.
      child.stdout.on('data', (chunk) => {
        if (found) return
        out += chunk
        const m = out.match(/relay on http:\/\/127\.0\.0\.1:(\d+)/)
        if (m) { found = true; clearTimeout(timer); resolvePort(Number(m[1])) }
      })
      child.once('error', (e) => { clearTimeout(timer); reject(e) })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`relay exited early with code ${code}; stderr: ${stderrText}`)) })
    })
  } catch (e) {
    await stop('SIGKILL')
    throw e
  }

  const base = `http://127.0.0.1:${port}`
  const get = async (path, init = {}) => {
    const r = await fetch(base + path, init)
    return { status: r.status, text: await r.text() }
  }
  const post = async (path, body = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ...body }) })
    const text = await r.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: r.status, json: parsed }
  }
  const state = async () => {
    const r = await get('/api/state')
    assert.equal(r.status, 200, `GET /api/state: ${r.text}`)
    return JSON.parse(r.text)
  }
  return Object.assign(handle, { port, child, dataDir, token, stderr: () => stderrText, get, post, state })
}

const peerIn =async (relay, name) => (await relay.state()).peers.list.find((p) => p.name === name) ?? null
const healthIn = async (relay, name) => (await peerIn(relay, name))?.health ?? null
const showHealth = (relay, name) => async () => JSON.stringify(await healthIn(relay, name))

// Every key the loopback snapshot carried before peering existed.
const SNAPSHOT_KEYS = ['t', 'sessions', 'events', 'questions', 'approvals', 'links', 'projects', 'canvas', 'dispatch',
  'dispatchOptions', 'usage', 'usageHistory', 'afterReset', 'steering', 'voice', 'hud', 'orchestrator', 'viewers', 'auth']

const TOKEN_A = 'peer-link-harness-token-a'
const TOKEN_B = 'peer-link-harness-token-b'
const TOKEN_C = 'peer-link-harness-token-c'
const dataA = tmp()
const dataB = tmp()
const dataC = tmp()
let RA = null
let RB = null
let nameOfB = null

try {
  RA = await startRelay({ dataDir: dataA, token: TOKEN_A })
  RB = await startRelay({ dataDir: dataB, token: TOKEN_B })

  await ok('relays: peering is off by default and mints no certificate', async () => {
    for (const [relay, dir] of [[RA, dataA], [RB, dataB]]) {
      const { peers } = await relay.state()
      assert.ok(peers, 'the snapshot carries peers')
      assert.equal(peers.enabled, false); assert.equal(peers.listening, false)
      assert.equal(existsSync(join(dir, S.CERT_FILE)), false)
    }
  })

  await ok('relays: enabling over the loopback control route binds a peer listener, and needs the token', async () => {
    const r = await fetch(`http://127.0.0.1:${RA.port}/api/peer/enable`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, bind: '127.0.0.1' }),
    })
    assert.equal(r.status, 401); await r.text()
    assert.equal((await RA.state()).peers.listening, false, 'a refused enable binds nothing')

    for (const [relay, self] of [[RA, 'alpha-host'], [RB, 'bravo-host']]) {
      const out = await relay.post('/api/peer/enable', { enabled: true, bind: '127.0.0.1', self })
      assert.equal(out.status, 200, JSON.stringify(out.json)); assert.equal(out.json.ok, true)
      const { peers } = await relay.state()
      assert.equal(peers.enabled, true); assert.equal(peers.listening, true, JSON.stringify(peers.error))
      assert.ok(Number.isInteger(peers.port) && peers.port > 0); assert.ok(P.fpBytes(peers.fingerprint))
      assert.equal(peers.self, self)
    }
  })

  await ok('relays: the certificate survives a restart unchanged, and the listener comes back without a request', async () => {
    const before = (await RA.state()).peers
    const certFile = join(dataA, S.CERT_FILE)
    const mtime = statSync(certFile).mtimeMs
    await RA.stop()
    RA = await startRelay({ dataDir: dataA, token: TOKEN_A })
    const after = await until('A to listen again after its restart', async () => {
      const { peers } = await RA.state()
      return peers.listening && peers
    }, { show: async () => JSON.stringify((await RA.state()).peers) })
    assert.equal(after.enabled, true); assert.equal(after.error, null)
    assert.equal(after.fingerprint, before.fingerprint)
    assert.equal(statSync(certFile).mtimeMs, mtime, 'the certificate is not minted again')
  })

  await ok('relays: the peer listener serves none of the relay, and the relay none of the peer listener', async () => {
    const peerPort = (await RA.state()).peers.port
    const tokenBody = JSON.stringify({ token: TOKEN_A })
    const offTable = [
      ['GET', '/api/state'], ['POST', '/api/state'], ['GET', '/'], ['GET', '/app.js'], ['GET', '/api/stream'],
      ['GET', '/api/health'], ['GET', '/peer/hello'],
    ]
    for (const [m, p] of offTable) {
      const r = await probe(peerPort, m, p)
      assert.equal(r.status, 404, `peer listener ${m} ${p}`); assert.equal(r.text, '', `peer listener ${m} ${p} has an empty body`)
    }
    // Holding the loopback token changes nothing on the peer listener.
    for (const p of ['/api/state', '/api/peer/pair/offer', '/api/peer/enable']) {
      const r = await probe(peerPort, 'POST', p, { body: tokenBody, headers: { 'content-type': 'application/json' } })
      assert.equal(r.status, 404, `peer listener POST ${p} with the token`); assert.equal(r.text, '')
    }
    assert.equal((await RA.state()).peers.pairing, null, 'no code was offered through the peer listener')

    const helloBody = JSON.stringify({ roster: [], jobDeltas: [], ackedTo: 0, now: Date.now() })
    const forged = P.signRequest({ secret: randomBytes(32), self: 'bravo-host', method: 'POST', path: '/peer/hello', body: helloBody })
    const refused = await probe(peerPort, 'POST', '/peer/hello', { body: helloBody, headers: { 'content-type': 'application/json', ...forged.headers } })
    assert.equal(refused.status, 404, 'a hello signed by a secret nobody holds'); assert.equal(refused.text, '')

    // Plain HTTP on the loopback relay: the peer routes do not exist there.
    assert.equal((await RA.get('/peer/hello')).status, 404, 'loopback GET /peer/hello')
    const loopHello = await RA.get('/peer/hello', { method: 'POST', headers: { 'content-type': 'application/json', ...forged.headers }, body: helloBody })
    assert.equal(loopHello.status, 404, 'loopback POST /peer/hello')
    for (const p of DROP_PATHS) {
      const dropBody = JSON.stringify({ token: TOKEN_A, dropId: 'ab'.repeat(8) })
      const onPeer = P.signRequest({ secret: randomBytes(32), self: 'bravo-host', method: 'POST', path: p, body: dropBody })
      const peerSide = await probe(peerPort, 'POST', p, { body: dropBody, headers: { 'content-type': 'application/json', ...onPeer.headers } })
      assert.equal(peerSide.status, 404, `peer listener forged ${p}`); assert.equal(peerSide.text, '')
      assert.equal((await RA.get(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: dropBody })).status, 404, `loopback POST ${p}`)
      assert.equal((await RA.get(p)).status, 404, `loopback GET ${p}`)
    }

    const open = await RA.get('/api/state')
    assert.equal(open.status, 200)
    const keys = Object.keys(JSON.parse(open.text))
    for (const k of [...SNAPSHOT_KEYS, 'peers']) assert.ok(keys.includes(k), `the loopback snapshot still carries ${k}`)

    // With the pane password left on, the gate answers exactly as it did
    // before peering existed.
    const RC = await startRelay({ dataDir: dataC, token: TOKEN_C, extraEnv: { SZG_PANE_PASSWORD_DISABLED: undefined } })
    try {
      const gated = await RC.get('/api/state')
      assert.equal(gated.status, 401); assert.equal(gated.text, '{"error":"auth required"}')
      assert.equal((await RC.get('/api/health')).status, 200)
      const withToken = await RC.get(`/api/state?token=${TOKEN_C}`)
      assert.equal(withToken.status, 200)
      assert.equal(JSON.parse(withToken.text).peers.listening, false)
      assert.equal(existsSync(join(dataC, S.CERT_FILE)), false)
    } finally {
      await RC.stop()
    }
  })

  await ok('relays: pairing over the loopback control routes; the code and the secret stay off the snapshot', async () => {
    const offer = await RA.post('/api/peer/pair/offer', {})
    assert.equal(offer.status, 200, JSON.stringify(offer.json))
    const code = offer.json.code
    const codeToken = code.split('.')[2]
    assert.ok(codeToken.length > 20)
    assert.equal((await RA.get('/api/state')).text.includes(codeToken), false)

    const accepted = await RB.post('/api/peer/pair/accept', { code, name: 'alpha' })
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json))

    const storedA = readJson(join(dataA, S.PEERS_FILE)).peers
    const storedB = readJson(join(dataB, S.PEERS_FILE)).peers
    assert.equal(storedA.length, 1); assert.equal(storedB.length, 1)
    assert.match(storedA[0].secret, /^[0-9a-f]{64}$/); assert.equal(storedA[0].secret, storedB[0].secret)

    const pa = (await RA.state()).peers
    const pb = (await RB.state()).peers
    assert.equal(pa.list.length, 1); assert.equal(pb.list.length, 1)
    assert.equal(pa.list[0].fingerprint, pb.fingerprint); assert.equal(pb.list[0].fingerprint, pa.fingerprint)
    assert.equal(pb.list[0].name, 'alpha'); assert.equal(pb.list[0].dials, true); assert.equal(pa.list[0].dials, false)
    nameOfB = pa.list[0].name
    assert.equal(nameOfB, 'bravo-host')

    assert.equal((await RA.post('/api/peer/pair/confirm', { name: nameOfB })).status, 200)
    assert.equal((await RB.post('/api/peer/pair/confirm', { name: 'alpha' })).status, 200)
    assert.equal(typeof (await peerIn(RA, nameOfB)).confirmedAt, 'number')
    assert.equal(typeof (await peerIn(RB, 'alpha')).confirmedAt, 'number')

    for (const relay of [RA, RB]) {
      const text = (await relay.get('/api/state')).text
      assert.equal(text.includes(storedA[0].secret), false); assert.equal(text.includes(codeToken), false)
      assert.equal(text.includes('BEGIN CERTIFICATE'), false); assert.equal(text.includes('"address"'), false)
    }
  })

  await ok('relays: health comes up both ways; the dialled side sees the dialler go down and come back', async () => {
    await until("B's view of alpha to be up", async () => (await healthIn(RB, 'alpha'))?.state === 'up', { show: showHealth(RB, 'alpha') })
    await until("A's view of B to be up", async () => (await healthIn(RA, nameOfB))?.state === 'up', { show: showHealth(RA, nameOfB) })
    await RB.stop()
    await until("A's view of B to go down", async () => (await healthIn(RA, nameOfB))?.state === 'down', { show: showHealth(RA, nameOfB) })
    // B dials A, and A kept its peer port, so B comes back on any port.
    RB = await startRelay({ dataDir: dataB, token: TOKEN_B })
    await until("B's view of alpha to be up after B's restart", async () => (await healthIn(RB, 'alpha'))?.state === 'up', { show: showHealth(RB, 'alpha') })
    await until("A's view of B to be up again", async () => (await healthIn(RA, nameOfB))?.state === 'up', { show: showHealth(RA, nameOfB) })
  })

  await ok('relays: forget is revocation -- the dialler reads refused (404)', async () => {
    assert.equal((await RA.post('/api/peer/forget', { name: nameOfB })).status, 200)
    assert.deepEqual((await RA.state()).peers.list, [])
    const h = await until("B's view of alpha to be refused", async () => {
      const got = await healthIn(RB, 'alpha')
      return got?.state === 'down' && got.error === 'refused (404)' && got
    }, { show: showHealth(RB, 'alpha') })
    assert.equal(h.error, 'refused (404)')
    await until("A's stderr to name the refused signature", async () => RA.stderr().includes('signature did not verify'), {
      show: async () => RA.stderr().slice(-2000),
    })
  })

  await ok('relays: paired and confirmed again, up both ways', async () => {
    assert.equal((await RB.post('/api/peer/forget', { name: 'alpha' })).status, 200)
    const offer = await RA.post('/api/peer/pair/offer', {})
    assert.equal(offer.status, 200, JSON.stringify(offer.json))
    const accepted = await RB.post('/api/peer/pair/accept', { code: offer.json.code, name: 'alpha' })
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json))
    nameOfB = (await RA.state()).peers.list[0].name
    assert.equal(nameOfB, 'bravo-host')
    assert.equal((await RA.post('/api/peer/pair/confirm', { name: nameOfB })).status, 200)
    assert.equal((await RB.post('/api/peer/pair/confirm', { name: 'alpha' })).status, 200)
    await until("B's view of alpha to be up", async () => (await healthIn(RB, 'alpha'))?.state === 'up', { show: showHealth(RB, 'alpha') })
    await until("A's view of B to be up", async () => (await healthIn(RA, nameOfB))?.state === 'up', { show: showHealth(RA, nameOfB) })
  })

  const askIn = async (relay, dir, text) => (await relay.state()).peers.asks.find((e) => e.dir === dir && e.text === text) ?? null
  const showRelayAsks = (relay) => async () => JSON.stringify((await relay.state()).peers.asks)
  const settledIn = (relay, dir, text, { state = 'answered', timeoutMs = 5000 } = {}) =>
    until(`${dir} copy of ${JSON.stringify(text)} to be ${state}`, async () => {
      const e = await askIn(relay, dir, text)
      return e?.state === state && e
    }, { timeoutMs, show: showRelayAsks(relay) })
  const argvLines = () => readFileSync(argvFile, 'utf8').trim().split(NL).map((l) => JSON.parse(l))
  const liaisonArgvFor = (question) => argvLines().reverse().find((a) => String(a.at(-1)).includes(question))
  const idle = (relay) => until('the orchestrator to be idle', async () => !(await relay.state()).orchestrator.busy, { timeoutMs: 10_000 })

  await ok("relays: A asks B's liaison; the reply comes back with a count of actions, and B's stream carries the turn", async () => {
    const work = tmp()
    assert.equal((await RB.post('/api/register', { session: { id: 'b-sess-1', name: 'bravo-only-session', cwd: work, root: work } })).status, 200)
    assert.equal((await RA.post('/api/register', { session: { id: 'a-sess-1', name: 'alpha-only-session', cwd: work, root: work } })).status, 200)

    const aborter = new AbortController()
    const stream = await fetch(`http://127.0.0.1:${RB.port}/api/stream`, { signal: aborter.signal })
    assert.equal(stream.status, 200)
    let streamText = ''
    const decoder = new TextDecoder()
    const reading = (async () => {
      try { for await (const chunk of stream.body) streamText += decoder.decode(chunk, { stream: true }) } catch {}
    })()
    try {
      const question = 'what is on your board?'
      const r = await RA.post(`/api/peer/${nameOfB}/ask`, { text: question })
      assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.state, 'queued')
      const out = await settledIn(RA, 'out', question)
      assert.equal(out.reply, 'Answered from the board.'); assert.equal(out.actionsProposed, 1)
      for (const e of (await RA.state()).peers.asks) assert.equal(Object.hasOwn(e, 'actions'), false)

      const argv = readFileSync(argvFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).at(-1)
      const at = argv.indexOf('--append-system-prompt')
      assert.ok(at >= 0 && String(argv[at + 1]).startsWith("You are Syzygy's liaison."), JSON.stringify(argv.slice(0, -1)))
      assert.equal(argv.includes('--resume'), false)
      assert.ok(argv.at(-1).includes('bravo-only-session'), 'the turn reads B\'s own board')
      assert.equal(argv.at(-1).includes('alpha-only-session'), false)

      const frame = await until("the liaison's final frame on B's stream", async () => streamText.split('\n\n')
        .filter((block) => block.startsWith('event: orchestrator\n'))
        .map((block) => JSON.parse(block.slice(block.indexOf('data: ') + 'data: '.length)))
        .find((d) => d.done === true && d.peer === 'alpha' && d.question === question), { show: async () => streamText.slice(-2000) })
      assert.equal(frame.actions.length, 1)
    } finally {
      aborter.abort()
      await reading
    }
  })

  await ok('relays: B asks A directly', async () => {
    const question = 'and what is on yours?'
    const r = await RB.post('/api/peer/alpha/ask', { text: question })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    const out = await settledIn(RB, 'out', question)
    assert.equal(out.reply, 'Answered from the board.'); assert.equal(out.actionsProposed, 1)
    assert.equal((await askIn(RA, 'in', question)).state, 'answered')
  })

  await ok("relays: an ask that finds B's model slot taken is queued and retried, not failed", async () => {
    writeFileSync(slowFile, '')
    let localAsk = null
    try {
      localAsk = RB.post('/api/orchestrator/ask', { text: 'local work' })
      await until("B's orchestrator to be busy", async () => (await RB.state()).orchestrator.busy)
      const question = 'are you free yet?'
      assert.equal((await RA.post(`/api/peer/${nameOfB}/ask`, { text: question })).status, 200)
      let sawQueued = false
      await until("B's copy to be answered", async () => {
        const e = await askIn(RB, 'in', question)
        if (e?.state === 'queued') sawQueued = true
        return e?.state === 'answered'
      }, { timeoutMs: 12_000, show: showRelayAsks(RB) })
      assert.ok(sawQueued, "B's copy waited in queued")
      await settledIn(RA, 'out', question, { timeoutMs: 12_000 })
      assert.equal((await localAsk).status, 200)
    } finally {
      rmSync(slowFile, { force: true })
      await localAsk?.catch(() => {})
    }
  })

  await ok('relays: an ask over the cap is held, sends nothing back, and a release answers it', async () => {
    assert.equal((await RB.post('/api/peer/policy', { name: 'alpha', asksPerHour: 0, peerAskDailyCapUsd: 2 })).status, 200)
    const question = 'over your cap?'
    assert.equal((await RA.post(`/api/peer/${nameOfB}/ask`, { text: question })).status, 200)
    const held = await settledIn(RB, 'in', question, { state: 'held' })
    assert.equal(held.error, 'asks per hour cap reached')
    await settledIn(RA, 'out', question, { state: 'sent' })
    await new Promise((r) => setTimeout(r, 1000))
    assert.equal((await askIn(RA, 'out', question)).state, 'sent', 'a held ask sends nothing back')
    const released = await RB.post('/api/peer/ask/answer', { id: held.id })
    assert.equal(released.status, 200, JSON.stringify(released.json)); assert.deepEqual(released.json, { ok: true })
    await settledIn(RB, 'in', question)
    await settledIn(RA, 'out', question)
    assert.equal((await RB.post('/api/peer/policy', { name: 'alpha', asksPerHour: 20, peerAskDailyCapUsd: 2 })).status, 200)
  })

  await ok("relays: A's ask log survives a restart", async () => {
    const before = (await RA.state()).peers
    const answered = before.asks.filter((e) => e.state === 'answered').map((e) => e.id)
    assert.ok(answered.length >= 4, JSON.stringify(before.asks))
    await RA.stop()
    RA = await startRelay({ dataDir: dataA, token: TOKEN_A, extraEnv: { SZG_PEER_PORT: String(before.port) } })
    const after = await until('A to listen again after its restart', async () => {
      const { peers } = await RA.state()
      return peers.listening && peers
    }, { show: async () => JSON.stringify((await RA.state()).peers) })
    for (const id of answered) assert.equal(after.asks.find((e) => e.id === id)?.state, 'answered', id)
    await until("B's view of alpha to be up after A's restart", async () => (await healthIn(RB, 'alpha'))?.state === 'up', { show: showHealth(RB, 'alpha') })
  })

  // From here the two relays are paired and confirmed: B holds A's address
  // under the name `alpha` and dials it; A knows B as `nameOfB`. So B pushes
  // what it sends, and pulls what A sends.

  const jobsIn = async (relay) => (await relay.state()).peers.jobs
  const jobIn = async (relay, pred) => (await jobsIn(relay)).find(pred) ?? null
  const showJobs = (relay) => async () => JSON.stringify((await jobsIn(relay))
    .map(({ id, dropId, side, state, sent, bytes, reason, error, remote }) => ({ id, dropId, side, state, sent, bytes, reason, error, remote })))
  const jobState = (relay, pred, state, { timeoutMs = 30_000 } = {}) =>
    until(`a ${state} job`, async () => {
      const j = await jobIn(relay, pred)
      return j?.state === state && j
    }, { timeoutMs, show: showJobs(relay) })
  const lengthOf = (file) => (existsSync(file) ? statSync(file).size : 0)
  const quarantined = (dataDir, peer, dropId, idx) => join(dataDir, 'peer-quarantine', peer, dropId, 'files', String(idx))
  /** A job as its relay last flushed it, read off disk. The drop route
   *  flushes before it answers, so this asks nothing of a relay that may be
   *  too busy serving a transfer to answer its state in time. */
  const flushedJob = (dataDir, id) => JSON.parse(readFileSync(join(dataDir, 'peer-jobs.json'), 'utf8')).items.find((j) => j.id === id) ?? null
  const makeSource = (label, bigBytes) => {
    const root = realpathSync(tmp())
    mkdirSync(join(root, 'dir'))
    const files = { 'a.txt': Buffer.from(`alpha from ${label}`), 'dir/b.json': Buffer.from(JSON.stringify({ label })), 'big.bin': randomBytes(bigBytes) }
    for (const [p, bytes] of Object.entries(files)) writeFileSync(join(root, p), bytes)
    return { root, files }
  }
  /** A session rooted at `root`, so a drop may name the files under it. */
  const register = async (relay, id, root) => {
    const r = await relay.post('/api/register', { session: { id, name: id, cwd: root, root } })
    assert.equal(r.status, 200, JSON.stringify(r.json))
  }
  /** Every landed file in the receiver's inbox, by its path, is its source
   *  byte for byte, the row names that inbox, and no quarantine is left. */
  const assertLanded = async (dataDir, peer, job, src) => {
    assert.equal(job.landed.length, 3)
    assert.equal(job.inboxPath, join(dataDir, 'peer-inbox', peer, job.dropId))
    for (const row of job.landed) {
      const want = P.sha256hex(src.files[row.path])
      assert.equal(row.sha256, want, row.path)
      assert.equal(P.sha256hex(readFileSync(join(job.inboxPath, row.path))), want, `${row.path} in the inbox`)
    }
    await until("the landed drop's quarantine to be removed", () => !existsSync(join(dataDir, 'peer-quarantine', peer, job.dropId)))
  }

  // A liaison's proposed drop is a button on the answering board and nothing
  // more: the proposal crosses as a count, and a job exists only once the local
  // route is posted -- the same route, and the same body, the button posts.
  let handbackAskId = null
  await ok("relays: B's liaison proposes a drop -- A learns only the count, and no job exists on either side until B posts the route", async () => {
    await register(RB, 'b-handback', handback)
    const aborter = new AbortController()
    const stream = await fetch(`http://127.0.0.1:${RB.port}/api/stream`, { signal: aborter.signal })
    assert.equal(stream.status, 200)
    let streamText = ''
    const decoder = new TextDecoder()
    const reading = (async () => {
      try { for await (const chunk of stream.body) streamText += decoder.decode(chunk, { stream: true }) } catch {}
    })()
    writeFileSync(dropReplyFile, '')
    try {
      const question = 'can you send the notes back?'
      assert.equal((await RA.post(`/api/peer/${nameOfB}/ask`, { text: question })).status, 200)
      const out = await settledIn(RA, 'out', question)
      assert.equal(out.actionsProposed, 1)
      assert.equal(out.reply, 'Here are the notes.')
      assert.equal(out.reply.includes('"kind"'), false)
      assert.equal(Object.hasOwn(out, 'actions'), false)
      // B's roster carries the session's root by design, so the check is for
      // the proposed file itself and for the action, never the directory.
      const seenByA = (await RA.get('/api/state')).text
      assert.equal(seenByA.includes(HANDBACK_PATHS[0]), false, 'no proposed path reaches the asking relay')
      assert.equal(seenByA.includes('"kind":"drop"'), false, 'no proposed action reaches the asking relay')

      const inB = await settledIn(RB, 'in', question)
      assert.equal(inB.actionsProposed, 1)
      handbackAskId = inB.id

      const frame = await until("the liaison's final frame on B's stream", async () => streamText.split(NL + NL)
        .filter((block) => block.startsWith('event: orchestrator' + NL))
        .map((block) => JSON.parse(block.slice(block.indexOf('data: ') + 'data: '.length)))
        .find((d) => d.done === true && d.peer === 'alpha' && d.question === question), { show: async () => streamText.slice(-2000) })
      assert.equal(frame.askId, inB.id)
      // Under manual the gate leaves the drop a button for the person on B.
      assert.deepEqual(frame.actions, [{ kind: 'drop', paths: HANDBACK_PATHS, note: 'the notes', gate: 'button' }])

      // A few hello cycles, so a job either side had made would show.
      await new Promise((r) => setTimeout(r, 1000))
      assert.deepEqual(await jobsIn(RB), [], 'a proposal alone makes no job on the answering side')
      assert.deepEqual(await jobsIn(RA), [], 'a proposal alone makes no job on the asking side')

      const [action] = frame.actions
      const r = await RB.post('/api/peer/alpha/drop', { paths: action.paths, note: action.note || '' })
      assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.refused ?? [], [])
      const sent = await jobState(RB, (j) => j.id === r.json.id, 'sent')
      const recv = await jobState(RA, (j) => j.side === 'recv' && j.dropId === sent.dropId, 'landed')
      assert.equal(recv.note, 'the notes')
    } finally {
      rmSync(dropReplyFile, { force: true })
      aborter.abort()
      await reading
    }
  })

  await ok("relays: a prompt applied for B's incoming ask tags the session it lands on with the asking peer, and a re-registration keeps the tag", async () => {
    assert.ok(handbackAskId, 'the drop case recorded an incoming ask')
    const root = realpathSync(tmp())
    await register(RB, 'b-for-peer', root)
    const r = await RB.post('/api/command', { targetId: 'b-for-peer', verb: 'prompt', payload: { text: 'x' }, forAsk: handbackAskId })
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.n, 1)
    const sessionIn = async (id) => (await RB.state()).sessions.find((s) => s.id === id)
    assert.deepEqual((await sessionIn('b-for-peer')).forPeer, { peer: 'alpha', askId: handbackAskId })
    await register(RB, 'b-for-peer', root)
    assert.deepEqual((await sessionIn('b-for-peer')).forPeer, { peer: 'alpha', askId: handbackAskId }, 'a re-registration carrying no tag keeps the one the record has')
  })

  await ok('relays: a forAsk naming an outgoing ask, or no ask at all, applies the prompt with no tag', async () => {
    const outgoing = (await RB.state()).peers.asks.find((e) => e.dir === 'out')
    assert.ok(outgoing, JSON.stringify((await RB.state()).peers.asks))
    const root = realpathSync(tmp())
    const untagged = async (id) => {
      const s = (await RB.state()).sessions.find((x) => x.id === id)
      assert.ok(s, id)
      return !Object.hasOwn(s, 'forPeer')
    }
    for (const [id, forAsk] of [['b-untagged-out', outgoing.id], ['b-untagged-unknown', 'ab'.repeat(16)]]) {
      await register(RB, id, root)
      const r = await RB.post('/api/command', { targetId: id, verb: 'prompt', payload: { text: 'x' }, forAsk })
      assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.n, 1)
      assert.ok(await untagged(id), id)
    }
    assert.ok(RB.stderr().includes('forAsk names no incoming ask; applied untagged'))
    const forged = await RB.post('/api/register', { session: { id: 'b-untagged-forged', name: 'b-untagged-forged', cwd: root, root, forPeer: { peer: 'alpha', askId: handbackAskId } } })
    assert.equal(forged.status, 200, JSON.stringify(forged.json))
    assert.ok(await untagged('b-untagged-forged'), 'a tag is never taken from a registering session')
  })

  await ok("relays: B dials, so B pushes -- three files, one larger than a chunk, each landed in A's inbox with its checksum; B's job is sent, and copy-into puts them in a worktree", async () => {
    const src = makeSource('bravo', 1024 * 1024 + 300 * 1024)
    await register(RB, 'b-drop-push', src.root)
    const r = await RB.post('/api/peer/alpha/drop', { paths: [src.root], note: 'pushed' })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    const sent = await jobState(RB, (j) => j.id === r.json.id, 'sent')
    const recv = await jobState(RA, (j) => j.side === 'recv' && j.dropId === sent.dropId, 'landed')
    assert.deepEqual([recv.peer, recv.bytes, recv.sent, recv.note], [nameOfB, sent.bytes, sent.bytes, 'pushed'])
    await assertLanded(dataA, nameOfB, recv, src)
    // The staged copy goes once the end is on disk, after the row says sent.
    await until('a sent drop to keep no staged copy', () => !existsSync(join(dataB, 'peer-staging', sent.dropId)), { show: showJobs(RB) })
    const told = await until("B's row to show A's state", async () => {
      const j = await jobIn(RB, (x) => x.id === sent.id)
      return j?.remote?.state === 'landed' && j
    }, { show: showJobs(RB) })
    assert.equal(typeof told.remote.at, 'number')

    const work = realpathSync(tmp())
    await register(RA, 'a-copy-dest', work)
    const copied = await RA.post('/api/peer/job/copy', { id: recv.id, dest: work })
    assert.equal(copied.status, 200, JSON.stringify(copied.json))
    assert.deepEqual([...copied.json.copied].sort(), ['a.txt', 'big.bin', 'dir/b.json'])
    for (const p of copied.json.copied) assert.equal(P.sha256hex(readFileSync(join(work, p))), P.sha256hex(src.files[p]), p)
    assert.equal((await RA.post('/api/peer/job/copy', { id: recv.id, dest: realpathSync(tmp()) })).status, 400, 'a destination outside every known root')
    assert.equal((await RA.post('/api/peer/job/copy', { id: recv.id, dest: work })).json.skipped.length, 3, 'a second copy overwrites nothing')
  })

  await ok("relays: A cannot dial, so B pulls -- A's drop waits to be pulled, B verifies and lands it, and A's job is sent", async () => {
    const src = makeSource('alpha', 1024 * 1024 + 200 * 1024)
    await register(RA, 'a-drop-pull', src.root)
    const r = await RA.post(`/api/peer/${nameOfB}/drop`, { paths: [src.root] })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    const dropId = (await jobIn(RA, (j) => j.id === r.json.id)).dropId
    const recv = await jobState(RB, (j) => j.side === 'recv' && j.dropId === dropId, 'landed')
    assert.equal(recv.peer, 'alpha')
    await assertLanded(dataB, 'alpha', recv, src)
    await jobState(RA, (j) => j.id === r.json.id, 'sent')
    await until("A's row to show B's landing", async () => (await jobIn(RA, (j) => j.id === r.json.id))?.remote?.state === 'landed', { show: showJobs(RA) })
    // The heartbeat that moves A's row to sent removes the staged copy after it.
    await until("A's staged copy to be removed", () => !existsSync(join(dataA, 'peer-staging', dropId)), { show: showJobs(RA) })
  })

  // A smaller chunk from here on, on both relays, so a transfer lasts long
  // enough to be interrupted.
  const SLOW = { SZG_PEER_CHUNK_BYTES: '16384' }
  const BIG = 6 * 1024 * 1024
  const portOfA = (await RA.state()).peers.port
  const upBothWays = async () => {
    await until("B's view of alpha to be up", async () => (await healthIn(RB, 'alpha'))?.state === 'up', { timeoutMs: 10_000, show: showHealth(RB, 'alpha') })
    await until("A's view of B to be up", async () => (await healthIn(RA, nameOfB))?.state === 'up', { timeoutMs: 10_000, show: showHealth(RA, nameOfB) })
  }

  await ok('relays: both restart with a smaller chunk and come back up', async () => {
    await RB.stop()
    await RA.stop()
    RA = await startRelay({ dataDir: dataA, token: TOKEN_A, extraEnv: { ...SLOW, SZG_PEER_PORT: String(portOfA) } })
    RB = await startRelay({ dataDir: dataB, token: TOKEN_B, extraEnv: SLOW })
    await upBothWays()
  })

  await ok("relays: the receiver killed mid-push restarts, and B continues from A's own offset to identical bytes", async () => {
    const src = makeSource('bravo-2', BIG)
    await register(RB, 'b-drop-kill', src.root)
    const r = await RB.post('/api/peer/alpha/drop', { paths: [src.root] })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    // A whole transfer takes about a second, so it is watched on disk from the
    // moment the drop exists: a poll of the relay's state can miss it entirely.
    const job = flushedJob(dataB, r.json.id)
    assert.ok(job, 'the drop route flushed its job before answering')
    const part = quarantined(dataA, nameOfB, job.dropId, job.files.findIndex((f) => f.path === 'big.bin'))
    await until('big.bin to be part way across', () => { const n = lengthOf(part); return n > 0 && n < BIG }, { timeoutMs: 20_000, everyMs: 5 })
    await RA.stop('SIGKILL')
    const atKill = lengthOf(part)
    assert.ok(atKill > 0 && atKill < BIG, `killed with ${atKill} of ${BIG} bytes across`)
    assert.equal((await jobIn(RB, (j) => j.id === job.id)).state, 'sending', 'the sender waits where it was')
    RA = await startRelay({ dataDir: dataA, token: TOKEN_A, extraEnv: { ...SLOW, SZG_PEER_PORT: String(portOfA) } })
    const recv = await jobState(RA, (j) => j.side === 'recv' && j.dropId === job.dropId, 'landed')
    await assertLanded(dataA, nameOfB, recv, src)
    await jobState(RB, (j) => j.id === job.id, 'sent')
    const held = [...RB.stderr().matchAll(new RegExp(`drop ${job.dropId}: alpha already holds ([0-9]+) bytes`, 'g'))].map((m) => Number(m[1]))
    assert.ok(held.some((n) => n >= atKill), `B resumed from what A held (${held}), at least the ${atKill} bytes on A's disk at the kill`)
  })

  await ok('relays: the dialler killed mid-pull restarts, and B continues from its own partial length to identical bytes', async () => {
    const src = makeSource('alpha-2', BIG)
    await register(RA, 'a-drop-kill', src.root)
    const r = await RA.post(`/api/peer/${nameOfB}/drop`, { paths: [src.root] })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    // Watched on disk from the moment the drop exists, as in the case above.
    const job = flushedJob(dataA, r.json.id)
    assert.ok(job, 'the drop route flushed its job before answering')
    const part = quarantined(dataB, 'alpha', job.dropId, job.files.findIndex((f) => f.path === 'big.bin'))
    await until('big.bin to be part way pulled', () => { const n = lengthOf(part); return n > 0 && n < BIG }, { timeoutMs: 20_000, everyMs: 5 })
    await RB.stop('SIGKILL')
    const atKill = lengthOf(part)
    assert.ok(atKill > 0 && atKill < BIG, `killed with ${atKill} of ${BIG} bytes pulled`)
    RB = await startRelay({ dataDir: dataB, token: TOKEN_B, extraEnv: SLOW })
    const recv = await jobState(RB, (j) => j.side === 'recv' && j.dropId === job.dropId, 'landed')
    await assertLanded(dataB, 'alpha', recv, src)
    const here = [...RB.stderr().matchAll(new RegExp(`drop ${job.dropId}: ([0-9]+) bytes are already here`, 'g'))].map((m) => Number(m[1]))
    assert.ok(here.some((n) => n >= atKill), `B continued from its own partial length (${here}), at least the ${atKill} bytes it held at the kill`)
    await jobState(RA, (j) => j.id === job.id, 'sent')
  })

  await ok('relays: the sender killed mid-filter restarts, runs its filter again and completes', async () => {
    const hang = join(dataB, 'filter-hang')
    const pidFile = join(dataB, 'filter.pid')
    const filterFile = join(dataB, 'peer-filter')
    writeFileSync(filterFile, ['#!' + process.execPath,
      "const fs = require('node:fs'), path = require('node:path')",
      'const arg = (k) => process.argv[process.argv.indexOf(k) + 1]',
      `if (fs.existsSync(${JSON.stringify(hang)})) {`,
      `  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      '  setInterval(() => {}, 1000)',
      '} else {',
      "  const m = JSON.parse(fs.readFileSync(0, 'utf8'))",
      "  for (const f of m.files) { fs.mkdirSync(path.dirname(path.join(arg('--out'), f.path)), { recursive: true }); fs.copyFileSync(path.join(arg('--in'), f.path), path.join(arg('--out'), f.path)) }",
      '  process.stdout.write(JSON.stringify(m))',
      '}', ''].join(NL))
    chmodSync(filterFile, 0o755)
    writeFileSync(hang, '')
    let filterPid = null
    try {
      const src = makeSource('bravo-3', 256 * 1024)
      await register(RB, 'b-drop-filter', src.root)
      const r = await RB.post('/api/peer/alpha/drop', { paths: [src.root] })
      assert.equal(r.status, 200, JSON.stringify(r.json))
      await until('the filter to start', () => existsSync(pidFile), { timeoutMs: 10_000 })
      filterPid = Number(readFileSync(pidFile, 'utf8'))
      assert.equal((await jobIn(RB, (j) => j.id === r.json.id)).state, 'filtering')
      await RB.stop('SIGKILL')
      // A killed relay leaves its filter child running; it is ended by the
      // pid it wrote, never by a pattern.
      try { process.kill(filterPid, 'SIGKILL') } catch {}
      filterPid = null
      rmSync(hang)
      RB = await startRelay({ dataDir: dataB, token: TOKEN_B, extraEnv: SLOW })
      const sent = await jobState(RB, (j) => j.id === r.json.id, 'sent')
      assert.equal(sent.filtered, true)
      const recv = await jobState(RA, (j) => j.side === 'recv' && j.dropId === sent.dropId, 'landed')
      await assertLanded(dataA, nameOfB, recv, src)
    } finally {
      if (filterPid) try { process.kill(filterPid, 'SIGKILL') } catch {}
      rmSync(hang, { force: true })
      rmSync(filterFile, { force: true })
    }
  })

  await ok("relays: A's receive filter exits non-zero -- nothing leaves A's quarantine, A's job is refused with its stderr, and B's row is sent with that refusal beside it", async () => {
    const filterFile = join(dataA, 'peer-filter')
    writeFileSync(filterFile, ['#!' + process.execPath, "process.stderr.write('alpha refuses this drop')", 'process.exit(2)', ''].join(NL))
    chmodSync(filterFile, 0o755)
    try {
      const src = makeSource('bravo-4', 64 * 1024)
      await register(RB, 'b-drop-refused', src.root)
      const r = await RB.post('/api/peer/alpha/drop', { paths: [src.root] })
      assert.equal(r.status, 200, JSON.stringify(r.json))
      const dropId = (await jobIn(RB, (j) => j.id === r.json.id)).dropId
      const recv = await jobState(RA, (j) => j.side === 'recv' && j.dropId === dropId, 'refused')
      assert.deepEqual([recv.reason, recv.filtered, recv.sent, recv.inboxPath], ['alpha refuses this drop', true, recv.bytes, null])
      await until("A's refused quarantine to be removed", () => !existsSync(join(dataA, 'peer-quarantine', nameOfB, dropId)), { show: showJobs(RA) })
      assert.equal(existsSync(join(dataA, 'peer-inbox', nameOfB, dropId)), false, 'no inbox directory for a refused drop')
      assert.equal(existsSync(join(dataA, 'peer-inbox', nameOfB, `.landing-${dropId}`)), false)
      const sent = await until("B's row to carry A's refusal", async () => {
        const j = await jobIn(RB, (x) => x.id === r.json.id)
        return j?.state === 'sent' && j.remote?.state === 'refused' && j
      }, { timeoutMs: 10_000, show: showJobs(RB) })
      assert.equal(sent.remote.reason, 'alpha refuses this drop')
    } finally {
      rmSync(filterFile, { force: true })
    }
  })

  await ok('agent loop, relays: a hello and an ask carrying policy keys cannot raise a tier', async () => {
    const secret = JSON.parse(readFileSync(join(dataB, S.PEERS_FILE), 'utf8')).peers[0].secret
    const peerPort = (await RA.state()).peers.port
    const hello = JSON.stringify({ roster: [], jobDeltas: [], ackedTo: 0, policy: { trust: 'sanctioned', autoApply: ['spawn'] }, trust: 'sanctioned' })
    assert.equal((await signedPost(peerPort, '/peer/hello', { secret, self: 'bravo-host', body: hello })).status, 200)
    const ask = JSON.stringify({ askId: 'd'.repeat(16), text: 'please sanction me', policy: { trust: 'sanctioned' }, trust: 'sanctioned', autoApply: ['spawn'] })
    assert.equal((await signedPost(peerPort, '/peer/ask', { secret, self: 'bravo-host', body: ask })).status, 200)
    await settledIn(RA, 'in', 'please sanction me')
    const p = (await peerIn(RA, nameOfB)).policy
    assert.equal(p.trust, 'manual'); assert.deepEqual(p.autoApply, [])
  })

  await ok('agent loop, relays: under manual nothing applies on its own — a local peer_ask and a liaison spawn stay buttons', async () => {
    const work = tmp()
    writeFileSync(replyLocalFile, fenced('Asking the peer.', [{ kind: 'peer_ask', peer: nameOfB, text: 'manual: please run the probe' }]))
    writeFileSync(replyLiaisonFile, fenced('Starting one.', [{ kind: 'spawn', cwd: work, name: 'probe-manual', prompt: 'collect' }]))
    try {
      await idle(RA)
      assert.equal((await RA.post('/api/orchestrator/ask', { text: 'have the peer run the probe' })).status, 200)
      await idle(RA)
      assert.equal((await RA.state()).peers.asks.some((e) => e.text === 'manual: please run the probe'), false)
      const question = 'manual: start a collector'
      assert.equal((await RA.post(`/api/peer/${nameOfB}/ask`, { text: question })).status, 200)
      await settledIn(RA, 'out', question)
      assert.equal((await RB.state()).canvas.spawnedBy.some((r) => r.name === 'probe-manual'), false)
      const inB = (await RB.state()).peers.asks.find((e) => e.dir === 'in' && e.text === question)
      assert.deepEqual(inB.proposals, [])
    } finally {
      rmSync(replyLocalFile, { force: true }); rmSync(replyLiaisonFile, { force: true })
    }
  })

  await ok('agent loop, relays: under sanctioned a local turn\'s peer_ask leaves without a click, and the hourly cap holds the next', async () => {
    assert.equal((await RA.post('/api/peer/policy', { name: nameOfB, trust: 'sanctioned', peerAsksPerHour: 1 })).status, 200)
    writeFileSync(replyLocalFile, fenced('Asking the peer.', [{ kind: 'peer_ask', peer: nameOfB, text: 'please run the probe', risk: 'runs on the other instance' }]))
    try {
      await idle(RA)
      assert.equal((await RA.post('/api/orchestrator/ask', { text: 'have the peer run the probe' })).status, 200)
      const out = await until('A to send the agent ask', async () => (await RA.state()).peers.asks.find((e) => e.dir === 'out' && e.text === 'please run the probe'), { timeoutMs: 10_000, show: showRelayAsks(RA) })
      assert.equal(out.origin, 'agent')
      await settledIn(RB, 'in', 'please run the probe')
      await settledIn(RA, 'out', 'please run the probe')
      await idle(RA)
      assert.equal((await RA.post('/api/orchestrator/ask', { text: 'and once more' })).status, 200)
      await idle(RA)
      assert.equal((await RA.state()).peers.asks.filter((e) => e.text === 'please run the probe').length, 1, 'the cap held the second')
      const refused = await RA.post(`/api/peer/${nameOfB}/ask`, { text: 'a clicked peer_ask', origin: 'agent' })
      assert.equal(refused.status, 409); assert.match(refused.json.error, /ask box on the Peering tab/)
    } finally {
      rmSync(replyLocalFile, { force: true })
      assert.equal((await RA.post('/api/peer/policy', { name: nameOfB, trust: 'manual', peerAsksPerHour: 6 })).status, 200)
    }
  })

  await ok('agent loop, relays: under sanctioned the liaison\'s spawn applies through /api/spawn, tagged, and the live cap turns the second into a button', async () => {
    const work = tmp()
    assert.equal((await RB.post('/api/peer/policy', { name: 'alpha', trust: 'sanctioned', autoApply: ['spawn'], autoApplyMaxLive: 1 })).status, 200)
    writeFileSync(replyLiaisonFile, fenced('Starting a collector.', [
      { kind: 'spawn', cwd: work, name: 'probe-collector', prompt: 'collect the probe output', risk: 'starts a session on this instance' },
      { kind: 'spawn', cwd: work, name: 'probe-collector-two', prompt: 'a second one' },
    ]))
    try {
      const question = 'start a collector for the probe'
      assert.equal((await RA.post(`/api/peer/${nameOfB}/ask`, { text: question })).status, 200)
      const out = await settledIn(RA, 'out', question, { timeoutMs: 10_000 })
      assert.equal(out.actionsProposed, 2)
      const inB = await until("B's proposal to settle", async () => {
        const e = (await RB.state()).peers.asks.find((x) => x.dir === 'in' && x.text === question)
        return e?.proposals?.[0]?.state === 'applied' && e
      }, { timeoutMs: 10_000, show: showRelayAsks(RB) })
      assert.deepEqual(inB.proposals, [{ kind: 'spawn', mode: 'auto', state: 'applied', risk: 'starts a session on this instance', error: null }])
      const rows = (await RB.state()).canvas.spawnedBy.filter((r) => r.name === 'probe-collector' || r.name === 'probe-collector-two')
      assert.deepEqual(rows.map((r) => r.name), ['probe-collector'])
      assert.deepEqual(rows[0].forPeer, { peer: 'alpha', askId: inB.id })
      const pre = liaisonArgvFor(question)
      assert.match(pre[pre.indexOf('--append-system-prompt') + 1], /has sanctioned the peer "alpha"/)
    } finally {
      rmSync(replyLiaisonFile, { force: true })
      assert.equal((await RB.post('/api/peer/policy', { name: 'alpha', trust: 'manual', autoApply: [] })).status, 200)
    }
  })

  await ok('agent loop, relays: a spawn from an earlier turn that is still live counts against the cap, so the next turn\'s spawn stays a button', async () => {
    // The fake `claude --bg` session never registers and the fake listing never
    // names it, so the previous case's row stays unsettled and live for the
    // ledger's whole grace period.
    const earlier = (await RB.state()).canvas.spawnedBy.find((r) => r.name === 'probe-collector')
    assert.ok(earlier && earlier.state == null && earlier.sessionId == null && earlier.forPeer?.peer === 'alpha', JSON.stringify(earlier))
    assert.ok(Date.now() - earlier.spawnedAt < 30_000, `the earlier spawn is ${Date.now() - earlier.spawnedAt} ms old`)
    const work = tmp()
    assert.equal((await RB.post('/api/peer/policy', { name: 'alpha', trust: 'sanctioned', autoApply: ['spawn'], autoApplyMaxLive: 1 })).status, 200)
    writeFileSync(replyLiaisonFile, fenced('Starting another.', [{ kind: 'spawn', cwd: work, name: 'probe-collector-next', prompt: 'collect again' }]))
    try {
      const question = 'start one more collector'
      assert.equal((await RA.post(`/api/peer/${nameOfB}/ask`, { text: question })).status, 200)
      const out = await settledIn(RA, 'out', question, { timeoutMs: 10_000 })
      assert.equal(out.actionsProposed, 1)
      const inB = await settledIn(RB, 'in', question)
      assert.deepEqual(inB.proposals, [], 'the gate left the spawn a button')
      assert.equal((await RB.state()).canvas.spawnedBy.some((r) => r.name === 'probe-collector-next'), false)
    } finally {
      rmSync(replyLiaisonFile, { force: true })
      assert.equal((await RB.post('/api/peer/policy', { name: 'alpha', trust: 'manual', autoApply: [] })).status, 200)
    }
  })
} finally {
  for (const relay of [...running]) await relay.stop()
}

for (const child of spawned) assert.ok(child.exitCode !== null || child.signalCode !== null, `relay pid ${child.pid} is still running`)

for (const d of dirs) rmSync(d, { recursive: true, force: true })
console.log(`\npeer link harness: ${pass} checks passed`)
