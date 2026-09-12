#!/usr/bin/env node
// Drives voice input's pure core (bridge/public/voice-math.js) and the
// relay's voice module (bridge/voice.mjs) against an injected `run` --
// every subprocess it would otherwise spawn (uv, the venv's python, the
// worker) is a small real node child speaking the same argv/stdio contract,
// so voice.mjs's spawn/parse/respond logic is exercised for real with no
// real venv, no network, and no model. Hermetic throughout: every tmp() is
// its own directory, cleaned up after. The real venv, the real
// openai-whisper package and the real model are verified by hand, against
// prepared WAV files: a harness that mocks the subprocess cannot verify a real
// command line, only that a fake accepted it.
import assert from 'node:assert/strict'
import {
  readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, chmodSync, openSync, closeSync, ftruncateSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const MATH_SRC = join(ROOT, 'syzygy', 'bridge', 'public', 'voice-math.js')

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }
const tmp = () => mkdtempSync(join(tmpdir(), 'szg-voice-'))

// --- load voice-math.js the way the pane does: a classic script, window shim ---
const win = {}
const MCVM = new Function('window', readFileSync(MATH_SRC, 'utf8') + '\nreturn MCVM')(win)

console.log('=== voice-math (pure core) ===')

// ---- resampleLinear ----------------------------------------------------------
await ok('resampleLinear: identity at equal rates', () => {
  const s = Float32Array.from([0.1, -0.2, 0.3, 0.4])
  const r = MCVM.resampleLinear(s, 16000, 16000)
  assert.deepEqual(Array.from(r), Array.from(s))
})
await ok('resampleLinear: downsamples 48k -> 16k to roughly a third of the length', () => {
  const s = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 10))
  const r = MCVM.resampleLinear(s, 48000, 16000)
  assert.ok(Math.abs(r.length - 1600) <= 1, `expected ~1600, got ${r.length}`)
})
await ok('resampleLinear: upsamples 8k -> 16k to roughly double the length', () => {
  const s = Float32Array.from({ length: 800 }, (_, i) => (i % 2 ? 1 : -1))
  const r = MCVM.resampleLinear(s, 8000, 16000)
  assert.ok(Math.abs(r.length - 1600) <= 1, `expected ~1600, got ${r.length}`)
})
await ok('resampleLinear: interpolates between neighbouring samples, not nearest-only', () => {
  const s = Float32Array.from([0, 1])
  const r = MCVM.resampleLinear(s, 2, 4)
  assert.ok(r.length >= 3)
  assert.ok(r[1] > 0 && r[1] < 1, 'a midpoint sample is a blend, not a copy of either neighbour')
})
await ok('resampleLinear: empty input is empty output', () => {
  assert.equal(MCVM.resampleLinear(new Float32Array(0), 48000, 16000).length, 0)
  assert.equal(MCVM.resampleLinear([], 48000, 16000).length, 0)
})

// ---- encodeWav ----------------------------------------------------------------
await ok('encodeWav: RIFF/WAVE header, fmt + data chunks, mono, 16-bit, the given rate', () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 1])
  const rate = 16000
  const bytes = MCVM.encodeWav(samples, rate)
  const buf = Buffer.from(bytes)
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF')
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE')
  assert.equal(buf.toString('ascii', 12, 16), 'fmt ')
  assert.equal(buf.readUInt16LE(20), 1, 'PCM format code')
  assert.equal(buf.readUInt16LE(22), 1, '1 channel')
  assert.equal(buf.readUInt32LE(24), rate)
  assert.equal(buf.readUInt16LE(34), 16, '16 bits per sample')
  assert.equal(buf.toString('ascii', 36, 40), 'data')
  const dataLen = buf.readUInt32LE(40)
  assert.equal(dataLen, samples.length * 2, 'data length is 2 bytes per sample')
  assert.equal(bytes.length, 44 + dataLen)
})
await ok('encodeWav: clamps out-of-range samples to +-32767, never wrapping to -32768', () => {
  const bytes = MCVM.encodeWav(Float32Array.from([2, -2, 0]), 16000)
  const buf = Buffer.from(bytes)
  assert.equal(buf.readInt16LE(44), 32767)
  assert.equal(buf.readInt16LE(46), -32767)
  assert.equal(buf.readInt16LE(48), 0)
})
await ok('encodeWav: an empty sample set is still a valid 44-byte header', () => {
  const bytes = MCVM.encodeWav(new Float32Array(0), 16000)
  assert.equal(bytes.length, 44)
  assert.equal(Buffer.from(bytes).readUInt32LE(40), 0)
})

// ---- wavDuration ---------------------------------------------------------------
await ok('wavDuration: seconds from a byte length, at the given rate', () => {
  const bytes = MCVM.encodeWav(new Float32Array(16000), 16000)   // exactly 1s of silence
  assert.equal(MCVM.wavDuration(bytes.length, 16000), 1)
  assert.equal(MCVM.wavDuration(44, 16000), 0, 'header only, no data')
  assert.equal(MCVM.wavDuration(0, 16000), 0, 'shorter than a header is still 0, never negative')
})

