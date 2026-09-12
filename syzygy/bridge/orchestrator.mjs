// A field under the presence sphere that talks to a headless `claude -p`
// carrying everything Syzygy can see.
//
// Two halves, exactly the shape scoping.mjs uses. The top of this file is the
// PURE half -- the context bundle, the action parser, the preamble and the
// argv -- all exported and tested directly under node, no I/O. Below is the
// IMPURE half: the spawned child and the blurb scheduler, created
// with an injected `spawn` so the harness never runs a real `claude`.

import { spawn as realSpawn } from 'node:child_process'
import { parseNdjson } from './scoping.mjs'
import { childEnv, HEADLESS_SETTINGS } from './canvas.mjs'

/**  hard cap. ~20k tokens at 4 chars/token -- a fifth of the window, and
 *  the number the per-ask `--max-budget-usd` is sized against. */
export const BUNDLE_BUDGET_BYTES = 80 * 1024

const byteLen = (s) => Buffer.byteLength(s, 'utf8')

/** Character clip with an ellipsis. Not the blurb's word-boundary rule,
 *  which is a different function's job -- this only keeps one runaway
 *  field (a note, a last-said line) from dominating its section's budget. */
const clip = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s)

const fmtAge = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h`
}

/** Renders one list-shaped section: a header, then as many `renderItem`
 *  lines as fit in `remaining`, in the order `items` is already in (callers
 *  pass their most-useful-first order). Truncation is never silent -- the
 *  exact count left out is always the last line of the section, even when
 *  that means zero real items fit and the line is the whole of it. An empty
 *  `items` renders nothing at all: there is no difference, to a reader,
 *  between "this relay has no such feature" and "this board genuinely has
 *  none of these right now", and inventing a header for the latter would
 *  only invite the former reading. */
const budgetedSection = ({ header, items, renderItem, noun, remaining }) => {
  if (!items.length) return { text: '', used: 0 }
  // The omission line itself must never be the thing that blows the budget:
  // its own cost is reserved up front (sized against `items.length`, the
  // largest the omitted count could ever be), so the loop below always
  // leaves room for it. Unused when every item ends up fitting -- harmless,
  // since the section is then already under budget on its own.
  const reserve = byteLen(`_… ${items.length} more ${noun} omitted (budget)_\n`)
  const headerCost = byteLen(header + '\n')
  // Not even the header plus a worst-case omission line fits in what is left
  // globally -- an earlier section's own omission line already signalled the
  // budget is spent, so this whole section is dropped rather than emitting a
  // header (or an omission line) that would itself exceed the cap.
  if (headerCost + reserve > remaining) return { text: '', used: 0 }
  let text = header + '\n'
  let shown = 0
  for (const item of items) {
    const rendered = renderItem(item)
    if (rendered == null) continue
    const withNl = rendered + '\n'
    if (byteLen(text) + byteLen(withNl) > remaining - reserve) break
    text += withNl
    shown++
  }
  const omitted = items.length - shown
  if (omitted > 0) text += `_… ${omitted} more ${noun} omitted (budget)_\n`
  return { text, used: byteLen(text) }
}

/** Claims live per-worktree (tasks.mjs's scanner, keyed by session id), never
 *  on the session object itself -- this is the one join bundleContext has to
 * do on its own to show "claims" beside a session's field list. */
const claimFor = (session, projects) => {
  for (const p of projects) {
    for (const w of p.worktrees ?? []) {
      const claim = w.claims?.[session.id]
      if (claim) return claim
    }
  }
  return null
}

const renderSession = (s, projects) => {
  const bits = [
    `- **${s.name || s.id}**`,
    s.branch ? `branch ${s.branch}` : null,
    s.cwd || s.repo || null,
    s.model || null,
    s.working ? 'working' : 'idle',
    s.needs ? `needs: ${clip(String(s.needs), 200)}` : null,
    Number.isFinite(s.idleSince) ? `idle ${fmtAge(Date.now() - s.idleSince)}` : null,
  ]
  const claim = claimFor(s, projects)
  if (claim) bits.push(`claim: ${claim.name || claim.note || 'yes'}`)
  // No `last said` tail. The end of whatever a session last typed is not the
  // same thing as something another session needs to know -- the `## Findings`
  // section below is, and it is structured rather than a sliced transcript.
  return bits.filter(Boolean).join(' · ')
}

/**  records, rendered one to a line. `touched` and `evidence` are
 *  omitted when empty rather than rendered as `touched: ` -- an empty label
 *  reads as "it touched nothing", which is a claim the record never made. */
const renderFinding = (f, nowMs) => {
  const bits = [
    `- **${f.session || 'unattributed'}**`,
    f.project || null,
    Number.isFinite(f.t) ? fmtAge(nowMs - f.t) + ' ago' : null,
    clip(String(f.surprise ?? ''), 600),
  ]
  const touched = Array.isArray(f.touched) ? f.touched.filter(Boolean) : []
  const evidence = Array.isArray(f.evidence) ? f.evidence.filter(Boolean) : []
  if (touched.length) bits.push('touched: ' + clip(touched.join(', '), 300))
  if (evidence.length) bits.push('evidence: ' + clip(evidence.join(', '), 300))
  return bits.filter(Boolean).join(' · ')
}

