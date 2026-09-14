// syzygy-editor — a file named in the chat opens in an editor split beneath
// the session.
//
// Three pieces, one idea: the path the model just typed is the thing you want
// to look at, so make it a target you can hit.
//
//   the box     a `ui.render` hook on `AssistantMessage` finds file references
//               in the reply, keeps the ones that EXIST on disk, and draws each
//               as a terminal `Button` — `[ src/app/util.js ]`. Pressing one
//               runs bin/syzygy-edit, which splits a tmux pane beneath the
//               session running the user's editor. The pane closes itself when
//               the editor exits, because a pane running a command ends with it.
//   the tool    `open_in_editor(path)`, so "open that" works with no mouse.
//   the rule    one `prompt.context` block asking the model to write paths
//               relative to the working directory, so `util.js` in two folders
//               are two different, unambiguous references.
//
// **Zero model calls.** The reference detector is a regex and a `$.fs.stat`
// filter; the relative-path rule is an INSTRUCTION in the conversation's
// context, not a classification. `just validate` prints the call inventory:
// no `$.model.*` line appears there.
//
// Four things established by probe on build 2.1.269 rather than assumed
// rather than assumed:
//
//  1. **A `Button` inside an `AssistantMessage` is pressable.** A mouse click
//     on it raises `ui.press` with `component: 'AssistantMessage'` and runs the
//     `onPress` closure. This is the whole click story — no OSC 8 link, no
//     localhost listener, no custom URL scheme.
//  2. **`next(e)` on `ui.render` resolves to an OPAQUE node** — literally
//     `{"type":"engine","ref":1}`. The engine's own drawing cannot be walked or
//     spliced into, so a Button cannot be threaded through the engine's
//     markdown. It CAN be embedded as a child (`<t.Box>{await next(e)}</t.Box>`),
//     which is what `box: "row"` does and why that is the default: `"inline"`
//     means owning the whole tree, and owning the tree means the reply's bold,
//     inline code, list bullets and fenced-block highlighting are gone.
//  3. **`$.fs.exists` and `$.fs.stat` survived the 2.1.269 rename** that took
//     `readFile` → `read`. `$.fs.exists` answers for absolute
//     paths outside the working directory too, so a reference to /etc/hosts
//     resolves rather than throwing.
//  4. **A render hook may await.** The engine waits for it (the debug log times
//     each one). Existence is therefore resolved in the hook and memoised twice
//     over — by message text, and by path with a short TTL — because the hook
//     fires ~10×/s per message and a transcript re-renders every message.

import type { EngineInterface, FsStat, Register, RenderNode, ToolSpec } from 'claude-code'

type Dollar = EngineInterface

/** What `$.fs.stat` says a path is. `null`, everywhere below, means ABSENT —
 *  which is what the boolean `false` meant while this was an existence check. */
export type FsKind = FsStat['kind']

// ---------------------------------------------------------------- constants

/** Where the user's settings live. Not in the repo: machine-local config. */
const CONFIG_PATH = '.claude/syzygy-editor.json'

/** More boxes than this in one reply is a listing, not a reference; drawing
 *  forty buttons under a message helps nobody and costs forty fs probes. */
const MAX_REFS = 12

/** A path's existence is cached this long. Short, because a file the model
 *  just wrote should become pressable within a frame or two of it landing. */
const EXISTS_TTL_MS = 5000

/** How many message texts keep their parse. A streamed reply produces a new
 *  text every frame, so this fills fast and is trimmed oldest-first. */
const PARSE_CACHE_MAX = 240

/** Scheme-ish prefixes are masked before scanning so a URL's path half never
 *  becomes a candidate. Masked with spaces so every index stays true. */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi

/** A candidate run: path characters, an optional trailing `/` (a folder is a
 *  legitimate reference written either way, and `docs/` would otherwise scan
 *  as the bare word `docs` and be dropped for having no slash), then an
 *  optional `:line` or `:line:col`. Broad on purpose — `looksLikePath` and
 *  then the existence check do the refusing. */
const CAND_RE = /(?:~\/|\.{0,2}\/)?(?:[A-Za-z0-9_.@+~-]+\/)*[A-Za-z0-9_.@+~-]+\/?(?::\d+(?::\d+)?)?/g

