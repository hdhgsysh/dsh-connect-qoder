/**
 * src/host/device-login.ts — the pure device-login protocol layer.
 *
 * Everything here runs offline. There is no `fetch` anywhere in this file except
 * the injected stand-ins, so a broken test can never reach qoder.cn and a
 * passing test can never depend on it.
 *
 * The fixtures are the MEASURED wire shapes, copied from the instrument that
 * produced them (`probe/qoder-device-login.mjs`, `test/probe-device-login.test.js`)
 * rather than invented: the shapes are the protocol, and a fixture that drifts
 * takes the test's meaning with it. The refresh fixture carries a key-set
 * assertion for exactly that reason.
 */
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEVICE_PRODUCTS,
  POLL_PATH,
  REFRESH_PATH,
  REQUEST_TIMEOUT_MS,
  buildAuthUrl,
  buildPollUrl,
  createDeviceSession,
  createPkce,
  mergeRotation,
  parseDeviceTokenPayload,
  pollOnce,
  productForRegion,
  refreshOnce,
} from '../src/host/device-login.ts'

const CN = 'qoder-cn'
const INTL = 'qoder'

const cn = productForRegion(CN)
const intl = productForRegion(INTL)
assert.ok(cn, 'the qoder-cn product must exist')
assert.ok(intl, 'the qoder product must exist')

/** The shape qoder.cn actually answered with; the token values are placeholders. */
const POLL_BODY = {
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

/**
 * The shape the live refresh endpoint answered with, on both regions: six
 * fields, the access token spelled `device_token`, and NO uid. Rebuilding a
 * credential from this alone is what drew `{"code":"101","message":"Signature
 * invalid"}` from both of them.
 */
const ROTATED_BODY = {
  created_at: '2026-10-16T16:44:38',
  device_token: 'dt-ROTATED0000000000000000',
  expires_at: '2026-11-15T16:46:38Z',
  refresh_token: 'drt-ROTATED000000000000000',
  refresh_token_expires_at: '2027-10-11T16:46:38Z',
  token_type: 'Bearer',
}

/** The credential being rotated — the account identity the response omits. */
const CREDENTIAL = {
  token: 'dt-OLD00000000000000000000',
  refreshToken: 'drt-OLD0000000000000000000',
  expiresAt: 1_760_000_000_000,
  refreshTokenExpiresAt: 1_790_000_000_000,
  userID: '019ec931-baf3-7de9-8363-65fbacc369b4',
  name: '示例用户',
  email: 'user@example.test',
}

const MACHINE_ID = '8b1b2f6e-0000-4000-8000-000000000001'

/** A `fetch` stand-in that records every call and never opens a socket. */
function recordingFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(url, init)
  }
  return { impl, calls }
}

/** A `Response`-shaped object carrying just the fields this module reads. */
function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => body }
}

