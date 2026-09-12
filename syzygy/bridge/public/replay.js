/* Syzygy — the replay view. Its global is MCR.
   Attached by app.js, which owns the shared state and the animation loop.

   Replay has no tab of its own: it is the right-hand column of the Telemetry
   tab, which is why the view name checked below is 'telemetry' and not
   'replay'. */
'use strict'

/* Canvas takes no CSS custom properties, so the timeline needs real colour
   values. app.js resolves the live theme out of the stylesheet and publishes
   it on window.MCT; this reads from there so the timeline follows a theme
   change like everything else. The table below is the teal fallback for the
   frames before app.js has booted. */
const CP = {
  accent: '#6fc3df', accentHot: '#a9e8ff', accentDeep: '#2f7f9b',
  amber: '#e0973c', redHot: '#ff5670', purple: '#a883e6', green: '#45c9a0',
  grey: '#41525c',
}
const col = (name) => window.MCT?.[name] || CP[name]

const MCR = (() => {
  let C = null                 // { S, steer, toast, el, compact, money, clockOf }
  let view = 'control'

  const fit = (canvas) => {
    const d = Math.min(2, window.devicePixelRatio || 1)
    const b = canvas.getBoundingClientRect()
    const w = Math.max(1, Math.round(b.width * d)), h = Math.max(1, Math.round(b.height * d))
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    return { x: canvas.getContext('2d'), w, h, d }
  }
  // ===================================================================== REPLAY
  const replay = {
    all: [], idx: 0, playing: false, lastStep: 0,
    async load() {
      try {
        const r = await fetch('/api/replay')
        const d = await r.json()
        this.all = d.events ?? []
        this.idx = this.all.length
        this.sync()
      } catch {}
    },
    sync() {
      const sc = document.getElementById('scrubber')
      sc.max = String(Math.max(0, this.all.length))
      sc.value = String(this.idx)
      document.getElementById('scrubpos').textContent = `${this.idx} / ${this.all.length}`
      const at = this.all[Math.max(0, this.idx - 1)]
      document.getElementById('scrubclock').textContent = at ? C.clockOf(at.t) : '—'
      document.getElementById('c-replay').textContent = String(this.all.length)
      const box = document.getElementById('replayfeed')
      box.textContent = ''
      const slice = this.all.slice(Math.max(0, this.idx - 60), this.idx).reverse()
      if (!slice.length) { box.appendChild(C.el('div', 'empty', 'Nothing recorded yet.')); return }
      for (const e of slice) {
        const row = C.el('div', 'ev ' + (e.status === 'deny' ? 'deny' : e.status === 'error' ? 'err' : e.kind === 'turn' ? 'turn' : 'ok'))
        row.style.animation = 'none'
        row.appendChild(C.el('div', 'ts num', C.clockOf(e.t)))
        const b = C.el('div', 'body')
        b.appendChild(C.el('div', 'title', e.label || e.kind))
        if (e.detail) b.appendChild(C.el('div', 'detail', e.detail))
        row.appendChild(b)
        box.appendChild(row)
      }
    },
    drawTimeline() {
      const cv = document.getElementById('timeline')
      const { x, w, h, d } = fit(cv)
      x.clearRect(0, 0, w, h)
      if (!this.all.length) return
      const t0 = this.all[0].t, t1 = this.all[this.all.length - 1].t || t0 + 1
      const span = Math.max(1, t1 - t0)
      const COLOR = { tool: col('accentDeep'), turn: col('accent'), agent: col('purple'), note: col('green') }
      /* One bar per pixel column, not one per event. A thousand events across
         900px used to be a thousand 1.6px bars at 55% alpha, which composite
         into a solid slab that carries no information at all -- and buries the
         denials and errors that are the only reason to look at this strip.
         Each column keeps its WORST event, ranked error > deny > ordinary, so
         a single failure inside a busy second still shows. */
      const rank = (e) => (e.status === 'error' ? 3 : e.status === 'deny' ? 2 : 1)
      const cols = new Array(Math.ceil(w) + 1).fill(null)
      let busiest = 1
      for (const e of this.all) {
        const ex = Math.round(((e.t - t0) / span) * (w - 4) + 2)
        const cur = cols[ex]
        if (!cur) cols[ex] = { e, n: 1 }
        else {
          cur.n += 1
          if (rank(e) > rank(cur.e)) cur.e = e
          if (cur.n > busiest) busiest = cur.n
        }
      }
      for (let ex = 0; ex < cols.length; ex++) {
        const c = cols[ex]
        if (!c) continue
        const loud = rank(c.e) > 1
        // Ordinary columns are as tall as they are busy; anything that failed
        // is full height whatever its density, because it is the exception.
        const eh = loud ? h * 0.92 : h * (0.18 + 0.5 * (c.n / busiest))
        x.fillStyle = c.e.status === 'deny' ? col('amber')
          : c.e.status === 'error' ? col('redHot')
          : (COLOR[c.e.kind] ?? col('grey'))
        x.globalAlpha = loud ? 0.95 : 0.5
        x.fillRect(ex, h - eh, Math.max(1, d), eh)
      }
      x.globalAlpha = 1
      const at = this.all[Math.max(0, this.idx - 1)]
      if (at) {
        const px = ((at.t - t0) / span) * (w - 4) + 2
        x.strokeStyle = col('accentHot'); x.lineWidth = 2 * d
        x.shadowColor = col('accentHot'); x.shadowBlur = 10 * d
        x.beginPath(); x.moveTo(px, 0); x.lineTo(px, h); x.stroke(); x.shadowBlur = 0
      }
    },
    step(t) {
      if (!this.playing) return
      if (t - this.lastStep < 90) return
      this.lastStep = t
      if (this.idx >= this.all.length) { this.playing = false; document.getElementById('playbtn').textContent = '▶ play'; return }
      this.idx += 1
      this.sync()
    },
  }

  return {
    attach(ctx) {
      C = ctx
      const sc = document.getElementById('scrubber')
      sc.addEventListener('input', () => { replay.idx = Number(sc.value); replay.playing = false; document.getElementById('playbtn').textContent = '▶ play'; replay.sync() })
      document.getElementById('playbtn').addEventListener('click', () => {
        if (replay.idx >= replay.all.length) replay.idx = 0
        replay.playing = !replay.playing
        document.getElementById('playbtn').textContent = replay.playing ? '❙❙ pause' : '▶ play'
      })
    },
    setView(v) { view = v; if (v === 'telemetry') replay.load() },
    frame(t) {
      if (view !== 'telemetry') return
      replay.step(t)
      replay.drawTimeline()
    },
  }
})()
