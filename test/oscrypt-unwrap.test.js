/**
 * The OSCrypt chain, exercised through its injected spawner.
 *
 * Run: node --test test/oscrypt-unwrap.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * `src/host/oscrypt-unwrap.ts` is the only part of credential acquisition that
 * writes a secret OUTSIDE the process (a plaintext master key in a temp file),
 * that spawns a child process, and that deletes things. It is also the part that
 * was hardest to test: the unwrap needs a real PowerShell, a real DPAPI
 * wrapper and a real signed-in Qoder, so the coverage report kept listing the
 * lines between "temp dir created" and "key read back" as untested — the
 * `mkdtemp` call, the identity marker, the read, the error paths, the async
 * tail. On a machine that has a signed-in Qoder those lines run, but the
 * assertions live in a test that skips itself on everyone else's box.
 *
 * Both unwrap entries now take the spawner as an argument. A fake spawner that
 * writes the hand-off file exactly as the real interpreter would makes every
 * one of those lines reachable on ANY machine, with no PowerShell, no DPAPI and
 * no user sign-in — which is what this file does.
 *
 * WHAT IT PINS
 *
 * - the key the child wrote is the key the caller gets, on both paths;
 * - the temp directory carries our identity marker and is gone afterwards, on
 *   the success path AND on every failure path (the residue property: a master
 *   key in `%TEMP%` must not outlive the call);
 * - a failure is remembered with a reason the card can show, and the "app is
 *   not installed" case is NOT reported as a problem;
 * - the child process never inherits a user-supplied PAT, and the interpreter
 *   is the system one, addressed absolutely;
 * - a host that is not Windows is told WHY it cannot read the sign-in, and
 *   nothing is spawned and no temp file is created for it;
 * - the zeroing overwrites the bytes, and refuses a target that is not a plain
 *   file instead of following it out of the temp dir (the out-of-bounds rule).
 */
import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The module under test can be pointed at a COPY of the source. That is how
// `test/mutation-gates.test.js` asks whether the guards in this chain are
// load-bearing: it deletes a guard in the copy and requires the assertions
// below to notice. With no override this is the checked-in module, so an
// ordinary run still tests the real thing.
const OSCryptModule = process.env.DSH_OSCRYPT_MODULE
  ? pathToFileURL(process.env.DSH_OSCRYPT_MODULE).href
  : new URL('../src/host/oscrypt-unwrap.ts', import.meta.url).href

const {
  describeUnwrapFailure,
  oscryptKeyFor,
  oscryptKeyForAsync,
  setCredentialDiagnosticSink,
  sweepStaleOscryptDirs,
  zeroOutFile,
} = await import(OSCryptModule)

/** The 32 bytes a real OSCrypt master key has. */
const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8')

/**
 * The platform these tests claim to be on.
 *
 * The unwrap is PowerShell + DPAPI, so the module refuses to run anywhere but
 * Windows — and it reads `process.platform` when the caller names no platform.
 * On a Linux CI runner that refusal would reach the assertions below as "the
 * unwrap answered with no key", which is a DIFFERENT failure from the one
 * these tests are about. Naming the platform is what lets the fake spawner
 * make the whole chain reachable on ANY machine — the promise this file makes
 * in its header — instead of only on the Windows box that runs it today.
 */
const WINDOWS = { platform: 'win32' }

/** The scratch root the module's temp dirs must land in. */
let tempRoot = ''

/** The env the module read before the test replaced it. */
const savedEnv = {}

/**
 * Point `os.tmpdir()` at a scratch directory.
 *
 * Node reads the temp location from the environment on every call, so setting
 * it here redirects BOTH the module's `mkdtempSync(join(tmpdir(), …))` and this
 * file's own bookkeeping — the module never learns the difference, which is
 * exactly what makes the assertions below trustworthy: if the module wrote its
 * hand-off file anywhere else, it would survive the test and be found by the
 * "no residue" assertions.
 */
before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'qoder-unwrap-'))
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) {
    savedEnv[name] = process.env[name]
    process.env[name] = tempRoot
  }
  assert.equal(tmpdir(), tempRoot, 'the scratch temp root must be the one the module sees')
})