/** base64url(sha256(verifier)) — RFC 7636's recipe, computed here independently. */
function s256(verifier) {
  return createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A session with fixed material, so URL assertions can be exact. */
function fixedSession(regionId) {
  return { region: regionId, verifier: 'v'.repeat(43), challenge: 'CHALLENGE-abc123', nonce: 'NONCE-1', machineID: 'MACHINE-1' }
}

test('productForRegion knows exactly the two measured products', () => {
  assert.strictEqual(cn.region, CN)
  assert.strictEqual(cn.authBase, 'https://qoder.cn')
  assert.strictEqual(cn.openApiBase, 'https://openapi.qoder.com.cn')
  // Pinned, not merely read back: this id was measured end to end against
  // qoder.cn, and a typo here fails only after a human has approved a login.
  assert.strictEqual(cn.clientId, '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa')

  assert.strictEqual(intl.region, INTL)
  assert.strictEqual(intl.authBase, 'https://qoder.com')
  assert.strictEqual(intl.openApiBase, 'https://openapi.qoder.sh')
  assert.strictEqual(intl.clientId, 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb')
})

test('a region nobody measured has no product, including the inherited names', () => {
  assert.strictEqual(productForRegion('qoder-global'), undefined)
  assert.strictEqual(productForRegion('Qoder-CN'), undefined)
  assert.strictEqual(productForRegion(''), undefined)
  // `Object.prototype`'s names answer a bare index with a function that has no
  // authBase or clientId — a wrong answer shaped like a right one, which would
  // build `undefined/device/selectAccounts`.
  assert.strictEqual(productForRegion('toString'), undefined)
  assert.strictEqual(productForRegion('constructor'), undefined)
  assert.strictEqual(productForRegion('__proto__'), undefined)
})

test('the two products share their client metadata and differ in every endpoint', () => {
  assert.deepStrictEqual(cn.clientMetadata, {
    client_type: '5',
    business_product: 'cli',
    business_type: 'agent',
    scene: 'assistant',
  })
  assert.deepStrictEqual(intl.clientMetadata, cn.clientMetadata)
  assert.notStrictEqual(cn.authBase, intl.authBase)
  assert.notStrictEqual(cn.openApiBase, intl.openApiBase)
  assert.notStrictEqual(cn.clientId, intl.clientId)
  assert.deepStrictEqual(Object.keys(DEVICE_PRODUCTS).sort(), [INTL, CN].sort())
})

test('buildAuthUrl carries every parameter the authorize page reads', () => {
  const session = fixedSession(CN)
  const url = new URL(buildAuthUrl(cn, session))

  assert.strictEqual(url.origin, 'https://qoder.cn')
  assert.strictEqual(url.pathname, '/device/selectAccounts')
  assert.strictEqual(url.searchParams.get('challenge'), session.challenge)
  assert.strictEqual(url.searchParams.get('challenge_method'), 'S256')
  assert.strictEqual(url.searchParams.get('nonce'), session.nonce)
  assert.strictEqual(url.searchParams.get('machine_id'), session.machineID)
  assert.strictEqual(url.searchParams.get('client_id'), cn.clientId)
  assert.deepStrictEqual([...url.searchParams.keys()].sort(), ['challenge', 'challenge_method', 'client_id', 'machine_id', 'nonce'])
})

test('each region is sent to its own authorize host with its own client id', () => {
  const cnUrl = new URL(buildAuthUrl(cn, fixedSession(CN)))
  const intlUrl = new URL(buildAuthUrl(intl, fixedSession(INTL)))

  assert.strictEqual(cnUrl.origin, 'https://qoder.cn')
  assert.strictEqual(intlUrl.origin, 'https://qoder.com')
  assert.strictEqual(cnUrl.searchParams.get('client_id'), cn.clientId)
  assert.strictEqual(intlUrl.searchParams.get('client_id'), intl.clientId)
})

test("buildPollUrl targets the region's own OpenAPI host, not its auth host", () => {
  const session = fixedSession(CN)
  const url = new URL(buildPollUrl(cn, session))

  assert.strictEqual(url.origin, 'https://openapi.qoder.com.cn')
  assert.notStrictEqual(url.origin, cn.authBase)
  assert.strictEqual(url.pathname, POLL_PATH)
  assert.strictEqual(url.searchParams.get('nonce'), session.nonce)
  assert.strictEqual(url.searchParams.get('verifier'), session.verifier)
  assert.strictEqual(url.searchParams.get('challenge_method'), 'S256')

  // The failure mode this pins: building the poll against authBase answers 404
  // forever, which reads as "the user never approved" on the CN region only.
  assert.strictEqual(new URL(buildPollUrl(intl, fixedSession(INTL))).origin, 'https://openapi.qoder.sh')
  assert.notStrictEqual(new URL(buildPollUrl(cn, session)).origin, new URL(buildPollUrl(intl, session)).origin)
})

test('a verifier survives the poll URL round trip, whatever it contains', () => {
  // `~`, `.` and `-` are all in the PKCE alphabet and not all of them are
  // query-safe; URLSearchParams is what keeps the verifier one parameter instead
  // of several.
  const verifier = 'a~b.c-d_e~f'.repeat(6)
  const session = { ...fixedSession(CN), verifier }
  const url = new URL(buildPollUrl(cn, session))

  assert.strictEqual(url.searchParams.get('verifier'), verifier)
  assert.ok(!url.search.includes('~'), 'the raw tilde must not reach the wire unescaped')
})

test('createPkce draws the verifier length from rand and its characters are never random', () => {
  assert.strictEqual(createPkce(() => 0).verifier.length, 43, "the measured formula's floor is RFC 7636's 43")
  assert.strictEqual(createPkce(() => 0.999999).verifier.length, 128, 'the measured formula tops out at 128')

  for (let i = 0; i < 200; i += 1) {
    const { verifier } = createPkce()
    assert.ok(verifier.length >= 43 && verifier.length <= 128, `length out of range: ${verifier.length}`)
    assert.match(verifier, /^[A-Za-z0-9\-._~]+$/, 'only RFC 7636 unreserved characters')
  }
})

test('the challenge is base64url(sha256(verifier)), checked against RFC 7636', () => {
  // The published vector first: it is what makes the recipe in this test a
  // reference rather than a second copy of the module's own mistake.
  assert.strictEqual(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')

  const { verifier, challenge } = createPkce(() => 0.5)
  assert.strictEqual(challenge, s256(verifier))
  assert.ok(!challenge.includes('='), 'padding is stripped')
  assert.ok(!challenge.includes('+') && !challenge.includes('/'), 'base64url, not base64')
})

test('two attempts never share a verifier, even with the same rand', () => {
  const first = createPkce(() => 0.5)
  const second = createPkce(() => 0.5)
  assert.notStrictEqual(first.verifier, second.verifier, 'the length is injected; the secret must not be')
  assert.notStrictEqual(first.challenge, second.challenge)
})

test('createDeviceSession mints a fresh attempt for a region it knows', () => {
  const session = createDeviceSession(CN)

  assert.strictEqual(session.region, CN)
  assert.strictEqual(session.challenge, s256(session.verifier))
  assert.match(session.nonce, /^[0-9a-f-]{36}$/)
  assert.match(session.machineID, /^[0-9a-f-]{36}$/)
  assert.notStrictEqual(createDeviceSession(CN).nonce, session.nonce)

  // The caller must be able to keep the machine id it issued the login with:
  // the poll envelope never publishes one, and the refresh has to send it back.
  assert.strictEqual(createDeviceSession(CN, MACHINE_ID).machineID, MACHINE_ID)
})

test('createDeviceSession refuses a region nothing can build a URL for', () => {
  assert.throws(() => createDeviceSession('qoder-x'), /no device-login product for region qoder-x/)
})

test('parseDeviceTokenPayload reads all three spellings of the access token', () => {
  for (const key of ['token', 'device_token', 'access_token']) {
    const parsed = parseDeviceTokenPayload({ [key]: `dt-${key}` })
    assert.strictEqual(parsed?.token, `dt-${key}`, `${key} must be an access token`)
  }
  // When an envelope somehow carries several, the poll envelope's own spelling
  // wins, so the choice is not left to property order.
  assert.strictEqual(parseDeviceTokenPayload({ token: 'a', device_token: 'b', access_token: 'c' })?.token, 'a')
})

test('second-based timestamps become milliseconds and millisecond ones do not', () => {
  assert.strictEqual(parseDeviceTokenPayload({ token: 't', expires_at: 1_750_000_000 })?.expiresAt, 1_750_000_000_000)
  assert.strictEqual(parseDeviceTokenPayload({ token: 't', expires_at: 1_790_000_000_000 })?.expiresAt, 1_790_000_000_000)
  assert.strictEqual(
    parseDeviceTokenPayload({ token: 't', refresh_token_expires_at: 1_800_000_000 })?.refreshTokenExpiresAt,
    1_800_000_000_000,
  )
  // A numeric string is what a JSON body written by a stringly-typed service
  // looks like, and reading it as 0 would make the credential look expired.
  assert.strictEqual(parseDeviceTokenPayload({ token: 't', expires_at: '1750000000' })?.expiresAt, 1_750_000_000_000)
})

test('the ISO-8601 timestamps qoder.cn actually answers are converted too', () => {
  // Measured: the poll payload's `expires_at` is an ISO string, not epoch at all.
  assert.strictEqual(parseDeviceTokenPayload(POLL_BODY)?.expiresAt, Date.parse('2026-11-15T16:39:32Z'))
  assert.strictEqual(
    parseDeviceTokenPayload(POLL_BODY)?.refreshTokenExpiresAt,
    Date.parse('2027-10-11T16:39:32Z'),
  )
  assert.strictEqual(
    parseDeviceTokenPayload({ token: 't', expiresAt: '2026-11-15T16:39:32+08:00' })?.expiresAt,
    Date.parse('2026-11-15T16:39:32+08:00'),
  )
})

test('every optional field has a camelCase spelling as well as a snake one', () => {
  const parsed = parseDeviceTokenPayload({
    access_token: 'dt-1',
    refreshToken: 'drt-1',
    expiresAt: 1_750_000_000,
    refreshTokenExpiresAt: 1_800_000_000,
    userId: 'u-1',
    userName: 'Ada',
    user_email: 'ada@example.test',
  })

  assert.deepStrictEqual(parsed, {
    token: 'dt-1',
    refreshToken: 'drt-1',
    expiresAt: 1_750_000_000_000,
    refreshTokenExpiresAt: 1_800_000_000_000,
    userID: 'u-1',
    name: 'Ada',
    email: 'ada@example.test',
  })
})

test('the measured poll envelope reads out whole', () => {
  assert.deepStrictEqual(parseDeviceTokenPayload(POLL_BODY), {
    token: POLL_BODY.token,
    refreshToken: POLL_BODY.refresh_token,
    expiresAt: Date.parse(POLL_BODY.expires_at),
    refreshTokenExpiresAt: Date.parse(POLL_BODY.refresh_token_expires_at),
    userID: POLL_BODY.user_id,
    name: '',
    email: '',
  })
})

test('a field the envelope omitted is empty, never the string "undefined"', () => {
  // Ship history: a machine fingerprint went upstream as the literal text
  // "undefined" because an absent field was stringified instead of defaulted.
  assert.deepStrictEqual(parseDeviceTokenPayload({ token: 't' }), {
    token: 't',
    refreshToken: '',
    expiresAt: 0,
    refreshTokenExpiresAt: 0,
    userID: '',
    name: '',
    email: '',
  })
})

test('a body with no usable access token is not a payload', () => {
  for (const body of [null, undefined, 'x', '', 42, 0, [], {}, { user_id: 'u' }, { token: '' }, { token: 12345 }, true]) {
    assert.strictEqual(parseDeviceTokenPayload(body), undefined, `${JSON.stringify(body) ?? String(body)} is not a payload`)
  }
})

test('parseDeviceTokenPayload never throws, on any input at all', () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('a hostile accessor')
      },
    },
  )
  const throwingToString = {
    token: {
      toString() {
        throw new Error('no')
      },
    },
  }

  for (const body of [hostile, throwingToString, Symbol('s'), () => 't', new Map([['token', 't']])]) {
    assert.strictEqual(parseDeviceTokenPayload(body), undefined)
  }
})

