// The thin derived register: WHEN and WHO, never what.
//
// The markdown always wins for an item's text and state. This file only holds
// facts the markdown cannot express -- when an item appeared, when it was
// checked and by whom, when it vanished. It is strictly derived and may be
// deleted at any time: the view simply loses its history. That is what stops
// it becoming a second source of truth, which would sit badly with the
// requirement that the list is uneditable.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_ENTRIES = 5000

export const emptyRegister = () => ({ version: 1, items: {} })

// '\0' can never occur in a filesystem path or in our hashed item ids, so it
// is an unambiguous join -- the same separator tasks-parse.mjs's itemId()
// uses to join relPath and normalizeTitle(text). Without it, a worktree path
// that happens to be a string-prefix of another (e.g. "/repo" vs
// "/repo-old") could make one worktree's startsWith() prefix scan in
// observe() below match keys that belong to the other.
export const keyOf = (worktreePath, itemId) => worktreePath + '\0' + itemId

/** Who to credit for a check. The rules are tried in order, and rule 3 is the
 *  point: a dashboard naming the wrong session is worse than one saying it
 *  cannot tell.
 *
 *  `working` alone will not do. It means "has an unfinished turn", so a session
 *  parked at a permission prompt reports it for as long as it waits -- which
 *  would make it the permanent sole-working candidate in its worktree and hand
 *  it every check another session made there. Requiring the stats fingerprint
 *  to have moved is what separates working from merely stuck. */
const creditFor = (sessionsHere, prevActivity) => {
  if (sessionsHere.length === 1) return { id: sessionsHere[0].id, name: sessionsHere[0].name }
  const active = sessionsHere.filter((s) => {
    const prev = prevActivity.get(s.id)
    return prev?.working === true && prev.fingerprint !== s.fingerprint
  })
  if (active.length === 1) return { id: active[0].id, name: active[0].name }
  return null
}

/** Fold one worktree's freshly parsed items into the register. */
export const observe = (reg, worktreePath, items, sessionsHere, prevActivity, at) => {
  const seen = new Set()
  for (const item of items) {
    const k = keyOf(worktreePath, item.id)
    seen.add(k)
    const e = reg.items[k] ?? (reg.items[k] = {
      firstSeen: at, lastSeen: at, checkedAt: null, checkedBy: null,
      uncheckedAt: null, removedAt: null, text: item.text,
      // Seed the last-observed state from what is already there. An item first
      // seen ALREADY checked was checked before this register existed, so there
      // is no flip to credit and no honest time to stamp. Seeding `true` here
      // is what makes deleting the register lose history rather than invent it.
      wasChecked: item.checked === true,
    })
    e.lastSeen = at
    e.text = item.text
    e.removedAt = null
    // Credit only a genuine transition. Testing `checkedAt === null` instead
    // would treat every first sighting of a checked item as a fresh check --
    // and would do it again on the next pass, and the next.
    if (item.checked === true && e.wasChecked === false) {
      e.checkedAt = at
      e.checkedBy = creditFor(sessionsHere, prevActivity)
    } else if (item.checked === false && e.wasChecked === true) {
      e.checkedAt = null
      e.checkedBy = null
      e.uncheckedAt = at
    }
    e.wasChecked = item.checked === true
  }
  // Anything this worktree used to have and no longer does.
  const prefix = worktreePath + '\0'
  for (const [k, e] of Object.entries(reg.items)) {
    if (!k.startsWith(prefix) || seen.has(k) || e.removedAt !== null) continue
    e.removedAt = at
  }
}

export const historyFor = (reg, worktreePath, itemId) => reg.items[keyOf(worktreePath, itemId)] ?? null

export const prune = (reg, at) => {
  for (const [k, e] of Object.entries(reg.items)) {
    if (at - e.lastSeen > MAX_AGE_MS) delete reg.items[k]
  }
  const keys = Object.keys(reg.items)
  if (keys.length <= MAX_ENTRIES) return
  keys.sort((a, b) => reg.items[a].lastSeen - reg.items[b].lastSeen)
  for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete reg.items[k]
}

export const load = (file) => {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8'))
    return r && r.items ? { ...emptyRegister(), ...r } : emptyRegister()
  } catch { return emptyRegister() }
}

export const save = (file, reg) => {
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(reg)) } catch {}
}
