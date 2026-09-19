/**
 * Qoder credential acquisition.
 *
 * The Qoder desktop apps (Qoder CN, Qoder, QoderWork CN) keep their sign-in in
 * a VS Code style SQLite store (`state.vscdb`) whose secret rows are Chromium
 * OSCrypt blobs: `"v10" || nonce(12) || ciphertext || tag(16)`, encrypted with
 * an AES-256-GCM key that is itself wrapped by the OS keystore and kept in the
 * app's `Local State` under `os_crypt.encrypted_key`.
 *
 * On Windows that wrapper is DPAPI scoped to the current user, which is why any
 * process running as the same user can unwrap it — that is the property this
 * module relies on. The unwrap is delegated to PowerShell because Node has no
 * built-in DPAPI binding, and the result is exchanged through a temp file
 * rather than a pipe so the call also works under a sandbox that forbids
 * piped stdio.
 *
 * Nothing here writes to the Qoder apps' files: the store is opened read-only.
 *
 * @module dsh-connect-qoder/credentials
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

/** SQLite key holding the signed-in identity, including its access token. */
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
 */
export const REGIONS = [
  {
    id: 'qoder-cn',
    mode: 'cn',
    displayName: 'Qoder CN',
    appNames: ['QoderCN', 'Qoder CN', 'QoderWork CN'],
    baseUrl: 'https://gateway.qoder.com.cn/',
    openApiUrl: 'https://openapi.qoder.com.cn',
    centerUrl: 'https://gateway.qoder.com.cn',
    manageUrl: 'https://qoder.com.cn',
    patEnvNames: ['QODERCN_API_KEY', 'QODERCN_PERSONAL_ACCESS_TOKEN', 'QODERCN_PAT'],
  },
  {
    id: 'qoder',
    mode: 'global',
    displayName: 'Qoder',
    appNames: ['Qoder', 'QoderWork'],
    baseUrl: 'https://api3.qoder.sh/',
    openApiUrl: 'https://openapi.qoder.sh',
    centerUrl: 'https://center.qoder.sh',
    manageUrl: 'https://qoder.com',
    patEnvNames: ['QODER_API_KEY', 'QODER_PERSONAL_ACCESS_TOKEN', 'QODER_PAT'],
  },
]

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
[System.IO.File]::WriteAllText($env:QODER_KEY_OUT, [Convert]::ToBase64String($key))
`

/** Per-app OSCrypt key cache; the DPAPI unwrap is not free, so do it once. */
const keyCache = new Map()

/**
 * Unwrap one app's OSCrypt key.
 *
 * @param appDir - absolute Electron user-data directory for the app.
 * @returns the 32-byte AES key, or `undefined` when it cannot be obtained.
 */
export function oscryptKeyFor(appDir) {
  if (keyCache.has(appDir)) return keyCache.get(appDir)
  let key
  const statePath = join(appDir, 'Local State')
  if (existsSync(statePath)) {
    let dir
    try {
      dir = mkdtempSync(join(tmpdir(), 'qoder-oscrypt-'))
      const outFile = join(dir, 'key.b64')
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT],
        {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 30000,
          env: { ...process.env, QODER_APP_DIR: appDir, QODER_KEY_OUT: outFile },
        },
      )
      const text = readFileSync(outFile, 'utf8').trim()
      if (text.length > 0) {
        const candidate = Buffer.from(text, 'base64')
        if (candidate.length === 32) key = candidate
      }
    } catch {
      key = undefined
    } finally {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
  }
  keyCache.set(appDir, key)
  return key
}

/**
 * Decrypt one Chromium OSCrypt blob.
 *
 * @param blob - the raw stored bytes, including the `v10` prefix.
 * @param key - the 32-byte AES key from {@link oscryptKeyFor}.
 * @returns the plaintext, or `undefined` when authentication fails.
 */
export function decryptOscrypt(blob, key) {
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
 * Read one secret row from a VS Code style `state.vscdb`.
 *
 * The value column is a JSON envelope (`{"type":"Buffer","data":[...]}`) for
 * secret rows; anything else is returned as-is.
 *
 * @returns the raw bytes for a Buffer row, a string for a plain row, or
 *   `undefined` when the key is absent.
 */
function readItem(dbPath, key) {
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
function readJsonSecret(dbPath, key, oscryptKey) {
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
function stateDbCandidates(appDir) {
  return [
    join(appDir, 'User', 'globalStorage', 'state.vscdb'),
    join(appDir, 'User', 'globalStorage', 'state.vscdb.backup'),
  ]
}

/**
 * The machine id Qoder binds its session to.
 *
 * `machineid` sits beside `Local State`; when it is missing a stable value is
 * derived from the app directory so repeated runs still agree with each other.
 */
function machineIdFor(appDir, fallback) {
  for (const name of ['machineid', 'machineId']) {
    const p = join(appDir, name)
    if (!existsSync(p)) continue
    const value = readFileSync(p, 'utf8').trim()
    if (value.length > 0) return value
  }
  return fallback
}

/**
 * Load one region's credential from the local Qoder apps.
 *
 * Every candidate app is tried in order; the first that yields a decryptable
 * `userInfo` row wins. A credential whose access token has expired is still
 * returned — the caller decides whether to refresh it — but `expired` says so.
 *
 * @returns a credential record, or `undefined` when no app holds a usable one.
 */
export function loadCredential(region, appDataRoot) {
  for (const appName of region.appNames) {
    const appDir = join(appDataRoot, appName)
    if (!existsSync(appDir)) continue
    const oscryptKey = oscryptKeyFor(appDir)
    if (oscryptKey === undefined) continue
    for (const dbPath of stateDbCandidates(appDir)) {
      if (!existsSync(dbPath)) continue
      let userInfo
      try {
        userInfo = readJsonSecret(dbPath, USER_INFO_KEY, oscryptKey)
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
  }
  return undefined
}

/** Run a reader, mapping any failure to `undefined`. */
function safeRead(fn) {
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
export function loadEnvCredential(region, env = process.env) {
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
