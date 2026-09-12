#!/usr/bin/env node
// Drives bridge/claims.mjs against a temp worktree. Hermetic: no relay.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { claimsPathFor, readClaims, writeClaim, removeClaim, transferClaim } =
  await import(join(ROOT, 'syzygy', 'bridge', 'claims.mjs'))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }
const wt = () => mkdtempSync(join(tmpdir(), 'szg-claims-'))

await ok('an absent file reads as no claims, not an error', () => {
  assert.deepEqual(readClaims(wt()), { version: 1, claims: {} })
})

await ok('a written claim reads back', () => {
  const r = wt()
  writeClaim(r, 's1', { name: 'alpha', items: [{ kind: 'plan', id: 'a.md' }] })
  const back = readClaims(r)
  assert.equal(back.claims.s1.name, 'alpha')
  assert.deepEqual(back.claims.s1.items, [{ kind: 'plan', id: 'a.md' }])
  assert.equal(typeof back.claims.s1.claimedAt, 'number')
})

await ok('writing one session never disturbs another', () => {
  const r = wt()
  writeClaim(r, 's1', { name: 'alpha', items: [] })
  writeClaim(r, 's2', { name: 'beta', items: [] })
  writeClaim(r, 's1', { name: 'alpha', items: [{ kind: 'plan', id: 'x.md' }] })
  const back = readClaims(r)
  assert.equal(back.claims.s2.name, 'beta', 's2 was rewritten by an s1 write')
  assert.equal(back.claims.s1.items.length, 1)
})

await ok('unknown fields added by hand survive a later write', () => {
  const r = wt()
  writeClaim(r, 's1', { name: 'alpha', items: [] })
  const p = claimsPathFor(r)
  const doc = JSON.parse(readFileSync(p, 'utf8'))
  doc.claims.s1.myOwnField = 'keep me'
  doc.myTopLevel = 'keep me too'
  writeFileSync(p, JSON.stringify(doc))
  writeClaim(r, 's1', { name: 'alpha', items: [{ kind: 'plan', id: 'y.md' }] })
  const back = readClaims(r)
  assert.equal(back.claims.s1.myOwnField, 'keep me')
  assert.equal(back.myTopLevel, 'keep me too')
})

await ok('claimedAt is preserved across updates, updatedAt moves', () => {
  const r = wt()
  writeClaim(r, 's1', { name: 'alpha', items: [] })
  const first = readClaims(r).claims.s1
  writeClaim(r, 's1', { name: 'alpha', items: [{ kind: 'plan', id: 'z.md' }] })
  const second = readClaims(r).claims.s1
  assert.equal(second.claimedAt, first.claimedAt, 'claimedAt must not be reset')
  assert.ok(second.updatedAt >= first.updatedAt)
})

await ok('removeClaim drops only that session', () => {
  const r = wt()
  writeClaim(r, 's1', { name: 'alpha', items: [] })
  writeClaim(r, 's2', { name: 'beta', items: [] })
  removeClaim(r, 's1')
  const back = readClaims(r)
  assert.equal(back.claims.s1, undefined)
  assert.equal(back.claims.s2.name, 'beta')
})

// transferClaim is ONE read-modify-flush that moves a claim from one
// session id to another, instead of the writeClaim+removeClaim pair -- two
// independent read-modify-flush cycles that can leave a duplicate if the
// second throws after the first succeeds ("inherit" must mean transfer,
// never duplicate).

await ok('transferClaim moves the entry and leaves no duplicate', () => {
  const r = wt()
  writeClaim(r, 'old', { name: 'alpha', items: [{ kind: 'plan', id: 'a.md' }] })
  const doc = transferClaim(r, 'old', 'new', { inheritedFrom: 'old' })
  assert.equal(doc.claims.old, undefined, 'the source key must be gone, not merely shadowed')
  assert.equal(doc.claims.new.name, 'alpha')
  assert.deepEqual(doc.claims.new.items, [{ kind: 'plan', id: 'a.md' }])
  assert.equal(doc.claims.new.inheritedFrom, 'old')
  assert.deepEqual(Object.keys(readClaims(r).claims), ['new'], 'no duplicate: exactly one key on disk after the transfer')
})

