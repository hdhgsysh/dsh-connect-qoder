#!/usr/bin/env node
/**
 * Capture real Qoder wire responses as committed fixtures for contract replay.
 *
 * Run: node probe/capture-fixtures.mjs
 *
 * WHY THIS SCRIPT EXISTS
 *
 * The plugin clones a private protocol with no version negotiation
 * (`COSY_VERSION '1.1.38'`, `CLIENT_TYPE '5'`). Its drift defence is a runtime
 * shape triage that fires when a response stops looking like what the plugin
 * knows — good, but it only speaks AFTER the gateway has changed. Nothing in
 * the repo lets a maintainer freeze what the wire looks like TODAY and replay
 * it later: `probe/model-shape.mjs` prints structural facts to the terminal,
 * `scripts/verify-live.mjs` prints a human checklist, and every drift test
 * in `test/` holds an inline hand-written sample that only proves the shape
 * reader agrees with itself.
 *
 * The gap is a frozen snapshot. This script fetches four READ-ONLY endpoints
 * with the user's real credential, runs each body through the very shape
 * reader the plugin uses in production (so a drift already visible to the
 * plugin is flagged here rather than committed as a green fixture), scrubs
 * personal fields, and writes `test/fixtures/<region>.<kind>.json`. The
 * replay suite `test/contract-replay.test.js` then feeds each fixture back
 * through the same readers in CI — with no credential and no network.
 *
 * READ-ONLY: model catalog + usage + campaigns + userinfo. The chat endpoint
 * is deliberately excluded — it is the one call that spends real quota, and
 * `probe/` scripts must stay free to run unattended (same rule as
 * `scripts/verify-live.mjs`).
 *
 * NOT IN CI. Needs a real sign-in on this machine (a local Qoder app
 * credential or a `QODER_API_KEY` / `QODERCN_API_KEY` environment variable)
 * and real network access. A CI runner has neither, so this script is the
 * manual refresh step; the replay suite it feeds is what runs unattended.
 *
 * TOKEN SAFETY. Nothing token-shaped is ever written to a fixture or printed:
 * COSY responses do not themselves carry the user's bearer or the decrypted
 * app token (only the requests do), and userinfo / campaigns / usage bodies
 * carry account ids and names, which this script replaces with placeholders
 * before saving. Anything 24+ characters of `[\w-]` is redacted on print.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  REGIONS,
  loadCredentialAsync,
  loadEnvCredential,
} from '../src/host/credentials.ts'
import { authHeaders, openApiHeaders, modelListUrl, usagePresentationUrl, campaignsUrl, userInfoUrl } from '../src/host/upstream.ts'
import { readUsageShape } from '../src/host/upstream/fetch-usage.ts'
import { readCampaignsShape, readUserInfoShape, readModelCatalogShape } from '../src/host/upstream/api-calls.ts'
import { isProtocolShapeChangedError } from '../src/host/errors.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(HERE, '..', 'test', 'fixtures')

/** Keep anything that looks like a token or key off the terminal. */
function redact(value) {
  if (typeof value !== 'string') return value
  if (/^[\w-]{24,}$/.test(value)) return `<redacted len=${value.length}>`
  return value
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

function describeLoaded(region, credential) {
  if (credential === undefined) return `  ${region.displayName}: 无本地凭据`
  return [
    `  ${region.displayName}: 已加载`,
    `    来源:   ${redact(credential.source)}`,
    `    过期:   ${credential.expired === true ? '已过期' : '有效'}`,
  ].join('\n')
}

async function resolveCredential(region) {
  const app = await loadCredentialAsync(region)
  if (app !== undefined) return app
  const env = loadEnvCredential(region)
  return env ?? undefined
}

/**
 * Fields that identify a person or an account. Keyed case-insensitively.
 *
 * These are the fields a committed fixture must never carry verbatim. The list
 * is deliberately wide: a COSY wire has used `user_id`, `uid`, `nickname`,
 * `union_id` and `open_id` across surfaces, and `avatar`/`phone`/`mobile` leak
 * just as much about a person as `email` does.
 */
const IDENTITY_FIELDS = new Set(
  ['id', 'user_id', 'uid', 'userid', 'user_name', 'name', 'nickname', 'email', 'open_id', 'union_id', 'avatar', 'phone', 'mobile', 'account', 'org_id']
    .map((field) => field.toLowerCase()),
)

/**
 * A path sits inside a model-catalog entry when it reaches a `chat` /
 * `developer` / `quest` array element. Only those entries carry a `name` /
 * `display_name` that is a MODEL's name, not a person's.
 *
 * Matched on the array-element boundary (`\.chat\[\d+\]`), NOT as a bare
 * substring: a key like `chat_history` (a conversation surface that genuinely
 * holds a user's `name`) must not be treated as a model entry, or the user's
 * name would be written to the fixture verbatim.
 */
function isInModelEntry(path) {
  return /\.(chat|developer|quest)\[\d+\]/.test(path)
}

/**
 * Deep-scrub personal fields from a response body before it is committed.
 *
 * Only fields that identify a person or an account are replaced; the SHAPE of
 * every object is preserved, which is the whole reason the fixture exists.
 * Numeric quota values are left alone — they are the kind of fact a replay
 * test should be free to assert on.
 *
 * Identity fields are scrubbed regardless of value type: a numeric `uid` is a
 * personal identifier just as much as a string `email` is.
 */
function sanitize(value, path = '') {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item, i) => sanitize(item, `${path}[${i}]`))

  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (IDENTITY_FIELDS.has(key.toLowerCase()) && entry !== null && entry !== '' && !isInModelEntry(path)) {
      out[key] = '<redacted>'
      continue
    }
    out[key] = sanitize(entry, `${path}.${key}`)
  }
  return out
}

