#!/usr/bin/env node
// Drives bridge/peer.mjs, the peering wire's pure rules: the canonical string
// and its signature, the replay guard, pair codes, the pairing proof and key
// derivation, names and binds, the certificate argv, the ghost roster, the ask
// and job state edges, the caps and health, a drop's path selection -- then
// bridge/peers-store.mjs, the two durable files and the certificate,
// bridge/peer-jobs.mjs's durable job store and resumption plan, and
// bridge/peer-drops.mjs's staging by copy and the user's filter script.
// Hermetic: every file lives in a fresh temp dir and nothing opens a socket.
// The subprocesses are the real `openssl`, run once to prove the certificate
// is minted exactly once, and small node scripts standing in for a filter, run
// through the real spawn so stdin, stdout, exit codes and signals are real.
import assert from 'node:assert/strict'
import {
  mkdtempSync, statSync, existsSync, readFileSync, writeFileSync,
  appendFileSync, mkdirSync, readdirSync, realpathSync, symlinkSync, unlinkSync, chmodSync,
  lstatSync, readlinkSync, rmSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const P = await import(join(ROOT, 'syzygy', 'bridge', 'peer.mjs'))
const S = await import(join(ROOT, 'syzygy', 'bridge', 'peers-store.mjs'))
const J = await import(join(ROOT, 'syzygy', 'bridge', 'peer-jobs.mjs'))
const D = await import(join(ROOT, 'syzygy', 'bridge', 'peer-drops.mjs'))
const { realRun } = await import(join(ROOT, 'syzygy', 'bridge', 'canvas.mjs'))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }
const tmp = () => mkdtempSync(join(tmpdir(), 'szg-peer-'))
/** A well-formed certificate fingerprint: 32 colon-separated hex pairs. */
const FP1 = 'AB:'.repeat(31) + 'AB'

// ---- the signed envelope ----------------------------------------------------
await ok('canonical string is asserted literally', () => {
  const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  assert.equal(P.sha256hex(''), EMPTY)
  assert.equal(P.canonicalString({ method: 'POST', path: '/peer/hello', query: 'b=2&a=1', ts: '1700000000000', nonce: '0'.repeat(32), bodySha256: EMPTY }),
    'POST\n/peer/hello?a=1&b=2\n1700000000000\n' + '0'.repeat(32) + '\n' + EMPTY)
  assert.equal(P.canonicalString({ method: 'POST', path: '/peer/ask', ts: '1', nonce: 'ab', bodySha256: EMPTY }), 'POST\n/peer/ask?\n1\nab\n' + EMPTY)
})

await ok('a good signature verifies; every tamper fails', () => {
  const secret = randomBytes(32)
  const body = JSON.stringify({ askId: 'x', text: 'hi' })
  const { headers, bodySha256 } = P.signRequest({ secret, self: 'alpha', method: 'POST', path: '/peer/ask', query: '', body, now: 1000 })
  const base = { secret, method: 'POST', path: '/peer/ask', query: '', headers, bodySha256 }
  assert.equal(headers['x-szg-peer'], 'alpha')
  assert.equal(P.verifySignature(base), true)
  assert.equal(P.verifySignature({ ...base, path: '/peer/hello' }), false)
  assert.equal(P.verifySignature({ ...base, query: 'a=1' }), false)
  assert.equal(P.verifySignature({ ...base, bodySha256: P.sha256hex(body + ' ') }), false)
  assert.equal(P.verifySignature({ ...base, secret: randomBytes(32) }), false)
  assert.equal(P.verifySignature({ ...base, headers: { ...headers, 'x-szg-sig': headers['x-szg-sig'].slice(0, 20) } }), false)
  assert.equal(P.verifySignature({ ...base, headers: { ...headers, 'x-szg-sig': 'not hex at all' } }), false)
  assert.equal(P.verifySignature({ ...base, headers: { ...headers, 'x-szg-ts': '1001' } }), false)
  assert.equal(P.verifySignature({ ...base, secret: null }), false)
})

await ok('replay window edges both ways, single-use nonces, capped cache', () => {
  let t = 1_000_000
  const g = P.createReplayGuard({ now: () => t })
  const n = () => randomBytes(16).toString('hex')
  assert.equal(g.check(String(t - 120_000), n()).ok, true)
  assert.equal(g.check(String(t + 120_000), n()).ok, true)
  assert.deepEqual(g.check(String(t - 120_001), n()), { ok: false, reason: 'stale' })
  assert.deepEqual(g.check(String(t + 120_001), n()), { ok: false, reason: 'stale' })
  assert.equal(g.check('12x', n()).reason, 'ts')
  assert.equal(g.check(String(t), 'short').reason, 'nonce')
  const once = n()
  assert.equal(g.check(String(t), once).ok, true)
  assert.deepEqual(g.check(String(t), once), { ok: false, reason: 'replay' })
  for (let i = 0; i < 20_000; i++) g.check(String(t), n())
  assert.equal(g.size(), P.NONCE_CACHE_CAP)
  t += 240_001
  g.check(String(t), n())
  assert.equal(g.size(), 1, 'entries older than twice the window are swept on insert')
})

// ---- pairing ----------------------------------------------------------------
await ok('pair codes round-trip; malformed codes are refused, never thrown', () => {
  const fp = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':')
  const token = randomBytes(32)
  const code = P.formatPairCode({ host: '192.168.1.20', port: 4318, fp, token })
  assert.match(code, /^szg1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  const back = P.parsePairCode('  ' + code + '\n')
  assert.deepEqual({ ...back, token: back.token.toString('hex') }, { host: '192.168.1.20', port: 4318, fp, token: token.toString('hex') })
  for (const bad of [code.slice(0, -5), 'szg2' + code.slice(4), code.replace(/\.[^.]+\./, '.!!!.'),
    P.formatPairCode({ host: 'h', port: 1, fp: fp.slice(3), token }), P.formatPairCode({ host: 'h', port: 70000, fp, token }),
    P.formatPairCode({ host: '', port: 1, fp, token }), P.formatPairCode({ host: 'h', port: 1, fp, token: randomBytes(16) }), '', null, 42])
    assert.equal(P.parsePairCode(bad), null, String(bad).slice(0, 40))
})

await ok('proof and ack bind both fingerprints; the secret is identical from either side', () => {
  const mk = () => Array.from(randomBytes(32)).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':')
  const fa = mk(), fb = mk(), token = randomBytes(32)
  assert.notEqual(P.pairProof(token, fa, fb), P.pairProof(token, fb, fa))
  assert.notEqual(P.pairProof(token, fa, fb), P.pairAck(token, fb, fa))
  assert.equal(P.hexEqual(P.pairProof(token, fa, fb), P.pairProof(token, fa, fb)), true)
  assert.equal(P.hexEqual('zz', 'zz'), false)
  const s1 = P.derivePairSecret(token, fa, fb), s2 = P.derivePairSecret(token, fb, fa)
  assert.equal(s1.length, 32)
  assert.equal(s1.equals(s2), true)
  assert.equal(s1.equals(P.derivePairSecret(token, fa, mk())), false)
  assert.equal(s1.equals(P.derivePairSecret(randomBytes(32), fa, fb)), false)
})

await ok('names, self names and binds', () => {
  for (const good of ['a', 'laptop', 'vm-01', 'x'.repeat(32)]) assert.equal(P.validName(good), true)
  for (const bad of ['', 'Laptop', 'a b', '../x', 'x'.repeat(33), null, 'a/b']) assert.equal(P.validName(bad), false)
  assert.equal(P.selfNameFrom('Someones-MacBook.local'), 'someones-macbook-local')
  assert.equal(P.selfNameFrom('...'), 'syzygy')
  assert.equal(P.validBind('192.168.1.20').ok, true)
  assert.equal(P.validBind('::1').ok, true)
  assert.equal(P.validBind('localhost').ok, false)
  assert.equal(P.validBind('0.0.0.0').ok, false)
  assert.equal(P.validBind('::').ok, false)
  assert.equal(P.validBind('0.0.0.0', { allowAny: true }).ok, true)
})

await ok('openssl argv is an array, exactly the verified invocation', () => {
  assert.deepEqual(P.opensslArgv({ keyPath: '/d/peer-key.pem', certPath: '/d/peer-cert.pem', bind: '192.168.1.20' }),
    ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', '/d/peer-key.pem', '-out', '/d/peer-cert.pem', '-days', '3650', '-nodes',
     '-subj', '/CN=syzygy-peer', '-addext', 'subjectAltName=IP:192.168.1.20,DNS:localhost,IP:127.0.0.1'])
  assert.equal(P.opensslArgv({ keyPath: 'k', certPath: 'c', bind: '127.0.0.1' }).at(-1), 'subjectAltName=DNS:localhost,IP:127.0.0.1')
})

// ---- what crosses the link --------------------------------------------------
await ok('the ghost roster is the narrow projection and nothing else', () => {
  const r = P.ghostRoster([{ id: 's1', name: 'n', model: 'opus', working: 1, needs: 'x'.repeat(500), branch: 'main', root: '/r',
    cwd: '/secret', pid: 9, stats: { cost: 3 }, files: { a: 1 }, lastAnswer: 'hi', tmux: '%1' }, { name: 'no id' }, 'junk'])
  assert.equal(r.length, 1)
  assert.deepEqual(Object.keys(r[0]).sort(), ['branch', 'forYou', 'id', 'model', 'name', 'needs', 'root', 'working'])
  assert.equal(r[0].working, true); assert.equal(r[0].needs.length, 200)
  assert.equal(P.ghostRoster(Array.from({ length: 300 }, (_, i) => ({ id: 'i' + i }))).length, 100)
  assert.deepEqual(P.ghostRoster(null), [])
})

await ok('ask edges: every legal edge, no illegal one, terminals are terminal', () => {
  const legal = { out: { queued: ['sent', 'answered', 'failed'], sent: ['answered', 'failed'] },
    in: { received: ['answering', 'held', 'failed'], queued: ['answering', 'held', 'failed'], held: ['received', 'failed'], answering: ['answered', 'failed', 'queued'] } }
  const states = { out: ['queued', 'sent', 'answered', 'failed'], in: ['received', 'queued', 'held', 'answering', 'answered', 'failed'] }
  for (const dir of ['out', 'in']) for (const from of states[dir]) for (const to of states[dir])
    assert.equal(P.canTransition(dir, from, to), (legal[dir][from] ?? []).includes(to), `${dir} ${from}->${to}`)
  assert.equal(P.isTerminalAsk('answered'), true); assert.equal(P.isTerminalAsk('held'), false)
})

await ok('both job ladders are exactly as drawn, and an illegal edge writes nothing', () => {
  assert.deepEqual(Object.keys(P.JOB_EDGES), ['send', 'recv'])
  assert.equal(P.canJobTransition('send', 'queued', 'filtering'), true)
  assert.equal(P.canJobTransition('send', 'filtering', 'offering'), true)
  assert.equal(P.canJobTransition('send', 'offering', 'sending'), true)
  assert.equal(P.canJobTransition('send', 'sending', 'sent'), true)
  assert.equal(P.canJobTransition('send', 'offering', 'refused'), true)
  assert.equal(P.canJobTransition('recv', 'offered', 'receiving'), true)
  assert.equal(P.canJobTransition('recv', 'receiving', 'verifying'), true)
  assert.equal(P.canJobTransition('recv', 'verifying', 'filtering'), true)
  assert.equal(P.canJobTransition('recv', 'filtering', 'landed'), true)
  // Terminal is terminal, and a side's ladder is not the other's.
  for (const s of ['sent', 'landed', 'refused', 'failed']) assert.equal(P.isTerminalJob(s), true)
  assert.equal(P.canJobTransition('send', 'sent', 'sending'), false)
  assert.equal(P.canJobTransition('send', 'queued', 'landed'), false)
  assert.equal(P.canJobTransition('recv', 'queued', 'receiving'), false)
  assert.equal(P.canJobTransition('sideways', 'queued', 'sent'), false)
  // failed is reachable from every non-terminal state on both ladders.
  for (const [side, edges] of Object.entries(P.JOB_EDGES)) {
    for (const from of Object.keys(edges)) assert.equal(P.canJobTransition(side, from, 'failed'), true, `${side} ${from} -> failed`)
  }
})

await ok('caps: per hour by count, per day by spend, other peers ignored', () => {
  const now = 10 * 86_400_000
  const mk = (peer, agoMs, costUsd = 0) => ({ dir: 'in', peer, startedAt: now - agoMs, costUsd })
  const policy = { asksPerHour: 2, peerAskDailyCapUsd: 1 }
  assert.equal(P.capCheck({ asks: [mk('a', 10), mk('b', 10), mk('b', 10)], peer: 'a', now, policy }).ok, true)
  assert.equal(P.capCheck({ asks: [mk('a', 10), mk('a', 20)], peer: 'a', now, policy }).ok, false)
  assert.equal(P.capCheck({ asks: [mk('a', 3_700_000), mk('a', 3_800_000)], peer: 'a', now, policy }).ok, true)
  assert.equal(P.capCheck({ asks: [mk('a', 5 * 3_600_000, 0.6), mk('a', 6 * 3_600_000, 0.5)], peer: 'a', now, policy }).ok, false)
  assert.equal(P.capCheck({ asks: [mk('a', 25 * 3_600_000, 5)], peer: 'a', now, policy }).ok, true)
  assert.equal(P.capCheck({ asks: [{ dir: 'in', peer: 'a', startedAt: null }], peer: 'a', now, policy }).ok, true)
})

await ok('health: never, up, down, both sides', () => {
  const helloMs = 1000, now = 100_000
  assert.equal(P.healthOf({ dials: true, now, helloMs }).state, 'never')
  assert.equal(P.healthOf({ dials: true, lastOkAt: now - 10, rttMs: 4, now, helloMs }).state, 'up')
  const down = P.healthOf({ dials: true, lastOkAt: now - 5000, lastErrAt: now - 10, lastErr: 'ECONNREFUSED', now, helloMs })
  assert.equal(down.state, 'down'); assert.equal(down.error, 'ECONNREFUSED'); assert.equal(down.lastSeenAt, now - 5000)
  assert.equal(P.healthOf({ dials: false, now, helloMs }).state, 'never')
  assert.equal(P.healthOf({ dials: false, lastInboundAt: now - 2999, now, helloMs }).state, 'up')
  assert.equal(P.healthOf({ dials: false, lastInboundAt: now - 3001, now, helloMs }).state, 'down')
  assert.equal(P.healthOf({ dials: true, lastOkAt: now, skewMs: -61_000, now, helloMs }).skewWarn, true)
  assert.deepEqual(P.retryLadder('500,1000'), [500, 1000]); assert.deepEqual(P.retryLadder('x'), [5000, 15000, 45000]); assert.deepEqual(P.retryLadder(undefined), [5000, 15000, 45000])
})

// ---- the stores -------------------------------------------------------------
await ok('peers.json is written atomically, mode 0600, and read back sanitised', () => {
  const dir = tmp()
  const doc = S.emptyPeers('Test-Host')
  assert.equal(doc.self, 'test-host')
  doc.peers.push({ name: 'vm', remoteName: 'vm', address: { host: '10.0.0.2', port: 4318 }, fingerprint: FP1, certPem: null,
    secret: 'ab'.repeat(32), pairedAt: 1, confirmedAt: null, policy: { asksPerHour: 5, peerAskDailyCapUsd: 1.5 } })
  doc.peers.push({ name: 'Bad Name', remoteName: 'x', fingerprint: FP1, secret: 'ab'.repeat(32) })
  S.writePeers(dir, doc)
  assert.equal(statSync(join(dir, 'peers.json')).mode & 0o777, 0o600)
  assert.equal(existsSync(join(dir, 'peers.json.tmp')), false)
  const back = S.readPeers(dir, { hostname: 'ignored' })
  assert.deepEqual(back.peers.map((p) => p.name), ['vm'])
  assert.deepEqual(back.peers[0].policy, {
    asksPerHour: 5, peerAskDailyCapUsd: 1.5, trust: 'manual', autoApply: [], autoApplyMaxLive: 2, peerAsksPerHour: 6,
  })
})

await ok('a failed serialize leaves the previous peers.json intact', () => {
  const dir = tmp()
  S.writePeers(dir, S.emptyPeers('h'))
  const before = readFileSync(join(dir, 'peers.json'), 'utf8')
  const cyclic = S.emptyPeers('h'); cyclic.self2 = cyclic
  assert.throws(() => S.writePeers(dir, cyclic))
  assert.equal(readFileSync(join(dir, 'peers.json'), 'utf8'), before)
})

await ok('a corrupt peers.json is moved aside, never overwritten', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'peers.json'), '{ not json')
  const doc = S.readPeers(dir, { hostname: 'h', now: () => 42 })
  assert.equal(doc.enabled, false)
  assert.equal(readFileSync(join(dir, 'peers.json.corrupt-42'), 'utf8'), '{ not json')
})

await ok('ensureCert mints once with the real openssl and never re-mints', async () => {
  const dir = tmp()
  const first = await S.ensureCert({ dir, bind: '127.0.0.1', run: realRun })
  assert.equal(first.minted, true)
  assert.match(first.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  assert.equal(statSync(join(dir, 'peer-key.pem')).mode & 0o777, 0o600)
  const mtime = statSync(join(dir, 'peer-cert.pem')).mtimeMs
  const second = await S.ensureCert({ dir, bind: '10.9.9.9', run: realRun })
  assert.equal(second.minted, false)
  assert.equal(second.fingerprint, first.fingerprint)
  assert.equal(statSync(join(dir, 'peer-cert.pem')).mtimeMs, mtime)
})

await ok('a missing openssl is a plain error naming the package', async () => {
  const run = async () => ({ code: 'ENOENT', stdout: '', stderr: '' })
  await assert.rejects(S.ensureCert({ dir: tmp(), bind: '127.0.0.1', run }), /install the openssl package/)
})

await ok('the ask store: legal transitions only, outbound seq, acks, forgotten peers, durability', () => {
  const dir = tmp(); let t = 1000
  const file = join(dir, 'peer-asks.json')
  const st = S.createAsksStore({ file, now: () => t })
  const out = st.create({ peer: 'vm', dir: 'out', text: 'hello?' })
  assert.equal(out.state, 'queued'); assert.match(out.askId, /^[0-9a-f]{16}$/)
  assert.throws(() => st.transition(out.id, 'received'), /illegal ask transition/)
  assert.equal(st.get(out.id).state, 'queued')
  assert.throws(() => st.create({ peer: 'vm', dir: 'in', askId: 'nothex', text: 'x' }))
  assert.equal(st.enqueueOutbound(out.id), 1)
  assert.deepEqual(st.outboundFor('vm', 0).map((e) => e.id), [out.id])
  assert.deepEqual(st.outboundFor('vm', 1), [])
  st.ackOutbound('vm', 1)
  assert.deepEqual(st.outboundFor('vm', 0), [])
  st.transition(out.id, 'sent')
  st.flush()
  const again = S.createAsksStore({ file, now: () => t })
  assert.equal(again.get(out.id).state, 'sent')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).seq, 1)
  again.markForgotten('vm')
  assert.equal(again.get(out.id).peer, 'vm (forgotten)')
})

await ok('the ask store: stalled asks fail after a day; a corrupt file is moved aside; bad entries are dropped', () => {
  const dir = tmp(); let t = 0
  const file = join(dir, 'peer-asks.json')
  const st = S.createAsksStore({ file, now: () => t })
  const a = st.create({ peer: 'vm', dir: 'in', askId: 'ab'.repeat(8), text: 'q' })
  const b = st.create({ peer: 'vm', dir: 'out', text: 'q' }); st.transition(b.id, 'answered', { reply: 'r' })
  t = 24 * 3600_000 + 1
  assert.deepEqual(st.sweepStalled().map((e) => e.id), [a.id])
  assert.equal(st.get(a.id).error, 'stalled'); assert.equal(st.get(b.id).state, 'answered')
  writeFileSync(file, JSON.stringify({ version: 1, seq: 3, items: [null, { id: 'x', dir: 'sideways' }, { ...st.get(b.id) }] }))
  assert.deepEqual(S.createAsksStore({ file, now: () => t }).all().map((e) => e.id), [b.id])
  writeFileSync(file, 'garbage')
  S.createAsksStore({ file, now: () => 77 })
  assert.equal(readFileSync(file + '.corrupt-77', 'utf8'), 'garbage')
})

await ok('the ask store: an apply left applying on disk reads back failed; one applying in memory stays applying', () => {
  const dir = tmp(); const t = 5000
  const file = join(dir, 'peer-asks.json')
  const st = S.createAsksStore({ file, now: () => t })
  const e = st.create({ peer: 'probe-check', dir: 'in', askId: 'cd'.repeat(8), text: 'start a collector' })
  const action = { kind: 'spawn', cwd: '/w', name: 'probe-collector', prompt: 'collect' }
  const running = { index: 0, kind: 'spawn', action, risk: null, mode: 'auto', state: 'applying', error: null, gateNote: null, at: t }
  const noted = { ...running, index: 1, error: 'the route did not answer' }
  const done = { ...running, index: 2, state: 'applied' }
  st.set(e.id, { proposals: [running, noted, done] })
  assert.deepEqual(st.get(e.id).proposals.map((p) => p.state), ['applying', 'applying', 'applied'])
  st.flush()
  const again = S.createAsksStore({ file, now: () => t })
  assert.deepEqual(again.get(e.id).proposals.map((p) => [p.state, p.error]),
    [['failed', 'the relay stopped'], ['failed', 'the route did not answer'], ['applied', null]])
  again.set(e.id, { proposals: [running] })
  assert.equal(again.get(e.id).proposals[0].state, 'applying')
})

