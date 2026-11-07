// Installs the DSH port of unica into a DSH home.
//
//   node install.mjs [--dsh-home <path>] [--target preset|profile|both] [--dry-run]
//                    [--profile <name>] [--platform win32|darwin|linux]
//                    [--cache-dir <path>] [--verify-cwd <path>]
//                    [--standard <composition.patch.yml>]
//
// `--standard` builds the preset from a given composition instead of the shipped
// `standard` one. It exists for CI, which has no DSH installed; a normal install
// finds the real template by itself.
//
// `--cache-dir` puts the runtime cache and the provider state there instead of
// `$DSH_HOME/unica`. On Windows it is the escape hatch for a `$DSH_HOME` whose
// directory mask refuses the server's daemon state; see the note on CACHE_DIR.
//
// `--verify-cwd` picks the directory the `--verify` self-test runs in. The bridge
// itself has no workspace pin: every call resolves the directory from its own
// session, which is the whole point of the native mode.
//
// Why an installer instead of a static tree: cordis patch files and preset
// compositions support `!!js` expressions but have no plugin-root interpolation,
// so the absolute location of this plugin must be baked in. Doing it here keeps
// the source tree location-independent.
//
// ── what changed for DSH 0.2.0 ──────────────────────────────────────────────
// DSH 0.1.x discovered agent presets by SCANNING DIRECTORIES: the package
// `@deepseek-ai/dsh-agent-presets` read `$DSH_HOME/.agent-presets/<id>/preset.yml`
// plus `agent.cordis.yml` (`USER_PRESET_DIR` / `scanRoot`). DSH 0.2.0-rc.2
// dropped that package entirely and replaced it with `@deepseek-ai/dsh-agent-preset`
// + `dsh-agent-preset-registry`, which "neither scans directories nor accepts
// preset paths": a preset is now one ordinary plugin ROW of the profile
// composition, whose `config.plugins` holds the child entries inline.
//
// So both targets now write into the profile's `cordis.patch.yml`, and the
// dropped `$DSH_HOME/.agent-presets/` directory must not be written at all — a
// preset left there is invisible to 0.2.0, which is exactly the failure this
// installer previously produced.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { harnessAsar, harnessRoots, readAsarFile } from './tools/lib/harness.mjs'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)))
const PRESET_ID = 'unica-1c'
/** Plugin row id of the preset declaration inside the profile patch. */
const PRESET_ROW_ID = `preset-${PRESET_ID}`
const PRESET_ROW_NAME = '@deepseek-ai/dsh-agent-preset'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const DRY_RUN = process.argv.includes('--dry-run')
const VERIFY = process.argv.includes('--verify')
/** Resolve symlinks in the longest existing prefix (macOS `/tmp` is one). */
function canonicalPath(value) {
  let current = resolve(value)
  const tail = []
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(value)
      tail.push(basename(current))
      current = parent
    }
  }
}
const DSH_HOME = canonicalPath(arg('dsh-home', process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')))
const TARGET = arg('target', 'preset')
// Each target defaults to the profile it belongs to; an explicit --profile wins
// for both. Web is the only profile served by presets, and headless is where a
// preset-free patch was historically installed.
const PROFILE_ARG = arg('profile', undefined)
const PRESET_PROFILE = PROFILE_ARG ?? 'web'
const PATCH_PROFILE = PROFILE_ARG ?? 'headless'

/**
 * Picks how the bridge launches unica on the target platform.
 *
 * One shape for every host: the port's own Node launcher, which reads
 * `runtime-manifest.json`, fetches the runtime archive described there on first
 * use and hands over to the server. Upstream 0.13 publishes no per-platform
 * bootstrap binary any more, and a launcher in Node needs nothing installed beyond
 * the runtime DSH already requires — so there is no OS/arch table to duplicate
 * here, and no prebuilt binary for this port to carry.
 */
function launchPlan() {
  const force = arg('platform', undefined)
  const platform = force ?? process.platform
  const arch = force === undefined ? process.arch : arg('arch', process.arch)
  const target = targetFor(platform, arch)
  if (target === undefined) {
    throw new Error(
      `unsupported platform "${platform}/${arch}": unica publishes runtimes for darwin-arm64, linux-x64 and win-x64 only. ` +
        `Pass --platform win32|darwin|linux to override.`,
    )
  }
  const launcher = join(PLUGIN_ROOT, 'bootstrap', 'launch.mjs')
  return { kind: 'node', platform, arch, target, command: 'node', args: [launcher, PLUGIN_ROOT], exe: launcher }
}

/** The upstream runtime target for a platform pair, or undefined. */
function targetFor(platform, arch) {
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  return undefined
}

const LAUNCH = launchPlan()
const SKILLS = join(PLUGIN_ROOT, 'skills')

/**
 * Both writable directories the port owns: the runtime cache and the state root
 * of the server's user daemon.
 *
 * `--cache-dir` moves them together, and on Windows it is sometimes the only way
 * to get a working unica daemon. Unica 0.13 keeps a persistent user daemon whose
 * state root it opens at startup, and a `$DSH_HOME` under the user profile can
 * carry a directory mask that refuses it: the server then dies with
 * `open daemon provider state root: Отказано в доступе. (os error 5)`, the MCP
 * client reports `initial connection or tool synchronization failed`, and a
 * preset that carries that row shows up as failed to load. The same directory
 * mask refused the 0.12 bootstrap's lock files, so this escape hatch predates the
 * daemon and outlived it.
 */
const CACHE_ARG = arg('cache-dir', undefined)

/**
 * `--verify-cwd` selects the directory the `--verify` self-test asks unica about.
 *
 * The bridge has no workspace pin: each call resolves the directory from its own
 * session. The flag only gives the check a concrete project to look at.
 */
const VERIFY_CWD_ARG = arg('verify-cwd', arg('workspace', undefined))
const VERIFY_CWD = VERIFY_CWD_ARG === undefined ? canonicalPath(process.cwd()) : canonicalPath(VERIFY_CWD_ARG)

/** Where the launcher keeps the runtime and the provider state. */
function cachePaths(cacheDir) {
  const root = cacheDir === undefined ? DSH_HOME : canonicalPath(cacheDir)
  return cacheDir === undefined
    ? { runtimes: join(root, 'unica', 'runtimes'), state: join(root, 'unica', 'provider-state') }
    : { runtimes: join(root, 'runtimes'), state: join(root, 'provider-state') }
}
let CACHE = cachePaths(CACHE_ARG)
let RUNTIMES = CACHE.runtimes
let PROVIDER_STATE = CACHE.state

const planned = []
async function emit(path, content) {
  planned.push(path)
  if (DRY_RUN) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

/** The runtime manifest this port ships: one descriptor per upstream target. */
const RUNTIME_MANIFEST = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'runtime-manifest.json'), 'utf8'))

