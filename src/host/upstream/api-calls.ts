/**
 * api-calls — moved verbatim from `src/host/upstream.ts` during the protocol
 * split (docs/issues/22-upstream-split.md); only imports and exports were
 * tidied. The protocol facts live in the header of `crypto.ts`.
 */

import { authHeaders } from './cosy-sign.ts'
import { openApiHeaders } from './headers.ts'
import { modelListUrl, exchangeUrl, userInfoUrl, campaignsUrl, claimCampaignUrl } from './endpoints.ts'
import { normalizePromotion } from './fetch-usage.ts'
import { parseRetryAfterSeconds, ProtocolShapeChangedError, UpstreamRefusalError, redactSecrets } from '../errors.ts'
import { toEpochMs } from '../time.ts'
import type { QoderCredential, Region } from '../domain.ts'

/**
 * Parse a JSON body, reporting the content-type when parsing fails.
 *
 * A 200 reply whose body is not JSON (an HTML login page from a SSO gateway,
 * a chunked-proxy error document) would otherwise surface as a cryptic
 * `SyntaxError: Unexpected token '<'`. The body is read once and parsed
 * directly — so a parseable body passes regardless of how the gateway labelled
 * it — and only a genuine parse failure produces the richer message.
 *
 * @param response - the successful (2xx) response to read.
 * @param context - short label for the error message (e.g. "Qoder model list").
 * @returns the parsed JSON value.
 */
export async function readJson(response: Response, context: string): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    const ct = response.headers.get('content-type') ?? 'no content-type'
    throw new Error(`${context}: response is not valid JSON (${ct}) — ${redactSecrets(text).slice(0, 300)}`)
  }
}

/**
 * Narrow a campaigns payload to the envelope {@link projectCampaignRows} reads.
 *
 * The endpoint is supplementary, but "no offers today" and "the offers envelope
 * was renamed" used to be indistinguishable: the panel simply rendered nothing
 * and the check-in card vanished, with no hint the plugin was out of step. The
 * clone's private protocol has no version negotiation, so this is the failure
 * that reaches users first after an upstream release.
 *
 * Deliberate non-drift cases: an empty object (nothing to misread) and a
 * missing `campaigns` value (null/undefined) both stay "no campaigns".
 *
 * @param payload - the parsed 200 body.
 * @returns the campaigns record.
 * @throws {ProtocolShapeChangedError} when the body is not a campaigns document.
 */
export function readCampaignsShape(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolShapeChangedError(
      `campaigns top level is ${payload === null ? 'null' : Array.isArray(payload) ? 'an array' : typeof payload}, not a campaigns envelope`,
    )
  }
  const record = payload as Record<string, unknown>
  const keys = Object.keys(record)
  // A campaigns document may omit the `campaigns` ARRAY when nothing is
  // running — the banner/claimable envelope fields are still there. So the
  // known-envelope set accepts either, and a body with none of them is drift.
  const KNOWN_ENVELOPE_FIELDS = ['campaigns', 'uid', 'showCampaign', 'claimable']
  if (keys.length > 0 && !keys.some((key) => KNOWN_ENVELOPE_FIELDS.includes(key))) {
    throw new ProtocolShapeChangedError(`no known campaigns field; keys present: ${keys.slice(0, 12).join(', ')}`)
  }
  if (record.campaigns !== null && record.campaigns !== undefined && !Array.isArray(record.campaigns)) {
    throw new ProtocolShapeChangedError(`\`campaigns\` is ${typeof record.campaigns}, not an array`)
  }
  return record
}

/**
 * Read the raw campaigns payload once.
 *
 * Split from the old `fetchCampaigns` (deleted in cleanup #1: it had no
 * callers) so one round trip can serve both things the campaign list answers:
 * the promotional copy the usage panel renders, and the
 * `actionType` / `claimStatus` pair that decides whether there is a daily
 * check-in to claim today. Sending two requests for those would be one more
 * way for the panel and the button to disagree.
 *
 * @returns the parsed campaigns document, unvalidated — `readJson` proves only
 *   that the body parsed as JSON, so the shape is left `unknown` and
 *   {@link projectCampaignRows} is what narrows it. The previous signature
 *   claimed `{ campaigns?: Campaign[] }`, which no code had ever checked; it
 *   compiled only because the field reads went through an `any`.
 */
