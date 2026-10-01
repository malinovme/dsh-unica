// Installs the DSH port of unica into a DSH home.
//
//   node install.mjs [--dsh-home <path>] [--target preset|profile|both] [--dry-run]
//                    [--profile <name>] [--platform win32|darwin|linux]
//                    [--standard <composition.patch.yml>]
//
// `--standard` builds the preset from a given composition instead of the shipped
// `standard` one. It exists for CI, which has no DSH installed; a normal install
// finds the real template by itself.
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
const RUNTIMES = join(DSH_HOME, 'unica', 'runtimes')
const PROVIDER_STATE = join(DSH_HOME, 'unica', 'provider-state')

const planned = []
async function emit(path, content) {
  planned.push(path)
  if (DRY_RUN) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
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

async function main() {
  const skillsCount = existsSync(SKILLS) ? (await readdir(SKILLS, { withFileTypes: true })).filter((e) => e.isDirectory()).length : 0
  if (skillsCount === 0) throw new Error(`no bundled skills found at ${SKILLS} — run build-skills.mjs first`)
  if (!existsSync(LAUNCH.exe)) throw new Error(`unica bootstrap for ${LAUNCH.platform}/${LAUNCH.arch} not found at ${LAUNCH.exe}`)

  const summary = []

  if (TARGET === 'profile' || TARGET === 'both') {
    summary.push(await patchProfile(PATCH_PROFILE, PROFILE_BANNER, profilePatchBody(), 'profile rows'))
  }

  if (TARGET === 'preset' || TARGET === 'both') {
    const template = standardTemplate()
    summary.push(await patchProfile(PRESET_PROFILE, PROFILE_BANNER, presetRow(templateRows(template.text)), 'agent preset'))
    summary.push(`  preset template: ${template.path}`)
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
  if (TARGET === 'preset' || TARGET === 'both') {
    console.log(
      `\nDSH composes the preset roster when it loads the profile, so the row is live as soon as the\n` +
        `DSH server restarts. Then start a NEW session on the preset "Unica 1C".\n` +
        `Check the result without a GUI: node tools/verify-install.mjs "${DSH_HOME}" ${PRESET_PROFILE}`,
    )
  }
}

await main()
