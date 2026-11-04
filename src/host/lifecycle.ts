/**
 * What a fiber must undo when it is disposed.
 *
 * @module dsh-connect-qoder/lifecycle
 */

/**
 * The release a `webServer.register(...)` call handed back, if it handed one
 * back at all.
 *
 * Typed as `() => void` rather than `Function` on purpose: the check below is
 * `typeof result === 'function'`, and a narrower element type is what lets
 * `sink.push(result)` typecheck without an assertion.
 */
export type RouteRelease = () => void

/** Remember a route registration's release so dispose can undo it; the host's
 * reclaim semantics are unreadable from a plugin, so only a callable result is
 * released — correct under both host behaviours. Incident: docs/issues/13-lifecycle-dispose.md.
 * @param sink - the array collecting releases for this fiber.
 * @param result - whatever `webServer.register(...)` returned.
 * @returns the release, or `undefined` when there was nothing to keep. */
export function rememberRouteRelease(
  sink: RouteRelease[],
  result: unknown,
): RouteRelease | undefined {
  if (typeof result === 'function') {
    sink.push(result as RouteRelease)
    return result as RouteRelease
  }
  return undefined
}

/**
 * Call every remembered release, tolerating a host that already reclaimed.
 *
 * All of them run even if one throws: a release that fails must not strand the
 * ones after it, because those are the ones holding the ports. Disposal
 * therefore never throws — it runs on the way out, and an exception there would
 * surface as a failed fiber cleanup in a place the user cannot act on.
 *
 * @param sink - the array collected by {@link rememberRouteRelease}.
 * @returns how many releases ran, for logging or a test.
 */
export function releaseRoutes(sink: RouteRelease[] | undefined): number {
  let released = 0
  for (const release of sink ?? []) {
    try {
      release()
      released += 1
    } catch {
      // Already reclaimed by the host, or a release that is not idempotent.
      // Either way there is nothing to recover and nothing to report.
    }
  }
  if (Array.isArray(sink)) sink.length = 0
  return released
}
