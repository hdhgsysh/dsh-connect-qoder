/**
 * headers — 自 src/host/upstream.ts 原文搬迁，未改逻辑
 *
 * 拆分依据 docs/issues/22-upstream-split.md；本文件代码逐字来自拆分前的
 * upstream.ts（见 git 历史里拆分前的那一版），只做 import/export 整理与
 * 文件头标注。协议事实的原文注释在 crypto.ts 头部。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { QoderCredential, Region } from '../domain.ts'

/**
 * Headers the Qoder IDE itself sends to the OpenAPI host.
 *
 * `Cosy-ClientType: 10` identifies the desktop app. The quota and campaign
 * routes answer without it, but sending what the real client sends keeps this
 * from depending on a default the server may tighten later.
 *
 * The international campaigns endpoint additionally gates the daily
 * `CLAIM_BENEFIT` round on the request carrying the app's umid machine
 * identity (`Cosy-MachineToken/Code/Type`) — verified 2026-09-27 against the
 * live endpoint: a plain-bearer GET lists the evergreen `VIEW_DETAILS`
 * banner only, the same GET with the real umid block lists the daily round.
 * The block's values come from {@link umidHeadersFor}: the app's embedded
 * `runtime-info.exe` mints them, and the app's own `auth.machine-id` value is
 * NOT what the endpoint accepts (substituting it silently degrades the
 * list back to the banner). CN needs no umid block: its campaigns are
 * served complete to a plain-bearer GET.
 */
