/**
 * Probe: does Qoder's device/PKCE login closure work — and does the token it
 * returns feed THIS plugin's existing gateway path?
 *
 * Run:
 *   node probe/qoder-device-login.mjs --dry            # no authorization needed
 *   node probe/qoder-device-login.mjs --region cn      # interactive: open, approve
 *   node probe/qoder-device-login.mjs --url-only       # print the URL, exit
 *
 * A login run measures three things in ONE approval: that the credential
 * arrives, that the token it carries drives this plugin's own gateway path (a
 * model list), and that the refresh call rotates it into one that still does
 * (`--no-refresh` skips the third).
 *
 * WHY this exists: `docs/KNOWN_GAPS.md` item 6（跨平台凭据链未实现（macOS / Linux））
 * leaves the OS-keystore half unbuilt — macOS needs Chromium's PBKDF2
 * ("peanuts", 1003 iterations, a different algorithm from Windows DPAPI) and
 * Linux needs libsecret. All of that work exists ONLY because this plugin reads
 * the desktop app's login state instead of having a sign-in of its own. Qoder
 * accepts a device/PKCE closure, so a sign-in of its own is possible — and
 * measuring it is the precondition for writing it (this repository measures
 * before it writes; see the two existing `probe/` scripts cited in
 * `docs/KNOWN_GAPS.md`).
 *
 * The protocol constants below are NOT guessed. They are read off a shipping
 * implementation of exactly this flow: `dsh-our-free-model`'s channel pack
 * (`vendor/channel-pack/pack.js`, generated from the MIT `dsh-codearts-auth`
 * sources), which carries a working Qoder device login —
 * `createQoderPkce`, `buildQoderAuthUrl`, `buildQoderPollUrl`,
 * `pollQoderDeviceToken`, `startQoderLoginFlow`, `parseQoderTokenPayload`, and
 * the product table `QODER` / `QODER_CN` (`authBase`, `openApiBase`, `clientId`).
 *
 * Two of that implementation's own notes are why this probe runs a REAL
 * closure instead of stopping at the entry point: a wrong `clientId` presents
 * as "the authorize page redirects fine, then approving reports invalid
 * parameters", and the CN and international clientIds differ (`732aef47-…` for
 * CN, `e883ade2-…` for international; the CN value comes from the CN asar's
 * `authClientIds.prod`). Neither symptom is visible to a request that stops at
 * the URL, so `--dry` can prove reachability and nothing more.
 *
 * Hygiene: this probe never writes a credential to disk and never prints one.
 * A token is reported by presence, length and a masked prefix/suffix only.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { REGIONS } from '../src/host/credentials.ts'
import { authHeaders, modelListUrl } from '../src/host/upstream.ts'

/** Poll cadence and budget, taken from the reference implementation. */
const POLL_INTERVAL_MS = 1000
const DEFAULT_TIMEOUT_MS = 300_000
const POLL_MAX_FAILURES = 5
/** Per-request budget, matching the reference implementation's 30s. */
const REQUEST_TIMEOUT_MS = 30_000

/** The PKCE verifier alphabet (RFC 7636 unreserved characters). */
const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

/** Paths on the auth / OpenAPI hosts. */
const DEVICE_SELECT_PATH = '/device/selectAccounts'
const POLL_PATH = '/api/v1/deviceToken/poll'
const REFRESH_PATH = '/api/v1/deviceToken/refresh'

/**
 * Per-region login endpoints and OAuth client ids.
 *
 * `openApiUrl` is NOT duplicated here: the plugin's own region table already
 * names that host, so reusing it means a divergence between this probe and the
 * plugin is a visible mismatch rather than two constants drifting apart.
 */
const PRODUCTS = {
  cn: {
    id: 'qoder-cn',
    authBase: 'https://qoder.cn',
    clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
    clientMetadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
  },
  global: {
    id: 'qoder',
    authBase: 'https://qoder.com',
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
    clientMetadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
  },
}