// ---- the job store ------------------------------------------------------------
await ok('the job store: mints per side, illegal edges write nothing, refused needs a reason, progress and pin', () => {
  const dir = tmp(); let t = 1000
  const file = join(dir, 'peer-jobs.json')
  const st = J.createJobsStore({ file, now: () => t })

  const sent = st.create({ peer: 'vm', side: 'send', files: [{ path: 'a.ts', size: 3 }], bytes: 3 })
  assert.equal(sent.state, 'queued'); assert.match(sent.dropId, /^[0-9a-f]{16}$/)
  const recv = st.create({ peer: 'vm', side: 'recv', dropId: sent.dropId, files: [{ path: 'a.ts', size: 3 }], bytes: 3 })
  assert.equal(recv.state, 'offered'); assert.equal(recv.dropId, sent.dropId)

  // An illegal edge throws before touching the in-memory job or the file.
  const before = JSON.stringify(st.get(sent.id))
  assert.throws(() => st.transition(sent.id, 'sending'), /illegal job transition/)
  assert.equal(JSON.stringify(st.get(sent.id)), before)
  st.flush()
  const onDisk = readFileSync(file, 'utf8')
  assert.throws(() => st.transition(sent.id, 'offering'), /illegal job transition/, 'queued cannot skip filtering')
  assert.equal(readFileSync(file, 'utf8'), onDisk)

  // A legal edge to `refused` still needs a reason.
  st.transition(sent.id, 'filtering', { files: [{ path: 'a.ts', size: 3, sha256: 'a'.repeat(64), mode: 0o644 }] })
  assert.throws(() => st.transition(sent.id, 'refused'), /reason/)
  assert.throws(() => st.transition(sent.id, 'refused', {}), /reason/)
  st.transition(sent.id, 'refused', { reason: 'the filter refused it' })
  assert.equal(st.get(sent.id).state, 'refused'); assert.equal(st.get(sent.id).reason, 'the filter refused it')

  // `failed` needs an error the same way.
  st.transition(recv.id, 'receiving')
  assert.throws(() => st.transition(recv.id, 'failed'), /error/)
  st.transition(recv.id, 'failed', { error: 'the connection dropped' })
  assert.equal(st.get(recv.id).state, 'failed'); assert.equal(st.get(recv.id).error, 'the connection dropped')

  // progress and pin are bookkeeping, not a state change.
  const third = st.create({ peer: 'vm', side: 'send', files: [], bytes: 0 })
  t = 1500
  st.progress(third.id, { fileIdx: 2, offset: 4096 })
  assert.deepEqual(st.get(third.id).progress, { fileIdx: 2, offset: 4096 })
  assert.equal(st.get(third.id).state, 'queued')
  assert.equal(st.get(third.id).updatedAt, 1500, 'a chunk is progress, so it holds off the stall sweep')
  st.pin(third.id, true)
  assert.equal(st.get(third.id).pinned, true)

  // set records a transfer's bookkeeping; it never moves state or the pin.
  t = 1600
  st.set(third.id, { sent: 7, remote: { state: 'receiving', reason: null, at: 5 }, retried: [1, 1, -1, 'x', 3], state: 'sent', pinned: false })
  const kept = st.get(third.id)
  assert.deepEqual([kept.sent, kept.remote, kept.retried, kept.state, kept.pinned, kept.updatedAt],
    [7, { state: 'receiving', reason: null, at: 5 }, [1, 3], 'queued', true, 1500])
  assert.deepEqual(recv.retried, [], 'a new job has asked for nothing again')
})

await ok('the job store: flush serializes atomically; a reload drops malformed entries; a corrupt file is moved aside', () => {
  const dir = tmp(); let t = 1
  const file = join(dir, 'peer-jobs.json')
  const st = J.createJobsStore({ file, now: () => t })
  const a = st.create({ peer: 'vm', side: 'send', files: [], bytes: 0 })
  st.flush()
  const before = readFileSync(file, 'utf8')

  // A write that cannot land leaves the previous file byte-identical.
  st.create({ peer: 'vm', side: 'send', files: [], bytes: 0 })
  chmodSync(dir, 0o500)
  try {
    assert.throws(() => st.flush())
  } finally {
    chmodSync(dir, 0o700)
  }
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(existsSync(file + '.tmp'), false)
  st.flush()

  writeFileSync(file, JSON.stringify({ version: 1, items: [null, { id: 'x', side: 'sideways' }, { ...st.get(a.id) }] }))
  assert.deepEqual(J.createJobsStore({ file, now: () => t }).all().map((e) => e.id), [a.id])

  writeFileSync(file, 'garbage')
  J.createJobsStore({ file, now: () => 77 })
  assert.equal(readFileSync(file + '.corrupt-77', 'utf8'), 'garbage')
})

await ok('the job store: sweepStalled fails exactly the jobs with no progress for 24h, terminal jobs untouched', () => {
  const dir = tmp(); let t = 0
  const file = join(dir, 'peer-jobs.json')
  const st = J.createJobsStore({ file, now: () => t })
  const stuck = st.create({ peer: 'vm', side: 'send', files: [], bytes: 0 })
  const done = st.create({ peer: 'vm', side: 'send', files: [], bytes: 0 })
  st.transition(done.id, 'filtering', {}); st.transition(done.id, 'refused', { reason: 'no' })
  t = 24 * 3600_000 + 1
  assert.deepEqual(st.sweepStalled().map((e) => e.id), [stuck.id])
  assert.equal(st.get(stuck.id).state, 'failed'); assert.equal(st.get(stuck.id).error, 'stalled')
  assert.equal(st.get(done.id).state, 'refused')
})

await ok('resumePlan is a plan, not an action: every non-terminal state maps to its resume step, terminal states are absent', () => {
  const dir = tmp()
  const st = J.createJobsStore({ file: join(dir, 'peer-jobs.json'), now: () => 1 })

  const sQueued = st.create({ peer: 'vm', side: 'send', files: [], bytes: 0 })
  const sFiltering = st.create({ peer: 'vm', side: 'send', files: [], bytes: 0 }); st.transition(sFiltering.id, 'filtering')
  const sOffering = st.create({ peer: 'vm', side: 'send', files: [], bytes: 0 })
  st.transition(sOffering.id, 'filtering'); st.transition(sOffering.id, 'offering')
  const sSending = st.create({ peer: 'vm', side: 'send', files: [], bytes: 0 })
  st.transition(sSending.id, 'filtering'); st.transition(sSending.id, 'offering'); st.transition(sSending.id, 'sending')
  const sSent = st.create({ peer: 'vm', side: 'send', files: [], bytes: 0 })
  st.transition(sSent.id, 'filtering'); st.transition(sSent.id, 'offering'); st.transition(sSent.id, 'sending'); st.transition(sSent.id, 'sent')

  const rOffered = st.create({ peer: 'vm', side: 'recv', files: [], bytes: 0 })
  const rReceiving = st.create({ peer: 'vm', side: 'recv', files: [], bytes: 0 }); st.transition(rReceiving.id, 'receiving')
  const rVerifying = st.create({ peer: 'vm', side: 'recv', files: [], bytes: 0 })
  st.transition(rVerifying.id, 'receiving'); st.transition(rVerifying.id, 'verifying')
  const rFiltering = st.create({ peer: 'vm', side: 'recv', files: [], bytes: 0 })
  st.transition(rFiltering.id, 'receiving'); st.transition(rFiltering.id, 'verifying'); st.transition(rFiltering.id, 'filtering')
  const rLanded = st.create({ peer: 'vm', side: 'recv', files: [], bytes: 0 })
  st.transition(rLanded.id, 'receiving'); st.transition(rLanded.id, 'verifying'); st.transition(rLanded.id, 'filtering'); st.transition(rLanded.id, 'landed')
  const rRefused = st.create({ peer: 'vm', side: 'recv', files: [], bytes: 0 }); st.transition(rRefused.id, 'refused', { reason: 'no' })

  const plan = new Map(st.resumePlan().map((p) => [p.id, p.action]))
  assert.equal(plan.get(sQueued.id), 'requeue')
  assert.equal(plan.get(sFiltering.id), 'refilter')
  assert.equal(plan.get(sOffering.id), 'reoffer')
  assert.equal(plan.get(sSending.id), 'reoffer')
  assert.equal(plan.get(rOffered.id), 'wait')
  assert.equal(plan.get(rReceiving.id), 'wait')
  assert.equal(plan.get(rVerifying.id), 'reverify')
  assert.equal(plan.get(rFiltering.id), 'reverify')
  // Every terminal state is absent from the plan entirely.
  for (const id of [sSent.id, rLanded.id, rRefused.id]) assert.equal(plan.has(id), false)
  assert.equal(st.resumePlan().length, 8)
})

// ---- which peer a session is working for ------------------------------------
await ok('sanitizeForPeer keeps exactly a valid peer name and an ask store id', () => {
  const id = 'a'.repeat(16)
  assert.deepEqual(P.sanitizeForPeer({ peer: 'vm', askId: id, extra: 1 }), { peer: 'vm', askId: id })
  for (const bad of [null, 'vm', {}, { peer: 'vm' }, { peer: 'Vm!', askId: id }, { peer: 'vm', askId: 'short' },
    { peer: 'vm (forgotten)', askId: id }]) {
    assert.equal(P.sanitizeForPeer(bad), null, JSON.stringify(bad) + ' must be refused')
  }
})

await ok('forPeerIndex reads the tags stored on spawns, requests and prompted sessions', () => {
  const tag = (peer, ch) => ({ peer, askId: ch.repeat(16) })
  const spawnedBy = [
    { shortId: 'ab12', sessionId: 's-spawned', forPeer: tag('vm', 'a') },
    { shortId: 'cd34', sessionId: null, forPeer: tag('vm', 'b') },
    { shortId: 'ef56', sessionId: 's-plain' },
  ]
  const requests = [
    { id: 'r-9', session: { sessionId: 's-dispatched' }, forPeer: tag('laptop', 'c') },
    { id: 'r-10', session: null, forPeer: tag('laptop', 'd') },
  ]
  const sessions = [{ id: 's-live', forPeer: tag('vm', 'e') }, { id: 's-plain' },
    { id: 's-spawned', forPeer: tag('laptop', 'f') }]
  const idx = P.forPeerIndex({ spawnedBy, requests, sessions })
  assert.deepEqual(idx.get('s-spawned'), tag('vm', 'a'))       // the origin wins over a later prompt
  assert.deepEqual(idx.get('s-dispatched'), tag('laptop', 'c'))
  assert.deepEqual(idx.get('s-live'), tag('vm', 'e'))
  assert.equal(idx.has('s-plain'), false)                        // a local session with no peer tag carries nothing
  assert.equal(idx.size, 3)
  assert.equal(P.forPeerIndex({ spawnedBy: [{ sessionId: 'x', forPeer: { peer: 'NOT OK', askId: 'zz' } }] }).size, 0)
  assert.equal(P.forPeerIndex().size, 0)
})

await ok('a roster row says forYou and never names a peer or an ask', () => {
  const sessions = [
    { id: 's1', name: 'one', forPeer: { peer: 'vm', askId: 'a'.repeat(16) } },
    { id: 's2', name: 'two', forPeer: { peer: 'laptop', askId: 'b'.repeat(16) } },
    { id: 's3', name: 'three' },
  ]
  const rows = P.ghostRoster(sessions, { peer: 'vm' })
  assert.deepEqual(rows.map((r) => [r.id, r.forYou]), [['s1', true], ['s2', false], ['s3', false]])
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['branch', 'forYou', 'id', 'model', 'name', 'needs', 'root', 'working'])
    assert.equal(JSON.stringify(r).includes('laptop'), false)
    assert.equal(JSON.stringify(r).includes('a'.repeat(16)), false)
  }
  // An incoming roster has no peer: the remote's own boolean is kept, and only a real true.
  assert.deepEqual(P.ghostRoster([{ id: 'r1', forYou: true }, { id: 'r2', forYou: 'yes' }, { id: 'r3' }]).map((r) => r.forYou),
    [true, false, false])
  // A local roster built with no peer carries no tag through.
  assert.deepEqual(P.ghostRoster(sessions).map((r) => r.forYou), [false, false, false])
})

// ---- selecting a drop ---------------------------------------------------------
await ok('expandDropPaths takes only known-root files, under both caps', () => {
  const tree = {
    '/w/app/a.ts': { file: true, size: 10 },
    '/w/app/sub/b.ts': { file: true, size: 20 },
    '/w/app/sub/.git/config': { file: true, size: 5 },
    '/w/app/sub': { dir: true, entries: ['b.ts', '.git'] },
    '/w/app': { dir: true, entries: ['a.ts', 'sub'] },
    '/elsewhere/c.ts': { file: true, size: 1 },
  }
  const stat = (p) => tree[p] ?? null
  const readdir = (p) => tree[p]?.entries ?? []
  const r = P.expandDropPaths(['/w/app'], { roots: ['/w/app'], stat, readdir })
  assert.deepEqual(r.files.map((f) => f.path), ['a.ts', 'sub/b.ts'])
  assert.equal(r.files.reduce((n, f) => n + f.size, 0), 30)
  // A path outside every known root is refused with a reason, never dropped silently --
  // and it is a PER-PATH refusal, not a whole-input one: a caller may drop it and send the rest.
  const out = P.expandDropPaths(['/elsewhere/c.ts'], { roots: ['/w/app'], stat, readdir })
  assert.deepEqual(out.files, [])
  assert.equal(out.refused.length, 1)
  assert.match(out.refused[0].reason, /root/)
  assert.equal(out.refused[0].whole, undefined)
  // Both caps refuse rather than truncate, and both mark the whole input refused.
  const many = P.expandDropPaths(['/w/app'], { roots: ['/w/app'], stat, readdir, fileCap: 1 })
  assert.match(many.refused[0].reason, /2000|cap|too many/i)
  assert.equal(many.refused[0].whole, true)
  const big = P.expandDropPaths(['/w/app'], { roots: ['/w/app'], stat, readdir, byteCap: 5 })
  assert.match(big.refused[0].reason, /bytes|too large/i)
  assert.equal(big.refused[0].whole, true)
})

await ok('expandDropPaths refuses by name, by prefix and by shape, and never throws', () => {
  const tree = {
    '/w/app': { dir: true, entries: ['sock', 'link.ts', 'ok.ts', 'pipe'] },
    '/w/app/ok.ts': { file: true, size: 3, mode: 0o100644 },
    '/w/app/link.ts': { symlink: true },
    '/w/app/sock': { other: 'socket' },
    '/w/app/pipe': { other: 'fifo' },
    '/w/appX/secret.ts': { file: true, size: 1 },
    '/w/app/.git/config': { file: true, size: 1 },
  }
  const stat = (p) => tree[p] ?? null
  const readdir = (p) => tree[p]?.entries ?? []
  const r = P.expandDropPaths(['/w/app'], { roots: ['/w/app'], stat, readdir })
  // A refused entry is named with its reason; its siblings still go.
  assert.deepEqual(r.files, [{ root: '/w/app', path: 'ok.ts', abs: '/w/app/ok.ts', size: 3, mode: 0o644 }])
  assert.deepEqual(r.refused.map((x) => x.path), ['/w/app/link.ts', '/w/app/pipe', '/w/app/sock'])
  assert.match(r.refused[0].reason, /symlink/)
  assert.match(r.refused[1].reason, /fifo/)
  assert.match(r.refused[2].reason, /socket/)
  // None of these are whole-input refusals: each is a path a caller may drop and continue past.
  assert.ok(r.refused.every((x) => x.whole === undefined))
  // A sibling directory that merely starts with the root's name is not inside it.
  const prefix = P.expandDropPaths(['/w/appX/secret.ts'], { roots: ['/w/app/'], stat, readdir })
  assert.deepEqual(prefix.files, [])
  assert.match(prefix.refused[0].reason, /root/)
  // Relative, unnormalised, inside .git, missing, not a string: each refused, none thrown.
  const bad = P.expandDropPaths(['w/app/ok.ts', '/w/app/../appX/secret.ts', '/w/app/.git/config', '/w/app/gone.ts', 7],
    { roots: ['/w/app'], stat, readdir })
  assert.deepEqual(bad.files, [])
  assert.equal(bad.refused.length, 5)
  const boom = () => { throw new Error('EACCES') }
  const thrown = P.expandDropPaths(['/w/app'], { roots: ['/w/app'], stat: boom, readdir: boom })
  assert.deepEqual(thrown.files, [])
  assert.equal(thrown.refused.length, 1)
  assert.deepEqual(P.expandDropPaths(null, {}), { files: [], refused: [] })
  // The same file selected twice is one file, not a collision.
  assert.deepEqual(P.expandDropPaths(['/w/app', '/w/app/ok.ts'], { roots: ['/w/app'], stat, readdir }).files.map((f) => f.path), ['ok.ts'])
})

await ok('two roots whose files would collide in staging refuse the whole drop', () => {
  const tree = {
    '/w/app/a.ts': { file: true, size: 1 },
    '/w/lib/a.ts': { file: true, size: 1 },
    '/w/app/x': { file: true, size: 1 },
    '/w/lib/x': { dir: true, entries: ['y'] },
    '/w/lib/x/y': { file: true, size: 1 },
  }
  const stat = (p) => tree[p] ?? null
  const readdir = (p) => tree[p]?.entries ?? []
  const roots = ['/w/app', '/w/lib']
  const same = P.expandDropPaths(['/w/app/a.ts', '/w/lib/a.ts'], { roots, stat, readdir })
  assert.deepEqual(same.files, [])
  assert.match(same.refused[0].reason, /a\.ts/)
  assert.equal(same.refused[0].whole, true)
  // A file in one root where the other root has a directory of the same name.
  const nested = P.expandDropPaths(['/w/app/x', '/w/lib/x'], { roots, stat, readdir })
  assert.deepEqual(nested.files, [])
  assert.equal(nested.refused[0].whole, true)
  assert.match(nested.refused[0].reason, /\bx\b/)
})

// ---- staging a drop -----------------------------------------------------------
/** A real source tree: `a.ts` and `sub/b.ts`, resolved the way the relay resolves. */
const srcTree = () => {
  const src = realpathSync(tmp())
  mkdirSync(join(src, 'sub'))
  writeFileSync(join(src, 'a.ts'), 'hello')
  writeFileSync(join(src, 'sub', 'b.ts'), 'world!')
  return src
}

await ok('stageDrop copies each file under peer-staging/<dropId>/in and hashes the copy', async () => {
  const src = srcTree()
  const { files, refused } = P.expandDropPaths([src], { roots: [src], ...D.dropFs })
  assert.deepEqual(refused, [])
  const world = join(tmp(), 'not', 'yet')
  const dropId = 'ab'.repeat(8)
  const srcMtime = statSync(join(src, 'a.ts')).mtimeMs
  const rows = await D.stageDrop({ dir: world, dropId, files })
  const inDir = join(world, 'peer-staging', dropId, 'in')
  assert.deepEqual(rows, [
    { path: 'a.ts', size: 5, sha256: P.sha256hex('hello'), mode: statSync(join(src, 'a.ts')).mode & 0o777 },
    { path: 'sub/b.ts', size: 6, sha256: P.sha256hex('world!'), mode: statSync(join(src, 'sub', 'b.ts')).mode & 0o777 },
  ])
  assert.equal(readFileSync(join(inDir, 'a.ts'), 'utf8'), 'hello')
  assert.equal(readFileSync(join(inDir, 'sub', 'b.ts'), 'utf8'), 'world!')
  // The source is read, never touched.
  assert.equal(readFileSync(join(src, 'a.ts'), 'utf8'), 'hello')
  assert.equal(statSync(join(src, 'a.ts')).mtimeMs, srcMtime)
  // The row's hash and size are the copy's on disk: a copier that alters the bytes changes them.
  const altering = async (fh, dest) => { await D.copyHandle(fh, dest); appendFileSync(dest, '!') }
  const altered = await D.stageDrop({ dir: world, dropId: 'cd'.repeat(8), files: files.slice(0, 1), copy: altering })
  assert.deepEqual([altered[0].size, altered[0].sha256], [6, P.sha256hex('hello!')])
})

