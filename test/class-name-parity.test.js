/**
 * Position gate #3 — the card's class names must line up with its stylesheet
 * in BOTH directions.
 *
 * Run: node --test test/class-name-parity.test.js
 *
 * `card.tsx` and its two panels put `dsm-qoder-*` / `dsm-plugin-card-*` classes
 * on the DOM, and `styles.ts` is the only place they are styled. Neither
 * direction is safe to drift:
 *
 * - a class applied to the DOM but never defined in `styles.ts` is SILENTLY
 *   unstyled — the node renders, the modifier does nothing, and nothing flags
 *   it. That is exactly the `.dsm-qoder-badge-offer` bug this gate caught on
 *   its first run: `card.tsx` applied it to the off-peak badge, `styles.ts`
 *   had never defined it, so an active promotion looked identical to a normal
 *   badge. `typecheck` could not see it; a status code could not see it.
 * - a style rule never applied to anything is dead CSS, and it invites a later
 *   reader to trust a name that no DOM node carries.
 *
 * The "referenced" set is read from STRING and TEMPLATE literals only, so a
 * class name that appears in a comment does not count as a usage. `styles.ts`
 * is excluded from that scan: it is the definition source, and its own strings
 * name the `@keyframes` animations (`dsm-qoder-shimmer`, `dsm-qoder-flash`) —
 * those are animation names, not class names, and would otherwise look like
 * usages.
 *
 * WHY THE SCAN IS AN AST WALK
 *
 * The first version of this gate matched literals with a regex over the raw
 * text. That is unsound in BOTH directions, and both directions have bitten:
 *
 * - a class name inside a comment was counted as a usage, which is the exact
 *   thing this gate exists to prevent (a comment can keep dead CSS alive);
 * - a comment containing an ASCII quote shifted the quote pairing, so real
 *   usages were swallowed into comment text and reported as "never applied".
 *   The card's own comments are full of quoted phrases ("am I signed in for
 *   this edition?"), so this was waiting for the first comment that unbalances
 *   the count.
 *
 * The TypeScript compiler already knows where a comment ends and a string
 * begins, so the literals are read from the AST instead of guessed from the
 * text. `typescript` is a devDependency of this repository and the import is
 * deliberately NOT optional: a gate that cannot run must fail loudly, never
 * skip (the slot-gate lesson in `.github/workflows/test.yml`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const CLASS_TOKEN = /(dsm-(?:qoder|plugin-card)[-\w]+)/g

/**
 * Every string or template literal in one source file.
 *
 * A template literal contributes its quasis (the text around each `${}`); the
 * expressions between them are walked as ordinary children, so a class name
 * inside an interpolation is still seen.
 */
function literals(source, fileName) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const out = []
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text)
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      out.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out
}

/** The dsm-* class tokens of every literal in one source file. */
function classesIn(source, fileName) {
  const out = new Set()
  for (const lit of literals(source, fileName)) {
    for (const m of lit.matchAll(CLASS_TOKEN)) out.add(m[1])
  }
  return out
}

/** Class names applied by the client source (all files but `styles.ts`). */
function referencedClasses() {
  const out = new Set()
  for (const f of readdirSync(join(root, 'src/client'))) {
    if (f === 'styles.ts') continue
    if (!/\.(?:ts|tsx)$/.test(f)) continue
    for (const c of classesIn(read(`src/client/${f}`), f)) out.add(c)
  }
  return out
}

/**
 * Class selectors defined in the stylesheet's string table.
 *
 * A rule string starts with its selector, so `.dsm-…` right at the front of a
 * literal is a class. `@keyframes dsm-qoder-shimmer` does not start with a dot
 * and is an animation name, not a class — it is deliberately not picked up.
 */
function definedClasses() {
  const out = new Set()
  for (const lit of literals(read(STYLES), 'styles.ts')) {
    const m = /^\.((?:dsm-qoder|dsm-plugin-card)[-\w]+)/.exec(lit)
    if (m !== null) out.add(m[1])
  }
  return out
}

const STYLES = 'src/client/styles.ts'

test('every class the card puts on the DOM is styled', () => {
  const used = referencedClasses()
  const defined = definedClasses()
  const missing = [...used].filter((c) => !defined.has(c))
  assert.deepEqual(
    missing,
    [],
    `these classes are applied but have no style rule: ${missing.join(', ')}`,
  )
})

test('every style rule is applied by the card', () => {
  const used = referencedClasses()
  const defined = definedClasses()
  const orphan = [...defined].filter((c) => !used.has(c))
  assert.deepEqual(
    orphan,
    [],
    `these style rules are never applied by the card: ${orphan.join(', ')}`,
  )
})
