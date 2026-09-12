// Geometry, determinism and glyph-width checks for every spinner frame.
// A ragged row shears the whole block, and a Wide code point occupies two
// terminal cells, so both are hard failures rather than cosmetic ones.

import assert from 'node:assert/strict'
import { SPINNERS, TINT, hash, displayWidth } from '../syzygy/hooks/spinner-frames.js'

/** East Asian Wide / Fullwidth ranges — a glyph in these takes two cells. */
const WIDE = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
]
const isWide = (cp) => WIDE.some(([lo, hi]) => cp >= lo && cp <= hi)

const MODES = ['thinking', 'requesting', 'responding', 'tool-input', 'tool-use']
const WIDTHS = [40, 60, 80, 120, 200]
const FRAMES = 120

// The set is CLOSED, and asserted by name rather than by count. A count alone
// would pass a swap -- one spinner deleted and another added -- which is
// exactly the accident this list exists to catch, since a pinned id that
// vanishes silently falls back to the default.
const EXPECTED = [
  'belfry', 'tide', 'galvanic', 'wisp',
  'orbitline', 'pulse', 'drift', 'scanner', 'waveform', 'morse', 'spiral',
  'rain', 'cipher',
  'orrery', 'perihelion', 'equaliser', 'parallax', 'scope', 'vortex',
  'cryptanalysis',
  'lunar',
  'engine',
]
assert.deepEqual([...SPINNERS.map((s) => s.id)].sort(), [...EXPECTED].sort(),
  'the shipped spinner set, exactly')
assert.equal(SPINNERS.length, 22, 'twenty-two spinners')
assert.equal(SPINNERS.filter((s) => s.kind === 'line').length, 10, 'the one-line family')
assert.equal(SPINNERS.filter((s) => s.kind === 'line' && !s.emoji).length, 9, 'the emoji-free one-line family')
assert.deepEqual(SPINNERS.filter((s) => s.emoji).map((s) => s.id), ['lunar'],
  'lunar is the only emoji spinner')
assert.ok(SPINNERS.every((s) => typeof s.id === 'string' && s.id), 'every spinner has an id')
assert.equal(new Set(SPINNERS.map((s) => s.id)).size, SPINNERS.length, 'ids are unique')
for (const m of MODES) assert.ok(TINT[m], `TINT covers ${m}`)
assert.equal(typeof hash(7), 'number', 'hash returns a number')