/** How long the self-test is given when the runtime is already cached. */
const SMOKE_TIMEOUT_MS = 120_000
/** The budget for a cold cache, which must download and verify the runtime first. */
const COLD_TIMEOUT_MS = 1_800_000
/** The tool surface Unica 0.13 introduced and 0.15 keeps: eleven tools, not 74 domain actions. */
const EXPECTED_TOOLS = 11

/**
 * The runtime's readiness marker, in the artifact layout the launcher installs:
 * `<cache>/<artifact>/<version>--<asset sha256>/<target>/.ready.json`.
 *
 * Its presence is what separates the two cases that need different budgets: a
 * cached runtime answers in seconds, while a cold one spends minutes on the
 * download and would look broken under the handshake's timeout. The launcher
 * writes this marker after it has verified and renamed the artifact into place.
 */
function readyMarker() {
  const core = RUNTIME_MANIFEST.artifacts?.unica?.targets?.[LAUNCH.target]
  if (core === undefined) return join(RUNTIMES, RUNTIME_MANIFEST.pluginVersion, LAUNCH.target, '.ready.json')
  return join(RUNTIMES, 'unica', `${RUNTIME_MANIFEST.artifacts.unica.version}--${core.asset.sha256}`, LAUNCH.target, '.ready.json')
}

/**
 * Starts unica through the same bridge the plugin uses and reads one node.
 *
 * This is the only check that answers the question a user actually has — "will
 * the tools work?" — because everything before it only proves that files were
 * written. The self-test spawns `host/selftest.js`, which speaks MCP to unica in
 * the chosen directory, lists the catalogue and calls `unica.view {}`. A cold
 * cache downloads the runtime inside this same run, so the budget follows the
 * cache rather than a handshake.
 *
 * @returns `{ ok, tools, server, root, stderr, ms }`
 */