/** How many findings the bundle will ever show. Everything past this is
 *  older than the board's own memory usefully reaches, and the section is
 *  second in priority order -- it must not be able to crowd out the sections
 *  below it on a relay that has been collecting for a week. */
export const FINDINGS_IN_BUNDLE = 40

/** `bundleContext(snapshot, extras)` -- pure, no I/O. `extras.capture`
 *  is the last-N capture-log entries (capture.mjs's `read()`) and
 * `extras.findings` the findings store's records (findings.mjs), since
 *  neither is part of `snapshot()` at all; every other section reads straight
 *  off the snapshot the caller already has.
 *
 *  Sections render in PRIORITY order, most useful first, so a truncation
 *  sheds the least valuable thing: sessions, findings, links, canvas,
 *  dispatch, projects, recent activity, usage, after-reset, custom steering.
 *  `dispatchOptions`, `voice` and `auth` are never read here at all --
 * capability and configuration, not board state. */
export const bundleContext = (snapshot, extras = {}) => {
  const s = snapshot ?? {}
  const sessions = Array.isArray(s.sessions) ? s.sessions : []
  const links = Array.isArray(s.links) ? s.links : []
  const canvas = s.canvas ?? {}
  const dispatchReqs = Array.isArray(s.dispatch?.requests) ? s.dispatch.requests : []
  const projects = Array.isArray(s.projects) ? s.projects : []
  const captureEntries = Array.isArray(extras?.capture) ? extras.capture.slice(-50) : []
  // NEWEST FIRST, unlike every other section: budgetedSection sheds from the
  // end, and the oldest finding is the one worth losing. `slice` before
  // `reverse` so the reverse is of the tail, not of the whole store.
  const findings = Array.isArray(extras?.findings)
    ? [...extras.findings].slice(-FINDINGS_IN_BUNDLE).reverse()
    : []
  const nowMs = Number.isFinite(extras?.now) ? extras.now : Date.now()

  const parts = []
  let used = 0
  const remaining = () => BUNDLE_BUDGET_BYTES - used
  const add = (built) => {
    if (!built.text) return
    parts.push(built.text)
    used += built.used
  }

  if (remaining() > 0) {
    add(budgetedSection({
      header: '## Sessions', items: sessions, noun: 'sessions', remaining: remaining(),
      renderItem: (session) => renderSession(session, projects),
    }))
  }

  // Second, right after the sessions themselves: a finding is the one
  // thing in this bundle that changes what another session should DO, which
  // makes it worth more than a link, a node position or a queue entry.
  if (remaining() > 0) {
    add(budgetedSection({
      header: '## Findings', items: findings, noun: 'findings', remaining: remaining(),
      renderItem: (f) => renderFinding(f, nowMs),
    }))
  }

  if (remaining() > 0) {
    add(budgetedSection({
      header: '## Links', items: links, noun: 'links', remaining: remaining(),
      renderItem: (l) => `- ${l.from} → ${l.to} (${l.kind || 'brief'})${l.note ? ': ' + clip(String(l.note), 200) : ''}`,
    }))
  }

  if (remaining() > 0) {
    // "Canvas nodes and wires": the wires ARE `links`, already rendered above
    // (canvas.js draws them from `S.links` -- see its own header comment), so
    // this only needs to cover what a link does not: node positions and the
    // spawn ledger.
    const nodeItems = Object.entries(canvas.nodes ?? {}).map(([id, n]) => ({ node: true, id, ...n }))
    const spawnItems = (Array.isArray(canvas.spawnedBy) ? canvas.spawnedBy : []).map((r) => ({ spawn: true, ...r }))
    add(budgetedSection({
      header: '## Canvas', items: [...nodeItems, ...spawnItems], noun: 'canvas entries', remaining: remaining(),
      renderItem: (it) => it.node
        ? `- node ${it.name || it.id} at (${it.x}, ${it.y})`
        : `- spawned ${it.name || it.shortId || '?'} (${it.state || 'starting'})`,
    }))
  }

  if (remaining() > 0) {
    add(budgetedSection({
      header: '## Dispatch queue', items: dispatchReqs, noun: 'requests', remaining: remaining(),
      renderItem: (r) => `- [${r.state}] ${r.title}${r.project ? ' (' + r.project + ')' : ''}`,
    }))
  }

  if (remaining() > 0) {
    add(budgetedSection({
      header: '## Projects', items: projects, noun: 'projects', remaining: remaining(),
      renderItem: (p) => {
        const worktrees = p.worktrees ?? []
        const plans = worktrees.reduce((n, w) => n + (w.plans?.length ?? 0), 0)
        const tasks = worktrees.reduce((n, w) => n + (w.tasks?.length ?? 0), 0)
        return `- **${p.name || p.key}** — ${worktrees.length} worktree(s), ${plans} plan(s), ${tasks} task file(s)`
      },
    }))
  }

  if (remaining() > 0) {
    add(budgetedSection({
      header: '## Recent activity', items: captureEntries, noun: 'entries', remaining: remaining(),
      renderItem: (e) => `- ${e.kind}${e.actor ? ' by ' + e.actor : ''}`,
    }))
  }

  // The older-relay rule: each of these is omitted -- no header, no
  // line -- when the KEY itself is absent from the snapshot, because that is
  // the one way to tell "this relay predates the feature" apart from "this
  // board genuinely has nothing here right now" (which renders fine: an
  // empty list already produces no text at all, from budgetedSection above).
  if (remaining() > 0 && 'usage' in s) {
    const u = s.usage ?? {}
    const lines = []
    if (u.fiveHour) lines.push(`- 5h: ${u.fiveHour.pct}% used`)
    if (u.sevenDay) lines.push(`- 7d: ${u.sevenDay.pct}% used`)
    if (!lines.length) lines.push('- no reading yet')
    const text = '## Usage window\n' + lines.join('\n') + '\n'
    if (byteLen(text) <= remaining()) { parts.push(text); used += byteLen(text) }
  }

  if (remaining() > 0 && 'afterReset' in s) {
    const queue = Array.isArray(s.afterReset?.queue) ? s.afterReset.queue : []
    add(budgetedSection({
      header: '## Scheduled (after reset)', items: queue, noun: 'entries', remaining: remaining(),
      renderItem: (e) => `- ${e.kind} for ${e.window}${e.target ? ' → ' + e.target : ''}`,
    }))
  }

  if (remaining() > 0 && 'steering' in s) {
    const custom = Array.isArray(s.steering?.custom) ? s.steering.custom : []
    add(budgetedSection({
      header: '## Custom steering', items: custom, noun: 'commands', remaining: remaining(),
      renderItem: (c) => `- ${c.label}: ${clip(String(c.text ?? ''), 200)}`,
    }))
  }

  return parts.join('')
}