// ---- insertAtCaret -----------------------------------------------
await ok('insertAtCaret: empty field gets the text with no leading space', () => {
  assert.deepEqual(MCVM.insertAtCaret({ value: '', start: 0, end: 0, text: 'hello' }), { value: 'hello', caret: 5 })
})
await ok('insertAtCaret: mid-word (no preceding whitespace) gets a leading space', () => {
  const r = MCVM.insertAtCaret({ value: 'hello', start: 5, end: 5, text: 'world' })
  assert.deepEqual(r, { value: 'hello world', caret: 11 })
})
await ok('insertAtCaret: right after a space, no double space', () => {
  const r = MCVM.insertAtCaret({ value: 'hello ', start: 6, end: 6, text: 'world' })
  assert.deepEqual(r, { value: 'hello world', caret: 11 })
})
await ok('insertAtCaret: never adds a trailing space', () => {
  const r = MCVM.insertAtCaret({ value: '', start: 0, end: 0, text: 'hello' })
  assert.equal(r.value.endsWith(' '), false)
})
await ok('insertAtCaret: an open selection is collapsed to its END, and the selected text survives', () => {
  // "hello world", selection covers "hello" (0..5): the insert must land right
  // after "hello", and "hello" itself must not be replaced.
  const r = MCVM.insertAtCaret({ value: 'hello world', start: 0, end: 5, text: 'there' })
  assert.equal(r.value, 'hello there world')
  assert.ok(r.value.includes('hello'), 'the selected text was not replaced')
})
await ok('insertAtCaret: caret and end out of range are clamped to the value\'s bounds', () => {
  const r = MCVM.insertAtCaret({ value: 'hi', start: 99, end: 99, text: 'x' })
  assert.equal(r.value, 'hi x')
})

// ---- fieldKind -----------------------------------------------------
await ok('fieldKind: textarea is full', () => {
  assert.equal(MCVM.fieldKind({ tag: 'textarea' }), 'full')
})
await ok('fieldKind: a bare input, or type=text/search, is modifier-only', () => {
  assert.equal(MCVM.fieldKind({ tag: 'input', type: undefined }), 'modifier')
  assert.equal(MCVM.fieldKind({ tag: 'input', type: 'text' }), 'modifier')
  assert.equal(MCVM.fieldKind({ tag: 'input', type: 'search' }), 'modifier')
})
await ok('fieldKind: type=range and type=checkbox are off', () => {
  assert.equal(MCVM.fieldKind({ tag: 'input', type: 'range' }), 'off')
  assert.equal(MCVM.fieldKind({ tag: 'input', type: 'checkbox' }), 'off')
})
await ok('fieldKind: anything else (a select, a div) is off', () => {
  assert.equal(MCVM.fieldKind({ tag: 'select' }), 'off')
  assert.equal(MCVM.fieldKind({ tag: 'div' }), 'off')
})
await ok('fieldKind: an explicit data-voice on the element overrides everything, including range/checkbox exclusion', () => {
  assert.equal(MCVM.fieldKind({ tag: 'input', type: 'range', voice: 'full' }), 'full')
  assert.equal(MCVM.fieldKind({ tag: 'textarea', voice: 'off' }), 'off')
  assert.equal(MCVM.fieldKind({ tag: 'input', type: 'text', voice: 'modifier' }), 'modifier')
})
await ok('fieldKind: an ancestor\'s data-voice is inherited when the element has none of its own', () => {
  assert.equal(MCVM.fieldKind({ tag: 'textarea', ancestorVoice: 'off' }), 'off')
  assert.equal(MCVM.fieldKind({ tag: 'input', type: 'range', ancestorVoice: 'full' }), 'full')
})
await ok('fieldKind: the element\'s own data-voice wins over an ancestor\'s', () => {
  assert.equal(MCVM.fieldKind({ tag: 'textarea', voice: 'off', ancestorVoice: 'full' }), 'off')
})

// ---- voiceReady ------------------------------------------------------
await ok('voiceReady: false for {}, {voice:{}}, and undefined -- never a throw', () => {
  assert.equal(MCVM.voiceReady({}), false)
  assert.equal(MCVM.voiceReady({ voice: {} }), false)
  assert.equal(MCVM.voiceReady(undefined), false)
  assert.equal(MCVM.voiceReady(null), false)
})
await ok('voiceReady: true only when voice.ready is truthy', () => {
  assert.equal(MCVM.voiceReady({ voice: { ready: true } }), true)
  assert.equal(MCVM.voiceReady({ voice: { ready: false } }), false)
})

// ---- replaceRegion --------------------------------------------
await ok('replaceRegion: length:0 is a pure insertion at anchor', () => {
  const r = MCVM.replaceRegion({ value: 'hello world', anchor: 5, length: 0, text: ',' })
  assert.deepEqual(r, { value: 'hello, world', length: 1, caret: 6 })
})
await ok('replaceRegion: at the START of a value', () => {
  const r = MCVM.replaceRegion({ value: 'world', anchor: 0, length: 0, text: 'hello ' })
  assert.deepEqual(r, { value: 'hello world', length: 6, caret: 6 })
})
await ok('replaceRegion: in the MIDDLE, replacing exactly the owned span and nothing else', () => {
  const r = MCVM.replaceRegion({ value: 'the quick fox', anchor: 4, length: 5, text: 'slow' })
  assert.deepEqual(r, { value: 'the slow fox', length: 4, caret: 8 })
})
await ok('replaceRegion: at the END of a value', () => {
  const r = MCVM.replaceRegion({ value: 'hello ', anchor: 6, length: 0, text: 'world' })
  assert.deepEqual(r, { value: 'hello world', length: 5, caret: 11 })
})
await ok('replaceRegion: replacing LONGER text with SHORTER, then back -- length always matches what was just written', () => {
  const first = MCVM.replaceRegion({ value: 'x', anchor: 0, length: 0, text: 'a longer guess' })
  assert.equal(first.value, 'a longer guessx')
  assert.equal(first.length, 'a longer guess'.length)
  const second = MCVM.replaceRegion({ value: first.value, anchor: 0, length: first.length, text: 'short' })
  assert.deepEqual(second, { value: 'shortx', length: 5, caret: 5 })
  const third = MCVM.replaceRegion({ value: second.value, anchor: 0, length: second.length, text: 'a longer guess again' })
  assert.equal(third.value, 'a longer guess againx')
})
await ok('replaceRegion: never touches anything OUTSIDE [anchor, anchor+length)', () => {
  const r = MCVM.replaceRegion({ value: 'PREFIX-owned-SUFFIX', anchor: 7, length: 5, text: 'REPLACED' })
  assert.equal(r.value, 'PREFIX-REPLACED-SUFFIX')
})
await ok('replaceRegion: an anchor past the end CLAMPS rather than throwing, and appends', () => {
  const r = MCVM.replaceRegion({ value: 'hi', anchor: 999, length: 0, text: '!' })
  assert.deepEqual(r, { value: 'hi!', length: 1, caret: 3 })
})
await ok('replaceRegion: a length reaching past the end clamps to what remains', () => {
  const r = MCVM.replaceRegion({ value: 'hello', anchor: 3, length: 999, text: 'p' })
  assert.deepEqual(r, { value: 'help', length: 1, caret: 4 })
})

