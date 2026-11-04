/**
 * Which credential path is serving a region — the host's own answer.
 *
 * Run: node --test test/credential-kind.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * There are two sign-ins a user can have: the desktop Qoder application's own,
 * and the one this plugin obtained itself through a browser sign-in. The card
 * used to work out which one was in use by reading the account payload's
 * `state` and `source` fields — a GUESS, made from what the panel could see
 * rather than from what the runtime resolved. On a machine where the desktop
 * store exists but its token has lapsed, the panel said "signed in to the
 * desktop app" while the plugin's own token was the one actually serving
 * requests, and the two answers disagree about the same region.
 *
 * The host CAN tell: it resolved the credential. So it says so, and this file
 * pins that answer at the three places it travels — the cache that resolved it,
 * the account payload the card reads, and the status route a user is sent to
 * when something is not working.
 *
 * The fallback matters as much as the answer: a host that names no kind (an
 * older build) must not make the card say "unknown" — the card keeps its own
 * inference, and the host's answer, when there is one, wins.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { credentialKindOf } from '../src/host/credential-kind.ts'
import { CredentialCache } from '../src/host/credential-cache.ts'
import { buildAccountPayload } from '../src/host/account-payload.ts'
import { statusHandler } from '../src/host/handlers.ts'
import { EventEmitter } from 'node:events'

/** A credential as the cache sees it; only the fields the rules read matter. */
const credential = (source) => ({
  source,
  token: 'token',
  expired: false,
  userID: 'u',
  expiresAt: Date.now() + 60_000,
})

test('the three credential paths are named the way a user would describe them', () => {
  assert.equal(credentialKindOf(credential('app')), 'desktop')
  assert.equal(credentialKindOf(credential('device')), 'device')
  assert.equal(credentialKindOf(credential('env-pat')), 'env')
})

test('no credential means no kind — not "desktop" and not "env"', () => {
  assert.equal(credentialKindOf(undefined), undefined)
})

test('the cache names the path it is serving, and names none before it resolved', async () => {
  const cache = new CredentialCache({
    loadApp: () => credential('app'),
    loadEnv: () => undefined,
  })
  assert.equal(cache.kind, undefined, 'nothing resolved yet is not a credential path')
  await cache.resolve()
  assert.equal(cache.kind, 'desktop')
})

test('the cache names the plugin\'s own sign-in when the desktop store has nothing usable', async () => {
  const cache = new CredentialCache({
    loadApp: () => credential('app'),
    loadEnv: () => undefined,
    loadDevice: () => credential('device'),
  })
  // The desktop credential has lapsed, so it cannot serve; the plugin's own
  // credential is what the runtime reaches for. That is the case the card used
  // to get wrong.
  const lapsed = { ...credential('app'), expired: true }
  cache.loadApp = () => lapsed
  await cache.resolve()
  assert.equal(cache.kind, 'device')
})

test('the cache names the PAT when the environment is the only source left', async () => {
  const cache = new CredentialCache({
    loadApp: () => undefined,
    loadEnv: () => credential('env-pat'),
    exchangePat: async () => ({ token: 'job', refreshToken: 'r', expiresAt: Date.now() + 60_000 }),
  })
  await cache.resolve()
  assert.equal(cache.kind, 'env')
})

test('the account payload carries the kind when the host knows it', async () => {
  const payload = await buildAccountPayload({
    regions: [{ id: 'qoder-cn', appNames: [], newAppNames: [], patEnvNames: [] }],
    settings: {},
    appDataRoot: '/nonexistent',
    readAccountState: async (region) => ({ region: region.id, state: 'signed-out' }),
    credentialKind: () => 'device',
  })
  assert.equal(payload.regions[0].credentialKind, 'device')
})

test('the account payload omits the kind it does not know', async () => {
  const payload = await buildAccountPayload({
    regions: [{ id: 'qoder-cn', appNames: [], newAppNames: [], patEnvNames: [] }],
    settings: {},
    appDataRoot: '/nonexistent',
    readAccountState: async (region) => ({ region: region.id, state: 'signed-out' }),
  })
  assert.equal('credentialKind' in payload.regions[0], false, 'an unknown kind is absent, not undefined-valued')
})

test('a host that knows the kind of one region and not the other says so per region', async () => {
  const payload = await buildAccountPayload({
    regions: [
      { id: 'qoder-cn', appNames: [], newAppNames: [], patEnvNames: [] },
      { id: 'qoder', appNames: [], newAppNames: [], patEnvNames: [] },
    ],
    settings: {},
    appDataRoot: '/nonexistent',
    readAccountState: async (region) => ({ region: region.id, state: 'signed-out' }),
    credentialKind: (regionId) => (regionId === 'qoder-cn' ? 'desktop' : undefined),
  })
  assert.equal(payload.regions[0].credentialKind, 'desktop')
  assert.equal('credentialKind' in payload.regions[1], false)
})

/** A request/response pair the status handler can answer. */
function fakeExchange() {
  const req = new EventEmitter()
  req.method = 'GET'
  req.url = '/'
  req.headers = { host: '127.0.0.1:19387' }
  const bodies = []
  const res = {
    req,
    writeHead: () => {},
    end: (payload) => {
      if (payload !== undefined) bodies.push(payload)
    },
  }
  return { req, res, bodies }
}

test('the status route names the credential path of every region', async () => {
  const { req, res, bodies } = fakeExchange()
  await statusHandler(req, res, {
    startedCount: 1,
    regions: [
      { id: 'qoder-cn', credentialKind: 'desktop' },
      { id: 'qoder' },
    ],
  })
  const json = JSON.parse(bodies.at(-1))
  assert.deepEqual(json.regions, [
    { id: 'qoder-cn', credentialKind: 'desktop' },
    { id: 'qoder' },
  ])
})

test('the status route keeps its old shape when no region is reported', async () => {
  const { req, res, bodies } = fakeExchange()
  await statusHandler(req, res, { startedCount: 2 })
  const json = JSON.parse(bodies.at(-1))
  assert.equal('regions' in json, false, 'a host that reports no regions answers the shape it always did')
  assert.deepEqual(Object.keys(json).sort(), ['activated', 'providerRegistration', 'startedRegions'])
})
