/**
 * Guard `fetchUserInfo` against the bare-Bearer regression that broke 在线确认.
 *
 * Run: node --test test/userinfo-headers.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * The card's 在线确认 button calls `fetchUserInfo`, and on the CN region the
 * upstream answered a bare `Authorization: Bearer` request with a 400 instead
 * of the profile. The quota/campaigns OpenAPI calls all go through the shared
 * `openApiHeaders` helper — the exact header set the real Qoder client sends
 * (`Cosy-ClientType`, `User-Agent`, plus the Bearer token) — and `fetchUserInfo`
 * was the one OpenAPI call still hand-rolling its own, slimmer headers. This
 * test is what keeps it on the shared path: a future edit that reverts
 * `fetchUserInfo` to a bare Bearer goes red here, before the user's card meets
 * the 400 again.
 *
 * The test cannot reach the real gateway (that needs a live sign-in), so it
 * stubs `globalThis.fetch`, captures the request, and asserts on the headers —
 * the one thing that distinguishes the two shapes. The response stub answers a
 * 200 with a minimal body so the call resolves and the header check is the only
 * thing under test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchUserInfo } from '../lib/upstream.js'

const CN_REGION = {
  id: 'qoder-cn',
  displayName: 'Qoder CN',
  openApiUrl: 'https://openapi.qoder.com.cn',
}
const CREDENTIAL = {
  userID: 'u-test',
  token: 'tok-test',
  name: 'n',
  email: 'e@x',
  machineID: 'm',
}

test('fetchUserInfo sends the real-client header set, not a bare Bearer', async () => {
  let captured
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init }
    return new Response(
      JSON.stringify({ data: { id: 'u-test', name: 'n', email: 'e@x' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  try {
    const info = await fetchUserInfo(CN_REGION, CREDENTIAL)
    // The call must resolve against the stub body, proving the flow ran.
    assert.strictEqual(info.userID, 'u-test')

    assert.strictEqual(captured.url, `${CN_REGION.openApiUrl}/api/v1/userinfo`)
    const headers = captured.init.headers

    // The three headers that identify the request as coming from the Qoder
    // client — the set every other OpenAPI call sends via openApiHeaders. A
    // bare-Bearer regression drops exactly these.
    assert.strictEqual(headers.Authorization, `Bearer ${CREDENTIAL.token}`)
    assert.strictEqual(headers['Cosy-ClientType'], '10', 'missing Cosy-ClientType — the 400 regression')
    assert.strictEqual(headers['User-Agent'], 'Qoder', 'missing User-Agent — the 400 regression')
  } finally {
    globalThis.fetch = original
  }
})
