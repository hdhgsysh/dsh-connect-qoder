/**
 * The campaigns half of a usage read must fail VISIBLY, not silently.
 *
 * Run: node --test test/usage-campaigns-error.test.js
 *
 * `fetchUsage` reads two things in one call: the quota (the reason the panel
 * exists) and the campaigns list (the promotional rows and the daily check-in
 * round). The campaigns read is supplementary — a failure there must not cost
 * the user their quota numbers — and the original code expressed that by
 * letting the rejection fall on the floor:
 *
 *   } catch (error) {
 *     if (signal?.aborted) throw error
 *   }
 *
 * That is AGENTS.md red line 1 verbatim: a failure path that does not speak.
 * Its cost is concrete rather than theoretical — "the campaigns endpoint is
 * down" and "this account has no offers and no check-in today" rendered
 * identically, which is the same indistinguishable-from-absence shape as
 * KNOWN_GAPS §8 (the umid-gated check-in) and every other incident in
 * docs/issues/.
 *
 * The fix keeps the quota and attaches the reason, so the card can print it.
 * These tests pin both halves: the reason survives, and the quota is untouched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchUsage } from '../src/host/upstream.ts'
import { readUsageShape } from '../src/host/upstream/fetch-usage.ts'
import { readCampaignsShape, readUserInfoShape } from '../src/host/upstream/api-calls.ts'
import { ProtocolShapeChangedError } from '../src/host/errors.ts'

const REGION = {
  id: 'qoder-cn',
  displayName: 'Qoder CN',
  baseUrl: 'https://openapi.qoder.com.cn/',
  openApiUrl: 'https://openapi.qoder.com.cn/',
}
const CREDENTIAL = { userID: 'u-test', token: 'tok-test', name: 'n', email: 'e@x', machineID: 'm' }

const USAGE_BODY = { user_quota: { total: 100, used: 25, percentage: 0.25 } }

/**
 * A fetch stub that answers the quota route normally and the campaigns route
 * with whatever the test asks for.
 *
 * The two routes are told apart by path, because the point of the test is
 * exactly that one of them can fail while the other succeeds: a stub that
 * answers every URL identically cannot express that.
 */
