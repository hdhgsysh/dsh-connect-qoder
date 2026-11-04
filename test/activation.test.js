/**
 * Execute `src/host/index.ts` itself: `apply()` with a fake Cordis context.
 *
 * Run: node --test test/activation.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * Every other host test stops at a module boundary — `handlers.ts`,
 * `account-payload.ts`, `route-mount.ts`, `region-gate.ts` are all peer-free
 * and imported directly. `index.ts` is the one file that was never in the
 * coverage denominator, and for a long time both docs/KNOWN_GAPS.md §1/§2 and
 * the comments in test/handlers.test.js and test/account-route-wiring.test.js
 * said why: it imports the Cordis peer dependencies at the top level, so a bare
 * `node --test` import died with ERR_MODULE_NOT_FOUND.
 *
 * That is no longer the whole truth, and the difference matters. This plugin
 * declares ten peers and installs none of them (`peerDependenciesMeta` marks
 * only `cordis` optional, and `.npmrc` sets `legacy-peer-deps` precisely so npm
 * does not try). On a machine that has a DSH runtime — a developer's machine,
 * which is where the plugin is edited — the four peers `index.ts` imports
 * values from (`dsh-home-paths`, `dsh-llm`, `dsh-llm-pi-ai`, `schemastery`)
 * are usually sitting in `node_modules/@deepseek-ai/` as links into the global
 * `@deepseek-ai/dsh` tree, and then `import('../src/host/index.ts')` simply
 * works. On a runner where they are absent it does not. So the import is
 * attempted, and a machine that cannot resolve the peers SKIPS LOUDLY: the
 * skip names the missing specifier and says that nothing was verified. A
 * silent pass here would be the same class of bug as a green gate that cannot
 * fail (see the CI job's own comment about the slot-gate).
 *
 * WHAT THIS BUYS THAT THE TEXT GUARDS CANNOT
 *
 * The route wiring used to be asserted by pattern-matching the source: "does
 * the substring `path: QODER_ACCOUNT_PATH` appear, and is `accountHandler(`
 * within 6000 characters of it". Those assertions are honest about their
 * limits, but they cannot tell you that the routes MOUNT. `apply()` returns
 * normally even when it registered nothing, because activation is best-effort
 * by design — so a regression that skipped the `webServer` injection, mounted a
 * group with a duplicate path, or let `mountRouteGroup`'s all-or-nothing
 * rollback fire would leave every source-text guard green and every card route
 * 404. Here the fake `webServer` records what was actually sent to
 * `register()`, and the handlers are then CALLED through those registrations.
 *
 * The fake context is a structural minimum, not the host's type: `inject`
 * immediately invokes the callback with a stub service (which is what Cordis
 * does once the service exists), `logger` records instead of printing, and
 * `effect` records the disposer without running it.
 *
 * WHY THE ENVIRONMENT IS REWRITTEN FIRST
 *
 * `apply()` is not a pure function: it reads the user's REAL sign-in, writes
 * the plugin's own files under the Harness home, and — when it finds a
 * sign-in — starts a loopback shim per region and refreshes the model catalog
 * from Qoder's servers. A test that did that would (a) leave the runner
 * holding a bound port and a live refresh interval, so the test process would
 * never exit, and (b) touch the developer's own credentials and cache files.
 *
 * So the two roots the plugin reads are pointed at a throwaway sandbox BEFORE
 * the module is imported: `$DSH_HOME` (the plugin's own files — catalog,
 * counters, the browser sign-in) and the platform's app-data root (the
 * desktop application's sign-in). The PAT environment variables are removed
 * as well, because they are the third credential source and would otherwise
 * hand a region a live sign-in on a machine that has one. With all three
 * sources empty, activation takes the zero-region path — which is the normal
 * state of a fresh install and the exact state the card has to be able to
 * explain — and no region starts, so nothing is bound and nothing is fetched.
 *
 * The last test in this file pins that isolation: the account payload must not
 * report a readable sign-in. If a future change made the sandbox leak (a path
 * built from `homedir()` instead of the app-data root, say), that assertion
 * fails instead of the test quietly reading the developer's real credential.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// The sandbox, installed before the import below.
// ---------------------------------------------------------------------------

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-qoder-activation-'))
const sandboxHome = join(sandbox, 'dsh-home')
const sandboxAppData = join(sandbox, 'appdata')
const sandboxUserHome = join(sandbox, 'user')
for (const dir of [sandboxHome, sandboxAppData, sandboxUserHome]) mkdirSync(dir, { recursive: true })

/** Every environment name this file overrides, with its original value. */
const OVERRIDES = {
  DSH_HOME: sandboxHome,
  APPDATA: sandboxAppData,
  HOME: sandboxUserHome,
  XDG_CONFIG_HOME: join(sandbox, 'xdg'),
  USERPROFILE: sandboxUserHome,
}
/** The PAT names, which are removed rather than replaced. */
const PAT_NAMES = [
  'QODERCN_API_KEY',
  'QODERCN_PERSONAL_ACCESS_TOKEN',
  'QODERCN_PAT',
  'QODER_API_KEY',
  'QODER_PERSONAL_ACCESS_TOKEN',
  'QODER_PAT',
]

