// Installs the DSH port of unica into a DSH home.
//
//   node install.mjs [--dsh-home <path>] [--target preset|profile|both] [--dry-run]
//                    [--profile <name>] [--platform win32|darwin|linux]
//                    [--cache-dir <path>] [--standard <composition.patch.yml>]
//
// `--standard` builds the preset from a given composition instead of the shipped
// `standard` one. It exists for CI, which has no DSH installed; a normal install
// finds the real template by itself.
//
// `--cache-dir` puts the runtime cache and the provider state there instead of
// `$DSH_HOME/unica`. On Windows it is the escape hatch for a `$DSH_HOME` whose
// directory mask refuses the bootstrap's lock files; see the note on CACHE_DIR.
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
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
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
const DSH_HOME = resolve(arg('dsh-home', process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')))
const TARGET = arg('target', 'preset')
// Each target defaults to the profile it belongs to; an explicit --profile wins
// for both. Web is the only profile served by presets, and headless is where a
// preset-free patch was historically installed.
const PROFILE_ARG = arg('profile', undefined)
const PRESET_PROFILE = PROFILE_ARG ?? 'web'
const PATCH_PROFILE = PROFILE_ARG ?? 'headless'

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

/**
 * Both writable directories the bootstrap owns.
 *
 * `--cache-dir` moves them together, and on Windows it is sometimes the only way
 * to get a working MCP server. The bootstrap writes lock and transaction files
 * next to the runtime, and a `$DSH_HOME` under the user profile can carry a
 * directory mask that refuses it: the process then dies with
 * `unica-bootstrap: Отказано в доступе. (os error 5)` about twenty milliseconds
 * in, the MCP client reports `initial connection or tool synchronization
 * failed`, and a preset that carries that row shows up as failed to load.
 */
const CACHE_ARG = arg('cache-dir', undefined)

/** Where the bootstrap keeps its runtime and the provider state. */
function cachePaths(cacheDir) {
  const root = cacheDir === undefined ? DSH_HOME : resolve(cacheDir)
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

/** How long the MCP handshake is given when the runtime is already cached. */
const SMOKE_TIMEOUT_MS = 120_000
/** The budget for a cold cache, which must download and verify ~100 MB first. */
const COLD_TIMEOUT_MS = 1_800_000
const EXPECTED_TOOLS = 74

/**
 * The runtime's readiness marker.
 *
 * Its presence is what separates the two cases that need different budgets: a
 * cached runtime answers in seconds, while a cold one spends minutes on the
 * download and would look broken under the handshake's timeout.
 */
function readyMarker() {
  const target = LAUNCH.platform === 'win32' ? 'win-x64' : LAUNCH.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64'
  return join(RUNTIMES, '0.12.3', target, '.ready.json')
}

/** Runs the bootstrap and gives up after `timeoutMs`, whatever it was doing. */
function runBootstrap(timeoutMs, ask) {
  return new Promise((resolve) => {
    const child = spawn(LAUNCH.command, LAUNCH.args, {
      env: { ...process.env, UNICA_RUNTIME_CACHE_DIR: RUNTIMES, UNICA_PROVIDER_STATE_DIR: PROVIDER_STATE },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let exitCode
    /** Complete JSON lines seen so far; a line can span several chunks. */
    const lines = []
    let pending = ''
    const started = Date.now()
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve({ code: exitCode, ...result, stderr, ms: Date.now() - started })
    }
    const timer = setTimeout(() => finish({ ok: false }), timeoutMs)
    child.on('error', (error) => finish({ ok: false, stderr: String(error.message) }))
    child.on('exit', (code) => {
      exitCode = code
      finish({ ok: false })
    })
    // A dead child turns these writes into EPIPE, and an unhandled `error` on a
    // socket takes the whole installer down with it. The exit handler above has
    // already recorded the failure, so the write error itself carries nothing.
    child.stdin.on('error', () => {})
    child.stdout.on('error', () => {})
    const send = (message) => {
      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    // The server speaks only when spoken to: without this request it waits
    // forever, and a probe that just listens would report a healthy server as
    // dead after the full timeout.
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-plugin-unica-installer', version: '1' } },
    })
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      // One JSON line can span chunks — the tool catalogue is a single line of
      // over a megabyte — so only complete lines are handed on, and the tail
      // waits for the rest of itself.
      const text = pending + chunk.toString()
      const parts = text.split('\n')
      pending = parts.pop() ?? ''
      lines.push(...parts.filter((l) => l.trim() !== ''))
      if (ask !== undefined) ask(child, lines, finish, send)
    })
  })
}

/**
 * Starts the MCP server exactly as the profile will and speaks to it.
 *
 * This is the only check that answers the question a user actually has — "will
 * the mode work?" — because everything before it only proves that files were
 * written. A profile can be composed perfectly and still carry a row whose
 * server never starts, and DSH then reports the whole preset as failed to load.
 *
 * A cold cache downloads the runtime inside this same run, so the budget follows
 * the cache rather than the handshake.
 *
 * @returns `{ ok, tools, server, stderr, ms }` — `ok` is false with `stderr`
 *   carrying the bootstrap's own message when the server never answered
 */
function smokeTest() {
  const budget = existsSync(readyMarker()) ? SMOKE_TIMEOUT_MS : COLD_TIMEOUT_MS
  if (budget === COLD_TIMEOUT_MS) {
    console.log(`  runtime       : not cached yet — downloading and verifying it first, this can take minutes`)
  }
  // The output arrives in many chunks, and the tool catalogue is a single line of
  // over a megabyte, so the reader works on complete lines collected by
  // `runBootstrap`. Every step below runs at most once.
  let asked = false
  let counted = false
  let serverInfo
  return runBootstrap(budget, (_child, lines, finish, send) => {
    const lineWith = (id) => lines.find((l) => l.includes(`"id":${id}`))
    if (!asked) {
      const initialized = lineWith(1)
      if (initialized === undefined) return
      asked = true
      let server
      try {
        server = JSON.parse(initialized).result?.serverInfo
      } catch {
        /* answered, but not with a result: treated as not started */
      }
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      serverInfo = server
      return
    }
    if (counted) return
    const listed = lineWith(2)
    if (listed === undefined) return
    counted = true
    let tools
    try {
      tools = JSON.parse(listed).result?.tools?.length
    } catch {
      /* fall through with tools undefined */
    }
    finish({ ok: tools === EXPECTED_TOOLS, tools, server: serverInfo })
  })
}

/**
 * The refusal the cache directory can cause, and the only one this tool repairs.
 *
 * The bootstrap writes lock and transaction files next to the runtime. When the
 * directory mask refuses that it exits within ~20 ms with
 * `unica-bootstrap: Отказано в доступе. (os error 5)`, the MCP client reports
 * `initial connection or tool synchronization failed`, and DSH shows the preset
 * as failed to load — a symptom three steps away from its cause.
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

/**
 * The standalone profile patch: correct for headless, TUI, SDK and ACP profiles.
 *
 * Those profiles compose their agent plane straight from the host composition
 * instead of mounting a preset, so the rows go into the profile patch itself.
 */
function profilePatchBody() {
  return `- id: mcp-unica
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: unica
    transport: stdio
${launchBlock('    ')}
    env:
${envBlock('      ')}
    failOnStartupError: true
    toolCallTimeoutMs: 600000

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
 */
const PERSONA_ANCHOR = 'suffix: Your working directory is {{cwd}}.'
const PERSONA_SUFFIX = `suffix: >-
      Your working directory is {{cwd}}.

      Unica rules for this session:
      - Always pass \`cwd\` explicitly to every \`unica.*\` call. Without it the
        core resolves the project from the home directory and fails with
        \`SourceSetNotFound\`; some tools, such as \`unica.role.edit\`, do not
        accept \`cwd\` at all and resolve nothing.
      - A failed partial build must be retried once with \`fullRebuild: true\`
        rather than repeated unchanged. The automatic full retry covers only a
        structured result after v8-runner exit code 4, so a platform read
        failure of the partial file list is not retried.
      - \`unica.meta.add\` cannot set a register's kind. The generator writes
        \`Balance\`; a register that needs \`Turnovers\` is corrected in the
        descriptor XML and re-checked.
      - An existing role cannot be updated by tools: \`unica.role.compile\`
        skips it even with \`force\`. Edit \`Rights.xml\` and verify with
        \`unica.role.validate\`.`

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
  if (!standardYaml.includes(PERSONA_ANCHOR)) {
    throw new Error(
      `the standard composition no longer carries the expected persona suffix (${PERSONA_ANCHOR}); ` +
        `the port rules would be lost. Re-check the template before installing.`,
    )
  }
  const withRules = standardYaml.replace(PERSONA_ANCHOR, PERSONA_SUFFIX)

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
  const composition = `${withRules.trimEnd()}\n${mcpRow}`.replace(/\s*$/, '')

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
      BSL-кода. Полный стандартный набор инструментов плюс MCP-сервер unica.
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
async function patchProfile(profile, banner, block, label) {
  const path = join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml')
  const raw = existsSync(path) ? await readFile(path, 'utf8') : ''
  const { text: existing, eol } = normalizePatch(raw)
  const rows = splitEntries(block)
  const ids = rows.map((row) => /^- id: (\S+)$/m.exec(row)[1])

  let text = existing
  const notes = []
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
    summary.push(await patchProfile(PATCH_PROFILE, PROFILE_BANNER, profilePatchBody(), 'profile rows'))
  }
  if (TARGET === 'preset' || TARGET === 'both') {
    const template = standardTemplate()
    summary.push(await patchProfile(PRESET_PROFILE, PROFILE_BANNER, presetRow(templateRows(template.text)), 'agent preset'))
    summary.push(`  preset template: ${template.path}`)
  }
  return summary
}

async function main() {
  const skillsCount = existsSync(SKILLS) ? (await readdir(SKILLS, { withFileTypes: true })).filter((e) => e.isDirectory()).length : 0
  if (skillsCount === 0) throw new Error(`no bundled skills found at ${SKILLS} — run build-skills.mjs first`)
  if (!existsSync(LAUNCH.exe)) throw new Error(`unica bootstrap for ${LAUNCH.platform}/${LAUNCH.arch} not found at ${LAUNCH.exe}`)

  let summary = await applyProfile()

  // `--verify` is what turns "the files were written" into "the mode will work".
  // Only the handshake proves the last one, and a refused cache directory is the
  // one failure this tool can repair on its own: it is a property of where the
  // cache sits, not of anything the user chose.
  let verified
  let relocated = false
  if (VERIFY && !DRY_RUN) {
    verified = await smokeTest()
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
      verified = await smokeTest()
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
        `Pass --verify to start the MCP server here and prove the mode will work.`,
    )
    return
  }

  if (DRY_RUN) {
    console.log('\n--verify was skipped: a dry run writes nothing to start the server for.')
    return
  }

  console.log('  mcp check     :')
  if (verified.ok) {
    console.log(`    ok      serverInfo ${verified.server?.name ?? '?'} ${verified.server?.version ?? '?'}, ${verified.tools} tools in ${verified.ms} ms`)
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

  console.log(`    FAIL    the MCP server did not answer within ${SMOKE_TIMEOUT_MS / 1000} s`)
  if (verified.stderr.trim() !== '') console.log(`            bootstrap said: ${verified.stderr.trim().split('\n').at(-1)}`)
  console.log(
    `\nThe profile was still patched, and DSH will report the preset as failed to load until this is\n` +
      `fixed — the picker hides such presets, so it would look like the install did nothing.\n` +
      `If the cause is a cold cache, the first download simply needs longer: run again, and the runtime\n` +
      `is kept. Otherwise check the cache directory: node tools/verify-install.mjs "${DSH_HOME}" ${PRESET_PROFILE}`,
  )
  process.exitCode = 1
}

await main()