after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(tempRoot, { recursive: true, force: true })
})

/** Every diagnostic the module emitted during one test. */
let messages = []
beforeEach(() => {
  messages = []
  setCredentialDiagnosticSink((m) => messages.push(String(m)))
})
afterEach(() => {
  setCredentialDiagnosticSink(undefined)
})

/**
 * An app directory that looks installed: a `Local State` file with a key in
 * it. The unwrap refuses to run without one (that is the "app is not here"
 * case), and the identity of this file is what the key cache is bound to.
 */
function appDirWithState(name = 'app') {
  const dir = mkdtempSync(join(tempRoot, `${name}-`))
  writeFileSync(join(dir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'v10AAAA' } }))
  return dir
}

/**
 * A fake spawner: it stands in for the PowerShell child.
 *
 * It receives the same three arguments the real one does, so it can write the
 * hand-off file to the path the module chose (`QODER_KEY_OUT` in the child
 * environment) and record everything the module decided — which interpreter,
 * which arguments, which environment, which temp directory.
 */
function fakeSpawn({ key = KEY, mode = 'sync', fail = false } = {}) {
  const calls = []
  const spawn = (powershell, args, options) => {
    const outFile = options.env.QODER_KEY_OUT
    calls.push({
      powershell,
      args,
      options,
      outFile,
      dir: dirname(outFile),
      markerPresent: existsSync(join(dirname(outFile), '.dsh-oscrypt')),
    })
    if (fail) {
      const error = new Error('the child failed')
      error.status = 1
      if (mode === 'sync') throw error
      return Promise.reject(error)
    }
    writeFileSync(outFile, Buffer.from(key).toString('base64'))
    if (mode === 'sync') return undefined
    return Promise.resolve(undefined)
  }
  spawn.calls = calls
  return spawn
}

/** The temp dirs the module created, by name. */
function tempDirs() {
  return readdirSync(tempRoot).filter((name) => name.startsWith('qoder-oscrypt-'))
}

test('the sync unwrap returns the key the child wrote, and takes its temp dir with it', () => {
  const appDir = appDirWithState('sync-ok')
  const spawn = fakeSpawn()
  const key = oscryptKeyFor(appDir, WINDOWS, spawn)
  assert.ok(key !== undefined, 'a successful unwrap must answer with a key')
  assert.deepStrictEqual(key, KEY, 'the key must be exactly what the child wrote')
  assert.equal(spawn.calls.length, 1, 'the child must be spawned exactly once')
  assert.deepStrictEqual(tempDirs(), [], 'the hand-off directory must not survive the call')
})

test('the async unwrap answers with the same key through the same body', async () => {
  const appDir = appDirWithState('async-ok')
  const spawn = fakeSpawn({ mode: 'async' })
  const key = await oscryptKeyForAsync(appDir, WINDOWS, spawn)
  assert.ok(key !== undefined, 'a successful async unwrap must answer with a key')
  assert.deepStrictEqual(key, KEY)
  assert.deepStrictEqual(tempDirs(), [], 'the hand-off directory must not survive the call')
})

test('the temp dir carries our identity marker before the child is spawned', () => {
  // The sweep only reclaims a directory that proves its identity. A directory
  // that was spawned into WITHOUT the marker could never be swept, so the
  // marker has to be written first — before any secret byte exists.
  const appDir = appDirWithState('marker')
  const spawn = fakeSpawn()
  oscryptKeyFor(appDir, WINDOWS, spawn)
  assert.equal(spawn.calls[0].markerPresent, true, 'the marker must exist when the child starts')
})

