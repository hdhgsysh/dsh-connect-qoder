/**
 * The OSCrypt key chain: unwrap the desktop app's master key, decrypt its
 * secret rows with it, and reclaim what a crash left in the temp dir.
 *
 * On Windows the wrapper is DPAPI scoped to the current user. Node has no
 * DPAPI binding, so the unwrap runs through PowerShell and hands the key over
 * in a temp file (a sandbox may forbid piped stdio). That file is the weakest
 * link: exclusive handle, user ACL, absolute interpreter path, whitelisted
 * child env (a `QODER_PAT` never reaches the child), zero before unlink, sweep.
 *
 * @module dsh-connect-qoder/oscrypt-unwrap
 */
import { execFileSync, execFile } from 'node:child_process'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv } from 'node:crypto'
import { describeThrown } from './errors.ts'

/**
 * One entry of the OSCrypt key cache: the key plus the identity of the
 * `Local State` file it was unwrapped from.
 *
 * `identity` is `undefined` for an entry written before that rule existed — a
 * hot reload of an older module can leave one in the map — and that is exactly
 * why `cachedKeyFor` refuses it rather than treating "both undefined" as a
 * match. The pair is declared here rather than inline so the two readers
 * (`cachedKeyFor`, the exit-time wipe) cannot drift apart.
 */
export interface CachedOscryptKey {
  key?: Buffer
  identity?: string | undefined
}

/** A recorded unwrap failure, and the `Local State` version it describes. */
export interface UnwrapFailure {
  reason: string
  at: number
  identity?: string | undefined
}

/**
 * Where a diagnostic message goes: the plugin entry's logger, once it has
 * installed one. Everything this module reports is one string, so a sink that
 * takes two arguments is accepted but never given a second one.
 */
export type DiagnosticSink = (message: string) => void

/** The knobs both unwrap entry points take. */
export interface UnwrapOptions {
  /**
   * Ignore the failure window and unwrap again. Reserved for the explicit user
   * action ("重读登录"), where suppressing the attempt would make the button a
   * no-op; every automatic caller leaves it unset.
   */
  force?: boolean
  /**
   * The Node platform string, defaulting to `process.platform`.
   *
   * Present only so the non-Windows branch is reachable from a Windows machine:
   * the unwrap is PowerShell + DPAPI, and DPAPI has no equivalent elsewhere
   * (KNOWN_GAPS §6). A test that could not name a foreign platform could not
   * assert that such a host is told WHY it cannot read the sign-in — and that
   * message is the whole reason the branch exists.
   */
  platform?: string | undefined
}

/**
 * What one child-process run answers with.
 *
 * The sync runner returns `undefined`; the async one returns a promise of it.
 * `runUnwrap` distinguishes them at runtime with a `typeof … .then` probe, so
 * the union has to admit both rather than being narrowed to the promise.
 */
export type UnwrapSpawn = (
  powershell: string,
  args: string[],
  options: Parameters<typeof execFileSync>[2],
) => Promise<unknown> | unknown

/** The outcome of reading the hand-off file: a key, or why there is none. */
interface UnwrappedKeyRead {
  key?: Buffer
  failure?: string
}

/** Chunk size for zeroing a file: large enough to be quick, small enough to be cheap to allocate. */
const ZERO_BLOCK_BYTES = 64 * 1024
/** Base delay between zeroing retries; attempt N waits N × this. */
const ZERO_RETRY_BACKOFF_MS = 50
/** Name of the identity marker file written into every unwrap temp dir. */
export const OSCRYPT_MARKER = '.dsh-oscrypt'

