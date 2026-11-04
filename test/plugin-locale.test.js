/**
 * Guard the plugin's listing metadata against the 0.4.3 bug.
 *
 * Run: node --test test/plugin-locale.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * 0.4.3 rendered its own listing on the plugins page as a single mixed sentence:
 *
 *   将本机已登录的 Qoder（国内版 Qoder CN / 国际版 Qoder）模型接入 DeepSeek
 *   Harness —— bring locally signed-in Qoder models into DeepSeek Harness with
 *   zero configuration.
 *
 * Not a translation that had gone stale — that string was the `description`
 * field, ONE string containing both languages, and it was rendered verbatim in
 * every UI language. The plugin had also declared `displayName: "DSH Connect
 * Qoder"`, which DSH never reads: verified by grepping the whole `@deepseek-ai`
 * tree, `manifest.displayName` appears only in `dsh-llm-pi-ai` where it means a
 * model-provider name, not a package field. So the title fell back to the
 * package NAME and the description to that mixed string.
 *
 * WHAT THE HOST ACTUALLY DOES
 *
 * `readPluginMeta()` in dsh-app-boot resolves `<pkg>/locale/en.json`, treats the
 * file's BASENAME as the language id, and reads `meta.title` / `meta.description`
 * from every sibling `*.json`. The English file must exist to anchor the
 * directory — with no `en.json` there is no locale resolution at all. The
 * client then picks a language at render time. The fallback rule matters:
 *
 *     en: fallback ?? finalFallback     // fallback = package.json description
 *
 * so `package.json#description` becomes the ENGLISH rendering whenever a locale
 * file is present but carries no description. A bilingual value there is
 * therefore a real bug, not just untidy — it is what English users read.
 *
 * This file asserts the invariants that were violated, by replicating the host's
 * own resolution rather than by inspecting the files' shape.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const SPEC = pkg.name

/** A crude but sufficient test for "this string contains CJK". */
const hasCjk = (s) => /[\u3400-\u9fff\uf900-\ufaff]/.test(s)

/** Mirror of the host's `optionalResourcePath`. */
const optionalResourcePath = (spec) => {
  try {
    return require.resolve(spec)
  } catch {
    return undefined
  }
}

/**
 * Mirror of the host's `dictionariesOf` + `localizedText`.
 *
 * Reimplemented rather than imported because the host lives in the app's own
 * install; copying the RULE is what makes this test able to fail when the
 * package stops satisfying it.
 */
