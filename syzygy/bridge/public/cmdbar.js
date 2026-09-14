/* The command bar, and the pane's one source of truth for orchestrator
   conversations. A CLASSIC script, like reconcile.js and projects.js: its top
   level declares nothing but the MCQ closure, which only defines functions,
   because `$`, `el` and `S` belong to app.js, which loads AFTER this file.
   Nothing here touches the DOM, MCE or MCX until attach() is called.

   `MCQ` is referenced BARE everywhere, never `window.MCQ` -- a classic
   script's top-level `const` is a lexical global shared across <script> tags
   in the same realm and is NOT a window property. Getting that backwards
   leaves a feature silently inert end to end, with nothing in the console.

   Two surfaces, one model: the rail's #orb-ask and the popup's #cmd-ask both
   render S.orchTurns and both go through ask() below, so there is exactly one
   409 queue. Two queues would 409 against each other. */
const MCQ = (() => {
  let D = null            // injected deps; see attach()
  let openState = false
  let lastFocus = null    // focus to restore on close
  const askQueue = []     // turns refused with a 409, oldest first
  let draining = false
  let recall = { idx: null, draft: '' }
  // The deck: which host is showing it, which slot is selected, whether the
  // mode is latched, the modifiers as held right now, and the transcript's
  // scroll position from before the deck took its place.
  let deck = { host: null, latched: false, sel: 0, mods: { shift: false, cmd: false }, scroll: 0, scrollThread: null }
  let tap = undefined                     // MCQA.tapStep's state
  let model = { bands: [], bySlot: {}, count: 0 }
  let pendingScope = null                 // { key, name } for the next ask
  // Whether this relay has ever sent `favourites`. The payload object is seeded
  // with an empty list before any frame lands, so the key's presence on it
  // cannot tell an older relay apart from nothing starred.
  let favKnown = false

  /** The pane keeps the last 20 CARDS; the store keeps 40 RECORDS, which is
   *  the same 20 exchanges. The two caps are deliberately in step. */
  const TURN_CAP = 20

  // ---- pure ------------------------------------------------------------------

  /** Stored role records -> pane cards. Deterministic ids, so an MCX key is
   *  stable across re-hydration and a reload does not rebuild every node. */
  const foldTurns = (stored) => {
    const list = Array.isArray(stored) ? stored : []
    const cards = []
    for (let i = 0; i < list.length; i++) {
      const rec = list[i]
      if (!rec || (rec.role !== 'user' && rec.role !== 'syzygy')) continue
      if (rec.role === 'syzygy') {
        // An orphan: turn eviction split an exchange. Kept, with no question,
        // rather than dropped -- the answer is the part worth having.
        cards.push(card('st-' + rec.at + '-' + i, '', rec))
        continue
      }
      const next = list[i + 1]
      if (next && next.role === 'syzygy') {
        cards.push(card('st-' + rec.at + '-' + i, rec.text, next))
        i++
        continue
      }
      // A question with no answer after it is what a relay that died
      // mid-turn leaves behind. Saying so is better than a card that looks
      // like it is still thinking.
      cards.push({
        id: 'st-' + rec.at + '-' + i, serverId: null, question: rec.text, answer: '',
        actions: [], rejected: [], error: 'no answer was recorded — the relay restarted before this turn finished',
        streaming: false,
      })
    }
    return cards.slice(-TURN_CAP)
  }

  const card = (id, question, answerRec) => ({
    id, serverId: null, question,
    answer: answerRec.text ?? '',
    actions: Array.isArray(answerRec.actions) ? answerRec.actions : [],
    rejected: Array.isArray(answerRec.rejected) ? answerRec.rejected : [],
    error: typeof answerRec.error === 'string' ? answerRec.error : null,
    streaming: false,
  })

  /** Recall fires only at the edges of a COLLAPSED caret, so a multi-line
   *  draft navigates normally until the caret reaches one -- the shell and
   *  Slack idiom, and the only rule under which shift+enter newlines and
   *  up-arrow recall can share one field. */
  const recallStep = ({ value, selectionStart, selectionEnd, key }) => {
    if (selectionStart !== selectionEnd) return null
    if (key === 'ArrowUp') return selectionStart === 0 ? 'older' : null
    if (key === 'ArrowDown') return selectionStart === String(value ?? '').length ? 'newer' : null
    return null
  }

  /** `asks` is this thread's user texts, oldest first. `idx` is null when not
   *  recalling. Stepping past the newest restores the stashed draft. */
  const stepRecall = ({ asks, idx, draft, value, dir }) => {
    const list = Array.isArray(asks) ? asks : []
    if (!list.length) return { idx, draft, value }
    if (dir === 'older') {
      if (idx === null) return { idx: list.length - 1, draft: value, value: list[list.length - 1] }
      const next = Math.max(0, idx - 1)
      return { idx: next, draft, value: list[next] }
    }
    if (idx === null) return { idx, draft, value }
    if (idx >= list.length - 1) return { idx: null, draft: '', value: draft }
    return { idx: idx + 1, draft, value: list[idx + 1] }
  }

  /** The deck's input, folded from the payload once per render. Every source
   *  is optional: a relay predating one sends no key, MCB may not be loaded,
   *  and either case must hide a band rather than throw. */
  const deckInput = () => {
    const S = D.S
    let badges = []
    try {
      badges = MCB.projectBadges({
        projects: S.projects ?? [], sessions: S.sessions ?? [],
        recents: S.canvas?.recents ?? [], limit: 2,
      })
    } catch (e) { badges = [] }
    return {
      sessions: S.sessions ?? [],
      favourites: S.favourites ?? [],
      templates: S.agentTemplates?.items ?? [],
      proposals: S.skillsQueue?.proposals ?? [],
      badges,
      needsOf: D.needsOf ?? (() => ''),
    }
  }

  // ---- the ask engine --------------------------------------------------------

  /** A 409 from the relay's shared slot -- the only refusal worth holding
   *  onto, since it means "later would work". Matched on the message the
   *  relay actually sends. */
  const isBusyRefusal = (err) => typeof err === 'string' && /already busy with a turn|^busy$/i.test(err)

  /** The one ask path for BOTH surfaces. No client-side busy guard: the
   *  server is the only thing that can arbitrate the shared slot, and it
   *  PREEMPTS an in-flight blurb rather than refusing, so a guard here would
   *  refuse exactly the turn that preemption exists to let through. A genuine
   *  409 comes back below and the turn is queued, never dropped. */
  const ask = async (text, { newThread = false, scope = null } = {}) => {
    const clean = String(text ?? '').trim()
    if (!clean) return
    const S = D.S
    let threadId = S.orchThreadId
    if (newThread) {
      const r = await D.post('/api/orchestrator/thread/new', {})
      // Never fall back to the current conversation when a new one was wanted.
      if (!r?.thread) { D.toast('Syzygy: could not start a new conversation', { kind: 'warn' }); return }
      threadId = r.thread.id; adoptThread(r.thread.id, [])
    }
    // The question is echoed IMMEDIATELY, before the request lands, so it is
    // never invisible while the answer is being produced. `pending` with
    // `serverId: null` marks it unclaimed; the first frame carrying a real
    // turn id claims this SAME object in onFrame, never a duplicate.
    const turn = {
      id: 'pending-' + Math.random().toString(36).slice(2), serverId: null, pending: true,
      question: clean, answer: '', streaming: true, actions: [], rejected: [], error: null,
    }
    S.orchTurns = [...S.orchTurns, turn].slice(-TURN_CAP)
    S.orchTranscriptHidden = false
    resetRecall()
    renderAll()
    S.orchestrator = { blurb: '', blurbAt: 0, ...(S.orchestrator || {}), busy: true, asking: true }
    D.renderBlurb()
    const body = { text: clean }
    if (threadId) body.threadId = threadId
    const useScope = scope ?? (pendingScope ? { project: pendingScope.key } : null)
    if (useScope) body.scope = useScope
    const r = await D.post('/api/orchestrator/ask', body)
    if (!r.ok) {
      // Refused because something else holds the slot: QUEUED, keeping its
      // place in the transcript, and re-sent by drain() the moment busy
      // clears. Any other failure (503, network) surfaces as an error on the
      // echoed question -- a silent retry loop against a dead relay is worse
      // than an honest failure.
      if (isBusyRefusal(r.error)) {
        turn.pending = false; turn.streaming = false; turn.queued = true
        askQueue.push({ turn, text: clean, threadId, scope: useScope })
        renderAll()
        return
      }
      turn.pending = false; turn.streaming = false
      turn.error = r.error || 'could not ask'
      flashError()
      renderAll()
      D.toast('Syzygy: ' + (r.error || 'could not ask'), { kind: 'warn' })
      S.orchestrator = { ...(S.orchestrator || {}), busy: false, asking: false }
      D.renderBlurb()
    }
  }

  /** Queued turns, oldest first, one at a time: the server still runs one ask
   *  at a time, so releasing them together would just 409 all but the first.
   *  Its only trigger is a frame reporting busy:false, so a queued turn is
   *  never released while an ask is still running. */
  const drain = async () => {
    const S = D.S
    if (draining || !askQueue.length) return
    if (S.orchestrator?.busy) return
    draining = true
    try {
      while (askQueue.length && !S.orchestrator?.busy) {
        const next = askQueue[0]
        const body = { text: next.text }
        if (next.threadId) body.threadId = next.threadId
        if (next.scope) body.scope = next.scope
        const r = await D.post('/api/orchestrator/ask', body)
        if (!r.ok) {
          // Still busy: leave it at the head and wait for the next busy:false.
          // Anything else is a real failure: surface it on the turn and drop
          // it from the queue rather than spinning.
          if (isBusyRefusal(r.error)) break
          askQueue.shift()
          next.turn.queued = false
          next.turn.error = r.error || 'could not ask'
          renderAll()
          continue
        }
        askQueue.shift()
        next.turn.queued = false; next.turn.pending = true
        next.turn.streaming = true; next.turn.serverId = null
        renderAll()
        S.orchestrator = { blurb: '', blurbAt: 0, ...(S.orchestrator || {}), busy: true, asking: true }
        D.renderBlurb()
      }
    } finally { draining = false }
  }

  // ---- frames ----------------------------------------------------------------

  /** The ask-turn half of the `orchestrator` SSE event. app.js's own handler
   *  keeps the busy/blurb half; no frame key is read by both, so the order
   *  the two are registered in cannot be observed. */
  const onFrame = (d) => {
    const S = D.S
    if (Array.isArray(d.threads)) {
      S.orchThreads = d.threads
      // Another pane, or this one, moved the current conversation: show that
      // thread's turns, so the transcript on screen is the one the next ask
      // resumes. follow() declines while a turn here is still live.
      if ('currentId' in d && (d.currentId ?? null) !== S.orchThreadId) void follow(d.currentId ?? null)
      // renderPopup rather than renderThreads: the pin button's pressed state
      // is drawn there, and it calls renderThreads itself.
      renderPopup()
    }
    if (!d.id) return
    // A bare session adopts the first frame's thread immediately, so the
    // later {threads, currentId} frame confirms rather than re-folds it.
    if (d.threadId && S.orchThreadId == null) S.orchThreadId = d.threadId
    // A frame for a thread that is not on screen updates nothing visible --
    // but it must not be folded into the wrong conversation either.
    if (d.threadId && S.orchThreadId && d.threadId !== S.orchThreadId) return
    // An automatic apply's outcome, for a turn this pane already holds. It never
    // creates a turn: a finished apply for a turn nobody is showing is not news.
    if (Array.isArray(d.applied)) {
      const held = S.orchTurns.find((x) => x.serverId === d.id)
      if (!held) return
      held.appliedIdx = held.appliedIdx || new Set()
      held.applyErrors = held.applyErrors || new Map()
      for (const a of d.applied) {
        if (!a || !Number.isInteger(a.index)) continue
        if (a.ok) held.appliedIdx.add(a.index)
        else held.applyErrors.set(a.index, String(a.error || 'the apply failed'))
      }
      renderAll()
      return
    }
    // Claim the question ask() already echoed rather than creating a second
    // card: the shared slot allows one ask in flight, so there is at most one
    // pending, unclaimed turn, and binding it keeps its MCX key stable.
    let t = S.orchTurns.find((x) => x.serverId === d.id)
    if (!t) {
      const pending = S.orchTurns.find((x) => x.pending && x.serverId == null)
      if (pending) { pending.serverId = d.id; pending.pending = false; t = pending }
    }
    if (!t) {
      // A page load that missed the optimistic echo -- a reload mid-turn.
      // Still renders something rather than dropping frames for a turn
      // nothing here is tracking.
      t = { id: 'srv-' + d.id, serverId: d.id, question: '', answer: '', streaming: true, actions: [], rejected: [], error: null }
      S.orchTurns = [...S.orchTurns, t].slice(-TURN_CAP)
    }
    // A liaison turn names its peer and the ask it answers, so an apply from
    // it can say which ask it serves. Carried whenever a frame has them.
    if (typeof d.peer === 'string' && d.peer) t.peer = d.peer
    if (typeof d.askId === 'string' && d.askId) t.askId = d.askId
    // A delta resets the stall watchdog, and REVIVES a turn it already
    // parked: a child can go quiet and then resume.
    if (typeof d.delta === 'string') { t.answer += d.delta; t.streaming = true; D.noteAskDelta() }
    // The server's own cleaned text (an action fence already stripped)
    // replaces whatever streamed in, on `done` and on `error` alike.
    if (typeof d.text === 'string') t.answer = d.text
    if (d.done) { t.streaming = false; t.actions = d.actions || []; t.rejected = d.rejected || [] }
    if (d.error) { t.streaming = false; t.error = d.error; flashError() }
    if (d.done || d.error) D.endAskStall()
    renderAll()
  }

  /** After the snapshot: adopt the payload's thread list and fetch the
   *  current conversation's turns. One extra request per page load, which is
   *  what keeps the snapshot frame from growing with conversation length. */
  const hydrate = async () => {
    const S = D.S
    const o = S.orchestrator
    if (!o || !Array.isArray(o.threads)) { renderThreads(); return }
    S.orchThreads = o.threads
    renderPopup()
    const id = o.currentId ?? null
    // The relay re-sends the snapshot on every reconnect. Re-folding from disk
    // over turns this pane already holds would drop queued turns and every
    // applied-action mark, which lives only on the in-memory card, so an
    // already-applied spawn button would arm again.
    if (id === S.orchThreadId && S.orchTurns.length) return
    await follow(id)
  }

  /** True while this pane holds a turn the store has not seen settle. */
  const hasLiveTurn = () => D.S.orchTurns.some((t) => t.streaming || t.pending || t.queued)

  /** Points both transcripts at thread `id` and folds its stored turns in, or
   *  empties them when `id` is null. Declines while a turn here is live unless
   *  `force` is set for an explicit switch: frames still arriving for that
   *  turn are filtered by thread id, so moving the pane off its thread would
   *  strand them. The pane catches up on the next switch or reload. `seq`
   *  lets the newest of two overlapping calls win. */
  let followSeq = 0
  const follow = async (id, { force = false } = {}) => {
    if (!force && hasLiveTurn()) return
    const seq = ++followSeq
    if (!id) { adoptThread(null, []); return }
    const r = await fetch('/api/orchestrator/thread/' + encodeURIComponent(id))
      .then((x) => x.json()).catch(() => null)
    if (seq !== followSeq || (!force && hasLiveTurn())) return
    if (!r?.thread && !force) return
    adoptThread(id, foldTurns(r?.thread?.turns))
  }

  const adoptThread = (id, turns) => {
    D.S.orchThreadId = id
    D.S.orchTurns = turns
    resetRecall()
    renderAll()
  }

  const resetRecall = () => { recall = { idx: null, draft: '' } }

  // ---- rendering -------------------------------------------------------------

  const renderAll = () => { D.renderOrchTranscript(); renderPopup() }

  /** How long a delete stays armed. There is no armed confirmation strip in
   *  the browser pane, so the second click is the confirmation -- the same
   *  3 s arm the hotkey editor uses, and for the same reason: a conversation
   *  is the one thing here that cannot be recovered. */
  const ARM_MS = 3000
  let armedDelete = null
  let armTimer = null
  let renameOpen = false

  const arm = (id) => {
    clearTimeout(armTimer)
    armedDelete = id
    armTimer = setTimeout(() => { armedDelete = null; renderThreads() }, ARM_MS)
    renderThreads()
  }

  /** Offsets every chip that moved back to where it was and lets the
   *  stylesheet settle it to zero. Runs on every render: a row nothing moved in
   *  measures a zero delta for every chip and animates nothing. Anything the
   *  reconciler did not create -- the `+ new` button -- has no key and is
   *  skipped. */
  const flipRow = (row, before, nodes) => {
    const box = row.getBoundingClientRect()
    for (const [k, n] of nodes) {
      const dx = MCQA.flipDx(before.has(k) ? before.get(k) : null,
        n.getBoundingClientRect().left, box.left, box.right)
      if (Math.abs(dx) < 1) continue
      MCX.toggle(n, 'cmdflip', false)
      n.style.translate = dx + 'px 0'
      // A layout read between the two values, or there is nothing to
      // transition from.
      void n.offsetWidth
      MCX.toggle(n, 'cmdflip', true)
      n.style.translate = '0px 0'
    }
  }

  /** MCX-reconciled, keyed by thread id -- so never assign node.className
   *  here: it would wipe `.gone` out from under MCX.show. The order comes
   *  from the payload (pinned first, then updatedAt desc) and is never
   *  re-sorted in the browser, so the switcher and the store cannot disagree.
   *  Does nothing while a rename is open, so the chip under the rename field
   *  stays where the field was placed. */
  const renderThreads = () => {
    if (!openState || renameOpen) return
    const S = D.S
    const row = D.$('cmd-threads')
    const known = Array.isArray(S.orchestrator?.threads)
    MCX.show(row, known && S.orchThreads.length > 0)
    // An older relay sends no `threads` key at all. "This relay predates the
    // feature" and "you have no conversations" would otherwise look identical.
    const note = D.$('cmd-note') || (() => {
      const n = D.el('div', 'cmdnote', 'This relay predates saved conversations — restart it to keep them.')
      n.id = 'cmd-note'
      row.parentNode.insertBefore(n, row.nextSibling)
      return n
    })()
    MCX.show(note, !!S.orchestrator && !known)
    if (!known) return
    // Measured before the reconcile: a chip that moves takes the difference as
    // a starting offset and settles back to zero, so the row makes room rather
    // than jumping. A row nothing moved in measures zero for every chip.
    const moving = !still()
    const before = new Map()
    if (moving) {
      for (const n of Array.prototype.slice.call(row.children)) {
        const k = MCX.keyOf(n)
        if (k !== undefined) before.set(k, n.getBoundingClientRect().left)
      }
    }
    const out = MCX.reconcile(row, S.orchThreads, {
      key: (t) => t.id,
      // A label and a separate × control. A browser fires two clicks before a
      // dblclick, so a chip that armed on one click and deleted on the next
      // would delete the conversation on every double-click to rename it.
      create: () => {
        const chip = D.el('button', 'cmdchip')
        chip.type = 'button'
        chip.appendChild(D.el('span', 'cmdchip-label'))
        chip.appendChild(D.el('span', 'cmdchip-x', '×'))
        return chip
      },
      update: (node, t) => {
        const current = t.id === S.orchThreadId
        const armed = armedDelete === t.id
        const x = node.lastChild
        MCX.setText(node.firstChild, (t.pinned ? '★ ' : '') + (t.title || 'untitled') + (t.turnCount ? ' · ' + t.turnCount : ''))
        // Only the current chip shows its ×; one click arms it, a second
        // within ARM_MS deletes.
        MCX.show(x, current)
        MCX.setText(x, armed ? '×?' : '×')
        MCX.toggle(node, 'on', current)
        MCX.toggle(node, 'arm', armed)
        node.title = t.preview || ''
        node.onclick = () => { if (!current) void selectThread(t.id) }
        x.onclick = (ev) => { ev.stopPropagation(); if (armed) void deleteThread(t.id); else arm(t.id) }
        node.ondblclick = (ev) => { if (current && ev.target !== x) startRename(node, t) }
      },
    })
    if (moving) flipRow(row, before, out.nodes)
    // Built once and hidden with MCX.show, never added and removed.
    const plus = D.$('cmd-new') || (() => {
      const b = D.el('button', 'cmdchip', '+ new')
      b.id = 'cmd-new'; b.type = 'button'
      b.addEventListener('click', () => void newThread())
      row.appendChild(b)
      return b
    })()
    row.appendChild(plus)
  }

  /** Rename uses one static field, #cmd-rename, laid over the chip rather than
   *  swapped into the row. The row is reconciled: a field inside it would get
   *  a mic button from voice.js, and a re-render landing mid-rename would
   *  leave a second node under the chip's key. The field's own keydown stops
   *  propagation, so Enter commits rather than reaching the composer -- what
   *  #d-titleedit does -- and onKey returns early while it is open, so Escape
   *  reaches it rather than closing the popup. */
  const startRename = (chip, t) => {
    const inp = D.$('cmd-rename')
    // position: fixed, placed from the chip's own box: the field sits outside
    // the row, so the row's layout cannot place it.
    const box = chip.getBoundingClientRect()
    inp.style.left = box.left + 'px'
    inp.style.top = box.top + 'px'
    inp.style.width = Math.max(box.width, 160) + 'px'
    inp.style.height = box.height + 'px'
    inp.value = t.title || ''
    renameOpen = true
    inp.hidden = false
    inp.focus(); inp.select()
    // Settles exactly once. Hiding a focused field fires `blur`, which would
    // otherwise turn Escape into a commit and Enter into a second POST.
    let settled = false
    const done = async (commit) => {
      if (settled) return
      settled = true
      inp.removeEventListener('keydown', onRenameKey)
      inp.removeEventListener('blur', onBlur)
      const hadFocus = document.activeElement === inp
      renameOpen = false
      inp.hidden = true
      // Back to the composer after Enter or Escape; a blur caused by a click
      // elsewhere leaves focus where the click put it.
      if (openState && hadFocus) D.$('cmd-ask').focus()
      if (commit) {
        const r = await D.post('/api/orchestrator/thread/rename', { id: t.id, title: inp.value })
        if (!r?.ok) D.toast(r?.error || 'could not rename', { kind: 'warn' })
      }
      renderThreads()
    }
    const onRenameKey = (ev) => {
      ev.stopPropagation()
      if (ev.key === 'Enter') { ev.preventDefault(); void done(true) }
      else if (ev.key === 'Escape') { ev.preventDefault(); void done(false) }
    }
    const onBlur = () => { void done(true) }
    inp.addEventListener('keydown', onRenameKey)
    inp.addEventListener('blur', onBlur)
  }

  /** An explicit switch, so it is shown even over a turn still streaming in
   *  the conversation being left. */
  const selectThread = async (id) => {
    const r = await D.post('/api/orchestrator/thread/select', { id })
    if (!r?.ok) { D.toast('could not switch conversation', { kind: 'warn' }); return }
    await follow(id, { force: true })
  }

  const newThread = async () => {
    const r = await D.post('/api/orchestrator/thread/new', {})
    if (!r?.thread) { D.toast('could not start a conversation', { kind: 'warn' }); return }
    adoptThread(r.thread.id, [])
  }

  const togglePin = async () => {
    const S = D.S
    if (!S.orchThreadId) return
    const t = S.orchThreads.find((x) => x.id === S.orchThreadId)
    const r = await D.post('/api/orchestrator/thread/pin', { id: S.orchThreadId, pinned: !t?.pinned })
    if (!r?.ok) { D.toast('could not pin', { kind: 'warn' }); return }
    D.toast(t?.pinned ? 'unpinned' : 'pinned — this conversation is never evicted')
  }

  const deleteThread = async (id) => {
    clearTimeout(armTimer); armedDelete = null
    const r = await D.post('/api/orchestrator/thread/delete', { id })
    if (!r?.ok) { D.toast(r?.error || 'could not delete', { kind: 'warn' }); renderThreads(); return }
    // Nothing to clear here: the relay re-points currentId and broadcasts it,
    // and onFrame follows that frame to the surviving thread's turns, or
    // empties the transcript when none is left.
  }

  /** An .orcha node -> the source string it was last split from, so a 30 Hz
   *  delta stream does not re-split twenty settled turns on every frame. The
   *  streaming flag rides the key because the trailing ellipsis appears and
   *  goes with it, and a `done` frame can carry the same text. */
  const PARA = new WeakMap()

  /** The answer, as paragraph nodes keyed by index. Reconciled rather than
   *  rebuilt, so text already on screen is never re-rendered and never moves:
   *  the last paragraph is the one still growing and updates in place, and a
   *  new index appears only when a blank line lands. The fade class is set in
   *  `update` on `isNew` rather than in `enter`, which is handed no index. */
  const renderParas = (box, text, streaming) => {
    if (!box) return
    const stamp = (streaming ? '1' : '0') + text
    if (PARA.get(box) === stamp) return
    PARA.set(box, stamp)
    // No placeholder paragraph any more: a turn with nothing to show yet
    // renders nothing here -- the question line above it shimmers instead
    // (MCQA.isThinking, wired in renderTurns).
    const list = MCQA.paragraphs(text)
    const quiet = still()
    MCX.reconcile(box, list, {
      key: (p, i) => 'p' + i,
      create: () => D.el('div', 'orchp'),
      update: (n, p, i, isNew) => {
        const src = p + (streaming && i === list.length - 1 ? ' …' : '')
        n.innerHTML = MCMD.render(src)
        if (isNew && !quiet) MCX.toggle(n, i === 0 ? 'orchpfirst' : 'orchpin', true)
      },
    })
  }

  /** The one transcript renderer, for BOTH boxes. Never assigns className: MCX
   *  keys this list by turn id and a wholesale class replacement would wipe
   *  `.gone` out from under MCX.show.
   *
   *  The answer and the failure reason are two SEPARATE elements, `.orcha`
   *  and `.orcherr`, so a turn that streamed a real partial answer before
   *  failing keeps that answer with the reason underneath it. `.orcha` hides
   *  when there is neither text nor an in-progress "…", so a reply that is
   *  ONLY an action block never renders an empty bubble. */
  const renderTurns = (box) => {
    if (!box) return
    MCX.reconcile(box, D.S.orchTurns, {
      key: (t) => t.id,
      create: () => {
        const c = D.el('div', 'orchturn')
        c.appendChild(D.el('div', 'orchq'))
        c.appendChild(D.el('div', 'orcha'))
        c.appendChild(D.el('div', 'orcherr'))
        c.appendChild(D.el('div', 'orchacts'))
        return c
      },
      update: (node, t) => {
        const q = node.querySelector('.orchq')
        MCX.setText(q, t.question)
        const shown = t.streaming ? visibleWhileStreaming(t.answer) : t.answer
        // Shimmer the sent question while nothing has come back yet, instead
        // of the reply box showing an empty three-dot placeholder. Stops the
        // instant real content exists -- recomputed every render, no timer.
        const thinking = MCQA.isThinking(t.streaming, shown)
        MCX.toggle(q, 'cmdthinking', thinking && !still())
        MCX.toggle(q, 'cmdthinkdim', thinking && still())
        const a = node.querySelector('.orcha')
        MCX.show(a, shown.trim().length > 0)
        renderParas(a, shown, !!t.streaming)
        // A queued turn is WAITING, not failed: a status line rather than a
        // ⚠, and no `errored` class, because nothing has been lost -- it goes
        // out by itself the moment the slot frees.
        const e = node.querySelector('.orcherr')
        MCX.show(e, !!t.error || !!t.queued)
        if (t.queued) MCX.setText(e, '⋯ queued — will send when Syzygy is free')
        else if (t.error) MCX.setText(e, '⚠ ' + t.error)
        MCX.toggle(node, 'streaming', !!t.streaming)
        MCX.toggle(node, 'queued', !!t.queued)
        MCX.toggle(node, 'errored', !!t.error && !t.queued)
        D.renderOrchActions(node.querySelector('.orchacts'), t)
      },
    })
  }

  /** The server strips a trailing action fence only once the whole turn is
   *  done, so while a reply streams the raw block would otherwise type itself
   *  into view and then vanish. Actions always arrive as a TRAILING fenced
   *  json block, so it is hidden for the whole of streaming, closed as well
   *  as open, and the server's own cleaned text takes over on `done`. Any
   *  other unclosed fence (an odd count of markers) hides only the incomplete
   *  block. Only ever trims a SUFFIX, so prose before a fence stays shown. */
  const visibleWhileStreaming = (answer) => {
    const open = answer.lastIndexOf('```json')
    if (open >= 0) return answer.slice(0, open).replace(/\s+$/, '')
    const fences = (answer.match(/```/g) || []).length
    if (fences % 2 === 0) return answer
    return answer.slice(0, answer.lastIndexOf('```')).replace(/\s+$/, '')
  }

  // ---- the popup: open, close, the chord --------------------------------------

  const CMD_MAX_H = 160

  /** One handle for the popup's own open or close, so a re-open can call a
   *  close off mid-flight and vice versa -- the discipline hideDeck's own
   *  `leaving` handle follows. */
  let barTimer = 0

  /** Every duration the bar moves on, onto the root element once: the reply
   *  transcript and its paragraphs live in the left rail as well as in the
   *  popup, so a property set on #cmdbar would not reach them. Distances that
   *  belong to a measurement go in writeGrow instead. */
  const writeBarMotion = () => {
    const M = MCQA.MOTION
    const root = document.documentElement
    root.style.setProperty('--cmd-open', M.openMs + 'ms')
    root.style.setProperty('--cmd-close', M.closeMs + 'ms')
    root.style.setProperty('--cmd-caret', M.caretMs + 'ms')
    root.style.setProperty('--cmd-sweep', M.sweepMs + 'ms')
    root.style.setProperty('--cmd-err', M.errMs + 'ms')
    root.style.setProperty('--cmd-errspan', (M.errMs * M.errBeats) + 'ms')
    root.style.setProperty('--cmd-swap', M.swapMs + 'ms')
    root.style.setProperty('--cmd-pin', M.pinMs + 'ms')
    root.style.setProperty('--cmd-first', M.firstLineMs + 'ms')
    root.style.setProperty('--cmd-firstrise', M.firstRisePx + 'px')
    root.style.setProperty('--cmd-para', M.paraMs + 'ms')
    root.style.setProperty('--cmd-think', M.thinkMs + 'ms')
  }

  /** The mark's rectangle, as the four insets the panel's clip grows out of.
   *  Measured on every open and every close, never cached: the panel's width is
   *  a viewport percentage and the mark's own geometry follows the Logo
   *  setting. False when either box is unmeasurable, which the caller reads as
   *  "no grow" and shows the bar at once. */
  const writeGrow = () => {
    const bar = D.$('cmdbar')
    const panel = bar.querySelector('.cmdpanel')
    const mark = bar.querySelector('.cmdglyph')
    if (!panel || !mark) return false
    const g = MCQA.growInsets(panel.getBoundingClientRect(), mark.getBoundingClientRect())
    bar.style.setProperty('--cmd-t', g.top + 'px')
    bar.style.setProperty('--cmd-r', g.right + 'px')
    bar.style.setProperty('--cmd-b', g.bottom + 'px')
    bar.style.setProperty('--cmd-l', g.left + 'px')
    return g.right > 0 || g.bottom > 0
  }

  const open = () => {
    if (openState) return
    // Give focus back on close: the chord can be pressed from anywhere, and
    // taking focus without returning it is what makes a popup feel like a trap.
    lastFocus = document.activeElement
    openState = true
    const bar = D.$('cmdbar')
    clearTimeout(barTimer)
    barTimer = 0
    MCX.toggle(bar, 'cmdclosing', false)
    bar.hidden = false
    renderPopup()
    // Focus at once, never at the end of the grow: a keystroke typed while the
    // bar arrives would otherwise be lost. What arrives last is the caret.
    const f = D.$('cmd-ask')
    f.focus()
    if (f.value) f.select()
    MCX.toggle(bar, 'cmdopening', false)
    if (still() || !writeGrow()) return
    // Taken off first either way, and a layout read between: a class that
    // stayed on through a cancelled close would not replay its animation.
    void bar.offsetWidth
    MCX.toggle(bar, 'cmdopening', true)
    barTimer = setTimeout(() => {
      barTimer = 0
      MCX.toggle(bar, 'cmdopening', false)
    }, MCQA.MOTION.openMs)
  }

  const close = () => {
    if (!openState) return
    // The key layer reads openState, so the bar stops acting before it stops
    // being drawn -- and the deck goes at once rather than cross-fading back to
    // a reply area that is leaving too.
    openState = false
    if (deck.host === 'popup') hideDeck({ now: true })
    const bar = D.$('cmdbar')
    clearTimeout(barTimer)
    barTimer = 0
    MCX.toggle(bar, 'cmdopening', false)
    resetRecall()
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus()
    lastFocus = null
    // Measured while the panel is still laid out; hidden afterwards.
    if (still() || !writeGrow()) {
      MCX.toggle(bar, 'cmdclosing', false)
      bar.hidden = true
      return
    }
    MCX.toggle(bar, 'cmdclosing', true)
    barTimer = setTimeout(() => {
      barTimer = 0
      // A re-open during the close already unhid the bar and cleared the class.
      if (openState) return
      bar.hidden = true
      MCX.toggle(bar, 'cmdclosing', false)
    }, MCQA.MOTION.closeMs)
  }

  const toggle = () => (openState ? close() : open())

  const grow = (f) => { f.style.height = 'auto'; f.style.height = Math.min(f.scrollHeight, CMD_MAX_H) + 'px' }

  const renderPopup = () => {
    if (!openState) return
    const box = D.$('cmd-transcript')
    const has = D.S.orchTurns.length > 0
    // While the deck holds the popup's reply area the transcript stays hidden:
    // a frame landing underneath still renders into it, but never re-shows it
    // or moves its scroll.
    const up = deck.host === 'popup'
    MCX.show(box, has && (!up || swapping))
    renderTurns(box)
    // Not while the deck has it, and not while it is on its way out either:
    // the offset the deck saved is the one that goes back.
    if (has && !up) box.scrollTop = box.scrollHeight
    renderThreads()
    const t = D.S.orchThreads.find((x) => x.id === D.S.orchThreadId)
    D.$('cmd-pin').setAttribute('aria-pressed', t?.pinned ? 'true' : 'false')
    renderScope()
  }

  /** The bar's own scope chip. The stripe has had one since the Projects
   *  reorganisation; this is the popup's, and both end at the same place --
   *  ask()'s `scope`, which the bundle reads as `scope.project` and nothing
   *  else. */
  const renderScope = () => {
    const chip = D.$('cmd-scope')
    MCX.show(chip, !!pendingScope)
    MCX.setText(chip, pendingScope ? 'about ' + pendingScope.name : '')
  }

  // ---- the quick-access deck ---------------------------------------------------

  const deckOpen = () => !!deck.host

  /** Placed from the HOST FIELD's own box, never its parent's: below the
   *  composer row in the popup, above the field in the stripe. Re-measured on
   *  every show and on resize, the same discipline #cmd-rename's overlay and
   *  the mic button live under. */
  const placeDeck = () => {
    const node = D.$('cmd-deck')
    if (!deck.host || !node) return
    const field = D.$(deck.host === 'stripe' ? 'pj-ask' : 'cmd-ask')
    if (!field) return
    const box = field.getBoundingClientRect()
    node.style.left = Math.max(8, box.left) + 'px'
    node.style.width = Math.max(280, Math.min(box.width, window.innerWidth - 16)) + 'px'
    if (deck.host === 'stripe') {
      node.style.top = ''
      node.style.bottom = Math.max(8, window.innerHeight - box.top + 8) + 'px'
    } else {
      node.style.bottom = ''
      node.style.top = (box.bottom + 8) + 'px'
    }
  }

  /** Motion, loaded once and never awaited by a render. The first show kicks
   *  the import off and draws without it; every later show uses it if it
   *  arrived. A rejection is remembered so the import is not retried on every
   *  keypress. */
  let motion = { tried: false, api: null }
  const loadMotion = () => {
    if (motion.tried) return
    motion.tried = true
    import('/quick-access-motion.js')
      .then(() => { motion.api = window.MCQMO ?? null })
      .catch(() => { motion.api = null })
  }

  /** The one motion gate. Reduced motion is the hard off, read live rather
   *  than cached, because a reader can change it while the pane is open. The
   *  sandbox tab's calm dial governs beside it when its pure module is
   *  loaded, so one dial moves the whole pane rather than two. `typeof`, not a
   *  bare reference: a bare MCGM throws when that module is absent. */
  const still = () => {
    if (MCX.reducedMotion()) return true
    const name = MCQA.calmName((k) => { try { return localStorage.getItem(k) } catch (e) { return null } })
    if (typeof MCGM === 'undefined' || !MCGM || typeof MCGM.calmScale !== 'function') {
      return MCQA.stillNow(name, false)
    }
    const scale = MCGM.calmScale(name, false)
    return !scale || !scale.settle
  }

  const ARRIVE_EASE = [0.2, 0.7, 0.3, 1]

  /** One pending departure at a time, held in one handle so a show can call it
   *  off. `arriving` is true only while a show draws, so the hint line takes
   *  its text at once rather than cross-fading from the previous show's. */
  let leaving = 0
  let arriving = false

  /** One pending hide of the reply area, so a deck called off mid-fade leaves
   *  the transcript shown rather than hidden behind a deck that has gone. */
  let swapTimer = 0
  let swapping = false

  const fadeTranscriptOut = () => {
    const box = D.$('cmd-transcript')
    clearTimeout(swapTimer)
    swapping = true
    MCX.toggle(box, 'cmdfading', true)
    swapTimer = setTimeout(() => {
      swapTimer = 0
      swapping = false
      if (deck.host === 'popup') MCX.show(box, false)
    }, MCQA.MOTION.swapMs)
  }

  const endSwap = () => {
    clearTimeout(swapTimer)
    swapTimer = 0
    swapping = false
  }

  const showDeck = (host) => {
    if (deck.host === host) { renderDeck(); return }
    const node = D.$('cmd-deck')
    clearTimeout(leaving)
    leaving = 0
    MCX.toggle(node, 'qaleaving', false)
    deck.host = host
    deck.sel = deck.sel || 0
    // A stale press class from a deck hidden mid-flash would dim every card of
    // the next one, since a show cancels the timer that would have cleared it.
    MCX.toggle(node, 'qapress', false)
    node.hidden = false
    // The popup's reply area is genuinely swapped, never torn down: the
    // transcript keeps its scroll, its applied-action marks and every queued
    // turn. The scroll is read before anything hides it, while the box still
    // has one.
    if (host === 'popup') {
      const box = D.$('cmd-transcript')
      deck.scroll = box.scrollTop
      deck.scrollThread = D.S.orchThreadId
    }
    arriving = true
    try { renderDeck() } finally { arriving = false }
    placeDeck()
    loadMotion()
    if (still()) {
      MCX.toggle(node, 'qamotion', false)
      MCX.toggle(node, 'qaarrive', false)
      if (host === 'popup') { endSwap(); MCX.toggle(D.$('cmd-transcript'), 'cmdfading', false); MCX.show(D.$('cmd-transcript'), false) }
      return
    }
    MCX.toggle(node, 'qamotion', true)
    // Taken off first either way: never both paths at once, and a class that
    // stayed on through a cancelled departure would not replay its animation.
    MCX.toggle(node, 'qaarrive', false)
    if (host === 'popup') fadeTranscriptOut()
    if (motion.api) {
      const M = MCQA.MOTION
      const cards = [...D.$('qa-bands').querySelectorAll('.qacard')]
      try {
        if (cards.length) {
          // `translate`, never `y`: y is written as a transform, which is the
          // card's static depth and the selected card's own forward offset.
          const run = motion.api.animate(cards,
            { translate: ['0px ' + M.cardRisePx + 'px', '0px 0px'], opacity: [0, 1] },
            { duration: M.arriveMs / 1000, ease: ARRIVE_EASE,
              delay: (i) => Math.min(i, M.staggerCap) * M.staggerMs / 1000 })
          // The bundle commits its end values inline, which would then beat the
          // press lift and the selection's own rules.
          const clear = () => { for (const c of cards) { c.style.translate = ''; c.style.opacity = '' } }
          if (run && run.finished && typeof run.finished.then === 'function') run.finished.then(clear, clear)
        }
        return
      } catch (e) {
        // A bundle that refuses the call falls through to the stylesheet.
      }
    }
    // With no bundle the stylesheet animates, on the same numbers. Reading a
    // layout property between removing and adding the class restarts it.
    void node.offsetWidth
    MCX.toggle(node, 'qaarrive', true)
  }

  /** The deck stops acting at once -- the key layer reads `deck.host` -- and
   *  goes from the screen after it: a card mid-flash is seen first, then the
   *  deck fades and drifts away, then it is hidden. */
  const hideDeck = ({ now = false } = {}) => {
    if (!deck.host) return
    const node = D.$('cmd-deck')
    const wasPopup = deck.host === 'popup'
    deck.host = null
    deck.latched = false
    deck.sel = 0
    MCX.toggle(node, 'qalatched', false)
    const quiet = now || still()
    if (wasPopup && openState) {
      const box = D.$('cmd-transcript')
      endSwap()
      const has = D.S.orchTurns.length > 0
      MCX.show(box, has)
      // Restored after un-hiding: a hidden box has no scroll to set. A thread
      // switched while the deck was up is a different transcript, whose saved
      // offset means nothing, so it opens at its latest turn instead.
      box.scrollTop = D.S.orchThreadId === deck.scrollThread ? deck.scroll : box.scrollHeight
      if (has && !quiet) {
        // Faded from zero on the next frame, so the transition has two values
        // to run between rather than one it was born at.
        MCX.toggle(box, 'cmdfading', true)
        requestAnimationFrame(() => MCX.toggle(box, 'cmdfading', false))
      } else {
        MCX.toggle(box, 'cmdfading', false)
      }
    }
    clearTimeout(leaving)
    leaving = 0
    if (quiet) {
      MCX.toggle(node, 'qaleaving', false)
      MCX.toggle(node, 'qapress', false)
      node.hidden = true
      return
    }
    const M = MCQA.MOTION
    // A card mid-press is seen first, then the deck fades and drifts away.
    const wait = node.querySelector('.qacard.qacommit, .qacard.qarefuse') ? M.commitMs : 0
    leaving = setTimeout(() => {
      MCX.toggle(node, 'qaleaving', true)
      leaving = setTimeout(() => {
        leaving = 0
        if (deck.host) return
        node.hidden = true
        MCX.toggle(node, 'qaleaving', false)
        MCX.toggle(node, 'qapress', false)
      }, M.swapMs)
    }, wait)
  }

  /** MCX-reconciled, keyed by band id and by the card's own key -- so never
   *  assign node.className here: it would wipe `.gone` out from under
   *  MCX.show. Every optional chip is built once in `create` and hidden in
   *  `update`. */
  const renderDeck = () => {
    if (!deck.host) return
    const node = D.$('cmd-deck')
    model = MCQA.deck(deckInput())
    const M = MCQA.MOTION
    node.style.setProperty('--qa-arrive', M.arriveMs + 'ms')
    node.style.setProperty('--qa-swap', M.swapMs + 'ms')
    node.style.setProperty('--qa-select', M.selectMs + 'ms')
    node.style.setProperty('--qa-commit', M.commitMs + 'ms')
    node.style.setProperty('--qa-hint', M.hintMs + 'ms')
    node.style.setProperty('--qa-cardrise', M.cardRisePx + 'px')
    node.style.setProperty('--qa-lift', M.liftPx + 'px')
    node.style.setProperty('--qa-forward', M.forwardPx + 'px')

    // Counted afresh on every render, so a re-render on hover hands every card
    // the same delay it had before rather than a longer one.
    stagger = 0
    MCX.reconcile(D.$('qa-bands'), model.bands, {
      key: (b) => b.id,
      create: () => {
        const n = D.el('div', 'qaband')
        n.appendChild(D.el('div', 'qablabel'))
        n.appendChild(D.el('div', 'qacards'))
        return n
      },
      update: (n, b) => {
        MCX.setText(n.querySelector('.qablabel'), b.label)
        renderCardsInto(n.querySelector('.qacards'), b)
      },
    })
    renderHint()
    // An older relay never sends `favourites`, which is worth telling apart
    // from having starred nothing.
    MCX.show(D.$('qa-note'), !favKnown)
  }

  /** A band's slot with no card behind it. Drawn, dim and inert, so a digit's
   *  place never moves; actionFor has nothing for it. */
  const emptyCard = (slot) => ({
    kind: 'empty', slot, key: 'empty:' + slot, id: null, title: '—', meta: 'unbound',
    color: '', live: false, path: '', jump: '', tip: '',
  })

  let stagger = 0
  const renderCardsInto = (box, band) => {
    const slots = MCQA.BANDS.find((x) => x.id === band.id)?.slots ?? []
    const bySlot = new Map(band.cards.map((c) => [c.slot, c]))
    const cards = slots.map((slot) => bySlot.get(slot) ?? emptyCard(slot))
    MCX.reconcile(box, cards, {
      key: (c) => c.key,
      create: () => {
        const n = D.el('div', 'qacard')
        n.appendChild(D.el('span', 'qadigit'))
        n.appendChild(D.el('span', 'qatitle'))
        n.appendChild(D.el('span', 'qameta'))
        return n
      },
      update: (n, c, i) => {
        MCX.setText(n.querySelector('.qadigit'), String(c.slot === 10 ? 0 : c.slot))
        MCX.setText(n.querySelector('.qatitle'), c.title)
        MCX.setText(n.querySelector('.qameta'), c.meta)
        MCX.setAttr(n, 'data-tip', c.tip || null)
        MCX.setAttr(n, 'data-slot', String(c.slot))
        MCX.toggle(n, 'qadim', !c.live)
        MCX.toggle(n, 'qasel', deck.sel === c.slot)
        MCX.toggle(n, 'qainert', MCQA.actionFor(c, deck.mods) === null)
        if (c.color) n.style.setProperty('--qa-color', c.color)
        else n.style.removeProperty('--qa-color')
        // The card's place within its band, for the stylesheet's depth.
        n.style.setProperty('--qa-i', String(i))
        // The stagger is a per-card delay the stylesheet reads, so the CSS
        // path and the Motion path use the same numbers.
        n.style.setProperty('--qa-delay',
          (Math.min(MCQA.MOTION.staggerCap, stagger++) * MCQA.MOTION.staggerMs) + 'ms')
        n.onmouseenter = () => { deck.sel = c.slot; renderDeck() }
        n.onclick = (ev) => {
          ev.preventDefault()
          // A deck on its way out is still painted, but no longer acts.
          if (!deck.host) return
          runAction(c, { shift: ev.shiftKey, cmd: ev.metaKey || ev.ctrlKey })
        }
      },
    })
  }

  const renderHint = () => {
    const card = model.bySlot[deck.sel]
    const a = card ? MCQA.actionFor(card, deck.mods) : null
    const mods = (deck.mods.shift ? 'shift ' : '') + (deck.mods.cmd ? 'cmd ' : '')
    const text = !card
      ? 'a digit picks a card · ⌥⌥ latches · esc leaves'
      : a ? mods + 'press ' + (card.slot === 10 ? '0' : card.slot) + ' — ' + hintFor(a, card)
          : 'nothing here for those modifiers'
    const line = D.$('qa-hint')
    if (!line) return
    // Compared with what the line is about to show, not only what it shows
    // now, so a change arriving mid-fade replaces the pending text.
    const shown = hintFade.timer ? hintFade.text : line.textContent
    if (text === shown) return
    if (arriving || still()) {
      clearTimeout(hintFade.timer)
      hintFade.timer = 0
      line.style.opacity = ''
      MCX.setText(line, text)
      return
    }
    // A cross-fade: out over the hint's duration, the latest text swapped in,
    // back in on the stylesheet's transition. One timer, replaced by the next
    // change. The line is static markup, so an inline style here is safe.
    hintFade.text = text
    line.style.opacity = '0'
    clearTimeout(hintFade.timer)
    hintFade.timer = setTimeout(() => {
      hintFade.timer = 0
      MCX.setText(line, hintFade.text)
      line.style.opacity = ''
    }, MCQA.MOTION.hintMs)
  }
  const hintFade = { timer: 0, text: '' }

  const hintFor = (a, card) => {
    switch (a.do) {
      case 'drawer': return a.reply ? 'open ' + card.title + ' and reply' : 'open ' + card.title
      case 'jump': return 'jump to ' + card.title + '’s terminal'
      case 'ring': return 'ring ' + card.title + ' on the canvas'
      case 'toast': return a.text
      case 'template': return a.submit ? 'apply ' + card.title + ' and queue it'
        : a.mode === 'fill-empty' ? 'fill only the empty fields from ' + card.title
        : 'apply ' + card.title + ' in Dispatch'
      case 'scope': return 'ask about ' + card.title
      case 'tab': return 'open ' + a.view
      case 'copy': return 'copy ' + a.text
      default: return ''
    }
  }

  /** One switch over the descriptor MCQA.actionFor returned, and nothing
   *  decides here: the table is pure and tested, this only performs it. Every
   *  target is something the pane already exposes -- MCW.open, MCC.spotlight,
   *  MCT.applyTo, a tab click and the clipboard -- so no sibling module needs
   *  a method invented for the deck beyond the one seam in templates.js. */
  const openTab = (view) => document.querySelector('.tab[data-view="' + view + '"]')?.click()

  const runAction = (card, mods) => {
    const a = MCQA.actionFor(card, mods)
    flash(card, !a)
    if (!a) { D.toast('nothing there for those modifiers'); return }
    switch (a.do) {
      case 'toast':
        D.toast(a.text, { kind: 'warn' })
        return
      case 'drawer':
        hideDeck()
        MCW.open(a.id)
        if (a.reply) requestAnimationFrame(() => D.$('d-replytext')?.focus())
        return
      case 'jump':
        void (async () => {
          const out = await D.post('/api/jump', { id: a.id })
          if (out && out.ok) {
            D.toast(out.case === 'tmux' ? 'jumped' : 'opened ' + (out.window || 'a tmux window'))
            if (out.note) D.toast(out.note, { ms: 5000, kind: 'warn' })
          } else if (out && out.case === 'outside') {
            D.toast('outside tmux' + (out.tty ? ' on ' + out.tty : '') + ' — run: ' + out.command, { ms: 8000, kind: 'warn' })
          } else {
            D.toast((out && out.error) || 'could not jump', { ms: 5000, kind: 'warn' })
          }
        })()
        return
      case 'ring':
        hideDeck()
        openTab('canvas')
        // The canvas's nodes measure zero while its view is still hidden.
        requestAnimationFrame(() => MCC.spotlight([a.id]))
        return
      case 'template':
        hideDeck()
        openTab('dispatch')
        requestAnimationFrame(() => {
          const done = MCT.applyTo('d-tplstrip', a.id, { mode: a.mode, submit: a.submit })
          D.toast(done
            ? (a.submit ? 'queued from ' + card.title : 'applied ' + card.title)
            : 'could not apply ' + card.title, done ? {} : { kind: 'warn' })
        })
        return
      case 'scope':
        pendingScope = { key: a.key, name: a.name }
        renderScope()
        if (deck.host === 'stripe') {
          hideDeck()
          D.$('pj-ask')?.focus()
        } else {
          hideDeck()
          if (!openState) open()
          D.$('cmd-ask').focus()
        }
        D.toast('the next ask is about ' + a.name)
        return
      case 'tab':
        hideDeck()
        openTab(a.view)
        if (a.focus) requestAnimationFrame(() => {
          const panel = D.$(a.focus)
          if (!panel) return
          panel.focus()
          panel.scrollIntoView({ block: 'nearest' })
        })
        return
      case 'copy':
        navigator.clipboard?.writeText(a.text)
        D.toast('copied ' + a.text)
        return
      default:
        return
    }
  }

  /** A press is acknowledged on the card before the deck goes away, so a digit
   *  never feels like it did nothing -- and a press the held modifiers have no
   *  action for is acknowledged too, differently: the card blinks its own edge
   *  instead of lifting and lighting, because nothing is about to happen. */
  const flash = (card, refused) => {
    const node = D.$('cmd-deck')
    const n = D.$('qa-bands')?.querySelector('.qacard[data-slot="' + card.slot + '"]')
    if (!n || still()) return
    MCX.toggle(n, 'qacommit', !refused)
    MCX.toggle(n, 'qarefuse', !!refused)
    MCX.toggle(node, 'qapress', !refused)
    setTimeout(() => {
      MCX.toggle(n, 'qacommit', false)
      MCX.toggle(n, 'qarefuse', false)
      MCX.toggle(node, 'qapress', false)
    }, MCQA.MOTION.commitMs)
  }

  /** One accent pulse when two taps of option latch the mode. */
  const pulseLatch = () => {
    const node = D.$('cmd-deck')
    if (!node || still()) return
    MCX.toggle(node, 'qalatched', false)
    void node.offsetWidth
    MCX.toggle(node, 'qalatched', true)
    setTimeout(() => MCX.toggle(node, 'qalatched', false), MCQA.MOTION.commitMs)
  }

  /** The chord, and the modal layer. Registered on WINDOW in the CAPTURE
   *  phase, which is the whole reason no other file needs editing. Four
   *  Enter handlers test `metaKey || ctrlKey` without testing shiftKey
   *  (#lm-note, the steer form, #d-replytext, canvas's spawn form), #orb-ask
   *  fires on a bare Enter with no modifier check at all, and the
   *  armed-steering handler sends on Enter -- all bubble-phase. Two capture
   *  listeners sit on the path as well: voice.js's on DOCUMENT, one step
   *  further down, and canvas.js's spawn-form Escape listener on WINDOW
   *  itself. Capture listeners on one target run in registration order, which
   *  is why MCQ.attach runs before MCC.attach, and only
   *  stopImmediatePropagation stops a second listener on the same target,
   *  which is why every key handled here goes through swallow(). */
  const isChord = (e) => (e.metaKey || e.ctrlKey) && e.shiftKey &&
    (e.key === 'Enter' || e.key === 'k' || e.key === 'K')

  /** A key this layer handles reaches no other handler in the pane. */
  const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation() }

  /** Which host would show the deck right now: the popup when it is open,
   *  else the stripe when its own field has focus. Nothing else hosts it, and
   *  nothing does while a rename owns the keyboard. */
  const deckHostNow = () => {
    if (renameOpen) return null
    if (openState) return 'popup'
    return document.activeElement === D.$('pj-ask') ? 'stripe' : null
  }

  const noteMods = (e) => {
    deck.mods = { shift: !!e.shiftKey, cmd: !!(e.metaKey || e.ctrlKey) }
    // A held Option repeats its keydown; feeding a repeat to the tap detector
    // would read it as a second press, so only a genuine keydown steps it.
    if (!(e.type === 'keydown' && e.repeat)) {
      const r = MCQA.tapStep(tap, { type: e.type, key: e.key, at: e.timeStamp })
      tap = r.state
      if (r.latch && deck.host) { deck.latched = true; if (!deck.sel) deck.sel = firstSlot(); renderDeck(); pulseLatch(); return }
    }
    const host = deckHostNow()
    if (e.type === 'keydown' && e.key === 'Alt' && !e.repeat && host) showDeck(host)
    else if (e.type === 'keyup' && e.key === 'Alt' && !deck.latched) hideDeck()
    else if (deck.host) renderDeck()
  }

  const firstSlot = () => {
    for (const b of MCQA.BANDS) for (const s of b.slots) if (model.bySlot[s]) return s
    return 0
  }

  const stepSel = (dir) => {
    const slots = MCQA.BANDS.flatMap((b) => b.slots).filter((s) => model.bySlot[s])
    if (!slots.length) return
    const at = Math.max(0, slots.indexOf(deck.sel))
    deck.sel = slots[Math.min(slots.length - 1, Math.max(0, at + dir))]
    renderDeck()
  }

  const stepBand = (dir) => {
    const ids = model.bands.map((b) => b.id)
    const cur = MCQA.slotBand(deck.sel)
    const at = Math.max(0, ids.indexOf(cur))
    const band = model.bands[Math.min(ids.length - 1, Math.max(0, at + dir))]
    if (band && band.cards[0]) { deck.sel = band.cards[0].slot; renderDeck() }
  }

  let fieldTimer = 0

  /** The field's one animation, by name, or none. Both of its motions live on
   *  the same `animation` property, so whichever is asked for takes the other
   *  off first; a layout read between makes the class replay rather than being
   *  ignored as already present. */
  const fieldAnim = (name) => {
    const f = D.$('cmd-ask')
    if (!f) return
    clearTimeout(fieldTimer)
    fieldTimer = 0
    MCX.toggle(f, 'cmdsweep', false)
    MCX.toggle(f, 'cmderr', false)
    if (!name || still()) return
    const M = MCQA.MOTION
    const ms = name === 'cmderr' ? M.errMs * M.errBeats : M.sweepMs
    void f.offsetWidth
    MCX.toggle(f, name, true)
    fieldTimer = setTimeout(() => {
      fieldTimer = 0
      MCX.toggle(f, name, false)
    }, ms)
  }

  /** A failed ask, on the bar's own field. Nothing while the popup is closed:
   *  a rail ask fails on a field nobody is looking at. */
  const flashError = () => { if (openState) fieldAnim('cmderr') }

  const onKey = (e) => {
    if (isChord(e)) { swallow(e); toggle(); return }
    // Option, observed and never swallowed. app.js carries two unguarded
    // bubble-phase `key === 'Alt'` latches; stopping the keyup would leave
    // both stuck on for the rest of the session. Their visible effect while
    // this layer is up is a class on two nodes in a hidden view and one
    // modeline redraw behind the scrim, so letting them through costs
    // nothing.
    if (e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta' || e.key === 'Control') {
      noteMods(e)
      return
    }
    // Any other key between two taps of Option means they were not a double tap.
    tap = MCQA.tapStep(tap, { type: 'keydown', key: e.key, at: e.timeStamp }).state
    // PEEK and DECK, ahead of the popup-only return so the stripe reaches it.
    // Digits are read off e.code, never e.key: Option plus a digit composes a
    // different glyph on macOS. They are swallowed in both modes, and that is
    // load-bearing in DECK -- with focus off the composer, the pane's own
    // digit router would otherwise switch tabs.
    // The stripe's own ⌥Enter (a new thread) and the popup's ⌥↑/⌥↓ (the
    // thread switcher) are untouched: a PEEK claims digits only, and the
    // latched branch is reached only after two taps.
    if (deck.host && !renameOpen) {
      const slot = MCQA.digitSlot(e.code)
      if (slot !== null && (e.altKey || deck.latched)) {
        swallow(e)
        const card = model.bySlot[slot]
        if (card) runAction(card, { shift: e.shiftKey, cmd: e.metaKey || e.ctrlKey })
        else D.toast('nothing on ' + (slot === 10 ? '0' : slot))
        if (!deck.latched) hideDeck()
        return
      }
      if (deck.latched) {
        if (e.key === 'Escape') { swallow(e); hideDeck(); if (openState) D.$('cmd-ask').focus(); return }
        if (e.key === 'Tab') { hideDeck(); return }
        if (e.key === 'j' || e.key === 'ArrowDown') { swallow(e); stepSel(1); return }
        if (e.key === 'k' || e.key === 'ArrowUp') { swallow(e); stepSel(-1); return }
        if (e.key === 'l' || e.key === 'ArrowRight') { swallow(e); stepBand(1); return }
        if (e.key === 'h' || e.key === 'ArrowLeft') { swallow(e); stepBand(-1); return }
        if (e.key === 'Enter') {
          swallow(e)
          const card = model.bySlot[deck.sel]
          if (card) runAction(card, { shift: e.shiftKey, cmd: e.metaKey || e.ctrlKey })
          return
        }
        // templates.js's rule: any other key leaves the mode and carries on to
        // whoever wanted it -- so it falls through to the rest of this handler.
        hideDeck()
      }
    }
    if (!openState) return
    // While a rename is open its field owns every key but the chord: Escape
    // must cancel the rename, not close the popup and commit it on blur.
    if (renameOpen) return
    if (e.key === 'Escape') {
      if (pendingScope) { swallow(e); pendingScope = null; renderScope(); return }
      swallow(e); close(); return
    }
    if (e.target !== D.$('cmd-ask')) return
    const f = e.target
    if (e.key === 'Enter' && !e.shiftKey) {
      swallow(e)
      const text = f.value
      f.value = ''; grow(f)
      fieldAnim('cmdsweep')
      void ask(text, { newThread: e.metaKey || e.ctrlKey })
      return
    }
    // e.code, never e.key: Option remaps e.key to a composed glyph on macOS
    // (Option+Shift+P is a different character entirely), the same reason
    // MCQA.digitSlot reads e.code and not e.key. Moved off cmd+P, which is
    // Print in most browsers.
    if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyP') {
      swallow(e); void togglePin(); return
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      swallow(e)
      // Two stages, the way Escape escalates elsewhere in this pane: clear
      // what is typed first, and only then drop the conversation.
      if (f.value) { f.value = ''; grow(f); resetRecall() } else void newThread()
      return
    }
    // The switcher's own modal keys. Option, not command-bracket: ⌘[ and ⌘]
    // are browser back/forward on macOS. A switcher you can only reach with
    // the mouse is not a modal layer, which is why this exists at all.
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      swallow(e)
      const list = D.S.orchThreads
      if (list.length < 2) return
      const at = Math.max(0, list.findIndex((t) => t.id === D.S.orchThreadId))
      const next = e.key === 'ArrowUp' ? Math.max(0, at - 1) : Math.min(list.length - 1, at + 1)
      if (list[next] && list[next].id !== D.S.orchThreadId) void selectThread(list[next].id)
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const dir = recallStep({ value: f.value, selectionStart: f.selectionStart, selectionEnd: f.selectionEnd, key: e.key })
      if (!dir) return
      swallow(e)
      const asks = D.S.orchTurns.map((t) => t.question).filter(Boolean)
      const next = stepRecall({ asks, idx: recall.idx, draft: recall.draft, value: f.value, dir })
      recall = { idx: next.idx, draft: next.draft }
      f.value = next.value; grow(f)
      f.setSelectionRange(f.value.length, f.value.length)
    }
  }

  // ---- wiring ----------------------------------------------------------------

  const attach = (deps) => {
    D = deps
    writeBarMotion()
    D.S.orchThreads = D.S.orchThreads || []
    D.S.orchThreadId = D.S.orchThreadId ?? null
    MCE.on('orchestrator', onFrame)
    MCE.onField('orchestrator', () => { void hydrate() })
    // A new live update is a line in this file, never an edit to app.js's one
    // snapshot handler. An older relay sends no `favourites` key, which
    // onField's own `name in d` guard tells apart from an empty list.
    MCE.onField('favourites', (v) => {
      favKnown = true
      D.S.favourites = Array.isArray(v) ? v : []
      if (deck.host) renderDeck()
    })
    MCE.on('favourites', (d) => {
      favKnown = true
      D.S.favourites = Array.isArray(d?.favourites) ? d.favourites : []
      if (deck.host) renderDeck()
    })
    addEventListener('resize', () => placeDeck())
    // #pj-ask is resizable by the user, so a window resize is not the only way
    // its box moves -- the mic button's anchoring lives under the same rule.
    const field = D.$('pj-ask')
    if (field && typeof ResizeObserver === 'function') new ResizeObserver(() => placeDeck()).observe(field)
    D.$('pj-ask')?.addEventListener('blur', () => { if (deck.host === 'stripe') hideDeck() })
    // The cards are not focusable, so a mousedown on one would otherwise move
    // focus to the page, and over the stripe that blur hides the deck before
    // the click lands.
    D.$('cmd-deck').addEventListener('mousedown', (e) => e.preventDefault())
    // A keyup that happens while the window is not focused never arrives, so
    // the deck would otherwise stay up with a modifier nobody is holding --
    // the same reason app.js's own Option latches clear on blur.
    const forget = () => { tap = MCQA.tapStep(tap, { type: 'blur', at: Date.now() }).state; deck.mods = { shift: false, cmd: false }; hideDeck() }
    addEventListener('blur', forget)
    document.addEventListener('visibilitychange', () => { if (document.hidden) forget() })
    // onKey hears keydown only; the modifiers' keyups come through here,
    // capture-phase and never swallowed.
    addEventListener('keyup', (e) => { if (e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta' || e.key === 'Control') noteMods(e) }, true)
    D.$('cmd-scope').addEventListener('click', () => { pendingScope = null; renderScope() })
    addEventListener('keydown', onKey, true)
    D.$('cmdbar').addEventListener('mousedown', (e) => { if (e.target === D.$('cmdbar')) close() })
    D.$('cmd-ask').addEventListener('input', (e) => grow(e.target))
    D.$('cmd-pin').addEventListener('click', () => void togglePin())
  }

  return { attach, ask, drain, onFrame, hydrate, renderTurns, renderAll, foldTurns, recallStep, stepRecall,
           isOpen: () => openState, open, close, toggle,
           deckOpen, showDeck, hideDeck, renderDeck }
})()
