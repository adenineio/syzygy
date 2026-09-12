// Voice input's relay side: the voice.json store (`{ enabled }`
// and nothing about the disk — presence and size are statSync'd at read
// time, so the file can never disagree with what is actually
// there), the uv-managed venv install, the model download (run through the
// package itself —   revised — with progress watched off the
// growing file on disk rather than parsed from a subprocess), delete, and
// the persistent Python worker's lifecycle and request/response plumbing.
//
// Nothing here downloads a model from a third party or shells out to a
// transcription binary: the environment and the model are the only two
// artefacts, and both are installed through the settings section.
//
// Impure parts (every subprocess) take an injected `run`, the same shape
// canvas.mjs's `run` and scoping.mjs's `spawn` give their callers: a
// function returning a live ChildProcess, not a promise — so this module
// builds its own promises around one-shot commands (venv create, pip
// install, the model download) and manages the worker's long-lived
// stdin/stdout itself. test/voice-harness.mjs never shells out for real.

import {
  readFileSync, statSync, unlinkSync, mkdirSync, writeFileSync, renameSync, rmSync, existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/** The one model this feature ever fetches: not a picker). Size
 *  is what matters here — the sha256 check is OpenAI's own, inside
 *  `whisper._download`, and re-pinning it beside that call could only ever
 * disagree with the package and be wrong. */
export const MODEL = {
  name: 'large-v3-turbo.pt',
  bytes: 1617941637,
}

// The measured install size: shown in
// the settings section as the environment's size once it is present. Not
// computed by walking the venv's tree on every state() call — state() is
// read on every /api/state poll, and a few hundred thousand site-packages
// files is not a walk to repeat per request for a number that does not
// change once the venv exists.
export const ENV_BYTES_ESTIMATE = 748 * 1024 * 1024

const VOICE_FILE = 'voice.json'
const ENV_DIR = 'voice-env'
const MODELS_DIR = 'models'
const TMP_DIR = 'voice-tmp'

// the raw transcribe body is capped at 6 MB (headroom over a
// 120s clip at 16kHz/16-bit mono, ~3.75 MB).
export const MAX_AUDIO_BYTES = 6 * 1024 * 1024
export const MAX_SECONDS = 120
// the browser's chunked-partial cadence. Exported so the relay
// can hand it to the pane on snapshot() rather than the two disagreeing.
export const CHUNK_MS = 2500
// How often download() may re-stat the growing model file and broadcast
// progress; how often install() may broadcast between its two phases.
export const PROGRESS_INTERVAL_MS = 250
// How long ensureWorker() waits for the worker's "ready" line before giving
// up: model load is 15-19s measured, the first-MPS-call warm-up the worker
// pays before announcing ready is another ~8s on top of that. Generous on
// purpose — a slow-but-alive worker must not be mistaken for a dead one.
export const WORKER_READY_TIMEOUT_MS = 120_000

const readVoiceJson = (dir) => {
  try {
    const doc = JSON.parse(readFileSync(join(dir, VOICE_FILE), 'utf8'))
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  } catch { return {} }
}

/** Write-then-rename, same contract as claims.mjs/requests.mjs: serialize
 *  first, so a throw there leaves the previous file untouched; every unknown
 *  key already in the file is carried through, so voice.json stays editable
 *  by hand and safe for a future key to land in without this module's help. */
const writeVoiceJson = (dir, patch) => {
  const doc = { ...readVoiceJson(dir), ...patch }
  const file = join(dir, VOICE_FILE)
  const tmp = file + '.tmp'
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, JSON.stringify(doc))
    renameSync(tmp, file)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
  return doc
}

const realSpawn = (bin, args, opts) => spawn(bin, args, opts)

/** Runs one command to completion and resolves `{ code, stdout, stderr }` --
 *  never rejects, so a caller only has to look at `code`. stdout/stderr are
 *  kept to their last 4000 chars: `uv pip install` and the model download
 *  both stream a live progress display over many minutes, and this is only
 *  ever read for an error message's tail, never the whole transcript. */
const runCmd = (run, bin, argv, opts) => new Promise((resolve) => {
  let child
  try { child = run(bin, argv, opts) } catch (err) {
    resolve({ code: -1, stdout: '', stderr: String(err?.message ?? err) })
    return
  }
  let stdout = '', stderr = ''
  child.stdout?.on('data', (c) => { stdout = (stdout + c).slice(-4000) })
  child.stderr?.on('data', (c) => { stderr = (stderr + c).slice(-4000) })
  child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err?.message ?? err) }))
  child.on('close', (code) => resolve({ code, stdout, stderr }))
})

