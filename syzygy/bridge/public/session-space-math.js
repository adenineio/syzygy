/* Syzygy -- the session-space tab's pure core.
   A CLASSIC script, like canvas-layout.js and voice-math.js: it assigns one
   global, MCZM, touches no DOM at load, and is evaluated under node by
   test/session-space-math-harness.mjs through `new Function`.

   Coordinates are the STAGE's own layout space: CSS pixels measured from the
   mount's centre, with Y DOWN. `k` is the projection scale -- screen pixels
   drawn per layout pixel -- so every screen-pixel distance in here is divided
   by `k` before it is treated as a layout distance.

   A ref is `{ kind: 'session', id }` or `{ kind: 'pane', target, pane }`.
   Only a session ref is ever a card on the stage; a pane ref is steered
   without ever being drawn as one. A session ref the magnet picked up also
   carries `follow: true`: that card follows the pointer, and every other
   carried card stays where it floats.

   Every function here is synchronous and pure -- no DOM, no fetch, no
   subprocess, no window. */
'use strict'

const MCZM = (() => {
  const CARRY_MAX = 32

  // The fan a magnet drag draws behind the cursor: a fixed screen-pixel step
  // along one diagonal (down-right), so it looks the same size at any zoom
  // once divided by `k`. Growth is capped at a bounded number of steps so a
  // big carry never fans out past a small cluster near the cursor.
  const MAGNET_STEP_PX = 18
  const MAGNET_FAN_CAP = 6

  const finiteOr = (v, fallback) => (Number.isFinite(v) ? v : fallback)

  /** A pointer (screen px, viewport-relative) into the stage's own layout
   *  space: CSS px from the mount's centre, y down. `rect` is the mount's own
   *  bounding rect (`left`/`top`/`width`/`height`). A `k` of 0, negative or
   *  non-finite is treated as 1 rather than dividing by it. */
  const toLayout = (pointer, rect, k) => {
    const r = rect || {}
    const left = finiteOr(Number(r.left), 0)
    const top = finiteOr(Number(r.top), 0)
    const width = finiteOr(Number(r.width), 0)
    const height = finiteOr(Number(r.height), 0)
    const scale = Number.isFinite(k) && k > 0 ? k : 1
    const px = finiteOr(Number(pointer && pointer.x), 0)
    const py = finiteOr(Number(pointer && pointer.y), 0)
    return { x: (px - (left + width / 2)) / scale, y: (py - (top + height / 2)) / scale }
  }

  /** One card's place in the pick-up stack, along the stage's own depth
   *  axis -- position.z, which the stage's own body stepping never writes
   *  (it moves only x and y onto an object every frame), so a value set
   *  here holds without fighting that per-frame layout. Pick-up order zero
   *  sits nearest the viewer and every later pick-up is one step further
   *  behind it, so the most recently carried card is always the one
   *  deepest in the stack. The step is a full card's own drawn size plus
   *  the fixed gap the layout already keeps between two resting cards, so
   *  two panels can never share a depth and their tilted faces can never
   *  poke through each other -- and unlike the lateral fan below, this axis
   *  is never capped: the no-overlap guarantee has to hold at any carried
   *  count. `order` is a card's zero-based pick-up rank among the
   *  following cards; `n` is their count, used only to keep a stray
   *  `order` in range. The result for a given rank never changes as `n`
   *  grows or shrinks, so picking up or dropping a card never moves any
   *  card already in the stack. */
  const CARD_DEPTH_PX = 152 // a card's own drawn height, in the stage's world units (CSS px)
  // The resting layout's own clearance between two cards, in every direction
  // -- a third of what it used to be. A card's tilt and float never reach
  // anywhere near the old gap's full width, so the extra room was read as
  // space rather than as anything protecting the cards from each other; this
  // is the smallest gap that still leaves that same protection intact.
  const STACK_GAP_PX = 12
  const STACK_STEP_PX = CARD_DEPTH_PX + STACK_GAP_PX

  const stackOffsets = (order, n) => {
    const total = Number.isInteger(n) && n > 0 ? n : 1
    const raw = Number.isInteger(order) ? order : 0
    const i = Math.min(Math.max(raw, 0), total - 1)
    const depth = i * STACK_STEP_PX
    return { z: depth === 0 ? 0 : -depth } // never -0: it fails a strict equal against 0
  }

  /** Where a magnet drag's carried cards land: one entry per FOLLOWING
   *  session ref, in pick-up order. A ref carried without `follow` stays
   *  where it floats and a pane ref is never a card; neither takes a target
   *  or a place in the fan. The
   *  first sits exactly at the pointer; each later one is offset from it by
   *  a fixed screen-pixel step along one diagonal, converted to layout
   *  pixels by `k` so the fan reads the same size at any zoom. The offset
   *  stops growing after `MAGNET_FAN_CAP` steps, so a large carry stays a
   *  bounded cluster rather than trailing off the stage. `z` comes from
   *  `stackOffsets`, uncapped, so the depth separation holds even past the
   *  point the lateral fan stops growing. */
  const magnetTargets = (refs, pointer, rect, k) => {
    const base = toLayout(pointer, rect, k)
    const scale = Number.isFinite(k) && k > 0 ? k : 1
    const step = MAGNET_STEP_PX / scale
    const following = (Array.isArray(refs) ? refs : [])
      .filter((ref) => ref && ref.kind === 'session' && ref.follow === true)
    const out = []
    for (let i = 0; i < following.length; i++) {
      const n = Math.min(i, MAGNET_FAN_CAP)
      out.push({
        ref: following[i],
        x: base.x + n * step,
        y: base.y + n * step,
        z: stackOffsets(i, following.length).z,
      })
    }
    return out
  }

  /** The stage's own CSS height for a resting layout whose vertical reach --
   *  half the full span a card can occupy at rest, exactly what the base
   *  component's own layout already measures as `extY` -- is `reachY`: the
   *  full span, rounded up so a fractional reach never leaves the last row's
   *  edge a pixel short. Grows to fit every row the layout lays out, never
   *  the other way around: nothing here ever shrinks a card to make it fit a
   *  smaller box, so a caller that sizes an element from this never has
   *  anything left to zoom. Zero, negative or non-finite (no cards yet, or a
   *  reading taken before the first layout) answers 0; a CSS min-height is
   *  what covers the empty stage, not this function. */
  const layoutHeight = (reachY) => {
    const y = Number(reachY)
    return Number.isFinite(y) && y > 0 ? Math.ceil(y * 2) : 0
  }

  /** Two refs are the same entry only when they share a kind: a session ref
   *  compares by `id`, a pane ref by `target`. A session ref and a pane ref
   *  are never equal, even when their id/target text happens to coincide. */
  const refEq = (a, b) => {
    if (!a || !b || a.kind !== b.kind) return false
    if (a.kind === 'session') return a.id === b.id
    if (a.kind === 'pane') return a.target === b.target
    return false
  }

  /** `'toggle'` adds an absent ref and removes a present one; `'add'` only
   *  ever adds, so an already-present ref is kept rather than duplicated --
   *  except that adding a following ref upgrades a present one to follow, in
   *  place; nothing ever downgrades one. Never mutates `carried`. At
   *  `CARRY_MAX` an attempt to
   *  add refuses by returning `carried` itself, unchanged -- not a copy, not
   *  a truncation, so a caller comparing by reference can tell a refusal
   *  from a successful no-op. */
  const carry = (carried, ref, mode) => {
    const list = Array.isArray(carried) ? carried : []
    const idx = list.findIndex((r) => refEq(r, ref))
    if (idx >= 0) {
      if (mode === 'add') {
        const copy = list.slice()
        if (ref && ref.follow === true && list[idx].follow !== true) copy[idx] = { ...list[idx], follow: true }
        return copy
      }
      return [...list.slice(0, idx), ...list.slice(idx + 1)]
    }
    if (list.length >= CARRY_MAX) return list
    return [...list, ref]
  }

  /** Exactly 8 rows, slot 1..8, each carrying the group that names that slot
   *  or `null` for an empty one. A group naming a slot outside 1..8 is
   *  ignored rather than thrown on -- a hand-edited store is the normal way
   *  this happens. */
  const bucketSlots = (groups) => {
    const bySlot = new Map()
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!g || typeof g !== 'object') continue
      const slot = Number(g.slot)
      if (!Number.isInteger(slot) || slot < 1 || slot > 8) continue
      if (!bySlot.has(slot)) bySlot.set(slot, g)
    }
    const out = []
    for (let slot = 1; slot <= 8; slot++) out.push({ slot, group: bySlot.get(slot) ?? null })
    return out
  }

  /** Maps every live session a `together` group's members can be matched to
   *  onto that group's `{ id, name, color }`. A member matches a live
   *  session by `id` first; when no live session carries that id, it falls
   *  back to matching by `name`, but only when exactly one live session
   *  carries it -- two or more sharing the name means neither is tinted, and
   *  the name is reported once in `ambiguous`. A group of any other kind
   *  contributes nothing. When one session is claimed by two `together`
   *  groups, the group in the LOWER slot wins. */
  const groupTints = (groups, sessions) => {
    const sessionList = Array.isArray(sessions) ? sessions : []
    const byId = new Map()
    const nameCounts = new Map()
    for (const s of sessionList) {
      if (!s || typeof s !== 'object') continue
      if (s.id != null) byId.set(s.id, s)
      if (s.name) nameCounts.set(s.name, (nameCounts.get(s.name) || 0) + 1)
    }
    const firstByName = (name) => sessionList.find((s) => s && s.name === name) ?? null

    const together = (Array.isArray(groups) ? groups : [])
      .filter((g) => g && g.kind === 'together')
      .slice()
      .sort((a, b) => (Number(a.slot) || 0) - (Number(b.slot) || 0))

    const bySession = {}
    const ambiguous = []
    const ambiguousSeen = new Set()

    for (const g of together) {
      const tint = { id: g.id, name: g.name, color: g.color }
      for (const m of Array.isArray(g.members) ? g.members : []) {
        if (!m || typeof m !== 'object') continue
        let sid = null
        if (m.id != null && byId.has(m.id)) {
          sid = m.id
        } else if (m.name) {
          const count = nameCounts.get(m.name) || 0
          if (count === 1) {
            const hit = firstByName(m.name)
            sid = hit ? hit.id : null
          } else if (count >= 2) {
            if (!ambiguousSeen.has(m.name)) { ambiguousSeen.add(m.name); ambiguous.push(m.name) }
            continue
          }
        }
        if (sid == null) continue
        if (!(sid in bySession)) bySession[sid] = tint
      }
    }
    return { bySession, ambiguous }
  }

  // The exact shape `bridge/jump.mjs`'s parseTmuxTarget accepts: a tmux
  // string is `<session>:@<window>.%<pane>` or it is not a pane reference at
  // all -- an empty string never matches this, which is what keeps a session
  // that has never sat in tmux from matching a pane that also carries none.
  const TMUX_TARGET_RE = /^[^:]+:@[0-9]+\.(%[0-9]+)$/

  /** Every `/api/tmux` pane folded against the payload's sessions, as rows
   *  for the tab: `onBoard` is true when the pane already carries a matched
   *  `sessionId`, OR when its own pane id is the `%N` tail of some session's
   *  `tmux` field. Rows are ordered by tmux session name, then by the order
   *  they arrived in; the label is the window name and the running command,
   *  cut to 40 columns. */
  const tmuxRows = (panes, sessions) => {
    const paneList = Array.isArray(panes) ? panes : []
    const sessionList = Array.isArray(sessions) ? sessions : []

    const boardPaneIds = new Set()
    for (const s of sessionList) {
      if (!s) continue
      const m = TMUX_TARGET_RE.exec(String(s.tmux ?? ''))
      if (m) boardPaneIds.add(m[1])
    }

    const rows = paneList.map((p, i) => {
      const pane = p || {}
      const onBoard = !!(pane.sessionId || boardPaneIds.has(pane.pane))
      const label = `${pane.windowName ?? ''} · ${pane.command ?? ''}`.slice(0, 40)
      return {
        target: pane.target ?? '',
        pane: pane.pane ?? '',
        label,
        session: pane.session ?? '',
        onBoard,
        _order: i,
      }
    })

    rows.sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : a._order - b._order))
    return rows.map(({ _order, ...row }) => row)
  }

  const NOT_A_SESSION = 'not a session this relay steers'

  /** What applying `group` to `carried` would do, split by the group's kind.
   *  `sessions` (default `[]`) is the payload's live sessions, so a session
   *  ref's own tmux pane can be resolved -- it is never taken from the ref
   *  itself.
   *
   *  `prompt`/`files`/`together` all steer session refs by id and skip every
   *  pane ref (`why: 'not a session this relay steers'`); only `tmux-group`
   *  returns `panes`, folding in a pane ref's own pane id AND the `%N` tail
   *  of each session ref's own tmux field, deduplicated -- a session ref with
   *  no resolvable tmux pane is skipped, naming it by session name where
   *  known, else by id. */
  const applyBody = (group, carried, sessions = []) => {
    const list = Array.isArray(carried) ? carried : []
    const sessionList = Array.isArray(sessions) ? sessions : []
    const byId = new Map()
    for (const s of sessionList) if (s && s.id != null) byId.set(s.id, s)

    const kind = group && group.kind

    if (kind === 'prompt' || kind === 'files' || kind === 'together') {
      const targetIds = []
      const skipped = []
      for (const ref of list) {
        if (!ref) continue
        if (ref.kind === 'session') targetIds.push(ref.id)
        else if (ref.kind === 'pane') skipped.push({ ref, why: NOT_A_SESSION })
      }
      return { targetIds, panes: [], skipped }
    }

    if (kind === 'tmux-group') {
      const panes = []
      const seen = new Set()
      const skipped = []
      const addPane = (id) => {
        if (!id || seen.has(id)) return
        seen.add(id)
        panes.push(id)
      }
      for (const ref of list) {
        if (!ref) continue
        if (ref.kind === 'pane') {
          addPane(ref.pane)
        } else if (ref.kind === 'session') {
          const sess = byId.get(ref.id) ?? null
          const m = TMUX_TARGET_RE.exec(String((sess && sess.tmux) ?? ''))
          if (m) {
            addPane(m[1])
          } else {
            const label = (sess && sess.name) || ref.id
            skipped.push({ ref, why: `${label} has no tmux pane` })
          }
        }
      }
      return { targetIds: [], panes, skipped }
    }

    return { targetIds: [], panes: [], skipped: [] }
  }

  // What a bucket's kind is called, and what applying one to the carried set
  // actually does. The same four kinds the bucket row's own chips label,
  // restated here since this file is standalone and shares nothing with the
  // view but the reducer's own shape.
  const KIND_NAME = { 'tmux-group': 'tmux', prompt: 'prompt', files: 'files', together: 'together' }
  const KIND_DOES = {
    'tmux-group': 'joins the carried panes into one tmux window',
    prompt: 'sends its prompt to the carried sessions',
    files: 'names its paths to the carried sessions',
    together: 'saves this grouping',
  }

  /** The one line telling a person what the tab is doing right now, and
   *  what the next action does -- never what is merely possible, so idle
   *  says nothing at all. Plain text, never markup, and never throws, even
   *  on a state missing every key. `state` is `{ mode, carried, aimed,
   *  groups }`, every key optional. Aiming a bucket is the most specific
   *  thing there is to say and wins; carrying something outranks a bare
   *  Option hold, since it is true whether or not Option is still down. */
  const modeLine = (state) => {
    const s = state && typeof state === 'object' ? state : {}
    const mode = s.mode === 'magnet' || s.mode === 'bucket' ? s.mode : ''
    const carried = Array.isArray(s.carried) ? s.carried : []
    const groups = Array.isArray(s.groups) ? s.groups : []

    if (mode === 'bucket') {
      const aimed = Number.isInteger(s.aimed) ? s.aimed : null
      if (aimed == null) return 'Press 1-8 to aim a bucket · Esc cancels'
      const g = groups.find((row) => row && Number(row.slot) === aimed)
      if (!g) return `Slot ${aimed} is empty · Enter opens its editor`
      const label = g.name || `slot ${aimed}`
      const kind = KIND_NAME[g.kind] ?? g.kind
      const does = KIND_DOES[g.kind] ?? 'applies to the carried set'
      return `${label} · ${kind} · Enter ${does}`
    }

    if (carried.length > 0) {
      return `${carried.length} carried · click a bucket to apply · Esc drops · release ⌥ keeps`
    }

    if (mode === 'magnet') {
      return '⌥ hover a card to collect'
    }

    return ''
  }

  /** Whether a bucket has something to apply. A prompt needs text that is
   *  not only whitespace and a files bucket needs at least one path; a tmux
   *  group and a together bucket always do. Anything that is not a bucket
   *  has nothing. */
  const isConfigured = (group) => {
    if (!group || typeof group !== 'object') return false
    if (group.kind === 'prompt') return typeof group.text === 'string' && group.text.trim() !== ''
    if (group.kind === 'files') return Array.isArray(group.paths) && group.paths.length > 0
    return group.kind === 'tmux-group' || group.kind === 'together'
  }

  const isSlot = (v) => Number.isInteger(v) && v >= 1 && v <= 8

  /** The tab's modes and gestures as one transition. `state` is
   *  `{ mode: '' | 'magnet' | 'bucket', carried, aimed, editing, swept }`,
   *  where `aimed` and `editing` are bucket slots (1..8) or null -- a slot,
   *  not a group id, because the editor also opens on an empty slot -- and
   *  `swept` is the session ids the current Option hold's sweep added. A
   *  ref the sweep adds carries `follow: true` and keeps following after
   *  Option comes up, until the set drops; a ref added by a click or a tmux
   *  row stays where it floats. Answers the
   *  next state with two extra fields: `effects`, a fresh array of
   *  `{ type, ... }` for the caller to carry out (`apply {slot, all}`,
   *  `open-editor {slot}`, `close-editor`, `close-flyout`, `open-drawer {id}`),
   *  and `consumed`, true when the event was this tab's and must reach no
   *  other handler.
   *
   *  Events, every field but `type` optional:
   *    alt-down { typing }      Option went down: a new hold, nothing swept
   *                             yet; enters MAGNET from no mode.
   *    alt-up, leave-magnet     Option went up, or the window lost it; ends
   *                             the hold, leaves MAGNET, keeps the set.
   *    hover-card { ref }       the pointer is over a card during MAGNET; the
   *                             card is added, or upgraded, to follow.
   *    key { key, typing, flyOut, configured, alt, shift, meta, ctrl }
   *                             `typing` is a field focused, `flyOut` a
   *                             fly-out open, `configured` whether the aimed
   *                             bucket has something to apply.
   *    click-card { ref, shift, alt, meta, ctrl, hit }
   *                             `hit` is a control inside the card.
   *    click-stage { shift, alt }
   *    click-row { ref, refs, shift, alt }
   *                             `refs` is every row of the same tmux session.
   *    click-bucket { slot, shift, alt, right, configured }
   *    add-bucket { slot }      the + chip, with the first free slot.
   *    close-editor, applied
   *
   *  Option is never consumed: other listeners track it as held state and
   *  would stick if its keys were stopped. */
  const nextState = (state, evt) => {
    const s = state && typeof state === 'object' ? state : {}
    const e = evt && typeof evt === 'object' ? evt : {}
    const cur = {
      mode: s.mode === 'magnet' || s.mode === 'bucket' ? s.mode : '',
      carried: Array.isArray(s.carried) ? s.carried : [],
      aimed: isSlot(s.aimed) ? s.aimed : null,
      editing: isSlot(s.editing) ? s.editing : null,
      swept: Array.isArray(s.swept) ? s.swept : [],
    }
    const out = { ...cur, effects: [], consumed: false }
    const isCard = (ref) => !!ref && ref.kind === 'session' && ref.id != null
    const isPane = (ref) => !!ref && ref.kind === 'pane' && !!ref.target
    // A row is carried as itself and never follows the pointer.
    const paneRef = (ref) => ({ kind: 'pane', target: ref.target, pane: ref.pane ?? '' })

    switch (e.type) {
      case 'alt-down':
        if (cur.swept.length) out.swept = []
        if (cur.mode === '' && cur.editing === null && !e.typing) out.mode = 'magnet'
        return out

      case 'alt-up':
      case 'leave-magnet':
        if (cur.swept.length) out.swept = []
        if (cur.mode === 'magnet') out.mode = ''
        return out

      case 'hover-card': {
        if (cur.mode !== 'magnet' || !isCard(e.ref)) return out
        const was = cur.carried.find((r) => refEq(r, e.ref))
        if (was && was.follow === true) return out
        const list = carry(cur.carried, { ...e.ref, follow: true }, 'add')
        if (list === cur.carried) return out
        out.carried = list
        // A card that was already carried is upgraded, not picked up by
        // this hold.
        if (!was) out.swept = [...cur.swept, e.ref.id]
        return out
      }

      case 'key': {
        const key = e.key
        if (key === 'Escape') {
          // Innermost first: the editor, the aim, the mode, a fly-out, the
          // carried set. A key typed into any field but the editor's own is
          // that field's.
          if (cur.editing !== null) {
            out.editing = null
            out.effects.push({ type: 'close-editor' })
          } else if (e.typing) {
            return out
          } else if (cur.aimed !== null) {
            out.aimed = null
          } else if (cur.mode === 'bucket') {
            out.mode = ''
          } else if (e.flyOut) {
            out.effects.push({ type: 'close-flyout' })
          } else if (cur.carried.length) {
            out.carried = []
          } else {
            return out
          }
          out.consumed = true
          return out
        }
        if (e.typing || cur.editing !== null) return out
        const bare = !e.alt && !e.shift && !e.meta && !e.ctrl
        if (cur.mode === 'bucket') {
          if (/^[0-9]$/.test(key ?? '') && !e.alt && !e.meta && !e.ctrl) {
            const n = Number(key)
            if (isSlot(n)) out.aimed = n
            out.consumed = true
            return out
          }
          if (key === 'Enter') {
            // Consumed aimed or not, so a focused bucket chip is not also
            // pressed by the same key.
            out.consumed = true
            if (cur.aimed === null) return out
            if (e.configured) {
              out.effects.push({ type: 'apply', slot: cur.aimed, all: false })
            } else {
              out.editing = cur.aimed
              out.effects.push({ type: 'open-editor', slot: cur.aimed })
            }
            return out
          }
          if (key === 'b' && bare) {
            out.mode = ''
            out.aimed = null
            out.consumed = true
          }
          return out
        }
        if (key === 'b' && bare && cur.mode === '') {
          out.mode = 'bucket'
          out.aimed = null
          out.consumed = true
        }
        return out
      }

      case 'click-card':
        if (!isCard(e.ref)) return out
        if (e.shift || e.alt) {
          out.consumed = true
          // Under Option the pointer's move onto a card sweeps it in before
          // the click lands, and that click must not undo the pick-up.
          const present = cur.carried.some((r) => refEq(r, e.ref))
          if (e.alt && present && cur.swept.includes(e.ref.id)) return out
          out.carried = carry(cur.carried, { kind: 'session', id: e.ref.id }, 'toggle')
          return out
        }
        if (e.hit || e.meta || e.ctrl) return out
        out.effects.push({ type: 'open-drawer', id: e.ref.id })
        return out

      case 'click-stage':
        // A modified click is an add or remove that missed its card; it
        // must not wipe a set somebody spent a sweep collecting.
        if (!e.shift && !e.alt && cur.carried.length) out.carried = []
        return out

      case 'click-row':
        if (!isPane(e.ref)) return out
        if (e.shift) {
          let list = cur.carried
          for (const ref of Array.isArray(e.refs) && e.refs.length ? e.refs : [e.ref]) {
            if (isPane(ref)) list = carry(list, paneRef(ref), 'add')
          }
          out.carried = list
        } else {
          out.carried = carry(cur.carried, paneRef(e.ref), 'toggle')
        }
        out.consumed = true
        return out

      case 'click-bucket':
        if (!isSlot(e.slot)) return out
        out.consumed = true
        if (e.alt || e.right || !e.configured) {
          out.editing = e.slot
          out.effects.push({ type: 'open-editor', slot: e.slot })
        } else {
          out.effects.push({ type: 'apply', slot: e.slot, all: !!e.shift })
        }
        return out

      case 'add-bucket':
        if (!isSlot(e.slot)) return out
        out.editing = e.slot
        out.effects.push({ type: 'open-editor', slot: e.slot })
        return out

      case 'close-editor':
        out.editing = null
        out.effects.push({ type: 'close-editor' })
        return out

      case 'applied':
        out.carried = []
        out.aimed = null
        return out

      default:
        return out
    }
  }

  return {
    CARRY_MAX, toLayout, magnetTargets, stackOffsets, carry, bucketSlots, groupTints, tmuxRows,
    applyBody, modeLine, isConfigured, nextState,
    CARD_DEPTH_PX, STACK_GAP_PX, STACK_STEP_PX, layoutHeight,
  }
})()
