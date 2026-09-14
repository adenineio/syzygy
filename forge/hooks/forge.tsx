// Forge — runtime skill acquisition, and deterministic offload.
//
// One idea, two halves: stop the model from re-deriving what it has already
// worked out.
//
//   create_tool   mints a sequence of tool calls the model has repeated into
//                 ONE named tool, stored per project and re-registered at every
//                 session.start — so a routine worked out on Monday is a single
//                 call on Friday, in a session that never saw Monday.
//   list_tools    what this project has forged.
//   forget_tool   unmint one.
//
//   json_query    exact code where the model would otherwise walk a path,
//   regex_test    match a pattern, or compare two texts in its head. Pure,
//   text_diff     dependency-free, and wrong-answer-proof.
//
// Nothing here executes arbitrary code. A forged tool is an ordered list of
// calls to tools that already existed when it was forged: every step's name is
// checked against `$.tool.list()` at creation time, and the steps run through
// `$.tool.call`, so the engine's own permission path still sees each one.
// `{{param}}` values are substituted into strings by replacement — no eval, no
// Function, no template evaluation.
//
// Two constraints out of claude-code.d.ts shaped this:
//
//   · `$.tool.call` "runs through the other plugins' hooks (this plugin's own
//     skipped)". A forged step naming `mcp__forge__*` would therefore reach no
//     hook and fail, so such a step is refused at creation with that reason.
//   · `$.tool.call`'s argument is a union discriminated by a literal `tool`
//     (ToolCallArgs over BuiltinToolInputs × McpToolInputs). A step's tool name
//     is only known at run time, so the argument is built as plain data and
//     cast once, at the call site.
//
// Storage is `$.store`, keyed by the project — `$.session.repo()` when the
// session is in a repository, else `$.session.cwd()` — because a forged tool
// belongs to the codebase, not to the session that happened to mint it.

import type { EngineInterface, Register, ToolSpec } from 'claude-code'

type Dollar = EngineInterface

/** `$.tool.call`'s argument as its last overload declares it. A step's tool is
 *  a run-time string, so the built argument is cast to this at the call site. */
type ToolCallArg = Parameters<Dollar['tool']['call']>[0]

// ---------------------------------------------------------------- constants

/** Tool names the model may forge: lower snake case, one line of a listing. */
const NAME_RE = /^[a-z][a-z0-9_]{0,40}$/
/** `{{param}}`, the only interpolation. Substitution only — never evaluated. */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/** A forged tool is a shortcut, not a program: past a dozen steps the model
 *  should be writing a script and running it, where it can see what happened. */
const MAX_STEPS = 12
/** Per project. A listing longer than this stops being a menu. */
const MAX_TOOLS = 60
/** How deep interpolation walks a step's arguments. */
const MAX_DEPTH = 8

const ARGS_PREVIEW = 120
const STEP_PREVIEW = 160
const OUTPUT_MAX = 8000

/** The only real defence against catastrophic backtracking available in a pure
 *  matcher: bound what the engine can be asked to chew on. */
const REGEX_TEXT_MAX = 200_000
const REGEX_PATTERN_MAX = 1000
const REGEX_MATCH_CAP = 100

const JSON_TEXT_MAX = 1_000_000

const DIFF_TEXT_MAX = 400_000
/** The LCS table is O(n·m); common head and tail are trimmed before it runs,
 *  so this caps the differing middle, not the files. */
const DIFF_LINE_MAX = 2000
const DIFF_CONTEXT = 3

/** Forge's own tools. A forged tool may not take one of these names, and may
 *  not call one as a step (see the header note on `$.tool.call`). */
const RESERVED = ['create_tool', 'list_tools', 'forget_tool', 'json_query', 'regex_test', 'text_diff']

// -------------------------------------------------------------------- state

type Step = { tool: string; args: Record<string, unknown> }

type Forged = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  steps: Step[]
  createdAt: number
  runs: number
}

/** Module scope, because `$` may never be bound: helpers take `($: Dollar, …)`
 *  and read what they need from here. `project` is cached because
 *  `$.session.repo()` reads the working copy on every call. */
const M: { project: string } = { project: '' }

// ------------------------------------------------------------------- basics

const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

const preview = (v: unknown, n: number): string => {
  let s: string
  try {
    s = JSON.stringify(v) ?? String(v)
  } catch {
    s = String(v)
  }
  return clip(s, n)
}

// ------------------------------------------------------------- project scope

/** Where a forged tool lives: the repository if there is one, else the working
 *  directory. A tool follows the codebase, not the session. */
