/**
 * Mutation checks for the credential temp-dir guards.
 *
 * Run: node --test test/mutation-gates.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * The sweep in `src/host/oscrypt-unwrap.ts` is the only place in this plugin
 * that deletes things it did not create, and the guards in it are the line
 * between "clean up after myself" and "destroy something the user owns":
 *
 *   - `lstat` instead of `stat`, so a junction is refused rather than
 *     followed (docs/issues/01);
 *   - the identity marker, so a directory that merely borrows the name prefix
 *     is not ours;
 *   - the exact two-file shape, so a directory that carries our residue plus
 *     somebody else's data is frozen, not wiped;
 *   - the 32-byte master key, so readable foreign bytes wearing our name are
 *     not deleted;
 *   - the age guard, so a live instance's key file is not taken away;
 *   - and in `zeroOutFile`, the plain-file rule, so an `r+` open cannot be
 *     aimed at a symlink's target.
 *
 * A test that asserts the happy path cannot tell us any of those guards is
 * load-bearing. Delete a guard from the source and every other test in this
 * repository stays green — which is exactly what happened while the guards
 * were "verified" by reading the code. `docs/KNOWN_GAPS.md` §5 records three
 * other places where a manual mutation was tried and had to be pinned by
 * hand; this file turns that into a repeatable check for the guards that
 * matter most.
 *
 * HOW IT WORKS
 *
 * The mutation is applied to a COPY of `src/host/`, never to the checkout:
 *
 *   1. copy the host sources into a scratch directory;
 *   2. delete one guard in the copy;
 *   3. run the real suite that owns that guard, in a child process, against
 *      the copy (`DSH_OSCRYPT_MODULE` / `DSH_CREDENTIALS_MODULE` point the
 *      suites at it);
 *   4. require the suite to go RED, and require the assertion that owns the
 *      guard to be among the failures — a mutation that breaks an unrelated
 *      test is not a proof that the guard is covered.
 *
 * A control run comes first: the unmutated copy must pass, otherwise the
 * harness is broken and every "the mutation was caught" verdict below would
 * be meaningless.
 *
 * The checkout is never modified, so this file is safe to run in parallel
 * with the rest of the suite: each mutation lives in its own scratch
 * directory, and the child processes get a private temp root so the sweep in
 * the child can only ever see the fixtures that child created.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, so the child processes run against this checkout. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The module whose guards are being mutated. */
const TARGET = 'oscrypt-unwrap.ts'

/**
 * One guard, one way to delete it, and the assertion that must notice.
 *
 * `from` must appear EXACTLY ONCE in the target file: the harness checks
 * that, and refuses to run if the source has moved, because a mutation that
 * silently applies to nothing would report "the guard survived" forever.
 */
const MUTATIONS = [
  {
    id: 'link-followed',
    what: 'the sweep follows a junction instead of refusing it',
    from: 'link = lstatSync(dir)',
    to: 'link = statSync(dir)',
    suite: 'test/credential-cleanup.test.js',
    caughtBy: 'a junction wearing our name AND our exact shape is refused, and its victim keeps its key',
  },
  {
    id: 'link-silent',
    what: 'the sweep stops reporting a junction collision (failure turned into silence)',
    from: 'if (link.isSymbolicLink()) {',
    to: 'if (false) {',
    suite: 'test/credential-cleanup.test.js',
    caughtBy: 'a junction wearing our name is refused and its victim is left byte-for-byte intact',
  },
  {
    id: 'marker-inverted',
    what: 'the identity-marker check is inverted, so our own residue is never reclaimed',
    from: 'if (!entries.includes(OSCRYPT_MARKER)) continue',
    to: 'if (entries.includes(OSCRYPT_MARKER)) continue',
    suite: 'test/credential-cleanup.test.js',
    caughtBy: 'a stale key directory is reclaimed',
  },
  {
    id: 'shape-relaxed',
    what: 'the sweep accepts a directory that holds more than our two files',
    from: "entries.length !== 2 || !entries.includes('key.b64')",
    to: "entries.length < 0 || !entries.includes('key.b64')",
    suite: 'test/credential-cleanup.test.js',
    caughtBy: 'our marker plus a foreign extra file is reported and left alone, not zeroed',
  },
  {
    id: 'key-size-relaxed',
    what: 'the sweep accepts a key file that is not a master key',
    from: 'if (unlockedBytes !== 32) {',
    to: 'if (unlockedBytes > 32) {',
    suite: 'test/credential-cleanup.test.js',
    caughtBy: 'our marker with a non-32-byte key file is reported and left alone',
  },
  {
    id: 'age-guard-inverted',
    what: 'the sweep ignores the age of the directory',
    from: 'if (!link.isDirectory() || link.mtimeMs > cutoff) continue',
    to: 'if (!link.isDirectory() || link.mtimeMs < cutoff) continue',
    suite: 'test/credential-cleanup.test.js',
    caughtBy: 'a fresh directory is left alone, because another instance may be using it',
  },
  {
    id: 'zero-any-target',
    what: 'the zeroing stops refusing targets that are not plain files',
    from: 'if (!stat.isFile()) {',
    to: 'if (false) {',
    suite: 'test/oscrypt-unwrap.test.js',
    caughtBy: 'the zeroing refuses a target that is not a plain file',
  },
  {
    id: 'zero-writes-nothing',
    what: 'the zeroing stops writing the zeros',
    from: 'writeSync(fd, block, 0, length, offset)',
    to: 'writeSync(fd, block, 0, 0, offset)',
    suite: 'test/oscrypt-unwrap.test.js',
    caughtBy: 'the zeroing overwrites the bytes',
  },
]

