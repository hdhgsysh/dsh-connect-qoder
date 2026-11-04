/**
 * Guard the CONFIGURATION of the test-tree type gate.
 *
 * Run: node --test test/test-types-gate.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * `scripts/audit-test-types.mjs` is the gate that puts the test tree into a
 * compiler program (`tsconfig.test.json`) and keeps it there. It is a heavy
 * gate: it runs the compiler twice, once with a self-probe file, so it is a CI
 * step and a `verify` step rather than part of `npm test`.
 *
 * This file is the cheap half. It reads the same configuration WITHOUT running
 * a compiler, and asserts the things that would silently turn the heavy gate
 * into a no-op:
 *
 *   - the test program must not inherit an `exclude` that names `test`
 *     (the trap: `extends` inherits `exclude`, and the inherited value would
 *     leave `include` naming a directory the compiler never looks at);
 *   - the gate must be wired into `npm run verify` AND into CI, or it runs
 *     only on the machines that remember to run it;
 *   - no test file may carry a pragma that the compiler would not honour, or
 *     one that silently switches checking off;
 *   - the ratchet floor in the gate script must equal the number of files
 *     that actually opt in, so the floor cannot go stale.
 *
 * The pragma rules below were MEASURED against the compiler with ten probe
 * files, not guessed, and they are re-implemented here independently of the
 * gate script on purpose: if the two disagree, the floor check fails and the
 * disagreement is visible instead of silent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

/** Every `.js`/`.mjs` file under `test/`, as repo-relative paths. */
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
 * The line index of the file's first statement — where the leading comment
 * region ends. A file with no statement at all reports its line count.
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
 * The `//` line comments that appear BEFORE the first statement, with their
 * line index.
 *
 * The compiler honours a pragma only in that region, and only in a line
 * comment: a block comment carrying the same token is ignored.
 */
function leadingLineComments(text) {
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

/** A pragma token must START the comment's content; the match is a prefix. */
const PRAGMA_TOKEN = /^@ts-(check|nocheck)(?![-\w])/i

/**
 * The compiler's effective state for a file: 'check', 'nocheck', or null.
 * The last pragma before the first statement wins.
 */
function pragmaState(text) {
  let state = null
  for (const comment of leadingLineComments(text)) {
    const match = PRAGMA_TOKEN.exec(comment.text)
    if (!match) continue
    state = match[1].toLowerCase() === 'check' ? 'check' : 'nocheck'
  }
  return state
}

/** Pragma-looking comments that sit after the first statement, where they mean nothing. */
function misplacedPragmas(text) {
  const limit = firstStatementLine(text)
  return allLineComments(text)
    .filter((c) => c.line >= limit && PRAGMA_TOKEN.test(c.text))
    .map((c) => c.text)
}

const states = new Map(testFiles().map((rel) => [rel, pragmaState(read(rel))]))
const optedIn = [...states].filter(([, state]) => state === 'check').map(([rel]) => rel)

test('the test program names the test tree and does not exclude it', () => {
  const config = JSON.parse(read('tsconfig.test.json'))
  assert.equal(config.extends, './tsconfig.json', 'the test program must extend the main one')
  assert.equal(config.compilerOptions.allowJs, true, 'allowJs is what puts the .js test files into the program')
  assert.equal(
    config.compilerOptions.checkJs,
    false,
    'checkJs would check every test file, which is a budgeted migration rather than a flag flip',
  )
  assert.ok(config.include.includes('test'), 'the test program must include the test tree')
  assert.ok(
    !config.exclude.includes('test'),
    'the test program must not exclude `test`: `extends` inherits the parent exclude, and an inherited `exclude` naming `test` ' +
      'leaves the compiler looking at nothing while the gate reports zero errors',
  )
})

test('the gate is wired into npm run verify and into CI', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.scripts['audit:test-types'], 'package.json lost the audit:test-types script')
  assert.ok(
    pkg.scripts.verify.includes('audit:test-types'),
    'npm run verify must run the test-tree gate, or it only runs on the machines that remember it',
  )
  const ci = read('.github/workflows/test.yml')
  assert.ok(
    ci.includes('npm run audit:test-types'),
    'CI must run the test-tree gate: a gate that lives only in the local verify chain is developer-machine-only',
  )
})

test('no test file opts itself out of checking, and no pragma sits where it means nothing', () => {
  for (const [rel, state] of states) {
    assert.notEqual(
      state,
      'nocheck',
      `${rel}: the effective pragma switches checking off — the compiler would check nothing in this file`,
    )
    for (const misplaced of misplacedPragmas(read(rel))) {
      assert.fail(
        `${rel}: carries a pragma-looking comment after the first statement (${JSON.stringify(misplaced)}); ` +
          'the compiler only honours a pragma before the first statement',
      )
    }
  }
})

test('the ratchet floor in the ledger equals the number of files that opt in', () => {
  const ledger = JSON.parse(read('scripts/ratchet-ledger.json'))
  const floor = /** @type {number} */ (ledger?.ratchets?.testOptInFloor?.value)
  assert.ok(Number.isInteger(floor), 'the ledger lost the opt-in floor')
  assert.ok(floor > 0, 'the floor is zero, so removing every pragma would still pass')
  assert.ok(optedIn.length > 0, 'no test file opts in to type checking — the gate would have nothing to guard')
  assert.equal(
    floor,
    optedIn.length,
    `the floor in scripts/ratchet-ledger.json is ${floor} but ${optedIn.length} file(s) opt in — raise it in the same diff`,
  )
})

test('the gate script exists next to the two any audits', () => {
  const stat = statSync(join(root, 'scripts', 'audit-test-types.mjs'))
  assert.ok(stat.isFile(), 'scripts/audit-test-types.mjs is missing')
  assert.ok(stat.size > 0, 'scripts/audit-test-types.mjs is empty')
})