const projectOf = async ($: Dollar): Promise<string> => {
  if (M.project) return M.project
  const repo = await $.session.repo().catch(() => null)
  const root = repo?.root ?? (await $.session.cwd().catch(() => ''))
  M.project = root || 'unknown-project'
  return M.project
}

const storeKey = (project: string): string => `forge:tools:${project}`

const loadForged = async ($: Dollar): Promise<Record<string, Forged>> => {
  const key = storeKey(await projectOf($))
  const raw = await $.store.get(key).catch(() => undefined)
  if (!isRecord(raw)) return {}
  const out: Record<string, Forged> = {}
  for (const [name, def] of Object.entries(raw)) {
    if (!isRecord(def) || !Array.isArray(def.steps)) continue
    out[name] = {
      name,
      description: String(def.description ?? ''),
      inputSchema: isRecord(def.inputSchema) ? def.inputSchema : { type: 'object' },
      steps: (def.steps as unknown[]).filter(isRecord).map((s) => ({
        tool: String(s.tool ?? ''),
        args: isRecord(s.args) ? s.args : {},
      })),
      createdAt: Number(def.createdAt ?? 0),
      runs: Number(def.runs ?? 0),
    }
  }
  return out
}

const saveForged = async ($: Dollar, tools: Record<string, Forged>): Promise<void> => {
  await $.store.set(storeKey(await projectOf($)), tools).catch(() => undefined)
}

// ------------------------------------------------------------- registration

/** What the model reads in the tool listing for a forged tool: its own words,
 *  then the sequence, so the model can tell at a glance what it will run. */
const specOf = (def: Forged): ToolSpec => ({
  name: def.name,
  description:
    `${def.description}\n\n` +
    `Forged tool: runs ${def.steps.length} step${def.steps.length === 1 ? '' : 's'} in order ` +
    `(${def.steps.map((s) => s.tool).join(' → ')}), substituting {{params}} from this call's input. ` +
    `It stops at the first failing step and tells you which one failed. ` +
    `Use forge's list_tools to see its steps, forget_tool to remove it.`,
  inputSchema: def.inputSchema,
})

/** Re-registers every tool this project has forged. Called from session.start,
 *  which the engine awaits before the first prompt — that is what makes a
 *  forged tool survive a restart without the model asking for it back. */
const registerForged = async ($: Dollar): Promise<number> => {
  const tools = await loadForged($)
  let n = 0
  for (const def of Object.values(tools)) {
    const ok = await $.tool.register(specOf(def)).then(() => true).catch(() => false)
    if (ok) n += 1
  }
  return n
}

