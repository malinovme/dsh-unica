// The preset checks that need a YAML parser, kept in one module so the CLI
// wrapper and the CI job share exactly one implementation.
//
// js-yaml is a dependency of the DSH installation, not of this plugin, so it is
// resolved from the ambient node_modules, from NODE_PATH, or from an explicit
// `searchDirs` list. Where it cannot be found the caller gets a clear error
// instead of a module-not-found stack.
import { readFileSync } from 'node:fs'
import { loadYaml, yamlWithJsTag } from './yaml.mjs'

/**
 * Parses and checks a generated preset composition.
 *
 * @param path - the preset's agent.cordis.yml
 * @param searchDirs - extra roots to resolve js-yaml from
 * @returns the parsed rows
 */
export function checkPreset(path, searchDirs = []) {
  const yaml = loadYaml(searchDirs)
  const schema = yamlWithJsTag(yaml)

  const doc = yaml.load(readFileSync(path, 'utf8'), { schema })
  if (!Array.isArray(doc)) throw new Error('the preset is not a list of rows')

  const ids = doc.map((r) => r.id)
  for (const id of ['persona', 'mcp-unica', 'skill-filesystem-unica']) {
    if (!ids.includes(id)) throw new Error(`row missing from the preset: ${id}`)
  }

  const persona = doc.find((r) => r.id === 'persona')
  const suffix = persona.config?.suffix ?? ''
  if (!suffix.includes('Your working directory is {{cwd}}.')) {
    throw new Error('the shipped persona suffix text was lost')
  }
  // A folded scalar that broke on indentation parses to different text, and the
  // rules would disappear without any error — hence checking the values.
  for (const needle of ['SourceSetNotFound', 'fullRebuild: true', 'Turnovers', 'Rights.xml', 'role.validate']) {
    if (!suffix.includes(needle)) throw new Error(`session rule lost from the persona suffix: ${needle}`)
  }

  const mcp = doc.find((r) => r.id === 'mcp-unica')
  if (!Array.isArray(mcp.config?.args) || !mcp.config.args.includes('--plugin-root')) {
    throw new Error('the mcp row lost its --plugin-root argument')
  }

  return { rows: doc.length, ids, suffix, command: mcp.config.command, args: mcp.config.args }
}
