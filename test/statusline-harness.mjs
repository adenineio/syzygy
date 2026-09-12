#!/usr/bin/env node
// Drives scripts/statusline-syzygy.sh (as a real subprocess, its stdin/stdout
// and its side-channel writes) and scripts/statusline-install.mjs (its pure
// planInstall/shellQuote/looksWrapped, plus the CLI against a throwaway
// settings file). Hermetic: every path is a temp directory, and
// SZG_SETTINGS_FILE / SZG_STATUSLINE_DIR mean neither script ever touches the
// real ~/.claude/settings.json or ~/.claude/syzygy/statusline. Run:
// node test/statusline-harness.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const WRAPPER = join(ROOT, 'scripts', 'statusline-syzygy.sh')
const INSTALLER = join(ROOT, 'scripts', 'statusline-install.mjs')
const { planInstall, shellQuote, looksWrapped, WRAPPER_PATH } = await import(join(ROOT, 'scripts', 'statusline-install.mjs'))

let pass = 0
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label) }
const dir = mkdtempSync(join(tmpdir(), 'szg-statusline-'))

// ======================================================================
// scripts/statusline-syzygy.sh -- a real subprocess, never the real
// ~/.claude/syzygy/statusline (SZG_STATUSLINE_DIR points at a temp
// dir every time).
// ======================================================================
const runWrapper = (input, args, envExtra = {}) => {
  const statusDir = join(dir, 'statusline-' + Math.random().toString(36).slice(2))
  const r = spawnSync(WRAPPER, args, {
    input,
    encoding: 'utf8',
    env: { ...process.env, SZG_STATUSLINE_DIR: statusDir, ...envExtra },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, statusDir }
}

ok('reads a real drop\'s JSON on stdin, hands the SAME content to the wrapped command, and side-channels it', () => {
  const drop = JSON.stringify({ session_id: 'sess-1', rate_limits: { five_hour: { used_percentage: 10, resets_at: 1 } }, extra: 'kept' })
  const r = runWrapper(drop, ['cat']) // the wrapped command echoes stdin back
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, drop, 'the wrapped command must see the exact same stdin')
  const written = JSON.parse(readFileSync(join(r.statusDir, 'sess-1.json'), 'utf8'))
  assert.equal(written.extra, 'kept', 'the whole object rides along, not just the fields usage.mjs reads')
  assert.equal(written.rate_limits.five_hour.used_percentage, 10)
  assert.equal(typeof written.szg_written_at, 'number', 'the freshness stamp is added')
  assert.deepEqual(readdirSync(r.statusDir), ['sess-1.json'], 'no temp file left behind')
})

ok('a malformed JSON drop never breaks the exec: no file written, the wrapped command still runs, exit 0', () => {
  const r = runWrapper('not even json', ['echo still-ran'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'still-ran')
  assert.equal(existsSync(r.statusDir) && readdirSync(r.statusDir).length > 0, false, 'mkdir -p is unconditional and harmless; nothing must be WRITTEN into it')
})

ok('a drop with no session_id: no file written, exec still happens', () => {
  const r = runWrapper(JSON.stringify({ rate_limits: {} }), ['echo ok'])
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), 'ok')
})

ok('no wrapped command at all: exits clean with nothing on stdout, never an error', () => {
  const r = runWrapper(JSON.stringify({ session_id: 'x' }), [])
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '')
})

ok('a python3 that always fails does not stop the wrapped command from running', () => {
  const fakeBinDir = join(dir, 'fakebin')
  mkdirSync(fakeBinDir, { recursive: true })
  writeFileSync(join(fakeBinDir, 'python3'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(fakeBinDir, 'python3'), 0o755)
  const r = runWrapper(JSON.stringify({ session_id: 'y', rate_limits: {} }), ['echo exec-still-fine'], {
    PATH: `${fakeBinDir}:${process.env.PATH}`,
  })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'exec-still-fine')
  assert.equal(existsSync(r.statusDir) && readdirSync(r.statusDir).length > 0, false, 'the failing python3 must leave the directory empty')
})