function nativeSelftest() {
  const budget = existsSync(readyMarker()) ? SMOKE_TIMEOUT_MS : COLD_TIMEOUT_MS
  if (budget === COLD_TIMEOUT_MS) {
    console.log(`  runtime       : not cached yet — downloading and verifying it first, this can take minutes`)
  }
  const args = [join(PLUGIN_ROOT, 'host', 'selftest.js'), '--cwd', VERIFY_CWD]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        UNICA_RUNTIME_CACHE_DIR: RUNTIMES,
        UNICA_PROVIDER_STATE_DIR: PROVIDER_STATE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const started = Date.now()
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve({ ...result, stderr, ms: result.ms ?? Date.now() - started })
    }
    const timer = setTimeout(() => finish({ ok: false, stderr: `self-test did not finish in ${budget / 1000} s` }), budget)
    child.on('error', (error) => finish({ ok: false, stderr: String(error.message) }))
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false })
      const at = stdout.indexOf('{')
      if (at === -1) return finish({ ok: false, stderr: 'self-test produced no report' })
      let report
      try {
        report = JSON.parse(stdout.slice(at))
      } catch (error) {
        return finish({ ok: false, stderr: `unreadable self-test report: ${error.message}` })
      }
      finish({ ok: report.ok === true, tools: report.tools, server: report.server, root: report.root })
    })
  })
}

/**
 * The refusal the cache directory can cause, and the only one this tool repairs.
 *
 * The bootstrap writes lock and transaction files next to the runtime. When the
 * directory mask refuses that it exits within ~20 ms with
 * `unica-bootstrap: Отказано в доступе. (os error 5)`, the bridge reports no
 * working tools, and the session looks like a broken install — a symptom three
 * steps away from its cause.
 *
 * Timing is the reliable signal, not the wording: a cold cache spends minutes
 * downloading and says little, while a refusal is over before the process can
 * print anything useful. Matching the message as well would tie this to the
 * bootstrap's locale, and the same refusal arrives in a different language on a
 * different machine.
 */
function isAccessRefusal(result) {
  if (result.ok) return false
  const message = result.stderr ?? ''
  if (/Access is denied|Отказано в доступе|os error 5/i.test(message)) return true
  return result.ms !== undefined && result.ms < 2_000 && result.code !== 0
}

/**
 * Where to move the cache when the default location refuses the bootstrap.
 *
 * Beside the plugin: that directory is known to be writable, because the plugin
 * itself was just unpacked there.
 */
function relocationTarget() {
  return join(dirname(PLUGIN_ROOT), '.unica-cache')
}

/** Adds `indent` to every non-empty line; blank lines stay blank. */
function indentBlock(text, indent) {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : indent + line))
    .join('\n')
}

/** Leading-space width of a line. */
function indentWidth(line) {
  return line.match(/^( *)/)[1].length
}

/**
 * Locates a TOP-LEVEL `- id:` entry.
 *
 * Deliberately not a regex: `^- id: x$` with the multiline flag also matches the
 * indented child rows of an `- insert:` list, and acting on that match removed a
 * sibling entry instead of the intended one.
 *
 * @returns `{ at, end }` line indices, or `undefined`
 */
function findTopLevelEntry(lines, id) {
  for (let i = 0; i < lines.length; i += 1) {
    if (indentWidth(lines[i]) === 0 && lines[i] === `- id: ${id}`) {
      return { at: i, end: findEntryEnd(lines, i) }
    }
  }
  return undefined
}

/**
 * Last line index (exclusive) of the entry starting at `at`.
 *
 * The entry ends where the next line in column 1 begins; section comments inside
 * it are indented in neither case, so they travel with the entry they precede.
 */
function findEntryEnd(lines, at) {
  for (let i = at + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue
    if (indentWidth(lines[i]) === 0 && !lines[i].startsWith('#')) return i
  }
  return lines.length
}

/**
 * Removes the top-level entry with this id, keeping everything else intact.
 *
 * @returns the new file text, or `undefined` when the id has no top-level entry
 */
function removeTopLevelEntry(text, id) {
  const lines = text.split('\n')
  const found = findTopLevelEntry(lines, id)
  if (found === undefined) return undefined
  const head = lines.slice(0, found.at).join('\n').replace(/[ \t]*\n+$/, '')
  const tail = lines.slice(found.end).join('\n').replace(/^\n+/, '')
  return `${head}${tail === '' ? '' : `\n\n${tail.replace(/[ \t]*\n*$/, '')}`}\n`
}

/** The bridge row name: a file URL, because the loader resolves module specifiers. */
const NATIVE_ENTRY = pathToFileURL(join(PLUGIN_ROOT, 'host', 'index.js')).href

/**
 * The bridge row both targets share, at column 0.
 *
 * The row points at this plugin's own `host/index.js`; the bridge resolves the
 * working directory per call from the session, so there is no `cwd` here and no
 * workspace pin anywhere in the profile.
 */
function nativeRow() {
  return `- id: unica-native
  name: '${NATIVE_ENTRY}'
  config:
    pluginRoot: '${PLUGIN_ROOT}'
    runtimeCacheDir: '${RUNTIMES}'
    providerStateDir: '${PROVIDER_STATE}'
    maxProcesses: 4
    idleMs: 600000
    toolCallTimeoutMs: 600000
`
}

