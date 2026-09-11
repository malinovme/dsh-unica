// Validates the generated preset the way DSH will read it: as YAML, with the
// port rules actually present in the persona suffix. A folded scalar that broke
// on indentation would parse to something other than the intended text, and the
// rules would be lost without any error.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

// The shipped preset carries `!!js` expressions (loader gates such as
// `disabled: !!js process.platform === 'win32'`). Plain js-yaml rejects the
// unknown tag, and stripping it would hide a genuinely broken document, so the
// tag is declared with a pass-through type instead.
const schema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: () => true,
    construct: (value) => ({ $js: value }),
  }),
])

const PRESET = resolve(
  process.argv[2] ?? join(process.cwd(), '.ci-check', 'home', '.agent-presets', 'unica-1c', 'agent.cordis.yml'),
)
if (!existsSync(PRESET)) throw new Error(`preset not found: ${PRESET}\nusage: node tools/check-preset.mjs <path-to-agent.cordis.yml>`)
const doc = yaml.load(readFileSync(PRESET, 'utf8'), { schema })

if (!Array.isArray(doc)) throw new Error('preset is not a list of rows')
const ids = doc.map((r) => r.id)
console.log('rows:', ids.length)
console.log('ids :', ids.join(', '))

const persona = doc.find((r) => r.id === 'persona')
if (persona === undefined) throw new Error('no persona row')
const suffix = persona.config?.suffix ?? ''
if (!suffix.includes('Your working directory is {{cwd}}.')) throw new Error('the shipped suffix text was lost')

const required = ['SourceSetNotFound', 'fullRebuild: true', 'Turnovers', 'Rights.xml', 'role.validate']
for (const needle of required) {
  const ok = suffix.includes(needle)
  console.log(`  ${ok ? 'ok     ' : 'MISSING'} ${needle}`)
  if (!ok) throw new Error(`port rule missing from the persona suffix: ${needle}`)
}

for (const id of ['mcp-unica', 'skill-filesystem-unica']) {
  if (!ids.includes(id)) throw new Error(`row missing: ${id}`)
}

const mcp = doc.find((r) => r.id === 'mcp-unica')
console.log('mcp command:', mcp.config.command)
console.log('mcp args   :', JSON.stringify(mcp.config.args))
console.log('\nYAML, rows and port rules all verified')
