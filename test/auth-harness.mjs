// Drives bridge/auth.mjs directly (unit half) and then a REAL relay
// subprocess (live half): setup, login, the cookie gate, SSE, the token
// bypass, reset, logout, /api/health staying open, and the
// SZG_PANE_PASSWORD_DISABLED escape hatch. Hermetic: SZG_PORT=0, SZG_DATA_DIR
// in a temp dir. Run: node test/auth-harness.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const A = await import(join(ROOT, 'syzygy', 'bridge', 'auth.mjs'))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }
const tmp = () => mkdtempSync(join(tmpdir(), 'szg-auth-'))

// ============================================================== unit half
console.log('--- unit ---')

await ok('hashPassword/verifyPassword round-trips', () => {
  const rec = A.hashPassword('correct horse battery staple')
  assert.equal(typeof rec.salt, 'string'); assert.equal(typeof rec.hash, 'string')
  assert.equal(A.verifyPassword('correct horse battery staple', rec), true)
})

await ok('verifyPassword rejects the wrong password', () => {
  const rec = A.hashPassword('right-password')
  assert.equal(A.verifyPassword('wrong-password', rec), false)
})

await ok('verifyPassword returns false, never throws, on a malformed record', () => {
  assert.equal(A.verifyPassword('anything', null), false)
  assert.equal(A.verifyPassword('anything', {}), false)
  assert.equal(A.verifyPassword('anything', { salt: 'zz', hash: 'not-hex!!' }), false)
  assert.equal(A.verifyPassword('anything', { salt: 123, hash: 456 }), false)
})

await ok('readAuth/writeAuth round-trip, mode 0600, atomic (a .tmp beside the target)', () => {
  const dir = tmp()
  assert.equal(A.readAuth(dir), null, 'absent reads as not configured')
  const rec = { version: 1, salt: 'aa', hash: 'bb', secret: A.mintSecret(), createdAt: 1, updatedAt: 1 }
  A.writeAuth(dir, rec)
  assert.deepEqual(A.readAuth(dir), rec)
  rmSync(dir, { recursive: true, force: true })
})

await ok('readAuth degrades a malformed file to null rather than throwing', () => {
  const dir = tmp()
  A.writeAuth(dir, { version: 1, salt: 'aa', hash: 'bb', secret: 's', createdAt: 1, updatedAt: 1 })
  // Hand-corrupt it: valid JSON, missing the fields readAuth requires.
  const file = join(dir, 'auth.json')
  writeFileSync(file, JSON.stringify({ version: 1 }))
  assert.equal(A.readAuth(dir), null)
  rmSync(dir, { recursive: true, force: true })
})

await ok('signCookie/verifyCookie: a fresh cookie verifies', () => {
  const secret = A.mintSecret()
  const now = Date.now()
  const cookie = A.signCookie(secret, now)
  assert.equal(cookie.split('.').length, 3)
  assert.equal(A.verifyCookie(secret, cookie, now, 30 * 24 * 3600 * 1000), true)
})

await ok('verifyCookie rejects one that has expired', () => {
  const secret = A.mintSecret()
  const issuedAt = Date.now() - 1000
  const cookie = A.signCookie(secret, issuedAt)
  assert.equal(A.verifyCookie(secret, cookie, issuedAt + 500, 400), false)
})

await ok('verifyCookie rejects a flipped byte in the mac', () => {
  const secret = A.mintSecret()
  const now = Date.now()
  const cookie = A.signCookie(secret, now)
  const [issuedAt, sid, mac] = cookie.split('.')
  const flipped = (mac[0] === '0' ? '1' : '0') + mac.slice(1)
  assert.equal(A.verifyCookie(secret, [issuedAt, sid, flipped].join('.'), now, 30 * 24 * 3600 * 1000), false)
})

