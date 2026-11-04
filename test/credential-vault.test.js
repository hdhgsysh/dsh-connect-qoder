/**
 * Round-trip and concurrency tests for the plugin's own credential file.
 *
 * Run: node --test test/credential-vault.test.js
 *
 * This file is checked against a real temporary directory rather than a mock,
 * because every claim it makes is a filesystem claim.
 *
 * The two properties worth the most attention here are the ones a sibling
 * plugin got wrong in production (docs/issues/21-device-login-credential-source.md):
 *
 *   1. **A read-modify-write must not lose.** Two writers of this file are
 *      genuinely concurrent — a token refresh (any request that finds the token
 *      expired triggers one) and a sign-out (the user pressing the button).
 *      Interleaved naively, a refresh that read the record before the sign-out
 *      writes it back AFTER, and the credential the user just deleted comes
 *      back on the next read. The serialization test below pins the fix: the
 *      whole read-decide-write is queued, so the outcome is some serialization
 *      of the requested writes and never a mix.
 *   2. **A damaged file must not eat the good one.** Treating a parse failure
 *      as "empty, so write the default over it" turns one bad sector into
 *      permanent credential loss. The bytes are moved aside instead.
 *
 * The permission assertions are POSIX-only: on Windows `mode` on
 * `writeFileSync` does not restrict anything, so asserting 0600 there would be
 * asserting a platform behaviour Node does not implement.
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { CredentialVault, VAULT_FORMAT_VERSION, vaultRecordFrom } from '../src/host/credential-vault.ts'

const created = []

/** A fresh temporary directory, removed after the test. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-vault-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop(), { recursive: true, force: true })
  }
})

/** A fixed wall clock, so the quarantine name and `savedAt` are exact. */
const NOW = 1_700_000_000_000
const clock = () => NOW

/** A whole, plausible record. Individual tests override the field under test. */
function record(overrides = {}) {
  return {
    token: 'dt-access',
    refreshToken: 'drt-refresh',
    expiresAt: NOW + 86_400_000,
    refreshTokenExpiresAt: NOW + 365 * 86_400_000,
    userID: 'uid-1',
    name: 'Someone',
    email: 'someone@example.test',
    machineID: 'machine-1',
    savedAt: NOW,
    ...overrides,
  }
}

test('a stored credential round-trips through a new vault over the same path', () => {
  const path = join(tempDir(), 'qoder-auth.qoder-cn.json')
  const first = new CredentialVault({ path, now: clock })
  assert.strictEqual(first.read(), null, 'no file means no device credential')

  assert.strictEqual(first.save(record()), true, 'the save must report success')

  // A second vault over the same path is the stand-in for a restart.
  const second = new CredentialVault({ path, now: clock })
  const held = second.read()
  assert.ok(held !== null, 'a restart must still see the credential')
  assert.strictEqual(held.token, 'dt-access')
  assert.strictEqual(held.refreshToken, 'drt-refresh')
  assert.strictEqual(held.userID, 'uid-1')
  assert.strictEqual(held.machineID, 'machine-1')
})

test('the file on disk carries a format version, so a future shape can be told apart', () => {
  const path = join(tempDir(), 'vault.json')
  new CredentialVault({ path, now: clock }).save(record())
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  assert.strictEqual(parsed.version, VAULT_FORMAT_VERSION)
  assert.strictEqual(parsed.token, 'dt-access')
})

test('a save leaves no temp file behind', () => {
  const dir = tempDir()
  const path = join(dir, 'vault.json')
  new CredentialVault({ path, now: clock }).save(record())
  assert.deepStrictEqual(readdirSync(dir), ['vault.json'], 'the .tmp must be renamed away, not left')
})

test('an unparseable file is kept aside rather than overwritten', () => {
  const dir = tempDir()
  const path = join(dir, 'vault.json')
  writeFileSync(path, '{ this is not json', 'utf8')
  const vault = new CredentialVault({ path, now: clock })

  assert.strictEqual(vault.read(), null, 'a damaged file reads as no credential')

  const kept = readdirSync(dir).filter((name) => name.startsWith('vault.json.corrupt-'))
  assert.strictEqual(kept.length, 1, 'the unreadable bytes must be preserved under a unique name')
  assert.strictEqual(readFileSync(join(dir, kept[0]), 'utf8'), '{ this is not json', 'and preserved verbatim')
})

