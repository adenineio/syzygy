// The snapshot frame's byte budget.
//
// Every pane is sent the whole snapshot when it connects, and a pane that
// cannot drain what it is sent is dropped. So the relay measures a frame
// before writing it, and when the frame is over its budget sheds whole
// optional sections, in one fixed order, until it fits or nothing optional is
// left. The frame a pane receives carries `shed`, saying what it is missing.
//
// Nothing a card needs is ever removed: a session keeps every field but the
// older end of its series, a project every field but the tail of its capped
// efforts, and every top-level key survives. A frame that cannot be brought
// under budget is sent fully shed rather than refused.
//
// Pure: no I/O, no clock, and nothing handed in is written to. A trim rebuilds
// the objects on its path and shares everything else with the input.

export const SNAPSHOT_BUDGET_BYTES = 512 * 1024

/** First to go first. Findings and proposals are each one GET away in full;
 *  a series and the event feed lose only their older end; a project's claimed
 *  efforts are cut last, since a session reads its own work off them, and the
 *  document route carries every one. */
export const SHED_ORDER = ['findings', 'proposals', 'series', 'events', 'efforts']

/** The newest points each session's series keeps once `series` is shed. */
export const SERIES_SHED_CAP = 60

/** The efforts each project keeps once `efforts` is shed; the project's
 *  `moreEfforts` grows by however many it lost. */
export const EFFORTS_SHED_CAP = 4

const byteLength = (json) => (typeof json === 'string' ? Buffer.byteLength(json) : 0)
const listOf = (x) => (Array.isArray(x) ? x : null)

/** Top-level key -> the UTF-8 byte length of that key's own serialisation. A
 *  value that does not serialise (undefined, a function) measures zero. */
export const sectionBytes = (frame, serialize = JSON.stringify) => {
  const out = {}
  for (const key of Object.keys(frame ?? {})) out[key] = byteLength(serialize(frame[key]))
  return out
}

// One trim per section but `events`, which halves in the walk itself. Each
// answers null when there is nothing to drop -- the section is absent, empty or
// already within its cap -- so the walk records no row for it and goes on.
const TRIMS = {
  findings: (f) => {
    const list = listOf(f.findings)
    if (!list?.length) return null
    return { frame: { ...f, findings: [] }, kept: 0, dropped: list.length }
  },
  proposals: (f) => {
    const list = listOf(f.skillsQueue?.proposals)
    if (!list?.length) return null
    return { frame: { ...f, skillsQueue: { ...f.skillsQueue, proposals: [] } }, kept: 0, dropped: list.length }
  },
  series: (f) => {
    const sessions = listOf(f.sessions)
    if (!sessions) return null
    let kept = 0, dropped = 0
    const next = sessions.map((s) => {
      const series = listOf(s?.series)
      if (!series) return s
      if (series.length <= SERIES_SHED_CAP) { kept += series.length; return s }
      kept += SERIES_SHED_CAP
      dropped += series.length - SERIES_SHED_CAP
      return { ...s, series: series.slice(-SERIES_SHED_CAP) }
    })
    return dropped ? { frame: { ...f, sessions: next }, kept, dropped } : null
  },
  efforts: (f) => {
    const projects = listOf(f.projects)
    if (!projects) return null
    let kept = 0, dropped = 0
    const next = projects.map((p) => {
      const efforts = listOf(p?.efforts)
      if (!efforts) return p
      if (efforts.length <= EFFORTS_SHED_CAP) { kept += efforts.length; return p }
      const lost = efforts.length - EFFORTS_SHED_CAP
      kept += EFFORTS_SHED_CAP
      dropped += lost
      const more = Number.isFinite(p.moreEfforts) ? p.moreEfforts : 0
      return { ...p, efforts: efforts.slice(0, EFFORTS_SHED_CAP), moreEfforts: more + lost }
    })
    return dropped ? { frame: { ...f, projects: next }, kept, dropped } : null
  },
}

/** Serialise; while over `budget`, shed whole optional sections in
 *  SHED_ORDER, re-measuring after each. `events` is the one repeating step: it
 *  halves, keeping the newest, until the frame fits or the list is empty, and
 *  reports the whole run as one row. Every measurement is of the frame with
 *  its `shed` rows already on it, so the size reported is the size sent.
 *
 *  Returns `{ frame, json, bytes, shed, sections }`: the frame actually sent
 *  (its `shed` included, in the place the input's own `shed` key held, else
 *  last), its json, that json's UTF-8 length, the rows `{ section, kept,
 *  dropped }`, and `sectionBytes` of the frame sent. */
export const shedToBudget = (frame, { budget = SNAPSHOT_BUDGET_BYTES, serialize = JSON.stringify } = {}) => {
  const shed = []
  let current = frame && typeof frame === 'object' ? frame : {}
  const measure = () => {
    const sent = { ...current, shed: [...shed] }
    const json = serialize(sent)
    return { sent, json, bytes: byteLength(json) }
  }

  let m = measure()
  for (const section of SHED_ORDER) {
    if (m.bytes <= budget) break
    if (section === 'events') {
      const events = listOf(current.events)
      if (!events?.length) continue
      const at = shed.length
      let keep = events.length
      while (m.bytes > budget && keep > 0) {
        keep = Math.floor(keep / 2)
        current = { ...current, events: events.slice(events.length - keep) }
        shed[at] = { section, kept: keep, dropped: events.length - keep }
        m = measure()
      }
      continue
    }
    const cut = TRIMS[section](current)
    if (!cut) continue
    current = cut.frame
    shed.push({ section, kept: cut.kept, dropped: cut.dropped })
    m = measure()
  }

  return { frame: m.sent, json: m.json, bytes: m.bytes, shed: m.sent.shed, sections: sectionBytes(m.sent, serialize) }
}
