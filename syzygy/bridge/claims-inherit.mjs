// A terminal window gets a fresh session id every restart, so a claim keyed by
// id alone is orphaned the moment you close the window. The session NAME is
// what survives, so a restarted session inherits its predecessor's claim.
//
// Two rules keep that from stealing work:
//   1. Never inherit from a session that is still LIVE. Two live sessions
//      sharing a name are different sessions, and taking one's claim is worse
//      than doing nothing.
//   2. Two or more STALE claims under one name: inherit nothing.
//
// Rule 2 is NOT "the most recently updated wins", which is the tie-break it
// looks like it wants: hud.tsx's displayName() falls back to the
// session name, else the repo, else the last path segment, else the id -- and
// every one of those but the id is IDENTICAL for all sessions in a worktree.
// So two default-named sessions in one worktree collide by construction, which
// is the exact case this feature exists for. Sessions A and B share worktree W
// and a name; A claims plan-1, B claims plan-2; both go stale; B restarts and
// the updatedAt tie-break hands it A's claim, while transferClaim deletes A's
// key outright. Ambiguity means do nothing -- the same principle rule 1 rests
// on -- and it also makes release_work durable in the common case, since
// registerSession re-runs on a 404 and on relay recovery and would otherwise
// silently re-inherit a released claim.
//
// Pure: no I/O.

export const inheritableClaim = (claims, name, liveIds) => {
  if (!name) return null
  let best = null
  let matches = 0
  for (const [sessionId, entry] of Object.entries(claims ?? {})) {
    // Pure, and driven directly with hand-built fixtures -- so it must not
    // assume readClaims's sanitation (every entry a plain object) holds.
    if (!entry) continue
    if (entry.name !== name) continue
    if (liveIds?.has(sessionId)) continue
    matches++
    if (!best || (entry.updatedAt ?? 0) > (best.entry.updatedAt ?? 0)) best = { sessionId, entry }
  }
  // `claims` is keyed by session id, so every match here is already a distinct
  // id: more than one means two different sessions wore this name, and there
  // is no way to tell whose successor the caller is.
  if (matches > 1) return null
  return best
}
