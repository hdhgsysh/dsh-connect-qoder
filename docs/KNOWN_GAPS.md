# 已知覆盖缺口

> **想找"某个现象是已知问题还是新 bug"？** 先去
> [`howto/symptom-triage.md`](howto/symptom-triage.md)——那份按界面原文排，
> 会直接告诉你该看本篇的哪一节，还是去看 issue NN。

这份文件登记**明确知道没有测试保护**的地方。每条都写清「为什么现在没有」和
「要补上它需要先做什么」，这样缺口是待办，不是旁白。

新增测试时请顺手更新本文件；删掉一条时请在提交信息里说明它为什么不再成立。

**最近一次复核**（P2-1 把七条路由 handler 抽进 `src/host/handlers.ts` 之后）：第 1 条是
接线缺口，等 `--experimental-test-module-mocks`；**第 2 条已大幅收窄**——路由 handler 主体现在是
可执行模块，`test/handlers.test.js` 以假 req/res 直接跑每条 handler（方法/来源/错误码都是真断言，
不再是源码文本），`test/account-route-wiring.test.js` 一类文本守门随之退为只锁 `index.ts` 的委托边界；
第 2 条**余下**的只是 `index.ts` 里的路由注册接线、`ctx.effect` dispose 时序、`registerAdapter`
失败回滚——这些仍因顶层 peer import 不能进测试。第 3 条的根治已落地
（见下），镜像本身是刻意接受的；第 4 条原理不可测；第 5 条是写了也测不到的等价路径；第 6 条是功能
未实现（跨平台凭据链），不是测试缺口；第 7 条登记仓库级缺失，其中**文档漂移**一项已由
`test/docs-facts.test.js` 建立门禁；第 8 条登记国际版 campaigns 端点的 umid 机器身份门控
（2026-09-27 实测 + 修复已落地，见下）。

**0.5.0 砍 ABI（2026-10-03）**：宿主 0.2.0-rc.2 实测已无 `installSection` / `settingsScope`，
双线探测与 `asVolatile` 退化随之删除（ADR 见
`docs/history/0.5.0-abi-cutover.md`）。本文件登记的缺口均不引用被删的旧 ABI 面，
条目不受影响；第 7 条的覆盖率基线已按砍后的源码重测。

**本轮（2026-10-03，chat 分诊 + umid 枚举）**：「仍未分诊的上游端点」段改写——
chat 端点已分诊（`streamChat` 的 content-type + 不可读帧判定，`test/chat-protocol-drift.test.js`
守门），剩余项收窄为 `fetchUsage` / `readCampaigns` / `fetchUserInfo`；第 8 条
`umidRootsFor` 的写死版本路径改为运行时枚举（`test/umid-roots.test.js` 守门），
并新增「签到降级用户可见性」残留项（host warn 已落地，卡片半边欠着）。

**本轮（2026-10-17，设备登录修复轮）**：`credential-vault` 的串行 RMW 链只约束**同进程**
的写者。跨进程（web 与 desktop 两个 profile 同时激活本插件、同一 `DSH_HOME` 下的同一个
`.qoder-auth.<region>.json`）没有文件锁：两边的读-改-写可以交错，各自刷新出的令牌会互相
覆盖最后一个赢。0600 原子写保证**文件永远是完整可解析的**，不保证**语义不打架**；
链外刷新的「登出优先」「不覆盖他人记录」守卫（`displaced`/`superseded`）只看得见本进程
链内的对手。登记为缺口不是因为漏了测试，而是这条路径要先有一个双宿主 harness 才谈得上
端到端验证；单进程侧的所有分支（复活被拒、他人记录保留、save-failed 内存续命、陈旧 .tmp
回收）本轮已由 `test/device-credential.test.js` 与 `test/credential-vault.test.js` 新用例守住。

**本轮新增的两处镜像**（跟着 issue 04/05/10 一起进来，是刻意接受而非遗漏）：
`test/model-route.test.js` 直接 import `buildModelRowsPayload`，断言的是**真实的**实现，
不是副本；`test/protocol-shape-card.test.js` 则从**产物文本里提取** `refreshNoticeKey` 并执行，
所以它守的是发货的那份代码（手法与 `test/client-bundle.test.js` 相同）。两者都不需要"改一处
必须同步改另一处"的人工纪律——这是与第 3 条那两处镜像的本质区别。

**chat 端点分诊已落地（2026-10-03，本轮）**：`streamChat` 补了 chat 侧的
协议形状分诊——200 路径先查 content-type（`json|html|xml` 即漂移，SSE 头缺失
或 event-stream 不误伤），帧路径把「整条流没有任何一帧可读」（envelope 解析
失败 / 内层 body 解析失败 / 非 chunk 非已知失败的 JSON 帧）判为
`ProtocolShapeChangedError` 并保留第一帧原文作证据；零数据帧的「空应答」仍走
原来的 `empty response` 错误，两种形态分开。判定不进队列预算（`retryable:
false`），shim 按 502 + 完整消息回给 agent，「插件需要更新」不再静默。守门在
`test/chat-protocol-drift.test.js`。

**上游端点形状分诊已全部落地（2026-10-17，issue 10 残留收尾）**：`fetchUsage` /
`readCampaigns` / `fetchUserInfo` 三个端点补了信封形状分诊——`readUsageShape` /
`readCampaignsShape` / `readUserInfoShape`（`src/host/upstream/fetch-usage.ts` /
`api-calls.ts`）在 200 应答「顶层不是对象 / 包装层换了名字 / 非空正文里一个已知字段
都没有」时抛 `ProtocolShapeChangedError`；`{}` 这类空正文仍按「无可展示数据」处理，
不误报。`/usage` 路由回 `unavailableReason: 'protocol-shape-changed'`（普通失败是
`read-failed`），`/account/confirm` 回 `kind: 'protocol-shape-changed'` 且**不**清凭据
（重新登录治不了形状变化）；campaigns 半边在快照上带 `campaignsShapeChanged`，配额
不受牵连。卡片对应文案统一指向「更新插件（重新登录没有用）」，守门在
`test/usage-campaigns-error.test.js`、`test/handlers.test.js`、`test/card-dom.test.js`、
`test/protocol-shape-card.test.js`。仍欠的是 issue 10 的周期性心跳探测（仍不单做：模型
目录每 30 分钟刷新一次，每轮都在做形状分诊，已有等价的证据面）。

