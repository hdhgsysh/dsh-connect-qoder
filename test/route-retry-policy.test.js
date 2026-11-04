/**
 * 本路由的宿主重试策略：只留 `EMPTY_RESPONSE` / `TIMEOUT` / `TRANSPORT`。
 *
 * Run: node --test test/route-retry-policy.test.js
 *
 * 为什么值得一条测试：这组码是**行为取舍**，不是实现细节——docs/issues/24 §1–§3 的结论
 * （终态判决不再白重试、队列预算不再被宿主续杯）全都建立在「`RATE_LIMIT`/`SERVER` 不在
 * 集合里」之上，而它的失效方式是安静的：把 `adapter.ts` 里那一行改回
 * `resolveRetryPolicy(undefined, …)`（看起来像"用回宿主默认、更省事"），或随手往集合里
 * 加一个码，都不会弄坏别的测试；线上表现是"又被重试了 5 次"，而用户只会看到又一次等待。
 *
 * `adapter.ts` 的接线用**源码文本**断言，沿用 `test/region-enabled-defaults.test.js` 的
 * 先例：`createQoderAdapter` 需要真的 pi-ai peer 才能构造，只为读一个字段不值得把 peer
 * 拉进测试。
 */
// @ts-check

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { ROUTE_RETRY_POLICY } from '../src/host/route-retry-policy.ts'

const adapterSource = readFileSync(new URL('../src/host/adapter.ts', import.meta.url), 'utf8')

test('本路由的策略：normal 模式，只留三个码', () => {
  assert.deepEqual(ROUTE_RETRY_POLICY, {
    mode: 'normal',
    retryableCodes: ['EMPTY_RESPONSE', 'TIMEOUT', 'TRANSPORT'],
  })
})

test('宿主自己的预算与退避不归我们定：maxRetries / backoff 都不写', () => {
  // 写死这两个字段会把宿主将来的默认值冻在插件里；收窄的是**集合**。
  assert.equal('maxRetries' in ROUTE_RETRY_POLICY, false)
  assert.equal('backoff' in ROUTE_RETRY_POLICY, false)
})

test('不再重试 RATE_LIMIT：队列的 120 s 预算只能花一次', () => {
  // 插件阶梯（upstream/retry.ts 的 QUEUE_WAIT_BUDGET_MS）花完 120 s 放弃后 shim 回
  // 503 rate_limit；宿主若重试 RATE_LIMIT，每次都会重开同样的 120 s（最坏 ~12 min）。
  assert.equal(ROUTE_RETRY_POLICY.retryableCodes.includes('RATE_LIMIT'), false)
})

test('不再重试 SERVER：终态判决问第二遍也不会变', () => {
  // 协议形状漂移（"插件需要更新"）与首帧登录过期都从 shim 的 502 upstream_error 出去，
  // 宿主按文本判 SERVER；重试只是把这句话推迟约 15 s 才显示给用户。
  assert.equal(ROUTE_RETRY_POLICY.retryableCodes.includes('SERVER'), false)
})

test('保留的三个码是宿主与 shim 之间那跳的失败：插件自己看不见，也就重试不了', () => {
  assert.deepEqual([...ROUTE_RETRY_POLICY.retryableCodes].sort(), ['EMPTY_RESPONSE', 'TIMEOUT', 'TRANSPORT'])
})

test('adapter.ts 真的把这份策略交给宿主（不是 undefined = 默认）', () => {
  assert.match(adapterSource, /import \{ ROUTE_RETRY_POLICY \} from '\.\/route-retry-policy\.ts'/)
  assert.match(
    adapterSource,
    /retryPolicy: resolveRetryPolicy\(\s*ROUTE_RETRY_POLICY,\s*`dsh-connect-qoder\.\$\{providerId\}\.retryPolicy`,?\s*\)/,
  )
  assert.equal(
    adapterSource.includes('resolveRetryPolicy(undefined'),
    false,
    'resolveRetryPolicy(undefined, …) 是宿主默认策略——那会把 RATE_LIMIT/SERVER 放回来',
  )
})
