// Confirms the port notes landed intact: correct UTF-8, exactly one per skill,
// placed after the routing section, and with tool names already namespaced.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from this file, not from the cwd: the check runs both from the
// repository root and from inside dsh-unica-plugin, where CI invokes it.
const ROOT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills')
// Needles are checked against the FINAL text, where tool names already carry
// the mcp__unica__ namespace, so they must be written in that form.
const EXPECTED = {
  'unica-v8-runner': ['Правка порта', 'полная пересборка', 'fullRebuild: true', 'partial-list'],
  'unica-register-design': ['Правка порта', 'RegisterType', 'Turnovers', 'Balance'],
  'unica-role-compile': ['Правка порта', 'unica_role_edit', 'role.validate', 'already exists'],
  'unica-code-patch': ['Правка порта', 'cwd', 'SourceSetNotFound'],
}

let failures = 0
for (const [skill, needles] of Object.entries(EXPECTED)) {
  const file = join(ROOT, skill, 'SKILL.md')
  const text = readFileSync(file, 'utf8')

  const headingCount = (text.match(/^## Правка порта/gm) ?? []).length
  const headingAt = text.indexOf('## Правка порта')
  const routingAt = text.indexOf('## MCP routing')
  const order = routingAt !== -1 && headingAt > routingAt

  // A dotted reference surviving inside a port note means the note was inserted
  // after the rename instead of before it.
  const noteStart = headingAt
  const noteEnd = text.indexOf('\n## ', headingAt + 5)
  const note = text.slice(noteStart, noteEnd === -1 ? undefined : noteEnd)
  const unnamespaced = /(?<!mcp__unica__unica_[a-z_]{0,20})\bunica\.[a-z_]+\.[a-z_]+/g.test(note.replace(/unica\.(runtime|build)\.\*/g, ''))

  const misses = needles.filter((n) => !text.includes(n))
  const ok = headingCount === 1 && order && misses.length === 0 && !unnamespaced
  if (!ok) failures += 1

  console.log(`${ok ? 'ok  ' : 'FAIL'} ${skill}`)
  console.log(`       notes=${headingCount}  afterRouting=${order}  missing=${misses.join('|') || 'none'}  unnamespacedToolRef=${unnamespaced}`)
  // Show a slice with the Cyrillic actually decoded, to prove the encoding.
  const first = note.split('\n')[0]
  console.log(`       heading: ${first}`)
}

console.log(failures === 0 ? '\nall port notes verified' : `\n${failures} skill(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
