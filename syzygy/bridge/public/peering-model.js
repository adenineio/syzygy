/* Syzygy -- the Peering tab's pure core, evaluated under node by its own
 * harness. The tab's rows come from three places -- wire exchanges paged
 * from the relay, and the ask log and job records already sitting in the
 * snapshot -- merged here so the view itself only draws what this file
 * hands back.
 *
 * A CLASSIC script, like reconcile.js/stream.js -- no DOM, no window, no
 * timers, nothing runs at evaluation time but defining the global below.
 * `MCPRM` is referenced bare wherever it is used, never window.MCPRM. */
'use strict'

const MCPRM = (() => {
  const KIND_DIGITS = Object.freeze({
    '1': 'pair', '2': 'hello', '3': 'ask', '4': 'reply', '5': 'held',
    '6': 'action', '7': 'drop', '8': 'filter', '9': 'error',
  })

  const ARROWS = { out: '→', in: '←', local: '•' }
  const arrowOf = (dir) => ARROWS[dir] || ''

  const fmtBytes = (n) => {
    const v0 = Number(n) || 0
    if (v0 < 1024) return String(Math.round(v0)) + ' B'
    const units = ['KB', 'MB', 'GB']
    let v = v0 / 1024
    let i = 0
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
    return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + ' ' + units[i]
  }

  const numOr = (v, fallback) => (Number.isFinite(v) ? v : fallback)

  // ------------------------------------------------------------- wireRows

  /** A wire log head (a row without its two bodies) becomes one row. `bytes` is
   *  both halves' measured size; `redactions` collapses to the count alone,
   *  since the kinds breakdown belongs to the detail pane, not the row. */
  const wireRows = (heads) => {
    const list = Array.isArray(heads) ? heads : []
    return list.map((h) => ({
      key: 'w' + h.t,
      t: h.t,
      source: 'wire',
      dir: h.dir,
      peer: h.peer,
      kind: h.kind,
      summary: h.summary,
      bytes: (Number(h.reqBytes) || 0) + (Number(h.resBytes) || 0),
      costUsd: null,
      redactions: h.redactions ? Number(h.redactions.n) || 0 : 0,
      safeguard: h.safeguard,
      ref: h.t,
    }))
  }

  // ------------------------------------------------------------- askRows

  /** Local events derived from the ask log: a held ask waiting on a human
   *  decision, an answered ask that proposed actions, and a failed dial.
   *  A plain answered ask with nothing proposed gives no row at all -- the
   *  exchange it rode on is already a wire row. */
  const askRows = (asks, applied) => {
    const list = Array.isArray(asks) ? asks : []
    const idx = applied instanceof Map ? applied : new Map()
    const rows = []
    for (const a of list) {
      if (!a) continue
      const base = {
        key: 'a' + a.id, t: a.t, source: 'ask', peer: a.peer,
        costUsd: numOr(a.costUsd, null), redactions: null, safeguard: null, ref: a.id,
      }
      if (a.state === 'held') {
        const err = typeof a.error === 'string' && a.error ? ': ' + a.error : ''
        rows.push({ ...base, dir: 'local', kind: 'held', summary: 'held' + err })
        continue
      }
      if (a.state === 'failed') {
        rows.push({ ...base, dir: a.dir, kind: 'error', summary: 'ask failed: ' + (a.error || '') })
        continue
      }
      const n = Number(a.actionsProposed) || 0
      if (a.state === 'answered' && n > 0) {
        let summary
        if (a.dir === 'out') {
          summary = n + (n === 1 ? ' action' : ' actions') + ' proposed on ' + a.peer
        } else {
          // `applied` is keyed by the WIRE id (`forPeer.askId`), never the
          // store id -- `a.id` and `a.askId` are two different things.
          // An automatic apply's own proposals (`a.proposals`, mode `auto`)
          // take precedence over `idx`, which only ever knows about a
          // record a person's click created.
          const props = Array.isArray(a.proposals) ? a.proposals.filter((p) => p && p.mode === 'auto') : []
          const autoOk = props.filter((p) => p.state === 'applied').map((p) => p.kind)
          const autoBad = props.filter((p) => p.state === 'failed').map((p) => p.kind)
          const kinds = idx.get(a.askId)
          const parts = []
          if (autoOk.length) parts.push('auto-applied: ' + autoOk.join(', '))
          if (autoBad.length) parts.push('failed: ' + autoBad.join(', '))
          if (!parts.length) parts.push(Array.isArray(kinds) && kinds.length ? 'applied: ' + kinds.join(', ') : 'no apply recorded')
          summary = n + (n === 1 ? ' action' : ' actions') + ' proposed · ' + parts.join(' · ')
        }
        rows.push({ ...base, dir: a.dir, kind: 'action', summary })
      }
      // a plain answered ask, or any other state: no local row
    }
    return rows
  }

  // ------------------------------------------------------------- jobRows

  /** A drop job (peer-drops; empty on a relay that predates it) gives a
   *  drop row, and -- only when `filtered` is actually a boolean -- a
   *  second filter row beside it. `reason` is the job's own `error` alone:
   *  `note` is the SENDER's note, never a refusal reason, and never shown
   *  as though it explained one. `filtered` absent means the concept did
   *  not apply to this job, and gives no filter row at all; `filtered:
   *  true` on a state this row does not recognise gives no filter row
   *  either -- there is nothing honest to say about it yet. */
  const jobRows = (jobs) => {
    const list = Array.isArray(jobs) ? jobs : []
    const rows = []
    for (const j of list) {
      if (!j) continue
      const t = numOr(j.updatedAt, j.t)
      const n = Array.isArray(j.files) ? j.files.length : (Number(j.files) || 0)
      const arrow = j.side === 'recv' ? '← ' : '→ '
      const reason = j.error || ''
      let summary
      if (j.state === 'landed') summary = arrow + n + ' files landed'
      else if (j.state === 'refused') summary = arrow + 'refused' + (reason ? ': ' + reason : '')
      else summary = arrow + n + ' files ' + (j.state || '')
      rows.push({
        key: 'j' + j.id, t, source: 'job', dir: j.side === 'recv' ? 'in' : 'out', peer: j.peer,
        kind: 'drop', summary, bytes: numOr(j.bytes, null), costUsd: null,
        redactions: null, safeguard: null, ref: j.id,
      })
      if (typeof j.filtered === 'boolean') {
        let filterSummary = null
        if (j.filtered === false) filterSummary = 'no filter installed'
        else if (j.state === 'refused') filterSummary = 'filter refused' + (reason ? ': ' + reason : '')
        else if (j.state === 'filtering') filterSummary = 'filter running'
        else if (j.state === 'sent' || j.state === 'landed') filterSummary = 'filter passed'
        if (filterSummary != null) {
          rows.push({
            key: 'jf' + j.id, t, source: 'job', dir: 'local', peer: j.peer, kind: 'filter',
            summary: filterSummary, bytes: null, costUsd: null,
            redactions: null, safeguard: null, ref: j.id,
          })
        }
      }
    }
    return rows
  }

  // --------------------------------------------------------- appliedIndex

  /** Which kind of local record applied a peer's proposed actions, keyed
   *  by the ask id every such record carries under `forPeer.askId`. A
   *  record with no `forPeer` tag at all is simply not one of these, and
   *  contributes nothing -- which is the common case on a relay that has
   *  not grown this tag yet. */
  const appliedIndex = ({ sessions, spawnedBy, requests } = {}) => {
    const idx = new Map()
    const add = (list, kind) => {
      if (!Array.isArray(list)) return
      for (const r of list) {
        const fp = r && r.forPeer
        if (!fp || typeof fp.askId !== 'string' || !fp.askId) continue
        const cur = idx.get(fp.askId)
        if (cur) { if (!cur.includes(kind)) cur.push(kind) } else idx.set(fp.askId, [kind])
      }
    }
    add(sessions, 'prompt')
    add(spawnedBy, 'spawn')
    add(requests, 'dispatch')
    return idx
  }

  // ---------------------------------------------------------- buildRows

  /** Every row across every source, pinned keys first and each group
   *  newest first, narrowed by an optional kind/text filter. `filter.kind`
   *  matches a row's own kind exactly (a wire kind or a local one, `held`/
   *  `action`/`filter` included); `filter.text` matches the peer name or
   *  the summary line, case-insensitively. */
  const buildRows = ({ heads, asks, jobs, applied, pinned, filter } = {}) => {
    let rows = [...wireRows(heads), ...askRows(asks, applied), ...jobRows(jobs)]
    const f = filter || {}
    if (f.kind) rows = rows.filter((r) => r.kind === f.kind)
    if (f.text) {
      const q = String(f.text).toLowerCase()
      rows = rows.filter((r) => (String(r.peer || '').toLowerCase().includes(q)) ||
        (String(r.summary || '').toLowerCase().includes(q)))
    }
    const pinnedSet = pinned instanceof Set ? pinned : new Set(Array.isArray(pinned) ? pinned : [])
    const pinnedRows = []
    const restRows = []
    for (const r of rows) (pinnedSet.has(r.key) ? pinnedRows : restRows).push(r)
    const byNewest = (a, b) => (Number(b.t) || 0) - (Number(a.t) || 0)
    pinnedRows.sort(byNewest)
    restRows.sort(byNewest)
    return [...pinnedRows, ...restRows]
  }

  // ----------------------------------------------------------- detailOf

  /** A string half of a full wire row: parsed to a value when it is whole
   *  JSON, or kept as raw text (with the head's own clipped flag) when it
   *  is not -- which is exactly what a clipped half looks like. */
  const parseHalf = (text, clipped) => {
    if (typeof text !== 'string') return { value: null, raw: null, clipped: false }
    let value
    try { value = JSON.parse(text) } catch { value = undefined }
    return { value, raw: text, clipped: !!clipped }
  }

  const askIdOf = (half) => {
    const v = half && half.value
    return v && typeof v === 'object' && typeof v.askId === 'string' ? v.askId : null
  }

  /** The record the detail pane shows and the copy gesture serialises. A
   *  wire row needs its full body (fetched separately and handed in as
   *  `full`, or undefined before that lands); an ask or job row's detail is
   *  simply the record itself, found by the row's own `ref`. */
  const detailOf = (row, ctx = {}) => {
    const { full, asks, jobs } = ctx
    if (!row) return null
    if (row.source === 'ask') {
      const list = Array.isArray(asks) ? asks : []
      return list.find((a) => a && a.id === row.ref) || null
    }
    if (row.source === 'job') {
      const list = Array.isArray(jobs) ? jobs : []
      return list.find((j) => j && j.id === row.ref) || null
    }
    const f = full || {}
    const sent = parseHalf(f.req, f.reqClipped)
    const received = parseHalf(f.res, f.resClipped)
    const askId = askIdOf(sent) || askIdOf(received)
    const askList = Array.isArray(asks) ? asks : []
    // Joined by the WIRE id (`askId`), never the store id: the two are
    // different fields and a wire body only ever carries the former. More
    // than one ask can share a wire id across peers, so only an ask whose own
    // peer is this row's peer counts: another peer's ask with the same id is a
    // different conversation, and attaching it would show the wrong record.
    let ask = null
    if (askId) ask = askList.find((a) => a && a.askId === askId && a.peer === row.peer) || null
    return {
      t: row.t, dir: row.dir, peer: row.peer, kind: row.kind,
      route: f.route ?? null, status: f.status ?? null, rttMs: f.rttMs ?? null,
      safeguard: row.safeguard, redactions: f.redactions ?? null,
      sent, received,
      ask: ask ? { id: ask.id, text: ask.text, reply: ask.reply } : null,
    }
  }

  // -------------------------------------------------------- summaryLine

  /** The Telemetry tab's one-line summary. `peers === undefined` is a
   *  relay old enough to carry no `peers` key at all, distinct from
   *  peering being merely disabled. */
  const summaryLine = (peers, wire) => {
    if (peers === undefined) return 'Peering: this relay predates peering'
    if (!peers || !peers.enabled) return 'Peering off'
    const list = Array.isArray(peers.list) ? peers.list : []
    const up = list.filter((p) => p && p.health && p.health.state === 'up').length
    const d = wire || {}
    const count = Number(d.count) || 0
    const redactions = (d.redactions && Number(d.redactions.total)) || 0
    return 'Peering on · ' + list.length + ' peers, ' + up + ' up · ' +
      count + ' exchanges · ' + redactions + ' redactions'
  }

  return {
    KIND_DIGITS, arrowOf, fmtBytes, wireRows, askRows, jobRows,
    appliedIndex, buildRows, detailOf, summaryLine,
  }
})()
