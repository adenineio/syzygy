/* Syzygy — the Peering tab's link panel: the link to another
 * instance (enable, fingerprint, pairing), the roster of paired peers with
 * their read-only session strips, and the ask log with its composer.
 *
 * A CLASSIC script, like drawer.js/projects.js/dispatch.js and unlike
 * swarm.js — loaded after reconcile.js and stream.js and before app.js, its
 * global (MCN) referenced bare everywhere, never window.MCN. Nothing runs at
 * evaluation time but defining MCN and one stream registration (below the
 * MCN definition, at this file's own top level): every DOM binding and
 * every OTHER stream registration happens inside attach(), the same shape
 * drawer.js and projects.js use, so the dependency names below shadow
 * app.js's own.
 *
 * The pairing code is never part of the payload — the relay hands it back
 * once, to whichever pane asked for it — so it lives only in a module
 * variable here, cleared the moment the outstanding offer is gone.
 *
 * Rules to keep if you edit this file:
 *   - NEVER assign `node.className` on a row built by MCX.reconcile. It
 *     would wipe `.gone` out from under MCX.show. Toggle classes instead.
 *   - The health dot, the roster strip's working dot and every ask's state
 *     chip are a flat colour by data attribute, set once per render. No
 *     animation and no transition anywhere in peers.css.
 *   - The top-level stream registration below MCN exists so a liaison turn
 *     is labelled before app.js's own orchestrator handling ever sees the
 *     frame — see that registration's own comment for why. */
'use strict'

