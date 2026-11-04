/**
 * Execute the seven card route handlers against fake request/response pairs.
 *
 * Run: node --test test/handlers.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * `src/host/index.ts` cannot be imported by a test (it pulls in the Cordis peer
 * dependencies), which is the registered gap docs/KNOWN_GAPS.md item 2（`RegionRuntime` 本身与 `activate` 的 Cordis 接线）:
 * every route's business decisions — which status an unknown region answers
 * with, what a refused save looks like, how a sign-in rejection is classified —
 * used to be unpinnable. `test/routes.ts` already executes the two gates every
 * route passes; this file is the second half: it executes the HANDLERS
 * themselves (now living in `src/host/handlers.ts`, dependency-free), so the
 * whole request→verdict chain is asserted against real code rather than
 * pattern-matched.
 *
 * What is stubbed: the HTTP transport (fake `req`/`res`), the runtime surface
 * (`resolveCredential` / `refreshCatalog` / `readUsage` / …), and the upstream
 * calls that would need the network (`claim` / `confirmUserInfo` — both
 * injectable seams with real defaults). What is NOT stubbed: the gates, the
 * payload builders, the settings verdict, the error classifier — the handlers
 * run those for real.
 *
 * This is what docs/PLAN.md §5 (P2-1) asks for: at least six routes with direct
 * assertions over method / authorization / error codes, and `handlers.ts`
 * entering the coverage denominator.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import {
  modelsHandler,
  saveHandler,
  usageHandler,
  checkinHandler,
  claimTodayFor,
  accountHandler,
  reloadHandler,
  confirmHandler,
  statusHandler,
  createTokenHistoryCache,
} from '../src/host/handlers.ts'
import { REGIONS } from '../src/host/credentials.ts'
import { ProtocolShapeChangedError, UpstreamRefusalError } from '../src/host/errors.ts'

const CN = REGIONS.find((r) => r.id === 'qoder-cn')
assert.ok(CN !== undefined, 'REGIONS lost the CN edition')
const GLOBAL = REGIONS.find((r) => r.id === 'qoder')
assert.ok(GLOBAL !== undefined, 'REGIONS lost the global edition')

/** A fake request: an EventEmitter so body readers can be fed after subscribing. */
function fakeReq({ method = 'GET', url = '/', origin, host = '127.0.0.1:19387' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { ...(origin === undefined ? {} : { origin }), host }
  req.destroy = () => { req.destroyed = true }
  return req
}

/** A fake response capturing the status, headers, and bodies sent. */
function fakeRes(req) {
  const bodies = []
  const out = { status: null, headers: null }
  const res = {
    req,
    writeHead: (status, headers) => {
      out.status = status
      out.headers = headers
    },
    end: (payload) => {
      if (payload !== undefined) bodies.push(payload)
    },
  }
  return { res, out, bodies }
}

/** The JSON of the last body the fake response sent. */
function lastJson({ bodies }) {
  assert.ok(bodies.length > 0, 'the handler sent no body')
  return JSON.parse(bodies.at(-1))
}

/** A request whose JSON body is fed AFTER the handler subscribed its readers. */
function post(req, body) {
  const buffer = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  req.emit('data', buffer)
  req.emit('end')
  return req
}

/** A logger that does not exist: the handlers call levels defensively. */
const quiet = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }

/** One started runtime, recording which lifecycle calls happened. */
function stubRuntime({ region = CN, credential, readUsage, resolveCredential, refreshCatalog } = {}) {
  const runtime = {
    region,
    resolveCredential: resolveCredential ?? (async () => credential),
    invalidateCredential: () => { runtime.invalidated = true },
    refreshCatalog: refreshCatalog ?? (async () => { runtime.refreshed = true }),
    readUsage: readUsage ?? (async () => ({ available: true, userQuota: { used: 1, total: 100 }, addOnQuota: { used: 0, total: 1000 } })),
    invalidateUsage: () => { runtime.usageInvalidated = true },
    catalog: { current: () => [], fetchedAt: 1750000000000 },
    refreshFailed: undefined,
    invalidated: false,
    refreshed: false,
    usageInvalidated: false,
  }
  return runtime
}

const fakeRates = { rateNow: () => 1, offPeakActive: () => false, offPeakRemaining: () => undefined }

// ---------------------------------------------------------------------------
// /models
// ---------------------------------------------------------------------------

test('models: a GET serves the roster and never refreshes without refresh=1', async () => {
  const runtime = stubRuntime()
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/models' })
  const { res, out, bodies } = fakeRes(req)
  await modelsHandler(req, res, { started: [{ region: CN, runtime }], currentSettings: () => ({}), logger: quiet, rates: fakeRates })
  assert.equal(out.status, 200)
  assert.equal(runtime.refreshed, false, 'a plain GET must not hit upstream')
  const body = lastJson({ bodies })
  assert.ok(Array.isArray(body.models), 'the roster must be an array')
  assert.ok('refreshedAt' in body, 'the payload must carry the honest fetch time')
})

test('models: refresh=1 re-reads every started region, and a failing one does not blank the card', async () => {
  let calls = 0
  const ok = stubRuntime()
  const failing = stubRuntime({ refreshCatalog: async () => { throw new Error('boom') } })
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/models?refresh=1' })
  const { res, out } = fakeRes(req)
  await modelsHandler(req, res, {
    started: [{ region: CN, runtime: ok }, { region: GLOBAL, runtime: failing }],
    currentSettings: () => ({}),
    logger: { warn: (msg, error) => { calls++; assert.match(String(error), /boom/) } },
    rates: fakeRates,
  })
  assert.equal(out.status, 200, 'a refresh failure must still answer with the last good catalog')
  assert.equal(ok.refreshed, true)
  assert.equal(calls, 1, 'the failure must be named in the log, not swallowed')
})

test('models: a non-GET is refused with a 405 carrying Allow', async () => {
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/models' })
  const { res, out } = fakeRes(req)
  await modelsHandler(req, res, { started: [], currentSettings: () => ({}), logger: quiet, rates: fakeRates })
  assert.equal(out.status, 405)
  assert.match(String(out.headers.Allow), /GET/, 'the 405 must advertise what would work')
})