/**
 * The standalone profile patch: correct for headless, TUI, SDK and ACP profiles.
 *
 * Those profiles compose their agent plane straight from the host composition
 * instead of mounting a preset, so the rows go into the profile patch itself.
 */
function profilePatchBody() {
  return `${nativeRow()}
- id: skill-filesystem-unica
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    providerName: unica-plugin
    includeDefaultRoots: false
    customSkillDirs:
      - '${SKILLS}'
    watch: false
`
}

const PROFILE_BANNER = `# Unica for DeepSeek Harness — profile patch, maintained by
# dsh-plugin-unica/install.mjs. Entries are updated in place by id; anything
# else in this file is left alone.
`

/**
 * Port rules that must hold for EVERY session, not only while a skill that
 * documents them happens to be loaded.
 *
 * A second `persona` row is not an option: `dsh-persona` registers the persona
 * section names globally, so a duplicate row collides and fails loud. The rules
 * are therefore injected into the shipped persona row's own `suffix` template,
 * which is what makes them permanent for the session.
 *
 * These describe Unica 0.13 and replace the four 0.12 field corrections, which
 * named `role.edit`, `meta.add`, `role.compile` and `v8-runner`. None of those
 * tools exists now: 0.13 collapsed 74 domain actions into eleven tools, and the
 * problems those corrections warned about are answered by the new contract —
 * `apply` plans before it writes, `check` owns the validators. Keeping the old
 * text would have been worse than having no rules, because the model would have
 * followed instructions for a tool surface that no longer exists.
 */
const PERSONA_ANCHOR = 'suffix: Your working directory is {{cwd}}.'

/**
 * The standing rules, without the working-directory line.
 *
 * DSH 0.2.0 registered a `cwd` prompt variable, and its shipped template carried
 * `suffix: Your working directory is {{cwd}}.`; rewriting that line attached the
 * rules to the persona row. DSH 0.2.1 removed both: the template has no suffix
 * line, and `{{cwd}}` is no longer a registered variable — a leftover reference
 * makes prompt rendering throw, because every `{{name}}` is resolved or the
 * section fails. So the rules start here, and `applyPersonaRules` decides how to
 * attach them to whatever persona row the installed DSH ships.
 */
const PORT_RULES = `Unica rules for this session:
- Address work with \`at\` (\`<sourceSet>:<Kind>[.<Name>...]\`). There is no
  \`cwd\` argument: the workspace comes from the session, and
  \`unica.resolve\` names the available sets.
- \`unica.apply\` plans before it writes. The call that carries \`at\` and
  \`ops\` returns \`data.executionToken\` and changes nothing; calling it
  again with only that token executes the saved plan.
- \`unica.check\` runs every validator a node's kind owns. The per-kind
  \`*.validate\` tools of earlier versions no longer exist.
- Tool arguments are not described on the wire. What a node accepts is its
  \`can\` list (\`unica.view\` with \`filter: {sections: ["can"]}\`), and a
  refused call names the offending field in \`diagnostics[].message\`.
  \`unica.docs\` searches 1C documentation, not tool contracts.
- \`unica.search\` with \`corpus: "text"\` matches BSL code only; metadata
  names live in \`corpus: "names"\`. An answer that returns a \`task\` must be
  followed through \`unica.task.result\`, not repeated.
- Runtime and build work may fetch an engine on first use, so the first such
  call can need network and take noticeably longer than the rest.`

/** The rules re-indented to sit under a `suffix:` key at `indent`. */
function personaRules(indent) {
  return PORT_RULES.split('\n')
    .map((line) => (line.trim() === '' ? '' : indent + line))
    .join('\n')
}

/** The 0.2.0 shape: the rules replace the working-directory line in place. */
const PERSONA_SUFFIX = `suffix: >-
      Your working directory is {{cwd}}.

${personaRules('      ')}`

/**
 * Attaches the port rules to the persona row of the shipped template.
 *
 * Two template shapes exist, and only the 0.2.0 one can be recognised by text:
 * it carries the working-directory suffix line, which is replaced. Since 0.2.1
 * the persona row has a `prefix` and no `suffix`, so the rules are added as a
 * `suffix:` key beside it — the row still declares that field, which is what
 * makes the rules permanent for the session instead of only while a skill
 * happens to be loaded.
 *
 * The new block is literal (`|`), not folded (`>-`): the rules are a list, and a
 * folded scalar would join every bullet into one paragraph.
 *
 * @param standardYaml - the shipped template, as top-level rows at 2-space indent
 * @returns the template with the rules in place
 */
