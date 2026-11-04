/**
 * The sign-in conversation a user actually has: start one, poll it, cancel it.
 *
 * The probe (`probe/qoder-device-login.mjs`) proved the protocol by driving it
 * to completion in a single process. This module is the same protocol split
 * into the steps a browser can drive — because the alternative, a Host that
 * holds the request open for up to five minutes waiting for the user to tap
 * "authorize", would tie up a route per attempt and lose the attempt entirely
 * if the panel was closed or DSH restarted.
 *
 * So the session lives here, in memory, keyed by region, and the card polls it
 * every two seconds (`POLL_MS` in `src/client/device-login-panel.tsx`).
 * Nothing about the pending session is written to disk: a
 * half-finished sign-in is not worth surviving a restart, and the verifier is a
 * secret that does not need a persistence story. An attempt that is never
 * finished ages out instead.
 *
 * The module knows nothing about vaults or credentials. It answers one
 * question — "has this attempt been authorized yet, and if not, why not" — and
 * hands what it obtains to its caller, which is what makes the flow itself
 * testable without a Host, a disk, or a network.
 */
import {
  buildAuthUrl,
  createDeviceSession,
  pollOnce,
  productForRegion,
  type DeviceSession,
  type DeviceTokenPayload,
} from './device-login.ts'

/**
 * How long one attempt stays alive before the user is asked to start again.
 *
 * The service's own window is what this mirrors; the probe's default is the
 * same five minutes. It is enforced host-side rather than left to the card so
 * that a card which stops polling — closed tab, reloaded panel — cannot leave a
 * session behind forever.
 */
export const LOGIN_ATTEMPT_TTL_MS = 5 * 60 * 1000

export type StartResult =
  | { kind: 'started'; region: string; authUrl: string; expiresAt: number }
  | { kind: 'unsupported-region' }

export type PollResult =
  /** No attempt is in flight for this region: the card is polling something stale. */
  | { kind: 'idle' }
  /** Nobody has approved yet. Keep waiting. */
  | { kind: 'pending' }
  /** Approved and handed to the caller to store. */
  | { kind: 'authorized' }
  /** The attempt outlived its window; the user must start again. */
  | { kind: 'expired' }
  /** Approving failed, or the credential could not be stored. */
  | { kind: 'failed'; reason: string }
  | { kind: 'unsupported-region' }

interface Attempt {
  session: DeviceSession
  startedAt: number
}

export interface DeviceLoginFlowDeps {
  /**
   * Store what an approved attempt obtained.
   *
   * Awaited, and its rejection is reported as a failure rather than swallowed:
   * an attempt that succeeds at the service but cannot be written down has not
   * signed the user in, and saying "signed in" there would be exactly the false
   * confirmation the red line forbids.
   */
  onAuthorized: (regionId: string, payload: DeviceTokenPayload, machineID: string) => Promise<void>
  fetchImpl?: typeof fetch
  now?: () => number
  ttlMs?: number
  logger?: { warn?: (message: string) => void }
}

export class DeviceLoginFlow {
  private readonly attempts = new Map<string, Attempt>()
  private readonly deps: DeviceLoginFlowDeps
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(deps: DeviceLoginFlowDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? LOGIN_ATTEMPT_TTL_MS
  }

  /** Whether an attempt is in flight for a region. Read by the account panel. */
  pending(regionId: string): boolean {
    return this.live(regionId) !== undefined
  }

  /**
   * Begin an attempt, replacing any previous one for the region.
   *
   * Replacing rather than refusing is deliberate: a user whose first window
   * expired has no other way forward than to ask again, and two live verifiers
   * for one region would make "which one is being polled" ambiguous.
   */
  start(regionId: string): StartResult {
    const product = productForRegion(regionId)
    if (product === undefined) return { kind: 'unsupported-region' }
    const session = createDeviceSession(regionId)
    const startedAt = this.now()
    this.attempts.set(regionId, { session, startedAt })
    return {
      kind: 'started',
      region: regionId,
      authUrl: buildAuthUrl(product, session),
      expiresAt: startedAt + this.ttlMs,
    }
  }

  /**
   * One poll. The card calls this on its own cadence and decides when to stop.
   *
   * A single poll rather than a loop inside: the card already owns a timer, and
   * a loop here would make "the user closed the panel" and "the service is
   * slow" indistinguishable to the code trying to end the attempt.
   */
  async poll(regionId: string): Promise<PollResult> {
    const attempt = this.live(regionId)
    if (attempt === undefined) {
      // Distinguish "aged out" from "never started": only the first is worth a
      // sentence to the user, and only the second happens on a stale card.
      return this.attempts.has(regionId) ? { kind: 'expired' } : { kind: 'idle' }
    }
    const product = productForRegion(regionId)
    if (product === undefined) return { kind: 'unsupported-region' }

    const outcome = await pollOnce(product, attempt.session, this.deps.fetchImpl ?? fetch)
    if (outcome.kind === 'pending') return { kind: 'pending' }
    if (outcome.kind === 'failed') {
      this.attempts.delete(regionId)
      return { kind: 'failed', reason: outcome.name }
    }

    // Approved. The attempt is over either way: the code cannot be redeemed
    // twice, so leaving it in the map would only produce a confusing second
    // answer to a later poll.
    this.attempts.delete(regionId)
    try {
      await this.deps.onAuthorized(regionId, outcome.payload, attempt.session.machineID)
    } catch (error) {
      const reason = error instanceof Error && error.message !== '' ? error.message : 'the credential could not be stored'
      this.deps.logger?.warn?.(`dsh-connect-qoder: signed in but could not store the credential (${reason})`)
      return { kind: 'failed', reason }
    }
    return { kind: 'authorized' }
  }

  /** Drop an attempt without waiting for its TTL. Returns whether one existed. */
  cancel(regionId: string): boolean {
    return this.attempts.delete(regionId)
  }

  /** Drop every attempt, for dispose. */
  clear(): void {
    this.attempts.clear()
  }

  private live(regionId: string): Attempt | undefined {
    const attempt = this.attempts.get(regionId)
    if (attempt === undefined) return undefined
    if (this.now() - attempt.startedAt >= this.ttlMs) return undefined
    return attempt
  }
}
