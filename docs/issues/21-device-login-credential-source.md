# 设备登录作为第三个凭据来源：插件自有 vault 存可刷新令牌

**P2 · 规模 L · 依赖 —**（已实现；改「三条事实」第 2 条的那一步已获用户明确同意，见「风险」3）

## 背景（我们缺的不是"能力"，是"零配置"）

本插件目前的凭据只有两条来源：桌面端登录态（OSCrypt 解密，`src/host/credentials.ts`
`loadNewCredential`）与 `QODERCN_*` / `QODER_*` 环境变量 PAT。

跨设备看，两条都不是好路子：

- **桌面端登录态是机器绑定的**。密文由本机 DPAPI / Keychain 解出，把文件拷到另一台机器上
  解不开（这也是 `docs/KNOWN_GAPS.md` item 6（跨平台凭据链未实现）里 macOS/Linux
  keystore 那一大坨工作的由来）。
- **环境变量 PAT 其实已经能跨设备**——它是可携带的，卡片在 macOS 上给用户的建议正是指向它。
  但用户得自己去后台造一个长期令牌。

所以缺的**不是跨设备能力，是零配置**：设备登录只需扫一次码，且拿到的是**可刷新**令牌。

## 证据（2026-10-17 两区实测，`probe/qoder-device-login.mjs`）

三段闭环，CN（`qoder.cn`）与国际（`qoder.com`）各跑一次，全部 exit 0：

1. **登录闭环成立**。`/device/selectAccounts` 授权 → `/api/v1/deviceToken/poll` 轮询拿到
   `dt-…` 访问令牌与 `drt-…` 刷新令牌；poll 信封 14 个字段。两区 clientId 均被真实授权验证
   （CN `732aef47-…`、国际 `e883ade2-…`），两区 access_token 27 字符、refresh_token 28 字符。
2. **凭据驱动本插件自有的网关路径**，不是另走一套。探针直接调 `authHeaders()` + `modelListUrl()`：
   `model list: HTTP 200`，CN chat=14、国际 chat=17，与 `machineos-probe.mjs` / `model-shape.mjs`
   独立量到的目录条数一致。
3. **刷新轮换后仍驱动同一路径**。`REFRESH WORKS`，轮换后的凭据再打一次目录仍是 200 同条数。

**踩到的坑：刷新响应是另一个信封。** 它与 poll 不同——只有 6 个字段
（`created_at, device_token, expires_at, refresh_token, refresh_token_expires_at, token_type`），
访问令牌叫 **`device_token`** 而不是 `token`，而且**没有 `user_id`**。
`authHeaders()` 把 uid 用在两处（`src/host/upstream/cosy-sign.ts:31` 加密进签名 info 块、
`src/host/upstream/cosy-sign.ts:80` 明文发成 `Cosy-User` 头；拆分前是 `src/host/upstream.ts:279` / `:328`，
见 `docs/issues/22`），所以拿刷新响应**替换**原凭据会签出空 uid →
两区逐字相同地回 `403 {"code":"101","message":"Signature invalid"}`（`7b15f37` 引入，`121805c` 修：
改成叠加，只覆盖非空字段）。**接进 host 时这个坑会原样复现。**

**接入成本低的原因**：设备登录产出与插件**已经在读**的桌面端形状几乎同构——
桌面端 0.3.x 的 `<userData>/auth.v1.dat` 明文是
`{"schemaVersion":1,"token":"dt-…","refreshToken":"drt-…","expiresAt":"<ISO>",
"refreshTokenExpiresAt":"<ISO>","user":{"id","name","email"}}`，
而 `loadNewCredential` 用 `Date.parse(String(record.expiresAt))` 解析——**ISO 字符串是原生支持的形状**。
也就是说上游 / 推理 / 模型目录层一行都不用改，登录半边是纯增量。

## 参考插件的凭据持久化对照

| | 凭据从哪来 | 自己存吗 | 跨设备 |
|---|---|---|---|
| `dsh-connect-workbuddy` | 自有 OAuth 扫码（`src/oauth.ts`）**或**桌面端扫描（`src/auth.ts`），两者并列 | 自有 vault `~/.dsh/workbuddy-vault/{cn,global}/*.json`；可经 `src/transfer.ts` 导出导入 | ✅ |
| `dsh-our-free-model` | 自有登录（`src/eac-user.js`） | `$DSH_HOME/our-free-model/eac-user.json` 存索引，凭据本体靠 `credentialRef` 指向内核凭据库 | ✅ |
| **本插件（现状）** | 桌面端 OSCrypt blob **或** `QODERCN_PAT`/`QODER_PAT` | 不存用户凭据 | ❌ / ⚠️（PAT 可携带，但要用户手造） |

