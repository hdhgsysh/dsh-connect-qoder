/**
 * Qoder's device login: authorize URL, poll, refresh — a pure protocol layer.
 *
 * The protocol is reverse-engineered from a shipping client: every constant,
 * URL shape and error rule is copied from `probe/qoder-device-login.mjs`.
 *
 * The loop, the persistence and the request budget belong to the caller.
 * Background: docs/issues/21-device-login-credential-source.md
 *
 * @module dsh-connect-qoder/device-login
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'

/** The PKCE verifier alphabet: RFC 7636's unreserved characters. */
export const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

/** The shortest verifier RFC 7636 allows; the measured length formula starts here. */
const PKCE_MIN_LENGTH = 43

/** How many further characters the measured formula may add (43..128). */
const PKCE_LENGTH_SPAN = 86

/** Paths on the auth host, the region's OpenAPI host, and again on OpenAPI. */
export const DEVICE_SELECT_PATH = '/device/selectAccounts'
export const POLL_PATH = '/api/v1/deviceToken/poll'
export const REFRESH_PATH = '/api/v1/deviceToken/refresh'

/**
 * The per-request budget, matching the reference implementation's 30 s.
 *
 * It is a signal, not a wrapper: `AbortSignal.timeout` aborts the fetch itself,
 * so a socket that never answers cannot hold the caller's loop forever. The
 * resulting rejection is reported as `{ kind: 'failed', name: 'TimeoutError' }`
 * — an outcome the caller can tell the user about, never a rejection out of
 * this module.
 */
export const REQUEST_TIMEOUT_MS = 30_000

/**
 * The access token, the token that renews it, and the account behind both.
 *
 * Epoch MILLISECONDS throughout, even though the platform mints epoch seconds
 * and, on at least one envelope, an ISO-8601 string; the conversion happens once
 * in {@link parseDeviceTokenPayload} so no caller has to remember which unit it
 * is holding. The two expiry fields stay apart because they answer different
 * questions: the access token expiring means "refresh", the refresh token
 * expiring means "sign in again".
 */
export interface DeviceTokenPayload {
  /** The access token sent upstream. Never logged, never rendered. */
  token: string
  /** The token that buys a new access token. Never logged, never rendered. */
  refreshToken: string
  /** Epoch ms the access token stops being usable; `0` when the body said nothing. */
  expiresAt: number
  /** Epoch ms the refresh token stops being usable; then a sign-in is required. */
  refreshTokenExpiresAt: number
  /** The account's uid, which the upstream signature carries (see mergeRotation). */
  userID: string
  /** Display name, when the platform published one. */
  name: string
  /** Display email, when the platform published one. */
  email: string
}

/** One region's login endpoints, OAuth client id and client metadata. */
export interface QoderProduct {
  /** `qoder-cn` or `qoder` — the plugin's own region ids (see `credentials.ts`). */
  region: string
  /** Where the authorize page lives. */
  authBase: string
  /** Where the poll and refresh endpoints live — a DIFFERENT host, per region. */
  openApiBase: string
  /** The OAuth client this region accepts. The two are not interchangeable. */
  clientId: string
  /** The client metadata every login attempt declares. */
  clientMetadata: { client_type: string; business_product: string; business_type: string; scene: string }
}

/**
 * The two products, keyed by region id.
 *
 * Both values are measured, not read off a specification: each clientId
 * completed a real authorization against its own host. They are also NOT
 * interchangeable — a clientId presented to the other region's authorize page
 * redirects and renders fine, and only fails after the user approves, which is
 * why the two ids are pinned by a test rather than merely declared here.
 *
 * `openApiBase` duplicates the host `credentials.ts` already names for each
 * region on purpose: this module imports nothing (see the header), so it cannot
 * read that table, and a test asserts the two agree rather than trusting two
 * constants to drift together.
 */
export const DEVICE_PRODUCTS: Record<string, QoderProduct> = {
  'qoder-cn': {
    region: 'qoder-cn',
    authBase: 'https://qoder.cn',
    openApiBase: 'https://openapi.qoder.com.cn',
    clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
    clientMetadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
  },
  qoder: {
    region: 'qoder',
    authBase: 'https://qoder.com',
    openApiBase: 'https://openapi.qoder.sh',
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
    clientMetadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
  },
}

