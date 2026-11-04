/**
 * Guard the `probe/` scripts' imports.
 *
 * Run: node --test test/probe-imports.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * `probe/` scripts are the repository's EVIDENCE for facts this project insists
 * on measuring rather than assuming: `docs/KNOWN_GAPS.md` and `docs/issues/10`
 * cite `probe/machineos-probe.mjs` and `probe/model-shape.mjs` by path for the
 * MACHINE_OS-acceptance and envelope-shape conclusions.
 *
 * Their imports were written when the host build emitted per-module `lib/*.js`
 * output. `tsdown.config.mjs` now emits ONE bundled `lib/index.js`
 * (`splitting: false`, "no per-module lib/ output"), so `../lib/credentials.js`,
 * `../lib/upstream.js` and `../lib/claim.js` stopped existing — and four of the
 * five probes became `ERR_MODULE_NOT_FOUND` with nothing anywhere to notice it.
 * A documented measurement nobody can re-run is not evidence, it is a memory.
 *
 * The convention for offline code that needs the sources is the one the suites
 * already use — import `../src/host/*.ts` and let Node strip types natively
 * (22.19+/24), which `tsdown.config.mjs` states outright. This file holds that
 * convention for `probe/` too, so the next removed layout fails HERE rather
 * than inside a hand-run script months later.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROBE = join(root, 'probe')

/**
 * Comments in these files discuss paths in prose (including the very layout
 * that broke), so a scan for import shape must look at code, not at prose.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** Every RELATIVE module specifier a probe imports (bare packages excluded). */
function relativeImports(source) {
  const found = []
  for (const match of stripComments(source).matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) {
    if (match[1].startsWith('.')) found.push(match[1])
  }
  return found
}

const probes = readdirSync(PROBE).filter((name) => name.endsWith('.mjs')).sort()

test('the probe directory is discovered, so the guards below are not vacuous', () => {
  assert.ok(probes.length > 0, 'no probe/*.mjs files found — did the directory move?')
})

test('every relative import in every probe resolves to a file that exists', () => {
  const broken = []
  for (const name of probes) {
    const source = readFileSync(join(PROBE, name), 'utf8')
    for (const specifier of relativeImports(source)) {
      const target = resolve(PROBE, specifier)
      if (!existsSync(target)) broken.push(`${name} imports '${specifier}' -> missing ${target}`)
    }
  }
  assert.deepStrictEqual(broken, [], `probes cannot run:\n${broken.join('\n')}`)
})

test('no probe reaches for the per-module lib/ layout the host build no longer emits', () => {
  // Named separately from the resolution check above so the failure says WHY:
  // `lib/` holds exactly the bundled `index.js` plus the client bundle, and that
  // bundle's exports are the plugin surface (`apply`, `inject`, `Config`, …) —
  // never the internal helpers a probe needs.
  const offenders = []
  for (const name of probes) {
    const source = readFileSync(join(PROBE, name), 'utf8')
    for (const specifier of relativeImports(source)) {
      if (specifier.startsWith('../lib/')) offenders.push(`${name}: ${specifier}`)
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `import the sources ('../src/host/<module>.ts') instead — lib/ is one bundled entry point:\n${offenders.join('\n')}`,
  )
})
