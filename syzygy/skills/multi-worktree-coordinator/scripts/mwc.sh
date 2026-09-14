#!/usr/bin/env bash
# mwc.sh -- the multi-worktree-coordinator skill's launcher.
#
# launch:  one git worktree per plan under .worktrees/ (branch feature/<name>
#          off the base branch), one tmux window with a tiled pane per worker
#          plus a merge-coordinator pane, and a named Claude Code session in
#          each of them.
# cleanup: remove those worktrees and delete their feature branches.
# status:  show the worktrees, the feature branches and the live panes.
#
# bash, git and tmux, and nothing else: no node, no build step, no task runner.
# The skill beside it drives it, and it also runs standalone.
#
# Test/override environment:
#   MWC_CLAUDE_BIN    the binary launched in the panes (default: claude)
#   MWC_TMUX_SOCKET   put every tmux call on `tmux -L <socket>` and always use
#                     a detached session, so a test run cannot reach the
#                     server the user is sitting in front of
set -euo pipefail

CLAUDE_BIN="${MWC_CLAUDE_BIN:-claude}"

die()  { echo "mwc: error: $*" >&2; exit 1; }
warn() { echo "mwc: warn: $*" >&2; }
info() { echo "mwc: $*"; }

# -u on every call, deliberately. Without it, a locale that is not UTF-8 gets
# the separators of a `-F` format printed back as underscores; tmux still exits
# 0, and a listing that should have rows parses to nothing at all.
tmx() {
  if [[ -n "${MWC_TMUX_SOCKET:-}" ]]; then
    command tmux -u -L "$MWC_TMUX_SOCKET" "$@"
  else
    command tmux -u "$@"
  fi
}

usage() {
  cat >&2 <<'EOF'
usage:
  mwc.sh launch [--base <branch>] [--model <model>] [--permission-mode <mode>] <name>...
      Create .worktrees/<name> on branch feature/<name> off <branch> (default:
      the current branch), open one tmux window with a pane per worker plus a
      merge-coordinator pane, and launch a named Claude Code session in each.
      Defaults: --model opus, --permission-mode bypassPermissions.
  mwc.sh cleanup [--force] <name>...
      Remove .worktrees/<name> and delete feature/<name>. Without --force it
      refuses a dirty worktree and an unmerged branch.
  mwc.sh status
      Show the worktrees, the feature branches and the live panes.
EOF
  exit 2
}

slugify() { printf '%s' "$1" | tr -cs 'a-zA-Z0-9' '-' | sed 's/^-//; s/-$//'; }

# ---------------------------------------------------------------- briefs ----

write_worker_brief() {
  local name="$1" repo_root="$2" base="$3"
  cat <<EOF
# mwc worker brief: $name

You are Claude Code session "$name", one of several parallel implementation workers.

Facts:
- Your cwd is $repo_root/.worktrees/$name -- an isolated git worktree on branch feature/$name, branched from $base. You are ALREADY in an isolated workspace: skip any worktree or workspace setup step a skill asks you for.
- Your plan: docs/plans/$name.md, in this worktree.
- Sibling workers are editing the same project on other branches in other worktrees. Never modify a file outside your own worktree, and never switch branches.

Protocol:
1. Now: read your plan, then establish a clean baseline (install dependencies if the project needs them, then run the test suite). Reply with a one-line readiness report and WAIT for a BEGIN message from the orchestrator before you implement anything. Coordination arrives as cross-session messages; answer with SendMessage to the sender's name.
2. On BEGIN: implement the plan with the superpowers:executing-plans skill if you have it, and otherwise work the plan's steps in order. Commit as you go, exactly as those steps direct.
3. When every step is done and the test suite passes: do NOT merge, do NOT finish the branch, do NOT push. SendMessage to "merge-coordinator": "DONE $name -- <one-line summary; test status>". Then stay available; a merge-time follow-up may come back to you.
4. If you hit a hard blocker -- a failing baseline, a missing dependency, an ambiguous plan step -- SendMessage to "merge-coordinator": "BLOCKED $name: <reason>" and wait.
EOF
}

