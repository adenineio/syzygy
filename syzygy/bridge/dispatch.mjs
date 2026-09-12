// The Dispatch tab's dispatcher: one git worktree, one branch and one named
// background Claude session per approved brief.
//
// The pure halves -- parsing, rendering, path containment and the card-state
// mapping -- are exported and tested directly. The impure half owns git and
// `claude` and is created with injected runners so the harness never shells out.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readdirSync, copyFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SLUG_RE } from './requests.mjs'
import { childEnv, spawnEnvSettings } from './canvas.mjs'

/** Auto mode still handles anything outside this; the allowlist just
 *  stops the classifier being asked about the things every run needs. Bare
 *  `Bash` is deliberately absent -- only the git verbs a plan session uses. */
export const ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Write', 'Edit', 'WebFetch',
  'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git status:*)',
  'Bash(git diff:*)', 'Bash(git log:*)',
  'mcp__context7__*',
]

/** `claude --bg` prints exactly one parseable line. Verified on
 *  2.1.269: it is preceded by a `Starting background service…` line and, when
 *  --session-id is passed, a warning -- so match the line, never the offset. */
export const parseBackgrounded = (stdout) => {
  for (const line of String(stdout ?? '').split('\n')) {
    const m = line.match(/^\s*backgrounded\s+·\s+(\S+)\s+·\s+(.+?)\s*$/)
    if (m) return { shortId: m[1], name: m[2] }
  }
  return null
}

/** A slug becomes a directory, a branch and a session name. Validate before it
 *  becomes any of them, and confirm the resolved path stayed where we put it. */
export const worktreePathFor = (project, slug) => {
  if (!SLUG_RE.test(String(slug ?? ''))) throw new Error(`unsafe slug: ${JSON.stringify(slug)}`)
  const base = resolve(project, '.claude', 'worktrees')
  const full = resolve(base, slug)
  if (full !== join(base, slug)) throw new Error(`unsafe slug: ${JSON.stringify(slug)}`)
  return full
}

const section = (title, items) =>
  items && items.length ? `\n## ${title}\n\n${items.map((x) => `- ${x}`).join('\n')}\n` : ''

/** The handoff, as markdown. The verbatim ask goes first and unedited: it is
 *  the only record of what was actually wanted, and everything below it is a
 *  lossy restatement. */
export const renderBrief = (r) => {
  const b = r.brief ?? {}
  const research = b.research ?? { context7: [], urls: [], files: [] }
  let md = `# ${r.title}\n\n`
  md += `> **What was actually asked for**, verbatim:\n>\n`
  md += String(r.ask ?? '(nothing recorded)').split('\n').map((l) => `> ${l}`).join('\n') + '\n\n'
  md += `## Goal\n\n${b.goal ?? '(no goal recorded — ask before building)'}\n`
  md += section('Success criteria', b.successCriteria)
  md += section('Non-goals', b.nonGoals)
  md += section('Constraints', b.constraints)
  const c7 = (research.context7 ?? []).map((x) => `\`${x.library}\`${x.topic ? ` — ${x.topic}` : ''}`)
  md += section('Research: context7', c7)
  md += section('Research: documentation', research.urls)
  md += section('Research: read these files first', research.files)
  md += section('Open questions', b.openQuestions)
  return md
}

/** Reads the session's `state` and whether the plan file exists.
 *  Never reads the relay's `working` flag, which is true for a parked session. */
export const cardState = ({ state, agent, planPath }) => {
  if (state !== 'dispatched') return state === 'planned' ? 'plan-ready' : state
  const s = agent?.state
  if (s === 'working') return 'working'
  if (s === 'done') return planPath ? 'plan-ready' : 'no-plan'
  // blocked, missing, or a value this build does not know: treat as blocked.
  return 'blocked'
}

export const initialPrompt = ({ slug, date }) => [
  'Read `.claude/dispatch/brief.md`. It is your handoff.',
  '',
  'Use the `superpowers:brainstorming` skill to turn it into a design spec.',
  'Follow its architectural path: ask the questions the brief leaves open, then',
  `write the spec to \`docs/specs/${date}-${slug}-design.md\` and commit it.`,
  "Use context7 for every library the brief's research plan names, and read the",
  'files it lists before designing anything.',
  '',
  'Then use the `superpowers:writing-plans` skill to write the implementation',
  `plan to \`docs/plans/${date}-${slug}.md\`, and commit that.`,
  '',
  '**Then stop. Do not implement any of it.** Someone will review your plan and',
  'tell you to proceed.',
].join('\n')

export const IMPLEMENT_PROMPT = [
  'Your plan is approved. Implement it now.',
  '',
  'Use the `superpowers:executing-plans` skill and work through the plan',
  'task by task. **Commit as soon as each file is finished**, not at the end —',
  'uncommitted work is work someone else has to rescue.',
].join('\n')