/**
 * The product for a region id, or `undefined` for anything else.
 *
 * `Object.hasOwn` rather than a bare index: a plain lookup answers
 * `productForRegion('toString')` with a function inherited from
 * `Object.prototype` — an object that looks product-shaped, whose `authBase` and
 * `clientId` are `undefined`, and which would send the user to
 * `undefined/device/selectAccounts`. A wrong answer that looks like a right one
 * is worse than no answer.
 */
export function productForRegion(regionId: string): QoderProduct | undefined {
  return Object.hasOwn(DEVICE_PRODUCTS, regionId) ? DEVICE_PRODUCTS[regionId] : undefined
}

export interface PkceChallenge {
  /** The secret half; it stays in this process and goes only into the poll URL. */
  verifier: string
  /** The public half, derived from the verifier; it goes into the authorize URL. */
  challenge: string
}

/**
 * A fresh PKCE pair (RFC 7636 S256).
 *
 * The LENGTH is drawn from `rand`, because that is the measured formula
 * (`43 + floor(86 * rand())`, i.e. 43..128) and the reference implementation
 * picks it the same way. The CHARACTERS never are: a verifier drawn from
 * `Math.random` is not a secret, and this verifier is the only thing standing
 * between a guessable poll URL and somebody else's credential. The bytes come
 * from `node:crypto` and are mapped onto the unreserved alphabet — the same
 * construction the probe has been running against both live regions.
 *
 * @param rand - the random source for the LENGTH only; injectable for tests.
 */
export function createPkce(rand: () => number = Math.random): PkceChallenge {
  const length = PKCE_MIN_LENGTH + Math.floor(PKCE_LENGTH_SPAN * rand())
  const bytes = randomBytes(length)
  let verifier = ''
  for (const byte of bytes) verifier += PKCE_ALPHABET.charAt(byte % PKCE_ALPHABET.length)
  // base64url(sha256(verifier)). Spelled out rather than `toString('base64url')`
  // so it can be read line by line against the probe, which is the instrument
  // the live regions accepted.
  const challenge = createHash('sha256')
    .update(verifier)
    .digest()
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return { verifier, challenge }
}

/** One login attempt: the region, the PKCE pair, the nonce and the machine id. */
export interface DeviceSession {
  /** The region this attempt is for; every URL built from it stays inside it. */
  region: string
  /** The verifier half of the PKCE pair (poll URL only). */
  verifier: string
  /** The challenge half of the PKCE pair (authorize URL only). */
  challenge: string
  /** The attempt's nonce; it ties the poll call to the authorize page. */
  nonce: string
  /** The machine identity the credential is issued against. */
  machineID: string
}

/**
 * A fresh login attempt for one region.
 *
 * @param machineID - the machine identity the credential is issued against.
 *   Defaults to a fresh UUID. The caller must remember it: the poll envelope
 *   carries no machine id at all, so this value — not the payload — is what
 *   {@link refreshOnce} has to send back later.
 * @throws when the region has no product. A session for a region nothing can
 *   build a URL for is not a session, and handing one back would defer the
 *   mistake to a request that cannot be made. The caller resolves the product
 *   with {@link productForRegion} first and reports the unknown region to the
 *   user; this is the load-bearing second half of that check, not a substitute
 *   for it.
 */
export function createDeviceSession(regionId: string, machineID?: string): DeviceSession {
  const product = productForRegion(regionId)
  if (product === undefined) throw new Error(`dsh-connect-qoder: no device-login product for region ${regionId}`)
  const pkce = createPkce()
  return {
    region: product.region,
    verifier: pkce.verifier,
    challenge: pkce.challenge,
    nonce: randomUUID(),
    machineID: machineID ?? randomUUID(),
  }
}

/**
 * `{authBase}/device/selectAccounts?…` — the page the user is sent to.
 *
 * Every parameter goes through `URLSearchParams` rather than a template string:
 * the challenge is derived material and the nonce is caller-supplied, and one
 * unescaped `&` would silently truncate the query into a request for a
 * different login.
 */
