/**
 * fetch-usage — the account's usage and campaign snapshot.
 *
 * Moved verbatim from `src/host/upstream.ts` when the protocol was split
 * (docs/issues/22-upstream-split.md); only imports and exports were tidied. The
 * protocol facts' original notes live at the head of `upstream/crypto.ts`.
 *
 * One deliberate behaviour change: `fetchUsage` used to swallow a failed
 * campaigns read (AGENTS.md red line 1); the failure now lands in the snapshot's
 * `campaignsError` field and the card renders it, so a vanished promo row is
 * distinguishable from a day with no campaign.
 */

import { openApiHeaders } from './headers.ts'
import { usageUrl, usagePresentationUrl } from './endpoints.ts'
import { readJson, readCampaigns } from './api-calls.ts'
import { windowIsOpen } from '../offpeak.ts'
import { toEpochMs } from '../time.ts'
import { checkinStateFrom } from '../claim.ts'
import { describeThrown, isProtocolShapeChangedError, ProtocolShapeChangedError, UpstreamRefusalError } from '../errors.ts'
import type { QoderCredential, Region } from '../domain.ts'

/** One quota bucket as the usage panel renders it. */
interface QuotaBucket {
  total: number
  used: number
  remaining: number
  percentage: number
  unit?: string
}

/**
 * The `used` / `remaining` / `percentage` / `unit` four-tuple, from a raw bucket.
 *
 * Shared by {@link normalizeQuotaBucket} and {@link normalizeDedicatedPackage}
 * because the two used to carry this block verbatim — the same guess about
 * percentages, the same clamp, the same default unit — and a heuristic that
 * exists twice is a heuristic that can be corrected once. That is not
 * hypothetical here: this plugin has already been bitten by two copies of a
 * time comparison drifting apart, and the fix then was to merge them into one
 * function (`time.ts`). Same shape, same fix.
 *
 * The `> 1 means percent` rule is a GUESS about an undeclared upstream field.
 * It is kept as-is (it is what the IDE panel agrees with) but it is stated in
 * one place now, so if the upstream ever starts sending `0.5` to mean 50% there
 * is one line to change and one comment to correct.
 *
 * @param source - the raw bucket or package object.
 * @param total - the already-validated total (> 0), used for the fallbacks.
 * @returns the four display fields.
 */
function quotaAmountsOf(source: Record<string, unknown>, total: number): {
  used: number
  remaining: number
  percentage: number
  unit: string
} {
  const used = Number(source.used)
  const safeUsed = Number.isFinite(used) ? Math.max(0, used) : 0
  const remainingRaw = Number(source.remaining)
  const remaining = Number.isFinite(remainingRaw) ? Math.max(0, remainingRaw) : Math.max(0, total - safeUsed)
  const percentageRaw = Number(source.percentage)
  const percentage = Number.isFinite(percentageRaw)
    ? percentageRaw > 1
      ? percentageRaw / 100
      : percentageRaw
    : safeUsed / total
  return {
    used: safeUsed,
    remaining,
    percentage: Math.min(1, Math.max(0, percentage)),
    unit: typeof source.unit === 'string' && source.unit.length > 0 ? source.unit : 'credits',
  }
}

/** Coerce one quota bucket into `{ total, used, remaining, percentage, unit }`. */
function normalizeQuotaBucket(value: unknown): QuotaBucket | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const bucket = value as Record<string, unknown>
  const total = Number(bucket.total)
  if (!Number.isFinite(total) || total <= 0) return undefined
  return { total, ...quotaAmountsOf(bucket, total) }
}

/**
 * Normalize one dedicated (per-model) resource package.
 *
 * These are the promotional allowances the IDE panel shows as e.g.
 * "Qwen3.8-Max 免费额度 1402 / 2000 次" — a package bound to a set of models
 * rather than to the account as a whole. Packages that declare no usable total
 * are dropped, matching the client's own filtering.
 */
/** One dedicated (per-model) resource package, as the IDE panel renders it. */
interface DedicatedPackage {
  id: string
  name: string
  description: string
  total: number
  used: number
  remaining: number
  percentage: number
  unit: string
  expiresAt?: number
  /**
   * Whether the package may still be used. Carried from the upstream rather
   * than recomputed: an allowance the gateway has already switched off is not
   * the same as one whose quota is spent, and the panel renders them
   * differently.
   */
  available: boolean
}

