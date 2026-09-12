// Syzygy — voice input's AudioWorklet processor.
//
// Collects Float32Array frames from the microphone and posts each block to
// the main thread as it arrives. No buffering and no resampling happen here:
// AudioWorkletGlobalScope is an isolated realm that cannot reach voice-math.js
// (a classic script loaded into the DOCUMENT's scope), so the one pure
// resample function lives in exactly one place — on the main thread, in
// voice.js — rather than being duplicated into this worklet's realm too.
'use strict'

class MCVCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length) {
      // .slice() copies: the engine reuses the underlying buffer for the next
      // render quantum, so what crosses postMessage must be this block's own.
      this.port.postMessage(channel.slice())
    }
    return true   // keep the processor alive for the life of the node
  }
}

registerProcessor('mcv-capture', MCVCapture)
