// Jump to a session's real terminal, from the pane.
//
// The endpoint is `/api/jump` and NOT `/api/attach` — that one already exists and
// is scoped to the canvas's own spawn ledger, which knows nothing about a
// session it did not start.
//
// FOUR CASES, and only three of them can be served. The fourth is a live
// interactive session outside tmux, and it is unreachable on this platform by
// decision, not by omission: the only macOS API that raises another app's
// chosen window is AXUIElement, which is Accessibility-gated with no
// exception, and AppleScript to the terminal trades that for an Automation
// prompt. **Both are ruled out** — the user's standing rule is that no macOS
// permission prompt (TCC) may ever be part of a design here. Adopting a
// running process into tmux is also impossible: it needs fds 0/1/2 and the
// controlling terminal replaced inside the target, which is `reptyr` plus
// `ptrace` on Linux and has no macOS equivalent. Do not re-litigate it; case 4
// reports the tty and the command to copy, and the card is marked so the state
// is visible before the click rather than after it.
//
// Everything that decides is pure and tested directly. The one impure function
// takes an injected runner, like `spawnSession` and `attachSession` beside it.

/** `~/.claude/sessions/<pid>.json` carries `"tmux": "<session>:@<window>.%<pane>"`.
 *  Claude Code internal and undocumented — a hint, never load-bearing, which is
 *  why every failure here is `null` and the caller falls through to another
 *  case rather than erroring. */
export const parseTmuxTarget = (s) => {
  const m = /^([^:]+):(@[0-9]+)\.(%[0-9]+)$/.exec(String(s ?? '').trim())
  if (!m) return null
  return { session: m[1], window: m[2], pane: m[3] }
}

/** The `tmux` field of `~/.claude/sessions/<pid>.json`, or ''.
 *
 *  Read SERVER-SIDE from the pid the session registered with, never taken from
 *  a request body: that is what keeps a caller from naming the pane a jump
 *  targets. `readFile` is injected so the harness can hand it a made-up
 *  registry, and every failure — no file, bad JSON, no field, the field not a
 *  string — is the empty string, because "not in tmux" is the normal answer
 *  and the file is Claude Code internal and undocumented. */
export const tmuxOfPid = ({ pid, dir, readFile }) => {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 1) return ''
  try {
    const d = JSON.parse(readFile(`${dir}/${n}.json`))
    return d && typeof d.tmux === 'string' ? d.tmux : ''
  } catch { return '' }
}

/** Which of the four cases this session is, from three facts the relay already
 *  holds. Pure, total, and ordered so that the better answer always wins: a
 *  session that is IN tmux is jumped to wherever it came from, even if it is
 *  also a background agent. */
export const jumpCase = ({ tmux, kind, pidAlive } = {}) => {
  if (parseTmuxTarget(tmux)) return { case: 'tmux', label: 'jump to terminal' }
  if (kind === 'background') return { case: 'background', label: 'attach' }
  if (!pidAlive) return { case: 'resume', label: 'resume' }
  return { case: 'outside', label: 'outside tmux' }
}

/** The most recently active client, from
 *  `tmux list-clients -F '#{client_name} #{client_activity} #{client_pid}'`.
 *
 *  Most recent rather than "the first": a machine with two terminals attached
 *  to one tmux server has two clients, and switching the one nobody is looking
 *  at moves a window on a screen nobody is looking at — which reads exactly
 *  like the jump having done nothing. */
export const pickClient = (text) => {
  let best = null
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s*$/.exec(line.trim())
    if (!m) continue
    const rec = { name: m[1], activity: Number(m[2]), pid: Number(m[3]) }
    if (!best || rec.activity > best.activity) best = rec
  }
  return best
}

/** The first `.app` bundle in a chain of ancestor command paths.
 *
 *  Resolved by walking up from the tmux client's pid rather than hardcoding a
 *  terminal: a chain typically runs `tmux → shell → login → <the terminal's
 *  own .app bundle>`, and which bundle that is differs per machine.
 *  `null` means "do not guess" — the switch and the
 *  pane select have already happened by then, so the jump has worked; only the
 *  app activation is skipped. */
export const appOfTree = (commands) => {
  for (const c of commands ?? []) {
    const m = /^(\/.*?\.app)(\/|$)/.exec(String(c ?? '').trim())
    if (m) return m[1]
  }
  return null
}

/** Walk ppids upward, collecting each process's command path. Bounded: a
 *  cycle in ps output (which should not happen, and would hang this forever)
 *  costs ten iterations instead. */
export const ancestorCommands = async ({ pid, run, max = 10 }) => {
  const out = []
  let cur = Number(pid)
  for (let i = 0; i < max && Number.isInteger(cur) && cur > 1; i++) {
    const r = await run('ps', ['-o', 'ppid=,comm=', '-p', String(cur)], { timeout: 4000 }).catch(() => null)
    if (!r || r.code !== 0) break
    const m = /^\s*(\d+)\s+(.*)$/.exec(String(r.stdout ?? '').trim())
    if (!m) break
    out.push(m[2])
    const next = Number(m[1])
    if (next === cur) break
    cur = next
  }
  return out
}

