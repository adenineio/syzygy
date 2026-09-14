/* The command bar's markdown, small and self-authored: no vendored library,
   escape-first, and every tag it can ever emit is named in MCMD.TAGS so the
   harness can hold the allowlist to the code. A CLASSIC script like
   quick-access.js -- no DOM, no imports, referenced BARE as MCMD, never
   window.MCMD. */
'use strict'

const MCMD = (() => {
  // Everything render() may ever put in its output; the harness scans real
  // output against this list rather than trusting it by inspection alone.
  const TAGS = Object.freeze([
    'p', 'h1', 'h2', 'h3', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
    'blockquote', 'a', 'br',
  ])

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c])

  const HEADING_RE = /^(#{1,3})\s+(.*)$/
  const heading = (line) => {
    const m = HEADING_RE.exec(line)
    return m ? { level: m[1].length, text: m[2] } : null
  }

  // Built at runtime, never typed as a literal escape sequence in this file
  // -- a typed control-character escape can land as a real byte instead of
  // the characters it was meant to spell.
  const MARK = String.fromCharCode(1)
  const MARK_RE = new RegExp(MARK + '(\\d+)' + MARK, 'g')

  /** Code spans are pulled out to placeholders FIRST, so nothing later
   *  (bold, italic, links) ever looks inside one -- `` `*not bold*` `` keeps
   *  its literal asterisks. Content is already escaped by the caller. */
  const extractCode = (text) => {
    const stash = []
    const out = text.replace(/`([^`\n]+)`/g, (_, code) => {
      stash.push(code)
      return MARK + (stash.length - 1) + MARK
    })
    return { out, stash }
  }
  const restoreCode = (text, stash) => text.replace(MARK_RE, (_, i) => '<code>' + stash[Number(i)] + '</code>')

  /** Only http:/https: URLs become a real link; any other scheme is left
   *  exactly as written -- already escaped, so it is inert text either way. */
  const applyLinks = (text) => text.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, label, url) =>
    /^https?:\/\//i.test(url) ? '<a href="' + url + '" rel="noopener noreferrer" target="_blank">' + label + '</a>' : whole)

  /** Bold before italic, both non-greedy, neither crosses a newline. An
   *  unmatched marker (no closer) is left as plain, already-escaped text. */
  const applyEmphasis = (text) => text
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>')

  /** The inline pipeline for one block's already-escaped text: code out,
   *  emphasis and links on what remains, code back in -- so a link or an
   *  emphasis marker inside a code span is never touched. */
  const inline = (text) => {
    const { out, stash } = extractCode(text)
    return restoreCode(applyLinks(applyEmphasis(out)), stash)
  }

  const FENCE_RE = /^```([a-z0-9+-]*)$/
  const BULLET_RE = /^\s*[-*]\s+(.*)$/
  const NUMBER_RE = /^\s*\d+\.\s+(.*)$/
  const QUOTE_RE = /^>\s?(.*)$/
  const BLANK_RE = /^\s*$/

  /** Block classification, line by line. A fence or heading line cannot
   *  also match a list or quote, so the order among those checks does not
   *  matter beyond running before the plain-text fallback. */
  const classify = (line) => {
    if (FENCE_RE.test(line)) return 'fence'
    if (heading(line)) return 'heading'
    if (BULLET_RE.test(line)) return 'bullet'
    if (NUMBER_RE.test(line)) return 'number'
    if (QUOTE_RE.test(line)) return 'quote'
    if (BLANK_RE.test(line)) return 'blank'
    return 'text'
  }

  /** The one export. Block structure is read off the RAW input -- `>` is
   *  both the blockquote marker and an HTML escape target, so escaping the
   *  whole input up front would make a quoted line unrecognisable. Every
   *  fragment of user text is still escaped exactly once, individually,
   *  before any tag is built around it, which is what "escape-first" means
   *  in practice: nothing reaches the page without having passed through
   *  `escape()`, and nothing after that point can turn it back into a live
   *  tag. Fenced code content is escaped but never run through `inline()`
   *  -- a code block's contents are literal. */
  const render = (text) => {
    const lines = String(text ?? '').split('\n')
    const blocks = []
    let i = 0
    while (i < lines.length) {
      const kind = classify(lines[i])
      if (kind === 'blank') { i++; continue }
      if (kind === 'fence') {
        const lang = FENCE_RE.exec(lines[i])[1]
        const cls = lang ? ' class="lang-' + lang + '"' : ''
        i++
        const body = []
        while (i < lines.length && !FENCE_RE.test(lines[i])) { body.push(lines[i]); i++ }
        if (i < lines.length) i++ // consume the closing fence
        blocks.push('<pre' + cls + '>' + escape(body.join('\n')) + '</pre>')
        continue
      }
      if (kind === 'heading') {
        const h = heading(lines[i])
        blocks.push('<h' + h.level + '>' + inline(escape(h.text)) + '</h' + h.level + '>')
        i++
        continue
      }
      if (kind === 'bullet' || kind === 'number') {
        const re = kind === 'bullet' ? BULLET_RE : NUMBER_RE
        const items = []
        while (i < lines.length && classify(lines[i]) === kind) { items.push(re.exec(lines[i])[1]); i++ }
        const tag = kind === 'bullet' ? 'ul' : 'ol'
        blocks.push('<' + tag + '>' + items.map((t) => '<li>' + inline(escape(t)) + '</li>').join('') + '</' + tag + '>')
        continue
      }
      if (kind === 'quote') {
        const items = []
        while (i < lines.length && classify(lines[i]) === 'quote') { items.push(QUOTE_RE.exec(lines[i])[1]); i++ }
        blocks.push('<blockquote>' + inline(escape(items.join('\n'))).replace(/\n/g, '<br>') + '</blockquote>')
        continue
      }
      // A run of consecutive plain lines is one paragraph, joined by a space.
      const para = []
      while (i < lines.length && classify(lines[i]) === 'text') { para.push(lines[i]); i++ }
      blocks.push('<p>' + inline(escape(para.join(' '))) + '</p>')
    }
    return blocks.join('')
  }

  return { TAGS, render }
})()