test('models: a cross-origin request is refused with a 403', async () => {
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/models', origin: 'http://evil.example' })
  const { res, out } = fakeRes(req)
  await modelsHandler(req, res, { started: [], currentSettings: () => ({}), logger: quiet, rates: fakeRates })
  assert.equal(out.status, 403)
})

test('models: a same-loopback-but-different-port origin is refused, not trusted by host name alone', async () => {
  // The hole `routes.ts` closed (issue 12): an Origin whose host NAME is
  // loopback but whose PORT differs from the request's Host must not pass.
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/models', origin: 'http://127.0.0.1:9999', host: '127.0.0.1:19387' })
  const { res, out } = fakeRes(req)
  await modelsHandler(req, res, { started: [], currentSettings: () => ({}), logger: quiet, rates: fakeRates })
  assert.equal(out.status, 403)
})

// ---------------------------------------------------------------------------
// /__save
// ---------------------------------------------------------------------------

test('save: a settings-absent host answers 503 with a readable body, not a 404', async () => {
  // docs/issues/06: the false-"已保存" this closed. The route must be able to
  // say "the settings service is not here" as a status the client can read.
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/__save' })
  const { res, out, bodies } = fakeRes(req)
  const pending = saveHandler(req, res, {
    getSettings: () => undefined,
    settingsNs: 'llm-qoder',
    fallbackNs: 'dsh-connect-qoder',
    refreshPicker: () => { throw new Error('must not refresh on a refused save') },
  })
  post(req, { field: 'useMaximumContextWindow', value: true })
  await pending
  assert.equal(out.status, 503)
  assert.ok(String(lastJson({ bodies }).error).length > 0, 'the 503 must carry a readable reason')
})

test('save: a valid field writes through and refreshes the picker', async () => {
  const doc = {}
  const settings = {
    describe: () => [{ ns: 'llm-qoder', value: doc }],
    mutate: async (_ns, ops) => { for (const op of ops) doc[op.path[0]] = op.value },
  }
  let picked = false
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/__save' })
  const { res, out, bodies } = fakeRes(req)
  const pending = saveHandler(req, res, {
    getSettings: () => settings,
    settingsNs: 'llm-qoder',
    fallbackNs: 'dsh-connect-qoder',
    refreshPicker: () => { picked = true },
  })
  post(req, { field: 'useMaximumContextWindow', value: true })
  await pending
  assert.equal(out.status, 200)
  assert.equal(lastJson({ bodies }).ok, true, 'a landed save must answer ok')
  assert.equal(picked, true, 'a landed save must refresh the picker')
  assert.equal(doc.useMaximumContextWindow, true)
})

test('save: a malformed JSON body is a 500 with the parse reason, not a bare crash', async () => {
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/__save' })
  const { res, out, bodies } = fakeRes(req)
  const pending = saveHandler(req, res, {
    getSettings: () => undefined,
    settingsNs: 'llm-qoder',
    fallbackNs: 'dsh-connect-qoder',
    refreshPicker: () => {},
  })
  post(req, '{not json')
  await pending
  assert.equal(out.status, 500)
  const body = lastJson({ bodies })
  assert.ok(body.errorName !== undefined, 'the 500 must name the error')
  assert.ok(String(body.error).length > 0, 'the 500 must carry the parse message')
})

test('save: a non-POST is refused with 405', async () => {
  const req = fakeReq({ method: 'GET', url: '/plugins/dsh-connect-qoder/__save' })
  const { res, out } = fakeRes(req)
  await saveHandler(req, res, { getSettings: () => undefined, settingsNs: 'x', fallbackNs: 'y', refreshPicker: () => {} })
  assert.equal(out.status, 405)
})

// ---------------------------------------------------------------------------
// /usage
// ---------------------------------------------------------------------------

test('usage: a GET reports one region per started runtime', async () => {
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true, userQuota: { used: 2, total: 100 } }) }) }],
    logger: quiet,
  })
  assert.equal(out.status, 200)
  const { regions } = lastJson({ bodies })
  assert.equal(regions.length, 1)
  assert.equal(regions[0].region, 'qoder-cn')
  assert.equal(regions[0].available, true)
})

test('usage: a failing region is reported unavailable, the panel still answers 200', async () => {
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => { throw new Error('upstream down') } }) }],
    logger: quiet,
  })
  assert.equal(out.status, 200, 'one dead sign-in must not fail the whole panel')
  assert.equal(lastJson({ bodies }).regions[0].available, false)
})

test('usage: a shape-change failure is named so the card points at a plugin update', async () => {
  // A renamed upstream envelope is not "try again later": the only remedy is
  // updating the plugin. The route names the reason; the card maps it to that
  // copy instead of the generic "usage unavailable".
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{
      region: CN,
      runtime: stubRuntime({ readUsage: async () => { throw new ProtocolShapeChangedError('no known usage field') } }),
    }],
    logger: quiet,
  })
  assert.equal(out.status, 200)
  const body = lastJson({ bodies }).regions[0]
  assert.equal(body.available, false)
  assert.equal(body.unavailableReason, 'protocol-shape-changed')
})

test('usage: an ordinary failure is NOT named as a shape change', async () => {
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => { throw new Error('ETIMEDOUT') } }) }],
    logger: quiet,
  })
  const body = lastJson({ bodies }).regions[0]
  assert.equal(body.available, false)
  assert.equal(body.unavailableReason, 'read-failed', 'a transport blip must not be blamed on the plugin version')
})

