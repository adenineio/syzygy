/* Syzygy -- the relay's event stream, as a registry.
 *
 * One EventSource, and handlers registered by event name from whichever file
 * owns the feature they serve:
 *
 *     MCE.on('mything', (d) => { ... })
 *
 * An event may carry any number of handlers. They are called in registration
 * order, on one JSON.parse of the frame, so a new live update is a line beside
 * its own feature rather than an edit to a shared switch.
 *
 * A CLASSIC script, like reconcile.js/projects.js and unlike swarm.js -- it
 * must be loaded BEFORE its consumers in index.html, and its global is a
 * lexical global, NOT a window property. `test/stream-harness.mjs` evaluates it
 * through `new Function` with `window` and `console` passed in.
 *
 * NO RECONNECTION LOGIC LIVES HERE, deliberately. The retry is the browser's
 * own, on the interval the relay dictates with its `retry: 1000` line, and the
 * pane has never had a backoff of its own. Adding one would change behaviour. */
'use strict'

const MCE = (() => {
  // event name -> handlers, in registration order. Registration order IS call
  // order, and since every registration is a top-level statement in app.js it
  // is also source order, top to bottom.
  const HANDLERS = new Map()
  // Event names that already carry a native listener on the LIVE source.
  // Cleared and rebuilt by connect(), which is what stops a reconnect or a
  // second connect() from fanning one frame out twice.
  const ATTACHED = new Set()
  // The EventSource's own two events. They carry no `data`, so there is
  // nothing to parse and their handlers get (null, ev).
  const RAW = new Set(['open', 'error'])

  let src = null
  let st = { status: 'idle', url: null, openedAt: null, opens: 0, error: null }

  /** A copy, never the live object: a caller that mutated what it was handed
   *  would be editing the connection's own record of itself. */
  const state = () => ({ ...st })

  const fan = (name, data, ev) => {
    const list = HANDLERS.get(name)
    if (!list) return
    // Iterate a copy: a handler may register or drop another mid-fan-out, and
    // this frame must see the list as it was when the frame arrived.
    for (const fn of [...list]) {
      try {
        fn(data, ev)
      } catch (e) {
        // One feature's bug must not silence another feature's handler on the
        // same frame. It only matters once an event has more than one
        // handler, which is exactly what the registry exists to allow.
        console.error('stream: handler for "' + name + '" threw', e)
      }
    }
  }

  const deliver = (name) => (ev) => {
    if (RAW.has(name)) { fan(name, null, ev); return }
    let data
    try {
      data = JSON.parse(ev.data)
    } catch (e) {
      // An unparseable frame runs no handler at all -- the same outcome as a
      // handler whose first statement is JSON.parse -- and is reported rather
      // than thrown.
      console.error('stream: unparseable frame on "' + name + '"', e)
      return
    }
    fan(name, data, ev)
  }

  const attach = (name) => {
    if (!src || ATTACHED.has(name)) return
    ATTACHED.add(name)
    src.addEventListener(name, deliver(name))
  }

  /** Register a handler for one named frame. Returns an `off()` that removes
   *  exactly this registration. Safe before or after connect(). */
  const on = (name, fn) => {
    let list = HANDLERS.get(name)
    if (!list) { list = []; HANDLERS.set(name, list) }
    list.push(fn)
    attach(name)              // a no-op before connect(), which attaches the rest
    return () => {
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    }
  }

  /** One field of the snapshot frame, delivered only when the frame actually
   *  carries it. Sugar over on('snapshot', ...) so there is one mechanism and
   *  one ordering rule, not two.
   *
   *  `name in d` and not `d[name] != null`: a relay that predates a field sends
   *  no key at all, and a client reading a missing payload field fails
   *  SILENTLY. Absence is the case worth distinguishing; an empty array or a
   *  null the relay meant to send is real data and is delivered. */
  const onField = (name, fn) => on('snapshot', (d) => { if (d && name in d) fn(d[name], d) })

  /** Open the stream. `opts.EventSource` exists only so the harness can drive a
   *  fake; production passes nothing. Calling this while a source is live
   *  closes that one first -- no call site does, and the rule is here so a
   *  future one cannot silently double-fire every frame. */
  const connect = (url, opts = {}) => {
    const Source = opts.EventSource || globalThis.EventSource
    if (src) { try { src.close() } catch (e) { /* already closed */ } }
    ATTACHED.clear()
    st = { status: 'connecting', url, openedAt: null, opens: st.opens, error: null }
    const s = new Source(url)
    src = s
    // Its own bookkeeping first, ahead of anything registered through on(), so
    // a handler calling state() already sees the status its own event produced.
    s.addEventListener('open', () => {
      st = { ...st, status: 'open', openedAt: Date.now(), opens: st.opens + 1, error: null }
    })
    s.addEventListener('error', () => {
      // No close(), no new source: readyState 2 means the browser has given up,
      // anything else means it is still retrying on its own.
      st = { ...st, status: s.readyState === 2 ? 'closed' : 'reconnecting', error: 'stream error' }
    })
    for (const name of HANDLERS.keys()) attach(name)
    return s
  }

  return { on, onField, connect, state }
})()
