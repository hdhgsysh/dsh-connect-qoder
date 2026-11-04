/**
 * Guard the card's refresh verdict against regressions in the shipped bundle.
 *
 * Run: node --test test/protocol-shape-card.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * Issue 10's third acceptance criterion is a card-level requirement: when the
 * host reports a protocol shape change, the next action the card offers must
 * NOT be "sign in again". That wording lived only in a JSX expression, so it
 * had the same problem as the off-peak gate this repository already had to
 * re-guard: it was untested, and a reworded or dropped branch would ship green.
 *
 * So the decision is a pure function, `refreshNoticeKey`, extracted from the
 * card, and it is read out of the SHIPPED bundle here — the same technique
 * `test/client-bundle.test.js` uses for `offPeakState`, and for the same
 * reason: a hand-written copy in the test file would assert against itself.
 * Deleting or inverting the function in `lib/client.js` turns this file red.
 *
 * The card renders four states and the host sends the inputs:
 *   - no failures           → the "已更新（time）" stamp, rows are current;
 *   - a transient failure   → the stamp, marked stale, retry is the next move;
 *   - persist               → "not persisted", rows are real but not durable;
 *   - protocol-shape-changed → "update the plugin", and no timestamp at all.
 *
 * The last one is the point: a plugin that reads an envelope it does not know
 * cannot be fixed by a login, and a time next to that message implies the rows
 * on screen are current when they are not. `persist` got its own verdict for
 * the mirror reason: the rows ARE current, and stamping them "stale" (or
 * "updated") would hide the one fact that matters — they will not survive a
 * restart.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BUNDLE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'),
  'utf8',
)

/** Pull one function out of the bundle by name, walking braces. */
function extract(name) {
  const header = new RegExp(`function ${name}\\([^)]*\\) \\{`).exec(BUNDLE)
  if (header === null) return null
  let depth = 0
  for (let i = BUNDLE.indexOf('{', header.index); i < BUNDLE.length; i++) {
    if (BUNDLE[i] === '{') depth++
    else if (BUNDLE[i] === '}') {
      depth--
      if (depth === 0) return BUNDLE.slice(header.index, i + 1)
    }
  }
  return null
}

const source = extract('refreshNoticeKey')
assert.ok(source !== null, 'could not extract `refreshNoticeKey` from lib/client.js — rebuild it from src/client/')
// eslint-disable-next-line no-new-func
const refreshNoticeKey = new Function(`${source}; return refreshNoticeKey;`)()

test('a healthy payload shows the honest "updated" stamp and nothing else', () => {
  assert.strictEqual(refreshNoticeKey({ refreshedAt: 1, refreshFailures: [] }), null)
  // A host from before this change sends no `refreshFailures` at all; that must
  // read as healthy, not as a failure with an empty reason.
  assert.strictEqual(refreshNoticeKey({ refreshedAt: 1 }), null)
  assert.strictEqual(refreshNoticeKey(undefined), null)
})

test('a transient failure marks the stamp stale rather than replacing it', () => {
  // The rows on screen are real — they are the last good upstream answer — so
  // the user should still see when they were fetched, and should be told to
  // retry. Hiding the time would make a real roster look like a fabrication.
  for (const reason of ['fetch', 'credential', 'no-credential']) {
    assert.strictEqual(
      refreshNoticeKey({ refreshedAt: 1, refreshFailures: [{ reason }] }),
      'transient',
      reason,
    )
  }
})

test('a protocol shape change is its own verdict, never a transient one', () => {
  // The whole point of issue 10: this is the failure that cannot be waited out
  // or signed past, so it must not be rendered as something the user retries.
  assert.strictEqual(
    refreshNoticeKey({
      refreshedAt: 1,
      refreshFailures: [{ region: 'qoder-cn', reason: 'protocol-shape-changed' }],
    }),
    'protocol-shape-changed',
  )
})

test('a swallowed disk write is its own verdict, never a transient one', () => {
  // The rows are the newest answer; only their durability failed. Marking them
  // stale ("retry") would send the user to refresh a roster that is already
  // current, and stamping them updated would hide that a restart reverts them.
  // Both would be wrong in the direction this file exists to stop.
  assert.strictEqual(
    refreshNoticeKey({
      refreshedAt: 1,
      refreshFailures: [{ region: 'qoder-cn', reason: 'persist' }],
    }),
    'persist',
  )
})

