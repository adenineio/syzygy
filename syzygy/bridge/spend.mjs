// The platform's own model calls, one JSON line each, and the small digest
// of them that rides the snapshot. The relay is the only writer and writes
// synchronously, one line per call with O_APPEND, so no other write can
// interleave with it; the worst a crash leaves is a torn final line, which
// every reader skips and counts. Nothing is ever rewritten in place.
import { appendFileSync, readFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const KINDS = Object.freeze(['chain', 'pattern', 'orchestrator', 'scoping', 'liaison', 'band', 'other'])
export const SPEND_FILE = 'spend.jsonl'
export const SPEND_ROTATED = 'spend.1.jsonl'
export const ROTATE_LINES = 20_000
export const READ_LIMIT_DEFAULT = 50
export const READ_LIMIT_MAX = 200
const SITE_RE = /^[a-z_]{1,32}$/
const MODEL_MAX = 64
const WEEK_MS = 7 * 86_400_000

export const normalizeKind = (k) => (KINDS.includes(k) ? k : 'other')
/** Four characters a token: only for a call whose usage nobody reports. */
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 4)
export const argvModel = (argv) => {
  const i = Array.isArray(argv) ? argv.indexOf('--model') : -1
  return i >= 0 && i + 1 < argv.length ? String(argv[i + 1]) : ''
}
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
const money = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

export const sanitizeRecord = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const u = raw.usage && typeof raw.usage === 'object' ? raw.usage : {}
  return {
    t: Number.isFinite(raw.t) ? raw.t : 0,
    kind: normalizeKind(raw.kind),
    site: typeof raw.site === 'string' && SITE_RE.test(raw.site) ? raw.site : '',
    model: typeof raw.model === 'string' ? raw.model.slice(0, MODEL_MAX) : '',
    usd: money(raw.usd),
    usage: { input: count(u.input), output: count(u.output), cacheCreate: count(u.cacheCreate), cacheRead: count(u.cacheRead) },
    durationMs: Number.isFinite(raw.durationMs) && raw.durationMs >= 0 ? Math.round(raw.durationMs) : null,
    estimated: raw.estimated === true,
    noResult: raw.noResult === true,
    error: raw.error === true,
  }
}

/** A record from a headless child's final `result` event, the CLI's own
 *  figures. A child that printed none still spent: it records with no cost. */
export const resultRecord = ({ kind, site, model = '', frame = null, startedAt = null, now = Date.now() }) => {
  const f = frame && typeof frame === 'object' && !Array.isArray(frame) ? frame : null
  const u = f?.usage ?? {}
  return sanitizeRecord({
    kind, site, model,
    usd: f ? f.total_cost_usd : null,
    usage: { input: u.input_tokens, output: u.output_tokens, cacheCreate: u.cache_creation_input_tokens, cacheRead: u.cache_read_input_tokens },
    durationMs: Number.isFinite(f?.duration_ms) ? f.duration_ms : (Number.isFinite(startedAt) ? now - startedAt : null),
    noResult: !f,
    error: !!f && (f.is_error === true || (typeof f.subtype === 'string' && f.subtype !== 'success')),
  })
}

export const tokensOf = (r) => r.usage.input + r.usage.output + r.usage.cacheCreate + r.usage.cacheRead
export const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }

const round4 = (x) => Math.round(x * 1e4) / 1e4
const emptyWindow = () => ({ calls: 0, usd: 0, tokens: 0, byKind: {} })
const addTo = (w, x) => {
  const b = w.byKind[x.k] ?? (w.byKind[x.k] = { calls: 0, usd: 0, tokens: 0 })
  for (const o of [w, b]) { o.calls += 1; o.usd += x.usd ?? 0; o.tokens += x.tok }
}
const finish = (w) => { w.usd = round4(w.usd); for (const b of Object.values(w.byKind)) b.usd = round4(b.usd); return w }

/** The digest, pure. `today` is the local calendar day, `week` a rolling
 *  seven days, `all` everything on disk from `since`. */
