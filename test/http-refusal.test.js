/**
 * A non-2xx reply from a one-shot OpenAPI read must arrive with its VERDICT, not
 * just its status.
 *
 * Run: node --test test/http-refusal.test.js
 *
 * docs/issues/24 is the report this file pins. The stream path had always known
 * what a failure body meant (`classifyUpstreamError`), but the five one-shot
 * readers — model list, usage, userinfo, campaigns, check-in — threw
 * `new Error('… HTTP 500 …')` and dropped the status and the body with it. Two
 * verdicts were lost, and both were the silent kind AGENTS.md red line 1
 * forbids:
 *
 *  - a spent daily allowance reached the card as a generic "刷新失败", and the
 *    local "疑似已用尽" badge could never light, because the only writer was the
 *    shim's chat path — for a limit that is per ACCOUNT, and the card polls this
 *    very route;
 *  - a 401 was indistinguishable from a network blip, so the credential the
 *    plugin caches for the life of the process was never invalidated.
 *
 * The fix gives every refusal a verdict (`classifyHttpRefusal`) carried on the
 * thrown value as plain flags (`UpstreamRefusalError`), so the consumers that
 * already read those flags — `handlers.ts`'s badge and `unavailableReason`,
 * `isStaleCredentialError` — start working for these paths too. The MESSAGES are
 * deliberately unchanged: they are what the card prints and what older tests
 * pin, so the classification rides alongside the wording, never inside it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyHttpRefusal, thrownFlag, UpstreamRefusalError } from '../src/host/errors.ts'
import { claimCampaign, fetchModels, fetchUserInfo, readCampaigns } from '../src/host/upstream/api-calls.ts'
import { fetchUsage } from '../src/host/upstream.ts'

const REGION = {
  id: 'qoder-cn',
  displayName: 'Qoder CN',
  baseUrl: 'https://openapi.qoder.com.cn/',
  openApiUrl: 'https://openapi.qoder.com.cn/',
}
const CREDENTIAL = { userID: 'u-test', token: 'tok-test', name: 'n', email: 'e@x', machineID: 'm' }

/**
 * The 429 body the report is written from, verbatim enough to matter: the prose
 * names the allowance and the code field carries the machine-readable verdict.
 * `type` (not `code`) is the field this gateway actually uses here, which is why
 * the code reader accepts both.
 */
const DAILY_LIMIT_BODY = JSON.stringify({
  message:
    "Qoder's daily request allowance for this account is used up. Waiting within the session " +
    'will not help; the off-peak price (22:00-08:00 Asia/Shanghai) and the daily check-in both still work.',
  type: 'daily_limit_exceeded',
  code: 'daily_limit_exceeded',
})

/** Run `run` with a stubbed `fetch` and restore the global afterwards. */
async function withFetch(impl, run) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

/** One JSON reply, the shape every route answers with. */
function refusal(status, body, headers = {}) {
  return async () => new Response(body, { status, headers })
}

test('classifyHttpRefusal: the body decides, and a daily limit is read before the status', () => {
  // The order is docs/issues/23's whole finding, one layer up: the gateway
  // carries a spent daily allowance ON a 429, and a status-first rule reads that
  // as "busy, retry" — the same request retried until the day rolls over.
  assert.deepStrictEqual(classifyHttpRefusal(429, DAILY_LIMIT_BODY), {
    kind: 'daily-limit',
    retryAfterSeconds: 0,
  })
  // Status-independent: the same body on a 400 is the same verdict.
  assert.strictEqual(classifyHttpRefusal(400, DAILY_LIMIT_BODY).kind, 'daily-limit')
  // Prose only, no code at all — the shape the numeric `110` era used.
  assert.strictEqual(
    classifyHttpRefusal(400, '{"message":"Billing daily count exceeded"}').kind,
    'daily-limit',
  )
})

