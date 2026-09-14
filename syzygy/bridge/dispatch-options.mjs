// The model and effort lists the Dispatch tab offers, read from the resolved
// `claude` binary's own `--help` rather than guessed.
//
// Why probe at all: on 2.1.269 the effort levels are (low, medium, high,
// xhigh, max) -- FIVE, where this feature's brief guessed four. A hardcoded
// list is a list that silently goes stale against the binary it is describing.
//
// Why the two lists are NOT sourced the same way: `--help` ENUMERATES effort
// and only ILLUSTRATES models ("Provide an alias ... (e.g. 'fable', 'opus',
// or 'sonnet') or a model's full name"). So efforts are parsed as truth and
// models are parsed as hints, unioned with a baked list. `source` says which
// happened, and the pane shows it -- publishing a guess dressed as a probe is
// worse than publishing a guess.

/** Known good at the time of writing. The union floor for models, and the
 *  whole answer when the probe fails. */
export const FALLBACK_MODELS = ['opus', 'sonnet', 'haiku', 'fable']
export const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** The description of one long option, with its wrapped continuation lines
 *  joined. `--help` wraps at ~40 columns, so the parenthesised enumeration
 *  after `--effort` is on the NEXT line, not beside the flag. A parser that
 *  reads single lines finds nothing and reports a confident empty list. */
const describe = (help, flag) => {
  const lines = String(help ?? '').split('\n')
  // Word-boundary on the flag: `--model` must not match `--fallback-model`.
  const re = new RegExp('^\\s{0,4}(?:-\\w,\\s*)?' + flag + '(?![\\w-])')
  const start = lines.findIndex((l) => re.test(l))
  if (start < 0) return ''
  const out = [lines[start].replace(re, '')]
  for (let i = start + 1; i < lines.length; i++) {
    // A new option starts at low indent with a dash; a continuation is
    // indented past it. Anything else ends the block.
    if (/^\s{0,4}-/.test(lines[i])) break
    if (!/^\s+\S/.test(lines[i])) break
    out.push(lines[i])
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

/** Pure. Never throws: every failure is an empty result the caller replaces
 *  with the baked list, because a half-typed or unfamiliar help text is the
 *  normal case on a machine with two `claude` installs. */
export const parseClaudeOptions = (help) => {
  let efforts = [], models = []
  try {
    const effortDesc = describe(help, '--effort')
    const m = effortDesc.match(/\(([^)]*)\)/)
    if (m) {
      efforts = m[1].split(',').map((x) => x.trim()).filter((x) => /^[a-z][a-z0-9]*$/.test(x))
    }
    const modelDesc = describe(help, '--model')
    // Quoted tokens only, and only the alias form. A dashed token is the
    // "full name" example the help gives; it is a real model id today and a
    // dead one in three months, and this list is a picker, not a record.
    for (const q of modelDesc.match(/'([^']+)'/g) ?? []) {
      const v = q.slice(1, -1).trim()
      if (/^[a-z][a-z0-9]*$/.test(v) && !models.includes(v)) models.push(v)
    }
  } catch { efforts = []; models = [] }

  // Presence only, not a value: the flag's own help on 2.1.270 says it "only
  // works with --print", so knowing it EXISTS is all a probe of --help can
  // learn. Whether a --bg session actually honours it is a separate, live
  // question and is not settled here.
  const maxBudget = /(^|\n)\s{0,4}--max-budget-usd(?![\w-])/.test(String(help ?? ''))

  const source = efforts.length || models.length ? 'help' : 'fallback'
  if (source === 'fallback') return { models: [...FALLBACK_MODELS], efforts: [...FALLBACK_EFFORTS], source, maxBudget }
  return {
    models: [...models, ...FALLBACK_MODELS.filter((m) => !models.includes(m))],
    efforts: efforts.length ? efforts : [...FALLBACK_EFFORTS],
    source,
    maxBudget,
  }
}

/** One `--help` at relay boot, the way pickClaudeBin probes capability once.
 *  A binary that cannot be run is not an error here -- it is the fallback
 *  list, and `source` reports it. `agents`/`agentSource` ride on every
 *  return path -- including the no-bin and throw paths, where the roster
 *  probe never ran and is reported the same way it reports itself:
 *  `[]`/`'unavailable'`, never a missing key. */
export const probeDispatchOptions = async (bin, run) => {
  if (!bin) return { ...parseClaudeOptions(''), agents: [], agentSource: 'unavailable' }
  try {
    const out = await run(bin, ['--help'], {})
    const opts = parseClaudeOptions(out?.code === 0 ? out.stdout : '')
    const roster = await probeAgentRoster(bin, run)
    return { ...opts, ...roster }
  } catch { return { ...parseClaudeOptions(''), agents: [], agentSource: 'unavailable' } }
}

// ---- the agent roster -------------------------------------------------------
//
// `claude --agent <name>` refuses a name that names no real agent, and its
// refusal lists every agent the binary actually knows about -- personas
// included, once the personas plugin is installed. That refusal is cheaper
// and truer than any static list: it costs no turn (nothing after `--agent`
// runs) and it can never go stale, because it is read off the same binary
// every spawn uses.

/** A name no template, skill or plugin will ever legitimately register --
 *  chosen so the refusal this deliberately provokes is unambiguous. */
export const ROSTER_SENTINEL = '__szg_roster_probe__'

/** Pure. Never throws: an unfamiliar refusal format is an empty roster, not
 *  a crash on relay boot. */
export const parseAgentRoster = (text) => {
  try {
    const m = String(text ?? '').match(/Available agents:\s*([^\n]*)/)
    if (!m) return []
    return m[1].split(',').map((x) => x.trim())
      .filter((x) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(x))
  } catch { return [] }
}

/** `run(bin, argv, opts)` is expected to hand back `{ code, stdout, stderr }`.
 *  The sentinel is refused (a non-zero exit) on every binary that understands
 *  `--agent` at all, so `code === 0` means the sentinel somehow named a real
 *  agent -- a coincidence to distrust, not a roster to trust, hence
 *  `'unavailable'` rather than an empty-but-successful reading. Both stdout
 *  and stderr are parsed together because the refusal has been observed on
 *  the combined stream and which one a given build writes to is not part of
 *  any contract this can rely on. */
export const probeAgentRoster = async (bin, run) => {
  const none = { agents: [], agentSource: 'unavailable' }
  if (!bin) return none
  try {
    const out = await run(bin, ['--agent', ROSTER_SENTINEL, '--print', 'x'], {
      timeout: 8000,
      env: { ...process.env, SZG_HEADLESS: '1' },
      closeStdin: true,
    })
    if (out?.code === 0) return none
    const agents = parseAgentRoster(`${out?.stdout ?? ''}\n${out?.stderr ?? ''}`)
    return agents.length ? { agents, agentSource: 'probe' } : none
  } catch { return none }
}