await ok('stageDrop is idempotent per drop id, and re-copies a file that changed', async () => {
  const src = srcTree()
  const { files } = P.expandDropPaths([src], { roots: [src], ...D.dropFs })
  let copies = 0
  const copy = async (fh, dest) => { copies++; await D.copyHandle(fh, dest) }
  const dir = tmp()
  const dropId = 'ef'.repeat(8)
  const staged = join(dir, 'peer-staging', dropId, 'in', 'a.ts')
  const first = await D.stageDrop({ dir, dropId, files, copy })
  assert.equal(copies, 2)
  const ino = statSync(staged).ino
  const again = await D.stageDrop({ dir, dropId, files, copy })
  assert.equal(copies, 2, 'an already-staged file of the same size and sha is not copied again')
  assert.deepEqual(again, first)
  assert.equal(statSync(staged).ino, ino)
  // Same size, different bytes: only that file is copied again.
  writeFileSync(join(src, 'a.ts'), 'HELLO')
  const third = await D.stageDrop({ dir, dropId, files, copy })
  assert.equal(copies, 3)
  assert.equal(third[0].sha256, P.sha256hex('HELLO'))
  assert.deepEqual(third[1], first[1])
  assert.deepEqual(readdirSync(join(dir, 'peer-staging', dropId, 'tmp')), [], 'no partial copy is left behind')
})

await ok('stageDrop refuses a bad drop id, a bad row, and a file swapped for a link after validation', async () => {
  const src = srcTree()
  const outside = join(realpathSync(tmp()), 'secret')
  writeFileSync(outside, 'secret')
  symlinkSync(outside, join(src, 'link.ts'))
  const { files, refused } = P.expandDropPaths([src], { roots: [src], ...D.dropFs })
  // The real adapter sees a link as a link, and the walk names it.
  assert.deepEqual(files.map((f) => f.path), ['a.ts', 'sub/b.ts'])
  assert.deepEqual(refused.map((r) => r.path), [join(src, 'link.ts')])
  assert.match(refused[0].reason, /symlink/)
  const dir = tmp()
  for (const bad of ['nothex', '../../escape', 'AB'.repeat(8), 'ab'.repeat(40), 'abc', '', null]) {
    await assert.rejects(D.stageDrop({ dir, dropId: bad, files }), /drop id/, String(bad))
  }
  assert.equal(existsSync(join(dir, 'peer-staging')), false)
  for (const path of ['../../x', '/abs', 'a/../b', '']) {
    await assert.rejects(D.stageDrop({ dir, dropId: '34'.repeat(8), files: [{ ...files[0], path }] }), /row/, path)
  }
  // Validated as a file, then swapped for a link before the copy opened it.
  unlinkSync(join(src, 'sub', 'b.ts'))
  symlinkSync(outside, join(src, 'sub', 'b.ts'))
  await assert.rejects(D.stageDrop({ dir, dropId: '12'.repeat(8), files }), /symlink/)
  assert.equal(existsSync(join(dir, 'peer-staging', '12'.repeat(8), 'in', 'sub', 'b.ts')), false)
})

// ---- the filter script: its wire ------------------------------------------------
await ok('filterArgv is an array with the eight flags in order', () => {
  assert.deepEqual(P.filterArgv({
    filterPath: '/w/.claude/syzygy/peer-filter', direction: 'send', peer: 'vm',
    dropId: 'd1', inDir: '/s/d1/in', outDir: '/s/d1/out',
  }), ['/w/.claude/syzygy/peer-filter', '--direction', 'send', '--peer', 'vm',
       '--drop', 'd1', '--in', '/s/d1/in', '--out', '/s/d1/out'])
})

await ok('filterManifest is the stdin shape, one narrow row per file, and pure', () => {
  const files = [{ path: 'a.ts', size: 5, sha256: 'a'.repeat(64), mode: 0o644, abs: '/secret/a.ts', root: '/secret' }, 'junk']
  const m = P.filterManifest({ direction: 'send', peer: 'vm', dropId: 'd1', note: 'n', files })
  assert.deepEqual(m, { version: 1, direction: 'send', peer: 'vm', dropId: 'd1', note: 'n',
    files: [{ path: 'a.ts', size: 5, sha256: 'a'.repeat(64), mode: 0o644 }] })
  assert.equal(files[0].abs, '/secret/a.ts', 'the input rows are not touched')
  const bare = P.filterManifest({ direction: 'receive', peer: 'vm', dropId: 'd1', files: [{ path: 'b', size: 1 }] })
  assert.equal(bare.note, null)
  assert.deepEqual(bare.files, [{ path: 'b', size: 1, sha256: null, mode: null }])
  assert.deepEqual(P.filterManifest({ direction: 'send', peer: 'vm', dropId: 'd1' }).files, [])
})

await ok('a filter\'s printed manifest is shape-checked, and a listed path must stay inside --out', () => {
  assert.deepEqual(P.readFilterManifest(JSON.stringify({ version: 1, files: [{ path: 'a.ts', mode: 0o100644, sha256: 'lies' }, { path: '../x' }] })),
    [{ path: 'a.ts', mode: 0o644 }, { path: '../x', mode: null }])
  assert.deepEqual(P.readFilterManifest(JSON.stringify({ version: 1, direction: 'send', files: [] })), [])
  for (const bad of ['', 'not json', '[]', '{}', 'null', JSON.stringify({ version: 2, files: [] }), JSON.stringify({ files: [] }),
    JSON.stringify({ version: 1, files: {} }), JSON.stringify({ version: 1, files: [{ size: 1 }] }), JSON.stringify({ version: 1, files: ['a.ts'] }), null, 7]) {
    assert.equal(P.readFilterManifest(bad), null, String(bad))
  }
  assert.equal(P.filterOutPath('a.ts'), 'a.ts')
  assert.equal(P.filterOutPath('./sub//b.ts'), 'sub/b.ts')
  assert.equal(P.filterOutPath('sub/../a.ts'), 'a.ts')
  for (const bad of ['', '/etc/passwd', '.', '..', '../x', 'a/../../x', 'dir/', 'a' + String.fromCharCode(0) + 'b', null, 7,
    '.git/config', 'sub/.GIT/x', 'x'.repeat(300)]) {
    assert.equal(P.filterOutPath(bad), null, String(bad))
  }
})

await ok('a landing path is computed locally and never taken from the wire', () => {
  const ch = String.fromCharCode
  const seg200 = 's'.repeat(200)
  for (const bad of [
    '../../etc/passwd', '/etc/passwd', 'a/../../b', '.git/config', 'a/.git/b',
    'a//b', 'a/./b', '.', '..', '', 'x'.repeat(300), 'a/' + 'y'.repeat(300),
    // Past the list above: the drop root by another spelling, dot-only
    // segments, .git by case and by the spellings other filesystems fold to it.
    'a/..', './a', 'a/', '/', '//a', '...', 'a/..../b', '.GIT/config', 'a/.Git', 'a/.git./b', '.git' + ch(0x200c), 'sub/GIT~1/config',
    // A backslash, and control characters at the edges of the range.
    'a' + ch(92) + 'b', 'a' + ch(0) + 'b', 'a' + ch(1), ch(31) + 'a', 'a' + ch(127), 'a' + ch(10) + 'b', 'a' + ch(13),
    // Bytes, not characters: one 128-character segment of 256 bytes, and a
    // 4220-byte path whose every segment is short.
    ch(0xe9).repeat(128) + '/x', Array(21).fill(seg200).join('/'),
    // Not text a filesystem stores as written.
    ch(0xd800) + 'a', 'a' + ch(0xdfff),
  ]) assert.equal(P.sanitizeLandingPath(bad), null, JSON.stringify(bad) + ' must be refused')
  for (const bad of [null, undefined, 42, {}, ['a.ts'], true]) assert.equal(P.sanitizeLandingPath(bad), null, String(bad))
  for (const good of ['src/app/main.ts', 'a.ts', '.gitignore', '.github/workflows/ci.yml', 'a/.gitkeep', '...a', 'a..b', ch(0xe9),
    'y'.repeat(255), 'a b/c d.txt', Array(20).fill(seg200).join('/'), '~/x', 'git~2']) {
    assert.equal(P.sanitizeLandingPath(good), good, JSON.stringify(good))
  }
  // Normalised first: a decomposed accent lands as the composed one.
  assert.equal(P.sanitizeLandingPath('caf' + 'e' + ch(0x301) + '/x'), 'caf' + ch(0xe9) + '/x')
})

// ---- the filter script: a real child ------------------------------------------
const NL = String.fromCharCode(10)

