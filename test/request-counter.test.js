/**
 * Round-trip tests for the local request counter.
 *
 * Run: node --test test/request-counter.test.js
 *
 * The counter is a filesystem claim (the same atomic write shape as the exchange
 * throttle store), so the load-bearing properties are asserted against a real
 * temporary directory rather than a mock:
 *
 *   - a bump persists and round-trips through a NEW instance over the same path
 *     (the "survives a restart" guarantee — a fresh process still sees today's
 *     count);
 *   - each region and each local day is a separate file, so midnight rollover
 *     does not carry yesterday's count forward;
 *   - the write is atomic (temp file + rename), so a crash never leaves a
 *     half-written JSON;
 *   - an invalid / out-of-bounds region component is refused (never escapes the
 *     plugin dir) — the same越界 discipline that issue 01 made load-bearing;
 *   - a failed write is logged and leaves no temp orphan;
 *   - gc removes only this plugin's stale day files, never neighbours.
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RequestCounter, localDayKey } from '../src/host/request-counter.ts'

const created = []

/** A fresh temporary directory, removed after the test. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-rc-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop(), { recursive: true, force: true })
  }
})

// A fixed wall clock so the Shanghai calendar day is deterministic. 2023-11-15
// 23:30 Asia/Shanghai is still the 15th; the rollover test bumps the clock a full
// day to land on the 16th.
const NOW = Date.UTC(2023, 10, 15, 15, 30, 0) // 23:30 UTC = 23:30 Asia/Shanghai (UTC+8)
const clock = () => NOW
const nextDay = () => NOW + 24 * 60 * 60 * 1000

function counterIn(dir, extra = {}) {
  return new RequestCounter({
    basePath: (filename) => join(dir, filename),
    now: clock,
    ...extra,
  })
}

test('localDayKey produces a Shanghai calendar day and tolerates a missing tz', () => {
  const key = localDayKey(NOW)
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/)
  // The same instant is 2023-11-15 in Shanghai (UTC+8).
  assert.strictEqual(key, '2023-11-15')
  // An unparseable timezone must degrade to null, not throw.
  assert.strictEqual(localDayKey(NOW, 'Not/AZone'), null)
})

test('a bump persists and round-trips through a new instance (restart)', () => {
  const dir = tempDir()
  const first = counterIn(dir)
  assert.deepStrictEqual(first.read('qoder-cn'), { count: null, day: '2023-11-15' })

  first.bump('qoder-cn')
  first.bump('qoder-cn')

  const second = counterIn(dir)
  const snapshot = second.read('qoder-cn')
  assert.strictEqual(snapshot.count, 2, 'a fresh process still sees today\'s count')
  assert.strictEqual(snapshot.day, '2023-11-15')
})

test('regions and days are independent files', () => {
  const dir = tempDir()
  const cn = counterIn(dir)
  cn.bump('qoder-cn')
  cn.bump('qoder-cn')
  cn.bump('qoder') // international edition

  assert.strictEqual(counterIn(dir).read('qoder-cn').count, 2)
  assert.strictEqual(counterIn(dir).read('qoder').count, 1)
  // Two day-files for two regions.
  const names = readdirSync(dir)
  assert.strictEqual(names.filter((n) => n.includes('qoder-cn')).length, 1)
  assert.strictEqual(names.filter((n) => n.includes('qoder.') && !n.includes('qoder-cn')).length, 1)
})

test('midnight rollover starts a fresh count on a new file', () => {
  const dir = tempDir()
  const dayOne = counterIn(dir, { now: clock })
  dayOne.bump('qoder-cn')
  dayOne.bump('qoder-cn')

  // The next day: a new clock, same directory.
  const dayTwo = counterIn(dir, { now: nextDay })
  dayTwo.bump('qoder-cn')

  assert.strictEqual(dayOne.read('qoder-cn').count, 2, 'yesterday keeps its count')
  assert.strictEqual(dayTwo.read('qoder-cn').count, 1, 'today starts at 1, not 3')
  assert.notStrictEqual(dayOne.read('qoder-cn').day, dayTwo.read('qoder-cn').day)
})

test('a corrupted or foreign-version file reads as unavailable, never as 0', () => {
  const dir = tempDir()
  writeFileSync(join(dir, '.qoder-request-count.qoder-cn.2023-11-15.json'), 'not json', 'utf8')
  assert.deepStrictEqual(counterIn(dir).read('qoder-cn'), { count: null, day: '2023-11-15' })

  writeFileSync(
    join(dir, '.qoder-request-count.qoder-cn.2023-11-15.json'),
    JSON.stringify({ version: 999, count: 7 }),
    'utf8',
  )
  assert.deepStrictEqual(counterIn(dir).read('qoder-cn'), { count: null, day: '2023-11-15' })
})

test('an out-of-bounds region component never writes outside the plugin dir', () => {
  const dir = tempDir()
  const warnings = []
  const counter = counterIn(dir, { logger: { warn: (m) => warnings.push(m) } })
  // A path-traversal region must be refused at the sanitizer, so neither bump
  // nor read can ever produce a path that leaves `dir` (issue 01 discipline).
  const snapshot = counter.bump('../../etc/passwd')
  assert.deepStrictEqual(snapshot, { count: null, day: null }, 'refused → no count, no write')
  assert.deepStrictEqual(counter.read('foo/bar'), { count: null, day: null })

  const names = readdirSync(dir)
  assert.strictEqual(names.length, 0, 'no file — malicious component never reached disk')
})

test('a failed write is logged and leaves no temp orphan', () => {
  const dir = tempDir()
  // A path whose parent cannot be a directory (it IS a file) makes mkdir throw.
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'x', 'utf8')
  const warnings = []
  const counter = counterIn(dir, {
    basePath: (f) => join(blocker, f),
    logger: { warn: (m) => warnings.push(m) },
  })
  assert.doesNotThrow(() => counter.bump('qoder-cn'))
  assert.strictEqual(warnings.length, 1, 'a degraded write is at least noticed')
  assert.ok(!existsSync(join(blocker, '.qoder-request-count.qoder-cn.2023-11-15.json.tmp')), 'no temp orphan')
  // The count degrades, never fakes 0.
  assert.strictEqual(counter.read('qoder-cn').count, null)
})

test('markExhausted records a local only-estimate flag without losing the count', () => {
  const dir = tempDir()
  const counter = counterIn(dir)
  counter.bump('qoder-cn')
  assert.strictEqual(counter.readExhausted('qoder-cn'), false)

  counter.markExhausted('qoder-cn')
  assert.strictEqual(counter.readExhausted('qoder-cn'), true, 'the flag is persisted')
  assert.strictEqual(counter.read('qoder-cn').count, 1, 'the count is preserved, not reset')
  // A later real request keeps incrementing past the flag.
  counter.bump('qoder-cn')
  assert.strictEqual(counter.read('qoder-cn').count, 2)
  assert.strictEqual(counter.readExhausted('qoder-cn'), true)
})

test('gc removes only this plugin’s stale day files, never neighbours', () => {
  const dir = tempDir()
  // A stale counter file two weeks old and a fresh one.
  writeFileSync(
    join(dir, '.qoder-request-count.qoder-cn.2023-01-01.json'),
    JSON.stringify({ version: 1, count: 3, day: '2023-01-01' }),
    'utf8',
  )
  writeFileSync(
    join(dir, '.qoder-request-count.qoder-cn.2023-11-15.json'),
    JSON.stringify({ version: 1, count: 1, day: '2023-11-15' }),
    'utf8',
  )
  // A non-plugin file sharing the directory must survive.
  writeFileSync(join(dir, 'someone-elses.json'), '{}', 'utf8')
  // A file with a different plugin prefix must survive too.
  writeFileSync(join(dir, '.qoder-auth.qoder-cn.json'), '{}', 'utf8')

  const counter = counterIn(dir, { keepDays: 7 })
  counter.gc(clock())

  assert.ok(!existsSync(join(dir, '.qoder-request-count.qoder-cn.2023-01-01.json')), 'stale counter gone')
  assert.ok(existsSync(join(dir, '.qoder-request-count.qoder-cn.2023-11-15.json')), 'today kept')
  assert.ok(existsSync(join(dir, 'someone-elses.json')), 'neighbour untouched')
  assert.ok(existsSync(join(dir, '.qoder-auth.qoder-cn.json')), 'other plugin file untouched')
})

// The window is the contract this counter shares with the token counter:
// `keepDays: 7` means today plus the six days before it. The original
// implementation cut off at `now - keepDays * DAY_MS`, which deleted the 7th day
// back a day early — and with keepDays=1 deleted yesterday's file too, so the
// documented "7 天" window was really 6 (or 0).

test('gc keeps exactly the keepDays window, today included', () => {
  const dir = tempDir()
  const inside = localDayKey(clock() - 6 * 24 * 60 * 60 * 1000) // 7th day back, still inside
  const outside = localDayKey(clock() - 7 * 24 * 60 * 60 * 1000) // 8th day back
  for (const day of [inside, outside]) {
    writeFileSync(
      join(dir, `.qoder-request-count.qoder-cn.${day}.json`),
      JSON.stringify({ version: 1, count: 1, day, dailyLimitHit: false }),
      'utf8',
    )
  }
  const counter = counterIn(dir, { keepDays: 7 })
  counter.gc(clock())

  assert.ok(existsSync(join(dir, `.qoder-request-count.qoder-cn.${inside}.json`)),
    'keepDays=7 must retain today plus the 6 days before it')
  assert.ok(!existsSync(join(dir, `.qoder-request-count.qoder-cn.${outside}.json`)),
    'anything older than the window is still collected')
})

test('gc with keepDays=1 keeps only today', () => {
  const dir = tempDir()
  const yesterday = localDayKey(clock() - 24 * 60 * 60 * 1000)
  writeFileSync(
    join(dir, `.qoder-request-count.qoder-cn.${yesterday}.json`),
    JSON.stringify({ version: 1, count: 4, day: yesterday, dailyLimitHit: false }),
    'utf8',
  )
  const counter = counterIn(dir, { keepDays: 1 })
  counter.gc(clock())
  assert.ok(!existsSync(join(dir, `.qoder-request-count.qoder-cn.${yesterday}.json`)),
    'with a 1-day window yesterday is outside it')
})

test('gc removes a stale tmp leftover as well', () => {
  const dir = tempDir()
  const stale = localDayKey(clock() - 30 * 24 * 60 * 60 * 1000)
  const staleTmp = `.qoder-request-count.qoder-cn.${stale}.json.tmp`
  writeFileSync(join(dir, staleTmp), '{"version":1', 'utf8')
  counterIn(dir, { keepDays: 7 }).gc(clock())
  assert.ok(!existsSync(join(dir, staleTmp)),
    'the token counter collects its tmp leftovers; this counter must not be the one that accumulates them')
})

test('gc throttles to at most one directory scan per local day', () => {
  const dir = tempDir()
  const counter = counterIn(dir, { keepDays: 7 })
  const stale = localDayKey(clock() - 30 * 24 * 60 * 60 * 1000)
  writeFileSync(join(dir, `.qoder-request-count.qoder-cn.${stale}.json`),
    JSON.stringify({ version: 1, count: 1, day: stale, dailyLimitHit: false }), 'utf8')
  counter.gc(clock())
  assert.ok(!existsSync(join(dir, `.qoder-request-count.qoder-cn.${stale}.json`)),
    'the first call of the day really scans and collects')
  // A leftover that appears AFTER the day's scan (a mid-write crash): the
  // same-day repeat must not re-scan — the throttle returns before readdir,
  // so this file is still here…
  const freshTmp = join(dir, `.qoder-request-count.qoder-cn.${localDayKey(clock() - 31 * 24 * 60 * 60 * 1000)}.json.tmp`)
  writeFileSync(freshTmp, '{"version":1', 'utf8')
  counter.gc(clock())
  assert.ok(existsSync(freshTmp), 'same-day repeat is a no-op')
  // …and the next local day's first call picks it up — the window is one
  // polling round after midnight, not one week.
  counter.gc(nextDay())
  assert.ok(!existsSync(freshTmp), 'the next local day scans again and collects it')
})

test('the written file carries only counter fields, never a token', () => {
  const dir = tempDir()
  const path = join(dir, '.qoder-request-count.qoder-cn.2023-11-15.json')
  counterIn(dir).bump('qoder-cn')
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepStrictEqual(
    Object.keys(parsed).sort(),
    ['count', 'dailyLimitHit', 'day', 'version'],
    'display state only; a secret must never land here',
  )
  assert.strictEqual(parsed.version, 1)
})