const BUILTINS: ToolSpec[] = [
  {
    name: 'create_tool',
    description:
      'Mint a sequence of tool calls you keep repeating into ONE named, deterministic tool for this ' +
      'project — available immediately, and in every future session on this codebase.\n\n' +
      'FORGE when: you have run the same ordered sequence of tool calls three or more times, the shape ' +
      'of the sequence is stable, and the only thing that changes between runs is a value or two you ' +
      'can name as parameters. That is the moment a routine has proved itself.\n\n' +
      'DO NOT FORGE when: you have run the sequence once or twice; a single existing tool already does ' +
      'it; the steps change depending on what the previous step returned (a forged tool runs blind — it ' +
      'cannot branch, loop, or read a result and decide); or the sequence is really "write a script and ' +
      'run it", which Bash already does better.\n\n' +
      'Each step is { tool, args }. Every `tool` must be a tool that exists right now (checked against ' +
      'the live tool list) and may not be one of forge\'s own. String values inside `args` may contain ' +
      '{{placeholders}} naming properties of this tool\'s inputSchema; they are substituted verbatim, ' +
      'never evaluated. Declare every placeholder in inputSchema.properties or creation is refused. ' +
      'Returns the full mcp__forge__<name> you can call on your very next turn.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Lower snake case, e.g. "run_typecheck". Pattern: [a-z][a-z0-9_]{0,40}.',
        },
        description: {
          type: 'string',
          description:
            'What the tool does and when to reach for it, in the words you would want to read in a ' +
            'tool listing six weeks from now.',
        },
        inputSchema: {
          type: 'object',
          description:
            'JSON schema for the new tool\'s input, e.g. { "type": "object", "properties": ' +
            '{ "path": { "type": "string" } }, "required": ["path"] }. Every {{placeholder}} used in a ' +
            'step must appear in properties.',
        },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_STEPS,
          description: `The calls to run, in order. At most ${MAX_STEPS}.`,
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'An existing tool name, e.g. "Bash" or "Read".' },
              args: {
                type: 'object',
                description: 'That tool\'s arguments. String values may contain {{placeholders}}.',
              },
            },
            required: ['tool'],
          },
        },
      },
      required: ['name', 'description', 'steps'],
    },
  },
  {
    name: 'list_tools',
    description:
      'List the tools forged for this project: name, description, step count, how often each has run, ' +
      'and the sequence each one performs. Call it when you suspect a routine has already been minted, ' +
      'before forging a near-duplicate.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'forget_tool',
    description:
      'Remove one forged tool from this project, permanently. Use it when a routine has gone stale — ' +
      'the command it wraps was renamed, or the sequence turned out to be wrong.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The forged tool\'s short name.' } },
      required: ['name'],
    },
  },
  {
    name: 'json_query',
    description:
      'Read one value out of a JSON document by path, exactly. Give it the JSON text and a dotted / ' +
      'bracket path such as `data.items[0].name`, `users[-1].email` (negative indexes count from the ' +
      'end) or `["odd key"].value`. Use it instead of eyeballing a large blob or re-deriving a value ' +
      'you already fetched: on a miss it names the segment that failed and lists the keys that were ' +
      'actually there. Path walking only — nothing is evaluated.',
    inputSchema: {
      type: 'object',
      properties: {
        json: { type: 'string', description: 'The JSON document, as text.' },
        path: {
          type: 'string',
          description: 'Dotted/bracket path. Empty, or "$", returns the whole document.',
        },
      },
      required: ['json', 'path'],
    },
  },
  {
    name: 'regex_test',
    description:
      'Run a regular expression against text and get every match back with its capture groups, named ' +
      'groups and character indices. Use it to prove a pattern works before you rely on it, or to pull ' +
      'structured fields out of command output — not as a substitute for Grep, which searches files. ' +
      `Text is capped at ${REGEX_TEXT_MAX} characters; an invalid pattern comes back as an error ` +
      'string, never an exception.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The regular expression source, without slashes.' },
        flags: { type: 'string', description: 'Any of d g i m s u v y. Without "g", only the first match is reported.' },
        text: { type: 'string', description: 'The text to match against.' },
      },
      required: ['pattern', 'text'],
    },
  },
  {
    name: 'text_diff',
    description:
      'Line-level unified diff between two texts, with a hunk header and three lines of context, plus ' +
      'an insertion/deletion count. Use it when you need to know exactly what changed between two ' +
      'versions of a file or two runs of a command, instead of comparing them by eye.',
    inputSchema: {
      type: 'object',
      properties: {
        before: { type: 'string', description: 'The original text.' },
        after: { type: 'string', description: 'The new text.' },
      },
      required: ['before', 'after'],
    },
  },
]

const registerBuiltins = async ($: Dollar): Promise<void> => {
  for (const spec of BUILTINS) await $.tool.register(spec).catch(() => null)
}

// ---------------------------------------------------------- interpolation
//
// Substitution into strings, and nothing else. A value that is exactly one
// placeholder becomes the parameter itself, so a number stays a number and an
// object stays an object; a placeholder inside a longer string is replaced with
// that value's text. Non-strings are walked, not touched.

const textOf = (v: unknown): string =>
  v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) ?? '' : String(v)

const interpolate = (value: unknown, params: Record<string, unknown>, depth = 0): unknown => {
  if (depth > MAX_DEPTH) return value
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(value)
    if (whole) return Object.prototype.hasOwnProperty.call(params, whole[1]!) ? params[whole[1]!] : ''
    return value.replace(PLACEHOLDER_RE, (_m, name: string) =>
      Object.prototype.hasOwnProperty.call(params, name) ? textOf(params[name]) : '',
    )
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, params, depth + 1))
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, params, depth + 1)
    return out
  }
  return value
}

/** Every `{{name}}` a step list mentions, in first-seen order. */
const placeholdersOf = (steps: readonly Step[]): string[] => {
  const found: string[] = []
  const walk = (v: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return
    if (typeof v === 'string') {
      for (const m of v.matchAll(PLACEHOLDER_RE)) if (!found.includes(m[1]!)) found.push(m[1]!)
      return
    }
    if (Array.isArray(v)) { for (const item of v) walk(item, depth + 1); return }
    if (isRecord(v)) for (const item of Object.values(v)) walk(item, depth + 1)
  }
  for (const s of steps) walk(s.args, 0)
  return found
}

// -------------------------------------------------------------- create_tool