/** Polls every 25 ms until `check` answers something truthy, and returns it. */
const until = async (label, check, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await check()
    if (got) return got
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const q = (s) => JSON.stringify(s)

/** The lines every filter script starts with: its two directories off the argv,
 *  the manifest off stdin, and a copy of every listed file from --in to --out. */
const PRELUDE = [
  "const fs = require('node:fs'), path = require('node:path')",
  "const arg = (k) => process.argv[process.argv.indexOf(k) + 1]",
  "const IN = arg('--in'), OUT = arg('--out')",
  "const read = () => JSON.parse(fs.readFileSync(0, 'utf8'))",
  "const copyAll = (m) => { for (const f of m.files) { fs.mkdirSync(path.dirname(path.join(OUT, f.path)), { recursive: true }); fs.copyFileSync(path.join(IN, f.path), path.join(OUT, f.path)) } }",
]
const ACCEPT = [...PRELUDE, 'const m = read()', 'copyAll(m)', 'process.stdout.write(JSON.stringify(m))']

/** Installs `lines` as WORLD_DIR/peer-filter, a node script with its own
 *  shebang, executable unless told otherwise. */
const writeFilter = (dir, lines, mode = 0o755) => {
  const file = join(dir, 'peer-filter')
  writeFileSync(file, ['#!' + process.execPath, ...lines].join(NL) + NL)
  chmodSync(file, mode)
  return file
}

/** A world dir, a source tree, a job store and an engine over them, started.
 *  The runner is the real spawn, recorded so the argv and the environment the
 *  engine handed it can be read back. */
const filterRig = ({ filter = null, opts = {} } = {}) => {
  const dir = realpathSync(tmp())
  const src = srcTree()
  const jobs = J.createJobsStore({ file: join(dir, 'peer-jobs.json') })
  if (filter) writeFilter(dir, filter)
  const spawned = []
  const logs = []
  const run = (bin, args, o) => { spawned.push({ argv: [bin, ...args], env: o?.env }); return spawn(bin, args, o) }
  const drops = D.createDrops({ dir, jobs, roots: () => [src], log: (m) => logs.push(m), run, filterTimeoutMs: 8000, killGraceMs: 150, ...opts })
  drops.start()
  return { dir, src, jobs, drops, spawned, logs }
}
const SETTLED = ['offering', 'refused', 'failed']
const settle = (rig, id) => until(`job ${id} to leave filtering`, () => {
  const j = rig.jobs.get(id)
  return j && SETTLED.includes(j.state) ? j : null
})
const dropOf = async (rig, extra = {}) => {
  const r = rig.drops.offer({ peer: 'vm', paths: [rig.src], ...extra })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  return settle(rig, r.json.id)
}
const onDisk = (rig, id) => JSON.parse(readFileSync(join(rig.dir, 'peer-jobs.json'), 'utf8')).items.find((e) => e.id === id)
const stagedRows = (src) => [
  { path: 'a.ts', size: 5, sha256: P.sha256hex('hello'), mode: statSync(join(src, 'a.ts')).mode & 0o777 },
  { path: 'sub/b.ts', size: 6, sha256: P.sha256hex('world!'), mode: statSync(join(src, 'sub', 'b.ts')).mode & 0o777 },
]

await ok('a filter that accepts: the literal argv and the manifest reach a real child with no SZG_ variable, and the job offers --out', async () => {
  const seen = join(realpathSync(tmp()), 'seen.json')
  process.env.SZG_FILTER_PROBE = 'must-not-reach-the-filter'
  let rig
  try {
    rig = filterRig({ filter: [...PRELUDE, 'const m = read()', 'copyAll(m)',
      `fs.writeFileSync(${q(seen)}, JSON.stringify({ argv: process.argv.slice(2), stdin: m, szg: Object.keys(process.env).filter((k) => k.startsWith('SZG_')) }))`,
      'process.stdout.write(JSON.stringify(m))'] })
    const job = await dropOf(rig, { note: 'for the vm' })
    assert.equal(job.state, 'offering', JSON.stringify(job))
    assert.equal(job.filtered, true)
    assert.equal(job.filterReason, null)
    assert.deepEqual(job.files, stagedRows(rig.src))
    assert.equal(job.bytes, 11)
    assert.equal(onDisk(rig, job.id).state, 'offering')

    const base = join(rig.dir, 'peer-staging', job.dropId)
    const argv = P.filterArgv({ filterPath: join(rig.dir, 'peer-filter'), direction: 'send', peer: 'vm', dropId: job.dropId, inDir: join(base, 'in'), outDir: join(base, 'out') })
    assert.equal(rig.spawned.length, 1)
    assert.deepEqual(rig.spawned[0].argv, argv)
    assert.deepEqual(Object.keys(rig.spawned[0].env).filter((k) => k.startsWith('SZG_')), [])
    const got = JSON.parse(readFileSync(seen, 'utf8'))
    assert.deepEqual(got.argv, argv.slice(1))
    assert.deepEqual(got.szg, [], 'the filter sees no SZG_ variable')
    assert.deepEqual(got.stdin, P.filterManifest({ direction: 'send', peer: 'vm', dropId: job.dropId, note: 'for the vm', files: stagedRows(rig.src) }))
    assert.equal(JSON.stringify(got.stdin).includes(rig.src), false, 'no source path reaches the filter')

    // The job records where its files came from; the payload never shows it.
    const more = rig.drops.offer({ peer: 'vm', paths: [rig.src] })
    assert.equal(rig.jobs.get(more.json.id).sources.length, 2)
    const shown = JSON.stringify(rig.drops.payload())
    assert.equal(shown.includes(rig.src), false, 'no source path is on the payload')
    assert.equal(shown.includes('"sources"'), false)
    await settle(rig, more.json.id)
  } finally {
    delete process.env.SZG_FILTER_PROBE
  }
})

await ok('any non-zero exit refuses: the reason is the stderr capped at 2 KB, --out is ignored, and a bad manifest refuses too', async () => {
  const rig = filterRig({ filter: [...PRELUDE, 'const m = read()', 'copyAll(m)',
    "fs.writeFileSync(path.join(OUT, 'extra.ts'), 'extra')",
    "m.files.push({ path: 'extra.ts' })",
    'process.stdout.write(JSON.stringify(m))',
    "process.stderr.write('x'.repeat(3000))",
    'process.exitCode = 1'] })
  const job = await dropOf(rig)
  assert.equal(job.state, 'refused')
  assert.equal(job.reason, 'x'.repeat(2048))
  assert.equal(job.filtered, true)
  assert.deepEqual(job.files.map((f) => f.path), ['a.ts', 'sub/b.ts'], 'nothing from --out reaches the job')
  assert.equal(onDisk(rig, job.id).state, 'refused')

  // A crash is a refusal too, and silence still names why.
  writeFilter(rig.dir, ['process.exit(3)'])
  const crashed = await dropOf(rig)
  assert.equal(crashed.state, 'refused')
  assert.match(crashed.reason, /code 3/)
  writeFilter(rig.dir, ["process.kill(process.pid, 'SIGHUP')", 'setInterval(() => {}, 1000)'])
  const killed = await dropOf(rig)
  assert.equal(killed.state, 'refused')
  assert.match(killed.reason, /SIGHUP/)

  // Exit 0 with no manifest a relay can read is the safe direction: refused.
  writeFilter(rig.dir, [...PRELUDE, 'copyAll(read())', "process.stdout.write('done, probably')"])
  const garbled = await dropOf(rig)
  assert.equal(garbled.state, 'refused')
  assert.equal(garbled.reason, 'the filter printed no valid manifest')
  writeFilter(rig.dir, [...PRELUDE, 'const m = read()', 'copyAll(m)', 'process.stdout.write(JSON.stringify({ ...m, version: 2 }))'])
  assert.equal((await dropOf(rig)).reason, 'the filter printed no valid manifest')
})

await ok('a filter that hangs: SIGTERM at the timeout, SIGKILL after the grace, and the job is failed, never lost', async () => {
  const rig = filterRig({ opts: { filterTimeoutMs: 200, killGraceMs: 150 } })
  const pidFile = join(rig.dir, 'filter.pid')
  const termFile = join(rig.dir, 'filter.term')
  const filter = writeFilter(rig.dir, [
    "if (process.argv.includes('--warm')) process.exit(0)",
    `process.on('SIGTERM', () => require('node:fs').appendFileSync(${q(termFile)}, 'TERM'))`,
    `require('node:fs').writeFileSync(${q(pidFile)}, String(process.pid))`,
    'setInterval(() => {}, 1000)'])
  // The first exec of a newly written executable can be held for a couple of
  // hundred ms while the OS assesses it -- longer than this timeout. Run it
  // once first, so the timeout measures the filter and not that.
  assert.equal(spawnSync(filter, ['--warm']).status, 0)
  const t0 = Date.now()
  const job = await dropOf(rig)
  assert.ok(Date.now() - t0 >= 350, 'the job waited out the timeout and the grace')
  assert.equal(job.state, 'failed')
  assert.match(job.error, /timed out/)
  assert.match(job.error, /200 ms/)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(readFileSync(termFile, 'utf8'), 'TERM', 'SIGTERM came first, and was ignored')
  await until('the filter to be gone', () => !alive(pid))
  assert.equal(onDisk(rig, job.id).state, 'failed')
  assert.equal(rig.spawned.length, 1, 'a slow filter is never retried')
  await until('the failed job\'s staged copy to be removed', () => !existsSync(join(rig.dir, 'peer-staging', job.dropId)))
})

await ok('a filter that writes outside --out, links out of it or lists what is not there: only real files under --out are offered', async () => {
  const rig = filterRig()
  const outside = join(realpathSync(tmp()), 'outside.ts')
  writeFileSync(outside, 'outside')
  writeFilter(rig.dir, [...PRELUDE, 'const m = read()', 'copyAll(m)',
    "fs.writeFileSync(path.join(OUT, '..', 'stray.ts'), 'stray')",
    `fs.symlinkSync(${q(outside)}, path.join(OUT, 'link.ts'))`,
    `fs.symlinkSync(${q(dirname(outside))}, path.join(OUT, 'linkdir'))`,
    "fs.writeFileSync(path.join(OUT, 'unlisted.ts'), 'unlisted')",
    "m.files.push({ path: '../stray.ts' }, { path: 'link.ts' }, { path: 'linkdir/outside.ts' }, { path: " + q(outside) + " },",
    "  { path: 'missing.ts' }, { path: './sub/../a.ts' }, { path: 'sub' })",
    'process.stdout.write(JSON.stringify(m))'])
  const job = await dropOf(rig)
  assert.equal(job.state, 'offering', JSON.stringify(job))
  assert.deepEqual(job.files, stagedRows(rig.src))
})

await ok('a filter that lies about a sha or a size: the relay hashes what is on disk, and the offer carries that', async () => {
  const rig = filterRig({ filter: [...PRELUDE, 'const m = read()', 'copyAll(m)',
    "fs.writeFileSync(path.join(OUT, 'a.ts'), 'HELLO, rewritten')",
    "for (const f of m.files) { f.sha256 = 'f'.repeat(64); f.size = 999 }",
    'process.stdout.write(JSON.stringify(m))'] })
  const job = await dropOf(rig)
  assert.equal(job.state, 'offering')
  assert.deepEqual(job.files.map((f) => [f.path, f.size, f.sha256]),
    [['a.ts', 16, P.sha256hex('HELLO, rewritten')], ['sub/b.ts', 6, P.sha256hex('world!')]])
  assert.equal(job.bytes, 22)
})

await ok('no filter, a filter that is not executable, or a directory: the drop passes through labelled, never an error', async () => {
  const rig = filterRig()
  const absent = await dropOf(rig)
  assert.equal(absent.state, 'offering')
  assert.equal(absent.filtered, false)
  assert.equal(absent.filterReason, 'no filter')
  assert.deepEqual(absent.files, stagedRows(rig.src))
  assert.equal(onDisk(rig, absent.id).filtered, false)

  const marker = join(rig.dir, 'ran')
  writeFilter(rig.dir, [`require('node:fs').writeFileSync(${q(marker)}, 'ran')`, 'process.exit(1)'], 0o644)
  const plain = await dropOf(rig)
  assert.deepEqual([plain.state, plain.filtered, plain.filterReason], ['offering', false, 'no filter'])
  unlinkSync(join(rig.dir, 'peer-filter'))
  mkdirSync(join(rig.dir, 'peer-filter'))
  const dirFilter = await dropOf(rig)
  assert.deepEqual([dirFilter.state, dirFilter.filtered, dirFilter.filterReason], ['offering', false, 'no filter'])
  assert.equal(existsSync(marker), false)
  assert.equal(rig.spawned.length, 0, 'no child was spawned')
})

await ok('what a filter leaves is held to both caps again, and a filter that leaves nothing refuses', async () => {
  const rig = filterRig({ opts: { byteCap: 100, fileCap: 2 } })
  writeFilter(rig.dir, [...PRELUDE, 'const m = read()', 'copyAll(m)',
    "fs.writeFileSync(path.join(OUT, 'big.ts'), 'b'.repeat(200))",
    "m.files = [m.files[0], { path: 'big.ts' }]",
    'process.stdout.write(JSON.stringify(m))'])
  const big = await dropOf(rig)
  assert.equal(big.state, 'refused')
  assert.match(big.reason, /too large/)
  writeFilter(rig.dir, [...PRELUDE, 'const m = read()', 'copyAll(m)',
    "fs.writeFileSync(path.join(OUT, 'c.ts'), 'c')",
    "m.files.push({ path: 'c.ts' })",
    'process.stdout.write(JSON.stringify(m))'])
  const many = await dropOf(rig)
  assert.equal(many.state, 'refused')
  assert.match(many.reason, /too many files/)
  writeFilter(rig.dir, [...PRELUDE, 'const m = read()', 'process.stdout.write(JSON.stringify({ ...m, files: [] }))'])
  const empty = await dropOf(rig)
  assert.equal(empty.state, 'refused')
  assert.match(empty.reason, /no files/)
})

await ok('one filter child at a time: two drops filter one after the other, and a cancel kills its child', async () => {
  const rig = filterRig()
  const log = join(rig.dir, 'order.log')
  writeFilter(rig.dir, [...PRELUDE, 'const m = read()',
    `fs.appendFileSync(${q(log)}, 'start ' + process.pid + String.fromCharCode(10))`,
    'copyAll(m)',
    `setTimeout(() => { fs.appendFileSync(${q(log)}, 'end ' + process.pid + String.fromCharCode(10)); process.stdout.write(JSON.stringify(m)) }, 150)`])
  const a = rig.drops.offer({ peer: 'vm', paths: [rig.src] })
  const b = rig.drops.offer({ peer: 'vm', paths: [rig.src] })
  const [ja, jb] = [await settle(rig, a.json.id), await settle(rig, b.json.id)]
  assert.deepEqual([ja.state, jb.state], ['offering', 'offering'])
  const order = readFileSync(log, 'utf8').trim().split(NL).map((l) => l.split(' '))
  assert.deepEqual(order.map(([what]) => what), ['start', 'end', 'start', 'end'])
  assert.equal(order[0][1], order[1][1]); assert.equal(order[2][1], order[3][1])

  const pidFile = join(rig.dir, 'hang.pid')
  writeFilter(rig.dir, [`require('node:fs').writeFileSync(${q(pidFile)}, String(process.pid))`, 'setInterval(() => {}, 1000)'])
  const c = rig.drops.offer({ peer: 'vm', paths: [rig.src] })
  await until('the hanging filter to start', () => existsSync(pidFile) && rig.jobs.get(c.json.id).state === 'filtering')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(rig.drops.cancel({ id: c.json.id }).status, 200)
  await until('the cancelled filter to be gone', () => !alive(pid))
  assert.deepEqual([rig.jobs.get(c.json.id).state, rig.jobs.get(c.json.id).error], ['failed', 'cancelled'])
  writeFilter(rig.dir, ACCEPT)
  assert.equal((await dropOf(rig)).state, 'offering', 'the queue is not held by a cancelled child')
  assert.deepEqual(rig.logs.filter((l) => /could not/.test(l)), [])
})

await ok('stop kills a running filter and leaves its jobs filtering on disk; at boot a finished stage is the drop, and only an unfinished one reads its sources', async () => {
  const rig = filterRig()
  const pidFile = join(rig.dir, 'hang.pid')
  writeFilter(rig.dir, ["process.on('SIGTERM', () => {})", `require('node:fs').writeFileSync(${q(pidFile)}, String(process.pid))`, 'setInterval(() => {}, 1000)'])
  const original = stagedRows(rig.src)
  // Two drops: one filter child runs, and the other waits its turn already
  // filtering on disk. Both stages have finished.
  const r1 = rig.drops.offer({ peer: 'vm', paths: [rig.src] })
  const r2 = rig.drops.offer({ peer: 'vm', paths: [rig.src] })
  await until('a filter to start with both drops filtering', () =>
    existsSync(pidFile) && rig.jobs.get(r1.json.id).state === 'filtering' && rig.jobs.get(r2.json.id).state === 'filtering')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  await rig.drops.stop()
  assert.equal(alive(pid), false, 'stop waited for the child, SIGKILL included')
  rig.jobs.flush()
  const frozen = onDisk(rig, r1.json.id)
  const broken = onDisk(rig, r2.json.id)
  for (const j of [frozen, broken]) {
    assert.deepEqual([j.state, j.staged], ['filtering', true])
    assert.equal(existsSync(join(rig.dir, 'peer-staging', j.dropId, 'in', 'a.ts')), true, 'a stopped job keeps its stage')
  }

  // While the relay is down: a source is edited, and the second drop's staged
  // copy is truncated.
  writeFileSync(join(rig.src, 'a.ts'), 'EDITED')
  writeFileSync(join(rig.dir, 'peer-staging', broken.dropId, 'in', 'sub', 'b.ts'), '')

  // Beside them: a queued job whose stage never finished (a stale partial copy
  // left behind), one whose source has gone, one with no sources recorded at
  // all, and one already offering.
  const st = J.createJobsStore({ file: join(rig.dir, 'peer-jobs.json') })
  const row = (p) => ({ path: p, abs: join(rig.src, p) })
  const queued = st.create({ peer: 'vm', side: 'send', files: [{ path: 'a.ts', size: 5 }], bytes: 5, sources: [row('a.ts')] })
  mkdirSync(join(rig.dir, 'peer-staging', queued.dropId, 'in'), { recursive: true })
  writeFileSync(join(rig.dir, 'peer-staging', queued.dropId, 'in', 'a.ts'), 'stale')
  const gone = st.create({ peer: 'vm', side: 'send', files: [{ path: 'gone.ts', size: 1 }], bytes: 1, sources: [row('gone.ts')] })
  const legacy = st.create({ peer: 'vm', side: 'send', files: [{ path: 'a.ts', size: 5 }], bytes: 5 })
  const offering = st.create({ peer: 'vm', side: 'send', files: [], bytes: 0, sources: [row('a.ts')] })
  st.transition(offering.id, 'filtering'); st.transition(offering.id, 'offering', { filtered: false, filterReason: 'no filter' })
  st.flush()
  assert.deepEqual([st.get(queued.id).sources, st.get(queued.id).staged], [[row('a.ts')], false])

  // The filter records the bytes it was handed for each drop.
  const seen = join(rig.dir, 'seen.log')
  writeFilter(rig.dir, [...PRELUDE, 'const m = read()',
    `fs.appendFileSync(${q(seen)}, arg('--drop') + ' ' + fs.readFileSync(path.join(IN, 'a.ts'), 'utf8') + String.fromCharCode(10))`,
    'copyAll(m)', 'process.stdout.write(JSON.stringify(m))'])
  const logs = []
  const again = { dir: rig.dir, src: rig.src, jobs: st, logs }
  again.drops = D.createDrops({ dir: rig.dir, jobs: st, roots: () => [rig.src], log: (m) => logs.push(m) })
  again.drops.start()
  const seenFor = (dropId) => readFileSync(seen, 'utf8').trim().split(NL).filter((l) => l.startsWith(dropId + ' ')).map((l) => l.slice(dropId.length + 1))

  // Staging had finished: the filter sees the original bytes, never the edit.
  const resumed = await settle(again, frozen.id)
  assert.equal(resumed.state, 'offering', JSON.stringify(resumed))
  assert.equal(resumed.filtered, true)
  assert.deepEqual(resumed.files, original)
  assert.deepEqual(seenFor(frozen.dropId), ['hello'])
  assert.deepEqual(resumed.sources, [], 'sources are dropped once the filter has run')

  // Staging had finished and the copy no longer matches: failed, naming the file, stage removed.
  const failedCopy = await settle(again, broken.id)
  assert.deepEqual([failedCopy.state, failedCopy.error], ['failed', 'the staged copy of sub/b.ts changed or is missing'])
  assert.deepEqual(existsSync(seen) ? seenFor(broken.dropId) : [], [], 'no filter ran over it')
  await until('the broken stage to be removed', () => !existsSync(join(rig.dir, 'peer-staging', broken.dropId)))

  // Staging never finished: staged from the sources as they are now.
  const requeued = await settle(again, queued.id)
  assert.equal(requeued.state, 'offering')
  assert.deepEqual(requeued.files.map((f) => [f.path, f.size, f.sha256]), [['a.ts', 6, P.sha256hex('EDITED')]])
  assert.deepEqual(seenFor(queued.dropId), ['EDITED'])

  const failed = await settle(again, gone.id)
  assert.equal(failed.state, 'failed')
  assert.match(failed.error, /gone\.ts/)
  assert.equal(failed.error.includes(rig.src), false, 'a failure names the file inside the drop, not where it lives')
  const noSources = await settle(again, legacy.id)
  assert.equal(noSources.state, 'failed')
  assert.match(noSources.error, /not recorded/)
  assert.equal(st.get(offering.id).state, 'offering')
  assert.ok(logs.some((l) => l.includes(offering.id) && /reoffer/.test(l)), 'a job this rung does not resume is logged')
  st.flush()
  assert.equal(onDisk(rig, frozen.id).state, 'offering')
})

await ok('a refused, failed or cancelled send job leaves no staged copy, and a sibling drop\'s is untouched', async () => {
  const rig = filterRig()
  const stageOf = (id) => join(rig.dir, 'peer-staging', rig.jobs.get(id).dropId)
  const sibling = await dropOf(rig)
  assert.equal(sibling.state, 'offering')

  writeFilter(rig.dir, ["process.stderr.write('no')", 'process.exit(1)'])
  const refused = await dropOf(rig)
  assert.equal(refused.state, 'refused')
  await until('the refused job\'s stage to be removed', () => !existsSync(stageOf(refused.id)))

  const pidFile = join(rig.dir, 'hang.pid')
  writeFilter(rig.dir, ["process.on('SIGTERM', () => {})", `require('node:fs').writeFileSync(${q(pidFile)}, String(process.pid))`, 'setInterval(() => {}, 1000)'])
  const running = rig.drops.offer({ peer: 'vm', paths: [rig.src] })
  await until('the filter to start', () => existsSync(pidFile) && rig.jobs.get(running.json.id).state === 'filtering')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(rig.drops.cancel({ id: running.json.id }).status, 200)
  assert.equal(existsSync(stageOf(running.json.id)), true, 'the stage stays while the child reading it is alive')
  await until('the cancelled child to be gone and its stage removed', () => !alive(pid) && !existsSync(stageOf(running.json.id)))

  // A job cancelled after it has left filtering loses its stage at once.
  unlinkSync(join(rig.dir, 'peer-filter'))
  const offered = await dropOf(rig)
  assert.equal(rig.drops.cancel({ id: offered.id }).status, 200)
  await until('the cancelled offer\'s stage to be removed', () => !existsSync(stageOf(offered.id)))

  assert.equal(readFileSync(join(stageOf(sibling.id), 'in', 'a.ts'), 'utf8'), 'hello', 'a sibling drop keeps its stage')
})

await ok('removeStaging removes one drop id\'s directory and nothing else', async () => {
  const dir = realpathSync(tmp())
  const target = realpathSync(tmp())
  writeFileSync(join(target, 'keep.ts'), 'keep')
  mkdirSync(join(dir, 'peer-staging'))
  const id = 'ab'.repeat(8)
  symlinkSync(target, join(dir, 'peer-staging', id))
  for (const bad of ['..', '../..', '', 'AB'.repeat(8), 'ab'.repeat(8) + '/..', null]) {
    assert.equal(await D.removeStaging({ dir, dropId: bad }), false, String(bad))
  }
  assert.equal(await D.removeStaging({ dir: 'relative', dropId: id }), false)
  assert.equal(existsSync(join(dir, 'peer-staging', id)), true)
  assert.equal(await D.removeStaging({ dir, dropId: id }), true)
  assert.equal(existsSync(join(dir, 'peer-staging', id)), false)
  assert.equal(existsSync(join(dir, 'peer-staging')), true)
  assert.equal(readFileSync(join(target, 'keep.ts'), 'utf8'), 'keep', 'a link in its place is removed, never followed')
})

await ok('the dry run runs the send filter over a throwaway stage, answers its manifest and stderr, and leaves no job and no stage', async () => {
  const rig = filterRig({ filter: [...PRELUDE, 'const m = read()', 'copyAll(m)', "process.stderr.write('scrubbed 0 secrets')", 'process.stdout.write(JSON.stringify(m))'] })
  const staging = join(rig.dir, 'peer-staging')
  const r = await rig.drops.filterTest({ peer: 'vm', paths: [rig.src] })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.filtered, true)
  assert.equal(r.json.stderr, 'scrubbed 0 secrets')
  assert.deepEqual(r.json.refused, [])
  assert.equal(r.json.manifest.version, 1)
  assert.equal(r.json.manifest.direction, 'send')
  assert.deepEqual(r.json.manifest.files, stagedRows(rig.src))
  assert.equal(rig.spawned.length, 1)
  assert.deepEqual(rig.jobs.all(), [], 'no job is created')
  assert.equal(existsSync(join(rig.dir, 'peer-jobs.json')), false, 'nothing was written to the job store')
  assert.deepEqual(existsSync(staging) ? readdirSync(staging) : [], [], 'the throwaway stage is removed')

  writeFilter(rig.dir, ["process.stderr.write('refusing: a .env file')", 'process.exit(2)'])
  const refused = await rig.drops.filterTest({ peer: 'vm', paths: [rig.src] })
  assert.equal(refused.status, 200)
  assert.deepEqual([refused.json.ok, refused.json.manifest, refused.json.stderr, refused.json.reason],
    [false, null, 'refusing: a .env file', 'refusing: a .env file'])
  assert.equal((await rig.drops.filterTest({ peer: 'vm', paths: 'nope' })).status, 400)
  assert.equal((await rig.drops.filterTest({ peer: 'Not A Name', paths: [rig.src] })).status, 400)
  assert.deepEqual(rig.jobs.all(), [])
  assert.deepEqual(existsSync(staging) ? readdirSync(staging) : [], [])
})

// ---- the transport: a pushed drop ------------------------------------------------
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const rowOf = (path, buf) => ({ path, size: buf.length, sha256: P.sha256hex(buf), mode: 0o644 })
const chunkQuery = (dropId, file, offset) => `drop=${dropId}&file=${file}&offset=${offset}`
const DIALLED = { confirmed: true, dials: false }
const DIALS = { confirmed: true, dials: true }

/** The receiving end of a drop, in a temp world dir: a job store and an engine
 *  that knows the peers named in `peers`. */
const recvRig = ({ peers = { vm: DIALLED }, opts = {} } = {}) => {
  const dir = realpathSync(tmp())
  const jobs = J.createJobsStore({ file: join(dir, 'peer-jobs.json') })
  const logs = []
  const drops = D.createDrops({ dir, jobs, log: (m) => logs.push(m), peerOf: (n) => peers[n] ?? null, ...opts })
  drops.start()
  return { dir, jobs, drops, logs }
}
const quarantineOf = (rig, peer, dropId) => join(rig.dir, 'peer-quarantine', peer, dropId)
const partOf = (rig, peer, dropId, idx) => join(quarantineOf(rig, peer, dropId), 'files', String(idx))
const lengthOf = (file) => (existsSync(file) ? statSync(file).size : 0)
const recvJobOf = (rig, dropId) => rig.jobs.all().find((e) => e.side === 'recv' && e.dropId === dropId) ?? null

const ROUTE_OF = {
  '/peer/drop/offer': 'onOffer', '/peer/drop/chunk': 'onChunk', '/peer/drop/commit': 'onCommit',
  '/peer/drop/manifest': 'onManifest', '/peer/drop/pull': 'onPull',
}
/** A dial that reaches another engine's handlers directly, as the peer named
 *  `as`, shaped the way the listener hands a request over and dialPeer answers:
 *  a JSON body round-tripped, a raw body as its own Buffer, null as the 404.
 *  `net.cut(call)` drops a call before it arrives, `net.lose(call)` lets it
 *  arrive and loses the answer, and `net.rewrite(call, json)` alters an answer. */
const wire = (target, as, net) => async ({ path, query = '', body, rawBody, rawResponse }) => {
  const call = { path, query, body: body === undefined ? null : JSON.parse(JSON.stringify(body)), bytes: Buffer.isBuffer(rawBody) ? rawBody.length : null }
  net.calls.push(call)
  const down = rawResponse ? { ok: false, status: 0, buf: null, error: 'ECONNRESET' } : { ok: false, status: 0, json: null, error: 'ECONNRESET' }
  if (net.cut?.(call)) return down
  const r = await target()[ROUTE_OF[path]]({ peer: as, query, body: Buffer.isBuffer(rawBody) ? Buffer.from(rawBody) : call.body })
  if (net.lose?.(call)) return down
  if (!r) return rawResponse ? { ok: false, status: 404, buf: null, error: 'HTTP 404' } : { ok: false, status: 404, json: null, error: 'HTTP 404' }
  if (rawResponse) return Buffer.isBuffer(r.raw) ? { ok: true, status: 200, buf: Buffer.from(r.raw) } : { ok: false, status: 0, buf: null, error: 'not raw' }
  const json = JSON.parse(JSON.stringify(r.json))
  return { ok: true, status: 200, json: net.rewrite ? net.rewrite(call, json) : json }
}
const routes = (net) => net.calls.map((c) => [c.path, c.query])

await ok('a pushed chunk appends only at the receiver\'s own offset; any other offset writes nothing and answers the real one', async () => {
  const rig = recvRig()
  const A = Buffer.from('hello world')
  const B = randomBytes(3000)
  const dropId = 'ab'.repeat(8)
  const manifest = { dropId, note: 'for you', files: [rowOf('a.ts', A), rowOf('dir/b.bin', B)] }

  assert.deepEqual(await rig.drops.onOffer({ peer: 'vm', body: manifest }), { status: 200, json: { accept: true, have: { 0: 0, 1: 0 } } })
  const job = recvJobOf(rig, dropId)
  assert.deepEqual([job.peer, job.state, job.bytes, job.files.length, job.note], ['vm', 'receiving', A.length + B.length, 2, 'for you'])
  assert.equal(existsSync(join(quarantineOf(rig, 'vm', dropId), 'files')), true)
  const part = partOf(rig, 'vm', dropId, 1)
  const chunk = (file, offset, body, peer = 'vm') => rig.drops.onChunk({ peer, query: chunkQuery(dropId, file, offset), body })

  assert.deepEqual(await chunk(1, 0, B.subarray(0, 1000)), { status: 200, json: { offset: 1000, appended: true } })
  assert.deepEqual((await chunk(1, 0, B.subarray(0, 1000))).json, { offset: 1000, appended: false }, 'the same chunk twice')
  assert.equal(lengthOf(part), 1000)
  for (const off of [0, 999, 1001, 5000]) {
    assert.deepEqual((await chunk(1, off, B.subarray(1000, 2000))).json, { offset: 1000, appended: false }, `offset ${off}`)
    assert.equal(lengthOf(part), 1000, `offset ${off} wrote nothing`)
  }
  // Two copies of one chunk arriving together still land once.
  const both = await Promise.all([chunk(1, 1000, B.subarray(1000, 2000)), chunk(1, 1000, B.subarray(1000, 2000))])
  assert.deepEqual(both.map((r) => r.json.appended).sort(), [false, true])
  assert.equal(lengthOf(part), 2000)
  assert.equal(Buffer.compare(readFileSync(part), B.subarray(0, 2000)), 0)
  assert.equal(rig.jobs.get(job.id).sent, 2000)

  // Offered again, the receiver says what it has, per file, and keeps one job.
  assert.deepEqual((await rig.drops.onOffer({ peer: 'vm', body: manifest })).json, { accept: true, have: { 0: 0, 1: 2000 } })
  assert.equal(rig.jobs.all().filter((e) => e.dropId === dropId).length, 1)

  // A malformed query, an unknown file, another peer, an empty chunk or one past the file's size is the 404.
  for (const q of ['', `drop=${dropId}&file=1`, `drop=${dropId}&file=1&offset=-1`, `drop=${dropId}&file=01&offset=2000`,
    `drop=${dropId}&file=1&offset=2e3`, `drop=${dropId}&file=2&offset=0`, `drop=${'AB'.repeat(8)}&file=1&offset=2000`,
    `drop=${dropId}&file=1&offset=2000&offset=2000`, `drop=${dropId}&file=1&offset=2000&x=1`]) {
    assert.equal(await rig.drops.onChunk({ peer: 'vm', query: q, body: Buffer.from('x') }), null, q)
  }
  assert.equal(await chunk(1, 2000, Buffer.from('x'), 'other'), null)
  assert.equal(await chunk(1, 2000, Buffer.alloc(0)), null)
  assert.equal(await chunk(0, 0, Buffer.alloc(A.length + 1)), null)
  assert.equal(await chunk(1, 2000, 'not bytes'), null)
  assert.equal(lengthOf(partOf(rig, 'vm', dropId, 0)), 0)
  assert.equal(lengthOf(part), 2000)
})