**契约回放 fixture（2026-10-18，本轮新增）**：上面的形状分诊是**运行时**的——网关
已经变了才会说话；仓库里此前没有任何东西把「某一天的真实应答」冻结下来。`test/` 里
每份漂移测试都拿手写内联样本，只能证明 shape reader 与自己一致：把 reader 顺手收紧或
放宽，它们全绿，漂移信号就没了。本轮补的是**快照**——`probe/capture-fixtures.mjs`
用真实凭据抓四个只读端点（模型目录 / usage / campaigns / userinfo；chat 端点不抓，
它花真实额度，与 `verify-live.mjs` 同一条纪律），每个 body 先过生产在用的同一个
shape reader（拒了就是活漂移，照样落盘但明确标注），再 scrubbing 掉个人身份字段
（`<redacted>`），写到 `test/fixtures/<region>.<kind>.json`。`test/contract-replay.test.js`
在 CI 里无凭据重放：reader 拒真实 wire → 红（要么网关变了该刷新 fixture，要么
reader 被收紧该修 reader）；fixture 缺失 → 红（`EXPECTED_FIXTURES` 逐个点名，
删掉任意一个都红，不只是整个目录清空）；fixture 里字符串值出现 32+ 位 `[\w-]`
的 token 形串 → 红（对**每个** fixture 都查，不只 userinfo；匹配的是值位置而非
JSON key，因为 COSY 自己就有 `dedicated_resource_packages`、`c-daily-checkin-*`
这类长串字段）。capture 脚本另有一道**精确**守卫：写盘前比较 body 是否包含
credential 自身的字段（token / userID / name / email），命中即拒写——那是
启发式猜不出的，只有持凭据的一方抓得到。capture 脚本
在无凭据时不写任何文件、已提交的 fixture 不受影响，也不会谎称「重放套件会
跳过」——若 fixture 真缺，重放套件会红，这正是它该做的。
种子 fixture 由实测 shape 派生（`probe/model-shape.mjs` + issue 04），模型名与额度是
占位不是实时抓取，`_meta.note` 里写清了；有登录态的真机上跑 capture 脚本即可换成
真快照。变异实测：`chat` 改名 `models`、userinfo 丢身份字段、catalog 的
`max_input_tokens` 变成字符串均被红；usage 有一个
**已知**残留——`readUsageShape` 认「任意已知字段」，而 `display_mode` 是包装层自己的
字段，所以网关若只把内层 quota 包装改名、外层 `display_mode` 还在，reader 会放行然后
读到空，渲染成「无用量」；重放套件为此断言 usage fixture 的内层 body 必须至少带一个
quota 字段，让那种捕获在 fixture 校验层就红，而不是靠运行时撞一次。


**凭据 sweep 的身份守卫（issue 01）**：`sweepStaleOscryptDirs` 现在要求
`lstat` 判真目录 + `.dsh-oscrypt` 标记文件 + `key.b64` 恰好解出 32 字节，
三道闸全部由 `test/credential-cleanup.test.js` 的新用例守着，且两道守卫各自
独立经手工变异验证承重（改回 `statSync` → junction 用例红；删 marker 检查 →
4 条红）。sweep 与 `zeroOutFile` 里剩下的手工"实测全绿"条目不变。

**第 3 条的根治已经落地**：卡片此前只由手抄副本守着，实测**抓不住任何东西**——
从 `lib/client.js` 删掉那行 `promo.active !== true`（正是阻止卡片显示拿不到的折扣价
的那一行），`model-row.test.js` 依然 9 pass / 0 fail。现已增加
`test/client-bundle.test.js`，直接从产物文本里提取 `offPeakState` 及其依赖并执行，
同一个变异会让它 3 条变红。此后 `src/client/*.ts` 已还原入库（issue 17，
`121d1a3`），产物由 `npm run verify` 保证可由源码逐字节重建——剩下的缺口见第 3 条本身。

---

## 1. `adapter.ts` 的 Cordis 接线与 profile 构造

**位置**：`src/host/adapter.ts`

**为什么没测**：模块顶层 import `@earendil-works/pi-ai` 与
`@deepseek-ai/dsh-llm-pi-ai`，本仓库不安装 peer 依赖。

**这句话曾经是全貌，现在不是了**（2026-10 实测更正）：在一台装了 DSH runtime 的机器上
（本插件的开发机即是——宿主把 `@deepseek-ai/*` 与 `@earendil-works/pi-ai` 以链接的形式
放进本目录的 `node_modules/`），`src/host/index.ts` 的顶层 import 是能解析的，
`adapter.ts` 随它一起进入了覆盖率分母：实测 `adapter.ts` 为 60.68 行 / 100.00 分支 /
0.00 函数（未覆盖 98、101、108、183-295，即 `createQoderAdapter` 组装 profile 的那段
接线与它构造的 `PiAiAdapter`）。也就是说，**这一条里"没有可断言的纯逻辑"的那部分，
现在已经进了分母**，只是它跑出来的形状是"接线被执行过"，不是"接线是对的"。
在没装 runtime 的机器（CI runner）上它仍然进不去，原因见第 2 条末尾的算术。

**已经测到哪一步**：`toPiModel` 原先住在这里，是整个插件最关键也最无防护的函数——
它那行 `compat: { supportsDeveloperRole: false }` 决定了每个请求会不会被 403
`10605` 拒绝。`maxTokens` 这条的教训翻转了一次：旧决策是「故意不声明」，但
不声明不等于无上限——peer 的 `resolveEntry` 走 `entry.maxTokens ?? base?.maxTokens ?? request.defaultMaxTokens`
兜到 32768，长推理回复全被掐在 32K；2026-10-02 翻转为钉住实测平台上限
`PROBED_MAX_TOKENS`（65536，平台 400 原文「max_tokens 不能超过 65536」），
测试从「断言不存在」改为「断言值」，将来谁删掉它都会判红。两处此前都只有
注释守着。现已抽出到 `src/host/pi-model.ts`
（纯函数、不碰任何 pi-ai API）并由 `test/pi-model.test.js` 覆盖；
它消费的 `rateNow` / `offPeakActive` / `offPeakRemaining` 早前已移到
`src/host/offpeak.ts` 并被完整覆盖。

**剩下的是什么**：`createQoderAdapter` 组装 `PiAiAdapter` profile 的那部分——provider
注册、inert 认证平面、`PiAiAdapter` 的构造。这部分是接线，没有可断言的纯逻辑，
留在原地是因为抽它出来只会造出一个只被调用一次的间接层。**它做的模型列表已经抽出**：
`buildModelsFor` 现在住在 `src/host/adapter-models.ts`（区域开关、勾选过滤、最大上下文、
逐模型图像模式）并由 `test/adapter-models.test.js` 覆盖。

**曾经登记为"可行"的方案，实测不可行**：`node --experimental-test-module-mocks` 桩掉
pi-ai 与 `@deepseek-ai/*`。本机实测**两种做法都失败**，原因写在这里以免下一次再走一遍：
（1）`mock.module()` 要求被桩的 specifier **先能解析**——而这些包恰恰不安装；
（2）自定义 resolve hook 也够不着，因为 `src/host/index.ts` 在模块顶层**静态** import
`adapter.ts`，那条解析发生在 hook 链看到它之前。flag 本身在 Node 24.16 上可用，
但对本仓库的用途无效。因此走的是另一条路：把有决策的部分抽成无 peer 依赖的模块
（`adapter-models.ts` / `region-gate.ts` / `routes.ts`），接线留在原地。

---

## 2. `RegionRuntime` 本身与 `activate` 的 Cordis 接线

**位置**：`src/host/index.ts`（约 1300 行）

**为什么没测**：模块顶层 import 四个 `@deepseek-ai/*` peer 包，本仓库不安装。

**这句话曾经是全貌，现在不是了**（2026-10 实测更正）：在一台装了 DSH runtime 的机器上
（本插件的开发机即是——宿主把 `@deepseek-ai/*` 以链接的形式放进本目录的 `node_modules/`），
`index.ts` 的顶层 import 是能解析的，因此它**已经进了覆盖率分母**：
`test/activation.test.js` 直接 `import('../src/host/index.ts')`，用假 Cordis 上下文执行
`apply()`，实测 `index.ts` 为 76.70 行 / 64.00 分支 / 34.15 函数。
该文件执行的是**真激活**：十二条卡片路由全部挂上、dispose 全部释放、零区域时每个区
都说明自己为什么没上线、`GET /account` 与 `GET /status` 经挂载后的 handler 真的应答。
在没装 runtime 的机器（CI runner）上它进不去，原因不是技术性的，是算术——见本条末尾。

