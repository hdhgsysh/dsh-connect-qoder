# DSH Connect Qoder

把本机已登录的 **Qoder** 模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，
零配置即可在 DSH 的模型选择器里使用你的 Qoder 账号额度。

国内版 **Qoder CN** 与国际版 **Qoder** 是两个并行的 provider（`qoder-cn` / `qoder`），
装哪个就出现哪一组模型，两个都装就两组并存，各自使用自己的账号与额度。

## 工作原理

```
DSH PiAiAdapter（每个区域一套）
  -> 安全 loopback shim（随机端口 + 进程内随机 secret）
  -> COSY 签名 + 自定义 base64 编码
  -> 国内版 https://gateway.qoder.com.cn/
  -> 国际版 https://api3.qoder.sh/
  -> Qoder 双层包装 SSE
  -> OpenAI SSE
  -> DSH 本地执行工具并回传结果
```

Qoder 不是 OpenAI 兼容端点，所以需要三样东西：

1. **COSY 签名头** —— 每个网关请求都带 `Cosy-*` 头与 `Authorization: Bearer COSY.<payload>.<sig>`，
   签名是对 base64 负载、RSA 包装的 AES 密钥、时间戳、请求体与签名路径做 MD5。
2. **置换 base64 请求体** —— 查询串里的 `Encode=1` 表示 JSON 体要先 base64、再按换过的字母表
   逐字符替换、最后按三分之一旋转。
3. **双层 SSE** —— 每个 `data:` 帧是一个信封对象，它的 `body` 字段本身又是 JSON 字符串，
   里面才是 OpenAI 风格的 chunk。

## 凭据来源

插件复用 Qoder 桌面应用自己的登录状态，**不启动额外的 OAuth 流程，也不写入应用的文件**
（凭据文件以只读方式打开）。

Qoder 把登录信息放在 Chromium OSCrypt 格式的凭据文件里（`v10` + nonce + 密文 + tag，AES-256-GCM）。
新版（0.3.x）的凭据直接保存在 `<userData>/auth.v1.dat`，旧版（0.2.x 及更早）则放在
VS Code 风格的 `state.vscdb` SQLite 数据库里。两种布局都支持，新版优先尝试。
密文用的密钥保存在应用的 `Local State` 中，由操作系统 keystore 包裹 —— Windows 上是当前用户
作用域的 DPAPI，因此同一用户下的进程都能解开它。
Node 没有内置 DPAPI 绑定，这一步交给 PowerShell，并通过临时文件交换结果（不使用管道），
这样在禁止管道 stdio 的沙箱里同样可用。

没有桌面应用登录时，可以用官方文档的 **PAT** 兜底：设置 `QODERCN_PAT`（国内版）或
`QODER_PAT`（国际版），插件会用它换取 job token。

## 安装

### 从 DSH 市场安装（推荐给 DSH 桌面用户）

在 DSH 的「插件市场」里粘贴这个源：

```
github:hdhgsysh/dsh-connect-qoder
```

或本地开发模式：

```sh
dsh plugin --profile web add <本仓库路径>
```

安装后需要**重启 DSH 进程**：bundle 的 patch 在启动时读取。

## 凭据安全

插件**不存储任何凭据**：

- 复用本机已登录的 Qoder 桌面应用的凭据文件（新版 `auth.v1.dat` / 旧版 `state.vscdb`，
  均以只读方式打开，不做任何写入）。
- 进程内随机 bearer token 绑定 loopback 端口；Qoder 真实的 RSA 包装 key 与 session key
  不会离开本插件的沙箱。

## 已知行为

- **始终思考的模型**：部分模型（如 `GLM-5.3-Flash`、`Kimi-K3`）声明了推理档位但不允许关闭思考，
  对它们发送 `enable_thinking: false` 会被上游以 `provider_error 1210` 拒绝。插件从模型目录
  识别这类模型并**完全省略**该字段，让模型使用自己的默认档位。
- **上游错误可见**：上游失败时返回的是普通 200 帧里的错误对象，而不是 chunk。插件把它翻译成
  一条可读的错误，而不是让用户看到一个空的助手回合。
- **国际版额度**：国际版的试用额度可能已用尽（`isQuotaExceeded`），此时目录请求会返回
  403 `Login expired`，该区域就不会显示模型；国内版不受影响。
