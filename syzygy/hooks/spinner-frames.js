// The turn-spinners — the pure frame math.
//
// Nothing here touches the plugin API: every draw() is a pure function of its
// context, so the render hook can be a pure projection and a repaint at the
// same frame draws the same thing. Types live in spinner-frames.d.ts.
//
// Glyph policy: one spinner (`lunar`) is emoji and every other is narrow. An
// East-Asian-Wide code point occupies two cells and shears any row that
// measures with `.length`, so measure with `displayWidth()` — which is why it
// is exported from this file rather than hidden in it.

/** Knuth multiplicative hash → 0..15. */
export const hash = (n) => Math.imul(n | 0, 2654435761) >>> 28

export const TINT = {
  thinking: { name: 'magenta', hex: '#a78bfa', word: 'divining' },
  requesting: { name: 'blue', hex: '#60a5fa', word: 'summoning' },
  responding: { name: 'cyan', hex: '#67e8f9', word: 'speaking' },
  'tool-input': { name: 'yellow', hex: '#fbbf24', word: 'inscribing' },
  'tool-use': { name: 'red', hex: '#f87171', word: 'conjuring' },
}
/** An escalated turn overrides the mode tint: whatever the agent is doing, the
 *  fact that it is doing it on a stronger model is the more important signal. */
export const ESCALATED_TINT = { name: 'magenta', hex: '#b267e6', word: 'escalated' }
const tintOf = (mode, escalated) => (escalated ? ESCALATED_TINT : (TINT[mode] ?? TINT.thinking))

const BRASS = 'yellow'
const MARSH = 'green'
const MARSH_HI = '#86efac'

// ------------------------------------------------------------------ helpers

const cell = (ch, style) => ({ ch, ...(style ?? {}) })
const cells = (text, style) => [...text].map((ch) => cell(ch, style))
const blank = (n) => Array.from({ length: Math.max(0, n) }, () => cell(' '))
/** Every row of a frame must be the same length or the block shears. */
const pad = (row, n) => (row.length >= n ? row.slice(0, n) : [...row, ...blank(n - row.length)])
const grid = (rows, n) => rows.map((r) => pad(r, n))

/** A one-row badge: a glyph run in the tint. Used by every wide spinner's
 *  narrow fallback so a 30-column terminal still gets something alive. */
const badge = (text, mode) => [cells(text, { color: tintOf(mode).hex, bold: true })]

// ================================================================= 3.5 Belfry

const FLAP = ['^v^', '-v-', '_v_', '-v-']
const batX = (b, f, cols) => {
  const span = cols + 6
  const raw = (b * 41 + Math.floor((f * (2 + (b % 3))) / 2)) % span
  const x = raw - 3
  return b % 2 === 0 ? x : cols - 1 - x
}

const belfryDraw = ({ frame: f, columns, mode, escalated }) => {
  const tint = tintOf(mode, escalated)
  if (columns < 40) return badge(`[${FLAP[f % 4]}]`, mode)
  const sky = [blank(columns), blank(columns)]
  for (let x = 0; x < columns; x++) {
    if (hash(x) < 2) {
      const r = hash(x * 3) < 8 ? 0 : 1
      const lit = hash(x + Math.floor(f / 7)) === 0
      sky[r][x] = lit ? cell('✦', { color: 'white' }) : cell('·', { color: 'gray', dim: true })
    }
  }
  if (columns >= 60) {
    const mx = columns - 8
    if (mx >= 0 && mx < columns) sky[0][mx] = cell('☾', { color: 'yellow' })
  }
  const nBats = columns < 60 ? 2 : Math.max(2, Math.min(6, Math.floor(columns / 22)))
  for (let b = 0; b < nBats; b++) {
    const wings = FLAP[(f + b * 2) % 4]
    const r = ((Math.floor(f / 3) + b) % 4) < 2 ? 0 : 1
    const x0 = batX(b, f, columns)
    const style = b === 0 ? { color: tint.hex, bold: true } : { color: 'gray', bold: true }
    for (let k = 0; k < 3; k++) {
      const x = x0 + k
      if (x >= 0 && x < columns) sky[r][x] = cell(wings[k], style)
    }
  }
  return grid(sky, columns)
}