**已经测到哪一步**：这个文件里所有**纯逻辑**都已经搬出去了——
凭据缓存（`src/host/credential-cache.ts`）、目录落盘（`src/host/catalog-store.ts`）、
设置写入与读回（`src/host/settings-save.ts`）、行投影与过滤（`src/host/catalog-entry.ts`）、
刷新结果落地（`src/host/catalog-refresh.ts`）、能否上线一个区域（`src/host/region-gate.ts`）、
**每条路由共用的两道闸与 body 读取器**（`src/host/routes.ts`：方法检查含 `Allow` 与
`HEAD`、回环来源检查、64 KiB 上限），以及**七条路由的 handler 本体**
（`src/host/handlers.ts`，`(req, res, deps) => Promise<void>` 形态，P2-1）。`test/handlers.test.js`
以假 req/res 直接执行每条 handler——方法闸 405、同源闸 403（含同 host 不同端口）、未知区 404、
缺 settings 服务 503、坏 body 400/500、签到 200/502、confirm 的 sign-in-expired 归名并失效缓存
全部是可执行断言，不再是文本守门。claim / confirm 的上游网络调用给了注入接缝（默认仍走真实现），
confirm 读取停摆区凭据的那条接缝同理——它原先调的是**同步**解包，会在路由里把整个插件的
事件循环冻住（`docs/issues/07` 修的就是这件事，此处是它的收尾），现改走 `loadCredentialAsync`，
并由一条结构断言钉住「路由里不得出现同步解包」（注入 reader 的行为测试分不出同步异步，故结构守门）。

**已知的一处覆盖代价**：`confirmHandler` 里默认 reader 那个箭头函数（`deps.readCredential` 缺省时
才走的那一行）没有函数覆盖——三个用例都注入了 reader，而让它真跑会去读**本机**应用目录，
套件从不真解包。要覆盖它得把 `appDataRootFor` 的 env 透传成第三个接缝，代价大于收益；
`handlers.ts` 函数覆盖因此是 93.33% 而非 100%（整体 86.11%，远高于地板 66）。

**provider 注册的回滚判定**（`src/host/publish-regions.ts`）：发布区域集给宿主的两个调用
（`registerAdapter` / `registerConfigurableProviders`）与失败时的三层回滚原本是 `activate()`
里的内联闭包，包着十一个可变绑定，所以它此前**没有任何可执行测试**——只有
`test/account-route-wiring.test.js` 一条正则确认零区域早退还在。回滚恰恰是出事的地方：
重载会重新发布整个区域集，而新注册开始时旧的一对**已经释放**，失败不回滚就等于插件
悄悄什么都不再提供、且用户看不到任何错误。现已按 `handlers.ts` 同样的手法抽出，两处宿主
调用改为注入，`test/publish-regions.test.js` 13 例钉住每个终态（干净发布 / 失败后装回
旧的一对 / 无旧的对则如实留空 / 设置行失败时释放半注册的 adapter / 回滚中途再次失败时
释放它自己刚装上的那个 / 宿主不返回 release 时不当成故障 / 旧 release 抛错仍继续并
上报）。抽取过程本身查出**两个真 bug**：半注册的 adapter 会残留无人能释放；回滚中途
失败会丢弃刚注册成功的 adapter 的句柄。两者都已修并各有变异验证（去掉即红）。

**剩下的风险**（2026-10 实测更正）：`ctx.inject(['webServer'])` 里的路由**注册**接线
**已经不再是风险**——`test/activation.test.js` 用假 webServer 记录每一次 `register()`，
断言十二条路由**都挂上了**（零区域也挂）、**没有重复路径**、dispose 之后**全部释放**，
并把挂上去的 handler 真的调用了一遍（`GET /account` 200 且带两个区、`GET /status` 报
`startedRegions === 0`）。仍未测的是两处：`ctx.effect` 的 dispose 时序（定时器与在途
`refreshCatalog` 的竞态）；`registerAdapter` 失败时的回滚是否真的释放了 shim 端口
（回滚的**判定**已由 `publish-regions.ts` 覆盖，**端口**没有）。
（handler 主体已不再是风险——见上。）

**一处刚补上、但只有一半有测试的守卫**（2026-10）：`readUsage` 的用法读缓存此前会在
**签到成功后回退**——`invalidateUsage()` 只清 `usage`/`usageAt`，对**已经在飞**的那次读
毫无作用，而 `doReadUsage` 落定时无条件用 `Date.now()` 重新盖章，于是签到前的旧余额被
盖成"刚读过"，钉住整个 `USAGE_TTL_MS`（20 秒）；叠加 `usageFlight` 会吞掉 joiner 的实参，
签到后那次 `readUsage(true)` 直接 join 到这次注定作废的读上（`docs/PLAN.md` 里"领取后作废
重读"的意图因此没有兑现）。现在拆成两半修：

- **可测的一半**：`createSingleFlight` 增加 `reset()`（`src/host/single-flight.ts`），
  放弃在飞槽位但不取消在飞的那次运行——它仍会把结果交给已经在等的调用方，只是不再占槽位。
  四条断言在 `test/single-flight.test.js`（新起一次运行 / 被放弃的运行仍答复原等待者 /
  **被放弃运行的清理不得驱逐替换它的新运行** / 空槽 reset 是 no-op）。
- **不可测的一半**：`RegionRuntime.usageGeneration` 的换代守卫，以及
  `invalidateUsage()` 里"换代 + 清缓存 + reset 槽位"三件事的顺序。**它仍然没有可执行
  断言**——原因换了一个：不再是"`index.ts` 顶层 import peer 包所以进不去"（那条已经不准，
  见本条开头），而是 `RegionRuntime` 本身没有导出，`activate()` 又把它关在词法作用域里，
  测试拿不到这个类。要真进分母，得先把它抽成一个纯模块（与 `single-flight.ts`、
  `region-gate.ts` 同样的手法），那是下一步而不是现状。**别把它当成已测**：行为验证至今
  靠上面那半加一次人工推演。

**要补上需要**：注册与 dispose 已经进了分母（`test/activation.test.js`，见上）；
剩下的是**回滚是否真的释放了 shim 端口**，以及 `RegionRuntime` 那半个守卫。
两者要真进 CI 的分母，靠的不是 module-mocks（那条路经实测是错的，见第 1 条），
而是**把 peer 依赖从被测文件里摘出去**：抽成不 import `@deepseek-ai/*` 的纯模块，
它们在**任何**机器上都能被 import，因而在 CI 的覆盖率里也占分母。
**为什么现在不能直接把 `index.ts` 挂进 CI 的分母**：算术，不是技术。
CI 的实测覆盖率是 90.27 / 82.27 / 86.35，**分支距地板（82）只剩 0.27pp**；
`index.ts` 的分支覆盖是 64.00，把它加进分母会把全局分支数拖到地板以下，让 CI 变红。
换句话说，第 7 条那句"新增分支多的文件前先想好它的测试"在这里是硬约束：
**要么先把 `index.ts` 的分支覆盖拉到 82 以上，要么先把它拆成不带 peer 的纯模块**。
在那之前，本仓库在装了 DSH runtime 的机器上（开发机即是）已经把 `index.ts` 拉进了分母，
在 CI 上它**大声跳过**（跳过理由里点名缺哪个 specifier），而不是静默通过。

---

## 3. 客户端卡片的门控表达式

