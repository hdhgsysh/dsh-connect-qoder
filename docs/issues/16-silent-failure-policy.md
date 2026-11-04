# 门禁：新代码不得再新增"静默失败"分支

**P2 · 规模 S · 依赖 —（可独立落地，越早越好）**

## 症状

这次审计的结论集中在同一个工程习惯上：**宁可能力缺失，不肯报错**。
清单里几乎每条都是它的变体：

| 表现 | 位置 |
|---|---|
| 目录成功刷新为 0 个模型时什么都不做，界面继续显示旧目录 | `lib/index.js:377-386` |
| "已更新（时间）"用响应时刻，刷新失败也照显 | `lib/index.js:848` |
| 端点失败后回退到自读回的快照，显示假"已保存" | `lib/client.js:311-322` |
| 凭据读不出来统一说成"app 在但没登录" | `src/host/account-state.ts` |
| `readItem` / `readJsonSecret` / `loadNewCredential` 全线返回 `undefined` 且无诊断 | `src/host/credentials.ts` |
| `zeroOutFile` 把 `statSync` 失败当"文件已不存在" | `src/host/credentials.ts` |
| 命名空间不匹配 → 整行从设置页消失，不报错 | `lib/index.js:564` / `src/host/settings-save.ts` |
| 上游协议形状变化 → 被当作"排队"重试到预算耗尽 | `src/host/upstream/retry.ts` + `src/host/upstream/sse.ts`（拆分前 `src/host/upstream.ts`，见 `docs/issues/22`） |
| 促销活动读失败 → 只置 flag，面板上"没活动"与"读不出来"长得一样 | `src/host/upstream/fetch-usage.ts`（拆分时按本条核销，见 `docs/issues/22` 整改 #4） |
| 产物被替换成桩 → 套件"少 6 条测试"而不是红 | `test/client-bundle.test.js:49-96` |

## 修法

1. **评审规则**：任何 `return undefined` / 空 `catch` / "失败但继续"的新分支，必须在 PR 里
   写出"调用方如何得知失败"。诊断走已有的 `setCredentialDiagnosticSink` 或结构化事件。
2. **可观测性**：把这条规则落成一条测试——对 `src/host/credentials.ts`、`src/host/catalog-store.ts`
   的导出函数做一次"失败注入"，断言至少产生一条上报（现在多数是 0 条）。
3. **卡片**：新增的每条失败路径都要有一个用户可见状态（而不是回落到"看起来正常"）。

## 验收标准

- [x] 新用例：对凭据层与目录层各注入一次失败，断言上报条数 ≥ 1
- [x] `CONTRIBUTING` 或 `docs/PLAN.md` 里写明这条评审规则，并在 PR 模板里加一项勾选
- [x] 后续新增的静默分支在评审中被明确标注（可 grep `catch {}` 与 `return undefined` 抽查）

## 实现（2026-10-17）

- **可执行门禁**：新增 `test/failure-reporting.test.js`，两处失败注入各断言上报通道 ≥ 1 条：
  - 凭据层：`qoder-oscrypt-*` 目录带本插件 marker 但夹带陌生文件时，sweep 必须拒绝清理
    并经 `setCredentialDiagnosticSink` 上报（该分支此前是"清掉且零上报"）；
  - 目录层：`CatalogStore` 的原子写失败（目标路径是目录，`EISDIR`）必须经 `logger.warn` 上报。
- **评审规则落纸**：`docs/PLAN.md` 新增 P2-5 小节（表 + 详情），写明"新失败分支必须留下调用方
  可感知的信号"及其边界（普通探测不算失败）；`.github/pull_request_template.md` 新建并加两项
  勾选（失败路径检查 + `lib/` 同提交）。
