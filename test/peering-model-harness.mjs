#!/usr/bin/env node
// The Peering tab's pure core: row building from wire heads, the ask log and
// job records, ordering, filters, pins, the detail record and the Telemetry
// summary line. No relay, no DOM -- fixed fixtures only.
//
// Run: node test/peering-model-harness.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// Loaded the way the pane loads it: a classic script evaluated with a window
// shim, so anything that only works as a module fails here as well.
const MCPRM = new Function('window', readFileSync(
  join(ROOT, 'syzygy', 'bridge', 'public', 'peering-model.js'), 'utf8') + '\nreturn MCPRM')({})

let pass = 0
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label) }

console.log('peering model')

ok('KIND_DIGITS names the nine row kinds a digit can pick', () => {
  assert.deepEqual(MCPRM.KIND_DIGITS, {
    '1': 'pair', '2': 'hello', '3': 'ask', '4': 'reply', '5': 'held',
    '6': 'action', '7': 'drop', '8': 'filter', '9': 'error',
  })
})

ok('fmtBytes', () => {
  assert.equal(MCPRM.fmtBytes(0), '0 B')
  assert.equal(MCPRM.fmtBytes(1536), '1.5 KB')
})

ok('arrowOf', () => {
  assert.equal(MCPRM.arrowOf('out'), '→')
  assert.equal(MCPRM.arrowOf('in'), '←')
  assert.equal(MCPRM.arrowOf('local'), '•')
})

// ---------------------------------------------------------------- wireRows

ok('wireRows maps a head to a row', () => {
  const head = {
    t: 100, dir: 'out', peer: 'bravo', route: '/peer/ask', kind: 'ask', status: 200,
    rttMs: 12, reqBytes: 50, resBytes: 30, reqClipped: false, resClipped: false,
    redactions: { n: 2, kinds: { home: 2 } }, safeguard: 'on', summary: 'ask: hello',
    repeats: 0, error: null, chunks: null,
  }
  assert.deepEqual(MCPRM.wireRows([head])[0], {
    key: 'w100', t: 100, source: 'wire', dir: 'out', peer: 'bravo', kind: 'ask',
    summary: 'ask: hello', bytes: 80, costUsd: null, redactions: 2, safeguard: 'on', ref: 100,
  })
})

// ----------------------------------------------------------------- askRows

// Every fixture ask's `askId` (the wire id) differs from its own `id` (the
// store id), on purpose: a join on the wrong field fails these on sight.
const heldAsk = {
  id: 'a1', askId: 'w-1111111111111111', peer: 'bravo', dir: 'in', text: 'do x', reply: '', error: 'rate limited',
  state: 'held', t: 500, elapsedMs: 1000, actionsProposed: 0, costUsd: null,
}
const inActionAsk = {
  id: 'a2', askId: 'w-2222222222222222', peer: 'bravo', dir: 'in', text: 'do y', reply: 'ok', error: null,
  state: 'answered', t: 600, elapsedMs: 500, actionsProposed: 2, costUsd: 0.01,
}
const outActionAsk = {
  id: 'a3', askId: 'w-3333333333333333', peer: 'bravo', dir: 'out', text: 'do z', reply: 'sure', error: null,
  state: 'answered', t: 700, elapsedMs: 200, actionsProposed: 2, costUsd: null,
}
const failedAsk = {
  id: 'a4', askId: 'w-4444444444444444', peer: 'bravo', dir: 'out', text: 'x', reply: '', error: 'ECONNREFUSED',
  state: 'failed', t: 800, elapsedMs: 0, actionsProposed: 0, costUsd: null,
}
const plainAsk = {
  id: 'a5', askId: 'w-5555555555555555', peer: 'bravo', dir: 'out', text: 'x', reply: 'ok', error: null,
  state: 'answered', t: 900, elapsedMs: 100, actionsProposed: 0, costUsd: 0.02,
}

ok('a held ask gives one held row, local, whose summary includes its error', () => {
  const rows = MCPRM.askRows([heldAsk], new Map())
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'ask')
  assert.equal(rows[0].dir, 'local')
  assert.equal(rows[0].kind, 'held')
  assert.match(rows[0].summary, /rate limited/)
})