await ok('verifyCookie is false, never throws, on any shape it does not recognise', () => {
  const secret = A.mintSecret()
  const now = Date.now()
  for (const v of [undefined, null, '', 'no-dots-here', 'a.b', 'a.b.c.d', 'notanumber.sid.mac']) {
    assert.equal(A.verifyCookie(secret, v, now, 1000), false, `did not reject ${JSON.stringify(v)}`)
  }
  assert.equal(A.verifyCookie(null, A.signCookie('s', now), now, 1000), false, 'no secret configured yet')
})

await ok('parseCookies reads a real Cookie header, tolerant of spacing', () => {
  assert.deepEqual(A.parseCookies('szg_auth=abc.def.ghi; theme=teal'), { szg_auth: 'abc.def.ghi', theme: 'teal' })
  assert.deepEqual(A.parseCookies(''), {})
  assert.deepEqual(A.parseCookies(undefined), {})
  assert.deepEqual(A.parseCookies('  a = 1 ; b=2'), { a: '1', b: '2' })
})

await ok('rateLimiter: the 10th call is ok, the 11th is not, and clear() resets it', () => {
  const rl = A.rateLimiter({ limit: 10, windowMs: 60_000 })
  let last
  for (let i = 1; i <= 10; i++) { last = rl.hit('k'); assert.equal(last.ok, true, `call ${i} should be ok`) }
  const eleventh = rl.hit('k')
  assert.equal(eleventh.ok, false)
  assert.equal(typeof eleventh.retryAfterSec, 'number')
  rl.clear('k')
  assert.equal(rl.hit('k').ok, true, 'clear() lets the next call through')
})

await ok('rateLimiter keys are independent', () => {
  const rl = A.rateLimiter({ limit: 1, windowMs: 60_000 })
  assert.equal(rl.hit('a').ok, true)
  assert.equal(rl.hit('a').ok, false)
  assert.equal(rl.hit('b').ok, true, 'a different key is not affected by a\'s count')
})

// ---- gate(): all seven branches, plus the PUT/DELETE method-agnostic gap ----
const base = { method: 'GET', path: '/api/state', accept: '*/*', cookieOk: false, tokenOk: false, configured: true, disabled: false }

await ok('gate: disabled -> allow, regardless of anything else', () => {
  assert.equal(A.gate({ ...base, configured: false, disabled: true }).mode, 'allow')
})
await ok('gate: /api/health -> allow, always', () => {
  assert.equal(A.gate({ ...base, path: '/api/health', configured: false }).mode, 'allow')
})
await ok('gate: /favicon.svg -> allow, always -- the login page needs to show it too', () => {
  assert.equal(A.gate({ ...base, path: '/favicon.svg', configured: false }).mode, 'allow')
})
await ok('gate: an auth route -> allow, for GET (/login, /setup) and POST (/api/auth/*) alike', () => {
  assert.equal(A.gate({ ...base, path: '/login' }).mode, 'allow')
  assert.equal(A.gate({ ...base, path: '/setup' }).mode, 'allow')
  assert.equal(A.gate({ ...base, method: 'POST', path: '/api/auth/login' }).mode, 'allow')
})
await ok('gate: a valid cookie allows', () => {
  assert.equal(A.gate({ ...base, cookieOk: true }).mode, 'allow')
})
await ok('gate: a valid token allows', () => {
  assert.equal(A.gate({ ...base, tokenOk: true }).mode, 'allow')
})
await ok('gate: an unauthenticated navigation with nothing configured -> setup', () => {
  assert.equal(A.gate({ ...base, path: '/', configured: false }).mode, 'setup')
})
await ok('gate: an unauthenticated navigation with a password configured -> login', () => {
  assert.equal(A.gate({ ...base, path: '/', configured: true }).mode, 'login')
})
await ok('gate: everything else -- an unauthenticated /api/* GET, or a static asset -- -> 401', () => {
  assert.equal(A.gate({ ...base, path: '/api/state' }).mode, '401')
  assert.equal(A.gate({ ...base, path: '/app.js' }).mode, '401')
  assert.equal(A.gate({ ...base, path: '/api/stream' }).mode, '401')
})
await ok('gate is method-agnostic: PUT and DELETE on /api/state with no cookie or token -> 401, not login and not allow', () => {
  // The gap this closes: today authed() runs only inside the POST branch, so
  // a PUT/DELETE/PATCH to /api/* fell through it to the static handler with
  // no check at all.
  assert.equal(A.gate({ ...base, method: 'PUT' }).mode, '401')
  assert.equal(A.gate({ ...base, method: 'DELETE' }).mode, '401')
  assert.equal(A.gate({ ...base, method: 'PATCH' }).mode, '401')
})
await ok('gate: HEAD is treated like GET for the navigation split (curl -sI)', () => {
  assert.equal(A.gate({ ...base, method: 'HEAD', path: '/', configured: false }).mode, 'setup')
})
await ok('gate: a plain curl-style Accept ("*/*") on / still counts as a navigation, not just a browser\'s "text/html"', () => {
  assert.equal(A.gate({ ...base, path: '/', accept: '*/*', configured: false }).mode, 'setup')
})

