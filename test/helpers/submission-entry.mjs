/**
 * submission-entry.mjs — 投稿副本 YAML 的共享解析器（真 YAML）。
 *
 * 两个门禁读同一份字节：离线的 `test/market-entry.test.mjs`（本文件 serve 的
 * 合规门禁）与本仓自己的同源门禁（`test/plugin-locale.test.js` 的投稿副本块），还有联网的
 * `test/submission-drift.mjs`（投稿 vs 市场线上条目）。它们必须对同一个文件
 * 给出同一个读法——两处各写一份、只靠一句注释要求「Keep identical」治不住
 * 漂移，共用一份实现才能让「相同」成为结构事实而不是纪律。
 *
 * **但本仓还没有完全做到**：联网的 `test/submission-drift.mjs` 仍带着它自己
 * 那份行扫描解析器（第 85 行），本轮**没有**切换它（切换要动联网门禁，而本仓
 * 没有它的离线夹具套件）。两份读法并存期间，同一份稿子可能被两个门禁读出不同
 * 结果——这是**已知缺口**，不是「已经治好了」。
 *
 * ## 为什么用真 YAML 解析器（js-yaml）
 *
 * 市场的真值就是 YAML：上游仓库 `scripts/lib/entries.mjs` 第 8 行
 * `import { load as yamlLoad } from 'js-yaml'`，第 86 行用它读每个条目文件，
 * 解析失败时抛的提示原文是「A description containing ": " must be quoted」。
 * 换句话说，**市场用 js-yaml 说话**，不是我们习惯的那种写法。
 *
 * 本仓那份自制解析器还在（`test/submission-drift.mjs` 第 85 行）：只认单引号
 * 标量、只认第一处 `en: ` 匹配。拿真解析器（js-yaml 5.5.0）当基准，同族仓
 * modelscope 量过 10 个构造场景——只有 4 个读数一致，5 个不一致，而且**两个
 * 方向都不利**：
 *
 *   - **假红**（真值有值，自制读成 undefined → 判成一次漂移）：无引号 plain
 *     scalar（市场自己的模板就是这种，`contributing.md` 第 16 行
 *     `en: One-line description ending with a period.`）、双引号标量、语义相同
 *     但带引号的 category。
 *   - **假绿**（真值不同，自制却读到同一个值 → 真漂移被吞，EXIT=0）：上游在
 *     `description:` 之前另有一行顶层 `en:` 时，自制取第一处匹配就绕过了真正
 *     的 `description.en`。
 *
 * 还有一条更贵的：自制解析器读不出上游的 plain scalar 时，四条逃生通道（维持
 * 现状 / 采纳上游文字 / 台账声明 upstream=null / 台账声明上游文字）**全部判红**
 * ——门禁建议「采纳上游写法」，而采纳之后离线门禁又红。根因不是建议写错了，
 * 是「读不出」和「读到了 undefined」不可区分。
 *
 * 本文件把真解析器备好：市场用 js-yaml 说话（上游 `scripts/lib/entries.mjs`
 * 第 8 行 `import { load as yamlLoad } from 'js-yaml'`），我们也就用 js-yaml
 * 说话——比较的是**语义**（解析后的字符串），不是写法：上游用 plain scalar、
 * 本仓用单引号，说的是同一句话就算一致。
 *
 * ## 三态：读不出 ≠ 相同，也 ≠ 不同
 *
 * `parseEntry` 不把「读不出」和「读到了空」混成一件事：
 *
 *   ok=true  → YAML 合法；`get(field)` 返回字符串，或 undefined（键不存在/
 *              不是字符串——是「读不出」）
 *   ok=false → YAML 不合法；`error` 里是解析器的原话；此时任何 `get` 都是
 *              undefined，但调用方必须先看 `ok`，否则又会退回「读不出＝相同」
 *
 * 字段级的 same / differs / unknown 是联网那一半（`test/submission-drift.mjs`）
 * 的事：unknown 不是失败，是「不知道」——它要么被台账声明掉（`"upstream": null`
 * 表示上游根本没这个字段），要么按字段类别硬错（市场要求存在的字段缺失 = 上游
 * 条目坏了）。
 *
 * @module test/helpers/submission-entry
 */

import { createRequire } from "node:module";

// 市场的解析器就是 js-yaml（上游 `scripts/lib/entries.mjs` 第 8 行）。本仓用
// 同一个，免得我们说的和市场说的不是一件事。
//
// 用 createRequire 而不是 import，是为了让「依赖没装」有一句能读懂的诊断：
// ESM 的静态 import 只会甩一句 ERR_MODULE_NOT_FOUND，而这里的读者多半是
// 在别人的机器上第一次跑这个门禁。
const require = createRequire(import.meta.url);

/** @type {{ load: (text: string) => any }} */
let yaml;
try {
  yaml = require("js-yaml");
} catch {
  throw new Error(
    "js-yaml is not installed. The marketplace parses entries with js-yaml " +
      "(upstream scripts/lib/entries.mjs), and these gates read YAML with that same " +
      "parser so that what we compare is what the market sees. Run `npm install`."
  );
}

/**
 * 从 YAML 文档里取一个字段的值。
 *
 * 字段名有两种形状：顶层键（url / name / category）与 `description.<locale>`
 * （市场的结构是 `description:` 下面一个 locale 映射，上游
 * `scripts/lib/entries.mjs` 第 192 行读的就是 `e.description?.[loc]`）。
 *
 * 取不到（键不存在、值不是字符串、description 不是映射）返回 undefined——
 * 这是「读不出」，和「读到了空字符串」是两件事，别混。
 *
 * @param {Record<string, any>} doc
 * @param {string} field
 * @returns {string | undefined}
 */
function readField(doc, field) {
  if (field.startsWith("description.")) {
    const locale = field.slice("description.".length);
    const descriptions = /** @type {Record<string, any>} */ (doc.description);
    if (!descriptions || typeof descriptions !== "object" || Array.isArray(descriptions)) {
      return undefined;
    }
    const value = descriptions[locale];
    return typeof value === "string" ? value : undefined;
  }
  const value = doc[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * 解析一份投稿 YAML。
 *
 * @param {string} text 文件全文
 * @returns {{ ok: true, error: null, doc: Record<string, any>,
 *             get: (field: string) => string | undefined }
 *           | { ok: false, error: string, doc: null,
 *             get: (field: string) => string | undefined }}
 */
export function parseEntry(text) {
  /** @type {Record<string, any> | null} */
  let doc = null;
  try {
    doc = yaml.load(String(text));
  } catch (error) {
    // `useUnknownInCatchVariables` is on in this repo, so the caught value
    // stays `unknown` until it is narrowed — the cast is the narrowing.
    const cause = /** @type {any} */ (error);
    const reason = cause?.reason ?? cause?.message ?? String(cause);
    return {
      ok: false,
      error: `YAML 解析失败：${reason}`,
      doc: null,
      get: () => undefined,
    };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    const shape = doc === null ? "空" : Array.isArray(doc) ? "数组" : typeof doc;
    return {
      ok: false,
      error: `顶层不是映射（读到 ${shape}）——市场要的是 url/name/category/description 四个键的映射`,
      doc: null,
      get: () => undefined,
    };
  }
  // A `const` keeps the narrowed type inside the closure: a captured `let`
  // would be read as the declared type (nullable) again.
  const parsed = doc;
  return {
    ok: true,
    error: null,
    doc: parsed,
    get: (field) => readField(parsed, field),
  };
}