function applyPersonaRules(standardYaml) {
  if (standardYaml.includes(PERSONA_ANCHOR)) return standardYaml.replace(PERSONA_ANCHOR, PERSONA_SUFFIX)

  const lines = standardYaml.split('\n')
  const personaAt = lines.findIndex((line) => /^- id: persona$/.test(line))
  if (personaAt === -1) {
    throw new Error('the standard composition has no persona row; the Unica rules could not be made permanent')
  }
  const nextRow = lines.findIndex((line, i) => i > personaAt && /^- id: \S/.test(line))
  const limit = nextRow === -1 ? lines.length : nextRow

  const prefixPattern = /^\s+prefix: You are a coding agent powered by the \{\{model\}\} model\.\s*$/
  const prefixAt = lines.findIndex((line, i) => i > personaAt && i < limit && prefixPattern.test(line))
  if (prefixAt === -1) {
    throw new Error(
      'the standard composition has neither the 0.2.0 persona suffix nor the 0.2.1 persona prefix row; ' +
        'the Unica rules could not be made permanent. Re-check the template before installing.',
    )
  }
  const indent = lines[prefixAt].match(/^(\s*)/)[1]

  // A template that ever ships both shapes is rewritten, not extended: the row
  // registers one suffix section, and two would collide.
  const suffixAt = lines.findIndex((line, i) => i > personaAt && i < limit && line.startsWith(`${indent}suffix:`))
  if (suffixAt !== -1) {
    let after = suffixAt + 1
    while (after < lines.length) {
      const line = lines[after]
      if (line.trim() !== '' && line.match(/^(\s*)/)[1].length <= indent.length) break
      after += 1
    }
    lines.splice(suffixAt, after - suffixAt)
  }

  const insertAfter = lines.findIndex((line, i) => i > personaAt && prefixPattern.test(line))
  lines.splice(insertAfter + 1, 0, `${indent}suffix: |`, personaRules(`${indent}  `))
  return lines.join('\n')
}

/**
 * The Web-GUI target. Web sessions are composed from an agent preset, and the
 * shipped `standard` preset mounts its OWN skill-filesystem row while the web
 * bundle disables the host-plane one — so a profile patch alone would give a Web
 * session the tools but no skills. A user preset is the only Web-side seam, and
 * presets have no "inherit and extend", so the standard composition is copied
 * and extended here (the same duplication the shipped `cordis` and `ptc`
 * presets accept).
 *
 * @param standardYaml - the shipped template, as top-level rows at 2-space indent
 */