test('a 404 from the poll endpoint is a pending login, not a failure', async () => {
  const { impl, calls } = recordingFetch(async () => jsonResponse(404, ''))

  const outcome = await pollOnce(cn, fixedSession(CN), impl)

  assert.deepStrictEqual(outcome, { kind: 'pending' })
  assert.strictEqual(calls.length, 1, 'one call per invocation: the caller owns the loop')
})

test('a 200 whose envelope carries no token yet is still pending', async () => {
  // The service answers before authorisation lands. An empty envelope is that
  // state; an empty BODY is its most literal form, and neither may be reported
  // as a failure while the caller still has budget.
  const emptyEnvelope = await pollOnce(cn, fixedSession(CN), async () => jsonResponse(200, '{}'))
  assert.deepStrictEqual(emptyEnvelope, { kind: 'pending' })

  const emptyBody = await pollOnce(cn, fixedSession(CN), async () => jsonResponse(200, ''))
  assert.deepStrictEqual(emptyBody, { kind: 'pending' })

  const noToken = await pollOnce(cn, fixedSession(CN), async () => jsonResponse(200, JSON.stringify({ code: 0, data: {} })))
  assert.deepStrictEqual(noToken, { kind: 'pending' })
})

test('a 200 carrying the measured envelope is an authorization', async () => {
  const { impl } = recordingFetch(async () => jsonResponse(200, JSON.stringify(POLL_BODY)))

  const outcome = await pollOnce(cn, fixedSession(CN), impl)

  assert.strictEqual(outcome.kind, 'authorized')
  assert.strictEqual(outcome.payload.token, POLL_BODY.token)
  assert.strictEqual(outcome.payload.refreshToken, POLL_BODY.refresh_token)
  assert.strictEqual(outcome.payload.userID, POLL_BODY.user_id)
  assert.strictEqual(outcome.payload.expiresAt, Date.parse(POLL_BODY.expires_at))
})

