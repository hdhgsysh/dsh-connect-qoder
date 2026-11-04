/**
 * The sign-in conversation, step by step.
 *
 * Run: node --test test/device-login-flow.test.js
 *
 * The properties worth guarding here are the ones a happy-path test would miss:
 * that a poll which succeeds but cannot store the credential reports a failure
 * rather than a sign-in, that an abandoned attempt ages out instead of waiting
 * forever, and that the PKCE verifier never travels to the caller — it is the
 * one secret in the exchange, and the caller is a web response.
 *
 * No network: `pollOnce` takes its fetch as an argument, so the flow takes one
 * too, and every case below is a stub.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DeviceLoginFlow } from '../src/host/device-login-flow.ts'

const NOW = 1_700_000_000_000

/** The poll envelope the service really sends, measured (see issue 21). */
const POLL_BODY = JSON.stringify({
  id: 'sess-1',
  nonce: 'nonce-1',
  code_challenge: 'challenge-1',
  code_challenge_method: 'S256',
  created_at: '2026-10-17T00:00:00Z',
  updated_at: '2026-10-17T00:00:00Z',
  expires_at: '2026-11-15T16:39:32Z',
  expires_in: 2500000,
  refresh_token: 'drt-measured',
  refresh_token_expires_at: '2027-10-11T16:39:32Z',
  refresh_token_expires_in: 31000000,
  refresh_token_id: 'rtid-1',
  token: 'dt-measured',
  user_id: '019ec931',
})

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => body }
}

/** A flow over a stubbed service, recording every request it made. */
function flowFor({ answer = () => response(404, ''), now = () => NOW, onAuthorized, ttlMs } = {}) {
  const calls = []
  const flow = new DeviceLoginFlow({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return answer(calls.length)
    },
    now,
    ttlMs,
    onAuthorized: onAuthorized ?? (async () => {}),
  })
  return { flow, calls }
}

test('starting an attempt returns a URL to approve, and pends the region', () => {
  const { flow } = flowFor()
  const result = flow.start('qoder-cn')
  assert.strictEqual(result.kind, 'started')
  assert.strictEqual(result.region, 'qoder-cn')
  // The real shape, on the region's own host: the user opens this in a browser.
  assert.match(result.authUrl, /^https:\/\/qoder\.cn\/device\/selectAccounts\?/)
  assert.match(result.authUrl, /challenge_method=S256/)
  assert.match(result.authUrl, /machine_id=/)
  assert.match(result.authUrl, /client_id=732aef47/)
  assert.ok(result.expiresAt > NOW)
  assert.strictEqual(flow.pending('qoder-cn'), true)
})

test('a region that has no product cannot start', () => {
  const { flow } = flowFor()
  assert.deepStrictEqual(flow.start('qoder-mars'), { kind: 'unsupported-region' })
  assert.strictEqual(flow.pending('qoder-mars'), false)
})

test('the verifier stays on this side of the fence', () => {
  // The challenge goes to the service; the verifier is what proves the poll
  // comes from the same party. Handing it to a web response would let anything
  // that can read the response redeem the attempt.
  const { flow } = flowFor()
  const result = flow.start('qoder-cn')
  const shown = JSON.stringify(result)
  assert.doesNotMatch(shown, /verifier/)
  // And the challenge in the URL is a digest, so it does not contain it either.
  const challenge = new URL(result.authUrl).searchParams.get('challenge')
  assert.ok(challenge !== null && challenge.length > 0)
  assert.doesNotMatch(result.authUrl, /verifier/)
})

test('polling a region with no attempt says so rather than inventing one', async () => {
  const { flow, calls } = flowFor()
  assert.deepStrictEqual(await flow.poll('qoder-cn'), { kind: 'idle' })
  assert.strictEqual(calls.length, 0, 'nothing to poll means no request')
})

test('404 is "keep waiting", not a failure', async () => {
  const { flow, calls } = flowFor({ answer: () => response(404, '{"errorCode":"NotFound"}') })
  flow.start('qoder-cn')
  assert.deepStrictEqual(await flow.poll('qoder-cn'), { kind: 'pending' })
  assert.strictEqual(calls.length, 1)
  assert.match(calls[0].url, /openapi\.qoder\.com\.cn\/api\/v1\/deviceToken\/poll/)
  // A second poll is a second request: the card owns the cadence.
  assert.deepStrictEqual(await flow.poll('qoder-cn'), { kind: 'pending' })
  assert.strictEqual(calls.length, 2)
})

