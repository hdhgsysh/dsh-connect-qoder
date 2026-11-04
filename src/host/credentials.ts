/**
 * Qoder credential acquisition — the store half: probe the candidate app
 * directories, open the VS Code style SQLite sign-in store (`state.vscdb`)
 * read-only, decode the secret rows.
 *
 * The OSCrypt unwrap, key cache, zeroing and startup sweep live in
 * `oscrypt-unwrap.ts`: that half is the only part of credential acquisition
 * that writes a secret outside the process, spawns a child and deletes things.
 * Nothing here writes to the Qoder apps' files — the store is opened read-only.
 *
 * @module dsh-connect-qoder/credentials
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Region } from './domain.ts'
import {
  cachedOscryptKeyFor,
  decryptOscrypt,
  oscryptKeyFor,
  oscryptKeyForAsync,
} from './oscrypt-unwrap.ts'

// The OSCrypt chain (the PowerShell unwrap, the key cache, the zeroing, the
// startup sweep) lives in `oscrypt-unwrap.ts` now — it is the only part of
// credential acquisition that writes a secret OUTSIDE the process, spawns a
// child and deletes things, and it deserves a reader who is looking at that
// and not at the store queries. These re-exports keep the ~20 importers that
// already name this module working, and give the repo exactly one place that
// says where the chain lives.
export {
  cachedKeyFor,
  cachedOscryptKeyFor,
  decryptOscrypt,
  describeUnwrapFailure,
  failureStillBlocks,
  oscryptKeyFor,
  oscryptKeyForAsync,
  reportCleanupFailure,
  setCredentialDiagnosticSink,
  sweepStaleOscryptDirs,
  zeroOutFile,
  OSCRYPT_MARKER,
  UNWRAP_FAILURE_TTL_MS,
} from './oscrypt-unwrap.ts'
export type {
  CachedOscryptKey,
  DiagnosticSink,
  UnwrapFailure,
  UnwrapOptions,
  UnwrapSpawn,
} from './oscrypt-unwrap.ts'

/**
 * One credential as read from a Qoder app, or minted from an environment PAT.
 *
 * This is the record `index.ts` caches per region and the shim is handed. Every
 * field is PRESENT rather than optional — the readers below fill in `''`/`0`
 * for what a given layout does not publish, because the account panel renders
 * these directly and an `undefined` would surface as "undefined" on screen.
 *
 * `source` distinguishes the two clocks {@link isCredentialUsable} treats
 * differently: an app credential carries `expired` computed at read time, while
 * an `env-pat` is exchanged upstream and expires on `expiresAt` instead.
 */
export interface LoadedCredential {
  region: string
  appName: string
  userID: string
  name: string
  email: string
  token: string
  refreshToken: string
  refreshTokenExpiresAt: number
  expiresAt: number
  expired: boolean
  userType: string
  userTag: string
  machineID: string
  /**
   * Which of the three sources this credential came from.
   *
   * `app` is the desktop application's own login, read and decrypted out of its
   * store; `env-pat` is a personal access token the user put in the
   * environment; `device` is a token this plugin obtained itself by device
   * login (a scan code) and keeps in its own vault. All three are structurally
   * the same once loaded, which is why the difference is a tag rather than a
   * separate type — but the three expire on different clocks, so every reader
   * that asks "is this still good?" has to distinguish them (see
   * `isCredentialUsable`).
   */
  source: 'app' | 'env-pat' | 'device'
  /** The plan summary row, decoded but unvalidated — display only. */
  plan: unknown
  /** The credit/quota snapshot row, decoded but unvalidated — display only. */
  usage: unknown
}

/**
 * How a key is obtained for one app directory.
 *
 * May answer with a key, `undefined`, or a PROMISE of either — `loadCredential`
 * passes the synchronous readers and `loadCredentialAsync` the asynchronous
 * ones, and `loadCredentialWith` probes for the thenable at runtime rather than
 * being told which mode it is in. That probe is what lets the two public
 * entries keep one copy of the layout order instead of two that must be kept in
 * step by hand.
 */
export type KeyProvider = (appDir: string) => Buffer | undefined | PromiseLike<Buffer | undefined>