function readPluginMeta() {
  const englishPath = optionalResourcePath(`${SPEC}/locale/en.json`)
  if (englishPath === undefined) return undefined

  const dictionaries = new Map()
  for (const entry of readdirSync(dirname(englishPath), { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue
    const language = entry.name.slice(0, -5)
    assert.match(
      language,
      /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u,
      `${entry.name}: a locale file must be named after a language id — the host throws otherwise`,
    )
    const parsed = JSON.parse(readFileSync(join(dirname(englishPath), entry.name), 'utf8'))
    dictionaries.set(language.toLowerCase(), {
      title: parsed.meta?.title,
      description: parsed.meta?.description,
    })
  }

  const fallbackText = (v) => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
  const localizedText = (field, fallback, finalFallback) => {
    const entries = [...dictionaries].flatMap(([lang, fields]) => {
      const value = fields[field]
      return value === undefined ? [] : [[lang, value]]
    })
    if (entries.length === 0) return fallback
    return { en: fallback ?? finalFallback, ...Object.fromEntries(entries) }
  }

  const manifest = JSON.parse(readFileSync(optionalResourcePath(`${SPEC}/package.json`), 'utf8'))
  return {
    title: localizedText('title', fallbackText(manifest.name), SPEC),
    description: localizedText('description', fallbackText(manifest.description), ''),
  }
}

/** The client's `fallbackChain(active).reduceRight((r,l) => text[l] ?? r, text.en)`. */
function resolveText(text, active) {
  const chain = active.toLowerCase().startsWith('zh') ? ['zh', 'en'] : ['en']
  return chain.reduceRight((r, l) => text[l] ?? r, text.en)
}

test('the listing metadata is a locale map, not one mixed-language string', () => {
  const meta = readPluginMeta()

  assert.ok(meta !== undefined, 'no resolvable locale/en.json — the host would fall back to package.json')
  assert.equal(typeof meta.title, 'object', 'title is not localized')
  assert.equal(typeof meta.description, 'object', 'description is not localized')

  assert.ok('zh' in meta.description, 'no Chinese description was found')
  assert.ok('en' in meta.description, 'no English description was found')
})

test('no UI language renders both languages at once', () => {
  const meta = readPluginMeta()

  /**
   * Product names stay in Latin inside Chinese copy — "Qoder", "Harness",
   * "DSH", "PAT" all belong there and are not evidence of mixing. What IS
   * evidence is a run of English PROSE, so this looks for several consecutive
   * Latin words rather than any Latin character at all. The 0.4.3 string
   * failed on "bring locally signed-in Qoder models into".
   */
  const englishProse = /(?:\b[A-Za-z][a-z]{2,}\b[ ,]+){3,}/

  for (const lang of ['zh-CN', 'en-US', 'ja-JP', 'de-DE']) {
    const description = resolveText(meta.description, lang)

    if (lang.startsWith('zh')) {
      assert.equal(
        englishProse.test(description),
        false,
        `[${lang}] the description contains a run of English prose: ${description}`,
      )
    } else {
      assert.equal(
        hasCjk(description),
        false,
        `[${lang}] the description contains Chinese: ${description}`,
      )
    }
  }
})

test('Chinese and English actually differ', () => {
  const meta = readPluginMeta()
  // A locale file that repeats the English text would satisfy "no mixing" while
  // still showing English to Chinese users — the failure mode this catches.
  assert.notEqual(
    meta.description.zh,
    meta.description.en,
    'the zh description is identical to en — the translation is missing',
  )
  assert.ok(hasCjk(meta.description.zh), 'the zh description carries no Chinese')
  assert.equal(hasCjk(meta.description.en), false, 'the en description carries Chinese')
})

test('package.json#description is a safe fallback on its own', () => {
  /**
   * The fallback rule is `en: fallback ?? finalFallback`, so
   * `package.json#description` becomes the ENGLISH rendering whenever a locale
   * file is present but carries no description — and the sole rendering when no
   * locale file resolves at all (an older host, a tarball that lost `locale/`,
   * a `link:` install).
   *
   * Mutation-tested note: with good locale files this field is NOT what the user
   * sees, so a bilingual value here is invisible at runtime and the earlier
   * "no UI language renders both languages" test does not catch it. It is still
   * worth constraining, because it is the string that appears the moment locale
   * resolution fails — and a fallback that is itself bilingual turns a missing
   * translation into the exact bug this file exists for.
   */
  const englishProse = /(?:\b[A-Za-z][a-z]{2,}\b[ ,]+){3,}/

  assert.equal(
    englishProse.test(pkg.description) && hasCjk(pkg.description),
    false,
    `package.json#description is bilingual; it is the English text whenever locale resolution fails: ${pkg.description}`,
  )
})

test('the locale files ship in the published package', () => {
  // The host resolves them through `exports`, so a missing entry or a `files`
  // exclusion means the metadata silently reverts to package.json in the tarball
  // even though it works in the working tree.
  assert.ok(
    pkg.exports['./locale/*.json'] !== undefined,
    'package.json#exports has no "./locale/*.json" entry — the host cannot resolve the locale files',
  )
  assert.ok(
    pkg.files.includes('locale/*.json'),
    'package.json#files does not ship locale/*.json — the metadata would revert after publish',
  )
})

/**
 * The same listing copy lives in FOUR places, and nothing used to compare them.
 *
 *   locale/en.json                          the anchor the host resolves
 *   locale/zh.json                          the Chinese card
 *   package.json#description                the English fallback (a DIFFERENT
 *                                           string from en.json is the silent-
 *                                           English drift this file exists for)
 *   awesome-dsh-plugin-submission/*.yml     the draft copied into the marketplace
 *
 * In the sibling agnes repo the draft and the live marketplace entry had
 * disagreed about `category` for a week with no red build anywhere, while the
 * copy itself had already been edited twice through those two surfaces
 * separately. This is the OFFLINE half of that fence.
 *
 * What it cannot see is what the upstream entry actually says: an internally
 * consistent draft that is stale against upstream passes here, on purpose —
 * that is `test/submission-drift.mjs`, which needs the network and lives in the
 * scheduled tier. A red build caused by someone else's `main` is nobody's
 * regression, and that is how a gate stops being read.
 *
 * `category` is deliberately not asserted here: the valid set lives in the
 * upstream `contributing.md` and moves as the taxonomy splits, so a copy of it
 * in this repo would be the hardcoded-value drift class the docs gates forbid.
 */
test('the submission draft says the same thing as the card', () => {
  const en = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8')).meta.description
  const zh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8')).meta.description

  assert.equal(
    pkg.description, en,
    'package.json#description drifted from locale/en.json — that is the silent-English fallback',
  )

  const repoUrl = String(pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')
  const slug = repoUrl.replace(/^https:\/\/github\.com\//, '')
  const draftPath = join(root, 'awesome-dsh-plugin-submission', `${slug.replace('/', '__')}.yml`)

  // A repo without a draft has nothing to pin here; the directory exists to
  // hold the text that was submitted, not to be mandatory.
  if (!existsSync(draftPath)) return

  const draft = readFileSync(draftPath, 'utf8')
  // Scanned line by line rather than by regex on purpose: inside a template
  // literal `\s` is silently eaten as an escape, so the pattern that reaches
  // the engine is `^url:s*(S+)s*$` — a "gate" that can only ever pass. The
  // draft has a dozen fields; finding them is cheaper than escaping them.
  //
  // A single-quoted scalar escapes a quote by doubling it: the file holds
  // `model''s` for `model's`, so unescape before comparing — otherwise every
  // apostrophe in the copy reads as drift.
  const lines = draft.split('\n').map((line) => line.trim())
  const scalar = (key) => {
    const prefix = `${key}: '`
    const line = lines.find((candidate) => candidate.startsWith(prefix) && candidate.endsWith("'"))
    return line === undefined ? undefined : line.slice(prefix.length, -1).replaceAll("''", "'")
  }
  const field = (key) => {
    const prefix = `${key}: `
    const line = lines.find((candidate) => candidate.startsWith(prefix))
    return line === undefined ? undefined : line.slice(prefix.length).trim()
  }

  assert.ok(
    scalar('en') !== undefined && scalar('zh') !== undefined,
    'the draft is missing one of description.en / description.zh, or they are not single-quoted scalars',
  )
  assert.equal(field('url'), repoUrl, 'the draft points at a different repository')
  assert.equal(field('name'), slug, 'the draft is named after a different repository')
  assert.equal(scalar('en'), en, 'edit one, edit both — the marketplace and the card are the same sentence')
  assert.equal(scalar('zh'), zh, 'edit one, edit both — the marketplace and the card are the same sentence')
})