test('the poll call is a GET to this region\'s poll URL and nowhere else', async () => {
  const session = fixedSession(INTL)
  const { impl, calls } = recordingFetch(async () => jsonResponse(404, ''))

  await pollOnce(intl, session, impl)

  const [call] = calls
  assert.strictEqual(call.url, buildPollUrl(intl, session))
  assert.ok(call.url.startsWith('https://openapi.qoder.sh'))
  assert.ok(!call.url.includes('https://qoder.com'), 'never the authorize host')
  assert.strictEqual(call.init.method, 'GET')
  assert.strictEqual(call.init.headers.Accept, 'application/json')
  assert.strictEqual(call.init.redirect, 'error')
  assert.ok(call.init.signal instanceof AbortSignal, 'the per-request timeout travels with the request')
  assert.strictEqual(REQUEST_TIMEOUT_MS, 30_000)
})

test('a refused poll reports the status it was given', async () => {
  const fiveHundred = await pollOnce(cn, fixedSession(CN), async () => jsonResponse(500, '{"message":"boom"}'))
  assert.deepStrictEqual(fiveHundred, { kind: 'failed', name: 'Http500' })

  // Unlike a refresh, a 401/403 here is not an expiry — there is no credential
  // yet to expire — so it keeps its status and reaches the user as a failure.
  assert.deepStrictEqual(await pollOnce(cn, fixedSession(CN), async () => jsonResponse(403, '')), {
    kind: 'failed',
    name: 'Http403',
  })
})