await ok('an offer is refused with a reason and creates nothing: an unconfirmed peer, either cap, no files, a malformed row, a drop id held elsewhere', async () => {
  const rig = recvRig({ peers: { vm: DIALLED, pending: { confirmed: false, dials: false }, other: DIALLED }, opts: { fileCap: 2, byteCap: 100 } })
  const refusedFor = async (peer, body) => {
    const r = await rig.drops.onOffer({ peer, body })
    assert.equal(r?.status, 200, JSON.stringify(r)); assert.equal(r.json.accept, false); assert.equal(typeof r.json.reason, 'string')
    return r.json.reason
  }
  const id = (c) => c.repeat(16)
  const small = rowOf('a.ts', Buffer.from('hi'))
  assert.match(await refusedFor('pending', { dropId: id('1'), files: [small] }), /confirm/)
  assert.match(await refusedFor('vm', { dropId: id('2'), files: [small, small, small] }), /too many files/)
  assert.match(await refusedFor('vm', { dropId: id('3'), files: [{ ...small, size: 101 }] }), /too large/)
  assert.match(await refusedFor('vm', { dropId: id('4'), files: [] }), /no files/)
  for (const bad of [{ ...small, sha256: 'A'.repeat(64) }, { ...small, sha256: null }, { ...small, size: -1 }, { ...small, size: 1.5 },
    { ...small, path: '' }, { ...small, path: 'x'.repeat(4097) }, { ...small, path: 'é'.repeat(2049) }, { ...small, mode: '644' }, null, 'a.ts']) {
    assert.match(await refusedFor('vm', { dropId: id('5'), files: [bad] }), /malformed/, JSON.stringify(bad))
  }
  assert.match(await refusedFor('vm', { dropId: id('5'), files: 'a.ts' }), /malformed/)
  assert.equal(await rig.drops.onOffer({ peer: 'vm', body: { dropId: 'nope', files: [small] } }), null)
  assert.equal(await rig.drops.onOffer({ peer: 'nobody', body: { dropId: id('6'), files: [small] } }), null)
  assert.deepEqual(rig.jobs.all(), [])
  assert.equal(existsSync(join(rig.dir, 'peer-quarantine')), false)

  assert.equal((await rig.drops.onOffer({ peer: 'vm', body: { dropId: id('7'), files: [small] } })).json.accept, true)
  assert.match(await refusedFor('other', { dropId: id('7'), files: [small] }), /already/)
  assert.match(await refusedFor('vm', { dropId: id('7'), files: [rowOf('a.ts', Buffer.from('ho'))] }), /changed/)
  assert.equal(rig.jobs.all().length, 1)
})

await ok('commit checks every file by sha256: short answers have, a first mismatch is asked for again, a second fails naming the file; a match answers before the receive filter, and then lands', async () => {
  const rig = recvRig()
  // A receive filter that waits to be released, so the drop is seen resting in filtering.
  const release = join(rig.dir, 'release')
  writeFilter(rig.dir, [...PRELUDE, 'const m = read()',
    `const go = () => { if (!fs.existsSync(${q(release)})) return setTimeout(go, 20); copyAll(m); process.stdout.write(JSON.stringify(m)) }`, 'go()'])
  const A = Buffer.from('alpha')
  const B = Buffer.from('bravo bytes')
  const dropId = 'cd'.repeat(8)
  await rig.drops.onOffer({ peer: 'vm', body: { dropId, files: [rowOf('a.ts', A), rowOf('b.ts', B)] } })
  const chunk = (d, file, offset, body) => rig.drops.onChunk({ peer: 'vm', query: chunkQuery(d, file, offset), body })
  const commit = (d, peer = 'vm') => rig.drops.onCommit({ peer, body: { dropId: d } })
  const job = recvJobOf(rig, dropId)

  await chunk(dropId, 0, 0, A)
  assert.deepEqual(await commit(dropId), { status: 200, json: { ok: false, have: { 0: 5, 1: 0 } } })
  await chunk(dropId, 1, 0, Buffer.from('BRAVO BYTES'))
  assert.deepEqual((await commit(dropId)).json, { ok: false, have: { 0: 5, 1: 0 } }, 'the wrong bytes are asked for again')
  assert.equal(existsSync(partOf(rig, 'vm', dropId, 1)), false)
  assert.deepEqual([rig.jobs.get(job.id).state, rig.jobs.get(job.id).retried], ['receiving', [1]])
  await chunk(dropId, 1, 0, B)
  assert.deepEqual((await commit(dropId)).json, { ok: true })
  assert.equal(rig.jobs.get(job.id).state, 'filtering')
  assert.equal(rig.jobs.get(job.id).sent, A.length + B.length)
  assert.deepEqual(readdirSync(join(quarantineOf(rig, 'vm', dropId), 'files')).sort(), ['0', '1'], 'held by index, never by the sender\'s path')
  assert.equal(readFileSync(partOf(rig, 'vm', dropId, 1), 'utf8'), 'bravo bytes')
  assert.deepEqual((await commit(dropId)).json, { ok: true }, 'a repeated commit moves nothing')
  assert.equal(rig.jobs.get(job.id).state, 'filtering')
  assert.equal(JSON.parse(readFileSync(join(rig.dir, 'peer-jobs.json'), 'utf8')).items.find((e) => e.id === job.id).state, 'filtering')
  assert.equal(await commit(dropId, 'other'), null)
  assert.equal(await commit('ef'.repeat(8)), null)
  await until('the drop to be laid out for the receive filter', () => existsSync(join(quarantineOf(rig, 'vm', dropId), 'in', 'b.ts')))
  assert.equal(rig.jobs.get(job.id).state, 'filtering')

  const twice = 'ef'.repeat(8)
  await rig.drops.onOffer({ peer: 'vm', body: { dropId: twice, files: [rowOf('dir/a.ts', A)] } })
  await chunk(twice, 0, 0, Buffer.from('ALPHA'))
  assert.deepEqual((await commit(twice)).json, { ok: false, have: { 0: 0 } })
  await chunk(twice, 0, 0, Buffer.from('ALPHA'))
  const failed = (await commit(twice)).json
  assert.equal(failed.ok, false); assert.match(failed.error, /dir\/a\.ts/)
  const failedJob = recvJobOf(rig, twice)
  assert.equal(failedJob.state, 'failed'); assert.match(failedJob.error, /dir\/a\.ts/); assert.match(failedJob.error, /sha256/)
  await until('the failed drop\'s quarantine to be removed', () => !existsSync(quarantineOf(rig, 'vm', twice)))
  assert.equal(existsSync(quarantineOf(rig, 'vm', dropId)), true, 'a sibling drop keeps its quarantine')
  const reoffered = await rig.drops.onOffer({ peer: 'vm', body: { dropId: twice, files: [rowOf('dir/a.ts', A)] } })
  assert.equal(reoffered.json.accept, false); assert.match(reoffered.json.reason, /dir\/a\.ts/)

  writeFileSync(release, '')
  await until('the released drop to land', () => rig.jobs.get(job.id).state === 'landed')
  assert.equal(readFileSync(join(rig.dir, 'peer-inbox', 'vm', dropId, 'b.ts'), 'utf8'), 'bravo bytes')
  assert.deepEqual((await commit(dropId)).json, { ok: true }, 'a commit after landing moves nothing')
  await until("the landed drop's quarantine to be removed", () => !existsSync(quarantineOf(rig, 'vm', dropId)))
})

await ok('removeQuarantine removes one peer\'s drop directory and nothing else, and never walks a link', async () => {
  const dir = realpathSync(tmp())
  const target = realpathSync(tmp())
  const id = 'ab'.repeat(8)
  mkdirSync(join(target, id))
  writeFileSync(join(target, id, 'keep'), 'keep')
  mkdirSync(join(dir, 'peer-quarantine', 'vm', id, 'files'), { recursive: true })
  mkdirSync(join(dir, 'peer-quarantine', 'vm', 'cd'.repeat(8)))
  for (const [peer, dropId] of [['vm', '..'], ['..', id], ['VM', id], ['vm/x', id], ['vm', 'AB'.repeat(8)], [null, id], ['vm', null]]) {
    assert.equal(await D.removeQuarantine({ dir, peer, dropId }), false, `${peer} ${dropId}`)
  }
  assert.equal(await D.removeQuarantine({ dir: 'relative', peer: 'vm', dropId: id }), false)
  assert.equal(existsSync(join(dir, 'peer-quarantine', 'vm', id)), true)
  assert.equal(await D.removeQuarantine({ dir, peer: 'vm', dropId: id }), true)
  assert.equal(existsSync(join(dir, 'peer-quarantine', 'vm', id)), false)
  assert.equal(existsSync(join(dir, 'peer-quarantine', 'vm', 'cd'.repeat(8))), true)
  symlinkSync(target, join(dir, 'peer-quarantine', 'evil'))
  assert.equal(await D.removeQuarantine({ dir, peer: 'evil', dropId: id }), false)
  assert.equal(readFileSync(join(target, id, 'keep'), 'utf8'), 'keep', 'a linked peer directory is never walked through')
  assert.equal(await D.removeQuarantine({ dir, peer: 'nobody', dropId: id }), true, 'nothing there is nothing to remove')
})

await ok('the dialler pushes: offer, chunks at the receiver\'s offset, commit, sent; a cut leaves the job where it was, and a resume sends only what is missing', async () => {
  const host = recvRig()
  const net = { calls: [] }
  let chunks = 0
  net.cut = (c) => c.path === '/peer/drop/chunk' && ++chunks === 3
  const vm = filterRig({ opts: { peerOf: (n) => (n === 'host' ? DIALS : null), dial: wire(() => host.drops, 'vm', net), chunkBytes: 4 } })
  const r = vm.drops.offer({ peer: 'host', paths: [vm.src] })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const id = r.json.id
  await until('the push to reach the cut', () => chunks >= 3)
  await pause(100)
  const d = vm.jobs.get(id).dropId
  assert.equal(vm.jobs.get(id).state, 'sending')
  const recv = recvJobOf(host, d)
  assert.equal(recv.state, 'receiving')
  assert.deepEqual(routes(net), [['/peer/drop/offer', ''], ['/peer/drop/chunk', chunkQuery(d, 0, 0)], ['/peer/drop/chunk', chunkQuery(d, 0, 4)], ['/peer/drop/chunk', chunkQuery(d, 1, 0)]])
  assert.deepEqual(net.calls[0].body.files, stagedRows(vm.src), 'the offer is the manifest, and names no source path')
  assert.equal(readFileSync(partOf(host, 'vm', d, 0), 'utf8'), 'hello')
  assert.equal(lengthOf(partOf(host, 'vm', d, 1)), 0)

  // The next offer's `have` is stale: the receiver's answer to a chunk puts the sender right.
  net.cut = null
  net.calls.length = 0
  net.rewrite = (c, json) => (c.path === '/peer/drop/offer' ? { ...json, have: {} } : json)
  vm.drops.resumeFor('host')
  const done = await until('the push to finish', () => vm.jobs.get(id).state === 'sent' && vm.jobs.get(id))
  assert.deepEqual(routes(net), [
    ['/peer/drop/offer', ''],
    ['/peer/drop/chunk', chunkQuery(d, 0, 0)],
    ['/peer/drop/chunk', chunkQuery(d, 1, 0)],
    ['/peer/drop/chunk', chunkQuery(d, 1, 4)],
    ['/peer/drop/commit', ''],
  ])
  assert.equal(done.sent, 11)
  await until('the pushed drop to land', () => host.jobs.get(recv.id).state === 'landed')
  assert.equal(readFileSync(join(host.dir, 'peer-inbox', 'vm', d, 'sub', 'b.ts'), 'utf8'), 'world!')
  await until('the sent drop\'s staged copy to be removed', () => !existsSync(join(vm.dir, 'peer-staging', d)))
})

await ok('at boot a sending job resumes when its peer dials and waits when it does not; a refused offer refuses the sender with the receiver\'s reason', async () => {
  const host = recvRig()
  const net = { calls: [] }
  let chunks = 0
  net.cut = (c) => c.path === '/peer/drop/chunk' && ++chunks === 2
  const dial = wire(() => host.drops, 'vm', net)
  const vm = filterRig({ opts: { peerOf: (n) => (n === 'host' ? DIALS : null), dial, chunkBytes: 4 } })
  const id = vm.drops.offer({ peer: 'host', paths: [vm.src] }).json.id
  await until('the push to reach the cut', () => chunks >= 2)
  await pause(100)
  await vm.drops.stop()
  vm.jobs.flush()
  net.cut = null
  const d = vm.jobs.get(id).dropId

  const store = J.createJobsStore({ file: join(vm.dir, 'peer-jobs.json') })
  assert.equal(store.get(id).state, 'sending')
  const before = net.calls.length
  const quietLogs = []
  const quiet = D.createDrops({ dir: vm.dir, jobs: store, roots: () => [vm.src], log: (m) => quietLogs.push(m), peerOf: () => DIALLED, dial, chunkBytes: 4 })
  quiet.start()
  await pause(100)
  assert.equal(net.calls.length, before, 'a side that does not dial never dials')
  assert.equal(store.get(id).state, 'sending')
  assert.ok(quietLogs.some((l) => l.includes(id)))
  await quiet.stop()

  const again = D.createDrops({ dir: vm.dir, jobs: store, roots: () => [vm.src], log: () => {}, peerOf: (n) => (n === 'host' ? DIALS : null), dial, chunkBytes: 4 })
  again.start()
  await until('the resumed push to finish', () => store.get(id).state === 'sent')
  await until('the resumed drop to land', () => recvJobOf(host, d)?.state === 'landed')
  assert.equal(readFileSync(join(host.dir, 'peer-inbox', 'vm', d, 'a.ts'), 'utf8'), 'hello')
  assert.equal(readFileSync(join(host.dir, 'peer-inbox', 'vm', d, 'sub', 'b.ts'), 'utf8'), 'world!')
  assert.equal(net.calls.filter((c) => c.path === '/peer/drop/chunk' && c.query === chunkQuery(d, 0, 0)).length, 1, 'what arrived is never sent again')

  // A receiver that refuses: the sender's job is refused with its reason, and its stage removed.
  const small = recvRig({ opts: { byteCap: 3 } })
  const refusing = filterRig({ opts: { peerOf: () => DIALS, dial: wire(() => small.drops, 'vm', { calls: [] }) } })
  const rid = refusing.drops.offer({ peer: 'host', paths: [refusing.src] }).json.id
  const refused = await until('the refused offer', () => refusing.jobs.get(rid).state === 'refused' && refusing.jobs.get(rid))
  assert.match(refused.reason, /too large/)
  assert.deepEqual(small.jobs.all(), [])
  await until('the refused drop\'s stage to be removed', () => !existsSync(join(refusing.dir, 'peer-staging', refused.dropId)))

  // A sender that does not dial never pushes: its drop rests in offering.
  let dialled = 0
  const resting = filterRig({ opts: { peerOf: () => DIALLED, dial: () => { dialled++; return { ok: false, status: 0 } } } })
  assert.equal((await dropOf(resting)).state, 'offering')
  await pause(100)
  assert.equal(dialled, 0, 'a dialled side never dials')
})

await ok('a file that fails its sha256 twice fails the receiver naming the file, and the sender with it', async () => {
  const host = recvRig()
  const net = { calls: [], cut: (c) => c.path === '/peer/drop/offer' }
  const vm = filterRig({ opts: { peerOf: () => DIALS, dial: wire(() => host.drops, 'vm', net) } })
  const id = vm.drops.offer({ peer: 'host', paths: [vm.src] }).json.id
  await until('the first offer to be cut', () => net.calls.length === 1 && vm.jobs.get(id).state === 'offering')
  // The staged copy is damaged after its hash was taken: same length, other bytes.
  const d = vm.jobs.get(id).dropId
  writeFileSync(join(vm.dir, 'peer-staging', d, 'in', 'sub', 'b.ts'), 'WORLD!')
  net.cut = null
  vm.drops.resumeFor('host')
  const failed = await until('the sender to fail', () => vm.jobs.get(id).state === 'failed' && vm.jobs.get(id))
  assert.match(failed.error, /sub\/b\.ts/)
  const recv = recvJobOf(host, d)
  assert.equal(recv.state, 'failed'); assert.match(recv.error, /sub\/b\.ts/)
  assert.equal(net.calls.filter((c) => c.path === '/peer/drop/commit').length, 2)
  await until('both sides to keep no copy', () => !existsSync(quarantineOf(host, 'vm', d)) && !existsSync(join(vm.dir, 'peer-staging', d)))
})

// ---- the transport: a pulled drop, and what each side hears of the other -----------

await ok('a dialled sender rests in offering and advertises counts only; its manifest and its bytes answer only the peer they are for', async () => {
  const BIG = randomBytes(D.CHUNK_BYTES + 12345)
  const X = filterRig({ opts: { peerOf: (n) => ({ vm: DIALLED, other: DIALLED, dialler: DIALS })[n] ?? null } })
  writeFileSync(join(X.src, 'big.bin'), BIG)
  const job = await dropOf(X, { note: 'pull me' })
  assert.equal(job.state, 'offering')
  const d = job.dropId
  const [delta, ...more] = X.drops.jobDeltasFor('vm')
  assert.deepEqual(more, [])
  assert.equal(typeof delta.at, 'number')
  assert.deepEqual({ ...delta, at: 0 }, { dropId: d, side: 'send', state: 'offering', files: 3, bytes: job.bytes, sent: 0, reason: null, at: 0 })
  for (const leak of ['a.ts', 'big.bin', 'sha256', 'pull me', X.src]) assert.equal(JSON.stringify(X.drops.jobDeltasFor('vm')).includes(leak), false, leak)
  assert.deepEqual(X.drops.jobDeltasFor('other'), [])

  const manifest = await X.drops.onManifest({ peer: 'vm', body: { dropId: d } })
  assert.deepEqual(manifest, { status: 200, json: { dropId: d, note: 'pull me', files: job.files.map(({ path, size, sha256, mode }) => ({ path, size, sha256, mode })) } })
  for (const [peer, body] of [['other', { dropId: d }], ['nobody', { dropId: d }], ['vm', { dropId: 'ef'.repeat(8) }], ['vm', {}], ['vm', { dropId: d.toUpperCase() }]]) {
    assert.equal(await X.drops.onManifest({ peer, body }), null, `${peer} ${JSON.stringify(body)}`)
  }

  const big = job.files.findIndex((f) => f.path === 'big.bin')
  const pull = (body, peer = 'vm') => X.drops.onPull({ peer, body: { dropId: d, ...body } })
  const head = await pull({ file: big, offset: 0 })
  assert.equal(head.status, 200)
  assert.equal(Buffer.compare(head.raw, BIG.subarray(0, D.CHUNK_BYTES)), 0, 'at most one chunk')
  assert.equal(Buffer.compare((await pull({ file: big, offset: D.CHUNK_BYTES })).raw, BIG.subarray(D.CHUNK_BYTES)), 0)
  assert.equal((await pull({ file: big, offset: BIG.length })).raw.length, 0, 'at the end, nothing more')
  for (const body of [{ file: job.files.length, offset: 0 }, { file: big, offset: BIG.length + 1 }, { file: -1, offset: 0 }, { file: String(big), offset: 0 }, { file: big, offset: 1.5 }]) {
    assert.equal(await pull(body), null, JSON.stringify(body))
  }
  assert.equal(await pull({ file: big, offset: 0 }, 'other'), null)

  // A peer this side dials is pushed to, never pulled by; and an ended job answers nobody.
  const toDialler = X.drops.offer({ peer: 'dialler', paths: [X.src] })
  const dj = await settle(X, toDialler.json.id)
  assert.equal(await X.drops.onManifest({ peer: 'dialler', body: { dropId: dj.dropId } }), null)
  assert.equal(X.drops.cancel({ id: job.id }).status, 200)
  assert.equal(await X.drops.onManifest({ peer: 'vm', body: { dropId: d } }), null)
  assert.equal(await pull({ file: 0, offset: 0 }), null)
})

await ok('the dialler, told of a drop it has no job for, fetches the manifest and pulls; interrupted, it continues each file from its own partial length; the sender follows on the deltas', async () => {
  const X = filterRig({ opts: { peerOf: (n) => (n === 'vm' ? DIALLED : null), chunkBytes: 4 } })
  const net = { calls: [] }
  let pulls = 0
  net.cut = (c) => c.path === '/peer/drop/pull' && ++pulls === 2
  const dial = wire(() => X.drops, 'vm', net)
  const Y = recvRig({ peers: { host: DIALS }, opts: { dial } })
  const sent = await dropOf(X)
  const d = sent.dropId

  Y.drops.applyDeltas('host', X.drops.jobDeltasFor('vm'))
  await until('the pull to reach the cut', () => pulls >= 2)
  await pause(100)
  const recv = recvJobOf(Y, d)
  assert.deepEqual([recv.peer, recv.state, recv.files.length, recv.bytes], ['host', 'receiving', 2, 11])
  assert.deepEqual(routes(net).map(([p]) => p), ['/peer/drop/manifest', '/peer/drop/pull', '/peer/drop/pull'])
  assert.deepEqual(net.calls.slice(1).map((c) => c.body), [{ dropId: d, file: 0, offset: 0 }, { dropId: d, file: 0, offset: 4 }])
  assert.equal(readFileSync(partOf(Y, 'host', d, 0), 'utf8'), 'hell')

  // The sender hears the receiver is receiving, and moves to sending.
  X.drops.applyDeltas('vm', Y.drops.jobDeltasFor('host'))
  assert.deepEqual([X.jobs.get(sent.id).state, X.jobs.get(sent.id).remote.state], ['sending', 'receiving'])

  // The dialler goes away mid-pull; a new engine over the same store continues at boot.
  await Y.drops.stop()
  Y.jobs.flush()
  net.cut = null
  net.calls.length = 0
  const store = J.createJobsStore({ file: join(Y.dir, 'peer-jobs.json') })
  const logs = []
  const Y2 = D.createDrops({ dir: Y.dir, jobs: store, log: (m) => logs.push(m), peerOf: (n) => (n === 'host' ? DIALS : null), dial })
  Y2.start()
  await until('the resumed pull to land', () => store.get(recv.id).state === 'landed')
  assert.deepEqual(net.calls.map((c) => c.body), [{ dropId: d, file: 0, offset: 4 }, { dropId: d, file: 1, offset: 0 }, { dropId: d, file: 1, offset: 4 }],
    'a partial file is continued, never restarted')
  assert.ok(logs.some((l) => l.includes(d) && l.includes('4 bytes are already here')), JSON.stringify(logs))
  assert.equal(readFileSync(join(Y.dir, 'peer-inbox', 'host', d, 'a.ts'), 'utf8'), 'hello')
  assert.equal(readFileSync(join(Y.dir, 'peer-inbox', 'host', d, 'sub', 'b.ts'), 'utf8'), 'world!')

  X.drops.applyDeltas('vm', Y2.jobDeltasFor('host'))
  assert.deepEqual([X.jobs.get(sent.id).state, X.jobs.get(sent.id).remote.state], ['sent', 'landed'])
  await until('the sent drop\'s stage to be removed', () => !existsSync(join(X.dir, 'peer-staging', d)))
  Y2.applyDeltas('host', X.drops.jobDeltasFor('vm'))
  assert.deepEqual([store.get(recv.id).state, store.get(recv.id).remote.state], ['landed', 'sent'])
})

