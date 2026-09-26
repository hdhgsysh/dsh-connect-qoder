/**
 * Resolving the three settings this plugin offers.
 *
 * Extracted from `activate` in lib/index.js. The logic is pure — it takes a
 * configuration source and answers questions about it — but it was inlined in a
 * function that cannot be imported, so none of it was covered.
 *
 * Two of the three settings are read on every model build and on every listing,
 * so their resolution sits on the hot path of a card render. The interesting
 * part is the 0.1.7 live-reference shape: a volatile field holds `{ get() }`
 * rather than a value, and reading it directly yields the shell.
 *
 * @module dsh-connect-qoder/preferences
 */

/** The per-model image modes a saved override may hold. */
const IMAGE_MODES = ['on', 'off', 'auto']

/** The image mode used when nothing says otherwise. */
const DEFAULT_IMAGE_MODE = 'auto'

/**
 * Unwrap a 0.1.7 volatile live reference.
 *
 * @param value - a field value, possibly a `{ get() }` shell.
 * @returns the resolved value.
 */
export function unwrapReference(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return value.get()
  }
  return value
}

/**
 * Resolve the current settings, preferring a live source over a frozen snapshot.
 *
 * The source may be a plain object, a `{ get() }` reference to the settings
 * document, or a zero-argument function returning either — the three shapes the
 * 0.1.6 installSection and 0.1.7 configure lines hand over. A source that
 * resolves to nothing usable falls back to the snapshot rather than blanking
 * the card.
 *
 * @param snapshot - the last known-good values.
 * @param source - the live source, or `undefined`.
 * @returns the merged settings.
 */
export function resolvePreferences(snapshot, source) {
  let resolved = typeof source === 'function' ? source() : source
  resolved = unwrapReference(resolved)
  if (resolved === undefined || resolved === null) return snapshot
  // A plain-object test rather than `typeof === 'object'`: an array or a
  // Date is an object, and spreading one into the settings would produce keys
  // nobody asked for.
  if (Object.prototype.toString.call(resolved) !== '[object Object]') return snapshot
  return { ...snapshot, ...resolved }
}

/**
 * The models the user enabled for one region.
 *
 * An empty result means "no filter" rather than "nothing": a fresh install has
 * saved nothing and must still see every model. The same convention
 * `filterByEnabled` applies on the model side.
 *
 * @param preferences - the resolved settings.
 * @param regionId - the region to look up.
 * @returns the allow-list, or `[]` for no filter.
 */
export function enabledIdsFor(preferences, regionId) {
  const byRegion = unwrapReference(preferences?.enabledModelIds)
  if (byRegion === null || typeof byRegion !== 'object') return []
  // An own-property check, not a bare lookup: `byRegion['constructor']` yields
  // a function, and the `Array.isArray` filter below would pass it through as
  // "not a list" — fine today, but only because the values happen to be
  // functions. Reading the prototype chain here is relying on a coincidence.
  if (!Object.hasOwn(byRegion, regionId)) return []
  const list = byRegion[regionId]
  return Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id.length > 0) : []
}

/**
 * The user's image-input choice for one model.
 *
 * `'auto'` is the absence of an override, so a row in auto mode never writes a
 * key — the saved document stays minimal and a future catalog change is picked
 * up again. An unrecognised stored value degrades to `auto` rather than to
 * `off`: defaulting to off would silently drop image input for every model
 * after a settings format change.
 *
 * @param preferences - the resolved settings.
 * @param modelId - the model to look up.
 * @returns `'auto'`, `'on'`, or `'off'`.
 */
export function imageModeFor(preferences, modelId) {
  const overrides = unwrapReference(preferences?.imageOverrides)
  if (overrides === null || typeof overrides !== 'object') return DEFAULT_IMAGE_MODE
  if (!Object.hasOwn(overrides, modelId)) return DEFAULT_IMAGE_MODE
  const saved = overrides[modelId]
  return IMAGE_MODES.includes(saved) ? saved : DEFAULT_IMAGE_MODE
}

/**
 * Whether to advertise each model's largest declared context window.
 *
 * @param preferences - the resolved settings.
 * @returns true when the maximum-context switch is on.
 */
export function preferMaximumContext(preferences) {
  return unwrapReference(preferences?.useMaximumContextWindow) === true
}
