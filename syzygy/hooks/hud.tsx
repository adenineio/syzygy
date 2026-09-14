// Syzygy — an ambient agent surface built from function hooks.
//
// Three surfaces, one state:
//   on('*')          collects facts as events go by; never blocks the chain
//   on('ui.render')  the AbovePrompt band — a pure projection of that state
//   the bridge       a local relay + browser pane, fed by $.http, steered back
//                    through a command queue this plugin polls on $.clock.every
//
// Registered tools give the model an action space of its own: ask_human,
// note/recall, think_harder, calc.
//
// Where the numbers come from
//   tokens/context  the session's own transcript JSONL, read incrementally by
//                   byte offset. `turn.complete` carries no usage (its fields
//                   are answer/durationMs/aborted/turnId/reason) and the only
//                   usage on the API is the Agent tool's result, which covers
//                   subagents alone. The transcript is where the main thread's
//                   real counts live.
//   $ spend         those counts priced by PRICES below. Prices are not an API
//                   surface; edit them when they change.
//   branch/diff     git, via $.process.run.
//   guardrails      tool calls that came back denied, seen on the '*' hook.

import type { EngineInterface, Elements, Register, RenderInput, TurnCompleteInput } from 'claude-code'
import { SPINNERS, TINT } from './spinner-frames.js'
import type { Cell, Row, SpinnerDef } from './spinner-frames.js'

type Dollar = EngineInterface
type Terminal = Elements['terminal']

// ---------------------------------------------------------------- constants

/** USD per million tokens. Not an API surface — keep in step with pricing. */
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-fable-5-1': { in: 10, out: 50 },
  'claude-fable-5': { in: 10, out: 50 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
}
const FALLBACK_PRICE = PRICES['claude-opus-5']!
const CACHE_READ_RATIO = 0.1
const CACHE_WRITE_5M_RATIO = 1.25
const CACHE_WRITE_1H_RATIO = 2.0

const CONTEXT_LIMIT = 200_000
const CONTEXT_LIMIT_1M = 1_000_000

/** The context window per model, keyed by `modelKey()`'s normalised form.
 *
 *  Nothing on `$` reports the window: `$.session.model()` returns a label and
 *  the transcript records an id, neither of which names it. So this table is an
 *  ASSUMPTION, and the two things that can actually observe the window both
 *  outrank it -- the statusline reading in `readStatusline()`, and the "ctx is
 *  already past the assumed limit" floor in `refresh()`. Keep it in step with
 *  the model line-up the way PRICES above is kept in step with pricing.
 *
 *  Before this table the only signal was `[1m]` in the label, so every session
 *  opened at 200k and corrected itself only after blowing past it -- which read
 *  as wrong for the whole first half of a long session. */
const CONTEXT_WINDOWS: Record<string, number> = {
  'fable-5-1': CONTEXT_LIMIT_1M,
  'fable-5': CONTEXT_LIMIT_1M,
  'opus-5': CONTEXT_LIMIT_1M,
  'sonnet-5': CONTEXT_LIMIT_1M,
  'opus-4-8': CONTEXT_LIMIT,
  'opus-4-7': CONTEXT_LIMIT,
  'opus-4-6': CONTEXT_LIMIT,
  'sonnet-4-6': CONTEXT_LIMIT,
  'haiku-4-5': CONTEXT_LIMIT,
}

/** Windows a derived reading is snapped to, so arithmetic noise never shows as
 *  a meter reading `0.98M`. */
const KNOWN_WINDOWS = [200_000, 500_000, CONTEXT_LIMIT_1M]
/** How far off a known window a derived reading may be and still snap to it.
 *  Outside every band the reading is rounded instead of snapped, so a window
 *  this build has never heard of still reports as itself. */
const SNAP_TOLERANCE = 0.25
/** Below this much of the window used, the statusline percentage is too coarse
 *  to divide by -- at 4% one integer point moves the derived limit by a
 *  quarter. Under it the table is the better answer. */
const STATUSLINE_MIN_PCT = 5
/** How old a DERIVED reading may be. Claude Code re-invokes the status line
 *  constantly, so a stale file means it stopped running (a `--bg` session has
 *  no status line to draw) -- and a frozen percentage divided into a still
 *  growing ctx would read as an ever-shrinking window. */
const STATUSLINE_MAX_AGE_MS = 120_000
/** How old a STATED window may be, which is far more forgiving on purpose: a
 *  percentage goes stale the moment the session keeps working, but the size of
 *  the window it was given does not change underneath it. An idle session whose
 *  status line has not redrawn in an hour still knows its own window. */
const STATUSLINE_STATED_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Where the statusline wrapper drops what Claude Code pipes it. Beside
 *  `world.json`, under the relay's existing directory. */
const STATUSLINE_DIR = '.claude/syzygy/statusline'

/** The band flips to a warning after this many edits to one file in a session. */
const STUCK_EDITS = 5
/** …or this many consecutive failing tool calls. */
const STUCK_ERRORS = 3

/** A chain record's prompt and answer are each cut to this many characters:
 *  enough to say what a turn was about, never the whole text. */
const CHAIN_HEAD_MAX = 400
/** Prompts remembered while they wait for the turn that works on them. One that
 *  starts no turn ages out of this rather than piling up. */
const CHAIN_PENDING_MAX = 8

/** One narration line per turn, on the small fast model, off the render path.
 *  Set false for a build that makes no model calls at all. */
const NARRATE = true

/** A short tone on each tool call and a chime on a clean turn. Off by default:
 *  it is charming for ten minutes and grating for an hour. */
const SONIFY = false

/** The relay port a session uses when nothing tells it otherwise. `SZG_RELAY_PORT`
 *  in the environment overrides it into `M.relayPort` at session.start -- which
 *  is how a session SPAWNED by a relay registers with the relay that spawned it
 *  rather than with the one on this port. Nothing else may read this constant:
 *  read `M.relayPort`, or a session started from a canvas on another port
 *  silently joins the wrong board. */
const RELAY_PORT_DEFAULT = 4317
const RELAY_HOST = '127.0.0.1'
/** How often the band re-asks tmux whether the side pane is still there. The
 *  button flips its own label optimistically on a press; this only has to catch
 *  a pane the user closed by hand. */
const PANE_CHECK_MS = 4000
const PUSH_MS = 1200
const POLL_MS = 900
const ASK_TIMEOUT_MS = 60_000
const SEEN_CAP = 4000
const EVENT_CAP = 60

/** The spinner tick. `$.ui.invalidate` folds calls closer than 100 ms, so this
 *  is the real ceiling; each spinner divides it with its own `every`. */
const SPIN_MS = 100
/** `tide` because it is the modest one: two rows, a caption below it, and a
 *  one-row badge fallback under 24 columns. A default has to be the spinner
 *  that costs the least room, not the one that shows the most. */
const DEFAULT_SPINNER = 'tide'

/** The context meter, six steps. It replaced an 8-26 column block bar: the
 *  `94k / 1.0M` and the `%` beside it already carry the precision, so the bar
 *  was spending a quarter of the line to repeat them.
 *
 *  **Both sets run FULL to EMPTY as context is consumed**, so the glyph is a
 *  gauge of what is LEFT while the numbers beside it count what is used. An
 *  untouched session shows a full moon and a drained one shows a new moon --
 *  depletion, the way a fuel gauge reads, not a pie filling up.
 *
 *  The moons are therefore the WANING sequence (🌕🌖🌗🌘🌑), whose lit face
 *  shrinks; the waxing glyphs (🌒🌓🌔) are their mirror images and would run
 *  the wrong way.
 *
 *  Two sets because one column is one cell and `circle` is therefore small --
 *  genuinely small, not just modest. `moon` is the same six steps drawn at
 *  emoji size, twice the cell width and several times the ink. Anything that
 *  measures a row must ask `displayWidth`, never `.length`: a moon is one code
 *  point and two columns, and the warning glyph is two columns on ONE.
 *
 *  The steps are a THRESHOLD TABLE, not a rounded fraction. Rounding put the
 *  dark moon past 87%, which is long after the answers have started to drift.
 *  The table carries the colour beside the glyph so the two cannot part. */
export type PieStep = {
  /** The lowest fraction USED that shows this step. */
  from: number
  moon: string
  circle: string
  pressure: 'green' | 'yellow' | 'red'
}

/** ASCENDING by `from` -- `pieStep` scans it in order and keeps the last match,
 *  so a row out of place silently answers the wrong glyph. */
export const PIE_STEPS: readonly PieStep[] = [
  { from: 0, moon: '🌕', circle: '●', pressure: 'green' },
  { from: 0.20, moon: '🌖', circle: '◕', pressure: 'green' },
  { from: 0.35, moon: '🌗', circle: '◑', pressure: 'green' },
  // Half a window is where the answers start to drift, and the user runs past
  // it almost every time, so the crescent arrives here and HOLDS to two thirds
  // rather than stepping again: a glyph that stops moving is the warning.
  { from: 0.50, moon: '🌘', circle: '◔', pressure: 'yellow' },
  { from: 0.66, moon: '🌑', circle: '○', pressure: 'red' },
  // Not a phase. The gauge has nothing left to say, so it stops being a gauge.
  { from: 0.75, moon: '❗', circle: '!', pressure: 'red' },
]

/** Every glyph the band draws that occupies TWO cells, derived from the table
 *  so a step added later is measured right without anyone remembering a second
 *  list. `displayWidth` is the only measure the one-row fit ladder has. */
const WIDE_GLYPHS = new Set(PIE_STEPS.map((s) => s.moon))

/** VARIATION SELECTOR-16, appended to every moon to demand emoji presentation.
 *
 *  Without it the full moon alone can render as a plain monochrome circle, and
 *  the reason is worth recording because it looks like a bug in this code:
 *  `Noto Sans Symbols 2` contains **U+1F315 and none of the other four
 *  phases**, so a font stack listing it ahead of the colour emoji font
 *  resolves exactly one glyph of five to a black-and-white outline, and a
 *  font stack that lists a symbols font ahead of the colour emoji font is an
 *  ordinary thing for a terminal to be configured with.
 *
 *  VS16 is the standard way to ask for the colour form, so fixing it here
 *  fixes it for every font stack rather than asking each user to patch their
 *  terminal. It is zero-width and `displayWidth` must skip it. */
const VS16 = '\uFE0F'
const SPARK = '▁▂▃▄▅▆▇█'
/** Columns the throughput sparkline gets. Deliberately small: it shares the
 *  vitals row with the model, the branch and the diff now, and it is the first
 *  thing that row drops. */
const TREND_WIDTH = 8

// ------------------------------------------------------------------- hotkeys

/** A band Button's hotkey must be a single DIGIT -- `ButtonProps.hotkey` says
 *  "Letters are refused" -- so there are exactly ten, forever, and every one
 *  spent here is one no other feature can have.
 *
 *  `1` and `4` are built in and fixed. The remaining eight are the user's,
 *  which is why they are listed in display order rather than derived: `0` reads
 *  last on a keyboard even though it sorts first. */
const HOTKEY_PANE = '1'
const HOTKEY_NARRATE = '4'
const HOTKEY_SLOTS = ['2', '3', '5', '6', '7', '8', '9', '0']
/** Display order for the whole row, built-ins included. */
const HOTKEY_ORDER = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
/** How long a pasteboard notice holds the band's notice row. */
const NOTICE_MS = 20_000

/** Read from `~/.claude/<file>` and then `<worktree root>/.claude/<file>`, the
 *  project copy overriding the global one slot by slot. */
const HOTKEYS_FILE = 'syzygy-hud-hotkeys.json'

type Hotkey = { key: string; title: string; short: string; prompt: string }

/** Band settings, from the same file as the hotkeys and merged the same way.
 *
 *  They live in config rather than behind a hotkey because there is no hotkey
 *  left to spend: all ten digits are the pane, `what now?` and the eight
 *  prompt slots.
 *
 *  `spinner` is optional on purpose: its ABSENCE is meaningful (see
 *  `resolveSpinnerId`) and distinct from every real id, so it cannot be typed
 *  as `string` with a sentinel default the way `pieStyle` is. */
type BandSettings = {
  spinnerPicker: boolean
  pieStyle: 'moon' | 'circle'
  spinner?: string
  /** The leading token that turns a submitted prompt into a pasteboard entry
   *  instead. NOT optional: the empty string is a real, meaningful value (the
   *  feature off), which is exactly what `spinner`'s absence means for the
   *  spinner and is why that one IS optional. */
  pasteboardMarker: string
}

/** The spinner picker is OFF by default: it is a thing you set once and then
 *  look at forever, and it was costing a permanent row of the band. `spinner`
 *  has no default here -- omitting the key is how the file says "I have no
 *  opinion", which `resolveSpinnerId` reads as "defer to $.store". */
const DEFAULT_SETTINGS: BandSettings = { spinnerPicker: false, pieStyle: 'moon', pasteboardMarker: ',,' }

/** What ships when no config file exists. Two of the eight slots are filled;
 *  the rest stay empty until somebody writes them.
 *
 *  `step back` was a stuck-row special before this -- it was only ever a
 *  prompt, so it became an ordinary, editable slot instead of a second thing
 *  to maintain. */
const DEFAULT_HOTKEYS: Hotkey[] = [
  {
    key: '2',
    title: 'my next steps',
    short: 'next',
    prompt:
      'What are MY next action steps here to move forward (things needing my review, ' +
      'or testing, configuring, or any other manual action I must take to have this ' +
      'session keep moving forward)',
  },
  {
    key: '3',
    title: 'step back',
    short: 'back',
    prompt:
      'Step back for a moment: am I solving the right problem here, and is there a ' +
      'simpler route to the actual goal? Answer in three sentences before continuing.',
  },
]

// -------------------------------------------------------------- needs-me

/** Classify each finished turn for "this one is waiting on the user". Off
 *  turns the classification off entirely, the way NARRATE does for narration. */
const NEEDS_ME = true

/** How much of the answer's tail is examined.
 *
 *  The TAIL, not the whole answer, and that is the point: an agent that writes
 *  "let me know if that breaks" in the middle of a report and then carries on
 *  working is not waiting on anybody. What a turn hands back is at its end. */
const NEEDS_TAIL = 400

/** The longest reason shown on a card. */
const NEEDS_MAX = 140

/** How much of a finished turn's answer the drawer gets to show.
 *
 *  2 KB: enough for a normal reply whole, and small enough that it rides on the
 *  once-a-second /api/stats push without making the board's payload a transcript
 *  mirror. The pane is not a transcript viewer and must not become one -- the
 *  session's own scrollback is still where a full answer is read. */
const LAST_ANSWER_MAX = 2048

/** Prefixed when the cap actually bit, so a message starting mid-sentence reads
 *  as elision rather than as a truncation bug. */
const LAST_ANSWER_ELIDED = '…'

/** Ways a turn hands the work back, beyond ending on a question mark.
 *
 *  Deliberately a fixed list of phrases rather than `$.model.classify`. This
 *  runs at every turn boundary, and a classification call there would put a
 *  model in the hot path for something a phrase list answers exactly. */
const NEEDS_PHRASES: RegExp[] = [
  /\blet me know\b/i,
  /\bwould you like\b/i,
  /\bdo you want\b/i,
  /\bwant me to\b/i,
  /\bshould i\b/i,
  /\bshall i\b/i,
  /\bup to you\b/i,
  /\byour (call|review|approval|input|decision|say-so)\b/i,
  /\bneeds? your\b/i,
  /\bwaiting (on|for) you\b/i,
  /\b(please )?(confirm|approve|greenlight|sign off)\b/i,
  /\blet me know which\b/i,
]

/** How long a file must go untouched before its stuck signal lapses.
 *
 *  `s.files[path]` only ever increments, so without this the warning would
 *  latch on for the rest of the session. Clearing `s.errors` does not help:
 *  `detectStuck()` reads `s.files` and would re-raise the same signal on the
 *  next tick. Quiet is the only honest way out of it. */
const STUCK_COOL_MS = 120_000

// -------------------------------------------------------------------- state

type Ev = { kind: string; label: string; detail?: string; status?: string; ms?: number; t?: number; internal?: true }

type Hud = {
  sessionId: string
  startedAt: number
  ctx: number
  inTok: number
  outTok: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  guardrails: number
  tools: number
  errors: number
  modelId: string
  offset: number
  seen: string[]
  transcript: string | null
  files: Record<string, number>
  diff: { added: number; removed: number }
  narration: string
  throughput: number[]
}

const blank = (sessionId: string, now: number): Hud => ({
  sessionId,
  startedAt: now,
  ctx: 0,
  inTok: 0,
  outTok: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  guardrails: 0,
  tools: 0,
  errors: 0,
  modelId: '',
  offset: 0,
  seen: [],
  transcript: null,
  files: {},
  diff: { added: 0, removed: 0 },
  narration: '',
  throughput: [],
})

// --------------------------------------------------------------- formatting

const compact = (n: number): string => {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k < 100 ? k.toFixed(1) : Math.round(k)}k`
  }
  const m = n / 1_000_000
  return `${m < 100 ? m.toFixed(2) : Math.round(m)}M`
}

const money = (usd: number): string =>
  usd >= 100 ? `$${usd.toFixed(0)}` : usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`

const elapsed = (ms: number, precise: boolean): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (!precise) return h > 0 ? `${h}h ${m}m` : `${m}m`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}

const priceOf = (modelId: string): { in: number; out: number; exact: boolean } => {
  const hit = PRICES[modelId]
  if (hit) return { ...hit, exact: true }
  let best: string | null = null
  for (const key of Object.keys(PRICES)) {
    if (modelId.startsWith(key) && (best === null || key.length > best.length)) best = key
  }
  if (best) return { ...PRICES[best]!, exact: true }
  return { ...FALLBACK_PRICE, exact: false }
}