const MCN = (() => {
  let S = null, post = null, toast = null, el = null, ago = null, fmtBytes = null, focused = null, renderOrchTranscript = null
  let setView = null

  // ---- the Link region: built once, refreshed by render() ------------------
  let elPredates = null
  let elLinkBox = null
  let elStatus = null
  let elSelf = null, elBind = null, elPort = null, elEnableBtn = null
  let elFp = null, elFpLine1 = null, elFpLine2 = null
  let elHostRow = null, elHostInput = null
  let elPairBtn = null
  let elCodeBox = null, elCodeText = null, elCodeCountdown = null
  let elAcceptCode = null, elAcceptName = null

  let listHost = null
  let asksHost = null
  let peerEmpty = null

  // ---- the Asks region: composer, dry-run output, the log -------------------
  let elAskSelect = null, elAskText = null, elAskSendBtn = null, elAskEnvelope = null
  let asksListHost = null, elAskEmpty = null
  let askTickTimer = null
  // Set at every 'peers' payload: the wall-clock moment this pane received
  // it. Each ask's own elapsedMs is only as fresh as that payload, so the
  // clock shown between payloads is that figure plus time since this pane
  // last heard anything — never a re-request, just local arithmetic.
  let lastAsksPayloadAt = Date.now()
  // Ask ids whose full text is shown past the 280-character clip.
  const expandedAsks = new Set()
  const TERMINAL_ASK_STATES = new Set(['answered', 'failed'])

  // Shift/Alt/Meta/Control held right now, anywhere on the page — drives the
  // Send and Drop buttons' labels only; the actual gesture is read off the
  // triggering keyboard/click event itself, never off these flags.
  let shiftHeld = false, altHeld = false, metaHeld = false, ctrlHeld = false

  // The panel's own keyboard layer.
  let panelEl = null
  let elHint = null
  let selectedPeerName = null
  // Per-peer override of the roster strip's shown/hidden state. Absent means
  // "use the default" (open when there is exactly one peer to show).
  const rosterOverride = new Map()

  // ---- the Jobs region: the drop composer, the job list, its keys ----------
  let jobsHost = null
  let elDropTarget = null, elDropPaths = null, elDropNote = null, elDropBtn = null, elDropEnvelope = null
  let jobsListHost = null, elJobsEmpty = null
  let jobTickTimer = null
  let selectedJobId = null
  // Job ids whose file list is expanded past the compact row.
  const expandedJobs = new Set()
  // The job row currently showing its inline copy-into destination field.
  let copyPromptJobId = null
  let elCopyDestInput = null
  // A cancel (x twice) is armed per job id, the same idiom Forget uses.
  let cancelArmed = null // { id, until, timer }
  const disarmCancel = () => {
    if (cancelArmed && cancelArmed.timer) clearTimeout(cancelArmed.timer)
    cancelArmed = null
  }
  // The arrival notice (a receive job landing) is a transition this pane
  // itself observes, never announced from the first payload after a load or
  // a reconnect -- see the 'open' registration in attach(). `unreadJobs` is
  // shown on the Peering tab and cleared when this panel gets focus.
  let prevJobStates = new Map()
  let sawJobsSincePeersOpen = false
  let unreadJobs = 0

  // The pairing code the pane most recently asked for. Never read from
  // S.peers — the snapshot never carries it — and cleared the moment the
  // server-side offer it belongs to is gone (S.peers.pairing turns null) or
  // its own countdown reaches zero, whichever comes first.
  let pairingCode = null
  let countdownTimer = null
  let hostVisible = false

  // A Forget click arms for a few seconds before the second click actually
  // sends anything, the same idiom the session drawer's close button uses.
  const FORGET_ARM_MS = 3000
  let forgetArmed = null // { name, until, timer }
  const disarmForget = () => {
    if (forgetArmed && forgetArmed.timer) clearTimeout(forgetArmed.timer)
    forgetArmed = null
  }

  // ---------------------------------------------------------------- helpers

  const urlHost = (h) => (typeof h === 'string' && h.includes(':') ? '[' + h + ']' : h)

  /** The own fingerprint, node's `AB:CD:…` form, read aloud two lines at a
   *  time: sixteen pairs, then the rest. */
  const fpLines = (fp) => {
    if (typeof fp !== 'string' || !fp) return ['', '']
    const pairs = fp.split(':')
    return [pairs.slice(0, 16).join(':'), pairs.slice(16).join(':')]
  }

  const formatCountdown = (ms) => {
    const total = Math.max(0, Math.ceil(ms / 1000))
    const m = Math.floor(total / 60)
    const s = total % 60
    return String(m) + ':' + String(s).padStart(2, '0')
  }

  const formatClock = (ms) => {
    const total = Math.max(0, Math.round(ms / 1000))
    const m = Math.floor(total / 60)
    const s = total % 60
    return String(m) + ':' + String(s).padStart(2, '0')
  }

  /** A textarea of one absolute path per line, trimmed, empty lines dropped.
   *  Split on a built character, never a typed escape. */
  const splitDropPaths = (text) =>
    String(text || '').split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean)

  /** When a job's current state began, for the filtering clock: `updatedAt`
   *  when the store has it, `t` for a job so new it has not moved yet. */
  const jobSince = (j) => (Number.isFinite(j.updatedAt) ? j.updatedAt : j.t)

  const statusText = (p) => {
    if (!p.enabled) return 'Peering is off'
    if (p.listening) return 'Listening on https://' + urlHost(p.bind) + ':' + p.port
    return 'Not listening: ' + (p.error || 'starting')
  }

  const fieldRow = (label, input) => {
    const row = el('label', 'peerfield')
    row.appendChild(el('span', 'peerfieldlabel', label))
    row.appendChild(input)
    return row
  }

  // -------------------------------------------------------- the code box

  const hideCode = () => {
    if (countdownTimer) clearInterval(countdownTimer)
    countdownTimer = null
    pairingCode = null
    MCX.setText(elCodeText, '')
    MCX.setText(elCodeCountdown, '')
    MCX.show(elCodeBox, false)
  }

  const tickCountdown = () => {
    const pairing = S.peers && S.peers.pairing
    const exp = pairing ? pairing.expiresAt : null
    if (!pairingCode || !Number.isFinite(exp)) { hideCode(); return }
    const remain = exp - Date.now()
    if (remain <= 0) { hideCode(); return }
    MCX.setText(elCodeCountdown, formatCountdown(remain))
  }

  const showCode = (code) => {
    pairingCode = code
    MCX.setText(elCodeText, code)
    MCX.show(elCodeBox, true)
    if (countdownTimer) clearInterval(countdownTimer)
    countdownTimer = setInterval(tickCountdown, 1000)
    tickCountdown()
  }

  // -------------------------------------------------------------- actions

  const onEnableSubmit = async (ev) => {
    ev.preventDefault()
    const body = {
      enabled: !(S.peers && S.peers.enabled),
      bind: elBind.value.trim(),
      port: Number(elPort.value),
      self: elSelf.value.trim(),
    }
    const r = await post('/api/peer/enable', body)
    if (!r || r.error) { toast((r && r.error) || 'could not change peering', { kind: 'error' }); return }
    if (r.peers) { S.peers = r.peers; render() }
  }

  const onPairClick = async () => {
    const body = {}
    if (hostVisible && elHostInput.value.trim()) body.host = elHostInput.value.trim()
    const r = await post('/api/peer/pair/offer', body)
    if (!r || r.error) { toast((r && r.error) || 'could not create a pairing code', { kind: 'error' }); return }
    showCode(r.code)
  }

  const onCopyClick = () => {
    if (!pairingCode) return
    navigator.clipboard?.writeText(pairingCode)
    toast('copied')
  }

  const onAcceptSubmit = async (ev) => {
    ev.preventDefault()
    const code = elAcceptCode.value.trim()
    const name = elAcceptName.value.trim()
    const r = await post('/api/peer/pair/accept', { code, name })
    if (!r || r.error) { toast((r && r.error) || 'could not pair', { kind: 'error' }); return }
    elAcceptCode.value = ''
    elAcceptName.value = ''
    toast('Paired with ' + r.name + '. Compare the fingerprints, then confirm.')
  }

  // ----------------------------------------------------- the roster strip

  /** One read-only card per session on a paired instance's board. A fresh
   *  spec per row-render so the card's title can carry which peer it came
   *  from without threading extra arguments through MCX.reconcile. */
  const makeRosterCardSpec = (peerName) => ({
    key: (s) => s.id,
    create: () => {
      const card = el('div', 'peerroster-card')
      card.setAttribute('aria-disabled', 'true')
      card.appendChild(el('span', 'peerroster-dot'))
      card.appendChild(el('span', 'peerroster-name'))
      card.appendChild(el('span', 'peerroster-model'))
      card.appendChild(el('span', 'peerroster-needs'))
      card.appendChild(el('span', 'peerroster-branch'))
      // Built once, shown only when the other side says this session is
      // working on an ask from here.
      card.appendChild(el('span', 'peerroster-foryou'))
      return card
    },
    update: (card, s) => {
      card.title = 'On ' + peerName + ' — read-only'
      MCX.setAttr(card.querySelector('.peerroster-dot'), 'data-working', s.working ? 'true' : 'false')
      MCX.setText(card.querySelector('.peerroster-name'), s.name || '')
      MCX.setText(card.querySelector('.peerroster-model'), s.model || '')
      const needsEl = card.querySelector('.peerroster-needs')
      const hasNeeds = typeof s.needs === 'string' && s.needs.length > 0
      MCX.setText(needsEl, hasNeeds ? s.needs : '')
      MCX.show(needsEl, hasNeeds)
      MCX.setText(card.querySelector('.peerroster-branch'), s.branch || '')
      const forYou = card.querySelector('.peerroster-foryou')
      MCX.setText(forYou, s.forYou === true ? 'working for you' : '')
      MCX.show(forYou, s.forYou === true)
    },
  })

  /** Whether a peer's roster strip is open. Absent from the override map
   *  means "the default", which is open only when there is exactly one
   *  peer to show — with more than one the board would otherwise arrive
   *  already crowded. */
  const rosterExpanded = (name, listLength) =>
    rosterOverride.has(name) ? rosterOverride.get(name) : listLength === 1

  // ------------------------------------------------------- the peer rows

  /** A fresh spec per render so a row's roster default (open with exactly
   *  one peer) can read the peer count directly, with no separate walk
   *  over the list to find it. */
  const makePeerRowSpec = (listLength) => ({
    key: (p) => p.name,
    create: () => {
      const row = el('div', 'peerrow')

      const head = el('div', 'peerrowhead')
      head.appendChild(el('span', 'peerdot'))
      head.appendChild(el('span', 'peername'))
      head.appendChild(el('span', 'peerdial'))
      head.appendChild(el('span', 'peerseen'))
      head.appendChild(el('span', 'peerrtt'))
      head.appendChild(el('span', 'peerskew'))
      head.appendChild(el('span', 'peercounts'))
      const dropBtn = el('button', 'btn peerdrop', 'Drop')
      dropBtn.type = 'button'
      head.appendChild(dropBtn)
      const forgetBtn = el('button', 'btn no peerforget', 'Forget')
      forgetBtn.type = 'button'
      head.appendChild(forgetBtn)
      row.appendChild(head)

      row.appendChild(el('div', 'peererr'))

      row.appendChild(el('div', 'peerroster'))

      const caps = el('div', 'peercaps')
      const hourInput = el('input', 'peerinput peercaphour')
      hourInput.type = 'number'; hourInput.min = '0'; hourInput.step = '1'
      caps.appendChild(fieldRow('asks / hour', hourInput))
      const dayInput = el('input', 'peerinput peercapday')
      dayInput.type = 'number'; dayInput.min = '0'; dayInput.step = '0.1'
      caps.appendChild(fieldRow('$ / day', dayInput))
      row.appendChild(caps)

      const confirmBox = el('div', 'peerconfirm')
      const fpRow = el('div', 'peerfprow')
      const theirsCol = el('div', 'peerfpcol')
      theirsCol.appendChild(el('div', 'peerfplabel', 'theirs'))
      theirsCol.appendChild(el('div', 'peerfpval theirs'))
      const mineCol = el('div', 'peerfpcol')
      mineCol.appendChild(el('div', 'peerfplabel', 'this instance'))
      mineCol.appendChild(el('div', 'peerfpval mine'))
      fpRow.appendChild(theirsCol)
      fpRow.appendChild(mineCol)
      confirmBox.appendChild(fpRow)
      const confirmBtn = el('button', 'btn peerconfirmbtn', 'Confirm')
      confirmBtn.type = 'button'
      confirmBox.appendChild(confirmBtn)
      row.appendChild(confirmBox)

      return row
    },
    update: (row, p) => {
      const h = p.health || {}
      MCX.setAttr(row, 'data-selected', selectedPeerName === p.name ? 'true' : null)
      MCX.setAttr(row, 'data-skew', h.skewWarn ? 'warn' : null)

      const dot = row.querySelector('.peerdot')
      MCX.setAttr(dot, 'data-state', h.state || 'never')

      MCX.setText(row.querySelector('.peername'), p.name)
      MCX.setText(row.querySelector('.peerdial'), p.dials ? 'we dial' : 'they dial')

      const seenText = h.state !== 'never' && Number.isFinite(h.lastSeenAt) ? 'last seen ' + ago(h.lastSeenAt) : 'never'
      MCX.setText(row.querySelector('.peerseen'), seenText)

      const rttEl = row.querySelector('.peerrtt')
      const hasRtt = Number.isFinite(h.rttMs)
      MCX.setText(rttEl, hasRtt ? h.rttMs + ' ms' : '')
      MCX.show(rttEl, hasRtt)

      const skewEl = row.querySelector('.peerskew')
      const hasSkew = Number.isFinite(h.skewMs)
      if (hasSkew) {
        const skewSec = Math.round(h.skewMs / 1000)
        MCX.setText(skewEl, h.skewWarn
          ? 'clocks differ by ' + Math.abs(skewSec) + ' s — signed requests fail past 120 s'
          : 'skew ' + (skewSec >= 0 ? '+' : '') + skewSec + ' s')
      }
      MCX.show(skewEl, hasSkew)

      const counts = p.counts || {}
      MCX.setText(row.querySelector('.peercounts'), 'asks in/out ' + (counts.asksIn || 0) + '/' + (counts.asksOut || 0))

      const errEl = row.querySelector('.peererr')
      const showErr = h.state === 'down' && !!h.error
      MCX.setText(errEl, showErr ? h.error : '')
      MCX.show(errEl, showErr)

      const rosterHost = row.querySelector('.peerroster')
      const sessions = Array.isArray(p.sessions) ? p.sessions : []
      const expanded = rosterExpanded(p.name, listLength) && sessions.length > 0
      MCX.show(rosterHost, expanded)
      if (expanded) MCX.reconcile(rosterHost, sessions, makeRosterCardSpec(p.name))

      const hourInput = row.querySelector('.peercaphour')
      const dayInput = row.querySelector('.peercapday')
      const policy = p.policy || {}
      if (document.activeElement !== hourInput) hourInput.value = Number.isFinite(policy.asksPerHour) ? String(policy.asksPerHour) : ''
      if (document.activeElement !== dayInput) dayInput.value = Number.isFinite(policy.peerAskDailyCapUsd) ? String(policy.peerAskDailyCapUsd) : ''
      const postCaps = async () => {
        const asksPerHour = Math.round(Number(hourInput.value))
        const peerAskDailyCapUsd = Number(dayInput.value)
        const r = await post('/api/peer/policy', { name: p.name, asksPerHour, peerAskDailyCapUsd })
        if (!r || r.error) toast((r && r.error) || 'could not update the caps', { kind: 'error' })
      }
      hourInput.onchange = postCaps
      dayInput.onchange = postCaps

      const unconfirmed = p.confirmedAt == null
      const confirmBox = row.querySelector('.peerconfirm')
      MCX.show(confirmBox, unconfirmed)
      if (unconfirmed) {
        MCX.setText(confirmBox.querySelector('.peerfpval.theirs'), p.fingerprint || '')
        MCX.setText(confirmBox.querySelector('.peerfpval.mine'), p.localFingerprint || '')
        confirmBox.querySelector('.peerconfirmbtn').onclick = async () => {
          const r = await post('/api/peer/pair/confirm', { name: p.name })
          if (!r || r.error) toast((r && r.error) || 'could not confirm', { kind: 'error' })
        }
      }

      // Selects this peer for the Jobs region's composer and focuses it; the
      // composer's own Drop button is what actually reads a gesture and acts.
      row.querySelector('.peerdrop').onclick = () => {
        selectedPeerName = p.name
        render()
        if (elDropPaths) elDropPaths.focus()
      }

      const armed = !!(forgetArmed && forgetArmed.name === p.name && Date.now() < forgetArmed.until)
      const forgetBtn = row.querySelector('.peerforget')
      MCX.setText(forgetBtn, armed ? 'Forget? click again' : 'Forget')
      forgetBtn.onclick = async () => {
        if (!(forgetArmed && forgetArmed.name === p.name && Date.now() < forgetArmed.until)) {
          disarmForget()
          forgetArmed = { name: p.name, until: Date.now() + FORGET_ARM_MS, timer: setTimeout(() => { disarmForget(); render() }, FORGET_ARM_MS) }
          render()
          return
        }
        disarmForget()
        const r = await post('/api/peer/forget', { name: p.name })
        if (!r || r.error) toast((r && r.error) || 'could not forget', { kind: 'error' })
        render()
      }
    },
  })

  // ---------------------------------------------------------- the ask log

  const askElapsedMs = (a) => {
    const base = Number.isFinite(a.elapsedMs) ? a.elapsedMs : 0
    if (TERMINAL_ASK_STATES.has(a.state)) return base
    return base + Math.max(0, Date.now() - lastAsksPayloadAt)
  }

  const updateAskClock = (node, a) => MCX.setText(node, formatClock(askElapsedMs(a)))

  const ASK_ROW = {
    key: (a) => a.id,
    create: () => {
      const row = el('div', 'askrow')
      const head = el('div', 'askhead')
      head.appendChild(el('span', 'askdir'))
      head.appendChild(el('span', 'askchip chip'))
      head.appendChild(el('span', 'askclock'))
      row.appendChild(head)
      row.appendChild(el('div', 'asktext'))
      const moreBtn = el('button', 'btn askmore', 'more')
      moreBtn.type = 'button'
      row.appendChild(moreBtn)
      row.appendChild(el('div', 'askreply'))
      row.appendChild(el('div', 'askerror'))
      row.appendChild(el('div', 'askactions'))
      const answerBtn = el('button', 'btn go askanswer', 'Answer')
      answerBtn.type = 'button'
      row.appendChild(answerBtn)
      return row
    },
    update: (row, a) => {
      MCX.setAttr(row, 'data-state', a.state)

      MCX.setText(row.querySelector('.askdir'), (a.dir === 'out' ? '→ ' : '← ') + a.peer)

      const chip = row.querySelector('.askchip')
      MCX.setText(chip, a.state)
      MCX.setAttr(chip, 'data-state', a.state)

      const full = typeof a.text === 'string' ? a.text : ''
      const expanded = expandedAsks.has(a.id)
      const clipped = full.length > 280
      MCX.setText(row.querySelector('.asktext'), expanded || !clipped ? full : full.slice(0, 280))
      const moreBtn = row.querySelector('.askmore')
      MCX.show(moreBtn, clipped)
      MCX.setText(moreBtn, expanded ? 'less' : 'more')
      moreBtn.onclick = () => {
        if (expandedAsks.has(a.id)) expandedAsks.delete(a.id); else expandedAsks.add(a.id)
        render()
      }

      const replyEl = row.querySelector('.askreply')
      const hasReply = typeof a.reply === 'string' && a.reply.length > 0
      MCX.setText(replyEl, hasReply ? a.reply : '')
      MCX.show(replyEl, hasReply)

      const errEl = row.querySelector('.askerror')
      const hasErr = typeof a.error === 'string' && a.error.length > 0
      MCX.setText(errEl, hasErr ? a.error : '')
      MCX.show(errEl, hasErr)

      const actionsEl = row.querySelector('.askactions')
      const n = Number(a.actionsProposed) || 0
      const showActions = n > 0
      MCX.setText(actionsEl, showActions
        ? (n + (a.dir === 'out' ? ' actions proposed on ' + a.peer : ' actions in your orchestrator transcript'))
        : '')
      MCX.show(actionsEl, showActions)

      const answerBtn = row.querySelector('.askanswer')
      const canAnswer = a.dir === 'in' && a.state === 'held'
      MCX.show(answerBtn, canAnswer)
      answerBtn.onclick = canAnswer ? async () => {
        const r = await post('/api/peer/ask/answer', { id: a.id })
        if (!r || r.error) toast((r && r.error) || 'could not release the ask', { kind: 'error' })
      } : null

      updateAskClock(row.querySelector('.askclock'), a)
    },
  }

  const tickAsks = () => {
    if (!asksListHost) return
    const list = (S.peers && Array.isArray(S.peers.asks)) ? S.peers.asks : []
    for (const node of asksListHost.children) {
      const key = MCX.keyOf(node)
      if (key == null) continue
      const a = list.find((x) => String(x.id) === key)
      if (a) updateAskClock(node.querySelector('.askclock'), a)
    }
  }

  /** The one interval this panel keeps: it exists only while some ask has
   *  not reached a terminal state, and is torn down the moment none does. */
  const ensureAskTicker = () => {
    const list = (S.peers && Array.isArray(S.peers.asks)) ? S.peers.asks : []
    const anyLive = list.some((a) => !TERMINAL_ASK_STATES.has(a.state))
    if (anyLive && !askTickTimer) askTickTimer = setInterval(tickAsks, 1000)
    else if (!anyLive && askTickTimer) { clearInterval(askTickTimer); askTickTimer = null }
  }

  // ---------------------------------------------------------- the composer

  const confirmedPeers = () => (S.peers && Array.isArray(S.peers.list) ? S.peers.list.filter((p) => p.confirmedAt != null) : [])

  const renderAskComposer = (p) => {
    const confirmed = Array.isArray(p.list) ? p.list.filter((x) => x.confirmedAt != null) : []
    const prevValue = elAskSelect.value
    elAskSelect.textContent = ''
    if (!confirmed.length) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = 'Confirm a peer to ask it anything'
      elAskSelect.appendChild(opt)
      elAskSelect.disabled = true
      elAskSendBtn.disabled = true
    } else {
      elAskSelect.disabled = false
      elAskSendBtn.disabled = false
      for (const c of confirmed) {
        const opt = document.createElement('option')
        opt.value = c.name
        opt.textContent = c.name
        elAskSelect.appendChild(opt)
      }
      if (confirmed.some((c) => c.name === prevValue)) elAskSelect.value = prevValue
    }
  }

  const renderEnvelope = (envelope) => {
    const lines = []
    lines.push(envelope.method + ' ' + envelope.path)
    const headers = envelope.headers || {}
    for (const k of ['x-szg-peer', 'x-szg-ts', 'x-szg-nonce', 'x-szg-sig']) lines.push(k + ': ' + (headers[k] ?? ''))
    lines.push('bodySha256: ' + envelope.bodySha256)
    if (typeof envelope.body === 'string') lines.push('body: ' + envelope.body)
    lines.push('canonical:')
    lines.push(String(envelope.canonical || '').split('\n').join('⏎\n'))
    MCX.setText(elAskEnvelope, lines.join('\n'))
    MCX.show(elAskEnvelope, true)
  }

  const askOnce = (name, text, dryRun) => post('/api/peer/' + name + '/ask', dryRun ? { text, dryRun: true } : { text })

  const onAskSend = async ({ shiftKey, altKey }) => {
    const text = elAskText.value.trim()
    if (!text) return

    if (altKey) {
      const name = elAskSelect.value
      if (!name) { toast('confirm a peer to ask it anything', { kind: 'error' }); return }
      const r = await askOnce(name, text, true)
      if (!r || r.error) { toast((r && r.error) || 'could not build a dry run', { kind: 'error' }); return }
      if (r.envelope) renderEnvelope(r.envelope)
      return
    }

    if (shiftKey) {
      const peers = confirmedPeers()
      if (!peers.length) { toast('confirm a peer to ask it anything', { kind: 'error' }); return }
      const results = await Promise.all(peers.map((p) => askOnce(p.name, text, false)))
      const failed = results.filter((r) => !r || r.error).length
      if (failed > 0) toast(failed + ' of ' + peers.length + ' asks did not go out', { kind: 'error' })
      return
    }

    const name = elAskSelect.value
    if (!name) { toast('confirm a peer to ask it anything', { kind: 'error' }); return }
    const r = await askOnce(name, text, false)
    if (!r || r.error) { toast((r && r.error) || 'could not send the ask', { kind: 'error' }); return }
    elAskText.value = ''
  }

  const updateSendLabel = () => MCX.setText(elAskSendBtn, altHeld ? 'Dry run' : shiftHeld ? 'Send to all' : 'Send')
  const updateDropLabel = () => {
    if (!elDropBtn) return
    MCX.setText(elDropBtn, altHeld ? 'Dry run' : shiftHeld ? 'Note first' : (metaHeld || ctrlHeld) ? 'Drop pinned' : 'Drop')
  }

  const onWindowKeydown = (ev) => {
    if (ev.key === 'Shift') { shiftHeld = true; updateSendLabel(); updateDropLabel() }
    else if (ev.key === 'Alt') { altHeld = true; updateSendLabel(); updateDropLabel() }
    else if (ev.key === 'Meta') { metaHeld = true; updateDropLabel() }
    else if (ev.key === 'Control') { ctrlHeld = true; updateDropLabel() }
  }
  const onWindowKeyup = (ev) => {
    if (ev.key === 'Shift') { shiftHeld = false; updateSendLabel(); updateDropLabel() }
    else if (ev.key === 'Alt') { altHeld = false; updateSendLabel(); updateDropLabel() }
    else if (ev.key === 'Meta') { metaHeld = false; updateDropLabel() }
    else if (ev.key === 'Control') { ctrlHeld = false; updateDropLabel() }
  }
  const resetHeldModifiers = () => {
    shiftHeld = false; altHeld = false; metaHeld = false; ctrlHeld = false
    updateSendLabel(); updateDropLabel()
  }

  // ------------------------------------------------------------ the jobs

  const jobListOrEmpty = () => (S.peers && Array.isArray(S.peers.jobs) ? S.peers.jobs : [])

  const REMOTE_STALE_MS = 45_000

  // The relay sends at most this many landed rows per job.
  const LANDED_ROWS_SHOWN = 5

  const renderJobFiles = (host, j) => {
    host.textContent = ''
    // A landed receive job lists what actually landed, never the offer as the
    // sender wrote it: a path the receiver refused was never written anywhere,
    // so it is listed as refused rather than as a file.
    const landedHere = j.side === 'recv' && j.state === 'landed' && Array.isArray(j.landed)
    const files = landedHere ? j.landed : Array.isArray(j.files) ? j.files : []
    for (const f of files) host.appendChild(el('div', 'jobfileline', f.path))
    if (landedHere) {
      if (files.length >= LANDED_ROWS_SHOWN) host.appendChild(el('div', 'jobfilemore', 'more in the inbox — o copies its path'))
    } else {
      const total = Number(j.fileCount) || files.length
      if (total > files.length) host.appendChild(el('div', 'jobfilemore', '+' + (total - files.length) + ' more'))
    }
    for (const r of Array.isArray(j.refusedPaths) ? j.refusedPaths : []) {
      if (!r || typeof r.path !== 'string') continue
      const line = el('div', 'jobfileline jobfilerefused', 'refused: ' + r.path)
      if (typeof r.reason === 'string') line.title = r.reason
      host.appendChild(line)
    }
  }

  const JOB_ROW = {
    key: (j) => j.id,
    create: () => {
      const row = el('div', 'jobrow')
      const head = el('div', 'jobhead')
      head.appendChild(el('span', 'jobdir'))
      head.appendChild(el('span', 'jobpeer'))
      head.appendChild(el('span', 'jobcount'))
      head.appendChild(el('span', 'jobbytes'))
      head.appendChild(el('span', 'jobchip chip'))
      // Built once, shown only for a send job carrying the other side's
      // report, and only that.
      head.appendChild(el('span', 'jobremote'))
      head.appendChild(el('span', 'jobfilter', 'no filter'))
      head.appendChild(el('span', 'jobpin', 'pinned'))
      row.appendChild(head)

      row.appendChild(el('div', 'jobreason'))
      row.appendChild(el('div', 'jobrefused'))
      row.appendChild(el('div', 'jobfiles'))

      const copyRow = el('div', 'jobcopyrow')
      const destInput = el('input', 'peerinput jobdestinput')
      destInput.type = 'text'
      destInput.placeholder = 'destination directory'
      copyRow.appendChild(destInput)
      const copyGo = el('button', 'btn go jobcopygo', 'Copy')
      copyGo.type = 'button'
      copyRow.appendChild(copyGo)
      row.appendChild(copyRow)

      // A click selects the job and a double-click opens or closes its file
      // list: what J/K and Enter do, for a pointer.
      const jobIdOf = () => row.getAttribute('data-job-id')
      head.addEventListener('click', () => {
        const id = jobIdOf()
        if (!id) return
        selectedJobId = id
        render()
      })
      head.addEventListener('dblclick', (ev) => {
        const id = jobIdOf()
        if (!id) return
        ev.preventDefault()
        selectedJobId = id
        if (expandedJobs.has(id)) expandedJobs.delete(id)
        else expandedJobs.add(id)
        render()
      })

      return row
    },
    update: (row, j) => {
      MCX.setAttr(row, 'data-state', j.state)
      MCX.setAttr(row, 'data-job-id', j.id)
      MCX.setAttr(row, 'data-selected', selectedJobId === j.id ? 'true' : null)

      MCX.setText(row.querySelector('.jobdir'), j.side === 'send' ? '↑' : '↓')
      MCX.setText(row.querySelector('.jobpeer'), j.peer)
      const n = Number(j.fileCount) || 0
      MCX.setText(row.querySelector('.jobcount'), n + (n === 1 ? ' file' : ' files'))
      MCX.setText(row.querySelector('.jobbytes'), fmtBytes(j.sent) + ' / ' + fmtBytes(j.bytes))

      const chip = row.querySelector('.jobchip')
      const filtering = j.state === 'filtering'
      MCX.setText(chip, filtering ? 'filtering… ' + ago(jobSince(j)) : j.state)
      MCX.setAttr(chip, 'data-state', j.state)

      const remoteEl = row.querySelector('.jobremote')
      const remote = j.side === 'send' && j.remote && typeof j.remote.state === 'string' ? j.remote : null
      if (remote) {
        const stale = !Number.isFinite(remote.at) || (Date.now() - remote.at) > REMOTE_STALE_MS
        MCX.setText(remoteEl, 'their ' + (stale ? '…' : remote.state))
      }
      MCX.show(remoteEl, !!remote)

      MCX.show(row.querySelector('.jobfilter'), j.filtered === false)
      MCX.show(row.querySelector('.jobpin'), j.pinned === true)

      const reasonEl = row.querySelector('.jobreason')
      const reasonText = j.state === 'refused' ? j.reason : j.state === 'failed' ? j.error : (remote && remote.reason ? remote.reason : null)
      MCX.setText(reasonEl, reasonText || '')
      MCX.show(reasonEl, !!reasonText)

      const refCount = Number(j.refusedCount) || 0
      const refusedEl = row.querySelector('.jobrefused')
      MCX.setText(refusedEl, refCount > 0 ? refCount + (refCount === 1 ? ' path refused' : ' paths refused') : '')
      MCX.show(refusedEl, refCount > 0)

      const filesEl = row.querySelector('.jobfiles')
      const expanded = expandedJobs.has(j.id)
      MCX.show(filesEl, expanded)
      if (expanded) renderJobFiles(filesEl, j)

      const copyRow = row.querySelector('.jobcopyrow')
      const showCopy = copyPromptJobId === j.id
      MCX.show(copyRow, showCopy)
      if (showCopy) {
        const destInput = copyRow.querySelector('.jobdestinput')
        elCopyDestInput = destInput
        const go = () => { void copyJobInto(j.id, destInput.value.trim()) }
        destInput.onkeydown = (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); go() }
          else if (ev.key === 'Escape') { ev.preventDefault(); copyPromptJobId = null; render() }
        }
        copyRow.querySelector('.jobcopygo').onclick = go
      }
    },
  }

  /** `job/copy`'s answer names what actually moved; the destination field
   *  closes only once it has. */
  const copyJobInto = async (id, dest) => {
    if (!dest) { toast('enter a destination', { kind: 'error' }); return }
    const r = await post('/api/peer/job/copy', { id, dest })
    if (!r || r.error) { toast((r && r.error) || 'could not copy', { kind: 'error' }); return }
    const copied = Array.isArray(r.copied) ? r.copied.length : 0
    const skipped = Array.isArray(r.skipped) ? r.skipped.length : 0
    toast(copied + (copied === 1 ? ' file copied' : ' files copied') + (skipped ? ', ' + skipped + ' skipped' : ''))
    copyPromptJobId = null
    render()
  }

  const tickJobs = () => {
    if (!jobsListHost) return
    const list = jobListOrEmpty()
    for (const node of jobsListHost.children) {
      const key = MCX.keyOf(node)
      if (key == null) continue
      const j = list.find((x) => String(x.id) === key)
      if (j && j.state === 'filtering') MCX.setText(node.querySelector('.jobchip'), 'filtering… ' + ago(jobSince(j)))
    }
  }

  /** The jobs region's one interval, the same shape as the ask log's: it
   *  exists only while some job is actually filtering. */
  const ensureJobTicker = () => {
    const anyFiltering = jobListOrEmpty().some((j) => j.state === 'filtering')
    if (anyFiltering && !jobTickTimer) jobTickTimer = setInterval(tickJobs, 1000)
    else if (!anyFiltering && jobTickTimer) { clearInterval(jobTickTimer); jobTickTimer = null }
  }

  const renderDropEnvelope = (r) => {
    if (!r) { MCX.show(elDropEnvelope, false); return }
    const lines = []
    lines.push(r.filtered === false ? 'no filter (' + (r.filterReason || 'not installed') + ')' : r.filtered ? 'filtered' : 'not run')
    if (r.reason) lines.push('refused: ' + r.reason)
    const files = r.manifest && Array.isArray(r.manifest.files) ? r.manifest.files : []
    if (files.length) {
      lines.push('files:')
      for (const f of files) lines.push('  ' + f.path + ' (' + fmtBytes(f.size) + ')')
    }
    if (Array.isArray(r.refused) && r.refused.length) {
      lines.push('left out:')
      for (const x of r.refused) lines.push('  ' + (x.path || '?') + ': ' + x.reason)
    }
    if (r.stderr) { lines.push('stderr:'); lines.push(r.stderr) }
    MCX.setText(elDropEnvelope, lines.join('\n'))
    MCX.show(elDropEnvelope, true)
  }

  const onDropClick = async (ev) => {
    const peer = selectedPeerName
    if (!peer) { toast('select a peer first (j/k)', { kind: 'error' }); return }
    if (ev.shiftKey) { elDropNote.focus(); return }
    const paths = splitDropPaths(elDropPaths.value)
    if (!paths.length) { toast('enter at least one absolute path', { kind: 'error' }); return }
    const note = elDropNote.value.trim() || undefined

    if (ev.altKey) {
      const r = await post('/api/peer/filter/test', { peer, paths, note })
      if (!r || r.error) toast((r && r.error) || 'could not test the filter', { kind: 'error' })
      renderDropEnvelope(r)
      return
    }

    const pinned = ev.metaKey || ev.ctrlKey
    const r = await post('/api/peer/' + peer + '/drop', { paths, note, pinned })
    if (!r || r.error) { toast((r && r.error) || 'could not drop', { kind: 'error' }); return }
    if (Array.isArray(r.refused) && r.refused.length) {
      toast(r.refused.length + (r.refused.length === 1 ? ' path was left out' : ' paths were left out'), { kind: 'error' })
    }
    elDropPaths.value = ''
    elDropNote.value = ''
  }

  /** A liaison turn's proposed drop, opened here with a modifier held rather
   *  than sent: the pane moves to this panel, the composer is aimed at the
   *  turn's own peer and filled from the proposal, and the note has focus.
   *  With `dryRun` the composer's own dry run follows, so the manifest shows
   *  exactly where this panel always shows it. Nothing here posts a drop. */
  const openDropComposer = ({ peer, paths, note, dryRun } = {}) => {
    if (!elDropPaths || typeof peer !== 'string' || !peer) return
    if (setView) setView('peering')
    selectedPeerName = peer
    elDropPaths.value = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string').join(String.fromCharCode(10))
    elDropNote.value = typeof note === 'string' ? note : ''
    renderDropEnvelope(null)
    render()
    elDropNote.focus()
    if (dryRun) void onDropClick({ altKey: true, shiftKey: false, metaKey: false, ctrlKey: false })
  }

  const renderJobsRegion = (p) => {
    MCX.setText(elDropTarget, selectedPeerName ? 'to ' + selectedPeerName : 'select a peer (j/k) to drop files')
    elDropBtn.disabled = !selectedPeerName
    const jobs = Array.isArray(p.jobs) ? p.jobs : []
    MCX.reconcile(jobsListHost, jobs, JOB_ROW)
    MCX.show(elJobsEmpty, jobs.length === 0)
  }

  /** The arrival notice is pane-only, never announced from the first
   *  payload after a load or a reconnect (see the 'open' registration in
   *  attach(), which resets `sawJobsSincePeersOpen`) -- only a transition this
   *  pane actually watched happen. */
  const noteJobArrivals = (p) => {
    const jobs = Array.isArray(p && p.jobs) ? p.jobs : []
    if (sawJobsSincePeersOpen) {
      for (const j of jobs) {
        const prevState = prevJobStates.get(j.id)
        if (prevState && prevState !== 'landed' && j.side === 'recv' && j.state === 'landed') {
          const n = Number(j.fileCount) || (Array.isArray(j.files) ? j.files.length : 0)
          toast(n + (n === 1 ? ' file from ' : ' files from ') + j.peer + ' landed')
          unreadJobs++
        }
      }
    } else {
      sawJobsSincePeersOpen = true
    }
    prevJobStates = new Map(jobs.map((j) => [j.id, j.state]))
    updateJobsTabBadge()
  }

  const updateJobsTabBadge = () => {
    const badge = document.getElementById('c-peer-jobs-unread')
    if (!badge) return
    MCX.setText(badge, String(unreadJobs))
    MCX.show(badge, unreadJobs > 0)
    MCX.toggle(badge, 'busy', unreadJobs > 0)
  }

  const clearJobsUnread = () => {
    if (unreadJobs === 0) return
    unreadJobs = 0
    updateJobsTabBadge()
  }

  // -------------------------------------------------------- the key layer

  const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

  const peerListOrEmpty = () => (S.peers && Array.isArray(S.peers.list) ? S.peers.list : [])

  const onPanelKeydown = (ev) => {
    if (!S.peers) return
    if (ev.target && FORM_TAGS.has(ev.target.tagName)) return
    const list = peerListOrEmpty()
    const key = ev.key

    if (key === 'p' || key === 'P') {
      ev.preventDefault()
      elPairBtn.click()
      return
    }
    if (key === 'a' || key === 'A') {
      ev.preventDefault()
      if (elAskText) elAskText.focus()
      return
    }
    if (key === 'd' || key === 'D') {
      ev.preventDefault()
      if (elDropPaths) elDropPaths.focus()
      return
    }
    // Plain j/k keep moving peers, exactly as before; shifted J/K move the
    // job selection instead, so the two lists have independent cursors.
    if (key === 'j' || key === 'k') {
      ev.preventDefault()
      if (!list.length) return
      const i = list.findIndex((p) => p.name === selectedPeerName)
      if (key === 'j') selectedPeerName = i < 0 ? list[0].name : list[Math.min(i + 1, list.length - 1)].name
      else selectedPeerName = i < 0 ? list[list.length - 1].name : list[Math.max(i - 1, 0)].name
      render()
      return
    }
    if (key === 'J' || key === 'K') {
      ev.preventDefault()
      const jobs = jobListOrEmpty()
      if (!jobs.length) return
      const i = jobs.findIndex((j) => j.id === selectedJobId)
      if (key === 'J') selectedJobId = i < 0 ? jobs[0].id : jobs[Math.min(i + 1, jobs.length - 1)].id
      else selectedJobId = i < 0 ? jobs[jobs.length - 1].id : jobs[Math.max(i - 1, 0)].id
      render()
      return
    }
    if (key === 'Enter') {
      ev.preventDefault()
      if (selectedJobId) {
        if (expandedJobs.has(selectedJobId)) expandedJobs.delete(selectedJobId)
        else expandedJobs.add(selectedJobId)
        render()
        return
      }
      if (!selectedPeerName) return
      rosterOverride.set(selectedPeerName, !rosterExpanded(selectedPeerName, list.length))
      render()
      return
    }
    if (key === 'x' || key === 'X') {
      ev.preventDefault()
      if (!selectedJobId) return
      const id = selectedJobId
      if (!(cancelArmed && cancelArmed.id === id && Date.now() < cancelArmed.until)) {
        disarmCancel()
        cancelArmed = { id, until: Date.now() + FORGET_ARM_MS, timer: setTimeout(disarmCancel, FORGET_ARM_MS) }
        toast('press x again to cancel', { kind: 'error' })
        return
      }
      disarmCancel()
      void (async () => {
        const r = await post('/api/peer/job/cancel', { id })
        if (!r || r.error) toast((r && r.error) || 'could not cancel', { kind: 'error' })
      })()
      return
    }
    if (key === 'o' || key === 'O') {
      ev.preventDefault()
      if (!selectedJobId) return
      const j = jobListOrEmpty().find((x) => x.id === selectedJobId)
      if (!j || j.side !== 'recv' || j.state !== 'landed' || !j.inboxPath) { toast('select a landed drop first', { kind: 'error' }); return }
      expandedJobs.add(j.id)
      navigator.clipboard?.writeText(j.inboxPath)
      toast('copied')
      render()
      return
    }
    // Read off ev.code, never ev.key: on some layouts Option+C composes a
    // different character, the same reason quick-access.js reads digits off
    // ev.code under Alt.
    if (ev.code === 'KeyC') {
      ev.preventDefault()
      if (!selectedJobId) return
      const j = jobListOrEmpty().find((x) => x.id === selectedJobId)
      if (!j || j.side !== 'recv' || j.state !== 'landed') { toast('select a landed drop first', { kind: 'error' }); return }
      if (ev.altKey) {
        const s = focused ? focused() : null
        if (!s || !s.root) { toast('no focused session', { kind: 'error' }); return }
        void copyJobInto(j.id, s.root)
        return
      }
      copyPromptJobId = j.id
      render()
      if (elCopyDestInput) elCopyDestInput.focus()
      return
    }
    if (key === 'Escape') {
      ev.preventDefault()
      selectedPeerName = null
      selectedJobId = null
      copyPromptJobId = null
      render()
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()
      return
    }
  }

  const onPanelFocusIn = () => { MCX.show(elHint, true); clearJobsUnread() }
  const onPanelFocusOut = (ev) => { if (!panelEl.contains(ev.relatedTarget)) MCX.show(elHint, false) }
  const onPanelClick = (ev) => {
    if (ev.target.closest('button, input, textarea, select, a')) return
    panelEl.focus()
  }

  // ------------------------------------------------------------ rendering

  const ensurePeerEmpty = (host, show) => {
    if (!peerEmpty) {
      peerEmpty = el('div', 'peerlist-empty empty', 'No peers yet — pair with another instance above.')
      host.parentNode.insertBefore(peerEmpty, host.nextSibling)
    }
    MCX.show(peerEmpty, show)
  }

  const renderLinkRegion = (p) => {
    MCX.setText(elStatus, statusText(p))

    if (document.activeElement !== elSelf) elSelf.value = p.self || ''
    if (document.activeElement !== elBind) elBind.value = p.bind || ''
    if (document.activeElement !== elPort) elPort.value = Number.isFinite(p.port) ? String(p.port) : ''
    MCX.setText(elEnableBtn, p.enabled ? 'Disable' : 'Enable')

    elPairBtn.disabled = !p.listening

    const showFp = !!p.fingerprint
    MCX.show(elFp, showFp)
    const [a, b] = fpLines(p.fingerprint)
    MCX.setText(elFpLine1, a)
    MCX.setText(elFpLine2, b)

    hostVisible = p.bind === '0.0.0.0' || p.bind === '::'
    MCX.show(elHostRow, hostVisible)

    if (pairingCode && !p.pairing) hideCode()
    else if (pairingCode) tickCountdown()
  }

  const renderPeersRegion = (p) => {
    const list = Array.isArray(p.list) ? p.list : []
    MCX.reconcile(listHost, list, makePeerRowSpec(list.length))
    ensurePeerEmpty(listHost, list.length === 0)
  }

  const renderAsksRegion = (p) => {
    renderAskComposer(p)
    const asks = Array.isArray(p.asks) ? p.asks : []
    MCX.reconcile(asksListHost, asks, ASK_ROW)
    MCX.show(elAskEmpty, asks.length === 0)
  }

  const render = () => {
    ensureAskTicker()
    ensureJobTicker()

    const p = S.peers
    const count = p && Array.isArray(p.list) ? p.list.length : 0
    const countEl = document.getElementById('c-peers')
    if (countEl) MCX.setText(countEl, String(count))

    const predates = p === undefined
    MCX.show(elPredates, predates)
    MCX.show(elLinkBox, !predates)
    if (listHost) MCX.show(listHost, !predates)
    if (asksHost) MCX.show(asksHost, !predates)
    if (jobsHost) MCX.show(jobsHost, !predates)
    if (predates) { if (peerEmpty) MCX.show(peerEmpty, false); return }

    renderLinkRegion(p)
    renderPeersRegion(p)
    renderAsksRegion(p)
    renderJobsRegion(p)
  }

  // -------------------------------------------------------------- building

  const buildLinkSkeleton = (host) => {
    elPredates = el('div', 'peerpredates', 'This relay predates peering. Restart it to use this panel.')
    host.appendChild(elPredates)

    elLinkBox = el('div', 'peerlink')
    host.appendChild(elLinkBox)

    elStatus = el('div', 'peerstatus')
    elLinkBox.appendChild(elStatus)

    const form = el('form', 'peerenable')
    elSelf = el('input', 'peerinput')
    elSelf.type = 'text'; elSelf.autocomplete = 'off'; elSelf.spellcheck = false
    form.appendChild(fieldRow('name', elSelf))
    elBind = el('input', 'peerinput')
    elBind.type = 'text'; elBind.autocomplete = 'off'; elBind.spellcheck = false
    form.appendChild(fieldRow('bind', elBind))
    elPort = el('input', 'peerinput')
    elPort.type = 'number'; elPort.min = '0'; elPort.max = '65535'
    form.appendChild(fieldRow('port', elPort))
    elEnableBtn = el('button', 'btn go', 'Enable')
    elEnableBtn.type = 'submit'
    form.appendChild(elEnableBtn)
    form.addEventListener('submit', onEnableSubmit)
    elLinkBox.appendChild(form)

    elFp = el('div', 'peerfp')
    elFpLine1 = el('div', 'peerfpline')
    elFpLine2 = el('div', 'peerfpline')
    elFp.appendChild(elFpLine1)
    elFp.appendChild(elFpLine2)
    elLinkBox.appendChild(elFp)

    const pairBox = el('div', 'peerpair')
    elHostInput = el('input', 'peerinput')
    elHostInput.type = 'text'
    elHostInput.placeholder = 'address the other instance can reach'
    elHostInput.autocomplete = 'off'
    elHostRow = fieldRow('host', elHostInput)
    elHostRow.classList.add('peerhostrow')
    pairBox.appendChild(elHostRow)

    elPairBtn = el('button', 'btn', 'Pair')
    elPairBtn.type = 'button'
    elPairBtn.disabled = true
    elPairBtn.addEventListener('click', onPairClick)
    pairBox.appendChild(elPairBtn)

    elCodeBox = el('div', 'peercode')
    elCodeText = el('div', 'peercodetext')
    elCodeBox.appendChild(elCodeText)
    const copyBtn = el('button', 'btn', 'Copy')
    copyBtn.type = 'button'
    copyBtn.addEventListener('click', onCopyClick)
    elCodeBox.appendChild(copyBtn)
    elCodeCountdown = el('span', 'peercodecountdown')
    elCodeBox.appendChild(elCodeCountdown)
    pairBox.appendChild(elCodeBox)
    elLinkBox.appendChild(pairBox)

    const acceptForm = el('form', 'peeraccept')
    elAcceptCode = el('textarea', 'peeraccepttext')
    elAcceptCode.placeholder = 'paste a pairing code'
    acceptForm.appendChild(elAcceptCode)
    elAcceptName = el('input', 'peerinput')
    elAcceptName.type = 'text'
    elAcceptName.placeholder = 'what you call the other instance'
    elAcceptName.autocomplete = 'off'
    acceptForm.appendChild(elAcceptName)
    const acceptBtn = el('button', 'btn go', 'Accept')
    acceptBtn.type = 'submit'
    acceptForm.appendChild(acceptBtn)
    acceptForm.addEventListener('submit', onAcceptSubmit)
    elLinkBox.appendChild(acceptForm)

    MCX.show(elCodeBox, false)
    MCX.show(elHostRow, false)
  }

  const buildAsksSkeleton = (host) => {
    const composer = el('div', 'peerasker')

    elAskSelect = el('select', 'peerinput peerselect')
    composer.appendChild(elAskSelect)

    elAskText = el('textarea', 'peerinput peerasktext')
    elAskText.placeholder = 'ask the confirmed peer anything'
    elAskText.rows = 2
    elAskText.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return
      ev.preventDefault()
      void onAskSend({ shiftKey: ev.shiftKey, altKey: ev.altKey })
    })
    composer.appendChild(elAskText)

    elAskSendBtn = el('button', 'btn go peerasksend', 'Send')
    elAskSendBtn.type = 'button'
    elAskSendBtn.addEventListener('click', (ev) => { void onAskSend({ shiftKey: ev.shiftKey, altKey: ev.altKey }) })
    composer.appendChild(elAskSendBtn)

    host.appendChild(composer)

    elAskEnvelope = el('pre', 'askenvelope')
    MCX.show(elAskEnvelope, false)
    host.appendChild(elAskEnvelope)

    elAskEmpty = el('div', 'asklog-empty empty', 'No asks yet.')
    host.appendChild(elAskEmpty)

    asksListHost = el('div', 'asklog')
    host.appendChild(asksListHost)
  }

  const buildJobsSkeleton = (host) => {
    const composer = el('div', 'jobcomposer')

    elDropTarget = el('div', 'jobtarget')
    composer.appendChild(elDropTarget)

    elDropPaths = el('textarea', 'peerinput jobdroppaths')
    elDropPaths.placeholder = 'absolute paths, one per line'
    elDropPaths.rows = 3
    composer.appendChild(elDropPaths)

    elDropNote = el('input', 'peerinput jobdropnote')
    elDropNote.type = 'text'
    elDropNote.placeholder = 'note (optional)'
    composer.appendChild(elDropNote)

    elDropBtn = el('button', 'btn go jobdropbtn', 'Drop')
    elDropBtn.type = 'button'
    elDropBtn.addEventListener('click', (ev) => { void onDropClick(ev) })
    composer.appendChild(elDropBtn)

    host.appendChild(composer)

    elDropEnvelope = el('pre', 'askenvelope')
    MCX.show(elDropEnvelope, false)
    host.appendChild(elDropEnvelope)

    elJobsEmpty = el('div', 'joblog-empty empty', 'No drops yet.')
    host.appendChild(elJobsEmpty)

    jobsListHost = el('div', 'joblog')
    host.appendChild(jobsListHost)
  }

  const buildHint = (body) => {
    elHint = el('div', 'peerhint',
      'p pair · a ask · d drop · j/k peers · J/K jobs · enter roster/expand · x×2 cancel · o inbox path · ' +
      'c copy into · ⌥c copy to focus · esc leave · ⇧ all/note first · ⌥ dry run')
    MCX.show(elHint, false)
    body.insertBefore(elHint, body.firstChild)
  }

  // ------------------------------------------------------------------ attach

  const attach = (deps) => {
    S = deps.S; post = deps.post; toast = deps.toast; el = deps.el; ago = deps.ago
    fmtBytes = deps.fmtBytes; focused = deps.focused
    renderOrchTranscript = deps.renderOrchTranscript
    setView = deps.setView

    panelEl = document.getElementById('peer-panel')
    const bodyNode = document.getElementById('peer-body')
    const linkNode = document.getElementById('peer-link')
    listHost = document.getElementById('peer-list')
    asksHost = document.getElementById('peer-asks')
    jobsHost = document.getElementById('peer-jobs')
    if (linkNode) buildLinkSkeleton(linkNode)
    if (asksHost) buildAsksSkeleton(asksHost)
    if (jobsHost) buildJobsSkeleton(jobsHost)
    if (bodyNode) buildHint(bodyNode)

    if (panelEl) {
      // Only while the panel sits in Telemetry does it fill that view, with
      // the other panels behind this toggle; in its own tab there is nothing
      // to hide and no toggle.
      const phead = panelEl.querySelector('.phead')
      const viewEl = panelEl.closest('#view-telemetry')
      if (phead && viewEl) {
        const othersBtn = el('button', 'btn peer-otherstoggle', 'show other panels')
        othersBtn.type = 'button'
        othersBtn.addEventListener('click', () => {
          const on = viewEl.classList.toggle('peer-others')
          MCX.setText(othersBtn, on ? 'hide other panels' : 'show other panels')
        })
        phead.appendChild(othersBtn)
      }
      panelEl.addEventListener('keydown', onPanelKeydown)
      panelEl.addEventListener('focusin', onPanelFocusIn)
      panelEl.addEventListener('focusout', onPanelFocusOut)
      panelEl.addEventListener('click', onPanelClick)
    }
    addEventListener('keydown', onWindowKeydown)
    addEventListener('keyup', onWindowKeyup)
    addEventListener('blur', resetHeldModifiers)
    document.addEventListener('visibilitychange', () => { if (document.hidden) resetHeldModifiers() })

    const onPeers = (p) => { S.peers = p; lastAsksPayloadAt = Date.now(); noteJobArrivals(p); render() }
    MCE.onField('peers', onPeers)
    MCE.on('peers', onPeers)
    // A fresh connection -- the very first one, or any reconnect -- means the
    // next 'peers' payload's jobs are a starting point to learn, never a batch
    // of arrivals to announce.
    MCE.on('open', () => { sawJobsSincePeersOpen = false })

    render()
  }

  return { attach, render, openDropComposer }
})()

// A liaison turn is labelled here, at load time, rather than inside attach():
// this statement runs the moment this script is parsed, which is before
// app.js — and therefore before app.js's own orchestrator wiring — ever
// runs. So by the time that later handling looks for a turn matching an
// incoming frame's id, one already exists with the right question text, and
// there is nothing left to fold in after the fact. `typeof S === 'undefined'`
// is how this guards against firing before app.js's own S exists yet: read
// bare, S is simply not declared at the point this line first runs, and
// `typeof` on an undeclared name answers 'undefined' rather than throwing.
MCE.on('orchestrator', (d) => {
  if (!d || !d.id || !d.peer || typeof S === 'undefined' || !Array.isArray(S.orchTurns)) return
  if (S.orchTurns.some((t) => t.serverId === d.id)) return
  S.orchTurns = [...S.orchTurns, {
    id: 'peer-' + d.id, serverId: d.id, question: 'from ' + d.peer + ': ' + (d.question || ''),
    peer: d.peer, askId: typeof d.askId === 'string' ? d.askId : null,
    answer: '', streaming: true, actions: [], rejected: [], error: null,
  }].slice(-20)
})
