/**
 * The error budget for the test tree's type program.
 *
 * Run: node scripts/audit-test-type-errors.mjs [--write] [--budget N]
 *
 * WHY THIS EXISTS
 *
 * `npm run audit:test-types` ratchets the test tree by FILE COUNT: a number
 * of files opt in to `// @ts-check`, and the floor may only rise. That axis
 * buys less than it looks like it buys, and it buys it in the wrong
 * direction:
 *
 *   - adding the pragma to a file that is already clean raises the count for
 *     free — progress that costs nothing, so it is not progress;
 *   - a file with sixty errors in it can only LOWER the count when it opts in,
 *     so the gate refuses the very files that need the attention most;
 *   - and a brand-new test file with twenty type errors in it changes the
 *     count by exactly nothing, because it never opts in at all.
 *
 * So the file count is the wrong axis, and the right one is the ERROR COUNT of
 * the whole tree. That is what this script measures: the test tree compiled
 * with `checkJs: true` (tsconfig.test.budget.json — the same program as
 * tsconfig.test.json with one flag flipped), every diagnostic counted, and the
 * total compared against a budget that may only shrink.
 *
 * WHERE THE BUDGET LIVES
 *
 * Not here. The budget is a line in the ratchet ledger
 * (`scripts/ratchet-ledger.json`), next to the record of how it got there, and
 * this script refuses a value the ledger does not account for. That is the
 * difference between "a number in a file" and "a fact somebody checked": a
 * constant could be raised in any diff with nothing in it to show, while a
 * ledger entry has to say from where, to where, on what date, and why — and
 * the chain of those entries has to add up.
 *
 * The budget is deliberately ABOVE ZERO. The tree is thousands of errors
 * deep, and pretending otherwise would mean either fixing all of it before
 * the gate exists (months of mechanical work) or pretending the debt is not
 * there. The honest shape is: the debt is measured, it is written down, and
 * it is not allowed to grow. New test files are checked the day they arrive;
 * the stock gets burned slowly.
 *
 * WHAT IT DOES NOT CLAIM
 *
 * A budget of thousands is not a type-clean test tree. It is a number that
 * cannot go up. The claim this gate makes is narrow and it is the one that
 * is true: "the test tree's type debt is not growing".
 *
 * WHY THE BUDGET IS NOT THE WHOLE STORY
 *
 * The opted-in files are held to a much stronger standard by the other
 * gate: they must compile with ZERO errors (`npm run audit:test-types`). This
 * script does not weaken that — it counts their errors too, and they are
 * zero, so they never move the total. The two gates are complementary: one
 * is a floor on the number of files that are perfect, the other is a ceiling
 * on the number of errors that are tolerated everywhere else.
 *
 * THE GUARDS ON THE GUARDS
 *
 * A budget gate is exactly the kind of thing that can go green for the wrong
 * reason, so three things are checked before the number is believed:
 *
 *   1. `tsconfig.test.budget.json` really has `checkJs: true` and really
 *      extends tsconfig.test.json. Flip the flag and the measured debt
 *      collapses to zero — the gate would report "0 errors, budget N" and
 *      pass forever.
 *   2. every `.js`/`.mjs` file under `test/` is really in the compiler's
 *      program. Narrow the `include` and the tree leaves the program, the
 *      error count collapses to zero, and the gate passes on an empty
 *      measurement. The check compares the program against the files on disk
 *      rather than against a fixed number, so it cannot rot.
 *   3. the budget this gate compares against is one the ledger accounts for.
 *      Otherwise the ceiling would travel with the debt: raise the number and
 *      the comparison stays green, which is the whole failure mode.
 *
 * And the main path is mutation-tested too: `test/gate-mutations.test.js`
 * makes the debt grow inside a staged copy and requires this gate to go red
 * with its own words, so "the ceiling holds" is a checked fact rather than an
 * intention.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { describeError, LEDGER_REL, loadLedger, ratchetValue } from './ratchet-ledger.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The debt ceiling, in diagnostics.
 *
 * It is not a constant in this file: it is a line in the ratchet ledger
 * (`scripts/ratchet-ledger.json`), together with the record of how it got
 * there. A value the ledger does not account for is refused below, so the
 * number that gates the build can only move as a recorded act — from, to,
 * date, reason — in a diff a reviewer reads, rather than drifting as a side
 * effect of ordinary work.
 *
 * What it covers: every `.js`/`.mjs` file under `test/` that has not opted
 * in, the `.mjs` helpers among them, and the two non-test files the tree
 * drags in transitively (`scripts/probe-params.mjs` and
 * `probe/qoder-device-login.mjs` — they are imported by test files, so they
 * are in the program whether or not anybody meant them to be). That last
 * part is worth remembering when the number moves for reasons that have
 * nothing to do with the test tree: a change in `src/` can raise the debt
 * without the tests getting worse at all.
 */
