/**
 * The submission draft against the LIVE marketplace entry — the half the
 * offline gate cannot see, and the only thing here that can.
 *
 * `test/plugin-locale.test.js` ('the submission draft says the same thing as the card') pins the draft to this repository's own copy:
 * `locale/en.json`, `locale/zh.json`, `package.json#description`. That fence is
 * deliberately blind to upstream, and its header says so — an internally
 * consistent draft that is stale against upstream passes it, because a red
 * caused by someone else's `main` is nobody's regression and that is how a gate
 * stops being read. This file is the other half: it asks the marketplace what
 * our entry actually says, and reports the difference.
 *
 * Why it needs a clock rather than a push:
 *
 *   - Upstream changes on upstream's schedule. A per-push run measures our
 *     commit cadence, not the maintainers' edit cadence — the one week the
 *     `category` disagreement went unseen is exactly that shape (the entry was
 *     re-filed, or a description was corrected, and nothing on our side was
 *     touched, so nothing on our side ran).
 *   - A red here is INFORMATION. It says: the entry moved. Read it, then either
 *     adopt the upstream text into the draft or re-open the PR. It never means
 *     "revert a commit to turn this green".
 *
 * So it lives in `.github/workflows/submission-drift.yml`, on a `schedule`, with
 * no `continue-on-error`: on a scheduled workflow GitHub mails the owner when a
 * run fails, which is the "shows up the day it happens" property a
 * `continue-on-error` job inside ci.yml promises and cannot deliver.
 *
 * What counts as a divergence, and what may be declared:
 *
 *   `url` / `name`   never declarable. A draft pointing at another repository is
 *                    a bug, full stop.
 *   `category`       declarable. The valid set lives in upstream
 *   `description.*`  `contributing.md` and the maintainers re-file entries as
 *                    maintenance, not as a correction of your judgement. A PR
 *                    in flight is a real, temporary divergence.
 *
 * A declaration lives in `awesome-dsh-plugin-submission/pending-drift.json` and
 * must name the exact pair it excuses plus the PR that ends it. It is checked
 * from BOTH sides: a divergence with no declaration is red, and a declaration
 * that no longer describes reality is ALSO red — either the PR landed (delete
 * the entry) or upstream moved somewhere else (the entry is now a lie). A
 * ledger that only ever grows is a mute button, and a mute button is the same
 * failure as `continue-on-error`.
 *
 *   node test/submission-drift.mjs                 # fetch upstream (needs the network)
 *   node test/submission-drift.mjs --from <dir>    # read data/plugins/*.yml from a checkout
 *
 * `--from` is not a test hook: when this reds at 03:43 you will want to
 * reproduce it against the file GitHub is showing you, and raw.githubusercontent
 * is blocked on plenty of corporate networks (this repository's own dev machine
 * included — `api.github.com` answers, `raw.` times out).
 */

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_REPO = "awesome-dsh-plugin/awesome-dsh-plugin";
const UPSTREAM_BRANCH = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_BRANCH}/data/plugins`;
const LEDGER_REL = "awesome-dsh-plugin-submission/pending-drift.json";
const TIMEOUT_MS = 20_000;
const ATTEMPTS = 3;

/** The fields this fence compares, in report order. Only these three may be
 *  declared in the ledger; `url` and `name` are identity, not judgement. */
const COMPARED = ["url", "name", "category", "description.en", "description.zh"];
const DECLARABLE = new Set(["category", "description.en", "description.zh"]);

// --- reading a submission file -------------------------------------------
//
// Scanned line by line rather than by regex, for the reason spelled out in the
// offline gate: inside a template literal `\s` is silently eaten as an escape,
// so the pattern that reaches the engine is `^url:s*(S+)s*$` — a matcher that
// can only ever fail to match, wrapped in a check that can only ever pass. And
// a single-quoted scalar escapes a quote by doubling it (`model''s` for
// `model's`), so unescape before comparing or every apostrophe reads as drift.
//
// Keep this parser identical to the offline gate's. The two tiers read the same
// bytes; if they read them differently they can contradict each other about one
// file, and then neither is believable.

