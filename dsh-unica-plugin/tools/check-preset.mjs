// Validates a generated agent preset: it must parse as YAML, carry both port
// rows, and keep the session rules in the persona suffix.
//
//   node tools/check-preset.mjs <path-to-agent.cordis.yml> [js-yaml-root ...]
//
// Extra roots let CI resolve js-yaml from a /tmp install without touching the
// repository's own (absent) node_modules.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkPreset } from './lib/preset-checks.mjs'

const target = resolve(process.argv[2] ?? join(process.cwd(), '.ci-check', 'home', '.agent-presets', 'unica-1c', 'agent.cordis.yml'))
if (!existsSync(target)) {
  throw new Error(`preset not found: ${target}\nusage: node tools/check-preset.mjs <path-to-agent.cordis.yml>`)
}
const searchDirs = process.argv.slice(3).map((p) => resolve(p))

const result = checkPreset(target, searchDirs)
console.log(`preset      : ${target}`)
console.log(`rows        : ${result.rows}`)
console.log(`ids         : ${result.ids.join(', ')}`)
console.log(`mcp command : ${result.command}`)
console.log(`mcp args    : ${JSON.stringify(result.args)}`)
console.log(`rules kept  : SourceSetNotFound, fullRebuild, Turnovers, Rights.xml, role.validate`)
console.log('\nYAML, rows and session rules all verified')
