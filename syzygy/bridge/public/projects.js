/* Syzygy -- the Projects view. Read-only by requirement: every task
   list here is rendered from a file on disk and nothing in this file writes
   one back. No <input> elements, deliberately.

   Rendered by KEYED RECONCILIATION (`MCX`, reconcile.js). It used to clear
   `#projlist` and rebuild every node on every payload, which restarted every
   animation, dropped `:hover` and focus, and clamped the scroller to the top
   while you were reading it. Nothing is torn down now: a node is reused if its
   key is still in the payload, moved only if its position is actually wrong,
   and removed only when it genuinely goes away.

   Two rules to keep if you edit this file:
     - NEVER assign `node.className`. It would wipe `.gone` and any state class
       out from under `MCX.show`/`MCX.toggle`. Toggle classes individually.
     - Build optional chips unconditionally in `create` and hide them with
       `MCX.show` in `update`. Adding and removing them reintroduces exactly
       the churn this rewrite removes. */
'use strict'

const MCP = (() => {
  let S = null, post = null, toast = null, el = null, ago = null
  let active = false

  const DIFF_LABEL = {
    'only-here': 'only here',
    'removed': 'removed',
    'done-here': 'done here',
    'behind': 'behind',
  }
  const DIFF_KINDS = Object.keys(DIFF_LABEL)

  // Which plans are opened out. Ordinary view state, held here because it is
  // the view's own business and no payload carries it -- NOT, as it once was, a
  // workaround for DOM state that could not survive a render.
  //
  // Keyed by worktree AND plan, because the same plan file exists in several
  // worktrees and opening one must not open them all. The plan half is the
  // BASENAME, the same identity `tasks-efforts.mjs` uses: a plan may live
  // under either of two directory layouts, so path identity does not hold.
  const expanded = new Set()
  const base = (rel) => String(rel).slice(String(rel).lastIndexOf('/') + 1)

  // A plan's identity WITHIN ONE WORKTREE. Basename, because a plan may live
  // under either of two directory layouts -- but basename ALONE is
  // not unique here, and that is not theoretical: `routeRemoved` adds a ghost
  // for a plan main has that this worktree lacks, and a worktree that keeps its
  // plans under an older directory holds its real copy there while main's lives
  // under the current one. Both land in the same `wt.plans`, same
  // basename, one real and one ghost -- and several such pairs can appear in
  // a single scan.
  //
  // So the ghost flag is part of the identity. `/` is the separator because
  // `base()` has already stripped every `/`, which makes the two namespaces
  // provably disjoint rather than merely unlikely to clash.
  const planIdent = (plan) => (plan.absent ? 'ghost/' : 'live/') + base(plan.rel)
  const planKey = (wt, plan) => wt.path + '\u0000' + planIdent(plan)

  const attach = (deps) => { S = deps.S; post = deps.post; toast = deps.toast; el = deps.el; ago = deps.ago }
  const setView = (name) => { active = name === 'projects'; if (active) render() }

  const plural = (n, word) => n + ' more ' + word + (n === 1 ? '' : 's') + ' over the cap are not shown.'

  // --- session chips ---------------------------------------------------------

  // Reconciled straight into `.wthead`, whose badge/branch/path spans are
  // foreign to the reconciler and are therefore left exactly where they are.
  // `.schip` must stay a DIRECT child of `.wthead`: the CSS lays that row out
  // as a flex line, so wrapping the chips in a container would change it.
  const CHIP = {
    key: (c) => c.s.id,
    create: (c) => {
      const id = c.s.id
      const b = el('button', 'schip')
      b.onclick = () => {
        if (S.linkFrom && S.linkFrom !== id) {
          post('/api/link', { from: S.linkFrom, to: id, kind: 'brief', note: '' })
          // "queued", not "sent": sendBrief reports on queueing, not delivery.
          toast('channel queued — ' + S.linkFrom.slice(0, 6) + ' → ' + b.textContent)
          S.linkFrom = null
        } else {
          S.linkFrom = id
          S.focus = id
          toast('pick another session to open a channel, or press esc')
        }
        render()
      }
      return b
    },
    update: (b, c) => {
      MCX.setText(b, c.s.name)
      MCX.toggle(b, 'working', c.s.working)
      MCX.setAttr(b, 'title', 'cwd ' + c.wt.path)
    },
  }

  // --- rows inside a worktree body, and inside a plan ------------------------

  const itemCreate = () => {
    const row = el('div', 'titem')
    row.appendChild(el('span', 'tbox'))
    row.appendChild(el('span', 'ttext'))
    row.appendChild(el('span', 'tdiff'))
    row.appendChild(el('span', 'thist'))
    return row
  }

  const itemUpdate = (row, item) => {
    MCX.toggle(row, 'absent', item.absent)
    MCX.toggle(row, 'current', item.current)
    MCX.toggle(row, 'section', item.kind === 'section')
    MCX.setText(row.querySelector('.tbox'), item.checked === null ? '' : item.checked ? '[x]' : '[ ]')
    MCX.setText(row.querySelector('.ttext'), item.text)

    const diff = row.querySelector('.tdiff')
    const labelled = item.diff && item.diff !== 'same'
    for (const d of DIFF_KINDS) MCX.toggle(diff, d, item.diff === d)
    MCX.setText(diff, labelled ? DIFF_LABEL[item.diff] : '')
    MCX.show(diff, labelled)

    const h = item.history
    const hist = row.querySelector('.thist')
    const credited = !!(h && h.checkedAt)
    MCX.setText(hist, credited ? '✓ ' + ago(h.checkedAt) + ' by ' + (h.checkedBy ? h.checkedBy.name : '—') : '')
    MCX.show(hist, credited)
  }

  // Collapsed by default to head plus the current step, which is exactly what
  // the per-session drawer shows. Rendering every step of every plan ran one
  // 57-step plan to thousands of lines and defeated the at-a-glance purpose of
  // the tab. Click the head for the whole thing.
  //
  // The current step keeps the SAME key whether the plan is open or shut, so
  // expanding a plan never rebuilds the row you were looking at.
  const planRows = (plan, ekey) => {
    const rows = []
    if (expanded.has(ekey)) {
      for (const item of plan.items) {
        rows.push({ k: 'i:' + item.id, kind: 'item', item: { ...item, current: item.id === plan.currentItemId } })
      }
      if (!plan.items.length) rows.push({ k: 'note', kind: 'note', text: 'no checkbox steps' })
      return rows
    }
    const cur = plan.items.find((i) => i.id === plan.currentItemId)
    if (cur) rows.push({ k: 'i:' + cur.id, kind: 'item', item: { ...cur, current: true } })
    else if (plan.absent) rows.push({ k: 'note', kind: 'note', text: 'absent from this worktree' })
    // Shipped is checked BEFORE the `plan.total` fall-through. A declared plan
    // has no current step by design, so without this branch it landed on
    // "all steps checked" -- printed beside a chip reading `0/N`, which is a
    // false completion claim about a plan nobody ticked. Say the true thing:
    // the milestone landed, and these steps were never verified.
    else if (plan.shipped) rows.push({ k: 'note', kind: 'note',
      text: 'shipped ' + plan.shipped.date + (plan.shipped.commit ? ' · ' + plan.shipped.commit : '') +
            ' · steps never ticked' })
    else if (plan.total) rows.push({ k: 'note', kind: 'note', text: 'all steps checked' })
    else rows.push({ k: 'note', kind: 'note', text: 'no checkbox steps' })
    return rows
  }

  // One spec for every row a worktree body or a plan body can hold. Keys are
  // prefixed by kind, so a key always means one kind of node and `create` can
  // switch on it safely.
  const ROW = {
    key: (r) => r.k,
    create: (r) => {
      if (r.kind === 'item') return itemCreate()
      if (r.kind === 'sect') return el('div', 'sect')
      if (r.kind === 'note') return el('div', 'plannote')
      if (r.kind === 'skip') return el('div', 'skipped')
      if (r.kind === 'empty') return el('div', 'empty')
      // kind === 'plan'
      const ekey = r.ekey
      const box = el('div', 'plan')
      const head = el('div', 'planhead')
      head.appendChild(el('span', 'plancaret'))
      head.appendChild(el('span', 'planname'))
      head.appendChild(el('span', 'plancount'))
      head.appendChild(el('span', 'planowner'))
      head.appendChild(el('span', 'tdiff'))
      head.onclick = () => {
        if (expanded.has(ekey)) expanded.delete(ekey); else expanded.add(ekey)
        render()
      }
      box.appendChild(head)
      box.appendChild(el('div', 'planbody'))
      return box
    },
    update: (node, r) => {
      if (r.kind === 'item') return itemUpdate(node, r.item)
      if (r.kind !== 'plan') return MCX.setText(node, r.text)

      const plan = r.plan
      const head = node.querySelector('.planhead')
      MCX.toggle(node, 'absent', plan.absent)
      MCX.setText(head.querySelector('.plancaret'), expanded.has(r.ekey) ? '▾' : '▸')
      MCX.setText(head.querySelector('.planname'), plan.title || plan.rel)

      // NEVER COLLAPSE REPORTED INTO DONE. `[~]` is what an executor believes
      // and `[x]` is what a reviewer confirmed; a chip that adds them together
      // is precisely the lie the three states exist to remove. With nothing
      // reported the familiar done/total is unchanged, so this only adds detail
      // where there is detail to add.
      const rep = plan.reported ?? 0
      MCX.setText(head.querySelector('.plancount'), rep
        ? plan.done + ' verified · ' + rep + ' reported · ' +
          Math.max(0, plan.total - plan.done - rep) + ' to do'
        : plan.done + '/' + plan.total)
      MCX.setText(head.querySelector('.planowner'), plan.owner ? '◉ ' + plan.owner.name : '—')

      // Every plan-level label, not just only-here: a ghost plan (one main has
      // that this worktree lacks entirely) arrives with diff 'removed'.
      const diff = head.querySelector('.tdiff')
      const labelled = plan.diff && plan.diff !== 'same'
      for (const d of DIFF_KINDS) MCX.toggle(diff, d, plan.diff === d)
      MCX.setText(diff, labelled ? DIFF_LABEL[plan.diff] : '')
      MCX.show(diff, labelled)

      MCX.reconcile(node.querySelector('.planbody'), planRows(plan, r.ekey), ROW)
    },
  }

  const bodyRows = (wt) => {
    const rows = []
    if (wt.plans.length) {
      rows.push({ k: 's:plans', kind: 'sect', text: 'Plans (in flight)' })
      for (const plan of wt.plans) {
        rows.push({ k: 'p:' + planIdent(plan), kind: 'plan', plan, ekey: planKey(wt, plan) })
      }
    }
    for (const t of wt.tasks) {
      rows.push({ k: 's:' + t.rel, kind: 'sect', text: 'Tasks (backlog) · ' + t.rel })
      for (const item of t.items) rows.push({ k: 'i:' + t.rel + ':' + item.id, kind: 'item', item })
    }
    if (!wt.plans.length && !wt.tasks.length) {
      rows.push({ k: 'empty', kind: 'empty', text: 'No TASKS.md and no plans in this worktree.' })
    }
    for (const s of wt.skipped) {
      rows.push({ k: 'k:' + s.rel, kind: 'skip', text: s.rel + ' — skipped (' + s.reason + ')' })
    }
    return rows
  }

  // --- worktrees -------------------------------------------------------------

  const PBODY = {
    key: (r) => r.k,
    create: (r) => {
      if (r.kind === 'overcap') return el('div', 'overcap')
      const box = el('div', 'wtree')
      const head = el('div', 'wthead')
      head.appendChild(el('span', 'wtbadge'))
      head.appendChild(el('span', 'wtbranch'))
      head.appendChild(el('span', 'wtpath'))
      box.appendChild(head)
      box.appendChild(el('div', 'wtbody'))
      return box
    },
    update: (node, r) => {
      if (r.kind === 'overcap') return MCX.setText(node, r.text)
      const wt = r.wt
      const head = node.querySelector('.wthead')
      MCX.toggle(node, 'main', wt.isMain)
      MCX.setText(head.querySelector('.wtbadge'), wt.isMain ? 'main' : 'worktree')
      MCX.setText(head.querySelector('.wtbranch'), wt.branch || (wt.detached ? 'detached' : '—'))
      const path = head.querySelector('.wtpath')
      MCX.setText(path, wt.path)
      MCX.show(path, r.multi)
      MCX.reconcile(head, wt.sessions.map((s) => ({ s, wt })), CHIP)
      MCX.reconcile(node.querySelector('.wtbody'), bodyRows(wt), ROW)
    },
  }

  const wtRows = (p) => {
    const multi = p.worktrees.length > 1
    const rows = p.worktrees.map((wt) => ({ k: 'w:' + wt.path, kind: 'wt', wt, multi }))
    const over = p.overCap ? p.overCap.worktrees : 0
    if (over) rows.push({ k: 'overcap', kind: 'overcap', text: plural(over, 'worktree') })
    return rows
  }

  // --- projects --------------------------------------------------------------

  const TOP = {
    key: (r) => r.k,
    create: (r) => {
      if (r.kind === 'empty') return el('div', 'empty')
      if (r.kind === 'overcap') return el('div', 'overcap')
      const box = el('div', 'project')
      const head = el('div', 'projhead')
      head.appendChild(el('span', 'projname'))
      head.appendChild(el('span', 'projpath'))
      head.appendChild(el('span', 'projwt'))
      head.appendChild(el('span', 'projroll'))
      box.appendChild(head)
      box.appendChild(el('div', 'projbody'))
      return box
    },
    update: (node, r) => {
      if (r.kind !== 'project') return MCX.setText(node, r.text)
      const p = r.p
      const head = node.querySelector('.projhead')
      MCX.setText(head.querySelector('.projname'), p.name)
      MCX.setText(head.querySelector('.projpath'), p.mainRoot)

      const wtc = head.querySelector('.projwt')
      const multi = p.worktrees.length > 1
      MCX.setText(wtc, multi ? p.worktrees.length + ' worktrees' : '')
      MCX.show(wtc, multi)

      const roll = p.roll
      const bits = []
      if (roll.onlyHere) bits.push(roll.onlyHere + ' only in a worktree')
      if (roll.doneHere) bits.push(roll.doneHere + ' done in a worktree')
      if (roll.removed) bits.push(roll.removed + ' removed')
      if (roll.behind) bits.push(roll.behind + ' behind')
      const rollEl = head.querySelector('.projroll')
      MCX.setText(rollEl, bits.join(' · '))
      MCX.show(rollEl, bits.length > 0)

      MCX.reconcile(node.querySelector('.projbody'), wtRows(p), PBODY)
    },
  }

  const topRows = (projects) => {
    if (!projects.length) {
      return [{ k: 'empty', kind: 'empty', text: 'No projects yet. They appear as sessions report in.' }]
    }
    const rows = []
    // Over a cap is reported, never silently dropped (spec 4.1). The count is
    // the same on every project, so the first one carries it for all.
    const over = projects[0].overCap ? projects[0].overCap.projects : 0
    if (over) rows.push({ k: 'overcap', kind: 'overcap', text: plural(over, 'project') })
    for (const p of projects) rows.push({ k: 'p:' + p.key, kind: 'project', p })
    return rows
  }

  // No scrollTop save/restore any more. It existed only because clearing
  // `#projlist` took its children to zero height and the browser clamped the
  // scroll to the top -- which happened every time any session's `working`
  // flag flipped, i.e. while you were reading. Nothing is cleared now.
  const render = () => {
    if (!active) return
    const list = document.getElementById('projlist')
    if (!list) return
    const projects = S.projects || []
    MCX.setText(document.getElementById('c-projects'), String(projects.length))
    MCX.reconcile(list, topRows(projects), TOP)
  }

  return { attach, setView, render }
})()
