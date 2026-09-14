// A session card's own outline colour and whether it is a favourite -- both
// set from the drawer, so a card you keep coming back to is easy to find and
// quick to reach. AUTHORITATIVE, not derived: neither exists anywhere else,
// so every write serializes FIRST, goes to a temp file in the same
// directory, and is renamed over the target -- a failed serialize leaves the
// previous file intact. Same contract as claims.mjs and findings.mjs, for
// the same reason.
//
// Keyed by the session's NAME, not its id -- the opposite of claims.mjs and
// canvas.mjs's position store, which are id-keyed with name carried as a
// field for matching. A terminal gets a fresh session id every restart
// (claims-inherit.mjs's header), and the thing a colour is picked FOR is the
// session you keep finding on the board, which is the name, not the
// id that happens to be running it this time. Because the key IS the name,
// there can never be two STALE entries sharing one to disambiguate between --
// the ambiguity claims-inherit.mjs and canvas.mjs's inheritPosition guard
// against cannot arise in the store itself. It still exists on the LIVE side:
// two live sessions currently wearing the same name cannot both safely show
// one stored colour, so `inheritableCardColor` below refuses exactly then,
// for the same reason those two modules refuse -- ambiguity means do nothing.
// The `id` on each entry is a secondary key, informational: which session
// last set this name's colour, kept so the file stays legible hand-edited,
// same as every other authoritative store here.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

export const COLOR_RE = /^#[0-9a-f]{6}$/i

/** '' (or nullish) clears a colour. Anything else must be exactly #rrggbb --
 *  what a `<input type="color">` and every preset swatch below produce, and
 *  the one shape CSS can hand straight to `outline-color` with no further
 *  parsing on either end. */
export const validateColor = (raw) => {
  if (raw === '' || raw == null) return { ok: true, color: '' }
  if (typeof raw !== 'string') return { ok: false, error: 'color must be #rrggbb or empty' }
  const v = raw.trim()
  if (!COLOR_RE.test(v)) return { ok: false, error: 'color must be #rrggbb or empty' }
  return { ok: true, color: v.toLowerCase() }
}

/** A favourite is a plain boolean and nothing else: anything looser and a
 *  hand-edited `"yes"` would read as true on one path and false on another. */
export const validateFavourite = (raw) => {
  if (typeof raw !== 'boolean') return { ok: false, error: 'favourite must be true or false' }
  return { ok: true, favourite: raw }
}

/** One stored entry, or `null` if it says nothing worth keeping. An entry is
 *  worth keeping when it carries a colour OR a favourite: it used to require
 *  a colour, which would have dropped every favourite on the next read. */
const sanitizeEntry = (name, raw) => {
  if (!name || !isPlainObject(raw)) return null
  const c = validateColor(raw.color)
  const color = c.ok ? c.color : ''
  const favourite = raw.favourite === true
  if (!color && !favourite) return null
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    color,
    favourite,
    updatedAt: Number(raw.updatedAt) || 0,
  }
}

/** Absence is the normal first-run case, not an error. A corrupt file
 *  degrades to "no cards" here -- the same bargain claims.mjs's readClaims
 *  and findings.mjs's readFindings make -- and is moved aside by the next
 *  write rather than being silently overwritten (see `flush` below). */
export const readCards = (file) => {
  let doc
  try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
  const raw = isPlainObject(doc?.byName) ? doc.byName : {}
  const out = {}
  for (const [name, entry] of Object.entries(raw)) {
    const e = sanitizeEntry(name, entry)
    if (e) out[name] = e
  }
  return out
}

/** Same two rules claims-inherit.mjs and canvas.mjs's inheritPosition apply,
 *  adapted to a store keyed by name: never hand a stored colour to a live
 *  session when a second live session currently wears the same name -- there
 *  is no telling whose colour it is. `liveSessions` should include the
 *  session being asked about; a solitary match (itself) inherits, a second
 *  match (another live session sharing the name) refuses for both. Pure. */
export const inheritableCardColor = (byName, name, liveSessions) => {
  if (!name) return ''
  const entry = byName?.[name]
  if (!entry || !entry.color) return ''
  const sharing = (liveSessions ?? []).filter((s) => s && s.name === name)
  if (sharing.length > 1) return ''
  return entry.color
}

/** `createCards({file, now})`. Write-through like findings.mjs's createFindings:
 *  a colour is picked at human pace, not a heartbeat, so there is no write
 *  amplification worth batching away, and a relay killed right after the pick
 *  should not lose it waiting on a 4 s tick. */
export const createCards = ({ file, now = Date.now }) => {
  let byName = readCards(file)

  const flush = () => {
    // Serialize FIRST. If this throws, nothing has been written.
    const body = JSON.stringify({ version: 1, byName }, null, 2)
    const tmp = file + '.tmp'
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, body)
      renameSync(tmp, file)
    } catch (err) {
      try { unlinkSync(tmp) } catch {}
      throw err
    }
  }

  return {
    all: () => byName,

    colorFor: (name, liveSessions) => inheritableCardColor(byName, name, liveSessions),

    /** Set (or, with '', clear) the colour stored under `name`. `id` is
     *  carried through as the informational secondary key, never used to
     *  look anything up. Returns `{ok:true, color}` or `{ok:false, error}`;
     *  a clear against a name with nothing stored is a no-op success. */
    set(name, id, color) {
      const r = validateColor(color)
      if (!r.ok) return r
      if (!name) return { ok: true, color: r.color }
      const prior = byName[name]
      if (!r.color) {
        // A cleared colour removes the entry only when nothing else lives on
        // it. An entry that is still a favourite keeps its place.
        if (!prior) return { ok: true, color: '' }
        if (prior.favourite) {
          byName = { ...byName, [name]: { ...prior, id: id || prior.id || '', color: '', updatedAt: now() } }
          flush()
          return { ok: true, color: '' }
        }
        const next = { ...byName }
        delete next[name]
        byName = next
        flush()
        return { ok: true, color: '' }
      }
      byName = { ...byName, [name]: { ...prior, id: id || '', color: r.color, favourite: prior?.favourite === true, updatedAt: now() } }
      flush()
      return { ok: true, color: r.color }
    },

    /** Set (or clear) the favourite flag under `name`, the same
     *  serialize-then-rename write `set` makes. Clearing the last signal on an
     *  entry removes it, so the file never fills with empty records. */
    setFavourite(name, id, on) {
      const r = validateFavourite(on)
      if (!r.ok) return r
      if (!name) return { ok: true, favourite: r.favourite }
      const prior = byName[name]
      if (!r.favourite) {
        if (!prior) return { ok: true, favourite: false }
        if (!prior.color) {
          const next = { ...byName }
          delete next[name]
          byName = next
        } else {
          byName = { ...byName, [name]: { ...prior, favourite: false, updatedAt: now() } }
        }
        flush()
        return { ok: true, favourite: false }
      }
      byName = {
        ...byName,
        [name]: { id: id || prior?.id || '', color: prior?.color || '', favourite: true, updatedAt: now() },
      }
      flush()
      return { ok: true, favourite: true }
    },

    /** The favourites, ascending by name -- which is the order the deck's
     *  digits follow, so starring something that sorts last moves no digit. */
    favourites: () => Object.entries(byName)
      .filter(([, e]) => e && e.favourite === true)
      .map(([name, e]) => ({ name, color: e.color || '' }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),

    flush,
  }
}