/** Either a credential or a promise of one, decided by the {@link KeyProvider}. */
type MaybeCredential = LoadedCredential | undefined | PromiseLike<LoadedCredential | undefined>

/** SQLite key holding the sign-in identity, including its access token. */
const USER_INFO_KEY = 'secret://aicoding.auth.userInfo'
/** SQLite key holding the plan summary (tier, validity window). */
const USER_PLAN_KEY = 'secret://aicoding.auth.userPlan'
/** SQLite key holding the credit/quota snapshot. */
const CREDIT_USAGE_KEY = 'secret://aicoding.auth.creditUsage'

/**
 * One Qoder region.
 *
 * `providerId` is the DSH provider route this region registers. The CN and
 * global regions are separate providers so both can be online at once, exactly
 * as the Trae bundle does for its two editions.
 *
 * `appDirs` is the ordered list of Electron user-data directory names that may
 * hold this region's sign-in; the first one that yields a readable credential
 * wins. `appNames` is the matching list of `%APPDATA%` roots.
 *
 * Typed as `Region[]` (from `domain.ts`) rather than left to infer: these two
 * entries ARE the only instances of that interface in the whole plugin, so
 * naming the type here is what makes a missing or misspelled URL family a
 * compile error at the definition instead of `undefined` at the request.
 */
export const REGIONS: Region[] = [
  {
    id: 'qoder-cn',
    mode: 'cn',
    displayName: 'Qoder CN',
    appNames: ['QoderCN', 'Qoder CN', 'QoderWork CN'],
    // Qoder 0.3.x moved its user data to a `com.<vendor>.app.<channel>` Electron
    // directory and replaced the VS Code `state.vscdb` store with `auth.v1.dat`.
    // Both layouts are listed so a user who upgrades keeps working; the newer
    // one is tried first because that is where a freshly installed app writes.
    newAppNames: ['com.qodercn.app.stable'],
    baseUrl: 'https://gateway.qoder.com.cn/',
    openApiUrl: 'https://openapi.qoder.com.cn',
    centerUrl: 'https://gateway.qoder.com.cn',
    manageUrl: 'https://qoder.com.cn',
    downloadUrl: 'https://qoder.com.cn/download',
    patEnvNames: ['QODERCN_API_KEY', 'QODERCN_PERSONAL_ACCESS_TOKEN', 'QODERCN_PAT'],
  },
  {
    id: 'qoder',
    mode: 'global',
    displayName: 'Qoder',
    appNames: ['Qoder', 'QoderWork'],
    newAppNames: ['com.qoder.app.stable'],
    baseUrl: 'https://api3.qoder.sh/',
    openApiUrl: 'https://openapi.qoder.sh',
    centerUrl: 'https://center.qoder.sh',
    manageUrl: 'https://qoder.com',
    downloadUrl: 'https://qoder.com/download',
    patEnvNames: ['QODER_API_KEY', 'QODER_PERSONAL_ACCESS_TOKEN', 'QODER_PAT'],
  },
]

/**
 * The per-user application-data root that Qoder's Electron apps live under.
 *
 * Every platform names it differently, and reading `process.env.APPDATA`
 * directly is why this plugin has never worked off Windows: on macOS that
 * variable does not exist, so the code probed `''`, found no app directory, and
 * reported "not signed in" for a user who plainly was. The path itself was never
 * the hard part — the fallback to the documented per-platform location is.
 *
 * The UNWRAP is still Windows-only (see `oscryptKeyFor`), so resolving the
 * directory on macOS or Linux does not make a sign-in readable yet. It is fixed
 * first because it is the half that is unambiguously correct, it is what lets
 * the account panel say "the app is installed here, but this build cannot read
 * its key" instead of "you are not signed in", and it removes the first thing
 * that has to be right when the keystore side lands.
 *
 * The order is the documented one per platform:
 * - Windows: `%APPDATA%` (roaming — Electron's `userData` default).
 * - macOS: `~/Library/Application Support`.
 * - Linux/other: `$XDG_CONFIG_HOME`, else `~/.config` (Electron's default there).
 *
 * @param platform - the Node platform string, injectable for tests.
 * @param env - the environment, injectable for tests.
 * @param home - the home directory, injectable for tests.
 * @returns an absolute path, or `''` when it cannot be determined — which every
 *   reader already treats as "no app here".
 */
