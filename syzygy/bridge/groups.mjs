// Session-space buckets: up to eight named slots, each a saved shape for a
// tmux group, a prompt, a set of exposed files or a loose "belongs together"
// grouping, that a person can re-apply with one action instead of rebuilding
// it by hand every time.
//
// AUTHORITATIVE, not derived: a bucket exists nowhere else, and nothing can
// rebuild one from other state. So every write serializes FIRST, goes to a
// temp file beside the target, and is renamed over it -- a failed serialize
// leaves the previous file exactly as it was. Same contract as
// pasteboard.mjs, agent-templates.mjs, findings.mjs and requests.mjs, for the
// same reason.
//
// Every mutator builds the array it intends to write (`next`), calls
// `flush(next)`, and only on success assigns `items = next` -- a throw during
// flush (or during the validation that builds `next`) must leave both the
// file and the in-memory list exactly as they were.
//
// A full store REFUSES; it never evicts. Dropping the bucket in a slot nobody
// asked to clear would silently destroy a shape somebody built on purpose.
// Every other cap (a name, a block of text, a path list, a member list, a
// colour, a tmux name) refuses the same way rather than quietly truncating --
// a save that silently kept only part of what was typed is worse than one
// that visibly failed.
//
// Reading SANITISES rather than throws. The file is small and hand-editable,
// and a corrupt one blocks every later write rather than being silently
// replaced with an empty store.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'

export const GROUPS_FILE = 'groups.json'
export const GROUPS_MAX = 8
export const KINDS = new Set(['tmux-group', 'prompt', 'files', 'together'])
export const NAME_MAX = 60
export const TEXT_MAX = 20_000
export const PATHS_MAX = 20
export const PATH_MAX = 1024
export const MEMBERS_MAX = 32
export const SLOT_MAX = 8
export const COLOR_RE = /^#[0-9a-f]{6}$/i
export const TMUX_NAME_RE = /^[A-Za-z0-9_.-]{1,60}$/

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// Control characters are stripped, not escaped -- these strings reach a JSON
// file and a pane row. \t, \n and \r survive in `text`: a multi-line prompt
// is the normal case and the whole point.
const CONTROL_ALL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
const CONTROL_LINE = /[\x00-\x1f\x7f]/g

const cleanLine = (v, max) => (typeof v === 'string' ? v.replace(CONTROL_LINE, '').trim().slice(0, max) : '')
const cleanBlock = (v, max) => (typeof v === 'string' ? v.replace(CONTROL_ALL, '').trim().slice(0, max) : '')

/** Trimmed, deduplicated, capped -- a lenient pass for whatever a hand-edited
 *  file happens to hold. The hard refusal for an over-long list lives in
 *  `createGroups`'s `save`, which runs on the RAW field before this ever
 *  sees it; this is only the fallback for reading. */
const cleanPaths = (raw, max) => {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const p = v.trim().slice(0, PATH_MAX)
    if (p && !out.includes(p)) out.push(p)
    if (out.length >= max) break
  }
  return out
}

/** A non-object entry is not a member and is dropped, never coerced. */
const cleanMembers = (raw, max) => {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const m of raw) {
    if (!isPlainObject(m)) continue
    out.push({ id: cleanLine(m.id, 200), name: cleanLine(m.name, NAME_MAX) })
    if (out.length >= max) break
  }
  return out
}

const uid = () => 'g-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

// Four literals from the accent-neighbour palette the pane already ships --
// this file has no access to the pane's CSS custom properties, so seeding
// needs real values rather than a token name.
const SEED_COLORS = ['#e0973c', '#a8213f', '#a883e6', '#45c9a0']
const DEFAULT_COLOR = SEED_COLORS[0]

export const SEEDS = [
  { slot: 1, kind: 'tmux-group', name: 'Group in tmux', tmuxName: 'szg-group' },
  { slot: 2, kind: 'prompt',     name: 'Send a prompt' },
  { slot: 3, kind: 'files',      name: 'Expose files' },
  { slot: 4, kind: 'together',   name: 'Belongs together' },
]

/** One stored bucket, normalised, or null if it is not one.
 *
 *  `kind` is the only required field beyond identity: a bucket with no shape
 *  to apply is not a bucket. Unknown fields are KEPT -- the file is
 *  hand-editable, and a note somebody added by hand must survive the next
 *  write.
 *
 *  `id`, `slot`, `createdAt`, `updatedAt` and `appliedAt` are identity and
 *  bookkeeping: this function fills them in when they are missing or
 *  malformed rather than refusing the whole record, since a hand-edited file
 *  legitimately omits them. The hard refusals (an unknown kind, a taken
 *  slot, an over-cap field) live in `createGroups`'s `save`, which runs
 *  BEFORE a candidate ever reaches here. */
