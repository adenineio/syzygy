/* Syzygy -- keyed DOM reconciliation.
 *
 * The generalisation of the loop `app.js` already runs for session cards
 * (`renderCards`, ~line 688): build a map of what is there, reuse by key, move
 * a node only when its position is actually wrong, remove what was not kept.
 * That loop is why a card keeps its `:hover` through a payload; this module is
 * the same idea made reusable and testable.
 *
 * A CLASSIC script, like replay.js/projects.js and unlike swarm.js -- it must
 * be loaded BEFORE its consumers in index.html. `test/reconcile-harness.mjs`
 * evaluates it through `new Function` with `window` passed in.
 *
 * NO ANIMATIONS LIVE HERE, and no animation library is vendored: one gets
 * described and agreed before it is built. `enter` and `exit` are the seams
 * that make one possible later; today nothing passes them. */
'use strict'

const MCX = (() => {
  // node -> key. A WeakMap and not a data- attribute because keys here are
  // absolute paths and may carry a NUL separator, which an attribute cannot.
  // `data-rkey` is written on create for devtools and is NEVER read back, so
  // sanitising it for display cannot affect identity.
  const KEY = new WeakMap()

  const RKEY_UNSAFE = /[\u0000-\u001f]/g

  /** Read live, not cached at load: a reader can change the setting while the
   *  pane is open, and a cached answer would outlive the change. */
  const reducedMotion = () => {
    try {
      return !!(typeof window !== 'undefined' && window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    } catch (e) { return false }
  }

  const keyOf = (node) => KEY.get(node)

  const setText = (node, text) => {
    if (!node) return
    const t = text == null ? '' : String(text)
    if (node.textContent !== t) node.textContent = t
  }

  const setAttr = (node, name, value) => {
    if (!node) return
    if (value == null) { if (node.getAttribute(name) !== null) node.removeAttribute(name); return }
    const v = String(value)
    if (node.getAttribute(name) !== v) node.setAttribute(name, v)
  }

  const toggle = (node, cls, on) => { if (node) node.classList.toggle(cls, !!on) }

  /** Optional elements are built unconditionally and hidden here, rather than
   *  added and removed -- which would reintroduce exactly the churn this module
   *  exists to remove, and would make sibling order position-dependent.
   *
   *  `.gone` and not the `hidden` attribute: these chips carry an explicit
   *  `display` from their own rules, which overrides `hidden`'s UA
   *  `display:none`. A hidden chip that is still visible is a silent bug. */
  const show = (node, on) => toggle(node, 'gone', !on)

  // A node mid-exit is still a child but is not part of the live list: it is
  // never reused, and placement steps over it. Anything the reconciler did not
  // create is foreign -- left exactly where it is, so a container may hold a
  // static header without it being swept away.
  const isLeaving = (n) => n.dataset && n.dataset.leaving === '1'
  const isOurs = (n) => KEY.has(n)

  /** Reconcile `parent`'s children against `data`, by key.
   *
   *  Returns { nodes: Map<key, Element> in data order, entered: [], exited: [] }.
   *  Order is create -> update -> insert -> enter, so a node is never inserted
   *  unfilled and `enter` always sees it parented and measurable. */
  const reconcile = (parent, data, spec) => {
    const list = data || []
    const { key, create, update, enter, exit } = spec

    // Rebuilt from the live children EVERY pass, never cached between calls:
    // the DOM is the single source of truth, so a subtree cleared by anything
    // else rebuilds rather than resurrecting detached nodes from a stale map.
    const prev = new Map()
    for (const n of Array.prototype.slice.call(parent.children)) {
      if (!isOurs(n) || isLeaving(n)) continue
      prev.set(KEY.get(n), n)
    }

    const nodes = new Map()
    const exited = []
    const fresh = []
    const want = []

    for (let i = 0; i < list.length; i++) {
      const d = list[i]
      const k = String(key(d, i))
      if (nodes.has(k)) {
        // A duplicate key is a caller bug, not something to paper over.
        // Reported, never silently dropped -- the rule the CAPS follow.
        console.warn('MCX.reconcile: duplicate key ' + JSON.stringify(k) + ' -- keeping the first')
        continue
      }
      let node = prev.get(k)
      const isNew = !node
      if (isNew) {
        node = create(d, k)
        KEY.set(node, k)
        node.dataset.rkey = k.replace(RKEY_UNSAFE, '·')
      }
      if (update) update(node, d, i, isNew)
      nodes.set(k, node)
      want.push(node)
      if (isNew) fresh.push([node, d])
    }

    // Exits first, so a synchronous removal is out of the way before placement
    // counts anything. An async exit leaves the node in place, marked.
    //
    // A departing node KEEPS its key: `exited` is handed back to the caller and
    // an exit animation needs `keyOf()` on it. A detached node can never be
    // adopted anyway -- `prev` is built from the parent's live children.
    for (const [k, node] of prev) {
      if (nodes.has(k)) continue
      exited.push(node)
      let held = null
      if (exit) {
        try { held = exit(node, k) } catch (e) { held = null }
      }
      // `.then` is read AND called inside the try: a malformed thenable can
      // throw from either, and a hook must never be able to break the render.
      // The node is marked only once subscribing has actually succeeded, so a
      // throw leaves a leaving-marked node that nothing will ever remove.
      //
      // `.then(done, done)` and not `.finally(done)`: finally re-throws, which
      // would log an unhandled rejection every time an exit animation failed.
      let holding = false
      if (held && !reducedMotion()) {
        try {
          if (typeof held.then === 'function') {
            const done = () => node.remove()
            held.then(done, done)
            holding = true
          }
        } catch (e) { holding = false }
      }
      if (holding) node.dataset.leaving = '1'
      else node.remove()
    }

    // Placement. A node is moved only when it is not already where it belongs;
    // an untouched node keeps its :hover, its focus, its pointer capture and
    // its scroll position, which is the entire point of the module.
    let at = 0
    for (const node of want) {
      let cur = parent.children[at]
      while (cur && cur !== node && (isLeaving(cur) || !isOurs(cur))) cur = parent.children[++at]
      if (cur === node) { at++; continue }
      parent.insertBefore(node, cur || null)
      at++
    }

    if (enter) for (const [node, d] of fresh) enter(node, d)

    return { nodes, entered: fresh.map((f) => f[0]), exited }
  }

  return { reconcile, setText, setAttr, toggle, show, keyOf, reducedMotion }
})()
