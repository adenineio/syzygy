/* Syzygy — voice input's pane side. A CLASSIC script, global MCV, loaded
   AFTER reconcile.js and voice-math.js (see index.html) — after reconcile.js
   because that is this project's convention for every classic script here,
   and after voice-math.js because everything below reaches into
   MCVM for its pure math (resampleLinear, encodeWav, insertAtCaret,
   fieldKind, voiceReady, replaceRegion, micRect) rather than re-implementing
   any of it.

   Everything here — discovery, the key handlers doing anything at all,
   getUserMedia, the AudioContext — is gated on MCVM.voiceReady(state).
   `state` is the app's own S object, handed in by attach() and read
   live rather than copied, so a later SSE `voice` event that flips `ready`
   is visible here without a second wiring path.

   Discovery converges, it does not defend: it does not need to
   survive MCX's reconciliation elsewhere in the pane, because it re-runs on
   every DOM mutation (one MutationObserver on #app, coalesced into a
   requestAnimationFrame) and puts back whatever a sibling's re-render took
   away. It ignores mutations of its own [data-mcv] nodes, or the observer
   would drive itself in a loop.

   Live transcription while listening: the browser
   keeps posting the whole accumulated utterance so far as `?partial=1`, at
   most one such request in flight, the next starting only when the previous
   returns AND `chunkMs` has elapsed. Each answer replaces exactly the region
   this module owns (`MCVM.replaceRegion`) — `[anchor,
   anchor+length)` from the caret where listening began, collapsed past any
   open selection so one is never overwritten. Setting `field.value`
   programmatically never fires a real `input` event (only user typing or
   execCommand does), so any `input` this module did NOT itself cause is an
   unambiguous "the user is typing" signal: it commits what is already there
   and releases the region rather than fighting them for it. The mic button
   sits on the field's OWN box rather than its parent's, via `MCVM.micRect`,
   re-measured on discovery, on window resize, and from a `ResizeObserver`
   per field. */
'use strict'