**状态**：**一真镜像 + 两层真门禁**。随 `card-model.ts` 抽离，原"两处刻意接受的镜像"
已经收缩成**一处**——下面第 1 点；第 2 点（错峰门控）现在 import 的是**真实规则**，
不再是手抄副本。

1. `test/model-row.test.js` 的 `cardInstallsClock` 仍复刻卡片 bundle 里的
   `models.some((m) => m.promotion?.active === true)`。这条**抽不出来**：它住在
   `QoderPluginCard` 的 hook 里、与"决定是否装每秒时钟"的 React 状态绑定，属于 JSX
   装配层而非纯函数，本仓库不为卡片引入 jsdom，所以只能镜像。它的语义是"装时钟的
   前置条件"，与 host 端 `isOffPeakActive` 不在同一处、不重算，故需要这一份独立断言。
2. 同文件的 `cardRendersOffPeak` 与 `card-host-parity.test.js` 的 `cardWindowLabelOf`
   **现已改为对真实规则的薄封装**：二者都 `import { offPeakState }` / `{ windowLabelOf }`
   自 `src/client/card-model.ts` 并直接转调，不再手抄任何判定或窗口算术。这消掉了
   这条原本最危险的镜像——它曾精确复刻 `offPeakState` 的守卫加窗口算术，原实现改坏时
   副本照样绿。

**两层真门禁（与上面第 1 点的"仅镜像"相对）**：

- `test/client-bundle.test.js` 从**产物文本**里提取 `offPeakState` 及其依赖并执行，
  卡片侧改坏会当场变红；这正是 issue 03（16 字节桩替换整卡）之后立的闸门，不能撤。
- `test/protocol-shape-card.test.js` 从产物文本提取 `refreshNoticeKey` 并执行，守的是
  发货的那份刷新裁决代码。

也就是说"只能靠人工纪律维持"的镜像已经只剩 `cardInstallsClock` 一处（`offPeakState` /
`windowLabelOf` 的断言对象已是真函数，副本漂移不再可能；产物层另由上面两道闸门兜底）。

**为什么 `card-model.ts` 能 import 而卡片整体不能**：浏览器无关决策层（`offPeakState` /
`rateAt` / `windowLabelOf` / `refreshNoticeKey` / 格式化工具 + 视图模型类型词汇）已搬出
React 装配层，模块**无 React、无 DOM、无 fetch**——这正是向 `dsh-connect-sensenova-token-plan`
的 `snapshot.ts` 对齐的那一刀（sensenova 把快照决策逻辑抬进 Node 可 import 的纯模块）。
卡片整体仍是浏览器 bundle（取 `window.__ModuleLoader__` 与 `react`），不可装进 Node 测试；
但凡能脱离 JSX 状态的纯规则都应落进 `card-model.ts`，从而可被直接 import 而非从产物
文本里抠。新增客户端判定逻辑前先问一句"它碰 DOM/React 状态吗"：不碰就进 `card-model.ts`，
碰（如 `cardInstallsClock`）才留在卡片、以镜像守。

**本轮去掉的唯一真分歧**（issue 09）：`windowLabelOf` 曾与宿主的 `contextWindowIsReal`
在"`contextOptions` 非空但 `defaultContextWindow === 0`"上给出不同答案，卡片显示 `200K`
而选择器不显示。卡片现在读宿主算好的 `contextWindowLabel`，只保留宿主无法表达的"逐行切到
最宽窗口"；`test/card-host-parity.test.js` 逐状态对拍，并断言产物里不再有第二份窗口算术。

**已经因此漏掉过一次**（这段事故史保留，它是本条存在的理由）：`offPeakState` 原先只看窗口
字段、不看 `promotion.active`，于是 Qoder 已下线但仍保留窗口字段的促销被按**折扣价**渲染
——用户看到一个自己并不被收取的价格，而同一目录条目在模型选择器里经 `rateNow` 算出的却是
`before` 价，两个界面自相矛盾。触发条件是目录里同时存在两种状态的模型：只要有任一模型
`active === true`，每秒时钟就会装上，此后**所有**行都走这条门控。修复是给 `offPeakState`
补上 `promo.active !== true` 的守卫（`lib/client.js`），并由 `cardRendersOffPeak`（当时是副本，
现已是真实规则的封装）与 host 端逐状态对拍。已用变异验证：抽掉守卫，`model-row.test.js`
3 条变红（如今这 3 条断言的是真 `offPeakState`）。

这与本仓库其他测试曾犯的错是同一类（手抄副本），区别是现在这一类镜像只剩 `cardInstallsClock`
一处，且 `offPeakState` / `windowLabelOf` 的覆盖对象已是可 import 的真函数，漂移在结构上不再可能。

**容器拆分与位置门禁（本轮新增）**：`card.tsx` 已从单一 ~1800 行的容器拆成 sensenova
风格的「装配层 + 小容器 + fetch 收口」三层——`card.tsx` 只留 `QoderPluginCard` 装配件与三个
无 hook 纯展示件（`RegionUsage` / `CheckinCard` / `QuotaBlock`）；`QoderUsagePanel` 搬入
`usage-panel.tsx`、`QoderAccountPanel` 搬入 `account-panel.tsx`，各自持有自己的 fetch 与
effect；六道宿主路由 fetch（名册 / 账号读 / 账号重读 / 账号确认 / 用量读 / 签到领）全部收口到
`http.ts` 的 `getJson` / `postJson`（失败统一带宿主 `error` 字段，避免「假 undefined 失败」；
名册读原先是装配层里唯一一道裸 `fetch`，已并入 `getJson`，settings 的 `__save` 写属于
`settings-write.ts` 的读回校验管线，不在此收口之列）。`describeThrown`（卡片 catch 块给用户看的
失败文案窄化）随拆层从 `card.tsx` 挪进 `card-model.ts`：它本就不碰 React/DOM，而容器反向伸手进
装配层取它会把 `card.tsx` ↔ `account-panel.tsx`、`card.tsx` ↔ `usage-panel.tsx` 两条循环 import
闭环——现在容器只 import 浏览器无关的 `card-model.ts`，环解开。拆分后行为零回退由两道**位置门禁**
守：`test/card-position.test.js` 对 `lib/client.js` 实渲染、断言卡片主体按「账号条 → 用量面板 → 模型
列表」固定顺序自上而下（区域条是整段 body 的表头，顺序错即语义错）；`test/registration-consistency.test.js`
断言 README 目录表列出的 `src/client` 文件集合与磁盘**完全一致**（双向，既不漏列也不残留已删文件的行）。
两道门禁都读真实产物/真实目录，不依赖手抄副本。

---

## 4. 协议层的两个原理盲区

**位置**：`src/host/upstream/cosy-sign.ts` 的 `authHeaders`（拆分前在 `src/host/upstream.ts`，见 `docs/issues/22`）

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

### 5c. `preferences.js` 的 `Object.hasOwn` 守卫

`enabledIdsFor` / `imageModeFor` 用 `Object.hasOwn` 拒绝原型链上的键。但
`Object.prototype` 上的值是函数或对象，`Array.isArray` 和模式白名单本来就拒绝它们，
所以删掉 `hasOwn` 之后行为完全相同。实测：删掉两处 `hasOwn`，
`preferences.test.js` 全绿。

保留它是因为这个保证不该依赖 `Object.prototype` 的当前内容——某些 polyfill 会往
`Object.prototype` 上加属性，那时过滤规则就可能放行。这是防御性加固，不是可观测行为。

---

## 6. 跨平台凭据链未实现（macOS / Linux）

