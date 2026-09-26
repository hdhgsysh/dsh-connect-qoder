/**
 * DSH Connect Qoder — bring locally signed-in Qoder models into DeepSeek
 * Harness.
 *
 * The Qoder desktop apps (Qoder CN and the international Qoder) already hold a
 * valid sign-in on this machine. This bundle reads that sign-in, registers one
 * DSH provider per region, and routes each region's traffic through a private
 * loopback shim that speaks OpenAI to pi-ai and COSY-signed Qoder on the way
 * out.
 *
 * Both regions register unconditionally and independently: whichever apps are
 * signed in produce a visible model group, and a region with no credential
 * simply contributes no models. Nothing here starts an OAuth flow, and nothing
 * writes to the Qoder apps' own files.
 *
 * @module dsh-connect-qoder
 */
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import z from '@deepseek-ai/schemastery'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { createQoderAdapter, offPeakActive, offPeakRemaining, rateNow } from './adapter.js'
import { createQoderShim } from './shim.js'
import { REGIONS, loadCredential, loadEnvCredential } from './credentials.js'
import { exchangePat, fetchModels, fetchUsage } from './upstream.js'

/** Loader row id; also the plugin's identity in the composition. */
export const name = 'llm-qoder'

/** The model registry that must exist before a provider can register. */
export const inject = ['llm']

/**
 * Settings namespace owning this plugin's section.
 *
 * A namespace only becomes configurable once a section is installed into it —
 * `registerConfigurableProviders` merely *addresses* the namespace. Without the
 * section there is no schema, so no configuration surface can render a control
 * for this route at all.
 */
export const QODER_SETTINGS_NS = 'dsh-connect-qoder'

/**
 * The settings fields a `__save` request may write, and the merge rule each
 * one uses.
 *
 * `regions` shape (`{ [regionId]: [...ids] }`): merge the incoming region keys
 * into the field's authoritative value, so saving one region's allow-list can
 * never delete the other region's. `whole` shape: replace the field outright
 * (the card always posts its complete value).
 */
const QODER_SAVE_FIELDS = {
  enabledModelIds: 'regions',
  imageOverrides: 'whole',
  useMaximumContextWindow: 'whole',
}

/** Plugin-owned route the settings card's save button writes through. */
const QODER_SAVE_PATH = '/plugins/dsh-connect-qoder/__save'

/**
 * Mark a schema's field as volatile on the DSH lines that support it.
 *
 * `volatile()` exists from schemastery 3.18.3 (the 0.1.7 line); on older
 * pinning (3.18.2, the 0.1.5 line) it is absent and this degrades to an
 * identity no-op, exactly as the WorkBuddy bundle does. Volatile fields
 * hand the Host a live reference (`{get()}`) that re-resolves on every
 * `loader/volatile-update` — that is how settings edits reach a running
 * host without a restart. The Host's `__save` route unwraps the reference
 * before merging and mutating, and the live `current()` below resolves it
 * the same way.
 */
function asVolatile(schema) {
  if (typeof schema.volatile === 'function') return schema.volatile()
  return schema
}

/**
 * Prefer the largest context window the catalog declares for a model.
 *
 * Qoder's catalog offers 200K/400K/1M for most models and flags one as its own
 * default. This switch decides whether this plugin advertises the largest
 * offered window or the one Qoder itself starts on.
 */
const USE_MAXIMUM_CONTEXT_WINDOW_FIELD = asVolatile(
  z
    .boolean()
    .default(false)
    .description('Advertise each model\'s largest declared context window instead of Qoder\'s own default window'),
)

/**
 * Per-model image-input opt-in, keyed by user-facing model id.
 *
 * Qoder's catalog advertises `is_vl` per model and this plugin maps it straight
 * onto the pi-ai `input` list, so a vision model arrives already declaring
 * image input. The user still owns the final say: an entry here overrides the
 * catalog for one model, which is what lets a model the catalog marks text-only
 * (or one the endpoint rejects images for) be turned off — and what lets a
 * mislabelled model be turned on. Absent means "follow `is_vl`".
 */
const IMAGE_MODES = ['auto', 'on', 'off']

/** One model's image preference. */
const IMAGE_OVERRIDES_FIELD = asVolatile(
  z
    .dict(z.union(IMAGE_MODES))
    .default({})
    .description('Per-model image input: "auto" follows the catalog, "on"/"off" force it'),
)

/**
 * Which models the picker offers, per region.
 *
 * An **empty list means "no filter"**, not "nothing": that is the same
 * convention the WorkBuddy bundle uses, and it is what keeps a fresh install
 * working — a new user has saved nothing yet, and must still see every model.
 * Once a list is non-empty it becomes an allow-list for that region.
 *
 * Keyed by region id (`qoder-cn`, `qoder`) so the two editions can be curated
 * independently; the CN and global rosters share no model ids.
 */