export const sanitizeGroup = (raw, fallbackSlot = 0) => {
  if (!isPlainObject(raw)) return null
  const kind = typeof raw.kind === 'string' && KINDS.has(raw.kind) ? raw.kind : ''
  if (!kind) return null
  const id = typeof raw.id === 'string' && raw.id ? raw.id.replace(CONTROL_LINE, '').slice(0, 64) : ''
  if (!id) return null
  const slotNum = Number(raw.slot)
  const slot = Number.isInteger(slotNum) && slotNum >= 1 && slotNum <= SLOT_MAX ? slotNum : fallbackSlot
  const color = typeof raw.color === 'string' && COLOR_RE.test(raw.color) ? raw.color : DEFAULT_COLOR
  const tmuxName = typeof raw.tmuxName === 'string' && TMUX_NAME_RE.test(raw.tmuxName) ? raw.tmuxName : ''
  const createdAt = Number(raw.createdAt)
  const updatedAt = Number(raw.updatedAt)
  const appliedAt = Number(raw.appliedAt)
  return {
    ...raw,
    id,
    slot,
    kind,
    name: cleanLine(raw.name, NAME_MAX) || 'untitled',
    color,
    tmuxName,
    text: cleanBlock(raw.text, TEXT_MAX),
    paths: cleanPaths(raw.paths, PATHS_MAX),
    members: cleanMembers(raw.members, MEMBERS_MAX),
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : fallbackSlot,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : createdAt,
    appliedAt: Number.isFinite(appliedAt) && appliedAt > 0 ? appliedAt : null,
  }
}

const sortGroups = (items) =>
  [...items].sort((a, b) => a.slot - b.slot || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** Ascending by slot. A missing file is the normal first-run case, read as
 *  empty rather than broken. A file that exists but will not parse is
 *  reported as `broken` -- the caller decides what that means for writes --
 *  rather than degrading silently to empty. */
export const readGroups = (file) => {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { groups: [], broken: false }
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    return { groups: [], broken: true }
  }
  const list = Array.isArray(doc?.groups) ? doc.groups : []
  const out = []
  for (let i = 0; i < list.length; i++) {
    const g = sanitizeGroup(list[i], i + 1)
    if (g) out.push(g)
  }
  return { groups: sortGroups(out), broken: false }
}

const corrupt = (file) => {
  if (!existsSync(file)) return false
  try { JSON.parse(readFileSync(file, 'utf8')); return false } catch { return true }
}

/** Turn a list of user-typed paths into real, existing, absolute paths with
 *  no duplicates -- or refuse naming the one that failed. `home`, `realpath`
 *  and `exists` are injected so a harness can drive it against a made-up
 *  tree; production defaults to the real ones. A non-string or blank entry
 *  is dropped rather than refused, since a path list mid-edit routinely
 *  carries one. */
export const normalizePaths = (raw, { home = homedir(), realpath = realpathSync, exists = existsSync } = {}) => {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    let p = entry.trim()
    if (!p) continue
    if (p === '~') p = home
    else if (p.startsWith('~/')) p = home + p.slice(1)
    if (!p.startsWith('/')) return { ok: false, error: `${p} is not an absolute path` }
    if (p.length > PATH_MAX) return { ok: false, error: `${p} is longer than ${PATH_MAX} characters` }
    if (!exists(p)) return { ok: false, error: `${p} does not exist` }
    let real
    try {
      real = realpath(p)
    } catch (err) {
      return { ok: false, error: `${p}: ${err.message}` }
    }
    if (!out.includes(real)) out.push(real)
  }
  return { ok: true, paths: out }
}

/** `createGroups({ file, now })`.
 *
 *  A corrupt file BLOCKS WRITES: `readGroups` cannot tell "genuinely empty"
 *  from "unreadable", so its own `broken` flag is kept on the store and every
 *  mutator refuses, naming the file, rather than flushing a fresh (empty)
 *  store over the only copy of whatever the file actually held.
 *
 *  Seeding happens once, here, and only when the file does not exist yet --
 *  file existence is the flag, which is what makes "never re-seeded" true
 *  with no second marker to fall out of sync with the file itself. */
