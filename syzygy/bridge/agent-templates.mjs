// Session presets: a template names a kickoff prompt, a model and effort, a
// skill list and an optional persona, so a spawn can be a click instead of a
// paragraph retyped every time.
//
// AUTHORITATIVE, not derived: a preset exists nowhere else, and nothing can
// rebuild it. So every write serializes FIRST, goes to a temp file in the
// same directory, and is renamed over the target -- a failed serialize leaves
// the previous file exactly as it was. Same contract as pasteboard.mjs,
// findings.mjs, claims.mjs and requests.mjs, for the same reason.
//
// Every mutator builds the array it intends to write (`next`), calls
// `flush(next)`, and only on success assigns `items = next` -- a throw during
// flush must leave both the file and the in-memory list exactly as they were.
//
// A full store REFUSES; it never evicts. Dropping the oldest preset to make
// room for a new one would silently destroy one somebody built on purpose.
//
// Reading SANITISES rather than throws. The file is small and hand-editable,
// and a corrupt one blocks every later write rather than being silently
// replaced with an empty list.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MODEL_RE, EFFORT_RE } from './requests.mjs'

export const TEMPLATES_MAX = 50
export const TPL_NAME_MAX = 60
export const TPL_PROMPT_MAX = 20_000
export const TPL_SKILLS_MAX = 20
export const TPL_TOOLS_MAX = 20

/** A template's id becomes a filename and, once it carries a persona, an
 *  agent name -- so it is validated the same way a request's slug is. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// Control characters are stripped, not escaped -- these strings reach a JSON
// file, a picker row and, for prompt/agentDef, a generated markdown file.
// \t, \n and \r survive in prompt and agentDef: a multi-line kickoff or
// persona is the normal case.
const CONTROL_ALL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
const CONTROL_LINE = /[\x00-\x1f\x7f]/g

const cleanLine = (v, max) => (typeof v === 'string' ? v.replace(CONTROL_LINE, '').trim().slice(0, max) : '')
const cleanBlock = (v, max) => (typeof v === 'string' ? v.replace(CONTROL_ALL, '').trim().slice(0, max) : '')

/** Trimmed, non-empty, deduplicated, capped. A non-array (or absent) field
 *  becomes an empty list rather than a refusal -- skills and allowedTools are
 *  both optional. */
const cleanList = (raw, max) => {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const v of raw) {
    const s = cleanLine(v, 200)
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= max) break
  }
  return out
}

/** Slugify `name` into a candidate id, then uniquify against `taken` with a
 *  numeric suffix -- the same shape requests.mjs's slugify uses, but against
 *  SLUG_RE's 49-character bound rather than a bare kebab-case. */
const slugFor = (name, taken) => {
  let base = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 49).replace(/-+$/, '')
  if (!base || !/^[a-z0-9]/.test(base)) base = 'template' + (base ? '-' + base.replace(/^-+/, '') : '')
  base = base.slice(0, 49).replace(/-+$/, '')
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) {
    const suffix = '-' + n
    const candidate = base.slice(0, 49 - suffix.length).replace(/-+$/, '') + suffix
    if (!taken.includes(candidate)) return candidate
  }
}

/** One stored template, normalised, or null if it is not one.
 *
 *  `prompt` is the only required field: a preset with nothing to kick a
 *  session off with is not a preset. Unknown fields are KEPT -- the file is
 *  hand-editable, and a note somebody added by hand must survive the next
 *  write.
 *
 *  `id`, `order`, `createdAt` and `updatedAt` are identity and bookkeeping,
 *  not content: sanitizeTemplate fills them in when they are missing or
 *  malformed rather than refusing the whole record, since a hand-edited file
 *  legitimately omits them. `create`/`update` below are what actually decide
 *  a NEW id or a NEW order for a fresh record. */
