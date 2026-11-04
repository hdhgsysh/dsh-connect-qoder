/**
 * The plugin's own credential source: a token this plugin obtained by device
 * login, kept in a vault it owns, renewed with a refresh token it holds.
 *
 * The third source, and the only one that is both zero-configuration and
 * portable: the desktop login is machine-bound, a PAT is manual. Evidence:
 * docs/issues/21-device-login-credential-source.md
 *
 * A class because it must remember two things between calls: the last outcome
 * (the panel renders it) and that a renewal was just refused, which keeps a
 * doomed refresh from being retried on every request.
 */
import type { LoadedCredential } from './credentials.ts'
import type { CredentialVault, VaultRecord } from './credential-vault.ts'
import { productForRegion, refreshOnce, type DeviceTokenPayload } from './device-login.ts'

/**
 * How long a refused (or failed) renewal is honoured before trying again.
 *
 * This exists because `CredentialCache.resolve` runs on every request that
 * reaches the gateway. Without a window, a refresh token the service has
 * revoked would be re-POSTed once per chat turn — a rate-limit ending in a
 * lockout. The value matches `UNWRAP_FAILURE_TTL_MS` in `credentials.ts`, which
 * memoises the other unrecoverable failure in this same chain for the same
 * reason and the same length of time.
 */
export const REFRESH_FAILURE_TTL_MS = 60 * 1000

/**
 * What the panel should say about this source.
 *
 * Deliberately six states rather than two. "You have not signed in on this
 * machine" and "your credential file will not parse" send the user to different
 * places, so collapsing them into one "not signed in" is the failure this
 * repo's first red line is about: a silent, wrong explanation.
 */
export type DeviceCredentialStatus =
  /** No vault file: nobody has signed in through this plugin on this machine. */
  | { state: 'none' }
  /** A usable credential is available (possibly just renewed). */
  | { state: 'ok' }
  /** The record is there but the refresh token is spent: sign in again. */
  | { state: 'expired' }
  /** The service refused to renew, or the renewal could not be reached. */
  | { state: 'refresh-failed'; reason: string }
  /**
   * The renewal succeeded but the file refused it: this process holds a good
   * token that the disk does not. The session keeps running — but it dies at
   * the next restart, and a panel that said `ok` would be lying about that.
   */
  | { state: 'save-failed'; reason: string }
  /** A vault file exists but cannot be used; the file is the problem, not the sign-in. */
  | { state: 'unreadable'; reason: string }

/**
 * The `appName` a device credential reports.
 *
 * `LoadedCredential.appName` names where a credential was found — the PAT source
 * puts the environment variable's name there. There is no directory to name
 * here, so it names the source itself, which is what a diagnostic reader wants
 * to see.
 */
export const DEVICE_APP_NAME = 'device-login'

/**
 * The reason a `save-failed` state reports.
 *
 * Stable text, because the panel renders it verbatim as the note's detail —
 * like every other reason in this module, changing it is a copy change, not a
 * refactor.
 */
export const DEVICE_SAVE_FAILED_REASON = 'the renewed credential could not be written to its file'

export interface DeviceCredentialDeps {
  /** The plugin's region id: `qoder-cn` or `qoder`. */
  region: string
  /** The vault for this region. One source per region, never shared. */
  vault: CredentialVault
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Wall clock, injectable for tests. */
  now?: () => number
  logger?: { warn?: (message: string) => void }
}

/** The vault record as the request-signing payload the service expects. */
function payloadOf(record: VaultRecord): DeviceTokenPayload {
  return {
    token: record.token,
    refreshToken: record.refreshToken,
    expiresAt: record.expiresAt,
    refreshTokenExpiresAt: record.refreshTokenExpiresAt,
    userID: record.userID,
    name: record.name,
    email: record.email,
  }
}

/** The payload back into a record. `savedAt` moves because the file changed. */
function recordOf(payload: DeviceTokenPayload, machineID: string, savedAt: number): VaultRecord {
  return {
    token: payload.token,
    refreshToken: payload.refreshToken,
    expiresAt: payload.expiresAt,
    refreshTokenExpiresAt: payload.refreshTokenExpiresAt,
    userID: payload.userID,
    name: payload.name,
    email: payload.email,
    machineID,
    savedAt,
  }
}

/**
 * The record as the shape the rest of the plugin already consumes.
 *
 * Structural, not a conversion: `LoadedCredential` is what every downstream
 * layer reads, and a device credential differs from an app credential only in
 * its `source` tag and in who can renew it.
 */
