/**
 * The Qoder pi-ai adapter.
 *
 * One adapter instance serves both Qoder regions, because each region is just
 * another profile in the same map — the same way a single `PiAiAdapter` can
 * front several providers. Every model's `baseUrl` points at its region's
 * loopback shim, so routing a request to a model is enough to select the
 * region, the credential, and the signing path.
 *
 * The profile is assembled by hand rather than through `dsh-llm-pi-ai`'s
 * internal resolver: that helper is not part of the package's public export
 * surface, so every field it would have supplied has to be named here.
 *
 * @module dsh-connect-qoder/adapter
 */
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { filterByEnabled } from './catalog-entry.js'
import { offPeakActive, offPeakRemaining, rateNow } from './offpeak.js'

/** Idle ceiling while one stream read is outstanding. */
const STREAM_IDLE_TIMEOUT_MS = 300000

/**
 * Image budgets at the `dsh-llm-pi-ai` defaults. They bound requests to models
 * whose catalog entry declares image input; text-only models never see images.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
}

/**
 * Inert pi-ai auth plane.
 *
 * This route authenticates only through the shim's shared secret, resolved per
 * request by `resolveApiKey`. pi-ai's own credential lifecycle must never
 * manufacture a credential for it, so every ambient question answers "nothing
 * stored, nothing set".
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-connect-qoder: the qoder route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false
    },
  },
}

/**
 * Whether one model may receive images.
 *
 * `auto` follows the catalog's own `is_vl` flag, which is what Qoder publishes
 * for every model it serves; `on` and `off` are the user's explicit override
 * from the settings card. An unrecognised mode degrades to `auto` rather than
 * disabling images, so a stale saved value cannot silently drop a capability.
 *
 * @param entry - one normalized catalog entry.
 * @param imageMode - `'auto'`, `'on'`, or `'off'`.
 * @returns true when the model should declare image input.
 */
function imageEnabled(entry, imageMode) {
  if (imageMode === 'on') return true
  if (imageMode === 'off') return false
  return entry.isVL === true
}

/** No per-token price is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Default context window when the catalog declares no usable one. */
const FALLBACK_CONTEXT_WINDOW = 200000

/**
 * The name the picker shows for one model.
 *
 * `listModels` forwards only `id`, `name`, and the input modalities, so the
 * multiplier has nowhere else to travel and is folded into the name — the same
 * approach the WorkBuddy bundle uses for its own rate. Every DSH-side join keys
 * on the model **id** (the selector's choice, the session events, the wire
 * request), so decorating the name is display-only and cannot affect routing.
 *
 * A zero multiplier means the model is free, which is worth saying outright;
 * anything else is shown to two decimals so the ordering is comparable. A
 * catalog entry with no multiplier at all keeps its bare name.
 */
function displayNameFor(entry, now) {
  const factor = rateNow(entry, now)
  if (!Number.isFinite(factor)) return entry.name
  if (factor <= 0) return `${entry.name} · 免费`
  const base = `${entry.name} · x${factor.toFixed(2)}`
  // The off-peak discount is time-dependent, so the name says which side of the
  // window it was computed on. Without this a rate that silently changes at
  // 22:00 would look like a bug.
  return offPeakActive(entry, now) ? `${base} 错峰` : base
}

/**
 * Map a catalog entry onto a pi-ai model descriptor.
 *
 * `id` is the value DSH shows and the value the shim receives; `upstreamKey`
 * rides along as the Qoder-side model key, which the shim needs on the wire.
 *
 * Two deliberate omissions:
 *
 * - **`maxTokens` is not declared.** `dsh-llm-pi-ai` records a declared value
 *   as the model's *configured* output ceiling, and pi-ai sends it as
 *   `max_tokens`. Qoder's catalog publishes no output ceiling, and reasoning
 *   shares that budget with the answer, so a declared value truncates long
 *   reasoned replies — the harness then reports `finish: max-tokens` and the
 *   visible text stops mid-sentence. Leaving it out lets the harness apply its
 *   own default instead.
 * - **`contextWindow` comes from `context_config`, not `max_input_tokens`.**
 *   The catalog's `context_config` is the set of windows the app itself offers,
 *   with one flagged as the default; `max_input_tokens` is a smaller floor that
 *   is not the advertised capacity. When `preferMaximumContext` is set the
 *   largest offered window is advertised instead of the catalog's own default,
 *   which is the choice the settings section exposes.
 *
 * The thinking map is the same decision the wire makes, expressed for the
 * picker: a model that always thinks refuses `enable_thinking: false`, so `off`
 * is reported as unsupported for it rather than offered and then rejected.
 */
