# sweep 跟随目录联接，把插件目录之外的文件清成 NUL

**P0 · 规模 S · 依赖 —**

## 症状

`sweepStaleOscryptDirs` 只按**名字前缀**匹配 `%TEMP%` 下的条目，`statSync` 跟随联接，
然后对目录内**每个条目**无条件 `zeroOutFile`（`open('r+')` + 写零到原长度），最后 `rmSync`。
任何名字撞上 `qoder-oscrypt-*` 的目录/联接，其内容会被静默抹成 NUL，**零上报**，还计入 `reclaimed`。

## 证据

- `lib/credentials.js:779-813`（前缀匹配、`statSync`、遍历清零、`rmSync`）
- `lib/credentials.js:429-478`（`zeroOutFile`）
- 本机复现：建 `%TEMP%\qoder-oscrypt-<rand>` → `mklink /J` 指向自己的目标目录 →
  `sweepStaleOscryptDirs(0)` → `reclaimed=2`、无任何上报、联接被删、
  目标目录里的 `victim.txt`（20 字节）**全部变成 NUL**。

威胁模型：`%TEMP%` 是 per-user ACL，现实威胁是**同用户进程/管理员 + 名字撞车的残留目录**
（旧版本、其它工具的残留），不是任意本地用户。但这是"我们自己的启动代码去清别人的文件"，损失不可逆。

## 修法

1. `lstat`（不跟随）判定类型：符号链接/junction/reparse point 一律跳过并上报；
2. 只处理**恰好一个 `key.b64`** 的目录，且校验内容为 base64 解出的 32 字节；
3. 目录内出现任何其它条目 → 不清零、不删除、上报 warning；
4. `reclaimed` 只统计"确认是自己的残留目录且已处理"。

## 验收标准

- [ ] junction/symlink 目标目录内的文件**逐字节不变**
- [ ] 目录含非 `key.b64` 条目时，既不清零也不删除，且产生一条上报
- [ ] 仅含 `key.b64` 且年龄超限的残留目录仍被回收，`reclaimed` 计数正确
- [ ] 变异验证：删掉 `lstat` 守卫，新增用例变红