test('usage: a spent daily allowance is named, and marks the local exhausted badge', async () => {
  // docs/issues/24. This route is the surface the card polls, and the limit is
  // per ACCOUNT — but before the verdict travelled the flag, the only writer of
  // `markExhausted` was the chat shim, so a daily limit that refused the usage
  // read looked exactly like a network blip: the card said "刷新失败" and the
  // badge said nothing, for a whole day, on the one poll that knows the number.
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  const marked = []
  await usageHandler(req, res, {
    started: [{
      region: CN,
      runtime: stubRuntime({
        readUsage: async () => {
          throw new UpstreamRefusalError('HTTP 429', 429, '{"type":"daily_limit_exceeded"}')
        },
      }),
    }],
    logger: quiet,
    requestCounter: {
      read: () => ({ count: null, day: null }),
      readExhausted: () => false,
      markExhausted: (regionId) => { marked.push(regionId) },
      gc: () => {},
    },
  })
  assert.equal(out.status, 200, 'a spent allowance is a per-region verdict, not a panel outage')
  const body = lastJson({ bodies }).regions[0]
  assert.equal(body.available, false)
  assert.equal(body.unavailableReason, 'daily-limit')
  assert.deepEqual(marked, ['qoder-cn'], 'the badge is per region, and this is the region that failed')
})

test('usage: an ordinary failure does NOT mark the badge', async () => {
  // The negative control for the test above: `markExhausted` is durable (a file
  // per local day), so marking on a transient blip would leave the card
  // claiming a spent allowance it never saw. Only the verdict may write it.
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out } = fakeRes(req)
  const marked = []
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => { throw new Error('ETIMEDOUT') } }) }],
    logger: quiet,
    requestCounter: {
      read: () => ({ count: null, day: null }),
      readExhausted: () => false,
      markExhausted: (regionId) => { marked.push(regionId) },
      gc: () => {},
    },
  })
  assert.equal(out.status, 200)
  assert.deepEqual(marked, [], 'a transport failure is not evidence about the allowance')
})

test('usage: an unavailable machine identity is reported so the card can explain itself', async () => {
  // Upstream gates the international edition's campaigns endpoint on the desktop
  // app's umid machine identity; without it no claimable round is served and the
  // check-in card is legitimately absent. "Absent" read as "nothing to claim",
  // so the reason travels with the usage read.
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true }) }) }],
    logger: quiet,
    umidState: () => ({ available: false, reason: 'no matching version root' }),
  })
  assert.equal(out.status, 200)
  const body = lastJson({ bodies })
  assert.equal(body.checkin.umidAvailable, false)
  assert.equal(body.checkin.reason, 'no matching version root', 'the host reason is carried verbatim')
})

test('usage: a working machine identity is not reported at all', async () => {
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true }) }) }],
    logger: quiet,
    umidState: () => ({ available: true }),
  })
  assert.equal(out.status, 200)
  assert.equal(lastJson({ bodies }).checkin, undefined, 'a healthy machine must not raise a warning')
})

test('usage: an unavailable machine identity STILL carries a reason', async () => {
  // The reason is the entire message. A bare `umidAvailable: false` would reach
  // the card as a warning that explains nothing — the blank this fixes.
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true }) }) }],
    logger: quiet,
    umidState: () => ({ available: false }),
  })
  assert.equal(out.status, 200)
  assert.ok(String(lastJson({ bodies }).checkin.reason).length > 0)
})

test('usage: a host that sends no umid seam gets the field omitted, not faked', async () => {
  // `umidState` is optional so the route keeps working against a host that
  // predates it. Inventing a reason there would be a lie; omitting it is the
  // old, correct behaviour.
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true }) }) }],
    logger: quiet,
  })
  assert.equal(out.status, 200)
  assert.equal(lastJson({ bodies }).checkin, undefined)
})

test('usage: a wired counter with no requests today reports 0, not unavailable', async () => {
  // The counter is mounted (so the feature is connected) but the client has not
  // sent a request yet today — the file does not exist, read() returns count
  // null. That is "0 today", NOT "not wired": the card must say "0 次", never
  // "未接入". This is the ambiguity the user hit: the two used to share one line.
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true }) }) }],
    logger: quiet,
    requestCounter: { read: () => ({ count: null, day: null }), readExhausted: () => false, gc: () => {} },
  })
  assert.equal(out.status, 200)
  const body = lastJson({ bodies }).regions[0]
  assert.equal(body.requestsToday, 0, 'wired but empty is 0, not omitted')
  assert.equal(body.requestsUnavailable, undefined, 'wired must not claim it is not wired')
})

test('usage: an unwired counter reports requestsUnavailable, not a fake 0', async () => {
  // The host did not mount requestCounter (older host, or the seam is off). That
  // is genuinely "not connected"; the card must say "未接入" rather than invent
  // a 0 that would hide the fact nothing is counting.
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true }) }) }],
    logger: quiet,
  })
  assert.equal(out.status, 200)
  const body = lastJson({ bodies }).regions[0]
  assert.equal(body.requestsUnavailable, true, 'no counter mounted → explicitly not wired')
  assert.equal(body.requestsToday, undefined, 'do not fake a count when nothing is counting')
})

test('usage: a wired counter carries the daily-limit hint when set', async () => {
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true }) }) }],
    logger: quiet,
    requestCounter: { read: () => ({ count: 7, day: '2026-10-18' }), readExhausted: () => true, gc: () => {} },
  })
  assert.equal(out.status, 200)
  const body = lastJson({ bodies }).regions[0]
  assert.equal(body.requestsToday, 7)
  assert.equal(body.requestsExhausted, true, 'local estimate of a hit daily limit travels with the count')
})

// ---------------------------------------------------------------------------
// /usage — the local token counter and its 7-day history
// ---------------------------------------------------------------------------

/** A token-counter stub whose reads are counted, so caching is visible. */
function tokenCounterStub({ total = 0, cached = 0, day = '2026-10-18', history = [] } = {}) {
  const calls = { read: 0, readHistory: 0, gc: 0 }
  return {
    calls,
    counter: {
      read: () => {
        calls.read += 1
        return { total, cached, day }
      },
      readHistory: (region, days) => {
        calls.readHistory += 1
        return history
      },
      gc: () => {
        calls.gc += 1
      },
    },
  }
}

test('usage: a wired token counter with no usage today reports 0, not unavailable', async () => {
  // Same two-「查不到」 separation as the request counter: wired + empty is 0.
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true }) }) }],
    logger: quiet,
    tokenCounter: tokenCounterStub({ total: null }).counter,
  })
  assert.equal(out.status, 200)
  const body = lastJson({ bodies }).regions[0]
  assert.equal(body.tokensToday, 0, 'wired but empty is 0, not omitted')
  assert.equal(body.tokensUnavailable, undefined, 'no such flag exists; tokensToday===0 already says "wired, nothing yet"')
})

