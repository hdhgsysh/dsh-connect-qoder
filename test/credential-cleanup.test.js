/**
 * Tests for the credential temp-file cleanup.
 *
 * Run: node --test test/credential-cleanup.test.js
 *
 * The unwrap hands the app's 32-byte master key to JavaScript through a
 * `%TEMP%` file, and that file is the one place in this plugin where a secret
 * exists outside the process. Its removal is a security property, not
 * housekeeping — the README promises the plugin "stores no credentials", and a
 * leftover `key.b64` breaks that promise for every same-user process on the box
 * until something reclaims it.
 *
 * The failure this file guards was a silent one. When the PowerShell child is
 * killed by the unwrap timeout, its exclusive (`FileShare.None`) handle on
 * `key.b64` is closed by the kernel asynchronously — a killed process runs no
 * `finally` — and until that teardown finishes, `zeroOutFile` fails its open
 * and `rmSync` fails too. `zeroOutFile` used to swallow every error, so the key
 * sat in TEMP as plain base64 with no report, and the next reclaim was a plugin
 * start away (the entry sweeps once at activation, not on a timer). The fix is
 * a short retry that waits out the teardown, and a report when the hazard
 * survives anyway. This file asserts both.
 *
 * PLATFORM: the hand-off only exists on Windows (DPAPI), so the locked-file
 * assertions are gated to `win32`; the reclaim and age-guard behaviour is
 * asserted everywhere. The lock is taken by a real PowerShell child, not by a
 * second Node handle — libuv opens files with `FILE_SHARE_READ|WRITE|DELETE`,
 * so a Node-side "lock" blocks nothing and the branch under test never runs.
 * (An earlier revision of this file made exactly that mistake; and an earlier
 * probe compared a file the holder never touched and drew the opposite
 * conclusion. Both are recorded here so neither is re-derived by feel.)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sweepStaleOscryptDirs, setCredentialDiagnosticSink } from '../lib/credentials.js'

/** A fixed, obviously-fake key body — the point is the file, not the secret. */
const KEY_BODY = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5'

/** Older than any sweep guard used here, so the sweep treats it as orphaned. */
const STALE_MS = 10 * 60 * 1000

/**
 * A scratch `qoder-oscrypt-*` directory holding an aged key file.
 *
 * Named to match the prefix the sweep looks for, so the sweep is exercised
 * against the real naming rather than a directory it would skip. The directory
 * is aged AFTER the file is written: writing it touches the parent's mtime,
 * and the sweep's guard is the directory's own clock.
 */
function makeKeyDir(ageMs = STALE_MS) {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-oscrypt-'))
  const file = join(dir, 'key.b64')
  writeFileSync(file, KEY_BODY, 'utf8')
  const old = new Date(Date.now() - ageMs)
  utimesSync(dir, old, old)
  return { dir, file }
}

/** Capture what the module reports, for the duration of one test. */
function captureDiagnostics() {
  const messages = []
  setCredentialDiagnosticSink((message) => messages.push(String(message)))
  return messages
}

test('a stale key directory is reclaimed', () => {
  const { dir, file } = makeKeyDir()
  const messages = captureDiagnostics()
  try {
    const reclaimed = sweepStaleOscryptDirs(0)
    assert.ok(reclaimed >= 1, 'the aged directory must be reclaimed')
    assert.equal(existsSync(file), false, 'the key file must not survive the sweep')
    assert.deepEqual(messages, [], 'an ordinary reclaim is not a problem to report')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    setCredentialDiagnosticSink(undefined)
  }
})

test('a fresh directory is left alone, because another instance may be using it', () => {
  // The sweep's age guard is what makes it safe to call while a concurrent DSH
  // is unwrapping. Removing it would let one process delete a key file out from
  // under another that is still reading it.
  const { dir, file } = makeKeyDir(0)
  const messages = captureDiagnostics()
  try {
    const reclaimed = sweepStaleOscryptDirs(5 * 60 * 1000)
    assert.equal(reclaimed, 0, 'a directory younger than the guard must not be touched')
    assert.deepEqual(messages, [], 'and it must not be reported as a problem')
    assert.equal(readFileSync(file, 'utf8'), KEY_BODY, 'its key file must still be intact')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    setCredentialDiagnosticSink(undefined)
  }
})

