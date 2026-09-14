/* Syzygy -- session presets' pure browser half. A CLASSIC script, like
   canvas-layout.js and findings.js: it touches no DOM, reads no storage and
   registers nothing at evaluation time, so it can be evaluated standalone
   under a bare interpreter and still hand back a complete MCTA.

   renderKickoff mirrors the relay's own copy of the same function exactly.
   A classic script cannot import an ES module, so the two are kept
   byte-identical by hand rather than shared -- the same split findings.js
   and findings.mjs live under.

   applyTemplate, slotLabel, digitSlot and chipTitle are the rest of the
   surface a preset picker needs: applying a chosen preset onto a form's
   current fields, labelling and reading back a numbered slot, and titling a
   chip with the two things no field on the form shows (a persona, a tool
   allowlist). None of them know anything about a DOM node, a keyboard event
   beyond the one string code it carries, or the personas setting. */
'use strict'

const MCTA = {
  /** The kickoff a spawn actually sends: the prompt, trimmed, plus -- when
   *  the template names skills -- one line pointing a session at them. */
  renderKickoff(tpl) {
    const prompt = String(tpl?.prompt ?? '').trim()
    const skills = Array.isArray(tpl?.skills) ? tpl.skills : []
    if (!skills.length) return prompt
    return prompt + '\n\nUse these skills: ' + skills.join(', ')
  },

  /** A NEW object with the same keys as `fields`, never a mutation of it.
   *  A template field that is missing, null or an empty/whitespace string
   *  means "inherit" and changes nothing in either mode. `overwrite`
   *  replaces every field the template does name; `fill-empty` only fills a
   *  field in `fields` that is itself empty or whitespace. `name` is never
   *  touched -- a preset never renames the thing somebody is already
   *  filling in. */
  applyTemplate(fields, tpl, mode) {
    const isEmpty = (v) => typeof v !== 'string' || v.trim() === ''
    const named = (v) => typeof v === 'string' && v.trim() !== ''
    const next = { ...fields }

    if (mode === 'overwrite' || isEmpty(fields?.prompt)) {
      if (named(tpl?.prompt)) next.prompt = MCTA.renderKickoff(tpl)
    }
    for (const key of ['model', 'effort']) {
      if ((mode === 'overwrite' || isEmpty(fields?.[key])) && named(tpl?.[key])) {
        next[key] = tpl[key]
      }
    }
    return next
  },

  /** The number a picker shows beside a preset in slot `i` (0-based),
   *  or '' past the nine slots a single digit can reach. */
  slotLabel(i) {
    return Number.isInteger(i) && i >= 0 && i <= 8 ? String(i + 1) : ''
  },

  /** The slot a keydown's `code` picks, read off the physical key rather
   *  than the character -- so holding shift for "fill empty" never changes
   *  which slot a digit names. 'Digit0' is deliberately not slot ten: there
   *  is no slot ten, only 1..9. */
  digitSlot(code) {
    const m = /^Digit([1-9])$/.exec(String(code ?? ''))
    return m ? Number(m[1]) : null
  },

  /** A chip's title: the preset's name, then -- only when the form itself
   *  has no field for it -- what persona and tool allowlist it carries. With
   *  neither, a line saying plainly that the preset only ever touches the
   *  prompt, model and effort. */
  chipTitle(tpl) {
    const name = String(tpl?.name ?? '')
    const agentDef = typeof tpl?.agentDef === 'string' ? tpl.agentDef.trim() : ''
    const tools = (Array.isArray(tpl?.allowedTools) ? tpl.allowedTools : []).filter(Boolean)
    const extra = []
    if (agentDef) extra.push('agent syzygy-agents:' + tpl.id)
    if (tools.length) extra.push('tools ' + tools.join(', '))
    if (!extra.length) extra.push('fills the prompt, model and effort only')
    return name + ' — ' + extra.join(', ')
  },
}

if (typeof window !== 'undefined') window.MCTA = MCTA
