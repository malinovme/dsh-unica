// Resolves js-yaml, which is a dependency of the DSH installation rather than of
// this plugin. Every tool that parses YAML needs it, and none of them should
// depend on NODE_PATH being set by the caller.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { harnessNodeModules } from './harness.mjs'

const require = createRequire(import.meta.url)

/**
 * @param extraDirs - node_modules directories (or their parents) to try before
 *   the harness; a path that already ends in `node_modules` is used as one
 */
export function loadYaml(extraDirs = []) {
  // A root may be given either way round: the directory that CONTAINS
  // node_modules, or node_modules itself. `createRequire` resolves relative to
  // the file it is given, so both readings are tried explicitly rather than
  // guessed.
  const bases = []
  for (const dir of extraDirs) {
    bases.push(dir, join(dir, 'node_modules'), join(dir, '..'))
  }
  bases.push(...harnessNodeModules().map((nm) => join(nm, '..')), ...harnessNodeModules())

  for (const dir of [undefined, ...bases]) {
    try {
      return dir === undefined ? require('js-yaml') : createRequire(join(dir, 'noop.js'))('js-yaml')
    } catch {
      /* try the next root */
    }
  }
  throw new Error(
    `js-yaml not found. Install it (npm install js-yaml) or point NODE_PATH at a node_modules that has it. ` +
      `Looked in: ${['(ambient)', ...new Set(bases)].join(', ')}`,
  )
}

/**
 * js-yaml schema that also understands the `!!js` tag.
 *
 * Cordis patch and composition files carry embedded expressions such as
 * `disabled: !!js process.platform === 'win32'`. Plain js-yaml rejects the
 * unknown tag, and stripping the tag would hide a genuinely broken document, so
 * it is declared as a pass-through scalar instead.
 *
 * The schema-extension API exists in js-yaml v4 and is absent from the v5
 * CommonJS build, where `DEFAULT_SCHEMA` is undefined and this would fail with
 * a bare "cannot read properties of undefined". Saying so outright is worth the
 * two lines: a version drift between the harness and a CI install is exactly how
 * this breaks.
 */
export function yamlWithJsTag(yaml) {
  if (yaml?.DEFAULT_SCHEMA?.extend === undefined || typeof yaml.Type !== 'function') {
    throw new Error(
      'the resolved js-yaml does not expose the v4 schema API (DEFAULT_SCHEMA.extend / Type). ' +
        'Install js-yaml@4 — that is what DSH ships, and what this check is written against.',
    )
  }
  return yaml.DEFAULT_SCHEMA.extend([
    new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: () => true,
      construct: (value) => ({ $js: value }),
    }),
  ])
}