**状态**：**第 2 项（app-data 根目录）已修**，**第 5 项（失败原因说清方向）已修**，
其余仍缺。修了它们不是为了"支持 macOS"，而是为了让 macOS 上的失败变得**诚实**：
此前探测 `process.env.APPDATA`（该变量在 macOS 上不存在）→ 得到 `''` → 报告"没登录"，
而用户明明登录了。现在 `appDataRootFor()` 解析到 `~/Library/Application Support`（macOS）
与 `$XDG_CONFIG_HOME`/`~/.config`（Linux），应用目录**找得到**了。解包本身仍只有 Windows 一条链。

**第 5 项（2026-10-03 补）**：解包是 PowerShell + DPAPI，在 macOS/Linux 上**没有可执行的东西**。
原先代码不管平台就往下走，于是 `systemPowershell()` 拼出的
`C:\Windows\System32\...\powershell.exe` 被 spawn 失败，报出来的 exec 错误就是账号面板显示的
`detail`——在一台 Mac 上显示一条 Windows 路径，解释不了任何事。更糟的是：应用**真的**没登录时
同一条路径报 `no Local State file`，两种答案最后都汇成卡片那句"请确认本机有已登录的
Qoder 客户端"——对着一个已经装了并登录了的用户。现在：

- `runUnwrap` 在创建临时目录与 spawn **之前**先判平台（`options.platform` 可注入，
  与 `appDataRootFor(platform = process.platform, …)` 同一手法，理由是让非 Windows 分支
  在 Windows 测试机上可测），非 Windows 直接记一条点名的原因并返回。于是 macOS 上省掉了
  每次请求的建目录开销，也不会留下一个自己读不了的手递文件。
- 卡片文案 `account.readFail` 改口：不再说"请确认本机有已登录的 Qoder 客户端"（对 macOS
  用户是**错的**建议），改为指向**在哪个平台都成立**的兜底——环境变量 PAT
  （`QODERCN_PAT` / `QODER_PAT`）或点「重新读取登录状态」。
  **2026-10-20 追加**：这条兜底又分成两个 key。宿主上报了插件自有凭据（`device`）时，
  卡片用 `account.readFailDevice`，**先指「浏览器登录」**——那是唯一在所有平台都成立的
  入口（不读桌面端任何东西，装不装客户端都行），PAT 退到第二；宿主没上报 `device`
  （旧版宿主）时卡片上根本没有那个按钮，仍用旧的 `account.readFail`（只指 PAT），
  免得指向一个不存在的按钮。

`async-unwrap.test.js` 新增四条（含"非 Windows 不建手递目录"、"win32 不得被这条守卫拒绝"），
均已变异验证。**注意**：这只改好了**说法**，第 1 项的 keystore 仍缺——macOS 上这仍是
"读不到"，只是现在说得对。

**设备登录闭环已实测（2026-10-17，两区各一次真机授权）**：上面第 1 项（OS keystore）**不是唯一的
出路**——Qoder 自己有设备登录（浏览器授权 + PKCE），走通后拿到的凭据与桌面端 `auth.v1.dat` 里
那份同构，因此完全不必碰 keystore。[`../probe/qoder-device-login.mjs`](../probe/qoder-device-login.mjs)
把三件事在**一次授权**里量完，两区结果：

- **登录闭环成立**：poll 拿到凭据（CN uid `019ec931-…`，国际 uid `019f7d80-…`）。
- **凭据驱动本插件自己的网关路径**：即探针直接调 `authHeaders()` + `modelListUrl()` 打模型目录，
  CN `HTTP 200, chat=14`、国际 `HTTP 200, chat=17`。
- **刷新轮换后仍驱动同一路径**：CN 与国际均 `REFRESH WORKS`，条数与刷新前一致。

两区的 `client_id` 都经**真实授权**验证（`732aef47-…` 对 `qoder.cn`，`e883ade2-…` 对 `qoder.com`），
这正是 pack.js 那条警告（clientId 用错时"授权页 302 正常、点授权后报参数无效"）唯一能证伪的方式；
两区 `access_token` 均 27 字符、`refresh_token` 均 28 字符，`chat` 条数与
[`machineos-probe.mjs`](../probe/machineos-probe.mjs) / [`model-shape.mjs`](../probe/model-shape.mjs)
量到的目录条数逐一吻合。

**实测出来的一个坑（接进 host 前必须带上）**：刷新响应与 poll 响应是**两个不同的信封**。poll 是 14 个
字段；刷新只有 `created_at, device_token, expires_at, refresh_token, refresh_token_expires_at,
token_type` 6 个，访问令牌在 `device_token` 而不是 `token`，而且**没有 `user_id`**。所以轮换必须
**叠加**在旧凭据上、不能替换：`authHeaders` 把 uid 同时放进加密的签名 info 块
（`src/host/upstream/cosy-sign.ts:31`）与明文的 `Cosy-User` 头（`:80`），替换会让 uid 变空，网关两区一致地回
`403 {"code":"101","message":"Signature invalid"}`。这个坑是**实测抓到的、不是推断**
（`7b15f37` 引入刷新阶段 → 两区各自 403 → `121805c` 改为叠加并加守门测试）。

**且这条替代路已经接进 host 了**（2026-10-17，用户明确同意后动手）。三源优先级是
**桌面端 → 插件自有设备登录 → 环境变量 PAT**（`credential-cache.ts`）——桌面端排第一是因为它
在场时它就是本机最新鲜的凭据，而且这个顺序让**任何今天能用的机器行为一字不变**，这才是
"可以安全发出去"的依据。**2026-10-20 补一条**：桌面端那条**过期之后就不再压住后两条**了
（过期的 access token 什么都干不了，而这个版本连 provider 都不会被注册；设备登录那一份
是插件唯一能自己续期的凭据）。原来的 `fromApp ?? fromDevice ?? loadEnv()` 读起来像"桌面端
永远第一"，实现是"`fromApp` **没过期**才算数，否则往下一条找，三条都没有才把那条过期的
桌面端登录作为事实报出去"。令牌存
`$DSH_HOME/.qoder-auth.<region>.json`（`0600` + temp/rename、按 region 分文件、RMW 在 vault 层
串行），面板上的「浏览器登录」/「退出插件登录」走四条 `device-login/*` 路由，登录流程按区域
一次一个尝试、PKCE verifier 只留宿主内存。这改掉了 AGENTS.md「三条事实」第 2 条的前提
（本插件不再"不持有用户凭据"），该条已同步改写。落地过程与八条验收见
[`issues/21-device-login-credential-source.md`](issues/21-device-login-credential-source.md)。

**余下的仍未解决**：协议是从客户端常量逆出来的非公开 API，厂商改版可能静默失效——探针
（[`../probe/qoder-device-login.mjs`](../probe/qoder-device-login.mjs)）是唯一的先行发现手段，
而卡片在失败时会说"登录流程坏了/续期被拒：<原因>"而不是"你没登录"（红线 1）；设备登录这条
路径本身**只在 Windows 上真机跑过**，macOS / Linux 的实机验证仍属下面第 4 项。

**位置**：`src/host/oscrypt-unwrap.ts`（OS keystore 封装、`runUnwrap` 平台守卫；2026-10-20
从 `src/host/credentials.ts` 拆出——这条链是唯一会把密文写到进程外、唯一 spawn 子进程、
唯一删东西的一半）、
`src/client/copy-account.ts`（`account.readFail` 文案）、`src/host/account-state.ts`（`appDataRoot` 注入）、
`src/host/upstream/client-constants.ts`（`MACHINE_OS` darwin 回落）

