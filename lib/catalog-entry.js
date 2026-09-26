/**
 * Catalog entry normalisation.
 *
 * Split out of `lib/index.js` for one concrete reason: this is pure data
 * reshaping with no Cordis context and no peer dependency, which makes it
 * directly importable from a test. It was previously a private function in the
 * plugin entry, and the contract test that guards it had to keep a hand-written
 * mirror in step by hand — which is precisely how the off-peak regression that
 * guard exists for survived, one layer further down (the host projection dropped
 * `promotion.active` and `promotion.timezone`, so the card's clock never ticked).
 *
 * A test that imports the real function cannot drift from it.
 *
 * @module dsh-connect-qoder/catalog-entry
 */

/**
 * A model id is the catalog display name with whitespace removed, so the id is
 * stable and readable; the upstream key is tracked beside it for the wire.
 */
function modelIdFor(entry) {
  return (entry.display_name || 'QoderModel').replace(/\s+/g, '')
}

/**
 * Reshape one entry from `fetchModels` for storage and lookup.
 *
 * The catalog interpretation (vision, reasoning, effort support, and the
 * always-thinking rule) already happened in `fetchModels`, so this only adds
 * the user-facing id.
 *
 * @param entry - one entry as `fetchModels` produced it.
 * @returns the stored catalog entry.
 */
export function normalizeEntry(entry) {
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
    //
    // Carried through verbatim, `active` and `timezone` included: the card
    // gates its ticking clock on `promotion.active` and resolves the window
    // against `timezone`, so losing either silently freezes the rate at whatever
    // it was when the card mounted.
    promotion: entry.promotion,
  }
}

/**
 * Project one stored catalog entry into the row the settings card renders.
 *
 * This is the second half of the off-peak regression, and the half that
 * actually broke: `normalizeEntry` carried the whole `promotion` block, but the
 * host route re-projected it field by field and left out `active` and
 * `timezone`. The card gates its ticking clock on `promotion?.active === true`,
 * so the gate was permanently false, the interval was never installed, the
 * clock stayed frozen at mount, and the 22:00 rate flip and countdown never
 * happened without a manual refresh — while the window and the rate still
 * rendered, which is what kept the failure invisible.
 *
 * It is a separate exported function, rather than inline in the route handler,
 * for the same reason `normalizeEntry` moved: the field list is exactly the kind
 * of thing that must be asserted against, not eyeballed.
 *
 * @param entry - one stored catalog entry.
 * @param region - `{ id, displayName }` for the region that owns it.
 * @param now - the instant the rates are resolved against.
 * @param rates - `{ rateNow, offPeakActive, offPeakRemaining }`, injected so
 *   this stays free of the adapter import.
 * @returns the row shape the card consumes.
 */
export function projectModelRow(entry, region, now, rates) {
  return {
    id: entry.id,
    name: entry.name,
    region: region.id,
    regionName: region.displayName,
    isVL: entry.isVL === true,
    // The raw catalog multiplier, kept for reference.
    priceFactor: Number(entry.priceFactor) || 0,
    // Free models display 免费 instead of x0.00 in the picker; `toPiModel` also
    // uses this flag directly.
    isFree: entry.isFree === true,
    // Whether the Qoder app starts on this model by default.
    isDefault: entry.isDefault === true,
    // The multiplier that applies right now, with the off-peak window resolved —
    // this is what the picker appends to the name.
    effectiveRate: rates.rateNow(entry, now),
    offPeakActive: rates.offPeakActive(entry, now),
    // The block is forwarded whole, `active` and `timezone` included. The card
    // gates its clock on `active` and resolves the window against `timezone`;
    // dropping either freezes the displayed rate at whatever it was when the
    // card mounted.
    ...(entry.promotion !== undefined
      ? { promotion: { ...entry.promotion, remainingSeconds: rates.offPeakRemaining(entry, now) } }
      : {}),
  }
}
