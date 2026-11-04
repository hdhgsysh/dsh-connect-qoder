/**
 * The ratchet ledger: the rules for the numbers that gate this repository.
 *
 * WHY A LEDGER AND NOT A CONSTANT
 *
 * Every gate used to keep its threshold as a constant in the script that
 * enforced it. That has exactly one failure mode, and it is the one this
 * module exists to close: the constant can be raised by anyone, in any diff,
 * with nothing in the diff to show for it. A budget of 2018 becomes 3000 and
 * the gate that was supposed to notice says nothing, because the number it
 * compares against moved with it. Nobody noticed, because the ratchet was a
 * number in a file, not a fact anyone could check.
 *
 * The ledger inverts that. The threshold lives in
 * `scripts/ratchet-ledger.json`, together with the record of how it got
 * there: a baseline and a chain of changes, each with a date and a reason.
 * A gate refuses any value the ledger does not account for, so the only way
 * to move a threshold is to record the move — and the record is exactly what
 * a reviewer reads.
 *
 * The chain has to be continuous: a change starts where the previous one
 * ended, and the value is where the last change ended. Editing the value on
 * its own breaks the chain, and the gate says so instead of passing.
 *
 * This module only reads. It never writes: raising a threshold is a
 * deliberate act with a reason in it, and a script that wrote the reason for
 * you would erase the one part that matters.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The ledger file, relative to the repository root. */
export const LEDGER_REL = 'scripts/ratchet-ledger.json'

/** The ledger file, absolute — derived from this module's own location, so a staged copy reads its own ledger. */
export const LEDGER_PATH = join(HERE, 'ratchet-ledger.json')

/** A ledger that does not add up. Every gate turns this into a red build. */
export class LedgerError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LedgerError'
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** A threshold value is a count, so a non-negative whole number. */
function isCount(value) {
  return Number.isInteger(value) && value >= 0
}

/** A reason that says something. */
function isText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Describe a thrown value in one line, whatever it was.
 *
 * @param {any} err
 * @returns {string}
 */
export function describeError(err) {
  if (err instanceof LedgerError) return err.message
  if (err && typeof err === 'object') {
    const anyErr = /** @type {any} */ (err)
    return String(anyErr.code ?? anyErr.message ?? err)
  }
  return String(err)
}

/**
 * Check one ratchet's shape, its change chain, and its value.
 *
 * @param {string} name
 * @param {any} ratchet
 */
function validateRatchet(name, ratchet) {
  if (!ratchet || typeof ratchet !== 'object') {
    throw new LedgerError(`ratchet "${name}" is not an object`)
  }
  const value = ratchet.value
  const baseline = ratchet.baseline
  const changes = ratchet.changes
  if (!isCount(value)) {
    throw new LedgerError(`ratchet "${name}" has no non-negative integer "value"`)
  }
  if (!baseline || typeof baseline !== 'object') {
    throw new LedgerError(`ratchet "${name}" has no "baseline"`)
  }
  if (!isCount(baseline.from)) {
    throw new LedgerError(`ratchet "${name}": baseline.from must be a non-negative integer`)
  }
  if (!ISO_DATE.test(String(baseline.on))) {
    throw new LedgerError(`ratchet "${name}": baseline.on must be an ISO date (YYYY-MM-DD)`)
  }
  if (!isText(baseline.reason)) {
    throw new LedgerError(`ratchet "${name}": baseline.reason must say why this number is the number`)
  }
  if (!Array.isArray(changes)) {
    throw new LedgerError(`ratchet "${name}": "changes" must be a list`)
  }
  let previous = baseline.from
  for (const [index, change] of changes.entries()) {
    const at = `change #${index + 1}`
    if (!change || typeof change !== 'object') {
      throw new LedgerError(`ratchet "${name}": ${at} is not an object`)
    }
    if (!isCount(change.from) || !isCount(change.to)) {
      throw new LedgerError(`ratchet "${name}": ${at} needs integer from/to`)
    }
    if (change.from === change.to) {
      throw new LedgerError(`ratchet "${name}": ${at} does not move the number (${change.from} → ${change.to})`)
    }
    if (change.from !== previous) {
      throw new LedgerError(
        `ratchet "${name}": ${at} starts at ${change.from} but the number before it was ${previous} — ` +
          'the recorded changes have to form one continuous chain',
      )
    }
    if (!ISO_DATE.test(String(change.on))) {
      throw new LedgerError(`ratchet "${name}": ${at}.on must be an ISO date (YYYY-MM-DD)`)
    }
    if (!isText(change.reason)) {
      throw new LedgerError(`ratchet "${name}": ${at}.reason must say why the number moved`)
    }
    previous = change.to
  }
  if (value !== previous) {
    throw new LedgerError(
      `ratchet "${name}" is at ${value} but the ledger accounts for ${previous} — ` +
        'every change has to be recorded as a change entry (from, to, date, reason); ' +
        'a number nobody accounted for is a number nobody noticed',
    )
  }
}

/**
 * Read and check the ledger.
 *
 * @param {string} [path]
 * @returns {any} the parsed ledger, with every ratchet in it checked
 */
export function loadLedger(path = LEDGER_PATH) {
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new LedgerError(`the ledger at ${path} cannot be read (${describeError(err)})`)
  }
  let data = null
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new LedgerError(`the ledger at ${path} is not valid JSON (${describeError(err)})`)
  }
  if (!data || typeof data !== 'object' || !data.ratchets || typeof data.ratchets !== 'object') {
    throw new LedgerError(`the ledger at ${path} has no "ratchets" object`)
  }
  for (const [name, ratchet] of Object.entries(data.ratchets)) {
    validateRatchet(name, ratchet)
  }
  return data
}

/**
 * The threshold one gate enforces.
 *
 * @param {any} ledger
 * @param {string} name
 * @returns {number}
 */
export function ratchetValue(ledger, name) {
  const ratchet = ledger?.ratchets?.[name]
  if (!ratchet) {
    throw new LedgerError(`the ledger has no ratchet called "${name}"`)
  }
  return ratchet.value
}
