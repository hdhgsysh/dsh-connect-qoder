/**
 * What one catalog refresh does with its answer.
 *
 * Pure decision logic extracted from `RegionRuntime.doRefreshCatalog`
 * (lib/index.js), which a test checkout cannot import (Cordis peer deps).
 *
 * The rule: an answer is committed even when EMPTY — only a failure keeps the
 * previous catalog, and each failure names its own reason. Committed is not
 * persisted: a swallowed disk write is reported as a `persist` failure.
 *
 * @module dsh-connect-qoder/catalog-refresh
 */
import { REFRESH_FAILURE_REASONS } from './domain.ts'
import type { CatalogOutcome, RefreshableRuntime, RefreshFailure, RefreshFailureReason } from './domain.ts'
// Re-exported so this module keeps presenting one surface for the refresh rule,
// while the definition (and the type derived from it) lives in `domain.ts` —
// `domain.ts` is where the interface `RefreshFailure` needs it, and importing
// upward from here would be the cycle.
export { REFRESH_FAILURE_REASONS }

/**
 * Whether a refresh that finished after a dispose may still touch the runtime.
 *
 * `doRefreshCatalog` can be in flight when the fiber disposes — a plugin
 * toggle, a hot reload, an upgrade. The fetch already had its answer, and the
 * code that follows used to run anyway: `catalog.replace()` wrote to disk and
 * emitted `llm/adapters-updated` on a fiber that had been torn down. Neither is
 * catastrophic, and both are invisible — the failure shape this repository
 * keeps finding. The `disposed` flag could not prevent it, because it was only
 * consulted by the caller that installs the refresh TIMER, never by the refresh
 * itself.
 *
 * Pure so it can be asserted without a Cordis context: the scenario is a boolean
 * over two values, and both ways to get it wrong — checking before the await
 * rather than after, or checking on the failure path only — are silent.
 *
 * @param runtime - the runtime, carrying `disposed`.
 * @returns true when the runtime is gone and the result must be dropped.
 */
export function isRefreshObsolete(runtime: RefreshableRuntime | null | undefined): boolean {
  return runtime?.disposed === true
}

/**
 * Every reason the fold will record, as a value list plus a type guard.
 *
 * The list itself lives in `domain.ts` (the `RefreshFailure` interface needs it
 * and cannot import from here), and this is the runtime half: the union type
 * stops a bad reason at compile time for typed callers, and the guard stops one
 * arriving from an untyped edge — a `CatalogOutcome` built from parsed JSON, or
 * a test double.
 */
function refreshFailureReasonOf(reason: unknown): RefreshFailureReason {
  return REFRESH_FAILURE_REASONS.includes(reason as RefreshFailureReason)
    ? (reason as RefreshFailureReason)
    : 'fetch'
}

/**
 * Fold one refresh's outcome into a runtime.
 *
 * Split by outcome so each branch can be asserted on its own, because the bug
 * was a branch that did not exist at all.
 *
 * @param runtime - the target: `catalog` (anything with `replace`), plus the
 *   optional `invalidate` hook the picker refreshes through.
 * @param outcome - `{ ok: true, entries }` for an answer, or
 *   `{ ok: false, reason, error }` for a failure.
 * @returns `{ committed, previousFailure }` — whether the catalog was replaced,
 *   and the failure marker that was displaced (so a caller that owns the
 *   runtime can log the transition rather than only the end state).
 */
export function applyCatalogOutcome(
  runtime: RefreshableRuntime,
  outcome: CatalogOutcome,
): { committed: boolean; previousFailure: RefreshFailure | undefined } {
  const previousFailure = runtime.refreshFailed
  if (outcome.ok !== true) {
    // Kept, not overwritten: a failed refresh is a statement about THIS fetch,
    // and the previous catalog is the one still on screen.
    //
    // The reason is VALIDATED rather than stringified. It used to be
    // `String(outcome.reason ?? 'fetch')`, which accepted any value at all and
    // pushed the problem into the card: `refreshNoticeKey` answers its
    // `default` branch — the "temporary, try again" copy — for a reason it does
    // not recognise, so a typo or a new reason with no client copy would leave
    // the plugin telling the user to retry when the real answer was to update
    // the plugin. Falling back to `fetch` here is the conservative choice: it
    // claims the least.
    runtime.refreshFailed = { reason: refreshFailureReasonOf(outcome.reason), error: outcome.error }
    return { committed: false, previousFailure }
  }
  // Empty is a value. `replace([])` advances `fetchedAt`, so the TTL refreshes
  // and the card's "last fetched" stops aging as if nothing were known.
  //
  // `catalog` is optional on `RefreshableRuntime` (test stand-ins omit it), so
  // the commit is guarded rather than assumed. A runtime with no catalog has
  // nowhere to put the answer; it still gets `refreshFailed` cleared and the
  // invalidation below, which is all the notification such a runtime can use.
  runtime.catalog?.replace(outcome.entries)
  // A `replace()` advances the in-memory roster even when the disk write was
  // swallowed (`CatalogStore.save()` records the error and returns — a
  // read-only Home must not kill the panel). That divergence has to stay
  // visible: if the fold cleared the failure marker here, the card would stamp
  // "已更新" on a catalog the disk does not have and a restart would silently
  // revert it. The write error is surfaced as its own failure class — the rows
  // stay (they are the correct roster for this process; only the disk lagged).
  const persistError = runtime.catalog?.lastSaveError
  if (persistError !== undefined) {
    runtime.refreshFailed = { reason: 'persist', error: persistError }
  } else {
    runtime.refreshFailed = undefined
  }
  // Called unconditionally, including for the empty result: a group that has to
  // disappear from the picker must be re-advertised as having disappeared, or
  // DSH keeps routing to a provider that now offers nothing.
  runtime.invalidate?.()
  return { committed: true, previousFailure }
}