export function appDataRootFor(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') return env.APPDATA ?? ''
  if (platform === 'darwin') return join(home, 'Library', 'Application Support')
  // Electron follows the XDG spec on Linux and other unix-likes.
  const xdg = env.XDG_CONFIG_HOME
  if (typeof xdg === 'string' && xdg.length > 0) return xdg
  return join(home, '.config')
}

/**
 * Read one secret row from a VS Code style `state.vscdb`.
 *
 * The value column is a JSON envelope (`{"type":"Buffer","data":[...]}`) for
 * secret rows; anything else is returned as-is.
 *
 * @returns the raw bytes for a Buffer row, a string for a plain row, or
 *   `undefined` when the key is absent.
 */
function readItem(dbPath: string, key: string): Buffer | string | undefined {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key)
    if (row === undefined || row.value === null || row.value === undefined) return undefined
    const value = row.value
    const text = value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : String(value)
    if (text.startsWith('{') && text.includes('"type":"Buffer"')) {
      try {
        return Buffer.from(JSON.parse(text).data)
      } catch {
        return text
      }
    }
    return text
  } finally {
    db.close()
  }
}

/** Decode one JSON secret row, or `undefined` when absent/undecryptable. */
function readJsonSecret(dbPath: string, key: string, oscryptKey: Buffer): unknown {
  const raw = readItem(dbPath, key)
  if (raw === undefined || typeof raw === 'string') return undefined
  const plain = decryptOscrypt(raw, oscryptKey)
  if (plain === undefined) return undefined
  try {
    return JSON.parse(plain)
  } catch {
    return undefined
  }
}

/** Candidate `state.vscdb` paths for one app's Electron user-data directory. */
function stateDbCandidates(appDir: string): string[] {
  return [
    join(appDir, 'User', 'globalStorage', 'state.vscdb'),
    join(appDir, 'User', 'globalStorage', 'state.vscdb.backup'),
  ]
}

/**
 * The machine id Qoder binds its session to.
 *
 * The legacy layout keeps it in `machineid`; 0.3.x renamed the file to
 * `auth.machine-id`. Both are checked because the id is sent to the gateway
 * alongside the token, and a wrong one is indistinguishable from a hijacked
 * session. When neither exists a stable value is derived from the app directory
 * so repeated runs still agree with each other.
 */
function machineIdFor(appDir: string, fallback: string): string {
  for (const name of ['auth.machine-id', 'machineid', 'machineId']) {
    const p = join(appDir, name)
    if (!existsSync(p)) continue
    const value = readFileSync(p, 'utf8').trim()
    if (value.length > 0) return value
  }
  return fallback
}

/**
 * Read the 0.3.x credential file.
 *
 * From 0.3.x the apps keep their sign-in in
 * `<userData>/auth.v1.dat` — a Chromium OSCrypt blob whose plaintext is the
 * session JSON directly, rather than a row inside a VS Code `state.vscdb`:
 *
 * ```json
 * { "schemaVersion": 1, "token": "dt-…", "refreshToken": "drt-…",
 *   "expiresAt": "2026-10-19T07:44:22Z", "refreshTokenExpiresAt": "…",
 *   "user": { "id": "…", "name": "…", "email": "…" } }
 * ```
 *
 * The envelope is unchanged (`v10` + AES-256-GCM under the DPAPI-wrapped key),
 * so {@link oscryptKeyFor} and {@link decryptOscrypt} are reused as they are.
 *
 * @returns a credential record, or `undefined` when the file is absent or
 *   cannot be decoded.
 */