**为什么剩下的还没有**：

1. **OS keystore 封装**：Windows 走 PowerShell + DPAPI（`Crypt32.dll`），macOS 需 Keychain
   （`security`，Chromium Safe Storage service 名），Linux 需 libsecret（`secret-tool`）
   或 Chromium 在 Linux 上 `peanuts` 硬编码 key 兜底。
   **且 macOS 的 key 不是直接取用**：Chromium 在 macOS 上对 `encrypted_key` 还要做
   PBKDF2-HMAC-SHA1 派生（"peanuts" 常量 + 1003 次迭代），这与 Windows 的 DPAPI 直解是
   两种算法，不是换个命令那么简单。
3. **`MACHINE_OS` 的 darwin 档已补**（实测网关对 `x86_64_darwin` / `aarch64_darwin` 一律 200
   且数据一致，见 [`../probe/machineos-probe.mjs`](../probe/machineos-probe.mjs)）。
4. **跨平台 CI 与实机验证**：GitHub Actions 的 macos / ubuntu runner 可以编译并跑单测，但
   Keychain 弹窗、签名打包、`secret-tool` 的 D-Bus session 都得在实机或 runner 上验。

**要补上需要**：

- 第 1 项是**实机工作**：service 名、PBKDF2 参数、Linux 的 `v10`/`v11` 变体都必须实测确认，
  写出来就是"盲代码"——而本仓库的规矩是量过才写（`probe/` 下两个探测脚本都是这么来的）。
- 第 4 项决定是否敢作为"正式支持"发布。

**影响面**：所有 macOS / Linux 上的 Qoder 桌面端用户，「零配置读应用凭据」卖点在那些平台上仍
不存在——但设备登录那条替代路**已经接进 host**（见上），所以那些平台上现在有了一条零配置的
出路（浏览器授权一次）；README 的「平台边界」段与「凭据来源」段已同步说明。**第 1 项（OS
keystore）因此从"必须补"变成"可选"：不补也不再有平台是彻底没路的。**

---

## 7. 仍未建立的东西

这些不是「某处没测」，而是整个仓库层面的缺失：

- **变异测试已有一个最小集，全仓 harness 仍未建立**。`test/mutation-gates.test.js`
  把「改坏、看是否变红」这件事对**凭据临时目录的几道闸**变成了机器门禁：它把
  `src/host/oscrypt-unwrap.ts` 的**副本**（不碰检出本身）里的一道闸删掉，再跑真正
  守着它的那套测试，要求它变红，**并且红在守这道闸的那条断言上**——红在别处不算数。
  当前覆盖：`lstat` 不跟随联接、联接碰撞必须上报（不许静默）、身份标记、目录恰好
  两件、32 字节主密钥、目录年龄闸，加上 `zeroOutFile` 的「必须是普通文件」与
  「必须真的写零」。每次先跑一遍**不删闸的对照**（副本必须全绿），所以这套结论不再
  依赖人眼，也不再依赖「记得把源码改回去」。
  **本文件 5a–5c 那三条「实测全绿」仍然是手工的**，它们进不了这个最小集：三条都是
  「两条代码路径产生同样的可观察行为」，删掉守卫在任何测试下都不可观测，机器化变异
  也证明不了什么——那三处的结论只能是「保留它更清楚」。
  注：两处最要害的变异现在**已经由静态断言守住**——`test/client-bundle.test.js`
  钉住 bundle 文本里的 `promo.active !== true`，`test/pi-model.test.js` 钉住
  `compat.supportsDeveloperRole === false`，破坏它们各自都会变红。
- **文档（prose）漂移此前没有任何门禁，现已建立**：还原入库（issue 17）作废了一整批
  当时写在活文件里的陈述——"卡片没有入库的源码"、"产物独一份"、"入库仍是待办"、硬编码
  的测试通过数、指向错误编号的交叉引用——三门禁全绿照过。化石原文的清单以
  `test/docs-facts.test.js` 里的 `FOSSILS` 为唯一登记处，本文件不逐字复述（复述即命中）。
  该门禁守的是：活文件里的化石短语、裸编号交叉引用（必须带标题括注）、README 目录表与
  `lib/`、`src/client/` 的清单一致、引用的覆盖率数字与 `package.json` 一致。它同样只是
  地板：防的是"悄悄说谎"，防不了"写一句没用的真话"。
- **覆盖率门槛已建立**（本条的前两版登记「没有阈值」，现已不成立）：
  `npm run test:coverage` 带 `--test-coverage-lines=68 --test-coverage-branches=82
  --test-coverage-functions=66`（分支门槛 0.5.0 前后由 85 下调到 82；`package.json`
  与 `AGENTS.md` 是判据，本条此前引用的 85 是旧值），CI 直接失败于跌破门槛
  （当前实测 90.27 / 82.27 / 86.35；**分支距地板只剩 0.27pp**——handler 抽进分母时
  它的 77% 曾把整体拖到 81.98 让门槛变红，补了分支尾巴用例才回到地板之上。新增
  分支多的文件前先想好它的测试，否则地板会被单个文件捅穿）。门槛是**地板不是分数**：
  它防的是悄悄丢覆盖，守不住的仍是「哪些具体回归
  被挡住」——那还得看本文件。
- **`verify:bundle` 的时钟脆弱性已根治**（原登记为"待根治"）：`offPeakState` / `rateAt` /
  `withDate` / `localSecondsOf` 读墙上时钟，脚本先 `load(OLD)` 再 `load(NEW)` 逐条对拍，
  两次指纹相隔毫秒；POOL 里带着 `undefined`，于是这些函数各读一次真实时钟，同一份未改动的
  `lib/client.js` 会偶发报「N differing call(s)」而 FAIL。实测复现频率约 1/5。
  修法是 `withFrozenClock()` 把两侧指纹固定在同一个时刻（只包住对拍，不包 `load`）。
  **踩到的一个坑值得记下来**：只替换 `Date` 不够——卡片把参数直接交给
  `Intl.DateTimeFormat.formatToParts(date)`，而按 ECMA-402，非 Date 参数经 `ToNumber`
  后 `NaN` 会取 `%CurrentDateTime%`，即引擎内部槽，任何 `Date` 覆盖都够不着；且卡片用的
  是 `formatToParts` 而非 `format`，只改后者等于没改（第一次尝试就是这样白跑的）。
  现在连跑 15 次全绿。
  同一类脆弱性也已堵在 jsdom 端：`test/card-dom.test.js` 的「live off-peak」用例此前直接
  读真实墙钟（22:00–08:00 窗口，白天跑必红、夜里绿，代码没动过），现已复用同一手法——`test/helpers/render-card.js`
  的 `withFrozenClock` 冻结 Node realm 的 `Date` 与 `Intl.DateTimeFormat`（bundle 在
  `new Function` 里跑，读的是 Node 全局而非 jsdom window 的），该用例在任何时刻都绿。

---

## 8. 国际版 campaigns 端点按 umid 机器身份门控每日签到

**位置**：`src/host/upstream/headers.ts`（`openApiHeaders`）与
`src/host/upstream/api-calls.ts`（`readCampaigns` / `claimCampaign`）、
`src/host/upstream/fetch-usage.ts`（`fetchUsage`）、`src/host/upstream/api-calls.ts`
（`fetchUserInfo`）共用的头组、`src/host/claim.ts`（降级列表的语义）

