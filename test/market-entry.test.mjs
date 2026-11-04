/**
 * market-entry.test.mjs — 我们的投稿副本，按**市场自己的规则**校验。
 *
 * ## 守的是什么
 *
 * 本仓以前只有一道投稿门禁（`test/plugin-locale.test.js` 的投稿副本块），它判的是
 * 「副本 == locale/*.json == package.json 的 description」——**同源**，不是**合规**。
 * 「这份文件市场收不收」从来没被查过。
 *
 * 而市场的检查时序是这样（上游源码实证）：
 *
 *   - PR 闸 `scripts/check-submission.mjs`（`.github/workflows/pr-gate.yml` 的
 *     「Check submitted entries」）只做 YAML 解析 + 仓库层面检查（仓库年龄、
 *     归档、bundle manifest、每 PR 条数上限）。**它不校验条目形状。**
 *   - 形状规则在 `scripts/lib/entries.mjs` 的 `validateEntries`，唯一调用方是
 *     `scripts/generate-readme.mjs`——合入 main 之后重新生成 README 时才跑，
 *     有问题就 `refusing to generate` 并退出 1。
 *
 * 于是：**一份形状不合规的稿子可以过 PR 闸，然后在合入后打断市场的 README 生成。**
 * 我们宁可在自己这边红。
 *
 * 规则镜像在 `test/helpers/market-rules.mjs`（手抄上游，抄的时候尽量逐字抄判据
 * 与措辞）。这个套件钉两件事：
 *
 *   1. **我们这份稿子**在镜像规则下零问题（这就是「市场会收」的本地判据）。
 *   2. **镜像的每一条判据**确实会抓到对应的坏形态——否则镜像自己被改弱了也没人
 *      知道（这是「绿灯撒谎」的第二类：门禁在核错对象）。
 *
 * 另外与本仓的 `awesome-dsh-plugin-submission/contributing.md`（上游副本）做一处
 * 交叉核对：那份副本里写着合法的 `category` 取值，它必须与镜像的 `CAT_IDS` 一致
 * ——上游改了类别表而我们两边都没跟上时，本地的门禁会响。其余规则没法这样交叉
 * 核对（贡献指南里没写成机器可读），那是镜像的已知缺口，见 helper 头注。
 *
 * @module test/market-entry
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASE_LOCALE,
  CAT_IDS,
  ENTRY_KEYS,
  LOCALE_CODES,
  checkEntry,
  slugFor,
  tarballProblem,
  validateEntry,
} from "./helpers/market-rules.mjs";
import { parseEntry } from "./helpers/submission-entry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const DRAFT_REL = "awesome-dsh-plugin-submission/eghrhegpe__dsh-connect-qoder.yml";
const DRAFT_PATH = join(REPO, DRAFT_REL);
const CONTRIBUTING_PATH = join(REPO, "awesome-dsh-plugin-submission", "contributing.md");

const OWNER_REPO = "eghrhegpe/dsh-connect-qoder";
const DRAFT_SLUG = "eghrhegpe__dsh-connect-qoder";

/**
 * 一条合规条目（镜像规则的测试底座）。
 *
 * @param {Record<string, any>} [over]
 * @returns {Record<string, any>}
 */
const entryOf = (over = {}) => ({
  url: `https://github.com/${OWNER_REPO}`,
  name: OWNER_REPO,
  category: "model",
  description: { en: "One sentence, ending with a period.", zh: "一句话描述。" },
  ...over,
});

/**
 * 断言某条坏形态被抓到，且问题文本里含指定片段。
 *
 * @param {Record<string, any>} doc
 * @param {string} needle
 * @param {{ file?: string }} [options]
 * @returns {string[]}
 */
function assertProblem(doc, needle, options = {}) {
  const problems = validateEntry(doc, options);
  assert.ok(
    problems.some((p) => p.includes(needle)),
    `期望抓到含 ${JSON.stringify(needle)} 的问题，实际：\n${problems.join("\n") || "（一个都没抓到）"}`
  );
  return problems;
}

// ── 一、我们这份稿子：市场的规则下零问题 ────────────────────────────────
{
  const draftText = readFileSync(DRAFT_PATH, "utf8");
  const result = checkEntry(draftText, { file: DRAFT_REL });
  assert.ok(result.ok, `投稿副本不是合法 YAML，市场会直接拒收：${result.error}`);
  assert.deepEqual(
    result.problems,
    [],
    `投稿副本不符合市场的条目规则（市场会在合入后拒绝生成 README）：\n${result.problems.join("\n")}`
  );

  // 文件名必须是 url 的 slug（上游 :169-172）——顺带钉住「改 url 就要改文件名」。
  assert.equal(slugFor(`https://github.com/${OWNER_REPO}`), DRAFT_SLUG, "文件名 slug 与规则不符");
}

// ── 二、镜像与贡献指南副本的交叉核对 ────────────────────────────────────
{
  const contributing = readFileSync(CONTRIBUTING_PATH, "utf8");
  const line =
    contributing.split(/\r?\n/).find((l) => l.includes("`agi`") && l.includes("`fun`")) ?? "";
  assert.ok(line, "contributing.md 里找不到 category 取值那一行");
  const fromGuide = [...line.matchAll(/`([a-z]+)`/g)].map((m) => m[1]);
  assert.deepEqual(
    fromGuide,
    CAT_IDS,
    "贡献指南副本里的 category 取值与镜像的 CAT_IDS 不一致——上游改了类别表，两边都要跟上"
  );
}

// ── 三、镜像的每条判据都要真能抓到东西 ──────────────────────────────────
// （这一节是给镜像上锁：判据被改弱了，这里会红）

