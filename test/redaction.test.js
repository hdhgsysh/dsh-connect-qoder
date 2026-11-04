/**
 * A credential must not reach a message — not even inside an upstream body.
 *
 * Run: node --test test/redaction.test.js
 *
 * The plugin's threat model (`src/host/handlers.ts`) says a credential only
 * travels in an `Authorization` header and never inside a URL, so a credential
 * should not be able to reach a log. That rule holds for the requests this
 * plugin MAKES. It does not cover the bytes it RECEIVES: an error body is
 * copied into a message verbatim in a dozen places, and a gateway or proxy that
 * echoes the request headers back — they do — carries the `Authorization` value
 * straight into the panel and into `$DSH_HOME/logs`.
 *
 * So `redactSecrets` in `src/host/errors.ts` is the second layer: it scrubs
 * credential-SHAPED substrings out of text that is about to be shown or logged.
 * These cases pin the shapes it covers, and — as importantly — pin that it
 * leaves ordinary prose alone, because a redaction that eats the words of a
 * diagnosis costs more than it buys.
 *
 * The second half of the file pins the CALL SITES: the shape rules are worth
 * nothing if the upstream body reaches the message without passing through
 * them, and the slice that trims the body is exactly where a credential can
 * ride the tail out in pieces (the rule is: redact BEFORE the slice).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { redactSecrets } from '../src/host/errors.ts'
import { fetchModels, readJson } from '../src/host/upstream/api-calls.ts'

/** @type {import('../src/host/domain.ts').Region} */
const REGION = {
  id: 'qoder-cn',
  mode: 'cn',
  displayName: 'Qoder CN',
  appNames: ['Qoder'],
  baseUrl: 'https://api.qoder.com.cn/',
  openApiUrl: 'https://openapi.qoder.com.cn/',
  centerUrl: 'https://center.qoder.com.cn/',
  manageUrl: 'https://manage.qoder.com.cn/',
  downloadUrl: 'https://download.qoder.com.cn/',
  patEnvNames: ['QODER_PAT'],
}

/** @type {import('../src/host/domain.ts').QoderCredential} */
const CREDENTIAL = { userID: 'u-test', token: 'tok-test' }

/** A JWT-shaped string, the shape a token takes when the upstream names it in prose. */
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlX2hlcmU'

/**
 * Run `run` with a stubbed `fetch` and restore the global afterwards.
 * @param {typeof globalThis.fetch} impl - the stub.
 * @param {() => Promise<unknown>} run - what to do while the stub is in place.
 * @returns {Promise<unknown>} whatever `run` returned.
 */
async function withFetch(impl, run) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

/**
 * One reply, the shape every route answers with.
 * @param {number} status - the HTTP status.
 * @param {string} body - the reply body.
 * @returns {typeof globalThis.fetch} a fetch stub answering with it.
 */
function reply(status, body) {
  return async () => new Response(body, { status })
}

test('an echoed Authorization header loses its value', () => {
  const out = redactSecrets('Authorization: Bearer abcdef0123456789')
  assert.doesNotMatch(out, /abcdef0123456789/, 'the credential must not survive')
  assert.match(out, /\[REDACTED\]/, 'the shape of the redaction must be visible')
})

test('a bare Bearer credential loses its value', () => {
  const out = redactSecrets('the gateway said: Bearer abcdef0123456789 rejected')
  assert.doesNotMatch(out, /abcdef0123456789/)
  assert.match(out, /Bearer \[REDACTED\]/, 'the scheme is kept — it is the diagnosis')
})

test('a cookie jar is dropped whole', () => {
  const out = redactSecrets('Set-Cookie: session=deadbeefdeadbeef; Path=/')
  assert.doesNotMatch(out, /deadbeefdeadbeef/)
})

test('a JWT with no key name in front of it is recognised by its shape', () => {
  // The key-name rules cannot cover a field name nobody has seen, so the shape
  // is what covers this one.
  const out = redactSecrets(`request rejected, token ${JWT}`)
  assert.doesNotMatch(out, /eyJhbGciOiJIUzI1NiJ9/)
  assert.match(out, /token \[REDACTED\]/)
})

test('the sk- and cpk- prefixes are recognised', () => {
  for (const secret of ['sk-abcdef0123456789', 'cpk-abcdef0123456789']) {
    assert.doesNotMatch(redactSecrets(`key=${secret}`), new RegExp(secret))
  }
})

test('a named secret in a JSON shape loses its value', () => {
  const out = redactSecrets('{"access_token":"abcdef0123456789","reason":"expired"}')
  assert.doesNotMatch(out, /abcdef0123456789/)
  assert.match(out, /reason/, 'the rest of the body must stay readable')
})

test('a named secret in a key=value shape loses its value', () => {
  const out = redactSecrets('token=abcdef0123456789&reason=expired')
  assert.doesNotMatch(out, /abcdef0123456789/)
  assert.match(out, /reason=expired/, 'the rest of the query must stay readable')
})

test('ordinary prose about tokens is left alone', () => {
  // The cost side of the trade: a redaction that eats the words of a diagnosis
  // is worse than the leak it prevents, because the leak is hypothetical and
  // the diagnosis is not.
  for (const prose of [
    'the token is expired',
    'Login expired, please sign in again',
    'daily request allowance for this account is used up',
    'Qoder chat failed: HTTP 500 Internal Server Error',
  ]) {
    assert.strictEqual(redactSecrets(prose), prose, `must not touch: ${prose}`)
  }
})

test('an upstream body that echoes a credential does not reach the message', async () => {
  // The call site, not the rule: the body is the upstream's bytes, and this is
  // where they would otherwise become a panel message.
  const body = JSON.stringify({ message: 'Authorization: Bearer abcdef0123456789', reason: 'nope' })
  const thrown = await withFetch(reply(500, body), () =>
    fetchModels(REGION, CREDENTIAL).then(
      () => undefined,
      (error) => error,
    ),
  )
  assert.ok(thrown instanceof Error, 'the read must fail')
  assert.doesNotMatch(thrown.message, /abcdef0123456789/, 'the credential must not reach the message')
  assert.match(thrown.message, /reason/, 'the rest of the body must stay readable')
})

test('a credential riding the tail of a body is cut in half, and the half is still caught', async () => {
  // The slice is the trap: trimming first would leave a fragment of the
  // credential, and a fragment matches no shape rule.
  const padded = 'x'.repeat(200) + ' Authorization: Bearer abcdef0123456789'
  const thrown = await withFetch(reply(500, padded), () =>
    fetchModels(REGION, CREDENTIAL).then(
      () => undefined,
      (error) => error,
    ),
  )
  assert.ok(thrown instanceof Error, 'the read must fail')
  assert.doesNotMatch(thrown.message, /abcdef0123456789/)
  assert.doesNotMatch(thrown.message, /abcdef01/, 'not even a fragment of it may survive')
})

test('a body that is not JSON does not leak a credential either', async () => {
  const thrown = await withFetch(reply(200, '<html>Authorization: Bearer abcdef0123456789</html>'), () =>
    readJson(new Response('<html>Authorization: Bearer abcdef0123456789</html>'), 'Qoder model list').then(
      () => undefined,
      (error) => error,
    ),
  )
  assert.ok(thrown instanceof Error, 'the parse must fail')
  assert.doesNotMatch(thrown.message, /abcdef0123456789/)
})