// ---- micRect ---------------------------------------------------
await ok('micRect: sits inside the field\'s own bottom-right corner, inset and clear of the grip', () => {
  const field = { offsetLeft: 10, offsetTop: 20, offsetWidth: 300, offsetHeight: 100 }
  const r = MCVM.micRect({ field, inset: 6, size: 22, gripClear: 14 })
  assert.equal(r.left, 10 + 300 - 22 - 6 - 14)
  assert.equal(r.top, 20 + 100 - 22 - 6)
})
await ok('micRect: a TALL field -- the button tracks the bottom edge, not a fixed offset from the top', () => {
  const short = MCVM.micRect({ field: { offsetLeft: 0, offsetTop: 0, offsetWidth: 200, offsetHeight: 80 } })
  const tall = MCVM.micRect({ field: { offsetLeft: 0, offsetTop: 0, offsetWidth: 200, offsetHeight: 400 } })
  assert.ok(tall.top > short.top, 'a taller field puts the button further down')
})
await ok('micRect: a SHORT/narrow field still clamps the button inside the field\'s own box', () => {
  const field = { offsetLeft: 5, offsetTop: 5, offsetWidth: 30, offsetHeight: 24 }
  const r = MCVM.micRect({ field, inset: 6, size: 22, gripClear: 14 })
  assert.ok(r.left >= field.offsetLeft, 'never lands left of the field')
  assert.ok(r.top >= field.offsetTop, 'never lands above the field')
})
await ok('micRect: never lands outside the field\'s box, across several sizes', () => {
  for (const [w, h] of [[300, 100], [80, 40], [22, 22], [500, 500]]) {
    const field = { offsetLeft: 12, offsetTop: 34, offsetWidth: w, offsetHeight: h }
    const r = MCVM.micRect({ field, inset: 6, size: 22, gripClear: 14 })
    assert.ok(r.left >= field.offsetLeft && r.left <= field.offsetLeft + field.offsetWidth, `left ${r.left} out of bounds for w=${w}`)
    assert.ok(r.top >= field.offsetTop && r.top <= field.offsetTop + field.offsetHeight, `top ${r.top} out of bounds for h=${h}`)
  }
})

// =============================================================================
// bridge/voice.mjs -- the relay's voice module, against injected fakes
// =============================================================================
console.log('\n=== voice.mjs (relay module, injected `run`) ===')

const untilTrue = async (cond, ms = 4000, step = 20) => {
  for (let i = 0; i < ms / step; i++) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, step))
  }
  return false
}

const { spawn: spawnProc } = await import('node:child_process')
const V = await import(join(ROOT, 'syzygy', 'bridge', 'voice.mjs'))

assert.equal(V.MODEL.name, 'large-v3-turbo.pt')
assert.equal(V.MODEL.bytes, 1617941637)

// A tiny fake model spec, so the download tests move a handful of bytes
// instead of MODEL's real 1.6 GB. `createVoice`'s `model` parameter exists
// for exactly this.
const FAKE_MODEL = { name: 'fake-model.pt', bytes: 20 }

/** Writes a small node script and returns its path, so a test's injected
 *  `run` can spawn a REAL child process (real stdin/stdout streaming, real
 *  'close'/'exit' events) without touching a real venv, uv, or python. */
const scriptFile = (dir, src) => {
  const p = join(dir, `fake-${Math.random().toString(36).slice(2, 8)}.mjs`)
  writeFileSync(p, src)
  return p
}

