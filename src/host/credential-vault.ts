/**
 * The plugin's own credential file, one per region — the storage half of the
 * device-login credential source (docs/issues/21-device-login-credential-source.md).
 *
 * It is the plugin's only secret of its own: the file is `0o600` in a `0o700`
 * directory, writes go to a sibling `.tmp` renamed onto the target, and
 * `update()` serializes the read-decide-write and re-reads first, so another
 * profile's record is never stomped. Nothing throws: a failure the user must
 * see comes back through the return value (docs/issues/16-silent-failure-policy.md).
 *
 * @module dsh-connect-qoder/credential-vault
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** On-disk format this reader accepts; other versions read as absent. */
export const VAULT_FORMAT_VERSION = 1

/**
 * How long one of a writer's `.tmp` leftovers must have sat untouched before a
 * save treats it as crash debris rather than an in-flight write. Far above any
 * real write (the rename follows the write in microseconds), far below a crash
 * nobody is cleaning up after.
 */
const STALE_TEMP_MS = 60_000

/**
 * One stored device-login credential.
 *
 * Epoch milliseconds throughout, and the two expiry fields are kept apart on
 * purpose: the access token is short-lived (the platform mints one good for
 * weeks) while the refresh token outlives it by about a year. Collapsing them
 * would make "the access token expired, refresh it" indistinguishable from
 * "the account is gone, sign in again", which are different sentences on the
 * card and different actions for the user.
 */
export interface VaultRecord {
  /** The access token sent upstream. Never logged, never rendered. */
  token: string
  /** The token that buys a new access token. Never logged, never rendered. */
  refreshToken: string
  /** Epoch ms the access token stops being usable. */
  expiresAt: number
  /** Epoch ms the refresh token stops being usable; then a sign-in is required. */
  refreshTokenExpiresAt: number
  /**
   * The account's uid.
   *
   * Required, and required to be non-empty, because the upstream signature
   * carries it: `authHeaders` puts it in the encrypted signature block and in
   * the `Cosy-User` header. A refresh response does NOT carry it, so an
   * implementation that replaced the stored credential with the refresh
   * response would sign an empty uid — measured on both regions as
   * `403 {"code":"101","message":"Signature invalid"}`. Keeping it here is what
   * lets the merge in `device-login.ts` have something to keep.
   */
  userID: string
  /** Display name, when the platform published one. */
  name: string
  /** Display email, when the platform published one. */
  email: string
  /** The machine identity this credential was issued against. */
  machineID: string
  /** When this record was last written, epoch ms. Diagnostic only. */
  savedAt: number
}

export interface CredentialVaultOptions {
  /** Where the vault file lives. Required. */
  path: string
  /** Wall clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number
  logger?: { warn?: (message: string, error?: unknown) => void }
}

/**
 * A field of a parsed record, read defensively.
 *
 * Records written by an older build, or edited by hand, must not be able to
 * produce a credential with `undefined` where a string is expected: the
 * signature is built from these, and a `undefined` there surfaces upstream as
 * an authentication failure rather than as the shape problem it is.
 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A timestamp field, in epoch ms. The on-disk form is a number; seconds are not accepted. */
function stamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Whether two candidate records carry the same credential.
 *
 * Used only by the commit-time re-read inside `update`, so the fields that
 * matter are the ones a competing writer changes: the tokens, the identity
 * and expiry stamps, and `savedAt` — the guard's own yardstick. Two records
 * differing in none of these are the same credential for the race's purposes
 * even if a future build grows a display-only field this comparison ignores.
 */
function recordsEqual(a: VaultRecord | undefined, b: VaultRecord | null): boolean {
  if (a === undefined || b === null) return false
  return (
    a.token === b.token &&
    a.refreshToken === b.refreshToken &&
    a.expiresAt === b.expiresAt &&
    a.refreshTokenExpiresAt === b.refreshTokenExpiresAt &&
    a.userID === b.userID &&
    a.machineID === b.machineID &&
    a.savedAt === b.savedAt
  )
}

/**
 * Read one value out of a parsed record into a {@link VaultRecord}.
 *
 * Returns `undefined` for anything that is not a whole, plausible record. The
 * bar is deliberately high — a `token` and a non-empty `userID` are the two
 * fields without which the credential cannot be used at all, and a record
 * missing either is treated as absent rather than as a credential that will
 * fail upstream.
 */
export function vaultRecordFrom(value: unknown): VaultRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.version !== VAULT_FORMAT_VERSION) return undefined
  const token = text(record.token)
  const userID = text(record.userID)
  const refreshToken = text(record.refreshToken)
  if (token === undefined || token === '' || userID === undefined || userID === '') return undefined
  return {
    token,
    refreshToken: refreshToken ?? '',
    expiresAt: stamp(record.expiresAt) ?? 0,
    refreshTokenExpiresAt: stamp(record.refreshTokenExpiresAt) ?? 0,
    userID,
    name: text(record.name) ?? '',
    email: text(record.email) ?? '',
    machineID: text(record.machineID) ?? '',
    savedAt: stamp(record.savedAt) ?? 0,
  }
}

