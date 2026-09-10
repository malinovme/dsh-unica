// Proves every relative `references/` citation in the ported skills resolves to
// a real file. A spot check is not enough: the corpus is cited from 26 different
// skill directories, and one missing file degrades exactly one skill silently.
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'

const ROOT = resolve(process.argv[2] ?? 'dsh-unica-plugin')

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (/\.(md|json|ya?ml|txt)$/i.test(e.name)) yield p
  }
}

let checked = 0
const broken = []
const seen = new Set()
for await (const file of walk(join(ROOT, 'skills'))) {
  const text = await readFile(file, 'utf8')
  for (const m of text.matchAll(/\.\.\/[A-Za-z0-9._/-]*references\/[A-Za-z0-9._/-]+/g)) {
    const target = resolve(dirname(file), m[0])
    checked += 1
    seen.add(m[0])
    if (!existsSync(target)) broken.push(`${relative(ROOT, file)} -> ${m[0]}`)
  }
}

console.log(`citations checked : ${checked}`)
console.log(`distinct targets  : ${seen.size}`)
console.log(`broken            : ${broken.length}`)
for (const b of broken.slice(0, 20)) console.log(`  BROKEN ${b}`)
process.exitCode = broken.length === 0 ? 0 : 1