export async function readCampaigns(
  region: Region,
  credential: QoderCredential,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(campaignsUrl(region), {
    method: 'GET',
    headers: openApiHeaders(credential, region),
    redirect: 'error',
    // `signal` is absent, not `undefined`: `RequestInit.signal` accepts
    // `AbortSignal | null` and `exactOptionalPropertyTypes` rejects an explicit
    // undefined. Spreading keeps "no timeout" as "no key", which is what the
    // runtime already saw.
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    // The body is read even though the message does not include it: it is where
    // the daily-limit code (`type`/`code`/`errorCode`) and the sign-in prose
    // live, and that is the whole difference between the card naming a spent
    // allowance and it naming a generic refresh failure (docs/issues/24).
    throw new UpstreamRefusalError(
      `Qoder campaigns failed: HTTP ${response.status}`,
      response.status,
      redactSecrets(await response.text()).slice(0, 300),
      response.headers.get('retry-after'),
    )
  }
  return readCampaignsShape(await readJson(response, 'Qoder campaigns'))
}

/**
 * Claim one campaign's benefit, returning the raw answer.
 *
 * The upstream answers a repeat claim idempotently — `replayed: true`, nothing
 * granted — rather than failing it, so calling this twice costs no Credits.
 * Shape normalisation is a separate pure function (`normalizeClaimResult`) so
 * the interesting part is asserted without a network.
 *
 * @returns the parsed claim response, unvalidated — {@link normalizeClaimResult}
 *   is what narrows it, so the shape stays `unknown` here.
 */
export async function claimCampaign(
  region: Region,
  credential: QoderCredential,
  campaignId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (typeof campaignId !== 'string' || campaignId.length === 0) {
    throw new Error('Qoder check-in failed: no campaign id to claim')
  }
  const response = await fetch(claimCampaignUrl(region, campaignId), {
    method: 'POST',
    headers: { ...openApiHeaders(credential, region), 'Content-Type': 'application/json' },
    body: '{}',
    redirect: 'error',
    ...(signal === undefined ? {} : { signal }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new UpstreamRefusalError(
      `Qoder check-in failed: HTTP ${response.status} ${redactSecrets(text).slice(0, 200)}`,
      response.status,
      redactSecrets(text).slice(0, 300),
      response.headers.get('retry-after'),
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    const ct = response.headers.get('content-type') ?? 'no content-type'
    throw new Error(`Qoder check-in: response is not valid JSON (${ct}) — ${redactSecrets(text).slice(0, 300)}`)
  }
}

/**
 * Read the model list's product-surface groups and return the `chat` one. A missing
 * sibling group is normal (the global edition has no `developer` group), so only `chat`
 * is keyed on; an empty group is `[]`, not an absent key: `chat: []` is the honest "no
 * models on this surface", not drift. The three states stay apart: an array is the
 * `chat` group, a plain object an unknown wrapper, an absent `chat` a renamed group —
 * either drift (docs/issues/04-empty-catalog-freeze.md).
 * @param data - the parsed 200 body.
 * @param region - the region descriptor, for the error message only.
 * @returns the `chat` array of raw rows.
 * @throws {ProtocolShapeChangedError} for either drift shape. */
export function readModelCatalogShape(
  data: unknown,
  _region: { displayName: string } = { displayName: 'Qoder' },
): unknown[] {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ProtocolShapeChangedError(
      `top level is ${Array.isArray(data) ? 'an array' : typeof data}, not a group envelope`,
    )
  }
  const envelope = data as Record<string, unknown>
  if (!('chat' in envelope)) {
    // The useful part of the message is what DID arrive: a renamed group reads
    // instantly ("it is called `models` now"), where "no chat" alone would
    // leave the maintainer guessing.
    throw new ProtocolShapeChangedError(
      `no \`chat\` group; groups present: ${Object.keys(envelope).slice(0, 12).join(', ') || '(none)'}`,
    )
  }
  const chat = envelope.chat
  if (!Array.isArray(chat)) {
    throw new ProtocolShapeChangedError(`\`chat\` is ${chat === null ? 'null' : typeof chat}, not an array`)
  }
  return chat
}

/**
 * Fetch and normalize the account's model catalog.
 *
 * The response is grouped by product surface (`chat`, `developer`, `quest`,
 * ...). The `chat` group is the one that answers on the `agent_common` route,
 * so only it is used.
 *
 * @returns an array of `{ key, name, isVL, isReasoning, maxInputTokens, ... }`.
 * @throws {ProtocolShapeChangedError} when the 200 body is not an envelope
 *   this code recognises — see {@link readModelCatalogShape}.
 */
export async function fetchModels(
  region: Region,
  credential: QoderCredential,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const url = modelListUrl(region)
  const headers = authHeaders(Buffer.alloc(0), url, credential)
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', ...headers },
    redirect: 'error',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    // Redact BEFORE the slice: a credential riding the tail of a body would
    // otherwise be cut in half and slip past every shape rule.
    const text = redactSecrets(await response.text()).slice(0, 300)
    throw new UpstreamRefusalError(
      `Qoder model list failed: HTTP ${response.status} ${text}`,
      response.status,
      text,
      response.headers.get('retry-after'),
    )
  }
  const data = await readJson(response, 'Qoder model list')
  const chat = readModelCatalogShape(data, region)
  if (chat.length === 0) return []
  const models: unknown[] = []
  for (const raw of chat) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    if (typeof entry.key !== 'string' || entry.key.length === 0) continue
    if (entry.enable === false) continue
    if (typeof entry.display_name !== 'string' || entry.display_name.length === 0) continue
    const config = entry.thinking_config as
      | { enabled?: { efforts?: unknown }; disabled?: unknown }
      | undefined
    const efforts = config?.enabled?.efforts
    // `efforts` is an object keyed by level (`{ high: {}, max: {} }`), not an
    // array, and `disabled` is present only on models that permit turning
    // thinking off. A model with `enabled` and no `disabled` block always
    // thinks: it answers `enable_thinking: false` with provider_error 1210
    // ("该模型始终思考，不支持关闭思考"), so the flag must be omitted for it.
    const effortLevels = efforts !== null && typeof efforts === 'object' ? Object.keys(efforts) : []
    const supportsEffort = effortLevels.length > 0
    const canDisableThinking = config?.disabled !== undefined

    // The catalog publishes its selectable context windows as `context_config`
    // (`{ "1M": {...}, "200K": { is_default: true }, ... }`). It publishes no
    // output ceiling anywhere, so the catalog entry deliberately carries no
    // output-ceiling field: the ceiling is a platform-wide constant, probed
    // once and pinned in `pi-model.ts` (`PROBED_MAX_TOKENS`), not per-model
    // catalog data.
    //
    // - `context_config` is the only place the offered window sizes exist, and
    //   the entry flagged `is_default` is the one the app itself starts on, so
    //   these become the choices the model picker can offer.
    // - The output ceiling is pinned, not omitted. `pi-model.ts` declares
    //   `PROBED_MAX_TOKENS` (65536) in every pi-ai descriptor, and
    //   dsh-llm-pi-ai's `resolveEntry` uses it as the per-turn cap. That pin
    //   matters: an omitted ceiling falls through to `resolveEntry`'s 32768
    //   default, which truncated long reasoned turns mid-sentence. See the
    //   `pi-model.ts` module header, item 2, for the chain and provenance.
    const windows = entry.context_config
    const contextOptions: number[] = []
    let defaultContextWindow = 0
    if (windows !== null && typeof windows === 'object') {
      for (const value of Object.values(windows as Record<string, unknown>)) {
        const option = value as { token_count?: unknown; is_default?: unknown } | null
        const tokens = Number(option?.token_count)
        if (!Number.isFinite(tokens) || tokens <= 0) continue
        contextOptions.push(tokens)
        if (option?.is_default === true) defaultContextWindow = tokens
      }
      contextOptions.sort((left, right) => left - right)
    }
    if (defaultContextWindow === 0) defaultContextWindow = Number(entry.max_input_tokens) || 0

    models.push({
      key: entry.key,
      name: entry.display_name,
      isVL: entry.is_vl === true,
      isReasoning: entry.is_reasoning === true || config !== undefined,
      supportsEffort,
      alwaysThinking: supportsEffort && !canDisableThinking,
      effortLevels,
      defaultContextWindow,
      contextOptions,
      maxInputTokens: Number(entry.max_input_tokens) || 0,
      isDefault: entry.is_default === true,
      // Absence is preserved, not folded to 0 — see `priceFactorOf` in
      // lib/catalog-entry.js for why (a manufactured zero renders as 免费, so a
      // renamed `price_factor` would present every model as free instead of
      // showing no rate). This is the only place the raw wire field is read, so
      // the rule is stated here in full rather than shared across the two
      // modules: `catalog-entry.ts` does not import this one and this one does
      // not import that one.
      priceFactor: (() => {
        if (entry.price_factor === undefined || entry.price_factor === null) return undefined
        const factor = Number(entry.price_factor)
        return Number.isFinite(factor) ? factor : undefined
      })(),
      isFree: entry.is_free === true,
      promotion: normalizePromotion(entry.promotion),
    })
  }
  return models
}

/**
 * Exchange a personal access token for a job token.
 *
 * @returns `{ token, refreshToken, expiresAt }`.
 */
export async function exchangePat(
  region: Region,
  pat: string,
  signal?: AbortSignal,
): Promise<{ token: string; refreshToken: string; expiresAt: number }> {
  const response = await fetch(exchangeUrl(region), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ personal_access_token: pat }),
    redirect: 'error',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    // Redact BEFORE the slice: a credential riding the tail of a body would
    // otherwise be cut in half and slip past every shape rule.
    const text = redactSecrets(await response.text()).slice(0, 300)
    // Carry what a throttle gate needs to honour the platform's own window
    // rather than invent one: the HTTP status classifies the refusal (a 429 is
    // a rate limit, a 401/403 is a dead credential), and `Retry-After` — read
    // off the header, falling back to a `retryAfterSeconds` field in the body —
    // is the wait the platform asked for. The gate reads both off the thrown
    // error's flags; see `CredentialCache`. An error whose prototype is lost
    // across the throw boundary still carries them, which is why they are plain
    // fields and not a subclass.
    const error = new Error(`Qoder PAT exchange failed: HTTP ${response.status} ${text}`) as Error & {
      status: number
      retryAfterSeconds?: number
    }
    error.status = response.status
    let retryAfter = parseRetryAfterSeconds(response.headers.get('retry-after'))
    if (retryAfter === undefined) {
      // A body-carried window is a second source the gateway has used; it lives
      // in the JSON, not a header. Parse leniently — a non-JSON body is already
      // covered by the header path and leaves no wait.
      const bodySeconds = /"retryAfterSeconds"\s*:\s*(\d+)/.exec(text)
      if (bodySeconds?.[1] !== undefined) {
        const parsed = Number(bodySeconds[1])
        if (Number.isFinite(parsed) && parsed > 0) retryAfter = parsed
      }
    }
    if (retryAfter !== undefined) error.retryAfterSeconds = retryAfter
    throw error
  }
  const data = await readJson(response, 'Qoder PAT exchange')
  // The gateway has answered this field three different ways across builds, so
  // all three spellings are tried. Narrowed through one record read rather than
  // three chained `?.` on an `any`: the values stay `unknown`, so the
  // `typeof token !== 'string'` check below is what actually proves the token.
  const payload = data === null || typeof data !== 'object' ? {} : (data as Record<string, unknown>)
  const token = payload.token ?? payload.job_token ?? payload.jobToken
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Qoder PAT exchange returned no token')
  }
  return {
    token,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : '',
    expiresAt: toEpochMs(payload.expires_at) ?? (Date.now() + 3600_000),
  }
}