/**
 * Spawn PowerShell to hold `file` with FileShare.None — exactly the shape of
 * the handle a mid-teardown killed child still has open. Resolves only after
 * the holder confirms it owns the handle, so no assertion below can run
 * against an unlocked file.
 */
function lockViaPowerShell(file, holdMs = 5000) {
  const child = spawn(
    join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "$h=[System.IO.File]::Open($env:QODER_LOCK_FILE,'Open','ReadWrite','None');" +
        "[Console]::Out.WriteLine('holder: opened');[Console]::Out.Flush();" +
        `Start-Sleep -Milliseconds ${holdMs};$h.Dispose()`,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, QODER_LOCK_FILE: file },
    },
  )
  const ready = new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(
      () => reject(new Error(`PowerShell never reported the handle held; output: ${text}`)),
      20000,
    )
    child.stdout.on('data', (data) => {
      text += data.toString()
      if (text.includes('holder: opened')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return {
    async stop() {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    },
    ready,
  }
}

test(
  'a key file locked by the killed child is reported, and a sibling is still reclaimed',
  { skip: process.platform === 'win32' ? false : 'the DPAPI hand-off exists only on Windows' },
  async () => {
  // Two aged directories, and a REAL exclusive lock on the first one's file —
  // this asserts both halves of the fix at once:
  //
  //   1. the locked file produces a report (`could not zero` / `could not
  //      reclaim`) naming what survived — the regression, invisible before the
  //      fix because every cleanup error was swallowed;
  //   2. the sweep does not abort on it — the unlocked sibling must still be
  //      reclaimed, since the sweep's whole job is to clear EVERY orphan out
  //      of TEMP, not just the first one it reaches.
  const locked = makeKeyDir()
  const sibling = makeKeyDir()
  const messages = captureDiagnostics()
  const holder = lockViaPowerShell(locked.file)
  try {
    await holder.ready
    // Prove the lock is live by hitting it, not by reading through it:
    // FileShare.None blocks READING too (measured: readFileSync fails EBUSY
    // while held), so the ordinary "still there, still intact" check is
    // exactly what this lock forbids. The failing open is both the precondition
    // of everything below and the same wall `zeroOutFile` is about to hit.
    assert.equal(canOpenReadWrite(locked.file), false, 'the handle must block Node opens before the sweep runs')

    const reclaimed = sweepStaleOscryptDirs(0)

    assert.ok(
      messages.some((m) => /could not zero|could not reclaim/.test(m)),
      `the surviving key file must be reported; got: ${JSON.stringify(messages)}`,
    )
    assert.ok(
      messages.some((m) => m.includes(locked.file) || m.includes(locked.dir)),
      'the report must name the file or directory it could not clear',
    )
    assert.equal(existsSync(sibling.file), false, 'the unlocked sibling must still be reclaimed')
    assert.ok(reclaimed >= 1)
  } finally {
    await holder.stop()
    // A failed cleanup must never mask or replace an error already thrown in
    // the try — the same finally-shadowing rule asserted in `oscryptKeyFor`.
    // The kill is asynchronous teardown, so the retries wait it out; anything
    // still left becomes the next startup sweep's problem, as in production.
    try {
      rmSync(locked.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch {
      // The live-process contract says it must never outlive this file's run;
      // the sweep reclaims it next start. Left on purpose.
    }
    try {
      rmSync(sibling.dir, { recursive: true, force: true })
    } catch {
      // Same.
    }
    setCredentialDiagnosticSink(undefined)
  }
})

/** Whether the file can be opened read-write right now (false = a lock holds it). */
function canOpenReadWrite(file) {
  try {
    closeSync(openSync(file, 'r+'))
    return true
  } catch {
    return false
  }
}

test('the sweep is inert when the temp root cannot be read', () => {
  // A failing readdirSync must return 0, not throw — the plugin entry calls
  // this at startup, and housekeeping must never stop the plugin from starting.
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }
  try {
    const missing = join(tmpdir(), `no-such-dir-dsh-qoder-${process.pid}`)
    process.env.TMPDIR = missing
    process.env.TEMP = missing
    process.env.TMP = missing
    assert.equal(sweepStaleOscryptDirs(0), 0, 'an unreadable temp root is zero, never an exception')
  } finally {
    Object.assign(process.env, saved)
  }
})
