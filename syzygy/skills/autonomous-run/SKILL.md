---
name: autonomous-run
description: Use when told to run autonomously, unattended, or "while I'm away" — takes a goal from spec through plan to implementation in a fresh worktree without check-ins, deciding every ruling from project context and logging each one with its tradeoffs, the alternatives not taken, and a rollback commit so nothing is lost.
---

# Autonomous run

The user is stepping away and has handed you a goal, not a spec. Everything
below exists to make that safe: you decide, you log why, and every ruling
carries a way back.

## 1. Isolate first

A worktree and a branch of your own, via `superpowers:using-git-worktrees` or
`EnterWorktree`. Never the user's own checkout, never a branch switch in a shared
one — an unattended run that touches the wrong tree cannot be stopped by
anyone watching.

## 2. Then the normal arc

`superpowers:brainstorming` → a spec in `docs/specs/` → `superpowers:writing-plans`
into `docs/plans/` → implement. Obey the repository's own conventions file,
if it has one —
the three checkbox states, `just plan-reported` for your own work, and
**never `[x]` on your own work**: that state is reserved for a reviewer, and
nobody is watching this run to be one.

## 3. Do not stop to ask

Where a question would block, decide it from project context and what you
know of their preferences, and log the ruling (see below). Stop and ask only for
something **irreversible or outward-facing**: a push, a publish, a delete, a
credential, anything that leaves the machine. Ask by ending the turn with the
question — the needs-me indicator catches that, so it is the one channel back
to someone who is not watching the terminal.

## 4. The rulings log, written as you go, never reconstructed at the end

`docs/decisions/<YYYY-MM-DD>-<slug>-autonomous-rulings.md`. One `##` section
per ruling, in this shape:

```markdown
## <the question, as a question>

**Chose:** <what you did>
**Why:** <the reason, from project context or a stated preference>
**Tradeoff:** <what this costs>
**Not taken:** <each alternative, and what exploring it would mean>
**Roll back to:** <the commit BEFORE this ruling took effect>
```

The rollback commit is the point of the log: the user can branch from it and
take a different path. Record it before you act, not after — a ruling written
after the fact is a rationalization, and the commit it names may already have
moved.

## 5. Budget

Skip reviewer subagents unless something is clearly broken. This run spends
the same budget the user is on, and a reviewer round nobody asked for is not
free.

## 6. Finish

Run `just verify` (or the project's gate), then make your final message the
rulings summary — every ruling, its tradeoff, its alternatives. That message
is what the user reads in the terminal and in the pane's last-message view,
so it is the deliverable, not a sign-off.