function credentialOf(record: VaultRecord, region: string, now: number): LoadedCredential {
  return {
    region,
    appName: DEVICE_APP_NAME,
    userID: record.userID,
    name: record.name,
    email: record.email,
    token: record.token,
    refreshToken: record.refreshToken,
    refreshTokenExpiresAt: record.refreshTokenExpiresAt,
    expiresAt: record.expiresAt,
    // The app source carries a flag its own store computed. Here the clock is
    // the only authority, and the record's expiry is the issuer's own word.
    expired: Number(record.expiresAt) <= now,
    userType: '',
    userTag: '',
    machineID: record.machineID,
    source: 'device',
    plan: undefined,
    usage: undefined,
  }
}

/**
 * One region's device credential, renewed when its access token has lapsed.
 */
export class DeviceCredentialSource {
  private readonly region: string
  private readonly vault: CredentialVault
  private readonly fetchImpl: typeof fetch | undefined
  private readonly now: () => number
  private readonly logger: { warn?: (message: string) => void } | undefined
  private last: DeviceCredentialStatus = { state: 'none' }
  /** When a renewal was last refused/failed, and what the service said. */
  private refusedAt: number | undefined
  private refusedReason = ''
  /**
   * The last record this process renewed but could not write to disk.
   *
   * Exists for `save-failed`: the disk copy is already spent, so without this
   * every cache miss after the failed write would re-post the refresh — a
   * request storm over a storage problem. Cleared when a write lands, when the
   * disk shows bytes at least as new, or when a sign-out deletes the file.
   */
  private memRecord: VaultRecord | undefined

  constructor({ region, vault, fetchImpl, now = () => Date.now(), logger }: DeviceCredentialDeps) {
    this.region = region
    this.vault = vault
    this.fetchImpl = fetchImpl
    this.now = now
    this.logger = logger
  }

  /** What the panel should say; reflects the most recent {@link load}. */
  get status(): DeviceCredentialStatus {
    return this.last
  }

  /**
   * Forget the failure window, so the next `load` tries again.
   *
   * Called on the same signal that invalidates the credential cache (a request
   * came back rejected). Without it, a credential the user has just fixed by
   * signing in again would stay invisible for the rest of the window — the same
   * mistake, from the other side, that the window exists to prevent.
   */
  retry(): void {
    this.refusedAt = undefined
    this.refusedReason = ''
  }

  /**
   * Store what a completed sign-in obtained, and make it usable at once.
   *
   * Rejects when the file could not be written. The caller is the sign-in flow,
   * which turns that into "signed in but could not store it" — the alternative,
   * resolving `undefined` and calling it a success, would hand the user a
   * session that silently vanishes at the next restart.
   */
  async remember(payload: DeviceTokenPayload, machineID: string): Promise<void> {
    const record = recordOf(payload, machineID, this.now())
    const stored = await this.vault.update(() => record)
    if (!stored) throw new Error(`the credential file ${this.vault.path} could not be written`)
    this.retry()
    this.last = { state: 'ok' }
  }

  /**
   * Delete the saved credential: this machine is signed out.
   *
   * Goes through the vault's serialised `clear` rather than around it, so a
   * renewal that has already read the record cannot write it back after the
   * sign-out lands — the resurrection the vault's chain exists to prevent.
   *
   * Answers whether the file is gone. `false` is reported as a failure rather
   * than smoothed over: telling someone they are signed out while the
   * credential is still on disk is a false confirmation, and it is also what
   * would make the next resolve quietly sign them back in.
   */
  async forget(): Promise<boolean> {
    this.retry()
    const cleared = await this.vault.clear()
    if (cleared) {
      // The in-memory copy of a rotation the disk refused goes with the file:
      // a signed-out machine must have nothing left to serve.
      this.memRecord = undefined
      this.last = { state: 'none' }
    }
    return cleared
  }