const MCV = (() => {
  const SAMPLE_RATE = 16000
  const HOLD_MIN_MS = 300   // a hold shorter than this sends no audio
  const KEY_HTML = '<kbd>&#8963;</kbd>'   // the Control glyph, matching app.js's KEY()
  const CHUNK_MS_DEFAULT = 2500   // overridden by S.voice.chunkMs when the relay sends one
  const MIC_SIZE = 22, MIC_INSET = 6, MIC_GRIP_CLEAR = 14

  let S = null
  let redraw = () => {}
  let toastFn = () => {}
  let attached = false

  let mo = null
  let rafPending = false

  /** M is this module's own live state -- the hooks-plugin convention
     (hud.tsx keeps its live state in a module-scope `M` for the same
     reason: the engine there refuses a closure over `$`, but the shape is
     worth reusing regardless). Never touched from outside this IIFE. */
  const M = {
    // region: { anchor, length } | null -- the live-transcription span this
    // capture owns; foreign: true once a real user `input` has
    // released it ("commits and releases"); partialTimer/
    // partialInFlight: the chunked-partial loop's own bookkeeping.
    active: null,        // { field, trigger, stream, ctx, source, node, chunks, startedAt, actualRate, region, foreign, partialTimer, partialInFlight } | null
    transcribing: false,
    ctrlHeld: false,
  }

  const ready = () => !!(MCVM && MCVM.voiceReady(S))

  // ---------------------------------------------------------- discovery --
  const ancestorVoiceOf = (el) => {
    let n = el.parentElement
    while (n) {
      if (n.dataset && 'voice' in n.dataset) return n.dataset.voice
      n = n.parentElement
    }
    return undefined
  }

  const kindOf = (el) => MCVM.fieldKind({
    tag: el.tagName, type: el.type, voice: el.dataset ? el.dataset.voice : undefined, ancestorVoice: ancestorVoiceOf(el),
  })

  const eligibleField = (el) => {
    if (!el || !el.tagName) return null
    const kind = kindOf(el)
    return kind === 'full' || kind === 'modifier' ? el : null
  }

  const isOwnButton = (node) => !!(node && node.dataset && node.dataset.mcv === 'button')

  /**  measured from the FIELD's own box (offsetLeft/Top/Width/
   * Height within its offsetParent), never assumed to fill its parent's.
   * `.mcv-host` (the shared offsetParent both the field and the button sit
   * in) still needs `position: relative` to establish that containing
   * block -- but the coordinates themselves come from the field, not from
   * "the parent's box". */
  const positionButton = (field, btn) => {
    const { left, top } = MCVM.micRect({
      field: { offsetLeft: field.offsetLeft, offsetTop: field.offsetTop, offsetWidth: field.offsetWidth, offsetHeight: field.offsetHeight },
      inset: MIC_INSET, size: MIC_SIZE, gripClear: MIC_GRIP_CLEAR,
    })
    btn.style.left = left + 'px'
    btn.style.top = top + 'px'
  }

  // One ResizeObserver per field with a button, so a user dragging `.dta`'s
  // native (resize: vertical) handle keeps the button glued to the corner
  // that moved. Disconnected in removeButtonFor -- an observer on a field
  // whose button is gone would just leak.
  const fieldResizers = new WeakMap()
  const observeFieldResize = (field, btn) => {
    if (fieldResizers.has(field) || typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(() => positionButton(field, btn))
    ro.observe(field)
    fieldResizers.set(field, ro)
  }

  const makeButton = (field) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'mcv-mic'
    btn.dataset.mcv = 'button'
    btn.setAttribute('aria-label', 'Dictate')
    btn.title = 'Dictate — or hold Control while focused here'
    btn.textContent = '\u{1F399}'   // microphone
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      onMicClick(field)
    })
    return btn
  }

  const ensureButton = (field) => {
    const sib = field.nextElementSibling
    const btn = isOwnButton(sib) ? sib : makeButton(field)
    if (!isOwnButton(sib) && field.parentElement) field.parentElement.insertBefore(btn, field.nextSibling)
    positionButton(field, btn)
    observeFieldResize(field, btn)
    return btn
  }

  const removeButtonFor = (field) => {
    const sib = field.nextElementSibling
    if (isOwnButton(sib)) sib.remove()
    const ro = fieldResizers.get(field)
    if (ro) { ro.disconnect(); fieldResizers.delete(field) }
  }

  /** Re-measures every button already on the page -- window resizes affect
   * every field's box at once, so this is cheaper and simpler than each
   * field carrying its own resize listener. */
  const repositionAllButtons = () => {
    for (const btn of document.querySelectorAll('[data-mcv="button"]')) {
      const field = btn.previousElementSibling
      if (field) positionButton(field, btn)
    }
  }

  const teardownAllButtons = () => {
    for (const btn of document.querySelectorAll('[data-mcv="button"]')) btn.remove()
  }

  // live browser check (Step 3) found `#lm-note` (the link
  // dialog's textarea) never got a button: `#linkmodal` is a SIBLING of
  // `#app`, not a descendant (a plain child of `<body>`, the same as
  // `#drawer` — verified live), so an `#app`-scoped query structurally
  // cannot reach it, no matter how long it waits. `document.body` covers
  // every one of the pane's real fields, `#app` and its siblings alike --
  // which is also what lets the drawer's reply field pick the button up for
  // free once it exists.
  const discoveryRoot = () => document.body

  const discover = () => {
    if (!ready()) { teardownAllButtons(); return }
    const app = discoveryRoot()
    if (!app) return
    for (const field of app.querySelectorAll('textarea, input')) {
      if (isOwnButton(field)) continue   // never true, but keeps the intent explicit
      if (kindOf(field) === 'full') {
        ensureButton(field)
        if (field.parentElement) field.parentElement.classList.add('mcv-host')
      } else {
        removeButtonFor(field)
      }
    }
  }

  const scheduleDiscover = () => {
    if (rafPending) return
    rafPending = true
    requestAnimationFrame(() => { rafPending = false; discover() })
  }

  /** True for a node that is part of what THIS module injects — a mic
   * button, or a text node moved as part of one. Mutations touching only
   * these must not re-trigger discovery, or the observer drives itself. */
  const isOurs = (node) => node && node.nodeType === 1 && (isOwnButton(node) || node.dataset?.mcv != null)

  const startObserving = () => {
    if (mo) return
    const app = discoveryRoot()
    if (!app) return
    mo = new MutationObserver((records) => {
      const relevant = records.some((r) => {
        if (isOurs(r.target)) return false
        for (const n of r.addedNodes) if (!isOurs(n)) return true
        for (const n of r.removedNodes) if (!isOurs(n)) return true
        return false
      })
      if (relevant) scheduleDiscover()
    })
    mo.observe(app, { childList: true, subtree: true })
  }

  // ------------------------------------------------------------ helpers --
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))

  const fieldLabel = (field) => {
    if (!field) return ''
    const lbl = field.labels && field.labels[0]
    if (lbl && lbl.textContent && lbl.textContent.trim()) return lbl.textContent.trim()
    if (field.getAttribute && field.getAttribute('aria-label')) return field.getAttribute('aria-label')
    if (field.placeholder) return field.placeholder
    if (field.name) return field.name
    return ''
  }

  const setFieldListening = (field, on) => {
    if (!field) return
    field.classList.toggle('mcv-listening', on)
    const sib = field.nextElementSibling
    if (isOwnButton(sib)) sib.classList.toggle('on', on)
  }

  const mergeChunks = (chunks) => {
    let total = 0
    for (const c of chunks) total += c.length
    const out = new Float32Array(total)
    let off = 0
    for (const c of chunks) { out.set(c, off); off += c.length }
    return out
  }

  // ------------------------------------------------------------ capture --
  /** How often the live-transcription loop may have a partial in flight
   *  The relay's own figure when it has sent one, so the
   * browser and the relay can never disagree about the cadence; 2500ms
   * otherwise (an older relay sends no `voice.chunkMs` at all). */
  const chunkMsFor = () => {
    const n = S && S.voice && Number(S.voice.chunkMs)
    return n > 0 ? n : CHUNK_MS_DEFAULT
  }

  /**   rule, applied to where a NEW region starts: an open
   * selection is collapsed to its END rather than owned/overwritten. */
  const regionStartFor = (field) => {
    const start = field.selectionStart, end = field.selectionEnd
    if (typeof start === 'number' && typeof end === 'number' && end > start) return end
    return typeof end === 'number' ? end : field.value.length
  }

  const clearPartialTimer = (a) => { if (a.partialTimer) { clearTimeout(a.partialTimer); a.partialTimer = null } }

  /**  replaces exactly the region this capture owns with better
   * text as it arrives. Never dispatches `input`/`change` -- setting
   * `.value` directly does not fire one either, which is exactly what lets
   * onForeignInput below tell "we wrote this" from "the user typed"
   * without a separate flag. */
  const applyProvisional = (a, text) => {
    const field = a.field
    const region = a.region || (a.region = { anchor: field.value.length, length: 0 })
    const { value, length, caret } = MCVM.replaceRegion({ value: field.value, anchor: region.anchor, length: region.length, text })
    field.value = value
    region.length = length
    if (typeof field.setSelectionRange === 'function') field.setSelectionRange(caret, caret)
    field.classList.add('mcv-provisional')
  }

  /** The chunked-partial loop itself: posts the WHOLE accumulated utterance
   * so far, at most one such request in flight, the next scheduled only
   * once this one returns (success OR failure -- a dropped partial costs a
   * redraw, never a retry storm). Silently drops a 409 : a
   * partial yields to a final) and any other failure -- partials are
   * disposable by construction; only the FINAL pass's failure is worth a
   * toast. */
  const partialLoop = (a) => {
    if (M.active !== a || a.foreign) return
    if (!a.chunks.length) { a.partialTimer = setTimeout(() => partialLoop(a), chunkMsFor()); return }
    a.partialInFlight = true
    const merged = mergeChunks(a.chunks)
    const resampled = MCVM.resampleLinear(merged, a.actualRate, SAMPLE_RATE)
    const wav = MCVM.encodeWav(resampled, SAMPLE_RATE)
    fetch('/api/voice/transcribe?partial=1', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav', 'x-mch-token': window.SZG_TOKEN },
      body: wav,
    }).then((res) => (res.ok ? res.json() : null)).then((j) => {
      if (M.active !== a || a.foreign) return
      if (j && j.ok && typeof j.text === 'string') applyProvisional(a, j.text)
    }).catch(() => {}).finally(() => {
      a.partialInFlight = false
      if (M.active === a && !a.foreign) a.partialTimer = setTimeout(() => partialLoop(a), chunkMsFor())
    })
  }

  /** An `input` event on the field this capture owns that THIS module did
   * not raise -- setting `.value` never fires one, so this is unambiguously
   * the user typing. Commit what is already there (nothing to do: it is
   * already in the field) and release the region rather than
   * fighting them for it, by discarding the rest of the capture outright. */
  const onForeignInput = (e) => {
    const a = M.active
    if (!a || a.field !== e.target || a.foreign) return
    a.foreign = true
    clearPartialTimer(a)
    a.field.classList.remove('mcv-provisional')
    stopCapture(true)
  }

  /** Opened per capture and released on stop -- never held
   * open between dictations, so the browser's mic indicator is lit only
   * while something is actually being recorded. */
  const startCapture = (field, trigger) => {
    if (M.active || !ready()) return
    // Held by IDENTITY, not by re-reading M.active and comparing field+trigger:
    // a capture aborted and restarted on the same field with the same trigger
    // would pass that comparison and let a stale promise write into the new
    // one. `mine` is the activation this call owns, and nothing else is.
    const mine = {
      field, trigger, startedAt: (window.performance || Date).now(), chunks: [], stream: null, ctx: null, source: null, node: null, actualRate: SAMPLE_RATE,
      region: { anchor: regionStartFor(field), length: 0 }, foreign: false, partialTimer: null, partialInFlight: false,
    }
    M.active = mine
    field.addEventListener('input', onForeignInput)
    mine.partialTimer = setTimeout(() => partialLoop(mine), chunkMsFor())
    setFieldListening(field, true)
    redraw()
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } }).then((stream) => {
      if (M.active !== mine) {
        // Aborted (key released, another key pressed, blur...) before the
        // permission prompt resolved. Never leave the mic open.
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      mine.stream = stream
      const AC = window.AudioContext || window.webkitAudioContext
      const ctx = new AC({ sampleRate: SAMPLE_RATE })
      mine.ctx = ctx
      mine.actualRate = ctx.sampleRate
      ctx.audioWorklet.addModule('/voice-worklet.js').then(() => {
        if (M.active !== mine) return   // aborted while the module was loading
        const source = ctx.createMediaStreamSource(stream)
        const node = new AudioWorkletNode(ctx, 'mcv-capture')
        node.port.onmessage = (e) => { if (M.active === mine) mine.chunks.push(e.data) }
        source.connect(node)
        mine.source = source
        mine.node = node
      }).catch((err) => {
        toastFn('Voice: could not start capture — ' + (err?.message || err))
        stopCapture(true)
      })
    }).catch((err) => {
      // The FIRST thing a new user hits: Chrome without the macOS microphone
      // grant rejects here. Clearing the listening state is not cosmetic --
      // without it the field and its button stay lit for the rest of the
      // page's life with nothing recording, and clicking the mic again is a
      // no-op because M.active is already null, so there is no way back.
      toastFn('Voice: microphone unavailable — ' + (err?.message || err))
      if (M.active !== mine) return   // a later capture owns the field now
      M.active = null
      setFieldListening(field, false)
      redraw()
    })
  }

  const releaseCapture = (a) => {
    clearPartialTimer(a)
    try { a.field && a.field.removeEventListener('input', onForeignInput) } catch {}
    try { a.node && a.node.disconnect() } catch {}
    try { a.source && a.source.disconnect() } catch {}
    try { a.stream && a.stream.getTracks().forEach((t) => t.stop()) } catch {}
    try { a.ctx && a.ctx.close() } catch {}
  }

  /** `discard` drops whatever was captured with no transcription request --
   * every abort path in goes through here with discard=true. */
  const stopCapture = (discard) => {
    const a = M.active
    if (!a) return
    M.active = null
    releaseCapture(a)
    setFieldListening(a.field, false)
    redraw()
    if (discard) return
    const heldMs = (window.performance || Date).now() - a.startedAt
    if (a.trigger === 'hold' && heldMs < HOLD_MIN_MS) return   // brushing the key sends no audio
    if (!a.chunks.length) return
    void sendCapture(a)
  }

  /**  one FINAL pass over the whole utterance, which
   * REPLACES everything provisional -- so the committed text is always a
   * single coherent transcription, never a seam of several partial
   * guesses. This is the one point in the whole flow that dispatches real
   * `input`/`change` events: by the time it runs, `releaseCapture` has
   * already removed onForeignInput from this field, so committing our own
   * final text cannot be mistaken for the user typing. */
  const sendCapture = async (a) => {
    M.transcribing = true
    redraw()
    try {
      const merged = mergeChunks(a.chunks)
      const resampled = MCVM.resampleLinear(merged, a.actualRate, SAMPLE_RATE)
      const wav = MCVM.encodeWav(resampled, SAMPLE_RATE)
      const res = await fetch('/api/voice/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'audio/wav', 'x-mch-token': window.SZG_TOKEN },
        body: wav,
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.ok) {
        toastFn('Voice: ' + (j.error || `transcription failed (${res.status})`))
        return
      }
      finalizeInto(a, j.text || '')
    } catch (err) {
      toastFn('Voice: ' + (err?.message || err))
    } finally {
      if (a.field) a.field.classList.remove('mcv-provisional')
      M.transcribing = false
      redraw()
    }
  }

  const finalizeInto = (a, text) => {
    const field = a.field
    const region = a.region || { anchor: field.value.length, length: 0 }
    // Nothing provisional ever appeared, and the final pass came back empty
    // too: nothing changed, so this is a silent no-op -- an empty result with
    // no provisional guess to remove has nothing to do.
    if (!text && !region.length) return
    const { value, caret } = MCVM.replaceRegion({ value: field.value, anchor: region.anchor, length: region.length, text: text || '' })
    field.value = value
    if (typeof field.setSelectionRange === 'function') field.setSelectionRange(caret, caret)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
    field.focus()
  }

  const onMicClick = (field) => {
    if (!ready()) return
    if (M.active) {
      if (M.active.field === field) stopCapture(false)
      return   // a different capture is already running; one mic at a time
    }
    startCapture(field, 'click')
  }

  // ------------------------------------------------ Control push-to-talk --
  // every guard: `M.ctrlHeld` makes a keydown REPEAT a no-op;
  // any other key while Control is down aborts and discards (macOS emacs
  // bindings — ^a ^e ^k — live in every textarea and must keep working);
  // contextmenu (Control-click is right-click on macOS), blur and
  // visibilitychange all abort too.
  const onKeydown = (e) => {
    if (!ready()) return
    if (e.key === 'Control') {
      if (M.ctrlHeld) return
      M.ctrlHeld = true
      const field = eligibleField(document.activeElement)
      if (field) startCapture(field, 'hold')
      redraw()
      return
    }
    if (M.ctrlHeld) {
      M.ctrlHeld = false
      if (M.active && M.active.trigger === 'hold') stopCapture(true)
      redraw()
    }
  }
  const onKeyup = (e) => {
    if (e.key !== 'Control') return
    const wasHeld = M.ctrlHeld
    M.ctrlHeld = false
    if (wasHeld && M.active && M.active.trigger === 'hold') stopCapture(false)
    else redraw()
  }
  const abortHeld = () => {
    if (!M.ctrlHeld && !(M.active && M.active.trigger === 'hold')) return
    M.ctrlHeld = false
    if (M.active && M.active.trigger === 'hold') stopCapture(true)
    else redraw()
  }
  const onContextmenu = () => abortHeld()
  const onWindowBlur = () => abortHeld()
  const onVisibility = () => { if (document.hidden) abortHeld() }

  // --------------------------------------------------------- mode line --
  /** Consulted FIRST by app.js's renderModeline, so voice takes
   * precedence over the existing chain while anything here is live.
   * Returns '' when there is nothing to say, so the fallback chain runs. */
  const modeline = () => {
    if (!ready()) return ''
    if (M.transcribing) return 'Transcribing your last recording&#8230;'
    if (M.active) {
      const label = fieldLabel(M.active.field)
      const target = label ? `<b>${escapeHtml(label)}</b>` : 'this field'
      const via = M.active.trigger === 'hold' ? `release ${KEY_HTML}` : 'click the mic'
      return `Listening — dictating into ${target}. ${via[0].toUpperCase()}${via.slice(1)} to stop.`
    }
    if (M.ctrlHeld) return `${KEY_HTML} held — focus a text field to dictate into it.`
    return ''
  }

  // -------------------------------------------------------------- attach --
  /** `state` is app.js's own S object (read live, not copied); `redrawModeline`
   * and `toast` are app.js's own functions, handed in rather than reached for
   * globally, the same shape MCC.attach and MCP.attach already take. */
  const attach = ({ state, redrawModeline, toast }) => {
    S = state
    redraw = redrawModeline || (() => {})
    toastFn = toast || (() => {})
    if (attached) return
    attached = true
    document.addEventListener('keydown', onKeydown, true)
    document.addEventListener('keyup', onKeyup, true)
    window.addEventListener('contextmenu', onContextmenu, true)
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('visibilitychange', onVisibility)
    // a window resize moves every field's box at once, so every
    // button gets re-measured from it -- a per-field ResizeObserver (wired in
    // ensureButton) covers the OTHER way a field's box changes, dragging the
    // native resize handle.
    window.addEventListener('resize', repositionAllButtons)
    startObserving()
    discover()
  }

  /** Called whenever `state.voice` changes (the SSE `voice` event, or the
   * snapshot) so buttons appear/disappear immediately rather than waiting
   * for an unrelated DOM mutation to trigger the observer. :
   * when `ready` goes false every injected button is removed. */
  const refresh = () => discover()

  return { attach, refresh, modeline }
})()
