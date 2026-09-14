// Tmux pane listing and the join plan for a session-space group.
//
// A pane target is `<session>:<window>.<pane>` (for example `main:@4.%12`) --
// the three ids tmux itself prints, joined the way `-t` accepts them. A
// plan's `-t` slots for a window that does not exist yet are left as the
// empty string, since the plan cannot know a window id that has not been
// created; `runGroup` fills every empty slot with the real target tmux hands
// back once it has created that window. An existing window's target is
// already known when the plan is built, so every `-t` is filled right away.
//
// `listPanes` and `groupPlan` are pure: given a tmux listing and a wanted
// set of pane ids, they decide the whole plan with no side effect, so a
// harness can drive every branch with no real tmux server. `runGroup` is the
// one impure step, taking an injected `run` of the same shape canvas.mjs's
// realRun gives.
//
// The new window keeps the shell pane tmux creates alongside it -- joining
// panes into it adds panes beside that shell rather than replacing it. That
// is deliberate: killing the shell pane would cost another tmux call for no
// benefit, and an extra shell pane sitting in a group window is harmless.

import { parseTmuxTarget } from './jump.mjs'

export const PANE_RE = /^%\d+$/
export const WINDOW_RE = /^[^:]+:@\d+$/
export const LIST_FORMAT = '#{session_name}\t#{window_id}\t#{pane_id}\t#{window_name}\t#{pane_current_command}\t#{pane_current_path}'

export const listArgv = (format = LIST_FORMAT) => ['list-panes', '-a', '-F', format]

/** Parses `tmux list-panes -a -F LIST_FORMAT` output into pane records, in
 *  order. A line that does not split into exactly six tab-separated fields --
 *  blank, or garbage with no tabs at all -- is dropped rather than thrown on:
 *  this reading is taken fresh on every request, and one bad line must never
 *  sink it. */
export const listPanes = (text) => {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const parts = line.split('\t')
    if (parts.length !== 6) continue
    const [session, window, pane, windowName, command, path] = parts
    if (!session || !window || !pane) continue
    out.push({ target: `${session}:${window}.${pane}`, session, window, pane, windowName, command, path })
  }
  return out
}

const firstLine = (s) => String(s ?? '').trim().split('\n')[0] || ''

/** `{ want, known, name }` -> `{ window, steps, skipped }`. `known` is a
 *  fresh `listPanes` reading; `want` is the caller's list of pane ids; `name`
 *  is the group's tmux window name. Never throws -- every id that cannot be
 *  honoured becomes a `skipped` entry instead of a thrown error.
 *
 *  The destination is the session of the FIRST `want` entry that is a known
 *  pane, even when that same pane ends up skipped below as already being in
 *  the destination window: the group lands where its first member lives.
 *  An existing destination is a window in that session whose name equals
 *  `name`; a member already in that window is a skip, not a join, since
 *  joining a pane into its own window is a no-op with nothing to show for
 *  it. With no existing window, the plan opens one instead, seeded from that
 *  same first member's path -- and only when there is at least one member to
 *  put in it, since an empty window is a visible side effect for no action. */
export const groupPlan = ({ want, known, name }) => {
  const list = Array.isArray(known) ? known : []
  const byId = new Map()
  for (const p of list) if (p && typeof p.pane === 'string') byId.set(p.pane, p)

  let firstKnown = null
  const seen = new Set()
  const skipped = []
  const members = []

  for (const raw of Array.isArray(want) ? want : []) {
    const id = String(raw)
    if (!PANE_RE.test(id)) { skipped.push({ ref: id, why: 'not a pane id' }); continue }
    const rec = byId.get(id)
    if (!rec) { skipped.push({ ref: id, why: 'no such pane' }); continue }
    if (!firstKnown) firstKnown = rec
    if (seen.has(id)) continue
    seen.add(id)
    members.push(rec)
  }

  if (!firstKnown) return { window: null, steps: [], skipped }

  const destSession = firstKnown.session
  const existing = list.find((p) => p.session === destSession && p.windowName === name)

  if (existing) {
    const destWindow = `${destSession}:${existing.window}`
    const joinable = []
    for (const m of members) {
      if (`${m.session}:${m.window}` === destWindow) skipped.push({ ref: m.pane, why: 'already in that window' })
      else joinable.push(m)
    }
    const steps = joinable.map((m) => ({ kind: 'join-pane', argv: ['join-pane', '-s', m.pane, '-t', destWindow] }))
    if (joinable.length) steps.push({ kind: 'select-layout', argv: ['select-layout', '-t', destWindow, 'tiled'] })
    return { window: destWindow, steps, skipped }
  }

  const steps = [{
    kind: 'new-window',
    argv: [
      'new-window', '-d', '-t', `${destSession}:`, '-n', name,
      '-c', firstKnown.path, '-P', '-F', '#{session_name}:#{window_id}.#{pane_id}',
    ],
  }]
  for (const m of members) steps.push({ kind: 'join-pane', argv: ['join-pane', '-s', m.pane, '-t', ''] })
  steps.push({ kind: 'select-layout', argv: ['select-layout', '-t', '', 'tiled'] })
  return { window: null, steps, skipped }
}

/** Runs a plan's steps in order, substituting the real window target into
 *  every empty `-t` slot once `new-window` has printed it. Every tmux call
 *  gets a 6 s timeout. A failed `join-pane` is folded into `skipped`, not a
 *  failure -- the group still forms around whichever members joined. A
 *  failed `new-window` is fatal: nothing after it has a target to join into,
 *  so no later step ever runs. Never rejects; a `run` that throws resolves
 *  `{ ok: false }` the same as a refused tmux call. */
export const runGroup = async ({ plan, run, tmuxBin = 'tmux' }) => {
  try {
    let window = plan?.window ?? null
    const joined = []
    const skipped = [...(plan?.skipped ?? [])]

    for (const step of plan?.steps ?? []) {
      const argv = step.argv.map((a) => (a === '' && window ? window : a))
      const out = await run(tmuxBin, argv, { timeout: 6000 })

      if (step.kind === 'new-window') {
        if (out.code !== 0) {
          return { ok: false, window: null, joined: [], skipped, error: firstLine(out.stderr) || 'new-window failed' }
        }
        const parsed = parseTmuxTarget(out.stdout)
        if (parsed) window = `${parsed.session}:${parsed.window}`
        continue
      }

      if (step.kind === 'join-pane') {
        const ref = step.argv[2]
        if (out.code !== 0) { skipped.push({ ref, why: firstLine(out.stderr) || 'join-pane failed' }); continue }
        joined.push(ref)
        continue
      }
    }

    return { ok: true, window, joined, skipped }
  } catch (err) {
    return { ok: false, window: null, joined: [], skipped: [], error: err?.message ?? 'tmux call failed' }
  }
}