test('usage: an unwired token counter sends no token fields at all', async () => {
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true }) }) }],
    logger: quiet,
  })
  const body = lastJson({ bodies }).regions[0]
  assert.equal(body.tokensToday, undefined, 'no counter mounted → no token line, not a fake 0')
  assert.equal(body.tokensHistory, undefined)
})

test('usage: tokensCachedToday is omitted when there is no cache hit today', async () => {
  // cached === 0 and "the field was absent from every frame" are the same
  // number here, and neither deserves a line on the card.
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true }) }) }],
    logger: quiet,
    tokenCounter: tokenCounterStub({ total: 500, cached: 0 }).counter,
  })
  const body = lastJson({ bodies }).regions[0]
  assert.equal(body.tokensToday, 500)
  assert.equal(body.tokensCachedToday, undefined, 'a 0 cache-hit line is noise')
})

test('usage: the 7-day history is only read once while today’s total is unchanged', async () => {
  // The chart divides by history.length, and six of those seven records have
  // not changed since yesterday. Re-reading all seven day files on every poll
  // (and re-sending the whole array) is pure waste — the cache keys on today's
  // (day, total), which is a complete summary of the array.
  const history = [
    { day: '2026-10-12', total: 10, cached: 0 },
    { day: '2026-10-18', total: 40, cached: 5 },
  ]
  const stub = tokenCounterStub({ total: 40, cached: 5, day: '2026-10-18', history })
  const cache = createTokenHistoryCache()
  const call = async () => {
    const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
    const { res, bodies } = fakeRes(req)
    await usageHandler(req, res, {
      started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true }) }) }],
      logger: quiet,
      tokenCounter: stub.counter,
      tokenHistoryCache: cache,
    })
    return lastJson({ bodies }).regions[0]
  }

  const first = await call()
  assert.deepEqual(first.tokensHistory, history, 'the first poll reads and ships the history')
  assert.equal(stub.calls.readHistory, 1)

  const second = await call()
  assert.deepEqual(second.tokensHistory, history, 'the array is still correct')
  assert.equal(stub.calls.readHistory, 1, 'an unchanged today-total must not re-read seven files')

  const third = await call()
  assert.equal(stub.calls.readHistory, 1)
  assert.equal(stub.calls.read, 3, 'today’s read is the cheap one and still happens every poll')
})

test('usage: a growing today-total rebuilds the history so the last bar moves', async () => {
  // The cache must not pin a stale "today" bar: as the day's total grows the
  // last record has to grow with it.
  let total = 100
  const history = () => [{ day: '2026-10-18', total, cached: 0 }]
  let today = 100
  const stub = tokenCounterStub({ day: '2026-10-18', history: history() })
  stub.counter.read = () => {
    stub.calls.read += 1
    return { total: today, cached: 0, day: '2026-10-18' }
  }
  stub.counter.readHistory = () => {
    stub.calls.readHistory += 1
    return history()
  }
  const cache = createTokenHistoryCache()
  const call = async () => {
    const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
    const { res, bodies } = fakeRes(req)
    await usageHandler(req, res, {
      started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true }) }) }],
      logger: quiet,
      tokenCounter: stub.counter,
      tokenHistoryCache: cache,
    })
    return lastJson({ bodies }).regions[0]
  }

  assert.equal((await call()).tokensHistory[0].total, 100)
  total = 260
  today = 260
  assert.equal((await call()).tokensHistory[0].total, 260, 'the newest total must invalidate the cache')
  assert.equal(stub.calls.readHistory, 2, 'a changed summary re-reads the window')
})

test('usage: a day rollover rebuilds the history with a new window', async () => {
  // Midnight: today's file is a different file, so (day, total) changes and the
  // whole window is re-read. Without this the card would keep drawing yesterday's
  // window under today's title until the first request bumped the total.
  let day = '2026-10-17'
  const history = () => [{ day, total: 30, cached: 0 }]
  const stub = tokenCounterStub({ day, total: 30, history: history() })
  stub.counter.read = () => {
    stub.calls.read += 1
    return { total: 30, cached: 0, day }
  }
  stub.counter.readHistory = () => {
    stub.calls.readHistory += 1
    return history()
  }
  const cache = createTokenHistoryCache()
  const call = async () => {
    const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
    const { res, bodies } = fakeRes(req)
    await usageHandler(req, res, {
      started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true }) }) }],
      logger: quiet,
      tokenCounter: stub.counter,
      tokenHistoryCache: cache,
    })
    return lastJson({ bodies }).regions[0]
  }

  assert.equal((await call()).tokensHistory[0].day, '2026-10-17')
  day = '2026-10-18'
  assert.equal((await call()).tokensHistory[0].day, '2026-10-18', 'a new calendar day must re-read the window')
  assert.equal(stub.calls.readHistory, 2, 'a new day is a new summary')
})

test('usage: the token counter is gc’d on the usage route', async () => {
  // The route is the only thing that runs on a timer with no conversation
  // happening, so it is where stale day files get collected. A test pins the
  // wiring: move the call out of here and nothing else would ever notice.
  const stub = tokenCounterStub({ history: [] })
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true }) }) }],
    logger: quiet,
    tokenCounter: stub.counter,
    tokenHistoryCache: createTokenHistoryCache(),
  })
  assert.equal(stub.calls.gc, 1, 'the usage route must still sweep stale day files')
})

test('usage: without a history cache the route still answers, just without memoising', async () => {
  // deps.tokenHistoryCache is optional (an older host wiring it absent must not
  // break the route), so the no-cache path is the fallback, not an error.
  const stub = tokenCounterStub({ history: [{ day: '2026-10-18', total: 1, cached: 0 }] })
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => ({ available: true }) }) }],
    logger: quiet,
    tokenCounter: stub.counter,
  })
  assert.equal(out.status, 200)
  assert.equal(lastJson({ bodies }).regions[0].tokensHistory.length, 1)
  assert.equal(stub.calls.readHistory, 1)
})

