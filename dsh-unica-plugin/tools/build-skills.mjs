// Builds the DSH port of the unica plugin from an installed upstream payload.
//
// Run from anywhere:  node tools/build-skills.mjs
//
// Source of truth:
//   <codexHome>/plugins/cache/unica/unica/<version>  -> the real upstream package
//   tools/tool-catalog.json                          -> the live `tools/list` result
//
// Overridable for a different upstream version or install layout:
//   UNICA_UPSTREAM_VERSION, UNICA_UPSTREAM_PLUGIN
//
// The only semantic rewrite is the tool-name namespace: unica skills address
// tools as `unica.<domain>.<action>`, while DSH's MCP bridge exposes them as
// `mcp__unica__unica_<domain>_<action>_<hash12>` (a dot is not legal in a
// DeepSeek function name, and the lossy replacement appends an identity hash).
// Everything else is copied byte-for-byte.
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOLS_DIR = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url))
const OUT_ROOT = dirname(TOOLS_DIR)
const CATALOG = join(TOOLS_DIR, 'tool-catalog.json')
const UPSTREAM_VERSION = process.env.UNICA_UPSTREAM_VERSION ?? '0.12.3'

const SOURCE_PLUGIN =
  process.env.UNICA_UPSTREAM_PLUGIN ??
  join(
    process.env.USERPROFILE ?? process.env.HOME ?? '',
    '.codex',
    'plugins',
    'cache',
    'unica',
    'unica',
    UPSTREAM_VERSION,
  )

const SERVER_NAME = 'unica'
const NAMESPACE = `mcp__${SERVER_NAME}__`

/**
 * Port-level corrections applied on top of the upstream skill text.
 *
 * The port does not fork unica, and these are not stylistic edits: each one
 * records a behaviour found in the field where an upstream tool does not cover
 * the path its own documentation promises. They live here, next to the rename
 * step, so a future regeneration cannot silently drop them.
 *
 * Each patch must name the tool it is about, because the tool names are
 * rewritten AFTER these are inserted.
 */
const PORT_NOTES = {
  // Defect: a partial load builds a UTF-8-with-BOM file list holding Cyrillic
  // relative paths; the platform refuses to read it. Upstream's own text in this
  // skill says the automatic full retry fires only after exit code 4 with a
  // structured result, so this failure class gets no retry.
  'v8-runner': `## Правка порта: полная пересборка при неудаче частичной

Сбой чтения файла-списка при частичной загрузке (платформа не читает
\`build/temp/partial-lists/partial-list-*.txt\`: записан UTF-8 с BOM, пути
относительные и с кириллицей вида \`Documents\\ЗаказПокупателя.xml\`) **не
приводит к автоматическому полному повтору**. Автоматический повтор, описанный
выше, вызывает только корректный структурированный результат после внешнего
кода \`4\`; этот класс ошибки в него не попадает.

Поэтому при такой ошибке не повторяй вызов с теми же аргументами, а сразу
перезапусти ту же операцию с \`fullRebuild: true\`. Для единичных изменений это
и дешевле: полная сборка одной цели обычно быстрее разбора частичной.`,

  // Defect: the generated descriptor writes the singular form, while upstream's
  // own specification and this skill use the plural vocabulary.
  'register-design': `## Правка порта: вид регистра задаётся не инструментом

\`unica.meta.add\` и \`unica.meta.edit\` **не принимают \`RegisterType\`** в
\`setProperties\`. Генератор в этом случае пишет
\`<RegisterType>Balance</RegisterType>\`, тогда как спецификация
\`references/specs/1c-config-objects-spec.md\` называет значения \`Balances\` и
\`Turnovers\`. Вид регистра выбирается выше по тексту, но задать его через MCP
нельзя.

Практическое следствие: после \`meta.add\` регистр накопления получает
\`Balance\` независимо от замысла. Чтобы получить \`Turnovers\`, правь
\`<RegisterType>\` в XML дескриптора напрямую и проверяй результат \`cf.validate\`
или \`meta.info\`. Не выдавай \`Balance\` за выбранный вид — это дефолт
генератора, а не решение.`,

  // Defect: no tool covers updating an existing role.
  'role-compile': `## Правка порта: обновление существующей роли инструментами не покрыто

Два ограничения, оба проверены на живом проекте:

- \`unica.role.edit\` **не принимает \`cwd\`** и уходит в домашний каталог,
  завершаясь \`source_set_unknown\`;
- \`unica.role.compile\` **всегда пропускает существующую роль** — даже с
  \`Force: true\` отвечает \`[SKIP] Role ... already exists\`.

Значит штатного способа дописать права в уже существующую роль у инструментов
нет. Рабочий путь: прочитать текущее состояние (\`role.info\`, \`cf.info\`),
затем править \`Rights.xml\` напрямую, не затирая существующие права, и
завершать проверкой \`role.validate\`. Не вызывай \`role.compile\` по
существующей роли в надежде на перезапись — вызов молча ничего не сделает.`,

  // Defect: without cwd the core resolves the project from the home directory.
  'code-patch': `## Правка порта: \`cwd\` обязателен

Вызов без \`cwd\` ищет источник в домашнем каталоге и падает с
\`SourceSetNotFound\`. Всегда передавай \`cwd\` рабочей области явно — правило
относится к любому инструменту \`unica.*\`, а не только к этому.`,
}