await ok('transferClaim with no matching from key is a no-op', () => {
  const r = wt()
  writeClaim(r, 's2', { name: 'beta', items: [] })
  const before = readClaims(r)
  const doc = transferClaim(r, 'ghost', 'new', { inheritedFrom: 'ghost' })
  assert.equal(doc.claims.new, undefined, 'nothing was there to transfer, so nothing must appear under the target key')
  assert.deepEqual(readClaims(r).claims, before.claims, 'the file on disk must be untouched by a no-op transfer')
})

await ok('transferClaim leaves every other session untouched', () => {
  const r = wt()
  writeClaim(r, 's1', { name: 'alpha', items: [] })
  writeClaim(r, 's2', { name: 'beta', items: [{ kind: 'plan', id: 'b.md' }] })
  transferClaim(r, 's1', 's3', { inheritedFrom: 's1' })
  const back = readClaims(r)
  assert.equal(back.claims.s2.name, 'beta', 's2 must survive an s1->s3 transfer untouched')
  assert.deepEqual(back.claims.s2.items, [{ kind: 'plan', id: 'b.md' }])
  assert.equal(back.claims.s3.name, 'alpha')
})

await ok('a non-object entry value is dropped, not thrown on', () => {
  const r = wt()
  mkdirSync(dirname(claimsPathFor(r)), { recursive: true })
  writeFileSync(claimsPathFor(r), JSON.stringify({ claims: { good: { name: 'g', items: [] }, bad: null } }))
  const back = readClaims(r)
  assert.deepEqual(Object.keys(back.claims), ['good'], 'a malformed entry value must not reach a consumer')
  assert.equal(back.claims.good.name, 'g')
})

// readClaims also sanitizes `items` inside a well-formed entry, so every
// consumer that reaches into `entry.items` (ownerFor, foldEfforts, the
// backlog matcher) can rely on it being an array of objects without its own
// guard. Each case below asserts the SPECIFIC shape the sanitation produces,
// not merely that reading the file does not throw -- a test that only checked
// "does not throw" would still pass if the bad element survived unsanitized.

await ok('a null element in items is dropped, not carried through', () => {
  const r = wt()
  mkdirSync(dirname(claimsPathFor(r)), { recursive: true })
  writeFileSync(claimsPathFor(r), JSON.stringify({ claims: { s1: { name: 'a', items: [null] } } }))
  const back = readClaims(r)
  assert.deepEqual(back.claims.s1.items, [], 'a null element must not survive into entry.items')
})

await ok('a non-array items is normalised to an empty array', () => {
  const r = wt()
  mkdirSync(dirname(claimsPathFor(r)), { recursive: true })
  writeFileSync(claimsPathFor(r), JSON.stringify({ claims: { s1: { name: 'a', items: 'not-an-array' } } }))
  const back = readClaims(r)
  assert.deepEqual(back.claims.s1.items, [], 'a string items must normalise to []')
})

await ok('a mixed items array keeps only its object elements', () => {
  const r = wt()
  mkdirSync(dirname(claimsPathFor(r)), { recursive: true })
  writeFileSync(claimsPathFor(r), JSON.stringify({
    claims: { s1: { name: 'a', items: [{ kind: 'plan', id: 'a.md' }, null, 'x'] } },
  }))
  const back = readClaims(r)
  assert.deepEqual(back.claims.s1.items, [{ kind: 'plan', id: 'a.md' }],
    'null and non-object elements must be dropped, leaving only the real item')
})

