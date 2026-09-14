// The peering engine: whether peering is on, the TLS listener that exists only
// while it is, pairing, the heartbeat and the health it produces, the asks
// that cross the link, and the drop routes -- everything a drop does belongs to
// peer-drops.mjs's own engine, which this file routes to, carries job deltas
// for on the heartbeat, and hands the one dialer it may use. relay.mjs
// constructs one, shows `payload()` in its snapshot and hands the loopback
// control routes under /api/peer/ to `local()`.
//
// Of a pair, only the side that accepted a code holds the other's address, and
// only that side dials. The side that offered the code never dials anyone: it
// answers each heartbeat, and anything it has to send rides back on the
// heartbeat's response. So an instance that nothing can reach can still be
// paired, provided it can reach the other side.
//
// `payload()` is what the pane sees and what goes out on the event stream. It
// is built field by field and never carries a pairing secret, a pending token
// or code, a pinned certificate or a peer's address: those stay in this
// process and in peers.json.

import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  HELLO_MS, DEFAULT_PEER_PORT, DEFAULT_POLICY, PAIR_TOKEN_MS,
  validName, validBind, sha256hex, verifySignature, createReplayGuard,
  fpBytes, fpEqual, formatPairCode, parsePairCode, pairProof, pairAck, hexEqual,
  derivePairSecret, ghostRoster, isTerminalAsk, healthOf, retryLadder,
  signRequest, capCheck, ASK_TEXT_MAX, sanitizeForPeer,
  validatePolicyPatch, gateActions, peerAskCap,
} from './peer.mjs'
import { readPeers, writePeers, ensureCert, createAsksStore, ASKS_FILE } from './peers-store.mjs'
import { createJobsStore, JOBS_FILE } from './peer-jobs.mjs'
import { createDrops, CHUNK_BYTES } from './peer-drops.mjs'
import { createPeerHandler, createPeerListener, fetchPeerCert, dialPeer, previewOutbound, MAX_PEER_BODY } from './peer-listener.mjs'
import { rateLimiter } from './auth.mjs'

const ASKS_IN_PAYLOAD = 200
const FLUSH_MS = 4000
const SWEEP_MS = 60_000
const PAIR_LIMIT = 10
const PAIR_WINDOW_MS = 60_000
const HOST_MAX = 253
const NAME_ERROR = 'name must be lowercase letters, digits and dashes, 1-32'
const ASK_ID_RE = /^[0-9a-f]{16,64}$/
const ASK_ROUTE_RE = /^([a-z0-9-]{1,32})\/ask$/
const DROP_ROUTE_RE = /^([a-z0-9-]{1,32})\/drop$/
const OUTBOUND_MAX = 50
const REPLY_MAX = 200_000
const ERROR_MAX = 400
// Room left in a body for everything but the text an item carries.
const BODY_SLACK = 4096

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const reply = (status, json) => ({ status, json })
const validPort = (p) => Number.isInteger(p) && p >= 0 && p <= 65535
const urlHost = (h) => (h.includes(':') ? `[${h}]` : h)
const quote = (v) => JSON.stringify(String(v ?? '').slice(0, 64))

const bindError = (value) =>
  value == null
    ? 'say which address to listen on: an IP address such as 127.0.0.1'
    : `cannot listen on ${quote(value)}: it must be an IP address, and a wildcard such as 0.0.0.0 needs SZG_PEER_BIND_ANY=1`