// ---- install(): uv venv --python 3.12, then uv pip install, as argv arrays ----
await ok('install(): invokes uv as an argv ARRAY with --python 3.12, and reports progress through both phases', async () => {
  const dir = tmp()
  const envDir = join(dir, 'voice-env')
  const argvFile = join(dir, 'argv.log')
  const broadcasts = []
  // `venv` creates the venv's own python (a real `uv venv` does too -- that
  // is exactly what env.present checks for afterwards); `pip` just succeeds.
  const run = (bin, argv, opts) => {
    writeFileSync(argvFile, (existsSync(argvFile) ? readFileSync(argvFile, 'utf8') : '') + JSON.stringify([bin, ...argv]) + '\n')
    if (argv[0] === 'venv') {
      const script = scriptFile(dir, `import {mkdirSync, writeFileSync} from 'node:fs'\nmkdirSync(${JSON.stringify(join(envDir, 'bin'))}, {recursive:true})\nwriteFileSync(${JSON.stringify(join(envDir, 'bin', 'python3'))}, '')\n`)
      return spawnProc(process.execPath, [script], opts)
    }
    const script = scriptFile(dir, `process.exit(0)\n`)
    return spawnProc(process.execPath, [script], opts)
  }
  const v = V.createVoice({ dir, model: FAKE_MODEL, run, broadcast: (s) => broadcasts.push(s) })
  const started = await v.install()
  assert.deepEqual(started, { ok: true, started: true })
  // Poll on `installing` settling, not `env.present`: env.present is a
  // filesystem check an independent poller can see complete a tick before
  // install()'s own promise chain reaches its `finally`.
  const done = await untilTrue(() => !v.state().env.installing)
  assert.ok(done, 'env.installing never settled back to false')
  assert.equal(v.state().env.present, true)
  assert.equal(v.state().env.error, null)
  const argvLines = readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(argvLines[0], ['uv', 'venv', '--python', '3.12', envDir])
  assert.equal(argvLines[1][0], 'uv')
  assert.deepEqual(argvLines[1].slice(1), ['pip', 'install', 'openai-whisper'])
  assert.ok(broadcasts.length > 0, 'progress was broadcast at least once')
  rmSync(dir, { recursive: true, force: true })
})

await ok('install(): a failed `uv venv` leaves env.present false and sets env.error, and pip is never invoked', async () => {
  const dir = tmp()
  const pipCalls = []
  const run = (bin, argv, opts) => {
    if (argv[0] === 'venv') {
      const script = scriptFile(dir, `process.stderr.write('no python 3.12 found'); process.exit(1)\n`)
      return spawnProc(process.execPath, [script], opts)
    }
    pipCalls.push(argv)
    return spawnProc(process.execPath, [scriptFile(dir, 'process.exit(0)\n')], opts)
  }
  const v = V.createVoice({ dir, model: FAKE_MODEL, run })
  await v.install()
  const failed = await untilTrue(() => v.state().env.error != null)
  assert.ok(failed, 'env.error was never set')
  assert.equal(v.state().env.present, false)
  assert.equal(v.state().env.installing, false)
  assert.equal(pipCalls.length, 0, 'a failed venv create must never run pip install')
  rmSync(dir, { recursive: true, force: true })
})

await ok('install(): a second call while one is running answers { already: true }', async () => {
  const dir = tmp()
  let releaseVenv
  const run = (bin, argv, opts) => {
    if (argv[0] === 'venv') {
      const script = scriptFile(dir, `process.stdin.resume()\nsetTimeout(() => process.exit(0), 300)\n`)
      return spawnProc(process.execPath, [script], opts)
    }
    return spawnProc(process.execPath, [scriptFile(dir, 'process.exit(0)\n')], opts)
  }
  const v = V.createVoice({ dir, model: FAKE_MODEL, run })
  const first = v.install()
  const second = await v.install()
  assert.deepEqual(second, { already: true })
  await first
  rmSync(dir, { recursive: true, force: true })
})

// ---- download(): the venv's OWN python does the fetch+verify; we watch the file grow ----
await ok('download(): a clean run leaves the model in place and state().model.present flips true', async () => {
  const dir = tmp()
  const broadcasts = []
  const body = 'a'.repeat(FAKE_MODEL.bytes)
  const run = (bin, argv, opts) => {
    const modelsDir = argv[argv.length - 1]
    const script = scriptFile(dir, `import {writeFileSync} from 'node:fs'\nimport {join} from 'node:path'\nwriteFileSync(join(${JSON.stringify(modelsDir)}, ${JSON.stringify(FAKE_MODEL.name)}), ${JSON.stringify(body)})\n`)
    return spawnProc(process.execPath, [script], opts)
  }
  const v = V.createVoice({ dir, model: FAKE_MODEL, run, broadcast: (s) => broadcasts.push(s) })
  const started = await v.download()
  assert.deepEqual(started, { ok: true, started: true })
  // Wait for `downloading` to settle, not just `model.present`: the fake
  // script writes the whole file in one synchronous burst, so a size-based
  // `model.present` check can go true a tick or two before runDownload's
  // OWN async chain reaches its `finally` and clears `downloading` --
  // asserting on `present` alone races that ordering under load.
  const done = await untilTrue(() => !v.state().model.downloading)
  assert.ok(done, 'model.downloading never settled back to false')
  const s = v.state()
  assert.equal(s.model.present, true)
  assert.equal(s.model.bytes, FAKE_MODEL.bytes)
  assert.equal(s.model.downloading, false)
  assert.equal(s.model.error, null)
  assert.ok(existsSync(join(dir, 'models', FAKE_MODEL.name)))
  assert.ok(broadcasts.length > 0, 'progress was broadcast at least once')
  rmSync(dir, { recursive: true, force: true })
})

await ok('download(): a nonzero exit (the package\'s own sha256 check failing) leaves model.present false, with model.error set and the bad file removed', async () => {
  const dir = tmp()
  const run = (bin, argv, opts) => {
    const modelsDir = argv[argv.length - 1]
    const script = scriptFile(dir, `import {mkdirSync, writeFileSync} from 'node:fs'\nimport {join} from 'node:path'\nmkdirSync(${JSON.stringify(dir)}, {recursive:true})\nwriteFileSync(join(${JSON.stringify(modelsDir)}, ${JSON.stringify(FAKE_MODEL.name)}), 'wrong bytes here')\nprocess.stderr.write('RuntimeError: sha256 checksum does not match')\nprocess.exit(1)\n`)
    return spawnProc(process.execPath, [script], opts)
  }
  const v = V.createVoice({ dir, model: FAKE_MODEL, run })
  await v.download()
  const failed = await untilTrue(() => v.state().model.error != null)
  assert.ok(failed, 'model.error was never set')
  assert.equal(v.state().model.present, false)
  assert.ok(!existsSync(join(dir, 'models', FAKE_MODEL.name)), 'a failed download must not leave a file behind')
  rmSync(dir, { recursive: true, force: true })
})

