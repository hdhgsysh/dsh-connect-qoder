/**
 * 探针：上游用 **HTTP 429** 送 `daily_limit_exceeded` 时，chat 路径还挡不挡重试。
 *
 * 背景：上游旧口径把「每日额度用完」放在 200 的 in-band error 帧 / 非 429 的
 * 非 2xx 里，`classifyUpstreamError` 已按 code 识别成 `daily-limit`（
 * `retryable:false`）。现在同一件事换成了 429 + JSON body。
 *
 * 探针只回答一个问题：`streamChat` 收到这个 429 后，是发一次就抛
 * `DailyLimitRejection`（不重试），还是走队列阶梯继续重试？
 *
 * 运行：node probe/http-429-daily-limit-probe.mjs
 *
 * 实测（2026-10-19，修复前 → 修复后）：
 *   HTTP 429 + daily_limit_exceeded body：{calls: 12, elapsedMs: 120101,
 *     name:'QueueRejection', retryable:true} → {calls: 1, elapsedMs: 21,
 *     name:'DailyLimitRejection', retryable:false, dailyLimit:true}
 *   对照组 HTTP 400 + 同一 body：两次都是 {calls: 1, dailyLimit:true}
 *     ——即分类器一直是对的，错的只是 429 这条状态门把它抢走了。
 * 修复与验收见 docs/issues/23-upstream-429-daily-limit.md；
 * 宿主那一侧（分类成 QUOTA 而非 RATE_LIMIT）见
 * probe/host-retry-classification-probe.mjs。
 */
const { streamChat } = await import('../src/host/upstream.ts')

const BODY = JSON.stringify({
  message:
    "Qoder's daily request allowance for this account is used up. Waiting within the session will not help; " +
    'the off-peak price (22:00–08:00 Asia/Shanghai) and the daily check-in both still work.',
  type: 'daily_limit_exceeded',
  code: 'daily_limit_exceeded',
})

const REGION = { id: 'qoder', displayName: 'Qoder', baseUrl: 'https://gateway.example' }
const CREDENTIAL = { userID: 'u-probe', token: 'tok-probe', name: 'n', email: 'e@x', machineID: 'm' }
const REQUEST = {
  model: 'model-key',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  maxTokens: undefined,
  enableThinking: false,
  alwaysThinking: false,
  reasoningEffort: undefined,
  sessionId: 's-probe',
}

/** Drive one `streamChat` against a fetch stub that always answers `status`. */
async function run(status, timeBudgetMs = 6000) {
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    calls += 1
    // 没有 retry-after 头：和上游新 429 的实测一致（再退避全由插件自己决定）。
    return new Response(BODY, { status, headers: { 'content-type': 'application/json' } })
  }
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeBudgetMs)
  let error
  try {
    const iterator = streamChat(REGION, CREDENTIAL, REQUEST, controller.signal)
    for (;;) {
      const step = await iterator.next()
      if (step.done) break
    }
  } catch (thrown) {
    error = thrown
  }
  clearTimeout(timer)
  globalThis.fetch = original
  return {
    calls,
    elapsedMs: Date.now() - started,
    name: error?.name,
    retryable: error?.retryable,
    dailyLimit: error?.dailyLimit,
    retryAfterSeconds: error?.retryAfterSeconds,
    message: String(error?.message ?? '').slice(0, 120),
  }
}

const budget = Number(process.env.PROBE_BUDGET_MS ?? 6000)

console.log('body =', BODY)
console.log(`\n[HTTP 429 + daily_limit_exceeded body]`, await run(429, budget))
console.log('\n[HTTP 400 + same body, control group]', await run(400, 2000))
