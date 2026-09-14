// One chain per session: the ordered blocks a conversation's turns have been
// sorted into. AUTHORITATIVE, not derived -- a chain is the only record of
// how a session's conversation was shaped, so every write serializes FIRST,
// goes to a temp file in the same directory, and is renamed over the target.
// A failed serialize leaves the previous file exactly as it was. Same
// contract as findings.mjs, claims.mjs and pasteboard.mjs, for the same
// reason.
//
/** A file that will not parse is moved aside, not left alone.
 *
 *  Everywhere else here a corrupt authoritative file is reported and never
 *  touched, because it is the only copy. A chain is the exception: it can be
 *  rebuilt from the session's own transcript, while a session with no chain for
 *  the rest of its life cannot be recovered at all. So the bad file is kept
 *  under a numbered name, one line says where it went, and a fresh chain
 *  starts. */
//
// Every mutator builds the NEXT chain object, calls `save`, and only then
// replaces the cache entry -- so a throw during serialize (a cyclic value
// reaching the store through a field `sanitizeChain` carried through
// unchanged) leaves the cache, like the file, exactly as it was.

import {
  readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, readdirSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  MAX_TURNS, MAX_BLOCKS, MAX_TERMS, TITLE_MAX, RECENT_MS,
  termsOf, blankChain, sanitizeChain, assignTurn, compactChain, inheritableChainOf,
  refinerInput, applyRefinement, CHAIN_SCHEMA, CHAIN_PREAMBLE,
  turnsFromTranscript, exportChains,
} from './chain-model.mjs'
import { childEnv, HEADLESS_SETTINGS } from './canvas.mjs'
import { parseNdjson } from './scoping.mjs'
import { resultRecord } from './spend.mjs'

export const CHAINS_DIR = 'chains'

export const chainPath = (dir, sessionId) => join(dir, CHAINS_DIR, `${sessionId}.json`)

/** The refiner's `run`: spawn-shaped, because the store reads the child's
 *  streams as they arrive and kills it on a timeout -- a runner that only
 *  resolves a finished result would give it no child to read or kill. */
export const realSpawn = (bin, args, opts) => spawn(bin, args, opts)

/** Reads and sanitises one chain file. A missing file is the ordinary
 *  first-run case and answers `null` quietly. A file that exists but will
 *  not parse calls `moveAside(file, err)` -- the caller does the actual
 *  rename and the stderr line, since only it knows what "moved aside" should
 *  mean for its own store -- and then also answers `null`, so a corrupt file
 *  and no file look the same to everything downstream. */
export const readChainFile = (file, { moveAside } = {}) => {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    if (moveAside) moveAside(file, err)
    return null
  }
  return sanitizeChain(raw)
}

// ---- the refiner's command line and its answer -----------------------------

/** The first line of every input. A fixed sentence, so the input -- the last
 *  argv element, with no end-of-options marker before it -- can never parse
 *  as a flag. */
const INPUT_LEAD = "Here is the window of one session's topic chain to refine, as JSON."

/** Exactly the text a refinement sends the child for this chain. */
export const chainInputText = (chain) => `${INPUT_LEAD}\n${JSON.stringify(refinerInput(chain))}`

/** The argv for one refinement. The input is always the final single element,
 *  so no quoting, escaping or shell is involved anywhere. */