**参考实现不把凭据存成环境变量文件。** 环境变量在那里只是**输入通道**（如发行签名用的
`OFM_MANIFEST_KEY`），从来不是存储。

## vault 形状（照抄参考实现的、已被事故验证过的部分）

**路径**：`$DSH_HOME/.qoder-auth.{region}.json`，按 region 隔离——对得上「三条事实」第 1 条
（双 region 是两根平行的线，切 tab 不得影响另一侧）。本仓库已有先例：`~/.dsh/.qoder-catalog.qoder-cn.json`
与 `~/.dsh/.qoder-catalog.qoder.json` 就是本插件写进 `DSH_HOME` 的自有 JSON。

1. **写**：`mkdirSync(dir, { recursive: true, mode: 0o700 })` → 写 `<file>.<pid>.tmp`
   带 `{ mode: 0o600 }` → `renameSync(tmp, file)`。崩溃不能留下半截 token。
2. **0600 跟着"文件里有没有秘密"走，不无脑加**。参考实现的 `FileStore` 存账号索引就**不设 mode**，
   因为索引里只有 `credentialRef` 而没有凭据本体。我们的 vault 装的是凭据本体，所以必须 0600。
3. **越界红线**：只能碰自己拥有的那个路径（`docs/issues/01`、`02` 换来的教训——sweep 跟随
   junction/symlink 把插件目录外的文件清成 NUL）。
4. **损坏文件另存，不覆盖**：读失败时把坏文件改名为 `<file>.corrupt-<timestamp>`，
   否则下一次 flush 会用默认值盖掉用户设置。
5. **写失败不得静默**：红线 1。参考实现的做法是重新置 `dirty`（否则 dispose 的末次 flush
   会跳过这次没落盘的写）并用一次事故只报一行的守门。我们这里表现为——卡片上要说
   "登录成功了但凭据没能存下来（<原因>）"，而不是显示"已登录"。
6. **严格区分"没登录"与"登录了但读不出来"**：这两句话对用户的下一步动作完全不同
   （前者去登录，后者去查权限/损坏）。`StateDot` / 文案必须分开，红线 1 的同一类问题。
7. **写并发要在 vault 层串行**（见下）。

## 那条竞态教训（参考实现作者自己抓到的真实缺陷，可直接复用）

`vendor/channel-pack/pack.js:29906-29927` 的形态是
`await this.writeAccounts(this.readAccounts().filter(...))`。它只保证了"读→改"这半原子，
而 `store.save()` 是**异步**的，两个写者的 save 可以**乱序完成**——后完成者带着更早的快照
覆盖磁盘：

- 并发 `removeAccount('a')` / `removeAccount('b')` ⇒ 内存 `["keep"]`，磁盘 `["b","keep"]`，
  **已删账号复活**，重启就回来；
- `removeAccount('victim')` 与 `addAccount(added)` 交错 ⇒ **新增账号被静默丢失**。

结论：**不能靠"换个同步后端"绕过**，只能在 vault 那一层把写排队
（`storeChain = Promise.resolve()` 链式串行），让 RMW 整体互斥。

## 验收标准

全部已落地。每条的落点：

- [x] vault 落盘：`$DSH_HOME/.qoder-auth.{region}.json`，`0o600` + temp/rename，两区互不干扰
      —— `src/host/credential-vault.ts`；路径由 `index.ts` 的 `deviceSourceFor(region, ctx)` 按
      `region.id` 拼出，一个 region 一个文件、一个共享实例（两个实例就是两个失败窗口）
- [x] 写并发：并发 RMW 后磁盘状态等于串行结果（照上面两个场景写成测试，先让它红）
      —— `test/credential-vault.test.js` 的 20 个并发 `update` 全部落地，以及
      "先 update 后 clear 则不复活" / "先 clear 后 update 则留新值" 两条（变异验证：把
      `read()` 从 chain 内提到 chain 外，恰好挂那一条）
- [x] 凭据优先级明确，且**桌面端失联不再等于"没登录"**——三个来源各自的"缺失"与
      "存在但读不出来"都要能在卡片上分辨 —— `credential-cache.ts` 的
      `fromApp ?? fromDevice ?? loadEnv()`（桌面端优先：它在场时它就是本机最新鲜的，
      且**任何今天能用的机器上行为一字不变**）；`DeviceCredentialStatus` 五档
      （`none` / `ok` / `expired` / `refresh-failed` / `unreadable`），经账号路由的 `device` 键
      与 `deviceLoginNotice` 到卡片；`absent` 与 `unreadable` 在 vault 层就已分开
      （`readResult()` 的四个 kind）