function presetRow(standardYaml) {
  // Fail loud instead of shipping a preset whose standing rules were silently
  // dropped by an upstream edit to the template.
  const withRules = applyPersonaRules(standardYaml)

  const bridgeRows = `
# ── added by dsh-plugin-unica ────────────────────────────────────────────────
# The native unica bridge. It exposes the same eleven tools as before
# (mcp__unica__<raw name with '.'->'_'>_<hash12>), but every call resolves its
# working directory from the DSH session and starts one unica process per
# directory instead of pinning one project for the whole profile.
${nativeRow()}
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
  const composition = `${withRules.trimEnd()}\n${bridgeRows}`.replace(/\s*$/, '')

  // The whole composition is nested as `config.plugins`, indented one level per
  // YAML level: 4 under the `- insert:` payload, then 6 under `plugins:`. A
  // plain re-indent is safe where re-serialising would not be — the persona
  // rules live in a folded scalar whose meaning depends on its indentation.
  return `- id: ${PRESET_ROW_ID}
  name: '${PRESET_ROW_NAME}'
  config:
    id: ${PRESET_ID}
    name: Unica 1C
    description: >-
      Разработка на 1С:Предприятии: метаданные, формы, роли, СКД и MXL,
      внешние обработки и отчёты, сборка и обновление ИБ, поиск и диагностика
      BSL-кода. Полный стандартный набор инструментов плюс нативные инструменты unica.
    order: 50
    plugins:
${indentBlock(composition, '      ')}
`
}

/**
 * Locates the template the preset is copied from.
 *
 * 0.2.0 moved the shipped presets out of a scanned directory and into the web
 * bundle, so the template is now a patch file rather than an `agent.cordis.yml`.
 * `--standard` overrides the search: CI has no DSH installed, and this keeps the
 * generator itself testable there.
 *
 * @returns `{ path, text }` — `path` names where it came from for the report,
 *   which for a bundled Desktop install is a path inside `app.asar`
 */
function standardTemplate() {
  const explicit = arg('standard', undefined)
  if (explicit !== undefined) {
    const path = resolve(explicit)
    if (!existsSync(path)) throw new Error(`--standard points at a file that does not exist: ${path}`)
    return { path, text: readFileSync(path, 'utf8') }
  }
  const rel = join('@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')
  const candidates = [
    join(PLUGIN_ROOT, 'node_modules', rel),
    join(dirname(PLUGIN_ROOT), 'node_modules', rel),
    ...harnessRoots().map((root) => join(root, 'node_modules', rel)),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (found !== undefined) return { path: found, text: readFileSync(found, 'utf8') }

  // DSH Desktop ships the harness inside app.asar rather than a node_modules on
  // disk. Without this branch the template is "not found" on a machine where it
  // is plainly present, which is exactly how Desktop installation failed.
  const bundle = harnessAsar()
  if (bundle !== undefined) {
    const internal = `dsh/node_modules/${rel.split(sep).join('/')}`
    const bytes = readAsarFile(internal, bundle)
    if (bytes !== undefined) return { path: `${bundle.asar}\\${internal.replace(/\//g, '\\')}`, text: bytes.toString('utf8') }
  }

  throw new Error(
    `cannot locate the shipped 'standard' preset composition. Looked at:\n  ${candidates.join('\n  ')}\n` +
      `DSH 0.2.0 or newer is required: before it, presets were scanned from ` +
      `$DSH_HOME/.agent-presets and this installer wrote files there instead.\n` +
      `A bundled Desktop install was ${bundle === undefined ? 'not found either' : `found at ${bundle.asar}, but it carries no ${rel}`}.\n` +
      `Pass DSH_INSTALL_ROOT=<the directory containing node_modules, or the app.asar, of your DSH install>, ` +
      `or --standard <path> to build from another composition.`,
  )
}

/**
 * Reads the shipped template as its payload rows.
 *
 * The template is a patch file (`- insert:` + one wrapping row whose
 * `config.plugins` holds the composition), so the child entries have to be
 * lifted out of that wrapper before they can be nested under this preset's own
 * `config.plugins`. Copying the wrapper too would nest a whole preset row inside
 * the composition.
 */
function templateRows(templateText) {
  const lines = templateText.split('\n')
  const from = lines.findIndex((line) => /^- insert:$/.test(line))
  if (from === -1) throw new Error('the standard composition no longer starts with a top-level `- insert:` payload')
  const payload = []
  for (const line of lines.slice(from + 1)) {
    if (line.trim() !== '' && !line.startsWith('  ')) break
    payload.push(line)
  }
  // Flat scans cannot drift with the template's nesting: the wrapper row
  // declares `config:` one level in and `plugins:` two, so child entries start
  // at `firstRow + 6` and are normalised back to column 0 from there.
  const idAt = payload.findIndex((line) => /^    - id: \S/.test(line))
  if (idAt === -1) throw new Error('the standard composition carries no row inside its `- insert:` payload')
  const firstRow = payload[idAt].match(/^(\s*)- id: /)[1].length
  const pluginsAt = payload.findIndex((line, i) => i > idAt && line === ' '.repeat(firstRow + 4) + 'plugins:')
  if (pluginsAt === -1) throw new Error('the standard composition has no `config.plugins` list to copy')
  const rows = payload
    .slice(pluginsAt + 1)
    .map((line) => (line.startsWith(' '.repeat(firstRow + 6)) ? line.slice(firstRow + 6) : line))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\s*$/, '')
  if (rows === '') throw new Error('the standard composition carries an empty `config.plugins` list')
  return `${rows}\n`
}

/**
 * Splits a generated block into its top-level `- id:` entries.
 *
 * A patch addresses entries by id, so every entry has to be applied on its own:
 * upserting a block of two entries as one unit would append one of them twice.
 */
function splitEntries(block) {
  const lines = block.trimEnd().split('\n')
  const starts = []
  for (let i = 0; i < lines.length; i += 1) {
    if (/^- id: \S/.test(lines[i])) starts.push(i)
  }
  if (starts.length === 0) throw new Error('an entry block without a top-level `- id:` row cannot be applied by id')
  return starts.map((start, n) => lines.slice(start, n + 1 < starts.length ? starts[n + 1] : lines.length).join('\n').replace(/\s*$/, ''))
}

/**
 * Drops the child row `id` from every `- insert:` list that carries it.
 *
 * The installer writes top-level entries, so a row left inside an older
 * install's `- insert:` list is not rewritten in place — it is taken out, and
 * the entry is written at top level afterwards. Two tasks with one id is what
 * DSH refuses to load, so leaving both is not an option.
 *
 * @returns `{ text, removed }`
 */