// ============================================================ 3.6 Wraith Tide

const DENSITY = [' ', '⣀', '⣤', '⣶', '⣿']
const fogLower = (x, f) => {
  const v = 0.5 + 0.35 * Math.sin(x / 9 - f / 6) + 0.15 * Math.sin(x / 4 + f / 11)
  return Math.max(0, Math.min(4, Math.round(v * 4)))
}
const fogUpper = (x, f) => {
  const w = 0.25 + 0.25 * Math.sin(x / 7 - f / 5 + 1.3)
  return w > 0.42 ? 2 : w > 0.3 ? 1 : 0
}
const FOG_STYLE = (lv, tint) =>
  lv === 1 ? { color: 'gray', dim: true }
  : lv === 2 ? { color: 'gray' }
  : lv === 3 ? { color: tint.name, dim: true }
  : lv === 4 ? { color: tint.name } : {}

const tideDraw = ({ frame: f, columns, mode, escalated }) => {
  const tint = tintOf(mode, escalated)
  if (columns < 24) return badge(`${DENSITY[fogLower(0, f)]}${DENSITY[fogLower(3, f)]}${DENSITY[fogLower(6, f)]}`, mode)
  const top = []
  const bottom = []
  for (let x = 0; x < columns; x++) {
    const u = fogUpper(x, f)
    const l = fogLower(x, f)
    top.push(cell(DENSITY[u], FOG_STYLE(u, tint)))
    bottom.push(cell(DENSITY[l], FOG_STYLE(l, tint)))
  }
  const ex = Math.floor(columns / 2 + (columns / 2 - 4) * Math.sin(f / 40))
  const blinking = f % 50 < 3
  const eyes = blinking ? '─ ─' : '◉ ◉'
  const eyeStyle = blinking ? { color: 'gray', dim: true } : { color: 'red', dim: true }
  for (let k = 0; k < 3; k++) {
    const x = ex + k
    if (x >= 0 && x < columns) top[x] = cell(eyes[k], eyeStyle)
  }
  return grid([top, bottom], columns)
}

// =============================================================== 3.7 Galvanic

const COMPLEX = [
  '..╭╮....╱╲......',
  '──╯╰───╱..╲..╭──',
  '...........╲─╯..',
]
const beatSpeed = (mode) => (mode === 'tool-use' ? 4 : mode === 'thinking' ? 2 : 3)

const galvanicDraw = ({ frame: f, columns, mode, word, message, elapsedMs, escalated }) => {
  const tint = tintOf(mode, escalated)
  if (columns < 40) return badge(['♥', '♥', '♡', '♡'][Math.floor(f / 2) % 4], mode)
  const label = `${message ?? word}…${elapsedMs > 0 ? ` (${Math.round(elapsedMs / 1000)}s)` : ''}`
  const capW = Math.min(24, label.length + 2)
  const L = capW + 2
  const BEAT = columns < 60 ? 24 : 40
  const speed = beatSpeed(mode)

  const rows = [blank(columns), blank(columns), blank(columns)]
  for (let x = L; x < columns; x++) {
    const k = (x - L + speed * f) % BEAT
    for (let r = 0; r < 3; r++) {
      const g = k < 16 ? COMPLEX[r][k] : '.'
      if (g === '.') {
        rows[r][x] = r === 1 ? cell('─', { color: tint.name, dim: true }) : cell(' ')
      } else {
        const peak = r === 0 && (k === 8 || k === 9)
        rows[r][x] = cell(g, peak ? { color: 'white', bold: true } : { color: tint.hex, bold: true })
      }
    }
  }
  cells(label.slice(0, capW), { color: 'gray' }).forEach((c, i) => { rows[1][i] = c })
  rows[1][capW] = cell('┤', { color: 'gray', dim: true })
  return grid(rows, columns)
}

// ========================================================= 3.10 Will-o'-the-Wisp