/**
 * Narrow a userinfo body to the record the identity fields are read from.
 *
 * Two envelopes occur (the identity sits under `data` or at the top level), and
 * the card's 在线校验 turns this call into "your sign-in is valid" — so a body
 * that is no longer the profile document must not be reported as a valid
 * sign-in with an empty name. An empty object still answers `{}` (no identity
 * to show, which the card renders as a plain confirm), but a non-empty body
 * carrying no identity field at all is drift.
 *
 * @param data - the parsed 200 body.
 * @returns the identity record.
 * @throws {ProtocolShapeChangedError} when the body is not a profile document.
 */
export function readUserInfoShape(data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ProtocolShapeChangedError(
      `userinfo top level is ${data === null ? 'null' : Array.isArray(data) ? 'an array' : typeof data}, not a userinfo envelope`,
    )
  }
  const envelope = data as Record<string, unknown>
  const inner = envelope.data
  const body = inner === null || typeof inner !== 'object' ? envelope : (inner as Record<string, unknown>)
  const keys = Object.keys(body)
  if (keys.length === 0) return body
  const IDENTITY_FIELDS = ['id', 'user_id', 'name', 'nickname', 'email']
  if (!keys.some((key) => IDENTITY_FIELDS.includes(key))) {
    throw new ProtocolShapeChangedError(`no identity field; keys present: ${keys.slice(0, 12).join(', ')}`)
  }
  return body
}

