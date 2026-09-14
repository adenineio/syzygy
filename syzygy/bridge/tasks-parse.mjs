// Markdown -> task items. Pure: no I/O, no git, no clock.
//
// Two shapes, because a project usually has both. Plans under docs/plans/ use `- [ ]`
// checkbox steps; docs/TASKS.md is prose under ## headings with no checkboxes
// at all. Both become Items so the rest of the scanner has one type to hold.

import { createHash } from 'node:crypto'

const STEP = /^(\s*)[-*]\s+\[([ xX~])\]\s+(.*)$/
const HEAD = /^(#{2,3})\s+(.*)$/
const FENCE = /^\s*(```|~~~)/

/** GitHub-style heading slug: lowercase, keep word chars, spaces and hyphens,
 *  then spaces to hyphens. An em dash is dropped but its surrounding spaces
 *  are not, which is why `A — B` slugs to `a--b`. */
export const slugOf = (heading) =>
  String(heading).toLowerCase().replace(/[^\w \-]/g, '').trim().replace(/ /g, '-')

/** The text an id is computed from. Bold, code ticks and runs of whitespace
 *  must not change identity, or the same task in two worktrees would not
 *  match itself. */
export const normalizeTitle = (text) =>
  String(text).toLowerCase().replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim()

export const stripBold = (s) => String(s).replace(/\*\*(.+?)\*\*/g, '$1').replace(/\s+$/, '').trim()

/** Stable across worktrees, distinct within a file.
 *
 *  Scoped by the nearest preceding heading, because a plan template repeats
 *  step titles structurally -- "Step 1: Write the failing test" appears once
 *  per task. Two items sharing one id share one register key, which makes
 *  observe() fire check and uncheck against the same entry every pass: the
 *  payload can then never serialize identically twice, so the relay broadcasts
 *  to every pane every 4s forever, and creditFor() invents attribution.
 *
 *  The ordinal is the tiebreak for a title repeated under the SAME heading.
 *  Both inputs come from file content alone, never position, so the same item
 *  in two worktrees still hashes identically. Line numbers must never enter
 *  here: they drift between checkouts and would break every diff label. */
export const itemId = (relPath, scope, text) =>
  createHash('sha1')
    .update(relPath + '\0' + normalizeTitle(scope) + '\0' + normalizeTitle(text))
    .digest('hex').slice(0, 12)

/** Every item in one file, in file order.
 *
 *  Fenced blocks are skipped. This is load-bearing rather than tidy: plan
 *  documents demonstrate `- [ ]` steps and `## headings` inside their own code
 *  fences, so a fence-blind parser invents phantom items from the examples. */
export const parseItems = (relPath, source) => {
  const items = []
  const lines = String(source).split('\n')
  let fence = false
  let scope = ''                 // nearest preceding heading
  const seen = new Map()         // normalized "scope\0text" -> count already emitted

  // Append `#<n>` to the hashed text once a (scope, text) pair repeats, so the
  // residual case -- the same title twice under ONE heading -- still separates.
  //
  // The map key MUST normalize its scope exactly as itemId() does. Keying on
  // the raw heading instead lets two headings that differ only in what
  // normalizeTitle erases -- case, whitespace runs, *_`~ -- take two different
  // map keys but one hashed scope: both occurrences then read n = 0 and
  // collide, which is the original duplicate-id defect through a narrower
  // door. `## `just check`` beside `## just check` is enough to trigger it.
  const idFor = (s, text) => {
    const k = normalizeTitle(s) + '\0' + normalizeTitle(text)
    const n = seen.get(k) ?? 0
    seen.set(k, n + 1)
    return itemId(relPath, s, n === 0 ? text : text + ' #' + n)
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE.test(line)) { fence = !fence; continue }
    if (fence) continue

    const step = STEP.exec(line)
    if (step) {
      const text = stripBold(step[3])
      if (!text) continue
      items.push({
        id: idFor(scope, text), kind: 'step', text,
        // THREE STATES. `[~]` is *reported* -- the executor believes it is done
        // -- and only `[x]` is *verified*. `checked` stays a strict boolean with
        // reported counting as FALSE, so any consumer that has not learned about
        // `reported` under-counts progress instead of over-counting it. Same
        // fail-safe direction as a ghost rolling up to done: 0, total: 0: a
        // stale reader lands short of the truth rather than past it.
        checked: step[2] === 'x' || step[2] === 'X',
        reported: step[2] === '~',
        depth: Math.floor(step[1].length / 2), line: i + 1,
      })
      continue
    }

    const head = HEAD.exec(line)
    if (head) {
      const text = stripBold(head[2])
      if (!text) continue
      // A heading is scoped by its PARENT context -- the heading in scope
      // before itself -- and only then becomes the scope for what follows.
      items.push({
        id: idFor(scope, text), kind: 'section', text,
        // `reported` is carried on headings too, so every item has one shape.
        checked: null, reported: false,
        depth: head[1].length - 2, line: i + 1, slug: slugOf(head[2]),
      })
      scope = text
    }
  }
  return items
}

/** A plan's declarative header block. Scanned only in the region before the
 *  first fence, so a document quoting `**Spec:**` in an example cannot
 *  overwrite the real one. */
export const parseHeader = (source) => {
  const text = String(source)
  const lines = text.split('\n')
  const end = lines.findIndex((l) => FENCE.test(l))
  const head = (end === -1 ? lines : lines.slice(0, end)).join('\n')

  // `[^:]*` before the colon admits a qualified label. A plan may write
  // `**Spec (the binding authority):**`, and an exact-match regex silently
  // returns null for it.
  //
  // The value continues onto a following line only while the line before it
  // ends in a comma -- a wrapped `**Tasks:**` list, one reference per line
  // with a trailing comma, is still one value. A value with no trailing comma
  // ends at its own line, so a `Spec:` line's wrapped commentary (kept only as
  // its first token anyway) or ordinary prose below the field is never pulled
  // in.
  const field = (name) => {
    // Each unit is a line ending in a comma, then the newline and any leading
    // indentation of the next line -- `[^\n]*` alone would greedily swallow
    // that trailing comma before the literal `,` beside it ever got to match,
    // which is why a comma is required IN the same token as the line content
    // rather than tacked on after a separate `.*`. The final `[^\n]*` is the
    // line that ends the value, with no comma required of it.
    const m = new RegExp('^\\*\\*' + name + '[^:]*:\\*\\*\\s*((?:[^\\n]*,[ \\t]*\\n[ \\t]*)*[^\\n]*)', 'm').exec(head)
    return m ? m[1].replace(/`/g, '').trim() : ''
  }
  // Real plans write ``**Spec:** `path` -- commentary``, so the value is the
  // first whitespace-delimited token, not the rest of the line. Keeping the
  // prose yields a pointer that resolves nowhere.
  const pathOnly = (s) => s.split(/\s+/)[0].replace(/[.,;]+$/, '')

  const title = /^#\s+(.*)$/m.exec(head)?.[1]?.trim() ?? null
  const spec = pathOnly(field('Spec')) || null
  // A backlog reference is `<file>#<slug>`, so an entry with no `#` is not a
  // reference and is dropped as prose.
  //
  // Found by a live scan rather than by reading. A plan may write
  // `**Tasks:** none — this is new work, not a `docs/TASKS.md` backlog entry.`
  // The comma split yields "none" and "not", pathOnly keeps them, and the
  // resolver then faithfully reports both as broken links: a page of broken
  // references that are words from a sentence.
  //
  // The cost of the rule is that a reference typo'd WITHOUT its `#` is
  // dropped silently rather than reported broken. That is the right trade:
  // a report is only worth having if it is worth reading, and prose in this
  // field is far commoner than that particular typo.
  const raw = field('Tasks')
  const tasks = raw
    ? raw.split(',').map((s) => pathOnly(s.trim())).filter((t) => t.includes('#'))
    : []

  // `**Shipped:** <date> - <commit>`. A weaker claim than `[x]` on purpose: it
  // says the milestone landed, NOT that each step was reviewed. It exists for
  // plans executed before the tick-as-you-go convention, whose steps cannot be
  // backfilled -- `just plan-done` requires a commit range, a verification
  // command with its exit status and a review verdict per task, and the ledger
  // those need was git-ignored scratch that is gone. Declaring the milestone is
  // the strongest TRUE statement still available.
  //
  // The commit is optional. A run of 7+ hex characters cannot be found inside a
  // YYYY-MM-DD date, so the two patterns do not compete for the same token.
  //
  // A DATE IS REQUIRED. Gating on the field being a non-empty string would
  // let `**Shipped:** no` produce {date:null, commit:null} -- truthy -- and
  // silently retire a live plan from every in-flight count. A gate that
  // ignores an EMPTY value while honouring the word "no" is accidental rather
  // than designed. A declaration this weak has
  // to be legible or it is worse than nothing: an undo button nobody can see.
  //
  // A present-but-undateable value is REPORTED rather than dropped, the same
  // rule planCollisions and unresolvedClaims already follow -- a typo in a hand
  // edit should be findable, not silent.
  const shippedRaw = field('Shipped')
  const shippedDate = /\d{4}-\d{2}-\d{2}/.exec(shippedRaw)?.[0] ?? null
  const shipped = shippedDate
    ? { date: shippedDate, commit: /\b[0-9a-f]{7,40}\b/.exec(shippedRaw)?.[0] ?? null }
    : null
  const shippedMalformed = !shipped && shippedRaw ? shippedRaw : null

  return { title, spec, tasks, shipped, shippedMalformed }
}

/** docs/FEATURES.md -> implemented features.
 *
 *  The repo's 26 entries are uniformly `## <Name> — <YYYY-MM-DD>`. Identity is
 *  the slug of the NAME alone: the date is part of the heading, so slugging the
 *  raw heading would embed it in the key and break every reference to that
 *  feature the moment someone corrected a date. */
const FEATURE_HEAD = /^##\s+(.+?)\s+\u2014\s+(\d{4}-\d{2}-\d{2})\s*$/
// The fallback. Deliberately `^##\s` and NOT `^#{2,}\s`: a `### ` subheading
// inside an entry is that entry's body, and matching it would split one
// feature into two.
const FEATURE_ANY = /^##\s+(.+?)\s*$/

/** Returns `{ features, collisions }` rather than a bare array. An array with
 *  a `collisions` property would be lost the moment the features reach the
 *  payload, because JSON.stringify drops properties hung off an array -- and
 *  `foldEfforts` already returns its own collisions this way. */
export const parseFeatures = (relPath, source) => {
  const features = []
  const bySlug = new Map()
  const collisions = []
  let fence = false

  const push = (name, date) => {
    const trimmed = String(name).trim()
    // A nameless `##` is not a feature. parseItems guards exactly this in two
    // places; without it a bare `##` yields an empty slug, which is an index
    // key every other malformed heading collides with.
    if (!trimmed) return
    const slug = slugOf(trimmed)
    if (!slug) return
    features.push({ rel: relPath, name: trimmed, date, slug })
    // Two names that slug identically are REPORTED, never silently deduped.
    // The slug is the feature index key and matching is exact, so a Map would
    // keep one row and a mapping made against the other would resolve to it.
    // The house rule is to report or refuse ambiguity, not to pick: see
    // foldEfforts' basename collisions and claims-inherit's outright refusal.
    const seen = bySlug.get(slug)
    if (seen) {
      const hit = collisions.find((c) => c.slug === slug)
      if (hit) hit.names.push(trimmed)
      else collisions.push({ slug, names: [seen, trimmed] })
    } else {
      bySlug.set(slug, trimmed)
    }
  }

  for (const line of String(source).split('\n')) {
    if (FENCE.test(line)) { fence = !fence; continue }
    if (fence) continue
    const dated = FEATURE_HEAD.exec(line)
    if (dated) { push(dated[1], dated[2]); continue }
    const any = FEATURE_ANY.exec(line)
    if (any) push(any[1], null)
  }
  return { features, collisions }
}
