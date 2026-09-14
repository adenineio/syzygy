#!/usr/bin/env node
// Harness for the snapshot's byte budget.
//
// A pane that cannot drain a frame is dropped. The relay now measures every
// snapshot frame before it is written, and when a frame is over its budget it
// sheds whole optional sections in one fixed order, saying on the frame what
// it shed. Half one drives the pure shed over a frame built by hand. Half two
// builds a board of forty projects through the real builders, measures it,
// holds the shed's order over that real frame, and proves on a real relay
// that the budget it was started with is the one its routes enforce.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SNAPSHOT_BUDGET_BYTES, SHED_ORDER, SERIES_SHED_CAP, EFFORTS_SHED_CAP, sectionBytes, shedToBudget,
} from '../syzygy/bridge/snapshot-budget.mjs'
import { foldEfforts } from '../syzygy/bridge/tasks-efforts.mjs'
import { digestProjects } from '../syzygy/bridge/tasks-digest.mjs'
import { planRecord } from '../syzygy/bridge/tasks.mjs'
import { digestOf, KINDS } from '../syzygy/bridge/spend.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let passed = 0
const ok = (label, fn) => { fn(); passed++; console.log('✔ ' + label) }
const okAsync = async (label, fn) => { await fn(); passed++; console.log('✔ ' + label) }

const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v))
const two = (n) => String(n).padStart(2, '0')
const uuid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const T0 = 1_800_000_000_000

/** The sections named by a list of shed rows, in SHED_ORDER's own order, each
 *  at most once. A row for a section the frame did not carry is never
 *  written, so this is a subsequence rule rather than a prefix rule. */
const inShedOrder = (rows) => {
  const at = rows.map((r) => SHED_ORDER.indexOf(r.section))
  return at.every((i) => i >= 0) && at.every((i, n) => n === 0 || i > at[n - 1])
}

/** Every length a list of `n` passes through while it is halved to nothing. */
const halvings = (n) => {
  const out = []
  for (let x = n; x > 0; x = Math.floor(x / 2)) out.push(x)
  return [...out, 0]
}

const spendDigest = (now) => digestOf(Array.from({ length: 120 }, (_, i) => ({
  k: KINDS[i % KINDS.length], usd: 0.0125 * (i % 7), tok: 900 + i * 11, t: now - i * 3_600_000, est: i % 5 === 0, nr: i % 13 === 0,
})), now, 0)

// ==== half one: the pure shed ===================================================

const SESSIONS = 15, SERIES = 240, EVENTS = 400, FINDINGS = 20, PROPOSALS = 12, PROJECTS = 3, EFFORTS = 20

const handFrame = () => ({
  payloadVersion: 1,
  t: T0,
  sessions: Array.from({ length: SESSIONS }, (_, k) => ({
    id: uuid(k + 1), name: 'session-' + two(k), working: k % 2 === 0,
    series: Array.from({ length: SERIES }, (_, i) => ({ t: i, tokens: 100 + i, spend: k, ctx: 1000 + i })),
  })),
  events: Array.from({ length: EVENTS }, (_, i) => ({
    kind: 'tool', label: 'Bash', detail: 'a command of an ordinary length', status: 'ok', ms: 100 + i, t: T0 + i, sessionId: uuid((i % SESSIONS) + 1), id: 'e' + i,
  })),
  findings: Array.from({ length: FINDINGS }, (_, i) => ({
    id: 'f' + i, t: T0 + i, kind: 'contract', session: 'session-00', project: 'alpha', touched: ['a.mjs'], surprise: 'a surprise of an ordinary length, number ' + i, evidence: ['a.mjs:1'],
  })),
  skillsQueue: {
    proposals: Array.from({ length: PROPOSALS }, (_, i) => ({ id: 'p' + i, title: 'a proposal ' + i, idea: 'an idea of an ordinary length', methodology: 'a method of an ordinary length' })),
    pass: {},
  },
  projects: Array.from({ length: PROJECTS }, (_, p) => ({
    key: '/Users/someone/work/project-' + p + '/.git', name: 'project-' + p,
    efforts: Array.from({ length: EFFORTS }, (_, e) => ({
      name: 'plan-' + two(e) + '.md', title: 'Plan ' + two(e), rel: 'docs/plans/plan-' + two(e) + '.md', done: e, reported: 0, total: 20,
      shipped: null, live: true, currentItem: 'Step ' + e + ': an ordinary step', checkedAt: T0 - e, at: 'main', claimedBy: [],
    })),
    moreEfforts: 5,
  })),
  spend: spendDigest(T0),
  viewers: 2,
})