/** Trailing prose punctuation to shed: `see src/a.ts.` is a reference to
 *  `src/a.ts`, and `(src/a.ts)` is too. */
const TRAILING_RE = /[.,;:!?)\]}'"“”‘’]+$/

/** A bare (slashless) candidate must end in a real extension: at least two
 *  characters, starting with a letter. This is what refuses `e.g.` (ext `g`,
 *  one character) and `v1.2` / `2.1.269` (ext starts with a digit) without a
 *  word list to keep up to date. */
const BARE_EXT_RE = /\.[A-Za-z][A-Za-z0-9]{1,7}$/

/** `**bold**` and `` `code` `` in `box: "inline"`, the only two markdown spans
 *  worth reconstructing by hand. Everything else renders as written. */
const SPAN_RE = /\*\*([^*]+)\*\*|`([^`]+)`/g

export type Config = {
  /** Append the relative-path instruction to the conversation's context. */
  relativePathRule: boolean
  /** The editor the split runs. `$SYZYGY_EDITOR`/`$VISUAL`/`$EDITOR` still win
   *  inside the script when this is left at its default. */
  editor: string
  /** Where the editor pane goes relative to the session's pane. */
  split: 'below' | 'right'
  /** The split's size, as tmux takes it (`40%`, or a cell count). */
  size: string
  /** `row` keeps the engine's own markdown drawing and puts the buttons on a
   *  dim row beneath it. `inline` boxes each reference where it stands, at the
   *  cost of the reply's markdown (see the header note 2). */
  box: 'row' | 'inline'
  /** What pressing a FOLDER does. `finder` opens a Finder window with `open`
   *  (macOS only; off macOS the value is inert and the editor opens, since
   *  `open` is not there to run). `editor` keeps the pre-folders behaviour:
   *  the directory goes to the editor pane, where nvim draws netrw. */
  folders: 'finder' | 'editor'
}

export const DEFAULTS: Config = {
  relativePathRule: true,
  editor: 'nvim',
  split: 'below',
  size: '40%',
  box: 'row',
  folders: 'finder',
}

/** The instruction, verbatim. An INSTRUCTION the model reads, not a model
 *  call: `prompt.context` appends text to the conversation's first message. */
export const RELATIVE_PATH_RULE =
  'When you name a file in a reply, write its path relative to the working ' +
  'directory (`src/a/b.ts`, not `b.ts` and not an absolute path), so ' +
  'references are unambiguous.'

const TOOL: ToolSpec = {
  name: 'open_in_editor',
  description:
    'Open a file in the editor pane: a tmux split beneath this session running ' +
    "the user's editor, which closes itself when the editor exits. Use it when " +
    'the user asks to open, edit or look at a file in their editor. A folder ' +
    'opens in a Finder window on macOS instead, unless `in` says otherwise. ' +
    'The path is relative to the working directory, or absolute.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file or folder to open, relative to the working directory or absolute.' },
      line: { type: 'number', description: 'Optional line to put the cursor on.' },
      in: {
        type: 'string',
        enum: ['finder', 'editor'],
        description:
          "Where to open a FOLDER: 'finder' for a Finder window (macOS), 'editor' for the editor pane. " +
          'Ignored for a file, and off macOS.',
      },
    },
    required: ['path'],
  },
}

// -------------------------------------------------------------------- state

export type Ref = {
  /** The token as it appeared, `:line` included. */
  raw: string
  /** The path half, trailing punctuation shed, and expanded to the absolute
   *  form when it was `~`/`~/`/`$HOME`/`$HOME/`-relative — the only forms
   *  nothing downstream ever expands on its own (the argv is exec'd, never
   *  run through a shell). A cwd-relative or already-absolute token is left
   *  as it was typed, which is what keeps a button's label and the tmux
   *  command line short. This is what feeds `editArgv`, so the VALUE the
   *  editor opens is always this, never the raw `~`. */
  rel: string
  /** Resolved against the working directory; what `$.fs.stat` is asked. */
  abs: string
  /** The line, when the token carried one. */
  line?: number
  /** Index of `raw` in the message text — the render walks these in order. */
  start: number
  end: number
}

/** A `Ref` the existence filter has answered for. Always a SHALLOW COPY of the
 *  cached `Ref`, never the cached object with a field written onto it:
 *  `M.parsed` holds those for the life of a message's text, and a kind written
 *  there would outlive the 5 s TTL the kind is supposed to obey. */
export type LiveRef = Ref & { kind: FsKind }

/** Module scope, because `$` may never be bound: the helpers take `($: Dollar,
 *  …)` and read what they need from here. */
const M: {
  cwd: string
  home: string
  script: string
  pane: string
  /** `$.session.id()`, resolved once at session.start. Used to find the
   *  attach pane when TMUX_PANE is absent, and passed to the script as
   *  `--session` so it can do the same lookup as a fallback. */
  sessionId: string
  cfg: Config
  /** `darwin` only when `uname` said exactly that. Read ONCE at session.start:
   *  it cannot change while a session runs, and a press must not pay a
   *  subprocess before doing its work. */
  os: 'darwin' | 'other'
  /** text → the refs parsed out of it. Bounded, oldest-first. */
  parsed: Map<string, Ref[]>
  /** abs path → [kind, when]. `null` is "absent", what `false` used to mean. */
  seen: Map<string, [FsKind | null, number]>
  /** Counters the harness asserts against: one parse per distinct text. */
  parses: number
  opens: number
} = {
  cwd: '',
  home: '',
  script: '',
  pane: '',
  sessionId: '',
  cfg: { ...DEFAULTS },
  os: 'other',
  parsed: new Map(),
  seen: new Map(),
  parses: 0,
  opens: 0,
}

/** The harness reads counters and caches through this rather than reaching
 *  into the module's private name. Exported extras are fine: `--strict`
 *  accepts them and the engine reads only `register`. */
export const state = M

// ------------------------------------------------------------ pure: parsing

/** Mask every URL with spaces, so indices are preserved and no scheme's path
 *  half survives as a candidate. */
export const maskUrls = (text: string): string =>
  text.replace(URL_RE, (m) => ' '.repeat(m.length))

/** Is this candidate shaped like a path at all? The cheap half of the filter;
 *  `$.fs.stat` (with an `$.fs.exists` fallback) is the expensive, authoritative
 *  half. */
export const looksLikePath = (token: string): boolean => {
  if (token.length < 3 || token.length > 400) return false
  if (token.includes('//')) return false
  if (token.startsWith('-')) return false
  // `../` and `./` become candidates once a trailing slash is allowed, and
  // `../` RESOLVES -- to the parent directory, which exists, so the existence
  // filter would box it and label it `/`. "Up one" is navigation, not a place
  // the model named.
  if (/^[./]+$/.test(token)) return false
  if (token.includes('/')) return true
  // Slashless: only a real extension saves it. `e.g` and `v1.2` die here.
  return BARE_EXT_RE.test(token)
}

/** Expand a bare `~`, a `~/`-prefix or a `$HOME`/`$HOME/`-prefix against
 *  `home`, once. Anything else — including `~user/...`, not supported — is
 *  returned unchanged; `resolvePath`'s cwd-join and the existence check then
 *  do the (correct) refusing rather than a special case here. */
export const expandTilde = (home: string, token: string): string => {
  if (home === '') return token
  if (token === '~' || token === '$HOME') return home
  if (token.startsWith('~/')) return `${home}/${token.slice(2)}`
  if (token.startsWith('$HOME/')) return `${home}/${token.slice(6)}`
  return token
}

/** Resolve a reference against the working directory. Pure — `home` and `cwd`
 *  are arguments so the harness can resolve against a tree it invented. */
export const resolvePath = (cwd: string, home: string, rel: string): string => {
  let p = expandTilde(home, rel)
  if (!p.startsWith('/')) p = `${cwd}/${p}`
  // Collapse `./` and a single `..` segment; no fs, no symlinks.
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  return `/${out.join('/')}`
}

/** Every file-shaped token in `text`, in order, deduplicated by path.
 *
 *  Pure and index-accurate: the render walks `start`/`end` to cut the text
 *  into segments, so a token's indices must land in the ORIGINAL string, which
 *  is why URLs are masked rather than removed. */
export const scanRefs = (text: string, cwd: string, home: string): Ref[] => {
  const masked = maskUrls(text)
  const out: Ref[] = []
  const byPath = new Set<string>()
  CAND_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CAND_RE.exec(masked)) !== null) {
    if (out.length >= MAX_REFS) break
    let token = m[0]
    if (!token.includes('/') && !token.includes('.')) continue
    const trimmed = token.replace(TRAILING_RE, '')
    if (trimmed === '') continue
    token = trimmed
    let rel = token
    let line: number | undefined
    const colon = /^(.*?):(\d+)(?::\d+)?$/.exec(token)
    if (colon) {
      rel = colon[1]!
      line = Number(colon[2])
    }
    if (!looksLikePath(rel)) continue
    const abs = resolvePath(cwd, home, rel)
    if (byPath.has(abs)) continue
    byPath.add(abs)
    // A `~`/`$HOME`-relative reference is expanded HERE, once, so the same
    // absolute path feeds the existence check above (`abs`), the label
    // (derived from `abs` and `home` in `label()`) and the argv (`rel`,
    // below) — never the literal `~`, which nothing downstream expands: the
    // argv is exec'd directly (no shell), so nvim would open it as a
    // same-named RELATIVE file instead of the file this button means.
    const homeRelative = expandTilde(home, rel) !== rel
    const ref: Ref = { raw: token, rel: homeRelative ? abs : rel, abs, start: m.index, end: m.index + token.length }
    if (line !== undefined) ref.line = line
    out.push(ref)
  }
  return out
}

/** `scanRefs` memoised on the message text. Two renders of the same text parse
 *  once: the hook fires ~10×/s per message, forever. */
export const refsOf = (text: string, cwd: string, home: string): Ref[] => {
  const hit = M.parsed.get(text)
  if (hit) return hit
  const refs = scanRefs(text, cwd, home)
  M.parses++
  M.parsed.set(text, refs)
  if (M.parsed.size > PARSE_CACHE_MAX) {
    const oldest = M.parsed.keys().next()
    if (!oldest.done) M.parsed.delete(oldest.value)
  }
  return refs
}

/** What the button says: relative to the working directory when the file is
 *  under it, `~`-relative when it's under the home directory instead, and
 *  absolute otherwise. The point of the whole plugin is that
 *  `src/app/util.js` and `src/lib/util.js` are different labels. The `~` form
 *  is cosmetic ONLY — derived straight from `abs`/`home`, never from `rel` —
 *  the VALUE fed to the argv (`ref.rel`) is always the absolute path for a
 *  home reference (see `scanRefs`), because nothing downstream expands a
 *  literal `~`. A directory's label carries a trailing `/` so a folder reads
 *  as one — the only thing that distinguishes the two before you press,
 *  since the terminal has no hover. */
export const label = (cwd: string, home: string, ref: Ref, kind?: FsKind | null): string => {
  const inside = cwd !== '' && ref.abs.startsWith(`${cwd}/`)
  let path: string
  if (inside) {
    path = ref.abs.slice(cwd.length + 1)
  } else if (home !== '' && ref.abs.startsWith(`${home}/`)) {
    path = `~/${ref.abs.slice(home.length + 1)}`
  } else {
    path = ref.abs
  }
  // A line number in a directory is nonsense; the suffix is for folders only.
  if (ref.line !== undefined) return `${path}:${ref.line}`
  return kind === 'dir' ? `${path}/` : path
}

/** The argv `bin/syzygy-edit` is invoked with. Pure, and an ARRAY: the path is
 *  never interpolated into a shell string. `--session` is passed only when
 *  `pane` is unknown — it is the script's OWN fallback (see `attachPaneFor`
 *  below and the mirrored shell resolution in `bin/syzygy-edit`), not needed
 *  once a pane is already in hand. */
export const editArgv = (
  script: string,
  cfg: Config,
  pane: string,
  sessionId: string,
  ref: { rel: string; line?: number },
): string[] => {
  const argv = [script]
  if (pane !== '') argv.push('--pane', pane)
  else if (sessionId !== '') argv.push('--session', sessionId)
  // Only when the config actually CHOSE an editor. Passing the default would
  // put `nvim` ahead of the user's $VISUAL/$EDITOR, which is the script's
  // documented precedence reversed.
  if (cfg.editor !== '' && cfg.editor !== DEFAULTS.editor) argv.push('--editor', cfg.editor)
  argv.push('--split', cfg.split, '--size', cfg.size)
  if (ref.line !== undefined) argv.push('--line', String(ref.line))
  // `--` so a path beginning with a dash is a path, not a flag.
  argv.push('--', ref.rel)
  return argv
}

/** Find the pane a `claude attach <id>` is running THIS session from, given
 *  `tmux list-panes -a -F '#{pane_id}\t#{pane_start_command}\t#{pane_current_command}'`.
 *
 *  A `claude --bg` session's own process carries neither TMUX nor TMUX_PANE —
 *  it is a daemon child, not a pane — so `discover`'s `printenv TMUX_PANE` comes back
 *  empty. The user's terminal there is a SEPARATE `claude attach <id>`
 *  process, itself running inside a tmux pane; when the session's own pane is
 *  unknown, this looks for THAT one instead. `canvas.mjs`'s `attachArgv`
 *  spells the command `claude attach <shortId>` (`shortId` the first 8
 *  characters of the session id), so both the short and full forms are
 *  matched. Several attaches of the same session match several panes; a
 *  repeat attach always `new-window`s (`attachArgv`), so the LAST match in
 *  `list-panes -a`'s per-session window order is the closest this listing
 *  gets to "most recently active" without a client listing to ask instead. */
export const attachPaneFor = (sessionId: string, panesText: string): string => {
  const short = sessionId.slice(0, 8)
  let match = ''
  for (const line of panesText.split('\n')) {
    if (line.trim() === '') continue
    const [paneId, startCmd] = line.split('\t')
    if (paneId === undefined || paneId === '' || startCmd === undefined) continue
    const words = startCmd.trim().split(/\s+/)
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i] === 'attach' && (words[i + 1] === short || words[i + 1] === sessionId)) match = paneId
    }
  }
  return match
}

// ------------------------------------------------------------- pure: config

/** Parse the settings file. Every failure is the defaults: a half-typed JSON
 *  file must not cost the user their boxes. */
export const parseConfig = (text: string): Config => {
  const cfg: Config = { ...DEFAULTS }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return cfg
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return cfg
  const o = raw as Record<string, unknown>
  if (typeof o.relativePathRule === 'boolean') cfg.relativePathRule = o.relativePathRule
  if (typeof o.editor === 'string' && o.editor.trim() !== '') cfg.editor = o.editor.trim()
  if (o.split === 'below' || o.split === 'right') cfg.split = o.split
  if (typeof o.size === 'string' && /^\d{1,3}%?$/.test(o.size.trim())) cfg.size = o.size.trim()
  if (o.box === 'row' || o.box === 'inline') cfg.box = o.box
  if (o.folders === 'finder' || o.folders === 'editor') cfg.folders = o.folders
  return cfg
}

// ------------------------------------------------------- pure: inline spans

export type Span = { text: string; bold?: true; code?: true }

/** The two markdown spans worth rebuilding when `box: "inline"` owns the tree.
 *  Leftover lone markers are dropped rather than drawn: a stray `**` reads as
 *  a bug, and the engine's own renderer is not available to us (header note 2). */
export const styleSpans = (text: string): Span[] => {
  const out: Span[] = []
  let i = 0
  SPAN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SPAN_RE.exec(text)) !== null) {
    if (m.index > i) out.push({ text: text.slice(i, m.index) })
    if (m[1] !== undefined) out.push({ text: m[1], bold: true })
    else if (m[2] !== undefined) out.push({ text: m[2], code: true })
    i = m.index + m[0].length
  }
  if (i < text.length) out.push({ text: text.slice(i) })
  return out.map((s) => ({ ...s, text: s.bold || s.code ? s.text : s.text.replace(/\*\*|`/g, '') })).filter((s) => s.text !== '')
}

