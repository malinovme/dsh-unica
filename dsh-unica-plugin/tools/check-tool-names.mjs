// Confirms every tool name a skill mentions is one the map resolves.
//
//   node tools/check-tool-names.mjs
//
// This replaces the 0.12 check that proved the four port corrections survived a
// rebuild. Those corrections patched skills that 0.13 removed, and the tools they
// described (`role.edit`, `meta.add`, `role.compile`, `v8-runner`) do not exist on
// the new surface — so the correction check had nothing left to look at.
//
// What it was really protecting is worth keeping: a skill must never tell the
// model to call a tool that does not exist. `build-skills.mjs` enforces that while
// generating, from upstream; this checks the committed result, so a hand edit or a
// stale copy is caught in CI where no upstream checkout is available.
import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const map = JSON.parse(readFileSync(join(ROOT, 'tool-map.json'), 'utf8'))
const known = new Set(Object.values(map))
const rawNames = Object.keys(map)

let files = 0
let references = 0
const problems = []

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name.endsWith('.md')) inspect(path)
  }
}

function inspect(path) {
  files += 1
  const text = readFileSync(path, 'utf8')
  for (const match of text.matchAll(/\bmcp__unica__[A-Za-z0-9_]+/g)) {
    references += 1
    if (!known.has(match[0])) problems.push(`${path}: unknown public tool name ${match[0]}`)
  }
  // A dot-form name is what upstream writes; in the committed tree it means the
  // rewrite never happened, and the model would call a tool DSH does not expose.
  for (const match of text.matchAll(/\bunica\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+/g)) {
    if (rawNames.includes(match[0])) problems.push(`${path}: raw tool name left unrewritten: ${match[0]}`)
  }
}

walk(join(ROOT, 'skills'))

console.log(`skills scanned    : ${files} files`)
console.log(`tool references   : ${references}`)
console.log(`map entries       : ${rawNames.length}`)
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`)
  for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`)
  process.exit(1)
}
console.log('names             : every reference resolves')
