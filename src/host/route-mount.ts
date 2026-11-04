/**
 * Mounting the card routes, as one decision instead of seven.
 *
 * @module dsh-connect-qoder/route-mount
 */
import { rememberRouteRelease } from './lifecycle.ts'
import type { RouteRelease } from './lifecycle.ts'

/** What one `webServer.register({ … })` call takes. */
export interface RouteSpec {
  /** The loopback path this route answers on. */
  path: string
  /** The request handler, already bound to everything it needs. */
  handler: (req: never, res: never) => unknown
}

/** The `webServer` surface this module needs — a structural minimum, not the host's type. */
export interface RouteRegistrar {
  register: (route: { kind: string; path: string; handler: unknown }) => unknown
}

/** The logger subset used for the failure line. */
export interface MountLogger {
  warn?: (message: string, error?: unknown) => void
}

/** What one mount attempt did, for the caller's own bookkeeping. */
export interface MountResult {
  /** How many routes are registered and remembered for dispose. */
  registered: number
  /** The paths that made it in, in registration order. */
  paths: string[]
}

/**
 * Register a GROUP of routes that are meant to stand or fall together.
 *
 * The grouping is the point: a card that can read its account state but not
 * re-read it or confirm it looks alive and silently does nothing on two of
 * its buttons — the silent-failure shape of
 * docs/issues/16-silent-failure-policy.md
 *
 * So a group is all-or-nothing: if any registration throws, every release the
 * group already obtained is run before returning, and the caller is told the
 * group failed. Each release runs inside its own `try`, so one that throws
 * cannot strand the ones after it and leak them.
 *
 * @param registrar - the `webServer` service, already obtained by the caller.
 * @param routes - the routes to mount, in order.
 * @param sink - the array collecting releases for this fiber.
 * @param logger - where the failure line goes; optional, like the host's.
 * @returns what the attempt registered, or `[]` if the group failed.
 */
export function mountRouteGroup(
  registrar: RouteRegistrar,
  routes: RouteSpec[],
  sink: RouteRelease[],
  logger?: MountLogger,
): MountResult {
  const paths: string[] = []
  const taken: RouteRelease[] = []
  for (const route of routes) {
    let result: unknown
    try {
      result = registrar.register({ kind: 'exact', path: route.path, handler: route.handler })
    } catch (error) {
      // Roll the group back before reporting: a half-mounted group answers some
      // requests and 404s the rest, and the card cannot tell that apart from a
      // host that never served these routes at all.
      releaseTaken(taken, logger, route.path)
      logger?.warn?.(
        `dsh-connect-qoder: ${route.path} route unavailable; the routes mounted with it were released too`,
        error,
      )
      return { registered: 0, paths: [] }
    }
    // `rememberRouteRelease` collects into `taken`; the return value is only
    // consulted to learn whether there WAS anything to collect. Pushing the
    // release a second time here would store it twice and run it twice on
    // dispose — the exact double-release this module exists to make careful.
    rememberRouteRelease(taken, result)
    paths.push(route.path)
  }
  // Only now, with the whole group up, does it become the fiber's business.
  // Pushing into `sink` per-route would make a failed group unreleasable.
  sink.push(...taken)
  return { registered: paths.length, paths }
}

/**
 * Run the releases a failed group collected, without letting one strand the
 * next.
 */
function releaseTaken(taken: RouteRelease[], logger: MountLogger | undefined, failedPath: string): void {
  for (const release of taken) {
    try {
      release()
    } catch (error) {
      // Nothing to recover and nowhere to report it to — the group is already
      // being reported as failed, and dispose is not a place a user can act.
      logger?.warn?.(
        `dsh-connect-qoder: releasing the ${failedPath} route group's earlier registration failed`,
        error,
      )
    }
  }
  taken.length = 0
}
