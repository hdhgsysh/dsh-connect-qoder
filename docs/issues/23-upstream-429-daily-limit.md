# 上游把「每日额度用完」换成了 HTTP 429：插件跑满两分钟预算，宿主再叠五次重试

**P1 · 规模 S · 依赖 — · ✅ 已修（2026-10-19）**

## 现象（用户原话，2026-10-19）

```
429: {"message":"Qoder's daily request allowance for this account is used up.
      Waiting within the session will not help; the off-peak price (22:00–08:00
      Asia/Shanghai) and the daily check-in both still work.","type":
      "daily_limit_exceeded","code":"daily_limit_exceeded"}
```

问的是「这个插件会正确阻断重试吗」。答案曾经是**不会**，而且错得比这条错误信息本身
看上去更深：同一个「今天用完了」被**两层**各自当成可重试。

## 根因（两层，互相独立）

### 第一层：插件的非 2xx 路径先判状态、后读 body

`src/host/upstream/sse.ts` 的 `openAttempt()` 里，`if (!response.ok)` 之后原来的顺序是：

1. `if (response.status === 429 || response.status >= 500)` → 直接
   `throw new QueueRejection(...)`（`retryable: true`）；
2. 只有走到后面才 `readFailure(...)` + `classifyUpstreamError(...)` 分类。

而 `classifyUpstreamError` 对 `code === 'daily_limit_exceeded'`（以及旧的数值 `110`、
prose `daily request allowance`）返回 `{ kind: 'daily-limit' }`——这个分类**本来是**对
的，`test/daily-limit.test.js` 也一直在钉它。问题只在于：429 根本走不到它。于是

- 上游语义：今天没有了，等到明天；
- 插件行为：`QueueRejection` → 进队列阶梯 → **实测 12 次请求 / 120,101 ms**
  （`probe/http-429-daily-limit-probe.mjs` 实测，修复前）；
- 对照：同一个 body 用 `400` 送出时只请求 1 次、抛 `DailyLimitRejection`
  （`retryable: false`、`dailyLimit: true`）——证明分类器没问题，错的是状态门的顺序。

旁证：旧口径的 in-band error 帧路径（同一个方法里的帧循环）**本来就是**先分类、把
`daily-limit` 放在队列分支之前，注释也写着「must not be retried at all」。两条路径的
顺序不一致，是这次漏掉的直接原因。

### 第二层：宿主（DSH）看不见 `retryable`，只按文本分类

`retryable: false` 只挡得住插件自己的阶梯。shim 交出去的是「HTTP 状态 + 一段文本」
（`src/host/shim.ts:458` `writeError(res, 429, 'daily_limit_exceeded', describeThrown(error))`），
宿主的分类完全基于文本：

- `@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1448` `classifyPiAiError(message)` 的顺序是
  `401/403 → isQuotaExceededError → 429|rate.?limit → 413/400 → 5xx → timeout → transport`；
- `@deepseek-ai/dsh-llm/lib/types/error.js:76` `isQuotaExceededError` 只认已归档的额度措辞
  （`quota|usage limit` + `exceeded|exhausted|reached`、`insufficient quota|balance|credits`…），
  **不认**「daily request allowance … is used up」这句散文；
- 于是落进 `\b429\b|rate.?limit` → `RATE_LIMIT`；
- 而 `RATE_LIMIT` 在 `@deepseek-ai/dsh-llm/lib/types/retry-policy.js` 的
  `DEFAULT_RETRYABLE_CODES` 里（`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`），
  默认策略 `maxRetries: 5` → **再叠 5 次**。

也就是说：`DailyLimitRejection` 的类注释原写着「`retryable: false` 同时挡住插件阶梯和
宿主的重试策略」——后半句从来没有成立过（`retryable` 不可能跨进程传给宿主）。

> 后续（2026-10-19）：这一层现在由 [24](24-terminal-failure-status-codes.md) 一并关掉——
> `src/host/route-retry-policy.ts` 把本路由交给宿主的策略收窄为
> `EMPTY_RESPONSE / TIMEOUT / TRANSPORT`，`RATE_LIMIT` 不再被宿主重试。上面这段描述的是
> 收窄**之前**的默认策略，保留作为"为什么文案也是锁"的出处：quota 措辞让宿主把这件事
> 判成 `QUOTA`（诚实、并且不依赖那份码表），码表收窄则覆盖所有终态判决。

## 修复

1. **`src/host/upstream/sse.ts:394-421`：先读 body、后判状态。**
   `readFailure(...)` 提到 429/5xx 分支之前，`daily-limit` 命中即
   `throw new DailyLimitRejection(...)`——与帧路径同一顺序、同一理由。429 分支本身
   不变（真正的队列仍是队列，仍按 `Retry-After` 走阶梯）。
2. **`DailyLimitRejection` 的文案带上宿主认得的额度措辞**：
   `… is used up (daily quota exhausted). …`（`sse.ts:604`）。这不是修辞：宿主按文本
   分类，`quota exhausted` 命中 `isQuotaExceededError`，于是分类成 `QUOTA`（不在可重试
   集合里）而不是 `RATE_LIMIT`。类注释 `sse.ts:543-586` 已改写为如实的两层说明。

## 验证

- `test/daily-limit.test.js` 新增 3 个测试，用 `fetch` stub 驱动**真的** `streamChat`：
  - 429 + 该 body → **1 次请求**、`DailyLimitRejection`、`retryable:false`（修复前为 12 次/120 s）；
  - 429 + 真队列（`10605` + 队列标记）→ 仍重试，随后的 429 每日额度立刻收尾（`calls === 2`）；
  - 文案含有 `daily quota exhausted` 且两词相邻（宿主正则的邻接要求）。
  变异验证：把第 1 步的提前判断删掉，3 个新测试全红（各 8 s 超时 = 阶梯被进入），恢复后全绿。
- `probe/host-retry-classification-probe.mjs`：从安装副本 `app.asar` 取出**宿主自己的**
  `isQuotaExceededError`（该文件零 import，可直接执行）判定真文案；并**读取**宿主的
  `classifyPiAiError` 顺序、默认可重试码表（`DEFAULT_RETRYABLE_CODES`）与**本路由生效的
  策略**（`src/host/route-retry-policy.ts`），任一处漂移即 FAIL。当前 PASS：
  两种文本合成（`429: <json>` / `429 <message>`）都命中 `QUOTA`，上游原文（无括注）不命中。
- `npm run typecheck` / `npm test` / `npm run build`（重建 `lib/`）全绿。

## 边界（这次**没有**做的，明说而不静默）

- **同状态下的 `sign-in-expired` 仍会被 429/5xx 分支吃掉**（重试 12 次后才报出来）。
  它同样是终态判决，但这次没动：改它要连带确认 shim 的凭据失效路径
  （`isStaleCredentialError` → `invalidateCredential`）在 429 上是否安全，
  证据不足就不一起改。留作后续。
- **治标的成分**：第 2 步依赖宿主的文本分类，属于跨包契约。`probe/host-retry-classification-probe.mjs`
  就是为这条契约写的漂移探针——宿主改措辞表，它会红，而不是悄悄退回「重试五次」。
- 若宿主将来把 `QUOTA` 也纳入可重试集合，本修复会失效；探针第 [3] 段会立刻报出来。
