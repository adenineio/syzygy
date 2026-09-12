#!/usr/bin/env node
// `just statusline-install` -- wires scripts/statusline-syzygy.sh
// into ~/.claude/settings.json's `statusLine.command`, preserving whatever
// command was already there as the thing the wrapper `exec`s into.
//
// NON-DESTRUCTIVE and narrowly scoped: only `statusLine.command` is ever
// changed. Every other key -- permissions, model, tui, everything -- is
// read, kept, and written back with the same value (re-serializing the file
// does not preserve exact whitespace or key order, only every value; noted
// at the write site rather than pretended away). Refuses outright, rather
// than guessing, when there is no existing `statusLine.command` to wrap or
// when the command already looks wrapped -- see planInstall below, which is
// the whole decision and takes no filesystem action itself.
//
// SZG_SETTINGS_FILE overrides the target path. Used ONLY by
// test/statusline-harness.mjs, which must never touch the real, shared
// ~/.claude/settings.json; production never sets it.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
export const WRAPPER_PATH = join(HERE, 'statusline-syzygy.sh')
export const SETTINGS_FILE = process.env.SZG_SETTINGS_FILE || join(homedir(), '.claude', 'settings.json')

/** Single-quotes a string for safe use as ONE shell argument: close the
 *  quote, emit an escaped literal quote, reopen it -- the standard POSIX
 *  trick (`'` -> `'\''`), needed because the wrapped command may itself
 *  contain a quote. */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** True once a command line already runs THIS wrapper -- matched by
 *  basename, not the full path, so a checkout at a different location (or a
 *  test's own copy of the script) is still recognised as already-wrapped. */
export const looksWrapped = (command) => typeof command === 'string' && command.includes('statusline-syzygy.sh')

/** The whole decision, pure: given the parsed settings and the wrapper's
 *  path, what (if anything) should be written. Refuses with a `reason`
 *  rather than throwing, so the CLI below can print it and exit 1 without
 *  a stack trace -- this is an expected outcome, not a bug. */
export const planInstall = (settings, wrapperPath) => {
  const command = settings?.statusLine?.command
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, reason: 'no statusLine.command found in settings.json -- set one up first, then re-run this' }
  }
  if (looksWrapped(command)) {
    return { ok: false, reason: 'statusLine.command already runs statusline-syzygy.sh -- refusing to wrap a wrapper' }
  }
  const next = {
    ...settings,
    statusLine: { ...settings.statusLine, command: `${wrapperPath} ${shellQuote(command)}` },
  }
  return { ok: true, next, wrapped: command }
}

// ---------------------------------------------------------------- CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  let settings = {}
  if (existsSync(SETTINGS_FILE)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    } catch (e) {
      process.stderr.write(`statusline-install: ${SETTINGS_FILE} did not parse as JSON (${e.message}) -- refusing to touch it\n`)
      process.exit(1)
    }
  } else {
    process.stderr.write(`statusline-install: no ${SETTINGS_FILE} found -- nothing to wrap\n`)
    process.exit(1)
  }

  const plan = planInstall(settings, WRAPPER_PATH)
  if (!plan.ok) {
    process.stderr.write(`statusline-install: ${plan.reason}\n`)
    process.exit(1)
  }

  // Same atomic temp-then-rename every authoritative store in this project
  // uses (requests.mjs, claims.mjs, after-reset.mjs). This file is the
  // user's own Claude Code settings, not ours, so the bar is at least that
  // high: serialize first, then rename over the target, never write the
  // target directly.
  const text = JSON.stringify(plan.next, null, 2) + '\n'
  const tmp = SETTINGS_FILE + '.tmp'
  writeFileSync(tmp, text)
  renameSync(tmp, SETTINGS_FILE)
  process.stdout.write(`statusline-install: wrapped "${plan.wrapped}" with ${WRAPPER_PATH}\n`)
}