// ---------------------------------------------------------------------------
// /checkin + the claim orchestration
// ---------------------------------------------------------------------------

test('checkin: an unknown region is a 404', async () => {
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/checkin?region=nope' })
  const { res, out, bodies } = fakeRes(req)
  await checkinHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime() }],
    logger: quiet,
    claim: async () => { throw new Error('must not claim for an unknown region') },
  })
  assert.equal(out.status, 404)
  assert.equal(lastJson({ bodies }).error, 'unknown-region')
})

test('checkin: a successful claim answers 200 with the outcome', async () => {
  const outcome = { region: 'qoder-cn', claimed: true, replayed: false, alreadyClaimed: false, checkin: { active: true } }
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/checkin?region=qoder-cn' })
  const { res, out, bodies } = fakeRes(req)
  await checkinHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime() }],
    logger: quiet,
    claim: async () => outcome,
  })
  assert.equal(out.status, 200)
  assert.deepEqual(lastJson({ bodies }), outcome)
})

test('checkin: a failed claim answers 502 naming the reason', async () => {
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/checkin?region=qoder-cn' })
  const { res, out, bodies } = fakeRes(req)
  await checkinHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime() }],
    logger: quiet,
    claim: async () => { throw new Error('round ended minutes ago') },
  })
  assert.equal(out.status, 502)
  assert.match(String(lastJson({ bodies }).error), /round ended minutes ago/)
})

test('checkin: no runtime means no usable sign-in — the claim refuses before any network call', async () => {
  // The default claim is the REAL orchestration (claimTodayFor): resolveCredential
  // answering undefined must throw before io.readCampaigns is ever reached.
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/checkin?region=qoder-cn' })
  const { res, out, bodies } = fakeRes(req)
  await checkinHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ credential: undefined }) }],
    logger: quiet,
  })
  assert.equal(out.status, 502)
  assert.match(String(lastJson({ bodies }).error), /no usable sign-in/)
})

/** A claimable round whose window covers "now", so the default clock passes it. */
function freshRound(claimStatus) {
  const nowS = Math.floor(Date.now() / 1000)
  return {
    campaignId: 'campaign-test-1',
    campaignKey: 'act-test',
    actionType: 'CLAIM_BENEFIT',
    startAt: nowS - 3600,
    endAt: nowS + 3600,
    claimStatus,
    benefit: { kind: 'CREDITS', amount: 100 },
  }
}
const payloadWith = (round) => ({ claimable: true, campaigns: [round] })

test('claimTodayFor: a round already claimed today answers replayed and posts nothing', async () => {
  const runtime = stubRuntime({ credential: { token: 't' } })
  const io = {
    readCampaigns: async () => payloadWith(freshRound('CLAIMED')),
    claimCampaign: async () => { throw new Error('a claimed round must never be posted at') },
  }
  const outcome = await claimTodayFor(runtime, io)
  assert.equal(outcome.claimed, false)
  assert.equal(outcome.replayed, true)
  assert.equal(outcome.alreadyClaimed, true)
  assert.equal(runtime.usageInvalidated, false, 'a replayed round grants nothing, so the usage cache stays')
})

test('claimTodayFor: a fresh grant claims, invalidates the usage cache, and reads back', async () => {
  const runtime = stubRuntime({ credential: { token: 't' } })
  const claimed = payloadWith(freshRound('CLAIMABLE'))
  const io = {
    readCampaigns: async () => claimed,
    claimCampaign: async () => ({ status: 'CLAIMED', replayed: false, benefit: { kind: 'CREDITS', amount: 100 } }),
  }
  const outcome = await claimTodayFor(runtime, io)
  assert.equal(outcome.claimed, true)
  assert.equal(outcome.replayed, false)
  assert.equal(outcome.alreadyClaimed, false)
  assert.equal(outcome.region, 'qoder-cn')
  assert.equal(runtime.usageInvalidated, true, 'the Credits landed in the add-on quota this panel renders')
})

test('claimTodayFor: no open round is a refusal, not a silent nothing', async () => {
  const runtime = stubRuntime({ credential: { token: 't' } })
  await assert.rejects(
    claimTodayFor(runtime, { readCampaigns: async () => ({ campaigns: [] }), claimCampaign: async () => ({}) }),
    /not running a check-in/,
  )
})

test('claimTodayFor: an upstream that does not confirm is a refusal', async () => {
  const runtime = stubRuntime({ credential: { token: 't' } })
  await assert.rejects(
    claimTodayFor(runtime, {
      readCampaigns: async () => payloadWith(freshRound('CLAIMABLE')),
      claimCampaign: async () => ({ status: 'FAILED' }),
    }),
    /did not confirm/,
  )
})

// ---------------------------------------------------------------------------
// /account
// ---------------------------------------------------------------------------

test('account: a GET answers the shared payload', async () => {
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/account' })
  const { res, out, bodies } = fakeRes(req)
  await accountHandler(req, res, { payload: async () => ({ regions: [{ region: 'qoder-cn', state: 'ok' }] }), logger: quiet })
  assert.equal(out.status, 200)
  assert.equal(lastJson({ bodies }).regions[0].state, 'ok')
})

test('account: a payload failure is a 500 naming the step, not a bodyless 400', async () => {
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/account' })
  const { res, out, bodies } = fakeRes(req)
  const seen = []
  await accountHandler(req, res, {
    payload: async () => { throw new Error('store unwrap failed') },
    logger: { error: (msg, error) => { seen.push(String(error)) } },
  })
  assert.equal(out.status, 500)
  assert.ok(seen.length === 1, 'the failure must reach the error log')
  assert.ok(String(lastJson({ bodies }).detail).includes('store unwrap failed'))
})

test('account: a non-GET is refused with 405', async () => {
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account' })
  const { res, out } = fakeRes(req)
  await accountHandler(req, res, { payload: async () => ({}), logger: quiet })
  assert.equal(out.status, 405)
})

// ---------------------------------------------------------------------------
// /account/reload
// ---------------------------------------------------------------------------

