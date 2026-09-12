// Declared references, resolved. Pure: no I/O, no git, no clock.
//
// The gap this closes: `parseHeader` has produced `plan.tasks` since the
// Projects tab shipped, the payload has transported it, and `item.slug` has
// been computed for every backlog section -- and no code has ever matched one
// against the other. The same join is what lets an ask be mapped onto a
// feature or a plan, so it is built once here rather than twice badly.
//
// THE KIND IS ALWAYS DECLARED, never sniffed from the shape of the reference.
// A caller knows what it is resolving: a plan's `Tasks:` line names backlog
// entries, its `Spec:` line names a spec, a request's `relatesTo` carries its
// own kind. Guessing from a path would put this module in the business of
// inference, which is the one thing exists to forbid.

/** The identity each kind is keyed by, and why:
 *
 *  - `backlog` -- `<task file rel>#<heading slug>`, the same key a claim uses
 *    and the same string a plan's `Tasks:` line writes.
 *  - `plan` -- the BASENAME, the identity `tasks-efforts.mjs` folds on. Plans
 *    may live under either of two directory layouts, so path identity does not hold.
 *  - `spec` -- the basename, for the same reason.
 *  - `feature` -- the slug of the feature's NAME with its date excluded, so a
 *    corrected date cannot break a reference.
 */
export const REF_KINDS = ['backlog', 'plan', 'spec', 'feature']

const base = (rel) => String(rel).slice(String(rel).lastIndexOf('/') + 1)

/** A reference as written, reduced to the key its kind is indexed by. A
 *  `Spec:` line writes a path and the index holds basenames, so the two have
 *  to meet somewhere; they meet here rather than in every caller. */
export const refKey = (kind, ref) => {
  const s = String(ref ?? '').trim()
  if (!s) return ''
  // A backlog reference is already a key. Everything else is a path or a slug,
  // and a path reduces to its basename.
  return kind === 'backlog' ? s : base(s)
}

export const buildIndex = (project) => {
  const backlog = new Map()
  const plan = new Map()
  const spec = new Map()
  const feature = new Map()

  for (const w of project?.worktrees ?? []) {
    for (const t of w.tasks ?? []) {
      for (const i of t.items ?? []) {
        // Only headings carry a slug, and only headings are referenceable.
        if (i.kind === 'section' && i.slug) {
          const k = t.rel + '#' + i.slug
          if (!backlog.has(k)) backlog.set(k, i)
        }
      }
    }
    // First copy wins for plans and specs. Every worktree inherits every
    // committed one, so later copies are the same document; which checkout it
    // was read from is not part of the reference.
    for (const p of w.plans ?? []) {
      if (p.absent) continue
      const k = base(p.rel)
      if (!plan.has(k)) plan.set(k, p)
    }
    // Only when the project has no folded list; see below.
    if (!(project?.specs ?? []).length) {
      for (const s of w.specs ?? []) {
        const rel = typeof s === 'string' ? s : s?.rel
        if (!rel) continue
        const k = base(rel)
        if (!spec.has(k)) spec.set(k, typeof s === 'string' ? { rel } : s)
      }
    }
  }
  // The scanner folds specs at PROJECT level, with titles and already
  // deduped by basename. Prefer that: a `Spec:` reference resolved from a
  // worktree's bare path list has no title, and a title is the whole point --
  // it is what a planned feature is shown as. The per-worktree branch above
  // remains for a payload from a relay predating the fold, which is not
  // hypothetical: a running relay serves a pane newer than itself until it is
  // restarted: a relay's static assets reload, its route table does not.
  for (const sp of project?.specs ?? []) {
    const rel = typeof sp === 'string' ? sp : sp?.rel
    if (!rel) continue
    const k = (typeof sp === 'string' ? base(rel) : sp.name) || base(rel)
    if (!spec.has(k)) spec.set(k, typeof sp === 'string' ? { rel } : sp)
  }
  for (const f of project?.features ?? []) {
    if (f?.slug && !feature.has(f.slug)) feature.set(f.slug, f)
  }

  return { backlog, plan, spec, feature }
}

/** Exact match only. No fuzzy fallback, no similarity scoring.
 *
 * worked example is the reason: the backlog's `## Browser pane — finish
 *  the patch bay` and the plan titled `# GRID Patch Bay Implementation Plan`
 *  share almost no tokens, while `## GRID — second pass` and `## GRID —
 *  deferred from the final review` would both match that plan strongly and
 *  both be wrong -- they are its OUTPUT, not its input.
 *
 *  A miss is REPORTED, never dropped, so a renamed heading is visible rather
 *  than silent. */
export const resolveRef = (index, kind, ref) => {
  // The kind is checked against the LIST, never used to index the object
  // directly. `index['__proto__']` returns Object.prototype -- truthy, and
  // with no `.has` -- so a blind lookup turns a hand-edited `relatesTo` into a
  // TypeError thrown out of the scanner. Same hazard `requests.mjs` guards
  // with sanitizePatch, arriving through a different door.
  if (!REF_KINDS.includes(kind)) return { broken: true, kind, ref: String(ref ?? '') }
  const key = refKey(kind, ref)
  const table = index?.[kind]
  if (!table || !key || !table.has(key)) return { broken: true, kind, ref: String(ref ?? '') }
  return { kind, key, target: table.get(key) }
}
