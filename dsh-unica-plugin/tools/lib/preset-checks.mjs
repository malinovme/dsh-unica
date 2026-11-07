// The preset checks that need a YAML parser, kept in one module so the CLI
// wrapper and the CI job share exactly one implementation.
//
// js-yaml is a dependency of the DSH installation, not of this plugin, so it is
// resolved from the ambient node_modules, from NODE_PATH, or from an explicit
// `searchDirs` list. Where it cannot be found the caller gets a clear error
// instead of a module-not-found stack.
import { readFileSync } from 'node:fs'
import { loadYaml, yamlWithJsTag } from './yaml.mjs'

/** The row id the installer writes the preset declaration under. */
const PRESET_ROW_ID = 'preset-unica-1c'
const PRESET_ID = 'unica-1c'

/**
 * Finds the preset declaration in a profile patch.
 *
 * A patch declares new rows inside `- insert:` lists — a top-level `- id:` entry
 * addresses a row of the layer below instead of creating one, which is exactly
 * how an install once composed a profile without its preset. The plain top-level
 * row an older version of this installer wrote is still accepted, so an
 * existing install can be checked instead of only reported as broken.
 *
 * The current patch shape is deliberately asserted as well: a preset that sits
 * in an `insert:` list is the only shape DSH will actually mount, so a
 * top-level row is reported rather than silently accepted.
 *
 * @returns the declaration row, or throws naming what was found instead
 */
function findPresetRow(doc) {
  const found = []
  for (const entry of doc) {
    found.push(entry?.id)
    for (const child of Array.isArray(entry?.insert) ? entry.insert : []) found.push(child?.id)
  }
  for (const entry of doc) {
    if (entry?.id === PRESET_ROW_ID) {
      throw new Error(
        `\`${PRESET_ROW_ID}\` is a top-level entry, which a patch cannot declare — DSH will compose the profile ` +
          `without it. The row must sit inside an \`- insert:\` list.`,
      )
    }
  }
  for (const entry of doc) {
    for (const child of Array.isArray(entry?.insert) ? entry.insert : []) {
      if (child?.id === PRESET_ROW_ID || child?.config?.id === PRESET_ID) return child
    }
  }
  throw new Error(`no \`${PRESET_ROW_ID}\` row in the patch (found: ${found.filter(Boolean).join(', ') || 'nothing'})`)
}

/**
 * Parses and checks a generated preset, in either of the two shapes DSH has
 * used for them: a declaration row inside a profile patch (0.2.0+) or a bare
 * composition file (0.1.x).
 *
 * @param path - the profile patch, or the preset's agent.cordis.yml
 * @param searchDirs - extra roots to resolve js-yaml from
 * @param kind - `patch` or `composition`
 * @returns the parsed rows and where they came from
 */
