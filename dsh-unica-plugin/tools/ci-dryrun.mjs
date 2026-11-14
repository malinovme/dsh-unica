// Dry-runs the CI job locally: strips PATH down to what a GitHub runner has for
// a Node-only repo, then executes each installer step in the same order and with
// the same assertions the workflow uses. Running this before a push avoids the
// loop of pushing to discover what the runner would say.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { harnessAsar, harnessNodeModules, harnessRoots } from './lib/harness.mjs'

const PLUGIN = resolve(import.meta.dirname, '..')
const TMP = process.env.TEMP ?? '/tmp'
const STUB = join(TMP, 'ci-standard.cordis.yml')
const HOME_A = join(TMP, 'ci-dsh-home')
const HOME_B = join(TMP, 'ci-dsh-preset')
/** The profile the preset target writes to by default. */
const PATCH_REL = join('profiles', 'web', 'cordis.patch.yml')

// What a runner has: node itself plus the OS directories. No DSH, so the
// installer cannot find the shipped `standard` composition — the exact
// condition that broke the first two CI runs.
const runnerPath = process.env.CI_PATH ?? `${join(process.env.ProgramFiles ?? '', 'nodejs')};C:\\WINDOWS\\system32;C:\\WINDOWS`

function run(args, opts = {}) {
  execFileSync(process.execPath, args, {
    cwd: PLUGIN,
    stdio: 'inherit',
    // `realEnv` keeps the ambient PATH: a step that has to find the harness for
    // js-yaml cannot use the stripped one. `opts.env` is applied either way, so a
    // step can name the harness explicitly instead of relying on PATH.
    env: opts.realEnv === true ? { ...process.env, ...opts.env } : { ...process.env, PATH: runnerPath, Path: runnerPath, ...opts.env },
  })
}

function runCapture(args) {
  return execFileSync(process.execPath, args, {
    cwd: PLUGIN,
    encoding: 'utf8',
    env: { ...process.env, PATH: runnerPath, Path: runnerPath },
  })
}