export const createPeerLink = ({
  dir,
  env = process.env,
  run,
  now = Date.now,
  hostname = osHostname(),
  sessions = () => [],
  broadcast = () => {},
  orchestrator = null,
  // The worktree roots a drop's paths must lie inside: every project's main
  // root, every worktree, every live session's root. Never read at
  // construction time -- the caller's own scan is what stays current.
  dropRoots = () => [],
  // Applies one action the gate let through without a click, tagged for the
  // peer and ask it serves; answers `{ ok, error }`.
  applyAction = async () => ({ ok: false, error: 'this relay cannot apply actions' }),
  // How many live sessions on this board are working for a peer.
  liveForPeer = () => 0,
  log = (m) => process.stderr.write('peering: ' + m + '\n'),
}) => {
  const helloMs = Number(env.SZG_PEER_HELLO_MS) > 0 ? Number(env.SZG_PEER_HELLO_MS) : HELLO_MS
  // Consumed by the ask queue: the delays between retries of a busy turn.
  const retry = retryLadder(env.SZG_PEER_ASK_RETRY_MS)
  const opensslBin = env.SZG_OPENSSL_BIN || 'openssl'
  const allowAny = env.SZG_PEER_BIND_ANY === '1'
  const envBind = env.SZG_PEER_BIND || null
  const envPort = env.SZG_PEER_PORT != null && env.SZG_PEER_PORT !== '' ? Number(env.SZG_PEER_PORT) : null
  // A harness knob: a smaller chunk, never a larger one, so a transfer lasts
  // long enough to be interrupted.
  const envChunk = Number(env.SZG_PEER_CHUNK_BYTES)
  const chunkBytes = Number.isSafeInteger(envChunk) && envChunk > 0 && envChunk < CHUNK_BYTES ? envChunk : CHUNK_BYTES

  // ---- runtime state, never persisted ---------------------------------------

  /** @type {any} */ let doc = null
  /** @type {any} */ let asks = null
  /** @type {any} */ let jobs = null
  /** @type {any} */ let drops = null
  let listener = null
  let listenerBind = null
  let listenerPort = null
  let boundPort = null
  let lastError = null
  /** @type {{ token: Buffer, expiresAt: number } | null} */ let pending = null
  let started = false
  let stopped = false
  let timers = []
  let lastSent = null
  let running = null
  let queued = null
  let enabling = Promise.resolve()
  const limiter = rateLimiter({ limit: PAIR_LIMIT, windowMs: PAIR_WINDOW_MS })
  const guard = createReplayGuard({ now })
  /** Per peer, by local name: what the heartbeat has learned. */
  const rt = new Map()

  const rtOf = (name) => {
    let r = rt.get(name)
    if (!r) {
      r = { lastOkAt: null, lastErrAt: null, lastErr: null, rttMs: null, skewMs: null, lastInboundAt: null, roster: [], ackedTo: 0, busy: false }
      rt.set(name, r)
    }
    return r
  }

  /** Loaded on first use rather than at construction, and never twice: a
   *  write before the load would replace peers.json with an empty document. */
  const load = () => {
    if (doc) return
    doc = readPeers(dir, { hostname, now })
    asks = createAsksStore({ file: join(dir, ASKS_FILE), now })
    jobs = createJobsStore({ file: join(dir, JOBS_FILE), now })
    drops = createDrops({ dir, jobs, now, log, broadcast: broadcastIfChanged, roots: dropRoots, peerOf: dropPeerOf, dial: dropDial, chunkBytes })
  }

  /** What the drop engine may know of a peer: whether it is confirmed here,
   *  and whether this side dials it. */
  function dropPeerOf(name) {
    const p = doc ? recordNamed(name) : null
    return p ? { confirmed: !!p.confirmedAt, dials: !!p.address } : null
  }

  /** The drop engine's one way out: a signed request, pinned to the peer's
   *  certificate, to a confirmed peer this side dials, while peering runs.
   *  The record is read here, so the engine never holds a secret, a
   *  certificate or an address. Never throws. */
  async function dropDial({ peer, path, query = '', body, rawBody, rawResponse, maxResponse, timeoutMs }) {
    const rec = doc ? recordNamed(peer) : null
    if (stopped || !started || !doc?.enabled || !rec?.address || !rec.certPem || !rec.confirmedAt) {
      return { ok: false, status: 0, json: null, buf: null, rttMs: null, error: 'not dialling this peer' }
    }
    return dialPeer({
      host: rec.address.host, port: rec.address.port, fingerprint: rec.fingerprint, certPem: rec.certPem,
      secret: rec.secret, self: doc.self, now,
      path: query ? `${path}?${query}` : path, body, rawBody, rawResponse, maxResponse, timeoutMs,
    })
  }

  /** Disk first, memory second, so a write that throws leaves the engine
   *  holding exactly what the file still says. */
  const commit = (next) => {
    writePeers(dir, next)
    doc = next
    return next
  }

  const replaceRecord = (old, rec) => commit({ ...doc, peers: doc.peers.map((p) => (p === old ? rec : p)) })
  const recordNamed = (name) => doc.peers.find((p) => p.name === name) ?? null

  const localSessions = () => {
    try {
      return sessions()
    } catch (e) {
      log(`could not list sessions: ${e?.message ?? e}`)
      return []
    }
  }

  const burnPending = () => {
    if (!pending) return
    pending.token.fill(0)
    pending = null
  }

  const uniqueName = (base) => {
    const taken = new Set(doc.peers.map((p) => p.name))
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) {
      const suffix = '-' + n
      const candidate = base.slice(0, 32 - suffix.length) + suffix
      if (!taken.has(candidate)) return candidate
    }
  }

  // ---- what the pane sees -----------------------------------------------------

  /** The tag an applied action stores. Only an INCOMING ask can put work on this
   *  board, and the peer's name comes from the log, never from the pane. */
  const tagFor = (id) => {
    load()
    const e = typeof id === 'string' ? asks.get(id) : null
    return e && e.dir === 'in' ? sanitizeForPeer({ peer: e.peer, askId: e.id }) : null
  }

  function payload() {
    load()
    const t = now()
    const all = asks.all()
    const live = (name, dir) => all.filter((a) => a.peer === name && a.dir === dir && !isTerminalAsk(a.state)).length
    const dropsPayload = drops.payload()
    const list = doc.peers.map((p) => {
      const r = rt.get(p.name) ?? {}
      const jobCounts = dropsPayload.countsByPeer[p.name] ?? { jobsActive: 0, jobsFailed: 0 }
      return {
        name: p.name,
        remoteName: p.remoteName,
        dials: !!p.address,
        fingerprint: p.fingerprint,
        localFingerprint: doc.fingerprint,
        pairedAt: p.pairedAt,
        confirmedAt: p.confirmedAt,
        policy: { ...p.policy, autoApply: [...p.policy.autoApply] },
        health: healthOf({ dials: !!p.address, ...r, now: t, helloMs }),
        sessions: [...(r.roster ?? [])],
        counts: { asksIn: live(p.name, 'in'), asksOut: live(p.name, 'out'), jobsActive: jobCounts.jobsActive, jobsFailed: jobCounts.jobsFailed },
      }
    })
    const newest = [...all].sort((a, b) => (b.t ?? 0) - (a.t ?? 0)).slice(0, ASKS_IN_PAYLOAD)
    return {
      enabled: doc.enabled,
      self: doc.self,
      bind: envBind ?? doc.bind,
      port: boundPort ?? envPort ?? doc.port,
      listening: !!listener,
      error: lastError,
      fingerprint: doc.fingerprint,
      pairing: pending && t < pending.expiresAt ? { expiresAt: pending.expiresAt } : null,
      list,
      asks: newest.map((e) => ({
        id: e.id,
        askId: e.askId,
        peer: e.peer,
        dir: e.dir,
        text: e.text,
        reply: e.reply,
        error: e.error,
        state: e.state,
        t: e.t,
        elapsedMs: Number.isFinite(e.t) ? (isTerminalAsk(e.state) ? (e.answeredAt ?? e.updatedAt ?? t) : t) - e.t : 0,
        actionsProposed: e.actionsProposed,
        costUsd: e.costUsd,
        origin: e.origin,
        proposals: (e.proposals ?? []).map(({ kind, mode, state, risk, error }) => ({ kind, mode, state, risk, error })),
      })),
      jobs: dropsPayload.jobs,
    }
  }

  /** Health is a function of the clock, so a payload can change with nothing
   *  having happened; comparing the serialised form is what keeps the stream
   *  from repeating an identical frame. */
  const broadcastIfChanged = () => {
    const data = payload()
    const text = JSON.stringify(data)
    if (text === lastSent) return
    lastSent = text
    try {
      broadcast('peers', data)
    } catch (e) {
      log(`broadcast failed: ${e?.message ?? e}`)
    }
  }

  // ---- the listener's side ----------------------------------------------------

  /** Every record calling itself by that name is tried, because two different
   *  peers may. With no candidate the HMAC is still computed once, so an
   *  unknown name costs what a wrong signature costs. The replay guard runs
   *  only after a signature verifies, so a forgery cannot burn a nonce. */
  function authenticate({ method, path, query, headers, rawBody }) {
    const name = headers['x-szg-peer']
    const candidates = validName(name) ? doc.peers.filter((p) => p.remoteName === name) : []
    const bodySha256 = sha256hex(rawBody)
    let found = null
    if (candidates.length === 0) {
      verifySignature({ secret: null, method, path, query, headers, bodySha256 })
    } else {
      for (const p of candidates) {
        if (verifySignature({ secret: Buffer.from(p.secret, 'hex'), method, path, query, headers, bodySha256 })) {
          found = p
          break
        }
      }
    }
    if (!found) {
      log(`signature did not verify for ${quote(name)}`)
      return null
    }
    const fresh = guard.check(headers['x-szg-ts'], headers['x-szg-nonce'])
    if (!fresh.ok) {
      log(`request from ${quote(name)} refused by the replay guard: ${fresh.reason}`)
      return null
    }
    return found
  }

  /** The one unsigned route. Every refusal is the listener's empty 404 and its
   *  reason goes to the log; only the rate limit answers differently. */
  function pairRoute({ body, remoteAddress }) {
    const key = remoteAddress || 'unknown'
    const hit = limiter.hit(key, now())
    if (!hit.ok) {
      log(`pairing attempts from ${quote(key)} over the limit`)
      return { status: 429, headers: { 'retry-after': String(hit.retryAfterSec) } }
    }
    const refuse = (reason) => {
      log(`pairing refused: ${reason}`)
      return null
    }
    if (!pending) return refuse('no code is outstanding')
    if (now() >= pending.expiresAt) return refuse('the code has expired')
    if (!validName(body.name)) return refuse('the name is not valid')
    if (!fpBytes(body.fp)) return refuse('the fingerprint is not valid')
    const fp = body.fp.toUpperCase()
    if (fpEqual(fp, doc.fingerprint)) return refuse("the fingerprint is this instance's own")
    if (!hexEqual(body.proof, pairProof(pending.token, doc.fingerprint, fp))) return refuse('the proof did not match')

    const { token } = pending
    pending = null
    const secret = derivePairSecret(token, doc.fingerprint, fp)
    const ack = pairAck(token, fp, doc.fingerprint)
    token.fill(0)
    if (!secret) return refuse('no secret could be derived')

    const existing = doc.peers.find((p) => fpEqual(p.fingerprint, fp)) ?? null
    const rec = {
      name: existing ? existing.name : uniqueName(body.name),
      remoteName: body.name,
      address: null,
      fingerprint: fp,
      certPem: null,
      secret: secret.toString('hex'),
      pairedAt: now(),
      confirmedAt: null,
      policy: { ...DEFAULT_POLICY },
    }
    secret.fill(0)
    commit({ ...doc, peers: existing ? doc.peers.map((p) => (p === existing ? rec : p)) : [...doc.peers, rec] })
    limiter.clear(key)
    broadcastIfChanged()
    return { status: 200, json: { name: doc.self, ack } }
  }

  /** The dialled side of the heartbeat: the only proof it has that the other
   *  side is alive, and its only chance to send anything back. */
  function helloRoute({ peer, body, headers, receivedAt }) {
    if (!doc.peers.includes(peer)) return null
    const r = rtOf(peer.name)
    r.lastInboundAt = receivedAt
    r.skewMs = receivedAt - Number(headers['x-szg-ts'])
    r.roster = peer.confirmedAt ? ghostRoster(body.roster) : []
    const answer = { roster: peer.confirmedAt ? ghostRoster(localSessions(), { peer: peer.name }) : [], jobDeltas: [], outbound: [], now: now() }
    if (peer.confirmedAt) {
      // Heard first, so an edge the dialler's report settles is in this answer.
      drops.applyDeltas(peer.name, body.jobDeltas)
      answer.jobDeltas = drops.jobDeltasFor(peer.name)
      // `ackedTo` is the highest sequence number the dialler has handled, so
      // everything up to it is delivered and an ask among it has been sent.
      const acked = Number.isInteger(body.ackedTo) ? body.ackedTo : 0
      for (const e of asks.ackOutbound(peer.name, acked)) {
        if (e.dir === 'out' && e.state === 'queued') asks.transition(e.id, 'sent')
      }
      answer.outbound = outboundItems(asks.outboundFor(peer.name, acked), MAX_PEER_BODY - byteLength(answer) - BODY_SLACK)
    }
    broadcastIfChanged()
    return { status: 200, json: answer }
  }

  // ---- asks ---------------------------------------------------------------------
  //
  // An ask is one entry in each side's ask log: `out` where it was typed, `in`
  // where it is answered. The side that dials sends its asks and replies by
  // direct POST. The side that is dialled gives each one a sequence number
  // instead, and they ride back on heartbeat responses until the dialler
  // acknowledges them. A repeat is harmless either way: an incoming ask is
  // recorded once per askId, and a reply to an ask already settled is ignored.
  //
  // Incoming asks are answered one at a time, oldest first, by the
  // orchestrator's liaison turn. The asking side learns the reply text, the
  // error and how many actions the turn proposed -- never the actions, which
  // stay with the board they would act on.

  /** Ids of incoming asks waiting for a turn, oldest first. */
  let inQueue = []
  let pumping = false
  let wake = null
  /** Entries a direct POST is carrying right now, so two overlapping flushes
   *  cannot send one twice. */
  const inFlight = new Set()

  const byteLength = (v) => Buffer.byteLength(JSON.stringify(v))
  const waiting = (e) => !!e && e.dir === 'in' && (e.state === 'received' || e.state === 'queued')

  /** Halves the text until the item fits. A body the other side's listener
   *  refuses would be sent again every heartbeat and never arrive, and a
   *  heartbeat response the dialler refuses would take the heartbeat down
   *  with it. */
  const fit = (item, max) => {
    let it = item
    while (byteLength(it) > max && it.text.length > 0) it = { ...it, text: it.text.slice(0, Math.floor(it.text.length / 2)) }
    return it
  }

  const replyBody = (e) => ({
    askId: e.askId,
    text: (e.reply ?? '').slice(0, REPLY_MAX),
    actionsProposed: e.actionsProposed,
    error: typeof e.error === 'string' ? e.error.slice(0, ERROR_MAX) : null,
  })

  /** At most OUTBOUND_MAX items, and only as many as fit in `budget` bytes;
   *  the first always goes, clipped if it has to be, so one long reply cannot
   *  hold up the queue behind it. */
  const outboundItems = (entries, budget) => {
    const items = []
    let size = 2
    for (const e of entries.slice(0, OUTBOUND_MAX)) {
      const item = fit(
        e.dir === 'out'
          ? { seq: e.outSeq, kind: 'ask', askId: e.askId, text: e.text }
          : { seq: e.outSeq, kind: 'reply', ...replyBody(e) },
        budget,
      )
      const n = byteLength(item) + 1
      if (items.length > 0 && size + n > budget) break
      items.push(item)
      size += n
    }
    return items
  }

  /** The next retry is due when the earliest waiting entry's attempt is. Not
   *  scheduled while peering is off: enabling pumps again. */
  const scheduleWake = () => {
    if (wake) clearTimeout(wake)
    wake = null
    if (stopped || !doc?.enabled) return
    const due = inQueue.map((id) => asks.get(id)?.nextAttemptAt).filter((v) => Number.isFinite(v))
    if (!due.length) return
    wake = setTimeout(() => { wake = null; pump() }, Math.max(0, Math.min(...due) - now()) + 1)
    wake.unref()
  }

  /** One runner at a time. A call made while one runs returns at once: the
   *  running loop reads the queue again after every turn, so an entry pushed
   *  meanwhile is not missed. Never rejects. */
  async function pump() {
    if (pumping) return
    pumping = true
    try {
      for (;;) {
        if (stopped || !started || !doc?.enabled) break
        inQueue = inQueue.filter((id) => waiting(asks.get(id)))
        const t = now()
        const i = inQueue.findIndex((id) => {
          const at = asks.get(id).nextAttemptAt
          return at === null || at <= t
        })
        if (i === -1) break
        const [id] = inQueue.splice(i, 1)
        try {
          await answer(asks.get(id))
        } catch (e) {
          log(`answering ask ${id} failed: ${e?.message ?? e}`)
        }
      }
    } finally {
      pumping = false
    }
    scheduleWake()
  }

  /** One liaison turn for one incoming ask. The entry is read again after the
   *  turn, because a forget or the stall sweep may have moved it meanwhile. */
  async function answer(e) {
    const record = recordNamed(e.peer)
    if (!record) {
      // A forgotten peer's ask is never answered: there is nobody to reply to.
      asks.transition(e.id, 'failed', { error: 'the peer was forgotten', answeredAt: now() })
      broadcastIfChanged()
      return
    }
    // A released ask was let through by a person, so the cap does not apply.
    if (!e.override) {
      const cap = capCheck({ asks: asks.all(), peer: e.peer, now: now(), policy: record.policy })
      if (!cap.ok) {
        asks.transition(e.id, 'held', { error: cap.reason })
        broadcastIfChanged()
        return
      }
    }
    asks.transition(e.id, 'answering', { startedAt: e.startedAt ?? now(), attempts: e.attempts + 1, nextAttemptAt: null })
    broadcastIfChanged()

    let r
    try {
      r = orchestrator ? await orchestrator.liaisonAsk(e.text, { peer: e.peer, askId: e.id, policy: record.policy }) : { ok: false, code: 503, error: 'no orchestrator' }
    } catch (err) {
      r = { ok: false, code: 500, error: String(err?.message ?? err) }
    }
    // An engine that stopped mid-turn leaves the entry answering on disk, and
    // the next start queues it again.
    if (stopped) return
    const cur = asks.get(e.id)
    if (!cur || cur.state !== 'answering') return

    if (r?.ok === false && r.code === 409) {
      // Busy, or a local ask took the slot: wait for the next step of the
      // ladder, and past its last step hold the ask for a person to release.
      if (cur.attempts <= retry.length) {
        asks.transition(cur.id, 'queued', { nextAttemptAt: now() + retry[cur.attempts - 1] })
        inQueue.push(cur.id)
      } else {
        // A running turn has no edge straight to held; it goes back in line
        // first, and out of it into held.
        asks.transition(cur.id, 'queued', { nextAttemptAt: null })
        asks.transition(cur.id, 'held', { error: 'the orchestrator stayed busy' })
      }
    } else if (r?.ok !== true) {
      asks.transition(cur.id, 'failed', { error: String(r?.error ?? 'the turn did not run').slice(0, ERROR_MAX), answeredAt: now() })
      deliverReply(cur)
    } else if (r.error) {
      // The turn ran and failed; its partial text still goes back.
      asks.transition(cur.id, 'failed', {
        reply: typeof r.text === 'string' ? r.text : '',
        error: String(r.error).slice(0, ERROR_MAX),
        costUsd: r.costUsd,
        answeredAt: now(),
      })
      deliverReply(cur)
    } else {
      asks.transition(cur.id, 'answered', {
        reply: typeof r.text === 'string' ? r.text : '',
        error: null,
        actionsProposed: Array.isArray(r.actions) ? r.actions.length : 0,
        costUsd: r.costUsd,
        answeredAt: now(),
      })
      deliverReply(cur)
    }
    broadcastIfChanged()
  }

  /** A dialler sends the reply now; a dialled side queues it for the next
   *  heartbeat. A peer forgotten during the turn gets nothing. */
  function deliverReply(e) {
    const record = recordNamed(e.peer)
    if (!record) return
    if (record.address) setImmediate(() => { flushOut(record) })
    else asks.enqueueOutbound(e.id)
  }

  /** The dialling side's outbound: every ask of this peer's not yet accepted,
   *  and every reply to it not yet delivered, each by its own POST. Anything
   *  that fails stays as it is for the next heartbeat. Never rejects. */
  async function flushOut(p) {
    try {
      const rec = recordNamed(p.name)
      if (stopped || !doc.enabled || !rec?.address || !rec.certPem || !rec.confirmedAt) return
      const { host, port } = rec.address
      const due = asks.all().filter((e) => e.peer === rec.name && e.outSeq === null && !inFlight.has(e.id) &&
        ((e.dir === 'out' && e.state === 'queued') || (e.dir === 'in' && isTerminalAsk(e.state) && !e.delivered)))
      for (const e of due) {
        if (stopped) break
        const isAsk = e.dir === 'out'
        inFlight.add(e.id)
        try {
          const res = await dialPeer({
            host, port, fingerprint: rec.fingerprint, certPem: rec.certPem, secret: rec.secret, self: doc.self, now,
            path: isAsk ? '/peer/ask' : '/peer/ask/reply',
            body: isAsk ? { askId: e.askId, text: e.text } : fit(replyBody(e), MAX_PEER_BODY - BODY_SLACK),
          })
          const cur = asks.get(e.id)
          if (!res.ok || !cur || cur.peer !== rec.name) continue
          // A reply may have settled the ask while this POST was out.
          if (isAsk && cur.state === 'queued' && isPlainObject(res.json) && res.json.accepted === true) asks.transition(cur.id, 'sent')
          if (!isAsk) asks.set(cur.id, { delivered: true })
        } finally {
          inFlight.delete(e.id)
        }
      }
      broadcastIfChanged()
    } catch (err) {
      log(`sending asks to ${quote(p.name)} failed: ${err?.message ?? err}`)
    }
  }

  /** An ask from a peer, by POST or on a heartbeat response. Refused unless
   *  this side has confirmed the peer. A repeat of an askId already recorded
   *  is accepted and changes nothing, because the sender cannot tell a lost
   *  answer from a lost request and sends again. */
  function receiveAsk(peer, body) {
    if (!peer.confirmedAt || !isPlainObject(body)) return false
    const { askId, text } = body
    if (typeof askId !== 'string' || !ASK_ID_RE.test(askId)) return false
    if (typeof text !== 'string' || text.length === 0 || text.length > ASK_TEXT_MAX) return false
    if (asks.find(peer.name, 'in', askId)) return true
    const e = asks.create({ peer: peer.name, dir: 'in', askId, text })
    inQueue.push(e.id)
    pump()
    broadcastIfChanged()
    return true
  }

  /** A reply to an ask this side sent. Only the count of proposed actions is
   *  kept. An unknown askId, or one already settled, is ignored. */
  function applyReply(peer, body) {
    if (!isPlainObject(body) || typeof body.askId !== 'string') return false
    const e = asks.find(peer.name, 'out', body.askId)
    if (!e || isTerminalAsk(e.state)) return false
    const failed = typeof body.error === 'string' && body.error !== ''
    asks.transition(e.id, failed ? 'failed' : 'answered', {
      reply: typeof body.text === 'string' ? body.text.slice(0, REPLY_MAX) : '',
      error: failed ? body.error.slice(0, ERROR_MAX) : null,
      actionsProposed: Number.isInteger(body.actionsProposed) && body.actionsProposed >= 0 ? body.actionsProposed : 0,
      answeredAt: now(),
    })
    broadcastIfChanged()
    return true
  }

  function askRoute({ peer, body }) {
    if (!doc.peers.includes(peer) || !receiveAsk(peer, body)) return null
    return reply(200, { accepted: true })
  }

  /** Always the same answer, so a probe with a stolen signature learns
   *  nothing about which askIds exist. */
  function askReplyRoute({ peer, body }) {
    if (doc.peers.includes(peer)) applyReply(peer, body)
    return reply(200, { ok: true })
  }

  /** A drop route answers only a peer still on record; everything past that
   *  is the drop engine's to decide, by the peer's local name. */
  const dropRoute = (fn) => ({ peer, body, query }) => (doc.peers.includes(peer) ? fn({ peer: peer.name, body, query }) : null)

  const handler = createPeerHandler({
    routes: {
      pair: pairRoute,
      hello: helloRoute,
      ask: askRoute,
      askReply: askReplyRoute,
      dropOffer: dropRoute((a) => drops.onOffer(a)),
      dropChunk: dropRoute((a) => drops.onChunk(a)),
      dropCommit: dropRoute((a) => drops.onCommit(a)),
      dropManifest: dropRoute((a) => drops.onManifest(a)),
      dropPull: dropRoute((a) => drops.onPull(a)),
    },
    authenticate,
    log,
    now,
  })

  /** Handles the items a responder's outbound queue sent back on a heartbeat.
   *  Every well-formed item is acknowledged, handled or refused, so one bad
   *  item cannot be sent again forever and hold up the rest. */
  function processOutbound(p, items) {
    if (!Array.isArray(items)) return
    const r = rtOf(p.name)
    for (const item of items) {
      if (!isPlainObject(item) || !Number.isInteger(item.seq)) continue
      try {
        if (item.kind === 'ask') receiveAsk(p, item)
        else if (item.kind === 'reply') applyReply(p, item)
      } catch (e) {
        log(`an item from ${quote(p.name)} failed: ${e?.message ?? e}`)
      }
      r.ackedTo = Math.max(r.ackedTo, item.seq)
    }
  }

  // ---- the local ask routes -----------------------------------------------------

  /** A dry run signs exactly what would be sent, with a real timestamp and
   *  nonce, and sends, stores and broadcasts nothing. */
  function localAsk(name, { text, dryRun, origin, forAsk }) {
    const p = recordNamed(name)
    if (!p) return reply(404, { error: 'no such peer' })
    if (!p.confirmedAt) return reply(409, { error: 'confirm the fingerprints first' })
    const t = typeof text === 'string' ? text.trim() : ''
    if (!t || t.length > ASK_TEXT_MAX) return reply(400, { error: `an ask needs text, at most ${ASK_TEXT_MAX} characters` })
    if (dryRun === true) {
      // Built through the wire tap, so the preview is what would actually leave.
      const body = JSON.stringify(previewOutbound('/peer/ask', { askId: '<assigned when sent>', text: t }, p.fingerprint))
      const key = Buffer.from(p.secret, 'hex')
      const signed = signRequest({ secret: key, self: doc.self, method: 'POST', path: '/peer/ask', body, now: now() })
      key.fill(0)
      return reply(200, { envelope: { method: 'POST', path: '/peer/ask', canonical: signed.canonical, headers: signed.headers, bodySha256: signed.bodySha256, body } })
    }
    // An agent's ask counts against the peer's hourly allowance; a person's
    // ask from the Peering tab never does.
    const agent = origin === 'agent'
    if (agent) {
      const cap = peerAskCap({ asks: asks.all(), peer: p.name, now: now(), perHour: p.policy.peerAsksPerHour })
      if (!cap.ok) return reply(409, { error: `${p.name} has had its ${p.policy.peerAsksPerHour} peer_ask(s) for this hour — use the ask box on the Peering tab` })
    }
    const e = asks.create({ peer: p.name, dir: 'out', text: t, origin: agent ? 'agent' : 'person', forPeer: typeof forAsk === 'string' ? tagFor(forAsk) : null })
    if (p.address) setImmediate(() => { flushOut(p) })
    else asks.enqueueOutbound(e.id)
    broadcastIfChanged()
    return reply(200, { ok: true, id: e.id, askId: e.askId, state: e.state })
  }

  // ---- the action gate ----------------------------------------------------
  //
  // The orchestrator hands every turn's proposals here before it shows them.
  // A local turn may send a peer_ask to a sanctioned peer; a liaison turn for a
  // sanctioned peer may apply the kinds that peer's policy lists. Everything
  // else stays a button for the person here to press.

  const countLive = (name) => {
    try { return Number(liveForPeer(name)) || 0 } catch (e) { log(`could not count live sessions: ${e?.message ?? e}`); return 0 }
  }

  function gate({ source, turnId = null, threadId = null, askId = null, actions } = {}) {
    const list = Array.isArray(actions) ? actions : []
    if (!list.length || !started || stopped) return list
    load()
    let decisions = []
    let entry = null
    if (source === 'ask') {
      // Counted per peer across this turn too, so one turn cannot overrun the
      // hourly allowance with several peer_asks at once.
      const extra = new Map()
      decisions = list.map((a) => {
        if (a?.kind !== 'peer_ask') return { gate: 'button', gateNote: null }
        const rec = typeof a.peer === 'string' ? recordNamed(a.peer) : null
        if (!rec) return { gate: 'button', gateNote: 'no such peer' }
        const base = peerAskCap({ asks: asks.all(), peer: rec.name, now: now(), perHour: rec.policy.peerAsksPerHour }).count
        const [d] = gateActions({
          source, trust: rec.policy.trust, confirmed: !!rec.confirmedAt,
          peerAskCount: base + (extra.get(rec.name) ?? 0), peerAsksPerHour: rec.policy.peerAsksPerHour, actions: [a],
        })
        if (d.gate === 'auto') extra.set(rec.name, (extra.get(rec.name) ?? 0) + 1)
        return d
      })
    } else if (source === 'liaison') {
      entry = typeof askId === 'string' ? asks.get(askId) : null
      const rec = entry && entry.dir === 'in' ? recordNamed(entry.peer) : null
      if (!rec) return list
      decisions = gateActions({
        source, trust: rec.policy.trust, autoApply: rec.policy.autoApply,
        liveForPeer: countLive(rec.name), autoApplyMaxLive: rec.policy.autoApplyMaxLive, actions: list,
      })
    } else {
      return list
    }
    const autos = decisions.flatMap((d, i) => (d.gate === 'auto' ? [i] : []))
    if (entry && autos.length) {
      asks.set(entry.id, { proposals: autos.map((i) => ({
        index: i, kind: list[i].kind, action: list[i], risk: list[i].risk ?? null,
        mode: 'auto', state: 'applying', error: null, gateNote: null, at: now(),
      })) })
      broadcastIfChanged()
    }
    if (autos.length) runApplies({ turnId, threadId, entry, list, autos }).catch((e) => log(`automatic applies failed: ${e?.message ?? e}`))
    return list.map((a, i) => ({ ...a, gate: decisions[i].gate, ...(decisions[i].gateNote ? { gateNote: decisions[i].gateNote } : {}) }))
  }

  /** Whether an apply the gate allowed still stands against the record as it
   *  is now. A person may set the peer back to manual, take the kind off its
   *  list or forget the peer while an earlier apply of the same turn runs. */
  const stillAllowed = (entry, action) => {
    const rec = entry ? recordNamed(entry.peer) : typeof action?.peer === 'string' ? recordNamed(action.peer) : null
    if (!rec || rec.policy.trust !== 'sanctioned') return false
    return entry ? rec.policy.autoApply.includes(action?.kind) : true
  }

  /** The automatic applies of one turn, in order, each checked against the
   *  peer's record again just before it runs. Each outcome lands on the ask's
   *  proposal record, and one frame tells the transcript which buttons
   *  applied. */
  async function runApplies({ turnId, threadId, entry, list, autos }) {
    const results = []
    const settle = (i, ok, error) => {
      results.push({ index: i, ok, error })
      const cur = entry ? asks.get(entry.id) : null
      if (cur) asks.set(cur.id, { proposals: (cur.proposals ?? []).map((p) => (p.index === i ? { ...p, state: ok ? 'applied' : 'failed', error } : p)) })
    }
    for (const i of autos) {
      if (stopped) break
      if (!stillAllowed(entry, list[i])) {
        settle(i, false, 'policy changed')
        continue
      }
      let out
      try {
        out = await applyAction(list[i], { peer: entry?.peer ?? null, forAsk: entry?.id ?? null })
      } catch (e) {
        out = { ok: false, error: String(e?.message ?? e) }
      }
      const ok = out?.ok === true
      settle(i, ok, ok ? null : String(out?.error ?? 'the apply failed').slice(0, ERROR_MAX))
    }
    if (stopped) {
      // An apply that never ran is failed rather than left applying, and
      // nothing is published once the engine has stopped.
      const ran = new Set(results.map((r) => r.index))
      const cur = entry ? asks.get(entry.id) : null
      if (cur) {
        asks.set(cur.id, { proposals: (cur.proposals ?? []).map((p) => (
          autos.includes(p.index) && !ran.has(p.index) ? { ...p, state: 'failed', error: 'the relay stopped' } : p)) })
      }
      return
    }
    broadcastIfChanged()
    try {
      broadcast('orchestrator', { id: turnId, ...(threadId ? { threadId } : {}), ...(entry ? { peer: entry.peer, askId: entry.id } : {}), applied: results })
    } catch (e) {
      log(`could not report automatic applies: ${e?.message ?? e}`)
    }
  }

  // ---- the local drop route -------------------------------------------------

  /** Refuses an unknown or unconfirmed peer exactly the way `localAsk` does,
   *  then hands the paths to the drop engine. Everything past that -- the
   *  path validation, the job, the staging copy -- is `drops`'s, not this
   *  router's. */
  function localDrop(name, { paths, note, pinned }) {
    const p = recordNamed(name)
    if (!p) return reply(404, { error: 'no such peer' })
    if (!p.confirmedAt) return reply(409, { error: 'confirm the fingerprints first' })
    return drops.offer({ peer: p.name, paths, note, pinned })
  }

  /** The dry run names a peer on the filter's argv but sends that peer
   *  nothing, so a peer whose fingerprints are not confirmed yet may be named. */
  function filterTest({ peer, paths, note }) {
    const p = typeof peer === 'string' ? recordNamed(peer) : null
    if (!p) return reply(404, { error: 'no such peer' })
    return drops.filterTest({ peer: p.name, paths, note })
  }

  function cancelJob(body) { return drops.cancel(body) }
  function pinJob(body) { return drops.pin(body) }
  /** Copy-into: the destination is the local person's pick, held by the
   *  engine to the known worktree roots. */
  function copyJob(body) { return drops.copyInto(body) }

  /** Releasing a held ask lets it past the caps, for that ask only, and gives
   *  it the whole retry ladder again, so one busy slot cannot re-hold it. */
  function releaseAsk({ id }) {
    const e = typeof id === 'string' ? asks.get(id) : null
    if (!e || e.dir !== 'in' || e.state !== 'held') return reply(409, { error: 'only a held ask can be released' })
    asks.transition(e.id, 'received', { override: true, error: null, attempts: 0 })
    if (!inQueue.includes(e.id)) inQueue.push(e.id)
    pump()
    broadcastIfChanged()
    return reply(200, { ok: true })
  }

  /** A turn that was running when the engine last stopped never finished, so
   *  it is queued again, and every ask that was waiting waits again, oldest
   *  first. Published before any turn starts. */
  const resumeAsks = () => {
    for (const e of asks.all()) {
      if (e.dir === 'in' && e.state === 'answering') asks.transition(e.id, 'queued', { nextAttemptAt: null })
    }
    inQueue = asks.all().filter(waiting).sort((a, b) => (a.t ?? 0) - (b.t ?? 0)).map((e) => e.id)
    broadcastIfChanged()
    pump()
  }

  // ---- enable and disable -----------------------------------------------------

  const stopListener = async () => {
    const l = listener
    listener = null
    listenerBind = null
    listenerPort = null
    boundPort = null
    if (l) await l.stop()
  }

  /** `bind` and `port` from the environment override what the pane sent, but
   *  what is saved is what the pane sent: an override is not a setting. */
  async function doEnable({ enabled, bind, port, self }) {
    if (self != null && !validName(self)) return reply(400, { error: NAME_ERROR })
    if (typeof enabled !== 'boolean') return reply(400, { error: 'enabled must be true or false' })
    const nextSelf = self ?? doc.self

    if (enabled === false) {
      await stopListener()
      burnPending()
      lastError = null
      commit({ ...doc, enabled: false, self: nextSelf })
      broadcastIfChanged()
      return reply(200, { ok: true, peers: payload() })
    }

    if (bind != null && !validBind(bind, { allowAny }).ok) return reply(400, { error: bindError(bind) })
    const effectiveBind = envBind ?? bind ?? doc.bind
    if (!validBind(effectiveBind, { allowAny }).ok) return reply(400, { error: bindError(effectiveBind) })
    const portError = (p) => `cannot listen on port ${quote(p)}: a port is an integer from 0 to 65535`
    if (port != null && !validPort(port)) return reply(400, { error: portError(port) })
    const effectivePort = envPort ?? port ?? doc.port ?? DEFAULT_PEER_PORT
    if (!validPort(effectivePort)) return reply(400, { error: portError(effectivePort) })

    let cert
    try {
      cert = await ensureCert({ dir, bind: effectiveBind, run, opensslBin })
    } catch (e) {
      lastError = e?.message ?? String(e)
      broadcastIfChanged()
      return reply(503, { error: lastError })
    }

    if (listener && (listenerBind !== effectiveBind || listenerPort !== effectivePort)) await stopListener()
    let fresh = false
    if (!listener) {
      const l = createPeerListener({ keyPem: cert.keyPem, certPem: cert.certPem, bind: effectiveBind, port: effectivePort, handler, log })
      try {
        boundPort = await l.start()
      } catch (e) {
        lastError = `could not listen on ${effectiveBind}:${effectivePort}: ${e?.code || e?.message || e}`
        broadcastIfChanged()
        return reply(409, { error: lastError })
      }
      listener = l
      listenerBind = effectiveBind
      listenerPort = effectivePort
      fresh = true
    }

    commit({
      ...doc,
      enabled: true,
      bind: bind ?? doc.bind ?? effectiveBind,
      port: port ?? doc.port ?? effectivePort,
      fingerprint: cert.fingerprint,
      self: nextSelf,
    })
    lastError = null
    if (fresh) log(`peer listener on https://${urlHost(effectiveBind)}:${boundPort}`)
    broadcastIfChanged()
    // Asks that waited while peering was off are answered now.
    pump()
    return reply(200, { ok: true, peers: payload() })
  }

  /** One enable at a time, so two overlapping requests cannot both construct
   *  a listener. */
  const enable = (body) => {
    const job = enabling.then(() => doEnable(body))
    enabling = job.catch(() => {})
    return job
  }

  // ---- pairing and the per-peer controls --------------------------------------

  function pairOffer({ host }) {
    if (!listener) return reply(409, { error: 'enable peering first' })
    // The listener's bind is a valid address, so the only reason it can fail
    // the strict check is that it is a wildcard.
    const bindIsWild = !validBind(listenerBind, { allowAny: false }).ok
    const h = typeof host === 'string' && host.trim() ? host.trim() : bindIsWild ? null : listenerBind
    if (h === null) return reply(400, { error: 'this listener is bound to every interface; say which address the other side should dial' })
    if (h.length > HOST_MAX) return reply(400, { error: `host must be at most ${HOST_MAX} characters` })
    burnPending()
    pending = { token: randomBytes(32), expiresAt: now() + PAIR_TOKEN_MS }
    const code = formatPairCode({ host: h, port: boundPort, fp: doc.fingerprint, token: pending.token })
    broadcastIfChanged()
    return reply(200, { code, expiresAt: pending.expiresAt, fingerprint: doc.fingerprint })
  }

  async function pairAccept({ code, name }) {
    if (!doc.enabled || !doc.fingerprint) return reply(409, { error: 'enable peering first' })
    const parsed = parsePairCode(code)
    if (!parsed) return reply(400, { error: 'that is not a pairing code' })
    try {
      if (!validName(name)) return reply(400, { error: NAME_ERROR })
      const taken = () => reply(409, { error: `a peer named ${name} already exists` })
      if (recordNamed(name)) return taken()
      if (fpEqual(parsed.fp, doc.fingerprint)) return reply(400, { error: "that code is this instance's own" })

      const { host, port, fp, token } = parsed
      const cert = await fetchPeerCert({ host, port, fingerprint: fp })
      if (!cert.ok) return reply(502, { error: `could not reach ${host}:${port} with that fingerprint (${cert.error})` })
      const r = await dialPeer({
        host, port, fingerprint: fp, certPem: cert.pem, path: '/peer/pair', now,
        body: { name: doc.self, fp: doc.fingerprint, proof: pairProof(token, fp, doc.fingerprint) },
      })
      if (!r.ok) return reply(502, { error: 'the other side refused the code (it may have expired or already been used)' })
      const answer = isPlainObject(r.json) ? r.json : {}
      if (!hexEqual(answer.ack, pairAck(token, doc.fingerprint, fp)) || !validName(answer.name)) {
        return reply(502, { error: 'the other side did not prove it holds the code' })
      }
      // Two accepts under one name can overlap across the awaits above.
      if (recordNamed(name)) return taken()

      const secret = derivePairSecret(token, fp, doc.fingerprint)
      if (!secret) return reply(502, { error: 'the other side did not prove it holds the code' })
      const rec = {
        name,
        remoteName: answer.name,
        address: { host, port },
        fingerprint: fp,
        certPem: cert.pem,
        secret: secret.toString('hex'),
        pairedAt: now(),
        confirmedAt: null,
        policy: { ...DEFAULT_POLICY },
      }
      secret.fill(0)
      commit({ ...doc, peers: [...doc.peers, rec] })
      broadcastIfChanged()
      setImmediate(() => { tick() })
      return reply(200, { ok: true, name, fingerprint: fp, localFingerprint: doc.fingerprint })
    } finally {
      parsed.token.fill(0)
    }
  }

  function pairConfirm({ name }) {
    const p = recordNamed(name)
    if (!p) return reply(404, { error: 'no such peer' })
    replaceRecord(p, { ...p, confirmedAt: now() })
    broadcastIfChanged()
    return reply(200, { ok: true })
  }

  function forget({ name }) {
    const p = recordNamed(name)
    if (!p) return reply(404, { error: 'no such peer' })
    commit({ ...doc, peers: doc.peers.filter((x) => x !== p) })
    rt.delete(p.name)
    asks.markForgotten(p.name)
    broadcastIfChanged()
    return reply(200, { ok: true })
  }

  /** A peer that moved keeps its pairing: only where this side dials it
   *  changes. The pinned fingerprint still has to answer at the new address,
   *  so a wrong one reads down rather than reaching anyone else. */
  function setAddress({ name, host, port }) {
    const p = recordNamed(name)
    if (!p) return reply(404, { error: 'no such peer' })
    if (!p.address) return reply(409, { error: `${name} dials this side, so there is no address to change` })
    if (!validBind(host).ok) return reply(400, { error: 'host must be an IP address, and not a wildcard' })
    if (!Number.isInteger(port) || port < 1 || port > 65535) return reply(400, { error: 'port must be an integer from 1 to 65535' })
    replaceRecord(p, { ...p, address: { host, port } })
    broadcastIfChanged()
    setImmediate(() => { tick() })
    return reply(200, { ok: true })
  }

  /** A validated merge: what the local person sent replaces those fields, and
   *  everything else the record held stands. No peer route reaches this. */
  function setPolicy(body) {
    const p = typeof body?.name === 'string' ? recordNamed(body.name) : null
    if (!p) return reply(404, { error: 'no such peer' })
    const v = validatePolicyPatch(body)
    if (!v.ok) return reply(400, { error: v.error })
    const policy = { ...p.policy, ...v.patch }
    replaceRecord(p, { ...p, policy })
    broadcastIfChanged()
    return reply(200, { ok: true, policy })
  }

  // ---- the heartbeat ----------------------------------------------------------

  /** One dial to one peer. The record is looked up again after every await,
   *  because it may have been confirmed, re-paired or forgotten meanwhile. */
  const heartbeat = async (name) => {
    let p = recordNamed(name)
    if (!p?.address) return
    const fingerprint = p.fingerprint
    const current = () => {
      const x = recordNamed(name)
      return x && x.fingerprint === fingerprint ? x : null
    }
    const r = rtOf(name)
    const { host, port } = p.address

    if (!p.certPem) {
      const cert = await fetchPeerCert({ host, port, fingerprint })
      p = current()
      if (!p || rt.get(name) !== r) return
      if (!cert.ok) {
        r.lastErrAt = now()
        r.lastErr = cert.error
        return
      }
      const rec = { ...p, certPem: cert.pem }
      replaceRecord(p, rec)
      p = rec
    }

    const sentAt = now()
    const res = await dialPeer({
      host, port, fingerprint, certPem: p.certPem, path: '/peer/hello', secret: p.secret, self: doc.self, now,
      body: {
        roster: p.confirmedAt ? ghostRoster(localSessions(), { peer: p.name }) : [],
        jobDeltas: p.confirmedAt ? drops.jobDeltasFor(p.name) : [],
        ackedTo: r.ackedTo,
        now: sentAt,
      },
    })
    p = current()
    if (!p || rt.get(name) !== r) return
    if (res.ok) {
      const answer = isPlainObject(res.json) ? res.json : {}
      r.lastOkAt = now()
      r.rttMs = res.rttMs
      r.skewMs = Number.isFinite(answer.now) ? Math.round(answer.now - (sentAt + res.rttMs / 2)) : null
      r.roster = p.confirmedAt ? ghostRoster(answer.roster) : []
      if (p.confirmedAt) {
        drops.applyDeltas(p.name, answer.jobDeltas)
        // The other side answered, so any transfer with it that stopped
        // for want of an answer can go on.
        drops.resumeFor(p.name)
      }
      processOutbound(p, answer.outbound)
      await flushOut(p)
    } else {
      r.lastErrAt = now()
      r.lastErr = res.status ? `refused (${res.status})` : res.error
    }
  }

  const pass = async () => {
    try {
      if (!started || stopped) return
      if (pending && now() >= pending.expiresAt) burnPending()
      if (doc.enabled) {
        for (const name of doc.peers.filter((p) => p.address).map((p) => p.name)) {
          if (stopped) break
          await heartbeat(name)
        }
      }
      // Also when nothing was dialled: a dialled side's health turns down by
      // the clock alone, and that has to be published too.
      broadcastIfChanged()
    } catch (e) {
      log(`heartbeat failed: ${e?.message ?? e}`)
    }
  }

  /** At most one pass runs. A call made while one is running is promised the
   *  next pass rather than the current one, which may have read its peers
   *  before whatever the caller just changed. */
  function tick() {
    if (!running) {
      running = pass().finally(() => { running = null })
      return running
    }
    if (!queued) {
      queued = running.then(() => {
        queued = null
        return tick()
      })
    }
    return queued
  }

  // ---- lifecycle ----------------------------------------------------------------

  const flush = () => {
    load()
    asks.flush()
    jobs.flush()
  }

  async function start() {
    if (started) return
    load()
    started = true
    stopped = false
    resumeAsks()
    drops.start()
    if (doc.enabled) {
      try {
        const out = await enable({ enabled: true })
        if (out.status !== 200) {
          lastError = out.json.error
          log(`peering is enabled but the listener did not start: ${out.json.error}`)
          broadcastIfChanged()
        }
      } catch (e) {
        lastError = e?.message ?? String(e)
        log(`peering is enabled but the listener did not start: ${lastError}`)
      }
    }
    if (stopped) return
    timers = [
      setInterval(() => { if (!running) tick() }, helloMs),
      setInterval(() => {
        try { flush() } catch (e) { log(`could not save the ask log: ${e?.message ?? e}`) }
      }, FLUSH_MS),
      setInterval(() => {
        try {
          if (asks.sweepStalled().length) broadcastIfChanged()
        } catch (e) { log(`stall sweep failed: ${e?.message ?? e}`) }
        // Through the drop engine, so a job failed for stalling keeps no copy.
        drops.sweep().catch((e) => log(`stall sweep failed: ${e?.message ?? e}`))
      }, SWEEP_MS),
    ]
    for (const t of timers) t.unref()
  }

  async function stop() {
    stopped = true
    for (const t of timers) clearInterval(t)
    timers = []
    if (wake) clearTimeout(wake)
    wake = null
    await (queued ?? running)
    await enabling
    await stopListener()
    burnPending()
    // A filter still running is ended, and its job stays filtering on disk for
    // the next boot to run again.
    if (drops) await drops.stop()
    try {
      if (doc) flush()
    } catch (e) {
      log(`could not save the ask log: ${e?.message ?? e}`)
    }
    started = false
  }

  async function local(sub, body) {
    load()
    const b = isPlainObject(body) ? body : {}
    try {
      switch (sub) {
        case 'enable': return await enable(b)
        case 'pair/offer': return pairOffer(b)
        case 'pair/accept': return await pairAccept(b)
        case 'pair/confirm': return pairConfirm(b)
        case 'forget': return forget(b)
        case 'address': return setAddress(b)
        case 'policy': return setPolicy(b)
        case 'ask/answer': return releaseAsk(b)
        case 'filter/test': return await filterTest(b)
        case 'job/cancel': return cancelJob(b)
        case 'job/pin': return pinJob(b)
        case 'job/copy': return await copyJob(b)
        default: {
          const m = ASK_ROUTE_RE.exec(String(sub))
          if (m) return localAsk(m[1], b)
          const dm = DROP_ROUTE_RE.exec(String(sub))
          return dm ? localDrop(dm[1], b) : reply(404, { error: 'no such endpoint' })
        }
      }
    } catch (e) {
      log(`${quote(sub)} failed: ${e?.message ?? e}`)
      return reply(500, { error: e?.message ?? String(e) })
    }
  }

  return { start, stop, flush, payload, tagFor, local, tick, gate }
}