/** What a press — or the `open_in_editor` tool — should do with a reference.
 *
 *  Pure, and the ONE place this is decided: the press, the tool and anything
 *  later all ask here. The order matters. A non-directory and a non-macOS
 *  machine are settled BEFORE the setting or a caller's `want`, so `in:
 *  'finder'` can never hand a FILE to `open` (which would launch whatever
 *  application owns that file type) and can never run a command that is not on
 *  the machine. */
export const folderAction = (
  cfg: Config,
  os: 'darwin' | 'other',
  kind: FsKind | null,
  want?: 'finder' | 'editor',
): 'finder' | 'editor' => {
  if (kind !== 'dir') return 'editor'
  if (os !== 'darwin') return 'editor'
  if (want === 'finder' || want === 'editor') return want
  return cfg.folders === 'editor' ? 'editor' : 'finder'
}

// ------------------------------------------------------------ $ : discovery

const readConfig = async ($: Dollar): Promise<void> => {
  // `cat`, not `$.fs.read`: the settings file lives under $HOME, outside the
  // working directory, and hud.tsx established `cat` as the idiom that works
  // across the 2.1.269 `$.fs` rename.
  if (M.home === '') return
  const res = await $.process.run(['cat', `${M.home}/${CONFIG_PATH}`], { timeoutMs: 4000 }).catch(() => null)
  if (!res || res.exitCode !== 0) return
  M.cfg = parseConfig(res.stdout)
}

