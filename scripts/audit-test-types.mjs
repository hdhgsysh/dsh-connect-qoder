/**
 * Gate the type-checking of the test tree.
 *
 * Run: node scripts/audit-test-types.mjs
 *
 * WHY THIS EXISTS
 *
 * The test tree used to be outside the compiler entirely: `tsconfig.json`
 * scopes itself to `src/`, and the suite imports `src/host/*.ts` through
 * Node's strip-only loader, which erases the annotations without checking a
 * single one. The suite's own `.js` files were never in a program either, so
 * a typo in an import path, a renamed export, or a changed parameter type
 * inside a test was invisible to every compiler in the build.
 *
 * `tsconfig.test.json` puts the test tree into a program. This script is the
 * gate around that program, and it exists because the failure mode of such a
 * gate is SILENCE, not noise: a program that accidentally contains no test file
 * compiles clean, reports no errors, and exits 0. Every assertion below is
 * aimed at that shape rather than at the ordinary "there is a type error" case.
 *
 * WHAT IT CHECKS
 *
 * 1. The ratchet floor: at least FLOOR test files carry a `// @ts-check`
 *    pragma. Removing a pragma is a silent loss of coverage, and nothing else
 *    in the build would notice it. The floor itself lives in the ratchet
 *    ledger (`scripts/ratchet-ledger.json`), so lowering it has to be a
 *    recorded act — from, to, date, reason — and not a quiet edit.
 * 2. No effective `@ts-nocheck`: it outranks `@ts-check` in the same file, so
 *    a file could carry both and leave the program without reporting anything.
 * 3. No MISPLACED pragma: a pragma that sits after the first statement reads
 *    like an opt-in and checks nothing, so it is a silent loss too — the same
 *    shape as (1) but with the file still in the program.
 * 4. The compiler run is clean.
 * 5. Every opted-in file is actually IN the program (`tsc --listFiles`).
 *    A file that dropped out of the program is a file nothing checks any more.
 * 6. The SELF-PROBE: a temporary file with a deliberate type error is written
 *    into `test/`, and the compiler is asked to compile the program again. The
 *    gate fails unless that error is REPORTED. This is the assertion that
 *    makes the other five mean something — it proves the program really
 *    checks test files and really reports their errors, instead of quietly
 *    compiling an empty set.
 *
 * HOW THE PRAGMA IS DETECTED (measured, not assumed)
 *
 * The compiler's own rules were pinned down with ten probe files, because a
 * gate that guesses the compiler's rules checks the wrong object:
 *
 *   - only `//` LINE comments count. `/* @ts-check *\/` is IGNORED by the
 *     compiler, so a block comment is not a pragma.
 *   - the token must START the comment's content: `// @ts-check` works,
 *     `// @ts-check extra` still works (the match is a prefix), and
 *     `// see @ts-check for details` does NOT (the token is not at the start).
 *   - only comments BEFORE the first statement count. A pragma after an
 *     `import` is not honoured.
 *   - the LAST pragma wins: `// @ts-check` followed by `// @ts-nocheck`
 *     suppresses checking, and the other order re-enables it.
 *
 * The detection below mirrors those rules exactly, so "the gate says this file
 * is checked" and "the compiler really checks this file" are the same claim.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describeError, LEDGER_REL, loadLedger, ratchetValue } from './ratchet-ledger.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const configRel = 'tsconfig.test.json'
const configAbs = join(root, configRel)

/**
 * The ratchet floor: how many test files must carry `// @ts-check`.
 *
 * It is not a constant in this file: it is a line in the ratchet ledger
 * (`scripts/ratchet-ledger.json`), next to the record of how it got there. A
 * value the ledger does not account for is refused, so the number that gates
 * the build moves only as a recorded act — from, to, date, reason — in a diff
 * a reviewer reads, rather than drifting as a side effect of ordinary work.
 *
 * The floor is a FLOOR and not an exact count: adding a pragma must never
 * fail the build. Only REMOVING one may.
 */