const createTool = async ($: Dollar, args: Record<string, unknown>): Promise<string> => {
  const name = String(args.name ?? '').trim()
  if (!NAME_RE.test(name)) {
    return (
      `create_tool: ${JSON.stringify(name)} is not a usable name. Use lower snake case matching ` +
      `[a-z][a-z0-9_]{0,40} — a letter first, then letters, digits and underscores, 41 characters at most.`
    )
  }
  if (RESERVED.includes(name)) {
    return `create_tool: "${name}" is one of forge's own tools. Pick another name.`
  }

  const description = String(args.description ?? '').trim()
  if (description.length < 12) {
    return 'create_tool: description must say what the tool does and when to use it (12 characters at least).'
  }

  const rawSteps = Array.isArray(args.steps) ? (args.steps as unknown[]) : null
  if (!rawSteps || rawSteps.length === 0) {
    return 'create_tool: steps must be a non-empty array of { tool, args } objects, in the order they run.'
  }
  if (rawSteps.length > MAX_STEPS) {
    return (
      `create_tool: ${rawSteps.length} steps, and the cap is ${MAX_STEPS}. A sequence this long wants a ` +
      `script you can run with Bash and watch, not a blind forged tool.`
    )
  }

  const schema = isRecord(args.inputSchema) ? args.inputSchema : { type: 'object' as const }
  const props = isRecord(schema.properties) ? schema.properties : {}

  // A step may only name a tool that exists right now. An empty listing means
  // the read failed, not that nothing exists — refuse rather than accept blind.
  const listed = await $.tool.list().catch(() => [])
  if (listed.length === 0) {
    return 'create_tool: the tool list came back empty, so no step could be checked. Try again.'
  }
  const known = new Set(listed.map((t) => t.name))

  const steps: Step[] = []
  for (let i = 0; i < rawSteps.length; i++) {
    const raw = rawSteps[i]
    if (!isRecord(raw)) return `create_tool: step ${i + 1} is not an object with { tool, args }.`
    const tool = String(raw.tool ?? '').trim()
    if (!tool) return `create_tool: step ${i + 1} names no tool.`
    if (/^mcp__forge__/.test(tool) || RESERVED.includes(tool)) {
      return (
        `create_tool: step ${i + 1} names "${tool}", one of forge's own tools. A plugin's $.tool.call ` +
        `skips that plugin's own hooks, so the call would reach nothing and hang the step. Inline what ` +
        `that tool would have done instead.`
      )
    }
    if (!known.has(tool)) {
      const near = [...known].filter((k) => k.toLowerCase().includes(tool.toLowerCase().slice(0, 6))).slice(0, 5)
      return (
        `create_tool: step ${i + 1} names "${tool}", which is not a tool in this session. ` +
        (near.length ? `Did you mean: ${near.join(', ')}? ` : '') +
        `Nothing was created.`
      )
    }
    if (raw.args !== undefined && !isRecord(raw.args)) {
      return `create_tool: step ${i + 1}'s args must be an object of that tool's arguments.`
    }
    steps.push({ tool, args: isRecord(raw.args) ? raw.args : {} })
  }

  // A placeholder no parameter can ever fill is a bug the model should see now,
  // not the first time the tool runs.
  const used = placeholdersOf(steps)
  const undeclared = used.filter((p) => !Object.prototype.hasOwnProperty.call(props, p))
  if (undeclared.length) {
    return (
      `create_tool: the steps use {{${undeclared.join('}}, {{')}}} but inputSchema.properties declares ` +
      `${Object.keys(props).length ? Object.keys(props).join(', ') : 'nothing'}. Declare every ` +
      `placeholder as a property (and list the ones that must be supplied in "required"). Nothing was created.`
    )
  }

  const tools = await loadForged($)
  const prior = tools[name]
  if (!prior && Object.keys(tools).length >= MAX_TOOLS) {
    return `create_tool: this project already has ${MAX_TOOLS} forged tools. Use forget_tool on one that has gone stale.`
  }

  const def: Forged = {
    name,
    description,
    inputSchema: schema,
    steps,
    createdAt: $.clock.now(),
    runs: prior?.runs ?? 0,
  }
  tools[name] = def
  await saveForged($, tools)

  const registered = await $.tool.register(specOf(def)).catch((err: unknown) => ({ tool: `!${msgOf(err)}` }))
  const full = String(registered.tool)
  if (full.startsWith('!')) {
    delete tools[name]
    await saveForged($, tools)
    return `create_tool: the engine refused to register "${name}" — ${full.slice(1)}. Nothing was created.`
  }

  return [
    `Forged ${full}${prior ? ` (replacing its previous ${prior.steps.length}-step definition)` : ''}.`,
    ``,
    `  ${def.steps.map((s, i) => `${i + 1} ${s.tool} ${preview(s.args, ARGS_PREVIEW)}`).join('\n  ')}`,
    ``,
    used.length ? `Parameters: ${used.join(', ')}.` : `No parameters.`,
    `Callable now, and re-registered automatically in every future session on ${await projectOf($)}.`,
  ].join('\n')
}