const spendOf = (s: Hud): { usd: number; exact: boolean } => {
  const p = priceOf(s.modelId)
  const usd =
    (s.inTok * p.in +
      s.outTok * p.out +
      s.cacheRead * p.in * CACHE_READ_RATIO +
      s.cacheWrite5m * p.in * CACHE_WRITE_5M_RATIO +
      s.cacheWrite1h * p.in * CACHE_WRITE_1H_RATIO) /
    1_000_000
  return { usd, exact: p.exact }
}

const shortModel = (label: string): string =>
  label.replace(/^claude-/, '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-(\d)$/, ' $1')

/** A block-glyph sparkline of the last values. */
const spark = (values: readonly number[], width: number): string => {
  if (values.length === 0) return ''
  const tail = values.slice(-width)
  const max = Math.max(...tail, 1)
  return tail.map((v) => SPARK[Math.min(7, Math.floor((v / max) * 7.999))]).join('')
}

/** Random glyphs settling into the real text over ~12 frames. */
const GLYPHS = '▚▞▛▜▙▟▖▗▘▝┃━╱╲╳◤◥◣◢'
const decrypt = (text: string, frame: number, since: number): string => {
  const age = frame - since
  if (age > 12) return text
  const settled = Math.floor((age / 12) * text.length)
  return text
    .split('')
    .map((c, i) => (i < settled || c === ' ' ? c : GLYPHS[(i * 7 + frame * 3) % GLYPHS.length]))
    .join('')
}

// ------------------------------------------------------- context window math
//
// Everything from here to the end of the hotkey section is pure and EXPORTED
// so `test/harness.mjs` can import it from the compiled module and assert it
// directly -- the same reason `spinner-frames.js` and `swarm-math.js` are split
// out, minus the split, because the harness already imports `build/hud.js`.
// The engine only ever reads `register`; the extra exports are inert to it.

/** One normal form for every spelling of a model this build sees: the
 *  transcript's `claude-opus-5`, `$.session.model()`'s label, and a display
 *  name like `fable 5.1` all land on the same key. */
export const modelKey = (name: string): string =>
  name.toLowerCase().trim().replace(/^claude-/, '').replace(/[\s.]+/g, '-')

/** The window this session most likely has, from the table alone.
 *
 *  The id off the transcript is preferred over the label because it is the
 *  model's real name rather than something chosen for display -- but `[1m]` in
 *  the label outranks both, since it is the one thing that states the window
 *  outright. */
export const windowFor = (modelId: string, label: string): number => {
  if (/\[1m\]/i.test(label)) return CONTEXT_LIMIT_1M
  for (const candidate of [modelId, label]) {
    if (!candidate) continue
    const key = modelKey(candidate)
    const hit = CONTEXT_WINDOWS[key]
    if (hit) return hit
    let best: string | null = null
    for (const known of Object.keys(CONTEXT_WINDOWS)) {
      if (key.startsWith(known) && (best === null || known.length > best.length)) best = known
    }
    if (best) return CONTEXT_WINDOWS[best]!
  }
  return CONTEXT_LIMIT
}

/** A window derived by dividing, cleaned up. Within a quarter of a window we
 *  know, it IS that window and the remainder was rounding in the percentage.
 *  Outside every band it is something this build has not heard of, so it is
 *  rounded rather than forced onto the nearest thing we happen to know. */
export const snapWindow = (derived: number): number => {
  if (!Number.isFinite(derived) || derived <= 0) return CONTEXT_LIMIT
  for (const w of KNOWN_WINDOWS) if (Math.abs(derived - w) <= w * SNAP_TOLERANCE) return w
  return Math.max(CONTEXT_LIMIT, Math.round(derived / 50_000) * 50_000)
}

/** The smallest window that could actually hold this much context.
 *
 *  The one thing that can correct both layers above it, and the reason the
 *  meter is never simply wrong for long: a ctx past the assumed limit is proof
 *  the assumption is wrong, not that the session is at 100%. */
export const windowAtLeast = (ctx: number): number => {
  for (const w of KNOWN_WINDOWS) if (w >= ctx) return w
  return Math.ceil(ctx / 500_000) * 500_000
}

/** The window a status line reading implies by division, or null when it
 *  cannot say. The FALLBACK path -- `context_window_size` states the window
 *  outright on builds that carry it, and dividing is only for those that do
 *  not.
 *
 *  Claude Code hands the statusLine command `.context_window.used_percentage`
 *  -- the only authoritative number available anywhere -- and the wrapper drops
 *  that JSON where this can read it. ctx divided by the fraction used is the
 *  window. Null whenever the answer would be a guess: too little used to
 *  divide by, or a reading old enough to be from a status line that has
 *  stopped running. */
export const derivedWindow = (ctx: number, usedPct: number, ageMs: number): number | null => {
  if (!(ctx > 0) || !(usedPct >= STATUSLINE_MIN_PCT) || usedPct > 100) return null
  if (!(ageMs >= 0) || ageMs > STATUSLINE_MAX_AGE_MS) return null
  return snapWindow(ctx / (usedPct / 100))
}

/** The step the fraction USED falls in. Clamped at both ends, and the table is
 *  scanned rather than indexed: the steps are not evenly spaced, which is the
 *  whole point of replacing the rounding that put the dark moon past 87%. */
export const pieStep = (pct: number): PieStep => {
  const p = Math.min(1, Math.max(0, pct))
  let step = PIE_STEPS[0]!
  for (const s of PIE_STEPS) if (p >= s.from) step = s
  return step
}

/** The context meter: the glyph for this step, in the requested set. */
export const pie = (pct: number, style: BandSettings['pieStyle'] = 'moon'): string => {
  const step = pieStep(pct)
  return style === 'circle' ? step.circle : step.moon + VS16
}

/** The band's colour for this step -- the pie, the percentage and the band's own
 *  border. Read from the SAME table as the glyph, so the border can never go
 *  red a step before or after the moon goes dark. */
export const pressureOf = (pct: number): PieStep['pressure'] => pieStep(pct).pressure

/** Columns a string occupies, which is NOT its length: the moon glyphs are one
 *  code point and two cells each, and the warning glyph is ONE UTF-16 unit and
 *  two cells -- wrong in the other direction. Only the table's own glyphs are
 *  treated as wide: the band's other non-ASCII (⎇ ↑ ↓ ⚑ ◈ ◇ ▸ ⚠) is all
 *  single-width, and a blanket "is it above U+2600" test would wrongly double
 *  half the row. */
export const displayWidth = (text: string): number => {
  let w = 0
  for (const ch of text) {
    if (ch === VS16) continue // a presentation request, not a glyph
    w += WIDE_GLYPHS.has(ch) ? 2 : 1
  }
  return w
}

/** Fit the vitals onto one row, dropping by PRIORITY rather than by position.
 *
 *  The hotkey row drops from the right because its order is the keyboard's and
 *  cannot be reordered. The vitals row is different: what sits rightmost is not
 *  what matters least, so each item carries its own `prio` and the least useful
 *  one goes first wherever it happens to sit. The first item is never dropped.
 *
 *  Returns what was dropped as well as what was kept, so a band with vertical
 *  room can spill the remainder onto a second line instead of losing it. */
export const fitVitals = <T extends { text: string; prio: number }>(
  items: readonly T[],
  width: number,
  gap: number,
): { kept: T[]; dropped: T[] } => {
  const kept = items.slice()
  const dropped: T[] = []
  const cost = (list: readonly T[]): number =>
    list.reduce((n, i) => n + displayWidth(i.text), 0) + gap * Math.max(0, list.length - 1)
  while (kept.length > 1 && cost(kept) > width) {
    let worst = 0
    for (let i = 1; i < kept.length; i += 1) if (kept[i]!.prio >= kept[worst]!.prio) worst = i
    dropped.push(kept[worst]!)
    kept.splice(worst, 1)
  }
  // Back into display order, so a spill row reads like the row it fell out of.
  dropped.sort((a, b) => items.indexOf(a) - items.indexOf(b))
  return { kept, dropped }
}

// ------------------------------------------------------------ hotkey config

/** One config file's slots, or null when the text is not JSON we understand.
 *
 *  Null and empty mean different things and the caller relies on it: a file
 *  that will not parse falls back to the defaults, while a file that parses to
 *  nothing is somebody deliberately clearing every slot.
 *
 *  Malformed entries inside a readable file are dropped rather than thrown on.
 *  This file is meant to be hand-edited, and a typo in it must never be able to
 *  take the band down. */
export const parseHotkeys = (text: string): Hotkey[] | null => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const list = (raw as { hotkeys?: unknown })?.hotkeys
  if (!Array.isArray(list)) return null
  const out: Hotkey[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    const key = typeof e.key === 'string' ? e.key.trim() : ''
    if (!HOTKEY_SLOTS.includes(key)) continue
    if (out.some((h) => h.key === key)) continue
    const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : ''
    const title = typeof e.title === 'string' ? e.title.trim() : ''
    const short = typeof e.short === 'string' ? e.short.trim() : ''
    out.push({ key, title: title || short, short: short || title, prompt })
  }
  return out
}

/** Split into sentences without a lookbehind, which is not worth relying on
 *  in an environment whose JS target this file does not control. */
const sentencesOf = (text: string): string[] =>
  (text.match(/[^.!?\n]+[.!?]*/g) ?? []).map((x) => x.trim()).filter(Boolean)