/** PowerShell that unwraps the OSCrypt key and writes it to `$env:QODER_KEY_OUT`. */
const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QoderDpapi {
  [StructLayout(LayoutKind.Sequential)] public struct B { public int cbData; public IntPtr pbData; }
  [DllImport("Crypt32.dll", SetLastError=true)]
  static extern bool CryptUnprotectData(ref B i, IntPtr d, IntPtr e, IntPtr r, IntPtr p, int f, ref B o);
  [DllImport("Kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
  public static byte[] U(byte[] data) {
    B i = new B(); i.cbData = data.Length; i.pbData = Marshal.AllocHGlobal(data.Length);
    Marshal.Copy(data, 0, i.pbData, data.Length);
    B o = new B();
    try {
      if (!CryptUnprotectData(ref i, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref o))
        throw new Exception("DPAPI error " + Marshal.GetLastWin32Error());
      byte[] r = new byte[o.cbData]; Marshal.Copy(o.pbData, r, 0, o.cbData); return r;
    } finally { Marshal.FreeHGlobal(i.pbData); if (o.pbData != IntPtr.Zero) LocalFree(o.pbData); }
  }
}
'@
$statePath = Join-Path $env:QODER_APP_DIR 'Local State'
$json = Get-Content $statePath -Raw | ConvertFrom-Json
$raw = [Convert]::FromBase64String($json.os_crypt.encrypted_key)
if ($raw.Length -le 5) { throw 'encrypted_key too short' }
$key = [QoderDpapi]::U($raw[5..($raw.Length - 1)])
# Hand the key off through an exclusive handle (no other process on the box
# can read it while it is on disk) and, before any secret byte touches the
# file, restrict its ACL to the current user: the default inherited ACL of
# the temp directory follows the machine's policy, shared-drive TEMP included.
#
# The ACL is applied with the static File.SetAccessControl after the handle
# that created the file is closed. Applying it THROUGH the open handle (the
# previous shape) always fails: that handle was opened ReadWrite, which does
# not carry WRITE_DAC, so the driver answers ACCESS_DENIED — and widening the
# handle's access would let another process open the file in the gap anyway.
# The file is still EMPTY when the ACL lands, so no key byte exists before
# the restriction is in force; the handle is then reopened exclusive for the
# write. The type is FileSystemAccessRule — there is no "FileAccessRule" in
# .NET, and resolving a non-existent type aborts the script before the unwrap.
$fs = New-Object System.IO.FileStream($env:QODER_KEY_OUT, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
$fs.Dispose()
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
  [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.InheritanceFlags]::None,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow)))