test('reload: re-reads the named region and asks for the forced payload', async () => {
  const runtime = stubRuntime()
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/reload' })
  const { res, out, bodies } = fakeRes(req)
  const calls = []
  const pending = reloadHandler(req, res, {
    regions: REGIONS,
    started: [{ region: CN, runtime }],
    startStoppedRegions: async (wanted) => { calls.push(['start', wanted]) },
    payload: async (options) => { calls.push(['payload', options]); return { regions: [] } },
    logger: quiet,
  })
  post(req, { region: 'qoder-cn' })
  await pending
  assert.equal(out.status, 200)
  assert.equal(runtime.invalidated, true, 're-read must drop the cached credential')
  assert.equal(runtime.refreshed, true, 're-read must force a catalog refresh')
  assert.deepEqual(calls, [['start', 'qoder-cn'], ['payload', { force: true }]], 'the reload must start stopped regions and ask for the forced read')
})

test('reload: a failing region start does not take the route down', async () => {
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/reload' })
  const { res, out, bodies } = fakeRes(req)
  const seen = []
  const pending = reloadHandler(req, res, {
    regions: REGIONS,
    started: [],
    startStoppedRegions: async () => { throw new Error('shim failed to listen') },
    payload: async () => ({ regions: [] }),
    logger: { error: (msg, error) => { seen.push(String(error)) } },
  })
  post(req, {})
  await pending
  assert.equal(out.status, 200, 'a refused region start must still answer the fresh account states')
  assert.ok(seen.length === 1, 'the failure must be logged, not swallowed')
})

test('reload: a malformed body is a 400 with a reason', async () => {
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/reload' })
  const { res, out, bodies } = fakeRes(req)
  const pending = reloadHandler(req, res, {
    regions: REGIONS,
    started: [],
    startStoppedRegions: async () => {},
    payload: async () => ({}),
    logger: quiet,
  })
  post(req, 'not json')
  await pending
  assert.equal(out.status, 400)
  assert.ok(String(lastJson({ bodies }).error).length > 0)
})

test('reload: a GET is refused with 405', async () => {
  const req = fakeReq({ method: 'GET', url: '/plugins/dsh-connect-qoder/account/reload' })
  const { res, out } = fakeRes(req)
  await reloadHandler(req, res, { regions: REGIONS, started: [], startStoppedRegions: async () => {}, payload: async () => ({}), logger: quiet })
  assert.equal(out.status, 405)
})

// ---------------------------------------------------------------------------
// /account/confirm
// ---------------------------------------------------------------------------

test('confirm: an unknown region is a 400', async () => {
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/confirm' })
  const { res, out, bodies } = fakeRes(req)
  const pending = confirmHandler(req, res, { regions: REGIONS, started: [] })
  post(req, { region: 'nope' })
  await pending
  assert.equal(out.status, 400)
  assert.equal(lastJson({ bodies }).error, 'unknown region')
})

test('confirm: a credential resolution failure is "unavailable" with the reason, not a crash', async () => {
  const runtime = stubRuntime({ resolveCredential: async () => { throw new Error('PAT exchange throttled') } })
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/confirm' })
  const { res, out, bodies } = fakeRes(req)
  const pending = confirmHandler(req, res, { regions: REGIONS, started: [{ region: CN, runtime }] })
  post(req, { region: 'qoder-cn' })
  await pending
  assert.equal(out.status, 200)
  const body = lastJson({ bodies })
  assert.equal(body.available, false)
  assert.ok(String(body.detail).includes('PAT exchange throttled'))
})

test('confirm: no credential is "unavailable", plainly', async () => {
  const runtime = stubRuntime({ credential: undefined })
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/confirm' })
  const { res, out, bodies } = fakeRes(req)
  const pending = confirmHandler(req, res, { regions: REGIONS, started: [{ region: CN, runtime }] })
  post(req, { region: 'qoder-cn' })
  await pending
  assert.equal(out.status, 200)
  assert.equal(lastJson({ bodies }).available, false)
})

test('confirm: a live sign-in confirms with identity only', async () => {
  const runtime = stubRuntime({ credential: { token: 't' } })
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/confirm' })
  const { res, out, bodies } = fakeRes(req)
  const pending = confirmHandler(req, res, {
    regions: REGIONS,
    started: [{ region: CN, runtime }],
    confirmUserInfo: async () => ({ name: 'alice', email: 'alice@example.com' }),
  })
  post(req, { region: 'qoder-cn' })
  await pending
  const body = lastJson({ bodies })
  assert.equal(out.status, 200)
  assert.equal(body.available, true)
  assert.equal(body.confirmed, true)
  assert.deepEqual(body.identity, { name: 'alice', email: 'alice@example.com' })
})

test('confirm: a sign-in rejection names itself and invalidates the cached credential', async () => {
  const runtime = stubRuntime({ credential: { token: 't' } })
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/confirm' })
  const { res, out, bodies } = fakeRes(req)
  const pending = confirmHandler(req, res, {
    regions: REGIONS,
    started: [{ region: CN, runtime }],
    confirmUserInfo: async () => { throw new Error('Login expired') },
  })
  post(req, { region: 'qoder-cn' })
  await pending
  const body = lastJson({ bodies })
  assert.equal(out.status, 200)
  assert.equal(body.confirmed, false)
  assert.equal(body.kind, 'sign-in-expired', 'a dead sign-in must be named, not blurred into "unavailable"')
  assert.equal(runtime.invalidated, true, 'the re-read after a re-sign-in must pick up the fresh store')
})

test('confirm: a protocol-shape change is named, and does not invalidate the credential', async () => {
  // Re-signing in cannot fix a response the plugin no longer understands, so
  // this must NOT be reported as sign-in-expired (that would send the user
  // through a login loop) and must NOT drop the cached credential.
  const runtime = stubRuntime({ credential: { token: 't' } })
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/confirm' })
  const { res, out, bodies } = fakeRes(req)
  const pending = confirmHandler(req, res, {
    regions: REGIONS,
    started: [{ region: CN, runtime }],
    confirmUserInfo: async () => { throw new ProtocolShapeChangedError('no identity field') },
  })
  post(req, { region: 'qoder-cn' })
  await pending
  const body = lastJson({ bodies })
  assert.equal(out.status, 200)
  assert.equal(body.available, true, 'the credential exists; only the answer is unreadable')
  assert.equal(body.confirmed, false)
  assert.equal(body.kind, 'protocol-shape-changed')
  assert.equal(runtime.invalidated, false, 'a shape change is not the credential going bad')
})

