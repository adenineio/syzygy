// Night-driven execution's acting half: one git worktree, one branch and one
// background Claude session per armed `plan` entry, plus the watchdog that
// stops a runaway.
//
// Beside dispatch.mjs rather than inside relay.mjs because a route ladder is
// not a place to shell out to git, and because every subprocess here is
// INJECTED so test/usage-harness.mjs can drive the whole thing without a live
// relay. Proving a fake `run` accepted a given argv is not the same as
// proving the real command line works -- that still has to be checked by
// hand against a real `git` and a real `claude`, separately from whatever
// runs green here.
//
// It NEVER deletes a worktree, merges a branch or pushes. A failed spawn
// leaves the worktree exactly where it is: it is the evidence.

import { existsSync, mkdirSync, writeFileSync, readdirSync, copyFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { worktreePathFor } from './dispatch.mjs'
import { spawnSession, killPlan, killSession, NAME_MAX } from './canvas.mjs'
import { SLUG_RE } from './requests.mjs'

/** "YYYY-MM-DD" in LOCAL time, built from a Date's own fields rather than
 *  `toISOString()`, which reports UTC and can land on the wrong side of
 *  midnight from whatever a night run's own evening actually is. */
const localDate = (ts) => {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The one normalisation nightSlug and nightBranch share: a plan's basename,
 *  minus `.md`, folded onto the alphabet a directory name, a branch and a
 *  session name all tolerate. Never refuses on odd input -- a plan titled in
 *  any script, or none, becomes SOMETHING safe -- except when nothing
 *  survives the fold at all, which is the one case with no safe name left to
 *  return.
 *
 *  Cut to 32 characters before either caller adds its own prefix and the date
 *  suffix, so `night-<base>-<date>` never exceeds the 49 characters SLUG_RE
 *  allows even at the longest possible base. */
const slugBase = (planRel) => {
  const stem = basename(String(planRel ?? '')).replace(/\.md$/i, '')
  let base = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  base = base.slice(0, 32).replace(/-+$/, '')
  if (!base) throw new Error(`plan name leaves no usable slug: ${JSON.stringify(planRel)}`)
  return base
}

/** A directory name, a branch and a session name all derive from this. Flat
 *  -- no `/` -- because worktreePathFor validates it against SLUG_RE, which a
 *  branch name does not have to satisfy. */
export const nightSlug = (planRel, date) => {
  const slug = `night-${slugBase(planRel)}-${date}`
  if (!SLUG_RE.test(slug)) throw new Error(`plan name produces an unsafe slug: ${JSON.stringify(planRel)}`)
  return slug
}

/** Slashes are legal in a branch name and make `git branch --list 'night/*'`
 *  find every night run at once -- the directory can't take the same shape,
 *  since SLUG_RE forbids `/`. */
export const nightBranch = (planRel, date) => `night/${slugBase(planRel)}-${date}`

const section = (title, body) => `\n## ${title}\n\n${body}\n`

/** The markdown written to `.claude/night/brief.md` -- the handoff a night
 *  session reads first. */
export const nightBrief = ({ planRel, planTitle, branch, budgetUsd, date }) => {
  let md = `# ${planTitle || planRel}\n\n`
  md += `A night run started ${date}, on branch \`${branch}\`.\n`
  md += section('Plan', `\`${planRel}\` is what this run executes. Read it in full before doing anything else.`)
  md += section('Budget', `This run is capped at $${budgetUsd}. A watchdog outside this session enforces the cap; staying well under it leaves margin for whoever reviews the result.`)
  md += section('Ground rules', [
    '- Work through the plan with the `superpowers:executing-plans` skill, one task at a time.',
    '- Commit as soon as each task finishes, not at the end.',
    "- Never mark a task `[x]` yourself -- that is a reviewer's mark.",
    '- Never merge this branch, never push it, and never delete this worktree.',
    '- Write `.claude/night/report.md` before you stop.',
  ].join('\n'))
  return md
}

/** The eight-point kickoff prompt. Points, not prose, because a background
 *  session reads this once and acts on it with nobody watching -- every rule
 *  an unattended run needs has to survive being skimmed. */
export const nightPrompt = ({ planRel, planTitle, branch, budgetUsd }) => [
  "Read `.claude/night/brief.md`, then the project's own agent instructions and every document they say to read first.",
  '',
  `Use the \`superpowers:executing-plans\` skill and work through \`${planRel}\`${planTitle ? ` ("${planTitle}")` : ''} task by task, on the \`${branch}\` branch this worktree already carries.`,
  '',
  'This worktree may be freshly created: run `just deps` before `just check`, if the project defines them, or the first typecheck fails on missing dependencies rather than on anything you wrote.',
  '',
  'Report each task with `just plan-reported <plan> <task>` as you finish it. Never mark a task `[x]` yourself -- that mark belongs to a reviewer, and none is watching this run.',
  '',
  `Commit as soon as each task is done, not at the end. End every commit with no attribution trailer of any kind -- nothing naming who or what ran this session.${Number(budgetUsd) > 0 ? ` Stay mindful of the $${budgetUsd} cap this run carries.` : ''}`,
  '',
  'Never merge this branch, never push it, and never delete this worktree. Leave every commit in it for a person to review.',
  '',
  'When you stop -- finished, blocked, or simply out of scope for tonight -- write `.claude/night/report.md` summarizing what happened and what is left.',
].join('\n')

/** The exact wording relay.mjs's own 503 routes use for a missing binary, so
 *  a refusal here reads as the same fact rather than a new one. */
const NO_CLAUDE_BIN = "no claude binary with --bg was found — see the relay's stderr"

/** `.claude/types/*.d.ts`, copied the way dispatch.mjs's own dispatcher
 *  copies them into a dispatched worktree: every failure swallowed, because a
 *  project with no generated types is not an error, only a session that will
 *  not have them either. */
const copyTypes = (mainRoot, wt) => {
  try {
    const src = join(mainRoot, '.claude', 'types')
    if (existsSync(src)) {
      const dst = join(wt, '.claude', 'types')
      mkdirSync(dst, { recursive: true })
      for (const n of readdirSync(src)) if (n.endsWith('.d.ts')) copyFileSync(join(src, n), join(dst, n))
    }
  } catch {}
}

/** `{ fire, watch }`. Every subprocess is injected as `run`; `relayInfo` is a
 *  thunk called at fire time, not construction time, because a relay only
 *  knows its own bound port once it is actually listening. */
export const createNightRunner = ({ run, canvas, claudeBin, relayInfo, pluginDir = null, now = Date.now }) => {
  // Stopped-with-ok ids only. A failed stop is not remembered, so the next
  // pass over the same entry tries again rather than giving up on a runaway
  // this call merely failed to reach.
  const stopped = new Set()

  const fire = async (entry, { budgetUsd, maxBudgetFlag } = {}) => {
    // No usable binary was resolved at boot: refuse before creating a
    // worktree that could never be spawned into, rather than fall back to
    // whatever `claude` happens to sit on PATH.
    if (!claudeBin) {
      process.stderr.write(`[night] refusing to fire ${entry?.id}: ${NO_CLAUDE_BIN}\n`)
      return { ok: false, error: NO_CLAUDE_BIN }
    }
    const mainRoot = entry?.payload?.mainRoot
    const planRel = entry?.target
    const planTitle = entry?.payload?.planTitle
    if (!mainRoot || !existsSync(mainRoot) || !statSync(mainRoot).isDirectory()) {
      return { ok: false, error: `project directory does not exist: ${mainRoot || '(none)'}` }
    }
    const date = localDate(now())
    let slug, branch, wt
    try {
      slug = nightSlug(planRel, date)
      branch = nightBranch(planRel, date)
      wt = worktreePathFor(mainRoot, slug)
    } catch (e) { return { ok: false, error: e.message } }

    const add = await run('git', ['worktree', 'add', wt, '-b', branch], { cwd: mainRoot })
    if (add.code !== 0) return { ok: false, error: (add.stderr || add.stdout || `git exit ${add.code}`).trim().slice(0, 400) }
    await run('git', ['worktree', 'lock', wt, '--reason', `night ${slug}`], { cwd: mainRoot })

    copyTypes(mainRoot, wt)

    mkdirSync(join(wt, '.claude', 'night'), { recursive: true })
    writeFileSync(join(wt, '.claude', 'night', 'brief.md'), nightBrief({ planRel, planTitle, branch, budgetUsd, date }))

    const { relayPort = null, relayToken = null } = relayInfo?.() ?? {}
    const res = await spawnSession({
      canvas, run, claudeBin, now,
      body: { cwd: wt, name: slug.slice(0, NAME_MAX), prompt: nightPrompt({ planRel, planTitle, branch, budgetUsd }) },
      relayPort, relayToken, pluginDir,
      budgetUsd: maxBudgetFlag ? budgetUsd : null,
    })
    if (res.status !== 200) return { ok: false, error: res.body?.error ?? `spawn failed (${res.status})` }
    return { ok: true, spawn: { shortId: res.body.shortId, name: res.body.name, branch, worktree: wt, spawnedAt: now() } }
  }

  const watch = async ({ entries, sessions, settings, now: at = now } = {}) => {
    const out = []
    const night = settings?.night ?? {}
    for (const e of entries ?? []) {
      if (e?.kind !== 'plan' || e.state !== 'fired') continue
      const spawn = e.payload?.spawn
      if (!spawn) continue
      if (stopped.has(e.id)) continue
      // No session, no stop -- whatever the elapsed time. A spawn nobody has
      // ever seen register is not evidence it is runaway, only that nobody
      // has looked yet.
      const s = (sessions ?? []).find((x) => x && (x.shortId === spawn.shortId || x.name === spawn.name))
      if (!s) continue
      const spend = Number(s?.stats?.spend)
      const elapsed = at() - Number(spawn.spawnedAt || 0)
      let reason = null
      if (Number.isFinite(spend) && Number(night.budgetUsd) > 0 && spend >= Number(night.budgetUsd)) {
        reason = `budget: estimated spend $${spend.toFixed(2)} reached the $${night.budgetUsd} cap`
      } else if (Number(night.maxHours) > 0 && elapsed > Number(night.maxHours) * 3600_000) {
        reason = `time: ran past the ${night.maxHours}h ceiling`
      }
      if (!reason) continue
      // The pane's own kill path, never a pattern kill: a dev copy and a
      // production copy of the same binary can share a command line, and a
      // pattern match cannot tell them apart.
      const plan = killPlan({ kind: 'background', shortId: spawn.shortId })
      let ok = false, error = null
      try {
        const res = await killSession({ plan, run, claudeBin })
        ok = res.status === 200
        if (!ok) error = res.body?.error ?? `stop failed (${res.status})`
      } catch (err) {
        error = err?.message ?? String(err)
      }
      if (ok) stopped.add(e.id)
      out.push({ id: e.id, reason, ok, error })
    }
    return out
  }

  return { fire, watch }
}
