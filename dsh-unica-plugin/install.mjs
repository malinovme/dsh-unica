// Installs the DSH port of unica into a DSH home.
//
//   node install.mjs [--dsh-home <path>] [--target preset|profile|both] [--dry-run]
//
// Why an installer instead of a static tree: cordis patch files and agent-preset
// composition files support `!!js` expressions but have no plugin-root
// interpolation, so the absolute location of this plugin must be baked in. Doing
// it here keeps the source tree location-independent.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)))
const PRESET_ID = 'unica-1c'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const DRY_RUN = process.argv.includes('--dry-run')
const DSH_HOME = resolve(arg('dsh-home', process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')))
const TARGET = arg('target', 'preset')

/**
 * Picks how the MCP server is launched on the target platform.
 *
 * Two shapes, because they have different requirements:
 *   - Windows: exec the packaged `unica-bootstrap.exe` directly. No shell and no
 *     Git are involved, so this is the least fragile option there.
 *   - macOS / Linux: run the upstream `bootstrap/launch.sh` through `sh`. That
 *     script is where upstream keeps its OS/arch dispatch, so using it means
 *     this port does not duplicate the target table. It needs no Git here
 *     either: Git is only required by the *marketplace* `.mcp.json`, which
 *     routes through a command-scoped Git alias to recover the plugin root.
 *     DSH passes the plugin root as a plain argument, so the alias is moot.
 */
function launchPlan() {
  const force = arg('platform', undefined)
  const platform = force ?? process.platform
  const arch = force === undefined ? process.arch : arg('arch', process.arch)

  if (platform === 'win32') {
    const exe = join(PLUGIN_ROOT, 'bootstrap', 'bin', 'win-x64', 'unica-bootstrap.exe')
    return { kind: 'direct', platform, arch, command: exe, args: ['run', '--plugin-root', PLUGIN_ROOT], exe }
  }
  if (platform === 'darwin' || platform === 'linux') {
    const sh = join(PLUGIN_ROOT, 'bootstrap', 'launch.sh')
    return { kind: 'shell', platform, arch, command: 'sh', args: [sh, PLUGIN_ROOT], exe: sh }
  }
  throw new Error(
    `unsupported platform "${platform}": unica ships bootstrap binaries for darwin-arm64, linux-x64 and win-x64 only. ` +
      `Pass --platform win32|darwin|linux to override.`,
  )
}

const LAUNCH = launchPlan()
const SKILLS = join(PLUGIN_ROOT, 'skills')
const RUNTIMES = join(DSH_HOME, 'unica', 'runtimes')
const PROVIDER_STATE = join(DSH_HOME, 'unica', 'provider-state')

const planned = []
async function emit(path, content) {
  planned.push(path)
  if (DRY_RUN) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

/**
 * Finds the installed harness so its shipped `standard` preset can be copied.
 *
 * Deliberately subprocess-free: spawning `where.exe` is denied inside a
 * sandboxed DSH session (EPERM), which would make auto-detection fail exactly
 * where this installer is most likely to be run. PATH scanning needs no spawn.
 */
function installedHarnessRoots() {
  const roots = []
  const explicit = process.env.DSH_INSTALL_ROOT
  if (explicit !== undefined && explicit !== '') roots.push(explicit)
  // Windows environment variable names are case-insensitive; Node keeps the
  // original spelling, so `process.env.PATH` may be undefined while `Path` is set.
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path')
  const tail = `.bin${sep}`
  for (const entry of (process.env[pathKey] ?? '').split(delimiter)) {
    // A shim directory ends with `node_modules/.bin`, and npm does not always
    // append a trailing separator, so match the tail with and without it.
    const at = entry.endsWith(tail)
      ? entry.length - tail.length
      : entry.endsWith('.bin')
        ? entry.length - '.bin'.length
        : -1
    const prefix = `node_modules${sep}`
    if (at > 0 && entry.slice(0, at).endsWith(prefix)) roots.push(entry.slice(0, at - prefix.length))
  }
  return [...new Set(roots)]
}

/** The launch lines both targets share, at the given indentation. */
function launchBlock(indent) {
  const args = LAUNCH.args.map((a) => `${indent}  - '${a}'`).join('\n')
  return [`${indent}command: '${LAUNCH.command}'`, `${indent}args:`, args].join('\n')
}

/** The comment+env block both targets share, at the given indentation. */
function envBlock(indent) {
  return [
    `${indent}# Both writable directories are resolved by falling back through`,
    `${indent}# UNICA_*_DIR, CLAUDE_PLUGIN_DATA, CODEX_HOME and ~/.codex in that order.`,
    `${indent}# Pinning both keeps this port out of a Codex or Claude Code install`,
    `${indent}# that happens to share the machine.`,
    `${indent}UNICA_RUNTIME_CACHE_DIR: '${RUNTIMES}'`,
    `${indent}UNICA_PROVIDER_STATE_DIR: '${PROVIDER_STATE}'`,
  ].join('\n')
}

/** The standalone profile patch: correct for headless, TUI, SDK and ACP profiles. */
function profilePatch() {
  return `# Unica for DeepSeek Harness — generated by dsh-plugin-unica/install.mjs.
# Plugin root : ${PLUGIN_ROOT}
# Launch shape: ${LAUNCH.kind} (${LAUNCH.platform}/${LAUNCH.arch})
- insert:
    - id: mcp-unica
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: unica
        transport: stdio
${launchBlock('        ')}
        env:
${envBlock('          ')}
        failOnStartupError: true
        toolCallTimeoutMs: 600000
`
}

/**
 * The Web-GUI target. Web sessions are composed from an agent preset, and the
 * shipped `standard` preset mounts its OWN skill-filesystem row while the web
 * bundle disables the host-plane one — so a profile patch alone would give a Web
 * session the tools but no skills. A user preset is the only Web-side seam, and
 * presets have no "inherit and extend", so the standard composition is copied
 * and extended here (the same duplication the shipped `cordis` and `code`
 * presets accept).
 */
function presetComposition(standardYaml) {
  const mcpRow = `
# ── added by dsh-plugin-unica ────────────────────────────────────────────────
# The unica MCP bridge. Its 74 tools reach the model as
# mcp__unica__<raw name with '.'->'_'>_<hash12>, e.g.
# unica.cf.init -> mcp__unica__unica_cf_init_60b2c7880b08.
- id: mcp-unica
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: unica
    transport: stdio
${launchBlock('    ')}
    env:
${envBlock('      ')}
    failOnStartupError: true
    toolCallTimeoutMs: 600000

# A dedicated skill root for the bundled unica skills. The standard preset
# already mounts a skill-filesystem row, but with default roots only; this
# sibling row adds the plugin's own catalog without disturbing the project and
# user roots above.
- id: skill-filesystem-unica
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    providerName: unica-plugin
    includeDefaultRoots: false
    customSkillDirs:
      - '${SKILLS}'
    watch: false
`
  return `${standardYaml.trimEnd()}\n${mcpRow}`
}

const presetMeta = () => `name: Unica 1C
description: >-
  Разработка на 1С:Предприятии: метаданные, формы, роли, СКД и MXL,
  внешние обработки и отчёты, сборка и обновление ИБ, поиск и диагностика
  BSL-кода. Полный стандартный набор инструментов плюс MCP-сервер unica.
order: 50
`

async function main() {
  const skillsCount = existsSync(SKILLS) ? (await readdir(SKILLS, { withFileTypes: true })).filter((e) => e.isDirectory()).length : 0
  if (skillsCount === 0) throw new Error(`no bundled skills found at ${SKILLS} — run build-skills.mjs first`)
  if (!existsSync(LAUNCH.exe)) throw new Error(`unica bootstrap for ${LAUNCH.platform}/${LAUNCH.arch} not found at ${LAUNCH.exe}`)

  if (TARGET === 'profile' || TARGET === 'both') {
    const profile = arg('profile', 'headless')
    await emit(join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), profilePatch())
  }

  if (TARGET === 'preset' || TARGET === 'both') {
    // The shipped `standard` composition is the template the preset is copied
    // from. Look beside this plugin first (monorepo / sibling install), then in
    // the DSH installation the launcher actually runs from.
    const rel = join('@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml')
    const candidates = [
      join(PLUGIN_ROOT, 'node_modules', rel),
      join(dirname(PLUGIN_ROOT), 'node_modules', rel),
      ...installedHarnessRoots().map((root) => join(root, 'node_modules', rel)),
    ]
    const standardPath = candidates.find((p) => existsSync(p))
    if (standardPath === undefined) {
      throw new Error(
        `cannot locate the shipped 'standard' preset composition. Looked at:\n  ${candidates.join('\n  ')}\nPass DSH_INSTALL_ROOT=<the directory containing node_modules of your DSH install>.`,
      )
    }
    const presetDir = join(DSH_HOME, '.agent-presets', PRESET_ID)
    await emit(join(presetDir, 'preset.yml'), presetMeta())
    await emit(join(presetDir, 'agent.cordis.yml'), presetComposition(await readFile(standardPath, 'utf8')))
  }

  console.log(`${DRY_RUN ? '[dry-run] would install' : 'installed'} unica into ${DSH_HOME} (target: ${TARGET})`)
  console.log(`  plugin root   : ${PLUGIN_ROOT}`)
  console.log(`  launch        : ${LAUNCH.kind} — ${LAUNCH.command} ${LAUNCH.args.map((a) => `'${a}'`).join(' ')}`)
  console.log(`  platform      : ${LAUNCH.platform}/${LAUNCH.arch}`)
  console.log(`  skills        : ${skillsCount} directories at ${SKILLS}`)
  console.log(`  runtime cache : ${RUNTIMES}`)
  console.log(`  provider state: ${PROVIDER_STATE}`)
  console.log('  files:')
  for (const p of planned) console.log(`    ${p}`)
  if (TARGET === 'preset' || TARGET === 'both') {
    console.log(`\nStart a NEW DSH session and pick the "Unica 1C" preset.`)
  }
}

await main()