/** Nothing the shed does not own may change: every key survives, every key
 *  outside the five sections is untouched, and a session or a project keeps
 *  every field but the one list the shed trims. */
const assertOnlyShedSections = (input, frame) => {
  for (const k of Object.keys(input)) assert.ok(Object.hasOwn(frame, k), 'the shed removed the key ' + k)
  for (const k of Object.keys(input)) {
    if (['findings', 'skillsQueue', 'sessions', 'events', 'projects', 'shed'].includes(k)) continue
    assert.deepEqual(frame[k], input[k], 'the shed changed ' + k + ', which it does not own')
  }
  if (input.skillsQueue) assert.deepEqual(frame.skillsQueue.pass, input.skillsQueue.pass, 'skillsQueue.pass was touched')
  if (input.sessions) {
    assert.equal(frame.sessions.length, input.sessions.length, 'a session was dropped')
    input.sessions.forEach((s, i) => {
      const { series: _a, ...rest } = s
      const { series: _b, ...kept } = frame.sessions[i]
      assert.deepEqual(kept, rest, 'session ' + s.id + ' lost a field other than its series')
    })
  }
  if (input.projects) {
    assert.equal(frame.projects.length, input.projects.length, 'a project was dropped')
    input.projects.forEach((p, i) => {
      const { efforts: _a, moreEfforts: _b, ...rest } = p
      const { efforts: _c, moreEfforts: _d, ...kept } = frame.projects[i]
      assert.deepEqual(kept, rest, 'project ' + p.key + ' lost a field other than its efforts')
    })
  }
}

const assertConsistent = (out) => {
  assert.equal(typeof out.json, 'string')
  assert.equal(out.bytes, Buffer.byteLength(out.json), 'bytes is not the json\'s UTF-8 length')
  assert.deepEqual(JSON.parse(out.json), out.frame, 'the json is not the frame returned beside it')
  assert.deepEqual(out.frame.shed, out.shed, 'the frame does not say what it shed')
  assert.deepEqual(out.sections, sectionBytes(out.frame), 'sections does not measure the frame actually sent')
}

ok('sectionBytes has one number per top-level key, summing to about the whole frame', () => {
  const frame = handFrame()
  const sections = sectionBytes(frame)
  assert.deepEqual(Object.keys(sections), Object.keys(frame))
  for (const [k, n] of Object.entries(sections)) {
    assert.ok(Number.isInteger(n) && n >= 0, k + ' measured ' + n)
    assert.equal(n, bytesOf(frame[k]), k + ' is not its own serialisation\'s length')
  }
  const sum = Object.values(sections).reduce((a, n) => a + n, 0)
  const whole = JSON.stringify(frame).length
  assert.ok(sum >= 0.9 * whole && sum <= 1.1 * whole, 'the sections sum to ' + sum + ' against a frame of ' + whole)
})

ok('a key whose value does not serialise measures zero rather than throwing', () => {
  assert.deepEqual(sectionBytes({ a: undefined, b: () => 1, c: 'é' }), { a: 0, b: 0, c: 4 })
})

ok('a frame already under the budget sheds nothing and gains shed: []', () => {
  const input = handFrame()
  assert.ok(bytesOf(input) < SNAPSHOT_BUDGET_BYTES, 'the hand-built frame must fit the default budget')
  const out = shedToBudget(input)
  assert.deepEqual(out.shed, [])
  assert.deepEqual(out.frame, { ...input, shed: [] })
  assertConsistent(out)
})

ok('an existing shed key keeps its place in the frame', () => {
  const { payloadVersion, t, ...rest } = handFrame()
  const input = { payloadVersion, t, shed: [], ...rest }
  const out = shedToBudget(input, { budget: 64 * 1024 })
  assert.deepEqual(Object.keys(out.frame), Object.keys(input))
})

