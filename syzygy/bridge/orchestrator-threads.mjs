// Persisted orchestrator conversations. AUTHORITATIVE, not derived: a thread
// exists nowhere else once the pointer to it is lost. Each thread carries its
// own --resume session id, so a relay restart resumes the headless transcript
// Claude Code still has on disk instead of orphaning it.
//
// The write discipline: serialize FIRST, write a temp file in the same
// directory, rename it over the target. A serialize that throws leaves the
// previous file exactly as it was. Write-through on every mutation rather
// than a dirty flag plus a timer, because a relay dying between a turn and a
// timer tick would lose the answer.
//
// Reading sanitises rather than throws: a malformed record is dropped, never
// carried through to a consumer that reaches into it unguarded.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { clipToWordBoundary } from './orchestrator.mjs'

export const THREADS_MAX = 25
/** Turn RECORDS, not exchanges: 40 records is 20 question/answer pairs. */
export const THREAD_TURNS_MAX = 40
export const TURN_TEXT_MAX = 8000
export const TITLE_MAX = 80
export const THREADS_IN_PAYLOAD = 10
export const PREVIEW_MAX = 80

const ROLES = ['user', 'syzygy']

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Clips rather than drops: a truncated answer is still the record that the
 *  turn happened, and a dropped one is no record at all. */
const clipText = (s) => {
  const t = String(s ?? '')
  return t.length > TURN_TEXT_MAX ? t.slice(0, TURN_TEXT_MAX - 1) + '…' : t
}

const sanitizeTurn = (t) => {
  if (!isPlainObject(t) || !ROLES.includes(t.role) || typeof t.text !== 'string') return null
  return {
    role: t.role,
    text: clipText(t.text),
    actions: Array.isArray(t.actions) ? t.actions : [],
    rejected: Array.isArray(t.rejected) ? t.rejected : [],
    error: typeof t.error === 'string' ? t.error : null,
    at: Number.isFinite(t.at) ? t.at : 0,
  }
}

const sanitizeThread = (t) => {
  if (!isPlainObject(t) || typeof t.id !== 'string' || !t.id) return null
  return {
    id: t.id,
    title: typeof t.title === 'string' ? t.title.slice(0, TITLE_MAX) : '',
    createdAt: Number.isFinite(t.createdAt) ? t.createdAt : 0,
    updatedAt: Number.isFinite(t.updatedAt) ? t.updatedAt : 0,
    pinned: !!t.pinned,
    resumeSessionId: typeof t.resumeSessionId === 'string' ? t.resumeSessionId : null,
    turns: (Array.isArray(t.turns) ? t.turns : []).map(sanitizeTurn).filter(Boolean).slice(-THREAD_TURNS_MAX),
  }
}

/** Pinned first, then most recently touched. The payload, the switcher and
 *  eviction all read this one order, so none of them can disagree. */
const byRank = (a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt - a.updatedAt)

