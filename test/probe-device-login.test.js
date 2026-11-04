/**
 * Regression tests for `probe/qoder-device-login.mjs`.
 *
 * Run: node --test test/probe-device-login.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * The probe's first real run against qoder.cn SUCCEEDED at the login and then
 * destroyed its own evidence. `pollOnce` read the poll body as
 * `(await response.text()).slice(0, 400)`, which cut a real device-token
 * payload mid-string; `JSON.parse` then threw, and because the throw was
 * uncaught, Node printed the offending input — a LIVE device token — into the
 * log.
 *
 * Two defects, one root cause: bounding was applied to the READ instead of to
 * the PRINT. Both are pinned here. Transport must be lossless so the credential
 * can be parsed at all, and a body that will not parse may contribute only its
 * byte count and shape to anything that leaves the probe.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bodyForDisplay,
  credentialOf,
  mask,
  mergeRotation,
  parsePollBody,
  parseTokenPayload,
  pollOnce,
  refreshStep,
} from '../probe/qoder-device-login.mjs'

/** The shape qoder.cn actually answered with; the token values are placeholders. */
const CN_PAYLOAD = {
  id: '01a14590-538b-7e1e-8a9e-33ac4b367354',
  token: 'dt-EXAMPLE00000000000000000',
  user_id: '019ec931-baf3-7de9-8363-65fbacc369b4',
  code_challenge: 'QipFX9pZAQskb5pMZWPoeT4mJ2wij3eU4dbeqW0BIC4',
  code_challenge_method: 'S256',
  nonce: '7706ae3b-adfd-4bf1-a4da-79b3df44e7b1',
  expires_at: '2026-11-15T16:39:32Z',
  expires_in: 2592000,
  refresh_token: 'drt-EXAMPLE00000000000000000',
  refresh_token_expires_at: '2027-10-11T16:39:32Z',
  refresh_token_expires_in: 31104000,
  refresh_token_id: '01a14590-537f-7413-86e4-20ba6b870816',
  created_at: '2026-10-16T16:34:08',
  updated_at: '2026-10-16T16:39:32',
}

const REGION = { openApiUrl: 'https://openapi.example.test', baseUrl: 'https://gateway.example.test/' }
const SESSION = { nonce: 'n', pkce: { verifier: 'v'.repeat(43) }, machineId: 'm' }

test('a poll body is read whole, never bounded at the read site', async () => {
  const body = JSON.stringify(CN_PAYLOAD)
  // The real payload is longer than the 400 characters that used to cut it, so
  // a fixture that shrank below that bound would silently stop testing anything.
  assert.ok(body.length > 400, `fixture must exceed the old 400-char bound, got ${body.length}`)

  const result = await pollOnce(SESSION, REGION, async () => ({ status: 200, text: async () => body }))

  assert.deepStrictEqual(result, { reachable: true, status: 200, text: body })
  assert.strictEqual(parsePollBody(result.text).ok, true, 'the body must still parse after the read')
})

test('a body that will not parse gives up its shape and size, never its contents', () => {
  const secret = 'dt-LIVEDEVICETOKEN0123456789'
  const truncated = `{"token":"${secret}","user_id":"019ec931`

  const read = parsePollBody(truncated)

  assert.strictEqual(read.ok, false)
  assert.strictEqual(read.bytes, truncated.length)
  assert.strictEqual(read.truncated, true, 'a payload cut mid-string does not end with a closing brace')
  // The whole point. V8 embeds a slice of its input in JSON syntax errors, which
  // is why the parser's message is not among the fields this returns: whatever a
  // caller logs must not contain the credential.
  const escaped = JSON.stringify(read)
  assert.ok(!escaped.includes(secret), `the secret escaped: ${escaped}`)
  assert.ok(!escaped.includes('LIVEDEVICETOKEN'), `part of the secret escaped: ${escaped}`)
  assert.ok(!escaped.includes('token'), 'no field of the body may be carried out')
})

