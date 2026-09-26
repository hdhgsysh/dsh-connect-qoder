# 已知覆盖缺口

这份文件登记**明确知道没有测试保护**的地方。每条都写清「为什么现在没有」和
「要补上它需要先做什么」，这样缺口是待办，不是旁白。

新增测试时请顺手更新本文件；删掉一条时请在提交信息里说明它为什么不再成立。

**最近一次复核**：已解决 3 条（凭据缓存链路、目录落盘、CLI 入口），仍存在 4 条，
其中 3 条是原理上不可测而非尚未动手。

---

## 1. 设置保存的读回校验

**位置**：`lib/index.js` 的 `__save` 路由（约 130 行）

**为什么没测**：`lib/index.js` 顶层 import `@deepseek-ai/dsh-home-paths`、
`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`，本仓库的测试环境不安装 peer
依赖，因此该模块无法被 import。

**为什么它重要**：这段代码的全部存在理由，是 DSH 0.1.7 的 `settingsScope.set()`
会在原子写重试耗尽后**静默成功而不落盘**。它用「写入 → `mutate` → 读回 → 深度比较」
来把假成功变成显式失败。用户在设置卡片上点保存，如果这个判定失效，界面会显示
「已保存」而配置根本没变——而配置没变意味着模型选择、图像开关、上下文窗口
全部没有生效，且没有任何提示。

**已经测到哪一步**：`QODER_SAVE_FIELDS` 的合并规则（`regions` 按区域合并而非整体
替换）**没有**被测。相邻的 `filterByEnabled`、`isCredentialUsable` 都测了，唯独
这条合并规则是裸的。

**要补上需要**：把 `__save` 的 handler 主体抽成一个接收 `settings` 与 `body` 的
纯函数，路由只负责取 body 和写响应。这是最容易拆、收益最高的一处。

**附带的实现风险**（不是覆盖问题，是代码问题）：namespace 匹配链的最后一两级用
`String(entry.ns).includes(name)` 兜底。前面几级都是全等匹配，只有全落空才会走到
这里，所以现实风险低，但 `'llm-qoder-extra'` 这类命名会被 `includes('llm-qoder')`
命中，随后对**错误的 settings 行**执行 `mutate`。改成全等或显式前缀更稳妥。

---

## 2. `toPiModel` 与 `adapter.js` 的其余部分

**位置**：`lib/adapter.js`

**为什么没测**：模块顶层 import `@earendil-works/pi-ai` 与
`@deepseek-ai/dsh-llm-pi-ai`，本仓库不安装 peer 依赖。

**风险**：`toPiModel` 里那行 `compat: { supportsDeveloperRole: false }` 是整个插件
最关键的一行——没有它，每个请求都会 403 `10605`，且 DSH 会无限重试。同一函数里
还有「故意不声明 `maxTokens`」这个决定，理由同样充分（声明了会让长推理回复被截断，
harness 报 `finish: max-tokens`）。这两处目前只有注释守着。

**已经测到哪一步**：它消费的 `rateNow` / `offPeakActive` / `offPeakRemaining`
已全部移到 `lib/offpeak.js` 并被完整覆盖。

**要补上需要**：把 `toPiModel` 的输出构造（与 `PiAiAdapter` 无关的那部分）抽到
无依赖模块，或用 `node --experimental-test-module-mocks` 桩掉 pi-ai。

---

## 3. 客户端卡片的门控表达式

**状态**：**已知的、刻意接受的镜像**。`test/model-row.test.js` 里的
`cardInstallsClock` 复刻了卡片 bundle 中的
`models.some((m) => m.promotion?.active === true)`。

**为什么无法 import**：卡片是浏览器 bundle，由 5 个从不提交的 TypeScript 源文件
构建（`src/client/{paths,styles,settings-write,copy,index}.ts`）。仓库里没有任何
构建配置能重新生成 `lib/client.js`。