test('classifyHttpRefusal: the code is found in every field the gateways have used', () => {
  // These four spellings are the reason the reader exists rather than a
  // `JSON.parse(...).code`: a wrong guess here is the difference between "your
  // allowance is spent" and a retry loop.
  for (const body of [
    '{"code":"daily_limit_exceeded"}',
    '{"errorCode":"daily_limit_exceeded"}',
    '{"type":"daily_limit_exceeded"}',
    '{"error":{"code":"daily_limit_exceeded"}}',
    '{"errorCode":110,"message":"Billing daily count exceeded"}',
  ]) {
    assert.strictEqual(classifyHttpRefusal(429, body).kind, 'daily-limit', `saw: ${body}`)
  }
  // A non-JSON body (an HTML error page, an empty 502) must not throw here —
  // this runs inside a catch block, where a second throw loses the first.
  assert.strictEqual(classifyHttpRefusal(429, '<html>gateway</html>').kind, 'rate-limit')
  assert.strictEqual(classifyHttpRefusal(500, '').kind, 'upstream')
})

test('classifyHttpRefusal: the status answers only when the body says nothing', () => {
  assert.strictEqual(classifyHttpRefusal(429, '').kind, 'rate-limit')
  assert.strictEqual(classifyHttpRefusal(429, '{"code":10605,"message":"queued"}').kind, 'rate-limit')
  assert.strictEqual(classifyHttpRefusal(401, '').kind, 'sign-in-expired')
  assert.strictEqual(classifyHttpRefusal(500, 'upstream is unwell').kind, 'upstream')
})

test('classifyHttpRefusal: a 403 is NOT a sign-in rejection', () => {
  // Deliberate, and the one place this differs from the credential-vault
  // exchange (which treats 401/403 alike): the international campaigns endpoint
  // is gated on machine identity and answers 403 for a perfectly good login
  // (KNOWN_GAPS §8). Reading that as a dead credential would drop a working
  // token, so only 401 — which is about the credential itself — does that.
  assert.strictEqual(classifyHttpRefusal(403, '').kind, 'upstream')
  assert.strictEqual(classifyHttpRefusal(403, '{"message":"umid required"}').kind, 'upstream')
})

test('UpstreamRefusalError carries the verdict as flags, and keeps the message', () => {
  const error = new UpstreamRefusalError('Qoder model list failed: HTTP 429', 429, DAILY_LIMIT_BODY)
  assert.strictEqual(error.message, 'Qoder model list failed: HTTP 429')
  assert.strictEqual(error.name, 'UpstreamRefusalError')
  assert.strictEqual(error.status, 429)
  assert.strictEqual(error.upstreamKind, 'daily-limit')
  assert.strictEqual(error.dailyLimit, true)
  assert.strictEqual(error.signInExpired, false)
  // The flags are read through `thrownFlag` by every consumer, and they survive
  // a value that lost its prototype (a cross-realm throw, a re-wrap) because
  // they are plain own fields.
  assert.strictEqual(thrownFlag(error, 'dailyLimit'), true)
  assert.strictEqual(thrownFlag({ ...error }, 'upstreamKind'), 'daily-limit')
})

test('UpstreamRefusalError: Retry-After wins over the body, and 0 is not "unknown"', () => {
  // The header is what HTTP promises; the field is a courtesy the gateway only
  // sometimes includes. Same precedence as the exchange throttle
  // (`credential-cache.ts`).
  const withHeader = new UpstreamRefusalError('m', 429, DAILY_LIMIT_BODY, '7350')
  assert.strictEqual(withHeader.retryAfterSeconds, 7350)
  const fromBody = new UpstreamRefusalError(
    'm',
    429,
    '{"type":"daily_limit_exceeded","retryAfterSeconds":900}',
  )
  assert.strictEqual(fromBody.retryAfterSeconds, 900)
  // An HTTP-date header resolves against the wall clock, and a date already in
  // the past reads as "wait 0" (open now) rather than a negative wait. The date
  // is deliberately long past: a future one would be a real second count, and
  // asserting that would be asserting the test's own clock.
  const stale = new UpstreamRefusalError('m', 429, DAILY_LIMIT_BODY, 'Wed, 21 Oct 2020 07:28:00 GMT')
  assert.strictEqual(stale.retryAfterSeconds, 0)
  assert.strictEqual(new UpstreamRefusalError('m', 429, DAILY_LIMIT_BODY).retryAfterSeconds, 0)
})