/** Injects a port note right after the skill's `## MCP routing` section heading. */
function applyPortNote(skillDir, text, stats) {
  const note = PORT_NOTES[skillDir]
  if (note === undefined) return text
  const anchor = /^## MCP routing[ \t]*$/m
  const match = anchor.exec(text)
  // Fail loud rather than ship a skill whose correction silently vanished: an
  // upstream edit that renames this heading is exactly when that would happen.
  if (match === null) {
    throw new Error(`port note for "${skillDir}" has no "## MCP routing" anchor to attach to`)
  }
  const at = match.index + match[0].length
  stats.portNotes += 1
  return `${text.slice(0, at)}\n\n${note}${text.slice(at)}`
}

async function main() {
  if (!existsSync(SOURCE_PLUGIN)) throw new Error(`unica payload not found: ${SOURCE_PLUGIN}`)
  const tools = JSON.parse(await readFile(CATALOG, 'utf8'))

  // DSH's mcp-client naming contract, mirrored verbatim from
  // @deepseek-ai/dsh-mcp-client `publicToolName()`:
  //   joined = `mcp__<server>__<raw>`
  //   normalized = joined with every char outside [A-Za-z0-9_-] replaced by '_'
  //   if (normalized === joined && normalized.length <= 64) return normalized
  //   else return normalized.slice(0, 51) + '_' + sha256(`${server}\0${raw}`).slice(0,12)
  // Note the branch is taken when EITHER the replacement changed something OR
  // the name overflows 64 chars. Every unica tool name contains dots, so every
  // public name is the hashed `<normalized>_<hash12>` form — verified by
  // reproducing the README's own example (`mcp__github__create_issue` needs no
  // hash because it has no illegal character).
  const publicName = (raw) => {
    const joined = `${NAMESPACE}${raw}`
    const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
    if (normalized === joined && normalized.length <= 64) return normalized
    const hash = createHash('sha256').update(`${SERVER_NAME}\0${raw}`).digest('hex').slice(0, 12)
    return `${normalized.slice(0, 64 - 12 - 1)}_${hash}`
  }

  const mapping = new Map(tools.map((t) => [t.name, publicName(t.name)]))
  const escaped = [...mapping.keys()]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  // Longest-first alternation, so `unica.runtime.job.list` never matches the
  // `unica.runtime.job.list…` prefix of a longer name; the trailing boundary
  // keeps `unica.cfe.patch_method` and `-x`/`.RU` suffixed prose from matching.
  const pattern = new RegExp(`(?:${escaped.join('|')})(?![A-Za-z0-9_.-])`, 'g')

  // Only the generated subtrees are cleared. The plugin root also holds the
  // hand-written packaging (installer, patch, manifests) and one-off
  // third-party payload (bootstrap binaries, licenses), so removing the root
  // here would destroy files this script does not regenerate.
  for (const generated of ['skills', 'references']) {
    await rm(join(OUT_ROOT, generated), { recursive: true, force: true })
  }
  await mkdir(join(OUT_ROOT, 'skills'), { recursive: true })

  // The skills cite their reference corpus as `../../references/...`. From an
  // upstream skill file (<plugin>/skills/<skill>/SKILL.md) that resolves to
  // <plugin-root>/references/. This port nests skills identically
  // (<plugin>/skills/unica-<skill>/SKILL.md is still two levels below the
  // plugin root), so the citations keep resolving correctly and must NOT be
  // re-anchored. Only the corpus itself has to travel with the skills:
  // omitting it silently degrades the 26 skills that read it.
  const refSrc = join(SOURCE_PLUGIN, 'references')
  const refDst = join(OUT_ROOT, 'references')
  if (existsSync(refSrc)) await cp(refSrc, refDst, { recursive: true })
  const refFiles = existsSync(refDst)
    ? (await readdir(refDst, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).length
    : 0

  const srcSkills = join(SOURCE_PLUGIN, 'skills')
  const skillDirs = (await readdir(srcSkills, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  const stats = {
    skills: 0,
    rewrittenFiles: 0,
    replacements: 0,
    portNotes: 0,
    unknownToolRefs: new Set(),
    extraFiles: 0,
  }
  const perSkill = []

  for (const dir of skillDirs) {
    const src = join(srcSkills, dir)
    const dst = join(OUT_ROOT, 'skills', `unica-${dir}`)
    await mkdir(dst, { recursive: true })

    let hits = 0
    const walk = async (from, to) => {
      for (const entry of await readdir(from, { withFileTypes: true })) {
        const s = join(from, entry.name)
        const d = join(to, entry.name)
        if (entry.isDirectory()) {
          await mkdir(d, { recursive: true })
          await walk(s, d)
          continue
        }
        const buf = await readFile(s)
        const isText = /\.(md|txt|json|ya?ml)$/i.test(entry.name)
        if (!isText) {
          await writeFile(d, buf)
          continue
        }
        let text = buf.toString('utf8')
        // Port corrections go in before the rename, so a note can name the tool
        // the ordinary way and still come out rewritten consistently.
        if (entry.name === 'SKILL.md') text = applyPortNote(dir, text, stats)
        // Catch any tool reference the live catalog does not know about, so a
        // stale skill is reported rather than silently left pointing nowhere.
        for (const m of text.matchAll(/unica\.[a-z_]+(?:\.[a-z_]+)+/g)) {
          if (!mapping.has(m[0])) stats.unknownToolRefs.add(m[0])
        }
        const rewritten = text.replace(pattern, (found) => {
          hits += 1
          return mapping.get(found)
        })
        if (rewritten !== text) {
          stats.rewrittenFiles += 1
          stats.replacements += hits
        }
        await writeFile(d, rewritten, 'utf8')
        if (entry.name !== 'SKILL.md') stats.extraFiles += 1
      }
    }
    await walk(src, dst)

    // Drop Codex-only per-host artifacts: they declare a host this port is not.
    const codexAgents = join(dst, 'agents')
    if (existsSync(codexAgents)) await rm(codexAgents, { recursive: true, force: true })

    stats.skills += 1
    perSkill.push({ skill: `unica-${dir}`, toolRefs: hits })
  }

  const report = {
    sourcePlugin: SOURCE_PLUGIN,
    outRoot: OUT_ROOT,
    serverName: SERVER_NAME,
    tools: tools.length,
    skills: stats.skills,
    referenceFiles: refFiles,
    portNotes: stats.portNotes,
    rewrittenFiles: stats.rewrittenFiles,
    replacements: stats.replacements,
    extraFiles: stats.extraFiles,
    unknownToolRefs: [...stats.unknownToolRefs].sort(),
    skillsWithoutToolRefs: perSkill.filter((s) => s.toolRefs === 0).map((s) => s.skill),
    portNotesApplied: Object.keys(PORT_NOTES).map((s) => `unica-${s}`).sort(),
  }
  await writeFile(join(TOOLS_DIR, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(join(OUT_ROOT, 'tool-map.json'), `${JSON.stringify(Object.fromEntries(mapping), null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
}

await main()
