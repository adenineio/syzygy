// The Steering panel's custom buttons. A user types a label and a prompt;
// this module owns their shape, their validation and their persistence.
//
// Like dispatch.json and unlike world.json this file is AUTHORITATIVE, not
// derived: a button a user registered exists nowhere else and cannot be
// rebuilt if lost. So every write serializes first, goes to a temp file in the
// same directory and is renamed over the target -- a serialize that throws
// leaves the previous file exactly as it was.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export const MAX_BUTTONS = 24
export const MAX_LABEL = 24
export const MAX_PROMPT = 4000

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

/** A label reaches a <button> and the mode line; a prompt reaches a session's
 *  composer. Both are rejected outright rather than trimmed to fit: a prompt
 *  cut at 4000 characters is still an instruction the session will follow, and
 *  a silently shortened one is worse than a refused one. */
const validate = (list) => {
  if (!Array.isArray(list)) return { ok: false, error: 'custom must be an array' }
  if (list.length > MAX_BUTTONS) return { ok: false, error: `at most ${MAX_BUTTONS} custom buttons` }
  const clean = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'each button must be an object' }
    }
    if (typeof raw.label !== 'string' || typeof raw.prompt !== 'string') {
      return { ok: false, error: 'label and prompt must both be strings' }
    }
    const label = raw.label.trim()
    const prompt = raw.prompt.trim()
    if (!label) return { ok: false, error: 'a button needs a label' }
    if (!prompt) return { ok: false, error: 'a button needs a prompt' }
    if (label.length > MAX_LABEL) return { ok: false, error: `a label is at most ${MAX_LABEL} characters` }
    if (prompt.length > MAX_PROMPT) return { ok: false, error: `a prompt is at most ${MAX_PROMPT} characters` }
    clean.push({ raw, label, prompt })
  }
  return { ok: true, clean }
}

export const createSteeringStore = ({ file, now = Date.now }) => {
  /** @type {any[]} */ let custom = []
  let dirty = false

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(raw?.custom)) custom = raw.custom.filter((b) => b && typeof b === 'object')
    else throw new Error('steering.json has no custom array')
  } catch (err) {
    custom = []
    // A missing file is a first run, or a fresh worktree -- nothing to rescue
    // and nothing worth a warning. A file that EXISTS but failed to parse is
    // different: this store is the only copy, so move it aside rather than let
    // the next flush overwrite it, and say so on stderr.
    if (err.code !== 'ENOENT') {
      const aside = `${file}.corrupt-${now()}`
      try {
        renameSync(file, aside)
        process.stderr.write(`steering store: ${file} failed to load (${err.message}); moved aside to ${aside} and starting empty\n`)
      } catch (renameErr) {
        process.stderr.write(`steering store: ${file} failed to load (${err.message}); could not move it aside (${renameErr.message}) -- starting empty, original left in place\n`)
      }
    }
  }

  const flush = () => {
    if (!dirty) return
    // Serialize FIRST: if this throws, nothing was written and the previous
    // file is still the previous file.
    const text = JSON.stringify({ version: 1, custom })
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

  return {
    get dirty() { return dirty },
    all: () => custom,
    flush,

    /** The whole list, every time: add, edit, delete and reorder are all "here
     *  is the new list", the shape /api/request/reorder already uses. Nothing
     *  is written unless every entry validates. */
    replace(list) {
      const v = validate(list)
      if (!v.ok) return v
      const byId = new Map(custom.map((b) => [b.id, b]))
      custom = v.clean.map(({ raw, label, prompt }) => {
        // An id is honoured only when this store minted it. A client that
        // sends one for a button we have never seen gets a fresh one.
        const prior = typeof raw.id === 'string' ? byId.get(raw.id) : undefined
        // Unknown fields on a button we already hold are carried through, so
        // the file stays hand-editable -- readClaims' rule.
        return { ...(prior ?? {}), id: prior?.id ?? uid(), label, prompt, createdAt: prior?.createdAt ?? now() }
      })
      dirty = true
      return { ok: true, custom }
    },
  }
}
