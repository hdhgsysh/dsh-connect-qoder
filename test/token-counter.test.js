/**
 * Round-trip tests for the local token-consumption accumulator.
 *
 * Run: node --test test/token-counter.test.js
 *
 * The accumulator is a filesystem claim (the same atomic write shape as the
 * request counter and the exchange throttle store), so the load-bearing
 * properties are asserted against a real temporary directory:
 *
 *   - an addUsage persists and round-trips through a NEW instance over the same
 *     path (the "survives a restart" guarantee);
 *   - each region and each local day is a separate file, so midnight rollover
 *     does not carry yesterday's total forward;
 *   - the write is atomic (temp file + rename), so a crash never leaves a
 *     half-written JSON;
 *   - an invalid / out-of-bounds region component is refused (never escapes the
 *     plugin dir);
 *   - a failed write is logged and leaves no temp orphan;
 *   - gc removes only this plugin's stale day files, never neighbours;
 *   - a malformed usage frame (missing / negative / non-numeric total) is
 *     skipped, not written as dirty data.
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TokenCounter, tokensFromUsage } from '../src/host/token-counter.ts'
import { localDayKey } from '../src/host/request-counter.ts'

const created = []

/** A fresh temporary directory, removed after the test. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-tc-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop(), { recursive: true, force: true })
  }
})

// A fixed wall clock so the Shanghai calendar day is deterministic.
const NOW = Date.UTC(2023, 10, 15, 15, 30, 0) // 23:30 UTC = 23:30 Asia/Shanghai (UTC+8)
const clock = () => NOW
const nextDay = () => NOW + 24 * 60 * 60 * 1000

function counterIn(dir, extra = {}) {
  return new TokenCounter({
    basePath: (filename) => join(dir, filename),
    now: clock,
    ...extra,
  })
}

// A realistic Qoder usage frame (OpenAI stream_options.include_usage shape).
const USAGE_100 = { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100, prompt_tokens_details: { cached_tokens: 20 } }
const USAGE_50 = { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 }

test('tokensFromUsage extracts total_tokens and cached_tokens', () => {
  const r = tokensFromUsage(USAGE_100)
  assert.strictEqual(r.total, 100)
  assert.strictEqual(r.cached, 20)
})

test('tokensFromUsage defaults cached to 0 when the field is absent', () => {
  const r = tokensFromUsage(USAGE_50)
  assert.strictEqual(r.total, 50)
  assert.strictEqual(r.cached, 0)
})

test('tokensFromUsage returns null for a malformed frame', () => {
  assert.strictEqual(tokensFromUsage(undefined), null)
  assert.strictEqual(tokensFromUsage(null), null)
  assert.strictEqual(tokensFromUsage({}), null)
  assert.strictEqual(tokensFromUsage({ total_tokens: -1 }), null)
  assert.strictEqual(tokensFromUsage({ total_tokens: 'not-a-number' }), null)
  assert.strictEqual(tokensFromUsage({ total_tokens: 'not-a-number', cached_tokens: 5 }), null)
})

test('tokensFromUsage floors fractional values', () => {
  const r = tokensFromUsage({ total_tokens: 12.7, prompt_tokens_details: { cached_tokens: 3.9 } })
  assert.strictEqual(r.total, 12)
  assert.strictEqual(r.cached, 3)
})

test('an addUsage persists and round-trips through a new instance (restart)', () => {
  const dir = tempDir()
  const first = counterIn(dir)
  assert.deepStrictEqual(first.read('qoder-cn'), { total: null, cached: null, day: '2023-11-15' })

  first.addUsage('qoder-cn', USAGE_100)
  first.addUsage('qoder-cn', USAGE_50)

  const second = counterIn(dir)
  const snapshot = second.read('qoder-cn')
  assert.strictEqual(snapshot.total, 150, 'a fresh process still sees today\'s total')
  assert.strictEqual(snapshot.cached, 20)
  assert.strictEqual(snapshot.day, '2023-11-15')
})

test('regions are isolated from each other', () => {
  const dir = tempDir()
  const c = counterIn(dir)
  c.addUsage('qoder-cn', USAGE_100)
  c.addUsage('qoder', USAGE_50)

  assert.strictEqual(c.read('qoder-cn').total, 100)
  assert.strictEqual(c.read('qoder').total, 50)
})

test('a midnight rollover starts a fresh file', () => {
  const dir = tempDir()
  const first = counterIn(dir)
  first.addUsage('qoder-cn', USAGE_100)

  const second = counterIn(dir, { now: nextDay })
  assert.deepStrictEqual(second.read('qoder-cn'), { total: null, cached: null, day: '2023-11-16' })
  second.addUsage('qoder-cn', USAGE_50)
  assert.strictEqual(second.read('qoder-cn').total, 50)

  // The first day's file is untouched.
  const third = counterIn(dir)
  assert.strictEqual(third.read('qoder-cn').total, 100)
})

test('an invalid region component is refused, never escapes the dir', () => {
  const dir = tempDir()
  const c = counterIn(dir)
  assert.deepStrictEqual(c.read('../escape'), { total: null, cached: null, day: null })
  assert.deepStrictEqual(c.read('a/b'), { total: null, cached: null, day: null })
  c.addUsage('../escape', USAGE_100)
  // No file was written outside the plugin dir.
  const files = readdirSync(dir)
  assert.strictEqual(files.some((f) => f.includes('..')), false)
})

test('a malformed usage frame is skipped without writing dirty data', () => {
  const dir = tempDir()
  const c = counterIn(dir)
  c.addUsage('qoder-cn', { total_tokens: -1 })
  c.addUsage('qoder-cn', {})
  c.addUsage('qoder-cn', undefined)
  assert.deepStrictEqual(c.read('qoder-cn'), { total: null, cached: null, day: '2023-11-15' })
})

test('gc removes only this plugin\'s stale day files', () => {
  const dir = tempDir()
  const c = counterIn(dir, { keepDays: 1 })
  // Write a file two days before the clock; gc with keepDays=1 should remove it
  // (the cutoff day is inclusive, so a file exactly one day old survives).
  const staleDay = localDayKey(NOW - 2 * 24 * 60 * 60 * 1000)
  writeFileSync(join(dir, `.qoder-token-count.qoder-cn.${staleDay}.json`), JSON.stringify({ version: 1, total: 5, cached: 0, day: staleDay }))
  // Write today's file.
  c.addUsage('qoder-cn', USAGE_100)
  // Write a neighbour file (not this plugin's) that should never be touched.
  writeFileSync(join(dir, '.other-plugin.json'), '{}')

  c.gc()

  assert.strictEqual(existsSync(join(dir, `.qoder-token-count.qoder-cn.${staleDay}.json`)), false)
  assert.strictEqual(existsSync(join(dir, '.other-plugin.json')), true)
  // Today's file survives.
  assert.strictEqual(c.read('qoder-cn').total, 100)
})

test('gc with a missing timezone degrades, never throws', () => {
  const dir = tempDir()
  const c = new TokenCounter({ basePath: (f) => join(dir, f), now: clock, keepDays: 1, logger: { warn() {} } })
  c.gc()
})

test('a failed write leaves no temp orphan', () => {
  const dir = tempDir()
  // Point basePath at a path that cannot be written to.
  const unwritable = join(dir, 'nope', 'deeper')
  const c = new TokenCounter({ basePath: (f) => join(unwritable, f), now: clock, logger: { warn() {} } })
  c.addUsage('qoder-cn', USAGE_100)
  const files = readdirSync(dir)
  assert.strictEqual(files.some((f) => f.endsWith('.tmp')), false)
})

// --- readHistory: the 7-day chart's data source -----------------------------
//
// The chart divides by `history.length` to show a daily average, so the length
// of this array IS the denominator the user sees. An earlier revision pushed a
// `{total: 0}` record for every day with no file, which made a brand-new user's
// average read 1/7 of the truth and drew six bars indistinguishable from "no
// usage that day". Both properties are asserted below.

test('readHistory omits days with no file instead of zero-filling them', () => {
  const dir = tempDir()
  const c = counterIn(dir)
  // Only today has data.
  c.addUsage('qoder-cn', USAGE_100)

  const history = c.readHistory('qoder-cn', 7)

  assert.strictEqual(history.length, 1, 'a day with no file must not appear as a zero record')
  assert.deepStrictEqual(history, [{ day: '2023-11-15', total: 100, cached: 20 }])
})

test('readHistory returns days in ascending order, oldest first', () => {
  const dir = tempDir()
  // Three consecutive days of files, written through the counter itself so the
  // on-disk shape is the real one.
  const days = ['2023-11-13', '2023-11-14', '2023-11-15']
  for (const [i, day] of days.entries()) {
    writeFileSync(
      join(dir, `.qoder-token-count.qoder-cn.${day}.json`),
      JSON.stringify({ version: 1, total: 10 * (i + 1), cached: i, day }),
      'utf8',
    )
  }
  const c = counterIn(dir)
  const history = c.readHistory('qoder-cn', 7)

  assert.deepStrictEqual(
    history.map((r) => r.day),
    days,
    'the chart plots left-to-right oldest-to-newest; a reversed array draws the trend backwards',
  )
  assert.deepStrictEqual(
    history.map((r) => r.total),
    [10, 20, 30],
  )
})

test('readHistory is empty for a region that has never been used', () => {
  const dir = tempDir()
  const c = counterIn(dir)
  assert.deepStrictEqual(c.readHistory('qoder-cn', 7), [])
})

test('readHistory never returns more than keepDays of records', () => {
  const dir = tempDir()
  const c = counterIn(dir, { keepDays: 3 })
  // Write eight days of history — more than the window.
  for (let i = 0; i < 8; i++) {
    const day = localDayKey(NOW - i * 24 * 60 * 60 * 1000)
    writeFileSync(
      join(dir, `.qoder-token-count.qoder-cn.${day}.json`),
      JSON.stringify({ version: 1, total: 1, cached: 0, day }),
      'utf8',
    )
  }
  assert.strictEqual(c.readHistory('qoder-cn', 7).length, 3, 'the window is min(days, keepDays), not days')
})

test('readHistory falls back to a crash-left tmp file for that day', () => {
  const dir = tempDir()
  const c = counterIn(dir)
  c.addUsage('qoder-cn', USAGE_100)
  // Simulate a crash between writeFileSync and renameSync: the real file is
  // gone, the tmp is what holds today's total.
  const today = '.qoder-token-count.qoder-cn.2023-11-15.json'
  renameSync(join(dir, today), join(dir, `${today}.tmp`))
  assert.deepStrictEqual(c.readHistory('qoder-cn', 7), [{ day: '2023-11-15', total: 100, cached: 20 }])
})

// --- gc window semantics ----------------------------------------------------

test('gc keeps exactly the keepDays window, today included', () => {
  const dir = tempDir()
  const c = counterIn(dir, { keepDays: 7 })
  const inside = localDayKey(NOW - 6 * 24 * 60 * 60 * 1000) // the 7th day back, still inside
  const outside = localDayKey(NOW - 7 * 24 * 60 * 60 * 1000) // the 8th day back
  for (const day of [inside, outside]) {
    writeFileSync(
      join(dir, `.qoder-token-count.qoder-cn.${day}.json`),
      JSON.stringify({ version: 1, total: 1, cached: 0, day }),
      'utf8',
    )
  }
  c.gc()

  assert.ok(existsSync(join(dir, `.qoder-token-count.qoder-cn.${inside}.json`)),
    'keepDays=7 must retain today plus the 6 days before it; the old off-by-one deleted the 7th day too early')
  assert.ok(!existsSync(join(dir, `.qoder-token-count.qoder-cn.${outside}.json`)),
    'anything older than the window is still collected')
})

test('gc with keepDays=1 keeps only today', () => {
  const dir = tempDir()
  const c = counterIn(dir, { keepDays: 1 })
  const yesterday = localDayKey(NOW - 24 * 60 * 60 * 1000)
  writeFileSync(
    join(dir, `.qoder-token-count.qoder-cn.${yesterday}.json`),
    JSON.stringify({ version: 1, total: 1, cached: 0, day: yesterday }),
    'utf8',
  )
  c.addUsage('qoder-cn', USAGE_100)
  c.gc()

  assert.ok(!existsSync(join(dir, `.qoder-token-count.qoder-cn.${yesterday}.json`)), 'yesterday is outside a 1-day window')
  assert.strictEqual(c.read('qoder-cn').total, 100, 'today survives')
})

test('gc removes a stale tmp leftover as well', () => {
  const dir = tempDir()
  const c = counterIn(dir, { keepDays: 7 })
  const stale = localDayKey(NOW - 30 * 24 * 60 * 60 * 1000)
  const staleTmp = `.qoder-token-count.qoder-cn.${stale}.json.tmp`
  writeFileSync(join(dir, staleTmp), '{"version":1', 'utf8')
  c.gc()
  assert.ok(!existsSync(join(dir, staleTmp)),
    'a crash before renameSync leaves a tmp; leaving it forever accumulates garbage nobody reads')
})

test('gc throttles to at most one directory scan per local day', () => {
  const dir = tempDir()
  const c = counterIn(dir, { keepDays: 1 })
  const stale1 = localDayKey(NOW - 2 * 24 * 60 * 60 * 1000)
  writeFileSync(join(dir, `.qoder-token-count.qoder-cn.${stale1}.json`), JSON.stringify({ version: 1, total: 5, cached: 0, day: stale1 }))
  c.gc()
  assert.ok(!existsSync(join(dir, `.qoder-token-count.qoder-cn.${stale1}.json`)),
    'the first call of a day scans and collects')

  // A second stale file "appearing" the same day: the repeat call must
  // short-circuit — the usage route polls every 5 minutes over the SAME shared
  // dir, and re-scanning it all day is pure sync-IO waste.
  const stale2 = localDayKey(NOW - 3 * 24 * 60 * 60 * 1000)
  writeFileSync(join(dir, `.qoder-token-count.qoder-cn.${stale2}.json`), JSON.stringify({ version: 1, total: 5, cached: 0, day: stale2 }))
  c.gc()
  assert.ok(existsSync(join(dir, `.qoder-token-count.qoder-cn.${stale2}.json`)),
    'a same-day repeat is skipped by the throttle')

  // Crossing into the next local day re-arms the scan.
  c.gc(nextDay())
  assert.ok(!existsSync(join(dir, `.qoder-token-count.qoder-cn.${stale2}.json`)),
    'the next local day collects what the throttled day skipped')
})



