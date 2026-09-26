/**
 * Contract test for the row the settings card actually renders.
 *
 * Run: node --test test/model-row.test.js
 *
 * This is the guard for the second half of the off-peak regression, and the half
 * that was still broken when the first guard was written. `normalizeEntry` did
 * carry the whole `promotion` block, and `catalog-fields.test.js` did assert it
 * — but the host route re-projected that block field by field on its way to the
 * card, and the projection left out `active` and `timezone`.
 *
 * The card gates its ticking clock on `models.some((m) => m.promotion?.active
 * === true)`. With `active` missing that gate is permanently false, so the
 * one-second interval is never installed, `setClock` never fires again, and the
 * 22:00 rate flip and countdown never happen without a manual card refresh. The
 * window and the rate still rendered, so nothing looked broken.
 *
 * The projection now lives in `lib/catalog-entry.js` as a pure function so it
 * can be asserted directly; the test imports it for the same reason the sibling
 * test stopped mirroring: a hand-written copy cannot catch a bug in the code it
 * is a copy of.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeEntry, projectModelRow } from '../lib/catalog-entry.js'
import { offPeakActive, offPeakRemaining, rateNow } from '../lib/offpeak.js'

/**
 * The card's own gate, reproduced so this test fails if the card's rule changes.
 *
 * SYNC CONSTRAINT: this is a copy of an expression that lives in the client
 * card (lib/client.js, `models.some((m) => m.promotion?.active === true)`), and
 * there is no way to import it — the card is a browser bundle built from
 * TypeScript sources that are not in this repository. So this file is
 * deliberately NOT import-clean, and it should not be read as being so.
 *
 * If the card's gate is ever rewritten, this copy has to be rewritten with it,
 * or these tests will keep passing while asserting a rule nothing implements.
 * That is the same mirror failure the sibling tests were rewritten to eliminate;
 * it is accepted here only because the alternative — no coverage of the layer
 * where the regression actually happened — is worse.
 */
function cardInstallsClock(rows) {
  return rows.some((m) => m.promotion?.active === true)
}

const PROMOTION = {
  active: true,
  windowStart: '22:00',
  windowEnd: '08:00',
  timezone: 'Asia/Shanghai',
  discountFactor: 0.4,
  beforePromotionPriceFactor: 0.025,
  badge: '错峰',
  description: '夜间折扣',
}

const REGION = { id: 'qoder-cn', displayName: 'Qoder CN' }

// The window is open, so the discount applies and the rate is the product.
const NOW = new Date('2026-09-26T23:30:00+08:00')

/**
 * The REAL rate helpers, not a stand-in.
 *
 * This used to be a hand-written `RATES` object duplicating the arithmetic. That
 * made the file unfalsifiable in the way its siblings used to be: nothing
 * checked the stand-in against the shipped `rateNow`, so "the rate flips at
 * 22:00" was being asserted against a fiction. The helpers were then moved into
 * lib/offpeak.js, which has no pi-ai dependency, so the real ones can be
 * imported here.
 *
 * The fixture's `priceFactor` is deliberately different from
 * `beforePromotionPriceFactor × discountFactor`, so a change that skipped the
 * product would be visible rather than masked by a coincidentally equal
 * fallback.
 */
const RATES = { rateNow, offPeakActive, offPeakRemaining }

const ENTRY = normalizeEntry({
  key: 'GLM',
  name: 'GLM 5.3',
  isVL: false,
  isReasoning: true,
  alwaysThinking: true,
  maxInputTokens: 200000,
  defaultContextWindow: 128000,
  contextOptions: [128000, 200000],
  priceFactor: 0.03,
  isFree: false,
  isDefault: true,
  promotion: PROMOTION,
})

test('the projected row lets the card install its ticking clock', () => {
  const row = projectModelRow(ENTRY, REGION, NOW, RATES)
  // The single assertion whose absence let a dead feature ship green: without
  // `active` on the wire this is false and the rate never updates on its own.
  assert.strictEqual(
    cardInstallsClock([row]),
    true,
    'promotion.active must reach the card or the off-peak clock never ticks',
  )
})

test('the projected row carries promotion.timezone', () => {
  const row = projectModelRow(ENTRY, REGION, NOW, RATES)
  assert.strictEqual(
    row.promotion.timezone,
    'Asia/Shanghai',
    'promotion.timezone must reach the card or the window cannot be resolved',
  )
})

test('the projected row forwards every promotion field', () => {
  const row = projectModelRow(ENTRY, REGION, NOW, RATES)
  for (const field of Object.keys(PROMOTION)) {
    assert.ok(field in row.promotion, `promotion.${field} was dropped by the host projection`)
  }
  // Plus the one field the host computes itself: the countdown to the next
  // boundary. At 23:30 with a 22:00-08:00 window, that is 8h30m away.
  assert.strictEqual(row.promotion.remainingSeconds, 8.5 * 3600)
})

test('the projected rate is the real discounted rate, not the stand-in', () => {
  // This is the assertion that was impossible while `RATES` was a hand-written
  // stand-in. Inside the window the rate must be before × discount, which for
  // this entry differs from both the raw priceFactor and the before figure.
  const row = projectModelRow(ENTRY, REGION, NOW, RATES)
  assert.ok(Math.abs(row.effectiveRate - 0.01) < 1e-9, `expected 0.01, got ${row.effectiveRate}`)
  assert.notStrictEqual(row.effectiveRate, 0.03, 'must not fall back to priceFactor')
  assert.strictEqual(row.offPeakActive, true)
})

test('a bare model projects with no promotion block at all', () => {
  const bare = normalizeEntry({
    key: 'Kimi',
    name: 'Kimi K3',
    priceFactor: 0.01,
    promotion: undefined,
  })
  const row = projectModelRow(bare, REGION, NOW, RATES)
  assert.strictEqual(row.promotion, undefined)
  assert.strictEqual(cardInstallsClock([row]), false)
  assert.strictEqual(row.effectiveRate, 0.01)
})

test('the projected row keeps identity and region fields', () => {
  const row = projectModelRow(ENTRY, REGION, NOW, RATES)
  assert.strictEqual(row.id, 'GLM5.3')
  assert.strictEqual(row.name, 'GLM 5.3')
  assert.strictEqual(row.region, 'qoder-cn')
  assert.strictEqual(row.regionName, 'Qoder CN')
  assert.strictEqual(row.isFree, false)
  assert.strictEqual(row.isDefault, true)
  assert.strictEqual(row.offPeakActive, true)
})
