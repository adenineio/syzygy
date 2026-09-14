/* The session drawer's Topic chain section: read-only, one row per block.
 *
 * A classic script exposing one global, MCTC, attached by app.js the way
 * MCF/MCK/MCN are. It registers its OWN stream handlers -- the `chains`
 * snapshot field and the live `chain` event -- so app.js gains one line,
 * which is the whole point of the MCE registry.
 *
 * MCX-reconciled and keyed by block id: NEVER assign node.className here,
 * and the branch-indent spacer and the `by` tag are both built once and
 * hidden with MCX.show.
 *
 * Nothing runs at evaluation time: no DOM, no fetch, no MCE registration
 * until attach(). `$` and `el` are the injected names, deliberately
 * shadowing app.js's own, the way drawer.js does it.
 *
 * Read-only end to end: no POST, no arm, no delete anywhere in this file.
 * The editing surface for a chain is the terminal pane. */
'use strict'

const MCTC = (() => {
  let S, $, el, post, toast, ago

  // The state a full-chain fetch is currently in for one session, keyed by
  // session id. `rev` is the compact chain's own rev at the moment the fetch
  // was started -- a fetch answers the question "what does the chain look
  // like as of this rev", so a later rev invalidates it rather than reusing
  // a stale answer under a fresh row.
  const detail = new Map()

  // Which blocks are expanded right now, keyed 'sessionId/blockId'. Survives
  // a repaint -- the point of keeping it outside the reconciled row's own
  // data -- and is never pruned: a stale entry for a block that no longer
  // exists costs one Set slot and nothing else.
  const expanded = new Set()
  const expandKey = (sessionId, blockId) => sessionId + '/' + blockId

  const DOT = { open: '●', closed: '○' } // ● ● open, ○ ○ closed -- 'merged' is never drawn

  /** The rows this session's drawer actually draws: every block but a merged
   *  one, which stopped being a subject of its own the moment it merged into
   *  its neighbour and has nothing left to show. */
  const liveBlocks = (compact) => (compact?.blocks || []).filter((b) => b && b.state !== 'merged')

  /** Fetches the one session's full chain, memoised per session per `rev` of
   *  its compact chain -- a later rev means a later fetch, never the same
   *  promise reused under a fresh row. Every failure (404, non-2xx, bad
   *  JSON) lands on the SAME entry shape as success, `error: true`, so the
   *  render side never has to distinguish "still loading" from "thrown" --
   *  there is no throw, ever, out of this function. */
  const ensureDetail = (sessionId, rev) => {
    const cur = detail.get(sessionId)
    if (cur && cur.rev === rev) return cur
    const entry = { rev, loading: true, chain: null, error: false }
    detail.set(sessionId, entry)
    fetch('/api/chain/' + encodeURIComponent(sessionId))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))
      .then((d) => {
        if (detail.get(sessionId) !== entry) return // superseded by a newer rev
        if (!d || !d.chain) { entry.error = true } else { entry.chain = d.chain }
        entry.loading = false
        repaint()
      })
      .catch(() => {
        if (detail.get(sessionId) !== entry) return
        entry.error = true
        entry.loading = false
        repaint()
      })
    return entry
  }

  const toggleBlock = (sessionId, blockId, rev) => {
    const k = expandKey(sessionId, blockId)
    if (expanded.has(k)) expanded.delete(k)
    else { expanded.add(k); ensureDetail(sessionId, rev) }
    renderDrawer(sessionId)
  }

  /** The expanded body under one row: the block's summary, then its turns --
   *  a prompt's head as it was said, and an answer's head as it ENDED (the
   *  store keeps the last characters of an answer, not the first, so it is
   *  labelled "answer ended" rather than read as the opening line). Rebuilt
   *  plainly on every call, the same way drawer.js's renderTodos rebuilds a
   *  row's own body inside a keyed reconcile -- nothing here needs its own
   *  identity preserved across a repaint. */
  const renderBody = (bodyEl, sessionId, blockId, rev, isOpen) => {
    MCX.show(bodyEl, isOpen)
    bodyEl.textContent = ''
    if (!isOpen) return
    const entry = detail.get(sessionId)
    if (!entry || entry.rev !== rev || entry.loading) {
      bodyEl.appendChild(el('div', 'chnote', 'reading the full chain…'))
      return
    }
    if (entry.error || !entry.chain) {
      bodyEl.appendChild(el('div', 'chnote', 'the summary could not be read'))
      return
    }
    const full = (entry.chain.blocks || []).find((b) => b.id === blockId)
    if (!full) {
      bodyEl.appendChild(el('div', 'chnote', 'this block is no longer in the chain'))
      return
    }
    if (full.summary) bodyEl.appendChild(el('div', 'chsummary', full.summary))
    const turns = entry.chain.turns || {}
    const ids = Array.isArray(full.turns) ? full.turns : []
    if (!ids.length && !full.summary) bodyEl.appendChild(el('div', 'chnote', 'nothing recorded for this block yet'))
    for (const id of ids) {
      const t = turns[id]
      if (!t) continue
      const row = el('div', 'chturn')
      row.appendChild(el('div', 'chturnline', 'said: ' + (t.promptHead || '')))
      row.appendChild(el('div', 'chturnline', 'answer ended: …' + (t.answerHead || '')))
      bodyEl.appendChild(row)
    }
  }

  /** A fresh spec per render, closing over the session id, so a click and the
   *  expanded body can reach it without threading extra args through
   *  MCX.reconcile -- the same reason peers.js's makePeerRowSpec/
   *  makeRosterCardSpec are built fresh each time. */
  const rowSpec = (sessionId) => ({
    key: (d) => d.block.id,
    create: () => {
      const row = el('div', 'chrow')
      const head = el('div', 'chhead')
      head.appendChild(el('span', 'chindent'))
      head.appendChild(el('span', 'chdot'))
      head.appendChild(el('span', 'chtitle'))
      head.appendChild(el('span', 'chcount'))
      head.appendChild(el('span', 'chby'))
      row.appendChild(head)
      row.appendChild(el('div', 'chbody'))
      return row
    },
    update: (row, d) => {
      const b = d.block
      const k = expandKey(sessionId, b.id)
      const isOpen = expanded.has(k)
      MCX.toggle(row, 'chopen', isOpen)
      MCX.show(row.querySelector('.chindent'), d.indent)
      const dot = row.querySelector('.chdot')
      MCX.setText(dot, DOT[b.state] || DOT.open)
      MCX.setAttr(dot, 'data-state', b.state)
      MCX.setText(row.querySelector('.chtitle'), b.title || 'untitled')
      MCX.setText(row.querySelector('.chcount'), String(b.turnCount || 0) + (b.turnCount === 1 ? ' turn' : ' turns'))
      const byEl = row.querySelector('.chby')
      MCX.setText(byEl, 'by ' + b.by)
      // The heuristic boundary rule is the default and silent case; a `by`
      // tag is worth a glance only when a model or a human actually retitled
      // or moved something.
      MCX.show(byEl, b.by !== 'heuristic')
      row.querySelector('.chhead').onclick = () => toggleBlock(sessionId, b.id, d.rev)
      renderBody(row.querySelector('.chbody'), sessionId, b.id, d.rev, isOpen)
    },
  })

  /** Renders session `id`'s Topic chain section into the drawer's stable
   *  `#d-chain` container -- called from drawer.js's openDrawer (once, on
   *  open) and from repaint() below (on every payload while that drawer
   *  stays open), never on a full re-open. */
  const renderDrawer = (id) => {
    const host = $('d-chain')
    const emptyEl = $('d-chain-empty')
    if (!host || !emptyEl) return
    const compact = (S.chains || {})[id]
    const blocks = liveBlocks(compact)
    MCX.show(emptyEl, blocks.length === 0)
    if (!blocks.length) { MCX.reconcile(host, [], { key: (d) => d.block.id }); return }
    // A block is indented one step when it branches from something other than
    // the row directly above it -- a block whose parent IS the previous
    // drawn block is a plain continuation and sits flush, exactly like the
    // parent it follows.
    let prevId = null
    const rows = blocks.map((b) => {
      const indent = !!(b.parent && b.parent !== prevId)
      prevId = b.id
      return { block: b, indent, rev: compact.rev }
    })
    MCX.reconcile(host, rows, rowSpec(id))
  }

  /** Repaints only while the drawer is actually open on a session -- the
   *  same guard refreshPasteboard uses -- so a payload for a session nobody
   *  is looking at costs nothing. */
  const repaint = () => { if (S.pinned) renderDrawer(S.pinned) }

  const attach = (deps) => {
    ({ S, $, el, post, toast, ago } = deps)
    // Its own registrations, in its own file: the snapshot field and the live
    // event. A relay predating the field sends no `chains` key at all, and
    // onField's `name in d` guard means the section simply stays on its empty
    // placeholder -- never a throw, which is why S.chains starts as {}.
    MCE.onField('chains', (v) => { S.chains = v || {}; repaint() })
    MCE.on('chain', (d) => {
      if (!d || !d.sessionId) return
      S.chains = Object.assign({}, S.chains, { [d.sessionId]: d.chain })
      repaint()
    })
  }

  return { attach, renderDrawer }
})()