test('a poll that throws is an outcome the host can report, not a rejection', async () => {
  const { impl } = recordingFetch(async () => {
    throw new TypeError('fetch failed')
  })

  const outcome = await pollOnce(cn, fixedSession(CN), impl)

  assert.deepStrictEqual(outcome, { kind: 'failed', name: 'TypeError' })
})

test('a poll body that will not parse fails without quoting the body', async () => {
  const secret = 'dt-LIVEDEVICETOKEN0123456789'
  const { impl } = recordingFetch(async () => jsonResponse(200, `{"token":"${secret}","user_id":"019ec931`))

  const outcome = await pollOnce(cn, fixedSession(CN), impl)

  assert.deepStrictEqual(outcome, { kind: 'failed', name: 'UnparseableBody' })
  // V8 embeds a slice of its input in a JSON syntax error; the module contributes
  // only a literal name, so nothing a caller logs can contain the credential.
  const serialized = JSON.stringify(outcome)
  assert.ok(!serialized.includes(secret) && !serialized.includes('LIVEDEVICETOKEN'), `a token escaped: ${serialized}`)
})

test("refresh posts the refresh token and machine id to the region's own OpenAPI host", async () => {
  const { impl, calls } = recordingFetch(async () => jsonResponse(200, JSON.stringify(ROTATED_BODY)))

  await refreshOnce(cn, CREDENTIAL, MACHINE_ID, impl)
  await refreshOnce(intl, CREDENTIAL, MACHINE_ID, impl)

  const [cnCall, intlCall] = calls
  assert.strictEqual(cnCall.url, `https://openapi.qoder.com.cn${REFRESH_PATH}`)
  assert.strictEqual(intlCall.url, `https://openapi.qoder.sh${REFRESH_PATH}`)
  assert.strictEqual(cnCall.init.method, 'POST')
  assert.strictEqual(cnCall.init.headers['Content-Type'], 'application/json')
  assert.strictEqual(cnCall.init.headers.Accept, 'application/json')
  assert.ok(cnCall.init.signal instanceof AbortSignal)
  // Pinned to the measured body: a refresh token and a machine id, nothing else.
  assert.deepStrictEqual(JSON.parse(cnCall.init.body), { refresh_token: CREDENTIAL.refreshToken, machine_id: MACHINE_ID })
})

