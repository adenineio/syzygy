/* Syzygy — voice input's pure core.
   A CLASSIC script, like canvas-layout.js and reconcile.js: it assigns one
   global, MCVM, touches no DOM at load, and is evaluated under node by
   test/voice-harness.mjs through `new Function`. Split out for the reason
   swarm-math.js and spinner-frames.js are split out of their consumers: the
   part worth asserting is separable, so separate it and assert it.

   Every function here is synchronous and pure — no subprocess, no fetch, no
   Web Audio, no DOM.

   There is no engine selection and no PATH lookup for a binary:
   `bridge/voice.mjs` manages a uv-installed venv and a persistent Python
   worker, and their presence is a plain `existsSync`/`statSync` check, not
   something this module needs to decide.
   `replaceRegion` and `micRect` carry the live-transcription provisional
   region and the mic button's field-relative position. */
'use strict'

const MCVM = (() => {
  /** Identity when the rates already match; linear interpolation otherwise.
   * Always returns a Float32Array, so a caller never has to branch on what
   * it got back. */
  const resampleLinear = (samples, rateIn, rateOut) => {
    const src = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? [])
    if (!src.length) return new Float32Array(0)
    if (!rateIn || !rateOut || rateIn === rateOut) return src.slice()
    const ratio = rateIn / rateOut
    const outLen = Math.max(1, Math.round(src.length / ratio))
    const out = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio
      const i0 = Math.floor(pos)
      const i1 = Math.min(src.length - 1, i0 + 1)
      const frac = pos - i0
      out[i] = src[i0] * (1 - frac) + src[i1] * frac
    }
    return out
  }

  /** 16-bit PCM mono WAV: a 44-byte RIFF/WAVE header (`fmt ` then `data`)
   * followed by the samples, each clamped to [-1, 1] before scaling — so an
   * out-of-range sample lands at ±32767, never wrapping and never reaching
   * the asymmetric int16 floor of -32768. */
  const encodeWav = (samples, rate) => {
    const src = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? [])
    const n = src.length
    const dataSize = n * 2
    const buf = new ArrayBuffer(44 + dataSize)
    const view = new DataView(buf)
    const str = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)) }
    str(0, 'RIFF')
    view.setUint32(4, 36 + dataSize, true)
    str(8, 'WAVE')
    str(12, 'fmt ')
    view.setUint32(16, 16, true)       // fmt chunk size
    view.setUint16(20, 1, true)        // PCM
    view.setUint16(22, 1, true)        // mono
    view.setUint32(24, rate, true)
    view.setUint32(28, rate * 2, true) // byte rate: rate * blockAlign(2)
    view.setUint16(32, 2, true)        // block align
    view.setUint16(34, 16, true)       // bits per sample
    str(36, 'data')
    view.setUint32(40, dataSize, true)
    for (let i = 0; i < n; i++) {
      let v = src[i]
      if (v > 1) v = 1
      else if (v < -1) v = -1
      view.setInt16(44 + i * 2, Math.round(v * 32767), true)
    }
    return new Uint8Array(buf)
  }

  /** Seconds, from a WAV file's total byte length — the 44-byte header plus
   * 2 bytes per mono sample, at `rate` samples/sec. */
  const wavDuration = (bytes, rate) => {
    const dataBytes = Math.max(0, (Number(bytes) || 0) - 44)
    return rate > 0 ? dataBytes / 2 / rate : 0
  }

  /**  never replaces a selection. With one open it collapses to
   * the selection's END and inserts there, so the selected text survives
   * untouched. A leading space is added only when the character right
   * before the insertion point exists and is not whitespace; no trailing
   * space is ever added. */
  const insertAtCaret = ({ value, start, end, text }) => {
    const v = String(value ?? '')
    const s = Math.max(0, Math.min(v.length, Number(start) || 0))
    const e = Math.max(s, Math.min(v.length, Number.isFinite(end) ? end : s))
    const before = v.slice(0, e)
    const after = v.slice(e)
    const needsLead = before.length > 0 && !/\s$/.test(before)
    const insert = (needsLead ? ' ' : '') + String(text ?? '')
    return { value: before + insert + after, caret: before.length + insert.length }
  }

  /** `textarea` -> full (gets a mic button); a text-ish `input` -> modifier
   * (⌃ dictates, no button); everything else -> off. `data-voice` on the
   * element itself, or inherited from its nearest ancestor that carries
   * one, overrides all of the above — checked first, own before ancestor. */
  const fieldKind = ({ tag, type, voice, ancestorVoice }) => {
    const OVERRIDES = new Set(['off', 'full', 'modifier'])
    if (OVERRIDES.has(voice)) return voice
    if (OVERRIDES.has(ancestorVoice)) return ancestorVoice
    const t = String(tag ?? '').toLowerCase()
    if (t === 'textarea') return 'full'
    if (t === 'input') {
      const ty = type == null || type === '' ? 'text' : String(type).toLowerCase()
      return ty === 'text' || ty === 'search' ? 'modifier' : 'off'
    }
    return 'off'
  }

  /**  the ONE boolean the pane gates every button, key handler and
   * getUserMedia call on. An older relay sends no `voice` key at all, so
   * this reads false — off means off, never a throw on a missing payload. */
  const voiceReady = (payload) => !!(payload && payload.voice && payload.voice.ready)

  /**  live transcription replaces exactly the region it owns,
   * `[anchor, anchor+length)`, with `text` — never touching anything
   * outside it. `length: 0` is a pure insertion (the first partial, before
   * anything has been written yet). Returns the REPLACEMENT's length (so
   * the caller can remember it as the region's new extent) and the caret
   * position right after the inserted text. `anchor`/`length` are clamped
   * to the value's own bounds rather than thrown on — a caret that raced
   * ahead of an edit elsewhere in the field must not crash the module that
   * merely wants to keep dictating into it. */
  const replaceRegion = ({ value, anchor, length, text }) => {
    const v = String(value ?? '')
    const a = Math.max(0, Math.min(v.length, Number(anchor) || 0))
    const len = Math.max(0, Math.min(v.length - a, Number(length) || 0))
    const t = String(text ?? '')
    return { value: v.slice(0, a) + t + v.slice(a + len), length: t.length, caret: a + t.length }
  }

  /** Places the mic button's top-left, so it sits INSIDE the field's own
   * bottom-right corner rather than its parent's. `field` is a plain descriptor — `offsetLeft/Top/Width/Height`, so
   * this stays pure and callable with a fake field in a test. `inset` clears
   * the field's own edge; `gripClear` additionally shifts the button clear
   * of the native resize handle that already lives in that same corner on a
   * `resize: vertical` textarea. The result is always clamped inside the
   * field's own box — a field too small for `size + inset + gripClear`
   * still gets a button that starts at the field's own top-left corner
   * edge, never one that lands outside it. */
  const micRect = ({ field, inset = 6, size = 22, gripClear = 14 } = {}) => {
    const f = field || {}
    const left0 = Number(f.offsetLeft) || 0
    const top0 = Number(f.offsetTop) || 0
    const w = Math.max(0, Number(f.offsetWidth) || 0)
    const h = Math.max(0, Number(f.offsetHeight) || 0)
    const rawLeft = left0 + w - size - inset - gripClear
    const rawTop = top0 + h - size - inset
    const left = Math.max(left0, Math.min(rawLeft, left0 + w - size))
    const top = Math.max(top0, Math.min(rawTop, top0 + h - size))
    return { left, top }
  }

  return { resampleLinear, encodeWav, wavDuration, insertAtCaret, fieldKind, voiceReady, replaceRegion, micRect }
})()
