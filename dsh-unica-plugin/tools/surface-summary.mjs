// Summarises the port's surface for documentation: tool families from the map
// and skill names grouped by prefix. Numbers here must match the shipped
// artifacts, so they are computed rather than hand-written.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = process.argv[2] ?? 'dsh-unica-plugin'
// The map is what the skills actually reference. The 74-tool `tool-catalog.json`
// that used to sit in tools/ described a surface upstream no longer has.
const map = JSON.parse(await readFile(join(ROOT, 'tool-map.json'), 'utf8'))
const catalog = Object.keys(map).map((name) => ({ name }))

const byDomain = new Map()
for (const t of catalog) {
  const parts = t.name.split('.')
  const domain = parts.length >= 3 ? parts.slice(0, 2).join('.') : parts[0]
  if (!byDomain.has(domain)) byDomain.set(domain, [])
  byDomain.get(domain).push(t.name)
}
console.log(`TOOLS: ${catalog.length} in ${byDomain.size} domains`)
for (const [d, list] of [...byDomain].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${d.padEnd(24)} ${String(list.length).padStart(2)}  ${list.join(', ')}`)
}

const skills = []
for (const e of await readdir(join(ROOT, 'skills'), { withFileTypes: true })) {
  if (e.isDirectory()) skills.push(e.name.replace(/^unica-/, ''))
}
skills.sort()
console.log(`\nSKILLS: ${skills.length}`)
console.log(skills.join(', '))

// The frontmatter description is the skill's own one-line pitch; a sample makes
// the usage section concrete instead of invented.
console.log('\nSaMple descriptions:')
for (const name of ['meta-info', 'form-compile', 'code-diagnostics', 'v8-runner', 'metadata-modeling']) {
  const p = join(ROOT, 'skills', `unica-${name}`, 'SKILL.md')
  try {
    const text = await readFile(p, 'utf8')
    const m = text.match(/^description:\s*(.+)$/m)
    if (m) console.log(`  ${name}: ${m[1].slice(0, 150)}`)
  } catch {
    /* skill absent */
  }
}