export function toPiModel(entry, baseUrl, providerId, preferMaximumContext = false, imageMode = 'auto', now = new Date()) {
  const reasoning = entry.isReasoning === true
  const levels = Array.isArray(entry.effortLevels) ? entry.effortLevels : []
  const offered = (level) => (levels.includes(level) ? level : null)
  const canDisable = reasoning && entry.alwaysThinking !== true
  const options = Array.isArray(entry.contextOptions) ? entry.contextOptions.filter((n) => Number(n) > 0) : []
  const widest = options.length > 0 ? Math.max(...options) : 0
  // The Qoder client itself offers these windows up to 1M, so advertising the
  // largest declared window is legitimate — the gateway accepts it there, and
  // DSH sizes context from this number. Do not clamp it to `max_input_tokens`,
  // which is a smaller per-request floor, not the model's real ceiling.
  const preferred = preferMaximumContext && widest > 0 ? widest : 0
  const contextWindow =
    preferred > 0
      ? preferred
      : Number(entry.defaultContextWindow) > 0
        ? Number(entry.defaultContextWindow)
        : Number(entry.maxInputTokens) > 0
          ? Number(entry.maxInputTokens)
          : FALLBACK_CONTEXT_WINDOW
  return {
    id: entry.id,
    // The credit multiplier rides in the name because `listModels` forwards only
    // id/name/modalities, so there is no other field the picker would show. It is
    // resolved against `now`, because an off-peak model costs different amounts
    // on either side of its window.
    name: displayNameFor(entry, now),
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    // The catalog's `is_vl` is the default; the user's per-model choice wins.
    input: imageEnabled(entry, imageMode) ? ['text', 'image'] : ['text'],
    reasoning,
    ...(reasoning
      ? {
          thinkingLevelMap: {
            off: canDisable ? 'off' : null,
            minimal: null,
            low: offered('low'),
            medium: offered('medium'),
            high: offered('high'),
            xhigh: offered('xhigh'),
            max: offered('max'),
          },
        }
      : {}),
    cost: NO_COST,
    contextWindow,
    // `supportsDeveloperRole: false` is load-bearing, not cosmetic.
    //
    // pi-ai's OpenAI-completions API decides the system-prompt role as
    // `model.reasoning && compat.supportsDeveloperRole ? 'developer' : 'system'`.
    // When left unset, pi-ai auto-detects it from the provider/URL, and the
    // detection returns true for anything that does not look like a known
    // non-standard provider. This route's baseUrl is the loopback shim
    // (`http://127.0.0.1:<port>/v1`), so nothing matches that list and the
    // resolved value is true — and every Qoder model declares `reasoning: true`,
    // so pi-ai emits `role: "developer"` for the system prompt.
    //
    // Qoder's endpoint has no `developer` role. `toQoderMessages` used to drop
    // the unknown role silently, which left the request with no system message
    // at all — and the gateway answers a system-less request with
    // `403 {"code":"10605"}` ("your request is already in the queue") on every
    // attempt, no matter how long DSH retries. Declaring the capability false
    // makes pi-ai emit `role: "system"`, which the endpoint honours.
    compat: { maxTokensField: 'max_tokens', supportsDeveloperRole: false },
    // Qoder's own key for this model, carried for the shim's wire request.
    upstreamKey: entry.key,
  }
}

/**
 * The off-peak helpers, re-exported from lib/offpeak.js.
 *
 * They are re-exported rather than wrapped so that the settings card and the
 * adapter keep importing one name from one place, while the arithmetic itself
 * lives in a module that has no pi-ai dependency and can therefore be tested
 * directly. `offPeakRemaining` is exported so the card can show the same
 * countdown the Qoder client does, computed from the same catalog entry rather
 * than re-derived.
 */
export { offPeakActive, offPeakRemaining, rateNow } from './offpeak.js'

/**
 * Narrow a catalog to the models the user enabled.
 *
 * An **empty list means "no filter"**, following the WorkBuddy convention: a
 * fresh install has saved nothing and must still see every model. Once the list
 * is non-empty it becomes an allow-list.
 *
 * This is shared because two independent readers must agree: the adapter builds
 * the model list DSH routes requests through, and the shim answers
 * `GET /v1/models`, which is what the picker's discovery actually reads. If they
 * diverge, unchecking a model removes it from one surface and leaves it in the
 * other — so the filtering lives in one place rather than being written twice.
 *
 * Re-exported from lib/catalog-entry.js: that module is dependency-free, which
 * is what lets lib/shim.js use it without dragging adapter.js's peer
 * dependencies along.
 */
export { filterByEnabled } from './catalog-entry.js'

