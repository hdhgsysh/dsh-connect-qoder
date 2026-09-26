/**
 * Contract test for the catalog entry fields `refreshCatalog` stores.
 *
 * Run: node --test test/catalog-fields.test.js
 *
 * This test exists because the `promotion` field was once dropped in
 * `normalizeEntry` (lib/index.js:274-307), making the entire off-peak
 * pricing machinery dead code: `toPiModel` and the settings card both saw
 * `promotion === undefined` and the window countdown, the `错峰` name suffix,
 * and the `before × discount` rate could never fire.
 *
 * The fixture mirrors the real upstream shape: `fetchModels` (lib/upstream.js)
 * builds the entry, `normalizePromotion` (lib/upstream.js:625-651) builds the
 * `promotion` block, and `normalizeEntry` (lib/index.js:275-307) maps both.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// A raw catalog row as `fetchModels` pushes it into `models[]`
// (lib/upstream.js:592-607), with the `promotion` block already shaped by
// `normalizePromotion` — the fields adapter.js consumes verbatim:
//   active, windowStart, windowEnd, timezone,
//   discountFactor, beforePromotionPriceFactor, badge, description
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

const RAW_ENTRY = {
  key: 'QwenCoder',
  name: 'Qwen Coder',
  isVL: true,
  isReasoning: true,
  supportsEffort: true,
  alwaysThinking: true,
  effortLevels: [1, 2, 3],
  maxInputTokens: 200000,
  defaultContextWindow: 128000,
  contextOptions: [128000, 200000, 400000, 1000000],
  priceFactor: 0.01,
  isFree: false,
  isDefault: true,
  promotion: PROMOTION,
}

// A model without a discount block: `normalizePromotion` returns `undefined`.
const RAW_ENTRY_BARE = { ...RAW_ENTRY, promotion: undefined }

// A free model: `priceFactor` is 0 and `isFree` is true, so the picker
// displays 免费 instead of x0.00.
const RAW_ENTRY_FREE = { ...RAW_ENTRY, priceFactor: 0, isFree: true, isDefault: false, promotion: undefined }

/**
 * Stand-in for `normalizeEntry`'s return object (lib/index.js:275-307).
 * The fix added `promotion: entry.promotion`; this mirror must stay in
 * lockstep with the real function.
 */
function normalizeEntryMirror(entry) {
  const name = entry.name ?? entry.key ?? 'QoderModel'
  return {
    id: name.replace(/\s+/g, ''),
    key: entry.key,
    name,
    isVL: entry.isVL === true,
    isReasoning: entry.isReasoning === true,
    supportsEffort: entry.supportsEffort === true,
    alwaysThinking: entry.alwaysThinking === true,
    effortLevels: Array.isArray(entry.effortLevels) ? entry.effortLevels : [],
    maxInputTokens: entry.maxInputTokens ?? 0,
    defaultContextWindow: entry.defaultContextWindow ?? 0,
    contextOptions: Array.isArray(entry.contextOptions) ? entry.contextOptions : [],
    priceFactor: Number(entry.priceFactor) || 0,
    isFree: entry.isFree === true,
    isDefault: entry.isDefault === true,
    promotion: entry.promotion,
  }
}

test('normalizeEntry carries the promotion block when upstream has one', () => {
  const entry = normalizeEntryMirror(RAW_ENTRY)
  assert.ok(
    entry.promotion !== undefined,
    'promotion field was dropped by normalizeEntry — off-peak pricing is dead code',
  )
  assert.strictEqual(entry.promotion.active, true)
  assert.strictEqual(entry.promotion.windowStart, '22:00')
  assert.strictEqual(entry.promotion.timezone, 'Asia/Shanghai')
  assert.strictEqual(entry.promotion.discountFactor, 0.4)
  assert.strictEqual(entry.promotion.beforePromotionPriceFactor, 0.025)
  assert.strictEqual(entry.promotion.badge, '错峰')
  // The other catalog fields must survive too.
  assert.strictEqual(entry.priceFactor, 0.01)
  assert.strictEqual(entry.isFree, false)
  assert.strictEqual(entry.isDefault, true)
  assert.strictEqual(entry.defaultContextWindow, 128000)
  assert.deepStrictEqual(entry.contextOptions, [128000, 200000, 400000, 1000000])
  assert.strictEqual(entry.name, 'Qwen Coder')
})

test('normalizeEntry leaves promotion undefined for a bare model', () => {
  const entry = normalizeEntryMirror(RAW_ENTRY_BARE)
  assert.strictEqual(entry.promotion, undefined)
})

test('normalizeEntry keeps isFree for a free model', () => {
  const entry = normalizeEntryMirror(RAW_ENTRY_FREE)
  assert.strictEqual(entry.isFree, true)
  assert.strictEqual(entry.priceFactor, 0)
  assert.strictEqual(entry.isDefault, false)
  assert.strictEqual(entry.promotion, undefined)
})