let checked = 0
for (const def of SPINNERS) {
  if (def.kind === 'engine') {
    assert.deepEqual(def.draw({ frame: 0, columns: 80, mode: 'thinking', word: 'x', message: null, elapsedMs: 0 }), [])
    console.log(`✔ ${def.id.padEnd(10)} passthrough draws nothing`)
    continue
  }
  let sawNarrow = false
  for (const columns of WIDTHS) {
    for (const mode of MODES) {
      for (let frame = 0; frame < FRAMES; frame++) {
        const ctx = { frame, columns, mode, word: 'Sauteing', message: null, elapsedMs: frame * 100, turn: frame % 7 }
        const rows = def.draw(ctx)
        assert.ok(Array.isArray(rows) && rows.length > 0, `${def.id}: rows at ${columns}/${mode}/${frame}`)

        // A one-line spinner has no other row to align with, so a two-cell
        // emoji is fine there — what matters is that the drawn line fits the
        // terminal. Multi-row blocks keep the strict no-Wide rule, because a
        // two-cell glyph shears every row it lands in.
        if (def.kind === 'line') {
          assert.equal(rows.length, 1, `${def.id}: a line spinner draws one row`)
          let width = 0
          for (const c of rows[0]) {
            assert.ok(c && typeof c.ch === 'string' && c.ch.length > 0, `${def.id}: empty cell`)
            const declared = c.w ?? 1
            assert.equal(declared, displayWidth(c.ch), `${def.id}: cell "${c.ch}" declares width ${declared}`)
            // A spinner not marked `emoji` must contain none — the emoji-free
            // set has to stay emoji-free, whatever gets added later.
            if (!def.emoji) {
              assert.equal(declared, 1, `${def.id} is emoji-free but drew "${c.ch}" (width ${declared})`)
              assert.ok(!isWide(c.ch.codePointAt(0)), `${def.id} is emoji-free but drew wide "${c.ch}"`)
              assert.ok(!/\uFE0F/.test(c.ch), `${def.id} is emoji-free but drew a variation selector`)
            }
            width += declared
          }
          assert.ok(width <= columns, `${def.id}: line is ${width} columns wide in ${columns}`)
        } else {
          const w = rows[0].length
          for (const row of rows) {
            assert.equal(row.length, w, `${def.id}: ragged row at ${columns}/${mode}/${frame}`)
            for (const c of row) {
              assert.ok(c && typeof c.ch === 'string' && c.ch.length > 0, `${def.id}: empty cell`)
              assert.equal([...c.ch].length, 1, `${def.id}: cell "${c.ch}" is not one code point`)
              assert.ok(!isWide(c.ch.codePointAt(0)), `${def.id}: wide glyph "${c.ch}" at ${columns}/${mode}/${frame}`)
            }
          }
        }
        const w = rows[0].length
        // A wide spinner must fill the terminal exactly, or it shears.
        const narrow = rows.length === 1 && def.kind !== 'badge' && def.kind !== 'hero'
        if (def.kind === 'wide' && !narrow && w !== columns) {
          assert.fail(`${def.id}: wide row is ${w} cells at ${columns} columns`)
        }
        if (rows.length === 1 && def.rows > 1) sawNarrow = true

        // Determinism: the render must be a pure function of the frame.
        if (frame % 37 === 0) {
          assert.deepEqual(def.draw(ctx), rows, `${def.id}: draw is not deterministic`)
        }
        checked++
      }
    }
  }
  // Every spinner has a documented narrow fallback; prove it produces a frame.
  const tiny = def.draw({ frame: 3, columns: 22, mode: 'thinking', word: 'Sauteing', message: null, elapsedMs: 0, turn: 1 })
  assert.ok(tiny.length > 0 && tiny[0].length > 0, `${def.id}: no frame at 22 columns`)
  if (def.kind !== 'line') {
    const tw = tiny[0].length
    for (const row of tiny) assert.equal(row.length, tw, `${def.id}: ragged narrow frame`)
  }

  console.log(`✔ ${def.id.padEnd(10)} ${String(def.rows).padStart(2)} rows · every ${def.every} · ${def.kind.padEnd(6)} · ${def.name}`)
}

// Lunar draws the colour moon, not the monochrome outline. Every panel carries
// VARIATION SELECTOR-16: without it a font stack listing `Noto Sans Symbols 2`
// ahead of the colour emoji font resolves U+1F315 -- the one phase that font
// contains -- to a black-and-white glyph, so the full moon alone comes out
// wrong. VS16 is zero-width, so the moon still measures two columns.
const lunar = SPINNERS.find((s) => s.id === 'lunar')
const phases = new Set()
for (let frame = 0; frame < 32; frame++) {
  const row = lunar.draw({ frame, columns: 80, mode: 'thinking', word: 'x', message: null, elapsedMs: 0, turn: 0 })
  const moon = row[0][0]
  assert.ok(/\uFE0F$/.test(moon.ch), `lunar frame ${frame} drew "${moon.ch}" without VS16`)
  assert.equal(moon.w, 2, `lunar frame ${frame}: the moon must measure two columns`)
  assert.equal(displayWidth(moon.ch), 2, 'displayWidth folds VS16 into the moon')
  phases.add(moon.ch)
}
assert.equal(phases.size, 8, `lunar cycles all eight phases (saw ${phases.size})`)
console.log('\u2714 lunar draws all eight moons in colour (VS16), two columns each')

const emojiFree = SPINNERS.filter((s) => !s.emoji && s.kind !== 'engine')
console.log(`✔ ${emojiFree.length} spinners verified emoji-free across every frame drawn above`)

console.log(`\n✔ all spinner frame checks passed (${checked.toLocaleString()} frames)`)