export const chainArgv = ({ text, model = 'sonnet', budgetUsd = 0.15, safeMode = false }) => {
  const argv = ['-p', '--output-format', 'json']
  // No tools at all: an empty argv element, which the CLI reads as "disable
  // every tool". A schema'd summary needs none, and the input is prompt and
  // answer heads -- a tool is the only way text inside one could make the
  // child act. `--tools` is variadic, so it sits early with a flag after its
  // value: placed last, it would read the input text as a tool name.
  argv.push('--tools', '')
  // This child is the relay's, not a session anyone is watching: --safe-mode
  // where the binary has it, and SZG_HEADLESS on every binary.
  if (safeMode) argv.push('--safe-mode')
  argv.push('--settings', HEADLESS_SETTINGS)
  argv.push('--model', String(model))
  argv.push('--max-budget-usd', String(budgetUsd))
  argv.push('--effort', 'low')
  // The tick can spawn a child per idle session; none of them should leave a
  // session file behind.
  argv.push('--no-session-persistence')
  // The preamble is the child's whole system prompt and tells it the window
  // rule; the schema is what holds its answer to a shape. Both, because either
  // alone lets a confident answer through that the other would have stopped.
  argv.push('--json-schema', JSON.stringify(CHAIN_SCHEMA))
  argv.push('--system-prompt', CHAIN_PREAMBLE)
  argv.push(String(text))
  return argv
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isResultFrame = (v) => isObj(v) && v.type === 'result'

/** The child's answer out of everything it printed. A `result` frame first,
 *  found line by line; failing that, the whole of stdout as one JSON document,
 *  since a pretty-printed object has no line that parses on its own and would
 *  otherwise read as silence. The cost comes from the frame whether the answer
 *  is usable or not -- a refused or over-budget pass still spent it. */
const readAnswer = (stdout) => {
  const text = String(stdout ?? '')
  let frame = null
  try {
    parseNdjson(text.endsWith('\n') ? text : text + '\n', (obj) => { if (isResultFrame(obj)) frame = obj })
  } catch {}
  if (!frame) {
    let doc = null
    try { doc = JSON.parse(text) } catch {}
    if (isResultFrame(doc)) frame = doc
    else if (isObj(doc) && Array.isArray(doc.blocks)) return { answer: doc, usd: 0, error: null, frame: null }
  }
  if (!frame) return { answer: null, usd: 0, error: text.trim() ? 'unparseable output' : 'no output', frame: null }
  const usd = Number.isFinite(frame.total_cost_usd) && frame.total_cost_usd > 0 ? frame.total_cost_usd : 0
  if (frame.is_error === true || (typeof frame.subtype === 'string' && frame.subtype !== 'success')) {
    return { answer: null, usd, error: `the child reported ${frame.subtype || 'an error'}`, frame }
  }
  for (const candidate of [frame.structured_output, frame.structured, frame.result]) {
    let v = candidate
    if (typeof v === 'string') {
      try { v = JSON.parse(v) } catch { continue }
    }
    if (isObj(v)) return { answer: v, usd, error: null, frame }
  }
  return { answer: null, usd, error: 'unparseable answer', frame }
}

const pad2 = (n) => String(n).padStart(2, '0')
/** The local calendar day a spend is booked against, built from the clock. */
const dayOf = (ms) => {
  const d = new Date(ms)
  return [d.getFullYear(), pad2(d.getMonth() + 1), pad2(d.getDate())].join('-')
}

const OUT_MAX = 2 * 1024 * 1024
const ERR_MAX = 8000
// How long a child that ignored SIGTERM gets before SIGKILL, and before the
// queue stops waiting on it regardless.
const KILL_GRACE_MS = 5000

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

const unionArr = (a, b) => {
  const out = [...a]
  for (const x of b) if (!out.includes(x)) out.push(x)
  return out
}

/** A block's running term set, folded and capped: newest wins the slot,
 *  oldest is what gets dropped once the set is full. */
const foldTerms = (existing, fresh) => {
  const out = unionArr(existing, fresh)
  return out.length > MAX_TERMS ? out.slice(out.length - MAX_TERMS) : out
}

/** A heuristic block's title: the opening turn's own prompt head, or, for a
 *  turn that began with no typed prompt, its answer head instead -- and
 *  `untitled` rather than empty when both are blank. Cut at `TITLE_MAX`
 *  either way. */
const titleFor = (t) => {
  const p = String(t?.promptHead ?? '').trim()
  if (p) return p.slice(0, TITLE_MAX)
  const a = String(t?.answerHead ?? '').trim()
  if (a) return a.slice(0, TITLE_MAX)
  return 'untitled'
}

const blankBlock = (id, t, at) => ({
  id, title: titleFor(t), summary: '', state: 'open', by: 'heuristic', pinned: false, rev: 0,
  startedAt: at, endedAt: at, parent: null,
  turns: [t.id], files: Array.isArray(t.files) ? [...t.files] : [], terms: t.terms ?? [], progress: '',
})

/** Older turns keep their id and lose their prompt/answer text once the
 *  chain holds more turns than `MAX_TURNS` -- the block that owns them, and
 *  its turn count and file list, are unaffected. Idempotent: re-running it
 *  against an already-trimmed turn is a harmless no-op, which is what lets
 *  every `turn()` call just re-check the whole map rather than track a
 *  cursor. */
const capTurns = (chain) => {
  const ids = Object.keys(chain.turns)
  const overflow = ids.length - MAX_TURNS
  if (overflow <= 0) return chain
  const turns = { ...chain.turns }
  for (let i = 0; i < overflow; i++) {
    const t = turns[ids[i]]
    if (!t) continue
    const { promptHead, answerHead, ...rest } = t
    turns[ids[i]] = rest
  }
  return { ...chain, turns }
}

/** The oldest block is dropped ENTIRELY once the chain holds more than
 *  `MAX_BLOCKS` -- including the turn records only it referenced, so a
 *  chain that keeps opening blocks does not also keep an ever-growing set
 *  of orphaned turns nothing can reach any more. */
const capBlocks = (chain) => {
  if (chain.blocks.length <= MAX_BLOCKS) return chain
  const drop = chain.blocks.length - MAX_BLOCKS
  const dropped = chain.blocks.slice(0, drop)
  const kept = chain.blocks.slice(drop)
  const turns = { ...chain.turns }
  for (const b of dropped) for (const id of b.turns) delete turns[id]
  return { ...chain, blocks: kept, turns }
}

/** Folds one turn, landing at `at`, into a chain and returns the next chain
 *  without touching the one passed in. The one path `turn()` and `rebuild()`
 *  share, so a replayed transcript lands in exactly the blocks the same turns
 *  would have built live. */
const foldTurn = (chain, t, at) => {
  const terms = termsOf(t.promptHead, t.files)
  const decision = assignTurn(chain, { ...t, terms }, at)
  const turnRecord = {
    id: t.id,
    at,
    durationMs: t.durationMs ?? 0,
    reason: t.reason ?? '',
    origin: t.origin ?? 'unknown',
    promptHead: t.promptHead ?? '',
    answerHead: t.answerHead ?? '',
    files: Array.isArray(t.files) ? t.files : [],
    tools: t.tools ?? 0,
    subturns: t.subturns ?? 0,
  }
  const turns = { ...chain.turns, [t.id]: turnRecord }
  const blocks = chain.blocks.map((b) => ({ ...b }))
  let blockId
  if (decision.opened) {
    const openIdx = blocks.findIndex((b) => b.state === 'open')
    if (openIdx !== -1) blocks[openIdx] = { ...blocks[openIdx], state: 'closed', endedAt: at }
    blockId = uid()
    blocks.push(blankBlock(blockId, { ...t, terms }, at))
  } else {
    blockId = decision.blockId
    const idx = blocks.findIndex((b) => b.id === blockId)
    const b = blocks[idx]
    blocks[idx] = {
      ...b,
      turns: [...b.turns, t.id],
      files: unionArr(b.files, turnRecord.files),
      terms: foldTerms(b.terms, terms),
      endedAt: at,
    }
  }
  let next = { ...chain, blocks, turns }
  next = capTurns(next)
  next = capBlocks(next)
  return { next, decision, blockId }
}

// `callBudgetUsd` is one pass's --max-budget-usd: at least twice what a cold
// pass on the default model has been seen to cost with this argv, rounded up
// to the next five cents, and never below 0.15. A cap under a cold pass fails
// the first refine after every cache expiry, with the spend booked and no
// summary to show for it.
//
// `dayUsd` is RELAY-WIDE: the refiner's total across every session for one
// local calendar day, not a per-session allowance. A per-session cap let a
// board with many sessions spend that allowance once per session.
export const createChains = ({
  dir, now = Date.now, run = null, claudeBin = 'claude', safeMode = false,
  model = 'sonnet', callBudgetUsd = 0.15, dayUsd = 3,
  idleMs = 90_000, everyTurns = 8, timeoutMs = 120_000,
  capture = null, broadcast = null, readFile = null,
  // The spend ledger (spend.mjs). Optional and duck-typed exactly like
  // `capture` above: a caller with none simply records nothing.
  spend = null,
} = {}) => {
  const cache = new Map()
  // The refiner's relay-wide spend for one local day. Seeded below from every
  // chain's own booking for today, so a relay restart neither forgets what
  // was spent nor needs a file of its own.
  let dayTotal = { day: dayOf(now()), usd: 0 }
  // Keyed by session id, holding only what `inheritableChainOf` needs.
  // Built once from whatever is already on disk, then kept current on
  // every save -- so a candidate search never has to load every chain on
  // the machine just to read four fields off each of them.
  const index = {}

  const indexEntryOf = (chain) => ({
    name: chain.name ?? '',
    cwd: chain.cwd ?? '',
    updatedAt: chain.updatedAt ?? 0,
    resumedFrom: chain.resumedFrom ?? null,
  })

  try {
    const chainsDir = join(dir, CHAINS_DIR)
    for (const fname of readdirSync(chainsDir)) {
      if (!fname.endsWith('.json')) continue
      const id = fname.slice(0, -'.json'.length)
      try {
        const chain = sanitizeChain(JSON.parse(readFileSync(join(chainsDir, fname), 'utf8')))
        if (chain) index[id] = indexEntryOf(chain)
        if (chain?.refiner?.day === dayTotal.day) {
          const usd = Number(chain.refiner.spentUsd)
          if (Number.isFinite(usd) && usd > 0) dayTotal.usd += usd
        }
      } catch {
        // Unparseable at construction time is skipped, not moved -- only
        // load(id) touches the filesystem for that, and this scan runs for
        // every session's file at once rather than one a caller asked for.
      }
    }
  } catch {
    // No chains directory yet: an empty index is the correct starting point.
  }

  const save = (sessionId, chain) => {
    // Serialize FIRST. If this throws, nothing below has run and the
    // previous file is still the previous file.
    const body = JSON.stringify(chain, null, 2)
    const file = chainPath(dir, sessionId)
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

  const load = (sessionId) => {
    if (cache.has(sessionId)) return cache.get(sessionId)
    const file = chainPath(dir, sessionId)
    const chain = readChainFile(file, {
      moveAside: (f, err) => {
        const aside = `${f}.bad-${now()}`
        try {
          renameSync(f, aside)
          process.stderr.write(`chain store: ${f} would not parse (${err.message}); moved aside to ${aside}\n`)
        } catch (renameErr) {
          process.stderr.write(`chain store: ${f} would not parse (${err.message}); could not move it aside (${renameErr.message})\n`)
        }
      },
    })
    if (chain) {
      cache.set(sessionId, chain)
      index[sessionId] = indexEntryOf(chain)
    }
    return chain
  }

  /** Every mutator's last step: stamp `updatedAt`, persist, and only THEN
   *  update the cache and the index -- a throw from `save` propagates
   *  straight out, leaving both exactly as they were before the call. */
  const bump = (sessionId, next, extra = {}) => {
    next.updatedAt = now()
    save(sessionId, next)
    cache.set(sessionId, next)
    index[sessionId] = indexEntryOf(next)
    if (broadcast) broadcast('chain', { sessionId, chain: compactChain(next) })
    return { ok: true, ...extra }
  }

  /** The refiner's bookkeeping write -- call count, spend, last attempt --
   *  in the same save-then-cache order, but WITHOUT stamping `updatedAt`,
   *  which says when the chain itself last changed. Broadcasts only when
   *  `announce` says the paused flag the payload carries has moved. */
  const record = (sessionId, next, announce = false) => {
    save(sessionId, next)
    cache.set(sessionId, next)
    index[sessionId] = indexEntryOf(next)
    if (announce && broadcast) broadcast('chain', { sessionId, chain: compactChain(next) })
  }

  const get = (sessionId) => load(sessionId)

  const payload = (liveIds) => {
    const live = liveIds instanceof Set ? liveIds : new Set(liveIds ?? [])
    const t = now()
    const out = {}
    for (const [sessionId, entry] of Object.entries(index)) {
      const recent = t - (entry.updatedAt ?? 0) <= RECENT_MS
      if (!live.has(sessionId) && !recent) continue
      const chain = load(sessionId)
      if (chain) out[sessionId] = compactChain(chain)
    }
    return out
  }

  /** `meta` is the session as the caller knows it -- `{ name, cwd, root,
   *  transcript, startedAt }`, every field optional. Each non-empty string
   *  replaces the chain's own value and an empty one leaves it standing, so a
   *  path learned late is recorded and never erased again. Inheritance reads
   *  the name and cwd from here, and a rebuild reads the transcript path. */
  const turn = (sessionId, t, meta = null) => {
    let chain = load(sessionId)
    const at = t.at ?? now()
    if (!chain) {
      const startedAt = Number.isFinite(meta?.startedAt) ? meta.startedAt : at
      chain = blankChain({ sessionId, name: '', cwd: '', root: '', transcript: '', startedAt, now: at })
    }
    for (const key of ['name', 'cwd', 'root', 'transcript']) {
      const v = meta?.[key]
      if (typeof v === 'string' && v && chain[key] !== v) chain = { ...chain, [key]: v }
    }
    const { next, decision, blockId } = foldTurn(chain, t, at)
    return bump(sessionId, next, { opened: decision.opened, blockId, why: decision.why })
  }

  const pin = (sessionId, blockId, pinned) => {
    const chain = load(sessionId)
    if (!chain) return { ok: false, error: 'no such session' }
    const idx = chain.blocks.findIndex((b) => b.id === blockId)
    if (idx === -1) return { ok: false, error: 'no such block' }
    const blocks = [...chain.blocks]
    blocks[idx] = { ...blocks[idx], pinned: !!pinned }
    return bump(sessionId, { ...chain, blocks })
  }

  const retitle = (sessionId, blockId, title) => {
    const chain = load(sessionId)
    if (!chain) return { ok: false, error: 'no such session' }
    const idx = chain.blocks.findIndex((b) => b.id === blockId)
    if (idx === -1) return { ok: false, error: 'no such block' }
    const t = String(title ?? '').trim().slice(0, TITLE_MAX) || 'untitled'
    const blocks = [...chain.blocks]
    blocks[idx] = { ...blocks[idx], title: t, by: 'human' }
    return bump(sessionId, { ...chain, blocks })
  }

  const merge = (sessionId, blockId, into) => {
    const chain = load(sessionId)
    if (!chain) return { ok: false, error: 'no such session' }
    const idx = chain.blocks.findIndex((b) => b.id === blockId)
    if (idx === -1) return { ok: false, error: 'no such block' }
    if (into !== 'prev' && into !== 'next') return { ok: false, error: 'into must be prev or next' }
    const targetIdx = into === 'prev' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= chain.blocks.length) {
      return { ok: false, error: into === 'prev' ? 'no previous block' : 'no next block' }
    }
    const lo = Math.min(idx, targetIdx)
    const hi = Math.max(idx, targetIdx)
    const earlier = chain.blocks[lo]
    const later = chain.blocks[hi]
    const survivorIdx = targetIdx
    const absorbedIdx = idx
    const survived = {
      ...chain.blocks[survivorIdx],
      turns: [...earlier.turns, ...later.turns],
      files: unionArr(earlier.files, later.files),
      terms: foldTerms(earlier.terms, later.terms),
      startedAt: Math.min(earlier.startedAt, later.startedAt),
      endedAt: Math.max(earlier.endedAt, later.endedAt),
      by: 'human',
      rev: (chain.blocks[survivorIdx].rev ?? 0) + 1,
    }
    const absorbed = { ...chain.blocks[absorbedIdx], state: 'merged' }
    const blocks = [...chain.blocks]
    blocks[survivorIdx] = survived
    blocks[absorbedIdx] = absorbed
    return bump(sessionId, { ...chain, blocks })
  }

  const split = (sessionId, blockId, atTurnId) => {
    const chain = load(sessionId)
    if (!chain) return { ok: false, error: 'no such session' }
    const idx = chain.blocks.findIndex((b) => b.id === blockId)
    if (idx === -1) return { ok: false, error: 'no such block' }
    const block = chain.blocks[idx]
    const cut = block.turns.indexOf(atTurnId)
    if (cut === -1) return { ok: false, error: 'no such turn in that block' }
    const firstTurns = block.turns.slice(0, cut)
    const secondTurns = block.turns.slice(cut)
    const filesFor = (ids) => {
      let out = []
      for (const id of ids) out = unionArr(out, chain.turns[id]?.files ?? [])
      return out
    }
    const termsFor = (ids) => {
      let out = []
      for (const id of ids) {
        const t = chain.turns[id]
        if (!t) continue
        out = foldTerms(out, termsOf(t.promptHead, t.files))
      }
      return out
    }
    const lastFirst = firstTurns[firstTurns.length - 1]
    const firstBlock = {
      ...block,
      turns: firstTurns,
      files: filesFor(firstTurns),
      terms: termsFor(firstTurns),
      state: 'closed',
      endedAt: chain.turns[lastFirst]?.at ?? block.endedAt,
      by: 'human',
      rev: (block.rev ?? 0) + 1,
    }
    const secondBlock = {
      id: uid(),
      title: titleFor(chain.turns[secondTurns[0]]),
      summary: '',
      state: block.state,
      by: 'human',
      pinned: false,
      rev: 0,
      startedAt: chain.turns[secondTurns[0]]?.at ?? block.startedAt,
      endedAt: block.endedAt,
      parent: block.id,
      turns: secondTurns,
      files: filesFor(secondTurns),
      terms: termsFor(secondTurns),
      progress: block.progress ?? '',
    }
    const blocks = [...chain.blocks]
    blocks.splice(idx, 1, firstBlock, secondBlock)
    return bump(sessionId, { ...chain, blocks })
  }

  const inherit = (opts, liveIds) => {
    const { sessionId, name, repo, cwd, root, transcript, startedAt } = opts
    if (load(sessionId)) return { from: null }
    const live = liveIds instanceof Set ? liveIds : new Set(liveIds ?? [])
    const found = inheritableChainOf(index, { name, repo, cwd }, live)
    if (!found) return { from: null }
    const old = load(found.sessionId)
    if (!old) return { from: null }
    const t = now()
    // Every copied block that was still open belongs to the OLD session's
    // story, not the new one's -- the new session gets its own open block
    // below, and a chain must never carry two.
    const blocks = old.blocks.map((b) => (b.state === 'open' ? { ...b, state: 'closed', endedAt: t } : { ...b }))
    const turns = {}
    for (const b of blocks) for (const id of b.turns) if (old.turns[id]) turns[id] = old.turns[id]
    const fresh = {
      id: uid(), title: 'restart', summary: '', state: 'open', by: 'heuristic', pinned: false, rev: 0,
      startedAt: t, endedAt: t, parent: null, turns: [], files: [], terms: [], progress: '',
    }
    const base = blankChain({
      sessionId, name: name ?? '', cwd: cwd ?? '', root: root ?? '', transcript: transcript ?? '',
      startedAt: startedAt ?? t, now: t,
    })
    const next = { ...base, resumedFrom: found.sessionId, blocks: [...blocks, fresh], turns }
    bump(sessionId, next)
    return { from: found.sessionId }
  }

  // ---- rebuild and export ------------------------------------------------------

  const readTranscript = readFile ?? ((file) => readFileSync(file, 'utf8'))

  /** Replaces a chain's blocks and turns with a replay of its transcript
   *  through the same fold `turn()` uses. When the transcript yields no turn
   *  -- empty, unreadable as messages, or a format that has drifted -- it
   *  answers "nothing to rebuild" and writes nothing: a wrong chain is worse
   *  than no rebuild.
   *
   *  A rebuild is for a chain that is wrong or missing, so pins, hand edits,
   *  summaries and history all go: carrying a pin across a replay would mean
   *  matching old block ids to new ones, which a replay cannot do honestly.
   *  The name, cwd, root, transcript path and lineage carry over, and so does
   *  the refiner's day accounting, so a rebuild never resets the budget. Its
   *  `lastAt` goes back to zero: the rebuilt window counts as never refined,
   *  and the next tick refines it once under the ordinary triggers and caps. */
  const rebuild = async (sessionId) => {
    let chain
    try {
      chain = load(sessionId)
    } catch (err) {
      return { ok: false, error: `unreadable chain: ${err?.message ?? err}` }
    }
    if (!chain) return { ok: false, error: 'no such session' }
    const file = typeof chain.transcript === 'string' ? chain.transcript : ''
    if (!file) return { ok: false, error: 'no transcript' }
    let text
    try {
      text = await readTranscript(file)
    } catch (err) {
      return { ok: false, error: `transcript unreadable: ${err?.code ?? err?.message ?? err}` }
    }
    const turns = turnsFromTranscript(String(text ?? '').split('\n'))
    if (turns.length === 0) return { ok: false, error: 'nothing to rebuild' }
    // The chain as it stands after the read, so a turn recorded meanwhile is
    // not resurrected from a stale copy of the fields carried over.
    const live = load(sessionId) ?? chain
    const refiner = { calls: 0, spentUsd: 0, day: '', paused: false, ...live.refiner, lastAt: 0 }
    let next = { ...live, blocks: [], turns: {}, history: [], refiner }
    for (const t of turns) next = foldTurn(next, t, Number.isFinite(t.at) ? t.at : now()).next
    next = { ...next, rev: (Number.isFinite(live.rev) ? live.rev : 0) + 1 }
    bump(sessionId, next)
    return { ok: true, turns: turns.length, blocks: next.blocks.length }
  }

  /** The export over every chain the store knows, read without side effects:
   *  from the cache when a chain is already loaded, otherwise straight from
   *  its file -- neither caching it nor moving a bad file aside, since an
   *  export only reads. */
  const exportAll = ({ since = 0 } = {}) => {
    const from = Number(since) || 0
    const ids = Object.keys(index).filter((id) => (index[id].updatedAt ?? 0) >= from)
    const read = (id) => cache.get(id) ?? readChainFile(chainPath(dir, id))
    return exportChains({ ids, read, since: from })
  }

  // ---- the refiner -----------------------------------------------------------
  //
  // A budgeted `claude -p` child, the relay's rather than any session's, that
  // retitles and resummarises the open block and the three before it. Three
  // bounds hold it: one child at a time across every session (a FIFO queue), a
  // relay-wide day spend cap checked BEFORE a spawn, and a timeout that kills.
  // Its answer is applied to the chain as it stands when the child settles,
  // never to the copy it was shown, so a turn that arrived while it ran is
  // never overwritten.

  const queue = []
  let active = null
  // The running child's stop, while one is running: one child at a time, so
  // one slot. `stopped` is set by killAll and never cleared.
  let stopActive = null
  let stopped = false

  const busy = (sessionId) => active?.sessionId === sessionId || queue.some((j) => j.sessionId === sessionId)

  /** One child, settled exactly once. Resolves `{ stdout, error }` on a real
   *  exit, a spawn failure, a stream error or a timeout alike -- never
   *  rejects. Every stream carries an 'error' listener: an unhandled one is an
   *  uncaught exception, and this runs inside the relay. */
  const runChild = (argv) => new Promise((resolve) => {
    let stdout = ''
    let errText = ''
    let failure = null
    let settled = false
    let child = null
    let timer = null
    let backstop = null
    // False only on the two paths below that settle before a child exists
    // (a synchronous spawn throw, or a runner that hands back something with
    // no child on it); true the moment `child` is a real handle.
    let spawned = false
    const settle = (code) => {
      if (settled) return
      settled = true
      stopActive = null
      clearTimeout(timer)
      clearTimeout(backstop)
      const tail = errText.trim().slice(0, 200)
      const error = failure ?? (code === 0 ? null : `exit ${code}${tail ? `: ${tail}` : ''}`)
      resolve({ stdout, error, spawned })
    }
    const fail = (why) => {
      if (!failure) failure = why
      try { child?.kill('SIGTERM') } catch {}
    }
    try {
      // stdin is closed outright: the input is on the argv, and an open stdin
      // makes the CLI wait for input that never arrives.
      child = run(claudeBin, argv, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      failure = `spawn threw: ${err?.message ?? err}`
      settle(-1)
      return
    }
    if (!child || typeof child.on !== 'function') {
      failure = 'spawn returned no child'
      settle(-1)
      return
    }
    spawned = true
    // The same escalation the timeout uses, so a child that ignores SIGTERM
    // still settles its refine.
    stopActive = () => {
      fail('stopped')
      clearTimeout(backstop)
      backstop = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
        settle(-1)
      }, KILL_GRACE_MS)
      backstop.unref?.()
    }
    child.on('error', (err) => {
      if (!failure) failure = `spawn failed: ${err?.message ?? err}`
      settle(-1)
    })
    child.stdout?.on('error', (err) => fail(`stdout: ${err?.message ?? err}`))
    child.stderr?.on('error', (err) => fail(`stderr: ${err?.message ?? err}`))
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk) => {
      if (stdout.length + chunk.length > OUT_MAX) fail('output too large')
      else stdout += chunk
    })
    child.stderr?.on('data', (chunk) => { if (errText.length < ERR_MAX) errText += chunk })
    child.on('close', (code) => settle(code))
    // A failed child is done once it exits; its output no longer matters, and
    // 'close' can wait on a grandchild still holding a pipe.
    child.on('exit', (code) => { if (failure) settle(code) })
    timer = setTimeout(() => {
      fail(`timed out after ${timeoutMs}ms`)
      backstop = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
        settle(-1)
      }, KILL_GRACE_MS)
      backstop.unref?.()
    }, timeoutMs)
    timer.unref?.()
  })

  const logCall = (sessionId, payloadOut) => {
    try { capture?.append?.('chain', sessionId, payloadOut) } catch {}
  }

  /** One refinement, run from the head of the queue. */
  const attempt = async (sessionId) => {
    const chain = load(sessionId)
    if (!chain) return { ok: false, error: 'no such session' }
    const t = now()
    const day = dayOf(t)
    const was = { calls: 0, spentUsd: 0, lastAt: 0, day: '', paused: false, ...chain.refiner }
    let refiner = was.day === day ? { ...was } : { ...was, calls: 0, spentUsd: 0, day, paused: false }
    if (dayTotal.day !== day) dayTotal = { day, usd: 0 }
    // The cap is checked before anything spawns, so the worst overrun is one
    // call's own --max-budget-usd. It is relay-wide: the per-session numbers
    // are kept for display and never gate anything.
    if (dayTotal.usd >= dayUsd) {
      refiner.paused = true
      if (!was.paused || was.day !== day) record(sessionId, { ...chain, refiner }, !was.paused)
      const reason = `the refiner has spent $${dayTotal.usd.toFixed(2)} today across every session; its day cap is $${dayUsd.toFixed(2)}`
      return { ok: false, error: 'budget', reason }
    }
    // Stamped on every attempt that spawns, success or failure, so a child
    // that keeps failing is tried again only once a new turn arrives.
    refiner = { ...refiner, calls: (Number(refiner.calls) || 0) + 1, lastAt: t }
    record(sessionId, { ...chain, refiner }, refiner.paused !== was.paused)

    const argv = chainArgv({ text: chainInputText(chain), model, budgetUsd: callBudgetUsd, safeMode })
    const startedAt = now()
    const out = await runChild(argv)
    const read = readAnswer(out.stdout)
    if (out.spawned) {
      try { spend?.record(resultRecord({ kind: 'chain', site: 'refine', model, frame: read.frame, startedAt, now: now() })) } catch {}
    }
    const error = out.error ?? read.error

    // A child that ran but reported no cost books its whole --max-budget-usd:
    // the cap guards real spend, and an unknown figure is not a zero one. A
    // spawn that never produced a child spent nothing and books nothing.
    const cost = out.spawned ? (read.usd > 0 ? read.usd : callBudgetUsd) : 0
    const settledDay = dayOf(now())
    if (dayTotal.day !== settledDay) dayTotal = { day: settledDay, usd: 0 }
    dayTotal.usd += cost
    const live = load(sessionId) ?? { ...chain, refiner }
    const spentUsd = (Number(live.refiner?.spentUsd) || 0) + cost
    const booked = { ...live.refiner, spentUsd, paused: dayTotal.usd >= dayUsd }
    const pausedMoved = booked.paused !== !!live.refiner?.paused

    if (error) {
      record(sessionId, { ...live, refiner: booked }, pausedMoved)
      logCall(sessionId, { calls: booked.calls, usd: read.usd, refused: 0, error })
      return { ok: false, error }
    }
    const result = applyRefinement(live, read.answer, now())
    const next = { ...result.chain, refiner: booked }
    if (result.applied.length) bump(sessionId, next)
    else record(sessionId, next, pausedMoved)
    logCall(sessionId, { calls: booked.calls, usd: read.usd, refused: result.refused.length })
    return { ok: true, applied: result.applied, refused: result.refused, usd: read.usd }
  }

  const pump = () => {
    if (stopped || active || queue.length === 0) return
    const job = queue.shift()
    active = job
    attempt(job.sessionId)
      .catch((err) => ({ ok: false, error: `refine failed: ${err?.message ?? err}` }))
      .then((result) => {
        active = null
        job.resolve(result)
        pump()
      })
  }

  /** Queues one refinement. Without `force` it runs only when a turn has
   *  arrived since the last pass; `force` never lifts the day cap. */
  const refine = async (sessionId, { force = false } = {}) => {
    if (!run) return { ok: false, error: 'no claude' }
    if (stopped) return { ok: false, error: 'stopped' }
    let chain
    try {
      chain = load(sessionId)
    } catch (err) {
      return { ok: false, error: `unreadable chain: ${err?.message ?? err}` }
    }
    if (!chain) return { ok: false, error: 'no such session' }
    const all = Object.values(chain.turns ?? {})
    if (all.length === 0) return { ok: false, error: 'nothing to refine' }
    if (busy(sessionId)) return { ok: false, error: 'busy' }
    const lastAt = Number(chain.refiner?.lastAt) || 0
    if (!force && !all.some((tr) => (Number(tr?.at) || 0) > lastAt)) return { ok: false, error: 'nothing new' }
    return new Promise((resolve) => {
      queue.push({ sessionId, resolve })
      pump()
    })
  }

  /** Decides which chains are due, and queues them. Due means at least one
   *  turn since the last pass AND either idle for `idleMs` since the newest
   *  turn or `everyTurns` turns since the last pass -- both read from turn
   *  times, never from `updatedAt`, which a pin also moves. Only chains the
   *  payload would carry are considered, so a restart never sweeps every old
   *  session on disk into the queue. */
  const tick = () => {
    if (!run || stopped) return
    const t = now()
    for (const [sessionId, entry] of Object.entries(index)) {
      if (t - (entry.updatedAt ?? 0) > RECENT_MS) continue
      if (busy(sessionId)) continue
      let chain
      try { chain = load(sessionId) } catch { continue }
      if (!chain) continue
      const lastAt = Number(chain.refiner?.lastAt) || 0
      let since = 0
      let newest = 0
      for (const tr of Object.values(chain.turns ?? {})) {
        const at = Number(tr?.at) || 0
        if (at > lastAt) since++
        if (at > newest) newest = at
      }
      if (since === 0) continue
      if (t - newest >= idleMs || since >= everyTurns) refine(sessionId).catch(() => {})
    }
  }

  const flush = () => {
    for (const [sessionId, chain] of cache) save(sessionId, chain)
  }

  /** Stops the refiner for good. Every queued refine settles as a failure
   *  without spawning; the running child gets SIGTERM and its refine settles
   *  as an ordinary failure, already stamped, so nothing retries it. After
   *  this no refine and no tick spawns anything. For shutdown, where a child
   *  left running would go on spending after the relay has gone. */
  const killAll = () => {
    stopped = true
    for (const job of queue.splice(0, queue.length)) job.resolve({ ok: false, error: 'stopped' })
    stopActive?.()
  }

  return {
    get, payload, turn, pin, merge, split, retitle, inherit,
    refine, rebuild, exportAll, busy, tick, flush, killAll,
  }
}