/**
 * What a read of the vault found, including the cases that `read` folds into
 * `null`. See {@link CredentialVault.readResult}.
 */
export type VaultRead =
  | { kind: 'ok'; record: VaultRecord }
  /** No file: nobody has signed in through this plugin on this machine. */
  | { kind: 'absent' }
  /** A file that would not parse; it has been moved aside (see `quarantine`). */
  | { kind: 'unreadable' }
  /** A file that parsed but is not a record this build can use. */
  | { kind: 'unrecognised' }

/**
 * One region's credential file, with serialized read-modify-write.
 *
 * @see module:dsh-connect-qoder/credential-vault for why each rule exists.
 */
export class CredentialVault {
  /** Where the vault file lives. */
  path: string
  /** The wall clock, stamped into `savedAt` and used for the quarantine name. */
  private now: () => number
  /** Optional logger for a failed write or an unreadable file. */
  private logger: { warn?: (message: string, error?: unknown) => void } | undefined
  /**
   * The tail of the write chain; see {@link CredentialVault.update}.
   *
   * Every mutation is appended here, so two mutations can never interleave
   * their read-decide-write. It is a promise chain rather than a boolean "busy"
   * flag because the work is synchronous: a caller must still be able to queue.
   */
  private chain: Promise<unknown> = Promise.resolve()

  constructor({ path, now = () => Date.now(), logger }: CredentialVaultOptions) {
    this.path = path
    this.now = now
    this.logger = logger
  }

  /**
   * Read the stored credential, or `null`.
   *
   * `null` covers every "there is nothing usable here" case on purpose: no
   * file, an unreadable file, a foreign version, or a record missing the fields
   * a signature needs. The caller's answer to all of them is the same — treat
   * this region as having no device credential — and keeping them distinct here
   * would invite a caller to invent a second, differently-worded version of
   * that answer.
   *
   * A file that exists but cannot be PARSED is quarantined (see
   * {@link CredentialVault.quarantine}) so the next write does not overwrite
   * it. A file that parses but is the wrong shape is left alone: it is
   * evidence of a version skew, not of damage, and the next write replaces it.
   */
  read(): VaultRecord | null {
    const result = this.readResult()
    return result.kind === 'ok' ? result.record : null
  }

  /**
   * Read the credential and say WHY, where {@link CredentialVault.read} says
   * only "nothing usable".
   *
   * `read` is the right call for control flow: every empty answer has the same
   * consequence (this region has no device credential). This is the call for
   * the panel, where "you have not signed in on this machine" and "your
   * credential file is damaged" are different sentences with different next
   * steps, and telling a user the wrong one is the class of failure this repo's
   * first red line exists for.
   */
  readResult(): VaultRead {
    if (!existsSync(this.path)) return { kind: 'absent' }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch (error) {
      this.quarantine(error)
      return { kind: 'unreadable' }
    }
    const record = vaultRecordFrom(parsed)
    if (record !== undefined) return { kind: 'ok', record }
    // It parsed, so it is not damage: either written by a future version or a
    // shape this build does not know. Both mean the same thing to a user.
    return { kind: 'unrecognised' }
  }

