// Validates an agent preset with DSH's OWN discovery and health check, so the
// verdict does not depend on a hand-rolled parser.
//
//   node tools/validate-preset.mjs [preset-root-dir]
//
// `scanRoot(root, harnessBase)` resolves each row's package name against
// `harnessBase` — the base URL of the installed harness — proves the row is a
// named module row, and reports `broken` with the offending rows otherwise.
//
// DSH ships js-yaml and the preset packages as dependencies of the harness, not
// of this plugin, so the harness location has to be supplied: DSH_INSTALL_ROOT,
// or a node_modules directory on PATH. Without either, the check cannot run.
import { existsSync } from 'node:fs'
import { delimiter, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

function harnessRoots() {
  const roots = []
  const explicit = process.env.DSH_INSTALL_ROOT
  if (explicit !== undefined && explicit !== '') roots.push(explicit)
  // Windows env names are case-insensitive and Node keeps the original spelling.
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path')
  const tail = `.bin${sep}`
  for (const entry of (process.env[pathKey] ?? '').split(delimiter)) {
    const at = entry.endsWith(tail) ? entry.length - tail.length : entry.endsWith('.bin') ? entry.length - '.bin'.length : -1
    const prefix = `node_modules${sep}`
    if (at > 0 && entry.slice(0, at).endsWith(prefix)) roots.push(entry.slice(0, at - prefix.length))
  }
  return [...new Set(roots)]
}

const roots = harnessRoots()
const moduleUrl = roots
  .map((r) => join(r, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'lib', 'index.js'))
  .find((p) => existsSync(p))
if (moduleUrl === undefined) {
  throw new Error(
    `cannot find @deepseek-ai/dsh-agent-presets to validate with. Looked in:\n  ${roots.join('\n  ') || '(nothing: DSH is not on PATH)'}\nPass DSH_INSTALL_ROOT=<directory containing node_modules of your DSH install>.`,
  )
}
const harnessBase = pathToFileURL(join(roots.find((r) => moduleUrl.startsWith(r)), 'node_modules') + sep).href

const presetRoot = resolve(process.argv[2] ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', '.agent-presets'))
const { scanRoot } = await import(pathToFileURL(moduleUrl).href)

const presets = await scanRoot({ path: presetRoot, trust: 'user' }, harnessBase)
for (const p of presets) {
  console.log(`preset id   : ${p.id}`)
  console.log(`trust       : ${p.trust}`)
  console.log(`display name: ${p.name ?? '(none)'}`)
  console.log(`order       : ${p.order ?? '(none)'}`)
  console.log(`composition : ${p.path}`)
  console.log(`status      : ${p.broken === undefined ? 'HEALTHY' : 'BROKEN'}`)
  if (p.broken !== undefined) console.log(`reason      : ${p.broken}`)
}
if (presets.length === 0) console.log(`NO PRESETS DISCOVERED in ${presetRoot}`)
process.exitCode = presets.some((p) => p.broken !== undefined) ? 1 : 0