const LIGHT = [' ', '·', '∘', '○', '◍', '◉']
const WISP_BASE = [2, 5, 8]
const WISP_PERIOD = [14, 17, 20]
const wispLevel = (i, f) => {
  const k = (f + i * 5) % WISP_PERIOD[i]
  return k < 6 ? [1, 2, 3, 4, 5, 4][k] : k < 9 ? [3, 2, 1][k - 6] : 0
}
const wispRow = (i, f) => Math.floor((f + i * 7) / 8) % 2
const wispCol = (i, f) => WISP_BASE[i] + ((Math.floor((f + i * 3) / 6) % 3) - 1)

const wispDraw = ({ frame: f, columns, mode, escalated }) => {
  const tint = tintOf(mode, escalated)
  const oneRow = columns < 30
  const rows = oneRow ? [blank(11)] : [blank(11), blank(11)]
  for (let i = 0; i < 3; i++) {
    const lv = wispLevel(i, f)
    if (lv === 0) continue
    const r = oneRow ? 0 : wispRow(i, f)
    const c = wispCol(i, f)
    if (c < 0 || c > 10) continue
    const mid = i === 1
    const style = lv <= 2 ? { color: mid ? tint.name : MARSH, dim: true }
      : lv === 3 ? { color: mid ? tint.name : 'green' }
      : lv === 4 ? { color: mid ? tint.hex : MARSH_HI, bold: true }
      : { color: 'white', bold: true }
    rows[r][c] = cell(LIGHT[lv], style)
    if (!oneRow && lv >= 3) rows[1 - r][c] = cell('·', { color: 'gray', dim: true })
  }
  return grid(rows, 11)
}


// ==================================================== one-line spinners

/**
 * Split into grapheme clusters without Intl.Segmenter (not guaranteed in the
 * plugin environment): merge variation selectors, ZWJ joins, skin tones and
 * keycaps into the cluster before them.
 */
const graphemes = (text) => {
  const out = []
  for (const cp of text) {
    const c = cp.codePointAt(0)
    const combining =
      c === 0xfe0f || c === 0xfe0e || c === 0x20e3 ||
      (c >= 0x1f3fb && c <= 0x1f3ff) ||
      (c >= 0x1f1e6 && c <= 0x1f1ff && out.length > 0 &&
        out[out.length - 1].codePointAt(0) >= 0x1f1e6)
    if (combining && out.length) out[out.length - 1] += cp
    else if (out.length && out[out.length - 1].endsWith('‍')) out[out.length - 1] += cp
    else if (cp === '‍' && out.length) out[out.length - 1] += cp
    else out.push(cp)
  }
  return out
}

const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
]
/** Emoji-presentation code points outside the main blocks: these default to
 *  emoji (two cells) even without a variation selector. */
const EMOJI_PRESENTATION = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
]
const inRanges = (cp, ranges) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi)

/** Columns one grapheme occupies. A variation selector forces emoji
 *  presentation, which every terminal draws two cells wide. */
const graphemeWidth = (g) => {
  if (g.includes('\uFE0F')) return 2
  const cp = g.codePointAt(0)
  return inRanges(cp, WIDE_RANGES) || inRanges(cp, EMOJI_PRESENTATION) ? 2 : 1
}

/** Terminal columns a string occupies (emoji count as two). */
export const displayWidth = (text) =>
  graphemes(text).reduce((n, g) => n + graphemeWidth(g), 0)

const glyphCells = (text, style) =>
  graphemes(text).map((g) => {
    const w = graphemeWidth(g)
    return w === 2 ? { ch: g, w: 2, ...(style ?? {}) } : { ch: g, ...(style ?? {}) }
  })

/** One row: the animation, then the caption, clipped to the terminal. */
const lineWith = (art, ctx, artStyle) => {
  const tint = tintOf(ctx.mode, ctx.escalated)
  const elapsed = ctx.elapsedMs > 0 ? ` (${Math.round(ctx.elapsedMs / 1000)}s)` : ''
  const tail = `  ${ctx.message ?? ctx.word}…${elapsed}`
  const row = [...glyphCells(art, artStyle), ...cells(tail, { color: 'gray' })]
  let used = 0
  const clipped = []
  for (const c of row) {
    const w = c.w ?? 1
    if (used + w > ctx.columns) break
    clipped.push(c)
    used += w
  }
  return [clipped]
}