// 未知字段：上游 #1775 之后直接拒（`npm:` 这类没人读的键）。
assertProblem(entryOf({ npm: "dsh-connect-qoder" }), 'unknown field "npm"');
{
  const problems = validateEntry(entryOf({ npm: "x" }));
  const first = problems[0] ?? "";
  assert.ok(
    first.includes("may only declare url, name, category, description, tarball"),
    `未知字段的提示应说明允许哪些键，实际：${first}`
  );
}

// url 必须是 GitHub 仓库链接；不合法时上游直接跳过本条其余检查（:162-164）。
{
  const problems = assertProblem({ ...entryOf(), url: "https://example.com/x" }, '"url" must be');
  assert.equal(
    problems.length,
    1,
    `url 不合法时应只报 url 一条（上游 continue），实际 ${problems.length} 条：${problems.join(" | ")}`
  );
}

// 文件名必须与 url 对得上。
assertProblem(entryOf(), "filename must match the url", { file: "wrong__name.yml" });

// name 必填。
assertProblem(entryOf({ name: "" }), '"name" is required');

// name 写成 owner/repo 时必须与 url 指向同一个仓库。
assertProblem(entryOf({ name: "someone/else" }), "the name is the link text");

// category 必须在 CAT_IDS 里。
assertProblem(entryOf({ category: "modeling" }), '"category" must be one of');

// description.en 必填、不能空、必须单行。
assertProblem(entryOf({ description: { zh: "有中文没英文。" } }), '"description.en" is required');
assertProblem(entryOf({ description: { en: "   " } }), '"description.en" is required');
{
  const doc = entryOf({ description: { en: "First line.\nSecond line." } });
  assertProblem(doc, '"description.en" must be a single line');
}

// description.zh 给了就不能是空串；没给不算错（上游 :191-201）。
assertProblem(entryOf({ description: { en: "Sentence.", zh: "" } }), "present but empty — omit the key instead");
{
  const problems = validateEntry(entryOf({ description: { en: "Sentence." } }));
  assert.deepEqual(problems, [], `缺 description.zh 是合法的（市场只要求 en），实际报了：${problems.join(" | ")}`);
}

// 站点不渲染的 locale 一律不许多带（上游 :208-216）。
assertProblem(entryOf({ description: { en: "Sentence.", ja: "こんにちは。" } }), "remove the extra key(s)");

// tarball 给了就得是 GitHub 发布托管上的 .tgz（上游 :113、:116-128、:221-224）。
assert.equal(
  tarballProblem("https://github.com/o/r/releases/download/v1/p.tgz"),
  null,
  "合法的 GitHub release tarball 不该被报"
);
assertProblem(entryOf({ tarball: "http://github.com/o/r/releases/download/v1/p.tgz" }), "must be https");
assertProblem(entryOf({ tarball: "https://example.com/p.tgz" }), "must be hosted on GitHub releases");
assertProblem(entryOf({ tarball: "https://github.com/o/r/download/v1/p.tgz" }), "must point at a GitHub release asset");
assertProblem(entryOf({ tarball: "https://github.com/o/r/releases/download/v1/p.zip" }), "must point at a .tgz");

// slug 规则：owner/repo → owner__repo；子包 → owner__repo--packages-x。
assert.equal(slugFor("https://github.com/o/r"), "o__r");
assert.equal(slugFor("https://github.com/o/r/tree/main/packages/my-plugin"), "o__r--packages-my-plugin");

// 镜像自己的常量：允许的键、locale、类别表。
assert.deepEqual([...ENTRY_KEYS].sort(), ["category", "description", "file", "name", "tarball", "url"]);
assert.deepEqual(LOCALE_CODES, ["en", "zh"]);
assert.equal(BASE_LOCALE, "en");
assert.ok(CAT_IDS.includes("model"), "我们投稿用的 category 必须在 CAT_IDS 里");
assert.ok(CAT_IDS.includes("usage"), "上游线上条目现在的 category 必须在 CAT_IDS 里");

// checkEntry：YAML 不合法 → ok=false（这是市场会直接拒收的那一类）。
{
  const broken = checkEntry("url: https://github.com/o/r\nname: o/r\ncategory: model\ndescription:\n  en: Vision toolkit: OCR, grounding and pixel diff.\n");
  assert.equal(broken.ok, false, "未加引号且含 ': ' 的描述不是合法 YAML");
  assert.ok(broken.error, "解析失败时必须带原因");
}

// ── 四、我们自己的文案约定（市场模板的措辞，上游的 validateEntries 不判）────
//
// 这两条检查在本仓**从来没有过**门禁：同族仓 modelscope 的同款检查曾活在
// `tools/check-market-entry.mjs` 里，那个工具 2026-10-20 退役了（草稿从 md 里的
// yaml 代码块改成独立 yml 文件后，它的抽取步骤永远找不到东西），检查没跟着一起
// 消失。上游 `validateEntries` 不判句号，但市场模板就是这么写的
// （contributing.md:11-18「One-line description ending with a period.」与
// 「一句话描述，以句号结尾。」），所以按模板对齐。
{
  const parsed = parseEntry(readFileSync(DRAFT_PATH, "utf8"));
  assert.ok(parsed.ok, `投稿副本不是合法 YAML：${parsed.error}`);
  const en = parsed.get("description.en") ?? "";
  const zh = parsed.get("description.zh") ?? "";
  assert.ok(
    en.endsWith("."),
    `投稿副本的 description.en 没有以英文句号结尾（市场模板要求一句话描述以句号结尾）：${en}`
  );
  assert.ok(
    zh.endsWith("。"),
    `投稿副本的 description.zh 没有以中文句号结尾（市场模板要求以句号结尾）：${zh}`
  );
}

console.log("market-entry.test.mjs: all checks passed");