test('a body that ends in a brace is not blamed on truncation', () => {
  const read = parsePollBody('{"a":1}}')
  assert.strictEqual(read.ok, false)
  assert.strictEqual(read.truncated, false)
})

test('an empty body is a distinct, reportable case', () => {
  assert.deepStrictEqual(parsePollBody(''), { ok: false, bytes: 0, truncated: false, name: 'EmptyBody' })
})

test('the CN poll payload maps onto the plugin credential shape', () => {
  const parsed = parseTokenPayload(CN_PAYLOAD)

  assert.strictEqual(parsed.accessToken, CN_PAYLOAD.token)
  assert.strictEqual(parsed.expiresAt, '2026-11-15T16:39:32Z', 'the region answers an ISO string, not epoch millis')
  assert.strictEqual(parsed.uid, CN_PAYLOAD.user_id)
  assert.strictEqual(parsed.userName, undefined)
  // `drt-…` is the same refresh-token shape the plugin already reads out of the
  // app's own `auth.v1.dat`, so the login half needs no new credential plumbing.
  assert.strictEqual(parsed.refreshToken, CN_PAYLOAD.refresh_token)
  assert.strictEqual(parsed.refreshTokenId, CN_PAYLOAD.refresh_token_id)
})

test('the fixture carries the refresh material a truncated read once hid', () => {
  // The first run bounded the read at 400 characters and the cut landed before
  // `refresh_token`, so the probe reported that qoder.cn issues only a
  // refresh_token_id — a wrong "measured fact" produced entirely by the bug. It
  // issues both, and this keeps the fixture from drifting back to the truncated
  // shape and re-teaching that same wrong lesson.
  const body = JSON.stringify(CN_PAYLOAD)
  assert.ok(body.includes('"refresh_token"'), 'the region issues a `drt-` refresh token')
  assert.ok(body.includes('"refresh_token_id"'))
})

test('mask reports a secret without disclosing it', () => {
  const secret = 'dt-LIVEDEVICETOKEN0123456789'
  const masked = mask(secret)

  assert.ok(!masked.includes(secret))
  assert.ok(!masked.includes('LIVEDEVICETOKEN'))
  assert.ok(masked.includes(String(secret.length)))
  assert.strictEqual(mask(''), 'absent')
  assert.strictEqual(mask(undefined), 'absent')
})

test('bodyForDisplay bounds the print and still reports the real size', () => {
  const long = 'x'.repeat(500)
  const shown = bodyForDisplay(long)

  assert.ok(shown.length < long.length, 'the display must be bounded')
  assert.ok(shown.includes('500'), 'the real size must survive the bound')
  assert.strictEqual(bodyForDisplay('short'), 'short')
  assert.strictEqual(bodyForDisplay(''), '<empty>')
})

/**
 * The shape the live refresh endpoint answers with: new token material, no uid.
 * Both regions returned exactly this, and rebuilding a credential from it alone
 * is what drew `{"code":"101","message":"Signature invalid"}` from both of them.
 */
const ROTATED = {
  token: 'dt-ROTATED0000000000000000',
  refresh_token: 'drt-ROTATED000000000000000',
  expires_at: '2026-11-15T16:46:38Z',
}

/** Serves the refresh POST and then the model list the rotated credential must pass. */
function refreshFetch(calls) {
  return async (url, init) => {
    calls.push({ url: String(url), init })
    return String(url).includes('/deviceToken/refresh')
      ? { ok: true, status: 200, text: async () => JSON.stringify(ROTATED) }
      : { ok: true, status: 200, text: async () => JSON.stringify({ chat: new Array(14).fill({}) }) }
  }
}

/** Run `body` with console.log captured, and hand back what it printed. */
async function capturingConsole(body) {
  const lines = []
  const original = console.log
  console.log = (...args) => lines.push(args.join(' '))
  try {
    return { result: await body(), output: lines.join('\n') }
  } finally {
    console.log = original
  }
}

