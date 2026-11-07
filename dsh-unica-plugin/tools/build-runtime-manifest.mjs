#!/usr/bin/env node
// Builds `runtime-manifest.json` from the checked-in tool lock and the current
// core-runtime descriptor.
//
//   node tools/build-runtime-manifest.mjs            # rewrite the manifest
//   node tools/build-runtime-manifest.mjs --check    # fail if it is stale
//
// Why this exists: Unica 0.13 resolves its engines through the artifact cache —
// `<cache>/<artifact>/<version>--<asset sha256>/<target>/` — and the launcher has
// to know what to fetch there. The checked-in lock (`third-party/tools.lock.json`)
// already pins every artifact asset per target with a SHA-256, so the descriptor
// is derivable and must not drift by hand.
//
// The layout knowledge below is upstream's, not the port's invention: the runtime
// looks for each engine at the path its own bundled `third-party/manifest.json`
// calls `deliveredPath`. `bsl-analyzer` ships as a bare executable, the other two
// as archives that unpack in place.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const manifestPath = join(pluginRoot, 'runtime-manifest.json')
const lockPath = join(pluginRoot, 'third-party', 'tools.lock.json')

const checkOnly = process.argv.includes('--check')

/**
 * How each artifact lands in its cache directory.
 * `strategy: 'archive'` unpacks the asset in place and keeps the archive layout;
 * `strategy: 'file'` stores the single asset under `as`.
 */
const LAYOUT = {
  'bsl-analyzer': { strategy: 'file', as: (target) => `bsl-analyzer${EXE[target]}`, entrypoint: (target) => `bsl-analyzer${EXE[target]}` },
  'rlm-tools-bsl': { strategy: 'archive', entrypoint: (target) => `payload/rlm-bsl-mcp${EXE[target]}` },
  // Only v8-runner's lock row records the in-archive binary path, and only its
  // path differs per target (`v8-runner-macos-aarch64/…`, `…-windows-x86_64/…`).
  // The rlm row's `archiveBinary` omits its `payload/` prefix, so it is not used.
  'v8-runner': { strategy: 'archive', entrypoint: (target, asset) => asset.archiveBinary ?? `v8-runner-windows-x86_64/v8-runner${EXE[target]}` },
}

const EXE = { 'win-x64': '.exe', 'darwin-arm64': '', 'linux-x64': '' }

/** Media type the launcher unpacks by, or `null` for a bare file. */
function mediaTypeFor(assetName) {
  if (assetName.endsWith('.tar.gz')) return 'application/gzip'
  if (assetName.endsWith('.zip')) return 'application/zip'
  return 'application/octet-stream'
}

const lock = JSON.parse(await readFile(lockPath, 'utf8'))
const previous = JSON.parse(await readFile(manifestPath, 'utf8'))

/**
 * The core descriptor in the pre-artifact shape, whichever shape the manifest is
 * in now: the generator must accept its own output, or a second run would have
 * nothing to convert.
 */
function coreTargets(source) {
  if (source.targets !== undefined) return source.targets
  const core = source.artifacts?.unica?.targets ?? {}
  return Object.fromEntries(
    Object.entries(core).map(([target, entry]) => [
      target,
      { url: entry.asset.url, sha256: entry.asset.sha256, entrypoint: entry.entrypoint, files: entry.files ?? [] },
    ]),
  )
}

const coreDescriptor = coreTargets(previous)
if (Object.keys(coreDescriptor).length === 0) {
  throw new Error('runtime-manifest.json carries no core descriptor; restore it from the release page first')
}

const targets = Object.keys(lock.targets ?? {})
if (targets.length === 0) throw new Error('tools.lock.json lists no targets')

/** One artifact descriptor: version, role, and one entry per target. */
const artifacts = {}

// The core runtime is not in the lock: the lock's `unica` row is a cargo source
// row with no published asset. The port's own release descriptor is the source of
// truth for it, so the manifest keeps that data and only reshapes it.
artifacts.unica = {
  version: previous.pluginVersion,
  role: 'core',
  targets: {},
}
for (const target of targets) {
  const descriptor = coreDescriptor[target]
  if (descriptor === undefined) continue
  artifacts.unica.targets[target] = {
    asset: {
      mediaType: mediaTypeFor(descriptor.url),
      name: descriptor.url.slice(descriptor.url.lastIndexOf('/') + 1),
      sha256: descriptor.sha256,
      url: descriptor.url,
    },
    install: { strategy: 'archive' },
    entrypoint: descriptor.entrypoint,
    files: descriptor.files ?? [],
  }
}

// `rlm-bsl-mcp` and `rlm-bsl-index` are two binaries of one archive; the runtime
// treats them as a single artifact, so the lock's second row must not become a
// second download.
const SKIP = new Set(['unica', 'rlm-bsl-index'])

for (const tool of lock.tools ?? []) {
  if (SKIP.has(tool.name)) continue
  const artifactName = tool.name === 'rlm-bsl-mcp' ? 'rlm-tools-bsl' : tool.name
  const layout = LAYOUT[artifactName]
  if (layout === undefined) throw new Error(`no layout rule for tool ${tool.name}; add one before publishing`)

  const artifact = { version: tool.version, role: 'engine', targets: {} }
  for (const target of targets) {
    const asset = tool.assets?.[target]
    if (asset === undefined) continue
    const assetName = asset.assetName
    if (asset.sha256 === undefined) throw new Error(`${tool.name}/${target} has no asset sha256 in the lock`)
    artifact.targets[target] = {
      asset: {
        mediaType: mediaTypeFor(assetName),
        name: assetName,
        sha256: asset.sha256,
        url: `${tool.assetRepository}/releases/download/${tool.assetTag}/${assetName}`,
      },
      install: layout.strategy === 'file' ? { strategy: 'file', as: layout.as(target) } : { strategy: 'archive' },
      entrypoint: layout.entrypoint(target, asset),
    }
  }
  if (Object.keys(artifact.targets).length === 0) continue
  artifacts[artifactName] = artifact
}

// Keep the core first: the launcher installs it before anything else, and a
// stable order keeps the diff readable.
const ordered = { unica: artifacts.unica }
for (const name of Object.keys(artifacts).sort()) if (name !== 'unica') ordered[name] = artifacts[name]

const manifest = {
  schemaVersion: 2,
  pluginVersion: previous.pluginVersion,
  ...(previous.upstream === undefined ? {} : { upstream: previous.upstream }),
  ...(previous.tag === undefined ? {} : { tag: previous.tag }),
  artifacts: ordered,
}

const rendered = `${JSON.stringify(manifest, null, 2)}\n`
const current = await readFile(manifestPath, 'utf8')

if (checkOnly) {
  if (current !== rendered) {
    console.error('runtime-manifest.json is stale: run `node tools/build-runtime-manifest.mjs`')
    process.exit(1)
  }
  console.log('runtime-manifest.json matches the tool lock')
} else {
  await writeFile(manifestPath, rendered, 'utf8')
  const counts = Object.entries(manifest.artifacts).map(([name, artifact]) => `${name}(${Object.keys(artifact.targets).length})`)
  console.log(`runtime-manifest.json rewritten: ${counts.join(' ')}`)
}