test('confirm: any other failure is "unavailable", not "sign in again"', async () => {
  const runtime = stubRuntime({ credential: { token: 't' } })
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/confirm' })
  const { res, out, bodies } = fakeRes(req)
  const pending = confirmHandler(req, res, {
    regions: REGIONS,
    started: [{ region: CN, runtime }],
    confirmUserInfo: async () => { throw new Error('socket hang up') },
  })
  post(req, { region: 'qoder-cn' })
  await pending
  const body = lastJson({ bodies })
  assert.equal(body.confirmed, false)
  assert.equal(body.kind, 'unavailable')
  assert.equal(runtime.invalidated, false, 'a transport failure is not a sign-in verdict')
})

test('confirm: a GET is refused with 405', async () => {
  const req = fakeReq({ method: 'GET', url: '/plugins/dsh-connect-qoder/account/confirm' })
  const { res, out } = fakeRes(req)
  await confirmHandler(req, res, { regions: REGIONS, started: [] })
  assert.equal(out.status, 405)
})

test('confirm: a region with no running runtime is read through the ASYNC unwrapper', async () => {
  // The recovery path: a sign-in that never produced a runtime (expired, or the
  // plugin started before sign-in). This branch used to call the SYNCHRONOUS
  // `loadCredential`, which spawns PowerShell and blocks the event loop for as
  // long as it takes — freezing the whole plugin because a browser button was
  // pressed. It now resolves through `loadCredentialAsync`.
  //
  // The injected reader is what makes that assertable without decrypting
  // anything on the machine running the suite.
  const reads = []
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/confirm' })
  const { res, out, bodies } = fakeRes(req)
  const pending = confirmHandler(req, res, {
    regions: REGIONS,
    started: [],
    readCredential: async (region) => { reads.push(region.id); return { token: 't' } },
    confirmUserInfo: async () => ({ name: 'alice', email: 'alice@example.com' }),
  })
  post(req, { region: 'qoder-cn' })
  await pending
  assert.equal(out.status, 200)
  assert.deepEqual(reads, ['qoder-cn'], 'the stopped region is read exactly once')
  assert.equal(lastJson({ bodies }).confirmed, true, 'a region can come back without a restart')
})

test('confirm: a stopped region signed in by the plugin itself is confirmed', async () => {
  // The plugin's own sign-in (browser sign-in) is a first-class credential, so
  // a region that never produced a runtime can still be checked. The host
  // wires the reader to the shared per-region cache, which resolves
  // desktop -> plugin-owned -> PAT; the route must not insist on the desktop
  // credential being the one that answers.
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/confirm' })
  const { res, out, bodies } = fakeRes(req)
  const pending = confirmHandler(req, res, {
    regions: REGIONS,
    started: [],
    readCredential: async () => ({ token: 'device-token', source: 'device' }),
    confirmUserInfo: async (region, credential) => {
      assert.equal(credential.source, 'device', 'the plugin-owned credential is the one being checked')
      return { name: 'alice', email: 'alice@example.com' }
    },
  })
  post(req, { region: 'qoder-cn' })
  await pending
  assert.equal(out.status, 200)
  const body = lastJson({ bodies })
  assert.equal(body.available, true)
  assert.equal(body.confirmed, true)
})

test('confirm: a throwing read for a stopped region is "unavailable" with the reason', async () => {
  // The same posture as a runtime's own resolve failure, and the reason the
  // 200-with-detail answer exists at all: a bare catch-all 400 would tell the
  // user nothing about which step failed.
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/confirm' })
  const { res, out, bodies } = fakeRes(req)
  const pending = confirmHandler(req, res, {
    regions: REGIONS,
    started: [],
    readCredential: async () => { throw new Error('OSCrypt key material unavailable') },
  })
  post(req, { region: 'qoder-cn' })
  await pending
  assert.equal(out.status, 200)
  const body = lastJson({ bodies })
  assert.equal(body.available, false)
  assert.ok(String(body.detail).includes('OSCrypt key material unavailable'))
})

test('confirm: a stopped region with no sign-in anywhere is "unavailable", plainly', async () => {
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/confirm' })
  const { res, out, bodies } = fakeRes(req)
  const pending = confirmHandler(req, res, {
    regions: REGIONS,
    started: [],
    readCredential: async () => undefined,
  })
  post(req, { region: 'qoder-cn' })
  await pending
  assert.equal(out.status, 200)
  assert.equal(lastJson({ bodies }).available, false)
})