ok('an answered in ask with actions proposed and no apply recorded', () => {
  const rows = MCPRM.askRows([inActionAsk], new Map())
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'action')
  assert.equal(rows[0].summary, '2 actions proposed · no apply recorded')
})

ok('the same ask reads applied: spawn once appliedIndex maps its WIRE id to spawn', () => {
  const applied = new Map([[inActionAsk.askId, ['spawn']]])
  const rows = MCPRM.askRows([inActionAsk], applied)
  assert.equal(rows[0].summary, '2 actions proposed · applied: spawn')
})

ok('a map keyed by the store id instead of the wire id joins nothing', () => {
  const applied = new Map([[inActionAsk.id, ['spawn']]])
  const rows = MCPRM.askRows([inActionAsk], applied)
  assert.equal(rows[0].summary, '2 actions proposed · no apply recorded')
})

ok('an out ask with actions names the peer instead of an apply record', () => {
  const rows = MCPRM.askRows([outActionAsk], new Map())
  assert.equal(rows.length, 1)
  assert.equal(rows[0].dir, 'out')
  assert.equal(rows[0].kind, 'action')
  assert.equal(rows[0].summary, '2 actions proposed on bravo')
})

ok('a failed ask gives an error row', () => {
  const rows = MCPRM.askRows([failedAsk], new Map())
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'error')
  assert.match(rows[0].summary, /ECONNREFUSED/)
})

ok('a plain answered ask gives no row -- its exchanges are wire rows', () => {
  assert.deepEqual(MCPRM.askRows([plainAsk], new Map()), [])
})

ok('askRows: an incoming ask whose proposals applied automatically says so', () => {
  const rows = MCPRM.askRows([{
    id: 'i1', askId: 'w1', peer: 'beta', dir: 'in', state: 'answered', t: 5, actionsProposed: 3, costUsd: 0.01,
    proposals: [
      { kind: 'spawn', mode: 'auto', state: 'applied', risk: null, error: null },
      { kind: 'prompt', mode: 'auto', state: 'failed', risk: null, error: 'no such session' },
      { kind: 'link', mode: 'auto', state: 'applied', risk: null, error: null },
    ],
  }], new Map())
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'action')
  assert.equal(rows[0].summary, '3 actions proposed · auto-applied: spawn, link · failed: prompt')
})

// ------------------------------------------------------------------ jobRows

ok('a landed recv job gives a drop row', () => {
  const job = {
    id: 'j1', dropId: 'd1', peer: 'bravo', side: 'recv', state: 'landed',
    files: ['a.txt', 'b.txt', 'c.txt'], bytes: 4096, sent: true, note: '',
    error: null, pinned: false, t: 100, updatedAt: 1000,
  }
  const rows = MCPRM.jobRows([job])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'drop')
  assert.equal(rows[0].summary, '← 3 files landed')
})

ok('a refused job gives a drop row with the reason and a filter row', () => {
  const job = {
    id: 'j2', dropId: 'd2', peer: 'bravo', side: 'recv', state: 'refused',
    files: [], bytes: 0, sent: false, filtered: true, note: '',
    error: 'contains a private key', pinned: false, t: 200, updatedAt: 2000,
  }
  const rows = MCPRM.jobRows([job])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].kind, 'drop')
  assert.match(rows[0].summary, /contains a private key/)
  assert.equal(rows[1].kind, 'filter')
  assert.equal(rows[1].summary, 'filter refused: contains a private key')
})

ok('filtered: false reads as no filter installed', () => {
  const job = {
    id: 'j3', dropId: 'd3', peer: 'bravo', side: 'send', state: 'landed',
    files: ['x'], bytes: 10, sent: true, filtered: false, note: '',
    error: null, pinned: false, t: 300, updatedAt: 3000,
  }
  const rows = MCPRM.jobRows([job])
  assert.equal(rows.length, 2)
  assert.equal(rows[1].kind, 'filter')
  assert.equal(rows[1].summary, 'no filter installed')
})

ok('a job with filtered absent gives no filter row', () => {
  const job = {
    id: 'j4', dropId: 'd4', peer: 'bravo', side: 'send', state: 'landed',
    files: ['x'], bytes: 10, sent: true, note: '', error: null, pinned: false,
    t: 400, updatedAt: 4000,
  }
  const rows = MCPRM.jobRows([job])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'drop')
})

