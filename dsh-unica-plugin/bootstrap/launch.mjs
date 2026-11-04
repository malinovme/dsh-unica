#!/usr/bin/env node
// Launches the unica MCP server for DSH, fetching the runtime on first use.
//
//   node launch.mjs <plugin-root>
//
// Upstream 0.13 stopped shipping a per-platform bootstrap binary in the plugin
// package; it publishes a runtime archive per target instead, described by a
// small JSON descriptor (`runtime-manifest.json`). This script is the port's
// replacement for that bootstrap, and it stays in Node so the port carries no
// prebuilt binaries of its own — which is also what removes the licensing weight
// the old `bootstrap/bin/` directory carried.
//
// What it has to do, in this order, because a half-written cache is worse than an
// empty one:
//
//   1. resolve the target from the running platform, and the descriptor for it;
//   2. if the cache already holds a ready runtime, exec it and touch nothing;
//   3. otherwise download the archive, hash it while streaming, compare with the
//      descriptor, unpack into a scratch directory, hash every file the
//      descriptor lists, and only then rename the directory into place;
//   4. write the readiness marker and hand over to the server with inherited
//      stdio, so DSH speaks MCP to it directly.
//
// A crash during step 3 leaves the scratch directory behind, never a cache that
// looks ready. That is the whole reason for the rename.
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url))))

function die(message) {
  console.error(`unica launcher: ${message}`)
  process.exit(1)
}

/** The upstream target this machine needs, or a message naming what is unsupported. */
function target() {
  const platform = process.platform
  const arch = process.arch
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  die(
    `no unica runtime for ${platform}/${arch}. Unica publishes ` +
      `win-x64, darwin-arm64 and linux-x64; Intel Macs and 32-bit hosts are not covered.`,
  )
}

const manifestPath = join(PLUGIN_ROOT, 'runtime-manifest.json')
if (!existsSync(manifestPath)) die(`no runtime manifest at ${manifestPath}`)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const wanted = target()
const descriptor = manifest.targets?.[wanted]
if (descriptor === undefined) die(`the runtime manifest has no entry for ${wanted}`)

// The cache lives where the profile says (the installer pins it), falling back to
// the DSH home so a hand-run of this script behaves like an installed one.
const cacheRoot =
  process.env.UNICA_RUNTIME_CACHE_DIR && process.env.UNICA_RUNTIME_CACHE_DIR !== ''
    ? resolve(process.env.UNICA_RUNTIME_CACHE_DIR)
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'unica', 'runtimes')
// The server keeps a user daemon; without a writable state root it refuses to
// start, and the default it picks belongs to another host's layout.
process.env.UNICA_PROVIDER_STATE_DIR ??= join(dirname(cacheRoot), 'provider-state')

const versionDir = join(cacheRoot, manifest.pluginVersion, wanted)
const marker = join(versionDir, '.ready.json')
const entrypoint = join(versionDir, descriptor.entrypoint)

/** Streams a URL to a file, returning its SHA-256. */
async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || response.body === null) die(`cannot download ${url}: HTTP ${response.status}`)
  const hash = createHash('sha256')
  await pipeline(Readable.fromWeb(response.body), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk)
      yield chunk
    }
  }, createWriteStream(destination))
  return hash.digest('hex')
}

/** The SHA-256 of a file on disk. */
async function hashFile(path) {
  const hash = createHash('sha256')
  const { createReadStream } = await import('node:fs')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function ensureRuntime() {
  if (existsSync(marker) && existsSync(entrypoint)) return entrypoint

  // Both paths carry the pid. Several servers can start at once — DSH restarts
  // are exactly that moment — and a shared archive name had them writing the same
  // file, so one process unlinked the bytes another was still hashing or unpacking
  // and a healthy install died with a checksum or tar error.
  const archive = join(cacheRoot, `.unica-${wanted}-${process.pid}.tar.gz`)
  const scratch = join(cacheRoot, `.unica-${wanted}-${process.pid}`)
  await mkdir(cacheRoot, { recursive: true })
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })

  console.error(`unica launcher: fetching ${manifest.pluginVersion} runtime for ${wanted} (first run)`)
  let digest
  try {
    digest = await download(descriptor.url, archive)
  } catch (error) {
    await rm(scratch, { recursive: true, force: true })
    await rm(archive, { force: true })
    die(`cannot download ${descriptor.url}: ${error.message}. The first start needs network; a proxy or a blocked host shows up here.`)
  }
  if (digest !== descriptor.sha256) {
    await rm(scratch, { recursive: true, force: true })
    await rm(archive, { force: true })
    die(`runtime archive checksum mismatch: descriptor says ${descriptor.sha256}, got ${digest}`)
  }

  // tar ships with Windows 10 1803 and every POSIX host the port supports.
  const unpacked = spawnSync('tar', ['-xzf', archive, '-C', scratch], { encoding: 'utf8' })
  if (unpacked.status !== 0) {
    await rm(scratch, { recursive: true, force: true })
    die(`cannot unpack the runtime archive: ${unpacked.stderr || unpacked.status}`)
  }
  await rm(archive, { force: true })

  for (const file of descriptor.files ?? []) {
    const path = join(scratch, file.path)
    if (!existsSync(path)) die(`the runtime archive is missing ${file.path}`)
    const actual = await hashFile(path)
    if (file.sha256 !== undefined && actual !== file.sha256) {
      await rm(scratch, { recursive: true, force: true })
      die(`runtime file checksum mismatch for ${file.path}`)
    }
    // tar preserves the executable bit, but an archive built on Windows may not.
    if (file.executable === true) await chmod(path, 0o755).catch(() => {})
  }

  await writeFile(
    join(scratch, '.ready.json'),
    `${JSON.stringify({ pluginVersion: manifest.pluginVersion, target: wanted, sha256: descriptor.sha256 }, null, 2)}\n`,
    'utf8',
  )
  // Another process may have published the same runtime while this one was
  // downloading. Its copy is just as verified, and replacing a directory a live
  // server is running from is worse than keeping it, so defer to it.
  if (existsSync(marker) && existsSync(entrypoint)) {
    await rm(scratch, { recursive: true, force: true })
    return entrypoint
  }
  // The rename is what makes the cache appear ready only once it *is* ready.
  await rm(versionDir, { recursive: true, force: true })
  await mkdir(dirname(versionDir), { recursive: true })
  await rename(scratch, versionDir)
  return entrypoint
}

const executable = await ensureRuntime()
if (!existsSync(executable)) die(`the runtime entrypoint is missing after install: ${executable}`)

const child = spawn(executable, [], { stdio: 'inherit' })
child.on('error', (error) => die(`cannot start ${executable}: ${error.message}`))
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
