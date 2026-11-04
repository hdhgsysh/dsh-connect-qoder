/**
 * market-rules.mjs — 市场的**条目规则**镜像（上游 `scripts/lib/entries.mjs`）。
 *
 * ## 这份文件解决什么
 *
 * 投稿副本以前**从未**被市场的规则校验过：本仓只有「副本与文案同源」这一道门禁
 * （`test/plugin-locale.test.js` 的投稿副本块），判的是「副本 == locale/*.json == package.json
 * 的 description」，不是「这份文件市场收不收」。
 *
 * 而市场的收件闸在**合入之后**才跑形状检查：
 *
 *   - PR 闸 `scripts/check-submission.mjs`（`.github/workflows/pr-gate.yml` 的
 *     「Check submitted entries」）只做两件事：用 `readEntries` 解析 YAML（解析失败
 *     才报错，提示原文「A description containing ": " must be quoted」），以及仓库
 *     层面的检查（仓库年龄、归档、bundle manifest、每 PR 条数上限）。**它不校验条目
 *     的形状。**
 *   - 形状规则在 `scripts/lib/entries.mjs` 的 `validateEntries` 里，唯一的调用方是
 *     `scripts/generate-readme.mjs`（第 95–99 行）：有 problem 就打印并
 *     `process.exit(1)`，原话是「refusing to generate」。README 是合入 main 之后
 *     重新生成的。
 *
 * 也就是说：**一份形状不合规的稿子可以过 PR 闸，然后在合入后打断市场的 README
 * 生成**。我们宁可在自己这边红。
 *
 * ## 这份镜像的边界（别把它当市场源码的同步副本）
 *
 * - 规则是**手抄**的：上游改了类别表、键白名单或描述规则，这份镜像就会过期。
 *   过期了不会立刻出事——顶多是我们少查一条、多查一条——但它会**静悄悄地**过期。
 *   本仓目前没有任何机制发现它（上游的 `scripts/lib/entries.mjs` 只能联网取，
 *   而离线门禁是零网络的）。这是已知缺口，不假装没有。
 * - 抄的时候**尽量逐字**抄上游的判据与措辞：出问题时要能拿我们的输出和市场的
 *   输出对照，措辞对不上会让排查变难。
 * - 上游只抄了**单个条目**相关的规则：跨条目的重复 url 检查（`seen` 映射）在
 *   `validateEntries` 里，本仓只有一条投稿，用不上，因此不抄。
 *
 * @module test/helpers/market-rules
 */

import { parseEntry } from "./submission-entry.mjs";

/** 上游 `scripts/lib/entries.mjs` 第 145 行：条目文件允许带的键。 */
export const ENTRY_KEYS = new Set(["url", "name", "category", "description", "tarball", "file"]);

/** 上游第 20 行：站点渲染的 locale。 */
export const LOCALE_CODES = ["en", "zh"];

/** 上游第 21 行：只有这个 locale 是投稿人的责任。 */
export const BASE_LOCALE = "en";

/** 上游第 27 行：category 的合法取值（顺序即站点章节顺序）。 */
export const CAT_IDS = [
  "agi",
  "ui",
  "usage",
  "theme",
  "model",
  "identity",
  "session",
  "memory",
  "tools",
  "wsl",
  "browser",
  "vision",
  "voice",
  "docs",
  "skill",
  "workflow",
  "git",
  "notify",
  "dev",
  "security",
  "remote",
  "market",
  "fun",
];

/** 上游第 113 行：tarball 只认 GitHub 自己的发布托管。 */
const TARBALL_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);

/**
 * 上游第 60–66 行：`https://github.com/o/r` → `o__r`；`.../tree/main/packages/x`
 * → `o__r--packages-x`。
 *
 * @param {string} url
 * @returns {string}
 */
export function slugFor(url) {
  const p = String(url).replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, "");
  const repo = p.split("/").slice(0, 2).join("/");
  const sub = p.includes("/tree/") ? p.split("/tree/").slice(1).join("/").replace(/^[^/]+\//, "") : null;
  const base = repo.replaceAll("/", "__");
  return sub ? `${base}--${sub.replaceAll("/", "-")}` : base;
}

/**
 * 上游第 116–128 行：返回一个 tarball URL 的问题描述，合规返回 null。
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function tarballProblem(value) {
  if (typeof value !== "string" || !value.trim()) return "must be a URL string";
  let u;
  try {
    u = new URL(value);
  } catch {
    return `is not a valid URL: ${value}`;
  }
  if (u.protocol !== "https:") return "must be https";
  if (!TARBALL_HOSTS.has(u.hostname)) return `must be hosted on GitHub releases (got ${u.hostname})`;
  if (u.hostname === "github.com" && !u.pathname.includes("/releases/")) return "must point at a GitHub release asset";
  if (!u.pathname.endsWith(".tgz") && !u.pathname.endsWith(".tar.gz")) return "must point at a .tgz";
  return null;
}

/**
 * 取路径的文件名并去掉 .yml 后缀（上游用 path.basename(file, '.yml')）。
 *
 * @param {unknown} file
 * @returns {string}
 */
function stemOf(file) {
  const base = String(file).split(/[\\/]/).pop() ?? "";
  return base.endsWith(".yml") ? base.slice(0, -4) : base;
}