/**
 * Assemble one adapter covering every region.
 *
 * A single `PiAiAdapter` serves all regions because `registerAdapter` maps a
 * *set* of providers onto one adapter: registering each region in its own call
 * would leave only the last one owned, since a later call replaces the previous
 * registration rather than adding to it.
 *
 * @param options.regions - `[{ region, shim, catalog }]`, one entry per region.
 * @param options.preferMaximumContext - `() => boolean`, read per model build so
 *   the settings switch takes effect on the next `llm/adapters-updated`.
 * @param options.imageModeFor - `(modelId) => string`, the user's per-model image
 *   choice, read per model build for the same reason: turning a model's image
 *   input on or off must reach the picker without re-registering the adapter.
 * @param options.enabledIdsFor - `(regionId) => string[]`, the models the user
 *   wants offered in that region. An empty list means "no filter", not "none":
 *   a fresh install has saved nothing and must still show every model, which is
 *   the same convention the WorkBuddy bundle uses. Read per build so curating
 *   the roster reaches the picker on the next `llm/adapters-updated`.
 * @param options.resolveAttachments - `() => AttachmentStore | undefined`, the
 *   durable attachment service. **Omitting this breaks every image request.**
 *   pi-ai refuses any message carrying an image unless this resolves, so a route
 *   registered without it answers `UNSUPPORTED_CONTENT` ("pi-ai image input
 *   requires the durable attachment service") for the whole turn — which is what
 *   a model does the moment it reads back a screenshot it just produced.
 * @param options.resolveImageAccess - `(attachments, ref) => { readonlyPath } | undefined`,
 *   maps one durable image reference onto a path the request builder may read.
 *   Without it the store is reachable but no image can actually be located.
 * @returns `{ adapter, invalidate, providerIds }`.
 */
export function createQoderAdapter(options) {
  const runtimes = options.regions
  if (runtimes.length === 0) throw new Error('dsh-connect-qoder: no regions to adapt')
  const preferMaximumContext = options.preferMaximumContext ?? (() => false)
  const imageModeFor = options.imageModeFor ?? (() => 'auto')
  const enabledIdsFor = options.enabledIdsFor ?? (() => [])
  const resolveAttachments = options.resolveAttachments
  const resolveImageAccess = options.resolveImageAccess

  const buildModels = (runtime) => {
    const baseUrl = `${runtime.shim.baseUrl()}/v1`
    const widest = preferMaximumContext() === true
    const enabled = enabledIdsFor(runtime.region.id)
    return filterByEnabled(runtime.catalog(), enabled).map((entry) =>
      toPiModel(entry, baseUrl, runtime.region.id, widest, imageModeFor(entry.id)),
    )
  }

  const buildProfiles = () => {
    const profiles = new Map()
    for (const runtime of runtimes) {
      const providerId = runtime.region.id
      const displayName = runtime.region.displayName
      const provider = {
        ...createProvider({
          id: providerId,
          name: displayName,
          auth: {
            apiKey: {
              name: 'Qoder loopback shim token',
              async resolve({ credential }) {
                const apiKey = credential?.key
                return apiKey === undefined || apiKey.length === 0
                  ? undefined
                  : { auth: { apiKey }, source: displayName }
              },
            },
          },
          models: buildModels(runtime),
          api: openAICompletionsApi(),
        }),
        getModels: () => buildModels(runtime),
      }
      profiles.set(providerId, {
        provider: providerId,
        displayName,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        retryPolicy: resolveRetryPolicy(undefined, `dsh-connect-qoder.${providerId}.retryPolicy`),
        configuredMaxTokens: new Map(),
        modelErrors: new Map(),
        ...REQUEST_IMAGE_BUDGETS,
        piProvider: provider,
      })
    }
    return profiles
  }

  let profiles = buildProfiles()

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // Each region's shim secret is the only credential this route presents.
    resolveApiKey: async (provider) => {
      const runtime = runtimes.find((entry) => entry.region.id === provider)
      return runtime?.shim.token()
    },
    // Image input is a hard requirement of the pi-ai adapter, not an optional
    // extra: `streamWithSnapshot` throws UNSUPPORTED_CONTENT whenever a message
    // carries an image and `resolveAttachments()` yields undefined. A Qoder
    // model that reads back a screenshot it just produced sends exactly such a
    // message, so leaving these unwired turns a normal step into a failed run.
    //
    // Both are passed through from the caller rather than resolved here: this
    // module stays free of Cordis context, and the official `llm-pi-ai` plugin
    // wires the same two hooks the same way.
    ...(resolveAttachments === undefined ? {} : { resolveAttachments }),
    ...(resolveImageAccess === undefined ? {} : { resolveImageAccess }),
  })

  return {
    adapter,
    invalidate: () => {
      profiles = buildProfiles()
    },
    providerIds: runtimes.map((runtime) => runtime.region.id),
  }
}