export const sanitizeTemplate = (raw, fallbackOrder = 0) => {
  if (!isPlainObject(raw)) return null
  const prompt = cleanBlock(raw.prompt, TPL_PROMPT_MAX)
  if (!prompt) return null
  const id = typeof raw.id === 'string' && SLUG_RE.test(raw.id) ? raw.id : ''
  if (!id) return null
  const name = cleanLine(raw.name, TPL_NAME_MAX) || id
  const model = typeof raw.model === 'string' && MODEL_RE.test(raw.model.trim()) ? raw.model.trim() : null
  const effort = typeof raw.effort === 'string' && EFFORT_RE.test(raw.effort.trim()) ? raw.effort.trim() : null
  const agentDef = cleanBlock(raw.agentDef, TPL_PROMPT_MAX) || null
  const createdAt = Number(raw.createdAt)
  const updatedAt = Number(raw.updatedAt)
  const order = Number(raw.order)
  return {
    ...raw,
    id,
    name,
    prompt,
    model,
    effort,
    skills: cleanList(raw.skills, TPL_SKILLS_MAX),
    allowedTools: cleanList(raw.allowedTools, TPL_TOOLS_MAX),
    agentDef,
    order: Number.isFinite(order) ? order : fallbackOrder,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : fallbackOrder,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : createdAt,
  }
}

const sortTemplates = (items) => [...items].sort((a, b) => a.order - b.order)

/** A missing file is the normal first-run case. A file that exists but is
 *  corrupt degrades to "no templates" here and is moved aside by the next
 *  write, never silently overwritten. */
export const readTemplates = (file) => {
  let doc
  try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch { return [] }
  const raw = Array.isArray(doc?.items) ? doc.items : []
  const out = []
  for (let i = 0; i < raw.length; i++) {
    const t = sanitizeTemplate(raw[i], i)
    if (t) out.push(t)
  }
  return sortTemplates(out)
}

const corrupt = (file) => {
  if (!existsSync(file)) return false
  try { JSON.parse(readFileSync(file, 'utf8')); return false } catch { return true }
}

/** `createTemplates({ file, now })`.
 *
 *  A corrupt file BLOCKS WRITES: `readTemplates` cannot tell "genuinely
 *  empty" from "unreadable", so the load below re-checks with `corrupt()` and
 *  records the failure on the store itself. Every mutator then refuses,
 *  naming the file, rather than flushing a fresh (empty) list over the only
 *  copy of whatever the file actually held. */
