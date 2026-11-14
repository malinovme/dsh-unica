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

// Since 0.13 the manifest describes *artifacts*, not one runtime archive: the
// core server plus the engines Unica borrows (`bsl-analyzer`, `rlm-tools-bsl`,
// `v8-runner`). Unica resolves an engine from the artifact cache, never from its
// own bundle, so the layout below is the whole contract: get it wrong and every
// engine-backed call dies as `bundled_tool_missing`, with a message that points
// at a directory nothing is supposed to exist in.
const artifacts = manifest.artifacts
if (artifacts === null || typeof artifacts !== 'object') {
  die('runtime-manifest.json carries no `artifacts` block: run `node tools/build-runtime-manifest.mjs`')
}

// The cache lives where the profile says (the installer pins it), falling back to
// the DSH home so a hand-run of this script behaves like an installed one.
const cacheRoot =
  process.env.UNICA_RUNTIME_CACHE_DIR && process.env.UNICA_RUNTIME_CACHE_DIR !== ''
    ? resolve(process.env.UNICA_RUNTIME_CACHE_DIR)
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'unica', 'runtimes')
// The server keeps a user daemon; without a writable state root it refuses to
// start, and the default it picks belongs to another host's layout.
process.env.UNICA_PROVIDER_STATE_DIR ??= join(dirname(cacheRoot), 'provider-state')

/** Where one artifact for this target lives, plus its installed marker. */
function artifactAt(name) {
  const artifact = artifacts[name]
  if (artifact === undefined) die(`the runtime manifest has no artifact ${name}`)
  const descriptor = artifact.targets?.[wanted]
  if (descriptor === undefined) die(`artifact ${name} has no entry for ${wanted}`)
  const dir = join(cacheRoot, name, `${artifact.version}--${descriptor.asset.sha256}`, wanted)
  return { artifact, descriptor, dir, marker: join(dir, '.ready.json') }
}

/** Streams a URL to a file, returning its SHA-256. */
async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
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

/**
 * Removes scratch directories a dead launcher left behind. A killed install (DSH
 * restart, Ctrl-C) cannot clean up after itself, and the leftovers are the size of
 * the artifact, so they must not accumulate in the cache.
 */
async function sweepAbandonedScratch(name) {
  const prefix = `.${name}-`
  let entries
  try {
    entries = await readdir(cacheRoot)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    // The asset download carries `<pid>-<asset name>`; the scratch dir `<pid>`.
    const pid = Number.parseInt(entry.slice(prefix.length).split('-')[0], 10)
    if (!Number.isInteger(pid) || pid === process.pid) continue
    let alive = true
    try {
      process.kill(pid, 0)
    } catch (error) {
      alive = error.code === 'EPERM'
    }
    if (alive) continue
    await rm(join(cacheRoot, entry), { recursive: true, force: true }).catch(() => {})
  }
}

/** Unpacks an archive into `dir`, using whichever tool the host actually has. */
function unpack(archivePath, dir, assetName) {
  const lower = assetName.toLowerCase()
  const zip = lower.endsWith('.zip')
  const attempts = zip
    ? process.platform === 'win32'
      // bsdtar ships with Windows 10 1803 and reads zip; unzip may be absent.
      ? [['tar', ['-xf', archivePath, '-C', dir]], ['unzip', ['-q', archivePath, '-d', dir]]]
      : [['unzip', ['-q', archivePath, '-d', dir]], ['tar', ['-xf', archivePath, '-C', dir]]]
    : [['tar', ['-xzf', archivePath, '-C', dir]]]

  const failures = []
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { encoding: 'utf8' })
    if (result.status === 0) return
    const detail = result.error?.message || (result.stderr || '').trim() || 'exit ' + result.status
    failures.push(command + ': ' + detail)
  }
  throw new Error(`cannot unpack ${assetName} (${failures.join('; ')})`)
}

/**
 * Installs one artifact into its cache directory, verifying the asset first.
 * The directory only appears under its final name once it is complete, so a
 * crash leaves a scratch directory behind rather than a cache that looks ready.
 * Throws instead of exiting: engine delivery runs in the background, where a
 * failure must not take the MCP server down.
 */
