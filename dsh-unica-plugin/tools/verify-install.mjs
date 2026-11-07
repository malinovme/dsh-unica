#!/usr/bin/env node
// The end-to-end gate: composes the installed profile with DSH's own loader and
// inspects the result.
//
//   node tools/verify-install.mjs <dsh-home> [profile]
//
// Why this exists. The first working version of the installer wrote its rows as
// plain top-level patch entries. Those parse, typecheck, and satisfy every
// text-level assertion in this repository — but a top-level `- id:` entry in a
// patch ADDRESSES a row of the layer below to override it; it does not declare a
// new one. DSH therefore composed the profile WITHOUT the preset and only said
// `patch: entry "preset-unica-1c" not found` on stderr. The install looked
// successful and the mode never appeared in the GUI.
//
// Only composing the profile the way DSH composes it catches that class of
// mistake, so this tool does exactly that: it calls the harness's own
// `--dump-config` path, which is the documented, boot-free way to see what a
// profile resolves to.
//
// `@deepseek-ai/dsh` lives in the DSH installation rather than in this
// repository, so the harness has to be locatable: DSH_INSTALL_ROOT, a
// `node_modules/.bin` of the harness on PATH, or the Desktop app's own bundle.
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadYaml, yamlWithJsTag } from './lib/yaml.mjs'
import { harnessAsar, harnessRoots, materializeHarness } from './lib/harness.mjs'

const argv = process.argv.slice(2)
const positional = argv.filter((a) => !a.startsWith('--'))
const dshHome = resolve(positional[0] ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'))
const profile = positional[1] ?? 'web'

const harnessNodeModules = harnessRoots()
  .map((root) => join(root, 'node_modules'))
  .find((dir) => existsSync(join(dir, '@deepseek-ai', 'dsh')))

// DSH Desktop keeps the harness inside `app.asar` instead of a `node_modules` on
// disk. Plain Node cannot import from an archive, so the modules the composition
// needs are copied out of the bundle first; after that the code runs unchanged.
const desktopBundle = harnessNodeModules === undefined ? harnessAsar() : undefined
if (harnessNodeModules === undefined && desktopBundle === undefined) {
  throw new Error(
    `cannot locate the DSH installation to verify against. Looked in:\n  ${harnessRoots().join('\n  ') || '(nothing: DSH is not on PATH)'}\n` +
      `and for a bundled Desktop install in the usual places, and found neither.\n` +
      `Pass DSH_INSTALL_ROOT=<directory containing node_modules, or the app.asar, of your DSH install>.`,
  )
}

/** `<root>/node_modules` for a disk install, or the bundle's copy for Desktop. */
function harnessEntry(relative) {
  if (desktopBundle !== undefined) return { fromBundle: true, internal: `dsh/node_modules/@deepseek-ai/${relative}` }
  return { fromBundle: false, path: join(harnessNodeModules, '@deepseek-ai', relative) }
}

let materialized
/** Copies the bundle's composition modules out of the asar, once. */
function materialize() {
  if (materialized === undefined) {
    const dir = join(tmpdir(), `dsh-verify-${process.pid}`)
    materialized = materializeHarness('dsh/node_modules/@deepseek-ai/dsh/lib/dump-config-crgOY3tW.js', dir, desktopBundle)
    console.log(`desktop     : ${desktopBundle.asar}`)
    console.log(`extracted   : ${materialized.packages.length} packages -> ${dirname(materialized.entry)}`)
  }
  return materialized.entry
}

/**
 * Composes the profile and returns the dump as text.
 *
 * The harness writes the dump to stdout itself, and a redirected child process
 * cannot be used for this: under the harness's own file sandbox, a spawned
 * `node` loses stdio. Capturing the one call in-process keeps the check working
 * wherever the installer itself runs.
 *
 * @param defaultOnly - omit the user layer, i.e. show what the bundles alone give
 */
async function dumpConfig(defaultOnly) {
  process.env.DSH_HOME = dshHome
  const source = harnessEntry(join('dsh', 'lib', 'dump-config-crgOY3tW.js'))
  const modulePath = source.fromBundle ? materialize() : source.path
  const { runDumpConfig } = await import(pathToFileURL(modulePath).href)
  const chunks = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }
  try {
    runDumpConfig(profile, defaultOnly, [], undefined)
  } finally {
    process.stdout.write = write
  }
  return chunks.join('')
}

