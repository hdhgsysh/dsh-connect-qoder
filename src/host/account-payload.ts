/**
 * The payload behind the account panel's three routes.
 *
 * WHY THIS IS A MODULE AND NOT A CLOSURE IN lib/index.js
 *
 * It used to be a local arrow function there, and it stayed invisible to the
 * test suite for exactly as long as it stayed broken. `lib/index.js` imports the
 * Cordis peer packages, which this repository deliberately does not install, so
 * nothing in it can be imported by a test — and this payload called
 * `readAccountStateAsync` while the file's import line named only the
 * synchronous `readAccountState`. Every render of the account panel answered
 * `ReferenceError: readAccountStateAsync is not defined`, which escaped the
 * request handler into the host's catch-all and came back to the browser as a
 * bodyless 400 — the single line "读取账号状态失败" on an otherwise working
 * card, with nothing logged anywhere. The user saw it first. Nothing else
 * noticed: the model list, usage panel and generation were all fine because they
 * never touch this function.
 *
 * Moving it here puts the call where a test can execute it for real. The three
 * dependencies it needs are all peer-free already (`account-state`,
 * `credentials`, `preferences`), so this module has no Cordis contact at all —
 * same reasoning the README's table gives for every other extracted module.
 * `lib/index.js` now passes only what it uniquely owns: the regions and the
 * live settings snapshot.
 *
 * @module dsh-connect-qoder/account-payload
 */
import { readAccountStateAsync } from './account-state.ts'
import type { AccountRegion, AccountStateRecord } from './account-state.ts'
import type { DeviceCredentialStatus } from './device-credential.ts'
import { appDataRootFor } from './credentials.ts'
import type { CredentialKind } from './credential-kind.ts'
import { regionEnabledFor } from './preferences.ts'
import type { Preferences } from './preferences.ts'

/**
 * Build the account panel's answer for all regions: one record per region
 * (sign-in state plus `enabled`) and the whole `enabledRegions` map, which the
 * per-region switch posts back complete; both are read live, `force` reads for real.
 * @returns a promise of `{ regions, enabledRegions }`.
 */
export interface BuildAccountPayloadOptions {
  // The real types, not `any`. The comment that used to sit here said the
  // callers pass shapes "richer than any type this extracted module should
  // pin" — true when the caller was `lib/index.js`, which had no types at all.
  // Both callers are TypeScript now, and each one's type is already imported
  // here (the region descriptor by `account-state.ts`, the preferences
  // snapshot by `preferences.ts`), so pinning them costs nothing and makes
  // `region.id` / `enabledRegions` checked at the only call site.
  regions: AccountRegion[]
  settings: Preferences | undefined
  force?: boolean
  readAccountState?: (
    region: AccountRegion,
    appDataRoot: string,
    options?: { force?: boolean; cachedOnly?: boolean },
  ) => Promise<AccountStateRecord>
  appDataRoot?: string
  regionEnabled?: (preferences: Preferences | undefined, regionId: string) => boolean
  /**
   * What the panel should say about this region's device credential.
   *
   * Injected rather than imported so this module keeps naming only its
   * peer-free collaborators, and optional so a caller with no device sources
   * produces exactly the payload shape that existed before they did — the
   * field is added, never `undefined`-valued, because the card distinguishes
   * "absent" from "reported as none" and a `device: undefined` key would make
   * every existing shape assertion in the suite fail for no reason.
   */
  deviceStatus?: (regionId: string) => DeviceCredentialStatus
  /**
   * Which credential path is serving this region, when the host knows.
   *
   * Injected for the same reason as `deviceStatus`, and optional for the same
   * reason: a caller with no resolved credential produces exactly the payload
   * shape that existed before, and the key is added only when there is a kind
   * to report. `undefined` means "not resolved yet", not "no credential" — the
   * card falls back to what it can infer when the key is absent.
   */
  credentialKind?: (regionId: string) => CredentialKind | undefined
}

export async function buildAccountPayload({
  regions,
  settings,
  force = false,
  readAccountState = readAccountStateAsync,
  appDataRoot = appDataRootFor(),
  regionEnabled = regionEnabledFor,
  deviceStatus,
  credentialKind,
}: BuildAccountPayloadOptions = {} as BuildAccountPayloadOptions) {
  const enabledRegions = Object.fromEntries(
    regions.map((region) => [region.id, regionEnabled(settings, region.id)]),
  )
  // One mode object for every region: the panel's answer must be consistent
  // about HOW it was read, the same way it is consistent about what it read.
  const mode = force === true ? { force: true } : { cachedOnly: true }
  const states = await Promise.all(
    regions.map(async (region) => {
      const kind = credentialKind?.(region.id)
      return {
        ...(await readAccountState(region, appDataRoot, mode)),
        enabled: enabledRegions[region.id],
        // The plugin's own credential is reported alongside the application's
        // sign-in, not merged into it: they are two credentials with two
        // lifetimes, and a region can be `signed-out` of the app while the
        // plugin's own token is perfectly good.
        ...(deviceStatus === undefined ? {} : { device: deviceStatus(region.id) }),
        // Which path is actually serving this region. Absent when nothing has
        // been resolved yet — the card then falls back to what it can infer.
        ...(kind === undefined ? {} : { credentialKind: kind }),
      }
    }),
  )
  return { regions: states, enabledRegions }
}