test('fetchUsage: a daily-limit 429 arrives as a verdict, message unchanged', async () => {
  // This is the surface the card polls, so it is the one that can light the
  // local exhausted badge.
  const error = await withFetch(refusal(429, DAILY_LIMIT_BODY), () =>
    fetchUsage(REGION, CREDENTIAL).then(
      () => undefined,
      (thrown) => thrown,
    ),
  )
  assert.ok(error instanceof UpstreamRefusalError, `saw: ${error?.name}`)
  assert.strictEqual(error.dailyLimit, true)
  assert.strictEqual(error.message, 'HTTP 429', 'the reader\'s message has always been the bare status')
  // The presentation route fails first and the quota route is tried second;
  // both answer the same way here, so the verdict must survive the fallback.
  assert.strictEqual(error.upstreamKind, 'daily-limit')
})

test('fetchModels: the daily limit is named, and a 500 keeps its old message', async () => {
  const limited = await withFetch(refusal(429, DAILY_LIMIT_BODY), () =>
    fetchModels(REGION, CREDENTIAL).then(
      () => undefined,
      (thrown) => thrown,
    ),
  )
  assert.strictEqual(limited.dailyLimit, true)
  assert.strictEqual(limited.upstreamKind, 'daily-limit')

  // The regression pin: this text is what the card and the log show, and
  // docs/issues/8 made it name the body. The verdict must not cost it.
  const server = await withFetch(refusal(500, 'upstream is unwell'), () =>
    fetchModels(REGION, CREDENTIAL).then(
      () => undefined,
      (thrown) => thrown,
    ),
  )
  assert.strictEqual(server.upstreamKind, 'upstream')
  assert.strictEqual(server.dailyLimit, false)
  assert.match(server.message, /^Qoder model list failed: HTTP 500 upstream is unwell$/)
})

test('fetchUserInfo: 401 is a dead credential, 403 is not', async () => {
  // `isStaleCredentialError` reads this flag and the credential cache is dropped
  // on it — for a 401 that is the fix, for the umid-gated 403 it would be a
  // regression that re-signs the user out of a working account.
  const expired = await withFetch(refusal(401, '{"message":"Sign in expired"}'), () =>
    fetchUserInfo(REGION, CREDENTIAL).then(
      () => undefined,
      (thrown) => thrown,
    ),
  )
  assert.strictEqual(expired.signInExpired, true)
  assert.strictEqual(expired.upstreamKind, 'sign-in-expired')

  const gated = await withFetch(refusal(403, '{"message":"umid required"}'), () =>
    fetchUserInfo(REGION, CREDENTIAL).then(
      () => undefined,
      (thrown) => thrown,
    ),
  )
  assert.strictEqual(gated.signInExpired, false)
  assert.strictEqual(gated.upstreamKind, 'upstream')
})

test('readCampaigns and the check-in read the body they used to discard', async () => {
  // Campaigns used to throw without reading the body at all, so even a
  // machine-readable verdict was thrown away with the response.
  const campaigns = await withFetch(refusal(500, DAILY_LIMIT_BODY), () =>
    readCampaigns(REGION, CREDENTIAL).then(
      () => undefined,
      (thrown) => thrown,
    ),
  )
  assert.strictEqual(campaigns.dailyLimit, true)
  assert.strictEqual(campaigns.message, 'Qoder campaigns failed: HTTP 500')

  const checkin = await withFetch(refusal(429, DAILY_LIMIT_BODY), () =>
    claimCampaign(REGION, CREDENTIAL, 'campaign-key').then(
      () => undefined,
      (thrown) => thrown,
    ),
  )
  assert.strictEqual(checkin.dailyLimit, true)
  assert.match(checkin.message, /^Qoder check-in failed: HTTP 429 /)
})