const patchPath = join(dshHome, 'profiles', profile, 'cordis.patch.yml')
console.log(`dsh home    : ${dshHome}`)
console.log(`profile     : ${profile}`)
console.log(`harness     : ${harnessNodeModules ?? '(bundled in the Desktop app)'}`)
console.log(`patch file  : ${patchPath} (${existsSync(patchPath) ? 'present' : 'MISSING'})`)

const yaml = loadYaml([])
const composed = yaml.load(await dumpConfig(false), { schema: yamlWithJsTag(yaml) })
if (!Array.isArray(composed)) throw new Error('the harness returned a composed tree that is not a list of entries')

/** Every entry of the composed tree, groups and preset compositions flattened. */
function flatten(entries, out = []) {
  for (const entry of entries ?? []) {
    out.push(entry)
    // `cordis:group` keeps its children in `config`; a preset declaration keeps
    // its composition in `config.plugins`. Both are rows DSH will mount.
    if (Array.isArray(entry?.config)) flatten(entry.config, out)
    if (Array.isArray(entry?.config?.plugins)) flatten(entry.config.plugins, out)
    if (Array.isArray(entry?.insert)) flatten(entry.insert, out)
  }
  return out
}
const flat = flatten(composed)
const ids = new Set(flat.map((e) => e?.id))
console.log(`composed    : ${composed.length} top-level entries, ${flat.length} rows in total`)

const isPresetProfile = ids.has('agent-preset-registry')
console.log(`profile kind: ${isPresetProfile ? 'preset-based (the agent plane is composed from a preset)' : 'plain (the agent plane comes from the host composition)'}`)

let failed = 0
/** The one check this tool exists for: the installer's rows are in the result. */
function requireRow(id, why) {
  if (ids.has(id)) {
    console.log(`  ok      \`${id}\` is in the composed tree`)
    return flat.find((e) => e?.id === id)
  }
  console.log(`  MISSING \`${id}\` — ${why}`)
  failed += 1
  return undefined
}

// A preset-based profile must carry the preset; a plain one must not (it has no
// registry to register a declaration with, so the installer does not write one).
if (isPresetProfile) {
  const preset = requireRow('preset-unica-1c', 'the preset row was dropped by the patch layer (a top-level `- id:` entry cannot declare a row)')
  if (preset !== undefined) {
    if (preset.name !== '@deepseek-ai/dsh-agent-preset') {
      console.log(`  BROKEN  \`preset-unica-1c\` has name ${preset.name}`)
      failed += 1
    }
    console.log(`  preset  : ${preset.config?.id} / "${preset.config?.name}" / order ${preset.config?.order} / ${preset.config?.plugins?.length ?? 0} rows`)
  }
  // The shipped presets must still be there: a patch that replaced the roster
  // instead of adding to it would pass a naive "is my preset present" check.
  for (const id of ['preset-standard', 'agent-preset-registry']) {
    if (!ids.has(id)) {
      console.log(`  BROKEN  the shipped row \`${id}\` disappeared from the composed tree`)
      failed += 1
    }
  }
}
requireRow('mcp-unica', 'the MCP bridge row is missing from the profile')
requireRow('skill-filesystem-unica', 'the bundled skill root is missing from the profile')

if (failed > 0) {
  console.error(`\n${failed} check(s) failed: the install is not what DSH will boot`)
  process.exitCode = 1
} else {
  console.log('\nDSH composes this profile with every row the installer wrote')
}