// ---------------------------------------------------------------- actions --
/** The required fields of every understood action kind (extended by
 *  Each apply path is an endpoint that ALREADY existed:
 *
 *    link     -> POST /api/link
 *    prompt   -> POST /api/command   (verb 'prompt')
 *    dispatch -> POST /api/request/create
 *    spawn    -> POST /api/spawn     (canvas.mjs's spawnSession: argv array,
 *                                     prompt last behind `--`, childEnv())
 *
 * accepted any object whose `kind` was known and let the server sort
 *  out the rest. That is fine for two kinds whose fields are two session ids;
 *  for `spawn` it would render a button that can only ever 400, so every kind
 *  now declares what it needs and a proposal missing a field is `rejected`
 * -- reported to the user, never turned into a button.
 *  Optional fields are deliberately absent from these lists: `link.note`,
 *  `prompt.report_to`, `dispatch.project`/`ask`/`brief` and
 *  `spawn.name`/`model`/`effort` are all omittable. */
export const ACTION_REQUIRED = {
  link: ['from', 'to'],
  prompt: ['to', 'text'],
  dispatch: ['title'],
  spawn: ['cwd', 'prompt'],
}

/** /: nothing outside this set is understood; an unknown kind is
 *  dropped and reported, never applied. */
export const KNOWN_ACTION_KINDS = new Set(Object.keys(ACTION_REQUIRED))

/** The sentence `report_to` folds into a prompt's text. Exported and
 *  pure so the phrasing is asserted here rather than duplicated into a
 *  browser script that cannot import this module -- which is also why the
 *  fold happens in `parseActions` and not in the pane: what the button's
 *  tooltip shows is then exactly what will be enqueued.
 *
 *  The four things it asks for are deliberately the four fields of a
 * findings record, so a report can become one without being rewritten. */
export const reportInstruction = (name) => [
  '',
  '',
  '---',
  `When you have finished this, send your report to the session named "${name}"`,
  'with SendMessage: what you did, what you touched, and anything that',
  'surprised you, with file:line evidence for it.',
].join('\n')

const FENCE_RE = /```json\s*\n?([\s\S]*?)```/gi

/** Pure. Reads the LAST fenced ```json block in `text` (the reply "may END
 * with" one) and ignores every other character -- prose before,
 *  after, or between fences is not the contract, only the block is. No block
 *  at all, or a block that is not valid JSON, both degrade to `{actions: [],
 *  rejected: []}` rather than throwing: a malformed proposal is nothing
 *  proposed, not a crashed turn.
 *
 *  also returns `text` -- the reply with the parsed
 *  fence itself removed, so the pane can show the model's prose and the
 *  action button without the raw JSON block sitting above it as visible
 *  text. Stripped ONLY when the fence's JSON actually parsed: a block that
 *  failed to parse is left in `text` untouched (the two early returns below
 *  both hand back the ORIGINAL string) -- if it is malformed, hiding it
 *  destroys the only evidence of what went wrong. Only the matched fence's
 *  own span is removed; an earlier, unrelated fenced code block the model
 *  included for illustration is left exactly as written. */
/** A `prompt` carrying a non-empty `report_to` comes back as a NEW
 *  object with the instruction folded into its `text`; one without passes
 *  through byte-for-byte unchanged (the same object, not a copy), so a
 *  proposal that names nobody is exactly what it always was. Never mutates its input. */