function parseEntry(text) {
  const lines = text.split("\n").map((line) => line.trim());
  const scalar = (key) => {
    const prefix = `${key}: '`;
    const line = lines.find((c) => c.startsWith(prefix) && c.endsWith("'"));
    return line === undefined ? undefined : line.slice(prefix.length, -1).replaceAll("''", "'");
  };
  const field = (key) => {
    const prefix = `${key}: `;
    const line = lines.find((c) => c.startsWith(prefix));
    return line === undefined ? undefined : line.slice(prefix.length).trim();
  };
  return {
    url: field("url"),
    name: field("name"),
    category: field("category"),
    "description.en": scalar("en"),
    "description.zh": scalar("zh"),
  };
}

// --- reporting ------------------------------------------------------------

const SKIP_TAG = "SKIP submission-drift";

function summarise(lines) {
  const body = lines.join("\n");
  console.log(body);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, `\n### submission-drift\n\n\`\`\`\n${body}\n\`\`\`\n`);
    } catch {
      /* the step summary is a convenience; losing it must not change a verdict */
    }
  }
}

/** A skip is an environment fact, not a marketplace signal. It exits 0, the
 *  same shape as every other environment skip in this repository, but it
 *  prints the exact URL and the exact error and annotates the run, so a green
 *  scheduled job that never reached anything is visible as such instead of
 *  passing for a clean bill. */
function skip(reason, detail) {
  const lines = [
    `${SKIP_TAG} — ${reason}`,
    "",
    ...detail,
    "",
    "Nothing was compared. This is not a statement about the marketplace entry;",
    "it is a statement about this environment. Re-run once the network is back,",
    "or reproduce locally with `node test/submission-drift.mjs --from <checkout>/data/plugins`.",
  ];
  summarise(lines);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::warning title=submission-drift skipped::${reason}`);
  }
  process.exit(0);
}

/** Truncate around the first differing byte so a 400-character description
 *  reports the sentence that moved instead of 400 characters of eyeballing. */
function windowOf(value, other) {
  if (typeof value !== "string") return JSON.stringify(value);
  if (value.length <= 100) return JSON.stringify(value);
  let i = 0;
  while (i < value.length && i < other.length && value[i] === other[i]) i += 1;
  const start = Math.max(0, i - 30);
  const end = Math.min(value.length, i + 70);
  return `${start > 0 ? "…" : ""}${JSON.stringify(value.slice(start, end))}${end < value.length ? "…" : ""}`;
}

// --- the ledger -----------------------------------------------------------

function readLedger() {
  const path = join(ROOT, LEDGER_REL);
  if (!existsSync(path)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${LEDGER_REL} is not valid JSON: ${error.message}`);
  }
  const entries = parsed.entries ?? [];
  if (!Array.isArray(entries)) throw new Error(`${LEDGER_REL}: "entries" must be an array`);
  for (const [i, entry] of entries.entries()) {
    const at = `${LEDGER_REL} entries[${i}]`;
    if (!DECLARABLE.has(entry?.field)) {
      throw new Error(
        `${at}: field ${JSON.stringify(entry?.field)} cannot be declared. ` +
          `Declarable: ${[...DECLARABLE].join(", ")}. ` +
          `A wrong url or name is a bug, not an in-flight disagreement.`
      );
    }
    for (const key of ["upstream", "draft"]) {
      if (typeof entry[key] !== "string") throw new Error(`${at}: "${key}" must be a string`);
    }
    if (typeof entry.pr !== "string" || !entry.pr.startsWith("https://")) {
      throw new Error(`${at}: "pr" must be the URL of the change that ends this divergence`);
    }
  }
  return entries;
}

// --- the upstream side ----------------------------------------------------