const realRun = (bin, argv, opts = {}) =>
  new Promise((resolve) => {
    execFile(bin, argv, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
  })

const today = () => new Date().toISOString().slice(0, 10)

/** Finding: the plan/spec gate must check the EXACT path
 *  `initialPrompt` told the session to write, never "the newest markdown in
 *  the directory". A dispatched worktree branches from the project's current
 *  HEAD, so it inherits every `docs/plans/*.md` and `docs/specs/*.md` already
 *  committed there, usually several. "Newest in the directory" is
 *  therefore never empty, `no-plan` becomes unreachable, and a session that
 *  wrote nothing at all reads as `plan ready`, pointing at a plan it never
 *  wrote. Checking one exact, known-in-advance path closes that. */
const expectedPaths = (slug, date) => ({
  expectedPlanPath: `docs/plans/${date}-${slug}.md`,
  expectedSpecPath: `docs/specs/${date}-${slug}-design.md`,
})

export const createDispatcher = ({ store, broadcast, run = realRun, now = Date.now, claudeBin = 'claude',
  relayInfo = () => ({ relayPort: null, relayToken: null }) }) => {
  const push = () => broadcast('dispatch', { requests: store.all() })

  const fail = (id, phase, message) => {
    try { store.transition(id, 'failed', { error: { at: now(), phase, message: String(message).slice(0, 400) } }) }
    catch { store.update(id, { error: { at: now(), phase, message: String(message).slice(0, 400) } }) }
  }

  const dispatchOne = async (r) => {
    // Before anything shells out. `git worktree add` with a cwd that does not
    // exist fails with an error that names git, and `spawn ... ENOENT` names
    // the binary -- neither says the project field is wrong, which is what a
    // request carrying a bare repo name actually has. Say which it is.
    if (!r.project || !existsSync(r.project) || !statSync(r.project).isDirectory()) {
      fail(r.id, 'worktree', `project directory does not exist: ${r.project || '(none)'}`)
      return null
    }
    const wt = worktreePathFor(r.project, r.slug)          // throws on an unsafe slug
    const branch = `worktree-${r.slug}`

    // Branches from the project's CURRENT HEAD, deliberately. Do not "improve"
    // this to base off origin/main: a project may have no remote at all, and
    // then there is nothing to branch from. A dispatcher that assumes a remote
    // exists does not work everywhere.
    const add = await run('git', ['worktree', 'add', wt, '-b', branch], { cwd: r.project })
    if (add.code !== 0) { fail(r.id, 'worktree', add.stderr || add.stdout); return null }
    await run('git', ['worktree', 'lock', wt, '--reason', `dispatch ${r.slug}`], { cwd: r.project })

    // `.claude/types/` is gitignored, so a fresh worktree fails
    // `just check` with dozens of phantom "Cannot find module 'claude-code'"
    // errors that blame the plugin source. Copy them across or every dispatched
    // session burns its first turns on a misleading error.
    try {
      const src = join(r.project, '.claude', 'types')
      if (existsSync(src)) {
        const dst = join(wt, '.claude', 'types')
        mkdirSync(dst, { recursive: true })
        for (const n of readdirSync(src)) if (n.endsWith('.d.ts')) copyFileSync(join(src, n), join(dst, n))
      }
    } catch {}

    mkdirSync(join(wt, '.claude', 'dispatch'), { recursive: true })
    writeFileSync(join(wt, '.claude', 'dispatch', 'brief.md'), renderBrief(r))

    // The SAME date feeds initialPrompt and the expected paths below, so the
    // file the session is told to write and the file the poller checks for
    // cannot drift apart.
    const date = today()
    const { expectedPlanPath, expectedSpecPath } = expectedPaths(r.slug, date)

    // Which relay started this session. `claude --bg` does NOT inherit the
    // environment set on it -- it hands the request to a long-lived daemon
    // whose pre-warmed spare carries the DAEMON's environment, whatever the
    // first background launch of the day happened to have. Argv is marshalled
    // to the session intact, so `--settings` is the only channel that reaches
    // it. See canvas.mjs's spawnEnvSettings.
    //
    // Without it the child registers with the DEFAULT relay, and this relay's
    // implement green light enqueues its prompt on a queue that session never
    // polls -- invisible on the default port, silent everywhere else.
    //
    // A thunk, not a value: the relay's bound port is only known after
    // server.listen, and this dispatcher is constructed at module load.
    let settings = null
    try { settings = spawnEnvSettings(relayInfo() ?? {}) } catch { settings = null }

    // `--allowedTools` is variadic: it consumes every following non-option
    // token, so spreading ALLOWED_TOOLS here would swallow the prompt as a
    // 13th "allowed tool" and every dispatched session would run with no
    // prompt at all (verified live against 2.1.269). The
    // CLI documents the flag as accepting a comma- or space-separated LIST,
    // so pass it as one argument.
    const argv = [
      '--bg',
      '-n', r.slug,
      ...(settings ? ['--settings', settings] : []),
      '--model', r.dispatch?.model ?? 'opus',
      '--effort', r.dispatch?.effort ?? 'high',
      '--allowedTools', ALLOWED_TOOLS.join(' '),
      initialPrompt({ slug: r.slug, date }),
    ]
    // `env: childEnv()` is not hygiene, it is containment. `claude --bg` does
    // not fork -- it hands the request to a long-lived daemon that is
    // COLD-STARTED by the first background launch on the machine and keeps
    // THAT launcher's environment for every session afterwards. So if a
    // dispatch is ever the launch that starts the daemon, every later
    // background session started afterwards inherits this relay's
    // SZG_RELAY_PORT/SZG_RELAY_TOKEN and registers with the wrong board, or
    // reads another relay's world.json through SZG_DATA_DIR. A live daemon has
    // been observed still holding a port from a relay started hours earlier.
    // See canvas.mjs's childEnv.
    //
    // Only the `--bg` spawn needs it: `claude agents` below is a read and
    // cannot cold-start a session host.
    const spawned = await run(claudeBin, argv, { cwd: wt, env: childEnv() })
    const parsed = spawned.code === 0 ? parseBackgrounded(spawned.stdout) : null
    if (!parsed) {
      fail(r.id, 'spawn', spawned.stderr || spawned.stdout || `exit ${spawned.code}`)
      return null                                          // the worktree stays: it is the evidence
    }

    store.transition(r.id, 'dispatched', {
      dispatch: { ...r.dispatch, branch, sessionName: r.slug },
      session: { shortId: parsed.shortId, sessionId: null, spawnedAt: now(), status: null, state: null, waitingFor: null },
      artifacts: { planPath: null, specPath: null, expectedPlanPath, expectedSpecPath },
      error: null,
    })
    return parsed
  }

  return {
    /** Sequential by design: two `git worktree add` calls racing in one
     *  repository is a real failure mode, and a partial failure should stop
     *  rather than fan out. */
    async dispatch(ids) {
      const dispatched = [], failed = []
      for (const id of ids) {
        const r = store.get(id)
        if (!r || r.state !== 'queued') { failed.push({ id, error: 'not queued' }); continue }
        try {
          const out = await dispatchOne(r)
          if (out) dispatched.push({ id, ...out }); else failed.push({ id, error: store.get(id)?.error?.message ?? 'failed' })
        } catch (e) {
          fail(id, 'dispatch', e.message)
          failed.push({ id, error: e.message })
          break                                            // stop rather than fan out
        }
      }
      push()
      return { dispatched, failed }
    },

    /** One `claude agents --json` per pass, folded onto every dispatched
     * request. this is the authority, not the relay's `working`. */
    async poll() {
      const open = store.all().filter((r) => r.state === 'dispatched' || r.state === 'implementing')
      if (!open.length) return
      const out = await run(claudeBin, ['agents', '--json', '--all'], {})
      let agents = [], callOk = out.code === 0
      if (callOk) { try { agents = JSON.parse(out.stdout) } catch { callOk = false } }
      // Two situations look identical at this call site but are not the same:
      // the `agents --json` call itself failing (non-zero exit, or output
      // that does not parse) tells us nothing about any individual session --
      // it is a transient CLI hiccup, not evidence every session vanished. Do
      // NOT touch any request's session fields in that case; leave the board
      // exactly as it was and try again next pass. Only once the call has
      // actually succeeded does a session's absence from the list mean it is
      // genuinely gone, and nulling status/state/waitingFor for that one
      // request below is then correct.
      if (!callOk) return

      let changed = false
      for (const r of open) {
        const a = agents.find((x) => x.id === r.session?.shortId ||
          (r.session?.sessionId && x.sessionId === r.session.sessionId))
        const session = {
          ...r.session,
          sessionId: a?.sessionId ?? r.session?.sessionId ?? null,
          status: a?.status ?? null, state: a?.state ?? null, waitingFor: a?.waitingFor ?? null,
        }
        const wt = worktreePathFor(r.project, r.slug)
        // Check the EXACT path `initialPrompt` told this session to write --
        // never "the newest markdown in the directory" (see `expectedPaths`).
        // A request with no expected path on record degrades to
        // `planPath: null`, never to a guess.
        const expectedPlanPath = r.artifacts?.expectedPlanPath ?? null
        const expectedSpecPath = r.artifacts?.expectedSpecPath ?? null
        const planPath = expectedPlanPath && existsSync(join(wt, expectedPlanPath)) ? expectedPlanPath : null
        const specPath = expectedSpecPath && existsSync(join(wt, expectedSpecPath)) ? expectedSpecPath : null
        const artifacts = { ...r.artifacts, planPath, specPath }

        // a pane with a brief editor open re-renders (and blanks it) on
        // every 'dispatch' broadcast, so only broadcast when this request's
        // session or artifacts actually differ from last pass -- never
        // unconditionally just because something is open. Compare the
        // serialized values; `r.session`/`r.artifacts` are read BEFORE the
        // store.update below, which mutates `r` in place.
        if (JSON.stringify(session) !== JSON.stringify(r.session) ||
            JSON.stringify(artifacts) !== JSON.stringify(r.artifacts)) {
          changed = true
        }
        store.update(r.id, { session, artifacts })

        // `planned` is entered on the plan FILE, never on a status field.
        if (r.state === 'dispatched' && planPath && a?.state === 'done') {
          try { store.transition(r.id, 'planned', { artifacts }); changed = true }
          catch {}
        }
      }
      if (changed) push()
    },
  }
}