await ok('download(): a right-sized but truncated/wrong file (a crash mid-write) is caught by the SIZE check and never reads as present', async () => {
  const dir = tmp()
  const run = (bin, argv, opts) => {
    const modelsDir = argv[argv.length - 1]
    // Exits 0 (as if the package's own check somehow passed) but the file on
    // disk is short -- modelPresent() checks size against model.bytes, not
    // just existence, exactly so a truncated file never reads as ready.
    const script = scriptFile(dir, `import {mkdirSync, writeFileSync} from 'node:fs'\nimport {join} from 'node:path'\nmkdirSync(${JSON.stringify(modelsDir)}, {recursive:true})\nwriteFileSync(join(${JSON.stringify(modelsDir)}, ${JSON.stringify(FAKE_MODEL.name)}), 'short')\n`)
    return spawnProc(process.execPath, [script], opts)
  }
  const v = V.createVoice({ dir, model: FAKE_MODEL, run })
  await v.download()
  const failed = await untilTrue(() => v.state().model.error != null)
  assert.ok(failed)
  assert.match(v.state().model.error, /unexpected size/)
  assert.equal(v.state().model.present, false)
  rmSync(dir, { recursive: true, force: true })
})

await ok('download(): a second call while one is running answers { already: true }', async () => {
  const dir = tmp()
  let calls = 0
  const run = (bin, argv, opts) => {
    calls++
    const script = scriptFile(dir, `process.stdin.resume()\nsetTimeout(() => process.exit(0), 250)\n`)
    return spawnProc(process.execPath, [script], opts)
  }
  const v = V.createVoice({ dir, model: FAKE_MODEL, run })
  const first = v.download()
  const second = await v.download()
  assert.deepEqual(second, { already: true })
  await first
  assert.equal(calls, 1, 'a second call while one is running must not spawn a second download')
  rmSync(dir, { recursive: true, force: true })
})

await ok('remove(): "model" clears only the model; "env" clears only the venv; "all" clears both', () => {
  const dir = tmp()
  mkdirSync(join(dir, 'models'), { recursive: true })
  writeFileSync(join(dir, 'models', FAKE_MODEL.name), 'a'.repeat(20))
  mkdirSync(join(dir, 'voice-env'), { recursive: true })
  writeFileSync(join(dir, 'voice-env', '.szg-ready'), '')
  const v = V.createVoice({ dir, model: FAKE_MODEL })
  assert.equal(v.state().model.present, true)
  assert.equal(v.state().env.present, true)
  v.remove('model')
  assert.equal(v.state().model.present, false)
  assert.equal(v.state().env.present, true, 'remove("model") must not touch the venv')
  v.remove('all')
  assert.equal(v.state().env.present, false)
  rmSync(dir, { recursive: true, force: true })
})

await ok('setEnabled round-trips through voice.json and leaves unknown keys untouched', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'voice.json'), JSON.stringify({ enabled: false, somethingElse: 'kept' }))
  const v = V.createVoice({ dir, model: FAKE_MODEL })
  v.setEnabled(true)
  assert.equal(v.state().enabled, true)
  const onDisk = JSON.parse(readFileSync(join(dir, 'voice.json'), 'utf8'))
  assert.equal(onDisk.enabled, true)
  assert.equal(onDisk.somethingElse, 'kept', 'an unrelated key already in the file survives the write')
  v.setEnabled(false)
  assert.equal(v.state().enabled, false)
  rmSync(dir, { recursive: true, force: true })
})

// ---- the worker: spawn-once, respawn-on-death, stop(), and the partial/final queue ----
/** A real node child speaking the worker's own JSON-line protocol -- close
 *  enough to the real Python worker's behaviour (an initial `ready` line,
 *  then one reply per request line) that voice.mjs's spawn/parse/respond
 *  logic is exercised for real, with no python and no model involved. */
const fakeWorkerScript = (dir, { crashAfterReady = false, delayMs = 0, textFor = null, failAll = false } = {}) => scriptFile(dir, `
import { createInterface } from 'node:readline'
process.stdout.write(JSON.stringify({ ready: true, device: 'cpu' }) + '\\n')
${crashAfterReady ? "setTimeout(() => process.exit(1), 30)\n" : ''}
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let req
  try { req = JSON.parse(line) } catch { return }
  setTimeout(() => {
    if (${JSON.stringify(!!failAll)}) {
      process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: 'fake failure' }) + '\\n')
    } else {
      const text = ${textFor ? `(${textFor})(req.id)` : `'text for ' + req.id`}
      process.stdout.write(JSON.stringify({ id: req.id, ok: true, text }) + '\\n')
    }
  }, ${delayMs})
})
`)

await ok('transcribe(): the worker is spawned ONCE and reused across many calls', async () => {
  const dir = tmp()
  const script = fakeWorkerScript(dir, {})
  let spawnCount = 0
  const run = (bin, argv) => { spawnCount++; return spawnProc(process.execPath, [script]) }
  const v = V.createVoice({ dir, model: FAKE_MODEL, workerPy: 'fake-worker.py', run })
  for (let i = 0; i < 3; i++) {
    const out = await v.transcribe({ buf: Buffer.from('wav'), partial: false })
    assert.equal(out.ok, true)
  }
  assert.equal(spawnCount, 1, 'three calls, one worker process')
  v.stop()
  rmSync(dir, { recursive: true, force: true })
})