await ok('a well-formed entry is completely unchanged by the sanitation', () => {
  const r = wt()
  const items = [{ kind: 'plan', id: 'a.md' }, { kind: 'backlog', id: 'docs/TASKS.md#x' }]
  writeClaim(r, 's1', { name: 'alpha', note: 'in progress', items })
  // Hand-add a field the code has no special knowledge of -- readClaims and
  // this test both name items/name/note/claimedAt/updatedAt explicitly, so
  // asserting only those would still pass a refactor that swapped the `{
  // ...entry, items: ... }` spread for an explicit field whitelist, silently
  // dropping every hand-added field. This is the field that catches that.
  const p = claimsPathFor(r)
  const doc = JSON.parse(readFileSync(p, 'utf8'))
  doc.claims.s1.myOwnField = 'keep me'
  writeFileSync(p, JSON.stringify(doc))

  const back = readClaims(r).claims.s1
  // Compared against the literal that was written, not against another
  // readClaims() call -- a sanitizer that mangled well-formed items the same
  // way on every read would still pass a read-vs-read comparison.
  assert.deepEqual(back.items, items, 'well-formed items must pass through unchanged')
  assert.equal(back.name, 'alpha')
  assert.equal(back.note, 'in progress')
  assert.equal(typeof back.claimedAt, 'number')
  assert.equal(typeof back.updatedAt, 'number')
  assert.equal(back.myOwnField, 'keep me', 'a genuinely unknown hand-added field must survive the items sanitation too')
})

await ok('a corrupt file degrades to no claims instead of throwing', () => {
  const r = wt()
  mkdirSync(dirname(claimsPathFor(r)), { recursive: true })
  writeFileSync(claimsPathFor(r), '{ not json')
  assert.deepEqual(readClaims(r).claims, {}, 'a corrupt file must not kill the scan')
})

await ok('a corrupt file is moved aside rather than silently overwritten', () => {
  const r = wt()
  mkdirSync(dirname(claimsPathFor(r)), { recursive: true })
  writeFileSync(claimsPathFor(r), '{ not json')
  writeClaim(r, 's1', { name: 'alpha', items: [] })
  assert.equal(readClaims(r).claims.s1.name, 'alpha')
  assert.ok(readdirSync(dirname(claimsPathFor(r))).some(f => /\.corrupt-\d+$/.test(f)), 'corrupt file must be moved aside with .corrupt-* name')
})

// if the `.corrupt-*` aside cannot be made, execution used to
// fall through to the unconditional renameSync(tmp, file) below it and destroy
// the corrupt file -- silently violating the very contract the test above
// exists to protect. The aside destination is blocked here with a NON-EMPTY
// DIRECTORY, which is the one shape that makes renameSync(file, dest) fail
// while the tmp write and final rename that follow would both still succeed.
// A read-only parent directory would not do: that fails the tmp write too, so
// the file survives either way and the test would have no teeth.
await ok('a failed corrupt-aside leaves the corrupt file on disk instead of destroying it', () => {
  const r = wt()
  const p = claimsPathFor(r)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, '{ not json')
  const at = 1_700_000_000_000
  const blocked = p + '.corrupt-' + at
  mkdirSync(blocked, { recursive: true })
  writeFileSync(join(blocked, 'occupied'), 'x')

  assert.throws(() => writeClaim(r, 's1', { name: 'alpha', items: [] }, () => at),
    'a write that cannot move the corrupt file aside must fail, not proceed')
  assert.equal(readFileSync(p, 'utf8'), '{ not json',
    'the corrupt file must still be on disk, recoverable by hand')
  assert.equal(existsSync(p + '.tmp'), false, 'the temp file must be cleaned up on the failure path')
})

await ok('no .tmp file is left behind', () => {
  const r = wt()
  writeClaim(r, 's1', { name: 'alpha', items: [] })
  assert.equal(existsSync(claimsPathFor(r) + '.tmp'), false)
})

