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

  const source = efforts.length || models.length ? 'help' : 'fallback'
  if (source === 'fallback') return { models: [...FALLBACK_MODELS], efforts: [...FALLBACK_EFFORTS], source }
  return {
    models: [...models, ...FALLBACK_MODELS.filter((m) => !models.includes(m))],
    efforts: efforts.length ? efforts : [...FALLBACK_EFFORTS],
    source,
  }
}

/** One `--help` at relay boot, the way pickClaudeBin probes capability once.
 *  A binary that cannot be run is not an error here -- it is the fallback
 *  list, and `source` reports it. */
export const probeDispatchOptions = async (bin, run) => {
  if (!bin) return parseClaudeOptions('')
  try {
    const out = await run(bin, ['--help'], {})
    return parseClaudeOptions(out?.code === 0 ? out.stdout : '')
  } catch { return parseClaudeOptions('') }
}
