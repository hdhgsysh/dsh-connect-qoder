/**
 * Mutation checks for the release gates that had no test of their own.
 *
 * Run: node --test test/gate-mutations.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * The README tells the reader how to break each gate on purpose: drop a string
 * the bundle needs, tamper with the shipped host artifact, move a probe's
 * lower bound. Those recipes are the only proof that a gate can fail at all —
 * and they only run when a human remembers to run them, by hand, once. A gate
 * that has never been seen red is a gate whose verdict nobody has checked, and
 * the failure mode is silent: the recipe is written as prose ("follow these
 * steps"), so a reader who cannot reproduce it learns nothing about whether the
 * gate works or the recipe has gone stale.
 *
 * So the recipes live here instead, as tests. Each one:
 *
 *   1. stages a scratch copy of the files the gate reads;
 *   2. runs the gate on the unmutated copy — the control, which proves the
 *      scratch is a faithful copy rather than a broken one;
 *   3. applies the mutation the README describes;
 *   4. runs the gate again and requires it to go RED — and to go red with the
 *      gate's OWN complaint, because a mutation that trips an unrelated crash
 *      is not a proof that the gate is load-bearing.
 *
 * The same discipline as `test/mutation-gates.test.js`, applied to the gates
 * that one cannot reach: that file mutates the credential chain and lets the
 * real suite notice, while these four gates are scripts, not assertions, so
 * there is no failing test title to point at — the gate's own message is the
 * evidence.
 *
 * WHY THE SCRATCH LIVES INSIDE THE REPOSITORY
 *
 * Two of the gates read their baseline out of git (`git show
 * <ref>:lib/client.js`) and the others need the bundler or the compiler from
 * `node_modules`. A scratch directory under the OS temp dir would have neither,
 * so the gates would report "no baseline" and exit 0 — the vacuous green this
 * file exists to catch, reproduced by the harness itself. `.verify-tmp/` is
 * already ignored, so the scratch never shows up in `git status`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, so the staged copies and the children match this checkout. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Where the scratch copies live. Ignored by git, so `git status` stays clean. */
const SCRATCH = join(ROOT, '.verify-tmp')

/**
 * Copy the given repository-relative paths into a fresh scratch directory.
 *
 * The whole directory a gate reads is copied, not just the file being
 * mutated, so the gate's own relative lookups still resolve inside the copy.
 */
function stage(files) {
  mkdirSync(SCRATCH, { recursive: true })
  const dir = mkdtempSync(join(SCRATCH, 'gate-'))
  for (const rel of files) {
    const to = join(dir, rel)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(join(ROOT, rel), to, { recursive: true })
  }
  return dir
}

/**
 * Point the scratch's `node_modules` at the repository's.
 *
 * `npm run` puts `<package>/node_modules/.bin` on the PATH, so without this the
 * host build inside the scratch could not find `tsdown` — and the gate would
 * skip its freshness check with a SKIP banner instead of failing. A junction on
 * Windows, a plain symlink elsewhere; neither needs elevation.
 */