export const createTemplates = ({ file, now = Date.now }) => {
  const readFailed = corrupt(file)
  let items = readFailed ? [] : readTemplates(file)

  const flush = (next = items) => {
    const body = JSON.stringify({ version: 1, items: next }, null, 2)
    const tmp = file + '.tmp'
    try {
      mkdirSync(dirname(file), { recursive: true })
      if (corrupt(file)) {
        // NOT swallowed: if the aside cannot be made, falling through to the
        // rename would destroy the very file the aside was protecting.
        const aside = file + '.corrupt-' + now()
        renameSync(file, aside)
        console.error(`agent-templates: ${file} would not parse; moved aside to ${aside}`)
      }
      writeFileSync(tmp, body)
      renameSync(tmp, file)
    } catch (err) {
      try { unlinkSync(tmp) } catch {}
      throw err
    }
  }

  const get = (id) => items.find((t) => t.id === id) ?? null

  return {
    all: () => items,
    get,

    /** `{ name, prompt, model?, effort?, skills?, allowedTools?, agentDef? }`.
     *  `id`, `order`, `createdAt` and `updatedAt` are the store's to assign:
     *  a caller-supplied id could collide with another template's, and a
     *  caller-supplied order could reorder somebody else's list. Returns
     *  `{ ok: true, template }` or `{ ok: false, error }` -- never throws for
     *  a refusal, because the reason reaches whoever is filling in the form. */
    create(fields = {}) {
      if (readFailed) return { ok: false, error: `${file} would not parse; refusing to write until it is fixed by hand` }
      const f = isPlainObject(fields) ? fields : {}
      const prompt = cleanBlock(f.prompt, TPL_PROMPT_MAX)
      if (!prompt) return { ok: false, error: 'a prompt is required' }
      if (items.length >= TEMPLATES_MAX) return { ok: false, error: 'too many templates' }
      if (f.model != null && f.model !== '' && !MODEL_RE.test(String(f.model).trim())) {
        return { ok: false, error: `unknown model ${JSON.stringify(f.model)}` }
      }
      if (f.effort != null && f.effort !== '' && !EFFORT_RE.test(String(f.effort).trim())) {
        return { ok: false, error: `unknown effort ${JSON.stringify(f.effort)}` }
      }
      const name = cleanLine(f.name, TPL_NAME_MAX) || 'untitled'
      const taken = items.map((t) => t.id)
      const id = typeof f.id === 'string' && SLUG_RE.test(f.id) && !taken.includes(f.id) ? f.id : slugFor(name, taken)
      const t = now()
      // Dense and ascending: `items` is always ordered 0..items.length-1 (see
      // remove() and reorder()), so appending at `items.length` both goes
      // last and keeps the sequence with no gap.
      const order = items.length
      const template = sanitizeTemplate({
        ...f,
        id,
        name,
        prompt,
        createdAt: t,
        updatedAt: t,
        order,
      }, order)
      if (!template) return { ok: false, error: 'invalid template' }
      const next = sortTemplates([...items, template])
      flush(next)
      items = next
      return { ok: true, template }
    },

    /** Merge a patch into a template. `id`, `createdAt` and `order` are never
     *  taken from the patch -- a forged id could hijack another record, and a
     *  forged order could reorder the whole list from an edit dialog meant to
     *  rename one row. */
    update(id, patch = {}) {
      const cur = get(id)
      if (!cur) return { ok: false, error: 'no such template' }
      const p = isPlainObject(patch) ? patch : {}
      if (p.model != null && p.model !== '' && !MODEL_RE.test(String(p.model).trim())) {
        return { ok: false, error: `unknown model ${JSON.stringify(p.model)}` }
      }
      if (p.effort != null && p.effort !== '' && !EFFORT_RE.test(String(p.effort).trim())) {
        return { ok: false, error: `unknown effort ${JSON.stringify(p.effort)}` }
      }
      const { id: _i, createdAt: _c, order: _o, ...rest } = p
      const merged = sanitizeTemplate({ ...cur, ...rest, id: cur.id, createdAt: cur.createdAt, order: cur.order, updatedAt: now() }, cur.order)
      if (!merged) return { ok: false, error: 'invalid template' }
      const next = sortTemplates(items.map((t) => (t.id === id ? merged : t)))
      flush(next)
      items = next
      return { ok: true, template: merged }
    },

    remove(id) {
      const filtered = items.filter((t) => t.id !== id)
      if (filtered.length === items.length) return false
      // Renumbered so `order` stays dense after the gap the removal left --
      // the next create() appends at `items.length` and relies on it.
      const next = sortTemplates(filtered).map((t, i) => ({ ...t, order: i }))
      flush(next)
      items = next
      return true
    },

    /** An explicit order for every id in the store. Anything short of a full
     *  permutation refuses whole, because a half-applied reorder is worse
     *  than none. Every entry whose `order` changes is replaced with a NEW
     *  object, never mutated in place. */
    reorder(ids) {
      if (!Array.isArray(ids) || ids.length !== items.length) return false
      const found = ids.map((id) => get(String(id)))
      if (found.some((t) => !t)) return false
      if (new Set(ids).size !== ids.length) return false
      const changed = new Map(found.map((t, i) => [t.id, { ...t, order: i }]))
      const next = sortTemplates(items.map((t) => changed.get(t.id) ?? t))
      flush(next)
      items = next
      return true
    },

    flush,
  }
}

/** The kickoff a spawn actually sends: the prompt, trimmed, plus -- when the
 *  template names skills -- one line pointing a session at them. A skill
 *  list on its own says nothing to the model; the sentence is what makes it
 *  reach for one. */
