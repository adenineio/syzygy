// The fleet: one steering click reaching many sessions, and the architecture
// sweep that reads what they wrote.
//
// Everything that DECIDES is pure and exported here so the harness can drive
// it directly; the one action takes an injected runner. Same division
// canvas.mjs draws, and for the same reason: a harness that mocks the
// subprocess cannot verify a command line, so the argv is built by a pure
// function that IS asserted literally, and run by something that is not.

import { join } from 'node:path'
import { spawnArgv, spawnEnvSettings, childEnv, MODELS, EFFORTS, DEFAULT_MODEL, DEFAULT_EFFORT } from './canvas.mjs'
import { parseBackgrounded, worktreePathFor } from './dispatch.mjs'
import { hasLineEvidence } from './findings.mjs'

/** The most sessions one command may reach. Over this the request is REFUSED
 *  with the count named -- never truncated. A silently shortened broadcast is
 *  still an instruction some sessions will follow, and whoever clicked
 *  believes everyone got it. */
export const FLEET_MAX = 32

/** Which sessions a /api/command body is aimed at. `ids` is the relay's live
 *  sessions in board order, passed in -- this module never reads relay state.
 *
 *  EXACTLY ONE selector. Zero is a mistake; two is a mistake the pane could
 *  make while a modifier is held, and guessing which wins would send a
 *  broadcast somebody meant for one card.
 *
 *  An unknown id refuses the WHOLE request rather than skipping it: reporting
 *  a go-ahead that never verified it reached anyone is the thing to avoid.
 *  Validation runs before the first enqueue, so a fan-out is all-or-nothing
 *  and there is no partial state to report. */
export const resolveTargets = ({ body, ids, max = FLEET_MAX }) => {
  const b = body && typeof body === 'object' ? body : {}
  const known = new Set(ids ?? [])
  const picked = [
    b.all === true ? 'all' : null,
    Array.isArray(b.targetIds) || typeof b.targetIds === 'string' ? 'subset' : null,
    b.targetId != null && b.targetId !== '' ? 'one' : null,
  ].filter(Boolean)

  if (picked.length === 0) {
    return { ok: false, status: 400, error: 'one of `targetId`, `targetIds` or `all` is required' }
  }
  if (picked.length > 1) {
    return { ok: false, status: 400, error: `exactly one of \`targetId\`, \`targetIds\` or \`all\` — got ${picked.join(' and ')}` }
  }

  const scope = picked[0]
  let want
  if (scope === 'all') {
    want = [...known]
    if (!want.length) return { ok: false, status: 400, error: 'no sessions are registered with this relay' }
  } else if (scope === 'subset') {
    if (!Array.isArray(b.targetIds) || b.targetIds.length === 0) {
      return { ok: false, status: 400, error: '`targetIds` must be a non-empty array of session ids' }
    }
    // De-duplicated, and ordered by the BOARD rather than by the body, so the
    // capture line and the response read in the order the board shows.
    const asked = new Set(b.targetIds.map(String))
    const unknown = [...asked].filter((id) => !known.has(id))
    if (unknown.length) {
      return { ok: false, status: 404, error: `unknown session${unknown.length > 1 ? 's' : ''}: ${unknown.slice(0, 5).join(', ')}` }
    }
    want = [...known].filter((id) => asked.has(id))
  } else {
    const id = String(b.targetId)
    if (!known.has(id)) return { ok: false, status: 404, error: 'unknown session' }
    want = [id]
  }

  if (want.length > max) {
    return { ok: false, status: 400, error: `${want.length} targets is over the ${max}-session cap — pick a subset` }
  }
  return { ok: true, ids: want, scope }
}

/** How long the board must have been quiet before a sweep is "between
 *  milestones". A sweep is worth most between milestones and worst
 *  mid-flight, and an impulse trigger makes it the thing it was built to
 *  prevent. SZG_SWEEP_QUIET_MS overrides it, in relay.mjs. */
export const SWEEP_QUIET_MS = 20 * 60_000

/** Where a sweep's review lands, inside the sweep's own worktree:
 *  docs/reviews/<date>-architecture-sweep.md. Exported so the harness builds
 *  the path rather than spelling it. */
export const REVIEW_DIR = 'docs/reviews'

/** Whether the fleet is quiet enough for an unattended sweep to start, with
 *  both refusal directions stated plainly. */