function linkNodeModules(dir) {
  const target = join(ROOT, 'node_modules')
  symlinkSync(target, join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
}

/** Run a script in a child process and return its exit status and output. */
function runNode(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

/** Replace one occurrence of `from` with `to`, insisting there is exactly one. */
function replaceOnce(file, from, to) {
  const original = readFileSync(file, 'utf8')
  const occurrences = original.split(from).length - 1
  assert.equal(
    occurrences,
    1,
    `the anchor ${JSON.stringify(from)} must appear exactly once in ${file} — ` +
      'the source moved, so this mutation check is stale',
  )
  writeFileSync(file, original.replace(from, to), 'utf8')
  return original
}

/**
 * Move one ratchet value in a staged ledger, without recording the move.
 *
 * The ledger is edited as data rather than by string surgery: a text anchor
 * would rot the moment the file is reworded, and the point of this mutation
 * is not the exact bytes but the shape — the VALUE moves, the RECORD does
 * not. That is the whole failure mode: a threshold that travels with the
 * debt it is supposed to hold down.
 *
 * @param {string} dir the staged copy
 * @param {string} ratchet which ratchet to move
 * @param {number} value what to move it to
 */
function bumpLedgerValue(dir, ratchet, value) {
  const file = join(dir, 'scripts', 'ratchet-ledger.json')
  const ledger = JSON.parse(readFileSync(file, 'utf8'))
  ledger.ratchets[ratchet].value = value
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
}

test(
  'the build gate refuses to write a bundle that lost a string the card needs',
  { concurrency: true },
  () => {
    const files = ['package.json', 'tsconfig.json', 'scripts/build-client.mjs', 'src/client', 'lib/client.js']

    // The control: the same scratch, unmutated, must build and match the
    // shipped bytes. Without it, "the mutation was caught" could mean "the
    // scratch never built in the first place".
    const controlDir = stage(files)
    try {
      const control = runNode(join(controlDir, 'scripts', 'build-client.mjs'), ['--tsdown'], controlDir)
      assert.equal(
        control.status,
        0,
        `the unmutated copy must build and match; got:\n${control.output}`,
      )
      assert.ok(
        control.output.includes('MATCH'),
        `the unmutated copy must reproduce the shipped bytes; got:\n${control.output}`,
      )
    } finally {
      rmSync(controlDir, { recursive: true, force: true })
    }

    const dir = stage(files)
    try {
      const shipped = join(dir, 'lib', 'client.js')
      const before = readFileSync(shipped, 'utf8')
      // A typo in the route the card renders its model rows from: the bundle
      // still builds, still exits 0, and simply no longer has the string.
      replaceOnce(join(dir, 'src', 'client', 'paths.ts'), 'dsh-connect-qoder/models', 'dsh-connect-qoder/modelz')

      const run = runNode(join(dir, 'scripts', 'build-client.mjs'), ['--tsdown'], dir)

      assert.notEqual(run.status, 0, `the build gate survived its mutation:\n${run.output}`)
      assert.ok(
        run.output.includes('the build is incomplete'),
        `the gate must complain that the build is incomplete; got:\n${run.output}`,
      )
      assert.ok(
        run.output.includes('the model route the card renders rows from'),
        `the gate must name the string it found missing; got:\n${run.output}`,
      )
      assert.equal(
        readFileSync(shipped, 'utf8'),
        before,
        'the gate promised "nothing was written" — a working artifact must survive the refusal',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test(
  'the host gate calls the shipped artifact stale when the sources moved on',
  { concurrency: true },
  () => {
    const files = [
      'package.json',
      'tsconfig.json',
      'tsdown.config.mjs',
      'scripts/clean-host-bundle.mjs',
      'scripts/verify-host-bundle.mjs',
      'src/host',
      'types',
      'lib/index.js',
    ]

    const controlDir = stage(files)
    try {
      linkNodeModules(controlDir)
      const control = runNode(join(controlDir, 'scripts', 'verify-host-bundle.mjs'), [], controlDir)
      assert.equal(
        control.status,
        0,
        `the unmutated copy must pass every check; got:\n${control.output}`,
      )
      assert.ok(
        control.output.includes('checks passed'),
        `the unmutated copy must report the checks it ran; got:\n${control.output}`,
      )
    } finally {
      rmSync(controlDir, { recursive: true, force: true })
    }

    const dir = stage(files)
    try {
      linkNodeModules(dir)
      // The README's recipe: append a line to the shipped artifact. The rebuild
      // inside the gate overwrites it, so the committed bytes no longer match
      // what the sources produce — the exact drift the gate exists to catch.
      const artifact = join(dir, 'lib', 'index.js')
      writeFileSync(artifact, `${readFileSync(artifact, 'utf8')}\n// tampered\n`, 'utf8')

      const run = runNode(join(dir, 'scripts', 'verify-host-bundle.mjs'), [], dir)

      assert.notEqual(run.status, 0, `the host gate survived its mutation:\n${run.output}`)
      assert.ok(
        run.output.includes('the artifact is stale'),
        `the gate must say the artifact is stale; got:\n${run.output}`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test(
  'the bundle gate catches a card that prices models with a discount Qoder switched off',
  { concurrency: true },
  () => {
    const files = ['scripts/verify-bundle-behaviour.mjs', 'lib/client.js']

    const controlDir = stage(files)
    try {
      const control = runNode(join(controlDir, 'scripts', 'verify-bundle-behaviour.mjs'), [], controlDir)
      assert.equal(
        control.status,
        0,
        `the unmutated copy must behave like its baseline; got:\n${control.output}`,
      )
      assert.ok(
        control.output.includes('OK:'),
        `the unmutated copy must report the comparison it made; got:\n${control.output}`,
      )
    } finally {
      rmSync(controlDir, { recursive: true, force: true })
    }

    const dir = stage(files)
    try {
      // The one line whose loss is silent: the card would show a discount the
      // user is never charged, and nothing else in the bundle would move.
      replaceOnce(
        join(dir, 'lib', 'client.js'),
        'promo.active !== true',
        'promo.active === true',
      )

      const run = runNode(join(dir, 'scripts', 'verify-bundle-behaviour.mjs'), [], dir)

      assert.notEqual(run.status, 0, `the bundle gate survived its mutation:\n${run.output}`)
      assert.ok(
        run.output.includes('does not behave like its baseline'),
        `the gate must say the bundle drifted; got:\n${run.output}`,
      )
      assert.ok(
        run.output.includes('off-peak gate: baseline=true rebuilt=false'),
        `the gate must report the off-peak gate it lost; got:\n${run.output}`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test(
  'the debt budget refuses to be satisfied by measuring nothing',
  { concurrency: true },
  () => {
    // The budget gate counts the type errors in the whole test tree and holds
    // that count to a ceiling. Two configurations make the count collapse to
    // zero while the gate still reports success — and each is one line of
    // config away, so each is a mutation here.
    const files = [
      'package.json',
      'tsconfig.json',
      'tsconfig.test.json',
      'tsconfig.test.budget.json',
      'scripts',
      'src',
      'test',
      'types',
      'probe',
    ]

    // One control for both mutations: it proves the staged tree compiles the
    // way the checkout does, so "the mutation was caught" cannot mean "the
    // scratch was broken to begin with".
    const controlDir = stage(files)
    try {
      linkNodeModules(controlDir)
      const control = runNode(join(controlDir, 'scripts', 'audit-test-type-errors.mjs'), [], controlDir)
      assert.equal(
        control.status,
        0,
        `the unmutated copy must stay within its budget; got:\n${control.output}`,
      )
      assert.ok(
        control.output.includes('test type errors:'),
        `the unmutated copy must report the debt it measured; got:\n${control.output}`,
      )
    } finally {
      rmSync(controlDir, { recursive: true, force: true })
    }

    // Mutation 1: the measuring program stops checking the files that have
    // not opted in. The debt reads as zero, zero fits any budget, and the gate
    // would pass forever on an empty measurement.
    const flippedDir = stage(files)
    try {
      linkNodeModules(flippedDir)
      replaceOnce(
        join(flippedDir, 'tsconfig.test.budget.json'),
        '"checkJs": true',
        '"checkJs": false',
      )

      const run = runNode(join(flippedDir, 'scripts', 'audit-test-type-errors.mjs'), [], flippedDir)

      assert.notEqual(run.status, 0, `the budget gate survived its mutation:\n${run.output}`)
      assert.ok(
        run.output.includes('no longer turns checkJs on'),
        `the gate must say the measuring program stopped measuring; got:\n${run.output}`,
      )
    } finally {
      rmSync(flippedDir, { recursive: true, force: true })
    }

    // Mutation 2: the test tree leaves the program entirely. Nothing is
    // measured, nothing looks missing, and the gate has no way to tell —
    // unless it compares the program against the files on disk.
    const narrowedDir = stage(files)
    try {
      linkNodeModules(narrowedDir)
      replaceOnce(
        join(narrowedDir, 'tsconfig.test.json'),
        '"include": ["src/host", "src/client", "types/*.d.ts", "test"]',
        '"include": ["src/host", "src/client", "types/*.d.ts"]',
      )

      const run = runNode(join(narrowedDir, 'scripts', 'audit-test-type-errors.mjs'), [], narrowedDir)

      assert.notEqual(run.status, 0, `the budget gate survived its mutation:\n${run.output}`)
      assert.ok(
        run.output.includes('the test tree is not fully in the type program'),
        `the gate must say the tree left the program; got:\n${run.output}`,
      )
    } finally {
      rmSync(narrowedDir, { recursive: true, force: true })
    }

    // Mutation 3: the MAIN path. The tree carries more debt than the ceiling
    // allows, and the gate has to say so in its own words. The two mutations
    // above both made the MEASUREMENT collapse; this one keeps the
    // measurement honest and checks the comparison instead — which is the
    // thing nobody was checking before.
    const grownDir = stage(files)
    try {
      linkNodeModules(grownDir)
      writeFileSync(
        join(grownDir, 'test', 'zz-debt-growth-probe.js'),
        [
          '// The debt, grown on purpose: two deliberate type errors.',
          '// Exported so the compiler reports them as type errors and not as unused.',
          "export const debtGrowthNumber = /** @type {number} */ ('a string, not a number')",
          'export const debtGrowthList = /** @type {string[]} */ (42)',
          '',
        ].join('\n'),
      )

      const run = runNode(join(grownDir, 'scripts', 'audit-test-type-errors.mjs'), [], grownDir)

      assert.notEqual(run.status, 0, `the budget gate survived a debt that outgrew it:\n${run.output}`)
      assert.ok(
        run.output.includes('debt is above the ceiling'),
        `the gate must say the debt is above the ceiling; got:\n${run.output}`,
      )
    } finally {
      rmSync(grownDir, { recursive: true, force: true })
    }

    // Mutation 4: the ceiling itself moves, and nothing records the move.
    // This is the failure mode the ledger exists for: a threshold that
    // travels with the debt is not a threshold, it is a comment.
    const movedDir = stage(files)
    try {
      linkNodeModules(movedDir)
      bumpLedgerValue(movedDir, 'testTypeErrorBudget', 3000)

      const run = runNode(join(movedDir, 'scripts', 'audit-test-type-errors.mjs'), [], movedDir)

      assert.notEqual(run.status, 0, `the budget gate survived an unrecorded raise:\n${run.output}`)
      assert.ok(
        run.output.includes('the ratchet ledger is not consistent'),
        `the gate must say the threshold moved without a record; got:\n${run.output}`,
      )
    } finally {
      rmSync(movedDir, { recursive: true, force: true })
    }
  },
)

test(
  'the ratchet ledger refuses a threshold nobody recorded',
  { concurrency: true },
  () => {
    // The thresholds the gates enforce used to be constants in the scripts
    // themselves, which made a raise invisible: the number moved, and the
    // comparison moved with it, so the gate stayed green while its job
    // disappeared. They live in a ledger now, and the ledger refuses a value
    // it cannot account for — so the only way to move one is to record the
    // move (from, to, date, reason).
    const files = [
      'package.json',
      'tsconfig.json',
      'tsconfig.test.json',
      'scripts',
      'src',
      'test',
      'types',
      'probe',
    ]

    // Control: the staged copy passes the floor gate the way the checkout
    // does, so "the mutation was caught" cannot mean "the scratch was broken".
    const controlDir = stage(files)
    try {
      linkNodeModules(controlDir)
      const control = runNode(join(controlDir, 'scripts', 'audit-test-types.mjs'), [], controlDir)
      assert.equal(
        control.status,
        0,
        `the unmutated copy must pass the opt-in gate; got:\n${control.output}`,
      )
      assert.ok(
        control.output.includes('opted in to type checking'),
        `the unmutated copy must report the opt-in set it measured; got:\n${control.output}`,
      )
    } finally {
      rmSync(controlDir, { recursive: true, force: true })
    }

    // Mutation: the floor moves down, and nothing says why.
    const movedDir = stage(files)
    try {
      linkNodeModules(movedDir)
      bumpLedgerValue(movedDir, 'testOptInFloor', 1)

      const run = runNode(join(movedDir, 'scripts', 'audit-test-types.mjs'), [], movedDir)

      assert.notEqual(run.status, 0, `the opt-in gate survived an unrecorded move:\n${run.output}`)
      assert.ok(
        run.output.includes('the ratchet ledger is not consistent'),
        `the gate must say the threshold moved without a record; got:\n${run.output}`,
      )
    } finally {
      rmSync(movedDir, { recursive: true, force: true })
    }
  },
)