const LEDGER_RATCHET = 'testTypeErrorBudget'

let ledger = null
try {
  ledger = loadLedger()
} catch (err) {
  console.error(
    `\nFAIL the ratchet ledger is not consistent: ${describeError(err)}\n` +
      `  (${LEDGER_REL} is the single source of truth for this budget — a threshold nobody ` +
      'accounted for is a threshold nobody noticed.)',
  )
  process.exit(1)
}

const BUDGET = ratchetValue(ledger, LEDGER_RATCHET)

// The budget that is actually enforced: the ledger's value, unless the caller
// overrides it for a one-off measurement. It is parsed BEFORE anything is
// printed, so every number this gate shows is the number it enforced. The
// old version printed the constant and compared against the override, which
// made the failure message quote a budget the run was not using.
const budgetArgIndex = process.argv.indexOf('--budget')
const budget = budgetArgIndex >= 0 ? Number(process.argv[budgetArgIndex + 1]) : BUDGET
if (!Number.isFinite(budget)) {
  console.error(
    `\nFAIL --budget needs a number, got ${JSON.stringify(process.argv[budgetArgIndex + 1] ?? null)}`,
  )
  process.exit(1)
}

const CONFIG = 'tsconfig.test.budget.json'

/**
 * Read a tsconfig with its comments removed.
 *
 * The configs in this repository carry a long `$comment` explaining why they
 * are shaped the way they are, so they cannot be parsed as plain JSON. Only
 * whole-line `//` comments are stripped: a `//` inside a string (a URL, a
 * path) must survive, and no config here has one, but the rule stays narrow
 * anyway.
 */
function readConfig(rel) {
  const text = readFileSync(join(root, rel), 'utf8')
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''))
}

const config = readConfig(CONFIG)

if (config.compilerOptions?.checkJs !== true) {
  console.error(
    `FAIL ${CONFIG} no longer turns checkJs on — the measured debt would collapse to zero ` +
      'and this gate would pass forever on an empty measurement. Put "checkJs": true back.',
  )
  process.exit(1)
}

if (config.extends !== './tsconfig.test.json') {
  console.error(
    `FAIL ${CONFIG} no longer extends tsconfig.test.json — it would measure a different ` +
      'program than the one npm run audit:test-types looks at.',
  )
  process.exit(1)
}

/** Every `.js`/`.mjs` file under `test/`, as repo-relative paths. */
function testTreeFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (/\.(js|mjs)$/.test(entry.name)) out.push(rel)
    }
  }
  walk('test')
  return out
}

/**
 * tsc exits 2 whenever it has anything to say, so a full run ALWAYS throws
 * here. The report is on stdout, not in the error, which makes this script a
 * reader of a compiler failure — the one place where "expect the process to
 * die" is the correct shape rather than a mistake.
 */