const LEDGER_RATCHET = 'testOptInFloor'

let ledger = null
try {
  ledger = loadLedger()
} catch (err) {
  console.error(
    `\nFAIL the ratchet ledger is not consistent: ${describeError(err)}\n` +
      `  (${LEDGER_REL} is the single source of truth for this floor — a threshold nobody ` +
      'accounted for is a threshold nobody noticed.)',
  )
  process.exit(1)
}

const FLOOR = ratchetValue(ledger, LEDGER_RATCHET)

/** The temporary file the self-probe writes. Not a `*.test.js`, so `npm test` never runs it. */
const PROBE_REL = 'test/zz-audit-test-types-probe.js'

/** Every `.js`/`.mjs` file under `test/`, as repo-relative POSIX-ish paths. */
function testFiles(dir = 'test') {
  const out = []
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...testFiles(rel))
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(rel)
  }
  return out.sort()
}

/**
 * The line index of the file's first statement — that is, where the leading
 * comment region ends. A file with no statement at all reports its line count.
 *
 * The region is everything before that line: blank lines, block comments and
 * line comments. A line comment ON the first statement's line is already after
 * the first token, so it counts as misplaced too.
 */
function firstStatementLine(text) {
  const lines = text.split(/\r?\n/)
  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      continue
    }
    if (trimmed === '') continue
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true
      continue
    }
    if (trimmed.startsWith('//')) continue
    return i
  }
  return lines.length
}

/**
 * The LINE comments of the file's leading comment region: every `//` comment
 * that appears before the first statement.
 *
 * The region ends at the first line that is neither blank nor part of a
 * comment — the compiler honours a pragma only before the first statement.
 * Block comments are skipped, because the compiler does NOT read a pragma out
 * of a block comment.
 */
function leadingComments(text) {
  const found = []
  const limit = firstStatementLine(text)
  const lines = text.split(/\r?\n/)
  let inBlock = false
  for (let i = 0; i < limit; i++) {
    const trimmed = lines[i].trim()
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      continue
    }
    if (trimmed === '') continue
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true
      continue
    }
    if (trimmed.startsWith('//')) found.push({ text: trimmed.slice(2).trim(), line: i })
  }
  return found
}

/** Every `//` comment in the file, wherever it sits, with its line index. */
function allLineComments(text) {
  const out = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('//')) out.push({ text: trimmed.slice(2).trim(), line: i })
  }
  return out
}

/**
 * A pragma token: the comment's content must START with the token.
 *
 * The trailing `(?![-\w])` keeps `@ts-checker` and `@ts-check-noUnused` from
 * being read as `@ts-check`; the compiler's own match is a plain prefix, so
 * this is a deliberate narrowing — a file that carries an exotic pragma is
 * simply not counted as opted in, which is the safe direction.
 */
const PRAGMA_TOKEN = /^@ts-(check|nocheck)(?![-\w])/i

/**
 * The compiler's effective pragma state for a file: 'check', 'nocheck', or
 * null. The LAST pragma in the leading region wins.
 */
function pragmaState(text) {
  let state = null
  for (const comment of leadingComments(text)) {
    const match = PRAGMA_TOKEN.exec(comment.text)
    if (!match) continue
    state = match[1].toLowerCase() === 'check' ? 'check' : 'nocheck'
  }
  return state
}

/** A line comment outside the leading region whose content starts with a pragma token. */
function misplacedPragmas(text) {
  const limit = firstStatementLine(text)
  return allLineComments(text)
    .filter((c) => c.line >= limit && PRAGMA_TOKEN.test(c.text))
    .map((c) => c.text)
}

const failures = []
const fail = (message) => failures.push(message)

// --- 1/2/3: the opt-in set -------------------------------------------------

