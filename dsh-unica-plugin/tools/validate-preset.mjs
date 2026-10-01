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
// the harness location has to be found: DSH_INSTALL_ROOT, a node_modules on PATH,
// or the Desktop app's own bundle, which packs the harness into `app.asar`.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { harnessAsar, harnessRoots, asarHarnessPackages, materializeHarness } from './lib/harness.mjs'

/** Locates a package directory inside the harness, without spawning anything. */
async function harnessPackage(name) {
  for (const root of harnessRoots()) {
    const dir = join(root, 'node_modules', name)
    if (existsSync(join(dir, 'package.json'))) return { dir, root }
  }
  return undefined
}

/**
 * Loads the package that declares presets, from the harness the profile belongs
 * to.
 *
 * On disk it is imported straight from the harness. On a bundled Desktop install
 * there is no directory to import from — the package lives inside `app.asar` —
 * so it is copied out of the bundle into a temporary closure first. Plain Node
 * cannot import from an archive, and rewriting the bundle's imports instead would
 * stop the check from testing what DSH actually loads.
 *
 * Which harness a profile belongs to matters, and it is not a detail: this
 * machine also has an `npx`-installed harness on PATH, and reading the rows of a
 * Desktop profile against that one reported eighteen healthy rows as missing.
 * A profile under a Desktop that ships its own harness is Desktop's business, so
 * that bundle wins unless `DSH_INSTALL_ROOT` says otherwise.
 *
 * @param profileName - the profile being validated, e.g. `desktop`
 * @returns the declaration package and where it came from
 */
async function loadPresetPackage(profileName) {
  const bundle = harnessAsar()
  const preferBundle = bundle !== undefined && (process.env.DSH_INSTALL_ROOT === undefined || process.env.DSH_INSTALL_ROOT === '')
  if (!preferBundle) {
    const onDisk = await harnessPackage('@deepseek-ai/dsh-agent-preset')
    if (onDisk !== undefined) {
      const { default: AgentPreset } = await import(pathToFileURL(join(onDisk.dir, 'lib', 'index.js')).href)
      return { Config: AgentPreset.Config, dir: onDisk.dir, nodeModules: join(onDisk.root, 'node_modules'), source: `disk ${onDisk.dir}`, inBundle: undefined }
    }
  }
  if (bundle === undefined) return undefined
  const extracted = materializeHarness('dsh/node_modules/@deepseek-ai/dsh-agent-preset/lib/index.js', join(tmpdir(), `dsh-validate-${process.pid}`), bundle)
  const { default: AgentPreset } = await import(pathToFileURL(extracted.entry).href)
  const known = new Set(asarHarnessPackages(bundle))
  // The bundle's table is keyed by the name inside the scope, while a row names
  // the scoped package (`@deepseek-ai/dsh-persona`), so the scope is restored.
  return { Config: AgentPreset.Config, dir: extracted.entry, nodeModules: join(extracted.entry, '..', 'node_modules'), source: `bundle ${bundle.asar}`, inBundle: (name) => known.has(name.replace(/^@deepseek-ai\//, '')), profileName }
}

const argv = process.argv.slice(2)
const compAt = argv.indexOf('--composition')
const compositionArg = compAt === -1 ? undefined : argv[compAt + 1]
const positional = argv.filter((a, i) => !a.startsWith('--') && (compAt === -1 || i !== compAt + 1))
const target = resolve(
  compositionArg ?? positional[0] ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'), 'profiles', 'web', 'cordis.patch.yml'),
)
if (!existsSync(target)) throw new Error(`preset not found: ${target}`)
// The profile name decides which harness the declaration is judged against, so
// it is read off the path rather than guessed from the file name.
const profileName = /[\\/]profiles[\\/]([^\\/]+)[\\/]/.exec(target)?.[1] ?? 'web'

const presetPkg = await loadPresetPackage(profileName)
if (presetPkg === undefined) {
  throw new Error(
    `cannot find @deepseek-ai/dsh-agent-preset to validate with. Looked in:\n  ${harnessRoots().join('\n  ') || '(nothing: DSH is not on PATH)'}\n` +
      `and for a bundled Desktop install in the usual places, and found neither.\n` +
      `That package is how DSH 0.2.0 declares presets. On DSH 0.1.x presets were scanned from ` +
      `$DSH_HOME/.agent-presets by the retired @deepseek-ai/dsh-agent-presets package, which no ` +
      `longer ships — upgrade DSH rather than validating the old layout.\n` +
      `Pass DSH_INSTALL_ROOT=<directory containing node_modules, or the app.asar, of your DSH install>.`,
  )
}

const schema = presetPkg.Config
// DSH resolves preset rows against the harness, so the same base decides whether
// a row's module specifier is real. `createRequire` needs a file URL inside it.
const harnessRequire = createRequire(pathToFileURL(presetPkg.nodeModules + sep).href)

/**
 * Whether a row's module can be loaded where DSH will load it.
 *
 * On disk `require.resolve` answers directly. For a bundled Desktop install the
 * question is membership of the packages inside `app.asar` — resolution there is
 * the app's own loader's business, and only the bundle's table can answer it.
 *
 * @param pkg - the package part of the specifier
 * @param name - the full specifier, subpath included
 */
async function resolves(pkg, name) {
  if (presetPkg.inBundle !== undefined) return presetPkg.inBundle(pkg)
  try {
    harnessRequire.resolve(name)
    return true
  } catch {
    // ESM-only packages have no `main`, so `require.resolve` can fail on a
    // package that is plainly installed. The directory is the real test.
    return (await harnessPackage(pkg)) !== undefined
  }
}

const { checkPreset } = await import('./lib/preset-checks.mjs')
const kind = compositionArg !== undefined ? 'composition' : 'patch'
const result = checkPreset(target, [], kind)

console.log(`preset      : ${target}`)
console.log(`harness     : ${presetPkg.source}`)
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
  const known = await resolves(pkg, name)
  if (!known) {
    if (pkg.startsWith('@deepseek-ai/')) missing.push(`${name} (row ${child.id ?? '?'})`)
    else unresolved.push(`${name} (row ${child.id ?? '?'}) — not shipped by DSH`)
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