- 依赖 Qoder 客户端接口（非官方开放 API），Qoder 更新后插件可能需要随之调整。
- **设置保存走插件的 `__save` 主机端点 + 读回校验**（对齐 WorkBuddy 0.1.7 修复）：DSH 0.1.7 的
  客户端 `settingsScope.set()` 在原子写重试耗尽后会**静默返回成功而不落盘**，卡片改为「主机端点
  权威写、本地写仅作镜像、写后读回确认」，保存按钮只会显示真实结果。在宿主未为本插件注册设置
  命名空间行的环境（如 `link:` 开发安装）下端点会 503，卡片如实显示失败而不是假"已保存"；
  正式（registry）安装下该端点可用。

## 目录

| 文件 | 作用 |
| --- | --- |
| `lib/credentials.js` | 从 Qoder 应用读取并解密登录凭据 |
| `lib/upstream.js` | COSY 签名、请求体编码、目录与对话流 |
| `lib/shim.js` | 面向 pi-ai 的 OpenAI 兼容回环端点 |
| `lib/adapter.js` | pi-ai provider 与 `PiAiAdapter` profile |
| `lib/catalog-entry.js` | 目录条目的归一化、模型过滤与卡片行投影（无 peer 依赖） |
| `lib/catalog-store.js` | 目录的磁盘缓存与原子落盘（无 peer 依赖） |
| `lib/credential-cache.js` | 凭据缓存与「登录失效后重读」规则（无 peer 依赖） |
| `lib/offpeak.js` | 错峰窗口与费率算术（无 peer 依赖） |
| `lib/errors.js` | 上游错误分类与「凭据是否过期」判定（无 peer 依赖） |
| `lib/index.js` | 按区域注册 provider 的插件入口 |

## 测试

```sh
npm test             # node --test "test/*.test.js"
npm run test:coverage   # 同上，加 --experimental-test-coverage
```

CI 在 Node 22.19 / 24 × Ubuntu / Windows 上跑（`.github/workflows/test.yml`）——
Windows 不是冗余：shim 绑定回环监听、目录缓存依赖 rename 覆盖、凭据读取要调
PowerShell，这些在别的平台上行为不同。

测试只用 Node 内置的 `node:test`，不需要安装任何依赖——**也不需要安装 peer 依赖**，
这是刻意的：`lib/` 中凡是纯逻辑的部分都放在无 peer 依赖的模块里（见上表），
这样它们才能被直接 import 并断言真实的实现，而不是在测试里手抄一份。

几个文件存在的理由，都是因为曾经出过问题：

- `test/catalog-fields.test.js` 与 `test/model-row.test.js` —— 错峰机制曾因
  `promotion.active` / `promotion.timezone` 在 Host 投影时被丢掉而全程哑火，
  而当时的测试是绿的，因为它测的是自己手抄的副本。
- `test/credential-cache.test.js` —— 「重新登录无需重启」这条卖点的完整链路：
  网关拒绝 → 谓词判定 → 置失效标志 → 下次请求重读。此前只有两端被测。
- `test/credential-invalidation.test.js` —— 上面那条链路上的两个纯谓词。
- `test/errors-classify.test.js` —— 105 与 10605 的优先级决定了「提示用户重新登录」
  还是「排队等待」，两者弄反的代价完全不同。
- `test/catalog-store.test.js` —— 目录缓存的原子落盘，用真实临时目录跑，
  在 CI 所在的平台上实测 `rename` 覆盖行为，而不是在注释里假设。
- `test/shim.test.js` —— 回环端点的鉴权与 `/v1/models` 过滤；对着真实
  HTTP 服务器说话，Host 头用裸 socket 发送（`fetch` 禁止设置该头）。
- `test/oscrypt.test.js` —— 凭据解密往返；夹具用真实 AES-256-GCM 构造，
  key 是固定哈希，失败可复现。
- `test/upstream-protocol.test.js` —— 编码与签名。两个盲区是**原理上不可测**的，
  已在文件头写明。
- `test/upstream-messages.test.js` —— 消息与工具调用翻译，注释里自称
  「最重要的一件事」，此前零覆盖。

尚未覆盖的部分集中登记在 `test/KNOWN_GAPS.md`，不在各文件里重复叙述——
重复三处正是「手抄副本」那类问题的文档版。

## 免责声明

仅供个人学习研究使用，仅驱动使用者自己的 Qoder 账号在本机调用。使用者需遵守 Qoder 的服务条款，
因使用本项目产生的后果由使用者自行承担。本项目与 Qoder、DeepSeek 均无关联。

## 许可证

MIT
