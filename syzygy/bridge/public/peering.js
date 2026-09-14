/* Syzygy -- the Peering view: the link's controls (peers.js's own markup,
 * unmoved in code, only relocated in the page) along the top, a drill-in
 * log of every exchange that has crossed the link below it, and the record
 * of whichever row is open beside the log.
 *
 * A CLASSIC script, like peers.js/spend.js and unlike swarm.js -- loaded
 * after peering-model.js and before app.js, its global (MCPR) referenced
 * bare everywhere, never window.MCPR. Nothing runs at evaluation time but
 * defining MCPR: every DOM binding, and every stream registration, happens
 * inside attach().
 *
 * Rules to keep if you edit this file:
 *   - NEVER assign `node.className` on a row built by MCX.reconcile -- use
 *     MCX.setAttr/MCX.toggle/MCX.show instead.
 *   - Every string the relay or a peer sent goes in through textContent,
 *     never innerHTML.
 *   - No animation and no transition anywhere in peering.css.
 *   - Every key this file's own log layer consumes calls preventDefault()
 *     and stopPropagation(), so the digit map above it never sees it; a key
 *     it does not consume is left alone so it can bubble. */
'use strict'

const MCPR = (() => {
  const PIN_KEY = 'szg.peering.pins'
  const REDACT_ARM_MS = 3000
  const PAGE_LIMIT = 100
  // Kinds the relay's own log actually stores rows under. A local-only kind
  // (held/action/filter) is still a valid row filter, but sending it to
  // /api/peer-wire would just narrow nothing the relay recognises, so it is
  // never sent -- buildRows filters the merged set correctly regardless.
  const WIRE_KINDS = new Set(['pair', 'hello', 'ask', 'reply', 'drop', 'error', 'other'])
  const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

  let S = null, $ = null, el = null, post = null, toast = null, ago = null

  // ------------------------------------------------------------------ state
  let heads = []            // wire log heads, newest first
  let next = null
  let loading = false
  let loadedOnce = false
  let digest = null
  let redactOff = []
  let selfIsHostname = false
  let openKey = null
  const full = new Map()    // wire row ref (t) -> its full body
  let pinned = new Set()
  let filter = { kind: '', text: '' }
  let filterMode = false
  let selectedKey = null
  let armedOff = null       // { fingerprint, until, timer }

  let toolsHint = null, toolsInput = null
  let olderBtn = null
  // What renderDetail/renderSafeguard last actually drew, so a render() that
  // changed nothing either of them reads does not tear down and rebuild that
  // DOM -- which would reset scroll position and text selection inside an
  // open exchange, and could swap the redaction button out from under a
  // click already in flight.
  let lastDetailSig = null
  let lastSafeguardSig = null

  // -------------------------------------------------------------- pin store

  const loadPins = () => {
    try {
      const raw = localStorage.getItem(PIN_KEY)
      const arr = raw ? JSON.parse(raw) : []
      return new Set(Array.isArray(arr) ? arr : [])
    } catch (e) { return new Set() }
  }
  const savePins = () => { try { localStorage.setItem(PIN_KEY, JSON.stringify([...pinned])) } catch (e) { /* per-viewer only */ } }

  // ------------------------------------------------------------------ fetch

  const getJson = (path) => fetch(path, { headers: { 'x-mch-token': window.SZG_TOKEN } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))

  const fetchPage = (before) => {
    const params = new URLSearchParams()
    if (before != null) params.set('before', String(before))
    if (filter.kind && WIRE_KINDS.has(filter.kind)) params.set('kind', filter.kind)
    if (filter.text) params.set('q', filter.text)
    params.set('limit', String(PAGE_LIMIT))
    return getJson('/api/peer-wire?' + params.toString())
  }

  const loadFirstPage = () => {
    loading = true
    render()
    fetchPage().then((d) => {
      heads = Array.isArray(d.items) ? d.items : []
      next = d.next ?? null
      loading = false
      loadedOnce = true
      render()
    }).catch(() => { loading = false; render() })
  }

  const loadOlder = () => {
    if (next == null || loading) return
    loading = true
    render()
    fetchPage(next).then((d) => {
      heads = heads.concat(Array.isArray(d.items) ? d.items : [])
      next = d.next ?? null
      loading = false
      render()
    }).catch(() => { loading = false; render() })
  }

  const fetchFull = (t) => {
    if (full.has(t)) return Promise.resolve(full.get(t))
    return getJson('/api/peer-wire?' + new URLSearchParams({ id: String(t) }).toString())
      .then((d) => { const row = d && d.row; if (row) full.set(t, row); return row })
      .catch(() => null)
  }

  // ------------------------------------------------------------------ rows

  const currentRows = () => MCPRM.buildRows({
    heads,
    asks: (S.peers && S.peers.asks) || [],
    jobs: (S.peers && S.peers.jobs) || [],
    applied: MCPRM.appliedIndex({
      sessions: S.sessions,
      spawnedBy: S.canvas && S.canvas.spawnedBy,
      requests: S.dispatch && S.dispatch.requests,
    }),
    pinned, filter,
  })

  const rowByKey = (key) => currentRows().find((r) => r.key === key) || null

  const ensureFullFor = (row) => (row.source === 'wire' ? fetchFull(row.ref) : Promise.resolve(null))

  const detailFor = (row) => MCPRM.detailOf(row, {
    full: row.source === 'wire' ? full.get(row.ref) : null,
    asks: (S.peers && S.peers.asks) || [],
    jobs: (S.peers && S.peers.jobs) || [],
  })

  const pad2 = (n) => String(n).padStart(2, '0')
  const fmtTime = (t) => {
    const d = new Date(t)
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
  }

  // ---------------------------------------------------------------- clicks

  const togglePin = (key) => {
    if (pinned.has(key)) pinned.delete(key); else pinned.add(key)
    savePins()
    render()
  }

  // The one path that closes the detail pane. Resetting the signature here,
  // not just leaving renderDetail to notice, means the NEXT thing opened --
  // even one that happens to render identically -- is never mistaken for a
  // no-op render and skipped.
  const closeDetail = () => { openKey = null; lastDetailSig = null }

  const toggleOpen = (key) => {
    if (openKey === key) { closeDetail(); render(); return }
    openKey = key
    selectedKey = key
    render()
    const row = rowByKey(key)
    if (row) ensureFullFor(row).then(render)
  }

  const copyDetail = async (key) => {
    const row = rowByKey(key)
    if (!row) return
    await ensureFullFor(row)
    const detail = detailFor(row)
    try {
      await navigator.clipboard.writeText(JSON.stringify(detail, null, 2))
      toast('copied')
    } catch (e) { toast('copy failed', { kind: 'error' }) }
  }

  const onListClick = (ev) => {
    const rowEl = ev.target.closest('.prrow')
    if (!rowEl) return
    const key = MCX.keyOf(rowEl)
    if (key == null) return
    if (ev.shiftKey) { togglePin(key); return }
    if (ev.altKey) { void copyDetail(key); return }
    toggleOpen(key)
  }

  const onLogPanelClick = (ev) => {
    if (ev.target.closest('button, input, textarea, select, a')) return
    const logHost = $('pr-log')
    if (logHost) logHost.focus()
  }

  // ------------------------------------------------------------- key layer

  const moveSelection = (dir) => {
    const rows = currentRows()
    if (!rows.length) return
    const i = rows.findIndex((r) => r.key === selectedKey)
    if (dir === 'down') selectedKey = i < 0 ? rows[0].key : rows[Math.min(i + 1, rows.length - 1)].key
    else selectedKey = i < 0 ? rows[rows.length - 1].key : rows[Math.max(i - 1, 0)].key
    render()
    const list = $('pr-list')
    const node = list && list.querySelector('[data-selected="true"]')
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' })
  }

  const onLogKeydown = (ev) => {
    if (ev.target && FORM_TAGS.has(ev.target.tagName)) return
    const key = ev.key

    if (filterMode) {
      if (key === 'Escape' || key === 'f') {
        ev.preventDefault(); ev.stopPropagation()
        filterMode = false
        render()
        return
      }
      if (key === '/') {
        ev.preventDefault(); ev.stopPropagation()
        if (toolsInput) toolsInput.focus()
        return
      }
      if (/^[0-9]$/.test(key)) {
        ev.preventDefault(); ev.stopPropagation()
        filter = { ...filter, kind: key === '0' ? '' : (MCPRM.KIND_DIGITS[key] || '') }
        loadFirstPage()
        return
      }
      // A browser shortcut, Tab, an arrow key or anything held with a
      // modifier must still bubble even while a filter kind is being
      // chosen -- only a bare printable character is this mode's own.
      if (ev.metaKey || ev.ctrlKey || ev.altKey || key.length !== 1) return
      // Any other bare character while choosing a filter is consumed
      // rather than left to fall through to the tab digit map underneath.
      ev.preventDefault(); ev.stopPropagation()
      return
    }

    if (key === 'j' || key === 'k') {
      ev.preventDefault(); ev.stopPropagation()
      moveSelection(key === 'j' ? 'down' : 'up')
      return
    }
    if (key === 'Enter') {
      if (!selectedKey) return
      ev.preventDefault(); ev.stopPropagation()
      if (ev.shiftKey) togglePin(selectedKey)
      else if (ev.altKey) void copyDetail(selectedKey)
      else toggleOpen(selectedKey)
      return
    }
    if (key === 'f') {
      ev.preventDefault(); ev.stopPropagation()
      filterMode = true
      render()
      return
    }
    if (key === 'Escape') {
      if (openKey == null) return
      ev.preventDefault(); ev.stopPropagation()
      closeDetail()
      render()
      return
    }
  }

  // -------------------------------------------------------------- building

  const buildToolsSkeleton = (host) => {
    toolsHint = el('span', 'prtoolshint')
    host.appendChild(toolsHint)

    toolsInput = el('input', 'prfiltertext')
    toolsInput.type = 'text'
    toolsInput.placeholder = 'peer or text'
    toolsInput.autocomplete = 'off'
    toolsInput.spellcheck = false
    toolsInput.addEventListener('input', () => { filter = { ...filter, text: toolsInput.value } })
    toolsInput.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== 'Escape') return
      ev.preventDefault(); ev.stopPropagation()
      loadFirstPage()
      const logHost = $('pr-log')
      if (logHost) logHost.focus()
    })
    host.appendChild(toolsInput)
  }

  const renderTools = () => {
    if (!toolsHint) return
    const activeParts = []
    if (filter.kind) activeParts.push('kind: ' + filter.kind)
    if (filter.text) activeParts.push('text: ' + filter.text)
    const active = activeParts.length ? activeParts.join(' · ') + ' · ' : ''
    const hint = filterMode
      ? 'FILTER · 1 pair 2 hello 3 ask 4 reply 5 held 6 action 7 drop 8 filter 9 error 0 all · / text · esc'
      : 'f filter · j/k move · enter open · ⇧ pin · ⌥ copy'
    MCX.setText(toolsHint, active + hint)
    MCX.show(toolsInput, filterMode)
  }

  const ROW = {
    key: (r) => r.key,
    create: () => {
      const row = el('div', 'prrow')
      row.appendChild(el('span', 'prtime'))
      row.appendChild(el('span', 'prarrow'))
      row.appendChild(el('span', 'prpeer'))
      row.appendChild(el('span', 'prkind chip'))
      row.appendChild(el('span', 'prsummary'))
      row.appendChild(el('span', 'prmeta'))
      row.appendChild(el('span', 'prredact'))
      row.appendChild(el('span', 'prpin', '📌'))
      return row
    },
    update: (row, r) => {
      MCX.setAttr(row, 'data-open', openKey === r.key ? 'true' : null)
      MCX.setAttr(row, 'data-selected', selectedKey === r.key ? 'true' : null)
      MCX.setAttr(row, 'data-pinned', pinned.has(r.key) ? 'true' : null)

      MCX.setText(row.querySelector('.prtime'), fmtTime(r.t))
      MCX.setText(row.querySelector('.prarrow'), MCPRM.arrowOf(r.dir))
      MCX.setText(row.querySelector('.prpeer'), r.peer || '')

      const kindEl = row.querySelector('.prkind')
      MCX.setText(kindEl, r.kind || '')
      MCX.setAttr(kindEl, 'data-kind', r.kind || null)

      MCX.setText(row.querySelector('.prsummary'), r.summary || '')

      const metaParts = []
      if (Number.isFinite(r.bytes)) metaParts.push(MCPRM.fmtBytes(r.bytes))
      if (Number.isFinite(r.costUsd)) metaParts.push('$' + r.costUsd.toFixed(4))
      MCX.setText(row.querySelector('.prmeta'), metaParts.join(' · '))

      const redactEl = row.querySelector('.prredact')
      const n = Number(r.redactions) || 0
      const off = r.safeguard === 'off'
      MCX.setText(redactEl, off ? 'sent unredacted' : n + ' redacted')
      MCX.setAttr(redactEl, 'data-off', off ? 'true' : null)
      MCX.show(redactEl, off || n > 0)

      MCX.show(row.querySelector('.prpin'), pinned.has(r.key))
    },
  }

  const ensureOlderBtn = (host) => {
    if (!olderBtn) {
      olderBtn = el('button', 'btn no prolder', 'Older')
      olderBtn.type = 'button'
      olderBtn.addEventListener('click', loadOlder)
    }
    host.appendChild(olderBtn) // moves it to the end, after every reconciled row
    MCX.show(olderBtn, next != null)
  }

  // --------------------------------------------------------------- detail

  const clippedNote = (clipped) => (clipped ? ' (clipped at 8 KB)' : '')

  const preBlock = (label, value, clipped) => {
    const wrap = el('div', 'prsection')
    wrap.appendChild(el('div', 'prsectionlabel', label + clippedNote(clipped)))
    const pre = el('pre', 'prpre')
    pre.textContent = typeof value === 'string' ? value : JSON.stringify(value === undefined ? null : value, null, 2)
    wrap.appendChild(pre)
    return wrap
  }

  const safeguardLine = (row, detail) => {
    if (row.kind === 'pair') return 'pairing is never redacted'
    if (row.safeguard === 'off') return 'sent unredacted: redaction is off for this peer'
    const red = (detail && detail.redactions) || null
    const n = red ? Number(red.n) || 0 : (Number(row.redactions) || 0)
    if (!n) return 'nothing redacted'
    const kinds = red && red.kinds
      ? Object.entries(red.kinds).filter(([, v]) => v).map(([k, v]) => k + ' ' + v).join(', ')
      : ''
    return n + ' redacted' + (kinds ? ': ' + kinds : '')
  }

  const renderDetail = () => {
    const host = $('pr-detail')
    const body = $('pr-detail-body')
    if (!host || !body) return

    let row = openKey == null ? null : rowByKey(openKey)
    if (openKey != null && !row) closeDetail()

    if (!row) {
      if (lastDetailSig === 'closed') return
      lastDetailSig = 'closed'
      MCX.setAttr(host, 'hidden', '')
      body.textContent = ''
      return
    }

    const detail = detailFor(row)
    const hasFull = row.source !== 'wire' || full.has(row.ref)
    const ask = detail && detail.ask
    const askSig = ask ? (ask.text || '').length + ':' + (ask.reply || '').length : ''
    const sig = [openKey, hasFull ? 1 : 0, row.summary, row.redactions, row.safeguard, askSig].join('|')
    if (sig === lastDetailSig) return
    lastDetailSig = sig

    MCX.setAttr(host, 'hidden', null)
    body.textContent = ''

    const head = el('div', 'prdetailhead')
    const headParts = [fmtTime(row.t), MCPRM.arrowOf(row.dir), row.peer || '', row.kind || '']
    if (detail && detail.status != null) headParts.push(String(detail.status))
    if (detail && Number.isFinite(detail.rttMs)) headParts.push(detail.rttMs + 'ms')
    if (Number.isFinite(row.bytes)) headParts.push(MCPRM.fmtBytes(row.bytes))
    head.textContent = headParts.filter((p) => p !== '').join(' · ')
    body.appendChild(head)

    body.appendChild(el('div', 'prsafeguardline', safeguardLine(row, detail)))

    if (row.source === 'wire') {
      const sent = detail && detail.sent
      const received = detail && detail.received
      if (sent) body.appendChild(preBlock('Sent', sent.value !== undefined ? sent.value : sent.raw, sent.clipped))
      if (received) body.appendChild(preBlock('Received', received.value !== undefined ? received.value : received.raw, received.clipped))
      if (detail && detail.ask) {
        body.appendChild(preBlock('Ask', detail.ask.text ?? ''))
        body.appendChild(preBlock('Reply', detail.ask.reply ?? ''))
      }
    } else if (row.source === 'ask') {
      body.appendChild(preBlock('Ask', (detail && detail.text) ?? ''))
      body.appendChild(preBlock('Reply', (detail && detail.reply) ?? ''))
      body.appendChild(preBlock('Record', detail))
    } else if (row.source === 'job') {
      body.appendChild(preBlock('Record', detail))
    }

    const closeBtn = el('button', 'btn prdetailclose', 'Close')
    closeBtn.type = 'button'
    closeBtn.addEventListener('click', () => { closeDetail(); render() })
    body.appendChild(closeBtn)
  }

  // ------------------------------------------------------------- safeguard

  const disarmOff = () => { if (armedOff && armedOff.timer) clearTimeout(armedOff.timer); armedOff = null }

  const onToggleRedact = async (p, currentlyOff) => {
    const turningOff = !currentlyOff
    if (turningOff) {
      const isArmed = armedOff && armedOff.fingerprint === p.fingerprint && Date.now() < armedOff.until
      if (!isArmed) {
        disarmOff()
        armedOff = {
          fingerprint: p.fingerprint,
          until: Date.now() + REDACT_ARM_MS,
          timer: setTimeout(() => { disarmOff(); renderSafeguard() }, REDACT_ARM_MS),
        }
        renderSafeguard()
        return
      }
      disarmOff()
    }
    const r = await post('/api/peer-wire/redact', { fingerprint: p.fingerprint, redact: currentlyOff })
    if (!r || r.error) toast((r && r.error) || 'could not change redaction', { kind: 'error' })
  }

  const renderSafeguard = () => {
    const host = $('pr-safeguard-body')
    if (!host) return

    const d = digest || {}
    const red = d.redactions || {}
    const byKindSig = Object.entries(red.byKind || {}).filter(([, v]) => v).map(([k, v]) => k + ':' + v).sort().join(',')
    const list = (S.peers && Array.isArray(S.peers.list)) ? S.peers.list : []
    const peersSig = list.map((p) => p.name + ':' + p.fingerprint).join(',')
    const armedFp = armedOff && Date.now() < armedOff.until ? armedOff.fingerprint : ''
    const sig = [
      Number(red.total) || 0, byKindSig, Number(d.refused) || 0,
      selfIsHostname ? 1 : 0, redactOff.join(','), peersSig, armedFp,
    ].join('|')
    if (sig === lastSafeguardSig) return
    lastSafeguardSig = sig

    host.textContent = ''

    host.appendChild(el('div', 'prsgline',
      'Everything sent to a peer is redacted first: home folder, user name, computer name, local addresses and anything shaped like a key.'))

    const total = Number(red.total) || 0
    const kinds = Object.entries(red.byKind || {}).filter(([, v]) => v).map(([k, v]) => k + ' ' + v).join(', ')
    host.appendChild(el('div', 'prsgline',
      total + ' redacted so far' + (kinds ? ' (' + kinds + ')' : '') + ' · ' + (Number(d.refused) || 0) + ' refused'))

    if (selfIsHostname) {
      host.appendChild(el('div', 'prsgline prsgwarn',
        "This instance's name on the wire comes from the computer's name. Change it in Link before pairing; changing it after means pairing again."))
    }

    for (const p of list) {
      const row = el('div', 'prsgpeer')
      row.appendChild(el('span', 'prsgpeername', p.name))
      const off = redactOff.includes(p.fingerprint)
      const armed = !!(armedOff && armedOff.fingerprint === p.fingerprint && Date.now() < armedOff.until)
      const label = armed ? 'turn off? press again' : (off ? 'redaction OFF' : 'redaction on')
      const btn = el('button', 'btn prsgtoggle', label)
      btn.type = 'button'
      btn.addEventListener('click', () => { void onToggleRedact(p, off) })
      row.appendChild(btn)
      host.appendChild(row)
    }

    host.appendChild(el('div', 'prsgline',
      'Nothing a peer sends runs here: a proposed action waits for a click in this pane.'))
  }

  // ------------------------------------------------------------ rendering

  const render = () => {
    const rows = currentRows()
    const list = $('pr-list')
    if (list) {
      MCX.reconcile(list, rows, ROW)
      ensureOlderBtn(list)
    }
    const countEl = $('c-prwire')
    if (countEl) MCX.setText(countEl, String(rows.length))

    renderTools()
    renderDetail()
    renderSafeguard()

    const summaryEl = $('peer-summary')
    if (summaryEl) MCX.setText(summaryEl, MCPRM.summaryLine(S.peers, digest) + ' ›')
  }

  // ------------------------------------------------------------------ attach

  const attach = (deps) => {
    S = deps.S; $ = deps.$; el = deps.el; post = deps.post; toast = deps.toast; ago = deps.ago
    pinned = loadPins()

    const toolsHost = $('pr-tools')
    if (toolsHost) buildToolsSkeleton(toolsHost)

    const listHost = $('pr-list')
    if (listHost) listHost.addEventListener('click', onListClick)

    const logHost = $('pr-log')
    if (logHost) {
      logHost.addEventListener('keydown', onLogKeydown)
      logHost.addEventListener('click', onLogPanelClick)
    }

    const summaryEl = $('peer-summary')
    if (summaryEl) summaryEl.addEventListener('click', () => {
      const tab = document.querySelector('.tab[data-view="peering"]')
      if (tab) tab.click()
    })

    MCE.onField('peerWire', (v) => {
      digest = v.digest; redactOff = v.redactOff; selfIsHostname = v.selfIsHostname
      render()
    })
    MCE.on('peerwire', (d) => {
      if (d.digest) digest = d.digest
      if (d.redactOff) redactOff = d.redactOff
      if (d.row && !heads.some((h) => h.t === d.row.t)) heads = [d.row, ...heads]
      render()
    })
    // After MCN.attach() above this call, so S.peers already carries whatever
    // the initial snapshot set before this file's own handlers see a frame.
    MCE.onField('peers', render)
    MCE.on('peers', render)

    const node = $('view-peering')
    if (node) {
      const mo = new MutationObserver(() => {
        if (node.classList.contains('on') && !loadedOnce) loadFirstPage()
      })
      mo.observe(node, { attributes: true, attributeFilter: ['class'] })
      if (node.classList.contains('on') && !loadedOnce) loadFirstPage()
    }

    render()
  }

  return { attach }
})()
