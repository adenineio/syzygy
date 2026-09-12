#!/bin/sh
# syzygy-pane.sh -- launcher for the Syzygy terminal side pane (Charm v2).
#
# Inside tmux it splits a side pane to the right of the current one and leaves
# focus where it was: the pane is for glancing, the user types into Claude.
# Outside tmux it creates the "syzygy" session with Claude on the left and the
# pane on the right, then attaches.
#
# It does not check whether the relay is up and does not care: the binary
# starts, paints WAITING FOR RELAY and connects with backoff. The plugin brings
# the relay up on session.start, so a Claude launched beside the pane makes it
# snap to live within seconds.
#
# Usage:
#   syzygy-pane.sh [claude args...]   split beside this pane / start a tmux session
#   syzygy-pane.sh --close            kill the side pane in this window
#   syzygy-pane.sh --toggle           close it if open, open it if not
#   syzygy-pane.sh --focus            move the cursor into the side pane
#   syzygy-pane.sh --build            build the binary and exit
#
# It assumes NOTHING from your tmux.conf. Everything it needs it sets on the
# pane it creates (border styles, remain-on-exit), and it targets panes by
# pane id rather than by index, so base-index and pane-base-index cannot move
# it. The one hard requirement is tmux >= 3.1, for `split-window -l` taking a
# percentage -- checked below with a message that names the version found.
# The README has the optional root binding for --toggle.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN=${SZG_PANE_BIN:-$SCRIPT_DIR/bin/syzygy-pane}

# The window option that records this window's side pane, so a re-run finds it.
OPT='@syzygy_pane'
SESSION=syzygy
WINDOW=claude

# Border colours, by ANSI name so the terminal's own scheme picks the shade
# (kept in step with internal/theme/palette.go, which is ANSI 0-15 only).
#
# There is deliberately no window-style: setting one would paint the pane's
# background with a colour of our own, which is exactly what the binary stopped
# doing so the pane could inherit the terminal's scheme. Do not add one back.
BORDER_ON='fg=yellow'
BORDER_OFF='fg=brightblack'

# `split-window -l 25%` needs tmux 3.1. Before that the flag was `-p` and `-l`
# took cells only, so an older tmux does not fail -- it silently makes a pane
# 25 CELLS wide, which reads as the pane being broken rather than as tmux being
# old. Check for it and say so.
require_tmux_31() {
  v=$(tmux -V 2>/dev/null | sed 's/^tmux //') || die "tmux is not installed"
  maj=$(printf '%s' "$v" | sed 's/[^0-9.].*$//' | cut -d. -f1)
  min=$(printf '%s' "$v" | sed 's/[^0-9.].*$//' | cut -d. -f2)
  [ -n "$maj" ] || return 0            # an unparseable version: assume modern
  [ -z "$min" ] && min=0
  if [ "$maj" -lt 3 ] || { [ "$maj" -eq 3 ] && [ "$min" -lt 1 ]; }; then
    die "tmux $v is too old; the side pane needs 3.1 or newer"
  fi
}

MIN_WIDTH=60   # refuse to split a window narrower than this
MIN_PANE=30    # everything below 30 columns is the degraded strip
PCT=25

die() { echo "syzygy-pane: $*" >&2; exit 1; }

ensure_bin() {
  [ -x "$BIN" ] && return 0
  if command -v go >/dev/null 2>&1; then
    echo "syzygy-pane: building $BIN" >&2
    ( cd "$SCRIPT_DIR" && go build -o "$BIN" ./cmd/syzygy-pane ) || die "build failed"
  else
    die "binary missing and go is not on PATH; run: go build -o bin/syzygy-pane ./cmd/syzygy-pane"
  fi
}

# pane_size WINDOW_WIDTH -> the -l argument: a quarter, floored at 30 columns.
pane_size() {
  ww=$1
  quarter=$(( ww * PCT / 100 ))
  if [ "$quarter" -lt "$MIN_PANE" ]; then
    echo "$MIN_PANE"
  else
    echo "${PCT}%"
  fi
}