export function openApiHeaders(credential: QoderCredential, region: Region): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${credential.token}`,
    'Cosy-ClientType': '10',
    'User-Agent': 'Qoder',
    ...umidHeadersFor(region),
  }
}

/** The validated umid block, or `null` when the binary is absent or uncooperative. */
interface UmidBlock {
  machineToken: string
  machineCode: string
  machineType: string
}

/** One cached umid read per process: the binary is slow enough to matter, cheap enough to run once. */
let umidInfo: UmidBlock | null | undefined

/**
 * Test seam: a global function, when present, replaces the binary read
 * (`execFileSync` + `existsSync` + `JSON.parse`) and the per-process cache.
 * Production never sets it; the unit test sets it so every branch of the
 * umid path is reachable without a real install. The probe returns the
 * parsed block, `null`, `undefined`, a partial object, or throws — the
 * header builder must treat all of those as "no block" rather than crash.
 */

/**
 * The app's umid machine-identity header block, or `{}` when it cannot be
 * read. See {@link openApiHeaders} for why the block exists.
 *
 * The block is read from the install root, not the credential: the values
 * are machine-scoped, the same for both regions, and the CN region's
 * campaigns never needed them — but reading them when absent (CN-only
 * installs) must stay a no-op, never a failure.
 *
 * @param {object|undefined} region - the region descriptor.
 * @returns `{ 'Cosy-MachineToken', 'Cosy-MachineCode', 'Cosy-MachineType' }` or `{}`.
 */
/**
 * Test-only seam: reset the per-process umid cache so the next call to
 * `openApiHeaders` re-resolves. Production never calls this; the unit test
 * invokes it between cases because the cache lives in module scope.
 */
export function __dshQoderUmidCacheReset() {
  umidInfo = undefined
}

/**
 * Observability seam: whether the umid machine identity is available to this
 * process, forcing the same lazy per-process resolution `openApiHeaders`
 * performs when the read has not happened yet.
 *
 * The activation warn in `index.ts` uses it to name the one degradation the
 * international edition's check-in depends on — no machine identity, no daily
 * round — without waiting for the first OpenAPI call. The test seam
 * `__dshQoderUmidProbe` still stands in for the binary read, so the answer is
 * deterministic on any machine; the cache stays machine-scoped, region
 * independent, exactly like the header builder's.
 */
export function __dshQoderUmidState(): { available: boolean; reason?: string } {
  if (umidInfo === undefined) umidInfo = readUmidInfo(undefined)
  if (umidInfo !== null) return { available: true }
  return {
    available: false,
    reason:
      'the desktop app machine identity (umid) could not be read ' +
      '(no install, no matching version root, or a silent binary failure)',
  }
}

/**
 * The app's umid machine-identity header block, or `{}` when it cannot be
 * read. See {@link openApiHeaders} for why the block exists.
 *
 * The block is read from the install root, not the credential: the values
 * are machine-scoped, the same for both regions, and the CN region's
 * campaigns never needed them — but reading them when absent (CN-only
 * installs) must stay a no-op, never a failure.
 *
 * The resolution is cached per process in `umidInfo`; the test seam
 * `__dshQoderUmidProbe` and the reset hook `__dshQoderUmidCacheReset` let
 * the unit tests drive every branch without a real install.
 *
 * @param {object|undefined} region - the region descriptor.
 * @returns `{ 'Cosy-MachineToken', 'Cosy-MachineCode', 'Cosy-MachineType' }` or `{}`.
 */
function umidHeadersFor(region: Region): Record<string, string> {
  if (umidInfo === undefined) umidInfo = readUmidInfo(region)
  if (umidInfo === null) return {}
  return {
    'Cosy-MachineToken': umidInfo.machineToken,
    'Cosy-MachineCode': umidInfo.machineCode,
    'Cosy-MachineType': umidInfo.machineType,
  }
}

/**
 * Validate a candidate umid block; return `null` when any field is missing,
 * non-string, or empty. A partial block must not surface partially — the
 * header set is all-or-nothing.
 */
function normalizeUmidBlock(answer: unknown): UmidBlock | null {
  const block = answer as Partial<UmidBlock> | null | undefined
  if (typeof block?.machineToken !== 'string' || block.machineToken.length === 0) return null
  if (typeof block?.machineType !== 'string' || block.machineType.length === 0) return null
  if (typeof block?.machineCode !== 'string' || block.machineCode.length === 0) return null
  return { machineToken: block.machineToken, machineType: block.machineType, machineCode: block.machineCode }
}

/**
 * Run the app's umid binary and parse its `{ machineToken, machineType,
 * machineCode }` answer, or `null` when the binary is absent or uncooperative.
 *
 * The binary ships at `<install>/resources\umid\runtime-info.exe` — the
 * launcher's directory, one level above the versioned resources — and
 * answers with no arguments in well under a second. It is run with a 5 s
 * timeout and a pipe, never a shell: a hung or missing binary degrades to
 * "no machine identity", which on CN is the full answer anyway and on the
 * international edition costs only the daily check-in row.
 *
 * @param {object|undefined} region - the region descriptor; its `id` selects
 *   the install root.
 * @returns the parsed block or `null`.
 */
function readUmidInfo(region?: Region): UmidBlock | null {
  // The test seam stands in for the whole binary read: a probe that answers
  // `null` models "the binary is absent on this machine", which is the
  // production behaviour on a CN-only install or a CI runner.
  const probe = (globalThis as { __dshQoderUmidProbe?: () => unknown }).__dshQoderUmidProbe
  if (typeof probe === 'function') {
    try {
      return normalizeUmidBlock(probe())
    } catch {
      return null
    }
  }
  if (process.platform !== 'win32') return null
  const roots = umidRootsFor(region)
  for (const root of roots) {
    const binary = join(root, 'resources', 'umid', 'runtime-info.exe')
    if (!existsSync(binary)) continue
    let output
    try {
      output = execFileSync(binary, [], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    } catch {
      continue
    }
    try {
      // `normalizeUmidBlock` is the single all-or-nothing validator (cleanup #3
      // of docs/issues/22): the copy that used to live here accepted an empty
      // `machineType` / `machineCode`, which is a partial block surfacing
      // partially — the one thing the header set must never do.
      const block = normalizeUmidBlock(JSON.parse(output))
      if (block === null) continue
      return block
    } catch {
      continue
    }
  }
  return null
}

/**
 * Candidate install roots, newest layout first.
 *
 * The 0.4.x launcher splits each version into `Programs\Qoder\.qoder-versions\<v>\resources`,
 * leaving a thin launcher tree at `Programs\Qoder\resources` that carries
 * the shared `umid` binary; the CN app keeps its own `Programs\QoderCN` tree.
 *
 * The version directories are ENUMERATED rather than pinned: the old list
 * hard-coded `0.4.3` (the measured value of the day it was written), and a
 * pinned list stops matching the moment upstream ships the next desktop
 * version — which is exactly when the shared binary may have moved into the
 * new version root. Measured 2026-10-03, the `.qoder-versions` directory also
 * carries sibling MARKER FILES next to the version directories (`0.4.3.qoder-update-ready.json`
 * on this machine), so only directory entries become candidates. Enumeration
 * failing (no `.qoder-versions`, a locked directory) answers an empty list —
 * not a failure: the launcher-tree root below it remains the fallback, and
 * each candidate is still verified with `existsSync` before the binary runs.
 *
 * The CN tree is enumerated by the same rule by symmetry with the global one.
 * It is unmeasured here (no CN install on this machine); the no-op behaviour
 * when the directory is absent is what makes the symmetry safe.
 */
export function umidRootsFor(region?: Region): string[] {
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData === undefined) return []
  const programs = join(localAppData, 'Programs')
  const roots = [
    ...versionedUmidRoots(join(programs, 'Qoder')),
    join(programs, 'Qoder'),
  ]
  if (region?.id === 'qoder-cn') {
    roots.push(...versionedUmidRoots(join(programs, 'QoderCN')), join(programs, 'QoderCN'))
  }
  return roots
}

/**
 * The version-split install roots under one launcher tree, newest version first.
 *
 * Newest-first matters: when two version roots both carry the binary, the
 * newer one is the one the app runs against, and its umid values are the
 * current machine identity.
 */
function versionedUmidRoots(tree: string): string[] {
  let names: string[]
  try {
    names = readdirSync(join(tree, '.qoder-versions'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    // Absent or unreadable directory: no version-split candidates. The caller's
    // launcher-tree root is the fallback; this is not a failure worth naming.
    return []
  }
  // Newest first, numerically: `0.4.10` must beat `0.4.9`, and a
  // lexicographic sort is exactly the bug the enumeration exists to avoid.
  // A non-numeric part falls to the end, last among equals.
  names.sort((a, b) => versionCompare(b, a))
  return names.map((name) => join(tree, '.qoder-versions', name))
}

/** Compare two dot-separated version strings numerically per part. */
function versionCompare(a: string, b: string): number {
  const partsA = a.split('.')
  const partsB = b.split('.')
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const na = Number(partsA[i] ?? 0)
    const nb = Number(partsB[i] ?? 0)
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb
      continue
    }
    const ca = String(partsA[i] ?? '')
    const cb = String(partsB[i] ?? '')
    if (ca !== cb) return ca < cb ? -1 : 1
  }
  return 0
}