ok('forced down to 64 KB, the shed walks SHED_ORDER and meets the budget', () => {
  const input = handFrame()
  const budget = 64 * 1024
  const out = shedToBudget(input, { budget })
  assertConsistent(out)
  assert.ok(out.shed.length >= 4, 'expected findings, proposals, series and events to shed, got ' + JSON.stringify(out.shed))
  assert.deepEqual(out.shed.map((r) => r.section), SHED_ORDER.slice(0, out.shed.length), 'the shed left SHED_ORDER')
  assert.ok(out.bytes <= budget, 'the frame is ' + out.bytes + ' bytes against ' + budget)
  assertOnlyShedSections(input, out.frame)

  const row = (section) => out.shed.find((r) => r.section === section)
  assert.deepEqual(row('findings'), { section: 'findings', kept: 0, dropped: FINDINGS })
  assert.deepEqual(out.frame.findings, [])
  assert.deepEqual(row('proposals'), { section: 'proposals', kept: 0, dropped: PROPOSALS })
  assert.deepEqual(out.frame.skillsQueue.proposals, [])

  assert.deepEqual(row('series'), { section: 'series', kept: SERIES_SHED_CAP * SESSIONS, dropped: (SERIES - SERIES_SHED_CAP) * SESSIONS })
  out.frame.sessions.forEach((s, i) => {
    assert.equal(s.series.length, SERIES_SHED_CAP)
    assert.deepEqual(s.series[0], input.sessions[i].series[SERIES - SERIES_SHED_CAP], 'the series did not keep its newest points')
    assert.deepEqual(s.series.at(-1), input.sessions[i].series.at(-1))
  })

  const ev = row('events')
  assert.equal(ev.kept + ev.dropped, EVENTS)
  assert.ok(halvings(EVENTS).slice(1).includes(ev.kept), 'events kept ' + ev.kept + ', which halving ' + EVENTS + ' never reaches')
  assert.equal(out.shed.filter((r) => r.section === 'events').length, 1, 'the halvings were not accumulated into one row')
  assert.deepEqual(out.frame.events, input.events.slice(EVENTS - ev.kept), 'events did not keep the newest')
})

ok('events halve only until the frame fits', () => {
  const input = { t: T0, events: handFrame().events }
  const whole = bytesOf({ ...input, shed: [] })
  const budget = Math.floor(whole / 5)
  const out = shedToBudget(input, { budget })
  assertConsistent(out)
  const [ev] = out.shed
  assert.equal(out.shed.length, 1)
  assert.equal(ev.section, 'events')
  assert.ok(ev.kept > 0 && halvings(EVENTS).includes(ev.kept))
  assert.ok(out.bytes <= budget)
  // One halving fewer would not have fitted, so the walk did not overshoot.
  const before = halvings(EVENTS)[halvings(EVENTS).indexOf(ev.kept) - 1]
  const oneFewer = { ...input, events: input.events.slice(EVENTS - before), shed: [{ section: 'events', kept: before, dropped: EVENTS - before }] }
  assert.ok(bytesOf(oneFewer) > budget, 'keeping ' + before + ' events would already have fitted')
})

ok('a budget nothing can meet sheds every section, never throws, and keeps every card', () => {
  const input = handFrame()
  const out = shedToBudget(input, { budget: 1 })
  assertConsistent(out)
  assert.ok(out.bytes > 1)
  assert.deepEqual(out.shed.map((r) => r.section), SHED_ORDER)
  assertOnlyShedSections(input, out.frame)
  assert.deepEqual(out.frame.spend, input.spend, 'spend is bounded and never shed')
  assert.deepEqual(out.shed.find((r) => r.section === 'events'), { section: 'events', kept: 0, dropped: EVENTS })
  assert.deepEqual(out.frame.events, [])
  assert.deepEqual(out.shed.find((r) => r.section === 'efforts'),
    { section: 'efforts', kept: EFFORTS_SHED_CAP * PROJECTS, dropped: (EFFORTS - EFFORTS_SHED_CAP) * PROJECTS })
  out.frame.projects.forEach((p, i) => {
    assert.deepEqual(p.efforts, input.projects[i].efforts.slice(0, EFFORTS_SHED_CAP))
    assert.equal(p.moreEfforts, input.projects[i].moreEfforts + (EFFORTS - EFFORTS_SHED_CAP), 'moreEfforts no longer counts what is missing')
  })
  assert.deepEqual(out.frame.sessions.map((s) => s.id), input.sessions.map((s) => s.id))
  assert.equal(out.frame.sessions[0].id, uuid(1))

  // The same walk, at exactly the size it reaches, meets its budget.
  const met = shedToBudget(input, { budget: out.bytes })
  assert.deepEqual(met.shed, out.shed)
  assert.equal(met.bytes, out.bytes)
})