await ok('a pull the dialler refuses is recorded refused with the reason and refuses the sender with it; nothing else starts a pull', async () => {
  const X = filterRig({ opts: { peerOf: (n) => (n === 'vm' ? DIALLED : null) } })
  const net = { calls: [] }
  const Y = recvRig({ peers: { host: DIALS }, opts: { dial: wire(() => X.drops, 'vm', net), byteCap: 3 } })
  const sent = await dropOf(X)
  Y.drops.applyDeltas('host', X.drops.jobDeltasFor('vm'))
  const refused = await until('the dialler to refuse', () => recvJobOf(Y, sent.dropId)?.state === 'refused' && recvJobOf(Y, sent.dropId))
  assert.match(refused.reason, /too large/)
  assert.deepEqual(routes(net).map(([p]) => p), ['/peer/drop/manifest'])
  X.drops.applyDeltas('vm', Y.drops.jobDeltasFor('host'))
  const xs = X.jobs.get(sent.id)
  assert.deepEqual([xs.state, xs.reason, xs.remote.state, xs.remote.reason], ['refused', refused.reason, 'refused', refused.reason])
  await until('the refused drop\'s stage to be removed', () => !existsSync(join(X.dir, 'peer-staging', sent.dropId)))

  const dialled = []
  const Z = recvRig({ peers: { host: DIALLED, vm: DIALS }, opts: { dial: (a) => { dialled.push(a); return { ok: false, status: 0 } } } })
  const offering = { dropId: 'ab'.repeat(8), side: 'send', state: 'offering', files: 1, bytes: 1, sent: 0, reason: null, at: 1 }
  Z.drops.applyDeltas('host', [offering])
  Z.drops.applyDeltas('vm', [{ ...offering, state: 'sending' }, { ...offering, side: 'recv', state: 'receiving' }, { ...offering, state: 'bogus' },
    { ...offering, dropId: '../x' }, { ...offering, side: 'sideways' }, null, 'x'])
  Z.drops.applyDeltas('nobody', [offering])
  Z.drops.applyDeltas('vm', 'not a list')
  await pause(50)
  assert.deepEqual([dialled, Z.jobs.all()], [[], []], 'only an offering delta from a peer this side dials starts a pull')
})

await ok('jobDeltas: moving jobs first, then those ended within the hour, at most 100, a reason at most 2 KB; a delta moves only this side\'s job for that drop and peer', async () => {
  let t = 10_000_000
  const dir = realpathSync(tmp())
  const jobs = J.createJobsStore({ file: join(dir, 'peer-jobs.json'), now: () => t })
  const drops = D.createDrops({ dir, jobs, now: () => t, peerOf: (n) => ({ vm: DIALLED, other: DIALLED })[n] ?? null })
  const ROW = [{ path: 'a.ts', size: 1, sha256: 'a'.repeat(64), mode: 0o644 }]
  const sendJob = (peer, ...states) => {
    const e = jobs.create({ peer, side: 'send', files: ROW, bytes: 1 })
    for (const s of ['filtering', ...states]) jobs.transition(e.id, s, s === 'refused' ? { reason: 'no' } : s === 'failed' ? { error: 'broke' } : {})
    return e
  }
  sendJob('vm', 'refused')
  t += 3600_000 + 1
  const recent = sendJob('vm', 'failed')
  jobs.set(recent.id, { error: 'é'.repeat(3000) })
  t += 1
  const moving = sendJob('vm', 'offering')
  sendJob('other', 'offering')
  const rows = drops.jobDeltasFor('vm')
  assert.deepEqual(rows.map((r) => r.dropId), [moving.dropId, recent.dropId], 'a moving job first, one ended within the hour next, and an older end not at all')
  assert.equal(rows[1].state, 'failed')
  assert.ok(rows[1].reason.startsWith('é') && Buffer.byteLength(rows[1].reason) <= 2000 && Buffer.byteLength(rows[1].reason) > 1990)
  for (let i = 0; i < 120; i++) sendJob('vm')
  assert.equal(drops.jobDeltasFor('vm').length, 100)

  const delta = (over) => ({ dropId: moving.dropId, side: 'recv', state: 'receiving', files: 1, bytes: 1, sent: 0, reason: null, at: 1, ...over })
  drops.applyDeltas('other', [delta()])
  assert.deepEqual([jobs.get(moving.id).state, jobs.get(moving.id).remote], ['offering', null], "another peer's delta for the same drop id")
  drops.applyDeltas('vm', [delta({ side: 'send', state: 'offering' }), delta({ state: 'nonsense' }), delta({ dropId: 'x' }), null])
  assert.equal(jobs.get(moving.id).remote, null)
  t += 5
  drops.applyDeltas('vm', [delta({ reason: 'x'.repeat(3000) })])
  const heard = jobs.get(moving.id)
  assert.deepEqual([heard.state, heard.remote.state, heard.remote.reason.length, heard.remote.at], ['sending', 'receiving', 2000, t])
  drops.applyDeltas('vm', [delta({ state: 'failed', reason: 'disk full' })])
  assert.equal(jobs.get(moving.id).state, 'failed'); assert.match(jobs.get(moving.id).error, /disk full/)

  for (const s of ['verifying', 'filtering', 'landed']) {
    const e = sendJob('vm', 'offering')
    drops.applyDeltas('vm', [delta({ dropId: e.dropId, state: s })])
    assert.deepEqual([jobs.get(e.id).state, jobs.get(e.id).remote.state], ['sent', s])
  }
  const theirs = sendJob('vm', 'offering')
  drops.applyDeltas('vm', [delta({ dropId: theirs.dropId, state: 'refused', reason: 'a .env file' })])
  assert.deepEqual([jobs.get(theirs.id).state, jobs.get(theirs.id).reason], ['refused', 'a .env file'])

  // A receive job whose sender ended the drop ends with it, and keeps no copy.
  const rd = 'ab'.repeat(8)
  await drops.onOffer({ peer: 'vm', body: { dropId: rd, files: ROW } })
  assert.equal(existsSync(join(dir, 'peer-quarantine', 'vm', rd)), true)
  drops.applyDeltas('vm', [{ dropId: rd, side: 'send', state: 'failed', files: 1, bytes: 1, sent: 0, reason: 'cancelled', at: 1 }])
  const ended = recvJobOf({ jobs }, rd)
  assert.equal(ended.state, 'failed'); assert.match(ended.error, /cancelled/)
  await until('the ended drop\'s quarantine to be removed', () => !existsSync(join(dir, 'peer-quarantine', 'vm', rd)))
})

await ok('the stall sweep fails a job with no progress for a day and removes its copy, and removes a copy an earlier end left behind', async () => {
  let t = 0
  const dir = realpathSync(tmp())
  const jobs = J.createJobsStore({ file: join(dir, 'peer-jobs.json'), now: () => t })
  const drops = D.createDrops({ dir, jobs, now: () => t, peerOf: () => DIALLED })
  const rd = 'ab'.repeat(8)
  await drops.onOffer({ peer: 'vm', body: { dropId: rd, files: [rowOf('a.ts', Buffer.from('x'))] } })
  const done = jobs.create({ peer: 'vm', side: 'send', files: [], bytes: 0 })
  for (const s of ['filtering', 'offering', 'sending', 'sent']) jobs.transition(done.id, s)
  mkdirSync(join(dir, 'peer-staging', done.dropId, 'in'), { recursive: true })
  t = 12 * 3600_000
  assert.equal(await drops.sweep(), 0)
  assert.equal(existsSync(join(dir, 'peer-staging', done.dropId)), false, "an ended job's leftover stage goes on the next sweep")
  assert.equal(existsSync(join(dir, 'peer-quarantine', 'vm', rd)), true, 'a moving drop keeps its quarantine')
  t = 24 * 3600_000 + 1
  assert.equal(await drops.sweep(), 1)
  const stalled = recvJobOf({ jobs }, rd)
  assert.deepEqual([stalled.state, stalled.error], ['failed', 'stalled'])
  assert.equal(existsSync(join(dir, 'peer-quarantine', 'vm', rd)), false)
  assert.equal(JSON.parse(readFileSync(join(dir, 'peer-jobs.json'), 'utf8')).items.find((e) => e.id === stalled.id).state, 'failed')
})

// ---- landing ---------------------------------------------------------------------

const LD = await import(join(ROOT, 'syzygy', 'bridge', 'peer-landing.mjs'))

/** Every entry under `root`, never followed: a file by its sha256, a directory
 *  as `dir`, a link by where it points. Two readings equal means nothing under
 *  `root` was created, removed, written or truncated. */
const treeOf = (root) => {
  const out = {}
  const walk = (rel) => {
    for (const name of readdirSync(rel ? join(root, rel) : root).sort()) {
      const child = rel ? `${rel}/${name}` : name
      const st = lstatSync(join(root, child))
      if (st.isSymbolicLink()) out[child] = 'link:' + readlinkSync(join(root, child))
      else if (st.isDirectory()) { out[child] = 'dir'; walk(child) } else out[child] = P.sha256hex(readFileSync(join(root, child)))
    }
  }
  walk('')
  return out
}
/** Somewhere outside every world dir, holding one file, for a planted link to aim at. */
const outsideDir = () => {
  const d = realpathSync(tmp())
  writeFileSync(join(d, 'precious.txt'), 'do not touch')
  return d
}
/** A verified drop's quarantine written by hand: `files/<index>` for each entry. */
const quarantineBy = (dir, peer, dropId, entries) => {
  const files = join(dir, 'peer-quarantine', peer, dropId, 'files')
  mkdirSync(files, { recursive: true })
  entries.forEach(([, buf], i) => writeFileSync(join(files, String(i)), buf))
  return entries.map(([path, buf]) => rowOf(path, buf))
}
/** Files under `root/src` by relative path, and their rows. */
const landingSource = (entries) => {
  const dir = realpathSync(tmp())
  const src = join(dir, 'src')
  for (const [path, buf] of entries) {
    mkdirSync(dirname(join(src, path)), { recursive: true })
    writeFileSync(join(src, path), buf)
  }
  return { dir, src, rows: entries.map(([path, buf]) => rowOf(path, buf)) }
}
const LAND_ID = 'ab'.repeat(8)

await ok('layOut builds in/ from files by index under sanitised paths, clears in/ and out/, and drops a refused path with its reason', async () => {
  const dir = realpathSync(tmp())
  const rows = quarantineBy(dir, 'vm', LAND_ID, [
    ['src/app/main.ts', Buffer.from('main')], ['../../x', Buffer.from('up')], ['/etc/x', Buffer.from('abs')],
    ['.git/config', Buffer.from('cfg')], ['a//b', Buffer.from('slashes')], ['empty.txt', Buffer.alloc(0)], ['README', Buffer.from('readme')],
  ])
  const base = join(dir, 'peer-quarantine', 'vm', LAND_ID)
  mkdirSync(join(base, 'in', 'stale'), { recursive: true })
  mkdirSync(join(base, 'out'))
  writeFileSync(join(base, 'out', 'stale'), 'stale')
  const laid = await LD.layOut({ dir, peer: 'vm', dropId: LAND_ID, rows })
  assert.deepEqual(laid.rows, [rows[0], rows[5], rows[6]])
  assert.deepEqual(laid.dropped.map((d) => d.path), ['../../x', '/etc/x', '.git/config', 'a//b'])
  for (const d of laid.dropped) assert.match(d.reason, /landing path/)
  assert.deepEqual(treeOf(join(base, 'in')), {
    README: P.sha256hex('readme'), 'empty.txt': P.sha256hex(''), src: 'dir', 'src/app': 'dir', 'src/app/main.ts': P.sha256hex('main'),
  })
  assert.equal(existsSync(join(base, 'out')), false)
  assert.deepEqual(readdirSync(join(base, 'files')).sort(), ['0', '1', '2', '3', '4', '5', '6'], 'the quarantine itself is left as it was')
  assert.equal(existsSync(join(dir, 'peer-quarantine', 'x')), false)
  assert.equal(existsSync(join(dir, 'x')), false)

  // Laid out twice, the same tree: the filter must be free to run again.
  assert.deepEqual((await LD.layOut({ dir, peer: 'vm', dropId: LAND_ID, rows })).rows, laid.rows)
})

await ok('layOut refuses a drop whose files would land on each other, or has nothing it may land, and never walks a link', async () => {
  const dir = realpathSync(tmp())
  const cases = [
    [[['x', Buffer.from('1')], ['x/y', Buffer.from('2')]], /x is a file in the drop and also a directory above x\/y/],
    [[['x/y', Buffer.from('2')], ['x', Buffer.from('1')]], /x is a file in the drop and also a directory above x\/y/],
    [[['a.ts', Buffer.from('1')], ['a.ts', Buffer.from('2')]], /both land at a\.ts/],
    [[['README.md', Buffer.from('1')], ['readme.md', Buffer.from('2')]], /both land at readme\.md/],
    [[['../x', Buffer.from('1')], ['.git/HEAD', Buffer.from('2')]], /no file in the drop/],
  ]
  for (const [i, [entries, reason]] of cases.entries()) {
    const dropId = String(i).repeat(16)
    const rows = quarantineBy(dir, 'vm', dropId, entries)
    const r = await LD.layOut({ dir, peer: 'vm', dropId, rows })
    assert.match(r.refuse, reason, JSON.stringify(entries.map(([p]) => p)))
    assert.equal(existsSync(join(dir, 'peer-quarantine', 'vm', dropId, 'in')), false, 'a refused drop is never laid out')
  }

  // A quarantined file that no longer holds what was verified is an error, not a layout.
  const rows = quarantineBy(dir, 'vm', LAND_ID, [['a.ts', Buffer.from('alpha')]])
  writeFileSync(join(dir, 'peer-quarantine', 'vm', LAND_ID, 'files', '0'), 'ALPHA')
  await assert.rejects(LD.layOut({ dir, peer: 'vm', dropId: LAND_ID, rows }), /a\.ts/)

  // A quarantine reached through a link is never laid out, and what it points at is untouched.
  const outside = outsideDir()
  mkdirSync(join(outside, LAND_ID, 'files'), { recursive: true })
  writeFileSync(join(outside, LAND_ID, 'files', '0'), 'alpha')
  const before = treeOf(outside)
  symlinkSync(outside, join(dir, 'peer-quarantine', 'evil'))
  await assert.rejects(LD.layOut({ dir, peer: 'evil', dropId: LAND_ID, rows: [rowOf('a.ts', Buffer.from('alpha'))] }))
  assert.deepEqual(treeOf(outside), before)
  for (const [peer, dropId] of [['..', LAND_ID], ['vm', '../x'], ['VM', LAND_ID], [null, LAND_ID]]) {
    await assert.rejects(LD.layOut({ dir, peer, dropId, rows }), undefined, `${peer} ${dropId}`)
  }
})

await ok('landDrop writes into a scratch directory, checks every file, and renames it to peer-inbox/<peer>/<dropId> in one step', async () => {
  const { dir, src, rows } = landingSource([['src/app/main.ts', Buffer.from('main')], ['a.ts', Buffer.from('alpha')], ['e', Buffer.alloc(0)]])
  const r = await LD.landDrop({ dir, peer: 'vm', dropId: LAND_ID, srcDir: src, rows })
  const inbox = join(dir, 'peer-inbox', 'vm', LAND_ID)
  assert.deepEqual(r, { inboxPath: inbox, recovered: false })
  assert.deepEqual(treeOf(join(dir, 'peer-inbox')), {
    vm: 'dir', [`vm/${LAND_ID}`]: 'dir', [`vm/${LAND_ID}/a.ts`]: P.sha256hex('alpha'), [`vm/${LAND_ID}/e`]: P.sha256hex(''),
    [`vm/${LAND_ID}/src`]: 'dir', [`vm/${LAND_ID}/src/app`]: 'dir', [`vm/${LAND_ID}/src/app/main.ts`]: P.sha256hex('main'),
  }, 'no scratch directory is left beside it')
  assert.equal(statSync(join(inbox, 'a.ts')).mode & 0o777, 0o600, 'a landed file is owner-only and never executable')
  assert.equal(statSync(join(dir, 'peer-inbox', 'vm')).mode & 0o777, 0o700)

  // The same files already there: a landing whose rename finished before the relay stopped.
  assert.deepEqual(await LD.landDrop({ dir, peer: 'vm', dropId: LAND_ID, srcDir: src, rows }), { inboxPath: inbox, recovered: true })
  // Anything else there is never replaced.
  writeFileSync(join(inbox, 'a.ts'), 'other', { mode: 0o600 })
  const before = treeOf(inbox)
  await assert.rejects(LD.landDrop({ dir, peer: 'vm', dropId: LAND_ID, srcDir: src, rows }), /an inbox directory for this drop already exists/)
  assert.deepEqual(treeOf(inbox), before)
  writeFileSync(join(inbox, 'a.ts'), 'alpha')
  writeFileSync(join(inbox, 'extra'), 'x')
  await assert.rejects(LD.landDrop({ dir, peer: 'vm', dropId: LAND_ID, srcDir: src, rows }), /already exists/, 'an extra file is not the same drop')
  assert.equal(readdirSync(join(dir, 'peer-inbox', 'vm')).some((n) => n.startsWith('.landing-')), false)
})

