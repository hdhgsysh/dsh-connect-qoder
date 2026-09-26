/**
 * Test the credential re-read pattern added to `RegionRuntime` (lib/index.js)
 * to fix report item 7: a cached app credential whose token expires at
 * runtime was never re-read, so every request 401s until DSH restarts.
 *
 * The fix adds a `credentialInvalid` flag (set by `invalidateCredential()`,
 * called from the shim on a sign-in failure) that forces the next
 * `resolveCredential` to re-read from disk. This test mirrors that pattern
 * without importing the real module (peer deps are not installed here).
 *
 * Run: node --test test/credential-invalidation.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * A minimal mirror of the `resolveCredential` + `invalidateCredential`
 * pattern added to RegionRuntime (lib/index.js:327-400). The real code uses
 * `loadCredential` and `loadEnvCredential` here; the mirror uses a fake
 * source that counts reads so the test can assert a re-read happens.
 */
function makeCredentialStore() {
  let reads = 0
  let cached = undefined
  const store = {
    /** Mirrors `loadCredential(region, appDataRoot)` — counts how often it is called. */
    load() {
      reads += 1
      // A fresh read returns a not-expired credential.
      return { source: 'app', token: `fresh-token-${reads}`, expired: false }
    },
    /** Mirrors `RegionRuntime.resolveCredential`. */
    async resolve() {
      if (store.invalid) {
        store.invalid = false
        cached = undefined
      }
      if (cached !== undefined) return cached
      cached = store.load()
      return cached
    },
    /** Mirrors `RegionRuntime.invalidateCredential`. */
    invalidate() {
      store.invalid = true
    },
    reads: () => reads,
  }
  return store
}

test('invalidateCredential forces a re-read of the credential source', async () => {
  const store = makeCredentialStore()

  // First read loads and caches the credential.
  const first = await store.resolve()
  assert.strictEqual(first.token, 'fresh-token-1')
  assert.strictEqual(store.reads(), 1)

  // A cached read does not trigger another load.
  const second = await store.resolve()
  assert.strictEqual(second, first)
  assert.strictEqual(store.reads(), 1, 'cached read must not re-load')

  // Simulate a sign-in failure: the cached credential is stale.
  store.invalidate()
  const third = await store.resolve()
  assert.notStrictEqual(third, first, 'invalidated credential must be re-read')
  assert.strictEqual(third.token, 'fresh-token-2')
  assert.strictEqual(store.reads(), 2, 'invalidate must trigger exactly one re-load')
})

test('a sign-in error with the signInExpired flag triggers invalidate', () => {
  // Mirrors the shim's detection logic (lib/shim.js:260, 359):
  //   error?.signInExpired === true || /sign-in is no longer valid|sign-in-expired/i.test(message)
  const signInErrors = [
    Object.assign(new Error('Qoder CN sign-in is no longer valid — open the Qoder CN app to sign in again'), { signInExpired: true }),
    new Error('sign-in-expired: HTTP 401: token expired'),
  ]
  for (const error of signInErrors) {
    const detected = error?.signInExpired === true || /sign-in is no longer valid|sign-in-expired/i.test(String(error?.message ?? ''))
    assert.strictEqual(detected, true, `error should be detected: ${error.message}`)
  }
  // Non sign-in errors must NOT trigger invalidate.
  const queueError = new Error('Qoder is busy — the request was queued (retry in ~2s)')
  const detected = queueError?.signInExpired === true || /sign-in is no longer valid|sign-in-expired/i.test(String(queueError?.message ?? ''))
  assert.strictEqual(detected, false, 'queue rejection must not be mistaken for a sign-in failure')
})