/** `uname`, once. Bare, not `uname -a`: the long form also prints the machine's
 *  HOSTNAME, so the test would become a substring search across a string a
 *  host called `foo-darwin` would pass. Reset to `'other'` first, then raised
 *  only on an exact match: every failure means today's behaviour rather than a
 *  wrong one. The reset matters only to a harness driving several sessions
 *  through one module; in production `discover` runs once per session. */
const detectOs = async ($: Dollar): Promise<void> => {
  M.os = 'other'
  const res = await $.process.run(['uname'], { timeoutMs: 4000 }).catch(() => null)
  if (res && res.exitCode === 0 && res.stdout.trim().toLowerCase() === 'darwin') M.os = 'darwin'
}

/** Where the plugin's own script is. `$.plugin.root` is absolute and already
 *  resolved, so unlike hud.tsx's pane launcher there is no symlink to walk. */
const discover = async ($: Dollar): Promise<void> => {
  M.cwd = await $.session.cwd().catch(() => '')
  M.script = `${$.plugin.root}/bin/syzygy-edit`
  // Promise.resolve wraps this defensively: the declared contract is
  // Promise<string>, and this is the only call site in the module that
  // chains .catch off it directly (recordRecent below interpolates it
  // un-awaited, and does not need the same guard).
  M.sessionId = await Promise.resolve($.session.id()).catch(() => '')
  const home = await $.process.run(['printenv', 'HOME'], { timeoutMs: 4000 }).catch(() => null)
  if (home && home.exitCode === 0) M.home = home.stdout.trim()
  // TMUX_PANE in the session's own environment is the pane Claude draws in;
  // pane ids are stable, so this stays true for the session's life. Absent
  // for a `claude --bg` session, whose process is a daemon child carrying
  // neither TMUX nor TMUX_PANE -- the user's terminal
  // there is a SEPARATE `claude attach <id>` process, found below instead.
  const pane = await $.process.run(['printenv', 'TMUX_PANE'], { timeoutMs: 4000 }).catch(() => null)
  if (pane && pane.exitCode === 0) M.pane = pane.stdout.trim()
  if (M.pane === '' && M.sessionId !== '') {
    const panes = await $.process
      .run(['tmux', 'list-panes', '-a', '-F', '#{pane_id}\t#{pane_start_command}\t#{pane_current_command}'], {
        timeoutMs: 4000,
      })
      .catch(() => null)
    if (panes && panes.exitCode === 0) M.pane = attachPaneFor(M.sessionId, panes.stdout)
  }
  await detectOs($)
  await readConfig($)
}