export function buildAuthUrl(product: QoderProduct, session: DeviceSession): string {
  const query = new URLSearchParams({
    challenge: session.challenge,
    challenge_method: 'S256',
    nonce: session.nonce,
    machine_id: session.machineID,
    client_id: product.clientId,
  })
  return `${product.authBase}${DEVICE_SELECT_PATH}?${query.toString()}`
}

/**
 * `{openApiBase}/api/v1/deviceToken/poll?…` — where the credential arrives, if
 * it can.
 *
 * Note the host: `openApiBase`, NOT `authBase`. The two differ in both regions
 * (`qoder.cn` vs `openapi.qoder.com.cn`), so a poll built against the auth host
 * is a live failure mode rather than a theoretical one, and a test asserts each
 * region polls its own host.
 *
 * The verifier goes out in the clear, which is what PKCE prescribes: it is
 * bound to the challenge the user approved, and it is the only proof that this
 * caller is the one that started the attempt. It must still never be logged —
 * whoever holds it can claim the pending credential.
 */
export function buildPollUrl(product: QoderProduct, session: DeviceSession): string {
  const query = new URLSearchParams({
    nonce: session.nonce,
    verifier: session.verifier,
    challenge_method: 'S256',
  })
  return `${product.openApiBase}${POLL_PATH}?${query.toString()}`
}

/** The first key that holds a non-empty string, or `''`. */
function readString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return ''
}

/**
 * A timestamp as epoch ms, or `undefined` when the value carries none.
 *
 * Three forms arrive in practice and all three are accepted: epoch ms (the
 * vault's own shape), epoch seconds (what the platform mints — read as
 * milliseconds, `1750000000` is 1970), and an ISO-8601 string (qoder.cn answered
 * one, and the desktop app's `auth.v1.dat` stores one). The alternative to
 * accepting all three is a perfectly good credential whose `expiresAt` reads as
 * `0` — i.e. permanently expired — because the envelope picked a unit this
 * parser did not know.
 *
 * The 1e12 threshold is the discriminator: no second-based timestamp in this
 * system's lifetime reaches it, and no millisecond one is below it.
 */
function asEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** The first key that holds a readable timestamp, or `0`. */
function readEpochMs(record: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const converted = asEpochMs(record[key])
    if (converted !== undefined) return converted
  }
  return 0
}

/**
 * Read one response envelope into a payload, or `undefined` when it carries no
 * access token at all.
 *
 * Two envelopes arrive here and they are NOT the same shape: the poll response
 * calls the access token `token` and carries `user_id`, while the refresh
 * response calls it `device_token`, carries six fields and no uid. Every field
 * is therefore a spelling LIST, and a field that is absent becomes `''`/`0`
 * rather than `undefined` — a caller that signs a request with these must never
 * send the literal string "undefined" (`docs/history` records that exact
 * incident).
 *
 * `undefined` means "no credential here", which for a poll is the ordinary
 * "not approved yet" state; a caller must not confuse it with a body it could
 * not read (see the outcome types below).
 *
 * Never throws, on any input, including the hostile ones: it is fed a network
 * body, and a body may be a Proxy with a throwing accessor as easily as it may
 * be a string.
 */
export function parseDeviceTokenPayload(value: unknown): DeviceTokenPayload | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    const token = readString(record, ['token', 'device_token', 'access_token'])
    if (token === '') return undefined
    return {
      token,
      refreshToken: readString(record, ['refresh_token', 'refreshToken']),
      expiresAt: readEpochMs(record, ['expires_at', 'expiresAt']),
      refreshTokenExpiresAt: readEpochMs(record, ['refresh_token_expires_at', 'refreshTokenExpiresAt']),
      userID: readString(record, ['user_id', 'userId']),
      name: readString(record, ['user_name', 'userName']),
      email: readString(record, ['email', 'user_email']),
    }
  } catch {
    return undefined
  }
}

/** A string field of the rotation, or the original when the rotation has none. */
function keepText(original: string, rotated: string): string {
  return rotated === '' ? original : rotated
}

/**
 * A timestamp of the rotation, or the original when the rotation has none.
 *
 * `> 0`, not `!== ''`: `parseDeviceTokenPayload` answers `0` for a field the
 * response omitted, and a rule that only skips empty strings would overwrite a
 * live expiry with `0` — turning a perfectly good credential into one that
 * reads as expired. Same loss as the uid trap below, arriving from the other
 * side.
 */