test('the child is the system PowerShell, addressed absolutely, with a minimal environment', () => {
  const appDir = appDirWithState('env')
  process.env.QODER_PAT = 'a-user-pat-that-must-not-travel'
  process.env.QODER_API_KEY = 'another-secret'
  try {
    const spawn = fakeSpawn()
    oscryptKeyFor(appDir, WINDOWS, spawn)
    const { powershell, args, options } = spawn.calls[0]
    assert.match(powershell, /powershell\.exe$/i, 'the interpreter must be the system one')
    assert.ok(powershell.includes('System32'), `the interpreter must be addressed absolutely: ${powershell}`)
    assert.deepStrictEqual(args.slice(0, 2), ['-NoProfile', '-NonInteractive'])
    assert.equal(options.timeout, 30000)
    assert.equal(options.windowsHide, true)
    assert.equal(options.env.QODER_APP_DIR, appDir, 'the child must know which app to unwrap')
    assert.ok(options.env.QODER_KEY_OUT, 'the child must know where to hand the key off')
    assert.equal(options.env.QODER_PAT, undefined, "a user's PAT must never reach the child")
    assert.equal(options.env.QODER_API_KEY, undefined, "a user's API key must never reach the child")
  } finally {
    delete process.env.QODER_PAT
    delete process.env.QODER_API_KEY
  }
})

test('a child that fails leaves no temp dir, and the reason is remembered', () => {
  const appDir = appDirWithState('fail-sync')
  const spawn = fakeSpawn({ fail: true })
  const key = oscryptKeyFor(appDir, WINDOWS, spawn)
  assert.equal(key, undefined, 'a failed unwrap must not answer with a key')
  assert.deepStrictEqual(tempDirs(), [], 'a failed unwrap must not leave its hand-off file behind')
  const reason = describeUnwrapFailure(appDir)
  assert.match(String(reason), /PowerShell exited 1/, `the reason must name the failure: ${reason}`)
  assert.ok(messages.length > 0, 'a failure must reach the diagnostic sink')
})

test('a rejected async child is caught, and its temp dir is removed', async () => {
  // The async tail is where a lost cleanup hides: the rejection arrives after
  // the synchronous part of `runUnwrap` has returned, so the zeroing and the
  // removal have to happen in the promise chain. If they did not, this would
  // leave a plaintext master key in the temp dir.
  const appDir = appDirWithState('fail-async')
  const spawn = fakeSpawn({ fail: true, mode: 'async' })
  const key = await oscryptKeyForAsync(appDir, WINDOWS, spawn)
  assert.equal(key, undefined)
  assert.deepStrictEqual(tempDirs(), [], 'a rejected async child must not leave its temp dir behind')
  assert.match(String(describeUnwrapFailure(appDir)), /PowerShell exited 1/)
})

test('a hand-off file that is not a 32-byte key is refused, and the size is named', () => {
  const appDir = appDirWithState('short-key')
  const spawn = fakeSpawn({ key: Buffer.from('too-short', 'utf8') })
  const key = oscryptKeyFor(appDir, WINDOWS, spawn)
  assert.equal(key, undefined, 'a key of the wrong size must not be accepted')
  assert.match(
    String(describeUnwrapFailure(appDir)),
    /unwrapped to 9 bytes, expected 32/,
    'the reason must say what came out, so the user is not left guessing',
  )
  assert.deepStrictEqual(tempDirs(), [], 'the refused hand-off file must still be cleaned up')
})

test('an empty hand-off file is refused', () => {
  const appDir = appDirWithState('empty-key')
  const spawn = fakeSpawn({ key: Buffer.alloc(0) })
  assert.equal(oscryptKeyFor(appDir, WINDOWS, spawn), undefined)
  assert.match(String(describeUnwrapFailure(appDir)), /empty key file/)
})

test('an app that is not installed is not reported as a problem', () => {
  // The reader probes several app names and most of them are not there. If
  // each miss were reported, the user would get a message per render for
  // something that is expected.
  const missing = mkdtempSync(join(tempRoot, 'missing-'))
  const spawn = fakeSpawn()
  assert.equal(oscryptKeyFor(missing, WINDOWS, spawn), undefined)
  assert.deepStrictEqual(messages, [], 'a name that does not exist is not a problem to report')
  assert.equal(spawn.calls.length, 0, 'a missing app must not spawn a child')
})