test('a 401 or a 403 means the refresh token is gone, and that is not a failure', async () => {
  assert.deepStrictEqual(await refreshOnce(cn, CREDENTIAL, MACHINE_ID, async () => jsonResponse(401, '')), { kind: 'expired' })
  assert.deepStrictEqual(await refreshOnce(cn, CREDENTIAL, MACHINE_ID, async () => jsonResponse(403, '')), { kind: 'expired' })
})

test('a credential with no refresh token never reaches the network', async () => {
  const { impl, calls } = recordingFetch(async () => jsonResponse(200, JSON.stringify(ROTATED_BODY)))

  const outcome = await refreshOnce(cn, { ...CREDENTIAL, refreshToken: '' }, MACHINE_ID, impl)

  assert.deepStrictEqual(outcome, { kind: 'expired' })
  assert.strictEqual(calls.length, 0, 'an empty refresh token is a 401 at best and a rate limit at worst')
})

test('a failing refresh keeps its status and does not masquerade as an expiry', async () => {
  assert.deepStrictEqual(await refreshOnce(cn, CREDENTIAL, MACHINE_ID, async () => jsonResponse(500, '')), {
    kind: 'failed',
    name: 'Http500',
  })
  assert.deepStrictEqual(await refreshOnce(cn, CREDENTIAL, MACHINE_ID, async () => jsonResponse(429, '')), {
    kind: 'failed',
    name: 'Http429',
  })
})

test('a refresh that throws or answers nonsense is an outcome, never a rejection', async () => {
  const { impl } = recordingFetch(async () => {
    throw new TypeError('socket hang up')
  })
  assert.deepStrictEqual(await refreshOnce(cn, CREDENTIAL, MACHINE_ID, impl), { kind: 'failed', name: 'TypeError' })

  const empty = await refreshOnce(cn, CREDENTIAL, MACHINE_ID, async () => jsonResponse(200, ''))
  assert.deepStrictEqual(empty, { kind: 'failed', name: 'EmptyBody' })

  // A 200 with no token in it is a protocol surprise: reporting "refreshed"
  // would store the credential we already know is dead.
  const noToken = await refreshOnce(cn, CREDENTIAL, MACHINE_ID, async () => jsonResponse(200, '{}'))
  assert.deepStrictEqual(noToken, { kind: 'failed', name: 'NoToken' })
})

test('the rotation fixture is the measured refresh response, not a convenient one', () => {
  // If someone "fixes" this fixture by adding a `user_id` or renaming
  // `device_token` back to `token`, the trap test below quietly stops testing
  // anything. This assertion is the tripwire.
  assert.deepStrictEqual(Object.keys(ROTATED_BODY).sort(), [
    'created_at',
    'device_token',
    'expires_at',
    'refresh_token',
    'refresh_token_expires_at',
    'token_type',
  ])
  assert.ok(!('user_id' in ROTATED_BODY), 'the live refresh response carries no uid')
  assert.ok(!('token' in ROTATED_BODY), 'the live refresh response spells it `device_token`')
})