function keepStamp(original: number, rotated: number): number {
  return rotated > 0 ? rotated : original
}

/**
 * Overlay a rotation onto the credential it rotated — never replace it.
 *
 * This is not a stylistic choice, it is the whole point of `refreshOnce`, and it
 * is measured on both regions. A refresh response carries six fields
 * (`created_at`, `device_token`, `expires_at`, `refresh_token`,
 * `refresh_token_expires_at`, `token_type`), renames the access token to
 * `device_token`, and does NOT carry `user_id`. The credential's uid is
 * encrypted into the request signature (`authHeaders` in `upstream.ts`), so a
 * credential rebuilt from the response alone signs an empty uid and the gateway
 * answers `403 {"code":"101","message":"Signature invalid"}` — exactly what the
 * probe measured before `121805c` taught it to merge, and what would reproduce
 * verbatim the moment this gets wired into the host.
 *
 * The fields are listed one by one rather than looped over with a key cast: a
 * loop would let a field added to the payload later be silently dropped from the
 * merge (or silently carried over), and this is the one function in the file
 * where being explicit is the point.
 */
export function mergeRotation(original: DeviceTokenPayload, rotated: DeviceTokenPayload): DeviceTokenPayload {
  return {
    token: keepText(original.token, rotated.token),
    refreshToken: keepText(original.refreshToken, rotated.refreshToken),
    expiresAt: keepStamp(original.expiresAt, rotated.expiresAt),
    refreshTokenExpiresAt: keepStamp(original.refreshTokenExpiresAt, rotated.refreshTokenExpiresAt),
    userID: keepText(original.userID, rotated.userID),
    name: keepText(original.name, rotated.name),
    email: keepText(original.email, rotated.email),
  }
}

/** What one poll request produced. */
export type PollOutcome =
  /** Not approved yet — 404, or 200 with an envelope carrying no token. */
  | { kind: 'pending' }
  /** A credential arrived. */
  | { kind: 'authorized'; payload: DeviceTokenPayload }
  /** Something is actually wrong; `name` is a stable, greppable literal. */
  | { kind: 'failed'; name: string }

/** What one refresh request produced. */
export type RefreshOutcome =
  /** A new credential, overlaid on the one that was rotated. */
  | { kind: 'refreshed'; payload: DeviceTokenPayload }
  /** The refresh token is gone (401/403, or absent): the user must sign in. */
  | { kind: 'expired' }
  /** A transport, protocol or gateway failure. */
  | { kind: 'failed'; name: string }

/** A JSON body, parsed — with the two ways it can be unusable kept apart. */
type BodyRead = { ok: true; value: unknown } | { ok: false; name: 'EmptyBody' | 'UnparseableBody' }

/**
 * Parse a response body, contributing nothing but its shape.
 *
 * The two failures are named literals and the exception is not forwarded: V8
 * embeds a slice of its input in a `JSON.parse` syntax error, so rethrowing or
 * quoting one would print part of a live device token — which is how the probe
 * destroyed its own first successful run (`43edbd7`). The byte count is
 * deliberately not reported either; the caller has the status, and the probe is
 * the instrument that prints shapes.
 */
function readJsonBody(text: string): BodyRead {
  if (text.trim() === '') return { ok: false, name: 'EmptyBody' }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, name: 'UnparseableBody' }
  }
}

/**
 * A stable name for a thrown failure.
 *
 * An aborted request arrives as `TimeoutError` and a dead socket as `TypeError`;
 * both names are more use to the caller than a generic word. Only the NAME
 * travels: an error's message can quote the request URL, and the poll URL
 * carries the verifier.
 */
function errorName(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = (error as { name?: unknown }).name
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return 'UnknownError'
}