test('persist wins over a transient failure in the same payload', () => {
  // Two regions, one of each: CN's write was swallowed, the global edition
  // merely 500-ed. The persist one names a condition the user can act on
  // (retry/restart), so it is the one that shows.
  assert.strictEqual(
    refreshNoticeKey({
      refreshFailures: [
        { region: 'qoder', reason: 'fetch' },
        { region: 'qoder-cn', reason: 'persist' },
      ],
    }),
    'persist',
  )
})

test('a protocol change wins over a transient failure in the same payload', () => {
  // Two regions, one of each: CN hit a shape change, the global edition merely
  // 500-ed. The actionable one is the protocol change, so that is what shows.
  assert.strictEqual(
    refreshNoticeKey({
      refreshFailures: [
        { region: 'qoder', reason: 'fetch' },
        { region: 'qoder-cn', reason: 'protocol-shape-changed' },
      ],
    }),
    'protocol-shape-changed',
  )
})

test('a spent daily allowance is its own verdict, never a transient one', () => {
  // docs/issues/24. The rows are as real and as old as a transient failure's —
  // which is why this verdict keeps the timestamp rather than replacing it —
  // but "retry" is the one move that cannot work: the allowance resets at the
  // day boundary, so the generic stale stamp would invite a refresh loop
  // against a door that is shut until tomorrow.
  assert.strictEqual(
    refreshNoticeKey({ refreshedAt: 1, refreshFailures: [{ region: 'qoder-cn', reason: 'daily-limit' }] }),
    'daily-limit',
  )
  // Precedence, in one payload each way: the standing verdicts still win (they
  // name what the user must DO), and the allowance wins over a plain blip.
  assert.strictEqual(
    refreshNoticeKey({
      refreshFailures: [
        { region: 'qoder', reason: 'daily-limit' },
        { region: 'qoder-cn', reason: 'protocol-shape-changed' },
      ],
    }),
    'protocol-shape-changed',
  )
  assert.strictEqual(
    refreshNoticeKey({
      refreshFailures: [
        { region: 'qoder', reason: 'daily-limit' },
        { region: 'qoder-cn', reason: 'persist' },
      ],
    }),
    'persist',
  )
  assert.strictEqual(
    refreshNoticeKey({
      refreshFailures: [
        { region: 'qoder', reason: 'daily-limit' },
        { region: 'qoder-cn', reason: 'fetch' },
      ],
    }),
    'daily-limit',
  )
})

test('a malformed failures field cannot crash the card', () => {
  // The route is the untrusted input here — a hand-edited payload, an older
  // host, a proxy. Every one of these must fold to a verdict, never throw,
  // because a throw here is a card that never renders at all.
  for (const value of [null, 0, '', 'x', {}, [null, 1, 'x'], [{ reason: 1 }], { refreshFailures: {} }]) {
    const verdict = refreshNoticeKey({ refreshedAt: 1, refreshFailures: value })
    assert.ok(
      verdict === null ||
        verdict === 'transient' ||
        verdict === 'persist' ||
        verdict === 'protocol-shape-changed' ||
        verdict === 'daily-limit',
      `${JSON.stringify(value)} → ${JSON.stringify(verdict)}`,
    )
  }
})

test('the card copy for an unreadable usage/account answer points at a plugin update', () => {
  // The same contract as the roster stamp, for the OTHER three endpoints that
  // can now report a shape change (usage / campaigns / account confirm): the
  // user must be sent to "update the plugin", never to a login, because the
  // credential is not the thing that broke.
  for (const key of ['usage.protocolChanged', 'usage.promotionsProtocolChanged', 'account.confirmProtocolChanged']) {
    const strings = [...BUNDLE.matchAll(new RegExp(`"${key.replace(/\./g, '\\.')}":\\s*"([^"]*)"`, 'g'))].map((m) => m[1])
    assert.ok(strings.length >= 2, `expected a zh and an en string for ${key}, found ${strings.length}`)
    for (const text of strings) {
      assert.match(text, /插件|plugin/i, `${key} copy does not mention the plugin: ${text}`)
      assert.doesNotMatch(
        text,
        /请(先)?重新登录。$|Please (re)?sign in\.?$/,
        `${key} copy must not END by telling the user to sign in: ${text}`,
      )
    }
  }
})