/** Strip the markdown a turn's last line usually wears, and cap it. */
const cleanAsk = (text: string): string =>
  text
    .replace(/[`*_>#]/g, '')
    .replace(/^[-•\s\d.)]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NEEDS_MAX)

/** Does this finished turn hand the work back to the user, and if so, saying
 *  what? Returns the sentence that asks, or '' for a turn that asks nothing.
 *
 *  Only a turn that ENDED WITH AN ANSWER can be waiting on anybody: an aborted
 *  turn was interrupted by the user, who is therefore already here, and an
 *  error or a refusal is a different problem with a different remedy.
 *
 *  Scanned from the END backwards, so the reason reported is the last thing
 *  asked rather than the first -- a turn that asks two questions is waiting on
 *  the second. */
export const needsHuman = (answer: string, reason: string): string => {
  if (reason !== 'answer') return ''
  const text = (answer ?? '').trim()
  if (!text) return ''
  const sentences = sentencesOf(text.slice(-NEEDS_TAIL))
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const one = sentences[i]!
    if (one.includes('?') || NEEDS_PHRASES.some((re) => re.test(one))) {
      const asked = cleanAsk(one)
      if (asked) return asked
    }
  }
  return ''
}

/** What this session last SAID, for the drawer to show and the user to answer.
 *
 *  A different question from needsHuman's, and answered differently in two
 *  ways. It keeps the text for ANY finished turn rather than only one that
 *  ended in an answer: needsHuman requires `reason === 'answer'` because only a
 *  turn that finished can be waiting on somebody, while an aborted turn's
 *  visible text is still the last thing this session said. And it is not
 *  classified at all -- no phrase list, no model call, nothing derived. It is
 *  the text.
 *
 *  Capped from the END for the same reason NEEDS_TAIL is: what a turn hands
 *  back is at its end, so a long answer loses its opening rather than its
 *  conclusion. The marker says so, because 2 KB of prose beginning mid-sentence
 *  otherwise reads as a bug in the pane. */
export const lastAnswerOf = (answer: string): string => {
  const text = (answer ?? '').trim()
  if (text.length <= LAST_ANSWER_MAX) return text
  return LAST_ANSWER_ELIDED + text.slice(-LAST_ANSWER_MAX)
}

/** The running turn's prompt head, from turn.start's own text, and its origin,
 *  matched by text against what prompt.submit saw. The match drops every entry
 *  queued before it: those prompts were delivered into a turn or stashed, and
 *  started nothing. No match leaves the queue alone and says 'unknown'. */
export const chainPromptOf = (
  text: string,
  pending: readonly { head: string; origin: string }[],
): { prompt: { head: string; origin: string }; pending: { head: string; origin: string }[] } => {
  const head = String(text ?? '').slice(0, CHAIN_HEAD_MAX)
  const at = head ? pending.findIndex((p) => p.head === head) : -1
  if (at < 0) return { prompt: { head, origin: 'unknown' }, pending: [...pending] }
  return { prompt: { head, origin: pending[at]!.origin }, pending: pending.slice(at + 1) }
}

/** Does this tool call count as "working on a plan"? Returns the plan's
 *  basename -- the identity `claim_work` and `foldEfforts` already use -- or
 *  null when the call is unrelated. Pure, and exported so `test/harness.mjs`
 *  can assert it directly without a mock `$`; the auto-claim branch in the
 *  `*` hook is its only caller.
 *
 *  Two shapes count: a direct edit of a plan file (`Edit`/`Write`/
 *  `MultiEdit`/`NotebookEdit` whose `file_path` sits under `docs/plans/` or
 *  `docs/superpowers/plans/`, `README.md` excluded -- it is an index, not a
 *  plan), or a `Bash` call that reports or verifies one via
 *  `just plan-reported <path> …` / `just plan-done <path> …`, whose first
 *  argument is a path we reduce to its basename the same way. */
export const planFromToolCall = (tool: string, args: Record<string, unknown>): string | null => {
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
    const path = typeof args.file_path === 'string' ? args.file_path : ''
    const m = /(^|\/)docs\/(superpowers\/)?plans\/([^/]+\.md)$/.exec(path)
    return m && m[3] !== 'README.md' ? m[3]! : null
  }
  if (tool === 'Bash') {
    const command = typeof args.command === 'string' ? args.command : ''
    const m = /\bjust\s+plan-(?:reported|done)\s+(\S+)/.exec(command)
    if (!m) return null
    const base = m[1]!.split('/').pop() || ''
    return base || null
  }
  return null
}

/** At least one evidence entry ends in a line number. findings.mjs's
 *  hasLineEvidence is the source of truth; this copy exists because the hooks
 *  module cannot import a bridge module (that one pulls in node:fs, which the
 *  hooks runtime does not have). test/harness.mjs asserts the two agree. */
export const hasLineEvidence = (evidence: unknown): boolean =>
  Array.isArray(evidence) && evidence.some((e) => typeof e === 'string' && /:\d+(:\d+)?$/.test(e.trim()))

/** What the built-in pane button says. Pure, so its three states can be
 *  asserted directly -- read off a live band it would depend on whether the
 *  machine running the tests happens to have a side pane open. */
export const paneLabel = (inTmux: boolean, open: boolean): { label: string; short: string } => {
  if (!inTmux) return { label: 'pane needs tmux', short: 'no tmux' }
  return open ? { label: 'close pane', short: 'close' } : { label: 'open pane', short: 'pane' }
}

/** The `settings` object of one config file, or null when there is none.
 *
 *  Unknown keys and wrong-typed values are ignored rather than rejected: this
 *  file is hand-edited, and one bad key must not cost the user the other
 *  settings in it. */
export const parseSettings = (text: string): Partial<BandSettings> | null => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const got = (raw as { settings?: unknown })?.settings
  if (!got || typeof got !== 'object') return null
  const e = got as Record<string, unknown>
  const out: Partial<BandSettings> = {}
  if (typeof e.spinnerPicker === 'boolean') out.spinnerPicker = e.spinnerPicker
  if (e.pieStyle === 'moon' || e.pieStyle === 'circle') out.pieStyle = e.pieStyle
  // Validity against SPINNERS is checked at USE time (resolveSpinnerId), not
  // here -- the same split parseHotkeys/mergeHotkeys already draws between
  // "well-typed" and "well-formed". A parse-time check would also need
  // SPINNERS in scope, which this function otherwise has no reason to import.
  if (typeof e.spinner === 'string' && e.spinner) out.spinner = e.spinner
  // Unlike `spinner`, the EMPTY string is kept: it is how the file says "no
  // marker, leave my prompts alone", which is a different statement from
  // omitting the key (inherit). Validity is checked at USE time, in
  // normalizeMarker, the same split this function already draws.
  if (typeof e.pasteboardMarker === 'string') out.pasteboardMarker = e.pasteboardMarker
  return out
}

/** Defaults, then global, then project -- the same precedence as the slots. */
export const mergeSettings = (
  globals: Partial<BandSettings> | null,
  project: Partial<BandSettings> | null,
): BandSettings => ({ ...DEFAULT_SETTINGS, ...(globals ?? {}), ...(project ?? {}) })

/** What a leading marker asked for, or `{ stash: false }` for an ordinary
 *  prompt. */
export type Stash =
  | { stash: false }
  | { stash: true; text: string; title: string | null; scope: 'session' | 'global' }

/** Characters a marker may be made of: ASCII punctuation only. */
const MARKER_CHARS = /^[!-/:-@[-`{-~]+$/
/** Position 0 belongs to the engine for these four: a slash command, bash
 *  mode, a memory line and a file mention. A marker starting with one would
 *  either never fire or would shadow something the user cannot get back. */
const MARKER_FORBIDDEN_FIRST = new Set(['/', '!', '#', '@'])

/** The marker actually in force, or `''` for "no interception at all".
 *
 *  An UNUSABLE value disables rather than falling back to the default. The
 *  default would start eating prompts the user never asked to have eaten, and
 *  this mechanism's whole job is destroying what you just typed -- so the
 *  failure direction has to be "do nothing". */
export const normalizeMarker = (raw: unknown): string => {
  if (raw === undefined || raw === null) return DEFAULT_SETTINGS.pasteboardMarker
  if (typeof raw !== 'string') return ''
  if (raw === '') return ''
  if (raw.length > 4) return ''
  if (!MARKER_CHARS.test(raw)) return ''
  if (MARKER_FORBIDDEN_FIRST.has(raw[0]!)) return ''
  return raw
}

/** Three leading forms, and their two trailing twins:
 *
 *      ,,<text>            this session's board
 *      ,,,<text>           the global board  -- one more of the same key
 *      ,,@<title> <text>   an explicit title -- @ marks a NAME
 *      <text>,,            this session's board, decided at the END of typing
 *      <text>,,,           the global board, likewise
 *
 *  A leading marker must be at index 0, with no trimming first: a stash that
 *  depended on invisible leading characters would be impossible to reason
 *  about when it did not fire. A trailing marker is read after trailing
 *  whitespace is dropped, because the hand that decides to stash at the end
 *  of a long prompt has often already hit space. Leading wins over trailing;
 *  there is no trailing title form. The triple is tested before the double at
 *  either end, or every global stash would land on the session board with a
 *  comma glued to its text. */
export const parseStash = (text: string, marker: string): Stash => {
  if (!marker) return { stash: false }
  const triple = marker + marker[marker.length - 1]
  let rest: string
  let scope: 'session' | 'global'
  if (text.startsWith(triple)) { rest = text.slice(triple.length); scope = 'global' }
  else if (text.startsWith(marker)) { rest = text.slice(marker.length); scope = 'session' }
  else {
    const tail = text.replace(/\s+$/, '')
    if (tail.endsWith(triple)) return { stash: true, text: tail.slice(0, -triple.length).replace(/\s+$/, ''), title: null, scope: 'global' }
    if (tail.endsWith(marker)) return { stash: true, text: tail.slice(0, -marker.length).replace(/\s+$/, ''), title: null, scope: 'session' }
    return { stash: false }
  }

  let title: string | null = null
  if (rest.startsWith('@')) {
    const space = rest.indexOf(' ')
    const word = space === -1 ? rest.slice(1) : rest.slice(1, space)
    if (word) {
      title = word.slice(0, 60)
      rest = space === -1 ? '' : rest.slice(space + 1)
    }
  }
  return { stash: true, text: rest, title, scope }
}

/** What the engine shows the user where their prompt would have gone.
 *
 *  `prompt.submit`'s declaration: a hook's refusal is `{ drop: reason }` and
 *  "the text is shown to the user as the reason". That makes this the one
 *  confirmation guaranteed to be seen, so it is a pure function with its own
 *  assertions rather than a string built inline in the hook. */
export type StashOutcome = {
  ok: boolean
  error?: string
  index?: number
  count?: number
  scope: 'session' | 'global'
  text: string
  attachments: number
  restored: boolean
  title?: string | null
}

const WHY: Record<string, string> = {
  'board full': 'this board is full — delete something',
  'pasteboard full': 'the pasteboard is full — delete something',
  empty: 'nothing after the marker — nothing stashed',
  unreachable: 'the relay is not answering',
  'no session': 'this session has not registered yet',
}

export const stashReason = (r: StashOutcome): string => {
  const where = r.scope === 'global' ? 'the global board' : "this session's board"
  if (r.ok) {
    const head = r.title ? `stashed as "${r.title}"` : 'stashed'
    const at = `${(r.index ?? 0) + 1} of ${r.count ?? 1} on ${where}`
    const lost = r.attachments > 0 ? ` · ${r.attachments} attachments were not kept` : ''
    return `${head} · ${at}${lost}`
  }
  // The limit is the relay's to set, so the sentence carries the length it
  // was handed and never a number that could go stale here.
  const why = r.error === 'too long'
    ? `that text is ${r.text.length.toLocaleString('en-US')} characters, over the stash limit`
    : WHY[r.error ?? ''] ?? `could not stash (${r.error ?? 'unknown'})`
  if (r.restored) return `pasteboard: ${why} — your text is back in the composer`
  // The restore itself failed, so THIS STRING is the last copy of the text.
  return `pasteboard: ${why} — and putting it back failed, so here it is: ${r.text.slice(0, 200)}`
}

/** Which spinner actually plays, three sources deep.
 *
 *  The config file's `settings.spinner` wins whenever it names a real id --
 *  that is a deliberate PIN, e.g. a team standardising on one look, and it is
 *  allowed to override even a choice just made live in the band, because the
 *  file is re-read every `refresh()` (see `loadHotkeys`) and would only
 *  overwrite it again next turn boundary anyway. Silently reverting a live
 *  pick with no explanation is the cost of that pin; `chooseSpinner`'s toast
 *  says so when it happens.
 *
 *  Absent that, `$.store`'s `'spinner'` key is the picker's own live choice --
 *  the thing this function existed to read before the config route was added,
 *  and still what governs when the file has no opinion.
 *
 *  An unrecognised id in either source (a typo, or a spinner renamed out from
 *  under a stale value) falls through rather than throwing: file → store →
 *  the shipped default, same as `spinnerById` already does for the id it is
 *  finally given. */
export const resolveSpinnerId = (fileSpinner: string | undefined, storeSpinner: unknown): string => {
  if (typeof fileSpinner === 'string' && SPINNERS.some((sp) => sp.id === fileSpinner)) return fileSpinner
  if (typeof storeSpinner === 'string' && SPINNERS.some((sp) => sp.id === storeSpinner)) return storeSpinner
  return DEFAULT_SPINNER
}

/** Global slots with the project's written over them, one slot at a time.
 *
 *  Per-slot rather than whole-file so a project may claim one hotkey without
 *  restating the seven it does not care about. An entry whose prompt is empty
 *  hides that slot -- which is how a project turns a global slot OFF, the only
 *  way to say "not here" in a format where absence already means "inherit". */
export const mergeHotkeys = (globals: Hotkey[], project: Hotkey[]): Hotkey[] => {
  const bySlot = new Map<string, Hotkey>()
  for (const h of globals) bySlot.set(h.key, h)
  for (const h of project) bySlot.set(h.key, h)
  const out: Hotkey[] = []
  for (const slot of HOTKEY_SLOTS) {
    const h = bySlot.get(slot)
    if (h && h.prompt && h.title) out.push(h)
  }
  return out
}

/** What a `plain` Button occupies: the engine draws it as `<hotkey>: <label>`. */
export const buttonWidth = (key: string, label: string): number => key.length + 2 + label.length

/** Fit the action row on ONE line, longest form first.
 *
 *  It is one line by design, but the ladder is not cosmetic: `AbovePrompt`'s
 *  own declaration says a tree taller than `maxRows` is clipped and "none of
 *  its Buttons' hotkeys are armed" -- so a row that wraps does not merely look
 *  wrong, it disarms every key in the band.
 *
 *  Full titles, then short labels, then dropping from the right with a `+N`
 *  marker saying how many went. The first entry is never dropped. */
export const fitHotkeys = (
  items: readonly { key: string; label: string; short: string }[],
  width: number,
  gap: number,
): { shown: { key: string; label: string }[]; hidden: number } => {
  if (items.length === 0) return { shown: [], hidden: 0 }
  const total = (labels: readonly string[]): number =>
    labels.reduce((n, l, i) => n + buttonWidth(items[i]!.key, l), 0) + gap * (labels.length - 1)

  const full = items.map((i) => i.label)
  if (total(full) <= width) return { shown: items.map((i) => ({ key: i.key, label: i.label })), hidden: 0 }

  const short = items.map((i) => i.short || i.label)
  if (total(short) <= width) return { shown: items.map((i, n) => ({ key: i.key, label: short[n]! })), hidden: 0 }

  for (let keep = items.length - 1; keep >= 1; keep -= 1) {
    const hidden = items.length - keep
    const marker = gap + `+${hidden}`.length
    if (total(short.slice(0, keep)) + marker <= width) {
      return { shown: items.slice(0, keep).map((i, n) => ({ key: i.key, label: short[n]! })), hidden }
    }
  }
  return { shown: [{ key: items[0]!.key, label: short[0]! }], hidden: items.length - 1 }
}

// ------------------------------------------------------------------ spinners

const spinnerById = (id: string): SpinnerDef =>
  SPINNERS.find((s) => s.id === id) ?? SPINNERS.find((s) => s.id === DEFAULT_SPINNER) ?? SPINNERS[0]!

/** A travelling wave across the caption, at the 10 Hz tick. */
const captionColor = (i: number, frame: number, tint: string): string => {
  const p = (((i - Math.floor(frame / 2)) % 10) + 10) % 10
  return p < 2 ? 'white' : p < 5 ? tint : 'gray'
}

const cellsOf = (text: string, style: Omit<Cell, 'ch'> = {}): Row =>
  [...text].map((ch) => ({ ch, ...style }))

const captionRows = (
  word: string,
  message: string | null,
  mode: keyof typeof TINT,
  frame: number,
  elapsedMs: number,
): Row[] => {
  const tint = TINT[mode] ?? TINT.thinking
  const text = `${message ?? word}\u2026`
  const elapsed = elapsedMs > 0 ? `(${Math.round(elapsedMs / 1000)}s)` : ''
  return [
    [...text].map((ch, i) => ({ ch, color: captionColor(i, frame, tint.name) })),
    cellsOf(`${elapsed}${elapsed ? ' · ' : ''}${tint.word}`, { dim: true }),
  ]
}

/** Merges adjacent cells that share a style into one Text: a 200-column row of
 *  single cells would otherwise be 200 elements every frame. */
const paintRow = (t: Terminal, row: Row) => {
  const runs: { c: Cell; text: string }[] = []
  for (const cell of row) {
    const last = runs[runs.length - 1]
    if (
      last && last.c.color === cell.color && last.c.dim === cell.dim &&
      last.c.bold === cell.bold && last.c.inverse === cell.inverse
    ) last.text += cell.ch
    else runs.push({ c: cell, text: cell.ch })
  }
  return (
    <t.Box flexDirection="row">
      {runs.map((r) => (
        <t.Text color={r.c.color} dimColor={r.c.dim} bold={r.c.bold} inverse={r.c.inverse} wrap="truncate-end">
          {r.text}
        </t.Text>
      ))}
    </t.Box>
  )
}

const paint = (t: Terminal, rows: readonly Row[], width: number) => (
  <t.Box flexDirection="column" width={width} overflow="hidden">
    {rows.map((r) => paintRow(t, r))}
  </t.Box>
)

/** The spinner block plus its caption, placed as the definition asks. */
const paintSpinner = (t: Terminal, def: SpinnerDef, rows: Row[], caption: Row[], columns: number) => {
  if (def.caption === 'none') return paint(t, rows, columns)
  if (def.caption === 'below') return paint(t, [...rows, ...caption.slice(0, 1)], columns)
  const blockWidth = Math.max(...rows.map((r) => r.length), 1)
  return (
    <t.Box flexDirection="row" width={columns} overflow="hidden">
      {paint(t, rows, blockWidth)}
      <t.Box flexDirection="column" marginLeft={2} justifyContent="center">
        {caption.map((r) => paintRow(t, r))}
      </t.Box>
    </t.Box>
  )
}

const summarizeInput = (e: Record<string, unknown>): string => {
  const pick = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const raw =
    pick('command') || pick('file_path') || pick('pattern') || pick('path') ||
    pick('prompt') || pick('url') || pick('query') || ''
  return raw.replace(/\s+/g, ' ').slice(0, 120)
}

// ---------------------------------------------------------- transcript read

const enc = new TextEncoder()

const findTranscript = async ($: Dollar, sessionId: string): Promise<string | null> => {
  const home = await $.process.run(['printenv', 'HOME'], { timeoutMs: 5000 })
  const dir = `${home.stdout.trim()}/.claude/projects`
  if (!dir.startsWith('/')) return null
  const found = await $.process.run(
    ['find', dir, '-maxdepth', '2', '-name', `${sessionId}.jsonl`],
    { timeoutMs: 10_000 },
  )
  const path = found.stdout.split('\n').find((l) => l.trim().length > 0)
  return path ? path.trim() : null
}

/** Reads whatever has been appended since the last call and folds its usage
 *  into `s`. Byte offsets land on line boundaries, so the tail never starts
 *  mid-character. */
const ingest = async ($: Dollar, s: Hud): Promise<boolean> => {
  if (!s.transcript) {
    s.transcript = await findTranscript($, s.sessionId)
    if (!s.transcript) return false
  }
  const tail = await $.process.run(['tail', '-c', `+${s.offset + 1}`, s.transcript], {
    timeoutMs: 15_000,
  })
  if (tail.exitCode !== 0 || tail.stdout.length === 0) return false

  const parts = tail.stdout.split('\n')
  const complete = parts.slice(0, -1)
  if (complete.length === 0) return false

  let consumed = 0
  let changed = false
  let turnTokens = 0
  const seen = new Set(s.seen)

  for (const line of complete) {
    consumed += enc.encode(line).length + 1
    if (line.length === 0) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row?.type !== 'assistant') continue
    const msg = row.message
    const usage = msg?.usage
    const id = msg?.id
    if (!usage || typeof id !== 'string') continue

    // The context meter tracks the main thread; subagents run their own.
    if (!row.isSidechain) {
      const ctx =
        (usage.input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0) +
        (usage.cache_read_input_tokens || 0)
      if (ctx > 0) s.ctx = ctx
      if (typeof msg.model === 'string') s.modelId = msg.model
    }

    if (seen.has(id)) continue
    seen.add(id)
    changed = true

    s.inTok += usage.input_tokens || 0
    s.outTok += usage.output_tokens || 0
    s.cacheRead += usage.cache_read_input_tokens || 0
    turnTokens += (usage.input_tokens || 0) + (usage.output_tokens || 0) +
      (usage.cache_creation_input_tokens || 0)

    const created = usage.cache_creation
    if (created) {
      s.cacheWrite1h += created.ephemeral_1h_input_tokens || 0
      s.cacheWrite5m += created.ephemeral_5m_input_tokens || 0
    } else {
      s.cacheWrite5m += usage.cache_creation_input_tokens || 0
    }
  }

  s.offset += consumed
  s.seen = [...seen].slice(-SEEN_CAP)
  if (turnTokens > 0) s.throughput = [...s.throughput, turnTokens].slice(-60)
  return changed
}

// ------------------------------------------------------ live state + readers
//
// Module scope, not a closure inside register(): the validator requires every
// helper that takes $ to be declared at the top of the file. A hot reload
// builds a fresh environment, so this resets and rehydrates from $.store.

const M: {
  state: Hud | null
  modelLabel: string
  branch: string | null
  dirty: boolean
  contextLimit: number
  turnStartedAt: number | null
  /** The running turn's id, as turn.start hands it over; $.turn.abort needs it. */
  turnId: string | null
  ticker: { cancel: () => void } | null
  pusher: { cancel: () => void } | null
  poller: { cancel: () => void } | null
  lastClock: string
  lastStatus: number
  refreshing: boolean
  frame: number
  narrationAt: number
  // spinner
  spin: number
  spinner: { cancel: () => void } | null
  spinnerId: string
  /** The mode and word the engine last handed the Spinner component. The
   *  plugin has always known these and never sent them; the pane draws its
   *  own spinner from them. */
  spinMode: string
  spinWord: string
  previewUntil: number
  /** Turns since session start. No shipped spinner reads it, but it is part of
   *  the context every draw() is handed and cheap to keep. */
  turnSeq: number
  // bridge
  relayUp: boolean
  /** The relay this session talks to. RELAY_PORT_DEFAULT unless
   *  `SZG_RELAY_PORT` said otherwise at session.start, which is how a session
   *  spawned from a canvas joins the board that spawned it. */
  relayPort: number
  /** True when `SZG_RELAY_TOKEN` supplied the token, so relayConfig's file read
   *  and mint are skipped: the spawning relay's token is authoritative for this
   *  session, and the shared config file describes a DIFFERENT relay. */
  tokenFromEnv: boolean
  headless: boolean
  token: string
  bridgePath: string | null
  /** The side TUI pane's launcher (`pane-v2/syzygy-pane.sh`), or null when this
   *  machine has no copy of it. Resolved once at boot. */
  paneScript: string | null
  /** What this session last asked the user for, or '' when it asked nothing.
   *  Set when a turn ends, cleared when the next one starts. */
  needs: string
  /** The tail of what this session last SAID, or '' before its first turn.
   *  Unlike `needs` it is NOT cleared at turn.start: the drawer's question is
   *  "what did it last say", and a session that has started working has not
   *  unsaid it. It is replaced when the next turn ends. */
  lastAnswer: string
  /** When `lastAnswer` was captured, so the drawer can age it. 0 for none. */
  lastAnswerAt: number
  /** Whether this window currently has a side TUI pane. Polled, because the
   *  user can also close it with tmux directly. */
  paneOpen: boolean
  /** Throttle for that poll: two tmux shell-outs a second would be absurd. */
  paneCheckedAt: number
  cwd: string
  /** The worktree root for `cwd`, from `git rev-parse --show-toplevel`, or ''
   *  when the session is not in a git worktree. Resolved once: `loadHotkeys`
   *  runs at every turn boundary and this must not cost a subprocess there. */
  projectRoot: string
  /** The cwd `projectRoot` was resolved for, so the memo cannot go stale. */
  projectRootFor: string
  repo: string | null
  agentName: string
  /** This session's pid, which is also the key of Claude Code's own session
   *  index. Discovered once at boot; the relay reports it so the tmux pane can
   *  match a pane's process tree against it. */
  pid: string
  /** Claude Code's own name for this session, read from that index. Empty
   *  until it is found, and the folder name stands in until then. */
  sessionName: string
  /** The tmux session this Claude is running inside, when it is running inside
   *  one at all. Discovered once at boot; the board groups its cards by it.
   *  Empty means "not in tmux", which is the common case and must stay silent. */
  tmux: string
  /** Whether the tmux lookup has been attempted. A session that is not in tmux
   *  would otherwise re-shell twice a second forever to learn the same thing. */
  tmuxAsked: boolean
  pending: Ev[]
  agents: { id: string; description: string; type: string; status: string }[]
  // in-band interaction
  /** The eight configurable prompt slots, resolved from the global config file
   *  with the project's written over it. Re-read on every refresh, so editing
   *  either file takes effect at the next turn boundary rather than at the next
   *  session. */
  hotkeys: Hotkey[]
  /** Band settings, from the same two files as the hotkeys. */
  settings: BandSettings
  /** $HOME, asked for once. Three separate readers need it and `$.fs` is
   *  sandboxed to the working directory, so all of them shell out. */
  home: string
  /** When each file was last edited, which `s.files` cannot say: it counts and
   *  never forgets. A stuck signal lapses off this, not off the count. */
  fileAt: Record<string, number>
  stuck: string | null
  /** One line under the vitals saying what the last marker or fill did.
   *  Cleared when the next `turn.start` bumps `M.turnSeq` past `seq`, or after
   *  NOTICE_MS, whichever comes first -- a dropped submission starts no turn,
   *  so the clock is the only thing that would ever clear it on an idle
   *  session. */
  notice: { text: string; at: number; seq: number } | null
  /** The unusable marker value already reported to the feed, so a bad setting
   *  is said once rather than on every prompt. */
  markerWarned: string
  approvals: { id: string; label: string }[]
  /** Plan basenames already auto-claimed this session, so a second edit of the
   *  same plan does not POST again. Cleared at session.start (a fresh session
   *  has claimed nothing yet); NOT marked when the relay is down, so a later
   *  edit retries rather than silently giving up. */
  autoClaimed: Set<string>
  /** Where recently submitted prompts came from, oldest first, keyed by their
   *  head. turn.start carries the text but not the origin, so the two are
   *  matched by text there -- never by position, because a prompt delivered
   *  INTO a running turn starts no turn of its own and would shift every later
   *  one. Capped; the oldest goes first. */
  chainPending: { head: string; origin: string }[]
  /** The head and origin of the prompt the RUNNING turn is working on, set at
   *  turn.start and read at turn.complete, which carries neither. */
  chainPrompt: { head: string; origin: string } | null
  /** The files edited during the RUNNING turn. `s.files` counts for the whole
   *  session and never forgets, which cannot say what this turn was about. */
  turnFiles: Set<string>
  /** Tool calls, and subagent turns, during the running turn. */
  turnTools: number
  subturns: number
} = {
  state: null,
  modelLabel: '',
  branch: null,
  dirty: false,
  contextLimit: CONTEXT_LIMIT,
  turnStartedAt: null,
  turnId: null,
  ticker: null,
  pusher: null,
  poller: null,
  lastClock: '',
  lastStatus: 0,
  refreshing: false,
  frame: 0,
  narrationAt: 0,
  spin: 0,
  spinner: null,
  spinnerId: DEFAULT_SPINNER,
  spinMode: '',
  spinWord: '',
  previewUntil: 0,
  turnSeq: 0,
  relayUp: false,
  relayPort: RELAY_PORT_DEFAULT,
  tokenFromEnv: false,
  headless: false,
  token: '',
  bridgePath: null,
  paneScript: null,
  needs: '',
  lastAnswer: '',
  lastAnswerAt: 0,
  paneOpen: false,
  paneCheckedAt: 0,
  cwd: '',
  projectRoot: '',
  projectRootFor: '',
  repo: null,
  agentName: 'main',
  pid: '',
  sessionName: '',
  tmux: '',
  tmuxAsked: false,
  pending: [],
  agents: [],
  hotkeys: DEFAULT_HOTKEYS,
  settings: DEFAULT_SETTINGS,
  home: '',
  fileAt: {},
  stuck: null,
  notice: null,
  markerWarned: '',
  approvals: [],
  autoClaimed: new Set(),
  chainPending: [],
  chainPrompt: null,
  turnFiles: new Set(),
  turnTools: 0,
  subturns: 0,
}

const note = (ev: Ev): void => {
  M.pending = [...M.pending, { ...ev, t: Date.now() }].slice(-EVENT_CAP)
}

const persist = ($: Dollar): void => {
  const s = M.state
  if (!s) return
  void $.store.set(`hud:${s.sessionId}`, s as unknown).catch(() => {})
}

// ------------------------------------------------------------------- bridge

const relayUrl = (path: string): string => `http://${RELAY_HOST}:${M.relayPort}${path}`

/** Reads `SZG_RELAY_PORT` and `SZG_RELAY_TOKEN` into `M`, once, at session.start
 *  and BEFORE relayConfig or ensureRelay run. A relay sets both on every
 *  session it spawns (`canvas.mjs`'s spawnSession), so this is what makes a
 *  canvas-started session appear on the canvas that started it.
 *
 *  `printenv` through `$.process.run` is the only way to read the environment
 *  here -- the same idiom findBridge and relayConfig use for HOME. A missing
 *  variable exits non-zero, which is the common case and must stay silent.
 *
 *  Neither variable set leaves `M` exactly as it was, so an ordinary session
 *  behaves byte for byte as it did before this existed. */
const readRelayEnv = async ($: Dollar): Promise<void> => {
  // SZG_HEADLESS first, and on its own, because everything else this function
  // does is only interesting to a session that is going to join the board.
  const headless = await $.process.run(['printenv', 'SZG_HEADLESS'], { timeoutMs: 4000 }).catch(() => null)
  if (headless && headless.exitCode === 0 && headless.stdout.trim() === '1') {
    M.headless = true
    return
  }
  const port = await $.process.run(['printenv', 'SZG_RELAY_PORT'], { timeoutMs: 4000 }).catch(() => null)
  if (port && port.exitCode === 0) {
    const n = Number.parseInt(port.stdout.trim(), 10)
    // A port of 0 means "any port" to a LISTENER and nothing at all to a
    // client, and NaN would make every relay URL the string "NaN".
    if (Number.isInteger(n) && n >= 1 && n <= 65535) M.relayPort = n
  }
  const token = await $.process.run(['printenv', 'SZG_RELAY_TOKEN'], { timeoutMs: 4000 }).catch(() => null)
  if (token && token.exitCode === 0) {
    const t = token.stdout.trim()
    if (t) { M.token = t; M.tokenFromEnv = true }
  }
}

/** Finds relay.mjs wherever the plugin happens to be loaded from. */
const findBridge = async ($: Dollar): Promise<string | null> => {
  const home = (await $.process.run(['printenv', 'HOME'], { timeoutMs: 5000 })).stdout.trim()
  const candidates = [
    `${home}/.claude/skills/syzygy/bridge/relay.mjs`,
    `${home}/.claude/plugins/cache/syzygy/bridge/relay.mjs`,
    `${M.cwd}/syzygy/bridge/relay.mjs`,
    `${M.cwd}/bridge/relay.mjs`,
  ]
  for (const c of candidates) {
    const hit = await $.process.run(['test', '-f', c], { timeoutMs: 4000 }).catch(() => null)
    if (hit && hit.exitCode === 0) return c
  }
  return null
}

/** The side TUI pane's launcher.
 *
 *  Cannot be found by walking up from `M.bridgePath` as text: the plugin is
 *  normally loaded through a SYMLINK (`~/.claude/skills/syzygy` ->
 *  the repo), so `<bridge>/../../pane-v2` resolves to
 *  `~/.claude/skills/pane-v2`, which does not exist. `realpath` first, then
 *  walk. The working directory is tried ahead of it for the common case of a
 *  session running inside the repo itself. */
const findPaneScript = async ($: Dollar): Promise<string | null> => {
  const candidates: string[] = []
  if (M.cwd) candidates.push(`${M.cwd}/pane-v2/syzygy-pane.sh`)
  if (M.bridgePath) {
    const real = await $.process.run(['realpath', M.bridgePath], { timeoutMs: 4000 }).catch(() => null)
    const resolved = real && real.exitCode === 0 ? real.stdout.trim() : ''
    const root = resolved.replace(/\/syzygy\/bridge\/relay\.mjs$/, '')
    if (root.startsWith('/') && root !== resolved) candidates.push(`${root}/pane-v2/syzygy-pane.sh`)
  }
  for (const c of candidates) {
    const hit = await $.process.run(['test', '-x', c], { timeoutMs: 4000 }).catch(() => null)
    if (hit && hit.exitCode === 0) return c
  }
  return null
}

/** Is there a side pane in THIS window right now?
 *
 *  The launcher records its pane id in the window option `@syzygy_pane`, so the
 *  question is "is that option set, and is the pane it names still alive" --
 *  the user may have closed it with tmux and left the option behind. Both in
 *  one `sh -c` rather than two `$.process.run` calls, because this is polled.
 *
 *  Window-scoped commands resolve through `TMUX_PANE`, which a freshly spawned
 *  child inherits correctly. (A long-lived one does NOT: the relay outlives the
 *  session that started it and carries that session's stale pane id. Anything
 *  asking this question must ask it from a new process, as this does.) */
const refreshPaneOpen = async ($: Dollar, force: boolean): Promise<void> => {
  if (!M.tmux) { M.paneOpen = false; return }
  const now = $.clock.now()
  if (!force && now - M.paneCheckedAt < PANE_CHECK_MS) return
  M.paneCheckedAt = now
  const res = await $.process
    .run(
      ['sh', '-c',
        'p=$(tmux show-options -wqv @syzygy_pane 2>/dev/null); ' +
        '[ -n "$p" ] && tmux list-panes -F "#{pane_id}" 2>/dev/null | grep -qx "$p" && echo open || echo closed'],
      { timeoutMs: 5000 },
    )
    .catch(() => null)
  const open = !!res && res.stdout.trim() === 'open'
  if (open !== M.paneOpen) {
    M.paneOpen = open
    $.ui.invalidate('ui.render')
  }
}

/** Reads the shared relay config, or mints one. Sessions race benignly: the
 *  loser's spawn fails to bind and it simply uses the winner's relay. */
const relayConfig = async ($: Dollar): Promise<{ token: string } | null> => {
  const home = (await $.process.run(['printenv', 'HOME'], { timeoutMs: 5000 })).stdout.trim()
  if (!home.startsWith('/')) return null
  const path = `${home}/.claude/syzygy-relay.json`
  const read = await $.process.run(['cat', path], { timeoutMs: 4000 }).catch(() => null)
  if (read && read.exitCode === 0) {
    try {
      const parsed = JSON.parse(read.stdout)
      if (typeof parsed.token === 'string' && parsed.token) return { token: parsed.token }
    } catch {}
  }
  const token = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  // 0600, two ways. `umask 077` covers the file being CREATED here, which is
  // the normal case; `chmod` covers one that already exists and is being
  // rewritten (an unparseable file, or one left 0644 by a relay from before
  // this line). The file is a bearer token for a server that can spawn
  // sessions and read every transcript on the board, so world-readable was
  // simply wrong -- and it is a default, not a decision: `>` takes the umask,
  // which on a normal account is 022.
  await $.process
    .run(['sh', '-c',
      `umask 077; printf '%s' '${JSON.stringify({ token, port: M.relayPort })}' > "${path}" && chmod 600 "${path}"`], {
      timeoutMs: 5000,
    })
    .catch(() => null)
  return { token }
}

/** Starts the relay if nothing is answering on the port. Detached through sh
 *  so $.process.run returns at once instead of holding the child. */
const ensureRelay = async ($: Dollar): Promise<boolean> => {
  if (M.headless) return false
  const health = await $.http.fetch(relayUrl('/api/health')).catch(() => null)
  if (health?.ok) return true
  if (!M.bridgePath) return false
  // The token is interpolated into an `sh -c` string below, inside single
  // quotes. That was safe while it could only be a hex string this file minted
  // itself; it may also come from SZG_RELAY_TOKEN, which is
  // whatever a spawning relay put there. One apostrophe would close the quote
  // and the rest would be shell. So: a token that is not plainly alphanumeric
  // does not get to start a relay. Refusing is the whole remedy -- this
  // session still TALKS to a relay on that token (that path is a JSON body,
  // not a shell string); it just will not launch one.
  if (!/^[A-Za-z0-9_-]+$/.test(M.token)) return false
  const node = await $.process.run(['sh', '-c', 'command -v node'], { timeoutMs: 5000 }).catch(() => null)
  if (!node || node.exitCode !== 0) return false
  const bin = node.stdout.trim()
  await $.process
    .run(
      [
        'sh',
        '-c',
        // NOT /tmp. That directory is world-writable, so anyone with an
        // account on the machine could plant a symlink at a fixed, guessable
        // name and have the relay's output truncate and overwrite whatever it
        // points at, as this user. The relay's own state directory is the
        // right place and needs no new invention.
        `mkdir -p "\${HOME}/.claude/syzygy" && ` +
          `SZG_TOKEN='${M.token}' SZG_PORT=${M.relayPort} nohup '${bin}' '${M.bridgePath}' ` +
          `>>"\${HOME}/.claude/syzygy/relay.log" 2>&1 & echo started`,
      ],
      { timeoutMs: 8000 },
    )
    .catch(() => null)
  for (let i = 0; i < 12; i++) {
    await $.clock.sleep(250).catch(() => {})
    const again = await $.http.fetch(relayUrl('/api/health')).catch(() => null)
    if (again?.ok) return true
  }
  return false
}

const relayPost = async ($: Dollar, path: string, body: unknown): Promise<any> => {
  if (M.headless || !M.relayUp) return null
  const res = await $.http
    .fetch(relayUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: M.token, ...(body as object) }),
    })
    .catch(() => null)
  M.lastStatus = res?.status ?? 0
  if (!res || !res.ok) return null
  try {
    return JSON.parse(res.text)
  } catch {
    return null
  }
}