function normalizeDedicatedPackage(value: unknown): DedicatedPackage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const pkg = value as Record<string, unknown>
  const id = typeof pkg.id === 'string' ? pkg.id.trim() : ''
  const total = Number(pkg.total)
  if (id === '' || !Number.isFinite(total) || total <= 0) return undefined
  const expiresAt = toEpochMs(pkg.expiresAt)
  return {
    id,
    name: typeof pkg.name === 'string' ? pkg.name : '',
    description: typeof pkg.description === 'string' ? pkg.description : '',
    total,
    // The same four fields `normalizeQuotaBucket` produces, from the same
    // helper — these two had already been copied once, and the percentage
    // heuristic in particular is a guess that must not diverge between them.
    ...quotaAmountsOf(pkg, total),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    available: pkg.available !== false,
  }
}

/**
 * The fields whose presence proves the body is still a usage document.
 *
 * Both spellings of each key are accepted: the plain route answers snake_case,
 * the presentation route has been seen with camelCase, and the panel has always
 * read either. This is a triage list, not a schema — a field the upstream adds
 * is invisible here and must stay that way; what it rules out is the OTHER
 * reading, a body that parsed as JSON but is no longer about usage at all.
 */
const USAGE_FIELDS: readonly string[] = [
  'user_quota',
  'userQuota',
  'add_on_quota',
  'addOnQuota',
  'dedicated_resource_packages',
  'dedicatedResourcePackages',
  'is_quota_exceeded',
  'isQuotaExceeded',
  'user_type',
  'userType',
  'expires_at',
  'expiresAt',
  'upgrade_url',
  'upgradeUrl',
  'display_mode',
  'displayMode',
]

/**
 * Narrow a usage payload to the record the snapshot fields are read from.
 *
 * The two routes answer the same body differently — `usagePresentationUrl`
 * wraps it under `qoderUsage`, `usageUrl` returns it directly — so the unwrap
 * has to happen somewhere. It used to happen by assumption: `qoderUsage ??
 * data ?? payload`, then one `typeof === 'object'` test, and anything else
 * became `undefined`, which the card rendered as "usage unavailable". After the
 * clone's private protocol changes (it has no version negotiation) a renamed
 * envelope therefore read as an account with nothing to show, and nothing told
 * the user the plugin needs updating. That is the silent-failure shape red line
 * 1 forbids, and the same triage the model list and chat already report.
 *
 * Three deliberate non-drift cases, because a false "update the plugin" is its
 * own incident:
 *
 * - an empty object stays "no data" — it carries no evidence either way;
 * - unknown fields alongside a known one are fine — the upstream may add;
 * - the `usage` body is read from `qoderUsage` OR `data` OR the top level, so
 *   either route's layout is accepted.
 *
 * @param payload - the parsed 200 body.
 * @returns the envelope (for `displayMode`) and the usage record.
 * @throws {ProtocolShapeChangedError} when the body is not a usage document.
 */
export function readUsageShape(payload: unknown): {
  envelope: Record<string, unknown>
  record: Record<string, unknown>
} {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolShapeChangedError(
      `top level is ${payload === null ? 'null' : Array.isArray(payload) ? 'an array' : typeof payload}, not a usage envelope`,
    )
  }
  const envelope = payload as Record<string, unknown>
  const usage = envelope.qoderUsage ?? envelope.data ?? payload
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new ProtocolShapeChangedError(
      `usage body is ${usage === null ? 'null' : Array.isArray(usage) ? 'an array' : typeof usage}, not an object`,
    )
  }
  const record = usage as Record<string, unknown>
  const keys = Object.keys(record)
  // Nothing to misread: "no usage" stays the honest empty answer.
  if (keys.length === 0) return { envelope, record }
  if (!keys.some((key) => USAGE_FIELDS.includes(key))) {
    throw new ProtocolShapeChangedError(`no known usage field; keys present: ${keys.slice(0, 12).join(', ')}`)
  }
  return { envelope, record }
}