**发现（2026-09-27，本机两个真实账号）**：国际版 `GET /sash/api/v1/me/campaigns`
对**不带 umid 机器身份头**的请求只下发常驻的 `VIEW_DETAILS` 横幅（首月翻倍广告），
**不下发**每日 `CLAIM_BENEFIT` 轮次（100 Credits）。于是插件的 `checkinStateFrom`
读到的列表里没有可领轮次，判 `{ active: false }`，卡片签到卡片按设计不渲染——判断逻辑
本身没有 bug，缺的是请求侧的机器身份。

**判别证据**（全部只读探测，脚本在 `probe/`）：

| 请求 | 国际端返回 |
|---|---|
| 裸 bearer（插件原状） | 仅 `VIEW_DETAILS` |
| bearer + `auth.machine-id` 文件值充数机器头 | 仅 `VIEW_DETAILS`（充数值不被接受） |
| bearer + **真实 umid 头**（`resources\umid\runtime-info.exe` 输出的 `machineToken/Code/Type`） | `CLAIM_BENEFIT` + `VIEW_DETAILS` ✅ |
| 对照：CN 端裸 bearer | `CLAIM_BENEFIT` + `VIEW_DETAILS`（CN 不门控） |

**修复**：`openApiHeaders(credential, region)` 在 Windows 上定位安装目录下的
`runtime-info.exe`（0.4.x 布局在 `Programs\Qoder\.qoder-versions\<v>\resources\umid\`，
旧布局在 `Programs\Qoder\resources\umid\`），同步执行（5 s 超时、非 shell、
`stdio` 管道）取其 JSON 输出作为 `Cosy-MachineToken/Code/Type` 头随 OpenAPI 请求发送；
任一环节失败（非 Windows、未安装、二进制超时/输出不可解析）降级为原头组，
CN 与 PAT 凭据不受影响。二进制每进程只跑一次（`umidInfo` 缓存）。

**残留缺口**：

- umid 头目前附加在**所有** OpenAPI 调用上（userinfo / usage / campaigns / claim）。
  国际端 campaigns 是它的判别因子，其余端点是否也门控未逐一验证；若上游收紧
  （只认机器身份、拒裸请求），全走 umid 头反而是对的。若上游将来对 umid 做
  频控/绑定，需要按端点收窄。
- `runtime-info.exe` 的版本根目录**已改为运行时枚举**（2026-10-03，本轮）：
  `umidRootsFor` 不再钉死 `0.4.3`，而是按目录枚举 `.qoder-versions` 下的版本
  根（数值序 newest-first，仅目录条目——实测布局里版本目录旁有
  `0.4.3.qoder-update-ready.json` 之类的标记**文件**，须过滤），launcher tree
  仍是回落候选。上游升版（0.4.4…）不再需要插件发版跟档。剩余：CN 端的
  `QoderCN\.qoder-versions` 布局未实测（本机无 CN 安装），按对称规则枚举，
  目录不存在时静默 no-op；枚举读失败同样 no-op（`umid-roots` 测试守着）。
- **签到降级的用户可见性（2026-10-03 两侧都补齐了）**：umid 读不到时，国际版签到轮次
  不下发、卡片签到区不渲染，此前**全程无痕迹**——"面板空着"与"今天没有轮次"长得一模一样。
  现在两端都发声：
  - host 半边：`__dshQoderUmidState` 这个既有缝同时接到 `usageHandler` 的响应上
    （`{ checkin: { umidAvailable: false, reason } }`），判据与激活期那条 warn 同源，
    所以卡片看到的解释与日志那行**不可能互相矛盾**；umid 可用时该字段整个不出现，
    健康机器不会多出一条谁也处理不了的警告。`reason` 永不为空——空的 `reason` 到卡片
    上就是"一条什么都不解释的警告"，那正是本条要消灭的东西。
  - card 半边：`usage.checkinUnavailable` 在**签到卡不渲染时**补一行说明，{reason}
    逐字带出宿主原话。签到卡真的在渲染时（轮次存在）不显示这行，否则会和卡片自相矛盾。
    `card-dom.test.js` 新增四条，含"有轮次时以卡片为准"与"没有 reason 就不显示"。
- 跨平台（第 6 条）依旧：umid 二进制是 Windows 专物，macOS / Linux 上国际版
  签到卡片会继续缺席，与跨平台凭据链缺口同源。
- **领取幂等性未实测**：本轮只读验证了"看见轮次"，没有真发 POST 领取
  （领取会真实进账，属于账号变更操作）。`normalizeClaimResult` 的 `replayed`
  语义在 CN 端有既测，国际端同链路但缺一次实领确认。

---

## 9. 「插件自有登录」与账号状态之间的两本账

**发现（2026-10-20，同类问题普查）**：第 6 节（跨平台凭据链未实现）那条设备登录已经把第三条
凭据接进了 host，但**账号状态这一层仍然只认桌面端与 PAT**。于是同一张卡上能同时出现两句互相
打架的话：上面写"读不到"（`account.state.needs-app`），下面设备块写"插件已登录"
（`device.state.ok`）。这不是文案问题，是**两条并行的账**——`account-payload.ts` 的注释就是这么
写的（"不合并"）。

**这一轮已经修掉的**（各带测试）：

- **过期的桌面端登录不再压住插件自有登录**（`credential-cache.ts`）。这一条是功能性的：不修
  的话，一台"桌面端登录过期了"的 Windows 机器连插件自己的浏览器登录都轮不上（那个 region
  直接不发布 provider），而那正是设备登录存在的理由。规则现在是：桌面端那条**没过期**才算
  "在场"；三条都拿不出东西时，那条过期的桌面端登录仍作为"本机真实发生过的事"被报出去，
  而不是被一句含糊的"没登录"盖过去。
- **「在线校验登录」失败时不再只剩一个冒号**（`account-panel.tsx`）。宿主答 `available: false`
  时**可能带原因**（读凭据时抛了），也可能不带（这台机器根本没有登录可校验）。以前两种都被
  折成"在线校验失败："，不带原因的那种在屏上就是一个空尾巴——红线 1 说的"失败必须说清是
  哪一种"。现在带原因的照原样透出，不带原因的单独一句"这个版本没有可校验的登录"。
- **「来自 {app}」这个来源标签只在真读到凭据时出现**（`account-panel.tsx`）。`needs-app` 状态里
  的 `appName` 是**应用目录名**（宿主"找到了 Qoder 装着、但读不出登录"），照印成"来自 Qoder"
  等于宣称这台机器的凭据来自桌面端——而那正是没发生的事。
- **卡片改按"真正在服务这个版本的凭据"说话**（`account-panel.tsx`）。宿主把两条凭据**并列**上
  报、刻意不合并（两条凭据两个寿命），但卡片要回答的其实只有一个问题："这个版本登录了吗"。
  现在有 `effectiveStateOf()`：插件自有凭据可用、且桌面端那条**不在服务**时，这个版本读作
  "已登录"，并配一句"当前用的是插件自有登录（浏览器登录）——不需要桌面端客户端"。
  "桌面端在不在服务"用的是宿主真实的解析顺序（桌面端 → 插件自有 → PAT，见
  `credential-cache.ts`）加上宿主声明的 `source`（`app`=桌面端 store、`env-pat`=环境变量）：
  桌面端过期、读不到、或只是环境变量在服务时，插件自有凭据都算数。
  顺带把两个来源标签合成一个（以前会出现"来自 Qoder · 来自插件自有登录"这种自相矛盾的说法）。
- **只签浏览器登录的用户现在也有"在线校验登录"按钮**（`account-panel.tsx`）。按钮以前只在
  `source` 有值时出现，而插件自有登录在账号行里 `source` 是空的——于是这条唯一在 macOS 上
  真正好用的路子，反而没有按钮可点。
- **宿主现在直接说「谁在服务这个版本」**（`credential-kind.ts` + `credential-cache.ts` +
  `account-payload.ts` + `index.ts` + `handlers.ts` + `card-model.ts`）。以前「桌面端还是插件
  自有」这件事**只有卡片能猜**：`effectiveStateOf()` 靠账号行里的 `source` 反推，而 `source`
  只在「桌面端 → PAT」的读取链里产生，插件自有登录那条永远不出现——于是卡片在「桌面端登录
  过期、插件自有登录在服务」时只能靠 `device.state === 'ok'` 猜，猜错就显示成"没登录"。
  现在**宿主是唯一知道实际解出哪条凭据的一方**，它把答案写成 `credentialKind`（`desktop` /
  `device` / `env` 三档）随账号面板 payload 与 status 路由一起上报；卡片优先用这个字段，
  拿不到时才回退到旧推断（兼容尚未解析出凭据的机器：面板渲染路径刻意不解析，宿主可能
  真的还不知道）。宿主的答案来自**凭据缓存最后一次解析出的那一条**，与 runtime 用的
  是同一次解析，不是另一次读盘。
- **确认路由的兜底路径现在也读得到设备凭据**（`index.ts` + `handlers.ts`）。`deps.readCredential`
  这个接缝以前在宿主侧**从未接线**，所以没有 runtime 的 region 走兜底时只读桌面端与 PAT，
  插件自己的浏览器登录看不见。宿主现在把它接到**按 region 共享的凭据缓存**上（`RegionSources`），
  解析顺序与 runtime 用的那条完全一致——一次 store 读、一次 PAT 交换、每 region 一次
  invalidation，兜底路径和正常路径不再各读各的。

**仍未做（host 侧 payload 语义，等定夺）**：

- **`source` 字段本身仍旧只分桌面端与 PAT**（`account-state.ts` 的 `readAccountState` 只读
  桌面端 → PAT，账号行里 `source` 永远不会出现 `device`）。这一轮**刻意没改它的语义**：
  让 `source` 多一档 `device` 会牵动 `region-gate` 的判定与
  `docs/issues/21-device-login-credential-source.md` 的验收，属于**要单独设计**的改动。
  取而代之的是加了一个**正交**的新字段 `credentialKind`：它不描述「这条账号状态的证据来自
  哪」，而描述「**实际在服务的是哪条凭据**」，两者可以同时成立（账号状态的证据读自桌面端，
  但那条已过期、真正在服务的是插件自有登录——这正是本节开头那句"两句互相打架的话"）。
  代价是 `source` 与 `credentialKind` 可能不一致，那是它们各自的职责，不是漂移。
- **「谁在服务」目前只到凭据这一层**：`credentialKind` 说的是**凭据**来自哪条路（桌面端 store
  / 插件自有 / 环境变量），还没说**这个版本是不是真的在用这条凭据**（例如区域被关掉、
  provider 没注册成功时，凭据仍可能解出来）。要回答后者得把 provider 注册态也接进同一个
  字段，牵动 `region-gate`，与上一条同源。
- **"非 Windows 上不该建议装客户端"这条不成立，已撤下**：原以为 `account.download`（"没装 Qoder
  客户端？到「下载」区安装"）在读不到桌面端凭据的平台上是死路。重新校准后不成立：带这句的
  只有 `signed-out`（"应用目录不存在"，建议装客户端完全成立）与 `expired`（只有**读得到**桌面端
  凭据才可能出现，而解密链只有 Windows 有，所以这条分支在 macOS/Linux 上根本到不了）。

---

## 10. 测试树的类型债被记成预算，但存量一条没修

**位置**：`test/`、`tsconfig.test.json`、`tsconfig.test.budget.json`、
`scripts/audit-test-types.mjs`、`scripts/audit-test-type-errors.mjs`、
`scripts/ratchet-ledger.json`（上界与下限住在这本账里）

**为什么没测**：2026-10-20 之前，测试文件完全不在任何编译器程序里——主 `tsconfig.json` 的
`exclude` 写着 `test`、`allowJs` 是 `false`，而套件是经 Node 的剥类型加载器 import
`src/**/*.ts` 的，注解被抹掉、一个都没查。测试树现在有了自己的程序（`tsconfig.test.json`），
但 `checkJs` 是关的：没有 `// @ts-check` 的文件只被解析、不被检查。

