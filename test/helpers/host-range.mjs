/**
 * Judge a peer range against a whole version universe, without a semver dep.
 *
 * WHY THIS IS A SEPARATE MODULE FROM THE TEST
 *
 * `node --test test/*.test.js` must run on a bare checkout with nothing
 * installed (README promises it, CI relies on it before any `npm install`).
 * So the comparator lives here, exports plain functions, and both the gate
 * (`test/host-range.test.mjs`) and the generator (`scripts/update-host-range.mjs`)
 * import it. One implementation, so the thing that WRITES the golden file and
 * the thing that CHECKS it can never disagree.
 *
 * WHAT IT REFUSES TO DO
 *
 * Only the dialect the manifests actually use is understood: one or more
 * `>=X.Y.Z[-pre]` / `<X.Y.Z[-pre]` comparators ANDed by whitespace. `^`, `~`,
 * `*`, `||`, x-ranges and hyphen ranges throw instead of guessing — a
 * comparator that quietly answers `true` for a range it cannot parse is
 * exactly how a fake gate gets built.
 *
 * THE ONE SUBTLETY THAT CARRIES THE WEIGHT
 *
 * A partial upper bound desugars with a `-0` floor: `semver.Range('<0.2').range`
 * is `<0.2.0-0`, which excludes every `0.2.0` pre-release. That is the whole
 * reason `>=0.1.5 <0.2` refused `0.2.0-rc.1`. Verified against semver 7.8.5 in
 * `test/host-range.test.mjs` ("the comparator agrees with the host's semver").
 */

/** Parse `X.Y.Z[-pre]`, or `X.Y` when `allowPartial` (partial is only legal below `<`). */
export function parseVersion(version, { allowPartial = false } = {}) {
  const pattern = allowPartial
    ? /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/
    : /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
  const match = pattern.exec(version)
  if (!match) throw new Error(`unparseable version: ${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? undefined : Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
    partial: match[3] === undefined,
  }
}

/** Semver 11.4 prerelease ordering: numeric identifiers rank below alphanumeric ones. */
function comparePrerelease(a, b) {
  const shared = Math.max(a.length, b.length)
  for (let i = 0; i < shared; i += 1) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    const numericA = /^\d+$/.test(a[i])
    const numericB = /^\d+$/.test(b[i])
    if (numericA !== numericB) return numericA ? -1 : 1
    if (numericA) {
      if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]) ? -1 : 1
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1
    }
  }
  return 0
}

/** Standard semver ordering, including "a stable version sorts above its prereleases". */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  return comparePrerelease(a.pre, b.pre)
}

/**
 * What `semver.satisfies(version, range, { includePrerelease: true })` answers
 * for the dialect described in this file's header. The host calls it with
 * exactly those options (dsh-app-boot/lib/index.js: `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`),
 * so a gate built on this function is judging with the host's semantics.
 */
export function satisfies(version, range) {
  const unsupported = ['^', '~', '*', '||', 'x', 'X'].filter((token) => range.includes(token))
  if (unsupported.length > 0) {
    throw new Error(`range uses syntax this helper refuses to guess at: ${range} (saw ${unsupported.join(', ')})`)
  }
  const comparators = range.trim().split(/\s+/).filter(Boolean)
  if (comparators.length === 0) throw new Error(`empty range: ${range}`)
  for (const comparator of comparators) {
    const match = /^(>=|<)(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)$/.exec(comparator)
    if (!match) throw new Error(`cannot parse comparator: ${comparator} (in ${range})`)
    const operator = match[1]
    let operand = match[2]
    const parsed = parseVersion(operand, { allowPartial: true })
    if (parsed.partial) {
      if (operator !== '<') throw new Error(`only < may carry a partial bound, got ${comparator} (in ${range})`)
      // `<X.Y` is `<X.Y.0-0`: the `-0` floor excludes X.Y.0's own prereleases.
      operand = `${operand}.0-0`
    }
    const order = compareVersions(version, operand)
    const held = operator === '>=' ? order >= 0 : order < 0
    if (!held) return false
  }
  return true
}

/** Split a universe into the versions a range admits and the ones it refuses. */
export function partition(versions, range) {
  const admitted = []
  const refused = []
  for (const version of versions) (satisfies(version, range) ? admitted : refused).push(version)
  return { admitted, refused }
}

/**
 * Sort a version list into ascending semver order. The registry already hands
 * back publish order, which is NOT version order (0.2.1-alpha.1 ships after
 * 0.2.0-rc.2), so anything comparing "newest admitted" needs this first.
 */
export function sortVersions(versions) {
  return [...versions].sort(compareVersions)
}

/** The `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers — the ones the host gates on. */
export function hostPeers(manifest) {
  return Object.entries(manifest.peerDependencies ?? {}).filter(
    ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
  )
}

/**
 * Compare this manifest's ranges against a recorded verdict set.
 *
 * The golden file records only `admitted` for each peer — `refused` is derived
 * as `universe - admitted`, because storing both invites them to disagree and
 * there is a separate self-consistency test for the derived partition.
 *
 * Returns a per-peer report instead of throwing, because the caller needs to
 * print WHICH version moved — "the range is wrong" is not actionable, "0.2.2-rc.1
 * is newly refused" is.
 */
export function diffAgainstGolden(manifest, golden) {
  const report = []
  for (const [name, range] of hostPeers(manifest)) {
    const expected = golden.peers?.[name]
    if (!expected) {
      report.push({ name, range, kind: 'unrecorded', newlyAdmitted: [], newlyRefused: [] })
      continue
    }
    if (expected.range !== range) {
      report.push({ name, range, previousRange: expected.range, kind: 'range-changed', newlyAdmitted: [], newlyRefused: [] })
      continue
    }
    const universe = golden.universe
    const { admitted, refused } = partition(universe, range)
    const recordedAdmitted = expected.admitted ?? []
    // `refused` was not stored; it is the complement of the recorded admitted list.
    const recordedRefused = universe.filter((version) => !recordedAdmitted.includes(version))
    const newlyAdmitted = admitted.filter((version) => !recordedAdmitted.includes(version))
    const newlyRefused = refused.filter((version) => !recordedRefused.includes(version))
    if (newlyAdmitted.length > 0 || newlyRefused.length > 0) {
      report.push({ name, range, kind: 'verdicts-moved', newlyAdmitted, newlyRefused })
    }
  }
  const declared = new Set(hostPeers(manifest).map(([name]) => name))
  for (const name of Object.keys(golden.peers ?? {})) {
    if (!declared.has(name)) report.push({ name, kind: 'dropped', newlyAdmitted: [], newlyRefused: [] })
  }
  return report
}

/** One-line human explanation for a single diff entry; used in assertion messages. */
export function explain(report) {
  const lines = []
  for (const entry of report) {
    if (entry.kind === 'verdicts-moved') {
      for (const version of entry.newlyAdmitted) {
        lines.push(`${entry.name} "${entry.range}" now ADMITS ${version} (was refused)`)
      }
      for (const version of entry.newlyRefused) {
        lines.push(`${entry.name} "${entry.range}" now REFUSES ${version} (was admitted)`)
      }
    } else if (entry.kind === 'range-changed') {
      lines.push(`${entry.name} range changed: "${entry.previousRange}" -> "${entry.range}"`)
    } else if (entry.kind === 'unrecorded') {
      lines.push(`${entry.name} "${entry.range}" has no recorded verdicts`)
    } else if (entry.kind === 'dropped') {
      lines.push(`${entry.name} is recorded in the golden file but no longer declared`)
    }
  }
  return lines.join('\n')
}
