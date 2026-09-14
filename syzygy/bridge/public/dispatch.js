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

  // The fan-out review panel. `splitMode`/`hi`/`lastAssign` are exactly the
  // three fields the mode needs: whether it is on, which paragraph is
  // highlighted, and the one keyboard assignment `u` can undo. `closedRuns`
  // is which ready run's card Esc has dismissed locally, without discarding
  // it -- a run stays `ready` on the relay and reappears if `closedRuns` is
  // cleared by a reload. `openDrafts` is which draft cards are expanded.
  // `fanPanel` holds the built-once child elements so a render only updates
  // them, never rebuilds the tree -- a rebuild mid-drag would drop the drag.
  let splitMode = false, hi = 0, lastAssign = null
  let shownRun = null
  const closedRuns = new Set()
  const openDrafts = new Set()
  let fanPanel = null

  // Which glance rows are expanded to show their efforts/backlog. Module
  // scope, not per-render state -- renderGlance rebuilds the whole list on
  // every 'dispatch' AND every 'projects' SSE push (app.js calls MCD.render()
  // from both handlers), so anything held in the DOM is gone within seconds.
  // Keyed by the project's stable `key` (its main worktree root), the same
  // pattern projects.js uses for plan expansion (there keyed by worktree path
  // + plan path) -- a user preference for one expansion mechanism, not two.
  const expandedProjects = new Set()
  const projectKey = (p) => p?.key ?? p?.name ?? p?.mainRoot ?? 'project'

  // Which Dispatch panes are toggled tall. Per-browser, persisted so it
  // survives a reload; every dsection is static markup (never rebuilt by
  // MCX), so applying the class once at attach and again on each click is
  // enough -- nothing here ever needs to run per render(). localStorage can
  // throw and can come back with anything, so every access is guarded.
  const EXPANDED_KEY = 'szg.dispatch.expanded'
  const readExpanded = () => {
    try {
      const v = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]')
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
    } catch { return [] }
  }
  const writeExpanded = (ids) => { try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids])) } catch {} }
  const applyExpanded = () => {
    const ids = new Set(readExpanded())
    for (const section of document.querySelectorAll('#view-dispatch .dsection[data-pane]')) {
      const on = ids.has(section.dataset.pane)
      section.classList.toggle('expanded', on)
      section.querySelector(':scope > .phead')?.setAttribute('aria-expanded', String(on))
    }
  }

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
    renderFanout()
    renderQueue()
    renderCards()
    renderBadges()
    renderOptions()
  }

  /** The fuzzy-ask box's own state -- the button, its note, and the ready
   *  count -- plus `#d-fanpanel`, the review panel for whichever run is
   *  showing. */
  const renderFanout = () => {
    const btn = document.getElementById('d-fanout')
    const note = document.getElementById('d-fanoutnote')
    const count = document.getElementById('c-fanout')
    if (!btn) return
    const runs = C.S.fanout?.runs ?? []
    const running = runs.some((r) => r.state === 'running')
    btn.disabled = running
    const newest = runs[runs.length - 1]
    if (note) {
      const text = running ? 'splitting — one model call'
        : newest?.state === 'failed' ? 'the last split failed: ' + (newest.error ?? 'unknown error')
        : ''
      MCX.setText(note, text)
      MCX.show(note, !!text)
    }
    if (count) {
      const ready = runs.filter((r) => r.state === 'ready').length
      count.textContent = ready ? String(ready) : '—'
    }

    const panel = document.getElementById('d-fanpanel')
    if (!panel) return
    const readyRuns = runs.filter((r) => r.state === 'ready')
    const newestReady = readyRuns[readyRuns.length - 1]
    const run = newestReady && !closedRuns.has(newestReady.id) ? newestReady : null
    shownRun = run
    if (!run) {
      MCX.show(panel, false)
      splitMode = false
      return
    }
    if (!fanPanel) fanPanel = buildFanPanel(panel)
    MCX.show(panel, true)
    if (hi > run.paragraphs.length - 1) hi = Math.max(0, run.paragraphs.length - 1)
    renderFanPanel(run, panel)
  }

  /** Built once inside `#d-fanpanel`; every later `renderFanout` only updates
   *  these through MCX -- never `replaceChildren`, never `node.className`. */
  const buildFanPanel = (panel) => {
    const banner = C.el('div', 'dsplitbanner',
      'SPLIT MODE — j/k paragraph · 1–8 assign to draft · 0 unassign · . repeat on next · u undo · s or Esc leave')
    panel.appendChild(banner)

    const head = C.el('div', 'dfanhead')
    const status = C.el('span', 'dfanstatus')
    const acceptAll = C.el('button', 'btn go', 'accept all')
    const splitBtn = C.el('button', 'btn', 'split mode')
    const discardBtn = C.el('button', 'btn', 'discard')
    head.append(status, acceptAll, splitBtn, discardBtn)
    panel.appendChild(head)

    const paras = C.el('div', 'dfanparas')
    panel.appendChild(paras)

    const cards = C.el('div', 'dfandrafts')
    panel.appendChild(cards)

    const tray = C.el('div', 'dfantray')
    tray.appendChild(C.el('div', 'dfantraylabel', 'unassigned — nothing you typed is dropped'))
    const trayList = C.el('div', 'dfantraylist')
    tray.appendChild(trayList)
    panel.appendChild(tray)

    return { banner, status, acceptAll, splitBtn, discardBtn, paras, cards, tray, trayList }
  }

  /** Every draft holding paragraph `index`, as its 1-based position in
   *  `run.drafts` -- the same digit split mode assigns with. */
  const holdersOf = (run, index) =>
    run.drafts.map((d, i) => (d.paragraphs.includes(index) ? i + 1 : null)).filter((n) => n != null)

  const acceptDrafts = async (run, draftIds) => {
    if (!draftIds.length) return
    const res = await C.post('/api/fanout/accept', { runId: run.id, draftIds })
    if (res?.error) return C.toast(res.error, { kind: 'warn' })
    C.toast(`filed ${draftIds.length} draft requests — they are in the queue`)
  }

  const postAssign = async (run, draftId, index, mode) => {
    const res = await C.post('/api/fanout/assign', { runId: run.id, draftId, index, mode })
    if (res?.error) C.toast(res.error, { kind: 'warn' })
  }

  /** Records what `index` undoes to before changing it, so `u` has exactly
   *  one level to undo. */
  const assignKeyboard = async (run, index, draftId) => {
    lastAssign = { index, draftId, before: holdersOf(run, index).map((n) => run.drafts[n - 1].id) }
    await postAssign(run, draftId, index, 'move')
  }

  const unassignKeyboard = async (run, index) => {
    const before = holdersOf(run, index).map((n) => run.drafts[n - 1].id)
    if (!before.length) return
    lastAssign = { index, draftId: null, before }
    for (const id of before) await postAssign(run, id, index, 'unassign')
  }

  const undoLast = async (run) => {
    if (!lastAssign) return
    const { index, draftId, before } = lastAssign
    lastAssign = null
    if (draftId && !before.includes(draftId)) await postAssign(run, draftId, index, 'unassign')
    for (const id of before) await postAssign(run, id, index, 'copy')
  }

  const paraRowSpec = (run) => ({
    key: (p) => p.i,
    create: () => {
      const row = C.el('div', 'dfanpararow')
      row.appendChild(C.el('span', 'dfanparaidx'))
      row.appendChild(C.el('span', 'dfanparatext'))
      row.appendChild(C.el('span', 'dfanparawho'))
      return row
    },
    update: (row, p) => {
      MCX.setText(row.querySelector('.dfanparaidx'), '[' + p.i + ']')
      MCX.setText(row.querySelector('.dfanparatext'), p.text)
      const holders = holdersOf(run, p.i)
      MCX.setText(row.querySelector('.dfanparawho'), holders.length ? '→ ' + holders.join(', ') : 'unassigned')
      MCX.toggle(row, 'hi', splitMode && p.i === hi)
    },
  })

  /** A chip is the drag SOURCE: `dragstart` carries the run, the draft it
   *  currently belongs to, and the paragraph index, so any card or the tray
   *  can read where a drop came from without a shared module-scope variable. */
  const chipSpec = (run, d) => ({
    key: (c) => c.i,
    create: () => {
      const chip = C.el('span', 'dchip dfanchip')
      chip.draggable = true
      return chip
    },
    update: (chip, c) => {
      MCX.setText(chip, '¶' + c.i)
      MCX.setAttr(chip, 'title', (run.paragraphs[c.i] ?? '').slice(0, 120))
      chip.ondragstart = (ev) => {
        ev.dataTransfer.setData('text/plain', JSON.stringify({ runId: run.id, fromDraftId: d.id, index: c.i }))
      }
    },
  })

  /** A card is a drop TARGET: `drop` reads back what `dragstart` wrote,
   *  refuses a foreign run, and no-ops a same-card `move`. */
  const wireDropTarget = (node, onDrop) => {
    node.ondragover = (ev) => ev.preventDefault()
    node.ondragenter = (ev) => { ev.preventDefault(); MCX.toggle(node, 'drop', true) }
    node.ondragleave = () => MCX.toggle(node, 'drop', false)
    node.ondrop = (ev) => {
      ev.preventDefault()
      MCX.toggle(node, 'drop', false)
      let data
      try { data = JSON.parse(ev.dataTransfer.getData('text/plain')) } catch { return }
      if (!data || typeof data.index !== 'number') return
      void onDrop(data, ev)
    }
  }

  const draftCardSpec = (run) => ({
    key: (d) => d.id,
    create: () => {
      const card = C.el('div', 'dfancard')
      const head = C.el('div', 'dfancardhead')
      head.appendChild(C.el('span', 'dfannum'))
      head.appendChild(C.el('span', 'dtitle dfantitle'))
      head.appendChild(C.el('span', 'dchip dfanproject'))
      head.appendChild(C.el('button', 'btn dfanaccept', 'accept'))
      card.appendChild(head)
      card.appendChild(C.el('div', 'dfanchips'))
      const body = C.el('div', 'dfanbody gone')
      body.appendChild(C.el('div', 'dfanask'))
      body.appendChild(C.el('div', 'dfangoal'))
      body.appendChild(C.el('ul', 'dfanquestions'))
      card.appendChild(body)
      return card
    },
    update: (card, d, i) => {
      MCX.setText(card.querySelector('.dfannum'), String(i + 1))
      MCX.setText(card.querySelector('.dfantitle'), d.title)

      const proj = run.projects.find((p) => p.key === d.projectKey)
      const projChip = card.querySelector('.dfanproject')
      MCX.setText(projChip, proj ? proj.name : 'no project')
      MCX.setAttr(projChip, 'title', d.reason || null)

      MCX.reconcile(card.querySelector('.dfanchips'), d.paragraphs.map((i2) => ({ i: i2 })), chipSpec(run, d))

      const accept = card.querySelector('.dfanaccept')
      MCX.setAttr(accept, 'data-tip', 'Accept\n⇧-click accepts every draft.')
      accept.onclick = (ev) => {
        ev.stopPropagation()
        void acceptDrafts(run, ev.shiftKey ? run.drafts.map((x) => x.id) : [d.id])
      }

      const body = card.querySelector('.dfanbody')
      MCX.setText(body.querySelector('.dfanask'), d.ask)
      MCX.setText(body.querySelector('.dfangoal'), d.goal)
      MCX.reconcile(body.querySelector('.dfanquestions'), (d.openQuestions ?? []).map((q, qi) => ({ qi, q })), {
        key: (x) => x.qi,
        create: () => C.el('li', 'dfanq'),
        update: (li, x) => MCX.setText(li, x.q),
      })
      MCX.show(body, openDrafts.has(d.id))

      card.onclick = (ev) => {
        if (ev.target.closest('button') || ev.target.closest('.dfanchip')) return
        if (openDrafts.has(d.id)) openDrafts.delete(d.id); else openDrafts.add(d.id)
        render()
      }

      // Plain and Alt-drag both move; Cmd-drag copies. The mode reads the
      // DROP event's own modifier key, not anything recorded at dragstart.
      wireDropTarget(card, (data, ev) => {
        if (data.runId !== run.id) return
        const mode = ev.metaKey ? 'copy' : 'move'
        if (mode === 'move' && data.fromDraftId === d.id) return
        return postAssign(run, d.id, data.index, mode)
      })
    },
  })

  const renderFanPanel = (run, panel) => {
    const { banner, status, acceptAll, splitBtn, discardBtn, paras, cards, tray, trayList } = fanPanel

    MCX.show(banner, splitMode)

    MCX.setText(status, `${run.drafts.length} drafts from ${run.paragraphs.length} paragraphs` +
      (run.error ? ` — ${run.error}` : ''))

    MCX.setAttr(acceptAll, 'data-tip', 'Accept all\n⌘Enter from the panel does the same.')
    acceptAll.onclick = () => void acceptDrafts(run, run.drafts.map((d) => d.id))

    MCX.setAttr(splitBtn, 'data-tip', 'Split mode\nOr press s with the panel focused.')
    splitBtn.onclick = () => { splitMode = !splitMode; if (splitMode) hi = 0; panel.focus(); render() }

    discardBtn.onclick = async () => {
      if (!confirm('Discard these drafts?')) return
      const res = await C.post('/api/fanout/discard', { runId: run.id })
      if (res?.error) C.toast(res.error, { kind: 'warn' })
    }

    MCX.reconcile(paras, run.paragraphs.map((text, i) => ({ i, text })), paraRowSpec(run))
    MCX.show(paras, splitMode)

    MCX.reconcile(cards, run.drafts, draftCardSpec(run))

    MCX.reconcile(trayList, (run.unassigned ?? []).map((i) => ({ i, text: run.paragraphs[i] ?? '' })), {
      key: (x) => x.i,
      create: () => C.el('div', 'dfantrayrow'),
      update: (row, x) => MCX.setText(row, '[' + x.i + '] ' + x.text),
    })
    wireDropTarget(tray, (data) => {
      if (data.runId !== run.id) return
      return postAssign(run, data.fromDraftId, data.index, 'unassign')
    })
    MCX.show(tray, (run.unassigned ?? []).length > 0)
  }

  /** One listener on `#d-fanpanel` itself (bubble phase). `app.js` switches
   *  tabs on bare digits from a bubble-phase `window` listener whenever focus
   *  is not in an input, so EVERY key this claims calls both
   *  `preventDefault()` and `stopPropagation()` -- a digit must never also
   *  switch tabs while this panel is focused. */
  const onFanKeydown = (e) => {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return
    const run = shownRun
    if (!run) return

    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation()
      void acceptDrafts(run, run.drafts.map((d) => d.id))
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      if (splitMode) splitMode = false
      else closedRuns.add(run.id)
      render()
      return
    }

    if (!splitMode) {
      if (e.key === 's') {
        e.preventDefault(); e.stopPropagation()
        splitMode = true
        hi = 0
        render()
      }
      return
    }

    const last = run.paragraphs.length - 1
    if (e.key === 'j') { e.preventDefault(); e.stopPropagation(); hi = Math.min(hi + 1, last); render(); return }
    if (e.key === 'k') { e.preventDefault(); e.stopPropagation(); hi = Math.max(hi - 1, 0); render(); return }
    if (/^[1-8]$/.test(e.key)) {
      e.preventDefault(); e.stopPropagation()
      const draft = run.drafts[Number(e.key) - 1]
      if (draft) void assignKeyboard(run, hi, draft.id)
      return
    }
    if (e.key === '0') {
      e.preventDefault(); e.stopPropagation()
      void unassignKeyboard(run, hi)
      return
    }
    if (e.key === '.') {
      e.preventDefault(); e.stopPropagation()
      if (lastAssign?.draftId) {
        hi = Math.min(hi + 1, last)
        void assignKeyboard(run, hi, lastAssign.draftId)
      }
      return
    }
    if (e.key === 'u') {
      e.preventDefault(); e.stopPropagation()
      void undoLast(run)
      return
    }
    if (e.key === 's') {
      e.preventDefault(); e.stopPropagation()
      splitMode = false
      render()
    }
  }

  const openThread = (id) => { thread = id; streaming = false; render() }

  /** Clears a stuck streaming indicator when the SSE connection drops (relay
   *  restart, network blip) -- otherwise "…thinking" survives forever, since
   *  nothing else would ever clear it without a page reload. */
  const onDisconnect = () => { streaming = false; renderThread() }

  /** Factored out so the send button and the say box's ⌘/⌃+Enter both drive
   *  one path. */
  const sendTurn = async () => {
    const box = document.getElementById('d-say')
    const text = box.value.trim()
    if (!text || !thread) return
    box.value = ''
    streaming = true; renderThread()
    const res = await C.post('/api/scope', { id: thread, text })
    if (res?.error) { streaming = false; renderThread(); C.toast('scoping failed: ' + res.error, { kind: 'warn' }) }
  }

  const renderThread = () => {
    const panel = document.getElementById('d-threadpanel')
    const host = document.getElementById('d-thread')
    const count = document.getElementById('c-thread')
    const scopesCount = document.getElementById('c-scopes')
    if (!panel || !host) return
    // Independent of which thread is open, so it stays right even while the
    // panel itself is hidden.
    if (scopesCount) {
      const liveScopes = requests().filter((x) => x.scoping?.session && !x.scoping.session.endedAt).length
      scopesCount.textContent = liveScopes ? liveScopes + ' live' : ''
    }
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
      if (t.role === 'marker') { host.appendChild(C.el('div', 'dturn marker', t.text)); continue }
      const pending = t.role === 'user' && t.via === 'pane' && t.confirmed === false
      const n = C.el('div', 'dturn ' + t.role + (pending ? ' pending' : ''))
      const who = t.role === 'user' ? (t.via === 'terminal' ? 'you · terminal' : 'you') : 'claude'
      n.appendChild(C.el('div', 'dwho', who))
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

    // `continuedInTerminal` marks an older record whose take-over forked the
    // conversation into a brand new process instead of joining the running one.
    const legacyFork = r.scoping?.continuedInTerminal
    const session = r.scoping?.session ?? null
    const live = !!session && !session.endedAt
    const ended = !!session?.endedAt
    const legacy = !session && !!r.scoping?.sessionId

    let noteText = ''
    if (legacyFork) {
      noteText = `continued in your terminal${legacyFork.window ? ' (' + legacyFork.window + ')' : ''} — turns here no longer reach it`
    } else if (ended) {
      noteText = `conversation ended (${session.endedReason})` +
        (session.stopError ? ` — stopping it failed: ${session.stopError}` : '')
    } else if (legacy) {
      noteText = 'an older conversation — its session is gone'
    } else if (live && session.attachedAt) {
      noteText = `joined in your terminal${session.window ? ' (' + session.window + ')' : ''} — the same conversation`
    }
    let note = host.parentNode.querySelector('.dforked')
    if (noteText && !note) {
      note = C.el('div', 'dforked')
      host.parentNode.insertBefore(note, host.nextSibling)
    }
    if (note) {
      MCX.show(note, !!noteText)
      if (noteText) note.textContent = noteText
    }

    const say = document.getElementById('d-say')
    if (say) say.disabled = !!legacyFork
    const sendBtn = document.getElementById('d-send')
    if (sendBtn) sendBtn.disabled = !!legacyFork || ended || legacy || busy
    const bankBtn = document.getElementById('d-bank')
    if (bankBtn) bankBtn.disabled = !!legacyFork || busy
    const endscopeBtn = document.getElementById('d-endscope')
    if (endscopeBtn) MCX.show(endscopeBtn, live)
    const restartBtn = document.getElementById('d-restart')
    if (restartBtn) MCX.show(restartBtn, ended || legacy)
    const takeoverBtn = document.getElementById('d-takeover')
    if (takeoverBtn) takeoverBtn.disabled = !(live || legacy)

    // The escape hatch. The command is ALWAYS shown, so take-over works with no
    // tmux and lands wherever the user wants it; the button is the one-click path.
    const cmd = document.getElementById('d-resumecmd')
    if (cmd) {
      cmd.textContent = live ? `claude attach ${session.shortId}`
        : legacy ? `claude --resume ${r.scoping.sessionId}`
        : 'no session yet'
      cmd.onclick = () => {
        if (!live && !legacy) return
        navigator.clipboard?.writeText(cmd.textContent)
        C.toast('copied')
      }
    }
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

  const claimNames = (list) => list.map((c) => c.name).join(', ')

  const effortRow = (e) => {
    const row = C.el('div', 'drow dexeffort')
    const head = C.el('div', 'dexefforthead')
    head.appendChild(C.el('span', 'dtitle', e.title || e.name))
    head.appendChild(C.el('span', 'dexprogress', MCPM.effortProgress(e)))
    row.appendChild(head)
    // A DECLARED `**Shipped:**` line is a weaker claim than a ticked plan and
    // has to read as one: the milestone landed, the steps were never
    // verified. Without this a declared plan sat in the list reading `0/N`,
    // indistinguishable from one nobody had started.
    if (e.shipped) {
      head.appendChild(C.el('span', 'dchip dshipped',
        'shipped ' + e.shipped.date + (e.shipped.commit ? ' · ' + e.shipped.commit : '')))
    }
    if (e.currentItem) row.appendChild(C.el('div', 'dsub dcurrent', 'on: ' + e.currentItem))
    if (e.claimedBy?.length) row.appendChild(C.el('div', 'dsub dclaimed', 'claimed by ' + claimNames(e.claimedBy)))
    return row
  }

  const backlogRow = (b) => {
    const row = C.el('div', 'drow dexbacklog')
    row.appendChild(C.el('span', 'ttext', b.text))
    if (b.claimedBy?.length) row.appendChild(C.el('span', 'dchip on', 'claimed: ' + claimNames(b.claimedBy)))
    return row
  }

  // Each expanded project's document, keyed by project key as
  // `{ status, changedAt, project }`. The digest carries a project's counts;
  // what an opened row lists -- every effort, the backlog, the unresolved
  // claims -- rides the document, fetched when the row is opened and again
  // when that project's changedAt moves. A collapsed row never asks.
  const docs = new Map()

  const fetchDoc = (key, changedAt) => {
    const prior = docs.get(key)
    const entry = { status: 'loading', changedAt, project: prior?.project ?? null }
    docs.set(key, entry)
    // The entry is recorded at the changedAt it was asked for, never the
    // document's own: a document newer than the digest this pane holds would
    // otherwise read as stale on every render until the next frame arrived.
    fetch('/api/projects/' + encodeURIComponent(key))
      .then((r) => {
        if (r.status === 404) return { status: 'missing', changedAt, project: null }
        if (!r.ok) return { status: 'error', changedAt, project: entry.project }
        return r.json().then((d) => (d?.project
          ? { status: 'ok', changedAt, project: d.project }
          : { status: 'error', changedAt, project: entry.project }))
      })
      .catch(() => ({ status: 'error', changedAt, project: entry.project }))
      .then((next) => {
        // A row closed and reopened, or evicted, while this was in flight
        // holds a newer entry; this answer is not the one it is waiting for.
        if (docs.get(key) !== entry) return
        docs.set(key, next)
        render()
      })
  }

  const DOC_NOTE = { 'loading…': 'reading this project…', 'could not be read': 'this project could not be read' }

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
    const plan = MCPM.docPlan(list, docs, { want: [...expandedProjects] })
    for (const key of plan.evict) docs.delete(key)
    for (const key of plan.fetch) fetchDoc(key, list.find((p) => projectKey(p) === key)?.changedAt ?? null)
    for (const p of list) {
      const worktrees = p.worktrees ?? []
      // Every count is the digest's, taken on the relay over the whole scan
      // (tasks-digest.mjs). A ghost -- a plan or task file main has and this
      // worktree lacks -- is never counted as work, and one plan is one
      // effort however many worktrees carry a copy, so neither inflates "in
      // flight". Drift is its own chip rather than being buried inside it.
      const live = p.counts?.inFlight ?? 0
      const behind = p.counts?.behind ?? 0
      // Every backlog item, headings and the steps beneath them alike.
      const backlog = p.counts?.backlogItems ?? 0
      const fresh = p.counts?.fresh ?? 0

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
      const clash = p.flags?.planCollisions ?? 0
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
        // A document being refetched is still drawn; only a row with nothing
        // to draw yet says so.
        const { project: doc, note } = MCPM.docNeed(p, docs.get(key))
        if (!doc) {
          panel.appendChild(C.el('div', 'empty', DOC_NOTE[note] ?? note ?? DOC_NOTE['loading…']))
        } else {
          const efforts = doc.efforts ?? []
          if (efforts.length) {
            panel.appendChild(C.el('div', 'dexsect', 'Efforts'))
            for (const e of efforts) panel.appendChild(effortRow(e))
          }
          const sections = doc.backlog ?? []
          if (sections.length) {
            panel.appendChild(C.el('div', 'dexsect', 'Backlog'))
            for (const s of sections) panel.appendChild(backlogRow(s))
          }
          // Exists precisely so a typo in a hand-edited claims.json is findable
          // rather than silent -- surface it here, not just in the payload.
          const unresolved = doc.unresolvedClaims ?? []
          if (unresolved.length) {
            const notice = C.el('div', 'dnotice',
              unresolved.length + ' unresolved claim' + (unresolved.length === 1 ? '' : 's') + ': ' +
              unresolved.map((c) => (c.name || 'a session') + ' claims ' + c.kind + ' "' + c.id + '", which does not exist').join('; '))
            panel.appendChild(notice)
          }
          if (!efforts.length && !sections.length && !unresolved.length) {
            panel.appendChild(C.el('div', 'empty', 'Nothing in flight and no backlog for this project.'))
          }
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
    if (r.fanout) sub.appendChild(C.el('span', 'dchip', `fan-out ${r.fanout.n}/${r.fanout.of}`))
    if (r.relatesTo) {
      const rel = C.el('span', 'dchip', `re: ${r.relatesTo.kind} ${r.relatesTo.ref}`)
      rel.title = r.relatesTo.ref
      sub.appendChild(rel)
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
      // From this file, never from app.js: a relay predating this merge never
      // calls it, since MCE.onField only fires for a key present on the frame.
      if (typeof MCE !== 'undefined') MCE.onField('fanout', () => render())

      // A pane's title bar toggles it tall. One delegated listener covers
      // every .dsection uniformly, including one added later -- nothing
      // here names a section. A click on a control inside the head (the
      // skills panel's selects and buttons, the queue's "dispatch selected")
      // is left alone; only the bare head toggles. Shift-click makes that
      // pane the only tall one; a plain click only ever tests its own state.
      const dview = document.getElementById('view-dispatch')
      if (dview) {
        applyExpanded()
        dview.addEventListener('click', (e) => {
          const head = e.target.closest('.dsection > .phead')
          if (!head) return
          if (e.target.closest('button, select, input, textarea, a, label')) return
          const id = head.parentElement.dataset.pane
          if (!id) return
          const ids = new Set(readExpanded())
          if (e.shiftKey) { ids.clear(); ids.add(id) }
          else if (ids.has(id)) ids.delete(id)
          else ids.add(id)
          writeExpanded(ids)
          applyExpanded()
        })
      }

      // The preset strip over the ask. d-model offers the listed models plus
      // `custom…`, so a preset's model that is not among them is written as
      // custom… with the name in d-model-custom, and read back the same way.
      MCT.mountStrip(document.getElementById('d-tplstrip'), {
        read: () => {
          const sel = document.getElementById('d-model')
          return {
            prompt: document.getElementById('d-ask').value,
            model: sel.value === 'custom…' ? document.getElementById('d-model-custom').value : sel.value,
            effort: document.getElementById('d-effort').value,
            name: document.getElementById('d-req-title').value,
          }
        },
        write: (f) => {
          document.getElementById('d-ask').value = f.prompt
          const sel = document.getElementById('d-model')
          const custom = document.getElementById('d-model-custom')
          const listed = [...sel.options].some((o) => o.value === f.model && o.value !== 'custom…')
          if (listed) { sel.value = f.model; MCX.show(custom, false) }
          else if (f.model) { sel.value = 'custom…'; custom.value = f.model; MCX.show(custom, true) }
          const effort = document.getElementById('d-effort')
          if ([...effort.options].some((o) => o.value === f.effort)) effort.value = f.effort
          else if (f.effort) C.toast('this relay offers no effort ' + f.effort + ' — kept ' + effort.value, { kind: 'warn' })
          document.getElementById('d-req-title').value = f.name
        },
        submit: () => document.getElementById('d-add').click(),
        focus: () => document.getElementById('d-ask').focus(),
        verb: 'queues',
      })
      const add = document.getElementById('d-add')
      if (add) add.onclick = async () => {
        const title = document.getElementById('d-req-title').value.trim()
        const project = document.getElementById('d-project').value.trim()
        const ask = document.getElementById('d-ask').value.trim()
        if (!title && !ask) return C.toast('a title or an ask is required', { kind: 'warn' })
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
        const strip = document.getElementById('d-tplstrip')
        const res = await C.post('/api/request/create', {
          title, project, ask, model, effort, templateId: MCT.appliedId(strip),
        })
        if (res?.error) return C.toast('create failed: ' + res.error, { kind: 'warn' })
        document.getElementById('d-req-title').value = ''
        document.getElementById('d-ask').value = ''
        MCT.detach(strip)
        C.toast('queued — open it to write the brief')
      }
      const say = document.getElementById('d-say')
      if (say) say.addEventListener('keydown', (e) => {
        // A plain Enter stays a newline. ⌘⇧Enter/⌃⇧Enter is the command bar's
        // chord, caught upstream in the capture phase, so it never reaches here.
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTurn() }
      })
      const send = document.getElementById('d-send')
      if (send) send.onclick = () => sendTurn()
      const bank = document.getElementById('d-bank')
      if (bank) bank.onclick = async (e) => {
        if (!thread) return
        C.toast('writing the brief…')
        const res = await C.post('/api/scope/bank', { id: thread })
        if (res?.error) return C.toast('could not write the brief: ' + res.error, { kind: 'warn', ms: 6000 })
        if (e.altKey) return C.toast('brief written and queued')
        editing = thread
        render()
      }
      const over = document.getElementById('d-takeover')
      if (over) over.onclick = async (e) => {
        if (!thread) return
        if (e.shiftKey) {
          const cmd = document.getElementById('d-resumecmd')
          navigator.clipboard?.writeText(cmd?.textContent ?? '')
          C.toast('copied')
          return
        }
        const res = await C.post('/api/takeover', { id: thread, kind: 'scope' })
        // only a window tmux actually created is ever named.
        if (res?.window) return C.toast('opened tmux window ' + res.window)
        C.toast(res?.error ?? 'take-over failed — use the command shown', { kind: 'warn', ms: 5000 })
        if (res?.command) navigator.clipboard?.writeText(res.command)
      }
      const endscope = document.getElementById('d-endscope')
      if (endscope) endscope.onclick = async (e) => {
        if (!thread) return
        if (!e.metaKey && !confirm('End this conversation? A terminal joined to it closes too.')) return
        const res = await C.post('/api/scope/end', { id: thread })
        if (res?.error) return C.toast(res.error, { kind: 'warn' })
        C.toast('conversation ended')
      }
      const restart = document.getElementById('d-restart')
      if (restart) restart.onclick = async () => {
        if (!thread) return
        const box = document.getElementById('d-say')
        const text = box.value.trim()
        const res = await C.post('/api/scope', { id: thread, text, restart: true })
        if (res?.error) return C.toast(res.error, { kind: 'warn' })
        box.value = ''
      }
      const fanoutBtn = document.getElementById('d-fanout')
      if (fanoutBtn) fanoutBtn.onclick = async () => {
        const box = document.getElementById('d-fuzzy')
        const ask = box.value.trim()
        if (!ask) return C.toast('type the ask first', { kind: 'warn' })
        // The relay derives the project set from its own snapshot -- this box
        // sends nothing but the ask.
        const res = await C.post('/api/fanout', { ask })
        if (res?.error) return C.toast(res.error, { kind: 'warn' })
        box.value = ''
        C.toast('splitting…')
      }
      const fanPanelEl = document.getElementById('d-fanpanel')
      if (fanPanelEl) fanPanelEl.addEventListener('keydown', onFanKeydown)
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
    render, onScope, openThread, onDisconnect,
  }
})()