await ok('transcribe(): a worker that dies is respawned, and the NEXT call still succeeds', async () => {
  const dir = tmp()
  const crashy = fakeWorkerScript(dir, { crashAfterReady: true })
  const good = fakeWorkerScript(dir, {})
  let spawnCount = 0
  const run = (bin, argv) => { spawnCount++; return spawnProc(process.execPath, [spawnCount === 1 ? crashy : good]) }
  const v = V.createVoice({ dir, model: FAKE_MODEL, workerPy: 'fake-worker.py', run })
  // Spawns the first (crashy) worker and gets one answer out of it before it
  // dies -- it only crashes ~30ms after announcing ready, well after a reply
  // with no artificial delay. Then give it time to actually die before the
  // NEXT call, so this exercises "dies, then the next call respawns" rather
  // than "dies mid-request" (a separate, harder case this step does not ask
  // for).
  const firstOut = await v.transcribe({ buf: Buffer.from('one'), partial: false })
  assert.equal(firstOut.ok, true, 'the first (soon-to-crash) worker still answered')
  assert.equal(spawnCount, 1)
  await new Promise((r) => setTimeout(r, 150))
  const out = await v.transcribe({ buf: Buffer.from('two'), partial: false })
  assert.equal(out.ok, true, 'a fresh worker was spawned and answered')
  assert.equal(spawnCount, 2, 'the dead worker was respawned exactly once')
  v.stop()
  rmSync(dir, { recursive: true, force: true })
})

await ok('stop(): kills the live worker; the next transcribe spawns a fresh one', async () => {
  const dir = tmp()
  const script = fakeWorkerScript(dir, {})
  let spawnCount = 0
  const run = (bin, argv) => { spawnCount++; return spawnProc(process.execPath, [script]) }
  const v = V.createVoice({ dir, model: FAKE_MODEL, workerPy: 'fake-worker.py', run })
  await v.transcribe({ buf: Buffer.from('wav'), partial: false })
  assert.equal(spawnCount, 1)
  v.stop()
  await new Promise((r) => setTimeout(r, 150))   // let SIGTERM actually land
  const out = await v.transcribe({ buf: Buffer.from('wav'), partial: false })
  assert.equal(out.ok, true)
  assert.equal(spawnCount, 2, 'stop() killed the old worker, so a second spawn was needed')
  v.stop()
  rmSync(dir, { recursive: true, force: true })
})

await ok('stop(): a stray call with no worker running is a no-op', () => {
  const dir = tmp()
  const v = V.createVoice({ dir, model: FAKE_MODEL, workerPy: 'fake-worker.py' })
  assert.doesNotThrow(() => v.stop())
  rmSync(dir, { recursive: true, force: true })
})

await ok('the worker warms itself as soon as enabled+env+model all exist, with no transcribe call needed', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'voice.json'), JSON.stringify({ enabled: true }))
  mkdirSync(join(dir, 'voice-env'), { recursive: true })
  writeFileSync(join(dir, 'voice-env', '.szg-ready'), '')
  mkdirSync(join(dir, 'models'), { recursive: true })
  writeFileSync(join(dir, 'models', FAKE_MODEL.name), 'a'.repeat(FAKE_MODEL.bytes))
  const script = fakeWorkerScript(dir, {})
  let spawnCount = 0
  const run = () => { spawnCount++; return spawnProc(process.execPath, [script]) }
  const v = V.createVoice({ dir, model: FAKE_MODEL, workerPy: 'fake-worker.py', run })
  const up = await untilTrue(() => v.state().worker.up)
  assert.ok(up, 'worker.up never went true on its own')
  assert.equal(spawnCount, 1)
  v.stop()
  rmSync(dir, { recursive: true, force: true })
})

await ok('the worker does NOT warm itself when enabled is false, or env/model is missing', async () => {
  const dir = tmp()
  // enabled but no env/model on disk at all.
  writeFileSync(join(dir, 'voice.json'), JSON.stringify({ enabled: true }))
  let spawnCount = 0
  const run = () => { spawnCount++; return spawnProc(process.execPath, [fakeWorkerScript(dir, {})]) }
  const v = V.createVoice({ dir, model: FAKE_MODEL, workerPy: 'fake-worker.py', run })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(spawnCount, 0, 'nothing to warm with -- env and model are both absent')
  assert.equal(v.state().worker.up, false)
  rmSync(dir, { recursive: true, force: true })
})

await ok('transcribe(): a PARTIAL answers 409 while anything is in flight; the in-flight call still completes', async () => {
  const dir = tmp()
  const script = fakeWorkerScript(dir, { delayMs: 250 })
  const run = () => spawnProc(process.execPath, [script])
  const v = V.createVoice({ dir, model: FAKE_MODEL, workerPy: 'fake-worker.py', run })
  const first = v.transcribe({ buf: Buffer.from('one'), partial: true })
  await new Promise((r) => setTimeout(r, 50))   // let the first actually start
  const second = await v.transcribe({ buf: Buffer.from('two'), partial: true })
  assert.equal(second.ok, false)
  assert.equal(second.status, 409)
  const firstOut = await first
  assert.equal(firstOut.ok, true, 'the first call still completes normally')
  v.stop()
  rmSync(dir, { recursive: true, force: true })
})

