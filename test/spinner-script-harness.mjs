#!/usr/bin/env node
// Drives scripts/spinner.py as a real subprocess (invalid id refused, other
// keys preserved, atomic write, --ensure is non-destructive). Hermetic:
// SZG_HUD_CONFIG points every run at a temp file, so this never touches a
// developer's real ~/.claude/syzygy-hud-hotkeys.json. Same shape as
// test/statusline-harness.mjs, for a script under the same rule (Python via
// uv normally; a plain `python3` stdlib script is fine with no dependencies).
// Run: node test/spinner-script-harness.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'spinner.py')

let pass = 0
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label) }
const dir = mkdtempSync(join(tmpdir(), 'szg-spinner-script-'))

const run = (args, cfgPath) =>
  spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, SZG_HUD_CONFIG: cfgPath } })

// ---------------------------------------------------------------- --ensure
ok('--ensure writes the shipped default when nothing exists yet', () => {
  const cfg = join(dir, 'ensure-fresh.json')
  assert.equal(existsSync(cfg), false)
  const r = run(['--ensure'], cfg)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(existsSync(cfg), true)
  const doc = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.ok(Array.isArray(doc._readme) && doc._readme.length > 0, 'ships a _readme')
  assert.deepEqual(doc.settings, { spinnerPicker: false, pieStyle: 'moon' }, 'no spinner pinned by default')
  assert.equal(doc.hotkeys.length, 8, 'all eight slots present, most as empty templates')
})

ok('--ensure never overwrites a file already there', () => {
  const cfg = join(dir, 'ensure-existing.json')
  writeFileSync(cfg, JSON.stringify({ marker: 'do-not-touch', settings: { spinner: 'wisp' } }))
  const r = run(['--ensure'], cfg)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /already exists, left alone/)
  const doc = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.equal(doc.marker, 'do-not-touch')
  assert.equal(doc.settings.spinner, 'wisp')
})

// -------------------------------------------------------------------- --list
ok('--list prints every real id, and only real ids', () => {
  const r = run(['--list'], join(dir, 'unused-for-list.json'))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^tide\s+Wraith Tide$/m, 'the default id is listed with its name')
  assert.match(r.stdout, /^wisp\s+Will-o'-the-Wisp$/m)
  assert.equal(r.stdout.trim().split('\n').length, 22, 'the whole set, not a partial one')
})

// --------------------------------------------------------------- setting it
ok('a real id is written to settings.spinner, preserving every other field', () => {
  const cfg = join(dir, 'set-real.json')
  writeFileSync(cfg, JSON.stringify({
    _readme: ['keep me'],
    settings: { spinnerPicker: true, pieStyle: 'circle' },
    hotkeys: [{ key: '2', title: 't', short: 's', prompt: 'p' }],
  }))
  const r = run(['wisp'], cfg)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /spinner -> wisp/)
  assert.match(r.stdout, /next turn boundary/, 'says no restart is needed')
  const doc = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.deepEqual(doc._readme, ['keep me'], 'readme untouched')
  assert.deepEqual(doc.hotkeys, [{ key: '2', title: 't', short: 's', prompt: 'p' }], 'hotkeys untouched')
  assert.equal(doc.settings.spinnerPicker, true, 'other settings untouched')
  assert.equal(doc.settings.pieStyle, 'circle', 'other settings untouched')
  assert.equal(doc.settings.spinner, 'wisp')
})

ok('an unknown id is refused, and the file is left exactly as it was', () => {
  const cfg = join(dir, 'set-invalid.json')
  const before = { settings: { spinner: 'orrery' }, hotkeys: [] }
  writeFileSync(cfg, JSON.stringify(before))
  const r = run(['not-a-real-spinner'], cfg)
  assert.notEqual(r.status, 0, 'refuses with a non-zero exit')
  assert.match(r.stderr, /unknown spinner id/)
  assert.match(r.stderr, /valid ids:/, 'names what WOULD have worked')
  assert.deepEqual(JSON.parse(readFileSync(cfg, 'utf8')), before, 'file is untouched by a refused write')
})

ok('creates the file (via --ensure semantics) when setting a real id and none exists yet', () => {
  const cfg = join(dir, 'set-on-fresh.json')
  assert.equal(existsSync(cfg), false)
  const r = run(['orrery'], cfg)
  assert.equal(r.status, 0, r.stderr)
  const doc = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.equal(doc.settings.spinner, 'orrery')
  assert.ok(Array.isArray(doc._readme), 'still gets the shipped shape, not a bare {settings:{...}}')
})

ok('the write is atomic: no leftover temp file after a successful set', () => {
  const cfg = join(dir, 'set-atomic.json')
  run(['tide'], cfg)
  JSON.parse(readFileSync(cfg, 'utf8')) // just proves the target exists and parses
  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'))
  assert.deepEqual(leftovers, [], 'no .tmp file left behind in the config directory')
})

console.log(`\n✔ spinner.py: ${pass} checks passed`)
rmSync(dir, { recursive: true, force: true })