ok('the wrapped command can itself be a multi-word shell command line, exactly as settings.json would store one', () => {
  const r = runWrapper(JSON.stringify({ session_id: 'z' }), ['echo hello && echo world'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, 'hello\nworld\n')
})

// ======================================================================
// scripts/statusline-install.mjs -- pure functions
// ======================================================================

ok('shellQuote wraps in single quotes and escapes an embedded quote', () => {
  assert.equal(shellQuote('plain'), "'plain'")
  assert.equal(shellQuote("it's got a quote"), "'it'\\''s got a quote'")
})

ok('looksWrapped matches by basename, tolerates a non-string, and is false for an ordinary command', () => {
  assert.equal(looksWrapped('/anywhere/scripts/statusline-syzygy.sh \'x\''), true)
  assert.equal(looksWrapped('bash ~/.claude/statusline-command.sh'), false)
  assert.equal(looksWrapped(undefined), false)
  assert.equal(looksWrapped(42), false)
})

ok('planInstall refuses when there is no statusLine.command to wrap', () => {
  const noSettings = planInstall({}, '/wrapper')
  assert.equal(noSettings.ok, false)
  assert.match(noSettings.reason, /no statusLine\.command/)
  const blank = planInstall({ statusLine: { command: '   ' } }, '/wrapper')
  assert.equal(blank.ok, false)
  assert.match(blank.reason, /no statusLine\.command/)
})

ok('planInstall refuses a command that already looks wrapped', () => {
  const settings = { statusLine: { type: 'command', command: '/x/statusline-syzygy.sh \'orig\'' } }
  const plan = planInstall(settings, '/wrapper')
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /already runs statusline-syzygy\.sh/)
})

ok('planInstall wraps the existing command and keeps every other key untouched', () => {
  const settings = { model: 'opus', statusLine: { type: 'command', command: 'bash ~/.claude/statusline-command.sh' }, tui: { x: 1 } }
  const plan = planInstall(settings, '/repo/scripts/statusline-syzygy.sh')
  assert.equal(plan.ok, true)
  assert.equal(plan.wrapped, 'bash ~/.claude/statusline-command.sh')
  assert.equal(plan.next.statusLine.command, "/repo/scripts/statusline-syzygy.sh 'bash ~/.claude/statusline-command.sh'")
  assert.equal(plan.next.statusLine.type, 'command', 'other statusLine keys survive')
  assert.equal(plan.next.model, 'opus')
  assert.deepEqual(plan.next.tui, { x: 1 })
})

ok('WRAPPER_PATH resolves to the sibling statusline-syzygy.sh', () => {
  assert.equal(WRAPPER_PATH, WRAPPER)
})

// ======================================================================
// scripts/statusline-install.mjs -- the CLI, against a throwaway settings
// file. SZG_SETTINGS_FILE means the real ~/.claude/settings.json is never
// touched by this harness.
// ======================================================================
const runInstaller = (settingsPath) =>
  spawnSync(process.execPath, [INSTALLER], { encoding: 'utf8', env: { ...process.env, SZG_SETTINGS_FILE: settingsPath } })

ok('the CLI refuses when the settings file does not exist at all', () => {
  const f = join(dir, 'missing.json')
  const r = runInstaller(f)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no .* found/)
})

ok('the CLI refuses on unparseable JSON, leaving the file untouched', () => {
  const f = join(dir, 'bad.json')
  writeFileSync(f, '{not json')
  const r = runInstaller(f)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /did not parse/)
  assert.equal(readFileSync(f, 'utf8'), '{not json')
})

ok('the CLI wraps a real settings file atomically, leaving no temp file, preserving other keys', () => {
  const f = join(dir, 'settings.json')
  writeFileSync(f, JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: 'bash ~/.claude/statusline-command.sh' } }))
  const r = runInstaller(f)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /wrapped/)
  assert.equal(existsSync(f + '.tmp'), false)
  const written = JSON.parse(readFileSync(f, 'utf8'))
  assert.equal(written.model, 'opus')
  assert.equal(written.statusLine.command, `${WRAPPER} 'bash ~/.claude/statusline-command.sh'`)
})

ok('the CLI refuses a second run against an already-wrapped file', () => {
  const f = join(dir, 'settings2.json')
  writeFileSync(f, JSON.stringify({ statusLine: { command: 'bash ~/.claude/statusline-command.sh' } }))
  runInstaller(f)
  const r2 = runInstaller(f)
  assert.equal(r2.status, 1)
  assert.match(r2.stderr, /already runs statusline-syzygy\.sh/)
})

rmSync(dir, { recursive: true, force: true })
console.log(`\nstatusline harness: ${pass} checks passed`)