test('a save after a damaged read does not destroy the quarantined bytes', () => {
  const dir = tempDir()
  const path = join(dir, 'vault.json')
  writeFileSync(path, 'not json at all', 'utf8')
  const vault = new CredentialVault({ path, now: clock })

  vault.read()
  vault.save(record({ token: 'dt-replacement' }))

  assert.strictEqual(vault.read().token, 'dt-replacement')
  const kept = readdirSync(dir).filter((name) => name.startsWith('vault.json.corrupt-'))
  assert.strictEqual(kept.length, 1, 'the old bytes survived the new save')
})

test('a record of the wrong version reads as absent and is NOT quarantined', () => {
  const dir = tempDir()
  const path = join(dir, 'vault.json')
  // A parseable file of a future version is a version skew, not damage: there
  // is nothing to recover from it, and moving it aside would be noise.
  writeFileSync(path, JSON.stringify({ ...record(), version: VAULT_FORMAT_VERSION + 1 }), 'utf8')

  assert.strictEqual(new CredentialVault({ path, now: clock }).read(), null)
  assert.deepStrictEqual(readdirSync(dir), ['vault.json'], 'the file is left where it is')
})

test('a record missing what a signature needs reads as absent', () => {
  const vault = new CredentialVault({ path: join(tempDir(), 'vault.json'), now: clock })
  // Both of these would produce a credential that authenticates as nobody.
  assert.strictEqual(vaultRecordFrom({ version: VAULT_FORMAT_VERSION, userID: 'uid-1' }), undefined, 'no token')
  assert.strictEqual(vaultRecordFrom({ version: VAULT_FORMAT_VERSION, token: 'dt-x' }), undefined, 'no uid')
  assert.strictEqual(
    vaultRecordFrom({ version: VAULT_FORMAT_VERSION, token: 'dt-x', userID: '' }),
    undefined,
    'an empty uid is the shape a naive refresh-substitution would store',
  )
  assert.strictEqual(vaultRecordFrom(null), undefined)
  assert.strictEqual(vaultRecordFrom('a string'), undefined)
})

test('the vault file is owner-only', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir()
  const path = join(dir, 'vault.json')
  new CredentialVault({ path, now: clock }).save(record())
  assert.strictEqual(statSync(path).mode & 0o777, 0o600, 'a file holding a token must not be group/world readable')
})

test('concurrent read-modify-writes all land: none is lost to a stale read', async () => {
  const path = join(tempDir(), 'vault.json')
  const vault = new CredentialVault({ path, now: clock })
  vault.save(record({ savedAt: 0 }))

  // Every one of these reads the CURRENT value inside the queue. An
  // implementation that read before queueing would lose all but a few.
  const writers = []
  for (let i = 0; i < 20; i += 1) {
    writers.push(vault.update((current) => ({ ...current, savedAt: current.savedAt + 1 })))
  }
  await Promise.all(writers)

  assert.strictEqual(vault.read().savedAt, 20, 'every increment must have seen the previous one')
})

test('a sign-out queued after a refresh is not undone by that refresh', async () => {
  const path = join(tempDir(), 'vault.json')
  const vault = new CredentialVault({ path, now: clock })
  vault.save(record({ token: 'dt-old' }))

  // The shape of the real race: a refresh is already in flight when the user
  // signs out. The refresh must not write the credential back afterwards.
  const refresh = vault.update((current) => ({ ...current, token: 'dt-rotated' }))
  const signOut = vault.clear()
  await Promise.all([refresh, signOut])

  assert.strictEqual(vault.read(), null, 'the credential the user deleted must not come back')
  assert.ok(!existsSync(path), 'and not merely be unreadable through this instance')
})

test('a sign-out queued before a refresh leaves the refreshed credential', async () => {
  const path = join(tempDir(), 'vault.json')
  const vault = new CredentialVault({ path, now: clock })
  vault.save(record({ token: 'dt-old' }))

  // The mirror image, to pin that the order is what decides — not "sign-out
  // always wins", which would be a different (and wrong) rule.
  const signOut = vault.clear()
  const refresh = vault.update(() => record({ token: 'dt-rotated' }))
  await Promise.all([signOut, refresh])

  assert.strictEqual(vault.read().token, 'dt-rotated')
})