ok('an absent or empty section writes no row, and the walk goes on past it', () => {
  const { findings: _f, ...rest } = handFrame()
  const input = {
    ...rest,
    skillsQueue: { proposals: [], pass: { at: T0 } },
    sessions: rest.sessions.map((s) => ({ ...s, series: s.series.slice(0, SERIES_SHED_CAP) })),
  }
  const out = shedToBudget(input, { budget: 1 })
  assertConsistent(out)
  assert.deepEqual(out.shed.map((r) => r.section), ['events', 'efforts'])
  assert.ok(inShedOrder(out.shed))
  assert.equal(Object.hasOwn(out.frame, 'findings'), false, 'the shed added a findings key the frame never carried')

  const bare = { t: T0, sessions: [{ id: uuid(1) }], projects: [{ key: 'k', efforts: [] }], events: [] }
  const none = shedToBudget(bare, { budget: 1 })
  assert.deepEqual(none.shed, [])
  assert.deepEqual(none.frame, { ...bare, shed: [] })
})

ok('the shed never mutates the frame it is handed', () => {
  const input = handFrame()
  const copy = structuredClone(input)
  for (const budget of [1, 64 * 1024, SNAPSHOT_BUDGET_BYTES]) shedToBudget(input, { budget })
  assert.deepEqual(input, copy)
})

ok('the serialiser it is handed is the one that writes the json', () => {
  let calls = 0
  const serialize = (v) => { calls++; return JSON.stringify(v) }
  const out = shedToBudget(handFrame(), { budget: 64 * 1024, serialize })
  assert.ok(calls > 0)
  assertConsistent(out)
})

// ==== half two: forty projects through the real builders =======================
// Forty projects of twelve worktrees each carrying forty plans of a hundred
// and twenty steps, and sixty backlog headings, with lengths a real board has:
// worktree paths, branch names, short heads, plan names, step text
// of about sixty characters and two sessions on each of the first three
// worktrees. A plan's step list is one array shared by every copy of it: the
// digest reads the list and writes nothing, so sharing it changes no byte of
// what is measured, and it keeps the fixture in memory.

const BIG = { projects: 40, worktrees: 12, plans: 40, steps: 120, sections: 60, sessions: 15 }
const hex16 = (n) => n.toString(16).padStart(16, '0')
// The short sha a scan sends.
const shortHead = (seed) => (((seed * 2654435761) >>> 0) * 1103515245 + 12345 >>> 0).toString(16).padStart(8, '0').slice(0, 7)