function loadNewCredential(region: Region, appDir: string, oscryptKey: Buffer): LoadedCredential | undefined {
  const file = join(appDir, 'auth.v1.dat')
  if (!existsSync(file)) return undefined
  const plain = decryptOscrypt(readFileSync(file), oscryptKey)
  if (plain === undefined) return undefined
  // `JSON.parse` answers `any`, so this is the one place the shape of the
  // decrypted session is guaranteed rather than checked — hence the narrowing
  // immediately below, before any field is read.
  let session: unknown
  try {
    session = JSON.parse(plain)
  } catch {
    return undefined
  }
  if (session === null || typeof session !== 'object') return undefined
  const record = session as Record<string, unknown>
  if (typeof record.token !== 'string' || record.token.length === 0) return undefined
  const user =
    record.user !== null && typeof record.user === 'object'
      ? (record.user as Record<string, unknown>)
      : {}
  const userID = typeof user.id === 'string' ? user.id : ''
  if (userID.length === 0) return undefined
  // The new file carries ISO timestamps rather than epoch millis. `Date.parse`
  // on a non-string answers NaN rather than throwing, and NaN is what the
  // `Number.isFinite` guards below exist to catch — so the cast is confined to
  // this line instead of being spread over four.
  const expiresAt = Date.parse(String(record.expiresAt))
  const refreshExpiresAt = Date.parse(String(record.refreshTokenExpiresAt))
  return {
    region: region.id,
    appName: basename(appDir),
    userID,
    name: typeof user.name === 'string' ? user.name : '',
    email: typeof user.email === 'string' ? user.email : '',
    token: record.token,
    refreshToken: typeof record.refreshToken === 'string' ? record.refreshToken : '',
    refreshTokenExpiresAt: Number.isFinite(refreshExpiresAt) ? refreshExpiresAt : 0,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    expired: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt <= Date.now() : false,
    // The new layout does not publish these; they were only ever used for
    // display, and the catalog call supplies what routing actually needs.
    userType: '',
    userTag: '',
    machineID: machineIdFor(appDir, `dsh-connect-qoder-${region.id}`),
    source: 'app',
    plan: undefined,
    usage: undefined,
  }
}

/**
 * Load one region's credential from the local Qoder apps.
 *
 * The 0.3.x layout is tried before the legacy one, because that is where a
 * freshly installed app writes; a user who upgrades therefore keeps working
 * without a reinstall, and a user who has not upgraded is unaffected.
 *
 * Every candidate app is tried in order; the first that yields a decryptable
 * credential wins. A credential whose access token has expired is still
 * returned — the caller decides whether to refresh it — but `expired` says so.
 *
 * SYNCHRONOUS, and on a cache miss that means a blocking PowerShell child
 * (~0.5 s measured, up to 30 s on failure). Every request path should call
 * {@link loadCredentialAsync} instead; this one is kept for the startup sweep
 * and the `probe/` scripts, and for `cachedOnly`, which by construction never
 * reaches the unwrap.
 *
 * @returns a credential record, or `undefined` when no app holds a usable one.
 */
export interface LoadCredentialOptions {
  cachedOnly?: boolean
  force?: boolean
  /**
   * Forwarded to the unwrap; see `UnwrapOptions.platform` in
   * `oscrypt-unwrap.ts`. Defaults to `process.platform`, and exists so the
   * non-Windows explanation is reachable from a Windows test machine rather
   */
  platform?: string
}

export function loadCredential(
  region: Region,
  appDataRoot?: string,
  options: LoadCredentialOptions = {},
): LoadedCredential | undefined {
  // `cachedOnly` is how the account route reads: it answers from the key cache
  // and never spawns the unwrap. See `cachedOscryptKeyFor` for why that matters.
  // `force` is the opposite end, for the explicit user-driven re-read.
  const keyFor: KeyProvider =
    options.cachedOnly === true
      ? cachedOscryptKeyFor
      : options.force === true
        ? (appDir: string) => oscryptKeyFor(appDir, { force: true, platform: options.platform })
        : (appDir: string) => oscryptKeyFor(appDir, { platform: options.platform })
  return loadCredentialWith(region, appDataRoot, keyFor) as LoadedCredential | undefined
}

/**
 * Load one region's credential without blocking the event loop.
 *
 * Identical in every rule to {@link loadCredential} — same layouts probed in
 * the same order, same "first that decrypts wins", same `expired` semantics —
 * because both delegate to `loadCredentialWith` and differ only in which unwrap
 * they await. `cachedOnly` is honoured here too, and stays synchronous in
 * effect: it answers from the cache and never spawns anything.
 *
 * @returns a promise of a credential record, or `undefined`.
 */
