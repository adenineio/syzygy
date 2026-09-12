/* Syzygy — the Dispatch tab: the morning planning-and-dispatch
   surface. Attached by app.js, which owns the shared state and the SSE. */
'use strict'

const MCD = (() => {
  let C = null                  // { S, post, toast, el, compact, ago }
  let view = 'control'
  let editing = null            // request id whose brief editor is open
  let thread = null             // request id whose scoping thread is open
  let streaming = false
  const selected = new Set()    // request ids picked for "dispatch selected"

  // Which glance rows are expanded to show their efforts/backlog. Module
  // scope, not per-render state -- renderGlance rebuilds the whole list on
  // every 'dispatch' AND every 'projects' SSE push (app.js calls MCD.render()
  // from both handlers), so anything held in the DOM is gone within seconds.
  // Keyed by the project's stable `key` (its main worktree root), the same
  // pattern projects.js uses for plan expansion (there keyed by worktree path
  // + plan path) -- a user preference for one expansion mechanism, not two.
  const expandedProjects = new Set()
  const projectKey = (p) => p?.key ?? p?.name ?? p?.mainRoot ?? 'project'

  const requests = () => C?.S?.dispatch?.requests ?? []

  /**  pure mapping, rendered by MCX keyed on the project key so a
   *  badge keeps its :hover across a payload. Never assign node.className
   *  here -- MCX.show owns `.gone`. */
  const BADGE = {
    key: (b) => b.key,
    create: () => {
      const n = C.el('button', 'dbadge')
      n.type = 'button'
      return n
    },
    update: (n, b) => {
      MCX.setText(n, b.name)
      // The deck's own tooltip: app.js delegates on [data-tip] at the
      // document, so this needs no wiring there.
      MCX.setAttr(n, 'data-tip', b.path)
      MCX.toggle(n, 'live', b.live)
      n.onclick = () => {
        // The PATH, always -- `b.path` is the project's mainRoot. The label is
        // the leaf name because that is what reads well on a badge; what gets
        // stored has to be a directory a spawn can cd into.
        const box = document.getElementById('d-project')
        box.value = b.path
        box.setCustomValidity('')
        C.toast(b.path)
      }
    },
  }

  const renderBadges = () => {
    const host = document.getElementById('d-badges')
    if (!host || typeof MCB === 'undefined') return
    const badges = MCB.projectBadges({
      projects: Array.isArray(C.S.projects) ? C.S.projects : Object.values(C.S.projects ?? {}),
      sessions: C.S.sessions ?? [],
      recents: C.S.canvas?.recents ?? [],
    })
    MCX.reconcile(host, badges, BADGE)
    // The empty state is a sibling, not a reconciled child: MCX sweeps only
    // the nodes it owns, so a plain node here survives its passes.
    let empty = host.parentNode.querySelector('.dbadges-empty')
    if (!empty) {
      empty = C.el('div', 'dbadges-empty empty',
        'No projects yet — badges appear for projects a session is open in, and for recent spawns.')
      host.parentNode.insertBefore(empty, host.nextSibling)
    }
    MCX.show(empty, !badges.length)
  }

  // Rebuilt only when the published lists actually change: a <select> rebuilt
  // on every payload would discard what had just been chosen.
  let optionsKey = ''

  const renderOptions = () => {
    const model = document.getElementById('d-model')
    const effort = document.getElementById('d-effort')
    const note = document.getElementById('d-optnote')
    if (!model || !effort) return
    // A client reading a payload field its relay has never heard of fails
    // SILENTLY. A relay older than dispatchOptions would leave both
    // pickers empty with nothing in the console, which is indistinguishable
    // from the feature being broken -- so fall back AND say so.
    const opts = C.S.dispatchOptions
    const stale = !opts
    const models = opts?.models ?? ['opus', 'sonnet', 'haiku', 'fable']
    const efforts = opts?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max']
    const key = JSON.stringify([models, efforts, stale])
    if (key === optionsKey) return
    optionsKey = key

    const fill = (sel, values, chosen, extra) => {
      sel.textContent = ''
      for (const v of values) {
        const o = C.el('option', '', v)
        o.value = v
        sel.appendChild(o)
      }
      if (extra) {
        const o = C.el('option', '', extra)
        o.value = extra
        sel.appendChild(o)
      }
      sel.value = values.includes(chosen) ? chosen : values[0]
    }
    fill(model, models, 'opus', 'custom…')
    fill(effort, efforts, 'high')
    if (note) {
      MCX.setText(note, stale
        ? 'Model and effort lists are this pane’s defaults: the relay predates the --help probe. Restart the relay to read them from the binary.'
        : opts.source === 'fallback'
          ? 'Model and effort lists are defaults: the relay could not read `claude --help`.'
          : '')
      MCX.show(note, stale || opts.source === 'fallback')
    }
    model.onchange = () => {
      const custom = document.getElementById('d-model-custom')
      MCX.show(custom, model.value === 'custom…')
      if (model.value === 'custom…') custom.focus()
    }
  }

  const render = () => {
    if (!C || view !== 'dispatch') return
    renderGlance()
    renderThread()
    renderQueue()
    renderCards()
    renderBadges()
    renderOptions()
  }

  const openThread = (id) => { thread = id; streaming = false; render() }

  /** Clears a stuck streaming indicator when the SSE connection drops (relay
   *  restart, network blip) -- otherwise "…thinking" survives forever, since
   *  nothing else would ever clear it without a page reload. */
  const onDisconnect = () => { streaming = false; renderThread() }

  const renderThread = () => {
    const panel = document.getElementById('d-threadpanel')
    const host = document.getElementById('d-thread')
    const count = document.getElementById('c-thread')
    if (!panel || !host) return
    const r = requests().find((x) => x.id === thread)
    panel.hidden = !r
    if (!r) return
    count.textContent = r.title
    // Stick to the bottom only if the reader is already there -- otherwise a
    // streaming turn (a render on every raw CLI frame) yanks their scroll
    // position back down and they can never read back up mid-turn.
    const stuckToBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40
    host.replaceChildren()
    const turns = r.scoping?.turns ?? []
    if (!turns.length) {
      host.appendChild(C.el('div', 'empty', 'Say what you want. It will ask one question at a time.'))
    }
    for (const t of turns) {
      const n = C.el('div', 'dturn ' + t.role)
      n.appendChild(C.el('div', 'dwho', t.role === 'user' ? 'you' : 'claude'))
      n.appendChild(C.el('div', 'dtext', t.text))
      host.appendChild(n)
    }
    // Keyed to the REQUEST, not to a local flag. `streaming` was set on
    // `turn-start` and cleared on `turn-end`, so a completion that arrived as
    // a request update rather than as a stream frame left "…thinking" spinning
    // forever -- seen live on a request that reached state `scoped` with its
    // answer stored while the panel still said thinking. `scoping.busy` is the
    // fact, written where the rest of the state already lives.
    //
    // A relay that predates the field sends `undefined`, and the local flag is
    // then the fallback -- identical behaviour to before, rather than a panel
    // that never shows the indicator at all.
    const busy = r.scoping?.busy === undefined ? streaming : r.scoping.busy === true
    if (busy) host.appendChild(C.el('div', 'dturn assistant dstreaming', '…thinking'))
    if (stuckToBottom) host.scrollTop = host.scrollHeight

    // Taking this conversation over in a terminal FORKS it. Scoping runs as
    // one-shot `claude -p` calls that exit after each turn, so "take over"
    // resumes the saved transcript into a NEW process: from that moment,
    // terminal turns never reach the relay and pane turns never reach the
    // terminal. That was completely silent. Say it, and stop offering the two
    // actions that would now go nowhere.
    const forked = r.scoping?.continuedInTerminal
    let note = host.parentNode.querySelector('.dforked')
    if (forked && !note) {
      note = C.el('div', 'dforked')
      host.parentNode.insertBefore(note, host.nextSibling)
    }
    if (note) {
      MCX.show(note, !!forked)
      if (forked) {
        note.textContent = `continued in your terminal${forked.window ? ' (' + forked.window + ')' : ''} — turns here no longer reach it`
      }
    }
    const say = document.getElementById('d-say')
    if (say) say.disabled = !!forked
    const sendBtn = document.getElementById('d-send')
    if (sendBtn) sendBtn.disabled = !!forked

    // The escape hatch. The command is ALWAYS shown, so take-over works with no
    // tmux and lands wherever the user wants it; the button is the one-click path.
    const cmd = document.getElementById('d-resumecmd')
    const sid = r.scoping?.sessionId
    cmd.textContent = sid ? `claude --resume ${sid}` : 'no session yet'
    cmd.onclick = () => {
      if (!sid) return
      navigator.clipboard?.writeText(`claude --resume ${sid}`)
      C.toast('copied')
    }
    document.getElementById('d-takeover').disabled = !sid
    const bankBtn = document.getElementById('d-bank')
    if (bankBtn) bankBtn.disabled = !!forked
  }

  /** One frame from the relay's scope broadcast. The turns themselves are
   *  already on the request (the relay appends them), so this only drives the
   *  streaming indicator and the failure toasts. */
  const onScope = ({ requestId, event }) => {
    if (requestId !== thread) return
    if (event.type === 'turn-start') streaming = true
    if (event.type === 'turn-end') {
      streaming = false
      if (event.code !== 0) C.toast('scoping turn failed — see the request', { kind: 'warn' })
    }
    if (event.type === 'bank-failed') C.toast('brief rejected: ' + event.message, { kind: 'warn', ms: 6000 })
    if (event.type === 'banked') C.toast('brief written — it is in the queue')
    renderThread()
  }

  /** BACKLOG. A worktree carries `tasks` -- a list of task FILES, each with its
   *  own `items` array -- and no `backlog` key at all. Reading `w.backlog` is
   *  why this chip read 0 while a task file sat there full of sections.
   *
   *  Count DISTINCT item ids rather than summing per worktree: every worktree
   *  inherits the same docs/TASKS.md, so a sum reports one backlog once per
   *  worktree -- twice the real count, on a project with two. That would
   *  swap a chip that read too low for one that reads too high, which is the
   *  same inflation the ghost rule below exists to prevent. Ghosts are skipped
   *  at both levels, because a whole file and a single item can each be one. */
  const backlogCount = (worktrees) => {
    const ids = new Set()
    for (const w of worktrees ?? []) {
      for (const t of (w.tasks ?? [])) {
        if (t.absent) continue
        for (const it of (t.items ?? [])) if (!it.absent) ids.add(it.id)
      }
    }
    return ids.size
  }

  /** "12 verified · 3 reported · 21 to do" -- mirrors projects.js's planhead
   *  count exactly (same three-state ladder, same wording). NEVER COLLAPSE
   *  REPORTED INTO DONE: `[~]` is what an executor believes, `[x]` is what a
   *  reviewer confirmed, and adding them is the lie the three states exist to
   *  remove. With nothing reported the plain done/total form is unchanged. */
  const effortProgress = (e) => {
    const total = e?.total ?? 0
    const done = e?.done ?? 0
    const reported = e?.reported ?? 0
    if (!reported) return done + '/' + total
    return done + ' verified · ' + reported + ' reported · ' +
      Math.max(0, total - done - reported) + ' to do'
  }

  /** Backlog sections (TASKS.md headings, `kind === 'section'`) collapsed to
   *  one row per distinct item id. Every worktree inherits the same
   *  docs/TASKS.md, so a naive pass over every worktree's tasks[].items[]
   *  shows each entry once per worktree -- the same over-count backlogCount
   *  exists to avoid, one level up. Ghosts are skipped at both the file level
   *  (`t.absent`) and the item level (`it.absent`), matching backlogCount.
   *
   *  A backlog claim lands on whichever worktree's copy of the item the
   *  scanner happened to visit last for that slug (resolveBacklogClaims in
   *  tasks.mjs overwrites its `bySlug` map entry per worktree), so reading
   *  `claimedBy` off whichever copy this dedupe kept first could silently
   *  drop a real claim depending on scan order. Union it across every copy
   *  sharing an id instead. Pure: no I/O. */
  const dedupeBacklogSections = (worktrees) => {
    const byId = new Map()
    const order = []
    for (const w of worktrees ?? []) {
      for (const t of (w.tasks ?? [])) {
        if (t.absent) continue
        for (const it of (t.items ?? [])) {
          if (it.kind !== 'section' || it.absent) continue
          let hit = byId.get(it.id)
          if (!hit) {
            hit = { id: it.id, text: it.text, slug: it.slug ?? null, claimedBy: [] }
            byId.set(it.id, hit)
            order.push(it.id)
          }
          for (const c of (it.claimedBy ?? [])) {
            if (!hit.claimedBy.some((x) => x.id === c.id)) hit.claimedBy.push(c)
          }
        }
      }
    }
    return order.map((id) => byId.get(id))
  }

  const claimNames = (list) => list.map((c) => c.name).join(', ')

  const effortRow = (e) => {
    const row = C.el('div', 'drow dexeffort')
    const head = C.el('div', 'dexefforthead')
    head.appendChild(C.el('span', 'dtitle', e.title || e.name))
    head.appendChild(C.el('span', 'dexprogress', effortProgress(e)))
    row.appendChild(head)
    if (e.currentItem) row.appendChild(C.el('div', 'dsub dcurrent', 'on: ' + e.currentItem))
    if (e.claimedBy?.length) row.appendChild(C.el('div', 'dsub dclaimed', 'claimed by ' + claimNames(e.claimedBy)))
    return row
  }

  const backlogRow = (b) => {
    const row = C.el('div', 'drow dexbacklog')
    row.appendChild(C.el('span', 'ttext', b.text))
    if (b.claimedBy.length) row.appendChild(C.el('span', 'dchip on', 'claimed: ' + claimNames(b.claimedBy)))
    return row
  }

  /** this consumes snapshot.projects and parses no markdown of its
   *  own. Two parsers that disagree would be worse than no glance at all. */
  const renderGlance = () => {
    const host = document.getElementById('d-glance')
    if (!host) return
    host.replaceChildren()
    const projects = C.S.projects
    if (!projects) {
      host.appendChild(C.el('div', 'empty', 'Project status needs the Projects tab — the queue below works without it.'))
      return
    }
    const list = Array.isArray(projects) ? projects : Object.values(projects)
    if (!list.length) {
      host.appendChild(C.el('div', 'empty', 'No projects seen yet.'))
      return
    }
    const DAY = 24 * 60 * 60 * 1000
    for (const p of list) {
      const worktrees = p.worktrees ?? []
      // GHOST ENTRIES. A plan or backlog file that main has but this worktree
      // lacks arrives with `absent: true` and `diff: 'removed'`, so the UI can
      // show it as missing instead of letting it vanish. A ghost has no file
      // behind it and must never be counted as work: one carrying main's
      // done/total would inflate "in flight" while nothing looked wrong, which
      // is precisely the lie this glance exists to prevent.
      // ONE PLAN IS ONE EFFORT, however many worktrees carry a copy of it. The
      // old count was `worktrees.flatMap(...)`, which reads several times the
      // real number: every extra is an inherited copy nobody has touched, plus
      // any stale copy at an older path the differ cannot recognise as the
      // same plan. Drift is now its own chip rather than
      // being buried inside "in flight". See bridge/tasks-efforts.mjs.
      //
      // `efforts` is absent from an older relay's payload, so the per-worktree
      // count stays as the fallback -- wrong, but no worse than it was.
      const efforts = p.efforts ?? null
      const plans = worktrees.flatMap((w) => (w.plans ?? []).filter((pl) => !pl.absent))
      const live = efforts
        ? efforts.filter((e) => e.live).length
        : plans.filter((pl) => pl.done < pl.total && !pl.shipped).length
      const behind = efforts ? efforts.reduce((n, e) => n + e.behind, 0) : 0
      const backlog = backlogCount(worktrees)
      const fresh = efforts
        ? efforts.filter((e) => !e.live && e.total > 0 && e.checkedAt > Date.now() - DAY).length
        : plans.filter((pl) => pl.done === pl.total && pl.total > 0 &&
          (pl.items ?? []).some((it) => it.history?.checkedAt > Date.now() - DAY)).length

      const key = projectKey(p)
      const open = expandedProjects.has(key)

      const n = C.el('div', 'drow grow dclick')
      const title = C.el('span', 'dtitle')
      title.appendChild(C.el('span', 'dcaret', open ? '▾' : '▸'))
      title.appendChild(document.createTextNode(p.name ?? p.key ?? 'project'))
      n.appendChild(title)
      const stats = C.el('div', 'dsub')
      stats.appendChild(C.el('span', 'dchip' + (live ? ' on' : ''), live + ' in flight'))
      stats.appendChild(C.el('span', 'dchip', backlog + ' backlog'))
      stats.appendChild(C.el('span', 'dchip' + (fresh ? ' on' : ''), fresh + ' finished today'))
      // Drift, kept out of "in flight" but not hidden: a worktree whose copy of
      // a plan is behind the most advanced one is worth seeing.
      if (behind) stats.appendChild(C.el('span', 'dchip', behind + ' behind in a worktree'))
      // A basename collision means two plans would share one row. Never merge
      // silently -- say so, the way an over-cap count is reported.
      const clash = p.planCollisions?.length ?? 0
      if (clash) stats.appendChild(C.el('span', 'dchip warn', clash + ' plan name clash'))
      stats.appendChild(C.el('span', 'dchip', worktrees.length + ' worktree' + (worktrees.length === 1 ? '' : 's')))
      n.appendChild(stats)
      // Click to see this project's efforts and backlog -- the whole reason a
      // project glance is worth looking at rather than skimming past. Toggle
      // in the module-scope Set, not local state, so it survives the re-render
      // every 'projects'/'dispatch' push causes (see `expandedProjects` above).
      n.onclick = () => { if (open) expandedProjects.delete(key); else expandedProjects.add(key); render() }

      const wrap = C.el('div', 'dwrap')
      wrap.appendChild(n)
      if (open) {
        const panel = C.el('div', 'dexpand')
        if (efforts?.length) {
          panel.appendChild(C.el('div', 'dexsect', 'Efforts'))
          for (const e of efforts) panel.appendChild(effortRow(e))
        }
        const sections = dedupeBacklogSections(worktrees)
        if (sections.length) {
          panel.appendChild(C.el('div', 'dexsect', 'Backlog'))
          for (const s of sections) panel.appendChild(backlogRow(s))
        }
        // Exists precisely so a typo in a hand-edited claims.json is findable
        // rather than silent -- surface it here, not just in the payload.
        const unresolved = p.unresolvedClaims ?? []
        if (unresolved.length) {
          const notice = C.el('div', 'dnotice',
            unresolved.length + ' unresolved claim' + (unresolved.length === 1 ? '' : 's') + ': ' +
            unresolved.map((c) => (c.name || 'a session') + ' claims ' + c.kind + ' "' + c.id + '", which does not exist').join('; '))
          panel.appendChild(notice)
        }
        if (!efforts?.length && !sections.length && !unresolved.length) {
          panel.appendChild(C.el('div', 'empty', 'Nothing in flight and no backlog for this project.'))
        }
        wrap.appendChild(panel)
      }
      host.appendChild(wrap)
    }
  }

  const renderQueue = () => {
    const host = document.getElementById('d-queue')
    const count = document.getElementById('c-dispatch')
    if (!host) return
    const rs = requests()
    if (count) count.textContent = String(rs.length)
    host.replaceChildren()
    if (!rs.length) {
      host.appendChild(C.el('div', 'empty', 'Nothing queued. Write a brief to start.'))
      return
    }
    for (const r of rs) host.appendChild(row(r))
  }

  /** Mirrors dispatch.mjs's cardState. read `state` and whether the
   *  plan file exists — never the relay's `working` flag, which is true for a
   *  session parked at a permission prompt. */
  const cardStateOf = (r) => {
    if (r.state === 'planned') return 'plan-ready'
    if (r.state === 'implementing') return 'implementing'
    if (r.state !== 'dispatched') return r.state
    const s = r.session?.state
    if (s === 'working') return 'working'
    if (s === 'done') return r.artifacts?.planPath ? 'plan-ready' : 'no-plan'
    // BLOCKED means "it is asking you something", and only two things say so:
    // a `waitingFor` string, or Claude Code's own `status: 'waiting'`. The
    // catch-all used to answer `blocked` for everything else, which told the
    // human to take over and find out what a session was asking when it had
    // simply finished -- exactly what happened with a placeholder brief that
    // told its session not to build anything.
    if (r.session?.waitingFor || r.session?.status === 'waiting') return 'blocked'
    if (s === 'stopped') return 'stopped'
    if (s === 'idle' || s === 'done') return 'no-plan'
    return 'unknown'
  }

  const CARD_COPY = {
    working:      ['working', ''],
    blocked:      ['blocked', 'needs you — take it over to see what it is asking'],
    stopped:      ['stopped', 'the session was stopped; take it over to resume it'],
    'plan-ready': ['plan ready', 'read the plan, then green-light it'],
    'no-plan':    ['stopped — no plan written', 'it finished without writing a plan — take it over to see what it did'],
    unknown:      ['state unknown', 'the agents listing has not ruled on this one yet'],
    implementing: ['implementing', 'the go-ahead is queued; it drains on the session\'s next poll'],
  }

  const renderCards = () => {
    const host = document.getElementById('d-cards')
    const count = document.getElementById('c-cards')
    if (!host) return
    const rs = requests().filter((r) => ['dispatched', 'planned', 'implementing', 'done', 'failed'].includes(r.state))
    if (count) count.textContent = String(rs.length)
    host.replaceChildren()
    if (!rs.length) { host.appendChild(C.el('div', 'empty', 'Nothing dispatched yet.')); return }

    for (const r of rs) {
      const kind = cardStateOf(r)
      const [label, hint] = CARD_COPY[kind] ?? [kind, '']
      const card = C.el('div', 'dcard ' + kind)
      const head = C.el('div', 'dcardhead')
      head.appendChild(C.el('span', 'dstate ' + kind, label))
      head.appendChild(C.el('span', 'dtitle', r.title))
      // What this request was actually spawned with.
      const spawnedWith = [r.dispatch?.model, r.dispatch?.effort].filter(Boolean).join('/')
      if (spawnedWith) head.appendChild(C.el('span', 'dchip', spawnedWith))
      card.appendChild(head)

      if (r.session?.waitingFor) card.appendChild(C.el('div', 'dsub', 'waiting for: ' + r.session.waitingFor))
      if (hint) card.appendChild(C.el('div', 'dsub', hint))
      if (r.artifacts?.planPath) card.appendChild(C.el('div', 'dsub', 'plan: ' + r.artifacts.planPath))
      if (r.artifacts?.specPath) card.appendChild(C.el('div', 'dsub', 'spec: ' + r.artifacts.specPath))
      if (r.error?.message) card.appendChild(C.el('div', 'dsub derr', r.error.message))

      const acts = C.el('div', 'drowbtns')
      const short = r.session?.shortId
      if (short) {
        const cmd = C.el('code', 'dcmd', `claude attach ${short}`)
        cmd.onclick = () => { navigator.clipboard?.writeText(`claude attach ${short}`); C.toast('copied') }
        const btn = C.el('button', 'btn', 'take over in tmux')
        btn.onclick = async () => {
          const res = await C.post('/api/takeover', { id: r.id, kind: 'session' })
          if (res?.window) C.toast('opened tmux window ' + res.window)
          else C.toast(res?.error ?? 'take-over failed — use the command shown', { kind: 'warn', ms: 5000 })
        }
        acts.append(btn, cmd)
      }
      card.appendChild(acts)
      host.appendChild(card)
    }
  }

  /** Which parts of a brief are populated. An empty successCriteria is the
   *  strongest predictor of a dispatched session building the wrong thing, so
   *  the row says so rather than leaving it to be noticed. */
  const briefCompleteness = (b) => ({
    goal: !!(b && b.goal && b.goal.trim()),
    successCriteria: !!(b && b.successCriteria && b.successCriteria.length),
    // A partial brief supplied through /api/request/create may have
    // `research` present but missing one of its own sub-arrays -- guard
    // each so that shape can never throw and blank the whole tab.
    research: !!(b && b.research && ((b.research.context7?.length) || (b.research.urls?.length) || (b.research.files?.length))),
    nonGoals: !!(b && b.nonGoals && b.nonGoals.length),
  })

  const row = (r) => {
    const n = C.el('div', 'drow')
    n.dataset.id = r.id

    const pick = C.el('input', 'dpick')
    pick.type = 'checkbox'
    pick.checked = selected.has(r.id)
    pick.disabled = r.state !== 'queued'
    pick.onchange = () => { pick.checked ? selected.add(r.id) : selected.delete(r.id) }
    n.appendChild(pick)

    n.appendChild(C.el('span', 'dstate ' + r.state, r.state))

    const mid = C.el('div', 'dmid')
    mid.appendChild(C.el('div', 'dtitle', r.title))
    const sub = C.el('div', 'dsub')
    sub.appendChild(C.el('span', 'dslug', r.slug))
    const c = briefCompleteness(r.brief)
    for (const [k, label] of [['goal', 'goal'], ['successCriteria', 'success'], ['research', 'research'], ['nonGoals', 'non-goals']]) {
      sub.appendChild(C.el('span', 'dchip' + (c[k] ? ' on' : ''), label))
    }
    mid.appendChild(sub)
    n.appendChild(mid)

    const acts = C.el('div', 'dacts')
    const edit = C.el('button', 'btn', editing === r.id ? 'close' : 'edit')
    edit.onclick = () => { editing = editing === r.id ? null : r.id; render() }
    const up = C.el('button', 'btn', '↑')
    up.onclick = () => {
      const ids = requests().map((x) => x.id)
      const i = ids.indexOf(r.id)
      if (i > 0) { ids.splice(i - 1, 0, ids.splice(i, 1)[0]); C.post('/api/request/reorder', { ids }) }
    }
    const dup = C.el('button', 'btn', 'copy')
    dup.onclick = async () => {
      const res = await C.post('/api/request/create', {
        title: r.title + ' (copy)', project: r.project, ask: r.ask, brief: r.brief,
      })
      if (res?.error) return C.toast('copy failed: ' + res.error, { kind: 'warn' })
      C.toast('copied — it gets its own slug')
    }
    const del = C.el('button', 'btn', '✕')
    del.onclick = async () => {
      if (!confirm(`Delete "${r.title}"? The brief is not stored anywhere else.`)) return
      await C.post('/api/request/delete', { id: r.id })
      C.toast('deleted')
    }
    const scope = C.el('button', 'btn', 'scope')
    scope.onclick = () => openThread(r.id)
    acts.append(edit, scope, dup, up, del)
    n.appendChild(acts)

    const wrap = C.el('div', 'dwrap')
    wrap.appendChild(n)
    if (editing === r.id) wrap.appendChild(editor(r))
    return wrap
  }

  const lines = (v) => (v ?? []).join('\n')
  const parseLines = (s) => String(s).split('\n').map((x) => x.trim()).filter(Boolean)

  /** Textareas over a plain object of strings and string arrays. No rich text,
   *  no markdown preview -- the brief is data the dispatched session reads. */
  const editor = (r) => {
    const b = r.brief ?? {
      goal: '', nonGoals: [], constraints: [],
      research: { context7: [], urls: [], files: [] },
      successCriteria: [], openQuestions: [],
    }
    // A partial brief supplied through /api/request/create can have `b`
    // itself but no `research` key at all -- guard it the same way
    // dispatch.mjs's renderBrief() does server-side, so this can never
    // throw and blank the tab.
    const research = b.research ?? { context7: [], urls: [], files: [] }
    const box = C.el('div', 'deditor')
    const fields = [
      ['goal', 'Goal — one paragraph', b.goal, false],
      ['successCriteria', 'Success criteria — one per line', lines(b.successCriteria), true],
      ['nonGoals', 'Non-goals — one per line', lines(b.nonGoals), true],
      ['constraints', 'Constraints — one per line', lines(b.constraints), true],
      ['urls', 'Research: doc URLs — one per line', lines(research.urls), true],
      ['files', 'Research: files to read first — one per line', lines(research.files), true],
      ['openQuestions', 'Open questions — one per line', lines(b.openQuestions), true],
    ]
    const inputs = {}
    for (const [key, label, value, multi] of fields) {
      box.appendChild(C.el('label', 'dlabel', label))
      const ta = C.el('textarea', 'dinput dta')
      ta.rows = multi ? 3 : 4
      ta.value = value
      inputs[key] = ta
      box.appendChild(ta)
    }
    const save = C.el('button', 'btn go', 'save brief')
    save.onclick = async () => {
      const patch = {
        brief: {
          goal: inputs.goal.value.trim(),
          successCriteria: parseLines(inputs.successCriteria.value),
          nonGoals: parseLines(inputs.nonGoals.value),
          constraints: parseLines(inputs.constraints.value),
          openQuestions: parseLines(inputs.openQuestions.value),
          research: {
            context7: research.context7 ?? [],
            urls: parseLines(inputs.urls.value),
            files: parseLines(inputs.files.value),
          },
        },
      }
      const res = await C.post('/api/request/update', { id: r.id, patch })
      if (res?.error) return C.toast('save failed: ' + res.error, { kind: 'warn' })
      if (r.state === 'draft') {
        const moved = await C.post('/api/request/state', { id: r.id, to: 'queued' })
        if (moved?.error) {
          // The brief itself is saved -- only the queued transition failed.
          // Say exactly that, and leave the editor open so the move can be retried.
          C.toast('brief saved, but still draft: ' + moved.error, { kind: 'warn' })
          return
        }
      }
      C.toast('brief saved')
      editing = null
    }
    box.appendChild(save)
    return box
  }

  return {
    attach(ctx) {
      C = ctx
      const add = document.getElementById('d-add')
      if (add) add.onclick = async () => {
        const title = document.getElementById('d-req-title').value.trim()
        const project = document.getElementById('d-project').value.trim()
        const ask = document.getElementById('d-ask').value.trim()
        if (!title) return C.toast('a title is required', { kind: 'warn' })
        // Refused here as well as at the relay. The relay's check is the one
        // that matters -- it is what a request created any other way goes
        // through -- but a bare repo name typed into this field should be
        // caught beside the field, not two screens later as a spawn failure.
        if (project && !project.startsWith('/') && !project.startsWith('~')) {
          return C.toast('the project must be an absolute path, not a name — click a badge above', { kind: 'warn', ms: 6000 })
        }
        const modelSel = document.getElementById('d-model')
        const model = modelSel.value === 'custom…'
          ? document.getElementById('d-model-custom').value.trim()
          : modelSel.value
        const effort = document.getElementById('d-effort').value
        if (!model) return C.toast('a custom model needs a name', { kind: 'warn' })
        const res = await C.post('/api/request/create', { title, project, ask, model, effort })
        if (res?.error) return C.toast('create failed: ' + res.error, { kind: 'warn' })
        document.getElementById('d-req-title').value = ''
        document.getElementById('d-ask').value = ''
        C.toast('queued — open it to write the brief')
      }
      const send = document.getElementById('d-send')
      if (send) send.onclick = async () => {
        const box = document.getElementById('d-say')
        const text = box.value.trim()
        if (!text || !thread) return
        box.value = ''
        streaming = true; renderThread()
        const res = await C.post('/api/scope', { id: thread, text })
        if (res?.error) { streaming = false; renderThread(); C.toast('scoping failed: ' + res.error, { kind: 'warn' }) }
      }
      const bank = document.getElementById('d-bank')
      if (bank) bank.onclick = async () => {
        if (!thread) return
        C.toast('writing the brief…')
        const res = await C.post('/api/scope/bank', { id: thread })
        if (res?.error) C.toast('could not write the brief: ' + res.error, { kind: 'warn', ms: 6000 })
      }
      const over = document.getElementById('d-takeover')
      if (over) over.onclick = async () => {
        if (!thread) return
        const res = await C.post('/api/takeover', { id: thread, kind: 'scope' })
        // only a window tmux actually created is ever named.
        if (res?.window) C.toast('opened tmux window ' + res.window)
        else C.toast(res?.error ?? 'take-over failed — use the command shown', { kind: 'warn', ms: 5000 })
      }
      const disp = document.getElementById('d-dispatch')
      if (disp) disp.onclick = async () => {
        const ids = [...selected]
        if (!ids.length) return C.toast('nothing selected', { kind: 'warn' })
        if (!confirm(`Dispatch ${ids.length}? Each gets its own worktree, branch and Claude session.`)) return
        C.toast('dispatching…')
        const res = await C.post('/api/dispatch', { ids })
        selected.clear()
        const n = res?.dispatched?.length ?? 0
        const f = res?.failed?.length ?? 0
        C.toast(`${n} dispatched${f ? `, ${f} failed — see the cards` : ''}`, f ? { kind: 'warn' } : {})
      }
      const impl = document.getElementById('d-implement')
      if (impl) impl.onclick = async () => {
        const ids = requests().filter((r) => r.state === 'planned').map((r) => r.id)
        if (!ids.length) return C.toast('nothing has a plan ready', { kind: 'warn' })
        if (!confirm(`Tell ${ids.length} session(s) to implement their plans?`)) return
        const res = await C.post('/api/implement', { ids })
        // "queued", never "sent" — the session drains on its own poll.
        C.toast(`go-ahead queued for ${res?.queued?.length ?? 0}`)
      }
    },
    setView(v) { view = v; render() },
    render, onScope, openThread, onDisconnect, backlogCount,
    effortProgress, dedupeBacklogSections,
  }
})()