/** A story is a list of panels; each is held for `hold` ticks, then the next. */
const storyPanel = (panels, hold, frame) => panels[Math.floor(frame / hold) % panels.length]

/** Pad every panel to the widest one so the caption beside it never jitters as
 *  the art grows and shrinks — moving text is far more distracting than the
 *  animation it sits next to. */
const padPanel = (panel, width) => {
  const short = width - displayWidth(panel)
  return short > 0 ? panel + ' '.repeat(short) : panel
}

const makeStory = (id, name, panels, hold = 4) => {
  const width = Math.max(...panels.map(displayWidth))
  return {
    id, name, kind: 'line', rows: 1, every: 1, caption: 'none', story: true,
    draw: (ctx) => lineWith(padPanel(storyPanel(panels, hold, ctx.frame), width), ctx, undefined),
  }
}

// --- text one-liners — no emoji anywhere ------------------------------------
// Every glyph below is single-cell (braille, block, box-drawing, geometric or
// runic), so these render identically whatever a terminal thinks of emoji.

const BOUNCE = ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈']
const BARS = '▁▂▃▄▅▆▇█'
const SPIRAL = ['⡀', '⡄', '⡆', '⡇', '⠇', '⠃', '⠁', '⠀', '⠈', '⠘', '⠸', '⢸', '⣸', '⣰', '⣠', '⣀']
const CIPHER = '▚▞▛▜▙▟┃━╱╲╳◤◥◣◢▖▘▝▗'
const RAIN_GLYPH = ['╷', '│', '╵', ' ']

/** Width of the animated field, leaving room for the caption. */
const fieldWidth = (ctx, lo, hi) => Math.max(lo, Math.min(hi, ctx.columns - 32))

const MORSE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....',
  I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.',
  Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..',
}