const withReportTo = (a) => {
  const to = typeof a.report_to === 'string' ? a.report_to.trim() : ''
  if (!to) return a
  return { ...a, report_to: to, text: String(a.text) + reportInstruction(to) }
}

export const parseActions = (text) => {
  const s = typeof text === 'string' ? text : ''
  const matches = [...s.matchAll(FENCE_RE)]
  if (!matches.length) return { actions: [], rejected: [], text: s }
  const last = matches[matches.length - 1]
  let parsed
  try { parsed = JSON.parse(last[1]) } catch { return { actions: [], rejected: [], text: s } }
  const list = Array.isArray(parsed?.actions) ? parsed.actions : []
  const actions = []
  const rejected = []
  for (const a of list) {
    if (!a || typeof a !== 'object' || !KNOWN_ACTION_KINDS.has(a.kind)) { rejected.push(a); continue }
    // a known kind missing a required field is rejected, not applied.
    const missing = ACTION_REQUIRED[a.kind].some((k) => !(typeof a[k] === 'string' && a[k].trim()))
    if (missing) { rejected.push(a); continue }
    actions.push(a.kind === 'prompt' ? withReportTo(a) : a)
  }
  const stripped = (s.slice(0, last.index) + s.slice(last.index + last[0].length)).trim()
  return { actions, rejected, text: stripped }
}

// ------------------------------------------------------------- the call ---
/** Identity lives in the system prompt, never the user turn --
 *  the bundle is the user turn, fresh on every ask. Shared by both the ask
 * and the blurb call (passes a different preamble/model/budget to
 *  `askArgv` for the blurb; the argv shape is identical either way, which is
 *  why there is one exported builder and not two). */
export const ORCHESTRATOR_PREAMBLE = [
  'You are Syzygy, an orchestrator with a live, read-only view of a Claude Code',
  'session board: every session, the canvas layout, the dispatch queue, this',
  'project\'s worktrees/plans/backlog, and a log of recent actions.',
  '',
  'You may PROPOSE actions. You may never PERFORM one -- nothing you say',
  'changes anything by itself. A human clicks a button to apply a proposal.',
  '',
  'The "Findings" section is what other sessions have learned that changes',
  'somebody else\'s work. Weigh it: it is the most decision-relevant thing you',
  'can see, and the evidence beside each one is a real file:line.',
  '',
  'Write your answer to the user first, in plain prose. If you have a',
  'concrete action to propose, end your reply with exactly one fenced JSON',
  'block containing an "actions" array and nothing else. Four kinds are',
  'understood, and every field shown without a "?" is required:',
  '```json',
  '{"actions": [',
  '  {"kind": "link", "from": "<session>", "to": "<session>", "note?": "<why>"},',
  '  {"kind": "prompt", "to": "<session>", "text": "<what to say>", "report_to?": "<session>"},',
  '  {"kind": "dispatch", "title": "<brief title>", "project?": "<absolute repo path>", "ask?": "<the ask, in full>"},',
  '  {"kind": "spawn", "cwd": "<absolute directory>", "prompt": "<the brief to start with>", "name?": "<session name>"}',
  ']}',
  '```',
  '"report_to" names the session the prompted session should send its report',
  'to; it is folded into the prompt for you, so do not write the instruction',
  'yourself. "dispatch" queues a brief on the Dispatch tab for a human to',
  'scope and dispatch; its "project" must be an ABSOLUTE PATH -- the project\'s',
  'mainRoot, exactly as the board state shows it -- and never a repo name,',
  'because it becomes a working directory and a bare name is refused.',
  '"spawn" starts a new session immediately in a directory',
  'that must already exist -- prefer "dispatch" unless the work is a quick,',
  'self-contained collection task.',
  '',
  'Nothing else is understood, and an action missing a required field is',
  'discarded. Omit the block entirely when you have nothing concrete to',
  'propose -- do not propose something just to fill it.',
].join('\n')

/** Mirrors `scopeArgv` exactly (scoping.mjs): argv is always an ARRAY, the
 *  prompt is always the final element, and `--verbose` is not optional --
 *  the CLI refuses `--print --output-format stream-json` without it, and a
 *  harness with a fake `spawn` cannot catch its absence. */
export const askArgv = ({ text, sessionId = null, model = 'opus', budgetUsd = 1, preamble = ORCHESTRATOR_PREAMBLE, safeMode = false }) => {
  const argv = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
  // See scoping.mjs's scopeArgv: the same two layers, for the same reason.
  if (safeMode) argv.push('--safe-mode')
  argv.push('--settings', HEADLESS_SETTINGS)
  argv.push('--model', String(model))
  argv.push('--max-budget-usd', String(budgetUsd))
  argv.push('--append-system-prompt', String(preamble))
  if (sessionId) argv.push('--resume', String(sessionId))
  argv.push(String(text))
  return argv
}

// =================================================================== 
// ---------------------------------------------------------- the impure half
// Mirrors bridge/scoping.mjs's createScoper's child lifecycle exactly: a
// single `settle` gate so 'error' and 'close' -- independent events, either
// of which can fire alone -- can never resolve one run twice; stdout parsed
// by scoping.mjs's own `parseNdjson`; an `onFrame` exception caught at the
// stream boundary so one bad frame cannot take the whole relay down.