function removeInsertChild(text, id) {
  const lines = text.split('\n')
  const out = []
  let removed = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (indentWidth(lines[i]) !== 0 || lines[i] !== '- insert:') {
      out.push(lines[i])
      continue
    }
    const end = findEntryEnd(lines, i)
    const payload = lines.slice(i + 1, end)
    let width = 0
    for (const line of payload) {
      if (line.trim() !== '' && !line.startsWith('#')) {
        width = indentWidth(line)
        break
      }
    }
    const child = `${' '.repeat(width)}- id: ${id}`
    const kept = []
    for (let j = 0; j < payload.length; j += 1) {
      if (width > 0 && indentWidth(payload[j]) === width && payload[j] === child) {
        // The row owns the comment block directly above it.
        while (kept.length > 0 && kept[kept.length - 1].trimStart().startsWith('#')) kept.pop()
        j += 1
        while (j < payload.length && !(indentWidth(payload[j]) === width && payload[j].startsWith('- '))) j += 1
        j -= 1
        removed += 1
        continue
      }
      kept.push(payload[j])
    }
    out.push(lines[i], ...kept)
    i = end - 1
  }
  return { text: out.join('\n'), removed }
}

/**
 * Drops `- insert:` entries that no longer hold any child.
 *
 * Taking a row out of a list can leave its empty parent behind, and an empty
 * `insert:` is an entry DSH cannot make sense of.
 *
 * @returns `{ text, removed }`
 */
function removeEmptyInserts(text) {
  const lines = text.split('\n')
  const out = []
  let removed = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (/^- insert:\s*$/.test(lines[i])) {
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j += 1
      if (j >= lines.length || /^- /.test(lines[j])) {
        removed += 1
        // Swallow the blank separator this entry owned, so no double blank line
        // is left where it stood.
        while (i + 1 < lines.length && lines[i + 1].trim() === '') i += 1
        continue
      }
    }
    out.push(lines[i])
  }
  return { text: out.join('\n'), removed }
}

/**
 * Normalises a profile patch before editing it.
 *
 * Every anchor in this file ends a line, and a Windows editor writes CRLF, so a
 * `^`-to-`$` match would silently miss — which once produced a duplicate
 * `mcp-unica` row instead of an error. The BOM some editors prepend is dropped
 * for the same reason: it would sit in front of the first entry.
 *
 * @returns `{ text, eol }` where eol is restored on the way out
 */
function normalizePatch(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return { text: text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), eol }
}

/**
 * Applies one row to a profile patch, reporting exactly what happened.
 *
 * @returns a line for the install summary
 */
async function patchProfile(profile, banner, block, label, legacyIds = []) {
  const path = join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml')
  const raw = existsSync(path) ? await readFile(path, 'utf8') : ''
  const { text: existing, eol } = normalizePatch(raw)
  const rows = splitEntries(block)
  const ids = rows.map((row) => /^- id: (\S+)$/m.exec(row)[1])

  let text = existing
  const notes = []
  // A native-only release replaces the old MCP row: leaving it would register a
  // second set of tools under the same names.
  for (const legacy of legacyIds) {
    const stripped = removeInsertChild(text, legacy)
    if (stripped.removed > 0) {
      text = stripped.text
      notes.push(`${legacy}: removed the retired MCP row`)
    }
    const dropped = removeTopLevelEntry(text, legacy)
    if (dropped !== undefined) {
      text = dropped
      notes.push(`${legacy}: removed the retired top-level row`)
    }
  }
  for (const id of ids) {
    const stripped = removeInsertChild(text, id)
    if (stripped.removed > 0) {
      text = stripped.text
      notes.push(`${id}: rewritten from a nested \`- insert:\` child`)
    }
    const deduped = removeTopLevelEntry(text, id)
    if (deduped !== undefined) {
      text = deduped
      notes.push(`${id}: replaced a top-level entry, which a patch cannot declare`)
    }
  }

  const entry = `- insert:\n${indentBlock(rows.join('\n\n'), '    ')}`
  text = `${text.replace(/[ \t]*\n*$/, '')}\n\n${entry}\n`
  text = removeEmptyInserts(text).text
  if (existing.trim() === '') text = `${banner}${text}`

  await emit(path, eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text)
  const detail = notes.length === 0 ? '' : ` — ${notes.join('; ')}`
  return `  ${label}: ${ids.join(', ')} in ${path}${detail}`
}

/**
 * Writes everything the install owns and returns the report lines.
 *
 * Kept separate from `main` because `--verify` may have to run it a second time,
 * with the cache somewhere else.
 *
 * @returns one line per patched profile, plus where the template came from
 */