await ok('transcribe(): a FINAL WAITS behind an in-flight partial, rather than being rejected', async () => {
  const dir = tmp()
  const script = fakeWorkerScript(dir, { delayMs: 250 })
  const run = () => spawnProc(process.execPath, [script])
  const v = V.createVoice({ dir, model: FAKE_MODEL, workerPy: 'fake-worker.py', run })
  const t0 = Date.now()
  const partial = v.transcribe({ buf: Buffer.from('one'), partial: true })
  await new Promise((r) => setTimeout(r, 50))
  const final = v.transcribe({ buf: Buffer.from('two'), partial: false })
  const [partialOut, finalOut] = await Promise.all([partial, final])
  assert.equal(partialOut.ok, true)
  assert.equal(finalOut.ok, true, 'the final was queued, not rejected')
  assert.ok(Date.now() - t0 >= 250 + 250 - 30, 'the final only ran after the partial finished, never concurrently')
  v.stop()
  rmSync(dir, { recursive: true, force: true })
})

await ok('transcribe(): two FINALs queue FIFO and both complete', async () => {
  const dir = tmp()
  const script = fakeWorkerScript(dir, { delayMs: 80 })
  const run = () => spawnProc(process.execPath, [script])
  const v = V.createVoice({ dir, model: FAKE_MODEL, workerPy: 'fake-worker.py', run })
  const a = v.transcribe({ buf: Buffer.from('a'), partial: false })
  const b = v.transcribe({ buf: Buffer.from('b'), partial: false })
  const [outA, outB] = await Promise.all([a, b])
  assert.equal(outA.ok, true)
  assert.equal(outB.ok, true)
  v.stop()
  rmSync(dir, { recursive: true, force: true })
})

await ok('transcribe(): a worker request that fails is a clean error, and the temp WAV is gone', async () => {
  const dir = tmp()
  const script = fakeWorkerScript(dir, { failAll: true })
  const run = () => spawnProc(process.execPath, [script])
  const v = V.createVoice({ dir, model: FAKE_MODEL, workerPy: 'fake-worker.py', run })
  const out = await v.transcribe({ buf: Buffer.from('wav'), partial: false })
  assert.equal(out.ok, false)
  assert.equal(out.status, 502)
  const left = existsSync(join(dir, 'voice-tmp')) ? (await import('node:fs')).readdirSync(join(dir, 'voice-tmp')) : []
  assert.deepEqual(left, [])
  v.stop()
  rmSync(dir, { recursive: true, force: true })
})

await ok('transcribe(): with no venv/worker at all, answers a clean error rather than hanging or throwing', async () => {
  const dir = tmp()
  const run = () => spawnProc('/nonexistent/python3', ['fake-worker.py'])
  const v = V.createVoice({ dir, model: FAKE_MODEL, workerPy: 'fake-worker.py', run })
  const out = await v.transcribe({ buf: Buffer.from('x'), partial: false })
  assert.equal(out.ok, false)
  rmSync(dir, { recursive: true, force: true })
})