/** The relay's answer to one stash, error named. */
type StashPosted = { ok: boolean; error?: string; index?: number; count?: number }

/** POST one stash and read the relay's answer, error body included.
 *
 *  Not `relayPost`: that returns `null` for every non-ok status, which
 *  collapses "the board is full" and "the relay is gone" into the same
 *  nothing -- and those two want different sentences and different next
 *  actions from the person whose prompt was just swallowed. */
const stashText = async (
  $: Dollar,
  body: { sessionId: string | null; sessionName: string; text: string; title?: string; scope: string },
): Promise<StashPosted> => {
  if (M.headless || !M.relayUp) return { ok: false, error: 'unreachable' }
  const res = await $.http
    .fetch(relayUrl('/api/pasteboard/create'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: M.token, ...body }),
    })
    .catch(() => null)
  M.lastStatus = res?.status ?? 0
  if (!res) return { ok: false, error: 'unreachable' }
  let parsed: any = null
  try { parsed = JSON.parse(res.text) } catch { parsed = null }
  if (!res.ok) return { ok: false, error: String(parsed?.error ?? 'unreachable') }
  return { ok: true, index: Number(parsed?.index ?? 0), count: Number(parsed?.count ?? 1) }
}

/**
 * A session's own addressable name — what a PEER must pass as SendMessage's
 * `to`. Without this every session reported the literal "main", so dragging A
 * onto B addressed "main" rather than B: it logged a success and briefed the
 * wrong session. ListAgents opens with "This session is <name> — ...", which is
 * the only place a session can read its own name.
 */
/** Claude Code's own name for this session, or null.
 *
 *  There is no session-name call on `$` — `$.session` offers id, cwd, model,
 *  turnCount, repo, surface and messages and nothing else — so the folder name
 *  used to stand in for it, which made every session in one repo look alike.
 *  Claude Code does keep a name, in its pid index at
 *  `~/.claude/sessions/<pid>.json`, together with a `nameSource` saying whether
 *  a human set it or it was derived from the directory. Either beats the folder.
 *
 *  That index is Claude Code internal and undocumented, so this is a hint and
 *  never load-bearing: any failure leaves the previous name in place. It goes
 *  through `$.process.run` because `$.fs` is sandboxed to the working directory
 *  and this path is outside it — the same reason the transcript reader shells out.
 */
const readSessionName = async ($: Dollar, pid: string): Promise<string | null> => {
  if (!/^\d+$/.test(pid)) return null
  const home = await $.process.run(['printenv', 'HOME'], { timeoutMs: 5000 }).catch(() => null)
  const dir = home?.stdout.trim() ?? ''
  if (!dir.startsWith('/')) return null
  const res = await $.process
    .run(['cat', `${dir}/.claude/sessions/${pid}.json`], { timeoutMs: 5000 })
    .catch(() => null)
  if (!res || res.exitCode !== 0) return null
  try {
    const rec = JSON.parse(res.stdout) as { name?: unknown; sessionId?: unknown }
    // Pids get recycled. If the record names a different session than the one
    // this plugin is running in, it belongs to somebody else: take nothing.
    const s = M.state
    if (s && typeof rec.sessionId === 'string' && rec.sessionId !== s.sessionId) return null
    const name = typeof rec.name === 'string' ? rec.name.trim() : ''
    return name ? name.slice(0, 60) : null
  } catch {
    return null
  }
}

/** What the board should call this session: its real name when we have one,
 *  otherwise the repo or folder it runs in, as before. */
const displayName = (s: Hud): string =>
  M.sessionName || M.repo || M.cwd.split('/').pop() || s.sessionId.slice(0, 8)

/** Reads the pid once, then the name. The name is re-read on every refresh
 *  because a session can be renamed while it runs. */
const discoverPid = async ($: Dollar): Promise<void> => {
  if (M.pid) return
  const pid = await $.process.run(['sh', '-c', 'echo $PPID'], { timeoutMs: 4000 }).catch(() => null)
  M.pid = pid?.stdout.trim() ?? ''
}

/** The tmux session this Claude is running inside, so the board can group the
 *  switchboard's cards by it. `TMUX` is set in the plugin's environment when
 *  there is one, and `tmux display-message -p '#{session_name}'` names it.
 *
 *  Asked ONCE: a session does not move between tmux sessions, and the answer
 *  for the far commoner case -- not in tmux at all -- would otherwise be
 *  re-shelled on every push. Every failure path leaves `M.tmux` empty, which
 *  the relay and the board both read as "no tmux", so nothing about this is
 *  load-bearing: no tmux, no tmux binary, a dead server, all degrade to the
 *  ungrouped board that shipped before it.
 *
 *  It shells out for the same reason readSessionName does -- `$.fs` is
 *  sandboxed to the working directory and this is not a file at all. */
const discoverTmux = async ($: Dollar): Promise<void> => {
  if (M.tmuxAsked) return
  M.tmuxAsked = true
  const env = await $.process.run(['printenv', 'TMUX'], { timeoutMs: 4000 }).catch(() => null)
  if (!env || env.exitCode !== 0 || !env.stdout.trim()) return
  const res = await $.process
    .run(['tmux', 'display-message', '-p', '#{session_name}'], { timeoutMs: 4000 })
    .catch(() => null)
  if (!res || res.exitCode !== 0) return
  const name = res.stdout.trim()
  if (name) M.tmux = name.slice(0, 60)
}

