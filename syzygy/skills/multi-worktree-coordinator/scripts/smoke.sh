#!/usr/bin/env bash
# smoke.sh -- drives mwc.sh end to end against nothing real: a scratch git
# repository in a temp directory (its path carries a space on purpose), a stub
# binary standing in for `claude` that records its argv and environment, and a
# tmux server of its own on a private socket. It cleans up after itself,
# whether it passes or fails.
#
#   MWC_SMOKE_SOCKET   the tmux socket name to use (default: mwc-smoke-<pid>,
#                      so two runs at once cannot collide)
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mwc="$here/mwc.sh"
sock="${MWC_SMOKE_SOCKET:-mwc-smoke-$$}"
tmp_base="${TMPDIR:-/tmp}"
work=$(mktemp -d "${tmp_base%/}/mwc-smoke.XXXXXX")
# Where mwc.sh writes its briefing files for a repository whose basename
# slugifies to `scratch-repo`. It sits outside $work, so it is removed here
# by name.
briefs="${tmp_base%/}/mwc-scratch-repo"

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }

cleanup() {
  command tmux -u -L "$sock" kill-server 2>/dev/null || true
  # kill-server leaves the socket file itself behind, and it is ours: the
  # default name carries this process's own pid.
  rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$sock"
  rm -rf "$work" "$briefs"
}
trap cleanup EXIT

# --- the scratch repository -------------------------------------------------
repo="$work/scratch repo"
mkdir -p "$repo/docs/plans"
git -C "$repo" init -q -b develop
# A repository-local identity and no signing, so the run does not depend on
# what the caller's own git configuration happens to say -- mwc.sh makes a
# commit of its own for the .worktrees ignore line.
git -C "$repo" config user.email smoke@example.invalid
git -C "$repo" config user.name smoke
git -C "$repo" config commit.gpgsign false
git -C "$repo" commit -q --allow-empty -m init
printf '# plan alpha\n' > "$repo/docs/plans/alpha.md"
printf '# plan beta\n'  > "$repo/docs/plans/beta.md"
git -C "$repo" add -A
git -C "$repo" commit -q -m plans

# --- the stub binary --------------------------------------------------------
stub_out="$work/out"
mkdir -p "$stub_out"
stub="$work/claude-stub"
cat > "$stub" <<'STUB'
#!/usr/bin/env bash
out="$MWC_STUB_OUT/stub-$$.log"
{
  printf 'ARGS:'; printf ' %s' "$@"; printf '\n'
  printf 'SESSION_ID=%s\n' "${CLAUDE_CODE_SESSION_ID-unset}"
  printf 'SSE_PORT=%s\n' "${CLAUDE_CODE_SSE_PORT-unset}"
  printf 'CHILD=%s\n' "${CLAUDE_CODE_CHILD_SESSION-unset}"
} > "$out"
sleep 30
STUB
chmod +x "$stub"

export MWC_STUB_OUT="$stub_out"
export MWC_CLAUDE_BIN="$stub"
export MWC_TMUX_SOCKET="$sock"
# Orchestrator-identity variables. mwc.sh has to strip these before it starts a
# session, or a worker writes into the orchestrator's transcript.
export CLAUDE_CODE_SESSION_ID="stub-orchestrator-session"
export CLAUDE_CODE_SSE_PORT="12345"

# --- launch -----------------------------------------------------------------
echo "smoke: launch"
( cd "$repo" && bash "$mwc" launch alpha beta )

[[ -d "$repo/.worktrees/alpha" ]] || fail "worktree alpha missing"
[[ -d "$repo/.worktrees/beta"  ]] || fail "worktree beta missing"
pass "worktrees created"
git -C "$repo" show-ref --verify -q refs/heads/feature/alpha || fail "branch feature/alpha missing"
git -C "$repo" show-ref --verify -q refs/heads/feature/beta  || fail "branch feature/beta missing"
pass "feature branches created"
git -C "$repo" check-ignore -q .worktrees || fail ".worktrees is not gitignored"
pass ".worktrees gitignored, and the ignore line committed"
[[ -f "$briefs/alpha.md" ]] || fail "worker brief missing"
[[ -f "$briefs/merge-coordinator.md" ]] || fail "coordinator brief missing"
grep -q 'feature/alpha' "$briefs/alpha.md" || fail "worker brief does not name its branch"
grep -q 'docs/plans/alpha.md' "$briefs/alpha.md" || fail "worker brief does not name its plan"
grep -q 'DONE' "$briefs/merge-coordinator.md" || fail "coordinator brief lacks the protocol"
grep -q 'approval' "$briefs/merge-coordinator.md" || fail "coordinator brief lacks the approval gate"
pass "briefs written"

panes=$(command tmux -u -L "$sock" list-panes -s -t "=mwc-scratch-repo" | wc -l | tr -d ' ')
[[ "$panes" == 3 ]] || fail "expected 3 panes, got $panes"
pass "3 panes: the coordinator and two workers"

# --- what reached the stub --------------------------------------------------
echo "smoke: waiting for the launches"
deadline=$((SECONDS + 20))
while :; do
  n=$(find "$stub_out" -name 'stub-*.log' 2>/dev/null | wc -l | tr -d ' ')
  [[ "$n" == 3 ]] && break
  (( SECONDS < deadline )) || fail "expected 3 launches, got $n"
  sleep 0.5
done
pass "3 launches"

coord_log=$(grep -l -- '--name merge-coordinator' "$stub_out"/stub-*.log) || fail "the coordinator launch is missing"
alpha_log=$(grep -l -- '--name alpha' "$stub_out"/stub-*.log) || fail "the alpha launch is missing"
grep -l -- '--name beta' "$stub_out"/stub-*.log >/dev/null || fail "the beta launch is missing"
pass "sessions named"
grep -q -- '--model opus' "$alpha_log" || fail "alpha was launched without --model opus"
grep -q -- '--permission-mode bypassPermissions' "$alpha_log" || fail "alpha was launched without the permission mode"
grep -qF "$briefs/alpha.md and follow it." "$alpha_log" || fail "alpha was launched without its brief"
grep -qF "$briefs/merge-coordinator.md and follow it." "$coord_log" || fail "the coordinator was launched without its brief"
pass "launch arguments correct"
if grep -h 'SESSION_ID=' "$stub_out"/stub-*.log | grep -qv 'SESSION_ID=unset'; then
  fail "CLAUDE_CODE_SESSION_ID reached a launched session"
fi
if grep -h 'SSE_PORT=' "$stub_out"/stub-*.log | grep -qv 'SSE_PORT=unset'; then
  fail "CLAUDE_CODE_SSE_PORT reached a launched session"
fi
pass "the orchestrator's session identity was stripped"

# --- a name already in use --------------------------------------------------
if ( cd "$repo" && bash "$mwc" launch alpha 2>/dev/null ); then
  fail "a second launch of an existing name was not refused"
fi
pass "name collision refused"

# --- cleanup ----------------------------------------------------------------
echo "smoke: cleanup"
( cd "$repo" && bash "$mwc" cleanup alpha beta )
[[ ! -d "$repo/.worktrees/alpha" ]] || fail "worktree alpha survived cleanup"
[[ ! -d "$repo/.worktrees/beta"  ]] || fail "worktree beta survived cleanup"
if git -C "$repo" show-ref --verify -q refs/heads/feature/alpha; then fail "branch feature/alpha survived cleanup"; fi
if git -C "$repo" show-ref --verify -q refs/heads/feature/beta; then fail "branch feature/beta survived cleanup"; fi
pass "cleanup removed the worktrees and the branches"

echo "SMOKE PASS"