// Sonnet, not opus. The ask reads a bundle and answers about it; that is not work that
// needs the larger model, and every ask is real money. `SZG_ORCH_MODEL`
// overrides it without a code change if a harder question ever wants opus.
export const DEFAULT_ASK_MODEL = 'sonnet'
export const DEFAULT_BLURB_MODEL = 'sonnet'
// A budget has to clear a turn's fixed overhead as well as its own work:
// SessionStart hooks alone can cost several cents before the model is asked
// anything. Kept here as the single source of truth for both budgets.
export const DEFAULT_ASK_BUDGET_USD = 1
export const DEFAULT_BLURB_BUDGET_USD = 0.2
export const DEFAULT_ASK_TIMEOUT_MS = 120_000
export const DEFAULT_BLURB_TIMEOUT_MS = 45_000
export const DEFAULT_BLURB_MIN_MS = 10 * 60_000
export const BLURB_MAX_CHARS = 140

/** one line, word-wrapped down to `max` characters rather than cut
 *  mid-word. Pure, exported so the harness can assert it directly. */
export const clipToWordBoundary = (s, max = BLURB_MAX_CHARS) => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim() + '…'
}

/** A coarse fingerprint of the things worth summarising: session identity
 *  and status, links, dispatch state, canvas structure. Deliberately
 *  EXCLUDES continuously-ticking telemetry -- token/spend series, seenAt,
 *  the top-level snapshot timestamp -- because those change on every
 *  heartbeat even when nothing a summary would ever mention has happened.
 * Fingerprinting them would make "only when the board changed" true on
 *  every tick, which defeats the whole reason the gate exists: an
 *  unattended relay must spend nothing. */
const boardFingerprint = (snap) => JSON.stringify({
  sessions: (snap?.sessions ?? []).map((s) => ({ id: s.id, working: s.working, needs: s.needs, branch: s.branch, model: s.model })),
  links: snap?.links ?? [],
  dispatch: (snap?.dispatch?.requests ?? []).map((r) => ({ id: r.id, state: r.state })),
  canvasNodes: Object.keys(snap?.canvas?.nodes ?? {}).length,
  canvasLive: snap?.canvas?.live ?? 0,
})

const BLURB_PREAMBLE = [
  'You are Syzygy, summarising a live Claude Code session board for a person',
  'glancing at a sidebar. Reply with ONE line, at most 140 characters: no',
  'preamble, no quotes, no markdown -- just the summary itself.',
].join('\n')

const uid = () => Math.random().toString(36).slice(2, 10)

/** `createOrchestrator({spawn, claudeBin, broadcast, capture, ...})`. Beyond
 *  the four headline params: `snapshot()` and `panesSize()` are getters (the
 *  same lazy-closure trick relay.mjs already uses for `voicePayload` --
 *  referenced only inside a function body invoked well after the module
 *  finishes initialising, so construction order does not matter), and the
 *  model/budget/timeout knobs carry their own defaults so a caller only
 *  overrides what an env var actually configures. */