[System.IO.File]::SetAccessControl($env:QODER_KEY_OUT, $acl)
$fs = New-Object System.IO.FileStream($env:QODER_KEY_OUT, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
try {
  $payload = [System.Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($key))
  $fs.Write($payload, 0, $payload.Length)
  $fs.Flush()
} finally {
  $fs.Dispose()
}
`

/**
 * Per-app OSCrypt key cache; the unwrap is not free, so do it once. Only a
 * successful unwrap is remembered — a failure is usually transient, and caching
 * it would pin "not signed in" for the life of the process. An entry is bound to
 * the `Local State` identity, so a rewrite invalidates it (docs/issues/08-keycache-staleness.md).
 */
const keyCache = new Map<string, CachedOscryptKey>()

/**
 * The reason the most recent unwrap of one app directory failed, and when: the
 * card's account route reads the cause back, so a stuck region can say why. It
 * is cleared on the next successful unwrap, and blocks retries only for
 * {@link UNWRAP_FAILURE_TTL_MS} — a transient fault is retried, not remembered.
 */
const lastUnwrapFailure = new Map<string, UnwrapFailure>()

/**
 * How long a failed unwrap is remembered before another is attempted.
 *
 * 60 s: long enough that opening, switching and re-opening the card panel costs
 * one subprocess rather than one per render, short enough that a user who
 * re-signed-in-and-retried is not told "unreadable" for a minute.
 */
export const UNWRAP_FAILURE_TTL_MS = 60 * 1000

/**
 * The last unwrap failure recorded for one app directory, or `undefined`.
 *
 * `undefined` covers two cases and they are not distinguished: the directory
 * never attempted an unwrap, and it last succeeded. Both mean "no reason to
 * show" from the card's side.
 *
 * A failure is still returned while it is fresh, so the card keeps saying *why*
 * between retries; only the *attempt* is suppressed.
 *
 * @param appDir - the app's user-data directory.
 * @param now - the current instant, injectable for tests.
 * @returns the recorded reason, or `undefined`.
 */
export function describeUnwrapFailure(appDir: string, now = Date.now()): string | undefined {
  const entry = lastUnwrapFailure.get(appDir)
  if (entry === undefined) return undefined
  if (now - entry.at >= UNWRAP_FAILURE_TTL_MS) return undefined
  return entry.reason
}

/**
 * Where an unwrap failure is reported, set by the plugin entry at activation.
 *
 * This module has no Cordis context of its own, so it cannot reach a logger
 * directly. Without somewhere to send it, a failed unwrap is the silent failure
 * the plugin used to have; the entry installs the host logger here so the cause
 * lands in the same stream as every other plugin message.
 */
let diagnosticSink: DiagnosticSink | undefined
export function setCredentialDiagnosticSink(sink: unknown): void {
  diagnosticSink = typeof sink === 'function' ? (sink as DiagnosticSink) : undefined
}

/**
 * Block for a few milliseconds without spinning.
 *
 * `oscryptKeyFor` is synchronous (it wraps `execFileSync`), so it cannot await a
 * backoff. `Atomics.wait` on a shared int is the one way to sleep on the main
 * thread without a busy loop; the wait is in microseconds and the timeout is in
 * milliseconds, so the value itself is irrelevant.
 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // A host without shared memory available (a locked-down sandbox) simply
    // does not back off; the retry then happens immediately.
  }
}

/**
 * Report a cleanup that could not be completed.
 *
 * A temp file left holding the unwrapped key is the one failure in this module
 * that outlives the process, so it must not be silent even though cleanup is
 * best-effort by design. The diagnostic sink is the same channel used for
 * unwrap failures, which the plugin entry installs at activation; before that,
 * and when nobody is listening, it falls back to a process warning so the
 * condition is still observable.
 */
export function reportCleanupFailure(message: string): void {
  const where: DiagnosticSink = diagnosticSink ?? ((text: string) => process.emitWarning(text))
  where(`dsh-connect-qoder: ${message}`)
}

// The cached values are 32-byte Buffers that outlive every request, and
// nothing in this module zeroes them: a core dump or a same-process hook can
// read the heap for the process's whole life. Wipe the slots when the host
// exits, where no reader can be in flight — best-effort hygiene, not a
// guarantee.
process.on('exit', () => {
  for (const cached of keyCache.values()) cached?.key?.fill(0)
})

/**
 * Identify the `Local State` file a cached key was unwrapped from.
 *
 * Returns `undefined` when the file is absent, and that `undefined` is itself a
 * valid identity: "there is no file" is also how the cache must read when the
 * file is deleted, so a cached key is correctly retired in that case too (an app
 * being uninstalled under a running host is rare, but the old key would then
 * outlive the store it decrypts).
 *
 * @param statePath - absolute path to the app's `Local State`.
 * @returns `"<mtimeMs>:<size>"`, or `undefined` when the file cannot be stat'd.
 */
function localStateIdentity(statePath: string): string | undefined {
  try {
    const stats = statSync(statePath)
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return undefined
  }
}

/**
 * Whether a cached key may be reused; both sides must be present and equal.
 * @param cached - the cache entry `{ key, identity }`, or `undefined`.
 * @param identity - the current file identity, or `undefined` when absent.
 * @returns the reusable key, or `undefined` when a fresh unwrap is required.
 */
export function cachedKeyFor(cached: unknown, identity: string | undefined): Buffer | undefined {
  if (cached === undefined || cached === null) return undefined
  // Narrowed rather than assumed: the caller passes whatever the cache holds,
  // and on a hot reload that can be the bare Buffer an older module cached
  // before this shape existed — the doc comment below relies on that.
  const entry = cached as CachedOscryptKey
  if (entry.key === undefined || entry.key === null) return undefined
  // Both sides must be PRESENT and equal. Comparing `undefined === undefined`
  // would otherwise pass for an entry with no recorded identity against a
  // missing file, handing out a key whose provenance is unknown — the test
  // `a legacy entry is never trusted` pins exactly that.
  if (entry.identity === undefined || identity === undefined) return undefined
  if (entry.identity !== identity) return undefined
  return entry.key
}

/**
 * Whether a recorded failure still suppresses an attempt: age AND identity.
 * @param entry - the recorded `{ reason, at, identity }`, or `undefined`.
 * @param identity - the current `Local State` identity.
 * @returns true when the attempt should be skipped.
 */
export function failureStillBlocks(
  entry: UnwrapFailure | undefined | null,
  identity: string | undefined,
  now = Date.now(),
): boolean {
  if (entry === undefined || entry === null) return false
  if (now - entry.at >= UNWRAP_FAILURE_TTL_MS) return false
  // A rewritten `Local State` ends the window early: the failure described a
  // file that no longer exists, and the user re-signing in is exactly the
  // moment they expect the retry to happen. This is the same "bind the answer
  // to the file it came from" rule as the key cache, applied to the failure.
  if (entry.identity !== undefined && entry.identity !== identity) return false
  return true
}

/**
 * Unwrap one app's OSCrypt key.
 *
 * The cache hit is conditional on `Local State` being byte-for-byte the same
 * file the cached key came from (see `keyCache`); anything else is a miss and
 * re-unwraps.
 *
 * SYNCHRONOUS, and that is a documented cost rather than an oversight: the
 * PowerShell child blocks the host's event loop for as long as it runs
 * (measured: ~0.5 s per region on the success path, and up to the 30 s timeout
 * when it cannot succeed). `oscryptKeyForAsync` is the version every request
 * path should use; this one is kept for the callers that genuinely cannot await
 * — the process-startup sweep and the `probe/` scripts — and for the rare
 * `cachedOnly` read, which by construction answers from the cache and never
 * spawns the child at all.
 *
 * @param appDir - absolute Electron user-data directory for the app.
 * @param options.force - ignore the failure window and unwrap again. Reserved
 *   for the explicit user action ("重读登录"), where suppressing the attempt
 *   would make the button a no-op; every automatic caller leaves it unset.
 * @param spawn - the child-process runner. Injectable so the whole unwrap can
 *   be exercised without a PowerShell child: the seam exists because the code
 *   between "temp dir created" and "key read back" is where a plaintext key
 *   escapes the process, and it used to be reachable only on a Windows machine
 *   with a signed-in Qoder.
 * @returns the 32-byte AES key, or `undefined` when it cannot be obtained.
 */
export function oscryptKeyFor(
  appDir: string,
  options: UnwrapOptions = {},
  spawn: UnwrapSpawn = spawnUnwrapSync,
): Buffer | undefined {
  // The sync runner never returns a thenable, so this is a key or nothing. The
  // cast states that instead of widening the caller's return type to a promise
  // it can never receive.
  return runUnwrap(appDir, options, spawn) as Buffer | undefined
}

/**
 * Unwrap one app's OSCrypt key without blocking the event loop.
 *
 * Same rules, same caches, same failure classification as
 * {@link oscryptKeyFor} — the two share `runUnwrap` and differ ONLY in how the
 * child process is spawned, which is what makes that claim checkable rather
 * than a promise: there is one implementation of the temp-dir handling, the
 * zeroing, the identity binding and the failure recording, so an async version
 * that diverged would have to diverge by re-implementing one of them.
 *
 * @param appDir - absolute Electron user-data directory for the app.
 * @param options.force - see {@link oscryptKeyFor}.
 * @param spawn - the child-process runner; see {@link oscryptKeyFor}.
 * @returns a promise of the 32-byte AES key, or `undefined` when it cannot be
 *   obtained.
 */
export async function oscryptKeyForAsync(
  appDir: string,
  options: UnwrapOptions = {},
  spawn: UnwrapSpawn = spawnUnwrapAsync,
): Promise<Buffer | undefined> {
  // Async runner, so the thenable branch is the one that runs; the cast keeps
  // the union out of every call site.
  return runUnwrap(appDir, options, spawn) as Promise<Buffer | undefined>
}

/**
 * The shared body of both unwrap paths.
 *
 * `spawn` receives `(powershell, args, options)` and either returns (sync) or
 * returns a promise of it (async); everything around it — the cache lookup, the
 * failure window, the temp directory, the marker, the zeroing, the reporting —
 * is identical by construction.
 *
 * @param appDir - the app's user-data directory.
 * @param options - `{ force, platform }`.
 * @param spawn - the child-process runner.
 * @returns the key, or a promise of it, depending on `spawn`.
 */
function runUnwrap(
  appDir: string,
  options: UnwrapOptions,
  spawn: UnwrapSpawn,
): Buffer | undefined | PromiseLike<Buffer | undefined> {
  const platform = options.platform ?? process.platform
  const statePath = join(appDir, 'Local State')
  // Read before the cache lookup, not after: a stat is a few microseconds and
  // it is the only thing standing between a reinstall and a permanent
  // "unreadable" verdict, so it is not worth deferring to the miss path.
  const identity = localStateIdentity(statePath)
  const cached = cachedKeyFor(keyCache.get(appDir), identity)
  if (cached !== undefined) return cached
  // Inside the failure window, do not spawn the child again (issue 07): on a
  // machine that cannot unwrap, retrying on every request would pay the cost
  // over and over for a known answer. The recorded reason is still served to
  // the card, so the panel keeps saying WHY rather than being blanked.
  if (options.force !== true && failureStillBlocks(lastUnwrapFailure.get(appDir), identity)) {
    return undefined
  }
  if (identity === undefined) {
    // No `Local State`: the app is not installed under this name. Reported
    // below like any other failure, minus the diagnostic, because this is the
    // normal outcome of probing the several names a region knows.
    return recordUnwrapFailure(appDir, 'no Local State file', identity)
  }
  // The unwrap is a PowerShell + DPAPI script and DPAPI is Windows-only, so on
  // macOS and Linux there is nothing to run. Checked HERE, before the spawn,
  // for two reasons.
  //
  // The first is honesty. Without this, the child fails with an exec error on a
  // path like `C:\Windows\System32\...\powershell.exe`, and that string is what
  // the account panel shows — a Windows path on a Mac, which tells the user
  // nothing. Worse, if the app genuinely has no sign-in the same code path
  // reports `no Local State file`, and both answers end in the card saying
  // "make sure a signed-in Qoder client is on this machine" to someone who has
  // one. The sign-in is right there; the plugin simply cannot read it here.
  //
  // The second is cost: this is checked before the temp directory is created
  // and before a child is spawned, so a non-Windows host never writes a
  // hand-off file it cannot use.
  if (platform !== 'win32') {
    return recordUnwrapFailure(
      appDir,
      `this plugin can only read the Qoder sign-in on Windows; ${platform} has no supported keychain path yet`,
      identity,
    )
  }
  // `dir` and `lastFailure` are assigned inside `settle`, which runs AFTER the
  // child exits on the async path — so they cannot be `const`, and both need
  // their types stated for the same reason: no initializer to infer from.
  let dir: string | undefined
  let key: Buffer | undefined
  let lastFailure: string | undefined
  /**
   * Zero the hand-off file and remove the directory, then hand back the key.
   *
   * Takes the key as an argument rather than closing over it, because the
   * async path discovers the key AFTER the child exits: a closure would capture
   * `undefined` and the cleanup would return the wrong answer.
   */
  const settle = (found: Buffer | undefined): Buffer | undefined => {
    key = found
    if (dir !== undefined) {
      // Zero the key bytes before unlink: removing the file does not clear
      // the sectors, so a spinning disk (or an AV quarantine snapshot) would
      // keep them recoverable.
      zeroOutFile(join(dir, 'key.b64'))
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        // Blocked only while some handle on the file is still open — in
        // practice a killed child whose kernel teardown has not caught up
        // (see `zeroOutFile`). Reported rather than thrown, so a surviving
        // directory is a logged hazard whose remaining owner is the next
        // startup sweep — which is a plugin start away, not a timer.
        reportCleanupFailure(
          `could not remove the credential temp dir ${dir}: ${describeThrown(error)}`,
        )
      }
    }
    return key
  }
  try {
    dir = mkdtempSync(join(tmpdir(), 'qoder-oscrypt-'))
    // Identity marker: the startup sweep only reclaims a directory that
    // carries this file, so name-prefix collisions (another tool's
    // `qoder-oscrypt-*`, or a junction wearing that name) are never touched.
    // Written before the child starts — and before any secret byte exists —
    // so the ordering rule from the ACL comment holds. If this write fails,
    // the whole unwrap aborts through the same catch: a directory that cannot
    // be marked must not leak un-marked, because then it could never be swept.
    writeFileSync(join(dir, OSCRYPT_MARKER), '')
    const outFile = join(dir, 'key.b64')
    const spawned = spawn(systemPowershell(), ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 30000,
      env: unwrapEnv(appDir, outFile),
    })
    // The sync runner answers `undefined` and the async one a promise, so the
    // branch is decided on the VALUE. `PromiseLike<unknown>` rather than a bare
    // `unknown` because `.then` is called on it two lines down — the probe is
    // what makes the cast safe, not a wish.
    if (
      spawned !== undefined &&
      typeof (spawned as PromiseLike<unknown>).then === 'function'
    ) {
      // The async path. The cleanup cannot run until the child is done, or the
      // temp directory would be removed underneath a live process — so it runs
      // in the promise chain rather than in a `finally`, and the whole tail of
      // the synchronous function is mirrored by the two handlers below.
      return (spawned as PromiseLike<unknown>).then(
        () => {
          // `readUnwrappedKey` is the one step that can THROW, and a bare throw
          // here would reject the promise without reaching `settle` — leaving
          // the child's `key.b64` in `%TEMP%` and recording no failure reason,
          // so the card would report an ordinary "not signed in". The sync tail
          // cannot lose that way: its read sits inside the `try` above, so its
          // `catch` still runs `settle(undefined)`.
          let read: UnwrappedKeyRead
          try {
            read = readUnwrappedKey(outFile)
          } catch (error) {
            return finishUnwrap(appDir, settle(undefined), describeUnwrapError(error), identity)
          }
          if (read.failure !== undefined) lastFailure = read.failure
          return finishUnwrap(appDir, settle(read.key), lastFailure, identity)
        },
        (error) => {
          // The child failed or timed out. `settle(undefined)` still zeroes and
          // removes the directory, so a failed unwrap leaves no key behind.
          return finishUnwrap(appDir, settle(undefined), describeUnwrapError(error), identity)
        },
      )
    }
    // `read.key` is what the child actually produced; `key` the outer variable is
    // the SETTLED value, which is why it is assigned here rather than read.
    const read = readUnwrappedKey(outFile)
    if (read.failure !== undefined) lastFailure = read.failure
    return finishUnwrap(appDir, settle(read.key), lastFailure, identity)
  } catch (error) {
    // Keep enough of the cause to be diagnosable. This used to be a bare
    // `catch {}`, which made a missing app, a DPAPI failure, an absent
    // PowerShell and a changed `Local State` format all look identical from
    // the outside: the region simply never appeared, with nothing logged.
    //
    // Reached when the setup itself failed — `mkdtempSync`, the marker write, or
    // the child spawn throwing. In that case there is no key, and `key` is
    // still `undefined` because only `settle` assigns it.
    lastFailure = describeUnwrapError(error)
  }
  return finishUnwrap(appDir, settle(key), lastFailure, identity)
}

/**
 * Read the hand-off file the child wrote.
 *
 * @param outFile - where the child wrote the base64 key.
 * @returns `{ key }` when it decoded to a real 32-byte master key, or
 *   `{ failure }` naming why it did not. The two are separate fields rather
 *   than one value because a wrong-size key is a DIFFERENT failure from an
 *   empty file, and both are reported.
 */
function readUnwrappedKey(outFile: string): UnwrappedKeyRead {
  const text = readFileSync(outFile, 'utf8').trim()
  if (text.length === 0) return { failure: 'the unwrap produced an empty key file' }
  const candidate = Buffer.from(text, 'base64')
  if (candidate.length !== 32) {
    return { failure: `Local State unwrapped to ${candidate.length} bytes, expected 32` }
  }
  return { key: candidate }
}

/**
 * Record a failure, emit the diagnostic, and answer `undefined`.
 *
 * Split out so the "no `Local State`" early return and the post-spawn failure
 * path cannot drift on when they report: the first is the normal outcome of
 * probing several app names and stays out of the log, everything else is a real
 * problem the user has to see.
 */
function recordUnwrapFailure(
  appDir: string,
  reason: string | undefined,
  identity: string | undefined,
): undefined {
  lastUnwrapFailure.set(appDir, { reason: String(reason), at: Date.now(), identity })
  if (reason !== 'no Local State file') {
    reportCleanupFailure(`could not unwrap the OSCrypt key for ${appDir}: ${reason}`)
  }
  return undefined
}

/** The one place a fresh key replaces a remembered failure, and vice versa. */
function finishUnwrap(
  appDir: string,
  key: Buffer | undefined,
  lastFailure: string | undefined,
  identity: string | undefined,
): Buffer | undefined {
  if (key === undefined) return recordUnwrapFailure(appDir, lastFailure, identity)
  lastUnwrapFailure.delete(appDir)
  keyCache.set(appDir, { key, identity })
  return key
}

/** Name the cause of a failed child, keeping enough to diagnose it. */
function describeUnwrapError(error: unknown): string {
  const failure = error as { status?: unknown; signal?: unknown; message?: unknown } | undefined
  return failure?.status !== undefined
    ? `PowerShell exited ${String(failure.status)}${failure.signal ? ` (${String(failure.signal)})` : ''}`
    : String(failure?.message ?? error)
}

/** Run the DPAPI child, blocking. */
function spawnUnwrapSync(
  powershell: string,
  args: string[],
  options: Parameters<typeof execFileSync>[2],
): undefined {
  execFileSync(powershell, args, options)
  return undefined
}

/** Run the DPAPI child without blocking the event loop. */
function spawnUnwrapAsync(
  powershell: string,
  args: string[],
  options: Parameters<typeof execFileSync>[2],
): Promise<undefined> {
  return new Promise((resolve, reject) => {
    execFile(powershell, args, options, (error) => {
      if (error) reject(error)
      else resolve(undefined)
    })
  })
}

/**
 * The system Windows PowerShell, by absolute path.
 *
 * A bare `powershell.exe` resolves through CWD/PATH, so a same-user program
 * could plant a fake interpreter in the working directory or ahead on PATH
 * and hijack the entire unwrap — running with the hand-off environment in
 * hand. Pinning the system binary closes that; on a machine without it the
 * call fails and the unwrap degrades to "key unavailable" like any other.
 */
function systemPowershell() {
  return join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

/**
 * The environment of the unwrap child process: a minimal whitelist plus the
 * two hand-off variables.
 *
 * Expanding the whole `process.env` (the old behaviour) carried every
 * user-supplied secret — a `QODER_PAT` fallback token among them — into the
 * child's environment block, readable by every same-user process; next to the
 * fake-`powershell.exe` vector that was a free credential hand-off. The
 * DPAPI script itself consults only `QODER_APP_DIR`, `QODER_KEY_OUT` and the
 * system variables PowerShell and its C# compiler need.
 */
const PS_ENV_ALLOWLIST = [
  'SYSTEMDRIVE',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'COMSPEC',
  'PATHEXT',
  'PATH',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'NUMBER_OF_PROCESSORS',
  'USERNAME',
  'USERPROFILE',
  'LOGONSERVER',
]

function unwrapEnv(appDir: string, outFile: string): Record<string, string | undefined> {
  const allowed = new Set(PS_ENV_ALLOWLIST.map((name) => name.toLowerCase()))
  const env: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (allowed.has(name.toLowerCase())) env[name] = value
  }
  env.QODER_APP_DIR = appDir
  env.QODER_KEY_OUT = outFile
  return env
}

/**
 * Overwrite a file's bytes with zeros, best-effort, with a short retry.
 *
 * A failed overwrite used to be swallowed outright, which turned a real hazard
 * into a silent one. The caller that can hit a lock is {@link oscryptKeyFor}
 * running right after a timeout killed the PowerShell child. A killed process
 * never runs its `finally` — its handles are closed by the kernel tearing the
 * process object down, and that teardown is asynchronous. So the `finally` can
 * arrive while the child's exclusive (`FileShare.None`) handle on `key.b64` is
 * still open: on Windows the open then fails with EBUSY, and so does the
 * unlink that follows. Zeroing used to drop that error, the `rmSync` used to
 * throw into a bare catch, and the app's 32-byte master key sat in `%TEMP%` as
 * plain base64 — readable by any same-user process — with no report, until the
 * next plugin start, because `sweepStaleOscryptDirs` runs once at startup, not
 * on a timer.
 *
 * The retry waits out the kernel teardown, which normally finishes within a
 * few hundred milliseconds; what remains is reported rather than dropped, so a
 * surviving key file is a logged hazard, never an inferred one.
 *
 * @param file - the path to overwrite.
 * @param attempts - how many times to try; each retry waits a little longer,
 *   since the usual cause is a killed child whose teardown has not finished.
 * @returns `true` when the file is gone or was fully zeroed, `false` when it
 *   still exists with its bytes intact, or is not a plain file to begin with.
 */
export function zeroOutFile(file: string, attempts = 4): boolean {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(file)
  } catch {
    // Never existed, or already removed. Nothing to clear.
    return true
  }
  if (!stat.isFile()) {
    // An `r+` open FOLLOWS a symlink, so zeroing "our" file would overwrite
    // whatever the link points at — a same-user attacker who can swap a file
    // in a stale temp dir gets to destroy anything the account can read.
    // Refuse links and irregular entries outright; `rmSync` removes a link
    // without following, so callers still reclaim the directory.
    reportCleanupFailure(
      `refused to zero ${file}: not a plain file (mode ${(stat.mode & 0o7777).toString(8)})`,
    )
    return false
  }
  if (stat.size <= 0) return true
  const size = stat.size
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) sleepSync(ZERO_RETRY_BACKOFF_MS * attempt)
    let fd: number
    try {
      fd = openSync(file, 'r+')
    } catch (error) {
      // A file that vanished between the stat and the open is a success, not a
      // failure; anything else is a lock we may be able to win on the retry.
      if (!existsSync(file)) return true
      lastError = error
      continue
    }
    try {
      const block = Buffer.alloc(Math.min(ZERO_BLOCK_BYTES, size))
      let offset = 0
      while (offset < size) {
        const length = Math.min(block.length, size - offset)
        writeSync(fd, block, 0, length, offset)
        offset += length
      }
      return true
    } catch (error) {
      lastError = error
    } finally {
      try {
        closeSync(fd)
      } catch {
        // The descriptor is already gone; the unlink below is the fallback.
      }
    }
  }
  // The bytes are still on disk. Before giving up, one last resort: truncate
  // to zero, so a surviving file holds no plaintext even if it cannot be
  // removed. On Windows this usually also fails for the same reason the write
  // did — the killed child's exclusive (`FileShare.None`) handle blocks open
  // for write, and Node's `truncate` opens for write (measured: EBUSY on
  // truncate, unlink, and rm alike while the handle is live) — so this is
  // best-effort, worth it on POSIX where the block is the directory unlink
  // rather than the file open. It never throws past here.
  //
  // The real mitigation for the Windows case is the retry window above, which
  // waits out the asynchronous kernel teardown, plus the startup sweep: what
  // survives this call is a *logged* hazard whose owner is the next sweep.
  try {
    truncateSync(file, 0)
  } catch {
    // Still locked; nothing more to do but report it below.
  }
  // Say so, loudly, unless the truncate above won the race and cleared it.
  if (existsSync(file) && currentSize(file) > 0) {
    reportCleanupFailure(
      `could not zero ${file} after ${attempts} attempts (${(lastError as { message?: string } | undefined)?.message ?? 'unknown'})`,
    )
    return false
  }
  return true
}

/** The current byte length of a file, or 0 when it cannot be stat'd (gone). */
function currentSize(file: string): number {
  try {
    return lstatSync(file).size
  } catch {
    return 0
  }
}

/**
 * Decrypt one Chromium OSCrypt blob.
 *
 * @param blob - the raw stored bytes, including the `v10` prefix.
 * @param key - the 32-byte AES key from {@link oscryptKeyFor}.
 * @returns the plaintext, or `undefined` when authentication fails.
 */
export function decryptOscrypt(blob: Buffer, key: Buffer): string | undefined {
  if (blob.length < 3 + 12 + 16) return undefined
  if (blob.subarray(0, 3).toString('latin1') !== 'v10') return undefined
  const body = blob.subarray(3)
  const nonce = body.subarray(0, 12)
  const tag = body.subarray(body.length - 16)
  const ciphertext = body.subarray(12, body.length - 16)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * The 32-byte AES key of one app, if one is already cached and current.
 *
 * This variant is honest about what it knows: it answers from the cache or not
 * at all. The caller then reports `needs-app` with whatever reason the unwrap
 * layer already recorded, which is the same thing the user needs to see, and
 * the next scheduled refresh retries the unwrap on its own schedule rather
 * than on a card render.
 *
 * @param appDir - absolute Electron user-data directory for the app.
 * @returns the 32-byte AES key if one is already cached and current, else
 *   `undefined`.
 */
export function cachedOscryptKeyFor(appDir: string): Buffer | undefined {
  return cachedKeyFor(keyCache.get(appDir), localStateIdentity(join(appDir, 'Local State')))
}

/**
 * Reclaim the `qoder-oscrypt-*` dirs a crash left in the temp dir; the name is only a
 * candidate — a dir is touched only when it is a real directory (never a junction or
 * symlink) with our marker and a 32-byte `key.b64`, and is older than `maxAgeMs`.
 * @returns the number of directories reclaimed.
 */
export function sweepStaleOscryptDirs(maxAgeMs = 5 * 60 * 1000) {
  let names
  try {
    names = readdirSync(tmpdir())
  } catch {
    return 0
  }
  const cutoff = Date.now() - maxAgeMs
  let reclaimed = 0
  for (const name of names) {
    if (!name.startsWith('qoder-oscrypt-')) continue
    const dir = join(tmpdir(), name)
    let link
    try {
      link = lstatSync(dir)
    } catch {
      continue
    }
    // Check 1: never follow a link out of the temp dir. `lstat` on a Windows
    // junction reports isSymbolicLink(); a plain file or a vanished entry is
    // equally not-ours.
    if (link.isSymbolicLink()) {
      reportCleanupFailure(
        `refused to sweep ${dir}: it is a symbolic link, not a credential temp dir`,
      )
      continue
    }
    if (!link.isDirectory() || link.mtimeMs > cutoff) continue
    // Check 2: identity by marker, and nothing foreign riding along.
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    if (!entries.includes(OSCRYPT_MARKER)) continue
    if (entries.length !== 2 || !entries.includes('key.b64')) {
      reportCleanupFailure(
        `left ${dir} alone: it carries our marker but its contents are ${JSON.stringify(entries)}`,
      )
      continue
    }
    // Check 3: the key file must look like a master key, not arbitrary bytes —
    // but only when it can be READ. A `key.b64` we cannot open is the exact
    // locked-by-a-live-handle shape this sweep exists to report and retry, so
    // read failure falls through to the reclaim attempt below rather than
    // silently skipping. The size check refuses to delete *readable* content
    // that does not match a 32-byte key: foreign bytes wearing our name.
    const keyFile = join(dir, 'key.b64')
    let unlockedBytes
    try {
      unlockedBytes = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64').length
    } catch {
      unlockedBytes = 32 // unreadable: ours-but-locked, handled below
    }
    if (unlockedBytes !== 32) {
      reportCleanupFailure(
        `left ${keyFile} alone: it decodes to ${unlockedBytes} bytes, not a 32-byte master key`,
      )
      continue
    }
    try {
      zeroOutFile(keyFile)
      zeroOutFile(join(dir, OSCRYPT_MARKER))
      rmSync(dir, { recursive: true, force: true })
      reclaimed += 1
    } catch (error) {
      // Still held by a live process, or the dir vanished under us; its own
      // cleanup (or the next sweep) takes it. Reported, because this directory
      // holds a master key in plain text and the next sweep is a plugin start
      // away — possibly days.
      reportCleanupFailure(
        `could not reclaim the stale credential temp dir ${dir}: ${describeThrown(error)}`,
      )
    }
  }
  return reclaimed
}
