/**
 * The retry policy this plugin hands the host for every region route.
 *
 * The host runs its own retry loop on top of a provider failure, so this
 * route narrows the retryable SET to the failures along the loopback hop —
 * which the plugin cannot retry itself: an empty provider response, a stream
 * idle past `streamIdleTimeoutMs`, a transport failure between host and shim.
 *
 * `maxRetries` and `backoff` are deliberately NOT set: the host owns its
 * budget and its delays; narrowing the SET is the only decision that is ours.
 * Accident history: docs/issues/24-terminal-failure-status-codes.md
 */
export const ROUTE_RETRY_POLICY = {
  mode: 'normal' as const,
  retryableCodes: ['EMPTY_RESPONSE', 'TIMEOUT', 'TRANSPORT'],
}