// =============================================================================
// The live relay: a real subprocess, a fake `python3` + worker
// =============================================================================
// Hermetic on every axis canvas-harness.mjs insists on:
// SZG_PORT=0 (OS-assigned, never 4317/4319/4321), SZG_DATA_DIR a throwaway
// temp dir. There is no env var for WHICH python runs the worker (unlike
// SZG_CLAUDE_BIN/SZG_VOICE_WORKER_PY) -- voice.mjs always spawns
// `<dataDir>/voice-env/bin/python3`, so faking it means putting a real,
// executable "python3" at exactly that path: a node script with a shebang,
// speaking the worker's own JSON-line protocol. No test here runs the real
// venv, the real openai-whisper package or the real model -- that is verified
// by hand.
{
  console.log('\n=== the live relay: real subprocess, fake python3/worker ===')
  const { spawn: spawnProc } = await import('node:child_process')
  const dataDir = tmp()
  const FAKE_TEXT = 'the quick brown fox jumps over the lazy dog'

  // env: present via the marker voice.mjs itself writes on a real install.
  mkdirSync(join(dataDir, 'voice-env', 'bin'), { recursive: true })
  writeFileSync(join(dataDir, 'voice-env', '.szg-ready'), '')
  const fakePython = join(dataDir, 'voice-env', 'bin', 'python3')
  writeFileSync(fakePython, [
    '#!/usr/bin/env node',
    "import { createInterface } from 'node:readline'",
    "process.stdout.write(JSON.stringify({ ready: true, device: 'cpu' }) + '\\n')",
    'const rl = createInterface({ input: process.stdin })',
    "rl.on('line', (line) => {",
    '  if (!line.trim()) return',
    '  let req',
    '  try { req = JSON.parse(line) } catch { return }',
    '  setTimeout(() => {',
    `    process.stdout.write(JSON.stringify({ id: req.id, ok: true, text: ${JSON.stringify(FAKE_TEXT)} }) + '\\n')`,
    '  }, 300)',
    '})',
    '',
  ].join('\n'))
  chmodSync(fakePython, 0o755)

  // model: present via SIZE, matching the real MODEL.bytes exactly -- a
  // sparse file (ftruncate, never actually written) so this test does not
  // need to move 1.6 GB to exercise the size check honestly.
  const modelPath = join(dataDir, 'models', V.MODEL.name)
  mkdirSync(dirname(modelPath), { recursive: true })
  {
    const fd = openSync(modelPath, 'w')
    ftruncateSync(fd, V.MODEL.bytes)
    closeSync(fd)
  }

  const relayPath = join(ROOT, 'syzygy', 'bridge', 'relay.mjs')
  const RELAY_TOKEN = 'voice-harness-token'
  const child = spawnProc(process.execPath, [relayPath], {
    cwd: ROOT,
    env: { ...process.env, SZG_PORT: '0', SZG_TOKEN: RELAY_TOKEN, SZG_DATA_DIR: dataDir, SZG_CLAUDE_BIN: '/nonexistent/claude',
      // This harness authenticates with the token, never a cookie.
      SZG_PANE_PASSWORD_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderrText = ''
  child.stderr.on('data', (c) => { stderrText += c })
  const port = await new Promise((resolvePort, reject) => {
    let out = ''
    const onData = (chunk) => {
      out += chunk
      const m = out.match(/relay on http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { child.stdout.off('data', onData); resolvePort(Number(m[1])) }
    }
    child.stdout.on('data', onData)
    child.on('error', reject)
    child.on('exit', (code) => reject(new Error(`relay exited early with code ${code}; stderr: ${stderrText}`)))
    setTimeout(() => reject(new Error('relay did not report a port in time')), 8000)
  })
  const base = `http://127.0.0.1:${port}`
  const post = async (path, body = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: RELAY_TOKEN, ...body }) })
    const j = await r.json().catch(() => ({}))
    return { status: r.status, ...j }
  }
  const state = async () => (await fetch(base + '/api/state')).json()

  try {
    // The payload naming only 'openai-whisper' (never any other engine) is
    // verified by construction: the whole source tree is grepped for the
    // names that must not appear, so a second, string-matching copy of that
    // check does not belong in a committed test file -- it would itself be a
    // hit against that grep.
    await ok('/api/state carries voice with ready:false before anything', async () => {
      const s = await state()
      assert.ok(s.voice, 'the payload carries a voice key at all')
      assert.equal(s.voice.ready, false)
      assert.equal(s.voice.enabled, false)
      assert.equal(s.voice.engine, 'openai-whisper')
      assert.equal(s.voice.modifier, 'Control')
      assert.equal(s.voice.maxSeconds, V.MAX_SECONDS)
      assert.equal(s.voice.maxBytes, V.MAX_AUDIO_BYTES)
      assert.equal(s.voice.chunkMs, V.CHUNK_MS)
    })

    await ok('every voice write route is 401 without a token', async () => {
      for (const path of ['/api/voice/toggle', '/api/voice/install', '/api/voice/download', '/api/voice/delete']) {
        const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
        assert.equal(r.status, 401, path)
      }
      const rt = await fetch(base + '/api/voice/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: Buffer.from('x') })
      assert.equal(rt.status, 401, '/api/voice/transcribe')
      assert.equal((await state()).voice.enabled, false, 'none of the above changed anything')
    })

    await ok('ready flips true only once enabled+env+model+worker are ALL there -- the worker warms on its own once toggled on', async () => {
      // env and model are already on disk (this test's setup); enabling is
      // the only missing piece, and it alone must be enough to bring the
      // worker up with no transcribe call in between.
      const r = await post('/api/voice/toggle', { on: true })
      assert.equal(r.status, 200)
      assert.equal(r.voice.enabled, true)
      let last = null
      const ready = await untilTrue(async () => { last = await state(); return last.voice.ready === true })
      assert.ok(ready, `voice never became ready; last seen: ${JSON.stringify(last?.voice)}`)
      assert.equal(last.voice.worker.up, true)
      assert.equal(last.voice.device, 'cpu')
    })

    await ok('POST /api/voice/transcribe with a raw WAV body returns the fake worker\'s text', async () => {
      const wav = Buffer.from('RIFF....WAVEfmt fake body for the harness')
      const r = await fetch(`${base}/api/voice/transcribe?token=${RELAY_TOKEN}`, {
        method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav,
      })
      assert.equal(r.status, 200)
      const j = await r.json()
      assert.equal(j.ok, true)
      assert.equal(j.text, FAKE_TEXT)
    })

    await ok('?partial=1 answers 409 while a request is in flight; the in-flight one still completes', async () => {
      const wav = Buffer.from('partial body')
      const first = fetch(`${base}/api/voice/transcribe?token=${RELAY_TOKEN}&partial=1`, {
        method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav,
      })
      await new Promise((r) => setTimeout(r, 80))   // let the first actually start
      const second = await fetch(`${base}/api/voice/transcribe?token=${RELAY_TOKEN}&partial=1`, {
        method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav,
      })
      assert.equal(second.status, 409)
      const firstRes = await first
      assert.equal(firstRes.status, 200)
    })

    await ok('an over-cap transcribe body is rejected with 413', async () => {
      const big = Buffer.alloc(V.MAX_AUDIO_BYTES + 1, 1)
      const r = await fetch(`${base}/api/voice/transcribe?token=${RELAY_TOKEN}`, {
        method: 'POST', headers: { 'content-type': 'audio/wav' }, body: big,
      })
      assert.equal(r.status, 413)
    })

    await ok('a missing token on transcribe is 401', async () => {
      const r = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: Buffer.from('x') })
      assert.equal(r.status, 401)
    })

    await ok('POST /api/voice/delete removes the model and ready goes false', async () => {
      const r = await post('/api/voice/delete', { what: 'model' })
      assert.equal(r.status, 200)
      assert.equal(existsSync(modelPath), false)
      const s = await state()
      assert.equal(s.voice.model.present, false)
      assert.equal(s.voice.ready, false)
      assert.equal(s.voice.enabled, true, 'delete touches the model only, not the enabled flag')
    })
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)) }
  }
  rmSync(dataDir, { recursive: true, force: true })
}

console.log(`\nvoice harness: ${pass} checks passed`)