  /**
   * Move an unparseable file aside, keeping the bytes.
   *
   * The name carries the clock so repeated failures accumulate rather than
   * overwrite each other — the point is to lose nothing that a human might
   * recover a token from. Failing to move it is not worth an error: the next
   * write replaces the file either way, and the caller is already being told
   * there is no credential.
   */
  private quarantine(error: unknown): void {
    try {
      renameSync(this.path, `${this.path}.corrupt-${this.now()}`)
      this.logger?.warn?.(`dsh-connect-qoder: kept an unreadable credential file as ${this.path}.corrupt-*`)
    } catch (renameError) {
      this.logger?.warn?.(`dsh-connect-qoder: could not set aside an unreadable credential file ${this.path}`, renameError)
    }
    this.logger?.warn?.(`dsh-connect-qoder: could not read credential file ${this.path}`, error)
  }

  /**
   * Write a record atomically, with owner-only permissions.
   *
   * @returns whether the bytes actually landed. A `false` is a fact the caller
   *   must surface: a credential that could not be saved still works for this
   *   process, but the user has signed in for nothing unless they are told.
   */
  save(record: VaultRecord): boolean {
    const tmp = `${this.path}.${process.pid}.tmp`
    this.sweepStaleTemps()
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      writeFileSync(
        tmp,
        JSON.stringify({ version: VAULT_FORMAT_VERSION, ...record }, null, 2),
        { encoding: 'utf8', mode: 0o600 },
      )
      // Rename onto the target rather than writing it in place: on Windows the
      // rename-over-existing works (MoveFileEx), and a crash therefore leaves
      // either the old credential or the new one, never a truncated file.
      renameSync(tmp, this.path)
      return true
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        // This name is overwritten by the next write from this process; a
        // crash between the write and the rename is reclaimed by
        // sweepStaleTemps once the leftover goes stale.
      }
      this.logger?.warn?.(`dsh-connect-qoder: could not save credential file ${this.path}`, error)
      return false
    }
  }

  /**
   * Clear temp files from interrupted writes.
   *
   * The catch above can only clean up when this process still gets to run it:
   * a kill between the write and the rename leaves the token in cleartext next
   * to the vault with nothing to reclaim it. Sweeping at the start of every
   * save bounds that window. The candidate set is deliberately narrow — this
   * vault's own directory, names starting with this vault's own basename plus
   * a dot and ending in `.tmp`, older than STALE_TEMP_MS, never including the
   * name currently being written — so a live writer's temp, this process or
   * another machine profile, is never yanked out from under it, and no name
   * this vault could not have written is ever a candidate. unlink does not
   * follow links: a planted symlink goes, its target anywhere else does not.
   * Every removal is best-effort: a temp that will not die today is retried
   * on the next save, never a save failure.
   */
  private sweepStaleTemps(): void {
    const dir = dirname(this.path)
    const prefix = `${basename(this.path)}.`
    const own = `${prefix}${process.pid}.tmp`
    const now = this.now()
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return // no directory yet: nothing to sweep
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp') || name === own) continue
      const path = join(dir, name)
      try {
        if (now - statSync(path).mtimeMs < STALE_TEMP_MS) continue
        unlinkSync(path)
      } catch {
        // Unreadable or unwilling: the next save tries again.
      }
    }
  }

  /** Remove the stored credential. An absent file is a no-op, not an error. */
  private remove(): boolean {
    try {
      if (existsSync(this.path)) unlinkSync(this.path)
      return true
    } catch (error) {
      this.logger?.warn?.(`dsh-connect-qoder: could not remove credential file ${this.path}`, error)
      return false
    }
  }

  /**
   * Atomically apply one change to the stored credential.
   *
   * The mutator receives the CURRENT stored record (re-read inside the chain,
   * not passed in by the caller) and returns the record to store, or `null` to
   * remove the file. Because the read, the decision and the write all happen
   * inside one chain step, a concurrent `update` cannot land between another
   * one's read and its write.
   *
   * This is the whole reason the class exists rather than callers doing
   * `read()`/`save()` themselves: a sign-out and a token refresh are both
   * ordinary events, and interleaved they resurrect a signed-out credential.
   *
   * Cross-process writers (a second DSH profile over the same Harness home)
   * do not go through this chain, so just before committing, the step re-reads
   * the file and refuses to write unless the disk still holds the record the
   * decision was based on — see the module header for the refusal cases and
   * the window that honestly remains. A deletion (`null`) always commits: the
   * user pressed sign-out, and no concurrent refresh may outrank that.
   *
   * @returns whether the file's contents ended up as requested. A rejected
   *   promise is never used to report a storage failure — the caller needs to
   *   distinguish "the disk refused" from "the operation threw". `false`
   *   covers the disk refusing AND the commit-time re-read finding that
   *   another process changed the record under us; both are facts the caller
   *   must surface, never smooth over.
   */
  update(mutator: (current: VaultRecord | null) => VaultRecord | null): Promise<boolean> {
    const step = this.chain.then(() => {
      const current = this.read()
      const next = mutator(current)
      // A deletion decided inside the chain always commits: the user pressed
      // sign-out, and the file is the plugin's only copy of the credential —
      // there is no newer version of "this machine is signed out" to protect.
      if (next === null) return this.remove()
      if (!this.diskStillHolds(current, next)) return false
      return this.save(next)
    })
    // The chain must survive a throwing mutator, or every later update would
    // reject on a promise nobody ever handled.
    this.chain = step.catch(() => undefined)
    return step
  }

  /**
   * Whether the disk still holds the record this chain step decided on.
   *
   * A second DSH profile (web and desktop share one Harness home, hence one
   * vault file per region) writes this file with its OWN chain, so a record
   * can land between this step's read and its rename. Re-reading immediately
   * before the commit narrows the race to the re-read→rename pair of syscalls
   * and, more importantly, turns "my write silently overwrote theirs" into
   * "my write is refused and the caller says so":
   *
   * - a record newer than the one decided on (the other profile refreshed or
   *   re-signed-in) is left standing — a diverged disk is never overwritten,
   *   whichever side claims to be newer, because "newer" across two processes
   *   is last-writer-wins wearing a timestamp;
   * - a file that vanished (the other profile signed out) is not resurrected;
   * - a file that changed shape under us (unreadable, or a foreign version)
   *   is never stomped by a build that cannot even parse it;
   * - the decided-on state itself — including "absent", for the first-ever
   *   sign-in — passes through.
   *
   * Deletions never reach here (`update` commits them unconditionally), so
   * `next` is always a record to store.
   */
  private diskStillHolds(decidedOn: VaultRecord | null, next: VaultRecord): boolean {
    const fresh = this.readResult()
    if (decidedOn === null) {
      // The decision was made on an empty vault. Only an actually-empty
      // (or never-existing) disk may receive the write: an unreadable or
      // unrecognised file is somebody's evidence, and an ok record is a
      // sign-in the other profile just landed.
      return fresh.kind === 'absent' || recordsEqual(fresh.kind === 'ok' ? fresh.record : undefined, next)
    }
    if (fresh.kind !== 'ok') return false
    const disk = fresh.record
    // The disk moved and is neither what we are about to write nor the state
    // the decision was made on: refuse, whichever side is newer. Overwriting
    // a diverged disk would be last-writer-wins — the exact bug this guard
    // exists to stop. The caller surfaces the refusal, and its next attempt
    // decides on the fresh record like any other step.
    return recordsEqual(disk, next) || recordsEqual(disk, decidedOn)
  }

  /**
   * Forget the stored credential, serialized against in-flight updates.
   *
   * Goes through the same chain as {@link CredentialVault.update} so that a
   * refresh which has already read the record cannot write it back after the
   * sign-out lands.
   */
  clear(): Promise<boolean> {
    return this.update(() => null)
  }
}