ok('the refusal reason comes from error only, never the sender\'s note', () => {
  const job = {
    id: 'j5', dropId: 'd5', peer: 'bravo', side: 'recv', state: 'refused',
    files: [], bytes: 0, sent: false, filtered: true, note: 'a note from the sender',
    error: null, pinned: false, t: 250, updatedAt: 2500,
  }
  const rows = MCPRM.jobRows([job])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].summary, '← refused')
  assert.equal(rows[1].summary, 'filter refused')
  assert.doesNotMatch(rows[0].summary, /a note from the sender/)
  assert.doesNotMatch(rows[1].summary, /a note from the sender/)
})

ok('filtered: true and state filtering reads filter running', () => {
  const job = {
    id: 'j6', dropId: 'd6', peer: 'bravo', side: 'recv', state: 'filtering',
    files: [], bytes: 0, sent: false, filtered: true, note: '',
    error: null, pinned: false, t: 260, updatedAt: 2600,
  }
  const rows = MCPRM.jobRows([job])
  assert.equal(rows.length, 2)
  assert.equal(rows[1].summary, 'filter running')
})

ok('filtered: true and state sent reads filter passed', () => {
  const job = {
    id: 'j7', dropId: 'd7', peer: 'bravo', side: 'send', state: 'sent',
    files: ['a'], bytes: 10, sent: true, filtered: true, note: '',
    error: null, pinned: false, t: 270, updatedAt: 2700,
  }
  const rows = MCPRM.jobRows([job])
  assert.equal(rows.length, 2)
  assert.equal(rows[1].summary, 'filter passed')
})

ok('filtered: true and state landed also reads filter passed', () => {
  const job = {
    id: 'j8', dropId: 'd8', peer: 'bravo', side: 'recv', state: 'landed',
    files: ['a', 'b'], bytes: 20, sent: true, filtered: true, note: '',
    error: null, pinned: false, t: 280, updatedAt: 2800,
  }
  const rows = MCPRM.jobRows([job])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].summary, '← 2 files landed')
  assert.equal(rows[1].summary, 'filter passed')
})

ok('filtered: true with an unrecognised state gives no filter row', () => {
  const job = {
    id: 'j10', dropId: 'd10', peer: 'bravo', side: 'recv', state: 'queued',
    files: [], bytes: 0, sent: false, filtered: true, note: '',
    error: null, pinned: false, t: 290, updatedAt: 2900,
  }
  const rows = MCPRM.jobRows([job])
  assert.equal(rows.length, 1)
})

// ------------------------------------------------------------- appliedIndex

ok('appliedIndex folds sessions, spawnedBy and requests by forPeer.askId', () => {
  const sessions = [{ id: 's1', forPeer: { peer: 'bravo', askId: 'ask1' } }, { id: 's2' }]
  const spawnedBy = [
    { shortId: 'x1', forPeer: { peer: 'bravo', askId: 'ask1' } },
    { shortId: 'x2', forPeer: { peer: 'bravo', askId: 'ask2' } },
  ]
  const requests = [{ id: 'r1', forPeer: { peer: 'bravo', askId: 'ask3' } }]
  const idx = MCPRM.appliedIndex({ sessions, spawnedBy, requests })
  assert.deepEqual(idx.get('ask1'), ['prompt', 'spawn'])
  assert.deepEqual(idx.get('ask2'), ['spawn'])
  assert.deepEqual(idx.get('ask3'), ['dispatch'])
  assert.equal(idx.get('nope'), undefined)
})

ok('appliedIndex over records with no forPeer at all is an empty map', () => {
  const idx = MCPRM.appliedIndex({ sessions: [{ id: 's1' }], spawnedBy: [], requests: undefined })
  assert.equal(idx.size, 0)
})

// --------------------------------------------------------------- buildRows

