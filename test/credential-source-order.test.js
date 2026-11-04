/**
 * Where the plugin's own credential (device login) sits in the resolution order.
 *
 * Run: node --test test/credential-source-order.test.js
 *
 * The order is the whole safety argument for shipping a third source: the
 * desktop application's login stays first, so on every machine that works today
 * nothing changes -- and the vault is not even consulted. The alternative
 * (vault first) would silently switch existing users to a token they may have
 * obtained months ago, which is a behaviour change nobody asked for.
 *
 * `loadDevice` is a seam rather than a hard dependency, so "not wired up" has
 * to keep behaving exactly like "there is no third source". That is asserted
 * here rather than assumed, because it is what makes the change revertible.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CredentialCache } from '../src/host/credential-cache.ts'
import { isCredentialUsable } from '../src/host/credentials.ts'

const appCredential = (token) => ({ source: 'app', token, expired: false, userID: 'uid-app' })
const patCredential = (token) => ({ source: 'env-pat', token, userID: '', expiresAt: 0 })
const deviceCredential = (token, expiresAt) => ({
  source: 'device',
  token,
  userID: 'uid-device',
  expiresAt,
  refreshTokenExpiresAt: expiresAt + 1000,
})

/** A cache with all three sources, each recording whether it was asked. */
function cache({ app, device, pat, now } = {}) {
  const asked = { app: 0, device: 0 }
  const cache = new CredentialCache({
    loadApp: () => {
      asked.app += 1
      return app
    },
    loadDevice: () => {
      asked.device += 1
      return device
    },
    loadEnv: () => pat,
    now,
  })
  return { cache, asked }
}

const FUTURE = Date.now() + 3600 * 1000

test('the desktop app still wins, and the vault is not even read', async () => {
  const { cache: subject, asked } = cache({
    app: appCredential('app-token'),
    device: deviceCredential('device-token', FUTURE),
  })

  const resolved = await subject.resolve()
  assert.strictEqual(resolved.token, 'app-token')
  assert.strictEqual(asked.device, 0, 'consulting the vault would be a disk read per resolution for nothing')
})

test('the vault is used when the app has nothing to say', async () => {
  const { cache: subject, asked } = cache({
    app: undefined,
    device: deviceCredential('device-token', FUTURE),
  })

  const resolved = await subject.resolve()
  assert.strictEqual(resolved.token, 'device-token')
  assert.strictEqual(resolved.source, 'device')
  assert.strictEqual(resolved.userID, 'uid-device')
  assert.strictEqual(asked.device, 1)
})

test('the vault outranks an environment PAT', async () => {
  // A signed-in, renewable token beats a hand-made one the user has to rotate
  // themselves; someone who took the trouble to sign in meant it.
  const { cache: subject } = cache({
    app: undefined,
    device: deviceCredential('device-token', FUTURE),
    pat: patCredential('pat-token'),
  })

  assert.strictEqual((await subject.resolve()).token, 'device-token')
})

test('the PAT is still the last resort', async () => {
  const { cache: subject } = cache({ app: undefined, device: undefined, pat: patCredential('pat-token') })
  assert.strictEqual((await subject.resolve()).token, 'pat-token')
})

test('a lapsed app credential does not shadow the plugin\'s own credential', async () => {
  // The desktop app refreshes its own login while it runs, but the token it
  // left on disk stops working the moment it lapses -- and a lapsed token
  // serves NOTHING: every request signed with it is rejected, and the region
  // gate refuses to publish the edition over it. Shadowing the plugin's own
  // (renewable) sign-in with it would leave a machine that CAN work unable
  // to, and would hide the browser sign-in behind a desktop app that has to
  // be started again first.
  const { cache: subject, asked } = cache({
    app: { ...appCredential('app-token'), expired: true },
    device: deviceCredential('device-token', FUTURE),
  })

  const resolved = await subject.resolve()
  assert.strictEqual(resolved.token, 'device-token')
  assert.strictEqual(resolved.source, 'device')
  assert.strictEqual(asked.device, 1, 'a lapsed app store is exactly when the vault must be read')
})

test('a lapsed app credential outranks an environment PAT', async () => {
  // Same rule, one step down the chain: a working PAT beats a dead store.
  const { cache: subject } = cache({
    app: { ...appCredential('app-token'), expired: true },
    device: undefined,
    pat: patCredential('pat-token'),
  })

  const resolved = await subject.resolve()
  assert.strictEqual(resolved.token, 'pat-token')
  assert.strictEqual(resolved.source, 'env-pat')
})

test('a lapsed app credential with nothing better stays the truth about the machine', async () => {
  // Nothing else to fall back on: the desktop sign-in is expired, and saying
  // so is the honest answer. Reporting "no sign-in at all" here would hide a
  // lapsed login behind a vaguer failure, and would make the region gate log
  // "no local sign-in" for a machine that plainly has one.
  const { cache: subject, asked } = cache({
    app: { ...appCredential('app-token'), expired: true },
    device: undefined,
  })

  const resolved = await subject.resolve()
  assert.strictEqual(resolved.token, 'app-token')
  assert.strictEqual(resolved.expired, true)
  assert.strictEqual(asked.device, 1, 'the vault is read before giving up on the app')
})

test('with no third source wired, resolution is exactly what it was', async () => {
  // The revert path: deleting one line from the entry must restore the old
  // behaviour completely, with no other edit.
  const withSeam = cache({ app: undefined, pat: patCredential('pat-token') })
  assert.strictEqual((await withSeam.cache.resolve()).token, 'pat-token')
})

test('a lapsed device credential sends resolution back to the loader', async () => {
  // Rotation is the loader's business (see DeviceCredentialSource, which either
  // rotates or answers `undefined` -- it never hands back a lapsed record). The
  // cache's job is the narrower one of noticing that what it holds has lapsed,
  // because a cached value outlives the minute its expiry was computed in.
  const now = Date.now()
  const asked = []
  let held = deviceCredential('device-1', now + 3600 * 1000)
  const subject = new CredentialCache({
    loadApp: () => undefined,
    loadDevice: () => {
      asked.push(1)
      return held
    },
    loadEnv: () => undefined,
    now: () => now,
  })

  assert.strictEqual((await subject.resolve()).token, 'device-1')
  assert.strictEqual(asked.length, 1)

  assert.strictEqual((await subject.resolve()).token, 'device-1')
  assert.strictEqual(asked.length, 1, 'a usable cached value must not be re-read')

  // The token lapses while this process holds it, and the loader now has a
  // fresh one. Serving the cached record here would sign every request with a
  // dead token until DSH restarted.
  held = deviceCredential('device-2', now + 3600 * 1000)
  subject.cached = { ...subject.cached, expiresAt: now - 1 }
  assert.strictEqual((await subject.resolve()).token, 'device-2')
  assert.strictEqual(asked.length, 2, 'the loader is where rotation happens')
})

test('isCredentialUsable reads a device credential off the wall clock', () => {
  const now = 1_700_000_000_000
  // Unlike an app credential, whose `expired` flag was computed when its file
  // was read, a device credential states its own expiry -- so the clock decides
  // and a stale flag cannot make a good token look dead.
  assert.strictEqual(isCredentialUsable({ ...deviceCredential('t', now + 1), expired: true }, now), true)
  assert.strictEqual(isCredentialUsable({ ...deviceCredential('t', now - 1), expired: false }, now), false)
})