/** What is at this path, cached for EXISTS_TTL_MS? `null` means nothing is.
 *
 *  `$.fs.stat` gives the kind, which is what tells a folder from a file — but
 *  it REJECTS on a missing path (the declarations say so) where `$.fs.exists`
 *  never rejects, and it has never been probed against a path OUTSIDE the
 *  working directory the way `$.fs.exists` has.
 *  A stat that
 *  rejected for any other reason would silently unbox every reference in the
 *  transcript, so `exists` gets the last word: present but unknown is `other`,
 *  which routes to the editor exactly as this plugin behaved before folders. */
const kindCached = async ($: Dollar, abs: string): Promise<FsKind | null> => {
  const now = $.clock.now()
  const hit = M.seen.get(abs)
  if (hit && now - hit[1] < EXISTS_TTL_MS) return hit[0]
  const st = await $.fs.stat(abs).catch(() => null)
  let kind: FsKind | null = st === null ? null : st.kind
  if (kind === null && (await $.fs.exists(abs).catch(() => false))) kind = 'other'
  M.seen.set(abs, [kind, now])
  return kind
}

/** The refs in `text` that exist on disk, in order, each with its kind. */
const liveRefs = async ($: Dollar, text: string): Promise<LiveRef[]> => {
  const out: LiveRef[] = []
  for (const ref of refsOf(text, M.cwd, M.home)) {
    const kind = await kindCached($, ref.abs)
    if (kind !== null) out.push({ ...ref, kind })
  }
  return out
}

