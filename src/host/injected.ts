/**
 * The one guard that converts an `inject` callback's promise into a type.
 *
 * Extracted from `activate()` (where it closed the loop over seven call sites)
 * so the guarantee it encodes is a test rather than a comment — the same
 * rule-by-extraction the repo already applies to `region-gate.ts`,
 * `publish-regions.ts` and `route-mount.ts`.
 *
 * THE GUARANTEE
 *
 * `ctx.inject(['webServer'], cb)` is Cordis's way of saying "do not call `cb`
 * until `webServer` exists" — so inside `cb` the service is present. That fact
 * lives in the `inject` call rather than in the type of `webCtx.webServer`
 * (which must stay optional: a Host without the service never runs this
 * callback at all, and `apply` still has to compile for it).
 *
 * Rather than sprinkle `!` at the seven registrations, or `?.` on code that
 * cannot be reached without the service, the guarantee is converted once per
 * call here. The throw is unreachable under a correct Host; it exists so that
 * a Host which fires the callback WITHOUT the service fails loudly at
 * activation instead of registering routes into `undefined` — the silent
 * shape red line 1 (AGENTS.md) forbids.
 *
 * @module dsh-connect-qoder/injected
 */

/**
 * Return the injected service, or throw naming the service when the Host ran
 * an `inject` callback without it.
 *
 * Only `undefined` is refused: the callers hand in values typed
 * `T | undefined`, and a present-but-falsy service (a host that answers with
 * `null`, say) is the host's own contract violation to keep, not this guard's
 * to reinterpret — rewriting it here would hide the host's answer.
 */
export function requireInjected<T>(service: T | undefined, name: string): T {
  if (service === undefined) {
    throw new Error(`dsh-connect-qoder: ctx.inject ran for '${name}' without the service`)
  }
  return service
}