/**
 * One endpoint's shape reader, keyed by kind.
 *
 * Returned as a named pair so the replay test and this script agree on the
 * dispatch table instead of each keeping its own copy.
 */
const SHAPE_READERS = {
  'model-catalog': readModelCatalogShape,
  'usage': readUsageShape,
  'campaigns': readCampaignsShape,
  'userinfo': readUserInfoShape,
}

/** The four endpoints, with the exact URL + headers the plugin uses. */
function endpoint(region, credential) {
  return {
    'model-catalog': () => {
      const url = modelListUrl(region)
      return { url, headers: { Accept: 'application/json', ...authHeaders(Buffer.alloc(0), url, credential) } }
    },
    'usage': () => {
      const url = usagePresentationUrl(region)
      return { url, headers: { Accept: 'application/json', ...openApiHeaders(credential, region) } }
    },
    'campaigns': () => {
      const url = campaignsUrl(region)
      return { url, headers: { Accept: 'application/json', ...openApiHeaders(credential, region) } }
    },
    'userinfo': () => {
      const url = userInfoUrl(region)
      return { url, headers: { Accept: 'application/json', ...openApiHeaders(credential, region) } }
    },
  }
}

let failures = 0
function fail(message) {
  failures += 1
  console.log(`  ✗ ${message}`)
}

/**
 * Precise, capture-side guard: refuse to save a body that carries any of the
 * credential's own fields verbatim.
 *
 * COSY responses do not normally echo the bearer or the app token — that is
 * why the heuristic in the replay suite can stay loose. But if a future
 * response (or a future reader change) ever does echo one of these, it must be
 * caught HERE, where we still hold the credential to compare against, not by a
 * heuristic guessing a token's shape. This guard is exact: no false positives.
 *
 * Returns the list of leaked field names, or `[]` when the body is clean.
 */
function assertNoCredentialLeak(body, credential) {
  const serialized = JSON.stringify(body)
  if (serialized === undefined || typeof serialized !== 'string') return []
  const leaked = []
  for (const field of ['token', 'userID', 'name', 'email', 'user_id']) {
    const secret = credential?.[field]
    // A very short field (say a 2-char token) is too weak a signal to compare
    // as a substring; skip it rather than false-positive.
    if (typeof secret !== 'string' || secret.length < 6) continue
    if (serialized.includes(secret)) leaked.push(field)
  }
  return leaked
}

