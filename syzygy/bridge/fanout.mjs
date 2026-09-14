// The Dispatch tab's fan-out: splitting one ask into several drafts, each
// aimed at a project, plus the argv builders, schemas and transcript reader
// that turn a scoping conversation into a bounded, replayable thread.
//
// Every export here is pure. Nothing spawns a process, opens a file or calls
// a model; the impure half lives beside the relay's routes and injects this
// module's argv builders into a real `spawn`.

import { HEADLESS_SETTINGS } from './canvas.mjs'

export const FANOUT_MAX_DRAFTS = 8
export const FANOUT_ASK_MAX = 20_000
export const TITLE_MAX = 60

/** Blank-line separated, indices stable for the life of a run: every draft
 *  addresses paragraphs by index, so a re-split would silently repoint them. */
export const splitParagraphs = (ask) =>
  String(ask ?? '').split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean)

/** A draft's ask is derived, never authored: the words stay the user's, and a
 *  wrong boundary is fixed by moving an index rather than by retyping. */
export const draftAsk = (paragraphs, indices) => {
  const ps = Array.isArray(paragraphs) ? paragraphs : []
  const idx = [...new Set((Array.isArray(indices) ? indices : []).map(Number))]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < ps.length)
    .sort((a, b) => a - b)
  return idx.map((i) => ps[i]).join('\n\n')
}

const withParagraphs = (d, next) => ({ ...d, paragraphs: [...new Set(next)].sort((a, b) => a - b) })

export const assign = (drafts, draftId, index, mode) => {
  const list = Array.isArray(drafts) ? drafts : []
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0) return list
  if (mode === 'unassign') {
    return list.map((d) => (d.id === draftId ? withParagraphs(d, d.paragraphs.filter((p) => p !== i)) : d))
  }
  if (!list.some((d) => d.id === draftId)) return list
  return list.map((d) => {
    if (d.id === draftId) return withParagraphs(d, [...d.paragraphs, i])
    if (mode === 'move') return withParagraphs(d, d.paragraphs.filter((p) => p !== i))
    return d
  })
}

export const unassignedIndices = (drafts, count) => {
  const taken = new Set()
  for (const d of Array.isArray(drafts) ? drafts : []) for (const p of d.paragraphs ?? []) taken.add(p)
  const out = []
  for (let i = 0; i < Number(count ?? 0); i++) if (!taken.has(i)) out.push(i)
  return out
}

export const mergeDrafts = (drafts, aId, bId) => {
  const list = Array.isArray(drafts) ? drafts : []
  const a = list.find((d) => d.id === aId), b = list.find((d) => d.id === bId)
  if (!a || !b || aId === bId) return list
  const merged = withParagraphs(a, [...a.paragraphs, ...b.paragraphs])
  merged.openQuestions = [...new Set([...(a.openQuestions ?? []), ...(b.openQuestions ?? [])])]
  return list.filter((d) => d.id !== bId).map((d) => (d.id === aId ? merged : d))
}

/** Every project the scanner knows, collapsed onto its main root. `check` is
 *  injected so this stays pure; production passes the store's own validator. */
export const fanoutProjects = (projects, { check } = {}) => {
  const out = []
  for (const p of Array.isArray(projects) ? projects : []) {
    if (!p || typeof p !== 'object') continue
    const root = typeof p.mainRoot === 'string' && p.mainRoot ? p.mainRoot : null
    if (!root) continue
    const r = check ? check(root) : { ok: true, project: root }
    if (!r?.ok) continue
    out.push({
      key: typeof p.key === 'string' && p.key ? p.key : root,
      name: typeof p.name === 'string' && p.name ? p.name : root.split('/').filter(Boolean).pop() || root,
      root: r.project ?? root,
    })
  }
  return out
}