export function checkPreset(path, searchDirs = [], kind = 'patch') {
  const yaml = loadYaml(searchDirs)
  const schema = yamlWithJsTag(yaml)

  const doc = yaml.load(readFileSync(path, 'utf8'), { schema })
  if (!Array.isArray(doc)) throw new Error('the file is not a list of rows')

  let rows
  let rowId = '(composition)'
  let presetId = PRESET_ID
  let name = '(none)'
  if (kind === 'composition') {
    rows = doc
  } else {
    const row = findPresetRow(doc)
    rowId = row.id ?? PRESET_ROW_ID
    if (row.name !== '@deepseek-ai/dsh-agent-preset') {
      throw new Error(`\`${rowId}\` is not a \`@deepseek-ai/dsh-agent-preset\` row (name: ${row.name ?? '(none)'})`)
    }
    presetId = row.config?.id
    if (presetId !== PRESET_ID) throw new Error(`\`${rowId}\` declares preset id "${presetId ?? '(none)'}", expected "${PRESET_ID}"`)
    name = row.config?.name ?? '(none)'
    rows = row.config?.plugins
    if (!Array.isArray(rows)) throw new Error(`\`${rowId}\` has no \`config.plugins\` list`)
  }

  const ids = rows.map((r) => r?.id)
  // Only what the port itself owns or must have: the persona carries the session
  // rules and the other two rows are injected. The rest of the composition is
  // copied from the shipped template, and requiring a specific set of template
  // rows would fail this check every time upstream edits its own preset.
  for (const id of ['persona', 'mcp-unica', 'skill-filesystem-unica']) {
    if (!ids.includes(id)) throw new Error(`row missing from the preset: ${id}`)
  }
  // The registry's own rule for a composition, mirrored here because it is the
  // one that decides whether the mode appears at all: a row without a plugin
  // name marks the whole preset "Failed to load", and a broken preset is hidden
  // from the picker. A config-only row passes YAML and the schema and is still
  // unselectable, so it is worth catching before DSH does.
  for (const [index, row] of rows.entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`composition row ${index + 1} is not a plugin row (expected a map with a "name")`)
    }
    if (typeof row.name !== 'string' || row.name === '') {
      throw new Error(`composition row ${index + 1} (id: ${row.id ?? 'none'}) names no plugin — DSH marks the whole preset "Failed to load" and hides it from the picker`)
    }
  }
  // A preset built by copying the shipped template must not nest the template's
  // own wrapper row — that silently produces a preset inside a preset.
  const dupes = ids.filter((id, i) => id !== undefined && ids.indexOf(id) !== i)
  if (dupes.length > 0) throw new Error(`duplicate row id(s) in the preset: ${[...new Set(dupes)].join(', ')}`)
  if (ids.includes('preset-standard')) {
    throw new Error('the template wrapper row `preset-standard` leaked into the composition; the child rows must be copied, not the declaration')
  }

  const persona = rows.find((r) => r.id === 'persona')
  const suffix = persona?.config?.suffix ?? ''
  // DSH 0.2.0's template carried `suffix: Your working directory is {{cwd}}.`,
  // so that line proves the rules survived. 0.2.1 removed both the line and the
  // `cwd` prompt variable: the installer adds a suffix of its own, which must
  // start with the rules and must not carry a reference the prompt renderer
  // would reject. Either shape is accepted; the rules themselves are not
  // optional.
  if (!suffix.includes('Unica rules for this session:')) {
    throw new Error('the session rules were lost from the persona suffix')
  }
  // A folded scalar that broke on indentation parses to different text, and the
  // rules would disappear without any error — hence checking the values. These
  // are the 0.13 rules; the 0.12 ones named `role.edit`, `meta.add`,
  // `role.compile` and `v8-runner`, none of which exists on the new surface.
  for (const needle of ['executionToken', 'unica.check', 'unica.docs', 'engine on first use']) {
    if (!suffix.includes(needle)) throw new Error(`session rule lost from the persona suffix: ${needle}`)
  }

  const mcp = rows.find((r) => r.id === 'mcp-unica')
  const args = mcp?.config?.args
  if (!Array.isArray(args) || args.length === 0) throw new Error('the mcp row lost its args')
  // Every host launches the port's Node script the same way — `node launch.mjs
  // <root>` — because upstream 0.13 stopped publishing per-platform bootstrap
  // binaries. The argument list still has to prove the plugin root reached the
  // command, or the launcher cannot find its runtime manifest.
  const command = mcp?.config?.command ?? ''
  const carriesRoot = command === 'node' && args.some((a) => a.endsWith('launch.mjs'))
  if (!carriesRoot) {
    throw new Error(
      `the mcp row does not launch the Node launcher: command="${command}" args=${JSON.stringify(args)}`,
    )
  }
  if (!args.some((a) => args.indexOf(a) > args.findIndex((x) => x.endsWith('launch.mjs')))) {
    throw new Error(`the launcher is not given the plugin root: args=${JSON.stringify(args)}`)
  }

  // The bundled catalog has to reach the session, and it only does through this
  // row: the shipped `standard` preset disables the host-plane skill root.
  const skills = rows.find((r) => r.id === 'skill-filesystem-unica')
  const dirs = skills?.config?.customSkillDirs
  if (!Array.isArray(dirs) || dirs.length === 0 || !dirs[0].endsWith('skills')) {
    throw new Error(`the unica skill root is not mounted: customSkillDirs=${JSON.stringify(dirs)}`)
  }

  return { rows: rows.length, ids, suffix, command, args, rowId, presetId, name }
}