const heads = [
  {
    t: 100, dir: 'out', peer: 'bravo', route: '/peer/ask', kind: 'ask', status: 200,
    rttMs: 5, reqBytes: 10, resBytes: 10, redactions: { n: 0, kinds: {} },
    safeguard: 'on', summary: 'ask: hi', repeats: 0, error: null, chunks: null,
  },
  {
    t: 300, dir: 'in', peer: 'bravo', route: '/peer/hello', kind: 'hello', status: 200,
    rttMs: 3, reqBytes: 5, resBytes: 5, redactions: { n: 0, kinds: {} },
    safeguard: 'on', summary: 'heartbeat', repeats: 0, error: null, chunks: null,
  },
]
const asksFixture = [{
  id: 'a1', askId: 'w-9999999999999999', peer: 'charlie', dir: 'in', text: 'x', reply: 'ok', error: null,
  state: 'answered', t: 200, elapsedMs: 0, actionsProposed: 1, costUsd: null,
}]
const jobsFixture = [{
  id: 'j1', dropId: 'd1', peer: 'bravo', side: 'recv', state: 'landed',
  files: ['a'], bytes: 10, sent: true, note: '', error: null, pinned: false,
  t: 50, updatedAt: 50,
}]

ok('buildRows orders newest first across every source', () => {
  const rows = MCPRM.buildRows({ heads, asks: asksFixture, jobs: jobsFixture, applied: new Map(), pinned: new Set(), filter: {} })
  assert.deepEqual(rows.map((r) => r.t), [300, 200, 100, 50])
})

ok('buildRows puts pinned keys first, each group still newest first', () => {
  const pinned = new Set(['jj1', 'w100'])
  const rows = MCPRM.buildRows({ heads, asks: asksFixture, jobs: jobsFixture, applied: new Map(), pinned, filter: {} })
  assert.deepEqual(rows.map((r) => r.key), ['w100', 'jj1', 'w300', 'aa1'])
})

ok('buildRows filter.kind matches only that kind of row', () => {
  const rows = MCPRM.buildRows({ heads, asks: asksFixture, jobs: jobsFixture, applied: new Map(), pinned: new Set(), filter: { kind: 'drop' } })
  assert.deepEqual(rows.map((r) => r.key), ['jj1'])
})

ok('buildRows filter.text matches peer or summary, case-insensitive', () => {
  const byPeer = MCPRM.buildRows({ heads, asks: asksFixture, jobs: jobsFixture, applied: new Map(), pinned: new Set(), filter: { text: 'CHARLIE' } })
  assert.deepEqual(byPeer.map((r) => r.key), ['aa1'])
  const bySummary = MCPRM.buildRows({ heads, asks: asksFixture, jobs: jobsFixture, applied: new Map(), pinned: new Set(), filter: { text: 'heartbeat' } })
  assert.deepEqual(bySummary.map((r) => r.key), ['w300'])
})

// ---------------------------------------------------------------- detailOf

ok('detailOf on a wire row with a full row parses both halves and attaches the ask by its wire id', () => {
  const head = {
    t: 500, dir: 'out', peer: 'bravo', route: '/peer/ask', kind: 'ask', status: 200,
    rttMs: 10, reqBytes: 20, resBytes: 20, redactions: { n: 1, kinds: { home: 1 } },
    safeguard: 'on', summary: 'ask: hi', repeats: 0, error: null, chunks: null,
  }
  const row = MCPRM.wireRows([head])[0]
  // The ask's own store id ('ask9-db') is deliberately not the wire id in the
  // body below -- a join on `a.id` instead of `a.askId` would find nothing.
  const askList = [{
    id: 'ask9-db', askId: 'ask9', peer: 'bravo', dir: 'out', text: 'what is in ~?', reply: 'nothing much',
    error: null, state: 'answered', t: 500, elapsedMs: 10, actionsProposed: 0, costUsd: null,
  }]
  const full = {
    ...head, req: JSON.stringify({ askId: 'ask9', text: 'what is in ~?' }),
    res: JSON.stringify({ accepted: true }), reqClipped: false, resClipped: false,
  }
  const detail = MCPRM.detailOf(row, { full, asks: askList, jobs: [] })
  assert.deepEqual(detail.sent.value, { askId: 'ask9', text: 'what is in ~?' })
  assert.deepEqual(detail.received.value, { accepted: true })
  assert.equal(detail.ask.text, 'what is in ~?')
  assert.equal(detail.ask.reply, 'nothing much')
})