export async function loadCredentialAsync(
  region: Region,
  appDataRoot?: string,
  options: LoadCredentialOptions = {},
): Promise<LoadedCredential | undefined> {
  const keyFor: KeyProvider =
    options.cachedOnly === true
      ? cachedOscryptKeyFor
      : options.force === true
        ? (appDir: string) => oscryptKeyForAsync(appDir, { force: true, platform: options.platform })
        : (appDir: string) => oscryptKeyForAsync(appDir, { platform: options.platform })
  return loadCredentialWith(region, appDataRoot, keyFor) as Promise<LoadedCredential | undefined>
}

/**
 * The shared probe loop, parameterised by how a key is obtained.
 *
 * `keyFor` may return a key or a promise of one, and this awaits either — which
 * is what lets the two public entries share one implementation instead of
 * keeping two copies of the layout order in step by hand.
 *
 * @param region - the region descriptor.
 * @param appDataRoot - the application-data root to probe.
 * @param keyFor - `(appDir) => key | Promise<key | undefined>`.
 * @returns a credential record or `undefined`, or a promise of one when
 *   `keyFor` is asynchronous.
 */
function loadCredentialWith(
  region: Region,
  appDataRoot: string | undefined,
  keyFor: KeyProvider,
): MaybeCredential {
  // 0.3.x: `com.<vendor>.app.stable/auth.v1.dat`.
  for (const appName of region.newAppNames ?? []) {
    const appDir = join(appDataRoot ?? '', appName)
    if (!existsSync(appDir)) continue
    const pending = keyFor(appDir)
    if (pending !== undefined && typeof (pending as PromiseLike<Buffer | undefined>).then === 'function') {
      // The first candidate that exists may still be the one that blocks, so the
      // loop has to become a chain from here on. The remaining layouts are
      // handled by the same function, which is why the order is expressed once.
      return (pending as PromiseLike<Buffer | undefined>).then((key) =>
        finishCandidate(region, appDataRoot, keyFor, appDir, key),
      )
    }
    const credential = finishCandidate(region, appDataRoot, keyFor, appDir, pending as Buffer | undefined)
    if (credential !== undefined) return credential
  }
  return credentialFromLegacyLayouts(region, appDataRoot, keyFor)
}

/**
 * Use one app directory's key, falling through to the remaining layouts.
 *
 * @returns a credential record, or a promise of one when the key was a promise.
 */
function finishCandidate(
  region: Region,
  appDataRoot: string | undefined,
  keyFor: KeyProvider,
  appDir: string,
  key: Buffer | undefined,
): MaybeCredential {
  if (key === undefined) return credentialFromLegacyLayouts(region, appDataRoot, keyFor)
  const credential = safeRead(() => loadNewCredential(region, appDir, key))
  if (credential !== undefined) return credential
  return credentialFromLegacyLayouts(region, appDataRoot, keyFor)
}

/**
 * The legacy `<AppName>/User/globalStorage/state.vscdb` layouts.
 */
function credentialFromLegacyLayouts(
  region: Region,
  appDataRoot: string | undefined,
  keyFor: KeyProvider,
): MaybeCredential {
  for (const appName of region.appNames) {
    const appDir = join(appDataRoot ?? '', appName)
    if (!existsSync(appDir)) continue
    const pending = keyFor(appDir)
    if (pending !== undefined && typeof (pending as PromiseLike<Buffer | undefined>).then === 'function') {
      return (pending as PromiseLike<Buffer | undefined>).then((key) =>
        readLegacyCredential(region, appDir, appName, key),
      )
    }
    const credential = readLegacyCredential(region, appDir, appName, pending as Buffer | undefined)
    if (credential !== undefined) return credential
  }
  return undefined
}

/**
 * Read one legacy store, or `undefined` when this app holds nothing usable.
 */