// --------------------------------------------------------------- list/forget

const listTools = async ($: Dollar): Promise<string> => {
  const project = await projectOf($)
  const tools = Object.values(await loadForged($)).sort((a, b) => a.name.localeCompare(b.name))
  if (!tools.length) {
    return (
      `No tools forged for ${project} yet. When you notice you have run the same ordered sequence of ` +
      `tool calls three or more times, mint it with create_tool.`
    )
  }
  const rows = tools.map((d) => {
    const params = placeholdersOf(d.steps)
    return [
      `mcp__forge__${d.name} — ${d.description}`,
      `    ${d.steps.length} step${d.steps.length === 1 ? '' : 's'}, run ${d.runs}×` +
        (params.length ? `, parameters: ${params.join(', ')}` : '') +
        (d.createdAt ? `, forged ${new Date(d.createdAt).toISOString().slice(0, 10)}` : ''),
      ...d.steps.map((s, i) => `    ${i + 1} ${s.tool} ${preview(s.args, ARGS_PREVIEW)}`),
    ].join('\n')
  })
  return `${tools.length} tool${tools.length === 1 ? '' : 's'} forged for ${project}:\n\n${rows.join('\n\n')}`
}

const forgetTool = async ($: Dollar, args: Record<string, unknown>): Promise<string> => {
  const name = String(args.name ?? '').trim().replace(/^mcp__forge__/, '')
  const tools = await loadForged($)
  if (!tools[name]) {
    const have = Object.keys(tools)
    return `forget_tool: nothing forged here is called "${name}". ${have.length ? `This project has: ${have.join(', ')}.` : 'This project has none.'}`
  }
  const steps = tools[name]!.steps.length
  delete tools[name]
  await saveForged($, tools)
  return (
    `Forgot mcp__forge__${name} (${steps} steps). It is gone from the store, so it will not come back ` +
    `next session; it may stay in this session's tool listing until the next restart — calling it now ` +
    `answers that it no longer exists.`
  )
}

// ----------------------------------------------------------- running a tool

const runForged = async ($: Dollar, def: Forged, input: Record<string, unknown>): Promise<string> => {
  const props = isRecord(def.inputSchema.properties) ? def.inputSchema.properties : {}
  const required = Array.isArray(def.inputSchema.required)
    ? (def.inputSchema.required as unknown[]).map(String)
    : Object.keys(props)

  const missing = placeholdersOf(def.steps).filter(
    (p) => !Object.prototype.hasOwnProperty.call(input, p) && required.includes(p),
  )
  if (missing.length) {
    return `mcp__forge__${def.name}: missing required parameter${missing.length === 1 ? '' : 's'} ${missing.join(', ')}. Nothing ran.`
  }

  const lines: string[] = []
  let lastText = ''
  let lastTool = ''

  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i]!
    const args = interpolate(step.args, input) as Record<string, unknown>
    const shown = `${i + 1} ${step.tool} ${preview(args, ARGS_PREVIEW)}`

    // The engine's own call path: other plugins' hooks, the permission check,
    // then the tool. A rejection here is a normal outcome, not an exception.
    const res = await $.tool
      .call({ ...args, tool: step.tool } as unknown as ToolCallArg)
      .catch((err: unknown) => ({ deny: msgOf(err) }) as { deny: string })

    const denied = typeof res === 'object' && res !== null && 'deny' in res ? String(res.deny ?? '') : ''
    const errored = typeof res === 'object' && res !== null && 'isError' in res && res.isError === true
    const text =
      typeof res === 'object' && res !== null && 'text' in res && typeof res.text === 'string'
        ? res.text
        : preview((res as { result?: unknown }).result, OUTPUT_MAX)

    if (denied || errored) {
      lines.push(`  ${shown} → FAILED`)
      for (let j = i + 1; j < def.steps.length; j++) {
        lines.push(`  ${j + 1} ${def.steps[j]!.tool} — not run`)
      }
      return [
        `mcp__forge__${def.name} FAILED at step ${i + 1} of ${def.steps.length} (${step.tool}).`,
        ``,
        ...lines,
        ``,
        `--- step ${i + 1} (${step.tool}) reported ---`,
        clip(denied || text || 'no detail', OUTPUT_MAX),
      ].join('\n')
    }

    lines.push(`  ${shown} → ok${text ? ` (${text.length} chars)` : ''}`)
    lastText = text
    lastTool = step.tool
  }

  const tools = await loadForged($)
  if (tools[def.name]) {
    tools[def.name]!.runs += 1
    await saveForged($, tools)
  }

  return [
    `mcp__forge__${def.name} — ${def.steps.length} step${def.steps.length === 1 ? '' : 's'}, all ok.`,
    ``,
    ...lines,
    ``,
    `--- output of step ${def.steps.length} (${lastTool}) ---`,
    clip(lastText, OUTPUT_MAX) || '(empty)',
  ].join('\n')
}

