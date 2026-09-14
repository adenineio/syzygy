/* Syzygy -- session presets in the pane. A classic script, global MCT,
   attached by app.js the way MCP/MCD/MCC are, and loaded after
   template-apply.js, whose MCTA does every pure step.

   Referenced BARE, never through window: a classic script's top-level const
   is a lexical global shared across <script> tags and is not a window
   property. That matters twice here, because window.MCT is already taken --
   app.js publishes the live theme palette under that name for the canvases
   -- so this module never assigns window.MCT, and nothing may read the theme
   as a bare MCT.

   Three surfaces over one store, S.agentTemplates, which only the relay
   writes:
     - the gear's Session presets list, its New preset button and the
       personas switch;
     - #tplmodal, the editor, a sibling of #app;
     - a strip of preset chips over a form's prompt, mounted by that form's
       own file through mountStrip.

   Rendered by MCX keyed on template id: NEVER assign node.className on a
   reconciled node, and optional marks are built once and toggled with
   MCX.show or MCX.toggle.

   Nothing runs at evaluation time. $, el, post and toast belong to app.js,
   which loads afterwards, so every binding happens inside attach. */
'use strict'

const MCT = (() => {
  let D = null                 // { S, $, el, post, toast }
  const strips = []            // see mountStrip for the shape
  const pending = []           // [host, adapter] pairs mounted before attach
  let editing = null           // { id: string|null, returnFocus } while the editor is open
  let saving = false
  let deleteArmed = false, deleteTimer = null
  let togglingPersonas = false

  // The same fallbacks the Dispatch tab's pickers use for a relay that
  // publishes no option lists.
  const DEFAULT_MODELS = ['opus', 'sonnet', 'haiku', 'fable']
  const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

  const MOD_KEYS = new Set(['Shift', 'Alt', 'Meta', 'Control'])
  const NO_MODS = { shift: false, alt: false, cmd: false }

  /** A relay that predates presets sends no key at all; every reader goes
   *  through these, so that reads as an empty list and never as a throw. */
  const store = () => D.S.agentTemplates ?? { items: [] }
  const items = () => (Array.isArray(store().items) ? store().items : [])
  const byId = (id) => (id ? items().find((t) => t.id === id) ?? null : null)
  const personas = () => store().personas ?? null

  const warn = (msg) => D.toast(msg, { kind: 'warn' })

  /** What a preset sets, in words: its prompt always, then whatever else it
   *  names. The gear row counts these and its tip lists them. */
  const setsOf = (t) => {
    const count = (list) => (Array.isArray(list) ? list.length : 0)
    const out = ['prompt']
    if (t.model) out.push('model ' + t.model)
    if (t.effort) out.push('effort ' + t.effort)
    const skills = count(t.skills), tools = count(t.allowedTools)
    if (skills) out.push(skills + (skills === 1 ? ' skill' : ' skills'))
    if (tools) out.push(tools + (tools === 1 ? ' tool' : ' tools'))
    if (t.agentDef) out.push('a persona')
    return out
  }

  /** Why a persona cannot reach a session right now, or '' when it can. The
   *  reasons are checked in the order somebody could act on them. */
  const personaNote = () => {
    const p = personas()
    if (!p) return 'this relay does not report the personas setting — restart it to use presets'
    if (!p.enabled) return 'off — presets reach sessions without a persona: kickoff prompt, model, effort and tools only'
    if (p.error) return 'personas: ' + p.error
    const src = D.S.dispatchOptions?.agentSource
    if (src == null || src === 'unavailable') {
      return "this relay could not read the CLI's agent roster — personas cannot be selected"
    }
    return ''
  }

  /** Folds a write's own answer into S before the relay's broadcast lands,
   *  so a strip that has just applied a new preset never finds it missing
   *  and detaches it. The broadcast replaces the whole list anyway. */
  const adopt = (tpl) => {
    if (!tpl?.id) return
    const list = [...items()]
    const at = list.findIndex((t) => t.id === tpl.id)
    if (at === -1) list.push(tpl)
    else list[at] = tpl
    D.S.agentTemplates = { ...store(), items: list }
    render()
  }

  const forget = (id) => {
    D.S.agentTemplates = { ...store(), items: items().filter((t) => t.id !== id) }
    render()
  }

  // ---- the gear -------------------------------------------------------------

  const duplicate = async (t) => {
    const r = await D.post('/api/templates/create', {
      name: t.name + ' copy', prompt: t.prompt,
      model: t.model ?? null, effort: t.effort ?? null,
      skills: t.skills ?? [], allowedTools: t.allowedTools ?? [], agentDef: t.agentDef ?? null,
    })
    if (!r?.ok) return void warn('could not duplicate: ' + (r?.error ?? 'unreachable'))
    adopt(r.template)
    D.toast('duplicated as "' + r.template.name + '"')
  }

  const ROW = {
    key: (t) => t.id,
    create: () => {
      const n = D.el('button', 'tplrow')
      n.type = 'button'
      n.appendChild(D.el('span', 'tplslot'))
      n.appendChild(D.el('span', 'tplname'))
      n.appendChild(D.el('span', 'chip tplsets'))
      n.appendChild(D.el('span', 'chip tplpersona', 'persona'))
      return n
    },
    update: (n, t, i) => {
      const sets = setsOf(t)
      MCX.setText(n.querySelector('.tplslot'), MCTA.slotLabel(i))
      MCX.setText(n.querySelector('.tplname'), t.name)
      MCX.setText(n.querySelector('.tplsets'), sets.length + ' set')
      MCX.show(n.querySelector('.tplpersona'), !!t.agentDef)
      MCX.setAttr(n, 'data-tip', t.name + '\nsets ' + sets.join(', ') + '\nclick edits · ⌥click duplicates')
      n.onclick = (ev) => {
        ev.preventDefault()
        // ⇧ is left unbound on a row: a row has two meanings, not three.
        if (ev.shiftKey) return
        if (ev.altKey) return void duplicate(t)
        openEditor(t.id)
      }
    },
  }

  const renderGear = () => {
    const list = D.$('tpl-list')
    if (!list) return
    const all = items()
    MCX.reconcile(list, all, ROW)
    MCX.show(D.$('tpl-empty'), all.length === 0)
    const p = personas()
    const box = D.$('tpl-personas')
    // Left alone while a switch is in flight, so the box never flickers back
    // to the old value between the click and the relay's answer.
    if (box && !togglingPersonas) {
      box.checked = !!p?.enabled
      box.disabled = !p
    }
    const note = personaNote()
    MCX.setText(D.$('tpl-personanote'), note)
    MCX.show(D.$('tpl-personanote'), !!note)
  }

  /** The switch shows what the relay holds, never what was clicked: a
   *  refusal re-renders it back, and a success adopts the relay's answer. A
   *  switch that was written but whose plugin write failed is still on, and
   *  says why. */
  const onPersonas = async () => {
    const box = D.$('tpl-personas')
    const enabled = box.checked
    togglingPersonas = true
    box.disabled = true
    const r = await D.post('/api/templates/personas', { enabled })
    togglingPersonas = false
    if (!r?.ok) {
      warn('personas not changed: ' + (r?.error ?? 'unreachable'))
    } else {
      if (r.personas) D.S.agentTemplates = { ...store(), personas: r.personas }
      if (r.error) warn('personas: ' + r.error)
    }
    render()
  }

  // ---- the editor -----------------------------------------------------------

  /** A leading — option stores null, which means "inherit whatever the form
   *  already holds". A stored value the relay no longer lists is kept as an
   *  option, so saving without touching the select never rewrites it. */
  const fillSelect = (sel, values, chosen) => {
    sel.textContent = ''
    const inherit = D.el('option', '', '—')
    inherit.value = ''
    sel.appendChild(inherit)
    const list = (Array.isArray(values) ? values : []).filter((v) => typeof v === 'string' && v)
    if (chosen && !list.includes(chosen)) list.push(chosen)
    for (const v of list) {
      const o = D.el('option', '', v)
      o.value = v
      sel.appendChild(o)
    }
    sel.value = chosen || ''
  }

  const lines = (v) => String(v ?? '').split('\n').map((x) => x.trim()).filter(Boolean)

  const renderEditorNote = () => {
    const note = D.$('tpl-agentnote')
    if (!note) return
    const text = personaNote()
    MCX.setText(note, text)
    MCX.show(note, !!text)
  }

  const disarmDelete = () => {
    deleteArmed = false
    clearTimeout(deleteTimer)
    deleteTimer = null
    MCX.setText(D.$('tpl-delete'), 'delete')
  }

  const openEditor = (id) => {
    if (!D) return
    const t = id ? byId(id) : null
    if (id && !t) return void warn('that preset is gone')
    const opts = D.S.dispatchOptions
    editing = { id: t ? t.id : null, returnFocus: document.activeElement }
    MCX.setText(D.$('tpl-title'), t ? 'Edit preset' : 'New preset')
    D.$('tpl-name').value = t?.name ?? ''
    D.$('tpl-prompt').value = t?.prompt ?? ''
    fillSelect(D.$('tpl-model'), opts?.models ?? DEFAULT_MODELS, t?.model ?? '')
    fillSelect(D.$('tpl-effort'), opts?.efforts ?? DEFAULT_EFFORTS, t?.effort ?? '')
    D.$('tpl-skills').value = (t?.skills ?? []).join('\n')
    D.$('tpl-tools').value = (t?.allowedTools ?? []).join('\n')
    D.$('tpl-agentdef').value = t?.agentDef ?? ''
    disarmDelete()
    MCX.show(D.$('tpl-delete'), !!t)
    renderEditorNote()
    D.$('tplmodal').hidden = false
    D.$('tpl-name').focus()
  }

  /** Focus goes back where it came from -- a chip, a gear row -- when that
   *  element is still in the page. */
  const closeEditor = () => {
    const back = editing?.returnFocus
    editing = null
    disarmDelete()
    D.$('tplmodal').hidden = true
    if (back && back.isConnected && typeof back.focus === 'function') back.focus()
  }

  /** A refusal keeps the editor open with everything still in it, and the
   *  relay's own reason is what the toast says. */
  const saveEditor = async () => {
    if (!editing || saving) return
    const session = editing
    const agentDef = D.$('tpl-agentdef').value
    const fields = {
      name: D.$('tpl-name').value.trim(),
      prompt: D.$('tpl-prompt').value,
      model: D.$('tpl-model').value || null,
      effort: D.$('tpl-effort').value || null,
      skills: lines(D.$('tpl-skills').value),
      allowedTools: lines(D.$('tpl-tools').value),
      agentDef: agentDef.trim() ? agentDef : null,
    }
    saving = true
    D.$('tpl-save').disabled = true
    const r = session.id
      ? await D.post('/api/templates/update', { id: session.id, patch: fields })
      : await D.post('/api/templates/create', fields)
    saving = false
    D.$('tpl-save').disabled = false
    if (!r?.ok) return void warn('could not save: ' + (r?.error ?? 'unreachable'))
    adopt(r.template)
    if (editing === session) closeEditor()
    const trouble = r.personas?.enabled && r.personas.error
    if (trouble) warn('saved "' + r.template.name + '", but personas: ' + r.personas.error)
    else D.toast('saved "' + r.template.name + '"')
  }

  /** The store is the only copy of a preset, so the first click arms for 3 s
   *  and relabels, and only the second deletes. */
  const deleteFromEditor = async () => {
    if (!editing?.id) return
    if (!deleteArmed) {
      deleteArmed = true
      MCX.setText(D.$('tpl-delete'), 'click again to delete')
      clearTimeout(deleteTimer)
      deleteTimer = setTimeout(disarmDelete, 3000)
      return
    }
    const session = editing
    disarmDelete()
    const r = await D.post('/api/templates/delete', { id: session.id })
    if (!r?.ok) return void warn('could not delete: ' + (r?.error ?? 'unreachable'))
    forget(session.id)
    if (editing === session) closeEditor()
    D.toast('deleted')
  }

  // ---- strips ---------------------------------------------------------------

  const stripOf = (host) => strips.find((s) => s.host === host) ?? null

  const visible = (node) => !!node && node.isConnected && node.getClientRects().length > 0

  /** Applies a preset onto the form's current fields and marks its chip. The
   *  mark stays when the prompt is edited afterwards: the two things a chip
   *  carries that no field shows -- a persona and a tool allowlist -- are
   *  exactly why only the ✕ may clear it. */
  const applyStrip = (s, t, mode) => {
    s.adapter.write(MCTA.applyTemplate(s.adapter.read(), t, mode))
    setApplied(s, t.id)
  }

  /** click applies, ⇧ fills only the empty fields, ⌥ opens the editor, and
   *  ⌘ or ctrl applies and then submits the form. */
  const onChip = (s, id, ev) => {
    ev.preventDefault()
    const t = byId(id)
    if (!t) return
    if (ev.altKey) return void openEditor(t.id)
    applyStrip(s, t, ev.shiftKey ? 'fill-empty' : 'overwrite')
    if (ev.metaKey || ev.ctrlKey) s.adapter.submit()
  }

  /** Saves the form's prompt, model and effort as a new preset and marks it
   *  applied. It does not open the editor: a modal over a half-filled form
   *  would put a third Escape handler on top of the two already there, so
   *  the toast says where the editor is instead. */
  const saveAsPreset = async (s) => {
    const f = s.adapter.read()
    if (!String(f.prompt ?? '').trim()) return void warn('nothing to save yet')
    const name = String(f.name || '').trim() ||
      String(f.prompt).trim().split(/\s+/).slice(0, 4).join(' ')
    const r = await D.post('/api/templates/create', {
      name, prompt: f.prompt, model: f.model || null, effort: f.effort || null,
    })
    if (!r?.ok) return void warn('could not save: ' + (r?.error ?? 'unreachable'))
    adopt(r.template)
    setApplied(s, r.template.id)
    D.toast('saved as "' + r.template.name + '" — the gear edits it')
  }

  const chipSpec = (s) => ({
    key: (t) => t.id,
    create: () => {
      const b = D.el('button', 'tplchip')
      b.type = 'button'
      b.appendChild(D.el('span', 'tplslot'))
      b.appendChild(D.el('span', 'tplchipname'))
      return b
    },
    update: (b, t, i) => {
      const on = s.applied === t.id
      MCX.setText(b.querySelector('.tplslot'), MCTA.slotLabel(i))
      MCX.setText(b.querySelector('.tplchipname'), t.name)
      MCX.toggle(b, 'applied', on)
      MCX.setAttr(b, 'aria-pressed', on ? 'true' : 'false')
      // The deck's tooltip takes its first line as the headline, so the name
      // leads and what the chip carries beyond the form's fields follows.
      const title = MCTA.chipTitle(t)
      const name = String(t.name ?? '')
      MCX.setAttr(b, 'aria-label', title)
      MCX.setAttr(b, 'data-tip', name + '\n' + title.slice(name.length + 3))
      b.onclick = (ev) => onChip(s, t.id, ev)
    },
  })

  // The hint line under the chips. Every state a click or a key can be in has
  // a sentence, including the two modifiers held together; a string part is
  // text and an object part is a key cap.
  const K = (k) => ({ k })
  const HINTS = {
    plain: (verb) => ['click applies · ', K('⇧'), ' fills empty fields · ', K('⌥'), ' edits · ',
      K('⌘'), ' applies and ' + verb + ' · ', K('⌥T'), ' picks by number'],
    shift: () => ['click fills only the empty fields'],
    alt: () => ['click opens the preset in the editor'],
    cmd: (verb) => ['click applies and ' + verb],
    cmdShift: (verb) => ['click fills only the empty fields and ' + verb],
    mode: () => ['press ', K('1'), '–', K('9'), ' to pick · ', K('⇧'), '+digit fills only empty fields · ',
      K('esc'), ' leaves'],
  }

  const hintState = (s) => {
    if (s.host.classList.contains('tplmode')) return 'mode'
    if (s.mods.alt) return 'alt'
    if (s.mods.cmd) return s.mods.shift ? 'cmdShift' : 'cmd'
    return s.mods.shift ? 'shift' : 'plain'
  }

  /** Rebuilt only when the state changes. The hint is static, not
   *  reconciled, so clearing and refilling it is safe. */
  const renderHint = (s) => {
    const state = hintState(s)
    if (s.hint.dataset.state === state) return
    s.hint.textContent = ''
    for (const part of HINTS[state](s.adapter.verb || 'starts')) {
      s.hint.appendChild(typeof part === 'string' ? D.el('span', '', part) : D.el('kbd', '', part.k))
    }
    s.hint.dataset.state = state
  }

  /** A strip whose applied preset no longer exists lets go of it: a spawn
   *  naming a deleted preset would be refused, and the chip it named is gone. */
  const renderStrip = (s) => {
    if (s.applied && !byId(s.applied)) s.applied = null
    MCX.reconcile(s.chips, items(), s.spec)
    const cur = byId(s.applied)
    MCX.show(s.clear, !!cur)
    MCX.setAttr(s.clear, 'data-tip', cur
      ? 'Clear ' + cur.name + '\nThe fields keep what it wrote. Nothing else from it rides along.'
      : null)
    renderHint(s)
  }

  const setApplied = (s, id) => {
    s.applied = id
    renderStrip(s)
  }

  // ---- template mode --------------------------------------------------------

  const focusPrompt = (s) => {
    if (typeof s.adapter.focus === 'function') s.adapter.focus()
    else s.host.blur()
  }

  /** Idempotent: the class comes off before focus moves, so the blur that
   *  focusing the prompt raises finds the mode already left. */
  const leave = (s, toPrompt) => {
    if (!s.host.classList.contains('tplmode')) return
    s.host.classList.remove('tplmode')
    renderHint(s)
    if (toPrompt) focusPrompt(s)
  }

  const enter = (s) => {
    for (const other of strips) if (other !== s) leave(other, false)
    s.host.classList.add('tplmode')
    renderHint(s)
    s.host.focus({ preventScroll: true })
  }

  const pick = (s, index, mode) => {
    const t = items()[index]
    if (t) applyStrip(s, t, mode)
    leave(s, true)
    if (!t) warn('no preset ' + (index + 1))
  }

  /** The strip ⌥T acts on: the canvas spawn form's while that form is open,
   *  else the Dispatch create box's while focus is inside the box. */
  const activeStrip = () => {
    const canvas = strips.find((s) => s.host.id === 'cs-tplstrip')
    const form = D.$('cspawn')
    if (canvas && form && !form.hidden && visible(canvas.host)) return canvas
    const disp = strips.find((s) => s.host.id === 'd-tplstrip')
    const box = D.$('d-ask')?.parentElement
    const focus = document.activeElement
    if (disp && box && focus && box.contains(focus) && box.contains(D.$('d-add')) && visible(disp.host)) return disp
    return null
  }

  // ---- mounting -------------------------------------------------------------

  /** `adapter` is `{ read, write, submit, focus, verb }` over the form's own
   *  fields: `read` and `write` speak `{ prompt, model, effort, name }`,
   *  `submit` does what the form's own start button does, `focus` puts the
   *  caret in the prompt, and `verb` finishes "⌘ applies and …". Tolerates
   *  a missing host, and a mount before attach is held until attach runs. */
  const mountStrip = (host, adapter) => {
    if (!host || !adapter) return
    if (!D) { pending.push([host, adapter]); return }
    if (stripOf(host)) return
    if (!host.hasAttribute('tabindex')) host.tabIndex = -1
    const chips = D.el('div', 'tplchips')
    const clear = D.el('button', 'tplclear gone', '✕')
    clear.type = 'button'
    clear.setAttribute('aria-label', 'Clear the applied preset')
    const save = D.el('button', 'tplchip tplsave', '+ save as preset')
    save.type = 'button'
    save.dataset.tip = 'Save as preset\nSaves this form\'s prompt, model and effort as a new preset, named from its name field or the prompt\'s first words.'
    const hint = D.el('div', 'tplhint')
    host.appendChild(chips)
    host.appendChild(clear)
    host.appendChild(save)
    host.appendChild(hint)
    const s = { host, adapter, applied: null, chips, clear, save, hint, spec: null, mods: NO_MODS }
    s.spec = chipSpec(s)
    clear.onclick = (ev) => { ev.preventDefault(); setApplied(s, null) }
    save.onclick = (ev) => { ev.preventDefault(); void saveAsPreset(s) }
    // Focus leaving the strip -- a click elsewhere, a tab switch -- ends the mode.
    host.addEventListener('blur', () => leave(s, false))
    strips.push(s)
    renderStrip(s)
  }

  /** The id a submit should carry, or null: nothing applied, a host that
   *  was never mounted, or a preset that has since been deleted. */
  const appliedId = (host) => {
    const s = stripOf(host)
    return s && byId(s.applied) ? s.applied : null
  }

  const detach = (host) => {
    const s = stripOf(host)
    if (!s) return
    leave(s, false)
    setApplied(s, null)
  }

  // ---- keys -----------------------------------------------------------------

  const swallow = (ev) => { ev.preventDefault(); ev.stopImmediatePropagation() }

  /** CAPTURE phase on window, registered in attach -- before cmdbar.js's and
   *  canvas.js's capture listeners on the same target, which therefore never
   *  see a key this one stops. In order:
   *    - the editor open: Escape closes it; every other key passes.
   *    - a strip in template mode: a digit picks (⇧ fills only the empty
   *      fields) and leaves, Escape leaves, both stopped here, so app.js's
   *      digit router and every Escape handler behind this one never see
   *      them; a bare modifier is ignored; any other key leaves the mode and
   *      carries on to whoever wanted it. A digit with ⌘ or ctrl is not a
   *      pick, so browser shortcuts still work.
   *    - ⌥T with a strip active enters the mode. */
  const onKey = (ev) => {
    const modal = D.$('tplmodal')
    if (modal && !modal.hidden) {
      if (ev.key !== 'Escape') return
      swallow(ev)
      closeEditor()
      return
    }
    const moded = strips.find((s) => s.host.classList.contains('tplmode'))
    // A strip whose form was hidden under it cannot be holding the keyboard.
    if (moded && !visible(moded.host)) leave(moded, false)
    else if (moded) {
      if (MOD_KEYS.has(ev.key)) return
      const slot = MCTA.digitSlot(ev.code)
      if (slot !== null && !ev.metaKey && !ev.ctrlKey) {
        swallow(ev)
        pick(moded, slot - 1, ev.shiftKey ? 'fill-empty' : 'overwrite')
        return
      }
      if (ev.key === 'Escape') {
        swallow(ev)
        leave(moded, true)
        return
      }
      leave(moded, false)
      return
    }
    if (ev.code === 'KeyT' && ev.altKey && !ev.metaKey && !ev.ctrlKey) {
      const s = activeStrip()
      if (!s) return
      swallow(ev)
      enter(s)
    }
  }

  /** Bubble phase: the hint line says what a click does with the modifiers
   *  held right now, and blur clears them, since a key released while the
   *  window is not focused never arrives. */
  const onMods = (ev) => {
    if (!MOD_KEYS.has(ev.key)) return
    const mods = { shift: !!ev.shiftKey, alt: !!ev.altKey, cmd: !!(ev.metaKey || ev.ctrlKey) }
    for (const s of strips) { s.mods = mods; renderHint(s) }
  }

  // ---- render and attach ----------------------------------------------------

  const render = () => {
    if (!D) return
    renderGear()
    for (const s of strips) renderStrip(s)
    if (editing) renderEditorNote()
  }

  const attach = (deps) => {
    D = deps
    MCE.onField('agentTemplates', (v) => { D.S.agentTemplates = v; render() })
    MCE.on('agentTemplates', (d) => { D.S.agentTemplates = d; render() })
    // The editor's selects and the persona note read S.dispatchOptions, so
    // this keeps it current on every snapshot.
    MCE.onField('dispatchOptions', (v) => { D.S.dispatchOptions = v; render() })

    D.$('tpl-new').onclick = () => openEditor(null)
    D.$('tpl-personas').onchange = () => void onPersonas()

    const modal = D.$('tplmodal')
    D.$('tpl-save').onclick = () => void saveEditor()
    D.$('tpl-delete').onclick = () => void deleteFromEditor()
    D.$('tpl-cancel').onclick = () => closeEditor()
    // The backdrop cancels, as it does for the link dialog.
    modal.addEventListener('mousedown', (ev) => { if (ev.target === modal) closeEditor() })
    // A click inside the editor is not a click on the page behind it: the
    // gear stays open under the editor, so a saved preset shows up in its list.
    modal.addEventListener('click', (ev) => ev.stopPropagation())
    modal.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || !(ev.metaKey || ev.ctrlKey)) return
      ev.preventDefault()
      ev.stopPropagation()
      void saveEditor()
    })
    addEventListener('keydown', onKey, true)
    addEventListener('keydown', onMods)
    addEventListener('keyup', onMods)
    addEventListener('blur', () => { for (const s of strips) { s.mods = NO_MODS; renderHint(s) } })

    for (const [host, adapter] of pending.splice(0)) mountStrip(host, adapter)
    render()
  }

  return {
    attach, render, mountStrip, openEditor, appliedId, detach,
    /** Apply a preset onto the strip mounted on `hostId`, exactly as clicking
     *  its chip does -- including the persona and the tool allowlist, which
     *  live in no field and travel as the recorded id. A caller outside this
     *  file must not reimplement that bookkeeping. Returns false when the
     *  host has no visible strip (its tab is not showing) or the id is
     *  unknown, so the caller can say so rather than appearing to work. */
    applyTo(hostId, templateId, { mode = 'overwrite', submit = false } = {}) {
      const host = D.$(hostId)
      if (!host || !visible(host)) return false
      const s = stripOf(host)
      const t = byId(templateId)
      if (!s || !t) return false
      applyStrip(s, t, mode === 'fill-empty' ? 'fill-empty' : 'overwrite')
      if (submit) s.adapter.submit()
      return true
    },
  }
})()