{
  const { inheritableClaim } = await import(join(ROOT, 'syzygy', 'bridge', 'claims-inherit.mjs'))
  const claims = {
    old1: { name: 'alpha', items: [{ kind: 'plan', id: 'a.md' }], updatedAt: 100 },
    old2: { name: 'alpha', items: [{ kind: 'plan', id: 'b.md' }], updatedAt: 200 },
    livey: { name: 'beta', items: [], updatedAt: 300 },
    // Deliberately falsy-named entries, most-recently-updated of the lot, so
    // the empty/missing-name guard is actually exercised below: without
    // `if (!name) return null`, `entry.name !== name` would treat a '' query
    // as matching an entry whose own name is '', and an undefined query as
    // matching an entry with no name field at all.
    unnamed: { name: '', items: [], updatedAt: 400 },
    noname: { items: [], updatedAt: 500 },
  }

  await ok('a LONE stale same-name claim is inheritable', () => {
    const lone = { solo: { name: 'alpha', items: [{ kind: 'plan', id: 'a.md' }], updatedAt: 100 }, other: { name: 'beta', items: [], updatedAt: 900 } }
    const hit = inheritableClaim(lone, 'alpha', new Set())
    assert.equal(hit.sessionId, 'solo', 'the one stale claim under this name must be inherited')
  })

  // displayName() (hud.tsx) falls back to the session
  // name, else the repo, else the last path segment, else the id -- so every
  // session in one worktree without an explicit name shares a name by
  // construction, which is the exact case this feature exists for. With the
  // old "most recent updatedAt wins" rule, B restarting could inherit A's
  // claim while transferClaim deleted A's key outright. Ambiguity means do
  // nothing.
  await ok('two distinct-id stale same-name claims inherit NOTHING', () => {
    assert.equal(inheritableClaim(claims, 'alpha', new Set()), null,
      'two stale claims wearing one name are ambiguous: inheriting either one can steal the other session\'s work')
  })

  // The liveness filter runs BEFORE the ambiguity count, so a name worn by one
  // live session and one stale one is not ambiguous -- there is exactly one
  // claim available to inherit. Without that ordering this returns null and
  // the ordinary restart-while-a-namesake-runs case would stop working.
  await ok('a live namesake does not make the remaining stale claim ambiguous', () => {
    const hit = inheritableClaim(claims, 'alpha', new Set(['old1']))
    assert.equal(hit.sessionId, 'old2', 'the only STALE claim under the name must still be inheritable')
  })

  await ok('a LIVE same-name session is never inherited from', () => {
    // Stealing from a running session is worse than doing nothing.
    assert.equal(inheritableClaim(claims, 'beta', new Set(['livey'])), null)
  })

  await ok('a name nobody claimed inherits nothing', () => {
    assert.equal(inheritableClaim(claims, 'gamma', new Set()), null)
  })

  await ok('an empty or missing name never inherits', () => {
    assert.equal(inheritableClaim(claims, '', new Set()), null,
      "an empty query name must not match an entry whose own name is ''")
    assert.equal(inheritableClaim(claims, undefined, new Set()), null,
      'an undefined query name must not match an entry with no name field')
  })

  // inheritableClaim is advertised as directly testable with hand-built
  // fixtures rather than only through readClaims, so it must not assume
  // readClaims's own sanitation (every entry a plain object) holds. A `null`
  // entry must be skipped, not thrown on -- and the loop must still find a
  // genuine later match, proving it was skipped rather than the whole call
  // short-circuiting.
  await ok('a null claims entry is skipped, not thrown on', () => {
    const withGhost = { ghost: null, real: { name: 'alpha', items: [], updatedAt: 100 } }
    const hit = inheritableClaim(withGhost, 'alpha', new Set())
    assert.equal(hit.sessionId, 'real', 'the null entry must not stop a genuine match from being found')
  })
}

