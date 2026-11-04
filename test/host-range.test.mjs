/**
 * The peer ranges must still admit every host the plugin is published for,
 * judged against EVERY version DSH has ever published — not against a hand
 * written list of four.
 *
 * WHAT THIS CATCHES THAT peer-compat.test.js CANNOT
 *
 * `test/peer-compat.test.js` checks the ranges against a golden table someone
 * typed (ADMIT: 4 versions, REFUSE: 3). It answers "did the range move away
 * from the versions we already knew about", which is what you want at review
 * time. It cannot answer "is this range still aligned with the world", because
 * the world is 36 published versions and the table names 7 of them.
 *
 * This test scores each range against the entire published version list:
 *
 *   universe  = every @deepseek-ai/dsh version npm has ever had (36 today)
 *   admitted  = the subset the host would accept for this peer's range
 *
 * and compares that partition to `test/host-range.golden.json`. The failure
 * message names the exact version that moved:
 *
 *   @deepseek-ai/dsh-settings ">=0.2.0-rc.0 <0.3"
 *     now REFUSES 0.2.2-rc.1 (was admitted)
 *
 * WHICH IS WHY THIS FILE IS `*.mjs` AND NOT `*.test.js`
 *
 * `npm test` is `node --test "test/*.test.js"` — an explicit glob, not a
 * recursive scan. A `.mjs` file in `test/` is therefore NOT picked up by the
 * local suite, and this gate runs ONLY in CI (`.github/workflows/test.yml`,
 * step "Host range covers the whole published universe"). That split is
 * deliberate:
 *
 *   peer-compat.test.js  = fast, offline, runs on every bare checkout. Guards
 *                          the DECISION (which host lines we claim).
 *   host-range.test.mjs  = same math, but against the frozen universe. Guards
 *                          ALIGNMENT with the registry. Needs no network (the
 *                          universe is committed), but it does need the golden
 *                          file, so it belongs with the release gate.
 *
 * If you ever wire this into `npm test`, rename it to `.test.js` — but then
 * `scripts/update-host-range.mjs` must have run first, and a fresh clone that
 * has never run it would fail for the wrong reason.
 *
 * REFRESHING IT
 *
 *   node scripts/update-host-range.mjs          # rewrite the golden file
 *   node scripts/update-host-range.mjs --check  # just print the diff
 *
 * Then READ the diff. A version leaving `admitted` is a decision, not a chore:
 * either the range is too narrow for a host line this plugin actually supports,
 * or this plugin genuinely stops supporting it and the range should say so.
 */
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { diffAgainstGolden, explain, hostPeers, partition, satisfies } from './helpers/host-range.mjs'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(`${REPO_ROOT}package.json`, 'utf8'))
const golden = JSON.parse(readFileSync(`${REPO_ROOT}test/host-range.golden.json`, 'utf8'))

test('the golden universe is the whole published list, not a sample', () => {
  assert.ok(Array.isArray(golden.universe) && golden.universe.length > 0, 'golden.universe is empty')
  assert.equal(golden.universePackage, '@deepseek-ai/dsh')
  // Ascending order matters: "newest admitted" and "oldest refused" are only
  // meaningful after sorting, and the registry's publish order is NOT version
  // order (0.2.1-alpha.1 ships after 0.2.0-rc.2).
  const sorted = [...golden.universe].sort((a, b) => {
    const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a)
    const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b)
    for (let i = 1; i <= 3; i += 1) {
      if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]) ? -1 : 1
    }
    return a.localeCompare(b)
  })
  assert.deepEqual(golden.universe, sorted, 'golden.universe must be sorted ascending')
  // Every DSH release line this plugin ships for is represented.
  for (const line of ['0.1.7-rc.1', '0.2.0-rc.1', '0.2.1-rc.2']) {
    assert.ok(golden.universe.includes(line), `golden.universe is missing ${line}`)
  }
})

test('every host-gated peer range still scores the same against the universe', () => {
  const report = diffAgainstGolden(manifest, golden)
  assert.deepEqual(
    report,
    [],
    `the peer ranges and the published version universe have drifted apart:\n\n${explain(report)}\n\n` +
      'If this is expected, run `node scripts/update-host-range.mjs` and commit the diff with a ' +
      'note saying which host line moved and why.',
  )
})

test('the recorded partition is self-consistent with its own range', () => {
  // Catches a hand-edited golden file even if it happens to parse: the admitted
  // list must be exactly the universe filtered by the range recorded beside it.
  for (const [name, entry] of Object.entries(golden.peers)) {
    const { admitted, refused } = partition(golden.universe, entry.range)
    assert.deepEqual(entry.admitted, admitted, `${name}: recorded admitted list does not match its own range`)
    assert.equal(admitted.length + refused.length, golden.universe.length, `${name}: partition is not exhaustive`)
  }
})

