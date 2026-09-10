// Guards the port against the failure mode the analysis pipeline hit: a bad
// UTF-8 round-trip during a copy/concatenate step turns Russian text into
// mojibake. The ported skills are ~99% Russian prose, so this is a real risk
// for the deliverable, and a byte-level check is cheap.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const MARKERS = ['Р Рµ', 'РѕРІ', 'РёСЏ', 'Р°РЅ', 'вЂ', 'Ð', 'Ñ', 'â€', 'Ã']

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (/[.](md|json|ya?ml|txt)$/i.test(e.name)) yield p
  }
}

let total = 0
let bad = 0
let cyrillicFiles = 0
const hits = []
for (const dir of process.argv.slice(2)) {
  for await (const file of walk(dir)) {
    total += 1
    const text = await readFile(file, 'utf8')
    if (/[\u0400-\u04FF]/.test(text)) cyrillicFiles += 1
    const found = MARKERS.filter((m) => text.includes(m))
    if (found.length > 0) {
      bad += 1
      if (hits.length < 5) hits.push(`${file} :: ${JSON.stringify(found)}`)
    }
  }
}
console.log(`files scanned      : ${total}`)
console.log(`files with Cyrillic: ${cyrillicFiles}`)
console.log(`files with mojibake: ${bad}`)
for (const h of hits) console.log(`  ${h}`)
process.exitCode = bad === 0 ? 0 : 1
