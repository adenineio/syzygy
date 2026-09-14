/* Syzygy — the Telemetry tab's "Syzygy's own usage" panel: a table of the
 * platform's own model calls, built from the relay's `spend` digest, with
 * one GET per row's call list, opened on demand.
 *
 * A CLASSIC script, like peers.js/skills.js and unlike swarm.js — loaded
 * after stream.js and before app.js, its global (MCSP) referenced bare
 * everywhere, never window.MCSP. Nothing runs at evaluation time: no DOM, no
 * fetch, no MCE registration until attach(). `S`, `post`, `toast`, `el` and
 * `ago` are the injected names, shadowing app.js's own, the way
 * peers.js/skills.js do it. This script loads before app.js, so the token
 * for its own GET is read straight off `window.SZG_TOKEN` rather than
 * app.js's TOKEN constant.
 *
 * The table is small and rebuilt whole with document.createElement on every
 * render — no MCX.reconcile here. NEVER build a row from a record's text
 * with innerHTML; every value goes through textContent (via `el`, or a plain
 * node's own .textContent). No animation and no transition anywhere in
 * spend.css.
 *
 * KINDS and LABELS restate spend.mjs's own list, because a classic script
 * cannot import an ES module — the harness holds the two equal. */
'use strict'

const MCSP = (() => {
  const KINDS = Object.freeze(['chain', 'pattern', 'orchestrator', 'scoping', 'liaison', 'band', 'other'])
  const LABELS = {
    chain: 'chains refiner',
    pattern: 'pattern pass',
    orchestrator: 'orchestrator',
    scoping: 'scoping & fan-out',
    liaison: 'liaison',
    band: 'band',
    other: 'other',
  }

  const CAVEAT_BASE = "These are the CLI's own cost figures; your usage window is account-wide and cannot be attributed to any single call"
  const CAVEAT_NOT_COUNTED = '. Not counted: dispatched, canvas and night sessions, scoping conversations, the architecture sweep'

  const CALL_LIMIT = 50

  // -------------------------------------------------------- pure helpers

  /** Below a dollar, four decimal places: most of a row's cells are a
   *  handful of cents or less, and two decimals would round those to
   *  nothing. At a dollar and above, two decimals reads as money. */
  const fmtUsd = (usd) => {
    const n = Number(usd) || 0
    if (n === 0) return '$0'
    return n < 1 ? '$' + n.toFixed(4) : '$' + n.toFixed(2)
  }

  const fmtTok = (n) => {
    n = Number(n) || 0
    if (n < 1000) return String(Math.round(n))
    if (n < 1e6) return (n / 1e3).toFixed(1) + 'k'
    return (n / 1e6).toFixed(1) + 'M'
  }

  /** A window's per-kind cell, or undefined when that kind had no calls in
   *  the window — digestOf omits an empty kind's key rather than zeroing
   *  it, which is why every dash below reads "no calls" and never "$0". A
   *  band cell is always token estimates, never a dollar figure. */
  const cellText = (cell, kind) => {
    if (!cell) return '—'
    if (kind === 'band') return cell.calls + ' · ~' + fmtTok(cell.tokens) + ' tok'
    return cell.calls + ' · ' + fmtUsd(cell.usd)
  }

  const pad2 = (n) => String(n).padStart(2, '0')
  const clockOf = (t) => { const d = new Date(t); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) }
  const dateOf = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) }

  const sinceLabel = (since) => (since == null ? 'all time' : 'since ' + dateOf(since))

  /** The six named kinds in order, `other` only when the digest actually
   *  carries one, then the total row — whose cells are the windows
   *  themselves rather than one kind's slice of them. */
  const rowsOf = (d) => {
    const rows = KINDS.filter((k) => k !== 'other').map((k) => ({
      kind: k, label: LABELS[k], today: d.today.byKind[k], week: d.week.byKind[k], all: d.all.byKind[k],
    }))
    if (d.all.byKind.other) {
      rows.push({ kind: 'other', label: LABELS.other, today: d.today.byKind.other, week: d.week.byKind.other, all: d.all.byKind.other })
    }
    rows.push({ kind: 'total', label: 'total', today: d.today, week: d.week, all: d.all })
    return rows
  }

  const caveatOf = (d) => {
    let s = CAVEAT_BASE + CAVEAT_NOT_COUNTED
    if (d.unreported > 0) s += '; ' + d.unreported + ' call' + (d.unreported === 1 ? '' : 's') + ' ended with no figure'
    if (d.estimatedShare > 0) s += '; band rows are estimated tokens'
    if (d.skipped > 0) s += '; ' + d.skipped + ' unreadable ledger line' + (d.skipped === 1 ? '' : 's') + ' skipped'
    return s + '.'
  }

  const rowText = (row, since) =>
    row.label + ': today ' + cellText(row.today, row.kind) +
    '; 7-day ' + cellText(row.week, row.kind) +
    '; ' + sinceLabel(since) + ' ' + cellText(row.all, row.kind)

  /** One line in an open row's call list: local clock, where it ran (or the
   *  kind, when the site is blank), what it ran, what it cost (or that it
   *  printed no figure), the tokens it moved (with `~` when estimated), how
   *  long it took, and whether it errored. */
  const callText = (item) => {
    const site = item.site || item.kind
    const cost = item.usd == null ? 'no figure' : fmtUsd(item.usd)
    const u = item.usage || {}
    const tokens = (u.input || 0) + (u.output || 0) + (u.cacheCreate || 0) + (u.cacheRead || 0)
    const tok = (item.estimated ? '~' : '') + fmtTok(tokens) + ' tok'
    const parts = [clockOf(item.t), site, item.model || '', cost, tok]
    if (Number.isFinite(item.durationMs)) parts.push((item.durationMs / 1000).toFixed(1) + 's')
    let text = parts.filter(Boolean).join(' ')
    if (item.error) text += ' error'
    return text
  }

  // ------------------------------------------------------------------ state

  let S = null, post = null, toast = null, el = null, ago = null
  let predates = false
  let digest = null
  let selectedKind = null
  // kind -> { items, next, loading, error }. 'total' is never a key here:
  // it is not a real KINDS member, so opening it opens every real kind
  // instead of fetching under a kind the relay would refuse.
  const open = new Map()

  let panelEl = null

  // -------------------------------------------------------------- the GET

  const fetchCalls = (kind, before) => {
    const params = new URLSearchParams({ kind, limit: String(CALL_LIMIT) })
    if (before != null) params.set('before', String(before))
    return fetch('/api/spend?' + params.toString(), { headers: { 'x-mch-token': window.SZG_TOKEN } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))
  }

  const openKind = (kind) => {
    const state = { items: [], next: null, loading: true, error: false }
    open.set(kind, state)
    fetchCalls(kind).then((d) => {
      if (open.get(kind) !== state) return // closed, or reopened, before this landed
      state.items = Array.isArray(d.items) ? d.items : []
      state.next = d.next ?? null
      state.loading = false
      render()
    }).catch(() => {
      if (open.get(kind) !== state) return
      state.error = true
      state.loading = false
      render()
    })
  }

  const loadMore = (kind) => {
    const state = open.get(kind)
    if (!state || state.next == null || state.loading) return
    state.loading = true
    render()
    fetchCalls(kind, state.next).then((d) => {
      if (open.get(kind) !== state) return
      state.items = state.items.concat(Array.isArray(d.items) ? d.items : [])
      state.next = d.next ?? null
      state.loading = false
      render()
    }).catch(() => {
      if (open.get(kind) !== state) return
      state.error = true
      state.loading = false
      render()
    })
  }

  /** Shift-click (or Enter on the selected row). `total` isn't a real kind
   *  to fetch under, so toggling it opens every real kind instead — closing
   *  them all only when every one of them was already open. */
  const toggleKind = (kind) => {
    if (kind === 'total') {
      const kinds = rowsOf(digest).map((r) => r.kind).filter((k) => k !== 'total')
      const allOpen = kinds.every((k) => open.has(k))
      if (allOpen) { for (const k of kinds) open.delete(k) }
      else { for (const k of kinds) if (!open.has(k)) openKind(k) }
      render()
      return
    }
    if (open.has(kind)) { open.delete(kind); render(); return }
    openKind(kind)
    render()
  }

  const copyRow = (kind) => {
    const row = rowsOf(digest).find((r) => r.kind === kind)
    if (!row) return
    const text = rowText(row, digest.since)
    const done = () => toast('copied')
    const failed = () => toast('copy failed', { kind: 'error' })
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, failed)
    else failed()
  }

  // ------------------------------------------------------------ rendering

  const buildCallsRow = (row) => {
    const tr = document.createElement('tr')
    tr.className = 'spendcalls'
    const td = document.createElement('td')
    td.colSpan = 4
    const state = open.get(row.kind)
    if (state.error) {
      td.appendChild(el('div', 'spendcallline', 'could not load'))
    } else {
      for (const item of state.items) td.appendChild(el('div', 'spendcall', callText(item)))
      if (!state.loading && state.items.length === 0) td.appendChild(el('div', 'spendcallline', 'no calls'))
      if (state.next != null && !state.loading) {
        const more = el('button', 'btn spendmore', 'more')
        more.type = 'button'
        more.dataset.kind = row.kind
        td.appendChild(more)
      }
      if (state.loading) td.appendChild(el('div', 'spendcallline', 'loading…'))
    }
    tr.appendChild(td)
    return tr
  }

  const buildTable = () => {
    const table = document.createElement('table')

    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    for (const text of ['kind', 'today', '7-day', sinceLabel(digest.since)]) headRow.appendChild(el('th', '', text))
    thead.appendChild(headRow)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    for (const row of rowsOf(digest)) {
      const tr = document.createElement('tr')
      tr.dataset.kind = row.kind
      if (selectedKind === row.kind) tr.setAttribute('aria-selected', 'true')
      tr.appendChild(el('td', '', row.label))
      tr.appendChild(el('td', '', cellText(row.today, row.kind)))
      tr.appendChild(el('td', '', cellText(row.week, row.kind)))
      tr.appendChild(el('td', '', cellText(row.all, row.kind)))
      tbody.appendChild(tr)
      if (open.has(row.kind)) tbody.appendChild(buildCallsRow(row))
    }
    table.appendChild(tbody)
    return table
  }

  const render = () => {
    const host = document.getElementById('spend-table')
    const countEl = document.getElementById('c-spend')
    const caveatEl = document.getElementById('spend-caveat')
    if (!host) return

    if (predates) {
      host.textContent = ''
      host.appendChild(el('div', 'empty', 'this relay predates the spend ledger — restart it to see this'))
      if (countEl) countEl.textContent = '0'
      if (caveatEl) caveatEl.textContent = ''
      return
    }
    if (!digest) {
      host.textContent = ''
      host.appendChild(el('div', 'empty', 'Nothing recorded yet.'))
      if (countEl) countEl.textContent = '0'
      if (caveatEl) caveatEl.textContent = ''
      return
    }

    if (countEl) countEl.textContent = String(digest.all.calls)
    if (caveatEl) caveatEl.textContent = caveatOf(digest)

    host.textContent = ''
    host.appendChild(buildTable())
  }

  // -------------------------------------------------------------- clicks

  const onTableClick = (ev) => {
    const moreBtn = ev.target.closest('.spendmore')
    if (moreBtn) { loadMore(moreBtn.dataset.kind); return }
    const tr = ev.target.closest('tr[data-kind]')
    if (!tr) return
    const kind = tr.dataset.kind
    if (ev.altKey) { copyRow(kind); return }
    if (ev.shiftKey) { toggleKind(kind); return }
    selectedKind = kind
    render()
  }

  const onPanelClick = (ev) => {
    if (ev.target.closest('button, a')) return
    panelEl.focus()
  }

  // -------------------------------------------------------- the key layer

  const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

  const onPanelKeydown = (ev) => {
    if (!digest) return
    if (ev.target && FORM_TAGS.has(ev.target.tagName)) return
    const rows = rowsOf(digest)
    const key = ev.key

    if (key === 'j' || key === 'k') {
      ev.preventDefault(); ev.stopPropagation()
      if (!rows.length) return
      const i = rows.findIndex((r) => r.kind === selectedKind)
      if (key === 'j') selectedKind = i < 0 ? rows[0].kind : rows[Math.min(i + 1, rows.length - 1)].kind
      else selectedKind = i < 0 ? rows[rows.length - 1].kind : rows[Math.max(i - 1, 0)].kind
      render()
      return
    }
    if (key === 'Enter') {
      if (!selectedKind) return // nothing to act on -- let the key bubble
      ev.preventDefault(); ev.stopPropagation()
      toggleKind(selectedKind)
      return
    }
    if (key === 'y') {
      if (!selectedKind) return // nothing to act on -- let the key bubble
      ev.preventDefault(); ev.stopPropagation()
      copyRow(selectedKind)
      return
    }
    if (key === 'Escape') {
      if (!open.size) return // nothing open -- the page's own Escape handling gets it
      ev.preventDefault(); ev.stopPropagation()
      open.clear()
      render()
      return
    }
  }

  // ------------------------------------------------------------------ attach

  const attach = (deps) => {
    S = deps.S; post = deps.post; toast = deps.toast; el = deps.el; ago = deps.ago

    panelEl = document.getElementById('spend-panel')
    const table = document.getElementById('spend-table')
    if (table) table.addEventListener('click', onTableClick)
    if (panelEl) {
      panelEl.addEventListener('keydown', onPanelKeydown)
      panelEl.addEventListener('click', onPanelClick)
    }

    const take = (d) => { predates = false; digest = d; render() }
    MCE.on('snapshot', (d) => { if (d && !('spend' in d)) { predates = true; render() } })
    MCE.onField('spend', take)
    MCE.on('spend', take)

    render()
  }

  return { KINDS, LABELS, fmtUsd, fmtTok, cellText, rowsOf, caveatOf, rowText, callText, sinceLabel, attach, render }
})()
