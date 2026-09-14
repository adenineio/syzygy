// The pasteboard: prompts stashed with the band's marker, waiting to be
// reloaded into a composer.
//
// A classic script exposing one global, MCK -- K for "the keep"; MCP is
// Projects and MCB is the dispatch badges, so the pasteboard's own two
// initials are both spoken for. Referenced BARE everywhere, never
// window.MCK: a classic script's top-level const is a lexical global across
// <script> tags in one realm and is NOT a window property. Getting this
// backwards once shipped a whole feature silently inert end to end.
//
// Two boards with two homes and no scope toggle: the drawer section is the
// focused session's, the rail panel is the global one. Rendered through MCX,
// keyed by id -- so node.className is never assigned here, because it would
// wipe .gone out from under MCX.show.
const MCK = (() => {
  let D = null
  // { id, scope } of the row currently being dragged, or null. Module-level
  // rather than per-row: a drag started on one row is read by every other
  // row's dragover/drop, and there is exactly one drag in flight at a time.
  let dragging = null

  /** An entry stores a title only when `,,@name ` gave one. Everything else
   *  derives its caption here, so a better derivation later improves every
   *  old entry and there is nothing to keep in sync. */
  const captionOf = (e) => {
    if (e.title) return e.title
    const line = String(e.text || '').split('\n').find((l) => l.trim()) || ''
    return line.trim().slice(0, 60) || 'empty'
  }

  const linesOf = (e) => String(e.text || '').split('\n').length

  const rowSpec = (scope) => ({
    key: (e) => e.id,
    create: () => {
      const n = D.el('div', 'pbrow')
      n.appendChild(D.el('div', 'pbcap'))
      const meta = D.el('div', 'pbmeta')
      meta.appendChild(D.el('span', 'pbwho'))
      meta.appendChild(D.el('span', 'pbsize'))
      meta.appendChild(D.el('span', 'pbwhen'))
      n.appendChild(meta)
      const ctl = D.el('div', 'pbctl')
      const up = D.el('button', 'btn pbmove', '↑')
      const down = D.el('button', 'btn pbmove', '↓')
      ctl.appendChild(up); ctl.appendChild(down)
      n.appendChild(ctl)
      return n
    },
    update: (n, e) => {
      MCX.setText(n.querySelector('.pbcap'), captionOf(e))
      MCX.setText(n.querySelector('.pbwho'), e.sessionName || 'unknown')
      MCX.setText(n.querySelector('.pbsize'), e.text.length + ' chars · ' + linesOf(e) + ' lines')
      MCX.setText(n.querySelector('.pbwhen'), D.ago(e.createdAt))
      MCX.toggle(n, 'pbtitled', !!e.title)
      MCX.setAttr(n, 'draggable', 'true')
      MCX.setAttr(n, 'data-tip',
        'Click reloads this into ' + (scope === 'global' ? 'the focused session' : 'this session') +
        ' and REPLACES whatever is in its composer\n' +
        'Shift-click reloads into the focused session\n' +
        'Alt-click deletes it\n' +
        'Drag reorders within this board')
      n.onclick = (ev) => {
        if (ev.altKey) return remove(e)
        fill(e, ev.shiftKey ? D.S.focus : (scope === 'global' ? D.S.focus : e.sessionId))
      }
      n.querySelector('.pbctl').onclick = (ev) => ev.stopPropagation()
      const [up, down] = n.querySelectorAll('.pbmove')
      up.onclick = () => move(e, 'up')
      down.onclick = () => move(e, 'down')
      n.ondragstart = (ev) => {
        dragging = { id: e.id, scope }
        ev.dataTransfer.effectAllowed = 'move'
      }
      n.ondragover = (ev) => {
        if (!dragging || dragging.scope !== scope) return
        ev.preventDefault()
        MCX.toggle(n, 'pbdrop', true)
      }
      n.ondragleave = () => MCX.toggle(n, 'pbdrop', false)
      n.ondragend = () => {
        dragging = null
        document.querySelectorAll('.pbrow.pbdrop').forEach((r) => r.classList.remove('pbdrop'))
      }
      n.ondrop = (ev) => {
        ev.preventDefault()
        if (!dragging || dragging.scope !== scope || dragging.id === e.id) return
        void reorderOnto(e)
      }
    },
  })

  const fill = async (e, targetId) => {
    if (!targetId) return D.toast('no session focused — pick a card first', { kind: 'warn' })
    const r = await D.post('/api/pasteboard/fill', { id: e.id, targetId })
    D.toast(r && r.ok
      ? 'reloaded into ' + D.nameOf(targetId) + ' — its composer was replaced'
      : 'could not reload: ' + ((r && r.error) || 'unreachable'),
      { kind: r && r.ok ? '' : 'warn' })
  }

  const remove = async (e) => {
    const r = await D.post('/api/pasteboard/delete', { id: e.id })
    D.toast(r && r.ok ? 'deleted' : 'could not delete', { kind: r && r.ok ? '' : 'warn' })
  }

  const move = async (e, dir) => {
    const r = await D.post('/api/pasteboard/reorder', { id: e.id, dir })
    if (!(r && r.ok)) D.toast('could not reorder', { kind: 'warn' })
  }

  /** Drag-and-drop reorder within one board: takes that board's ids in their
   *  current order, relocates the dragged id to the row it was dropped on,
   *  and posts the whole order back in one call. The dragged and target rows
   *  are already known to share a scope and to differ -- checked by the
   *  caller before this runs. */
  const reorderOnto = async (target) => {
    const ids = board(target.sessionId).map((it) => it.id)
    const from = ids.indexOf(dragging.id)
    if (from === -1) return
    ids.splice(from, 1)
    ids.splice(ids.indexOf(target.id), 0, dragging.id)
    const r = await D.post('/api/pasteboard/reorder', { ids })
    if (!(r && r.ok)) D.toast('could not reorder', { kind: 'warn' })
  }

  /** Every consumer reads the field with `?? []`: a relay predating this
   *  feature serves a pane that has it, and "not landed" and "old relay" are
   *  otherwise indistinguishable from the view. */
  const board = (sessionId) => (D.S.pasteboard || []).filter((e) => e.sessionId === sessionId)

  const render = () => {
    if (!D) return
    const items = board(null)
    MCX.setText(D.$('c-pasteboard'), String(items.length))
    const host = D.$('pasteboard')
    MCX.reconcile(host, items, rowSpec('global'))
    MCX.show(D.$('pb-empty'), items.length === 0)
  }

  const renderDrawer = (id) => {
    if (!D) return
    const host = D.$('d-pasteboard')
    if (!host) return
    const items = board(id)
    MCX.reconcile(host, items, rowSpec('session'))
    MCX.show(D.$('d-pb-empty'), items.length === 0)
  }

  const attach = (deps) => {
    D = deps
    render()
  }

  return { attach, render, renderDrawer }
})()