/**
 * One poll request.
 *
 * The outcome vocabulary is the measured one, and each branch is a decision:
 *
 * - **404 is `pending`, not an error.** It is "this nonce has not been approved
 *   yet" — the healthy answer every second until the user clicks. Reporting it
 *   as a failure is what would turn an ordinary sign-in into "登录流程坏了".
 * - **A 2xx whose envelope carries no token is `pending` too**, including an
 *   empty body: the service answers before authorisation lands, and the 300 s
 *   budget the caller owns is the backstop for a body that never gains a token.
 * - **Any other non-2xx is `failed` with the status in the name** (`Http500`).
 *   A refused clientId or a broken gateway must reach the user as a failure
 *   (red line 1: no silent failure branches), never as "you have not signed in".
 * - **A non-empty body that will not parse is `failed`, not `pending`.** `{}` is
 *   an envelope with no token yet; `"<html>"` is the protocol having changed,
 *   and retrying it for the full budget would report the user's approval as the
 *   problem. The probe — the measuring instrument — stops hard on the same
 *   distinction.
 * - **Nothing rejects.** The caller is a host loop that has to be able to say
 *   something to the user even when the network is gone, so a throw is an
 *   outcome here like any other.
 *
 * @param fetchImpl - injectable so tests (and a future probe) never touch the
 *   network; defaults to the global `fetch`.
 */
export async function pollOnce(
  product: QoderProduct,
  session: DeviceSession,
  fetchImpl: typeof fetch = fetch,
): Promise<PollOutcome> {
  try {
    const response = await fetchImpl(buildPollUrl(product, session), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === 404) return { kind: 'pending' }
    if (response.status < 200 || response.status >= 300) return { kind: 'failed', name: `Http${response.status}` }
    const read = readJsonBody(await response.text())
    if (!read.ok) return read.name === 'EmptyBody' ? { kind: 'pending' } : { kind: 'failed', name: read.name }
    const payload = parseDeviceTokenPayload(read.value)
    return payload === undefined ? { kind: 'pending' } : { kind: 'authorized', payload }
  } catch (error) {
    return { kind: 'failed', name: errorName(error) }
  }
}

/**
 * One refresh request.
 *
 * @param machineID - the machine identity to sign the request with. It is a
 *   parameter rather than a field of `current` because the payload has none: the
 *   poll envelope never publishes a machine id, so the only source of it is the
 *   session that produced the credential. Pass that session's `machineID`; a
 *   different value signs a request the platform did not issue.
 *
 * The refusals mean different things and are kept apart:
 *
 * - **401/403 is `expired`**, not a failure. It is the one refusal with a
 *   specific user action attached — the refresh token is gone, sign in again —
 *   and a caller that cannot tell it from a 500 will keep retrying a credential
 *   that can never work.
 * - **Any other non-2xx is `failed`** with the status in the name, and a
 *   transport throw or an unreadable body is `failed` with the error's name or a
 *   stable literal. Neither rejects.
 * - **Success is `{ merged }`**, never the parsed response — see
 *   {@link mergeRotation} for why that distinction cost a 403 on both regions.
 */
export async function refreshOnce(
  product: QoderProduct,
  current: DeviceTokenPayload,
  machineID: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshOutcome> {
  // Nothing to rotate. An empty refresh_token is a 401 at best and a wasted —
  // possibly rate-limited — call at worst, and "sign in again" is the same
  // answer the platform would have given.
  if (current.refreshToken === '') return { kind: 'expired' }
  try {
    const response = await fetchImpl(`${product.openApiBase}${REFRESH_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // The body shape is taken from the reference implementation and pinned by
      // a test: the refresh token and the machine id, and nothing else.
      body: JSON.stringify({ refresh_token: current.refreshToken, machine_id: machineID }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === 401 || response.status === 403) return { kind: 'expired' }
    if (response.status < 200 || response.status >= 300) return { kind: 'failed', name: `Http${response.status}` }
    const read = readJsonBody(await response.text())
    if (!read.ok) return { kind: 'failed', name: read.name }
    const rotated = parseDeviceTokenPayload(read.value)
    // A 200 with no token in it is a protocol surprise, not a rotation: saying
    // "refreshed" here would store the credential we already know is dead.
    if (rotated === undefined) return { kind: 'failed', name: 'NoToken' }
    return { kind: 'refreshed', payload: mergeRotation(current, rotated) }
  } catch (error) {
    return { kind: 'failed', name: errorName(error) }
  }
}