const bigScan = ({ plans = BIG.plans, steps = BIG.steps } = {}) => {
  let nextId = 0
  let sessionSeq = 0
  const checker = { id: uuid(9999), name: 'project-00-feature-00-a' }
  const history = (i, checked) => ({
    firstSeen: T0 - 5 * 86_400_000, checkedAt: checked ? T0 - 3_600_000 - i * 1000 : null,
    checkedBy: checked ? checker : null, uncheckedAt: null, removedAt: null,
  })
  // Progress as a share of the steps, so a board of fewer steps is otherwise
  // the same board.
  const DONE = [0, 0.25, 0.5, 0.75, 1]
  const doneOf = (p) => DONE[p % DONE.length] * steps
  const stepsOf = (done) => {
    const items = []
    for (let s = 0; s < steps; s++) {
      if (s % 12 === 0) {
        items.push({ id: hex16(nextId++), kind: 'section', text: 'Task ' + (s / 12 + 1) + ': a heading of an ordinary length', checked: null, reported: false, depth: 0, line: s * 3, slug: 'task-' + (s / 12 + 1) + '-a-heading-of-an-ordinary-length', history: history(s, true), diff: 'same' })
      }
      items.push({ id: hex16(nextId++), kind: 'step', text: ('Step ' + (s + 1) + ': write the failing test for the ordinary change').padEnd(60, '.'), checked: s < done, reported: false, depth: 0, line: s * 3 + 1, history: history(s, s < done), diff: 'same' })
    }
    return items
  }
  const stepLists = Array.from({ length: plans }, (_, p) => stepsOf(doneOf(p)))
  const backlog = Array.from({ length: BIG.sections }, (_, n) => ({
    id: hex16(1_000_000 + n), kind: 'section', text: 'Backlog heading ' + n + ': something deferred that outlives a session', checked: null, reported: false, depth: 0, line: n * 20, slug: 'backlog-heading-' + n + '-something-deferred-that-outlives-a-session', history: history(n, true), diff: 'same',
  }))
  return Array.from({ length: BIG.projects }, (_, pi) => {
    const mainRoot = '/Users/someone/work/project-' + two(pi)
    const worktrees = Array.from({ length: BIG.worktrees }, (_, wi) => {
      const sessions = wi < 3
        ? ['a', 'b'].map((x) => ({ id: uuid(++sessionSeq), name: 'project-' + two(pi) + '-feature-' + two(wi) + '-' + x, working: x === 'a' }))
        : []
      return {
        path: wi === 0 ? mainRoot : mainRoot + '/.worktrees/feature-branch-' + two(wi),
        branch: wi === 0 ? 'main' : 'feat/some-feature-' + two(wi), head: shortHead(pi * 100 + wi), isMain: wi === 0,
        detached: false, locked: false, sessions,
        plans: Array.from({ length: plans }, (_, p) => {
          const items = stepLists[p]
          return {
            rel: 'docs/plans/some-plan-name-' + two(p) + '.md', dir: 'plans', title: ('Some plan name ' + two(p) + ': the implementation').padEnd(40, '.'),
            spec: 'docs/specs/some-plan-name-' + two(p) + '-design.md', tasks: [], shipped: null, shippedMalformed: null,
            items, currentItemId: items.find((i) => i.kind === 'step' && !i.checked)?.id ?? null,
            done: doneOf(p), reported: 0, total: steps, owner: null, diff: 'same', mtimeMs: T0 - p * 60_000,
            resolvedTasks: [], resolvedSpec: { ref: 'docs/specs/some-plan-name-' + two(p) + '-design.md', name: 'some-plan-name-' + two(p) + '-design.md', title: 'Some plan name ' + two(p) + ' design' },
          }
        }),
        tasks: [{ rel: 'docs/TASKS.md', items: backlog }],
        taskFile: 'docs/TASKS.md', taskAuthority: 'docs', specs: [], skipped: [],
        // Every claim names one of the first four plans, so a board of four
        // plans resolves the same claims as a board of forty.
        claims: Object.fromEntries(sessions.map((s, k) => [s.id, { name: s.name, items: [{ kind: 'plan', id: 'some-plan-name-' + two((wi * 2 + k) % 4) + '.md' }] }])),
      }
    })
    const folded = foldEfforts(worktrees)
    return {
      key: mainRoot + '/.git', name: 'project-' + two(pi), isGit: true, mainRoot,
      overCap: { projects: 0, worktrees: 0 }, roll: { onlyHere: 0, removed: 0, doneHere: 0, behind: 0 },
      efforts: folded.efforts, planCollisions: [], features: [], featureCollisions: [],
      specs: [], brokenRefs: [], malformedShipped: [], unresolvedClaims: folded.unresolvedClaims, gitGraph: null, worktrees,
    }
  })
}

