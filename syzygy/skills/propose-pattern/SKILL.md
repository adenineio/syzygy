---
name: propose-pattern
description: Use when you notice this session doing something for the third time that a reusable skill would have done better — a shape, a sequence of steps, a kickoff prompt, a project instruction. Writes the pattern up as a candidate another session can be dispatched to build, and says plainly that proposing nothing is the normal outcome.
---

# Propose a pattern

## What this is for

A pattern worth a skill is something **repeated**, and a single session
usually cannot see repetition — which is why a pass over the whole board looks
for it too. You are the other half: you are inside the work, so you can see
the *methodology*, which the pass can only guess at.

## When not to use this

- Once. A pattern you have done one time is a task, not a pattern.
- For something you are about to build anyway.
- For an observation. "The relay is large" is not a pattern.
- To record a fact. That is `report_finding`, and it is a different store.

**Proposing nothing is the normal outcome of a session.** A session that
proposes a pattern every time is padding, and padding is what makes a queue
worthless.

## The write-up

Four things, and the third is the one that matters:

1. **Title** — one line, naming the pattern the way you would name a skill.
2. **Idea** — what the pattern is, in a sentence or two. What it is *for*.
3. **Methodology** — the **ordered steps somebody else could follow**, with no
   knowledge of this session. This is the part that turns a flag into a
   candidate. Write it as a numbered list, one step per line.
4. **Evidence** — at least one `path:line`, or the session and turn it came
   out of. A candidate nobody can check is one nobody will build.

Pick the kind: `skill` (a reusable skill to build), `shape` (a better shape for
something that already exists), `kickoff` (a prompt worth keeping),
`claude-md` (a project instruction worth writing down).

## Filing it

Make **exactly one** `propose_pattern` call. It queues the write-up; it builds
nothing and spends nothing. A person rates it — good, near good, has potential
— and may prep it into the dispatch queue, where your methodology becomes the
brief a session is handed.

Do not also write a file, a note or a doc about it. The queue is the one place
a candidate lives.

## What you are not doing

Deciding. A proposal is a candidate, and the step that turns a candidate into a
built skill belongs to somebody else. Say what you saw and what you did, not
what should happen next.