/** Run the editor script. One-shot is right: `tmux split-window` returns as
 *  soon as the pane exists — the editor keeps running in the pane, not here. */
const openPath = async ($: Dollar, rel: string, line?: number): Promise<string> => {
  const ref = line === undefined ? { rel } : { rel, line }
  const argv = editArgv(M.script, M.cfg, M.pane, M.sessionId, ref)
  M.opens++
  const res = await $.process.run(argv, { timeoutMs: 10000 }).catch(() => null)
  if (!res) return `could not run ${M.script}`
  // Two honest exit-2 messages come back on stderr now -- "not inside tmux"
  // when there is truly no terminal to try, and "no tmux pane is attached to
  // this session" when this IS a `claude --bg` session but no `claude attach`
  // was found either (bin/syzygy-edit's own message, mirrored from the same
  // `attachPaneFor` reasoning above). Pass whichever one came back through,
  // rather than hard-coding "not inside tmux" here for both.
  if (res.exitCode === 2) {
    const why = (res.stderr || '').trim().replace(/^syzygy-edit: /, '') || 'not inside tmux'
    return `${why} (would have run: ${res.stdout.trim()})`
  }
  if (res.exitCode !== 0) return `syzygy-edit failed: ${(res.stderr || res.stdout).trim()}`
  return `opened ${rel} in the editor pane`
}