/**
 * The account's usage, shaped the way the IDE's panel presents it.
 *
 * Fields the plugin does not itself merge into a card are typed `unknown`
 * rather than dropped: the payload is handed to the client card largely as-is,
 * so a closed interface here would mean a field the upstream adds is silently
 * invisible to the type. What IS declared are the keys the host reads before
 * spreading — `displayMode`, `isQuotaExceeded`, the quota halves — because
 * those are the ones a typo would turn into a missing panel row.
 */
export interface UsageSnapshot {
  displayMode?: unknown
  userType?: unknown
  expiresAt?: number
  upgradeUrl?: unknown
  userQuota?: QuotaBucket
  addOnQuota?: QuotaBucket
  dedicatedPackages?: DedicatedPackage[]
  campaigns?: Array<{ key: string; title: string; description: string; detailUrl: string; endsAt?: number }>
  /**
   * Why the campaigns half of this read is missing, when it failed.
   *
   * Campaigns are supplementary, so a failure must not cost the user their
   * quota numbers — but it must not be silent either (red line 1). The reason
   * travels with the snapshot and the card renders it, exactly as the
   * machine-identity hint travels with the usage response. It is per-region
   * because the failure is: one edition's campaigns endpoint can be down while
   * the other's answers normally.
   */
  campaignsError?: string
  /**
   * Whether the campaigns read failed specifically as a protocol-shape change.
   *
   * The card cannot tell a transport failure ("the offers endpoint is down")
   * from the upstream having renamed its envelope — but the remedy differs:
   * one heals on its own, the other needs a plugin update. The flag says which
   * one this is; `campaignsError` still carries the host's own words.
   */
  campaignsShapeChanged?: boolean
  checkin?: unknown
  isQuotaExceeded?: boolean
  source?: string
  [field: string]: unknown
}

/**
 * Project the campaigns payload onto the rows the usage panel renders.
 *
 * @param {unknown} payload - the raw campaigns document.
 * @returns `[{ key, title, description, detailUrl, endsAt }]`.
 */
export function projectCampaignRows(payload: unknown): Array<{
  key: string
  title: string
  description: string
  detailUrl: string
  endsAt?: number
}> {
  const list = Array.isArray((payload as { campaigns?: unknown } | null | undefined)?.campaigns)
    ? (payload as { campaigns: unknown[] }).campaigns
    : []
  const rows: Array<{ key: string; title: string; description: string; detailUrl: string; endsAt?: number }> = []
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue
    const campaign = raw as {
      placements?: unknown
      endAt?: unknown
      campaignKey?: unknown
      campaignId?: unknown
    }
    const placements = Array.isArray(campaign.placements) ? campaign.placements : []
    const usage = placements.find(
      (entry) => (entry as { type?: unknown } | null | undefined)?.type === 'USAGE',
    ) as { content?: Record<string, unknown> } | undefined
    if (usage === undefined) continue
    // The panel is bilingual; prefer the Simplified Chinese copy to match the
    // rest of this card, and fall back to English when only that exists.
    const content = (usage.content?.zh ?? usage.content?.['zh-CN'] ?? usage.content?.en ?? {}) as Record<string, unknown>
    const endsAt = toEpochMs(campaign.endAt)
    rows.push({
      key: String(campaign.campaignKey ?? campaign.campaignId ?? ''),
      title: typeof content.title === 'string' ? content.title : '',
      description: typeof content.description === 'string' ? content.description : '',
      detailUrl: typeof content.detailUrl === 'string' ? content.detailUrl : '',
      ...(endsAt !== undefined ? { endsAt } : {}),
    })
  }
  return rows
}