**同步约束**：卡片里那条表达式一旦改写，测试里的副本必须一起改，否则测试会在断言
一条没人实现的规则的同时保持绿色。

这与本仓库其他测试曾犯的错是同一类（手抄副本），之所以接受，是因为
「完全不覆盖」比「覆盖一个可能过期的副本」更糟——这个 bug 恰恰是在那一层发生的。

**根治办法**：把 `src/client/*.ts` 纳入仓库，让 `lib/client.js` 成为可复现的构建
产物。这是本文件里价值最高的一条待办，但工作量也最大。

---

## 4. 协议层的两个原理盲区

**位置**：`lib/upstream.js` 的 `authHeaders`

**为什么测不了**（已实测确认，不是推测）：

1. **RSA 填充模式**。Node 的 `publicEncrypt` 返回裸 RSA 结果，PKCS#1 v1.5 的
   framing（`0x00 0x02 PS 0x00 M`）不出现在密文里。1024 位密钥下 PKCS#1 与 OAEP
   都是 128 字节，差异只在永不暴露的 padding 串中。把 `authHeaders` 改成 OAEP，
   `upstream-protocol.test.js` 全绿。
2. **AES key 的随机性**。RSA padding 是随机的，所以常量化的 AES key 每次仍会
   产生不同的 `Cosy-Key`。「key 每次不同」这条断言对常量 key 同样成立。

**能测的都已测**：key 尺寸（RSA-1024 包装 128 字节）、`info` 必须是 16 字节对齐
的 AES 密文且不含明文身份、签名覆盖的输入与顺序、`/algo` 前缀剥离、编码的双射性。

**要真正覆盖需要**：网关的私钥，或一份可对照的真实网关响应样本。有了样本，
第 1 条立刻可测（用样本里已知的明文/密文对验证 padding 行为）；第 2 条仍然不可测，
因为它关乎的是**本端**是否每次生成新 key，而这只能靠审查代码而非测试来保证。

---

## 5. 两条「不可约」的等价路径

这两处不是没写测试，是**写了也测不到**，因为两条代码路径产生完全相同的可观察行为。

### 5a. `decryptOscrypt` 的长度守卫

`blob.length < 3 + 12 + 16` 这个显式检查，与「短 blob 让 `createDecipheriv` 在
截断的 nonce 上抛错、被 `catch` 吞掉」都返回 `undefined`，从外部无法区分。
实测：删掉守卫，`oscrypt.test.js` 全绿。

守卫本身是对的（避免在每次启动的热点路径上抛异常）。**不建议**为了可测性而删除它。

### 5b. `CredentialCache.resolve` 的「无凭据」分支

`if (credential === undefined) { this.cached = undefined; return undefined }` 里的
那行 `this.cached = undefined` 可以删掉而不改变任何可观察行为——因为
`isCredentialUsable(undefined)` 已经是 `false`，下一次 resolve 无论如何都会重读。
实测：删掉该行，`credential-cache.test.js` 全绿。

保留它是为了可读性：显式清空比依赖「undefined 恰好不可用」更清楚。

---

## 6. 仍未建立的东西

这些不是「某处没测」，而是整个仓库层面的缺失：

- **没有变异测试 harness**。本文件里每一条「实测全绿」都是手工跑出来的
  （逐个改坏、跑测试、看是否变红、还原）。没有 `mutmut` 之类的工具把它们变成
  持续的门禁，所以下一个改动可能悄悄重新引入其中一条。
- **覆盖率没有门槛**。`npm run test:coverage` 会输出数字（当前整体行覆盖约 57%，
  函数覆盖约 51%），但没有阈值。低覆盖率本身不是问题——`lib/index.js` 的 HTTP
  路由与 Cordis 接线在单元测试里天然难覆盖——真正的问题是**哪些具体回归被守住**，
  而那个没法用百分比表达。
- **CI 不跑覆盖率门槛**，只跑测试。见 `.github/workflows/test.yml`。
