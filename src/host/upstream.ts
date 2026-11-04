/**
 * The Qoder wire protocol — facade.
 *
 * The protocol was split into 11 leaf modules under `upstream/`
 * (docs/issues/22-upstream-split.md); this facade re-exports the current names
 * one by one, so dropping an export has to be stated here explicitly (TypeScript
 * errors on the spot) rather than slipping through `export *`.
 *
 * The protocol facts' original notes (COSY signature header, permuted-alphabet
 * base64, two-layer SSE) moved with the code to `upstream/crypto.ts`.
 * @module dsh-connect-qoder/upstream
 */

export { MACHINE_OS } from './upstream/client-constants.ts'
export { CUSTOM_ALPHABET, STD_ALPHABET, encodeBody } from './upstream/crypto.ts'
export { signaturePath } from './upstream/sign.ts'
export { authHeaders } from './upstream/cosy-sign.ts'
export { openApiHeaders, __dshQoderUmidCacheReset, __dshQoderUmidState, umidRootsFor } from './upstream/headers.ts'
export { modelListUrl, chatUrl, exchangeUrl, userInfoUrl, usageUrl, usagePresentationUrl, campaignsUrl, claimCampaignUrl } from './upstream/endpoints.ts'
export { QUEUE_WAIT_BUDGET_MS, QUEUE_WAIT_MAX_SLEEP_MS, QUEUE_WAIT_MIN_SLEEP_MS, queueWaitFor } from './upstream/retry.ts'
export { streamChat } from './upstream/sse.ts'
export { toQoderMessages, toQoderTools } from './upstream/messages.ts'
export { projectCampaignRows, normalizePromotion, fetchUsage } from './upstream/fetch-usage.ts'
export type { UsageSnapshot } from './upstream/fetch-usage.ts'
export { readCampaigns, claimCampaign, readModelCatalogShape, fetchModels, exchangePat, fetchUserInfo } from './upstream/api-calls.ts'
