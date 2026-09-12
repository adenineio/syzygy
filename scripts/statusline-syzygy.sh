#!/usr/bin/env bash
# Wraps a Claude Code `statusLine` command with the usage-window side-channel
# Installed by `just statusline-install`, never by hand -- it rewrites
# ~/.claude/settings.json's `statusLine.command` to:
#
#   <this script's absolute path> '<the original command, verbatim>'
#
# so the original command keeps running exactly as it did before, and a
# session whose settings were never touched by `statusline-install` is
# completely unaffected: this file does nothing unless something points a
# `statusLine` setting at it.
#
# THE TEE PATTERN. Claude Code pipes one JSON object to `statusLine` on
# stdin per render and reads its stdout as the line to print. stdin can only
# be read once, so this reads it all into a variable up front, then hands
# that SAME content on to the wrapped command via process substitution on
# the final `exec` -- not a here-string (`<<<`), which silently APPENDS a
# newline the original stdin may not have had, and this must reproduce the
# original byte for byte. `exec` so this process is replaced by the wrapped
# command rather than lingering as a shim, and so its exit status and
# stdout become the wrapped command's, unchanged.
#
# EVERY FAILURE IN THE SIDE-CHANNEL HALF IS SWALLOWED. A status line is the
# one thing rendered on screen every single turn; this script must never be
# able to break it -- not a missing directory, not a payload with no
# `session_id`, not `python3` missing from PATH entirely. The side-channel
# write is wrapped in its own block with output and errors discarded, and
# nothing in it is allowed to affect the `exec` below either way.
set -uo pipefail

input="$(cat)"

{
  dir="${SZG_STATUSLINE_DIR:-$HOME/.claude/syzygy/statusline}"
  mkdir -p "$dir"

  # A minimal, tolerant JSON reshape: pull `session_id` out to name the file,
  # and stamp `szg_written_at` (the freshness clock, in seconds like every
  # other timestamp in the drop) onto a COPY of the whole object -- not just
  # the fields usage.mjs reads, because the point of this side-channel is
  # the same one the user's own script already serves: whatever else a
  # future consumer wants is sitting right there too. python3 is already a
  # dependency of this project's own tooling (see the justfile's *-status
  # recipes), so it costs nothing new here.
  session_id="$(printf '%s' "$input" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("session_id", ""))
except Exception:
    pass
')"

  if [ -n "$session_id" ]; then
    tmp="$dir/.$session_id.json.tmp.$$"
    printf '%s' "$input" | python3 -c '
import json, sys, time
try:
    d = json.load(sys.stdin)
    d["szg_written_at"] = int(time.time())
    sys.stdout.write(json.dumps(d))
except Exception:
    pass
' > "$tmp"
    # Only replace the real file with a write that actually produced
    # something -- an empty temp file (the python3 step failed or python3
    # itself is missing) must never truncate a good prior reading to empty.
    if [ -s "$tmp" ]; then
      mv -f "$tmp" "$dir/$session_id.json"
    fi
    rm -f "$tmp"
  fi
} >/dev/null 2>&1

# Nothing to wrap (installed against an empty command somehow) -- print
# nothing and exit clean rather than error out onto the user's screen.
if [ "$#" -eq 0 ]; then
  exit 0
fi

# `sh -c "$1"`, not `"$1"` as an argv0: the ORIGINAL statusLine value is a
# shell command line as Claude Code's settings.json stored it (may itself be
# a pipeline, may carry arguments), not necessarily a single executable, so
# it has to be handed to a shell to interpret exactly as Claude Code itself
# would have.
exec sh -c "$1" < <(printf '%s' "$input")
