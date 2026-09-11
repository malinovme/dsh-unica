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
  const args = mcp.config?.args
  if (!Array.isArray(args) || args.length === 0) throw new Error('the mcp row lost its args')
  // The launch shape is platform-dependent, so the argument that proves the
  // plugin root reached the command differs: Windows execs the bootstrap with
  // `run --plugin-root <root>`, while POSIX runs `sh launch.sh <root>` and the
  // script derives the rest itself. Accepting only the Windows shape made this
  // check pass locally and fail on the runner.
  const command = mcp.config?.command ?? ''
  const carriesRoot =
    command.endsWith('unica-bootstrap.exe')
      ? args.includes('--plugin-root')
      : command === 'sh'
        ? args.some((a) => a.endsWith('launch.sh'))
        : false
  if (!carriesRoot) {
    throw new Error(
      `the mcp row does not pass the plugin root in a recognised launch shape: command="${command}" args=${JSON.stringify(args)}`,
    )
  }

  return { rows: doc.length, ids, suffix, command, args }
}
