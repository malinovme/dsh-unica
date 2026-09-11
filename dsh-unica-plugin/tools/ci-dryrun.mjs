// Dry-runs the CI job locally: strips PATH down to what a GitHub runner has for
// a Node-only repo, then executes each installer step in the same order and with
// the same assertions the workflow uses. Running this before a push avoids the
// loop of pushing to discover what the runner would say.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { harnessNodeModules } from './lib/harness.mjs'

const PLUGIN = resolve(import.meta.dirname, '..')
const TMP = process.env.TEMP ?? '/tmp'
const STUB = join(TMP, 'ci-standard.cordis.yml')
const HOME_A = join(TMP, 'ci-dsh-home')
const HOME_B = join(TMP, 'ci-dsh-preset')

// What a runner has: node itself plus the OS directories. No DSH, so the
// installer cannot find the shipped `standard` composition — the exact
// condition that broke the first two CI runs.
const runnerPath = process.env.CI_PATH ?? `${join(process.env.ProgramFiles ?? '', 'nodejs')};C:\\WINDOWS\\system32;C:\\WINDOWS`

function run(args, opts = {}) {
  execFileSync(process.execPath, args, {
    cwd: PLUGIN,
    stdio: 'inherit',
    // `realEnv` keeps the ambient PATH: a step that has to find the harness for
    // js-yaml cannot use the stripped one.
    env: opts.realEnv === true ? process.env : { ...process.env, PATH: runnerPath, Path: runnerPath, ...opts.env },
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
// tests the branch it claims to test on any host.
const PLATFORM = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
const POSIX = PLATFORM !== 'win32'

for (const dir of [HOME_A, HOME_B]) rmSync(dir, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

console.log(`platform under test: ${PLATFORM} (${POSIX ? 'launch.sh branch' : 'direct bootstrap branch'})`)
console.log('--- step: create a stub preset template')
// The stub must carry the persona row the port rules attach to, with the exact
// suffix text the installer asserts. Without it the installer refuses by design.
writeFileSync(
  STUB,
  [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    suffix: Your working directory is {{cwd}}.',
    '- id: skill-filesystem',
    "  name: '@deepseek-ai/dsh-skill-filesystem'",
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

console.log('--- step: generated preset keeps the template and adds both rows')
const preset = join(HOME_B, '.agent-presets', 'unica-1c', 'agent.cordis.yml')
if (!existsSync(preset)) throw new Error(`preset was not written: ${preset}`)
const text = readFileSync(preset, 'utf8')
const needles = [
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
if (missing > 0) throw new Error(`${missing} expected items are missing from the generated preset`)

// The stripped runner PATH above hides the harness, which these two need for
// js-yaml, so they get the real environment plus an explicit search root. This
// mirrors what the workflow does with its /tmp install.
const harnessNM = harnessNodeModules()[0]
if (harnessNM === undefined) throw new Error('cannot locate the harness to resolve js-yaml from; set DSH_INSTALL_ROOT')

console.log('--- step: workflow definition is well formed')
run(['tools/validate-workflow.mjs', harnessNM], { realEnv: true })

console.log('--- step: port corrections are present in the skills')
run(['tools/check-port-notes.mjs'])

// The preset is also judged by DSH's own discovery and health check, so a
// composition the hand-rolled assertions accept but DSH refuses cannot pass.
// These two run with the REAL environment: they have to locate the harness,
// which deliberately is not on the stripped runner PATH built above.
console.log('--- step: generated preset parses and keeps the session rules')
execFileSync(process.execPath, ['tools/check-preset.mjs', preset], {
  cwd: PLUGIN,
  stdio: 'inherit',
  env: process.env,
})

console.log('--- step: DSH health-checks the generated preset')
execFileSync(process.execPath, ['tools/validate-preset.mjs', join(HOME_B, '.agent-presets')], {
  cwd: PLUGIN,
  stdio: 'inherit',
  env: process.env,
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
// go straight at the bootstrap executable. Read from the preset, which the step
// above writes for real — the plan step is a dry run and leaves no file.
const presetText = readFileSync(preset, 'utf8')
const usesShell = /^\s*command: 'sh'$/m.test(presetText)
const usesDirect = /unica-bootstrap\.exe'$/m.test(presetText)
if (POSIX && !usesShell) throw new Error('a POSIX install did not launch through sh launch.sh')
if (!POSIX && !usesDirect) throw new Error('a Windows install did not launch the bootstrap executable directly')
console.log(`    ok      launch shape is ${usesShell ? 'sh launch.sh' : 'direct bootstrap'} as expected for ${PLATFORM}`)

console.log('\nCI job dry-run passed: every installer step behaves as the workflow expects')