const discoverName = async ($: Dollar): Promise<void> => {
  const res = await $.tool.call({ tool: 'ListAgents' } as never).catch(() => null)
  const text = res && typeof res === 'object' && 'text' in res ? String((res as { text?: string }).text ?? '') : ''
  const found = /This session is\s+(.+?)\s+[—-]\s/.exec(text)
  if (!found) return
  // The bracketed ref disambiguates only when two sessions share a name; the
  // bare name is what ListAgents says to prefer.
  const name = found[1]!.replace(/\s*\[[0-9a-f]+\]\s*$/i, '').trim()
  if (name) M.agentName = name
}

const registerSession = async ($: Dollar): Promise<void> => {
  const s = M.state
  if (M.headless || !s || !M.relayUp) return
  await relayPost($, '/api/register', {
    session: {
      id: s.sessionId,
      name: displayName(s),
      agentName: M.agentName,
      cwd: M.cwd,
      // root feeds claim inheritance: the relay requires an absolute,
      // existing directory (isAbsolute+existsSync+isDirectory), which M.cwd is
      // and M.repo (a display name, see the claim_work branch in serveTool,
      // below) never is.
      root: M.cwd,
      repo: M.repo,
      branch: M.branch,
      model: shortModel(M.modelLabel || s.modelId || 'unknown'),
      pid: M.pid,
      startedAt: s.startedAt,
      transcript: s.transcript ?? '',
    },
  })
}

const pushStats = async ($: Dollar): Promise<void> => {
  const s = M.state
  if (!s || !M.relayUp) return
  const { usd } = spendOf(s)
  const events = M.pending
  M.pending = []
  const sent = await relayPost($, '/api/stats', {
    id: s.sessionId,
    name: displayName(s),
    tmux: M.tmux,
    branch: M.branch,
    model: shortModel(M.modelLabel || s.modelId || 'unknown'),
    working: M.turnStartedAt !== null,
    status: s.narration || (M.turnStartedAt !== null ? 'Working…' : 'Idle.'),
    needs: M.needs,
    lastAnswer: M.lastAnswer,
    lastAnswerAt: M.lastAnswerAt,
    // Also on the heartbeat, not only in the register body: boot registers
    // before the first refresh has looked for the file, so the path is not
    // known yet at that point and a session's chain could never be rebuilt
    // from its own transcript.
    transcript: s.transcript ?? '',
    spin: { mode: M.spinMode, word: M.spinWord, id: M.spinnerId },
    stats: {
      ctx: s.ctx,
      ctxLimit: M.contextLimit,
      outTok: s.outTok,
      spend: usd,
      tools: s.tools,
      guardrails: s.guardrails,
      errors: s.errors,
      diff: s.diff,
    },
    agents: M.agents,
    files: s.files,
    point: {
      t: Date.now(),
      tokens: s.throughput[s.throughput.length - 1] ?? 0,
      spend: usd,
      ctx: s.ctx,
    },
    events,
  })
  // The relay expires a session after its TTL and forgets everything on a
  // restart; a 404 here means we have been dropped from the board, so rejoin
  // rather than push into the void for the rest of the session.
  if (sent === null && M.lastStatus === 404) {
    await registerSession($)
  } else if (sent === null && M.lastStatus === 0) {
    // Drop the flag and stop. Recovery belongs to heartbeat(), NOT here: this
    // function returns early while `relayUp` is false, so a re-check written
    // below that return only ever gets the one instant the relay went down.
    // Miss it and the session was off the board until /reload-plugins.
    M.relayUp = false
  }
}

/** One record per finished turn: what it was asked, what it answered, what it
 *  touched. Heads only -- the relay never needs the transcript's text and must
 *  never be handed it. A subagent's turn is folded into its parent's count
 *  rather than posted: a subagent is not a topic of its own. */
const postChainTurn = async ($: Dollar, e: TurnCompleteInput): Promise<void> => {
  if (e.agentId) { M.subturns += 1; return }
  const s = M.state
  if (!s) return
  const prompt = M.chainPrompt
  M.chainPrompt = null
  // relayPost answers null when headless or offline, so a lost record is a gap in the chain, never a stalled turn.
  await relayPost($, '/api/chain/turn', {
    sessionId: s.sessionId,
    turn: {
      id: e.turnId, at: Date.now(), durationMs: e.durationMs, reason: e.reason,
      origin: prompt?.origin ?? 'unknown',
      promptHead: prompt?.head ?? '',
      // The excerpt is the END of the answer, because that is where a turn says what it did.
      answerHead: String(e.answer ?? '').trim().slice(-CHAIN_HEAD_MAX),
      files: [...M.turnFiles], tools: M.turnTools, subturns: M.subturns,
    },
  }).catch(() => {})
}

/** The heartbeat. Recovery has to live ABOVE pushStats' early return, on the
 *  ticker, or it is unreachable for exactly as long as it is needed: a relay
 *  that blinks and comes back a second later would never be noticed. Observed
 *  before this existed -- a killed relay latched eleven live sessions off
 *  within one heartbeat and restarting it recovered none of them. */
const heartbeat = async ($: Dollar): Promise<void> => {
  if (M.headless) return
  if (!M.relayUp) {
    const back = await $.http.fetch(relayUrl('/api/health')).catch(() => null)
    if (!back?.ok) return
    M.relayUp = true
    await registerSession($)
    // The band reads `pane offline` off M.relayUp. The 1 s ticker only redraws
    // when the clock label changes, so an idle session would keep saying it for
    // up to a minute after coming back. A ticker is a legal place to invalidate.
    $.ui.invalidate('ui.render')
  }
  await pushStats($)
}

/** Steering: the pane queues verbs, this drains and runs them.
 *
 *  Exported so `test/harness.mjs` can drive one verb directly against the mock
 *  `$`. It is still declared at the top level and still only ever spells
 *  `$.noun.verb(...)`, so the platform's two hard constraints hold -- exporting
 *  is not binding. */
export const runCommand = async ($: Dollar, cmd: any): Promise<void> => {
  const p = cmd?.payload ?? {}
  try {
    if (cmd.verb === 'prompt' && typeof p.text === 'string') {
      note({ kind: 'note', label: 'steered from the pane', detail: p.text.slice(0, 90), internal: true })
      await $.prompt.submit({ text: p.text })
    } else if (cmd.verb === 'speak' && typeof p.text === 'string') {
      await $.audio.speak(p.text).catch(() => {})
    } else if (cmd.verb === 'abort') {
      // The id comes from our own turn.start, not from the caller: the pane has
      // no way to know it, which is why this was previously a silent no-op.
      const turnId = M.turnId
      if (turnId !== null) {
        await $.turn.abort({ turnId }).catch(() => {})
        note({ kind: 'turn', label: 'turn aborted from the pane', internal: true })
      } else {
        note({ kind: 'note', label: 'abort ignored', detail: 'no turn is running', internal: true })
      }
    } else if (cmd.verb === 'rename' && typeof p.name === 'string') {
      await renameSession($, p.name)
    } else if (cmd.verb === 'kill-agent' && typeof p.agentId === 'string') {
      await $.tool.call({ tool: 'TaskStop', task_id: p.agentId } as never).catch(() => {})
      note({ kind: 'agent', label: 'kill sent', detail: p.agentId, internal: true })
    } else if (cmd.verb === 'send-message') {
      await sendBrief($, p)
    } else if (cmd.verb === 'fill' && typeof p.text === 'string' && p.text) {
      // Reload a pasteboard entry. `$.prompt.fill` writes the person's draft
      // "replacing what it held" -- so this DESTROYS whatever was typed here,
      // which is why every surface that offers it says so, and why a refusal
      // is reported rather than swallowed.
      const res = await $.prompt.fill({ text: p.text }).catch(() => ({ isFilled: false }))
      const ok = !!(res as { isFilled?: boolean })?.isFilled
      note({
        kind: 'note',
        label: ok ? 'pasteboard → composer' : 'pasteboard fill refused',
        detail: ok ? p.text.slice(0, 90) : 'a dialog holds the keys, or this session has no composer',
        status: ok ? undefined : 'error',
        internal: true,
      })
      M.notice = {
        text: ok
          ? 'reloaded from the pasteboard — the composer was replaced'
          : 'pasteboard: could not fill — a dialog holds the keys',
        at: $.clock.now(),
        seq: M.turnSeq,
      }
      // No invalidate here: pollCommands already invalidates once when its
      // batch was non-empty, and this runs inside that loop.
    }
  } catch (err) {
    note({ kind: 'note', label: 'command failed', detail: String(err).slice(0, 100), status: 'error', internal: true })
  }
}

/** Rename this session the way a person typing `/rename` in the TUI does.
 *
 *  Not `$.prompt.submit({ text: '/rename x' })`. The engine refuses that on
 *  purpose -- *"a text beginning with / would run a command as the user; run
 *  one with $.command.run({ command })"* -- and it is right to: submitting is
 *  for prompts, and a plugin typing a slash command into the composer would be
 *  impersonating the user. `$.command.run` is the sanctioned door.
 *
 *  Verified live, because nothing else could establish it: after this call the
 *  session's record at `~/.claude/sessions/<pid>.json` reads
 *  `nameSource: 'user'`, which is exactly what the TUI's own `/rename`
 *  produces. `readSessionName()` above then picks the new name up on the next
 *  refresh and it reaches the board by the ordinary `/api/stats` push, so
 *  there is nothing to report on success.
 *
 *  Name rules are Claude Code's, not ours: the relay rejects only what it must
 *  and `/rename` is authoritative beyond that, so whatever it says comes back
 *  as the note rather than being second-guessed here. */
const renameSession = async ($: Dollar, name: string): Promise<void> => {
  const asked = name.trim()
  if (!asked) return
  try {
    const res = await $.command.run({ command: 'rename', args: asked })
    const said = typeof res?.text === 'string' ? res.text.trim() : ''
    // A successful /rename prints nothing; anything it does say is a refusal
    // or a caveat, and whoever asked for the rename should see it.
    if (said) note({ kind: 'note', label: 'rename', detail: said.slice(0, 110), internal: true })
    // Re-read the name NOW rather than waiting for the next refresh(), which
    // runs only at session.start, turn.step and turn.complete. An idle session
    // fires none of those, and an idle session is exactly the one somebody
    // renames from the board -- so without this the card kept its old name
    // until the session next did some work, which looked like the rename
    // having failed. Observed on the live check, and cheaper than refresh():
    // one `cat` of the file whose single changed field this is.
    const now = await readSessionName($, M.pid).catch(() => null)
    if (now) M.sessionName = now
  } catch (err) {
    note({ kind: 'note', label: 'rename refused', detail: String(err).slice(0, 110), status: 'error', internal: true })
  }
}

/** Drag A → B on the board: A briefs B over the real messaging bus. */
const sendBrief = async ($: Dollar, p: any): Promise<void> => {
  const s = M.state
  if (!s) return
  const recent = M.pending.slice(-6).map((e) => `· ${e.label}${e.detail ? ` — ${e.detail}` : ''}`).join('\n')
  const message =
    `Session ${M.repo || M.cwd} (${M.branch ?? 'no branch'}) is sharing context from the session board.\n\n` +
    `Working directory: ${M.cwd}\n` +
    `Status: ${s.narration || 'no narration'}\n` +
    `Context: ${compact(s.ctx)} of ${compact(M.contextLimit)}; spend ${money(spendOf(s).usd)}.\n` +
    (recent ? `\nRecent activity:\n${recent}\n` : '') +
    (p.note ? `\nNote: ${p.note}\n` : '')
  const to = String(p.toName || p.toId || '')
  if (!to) return
  if (to === M.agentName) {
    note({
      kind: 'agent', label: 'brief not sent', status: 'error', internal: true,
      detail: `target resolved to this session's own name (${to})`,
    })
    return
  }
  const res = await $.tool
    .call({ tool: 'SendMessage', to, summary: 'linked from the session board', message } as never)
    .catch((err: unknown) => ({ deny: String(err) }) as any)
  const failed = res && typeof res === 'object' && 'deny' in res && (res as any).deny
  note({
    kind: 'agent',
    label: failed ? `brief to ${to} refused` : `briefed ${to}`,
    detail: failed ? String((res as any).deny).slice(0, 110) : 'over the messaging bus',
    status: failed ? 'error' : undefined,
    internal: true,
  })
}

const pollCommands = async ($: Dollar): Promise<void> => {
  if (M.headless) return
  const s = M.state
  if (!s || !M.relayUp) return
  const res = await $.http
    .fetch(relayUrl(`/api/commands/${encodeURIComponent(s.sessionId)}?token=${M.token}`))
    .catch(() => null)
  if (!res || !res.ok) return
  let list: any[] = []
  try {
    list = JSON.parse(res.text).commands ?? []
  } catch {
    return
  }
  for (const cmd of list) await runCommand($, cmd)
  if (list.length) $.ui.invalidate('ui.render')
}

// ------------------------------------------------- statusline & hotkey files

/** $HOME, asked for once.
 *
 *  `$.fs` is sandboxed to the working directory, so everything under
 *  `~/.claude` has to be reached by shelling out -- the same constraint
 *  `readSessionName()` and the transcript reader already work around. */
const homeDir = async ($: Dollar): Promise<string> => {
  if (M.home) return M.home
  const res = await $.process.run(['printenv', 'HOME'], { timeoutMs: 5000 }).catch(() => null)
  const dir = res?.stdout.trim() ?? ''
  if (dir.startsWith('/')) M.home = dir
  return M.home
}

/** The worktree root this session's project config belongs to, or '' when the
 *  session is not in a git worktree.
 *
 *  `git rev-parse --show-toplevel`, run with the session cwd -- the SAME
 *  command pane-v2's HOTKEYS mode runs, so the two cannot disagree about which
 *  file a slot lives in. The two shortcuts that look right are both wrong:
 *  `registerSession` POSTs `root: M.cwd`, which is the cwd wearing that name,
 *  and `$.session.repo()` answers the MAIN working tree's root -- which would
 *  send every linked worktree's band to the main checkout's file.
 *
 *  Memoised on the cwd it was resolved for, the way `homeDir` is: `loadHotkeys`
 *  calls this at every turn boundary, in a function whose subprocess count has
 *  already been trimmed once. */
const projectRoot = async ($: Dollar): Promise<string> => {
  if (!M.cwd) return ''
  if (M.projectRootFor === M.cwd) return M.projectRoot
  const res = await $.process
    .run(['git', 'rev-parse', '--show-toplevel'], { cwd: M.cwd, timeoutMs: 5000 })
    .catch(() => null)
  // Recorded even when git refuses, so a cwd outside a repository is asked once
  // and not once a turn. A non-zero exit is the answer "no worktree here".
  M.projectRootFor = M.cwd
  M.projectRoot = res && res.exitCode === 0 ? res.stdout.trim() : ''
  return M.projectRoot
}

/** Where the project's hotkey overrides live, given that root. Pure, and
 *  exported, so both branches are asserted without a subprocess: at the root
 *  when there is one, and the cwd-relative read when there is not -- which is
 *  what `$.process.run` resolves against anyway. */
export const projectHotkeysPath = (root: string): string =>
  root ? `${root}/.claude/${HOTKEYS_FILE}` : `.claude/${HOTKEYS_FILE}`

/** The context window the status line implies for THIS session, or null.
 *
 *  Claude Code pipes the statusLine command `.context_window.used_percentage`,
 *  which is the only place the real window is observable at all, and the
 *  wrapper in `~/.claude/statusline-command.sh` drops that JSON here.
 *
 *  Keyed by session id, and that is load-bearing: every session on the machine
 *  writes into this one directory, and another session's percentage divided
 *  into our own ctx would produce a confident, wrong window rather than no
 *  answer. Every failure path returns null and leaves the table's answer
 *  standing, so nothing here is load-bearing on an undocumented file surviving. */
const readStatusline = async ($: Dollar, sessionId: string, ctx: number): Promise<number | null> => {
  const home = await homeDir($)
  if (!home) return null
  const res = await $.process
    .run(['cat', `${home}/${STATUSLINE_DIR}/${sessionId}.json`], { timeoutMs: 4000 })
    .catch(() => null)
  if (!res || res.exitCode !== 0) return null
  try {
    const d = JSON.parse(res.stdout) as {
      context_window?: { context_window_size?: number; used_percentage?: number }
      szg_written_at?: number
    }
    const at = d.szg_written_at
    if (typeof at !== 'number') return null
    const age = $.clock.now() - at * 1000
    if (age < 0) return null

    // Verified on 2.1.269: the payload STATES the window. Nothing to derive,
    // nothing to snap, and no dependence on our own token accounting agreeing
    // with Claude Code's -- which it need not, since `used_percentage` is
    // computed against the status line's own total, not against `s.ctx`.
    const stated = d.context_window?.context_window_size
    if (typeof stated === 'number' && stated > 0 && age <= STATUSLINE_STATED_MAX_AGE_MS) {
      return stated
    }

    // Older builds, or a payload that drops the field: divide instead.
    const pct = d.context_window?.used_percentage
    if (typeof pct !== 'number') return null
    return derivedWindow(ctx, pct, age)
  } catch {
    return null
  }
}

/** Resolve the eight prompt slots: the global file, with the project's file
 *  written over it slot by slot.
 *
 *  A global file that will not parse falls back to the shipped defaults; one
 *  that parses to nothing is taken at its word.
 *
 *  BOTH files are read by subprocess. It used to use `$.fs.readFile`, and that
 *  is precisely the
 *  problem: the plugin API renamed `$.fs.readFile` to `$.fs.read` between two
 *  builds, so the call became a synchronous TypeError thrown before its
 *  own `.catch` could attach. The caller's `.catch(() => {})` then swallowed
 *  it and NEITHER file was read: the band silently kept DEFAULT_HOTKEYS and
 *  DEFAULT_SETTINGS, and editing either config file did nothing at all. `cat`
 *  costs one more subprocess per turn boundary in a function that already
 *  spawns one, and it cannot break again the next time `$.fs` is reshaped. */