/**
 * Copy the host sources into a scratch directory.
 *
 * The whole directory is copied, not just the file being mutated, so the
 * copies' own relative imports (`./errors.ts`, `./oscrypt-unwrap.ts`) resolve
 * without touching the checkout.
 */
function stageHostSources() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mutation-'))
  const host = join(dir, 'host')
  cpSync(join(ROOT, 'src', 'host'), host, { recursive: true })
  return { dir, host }
}

/** The titles of the tests that failed, as the TAP report spells them. */
function failingTitles(report) {
  const titles = []
  for (const line of report.split('\n')) {
    const match = /^\s*not ok \d+ - (.*)$/.exec(line)
    if (match) titles.push(match[1].trim())
  }
  return titles
}

/**
 * Run one suite file in a child process, against the staged copy.
 *
 * The child gets a private temp root: the sweep looks in `os.tmpdir()`, and a
 * shared root would let it see fixtures another suite left behind — the exact
 * coupling `test/credential-cleanup.test.js` works so hard to avoid.
 */
function runSuite(suite, staged) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-mutation-tmp-'))
  // `NODE_TEST_CONTEXT` marks a process as a test-runner child; a nested
  // runner that still sees it refuses to run any file ("run() is being called
  // recursively within a test file"), which would make every mutation look
  // like it was caught by a suite that never ran.
  const { NODE_TEST_CONTEXT, ...inherited } = process.env
  try {
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', suite], {
      cwd: ROOT,
      env: {
        ...inherited,
        TMPDIR: tempRoot,
        TEMP: tempRoot,
        TMP: tempRoot,
        DSH_OSCRYPT_MODULE: join(staged.host, TARGET),
        DSH_CREDENTIALS_MODULE: join(staged.host, 'credentials.ts'),
      },
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return {
      status: result.status,
      report: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

test('the staged copy of the chain passes the suites that own its guards', () => {
  // The control. Without it, "the mutation was caught" could mean "the copy
  // never worked in the first place" — a harness that fails every suite for
  // any reason at all.
  const staged = stageHostSources()
  try {
    for (const suite of ['test/credential-cleanup.test.js', 'test/oscrypt-unwrap.test.js']) {
      const run = runSuite(suite, staged)
      assert.equal(run.status, 0, `the unmutated copy must pass ${suite}; got:\n${run.report}`)
    }
  } finally {
    rmSync(staged.dir, { recursive: true, force: true })
  }
})

for (const mutation of MUTATIONS) {
  test(`deleting this guard turns the suite red: ${mutation.what}`, () => {
    const staged = stageHostSources()
    try {
      const target = join(staged.host, TARGET)
      const original = readFileSync(target, 'utf8')
      const occurrences = original.split(mutation.from).length - 1
      assert.equal(
        occurrences,
        1,
        `the anchor for "${mutation.id}" must appear exactly once in ${TARGET} — the source moved, so this mutation check is stale`,
      )
      writeFileSync(target, original.replace(mutation.from, mutation.to), 'utf8')

      const run = runSuite(mutation.suite, staged)

      // Put the copy back before asserting, so a failed verdict never leaves a
      // mutated file behind for the next check to trip over.
      writeFileSync(target, original, 'utf8')

      assert.notEqual(
        run.status,
        0,
        `the guard survived its mutation: ${mutation.what}\n${run.report}`,
      )
      const failures = failingTitles(run.report)
      assert.ok(
        failures.includes(mutation.caughtBy),
        `the mutation was caught, but not by the assertion that owns the guard ` +
          `("${mutation.caughtBy}"); failing tests were: ${JSON.stringify(failures)}`,
      )
    } finally {
      rmSync(staged.dir, { recursive: true, force: true })
    }
  })
}