export const createGroups = ({ file, now = Date.now }) => {
  const shouldSeed = !existsSync(file)
  const loaded = readGroups(file)
  const readFailed = loaded.broken
  let items = loaded.groups

  const flush = (next = items) => {
    const body = JSON.stringify({ version: 1, groups: next }, null, 2)
    const tmp = `${file}.tmp-${process.pid}`
    try {
      mkdirSync(dirname(file), { recursive: true })
      if (corrupt(file)) {
        // NOT swallowed: if the aside cannot be made, falling through to the
        // rename would destroy the very file the aside was protecting.
        const aside = `${file}.corrupt-${now()}`
        renameSync(file, aside)
        console.error(`groups: ${file} would not parse; moved aside to ${aside}`)
      }
      writeFileSync(tmp, body)
      renameSync(tmp, file)
    } catch (err) {
      try { unlinkSync(tmp) } catch {}
      throw err
    }
  }

  if (shouldSeed) {
    const t = now()
    const seeded = []
    for (let i = 0; i < SEEDS.length; i++) {
      const g = sanitizeGroup({ ...SEEDS[i], id: uid(), color: SEED_COLORS[i], createdAt: t, updatedAt: t }, SEEDS[i].slot)
      if (g) seeded.push(g)
    }
    flush(seeded)
    items = seeded
  }

  const get = (id) => items.find((g) => g.id === id) ?? null

  const refuseUnwritable = () => ({ ok: false, error: `${file} would not parse; refusing to write until it is fixed by hand` })

  return {
    all: () => items,
    get,
    broken: () => readFailed,

    /** `{ id?, kind, name, slot, color?, tmuxName?, text?, paths?, members? }`.
     *  With no `id` (or one this store does not hold) this CREATES, minting
     *  a fresh id and stamping `createdAt`/`updatedAt` together and
     *  `appliedAt: null`. With a known `id` this MERGES the patch onto the
     *  existing bucket: `id`, `createdAt` and `appliedAt` are never taken
     *  from the patch (a forged id could hijack another bucket, a forged
     *  `appliedAt` would let a save fake an apply that `markApplied` alone
     *  is meant to record), and every field the patch omits keeps its
     *  current value. Returns `{ ok: true, group }` or `{ ok: false, error }`
     *  -- never throws for a refusal, because the reason reaches whoever is
     *  filling in the form. Caps refuse whole rather than truncating: a
     *  save that silently kept only part of what somebody typed is worse
     *  than one that visibly failed. */
    save(fields = {}) {
      if (readFailed) return refuseUnwritable()
      const f = isPlainObject(fields) ? fields : {}
      const existing = typeof f.id === 'string' ? get(f.id) : null

      const kind = existing ? (f.kind !== undefined ? f.kind : existing.kind) : f.kind
      if (!KINDS.has(kind)) return { ok: false, error: `unknown kind ${JSON.stringify(kind)}` }

      const rawSlot = f.slot !== undefined ? f.slot : (existing ? existing.slot : undefined)
      const slotNum = Number(rawSlot)
      if (!Number.isInteger(slotNum) || slotNum < 1 || slotNum > SLOT_MAX) {
        return { ok: false, error: `slot must be a whole number from 1 to ${SLOT_MAX}` }
      }

      // Checked before the occupant lookup: once the store is full, any
      // slot a caller names is necessarily somebody's, and "too many
      // groups" is the truer reason for the refusal than "slot taken".
      if (!existing && items.length >= GROUPS_MAX) return { ok: false, error: 'too many groups' }

      const occupant = items.find((g) => g.slot === slotNum && g.id !== existing?.id)
      if (occupant) return { ok: false, error: `slot ${slotNum} is taken by ${JSON.stringify(occupant.name)}` }

      if (f.name !== undefined && typeof f.name === 'string' && f.name.length > NAME_MAX) {
        return { ok: false, error: `name is over ${NAME_MAX} characters` }
      }
      if (f.text !== undefined && typeof f.text === 'string' && f.text.length > TEXT_MAX) {
        return { ok: false, error: `text is over ${TEXT_MAX} characters` }
      }
      if (f.paths !== undefined) {
        if (!Array.isArray(f.paths)) return { ok: false, error: 'paths must be a list' }
        if (f.paths.length > PATHS_MAX) return { ok: false, error: `too many paths (max ${PATHS_MAX})` }
      }
      if (f.members !== undefined) {
        if (!Array.isArray(f.members)) return { ok: false, error: 'members must be a list' }
        if (f.members.length > MEMBERS_MAX) return { ok: false, error: `too many members (max ${MEMBERS_MAX})` }
      }
      if (f.color !== undefined && f.color !== '' && !(typeof f.color === 'string' && COLOR_RE.test(f.color))) {
        return { ok: false, error: 'color must be #rrggbb' }
      }
      if (f.tmuxName !== undefined && f.tmuxName !== '' && !(typeof f.tmuxName === 'string' && TMUX_NAME_RE.test(f.tmuxName))) {
        return { ok: false, error: 'tmuxName must be plain letters, digits, "_", "." or "-"' }
      }

      const t = now()
      const candidate = {
        ...(existing ?? {}),
        ...f,
        id: existing ? existing.id : uid(),
        kind,
        slot: slotNum,
        createdAt: existing ? existing.createdAt : t,
        updatedAt: t,
        appliedAt: existing ? existing.appliedAt : null,
      }
      const group = sanitizeGroup(candidate, slotNum)
      if (!group) return { ok: false, error: 'invalid group' }
      const next = sortGroups([...items.filter((g) => g.id !== group.id), group])
      flush(next)
      items = next
      return { ok: true, group }
    },

    remove(id) {
      if (readFailed) return false
      const next = items.filter((g) => g.id !== id)
      if (next.length === items.length) return false
      flush(next)
      items = next
      return true
    },

    /** Sets `appliedAt` from the injected clock and nothing else -- a plain
     *  patch through `sanitizeGroup` would be safe too, but this is the one
     *  place that is not even theoretically possible to touch another
     *  field. */
    markApplied(id) {
      if (readFailed) return refuseUnwritable()
      const cur = get(id)
      if (!cur) return { ok: false, error: 'no such group' }
      const updated = { ...cur, appliedAt: now() }
      const next = items.map((g) => (g.id === id ? updated : g))
      flush(next)
      items = next
      return { ok: true, group: updated }
    },

    flush,
  }
}