export const digestOf = (tuples, now, skipped = 0) => {
  const today = emptyWindow(), week = emptyWindow(), all = emptyWindow()
  const t0 = dayStart(now), w0 = now - WEEK_MS
  let since = null, updatedAt = null, est = 0, unreported = 0
  for (const x of tuples) {
    addTo(all, x)
    if (x.t >= w0) addTo(week, x)
    if (x.t >= t0) addTo(today, x)
    if (since === null || x.t < since) since = x.t
    if (updatedAt === null || x.t > updatedAt) updatedAt = x.t
    if (x.est) est += 1
    if (x.nr) unreported += 1
  }
  return {
    today: finish(today), week: finish(week), all: finish(all), since, updatedAt,
    estimatedShare: all.calls ? Math.round((est / all.calls) * 100) / 100 : 0, unreported, skipped,
  }
}

export const createSpend = ({ dir, now = Date.now, onChange = () => {} } = {}) => {
  const file = join(dir, SPEND_FILE)
  const rotated = join(dir, SPEND_ROTATED)
  let older = [], current = [], lines = 0, skipped = 0, lastT = 0
  const tupleOf = (r) => ({ t: r.t, k: r.kind, usd: r.usd, tok: tokensOf(r), est: r.estimated, nr: r.noResult })
  // Calls `each(record)` per readable line and `each(null)` per unreadable
  // one; answers how many non-blank lines there were.
  const scan = (path, each) => {
    let text = ''
    try { text = readFileSync(path, 'utf8') } catch { return 0 }
    let n = 0
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      n += 1
      let r = null
      try { r = sanitizeRecord(JSON.parse(line)) } catch {}
      each(r && r.t > 0 ? r : null)
    }
    return n
  }
  scan(rotated, (r) => { if (r) older.push(tupleOf(r)); else skipped += 1 })
  lines = scan(file, (r) => { if (r) current.push(tupleOf(r)); else skipped += 1 })
  for (const x of older) if (x.t > lastT) lastT = x.t
  for (const x of current) if (x.t > lastT) lastT = x.t

  const digest = () => digestOf(older.concat(current), now(), skipped)

  /** Sanitises, stamps a strictly increasing `t`, appends, rotates past
   *  ROTATE_LINES. Answers the record, or null when nothing was written. */
  const record = (raw) => {
    const r = sanitizeRecord(raw)
    if (!r) return null
    r.t = Math.max(now(), lastT + 1)
    try {
      mkdirSync(dir, { recursive: true })
      if (lines >= ROTATE_LINES) { renameSync(file, rotated); older = current; current = []; lines = 0 }
      appendFileSync(file, JSON.stringify(r) + '\n')
    } catch (e) {
      process.stderr.write(`spend: a call was not recorded: ${e?.message ?? e}\n`)
      return null
    }
    lastT = r.t
    lines += 1
    current.push(tupleOf(r))
    try { onChange(digest()) } catch (e) { process.stderr.write(`spend: onChange threw: ${e?.stack || e}\n`) }
    return r
  }

  /** Newest first, read off disk: the call list is opened by hand, rarely. */
  const read = ({ kind = '', since = NaN, before = NaN, limit = NaN } = {}) => {
    const n = Number.isFinite(limit) && limit > 0 ? Math.min(READ_LIMIT_MAX, Math.floor(limit)) : READ_LIMIT_DEFAULT
    if (kind && !KINDS.includes(kind)) return { items: [], next: null }
    const hits = []
    const take = (r) => {
      if (!r || (kind && r.kind !== kind)) return
      if (Number.isFinite(since) && r.t < since) return
      if (Number.isFinite(before) && r.t >= before) return
      hits.push(r)
    }
    scan(rotated, take)
    scan(file, take)
    hits.sort((a, b) => b.t - a.t)
    const items = hits.slice(0, n)
    return { items, next: hits.length > n ? items[items.length - 1].t : null }
  }

  return { record, digest, read }
}
