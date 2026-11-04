/**
 * endpoints — 自 src/host/upstream.ts 原文搬迁，未改逻辑
 *
 * 拆分依据 docs/issues/22-upstream-split.md；本文件代码逐字来自拆分前的
 * upstream.ts（见 git 历史里拆分前的那一版），只做 import/export 整理与
 * 文件头标注。协议事实的原文注释在 crypto.ts 头部。
 */

import type { Region } from '../domain.ts'

/** URL listing the models this account may use. */
export function modelListUrl(region: Region): string {
  return `${region.baseUrl}algo/api/v2/model/list?Encode=1`
}

/** URL of the streaming chat endpoint. */
export function chatUrl(region: Region): string {
  return `${region.baseUrl}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
}

/** URL exchanging a personal access token for a job token. */
export function exchangeUrl(region: Region): string {
  return `${region.openApiUrl}/api/v1/jobToken/exchange`
}

/** URL returning the signed-in account's profile. */
export function userInfoUrl(region: Region): string {
  return `${region.openApiUrl}/api/v1/userinfo`
}

/** URL returning the account's quota usage. */
export function usageUrl(region: Region): string {
  return `${region.openApiUrl}/api/v2/quota/usage`
}

/**
 * URL the Qoder IDE's own "我的用量" panel reads.
 *
 * The `sash` route is the presentation layer: it answers with a `displayMode`
 * wrapper and carries `dedicatedResourcePackages`, the per-model promotional
 * allowances the panel lists beside the plan and add-on quotas. The plain
 * `quota/usage` route returns only the plan and add-on halves, so this is the
 * one to prefer and the other is the fallback.
 */
export function usagePresentationUrl(region: Region): string {
  return `${region.openApiUrl}/sash/api/v2/me/usage`
}

/**
 * URL listing the account's active campaigns.
 *
 * The IDE's usage panel renders a campaign's `USAGE` placement as the extra
 * promotional row under the quotas — the one carrying a "限时特惠" badge and an
 * end date. The quota routes do not carry that text, so it is read separately
 * and merged in.
 */
export function campaignsUrl(region: Region): string {
  return `${region.openApiUrl}/sash/api/v1/me/campaigns`
}

/**
 * URL that claims one campaign's benefit.
 *
 * The OpenAPI host, not the gateway: this side authenticates with the plain
 * bearer token and needs none of the COSY signing or body encoding the model
 * routes require.
 *
 * The id belongs to a round that is live now, which is why the caller reads the
 * campaign list immediately before claiming: the daily round is re-issued with
 * a new id each day, so an id remembered from an earlier read is a stale one.
 */
export function claimCampaignUrl(region: Region, campaignId: string): string {
  return `${region.openApiUrl}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`
}