// ---- live relay -------------------------------------------------------------
// A mocked relay cannot prove this. The whole point of routing writes through
// one process is that two sessions in one worktree cannot interleave, and only
// a real relay taking two real concurrent requests demonstrates that.
{
  const { spawn, execFileSync } = await import('node:child_process')
  const relay = join(ROOT, 'syzygy', 'bridge', 'relay.mjs')
  const PORT = 4400 + Math.floor(Math.random() * 100)
  const TOKEN = 'test-token-' + Math.random().toString(36).slice(2)
  const root = wt()

  // SZG_DATA_DIR points the child at an isolated directory instead of the
  // real, shared ~/.claude/syzygy -- world.json and dispatch.json
  // are authoritative user data, and this test process must never load,
  // mutate or flush the real files (relay.mjs:31-34). Without this, the
  // child loads the real world.json and dispatch.json, shared right now with
  // any live relay on 4317/4319.
  const child = spawn(process.execPath, [relay], {
    env: {
      ...process.env, SZG_PORT: String(PORT), SZG_TOKEN: TOKEN,
      SZG_DATA_DIR: mkdtempSync(join(tmpdir(), 'szg-relay-data-')),
      SZG_PANE_PASSWORD_DISABLED: '1', // this harness's own POSTs carry only the token, no cookie
    },
    stdio: 'ignore',
  })
  const post = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mch-token': TOKEN },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  try {
    // Wait for the relay to answer rather than sleeping a fixed time.
    for (let i = 0; i < 60; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/api/health`); break } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    // A stale orphan relay already listening on this port would answer the
    // health poll above and silently take the claims traffic below, turning
    // the load-bearing concurrency test into a false pass.
    assert.equal(child.exitCode, null, 'relay child died -- port in use?')

    await ok('POST /api/claim writes a claim', async () => {
      const r = await post('/api/claim', {
        sessionId: 's1', name: 'alpha', root, items: [{ kind: 'plan', id: 'a.md' }],
      })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(readClaims(root).claims.s1.name, 'alpha')
    })

    await ok('POST /api/claim refuses a missing sessionId', async () => {
      assert.equal((await post('/api/claim', { root, name: 'x', items: [] })).status, 400)
    })

    await ok('POST /api/claim refuses a root that is not a real directory', async () => {
      assert.equal((await post('/api/claim', { sessionId: 'x', root: join(root, 'nope') })).status, 400)
    })

    await ok('TWO CONCURRENT CLAIMS IN ONE WORKTREE BOTH SURVIVE', async () => {
      const fresh = wt()
      const many = []
      for (let i = 0; i < 20; i++) {
        many.push(post('/api/claim', {
          sessionId: 'c' + i, name: 'n' + i, root: fresh,
          items: [{ kind: 'plan', id: i + '.md' }],
        }))
      }
      await Promise.all(many)
      const back = readClaims(fresh).claims
      assert.equal(Object.keys(back).length, 20,
        'lost a claim: got ' + Object.keys(back).length + ' of 20')
    })

    await ok('POST /api/release drops only that session', async () => {
      await post('/api/claim', { sessionId: 's2', name: 'beta', root, items: [] })
      assert.equal((await post('/api/release', { sessionId: 's1', root })).status, 200)
      const back = readClaims(root).claims
      assert.equal(back.s1, undefined)
      assert.equal(back.s2.name, 'beta')
    })

    // built claim inheritance and is the first thing that ever
    // sends `root` on a real /api/register call -- until now this whole path
    // was proven only by unit tests on the pure inheritableClaim/transferClaim
    // functions and by a sibling endpoint's (/api/claim) root-validation test.
    // These two drive the actual endpoint end-to-end.
    await ok('POST /api/register inherits a stale same-name claim end-to-end', async () => {
      const inheritRoot = wt()
      // A stale claim under a session id that never registers with this
      // relay, so it is never counted "live".
      writeClaim(inheritRoot, 'stale-old', { name: 'inherit-e2e', items: [{ kind: 'plan', id: 'z.md' }] })
      const r = await post('/api/register', {
        session: { id: 'fresh-new', name: 'inherit-e2e', root: inheritRoot },
      })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const claims = readClaims(inheritRoot).claims
      assert.equal(claims['stale-old'], undefined, 'the predecessor id must be gone, not left as a duplicate')
      assert.ok(claims['fresh-new'], 'the registering session must hold the transferred claim')
      assert.equal(claims['fresh-new'].name, 'inherit-e2e')
      assert.equal(claims['fresh-new'].inheritedFrom, 'stale-old', 'inheritedFrom must record the predecessor')
      assert.deepEqual(claims['fresh-new'].items, [{ kind: 'plan', id: 'z.md' }])
    })

    await ok('POST /api/register with a relative root never inherits and never throws', async () => {
      const relRoot = wt()
      writeClaim(relRoot, 'stale-rel', { name: 'inherit-rel', items: [] })
      // Relative to the relay child's own cwd -- which it inherits from this
      // process, since the spawn above passes no explicit `cwd` -- so this is
      // guaranteed to resolve to a REAL, existing directory if `isAbsolute`
      // were removed from the guard. That is what gives this test teeth: a
      // relative path that merely failed to exist would pass even with the
      // guard deleted, for the wrong reason.
      const asRelative = relative(process.cwd(), relRoot)
      assert.ok(asRelative.length > 0 && !isAbsolute(asRelative), 'test setup: the derived path must actually be relative')
      const r = await post('/api/register', {
        session: { id: 'fresh-rel', name: 'inherit-rel', root: asRelative },
      })
      assert.equal(r.status, 200, JSON.stringify(r.body), 'a relative root must not make registration throw/500')
      const claims = readClaims(relRoot).claims
      assert.ok(claims['stale-rel'], 'a relative root must not steal the stale claim away')
      assert.equal(claims['fresh-rel'], undefined, 'a relative root must not create an inherited claim')
    })

    // The two inherit tests above both pass unchanged if the endpoint
    // used an empty liveIds set, because neither ever registers the
    // predecessor id with this relay -- the pure inheritableClaim tests in
    // the hermetic section above already cover the liveIds *filter itself*,
    // but not this endpoint's own `[...sessions.keys()].filter(...)` wiring.
    // This registers the predecessor for real first, so it is genuinely live
    // when the newcomer registers under the same name.
    await ok('POST /api/register never steals a claim from a session still registered as live', async () => {
      const liveRoot = wt()
      writeClaim(liveRoot, 'live-old', { name: 'still-live', items: [{ kind: 'plan', id: 'keep.md' }] })
      const first = await post('/api/register', {
        session: { id: 'live-old', name: 'still-live', root: liveRoot },
      })
      assert.equal(first.status, 200, JSON.stringify(first.body))
      const second = await post('/api/register', {
        session: { id: 'live-new', name: 'still-live', root: liveRoot },
      })
      assert.equal(second.status, 200, JSON.stringify(second.body))
      const claims = readClaims(liveRoot).claims
      assert.ok(claims['live-old'], 'a session still registered with the relay must keep its own claim')
      assert.equal(claims['live-new'], undefined,
        'a live session\'s claim must never transfer to a same-named newcomer')
    })

    // The scanner always reads claims from the git TOPLEVEL
    // (topologyOf -> probe), but a session's reported cwd -- and so `root` on
    // /api/claim -- can be a subdirectory of its worktree. Writing the claim
    // where it was posted from produces a claims.json nothing ever reads: the tool reports
    // success, the session still shows as live in that worktree (sessionsIn
    // matches on `under(worktreePath, s.cwd)`), and nobody can tell it is
    // unclaimed. This proves the resolved location is the worktree root, not
    // the subdirectory the claim was posted from.
    await ok('POST /api/claim resolves a subdirectory root to the git worktree root', async () => {
      const { probe } = await import(join(ROOT, 'syzygy', 'bridge', 'tasks-git.mjs'))
      const repoRoot = wt()
      execFileSync('git', ['init', '-q'], { cwd: repoRoot, stdio: 'ignore' })
      const subdir = join(repoRoot, 'nested', 'deeper')
      mkdirSync(subdir, { recursive: true })

      // Ask the SAME probe() the relay itself calls what it resolves the
      // subdirectory to, rather than assuming `repoRoot` is that path
      // byte-for-byte -- on macOS, os.tmpdir() is under /var, a symlink to
      // /private/var, and `git rev-parse --show-toplevel` returns the real
      // path, so a naive string comparison against the mkdtempSync() result
      // would fail for a reason that has nothing to do with what is asserted.
      const resolved = (await probe(subdir))?.worktreeRoot
      assert.ok(resolved, 'test setup: probe must resolve a real git subdirectory to a worktree root')

      const r = await post('/api/claim', {
        sessionId: 'sub1', name: 'subdir-claim', root: subdir, items: [{ kind: 'plan', id: 'sub.md' }],
      })
      assert.equal(r.status, 200, JSON.stringify(r.body))

      assert.equal(readClaims(resolved).claims.sub1?.name, 'subdir-claim',
        'the claim must land at the git worktree root the endpoint resolves to, not the posted subdirectory')
      assert.equal(existsSync(claimsPathFor(subdir)), false,
        'no claims.json may be created inside the subdirectory itself')
    })

    // 4a: `root` reaches three endpoints straight off the wire and only
    // its absoluteness was ever checked. isAbsolute(123) THROWS, so a
    // non-string root became a 500 out of the handler's catch -- and on
    // /api/register that catch fires AFTER sessions.set(), leaving the session
    // registered in the map while the caller is told the call failed.
    await ok('POST /api/claim answers 400, not 500, for a non-string root', async () => {
      const r = await post('/api/claim', { sessionId: 'ns-claim', root: 123, name: 'x', items: [] })
      assert.equal(r.status, 400, 'a non-string root is bad input, not an internal error')
    })

    await ok('POST /api/register with a non-string root still registers the session', async () => {
      const r = await post('/api/register', { session: { id: 'ns-reg', name: 'non-string', root: 123 } })
      assert.equal(r.status, 200, JSON.stringify(r.body), 'a non-string root must not 500 the registration')
      const st = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json()
      assert.ok(st.sessions.some((x) => x.id === 'ns-reg'),
        'the session must be registered AND reported as registered -- never one without the other')
    })

    // /api/release had no root validation at all, unlike its sibling ten lines
    // above: a relative root resolved against the RELAY's cwd rather than the
    // caller's, and a non-string one threw out of probe()/join() as a 500.
    await ok('POST /api/release refuses a root that is not a real absolute directory', async () => {
      assert.equal((await post('/api/release', { sessionId: 'x', root: 123 })).status, 400, 'non-string root')
      assert.equal((await post('/api/release', { sessionId: 'x', root: 'relative/path' })).status, 400, 'relative root')
      assert.equal((await post('/api/release', { sessionId: 'x', root: join(root, 'nope') })).status, 400, 'absent directory')
    })

    // 4b: name/items/note were clamped and inheritedFrom was not. With the
    // 4 MB readBody cap one call could push claims.json past CAPS.fileBytes
    // (256 KiB), at which point discover()'s describe() reports 'too-large'
    // and EVERY claim in that worktree becomes invisible.
    await ok('POST /api/claim clamps inheritedFrom like its siblings', async () => {
      const clampRoot = wt()
      const r = await post('/api/claim', {
        sessionId: 'clamp1', root: clampRoot, name: 'clamped', items: [],
        inheritedFrom: 'z'.repeat(100_000),
      })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const got = readClaims(clampRoot).claims.clamp1.inheritedFrom
      assert.equal(got.length, 200, 'inheritedFrom must be clamped to 200 chars, like name')
    })

    // 4c: updatedAt is read by exactly one thing -- inheritableClaim's
    // tie-break -- so an inherited claim carrying its predecessor's stamp
    // competes there with an artificially old value. claimedAt records when
    // the work was FIRST claimed and must survive the transfer.
    await ok('an inherited claim gets a fresh updatedAt and keeps its original claimedAt', async () => {
      const stampRoot = wt()
      writeClaim(stampRoot, 'stamp-old', { name: 'stamp-refresh', items: [] }, () => 1_000_000)
      assert.equal(readClaims(stampRoot).claims['stamp-old'].updatedAt, 1_000_000, 'test setup')
      const r = await post('/api/register', {
        session: { id: 'stamp-new', name: 'stamp-refresh', root: stampRoot },
      })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const after = readClaims(stampRoot).claims['stamp-new']
      assert.ok(after, 'the claim must have transferred')
      assert.ok(after.updatedAt > 1_000_000,
        'the inherited claim kept its predecessor\'s updatedAt: ' + after.updatedAt)
      assert.equal(after.claimedAt, 1_000_000, 'claimedAt must survive the transfer unchanged')
    })

    // End to end: displayName gives every unnamed session in one worktree
    // the SAME name, so this is the ordinary case, not a corner.
    await ok('POST /api/register inherits NOTHING when two stale claims share the name', async () => {
      const ambRoot = wt()
      writeClaim(ambRoot, 'twin-a', { name: 'twins', items: [{ kind: 'plan', id: 'a.md' }] }, () => 1000)
      writeClaim(ambRoot, 'twin-b', { name: 'twins', items: [{ kind: 'plan', id: 'b.md' }] }, () => 2000)
      const r = await post('/api/register', {
        session: { id: 'twin-new', name: 'twins', root: ambRoot },
      })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const claims = readClaims(ambRoot).claims
      assert.equal(claims['twin-new'], undefined,
        'an ambiguous name must inherit nothing -- taking either claim can steal the other session\'s work')
      assert.ok(claims['twin-a'] && claims['twin-b'],
        'neither predecessor may be deleted: transferClaim removes the source key outright')
    })

    // api/claim, /api/release and /api/register's inherit block
    // each used to broadcast('claims', { root, claims }). Nothing consumed it
    // -- not app.js's SSE switch, not pane-v2's (it hit client.go's default
    // drop) -- and it was the one claims path that bypassed the scanner's
    // containment gate, echoing a caller-supplied root and free-text note onto
    // the ungated stream for a directory containedIn() would never expose.
    //
    // The marker makes this deterministic rather than a sleep: the relay
    // handles POSTs one at a time and writes broadcasts to the same response
    // in order, so a claims frame would necessarily sit AHEAD of the sessions
    // frame that follows it.
    await ok('a claim broadcasts nothing on the ungated stream', async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/stream`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      const leakRoot = wt()
      try {
        await post('/api/claim', {
          sessionId: 'leak1', root: leakRoot, name: 'leaky', items: [],
          note: 'a-note-only-the-claimant-should-see',
        })
        await post('/api/register', { session: { id: 'leak-marker', name: 'leak-marker' } })
        let buf = ''
        const deadline = Date.now() + 5000
        while (!buf.includes('event: sessions')) {
          assert.ok(Date.now() < deadline, 'timed out waiting for the marker frame')
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
        }
        assert.ok(!buf.includes('event: claims'), 'a claims frame reached the ungated stream')
        assert.ok(!buf.includes('a-note-only-the-claimant-should-see'),
          "a claim's free-text note reached the ungated stream")
        assert.ok(!buf.includes(leakRoot), 'a caller-supplied root reached the ungated stream')
      } finally {
        await reader.cancel().catch(() => {})
      }
    })
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 2000) })
  }
}

console.log(`\nclaims harness: ${pass} checks passed`)
assert.equal(pass, 41, `expected 41 checks to pass, got ${pass} -- a missed await would let a failing check report as passing`)
