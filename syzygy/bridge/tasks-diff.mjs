// Labels one worktree's items against the main worktree's.
//
// `removed` means present in MAIN and absent HERE, so its text comes from
// main's own parse -- the register is not involved and must not be imported.
// Pure: no I/O.

/** Where an item sits on the todo -> reported -> verified ladder. This is also
 *  the MERGE RULE: the same plan file exists in every worktree, and on a
 *  checkbox conflict the more advanced state wins -- never the discarding of a
 *  side. Ranking makes that mechanical, and `plan-check` then re-verifies the
 *  merged file against the ledger, which is what makes it safe to do. */
const rank = (i) => (i.checked ? 2 : i.reported ? 1 : 0)

/** @param {Array|null} mainItems the baseline, or null when there is none */
export const labelItems = (mainItems, hereItems) => {
  // A project with one worktree -- including every non-git project -- has no
  // baseline. Diffing says nothing there, so nothing is labelled.
  if (!mainItems) return hereItems.map((i) => ({ ...i, diff: 'same' }))

  const inMain = new Map(mainItems.map((i) => [i.id, i]))
  const here = new Map(hereItems.map((i) => [i.id, i]))

  const out = hereItems.map((i) => {
    const m = inMain.get(i.id)
    if (!m) return { ...i, diff: 'only-here' }
    const a = rank(i), b = rank(m)
    if (a === b) return { ...i, diff: 'same' }
    return { ...i, diff: a > b ? 'done-here' : 'behind' }
  })

  for (const m of mainItems) {
    if (here.has(m.id)) continue
    out.push({ ...m, diff: 'removed', absent: true })
  }
  return out
}

export const rollUp = (worktrees) => {
  const n = { onlyHere: 0, removed: 0, doneHere: 0, behind: 0 }
  for (const w of worktrees) {
    if (w.isMain) continue
    for (const i of w.items ?? []) {
      if (i.diff === 'only-here') n.onlyHere++
      else if (i.diff === 'removed') n.removed++
      else if (i.diff === 'done-here') n.doneHere++
      else if (i.diff === 'behind') n.behind++
    }
  }
  return n
}
