/**
 * areAdjacentDays — the calendar arithmetic behind the 7-day chart's trend arrow.
 *
 * Run: node --test test/token-adjacent-days.test.js
 *
 * Regression the same diff once self-contradicted on: while the host day-walk
 * (`token-counter.ts` / `request-counter.ts`) was moved to calendar setDate
 * steps because a fixed 24h step is WRONG on DST days (adjacent calendar days
 * are 23h or 25h apart there), the chart kept comparing
 * `Math.abs(Date.parse('...T00:00:00') - ...) === 24h` — silently dropping the
 * trend arrow on every DST transition. The fix is pure UTC day ordinals, so it
 * never reads the local zone at all; this test additionally forces a DST zone
 * (Europe/Berlin) so a future "simplification" back to local parsing FAILS
 * here instead of only on machines already configured for Berlin.
 *
 * Europe/Berlin 2026: DST starts Sun 2026-03-29 (that day is 23h long),
 * ends Sun 2026-10-25 (that day is 25h long).
 */
// @ts-check

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.TZ = 'Europe/Berlin'

// Dynamic import so the zone is already forced when the module evaluates.
const { areAdjacentDays } = await import('../src/client/card-model.ts')

test('DST transition days are adjacent (the 23h/25h trap)', () => {
  assert.ok(areAdjacentDays('2026-03-28', '2026-03-29'), 'spring-forward pair (23h apart in Berlin)')
  assert.ok(areAdjacentDays('2026-03-29', '2026-03-28'), 'symmetric')
  assert.ok(areAdjacentDays('2026-10-24', '2026-10-25'), 'fall-back pair (25h apart in Berlin)')
})

test('month / year / February boundaries are adjacent across them', () => {
  assert.ok(areAdjacentDays('2026-01-31', '2026-02-01'), 'month edge')
  assert.ok(areAdjacentDays('2025-12-31', '2026-01-01'), 'year edge')
  assert.ok(areAdjacentDays('2024-02-28', '2024-02-29'), 'leap February')
  assert.ok(areAdjacentDays('2026-02-28', '2026-03-01'), 'non-leap: Feb 29 does not exist, so the 28th is followed by the 1st')
})

test('non-adjacent, equal and malformed days are refused', () => {
  // The exact misleading case the "adjacent-only" rule exists for: with no
  // zero-filled days, a sparse history's last two records can be a week apart.
  assert.ok(!areAdjacentDays('2026-10-12', '2026-10-18'), 'a 6-day gap must not read as "vs yesterday"')
  assert.ok(!areAdjacentDays('2026-10-18', '2026-10-18'), 'same day')
  assert.ok(!areAdjacentDays('2026-02-30', '2026-03-01'), 'out-of-range day must not be normalized into a real date')
  assert.ok(!areAdjacentDays('2026-13-01', '2026-13-02'), 'month 13 is not a date')
  assert.ok(!areAdjacentDays('garbage', '2026-01-02'), 'unparseable input')
})
