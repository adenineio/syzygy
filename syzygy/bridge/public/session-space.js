/* Syzygy -- the session-space tab.
 *
 * A CLASSIC script, loaded after reconcile.js and session-space-math.js. Its
 * only top-level binding is MCZ, referenced bare, and nothing runs at
 * evaluation time. MCZM and MCX are referenced bare too. The sandbox stage is
 * an ES module that may not have loaded yet, so it is always read as
 * `window.MCGS`, optionally, and `derive()` answers false until it has.
 *
 * Two rules to keep if you edit this file:
 *   - NEVER assign `className` on a stage card. The stage owns its classes;
 *     toggle individual ones through MCX, and never append a node into a
 *     card's DOM.
 *   - Nothing is written to the stage's own per-mount record but keys
 *     prefixed `szg`. The record is read in exactly five places: its cards
 *     map (and each card's `body`, `el` and `obj`), its projection scale
 *     `k`, its own vertical reach `extY`, and the mount node's rect. `obj`'s
 *     `position.z` is the one field of it this file writes -- the stage's
 *     own body stepping never touches z, only x and y, so a value set there
 *     holds without a fight; the mount node's own CSS height, read off
 *     `extY`, is the other. */
'use strict'

const MCZ = (() => {
  const NAME = 'space-cards'
  const BASE = 'session-card'

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

  /** The ids of the session refs in a carried set; a pane ref is never a card. */
  const sessionIds = (held) => {
    const out = new Set()
    for (const ref of Array.isArray(held) ? held : []) {
      if (ref && ref.kind === 'session' && ref.id != null) out.add(String(ref.id))
    }
    return out
  }

  /** Each carried card's target before the base updates. */
  const heldTargets = (ctx) => {
    const s = ctx.state
    const before = new Map()
    for (const id of s.szgHome.keys()) {
      const c = s.cards.get(id)
      if (c) before.set(id, { x: c.body.tx, y: c.body.ty })
    }
    return before
  }

  /** The base retargets a body only when it lays the cards out again, so a
   *  carried card whose target moved across its update was given a new slot,
   *  and that slot is its home now. */
  const refreshHomes = (ctx, before) => {
    const s = ctx.state
    for (const [id, was] of before) {
      const c = s.cards.get(id)
      if (!c) continue
      if (c.body.tx !== was.x || c.body.ty !== was.y) s.szgHome.set(id, { x: c.body.tx, y: c.body.ty })
    }
  }

  /** A card's group halo: the group id as an attribute and its colour as a
   *  custom property, written only when either changes. */
  const paintTint = (s, c, tint) => {
    const group = tint && typeof tint === 'object' && tint.id != null ? String(tint.id) : null
    const color = group !== null && typeof tint.color === 'string' && tint.color ? tint.color : null
    const was = s.szgGroupOf.get(c.el)
    if (was ? was.group === group && was.color === color : group === null) return
    MCX.setAttr(c.el, 'data-space-group', group)
    if (color) c.el.style.setProperty('--szg-grp', color)
    else c.el.style.removeProperty('--szg-grp')
    if (group === null) s.szgGroupOf.delete(c.el)
    else s.szgGroupOf.set(c.el, { group, color })
  }

  /** Brings the cards in line with a carried set and a tint table, as a diff.
   *  Every card is stamped with its session id once, so a hit-test can read
   *  it off whatever card is under the pointer. A card newly carried records
   *  its home -- its target, which is its slot rather than where it has
   *  drifted to -- and is marked carried; a card no longer carried is sent
   *  back to that home, unmarked, and its depth cleared -- the stage never
   *  resets `position.z` on its own, so a card that was ever swept into the
   *  stack would stay sunk behind the others forever otherwise. A carried
   *  ref whose card has not arrived is kept and skipped until it does. */
  const szgSet = (ctx, held, tints) => {
    const s = ctx.state
    s.szgHeld = Array.isArray(held) ? held.slice() : []
    const bySession = tints && typeof tints === 'object' && tints.bySession && typeof tints.bySession === 'object'
      ? tints.bySession
      : {}
    s.szgTints = { ...(tints && typeof tints === 'object' ? tints : {}), bySession }
    const want = sessionIds(s.szgHeld)
    for (const [id, home] of s.szgHome) {
      const c = s.cards.get(id)
      if (c && want.has(id)) continue
      if (c) {
        c.body.to(home.x, home.y)
        MCX.toggle(c.el, 'carried', false)
        if (c.obj && c.obj.position.z !== 0) c.obj.position.z = 0
      }
      s.szgHome.delete(id)
    }
    for (const [id, c] of s.cards) {
      if (!s.szgSeen.has(c.el)) {
        MCX.setAttr(c.el, 'data-space-id', id)
        s.szgSeen.add(c.el)
      }
      if (want.has(id) && !s.szgHome.has(id)) {
        s.szgHome.set(id, { x: c.body.tx, y: c.body.ty })
        MCX.toggle(c.el, 'carried', true)
      }
      paintTint(s, c, hasOwn(bySession, id) ? bySession[id] : null)
    }
  }

  /** Grows the mount node's own CSS height to the layout's full vertical
   *  reach, read off the base's own `extY` -- so a grid taller than the view
   *  scrolls, in a wrap this file's own CSS makes scrollable, rather than
   *  ever asking the base to zoom the cards down to fit. A shorter reach
   *  writes a shorter height too; CSS's own min-height is what keeps the box
   *  no shorter than the visible stage, not this. Idempotent, so calling it
   *  on every update whether or not the reach actually changed costs nothing
   *  but a style read. */
  const sizeStage = (ctx) => {
    const px = MCZM.layoutHeight(ctx.state.extY) + 'px'
    if (ctx.node.style.height !== px) ctx.node.style.height = px
  }

  /** Pulls every following card toward the pointer, fanned in pick-up order
   *  and stacked in depth so the pile reads as a stack rather than a single
   *  flattened card. A card carried without following is never retargeted
   *  here, so it keeps its slot, its float and its depth. Runs after the
   *  base's frame, so it overrides that frame's target. The depth axis is
   *  `obj.position.z`, which the base's own body stepping never writes,
   *  only x and y, so setting it here fights nothing. */
  const magnetFrame = (ctx) => {
    const s = ctx.state
    if (!s.szgHeld.length || !s.szgPointer) return
    const rect = ctx.node.getBoundingClientRect()
    const at = MCZM.magnetTargets(s.szgHeld, s.szgPointer, rect, s.k)
    for (const t of at) {
      const c = s.cards.get(String(t.ref.id))
      if (!c) continue
      c.body.to(t.x, t.y)
      if (c.obj && Number.isFinite(t.z) && c.obj.position.z !== t.z) c.obj.position.z = t.z
    }
  }

  /** Registers `space-cards`: the stage's own session cards, which draw, lay
   *  out, tilt and fan exactly as they do in the gallery, with the carried
   *  set, the magnet and the group halo added on top. The carried set and the
   *  tints arrive as params (`szgHeld`, `szgTints`) on the stage's own
   *  update-in-place channel, `MCGS.mount` on the same node; the base ignores
   *  keys it does not know. Answers true once the component is in the stage's
   *  table, including when it already was. */
  const derive = () => {
    const stage = window.MCGS
    if (stage?.component?.(NAME)) return true
    const base = stage?.component?.(BASE)
    if (!base || typeof stage.register !== 'function') return false
    const comp = {
      ...base,
      mount(ctx) {
        base.mount(ctx)
        const s = ctx.state
        s.szgHeld = []                 // refs, in pick-up order
        s.szgHome = new Map()          // session id -> { x, y }, its slot while carried
        s.szgTints = { bySession: {} }
        s.szgSeen = new WeakSet()      // card elements already stamped with their id
        s.szgGroupOf = new WeakMap()   // card element -> { group, color } as painted
        s.szgPointer = null            // client coordinates, or null
        s.szgMove = (e) => { s.szgPointer = { x: e.clientX, y: e.clientY } }
        s.szgLeave = () => { s.szgPointer = null }
        ctx.node.addEventListener('pointermove', s.szgMove)
        ctx.node.addEventListener('pointerleave', s.szgLeave)
      },
      update(ctx, params, data) {
        const before = heldTargets(ctx)
        base.update(ctx, params, data)
        refreshHomes(ctx, before)
        szgSet(ctx, params?.szgHeld ?? [], params?.szgTints ?? { bySession: {} })
        sizeStage(ctx)
      },
      frame(ctx, t, dt) {
        base.frame(ctx, t, dt)
        magnetFrame(ctx)
      },
      unmount(ctx) {
        const s = ctx.state
        ctx.node.removeEventListener('pointermove', s.szgMove)
        ctx.node.removeEventListener('pointerleave', s.szgLeave)
        base.unmount(ctx)
      },
    }
    return stage.register(NAME, () => comp)
  }

  // ================================================================ the view
  // Everything below is the tab itself. `$`, `el`, `toast` and the rest
  // belong to app.js, which loads afterwards, so nothing binds until attach().
  let S = null, $ = null, el = null, post = null, toast = null, ago = null, nameOf = null, openDrawer = null

  /** What the tab is doing: a mode ('', 'magnet' or 'bucket'), the carried
   *  refs in pick-up order, the bucket slot being aimed at, the bucket being
   *  edited, and the session ids the current Option hold swept in. Gestures
   *  change it and call render(); render() only reads it. */
  const state = { mode: '', carried: [], aimed: null, editing: null, swept: [] }

  // The view's own on/off, so the observer never runs a transition twice.
  // `entered` makes the stage's dynamic import run at most once; `failed`
  // latches one failed import; `booted` is true once the import succeeded
  // and the cards component is in the stage's table, and gates every mount.
  let current = ''
  let entered = false
  let failed = false
  let booted = false
  // True once a snapshot arrived without a `groups` key: a relay that has
  // never heard of buckets.
  let predates = false
  let pollTimer = null

  const TMUX_POLL_MS = 5000
  // The sandbox owns these two settings and their storage; this view only
  // reads them.
  const CALM_KEY = 'szg.sandbox.calm'
  const FLYOUT_KEY = 'szg.flyout'
  const FLYOUT_DEFAULT = 'slide'

  /** A stored setting, or null when storage is unavailable. */
  const stored = (key) => { try { return localStorage.getItem(key) } catch (e) { return null } }

  // ------------------------------------------------------------ the buckets
  const KIND_LABEL = { 'tmux-group': 'tmux', prompt: 'prompt', files: 'files', together: 'together' }

  const chipSpec = {
    key: (row) => (row.add ? 'add' : 'slot:' + row.slot),
    create: (row) => {
      const n = el('button', row.add ? 'kchip kadd' : 'kchip')
      n.type = 'button'
      if (row.add) {
        n.dataset.add = '1'
        n.textContent = '+'
        n.dataset.tip = 'New bucket\nSaves a shape into the first empty slot.'
        return n
      }
      n.dataset.slot = String(row.slot)
      n.appendChild(el('span', 'kslot', String(row.slot)))
      n.appendChild(el('span', 'kname'))
      n.appendChild(el('span', 'kkind'))
      n.appendChild(el('span', 'kcount'))
      return n
    },
    update: (n, row) => {
      if (row.add) {
        MCX.show(n, !predates && row.room)
        return
      }
      MCX.show(n, !predates)
      const g = row.group
      MCX.toggle(n, 'empty', !g)
      MCX.toggle(n, 'aimed', state.aimed === row.slot)
      MCX.setAttr(n, 'data-group-id', g ? g.id : null)
      MCX.setAttr(n, 'data-kind', g ? g.kind : null)
      const color = g && typeof g.color === 'string' && g.color ? g.color : ''
      if (n.style.getPropertyValue('--szg-grp') !== color) {
        if (color) n.style.setProperty('--szg-grp', color)
        else n.style.removeProperty('--szg-grp')
      }
      MCX.setText(n.querySelector('.kname'), g ? g.name : 'empty')
      const kind = n.querySelector('.kkind')
      MCX.setText(kind, g ? KIND_LABEL[g.kind] ?? g.kind : '')
      MCX.show(kind, !!g)
      const count = n.querySelector('.kcount')
      const together = !!g && g.kind === 'together'
      MCX.setText(count, together && Array.isArray(g.members) ? String(g.members.length) : '')
      MCX.show(count, together)
      MCX.setAttr(n, 'data-tip', g ? `${g.name}\nSlot ${row.slot} · ${KIND_LABEL[g.kind] ?? g.kind}` : `Slot ${row.slot}\nNo bucket saved here.`)
    },
  }

  const renderBuckets = () => {
    const host = $('k-buckets')
    if (!host) return
    const slots = MCZM.bucketSlots(S.groups ?? [])
    const room = slots.some((r) => !r.group)
    MCX.reconcile(host, [...slots, { add: true, room }], chipSpec)
    const note = host.querySelector('.knote')
    if (note) MCX.show(note, predates)
  }

  // ----------------------------------------------------------- the tmux list
  const rowSpec = {
    key: (item) => item.key,
    create: (item) => {
      if (item.head) return el('div', 'khead')
      const n = el('div', 'krow')
      n.appendChild(el('span', 'klabel'))
      n.appendChild(el('span', 'kpane'))
      return n
    },
    update: (n, item) => {
      if (item.head) {
        MCX.setText(n, item.session || 'tmux')
        return
      }
      const r = item.row
      MCX.setAttr(n, 'data-target', r.target)
      MCX.setAttr(n, 'data-pane', r.pane)
      MCX.setAttr(n, 'data-tip', r.target)
      MCX.toggle(n, 'carried', state.carried.some((ref) => ref && ref.kind === 'pane' && ref.target === r.target))
      MCX.setText(n.querySelector('.klabel'), r.label)
      MCX.setText(n.querySelector('.kpane'), r.pane)
    },
  }

  const renderTmux = () => {
    const host = $('k-tmux')
    if (!host) return
    const reading = S.tmux ?? null
    const rows = MCZM.tmuxRows((S.tmux ?? { panes: [] }).panes, S.sessions ?? []).filter((r) => !r.onBoard)
    lastRows = rows
    // Rows arrive grouped by tmux session, so a heading goes in wherever the
    // session changes.
    const items = []
    let last = null
    for (const row of rows) {
      if (row.session !== last) {
        items.push({ key: 'head:' + row.session, head: true, session: row.session })
        last = row.session
      }
      items.push({ key: 'pane:' + row.target, row })
    }
    MCX.reconcile(host, items, rowSpec)
    MCX.setText($('c-ktmux'), String(rows.length))
    const quiet = $('k-tmuxquiet')
    if (quiet) {
      const panes = Array.isArray(reading?.panes) ? reading.panes.length : 0
      MCX.setText(quiet, panes ? 'every tmux pane is on the board' : 'no tmux panes')
      MCX.show(quiet, !!reading && rows.length === 0)
    }
  }

  // ------------------------------------------------------------- the stage
  /** Hands the carried set, the group tints and this tab's own tighter row
   *  clearance to the cards on the stage's own update-in-place channel. Only
   *  once the stage has booted: before that there is nothing to mount into.
   *  `cardGap` is the same number `stackOffsets` builds its depth step from,
   *  so the resting grid and the carried stack agree on what "close
   *  together" means; the gallery reads no such param and keeps its own,
   *  looser default. */
  const mountStage = () => {
    if (!booted) return
    window.MCGS?.mount?.($('k-stage'), NAME, {
      szgHeld: state.carried,
      szgTints: MCZM.groupTints(S.groups ?? [], S.sessions ?? []),
      cardGap: MCZM.STACK_GAP_PX,
    }, S.sessions ?? [])
  }

  const render = () => {
    if (!$) return
    const view = $('view-space')
    if (view) MCX.toggle(view, 'magnet', state.mode === 'magnet')
    renderBuckets()
    renderTmux()
    MCX.setText($('k-mode'), MCZM.modeLine({ ...state, groups: S.groups ?? [] }))
    mountStage()
  }

  /** The stage-wide motion settings, from the sandbox's own keys. An unknown
   *  or missing calm name resolves to the default; nothing is written back. */
  const applyStageSettings = () => {
    const calm = stored(CALM_KEY)
    const name = MCGM.CALM.includes(calm) ? calm : MCGM.CALM_DEFAULT
    window.MCGS?.setCalm?.(MCGM.calmScale(name, MCX.reducedMotion()))
    window.MCGS?.setFlyOut?.(stored(FLYOUT_KEY) ?? FLYOUT_DEFAULT)
  }

  /** Every entry boots the stage against this view's line canvas, since the
   *  sandbox may have moved it onto its own since this view was last shown.
   *
   *  First entry: import the stage and add the cards component to it. A
   *  failed import is one toast and a tab whose buckets and tmux list still
   *  work -- never asked again this page load. The import can finish after
   *  the view was left, and booting then would pull the stage off whichever
   *  view is showing, so the boot waits for the next entry instead. A later
   *  entry while the import is still in flight does nothing: the first
   *  entry's boot is still to come. */
  const enterStage = async () => {
    if (!entered) {
      entered = true
      try {
        await import('/sandbox-stage.js')
        if (!derive()) throw new Error('the stage has no session cards')
        booted = typeof window.MCGS?.mount === 'function'
      } catch (e) {
        failed = true
        booted = false
        toast('space stage unavailable', { kind: 'warn' })
      }
    }
    if (!booted || failed || current !== 'space') return
    window.MCGS?.boot?.({ glCanvas: $('k-lines') })
    applyStageSettings()
    render()
  }

  /** The sandbox hosts the same stage, and its observer runs before this
   *  one: on a switch straight from here to there it has already resumed
   *  the stage for itself, and a pause here would freeze the view now
   *  showing. */
  const exitStage = () => {
    if (booted && S.view !== 'sandbox') window.MCGS?.pause?.()
  }

  // ------------------------------------------------------------ the gestures
  let lastRows = []         // the tmux rows as last drawn, for a shift-click's session
  let lastPointer = null    // client coordinates over the stage, or null
  let applying = false      // one apply in flight at a time
  let saving = false        // one save in flight at a time
  let editorSeq = 0         // bumped on every open and close, so a late answer finds its own editor
  let editorId = null       // the bucket the open editor saves over; null when creating
  let editorKind = null     // that bucket's kind; null when the form chooses one
  let deleteArmed = false
  let deleteTimer = null
  const DELETE_CONFIRM_MS = 3000
  const DEFAULT_COLOR = '#6f86a8'
  const KIND_FIELDS = { 'tmux-group': 'k-edtmuxrow', prompt: 'k-edtextrow', files: 'k-edpathsrow' }
  const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`
  const APPLY_WORDS = {
    prompt: (n) => `prompt sent to ${plural(n, 'session')}`,
    files: (n) => `files named to ${plural(n, 'session')}`,
    together: (n, g) => `${plural(n, 'session')} saved as ${g.name}`,
    'tmux-group': (n) => `${plural(n, 'pane')} joined in tmux`,
  }

  const typing = () => {
    const a = document.activeElement
    return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)
  }

  /** The overlays that sit above every view and own the keyboard while up. */
  const overlayOpen = () => {
    if (typeof MCQ !== 'undefined' && MCQ.isOpen?.()) return true
    for (const id of ['settingspop', 'linkmodal', 'tplmodal']) {
      const n = $(id)
      if (n && !n.hidden) return true
    }
    return false
  }

  const groupAt = (slot) => MCZM.bucketSlots(S.groups ?? []).find((r) => r.slot === slot)?.group ?? null

  /** Feeds one event to the reducer, keeps the state it answers, carries out
   *  its effects and redraws when anything changed. Answers whether the
   *  event was this tab's. */
  const step = (evt) => {
    const nx = MCZM.nextState(state, evt)
    const changed = nx.mode !== state.mode || nx.carried !== state.carried ||
      nx.aimed !== state.aimed || nx.editing !== state.editing
    state.mode = nx.mode
    state.carried = nx.carried
    state.aimed = nx.aimed
    state.editing = nx.editing
    state.swept = nx.swept
    for (const fx of nx.effects) runEffect(fx)
    if (changed) refresh()
    return nx.consumed
  }

  const runEffect = (fx) => {
    if (fx.type === 'apply') void apply(fx.slot, fx.all)
    else if (fx.type === 'open-editor') openEditor(fx.slot)
    else if (fx.type === 'close-editor') closeEditor()
    else if (fx.type === 'close-flyout') window.MCGS?.closeFlyOut?.()
    else if (fx.type === 'open-drawer') openDrawer(fx.id)
  }

  /** MAGNET's pick-up: the first card under the pointer that is not already
   *  following it. Following cards sit on top of whatever the pointer passes
   *  over, so the hit-test looks past them rather than taking the topmost
   *  element. A card carried without following can still be swept, and then
   *  follows. A fly-out's child card carries no session id and is passed
   *  over too. */
  const sweep = (x, y) => {
    if (state.mode !== 'magnet' || typeof document.elementsFromPoint !== 'function') return
    const stage = $('k-stage')
    const held = new Set(state.carried.filter((r) => r && r.kind === 'session' && r.follow === true).map((r) => String(r.id)))
    for (const node of document.elementsFromPoint(x, y)) {
      const card = node.closest?.('.gcard')
      const id = card && stage && stage.contains(card) ? card.getAttribute('data-space-id') : null
      if (!id || held.has(id)) continue
      step({ type: 'hover-card', ref: { kind: 'session', id } })
      return
    }
  }

  const reasons = (skipped) => skipped.slice(0, 2).map((k) => k?.why).filter(Boolean).join('; ')

  /** Applies the bucket in `slot` to the carried set, or with `all` to every
   *  session on the board. What reaches the relay is only what this kind of
   *  bucket can act on; the rest is reported as skipped. A success drops the
   *  carried set and clears the aim. */
  const apply = async (slot, all) => {
    const group = groupAt(slot)
    if (!MCZM.isConfigured(group)) { toast(`slot ${slot} has nothing to apply`, { kind: 'warn' }); return }
    if (applying) return
    const sessions = S.sessions ?? []
    const refs = all ? sessions.map((s) => ({ kind: 'session', id: s.id })) : state.carried
    const body = MCZM.applyBody(group, refs, sessions)
    if (!body.targetIds.length && !body.panes.length) {
      const why = reasons(body.skipped)
      toast(why ? `nothing to apply · ${why}` : all ? 'no sessions on the board' : 'carry something first', { kind: 'warn' })
      return
    }
    applying = true
    let r
    try {
      r = await post('/api/groups/apply', { id: group.id, targetIds: body.targetIds, panes: body.panes })
    } finally {
      applying = false
    }
    if (!r || !r.ok) { toast(r?.error || 'apply failed', { kind: 'warn' }); return }
    const applied = Array.isArray(r.applied) ? r.applied : []
    const skipped = [...body.skipped, ...(Array.isArray(r.skipped) ? r.skipped : [])]
    const words = (APPLY_WORDS[r.kind] ?? ((n) => `applied to ${n}`))(applied.length, group)
    const why = reasons(skipped)
    if (why) toast(`${words} · skipped ${skipped.length}: ${why}`, { kind: 'warn', ms: 5000 })
    else toast(words)
    step({ type: 'applied' })
  }

  // ------------------------------------------------------------ the editor
  const showKindFields = (kind) => {
    for (const [k, id] of Object.entries(KIND_FIELDS)) {
      const n = $(id)
      if (n) MCX.show(n, k === kind)
    }
  }

  const editorError = (msg) => {
    const n = $('k-ederr')
    if (!n) return
    n.textContent = msg || ''
    n.hidden = !msg
  }

  const disarmDelete = () => {
    deleteArmed = false
    clearTimeout(deleteTimer)
    deleteTimer = null
    const b = $('k-eddelete')
    if (b) b.textContent = 'delete'
  }

  /** Fills the editor from the bucket in `slot`, or empties it to create one
   *  there. The kind is chosen only when creating. */
  const openEditor = (slot) => {
    const box = $('k-editor')
    if (!box) return
    const g = groupAt(slot)
    editorSeq++
    editorId = g ? g.id : null
    editorKind = g ? g.kind : null
    disarmDelete()
    editorError('')
    $('k-edtitle').textContent = g ? `Bucket ${slot}` : `New bucket · slot ${slot}`
    $('k-edname').value = g ? g.name ?? '' : ''
    $('k-edcolor').value = g && /^#[0-9a-f]{6}$/i.test(g.color ?? '') ? g.color : DEFAULT_COLOR
    const kind = $('k-edkind')
    if (!g) kind.value = 'prompt'
    MCX.show($('k-edkindrow'), !g)
    $('k-edtmux').value = g?.tmuxName ?? ''
    $('k-edtext').value = g?.text ?? ''
    $('k-edpaths').value = Array.isArray(g?.paths) ? g.paths.join('\n') : ''
    MCX.show($('k-eddelete'), !!g)
    showKindFields(g ? g.kind : kind.value)
    box.hidden = false
    $('k-edname').focus()
  }

  /** Hides the editor and gives the keyboard back to the page, so bare keys
   *  reach the tab again. */
  const closeEditor = () => {
    const box = $('k-editor')
    if (!box) return
    editorSeq++
    editorId = null
    editorKind = null
    disarmDelete()
    const a = document.activeElement
    if (a && box.contains(a)) a.blur()
    box.hidden = true
  }

  const saveEditor = async () => {
    const slot = state.editing
    if (slot === null || saving) return
    const kind = editorKind ?? $('k-edkind').value
    const group = { slot, kind, name: $('k-edname').value.trim(), color: $('k-edcolor').value }
    if (editorId) group.id = editorId
    if (kind === 'tmux-group') group.tmuxName = $('k-edtmux').value.trim()
    if (kind === 'prompt') group.text = $('k-edtext').value
    if (kind === 'files') group.paths = $('k-edpaths').value.split('\n').map((p) => p.trim()).filter(Boolean)
    const seq = editorSeq
    saving = true
    let r
    try {
      r = await post('/api/groups/save', { group })
    } finally {
      saving = false
    }
    if (!r || !r.ok || !r.group) {
      if (seq === editorSeq) editorError(r?.error || 'save failed')
      return
    }
    S.groups = [...(S.groups ?? []).filter((g) => g.id !== r.group.id), r.group]
    if (seq === editorSeq) step({ type: 'close-editor' })
    refresh()
  }

  /** Two presses within a few seconds, so a stray click never deletes. */
  const deleteFromEditor = async () => {
    if (!editorId) return
    if (!deleteArmed) {
      deleteArmed = true
      $('k-eddelete').textContent = 'delete — press again'
      deleteTimer = setTimeout(disarmDelete, DELETE_CONFIRM_MS)
      return
    }
    const id = editorId
    const seq = editorSeq
    disarmDelete()
    const r = await post('/api/groups/delete', { id })
    if (!r || !r.ok) {
      if (seq === editorSeq) editorError(r?.error || 'delete failed')
      return
    }
    S.groups = (S.groups ?? []).filter((g) => g.id !== id)
    if (seq === editorSeq) step({ type: 'close-editor' })
    refresh()
  }

  // ---------------------------------------------------------- the key layer
  /** Capture phase, so an aim's digit never reaches the tab switch and an
   *  Enter never presses a focused bucket chip. Only what the reducer
   *  consumed is stopped; Option is fed and never stopped. */
  const onKeydown = (e) => {
    if (S.view !== 'space') return
    if (e.key === 'Alt') {
      if (e.repeat) return
      step({ type: 'alt-down', typing: typing() || overlayOpen() })
      // Pressing Option over a card picks it up without waiting for a move.
      if (state.mode === 'magnet' && lastPointer) sweep(lastPointer.x, lastPointer.y)
      return
    }
    if (overlayOpen()) return
    const consumed = step({
      type: 'key', key: e.key, typing: typing(),
      flyOut: !!window.MCGS?.flyOutOpen?.(),
      configured: MCZM.isConfigured(groupAt(state.aimed)),
      alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey,
    })
    if (consumed) {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
  }

  const onKeyup = (e) => {
    if (S.view !== 'space') return
    if (e.key === 'Alt') step({ type: 'alt-up' })
  }

  const onStageClick = (e) => {
    const card = e.target.closest?.('.gcard')
    if (card) {
      const id = card.getAttribute('data-space-id')
      // A fly-out's child card, or a card not stamped yet, is not a session.
      if (!id) return
      // The agents badge toggles its own fly-out and stops a plain click
      // before it gets here; a modified one is this tab's add or remove.
      const consumed = step({
        type: 'click-card', ref: { kind: 'session', id },
        shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, ctrl: e.ctrlKey,
        hit: !!e.target.closest('button, a, input, textarea, select, [data-g-hit]'),
      })
      if (consumed) e.preventDefault()
      return
    }
    step({ type: 'click-stage', shift: e.shiftKey, alt: e.altKey })
  }

  const onRowClick = (e) => {
    const row = e.target.closest?.('.krow')
    const target = row ? row.getAttribute('data-target') : null
    if (!target) return
    const ref = { kind: 'pane', target, pane: row.getAttribute('data-pane') ?? '' }
    const hit = lastRows.find((r) => r.target === target)
    const refs = hit
      ? lastRows.filter((r) => r.session === hit.session).map((r) => ({ kind: 'pane', target: r.target, pane: r.pane }))
      : [ref]
    step({ type: 'click-row', ref, refs, shift: e.shiftKey, alt: e.altKey })
  }

  /** One handler for every chip, the + included. */
  const onBucketClick = (e) => {
    const chip = e.target.closest?.('.kchip')
    if (!chip) return
    if (chip.dataset.add) {
      const free = MCZM.bucketSlots(S.groups ?? []).find((r) => !r.group)
      if (!free) { toast('every bucket slot is taken', { kind: 'warn' }); return }
      step({ type: 'add-bucket', slot: free.slot })
      return
    }
    const slot = Number(chip.dataset.slot)
    step({ type: 'click-bucket', slot, shift: e.shiftKey, alt: e.altKey, configured: MCZM.isConfigured(groupAt(slot)) })
  }

  const onBucketMenu = (e) => {
    const chip = e.target.closest?.('.kchip')
    if (!chip || chip.dataset.add || !chip.dataset.slot) return
    e.preventDefault()
    const slot = Number(chip.dataset.slot)
    step({ type: 'click-bucket', slot, right: true, configured: MCZM.isConfigured(groupAt(slot)) })
  }

  // A modified press on a card or a row is a gesture, not the start of a
  // text selection.
  const noSelect = (e) => { if (e.shiftKey || e.altKey) e.preventDefault() }

  // ------------------------------------------------------------ the poll
  /** One reading of the tmux panes into S.tmux. A failure keeps the last
   *  reading and says nothing: the list is a convenience, and the relay being
   *  briefly away is already shown elsewhere. */
  const fetchTmux = async () => {
    try {
      const r = await fetch('/api/tmux')
      if (!r.ok) return
      const d = await r.json()
      if (!d || !Array.isArray(d.panes)) return
      S.tmux = d
      if (current === 'space') renderTmux()
    } catch (e) { /* the last reading stands */ }
  }

  const startPoll = () => {
    if (pollTimer) return
    void fetchTmux()
    pollTimer = setInterval(() => { void fetchTmux() }, TMUX_POLL_MS)
  }

  const stopPoll = () => {
    if (!pollTimer) return
    clearInterval(pollTimer)
    pollTimer = null
  }

  /** Called from the MutationObserver in attach() with 'space' or ''. A
   *  no-op unless the state actually changed. */
  const setView = (name) => {
    const next = name === 'space' ? 'space' : ''
    if (next === current) return
    current = next
    if (next) {
      startPoll()
      render()
      void enterStage()
    } else {
      stopPoll()
      exitStage()
      // An Option released on another tab is never heard here.
      step({ type: 'leave-magnet' })
    }
  }

  /** Renders only while the tab is showing; entering it renders anyway. */
  const refresh = () => { if (current === 'space') render() }

  // ----------------------------------------------------------------- attach
  const attach = (deps) => {
    S = deps.S; $ = deps.$; el = deps.el; post = deps.post
    toast = deps.toast; ago = deps.ago; nameOf = deps.nameOf; openDrawer = deps.openDrawer

    const buckets = $('k-buckets')
    if (buckets) {
      // Built once, ahead of the chips; the reconciler leaves a node it did
      // not create exactly where it is.
      const note = el('div', 'knote', 'this relay predates session space — restart it to use buckets')
      MCX.show(note, false)
      buckets.appendChild(note)
      buckets.addEventListener('click', onBucketClick)
      buckets.addEventListener('contextmenu', onBucketMenu)
    }
    const stage = $('k-stage')
    if (stage) {
      stage.addEventListener('pointermove', (e) => {
        lastPointer = { x: e.clientX, y: e.clientY }
        if (state.mode !== 'magnet') return
        // A release that happened while the window was not listening never
        // arrives as a keyup; the pointer's own flag says so.
        if (!e.altKey) { step({ type: 'leave-magnet' }); return }
        sweep(e.clientX, e.clientY)
      })
      stage.addEventListener('pointerleave', () => { lastPointer = null })
      stage.addEventListener('mousedown', noSelect)
      stage.addEventListener('click', onStageClick)
    }
    const tmux = $('k-tmux')
    if (tmux) {
      tmux.addEventListener('mousedown', noSelect)
      tmux.addEventListener('click', onRowClick)
    }
    $('k-edclose')?.addEventListener('click', () => step({ type: 'close-editor' }))
    $('k-edsave')?.addEventListener('click', () => void saveEditor())
    $('k-eddelete')?.addEventListener('click', () => void deleteFromEditor())
    $('k-edkind')?.addEventListener('change', (e) => showKindFields(e.target.value))
    $('k-editor')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      e.stopPropagation()
      void saveEditor()
    })
    addEventListener('keydown', onKeydown, true)
    addEventListener('keyup', onKeyup, true)
    addEventListener('blur', () => step({ type: 'leave-magnet' }))
    document.addEventListener('visibilitychange', () => step({ type: 'leave-magnet' }))

    const side = $('k-side')
    if (side) {
      const quiet = el('div', 'kquiet')
      MCX.show(quiet, false)
      quiet.id = 'k-tmuxquiet'
      side.appendChild(quiet)
    }

    // Registered first, so a snapshot's own groups field is judged before
    // the field handler below renders it.
    MCE.on('snapshot', (d) => {
      predates = !!d && typeof d === 'object' && !('groups' in d)
      if (predates) { S.groups = []; refresh() }
    })
    MCE.onField('groups', (v) => { S.groups = Array.isArray(v) ? v : []; refresh() })
    MCE.on('groups', (d) => {
      S.groups = Array.isArray(d?.groups) ? d.groups : []
      predates = false
      refresh()
    })
    // app.js assigns S.sessions in handlers registered before these.
    MCE.onField('sessions', () => refresh())
    MCE.on('sessions', () => refresh())

    const node = $('view-space')
    if (node) {
      const mo = new MutationObserver(() => {
        setView(node.classList.contains('on') ? 'space' : '')
      })
      mo.observe(node, { attributes: true, attributeFilter: ['class'] })
      if (node.classList.contains('on')) setView('space')
    }

    render()
  }

  return { derive, attach, render, setView }
})()
