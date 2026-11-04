/**
 * The token-history shape is a contract between two processes.
 *
 * Run: node --test test/token-history-contract.test.js
 *
 * WHY THIS EXISTS. `TokenDayRecord` is declared twice — once in
 * `src/host/token-counter.ts` (what the host sends on the `usage` route) and
 * once in `src/client/card-model.ts` (what the card and the composer pill
 * render). Neither side can import the other: the AGENTS.md rule "no client
 * file imports from src/host/" is load-bearing (a client bundle that reaches
 * into host code would drag Node-only modules into the browser), and the host
 * importing the client's types is backwards for the same reason.
 *
 * The duplication is therefore deliberate, but it is also exactly the shape
 * that rots: a field added on one side and not the other produces no compile
 * error, no runtime throw, just a card that prints `undefined` or a chart
 * that silently drops a series. The 0.7.0 round shipped `tokensHistory` with
 * three copies of the record type (host, card-model, chart props) and nothing
 * connecting them.
 *
 * This file is the connection. It reads both declarations as *text* and
 * compares their field lists, so the check runs on a bare checkout with no
 * bundler and no host installed. Rename a field on either side and this goes
 * red naming the field.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** `export interface TokenDayRecord { ... }` → its field names. */
function fieldsOf(text) {
  const match = /export\s+interface\s+TokenDayRecord\s*\{([\s\S]*?)\n\}/.exec(text)
  assert.ok(match, 'TokenDayRecord must be declared in this file')
  const body = match[1]
  const fields = [...body.matchAll(/^\s*(\w+)\s*[?:]/gm)].map((m) => m[1])
  assert.ok(fields.length > 0, 'TokenDayRecord must declare at least one field')
  return fields.sort()
}

const host = readFileSync(join(root, 'src', 'host', 'token-counter.ts'), 'utf8')
const client = readFileSync(join(root, 'src', 'client', 'card-model.ts'), 'utf8')

test('host and client declare the same TokenDayRecord fields', () => {
  const hostFields = fieldsOf(host)
  const clientFields = fieldsOf(client)
  assert.deepEqual(
    clientFields,
    hostFields,
    `TokenDayRecord has diverged between host and client — the usage route sends one shape and the card renders another. ` +
      `host: [${hostFields.join(', ')}]; client: [${clientFields.join(', ')}]. ` +
      'Update both declarations and their consumers (card.tsx, composer-usage-pill.tsx, token-history-chart.tsx).',
  )
})

test('the chart consumes TokenDayRecord rather than redeclaring it', () => {
  // The chart is the only consumer that needs the type as a *type* (its props
  // are typed by it). Importing it from card-model is what keeps the shape
  // honest; a local re-declaration would be a third copy that this file cannot
  // see.
  const chart = readFileSync(join(root, 'src', 'client', 'token-history-chart.tsx'), 'utf8')
  assert.match(
    chart,
    /import\s*\{[^}]*\btype\s+TokenDayRecord\b[^}]*\}\s*from\s*'\.\/card-model\.ts'/,
    'token-history-chart.tsx must import TokenDayRecord from card-model.ts instead of declaring its own copy',
  )
  const localCopies = chart.match(/interface\s+TokenDayRecord|type\s+TokenDayRecord\s*=/g) ?? []
  assert.equal(localCopies.length, 0, 'token-history-chart.tsx must not redeclare TokenDayRecord')
})

test('every day record field the host writes is a field the chart can read', () => {
  // A guard with teeth: the chart is the renderer, so it must not reach for a
  // field that neither declaration carries. This is the direction that
  // actually reaches a user — the host writing `cachedTokens` while the chart
  // reads `cached` draws zeros with no error anywhere.
  const chart = readFileSync(join(root, 'src', 'client', 'token-history-chart.tsx'), 'utf8')
  const declared = new Set(fieldsOf(client))
  // `r.<field>` property reads inside the chart component.
  const reads = [...chart.matchAll(/\br\.(\w+)/g)].map((m) => m[1])
  const unknown = [...new Set(reads)].filter((field) => !declared.has(field))
  assert.deepEqual(
    unknown,
    [],
    `token-history-chart.tsx reads fields that are not on TokenDayRecord: ${unknown.join(', ')}`,
  )
})