const ENABLED_MODEL_IDS_FIELD = asVolatile(
  z
    .dict(z.array(z.string()))
    .default({})
    .description('Per-region allow-list of model ids; an empty list shows every model'),
)

/** The plugin's whole configuration schema. */
export const Config = z.object({
  useMaximumContextWindow: USE_MAXIMUM_CONTEXT_WINDOW_FIELD,
  imageOverrides: IMAGE_OVERRIDES_FIELD,
  enabledModelIds: ENABLED_MODEL_IDS_FIELD,
})

/** The section this plugin publishes for its settings namespace. */
const QODER_SECTION = z.object({
  useMaximumContextWindow: USE_MAXIMUM_CONTEXT_WINDOW_FIELD,
  imageOverrides: IMAGE_OVERRIDES_FIELD,
  enabledModelIds: ENABLED_MODEL_IDS_FIELD,
})

/** Plugin-owned read-only route the settings card reads its model rows from. */
const QODER_MODELS_PATH = '/plugins/dsh-connect-qoder/models'

/**
 * Plugin-owned read-only route the card reads its usage panel from.
 *
 * Kept separate from the model route so the panel can be refreshed on its own:
 * quota moves with every turn, while the catalog changes rarely.
 */
const QODER_USAGE_PATH = '/plugins/dsh-connect-qoder/usage'

/**
 * How long a fetched usage reading stays fresh.
 *
 * Quota moves only when a turn runs, so a short cache keeps the panel honest
 * without turning every card render into an upstream round trip. The refresh
 * button bypasses it.
 */
const USAGE_TTL_MS = 20 * 1000

/** Answer one card request. */
function sendJson(res, status, value) {
  const payload = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * Whether a card request came from this machine.
 *
 * The route exposes model metadata, not credentials, but it stays loopback-only
 * anyway: it is an internal read path for a browser page this host itself
 * served, and a missing Origin (a same-origin GET) is the normal case.
 */
function loopbackRequest(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  try {
    const host = new URL(origin).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

/** How long a fetched catalog stays fresh before it is refetched. */
const CATALOG_TTL_MS = 30 * 60 * 1000

/** On-disk format this reader accepts; other versions are discarded. */
const CATALOG_FORMAT_VERSION = 1

/** Plugin-owned catalog path inside the Harness home. */
export function qoderCatalogPath(filename = '.qoder-catalog.json') {
  return join(resolveDshHome(), filename)
}

/**
 * The last catalog that actually loaded, per region.
 *
 * A restart must not drop the user to an empty model group when a good catalog
 * was fetched minutes earlier, and a temporary upstream failure must not either.
 * Only model metadata is stored — never a token.
 */
class CatalogStore {
  constructor(region, logger) {
    this.path = qoderCatalogPath(`.qoder-catalog.${region.id}.json`)
    this.logger = logger
    this.entries = []
    this.fetchedAt = 0
    this.load()
  }

  load() {
    // A crash mid-`save()` can leave a `.tmp` sibling behind; clean it up so
    // the next `save()` writes to a fresh temp file without stale data.
    const tmp = `${this.path}.tmp`
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // Inert; the next save overwrites it.
    }
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (parsed?.version !== CATALOG_FORMAT_VERSION) return
      if (!Array.isArray(parsed.entries)) return
      this.entries = parsed.entries
      this.fetchedAt = Number(parsed.fetchedAt) || 0
    } catch {
      // A damaged cache is simply ignored; the next fetch replaces it.
    }
  }

  save() {
    // Write to a sibling temp file, then rename onto the target. On POSIX the
    // rename is atomic, so a crash mid-write never leaves a half-written JSON
    // that the next `load()` would parse-fail on and discard the whole catalog.
    // On Windows the rename-over-existing also works (MoveFileEx), and a crash
    // still leaves either the old file or the complete new one, never a mix.
    try {
      const dir = join(this.path, '..')
      mkdirSync(dir, { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: CATALOG_FORMAT_VERSION, fetchedAt: this.fetchedAt, entries: this.entries }, null, 2), 'utf8')
      renameSync(tmp, this.path)
    } catch (error) {
      // A failed rename leaves the temp file behind; clean it up so the next
      // `save()` can write to it again.
      try {
        if (existsSync(`${this.path}.tmp`)) unlinkSync(`${this.path}.tmp`)
      } catch {
        // A leftover temp file is inert; the next save overwrites it.
      }
      this.logger?.warn?.(`dsh-connect-qoder: could not save catalog ${this.path}`, error)
    }
  }

  current() {
    return this.entries
  }

  fresh() {
    return Date.now() - this.fetchedAt < CATALOG_TTL_MS
  }

  replace(entries) {
    this.entries = entries
    this.fetchedAt = Date.now()
    this.save()
  }
}

