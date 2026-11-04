/**
 * Failure-path policy gate (issue 16).
 *
 * Run: node --test test/failure-reporting.test.js
 *
 * The plugin's accident history is dominated by one habit: preferring a missing
 * capability to a visible error — a frozen catalog that still says "updated", a
 * fake "saved", a credential that cannot be read reported as "not signed in".
 * The review rule that came out of that audit is simple: a new failure branch
 * must leave its caller — and therefore the user — a way to learn that it
 * failed.
 *
 * This file is the executable half of that rule for the two layers the audit
 * named explicitly, each injected with one failure:
 *
 * - credentials: the diagnostic sink installed by the plugin entry
 *   (`setCredentialDiagnosticSink`), which forwards to the host logger, must
 *   receive at least one report when a cleanup has to be refused;
 * - catalog store: the `logger.warn` it is constructed with must receive at
 *   least one report when the atomic save fails.
 *
 * The assertions are deliberately ">= 1 report" rather than an exact message:
 * the rule is about the branch being observable at all, not about wording.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CatalogStore } from '../src/host/catalog-store.ts'
import { setCredentialDiagnosticSink, sweepStaleOscryptDirs } from '../src/host/credentials.ts'

/** A 32-byte key body, base64'd: the sweep's content check demands a master key's size. */
const KEY_BODY = Buffer.alloc(32, 0x42).toString('base64')
/** The identity marker the production unwrap writes; without it a dir is foreign. */
const MARKER = '.dsh-oscrypt'
/** Older than the sweep's age guard, so the fixture counts as orphaned residue. */
const STALE_MS = 60 * 60 * 1000

test('credentials: a refused cleanup reaches the diagnostic sink', () => {
  // Injected failure: OUR name and marker, but a foreign file beside them shows
  // the directory is not the exact shape the sweep owns. The correct reaction is
  // to leave it alone AND say so; the old code zeroed whatever it found and
  // reported nothing.
  //
  // The temp root is redirected for the whole sweep (not just around the
  // fixture) for the measured reason `test/credential-cleanup.test.js` records:
  // `os.tmpdir()` is read INSIDE `sweepStaleOscryptDirs`, files run
  // concurrently, and a sibling file's residue otherwise lands in this capture
  // array. All three names are set because `os.tmpdir()` consults TMPDIR, then
  // TMP, then TEMP.
  const root = mkdtempSync(join(tmpdir(), 'qoder-failure-gate-root-'))
  const savedEnv = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }
  const messages = []
  setCredentialDiagnosticSink((message) => messages.push(String(message)))
  process.env.TMPDIR = root
  process.env.TEMP = root
  process.env.TMP = root
  try {
    const dir = mkdtempSync(join(root, 'qoder-oscrypt-'))
    writeFileSync(join(dir, 'key.b64'), KEY_BODY, 'utf8')
    writeFileSync(join(dir, MARKER), '')
    writeFileSync(join(dir, 'not-ours.bin'), 'foreign')
    const old = new Date(Date.now() - STALE_MS)
    utimesSync(dir, old, old)

    sweepStaleOscryptDirs(0)

    assert.equal(existsSync(join(dir, 'not-ours.bin')), true, 'the foreign file must survive')
    assert.ok(
      messages.length >= 1,
      `a refused cleanup must report at least once; got ${JSON.stringify(messages)}`,
    )
    assert.ok(
      messages.some((message) => message.includes(dir) || /carries our marker/.test(message)),
      `the report must name this directory, not just count; got ${JSON.stringify(messages)}`,
    )
  } finally {
    setCredentialDiagnosticSink(undefined)
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('catalog store: a failed save reaches the logger', () => {
  // Injected failure: a directory where the catalog file should be, so the
  // atomic write fails with EISDIR. A silent save would present the in-memory
  // roster as persisted.
  const root = mkdtempSync(join(tmpdir(), 'qoder-failure-gate-'))
  try {
    const path = join(root, 'catalog.json')
    mkdirSync(path)
    const warnings = []
    const store = new CatalogStore({
      path,
      logger: { warn: (message) => warnings.push(String(message)) },
    })

    store.replace([])

    assert.ok(store.lastSaveError !== undefined, 'the failed save must be recorded on the store')
    assert.ok(
      warnings.length >= 1,
      `a failed save must report at least once; got ${JSON.stringify(warnings)}`,
    )
    assert.deepEqual(store.current(), [], 'the in-memory roster stays usable despite the failure')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