/** Command line: `--dry`, `--url-only`, `--region cn|global|both`, `--timeout <s>`. */
function parseArgs(argv) {
  const options = { dry: false, urlOnly: false, refresh: true, region: 'both', timeoutMs: DEFAULT_TIMEOUT_MS }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--dry') options.dry = true
    else if (token === '--url-only') options.urlOnly = true
    else if (token === '--no-refresh') options.refresh = false
    else if (token === '--region') options.region = argv[++i] ?? 'both'
    else if (token === '--timeout') options.timeoutMs = Number(argv[++i] ?? '') * 1000
    else throw new Error(`unknown argument: ${token}`)
  }
  if (!['cn', 'global', 'both'].includes(options.region)) {
    throw new Error(`--region must be cn|global|both, got ${options.region}`)
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout must be a positive number of seconds')
  }
  return options
}

/** RFC 7636 S256: verifier in [43,128] unreserved chars, challenge = base64url(sha256). */
function createPkce() {
  const length = 43 + Math.floor(86 * Math.random())
  const bytes = randomBytes(length)
  let verifier = ''
  for (let i = 0; i < length; i++) verifier += PKCE_ALPHABET[bytes[i] % PKCE_ALPHABET.length]
  const challenge = createHash('sha256')
    .update(verifier)
    .digest()
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return { verifier, challenge }
}

function createSession() {
  return { pkce: createPkce(), nonce: randomUUID(), machineId: randomUUID() }
}

/** `{authBase}/device/selectAccounts?…` — the page the user is sent to. */
function buildAuthUrl(session, product) {
  const query = new URLSearchParams({
    challenge: session.pkce.challenge,
    challenge_method: 'S256',
    nonce: session.nonce,
    machine_id: session.machineId,
    client_id: product.clientId,
  })
  return `${product.authBase}${DEVICE_SELECT_PATH}?${query.toString()}`
}

/** `{openApiBase}/api/v1/deviceToken/poll?…` — where the credential arrives, if it can. */
function buildPollUrl(session, region) {
  const query = new URLSearchParams({
    nonce: session.nonce,
    verifier: session.pkce.verifier,
    challenge_method: 'S256',
  })
  return `${region.openApiUrl}${POLL_PATH}?${query.toString()}`
}

/**
 * One poll request, reported raw.
 *
 * `{ ok: false }` never means "no credential yet" — 404 is the reference
 * implementation's "still waiting" case, and anything else non-OK is a refusal
 * whose body this probe must surface verbatim rather than swallow.
 */
export async function pollOnce(session, region, fetchImpl = fetch) {
  const url = buildPollUrl(session, region)
  try {
    const response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error' })
    // Read the body WHOLE. Bounding the read here once truncated a real success
    // payload mid-string, and the resulting uncaught SyntaxError printed the
    // raw body — a live device token — into the log. Bounding is a DISPLAY
    // concern; see `bodyForDisplay`.
    const text = await response.text()
    return { reachable: true, status: response.status, text }
  } catch (error) {
    return { reachable: false, error: error?.message ?? String(error) }
  }
}

/**
 * Parse a poll body without ever letting its CONTENTS reach an exception.
 *
 * `JSON.parse` syntax errors embed a snippet of their input in V8, and on a
 * success response that input is the credential — which is exactly how a live
 * device token once escaped into the log. Only the byte count and the body's
 * shape leave this function, and it is exported so a test can hold that.
 */
export function parsePollBody(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, bytes: 0, truncated: false, name: 'EmptyBody' }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, bytes: text.length, truncated: !text.trimEnd().endsWith('}'), name: error?.name ?? 'Error' }
  }
}

/** The fields the reference implementation reads, and every spelling it tolerates. */
export function parseTokenPayload(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { accessToken: '' }
  const readString = (keys) => {
    for (const key of keys) {
      const candidate = value[key]
      if (typeof candidate === 'string' && candidate.length > 0) return candidate
    }
    return undefined
  }
  return {
    accessToken: readString(['token', 'device_token', 'access_token']) ?? '',
    refreshToken: readString(['refresh_token', 'refreshToken']),
    refreshTokenId: readString(['refresh_token_id', 'refreshTokenId']),
    expiresAt: value.expires_at ?? value.expiresAt,
    refreshTokenExpiresAt: value.refresh_token_expires_at ?? value.refreshTokenExpiresAt,
    uid: readString(['user_id', 'userId']),
    userName: readString(['user_name', 'userName']),
    fieldsPresent: Object.keys(value).sort().join(', '),
  }
}