/**
 * Normalize one model's time-of-day discount.
 *
 * Qoder discounts some models during an off-peak window (the catalog's own copy
 * reads "错峰 4 折" — 22:00 to 08:00, Asia/Shanghai). The block carries the
 * window, the discounted multiplier, and the multiplier that applies outside it,
 * so the effective rate depends on **when** the model is used, not just on the
 * catalog entry.
 *
 * The upstream `active` field is a moment-in-time answer — "is the discount
 * applying right now" — NOT a campaign switch. Measured live at 14:02 UTC+8:
 * all three discounted models reported `active:false` while still carrying
 * their badges, descriptions and 22:00–08:00 windows; the window was simply
 * closed. Read verbatim as a campaign switch it silenced the entire off-peak
 * UI for the whole day — no card badge, no countdown, no discounted-rate hint,
 * exactly the "does the discount only exist after 22:00?" confusion it is
 * normalized away here. So a `false` is only honored as a kill when the window
 * was OPEN at the moment the server told us it (the one reading that can only
 * mean switched off); a `false` fetched outside the window is uninformative
 * and the campaign stands. Every consumer keeps treating the normalized
 * `active:false` as the kill signal it always meant.
 *
 * @param value - the raw upstream promotion block.
 * @param now - the fetch instant the moment-in-time flag was observed at.
 * @returns `{ active, windowStart, windowEnd, timezone, discountFactor,
 *   beforePromotionPriceFactor, badge, description }`, or `undefined` when the
 *   model carries no promotion.
 */
export function normalizePromotion(value: unknown, now: Date = new Date()) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const promotion = value as Record<string, unknown>
  const discountFactor = Number(promotion.discount_factor)
  const before = Number(promotion.before_promotion_price_factor)
  const windowStart = typeof promotion.window_start === 'string' ? promotion.window_start : ''
  const windowEnd = typeof promotion.window_end === 'string' ? promotion.window_end : ''
  const hasWindow = /^\d{2}:\d{2}$/.test(windowStart) && /^\d{2}:\d{2}$/.test(windowEnd)
  if (!Number.isFinite(discountFactor) && !Number.isFinite(before) && !hasWindow) return undefined
  const timezone =
    typeof promotion.timezone === 'string' && promotion.timezone.length > 0
      ? promotion.timezone
      : 'Asia/Shanghai'
  // The catalog is bilingual; prefer the Simplified Chinese copy to match the
  // rest of the card, falling back to English when only that is present.
  const pick = (field: string): string => {
    const source = promotion[field] as Record<string, unknown> | null | undefined
    if (source === null || typeof source !== 'object') return ''
    const text = source.zh ?? source['zh-CN'] ?? source.en
    return typeof text === 'string' ? text : ''
  }
  // `true` is on at any hour; `false` is re-read against the window above; an
  // absent or non-boolean flag keeps the old strict read (off) — there is
  // nothing here to reinterpret, and guessing campaigns into existence is
  // worse than staying quiet. Without a parseable window there is no clock to
  // re-read against either, so those falses also stand as reported.
  const active = promotion.active === true
    || (promotion.active === false && hasWindow && !windowIsOpen(windowStart, windowEnd, timezone, now))
  return {
    active,
    windowStart: hasWindow ? windowStart : '',
    windowEnd: hasWindow ? windowEnd : '',
    timezone,
    ...(Number.isFinite(discountFactor) ? { discountFactor } : {}),
    ...(Number.isFinite(before) ? { beforePromotionPriceFactor: before } : {}),
    badge: pick('badge'),
    description: pick('description'),
  }
}

/**
 * Read the account's usage, shaped the way the IDE's panel presents it.
 *
 * Two routes are tried because they carry different halves of the picture: the
 * `sash` presentation route includes the per-model dedicated packages, while
 * `quota/usage` is the older, narrower shape. Either alone is enough to render
 * something useful, so a failure of the first falls back to the second rather
 * than failing the whole read.
 *
 * @returns `{ displayMode, userType, expiresAt, upgradeUrl, userQuota, addOnQuota,
 *   dedicatedPackages, campaigns, checkin, isQuotaExceeded, source }`, or
 *   `undefined` when neither route answered. `campaignsError` is present only
 *   when the supplementary campaigns read failed.
 */
