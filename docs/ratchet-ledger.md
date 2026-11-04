# 棘轮账（ratchet-ledger）机制

本文件是 `AGENTS.md` 「验证」节里棘轮账说明的展开版——把「为什么阈值不写死在脚本里、怎么改阈值」
从纪律文件挪到这儿，让 `AGENTS.md` 只钉红线、不教一步步做。

## 两套程序，别混

`npm run typecheck`（`tsconfig.json`）只管 `src/`，它的 `exclude` 里写着 `test`；
测试树由 `tsconfig.test.json` 管。所以 `npm run typecheck` 绿**不等于**测试文件被检查过——
套件是经 Node 的剥类型加载器 `import src/**/*.ts` 的，注解一个都没查。

想让某个测试文件进类型检查：在**前导区**写 `// @ts-check`，规则如下（写错不报错、只静默不生效）：

- 只认 `//` 行注释；块注释里的 `@ts-check` 编译器不看。
- token 必须在注释开头；最后一个 pragma 赢；写在 `import` 之后无效。

## opt-in 类型门禁（`npm run audit:test-types`）

三道判据绑在一起：opt-in 文件数**棘轮**下限 + 编译器真的报了 opt-in 文件的错误 +
opt-in 文件真的在程序里。给某个测试文件加 `// @ts-check` 时，要把 opt-in 集合的
棘轮下限一起抬。

## 错误预算门禁（`npm run audit:test-type-errors`）

`checkJs` 仍是关的：整棵树打开是数千条错误的量级（代价见 `docs/KNOWN_GAPS.md` 第 10 条，
测试树的类型债被记成预算）。所以另一道门禁按**错误预算**管着整棵树的债：

- 只许降不许涨。
- 棘轮轴从「文件数」换成「错误数」——因为给干净文件加 pragma 让文件数 +1，
  而给带 60 条错的文件 opt-in 反而当场变红，文件数买不到风险。

## 阈值单一真源：`scripts/ratchet-ledger.json`

四道门禁的阈值（opt-in 下限、测试树错误预算、两道 any 预算）都住在
`scripts/ratchet-ledger.json`，**不在脚本里**。

改阈值的正确姿势 = 在账本里记一笔：`from` / `to` / 日期 / 理由。
门禁核对「账实相符」，**单独改 `value` 会当场红**（`the ratchet ledger is not consistent`）——

> 即：阈值不能只改 JSON 里的数，必须同步记一笔账；账和值对不上，门禁直接红，
> 逼你在提交里留下「为什么抬阈值」的痕迹，而不是默默把门槛调低糊弄过去。
