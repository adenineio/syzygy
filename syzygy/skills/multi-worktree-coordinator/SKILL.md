---
name: multi-worktree-coordinator
description: Use when the user wants several features, fixes, or plans implemented in parallel — "implement these in parallel", "split this into separate plans and build them simultaneously", "fan these out to worktrees/sessions" — or when a planning conversation has produced multiple independent workstreams that should be built at the same time and merged back on approval. Applies even if the user doesn't mention worktrees, tmux, or sessions explicitly.
---

# Multi-worktree coordinator

Turn a set of requested features into parallel implementation: one plan per
feature, one git worktree and one named Claude Code session per plan, running in
tiled tmux panes, coordinated over cross-session messaging, and merged back by a
dedicated merge-coordinator session **only on the user's explicit approval**.

You — the session reading this — are the **orchestrator**. The mechanical work is
scripted: `scripts/mwc.sh`, relative to this skill's own base directory, creates
the worktrees, the panes and the sessions correctly. Your job is the judgement:
the split, the plans, the kickoff, the handoff.

Announce: "Using syzygy:multi-worktree-coordinator to parallelize <features>."

What the script needs: `bash`, `git`, `tmux`, and a Claude Code with `--name` and
cross-session messaging (`ListAgents` / `SendMessage`) — 2.1.224 or newer. It
needs nothing else at run time: no node, no relay, no build step.

## When NOT to use

- One feature → plain `superpowers:writing-plans` and
  `superpowers:executing-plans`.
- Steps that depend on each other's output → sequential work. Parallel sessions
  would only sit waiting on each other.
- Small independent chores that do not need whole sessions →
  `superpowers:dispatching-parallel-agents`, which runs subagents inside this
  session instead.

## Workflow

### 1. Propose the split — GATE: user approval

Group the requested features into right-sized plans:

- One plan per independent feature or subsystem. Fold a trivial adjacent tweak
  into the plan it is closest to — a two-line change does not deserve its own
  worktree and session.
- Right-sized means one session can finish it without waiting on a sibling
  part-way through.
- Give each plan a short kebab-case name (`auth-redesign`, `rate-limiter`). That
  one name becomes the branch (`feature/<name>`), the worktree
  (`.worktrees/<name>`), the session name and the plan file — one name, four
  uses.
- Declare the shared touchpoints now rather than meeting them at merge time:
  every file more than one plan must edit, and every cross-plan interface
  (function names, types, config keys). Give each shared file one owning plan
  where you can; where an overlap is unavoidable, say which plans collide and
  what the conflict will look like. This is what makes the merges boring.

Present the split to the user: the plan names with a one-line scope each, the
shared-file and interface notes, and the base branch (default: the current
branch). Get explicit approval — `AskUserQuestion` works well here. Write no
plan documents before that approval: the split itself is the decision worth
their attention.

### 2. Write the plans

For each approved plan — REQUIRED SUB-SKILL: `superpowers:writing-plans`. Save
into `docs/plans/<name>.md`, which is this workflow's location and overrides
that skill's own default path. Without that skill available, write the same
document by hand: numbered steps, and an Interfaces block.

Put the cross-plan contracts from step 1 in those Interfaces
(Consumes/Produces) blocks. A worker sees only its own plan, so a contract that
is not written inside it does not reach the session that has to honour it.

Then commit the plan documents to the base branch:

```
git add docs/plans && git commit -m "plans: <name1> <name2> ..."
```

A worktree branches from committed state, so an uncommitted plan simply does not
exist inside the worker that is supposed to read it.

### 3. Launch

```
<skill-base-dir>/scripts/mwc.sh launch <name1> <name2> ...
```

Flags: `--base <branch>` (default: the current branch), `--model <model>`
(default: `opus`), `--permission-mode <mode>` (default: `bypassPermissions` —
full autonomy inside an isolated worktree, reviewed at merge time; pass
`acceptEdits`, or anything else, to tighten it).