**还差多少**：opt-in 的测试文件必须**零错误**，其余测试树由 `npm run audit:test-type-errors`
按**错误预算**管着。今天的实测数与生效的上界都印在这道门禁的输出里（别把数字抄进文档——
抄进来的那天它就开始过期了）；2026-10-21 那一天的逐码分布、逐文件分布记在
[`docs/history/2026-10-21-test-tree-type-debt.md`](history/2026-10-21-test-tree-type-debt.md)。
**存量一条都没修**：上界就是那天的实测值，所以这道门禁管的是「不再变多」，不是「已经很干净」。

**已经做到哪一步**：
- `npm run audit:test-types` 盯住三件会静默失守的事——opt-in 集合的棘轮下限（摘掉一个
  pragma 就红）、编译器真的报了 opt-in 文件的错误（自探针：往 `test/` 里写一个带类型错误的
  临时文件，门禁要求这条错误被报出来）、以及 opt-in 的文件真的在程序里
  （`tsc --listFiles` 逐个点名）。pragma 的语义是实测出来的、不是猜的：只有 `//` 行注释算，
  块注释里的 `@ts-check` 编译器根本不看；token 必须出现在注释开头；最后一个 pragma 赢。
  六种故意破坏（摘 pragma、塞类型错误、把 `test` 加回 `exclude`、前导区加 `@ts-nocheck`、
  把 pragma 放到 import 之后、往未 opt-in 的文件里塞 pragma）都实测会红。
- `npm run audit:test-type-errors` 是另一半：**棘轮轴从「文件数」换成了「错误数」**。
  文件数那个轴买不到风险——给一个干净文件加 pragma 就 +1（有本事不要钱），而一个有 60 条
  错的文件 opt-in 反而立刻变红（最该被看的文件进不来）；新写的测试文件带 20 条错进来，
  文件数一动不动。错误预算反过来：新文件一进来就被数进去。两道门禁的分工是
  `audit:test-types` 管「opt-in 的文件必须零错」的下限，`audit:test-type-errors` 管
  「整棵树的债不许涨」的上限。
  这道门禁自己也有三道护栏：把 `tsconfig.test.budget.json` 的 `checkJs` 翻成 `false`
  （错误数会塌成 0、门禁永远绿）、把 `tsconfig.test.json` 的 `include` 里的 `test` 删掉
  （测试树整个离开程序、同样塌成 0），或者把上界本身悄悄抬高——上界不在脚本里，而是住在
  `scripts/ratchet-ledger.json` 那本账里，单独改一个数不记账，账实对不上，三种改法都实测
  当场被抓红。

**下一步**：预算只许降。降债的顺序与各类错误的分布见那份实测快照；降预算不需要另立计划：
`node scripts/audit-test-type-errors.mjs --write` 会把当前总数与逐文件分布打出来，
修掉一批就在 `scripts/ratchet-ledger.json` 的 `testTypeErrorBudget` ratchet 里记一笔
（from、to、日期、理由），门禁会核对账实相符。
