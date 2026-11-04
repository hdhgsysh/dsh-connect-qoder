/**
 * The four device-login routes, driven through their real handlers.
 *
 * Run: node --test test/device-login-routes.test.js
 *
 * These exercise the whole sign-in conversation over a real `DeviceLoginFlow`
 * with a stubbed `fetch`, because that is the layer a source-text assertion
 * cannot reach: which status an unknown region answers with, that a sign-out
 * which did not actually delete the file is not reported as success, and that
 * the gates (method, origin) run before anything else.
 */
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  deviceLoginCancelHandler,
  deviceLoginPollHandler,
  deviceLoginSignOutHandler,
  deviceLoginStartHandler,
} from '../src/host/handlers.ts'
import { DeviceLoginFlow } from '../src/host/device-login-flow.ts'
import { REGIONS } from '../src/host/credentials.ts'

const CN = REGIONS.find((r) => r.id === 'qoder-cn')
assert.ok(CN !== undefined, 'REGIONS lost the CN edition')

/** The poll envelope the service really sends (see issue 21). */
const POLL_BODY = JSON.stringify({
  id: 'sess-1',
  nonce: 'nonce-1',
  code_challenge: 'challenge-1',
  code_challenge_method: 'S256',
  expires_at: '2026-11-15T16:39:32Z',
  refresh_token: 'drt-measured',
  refresh_token_expires_at: '2027-10-11T16:39:32Z',
  refresh_token_id: 'rtid-1',
  token: 'dt-measured',
  user_id: '019ec931',
})