test('the range claims a floor it does not silently round up', () => {
  // A stable floor is the classic bug in this repo's history: `>=0.1.5` does
  // NOT admit `0.1.5-rc.3`, because a prerelease sorts below its stable
  // version. Any range whose lower bound lacks a prerelease tag therefore
  // cannot admit that same version's own rc/alpha builds — which is almost
  // certainly not what the author meant.
  for (const [name, range] of hostPeers(manifest)) {
    const floor = /^>=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(range)
    assert.ok(floor, `${name} has no parsable ">=" lower bound: ${range}`)
    if (!floor[1].includes('-')) {
      const prerelease = `${floor[1]}-rc.1`
      if (golden.universe.includes(prerelease)) {
        assert.ok(
          !satisfies(prerelease, range),
          `${name} "${range}" has a stable floor but admits ${prerelease} — ` +
            'check whether the floor is meant to include that version\'s prereleases',
        )
      }
    }
  }
})

test('the range admits every version this build was actually validated on', () => {
  // Recorded by the generator, NOT read off the development machine — a golden
  // file that changes with the box is a golden file nobody can review. If the
  // floor or the lid moves past one of these, the claim in
  // docs/history/0.5.0-abi-cutover.md no longer matches the manifest.
  assert.ok(Array.isArray(golden.validatedOn) && golden.validatedOn.length > 0, 'golden.validatedOn is empty')
  for (const validated of golden.validatedOn) {
    assert.ok(
      golden.universe.includes(validated),
      `${validated} is recorded as validated but is not a published DSH version`,
    )
    for (const [name, range] of hostPeers(manifest)) {
      assert.ok(
        satisfies(validated, range),
        `${name} "${range}" rejects ${validated}, a runtime this plugin was validated on`,
      )
    }
  }
})

test('nothing outside the 0.x line sneaks in', () => {
  // The lid is `<0.3` for every host peer. A `1.0.0`/`0.3.0` must stay out, and
  // no range may be so open that it admits the next generation.
  for (const [name, range] of hostPeers(manifest)) {
    for (const version of ['0.3.0', '1.0.0']) {
      assert.ok(!satisfies(version, range), `${name} "${range}" now admits ${version} (next generation)`)
    }
  }
})

test('the comparator agrees with the semver the host actually uses', (t) => {
  // THE TEST THAT MAKES EVERY OTHER TEST IN THIS FILE WORTH ANYTHING.
  //
  // The comparisons above are only as good as `satisfies()` in
  // test/helpers/host-range.mjs, which is 40 lines of hand-written ordering.
  // If it disagrees with semver, the whole gate is measuring the wrong thing —
  // exactly the "the test was green because it tested its own copy" failure
  // this repo has been bitten by.
  //
  // So on any machine that HAS a semver copy (the DSH install ships one), every
  // (range, published version) pair is cross-checked against it with the host's
  // own options: `semver.satisfies(v, range, { includePrerelease: true })`.
  //
  // Skipped — not failed — when no semver is reachable: a bare checkout and CI
  // must both stay green, and this is a fidelity check on our own helper, not a
  // statement about the plugin. `t.diagnostic` says which branch ran so a green
  // run is not mistaken for "verified against semver" when it was not.
  const semver = loadHostSemver()
  if (!semver) {
    t.diagnostic('no semver reachable — comparator cross-check NOT run on this machine')
    return
  }
  const probes = [
    ...hostPeers(manifest).map(([, range]) => range),
    // The shapes that historically broke: a partial lid, a stable floor, and
    // the explicit `-0` floor the semver docs warn about.
    '<0.2',
    '>=0.1.5 <0.3',
    '>=0.2.0 <0.3',
    '>=0.1.7-rc.1 <0.3.0-0',
  ]
  let compared = 0
  for (const range of new Set(probes)) {
    for (const version of golden.universe) {
      const mine = satisfies(version, range)
      const theirs = semver.satisfies(version, range, { includePrerelease: true })
      assert.equal(mine, theirs, `satisfies(${version}, "${range}") — helper says ${mine}, semver ${semver.version ?? ''} says ${theirs}`)
      compared += 1
    }
  }
  t.diagnostic(`cross-checked ${compared} (range, version) pairs against semver ${semver.version}`)
})

/**
 * Find a semver copy to cross-check against, preferring the one the installed
 * DSH host judges ranges with. Returns null when none is reachable — the test
 * above then skips instead of failing.
 *
 * Resolution order is deliberate: the host's own copy first (that is the ground
 * truth), then anything resolvable from this package. The host path is the
 * global npm root, which differs per platform, so the global `dsh` install is
 * located by asking npm rather than by hard-coding a path.
 */
function loadHostSemver() {
  const candidates = []
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    candidates.push(`${root}/@deepseek-ai/dsh/node_modules/semver`)
  } catch {
    // No global npm, or no global dsh. Fall through to the local resolutions.
  }
  candidates.push('semver')
  for (const specifier of candidates) {
    try {
      const resolved = createRequire(`${REPO_ROOT}package.json`).resolve(specifier)
      const mod = createRequire(`${REPO_ROOT}package.json`)(specifier)
      if (typeof mod.satisfies !== 'function') continue
      return Object.assign(mod, { version: readFileSync(`${dirname(resolved)}/package.json`, 'utf8').match(/"version":\s*"([^"]+)"/)?.[1], resolved })
    } catch {
      continue
    }
  }
  return null
}