const saved = new Map()
for (const [name, value] of Object.entries(OVERRIDES)) {
  saved.set(name, process.env[name])
  process.env[name] = value
}
for (const name of PAT_NAMES) {
  saved.set(name, process.env[name])
  delete process.env[name]
}

after(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(sandbox, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// The module under test.
// ---------------------------------------------------------------------------

const imported = await import('../src/host/index.ts').then(
  (mod) => ({ mod }),
  (error) => ({ error }),
)

const SKIP =
  imported.error === undefined
    ? undefined
    : `src/host/index.ts is not importable on this machine (${
        imported.error.code ?? imported.error.constructor?.name
      }: ${String(imported.error.message ?? '').split('\n')[0]}). This plugin installs none of its @deepseek-ai/* peers; a machine with a DSH runtime usually has four of them linked into node_modules/@deepseek-ai/, and this file verifies nothing without them.`

// ---------------------------------------------------------------------------
// The fake host.
// ---------------------------------------------------------------------------

/** The recorded life of one fake activation. */
function fakeHost() {
  const routes = []
  const logs = []
  const events = []
  const effects = []
  const injected = []
  const logger = {
    warn: (message, error) => logs.push({ level: 'warn', message: String(message), error }),
    error: (message, error) => logs.push({ level: 'error', message: String(message), error }),
    info: (message, error) => logs.push({ level: 'info', message: String(message), error }),
    debug: (message, error) => logs.push({ level: 'debug', message: String(message), error }),
  }
  const webServer = {
    register: (spec) => {
      // The host's own contract: an exact path and a handler, nothing else.
      assert.equal(spec.kind, 'exact', `route ${spec.path} registered with kind ${spec.kind}`)
      assert.equal(typeof spec.handler, 'function', `route ${spec.path} registered without a handler`)
      const existing = routes.find((route) => route.path === spec.path)
      assert.equal(existing, undefined, `${spec.path} was registered twice in one activation`)
      const route = { path: spec.path, handler: spec.handler, released: false }
      routes.push(route)
      return () => {
        route.released = true
      }
    },
  }
  const ctx = {
    logger,
    inject: (names, callback) => {
      injected.push(names)
      for (const name of names) {
        if (name === 'webServer') callback({ webServer })
        if (name === 'settings') callback({ settings: { configure: () => {} } })
      }
    },
    on: (name, listener) => {
      events.push({ name, listener })
    },
    effect: (factory) => {
      assert.equal(typeof factory, 'function', 'ctx.effect was handed something that is not a factory')
      effects.push(factory)
      return () => {}
    },
    emit: (name) => events.push({ name, emitted: true }),
  }
  return { ctx, routes, logs, events, effects, injected, webServer }
}

/** A GET with a loopback Host header — the shape every card fetch has. */
function loopbackGet(url) {
  const req = new EventEmitter()
  req.method = 'GET'
  req.url = url
  req.headers = { host: '127.0.0.1:19387' }
  req.destroy = () => {
    req.destroyed = true
  }
  return req
}

function fakeRes() {
  const bodies = []
  const out = { status: null, headers: null }
  const res = {
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

/** The lines the host logged, as `level: message`. */
function logLines(host) {
  return host.logs.map((entry) => `${entry.level}: ${entry.message}`)
}

// ---------------------------------------------------------------------------
// The tests.
// ---------------------------------------------------------------------------

test('apply() mounts every card route, on a machine with no Qoder install', { skip: SKIP }, async () => {
  // The zero-region case is the point, not an accident: the sandbox has no
  // sign-in, so `started` is empty and activation takes the branch whose
  // comment insists the routes are mounted ANYWAY. If that branch ever grows a
  // `return`, this assertion fails — which is exactly the regression
  // test/account-route-wiring.test.js can only approximate by looking for the
  // absence of the word.
  const host = fakeHost()
  await imported.mod.apply(host.ctx, {})

  const mounted = host.routes.map((route) => route.path).sort()
  assert.deepEqual(
    mounted,
    [
      '/plugins/dsh-connect-qoder/__save',
      '/plugins/dsh-connect-qoder/account',
      '/plugins/dsh-connect-qoder/account/confirm',
      '/plugins/dsh-connect-qoder/account/reload',
      '/plugins/dsh-connect-qoder/checkin',
      '/plugins/dsh-connect-qoder/device-login/cancel',
      '/plugins/dsh-connect-qoder/device-login/poll',
      '/plugins/dsh-connect-qoder/device-login/signout',
      '/plugins/dsh-connect-qoder/device-login/start',
      '/plugins/dsh-connect-qoder/models',
      '/plugins/dsh-connect-qoder/status',
      '/plugins/dsh-connect-qoder/usage',
    ],
    'activation must mount all twelve card routes even with zero regions started',
  )

  // The optional services are what the mounts hang off, so their absence would
  // explain a silent zero-mount. Named separately so the failure above is
  // readable.
  assert.ok(
    host.injected.some((names) => names.includes('webServer')),
    'webServer was never injected',
  )
  assert.ok(
    host.injected.some((names) => names.includes('settings')),
    'settings was never injected',
  )
})

test('a disposed activation releases every route it mounted', { skip: SKIP }, async () => {
  const host = fakeHost()
  await imported.mod.apply(host.ctx, {})
  assert.equal(
    host.effects.length > 0,
    true,
    'activation registered no effect, so nothing would ever dispose',
  )
  for (const factory of host.effects) {
    const dispose = factory()
    assert.equal(typeof dispose, 'function', 'an effect factory did not return a disposer')
    await dispose()
  }
  assert.ok(
    host.routes.every((route) => route.released),
    `dispose left routes registered: ${host.routes
      .filter((route) => !route.released)
      .map((route) => route.path)
      .join(', ')}`,
  )
})

test('a zero-region activation names every region it refused', { skip: SKIP }, async () => {
  // Red line 1: a state the user cannot see is a bug. The card routes stay up
  // (above), and on top of that every region that did not start must say why.
  //
  // The refusal is `regionPublishDecision`'s, and its LEVEL is what makes the
  // message readable: "no local sign-in" is `info` — the fresh-install state,
  // not a problem — while an expired sign-in is `warn`. Pinned here rather
  // than in test/region-gate.test.js because this is the call that decides
  // which level the host actually logs at.
  const host = fakeHost()
  await imported.mod.apply(host.ctx, {})

  const refusals = host.logs.filter((entry) => /region not registered/.test(entry.message))
  assert.equal(
    refusals.length,
    2,
    `both editions must explain their refusal; logged: ${JSON.stringify(logLines(host))}`,
  )
  for (const refusal of refusals) {
    assert.equal(
      refusal.level,
      'info',
      `a missing sign-in is the fresh-install state and must not be logged at ${refusal.level}`,
    )
  }

  // And the aggregate line, which is what an operator reads when only one
  // edition came up.
  assert.ok(
    host.logs.some((entry) => /no Qoder region could start/.test(entry.message)),
    `a zero-region activation must say so; logged: ${JSON.stringify(logLines(host))}`,
  )
})

test('a zero-region activation logs no failure', { skip: SKIP }, async () => {
  // Nothing here failed: there is no sign-in to fail with. The distinction
  // matters because the plugin's own history is a history of failures that
  // presented as success — and because a refusal is not a failure, so a
  // refusal logged at `error` would train the reader to ignore errors.
  const host = fakeHost()
  await imported.mod.apply(host.ctx, {})
  const errors = host.logs.filter((entry) => entry.level === 'error')
  assert.deepEqual(
    errors.map((entry) => entry.message),
    [],
    `a zero-region activation logged a failure: ${JSON.stringify(logLines(host))}`,
  )
})

test('the account route answers through the mounted handler', { skip: SKIP }, async () => {
  // The end of the wire the text guards start: the registration's handler is
  // called with a real loopback GET and must produce a JSON body with one
  // record per region. No region is started here — the payload is built from
  // the account-state readers, not from the runtimes — so this also pins the
  // "a region with no runtime still answers" property the reload button
  // depends on.
  const host = fakeHost()
  await imported.mod.apply(host.ctx, {})
  const route = host.routes.find((candidate) => candidate.path === '/plugins/dsh-connect-qoder/account')
  assert.ok(route !== undefined, 'GET /account was not mounted')

  const req = loopbackGet('/plugins/dsh-connect-qoder/account')
  const { res, out, bodies } = fakeRes()
  await route.handler(req, res)

  assert.equal(out.status, 200, `GET /account answered ${out.status}`)
  assert.ok(bodies.length > 0, 'GET /account sent no body')
  const body = JSON.parse(bodies.at(-1))
  assert.ok(Array.isArray(body.regions), 'the account payload must carry a regions array')
  assert.deepEqual(
    body.regions.map((entry) => entry.region).sort(),
    ['qoder', 'qoder-cn'],
    'the panel must report both editions even when neither started',
  )
  for (const entry of body.regions) {
    // The card distinguishes "absent" from "reported as none" (see
    // account-payload.ts), so the key must be present here — activation is the
    // one caller that CAN provide a device status, and a missing key would
    // silently disable the browser sign-in block.
    assert.ok('device' in entry, `region ${entry.region} reported no device entry`)
    assert.equal(typeof entry.enabled, 'boolean', `region ${entry.region} reported no enabled flag`)
  }
})

test('the account route reports no sign-in, even on a signed-in machine', { skip: SKIP }, async () => {
  // The isolation guard. Everything above would still pass if the sandbox
  // leaked and the host read the developer's REAL Qoder sign-in — the routes
  // would mount, the panel would answer, and the only symptom would be a test
  // suite that touches a live credential and starts a real shim. So the
  // payload is asked directly: with the sandbox in place, no edition may
  // report a readable sign-in.
  const host = fakeHost()
  await imported.mod.apply(host.ctx, {})
  const route = host.routes.find((candidate) => candidate.path === '/plugins/dsh-connect-qoder/account')
  const { res, bodies } = fakeRes()
  await route.handler(loopbackGet('/plugins/dsh-connect-qoder/account'), res)
  const body = JSON.parse(bodies.at(-1))
  for (const entry of body.regions) {
    assert.notEqual(
      entry.state,
      'ok',
      `region ${entry.region} reported a readable sign-in; the sandbox leaked and the test read a real credential`,
    )
    assert.equal(
      entry.device?.state,
      'none',
      `region ${entry.region} reported a device sign-in; the sandbox leaked`,
    )
  }
})

test('the status route reports activation health', { skip: SKIP }, async () => {
  // QODER_STATUS_PATH exists so a half-alive activation can say which step
  // failed. It must answer, and answer with the started-region count.
  const host = fakeHost()
  await imported.mod.apply(host.ctx, {})
  const route = host.routes.find((candidate) => candidate.path === '/plugins/dsh-connect-qoder/status')
  assert.ok(route !== undefined, 'GET /status was not mounted')

  const { res, out, bodies } = fakeRes()
  await route.handler(loopbackGet('/plugins/dsh-connect-qoder/status'), res)
  assert.equal(out.status, 200, `GET /status answered ${out.status}`)
  const body = JSON.parse(bodies.at(-1))
  assert.equal(typeof body.startedRegions, 'number', 'the status route must report a started-region count')
  assert.equal(body.startedRegions, 0, 'the sandbox has no sign-in, so no region can have started')
})