export async function fetchUsage(
  region: Region,
  credential: QoderCredential,
  signal?: AbortSignal,
): Promise<UsageSnapshot | undefined> {
  const headers = openApiHeaders(credential, region)

  const read = async (url: string): Promise<unknown> => {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
    })
    // The body is read for its verdict, not for this reader's message: the
    // message has always been the bare status, and what the card needs is the
    // flag (`unavailableReason`, and a spent allowance marking the local
    // exhausted badge). Both spellings of the usage route answer the same way,
    // so the presentation→quota fallback below re-throws a verdict it cannot
    // fix. See docs/issues/24.
    if (!response.ok) {
      throw new UpstreamRefusalError(
        `HTTP ${response.status}`,
        response.status,
        (await response.text()).slice(0, 300),
        response.headers.get('retry-after'),
      )
    }
    return readJson(response, 'Qoder usage')
  }

  let payload: unknown
  let source = 'presentation'
  try {
    payload = await read(usagePresentationUrl(region))
  } catch (error) {
    if (signal?.aborted) throw error
    source = 'quota'
    payload = await read(usageUrl(region))
  }

  // The presentation route wraps the same body under `qoderUsage`; the plain
  // route returns it directly. Both spellings of each field are accepted.
  //
  // The unwrap is TRIAGED rather than assumed: a body that is not a usage
  // document any more (a bare string, an array, a renamed envelope) throws
  // `ProtocolShapeChangedError`, which the usage route names in its answer so
  // the card can say "the plugin needs updating" instead of "no usage". An
  // empty object carries no evidence and still answers "no usage".
  const { envelope, record } = readUsageShape(payload)

  const userQuota = normalizeQuotaBucket(record.user_quota ?? record.userQuota)
  const addOnQuota = normalizeQuotaBucket(record.add_on_quota ?? record.addOnQuota)
  const rawPackages = record.dedicated_resource_packages ?? record.dedicatedResourcePackages
  const dedicatedPackages = Array.isArray(rawPackages)
    ? rawPackages.map(normalizeDedicatedPackage).filter((entry) => entry !== undefined)
    : []

  // Campaigns are supplementary: the panel is still useful without them, so a
  // failure here must not cost the user their quota numbers. The same payload
  // answers whether there is a daily check-in to claim, so both are read from
  // this one round trip rather than two that could disagree.
  //
  // "Supplementary" is not "silent". The original code let the failure fall on
  // the floor, which made "the campaigns endpoint is down / the machine
  // identity was refused" indistinguishable from "this account has no offers
  // and no check-in today" — the exact failure shape AGENTS.md red line 1
  // forbids and the shape this plugin's incident history is made of. So the
  // reason is kept and returned; the quota fields are still built normally.
  let campaigns: ReturnType<typeof projectCampaignRows> = []
  let checkin: ReturnType<typeof checkinStateFrom> | undefined
  let campaignsError: string | undefined
  let campaignsShapeChanged = false
  try {
    const raw = await readCampaigns(region, credential, signal)
    campaigns = projectCampaignRows(raw)
    checkin = checkinStateFrom(raw)
  } catch (error) {
    // An abort is not a campaigns failure: the caller withdrew the read, and
    // reporting a cancellation as "campaigns are broken" would be a lie that
    // outlives the request.
    if (signal?.aborted) throw error
    campaignsError = describeThrown(error)
    // A shape change is a different remedy from a transport failure, so it is
    // flagged rather than left for the card to infer from the message text.
    campaignsShapeChanged = isProtocolShapeChangedError(error)
  }

  const expiresAt = toEpochMs(record.expires_at ?? record.expiresAt)
  const isQuotaExceeded = record.is_quota_exceeded ?? record.isQuotaExceeded

  // Nothing usable at all is reported as "no data" so the card can say so
  // instead of rendering an empty panel.
  if (userQuota === undefined && addOnQuota === undefined && dedicatedPackages.length === 0) return undefined

  return {
    displayMode: typeof envelope.displayMode === 'string' ? envelope.displayMode : 'qoder',
    userType: String(record.user_type ?? record.userType ?? ''),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    upgradeUrl: String(record.upgrade_url ?? record.upgradeUrl ?? ''),
    ...(userQuota !== undefined ? { userQuota } : {}),
    ...(addOnQuota !== undefined ? { addOnQuota } : {}),
    dedicatedPackages,
    campaigns,
    ...(campaignsError !== undefined ? { campaignsError } : {}),
    ...(campaignsShapeChanged ? { campaignsShapeChanged: true } : {}),
    ...(checkin !== undefined ? { checkin } : {}),
    isQuotaExceeded: isQuotaExceeded === true,
    source,
  }
}
