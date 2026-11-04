/**
 * Contract replay — feeds committed real-wire fixtures through the plugin's own
 * shape readers, in CI, with no credential and no network.
 *
 * Run: node --test test/contract-replay.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * The plugin clones a private protocol with no version negotiation
 * (`COSY_VERSION '1.1.38'`, `CLIENT_TYPE '5'`). Its runtime drift triage only
 * speaks AFTER the gateway has changed, so it needs a frozen snapshot of what
 * the wire looked like on a known-good day. `test/` held only hand-written
 * inline samples, which prove a shape reader agrees with itself — a reader
 * tightened or loosened on purpose (or by accident) leaves every one of them
 * green, and the drift signal is gone.
 *
 * The fixture capture (`probe/capture-fixtures.mjs`) freezes real responses
 * under `test/fixtures/<region>.<kind>.json`. This suite replays them through
 * the SAME readers production uses. Two things it guards:
 *
 * 1. A shape reader that stops accepting a real wire shape — a regression a
 *    maintainer can only get by tightening it, and a user can only see as
 *    "update the plugin" on a live account. Fails here, in CI.
 * 2. A shape reader that is looser than the wire — e.g. one that would accept
 *    a renamed envelope. That is not caught by "does not throw", so this suite
 *    also asserts a few structural facts the plugin actually depends on.
 *
 * Fixtures carry NO tokens. COSY responses do not echo the user's bearer or
 * the decrypted app token, and the capture script scrubs personal identity
 * fields to `<redacted>` before saving. That scrub is checked below for every
 * fixture — an identity field the scrub stopped covering, or any token-shaped
 * string at all, fails the suite rather than silently entering the repo.
 *
 * A fixture missing entirely is a FAILURE, not a skip: the repo owns these
 * files, and deleting one is exactly the kind of quiet break this file exists
 * to surface. Regenerate them with `node probe/capture-fixtures.mjs`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readModelCatalogShape } from '../src/host/upstream.ts'
import { readUsageShape } from '../src/host/upstream/fetch-usage.ts'
import { readCampaignsShape, readUserInfoShape } from '../src/host/upstream/api-calls.ts'
import { ProtocolShapeChangedError, isProtocolShapeChangedError } from '../src/host/errors.ts'

const FIXTURE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures')

/** The dispatch table the capture script and this suite share by kind name. */
const SHAPE_READERS = {
  'model-catalog': readModelCatalogShape,
  'usage': readUsageShape,
  'campaigns': readCampaignsShape,
  'userinfo': readUserInfoShape,
}

/**
 * The fixtures this suite promises to own. A member that disappears is a real
 * regression signal — either someone deleted it, or a capture was never taken
 * for a newly added endpoint and the drift net has a hole it did not have
 * before. Pinned by NAME so a single missing file turns red, not just an
 * emptied directory.
 */
const EXPECTED_FIXTURES = [
  'qoder-cn.model-catalog.json',
  'qoder-cn.usage.json',
  'qoder-cn.campaigns.json',
  'qoder-cn.userinfo.json',
  'qoder.model-catalog.json',
]

/** Load every committed fixture; fail loudly if the directory is gone. */
function loadFixtures() {
  if (!existsSync(FIXTURE_DIR)) return []
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'))
      const meta = raw?._meta
      const kind = typeof meta?.kind === 'string' ? meta.kind : null
      const region = typeof meta?.region === 'string' ? meta.region : null
      return { name, kind, region, fixture: raw }
    })
}

const FIXTURES = loadFixtures()

test('contract-replay: fixtures directory exists and holds at least one snapshot', () => {
  // Loud, not silent. An empty directory means someone removed the whole set
  // (or the glob broke), which is a real regression signal on its own.
  assert.ok(
    FIXTURES.length > 0,
    `test/fixtures/ is empty or missing — regenerate with \`node probe/capture-fixtures.mjs\` on a machine with a Qoder sign-in`,
  )
})

test('contract-replay: every expected fixture is present', () => {
  // A single missing file is a FAILURE, not a skip. The capture script prints
  // the opposite for a NO-CREDENTIAL run (where it has written nothing and
  // should not silently break CI on an already-good machine); here the repo
  // owns these files, so any gap is a real regression signal.
  const present = new Set(FIXTURES.map((entry) => entry.name))
  const missing = EXPECTED_FIXTURES.filter((name) => !present.has(name))
  assert.deepEqual(
    missing,
    [],
    `missing fixture(s): ${missing.join(', ') || '(none)'} — regenerate with \`node probe/capture-fixtures.mjs\``,
  )
})