const FILLER = /^(?:ok(?:ay)?[,\s]+)?(?:so[,\s]+)?(?:i(?:'d| would)? (?:want|like) (?:to|you to)|i need (?:to|you to)|can you(?: please)?|could you(?: please)?|please|lets|let's|we should|it should)\s+/i

/** A title good enough to slug and to read on a row. Never a model call: this
 *  runs on the create path, which must not block. */
export const proposeTitle = (ask) => {
  let t = String(ask ?? '').trim()
  if (!t) return 'untitled'
  t = t.split(/(?<=[.!?])\s|\n/)[0] ?? t
  t = t.replace(FILLER, '').replace(/\s+/g, ' ').replace(/[.!?,;:\s]+$/, '').trim()
  if (!t) return 'untitled'
  if (t.length <= TITLE_MAX) return t
  const cut = t.slice(0, TITLE_MAX)
  const sp = cut.lastIndexOf(' ')
  return (sp > 20 ? cut.slice(0, sp) : cut).replace(/[\s-]+$/, '')
}

export const SCOPE_TOOLS = 'Read Glob Grep WebFetch mcp__context7__*'
export const SCOPE_DENY = 'Write Edit NotebookEdit Bash'

/** A scoping conversation is a real session on the board, not a headless child:
 *  the preamble rides on the kickoff prompt so it is the first thing anyone who
 *  joins in a terminal reads. Allowing a tool only pre-approves it, so the ones
 *  that write are denied outright. */
export const scopeSpawnArgv = ({ name, preamble, ask, model, settings = null, budgetUsd = null }) => [
  '--bg', '-n', String(name),
  ...(settings ? ['--settings', String(settings)] : []),
  '--model', String(model),
  '--allowedTools', SCOPE_TOOLS,
  '--disallowedTools', SCOPE_DENY,
  ...(Number(budgetUsd) > 0 ? ['--max-budget-usd', String(Number(budgetUsd))] : []),
  '--', `${preamble}\n\n${ask}`,
]

export const FANOUT_SCHEMA = {
  type: 'object', required: ['drafts'],
  properties: {
    drafts: {
      type: 'array',
      items: {
        type: 'object', required: ['title', 'projectKey', 'paragraphs'],
        properties: {
          title: { type: 'string' },
          projectKey: { type: 'string' },
          paragraphs: { type: 'array', items: { type: 'integer' } },
          goal: { type: 'string' },
          openQuestions: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
      },
    },
  },
}

export const TITLE_SCHEMA = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } }

/** The one-shot fan-out call's prompt: the ask as numbered, index-addressable
 *  paragraphs, beside every project the split may aim a draft at. */
export const fanoutPrompt = (ask, projects) => {
  const paragraphs = splitParagraphs(ask)
  const numbered = paragraphs.map((p, i) => `[${i}] ${p}`).join('\n\n')
  const projectLines = (Array.isArray(projects) ? projects : [])
    .map((p) => `${p.key} — ${p.name} (${p.root})`).join('\n')
  return [
    'Split the ask below into independent drafts, one per project it could be dispatched to.',
    '',
    'Paragraphs:',
    numbered,
    '',
    'Projects:',
    projectLines || '(none known)',
    '',
    'Each draft claims a set of PARAGRAPH INDICES from the ask above and must never rewrite their text.',
    'projectKey must be one of the keys listed above, or the literal "unknown" when none fits.',
    'A paragraph may belong to more than one draft, or to none.',
    `Propose at most ${FANOUT_MAX_DRAFTS} drafts.`,
    'goal is one sentence. openQuestions names what the ask leaves unsettled.',
  ].join('\n')
}

/** The one-shot title call's prompt: one short, plain-word title and nothing
 *  wrapped around it. */
export const titlePrompt = (ask) =>
  [`Propose one title of at most ${TITLE_MAX} characters for the ask below.`,
    'Plain words, no quotes, and nothing else.', '', String(ask ?? '')].join('\n')

const schemaArgv = ({ schema, model, budgetUsd, safeMode, prompt }) => {
  const argv = ['-p', '--output-format', 'json']
  if (safeMode) argv.push('--safe-mode')
  argv.push('--settings', HEADLESS_SETTINGS)
  argv.push('--model', String(model))
  if (Number(budgetUsd) > 0) argv.push('--max-budget-usd', String(Number(budgetUsd)))
  argv.push('--json-schema', JSON.stringify(schema))
  argv.push(String(prompt))
  return argv
}

export const fanoutArgv = ({ ask, projects, model = 'opus', budgetUsd = 2, safeMode = false }) =>
  schemaArgv({ schema: FANOUT_SCHEMA, model, budgetUsd, safeMode, prompt: fanoutPrompt(ask, projects) })

