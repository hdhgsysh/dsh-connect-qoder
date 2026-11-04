/**
 * Tests for the daily billing limit as its own kind of failure.
 *
 * Run: node --test test/daily-limit.test.js
 *
 * WHAT HAPPENED
 *
 * A user sent a request and got:
 *
 *   失败原因：502: {"message":"Qoder upstream error 110: Billing daily count exceeded",
 *              "type":"upstream_error","code":"upstream_error"}
 *   重试延迟：7350毫秒
 *
 * Two things in that are wrong, and they are the same mistake seen twice. The
 * gateway classified a SPENT DAILY ALLOWANCE as a queue — the payload carries
 * the queue markers and a `Retry-After` of 7350 seconds, which is about two
 * hours — and the plugin believed it. So the user was told a request would be
 * retried, for something no amount of retrying can change: the counter resets
 * at the day boundary rather than draining. And the status was `502`, which
 * reads as "Qoder broke" when the truth is "you have used today's requests".
 *
 * WHERE THE BOUNDARY IS DRAWN
 *
 * The classifier checks `110` BEFORE the queue-marker fallback, and the reason
 * is the whole test: this payload HAS the markers. A rule that matched markers
 * first would classify it as a queue no matter what the code said, and the
 * multi-hour hint would be honoured as a retry delay.
 *
 * WHAT IS ASSERTED HERE, AND WHAT IS NOT
 *
 * The envelope is taken from that user report rather than from a live probe:
 * `probe/daily-limit-probe.mjs` could not produce it, because the accounts on
 * this machine still had allowance and a real request came back with content.
 * That is stated in the probe too. So the SHAPE below is a specification, and
 * what these tests pin is the plugin's reaction to it — which is the part that
 * was wrong and the part a future edit could repeat.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyUpstreamError } from '../src/host/errors.ts'
import { queueWaitFor, streamChat } from '../src/host/upstream.ts'

/**
 * The frame as it arrives, at the nesting the gateway actually uses.
 *
 * `message` is itself a JSON STRING holding another document, which holds the
 * queue descriptor with the multi-hour hint — the shape `queueSeconds` walks.
 * Reproducing the nesting matters: a flat `{ code: 110, … }` would be a
 * different test, and would not exercise the part that misclassified it.
 */
const DAILY_LIMIT_FRAME = {
  code: '502',
  message: JSON.stringify({
    code: '110',
    message: JSON.stringify({
      error: { code: 110, message: 'Billing daily count exceeded' },
      isQueued: false,
      retryAfterSeconds: 7350,
      serviceAvailable: false,
    }),
  }),
}

const detail = DAILY_LIMIT_FRAME.message

test('a spent daily allowance is its own kind, not a queue', () => {
  const verdict = classifyUpstreamError(DAILY_LIMIT_FRAME, '502', detail)
  assert.strictEqual(verdict.kind, 'daily-limit')
  assert.notStrictEqual(verdict.kind, 'rate-limit', 'this is the exact misclassification that was fixed')
})

test('the check runs BEFORE the queue-marker fallback, because the payload HAS the markers', () => {
  // Stated as its own test because it is the fragile part: a reordering — or a
  // refactor that moves the marker check up for "efficiency" — silently
  // reinstates the original behaviour, and the payload below still contains
  // every marker the fallback looks for.
  const payload = JSON.stringify({
    isQueued: false,
    queueType: 'DAILY_LIMIT',
    retryAfterSeconds: 7350,
    serviceAvailable: false,
  })
  assert.ok(
    payload.includes('"queueType"') && payload.includes('"retryAfterSeconds"') &&
      payload.includes('"isQueued"') && payload.includes('"serviceAvailable"'),
    'the fixture must carry all four queue markers, or it proves nothing',
  )
  const verdict = classifyUpstreamError({ code: '110' }, '110', `Billing daily count exceeded ${payload}`)
  assert.strictEqual(verdict.kind, 'daily-limit', 'the markers must not win')
})

test('the reset hint is carried through, because it is all the user can plan around', () => {
  // Discarding the number leaves the UI with nothing but "try later", which is
  // the state the report came from. The hint is what becomes "resets at HH:MM".
  const verdict = classifyUpstreamError(DAILY_LIMIT_FRAME, '502', detail)
  assert.strictEqual(verdict.retryAfterSeconds, 7350)
})

test('a payload with no hint reports zero rather than guessing', () => {
  const verdict = classifyUpstreamError({ code: '110' }, '110', 'Billing daily count exceeded')
  assert.strictEqual(verdict.kind, 'daily-limit')
  assert.strictEqual(verdict.retryAfterSeconds, 0, 'no hint is "we do not know when", not an estimate')
})