test('no route reads a credential through the SYNCHRONOUS unwrapper', () => {
  // Structural, for the same reason `test/async-unwrap.test.js` pins the two
  // unwrap entries: the behavioural tests above inject a reader, so they cannot
  // tell an async read from a sync one that happens to return the same object.
  // The sync unwrapper spawns PowerShell and blocks the event loop for as long
  // as it takes (up to 30 s per candidate) — inside a route handler that freezes
  // the whole plugin, including every other open card. It belongs to the
  // startup sweep and the `probe/` script, which have no latency budget.
  const source = readFileSync(new URL('../src/host/handlers.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(
    source,
    /\bloadCredential\(/,
    'a route must reach the credential through loadCredentialAsync, never the blocking loadCredential',
  )
  assert.match(source, /loadCredentialAsync\(/)
})

// ---------------------------------------------------------------------------
// The branch tails the happy paths above never reach
// ---------------------------------------------------------------------------

test('usage: a read that resolves undefined is "unavailable", not an empty quota', async () => {
  // `readUsage` answering `undefined` is its own answer (issue 16's
  // false-"已更新" shape: a missing reading must not render as a zeroed one).
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/usage' })
  const { res, out, bodies } = fakeRes(req)
  await usageHandler(req, res, {
    started: [{ region: CN, runtime: stubRuntime({ readUsage: async () => undefined }) }],
    logger: quiet,
  })
  assert.equal(out.status, 200)
  assert.equal(lastJson({ bodies }).regions[0].available, false)
})

test('claimTodayFor: a campaign record with no id refuses to post an empty one', async () => {
  // Upstream changed the protocol: `claimableCampaignOf` picked a round whose
  // `campaignId` vanished. Posting an empty id would be a blind guess — this
  // names the change instead (the same discipline as
  // `ProtocolShapeChangedError`).
  const runtime = stubRuntime({ credential: { token: 't' } })
  const noId = payloadWith({ ...freshRound('CLAIMABLE'), campaignId: undefined })
  await assert.rejects(
    claimTodayFor(runtime, { readCampaigns: async () => noId, claimCampaign: async () => ({ status: 'CLAIMED' }) }),
    /no campaign id/,
  )
})

test('claimTodayFor: an unreadable read-back still answers the confirmed claim', async () => {
  // The claim landed; only the second, confirmatory read failed. The derived
  // `todayCheckedIn: true` is the most honest answer — throwing here would
  // tell the user the Credits were NOT granted after they were.
  const runtime = stubRuntime({ credential: { token: 't' } })
  let reads = 0
  const io = {
    readCampaigns: async () => {
      reads++
      if (reads === 1) return payloadWith(freshRound('CLAIMABLE'))
      throw new Error('the read-back went dark')
    },
    claimCampaign: async () => ({ status: 'CLAIMED', replayed: false, benefit: { kind: 'CREDITS', amount: 100 } }),
  }
  const outcome = await claimTodayFor(runtime, io)
  assert.equal(outcome.claimed, true, 'a landed claim must not be retracted by a failed second read')
  assert.equal(reads, 2, 'the read-back was really attempted (and really failed)')
})

test('reload: with no region named, every started region is re-read', async () => {
  // `{}` (or any non-string region) means "every region" — the invalidate loop
  // must visit each runtime, not skip past an undefined `wanted`.
  const first = stubRuntime({ region: CN })
  const second = stubRuntime({ region: GLOBAL })
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/reload' })
  const { res, out } = fakeRes(req)
  const pending = reloadHandler(req, res, {
    regions: REGIONS,
    started: [{ region: CN, runtime: first }, { region: GLOBAL, runtime: second }],
    startStoppedRegions: async () => {},
    payload: async () => ({ regions: [] }),
    logger: quiet,
  })
  post(req, {})
  await pending
  assert.equal(out.status, 200)
  assert.equal(first.invalidated, true)
  assert.equal(second.invalidated, true)
})

test('reload: naming one region leaves the other region caches alone', async () => {
  // The two-region isolation red line in miniature: re-reading one sign-in
  // must not invalidate the other region's credential cache.
  const cn = stubRuntime({ region: CN })
  const req = fakeReq({ method: 'POST', url: '/plugins/dsh-connect-qoder/account/reload' })
  const { res, out } = fakeRes(req)
  const calls = []
  const pending = reloadHandler(req, res, {
    regions: REGIONS,
    started: [{ region: CN, runtime: cn }],
    startStoppedRegions: async (wanted) => { calls.push(wanted) },
    payload: async () => ({ regions: [] }),
    logger: quiet,
  })
  post(req, { region: 'qoder' })
  await pending
  assert.equal(out.status, 200)
  assert.equal(cn.invalidated, false, 'the other region is not touched')
  assert.deepEqual(calls, ['qoder'], 'the named-but-stopped region is still started')
})

// ---------------------------------------------------------------------------
// /models and /status: the provider-registration verdict
// ---------------------------------------------------------------------------

test('models: the provider-registration failure is reported on the roster the card reads', async () => {
  // docs/issues/20 left two ways to learn that the provider half is dead: the
  // host log, and /status. The card reads neither. Folding the verdict into the
  // roster is what makes it reachable without a new fetch — so this asserts the
  // WIRING in handlers.ts, which the payload builders alone would not catch.
  const runtime = stubRuntime()
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/models' })
  const { res, out, bodies } = fakeRes(req)
  await modelsHandler(req, res, {
    started: [{ region: CN, runtime }],
    currentSettings: () => ({}),
    logger: quiet,
    rates: fakeRates,
    providerRegistrationError: new TypeError('this.ctx is undefined'),
  })
  assert.equal(out.status, 200, 'the roster still answers; the failure is added, not traded')
  assert.deepStrictEqual(lastJson({ bodies }).providerRegistration, {
    ok: false,
    errorName: 'TypeError',
  })
})

test('models: a healthy registration says so, and carries no error name', async () => {
  const runtime = stubRuntime()
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/models' })
  const { res, bodies } = fakeRes(req)
  await modelsHandler(req, res, {
    started: [{ region: CN, runtime }],
    currentSettings: () => ({}),
    logger: quiet,
    rates: fakeRates,
  })
  assert.deepStrictEqual(lastJson({ bodies }).providerRegistration, { ok: true })
})

test('status: the same failure is still reported on the diagnostic route', async () => {
  // The card learns from /models, but /models only answers when the card routes
  // mounted. /status is the route that survives issue 20's original symptom, so
  // the two must not drift apart.
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/status' })
  const { res, out, bodies } = fakeRes(req)
  await statusHandler(req, res, { startedCount: 1, providerRegistrationError: new TypeError('nope') })
  assert.equal(out.status, 200)
  assert.deepStrictEqual(lastJson({ bodies }), {
    activated: false,
    startedRegions: 1,
    providerRegistration: { ok: false, errorName: 'TypeError' },
  })
})

test('status: a non-string error name is narrowed instead of passed through', async () => {
  // The old `?? ''` style narrowing let a non-string `name` become the string
  // "42", which reads as a plausible class name in a warning line.
  const req = fakeReq({ url: '/plugins/dsh-connect-qoder/status' })
  const { res, bodies } = fakeRes(req)
  await statusHandler(req, res, { startedCount: 0, providerRegistrationError: { name: 42 } })
  assert.deepStrictEqual(lastJson({ bodies }).providerRegistration, { ok: false, errorName: 'Error' })
})
