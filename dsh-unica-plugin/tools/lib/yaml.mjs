// Resolves js-yaml, which is a dependency of the DSH installation rather than of
// this plugin. Every tool that parses YAML needs it, and none of them should
// depend on NODE_PATH being set by the caller.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { harnessNodeModules } from './harness.mjs'

const require = createRequire(import.meta.url)

/**
 * @param extraDirs - node_modules directories to try before the harness
 * @returns the js-yaml module
 */
export function loadYaml(extraDirs = []) {
  const searchDirs = [...extraDirs, ...harnessNodeModules()]
  for (const dir of [undefined, ...searchDirs]) {
    try {
      return dir === undefined ? require('js-yaml') : createRequire(join(dir, 'noop.js'))('js-yaml')
    } catch {
      /* try the next root */
    }
  }
  throw new Error(
    `js-yaml not found. Install it (npm install js-yaml) or point NODE_PATH at a node_modules that has it. ` +
      `Looked in: ${['(ambient)', ...searchDirs].join(', ')}`,
  )
}

/**
 * js-yaml schema that also understands the `!!js` tag.
 *
 * Cordis patch and composition files carry embedded expressions such as
 * `disabled: !!js process.platform === 'win32'`. Plain js-yaml rejects the
 * unknown tag, and stripping the tag would hide a genuinely broken document, so
 * it is declared as a pass-through scalar instead.
 */
export function yamlWithJsTag(yaml) {
  return yaml.DEFAULT_SCHEMA.extend([
    new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: () => true,
      construct: (value) => ({ $js: value }),
    }),
  ])
}