const loadHotkeys = async ($: Dollar): Promise<void> => {
  const home = await homeDir($)
  let globalText = ''
  if (home) {
    const res = await $.process
      .run(['cat', `${home}/.claude/${HOTKEYS_FILE}`], { timeoutMs: 4000 })
      .catch(() => null)
    if (res && res.exitCode === 0) globalText = res.stdout
  }
  // At the worktree ROOT, which is where pane-v2's HOTKEYS mode writes it. A
  // session started in a subdirectory used to read a different file from the
  // one the pane edited, and nothing said so.
  const proj = await $.process
    .run(['cat', projectHotkeysPath(await projectRoot($))], { timeoutMs: 4000 })
    .catch(() => null)
  const project = proj && proj.exitCode === 0 ? proj.stdout : ''

  const globals = globalText ? parseHotkeys(globalText) : null
  const overrides = project ? parseHotkeys(project) : null
  M.hotkeys = mergeHotkeys(globals ?? DEFAULT_HOTKEYS, overrides ?? [])
  M.settings = mergeSettings(
    globalText ? parseSettings(globalText) : null,
    project ? parseSettings(project) : null,
  )
  // Re-resolved every call, same as the settings merge just above: a config
  // file edited mid-session (by hand, `just spinner`, or the pane's gear)
  // lands here at the next turn boundary, not the next session. See
  // resolveSpinnerId for the precedence.
  const stored = await $.store.get('spinner').catch(() => undefined)
  M.spinnerId = resolveSpinnerId(M.settings.spinner, stored)
}

// ------------------------------------------------------------------- refresh

const refresh = async ($: Dollar): Promise<void> => {
  // Nothing in a headless child consumes this. It reads the transcript, the
  // statusline drop, both hotkey files and four git commands, and the only
  // consumers are the band (which is not drawn) and the relay push (which is
  // off). Left ungated it was the whole remaining cost: eleven subprocesses a
  // turn, measured by the harness.
  if (M.headless || M.refreshing || !M.state) return
  M.refreshing = true
  try {
    const s = M.state
    await ingest($, s).catch(() => false)

    const label = await $.session.model().catch(() => '')
    if (label) M.modelLabel = label

    // Three layers, weakest first. CONTEXT_WINDOWS is an assumption about the
    // model; the status line is the only real observation of the window
    // available anywhere at all; and windowAtLeast is the floor that
    // corrects either of them from what the session has actually used.
    let limit = windowFor(s.modelId, M.modelLabel)
    const observed = await readStatusline($, s.sessionId, s.ctx).catch(() => null)
    if (observed) limit = observed
    if (s.ctx > limit) limit = windowAtLeast(s.ctx)
    M.contextLimit = limit

    // Cheap, and it is what makes an edit to either hotkey file land at the
    // next turn boundary instead of the next session.
    await loadHotkeys($).catch(() => {})

    const cwd = await $.session.cwd().catch(() => '')
    if (cwd) {
      M.cwd = cwd
      const head = await $.process
        .run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 5000 })
        .catch(() => null)
      if (head && head.exitCode === 0) {
        M.branch = head.stdout.trim() || null
        const unstaged = await $.process.run(['git', 'diff', '--quiet'], { cwd, timeoutMs: 5000 }).catch(() => null)
        const staged = await $.process.run(['git', 'diff', '--cached', '--quiet'], { cwd, timeoutMs: 5000 }).catch(() => null)
        M.dirty = (unstaged?.exitCode ?? 0) !== 0 || (staged?.exitCode ?? 0) !== 0
        const stat = await $.process
          .run(['git', 'diff', '--shortstat', 'HEAD'], { cwd, timeoutMs: 6000 })
          .catch(() => null)
        if (stat && stat.exitCode === 0) {
          const add = /(\d+) insertion/.exec(stat.stdout)
          const del = /(\d+) deletion/.exec(stat.stdout)
          s.diff = { added: add ? Number(add[1]) : 0, removed: del ? Number(del[1]) : 0 }
        }
      } else {
        M.branch = null
      }
    }

    const repo = await $.session.repo().catch(() => null)
    M.repo = repo?.name ?? (repo ? repo.root.split('/').pop() ?? null : null)

    const named = await readSessionName($, M.pid).catch(() => null)
    if (named) M.sessionName = named

    M.agents = await $.agent.list().catch(() => [])

    persist($)
    $.ui.invalidate('ui.render')
  } finally {
    M.refreshing = false
  }
}

/** What one band completion cost, as far as it can be seen: the plugin API
 *  answers text only, so tokens are estimated at four characters each and
 *  no cost is claimed. */
export const bandSpendBody = (site: string, model: string, prompt: string, reply: string) => ({
  kind: 'band', site, model,
  usage: { input: Math.ceil(prompt.length / 4), output: Math.ceil(reply.length / 4) },
  estimated: true,
})
const recordBandSpend = ($: Dollar, site: string, model: string, prompt: string, reply: string): void => {
  void relayPost($, '/api/spend', bandSpendBody(site, model, prompt, reply))
}

/** One plain-English sentence about what just happened, on the small fast
 *  model, written to state and never generated on the render path. */
const narrate = async ($: Dollar): Promise<void> => {
  const s = M.state
  if (!s || !NARRATE) return
  const now = Date.now()
  if (now - M.narrationAt < 8000) return
  M.narrationAt = now
  const recent = M.pending.slice(-8).map((e) => `${e.label}${e.detail ? `: ${e.detail}` : ''}`).join('\n')
  if (!recent) return
  const prompt =
    'These are the last actions a coding agent took. In ONE short sentence (max 12 words), ' +
    'say what it is doing and why. No preamble.\n\n' + recent
  const text = await $.model
    .complete({
      model: 'haiku',
      maxTokens: 60,
      prompt,
    })
    .catch(() => '')
  if (text) {
    s.narration = text.trim().replace(/^["']|["']$/g, '').slice(0, 120)
    recordBandSpend($, 'narrate', 'haiku', prompt, text)
    $.ui.invalidate('ui.render')
  }
}

const detectStuck = ($: Dollar): void => {
  const s = M.state
  if (!s) return
  // A file that went quiet is no longer a stuck signal, however many times it
  // was edited earlier in the session. Without this the warning latches on for
  // good, which is what the `dismiss` button was there to paper over -- and
  // could not, since it never cleared `s.files`.
  const now = $.clock.now()
  const hot = Object.entries(s.files).find(
    ([path, n]) => n >= STUCK_EDITS && now - (M.fileAt[path] ?? 0) < STUCK_COOL_MS,
  )
  const prior = M.stuck
  M.stuck = s.errors >= STUCK_ERRORS
    ? `${s.errors} tool failures in a row`
    : hot
      ? `${hot[0].split('/').pop()} edited ${hot[1]}×`
      : null
  if (M.stuck && M.stuck !== prior) {
    note({ kind: 'note', label: 'stuck signal', detail: M.stuck, status: 'error', internal: true })
    $.ui.invalidate('ui.render')
  }
}

const chime = async ($: Dollar, kind: 'tool' | 'done' | 'deny'): Promise<void> => {
  if (!SONIFY) return
  if (kind === 'done') await $.audio.speak('Turn complete.').catch(() => {})
}

// --------------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'ask_human',
    description:
      'Ask the user a question and wait for their answer. The question appears in the Syzygy ' +
      'browser pane and in the terminal band. Returns their answer, or tells you to check back later ' +
      'if they have not answered within a minute. Use for genuine decisions only.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, in one clear sentence.' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional choices to offer.' },
        context: { type: 'string', description: 'One line of background, shown under the question.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'remember',
    description: 'Store a durable note for this project that survives across sessions. Use for decisions and constraints.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, tag: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'recall',
    description: 'Search the notes stored by `remember`, and this session\'s own tool history, for a phrase.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'think_harder',
    description:
      'Ask a more capable model one focused question and get its answer back. Costs a separate call; ' +
      'use for a hard sub-problem, not for routine work.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string' }, model: { type: 'string', description: 'Optional model alias.' } },
      required: ['question'],
    },
  },
  {
    name: 'calc',
    description: 'Evaluate an arithmetic expression exactly. Use instead of doing arithmetic in your head.',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'e.g. "(1200*0.15)/3"' } },
      required: ['expression'],
    },
  },
  {
    name: 'pane_event',
    description:
      'Post a labelled event to the Syzygy pane so the user can see what you are doing. ' +
      'Cheap and non-blocking. Use at milestones, not every step.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        detail: { type: 'string' },
        status: { type: 'string', enum: ['ok', 'error', 'deny'] },
      },
      required: ['label'],
    },
  },
  {
    name: 'report_finding',
    description:
      'Record ONE fact you learned that would change another session\'s work — not what you did, ' +
      'what surprised you. Facts only: somebody with the whole picture does the judging. ' +
      'Requires at least one `path:line` so a peer can check it. Call it once per finding.',
    inputSchema: {
      type: 'object',
      properties: {
        surprise: { type: 'string', description: 'One line. The fact itself, never a recommendation.' },
        kind: {
          type: 'string',
          enum: ['constraint', 'drift', 'hazard', 'dead-code', 'duplicate', 'question'],
          description:
            'constraint: a flag/API/platform behaviour that binds other work. drift: code and its ' +
            'doc/spec/plan disagree. hazard: a path that silently answers wrong. dead-code: reachable ' +
            'by nothing. duplicate: two implementations of one thing. question: a shape question raised.',
        },
        touched: { type: 'array', items: { type: 'string' }, description: 'Files or subsystems it came out of.' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'At least one "path:line".' },
      },
      required: ['surprise', 'kind', 'evidence'],
    },
  },
  {
    name: 'propose_pattern',
    description:
      'Propose ONE repeated pattern worth turning into a reusable skill — not an observation, ' +
      'and not something you are about to build. It queues as a candidate a person rates and a ' +
      'later session may be dispatched to build. Requires the methodology as ordered steps ' +
      'somebody else could follow, and at least one "path:line" or session reference. ' +
      'Proposing nothing is the normal outcome of a session; call this at most once.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One line naming the pattern.' },
        idea: { type: 'string', description: 'What the pattern is, in a sentence or two.' },
        methodology: {
          type: 'string',
          description: 'The ordered steps somebody else could follow. A candidate with no methodology is a flag, not a proposal.',
        },
        kind: {
          type: 'string',
          enum: ['skill', 'shape', 'kickoff', 'claude-md'],
          description:
            'skill: a reusable skill to build. shape: a better shape for something that already exists. ' +
            'kickoff: a prompt worth keeping. claude-md: a project instruction worth writing down.',
        },
        evidence: { type: 'array', items: { type: 'string' }, description: 'At least one "path:line" or session reference.' },
      },
      required: ['title', 'idea', 'methodology', 'evidence'],
    },
  },
  {
    name: 'claim_work',
    description:
      'Record what this session is working on, so the side pane can show you your own todos and ' +
      'not another session\'s. Claim a plan by its filename (e.g. "-projects-tab.md") ' +
      'and/or a backlog entry as "docs/TASKS.md#<heading-slug>". Call again to replace this session\'s claim. ' +
      'Call this when you start work on a plan or backlog entry, and call release_work when you stop.',
    inputSchema: {
      type: 'object',
      properties: {
        plans: { type: 'array', items: { type: 'string' }, description: 'Plan filenames, basename only.' },
        backlog: { type: 'array', items: { type: 'string' }, description: 'docs/TASKS.md#<heading-slug> entries.' },
        note: { type: 'string', description: 'One line about what you are actually doing.' },
      },
      required: [],
    },
  },
  {
    name: 'release_work',
    description: 'Drop this session\'s claim, so its todos stop showing as yours.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
]

const registerTools = async ($: Dollar): Promise<void> => {
  for (const t of TOOLS) await $.tool.register(t).catch(() => null)
}

/** Arithmetic without a model: a tiny shunting-yard evaluator, digits and
 *  operators only, so nothing here can execute arbitrary input. */
const evaluate = (expr: string): number => {
  const tokens = expr.match(/\d+\.?\d*|[()+\-*/%^]/g)
  if (!tokens || tokens.join('') !== expr.replace(/\s+/g, '')) throw new Error('unsupported characters')
  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 }
  const out: number[] = []
  const ops: string[] = []
  const apply = (op: string) => {
    const b = out.pop(), a = out.pop()
    if (a === undefined || b === undefined) throw new Error('malformed expression')
    out.push(op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b
      : op === '/' ? a / b : op === '%' ? a % b : Math.pow(a, b))
  }
  for (const tk of tokens) {
    if (/^\d/.test(tk)) out.push(Number(tk))
    else if (tk === '(') ops.push(tk)
    else if (tk === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') apply(ops.pop()!)
      if (ops.pop() !== '(') throw new Error('unbalanced parentheses')
    } else {
      while (ops.length && ops[ops.length - 1] !== '(' && prec[ops[ops.length - 1]!]! >= prec[tk]!) apply(ops.pop()!)
      ops.push(tk)
    }
  }
  while (ops.length) {
    const op = ops.pop()!
    if (op === '(') throw new Error('unbalanced parentheses')
    apply(op)
  }
  if (out.length !== 1) throw new Error('malformed expression')
  return out[0]!
}

const serveTool = async ($: Dollar, name: string, args: Record<string, unknown>): Promise<string> => {
  const s = M.state

  if (name === 'calc') {
    try {
      return `${evaluate(String(args.expression ?? ''))}`
    } catch (err) {
      return `calc error: ${String(err instanceof Error ? err.message : err)}`
    }
  }

  if (name === 'pane_event') {
    note({
      kind: 'note',
      label: String(args.label ?? 'event'),
      detail: args.detail ? String(args.detail).slice(0, 140) : undefined,
      status: args.status === 'error' || args.status === 'deny' ? String(args.status) : undefined,
    })
    $.ui.invalidate('ui.render')
    return 'posted to the pane'
  }

  if (name === 'remember') {
    const key = `notes:${M.repo || M.cwd}`
    const prior = ((await $.store.get(key).catch(() => [])) as any[]) ?? []
    const entry = { t: Date.now(), text: String(args.text ?? ''), tag: String(args.tag ?? '') }
    await $.store.set(key, [...prior, entry].slice(-500))
    note({ kind: 'note', label: 'remembered', detail: entry.text.slice(0, 90) })
    return `stored (${prior.length + 1} notes for this project)`
  }

  if (name === 'recall') {
    const q = String(args.query ?? '').toLowerCase()
    const key = `notes:${M.repo || M.cwd}`
    const notes = ((await $.store.get(key).catch(() => [])) as any[]) ?? []
    const hits = notes.filter((n) => String(n.text).toLowerCase().includes(q)).slice(-12)
    const acts = M.pending.filter((e) => `${e.label} ${e.detail ?? ''}`.toLowerCase().includes(q)).slice(-8)
    if (!hits.length && !acts.length) return `no notes or recent actions matching "${q}"`
    return [
      hits.length ? 'Notes:\n' + hits.map((n) => `· ${new Date(n.t).toISOString().slice(0, 10)} ${n.text}`).join('\n') : '',
      acts.length ? 'This session:\n' + acts.map((e) => `· ${e.label}${e.detail ? ` — ${e.detail}` : ''}`).join('\n') : '',
    ].filter(Boolean).join('\n\n')
  }

  if (name === 'think_harder') {
    const model = String(args.model ?? 'claude-opus-5')
    const question = String(args.question ?? '')
    let failed = false
    const answer = await $.model
      .complete({
        model,
        maxTokens: 1200,
        prompt: question,
      })
      .catch((err: unknown) => {
        failed = true
        return `think_harder failed: ${String(err)}`
      })
    note({ kind: 'note', label: 'think_harder', detail: question.slice(0, 90) })
    if (!failed) recordBandSpend($, 'think_harder', model, question, answer)
    return answer
  }

  if (name === 'ask_human') {
    const question = String(args.question ?? '')
    const options = Array.isArray(args.options) ? args.options.map(String) : []
    note({ kind: 'note', label: 'asked the user', detail: question.slice(0, 100) })
    $.ui.invalidate('ui.render')
    const posted = await relayPost($, '/api/ask', {
      id: s?.sessionId,
      question,
      options,
      context: String(args.context ?? ''),
    })
    if (!posted?.questionId) {
      return 'The Syzygy pane is not running, so the question could not be shown. Ask in your reply instead.'
    }
    const deadline = Date.now() + ASK_TIMEOUT_MS
    while (Date.now() < deadline) {
      await $.clock.sleep(1000).catch(() => {})
      const poll = await relayPost($, '/api/ask/poll', { questionId: posted.questionId })
      if (poll?.answered) {
        await relayPost($, '/api/ask/close', { questionId: posted.questionId })
        note({ kind: 'note', label: 'human answered', detail: String(poll.answer).slice(0, 100) })
        return String(poll.answer)
      }
    }
    return `No answer yet. The question is still open in the pane as ${posted.questionId}; carry on with your best judgement and check back later.`
  }

  if (name === 'report_finding') {
    // .map(String).filter(Boolean) for the same reason claim_work does it: a
    // model can send { evidence: [123] }, which is an array and would survive
    // findings.mjs's sanitising as a number-shaped string nobody can open.
    const surprise = typeof args.surprise === 'string' ? args.surprise.trim() : ''
    if (!surprise) return 'Nothing recorded: `surprise` is the finding itself — one line saying what you learned.'
    const evidence = Array.isArray(args.evidence) ? args.evidence.map(String).filter(Boolean) : []
    // Refused HERE and not in the store. The store stays permissive on
    // purpose: an older writer, a hand edit and the orchestrator all reach
    // POST /api/findings. The tool is where specificity is free, because the
    // model is right here and can fix it.
    if (!hasLineEvidence(evidence)) {
      return 'Nothing recorded: at least one `evidence` entry needs a line number, like ' +
        '"syzygy/bridge/relay.mjs:738". A finding nobody can open is one nobody can check.'
    }
    const kind = typeof args.kind === 'string' ? args.kind : ''
    const touched = Array.isArray(args.touched) ? args.touched.map(String).filter(Boolean) : []
    // `session` and `project` are the PLUGIN's to fill, never the model's —
    // claim_work's rule. A model that could set `session` could attribute a
    // finding to somebody else. `id` and `t` are the relay's, and are not sent.
    const sent = await relayPost($, '/api/findings', {
      session: s ? displayName(s) : '', project: M.repo ?? '',
      kind, touched, surprise, evidence,
    })
    return sent ? 'Finding recorded.' : 'The relay did not accept the finding; is it running?'
  }

  if (name === 'propose_pattern') {
    // .map(String).filter(Boolean) for the reason claim_work and
    // report_finding both do it: a model can send { evidence: [123] }, which
    // is an array and would survive the store's sanitising as a
    // number-shaped string nobody can open.
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    const idea = typeof args.idea === 'string' ? args.idea.trim() : ''
    const methodology = typeof args.methodology === 'string' ? args.methodology.trim() : ''
    if (!title || !idea || !methodology) {
      return 'Nothing queued: a proposal needs a `title`, an `idea` and a `methodology` — the ordered ' +
        'steps somebody else could follow. Without the methodology it is a flag, not a candidate.'
    }
    const evidence = Array.isArray(args.evidence) ? args.evidence.map(String).filter(Boolean) : []
    // Refused HERE and not in the store, which stays permissive because a
    // hand edit and an older writer both reach it. The model is right here.
    if (!evidence.length) {
      return 'Nothing queued: `evidence` needs at least one entry — a "path:line" like ' +
        '"syzygy/bridge/relay.mjs:738", or the session and turn it came out of. A candidate nobody can check is one nobody will build.'
    }
    const kind = typeof args.kind === 'string' ? args.kind : ''
    // `session` and `project` are the PLUGIN's to fill, never the model's: a
    // model that could set `session` could attribute a proposal to somebody else.
    const who = s ? displayName(s) : ''
    const sent = await relayPost($, '/api/skills/propose', {
      source: 'session', session: who, project: M.repo ?? '',
      sessions: [who], kind, title, idea, methodology, evidence,
    })
    return sent ? 'Queued as a proposed skill. Nothing is built from it until a person rates it and preps it.'
      : 'The relay did not accept the proposal; is it running?'
  }

  if (name === 'claim_work') {
    if (!s) return 'No active session to claim on behalf of.'
    // .map(String) rather than an `as string[]` cast: a model can send
    // { plans: [123] }, which is still an array and would otherwise survive
    // as { kind: 'plan', id: 123 } -- an object, so claims.mjs's sanitation
    // lets it through, and it then silently never matches any plan basename.
    // .filter(Boolean) drops '' after coercion (e.g. a stray null/empty slot).
    const plans = Array.isArray(args.plans) ? args.plans.map(String).filter(Boolean) : []
    const backlog = Array.isArray(args.backlog) ? args.backlog.map(String).filter(Boolean) : []
    const items = [
      ...plans.map((id) => ({ kind: 'plan', id })),
      ...backlog.map((id) => ({ kind: 'backlog', id })),
    ]
    if (!items.length) return 'Nothing claimed: pass at least one plan or backlog entry.'
    // root: M.cwd, not M.repo -- M.repo is a display NAME (SessionRepo.name /
    // a folder basename, see displayName()), never an absolute path. The relay
    // validates root with isAbsolute+existsSync+isDirectory, so a
    // name would always fail that check and the claim would silently never
    // land. M.cwd is the absolute path this session already trusts as its
    // worktree (registerSession sends it as `cwd`; git commands in refresh()
    // already run with it as cwd).
    const sent = await relayPost($, '/api/claim', {
      sessionId: s.sessionId, name: displayName(s), root: M.cwd,
      items, note: typeof args.note === 'string' ? args.note : '',
    })
    return sent ? `Claimed ${items.length} item(s).` : 'The relay did not accept the claim; is it running?'
  }

  if (name === 'release_work') {
    if (!s) return 'No active session to release.'
    const sent = await relayPost($, '/api/release', { sessionId: s.sessionId, root: M.cwd })
    return sent ? 'Claim released.' : 'The relay did not accept the release; is it running?'
  }

  return `no handler for ${name}`
}

