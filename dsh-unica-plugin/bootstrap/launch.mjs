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

// ---------------------------------------------------------------------------
// Model-visible text fallback
//
// Unica 0.13 answers a *successful* tools/call with `content: []` and the whole
// payload in `structuredContent`; only failures ship a text content block (the
// serialized envelope), which is why errors were visible and successes were not.
// DSH's MCP bridge projects nothing but `content` blocks, so the model received
// `(unica.view returned no model-visible content)` and never saw what a call
// actually produced: `executionToken`, the node's `can` operation dictionary,
// the `next` navigation hints, `taskId` of a task-based call, `view`/`check`/
// `search`/`diff` results.
//
// The relay below copies an otherwise-invisible structured payload into one text
// block and leaves `structuredContent` untouched, so a client that reads the
// structured form keeps working and a client that reads text stops being blind.
// It is a transport-level repair of the surface contract, not a change of it:
// nothing is invented, dropped, or reordered, and a result that already carries
// text is passed through byte for byte.
//
// UNICA_BRIDGE_TEXT_FALLBACK=0 turns the relay off (raw stdio, the pre-fix
// behaviour). UNICA_LAUNCH_SELFTEST_COMMAND is a test-only hook: a JSON argv that
// replaces the runtime entrypoint so tools/verify-bridge.mjs can exercise the
// relay without the real server.
// ---------------------------------------------------------------------------
const TEXT_FALLBACK = process.env.UNICA_BRIDGE_TEXT_FALLBACK !== '0'
const NEWLINE = Buffer.from('\n', 'utf8')

/**
 * Rewrite one JSON-RPC message so a structured-only success becomes visible.
 * Returns the replacement message, or null when the line must pass unchanged.
 */
function withTextFallback(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return null
  const result = message.result
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null
  const content = result.content
  if (Array.isArray(content) && content.length > 0) return null
  const structured = result.structuredContent
  if (structured === undefined || structured === null) return null
  const text = typeof structured === 'string' ? structured : JSON.stringify(structured, null, 2)
  return { ...message, result: { ...result, content: [{ type: 'text', text }] } }
}

/** One incoming server line: parse, maybe rewrite, always answer with bytes. */
function forwardLine(line) {
  const asText = line.toString('utf8')
  if (!TEXT_FALLBACK || !asText.trimStart().startsWith('{')) return Buffer.concat([line, NEWLINE])
  let message
  try {
    message = JSON.parse(asText)
  } catch {
    return Buffer.concat([line, NEWLINE])
  }
  const rewritten = withTextFallback(message)
  if (rewritten === null) return Buffer.concat([line, NEWLINE])
  return Buffer.from(`${JSON.stringify(rewritten)}\n`, 'utf8')
}

/** Wire the client's stdio to the server's, rewriting responses on the way back. */
function relay(child) {
  process.stdin.on('error', () => {})
  process.stdin.pipe(child.stdin)
  child.stdin.on('error', () => {})
  child.stdout.on('error', () => {})

  // MCP frames are newline-delimited JSON, but a frame can be split across
  // chunks or arrive several per chunk, so lines are assembled by hand.
  let pending = Buffer.alloc(0)
  child.stdout.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    for (;;) {
      const newline = pending.indexOf(0x0a)
      if (newline === -1) break
      const line = pending.subarray(0, newline)
      pending = pending.subarray(newline + 1)
      process.stdout.write(forwardLine(line))
    }
  })
  child.stdout.on('end', () => {
    if (pending.length > 0) process.stdout.write(forwardLine(pending))
    pending = Buffer.alloc(0)
  })
}

// Unica takes its workspace from the directory it was started in, and nothing on
// its surface names another one. That makes the project depend on the parent's
// cwd — which is not stable across a reconnect: DSH restarts a dropped server
// from the profile directory, and the server then answers about
// $DSH_HOME/profiles/desktop instead of the session's project. Pinning the root
// here keeps a restart from silently moving the workspace.
const workspaceRoot = process.env.UNICA_WORKSPACE_ROOT
if (workspaceRoot !== undefined && workspaceRoot.trim() !== '') {
  const resolvedRoot = resolve(workspaceRoot)
  if (!existsSync(resolvedRoot)) die(`UNICA_WORKSPACE_ROOT points at a missing directory: ${resolvedRoot}`)
  process.chdir(resolvedRoot)
  console.error(`unica launcher: workspace root pinned to ${resolvedRoot}`)
}

const selfTestArgv = process.env.UNICA_LAUNCH_SELFTEST_COMMAND
const selfTest = selfTestArgv === undefined || selfTestArgv === '' ? null : JSON.parse(selfTestArgv)
const selfTesting = Array.isArray(selfTest) && selfTest.length > 0

// A self-test replaces the runtime entirely, so it must not resolve or download
// one: tools/verify-bridge.mjs points this at a fake server.
const executable = selfTesting ? selfTest[0] : await ensureRuntime()
if (!selfTesting && !existsSync(executable)) die(`the runtime entrypoint is missing after install: ${executable}`)

const command = selfTesting ? selfTest[0] : executable
const commandArgs = selfTesting ? selfTest.slice(1) : []

const child = spawn(command, commandArgs, { stdio: TEXT_FALLBACK ? ['pipe', 'pipe', 'inherit'] : 'inherit' })
if (TEXT_FALLBACK) relay(child)
child.on('error', (error) => die(`cannot start ${executable}: ${error.message}`))
child.on('exit', (code, signal) => {
  if (signal !== null) return process.kill(process.pid, signal)
  // Drain the last rewritten lines before leaving: a piped stdout is flushed
  // asynchronously, and a bare exit() here would truncate the final response.
  const finish = () => process.exit(code ?? 1)
  const timer = setTimeout(finish, 1000)
  timer.unref?.()
  process.stdout.write('', () => {
    clearTimeout(timer)
    finish()
  })
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