test('the card copy for a protocol change points at a plugin update, not a login', () => {
  // The wording is part of the contract, so it is asserted as text: the strings
  // ship in the bundle, and a rewording that sends the user to re-authenticate
  // is the regression issue 10 named.
  for (const key of ['row.protocolChanged', 'row.refreshStale', 'row.refreshFailed', 'row.refreshed', 'row.refreshNotPersisted']) {
    assert.ok(BUNDLE.includes(key), `the card lost the ${key} string`)
  }
  const strings = [...BUNDLE.matchAll(/"row\.protocolChanged":\s*"([^"]*)"/g)].map((m) => m[1])
  assert.ok(strings.length >= 2, `expected a zh and an en string, found ${strings.length}`)
  for (const text of strings) {
    assert.match(text, /插件|plugin/i, `copy does not mention the plugin: ${text}`)
    // The words that would send the user down the wrong path. "Sign in again
    // will not help" is deliberately allowed — it names the action in order to
    // rule it out — so the check is for it being presented AS the next step.
    assert.doesNotMatch(
      text,
      /请(先)?重新登录。$|Please (re)?sign in\.?$/,
      `copy must not END by telling the user to sign in: ${text}`,
    )
  }
  // The persist copy is the whole point of the verdict: the rows on screen are
  // current, so the wording must name the restart consequence rather than
  // suggesting a refresh or pretending all is well.
  const persistStrings = [...BUNDLE.matchAll(/"row\.refreshNotPersisted":\s*"([^"]*)"/g)].map((m) => m[1])
  assert.ok(persistStrings.length >= 2, `expected a zh and an en string, found ${persistStrings.length}`)
  for (const text of persistStrings) {
    assert.match(text, /重启|restart/i, `persist copy does not name the restart consequence: ${text}`)
  }
})

test('the card copy for a spent allowance names the reset, and is not the stale stamp', () => {
  // docs/issues/24. The remedy for a daily limit is neither "retry" nor
  // "update": it is time, and the card has to say which. Both keys are asserted
  // as text because the wording IS the fix — the host could carry the reason
  // perfectly and still reach the user as "刷新失败".
  for (const key of ['row.refreshDailyLimit', 'row.refreshDailyLimitStale']) {
    const strings = [...BUNDLE.matchAll(new RegExp(`"${key.replace(/\./g, '\\.')}":\\s*"([^"]*)"`, 'g'))].map((m) => m[1])
    assert.ok(strings.length >= 2, `expected a zh and an en string for ${key}, found ${strings.length}`)
    for (const text of strings) {
      assert.match(text, /额度|allowance/i, `${key} does not name the allowance: ${text}`)
    }
  }
  // The stale stamp it replaces would have been "last updated (refresh failed)":
  // true, but it names the wrong cause and invites the retry that cannot work.
  const stale = [...BUNDLE.matchAll(/"row\.refreshDailyLimitStale":\s*"([^"]*)"/g)].map((m) => m[1])
  for (const text of stale) {
    assert.doesNotMatch(text, /刷新失败|refresh failed/i, `the allowance stamp still reads as a generic failure: ${text}`)
  }
  // The usage panel's own verdict, for the read that failed rather than the
  // roster: same reason, so the same promise (it comes back by itself).
  const usageStrings = [...BUNDLE.matchAll(/"usage\.dailyLimit":\s*"([^"]*)"/g)].map((m) => m[1])
  assert.ok(usageStrings.length >= 2, `expected a zh and an en string for usage.dailyLimit, found ${usageStrings.length}`)
  for (const text of usageStrings) {
    assert.match(text, /额度|allowance/i, `usage.dailyLimit does not name the allowance: ${text}`)
    assert.match(text, /重置|reset/i, `usage.dailyLimit does not say when it comes back: ${text}`)
  }
})