test('a throwing mutator does not poison every later update', async () => {
  const vault = new CredentialVault({ path: join(tempDir(), 'vault.json'), now: clock })
  vault.save(record({ savedAt: 0 }))

  await assert.rejects(() => vault.update(() => { throw new Error('mutator blew up') }), /mutator blew up/)
  // The chain must have survived it: without the catch on `this.chain`, this
  // second update would reject on a promise nobody is handling.
  assert.strictEqual(await vault.update((current) => ({ ...current, savedAt: 7 })), true)
  assert.strictEqual(vault.read().savedAt, 7)
})

test('a save that cannot land reports failure instead of pretending', () => {
  const dir = tempDir()
  // A directory where the file should be: mkdir and rename cannot both succeed.
  const path = join(dir, 'vault.json')
  mkdirSync(path)
  const vault = new CredentialVault({ path, now: clock })
  assert.strictEqual(vault.save(record()), false, 'the caller must be able to tell the user')
})

test('clearing an absent vault is a no-op, not an error', async () => {
  const vault = new CredentialVault({ path: join(tempDir(), 'never-written.json'), now: clock })
  assert.strictEqual(await vault.clear(), true)
  assert.strictEqual(vault.read(), null)
})

// The residue half of the red-line-2 pair: `save` writes `${path}.${pid}.tmp`
// before renaming it into place. A crash (or a kill) between the write and the
// rename leaves a plaintext 0600 credential sitting in the directory forever —
// the catch inside `save` only cleans the path its own process walks. Sweep
// runs at the start of the NEXT save; it may only touch files that match this
// vault's own name and are older than any honest write could be.

test('a stale temp left by a crashed save is swept by the next one', () => {
  const dir = tempDir()
  const path = join(dir, 'vault.json')
  // The sweep compares against the real wall clock, so this vault uses it too.
  const vault = new CredentialVault({ path })
  assert.strictEqual(vault.save(record({ token: 'dt-first' })), true)

  const orphan = join(dir, `${basename(path)}.999999.tmp`)
  writeFileSync(orphan, JSON.stringify(record({ token: 'dt-crash' })))
  const old = Math.floor((Date.now() - 120_000) / 1000)
  utimesSync(orphan, old, old)
  assert.ok(existsSync(orphan))

  assert.strictEqual(vault.save(record({ token: 'dt-second' })), true)
  assert.ok(!existsSync(orphan), 'a day-old plaintext residue must not outlive the next save')
  assert.strictEqual(vault.read().token, 'dt-second')
})

test('the sweep leaves live temps and unrelated neighbours alone', () => {
  const dir = tempDir()
  const path = join(dir, 'vault.json')
  const vault = new CredentialVault({ path })
  vault.save(record({ token: 'dt-first' }))

  const old = Math.floor((Date.now() - 120_000) / 1000)
  // A matching temp that is too young to be a crash residue — some writer is
  // possibly mid-rename with it. Sweeping it would break THEIR save.
  const live = join(dir, `${basename(path)}.888888.tmp`)
  writeFileSync(live, 'in flight')
  // Aged, but NOT this vault's name: sweeping these is exactly the issue-01
  // class of bug (the cleaner deleting files it does not own).
  const strangers = ['other.txt', 'vault-backup.json.999999.tmp', 'vault.json.999999.bak']
  for (const name of strangers) {
    const stranger = join(dir, name)
    writeFileSync(stranger, 'not mine')
    utimesSync(stranger, old, old)
  }
  utimesSync(live, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000))

  assert.strictEqual(vault.save(record({ token: 'dt-second' })), true)
  assert.ok(existsSync(live), 'a fresh matching temp belongs to a live writer, not to the sweep')
  for (const name of strangers) {
    assert.ok(existsSync(join(dir, name)), `${name} is not this vault's file to delete`)
  }
})

// ---------------------------------------------------------------------------
// Cross-process races. A second CredentialVault over the same path stands in
// for a second DSH profile: each instance has its own chain, so neither can
// serialize against the other — the exact shape of web + desktop sharing one
// Harness home (docs/KNOWN_GAPS.md, 设备登录修复轮). The guard under test
// re-reads the disk inside the chain step and refuses a write whose base has
// moved, so every interleaving below ends with ONE record standing and the
// losing writer told `false` — never a silent mix.
// ---------------------------------------------------------------------------