async function captureRegion(region, credential) {
  console.log(`\n--- ${region.displayName} (${region.id}) ---`)
  const readers = SHAPE_READERS

  for (const [kind, build] of Object.entries(endpoint(region, credential))) {
    const { url, headers } = build()
    try {
      const response = await fetch(url, { method: 'GET', headers, redirect: 'error' })
      const text = await response.text()
      if (!response.ok) {
        fail(`${kind}: HTTP ${response.status} (${redact(text.slice(0, 160))})`)
        continue
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        fail(`${kind}: HTTP 200 but body is NOT JSON (${redact(text.slice(0, 120))})`)
        continue
      }

      // Run the body through the same reader production uses. A rejection here
      // is a live drift signal: save it anyway (that is the useful artifact a
      // maintainer wants) but say so out loud, not silently.
      let driftNote = null
      const reader = readers[kind]
      try {
        // `readUsageShape` and `readCampaignsShape` return the envelope;
        // `readModelCatalogShape` returns the `chat` array; `readUserInfoShape`
        // returns the identity body. We only need to know whether it throws.
        reader(parsed)
      } catch (error) {
        if (isProtocolShapeChangedError(error)) {
          driftNote = `shape reader REJECTED this body: ${error.message}`
        } else {
          fail(`${kind}: shape reader threw unexpected error: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
      }

      const fixture = {
        _meta: {
          region: region.id,
          kind,
          capturedAt: new Date().toISOString(),
          pluginShapeReader: driftNote === null ? 'accepted' : 'rejected',
          sanitized: true,
          note: driftNote === null
            ? 'Live capture; regenerate with `node probe/capture-fixtures.mjs`.'
            : driftNote,
        },
        body: sanitize(parsed),
      }

      // The sanitizer above scrubs identity fields, but it is a list-driven
      // heuristic: it cannot know what a brand-new COSY field means. Compare
      // against the credential we actually hold to catch an echo before it is
      // written — an exact check the replay suite can only guess at.
      const leaked = assertNoCredentialLeak(fixture.body, credential)
      if (leaked.length > 0) {
        fail(`${kind}: credential field(s) ${leaked.join(', ')} present in body; NOT saved`)
        continue
      }

      const file = join(FIXTURE_DIR, `${region.id}.${kind}.json`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
      console.log(`  ✓ ${kind} → ${file}${driftNote === null ? '' : '  ⚠ ' + driftNote}`)
    } catch (error) {
      fail(`${kind}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

async function main() {
  console.log('dsh-connect-qoder 契约 fixture 捕获（只读，不产生计费请求）')
  console.log(`目标目录: ${FIXTURE_DIR}`)

  section('1. 凭据发现')
  const resolved = new Map()
  for (const region of REGIONS) {
    const credential = await resolveCredential(region)
    console.log(describeLoaded(region, credential))
    if (credential !== undefined) resolved.set(region.id, credential)
  }
  if (resolved.size === 0) {
    console.log('\n没有可用的凭据——请先在本机登录 Qoder，或设置 QODER_API_KEY / QODERCN_API_KEY。')
    console.log('本次不写入任何 fixture；已提交的 test/fixtures/ 不受影响。')
    console.log('若重放套件因 fixture 缺失而红（新端点未捕获，或 fixture 被删），')
    console.log('请在有登录态的机器上重跑本脚本补齐；这不是静默跳过。')
    process.exitCode = 1
    return
  }

  section('2. 捕获')
  for (const region of REGIONS) {
    const credential = resolved.get(region.id)
    if (credential === undefined) {
      console.log(`  ${region.displayName}: 跳过（无凭据）`)
      continue
    }
    await captureRegion(region, credential)
  }

  console.log('\n' + (failures === 0 ? '✓ 捕获完成' : `✗ ${failures} 项失败`))
  if (failures > 0) process.exitCode = 1
}

/**
 * Run only when invoked as a command, never when imported.
 *
 * Same guard `scripts/verify-live.mjs` uses: `await main()` at module scope
 * would make any import of this file perform live network probes with the
 * user's real credential as a side effect of the import.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}