/**
 * A model id is the catalog display name with whitespace removed, so the id is
 * stable and readable; the upstream key is tracked beside it for the wire.
 */
function modelIdFor(entry) {
  return (entry.display_name || 'QoderModel').replace(/\s+/g, '')
}

/**
 * Reshape one entry from {@link fetchModels} for storage and lookup.
 *
 * The catalog interpretation (vision, reasoning, effort support, and the
 * always-thinking rule) already happened in `fetchModels`, so this only adds
 * the user-facing id.
 */
function normalizeEntry(entry) {
  return {
    id: modelIdFor({ display_name: entry.name }),
    key: entry.key,
    name: entry.name,
    isVL: entry.isVL === true,
    isReasoning: entry.isReasoning === true,
    supportsEffort: entry.supportsEffort === true,
    alwaysThinking: entry.alwaysThinking === true,
    effortLevels: Array.isArray(entry.effortLevels) ? entry.effortLevels : [],
    maxInputTokens: entry.maxInputTokens ?? 0,
    // `toPiModel` sizes each model from these two, so dropping them here (which
    // is what happened before) made `useMaximumContextWindow` do nothing at all:
    // with no `contextOptions` the "widest offered window" is 0, the switch has
    // nothing to prefer, and every model falls back to `max_input_tokens` — a
    // smaller per-request floor, not the capacity the catalog advertises. They
    // are carried through verbatim so the setting and the picker agree.
    defaultContextWindow: entry.defaultContextWindow ?? 0,
    contextOptions: Array.isArray(entry.contextOptions) ? entry.contextOptions : [],
    // The credit multiplier Qoder charges for this model. It is display-only,
    // but the picker shows it beside the name so the cost of a choice is visible
    // before the request is sent. `toPiModel` is what formats it.
    priceFactor: Number(entry.priceFactor) || 0,
    // Free models skip the credit multiplier entirely; the picker reads
    // `isFree` to display 免费 instead of `x0.00`.
    isFree: entry.isFree === true,
    // Whether Qoder starts the app on this model by default
    // (`entry.is_default` in the raw catalog; the app's initial selection).
    isDefault: entry.isDefault === true,
    // The time-of-day discount block (`fetchModels` produced it as
    // `promotion` — the off-peak window, its discounted and pre-promotion
    // multipliers, and the copy that describes it). Dropped once: with the
    // field missing from the catalog entry, `toPiModel` and the settings
    // card both saw `promotion === undefined` and the whole off-peak
    // machinery — the `错峰` name suffix, the window countdown, the
    // `before × discount` rate — was dead code that could never fire.
    promotion: entry.promotion,
  }
}

/**
 * Owns one region: its credential, catalog, shim, adapter, and registration.
 */
class RegionRuntime {
  constructor(region, ctx) {
    this.region = region
    this.ctx = ctx
    this.logger = ctx.logger
    this.catalog = new CatalogStore(region, ctx.logger)
    this.credential = undefined
    this.exchanged = undefined
    this.refreshTimer = undefined
    /** Last usage reading and when it was taken; see {@link RegionRuntime.readUsage}. */
    this.usage = undefined
    this.usageAt = 0
    /**
     * Set when a request is rejected with a sign-in failure, so the next
     * {@link RegionRuntime.resolveCredential} call forces a re-read from disk.
     * Without this, a cached app credential whose token has expired stays
     * cached for the process's life — `resolveCredential` returns the stale
     * entry (its `expired` flag was computed at startup, not at request time),
     * and every request 401s until DSH is restarted.
     */
    this.credentialInvalid = false
    // Set by the fiber's effect cleanup (dispose) so any in-flight `.then`
    // callbacks that race the dispose can tell the runtime is already dead
    // and not install a new `setInterval` onto it.
    this.disposed = false
  }

  /**
   * Resolve the current credential, exchanging a PAT when that is the source.
   *
   * The Qoder app owns the token's lifecycle and refreshes it in its own
   * store, so an expired token is re-read from disk rather than cached — a
   * user who reopened the app is picked up on the next request, with no
   * restart. A PAT, by contrast, is exchanged once and then reused until its
   * own expiry.
   */
  async resolveCredential() {
    // A request was rejected with a sign-in failure; force a re-read so a
    // freshly re-signed-in app is picked up without a DSH restart.
    if (this.credentialInvalid) {
      this.credentialInvalid = false
      this.exchanged = undefined
    }
    if (this.exchanged !== undefined) {
      if (this.exchanged.source === 'env-pat' && this.exchanged.expiresAt > Date.now()) return this.exchanged
      if (this.exchanged.source !== 'env-pat' && !this.exchanged.expired) return this.exchanged
    }
    const fromApp = loadCredential(this.region, process.env.APPDATA ?? '')
    const credential = fromApp ?? loadEnvCredential(this.region)
    this.credential = credential
    if (credential === undefined) {
      this.exchanged = undefined
      return undefined
    }
    if (credential.source === 'env-pat') {
      const exchanged = await exchangePat(this.region, credential.token)
      this.exchanged = {
        ...credential,
        token: exchanged.token,
        refreshToken: exchanged.refreshToken,
        expiresAt: exchanged.expiresAt,
      }
      return this.exchanged
    }
    this.exchanged = credential
    return credential
  }