export const titleArgv = ({ ask, model = 'sonnet', budgetUsd = 0.5, safeMode = false }) =>
  schemaArgv({ schema: TITLE_SCHEMA, model, budgetUsd, safeMode, prompt: titlePrompt(ask) })

/** The thread as one bounded document, trimmed from the FRONT: a bank call is
 *  built from what was settled last. Marker rows carry no content of their own. */
export const renderThread = (turns, maxBytes = 60_000) => {
  const lines = (Array.isArray(turns) ? turns : [])
    .filter((t) => t?.role !== 'marker')
    .map((t) => `${t.role === 'user' ? 'HUMAN' : 'CLAUDE'}: ${t.text}`)
  const out = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const n = Buffer.byteLength(lines[i], 'utf8') + 2
    if (used + n > maxBytes) break
    used += n
    out.unshift(lines[i])
  }
  return out.join('\n\n')
}

const PLUGIN_WRAP = /^The .+? plugin sent a message:\n([\s\S]*?)\n\nThis is how Claude Code surfaces/

/** Reads one transcript tail: `text` is already sliced from `offset` by the
 *  caller, so this never re-reads earlier bytes. Only complete lines are
 *  consumed; a trailing partial line (the file is still being written) is
 *  held for the next read. A row's key is its `uuid`; a keyed row already in
 *  `seen` is skipped, and a row with no key is never de-duped. */
export const readTranscriptTail = (text, offset, seen) => {
  const lines = String(text ?? '').split('\n')
  const complete = lines.slice(0, -1)
  const seenSet = new Set(seen ?? [])
  const turns = []
  let consumed = 0
  for (const line of complete) {
    consumed += Buffer.byteLength(line, 'utf8') + 1
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!row || typeof row !== 'object') continue
    const key = typeof row.uuid === 'string' && row.uuid ? row.uuid : null
    if (key && seenSet.has(key)) continue

    if (row.type === 'assistant') {
      if (key) seenSet.add(key)
      const t = (row.message?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('')
      if (t.trim()) turns.push({ role: 'assistant', text: t, messageId: row.message?.id ?? null })
      continue
    }

    if (row.type === 'user') {
      if (key) seenSet.add(key)
      if (row.isMeta) continue
      const content = row.message?.content
      let t
      if (typeof content === 'string') {
        t = content
      } else if (Array.isArray(content)) {
        if (content.some((c) => c?.type === 'tool_result')) continue
        t = content.filter((c) => c?.type === 'text').map((c) => c.text).join('')
      } else {
        continue
      }
      t = t.trim()
      if (!t || t.startsWith('<command-') || t.startsWith('<local-command-')) continue
      const origin = row.origin?.kind === 'plugin' ? 'plugin' : 'human'
      if (origin === 'plugin') {
        const m = t.match(PLUGIN_WRAP)
        if (m) t = m[1].trim()
      }
      turns.push({ role: 'user', text: t, origin })
      continue
    }
  }
  return { turns, offset: Number(offset ?? 0) + consumed, seen: [...seenSet].slice(-500) }
}

export const TURN_TEXT_MAX = 16_000
export const SCOPE_TURNS_MAX = 200

const boundTurnText = (t) =>
  typeof t.text === 'string' && t.text.length > TURN_TEXT_MAX
    ? { ...t, text: t.text.slice(0, TURN_TEXT_MAX) + '\n…[truncated]' }
    : t

const MARKER_RE = /^(\d+) earlier turns dropped$/

/** Folds freshly read transcript turns into the stored thread: an assistant
 *  message written as several rows joins its own last turn by `messageId`
 *  rather than duplicating, and a turn the pane or the kickoff already holds
 *  (unconfirmed) is confirmed in place rather than appended a second time.
 *  Pure — `stored` and its turns are never mutated. */