const lineSpinners = [
  {
    id: 'orbitline', name: 'Orbit', kind: 'line', rows: 1, every: 1, caption: 'none',
    draw: (ctx) => {
      const tint = tintOf(ctx.mode, ctx.escalated)
      const w = fieldWidth(ctx, 8, 24)
      const at = ctx.frame % (w * 2)
      const x = at < w ? at : w * 2 - at - 1
      return lineWith(' '.repeat(x) + '●' + ' '.repeat(Math.max(0, w - x - 1)), ctx, { color: tint.hex, bold: true })
    },
  },
  {
    id: 'pulse', name: 'Pulse', kind: 'line', rows: 1, every: 1, caption: 'none',
    draw: (ctx) => {
      const tint = tintOf(ctx.mode, ctx.escalated)
      const w = fieldWidth(ctx, 8, 20)
      const lit = Math.round((Math.sin(ctx.frame / 5) * 0.5 + 0.5) * w)
      return lineWith('█'.repeat(lit) + '░'.repeat(Math.max(0, w - lit)), ctx, { color: tint.name })
    },
  },
  {
    id: 'drift', name: 'Drift', kind: 'line', rows: 1, every: 1, caption: 'none',
    draw: (ctx) => {
      const tint = tintOf(ctx.mode, ctx.escalated)
      return lineWith(BOUNCE.map((_, i) => BOUNCE[(ctx.frame + i * 2) % BOUNCE.length]).join(''), ctx, { color: tint.name, dim: true })
    },
  },
  {
    // A Knight-Rider sweep: the head is white, the two cells behind it fade.
    id: 'scanner', name: 'Scanner', kind: 'line', rows: 1, every: 1, caption: 'none',
    draw: (ctx) => {
      const tint = tintOf(ctx.mode, ctx.escalated)
      const w = fieldWidth(ctx, 8, 22)
      const at = ctx.frame % (w * 2 - 2)
      const x = at < w ? at : w * 2 - 2 - at
      const field = []
      for (let i = 0; i < w; i++) {
        const d = Math.abs(i - x)
        field.push(d === 0 ? { ch: '▰', color: 'white', bold: true }
          : d === 1 ? { ch: '▰', color: tint.name }
          : d === 2 ? { ch: '▱', color: tint.name, dim: true }
          : { ch: '▱', color: 'gray', dim: true })
      }
      return [[...field, ...lineWith('', ctx, undefined)[0]].slice(0, ctx.columns)]
    },
  },
  {
    // An audio meter: two incommensurate sines so the bars never march in step.
    id: 'waveform', name: 'Waveform', kind: 'line', rows: 1, every: 1, caption: 'none',
    draw: (ctx) => {
      const tint = tintOf(ctx.mode, ctx.escalated)
      const w = fieldWidth(ctx, 10, 26)
      const field = []
      for (let i = 0; i < w; i++) {
        const v = 0.5 + 0.32 * Math.sin(i / 2.2 - ctx.frame / 3) + 0.18 * Math.sin(i / 1.3 + ctx.frame / 5)
        const lv = Math.max(0, Math.min(7, Math.round(v * 7)))
        field.push({ ch: BARS[lv], color: lv > 5 ? 'white' : lv > 3 ? tint.name : tint.name, dim: lv <= 3, bold: lv > 5 })
      }
      return [[...field, ...lineWith('', ctx, undefined)[0]].slice(0, ctx.columns)]
    },
  },
  {
    // The telegraph really transmits the turn's word: dot, dash, letter gap.
    id: 'morse', name: 'Telegraph', kind: 'line', rows: 1, every: 1, caption: 'none',
    draw: (ctx) => {
      const tint = tintOf(ctx.mode, ctx.escalated)
      const word = ((ctx.message ?? ctx.word) || 'WAITING').toUpperCase().replace(/[^A-Z]/g, '') || 'WAITING'
      const stream = []
      for (const ch of word) {
        for (const sym of MORSE[ch] ?? '') stream.push(sym === '.' ? '▪' : '▬')
        stream.push(' ')
      }
      const w = fieldWidth(ctx, 10, 26)
      const head = Math.floor(ctx.frame / 2) % stream.length
      const field = []
      for (let i = 0; i < w; i++) {
        const k = head - w + 1 + i
        const sym = k >= 0 ? stream[k % stream.length] : ' '
        field.push(i === w - 1
          ? { ch: sym, color: 'white', bold: true }
          : { ch: sym, color: tint.name, dim: i < w - 5 })
      }
      return [[...field, ...lineWith('', ctx, undefined)[0]].slice(0, ctx.columns)]
    },
  },
  {
    id: 'spiral', name: 'Spiral', kind: 'line', rows: 1, every: 1, caption: 'none',
    draw: (ctx) => {
      const tint = tintOf(ctx.mode, ctx.escalated)
      const art = [0, 1, 2].map((k) => SPIRAL[(ctx.frame + k * 5) % SPIRAL.length]).join(' ')
      return lineWith(art, ctx, { color: tint.hex, bold: true })
    },
  },
  {
    id: 'rain', name: 'Downpour', kind: 'line', rows: 1, every: 1, caption: 'none',
    draw: (ctx) => {
      const tint = tintOf(ctx.mode, ctx.escalated)
      const w = fieldWidth(ctx, 10, 26)
      const field = []
      for (let i = 0; i < w; i++) {
        // Each column falls at its own rate, or every column shares one period
        // and the whole line loops every four frames instead of raining.
        const speed = 1 + (hash(i * 17) % 3)
        const phase = (Math.floor(ctx.frame * speed / 2) + hash(i * 31)) % 4
        field.push({ ch: RAIN_GLYPH[phase], color: phase === 1 ? tint.name : 'gray', dim: phase !== 1 })
      }
      return [[...field, ...lineWith('', ctx, undefined)[0]].slice(0, ctx.columns)]
    },
  },
  {
    // The word resolves out of ciphertext, then scrambles again.
    id: 'cipher', name: 'Cipher', kind: 'line', rows: 1, every: 1, caption: 'none',
    draw: (ctx) => {
      const tint = tintOf(ctx.mode, ctx.escalated)
      const word = ((ctx.message ?? ctx.word) || 'working').slice(0, 18)
      const cycle = 40
      const k = ctx.frame % cycle
      const settled = k < 20 ? Math.floor((k / 20) * word.length) : word.length - Math.floor(((k - 20) / 20) * word.length)
      const field = [...word].map((ch, i) =>
        i < settled
          ? { ch, color: 'white', bold: true }
          : { ch: CIPHER[(i * 7 + ctx.frame * 3) % CIPHER.length], color: tint.name, dim: true })
      return [[...field, ...lineWith('', ctx, undefined)[0]].slice(0, ctx.columns)]
    },
  },
]

