// Types for spinner-frames.js — the pure frame math, kept in a sibling module.
// Sibling imports were verified to resolve at run time on build 2.1.269 (a probe
// plugin registered a tool whose name came from an imported module, and the tool
// appeared in the session's tool list).

export type SpinnerMode = 'requesting' | 'responding' | 'thinking' | 'tool-input' | 'tool-use'

export type Cell = {
  /** One grapheme. Usually one code point; an emoji may be a cluster. */
  ch: string
  color?: string
  dim?: boolean
  bold?: boolean
  inverse?: boolean
  /** Display columns this cell occupies. Emoji are 2; omit for 1. */
  w?: number
}
export type Row = Cell[]

export type DrawCtx = {
  frame: number
  columns: number
  mode: SpinnerMode
  word: string
  message: string | null
  elapsedMs: number
  /** Which turn this is, counted from session start. No shipped spinner reads
   *  it today -- the shuffles that did are gone -- but it is part of the
   *  context every draw() is handed, and cheap to keep. */
  turn: number
}

export type SpinnerDef = {
  id: string
  name: string
  kind: 'badge' | 'wide' | 'engine' | 'line'
  rows: number
  /** Divides the 10 Hz tick: 2 means this spinner advances at 5 fps. */
  every: number
  caption: 'right' | 'below' | 'none'
  /** True for a spinner that draws emoji. `lunar` is the only one. */
  emoji?: boolean
  draw(ctx: DrawCtx): Row[]
}

export declare const SPINNERS: readonly SpinnerDef[]
export declare const TINT: Record<SpinnerMode, { name: string; hex: string; word: string }>
export declare const hash: (n: number) => number
/** Terminal columns a string occupies (emoji count as two). */
export declare const displayWidth: (text: string) => number
