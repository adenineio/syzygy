#!/usr/bin/env node
// cmd-markdown.js's whole pure core, loaded as a classic script under node --
// the quick-access.js pattern. No DOM: render() builds a string, never a node.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'syzygy', 'bridge', 'public', 'cmd-markdown.js')
const MCMD = new Function(readFileSync(SRC, 'utf8') + '\nreturn MCMD')()

let pass = 0
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label) }

console.log('=== cmd-markdown (pure core) ===')

ok('a bare line is one paragraph', () => { assert.equal(MCMD.render('hello world'), '<p>hello world</p>') })
ok('a blank line separates two paragraphs', () => { assert.equal(MCMD.render('one\n\ntwo'), '<p>one</p><p>two</p>') })
ok('two consecutive lines join with a space', () => { assert.equal(MCMD.render('one\ntwo'), '<p>one two</p>') })
ok('escapes & < > " \' before anything else runs', () => {
  assert.equal(MCMD.render('<b>&"\''), '<p>&lt;b&gt;&amp;&quot;&#39;</p>')
})
ok('a script tag is inert text, never a live tag', () => {
  const html = MCMD.render('<script>alert(1)</script>')
  assert.ok(!/<script/i.test(html))
  assert.ok(html.includes('&lt;script&gt;'))
})
ok('headings # through ### produce h1..h3', () => {
  assert.equal(MCMD.render('# one'), '<h1>one</h1>')
  assert.equal(MCMD.render('## two'), '<h2>two</h2>')
  assert.equal(MCMD.render('### three'), '<h3>three</h3>')
})
ok('#### is not a heading -- only one to three hashes are', () => {
  assert.equal(MCMD.render('#### not a heading'), '<p>#### not a heading</p>')
})
ok('bold and italic', () => {
  assert.equal(MCMD.render('a **bold** word'), '<p>a <strong>bold</strong> word</p>')
  assert.equal(MCMD.render('a *italic* word'), '<p>a <em>italic</em> word</p>')
})
ok('inline code is never itself interpreted as markdown', () => {
  assert.equal(MCMD.render('a `*not bold*` word'), '<p>a <code>*not bold*</code> word</p>')
})
ok('an unbalanced marker renders as plain text, not a broken tag', () => {
  assert.equal(MCMD.render('a **bold word'), '<p>a **bold word</p>')
  assert.equal(MCMD.render('a `unterminated code'), '<p>a `unterminated code</p>')
})

// ---- lists, blockquotes, fenced code, links -------------------------------

const openTagsIn = (html) => [...html.matchAll(/<([a-z0-9]+)[ >]/gi)].map((m) => m[1].toLowerCase())
const assertOnlyAllowedTags = (html) => {
  for (const t of openTagsIn(html)) assert.ok(MCMD.TAGS.includes(t), 'unlisted tag <' + t + '> in: ' + html)
}

ok('a fenced code block, with an allow-listed language class', () => {
  assert.equal(MCMD.render('```js\nconst x = 1\n```'), '<pre class="lang-js">const x = 1</pre>')
})
ok('a fence with no language token', () => { assert.equal(MCMD.render('```\nplain\n```'), '<pre>plain</pre>') })
ok('a fence never closed renders as one open <pre> to the end of the text', () => {
  assert.equal(MCMD.render('```\na\nb'), '<pre>a\nb</pre>')
})
ok('bullet and numbered lists, flat regardless of indent', () => {
  assert.equal(MCMD.render('- a\n- b'), '<ul><li>a</li><li>b</li></ul>')
  assert.equal(MCMD.render('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>')
  assert.equal(MCMD.render('- a\n  - nested'), '<ul><li>a</li><li>nested</li></ul>')
})
ok('a blockquote joins consecutive quoted lines on <br>', () => {
  assert.equal(MCMD.render('> a\n> b'), '<blockquote>a<br>b</blockquote>')
})
ok('a link renders only for http/https, rel/target-guarded', () => {
  assert.equal(MCMD.render('[go](https://example.com/x?y=1)'),
    '<p><a href="https://example.com/x?y=1" rel="noopener noreferrer" target="_blank">go</a></p>')
})
ok('a non-http(s) link is left as plain escaped text', () => {
  assert.equal(MCMD.render('[bad](javascript:alert(1))'), '<p>[bad](javascript:alert(1))</p>')
  assert.equal(MCMD.render('[bad](ftp://x)'), '<p>[bad](ftp://x)</p>')
})
ok('the frozen tag list is a plain array with the expected members', () => {
  for (const t of ['p', 'h1', 'h2', 'h3', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'a', 'br']) {
    assert.ok(MCMD.TAGS.includes(t), 'TAGS is missing ' + t)
  }
  assert.throws(() => { MCMD.TAGS.push('img') }, 'TAGS must be frozen')
})

console.log('=== cmd-markdown XSS battery ===')
const XSS_INPUTS = [
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">click</a>',
  '[x](javascript:alert(1))',
  '<script>alert(1)</script>',
  '"><script>alert(1)</script>',
  '\'><svg onload=alert(1)>',
  '```html\n<script>alert(1)</script>\n```',
  '**<script>alert(1)</script>**',
  '# <img src=x onerror=alert(1)>',
  '> <script>alert(1)</script>',
  '- <script>alert(1)</script>',
]
for (const input of XSS_INPUTS) {
  ok('XSS battery: ' + JSON.stringify(input), () => {
    const html = MCMD.render(input)
    assertOnlyAllowedTags(html)
    // "javascript:" as inert, escaped TEXT is fine (a person can read the
    // literal markup they typed); the property that matters is that it
    // never rides inside a live href/src attribute.
    assert.ok(!/(?:href|src)\s*=\s*"javascript:/i.test(html), 'a javascript: URI landed in a live attribute: ' + html)
    assert.ok(!(/on[a-z]+\s*=/i.test(html) && /<img|<svg/i.test(html)),
      'an event attribute rode along with an image/svg tag: ' + html)
  })
}

console.log(pass + ' passed')
