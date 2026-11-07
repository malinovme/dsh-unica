// Rebuilds the port's skills and references from an upstream Unica checkout.
//
//   UNICA_UPSTREAM_PLUGIN=<path to plugins/unica> node tools/build-skills.mjs
//
// The port does not fork Unica: the skill and reference corpus is a copy, and the
// only transformation is the tool namespace. Unica names its tools with dots
// (`unica.view`, `unica.apply`), and DSH publishes an MCP tool under
// `mcp__<server>__<normalized name>`, appending a 12-hex SHA-256 of
// `"<server>\0<raw name>"` whenever normalisation loses information — which the
// dots always do. Skill text therefore has to carry the public name, or the model
// reads an instruction it cannot follow.
//
// The mapping lives in `tool-map.json`, generated per upstream release from a live
// `tools/list` (see `tools/fetch-tool-map.mjs`). Nothing here guesses a name.
//
// Upstream 0.13 removed every skill this port used to patch: its four field
// corrections described `role.edit`, `meta.add`, `code.patch` and `v8-runner`, and
// none of those tools or that skill exists any more. They were dropped rather than
// translated, because the new surface already answers much of what they warned
// about — `apply` plans before it writes and returns an `executionToken` to commit
// a saved plan. A replacement correction has to be found against 0.13 in the field
// again; adding one here without that evidence would ship a guess as fact.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOLS_DIR = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url))
const OUT_ROOT = dirname(TOOLS_DIR)
const MAP_PATH = join(OUT_ROOT, 'tool-map.json')
const SKILLS_OUT = join(OUT_ROOT, 'skills')
const REFERENCES_OUT = join(OUT_ROOT, 'references')

// The upstream plugin cache is keyed by the version the port currently tracks, so
// the default comes from runtime-manifest.json rather than a literal that goes
// stale on every upgrade.
const MANIFEST = JSON.parse(await readFile(join(OUT_ROOT, 'runtime-manifest.json'), 'utf8'))
const SOURCE_PLUGIN =
  process.env.UNICA_UPSTREAM_PLUGIN ??
  join(
    process.env.USERPROFILE ?? process.env.HOME ?? '',
    '.codex',
    'plugins',
    'cache',
    'unica',
    'unica',
    process.env.UNICA_UPSTREAM_VERSION ?? MANIFEST.pluginVersion,
  )

if (!existsSync(join(SOURCE_PLUGIN, 'skills'))) {
  throw new Error(
    `no upstream plugin at ${SOURCE_PLUGIN}\n` +
      `Set UNICA_UPSTREAM_PLUGIN to a checkout's plugins/unica directory, e.g.\n` +
      `  UNICA_UPSTREAM_PLUGIN=/path/to/unica/plugins/unica node tools/build-skills.mjs`,
  )
}

const toolMap = JSON.parse(await readFile(MAP_PATH, 'utf8'))
// Longest first, so `unica.task.result` is replaced before a bare `unica.task`
// prefix could swallow part of it.
const TOOL_KEYS = Object.keys(toolMap).sort((a, b) => b.length - a.length)

/** Rewrites every mapped tool name, and reports any that are left unmapped. */
function rewrite(text) {
  let out = text
  for (const raw of TOOL_KEYS) out = out.split(raw).join(toolMap[raw])
  // A name that still looks like a tool means the map is missing an entry, and
  // shipping it would hand the model an instruction it cannot follow.
  const leftovers = [...out.matchAll(/\bunica\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+/g)].map((m) => m[0])
  return { out, leftovers }
}

await rm(SKILLS_OUT, { recursive: true, force: true })
await rm(REFERENCES_OUT, { recursive: true, force: true })
await mkdir(SKILLS_OUT, { recursive: true })

const upstreamSkills = (await readdir(join(SOURCE_PLUGIN, 'skills'), { withFileTypes: true })).filter((e) => e.isDirectory())
const unmappedSkills = new Map()
const unmappedReferences = new Map()
let rewritten = 0

for (const entry of upstreamSkills) {
  // The port prefixes the directory so its skills sit in one namespace, while the
  // frontmatter `name` stays upstream's, which is what DSH shows.
  const from = join(SOURCE_PLUGIN, 'skills', entry.name)
  const target = join(SKILLS_OUT, `unica-${entry.name}`)
  await mkdir(target, { recursive: true })
  for (const file of await readdir(from, { withFileTypes: true, recursive: true })) {
    if (file.isDirectory()) continue
    const source = join(file.parentPath, file.name)
    const rel = source.slice(from.length + 1)
    const destination = join(target, rel)
    await mkdir(dirname(destination), { recursive: true })
    if (!rel.endsWith('.md')) {
      await cp(source, destination)
      continue
    }
    const text = await readFile(source, 'utf8')
    const { out, leftovers } = rewrite(text)
    if (out !== text) rewritten += 1
    for (const left of leftovers) unmappedSkills.set(left, (unmappedSkills.get(left) ?? 0) + 1)
    await writeFile(destination, out, 'utf8')
  }
}

// The reference corpus is upstream documentation, not instructions: 0.13 still
// names ten 0.12 tools in its form/DSL specs. Rewriting those would mean inventing
// an equivalent for each and presenting the guess as upstream text, so they are
// left alone and only reported.
await cp(join(SOURCE_PLUGIN, 'references'), REFERENCES_OUT, { recursive: true })
for (const file of await readdir(REFERENCES_OUT, { withFileTypes: true, recursive: true })) {
  if (file.isDirectory() || !file.name.endsWith('.md')) continue
  const path = join(file.parentPath, file.name)
  const text = await readFile(path, 'utf8')
  const { out, leftovers } = rewrite(text)
  if (out !== text) await writeFile(path, out, 'utf8')
  for (const left of leftovers) unmappedReferences.set(left, (unmappedReferences.get(left) ?? 0) + 1)
}

await writeFile(
  join(OUT_ROOT, 'build-report.json'),
  `${JSON.stringify(
    {
      upstream: SOURCE_PLUGIN,
      skills: upstreamSkills.length,
      filesRewritten: rewritten,
      tools: Object.keys(toolMap).length,
      unmappedInSkills: Object.fromEntries(unmappedSkills),
      unmappedInReferences: Object.fromEntries(unmappedReferences),
    },
    null,
    2,
  )}\n`,
  'utf8',
)

console.log(`skills     : ${upstreamSkills.length} directories`)
console.log(`tools      : ${Object.keys(toolMap).length} mapped`)
console.log(`rewritten  : ${rewritten} files carried a tool name`)
if (unmappedReferences.size > 0) {
  console.log(`references : ${unmappedReferences.size} upstream tool names left as written (documentation, not instructions)`)
  for (const [name, count] of [...unmappedReferences].sort((a, b) => b[1] - a[1])) console.log(`  ${name} × ${count}`)
}
if (unmappedSkills.size > 0) {
  console.error('\nUNMAPPED tool names in SKILLS — the model would read instructions it cannot follow:')
  for (const [name, count] of [...unmappedSkills].sort((a, b) => b[1] - a[1])) console.error(`  ${name} × ${count}`)
  process.exitCode = 1
} else {
  console.log('skills map : every tool name resolved')
}