ok('detailOf disambiguates two asks sharing a wire id by the row\'s own peer', () => {
  const head = {
    t: 502, dir: 'out', peer: 'charlie', route: '/peer/ask', kind: 'ask', status: 200,
    rttMs: 10, reqBytes: 20, resBytes: 20, redactions: { n: 0, kinds: {} },
    safeguard: 'on', summary: 'ask: hi', repeats: 0, error: null, chunks: null,
  }
  const row = MCPRM.wireRows([head])[0]
  const shared = 'shared-wire-id'
  const askList = [
    {
      id: 'x1', askId: shared, peer: 'bravo', dir: 'out', text: 'to bravo', reply: 'bravo reply',
      error: null, state: 'answered', t: 100, elapsedMs: 0, actionsProposed: 0, costUsd: null,
    },
    {
      id: 'x2', askId: shared, peer: 'charlie', dir: 'out', text: 'to charlie', reply: 'charlie reply',
      error: null, state: 'answered', t: 100, elapsedMs: 0, actionsProposed: 0, costUsd: null,
    },
  ]
  const full = {
    ...head, req: JSON.stringify({ askId: shared, text: 'to charlie' }),
    res: JSON.stringify({ accepted: true }), reqClipped: false, resClipped: false,
  }
  const detail = MCPRM.detailOf(row, { full, asks: askList, jobs: [] })
  assert.equal(detail.ask.text, 'to charlie')
  assert.equal(detail.ask.reply, 'charlie reply')
  const onlyOther = MCPRM.detailOf(row, { full, asks: [askList[0]], jobs: [] })
  assert.equal(onlyOther.ask, null, "another peer's ask with the same wire id is never attached")
})

ok('detailOf keeps raw text when a clipped half does not parse', () => {
  const head = {
    t: 501, dir: 'out', peer: 'bravo', route: '/peer/ask', kind: 'ask', status: 200,
    rttMs: 10, reqBytes: 9000, resBytes: 20, redactions: { n: 0, kinds: {} },
    safeguard: 'on', summary: 'ask: hi', repeats: 0, error: null, chunks: null,
  }
  const row = MCPRM.wireRows([head])[0]
  const clippedText = '{"askId":"ask9","text":"part of a very long stri'
  const full = { ...head, req: clippedText, res: JSON.stringify({ ok: true }), reqClipped: true, resClipped: false }
  const detail = MCPRM.detailOf(row, { full, asks: [], jobs: [] })
  assert.equal(detail.sent.value, undefined)
  assert.equal(detail.sent.raw, clippedText)
  assert.equal(detail.sent.clipped, true)
})

ok('detailOf on an ask row answers the ask itself', () => {
  const row = MCPRM.askRows([heldAsk], new Map())[0]
  const detail = MCPRM.detailOf(row, { asks: [heldAsk], jobs: [] })
  assert.deepEqual(detail, heldAsk)
})

ok('detailOf on a job row answers the job itself', () => {
  const job = {
    id: 'j9', dropId: 'd9', peer: 'bravo', side: 'recv', state: 'landed',
    files: ['a'], bytes: 10, sent: true, note: '', error: null, pinned: false,
    t: 700, updatedAt: 700,
  }
  const row = MCPRM.jobRows([job])[0]
  const detail = MCPRM.detailOf(row, { asks: [], jobs: [job] })
  assert.deepEqual(detail, job)
})

// ------------------------------------------------------------- summaryLine

ok('summaryLine on a relay that predates peering', () => {
  assert.equal(MCPRM.summaryLine(undefined, null), 'Peering: this relay predates peering')
})

ok('summaryLine when peering is off', () => {
  assert.equal(MCPRM.summaryLine({ enabled: false, list: [] }, null), 'Peering off')
})

ok('summaryLine when peering is on, with peers and a digest', () => {
  const peers = {
    enabled: true,
    list: [{ name: 'bravo', health: { state: 'up' } }, { name: 'charlie', health: { state: 'down' } }],
  }
  const wire = { count: 14, redactions: { total: 3 } }
  assert.equal(MCPRM.summaryLine(peers, wire), 'Peering on · 2 peers, 1 up · 14 exchanges · 3 redactions')
})

console.log(`peering model harness: ${pass} ok`)
