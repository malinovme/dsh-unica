#!/usr/bin/env node
// The end-to-end gate: composes the installed profile with DSH's own loader and
// inspects the result.
//
//   node tools/verify-install.mjs <dsh-home> [profile] [preset|profile]
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
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadYaml, yamlWithJsTag } from './lib/yaml.mjs'
import { asarDirectoryFiles, harnessAsar, harnessRoots, materializeHarness } from './lib/harness.mjs'

const argv = process.argv.slice(2)
const positional = argv.filter((a) => !a.startsWith('--'))
const dshHome = resolve(positional[0] ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'))
const profile = positional[1] ?? 'web'
const expectedKind = positional[2] ?? (['web', 'desktop'].includes(profile) ? 'preset' : undefined)
if (expectedKind !== undefined && !['preset', 'profile'].includes(expectedKind)) {
  throw new Error('expected installation kind must be preset or profile')
}

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

/**
 * Chunk file names of the dump-config entry point.
 *
 * DSH names these `dump-config-<hash>.js`, and the hash changes between builds,
 * so the name is discovered instead of pinned: a stale literal made this tool
 * fail on every DSH release after the one it was written against.
 */
function dumpConfigChunks() {
  const isCandidate = (name) => /^dump-config-[^/]+\.js$/.test(name) && !name.startsWith('dump-config-schema-')
  if (desktopBundle !== undefined) {
    return asarDirectoryFiles('dsh/node_modules/@deepseek-ai/dsh/lib', desktopBundle).filter(isCandidate)
  }
  const dir = join(harnessNodeModules, '@deepseek-ai', 'dsh', 'lib')
  return existsSync(dir) ? readdirSync(dir).filter(isCandidate) : []
}

let materialized
/** Copies the bundle's composition modules out of the asar, once. */
function materialize() {
  if (materialized === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
    const candidates = dumpConfigChunks()
    if (candidates.length === 0) throw new Error('the DSH installation carries no dump-config entry point')
    materialized = materializeHarness(`dsh/node_modules/@deepseek-ai/dsh/lib/${candidates[0]}`, dir, desktopBundle, { profileBundles: true })
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
  const modulePath = desktopBundle !== undefined ? materialize() : harnessEntry('dsh/lib').path
  const candidates =
    desktopBundle !== undefined
      ? dumpConfigChunks().map((name) => join(dirname(modulePath), name))
      : dumpConfigChunks().map((name) => join(modulePath, name))
  let runDumpConfig
  for (const candidate of candidates) {
    try {
      const loaded = await import(pathToFileURL(candidate).href)
      if (typeof loaded.runDumpConfig === 'function') {
        runDumpConfig = loaded.runDumpConfig
        break
      }
    } catch {
      /* a sibling chunk that is not the entry point */
    }
  }
  if (runDumpConfig === undefined) throw new Error('no dump-config chunk exports runDumpConfig')
  const chunks = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }
  try {
    await runDumpConfig(profile, defaultOnly, [], undefined)
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

// A group mounts its children in the same plane. Each preset owns a separate
// composition, so a row inside another preset cannot satisfy a missing host row.
function groupRows(entries) {
  const rows = []
  for (const entry of entries) {
    rows.push(entry)
    if (Array.isArray(entry?.config)) rows.push(...groupRows(entry.config))
  }
  return rows
}

const host = groupRows(composed)
const presetBased = expectedKind === 'preset' ||
  (expectedKind === undefined && host.some((row) => row.id === 'agent-preset-registry'))
console.log(`checking    : ${presetBased ? 'preset' : 'host'} rows in ${profile}`)
function requireRow(rows, id) {
  const row = rows.find((row) => row.id === id)
  if (!row) throw new Error(`missing ${id} in the expected composition for ${profile}`)
  console.log(`  ok      ${id}`)
  return row
}

let tools = host
if (presetBased) {
  requireRow(host, 'agent-preset-registry')
  requireRow(host, 'preset-standard')
  const preset = requireRow(host, 'preset-unica-1c')
  if (preset.name !== '@deepseek-ai/dsh-agent-preset' || preset.config?.id !== 'unica-1c' ||
      !Array.isArray(preset.config?.plugins)) {
    throw new Error('invalid preset-unica-1c declaration')
  }
  tools = groupRows(preset.config.plugins)
}
requireRow(tools, 'unica-native')
requireRow(tools, 'skill-filesystem-unica')
console.log('\nDSH composes this profile with every required row')
