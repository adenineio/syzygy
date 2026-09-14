/* Syzygy -- the session drawer.
 *
 * openDrawer/closeDrawer, the last message and its live refresh, the reply
 * field, rename, the armed kill, the card-colour picker, the subagents list,
 * the terminal jump row and the TODO scope toggle -- behind the same
 * attach(deps) pattern replay.js, projects.js, dispatch.js and canvas.js use.
 *
 * A CLASSIC script, loaded after reconcile.js (it reconciles the TODO list) and
 * before app.js. Nothing may run at evaluation time: `$` and `el` belong to
 * app.js, which loads afterwards, so every DOM binding happens in wire(),
 * called from attach().
 *
 * The dependency names below SHADOW app.js's own top-level bindings of the same
 * names, the way projects.js's do, so the drawer's code reads exactly as it
 * would inside app.js.
 *
 * Two rules to keep if you edit this file:
 *   - NEVER assign `node.className` in renderTodos. It would wipe `.gone` out
 *     from under MCX.show. Toggle classes individually.
 *   - Nothing here writes to the relay directly: `post` is injected, so the
 *     token header stays in one place. The one read, a project's document for
 *     the TODOs section, is a plain GET of a read-only route. */
'use strict'

const MCW = (() => {
  let S = null, $ = null, el = null, post = null, toast = null, ago = null,
      compact = null, money = null, clockOf = null, nameOf = null,
      needsOf = null, rescope = null, renderCards = null

  /** Paints the drawer's "Last message" section from `s.lastAnswer`/
   *  `lastAnswerAt` alone. Split out of `openDrawer` so a live update can
   *  repaint just this one section into `#d-last` -- built once, in
   *  `openDrawer` -- without touching the rest of `#d-body` (which would cost
   *  its scroll position) and without a close/reopen. `lastAnswer` is a payload
   *  field, so against a relay that predates it this reads undefined and the
   *  empty state shows -- indistinguishable from a session that has not
   *  finished a turn yet: the pane's static assets reload on their own, but the
   *  relay behind them does not. */
  const renderLastMessage = (s) => {
    const box = $('d-last'); if (!box) return
    box.textContent = ''
    if (s.lastAnswer) {
      const said = el('div', 'saidbox')
      // textContent, never innerHTML: this is an assistant's prose arriving over
      // the wire and it is displayed, never parsed.
      const pre = el('pre', 'said')
      pre.textContent = s.lastAnswer
      said.appendChild(pre)
      said.appendChild(el('div', 'saidage', s.lastAnswerAt ? ago(s.lastAnswerAt) + ' ago' : ''))
      box.appendChild(said)
    } else box.appendChild(el('div', 'empty', 'No message yet.'))
  }

  /** Called on every SSE payload that carries fresh session data. While the
   *  drawer is pinned open on a session, its "Last message" section otherwise
   *  only reflects whatever was true at the moment it was opened -- this is
   *  what keeps it live without re-running `openDrawer` (and its scroll-
   *  resetting, rename-cancelling side effects) on every frame. */
  const refreshPinnedLastMessage = () => {
    if (!S.pinned) return
    const s = S.sessions.find((x) => x.id === S.pinned)
    if (s) renderLastMessage(s)
  }

  // --- TODOs: this session's own plans, with a whole-project toggle -----------
  // Display order among this session's own plans: an explicit claim, then
  // `checked`, then a copy touched here (MCPM.planIsMine says which).
  const TODO_MINE_ORDER = { claim: 0, checked: 1, touched: 2 }

  const TODO_SCOPE_KEY = 'szg.drawer.todoscope'
  const readTodoScope = () => {
    try { return localStorage.getItem(TODO_SCOPE_KEY) === 'all' ? 'all' : 'mine' } catch { return 'mine' }
  }
  const writeTodoScope = (v) => { try { localStorage.setItem(TODO_SCOPE_KEY, v) } catch {} }

  // The document of each project a drawer has listed TODOs for, keyed by
  // project key as `{ status, changedAt, project }`. The digest's worktree line
  // holds the flag for the task file, the plan count and the claimed sections; which
  // plans are in flight in a worktree, and whose, rides the document. It is
  // fetched when the drawer shows that project and again when the project's
  // changedAt moves, and a document being refetched is still drawn.
  const todoDocs = new Map()
  const TODO_NOTE = {
    'loading…': 'loading plans…',
    'unavailable on this relay': 'plans unavailable on this relay',
    'could not be read': 'plans could not be read',
  }

  const fetchTodoDoc = (key, changedAt) => {
    const prior = todoDocs.get(key)
    const entry = { status: 'loading', changedAt, project: prior?.project ?? null }
    todoDocs.set(key, entry)
    // Recorded at the changedAt it was asked for, never the document's own, so
    // an answer newer than this pane's digest is not re-asked on every paint.
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
        // Replaced or evicted while in flight: this is not the answer awaited.
        if (todoDocs.get(key) !== entry) return
        todoDocs.set(key, next)
        // Only the section repaints, and only while a drawer is open.
        if (S.pinned) renderTodos(S.pinned)
      })
  }

  /** The drawer's TODOs section: this session's own plans by default -- an
   *  explicit claim, then `checked`, then anything touched in this worktree's
   *  copy that main's does not share -- plus its claimed backlog sections, with
   *  a header toggle to the unfiltered whole-worktree list. Rebuilt on demand,
   *  from `openDrawer`, from the toggle's own click and when the project's
   *  document lands, rather than only ever from `openDrawer` -- the same reason
   *  `renderLastMessage` is split out: repainting the whole drawer body would
   *  cost scroll position and cancel an in-progress rename. Re-finds the
   *  worktree from `S.projects` each call rather than closing over it, so a
   *  repaint after a payload has moved on still reads live data. Rows are
   *  MCX-keyed so a hover surviving the mine/whole-project toggle is free, the
   *  same reason `renderSteer` reconciles its button list. */
  const renderTodos = (id) => {
    const head = $('d-todos-head'), flag = $('d-todos-flag'), note = $('d-todos-note'), list = $('d-todos-list')
    if (!head || !list || !flag || !note) return
    head.textContent = ''
    head.appendChild(el('span', 'sect', 'TODOs'))
    // An empty state is plain markup, not a keyed row: clear one left by an
    // earlier paint, so a later reconcile never draws rows beneath it.
    for (const n of Array.prototype.slice.call(list.children)) if (MCX.keyOf(n) === undefined) n.remove()

    let project = null, wt = null
    for (const p of (S.projects ?? [])) {
      wt = (p.worktrees ?? []).find((w) => (w.sessions ?? []).some((x) => x.id === id))
      if (wt) { project = p; break }
    }

    if (!wt) {
      MCX.show(flag, false)
      MCX.setText(note, 'No task files found for this session’s worktree.')
      MCX.show(note, true)
      MCX.reconcile(list, [], { key: (d) => d.key })
      return
    }

    // The convention is docs/TASKS.md; a file at the project ROOT outranks it.
    // Worth saying out loud, because a project with both has a docs/TASKS.md
    // that is being read and is not the authority -- which is invisible
    // everywhere else and is exactly the sort of thing somebody edits for an
    // hour before noticing.
    if (wt.taskAuthority === 'root') {
      MCX.setText(flag, 'todos: ' + wt.taskFile + ' at the project root takes precedence over docs/')
      MCX.show(flag, true)
    } else MCX.show(flag, false)

    const key = MCPM.projectKey(project)
    const { fetch: ask, evict } = MCPM.docPlan(S.projects ?? [], todoDocs, { want: [key] })
    for (const k of evict) todoDocs.delete(k)
    for (const k of ask) fetchTodoDoc(k, project.changedAt ?? null)
    const { project: doc, note: docNote } = MCPM.docNeed(project, todoDocs.get(key))

    // Nothing to list yet: the count the digest already holds, and what the
    // wait is -- never an empty state, which would claim there is no work.
    if (!doc) {
      const count = wt.planCount ?? 0
      head.appendChild(el('span', 'todocount', count + (count === 1 ? ' plan' : ' plans') + ' · whole project'))
      MCX.setText(note, TODO_NOTE[docNote] ?? docNote ?? TODO_NOTE['loading…'])
      MCX.show(note, true)
      MCX.reconcile(list, [], { key: (d) => d.key })
      return
    }

    // This worktree's own copy of each plan. `!fold.shipped` matters as much as
    // the counts here: this list computes "in flight" itself rather than
    // reading `effort.live`, so without it a plan that DECLARES it shipped
    // still appears, captioned "all steps checked" beside a title reading
    // `0/N`. That caption is a false completion claim -- worse than the stale
    // current step it replaced.
    const live = []
    for (const fold of (doc.plans ?? [])) {
      const copy = (fold.copies ?? []).find((c) => c.wt === wt.path)
      if (!copy || copy.label === 'absent' || fold.shipped) continue
      if ((copy.done ?? 0) < (copy.total ?? 0)) live.push({ fold, copy })
    }

    if (!live.length) {
      MCX.show(note, false)
      MCX.reconcile(list, [], { key: (d) => d.key })
      list.textContent = ''
      list.appendChild(el('div', 'empty', 'No plans in flight in ' + wt.path + '.'))
      return
    }

    const scope = readTodoScope()
    const mine = live
      .map((x) => ({ x, reason: MCPM.planIsMine(x.fold, id, wt.isMain, wt.path) }))
      .filter((m) => m.reason)
      .sort((a, b) => TODO_MINE_ORDER[a.reason] - TODO_MINE_ORDER[b.reason])
      .map((m) => m.x)
    // The digest's worktree line already holds exactly the sections a claim
    // sits on; this session's are the ones it claims.
    const sections = (wt.claimedSections ?? []).filter((c) => (c.claimedBy ?? []).some((x) => x.id === id))

    // Nothing claimed or touched: fall through to the unfiltered list rather
    // than an empty section, so a fresh session is never blank.
    const fallback = scope === 'mine' && mine.length === 0 && sections.length === 0
    const wholeProject = scope === 'all' || fallback
    const shownPlans = wholeProject ? live : mine

    const toggle = el('button', 'btn todoscope', scope === 'all' ? 'whole project' : 'this session')
    toggle.dataset.tip = 'TODOs scope\n"this session" shows only plans this session claimed or has touched, plus its claimed backlog sections.\n"whole project" shows every in-flight plan in the worktree.\n\nClick to switch.'
    toggle.onclick = () => { writeTodoScope(scope === 'all' ? 'mine' : 'all'); renderTodos(id) }
    head.appendChild(toggle)
    head.appendChild(el('span', 'todocount', scope === 'all'
      ? live.length + (live.length === 1 ? ' plan' : ' plans') + ' · whole project'
      : mine.length + ' of ' + live.length + ' plans · this session'))

    MCX.setText(note, 'no plan claimed or touched by this session — showing the project')
    MCX.show(note, fallback)

    const rows = shownPlans.map(({ fold, copy }) => ({ key: 'plan:' + fold.rel, kind: 'plan', fold, copy }))
    if (!wholeProject) for (const c of sections) rows.push({ key: 'section:' + c.rel + '#' + c.slug, kind: 'section', c })

    MCX.reconcile(list, rows, {
      key: (d) => d.key,
      create: () => {
        const r = el('div', 'ev ok')
        r.appendChild(el('div', 'body'))
        return r
      },
      update: (r, d) => {
        const bd = r.firstElementChild
        bd.textContent = ''
        if (d.kind === 'plan') {
          bd.appendChild(el('div', 'title', (d.fold.title || d.fold.rel) + ' · ' + (d.copy.done ?? 0) + '/' + (d.copy.total ?? 0)))
          bd.appendChild(el('div', 'detail', d.copy.currentItem ?? 'all steps checked'))
        } else {
          bd.appendChild(el('div', 'title', d.c.text))
          bd.appendChild(el('div', 'detail', 'claimed backlog section'))
        }
      },
    })
  }

  // --- card colour ---------------------------------------------------------
  // A session card's own outline colour, set here and drawn by fillCard/
  // canvas.js off `s.color` (cards.mjs). It exists to make one session findable
  // at a glance, which is a switchboard-wide concern -- so the picker lives in
  // the drawer, one per session, rather than as a global setting.

  /** Eight points spread evenly around the wheel, at the same saturation and
   *  lightness `buildSwatches` already uses for the theme picker (hsl(hue 60%
   *  65%)) -- "from the theme family" without literally reusing THEMES' five
   *  hues, which would sit on top of the four semantic presets below (amber
   *  ~30°, green ~165°, purple ~262°, red-hot ~350°). */
  const hslToHex = (h, s, l) => {
    s /= 100; l /= 100
    const k = (n) => (n + h / 30) % 12
    const a = s * Math.min(l, 1 - l)
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
    const toHex = (n) => Math.round(255 * f(n)).toString(16).padStart(2, '0')
    return `#${toHex(0)}${toHex(8)}${toHex(4)}`
  }
  const CARD_WHEEL = [0, 45, 90, 135, 180, 225, 270, 315].map((h) => hslToHex(h, 60, 65))
  // The four semantic tokens (app.css :root), spelled out as the literal hex
  // they already are rather than resolved from CSS -- the picker needs a real
  // #rrggbb to post, not a var() reference.
  const CARD_SEMANTIC = ['#e0973c', '#ff5670', '#45c9a0', '#a883e6'] // amber, red-hot, green, purple
  const CARD_PRESETS = [...CARD_WHEEL, ...CARD_SEMANTIC]

  /** Sets a session's outline colour. Optimistic, same pattern as canvas.js's
   *  node-move drag (finish()): the card and the drawer update immediately,
   *  and only revert if the relay refuses. `s` is mutated in place rather than
   *  replaced, since `S.sessions` is what every render reads. */
  const setCardColor = async (id, color) => {
    const s = S.sessions.find((x) => x.id === id)
    const prior = s ? s.color : undefined
    if (s) s.color = color
    renderCards()
    if (S.pinned === id) renderColor(id)
    const r = await post('/api/session/color', { id, color })
    if (!r || r.error) {
      toast((r && r.error) || 'could not set colour', { kind: 'warn' })
      if (s) s.color = prior
      renderCards()
      if (S.pinned === id) renderColor(id)
    }
  }

  /** Whether this session's NAME is a favourite. Keyed by name, like the
   *  colour beside it: a terminal gets a fresh id every restart, and the thing
   *  you keep coming back to is the name. */
  const isFavourite = (name) => (S.favourites ?? []).some((f) => f && f.name === name)

  /** Optimistic, the same pattern setCardColor uses: the star flips at once
   *  and only flips back if the relay refuses. */
  const setFavourite = async (id, on) => {
    const s = S.sessions.find((x) => x.id === id)
    const name = s ? s.name : ''
    const prior = (S.favourites ?? []).slice()
    S.favourites = on
      ? [...prior.filter((f) => f.name !== name), { name, color: s?.color || '' }].sort((a, b) => (a.name < b.name ? -1 : 1))
      : prior.filter((f) => f.name !== name)
    if (S.pinned === id) renderColor(id)
    const r = await post('/api/session/favourite', { id, favourite: on })
    if (!r || r.error) {
      toast((r && r.error) || 'could not set favourite', { kind: 'warn' })
      S.favourites = prior
      if (S.pinned === id) renderColor(id)
    }
  }

  /** Rebuilt on every call rather than kept as a stable container (unlike
   *  #d-last/#d-todos): nothing here needs a partial SSE repaint mid-drawer,
   *  so the plain rebuild openDrawer already does for most sections is enough. */
  const renderColor = (id) => {
    const box = $('d-color')
    if (!box) return
    const s = S.sessions.find((x) => x.id === id)
    box.textContent = ''
    if (!s) return

    const row = el('div', 'cswatches')
    for (const hex of CARD_PRESETS) {
      const b = el('button', 'swatch')
      b.type = 'button'
      b.style.setProperty('--sw', hex)
      b.setAttribute('aria-label', hex)
      b.setAttribute('aria-pressed', String((s.color || '') === hex))
      b.onclick = () => setCardColor(id, hex)
      row.appendChild(b)
    }
    box.appendChild(row)

    const pickrow = el('div', 'cpickrow')
    const input = el('input')
    input.type = 'color'
    input.value = /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : '#6fc3df'
    input.title = 'custom colour'
    input.oninput = () => setCardColor(id, input.value)
    pickrow.appendChild(input)

    const clear = el('button', 'btn no', 'clear')
    clear.type = 'button'
    clear.disabled = !s.color
    clear.onclick = () => setCardColor(id, '')
    pickrow.appendChild(clear)
    box.appendChild(pickrow)

    // Beside the colour, because they answer the same question: this is one I
    // keep coming back to. A favourite is what the command bar's deck offers
    // first.
    const favrow = el('div', 'cfavrow')
    const star = el('button', 'btn cfav', isFavourite(s.name) ? '★ favourite' : '☆ favourite')
    star.type = 'button'
    star.setAttribute('aria-pressed', String(isFavourite(s.name)))
    star.title = 'A favourite is offered on the command bar’s quick-access deck, held under option.'
    star.onclick = () => void setFavourite(id, !isFavourite(s.name))
    favrow.appendChild(star)
    box.appendChild(favrow)
  }

  const openDrawer = (id) => {
    const s = S.sessions.find((x) => x.id === id); if (!s) return
    S.focus = id
    S.pinned = id
    // a pinned card reveals the per-session narration underneath the
    // blurb, the same as hovering the panel does (app.css's .orb-pinned rules).
    MCX.toggle(document.querySelector('.orbpanel'), 'orb-pinned', true)
    rescope()
    const st = s.stats || {}
    // openDrawer re-runs on every payload, so a rename left half-typed would
    // otherwise survive a switch to a different card and commit against the
    // wrong session. Only a change of session cancels it; a refresh of the same
    // one leaves the field alone, or typing a name would be impossible.
    if (S.renaming !== id) { stopRenaming(); S.renaming = null }
    $('d-title').textContent = s.name || s.repo || id.slice(0, 12)
    const b = $('d-body'); b.textContent = ''
    const asking = needsOf(s)
    if (asking) {
      const box = el('div', 'needbox')
      box.appendChild(el('div', 'needhead', '\u25cf waiting on you'))
      box.appendChild(el('div', 'needwhat', asking))
      box.appendChild(el('div', 'needsrc', s.waiting ? 'parked at a prompt' : 'asked at the end of its last turn'))
      b.appendChild(box)
    }

    // A colour for this card, so it is findable at a glance -- above Last
    // message: it is the thing to reach for before reading anything else.
    b.appendChild(el('div', 'sect', 'Card colour'))
    const colorBox = el('div'); colorBox.id = 'd-color'
    b.appendChild(colorBox)
    renderColor(id)

    // What it last said, and when. Given its own stable container (`d-last`)
    // rather than built inline here, so `refreshPinnedLastMessage` (SSE handlers,
    // below) can repaint just this section while the drawer stays open, instead
    // of requiring a close/reopen to see a new answer -- see `renderLastMessage`.
    b.appendChild(el('div', 'sect', 'Last message'))
    const lastBox = el('div'); lastBox.id = 'd-last'
    b.appendChild(lastBox)
    renderLastMessage(s)

    const dl = el('dl', 'kv')
    const kv = (k, v) => { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, String(v ?? '—'))) }
    kv('session', s.id); kv('agent name', s.agentName || '—'); kv('cwd', s.cwd); kv('repo', s.repo || '—')
    kv('branch', s.branch || '—'); kv('model', s.model); kv('pid', s.pid); kv('uptime', ago(s.startedAt))
    kv('context', compact(st.ctx || 0) + ' / ' + compact(st.ctxLimit || 200000))
    kv('spend', money(st.spend)); kv('tool calls', st.tools || 0); kv('guardrails', st.guardrails || 0)
    b.appendChild(dl)

    b.appendChild(el('div', 'sect', 'Subagents'))
    if (s.agents?.length) {
      for (const a of s.agents) {
        const r = el('div', 'ev ' + (a.status === 'running' ? 'agent' : 'ok'))
        const bd = el('div', 'body')
        bd.appendChild(el('div', 'title', a.description || a.type))
        bd.appendChild(el('div', 'detail', a.type + ' · ' + a.status))
        r.appendChild(bd)
        const kill = el('button', 'btn no', 'kill'); kill.style.alignSelf = 'center'
        kill.onclick = () => { post('/api/command', { targetId: s.id, verb: 'kill-agent', payload: { agentId: a.id } }); toast('kill sent') }
        r.appendChild(kill)
        b.appendChild(r)
      }
    } else b.appendChild(el('div', 'empty', 'No subagents.'))

    // Built as stable containers (see renderTodos, above): the toggle repaints
    // just this section, without the scroll-resetting, rename-cancelling cost
    // of a full openDrawer re-run.
    const todosHead = el('div', 'secthead'); todosHead.id = 'd-todos-head'
    b.appendChild(todosHead)
    const todosFlag = el('div', 'taskflag'); todosFlag.id = 'd-todos-flag'
    b.appendChild(todosFlag)
    const todosNote = el('div', 'tdnote'); todosNote.id = 'd-todos-note'
    b.appendChild(todosNote)
    const todosList = el('div'); todosList.id = 'd-todos-list'
    b.appendChild(todosList)
    renderTodos(id)

    b.appendChild(el('div', 'sect', 'Recent activity'))
    const mine = S.events.filter((e) => e.sessionId === id).slice(-18).reverse()
    if (mine.length) for (const e of mine) {
      const r = el('div', 'ev ' + (e.status === 'deny' ? 'deny' : 'ok'))
      r.appendChild(el('div', 'ts num', clockOf(e.t)))
      const bd = el('div', 'body'); bd.appendChild(el('div', 'title', e.label || e.kind))
      if (e.detail) bd.appendChild(el('div', 'detail', e.detail))
      r.appendChild(bd); b.appendChild(r)
    } else b.appendChild(el('div', 'empty', 'Nothing recorded.'))

    b.appendChild(el('div', 'sect', 'Links'))
    const mylinks = S.links.filter((l) => l.from === id || l.to === id)
    if (mylinks.length) for (const l of mylinks) {
      const r = el('div', 'ev ok')
      const bd = el('div', 'body')
      bd.appendChild(el('div', 'title', (l.from === id ? '→ ' : '← ') + nameOf(l.from === id ? l.to : l.from)))
      r.appendChild(bd)
      const cut = el('button', 'btn no', 'unlink')
      cut.onclick = () => { post('/api/unlink', { id: l.id }); toast('unlinked') }
      r.appendChild(cut); b.appendChild(r)
    } else b.appendChild(el('div', 'empty', 'No channels open. Drag this card onto another.'))

    // This session's stashed prompts. A stable container like the TODOs and
    // Last message sections above, so a payload repaint can refresh just this
    // list without the scroll-resetting, rename-cancelling cost of a full
    // re-open.
    b.appendChild(el('div', 'sect', 'Pasteboard'))
    const pbBox = el('div'); pbBox.id = 'd-pasteboard'
    b.appendChild(pbBox)
    const pbEmpty = el('div', 'empty', 'Nothing stashed here. Type ,, in front of a prompt in this session.')
    pbEmpty.id = 'd-pb-empty'
    b.appendChild(pbEmpty)
    MCK.renderDrawer(id)

    // This session's topic chain, read-only. A stable container like the
    // sections above, so a payload repaint refreshes just this list without the
    // scroll-resetting, rename-cancelling cost of a full re-open.
    b.appendChild(el('div', 'sect', 'Topic chain'))
    const chBox = el('div'); chBox.id = 'd-chain'
    b.appendChild(chBox)
    const chEmpty = el('div', 'empty', 'No blocks yet. One appears as soon as this session finishes a turn.')
    chEmpty.id = 'd-chain-empty'
    b.appendChild(chEmpty)
    MCTC.renderDrawer(id)

    // --- jump to this session's terminal ---------------------------------------
    b.appendChild(el('div', 'sect', 'Terminal'))
    b.appendChild(renderJump(s))

    // Its own stable container, like the TODOs and Last message sections above:
    // arming has to survive the payload repaints that re-run openDrawer, or the
    // button would disarm itself two seconds after being armed.
    b.appendChild(el('div', 'sect', 'Close'))
    const killBox = el('div'); killBox.id = 'd-kill'
    b.appendChild(killBox)
    renderKill(id)

    $('drawer').classList.add('open')
    renderCards()
  }
  // --- jumping to a session's terminal -----------------------------------------
  /** The four cases, by the name the relay put on the payload. A relay that
   *  predates the field sends nothing, and the button then reads "jump to
   *  terminal" and lets the relay answer -- a neutral label is the right
   *  degradation, where guessing a case would be a confident wrong one
   *  A client reading a missing payload field fails SILENTLY. */
  const JUMP = {
    tmux: { label: 'jump to terminal', detail: 'switches the tmux client and raises the terminal' },
    background: { label: 'attach', detail: 'opens a tmux window and attaches to this background session' },
    resume: { label: 'resume', detail: 'the process has exited; opens a tmux window and resumes it' },
    outside: { label: 'outside tmux', detail: 'live in a terminal outside tmux — nothing can raise it without a macOS permission prompt' },
  }
  const renderJump = (s) => {
    const c = JUMP[s.jump] || JUMP.tmux
    const row = el('div', 'ev' + (s.jump === 'outside' ? ' deny' : ''))
    const bd = el('div', 'body')
    bd.appendChild(el('div', 'title', c.label))
    bd.appendChild(el('div', 'detail', c.detail))
    row.appendChild(bd)
    const btn = el('button', 'btn', c.label)
    btn.disabled = s.jump === 'outside'
    btn.onclick = async () => {
      const out = await post('/api/jump', { id: s.id })
      if (out && out.ok) {
        toast(out.case === 'tmux' ? 'jumped' : `opened ${out.window || 'a tmux window'}`)
        if (out.note) toast(out.note, { ms: 5000, kind: 'warn' })
      } else if (out && out.case === 'outside') {
        toast(`outside tmux${out.tty ? ' on ' + out.tty : ''} — run: ${out.command}`, { ms: 8000, kind: 'warn' })
      } else {
        toast((out && out.error) || 'could not jump', { ms: 5000, kind: 'warn' })
      }
    }
    row.appendChild(btn)
    return row
  }

  // --- closing a session -------------------------------------------------------
  /** Two steps, and the second one expires. The pane-v2 spec's armed-confirmation
   *  idiom in browser form: the first click arms, the second within ARM_MS does
   *  it, and anything else -- five seconds passing, opening another drawer --
   *  disarms. A confirm() dialog would have done the same job and blocked the
   *  whole board, which on a page carrying a live SSE stream is worse than the
   *  problem. */
  const KILL_ARM_MS = 5000
  let killArmed = null      // { id, until, timer }
  const disarmKill = () => {
    if (killArmed?.timer) clearTimeout(killArmed.timer)
    killArmed = null
  }
  /** What closing this session would actually do. Mirrors canvas.mjs's killPlan,
   *  and deliberately says WHICH mechanism: "stop" and "SIGTERM" are different
   *  promises and the button should not pretend they are one. */
  const killModeOf = (s) => {
    if (s.kind === 'background' && s.shortId) return { can: true, what: 'claude stop ' + s.shortId }
    if (Number(s.pid) > 1) return { can: true, what: 'SIGTERM to pid ' + s.pid }
    return { can: false, what: 'no pid registered, and not a background agent' }
  }
  const renderKill = (id) => {
    const box = $('d-kill')
    if (!box) return
    const s = S.sessions.find((x) => x.id === id)
    box.textContent = ''
    if (!s) return
    const mode = killModeOf(s)
    const row = el('div', 'ev')
    const bd = el('div', 'body')
    bd.appendChild(el('div', 'title', mode.can ? 'End this session' : 'Cannot end this session'))
    bd.appendChild(el('div', 'detail', mode.what))
    row.appendChild(bd)
    if (mode.can) {
      const armed = killArmed && killArmed.id === id && Date.now() < killArmed.until
      const btn = el('button', 'btn no', armed ? 'click again to confirm' : 'close session')
      btn.onclick = async () => {
        if (!(killArmed && killArmed.id === id && Date.now() < killArmed.until)) {
          disarmKill()
          killArmed = { id, until: Date.now() + KILL_ARM_MS, timer: setTimeout(() => { disarmKill(); renderKill(id) }, KILL_ARM_MS) }
          renderKill(id)
          return
        }
        disarmKill()
        const out = await post('/api/session/kill', { id })
        if (out && out.ok) { toast('session closed'); closeDrawer() }
        else toast((out && out.error) || 'could not close the session')
      }
      row.appendChild(btn)
    }
    box.appendChild(row)
  }

  const closeDrawer = () => {
    disarmKill()
    $('drawer').classList.remove('open')
    S.pinned = null
    MCX.toggle(document.querySelector('.orbpanel'), 'orb-pinned', false)
    rescope()
  }

  // --- the reply field ---------------------------------------------------------
  /** Send what is typed to the pinned session, as a prompt.
   *
   *  `S.pinned` and not `S.focus`: focus follows the pointer across the board, so
   *  addressing focus would send the reply to whichever card the mouse drifted
   *  over between typing and hitting send. The pin is the session whose drawer is
   *  open, which is the one the field is visibly attached to.
   *
   *  The toast says QUEUED, never "sent". `/api/command` returns once the verb is
   *  on the session's queue; the session collects it on its next poll and only
   *  then does `$.prompt.submit` run. Reporting "sent" would be a claim this code
   *  cannot make: the relay answers on enqueue, not on delivery. */
  const sendReply = async () => {
    const box = $('d-replytext')
    const text = box.value.trim()
    const id = S.pinned
    if (!text || !id) return
    // Cleared BEFORE the await, so a second Enter on a slow relay cannot enqueue
    // the same reply twice; restored on failure, because losing what somebody
    // typed is worse than a duplicate they can see and delete.
    box.value = ''
    const r = await post('/api/command', { targetId: id, verb: 'prompt', payload: { text } })
    if (r.error) { box.value = text; toast(r.error, { kind: 'warn' }); return }
    toast('queued for ' + nameOf(id))
  }
  // --- rename ------------------------------------------------------------------
  /** The drawer title becomes a field, and back again.
   *
   *  Nothing here writes the name: it posts, and the name arrives the long way
   *  round -- the relay queues the verb, the session runs Claude Code's own
   *  /rename on its next poll, and its next /api/stats push carries the new name
   *  onto the payload, about a second later. So the title is never assigned
   *  locally even for a moment. A title that changed instantly and then reverted
   *  because /rename refused the name would be a lie the board told itself. */
  const stopRenaming = () => {
    S.renaming = null
    MCX.show($('d-titleedit'), false)
    MCX.show($('d-renamehint'), false)
    MCX.show($('d-title'), true)
  }
  const startRenaming = () => {
    const s = S.sessions.find((x) => x.id === S.pinned)
    if (!s) return
    const box = $('d-titleedit')
    S.renaming = s.id
    box.value = s.name || ''
    MCX.show($('d-title'), false)
    MCX.show(box, true)
    MCX.show($('d-renamehint'), true)
    box.focus()
    box.select()
  }
  const commitRename = async () => {
    const box = $('d-titleedit')
    const name = box.value.trim()
    const id = S.pinned
    stopRenaming()
    if (!id || !name) return
    const r = await post('/api/rename', { id, name })
    toast(r.error ? 'rename refused: ' + r.error : 'rename queued', r.error ? { kind: 'warn' } : undefined)
  }

  /** Escape's innermost branch, asked by app.js's key router rather than
   *  answered here: a half-typed reply is the innermost thing on the page, so
   *  Escape steps out of the field and leaves the drawer open. Returns whether
   *  it handled the key. */
  const escapeFromReply = () => {
    const box = $('d-replytext')
    if (document.activeElement !== box) return false
    box.blur()
    return true
  }

  /** The static markup's own handlers. Bound once, from attach(), never at
   *  evaluation time -- `$` does not exist until app.js has run. */
  const wire = () => {
    $('d-close').onclick = closeDrawer

    $('d-rename').onclick = () => {
      if ($('d-titleedit').classList.contains('gone')) startRenaming()
      else void commitRename()
    }

    $('d-titleedit').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); void commitRename() }
      // Handled here rather than in the drawer's Escape listener so it can stop
      // the event: cancelling the rename must not also close the drawer.
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); stopRenaming() }
    })

    $('d-reply').addEventListener('submit', (ev) => { ev.preventDefault(); void sendReply() })
    $('d-replytext').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); void sendReply() }
    })
  }

  const attach = (deps) => {
    S = deps.S; $ = deps.$; el = deps.el; post = deps.post; toast = deps.toast
    ago = deps.ago; compact = deps.compact; money = deps.money
    clockOf = deps.clockOf; nameOf = deps.nameOf; needsOf = deps.needsOf
    rescope = deps.rescope; renderCards = deps.renderCards
    wire()
  }

  return {
    attach,
    open: openDrawer,
    close: closeDrawer,
    refreshLastMessage: refreshPinnedLastMessage,
    /** Repaint just the pasteboard section of an open drawer. Called from the
     *  `pasteboard` SSE handler, which must not re-run `open()`. */
    refreshPasteboard: () => { if (S.pinned) MCK.renderDrawer(S.pinned) },
    /** Repaint just the topic chain section of an open drawer. chain.js
     *  already guards on S.pinned itself (repaint()), so this exists only so
     *  a caller outside that file has the same one-line shape as
     *  refreshPasteboard beside it. */
    refreshChain: () => { if (S.pinned) MCTC.renderDrawer(S.pinned) },
    escapeFromReply,
  }
})()
