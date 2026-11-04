/**
 * The account reload route must not throw where the host turns a throw into a
 * bare, bodyless 400.
 *
 * The route had a real shape bug (fixed alongside these guards): `startRegion`
 * returned `{ runtime, shim }` while the stopped-region check read
 * `entry.region.id`, so every re-read threw a TypeError, dsh-host-webserver
 * caught it and answered 400 with no body — and the card's whole account panel
 * fell over to "读取账号状态失败" with nothing to show why. These guards pin
 * the two sides of that contract. The handler-side try/catch is exercised for
 * real in test/handlers.test.js; what stays textual here is the index.ts
 * delegation and the startRegion shape it feeds on.
 *
 * src/host/index.ts cannot be imported in a node test (Cordis peer dependencies),
 * so — like test/config-schema.test.js — the checks are textual against the
 * module's source.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Normalize so the literal newline markers below match on a CRLF checkout.
const source = readFileSync(new URL('../src/host/index.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n')

/** Slice from a start marker to an end marker (exclusive), over an optional source. */
function slice(start, end, fromSource = source) {
  const from = fromSource.indexOf(start)
  assert.notEqual(from, -1, `marker not found: ${start}`)
  const to = end === undefined ? fromSource.length : fromSource.indexOf(end, from)
  assert.notEqual(to, -1, `end marker not found: ${end}`)
  return fromSource.slice(from, to)
}

const startRegionBody = slice('async function startRegion(', '\n}\n')
const startStoppedRegionsBody = slice('async function startStoppedRegions(', '\n  }\n')
// The reload route's body ends where the account group ends. The three account
// routes are mounted together by `mountRouteGroup` (see src/host/route-mount.ts
// and test/route-mount.test.js), so the boundary is the group's closing bracket
// rather than the next `webServer.register` call.
const reloadHandler = slice('path: QODER_ACCOUNT_RELOAD_PATH', 'path: QODER_ACCOUNT_CONFIRM_PATH')

test('startRegion returns an entry tagged with its region', () => {
  assert.match(
    startRegionBody,
    /return \{ region, runtime, shim \}/,
    'the reload route reads entry.region.id off started entries; the entry must carry region',
  )
})