export const foldTurns = (stored, incoming, now = Date.now) => {
  let out = (Array.isArray(stored) ? stored : []).map((t) => ({ ...t }))

  for (const inc of Array.isArray(incoming) ? incoming : []) {
    if (inc?.role === 'assistant') {
      const last = out[out.length - 1]
      if (last && last.role === 'assistant' && last.messageId != null && last.messageId === inc.messageId) {
        out[out.length - 1] = { ...last, text: `${last.text}\n\n${inc.text}` }
      } else {
        out.push({ role: 'assistant', text: inc.text, messageId: inc.messageId ?? null, t: now() })
      }
      continue
    }

    if (inc?.role === 'user' && inc.origin === 'plugin') {
      const incText = String(inc.text ?? '').trim()
      const idx = out.findIndex((t) => {
        if (t.role !== 'user' || t.via !== 'pane' || t.confirmed !== false) return false
        const tt = String(t.text ?? '').trim()
        return tt === incText || incText.includes(tt)
      })
      if (idx >= 0) out[idx] = { ...out[idx], confirmed: true }
      else out.push({ role: 'user', text: inc.text, via: 'pane', confirmed: true, t: now() })
      continue
    }

    if (inc?.role === 'user' && inc.origin === 'human') {
      const incText = String(inc.text ?? '').trim()
      const idx = out.findIndex((t) => {
        if (t.role !== 'user' || t.kickoff !== true || t.confirmed !== false) return false
        return incText.endsWith(String(t.text ?? '').trim())
      })
      if (idx >= 0) out[idx] = { ...out[idx], confirmed: true }
      else out.push({ role: 'user', text: inc.text, via: 'terminal', t: now() })
      continue
    }
  }

  out = out.map(boundTurnText)

  const keep = SCOPE_TURNS_MAX - 1
  if (out.length > keep) {
    const overflow = out.length - keep
    const droppedSlice = out.slice(0, overflow)
    const rest = out.slice(overflow)
    let dropped = droppedSlice.length
    const maybeMarker = droppedSlice[0]
    if (maybeMarker?.role === 'marker') {
      const m = String(maybeMarker.text ?? '').match(MARKER_RE)
      if (m) dropped = dropped - 1 + Number(m[1])
    }
    out = [{ role: 'marker', text: `${dropped} earlier turns dropped`, t: now() }, ...rest]
  }

  return out
}

/** The one shape every headless schema call's finished frame is read through:
 *  a fresh structured field when the CLI reports one, else the same object
 *  parsed back out of `result`. Never throws. */
export const schemaPayload = (frame) => {
  const so = frame?.structured_output
  if (so && typeof so === 'object' && !Array.isArray(so)) return so
  const r = frame?.result
  if (typeof r === 'string') {
    try {
      const parsed = JSON.parse(r)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { /* not JSON */ }
  }
  return null
}

export const RUN_STATES = ['running', 'ready', 'failed', 'accepted', 'discarded']

const asString = (v) => (typeof v === 'string' ? v : '')

/** Sanitises a run as it is read back: an unknown key is dropped, a draft's
 *  paragraph indices are re-validated against the run's own paragraph count,
 *  and `unassigned` is recomputed rather than trusted from disk. */
export const sanitizeRun = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { id, state, ask } = raw
  if (typeof id !== 'string' || !id) return null
  if (!RUN_STATES.includes(state)) return null
  if (typeof ask !== 'string') return null

  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : 0

  const paragraphs = Array.isArray(raw.paragraphs)
    ? raw.paragraphs.filter((p) => typeof p === 'string')
    : splitParagraphs(ask)

  const projects = (Array.isArray(raw.projects) ? raw.projects : [])
    .filter((p) => p && typeof p === 'object'
      && typeof p.key === 'string' && typeof p.name === 'string' && typeof p.root === 'string')
    .map((p) => ({ key: p.key, name: p.name, root: p.root }))

  const drafts = (Array.isArray(raw.drafts) ? raw.drafts : [])
    .filter((d) => d && typeof d === 'object' && typeof d.id === 'string' && d.id)
    .map((d) => ({
      id: d.id,
      title: asString(d.title),
      projectKey: asString(d.projectKey),
      paragraphs: [...new Set((Array.isArray(d.paragraphs) ? d.paragraphs : [])
        .filter((i) => Number.isInteger(i) && i >= 0 && i < paragraphs.length))]
        .sort((a, b) => a - b),
      ask: asString(d.ask),
      goal: asString(d.goal),
      openQuestions: Array.isArray(d.openQuestions) ? d.openQuestions.filter((q) => typeof q === 'string') : [],
      reason: asString(d.reason),
    }))

  return {
    id, state, ask, createdAt, paragraphs, projects, drafts,
    unassigned: unassignedIndices(drafts, paragraphs.length),
    error: typeof raw.error === 'string' ? raw.error : null,
  }
}