function fakeReq({ method = 'GET', url = '/', origin, host = '127.0.0.1:19387' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { ...(origin === undefined ? {} : { origin }), host }
  req.destroy = () => {
    req.destroyed = true
  }
  return req
}

function fakeRes(req) {
  const bodies = []
  const out = { status: null, headers: null }
  const res = {
    req,
    writeHead: (status, headers) => {
      out.status = status
      out.headers = headers
    },
    end: (payload) => {
      if (payload !== undefined) bodies.push(payload)
    },
  }
  return { res, out, bodies }
}

/**
 * Drive a request the way this suite must: the handler is started FIRST, so it
 * has subscribed its body readers, and only then is the body emitted. An
 * EventEmitter drops events nobody is listening for, so feeding the body before
 * the call would leave the handler waiting forever.
 */
async function call(handler, options, deps, body) {
  const req = fakeReq(options)
  const res = fakeRes(req)
  const pending = handler(req, res.res, deps)
  if (body !== undefined) {
    const buffer = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    req.emit('data', buffer)
    req.emit('end')
  }
  await pending
  return res
}

function lastJson({ bodies }) {
  assert.ok(bodies.length > 0, 'the handler sent no body')
  return JSON.parse(bodies.at(-1))
}

/** Logger recording every line, so "did anything notice" is assertable. */
function depsFor({ answer = () => ({ status: 404, ok: false, text: async () => '' }), forget } = {}) {
  const stored = []
  const lines = []
  const flow = new DeviceLoginFlow({
    fetchImpl: async () => answer(),
    onAuthorized: async (region, payload, machineID) => {
      stored.push({ region, payload, machineID })
    },
  })
  return {
    stored,
    lines,
    flow,
    deps: {
      regions: REGIONS,
      flow,
      forget: forget ?? (async () => true),
      status: () => ({ state: 'ok' }),
      logger: {
        info: (m) => lines.push(`info:${m}`),
        warn: (m) => lines.push(`warn:${m}`),
        error: (m) => lines.push(`error:${m}`),
        debug: (m) => lines.push(`debug:${m}`),
      },
    },
  }
}

// -- start ------------------------------------------------------------------

test('starting a sign-in answers with the URL to approve', async () => {
  const { flow, deps } = depsFor()
  const res = await call(deviceLoginStartHandler, { method: 'POST' }, deps, { region: 'qoder-cn' })

  const body = lastJson(res)
  assert.strictEqual(res.out.status, 200)
  assert.strictEqual(body.region, 'qoder-cn')
  assert.match(body.authUrl, /^https:\/\/qoder\.cn\/device\/selectAccounts\?/)
  assert.ok(body.expiresAt > Date.now())
  assert.strictEqual(flow.pending('qoder-cn'), true)
})

test('starting for a region this plugin does not have is a 404', async () => {
  const { deps } = depsFor()
  const res = await call(deviceLoginStartHandler, { method: 'POST' }, deps, { region: 'qoder-mars' })

  assert.strictEqual(res.out.status, 404)
  assert.deepStrictEqual(lastJson(res), { error: 'unknown-region' })
})

test('the method gate runs before the body is even read', async () => {
  const { deps } = depsFor()
  const res = await call(deviceLoginStartHandler, { method: 'GET' }, deps)
  assert.strictEqual(res.out.status, 405)
  assert.strictEqual(res.out.headers.Allow, 'POST')
})

test('a request from outside this machine is refused', async () => {
  const { deps } = depsFor()
  const res = await call(
    deviceLoginStartHandler,
    { method: 'POST', origin: 'https://evil.example', host: 'evil.example' },
    deps,
    { region: 'qoder-cn' },
  )
  assert.strictEqual(res.out.status, 403)
  assert.deepStrictEqual(lastJson(res), { error: 'origin-not-trusted' })
})

// -- poll -------------------------------------------------------------------

test('polling reports the states the card renders, one at a time', async () => {
  let approved = false
  const { flow, deps } = depsFor({
    answer: () =>
      approved
        ? { status: 200, ok: true, text: async () => POLL_BODY }
        : { status: 404, ok: false, text: async () => '' },
  })
  const poll = async () => {
    const res = await call(
      deviceLoginPollHandler,
      { url: '/plugins/dsh-connect-qoder/device-login/poll?region=qoder-cn' },
      deps,
    )
    assert.strictEqual(res.out.status, 200)
    return lastJson(res)
  }

  assert.deepStrictEqual(await poll(), { state: 'idle' }, 'no attempt yet')
  flow.start('qoder-cn')
  assert.deepStrictEqual(await poll(), { state: 'pending' })
  approved = true
  assert.deepStrictEqual(await poll(), { state: 'authorized' })
  assert.strictEqual(flow.pending('qoder-cn'), false)
})

test('an unknown region on the poll is a 404, not an empty success', async () => {
  const { deps } = depsFor()
  const missing = await call(deviceLoginPollHandler, { url: '/plugins/dsh-connect-qoder/device-login/poll' }, deps)
  assert.strictEqual(missing.out.status, 404)

  const unknown = await call(
    deviceLoginPollHandler,
    { url: '/plugins/dsh-connect-qoder/device-login/poll?region=nope' },
    deps,
  )
  assert.strictEqual(unknown.out.status, 404)
  assert.deepStrictEqual(lastJson(unknown), { error: 'unknown-region' })
})

test('a failed poll carries its reason and is logged, not smoothed into "pending"', async () => {
  const { flow, deps, lines } = depsFor({ answer: () => ({ status: 500, ok: false, text: async () => 'boom' }) })
  flow.start('qoder-cn')
  const res = await call(
    deviceLoginPollHandler,
    { url: '/plugins/dsh-connect-qoder/device-login/poll?region=qoder-cn' },
    deps,
  )

  assert.strictEqual(res.out.status, 200)
  assert.deepStrictEqual(lastJson(res), { state: 'failed', reason: 'Http500' })
  assert.ok(
    lines.some((line) => line.startsWith('warn:') && line.includes('Http500')),
    'a failure the user cannot act on still has to be diagnosable somewhere',
  )
})

// -- cancel -----------------------------------------------------------------

test('cancelling stops the attempt and is idempotent', async () => {
  const { flow, deps } = depsFor()
  flow.start('qoder-cn')

  const cancel = async (body) => {
    const res = await call(deviceLoginCancelHandler, { method: 'POST' }, deps, body)
    return { status: res.out.status, body: lastJson(res) }
  }

  assert.deepStrictEqual(await cancel({ region: 'qoder-cn' }), {
    status: 200,
    body: { region: 'qoder-cn', cancelled: true },
  })
  assert.deepStrictEqual(await cancel({ region: 'qoder-cn' }), {
    status: 200,
    body: { region: 'qoder-cn', cancelled: false },
  })
  assert.strictEqual(flow.pending('qoder-cn'), false)
})

// -- sign out ---------------------------------------------------------------

test('signing out deletes the credential and says the device is what went away', async () => {
  const forgotten = []
  const { flow, deps } = depsFor({
    forget: async (region) => {
      forgotten.push(region)
      return true
    },
  })
  flow.start('qoder-cn')
  const res = await call(deviceLoginSignOutHandler, { method: 'POST' }, deps, { region: 'qoder-cn' })

  assert.deepStrictEqual(forgotten, ['qoder-cn'])
  assert.strictEqual(res.out.status, 200)
  const body = lastJson(res)
  assert.strictEqual(body.signedOut, true)
  assert.deepStrictEqual(body.device, { state: 'ok' })
  assert.strictEqual(flow.pending('qoder-cn'), false, 'a pending attempt must not outlive the sign-out')
})

test('a sign-out that did not delete the file is a failure, not a cheerful 200', async () => {
  // The credential is still on disk, so the very next request would sign the
  // user back in. Reporting success here is the false confirmation the first
  // red line is about.
  const { deps } = depsFor({ forget: async () => false })
  const res = await call(deviceLoginSignOutHandler, { method: 'POST' }, deps, { region: 'qoder-cn' })

  assert.strictEqual(res.out.status, 500)
  const body = lastJson(res)
  assert.strictEqual(body.error, 'sign-out-failed')
  assert.match(body.detail, /still in use/)
})

test('a sign-out that throws reports the throw and logs it', async () => {
  const { deps, lines } = depsFor({
    forget: async () => {
      throw new Error('EPERM: operation not permitted')
    },
  })
  const res = await call(deviceLoginSignOutHandler, { method: 'POST' }, deps, { region: 'qoder-cn' })

  assert.strictEqual(res.out.status, 500)
  assert.match(lastJson(res).detail, /EPERM/)
  assert.ok(lines.some((line) => line.startsWith('error:')))
})