/**
 * A credential is this plugin's `QoderCredential` shape, and its `token` is
 * consumed as `security_oauth_token` by `authHeaders` — the same field name the
 * device login produces, which is why this closure needs no upstream change.
 */
export function credentialOf(payload, machineId) {
  return {
    userID: payload.uid ?? '',
    token: payload.accessToken,
    name: payload.userName,
    machineID: machineId,
  }
}

/**
 * Overlay a refresh response on the credential it rotated — the reference
 * implementation's `applyQoderRefresh`, and not a stylistic choice.
 *
 * Measured: a refresh response carries new token material and little else. A
 * credential rebuilt from it alone loses `uid`, which `authHeaders` encrypts into
 * the signed info block (`src/host/upstream/cosy-sign.ts:31`, was
 * `src/host/upstream.ts:279` before the split — `docs/issues/22`) — so both regions answered
 * `{"code":"101","message":"Signature invalid"}` until the overlay was added.
 */
export function mergeRotation(original, rotated) {
  const merged = { ...original }
  for (const [key, value] of Object.entries(rotated)) {
    if (value !== undefined && value !== '') merged[key] = value
  }
  return merged
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Report a secret without disclosing it. */
export function mask(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return 'absent'
  if (secret.length <= 12) return `present (${secret.length} chars, too short to mask)`
  return `present (${secret.length} chars, ${secret.slice(0, 4)}…${secret.slice(-4)})`
}

function indent(text, pad = '    ') {
  return String(text).split('\n').map((line) => pad + line).join('\n')
}

/**
 * Bound a response body for DISPLAY only, never for parsing.
 *
 * A deviceToken poll body is credential material the moment it succeeds, so it
 * is echoed only through here — never by an exception, and never by a parse
 * failure. Keeping the limit at the print site is what makes that possible.
 */
export function bodyForDisplay(text, limit = 400) {
  if (typeof text !== 'string' || text.length === 0) return '<empty>'
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}… [${text.length} bytes total]`
}

/** Phase 1: prove the poll endpoint answers at all, without authorizing anything. */
async function dryRegion(key) {
  const product = PRODUCTS[key]
  const region = REGIONS.find((candidate) => candidate.id === product.id)
  if (region === undefined) throw new Error(`no region named ${product.id} in REGIONS`)
  const session = createSession()
  console.log(`[${key}] ${region.displayName}`)
  console.log(`  auth URL  : ${buildAuthUrl(session, product)}`)
  console.log(`  poll URL  : ${buildPollUrl(session, region)}`)
  console.log(`  client_id : ${product.clientId}`)
  const result = await pollOnce(session, region)
  if (!result.reachable) {
    console.log(`  poll      : UNREACHABLE — ${result.error}`)
    return false
  }
  // A 404 here is the expected, healthy answer: the nonce does not exist yet.
  const verdict = result.status === 404 ? 'expected (unknown nonce)' : 'UNEXPECTED — investigate'
  console.log(`  poll      : HTTP ${result.status} — ${verdict}`)
  console.log(`  body      :\n${indent(bodyForDisplay(result.text))}`)
  return result.status === 404
}

/** Phase 2: wait for a real approval, then prove the token works on the plugin's own path. */
async function loginRegion(key, options) {
  const product = PRODUCTS[key]
  const region = REGIONS.find((candidate) => candidate.id === product.id)
  if (region === undefined) throw new Error(`no region named ${product.id} in REGIONS`)
  const session = createSession()
  const authUrl = buildAuthUrl(session, product)
  console.log(`[${key}] ${region.displayName}`)
  console.log(`  Open this URL and approve the sign-in:\n\n${indent(authUrl, '      ')}\n`)
  if (options.urlOnly) return null

  const deadline = Date.now() + options.timeoutMs
  let failures = 0
  let payload
  while (Date.now() < deadline) {
    const result = await pollOnce(session, region)
    if (!result.reachable) {
      failures += 1
      console.log(`  poll      : error ${failures}/${POLL_MAX_FAILURES} — ${result.error}`)
      if (failures >= POLL_MAX_FAILURES) break
      await sleep(POLL_INTERVAL_MS)
      continue
    }
    failures = 0
    if (result.status === 404) {
      await sleep(POLL_INTERVAL_MS)
      continue
    }
    if (result.status < 200 || result.status >= 300) {
      // Red line 1: a refusal is reported, never reinterpreted as "not signed in".
      console.log(`  poll      : HTTP ${result.status} — REFUSED. Body verbatim:`)
      console.log(indent(bodyForDisplay(result.text)))
      if (result.status === 401 || result.status === 403) {
        console.log(`  verdict   : this is the wrong-clientId symptom — check ${product.clientId}`)
      }
      return false
    }
    const read = parsePollBody(result.text)
    if (!read.ok) {
      // Only the byte count and the shape are printed; see `parsePollBody`.
      console.log(`  poll      : HTTP ${result.status}, ${read.bytes} bytes, body is not JSON (${read.name})`)
      console.log(`  shape     : ${read.truncated ? 'does NOT end with a closing brace — the body looks TRUNCATED' : 'ends with a closing brace'}`)
      console.log('  body      : withheld — a deviceToken body is credential material once it parses')
      return false
    }
    const parsed = parseTokenPayload(read.value)
    if (parsed.accessToken.length > 0) {
      payload = parsed
      break
    }
    await sleep(POLL_INTERVAL_MS)
  }

  if (payload === undefined) {
    console.log(`  poll      : no credential within ${options.timeoutMs / 1000}s (the URL may have expired)`)
    return false
  }

  console.log('  credential received:')
  console.log(`    access_token   : ${mask(payload.accessToken)}`)
  console.log(`    refresh_token  : ${mask(payload.refreshToken)}`)
  if (payload.refreshToken === undefined && payload.refreshTokenId !== undefined) {
    // Defensive, not descriptive: qoder.cn answers BOTH a `drt-` refresh token
    // and a refresh_token_id, so this branch does not fire there. It exists
    // because an empty refresh token reads like a failed login, and because the
    // refresh CALL itself is still unexercised — a region that stopped issuing a
    // refresh token would need that path first.
    console.log('    note           : no refresh_token, but a refresh_token_id was issued — refresh needs its own call')
  }
  const expiry =
    payload.expiresAt === undefined ? 'absent' : `${String(payload.expiresAt)} (${typeof payload.expiresAt})`
  console.log(`    expires_at     : ${expiry}`)
  console.log(`    refresh expiry : ${payload.refreshTokenExpiresAt ?? 'absent'}`)
  console.log(`    uid            : ${payload.uid ?? 'absent'}`)
  console.log(`    user_name      : ${payload.userName ?? 'absent'}`)
  console.log(`    machine_id     : ${session.machineId}`)
  console.log(`    fields present : ${payload.fieldsPresent}`)
  console.log(`    refresh path   : ${region.openApiUrl}${REFRESH_PATH} (not exercised here)`)

  // The closure that matters: feed it to the plugin's OWN header builder and
  // model list. If this returns a catalog, the login half is additive and the
  // entire upstream layer stays untouched.
  const credential = credentialOf(payload, session.machineId)
  if (!(await probeModelList(region, credential))) {
    console.log('  verdict   : token obtained but the gateway refused it')
    return false
  }
  console.log('  verdict   : CLOSURE WORKS — the device token drives the plugin\'s existing gateway path')

  if (!options.refresh) return true
  return refreshStep(region, session, payload)
}

/**
 * The closure that matters, in one place.
 *
 * `authHeaders` is the builder the chat path itself uses, so a 200 here means a
 * credential drives the existing gateway with no upstream change — the whole
 * question this probe exists to answer. Shared by the login and the refresh
 * steps so the two cannot drift into testing different things.
 */
export async function probeModelList(region, credential, fetchImpl = fetch) {
  const url = modelListUrl(region)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...authHeaders(Buffer.alloc(0), url, credential) },
      redirect: 'error',
    })
    const text = await response.text()
    let chat = 'n/a'
    try {
      const parsed = JSON.parse(text)
      chat = Array.isArray(parsed?.chat) ? `${parsed.chat.length} chat models` : typeof parsed?.chat
    } catch {
      chat = 'not-json'
    }
    console.log(`  model list: HTTP ${response.status}, chat=${chat}`)
    if (response.ok && response.status === 200) return true
    console.log(`  body      :\n${indent(bodyForDisplay(text))}`)
    return false
  } catch (error) {
    console.log(`  model list: ERROR ${error?.message ?? String(error)}`)
    return false
  }
}

/**
 * Phase 3: rotate the credential.
 *
 * A login whose credentials nothing can renew is only half a source, so the
 * refresh call is measured rather than assumed. The reference implementation
 * POSTs the refresh token and the machine id and parses the answer with the same
 * tolerant parser; nothing here persists a credential, so rotating one costs
 * nothing.
 */
export async function refreshStep(region, session, payload, fetchImpl = fetch) {
  const url = `${region.openApiUrl}${REFRESH_PATH}`
  console.log(`  refresh   : POST ${url}`)
  if (payload.refreshToken === undefined) {
    console.log('  verdict   : the login issued no refresh token, so there is nothing to rotate')
    return false
  }
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refresh_token: payload.refreshToken, machine_id: session.machineId }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    console.log(`  refresh   : NETWORK ERROR ${error?.message ?? String(error)}`)
    return false
  }
  const text = await response.text()
  if (response.status === 401 || response.status === 403) {
    // The one refusal that means something specific: the refresh token itself
    // was rejected, which is "sign in again" rather than "the call failed".
    console.log(`  refresh   : HTTP ${response.status} — the refresh token was REFUSED (re-login required)`)
    return false
  }
  const read = parsePollBody(text)
  if (!read.ok) {
    console.log(`  refresh   : HTTP ${response.status}, ${read.bytes} bytes, not JSON (${read.name})`)
    console.log(`  shape     : ${read.truncated ? 'does NOT end with a closing brace — looks TRUNCATED' : 'ends with a closing brace'}`)
    console.log('  body      : withheld — a refresh body is credential material once it parses')
    return false
  }
  if (!response.ok) {
    console.log(`  refresh   : HTTP ${response.status} — REFUSED. Body verbatim:`)
    console.log(indent(bodyForDisplay(text)))
    return false
  }
  const rotated = parseTokenPayload(read.value)
  const rotatedExpiry =
    rotated.expiresAt === undefined ? 'absent' : `${String(rotated.expiresAt)} (${typeof rotated.expiresAt})`
  console.log(`    access_token   : ${mask(rotated.accessToken)}`)
  console.log(`    refresh_token  : ${mask(rotated.refreshToken)}`)
  console.log(`    expires_at     : ${rotatedExpiry}`)
  console.log(`    fields present : ${rotated.fieldsPresent}`)
  if (rotated.uid === undefined) {
    // The measured reason the overlay is not optional.
    console.log('    uid            : ABSENT — kept from the credential that was rotated')
  }
  const rotatedCredential = credentialOf(mergeRotation(payload, rotated), session.machineId)
  if (!(await probeModelList(region, rotatedCredential, fetchImpl))) {
    console.log('  verdict   : the rotated credential was refused by the gateway')
    return false
  }
  console.log('  verdict   : REFRESH WORKS — the rotated credential drives the same path')
  return true
}

/**
 * Run only when executed directly.
 *
 * `test/probe-device-login.test.js` imports this file to exercise the token
 * shape and the poll read, and importing it must not open a sign-in flow, read
 * argv, or set an exit code.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const keys = options.region === 'both' ? ['cn', 'global'] : [options.region]
  let allPassed = true
  for (const key of keys) {
    const passed = options.dry ? await dryRegion(key) : await loginRegion(key, options)
    if (passed === false) allPassed = false
    console.log('')
  }
  // `process.exitCode`, never `process.exit()`: the latter tears the process down
  // while fetch's sockets are still open, which on Windows trips a libuv fail-fast
  // (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, exit 0xC0000409) and
  // destroys the exit code a hand-run check reads. Setting the code lets the loop
  // drain first.
  process.exitCode = allPassed ? 0 : 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
