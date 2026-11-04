# 测试树的类型债实测快照 — 2026-10-21

**日期**：2026-10-21 · **状态**：快照（下面的数字只代表这一天）

## 怎么测的

`node scripts/audit-test-type-errors.mjs --write` —— 它把整棵测试树放进
`tsconfig.test.budget.json`（同源 `tsconfig.test.json`、`checkJs: true`），跑一遍 `tsc`，
逐行数错误。范围不止 `test/`：被测试文件顺带 import 进来的
`scripts/probe-params.mjs` 与 `probe/qoder-device-login.mjs` 也在程序里——所以「改 `src/`
也可能动这个数」，这不是错觉，是程序边界。

## 这一天的数字

- 错误总数 **2018** 条，分布在 **93** 个文件里。
- 按错误码排：`TS7006` 471、`TS2345` 302、`TS2339` 233、`TS7005` 166、`TS18048` 148、
  `TS7034` 90、`TS2379` 89、`TS2353` 89、`TS2532` 83、`TS2322` 64、`TS18046` 57、
  `TS7053` 46、`TS6133` 39、`TS18047` 29、`TS2769` 23、`TS7031` 18、`TS7017` 12、
  `TS2571` 12、`TS2740` 10、`TS2531` 8；剩下 16 种码合计 29 条。前十种码占了 1735 条。
- 最重的文件：`test/handlers.test.js` 161、`test/shim.test.js` 136、`test/route-mount.test.js` 60、
  `test/credential-cache.test.js` 58、`test/offpeak.test.js` 58、`test/catalog-refresh.test.js` 52、
  `test/activation.test.js` 51、`test/model-route.test.js` 50、`test/quota-amounts.test.js` 47、
  `test/card-dom.test.js` 46、`test/helpers/render-card.js` 44、`test/route-gates.test.js` 44。
- 被测试文件拖进来的两个非测试文件：`probe/qoder-device-login.mjs` 35、`scripts/probe-params.mjs` 29。
- opt-in 的测试文件 13 个，与 `npm run audit:test-types` 的棘轮下限一致；它们必须**零错误**。

## 这份快照怎么用

- 它是**历史**，不是承诺。上界住在 `scripts/ratchet-ledger.json` 的 `testTypeErrorBudget`
  ratchet 里；哪天降了预算，这份快照就过期了（那正是它该有的样子）。
- 要看今天的数，跑 `npm run audit:test-type-errors`——它打印实测数与生效的上界，两者相等才是绿的。
- 降债的顺序建议：`TS7006`（参数隐式 any）471 条最机械（补 JSDoc 类型标注就行），
  `TS2345`/`TS2339`（形状与属性）对测试的可信度最值钱；`TS7005`/`TS7034`（未使用的变量与
  参数）纯噪音，删掉即可。
