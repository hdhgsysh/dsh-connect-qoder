# 已知覆盖缺口

这份文件登记**明确知道没有测试保护**的地方。每条都写清了「为什么现在没有」和
「要补上它需要先做什么」，这样缺口是待办，不是旁白。

新增测试时请顺手更新本文件；删掉一条时请在提交信息里说明它为什么不再成立。

---

## 1. `RegionRuntime` 与 `credentialInvalid` 标志

**位置**：`lib/index.js` 的 `RegionRuntime.resolveCredential` / `invalidateCredential`

**为什么没测**：`lib/index.js` 顶层 import `@deepseek-ai/dsh-home-paths`、
`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`，本仓库的测试环境不安装 peer 依赖，
因此该模块无法被 import。

**已经测到哪一步**：`credential-invalidation.test.js` 测了这条链路上的**两个纯谓词**
——`isStaleCredentialError`（`lib/errors.js`）与 `isCredentialUsable`
（`lib/credentials.js`）——并对两者做了变异验证。

**没测到的是**：把两者连起来的那个标志。即「shim 观察到登录失效」到
「下一次请求真的重新读取了应用存储」这一段接线。

**要补上需要**：把 `RegionRuntime` 里的缓存与失效逻辑抽成一个不依赖 Cordis 的小类，
或用 `node --experimental-test-module-mocks` 提供 `@deepseek-ai/*` 的桩。
后者更贴近真实调用，但需要给 `package.json` 的 test script 加 flag。

---

## 2. `RegionRuntime.readUsage` 的缓存与 `CatalogStore` 的落盘

**位置**：`lib/index.js`

**为什么没测**：同上，模块级依赖 peer 包。

**风险**：`CatalogStore.save()` 走「写临时文件再 rename」，注释里声称这在 POSIX 上是原子的。
如果这个假设在某个文件系统上不成立，会静默丢缓存——模型列表变空，而用户看到的只是
「模型不见了」。目前没有任何测试覆盖这条路径。

**要补上需要**：把 `CatalogStore` 抽成独立模块（它只依赖 `node:fs` / `node:path` /
一个 `logger`），然后用临时目录做往返测试。这件事本身也值得做——它是 487 行的
`activate` 之外最独立的一块。

---

## 3. 设置保存的读回校验

**位置**：`lib/index.js` 的 `__save` 路由（约 134 行）

**为什么没测**：与 #1 同一个原因。

**风险**：这段代码的全部存在理由是 DSH 0.1.7 的 `settingsScope.set()` 会静默成功而不落盘。
它用「写入 → `mutate` → 读回 → 深度比较」来防止假成功。这个判定的正确性没有被断言过。

**附带风险**：`index.js` 里 namespace 匹配用了 `String(entry.ns).includes(name)` 作为
兜底。前面几级都是全等匹配，只有全落空时才会走到这里，所以现实风险低，但
`'llm-qoder-extra'` 这类命名会被 `includes('llm-qoder')` 命中，随后对**错误的
settings 行**执行 `mutate`。改成全等或前缀匹配更稳妥。

---

## 4. 客户端卡片的门控表达式

**位置**：`test/model-row.test.js` 里的 `cardInstallsClock`

**状态**：**已知的、刻意接受的镜像**。卡片是浏览器 bundle，由不在本仓库的
TypeScript 源码构建，所以这条规则无法 import。

**同步约束**：卡片里 `models.some((m) => m.promotion?.active === true)` 一旦改写，
测试里的这份副本必须一起改，否则测试会在断言一条没人实现的规则的同时保持绿色。

这与本仓库其他测试曾经犯过的错是同一类（手抄副本）——之所以接受，是因为
「不覆盖」比「覆盖一个可能过期的副本」更糟。

**根治办法**：把 `src/client/*.ts` 纳入仓库并让 `lib/client.js` 变成可复现的构建产物。
目前 `lib/client.js` 是 1255 行的编译输出，其 5 个源文件从未提交过。

---

## 5. 协议层的两个原理盲区

**位置**：`lib/upstream.js` 的 `authHeaders`

**为什么测不了**（已实测确认，不是推测）：

1. **RSA 填充模式**。Node 的 `publicEncrypt` 返回裸 RSA 结果，PKCS#1 v1.5 的
   framing（`0x00 0x02 PS 0x00 M`）不出现在密文里。1024 位密钥下 PKCS#1 与 OAEP
   都是 128 字节，差异只在永不暴露的 padding 串里。把 `authHeaders` 改成 OAEP，
   `upstream-protocol.test.js` 全绿。
2. **AES key 的随机性**。RSA padding 是随机的，所以常量化的 AES key 每次仍会
   产生不同的 `Cosy-Key`。断言「key 每次不同」对常量 key 同样成立。

**能测的已测了**：key 的尺寸（RSA-1024 包装 128 字节）、`info` 必须是 16 字节对齐的
AES 密文且不含明文身份、签名覆盖的输入与顺序、每请求唯一性。

**要真正覆盖需要**：网关的私钥，或者一个能对照的真实网关响应样本。

---

## 6. `decryptOscrypt` 的长度守卫

**位置**：`lib/credentials.js`

**为什么测不了**：`blob.length < 3 + 12 + 16` 这个显式检查，与「短 blob 让
`createDecipheriv` 在截断的 nonce 上抛错、被 `catch` 吞掉」是两条不同的路径，
但**两者都返回 `undefined`**，从外部无法区分。

实测：删掉该守卫，`oscrypt.test.js` 全绿。

**为什么不打算修**：守卫本身是对的（避免在每次启动的热点路径上抛异常），只是不可观测。
如果将来给这个模块加覆盖率门槛，这条应该以「不可约的盲区」的形式记录，而不是补一个
假装能测到的断言。