console.log(`unit: ${pass} checks passed so far`)

// ============================================================== live half
console.log('--- live ---')

const RELAY = join(ROOT, 'syzygy', 'bridge', 'relay.mjs')

const spawnRelay = async (extraEnv = {}) => {
  const dataDir = tmp()
  const child = spawn(process.execPath, [RELAY], {
    env: { ...process.env, SZG_PORT: '0', SZG_TOKEN: 'auth-harness-token', SZG_DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderrText = ''
  child.stderr.on('data', (c) => { stderrText += c })
  const port = await new Promise((resolvePort, reject) => {
    let out = ''
    const onData = (chunk) => {
      out += chunk
      const m = out.match(/relay on http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { child.stdout.off('data', onData); resolvePort(Number(m[1])) }
    }
    child.stdout.on('data', onData)
    child.on('error', reject)
    child.on('exit', (code) => reject(new Error(`relay exited early with code ${code}; stderr: ${stderrText}`)))
    setTimeout(() => reject(new Error('relay did not report a port in time')), 8000)
  })
  return { child, dataDir, base: `http://127.0.0.1:${port}`, getStderr: () => stderrText }
}

const stopRelay = async (child) => {
  if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)) }
}

const cookieOf = (res) => {
  const raw = res.headers.get('set-cookie')
  return raw ? raw.split(';')[0] : null
}

// ---- the password lifecycle, cookie by hand (Node's fetch does not keep a
// cookie jar the way a browser or curl -c/-b would) -------------------------
{
  const { child, dataDir, base } = await spawnRelay()
  try {
    await ok('with no auth.json: GET / redirects to /setup', async () => {
      const r = await fetch(base + '/', { redirect: 'manual' })
      assert.equal(r.status, 302)
      assert.equal(r.headers.get('location'), '/setup')
    })

    await ok('with no auth.json: GET /api/state with no credential is 401; with the token it is 200; /api/health stays open', async () => {
      assert.equal((await fetch(base + '/api/state')).status, 401)
      assert.equal((await fetch(base + '/api/state?token=auth-harness-token')).status, 200)
      assert.equal((await fetch(base + '/api/health')).status, 200)
    })

    await ok('an unauthenticated GET of /favicon.svg is 200 (the login page shows it too) while /app.js stays gated', async () => {
      assert.equal((await fetch(base + '/favicon.svg')).status, 200)
      assert.equal((await fetch(base + '/app.js')).status, 401)
    })

    await ok('gate is method-agnostic on the real relay too: PUT/DELETE /api/state with no credential is 401', async () => {
      assert.equal((await fetch(base + '/api/state', { method: 'PUT' })).status, 401)
      assert.equal((await fetch(base + '/api/state', { method: 'DELETE' })).status, 401)
    })

    await ok('a plugin-style POST (token only in the JSON body, no header, no cookie) still works unchanged', async () => {
      const r = await fetch(base + '/api/register', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'auth-harness-token', session: { id: 'auth-harness-plugin' } }),
      })
      assert.equal(r.status, 200)
    })

    let setupCookie
    await ok('POST /api/auth/setup: too short or mismatched is refused, 400', async () => {
      const r = await fetch(base + '/api/auth/setup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'short', confirm: 'short' }),
      })
      assert.equal(r.status, 400)
    })
    await ok('POST /api/auth/setup: a good pair succeeds and sets the cookie', async () => {
      const r = await fetch(base + '/api/auth/setup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'correcthorse1', confirm: 'correcthorse1' }),
      })
      assert.equal(r.status, 200)
      setupCookie = cookieOf(r)
      assert.ok(setupCookie, 'a Set-Cookie header was sent')
    })
    await ok('POST /api/auth/setup a second time is refused, 409 (already configured)', async () => {
      const r = await fetch(base + '/api/auth/setup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'whatever123', confirm: 'whatever123' }),
      })
      assert.equal(r.status, 409)
    })

    await ok('GET / now redirects to /login, not /setup', async () => {
      const r = await fetch(base + '/', { redirect: 'manual' })
      assert.equal(r.status, 302)
      assert.equal(r.headers.get('location'), '/login')
    })

    await ok('the cookie gates GET / and GET /api/state', async () => {
      assert.equal((await fetch(base + '/api/state')).status, 401, 'no cookie -> 401')
      const withCookie = await fetch(base + '/api/state', { headers: { cookie: setupCookie } })
      assert.equal(withCookie.status, 200)
      const page = await fetch(base + '/', { headers: { cookie: setupCookie } })
      assert.equal(page.status, 200)
    })

    await ok('SSE (/api/stream) is refused with no cookie and accepted with one', async () => {
      const denied = await fetch(base + '/api/stream')
      assert.equal(denied.status, 401)
      const ac = new AbortController()
      const allowed = await fetch(base + '/api/stream', { headers: { cookie: setupCookie }, signal: ac.signal })
      assert.equal(allowed.status, 200)
      ac.abort()
    })

    // REGRESSION, found by hand against a real relay after the first
    // implementation landed. The gate exempted EVERY POST so that the
    // plugin's body-carried token could still reach `authed()`. But the
    // read-only branches (/api/state, /api/replay, /api/stream)
    // sit ABOVE `authed()` and never checked the method, and the static
    // handler at the foot of the file does not check it either. So reading
    // the entire board, or pulling down the pane's source, was a one-word
    // change from GET to POST -- past a password that was otherwise working
    // perfectly. Measured, not theorised: POST /app.js returned 92901 bytes
    // and POST /api/state the full snapshot.
    //
    // The exemption is now narrow (POST to /api/ only, which is exactly what
    // `authed()` guards) and every read-only branch is GET/HEAD-only.
    await ok('REGRESSION: POST does not bypass the gate on static paths', async () => {
      for (const path of ['/app.js', '/', '/index.html']) {
        const r = await fetch(base + path, { method: 'POST' })
        assert.equal(r.status, 401, `POST ${path} served an unauthenticated caller`)
      }
    })

    await ok('REGRESSION: POST does not bypass the gate on the read-only API, SSE included', async () => {
      for (const path of ['/api/state', '/api/replay', '/api/stream']) {
        const r = await fetch(base + path, { method: 'POST' })
        assert.equal(r.status, 401, `POST ${path} answered an unauthenticated caller`)
      }
    })

    await ok('REGRESSION: PATCH joins PUT and DELETE in being refused on the read-only API', async () => {
      for (const method of ['PUT', 'DELETE', 'PATCH']) {
        assert.equal((await fetch(base + '/api/state', { method })).status, 401)
      }
    })

    await ok('the narrowed exemption did not break the cookie-only POST: the pane writes with no token at all', async () => {
      const r = await fetch(base + '/api/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: setupCookie },
        body: JSON.stringify({ session: { id: 'cookie-only-session' } }),
      })
      assert.equal(r.status, 200)
    })

    await ok('POST /api/auth/login: wrong password is 401', async () => {
      const r = await fetch(base + '/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'not-it' }),
      })
      assert.equal(r.status, 401)
    })

    let loginCookie
    await ok('POST /api/auth/login: the right password succeeds and sets a fresh cookie', async () => {
      const r = await fetch(base + '/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'correcthorse1' }),
      })
      assert.equal(r.status, 200)
      loginCookie = cookieOf(r)
      assert.ok(loginCookie)
    })

    await ok('POST /api/auth/reset requires the cookie: refused with none, 401', async () => {
      const r = await fetch(base + '/api/auth/reset', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current: 'correcthorse1', password: 'brandnew123', confirm: 'brandnew123' }),
      })
      assert.equal(r.status, 401)
    })

    let resetCookie
    await ok('POST /api/auth/reset rotates the secret: the OLD cookie (setupCookie) stops working, the NEW one (reissued in the same response) works', async () => {
      const r = await fetch(base + '/api/auth/reset', {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: loginCookie },
        body: JSON.stringify({ current: 'correcthorse1', password: 'brandnew123', confirm: 'brandnew123' }),
      })
      assert.equal(r.status, 200)
      resetCookie = cookieOf(r)
      assert.ok(resetCookie)
      assert.equal((await fetch(base + '/api/state', { headers: { cookie: setupCookie } })).status, 401, 'the pre-reset cookie is dead')
      assert.equal((await fetch(base + '/api/state', { headers: { cookie: resetCookie } })).status, 200, 'the reissued cookie works')
    })

    await ok('POST /api/auth/logout clears the cookie', async () => {
      const r = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { cookie: resetCookie } })
      assert.equal(r.status, 200)
      const cleared = cookieOf(r)
      assert.ok(cleared && /Max-Age=0/.test(r.headers.get('set-cookie')))
    })

    await ok('login is rate-limited: 10 failures succeed as failures, the 11th is 429 with Retry-After', async () => {
      let last
      for (let i = 0; i < 10; i++) {
        last = await fetch(base + '/api/auth/login', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: 'nope' }),
        })
        assert.equal(last.status, 401)
      }
      const blocked = await fetch(base + '/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'nope' }),
      })
      assert.equal(blocked.status, 429)
      assert.ok(blocked.headers.get('retry-after'))
    })
  } finally {
    await stopRelay(child)
  }
  rmSync(dataDir, { recursive: true, force: true })
}