// ------------------------------------------------------------------ pressing
//
// A Button's onPress runs in the plugin's own environment. The engine refuses
// to let `$` be bound to anything, so the handlers are built inside the render
// hook, where `$` is in scope and every use is a direct `$.noun.verb(...)`.

/** A function, not a constant: `M.relayPort` is not known until session.start
 *  has read the environment, and a constant evaluated at module load would
 *  point a spawned session's band and its "open the pane" button at the wrong
 *  relay. */
const paneUrl = (): string => `http://localhost:${M.relayPort}/`

/** SZG_HEADLESS=1 means "this claude is a child of the relay, not a session
 *  a human is watching": the orchestrator's ask and blurb turns, and a scoping
 *  turn. Those are `claude -p` runs, and they load the installed plugin like
 *  any other session -- so before this existed they registered on the
 *  switchboard, appeared as a card named after the project, paid the whole
 *  session.start cost, and vanished again -- a card named after the project,
 *  with no explanation of what it was.
 *
 *  It arrives on the ARGV, as `--settings '{"env":{"SZG_HEADLESS":"1"}}'`, and
 *  only there: a `--bg` or `-p` child does not inherit the launcher's
 *  environment. Read with `printenv` for the same reason the
 *  other two SZG_ variables are: it is the channel that was actually verified.
 *
 *  What it turns off is everything that talks to the relay or shells out --
 *  the relay handshake, registration, the heartbeat, the command poll, and the
 *  three discovery subprocesses. The band's own state is still built, because
 *  other hooks read `M.state` and a half-initialised module is a worse failure
 *  than a wasted object. */
const boot = async ($: Dollar): Promise<void> => {
  const id = await $.session.id().catch(() => '')
  const now = $.clock.now()
  const stored = id ? await $.store.get(`hud:${id}`).catch(() => undefined) : undefined
  M.state =
    stored && typeof stored === 'object'
      ? { ...blank(id, now), ...(stored as Partial<Hud>), sessionId: id }
      : blank(id, now)
  M.cwd = await $.session.cwd().catch(() => '')
  M.autoClaimed = new Set()
  // A fresh session has no turn in flight, and a reload must not inherit one.
  M.chainPending = []
  M.chainPrompt = null
  M.turnFiles = new Set()
  M.turnTools = 0
  M.subturns = 0

  // Before every subprocess below, because the whole point is to pay none of
  // them. `readRelayEnv` short-circuits on SZG_HEADLESS and reads nothing else.
  await readRelayEnv($).catch(() => {})
  if (M.headless) {
    // Cancel first, then return. A fresh headless child has no timers to
    // cancel, so this is not for it -- it is for a reload, where boot() runs
    // again over a module that already has four intervals ticking. Returning
    // without cancelling would leave the previous boot's heartbeat and command
    // poll running against a relay this session is meant to be invisible to.
    M.spinner?.cancel(); M.spinner = null
    M.ticker?.cancel(); M.ticker = null
    M.pusher?.cancel(); M.pusher = null
    M.poller?.cancel(); M.poller = null
    return
  }

  await discoverPid($).catch(() => {})
  M.sessionName = (await readSessionName($, M.pid).catch(() => null)) ?? ''
  await discoverTmux($).catch(() => {})

  // The spawning relay's token is authoritative for a spawned session, and the
  // shared config file describes a DIFFERENT relay -- reading it would hand
  // this session the wrong token for the port it was told to use, and minting
  // one would overwrite the real relay's config. So skip it entirely.
  const cfg = M.tokenFromEnv ? { token: M.token } : await relayConfig($).catch(() => null)
  if (cfg) {
    M.token = cfg.token
    M.bridgePath = await findBridge($).catch(() => null)
    M.paneScript = await findPaneScript($).catch(() => null)
    await refreshPaneOpen($, true).catch(() => {})
    M.relayUp = await ensureRelay($).catch(() => false)
  }
  if (M.relayUp) {
    await discoverName($).catch(() => {})
    await registerSession($)
    note({ kind: 'note', label: 'session joined the board', detail: M.cwd, internal: true })
  }

  // A look is a preference, so the choice is global rather than per session.
  // Config settings are not loaded yet at this point in boot (loadHotkeys
  // runs inside the un-awaited refresh() just below), so this early resolve
  // only knows $.store; loadHotkeys re-resolves with the file's opinion, if
  // any, moments later. Avoids a session's first few frames flashing the
  // shipped default before a config-pinned spinner has had a chance to load.
  const chosen = await $.store.get('spinner').catch(() => undefined)
  M.spinnerId = resolveSpinnerId(undefined, chosen)

  M.spinner?.cancel()
  M.spinner = $.clock.every(SPIN_MS, () => {
    M.spin += 1
    // Only redraw while something is actually spinning, or an idle session
    // would repaint ten times a second for nothing.
    const live = M.turnStartedAt !== null || $.clock.now() < M.previewUntil
    if (live && M.spin % Math.max(1, spinnerById(M.spinnerId).every) === 0) {
      $.ui.invalidate('ui.render')
    }
  })

  M.ticker?.cancel()
  M.ticker = $.clock.every(1000, () => {
    const s = M.state
    if (!s) return
    M.frame += 1
    const precise = M.turnStartedAt !== null
    const base = precise ? M.turnStartedAt! : s.startedAt
    const label = elapsed($.clock.now() - base, precise)
    // Redraw every second while a turn runs (the clock and the decrypt move),
    // once a minute when idle (only the clock's minutes change).
    if (label !== M.lastClock || precise) {
      M.lastClock = label
      $.ui.invalidate('ui.render')
    }
    // Throttled inside to PANE_CHECK_MS. Catches a side pane the user closed
    // with tmux rather than with the button, so the label cannot go stale.
    void refreshPaneOpen($, false).catch(() => {})
  })

  M.pusher?.cancel()
  M.pusher = $.clock.every(PUSH_MS, () => { void heartbeat($) })

  M.poller?.cancel()
  M.poller = $.clock.every(POLL_MS, () => { void pollCommands($) })
}