/**
 * Fetch the signed-in account's profile.
 *
 * The request goes through `openApiHeaders` like every other OpenAPI call, so
 * the whole route presents one client identity (`Cosy-ClientType`,
 * `User-Agent`) to the gateway.
 *
 * That is consistency, not the cure for a failure seen here: a direct probe of
 * `openapi.qoder.com.cn/api/v1/userinfo` with a real CN credential answers
 * HTTP 200 for a bare `Authorization: Bearer` as well. The 400 the card once
 * showed on 在线确认 came from the account route dereferencing a runtime
 * entry's nonexistent `region` field before this call was ever made (see the
 * stopped-region check in lib/index.js). Keep the shared header set: it is
 * what the real client sends, and the other OpenAPI calls already rely on it.
 *
 * @returns `{ userID, name, email }`.
 */
export async function fetchUserInfo(
  region: Region,
  credential: QoderCredential,
  signal?: AbortSignal,
): Promise<{ userID: string; name: string; email: string }> {
  const response = await fetch(userInfoUrl(region), {
    method: 'GET',
    headers: openApiHeaders(credential, region),
    redirect: 'error',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    // Redact BEFORE the slice: a credential riding the tail of a body would
    // otherwise be cut in half and slip past every shape rule.
    const text = redactSecrets(await response.text()).slice(0, 300)
    throw new UpstreamRefusalError(
      `Qoder userinfo failed: HTTP ${response.status} ${text}`,
      response.status,
      text,
      response.headers.get('retry-after'),
    )
  }
  const data = await readJson(response, 'Qoder userinfo')
  // Two envelopes occur: the identity sits either under `data` or at the top
  // level. The narrowing is triaged (see `readUserInfoShape`) rather than
  // assumed, so a renamed envelope surfaces as a shape change instead of an
  // empty-but-"valid" sign-in.
  const body = readUserInfoShape(data)
  return {
    userID: String(body.id ?? body.user_id ?? ''),
    name: String(body.name ?? body.nickname ?? ''),
    email: String(body.email ?? ''),
  }
}