# split_beside ORIGIN_PANE START_DIR -> prints the new pane id
split_beside() {
  origin=$1
  startdir=$2
  # SZG_TARGET_PID overrides the pane's own shell pid. It exists for the case
  # where Claude is not a descendant of this pane's shell (a wrapper that
  # re-execs, a detached launch) and for testing the descendant walk.
  opid=${SZG_TARGET_PID:-$(tmux display-message -p -t "$origin" '#{pane_pid}')}
  ww=$(tmux display-message -p -t "$origin" '#{window_width}')
  [ "$ww" -lt "$MIN_WIDTH" ] && die "window is $ww columns; need >= $MIN_WIDTH"
  size=$(pane_size "$ww")

  # -h puts the pane to the right; -d leaves focus on Claude.
  #
  # Colour. The colorprofile package deliberately IGNORES $COLORTERM when $TERM
  # starts with "tmux" or "screen", so exporting COLORTERM=truecolor into the
  # pane is not on its own enough. Two things make up for it: the program asks
  # the terminal for the RGB/Tc capabilities at startup (tea.RequestCapability),
  # and, when the outer terminal already told us it is truecolor, we pin the
  # profile with SZG_COLOR and let tmux down-convert if its own
  # terminal-features say it must. COLORTERM is still exported because tmux and
  # other children look at it.
  szg_color=${SZG_COLOR:-}
  if [ -z "$szg_color" ] && [ "${COLORTERM:-}" = "truecolor" ]; then
    szg_color=truecolor
  fi

  tmux split-window -h -d -l "$size" -c "$startdir" \
    -e COLORTERM=truecolor \
    -e SZG_COLOR="$szg_color" \
    -e SZG_MODE="${SZG_MODE:-}" \
    -e SZG_TARGET_PANE="$origin" \
    -e SZG_TARGET_PID="$opid" \
    -P -F '#{pane_id}' \
    -t "$origin" \
    -- "$BIN" --target-pane "$origin"
}

style_pane() {
  new=$1
  tmux set-option -w -t "$new" pane-active-border-style "$BORDER_ON" 2>/dev/null || true
  tmux set-option -w -t "$new" pane-border-style "$BORDER_OFF" 2>/dev/null || true
  # A tmux.conf with `remain-on-exit on` leaves a dead pane sitting there when
  # the binary exits, which reads as a hang. Set it OFF on this pane only --
  # never globally, which would silently undo a deliberate personal setting.
  tmux set-option -p -t "$new" remain-on-exit off 2>/dev/null || true
}

pane_exists() {
  tmux list-panes -F '#{pane_id}' 2>/dev/null | grep -qx "$1"
}

existing_pane() {
  tmux show-options -wqv "$OPT" 2>/dev/null || true
}

cmd_close() {
  [ -n "${TMUX:-}" ] || die "not inside tmux"
  old=$(existing_pane)
  if [ -n "$old" ] && pane_exists "$old"; then
    tmux kill-pane -t "$old"
    tmux set-option -wu "$OPT" 2>/dev/null || true
    echo "closed"
  else
    echo "no pane"
  fi
}

cmd_focus() {
  [ -n "${TMUX:-}" ] || die "not inside tmux"
  old=$(existing_pane)
  if [ -n "$old" ] && pane_exists "$old"; then
    tmux select-pane -t "$old"
  else
    die "no pane to focus"
  fi
}

case "${1:-}" in
  # Close if there is a pane, open if there is not. Exists for a key binding:
  # a tmux root binding can reach this while the user is mid-prompt in Claude,
  # which the band's own hotkey cannot -- a band hotkey is a bare digit and
  # only fires on an EMPTY composer.
  --toggle)
    [ -n "${TMUX:-}" ] || die "not inside tmux"
    old=$(existing_pane)
    if [ -n "$old" ] && pane_exists "$old"; then
      tmux kill-pane -t "$old"
      tmux set-option -wu "$OPT" 2>/dev/null || true
      echo "closed"
      exit 0
    fi
    shift   # no pane: fall through to the normal open path
    ;;
  --close) cmd_close; exit 0 ;;
  --focus) cmd_focus; exit 0 ;;
  --build) ( cd "$SCRIPT_DIR" && go build -o "$BIN" ./cmd/syzygy-pane ) && echo "$BIN"; exit 0 ;;
esac

command -v tmux >/dev/null 2>&1 || die "tmux is not installed"
require_tmux_31
ensure_bin

if [ -n "${TMUX:-}" ]; then
  # ---- inside tmux: split beside the current pane ---------------------------
  origin=$(tmux display-message -p '#{pane_id}')
  verb=started
  old=$(existing_pane)
  if [ -n "$old" ] && pane_exists "$old"; then
    # A re-run means "restart the pane": new binary, new flags.
    tmux kill-pane -t "$old"
    verb=restarted
  fi
  new=$(split_beside "$origin" "$PWD")
  tmux set-option -w "$OPT" "$new"
  style_pane "$new"
  echo "$verb $new"
  exit 0
fi

# ---- outside tmux: the one-command start ----------------------------------
if tmux has-session -t "$SESSION" 2>/dev/null; then
  # A re-run outside tmux attaches; it never creates a second tmux session.
  exec tmux attach-session -t "$SESSION"
fi

tmux new-session -d -s "$SESSION" -n "$WINDOW" -c "$PWD" -- claude "$@"
origin=$(tmux display-message -p -t "$SESSION:$WINDOW" '#{pane_id}')
new=$(split_beside "$origin" "$PWD")
tmux set-option -w -t "$SESSION:$WINDOW" "$OPT" "$new"
style_pane "$new"
exec tmux attach-session -t "$SESSION"
