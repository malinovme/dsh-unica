// Summarises the port's surface for documentation: tool domains from the live
// catalog and skill names grouped by prefix. Numbers here must match the shipped
// artifacts, so they are computed rather than hand-written.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = process.argv[2] ?? 'dsh-unica-plugin'
const catalog = JSON.parse(await readFile(join(ROOT, 'tools', 'tool-catalog.json'), 'utf8'))

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
const metadata = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).unica
assert.equal(catalog.length, metadata.mcpTools, 'package.json mcpTools differs from the catalog')
assert.equal(skills.length, metadata.skills, 'package.json skills differs from the catalog')
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