await ok('landDrop never writes through a link planted on the landing path, and leaves what it points at byte-identical', async () => {
  // The peer's inbox directory is itself a link.
  {
    const { dir, src, rows } = landingSource([['a.ts', Buffer.from('alpha')]])
    const outside = outsideDir()
    mkdirSync(join(dir, 'peer-inbox'))
    symlinkSync(outside, join(dir, 'peer-inbox', 'vm'))
    const before = treeOf(outside)
    await assert.rejects(LD.landDrop({ dir, peer: 'vm', dropId: LAND_ID, srcDir: src, rows }), /not a plain directory/)
    assert.deepEqual(treeOf(outside), before)
  }
  // The inbox itself is a link.
  {
    const { dir, src, rows } = landingSource([['a.ts', Buffer.from('alpha')]])
    const outside = outsideDir()
    symlinkSync(outside, join(dir, 'peer-inbox'))
    const before = treeOf(outside)
    await assert.rejects(LD.landDrop({ dir, peer: 'vm', dropId: LAND_ID, srcDir: src, rows }), /not a plain directory/)
    assert.deepEqual(treeOf(outside), before)
  }
  // The scratch directory's own name is a link.
  {
    const { dir, src, rows } = landingSource([['a.ts', Buffer.from('alpha')]])
    const outside = outsideDir()
    mkdirSync(join(dir, 'peer-inbox', 'vm'), { recursive: true })
    symlinkSync(outside, join(dir, 'peer-inbox', 'vm', `.landing-${LAND_ID}`))
    const before = treeOf(outside)
    await assert.rejects(LD.landDrop({ dir, peer: 'vm', dropId: LAND_ID, srcDir: src, rows }), /already there/)
    assert.deepEqual(treeOf(outside), before)
    assert.equal(lstatSync(join(dir, 'peer-inbox', 'vm', `.landing-${LAND_ID}`)).isSymbolicLink(), true, 'a link this call did not make is not its to remove')
    assert.equal(existsSync(join(dir, 'peer-inbox', 'vm', LAND_ID)), false)
  }
  // The drop's own directory name is a link.
  {
    const { dir, src, rows } = landingSource([['a.ts', Buffer.from('alpha')]])
    const outside = outsideDir()
    mkdirSync(join(dir, 'peer-inbox', 'vm'), { recursive: true })
    symlinkSync(outside, join(dir, 'peer-inbox', 'vm', LAND_ID))
    const before = treeOf(outside)
    await assert.rejects(LD.landDrop({ dir, peer: 'vm', dropId: LAND_ID, srcDir: src, rows }), /already exists/)
    assert.deepEqual(treeOf(outside), before)
    assert.deepEqual(readdirSync(join(dir, 'peer-inbox', 'vm')), [LAND_ID], 'the scratch directory it made is gone')
  }
  // A file to land that is a link, or sits below one, is never read through.
  {
    const outside = outsideDir()
    const { dir, src, rows } = landingSource([['a.ts', Buffer.from('do not touch')]])
    rmSync(join(src, 'a.ts'))
    symlinkSync(join(outside, 'precious.txt'), join(src, 'a.ts'))
    await assert.rejects(LD.landDrop({ dir, peer: 'vm', dropId: LAND_ID, srcDir: src, rows }), /a\.ts/)
    symlinkSync(outside, join(src, 'sub'))
    await assert.rejects(LD.landDrop({ dir, peer: 'vm', dropId: LAND_ID, srcDir: src, rows: [rowOf('sub/precious.txt', Buffer.from('do not touch'))] }), /sub\/precious\.txt/)
    assert.deepEqual(readdirSync(join(dir, 'peer-inbox', 'vm')), [], 'nothing landed and no scratch is left')
  }
  // A file that does not match its row fails the landing and leaves nothing.
  {
    const { dir, src, rows } = landingSource([['a.ts', Buffer.from('alpha')], ['b.ts', Buffer.from('bravo')]])
    await assert.rejects(LD.landDrop({ dir, peer: 'vm', dropId: LAND_ID, srcDir: src, rows: [rows[0], { ...rows[1], sha256: P.sha256hex('other') }] }), /b\.ts/)
    assert.deepEqual(readdirSync(join(dir, 'peer-inbox', 'vm')), [])
  }
  // A name that is not a peer or a drop id builds no path at all.
  {
    const { dir, src, rows } = landingSource([['a.ts', Buffer.from('alpha')]])
    for (const [peer, dropId] of [['..', LAND_ID], ['vm/x', LAND_ID], ['vm', '..'], ['vm', 'AB'.repeat(8)]]) {
      await assert.rejects(LD.landDrop({ dir, peer, dropId, srcDir: src, rows }), undefined, `${peer} ${dropId}`)
    }
    for (const bad of [[{ ...rows[0], path: '../a.ts' }], [{ ...rows[0], path: 'a//b' }], [rows[0], rows[0]], []]) {
      await assert.rejects(LD.landDrop({ dir, peer: 'vm', dropId: LAND_ID, srcDir: src, rows: bad }), undefined, JSON.stringify(bad))
    }
    assert.equal(existsSync(join(dir, 'peer-inbox')), false)
  }
})

await ok('removeLandingScratch removes one drop\'s scratch directory and nothing else, and never walks a link', async () => {
  const dir = realpathSync(tmp())
  const outside = outsideDir()
  mkdirSync(join(dir, 'peer-inbox', 'vm', `.landing-${LAND_ID}`, 'sub'), { recursive: true })
  mkdirSync(join(dir, 'peer-inbox', 'vm', LAND_ID))
  mkdirSync(join(dir, 'peer-inbox', 'vm', `.landing-${'cd'.repeat(8)}`))
  assert.equal(await LD.removeLandingScratch({ dir, peer: 'vm', dropId: LAND_ID }), true)
  assert.deepEqual(readdirSync(join(dir, 'peer-inbox', 'vm')).sort(), [`.landing-${'cd'.repeat(8)}`, LAND_ID])
  symlinkSync(outside, join(dir, 'peer-inbox', 'vm', `.landing-${LAND_ID}`))
  const before = treeOf(outside)
  assert.equal(await LD.removeLandingScratch({ dir, peer: 'vm', dropId: LAND_ID }), true)
  assert.equal(existsSync(join(dir, 'peer-inbox', 'vm', `.landing-${LAND_ID}`)), false, 'the link itself is removed')
  assert.deepEqual(treeOf(outside), before)
  mkdirSync(join(outside, `.landing-${LAND_ID}`))
  symlinkSync(outside, join(dir, 'peer-inbox', 'evil'))
  assert.equal(await LD.removeLandingScratch({ dir, peer: 'evil', dropId: LAND_ID }), false)
  assert.equal(existsSync(join(outside, `.landing-${LAND_ID}`)), true, 'a linked peer directory is never walked through')
  for (const [peer, dropId] of [['..', LAND_ID], ['vm', '..'], [null, LAND_ID]]) assert.equal(await LD.removeLandingScratch({ dir, peer, dropId }), false)
  assert.equal(await LD.removeLandingScratch({ dir, peer: 'nobody', dropId: LAND_ID }), true)
})

// ---- landing a received drop: the engine ---------------------------------------

/** Offers `entries` to a receiving rig as `peer`, pushes every byte and commits. */
const deliver = async (rig, dropId, entries, peer = 'vm') => {
  const offered = await rig.drops.onOffer({ peer, body: { dropId, files: entries.map(([path, buf]) => rowOf(path, buf)) } })
  assert.equal(offered?.json?.accept, true, JSON.stringify(offered?.json))
  for (const [i, [, buf]] of entries.entries()) {
    for (let off = 0; off < buf.length; off += D.CHUNK_BYTES) {
      await rig.drops.onChunk({ peer, query: chunkQuery(dropId, i, off), body: buf.subarray(off, off + D.CHUNK_BYTES) })
    }
  }
  assert.deepEqual((await rig.drops.onCommit({ peer, body: { dropId } }))?.json, { ok: true })
  return recvJobOf(rig, dropId)
}
const endOf = (rig, dropId) => until(`drop ${dropId} to end`, () => {
  const j = recvJobOf(rig, dropId)
  return j && ['landed', 'refused', 'failed'].includes(j.state) ? j : null
})
const inboxOf = (rig, peer, dropId) => join(rig.dir, 'peer-inbox', peer, dropId)
const filesUnder = (root) => Object.entries(treeOf(root)).filter(([, v]) => v !== 'dir').map(([k]) => k)
const pidIn = (file) => (existsSync(file) && Number(readFileSync(file, 'utf8'))) || null
const quarantineGone = (rig, peer, dropId) => until(`the quarantine of ${dropId} to be removed`, () => !existsSync(quarantineOf(rig, peer, dropId)))

await ok('with no receive filter a verified drop lands by landing path; the pane row carries inboxPath, a heartbeat never does, and the quarantine goes', async () => {
  const rig = recvRig()
  const dropId = 'a1'.repeat(8)
  const job = await deliver(rig, dropId, [['src/app/main.ts', Buffer.from('main')], ['a.ts', Buffer.from('alpha')], ['empty', Buffer.alloc(0)]])
  const landed = await endOf(rig, dropId)
  assert.deepEqual([landed.state, landed.filtered, landed.filterReason, landed.sent, landed.bytes], ['landed', false, 'no filter', 9, 9])
  assert.deepEqual(landed.files.map((f) => f.path), ['src/app/main.ts', 'a.ts', 'empty'])
  assert.deepEqual(landed.landed.map((f) => [f.path, f.sha256]), [['src/app/main.ts', P.sha256hex('main')], ['a.ts', P.sha256hex('alpha')], ['empty', P.sha256hex('')]])
  assert.deepEqual(treeOf(join(rig.dir, 'peer-inbox')), {
    vm: 'dir', [`vm/${dropId}`]: 'dir', [`vm/${dropId}/a.ts`]: P.sha256hex('alpha'), [`vm/${dropId}/empty`]: P.sha256hex(''),
    [`vm/${dropId}/src`]: 'dir', [`vm/${dropId}/src/app`]: 'dir', [`vm/${dropId}/src/app/main.ts`]: P.sha256hex('main'),
  })
  await quarantineGone(rig, 'vm', dropId)
  assert.equal(rig.drops.payload().jobs.find((j) => j.id === job.id).inboxPath, inboxOf(rig, 'vm', dropId))
  const deltas = rig.drops.jobDeltasFor('vm')
  assert.equal(deltas[0].state, 'landed')
  for (const leak of ['inboxPath', 'peer-inbox', rig.dir, 'main.ts']) assert.equal(JSON.stringify(deltas).includes(leak), false, leak)
  assert.deepEqual((await rig.drops.onCommit({ peer: 'vm', body: { dropId } })).json, { ok: true }, 'a commit after landing moves nothing')

  const moving = 'a2'.repeat(8)
  await rig.drops.onOffer({ peer: 'vm', body: { dropId: moving, files: [rowOf('b.ts', Buffer.from('b'))] } })
  assert.equal(rig.drops.payload().jobs.find((j) => j.dropId === moving).inboxPath, null, 'a drop still moving has no inbox path')
})

await ok('a receive filter runs over in/ laid out by landing path, and only regular files it left under --out land, each held to the landing rule again', async () => {
  const rig = recvRig({ opts: { filterTimeoutMs: 8000, killGraceMs: 150 } })
  const probe = join(realpathSync(tmp()), 'probe.json')
  writeFilter(rig.dir, [...PRELUDE, 'const m = read()',
    `fs.writeFileSync(${q(probe)}, JSON.stringify({ argv: process.argv.slice(2), stdin: m }))`,
    "const keep = m.files.filter((f) => f.path !== 'drop-me.txt')",
    'copyAll({ files: keep })',
    "fs.writeFileSync(path.join(OUT, 'added.txt'), 'added by the filter')",
    "fs.symlinkSync(path.join(IN, 'a.ts'), path.join(OUT, 'link.txt'))",
    "fs.writeFileSync(path.join(OUT, '..', 'escape.txt'), 'beside --out')",
    "process.stdout.write(JSON.stringify({ version: 1, files: [...keep, { path: 'added.txt' }, { path: '../escape.txt' }, { path: '.git/config' }, { path: 'not-there.txt' }, { path: 'link.txt' }] }))",
  ])
  const dropId = 'aa'.repeat(8)
  await deliver(rig, dropId, [['a.ts', Buffer.from('alpha')], ['sub/b.ts', Buffer.from('bravo')], ['drop-me.txt', Buffer.from('nope')], ['../../x', Buffer.from('up')]])
  const landed = await endOf(rig, dropId)
  assert.equal(landed.state, 'landed', JSON.stringify(landed))
  assert.deepEqual([landed.filtered, landed.filterReason], [true, null])
  const base = quarantineOf(rig, 'vm', dropId)
  const seen = JSON.parse(readFileSync(probe, 'utf8'))
  assert.deepEqual(seen.argv, ['--direction', 'receive', '--peer', 'vm', '--drop', dropId, '--in', join(base, 'in'), '--out', join(base, 'out')])
  assert.equal(seen.stdin.direction, 'receive')
  assert.deepEqual(seen.stdin.files.map((f) => f.path), ['a.ts', 'sub/b.ts', 'drop-me.txt'], 'a path the receiver refuses never reaches the filter')
  assert.deepEqual(treeOf(inboxOf(rig, 'vm', dropId)), {
    'a.ts': P.sha256hex('alpha'), 'added.txt': P.sha256hex('added by the filter'), sub: 'dir', 'sub/b.ts': P.sha256hex('bravo'),
  })
  assert.deepEqual(landed.landed.map((f) => [f.path, f.sha256]), [['a.ts', P.sha256hex('alpha')], ['sub/b.ts', P.sha256hex('bravo')], ['added.txt', P.sha256hex('added by the filter')]])
  assert.deepEqual(landed.files.map((f) => f.path), ['a.ts', 'sub/b.ts', 'drop-me.txt', '../../x'], 'the offer is kept as it came')
  assert.deepEqual(landed.refusedPaths.map((r) => r.path), ['../../x', '../escape.txt', '.git/config', 'not-there.txt', 'link.txt'])
  for (const r of landed.refusedPaths.slice(0, 3)) assert.match(r.reason, /landing path/)
  assert.match(landed.refusedPaths[3].reason, /no file/)
  assert.match(landed.refusedPaths[4].reason, /link/)
  assert.equal(landed.refusedCount, 5)
  await quarantineGone(rig, 'vm', dropId)
})

await ok('a receive filter that exits non-zero refuses the drop with its stderr and a hung or cancelled one fails it; nothing leaves quarantine, and the sender still hears every byte was delivered', async () => {
  const entries = [['a.ts', Buffer.from('alpha')], ['b.ts', Buffer.from('bravo')]]
  const rig = recvRig({ opts: { filterTimeoutMs: 8000, killGraceMs: 150 } })
  writeFilter(rig.dir, ["process.stderr.write('scanner says no')", 'process.exit(3)'])
  const dropId = 'd1'.repeat(8)
  await deliver(rig, dropId, entries)
  const refused = await endOf(rig, dropId)
  assert.deepEqual([refused.state, refused.reason, refused.filtered, refused.sent, refused.bytes], ['refused', 'scanner says no', true, 10, 10])
  await quarantineGone(rig, 'vm', dropId)
  assert.equal(existsSync(join(rig.dir, 'peer-inbox')), false, 'nothing left quarantine')

  const [delta] = rig.drops.jobDeltasFor('vm')
  assert.deepEqual([delta.state, delta.reason, delta.sent, delta.bytes], ['refused', 'scanner says no', 10, 10])
  const sender = recvRig()
  const s = sender.jobs.create({ peer: 'vm', side: 'send', dropId, files: entries.map(([p, b]) => rowOf(p, b)), bytes: 10 })
  for (const st of ['filtering', 'offering', 'sending']) sender.jobs.transition(s.id, st)
  sender.drops.applyDeltas('vm', rig.drops.jobDeltasFor('vm'))
  const heard = sender.jobs.get(s.id)
  assert.deepEqual([heard.state, heard.remote.state, heard.remote.reason], ['sent', 'refused', 'scanner says no'])
  // A sender that restarted before hearing its commit answered, offering and
  // committing again, is told every byte is here.
  const again = { dropId, files: entries.map(([p, b]) => rowOf(p, b)) }
  assert.deepEqual((await rig.drops.onOffer({ peer: 'vm', body: again })).json, { accept: true, have: { 0: 5, 1: 5 } })
  assert.deepEqual((await rig.drops.onCommit({ peer: 'vm', body: { dropId } })).json, { ok: true })

  const hang = (pidFile) => [`require('node:fs').writeFileSync(${q(pidFile)}, String(process.pid))`, 'setInterval(() => {}, 1000)']
  const slow = recvRig({ opts: { filterTimeoutMs: 400, killGraceMs: 100 } })
  const slowPid = join(slow.dir, 'filter.pid')
  writeFilter(slow.dir, hang(slowPid))
  const hung = 'd2'.repeat(8)
  await deliver(slow, hung, entries)
  const failed = await endOf(slow, hung)
  assert.equal(failed.state, 'failed'); assert.match(failed.error, /timed out/); assert.equal(failed.sent, 10)
  await until('the hung filter to be gone', () => !alive(pidIn(slowPid)))
  await quarantineGone(slow, 'vm', hung)
  assert.equal(existsSync(join(slow.dir, 'peer-inbox')), false)

  const held = recvRig({ opts: { filterTimeoutMs: 8000, killGraceMs: 100 } })
  const heldPid = join(held.dir, 'filter.pid')
  writeFilter(held.dir, hang(heldPid))
  const cancelled = 'd3'.repeat(8)
  const cj = await deliver(held, cancelled, entries)
  await until('the filter to start', () => pidIn(heldPid))
  assert.equal(held.drops.cancel({ id: cj.id }).status, 200)
  await until('the cancelled filter to be gone', () => !alive(pidIn(heldPid)))
  await quarantineGone(held, 'vm', cancelled)
  assert.deepEqual([held.jobs.get(cj.id).state, held.jobs.get(cj.id).error], ['failed', 'cancelled'])
  assert.equal(existsSync(join(held.dir, 'peer-inbox')), false)
})

await ok('a link planted on the landing path fails the drop and is never written through; an inbox directory already there for the drop is never replaced', async () => {
  const plant = async (i, why, setup) => {
    const rig = recvRig()
    const outside = outsideDir()
    const dropId = `e${i}`.repeat(8)
    setup(rig, outside, dropId)
    const before = treeOf(outside)
    await deliver(rig, dropId, [['a.ts', Buffer.from('alpha')]])
    const failed = await endOf(rig, dropId)
    assert.equal(failed.state, 'failed', JSON.stringify(failed)); assert.match(failed.error, why)
    assert.equal(failed.sent, failed.bytes, 'the bytes were delivered verified, so the sender still reads sent')
    assert.deepEqual(treeOf(outside), before)
    await quarantineGone(rig, 'vm', dropId)
    return { rig, dropId }
  }
  await plant(1, /not a plain directory/, (rig, outside) => { mkdirSync(join(rig.dir, 'peer-inbox')); symlinkSync(outside, join(rig.dir, 'peer-inbox', 'vm')) })
  await plant(2, /not a plain directory/, (rig, outside) => symlinkSync(outside, join(rig.dir, 'peer-inbox')))
  await plant(3, /already there/, (rig, outside, dropId) => {
    mkdirSync(join(rig.dir, 'peer-inbox', 'vm'), { recursive: true })
    symlinkSync(outside, join(rig.dir, 'peer-inbox', 'vm', `.landing-${dropId}`))
  })
  await plant(4, /already exists/, (rig, outside, dropId) => {
    mkdirSync(join(rig.dir, 'peer-inbox', 'vm'), { recursive: true })
    symlinkSync(outside, join(rig.dir, 'peer-inbox', 'vm', dropId))
  })
  const { rig, dropId } = await plant(5, /an inbox directory for this drop already exists/, (r, outside, id) => {
    mkdirSync(inboxOf(r, 'vm', id), { recursive: true })
    writeFileSync(join(inboxOf(r, 'vm', id), 'mine.txt'), 'mine')
  })
  assert.deepEqual(treeOf(inboxOf(rig, 'vm', dropId)), { 'mine.txt': P.sha256hex('mine') })
  assert.equal(readdirSync(join(rig.dir, 'peer-inbox', 'vm')).some((n) => n.startsWith('.landing-')), false)
})

await ok('a hostile offer lands only what may land: ../../x, /etc/x, .git/config and a//b are recorded refused, and nothing appears outside the inbox', async () => {
  const rig = recvRig()
  const dropId = 'f1'.repeat(8)
  const hostile = ['../../x', '/etc/x', '.git/config', 'a//b']
  await deliver(rig, dropId, [...hostile.map((p) => [p, Buffer.from('from ' + p)]), ['ok.txt', Buffer.from('fine')]])
  const landed = await endOf(rig, dropId)
  assert.equal(landed.state, 'landed', JSON.stringify(landed))
  assert.deepEqual(landed.refusedPaths.map((r) => r.path), hostile)
  for (const r of landed.refusedPaths) assert.match(r.reason, /landing path/)
  assert.equal(landed.refusedCount, 4)
  await quarantineGone(rig, 'vm', dropId)
  assert.deepEqual(filesUnder(rig.dir), [`peer-inbox/vm/${dropId}/ok.txt`, 'peer-jobs.json'])
  assert.equal(existsSync('/etc/x'), false)

  const none = 'f2'.repeat(8)
  await deliver(rig, none, hostile.map((p) => [p, Buffer.from('x')]))
  const refused = await endOf(rig, none)
  assert.deepEqual([refused.state, refused.sent, refused.bytes], ['refused', 4, 4]); assert.match(refused.reason, /no file/)
  const clash = 'f3'.repeat(8)
  await deliver(rig, clash, [['x', Buffer.from('1')], ['x/y', Buffer.from('2')]])
  assert.match((await endOf(rig, clash)).reason, /x is a file in the drop and also a directory above x\/y/)
  assert.equal(existsSync(inboxOf(rig, 'vm', none)) || existsSync(inboxOf(rig, 'vm', clash)), false)
})