// ---------------------------------------------------------------- json_query

/** `a.b[0].c`, `["odd key"].x`, `items[-1]`. A tokenizer, not a parser of
 *  expressions: there is nothing here that could evaluate anything. */
const parsePath = (path: string): (string | number)[] => {
  const s = path.trim().replace(/^\$(?=$|[.[])/, '')
  const out: (string | number)[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === '.') {
      i += 1
      continue
    }
    if (c === '[') {
      const close = s.indexOf(']', i)
      if (close < 0) throw new Error(`unclosed "[" at character ${i + 1}`)
      const raw = s.slice(i + 1, close).trim()
      if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        out.push(raw.slice(1, -1))
      } else if (/^-?\d+$/.test(raw)) {
        out.push(Number(raw))
      } else {
        throw new Error(`"[${raw}]" is neither an index nor a quoted key`)
      }
      i = close + 1
      continue
    }
    const m = /^[^.[\]]+/.exec(s.slice(i))
    if (!m) throw new Error(`cannot read the path at character ${i + 1}`)
    out.push(m[0])
    i += m[0].length
  }
  return out
}

const jsonQuery = (json: string, path: string): string => {
  if (json.length > JSON_TEXT_MAX) {
    return `json_query: the document is ${json.length} characters and the cap is ${JSON_TEXT_MAX}.`
  }
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch (err) {
    return `json_query: the input is not valid JSON — ${msgOf(err)}`
  }

  let segments: (string | number)[]
  try {
    segments = parsePath(path)
  } catch (err) {
    return `json_query: bad path ${JSON.stringify(path)} — ${msgOf(err)}`
  }

  let cur: unknown = doc
  const walked: string[] = []
  for (const seg of segments) {
    const where = walked.length ? walked.join('') : '(root)'
    if (cur === null || cur === undefined) {
      return `json_query: ${where} is ${cur === null ? 'null' : 'undefined'}, so ${JSON.stringify(seg)} has nothing to read.`
    }
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) {
        return `json_query: [${seg}] needs an array at ${where}, but the value there is ${describe(cur)}.`
      }
      const idx = seg < 0 ? cur.length + seg : seg
      if (idx < 0 || idx >= cur.length) {
        return `json_query: [${seg}] is out of range at ${where} — the array has ${cur.length} element${cur.length === 1 ? '' : 's'}.`
      }
      cur = cur[idx]
      walked.push(`[${seg}]`)
      continue
    }
    if (!isRecord(cur)) {
      return `json_query: "${seg}" needs an object at ${where}, but the value there is ${describe(cur)}.`
    }
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
      const keys = Object.keys(cur)
      return (
        `json_query: no "${seg}" at ${where}. ` +
        (keys.length ? `The keys there are: ${keys.slice(0, 40).join(', ')}${keys.length > 40 ? ', …' : ''}.` : 'That object is empty.')
      )
    }
    cur = cur[seg]
    walked.push(walked.length ? `.${seg}` : String(seg))
  }

  if (cur === undefined) return 'json_query: undefined'
  return clip(JSON.stringify(cur, null, 2) ?? String(cur), OUTPUT_MAX)
}

const describe = (v: unknown): string =>
  Array.isArray(v)
    ? `an array of ${v.length}`
    : v === null
      ? 'null'
      : typeof v === 'object'
        ? 'an object'
        : `${typeof v} ${JSON.stringify(v)}`

// ---------------------------------------------------------------- regex_test