/**
 * 校验**一条**条目，返回问题清单（空数组 = 合规）。
 *
 * 判据抄自上游 `validateEntries`（第 148–227 行）里与单条相关的部分：
 *
 *   - 未知字段（第 153–160 行）——`npm:` 这类键没有任何代码读，却看起来很有分量；
 *     上游为此专门拒过（#1775）。
 *   - url 必须是 https://github.com/owner/repo（第 162–164 行），不合法就**不再查
 *     别的**（上游是 `continue` 到下一条，这里对应 `return`）。
 *   - 文件名必须与 url 对得上（第 169–172 行）。
 *   - name 必填；name 写成 owner/repo 时必须与 url 指同一个仓库（第 173–187 行）——
 *     链接文字说什么就该指向什么。
 *   - category 必须在 CAT_IDS 里（第 188–190 行）。
 *   - description.en 必填、不能为空、必须单行；description.zh 给了就不能是空串
 *     （第 191–201 行）；没给不算错（维护者会补，第 193 行）。
 *   - description 里出现站点不渲染的 locale 也不行（第 208–216 行）。
 *   - tarball 给了就得是 GitHub 发布托管上的 .tgz（第 221–224 行）。
 *
 * @param {Record<string, any>} doc 已解析的条目（YAML 顶层映射）
 * @param {{ file?: string }} options file = 条目文件路径/文件名，用于文件名与
 *   「问题出在哪个文件」两处检查
 * @returns {string[]} 问题清单，空 = 合规
 */
export function validateEntry(doc, { file } = {}) {
  /** @type {string[]} */
  const problems = [];
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return ["(unknown): the entry is not a mapping"];
  }
  const at = file ?? (typeof doc.url === "string" ? doc.url : "(unknown)");

  const extra = Object.keys(doc).filter((k) => !ENTRY_KEYS.has(k));
  if (extra.length) {
    problems.push(
      `${at}: unknown field${extra.length > 1 ? "s" : ""} ${extra.map((k) => `"${k}"`).join(", ")} — ` +
        `an entry may only declare ${[...ENTRY_KEYS].filter((k) => k !== "file").join(", ")}. ` +
        "Nothing reads anything else, so it would sit in the file looking meaningful without being so. " +
        "The npm package is resolved automatically from the repository, not declared here."
    );
  }

  if (typeof doc.url !== "string" || !/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(doc.url)) {
    problems.push(`${at}: "url" must be a https://github.com/owner/repo link`);
    return problems;
  }

  if (file) {
    const want = slugFor(doc.url);
    if (stemOf(file) !== want) {
      problems.push(`${at}: filename must match the url — expected ${want}.yml`);
    }
  }

  // `split("#")[0]` is `string | undefined` under noUncheckedIndexedAccess,
  // and it is never undefined in practice (split always returns at least one
  // element) — so the fallback below only satisfies the checker, it never fires.
  const nameText = typeof doc.name === "string" ? (doc.name.split("#")[0] ?? "") : "";
  if (typeof doc.name !== "string" || !doc.name.trim()) {
    problems.push(`${at}: "name" is required`);
  } else if (nameText.includes("/")) {
    const named = nameText.trim().toLowerCase();
    const actual = doc.url.replace(/^https:\/\/github\.com\//, "").split("/").slice(0, 2).join("/").toLowerCase();
    if (named !== actual) {
      problems.push(
        `${at}: "name" says ${nameText.trim()} but the url is ` +
          `${doc.url.replace(/^https:\/\/github\.com\//, "").split("/").slice(0, 2).join("/")} — ` +
          "the name is the link text, so it must name the repository the link goes to"
      );
    }
  }

  if (!CAT_IDS.includes(doc.category)) {
    problems.push(`${at}: "category" must be one of ${CAT_IDS.join(", ")} (got ${JSON.stringify(doc.category)})`);
  }

  for (const loc of LOCALE_CODES) {
    const d = doc.description?.[loc];
    if (d === undefined && loc !== BASE_LOCALE) continue;
    if (typeof d !== "string" || !d.trim()) {
      problems.push(
        loc === BASE_LOCALE
          ? `${at}: "description.${BASE_LOCALE}" is required`
          : `${at}: "description.${loc}" is present but empty — omit the key instead`
      );
    } else if (d.includes("\n")) {
      problems.push(`${at}: "description.${loc}" must be a single line`);
    }
  }

  if (doc.description && typeof doc.description === "object" && !Array.isArray(doc.description)) {
    const extraLocales = Object.keys(doc.description).filter((k) => !LOCALE_CODES.includes(k));
    if (extraLocales.length) {
      problems.push(
        `${at}: "description" has ${extraLocales.map((k) => `"${k}"`).join(", ")}, ` +
          `but the site renders only ${LOCALE_CODES.join(" and ")} — remove the extra key(s)`
      );
    }
  }

  if (doc.tarball !== undefined) {
    const bad = tarballProblem(doc.tarball);
    if (bad) problems.push(`${at}: "tarball" ${bad}`);
  }

  return problems;
}

/**
 * 解析并校验一份投稿 YAML。
 *
 * @param {string} text 文件全文
 * @param {{ file?: string }} options 传给 validateEntry 的选项
 * @returns {{ ok: boolean, error: string | null, problems: string[] }}
 *   ok=false 表示 YAML 本身不合法（市场会拒收），error 里是解析器的原话；
 *   problems 非空表示形状不合规（市场的 README 生成会拒绝）。
 */
export function checkEntry(text, options = {}) {
  const parsed = parseEntry(text);
  if (!parsed.ok) return { ok: false, error: parsed.error, problems: [] };
  return { ok: true, error: null, problems: validateEntry(parsed.doc, options) };
}