test('a shim that fails to become ready is closed, not leaked', () => {
  // `createQoderShim` calls `server.listen(0, '127.0.0.1')` BEFORE the `ready`
  // promise settles, so a rejection here can leave a listening socket behind.
  // Dropping the reference does not free the port: nothing else holds the shim
  // (the entry is built at the end of this function and is what `started` and
  // `disposeFiber` iterate), so an unclosed handle keeps the port for the life
  // of the process.
  //
  // The cleanup must be in the `ready` catch specifically. This function's two
  // other early exits happen before the shim exists, and asserting on this
  // slice keeps the guard attached to the failure path that actually owns the
  // resource.
  assert.match(
    startRegionBody,
    /await shim\.ready\s*\} catch \(error\) \{[\s\S]*?await shim\.close\(\)/,
    'the shim must be closed when its endpoint fails to start, or its port leaks',
  )
  // `close()` rejects on a real error, and an unguarded await would replace the
  // start failure being reported with the close failure — turning a diagnosable
  // "endpoint failed to start" into a bare "could not close".
  assert.match(
    startRegionBody,
    /catch \(closeError\) \{/,
    'a close failure must be logged, not allowed to replace the start error',
  )
  // And the original error must still be the one reported at error level.
  assert.match(
    startRegionBody,
    /await shim\.close\(\)[\s\S]*?loopback endpoint failed to start/,
    'the start failure must still be reported after the cleanup',
  )
})

test('the stopped-region check reads that shape back', () => {
  assert.match(
    startStoppedRegionsBody,
    /started\.some\(\(entry\) => entry\.region\.id === region\.id\)/,
    'the consumer side of the entry shape',
  )
})

test('the reload route survives a failing region start', () => {
  // The try/catch now lives in the executable reloadHandler (handlers.ts) —
  // exercised for real by test/handlers.test.js, which calls it with a
  // `startStoppedRegions` that throws. The route in index.ts must keep
  // delegating to it, so a re-inlined body cannot smuggle the throw back past
  // this file's reach; the delegation itself is what remains textual here.
  assert.match(
    reloadHandler,
    /reloadHandler\(/,
    'POST /account/reload must delegate to src/host/handlers.ts reloadHandler',
  )
})

test('a region start already in flight is not started a second time', () => {
  // `started.some(...)` alone cannot witness a concurrent start: the entry is
  // pushed only AFTER `await startRegion`, and that await covers a credential
  // read plus `shim.ready`. Two overlapping reloads therefore both pass the
  // check, both build a shim, and both push — and `disposeFiber` iterates
  // `started`, so the first entry becomes unreachable: its HTTP server keeps the
  // port and its catalog interval keeps firing for the life of the process.
  //
  // The route is the panel's "重读登录" button, so the overlap is one
  // double-click away, not a theoretical interleaving.
  assert.match(
    startStoppedRegionsBody,
    /pendingStarts\.has\(region\.id\)/,
    'the in-flight check must guard the await, not just the completed array',
  )
  assert.match(
    startStoppedRegionsBody,
    /pendingStarts\.add\(region\.id\)/,
    'the region must be marked in flight before the await',
  )
  // The clearing must be in a `finally`: a start that THROWS has to release the
  // marker too, or that region can never be recovered without a DSH restart —
  // trading a slow leak for a permanently stuck region, which is worse.
  // The `[\s\S]*?` allows the explanatory comment that sits between the two.
  assert.match(
    startStoppedRegionsBody,
    /finally \{[\s\S]*?pendingStarts\.delete\(region\.id\)/,
    'the in-flight marker must be released on both the success and the throw path',
  )
  // Ordering matters and is the whole point: the marker is added BEFORE the
  // await. Asserting only that both statements appear would pass on a version
  // that adds it after, which is the original bug with extra steps.
  const addAt = startStoppedRegionsBody.indexOf('pendingStarts.add(region.id)')
  const awaitAt = startStoppedRegionsBody.indexOf('await startRegion(')
  assert.ok(awaitAt !== -1, 'startRegion must still be awaited in this loop')
  assert.ok(
    addAt < awaitAt,
    'the in-flight marker must be set before awaiting startRegion, or the second caller still wins the race',
  )
})

test('a start that lands after the fiber was disposed releases its own entry', () => {
  // `disposeFiber` reads `started` — the list the entry joins only AFTER
  // `await startRegion` resolves. A reload in flight when the fiber is torn
  // down therefore lands after that snapshot, and nothing else will ever
  // release it: its shim's HTTP server keeps serving and its catalog interval
  // keeps firing for the life of the process.
  //
  // Three parts, all asserted: the dispose effect raises the flag, the start
  // path reads it after the await, and the late entry is released instead of
  // being kept.
  const disposeEffect = slice('ctx.effect(() => async () => {', '\n  })')

  assert.match(
    source,
    /let disposed = false/,
    'the disposal flag must be one shared flag: the dispose effect raises it and the start path reads it',
  )

  const flagAt = disposeEffect.indexOf('disposed = true')
  const disposeAt = disposeEffect.indexOf('disposeFiber(')
  assert.ok(flagAt !== -1, 'the dispose effect must raise the disposal flag')
  assert.ok(disposeAt !== -1, 'the dispose effect must still delegate to disposeFiber')
  assert.ok(
    flagAt < disposeAt,
    'the flag must go up BEFORE disposeFiber reads `started`, or a start that lands in that window still leaks',
  )

  const startAwaitAt = startStoppedRegionsBody.indexOf('await startRegion(')
  const checkAt = startStoppedRegionsBody.indexOf('if (disposed)')
  assert.ok(checkAt !== -1, 'the start path must check whether the fiber is already gone')
  assert.ok(
    checkAt > startAwaitAt,
    'the disposal check must come AFTER the await: before it, the flag cannot yet be set',
  )

  assert.match(
    startStoppedRegionsBody,
    /if \(disposed\) \{[\s\S]*?await disposeLateEntry\(/,
    'a start that lands after disposal must release its own entry',
  )
  assert.match(
    startStoppedRegionsBody,
    /disposeLateEntry\([\s\S]*?runtime: entry\.runtime[\s\S]*?shim: entry\.shim/,
    'the release must undo the late entry itself, not some other runtime',
  )

  // And the released entry must NOT join `started`: a later reader would
  // believe the region is live, and the fiber would try to dispose it twice.
  const releaseAt = startStoppedRegionsBody.indexOf('await disposeLateEntry(')
  const pushAt = startStoppedRegionsBody.indexOf('started.push(entry)')
  assert.ok(pushAt !== -1, 'a live entry must still join `started`')
  assert.ok(releaseAt < pushAt, 'the release must come before the entry joins `started`')
  const branch = startStoppedRegionsBody.slice(checkAt, pushAt)
  assert.match(
    branch,
    /\n {8}return\n/,
    'the late entry must be released and the loop abandoned, not pushed onto `started`',
  )
})
