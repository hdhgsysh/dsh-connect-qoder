/**
 * Direct tests for `src/client/card-model.ts` — the card's browser-free
 * decision layer.
 *
 * Run: node --test test/card-model.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * `card-model.ts` is the module the card's pure rules were hoisted into so that
 * a plain Node test can import the REAL implementation and assert on it, instead
 * of copying a rule into the test and letting the source drift (the hand-copied
 * transcription `docs/KNOWN_GAPS.md` warns about, which `test/rule-layer.test.js`
 * turns into a gate). `model-row.test.js` / `card-host-parity.test.js` /
 * `protocol-shape-card.test.js` already cover `offPeakState` / `windowLabelOf` /
 * `refreshNoticeKey`; six exported rules had no direct test at all:
 *
 *   `withDate`, `rateLabelOf`, `formatCountdown`, `formatContextWindowForUi`,
 *   `rateAt`, `describeThrown`.
 *
 * This file closes that. Every assertion runs the shipped source directly —
 * `npm run build:client` then turns that same source into `lib/client.js`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  withDate,
  rateLabelOf,
  formatCountdown,
  formatContextWindowForUi,
  formatTokenCount,
  rateAt,
  describeThrown,
  providerRegistrationFailure,
  usageUnavailableKey,
  credentialKindOf,
  desktopCredentialInUse,
  effectiveAccountStateOf,
  credentialChipOf,
} from '../src/client/card-model.ts'

/** A translation stub that names the key it is asked for. */
const t = (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`)

// --- withDate ---------------------------------------------------------------

test('withDate fills a {date} placeholder from a real timestamp', () => {
  const out = withDate('renews on {date}', 1750000000000)
  assert.equal(typeof out, 'string')
  assert.ok(!out.includes('{date}'), 'the placeholder must be replaced')
  assert.ok(out.startsWith('renews on '), `prefix must survive; got ${out}`)
  assert.ok(out.length > 'renews on '.length, 'a date must actually be inserted')
})

test('withDate leaves a template with no placeholder untouched', () => {
  assert.equal(withDate('no placeholder here', 1750000000000), 'no placeholder here')
})

test('withDate renders nothing when the timestamp is unusable', () => {
  for (const at of [undefined, 0, -1, Number.NaN]) {
    assert.equal(withDate('renews on {date}', at), '', `at=${String(at)} must yield ""`)
  }
})

// --- rateLabelOf ------------------------------------------------------------

test('rateLabelOf names a free model instead of x0.00', () => {
  assert.equal(rateLabelOf(t, 0), 'row.rateFree')
  assert.equal(rateLabelOf(t, -1), 'row.rateFree', 'a negative factor is also free')
})

test('rateLabelOf renders a paid multiplier with two decimals', () => {
  assert.equal(rateLabelOf(t, 1.5), 'x1.50')
  assert.equal(rateLabelOf(t, 2), 'x2.00')
})

test('rateLabelOf shows nothing for a factor that is not a number', () => {
  for (const factor of [undefined, Number.NaN, 'abc']) {
    assert.equal(rateLabelOf(t, factor), undefined, `factor=${String(factor)} must be undefined`)
  }
})

// --- formatCountdown --------------------------------------------------------

test('formatCountdown is a zero-padded HH:MM:SS', () => {
  assert.equal(formatCountdown(0), '00:00:00')
  assert.equal(formatCountdown(3661), '01:01:01')
})

test('formatCountdown clamps and floors instead of emitting junk', () => {
  assert.equal(formatCountdown(-5), '00:00:00', 'a negative count is clamped to zero')
  assert.equal(formatCountdown(undefined), '00:00:00', 'a missing count renders as zero')
  assert.equal(formatCountdown(59.9), '00:00:59', 'a fractional second is floored')
})

// --- formatContextWindowForUi -----------------------------------------------

test('formatContextWindowForUi abbreviates the catalog sizes', () => {
  assert.equal(formatContextWindowForUi(200000), '200K')
  assert.equal(formatContextWindowForUi(128000), '128K')
  assert.equal(formatContextWindowForUi(1000000), '1M')
})

test('formatContextWindowForUi shows a small window in full', () => {
  assert.equal(formatContextWindowForUi(500), '500')
})

test('formatContextWindowForUi renders nothing for an unusable token count', () => {
  for (const n of [0, -1, Number.NaN, undefined]) {
    assert.equal(formatContextWindowForUi(n), '', `tokens=${String(n)} must yield ""`)
  }
})

// --- formatTokenCount -------------------------------------------------------

test('formatTokenCount keeps a comma separator below 10k', () => {
  assert.equal(formatTokenCount(0), '0')
  assert.equal(formatTokenCount(999), '999')
  assert.equal(formatTokenCount(1500), '1,500')
  assert.equal(formatTokenCount(9999), '9,999')
})

test('formatTokenCount abbreviates to k at 10k and above', () => {
  assert.equal(formatTokenCount(10000), '10k')
  assert.equal(formatTokenCount(15441), '15.4k')
  assert.equal(formatTokenCount(999999), '999.9k')
})

test('formatTokenCount abbreviates to m at 1m and above', () => {
  assert.equal(formatTokenCount(1000000), '1m')
  assert.equal(formatTokenCount(1500000), '1.5m')
  assert.equal(formatTokenCount(12345678), '12.3m')
})

test('formatTokenCount degrades to 0 for an unusable value', () => {
  for (const n of [-1, Number.NaN, undefined, null]) {
    assert.equal(formatTokenCount(n), '0', `n=${String(n)} must yield "0"`)
  }
})

// --- rateAt -----------------------------------------------------------------

/** A promotion window that holds for any mid-day instant. */
const ALL_DAY_WINDOW = {
  active: true,
  windowStart: '00:00',
  windowEnd: '23:58',
  beforePromotionPriceFactor: 2,
  discountFactor: 0.5,
}
// 2025-06-15T04:00:00Z is 12:00 in Asia/Shanghai, safely inside 00:00–23:58.
const NOW = new Date('2025-06-15T04:00:00Z')

test('rateAt reads the discounted factor inside an active window', () => {
  const rate = rateAt({ id: 'm', priceFactor: 2, promotion: { ...ALL_DAY_WINDOW, timezone: 'Asia/Shanghai' } }, NOW)
  assert.equal(rate, 1, 'an active promotion applies before x discount')
})

test('rateAt reports the before price when the promotion is switched off', () => {
  const rate = rateAt(
    { id: 'm', priceFactor: 2, promotion: { ...ALL_DAY_WINDOW, active: false } },
    NOW,
  )
  assert.equal(rate, 2, 'a dead window must not discount')
})

test('rateAt falls back to the base factor when there is no promotion', () => {
  assert.equal(rateAt({ id: 'm', priceFactor: 2.5 }, NOW), 2.5)
})

test('rateAt reports undefined when nothing yields a finite factor', () => {
  assert.equal(rateAt({ id: 'm' }, NOW), undefined)
})

// --- describeThrown ---------------------------------------------------------

test('describeThrown reads a real message from an Error', () => {
  assert.equal(describeThrown(new Error('boom')), 'boom')
})

test('describeThrown passes a bare string through', () => {
  assert.equal(describeThrown('bare'), 'bare')
})

test('describeThrown reads a message off a thrown object', () => {
  assert.equal(describeThrown({ message: 'obj' }), 'obj')
})

test('describeThrown never prints the literal word undefined', () => {
  // A thrown `undefined` used to render as the text "undefined" — a failure
  // message that says nothing at all. The narrowing must turn it into the
  // string "undefined" rather than the literal token.
  assert.equal(describeThrown(undefined), 'undefined')
  assert.equal(describeThrown(null), 'null')
})

test('describeThrown falls back to String() for a message-less throw', () => {
  assert.equal(describeThrown({ code: 42 }), '[object Object]')
  assert.equal(describeThrown({ message: 42 }), '[object Object]', 'a non-string message is not a message')
})

test('providerRegistrationFailure names a failed registration, and only a failure', () => {
  // The card's half of the fact the host publishes on /status and folds into
  // the roster. Since docs/issues/20 the roster renders even when the provider
  // half is dead, so this verdict is the only thing that stops the card showing
  // a tickable list the chat picker will not offer.
  assert.equal(providerRegistrationFailure({ providerRegistration: { ok: false, errorName: 'TypeError' } }), 'TypeError')
  assert.equal(providerRegistrationFailure({ providerRegistration: { ok: true } }), null)
})

test('providerRegistrationFailure treats an unreported or unreadable field as silence', () => {
  // The other direction of the same rule: a host from before this field, or a
  // stand-in fixture, sends nothing. Inventing a warning from a missing field
  // would be the false-alarm twin of the silent failure this closes — the card
  // would shout at users whose registration is fine.
  for (const value of [
    undefined,
    null,
    0,
    '',
    'x',
    [],
    {},
    { providerRegistration: null },
    { providerRegistration: 'yes' },
    { providerRegistration: [] },
    { providerRegistration: {} },
    { providerRegistration: { ok: 'false', errorName: 'TypeError' } },
    { providerRegistration: { ok: 0, errorName: 'TypeError' } },
    { providerRegistration: { ok: undefined } },
  ]) {
    assert.equal(providerRegistrationFailure(value), null, `${JSON.stringify(value)} must not warn`)
  }
})

test('providerRegistrationFailure never returns an empty name', () => {
  // A warning that reads "注册失败（）" names nothing, which is the failure mode
  // docs/KNOWN_GAPS.md item 8（国际版 campaigns 端点按 umid 机器身份门控每日签到）
  // exists to prevent. The host narrows this too; the card narrows again rather
  // than trusting another version's payload.
  assert.equal(providerRegistrationFailure({ providerRegistration: { ok: false } }), 'Error')
  assert.equal(providerRegistrationFailure({ providerRegistration: { ok: false, errorName: '' } }), 'Error')
  assert.equal(providerRegistrationFailure({ providerRegistration: { ok: false, errorName: 42 } }), 'Error')
  assert.equal(providerRegistrationFailure({ providerRegistration: { ok: false, errorName: null } }), 'Error')
})

test('usageUnavailableKey gives a spent allowance its own wording', () => {
  // docs/issues/24: same split as the roster notice, on the read the usage panel
  // makes directly. "刷新失败（read-failed）" is true of a daily limit and useless
  // — it invites the retry that cannot work until the allowance resets — so the
  // verdict must survive the last hop to the string.
  assert.equal(usageUnavailableKey({ unavailableReason: 'daily-limit' }), 'usage.dailyLimit')
  assert.equal(usageUnavailableKey({ unavailableReason: 'protocol-shape-changed' }), 'usage.protocolChanged')
  assert.equal(usageUnavailableKey({ unavailableReason: 'read-failed' }), 'usage.unavailable')
  assert.equal(usageUnavailableKey(null), 'usage.unavailable')
  assert.equal(usageUnavailableKey(undefined), 'usage.unavailable')
  assert.equal(usageUnavailableKey({}), 'usage.unavailable')
  // The two standing verdicts stay distinct in precedence order too: a payload
  // can only carry one reason, but an older host's unknown string must not be
  // mistaken for either.
  assert.equal(usageUnavailableKey({ unavailableReason: 'credential' }), 'usage.unavailable')
})

// --- the credential path -----------------------------------------------------

test('the host\'s credential kind is the answer, and its absence is not one', () => {
  assert.equal(credentialKindOf({ credentialKind: 'desktop' }), 'desktop')
  assert.equal(credentialKindOf({ credentialKind: 'device' }), 'device')
  assert.equal(credentialKindOf({ credentialKind: 'env' }), 'env')
  // A host that names something else is not trusted to name the path: the card
  // falls back to its own inference rather than acting on a word it does not know.
  assert.equal(credentialKindOf({ credentialKind: 'pat' }), undefined)
  assert.equal(credentialKindOf({}), undefined)
})

test('the host says which credential is in use, so the card does not have to guess', () => {
  // The desktop store exists and its token has lapsed; the plugin\'s own
  // credential is what actually serves the region. The old inference read the
  // account payload alone and called this "the desktop app".
  const entry = { state: 'expired', source: 'app', device: { state: 'ok' }, credentialKind: 'device' }
  assert.equal(desktopCredentialInUse(entry), false)
  assert.equal(effectiveAccountStateOf(entry), 'device')
})

test('a host that names no kind leaves the card on its own inference', () => {
  // The older shape: `state` and `source` only. The card still has to answer.
  const desktop = { state: 'ok', source: 'app' }
  assert.equal(desktopCredentialInUse(desktop), true)
  assert.equal(effectiveAccountStateOf(desktop), 'ok')

  const pluginOwned = { state: 'signed-out', source: undefined, device: { state: 'ok' } }
  assert.equal(desktopCredentialInUse(pluginOwned), false)
  assert.equal(effectiveAccountStateOf(pluginOwned), 'device')
})

test('one chip names the credential actually in use', () => {
  assert.equal(credentialChipOf({ credentialKind: 'device' }), 'device')
  assert.equal(credentialChipOf({ credentialKind: 'env' }), 'env')
  assert.equal(credentialChipOf({ credentialKind: 'desktop' }), 'app')
  // Without the host\'s answer, the panel\'s old inference still holds.
  assert.equal(credentialChipOf({ state: 'ok', source: 'app' }), 'app')
  assert.equal(credentialChipOf({ state: 'ok', source: 'env-pat' }), 'env')
  assert.equal(credentialChipOf({ state: 'signed-out', source: undefined, device: { state: 'ok' } }), 'device')
  // The app chip may only appear when a credential was actually READ: in the
  // `needs-app` state the host names the app DIRECTORY, not a sign-in.
  assert.equal(credentialChipOf({ state: 'needs-app', source: undefined }), undefined)
})