export const createOrchestrator = ({
  spawn = realSpawn,
  claudeBin = 'claude',
  // See scoping.mjs's createScoper: probed once at boot, defaults false.
  safeMode = false,
  broadcast,
  capture,
  // The findings store (findings.mjs). Optional and duck-typed
  // exactly like `capture` above: a caller that has none -- the harness, a
  // relay predating the store -- simply renders no `## Findings` section,
  // which is the honest result rather than an empty one.
  findings = null,
  snapshot = () => ({}),
  panesSize = () => 0,
  now = Date.now,
  askModel = DEFAULT_ASK_MODEL,
  blurbModel = DEFAULT_BLURB_MODEL,
  askBudgetUsd = DEFAULT_ASK_BUDGET_USD,
  blurbBudgetUsd = DEFAULT_BLURB_BUDGET_USD,
  askTimeoutMs = DEFAULT_ASK_TIMEOUT_MS,
  blurbTimeoutMs = DEFAULT_BLURB_TIMEOUT_MS,
  blurbMinMs = DEFAULT_BLURB_MIN_MS,
} = {}) => {
  /** The concurrency cap of ONE, SHARED between ask and blurb (numbers
   *  table) -- a single slot, not a map keyed by request id the way
   *  scoping.mjs's `live` is, because there is never more than one child
   *  running here by construction. `kind` ('ask' | 'blurb') and `preempted`
   *  are an ask may preempt an in-flight BLURB and take
   *  the slot for itself -- never another ask, which stays a 409 forever,
   *  the cap that bounds cost. See `preemptLiveBlurb` and `ask()` below. */
  let live = null // { child, timer, kind, preempted }
  let sessionId = null
  let blurb = ''
  let blurbAt = 0
  let lastBoardKey = null

  // `asking` is NOT `busy`. `busy` covers the ONE shared slot, which the
  // invisible after-reply blurb also takes; the pane's thinking animation
  // must follow a real ASK only, or it lingers for up to blurbTimeoutMs
  // after the answer has already finished streaming, where it lingers with
  // nothing behind it.
  const state = () => ({ blurb, blurbAt, busy: !!live, asking: live?.kind === 'ask' })

  /** One child turn. `onFrame` sees every parsed stdout object; resolves once
   *  with `{code, errText, preempted}` on a real exit OR a spawn failure
   *  alike, so a caller's `code !== 0` check covers both paths with no
   *  separate error branch -- identical reasoning to scoping.mjs's own
   *  `run`. `kind` tags the slot ('ask' | 'blurb') so `ask()` can
   *  tell what it would be waiting behind. */
  const run = (argv, timeoutMs, onFrame, kind) =>
    new Promise((resolve) => {
      let settled = false
      // This run's OWN slot object -- captured locally, not read back off
      // the shared `live` binding, because by the time this settles `live`
      // may already belong to a DIFFERENT run (an ask claims the
      // slot the instant it starts, while the blurb it preempted is still
      // unwinding toward its own 'close' event).
      let mySlot = null
      const settle = (result) => {
        if (settled) return
        settled = true
        if (mySlot) {
          clearTimeout(mySlot.timer)
          // Only clear the SHARED pointer if it still points at THIS run's
          // slot. Without this guard, a killed blurb's delayed 'close'
          // event would null out `live` out from under the ask that
          // preempted it and has been running ever since.
          if (live === mySlot) live = null
        }
        resolve(result)
      }

      let child
      try {
        // env: childEnv() -- no SZG_* variable may reach a spawned child
        // (canvas.mjs's childEnv/RELAY_ENV_PREFIX; see its header for why
        // this is not hygiene: it prevents a real cross-session leak).
        // stdio: the prompt is always on the ARGV
        // (askArgv puts it last), so this child never reads stdin -- but
        // Node's default 'pipe' leaves stdin OPEN, and the CLI itself waits
        // a hardcoded 3s for input that will never arrive before printing
        // "proceeding without it" and continuing. Verified live: first
        // stdout byte at +4.1s with the default pipe, +1.4s with stdin
        // closed outright -- a real 2.7s+ stall on every single turn, not
        // a cosmetic warning. `'ignore'` closes it before the child can
        // ever wait on it.
        child = spawn(claudeBin, argv, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        resolve({ code: -1, errText: `spawn threw: ${err?.message ?? err}`, preempted: false })
        return
      }

      const timer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch {}
      }, timeoutMs)
      timer.unref?.()
      mySlot = { child, timer, kind, preempted: false }
      live = mySlot

      let buf = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        try {
          buf = parseNdjson(buf + chunk, onFrame)
        } catch (err) {
          process.stderr.write(`[orchestrator] onFrame threw: ${err?.stack || err}\n`)
        }
      })
      let errText = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { errText += chunk })

      // Both independent, both resolve through the one `settle` gate -- see
      // scoping.mjs's `run` for the full reasoning (a spawn failure with no
      // 'error' listener would otherwise re-throw as an uncaught exception,
      // fatal to this long-lived relay process).
      child.on('error', (err) => settle({ code: -1, errText: `spawn failed: ${err.message}`, preempted: mySlot.preempted }))
      child.on('close', (code) => settle({ code, errText, preempted: mySlot.preempted }))
    })

  /** an ask may preempt an in-flight BLURB turn and take the shared
   *  slot for itself -- never another ask (that path in `ask()` below still
   *  returns 409 unconditionally). Marks the slot `preempted` so its own
   *  `run()` resolves with `preempted: true` -- `refreshBlurb` reads that to
   *  skip its `lastBoardKey`/`blurbAt` bookkeeping and its `busy:false`
   *  broadcast, since a turn that never finished must not be recorded as
   *  one that did, and the slot (and `busy`) now belong to the ask -- then
   *  kills the child. `settle()`'s `live === mySlot` guard above is what
   *  lets the ask's OWN `run()` claim `live` right away without the killed
   *  child's later close/error event corrupting it. */
  const preemptLiveBlurb = () => {
    if (!live || live.kind !== 'blurb') return
    live.preempted = true
    try { live.child.kill('SIGTERM') } catch {}
  }

  /** known CLI noise that must never be shown to the user as though
   *  it were the reason a turn failed -- verified live that a budget-
   *  exhaustion run writes NOTHING useful to stderr at all, only this
   *  warning (fixed at the source by closing the child's stdin, but filtered
   *  here too in case an older or different `claude` binary still emits it or
   *  something similar). The raw text is still written to the RELAY's own
   *  stderr at both call sites below for real diagnosis; this only filters
   *  what the PANE is shown. */
  const STDERR_NOISE_RE = /^.*no stdin data received.*$/gim
  const sanitizeStderr = (raw) => String(raw ?? '').replace(STDERR_NOISE_RE, '').trim()

  /** Assembles the assistant's text across every streamed frame and, in
   *  passing, the session id the first system frame carries -- the two
   *  things both `ask` and `refreshBlurb` need out of a run, so this is
   *  their one shared reducer. `onDelta`, when given, is called with each
   *  new chunk of text as it streams in (ask's SSE deltas; refreshBlurb has
   *  nothing to stream, so it omits it).
   *
   *  `askArgv` already passes `--include-partial-
   *  messages`, but this used to read ONLY the completed `assistant` frame
   *  -- which the CLI emits once a content block finishes, not once the
   *  whole turn finishes, but for a typical single-text-block reply that is
   *  effectively all at once near the end, not real streaming. Verified
   *  live against 2.1.269 before coding, since a mocked subprocess cannot
   *  verify a frame shape any more than it can verify a command line -- with
   *  `--include-partial-messages`, the real shape is
   *  `{type:'stream_event', event:{type:'content_block_delta',
   *  index, delta:{type:'text_delta', text}}}`, preceded by
   *  `{type:'stream_event', event:{type:'content_block_start', index,
   *  content_block:{type:'text'|'thinking',...}}}` -- captured to
   *  test/fixtures/orchestrator-stream-sample.ndjson (signature blobs
   *  truncated for size; every field name and shape is verbatim). Only
   *  deltas belonging to a `text`-typed block count -- `thinking` deltas are
   *  real but must never leak into the visible reply.
   *
   *  `streamedAny` is what keeps the completed `assistant` frame from
   *  DOUBLING a reply that already streamed via deltas: once any delta has
   *  been consumed above, a later `assistant` frame for that same (or any
   *  later) block is a re-statement of text already captured, not new
   *  information, and is skipped. A CLI or a run that emits no partials at
   *  all (`streamedAny` stays false) falls through to taking the completed
   *  frame whole, so a CLI that never streams degrades to a full reply
   *  rather than to an empty transcript. */
  const collectReply = (onDelta) => {
    let text = ''
    let gotSessionId = null
    let streamedAny = false
    const blockTypes = new Map() // stream_event content_block index -> its type
    let resultFrame = null
    return {
      handle: (frame) => {
        if (frame.type === 'system' && frame.session_id) gotSessionId = frame.session_id
        if (frame.type === 'result') resultFrame = frame
        if (frame.type === 'stream_event') {
          const ev = frame.event ?? {}
          if (ev.type === 'content_block_start') {
            blockTypes.set(ev.index, ev.content_block?.type)
          } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && blockTypes.get(ev.index) === 'text') {
            const t = ev.delta.text || ''
            if (t) { text += t; streamedAny = true; onDelta?.(t) }
          }
          return
        }
        if (frame.type === 'assistant') {
          if (streamedAny) return
          const t = (frame.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('')
          if (t) { text += t; onDelta?.(t) }
        }
      },
      text: () => text,
      sessionId: () => gotSessionId,
      // the terminal `result` frame -- when present -- carries the
      // CLI's own human-readable reason for a non-zero exit (`errors`,
      // e.g. "Reached maximum budget ($1.00)"), verified live to be a far
      // better source than stderr, which on a budget-exhaustion run carried
      // NOTHING at all (see ask()'s error-message construction).
      result: () => resultFrame,
    }
  }

  const NO_CLAUDE_ERR = 'no claude binary with --bg was found — see the relay\'s stderr'

  /** POST /api/orchestrator/ask. A fresh bundle on every turn (the board
   *  moves between turns, and a stale reading is a confident wrong answer),
   *  `--resume`d against the stored session id until `clear()`. Returns as
   *  soon as the turn finishes (or fails) -- there is no reason to hold the
   *  HTTP response open when every frame already streams over SSE.
   *
   *  the shared slot no longer silently eats the next
   *  ask for up to `blurbTimeoutMs` after every reply. `refreshBlurb`'s own
   *  after-reply call takes the SAME slot this checks, so without this an
   *  ask typed in that window -- exactly when a human types a follow-up --
   *  got an opaque 409. Only a BLURB is preemptible; another ask still
   *  always 409s, which is what bounds cost. */
  async function ask(text) {
    if (live) {
      if (live.kind !== 'blurb') return { ok: false, error: 'the orchestrator is already busy with a turn', code: 409 }
      preemptLiveBlurb()
    }
    if (!claudeBin) return { ok: false, error: NO_CLAUDE_ERR, code: 503 }
    const id = uid()
    const bundle = bundleContext(snapshot(), { capture: capture?.read?.({ limit: 50 }) ?? [], findings: findings?.read?.() ?? [], now: now() })
    const turn = `## Board state (now)\n\n${bundle}\n\n${text}`
    const argv = askArgv({ text: turn, sessionId, model: askModel, budgetUsd: askBudgetUsd, safeMode })
    try { capture.append('ask', '', { text }) } catch {}
    broadcast('orchestrator', { busy: true, asking: true })
    const collector = collectReply((delta) => broadcast('orchestrator', { id, delta }))
    const { code, errText } = await run(argv, askTimeoutMs, collector.handle, 'ask')
    if (collector.sessionId()) sessionId = collector.sessionId()
    if (code !== 0) {
      // whatever text the model DID produce before the turn ended is
      // never thrown away -- a budget-exhaustion run, verified live, still
      // streams a complete, usable reply and only THEN reports
      // is_error/errors on the terminal `result` frame; the old code
      // discarded any already-streamed answer the instant `code !== 0`,
      // which is why a real failed turn looked like "no answer at all."
      // An error frame, never an unhandled rejection: `run` above already
      // resolves rather than throws on every failure path, and this is the
      // one place that result turns into something the pane can show.
      if (errText) process.stderr.write(`[orchestrator] ask child stderr: ${errText}\n`)
      const result = collector.result()
      const resultReason = Array.isArray(result?.errors) && result.errors.length ? result.errors.join('; ') : null
      const message = (resultReason || sanitizeStderr(errText) || `exit ${code}`).slice(0, 400)
      const { text: partial } = parseActions(collector.text())
      broadcast('orchestrator', { id, text: partial, error: message, busy: false, asking: false })
      return { ok: true, id }
    }
    const { actions, rejected, text: cleanText } = parseActions(collector.text())
    broadcast('orchestrator', { id, done: true, text: cleanText, actions, rejected, busy: false, asking: false })
    // "after every ask reply" is one of the blurb's three triggers,
    // unconditional -- force:true skips the timer-only gates (a pane
    // connected, the board changed, the 10-minute floor). Fire and forget:
    // a slot that is busy (there is none right now; this ask just freed it)
    // or a spawn failure must never surface as THIS ask's own error.
    refreshBlurb({ force: true }).catch(() => {})
    return { ok: true, id }
  }

  /** POST /api/orchestrator/clear. Drops the stored session id so the next
   *  ask starts a fresh conversation rather than `--resume`ing this one. */
  function clear() {
    sessionId = null
    return { ok: true }
  }

  /** The blurb. `force: true` is the ↻ button and the after-ask-reply
   *  trigger -- both unconditional beyond the shared concurrency cap and
   *  having a binary at all. `force: false` (the default) is the PERIODIC
   *  TIMER's own call, and only that call is gated on all three of: a pane
   *  connected, the board having changed since the last blurb, and at least
   *  `blurbMinMs` since the last one -- so an unattended relay spends
   * nothing. */
  async function refreshBlurb({ force = false } = {}) {
    if (live) return { ok: false, error: 'busy', code: 409 }
    if (!claudeBin) return { ok: false, error: NO_CLAUDE_ERR, code: 503 }
    const snap = snapshot()
    if (!force) {
      if (!(panesSize() > 0)) return { ok: false, error: 'no pane connected' }
      if (now() - blurbAt < blurbMinMs) return { ok: false, error: 'refreshed too recently' }
      if (boardFingerprint(snap) === lastBoardKey) return { ok: false, error: 'the board has not changed' }
    }
    const bundle = bundleContext(snap, { capture: capture?.read?.({ limit: 50 }) ?? [], findings: findings?.read?.() ?? [], now: now() })
    const argv = askArgv({ text: `## Board state (now)\n\n${bundle}`, model: blurbModel, budgetUsd: blurbBudgetUsd, preamble: BLURB_PREAMBLE, safeMode })
    const collector = collectReply()
    // `ask()` broadcasts its own busy:true at its start; this is the mirror
    // for the blurb, needed for the SAME reason -- `live` is the ONE shared
    // slot, so a pane watching only ask's own frames would otherwise see
    // busy:false the instant an ask finishes while its own after-reply blurb
    // refresh is still silently holding that slot, and a next ask typed right
    // then would get an unexplained 409.
    // busy:true, asking:FALSE — the blurb holds the shared slot (so a typed
    // follow-up is queued correctly) but is invisible work, and must not
    // leave the sphere thinking after the answer has finished streaming.
    broadcast('orchestrator', { busy: true, asking: false })
    const { code, preempted } = await run(argv, blurbTimeoutMs, collector.handle, 'blurb')
    // an ask claimed the shared slot mid-turn (preemptLiveBlurb).
    // The slot -- and `busy` -- now belong to THAT ask, which already
    // broadcast its own busy:true; broadcasting busy:false here would be a
    // stale, WRONG signal while the ask is still running. Nor may
    // lastBoardKey/blurbAt move: this board reading was never actually
    // summarised, so a later periodic tick against the SAME board must
    // still be free to try it, rather than reading "no change since the
    // last (preempted) attempt" and skipping forever.
    if (preempted) return { ok: false, error: 'preempted by an ask' }
    // Both refreshed on EVERY attempt, success or failure -- not just on a
    // usable reply. `lastBoardKey` stops a turn that failed against THIS
    // board from being retried every tick until the board changes again on
    // its own; `blurbAt` stops a claude that keeps failing on a board that
    // keeps changing from bypassing the 10-minute floor entirely, which
    // it would if only a SUCCESS ever moved the clock forward.
    lastBoardKey = boardFingerprint(snap)
    blurbAt = now()
    if (code !== 0 || !collector.text().trim()) {
      broadcast('orchestrator', { busy: false, asking: false })
      return { ok: false, error: 'blurb turn failed' }
    }
    blurb = clipToWordBoundary(collector.text())
    broadcast('orchestrator', { blurb, blurbAt, busy: false, asking: false })
    return { ok: true, blurb }
  }

  /** Registered in relay.mjs's existing `shutdown()`, beside
   *  `scoper.killAll()`. */
  function killAll() {
    if (live) {
      clearTimeout(live.timer)
      try { live.child.kill('SIGTERM') } catch {}
    }
    live = null
  }

  return { ask, clear, refreshBlurb, state, killAll, busy: () => !!live }
}
