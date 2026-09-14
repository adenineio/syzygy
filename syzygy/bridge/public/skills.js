/* Syzygy — the Dispatch tab's Proposed skills section. A classic script,
   global MCSQ, attached by app.js the way MCF/MCN are. It registers its OWN
   stream handlers, so app.js gains one line.

   MCX-reconciled and keyed by proposal id: NEVER assign node.className here,
   and optional chips are built once and hidden with MCX.show.

   Nothing runs at evaluation time: no DOM, no localStorage, no MCE until
   attach(). The skills-queue harness evaluates this file in an empty
   node:vm context to hold its restated mark cycle to the store's own. */
'use strict'

const MCSQ = (() => {
  let S, $, el, post, toast, ago

  // The mark cycle skills-queue.mjs owns: '' -> good -> near -> potential ->
  // '', both ways. Restated here for a browser that cannot import an ES
  // module; the harness asserts the two agree. The pane never computes the
  // next mark for a real click -- every mark button POSTs {cycle:true} or
  // {cycle:'back'} and waits for the relay's answer, so two open panes can
  // never race on the order. These exist so the restatement itself is
  // checked, not so the pane can shortcut a POST.
  const MARKS = ['good', 'near', 'potential']
  const RING = ['', ...MARKS]
  const ringIndex = (mark) => { const i = RING.indexOf(mark); return i < 0 ? 0 : i }
  const nextMark = (mark) => RING[(ringIndex(mark) + 1) % RING.length]
  const prevMark = (mark) => RING[(ringIndex(mark) - 1 + RING.length) % RING.length]

  const KIND_LABEL = { skill: 'skill', shape: 'shape', kickoff: 'kickoff', 'claude-md': 'claude.md' }
  const KINDS = Object.keys(KIND_LABEL)

  // Which cards show idea/methodology/evidence. A module-level Set of ids, so
  // a reconcile -- which throws every row away and rebuilds it from the
  // payload -- never loses what was open.
  const expanded = new Set()

  // Review mode and the selection are module-level for the same reason: they
  // must survive a render triggered by someone else's SSE frame arriving
  // mid-session.
  let reviewMode = false
  let selectedId = null
  // What render() last put on screen, in the order shown -- j/k and the
  // review header read this rather than re-deriving it from S every
  // keystroke.
  let lastRows = []

  // Shift/Alt held right now, anywhere on the page -- drives the prep
  // buttons' label only; the actual gesture is read off the triggering
  // click/keydown event itself, never off these flags (peers.js's rule).
  let shiftHeld = false, altHeld = false
  const prepLabel = () => (altHeld ? 'Prep + queue' : shiftHeld ? 'Prep + rate good' : 'Prep')

  // This pane's own in-flight /api/skills/pass request. The route holds its
  // response open for the whole pass, so this is what disables the button and
  // relabels it -- S.skillsQueue.pass is only ever refreshed by a full
  // snapshot (see the onField/on registrations below), never by this POST's
  // own broadcast, so nothing there would move while we wait anyway.
  let passInFlight = false

  // The relay's snapshot budget can shed every proposal from a frame, and
  // S.shed then names `proposals`. The panel says how many it is missing and
  // loads them on demand: click loads this queue, shift-click every shed
  // section (MCBG.loadAll), option-click pins the section so it loads by
  // itself. A copy loaded that way lives here and never in S, so a later
  // snapshot cannot overwrite it and flicker the list empty; a snapshot that
  // no longer sheds the section drops it and S is drawn again.
  const SECTION = 'proposals'
  let bg = null                 // MCBG, when the chip's script is on the page
  let loaded = null             // the full queue from GET /api/skills, or null
  let loading = false
  // A live `skillsQueue` event arrived since the last snapshot: S holds the
  // newest proposals again, so there is nothing to offer to load.
  let liveSince = false

  const shedRow = () => (S && Array.isArray(S.shed) ? S.shed : []).find((r) => r && r.section === SECTION) || null
  const proposalsNow = () => loaded ?? ((S.skillsQueue && S.skillsQueue.proposals) || [])
  const moreProposals = (n) => `${n} more proposal${n === 1 ? '' : 's'}`

  /** The full queue, into this module. Kept only while the frame still sheds
   *  the section; a failure says so and leaves the line where it was. */
  const load = async () => {
    if (loading) return
    loading = true
    render()
    try {
      const r = await fetch('/api/skills', { cache: 'no-store' })
      const d = await r.json()
      if (!r.ok || !Array.isArray(d && d.proposals)) throw new Error((d && d.error) || 'status ' + r.status)
      if (shedRow()) loaded = d.proposals
    } catch (e) {
      toast('proposals did not load: ' + (e && e.message ? e.message : 'unreachable'), { kind: 'warn' })
    }
    loading = false
    render()
  }

  // The key layer's own hint, shown while focus is inside the panel, and the
  // panel's held-modifier bookkeeping.
  let hintFocused = false
  let panelEl = null

  const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

  const HINT = 'j/k move · 1 2 3 rate · 0 clear · enter expand · p prep · ⇧p prep + rate good · r review · esc clear selection'
  const REVIEW_HINT = 'review mode — 1 2 3 rates and moves to the next unrated · esc leaves review'

  // ------------------------------------------------------------- write-up

  const writeUpMarkdown = (p) => {
    const lines = [
      '# ' + p.title,
      '',
      (p.kind || 'unclassified') + ' · ' + (p.mark || 'unrated'),
      '',
      p.idea,
      '',
      '## Methodology',
      p.methodology,
    ]
    if (Array.isArray(p.evidence) && p.evidence.length) {
      lines.push('', '## Evidence')
      for (const e of p.evidence) lines.push('- ' + e)
    }
    return lines.join('\n')
  }

  // ------------------------------------------------------------------ rows

  const CHIP = {
    key: (c) => c.k,
    create: (c) => el('span', 'sqchip ' + c.cls),
    update: (node, c) => MCX.setText(node, c.text),
  }

  const doPrep = async (id, { shiftKey, altKey }) => {
    if (shiftKey) {
      const rm = await post('/api/skills/mark', { id, mark: 'good' })
      if (rm.error) { toast('mark: ' + rm.error, { kind: 'warn' }); return }
    }
    const project = $('d-project') ? $('d-project').value.trim() : ''
    const body = { id }
    if (project) body.project = project
    if (altKey) body.queue = true
    const r = await post('/api/skills/prep', body)
    if (r.error) { toast('prep: ' + r.error, { kind: 'warn' }); return }
    toast(altKey ? 'prepped and queued' : 'prepped into the dispatch queue')
  }

  const rate = async (id, mark) => {
    const r = await post('/api/skills/mark', { id, mark })
    if (r.error) { toast('mark: ' + r.error, { kind: 'warn' }); return }
    // Review mode's advance-after-rating falls out of render() itself: the
    // rated proposal drops out of the unrated list, so the stale-selection
    // check there seeds the next one. Nothing special happens here.
    render()
  }

  const ROW = {
    key: (p) => p.id,
    create: (p) => {
      const row = el('div', 'sqitem')

      const head = el('div', 'sqhead')
      head.appendChild(el('span', 'sqkind'))
      const markEl = el('span', 'sqmark chip')
      head.appendChild(markEl)
      head.appendChild(el('span', 'sqtitle'))
      head.appendChild(el('span', 'spacer'))
      head.appendChild(el('span', 'sqseen'))
      head.appendChild(el('span', 'sqago'))
      row.appendChild(head)

      const body = el('div', 'sqbody')
      body.appendChild(el('div', 'sqidea'))
      body.appendChild(el('div', 'sqmethod'))
      body.appendChild(el('div', 'sqchips'))
      row.appendChild(body)

      const actions = el('div', 'sqactions')
      const prep = el('button', 'btn go sqprep', 'Prep')
      prep.type = 'button'
      actions.appendChild(prep)
      row.appendChild(actions)

      // A click anywhere on the head expands the card, except the mark chip,
      // which owns its own click and stops it from bubbling here.
      head.addEventListener('click', (ev) => {
        if (ev.target.closest('.sqmark')) return
        if (expanded.has(p.id)) expanded.delete(p.id); else expanded.add(p.id)
        render()
      })

      markEl.addEventListener('click', (ev) => {
        ev.stopPropagation()
        void post('/api/skills/mark', { id: p.id, cycle: ev.altKey ? 'back' : true }).then((r) => {
          if (r.error) toast('mark: ' + r.error, { kind: 'warn' })
        })
      })

      prep.addEventListener('click', (ev) => {
        void doPrep(p.id, { shiftKey: ev.shiftKey, altKey: ev.altKey })
      })

      // Right-click copies the write-up as markdown rather than opening the
      // browser's own menu. There is no delete here, ever -- the store is
      // authoritative and nothing it holds is ever discarded.
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault()
        const cur = proposalsNow().find((x) => x.id === p.id)
        if (!cur) return
        navigator.clipboard?.writeText(writeUpMarkdown(cur))
        toast('copied the write-up')
      })

      return row
    },
    update: (row, p) => {
      const kindEl = row.querySelector('.sqkind')
      MCX.setText(kindEl, KIND_LABEL[p.kind] || 'unclassified')
      MCX.toggle(kindEl, 'unclassified', !p.kind)

      const markEl = row.querySelector('.sqmark')
      MCX.setText(markEl, p.mark || 'unrated')
      for (const m of MARKS) MCX.toggle(markEl, m, p.mark === m)
      MCX.toggle(markEl, 'unrated', !p.mark)

      MCX.setText(row.querySelector('.sqtitle'), p.title)
      const n = Array.isArray(p.seen) ? p.seen.length : 0
      MCX.setText(row.querySelector('.sqseen'), 'seen ' + n)
      MCX.setText(row.querySelector('.sqago'), ago(p.updatedAt))

      MCX.setAttr(row, 'data-selected', selectedId === p.id ? 'true' : null)

      const isExpanded = expanded.has(p.id)
      MCX.show(row.querySelector('.sqbody'), isExpanded)
      MCX.setText(row.querySelector('.sqidea'), p.idea)
      MCX.setText(row.querySelector('.sqmethod'), p.methodology)
      MCX.reconcile(row.querySelector('.sqchips'),
        (p.evidence || []).map((e, i) => ({ k: String(i) + ':' + e, cls: 'evidence', text: e })), CHIP)

      const prepBtn = row.querySelector('.sqprep')
      MCX.setAttr(prepBtn, 'data-prepped', p.requestId ? 'true' : null)
      MCX.setText(prepBtn, p.requestId ? 'Prepped' : prepLabel())
    },
  }

  // --------------------------------------------------------------- filters

  const readRows = (all) => {
    if (reviewMode) {
      const unrated = all.filter((p) => p.mark === '').sort((a, b) => a.createdAt - b.createdAt)
      if (unrated.length) return unrated
      // Nothing left to review: the mode ends on its own, same as Escape.
      reviewMode = false
    }
    const kindFilter = $('sq-kind').value
    const markFilter = $('sq-mark').value
    return all.filter((p) => (!kindFilter || p.kind === kindFilter) && (!markFilter || p.mark === markFilter))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  // ---------------------------------------------------------------- header

  const renderCount = (all) => {
    const node = $('c-skills')
    if (!node) return
    if (reviewMode) {
      const i = lastRows.findIndex((p) => p.id === selectedId)
      MCX.setText(node, 'review ' + (i < 0 ? 0 : i + 1) + '/' + lastRows.length)
    } else {
      MCX.setText(node, String(all.length))
    }
  }

  const renderReviewButton = () => {
    const btn = $('sq-review')
    if (!btn) return
    MCX.toggle(btn, 'on', reviewMode)
    MCX.setText(btn, reviewMode ? 'exit review' : 'review')
  }

  const renderHint = () => {
    const node = $('sq-hint')
    if (!node) return
    MCX.toggle(node, 'review', reviewMode)
    MCX.setText(node, reviewMode ? REVIEW_HINT : HINT)
    MCX.show(node, reviewMode || hintFocused)
  }

  // The pass button is never merely dead: a shut gate still explains itself,
  // on the gate line and on the button's own tip, the way findings.js's
  // sweep button does. S.skillsQueue.pass is a snapshot-only field -- this
  // route's own broadcast carries only `proposals` -- so it reflects what was
  // true when this pane last connected, not necessarily right now; the
  // in-flight guard below is what actually protects a click while the
  // request itself is open.
  const renderGate = () => {
    const btn = $('sq-pass')
    if (!btn) return
    const pass = (S.skillsQueue && S.skillsQueue.pass) || {}
    const reason = typeof pass.reason === 'string' ? pass.reason : ''
    const runningElsewhere = !passInFlight && !!pass.running

    btn.disabled = passInFlight
    MCX.setText(btn, passInFlight ? 'running…' : 'look for patterns')

    const gateText = passInFlight ? 'the pass is running now — this can take a few minutes'
      : runningElsewhere ? 'a pass is already running'
      : reason
    MCX.setText($('sq-gate'), gateText)
    MCX.show($('sq-gate'), !!gateText)

    btn.dataset.tip = passInFlight ? 'waiting on the reply'
      : runningElsewhere ? 'a pass started elsewhere is still running'
      : reason ? reason + '\n\noption-click runs it anyway'
      : 'Ask a budgeted turn what you keep repeating across sessions.'
  }

  // ---------------------------------------------------------------- render

  const render = () => {
    const list = $('sq-list')
    if (!list) return

    // A relay that predates the feature sends no `skillsQueue` key at all --
    // S.skillsQueue stays undefined forever on it, never {} -- so every
    // control is hidden and the list says plainly why.
    const predates = S.skillsQueue === undefined
    for (const id of ['sq-kind', 'sq-mark', 'sq-review', 'sq-pass']) MCX.show($(id), !predates)

    if (predates) {
      lastRows = []
      MCX.setText($('c-skills'), '0')
      MCX.show($('sq-gate'), false)
      MCX.show($('sq-hint'), false)
      MCX.show($('sq-shed'), false)
      MCX.reconcile(list, [], ROW)
      const empty = list.querySelector('.empty')
      MCX.setText(empty, 'this relay predates the proposals queue')
      MCX.show(empty, true)
      return
    }

    const shed = shedRow()
    if (!shed) loaded = null
    const all = proposalsNow()
    const rows = readRows(all)
    if (selectedId && !rows.some((p) => p.id === selectedId)) selectedId = null
    if (reviewMode && !selectedId && rows.length) selectedId = rows[0].id
    lastRows = rows

    MCX.reconcile(list, rows, ROW)
    // A shed queue is neither of the two empties below: the line says how many
    // the frame left out, in place of an empty state claiming there are none.
    const missing = !!shed && loaded === null && !liveSince
    const line = $('sq-shed')
    if (line) {
      const n = shed ? shed.dropped : 0
      const pin = bg ? bg.pinned(SECTION) : false
      MCX.setText(line, loading ? `loading ${moreProposals(n)}…` : `${moreProposals(n)} — open to load`)
      MCX.toggle(line, 'pinned', pin)
      MCX.setAttr(line, 'data-tip', 'Shed from this frame to keep it under budget\n'
        + 'click loads them · shift-click loads every shed section · option-click '
        + (pin ? 'stops loading them by themselves' : 'loads them by themselves from now on'))
      MCX.show(line, missing)
    }
    // Two different empties: an empty store, and a filter hiding a full one.
    // Saying "nothing proposed" for the second sends somebody looking for a
    // bug in the pass or the tool that never fired.
    const empty = list.querySelector('.empty')
    MCX.setText(empty, all.length
      ? `The filter matched none of ${all.length} proposal${all.length === 1 ? '' : 's'}.`
      : 'Nothing proposed yet.')
    MCX.show(empty, rows.length === 0 && !missing)

    renderCount(all)
    renderReviewButton()
    renderGate()
    renderHint()
  }

  // ------------------------------------------------------------- key layer

  const onPanelKeydown = (ev) => {
    if (S.skillsQueue === undefined) return
    if (ev.target && FORM_TAGS.has(ev.target.tagName)) return
    const key = ev.key

    if (key === 'j' || key === 'k') {
      ev.preventDefault(); ev.stopPropagation()
      if (!lastRows.length) return
      const i = lastRows.findIndex((p) => p.id === selectedId)
      if (key === 'j') selectedId = i < 0 ? lastRows[0].id : lastRows[Math.min(i + 1, lastRows.length - 1)].id
      else selectedId = i < 0 ? lastRows[lastRows.length - 1].id : lastRows[Math.max(i - 1, 0)].id
      render()
      return
    }
    if (key === '1' || key === '2' || key === '3') {
      // Digits, not letters -- and stopped here rather than left to bubble --
      // because app.js's own keydown maps 1-5 to a tab switch and treats only
      // a focused INPUT/TEXTAREA/SELECT as "typing". Without this, rating a
      // card would also switch the pane's tab.
      ev.preventDefault(); ev.stopPropagation()
      if (!selectedId) return
      void rate(selectedId, { '1': 'good', '2': 'near', '3': 'potential' }[key])
      return
    }
    if (key === '0') {
      ev.preventDefault(); ev.stopPropagation()
      if (!selectedId) return
      void rate(selectedId, '')
      return
    }
    if (key === 'Enter') {
      ev.preventDefault(); ev.stopPropagation()
      if (!selectedId) return
      if (expanded.has(selectedId)) expanded.delete(selectedId); else expanded.add(selectedId)
      render()
      return
    }
    if (key === 'p' || key === 'P') {
      ev.preventDefault(); ev.stopPropagation()
      if (!selectedId) return
      void doPrep(selectedId, { shiftKey: ev.shiftKey, altKey: false })
      return
    }
    if (key === 'r' || key === 'R') {
      ev.preventDefault(); ev.stopPropagation()
      reviewMode = !reviewMode
      selectedId = null
      render()
      return
    }
    if (key === 'Escape') {
      ev.preventDefault(); ev.stopPropagation()
      if (reviewMode) { reviewMode = false; selectedId = null; render(); return }
      selectedId = null
      render()
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()
      return
    }
  }

  const onPanelFocusIn = () => { hintFocused = true; renderHint() }
  const onPanelFocusOut = (ev) => { if (!panelEl.contains(ev.relatedTarget)) { hintFocused = false; renderHint() } }
  const onPanelClick = (ev) => {
    if (ev.target.closest('button, input, textarea, select, a')) return
    panelEl.focus()
  }

  // ------------------------------------------------------- held modifiers

  const renderPrepLabels = () => {
    const list = $('sq-list')
    if (!list) return
    const label = prepLabel()
    for (const row of list.children) {
      const btn = row.querySelector && row.querySelector('.sqprep')
      if (!btn || btn.dataset.prepped === 'true') continue
      MCX.setText(btn, label)
    }
  }
  const onWindowKeydown = (ev) => {
    if (ev.key === 'Shift') { shiftHeld = true; renderPrepLabels() }
    else if (ev.key === 'Alt') { altHeld = true; renderPrepLabels() }
  }
  const onWindowKeyup = (ev) => {
    if (ev.key === 'Shift') { shiftHeld = false; renderPrepLabels() }
    else if (ev.key === 'Alt') { altHeld = false; renderPrepLabels() }
  }
  const resetHeldModifiers = () => { shiftHeld = false; altHeld = false; renderPrepLabels() }

  // ------------------------------------------------------------------ attach

  const attach = (deps) => {
    ({ S, $, el, post, toast, ago } = deps)

    // Two fixed shapes, built once: the kind filter's four values and the
    // mark filter's three, appended after the "any ..." option already in
    // the markup.
    for (const k of KINDS) {
      const o = el('option', '', KIND_LABEL[k])
      o.value = k
      $('sq-kind').appendChild(o)
    }
    for (const m of MARKS) {
      const o = el('option', '', m)
      o.value = m
      $('sq-mark').appendChild(o)
    }

    $('sq-kind').onchange = $('sq-mark').onchange = () => render()
    $('sq-review').onclick = () => { reviewMode = !reviewMode; selectedId = null; render() }
    $('sq-pass').onclick = async (ev) => {
      if (passInFlight) return
      passInFlight = true
      renderGate()
      const r = await post('/api/skills/pass', { override: ev.altKey })
      passInFlight = false
      if (r.error) { toast('pass: ' + r.error, { kind: 'warn' }); renderGate(); return }
      toast(`pass filed ${r.filed} proposal${r.filed === 1 ? '' : 's'}`
        + (r.merged ? `, ${r.merged} merged` : '')
        + (r.rejected ? `, ${r.rejected} rejected` : ''))
      renderGate()
    }

    panelEl = $('skills-panel')
    if (panelEl) {
      panelEl.addEventListener('keydown', onPanelKeydown)
      panelEl.addEventListener('focusin', onPanelFocusIn)
      panelEl.addEventListener('focusout', onPanelFocusOut)
      panelEl.addEventListener('click', onPanelClick)
    }
    addEventListener('keydown', onWindowKeydown)
    addEventListener('keyup', onWindowKeyup)
    addEventListener('blur', resetHeldModifiers)
    document.addEventListener('visibilitychange', () => { if (document.hidden) resetHeldModifiers() })

    // Its own registrations, in its own file. The SSE event carries only
    // `proposals` -- merging keeps `pass` from being wiped out every time a
    // card is rated -- while the snapshot field (onField) is the one place
    // `pass` itself is ever refreshed.
    MCE.onField('skillsQueue', (v) => { S.skillsQueue = v; liveSince = false; render() })
    // A live event carries the store's newest proposals whatever the last
    // frame shed. A loaded copy is fetched again so a new mark or a new
    // proposal shows in it; with no loaded copy, S is the queue again.
    MCE.on('skillsQueue', (d) => {
      S.skillsQueue = { ...(S.skillsQueue ?? {}), proposals: d.proposals ?? [] }
      if (loaded !== null) void load(); else liveSince = true
      render()
    })
    bg = typeof MCBG === 'undefined' ? null : MCBG
    if (bg) bg.register(SECTION, load)
    const shedLine = $('sq-shed')
    if (shedLine) shedLine.onclick = (ev) => {
      if (ev.altKey) {
        const on = bg ? bg.togglePin(SECTION) : null
        toast(on === null ? 'this browser would not store the pin'
          : on ? 'proposals now load by themselves whenever a frame sheds them'
          : 'proposals no longer load by themselves')
        if (on) void load()
        render()
        return
      }
      if (ev.shiftKey && bg) { void bg.loadAll(); return }
      void load()
    }

    render()
  }

  return { attach, render, nextMark, prevMark }
})()
