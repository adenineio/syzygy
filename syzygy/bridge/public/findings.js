/* The Findings panel. A classic script, global MCF, attached by app.js the way
   MCP/MCD/MCC are. It registers its OWN stream handlers, so app.js gains one
   line -- which is the whole point of the MCE registry.

   MCX-reconciled and keyed by finding id: NEVER assign node.className here,
   and optional chips are built once and hidden with MCX.show.

   Nothing runs at evaluation time: no DOM, no localStorage, no MCE until
   attach(). The fleet harness evaluates this file in an empty node:vm context
   to hold its restated rules to the relay's.

   The relay's snapshot budget can shed the whole findings list from a frame,
   and S.shed then names `findings`. The panel says how many it is missing and
   loads them on demand: click loads this list, shift-click every shed section
   (MCBG.loadAll), option-click pins the section so it loads by itself. A copy
   loaded that way lives in this module and never in S, so a later snapshot
   cannot overwrite it and flicker the panel empty; a snapshot that no longer
   sheds the section drops it and S is drawn again. */
'use strict'

const MCF = (() => {
  let S, $, el, post, toast, ago
  let armedDelete = null, armedTimer = null

  const SECTION = 'findings'
  let bg = null                 // MCBG, when the chip's script is on the page
  let loaded = null             // the full list from GET /api/findings, or null
  let loading = false
  // A live `findings` event arrived since the last snapshot: S.findings holds
  // the newest list again, so there is nothing to offer to load.
  let liveSince = false

  const KIND_LABEL = {
    constraint: 'constraint', drift: 'drift', hazard: 'hazard',
    'dead-code': 'dead code', duplicate: 'duplicate', question: 'question',
  }
  const FILTER_KEY = 'szg.findings.filters'
  const readFilters = () => { try { const v = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}'); return { project: String(v.project ?? ''), kind: String(v.kind ?? '') } } catch { return { project: '', kind: '' } } }
  const writeFilters = (f) => { try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)) } catch {} }

  const shedRow = () => (S && Array.isArray(S.shed) ? S.shed : []).find((r) => r && r.section === SECTION) || null
  const rowsNow = () => loaded ?? (S.findings || [])
  const moreFindings = (n) => `${n} more finding${n === 1 ? '' : 's'}`

  /** The full store, into this module. Kept only while the frame still sheds
   *  the section; a failure says so and leaves the line where it was. */
  const load = async () => {
    if (loading) return
    loading = true
    render()
    try {
      const r = await fetch('/api/findings?limit=200', { cache: 'no-store' })
      const d = await r.json()
      if (!r.ok || !Array.isArray(d && d.findings)) throw new Error((d && d.error) || 'status ' + r.status)
      if (shedRow()) loaded = d.findings
    } catch (e) {
      toast('findings did not load: ' + (e && e.message ? e.message : 'unreachable'), { kind: 'warn' })
    }
    loading = false
    render()
  }

  /** The same rule findings.mjs exports as hasLineEvidence, restated for a
   *  browser that cannot import it. findings.mjs is the source of truth;
   *  test/fleet-harness.mjs asserts the two agree. */
  const hasLine = (ev) => Array.isArray(ev) && ev.some((e) => typeof e === 'string' && /:\d+(:\d+)?$/.test(e.trim()))

  // One spec for a chip inside a finding row. `touched` and `evidence` both
  // use it -- only the class and the text differ, and both are fixed once the
  // chip is created.
  const CHIPS = {
    key: (c) => c.k,
    create: (c) => el('span', 'fchip ' + c.cls),
    update: (node, c) => MCX.setText(node, c.text),
  }

  const ROW = {
    key: (f) => f.id,
    create: (f) => {
      const row = el('div', 'finditem')
      const head = el('div', 'fhead')
      head.appendChild(el('span', 'fkind'))
      head.appendChild(el('span', 'fproj'))
      head.appendChild(el('span', 'fsess'))
      head.appendChild(el('span', 'spacer'))
      head.appendChild(el('span', 'fago'))
      const del = el('button', 'btn no fdel', '×')
      head.appendChild(del)
      row.appendChild(head)
      row.appendChild(el('div', 'fsurprise'))
      const chips = el('div', 'fchips')
      chips.appendChild(el('div', 'ftouched'))
      chips.appendChild(el('div', 'fevidence'))
      chips.appendChild(el('span', 'fchip warn fnoline', 'no line evidence'))
      row.appendChild(chips)

      // findings.mjs is AUTHORITATIVE -- a finding exists nowhere else and
      // nothing can rebuild one -- so a misclick destroys the only copy. First
      // click arms for 3 s and relabels; the second deletes. Same affordance
      // pane-v2/internal/ui/hotkeys.go uses, for the same reason.
      del.onclick = () => {
        if (armedDelete !== f.id) {
          armedDelete = f.id
          clearTimeout(armedTimer)
          armedTimer = setTimeout(() => { armedDelete = null; render() }, 3000)
          return render()
        }
        armedDelete = null
        clearTimeout(armedTimer)
        void post('/api/findings/delete', { id: f.id }).then((r) => {
          if (r.error) toast('not deleted: ' + r.error, { kind: 'warn' })
        })
      }
      return row
    },
    update: (row, f) => {
      const kind = row.querySelector('.fkind')
      MCX.setText(kind, KIND_LABEL[f.kind] || 'unclassified')
      MCX.toggle(kind, 'unclassified', !f.kind)
      MCX.setText(row.querySelector('.fproj'), f.project || '—')
      MCX.setText(row.querySelector('.fsess'), f.session || '—')
      MCX.setText(row.querySelector('.fago'), ago(f.t))
      MCX.setText(row.querySelector('.fsurprise'), f.surprise)
      MCX.reconcile(row.querySelector('.ftouched'),
        (f.touched || []).map((t, i) => ({ k: String(i) + ':' + t, cls: 'touched', text: t })), CHIPS)
      MCX.reconcile(row.querySelector('.fevidence'),
        (f.evidence || []).map((e, i) => ({ k: String(i) + ':' + e, cls: 'evidence', text: e })), CHIPS)
      MCX.show(row.querySelector('.fnoline'), !hasLine(f.evidence))
      MCX.setText(row.querySelector('.fdel'), armedDelete === f.id ? 'click again to confirm' : '×')
    },
  }

  /** The SESSION half of fleet.mjs's sweepGate, restated for a browser that
   *  cannot import it, so the label reads right between polls: busy means
   *  working and not waiting, then the quiet window. Dispatch requests and
   *  canvas spawns are the relay's to weigh. test/fleet-harness.mjs asserts
   *  the two agree. */
  const gateOf = (sessions, quietMs, now) => {
    const list = Array.isArray(sessions) ? sessions : []
    const busy = list.filter((s) => s.working && !s.waiting).map((s) => s.name || String(s.id ?? '').slice(0, 8)).filter(Boolean)
    if (busy.length) return { ok: false, busy, reason: `${busy.length} session${busy.length > 1 ? 's are' : ' is'} working: ${busy.slice(0, 4).join(', ')}` }
    const lastBusyAt = list.reduce((acc, s) => Math.max(acc, s.idleSince ?? s.startedAt ?? 0), 0)
    const quietFor = now - lastBusyAt
    if (quietFor < quietMs) return { ok: false, busy, reason: `the board went quiet ${Math.round(quietFor / 60_000)} min ago; a sweep waits ${Math.round(quietMs / 60_000)}` }
    return { ok: true, busy, reason: '' }
  }

  /** The sweep runs in ONE project: the one whose name, or main root's last
   *  segment, the project filter names. "Any project", or a name matching zero
   *  or two projects, refuses rather than guesses. A finding's `project` is a
   *  display name and /api/sweep needs a directory, so the scanner's projects
   *  are the only honest bridge between the two. The export still carries
   *  every project's findings. */
  const PICK_ONE = 'choose one project in the filter; the review lands on a branch in that repo'
  const projectOf = (want) => {
    if (!want) return { error: PICK_ONE }
    const hits = (S.projects ?? []).filter((p) => p.name === want || String(p.mainRoot ?? '').split('/').pop() === want)
    return hits.length === 1 ? { root: hits[0].mainRoot } : { error: PICK_ONE }
  }

  /** The project filter as the select SHOWS it. A remembered project that no
   *  longer appears among the findings reads as "any project" everywhere --
   *  the select, the list and the sweep target -- rather than the select
   *  saying one thing while the list silently filters on another. */
  const projectsIn = (rows) => {
    const projects = []
    for (const f of rows) if (f.project && !projects.includes(f.project)) projects.push(f.project)
    return projects.sort()
  }
  const effectiveProject = (rows, filters) => projectsIn(rows).includes(filters.project) ? filters.project : ''

  // The button is never merely dead: the reason renders under it and on its
  // tip. A disabled control with no explanation is a dead end nobody can
  // diagnose. A relay without `sweepQuietMs` predates the sweep entirely.
  const renderGate = () => {
    const btn = $('f-sweep')
    if (!btn) return
    const target = projectOf(effectiveProject(rowsNow(), readFilters()))
    const g = typeof S.sweepQuietMs === 'number'
      ? gateOf(S.sessions, S.sweepQuietMs, Date.now())
      : { ok: false, reason: 'this relay predates the architecture sweep' }
    const line = target.error || (g.ok ? '' : g.reason)
    btn.disabled = false                  // ⌥ must still be clickable
    btn.dataset.tip = !line
      ? 'Spawn one fresh session to review the whole build: right problem, simpler way.'
      : line + (target.error ? '' : '\n\noption-click runs it anyway')
    MCX.setText($('f-gate'), line)
    MCX.show($('f-gate'), !!line)
  }

  const render = () => {
    const list = $('findlist')
    if (!list) return
    const shed = shedRow()
    if (!shed) loaded = null
    const rows = rowsNow()
    const filters = readFilters()
    const project = effectiveProject(rows, filters)

    // Project options are an open set -- unlike kind's fixed six shapes below
    // -- so they are rebuilt from the findings themselves on every render
    // rather than declared once.
    const projSel = $('f-project')
    while (projSel.options.length > 1) projSel.remove(1)
    for (const p of projectsIn(rows)) {
      const o = el('option', '', p)
      o.value = p
      projSel.appendChild(o)
    }
    projSel.value = project
    $('f-kind').value = filters.kind

    const filtered = rows.filter((f) =>
      (!project || f.project === project) &&
      (!filters.kind || f.kind === filters.kind))
    filtered.sort((a, b) => b.t - a.t)

    MCX.setText($('c-findings'), String(filtered.length))
    MCX.reconcile(list, filtered, ROW)
    // Two different empties: a store with nothing in it, and a filter that
    // hides everything in a store that has plenty. Saying "nothing reported"
    // for the second sends somebody looking for a bug in report_finding.
    // A shed list is neither of those: the line says how many the frame left
    // out, in place of an empty state that would claim there are none.
    const missing = !!shed && loaded === null && !liveSince
    const line = $('f-shed')
    if (line) {
      const n = shed ? shed.dropped : 0
      const pin = bg ? bg.pinned(SECTION) : false
      MCX.setText(line, loading ? `loading ${moreFindings(n)}…` : `${moreFindings(n)} — open to load`)
      MCX.toggle(line, 'pinned', pin)
      MCX.setAttr(line, 'data-tip', 'Shed from this frame to keep it under budget\n'
        + 'click loads them · shift-click loads every shed section · option-click '
        + (pin ? 'stops loading them by themselves' : 'loads them by themselves from now on'))
      MCX.show(line, missing)
    }
    const empty = list.querySelector('.empty')
    MCX.setText(empty, rows.length
      ? `The filter matched none of ${rows.length} finding${rows.length === 1 ? '' : 's'}.`
      : 'Nothing reported yet.')
    MCX.show(empty, filtered.length === 0 && !missing)
    renderGate()
  }

  const attach = (deps) => {
    ({ S, $, el, post, toast, ago } = deps)
    // Six fixed shapes, unlike a project: built once here rather than rebuilt
    // on every render.
    for (const [k, label] of Object.entries(KIND_LABEL)) {
      const o = el('option', '', label)
      o.value = k
      $('f-kind').appendChild(o)
    }
    // Its own registrations, in its own file: the snapshot field and the live
    // event. A relay that predates the field sends no `findings` key at all,
    // and onField's `name in d` guard means the panel simply stays empty --
    // never a throw, and S.findings starts as [] for the same reason.
    MCE.onField('findings', (v) => { S.findings = v; liveSince = false; render() })
    // A live event carries the store's newest findings whatever the last frame
    // shed. A loaded copy is fetched again so an addition or a delete shows in
    // it; with no loaded copy, S.findings is the list again.
    MCE.on('findings', (d) => {
      S.findings = d.findings ?? []
      if (loaded !== null) void load(); else liveSince = true
      render()
    })
    bg = typeof MCBG === 'undefined' ? null : MCBG
    if (bg) bg.register(SECTION, load)
    const shedLine = $('f-shed')
    if (shedLine) shedLine.onclick = (ev) => {
      if (ev.altKey) {
        const on = bg ? bg.togglePin(SECTION) : null
        toast(on === null ? 'this browser would not store the pin'
          : on ? 'findings now load by themselves whenever a frame sheds them'
          : 'findings no longer load by themselves')
        if (on) void load()
        render()
        return
      }
      if (ev.shiftKey && bg) { void bg.loadAll(); return }
      void load()
    }
    // The quiet window as THIS relay resolved it. An older relay sends no key,
    // so S.sweepQuietMs stays undefined and the gate line says so.
    MCE.onField('sweepQuietMs', (v) => { S.sweepQuietMs = v; render() })
    // Only the gate line: the list does not depend on sessions, and this
    // event arrives with every heartbeat. app.js registered its own handler
    // first, so S.sessions is already current here.
    MCE.on('sessions', () => renderGate())
    // The select's value is the effective project -- render() set it -- so
    // what persists is what the list shows.
    $('f-project').onchange = $('f-kind').onchange = () => {
      writeFilters({ project: $('f-project').value, kind: $('f-kind').value }); render()
    }
    $('f-sweep').onclick = (ev) => {
      const t = projectOf($('f-project').value)
      if (t.error) return void toast('sweep: ' + t.error, { kind: 'warn' })
      void post('/api/sweep', { project: t.root, override: ev.altKey }).then((r) => {
        if (r.error) return toast('sweep: ' + r.error, { kind: 'warn' })
        toast(`sweep started on ${r.branch}; the review lands on that branch and nothing is merged`)
      })
    }
    render()
  }

  return { attach, render, hasLine, gateOf }
})()