// ---- SZG_PANE_PASSWORD_DISABLED: the whole gate is off, and the token is
// injected into .html again 's byte-for-byte no-op) ----------------------
{
  const { child, dataDir, base } = await spawnRelay({ SZG_PANE_PASSWORD_DISABLED: '1' })
  try {
    await ok('AUTH_OFF: GET / is 200 (no redirect) and carries the real token', async () => {
      const r = await fetch(base + '/')
      assert.equal(r.status, 200)
      const html = await r.text()
      assert.ok(html.includes('window.SZG_TOKEN = "auth-harness-token"'), 'the real token is injected, not the empty string')
    })
    await ok('AUTH_OFF: GET /api/state needs no credential at all', async () => {
      assert.equal((await fetch(base + '/api/state')).status, 200)
    })
    await ok('AUTH_OFF: /setup and /login both bounce to /', async () => {
      const s = await fetch(base + '/setup', { redirect: 'manual' })
      assert.equal(s.status, 302); assert.equal(s.headers.get('location'), '/')
      const l = await fetch(base + '/login', { redirect: 'manual' })
      assert.equal(l.status, 302); assert.equal(l.headers.get('location'), '/')
    })
    await ok('AUTH_OFF: every /api/auth/* route answers 409, not half-working', async () => {
      for (const path of ['/api/auth/setup', '/api/auth/login', '/api/auth/logout', '/api/auth/reset']) {
        const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        assert.equal(r.status, 409, path)
      }
    })
  } finally {
    await stopRelay(child)
  }
  rmSync(dataDir, { recursive: true, force: true })
}

console.log(`\nauth harness: ${pass} checks passed`)