function readLegacyCredential(
  region: Region,
  appDir: string,
  appName: string,
  oscryptKey: Buffer | undefined,
): LoadedCredential | undefined {
  if (oscryptKey === undefined) return undefined
  for (const dbPath of stateDbCandidates(appDir)) {
    if (!existsSync(dbPath)) continue
    let userInfo: Record<string, unknown> | undefined
    try {
      const decoded = readJsonSecret(dbPath, USER_INFO_KEY, oscryptKey)
      // `readJsonSecret` answers `unknown` because the row is unvalidated JSON.
      // The field checks below are the validation; they need a record to read.
      userInfo =
        decoded !== null && typeof decoded === 'object' ? (decoded as Record<string, unknown>) : undefined
    } catch {
      continue
    }
    if (userInfo === undefined || typeof userInfo.token !== 'string' || userInfo.token.length === 0) continue
    if (typeof userInfo.id !== 'string' || userInfo.id.length === 0) continue
    const expiresAt = Number(userInfo.expireTime)
    return {
      region: region.id,
      appName,
      userID: userInfo.id,
      name: typeof userInfo.name === 'string' ? userInfo.name : '',
      email: typeof userInfo.email === 'string' ? userInfo.email : '',
      token: userInfo.token,
      refreshToken: typeof userInfo.refreshToken === 'string' ? userInfo.refreshToken : '',
      refreshTokenExpiresAt: Number(userInfo.refreshTokenExpireTime) || 0,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
      expired: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt <= Date.now() : false,
      userType: typeof userInfo.userType === 'string' ? userInfo.userType : '',
      userTag: typeof userInfo.userTag === 'string' ? userInfo.userTag : '',
      machineID: machineIdFor(appDir, `dsh-connect-qoder-${region.id}`),
      source: 'app',
      plan: safeRead(() => readJsonSecret(dbPath, USER_PLAN_KEY, oscryptKey)),
      usage: safeRead(() => readJsonSecret(dbPath, CREDIT_USAGE_KEY, oscryptKey)),
    }
  }
  return undefined
}

/** Run a reader, mapping any failure to `undefined`. */
function safeRead<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/**
 * A credential supplied through the environment instead of the desktop app.
 *
 * The Qoder personal access token is the officially documented integration
 * path, so it is honoured as a fallback when no app sign-in is present. The
 * token is exchanged for a job token by {@link module:dsh-connect-qoder/upstream}.
 */
export function loadEnvCredential(
  region: Region,
  env: NodeJS.ProcessEnv = process.env,
): LoadedCredential | undefined {
  for (const name of region.patEnvNames) {
    const value = env[name]
    if (typeof value === 'string' && value.trim().length > 0) {
      return {
        region: region.id,
        appName: name,
        userID: '',
        name: '',
        email: '',
        token: value.trim(),
        refreshToken: '',
        refreshTokenExpiresAt: 0,
        expiresAt: 0,
        expired: false,
        userType: '',
        userTag: '',
        machineID: `dsh-connect-qoder-${region.id}`,
        source: 'env-pat',
        plan: undefined,
        usage: undefined,
      }
    }
  }
  return undefined
}

/**
 * Whether a cached credential may still be served, or must be re-read.
 *
 * The two sources expire on different clocks, and conflating them is what made
 * this worth extracting:
 *
 * - An **app** credential carries an `expired` flag computed when it was read
 *   from disk. The Qoder app refreshes the token in its own store, so once this
 *   says expired the only way to learn about a re-sign-in is to read again.
 * - An **env PAT** is exchanged for a job token with its own `expiresAt`; the
 *   raw PAT never expires, so the exchange result does, and it is a wall-clock
 *   comparison rather than a stored flag.
 * - A **device** credential is this plugin's own, and it is the one source it
 *   can renew: it carries the same wall-clock `expiresAt` the service stated,
 *   and an expired one is not the end of the story — the refresh token is what
 *   the loader reaches for. Reporting it as unusable here is precisely what
 *   lets `CredentialCache.resolve` re-enter the loader and rotate it, so this
 *   comparison is a trigger for a refresh, not a verdict of death.
 *
 * @param cached - the cached record, or `undefined` when nothing is cached.
 * @param now - current epoch milliseconds.
 * @returns true when the cached value may be reused.
 */
export function isCredentialUsable(
  cached: LoadedCredential | undefined | null,
  now = Date.now(),
): boolean {
  if (cached === undefined || cached === null) return false
  // Both of these carry a real expiry the issuer stated, as opposed to the
  // app's pre-computed flag.
  if (cached.source === 'env-pat' || cached.source === 'device') return Number(cached.expiresAt) > now
  return cached.expired !== true
}