  /**
   * Invalidate the cached credential after an upstream sign-in rejection.
   *
   * The next {@link RegionRuntime.resolveCredential} call re-reads the app's
   * store, so a re-sign-in is picked up without a restart. This is called
   * from the shim when the upstream answers with a sign-in failure.
   */
  invalidateCredential() {
    this.credentialInvalid = true
  }

  /** Refresh the model catalog from upstream, keeping the last good one on failure. */
  async refreshCatalog(force = false) {
    if (!force && this.catalog.fresh()) return
    let credential
    try {
      credential = await this.resolveCredential()
    } catch (error) {
      this.logger?.warn?.(`dsh-connect-qoder: ${this.region.displayName} credential resolution failed`, error)
      return
    }
    if (credential === undefined) return
    try {
      const raw = await fetchModels(this.region, credential)
      const entries = raw.map(normalizeEntry)
      if (entries.length > 0) {
        this.catalog.replace(entries)
        this.invalidate?.()
      }
    } catch (error) {
      this.logger?.warn?.(`dsh-connect-qoder: ${this.region.displayName} catalog refresh failed`, error)
    }
  }

  /** Look up the upstream key for a user-facing model id. */
  upstreamKey(modelId) {
    const found = this.catalog.current().find((entry) => entry.id === modelId)
    return found?.key
  }

  /** The catalog entry behind a user-facing model id. */
  entryFor(modelId) {
    return this.catalog.current().find((entry) => entry.id === modelId)
  }

  /**
   * Read the account's usage, with a short cache.
   *
   * The card is the only consumer and it can be expanded repeatedly, so a
   * reading taken moments ago is reused; `force` is what the panel's refresh
   * button asks for. A failure is never cached, so a transient upstream problem
   * does not pin the panel to an error state.
   */
  async readUsage(force = false) {
    if (!force && this.usage !== undefined && Date.now() - this.usageAt < USAGE_TTL_MS) {
      return this.usage
    }
    const credential = await this.resolveCredential()
    if (credential === undefined) return undefined
    const usage = await fetchUsage(this.region, credential)
    this.usage = usage
    this.usageAt = Date.now()
    return usage
  }
}

/**
 * Start one region's shim and catalog lifecycle.
 *
 * @param enabledIdsFor - `(regionId) => string[]`, the user's roster choice. The
 *   shim needs it so `GET /v1/models` — the endpoint the picker's discovery
 *   reads — narrows the catalog the same way the adapter does.
 * @returns the runtime plus its shim, or `undefined` when the shim could not
 *   listen (the region is then simply absent rather than fatal).
 */
async function startRegion(region, ctx, enabledIdsFor) {
  const runtime = new RegionRuntime(region, ctx)

  // A region is published only when it can actually answer. Registering a
  // provider whose sign-in is missing or expired puts a dead route in the model
  // picker: selecting it sends a request the gateway answers with 403, which
  // the UI reports as "the provider rejected this request" — blaming the user's
  // account for a channel this plugin should never have offered. Skipping the
  // region leaves the other one working and the picker honest.
  let credential
  try {
    credential = await runtime.resolveCredential()
  } catch (error) {
    ctx.logger.warn(
      `dsh-connect-qoder: ${region.displayName} sign-in is unusable; region not registered`,
      error,
    )
    return undefined
  }
  if (credential === undefined) {
    ctx.logger.info(
      `dsh-connect-qoder: ${region.displayName} has no local sign-in; region not registered`,
    )
    return undefined
  }
  if (credential.expired === true) {
    ctx.logger.warn(
      `dsh-connect-qoder: ${region.displayName} sign-in has expired; region not registered ` +
        `(open the ${region.displayName} app to renew it, then restart DSH)`,
    )
    return undefined
  }

  const shim = createQoderShim({
    region,
    resolveCredential: () => runtime.resolveCredential(),
    resolveModels: () => runtime.catalog.current(),
    resolveUpstreamKey: (id) => runtime.upstreamKey(id),
    resolveAlwaysThinking: (id) => runtime.entryFor(id)?.alwaysThinking === true,
    // Read on every listing so curating the roster reaches the picker live.
    resolveEnabledIds: () => enabledIdsFor(region.id),
    // A sign-in failure from the upstream means the cached credential is
    // stale; the next resolveCredential re-reads the app's store.
    invalidateCredential: () => runtime.invalidateCredential(),
    logger: ctx.logger,
  })
  try {
    await shim.ready
  } catch (error) {
    ctx.logger.error(`dsh-connect-qoder: ${region.displayName} loopback endpoint failed to start`, error)
    return undefined
  }
  return { runtime, shim }
}