// Fifteen sessions with the key set and value lengths of a real captured
// session, each with a full series.
const realSession = JSON.parse(readFileSync(join(ROOT, 'pane-v2', 'testdata', 'fixtures', 'snapshot.json'), 'utf8')).sessions[0]
const capturedEvents = JSON.parse(readFileSync(join(ROOT, 'pane-v2', 'testdata', 'fixtures', 'snapshot.json'), 'utf8')).events
const bigSessions = () => Array.from({ length: BIG.sessions }, (_, k) => ({
  ...realSession,
  id: uuid(5000 + k), name: 'project-' + two(k) + '-feature-00-a', agentName: 'project-' + two(k) + '-feature-00-a',
  cwd: '/Users/someone/work/project-' + two(k), root: '/Users/someone/work/project-' + two(k),
  transcript: '/Users/someone/.claude/projects/-Users-someone-work-project-' + two(k) + '/' + uuid(5000 + k) + '.jsonl',
  series: Array.from({ length: 240 }, (_, i) => ({
    t: T0 - (240 - i) * 1201, tokens: 1777 + i * 13 + k, spend: Math.round((100.5483045 + i * 0.0451234 + k) * 1e7) / 1e7, ctx: 831399 + i * 37 + k,
  })),
}))
const bigEvents = () => Array.from({ length: EVENTS }, (_, i) => ({
  ...capturedEvents[i % capturedEvents.length], t: T0 - (EVENTS - i) * 900, id: 'e' + i.toString(36).padStart(7, '0'), sessionId: uuid(5000 + (i % BIG.sessions)),
}))

const scan = bigScan()
const digest = digestProjects(scan, { now: T0 }).map((d) => ({ ...d, changedAt: T0 }))
const digestBytes = bytesOf(digest)
// The plan route's body for one plan, at the route's default page of 500.
const record = planRecord(scan, scan[17].worktrees[7].path, 'docs/plans/some-plan-name-23.md')
const planPage = { plan: { ...record, items: record.items.slice(0, 500) }, offset: 0, limit: 500, total: record.items.length, changedAt: T0 }

const DIGEST_BOUND = 256 * 1024
const PLAN_PAGE_BOUND = 300 * 1024

ok('forty projects digest under 256 KB, and one plan page at the default limit is under 300 KB', () => {
  assert.equal(digest.length, BIG.projects)
  assert.equal(digest[0].counts.steps, BIG.worktrees * BIG.plans * BIG.steps)
  assert.equal(digest[0].counts.backlogSections, BIG.sections)
  assert.equal(record.items.length, BIG.steps + BIG.steps / 12)
  const pageBytes = bytesOf(planPage)
  console.log('  forty projects: digest ' + digestBytes + ' bytes, one plan page ' + pageBytes + ' bytes')
  assert.ok(digestBytes < DIGEST_BOUND, 'the digest is ' + digestBytes + ' bytes, over ' + DIGEST_BOUND)
  assert.ok(pageBytes < PLAN_PAGE_BOUND, 'one plan page is ' + pageBytes + ' bytes, over ' + PLAN_PAGE_BOUND)
})

const digestBytesOf = (opts) => bytesOf(digestProjects(bigScan(opts), { now: T0 }).map((d) => ({ ...d, changedAt: T0 })))
const driftOf = (n) => (n - digestBytes) / digestBytes

ok('the digest does not move with the number of steps a plan has', () => {
  const fewer = digestBytesOf({ steps: 12 })
  console.log('  twelve steps a plan: digest ' + fewer + ' bytes, ' + (100 * driftOf(fewer)).toFixed(2) + '% against a hundred and twenty')
  assert.ok(Math.abs(driftOf(fewer)) <= 0.01, 'the digest moved ' + (100 * driftOf(fewer)).toFixed(2) + '% when every plan went from 120 steps to 12')
})

ok('the digest does not move with the number of plans a worktree has', () => {
  const fewer = digestBytesOf({ plans: 4 })
  console.log('  four plans a worktree: digest ' + fewer + ' bytes, ' + (100 * driftOf(fewer)).toFixed(2) + '% against forty')
  assert.ok(Math.abs(driftOf(fewer)) <= 0.01, 'the digest moved ' + (100 * driftOf(fewer)).toFixed(2) + '% when every worktree went from 40 plans to 4')
})

// ==== the real relay ===========================================================
// It runs as a child on an OS-assigned port with a throwaway data directory,
// no SZG_* variable inherited, and a budget small enough that a handful of
// findings is over it.

const FORCED = 6144

