# 上游层拆分：2,335 行的 upstream.ts 拆成 11 个叶模块 + 26 行门面

**P2 · 规模 L · 依赖 — · ✅ 已落地（2026-10-17）**

2026-10-17 深挖结论：upstream.ts 是三个单文件巨石（upstream.ts 2,335 /
credentials.ts 1,579 / index.ts 1,544）中拆分收益最高、路径最清晰的一个。
本文既是问题记录也是拆分蓝图；**下方「落地结果」记录了实际形态与蓝图的三处
偏差**，蓝图段落保留原文以便对照。

## 背景

`src/host/upstream.ts` 现在 2,335 行，混装六类职责：COSY 签名、置换字母表 base64、
SSE 双层解码、fetch 封装、重试与队列预算、以及各 API 调用（登录/目录/用量/签到/账号）。
任何一处协议变化都要在这个文件里改；test/ 下 12 个测试文件 import 它，另有 5 个 probe、
3 个 src 内 importer——动导出面等于 20 个文件跟着动，所以此前一直没人动它。

## 落地结果（2026-10-17）

门面 `src/host/upstream.ts` 25 行（含文件头注释），11 个叶模块在 `src/host/upstream/`，
代码逐字搬迁自拆分前的 `upstream.ts`（用脚本按顶层声明切分，`git show HEAD:` 取冻结
原件，切完做了「按锚点重组 = 原文逐字节相等」的自检）：

| 叶模块 | 行数 | 内容 |
|---|---|---|
| `sse.ts` | 667 | 双层包裹 SSE 解码 + `streamChat` 重试循环 + 队列/限流拒绝类 |
| `api-calls.ts` | 381 | `readJson` / `readCampaigns` / `claimCampaign` / `fetchModels` / `readModelCatalogShape` / `exchangePat` / `fetchUserInfo` |
| `fetch-usage.ts` | 369 | `fetchUsage` / `UsageSnapshot` / 配额与资源包归一 / `normalizePromotion` |
| `headers.ts` | 261 | `openApiHeaders` + umid 机器身份（Windows `runtime-info.exe` 定位与版本根枚举） |
| `messages.ts` | 226 | `toQoderMessages` / `toQoderTools`（OpenAI 消息与工具 → Qoder 形状） |
| `retry.ts` | 109 | 重试策略、`ATTEMPT_TIMEOUT_MS`、`QUEUE_WAIT_*`、`queueWaitFor`、`sleep` |
| `crypto.ts` | 104 | RSA 公钥、`aesEncryptCBCBase64`、置换字母表 `encodeBody`；**协议事实原文注释在此文件头** |
| `cosy-sign.ts` | 93 | `authHeaders`：签名 info 块、RSA 包 AES key、MD5 over payload/key/ts/body/path |
| `endpoints.ts` | 65 | 各 API 端点 URL 构造（含 `claimCampaignUrl`） |
| `client-constants.ts` | 45 | `COSY_VERSION` / `CLIENT_TYPE` / `MACHINE_TYPE` / `DATA_POLICY` / `LOGIN_VERSION` / `MACHINE_OS` |
| `sign.ts` | 16 | `signaturePath` |

叶模块总行数 2,336 = 拆分前 `upstream.ts` 的行数（注释与代码整体搬迁，无删减）。

拆分前的原件可随时取回对照：`git show 7cda24d:src/host/upstream.ts > /tmp/upstream.orig.ts`
（`7cda24d` 是拆分前最后一版；拆分脚本用「按顶层声明切分后重组 = 原文逐字节相等」
自检过，所以这个对照是可信的）。

### 与蓝图的三处偏差

1. **叶数 11 → 11，但名单不同**：蓝图把「双层 SSE 解码」单列 `sse.ts`、把各调用
   编排单列 `api-calls.ts`，但没有给 umid 机器身份、失败帧辅助函数、消息转换留位置。
   实际落地把蓝图 11 名全部保留，另立 `headers.ts`（umid 并入其中，与 `openApiHeaders`
   同属「请求头组装」）、`messages.ts`（消息/工具转换）、`sse.ts` 内收失败帧辅助。
   蓝图里 `cosy-sign.ts` 与 `sign.ts` 的缝（签名 info 块 vs MD5/RSA 组装）按「谁被谁
   调用」切开：`sign.ts` 只剩 `signaturePath`（纯 URL 处理），`cosy-sign.ts` 拿全部
   加密与组装。
2. **`fetch-campaigns.ts` 不存在**：蓝图预期「整个文件删除」，但 `readCampaigns` /
   `projectCampaignRows` / `claimCampaign` 是活导出（`handlers.ts` 的签到路径在用），
   不能随死导出 `fetchCampaigns` 一起删。三个函数归入 `api-calls.ts` 与
   `fetch-usage.ts`，死导出 `fetchCampaigns` 按 #1 单独删除。
3. **门面 26 行而非 ~50 行**：逐名 re-export 后 12 行导出语句足够；用
   `export type { UsageSnapshot }` 单列类型（Node 的类型剥离需要类型导出与值导出分开）。

## 顺带整改清单（拆分时逐条核销）