let raw
try {
  raw = execFileSync(
    process.execPath,
    [
      join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      join(root, CONFIG),
      '--pretty',
      'false',
      '--listFiles',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  )
} catch (err) {
  raw = err.stdout ?? ''
  if (!/error TS\d+:/.test(raw)) throw err
}

const lines = raw.split(/\r?\n/)

/** `test/handlers.test.js(12,3): error TS2345: …` → `{ file, count, codes }`. */
const perFile = new Map()
const unparsed = []
for (const line of lines) {
  if (!/error TS\d+:/.test(line)) continue
  const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/)
  if (!m) {
    // A diagnostic with no file position (a config error, say) would otherwise
    // vanish from the total without a trace. Never let a number be quietly
    // smaller than the compiler's.
    unparsed.push(line)
    continue
  }
  const [, file, , , code, detail] = m
  const key = relative(root, join(root, file)).replace(/\\/g, '/')
  const entry = perFile.get(key) ?? { count: 0, codes: new Map(), first: `${key}(${m[2]}:${m[3]})`, detail }
  entry.count += 1
  entry.codes.set(code, (entry.codes.get(code) ?? 0) + 1)
  perFile.set(key, entry)
}

const total = lines.filter((l) => /error TS\d+:/.test(l)).length

// Guard on the guard: the files on disk must all be in the program, or the
// measurement is of something smaller than the tree.
const programTestFiles = new Set()
for (const line of lines) {
  const m = /^(.*[\\/]test[\\/].+\.(?:js|mjs))$/.exec(line.trim())
  if (!m) continue
  programTestFiles.add(relative(root, m[1]).replace(/\\/g, '/'))
}
const onDisk = testTreeFiles()
const missing = onDisk.filter((rel) => !programTestFiles.has(rel))
if (missing.length > 0) {
  console.error(
    `\nFAIL the test tree is not fully in the type program: ${missing.length} file(s) under test/ ` +
      `are not in the compiler's program, so their type errors are not being measured. ` +
      'First few:',
  )
  for (const rel of missing.slice(0, 10)) console.error(`  ${rel}`)
  console.error('  (tsconfig.test.json `include` must keep naming "test".)')
  process.exit(1)
}

if (unparsed.length > 0) {
  console.error(`\nFAIL test type-error budget: ${unparsed.length} diagnostic(s) had no file position and are not counted:`)
  for (const l of unparsed) console.error(`  ${l}`)
  process.exit(1)
}

const rows = [...perFile.entries()].sort((a, b) => b[1].count - a[1].count)

if (process.argv.includes('--write')) {
  for (const [file, e] of rows) {
    console.log(`  ${String(e.count).padStart(4)}  ${file}  ${[...e.codes].map(([c, n]) => `${c}×${n}`).join(' ')}`)
  }
  console.log(
    `\n${total} total — to move the ceiling, record it in ${LEDGER_REL} (ratchet "${LEDGER_RATCHET}": ` +
      'a change entry with from, to, date and reason). The ledger is checked, so a number that is not ' +
      'recorded there is refused.',
  )
  process.exit(0)
}

// Report before the gate so the failure is legible, not just a number.
console.log(`test type errors: ${total} (budget ${budget}) — ${rows.length} file(s) with errors`)
for (const [file, e] of rows.slice(0, 20)) {
  console.log(`  ${String(e.count).padStart(4)}  ${file}  ${[...e.codes].map(([c, n]) => `${c}×${n}`).join(' ')}`)
}
if (rows.length > 20) console.log(`  … and ${rows.length - 20} more file(s)`)

if (!(total <= budget)) {
  console.error(
    `\nFAIL test type-error budget: ${total} errors, budget ${budget}. ` +
      'The debt is above the ceiling. Fix the new errors, or take the increase deliberately: ' +
      `record it in ${LEDGER_REL} (ratchet "${LEDGER_RATCHET}", a change entry with from ${budget}, ` +
      `to ${total}, the date and a reason) and set the value to ${total}. ` +
      'A ceiling nobody accounted for is a ceiling nobody noticed. ' +
      '(Fixing errors also lowers the count: record the lower ceiling in the same diff.)',
  )
  process.exit(1)
}

if (total < budget) {
  console.log(
    `  (the debt is below the budget — record the lower ceiling in ${LEDGER_REL} in the same diff, ` +
      'or the slack hides the next file\'s errors)',
  )
}