function fetchTarget(file) {
  const fromIndex = process.argv.indexOf("--from");
  if (fromIndex !== -1) {
    const dir = process.argv[fromIndex + 1];
    if (dir === undefined) skip("--from needs a directory", ["  node test/submission-drift.mjs --from <checkout>/data/plugins"]);
    return { kind: "file", path: join(resolve(dir), `${file}.yml`), label: join(resolve(dir), `${file}.yml`) };
  }
  return { kind: "http", url: `${RAW_BASE}/${file}.yml`, label: `${RAW_BASE}/${file}.yml` };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function readUpstream(target) {
  if (target.kind === "file") {
    if (!existsSync(target.path)) {
      return { kind: "gone", label: target.label };
    }
    return { kind: "text", text: readFileSync(target.path, "utf8"), label: target.label };
  }

  let last = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(target.url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "dsh-submission-drift" },
      });
    } catch (error) {
      // No answer at all: DNS, a blocking proxy, a firewall. Returned at once
      // rather than retried — a host that does not answer does not answer the
      // second time either, and three timeouts would spend a minute learning
      // what the first one already said. 5xx below is the transient class and
      // is the only thing worth retrying.
      return { kind: "no-answer", label: target.url, why: `${error.name}: ${error.message}` };
    }
    if (response.status === 404) return { kind: "gone", label: target.url };
    if (response.status === 403 || response.status === 429) {
      // A shared runner IP hitting a rate limit says nothing about the entry.
      return { kind: "unavailable", label: target.url, why: `HTTP ${response.status} (rate limited)` };
    }
    if (response.status >= 500) {
      last = `HTTP ${response.status}`;
      if (attempt < ATTEMPTS) await sleep(2_000 * attempt);
      continue;
    }
    if (!response.ok) return { kind: "unavailable", label: target.url, why: `HTTP ${response.status}` };
    return { kind: "text", text: await response.text(), label: target.url };
  }
  return { kind: "unavailable", label: target.url, why: `${last} on ${ATTEMPTS} attempts` };
}

// --- main -----------------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const repoUrl = String(pkg.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
const slug = repoUrl.replace(/^https:\/\/github\.com\//, "");

// Without this, a package.json whose repository is missing or is not on GitHub
// would silently build the URL `<RAW_BASE>/.yml` and the run would report a
// gone entry — blaming the marketplace for a local manifest bug.
if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug)) {
  summarise([
    "submission-drift: package.json#repository is not a github.com owner/repo URL",
    "",
    `  repository: ${JSON.stringify(pkg.repository?.url ?? null)}`,
    `  derived:    ${JSON.stringify(slug)}`,
    "",
    "The upstream path is derived from that field, so nothing sensible can be",
    "asked. Fix the manifest before reading anything into this run.",
  ]);
  process.exit(1);
}

const file = slug.replace("/", "__");
const draftRel = `awesome-dsh-plugin-submission/${file}.yml`;

if (!existsSync(join(ROOT, draftRel))) {
  skip(`this repository ships no submission draft (${draftRel})`, [
    "There is nothing to compare against upstream. The draft directory exists to",
    "hold the text that was submitted; a repository without one has no live entry",
    "to drift from.",
  ]);
}

let ledger;
try {
  ledger = readLedger();
} catch (error) {
  summarise(["submission-drift: the pending-drift ledger is malformed", "", error.message]);
  process.exit(1);
}

const draft = parseEntry(readFileSync(join(ROOT, draftRel), "utf8"));
const target = fetchTarget(file);
const upstream = await readUpstream(target);

if (upstream.kind === "gone") {
  // Two very different failures share this shape, and conflating them sends the
  // reader to the wrong place: a 404 from upstream means the listing is gone,
  // while a missing file under `--from` means the path they typed is wrong (or
  // that checkout predates the entry). Nothing was asked of the marketplace in
  // the second case, so it must not claim an answer.
  const local = target.kind === "file";
  summarise([
    `submission-drift: ${local ? "no such file in the checkout you pointed --from at" : "the marketplace entry is GONE"}`,
    "",
    `  asked:    ${upstream.label}`,
    `  draft:    ${draftRel}`,
    "",
    ...(local
      ? [
          "`--from` reads a local checkout, so nothing was asked of the marketplace.",
          "Point it at `<checkout>/data/plugins` — the directory holding",
          "`<owner>__<repo>.yml` — or drop the flag to ask upstream over the network.",
        ]
      : [
          "Upstream answered, and there is no file at that path. The entry was removed",
          "or renamed — either way this repository's listing no longer exists in the",
          "marketplace. Check the upstream repository's history for the removal, then",
          "either re-submit the draft or delete it here so the offline gate stops",
          "pinning text nobody reads.",
        ]),
  ]);
  process.exit(1);
}