| # | 问题 | 证据 | 处置 |
|---|---|---|---|
| 1 | `fetchCampaigns` 是死导出，无任何调用方 | upstream.ts:765 | 拆分时直接删除（先 grep 全仓确认仍为 0 调用） |
| 2 | Retry-After 解析器重复实现两份 | upstream.ts:1774-1787 vs errors.ts `parseRetryAfterSeconds` | 保留 errors.ts 版本，upstream.ts 改 import |
| 3 | `readUmidInfo` 重新实现了 `normalizeUmidBlock` 的逻辑 | 拆分时以 errors/normalize 实测为准 | 收敛到一份，另一处改 import |
| 4 | `fetchUsage` 吞错：catch 后只置 flag，无日志 | upstream.ts:1028-1030 | 违红线 1（静默失败）；拆分时改为可见错误或显式降级 |

## 拆分蓝图（11 叶 + ~50 行门面）

按现有内部结构切；新模块**整体搬迁**代码，不改逻辑；upstream.ts 保留为 ~50 行门面
（re-export 全部现名导出），则 20 个下游文件一行不动。

| 新叶模块（upstream/ 下） | 内容 |
|---|---|
| `crypto.ts` | `aesEncryptCBCBase64`（upstream.ts:247）、RSA 包 AES key（:287）、置换字母表 base64 Encode=1（:1-92 一带） |
| `cosy-sign.ts` | COSY 签名头组装（MD5 over base64 payload + ts + body + sigpath） |
| `sse.ts` | 双层包裹 SSE 解码 |
| `client-constants.ts` | CLIENT_TYPE '5'、DATA_POLICY 'disagree'、UA 等协议常量 |
| `retry.ts` | 重试策略、QUEUE_WAIT_BUDGET_MS=120000（含 rationale 注释） |
| `fetch-usage.ts` | fetchUsage（含整改 #4） |
| `fetch-campaigns.ts` | fetchCampaigns（含整改 #1：预计整个文件删除） |
| `sign.ts` | signaturePath / 签名 info 块（upstream.ts:257、:279 uid 进签名块） |
| `headers.ts` | Cosy-* 头组装（:328 Cosy-User 明文 uid） |
| `endpoints.ts` | 各 API 端点 URL 与信封形状 |
| `api-calls.ts` | 登录/目录/用量/签到/账号各调用编排 |

门面 upstream.ts re-export 全部现名导出（含整改 #1 死导出除外）。

## 验收标准（2026-10-17 全部核销）

- [x] 门面 re-export 后，12 个测试文件 + 5 个 probe + 3 个 importer **一行不改**全绿
      （实际只改了 test/ 里 5 处**注释里的旧路径引用**与 `docs-facts.test.js` 的目录遍历——
      那是「路径同步」，没有一处改断言语义；`docs-facts.test.js` 现在递归 `src/host/`，
      否则 `readdirSync` 会把 `upstream/` 目录当文件读）
- [x] `npm run typecheck`、`npm test`、`npm run build` 全绿；`lib/` 与 `src/` 同一次提交（红线 3）
      （`npm test` = 1,127 tests / 1,124 pass / 0 fail / 3 skipped；typecheck 干净；
      `npm run build` 重建后 `lib/client.js` 与重建前逐字节相同，`lib/index.js` 反映拆分）
- [x] 整改清单四条全部核销：
      **#1** `fetchCampaigns` 已删（grep 全仓 8 处命中全是文档/注释/产物，无真实调用方）；
      **#2** `sse.ts:15` 从 `../errors.ts` import `parseRetryAfterSeconds`，本地重复实现已删
      （`sse.ts:402` 注释记录「`errors.ts` 的是唯一一份」）；
      **#3** `headers.ts:187` 改调 `normalizeUmidBlock`（比原内联校验更严：空串
      `machineType`/`machineCode` 现在被拒，与 all-or-nothing 文档一致）；
      **#4** `fetchUsage` 的 campaigns 读失败不再吞（`fetch-usage.ts:363` `describeThrown(error)`
      写入快照 `campaignsError`，卡片渲染），带 `test/usage-campaigns-error.test.js` 3 个测试
- [x] `test/audit:any` 两道审计保持 0 命中（implicit-any 0 / explicit-any 0）
- [x] AGENTS.md 协议事实锚点（拆分前 `upstream.ts:1-31` 头部读法）原文整体搬迁至
      `src/host/upstream/crypto.ts:1-29`，未改一字，并在其后附「三个机制现在在哪」的注记
- [x] 每个叶模块文件头注明「自 src/host/upstream.ts 原文搬迁」+ 拆分依据 + 协议注释新址
      （`fetch-usage.ts` 因整改 #4 是该文件唯一的**有意**逻辑改动，头注写「搬迁」并单列改动说明，
      不写「未改逻辑」）

## 风险（不粉饰）

1. **搬迁时行号漂移**：本文行号是 2026-10-17 时点，动手时以当时源码重量为准，别按行号硬切。
2. **`export *` 门面会放大表面积**：门面逐名 re-export，不用 `export *`，让删除一个导出时
   门面必须显式表态（TS 编译器当场报错），防止死导出悄悄回流。
3. **test/ 里若有对 upstream.ts 文件路径本身的断言**（如 probe-imports 守门），拆分时要同步改——
   这类断言是守门不是负担，改路径不改语义。
