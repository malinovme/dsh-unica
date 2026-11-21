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
import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, createWriteStream, existsSync, statSync } from 'node:fs'
import { access, chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const PLUGIN_ROOT = resolve(process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url))))

// The Windows native host closes IPC to stop this launcher and its direct MCP
// server. TerminateProcess on the launcher alone would leave the server behind.
let child
let unpacking
let shutdownTimer

function forwardSignal(signal) {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(signal)
    // Reap our direct server before UnicaProc's 2 s launcher deadline.
    // Its shared daemon may still be serving other sessions.
    if (process.platform !== 'win32' && !shutdownTimer) {
      shutdownTimer = setTimeout(() => child.kill('SIGKILL'), 1000).unref()
    }
  } else {
    unpacking?.kill(signal)
    process.exit(0)
  }
}

if (process.connected) process.once('disconnect', () => forwardSignal('SIGTERM'))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, forwardSignal)

function notifyHost(message) {
  if (process.connected) process.send(message, () => {})
}

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
// core server plus the engines Unica borrows (`bsl-analyzer` and `v8-runner`).
// Unica resolves an engine from the artifact cache, never from its
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
  return { name, artifact, descriptor, dir, marker: join(dir, '.ready.json') }
}

// Presence checks are cheap on a warm start. Hashes are checked during delivery.
function payloadPresent(entry) {
  return existsSync(entry.marker) && [entry.descriptor.entrypoint, ...(entry.descriptor.files ?? []).map(f => f.path)]
    .filter(Boolean).every(path => statSync(join(entry.dir, path), { throwIfNoEntry: false })?.isFile())
}

function canExecute(path) {
  if (process.platform === 'win32') return true
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function ready(entry) {
  // The core has its own permission check immediately before startup.
  if (!payloadPresent(entry)) return false
  if (entry.name === 'unica' || !entry.descriptor.entrypoint) return true
  return canExecute(join(entry.dir, entry.descriptor.entrypoint))
}

// Repair in place. A hard link publishes a complete verified file atomically
// and fails if another launcher got there first. Never unlink a live payload.
async function repairArtifact(scratch, entry) {
  const last = new Set([entry.descriptor.entrypoint, '.ready.json'].filter(Boolean).map(path => join(path)))
  async function publish(path) {
    const src = join(scratch, path)
    const dst = join(entry.dir, path)
    try {
      await link(src, dst)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!(await lstat(dst)).isFile()) throw new Error(`expected a cached file at ${dst}`)
      // Old ready markers can have different formatting. All payload files
      // encountered during repair must agree with the verified download.
      if (path !== '.ready.json' && await hashFile(src) !== await hashFile(dst)) {
        throw new Error(`existing cache file differs from the verified download: ${dst}`)
      }
    }
  }
  async function visit(relative) {
    const directory = join(entry.dir, relative)
    if (!(await lstat(directory)).isDirectory()) throw new Error(`expected a cache directory at ${directory}`)
    for (const file of await readdir(join(scratch, relative), { withFileTypes: true })) {
      const path = join(relative, file.name)
      if (file.isDirectory()) {
        await mkdir(join(entry.dir, path), { recursive: true })
        await visit(path)
      } else if (!last.has(path)) {
        await publish(path)
      }
    }
  }
  await visit('')
  for (const path of last) await publish(path)
}

const TRANSIENT_NETWORK_CODES = new Set([
  'EAI_AGAIN', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
])

function networkFailure(error) {
  return Object.assign(new Error(error.message, { cause: error }), {
    transient: error.name === 'TimeoutError' || TRANSIENT_NETWORK_CODES.has(error.cause?.code ?? error.code),
  })
}