// --- three-row blocks — the one-liners rethought for the space ---------------
// Not the same animation stacked: each gains a second dimension it could not
// have on one row (an orbit instead of a bounce, a scope instead of a meter,
// three registers of a cipher machine instead of one).

const block = (id, name, rows, every, draw) =>
  ({ id, name, kind: 'badge', rows, every, caption: 'right', emoji: false, draw })

const emptyRows = (n, w) => Array.from({ length: n }, () => blank(w))
const put = (rows, r, x, ch, style) => {
  if (r >= 0 && r < rows.length && x >= 0 && x < rows[r].length) rows[r][x] = cell(ch, style)
}

const blockSpinners = [
  // A bounce becomes a real orbit: an ellipse around a sun, with a trail that
  // follows the actual path rather than a straight line.
  block('orrery', 'Orrery', 3, 1, (ctx) => {
    const tint = tintOf(ctx.mode, ctx.escalated)
    const w = 17
    const rows = emptyRows(3, w)
    const pos = (k) => {
      const a = (ctx.frame - k) * 0.14
      return [1 + Math.round(Math.sin(a)), 8 + Math.round(Math.cos(a) * 7)]
    }
    for (let k = 6; k >= 1; k--) {
      const [r, x] = pos(k)
      put(rows, r, x, k > 3 ? '·' : '∙', { color: tint.name, dim: true })
    }
    put(rows, 1, 8, '◎', { color: BRASS })
    const [r, x] = pos(0)
    put(rows, r, x, '●', { color: tint.hex, bold: true })
    return grid(rows, w)
  }),

  // The comet now arcs: it climbs to the top row mid-flight and the tail
  // follows the curve instead of trailing flat behind it.
  block('perihelion', 'Perihelion', 3, 1, (ctx) => {
    const tint = tintOf(ctx.mode, ctx.escalated)
    const w = 26
    const rows = emptyRows(3, w)
    const span = w + 8
    for (let k = 7; k >= 0; k--) {
      const x = ((ctx.frame - k) % span)
      if (x < 0 || x >= w) continue
      const r = 2 - Math.round(Math.sin((x / (w - 1)) * Math.PI) * 2)
      const g = k === 0 ? '●' : k < 3 ? '•' : k < 5 ? '∙' : '·'
      put(rows, r, x, g, { color: k === 0 ? 'white' : tint.name, bold: k < 2, dim: k > 4 })
    }
    return grid(rows, w)
  }),

  // One bar becomes a meter with 24 levels of vertical resolution and a
  // peak-hold marker that falls slowly — the thing a real VU has.
  // One bar becomes a meter with 24 levels and a true peak-hold: the marker is
  // the decaying maximum of the last second, not a differently-phased sample.
  block('equaliser', 'Equaliser', 3, 1, (ctx) => {
    const tint = tintOf(ctx.mode, ctx.escalated)
    const w = 22
    const rows = emptyRows(3, w)
    const levelAt = (i, f) => {
      const v = 0.5 + 0.3 * Math.sin(i / 2.4 - f / 3) + 0.2 * Math.sin(i / 1.1 + f / 7)
      return Math.max(0, Math.min(24, Math.round(v * 24)))
    }
    for (let i = 0; i < w; i++) {
      const level = levelAt(i, ctx.frame)
      for (let r = 0; r < 3; r++) {
        const base = (2 - r) * 8
        const inBand = level - base
        if (inBand <= 0) continue
        put(rows, r, i, BARS[Math.min(7, inBand - 1)],
          { color: r === 0 ? 'white' : tint.name, dim: r === 2, bold: r === 0 })
      }
      let peak = level
      for (let k = 1; k <= 9; k++) peak = Math.max(peak, levelAt(i, ctx.frame - k))
      if (peak > level + 1) {
        const pr = 2 - Math.floor((peak - 1) / 8)
        if (rows[pr][i].ch === ' ') put(rows, pr, i, '▔', { color: BRASS })
      }
    }
    return grid(rows, w)
  }),

  // Depth: three layers drifting at different speeds, far ones dim and slow.
  block('parallax', 'Parallax', 3, 1, (ctx) => {
    const tint = tintOf(ctx.mode, ctx.escalated)
    const w = 24
    const rows = emptyRows(3, w)
    for (let r = 0; r < 3; r++) {
      const speed = r + 1
      for (let i = 0; i < w; i++) {
        const x = (i + Math.floor((ctx.frame * speed) / 3)) % w
        if (hash(x * 13 + r * 71) > 3) continue
        put(rows, r, i, BOUNCE[(x + r) % BOUNCE.length],
          { color: r === 2 ? 'white' : tint.name, dim: r === 0, bold: r === 2 })
      }
    }
    return grid(rows, w)
  }),

  // Twenty-four levels of vertical resolution: a real trace, not a bar row.
  // Twenty-four levels of vertical resolution, and consecutive samples are
  // joined: a scope draws a continuous trace, not a scatter of blocks.
  block('scope', 'Oscilloscope', 3, 1, (ctx) => {
    const tint = tintOf(ctx.mode, ctx.escalated)
    const w = 26
    const rows = emptyRows(3, w)
    const sample = (i) => {
      const v = Math.sin(i / 3 - ctx.frame / 4) * 0.6 + Math.sin(i / 1.4 + ctx.frame / 9) * 0.4
      return Math.max(0, Math.min(23, Math.round((v * 0.5 + 0.5) * 23)))
    }
    // graticule first, so the trace draws over it
    for (let i = 0; i < w; i += 6) for (let r = 0; r < 3; r++) put(rows, r, i, '┊', { color: 'gray', dim: true })
    for (let i = 0; i < w; i++) {
      const level = sample(i)
      const prev = i === 0 ? level : sample(i - 1)
      const lo = Math.min(level, prev)
      const hi = Math.max(level, prev)
      for (let r = 0; r < 3; r++) {
        const base = (2 - r) * 8
        const top = base + 7
        if (hi < base || lo > top) continue
        if (level >= base && level <= top) {
          put(rows, r, i, BARS[level - base], { color: tint.hex, bold: true })
        } else {
          // the trace passes through this row on its way to the sample
          put(rows, r, i, '│', { color: tint.name })
        }
      }
    }
    return grid(rows, w)
  }),

  // Concentric rings turning at different rates — the inner one fastest.
  block('vortex', 'Vortex', 3, 1, (ctx) => {
    const tint = tintOf(ctx.mode, ctx.escalated)
    const w = 15
    const rows = emptyRows(3, w)
    const RING = [
      { r: 0, xs: [4, 6, 8, 10], speed: 1 },
      { r: 1, xs: [2, 5, 9, 12], speed: 2 },
      { r: 2, xs: [4, 6, 8, 10], speed: 3 },
    ]
    for (const ring of RING) {
      const off = Math.floor((ctx.frame * ring.speed) / 3) % ring.xs.length
      ring.xs.forEach((x, i) => {
        const lit = i === off
        put(rows, ring.r, x, SPIRAL[(ctx.frame * ring.speed + i * 4) % SPIRAL.length],
          { color: lit ? 'white' : tint.name, bold: lit, dim: !lit })
      })
    }
    put(rows, 1, 7, '◉', { color: tint.hex, bold: true })
    return grid(rows, w)
  }),

  // The showpiece: three registers of a cipher machine. The ciphertext stays
  // put, a rotor steps through keys beneath it, and the plaintext resolves
  // left to right as each column falls — you can see the crack propagate.
  block('cryptanalysis', 'Cryptanalysis', 3, 1, (ctx) => {
    const tint = tintOf(ctx.mode, ctx.escalated)
    const plain = ((ctx.message ?? ctx.word) || 'working').slice(0, 22)
    const w = Math.max(plain.length + 4, 24)
    const rows = emptyRows(3, w)
    const cycle = 60
    const k = ctx.frame % cycle
    const solved = Math.max(0, Math.min(plain.length, Math.floor((k / 38) * plain.length)))

    // Row 0 — the intercept. Solved columns freeze; the rest keep churning.
    for (let i = 0; i < plain.length; i++) {
      const frozen = i < solved
      put(rows, 0, i, CIPHER[(i * 5 + (frozen ? 0 : ctx.frame * 3)) % CIPHER.length],
        { color: frozen ? 'gray' : tint.name, dim: frozen })
    }
    // Row 1 — the rotor: a window stepping along, showing the key under test.
    const shift = (Math.floor(ctx.frame / 2) % 26) + 1
    const label = `ROT ${String(shift).padStart(2, '0')}`
    const winAt = Math.min(plain.length - 1, solved)
    for (let i = 0; i < plain.length; i++) {
      put(rows, 1, i, i === winAt ? '┃' : '─', { color: i < solved ? tint.hex : 'gray', dim: i >= solved })
    }
    cells(label, { color: BRASS }).forEach((c, i) => put(rows, 1, plain.length + 2 + i, c.ch, c))
    // Row 2 — the plaintext, with a cursor at the working edge.
    for (let i = 0; i < plain.length; i++) {
      if (i < solved) put(rows, 2, i, plain[i], { color: 'white', bold: true })
      else if (i === solved) put(rows, 2, i, ctx.frame % 4 < 2 ? '▂' : '▁', { color: tint.hex, bold: true })
      else put(rows, 2, i, '·', { color: 'gray', dim: true })
    }
    return grid(rows, w)
  }),

]