test('a refresh racing a cross-profile refresh does not stomp the newer record', async () => {
  const path = join(tempDir(), 'vault.json')
  const web = new CredentialVault({ path, now: clock })
  const desktop = new CredentialVault({ path, now: clock })
  web.save(record({ token: 'dt-base', savedAt: NOW }))

  // Both profiles read the same base and rotate against it. To put desktop's
  // write INSIDE web's chain-step window (between web's read and web's commit
  // re-read — the only place a cross-process write can land), desktop's save
  // is triggered from web's own mutator: that is exactly where another
  // process's writer would be mid-flight in production.
  const newer = record({ token: 'dt-desktop', savedAt: NOW + 5 })
  const webAnswer = await web.update((current) => {
    desktop.save(newer) // the rival profile commits while web's step is open
    return { ...current, token: 'dt-web', savedAt: NOW + 9 }
  })

  assert.strictEqual(webAnswer, false, 'web must be told its write did not land')
  const held = web.read()
  assert.strictEqual(held.token, 'dt-desktop', 'the newer cross-profile record must survive')
  assert.strictEqual(desktop.read().token, 'dt-desktop')
})

test('a cross-profile sign-out is honoured by a refresh that already started', async () => {
  const path = join(tempDir(), 'vault.json')
  const web = new CredentialVault({ path, now: clock })
  const desktop = new CredentialVault({ path, now: clock })
  web.save(record({ token: 'dt-base' }))

  // web's refresh mutator captures its base; desktop deletes the file before
  // web's chain step runs (queued updates resolve in order, so this interleaves
  // the two instances' steps).
  const refresh = web.update((current) => ({ ...current, token: 'dt-rotated', savedAt: NOW + 1 }))
  desktop.clear()
  await refresh

  assert.strictEqual(web.read(), null, 'a cross-profile sign-out must not be resurrected')
  assert.ok(!existsSync(path))
})

test('a cross-profile sign-in lands when the disk is empty, and is not overwritten', async () => {
  const path = join(tempDir(), 'vault.json')
  const web = new CredentialVault({ path, now: clock })
  const desktop = new CredentialVault({ path, now: clock })

  // web's remembered sign-in was decided against an empty disk; desktop's
  // sign-in lands inside web's chain-step window (via the mutator, standing
  // in for the other process's writer). web must refuse to replace it.
  const webAnswer = await web.update(() => {
    desktop.save(record({ token: 'dt-desktop-signin', machineID: 'machine-2', savedAt: NOW + 3 }))
    return record({ token: 'dt-web-signin', machineID: 'machine-3', savedAt: NOW + 4 })
  })

  assert.strictEqual(webAnswer, false)
  const held = web.read()
  assert.strictEqual(held.token, 'dt-desktop-signin', 'the first cross-profile sign-in keeps the file')
  assert.strictEqual(held.machineID, 'machine-2')
})

test('a no-op update over an unchanged disk still succeeds', async () => {
  const path = join(tempDir(), 'vault.json')
  const vault = new CredentialVault({ path, now: clock })
  vault.save(record({ token: 'dt-base' }))

  // Returning the current record unchanged must stay a success — the guard
  // exists for foreign records, not for idempotent steps.
  assert.strictEqual(await vault.update((current) => current), true)
  assert.strictEqual(vault.read().token, 'dt-base')
})

test('a foreign-version file is never stomped by an update', async () => {
  const path = join(tempDir(), 'vault.json')
  const vault = new CredentialVault({ path, now: clock })
  vault.save(record({ token: 'dt-base' }))

  // A future build (or a botched editor) rewrote the file while this chain
  // step was deciding. The re-read sees a shape this build cannot parse and
  // refuses to write over evidence it does not understand.
  writeFileSync(path, JSON.stringify({ ...record(), version: VAULT_FORMAT_VERSION + 1 }), 'utf8')
  assert.strictEqual(await vault.update((current) => ({ ...current, token: 'dt-rotated' })), false)
  assert.strictEqual(
    JSON.parse(readFileSync(path, 'utf8')).version,
    VAULT_FORMAT_VERSION + 1,
    'the foreign record is left exactly as it was',
  )
})