test('a rotation keeps the uid the refresh response never carried', async () => {
  const { impl } = recordingFetch(async () => jsonResponse(200, JSON.stringify(ROTATED_BODY)))

  const outcome = await refreshOnce(cn, CREDENTIAL, MACHINE_ID, impl)

  assert.strictEqual(outcome.kind, 'refreshed')
  // The trap: returning the parsed response instead of the merge signs an empty
  // uid, and both regions answer 403 {"code":"101","message":"Signature invalid"}.
  assert.strictEqual(outcome.payload.userID, CREDENTIAL.userID, 'a uid the response omits must survive the merge')
  assert.strictEqual(outcome.payload.name, CREDENTIAL.name)
  assert.strictEqual(outcome.payload.email, CREDENTIAL.email)
  // ...while everything the rotation does carry is taken from it.
  assert.strictEqual(outcome.payload.token, ROTATED_BODY.device_token)
  assert.strictEqual(outcome.payload.refreshToken, ROTATED_BODY.refresh_token)
  assert.strictEqual(outcome.payload.expiresAt, Date.parse(ROTATED_BODY.expires_at))
  assert.strictEqual(outcome.payload.refreshTokenExpiresAt, Date.parse(ROTATED_BODY.refresh_token_expires_at))
})

test('the probe\'s older three-field refresh shape rotates the same way', async () => {
  const probeShaped = { token: 'dt-ROTATED-PROBE', refresh_token: 'drt-ROTATED-PROBE', expires_at: '2026-11-15T16:46:38Z' }
  const { impl } = recordingFetch(async () => jsonResponse(200, JSON.stringify(probeShaped)))

  const outcome = await refreshOnce(cn, CREDENTIAL, MACHINE_ID, impl)

  assert.strictEqual(outcome.kind, 'refreshed')
  assert.strictEqual(outcome.payload.token, probeShaped.token)
  assert.strictEqual(outcome.payload.refreshToken, probeShaped.refresh_token)
  assert.strictEqual(outcome.payload.userID, CREDENTIAL.userID)
  // The response said nothing about the refresh token's own expiry, so the value
  // that was already there stands rather than being zeroed into "expired".
  assert.strictEqual(outcome.payload.refreshTokenExpiresAt, CREDENTIAL.refreshTokenExpiresAt)
})

test('mergeRotation overlays only what the rotation carries, and keeps the original', () => {
  const original = { ...CREDENTIAL }
  const rotated = {
    token: 'dt-NEW',
    refreshToken: '',
    expiresAt: 1_761_000_000_000,
    refreshTokenExpiresAt: 0,
    userID: '',
    name: '',
    email: 'new@example.test',
  }

  const merged = mergeRotation(original, rotated)

  assert.deepStrictEqual(merged, {
    token: 'dt-NEW',
    refreshToken: original.refreshToken,
    expiresAt: 1_761_000_000_000,
    refreshTokenExpiresAt: original.refreshTokenExpiresAt,
    userID: original.userID,
    name: original.name,
    email: 'new@example.test',
  })
  assert.deepStrictEqual(original, CREDENTIAL, 'the credential being rotated is not mutated in place')
  assert.notStrictEqual(merged, original)
})

test('mergeRotation takes every rotated field when the rotation carries them all', () => {
  const rotated = {
    token: 'dt-NEW',
    refreshToken: 'drt-NEW',
    expiresAt: 1_761_000_000_000,
    refreshTokenExpiresAt: 1_800_000_000_000,
    userID: 'u-new',
    name: 'Ada',
    email: 'ada@example.test',
  }

  assert.deepStrictEqual(mergeRotation(CREDENTIAL, rotated), rotated)
})