async function installArtifact(name) {
  const entry = artifactAt(name)
  if (existsSync(entry.marker)) return entry

  const assetPath = join(cacheRoot, `.${name}-${process.pid}-${entry.descriptor.asset.name}`)
  const scratch = join(cacheRoot, `.${name}-${process.pid}`)
  await mkdir(cacheRoot, { recursive: true })
  await sweepAbandonedScratch(name)
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })

  console.error(`unica launcher: fetching ${name} ${entry.artifact.version} for ${wanted}`)
  let digest
  try {
    digest = await download(entry.descriptor.asset.url, assetPath)
  } catch (error) {
    await rm(scratch, { recursive: true, force: true })
    await rm(assetPath, { force: true })
    throw new Error(`cannot download ${entry.descriptor.asset.url}: ${error.message}. First start needs network; a proxy or a blocked host shows up here.`)
  }
  if (digest !== entry.descriptor.asset.sha256) {
    await rm(scratch, { recursive: true, force: true })
    await rm(assetPath, { force: true })
    throw new Error(`artifact ${name} checksum mismatch: manifest says ${entry.descriptor.asset.sha256}, got ${digest}`)
  }

  const install = entry.descriptor.install ?? { strategy: 'archive' }
  if (install.strategy === 'file') {
    const destination = join(scratch, install.as ?? entry.descriptor.asset.name)
    await mkdir(dirname(destination), { recursive: true })
    await rename(assetPath, destination)
    await chmod(destination, 0o755).catch(() => {})
  } else {
    try {
      unpack(assetPath, scratch, entry.descriptor.asset.name)
    } catch (error) {
      await rm(scratch, { recursive: true, force: true })
      await rm(assetPath, { force: true })
      throw error
    }
    await rm(assetPath, { force: true })
  }

  for (const file of entry.descriptor.files ?? []) {
    const path = join(scratch, file.path)
    if (!existsSync(path)) {
      await rm(scratch, { recursive: true, force: true })
      throw new Error(`artifact ${name} is missing ${file.path}`)
    }
    if (file.sha256 !== undefined && (await hashFile(path)) !== file.sha256) {
      await rm(scratch, { recursive: true, force: true })
      throw new Error(`artifact ${name} file checksum mismatch for ${file.path}`)
    }
    // tar preserves the executable bit, but an archive built on Windows may not.
    if (file.executable === true) await chmod(path, 0o755).catch(() => {})
  }

  await writeFile(
    join(scratch, '.ready.json'),
    `${JSON.stringify({ artifact: name, version: entry.artifact.version, target: wanted, assetSha256: entry.descriptor.asset.sha256 }, null, 2)}\n`,
    'utf8',
  )
  // Another process may have published the same artifact while this one was
  // downloading. Its copy is just as verified, and replacing a directory a live
  // server is running from is worse than keeping it, so defer to it.
  if (existsSync(entry.marker)) {
    await rm(scratch, { recursive: true, force: true })
    return entry
  }
  // The rename is what makes the cache appear ready only once it *is* ready.
  await rm(entry.dir, { recursive: true, force: true })
  await mkdir(dirname(entry.dir), { recursive: true })
  try {
    await rename(scratch, entry.dir)
  } catch (error) {
    await rm(scratch, { recursive: true, force: true })
    if (!existsSync(entry.marker)) throw error
  }
  return entry
}

/** Engines the runtime expects but this cache does not have yet, cheapest first. */
function missingEngines() {
  const order = ['v8-runner', 'bsl-analyzer', 'rlm-tools-bsl']
  return Object.keys(artifacts)
    .filter((name) => name !== 'unica' && !existsSync(artifactAt(name).marker))
    .sort((left, right) => order.indexOf(left) - order.indexOf(right))
}

async function deliverEngines(names) {
  for (const name of names) {
    try {
      await installArtifact(name)
      console.error(`unica launcher: ${name} delivered`)
    } catch (error) {
      // A missing engine degrades one capability, it does not stop the server:
      // every engine-backed call answers `provider_unavailable` on its own.
      console.error(`unica launcher: ${name} delivery failed: ${error.message}`)
    }
  }
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

let command
let commandArgs = []
if (selfTesting) {
  // A self-test replaces the runtime entirely, so it must neither resolve nor
  // download one: tools/verify-bridge.mjs points this at a fake server.
  command = selfTest[0]
  commandArgs = selfTest.slice(1)
} else {
  const coreEntry = await installArtifact('unica').catch((error) => die(error.message))
  command = join(coreEntry.dir, coreEntry.descriptor.entrypoint)
  if (!existsSync(command)) die(`the installed runtime is missing ${command}`)

  // `off` keeps the cache untouched, `eager` blocks the handover until every engine
  // is in place, and the default starts the server at once and delivers behind it:
  // engines appear on the next call that needs them, and a call that needs one
  // before it lands answers `bundled_tool_missing`, exactly as without them.
  const delivery = process.env.UNICA_ARTIFACT_DELIVERY ?? 'background'
  const pending = delivery === 'off' ? [] : missingEngines()
  if (delivery === 'eager' && pending.length > 0) await deliverEngines(pending)
  else if (delivery === 'background' && pending.length > 0) void deliverEngines(pending)
}

// The runtime finds its engines through this cache root, not through its own
// directory: without the variable every engine-backed call fails as if the engine
// were missing even when it is installed right next door.
const childEnv = { ...process.env, UNICA_ARTIFACT_CACHE: cacheRoot }

const child = spawn(command, commandArgs, { stdio: TEXT_FALLBACK ? ['pipe', 'pipe', 'inherit'] : 'inherit', env: childEnv })
if (TEXT_FALLBACK) relay(child)
child.on('error', (error) => die(`cannot start ${command}: ${error.message}`))
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