export const createThreadStore = ({ file, now = Date.now }) => {
  /** @type {any[]} */ let threads = []
  let currentId = null

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    threads = (Array.isArray(raw?.threads) ? raw.threads : []).map(sanitizeThread).filter(Boolean)
    currentId = typeof raw?.currentId === 'string' ? raw.currentId : null
  } catch (err) {
    threads = []; currentId = null
    // A missing file is the ordinary first run. A file that EXISTS but will
    // not parse is moved aside rather than silently overwritten, since this
    // store is authoritative and a silent overwrite would discard the only
    // copy of a real conversation.
    if (err.code !== 'ENOENT') {
      const aside = `${file}.corrupt-${now()}`
      try {
        renameSync(file, aside)
        process.stderr.write(`orchestrator threads: ${file} failed to load (${err.message}); moved aside to ${aside}\n`)
      } catch (renameErr) {
        process.stderr.write(`orchestrator threads: ${file} failed to load (${err.message}); could not move it aside (${renameErr.message})\n`)
      }
    }
  }
  // A currentId naming nothing that survived the read is dropped here, once,
  // so current() never has to guard it and no caller can dereference it.
  if (currentId && !threads.some((t) => t.id === currentId)) currentId = null

  const get = (id) => threads.find((t) => t.id === id) ?? null

  const write = () => {
    // Serialize FIRST. If this throws -- a circular `actions` off a bad
    // caller, say -- nothing has been written and the previous file is still
    // the previous file.
    const text = JSON.stringify({ version: 1, currentId, threads })
    const tmp = file + '.tmp'
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, text)
      renameSync(tmp, file)
    } catch (err) {
      try { unlinkSync(tmp) } catch {}
      throw err
    }
  }

  /** Never evicts a pinned thread, even when that means exceeding the cap:
   *  a pin means "come back to this", and a cap that quietly deleted one
   *  would break the only promise this feature makes. Says so once rather
   *  than silently, so the state is observable. */
  let overCapWarned = false
  const evict = () => {
    while (threads.length > THREADS_MAX) {
      const victim = [...threads].filter((t) => !t.pinned).sort((a, b) => a.updatedAt - b.updatedAt)[0]
      if (!victim) {
        if (!overCapWarned) {
          overCapWarned = true
          process.stderr.write(`orchestrator threads: ${threads.length} threads and all pinned; the ${THREADS_MAX} cap is not enforced against a pin\n`)
        }
        return
      }
      threads = threads.filter((t) => t.id !== victim.id)
      if (currentId === victim.id) currentId = threads.slice().sort(byRank)[0]?.id ?? null
    }
  }

  const touch = (t) => { t.updatedAt = now() }

  return {
    all: () => threads.slice().sort(byRank),
    get,
    current: () => get(currentId),

    create({ title = '' } = {}) {
      const t = {
        id: uid(), title: String(title ?? '').slice(0, TITLE_MAX),
        createdAt: now(), updatedAt: now(), pinned: false, resumeSessionId: null, turns: [],
      }
      threads.push(t)
      currentId = t.id
      evict()
      write()
      return t
    },

    select(id) {
      const t = get(id)
      if (!t) return null
      currentId = t.id
      write()
      return t
    },

    /** The auto-title lives here, on the FIRST user turn of a thread whose
     *  title is still empty -- so a `rename` is never overwritten by the next
     *  question, with no extra "locked" field to keep honest. */
    appendTurn(id, turn) {
      const t = get(id)
      if (!t) return null
      const rec = sanitizeTurn({ ...turn, at: now() })
      if (!rec) return null
      const next = [...t.turns, rec].slice(-THREAD_TURNS_MAX)
      const prevTurns = t.turns, prevTitle = t.title, prevUpdated = t.updatedAt
      t.turns = next
      // TITLE_MAX - 1: the clipper appends its ellipsis AFTER `max` characters,
      // so this is what keeps a spaceless question's title within TITLE_MAX.
      if (!t.title && rec.role === 'user') t.title = clipToWordBoundary(rec.text, TITLE_MAX - 1)
      touch(t)
      try { write() } catch (err) {
        // Roll the in-memory thread back to what is actually on disk, so a
        // failed write never leaves the process believing something the file
        // does not say.
        t.turns = prevTurns; t.title = prevTitle; t.updatedAt = prevUpdated
        throw err
      }
      return t
    },

    setResume(id, sessionId) {
      const t = get(id)
      if (!t) return null
      t.resumeSessionId = typeof sessionId === 'string' && sessionId ? sessionId : null
      write()
      return t
    },

    /** An empty rename falls back to the auto-title rather than leaving a
     *  nameless chip: the switcher has to show something, and the first
     *  question is what the thread is about. */
    rename(id, title) {
      const t = get(id)
      if (!t) return null
      const clean = String(title ?? '').trim().slice(0, TITLE_MAX)
      const firstAsk = t.turns.find((x) => x.role === 'user')
      t.title = clean || (firstAsk ? clipToWordBoundary(firstAsk.text, TITLE_MAX - 1) : '')
      touch(t)
      write()
      return t
    },

    setPinned(id, pinned) {
      const t = get(id)
      if (!t) return null
      t.pinned = !!pinned
      write()
      return t
    },

    remove(id) {
      if (!get(id)) return false
      threads = threads.filter((t) => t.id !== id)
      if (currentId === id) currentId = threads.slice().sort(byRank)[0]?.id ?? null
      write()
      return true
    },

    /** The snapshot payload's shape: every PINNED thread plus the `limit`
     *  most recent unpinned ones. No `turns` -- the snapshot frame goes in
     *  full to every pane that connects and must not grow with conversation
     *  length -- and no `resumeSessionId`, which the browser has no use for. */
    headers({ limit = THREADS_IN_PAYLOAD } = {}) {
      const sorted = threads.slice().sort(byRank)
      const pinned = sorted.filter((t) => t.pinned)
      const rest = sorted.filter((t) => !t.pinned).slice(0, Math.max(0, limit))
      return [...pinned, ...rest].map((t) => ({
        id: t.id, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt,
        pinned: t.pinned, turnCount: t.turns.length,
        preview: clipToWordBoundary(t.turns.at(-1)?.text ?? '', PREVIEW_MAX),
      }))
    },

    currentId: () => currentId,

    /** Belt only: every mutation above already wrote through. */
    flush: () => { write() },
  }
}