write_coordinator_brief() {
  local repo_root="$1" base="$2" roster="$3" script_path="$4" names="$5"
  cat <<EOF
# mwc merge-coordinator brief

You are Claude Code session "merge-coordinator" for a parallel implementation run in $repo_root (base branch: $base). Worker sessions are implementing these plans on these branches:

$roster
Your job, strictly in this order:
1. WAIT. Workers message you "DONE <name> -- ..." or "BLOCKED <name>: ..." as cross-session messages. Keep a checklist and acknowledge each message briefly. On BLOCKED, put it in front of the user in this session and await guidance. Do nothing else while you are waiting.
2. When ALL workers have reported DONE, verify on disk. Never take a report's word for it:
   - \`git log $base..feature/<name> --oneline\` is non-empty for each branch
   - \`git -C .worktrees/<name> status --porcelain\` shows no uncommitted source change
3. HARD GATE -- the user's approval: report what the verification found, in this session, and ask the user for explicit approval to merge. Merge nothing, for any reason, until the user answers here with an explicit yes. Merging is the one irreversible step of this workflow, and it is funnelled through that single decision on purpose.
4. On approval: make sure this checkout is on $base (\`git checkout $base\` if it is not), then merge sequentially. For each branch in roster order: \`git merge --no-ff feature/<name>\`, then run the project's own test command. On a conflict, resolve it yourself only where the resolution is obvious and the two branches' intents do not overlap, and say exactly what you did; otherwise stop and ask the user. On a test failure, stop and report: either fix forward here, or SendMessage the responsible worker to fix its branch and merge again.
5. When every branch is merged and the tests pass: run \`"$script_path" cleanup $names\` from $repo_root to remove the worktrees and delete the feature branches, then post a final summary and tell the user the worker panes can be closed.
EOF
}

# ---------------------------------------------------------------- launch ----

launch_in_pane() {
  local pane="$1" name="$2" model="$3" pmode="$4" brief="$5"
  local cmd
  # env -u: a pane inherits the orchestrator session's environment, and
  # CLAUDE_CODE_SESSION_ID there would make this worker write into the
  # orchestrator's own transcript. Strip the session-identity variables before
  # the binary starts.
  printf -v cmd 'env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_CHILD_SESSION %q --model %q --permission-mode %q --name %q %q' \
    "$CLAUDE_BIN" "$model" "$pmode" "$name" "Read $brief and follow it."
  tmx send-keys -t "$pane" -l "$cmd"
  tmx send-keys -t "$pane" Enter
}

cmd_launch() {
  local base="" model="opus" pmode="bypassPermissions"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --base) base="${2:?--base needs a value}"; shift 2 ;;
      --model) model="${2:?--model needs a value}"; shift 2 ;;
      --permission-mode) pmode="${2:?--permission-mode needs a value}"; shift 2 ;;
      --) shift; break ;;
      -*) usage ;;
      *) break ;;
    esac
  done
  [[ $# -gt 0 ]] || usage

  local repo_root
  repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"
  cd "$repo_root"
  local repo_slug
  repo_slug=$(slugify "$(basename "$repo_root")")

  if [[ -z "$base" ]]; then
    base=$(git branch --show-current)
    [[ -n "$base" ]] || die "detached HEAD -- pass --base <branch>"
  fi
  git show-ref --verify --quiet "refs/heads/$base" || die "base branch '$base' does not exist"
  command -v "$CLAUDE_BIN" >/dev/null 2>&1 || die "claude binary not found: $CLAUDE_BIN"
  command -v tmux >/dev/null 2>&1 || die "tmux not found"

  # Every refusal before anything is created: a half-launched run is worse than
  # one that never started.
  local name
  for name in "$@"; do
    [[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "invalid name '$name' (kebab-case only: a-z 0-9 -)"
    [[ "$name" != "merge-coordinator" ]] || die "'merge-coordinator' is a reserved name"
    if git show-ref --verify --quiet "refs/heads/feature/$name"; then die "branch feature/$name already exists"; fi
    [[ ! -e ".worktrees/$name" ]] || die ".worktrees/$name already exists"
    [[ -f "docs/plans/$name.md" ]] || warn "docs/plans/$name.md not found -- worker '$name' will have no plan to read"
  done

  if [[ -n "$(git status --porcelain)" ]]; then
    warn "working tree is dirty -- a worktree branches from the committed state of '$base' only"
  fi

  if ! git check-ignore -q .worktrees 2>/dev/null; then
    printf '.worktrees/\n' >> .gitignore
    git add .gitignore
    git commit -q -m "chore: gitignore .worktrees (mwc)" -- .gitignore
    info "added .worktrees/ to .gitignore (committed)"
  fi

  # Worktrees first, and roll back this run's own creations if one fails.
  local created=""
  for name in "$@"; do
    if ! git worktree add ".worktrees/$name" -b "feature/$name" "$base"; then
      warn "failed to create worktree '$name' -- rolling back this run"
      local n
      # shellcheck disable=SC2086
      for n in $created; do
        git worktree remove --force ".worktrees/$n" 2>/dev/null || true
        git branch -D "feature/$n" 2>/dev/null || true
      done
      die "launch aborted"
    fi
    created="$created $name"
  done

  # The briefing files, at a path a session can predict and re-read. Under
  # TMPDIR rather than a literal /tmp: a predictable name in a world-writable
  # directory is a name another account can take first.
  local tmp_base="${TMPDIR:-/tmp}"
  local brief_dir="${tmp_base%/}/mwc-$repo_slug"
  mkdir -p "$brief_dir"
  local script_path
  script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  local roster=""
  for name in "$@"; do
    roster="$roster- $name -> feature/$name (plan: docs/plans/$name.md)"$'\n'
  done
  for name in "$@"; do
    write_worker_brief "$name" "$repo_root" "$base" > "$brief_dir/$name.md"
  done
  write_coordinator_brief "$repo_root" "$base" "$roster" "$script_path" "$*" > "$brief_dir/merge-coordinator.md"

  # ONE tmux window: the first pane is the merge-coordinator in the main
  # checkout, then a pane per worker in its own worktree, with the tiled layout
  # re-applied after every split.
  local win_id attach_hint=""
  if [[ -n "${TMUX:-}" && -z "${MWC_TMUX_SOCKET:-}" ]]; then
    win_id=$(tmx new-window -P -F '#{window_id}' -n mwc -c "$repo_root")
  else
    local sess="mwc-$repo_slug"
    if tmx has-session -t "=$sess" 2>/dev/null; then
      die "tmux session '$sess' already exists -- attach to it or kill it first"
    fi
    # A fixed size, because a detached session defaults to 80x24, which is too
    # small to split N ways.
    tmx new-session -d -s "$sess" -n mwc -c "$repo_root" -x 220 -y 50
    win_id=$(tmx display-message -p -t "=$sess:mwc" '#{window_id}')
    attach_hint="tmux ${MWC_TMUX_SOCKET:+-L $MWC_TMUX_SOCKET }attach -t $sess"
  fi

  local first_pane
  first_pane=$(tmx display-message -p -t "$win_id" '#{pane_id}')
  launch_in_pane "$first_pane" "merge-coordinator" "$model" "$pmode" "$brief_dir/merge-coordinator.md"

  local pane_id
  for name in "$@"; do
    pane_id=$(tmx split-window -P -F '#{pane_id}' -t "$win_id" -c "$repo_root/.worktrees/$name")
    tmx select-layout -t "$win_id" tiled >/dev/null
    launch_in_pane "$pane_id" "$name" "$model" "$pmode" "$brief_dir/$name.md"
  done

  info "launched $# worker(s) plus merge-coordinator in tmux window $win_id"
  for name in "$@"; do
    info "  $name: .worktrees/$name (feature/$name off $base) -- session '$name'"
  done
  info "  merge-coordinator: $repo_root ($base) -- session 'merge-coordinator'"
  info "briefs: $brief_dir"
  [[ -z "$attach_hint" ]] || info "attach with: $attach_hint"
}

# --------------------------------------------------------------- cleanup ----

cmd_cleanup() {
  local force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force) force=1; shift ;;
      --) shift; break ;;
      -*) usage ;;
      *) break ;;
    esac
  done
  [[ $# -gt 0 ]] || usage
  local repo_root
  repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"
  cd "$repo_root"

  local name rc=0
  for name in "$@"; do
    if [[ -d ".worktrees/$name" ]]; then
      if (( force )); then
        git worktree remove --force ".worktrees/$name" || { warn "could not remove worktree '$name'"; rc=1; }
      elif ! git worktree remove ".worktrees/$name"; then
        warn "worktree '$name' has changes -- use --force"; rc=1; continue
      fi
    else
      warn "no worktree at .worktrees/$name"
    fi
    if git show-ref --verify --quiet "refs/heads/feature/$name"; then
      if (( force )); then
        git branch -D "feature/$name" || rc=1
      elif ! git branch -d "feature/$name"; then
        warn "branch feature/$name is not fully merged -- use --force"; rc=1
      fi
    fi
  done
  git worktree prune
  info "cleanup done"
  return "$rc"
}

# ---------------------------------------------------------------- status ----

cmd_status() {
  local repo_root
  repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"
  cd "$repo_root"
  echo "worktrees:"
  git worktree list | grep -F "/.worktrees/" || echo "  (none)"
  echo "feature branches:"
  git branch --list 'feature/*'
  echo "panes:"
  tmx list-panes -a -F '  #{session_name}:#{window_name}.#{pane_index}  #{pane_current_command}  #{pane_current_path}' 2>/dev/null \
    | grep -F "$repo_root" || echo "  (none)"
}

# ------------------------------------------------------------------ main ----

main() {
  [[ $# -ge 1 ]] || usage
  local sub="$1"
  shift
  case "$sub" in
    launch)  cmd_launch "$@" ;;
    cleanup) cmd_cleanup "$@" ;;
    status)  cmd_status "$@" ;;
    help|-h|--help) usage ;;
    *) usage ;;
  esac
}

main "$@"
