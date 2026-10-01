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

console.log(`platform under test: ${PLATFORM} (${POSIX ? 'launch.sh branch' : 'direct bootstrap branch'})`)
console.log('--- step: create a stub preset template')
// The stub must carry the persona row the port rules attach to, with the exact
// suffix text the installer asserts. Without it the installer refuses by design.
// It is written in the SHAPE the shipped template has since 0.2.0 — a patch file
// whose `- insert:` row holds the composition in `config.plugins` — because that
// is the shape the installer unwraps.
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
  'id: mcp-unica',
  'id: skill-filesystem-unica',
  'serverName: unica',
  'UNICA_PROVIDER_STATE_DIR',
  // The session rules must reach the persona suffix, not just the skill files.
  'SourceSetNotFound',
  'fullRebuild: true',
  'Turnovers',
  'Rights.xml',
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
// the same id — two `mcp-unica` tasks, which DSH refuses to load. The old layout
// is reproduced here because CI cannot regenerate one.
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
for (const id of ['mcp-unica', 'skill-filesystem-unica']) {
  const seen = countRow(id)
  console.log(`    ${seen === 1 ? 'ok     ' : 'BROKEN '} ${seen} row(s) with id ${id} after migration`)
  if (seen !== 1) throw new Error(`migrating the retired layout left ${seen} rows with id ${id}`)
}
// One insert list, holding exactly the two rows the installer owns: the migrated
// file must not accumulate a block per run, and nothing may sit at top level.
const inserts = migrated.split('\n').filter((line) => line === '- insert:').length
const strayTopLevel = migrated.split('\n').filter((line) => line.startsWith('- ') && line !== '- insert:')
console.log(`    ${inserts === 1 && strayTopLevel.length === 0 ? 'ok     ' : 'BROKEN '} one \`- insert:\` list, ${strayTopLevel.length} stray top-level entr(y|ies)`)
if (inserts !== 1 || strayTopLevel.length > 0) {
  throw new Error(`the migrated patch has ${inserts} insert lists and ${strayTopLevel.length} stray top-level entries`)
}
if (migrated.includes('stale')) throw new Error('a stale path from the retired layout survived the migration')

console.log('--- step: port corrections are present in the skills')
run(['tools/check-port-notes.mjs'])

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

console.log('--- step: installer rejects an unsupported platform')
let rejected = false
try {
  runCapture(['install.mjs', '--target', 'profile', '--dry-run', '--platform', 'freebsd'])
} catch {
  rejected = true
}
if (!rejected) throw new Error('an unsupported platform did not produce a non-zero exit')
console.log('    ok      unsupported platform rejected')

// Proves the branch the workflow claims to cover actually produced the shape it
// claims: a POSIX install must launch through `sh launch.sh`, a Windows one must
// go straight at the bootstrap executable. Read from the patch, which the step
// above writes for real — the plan step is a dry run and leaves no file.
const patchText = readFileSync(patch, 'utf8')
const usesShell = /^\s*command: 'sh'$/m.test(patchText)
const usesDirect = /unica-bootstrap\.exe'$/m.test(patchText)
if (POSIX && !usesShell) throw new Error('a POSIX install did not launch through sh launch.sh')
if (!POSIX && !usesDirect) throw new Error('a Windows install did not launch the bootstrap executable directly')
console.log(`    ok      launch shape is ${usesShell ? 'sh launch.sh' : 'direct bootstrap'} as expected for ${PLATFORM}`)

console.log('\nCI job dry-run passed: every installer step behaves as the workflow expects')