// --- emoji motion (no narrative) --------------------------------------------
//
// The only emoji spinner left. Every panel carries VARIATION SELECTOR-16 for
// the same reason the band's moon pie does: without it a font stack that lists
// `Noto Sans Symbols 2` ahead of the colour emoji font resolves U+1F315 -- and
// only U+1F315, which is the one phase that font contains -- to a monochrome
// outline, so the full moon alone renders black and white. VS16 is the
// standard request for the colour form, and it fixes every font stack rather
// than asking each user to patch their terminal. It is zero-width, and
// `graphemeWidth` above already folds it into the moon's two columns, so the
// panel width is unchanged by it.

const VS16 = '\uFE0F'
const MOONS = ['\u{1F311}', '\u{1F312}', '\u{1F313}', '\u{1F314}',
               '\u{1F315}', '\u{1F316}', '\u{1F317}', '\u{1F318}']

const emojiMotion = [
  ['lunar', 'Lunar', MOONS.map((m) => m + VS16), 2],
].map(([id, name, panels, hold]) => ({
  ...makeStory(id, name, panels, hold), story: false, emoji: true,
}))

// ================================================================== registry

export const SPINNERS = [
  { id: 'belfry', name: 'Belfry', kind: 'wide', rows: 2, every: 1, caption: 'below', draw: belfryDraw },
  { id: 'tide', name: 'Wraith Tide', kind: 'wide', rows: 2, every: 1, caption: 'below', draw: tideDraw },
  { id: 'galvanic', name: 'Galvanic', kind: 'wide', rows: 3, every: 1, caption: 'none', draw: galvanicDraw },
  { id: 'wisp', name: "Will-o'-the-Wisp", kind: 'badge', rows: 2, every: 1, caption: 'right', draw: wispDraw },
  ...lineSpinners,
  ...blockSpinners,
  ...emojiMotion,
  { id: 'engine', name: "Engine's own", kind: 'engine', rows: 0, every: 10, caption: 'none', draw: () => [] },
]
