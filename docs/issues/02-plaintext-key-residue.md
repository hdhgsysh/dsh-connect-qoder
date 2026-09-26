# 明文 OSCrypt 主密钥残留在共享 %TEMP%

**P0 · 规模 S · 依赖 —（与 #01 同一片代码，建议同 PR）**

## 症状

解包失败时 `key.b64` 会原样留在 `%TEMP%\qoder-oscrypt-*`，而唯一的回收点是**下次插件启动**的 sweep
（没有定时器）。文件内容是 OSCrypt 主密钥的 base64——凭据级材料。

## 证据

- `lib/credentials.js:260-342`（`oscryptKeyFor` 的 `finally` 清理；失败不缓存但会留下临时目录）
- `lib/index.js:592-601`（启动时 sweep 是唯一调用点）
- 本机实测：`%TEMP%\qoder-oscrypt-j5lTke\key.b64` = **48 字节全非零**

## 修法

1. 清理失败时立刻重试一次；
2. 仍失败则**先把文件截断为 0**（"剩 48 字节明文"比"删不掉"更糟）；
3. `process.on('exit')` 路径里补一次扫描；
4. 残留出现时通过 `setCredentialDiagnosticSink` 上报（含 TTL/年龄）。

## 验收标准

- [ ] 模拟"文件被独占句柄锁住"：该次调用后文件长度必须为 0（当前实现保留 48 字节）
- [ ] 残留出现时产生一条可被诊断 sink 收到的上报
- [ ] 正常路径仍然删除整个临时目录（不回退行为）