const regexTest = (pattern: string, flags: string, text: string): string => {
  if (!pattern) return 'regex_test: pattern is empty.'
  if (pattern.length > REGEX_PATTERN_MAX) {
    return `regex_test: the pattern is ${pattern.length} characters and the cap is ${REGEX_PATTERN_MAX}.`
  }
  // The length cap is the guard against catastrophic backtracking: a pure
  // matcher cannot interrupt itself, so bound what it can be asked to chew on.
  if (text.length > REGEX_TEXT_MAX) {
    return (
      `regex_test: the text is ${text.length} characters and the cap is ${REGEX_TEXT_MAX} — a nested ` +
      `quantifier over input that size can run for minutes. Slice the text and test the slice.`
    )
  }
  if (!/^[dgimsuvy]*$/.test(flags)) {
    return `regex_test: ${JSON.stringify(flags)} is not a set of flags. Use any of d g i m s u v y.`
  }

  const all = flags.includes('g')
  const base = flags.replace(/[gd]/g, '')
  let re: RegExp | null = null
  try {
    re = new RegExp(pattern, `${base}gd`)
  } catch {
    re = null
  }
  if (!re) {
    try {
      re = new RegExp(pattern, `${base}g`)
    } catch (err) {
      return `regex_test: invalid pattern /${pattern}/${flags} — ${msgOf(err)}`
    }
  }

  const header = `/${pattern}/${flags} over ${text.length} character${text.length === 1 ? '' : 's'}`
  const rows: string[] = []
  let count = 0
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    count += 1
    const end = m.index + m[0].length
    rows.push(`${count}. index ${m.index}-${end} ${JSON.stringify(clip(m[0], STEP_PREVIEW))}`)
    const indices = (m as RegExpExecArray & { indices?: (readonly [number, number] | undefined)[] }).indices
    for (let g = 1; g < m.length; g++) {
      const span = indices?.[g]
      rows.push(
        `     $${g} ${span ? `[${span[0]}-${span[1]}] ` : ''}${m[g] === undefined ? '(no match)' : JSON.stringify(clip(m[g]!, STEP_PREVIEW))}`,
      )
    }
    for (const [gname, gval] of Object.entries(m.groups ?? {})) {
      rows.push(`     ?<${gname}> ${gval === undefined ? '(no match)' : JSON.stringify(clip(String(gval), STEP_PREVIEW))}`)
    }
    if (m[0] === '') re.lastIndex += 1
    if (!all || count >= REGEX_MATCH_CAP) break
  }

  if (count === 0) return `${header} — no match.`
  const capped = all && count >= REGEX_MATCH_CAP ? ` (capped at ${REGEX_MATCH_CAP})` : ''
  const scope = all ? `${count} match${count === 1 ? '' : 'es'}${capped}` : 'first match (add the g flag for all of them)'
  return `${header} — ${scope}\n\n${rows.join('\n')}`
}

// ----------------------------------------------------------------- text_diff

type DiffOp = { k: ' ' | '-' | '+'; text: string }

/** Longest common subsequence over lines, with the common head and tail trimmed
 *  first so the O(n·m) table only ever covers the part that actually differs. */
const diffOps = (a: readonly string[], b: readonly string[]): DiffOps => {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1

  const am = a.slice(head, a.length - tail)
  const bm = b.slice(head, b.length - tail)
  if (am.length > DIFF_LINE_MAX || bm.length > DIFF_LINE_MAX) return { tooBig: Math.max(am.length, bm.length) }

  const n = am.length
  const m = bm.length
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        am[i] === bm[j]
          ? dp[(i + 1) * w + j + 1]! + 1
          : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!)
    }
  }

  const ops: DiffOp[] = []
  for (let k = 0; k < head; k++) ops.push({ k: ' ', text: a[k]! })
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (am[i] === bm[j]) {
      ops.push({ k: ' ', text: am[i]! })
      i += 1
      j += 1
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
      ops.push({ k: '-', text: am[i]! })
      i += 1
    } else {
      ops.push({ k: '+', text: bm[j]! })
      j += 1
    }
  }
  while (i < n) ops.push({ k: '-', text: am[i++]! })
  while (j < m) ops.push({ k: '+', text: bm[j++]! })
  for (let k = a.length - tail; k < a.length; k++) ops.push({ k: ' ', text: a[k]! })
  return { ops }
}

type DiffOps = { ops: DiffOp[]; tooBig?: undefined } | { ops?: undefined; tooBig: number }