async function applyProfile() {
  const summary = []
  if (TARGET === 'profile' || TARGET === 'both') {
    summary.push(await patchProfile(PATCH_PROFILE, PROFILE_BANNER, profilePatchBody(), 'profile rows', ['mcp-unica']))
  }
  if (TARGET === 'preset' || TARGET === 'both') {
    const template = standardTemplate()
    summary.push(
      await patchProfile(PRESET_PROFILE, PROFILE_BANNER, presetRow(templateRows(template.text)), 'agent preset', ['mcp-unica']),
    )
    summary.push(`  preset template: ${template.path}`)
  }
  return summary
}

async function main() {
  const skillsCount = existsSync(SKILLS) ? (await readdir(SKILLS, { withFileTypes: true })).filter((e) => e.isDirectory()).length : 0
  if (skillsCount === 0) throw new Error(`no bundled skills found at ${SKILLS} — run build-skills.mjs first`)
  if (!existsSync(LAUNCH.exe)) throw new Error(`unica bootstrap for ${LAUNCH.platform}/${LAUNCH.arch} not found at ${LAUNCH.exe}`)

  let summary = await applyProfile()

  // `--verify` is what turns "the files were written" into "the tools work".
  // Only the self-test proves the last one, and a refused cache directory is the
  // one failure this tool can repair on its own: it is a property of where the
  // cache sits, not of anything the user chose.
  let verified
  let relocated = false
  if (VERIFY && !DRY_RUN) {
    verified = await nativeSelftest()
    // Only a refused cache is repaired, and the refusal is what tells us so: a
    // download that merely ran long must not move the cache behind the user's
    // back, or the runtime would be fetched twice.
    if (!verified.ok && isAccessRefusal(verified)) {
      const target = relocationTarget()
      console.log(`\nthe bootstrap was refused at ${RUNTIMES} — moving the cache to ${target}`)
      CACHE = cachePaths(target)
      RUNTIMES = CACHE.runtimes
      PROVIDER_STATE = CACHE.state
      summary = await applyProfile()
      verified = await nativeSelftest()
      relocated = verified.ok
    }
  }

  console.log(`${DRY_RUN ? '[dry-run] would install' : 'installed'} unica into ${DSH_HOME} (target: ${TARGET})`)
  console.log(`  plugin root   : ${PLUGIN_ROOT}`)
  console.log(`  launch        : ${LAUNCH.kind} — ${LAUNCH.command} ${LAUNCH.args.map((a) => `'${a}'`).join(' ')}`)
  console.log(`  platform      : ${LAUNCH.platform}/${LAUNCH.arch}`)
  console.log(`  skills        : ${skillsCount} directories at ${SKILLS}`)
  console.log(`  runtime cache : ${RUNTIMES}`)
  console.log(`  provider state: ${PROVIDER_STATE}`)
  console.log('  profile patch:')
  for (const line of summary) console.log(line)
  console.log('  files:')
  for (const p of planned) console.log(`    ${p}`)

  if (!VERIFY) {
    console.log(
      `\nDSH composes the preset roster when it loads the profile, so the row is live as soon as the\n` +
        `DSH server restarts. Then start a NEW session on the preset "Unica 1C".\n` +
        `Pass --verify to start unica here and prove the tools will work.`,
    )
    return
  }

  if (DRY_RUN) {
    console.log('\n--verify was skipped: a dry run writes nothing to start the server for.')
    return
  }

  console.log('  native check  :')
  if (verified.ok) {
    console.log(
      `    ok      serverInfo ${verified.server?.name ?? '?'} ${verified.server?.version ?? '?'}, ${verified.tools} tools in ${verified.ms} ms` +
        `${verified.root === undefined ? '' : `, workspace ${verified.root}`}`,
    )
    if (relocated) {
      console.log(
        `    note    the default cache location refused the bootstrap, so this install uses ${dirname(RUNTIMES)}.\n` +
          `            That is a directory-permission problem on this machine, not a problem with the port.`,
      )
    }
    console.log(
      `\nStart a NEW session on the preset "Unica 1C" — after restarting the DSH server, which composes\n` +
        `the preset roster when it loads the profile.`,
    )
    return
  }

  console.log(`    FAIL    unica did not answer within ${SMOKE_TIMEOUT_MS / 1000} s`)
  if (verified.stderr.trim() !== '') console.log(`            bridge said: ${verified.stderr.trim().split('\n').at(-1)}`)
  console.log(
    `\nThe profile was still patched, and DSH will report the preset as failed to load until this is\n` +
      `fixed — the picker hides such presets, so it would look like the install did nothing.\n` +
      `If the cause is a cold cache, the first download simply needs longer: run again, and the runtime\n` +
      `is kept. Otherwise check the cache directory: node tools/verify-install.mjs "${DSH_HOME}" ${PRESET_PROFILE}`,
  )
  process.exitCode = 1
}

await main()