// A tiny inline script, passed as ONE argv element to `python -c` (never a
// shell string -- this spawns python directly, no shell in between). Does
// exactly what the settings section's progress bar watches for: writes
// large-v3-turbo.pt into `sys.argv[1]`, verified by the package's OWN
// sha256 check -- `in_memory=False` so the return value
// is a path, discarded here, we only care that it either raises or doesn't.
const DOWNLOAD_SCRIPT = 'import sys, whisper\nwhisper._download(whisper._MODELS["large-v3-turbo"], sys.argv[1], False)\n'

/** `dir` is WORLD_DIR: voice.json lives directly under it, the venv at
 *  `voice-env/`, the model under `models/`, and per-request temp WAVs under
 *  `voice-tmp/`. `uvBin`/`workerPy` are the already-resolved paths (see
 *  relay.mjs's SZG_UV_BIN/SZG_VOICE_WORKER_PY) — never re-resolved here.
 *  `run` is injected so test/voice-harness.mjs drives every failure mode —
 *  a failed venv create, a failed pip install, a truncated/corrupt
 *  download, a worker that dies mid-flight — with no real subprocess. */
export const createVoice = ({
  dir, uvBin = 'uv', workerPy = null, run = realSpawn, broadcast = () => {}, now = Date.now, model = MODEL,
}) => {
  const envDir = join(dir, ENV_DIR)
  const modelsDir = join(dir, MODELS_DIR)
  const modelPath = join(modelsDir, model.name)
  const tmpDir = join(dir, TMP_DIR)
  const venvPython = () => join(envDir, 'bin', 'python3')

  let installing = false
  let envProgress = 0
  let envError = null

  let downloading = false
  let modelProgress = 0
  let modelError = null

  let workerChild = null
  let workerUp = false
  let workerDevice = null
  let workerError = null
  let workerSpawning = null   // the in-flight spawn promise, so two callers share one spawn
  const pending = new Map()   // request id -> { resolve }
  let reqCounter = 0

  let busy = false
  let tail = Promise.resolve()

  // A marker WE write, not `bin/python3`'s mere existence: `uv venv` creates
  // that binary in PHASE ONE, before `uv pip install openai-whisper` (phase
  // two) has run at all -- so checking for the binary alone would read
  // "present" while the environment is still mid-install and unusable. The
  // marker is written only once phase two succeeds, and lives INSIDE envDir
  // so `remove('env'|'all')`'s `rmSync(envDir, ...)` clears it for free.
  const envReadyMarker = join(envDir, '.szg-ready')
  const envPresent = () => { try { return existsSync(envReadyMarker) } catch { return false } }
  const modelStat = () => { try { return statSync(modelPath) } catch { return null } }
  const modelPresent = (st) => !!st && st.size === model.bytes

  const state = () => {
    const v = readVoiceJson(dir)
    const envOk = envPresent()
    const st = modelStat()
    return {
      enabled: !!v.enabled,
      env: { present: envOk, bytes: envOk ? ENV_BYTES_ESTIMATE : 0, installing, progress: envProgress, error: envError },
      model: {
        name: model.name, present: modelPresent(st), bytes: st ? st.size : 0, expectedBytes: model.bytes,
        downloading, progress: modelProgress, error: modelError,
      },
      worker: { up: workerUp, device: workerDevice, error: workerError },
    }
  }

  const setEnabled = (on) => {
    writeVoiceJson(dir, { enabled: !!on })
    if (on) maybeWarmWorker()
    return state()
  }

  let lastBroadcast = 0
  const reportProgress = (force) => {
    const t = now()
    if (!force && t - lastBroadcast < PROGRESS_INTERVAL_MS) return
    lastBroadcast = t
    try { broadcast(state()) } catch {}
  }

  // ---------------------------------------------------------- env install --
  /** Two phases, broadcast between them: `uv venv --python 3.12 <envDir>`,
   *  then `uv pip install openai-whisper` with VIRTUAL_ENV pointed at it
   *  Coarse progress (0 -> 0.5 -> 1) rather than parsed from uv's own
   *  streaming progress bars, which are meant for a terminal, not a parser. */
  const runInstall = async () => {
    try {
      const r1 = await runCmd(run, uvBin, ['venv', '--python', '3.12', envDir], { stdio: ['ignore', 'pipe', 'pipe'] })
      if (r1.code !== 0) throw new Error(r1.stderr.trim() || `uv venv exited ${r1.code}`)
      envProgress = 0.5
      reportProgress(true)
      const r2 = await runCmd(run, uvBin, ['pip', 'install', 'openai-whisper'], {
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VIRTUAL_ENV: envDir },
      })
      if (r2.code !== 0) throw new Error(r2.stderr.trim() || `uv pip install exited ${r2.code}`)
      writeFileSync(envReadyMarker, '')
      envProgress = 1
      envError = null
      maybeWarmWorker()
    } catch (err) {
      envError = String(err?.message ?? err)
    } finally {
      installing = false
      reportProgress(true)
    }
  }

  /** A second call while one is running answers `{ already: true }` — the
   *  flag is set synchronously, before any await, so two calls arriving back
   *  to back within one relay tick cannot both see it clear. */
  const install = () => {
    if (installing) return Promise.resolve({ already: true })
    installing = true
    envProgress = 0
    envError = null
    reportProgress(true)
    runInstall().catch(() => {})
    return Promise.resolve({ ok: true, started: true })
  }

  // ------------------------------------------------------------ download --
  /** Runs the venv's OWN python with DOWNLOAD_SCRIPT, which is where the
   * real fetch and the real sha256 check happen --
   *  this function's only job is to run that to completion and watch the
   *  target file grow on disk in the meantime, polling rather than parsing
   *  the subprocess's tqdm progress bar (meant for a terminal). There is no
   *  `.part` staging file: whisper._download writes straight to the real path, so an interrupted download can leave a
   *  short or wrong-hash file sitting there -- which is exactly why
   *  `modelPresent` above checks size, not just existence, and why a
   *  failure here deletes whatever got left. */
  const runDownload = async () => {
    let poll = null
    try {
      modelError = null
      modelProgress = 0
      reportProgress(true)
      mkdirSync(modelsDir, { recursive: true })
      poll = setInterval(() => {
        try {
          const st = statSync(modelPath)
          modelProgress = model.bytes ? Math.min(1, st.size / model.bytes) : 0
        } catch { /* not created yet */ }
        reportProgress(false)
      }, PROGRESS_INTERVAL_MS)
      const r = await runCmd(run, venvPython(), ['-c', DOWNLOAD_SCRIPT, modelsDir], { stdio: ['ignore', 'pipe', 'pipe'] })
      if (r.code !== 0) throw new Error(r.stderr.trim().slice(-2000) || `download exited ${r.code}`)
      const st = statSync(modelPath)
      if (st.size !== model.bytes) throw new Error(`unexpected size: ${st.size} bytes (want ${model.bytes})`)
      modelProgress = 1
      modelError = null
      maybeWarmWorker()
    } catch (err) {
      modelError = String(err?.message ?? err)
      try { unlinkSync(modelPath) } catch {}
    } finally {
      if (poll) clearInterval(poll)
      downloading = false
      reportProgress(true)
    }
  }

  const download = () => {
    if (downloading) return Promise.resolve({ already: true })
    downloading = true
    modelProgress = 0
    modelError = null
    reportProgress(true)
    runDownload().catch(() => {})
    return Promise.resolve({ ok: true, started: true })
  }

  /** `what` is 'model' (default), 'env' or 'all' (routes table). */
  const remove = (what) => {
    const w = what || 'model'
    if (w === 'model' || w === 'all') {
      try { unlinkSync(modelPath) } catch {}
      modelProgress = 0
      modelError = null
    }
    if (w === 'env' || w === 'all') {
      try { rmSync(envDir, { recursive: true, force: true }) } catch {}
      envProgress = 0
      envError = null
    }
    reportProgress(true)
    return state()
  }

  // --------------------------------------------------------- the worker --
  /** Spawns the persistent worker if it is not already up (or already being
   *  spawned -- a second caller arriving mid-spawn shares the same promise
   *  rather than starting a second process). Resolves once the worker's
   *  "ready" line arrives; rejects on a spawn failure, an early exit, or the
   *  ready timeout -- any of which leaves `workerChild` null so the NEXT
   * call spawns fresh (a dead worker is respawned, spec's). */
  const spawnWorker = () => new Promise((resolve, reject) => {
    let child
    try {
      child = run(venvPython(), [workerPy, modelsDir], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      workerError = String(err?.message ?? err)
      reject(new Error(workerError))
      return
    }
    workerChild = child
    workerUp = false
    let settled = false
    let stderrTail = ''
    let outBuf = ''
    const readyTimer = setTimeout(() => {
      settle(new Error(`voice worker did not report ready within ${WORKER_READY_TIMEOUT_MS}ms`))
    }, WORKER_READY_TIMEOUT_MS)
    readyTimer.unref?.()

    const settle = (err) => {
      if (settled) return
      settled = true
      clearTimeout(readyTimer)
      if (err) { workerError = String(err?.message ?? err); reject(err) } else resolve()
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      outBuf += chunk
      let idx
      while ((idx = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, idx)
        outBuf = outBuf.slice(idx + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.ready) {
          workerUp = true
          workerDevice = msg.device || null
          workerError = null
          settle(null)
        } else if (msg.id != null && pending.has(msg.id)) {
          const p = pending.get(msg.id)
          pending.delete(msg.id)
          p.resolve(msg)
        }
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (c) => { stderrTail = (stderrTail + c).slice(-4000) })
    child.on('error', (err) => {
      workerUp = false
      settle(err)
    })
    child.on('exit', (code) => {
      workerUp = false
      workerChild = null
      const err = new Error(stderrTail.trim() || `voice worker exited ${code}`)
      settle(err)
      for (const [id, p] of pending) p.resolve({ id, ok: false, error: err.message })
      pending.clear()
    })
  })

  const ensureWorker = () => {
    if (workerChild && workerUp) return Promise.resolve()
    if (workerSpawning) return workerSpawning
    workerSpawning = spawnWorker().finally(() => { workerSpawning = null })
    return workerSpawning
  }

  /** Warms the worker proactively, the moment everything it needs exists,
   *  rather than waiting for the first dictation to ask for it. Without
   *  this, `ready` (enabled && env && model && worker.up) could never
   *  become true on its own -- the worker only starts on a transcribe
   *  call, and a transcribe call needs a mic button, which needs `ready`.
   *  Called after setEnabled(true), after a successful install/download
   *  (either can be the last piece to arrive), and once at construction so
   *  a relay restarted with everything already on disk warms up without
   *  waiting for a user to toggle anything. Fire-and-forget: any failure
   *  is already recorded on state().worker.error by spawnWorker itself. */
  const maybeWarmWorker = () => {
    if (workerChild || workerSpawning) return
    if (!readVoiceJson(dir).enabled) return
    if (!envPresent()) return
    if (!modelPresent(modelStat())) return
    ensureWorker().catch(() => {})
  }

  const sendToWorker = (payload) => ensureWorker().then(() => new Promise((resolve, reject) => {
    if (!workerChild) { reject(new Error('voice worker is not running')); return }
    const id = String(++reqCounter)
    pending.set(id, { resolve })
    try {
      workerChild.stdin.write(JSON.stringify({ id, ...payload }) + '\n')
    } catch (err) {
      pending.delete(id)
      reject(err)
    }
  }))

  /** One transcription, start to finish: writes the WAV to a temp file
   *  (unlinked in a `finally`, gone whether the worker succeeds, fails, or
   *  never answers), sends it to the worker, and maps the response onto the
   *  `{ ok, status, ... }` shape every route handler already expects. */
  const runOne = async (buf) => {
    const wavPath = join(tmpDir, `t-${now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
    try {
      mkdirSync(tmpDir, { recursive: true })
      writeFileSync(wavPath, buf)
    } catch (err) {
      return { ok: false, status: 500, error: `could not write temp WAV: ${err.message}` }
    }
    try {
      const msg = await sendToWorker({ wav: wavPath, language: 'en' })
      if (!msg || !msg.ok) return { ok: false, status: 502, error: (msg && msg.error) || 'the voice worker failed' }
      return { ok: true, text: msg.text || '' }
    } catch (err) {
      return { ok: false, status: 503, error: `voice worker unavailable: ${err.message}` }
    } finally {
      try { unlinkSync(wavPath) } catch {}
    }
  }

  /**  one transcription at a time, and a partial yields
   *  to a final. A `partial` request answers 409 immediately if anything is
   *  in flight (never queued -- it is disposable). A FINAL always runs,
   *  queued (FIFO, via `tail`) behind whatever is currently running or
   *  already queued, including a partial. */
  const transcribe = ({ buf, partial }) => {
    if (partial) {
      if (busy) return Promise.resolve({ ok: false, status: 409, error: 'a transcription is already in flight' })
      busy = true
      const p = runOne(buf).finally(() => { busy = false })
      tail = p.catch(() => {})
      return p
    }
    const p = tail.then(() => {
      busy = true
      return runOne(buf).finally(() => { busy = false })
    })
    tail = p.catch(() => {})
    return p
  }

  /** Called from the relay's SIGINT path, beside the canvas flush. Kills the
   *  worker if one is running; a no-op with nothing up. */
  const stop = () => { if (workerChild) { try { workerChild.kill('SIGTERM') } catch {} } }

  // A relay restarted with enabled+env+model already on disk from a prior
  // session should not need a user to touch anything before `ready` goes
  // true -- warm the worker now, once, rather than waiting for the first
  // transcribe request that only a `ready` button would ever trigger.
  maybeWarmWorker()

  return { state, setEnabled, install, download, remove, transcribe, stop }
}