- [x] 设备登录的刷新是**叠加**而非替换（`user_id` 缺失时保留原 uid；这条照 `121805c` 的测试形状）
      —— `device-login.ts` 的 `mergeRotation`，tripwire 测试断言刷新信封只有实测的 6 个键
- [x] 失败必须发声：登录失败 / 刷新被拒 / vault 写失败，卡片各自显示**具体原因**，不吞
      —— `device.*` 文案里每个带 `{reason}`/`{detail}` 的键；`remember` 落盘失败 reject
      （"登录了但存不下"），`forget` 返 false 走 **500** 而不是欢快的 200
- [x] 断链可恢复：刷新令牌被拒时提示重新登录，而不是静默变回"未登录"
      —— 刷新被拒**保留记录**（它是"本机曾登录过"的证据），状态是 `expired`/`refresh-failed`
      而非 `none`；`retry()` 让重新登录立刻生效
- [x] `probe/qoder-device-login.mjs` 保留为真机复现手段；协议若静默失效，探针能先发现
      —— 两区真机闭环 + `test/probe-imports.test.js` 守它的 import，探针被改单入口构建打烂过
      一次（`a7a08a6`）
- [x] 测试 + `npm run verify` 全绿；`lib/` 与 `src/` **同一次提交**（红线 3）

## 风险（不粉饰）

1. **协议是逆出来的，不是公开 API**。端点与两区 clientId 取自客户端常量与参考实现，
   厂商下个版本可能静默改掉。按仓库规矩要先有探针量它（已有），并且失败时必须让卡片说
   "登录流程坏了"，**不能显示成"你没登录"**（红线 1）。
2. **CN clientId 用错只能靠真实登录闭环抓**。参考实现里明确记录：clientId 不对的表现是
   "授权页 302 正常、点击授权后报参数无效"——入口探测抓不到。
3. **这会改掉「三条事实」第 2 条**。该条现在写"本插件不持有用户密码"；设备登录的令牌是
   插件自己持有的凭据。措辞要从"不持有密码"改成"不持有密码，但会持有自己取得的登录令牌"，
   并写清存哪、什么权限、怎么删。**需要用户明确同意后才动手。**
4. **不照抄 `vendor/channel-pack/`**。它的 NOTICE 声称上游源码一并入库"便于审计与再构建"，
   但实载只有不可读的 2.87 MB `pack.js` + `qoder-auth-wasm.wasm`。本仓库把 `lib/` 当受版本
   管理的产物、用 `verify:bundle` 做字节级比对；抄它等于把这份可审计性换掉。
5. **292 KB WASM 与登录无关**，它服务于加密推理。而本插件早已用原生 JS 解决加密推理
   （`src/host/upstream/crypto.ts:108` `aesEncryptCBCBase64`、`src/host/upstream/cosy-sign.ts:40`
   RSA 包 AES key、`src/host/upstream/sign.ts:13` `signaturePath`；拆分前的行号是
   `upstream.ts:247` / `:287` / `:257`，见 `docs/issues/22`），
   所以不需要它也**不应该**引入它。

## 相关提交

探针与实测：`a7a08a6`（修复被改单入口构建打烂的探针 + 守门 `test/probe-imports.test.js`）、
`43edbd7`（poll body 读取不再截断；截断曾让一枚可用设备令牌泄进 stderr）、
`f6702f1`（撤回"CN 只签发 `refresh_token_id`"——那是截断编出来的）、
`7b15f37`（一次授权量登录 + 目录 + 刷新）、`121805c`（刷新叠加保 uid）、
`a148f73`（`docs/KNOWN_GAPS.md` 记录实测闭环）。

接入：`44877ff`（本文件 + 索引行）、`b413ae1`（`credential-vault.ts`）、
`eba129b`（`device-login.ts` 纯协议层）、`70b64a3`（三源凭据链 + `device-credential.ts`）、
`ce7d4b1`（登录流程 + 四路由 + 卡片可驱动的 host 接线）、
`fce869f`（README 与 `AGENTS.md` 的诚实性修正：三条事实第 2 条改为三种来源），
以及**同一次提交**里的卡片半边：`src/client/device-login-panel.tsx`（新）+ `device.*` 文案 +
`card-model.ts` 的 `deviceLoginNotice` / `deviceLoginHasToken` + `http.ts` 开始读 `writeError`
的 `error.message`（否则每道 `writeError` 拒绝都退化成一句没有下文的 `HTTP 500`）。