test('refresh posts the refresh token and machine id, then re-checks the gateway', async () => {
  const calls = []
  const { result } = await capturingConsole(() =>
    refreshStep(REGION, SESSION, parseTokenPayload(CN_PAYLOAD), refreshFetch(calls)),
  )

  assert.strictEqual(result, true)
  const refresh = calls.find((call) => call.url.includes('/deviceToken/refresh'))
  assert.ok(refresh, 'the refresh endpoint must be called')
  assert.strictEqual(refresh.init.method, 'POST')
  assert.strictEqual(refresh.init.headers['Content-Type'], 'application/json')
  // The body shape is the part taken from the reference implementation, so it is
  // pinned: a refresh token and a machine id, and nothing else.
  assert.deepStrictEqual(JSON.parse(refresh.init.body), {
    refresh_token: CN_PAYLOAD.refresh_token,
    machine_id: SESSION.machineId,
  })
  assert.strictEqual(calls.length, 2, 'the rotated credential must be re-checked against the model list')

  // The live failure this pins down: `authHeaders` sends the uid here in the
  // clear and inside the signed info block, so an empty one is refused. The
  // refresh response carries no uid, and the overlay is what puts it back.
  const listCall = calls.find((call) => !call.url.includes('/deviceToken/refresh'))
  assert.ok(listCall, 'the model list must be called with the rotated credential')
  assert.strictEqual(listCall.init.headers['Cosy-User'], CN_PAYLOAD.user_id)
})

test('a rotation is overlaid on the credential, never substituted for it', () => {
  const merged = mergeRotation(parseTokenPayload(CN_PAYLOAD), parseTokenPayload(ROTATED))

  assert.strictEqual(merged.uid, CN_PAYLOAD.user_id, 'a uid the response omits must survive')
  assert.strictEqual(merged.accessToken, ROTATED.token)
  assert.strictEqual(merged.refreshToken, ROTATED.refresh_token)
  assert.strictEqual(credentialOf(merged, 'machine-1').userID, CN_PAYLOAD.user_id)
  // Substituting the response would send this empty string to the gateway.
  assert.strictEqual(credentialOf(parseTokenPayload(ROTATED), 'machine-1').userID, '')
})

test('a successful rotation reports the new tokens without printing them', async () => {
  const { result, output } = await capturingConsole(() =>
    refreshStep(REGION, SESSION, parseTokenPayload(CN_PAYLOAD), refreshFetch([])),
  )

  assert.strictEqual(result, true)
  assert.ok(output.includes('REFRESH WORKS'))
  // The defect this whole file grew out of: a credential reaching the log.
  assert.ok(!output.includes(ROTATED.token), 'the rotated access token must not be printed')
  assert.ok(!output.includes(ROTATED.refresh_token), 'the rotated refresh token must not be printed')
  assert.ok(!output.includes(CN_PAYLOAD.refresh_token), 'the incoming refresh token must not be printed')
})

test('a refused refresh says so and does not echo the refused body', async () => {
  const { result, output } = await capturingConsole(() =>
    refreshStep(REGION, SESSION, parseTokenPayload(CN_PAYLOAD), async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":"dt-SECRETVALUE1234567890"}',
    })),
  )

  assert.strictEqual(result, false)
  assert.ok(output.includes('REFUSED'))
  assert.ok(output.includes('re-login required'), 'a rejected refresh token means sign in again')
  assert.ok(!output.includes('SECRETVALUE'), 'the 401 path must not echo the body')
})

test('a login that issued no refresh token is not reported as a rotation failure', async () => {
  const { result, output } = await capturingConsole(() =>
    refreshStep(REGION, SESSION, { accessToken: 'dt-x', refreshToken: undefined }, async () => {
      throw new Error('this fake must never be called')
    }),
  )

  assert.strictEqual(result, false)
  assert.ok(output.includes('nothing to rotate'))
})