The script exists because hand-rolling this gets the details wrong. Worktrees go
under a gitignored `.worktrees/`, each on `feature/<name>` off the base. ONE tmux
window holds a merge-coordinator pane in the main checkout plus a tiled pane per
worker in its own worktree. Every session launches with `--name`, so messaging
can reach it, and with the orchestrator's own session-identity environment
(`CLAUDE_CODE_SESSION_ID` and its siblings) stripped — a leaked session id makes
a worker write into YOUR transcript. Each session boots on a generated briefing
file carrying its identity, its plan path, the commit discipline, the no-merge
rule and the message vocabulary below, so a pane restarted by hand reads the
same instructions.

If you were not inside tmux, the script prints the attach command. Pass it on to
the user so they can watch the panes.

### 4. Kick off

1. `ListAgents` until every worker name and `merge-coordinator` appear. Sessions
   take a few seconds to register — retry briefly rather than assuming.
2. `SendMessage` each worker: `BEGIN`, plus anything learned since planning
   ("expect a conflict with rate-limiter in server.js — your Interfaces block
   has the contract").
3. `SendMessage` `merge-coordinator`: the roster, your preferred merge order, and
   the shared-file conflicts you expect from step 1.

Workers answer by session name automatically — a reply routes on the message's
`from`. They report readiness first and implement on `BEGIN`.

### 5. Hand off and stand down

The merge-coordinator session owns everything after kickoff. It collects
`DONE`/`BLOCKED`, verifies each branch on disk — commits present, worktree clean,
never prose alone — **asks the user for merge approval in its own pane**, merges
sequentially into the base with the tests run after each merge, and calls
`mwc.sh cleanup` once it is green.

That approval happens there, not here, and nothing merges without it. Tell the
user so: "Workers are running — the merge-coordinator pane will ask you before
anything merges." Your remaining role is relay. Workers may message you
questions; surface anything that needs the user's own decision.

## Messaging protocol

Written into the generated briefs already. Here for your reference:

| Message | From → To | Meaning |
|---|---|---|
| `BEGIN` | orchestrator → worker | implement your plan now |
| `DONE <name> — <summary>` | worker → merge-coordinator | plan complete, tests pass |
| `BLOCKED <name>: <reason>` | worker → merge-coordinator | stuck; needs guidance or user input |

## Don't substitute the machinery

Each of these is a natural improvisation, and each of them breaks something this
workflow relies on:

| Tempting alternative | Why not here |
|---|---|
| `claude --worktree` / `EnterWorktree` | isolates ONE session under `.claude/worktrees/`, off the repository's default branch — not N tiled workers off the current branch |
| a session-driver framework | a whole other coordination model: a tmux session per worker, event files polled for state, its own consent gate. Native `SendMessage` already IS the coordination layer |
| status files and polling loops | a cross-session message queues even while its recipient is mid-task, and the coordinator keeps the `DONE` checklist — there is no per-run infrastructure to build |
| hand-rolled `git worktree add` plus panes | forgets the `.worktrees` ignore commit, the environment stripping, the tiled layout and the collision checks. The script is exactly those details |

## Failure notes

- A worker pane died, or its session is gone: the worktree and its commits
  survive on disk. The user can rerun the pane's command, or `claude --resume`
  there.
- A name never appears in `ListAgents` (give it ~30s): look at its pane, where
  `claude` has most likely failed to launch.
- `BLOCKED`: the coordinator surfaces it. Unblock the worker with `SendMessage`,
  or the user can type into its pane directly.
- A conflict beyond the expected ones at merge time: the coordinator stops and
  asks the user. That is the intent, not a failure.
- Abandoning a run without merging: `mwc.sh cleanup --force <names...>`.

## Script quick reference

| Command | Does |
|---|---|
| `mwc.sh launch [--base <b>] [--model <m>] [--permission-mode <pm>] <names...>` | the worktrees, one tmux window, the named sessions, the briefing files |
| `mwc.sh cleanup [--force] <names...>` | remove the worktrees, delete the feature branches |
| `mwc.sh status` | list the worktrees, the feature branches and the live panes |