/** Open a directory in a Finder window. macOS only — `folderAction` has
 *  already established that, and this is never reached otherwise.
 *
 *  `open` returns as soon as it has handed the path to the window server, so
 *  one-shot is right here for the same reason it is right for `tmux
 *  split-window`. The ABSOLUTE path, never `ref.rel`: `open` inherits the
 *  ENGINE's working directory, which is not guaranteed to be the session's. */
const openFolder = async ($: Dollar, abs: string): Promise<string> => {
  M.opens++
  const res = await $.process.run(['open', abs], { timeoutMs: 10000 }).catch(() => null)
  if (!res) return `could not run open ${abs}`
  if (res.exitCode !== 0) return `open failed: ${(res.stderr || res.stdout).trim()}`
  return `opened ${abs} in Finder`
}

/** What a pressed box does. One decision (`folderAction`), two routes. */
const openRef = async ($: Dollar, ref: LiveRef): Promise<string> => {
  if (folderAction(M.cfg, M.os, ref.kind) === 'finder') return openFolder($, ref.abs)
  return openPath($, ref.rel, ref.line)
}

/** The last turn's referenced-and-existing paths, for a pane or band that wants
 *  to list them. Written under `syzygy-editor:<sessionId>:recent`; `$.store` is
 * shared across sessions, hence the session-id key. */
const recordRecent = async ($: Dollar, text: string): Promise<void> => {
  const refs = await liveRefs($, text)
  const paths = refs.map((r) => label(M.cwd, M.home, r, r.kind))
  await $.store
    .set(`syzygy-editor:${$.session.id()}:recent`, { cwd: M.cwd, pane: M.pane, at: $.clock.now(), paths })
    .catch(() => {})
}

// -------------------------------------------------------------------- tools

const serveTool = async ($: Dollar, input: unknown): Promise<string> => {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const path = typeof o.path === 'string' ? o.path.trim() : ''
  if (path === '') return 'open_in_editor needs a path.'
  const line = typeof o.line === 'number' && Number.isFinite(o.line) ? Math.trunc(o.line) : undefined
  const want = o.in === 'finder' || o.in === 'editor' ? o.in : undefined
  const abs = resolvePath(M.cwd, M.home, path)
  const kind = await kindCached($, abs)
  if (kind === null) return `no such file: ${path}`
  if (folderAction(M.cfg, M.os, kind, want) === 'finder') return openFolder($, abs)
  // Same expansion as scanRefs: a hand-typed ~ must not reach the argv
  // unexpanded, or bin/syzygy-edit's exec'd (no-shell) argv opens it as a
  // same-named relative file instead of the file this call means.
  const arg = expandTilde(M.home, path) !== path ? abs : path
  return openPath($, arg, line)
}