test('the limit is recognised by code alone, and by message alone', () => {
  // Three ways in, because the gateway has been seen spelling it differently
  // across surfaces: a bare code, a quoted code, and the message without one.
  assert.strictEqual(classifyUpstreamError({}, '110', '').kind, 'daily-limit')
  assert.strictEqual(classifyUpstreamError({}, '"110"', '').kind, 'daily-limit')
  assert.strictEqual(
    classifyUpstreamError({}, '', 'Billing daily count exceeded').kind,
    'daily-limit',
  )
  // And the daily limit is not confused with the two codes that mean something
  // else, which is the failure that sent the user to their account instead.
  assert.strictEqual(classifyUpstreamError({}, '105', 'Login expired').kind, 'sign-in-expired')
  assert.strictEqual(
    classifyUpstreamError({}, '10605', JSON.stringify({ isQueued: true, retryAfterSeconds: 2 })).kind,
    'rate-limit',
  )
})

test('the upstream string code "daily_limit_exceeded" is its own kind, not a generic upstream error', () => {
  // Upstream switched from the numeric `110` (prose "Billing daily count
  // exceeded") to the string code `daily_limit_exceeded` whose prose is
  // "Qoder's daily request allowance for this account is used up…". That prose
  // contains NONE of the substrings the daily-limit regex used to match, so
  // without an explicit code match it fell through to `kind:'upstream'` — losing
  // the friendly off-peak/check-in message and the retryable:false guarantee.
  const verdict = classifyUpstreamError(
    {},
    'daily_limit_exceeded',
    "Qoder's daily request allowance for this account is used up. Waiting within the session will not help; the off-peak price (22:00–08:00 Asia/Shanghai) and the daily check-in both still work.",
  )
  assert.strictEqual(verdict.kind, 'daily-limit', 'must not regress to upstream on the new code')
  assert.notStrictEqual(verdict.kind, 'upstream', 'the new code must not be reported as a generic upstream error')
  assert.notStrictEqual(verdict.kind, 'rate-limit', 'the new code must not be read as a retryable queue')
})

test('the new code by itself, with no helpful prose, is still a daily limit', () => {
  // The code alone must decide, because upstream may send the bare code without
  // the explanatory message on other surfaces.
  assert.strictEqual(classifyUpstreamError({}, 'daily_limit_exceeded', '').kind, 'daily-limit')
  assert.strictEqual(classifyUpstreamError({}, '"daily_limit_exceeded"', '').kind, 'daily-limit')
})

test('a real queue is still a queue — the new branch must not swallow it', () => {
  // The counterpart, because a fix that turns every retryable failure into a
  // hard failure would trade one wrong answer for another. A `10605` with the
  // same markers and a small hint is the case that must still be waited out.
  const payload = JSON.stringify({ isQueued: true, retryAfterSeconds: 2, serviceAvailable: true })
  const verdict = classifyUpstreamError({}, '10605', payload)
  assert.strictEqual(verdict.kind, 'rate-limit')
  assert.strictEqual(verdict.retryAfterSeconds, 2)
})

test('the daily limit is never waited out, however much budget is left', () => {
  // The property that would have prevented the original symptom entirely: even
  // a caller with a fresh budget and a hint in hand gets no sleep, because the
  // answer does not improve with time inside a session.
  const rejection = { retryable: false, dailyLimit: true, retryAfterSeconds: 7350 }
  assert.strictEqual(queueWaitFor(rejection, 0, 1), undefined)
  assert.strictEqual(queueWaitFor(rejection, 0, 5), undefined)
  // The contrast: a genuine queue with the same hint DOES sleep, so the
  // assertion above is about the kind and not about the helper being broken.
  assert.ok(queueWaitFor({ retryable: true, retryAfterSeconds: 7350 }, 0, 1) > 0)
})

/* ---------------------------------------------------------------------------
 * THE HTTP CARRIER (docs/issues/23-upstream-429-daily-limit.md)
 *
 * Everything above classifies a FRAME. Upstream then delivered the same verdict
 * as a plain `429` with the verdict only in the body:
 *
 *   429: {"message":"Qoder's daily request allowance for this account is used
 *         up…","type":"daily_limit_exceeded","code":"daily_limit_exceeded"}
 *
 * The classifier was already right about that body. The gate in FRONT of it was
 * not: `streamChat` read the HTTP status first, so a 429 became a queue before
 * any body was read, and the plugin spent its full two-minute budget on twelve
 * attempts (measured: probe/http-429-daily-limit-probe.mjs) and then handed DSH
 * a `rate_limit`, which the host retried five more times.
 *
 * These tests drive the real `streamChat` against a `fetch` stub, because that
 * is the only place the retry ladder is visible: the error a caller receives is
 * the same either way, but the number of requests it cost is not.
 * ------------------------------------------------------------------------- */