const textDiff = (before: string, after: string): string => {
  if (before.length > DIFF_TEXT_MAX || after.length > DIFF_TEXT_MAX) {
    return `text_diff: inputs are capped at ${DIFF_TEXT_MAX} characters each (got ${before.length} and ${after.length}).`
  }
  if (before === after) return 'text_diff: the two texts are identical.'

  const a = before.split('\n')
  const b = after.split('\n')
  const built = diffOps(a, b)
  if (built.tooBig !== undefined) {
    return (
      `text_diff: ${built.tooBig} differing lines, and the cap is ${DIFF_LINE_MAX}. These two texts share ` +
      `almost nothing; diff a smaller region.`
    )
  }
  const ops = built.ops

  // Hunks: every run of changes, plus DIFF_CONTEXT unchanged lines either side.
  const keep = new Array<boolean>(ops.length).fill(false)
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.k === ' ') continue
    for (let j = Math.max(0, i - DIFF_CONTEXT); j <= Math.min(ops.length - 1, i + DIFF_CONTEXT); j++) keep[j] = true
  }

  const out: string[] = ['--- before', '+++ after']
  let added = 0
  let removed = 0
  let aLine = 1
  let bLine = 1
  let i = 0
  while (i < ops.length) {
    if (!keep[i]) {
      if (ops[i]!.k !== '+') aLine += 1
      if (ops[i]!.k !== '-') bLine += 1
      i += 1
      continue
    }
    const aStart = aLine
    const bStart = bLine
    const body: string[] = []
    let aCount = 0
    let bCount = 0
    while (i < ops.length && keep[i]) {
      const op = ops[i]!
      body.push(`${op.k}${op.text}`)
      if (op.k !== '+') { aCount += 1; aLine += 1 }
      if (op.k !== '-') { bCount += 1; bLine += 1 }
      if (op.k === '+') added += 1
      if (op.k === '-') removed += 1
      i += 1
    }
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`)
    out.push(...body)
  }
  out.push(`${added} insertion${added === 1 ? '' : 's'}(+), ${removed} deletion${removed === 1 ? '' : 's'}(-)`)
  return clip(out.join('\n'), OUTPUT_MAX)
}

// -------------------------------------------------------------------- serve

/** The engine strips nothing from a tool call's arguments, so `tool` and
 *  `tool_use_id` ride beside them; they are not the model's parameters. */
const paramsOf = (args: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) if (k !== 'tool' && k !== 'tool_use_id' && k !== 'consent') out[k] = v
  return out
}

const serve = async ($: Dollar, name: string, raw: Record<string, unknown>): Promise<string> => {
  const args = paramsOf(raw)
  try {
    if (name === 'create_tool') return await createTool($, args)
    if (name === 'list_tools') return await listTools($)
    if (name === 'forget_tool') return await forgetTool($, args)
    if (name === 'json_query') return jsonQuery(String(args.json ?? ''), String(args.path ?? ''))
    if (name === 'regex_test') {
      return regexTest(String(args.pattern ?? ''), String(args.flags ?? ''), String(args.text ?? ''))
    }
    if (name === 'text_diff') return textDiff(String(args.before ?? ''), String(args.after ?? ''))

    const def = (await loadForged($))[name]
    if (!def) {
      return (
        `mcp__forge__${name} no longer exists for this project — it was forgotten, or it belongs to ` +
        `another codebase. Call mcp__forge__list_tools to see what is here.`
      )
    }
    return await runForged($, def, args)
  } catch (err) {
    // A hook that throws is skipped silently and the call fails with nothing to
    // read; an error the model can act on is worth more.
    return `mcp__forge__${name} failed: ${msgOf(err)}`
  }
}

// ---------------------------------------------------------------- the plugin

export const register: Register = (on) => {
  // Awaited before the first prompt, so every tool this project forged in an
  // earlier session is in the listing by turn one. This is the whole point.
  on('session.start', async ($, e, next) => {
    M.project = ''
    await registerBuiltins($)
    const back = await registerForged($).catch(() => 0)
    if (back > 0) $.ui.log(`forge: re-registered ${back} forged tool${back === 1 ? '' : 's'} for this project`)
    return next(e)
  })

  // Forge's tools are served here. A call no hook answers fails, so every
  // mcp__forge__* name must return a result — including one that no longer
  // exists, which answers with an explanation rather than an engine error.
  on('tool.call', ($, e, next) => {
    const name = String((e as { tool: string }).tool)
    const mine = /^mcp__forge__(.+)$/.exec(name)
    if (!mine) return next(e)
    const args = e as unknown as Record<string, unknown>
    return serve($, mine[1]!, args).then((text) => ({ result: text }) as never)
  })
}