test('a host that is not Windows is told why, and nothing is spawned', () => {
  // The unwrap is PowerShell + DPAPI. On a Mac or a Linux box there is no
  // equivalent, and the user must be told THAT rather than be shown a Windows
  // path — and nothing may be written to the temp dir for a host that cannot
  // use it.
  const appDir = appDirWithState('darwin')
  const spawn = fakeSpawn()
  const key = oscryptKeyFor(appDir, { platform: 'darwin' }, spawn)
  assert.equal(key, undefined)
  assert.equal(spawn.calls.length, 0, 'no child may be spawned on a platform that cannot unwrap')
  assert.deepStrictEqual(tempDirs(), [], 'no temp dir may be created for a platform that cannot unwrap')
  assert.match(String(describeUnwrapFailure(appDir)), /only read the Qoder sign-in on Windows/)
})

test('the zeroing overwrites the bytes', () => {
  const file = join(tempRoot, 'plain.bin')
  writeFileSync(file, Buffer.alloc(4096, 0x41))
  assert.equal(zeroOutFile(file), true)
  assert.equal(existsSync(file), true, 'the file itself is not removed by the zeroing')
  const after = readFileSync(file)
  assert.equal(after.length, 4096, 'the zeroing overwrites in place; it does not shrink the file')
  assert.ok(
    after.every((byte) => byte === 0),
    'the plaintext must be gone: every byte must be zero',
  )
})

test('the zeroing refuses a target that is not a plain file', () => {
  // An `r+` open FOLLOWS a symlink, so zeroing "our" file would overwrite
  // whatever the link points at. The refusal is the out-of-bounds rule: the
  // sweep may only ever touch what it owns.
  const dir = mkdtempSync(join(tempRoot, 'not-a-file-'))
  assert.equal(zeroOutFile(dir), false, 'a directory is not something to zero')
  assert.ok(
    messages.some((m) => /not a plain file/.test(m)),
    `the refusal must be reported: ${JSON.stringify(messages)}`,
  )
})

test('the sweep reclaims a stale dir of ours, and leaves a foreign one alone', () => {
  // Two kinds of residue, in one place: a directory that proves it is ours
  // (marker + a 32-byte key) must be reclaimed, and one that merely borrows
  // the name prefix must survive untouched — it belongs to somebody else.
  const ours = join(tempRoot, 'qoder-oscrypt-stale-ours')
  mkdirSync(ours, { recursive: true })
  writeFileSync(join(ours, '.dsh-oscrypt'), '')
  writeFileSync(join(ours, 'key.b64'), KEY.toString('base64'))
  // Age it past the sweep's window.
  const old = new Date(Date.now() - 10 * 60 * 1000)
  writeFileSync(join(ours, 'key.b64'), KEY.toString('base64'))
  for (const file of ['.dsh-oscrypt', 'key.b64']) {
    utimesSync(join(ours, file), old, old)
  }
  utimesSync(ours, old, old)

  const foreign = join(tempRoot, 'qoder-oscrypt-foreign')
  mkdirSync(foreign, { recursive: true })
  writeFileSync(join(foreign, 'something-else.txt'), 'not ours')

  const reclaimed = sweepStaleOscryptDirs(5 * 60 * 1000)
  assert.ok(reclaimed >= 1, `our stale dir must be reclaimed, got ${reclaimed}`)
  assert.equal(existsSync(ours), false, 'our stale dir must be gone')
  assert.equal(existsSync(foreign), true, 'a foreign dir must survive')
  assert.equal(existsSync(join(foreign, 'something-else.txt')), true, 'and its contents must survive')
  rmSync(foreign, { recursive: true, force: true })
})

test('the module does not answer twice for the same app directory', () => {
  // The key cache is bound to the `Local State` identity, so a second read
  // within the same file version must not spawn a second child.
  const appDir = appDirWithState('cached')
  const spawn = fakeSpawn()
  const first = oscryptKeyFor(appDir, WINDOWS, spawn)
  const second = oscryptKeyFor(appDir, WINDOWS, spawn)
  assert.deepStrictEqual(first, KEY)
  assert.deepStrictEqual(second, KEY)
  assert.equal(spawn.calls.length, 1, 'the second read must come from the cache')
})