/** Streams a URL to a file, returning its SHA-256. */
async function download(url, destination, signal) {
  let response
  try {
    response = await fetch(url, { redirect: 'follow', signal })
  } catch (error) {
    throw networkFailure(error)
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw Object.assign(new Error(`HTTP ${response.status}`), {
      transient: response.status === 408 || response.status === 429 || response.status >= 500,
    })
  }
  const hash = createHash('sha256')
  await pipeline(Readable.fromWeb(response.body), async function* (source) {
    try {
      for await (const chunk of source) {
        hash.update(chunk)
        yield chunk
      }
    } catch (error) {
      throw networkFailure(error)
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

// A restored or copied cache can lose its Unix execute bits. Only grant the
// owner execute permission after verifying the same open file we will chmod.
async function restoreExecutePermission(path, expected, name) {
  if (!expected) throw new Error(`cannot verify executable permission repair for ${path}`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`expected a cached executable file at ${path}`)
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
    if (hash.digest('hex') !== expected) throw new Error(`cached ${name} checksum mismatch: ${path}`)
    await handle.chmod((info.mode & 0o777) | 0o100)
    await access(path, constants.X_OK)
  } finally {
    await handle.close()
  }
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
async function unpack(archivePath, dir, assetName) {
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
    try {
      await new Promise((resolve, reject) => {
        unpacking = execFile(command, args, (error, _stdout, stderr) => {
          unpacking = undefined
          if (error) reject(new Error(stderr.trim() || error.message, { cause: error }))
          else resolve()
        })
      })
      return
    } catch (error) {
      failures.push(command + ': ' + error.message)
    }
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
  if (ready(entry)) return entry
  const install = entry.descriptor.install ?? { strategy: 'archive' }
  if (install.strategy === 'file' && payloadPresent(entry)) {
    await restoreExecutePermission(join(entry.dir, entry.descriptor.entrypoint), entry.descriptor.asset.sha256, name)
    return entry
  }

  const assetPath = join(cacheRoot, `.${name}-${process.pid}-${entry.descriptor.asset.name}`)
  const scratch = join(cacheRoot, `.${name}-${process.pid}`)
  await mkdir(cacheRoot, { recursive: true })
  await sweepAbandonedScratch(name)
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })

  console.error(`unica launcher: fetching ${name} ${entry.artifact.version} for ${wanted}`)
  let digest
  try {
    const signal = name === 'unica' ? undefined : AbortSignal.timeout(120_000)
    digest = await download(entry.descriptor.asset.url, assetPath, signal)
  } catch (error) {
    await rm(scratch, { recursive: true, force: true })
    await rm(assetPath, { force: true })
    const message = `cannot download ${entry.descriptor.asset.url}: ${error.message}. First start needs network; a proxy or a blocked host shows up here.`
    throw Object.assign(new Error(message, { cause: error }), { transient: error.transient === true })
  }
  if (digest !== entry.descriptor.asset.sha256) {
    await rm(scratch, { recursive: true, force: true })
    await rm(assetPath, { force: true })
    throw new Error(`artifact ${name} checksum mismatch: manifest says ${entry.descriptor.asset.sha256}, got ${digest}`)
  }

  if (install.strategy === 'file') {
    const destination = join(scratch, install.as ?? entry.descriptor.asset.name)
    await mkdir(dirname(destination), { recursive: true })
    await rename(assetPath, destination)
    await chmod(destination, 0o755).catch(() => {})
  } else {
    try {
      await unpack(assetPath, scratch, entry.descriptor.asset.name)
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

  // A verified archive can itself lack Unix execute bits. Fix the staged
  // engine before another launcher sees the ready marker.
  if (name !== 'unica' && entry.descriptor.entrypoint && process.platform !== 'win32') {
    const executable = join(scratch, entry.descriptor.entrypoint)
    if (!canExecute(executable)) {
      try {
        const info = await lstat(executable)
        if (!info.isFile()) throw new Error(`expected an executable file in the verified archive at ${executable}`)
        await chmod(executable, (info.mode & 0o777) | 0o100)
        await access(executable, constants.X_OK)
      } catch (error) {
        await rm(scratch, { recursive: true, force: true })
        throw error
      }
    }
  }

  await writeFile(
    join(scratch, '.ready.json'),
    `${JSON.stringify({ artifact: name, version: entry.artifact.version, target: wanted, assetSha256: entry.descriptor.asset.sha256 }, null, 2)}\n`,
    'utf8',
  )
  // A published directory is nonempty (it contains the marker). rename cannot
  // replace it: the first publisher wins, and other launchers reuse its copy.
  // Never remove the destination here; it can already be serving another cwd.
  await mkdir(dirname(entry.dir), { recursive: true })
  try {
    await rename(scratch, entry.dir)
  } catch (error) {
    try {
      if (!ready(entry)) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code) || !existsSync(entry.dir)) throw error
        if (!payloadPresent(entry)) await repairArtifact(scratch, entry)
        const entrypoint = entry.descriptor.entrypoint
        if (name !== 'unica' && entrypoint && !canExecute(join(entry.dir, entrypoint))) {
          // The manifest pins the archive. Its verified entrypoint supplies
          // the digest for restoring the existing file's execute permission.
          await restoreExecutePermission(join(entry.dir, entrypoint), await hashFile(join(scratch, entrypoint)), name)
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  return entry
}

/** Engines the runtime expects but this cache does not have yet, cheapest first. */
function missingEngines() {
  const order = ['v8-runner', 'bsl-analyzer']
  return Object.keys(artifacts)
    .filter((name) => name !== 'unica' && !ready(artifactAt(name)))
    .sort((left, right) => order.indexOf(left) - order.indexOf(right))
}

async function deliverEngines(names, { eager = false } = {}) {
  for (const name of names) {
    for (const waitMs of [250, 750, null]) {
      try {
        await installArtifact(name)
        console.error(`unica launcher: ${name} delivered`)
        break
      } catch (error) {
        if (error.transient && waitMs !== null) {
          console.error(`unica launcher: retrying ${name} delivery: ${error.message}`)
          await delay(waitMs)
          continue
        }
        if (eager) throw new Error(`${name} delivery failed: ${error.message}`, { cause: error })
        console.error(`unica launcher: ${name} delivery failed: ${error.message}`)
        notifyHost({ type: 'unica:engine-delivery-failed', name, message: error.message })
        break
      }
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

/** Yield one response at a time so a slow client backpressures the server. */
async function* rewriteLines(chunks) {
  let fragments = []
  for await (const chunk of chunks) {
    let start = 0
    for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
      const line = chunk.subarray(start, end)
      if (fragments.length) {
        fragments.push(line)
        yield forwardLine(Buffer.concat(fragments))
        fragments = []
      } else {
        yield forwardLine(line)
      }
      start = end + 1
    }
    if (start < chunk.length) fragments.push(chunk.subarray(start))
  }
  if (fragments.length) yield forwardLine(Buffer.concat(fragments))
}

function relay(child) {
  process.stdin.on('error', () => {})
  process.stdin.pipe(child.stdin)
  child.stdin.on('error', () => {})
  return pipeline(child.stdout, rewriteLines, process.stdout)
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
  if (!canExecute(command)) {
    const file = coreEntry.descriptor.files?.find(file => file.path === coreEntry.descriptor.entrypoint && file.executable)
    await restoreExecutePermission(command, file?.sha256, 'core').catch(error => die(error.message))
  }

  // `off` keeps the cache untouched, `eager` blocks the handover until every engine
  // is in place, and the default starts the server at once and delivers behind it:
  // engines appear on the next call that needs them, and a call that needs one
  // before it lands answers `bundled_tool_missing`, exactly as without them.
  const delivery = process.env.UNICA_ARTIFACT_DELIVERY ?? 'background'
  const pending = delivery === 'off' ? [] : missingEngines()
  if (delivery === 'eager' && pending.length > 0) {
    await deliverEngines(pending, { eager: true }).catch((error) => die(error.message))
  } else if (delivery === 'background' && pending.length > 0) {
    void deliverEngines(pending)
  }
}

// The runtime finds its engines through this cache root, not through its own
// directory: without the variable every engine-backed call fails as if the engine
// were missing even when it is installed right next door.
const childEnv = { ...process.env, UNICA_ARTIFACT_CACHE: cacheRoot }

child = spawn(command, commandArgs, { stdio: TEXT_FALLBACK ? ['pipe', 'pipe', 'inherit'] : 'inherit', env: childEnv })
const relayed = TEXT_FALLBACK && relay(child).catch((error) => {
  child.kill('SIGKILL')
  die(`cannot forward runtime output: ${error.message}`)
})
child.on('error', (error) => die(`cannot start ${command}: ${error.message}`))
child.on('exit', async (code, signal) => {
  clearTimeout(shutdownTimer)
  if (signal !== null) {
    process.off(signal, forwardSignal)
    return process.kill(process.pid, signal)
  }
  // The runtime can exit with its final frame still in either stdout pipe.
  // Let the client's read rate determine when the successful exit is reported.
  await relayed
  process.exit(code ?? 1)
})
child.once('spawn', () => notifyHost({ type: 'unica:runtime-ready' }))