export const sweepGate = ({ sessions = [], requests = [], spawnedBy = [], now = Date.now(), quietMs = SWEEP_QUIET_MS, override = false }) => {
  // `waiting` comes from `claude agents --json` -- Claude Code's own knowledge
  // -- and a waiting session is parked on a question, not working. relay.mjs's
  // /api/stats comment records why that matters: `working` only means a turn
  // is OPEN, and a session at a permission prompt heartbeats working:true
  // forever. Counting those would let one forgotten prompt disable the sweep.
  const busy = [
    ...sessions.filter((s) => s.working && !s.waiting).map((s) => s.name || String(s.id ?? '').slice(0, 8)),
    ...requests.filter((r) => r?.session?.state === 'working').map((r) => r.slug || r.id),
    // A null state is NOT busy here -- the OPPOSITE of isLiveSpawn, which
    // counts it for a day. The live COUNT fails closed because an undercount
    // lets somebody start work they did not mean to; this GATE fails open
    // because an overcount disables a button forever after one failed
    // `claude agents` call. Different failure directions, on purpose.
    ...spawnedBy.filter((r) => r?.state === 'working').map((r) => r.name || r.shortId),
  ].filter(Boolean)

  const lastBusyAt = sessions.reduce(
    (acc, s) => Math.max(acc, s.working && !s.waiting ? now : (s.idleSince ?? s.startedAt ?? 0)), 0)
  const quietFor = now - lastBusyAt

  if (override) return { ok: true, reason: 'override — the gate was refused and overridden', busy, quietFor }
  if (busy.length) {
    return { ok: false, busy, quietFor, reason: `${busy.length} session${busy.length > 1 ? 's are' : ' is'} working: ${busy.slice(0, 4).join(', ')}` }
  }
  if (quietFor < quietMs) {
    return { ok: false, busy, quietFor, reason: `the board went quiet ${Math.round(quietFor / 60_000)} min ago; a sweep waits ${Math.round(quietMs / 60_000)}` }
  }
  return { ok: true, busy, quietFor, reason: '' }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One finding, as its own markdown block: what kind of fact it is (or
 *  "unclassified" when the session left it blank), who found it, when, the
 *  surprise itself, and whatever it touched. The time is an absolute ISO
 *  stamp, never an "ago": the file is read later by a session that has no
 *  idea when it was written, and a relative time would be wrong by then. */
const renderFinding = (f) => {
  const kind = f.kind || 'unclassified'
  const who = f.session || 'an unnamed session'
  const at = Number.isFinite(Number(f.t)) ? new Date(Number(f.t)).toISOString() : 'unknown'
  let md = `\n### ${kind} — ${who}\n\n${f.surprise}\n- at: ${at}\n`
  if (f.touched?.length) md += `- touched: ${f.touched.join(', ')}\n`
  const ev = Array.isArray(f.evidence) ? f.evidence : []
  if (ev.length) md += `- evidence: ${ev.join(', ')}\n`
  return md
}

/** Every finding recorded after `since`, as markdown grouped by project and
 *  ordered newest first inside each group. `project` never narrows what gets
 *  rendered -- it only names which project the review is about to land in,
 *  because the value of reading across the fleet is the picture no single
 *  project's findings would show on their own. A finding whose evidence
 *  carries no `file:line` still gets its own entry, set apart under a plain
 *  marker rather than dropped: the store already keeps only a rolling
 *  window, so losing a vague one here loses a fact nothing else remembers. */
export const sweepExport = (findings, { since = 0, now = Date.now(), project } = {}) => {
  const kept = (Array.isArray(findings) ? findings : [])
    .filter((f) => Number(f?.t) > since)
    .sort((a, b) => b.t - a.t)

  const header = project ? `# Architecture sweep export — ${project}\n\n` : '# Architecture sweep export\n\n'
  if (!kept.length) return `${header}No findings since the last sweep.\n`

  const groups = new Map()
  for (const f of kept) {
    const key = f.project || 'unspecified'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(f)
  }

  let md = `${header}${plural(kept.length, 'finding')} since the last sweep, across ${plural(groups.size, 'project')}.\n`
  for (const [proj, items] of groups) {
    const solid = items.filter((f) => hasLineEvidence(f.evidence))
    const vague = items.filter((f) => !hasLineEvidence(f.evidence))
    md += `\n## ${proj} (${plural(items.length, 'finding')})\n`
    for (const f of solid) md += renderFinding(f)
    if (vague.length) {
      md += `\n**no line evidence:**\n`
      for (const f of vague) md += renderFinding(f)
    }
  }
  return md
}

/** Turns one project and date into the three names a sweep's worktree needs:
 *  a slug and a worktree path that are the same string (the path a directory
 *  can actually hold), and a branch that keeps the slash a directory name
 *  cannot. `exists` is injected so this stays pure -- it probes candidate
 *  paths one suffix at a time until it finds one nothing has claimed yet, the
 *  same free-suffix search a request's own slug already does. */
export const sweepNames = ({ project, date, exists = () => false }) => {
  let n = 1
  let slug = `sweep-${date}`
  while (exists(worktreePathFor(project, slug))) {
    n += 1
    slug = `sweep-${date}-${n}`
  }
  return { slug, branch: n === 1 ? `sweep/${date}` : `sweep/${date}-${n}`, worktree: worktreePathFor(project, slug) }
}

/** The prompt a sweep session opens with. It never begins with `-`:
 *  spawnArgv puts it behind the `--` end-of-options sentinel, but
 *  canvas.mjs's own spawnRequest still refuses a prompt starting with a dash
 *  outright, so a kickoff built unattended has to pass the same rule a
 *  person's would. A clean bill of health is as real an outcome as a
 *  finding, so the prompt says that plainly rather than leaving a session to
 *  invent something worth reporting. */
export const sweepKickoff = ({ date, exportPath, reviewPath, count, since }) => {
  const sinceText = since ? `since ${new Date(since).toISOString()}` : 'from the start'
  return [
    `Run the architecture-sweep skill against this worktree.`,
    '',
    `${plural(count, 'finding')} collected ${sinceText} were exported to \`${exportPath}\`. Read every one`,
    `of them there, then read what they point at across the projects they name before deciding anything.`,
    '',
    `Write the review to \`${reviewPath}\`. Finding nothing to change is a legitimate result -- say so`,
    `plainly and commit the file rather than manufacturing a finding to justify the sweep.`,
    '',
    `Finish with exactly one \`report_finding\` call, even when the verdict is that nothing needs to change:`,
    `\`kind: 'question'\`, its \`surprise\` the verdict phrased as the question this sweep raises, and its`,
    `\`evidence\` naming \`${reviewPath}\` and the strongest \`file:line\` behind the verdict. A clean sweep`,
    `still makes that call, so a clean sweep and a sweep that died never look the same in the findings store.`,
  ].join('\n')
}

/** One architecture sweep, start to finish: a worktree and branch in
 *  `project`, the findings export written into it, and one `claude --bg`
 *  session started there on the kickoff. `run` is injected, so the harness
 *  asserts literally what a sweep hands git and claude.
 *
 *  `gate` is sweepGate's answer, computed by the caller from live relay
 *  state; this function only honours it. `now` is a function, called for the
 *  export's clock. Returns `{ status, body }`, the shape canvas.mjs's actions
 *  return, so the route forwards it untouched. */
export const runSweep = async ({ project, findings, since = 0, override = false,
  gate, run, now = Date.now, exists, date, writeFile, mkdir, claudeBin = 'claude',
  relayPort = null, relayToken = null, pluginDir = null,
  model = DEFAULT_MODEL, effort = DEFAULT_EFFORT }) => {
  // Both become argv tokens, so both are allowlisted by canvas.mjs's own lists
  // before anything is created.
  if (!MODELS.includes(model)) return { status: 400, body: { error: `unknown model: ${model}` } }
  if (!EFFORTS.includes(effort)) return { status: 400, body: { error: `unknown effort: ${effort}` } }
  if (!gate?.ok) return { status: 409, body: { error: gate?.reason || 'the sweep gate is closed' } }
  const names = sweepNames({ project, date, exists })
  // `git worktree add` in the project root, then lock it -- dispatch.mjs's
  // sequence. A failure here leaves nothing behind and is reported with git's
  // own message: a worktree that could not be created is not a sweep.
  const add = await run('git', ['worktree', 'add', names.worktree, '-b', names.branch], { cwd: project })
  if (add.code !== 0) return { status: 502, body: { error: 'git worktree add failed: ' + String(add.stderr || add.stdout).trim() } }
  await run('git', ['worktree', 'lock', names.worktree, '--reason', `sweep ${date}`], { cwd: project })
  // The export is a FILE, not argv: it is unbounded and an argv is not.
  // dispatch.mjs's brief.md is the same move. It carries every project's
  // findings; `project` only names where this review lands.
  const exportPath = '.claude/sweep/findings.md'
  const all = Array.isArray(findings) ? findings : []
  const count = all.filter((f) => Number(f?.t) > since).length
  mkdir(join(names.worktree, '.claude', 'sweep'))
  writeFile(join(names.worktree, exportPath), sweepExport(all, { since, now: now(), project }))
  const reviewPath = `${REVIEW_DIR}/${date}-architecture-sweep.md`
  const prompt = sweepKickoff({ date, exportPath, reviewPath, count, since })
  // canvas.mjs's own argv, not a copy of it: `--` then the prompt last, and
  // never --allowedTools, which is variadic and would swallow the prompt. No
  // --max-budget-usd either: the CLI binds it only to a --print session.
  // The relay handoff travels on the ARGV via --settings and ONLY there: a
  // --bg session does not inherit the environment set on it. The child's own
  // environment has every SZG_* key deleted, because the daemon a --bg launch
  // may cold-start keeps it.
  const settings = spawnEnvSettings({ relayPort, relayToken })
  const out = await run(claudeBin, spawnArgv({ name: names.slug, prompt, model, effort, settings, pluginDir }),
    { cwd: names.worktree, env: childEnv() })
  const parsed = out.code === 0 ? parseBackgrounded(out.stdout) : null
  // The worktree STAYS on a failed spawn: it is the evidence, as it is for a
  // dispatched request.
  if (!parsed) return { status: 502, body: { error: 'claude --bg failed: ' + String(out.stderr || out.stdout || `exit ${out.code}`).trim().slice(0, 400), worktree: names.worktree, branch: names.branch } }
  return { status: 200, body: { ok: true, date, ...names, shortId: parsed.shortId, reviewPath, findings: count, since, override } }
}
