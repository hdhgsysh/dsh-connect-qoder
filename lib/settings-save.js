/**
 * The settings save pipeline.
 *
 * Extracted from the `__save` route in lib/index.js so it can be tested. The
 * route's whole reason for existing is a defect on the DSH 0.1.7 line: the
 * client-side `settingsScope.set()` can resolve successfully without persisting
 * anything — the host's atomic write exhausts its retries on a locked file, the
 * scope reloads the previous document, and success is reported anyway. The card
 * would then show "已保存" while the model roster, image overrides and context
 * window had all silently failed to change, with nothing to indicate it.
 *
 * So a write here is only a success once the value has been read back out of the
 * document and compared. That check, the per-region merge, and the namespace
 * resolution all lived inline in an HTTP handler where no test could reach them.
 * They are here now as a function of `(settings, body)` — no Cordis, no
 * framework, no request or response objects.
 *
 * @module dsh-connect-qoder/settings-save
 */

/**
 * The fields a save may write, and the merge rule each one uses.
 *
 * `regions` shape (`{ [regionId]: [...ids] }`): merge the incoming region keys
 * into the field's authoritative value, so saving one region's allow-list can
 * never delete the other region's. `whole` shape: replace the field outright
 * (the card always posts its complete value).
 */
export const SAVE_FIELDS = {
  enabledModelIds: 'regions',
  imageOverrides: 'whole',
  useMaximumContextWindow: 'whole',
}

/**
 * Find the settings row this plugin owns.
 *
 * On 0.1.7 the service keys a provider's document by the provider name
 * (`llm-qoder`), while 0.1.6 and earlier use the plugin namespace
 * (`dsh-connect-qoder`). Both are matched exactly, in that order.
 *
 * The substring fallbacks this replaced were a real hazard rather than a
 * theoretical one: `String(entry.ns).includes(name)` matches `llm-qoder-extra`,
 * and the save would then `mutate` a row belonging to something else. A
 * namespace that is not ours must produce no match, not a near one.
 *
 * @param rows - `settings.describe()`.
 * @param candidates - the namespaces to try, in priority order.
 * @returns the matching row, or `undefined`.
 */
export function findSettingsRow(rows, candidates) {
  for (const candidate of candidates) {
    const exact = rows.find((entry) => String(entry.ns) === candidate)
    if (exact !== undefined) return exact
  }
  return undefined
}

/**
 * Unwrap a volatile live reference.
 *
 * On 0.1.7 a volatile field holds `{ get() }` rather than a value, so reading
 * `row.value[field]` directly yields the shell. Comparing that shell to the
 * value that was written would always report a mismatch.
 *
 * @returns the resolved value, or whatever was stored.
 */
export function unwrapVolatile(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return value.get()
  }
  return value
}

/**
 * Merge an incoming value with what the document already holds.
 *
 * @param shape - `'regions'` or `'whole'`, from {@link SAVE_FIELDS}.
 * @param incoming - the value the card posted.
 * @param stored - the document's current value, already unwrapped.
 * @returns the value to write.
 */
export function mergeForShape(shape, incoming, stored) {
  if (shape !== 'regions') return incoming
  // Merge per region rather than replacing: the card posts one region at a
  // time, and a wholesale replace would delete the other region's allow-list.
  const base = stored !== null && typeof stored === 'object' ? stored : {}
  const target = incoming !== null && typeof incoming === 'object' ? incoming : {}
  return { ...base, ...target }
}

/**
 * Read a field back out of a row, unwrapping a volatile reference.
 *
 * @param row - a row from `settings.describe()`.
 * @param field - the field name.
 * @returns the value the host actually holds.
 */
export function readField(row, field) {
  return unwrapVolatile(row?.value?.[field])
}

/**
 * Write one field, then prove it landed.
 *
 * The return value is the route's whole contract: `{ ok: true }` only when the
 * value is readable out of the document afterwards. A `mutate` that resolves is
 * not evidence of anything on the 0.1.7 line, so the document is re-read and
 * deep-compared against what was written.
 *
 * @param options.settings - the host settings service.
 * @param options.field - which field to write.
 * @param options.value - the value the card posted.
 * @param options.candidates - namespaces to try, in priority order.
 * @param options.equals - deep equality, injected so this module stays free of
 *   `node:util`; defaults to a structural comparison.
 * @returns `{ status, body }` — the HTTP status and the JSON payload.
 */
export async function applySettingsSave({ settings, field, value, candidates, equals }) {
  // `Object.hasOwn` rather than a plain lookup: a bare `SAVE_FIELDS[field]`
  // reaches the prototype chain, so `field: 'constructor'` (or `toString`,
  // `__proto__`, …) yields a function, is not `undefined`, and walks straight
  // through this guard into `settings.mutate` and the preferences assign below.
  // `Object.keys` already used for the error message has the same exposure, so
  // the whitelist is read through one helper and both agree.
  if (typeof field !== 'string' || !Object.hasOwn(SAVE_FIELDS, field)) {
    return {
      status: 400,
      body: { error: `field must be one of ${Object.keys(SAVE_FIELDS).join(', ')}` },
    }
  }
  const shape = SAVE_FIELDS[field]

  const rows = settings.describe()
  const row = findSettingsRow(rows, candidates)
  if (row === undefined) {
    return {
      status: 503,
      body: {
        error: `${candidates.join('/')} namespace missing from describe(); known: ${rows
          .map((entry) => String(entry.ns))
          .join(', ')}`,
      },
    }
  }

  const merged = mergeForShape(shape, value, readField(row, field))
  await settings.mutate(row.ns, [{ op: 'set', path: [field], value: merged }], undefined)

  // Read the value back and verify it actually landed. On the 0.1.7 line a
  // `mutate` can settle without persisting, so "the call returned" is not
  // proof the value is in the document.
  const readBackRow = settings.describe().find((entry) => String(entry.ns) === row.ns)
  const readBack = readField(readBackRow, field)
  const same = equals ?? deepEqual
  if (!same(readBack, merged)) {
    // The write did not land. The caller must NOT fold this into its base
    // snapshot and must NOT refresh the picker, or the UI would show a value
    // that is not stored. The client treats this as a failure and will not
    // display "saved".
    return {
      status: 200,
      body: {
        ok: false,
        errorName: 'read-back-mismatch',
        error: 'settings.mutate returned but the value did not land in the document',
        value: merged,
        readBack,
      },
    }
  }

  return { status: 200, body: { ok: true, value: merged, readBack } }
}

/**
 * A structural deep-equality, used when the caller injects none.
 *
 * `node:util`'s `isDeepStrictEqual` is the real implementation used in
 * production; this exists so the module can be exercised without importing it,
 * and it is only ever reached when a test omits `equals`.
 */
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b)
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
}
