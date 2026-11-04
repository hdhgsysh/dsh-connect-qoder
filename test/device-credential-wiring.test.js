/**
 * The wiring that turns the device credential from a module into a live source.
 *
 * Run: node --test test/device-credential-wiring.test.js
 *
 * `index.ts` cannot be imported by a test — it pulls Cordis peer packages that
 * only resolve inside a live Host — so its wiring is asserted as source text,
 * the way `account-reload.test.js` and `publish-regions.test.js` already do.
 *
 * This file exists because the units all passed while the feature was dead:
 * `device-credential.ts` had tests, `credential-cache.ts` had tests, and nothing
 * had ever connected them. Issue 20 is the precedent — a fix verified in `src/`
 * that never reached the shipped `lib/` — and that is why the last test here
 * reads the built artifact rather than the source.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const source = readFileSync(new URL('src/host/index.ts', root), 'utf8')

/** The balanced `{...}` block that follows the first occurrence of `marker`. */
function blockAfter(text, marker) {
  const at = text.indexOf(marker)
  assert.notStrictEqual(at, -1, `index.ts no longer contains ${marker}`)
  const open = text.indexOf('{', at)
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${marker}`)
}

test('a region builds its own vault, under a path no other region can reach', () => {
  const device = blockAfter(source, 'function deviceSourceFor(')
  assert.match(device, /region: region\.id/, 'the source must be bound to this region, not to "the plugin"')
  // The path carries the region id, the way the catalog and the PAT throttle
  // already do: one file per region, so switching tabs cannot cross credentials
  // and a sign-out in one region cannot delete the other region's.
  assert.match(device, /qoderCatalogPath\(`\.qoder-auth\.\$\{region\.id\}\.json`\)/)
})

test('every region resolves through the one source the routes also use', () => {
  // Two instances over one path would mean two refresh-failure windows and two
  // stale caches of the same credential, so the runtime takes the shared
  // instance instead of building its own; the sign-in routes write through the
  // same map, which is what lets a region that has never started be signed in.
  const at = source.indexOf('this.device = device ??')
  assert.notStrictEqual(at, -1, 'the runtime must take the shared source, not build its own')
  assert.match(source.slice(at, at + 120), /this\.device = device \?\? deviceSourceFor\(region, ctx\)/)
  assert.match(source, /const regionSources = new Map<string, RegionSources>\(\)/)
  assert.match(source, /onAuthorized: async \(regionId, payload, machineID\) => \{/)
  assert.match(source, /await source\.remember\(payload, machineID\)/)
  assert.match(source, /forget: async \(regionId\) => \(await regionSources\.get\(regionId\)\?\.device\.forget\(\)\) \?\? false/)
})

test('the vault is handed to the cache as the third source', () => {
  // The cache is built by one factory, so the runtime and the confirm route
  // share ONE cache per region instead of two over one credential.
  const cache = blockAfter(source, 'function credentialCacheFor(')
  assert.match(cache, /loadDevice: \(\) => device\.load\(\)/)
  // Same constructor call as the other two sources: a second, unused cache
  // would satisfy a looser check while resolving nothing.
  assert.match(cache, /loadApp:/)
  assert.match(cache, /loadEnv:/)
  assert.match(cache, /new CredentialCache\(/)
})

test('the runtime takes the shared cache, and the confirm route resolves through it', () => {
  // The confirm route answers for a region that has no runtime, so it needs a
  // credential from the same three sources the runtime would use — desktop
  // app, then the plugin's own, then the PAT. A route that read only the
  // desktop store would report "no sign-in" on exactly the machines that
  // signed in through the browser.
  assert.match(source, /this\.credentials = credentials \?\? credentialCacheFor\(region, ctx, this\.device\)/)
  assert.match(
    source,
    /readCredential: async \(region\) => regionSources\.get\(region\.id\)\?\.credentials\.resolve\(\)/,
  )
})

test('a rejection clears the device source too, so signing in again is not ignored', () => {
  const invalidate = blockAfter(source, 'invalidateCredential() {')
  assert.match(invalidate, /this\.credentials\.invalidate\(\)/)
  assert.match(invalidate, /this\.device\.retry\(\)/)
})

test('the shipped bundle actually contains the source, not just the source tree', () => {
  // The issue-20 lesson: a green unit suite over `src/` says nothing about what
  // the Host executes. If the rebuild is skipped, the feature is absent from
  // `lib/index.js` while every test above still passes.
  const bundle = readFileSync(new URL('lib/index.js', root), 'utf8')
  assert.match(bundle, /qoder-auth\./, 'the vault path template must survive bundling')
  assert.match(
    bundle,
    /could not store it; it will be renewed again|renewed a device credential but could not store/,
    'the vault-write warning must survive bundling',
  )
  assert.match(bundle, /deviceToken\/refresh/, 'the refresh endpoint must survive bundling')
})