// The workflow step is named for the POSIX branch, but it only exercises that
// branch when the runner IS POSIX. Pass the platform explicitly so this script
// tests the branch it claims to test on any host — and so the Windows-only
// launch shape cannot hide a failure that the runner would hit. CI_PLATFORM
// overrides it, which is how the POSIX branch is covered from a Windows box.
const PLATFORM = process.env.CI_PLATFORM ?? (process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux')
const POSIX = PLATFORM !== 'win32'

// The steps that have to reach the harness are handed its root explicitly: with
// the stripped runner PATH built below they could not find it, and PATH scanning
// is exactly what a sandboxed session denies. A Desktop-only machine has no
// harness on PATH at all, so its bundle is passed instead — `DSH_INSTALL_ROOT`
// accepts either shape and the tools understand both, which keeps this dry run
// meaningful on a Desktop install as well as on a checkout.
const harnessRoot = harnessRoots()[0] ?? harnessAsar()?.asar
if (harnessRoot === undefined) throw new Error('cannot locate the DSH installation; set DSH_INSTALL_ROOT')

for (const dir of [HOME_A, HOME_B]) rmSync(dir, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

console.log(`platform under test: ${PLATFORM} (Node launcher on every host since 0.13)`)
console.log('--- step: create a stub preset template')
// The stub must carry the persona row the port rules attach to. It is written in
// the 0.2.0 shape — a patch file whose `- insert:` row holds the composition in
// `config.plugins`, with the suffix line the installer replaces. The 0.2.1+
// shape, where that line is gone, is exercised further down.
writeFileSync(
  STUB,
  [
    '# Stub of the shipped `standard` preset template.',
    '- insert:',
    '    - id: preset-standard',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: standard',
    '        order: 1',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              suffix: Your working directory is {{cwd}}.',
    '          - id: skill-filesystem',
    "            name: '@deepseek-ai/dsh-skill-filesystem'",
    '',
  ].join('\n'),
  'utf8',
)

console.log('--- step: installer composes a plan')
run(['install.mjs', '--dsh-home', HOME_A, '--target', 'both', '--dry-run', '--standard', STUB, '--platform', PLATFORM])

// Written for real, not a dry run: the assertions below read the produced files,
// so a dry run here would assert against nothing.
console.log('--- step: installer builds a preset from the stub template')
run(['install.mjs', '--dsh-home', HOME_B, '--target', 'preset', '--standard', STUB, '--platform', PLATFORM])

console.log('--- step: generated patch keeps the template rows and adds both port rows')
const patch = join(HOME_B, PATCH_REL)
if (!existsSync(patch)) throw new Error(`profile patch was not written: ${patch}`)
const text = readFileSync(patch, 'utf8')
const needles = [
  // The declaration has to be INSERTED. A top-level `- id:` entry addresses a
  // row of the layer below instead of declaring one, and DSH then composes a
  // profile without the preset while reporting nothing but
  // `patch: entry "preset-unica-1c" not found` on stderr.
  '- insert:',
  'id: preset-unica-1c',
  "name: '@deepseek-ai/dsh-agent-preset'",
  'id: unica-1c',
  'name: Unica 1C',
  'plugins:',
  'id: persona',
  'id: skill-filesystem',
  'id: unica-native',
  'id: skill-filesystem-unica',
  'host/index.js',
  'pluginRoot:',
  'providerStateDir:',
  // The session rules must reach the persona suffix, not just the skill files.
  // These are the 0.13 rules: the text they replaced named `role.edit`,
  // `meta.add`, `role.compile` and `v8-runner`, which no longer exist.
  'executionToken',
  'unica.check',
  'unica.docs',
  'engine on first use',
]
let missing = 0
for (const needle of needles) {
  const ok = text.includes(needle)
  if (!ok) missing += 1
  console.log(`    ${ok ? 'ok     ' : 'MISSING'} ${needle}`)
}
if (missing > 0) throw new Error(`${missing} expected items are missing from the generated patch`)
// Every row of the patch must be a child of an `insert:` list: a top-level row
// is the silent failure described above. Comments and the `insert:` keys
// themselves are the only other lines allowed in column 1.
for (const line of text.split('\n')) {
  if (line.trim() === '' || line.startsWith(' ') || line.startsWith('#') || line === '- insert:') continue
  throw new Error(`the generated patch declares a top-level entry, which DSH reads as an override address and drops: ${JSON.stringify(line)}`)
}
// The dead layout: a preset written to `.agent-presets` is invisible to 0.2.0.
if (existsSync(join(HOME_B, '.agent-presets'))) throw new Error('the installer still writes the retired $DSH_HOME/.agent-presets layout')

// The stripped runner PATH above hides the harness, which these need for
// js-yaml, so they get the real environment plus an explicit search root. This
// mirrors what the workflow does with its /tmp install. On a Desktop-only
// machine that root is the bundle, which the YAML resolver reads from directly.
const harnessNM = harnessNodeModules()[0] ?? harnessAsar()?.asar

// The gate the text assertions above cannot be: compose the profile through
// DSH's own loader and prove the rows are IN the result. This is what caught the
// dropped preset, and nothing weaker would have.
console.log('--- step: DSH composes the installed profile with the preset in it')
run(['tools/verify-install.mjs', HOME_B, 'web'], { realEnv: true, env: { DSH_INSTALL_ROOT: harnessRoot } })

console.log('--- step: workflow definition is well formed')
run(['tools/validate-workflow.mjs', harnessNM], { realEnv: true })

// The migration path is where this broke once already: an install left by the
// 0.1.x layout keeps its rows inside a top-level `- insert:` list, and a
// new-format run that did not recognise that block appended a SECOND row with
// the same id — two rows DSH refuses to load. The old layout is reproduced here
// because CI cannot regenerate one; the native-only installer must replace the
// retired `mcp-unica` row instead of leaving both sources of the same tools.
console.log('--- step: migrating an install written in the retired layout')
const OLD_HOME = join(TMP, 'ci-dsh-old')
rmSync(OLD_HOME, { recursive: true, force: true })
mkdirSync(join(OLD_HOME, 'profiles', 'headless'), { recursive: true })
writeFileSync(
  join(OLD_HOME, 'profiles', 'headless', 'cordis.patch.yml'),
  [
    '# Legacy profile patch, as the pre-0.2.0 installer wrote it.',
    '- insert:',
    '    - id: mcp-unica',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: unica',
    '        transport: stdio',
    '        command: stale',
    '  ',
    '- id: skill-filesystem-unica',
    "  name: '@deepseek-ai/dsh-skill-filesystem'",
    '  config:',
    '    providerName: unica-plugin',
    '    customSkillDirs:',
    "      - 'stale'",
    '',
  ].join('\n'),
  'utf8',
)
run(['install.mjs', '--dsh-home', OLD_HOME, '--target', 'profile', '--standard', STUB, '--platform', PLATFORM])
const migrated = readFileSync(join(OLD_HOME, 'profiles', 'headless', 'cordis.patch.yml'), 'utf8')
const countRow = (id) => migrated.split('\n').filter((line) => new RegExp(`^\\s*- id: ${id}$`).test(line)).length
for (const id of ['unica-native', 'skill-filesystem-unica']) {
  const seen = countRow(id)
  console.log(`    ${seen === 1 ? 'ok     ' : 'BROKEN '} ${seen} row(s) with id ${id} after migration`)
  if (seen !== 1) throw new Error(`migrating the retired layout left ${seen} rows with id ${id}`)
}
const retired = countRow('mcp-unica')
console.log(`    ${retired === 0 ? 'ok     ' : 'BROKEN '} ${retired} retired mcp-unica row(s) after migration`)
if (retired !== 0) throw new Error(`the retired mcp-unica row survived the migration (${retired})`)
// One insert list, holding exactly the two rows the installer owns: the migrated
// file must not accumulate a block per run, and nothing may sit at top level.
const inserts = migrated.split('\n').filter((line) => line === '- insert:').length
const strayTopLevel = migrated.split('\n').filter((line) => line.startsWith('- ') && line !== '- insert:')
console.log(`    ${inserts === 1 && strayTopLevel.length === 0 ? 'ok     ' : 'BROKEN '} one \`- insert:\` list, ${strayTopLevel.length} stray top-level entr(y|ies)`)
if (inserts !== 1 || strayTopLevel.length > 0) {
  throw new Error(`the migrated patch has ${inserts} insert lists and ${strayTopLevel.length} stray top-level entries`)
}
if (migrated.includes('stale')) throw new Error('a stale path from the retired layout survived the migration')

// The check that used to stand here proved the four 0.12 port corrections were
// still in the skills. Both the corrections and the skills they patched are gone
// in 0.13, so there is nothing left to guard: the tool names they described
// (`role.edit`, `meta.add`, `role.compile`) and the `v8-runner` skill no longer
// exist. The generator now fails on its own if a skill cites a tool the map does
// not know, which covers the failure this step was really about.
console.log('--- step: every tool name in the skills resolves through the map')
run(['tools/check-tool-names.mjs'])

// The patch is also judged with DSH's own package and schema, so a composition
// the hand-rolled assertions accept but DSH refuses cannot pass. These run with
// the REAL environment: they have to locate the harness, which deliberately is
// not on the stripped runner PATH built above.
console.log('--- step: generated patch parses and keeps the session rules')
execFileSync(process.execPath, ['tools/check-preset.mjs', patch], {
  cwd: PLUGIN,
  stdio: 'inherit',
  env: { ...process.env, DSH_INSTALL_ROOT: harnessRoot },
})

console.log('--- step: DSH schema-checks the generated preset')
execFileSync(process.execPath, ['tools/validate-preset.mjs', patch], {
  cwd: PLUGIN,
  stdio: 'inherit',
  env: { ...process.env, DSH_INSTALL_ROOT: harnessRoot },
})

// DSH 0.2.1 removed the `cwd` prompt variable and the persona `suffix:` line it
// fed from the shipped template. The installer has to attach the rules itself,
// and must not leave a reference the prompt renderer would reject.
console.log('--- step: 0.2.1+ template without a persona suffix')
const STUB_021 = join(TMP, 'ci-standard-021.cordis.yml')
const HOME_C = join(TMP, 'ci-dsh-preset-021')
writeFileSync(
  STUB_021,
  [
    '# Stub of the shipped `standard` preset template since DSH 0.2.1: the',
    '# persona row carries a prefix and no suffix.',
    '- insert:',
    '    - id: preset-standard',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: standard',
    '        order: 1',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: You are a coding agent powered by the {{model}} model.',
    '          - id: skill-filesystem',
    "            name: '@deepseek-ai/dsh-skill-filesystem'",
    '',
  ].join('\n'),
  'utf8',
)
rmSync(HOME_C, { recursive: true, force: true })
run(['install.mjs', '--dsh-home', HOME_C, '--target', 'preset', '--standard', STUB_021, '--platform', PLATFORM])
const patch021 = join(HOME_C, PATCH_REL)
const text021 = readFileSync(patch021, 'utf8')
if (text021.includes('{{cwd}}')) {
  throw new Error('the 0.2.1+ preset references {{cwd}}, which that DSH no longer registers')
}
for (const needle of ['Unica rules for this session:', 'executionToken', 'unica.check']) {
  const ok = text021.includes(needle)
  console.log(`    ${ok ? 'ok     ' : 'MISSING'} ${needle}`)
  if (!ok) throw new Error(`the 0.2.1+ preset lost ${needle}`)
}
execFileSync(process.execPath, ['tools/check-preset.mjs', patch021], {
  cwd: PLUGIN,
  stdio: 'inherit',
  env: { ...process.env, DSH_INSTALL_ROOT: harnessRoot },
})
execFileSync(process.execPath, ['tools/verify-install.mjs', HOME_C, 'web'], {
  cwd: PLUGIN,
  stdio: 'inherit',
  env: { ...process.env, DSH_INSTALL_ROOT: harnessRoot },
})
execFileSync(process.execPath, ['tools/validate-preset.mjs', patch021], {
  cwd: PLUGIN,
  stdio: 'inherit',
  env: { ...process.env, DSH_INSTALL_ROOT: harnessRoot },
})

console.log('--- step: installer rejects an unsupported platform')
let rejected = false
try {
  runCapture(['install.mjs', '--target', 'profile', '--dry-run', '--platform', 'freebsd'])
} catch {
  rejected = true
}
if (!rejected) throw new Error('an unsupported platform did not produce a non-zero exit')
console.log('    ok      unsupported platform rejected')

console.log('\nCI job dry-run passed: every installer step behaves as the workflow expects')
