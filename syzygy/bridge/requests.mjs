// The Dispatch tab's request store. One queued item per Request; this module
// owns their shape, their slug, their state machine and their persistence.
//
// Unlike world.json this file is AUTHORITATIVE, not derived: a brief exists
// nowhere else until it is dispatched, and it cannot be rebuilt if lost. So
// every write goes to a temp file in the same directory and is renamed over
// the target, and a serialize that throws leaves the previous file untouched.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { validateCwd } from './canvas.mjs'
import { sanitizeForPeer } from './peer.mjs'

/** A request's `project` becomes a spawn's `cwd` and a `tmux new-window -c`,
 *  so it must be a real directory before it becomes either.
 *
 *  A request can arrive carrying the repo NAME as its project rather than
 *  its path -- the orchestrator's own action schema shows the field as
 *  `"project?": "<repo>"`. `scoping.mjs` would then spawn `claude -p` with
 *  that name as the cwd, and **node reports a missing cwd as
 *  `spawn ... ENOENT`**, which reads exactly like the binary being missing.
 *  `/api/takeover`'s `tmux new-window -c` fails the same way, with the pane
 *  showing nothing happening at all.
 *
 *  `validateCwd` is canvas.mjs's, deliberately -- one implementation of
 *  "absolute, ~ expanded, realpath-resolved, an existing directory", not two
 *  that can drift. The empty string is VALID and means "no project": most
 *  requests have none, and it is the default `create` writes. */
export const validateProject = (raw) => {
  const v = raw == null ? '' : String(raw).trim()
  if (v === '') return { ok: true, project: '' }
  const r = validateCwd(v)
  if (!r.ok) return { ok: false, error: `project is not a directory: ${JSON.stringify(v)} (${r.error})` }
  return { ok: true, project: r.cwd }
}

/** A slug becomes a directory name, a git branch and a session name, so it is
 *  validated before it becomes any of them. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/

export const STATES = [
  'draft', 'scoped', 'queued', 'dispatched', 'planned', 'implementing', 'done',
  'failed', 'cancelled',
]

const NEXT = {
  draft:        ['scoped', 'queued', 'cancelled'],
  scoped:       ['queued', 'draft', 'failed', 'cancelled'],
  queued:       ['dispatched', 'scoped', 'failed', 'cancelled'],
  dispatched:   ['planned', 'failed', 'cancelled'],
  planned:      ['implementing', 'failed', 'cancelled'],
  implementing: ['done', 'failed', 'cancelled'],
  done:         [],
  failed:       ['queued', 'cancelled'],
  cancelled:    [],
}

export const canTransition = (from, to) => (NEXT[from] ?? []).includes(to)

/** Kebab-case a title into something safe to use as a path, a branch and a
 *  session name, then uniquify it against slugs already in use. */
export const slugify = (title, taken = []) => {
  let base = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 49)
    .replace(/-+$/, '')
  if (!base || !/^[a-z0-9]/.test(base)) base = 'request' + (base ? '-' + base.replace(/^-+/, '') : '')
  base = base.slice(0, 49).replace(/-+$/, '')
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) {
    const suffix = '-' + n
    const candidate = base.slice(0, 49 - suffix.length).replace(/-+$/, '') + suffix
    if (!taken.includes(candidate)) return candidate
  }
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

const isPlainPatch = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

// __proto__, constructor and prototype are never merged from a caller's
// patch. JSON.parse gives a plain own property named "__proto__" (it does
// not itself touch the object's prototype), but Object.assign or `x.__proto__
// = ...` on the *target* invokes the real accessor -- so an unvalidated
// `{"__proto__":{...}}` patch from the network can repoint a stored record's
// prototype. Copying key-by-key with this blocklist, rather than
// Object.assign or `{ ...patch }`, keeps the merge to plain data properties.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** A patch arrives over HTTP with no shape guarantee. Anything that is not a
 *  plain object collapses to {} -- callers merge, they do not validate -- and
 *  the three keys above are stripped even from a plain object. */
const sanitizePatch = (patch) => {
  const clean = {}
  if (!isPlainPatch(patch)) return clean
  for (const k of Object.keys(patch)) {
    if (DANGEROUS_KEYS.has(k)) continue
    clean[k] = patch[k]
  }
  return clean
}

/** A model reaches the argv as `--model <value>`. The store does NOT enumerate
 *  models: `--model` accepts a full name as well as an alias, and a hardcoded
 *  enumeration here would reject a model newer than this file. Shape is what
 *  is checkable -- one bare token, no whitespace, no leading dash (which would
 *  arrive at the CLI as a FLAG, not a value). The picker's list is advice,
 *  published separately as `dispatchOptions`; this is the gate. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Effort IS a closed set at the CLI, so an unknown value is a typo, not a
 *  new level, and is refused. Shape-checked for the same reason as the model:
 *  this value becomes an argv token. */
