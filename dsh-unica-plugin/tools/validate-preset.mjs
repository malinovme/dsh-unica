// Validates a generated agent preset with DSH's OWN schema, so the verdict does
// not depend on a hand-rolled parser.
//
//   node tools/validate-preset.mjs [<profile-patch.yml>|--composition <agent.cordis.yml>]
//
// DSH 0.2.0 replaced directory scanning (`@deepseek-ai/dsh-agent-presets`,
// `scanRoot`) with a declaration row, so there is no longer a discovery API to
// call. What is validated instead is exactly what DSH validates when it loads
// the row:
//
//   1. `@deepseek-ai/dsh-agent-preset`'s own `Config` schema — required `id` and
//      `plugins`, optional `name` / `description` / `order`, nothing else;
//   2. that every child row names a module resolvable from the harness, which is
//      where DSH resolves preset rows from (missing modules are reported, but a
//      non-`@deepseek-ai` specifier is only a warning: presets may name plugins
//      installed elsewhere).
//
// DSH ships its packages as dependencies of the harness, not of this plugin, so
// the harness location has to be supplied: DSH_INSTALL_ROOT, or a node_modules
// directory on PATH.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { harnessRoots } from './lib/harness.mjs'

/** Locates a package directory inside the harness, without spawning anything. */
async function harnessPackage(name) {
  for (const root of harnessRoots()) {
    const dir = join(root, 'node_modules', name)
    if (existsSync(join(dir, 'package.json'))) return { dir, root }
  }
  return undefined
}

const argv = process.argv.slice(2)
const compAt = argv.indexOf('--composition')
const compositionArg = compAt === -1 ? undefined : argv[compAt + 1]
const positional = argv.filter((a, i) => !a.startsWith('--') && (compAt === -1 || i !== compAt + 1))
const target = resolve(
  compositionArg ?? positional[0] ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'), 'profiles', 'web', 'cordis.patch.yml'),
)
if (!existsSync(target)) throw new Error(`preset not found: ${target}`)

const presetPkg = await harnessPackage('@deepseek-ai/dsh-agent-preset')
if (presetPkg === undefined) {
  throw new Error(
    `cannot find @deepseek-ai/dsh-agent-preset to validate with. Looked in:\n  ${harnessRoots().join('\n  ') || '(nothing: DSH is not on PATH)'}\n` +
      `That package is how DSH 0.2.0 declares presets. On DSH 0.1.x presets were scanned from ` +
      `$DSH_HOME/.agent-presets by the retired @deepseek-ai/dsh-agent-presets package, which no ` +
      `longer ships — upgrade DSH rather than validating the old layout.\n` +
      `Pass DSH_INSTALL_ROOT=<directory containing node_modules of your DSH install>.`,
  )
}

const { default: AgentPreset } = await import(pathToFileURL(join(presetPkg.dir, 'lib', 'index.js')).href)
const schema = AgentPreset.Config
// DSH resolves preset rows against the harness, so the same base decides whether
// a row's module specifier is real. `createRequire` needs a file URL inside it.
const harnessRequire = createRequire(pathToFileURL(join(presetPkg.root, 'node_modules') + sep).href)

const { checkPreset } = await import('./lib/preset-checks.mjs')
const kind = compositionArg !== undefined ? 'composition' : 'patch'
const result = checkPreset(target, [], kind)

console.log(`preset      : ${target}`)
console.log(`shape       : ${kind === 'patch' ? 'profile patch row' : 'bare composition'}`)
console.log(`preset id   : ${result.presetId}`)
console.log(`display name: ${result.name}`)
console.log(`rows        : ${result.rows}`)

// Re-read the raw entries so the schema sees the document DSH will see, not the
// subset the text checks happened to need.
const { loadYaml, yamlWithJsTag } = await import('./lib/yaml.mjs')
const yaml = loadYaml([])
const parsed = yaml.load(readFileSync(target, 'utf8'), { schema: yamlWithJsTag(yaml) })
let config
if (kind === 'composition') {
  config = { id: result.presetId, plugins: parsed }
} else {
  const declared = parsed.find((e) => e?.id === result.rowId) ?? parsed.flatMap((e) => (Array.isArray(e?.insert) ? e.insert : [])).find((e) => e?.id === result.rowId)
  config = declared?.config
}
if (config === undefined) throw new Error(`cannot re-read the \`${result.rowId}\` declaration from ${target}`)

const checked = schema(config)
console.log(`schema      : accepted (id, plugins + ${['name', 'description', 'order'].filter((k) => config[k] !== undefined).join(', ') || 'no optional fields'})`)

const missing = []
const unresolved = []
for (const child of checked.plugins) {
  const name = child?.name
  if (typeof name !== 'string') {
    unresolved.push(`(row ${child?.id ?? '?'} has no module name)`)
    continue
  }
  // `cordis:group` is the composition's own grouping marker, carried over from
  // the shipped template; it is not a package and has nothing to resolve.
  if (name.startsWith('cordis:')) continue
  // Subpath specifiers (`@deepseek-ai/dsh-plugin-manager/tools`) resolve as a
  // package plus an export path; only the package part decides availability.
  const pkg = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
  try {
    harnessRequire.resolve(name)
  } catch {
    // ESM-only packages have no `main`, so `require.resolve` can fail on a
    // package that is plainly installed. The directory is the real test.
    const known = await harnessPackage(pkg)
    if (known === undefined) {
      if (pkg.startsWith('@deepseek-ai/')) missing.push(`${name} (row ${child.id ?? '?'})`)
      else unresolved.push(`${name} (row ${child.id ?? '?'}) — not shipped by DSH`)
    }
  }
}
console.log(`modules     : ${checked.plugins.length - missing.length - unresolved.length}/${checked.plugins.length} resolve from the harness`)
for (const m of unresolved) console.log(`  note    : ${m}`)
for (const m of missing) console.log(`  MISSING : ${m}`)

// DSH refuses a preset whose modules do not load, so this is fatal for the rows
// the port itself injects and a warning for anything else.
const portRows = ['mcp-unica', 'skill-filesystem-unica', 'persona', 'skill-filesystem']
const fatal = missing.filter((m) => portRows.some((id) => m.includes(`row ${id})`)))
if (fatal.length > 0) {
  console.error(`\n${fatal.length} row(s) the port depends on cannot resolve`)
  process.exitCode = 1
} else if (missing.length > 0) {
  console.error(`\n${missing.length} row(s) do not resolve from the harness`)
  process.exitCode = 1
} else {
  console.log('\nDSH schema accepted the declaration and every row resolves')
}
