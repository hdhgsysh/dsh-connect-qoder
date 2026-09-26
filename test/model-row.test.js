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

/** The card's own gate, reproduced so this test fails if the card's rule changes. */
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

/** Stand-ins for the adapter's exported rate helpers. */
const RATES = {
  rateNow: (entry) => {
    const promotion = entry.promotion
    if (promotion === undefined) return Number(entry.priceFactor)
    return promotion.beforePromotionPriceFactor * promotion.discountFactor
  },
  offPeakActive: (entry) => entry.promotion?.active === true,
  offPeakRemaining: () => 1800,
}

const ENTRY = normalizeEntry({
  key: 'GLM',
  name: 'GLM 5.3',
  isVL: false,
  isReasoning: true,
  alwaysThinking: true,
  maxInputTokens: 200000,
  defaultContextWindow: 128000,
  contextOptions: [128000, 200000],
  priceFactor: 0.025,
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
  // Plus the one field the host itself computes.
  assert.strictEqual(row.promotion.remainingSeconds, 1800)
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