// ----------------------------------------------------------------- register

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await discover($).catch(() => {})
    await $.tool.register(TOOL).catch(() => {})
    return next(e)
  })

  // An INSTRUCTION, not a model call: `prompt.context` appends text the model
  // reads beside the first message. Nothing is classified, nothing is asked.
  on('prompt.context', ($, e, next) => {
    if (!M.cfg.relativePathRule) return next(e)
    return next({ ...e, blocks: [...e.blocks, { name: 'syzygyEditor', text: RELATIVE_PATH_RULE }] })
  })

  // Cheap, no model call: the finished answer's existing file references, kept
  // for whatever wants to list "files this session just touched".
  on('turn.complete', async ($, e, next) => {
    const answer = typeof e.answer === 'string' ? e.answer : ''
    if (answer !== '') await recordRecent($, answer).catch(() => {})
    return next(e)
  })

  on('tool.call', { tool: /^mcp__syzygy-editor__open_in_editor$/ }, async ($, e, next) => {
    const text = await serveTool($, e).catch((err: unknown) => `open_in_editor failed: ${String(err)}`)
    return { result: text }
  })

  // The box. Terminal only; every other surface passes straight through.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    try {
      const text = String(e.props.text ?? '')
      if (text === '') return next(e)
      const refs = await liveRefs($, text)
      if (refs.length === 0) return next(e)
      const t = await $.ui.resolve(e)

      // `onPress` is built HERE, inline, because `$` may never be stashed for a
      // top-level handler to use.
      const button = (ref: LiveRef, i: number): RenderNode => (
        <t.Button
          key={`szg-${i}-${ref.abs}`}
          label={label(M.cwd, M.home, ref, ref.kind)}
          onPress={() => {
            void openRef($, ref).then((line) => $.ui.toast(line))
          }}
        />
      )

      if (M.cfg.box === 'row') {
        // The engine's own drawing, kept whole, with the boxes on a row beneath
        // it. `next(e)` is an opaque engine node; it can be a child, and that is
        // the only way to keep the reply's markdown (header note 2).
        const row: RenderNode[] = [<t.Text dimColor>open </t.Text>]
        refs.forEach((ref, i) => row.push(button(ref, i)))
        return (
          <t.Box flexDirection="column">
            {await next(e)}
            <t.Box flexDirection="row" flexWrap="wrap" gap={1} marginLeft={2}>
              {row}
            </t.Box>
          </t.Box>
        )
      }

      // inline: the box goes round the reference where it stands. We own the
      // whole tree here, so the reply's markdown is ours to approximate.
      const rows: RenderNode[] = []
      let cut = 0
      let n = 0
      const lines: { segs: RenderNode[] }[] = [{ segs: [] }]
      const push = (node: RenderNode): void => {
        lines[lines.length - 1]!.segs.push(node)
      }
      const plain = (chunk: string): void => {
        const parts = chunk.split('\n')
        parts.forEach((part, idx) => {
          if (idx > 0) lines.push({ segs: [] })
          for (const span of styleSpans(part)) {
            // Word by word, so a wrapping row still breaks between words.
            for (const word of span.text.split(/(\s+)/)) {
              if (word === '') continue
              push(
                <t.Text bold={span.bold === true} color={span.code === true ? 'cyan' : undefined}>
                  {word}
                </t.Text>,
              )
            }
          }
        })
      }
      if (e.props.isFirstOfReply === true) push(<t.Text color="green">⏺ </t.Text>)
      for (const ref of refs) {
        plain(text.slice(cut, ref.start))
        push(button(ref, n++))
        cut = ref.end
      }
      plain(text.slice(cut))
      for (const line of lines) {
        rows.push(
          <t.Box flexDirection="row" flexWrap="wrap">
            {line.segs.length === 0 ? [<t.Text> </t.Text>] : line.segs}
          </t.Box>,
        )
      }
      return <t.Box flexDirection="column">{rows}</t.Box>
    } catch {
      // An invalid tree is silently replaced by the engine's own; a throw is
      // silently skipped. Neither should be how this ends, so fail to the
      // engine's drawing explicitly.
      return next(e)
    }
  })
}