function stub({ campaignsStatus = 200, campaignsBody = { campaigns: [] } } = {}) {
  return async (url) => {
    const path = String(url)
    if (path.includes('/campaigns')) {
      if (campaignsStatus !== 200) {
        return new Response('upstream is unwell', { status: campaignsStatus })
      }
      return new Response(JSON.stringify(campaignsBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(USAGE_BODY), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

test('a usage body that is no longer a usage document is protocol drift, not "no usage"', async () => {
  // The clone's private protocol has no version negotiation: an upstream rename
  // reaches this plugin as a 200 whose body is valid JSON and no longer the
  // document the quota fields are read from. Before the triage that read as
  // `undefined` — "this account has nothing to show" — which is a claim the
  // plugin is not entitled to make and hides the one remedy that works.
  for (const payload of [[], 'ok', { data: null }, { unrelated: { a: 1 } }]) {
    await assert.rejects(
      () => usageWith(async () => jsonResponse(payload)),
      (error) => error instanceof ProtocolShapeChangedError && error.protocolShapeChanged === true,
      `saw: ${JSON.stringify(payload)}`,
    )
  }
})

test('an empty usage body stays "no data" instead of claiming drift', async () => {
  // The false-alarm twin: `{}` carries no evidence either way, so calling it a
  // protocol change would send the user to update a plugin that is working.
  const usage = await usageWith(async (url) => String(url).includes('/campaigns') ? jsonResponse({ campaigns: [] }) : jsonResponse({}))
  assert.strictEqual(usage, undefined)
})

test('a campaigns envelope that lost its array is flagged as drift on the snapshot', async () => {
  // Campaigns are supplementary, so the quota must survive — but the empty
  // offers block must not read as "no offers today" when the envelope moved.
  // The host now flags the reason so the card says "update the plugin".
  const usage = await usageWith(stub({ campaignsBody: { data: { campaigns: [] } } }))
  assert.ok(usage !== undefined, 'the quota read still answers')
  assert.strictEqual(usage.campaignsShapeChanged, true)
  assert.match(usage.campaignsError, /campaigns/i)
})

test('a transport failure is NOT flagged as a shape change', async () => {
  const usage = await usageWith(stub({ campaignsStatus: 500 }))
  assert.strictEqual(usage.campaignsShapeChanged, undefined, 'a 500 heals on its own; the wording must differ')
})

test('readUsageShape: empty object is no data, unknown keys alongside a known one are fine', () => {
  assert.deepStrictEqual(readUsageShape({}), { envelope: {}, record: {} })
  const known = { user_quota: { total: 1 }, futureField: true }
  assert.strictEqual(readUsageShape(known).record.user_quota !== undefined, true)
})

test('readCampaignsShape: {} / null list / banner-only envelopes are "no campaigns", not drift', () => {
  assert.deepStrictEqual(readCampaignsShape({}), {})
  assert.strictEqual(readCampaignsShape({ campaigns: null }).campaigns, null, 'a null list is an empty list')
  assert.strictEqual(readCampaignsShape({ campaigns: [] }).campaigns.length, 0)
  // The banner-only answer the international edition serves without the umid
  // identity: no array, but still the envelope the plugin knows.
  assert.strictEqual(readCampaignsShape({ uid: 'u', showCampaign: true, claimable: false }).uid, 'u')
})

test('readCampaignsShape: a renamed envelope or a non-array campaigns value is drift', () => {
  for (const payload of [null, [], 'x', { data: { campaigns: [] } }, { campaigns: 'soon' }]) {
    assert.throws(
      () => readCampaignsShape(payload),
      (error) => error instanceof ProtocolShapeChangedError,
      `saw: ${JSON.stringify(payload)}`,
    )
  }
})

test('readUserInfoShape: the two real envelopes are accepted', () => {
  assert.strictEqual(readUserInfoShape({ id: 'u', name: 'n' }).name, 'n')
  assert.strictEqual(readUserInfoShape({ data: { user_id: 'u', email: 'e@x' } }).email, 'e@x')
  assert.deepStrictEqual(readUserInfoShape({}), {}, 'an empty body is no identity, not drift')
})

test('readUserInfoShape: a non-empty body with no identity field is drift', () => {
  for (const payload of [null, [], 'x', { data: { profile: { id: 'u' } } }]) {
    assert.throws(
      () => readUserInfoShape(payload),
      (error) => error instanceof ProtocolShapeChangedError,
      `saw: ${JSON.stringify(payload)}`,
    )
  }
})

/** One JSON 200, the shape every upstream route answers with. */
function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Run `fetchUsage` against a stub and restore the global afterwards. */
async function usageWith(stubImpl, signal) {
  const original = globalThis.fetch
  globalThis.fetch = stubImpl
  try {
    return await fetchUsage(REGION, CREDENTIAL, signal)
  } finally {
    globalThis.fetch = original
  }
}

test('a failed campaigns read is reported, and the quota is still returned', async () => {
  // The whole point: both halves at once. The quota numbers are the user's
  // reason for opening the panel, so the failure must not take them; and the
  // failure must not vanish either, or the empty promo block reads as "no
  // offers" — a claim the plugin is not entitled to make.
  const usage = await usageWith(stub({ campaignsStatus: 500 }))

  assert.ok(usage !== undefined, 'the quota read succeeded, so a snapshot must come back')
  assert.strictEqual(usage.userQuota.percentage, 0.25, 'the quota must survive a campaigns failure')
  assert.deepStrictEqual(usage.campaigns, [], 'no campaigns could be read, so the list is empty')
  assert.strictEqual(
    typeof usage.campaignsError,
    'string',
    'the campaigns failure must be carried on the snapshot, not swallowed',
  )
  assert.ok(
    usage.campaignsError.length > 0,
    'an empty reason would reach the card as a note with nothing to say',
  )
  // The message names the failing read, so the card's note says WHICH half
  // broke rather than a bare "something went wrong".
  assert.match(usage.campaignsError, /campaigns/i, `saw: ${usage.campaignsError}`)
})

test('a healthy campaigns read leaves no error behind', async () => {
  // The negative control: the field is a failure report, not decoration. If it
  // were emitted unconditionally the card would warn on every good read.
  const usage = await usageWith(
    stub({ campaignsBody: { campaigns: [{ campaignKey: 'k', actionType: 'CLAIM_BENEFIT' }] } }),
  )
  assert.strictEqual(usage.campaignsError, undefined)
  assert.ok(Array.isArray(usage.campaigns), 'the campaigns array is always present')
})

test('an aborted read still throws instead of reporting a campaigns failure', async () => {
  // An abort is the caller withdrawing the request, not the campaigns endpoint
  // being broken. Reporting it as a campaigns error would be a lie that outlives
  // the request, and it would also hide the cancellation from the caller.
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => usageWith(stub({ campaignsStatus: 500 }), controller.signal),
    'an aborted read must reject rather than answer',
  )
})
