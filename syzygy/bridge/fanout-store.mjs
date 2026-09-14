// The Dispatch tab's fan-out run store: one paused ask, split into drafts, at
// a time. Modelled on requests.mjs's store -- authoritative, not derived, so
// every write goes to a temp file in the same directory and is renamed over
// the target, and a serialize that throws leaves the previous file untouched.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  splitParagraphs, draftAsk, assign as assignDraft, mergeDrafts, unassignedIndices,
  RUN_STATES, sanitizeRun,
} from './fanout.mjs'

export const FANOUT_KEEP = 10

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

// A patch that could reach a stored record's prototype is never merged --
// see requests.mjs for why Object.assign / spread on a caller's patch is
// unsafe here.
const UPDATE_LOCKED = new Set([
  'id', 'createdAt', 'ask', 'paragraphs', 'state', 'drafts', 'unassigned',
  '__proto__', 'constructor', 'prototype',
])

const asStr = (v) => (typeof v === 'string' ? v : '')

/** A draft's paragraph set, kept in range, de-duped and sorted -- the same
 *  shape sanitizeRun enforces when a run is read back off disk. */
const cleanIndices = (indices, count) =>
  [...new Set((Array.isArray(indices) ? indices : [])
    .filter((i) => Number.isInteger(i) && i >= 0 && i < count))]
    .sort((a, b) => a - b)

/** The sanitised runs held by `file`, oldest first. A missing or unreadable
 *  file reads as an empty list -- this never throws and never touches disk. */
export const readRuns = (file) => {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(raw?.runs)) return []
    return raw.runs.map(sanitizeRun).filter((r) => r !== null)
  } catch {
    return []
  }
}

export const createFanoutStore = ({ file, now = Date.now }) => {
  /** @type {any[]} */ let runs = []
  let dirty = false

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(raw?.runs)) runs = raw.runs.map(sanitizeRun).filter((r) => r !== null)
    else throw new Error('fanout.json has no runs array')
  } catch (err) {
    runs = []
    // A missing file (first run, or a fresh worktree) is not corruption --
    // there is nothing to rescue and nothing worth a warning. A file that
    // EXISTS but failed to parse or has the wrong shape is different: this
    // store is authoritative, so starting empty and letting the next flush
    // fire would silently destroy the only copy. Move it aside instead, and
    // say so on stderr.
    if (err.code !== 'ENOENT') {
      const aside = `${file}.corrupt-${now()}`
      try {
        renameSync(file, aside)
        process.stderr.write(`fanout store: ${file} failed to load (${err.message}); moved aside to ${aside} and starting empty\n`)
      } catch (renameErr) {
        process.stderr.write(`fanout store: ${file} failed to load (${err.message}); could not move it aside (${renameErr.message}) -- starting empty, original left in place\n`)
      }
    }
  }

  // A run can only be `running` while its child process is alive, and that
  // child belonged to the process that wrote this file. One still `running`
  // here means that process is gone -- left alone it would hold the one
  // running slot forever.
  for (const r of runs) {
    if (r.state === 'running') {
      r.state = 'failed'
      r.error = 'the relay restarted while this run was in flight'
      dirty = true
    }
  }

  const get = (id) => runs.find((r) => r.id === id) ?? null
  const running = () => runs.find((r) => r.state === 'running') ?? null

  const flush = () => {
    if (!dirty) return
    // Serialize FIRST. If this throws, nothing has been written and the
    // previous file is still the previous file.
    const text = JSON.stringify({ version: 1, runs })
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

  /** Every draft's ask comes from its own paragraph set, and the run's
   *  unassigned set comes from every draft's -- one join, computed here, so
   *  nothing downstream re-derives it. */
  const derive = (run) => {
    run.drafts = run.drafts.map((d) => ({ ...d, ask: draftAsk(run.paragraphs, d.paragraphs) }))
    run.unassigned = unassignedIndices(run.drafts, run.paragraphs.length)
  }

  return {
    get dirty() { return dirty },
    all: () => runs,
    get,
    running,

    start(fields = {}) {
      if (running()) return { ok: false, error: 'a fan-out is already running' }
      const paragraphs = splitParagraphs(fields.ask)
      const run = {
        id: uid(),
        createdAt: now(),
        state: 'running',
        ask: String(fields.ask ?? ''),
        paragraphs,
        unassigned: paragraphs.map((_, i) => i),
        projects: (Array.isArray(fields.projects) ? fields.projects : []).map((p) => ({
          key: asStr(p?.key), name: asStr(p?.name), root: asStr(p?.root),
        })),
        drafts: [],
        error: null,
      }
      // Only one run may ever be running, so if the cap is already full every
      // other run is finished -- drop the oldest of those to make room.
      if (runs.length >= FANOUT_KEEP) {
        const i = runs.findIndex((r) => r.state !== 'running')
        if (i >= 0) runs.splice(i, 1)
      }
      runs.push(run)
      dirty = true
      return { ok: true, run }
    },

    update(id, patch) {
      const r = get(id)
      if (!r) return null
      if (!isPlainObject(patch)) return r
      for (const k of Object.keys(patch)) {
        if (UPDATE_LOCKED.has(k)) continue
        r[k] = patch[k]
      }
      dirty = true
      return r
    },

    setDrafts(id, drafts) {
      const r = get(id)
      if (!r) return null
      const list = Array.isArray(drafts) ? drafts : []
      const explicit = new Set(
        list.map((d) => (d && typeof d.id === 'string' && d.id ? d.id : null)).filter(Boolean))
      const used = new Set()
      let n = 0
      const mintId = () => {
        let candidate
        do { n++; candidate = 'd' + n } while (used.has(candidate) || explicit.has(candidate))
        return candidate
      }
      r.drafts = list.map((d) => {
        let did = d && typeof d.id === 'string' && d.id ? d.id : null
        if (!did || used.has(did)) did = mintId()
        used.add(did)
        return {
          id: did,
          title: asStr(d?.title),
          projectKey: asStr(d?.projectKey),
          paragraphs: cleanIndices(d?.paragraphs, r.paragraphs.length),
          goal: asStr(d?.goal),
          openQuestions: Array.isArray(d?.openQuestions) ? d.openQuestions.filter((q) => typeof q === 'string') : [],
          reason: asStr(d?.reason),
        }
      })
      derive(r)
      dirty = true
      return r
    },

    assign(id, draftId, index, mode) {
      const r = get(id)
      if (!r) return null
      if (!['move', 'copy', 'unassign'].includes(mode)) return null
      const i = Number(index)
      if (!Number.isInteger(i) || i < 0 || i >= r.paragraphs.length) return null
      r.drafts = assignDraft(r.drafts, draftId, i, mode)
      derive(r)
      dirty = true
      return r
    },

    merge(id, aId, bId) {
      const r = get(id)
      if (!r) return null
      r.drafts = mergeDrafts(r.drafts, aId, bId)
      derive(r)
      dirty = true
      return r
    },

    finish(id, state) {
      const r = get(id)
      if (!r) return null
      if (!RUN_STATES.includes(state)) return null
      r.state = state
      dirty = true
      return r
    },

    flush,
  }
}
