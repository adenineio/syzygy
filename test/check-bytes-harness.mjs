#!/usr/bin/env node
// Drives scripts/check-bytes.py as a real subprocess against throwaway git
// repositories -- the same shape as test/spinner-script-harness.mjs, for a
// script under the same rule (Python via uv normally; a plain `python3`
// stdlib script is fine with no dependencies). CHECK_BYTES_ROOT points every
// run at a temp repo, the same convention test/plan-progress-harness.mjs
// uses (PLAN_NAMES_ROOT) so this never touches this checkout's own tree.
// Run: node test/check-bytes-harness.mjs
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'check-bytes.py')

let pass = 0
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label) }

const gitIn = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'ignore' })

// A fresh git repo with `files` (path -> Buffer|string content) written and
// staged, plus an optional `.gitattributes`. Commits are never needed --
// `git ls-files` reads the index, not history.
const repo = (files, attributes) => {
  const dir = mkdtempSync(join(tmpdir(), 'szg-check-bytes-'))
  gitIn(['init', '-q'], dir)
  if (attributes) writeFileSync(join(dir, '.gitattributes'), attributes)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  gitIn(['add', '-A'], dir)
  return dir
}

const run = (dir) =>
  spawnSync('python3', [SCRIPT], { encoding: 'utf8', env: { ...process.env, CHECK_BYTES_ROOT: dir } })

// -------------------------------------------------------------------- clean
ok('a clean tree passes with a summary naming the file count', () => {
  const dir = repo({ 'a.md': '# Title\n\nSome prose.\n', 'b.js': 'console.log(1)\n' })
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /2 tracked file\(s\) scanned, no control bytes found/)
  rmSync(dir, { recursive: true, force: true })
})

ok('tab, newline and carriage return are never offenders', () => {
  const dir = repo({ 'a.txt': Buffer.from('col1\tcol2\r\nnext line\n') })
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
  rmSync(dir, { recursive: true, force: true })
})

// --------------------------------------------------------------------- hits
ok('a raw NUL byte fails, reporting the exact line and column', () => {
  const dir = repo({ 'plan.md': Buffer.from('line one\nconst US = \'\x00\'\nline three\n') })
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /^plan\.md:2:13: control byte 0x00$/m)
  assert.match(r.stderr, /1 control byte\(s\) in 1 file\(s\)/)
  rmSync(dir, { recursive: true, force: true })
})

ok('form feed and escape are offenders too, not exempted like tab', () => {
  const dir = repo({
    'ff.txt': Buffer.from('a\x0cb\n'),
    'esc.txt': Buffer.from('a\x1bb\n'),
  })
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /ff\.txt:1:2: control byte 0x0c/)
  assert.match(r.stderr, /esc\.txt:1:2: control byte 0x1b/)
  assert.match(r.stderr, /2 control byte\(s\) in 2 file\(s\)/)
  rmSync(dir, { recursive: true, force: true })
})

ok('DEL (0x7f) is an offender', () => {
  const dir = repo({ 'del.txt': Buffer.from('a\x7fb\n') })
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /del\.txt:1:2: control byte 0x7f/)
  rmSync(dir, { recursive: true, force: true })
})

ok('a high UTF-8 byte (an accented letter, encoded) is never flagged', () => {
  const dir = repo({ 'accents.md': Buffer.from('café — naïve\n', 'utf8') })
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
  rmSync(dir, { recursive: true, force: true })
})

ok('multiple hits in one file are all reported', () => {
  const dir = repo({ 'many.txt': Buffer.from('a\x00b\x00c\n') })
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /many\.txt:1:2: control byte 0x00/)
  assert.match(r.stderr, /many\.txt:1:4: control byte 0x00/)
  assert.match(r.stderr, /2 control byte\(s\) in 1 file\(s\)/)
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------- extension skips
for (const ext of ['png', 'jpg', 'gif', 'webp', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'wasm', 'jsonl']) {
  ok(`a .${ext} file with a raw control byte is skipped, not scanned`, () => {
    const dir = repo({ [`asset.${ext}`]: Buffer.from('junk\x00bytes') })
    const r = run(dir)
    assert.equal(r.status, 0, r.stderr)
    rmSync(dir, { recursive: true, force: true })
  })
}

// -------------------------------------------------------------- vendor skip
ok('a minified bundle under public/vendor/ is skipped', () => {
  const dir = repo({ 'syzygy/bridge/public/vendor/three.slim.min.js': Buffer.from('var x="\x00"') })
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
  rmSync(dir, { recursive: true, force: true })
})

ok('a plain (non-minified) file in public/vendor/ is still scanned', () => {
  const dir = repo({ 'syzygy/bridge/public/vendor/README.md': Buffer.from('notes\x00here\n') })
  const r = run(dir)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stderr, /README\.md:1:6: control byte 0x00/)
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------- .gitattributes
ok('git check-attr binary marking a custom extension is honored', () => {
  const dir = repo(
    { 'blob.dat': Buffer.from('junk\x00bytes') },
    '*.dat binary\n',
  )
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
  rmSync(dir, { recursive: true, force: true })
})

ok('a -text .gitattributes rule is honored the same way as an explicit binary one', () => {
  const dir = repo(
    { 'blob.weird': Buffer.from('junk\x00bytes') },
    '*.weird -text\n',
  )
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
  rmSync(dir, { recursive: true, force: true })
})

ok('.gitattributes does not exempt an unmatched extension in the same tree', () => {
  const dir = repo(
    { 'blob.dat': Buffer.from('ok'), 'plain.txt': Buffer.from('a\x00b\n') },
    '*.dat binary\n',
  )
  const r = run(dir)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stderr, /plain\.txt:1:2: control byte 0x00/)
  rmSync(dir, { recursive: true, force: true })
})

// --------------------------------------------------------------- edge cases
ok('a tracked symlink is skipped rather than followed', () => {
  const dir = repo({ 'target.txt': Buffer.from('a\x00b\n') })
  // The symlink's own tracked content is a path string, never file bytes;
  // scanning it would mean reading whatever it happens to point at.
  symlinkSync('target.txt', join(dir, 'link.txt'))
  gitIn(['add', '-A'], dir)
  const r = run(dir)
  // target.txt itself is still scanned and still fails -- only the link is skipped.
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stderr, /target\.txt:1:2: control byte 0x00/)
  assert.doesNotMatch(r.stderr, /link\.txt/)
  rmSync(dir, { recursive: true, force: true })
})

ok('a tracked path missing from the working tree is reported, not silently skipped', () => {
  const dir = repo({ 'gone.txt': 'still in the index\n' })
  unlinkSync(join(dir, 'gone.txt'))
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /could not read gone\.txt/)
  rmSync(dir, { recursive: true, force: true })
})

ok('an empty repository (no tracked files at all) passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'szg-check-bytes-empty-'))
  gitIn(['init', '-q'], dir)
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /0 tracked file\(s\) scanned/)
  rmSync(dir, { recursive: true, force: true })
})

console.log(`\n✔ check-bytes.py: ${pass} checks passed`)