const firstSnapshot = (port, token) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { req.destroy(); reject(new Error('no snapshot frame on the stream')) }, 10_000)
  const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { 'x-mch-token': token } }, (res) => {
    let buf = ''
    res.setEncoding('utf8')
    res.on('error', () => {})
    res.on('data', (c) => {
      buf += c
      const m = buf.match(/event: snapshot\ndata: (.*)\n\n/)
      if (!m) return
      clearTimeout(timer)
      req.destroy()
      resolve(m[1])
    })
  })
  req.on('error', (e) => { clearTimeout(timer); reject(e) })
})

{
  const relayPath = join(ROOT, 'syzygy', 'bridge', 'relay.mjs')
  const TOKEN = 'budget-harness-' + Math.random().toString(36).slice(2)
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'szg-budget-relay-')))
  const fakeClaude = join(scratch, 'claude')
  writeFileSync(fakeClaude, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SZG_')))
  const child = spawn(process.execPath, [relayPath], {
    cwd: ROOT,
    env: {
      ...baseEnv, SZG_PORT: '0', SZG_TOKEN: TOKEN, SZG_DATA_DIR: scratch, SZG_PANE_PASSWORD_DISABLED: '1',
      SZG_CLAUDE_BIN: fakeClaude, SZG_TMUX_BIN: '/usr/bin/false', SZG_SNAPSHOT_BUDGET: String(FORCED),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => { stdout += c })
  child.stderr.on('data', (c) => { stderr += c })

  try {
    const port = await new Promise((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error('relay did not report a port; stderr: ' + stderr)), 15_000)
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error('relay exited early, code ' + code + '; stderr: ' + stderr)) })
      const poll = setInterval(() => {
        const m = stdout.match(/relay on http:\/\/127\.0\.0\.1:(\d+)/)
        if (!m) return
        clearInterval(poll); clearTimeout(timer); resolvePort(Number(m[1]))
      }, 50)
    })
    const base = 'http://127.0.0.1:' + port
    const call = async (method, path, body) => {
      const res = await fetch(base + path, {
        method, headers: { 'content-type': 'application/json', 'x-mch-token': TOKEN },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      let parsed = null
      try { parsed = JSON.parse(text) } catch {}
      return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), text, body: parsed }
    }

    await okAsync('/api/health builds a frame when none has been sent yet', async () => {
      const r = await call('GET', '/api/health')
      assert.equal(r.status, 200)
      const s = r.body.snapshot
      assert.ok(s, 'health carries no snapshot report')
      assert.equal(s.budgetBytes, FORCED, 'the relay did not take its budget from SZG_SNAPSHOT_BUDGET')
      assert.ok(s.bytes > 0)
      assert.equal(s.overBudget, s.bytes > FORCED)
      assert.deepEqual(s.shed, [])
      assert.equal(typeof s.sections.payloadVersion, 'number')
      assert.equal(s.droppedPanes, 0)
    })

    const empty = await call('GET', '/api/state')
    await okAsync('the snapshot declares shed right after t', async () => {
      assert.equal(empty.status, 200)
      assert.deepEqual(Object.keys(empty.body).slice(0, 3), ['payloadVersion', 't', 'shed'])
      assert.deepEqual(empty.body.shed, [])
      assert.ok(Buffer.byteLength(empty.text) <= FORCED, 'an empty board must fit the forced budget, got ' + Buffer.byteLength(empty.text))
    })

    const COUNT = 20
    for (let i = 0; i < COUNT; i++) {
      const r = await call('POST', '/api/findings', {
        token: TOKEN, kind: 'contract', session: 'budget-harness', project: 'budget',
        surprise: 'Finding ' + i + ': a surprise long enough that twenty of them put the frame over its budget.',
        evidence: ['syzygy/bridge/relay.mjs:1'],
      })
      assert.equal(r.status, 200, 'posting a finding failed: ' + r.text)
    }

    const state = await call('GET', '/api/state')
    await okAsync('/api/state sends the shed frame, with the json helper\'s headers', async () => {
      assert.equal(state.status, 200)
      assert.equal(state.type, 'application/json; charset=utf-8')
      assert.equal(state.cache, 'no-store')
      assert.deepEqual(state.body.shed, [{ section: 'findings', kept: 0, dropped: COUNT }])
      assert.deepEqual(state.body.findings, [])
      assert.ok(Buffer.byteLength(state.text) <= FORCED)
      const stored = await call('GET', '/api/findings?limit=200')
      assert.equal(stored.body.findings.length, COUNT, 'the shed reached the store rather than the frame')
    })

    await okAsync('/api/health reports the frame last sent', async () => {
      const s = (await call('GET', '/api/health')).body.snapshot
      assert.equal(s.bytes, Buffer.byteLength(state.text))
      assert.equal(s.budgetBytes, FORCED)
      assert.equal(s.overBudget, false)
      assert.deepEqual(s.shed, state.body.shed)
      assert.deepEqual(Object.keys(s.sections), Object.keys(state.body))
      assert.equal(s.sections.findings, 2)
      assert.equal(s.droppedPanes, 0)
    })

    await okAsync('/api/stream opens with the same shed frame', async () => {
      const frame = JSON.parse(await firstSnapshot(port, TOKEN))
      assert.deepEqual(frame.shed, [{ section: 'findings', kept: 0, dropped: COUNT }])
      assert.deepEqual(frame.findings, [])
    })

    // The real relay's frame with the forty-project board in it.
    const spend = spendDigest(T0)
    const realFrame = {
      ...empty.body,
      sessions: bigSessions(),
      events: bigEvents(),
      findings: (await call('GET', '/api/findings?limit=200')).body.findings,
      skillsQueue: { ...empty.body.skillsQueue, proposals: Array.from({ length: PROPOSALS }, (_, i) => ({ id: 'p' + i, title: 'A reusable skill for measuring a payload ' + i, idea: 'An idea of an ordinary length. '.repeat(6), methodology: 'Read the snapshot and measure each key. '.repeat(6) })) },
      projects: digest,
      spend,
    }

    ok('over the forty-project frame, a 64 KB budget sheds in SHED_ORDER and keeps spend whole', () => {
      const out = shedToBudget(realFrame, { budget: 64 * 1024 })
      assertConsistent(out)
      assert.ok(inShedOrder(out.shed), 'the shed left SHED_ORDER: ' + JSON.stringify(out.shed))
      // No project carries more claimed efforts than the shed keeps, so
      // `efforts` has nothing to drop and writes no row.
      assert.ok(realFrame.projects.every((p) => p.efforts.length <= EFFORTS_SHED_CAP))
      assert.deepEqual(out.shed.map((r) => r.section), SHED_ORDER.filter((s) => s !== 'efforts'))
      assert.deepEqual(out.frame.spend, spend)
      assertOnlyShedSections(realFrame, out.frame)
      assert.equal(out.frame.projects.length, BIG.projects)
      console.log('  forty projects at 64 KB: ' + out.bytes + ' bytes after ' + JSON.stringify(out.shed))
    })

    ok('forty projects and fifteen sessions fit the default budget with nothing shed', () => {
      const frame = { ...empty.body, sessions: bigSessions(), projects: digest, spend }
      const whole = bytesOf({ ...frame, shed: [] })
      const out = shedToBudget(frame)
      assertConsistent(out)
      assert.deepEqual(out.shed, [], 'the budget was met by shedding at forty projects')
      assert.ok(out.bytes < SNAPSHOT_BUDGET_BYTES, 'the frame is ' + out.bytes + ' bytes, over ' + SNAPSHOT_BUDGET_BYTES)
      assert.equal(out.bytes, whole)
      assert.deepEqual(out.frame.spend, spend)
      const top = Object.entries(sectionBytes(frame)).sort((a, b) => b[1] - a[1]).slice(0, 3)
      console.log('  forty projects and fifteen sessions: ' + whole + ' bytes (' + top.map(([k, n]) => k + ' ' + n).join(', ') +
        '); at ' + SNAPSHOT_BUDGET_BYTES + ' it sends ' + out.bytes + ' bytes after ' + JSON.stringify(out.shed))
    })
  } finally {
    // The relay flushes its stores as it exits, so its data directory is
    // removed only once it has.
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await exited
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log(passed + ' passed')