const files = testFiles()
const optedIn = []
for (const rel of files) {
  const text = readFileSync(join(root, rel), 'utf8')
  const state = pragmaState(text)
  if (state === 'nocheck') {
    fail(
      `${rel}: the effective pragma is \`@ts-nocheck\` — it outranks \`@ts-check\` in the same file, ` +
        `so the compiler checks nothing here and the file is silently out of the program`,
    )
    continue
  }
  for (const misplaced of misplacedPragmas(text)) {
    fail(
      `${rel}: carries a pragma-looking comment (\`// ${misplaced}\`) that sits AFTER the first statement — ` +
        `the compiler only honours a pragma before the first statement, so this reads like an opt-in and checks nothing`,
    )
  }
  if (state === 'check') optedIn.push(rel)
}

if (optedIn.length < FLOOR) {
  fail(
    `test-type ratchet: ${optedIn.length} file(s) opt in to type checking, floor is ${FLOOR}. ` +
      `A pragma was removed, so those files are no longer checked by anything. ` +
      `Restore the \`// @ts-check\` line, or take the loss deliberately: record it in ` +
      `${LEDGER_REL} (ratchet "${LEDGER_RATCHET}", a change entry with from ${FLOOR}, ` +
      `to ${optedIn.length}, the date and a reason) and set the value to ${optedIn.length}.`,
  )
}

// --- 4/5: the compiler run -------------------------------------------------

if (!existsSync(configAbs)) {
  fail(`${configRel} is missing — the test tree has no type program`)
  report()
}

function runTsc(extra = []) {
  const res = spawnSync(process.execPath, [tscBin, '-p', configRel, '--pretty', 'false', ...extra], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const first = runTsc(['--listFiles'])
const errorLines = first.out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l))
if (first.code !== 0 || errorLines.length > 0) {
  fail(
    `the test type program does not compile (tsc exit ${first.code}, ${errorLines.length} error(s)):\n` +
      errorLines.map((l) => `    ${l}`).join('\n'),
  )
}

const programFiles = new Set(
  first.out
    .split(/\r?\n/)
    .filter((l) => l !== '' && !/error TS\d+/.test(l) && isAbsolute(l))
    .map((l) => l.replace(/\\/g, '/')),
)
for (const rel of optedIn) {
  const needle = `/${rel}`
  const present = [...programFiles].some((p) => p.endsWith(needle) || p.endsWith(`\\${rel.replace(/\//g, '\\')}`))
  if (!present) {
    fail(`${rel}: opts in to type checking but is NOT in the compiler program — it would be checked by nothing`)
  }
}

// --- 6: the self-probe -----------------------------------------------------

if (!existsSync(join(root, PROBE_REL))) {
  const probe = [
    '// @ts-check',
    '// Written by scripts/audit-test-types.mjs, deleted again before it returns.',
    'const probeValue = null',
    'probeValue.toString()',
    '',
  ].join('\n')
  writeFileSync(join(root, PROBE_REL), probe)
  try {
    const second = runTsc()
    const reported = second.out.includes('zz-audit-test-types-probe.js') && /error TS\d+/.test(second.out)
    if (!reported) {
      fail(
        'the self-probe was not reported: a file with a deliberate type error, sitting in test/ with a `// @ts-check` pragma, ' +
          'compiled without a single complaint. The program is not checking test files, so every other check here is vacuous — ' +
          'most likely `exclude` in tsconfig.test.json still names `test` (it is inherited from tsconfig.json and must be restated).',
      )
    }
  } finally {
    rmSync(join(root, PROBE_REL), { force: true })
  }
}

report()

/**
 * Print the report and exit. The report comes BEFORE the verdict so a failure
 * is legible rather than just a number — the same convention the other two
 * audit scripts in this directory follow.
 */
function report() {
  console.log(`test files: ${files.length}, opted in to type checking: ${optedIn.length} (floor ${FLOOR})`)
  for (const rel of optedIn) console.log(`  ✓ ${rel}`)
  if (failures.length > 0) {
    console.error('')
    for (const f of failures) console.error(`FAIL ${f}`)
    process.exit(1)
  }
  console.log('ok: the test tree compiles under tsconfig.test.json, and the program reports test-file errors.')
}