test('an approval hands over the credential and the machine id it was signed with', async () => {
  const stored = []
  const { flow } = flowFor({
    answer: () => response(200, POLL_BODY),
    onAuthorized: async (region, payload, machineID) => {
      stored.push({ region, payload, machineID })
    },
  })
  flow.start('qoder-cn')
  assert.deepStrictEqual(await flow.poll('qoder-cn'), { kind: 'authorized' })

  assert.strictEqual(stored.length, 1)
  assert.strictEqual(stored[0].region, 'qoder-cn')
  assert.strictEqual(stored[0].payload.token, 'dt-measured')
  assert.strictEqual(stored[0].payload.refreshToken, 'drt-measured')
  assert.strictEqual(stored[0].payload.userID, '019ec931')
  // The machine id cannot come from the response — the envelope has none — so
  // it must be the one the session was created with, or the renewal that
  // follows will be signed by a machine the platform never issued a code to.
  assert.ok(stored[0].machineID.length > 0)

  // The code is spent: a later poll must not re-run the callback.
  assert.deepStrictEqual(await flow.poll('qoder-cn'), { kind: 'idle' })
  assert.strictEqual(stored.length, 1)
})

test('an approval that cannot be stored is a failure, never a sign-in', async () => {
  // The red line: saying "signed in" when nothing was written down leaves the
  // user with a credential that disappears at the next restart and no idea why.
  const { flow } = flowFor({
    answer: () => response(200, POLL_BODY),
    onAuthorized: async () => {
      throw new Error('the vault file could not be written')
    },
  })
  flow.start('qoder-cn')
  const result = await flow.poll('qoder-cn')
  assert.strictEqual(result.kind, 'failed')
  assert.match(result.reason, /could not be written/)
})

test('a service failure ends the attempt with the reason it gave', async () => {
  const { flow } = flowFor({ answer: () => response(500, 'nope') })
  flow.start('qoder-cn')
  const result = await flow.poll('qoder-cn')
  assert.deepStrictEqual(result, { kind: 'failed', reason: 'Http500' })
  // Ended, not stuck: the card stops polling and the user is told.
  assert.strictEqual(flow.pending('qoder-cn'), false)
  assert.deepStrictEqual(await flow.poll('qoder-cn'), { kind: 'idle' })
})

test('an attempt that outlives its window expires instead of polling forever', async () => {
  let clock = NOW
  const { flow, calls } = flowFor({ now: () => clock, answer: () => response(404, '') })
  flow.start('qoder-cn')
  assert.deepStrictEqual(await flow.poll('qoder-cn'), { kind: 'pending' })

  clock += 5 * 60 * 1000
  assert.deepStrictEqual(await flow.poll('qoder-cn'), { kind: 'expired' })
  assert.strictEqual(calls.length, 1, 'an expired attempt must not reach the network')
  assert.strictEqual(flow.pending('qoder-cn'), false)
})

test('a cancelled attempt stops polling and reports as idle, not expired', async () => {
  const { flow, calls } = flowFor({ answer: () => response(404, '') })
  flow.start('qoder-cn')
  assert.strictEqual(flow.cancel('qoder-cn'), true)
  assert.strictEqual(flow.cancel('qoder-cn'), false, 'cancelling nothing is not an error')
  assert.deepStrictEqual(await flow.poll('qoder-cn'), { kind: 'idle' })
  assert.strictEqual(calls.length, 0)
})

test('starting again replaces the attempt rather than forking it', () => {
  // Two live verifiers for one region would make "which one is the card
  // polling" unanswerable, and the user has no way to reach the first window
  // again anyway.
  const { flow } = flowFor()
  const first = flow.start('qoder-cn')
  const second = flow.start('qoder-cn')
  assert.notStrictEqual(first.authUrl, second.authUrl, 'a new attempt means a new challenge')
  assert.strictEqual(flow.pending('qoder-cn'), true)
})

test('the two regions keep separate attempts', async () => {
  const { flow } = flowFor()
  flow.start('qoder-cn')
  assert.strictEqual(flow.pending('qoder'), false, 'one region signing in must not pend the other')
  assert.strictEqual(flow.cancel('qoder'), false)
  assert.strictEqual(flow.pending('qoder-cn'), true)
})

test('clear drops every attempt, for dispose', () => {
  const { flow } = flowFor()
  flow.start('qoder-cn')
  flow.start('qoder')
  flow.clear()
  assert.strictEqual(flow.pending('qoder-cn'), false)
  assert.strictEqual(flow.pending('qoder'), false)
})