export const renderKickoff = (tpl) => {
  const prompt = String(tpl?.prompt ?? '').trim()
  const skills = Array.isArray(tpl?.skills) ? tpl.skills : []
  if (!skills.length) return prompt
  return prompt + '\n\nUse these skills: ' + skills.join(', ')
}

// ---- the generated personas plugin -------------------------------------
//
// A template with a persona (`agentDef`) becomes a real agent, so a spawn can
// name it on `--agent` and have the CLI load it as a system prompt instead of
// the relay pasting it into the kickoff every time. The plugin housing them
// is GENERATED and owned entirely by this process -- nothing under it is
// ever hand-edited, which is what makes deleting and rewriting it whole, on
// every change, safe.

export const AGENT_PLUGIN_NAME = 'syzygy-agents'

const yamlDouble = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

/** `{ $schema, name, version, description, author }`. `author` is not
 *  decoration: strict validation refuses a manifest without one. `version`
 *  is derived from the template count and the newest `updatedAt` in the set,
 *  so a changed set of personas is a changed version rather than a manifest
 *  that looks unchanged after a real edit. */
export const manifestFor = (templates) => {
  const list = Array.isArray(templates) ? templates : []
  const newest = list.reduce((max, t) => Math.max(max, Number(t?.updatedAt) || 0), 0)
  return {
    $schema: 'https://anthropic.com/claude-code/plugin.schema.json',
    name: AGENT_PLUGIN_NAME,
    version: `0.${list.length}.${newest}`,
    description: 'Session presets generated from Syzygy templates -- never hand-edited.',
    author: { name: 'adenineio' },
  }
}

/** The agent name a spawn passes to `--agent`, or null when the template has
 *  no persona to load. */
export const agentNameFor = (tpl) => {
  const def = typeof tpl?.agentDef === 'string' ? tpl.agentDef.trim() : ''
  return def ? `${AGENT_PLUGIN_NAME}:${tpl.id}` : null
}

/** What a template adds to a spawn's argv: `{ agent, allowedTools, skipped }`.
 *
 *  `agent` is named only when the CLI's own roster already lists it. A name
 *  the roster lacks is never passed on a guess -- the CLI's answer to an
 *  unknown `--agent` is a warning on stdout that nothing reads, and the
 *  session would start without its persona while looking as if it had one.
 *  So a persona that cannot be selected comes back as `skipped`, for the
 *  caller to report. An empty roster (the probe failed) skips every persona.
 *
 *  `personas: false` is the setting switched off: no agent is selected and
 *  nothing is reported as skipped, because nothing was asked for.
 *
 *  `allowedTools` is ONE space-joined string, or null when the template names
 *  none: `--allowedTools` is variadic, and one element per tool would swallow
 *  whatever follows it on the argv. */
export const templateArgv = (tpl, { roster = [], personas = true } = {}) => {
  const tools = (Array.isArray(tpl?.allowedTools) ? tpl.allowedTools : []).filter(Boolean)
  const allowedTools = tools.length ? tools.join(' ') : null
  if (personas === false) return { agent: null, allowedTools, skipped: null }
  const want = agentNameFor(tpl)
  const list = Array.isArray(roster) ? roster : []
  const agent = want && list.includes(want) ? want : null
  const skipped = want && !agent ? want : null
  return { agent, allowedTools, skipped }
}

/** One generated agent file: frontmatter naming the agent and describing it
 *  as a session preset, then the persona verbatim. **No `model:`** -- the
 *  argv carries the model, and a value baked into the agent file would
 *  silently outlive a template whose model is edited later. **No `tools:`**
 *  -- that key narrows the agent's tool set, and a session started FROM this
 *  preset is a whole session, never a delegation target whose tools should
 *  be amputated. */
export const agentFileFor = (tpl) => {
  const id = tpl?.id ?? ''
  const name = String(tpl?.name ?? id).replace(/[\r\n]+/g, ' ').trim()
  const description = `Syzygy session preset "${name}" — started as a whole session, not a delegation target.`
  const front = ['---', `name: ${id}`, `description: ${yamlDouble(description)}`, '---', ''].join('\n')
  return front + String(tpl?.agentDef ?? '').trim() + '\n'
}