  /**
   * The credential to sign a request with, or `undefined` when this machine has
   * none it can use.
   *
   * Never throws: every failure has a state the panel can render, and a
   * credential chain that throws would turn a login problem into a broken
   * region. A renewal that the service refused is reported as such rather than
   * silently retried, because "sign in again" and "we could not reach the
   * service" are different instructions.
   */
  async load(): Promise<LoadedCredential | undefined> {
    const read = this.vault.readResult()
    if (read.kind === 'absent') {
      // A file deleted outside this process — sign-out, or a human with a
      // shell — retires the memory copy too: this region has no credential,
      // and one hidden in a private field is not the user's to keep serving.
      this.memRecord = undefined
      this.last = { state: 'none' }
      return undefined
    }
    if (read.kind === 'unreadable') {
      // The vault moved the bytes aside, so this is not a transient state.
      this.last = { state: 'unreadable', reason: 'the saved credential file could not be read' }
      return undefined
    }
    if (read.kind === 'unrecognised') {
      this.last = {
        state: 'unreadable',
        reason: 'the saved credential file was written by a different version of this plugin',
      }
      return undefined
    }

    const record = read.record
    const now = this.now()

    // An in-memory copy shadows only the STALE disk record. The moment the
    // file carries bytes at least as new as ours — a re-login landed, or a
    // write finally succeeded — the file is the truth and this process lets
    // go of its private copy.
    if (this.memRecord !== undefined && Number(record.savedAt) >= Number(this.memRecord.savedAt)) {
      this.memRecord = undefined
    }
    if (this.memRecord !== undefined && Number(this.memRecord.expiresAt) > now) {
      // Renewed but unwritable: served from memory, and NOT worth another
      // refresh POST — re-asking on every cache miss over a storage problem is
      // the storm this copy exists to prevent. The state says what is true:
      // usable now, gone at the next restart.
      this.last = { state: 'save-failed', reason: DEVICE_SAVE_FAILED_REASON }
      return credentialOf(this.memRecord, this.region, now)
    }

    if (Number(record.expiresAt) > now) {
      this.last = { state: 'ok' }
      return credentialOf(record, this.region, now)
    }

    // The access token has lapsed. A record with no spendable refresh token
    // cannot be recovered by anything this process can do, so say so instead of
    // asking the service a question whose answer is already known.
    if (!(Number(record.refreshTokenExpiresAt) > now)) {
      this.last = { state: 'expired' }
      return undefined
    }
    if (this.refusedAt !== undefined && now - this.refusedAt < REFRESH_FAILURE_TTL_MS) {
      this.last = { state: 'refresh-failed', reason: this.refusedReason }
      return undefined
    }

    const product = productForRegion(this.region)
    if (product === undefined) {
      // Unreachable for a region that got this far, but a thrown error here
      // would take down a region over a login it never had.
      this.last = { state: 'unreadable', reason: `no device-login product is known for ${this.region}` }
      return undefined
    }

    const outcome = await refreshOnce(product, payloadOf(record), record.machineID, this.fetchImpl)
    if (outcome.kind === 'expired') {
      // The refresh token is gone. Keep the record: it is the evidence that this
      // machine once signed in, which is what lets the panel say "sign in again"
      // instead of "you never signed in".
      this.last = { state: 'expired' }
      return undefined
    }
    if (outcome.kind === 'failed') {
      this.refusedAt = now
      this.refusedReason = outcome.name
      this.last = { state: 'refresh-failed', reason: outcome.name }
      return undefined
    }

    // `refreshOnce` has already overlaid the rotation onto the credential it
    // rotated. Taking its answer as a whole would drop the uid the refresh
    // response does not carry, and the request would then be refused with
    // "Signature invalid" -- measured on both regions, see the module header.
    const rotated = outcome.payload
    const rotatedRecord = recordOf(rotated, record.machineID, this.now())
    let displaced = false
    let superseded: VaultRecord | undefined
    const saved = await this.vault.update((current) => {
      if (current === null) {
        // A sign-out landed while this renewal was on the wire. The chain
        // serialises writers that go through it — this one read its record
        // from outside it — so the guard has to be here: writing the rotated
        // record back would resurrect the credential the user just deleted.
        // The deletion wins.
        displaced = true
        return null
      }
      if (current.token !== record.token) {
        // The file now holds a different sign-in than the one this rotation
        // was computed from (a re-login inside the refresh window). Our copy
        // is built from bytes no longer on disk; leave theirs there.
        superseded = current
        return current
      }
      return rotatedRecord
    })
    this.refusedAt = undefined
    this.refusedReason = ''
    if (displaced) {
      // Signed out mid-renewal: the file is gone, so the panel must not claim
      // a credential that exists only in this field. Declining the request is
      // the sign-out being honoured; serving it would be the resurrection's
      // last gasp.
      this.memRecord = undefined
      this.last = { state: 'none' }
      return undefined
    }
    if (superseded !== undefined) {
      this.memRecord = undefined
      if (Number(superseded.expiresAt) > now) {
        this.last = { state: 'ok' }
        return credentialOf(superseded, this.region, now)
      }
      // Their copy has lapsed too. The next load renews from bytes that
      // actually exist; this request declines rather than serve a rotation
      // computed from a record that no longer does, and no status is claimed
      // for a rotation this load did not keep.
      return undefined
    }
    if (!saved) {
      // The renewal in hand is good right now, so this is not a request
      // failure — but the disk does not hold it. Keep it in memory (the next
      // expiry must not storm the refresh endpoint over a storage problem),
      // and say through the panel what is true: this session dies at the
      // next restart. `ok` would be a lie until a write lands.
      this.memRecord = rotatedRecord
      this.logger?.warn?.(
        'dsh-connect-qoder: renewed a device credential but could not store it; it is held in memory only and will not survive a restart',
      )
      this.last = { state: 'save-failed', reason: DEVICE_SAVE_FAILED_REASON }
      return credentialOf(rotatedRecord, this.region, now)
    }
    this.memRecord = undefined
    this.last = { state: 'ok' }
    return credentialOf(rotatedRecord, this.region, now)
  }
}