/**
 * Register every Qoder region.
 *
 * All regions are published through one adapter and one registration pair:
 * `registerAdapter` maps a set of providers onto a single adapter, so calling
 * it once per region would leave only the last provider owned.
 *
 * Activation is best-effort by design: this plugin contributes optional model
 * routes, and a failure to do so must never take the profile down with it. The
 * whole body is therefore guarded, so a fault here degrades to "Qoder models
 * are absent" rather than a profile that cannot boot.
 *
 * @param ctx - the plugin context, with `llm` injected.
 * @param config - the resolved plugin configuration.
 */
export async function apply(ctx, config = {}) {
  try {
    await activate(ctx, config)
  } catch (error) {
    ctx.logger.error('dsh-connect-qoder: activation failed; Qoder models will be unavailable', error)
  }
}

/** The real activation sequence, called under {@link apply}'s guard. */
async function activate(ctx, config) {
  // The context-window, image, and roster preferences are read through a mutable
  // holder so the settings section can change them without re-registering the
  // adapter; the adapter re-reads them every time it builds a model list, and the
  // shim re-reads them on every listing. The resolved config is the initial value.
  //
  // The section can hand the plugin a LIVE source (a `() => T` closure or a
  // `{ get(): T }` reference to the settings document) instead of a frozen
  // value. Reading `preferences` directly after such a hand-off would keep the
  // startup copy forever; `current()` resolves the live source at read time.
  //
  // The DEFAULT source re-reads the Config object the Loader hands `apply` on
  // every access. On the 0.1.7 line that object is live: its `asVolatile`
  // fields hold `{ get() }` references that the Loader's `_commitVolatile`
  // swaps in place after every `settings.mutate` (same shape as the host's own
  // `plainOptions(config)` in dsh-llm-deepseek). The installSection hosts
  // (0.1.6) replace the source with their document reference through the
  // `setSource` callback instead.
  let preferences = { ...config }
  const livePreferences = () => {
    const next = { ...config }
    for (const [key, value] of Object.entries(next)) {
      if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        next[key] = value.get()
      }
    }
    return next
  }
  let preferencesSource = livePreferences
  let invalidateAdapter = () => {}

  /** Resolve the live preferences, unwrapping a 0.1.7 live-reference source. */
  const current = () => {
    let source = preferencesSource()
    if (source !== null && typeof source === 'object' && typeof source.get === 'function') {
      source = source.get()
    }
    if (source === undefined || source === null) return preferences
    if (typeof source === 'object' && Object.prototype.toString.call(source) === '[object Object]') {
      return { ...preferences, ...source }
    }
    return preferences
  }

  /**
   * The three settings taking effect needs the picker to rebuild: `invalidate`
   * re-snapshots the model list, and the emit is what makes every reader of the
   * catalog — DSH's model picker included — drop the stale copy.
   */
  const refreshPicker = () => {
    invalidateAdapter()
    ctx.emit('llm/adapters-updated')
  }

  /** The models the user enabled for one region; empty means "no filter". */
  const enabledIdsFor = (regionId) => {
    const byRegion = current().enabledModelIds
    if (byRegion === null || typeof byRegion !== 'object') return []
    const list = byRegion[regionId]
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id.length > 0) : []
  }

  const started = []
  for (const region of REGIONS) {
    const entry = await startRegion(region, ctx, enabledIdsFor)
    if (entry !== undefined) started.push(entry)
  }
  if (started.length === 0) {
    ctx.logger.warn('dsh-connect-qoder: no Qoder region could start')
    return
  }

  const { adapter, invalidate } = createQoderAdapter({
    regions: started.map(({ runtime, shim }) => ({
      region: runtime.region,
      shim,
      catalog: () => runtime.catalog.current(),
    })),
    preferMaximumContext: () => current().useMaximumContextWindow === true,
    imageModeFor: (modelId) => {
      const overrides = current().imageOverrides
      if (overrides === null || typeof overrides !== 'object') return 'auto'
      const saved = overrides[modelId]
      return saved === 'on' || saved === 'off' ? saved : 'auto'
    },
    enabledIdsFor,
    // Image input must be wired or every request carrying an image fails the
    // whole turn with UNSUPPORTED_CONTENT. Both services are optional by
    // contract (`ctx.get` + undefined check), so a host without them keeps
    // working for text-only turns and simply cannot accept images — the same
    // graceful degradation the official llm-pi-ai plugin has.
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(
        attachments,
        (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
        ref,
      ),
  })
  invalidateAdapter = invalidate
  for (const { runtime } of started) {
    runtime.invalidate = () => {
      invalidate()
      ctx.emit('llm/adapters-updated')
    }
  }

  let releaseAdapter
  let releaseDirectory
  try {
    releaseAdapter = ctx.llm.registerAdapter(
      started.map(({ runtime }) => runtime.region.id),
      adapter,
    )
    releaseDirectory = ctx.llm.registerConfigurableProviders(
      started.map(({ runtime }) => ({
        provider: runtime.region.id,
        displayName: runtime.region.displayName,
        settingsNs: QODER_SETTINGS_NS,
        settingsPath: [],
        declared: false,
      })),
    )
  } catch (error) {
    releaseAdapter?.()
    releaseDirectory?.()
    for (const { shim } of started) shim.close()
    ctx.logger.error('dsh-connect-qoder: provider registration failed', error)
    return
  }

  ctx.effect(() => () => {
    releaseAdapter?.()
    releaseDirectory?.()
    for (const { runtime, shim } of started) {
      // Mark the runtime dead before clearing anything: an in-flight
      // `refreshCatalog().then` that races this dispose can still run and
      // would otherwise install a fresh `setInterval` onto the dead runtime.
      runtime.disposed = true
      if (runtime.refreshTimer !== undefined) clearInterval(runtime.refreshTimer)
      shim.close()
    }
  })

  // Publish the settings section. Without this the namespace a provider
  // directory entry points at would hold no schema, and no configuration
  // surface could render a control for this route — context-window choice
  // included. The section is optional: a host without a settings service still
  // gets working models, just no configuration surface.
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    try {
      // FIX 0.1.7: the settings service replaced `installSection` with a
      // configure() auto-form on the 0.1.7 rewrite. Probe both (neither throws
      // on absence) so one build spans 0.1.6 and 0.1.7. Without a served
      // section the client card is registered but never rendered.
      //
      // 0.1.7 live-config: `configure({auto:true})` only registers the
      // auto-form presentation — it does NOT hand the plugin a live source
      // (there is no `setSource` on that line). The live seam on 0.1.7 is the
      // Config object the Loader hands `apply`, whose volatile fields are
      // updated in place by the Loader after every `settings.mutate` and
      // announced with `loader/volatile-update`. The default
      // `preferencesSource` therefore re-reads that live object on every
      // access (above), and the listener below refreshes the picker when the
      // event lands. The installSection hosts (0.1.6) replace the source with
      // their document reference through `setSource` instead.
      if (typeof settings.configure === 'function') {
        settings.configure({ auto: true }, ctx.fiber)
      } else if (typeof settings.installSection === 'function') {
        settings.installSection(ctx, QODER_SETTINGS_NS, QODER_SECTION, config, {
          setSource(source) {
            preferencesSource = source
            // Install the live source and fold in its current value at once.
            // A source that has not been resolved yet degrades to the startup
            // preferences, so a half-handoff never blanks a field.
            const next = current()
            if (next !== preferences) preferences = next
            refreshPicker()
          },
          onChange() {
            refreshPicker()
          },
        })
      }
    } catch (error) {
      ctx.logger.warn('dsh-connect-qoder: settings section unavailable', error)
    }
  })

  // 0.1.7 dispatches `loader/volatile-update` on the plugin fiber after a
  // settings write updates the live config references in place — that is the
  // live seam the configure() auto-form relies on. `current()` now re-reads
  // those references, so re-snapshotting `preferences` here and refreshing the
  // picker is what makes a card save reach the running adapter without a DSH
  // restart. Optional chaining: hosts before 0.1.7 have no such event (or no
  // `ctx.on` at all), and there the installSection callbacks above already do
  // this.
  ctx.on?.('loader/volatile-update', () => {
    const next = current()
    if (next !== preferences) preferences = next
    refreshPicker()
  })

  // The settings card needs the live model roster to render one row per model,
  // and it cannot read the host catalog directly. This route is the only path,
  // so it is mounted on the optional webServer context and answers with the
  // catalog the adapter already holds — metadata only, never a credential.
  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.webServer.register({
        kind: 'exact',
        path: QODER_MODELS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
          if (!loopbackRequest(req)) return sendJson(res, 403, { error: 'origin-not-trusted' })
          // `refresh=1` re-reads the catalog from upstream. It matters because
          // both the roster and the rates move on their own: Qoder adds and
          // retires models, and an off-peak discount flips the effective price
          // at 22:00 and 08:00 Asia/Shanghai. Without this the picker would
          // keep showing whatever was true at process start.
          const force = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('refresh') === '1'
          if (force) {
            for (const { runtime } of started) {
              try {
                await runtime.refreshCatalog(true)
              } catch (error) {
                // A refresh failure must not blank the card: the last good
                // catalog is still served below.
                ctx.logger.warn(
                  `dsh-connect-qoder: ${runtime.region.displayName} catalog refresh failed`,
                  error,
                )
              }
            }
          }
          const now = new Date()
          const models = []
          for (const { runtime } of started) {
            for (const entry of runtime.catalog.current()) {
              models.push({
                id: entry.id,
                name: entry.name,
                region: runtime.region.id,
                regionName: runtime.region.displayName,
                isVL: entry.isVL === true,
                // The raw catalog multiplier, kept for reference.
                priceFactor: Number(entry.priceFactor) || 0,
                // Free models display 免费 instead of x0.00 in the picker;
                // `toPiModel` also uses this flag directly.
                isFree: entry.isFree === true,
                // Whether the Qoder app starts on this model by default.
                isDefault: entry.isDefault === true,
                // The multiplier that applies right now, with the off-peak
                // window resolved — this is what the picker appends to the name.
                effectiveRate: rateNow(entry, now),
                offPeakActive: offPeakActive(entry, now),
                ...(entry.promotion !== undefined
                  ? {
                      promotion: {
                        badge: entry.promotion.badge,
                        description: entry.promotion.description,
                        windowStart: entry.promotion.windowStart,
                        windowEnd: entry.promotion.windowEnd,
                        discountFactor: entry.promotion.discountFactor,
                        beforePromotionPriceFactor: entry.promotion.beforePromotionPriceFactor,
                        remainingSeconds: offPeakRemaining(entry, now),
                      },
                    }
                  : {}),
              })
            }
          }
          const overrides = current().imageOverrides
          const enabled = current().enabledModelIds
          sendJson(res, 200, {
            models,
            imageOverrides: overrides !== null && typeof overrides === 'object' ? overrides : {},
            useMaximumContextWindow: current().useMaximumContextWindow === true,
            enabledModelIds: enabled !== null && typeof enabled === 'object' ? enabled : {},
            refreshedAt: Date.now(),
          })
        },
      })
    } catch (error) {
      ctx.logger.warn('dsh-connect-qoder: model route unavailable', error)
    }
  })

  // The card's save button writes through this authoritative Host endpoint
  // (same pattern as the WorkBuddy bundle's `__save`): the settings document
  // lives in the Host process, and on DSH 0.1.7 the client-side
  // `settingsScope.set()` can settle WITHOUT persisting — the Host's
  // atomic-write retries exhaust on a locked file, the scope reloads Host
  // state, and returns success anyway. A read-back check catches that, but
  // the only writer that actually lands the value there is a mutate executed
  // inside the Host process.
  ctx.inject(['webServer', 'settings'], (webCtx) => {
    try {
      webCtx.webServer.register({
        kind: 'exact',
        path: QODER_SAVE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
          if (!loopbackRequest(req)) return sendJson(res, 403, { error: 'origin-not-trusted' })
          const settings = webCtx.get?.('settings')
          if (settings === undefined) {
            return sendJson(res, 503, { error: 'settings service unavailable to this fiber' })
          }
          try {
            const body = await new Promise((resolve, reject) => {
              const chunks = []
              let size = 0
              const MAX_BODY_BYTES = 64 * 1024 // 64 KiB: the settings payload is small
              req.on('data', (chunk) => {
                size += chunk.length
                if (size > MAX_BODY_BYTES) {
                  reject(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`))
                  req.destroy()
                  return
                }
                chunks.push(chunk)
              })
              req.on('end', () => {
                try {
                  resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
                } catch (error) {
                  reject(error)
                }
              })
              req.on('error', reject)
            })
            const field = body?.field
            const shape = QODER_SAVE_FIELDS[field]
            if (shape === undefined) {
              return sendJson(res, 400, { error: `field must be one of ${Object.keys(QODER_SAVE_FIELDS).join(', ')}` })
            }
            const rows = settings.describe()
            // On 0.1.7 the settings service keys a provider's document by the
            // provider name (`llm-qoder`), not the plugin namespace
            // (`dsh-connect-qoder`). Match either so both host generations
            // resolve the row.
            const row =
              rows.find((entry) => String(entry.ns) === QODER_SETTINGS_NS) ??
              rows.find((entry) => String(entry.ns) === name) ??
              rows.find((entry) => String(entry.ns).includes(QODER_SETTINGS_NS)) ??
              rows.find((entry) => String(entry.ns).includes(name))
            if (row === undefined) {
              return sendJson(res, 503, {
                error: `${QODER_SETTINGS_NS}/${name} namespace missing from describe(); known: ${rows
                  .map((entry) => String(entry.ns))
                  .join(', ')}`,
              })
            }
            const incoming = body.value
            const live = () => {
              let value = row.value?.[field]
              if (value !== null && typeof value === 'object' && typeof value.get === 'function') value = value.get()
              return value
            }
            let merged
            if (shape === 'regions') {
              const stored = live()
              const base = stored !== null && typeof stored === 'object' ? stored : {}
              const target = incoming !== null && typeof incoming === 'object' ? incoming : {}
              merged = { ...base, ...target }
            } else {
              merged = incoming
            }
            await settings.mutate(row.ns, [{ op: 'set', path: [field], value: merged }], undefined)
            // Read the value back and verify it actually landed. On the 0.1.7 line
            // a `mutate` can settle without persisting (the host atomic-write
            // retries exhaust on a locked file and the document is reloaded), so
            // "the call returned" is not proof the value is in the document.
            // Read it back and deep-compare: a mismatch means the write did not
            // land, which the client must treat as a failure, not a success.
            const readBackRow = settings
              .describe()
              .find((entry) => String(entry.ns) === row.ns)
            let readBack = readBackRow?.value?.[field]
            // Unwrap a volatile live-reference, same as `live()` above, so the
            // comparison is against the value the host actually holds, not the
            // `{ get() }` shell.
            if (readBack !== null && typeof readBack === 'object' && typeof readBack.get === 'function') {
              readBack = readBack.get()
            }
            if (!isDeepStrictEqual(readBack, merged)) {
              // The write did not land. Do not update `preferences` (which would
              // make the picker show a value that is not actually stored) and do
              // not call `refreshPicker` (which would fan out a false state).
              // The client's read-back path already treats this as a failure and
              // will not show "saved".
              return sendJson(res, 200, {
                ok: false,
                errorName: 'read-back-mismatch',
                error: 'settings.mutate returned but the value did not land in the document',
                value: merged,
                readBack,
              })
            }
            // `settings.mutate` already persisted the value and (on the 0.1.7
            // line) reconciles the Loader entry, which updates the live config
            // reference and dispatches `loader/volatile-update` — the listener
            // above refreshes the picker from that. This is belt-and-braces for
            // a host whose mutate does not dispatch the event: fold the merged
            // value into the base snapshot so `current()` sees it immediately.
            Object.assign(preferences, { [field]: merged })
            refreshPicker()
            sendJson(res, 200, { ok: true, value: merged, readBack })
          } catch (error) {
            const err = error
            sendJson(res, 500, {
              ok: false,
              errorName: err?.name ?? 'unknown',
              error: err?.message ?? String(error),
            })
          }
        },
      })
    } catch (error) {
      ctx.logger.warn('dsh-connect-qoder: save route unavailable', error)
    }
  })

  // The usage panel needs the same treatment: the quota lives upstream behind a
  // bearer token the browser must never hold, so the host reads it and hands the
  // card a credential-free summary. Each region is read independently and a
  // failing region is reported as unavailable rather than failing the panel, so
  // one dead sign-in cannot hide the other region's numbers.
  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.webServer.register({
        kind: 'exact',
        path: QODER_USAGE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
          if (!loopbackRequest(req)) return sendJson(res, 403, { error: 'origin-not-trusted' })
          const force = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('refresh') === '1'
          const regions = await Promise.all(
            started.map(async ({ runtime }) => {
              const base = {
                region: runtime.region.id,
                regionName: runtime.region.displayName,
                manageUrl: runtime.region.manageUrl,
              }
              try {
                const usage = await runtime.readUsage(force)
                return usage === undefined ? { ...base, available: false } : { ...base, available: true, ...usage }
              } catch (error) {
                ctx.logger.warn(
                  `dsh-connect-qoder: ${runtime.region.displayName} usage read failed`,
                  error,
                )
                return { ...base, available: false }
              }
            }),
          )
          sendJson(res, 200, { regions })
        },
      })
    } catch (error) {
      ctx.logger.warn('dsh-connect-qoder: usage route unavailable', error)
    }
  })

  // Load credentials and catalogs without blocking activation: the providers
  // are registered either way, and an empty catalog is how DSH hides a model
  // group until a sign-in appears.
  for (const { runtime } of started) {
    void runtime.refreshCatalog(true).then(() => {
      // The first refresh may still be in flight when the fiber disposes
      // (disable, hot reload, upgrade). Without this guard the timer
      // installs onto a dead runtime and is never cleared again — a zombie
      // credential-resolution loop that outlives the plugin.
      if (runtime.disposed) return
      runtime.refreshTimer = setInterval(() => {
        void runtime.refreshCatalog(true)
      }, CATALOG_TTL_MS)
      runtime.refreshTimer.unref?.()
    })
  }
}