let stagingSeq = 0

/** A directory that does not exist yet is nobody's; an EMPTY one is free to
 *  claim (there is nothing in it to lose); anything else must already carry
 *  this plugin's own manifest, or it is somebody else's and is refused
 *  untouched. */
const ownsDir = (dir, fs) => {
  if (!fs.existsSync(dir)) return { ok: true }
  let entries
  try { entries = fs.readdirSync(dir) } catch (err) { return { ok: false, error: `${dir}: ${err.message}` } }
  if (entries.length === 0) return { ok: true }
  const manifestPath = join(dir, '.claude-plugin', 'plugin.json')
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `${dir} is not empty and carries no ${AGENT_PLUGIN_NAME} manifest -- not ours to overwrite` }
  }
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch (err) {
    return { ok: false, error: `${manifestPath} would not parse -- not ours to overwrite (${err.message})` }
  }
  if (manifest?.name !== AGENT_PLUGIN_NAME) {
    return { ok: false, error: `${dir} belongs to a plugin named ${JSON.stringify(manifest?.name)}, not ${AGENT_PLUGIN_NAME} -- not ours to overwrite` }
  }
  return { ok: true }
}

/** Generate the personas plugin from every template carrying an `agentDef`,
 *  validate it before it lands, and swap it into place -- or roll the whole
 *  write back.
 *
 *  Nothing is written directly into `dir`. A fresh build goes into a SIBLING
 *  scratch directory first -- never `os.tmpdir()`, because `rename` across
 *  filesystems is not atomic and `dir`'s parent may not share one with
 *  `/tmp` -- and only a validation that PASSES gets swapped in. A validation
 *  that fails removes the scratch directory and leaves `dir` exactly as it
 *  was: nothing in `dir` was ever touched, which is the whole of "rolls
 *  back" here.
 *
 *  With no `claudeBin` there is nothing to validate WITH -- a machine that
 *  cannot spawn `claude` cannot spawn a templated session either, so
 *  refusing the write would only hide the templates from a machine that will
 *  read them again once a binary is configured. */
export const writePersonas = async ({ templates, dir, run, fs: fsFacade, claudeBin }) => {
  const fs = fsFacade ?? { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync }
  const withPersona = (Array.isArray(templates) ? templates : []).filter((t) => agentNameFor(t))

  if (withPersona.length === 0) {
    if (fs.existsSync(dir)) {
      const owns = ownsDir(dir, fs)
      if (!owns.ok) return { ok: false, count: 0, error: owns.error }
      fs.rmSync(dir, { recursive: true, force: true })
    }
    return { ok: true, count: 0, error: null }
  }

  const owns = ownsDir(dir, fs)
  if (!owns.ok) return { ok: false, count: 0, error: owns.error }

  const staging = `${dir}.next-${process.pid}-${Date.now()}-${stagingSeq++}`
  fs.mkdirSync(join(staging, '.claude-plugin'), { recursive: true })
  fs.mkdirSync(join(staging, 'agents'), { recursive: true })
  fs.writeFileSync(join(staging, '.claude-plugin', 'plugin.json'), JSON.stringify(manifestFor(withPersona), null, 2))
  for (const t of withPersona) {
    fs.writeFileSync(join(staging, 'agents', `${t.id}.md`), agentFileFor(t))
  }

  const swap = () => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(staging, dir)
  }

  if (!claudeBin) {
    swap()
    return { ok: true, count: withPersona.length, error: null }
  }

  let out
  try { out = await run(claudeBin, ['plugin', 'validate', staging, '--strict']) } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true })
    return { ok: false, count: 0, error: String(err?.message ?? err) }
  }
  if (out?.code !== 0) {
    const error = String(out?.stderr || out?.stdout || `plugin validate exited ${out?.code}`).trim().slice(0, 2000)
    fs.rmSync(staging, { recursive: true, force: true })
    return { ok: false, count: 0, error }
  }
  swap()
  return { ok: true, count: withPersona.length, error: null }
}