/** Bring the terminal forward, having already switched the client and selected
 *  the pane. `open -a <bundle>` and nothing else: no AppleScript, no
 *  Accessibility, no TCC prompt of any kind. */
export const activateApp = async ({ clientPid, run }) => {
  const app = appOfTree(await ancestorCommands({ pid: clientPid, run }))
  if (!app) return null
  await run('open', ['-a', app], { timeout: 4000 }).catch(() => null)
  return app
}

/** Put the user in front of `target` ({session, window, pane}). Every tmux
 *  call is argv, and the target's three parts come from tmux itself or from
 *  the pid file — never from a request body. */
export const focusTarget = async ({ target, run, tmuxBin = 'tmux' }) => {
  const list = await run(tmuxBin, ['list-clients', '-F', '#{client_name} #{client_activity} #{client_pid}'], { timeout: 4000 })
    .catch(() => null)
  const client = list && list.code === 0 ? pickClient(list.stdout) : null
  if (client) {
    await run(tmuxBin, ['switch-client', '-c', client.name, '-t', `${target.session}:${target.window}`], { timeout: 4000 })
      .catch(() => null)
  }
  const sel = await run(tmuxBin, ['select-pane', '-t', target.pane], { timeout: 4000 }).catch(() => null)
  if (!sel || sel.code !== 0) return { ok: false, error: 'that pane is no longer in tmux' }
  const app = client ? await activateApp({ clientPid: client.pid, run }) : null
  return { ok: true, client: client?.name ?? null, app }
}

/** Open a new tmux window running `argv`, and return its target. `-P -F` is
 *  what makes the window addressable afterwards; without it the second half of
 *  cases 2 and 3 would have nothing to focus. */
export const openWindow = async ({ name, cwd, argv, run, tmuxBin = 'tmux' }) => {
  const out = await run(tmuxBin, [
    'new-window', '-d', '-n', String(name).slice(0, 60), '-c', cwd,
    '-P', '-F', '#{session_name}:#{window_id}.#{pane_id}',
    ...argv,
  ], { timeout: 8000 }).catch(() => null)
  if (!out || out.code !== 0) {
    return { ok: false, error: 'tmux would not open a window — is a tmux server running?' }
  }
  const target = parseTmuxTarget(String(out.stdout ?? '').trim())
  if (!target) return { ok: false, error: 'tmux opened a window but did not name it' }
  return { ok: true, target }
}

/** The whole action. `sess` is the relay's own session record; nothing here
 *  reads the request body beyond the id the caller already looked up with. */
export const jumpToSession = async ({
  sess, run, tmuxBin = 'tmux', claudeBin = 'claude', pidAlive,
}) => {
  const alive = typeof pidAlive === 'function' ? pidAlive(sess?.pid) : !!pidAlive
  const c = jumpCase({ tmux: sess?.tmux, kind: sess?.kind, pidAlive: alive })

  if (c.case === 'tmux') {
    const target = parseTmuxTarget(sess.tmux)
    const r = await focusTarget({ target, run, tmuxBin })
    if (!r.ok) return { status: 409, body: { case: c.case, error: r.error } }
    return { status: 200, body: { ok: true, case: c.case, target: sess.tmux, app: r.app } }
  }

  if (c.case === 'outside') {
    // Not an error: the session is perfectly healthy, it simply cannot be
    // reached from here. Answer with what a human can act on.
    const tty = await run('ps', ['-o', 'tty=', '-p', String(sess?.pid ?? '')], { timeout: 4000 }).catch(() => null)
    return {
      status: 200,
      body: {
        ok: false, case: c.case,
        tty: tty && tty.code === 0 ? String(tty.stdout ?? '').trim() : '',
        command: `${claudeBin} --resume ${sess?.id ?? ''}`,
        error: 'this session is live in a terminal outside tmux; there is no promptless way to raise it',
      },
    }
  }

  if (!claudeBin) return { status: 503, body: { case: c.case, error: 'no usable claude binary was found' } }

  // Cases 2 and 3: open a window, then case 1 on it.
  //
  // `--resume` is safe HERE and only here: `claude --help` says it "starts a
  // copy … when the session is already running", so the copy hazard belongs to
  // a LIVE session — and this branch is reached only when the pid is dead.
  const argv = c.case === 'background'
    ? [claudeBin, 'attach', String(sess.shortId ?? sess.id)]
    : [claudeBin, '--resume', String(sess.id)]
  const name = ('szg-' + (sess?.name || sess?.id || 'session')).slice(0, 60)
  const cwd = sess?.cwd || sess?.root || process.cwd()
  const win = await openWindow({ name, cwd, argv, run, tmuxBin })
  if (!win.ok) return { status: 409, body: { case: c.case, error: win.error, command: argv.join(' ') } }
  const r = await focusTarget({ target: win.target, run, tmuxBin })
  // The window IS open at this point, so a focus failure is a partial success,
  // not a failure: say where it went rather than implying nothing happened.
  return {
    status: 200,
    body: {
      ok: true, case: c.case, window: name,
      target: `${win.target.session}:${win.target.window}.${win.target.pane}`,
      app: r.ok ? r.app : null,
      ...(r.ok ? {} : { note: r.error }),
    },
  }
}