await ok('at boot a drop left verifying or filtering is checked again from its quarantine and landed: leftover scratch goes, a finished rename counts as landed, and a damaged quarantine fails', async () => {
  const dir = realpathSync(tmp())
  const jobs = J.createJobsStore({ file: join(dir, 'peer-jobs.json') })
  const outside = outsideDir()
  const stranded = (dropId, state, entries) => {
    const rows = quarantineBy(dir, 'vm', dropId, entries)
    const e = jobs.create({ peer: 'vm', side: 'recv', dropId, files: rows, bytes: rows.reduce((n, r) => n + r.size, 0) })
    jobs.transition(e.id, 'receiving')
    jobs.transition(e.id, 'verifying', { sent: e.bytes })
    if (state === 'filtering') jobs.transition(e.id, 'filtering')
    return e
  }
  const one = stranded('b1'.repeat(8), 'verifying', [['a.ts', Buffer.from('alpha')]])
  mkdirSync(join(dir, 'peer-inbox', 'vm', `.landing-${one.dropId}`, 'half'), { recursive: true })
  writeFileSync(join(dir, 'peer-inbox', 'vm', `.landing-${one.dropId}`, 'half', 'x'), 'half written')
  const two = stranded('b2'.repeat(8), 'filtering', [['a.ts', Buffer.from('alpha')], ['sub/b.ts', Buffer.from('bravo')]])
  symlinkSync(outside, join(dir, 'peer-inbox', 'vm', `.landing-${two.dropId}`))
  const three = stranded('b3'.repeat(8), 'filtering', [['c.ts', Buffer.from('charlie')]])
  mkdirSync(join(dir, 'peer-inbox', 'vm', three.dropId))
  writeFileSync(join(dir, 'peer-inbox', 'vm', three.dropId, 'c.ts'), 'charlie')
  const four = stranded('b4'.repeat(8), 'filtering', [['d.ts', Buffer.from('delta')]])
  writeFileSync(join(dir, 'peer-quarantine', 'vm', four.dropId, 'files', '0'), 'DELTA')
  jobs.flush()
  const before = treeOf(outside)

  const store = J.createJobsStore({ file: join(dir, 'peer-jobs.json') })
  const drops = D.createDrops({ dir, jobs: store, peerOf: () => DIALLED, log: () => {} })
  drops.start()
  const ended = (e) => until(`${e.dropId} to end`, () => {
    const j = store.get(e.id)
    return ['landed', 'refused', 'failed'].includes(j.state) && j
  })
  assert.equal((await ended(one)).state, 'landed')
  assert.equal((await ended(two)).state, 'landed')
  assert.equal((await ended(three)).state, 'landed')
  const damaged = await ended(four)
  assert.deepEqual([damaged.state, damaged.sent], ['failed', 5]); assert.match(damaged.error, /d\.ts/)
  assert.deepEqual(treeOf(join(dir, 'peer-inbox', 'vm')), {
    [one.dropId]: 'dir', [`${one.dropId}/a.ts`]: P.sha256hex('alpha'),
    [two.dropId]: 'dir', [`${two.dropId}/a.ts`]: P.sha256hex('alpha'), [`${two.dropId}/sub`]: 'dir', [`${two.dropId}/sub/b.ts`]: P.sha256hex('bravo'),
    [three.dropId]: 'dir', [`${three.dropId}/c.ts`]: P.sha256hex('charlie'),
  })
  assert.deepEqual(treeOf(outside), before)
  await until('every quarantine to be removed', () => readdirSync(join(dir, 'peer-quarantine', 'vm')).length === 0)
  await drops.stop()
})

await ok('copy-into takes only a landed drop and a real directory inside a known root, never inside the world dir, and never overwrites or writes through a link', async () => {
  const work = realpathSync(tmp())
  const outside = outsideDir()
  let roots = [work]
  const rig = recvRig({ opts: { roots: () => roots } })
  const dropId = 'c1'.repeat(8)
  const job = await deliver(rig, dropId, [['src/app/main.ts', Buffer.from('main')], ['a.ts', Buffer.from('theirs')], ['linked/c.ts', Buffer.from('charlie')], ['sub/b.ts', Buffer.from('bravo')]])
  assert.equal((await endOf(rig, dropId)).state, 'landed')
  writeFileSync(join(work, 'a.ts'), 'mine')
  symlinkSync(outside, join(work, 'linked'))
  const before = treeOf(outside)

  assert.equal((await rig.drops.copyInto({ id: 'nope', dest: work })).status, 404)
  const moving = 'c2'.repeat(8)
  await rig.drops.onOffer({ peer: 'vm', body: { dropId: moving, files: [rowOf('x.ts', Buffer.from('x'))] } })
  assert.equal((await rig.drops.copyInto({ id: recvJobOf(rig, moving).id, dest: work })).status, 409, 'a drop that has not landed')
  mkdirSync(join(rig.dir, 'kept'))
  roots = [work, rig.dir]
  const stray = realpathSync(tmp())
  for (const [dest, why] of [
    ['relative/path', /absolute/], [null, /absolute/], [join(work, 'missing'), /does not exist/], [join(work, 'a.ts'), /not a directory/],
    [stray, /outside every known worktree root/], [inboxOf(rig, 'vm', dropId), /inbox/], [join(rig.dir, 'kept'), /data directory/],
  ]) {
    const r = await rig.drops.copyInto({ id: job.id, dest })
    assert.equal(r.status, 400, String(dest)); assert.match(r.json.error, why, String(dest))
  }
  roots = [work]
  const r = await rig.drops.copyInto({ id: job.id, dest: work })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(r.json.copied, ['src/app/main.ts', 'sub/b.ts'])
  assert.deepEqual(r.json.skipped.map((s) => s.path), ['a.ts', 'linked/c.ts'])
  assert.match(r.json.skipped[0].reason, /already there/); assert.match(r.json.skipped[1].reason, /link/)
  assert.equal(readFileSync(join(work, 'a.ts'), 'utf8'), 'mine', 'an existing file is never overwritten')
  assert.equal(readFileSync(join(work, 'src', 'app', 'main.ts'), 'utf8'), 'main')
  assert.deepEqual(treeOf(outside), before)
  assert.deepEqual(filesUnder(inboxOf(rig, 'vm', dropId)), ['a.ts', 'linked/c.ts', 'src/app/main.ts', 'sub/b.ts'], 'the inbox keeps its copy')

  // Named through a link that resolves inside a root, into a directory holding none of it yet.
  mkdirSync(join(work, 'deeper'))
  const via = join(realpathSync(tmp()), 'to-work')
  symlinkSync(join(work, 'deeper'), via)
  const again = await rig.drops.copyInto({ id: job.id, dest: via })
  assert.deepEqual([again.status, again.json.copied.length, again.json.skipped.length], [200, 4, 0])
  assert.equal(readFileSync(join(work, 'deeper', 'a.ts'), 'utf8'), 'theirs')
  const twice = await rig.drops.copyInto({ id: job.id, dest: via })
  assert.deepEqual([twice.json.copied, twice.json.skipped.map((s) => s.reason)], [[], Array(4).fill('a file is already there')])
})

await ok('the jobs payload stays under its byte budget at the worst case: 50 kept jobs, 2,000 files each, every path 200 characters long', () => {
  const dir = tmp()
  const store = J.createJobsStore({ file: join(dir, 'peer-jobs.json') })
  const manifest = Array.from({ length: 2000 }, (_, i) => ({
    path: 'p'.repeat(190) + String(i).padStart(10, '0'), size: 4096, sha256: 'a'.repeat(64), mode: 0o644,
  }))
  assert.equal(manifest[0].path.length, 200)
  for (let i = 0; i < 50; i++) {
    const e = store.create({ peer: `peer-${i % 5}`, side: i % 2 === 0 ? 'send' : 'recv', files: manifest, bytes: manifest.length * 4096 })
    store.set(e.id, { landed: manifest })
  }
  const drops = D.createDrops({ dir, jobs: store, peerOf: () => null })
  const p = drops.payload()
  assert.equal(p.jobs.length, 50)
  for (const row of p.jobs) {
    assert.equal(row.fileCount, 2000)
    assert.ok(row.files.length < manifest.length, 'files is capped, never the whole manifest')
    assert.ok(row.landed.length < manifest.length, 'landed is capped, never the whole manifest')
  }
  const bytes = Buffer.byteLength(JSON.stringify(p))
  assert.ok(bytes < 256_000, `the jobs payload is ${bytes} bytes at the file cap`)
})

// ---- the agent loop: policy, the gate, the cap, the apply builder --------

await ok('agent loop: sanitizePolicy fills the new fields and reads anything else as manual', () => {
  assert.deepEqual(S.sanitizePolicy(undefined), {
    asksPerHour: 20, peerAskDailyCapUsd: 2, trust: 'manual', autoApply: [], autoApplyMaxLive: 2, peerAsksPerHour: 6,
  })
  const p = S.sanitizePolicy({ trust: 'review', autoApply: ['link', 'arm_resume', 'spawn', 'spawn', 'peer_ask'], autoApplyMaxLive: 99, peerAsksPerHour: -3 })
  assert.equal(p.trust, 'manual')
  assert.deepEqual(p.autoApply, ['spawn', 'link'])
  assert.equal(p.autoApplyMaxLive, 50); assert.equal(p.peerAsksPerHour, 0)
  assert.equal(S.sanitizePolicy({ trust: 'sanctioned' }).trust, 'sanctioned')
})

await ok('agent loop: validatePolicyPatch validates what is present, names a bad field and ignores other keys', () => {
  assert.deepEqual(P.validatePolicyPatch({ trust: 'sanctioned', autoApply: ['link', 'spawn'], other: 1 }),
    { ok: true, patch: { trust: 'sanctioned', autoApply: ['spawn', 'link'] } })
  assert.deepEqual(P.validatePolicyPatch({ name: 'beta' }), { ok: true, patch: {} })
  for (const [body, field] of [
    [{ trust: 'review' }, 'trust'], [{ trust: 'root' }, 'trust'],
    [{ autoApply: ['arm_resume'] }, 'autoApply'], [{ autoApply: ['peer_ask'] }, 'autoApply'], [{ autoApply: 'spawn' }, 'autoApply'],
    [{ autoApplyMaxLive: 51 }, 'autoApplyMaxLive'], [{ autoApplyMaxLive: 1.5 }, 'autoApplyMaxLive'],
    [{ peerAsksPerHour: -1 }, 'peerAsksPerHour'], [{ asksPerHour: 1.5 }, 'asksPerHour'], [{ peerAskDailyCapUsd: 'x' }, 'peerAskDailyCapUsd'],
  ]) {
    const r = P.validatePolicyPatch(body)
    assert.equal(r.ok, false, JSON.stringify(body)); assert.ok(r.error.startsWith(field + ' '), r.error)
  }
  assert.equal(P.validatePolicyPatch({ asksPerHour: 5 }).patch.asksPerHour, 5)
})

await ok('agent loop: gateActions — manual is all buttons, whatever the lists say', () => {
  const kinds = ['link', 'prompt', 'dispatch', 'spawn', 'drop', 'peer_ask', 'arm_resume'].map((kind) => ({ kind }))
  for (const source of ['ask', 'liaison']) {
    const d = P.gateActions({ source, trust: 'manual', autoApply: P.AUTO_APPLY_KINDS, confirmed: true, actions: kinds })
    assert.deepEqual(d.map((x) => x.gate), kinds.map(() => 'button'))
  }
})

await ok('agent loop: gateActions — a local turn under sanctioned auto-sends peer_ask only, within the cap', () => {
  const g = (over, actions) => P.gateActions({ source: 'ask', trust: 'sanctioned', confirmed: true, peerAskCount: 0, peerAsksPerHour: 6, ...over, actions })
  assert.deepEqual(g({}, [{ kind: 'peer_ask' }, { kind: 'spawn' }]).map((d) => d.gate), ['auto', 'button'])
  assert.deepEqual(g({ confirmed: false }, [{ kind: 'peer_ask' }]), [{ gate: 'button', gateNote: 'the peer is not confirmed' }])
  assert.deepEqual(g({ peerAskCount: 6 }, [{ kind: 'peer_ask' }]), [{ gate: 'button', gateNote: 'peer_ask hourly cap reached' }])
  assert.deepEqual(g({ peerAskCount: 5 }, [{ kind: 'peer_ask' }, { kind: 'peer_ask' }]).map((d) => d.gate), ['auto', 'button'])
})

await ok('agent loop: gateActions — a liaison turn under sanctioned auto-applies listed kinds, never peer_ask or arm_resume', () => {
  const g = (over, actions) => P.gateActions({ source: 'liaison', trust: 'sanctioned', confirmed: true, liveForPeer: 0, autoApplyMaxLive: 2, ...over, actions })
  assert.deepEqual(
    g({ autoApply: ['spawn', 'drop'] }, ['spawn', 'drop', 'prompt', 'peer_ask', 'arm_resume', 'link', 'dispatch'].map((kind) => ({ kind }))).map((d) => d.gate),
    ['auto', 'auto', 'button', 'button', 'button', 'button', 'button'])
  // A kind smuggled into the list by hand is still never automatic.
  assert.deepEqual(g({ autoApply: ['peer_ask', 'arm_resume'] }, [{ kind: 'peer_ask' }, { kind: 'arm_resume' }]).map((d) => d.gate), ['button', 'button'])
  assert.deepEqual(g({ autoApply: ['spawn'], liveForPeer: 1, autoApplyMaxLive: 2 }, [{ kind: 'spawn' }, { kind: 'spawn' }]),
    [{ gate: 'auto', gateNote: null }, { gate: 'button', gateNote: 'live session cap reached' }])
  assert.deepEqual(g({ autoApply: ['prompt'], liveForPeer: 9, autoApplyMaxLive: 0 }, [{ kind: 'prompt' }]).map((d) => d.gate), ['auto'])
  assert.deepEqual(g({ autoApply: ['spawn'] }, [null, 'junk']).map((d) => d.gate), ['button', 'button'])
})

await ok('agent loop: peerAskCap counts this peer\'s agent asks from the last rolling hour', () => {
  const now = 10 * 3_600_000
  const asks = [
    { peer: 'beta', dir: 'out', origin: 'agent', t: now - 60_000 },
    { peer: 'beta', dir: 'out', origin: 'agent', t: now - 3_599_000 },
    { peer: 'beta', dir: 'out', origin: 'agent', t: now - 3_601_000 },
    { peer: 'beta', dir: 'out', origin: 'person', t: now - 1000 },
    { peer: 'beta', dir: 'in', origin: 'agent', t: now - 1000 },
    { peer: 'gamma', dir: 'out', origin: 'agent', t: now - 1000 },
  ]
  assert.deepEqual(P.peerAskCap({ asks, peer: 'beta', now, perHour: 2 }), { ok: false, count: 2 })
  assert.deepEqual(P.peerAskCap({ asks, peer: 'beta', now, perHour: 3 }), { ok: true, count: 2 })
  assert.deepEqual(P.peerAskCap({ asks: null, peer: 'beta', now, perHour: 0 }), { ok: false, count: 0 })
})

await ok('agent loop: livePeerSessions counts a peer\'s tagged sessions and its live spawns, each once', async () => {
  const tag = (peer, d) => ({ peer, askId: String(d).repeat(16) })
  const live = (r) => r.state !== 'missing'
  const sessA = { id: 'sess-a', forPeer: tag('beta', 1) }
  const sessOther = { id: 'sess-b', forPeer: tag('gamma', 2) }
  const sessBare = { id: 'sess-c' }
  const sessBadTag = { id: 'sess-d', forPeer: { peer: 'beta', askId: 'not-a-store-id' } }
  const rowOfA = { shortId: 's1', sessionId: 'sess-a', state: 'running', spawnedAt: 0, forPeer: tag('beta', 1) }
  const rowNull = { shortId: 's2', sessionId: null, state: null, spawnedAt: 0, forPeer: tag('beta', 3) }
  const rowStarting = { shortId: 's3', sessionId: null, state: 'starting', spawnedAt: 0, forPeer: tag('beta', 4) }
  const rowMissing = { shortId: 's4', sessionId: null, state: 'missing', spawnedAt: 0, forPeer: tag('beta', 5) }
  const rowOther = { shortId: 's5', sessionId: null, state: null, spawnedAt: 0, forPeer: tag('gamma', 6) }
  const rowBare = { shortId: 's6', sessionId: null, state: null, spawnedAt: 0 }
  const count = (sessions, spawnedBy, over = {}) => P.livePeerSessions({ peer: 'beta', sessions, spawnedBy, isLiveSpawn: live, now: 0, ...over })

  assert.equal(count([sessA], []), 1, 'a tagged live session counts')
  assert.equal(count([], [rowNull]), 1, 'a tagged spawn still live counts')
  assert.equal(count([], [rowStarting]), 1, 'a spawn still starting counts')
  assert.equal(count([sessA], [rowOfA]), 1, 'a spawn whose session is already counted is not counted twice')
  assert.equal(count([], [rowOfA]), 1, 'the same spawn counts while its session is not live')
  assert.equal(count([], [rowMissing]), 0, 'a row the predicate calls not live does not count')
  assert.equal(count([sessOther, sessBare, sessBadTag], [rowOther, rowBare]), 0, 'another peer\'s or an untagged session or row does not count')
  assert.equal(count([sessA, sessOther, sessBare, sessBadTag], [rowOfA, rowNull, rowStarting, rowMissing, rowOther, rowBare]), 3)
  assert.equal(count([sessA, sessOther], [rowOfA, rowOther], { peer: 'gamma' }), 2)
  assert.equal(count(null, null), 0)

  const seen = []
  count([], [rowNull], { isLiveSpawn: (r, t) => { seen.push([r.shortId, t]); return true }, now: 1234 })
  assert.deepEqual(seen, [['s2', 1234]], 'the predicate is asked with the row and the time given')

  const { isLiveSpawn, NULL_STATE_MAX_MS } = await import(join(ROOT, 'syzygy', 'bridge', 'canvas.mjs'))
  const rows = [rowNull, rowStarting, rowMissing, { ...rowNull, shortId: 's7', forPeer: tag('beta', 7), spawnedAt: -NULL_STATE_MAX_MS }]
  assert.equal(P.livePeerSessions({ peer: 'beta', sessions: [], spawnedBy: rows, isLiveSpawn, now: 1 }), 2, 'with the canvas rule: null and starting count, missing and an expired null do not')
})

await ok('agent loop: applyRequest builds the route and body a click posts, and resolves session refs', () => {
  const sessions = [{ id: 's1', name: 'probe-check' }, { id: 's2', name: 'dup' }, { id: 's3', name: 'dup' }]
  const forAsk = 'f'.repeat(16)
  assert.deepEqual(P.applyRequest({ kind: 'prompt', to: 'probe-check', text: 'go' }, { forAsk, sessions }),
    { path: '/api/command', body: { targetId: 's1', verb: 'prompt', payload: { text: 'go' }, forAsk } })
  assert.deepEqual(P.applyRequest({ kind: 'prompt', to: 'dup', text: 'go' }, { sessions }), { error: 'no such session' })
  assert.deepEqual(P.applyRequest({ kind: 'link', from: 's1', to: 'probe-check' }, { sessions }), { path: '/api/link', body: { from: 's1', to: 's1', note: '' } })
  assert.deepEqual(JSON.parse(JSON.stringify(P.applyRequest({ kind: 'spawn', cwd: '/w', prompt: 'p', model: 'sonnet' }, { forAsk }))),
    { path: '/api/spawn', body: { cwd: '/w', name: '', prompt: 'p', model: 'sonnet', forAsk } })
  assert.deepEqual(JSON.parse(JSON.stringify(P.applyRequest({ kind: 'dispatch', title: 't' }, {}))),
    { path: '/api/request/create', body: { title: 't', project: '', ask: '', brief: null } })
  assert.deepEqual(P.applyRequest({ kind: 'drop', paths: ['/w/a'] }, { peer: 'beta' }), { path: '/api/peer/beta/drop', body: { paths: ['/w/a'], note: '' } })
  assert.deepEqual(P.applyRequest({ kind: 'drop', paths: ['/w/a'] }, { peer: null }), { error: 'no peer on this turn' })
  assert.deepEqual(P.applyRequest({ kind: 'peer_ask', peer: 'beta', text: 'run it' }, { forAsk }),
    { path: '/api/peer/beta/ask', body: { text: 'run it', origin: 'agent', forAsk } })
  assert.deepEqual(P.applyRequest({ kind: 'peer_ask', peer: 'Not A Name', text: 'x' }, {}), { error: 'not a peer name' })
  assert.match(P.applyRequest({ kind: 'arm_resume', mode: 'arm' }, {}).error, /never applied automatically/)
})

await ok('agent loop: the ask store keeps origin, an outgoing ask\'s forPeer, and sanitised proposals across a reload', () => {
  const file = join(tmp(), 'asks.json')
  let t = 1000
  const st = S.createAsksStore({ file, now: () => t })
  const tag = { peer: 'beta', askId: 'a'.repeat(16) }
  const out = st.create({ peer: 'beta', dir: 'out', text: 'run the probe', origin: 'agent', forPeer: tag })
  const typed = st.create({ peer: 'beta', dir: 'out', text: 'typed', origin: 'nonsense', forPeer: { peer: 'Bad Name', askId: 'x' } })
  const inc = st.create({ peer: 'beta', dir: 'in', askId: 'b'.repeat(16), text: 'start it', forPeer: tag })
  assert.equal(out.origin, 'agent'); assert.deepEqual(out.forPeer, tag)
  assert.equal(typed.origin, 'person'); assert.equal(typed.forPeer, null)
  assert.equal(inc.origin, 'person'); assert.equal(inc.forPeer, null, 'only an outgoing ask carries a tag')
  st.set(inc.id, { proposals: [
    { index: 0, kind: 'spawn', action: { kind: 'spawn', cwd: '/w', prompt: 'p' }, risk: 'r'.repeat(300), mode: 'auto', state: 'applied', error: null, gateNote: null, at: 5 },
    { index: 1, kind: 'arm_resume', action: { kind: 'arm_resume' }, mode: 'auto', state: 'applied' },
    { index: 2, kind: 'prompt', action: 'not an object', mode: 'auto', state: 'applied' },
    'junk',
  ] })
  const kept = st.get(inc.id).proposals
  assert.equal(kept.length, 1); assert.equal(kept[0].risk.length, 200); assert.equal(kept[0].state, 'applied')
  st.flush()
  const again = S.createAsksStore({ file, now: () => t })
  assert.deepEqual(again.get(out.id).forPeer, tag); assert.equal(again.get(out.id).origin, 'agent')
  assert.deepEqual(again.get(inc.id).proposals, kept)
})

console.log(`\npeer harness: ${pass} checks passed`)