// ---------------------------------------------------------------- the plugin

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await boot($)
    await registerTools($)
    void refresh($)
    return next(e)
  })

  // The pasteboard's whole trigger. A hooks module cannot read the composer --
  // $.prompt has submit/fill/suggest and no getter -- so the text is first
  // visible HERE, after Enter. A leading marker means "stash this instead",
  // and the submission is cancelled with `{ drop: reason }`, which the engine
  // shows the user as the reason (PromptSubmitResult).
  //
  // This is deliberately NOT in the '*' hook, which runs for every event and
  // is the hot path.
  on('prompt.submit', async ($, e, next) => {
    // Where a prompt came from, for the topic chain. turn.start hands over the
    // text but not the origin, so it is noted here and matched by text there.
    //
    // It OBSERVES rather than decides, and comes before the origin gate so
    // every origin is noted: nothing is rewritten or refused by it. A stashed
    // prompt starts no turn, so its entry never matches and simply ages out of
    // the queue. It is a line in this hook rather than a hook of its own
    // because a second prompt.submit registration without a matcher throws.
    M.chainPending = [
      ...M.chainPending,
      { head: String(e.text ?? '').slice(0, CHAIN_HEAD_MAX), origin: e.origin?.kind ?? 'unknown' },
    ].slice(-CHAIN_PENDING_MAX)

    // The user's own Enter at the terminal, and nothing else. A peer's
    // message, a scheduled trigger and -- the one that actually bites -- this
    // plugin's OWN $.prompt.submit from runCommand's `prompt` verb all arrive
    // here too, and a steering command whose text began with the marker would
    // otherwise be eaten by the plugin that sent it.
    if (e.origin?.kind !== 'composer') return next(e)
    const marker = normalizeMarker(M.settings.pasteboardMarker)
    // A configured marker that normalizes to nothing has switched stashing off.
    // Say so once per value, or the user keeps typing `,,` and wondering why
    // their prompts are sent.
    const configured = M.settings.pasteboardMarker
    if (typeof configured === 'string' && configured !== '' && marker === '' && M.markerWarned !== configured) {
      M.markerWarned = configured
      note({
        kind: 'note',
        label: 'pasteboard marker ignored',
        detail: `unusable value ${JSON.stringify(configured)} — stashing is off`,
        status: 'error',
        internal: true,
      })
    }
    const parsed = parseStash(e.text, marker)
    if (!parsed.stash) return next(e)

    const attachments = e.attachments?.length ?? 0
    const body = parsed.text
    if (!body.trim()) {
      M.notice = { text: 'nothing after the marker', at: $.clock.now(), seq: M.turnSeq }
      $.ui.invalidate('ui.render')
      return { drop: stashReason({ ok: false, error: 'empty', scope: parsed.scope, text: '', attachments, restored: false }) }
    }

    // A session stash needs this session's id. Without one the relay would
    // file it on the global board, which is not what the marker asked for, so
    // it is refused like any other failure rather than quietly widened.
    const s = M.state
    const r: StashPosted =
      parsed.scope === 'session' && !s
        ? { ok: false, error: 'no session' }
        : await stashText($, {
            sessionId: parsed.scope === 'global' ? null : (s?.sessionId ?? null),
            sessionName: s ? displayName(s) : M.sessionName,
            text: body,
            title: parsed.title ?? undefined,
            scope: parsed.scope,
          })

    let restored = false
    if (!r.ok) {
      // The drop already cleared the composer, so without this the text exists
      // nowhere at all. Put back what was TYPED, marker and all, so a retry is
      // one keystroke.
      const back = await $.prompt.fill({ text: e.text }).catch(() => ({ isFilled: false }))
      restored = !!back?.isFilled
    }

    const reason = stashReason({
      ...r, scope: parsed.scope, text: body, attachments, restored, title: parsed.title,
    })
    note({
      kind: 'note',
      label: r.ok ? 'stashed to the pasteboard' : 'stash refused',
      detail: (parsed.title ? parsed.title + ' — ' : '') + body.slice(0, 90),
      status: r.ok ? undefined : 'error',
      internal: true,
    })
    M.notice = { text: reason, at: $.clock.now(), seq: M.turnSeq }
    // Legal here: this is not the render hook, and a dropped submission starts
    // no turn, so nothing else would ever repaint the band.
    $.ui.invalidate('ui.render')
    return { drop: reason }
  })

  // Every event passes here. It must stay cheap and must never throw: the only
  // event it waits on is tool.call, where the result says how the call ended.
  on('*', ($, e, next) => {
    const event = next.event

    if (event === 'tool.call' && next.is('tool.call', e)) {
      const started = $.clock.now()
      const name = String((e as { tool: string }).tool)
      const args = e as unknown as Record<string, unknown>

      // Tools this plugin registered are served here; a call no hook answers fails.
      const mine = /^mcp__syzygy__(.+)$/.exec(name)
      if (mine) {
        // A plain string: 2.1.270 checks a hook's result against the tool's output
        // shape (string | array | undefined) and rejects `{ text }`, while the
        // tool's side effect has already run.
        return serveTool($, mine[1]!, args).then((text) => ({ result: text }) as never)
      }

      return next(e).then((result) => {
        const s = M.state
        if (!s) return result
        const denied = result && typeof result === 'object' && 'deny' in result && (result as any).deny
        const errored = result && typeof result === 'object' && (result as any).isError
        s.tools += 1
        M.turnTools += 1
        if (denied) { s.guardrails += 1; s.errors = 0 }
        else if (errored) s.errors += 1
        else s.errors = 0

        const command = typeof args.command === 'string' ? args.command : ''
        if (command && /\b(test|pytest|jest|vitest|go test|cargo test|just test|npm t)\b/.test(command)) {
          const text = (result && typeof result === 'object' && 'text' in result ? String((result as any).text) : '')
          const failed = errored || /\b(FAIL|failed|failing|\d+ failed)\b/.test(text)
          note({
            kind: 'turn',
            label: failed ? 'tests failed' : 'tests passed',
            detail: command.slice(0, 90),
            status: failed ? 'error' : undefined,
          })
        }

        const path = typeof args.file_path === 'string' ? args.file_path : ''
        if (path && /^(Edit|Write|NotebookEdit)$/.test(name)) {
          s.files[path] = (s.files[path] ?? 0) + 1
          // The files of THIS turn, beside the session's running count: a chain
          // block is about what a turn touched, not what the session has ever
          // touched.
          M.turnFiles.add(path)
          // The count alone cannot say whether the churn is happening NOW; it
          // only ever grows. detectStuck lapses the signal off this timestamp.
          M.fileAt[path] = $.clock.now()
        }
        // A session claims a plan the moment it first touches it -- editing it
        // or reporting/verifying a task in it -- so the board's per-session
        // view is right without anyone remembering to call claim_work. Fires
        // the same POST that tool makes, kind 'plan' only, fire-and-forget:
        // never awaited beyond this, and a failed or skipped POST leaves the
        // plan out of M.autoClaimed so the very next edit retries it. A
        // deliberate claim_work call still wins any race -- the relay merges
        // by session key, so whichever POST lands last is what stands.
        const claimedPlan = planFromToolCall(name, args)
        if (claimedPlan && M.relayUp && !M.autoClaimed.has(claimedPlan)) {
          M.autoClaimed.add(claimedPlan)
          void relayPost($, '/api/claim', {
            sessionId: s.sessionId, name: displayName(s), root: M.cwd,
            items: [{ kind: 'plan', id: claimedPlan }],
            note: 'auto: first edit',
          }).catch(() => {})
        }
        note({
          kind: 'tool',
          label: name,
          detail: summarizeInput(args),
          status: denied ? 'deny' : errored ? 'error' : 'ok',
          ms: $.clock.now() - started,
        })
        detectStuck($)
        // Persist here, not only on the next turn boundary: a hot reload
        // between turns would otherwise lose the counters.
        persist($)
        if (denied) { void chime($, 'deny'); $.ui.invalidate('ui.render') }
        return result
      })
    }

    if (event === 'agent.spawn' && next.is('agent.spawn', e)) {
      note({ kind: 'agent', label: `spawned ${e.subagentType}`, detail: e.description })
    } else if (event === 'turn.start' && next.is('turn.start', e)) {
      M.turnId = e.turnId
      M.turnStartedAt = $.clock.now()
      M.needs = ''   // whatever it asked for has been answered by now
      M.spin = 0
      M.turnSeq += 1
      M.lastClock = ''
      M.turnFiles = new Set()
      M.turnTools = 0
      M.subturns = 0
      ;({ prompt: M.chainPrompt, pending: M.chainPending } = chainPromptOf(e.text, M.chainPending))
      note({ kind: 'turn', label: 'turn started' })
      $.ui.invalidate('ui.render')
    } else if (event === 'turn.complete' && next.is('turn.complete', e)) {
      M.turnStartedAt = null
      M.turnId = null
      M.lastClock = ''
      note({
        kind: 'turn',
        label: `turn ${e.reason}`,
        detail: `${Math.round(e.durationMs / 1000)}s`,
        status: e.reason === 'error' ? 'error' : undefined,
      })
      // Set here rather than on the render path: it is a pure function of the
      // answer, computed once per turn instead of ten times a second.
      M.needs = NEEDS_ME ? needsHuman(e.answer, e.reason) : ''
      if (M.needs) note({ kind: 'note', label: 'waiting on you', detail: M.needs, internal: true })
      // The same place and the same reason, but not the same rule: this keeps
      // the text of ANY finished turn, aborted included, because the drawer
      // asks what the session last said rather than what it is waiting for.
      // An empty answer leaves the previous one standing -- a turn that showed
      // nothing has not replaced what was on screen before it.
      {
        const said = lastAnswerOf(e.answer)
        if (said) { M.lastAnswer = said; M.lastAnswerAt = Date.now() }
      }
      void refresh($)
      void narrate($)
      void chime($, 'done')
      void postChainTurn($, e)
    } else if (event === 'turn.step') {
      void refresh($)
    }

    return next(e)
  })

  // The turn spinner. A pure function of M.spin: the definition draws cells,
  // paint() turns them into a tree, and nothing here touches the store.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    // Read the props before either early return, so the pane still learns what
    // the engine is doing when the passthrough spinner is selected. This is a
    // write, not an invalidate: the render path must never invalidate (it loops).
    const props = (e as RenderInput<'Spinner', 'terminal'>).props
    M.spinMode = props.mode
    M.spinWord = props.word ?? ''

    if (e.surface !== 'terminal') return next(e)
    const def = spinnerById(M.spinnerId)
    if (def.kind === 'engine') return next(e)   // the passthrough choice

    const t = await $.ui.resolve(e)
    const columns = e.viewport?.columns ?? 80
    const elapsedMs = M.turnStartedAt === null ? 0 : $.clock.now() - M.turnStartedAt
    const rows = def.draw({
      frame: M.spin,
      columns,
      mode: props.mode,
      word: props.word,
      message: props.message,
      elapsedMs,
      turn: M.turnSeq,
    })
    if (!rows.length) return next(e)
    const caption = captionRows(props.word, props.message, props.mode, M.spin, elapsedMs)
    return paintSpinner(t, def, rows, caption, columns)
  })

  // Pure render. Reads the state above and touches nothing else.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const props = (e as RenderInput<'AbovePrompt', 'terminal'>).props
    if (props.hasSurvey) return next(e) // a survey owns the band; yield to it

    const s = M.state
    if (!s) return next(e)

    const t = await $.ui.resolve(e)

    // Opens and closes the side TUI pane, not the browser -- the pane URL is
    // already a click away on the right of this row, so spending the one
    // built-in hotkey on the thing that has no other trigger is the better use
    // of it. The launcher restarts an existing pane on a bare re-run, so the
    // close arm passes `--close` explicitly rather than relying on that.
    const onOpenPane = () => {
      if (!M.tmux) {
        $.ui.toast('the side pane needs tmux — the web pane is on the link')
        return
      }
      if (!M.paneScript) {
        $.ui.toast('side pane launcher not found')
        return
      }
      const closing = M.paneOpen
      const argv = closing ? [M.paneScript, '--close'] : [M.paneScript]
      // Flip the label now and confirm against tmux after: the launcher takes
      // long enough (it builds the binary on a cold machine) that waiting for
      // it would make the button feel broken.
      M.paneOpen = !closing
      $.ui.invalidate('ui.render')
      $.ui.toast(closing ? 'closing side pane' : 'opening side pane')
      void $.process
        .run(argv, { cwd: M.cwd || undefined, timeoutMs: 30_000 })
        .then(() => refreshPaneOpen($, true))
        .catch(() => refreshPaneOpen($, true))
    }
    const onNarrate = () => {
      M.narrationAt = 0
      void narrate($)
    }
    const chooseSpinner = (id: string) => {
      M.spinnerId = id
      M.spin = 0
      M.previewUntil = $.clock.now() + 6000   // idle sessions draw no Spinner, so preview here
      void $.store.set('spinner', id).catch(() => {})
      // A config-file pin wins over $.store (resolveSpinnerId), and the file
      // is re-read every refresh() -- so a pin to a DIFFERENT id would revert
      // this exact pick at the next turn boundary. Say so now rather than
      // let it look like the picker silently stopped working.
      const pinned = M.settings.spinner
      const reverts = typeof pinned === 'string' && pinned !== id && SPINNERS.some((sp) => sp.id === pinned)
      $.ui.toast(
        reverts
          ? `spinner → ${spinnerById(id).name} (reverts to ${spinnerById(pinned!).name} next turn -- settings.spinner pins it)`
          : `spinner → ${spinnerById(id).name}`,
      )
      $.ui.invalidate('ui.render')
    }
    const onPickSpinner = (value: string) => chooseSpinner(value)

    const columns = e.viewport?.columns ?? 80
    const inner = Math.max(24, columns - 4)
    const roomy = props.maxRows >= 6 && inner >= 62
    const boxed = props.maxRows >= 4 && inner >= 44

    const pct = M.contextLimit > 0 ? Math.min(1, s.ctx / M.contextLimit) : 0
    const pressure = pressureOf(pct)

    const { usd, exact } = spendOf(s)
    const precise = M.turnStartedAt !== null
    const since = precise ? M.turnStartedAt! : s.startedAt
    const clock = elapsed($.clock.now() - since, precise)

    const meter = s.ctx > 0 ? `${compact(s.ctx)} / ${compact(M.contextLimit)}` : `— / ${compact(M.contextLimit)}`
    const model = shortModel(M.modelLabel || s.modelId || 'unknown')
    const gitLabel = M.branch ? `${M.branch}${M.dirty ? '*' : ''}` : 'no repo'
    // Fixed and small. It used to scale up to 18 columns beside the context
    // meter; the model, branch and diff that moved onto this row are worth more
    // than the extra width, so it is capped at a glanceable stub.
    const trend = spark(s.throughput, TREND_WIDTH)

    // ONE vitals line. Model, branch and diff used to sit on a second row below
    // the context meter; they are worth more than the sparkline that was taking
    // the space beside it, so they moved up and the sparkline shrank.
    //
    // Ordered for reading, dropped by priority: `prio` rises as an item matters
    // less, and fitVitals removes the highest wherever it sits. Anything that
    // does not fit spills to a second row when the band has the height, so
    // narrowing costs layout rather than information.
    const VITAL_GAP = 1
    const vitals: {
      key: string; text: string; prio: number
      color?: string; dim?: boolean; bold?: boolean
    }[] = [
      { key: 'pie', text: pie(pct, M.settings.pieStyle), prio: 1, color: pressure },
      { key: 'meter', text: meter, prio: 0, bold: true },
      { key: 'pct', text: `${Math.round(pct * 100)}%`, prio: 1, color: pressure },
      { key: 'model', text: model, prio: 2, color: 'magenta' },
      { key: 'branch', text: `⎇ ${gitLabel}`, prio: 3, color: M.branch ? 'blue' : 'gray' },
      { key: 'add', text: `+${s.diff.added}`, prio: 4, color: 'green' },
      { key: 'del', text: `−${s.diff.removed}`, prio: 4, color: 'red' },
      { key: 'spend', text: `${exact ? '' : '~'}${money(usd)}`, prio: 5, color: 'green', bold: true },
      { key: 'tok', prio: 6, dim: true,
        text: `↑${compact(s.inTok + s.cacheWrite5m + s.cacheWrite1h + s.cacheRead)} ↓${compact(s.outTok)}` },
      { key: 'guard', text: `⚑ ${s.guardrails}`, prio: 7, color: s.guardrails > 0 ? 'yellow' : 'gray' },
      { key: 'pane', text: M.relayUp ? '◈ pane' : '◇ no pane', prio: 9,
        color: M.relayUp ? 'cyan' : 'gray', dim: !M.relayUp },
    ]
    // The sparkline sits beside the meter it describes, and is the first thing
    // to go: it was holding 18 columns next to the context meter for a shape,
    // where the row now carries the model, the branch and the diff.
    if (trend) vitals.splice(3, 0, { key: 'trend', text: trend, prio: 8, color: 'cyan', dim: true })

    const clockText = `${precise ? 'turn' : 'session'} ${clock}`
    const vitalBudget = Math.max(12, inner - displayWidth(clockText) - VITAL_GAP)
    const { kept, dropped } = fitVitals(vitals, vitalBudget, VITAL_GAP)

    const paintVital = (v: (typeof vitals)[number]) => (
      <t.Text key={v.key} color={v.color} dimColor={v.dim} bold={v.bold} wrap="truncate-end">{v.text}</t.Text>
    )

    const line1Kids = [
      ...kept.map(paintVital),
      <t.Box flexGrow={1} />,
      <t.Text color="cyan" dimColor>{clockText}</t.Text>,
    ]

    // One flat children array rather than an array beside sibling elements: a
    // mapped array typechecks as a Box's ONLY child (as `paint()` relies on),
    // not as one child among several.
    const line1 = (
      <t.Box flexDirection="row" gap={VITAL_GAP}>
        {line1Kids}
      </t.Box>
    )

    // Only when something actually fell off AND there is height for it. The
    // spill is fitted in its own right: at 50 columns the remainder is wider
    // than the band, and an unfitted second row just moves the overflow rather
    // than solving it. Whatever does not fit here is genuinely the least
    // useful thing on screen, and goes.
    const spill = fitVitals(dropped, inner, VITAL_GAP).kept
    const line2 =
      dropped.length > 0 && spill.length > 0 && props.maxRows >= 5 ? (
        <t.Box flexDirection="row" gap={VITAL_GAP}>
          {spill.map(paintVital)}
        </t.Box>
      ) : null

    // The narration reveals itself: random glyphs settling into the sentence.
    const narrationRow =
      s.narration && roomy ? (
        <t.Box flexDirection="row" gap={1}>
          <t.Text color="cyan">▸</t.Text>
          <t.Text dimColor wrap="truncate-end">{decrypt(s.narration, M.frame, M.frame - 14)}</t.Text>
        </t.Box>
      ) : null

    // An indicator, with no buttons of its own. A prompt belongs in a
    // configurable slot, and the signal lapses on its own once the file goes
    // quiet (see STUCK_COOL_MS), so there is nothing for a button to do.
    const stuckRow =
      M.stuck && roomy ? (
        <t.Box flexDirection="row" gap={1}>
          <t.Text color="yellow" bold>{'⚠ stuck?'}</t.Text>
          <t.Text dimColor wrap="truncate-end">{M.stuck}</t.Text>
        </t.Box>
      ) : null

    // What the last marker or fill did. Modelled on the stuck row above: an
    // indicator with no buttons of its own, one glyph and one truncated line,
    // gated on `roomy` for the same reason -- a band taller than maxRows is
    // clipped and every hotkey in it is disarmed. `≡` is one column and is not
    // an emoji, so displayWidth already measures it; `▸` and `⚠` are taken by
    // the two rows above. A notice from an earlier turn is stale news.
    const noticeLive =
      M.notice !== null && M.notice.seq === M.turnSeq && $.clock.now() - M.notice.at < NOTICE_MS
    const noticeRow =
      noticeLive && roomy ? (
        <t.Box flexDirection="row" gap={1}>
          <t.Text color="cyan" bold>{'≡'}</t.Text>
          <t.Text dimColor wrap="truncate-end">{M.notice!.text}</t.Text>
        </t.Box>
      ) : null

    // The action row: two built-ins and up to eight configurable prompt slots,
    // on ONE line. Built here rather than at the top of the file because a
    // Button's onPress needs `$`, and `$` may only be spelled at a call site
    // inside this hook -- it cannot be stashed for a top-level handler.
    const ROW_GAP = 2
    const actionItems: { key: string; label: string; short: string; prompt: string }[] = [
      { key: HOTKEY_PANE, prompt: '', ...paneLabel(!!M.tmux, M.paneOpen) },
      { key: HOTKEY_NARRATE, label: 'what now?', short: 'now?', prompt: '' },
    ]
    for (const h of M.hotkeys) {
      actionItems.push({ key: h.key, label: h.title, short: h.short, prompt: h.prompt })
    }
    actionItems.sort((a, b) => HOTKEY_ORDER.indexOf(a.key) - HOTKEY_ORDER.indexOf(b.key))

    const fitted = fitHotkeys(actionItems, inner, ROW_GAP)
    const overflow = fitted.hidden > 0 ? `+${fitted.hidden}` : ''
    const spent =
      fitted.shown.reduce((n, b) => n + buttonWidth(b.key, b.label), 0) +
      ROW_GAP * Math.max(0, fitted.shown.length - 1) +
      (overflow ? ROW_GAP + overflow.length : 0)

    const actionKids = []
    for (const b of fitted.shown) {
      if (b.key === HOTKEY_PANE) {
        actionKids.push(<t.Button key="hk-pane" hotkey={b.key} plain label={b.label} onPress={onOpenPane} />)
      } else if (b.key === HOTKEY_NARRATE) {
        actionKids.push(<t.Button key="hk-now" hotkey={b.key} plain label={b.label} onPress={onNarrate} />)
      } else {
        // Captured per slot, so each button carries its own prompt rather than
        // reading a mutable index when the press finally happens.
        const text = actionItems.find((i) => i.key === b.key)?.prompt ?? ''
        const onPrompt = () => {
          if (text) void $.prompt.submit({ text })
        }
        actionKids.push(<t.Button key={`hk-${b.key}`} hotkey={b.key} plain label={b.label} onPress={onPrompt} />)
      }
    }
    if (overflow) actionKids.push(<t.Text dimColor>{overflow}</t.Text>)
    actionKids.push(<t.Box flexGrow={1} />)

    // The tail is the first thing to go: the hotkeys are the point of the row,
    // and both forms of it have to be budgeted the same way. Budgeting only the
    // link put the row 12 columns over at 72 columns, because `relay not
    // running` is longer than the URL it stands in for and was being appended
    // unconditionally. `◇ no pane` on the row above already says it anyway.
    const tail = M.relayUp ? paneUrl() : 'relay not running'
    if (inner - spent >= tail.length + ROW_GAP) {
      actionKids.push(
        M.relayUp ? <t.Link href={tail} label={tail} /> : <t.Text dimColor>{tail}</t.Text>,
      )
    }

    const actionRow = roomy ? (
      <t.Box flexDirection="row" gap={ROW_GAP}>
        {actionKids}
      </t.Box>
    ) : null

    if (!boxed) {
      return (
        <t.Box flexDirection="column" width={columns}>
          {line1}
        </t.Box>
      )
    }

    // Off unless `settings.spinnerPicker` asks for it: the spinner is set once
    // and then looked at forever, so a permanent row of the band is a poor
    // trade. There is no hotkey to toggle it with -- all ten digits are spent
    // -- so it lives in the same config file as the slots and lands at the next
    // turn boundary. The picker still needs real room when it IS on: a clipped
    // band disarms every hotkey in the tree.
    const chosen = spinnerById(M.spinnerId)
    const spinnerRow =
      M.settings.spinnerPicker && props.maxRows >= 10 && inner >= 62 ? (
        <t.Box flexDirection="row" gap={2}>
          <t.Select
            key="spinner"
            label="spinner"
            options={SPINNERS.map((sp) => ({ value: sp.id, label: sp.name }))}
            value={M.spinnerId}
            onSelect={onPickSpinner}
          />
        </t.Box>
      ) : null

    // While the preview is live the 10 Hz tick keeps invalidating, so it animates.
    const previewing = $.clock.now() < M.previewUntil
    const previewRows =
      spinnerRow && previewing && props.maxRows >= 10 + chosen.rows
        ? chosen.kind === 'engine'
          ? [<t.Text dimColor>{"engine's own spinner"}</t.Text>]
          : chosen
              .draw({ frame: M.spin, columns: inner, mode: 'thinking', word: 'Previewing', message: null, elapsedMs: 0, turn: M.turnSeq })
              .map((r) => paintRow(t, r))
        : []

    // Pushed conditionally: a null child makes the engine silently replace the
    // whole tree with its own component, and say so only in the debug log.
    const rows = [line1]
    if (line2) rows.push(line2)
    if (narrationRow) rows.push(narrationRow)
    if (stuckRow) rows.push(stuckRow)
    if (noticeRow) rows.push(noticeRow)
    if (actionRow) rows.push(actionRow)
    if (spinnerRow) rows.push(spinnerRow)
    for (const r of previewRows) rows.push(r)

    return (
      <t.Box
        flexDirection="column"
        borderStyle="round"
        borderColor={pressure}
        borderDimColor
        paddingX={1}
        width={columns}
      >
        {rows}
      </t.Box>
    )
  })
}
