## 这次改了什么

<!-- 一段话：用户/宿主能观察到什么变化，以及为什么必须这样改。 -->

## 失败路径检查（issue 16 门禁）

- [ ] 本次新增的每个 `return undefined` / 空 `catch` / “失败但继续”分支，都在这里写明了**调用方如何得知失败**：既有通道（`setCredentialDiagnosticSink`、结构化事件、`logger.warn`）或卡片/胶囊上的可见状态。
- [ ] 没有为了“看起来正常”而把失败折进成功或空结果；普通探测（例如某台机器没有某个 app 目录）不算失败，无需上报。

## 验证

- [ ] 改 `src/` 后跑过 `npm run build`，`lib/` 与源码同一次提交（`docs/issues/19`）
- [ ] `npm run verify`（或按改动域裁剪的 typecheck / test / verify:host / verify:bundle）