export const EFFORT_RE = /^[a-z][a-z0-9]{0,15}$/

/** `branch` and `sessionName` are written by the dispatcher when it actually
 *  creates them, and are never writable from a patch: they name a real git
 *  branch and a real session, and a forged value would point the UI at
 *  something that does not exist.
 *
 *  `templateId` joins `model` and `effort` as patch-settable: it names a
 *  session preset, and a preset's id is a slug. A slug sets it, `null` clears
 *  it, and anything else is ignored -- it is read back into a store lookup
 *  whose answer reaches the spawn argv. */
export const mergeDispatch = (current, patch) => {
  const out = { ...(current ?? {}) }
  if (!isPlainPatch(patch)) return out
  if (typeof patch.model === 'string' && MODEL_RE.test(patch.model.trim())) out.model = patch.model.trim()
  if (typeof patch.effort === 'string' && EFFORT_RE.test(patch.effort.trim())) out.effort = patch.effort.trim()
  if (patch.templateId === null) out.templateId = null
  else if (typeof patch.templateId === 'string' && SLUG_RE.test(patch.templateId)) out.templateId = patch.templateId
  return out
}

/** The kinds a request may point back at. Closed, the same way `STATES` is:
 *  a dispatched session reads this field, so an unrecognised kind is a typo
 *  worth refusing rather than a new kind worth inventing here. */
export const RELATES_KINDS = ['backlog', 'plan', 'spec', 'feature']
const REF_MAX = 200

/** A reference is data a dispatched session acts on, so it is shape-checked
 *  before it is stored -- the same gate model/effort go through. `null` clears
 *  it; anything malformed leaves the previous value alone. */
export const mergeRelatesTo = (current, patch) => {
  if (patch === null) return null
  if (!isPlainPatch(patch)) return current ?? null
  const kind = typeof patch.kind === 'string' ? patch.kind.trim() : ''
  const ref = typeof patch.ref === 'string' ? patch.ref.trim() : ''
  if (!RELATES_KINDS.includes(kind) || !ref || ref.length > REF_MAX) return current ?? null
  return { kind, ref }
}

/** A fan-out group is minted by the relay from one run, never typed by a
 *  person, so `create` is its only entry point and this stays private -- a
 *  patch can never forge one onto a request that was not created with it.
 *  `n` and `of` are the request's position and the group's size, shape-checked
 *  because both ride into a title suffix and a branch name downstream. */
const sanitizeFanout = (v) => {
  if (!isPlainPatch(v)) return null
  const id = typeof v.id === 'string' ? v.id.trim() : ''
  if (!id || id.length > 64) return null
  const { n, of } = v
  if (!Number.isInteger(n) || !Number.isInteger(of) || n < 1 || n > of) return null
  return { id, n, of }
}

const emptyBrief = () => ({
  goal: '', nonGoals: [], constraints: [],
  research: { context7: [], urls: [], files: [] },
  successCriteria: [], openQuestions: [],
})