if (upstream.kind === "no-answer") {
  skip(`nothing answered at ${upstream.label} (${upstream.why})`, [
    `  asked:    ${upstream.label}`,
    "",
    "DNS did not resolve, a proxy refused, or the connection timed out. The file",
    "was never requested, so this run knows nothing about the entry — including",
    "whether it still exists.",
  ]);
}

if (upstream.kind === "unavailable") {
  skip(`the host answered without the file (${upstream.why})`, [
    `  asked:    ${upstream.label}`,
    "",
    "The request reached a server, but the answer was a rate limit or an outage",
    "rather than the entry. On a shared runner IP this is routine and says",
    "nothing about the marketplace.",
  ]);
}

const live = parseEntry(upstream.text);

const report = [
  `submission-drift: ${slug}`,
  `  draft:    ${draftRel}`,
  `  upstream: ${upstream.label}`,
  "",
];

const diverged = [];
for (const field of COMPARED) {
  if (draft[field] === live[field]) {
    report.push(`  ${field.padEnd(16)} identical`);
    continue;
  }
  diverged.push(field);
  report.push(`  ${field.padEnd(16)} DRIFT`);
  report.push(`  ${"".padEnd(16)} upstream: ${windowOf(live[field], draft[field] ?? "")}`);
  report.push(`  ${"".padEnd(16)} draft:    ${windowOf(draft[field], live[field] ?? "")}`);
}

const problems = [];

// A declaration has to describe a divergence that is actually there. If it does
// not, the entry has outlived its reason and is now just a comment.
for (const entry of ledger) {
  const actualUpstream = live[entry.field];
  const actualDraft = draft[entry.field];
  if (actualUpstream === actualDraft) {
    problems.push(
      `stale declaration: ${entry.field} now matches upstream (${JSON.stringify(actualUpstream)}). ` +
        `The change this entry excused has landed — delete it from ${LEDGER_REL}.`
    );
    continue;
  }
  if (entry.upstream !== actualUpstream || entry.draft !== actualDraft) {
    problems.push(
      `declaration no longer describes reality: ${entry.field} is declared as ` +
        `upstream ${JSON.stringify(entry.upstream)} → draft ${JSON.stringify(entry.draft)}, but it is now ` +
        `upstream ${JSON.stringify(actualUpstream)} → draft ${JSON.stringify(actualDraft)}. ` +
        `Upstream moved somewhere else; decide again and update ${LEDGER_REL}.`
    );
  }
}

// Every divergence needs a declaration, and identity fields can never have one.
for (const field of diverged) {
  const declared = ledger.find((entry) => entry.field === field);
  if (declared === undefined) {
    problems.push(
      DECLARABLE.has(field)
        ? `undeclared divergence on ${field}. Either adopt the upstream text into ${draftRel} ` +
          `(and then into locale/*.json + package.json, or the offline gate will red), or — if a PR ` +
          `is in flight — declare this exact pair in ${LEDGER_REL} with the PR that ends it.`
        : `${field} diverges and cannot be declared: the draft points somewhere other than this ` +
          `repository. Fix ${draftRel}.`
    );
  }
}

const declaredCount = diverged.filter((field) => ledger.some((entry) => entry.field === field)).length;

if (problems.length > 0) {
  report.push("");
  for (const problem of problems) report.push(`  ✗ ${problem}`);
  report.push("");
  report.push(`FAIL — ${problems.length} problem(s) against the live entry.`);
  summarise(report);
  process.exit(1);
}

if (diverged.length === 0) {
  report.push("");
  report.push("OK — the draft and the live entry say the same thing.");
  summarise(report);
  process.exit(0);
}

report.push("");
for (const field of diverged) {
  const entry = ledger.find((candidate) => candidate.field === field);
  report.push(`  declared: ${field} — ${entry.pr}`);
  if (entry.note) report.push(`            ${entry.note}`);
}
report.push("");
report.push(
  `OK — ${declaredCount} divergence(s), each declared and each with a PR that ends it. ` +
    `This run will red the day one of those PRs lands, so the declaration gets deleted.`
);
summarise(report);