const REGION = { id: 'qoder', displayName: 'Qoder', baseUrl: 'https://gateway.example' }
const CREDENTIAL = { userID: 'u-test', token: 'tok-test', name: 'n', email: 'e@x', machineID: 'm' }
const CHAT_REQUEST = {
  model: 'model-key',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  maxTokens: undefined,
  enableThinking: false,
  alwaysThinking: false,
  reasoningEffort: undefined,
  sessionId: 's-test',
}

/** The 429 body as the newer gateway sends it — the report's own wording. */
const LIVE_429_BODY = JSON.stringify({
  message:
    "Qoder's daily request allowance for this account is used up. Waiting within the session will not help; " +
    'the off-peak price (22:00–08:00 Asia/Shanghai) and the daily check-in both still work.',
  type: 'daily_limit_exceeded',
  code: 'daily_limit_exceeded',
})

/**
 * Drive one real chat turn against a scripted reply sequence.
 *
 * The last reply is reused once the script runs out, so a case that regresses
 * into retrying reports a large `calls` instead of hanging until the timeout.
 * The timeout is the backstop for exactly that regression, not a wait anyone
 * should expect to hit.
 */
async function driveChat(replies, { timeoutMs = 8000 } = {}) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    const reply = replies[Math.min(calls, replies.length - 1)]
    calls += 1
    return new Response(reply.text, {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let error
  try {
    for await (const chunk of streamChat(REGION, CREDENTIAL, CHAT_REQUEST, controller.signal)) {
      void chunk
    }
  } catch (thrown) {
    error = thrown
  } finally {
    clearTimeout(timer)
    globalThis.fetch = original
  }
  return { calls, elapsedMs: Date.now() - started, error }
}

test('a 429 carrying the daily-limit body is not retried at all', async () => {
  const { calls, elapsedMs, error } = await driveChat([{ status: 429, text: LIVE_429_BODY }])
  assert.strictEqual(calls, 1, 'one attempt — the queue ladder must not be entered')
  assert.strictEqual(error?.name, 'DailyLimitRejection')
  assert.strictEqual(error?.dailyLimit, true)
  assert.strictEqual(error?.retryable, false)
  // Before the fix this was twelve attempts and ~120 s (the whole budget). The
  // bound is loose on purpose: what it separates is "no ladder" from "one
  // ladder", which differ by two orders of magnitude.
  assert.ok(elapsedMs < 5000, `no ladder wait expected, took ${elapsedMs} ms`)
})

test('a 429 that is a REAL queue is still waited out — only the daily limit stops the ladder', async () => {
  // The counterpart, because "429 is terminal" would be a different wrong
  // answer. The queue reply must still be retried; the daily-limit reply that
  // follows it must stop the turn there rather than keep spending the budget.
  const queue = JSON.stringify({
    code: '10605',
    message: JSON.stringify({
      isQueued: true,
      queueType: 'DEFAULT',
      retryAfterSeconds: 1,
      serviceAvailable: true,
    }),
  })
  const { calls, error } = await driveChat([
    { status: 429, text: queue },
    { status: 429, text: LIVE_429_BODY },
  ])
  assert.strictEqual(calls, 2, 'the queue reply was retried once, then the daily limit stopped the turn')
  assert.strictEqual(error?.name, 'DailyLimitRejection')
})

test('the daily-limit failure carries the wording the host quota predicate looks for', async () => {
  // Load-bearing coupling, not decoration. DSH cannot see `retryable`: the shim
  // hands it an HTTP status and a message, and the host classifies on those.
  // `dsh-llm-pi-ai`'s `classifyPiAiError` tests `isQuotaExceededError` BEFORE
  // its `\b429\b|rate.?limit` rule, so `RATE_LIMIT` (in the host's retryable
  // set) is what a message without quota wording falls through to, and
  // `QUOTA` is what this phrase buys. `probe/host-retry-classification-probe.mjs`
  // checks the phrase against the installed host's own predicate; this is the
  // cheap guard that keeps a reword from silently dropping it.
  const { error } = await driveChat([{ status: 429, text: LIVE_429_BODY }])
  const message = String(error?.message ?? '')
  assert.match(message, /daily quota exhausted/i)
  // The host's rule is `(?:quota|usage limit)[\s_-]+(?:exceeded|exhausted|reached)`,
  // so the two words have to stay adjacent: "quota is exhausted" would NOT
  // match, and nothing else in this sentence does.
  assert.match(message, /\bquota[\s_-]+exhausted\b/i, 'the host needs the two words adjacent')
})