export const createStore = ({ file, now = Date.now }) => {
  /** @type {any[]} */ let items = []
  let dirty = false

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(raw?.items)) items = raw.items
    else throw new Error('dispatch.json has no items array')
  } catch (err) {
    items = []
    // a missing file (first run, or a fresh worktree) is not corruption
    // -- there is nothing to rescue and nothing worth a warning. A file that
    // EXISTS but failed to parse or has the wrong shape is different: this
    // store is authoritative (see the file header) and the 4 s flush would
    // otherwise silently overwrite the only copy with an empty queue. Move
    // it aside instead of destroying it, and say so on stderr.
    if (err.code !== 'ENOENT') {
      const aside = `${file}.corrupt-${now()}`
      try {
        renameSync(file, aside)
        process.stderr.write(`dispatch store: ${file} failed to load (${err.message}); moved aside to ${aside} and starting empty\n`)
      } catch (renameErr) {
        process.stderr.write(`dispatch store: ${file} failed to load (${err.message}); could not move it aside (${renameErr.message}) -- starting empty, original left in place\n`)
      }
    }
  }

  const get = (id) => items.find((r) => r.id === id) ?? null

  const flush = () => {
    if (!dirty) return
    // Serialize FIRST. If this throws, nothing has been written and the
    // previous file is still the previous file.
    const text = JSON.stringify({ version: 1, items })
    const tmp = file + '.tmp'
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, text)
      renameSync(tmp, file)
      dirty = false
    } catch (err) {
      try { unlinkSync(tmp) } catch {}
      throw err
    }
  }

  const touch = (r) => { r.updatedAt = now(); dirty = true; return r }

  return {
    get dirty() { return dirty },
    all: () => items,
    get,

    create(fields = {}) {
      const project = fields.project ?? ''
      const taken = items.filter((r) => r.project === project).map((r) => r.slug)
      const r = {
        id: uid(),
        createdAt: now(), updatedAt: now(),
        state: 'draft',
        project,
        title: fields.title ?? 'untitled',
        titleSource: fields.titleSource === 'auto' ? 'auto' : 'manual',
        slug: slugify(fields.title, taken),
        ask: fields.ask ?? '',
        brief: fields.brief ?? null,
        relatesTo: mergeRelatesTo(null, fields.relatesTo ?? null),
        scoping: null,
        dispatch: mergeDispatch({ model: 'opus', effort: 'high', branch: null, sessionName: null, templateId: null },
          { model: fields.model, effort: fields.effort, templateId: fields.templateId }),
        fanout: sanitizeFanout(fields.fanout),
        session: null,
        artifacts: null,
        error: null,
      }
      // Which peer's ask this request serves, when the relay resolved one at
      // apply. Added, never defaulted: an ordinary request's shape is unchanged.
      const forPeer = sanitizeForPeer(fields.forPeer)
      if (forPeer) r.forPeer = forPeer
      items.push(r)
      dirty = true
      return r
    },

    /** Merge a patch into a request. Never changes `state`, `id`, `slug` or
     *  `createdAt` — state moves only through transition(). `titleSource`,
     *  `fanout` and `forPeer` are dropped from every patch too: provenance is
     *  set once at create, and a fan-out group is minted by the dispatcher, never
     *  supplied by a browser. Typing a new `title` always flips
     *  `titleSource` to 'manual' afterwards -- a human overriding an auto
     *  title cannot be pushed back by a later patch. A patch that is not a
     *  plain object (null, an array, a string, ...) is ignored entirely: no
     *  throw, no mutation. */
    update(id, patch = {}) {
      const r = get(id)
      if (!r) return null
      if (!isPlainPatch(patch)) return r
      const { id: _i, state: _s, slug: _g, createdAt: _c, titleSource: _ts, fanout: _fo, forPeer: _fp, ...rest } =
        sanitizePatch(patch)
      if (rest.brief && r.brief) rest.brief = { ...r.brief, ...rest.brief }
      if ('dispatch' in rest) rest.dispatch = mergeDispatch(r.dispatch, rest.dispatch)
      if ('relatesTo' in rest) rest.relatesTo = mergeRelatesTo(r.relatesTo, rest.relatesTo)
      Object.assign(r, rest)
      if (typeof rest.title === 'string' && rest.title.trim()) r.titleSource = 'manual'
      return touch(r)
    },

    /** The refine's only write path. Re-slugs, because in `draft` nothing has
     *  used the slug yet; from `scoped` on it is about to become a directory,
     *  a branch and a session name, so it is frozen. */
    retitle(id, title) {
      const r = get(id)
      if (!r || r.state !== 'draft') return null
      const clean = String(title ?? '').trim()
      if (!clean) return null
      const taken = items.filter((x) => x.project === r.project && x.id !== id).map((x) => x.slug)
      r.title = clean
      r.slug = slugify(clean, taken)
      return touch(r)
    },

    transition(id, to, patch = {}) {
      const r = get(id)
      if (!r) throw new Error(`no such request: ${id}`)
      if (!canTransition(r.state, to)) throw new Error(`illegal transition: ${r.state} -> ${to}`)
      // A patch that is not a plain object collapses to {} rather than
      // reaching Object.assign -- the transition still runs, it just carries
      // no extra fields.
      const clean = sanitizePatch(patch)
      // The peer tag is set once, at create, and never by a state change.
      delete clean.forPeer
      // `planned` means a plan file exists. It is never entered on a
      // status field alone, so the store refuses it without a path.
      if (to === 'planned' && !clean?.artifacts?.planPath) {
        throw new Error('transition to planned requires artifacts.planPath')
      }
      Object.assign(r, clean, { state: to })
      return touch(r)
    },

    remove(id) {
      const i = items.findIndex((r) => r.id === id)
      if (i < 0) return false
      items.splice(i, 1)
      dirty = true
      return true
    },

    /** Move the listed ids to the front, in the order given. Ids not listed
     *  keep their relative order behind them. */
    reorder(ids) {
      const rank = new Map(ids.map((id, i) => [id, i]))
      const listed = items.filter((r) => rank.has(r.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id))
      items = [...listed, ...items.filter((r) => !rank.has(r.id))]
      dirty = true
    },

    emptyBrief,
    flush,
  }
}
