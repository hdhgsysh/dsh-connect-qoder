/**
 * The fence around the redaction rule: one rule, one exit, and every upstream
 * body goes through it on the way to a message.
 *
 * Run: node --test test/redaction-closure.test.js
 *
 * WHY THIS EXISTS. The shape rules live in ONE module (src/host/errors.ts) and
 * the two upstream readers call them. That is the fix — but a fix nobody can
 * see is a fix that gets undone by the next contributor who adds an endpoint:
 * they read the body, they put it in the error message, and the credential the
 * gateway echoed back is now in the panel, in the log, and in whatever the
 * model is told about it. The rule was not in their way at all, because the
 * rule is not a rule — it is a call somebody remembered to make.
 *
 * So this file turns the convention into a fence, and the fence is about
 * SHAPE, not about output: a hand-rolled copy of the rule and the shared one
 * produce byte-identical text, so a behavioural assertion cannot tell them
 * apart. Only the code's shape can.
 *
 * What is checked, mechanically, with no hand-maintained file list:
 *   1. every upstream body read is either redacted on the spot or captured
 *      into a variable whose every later use is redacted or parsed;
 *   2. the rule has exactly one definition and both readers import THAT one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The files that read a body off the wire. */
const READERS = ['api-calls.ts', 'sse.ts']

/**
 * Drop comments, so a doc comment can never satisfy the fence.
 *
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//')
      if (at < 0) return line
      // `//` inside a URL is not a comment — the text before it ends in `:`.
      return line.slice(0, at).includes(':') ? line : line.slice(0, at)
    })
    .join('\n')
}

/**
 * Does this line mention `name` as a WHOLE identifier?
 *
 * `content-type` contains the letters `text`, and `-` is not an identifier
 * character, so a plain word boundary would read that as a use of the variable.
 *
 * @param {string} line
 * @param {string} name
 * @returns {boolean}
 */
function mentions(line, name) {
  return new RegExp(`(?<![A-Za-z0-9_$-])${name}(?![A-Za-z0-9_$-])`).test(line)
}

test('no upstream body reaches a message without the shared redaction rule', () => {
  /** @type {string[]} */
  const offenders = []
  for (const file of READERS) {
    const code = stripComments(readFileSync(join(root, 'src', 'host', 'upstream', file), 'utf8'))
    const lines = code.split('\n')
    // Which body variables are raw RIGHT NOW: a body captured through the rule
    // (`redactSecrets(await response.text())`) is already clean, so its later
    // uses need no second check. The state follows the declarations in file
    // order, because that is the order the reads happen in.
    /** @type {Map<string, boolean>} */
    const raw = new Map()
    lines.forEach((line) => {
      for (const match of line.matchAll(/const\s+(\w+)\s*=\s*await\s+\w+\.text\(\)/g)) {
        if (match[1] !== undefined) raw.set(match[1], true)
      }
      for (const match of line.matchAll(/const\s+(\w+)\s*=\s*redactSecrets\(/g)) {
        if (match[1] !== undefined) raw.set(match[1], false)
      }
      // Rule 1: a body read is either redacted on the spot, or captured into a
      // variable (whose uses rule 2 checks).
      if (/\.text\(\)/.test(line)) {
        const capturedHere = /const\s+\w+\s*=\s*await\s+\w+\.text\(\)/.test(line)
        if (!capturedHere && !line.includes('redactSecrets(')) {
          offenders.push(`${file}: ${line.trim()}`)
        }
      }
      // Rule 2: every use of a raw body is redacted or parsed.
      for (const [name, isRaw] of raw) {
        if (!isRaw) continue
        if (!mentions(line, name)) continue
        if (new RegExp(`const\\s+${name}\\s*=`).test(line)) continue
        if (line.includes('redactSecrets(')) continue
        if (line.includes('JSON.parse(')) continue
        if (line.includes('.exec(')) continue
        offenders.push(`${file}: ${line.trim()}`)
      }
    })
  }
  assert.deepEqual(
    offenders,
    [],
    'an upstream body must go through redactSecrets before it reaches a message:\n' + offenders.join('\n'),
  )
})

test('the redaction rule has exactly one definition and both readers import it', () => {
  const definitions = []
  for (const file of READERS) {
    const code = stripComments(readFileSync(join(root, 'src', 'host', 'upstream', file), 'utf8'))
    assert.doesNotMatch(
      code,
      /function\s+redactSecrets\s*\(/,
      `${file} defines its own redactSecrets — the rule must live in src/host/errors.ts only`,
    )
    assert.match(
      code,
      /import\s*\{[^}]*\bredactSecrets\b[^}]*\}\s*from\s*'\.\.\/errors\.ts'/,
      `${file} must import the shared rule from ../errors.ts`,
    )
    definitions.push(file)
  }
  assert.equal(definitions.length, READERS.length)
})