for (const { name, kind, region, fixture } of FIXTURES) {
  const label = `${region ?? '?'} ${kind ?? '?'} (${name})`

  test(`contract-replay: ${label} has a recognised kind`, () => {
    assert.ok(kind !== null, `${name} is missing _meta.kind`)
    assert.ok(SHAPE_READERS[kind], `${name} has unknown kind ${JSON.stringify(kind)}`)
  })

  test(`contract-replay: ${label} carries no token-shaped string`, () => {
    // A committed file must never hold a bearer or PAT. The capture script
    // redacts token-shaped runs before printing, scrubs identity fields before
    // saving, AND refuses to save a body that echoes any credential field
    // verbatim; this is the CI-side heuristic for the same threat, run for
    // EVERY fixture — not just the userinfo surface that is most obviously
    // personal.
    //
    // Matched on the VALUE position only (`: "..."` or `:"..."`), never on a
    // JSON key — real COSY fields are long `[\w-]` runs themselves
    // (`dedicated_resource_packages`, campaign ids like `c-daily-checkin-20261018`)
    // and must not trip the guard. The 32-char floor clears those while still
    // catching any credential-length secret (bearers and PATs are far longer).
    // The `?` after `:` is load-bearing: this suite stringifies with
    // `JSON.stringify(fixture)` (compact, no spaces), not the indented capture
    // format, so the separator is `:"` in compact JSON and `: "` if a future
    // change re-indents it.
    const serialized = JSON.stringify(fixture)
    assert.ok(
      !/: ?"[\w-]{32,}"/.test(serialized),
      `${name}: fixture contains a token-shaped string (32+ chars of [\\w-] in a value); redact before committing`,
    )
  })

  test(`contract-replay: ${label} is accepted by the shape reader production uses`, () => {
    const reader = SHAPE_READERS[kind]
    assert.ok(reader, `${name}: no reader for ${JSON.stringify(kind)}`)
    let result
    try {
      result = reader(fixture.body)
    } catch (error) {
      if (isProtocolShapeChangedError(error)) {
        assert.fail(
          `${name}: the production shape reader REJECTS this captured wire shape — ` +
            `${error.message}. Either the gateway changed (refresh fixtures) or ` +
            `the reader was tightened (fix the reader).`,
        )
      }
      throw error
    }
    assert.ok(result !== undefined, `${name}: reader returned nothing`)
  })

  test(`contract-replay: ${label} was captured as a shape the plugin can consume`, () => {
    // The shape reader proving "not drift" is necessary but not sufficient — it
    // would also accept an envelope that renamed every field it does not check.
    // These structural facts are what the plugin actually reads.
    const body = fixture.body
    switch (kind) {
      case 'model-catalog': {
        const chat = readModelCatalogShape(body)
        assert.ok(Array.isArray(chat), `${name}: chat is not an array`)
        assert.ok(chat.length > 0, `${name}: chat is empty — an empty catalog means the reader would wipe a live list`)
        for (const entry of chat) {
          assert.ok(entry !== null && typeof entry === 'object', `${name}: a chat entry is not an object`)
          const record = entry
          assert.equal(typeof record.key, 'string', `${name}: an entry has no string \`key\``)
          assert.equal(typeof record.display_name, 'string', `${name}: an entry has no string \`display_name\``)
          // Type facts the reader does NOT check but the card relies on. A wire
          // that turns `max_input_tokens` into a string or `is_reasoning` into
          // a number slips past the reader, so pin the types here.
          for (const numericField of ['max_input_tokens', 'price_factor']) {
            if (numericField in record && record[numericField] !== null && record[numericField] !== undefined) {
              assert.equal(typeof record[numericField], 'number', `${name}: \`${numericField}\` is not a number`)
              assert.ok(record[numericField] > 0, `${name}: \`${numericField}\` is not positive`)
            }
          }
          for (const boolField of ['enable', 'is_vl', 'is_reasoning', 'is_default']) {
            if (boolField in record && record[boolField] !== null && record[boolField] !== undefined) {
              assert.equal(typeof record[boolField], 'boolean', `${name}: \`${boolField}\` is not a boolean`)
            }
          }
          if ('context_config' in record && record.context_config !== null && record.context_config !== undefined) {
            assert.equal(typeof record.context_config, 'object', `${name}: \`context_config\` is not an object`)
          }
        }
        break
      }
      case 'usage': {
        const { record } = readUsageShape(body)
        const keys = Object.keys(record)
        assert.ok(keys.length > 0, `${name}: usage record has no fields at all`)
        // The reader accepts a body when ANY known field is present — including
        // `display_mode`, which is the wrapper's own field and carries no quota.
        // So a gateway that renames the inner quota wrapper while leaving the
        // outer wrapper intact passes the reader and then reads nothing,
        // rendering "no usage" silently. Pin the fixture's inner body to carry
        // at least one quota half, so a capture from a renamed wire fails HERE
        // rather than as a silent "no usage" on a live account.
        const inner = body.qoderUsage ?? body.data ?? body
        const innerKeys = Object.keys(inner)
        const hasQuotaField = innerKeys.some((key) =>
          ['user_quota', 'userQuota', 'add_on_quota', 'addOnQuota', 'is_quota_exceeded', 'isQuotaExceeded'].includes(key),
        )
        assert.ok(
          hasQuotaField,
          `${name}: inner usage body has no quota field (keys: ${innerKeys.join(', ') || '(none)'}) — ` +
            `this looks like a renamed wire the reader would silently accept`,
        )
        // The panel renders quota halves; a non-numeric `total` would render as
        // a silent zero. Assert every quota half that is present, not just one.
        for (const half of [record.user_quota ?? record.userQuota, record.add_on_quota ?? record.addOnQuota]) {
          if (half !== null && half !== undefined && typeof half === 'object') {
            const total = half.total
            assert.ok(
              typeof total === 'number' && total >= 0,
              `${name}: a quota half's \`total\` is not a non-negative number`,
            )
          }
        }
        break
      }
      case 'campaigns': {
        const envelope = readCampaignsShape(body)
        if (Array.isArray(envelope.campaigns)) {
          for (const campaign of envelope.campaigns) {
            assert.ok(campaign !== null && typeof campaign === 'object', `${name}: a campaign entry is not an object`)
          }
        }
        break
      }
      case 'userinfo': {
        // The personal identity fields a committed fixture may still carry MUST
        // be redacted — a capture script that stopped scrubbing them would leak
        // a user's id or email into the repo, and nothing else catches that.
        const identity = readUserInfoShape(body)
        for (const key of ['id', 'user_id', 'name', 'nickname', 'email']) {
          const value = identity[key]
          if (typeof value === 'string' && value !== '') {
            assert.ok(
              value.includes('<redacted>') || /^<redacted len=\d+>$/.test(value),
              `${name}: personal field \`${key}\` is not redacted (found ${JSON.stringify(value.slice(0, 24))})`,
            )
          }
        }
        break
      }
      default:
        break
    }
  })
}

/**
 * A sibling-group absence is NOT drift — the global edition has no `developer`
 * group (`probe/model-shape.mjs` measured it). This is pinned separately so a
 * future "require every known group" tightening fails loudly here rather than
 * on a real global account.
 */
test('contract-replay: a catalog that lacks a sibling group is still accepted (global edition)', () => {
  const global = FIXTURES.find((entry) => entry.region === 'qoder' && entry.kind === 'model-catalog')
  if (global === undefined) {
    // Not a failure: the CN fixture alone is enough to prove the readers work,
    // and the global one may not have been captured on a given machine.
    return
  }
  assert.equal(
    typeof global.fixture.body.developer,
    'undefined',
    'premise: the global fixture has no developer group',
  )
  const chat = readModelCatalogShape(global.fixture.body)
  assert.ok(Array.isArray(chat) && chat.length > 0, 'a global catalog without developer must still resolve')
})

/** `readModelCatalogShape` and the drift class are the shared vocabulary. */
test('contract-replay: ProtocolShapeChangedError stays the drift vocabulary', () => {
  assert.throws(
    () => readModelCatalogShape({ renamed: [] }),
    (error) => isProtocolShapeChangedError(error) && error instanceof ProtocolShapeChangedError,
  )
})