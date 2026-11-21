import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { apply } from '../dsh-unica-plugin/host/index.js'
import { resolveConfig } from '../dsh-unica-plugin/host/lib/config.js'
import { ProcPool } from '../dsh-unica-plugin/host/lib/pool.js'
import { UnicaProc } from '../dsh-unica-plugin/host/lib/proc.js'

const fixture = join(import.meta.dirname, 'fixtures/workspace-server.mjs')
const bootstrapSource = new URL('../dsh-unica-plugin/bootstrap/', import.meta.url)

async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'unica-native-')))
  const cleanups = []
  const previous = process.env.UNICA_LAUNCH_SELFTEST_COMMAND
  process.env.UNICA_LAUNCH_SELFTEST_COMMAND = JSON.stringify([process.execPath, fixture])
  t.after(async () => {
    for (const dispose of cleanups.reverse()) dispose()
    if (previous === undefined) delete process.env.UNICA_LAUNCH_SELFTEST_COMMAND
    else process.env.UNICA_LAUNCH_SELFTEST_COMMAND = previous
    // On Windows a worker holds its working directory until the process exits.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const config = resolveConfig({
    nodePath: process.execPath, probeCwd: root, runtimeCacheDir: join(root, 'cache'),
    providerStateDir: join(root, 'state'), startupTimeoutMs: 10_000, toolCallTimeoutMs: 3000,
  })
  return { root, config, cleanups }
}

async function waitFor(predicate, description, timeout = 5000) {
  const end = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= end) assert.fail('Timed out waiting for ' + description)
    await delay(10)
  }
}

test('server requests do not resolve a client request with the same id', async (t) => {
  const { root, config } = await setup(t)
  const proc = new UnicaProc({ cwd: root, config })
  try {
    await proc.start()
    const replies = await proc.callTool('server-requests', {})
    assert.deepEqual(replies, [
      { jsonrpc: '2.0', id: 2, result: {} },
      { jsonrpc: '2.0', id: 'unknown', error: { code: -32601, message: 'Method not found' } },
    ])
    assert.deepEqual(await proc.listTools(), [{ name: 'unica.view' }])
  } finally {
    proc.close('test finished', { tree: true })
  }
})

// Exercise the registered tool and the real pipeline from DSH session to child stdio.
async function registerView(cleanups, config, sessions) {
  const tools = []
  await apply({
    workingDirectory: { ensure: (agent) => sessions.get(agent.session) },
    tools: { register(tool) { tools.push(tool); return () => {} } },
    effect(setup) { cleanups.push(setup()) },
  }, config)
  assert.equal(tools.length, 1)
  return async (session, signal) => {
    const response = await tools[0].execute({}, { agent: { session }, signal })
    return response.structuredContent.data
  }
}

test('concurrent DSH sessions use separate workers and reuse their own workspace', async (t) => {
  const { root, config, cleanups } = await setup(t)
  const first = join(root, 'first')
  const second = join(root, 'second')
  await Promise.all([mkdir(first), mkdir(second)])
  const view = await registerView(cleanups, config, new Map([['a', first], ['b', second]]))
  const [a, b] = await Promise.all([view('a'), view('b')])
  assert.equal(a.workspaceRoot, first)
  assert.equal(b.workspaceRoot, second)
  assert.deepEqual([a.calls, b.calls], [1, 1])
  assert.notEqual(a.pid, b.pid)
  const [againB, againA] = await Promise.all([view('b'), view('a')])
  assert.deepEqual(againA, { ...a, calls: 2 })
  assert.deepEqual(againB, { ...b, calls: 2 })
})

// Windows pins a worker's cwd. Retarget a junction there, and replace the
// directory itself on POSIX. Both present the same pool key with new contents.
async function replaceableWorkspace(root) {
  const cwd = join(root, 'project')
  const original = join(root, 'original')
  if (process.platform === 'win32') {
    await mkdir(original)
    await symlink(original, cwd, 'junction')
  } else {
    await mkdir(cwd)
  }
  return {
    cwd, original,
    async replace() {
      if (process.platform === 'win32') {
        const replacement = join(root, 'replacement')
        await mkdir(replacement)
        await unlink(cwd)
        await symlink(replacement, cwd, 'junction')
      } else {
        await rename(cwd, original)
        await mkdir(cwd)
      }
      await writeFile(join(cwd, 'paginate-tools'), '')
    },
  }
}

test('replacing a project at the same path drains its worker after the active call', async (t) => {
  const { root, config } = await setup(t)
  const workspace = await replaceableWorkspace(root)
  const pool = new ProcPool({ ...config, maxProcesses: 1 })
  const release = Promise.withResolvers()
  const view = async proc => (await proc.callTool('unica.view', {})).structuredContent.data
  let old
  const active = pool.withProc(workspace.cwd, async proc => {
    old = await view(proc)
    await release.promise
    return proc.listTools()
  })
  try {
    await waitFor(() => old, 'the original call to start')
    await workspace.replace()
    const current = await pool.withProc(workspace.cwd, async proc => {
      assert.deepEqual(await proc.listTools(), [{ name: 'unica.view' }, { name: 'unica.second' }])
      return view(proc)
    })
    assert.notEqual(current.pid, old.pid)
    release.resolve()
    assert.deepEqual(await active, [{ name: 'unica.view' }])
    await Promise.all([old.pid, old.launcherPid].map(waitForProcessExit))
    const again = await pool.withProc(workspace.cwd, view)
    assert.equal(again.pid, current.pid)
  } finally {
    release.resolve()
    await Promise.allSettled([active])
    pool.closeAll()
  }
})

test('a delayed initialize for a replaced project cannot claim the new path', async (t) => {
  const { root, config } = await setup(t)
  const workspace = await replaceableWorkspace(root)
  await writeFile(join(workspace.cwd, 'hold-initialize'), '')
  const pool = new ProcPool(config)
  const originalCall = pool.withProc(workspace.cwd, proc => proc.listTools())
  try {
    await waitFor(() => existsSync(join(workspace.cwd, 'initialize-started')), 'the original initialize')
    await workspace.replace()
    const expected = [{ name: 'unica.view' }, { name: 'unica.second' }]
    assert.deepEqual(await pool.withProc(workspace.cwd, proc => proc.listTools()), expected)
    await rm(join(workspace.original, 'hold-initialize'))
    assert.deepEqual(await originalCall, [{ name: 'unica.view' }])
    assert.deepEqual(await pool.withProc(workspace.cwd, proc => proc.listTools()), expected)
  } finally {
    pool.closeAll()
    await Promise.allSettled([originalCall])
  }
})

test('a warm worker survives a concurrent call in another project at maxProcesses 1', async (t) => {
  const { root, config, cleanups } = await setup(t)
  const first = join(root, 'first')
  const second = join(root, 'second')
  await Promise.all([mkdir(first), mkdir(second)])
  const view = await registerView(cleanups, { ...config, maxProcesses: 1 }, new Map([['a', first], ['b', second]]))
  const warm = await view('a')

  const [a, b] = await Promise.all([view('a'), view('b')])
  assert.equal(a.workspaceRoot, first)
  assert.equal(a.pid, warm.pid)
  assert.equal(a.calls, 2)
  assert.equal(b.workspaceRoot, second)
  assert.notEqual(b.pid, a.pid)
})

test('excess workers are closed after concurrent calls settle', async (t) => {
  const { root, config } = await setup(t)
  const dirs = ['one', 'two', 'three', 'four'].map(name => join(root, name))
  await Promise.all(dirs.map(dir => mkdir(dir)))
  const pool = new ProcPool({ ...config, maxProcesses: 1 })
  const releases = []
  let unblock
  const gate = new Promise(resolve => { unblock = resolve })
  try {
    const calls = dirs.map(dir => pool.withProc(dir, async proc => {
      const result = await proc.callTool('unica.view', {})
      releases.push(result.structuredContent.data)
      await gate
      return result.structuredContent.data
    }))
    await waitFor(() => releases.length === 4, 'four active workers')
    assert.equal(new Set(releases.map(result => result.pid)).size, 4)
    unblock()
    const results = await Promise.all(calls)
    assert.deepEqual(results.map(result => result.workspaceRoot), dirs)
    await waitFor(() => results.filter(result => {
      try { process.kill(result.pid, 0); return true } catch { return false }
    }).length === 1, 'excess workers to exit')
    const survivor = results.find(result => {
      try { process.kill(result.pid, 0); return true } catch { return false }
    })
    const again = await pool.withProc(survivor.workspaceRoot, proc => proc.callTool('unica.view', {}))
    assert.equal(again.structuredContent.data.pid, survivor.pid)
  } finally {
    unblock()
    pool.closeAll()
  }
})

test('workers that initialize after all waiting calls cancel still respect the pool limit', async (t) => {
  const { root, config, cleanups } = await setup(t)
  const dirs = ['first', 'second'].map(name => join(root, name))
  const gates = dirs.map(dir => join(dir, 'hold-initialize'))
  const markers = dirs.map(dir => join(dir, 'initialize-started'))
  await Promise.all(dirs.map(dir => mkdir(dir)))
  await Promise.all(gates.map(gate => writeFile(gate, '')))
  const pool = new ProcPool({ ...config, maxProcesses: 1 })
  cleanups.push(() => pool.closeAll())
  const controller = new AbortController()
  const tool = t.mock.fn()
  const calls = dirs.map(dir => assert.rejects(pool.withProc(dir, tool, controller.signal), { name: 'AbortError' }))
  try {
    await waitFor(() => markers.every(marker => existsSync(marker)), 'both initialize requests')
    controller.abort()
    await Promise.all(calls)
    assert.equal(tool.mock.callCount(), 0)
    const pids = await Promise.all(markers.map(async marker => Number(await readFile(marker, 'utf8'))))
    await Promise.all(gates.map(gate => rm(gate)))
    await waitFor(() => pids.some(pid => {
      try { process.kill(pid, 0); return false }
      catch (error) { if (error.code === 'ESRCH') return true; throw error }
    }), 'one unreserved worker to exit after initialize')
  } finally {
    controller.abort()
    await Promise.allSettled(calls)
  }
})

test('cancelling a caller during initialize leaves the shared startup available to its peer', async (t) => {
  const { root, config, cleanups } = await setup(t)
  const cwd = join(root, 'project')
  await mkdir(cwd)
  const gate = join(cwd, 'hold-initialize')
  await writeFile(gate, '')
  const view = await registerView(cleanups, config, new Map([['first', cwd], ['peer', cwd]]))
  const controller = new AbortController()
  const cancelled = assert.rejects(view('first', controller.signal), { name: 'AbortError' })
  const peer = view('peer')
  try {
    await waitFor(() => existsSync(join(cwd, 'initialize-started')), 'initialize request')
    controller.abort()
    const completed = await Promise.race([cancelled.then(() => true), delay(1500, false, { ref: false })])
    assert.ok(completed, 'cancellation must finish before initialize is released')
  } finally {
    await rm(gate)
    await Promise.allSettled([peer, cancelled])
  }
  await cancelled
  const result = await peer
  assert.equal(result.calls, 1, 'only the peer sent a tool request')
  assert.equal(String(result.pid), await readFile(join(cwd, 'initialize-started'), 'utf8'))
  assert.deepEqual(await view('peer'), { ...result, calls: 2 })
})

test('slow initialize uses the startup budget and the pool retries a timed-out handshake', async (t) => {
  const { root, config } = await setup(t)
  const gate = join(root, 'hold-initialize')
  await writeFile(gate, '')
  // A held handshake exceeds the tool deadline, but fits inside the startup deadline.
  const proc = new UnicaProc({ cwd: root, config: { ...config, toolCallTimeoutMs: 30 } })
  try {
    const started = proc.start()
    const release = async () => {
      await waitFor(() => existsSync(join(root, 'initialize-started')), 'delayed initialize')
      await delay(100)
      await rm(gate)
    }
    await Promise.all([started, release()])
    assert.deepEqual(await proc.listTools({ timeoutMs: 3000 }), [{ name: 'unica.view' }])
  } finally {
    proc.close('test finished', { tree: true })
  }

  await writeFile(gate, '')
  const pool = new ProcPool({ ...config, startupTimeoutMs: 1500 })
  try {
    await assert.rejects(pool.withProc(root, (p) => p.listTools()), /initialize timed out after 1500 ms/)
    await rm(gate)
    assert.deepEqual(await pool.withProc(root, (p) => p.listTools()), [{ name: 'unica.view' }])
  } finally {
    pool.closeAll()
  }
})

async function waitForProcessExit(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0)
  await waitFor(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch (error) {
      if (error.code === 'ESRCH') return true
      throw error
    }
  }, `process ${pid} to exit`)
}

test('closeAll during initialize stops the worker and rejects every waiting call', async (t) => {
  const { root, config } = await setup(t)
  const gate = join(root, 'hold-initialize')
  const marker = join(root, 'initialize-started')
  await writeFile(gate, '')
  const pool = new ProcPool(config)
  const tool = t.mock.fn((proc) => proc.callTool('unica.view', {}))
  const waiting = Promise.allSettled([pool.withProc(root, tool), pool.withProc(root, tool)])
  try {
    await waitFor(() => existsSync(marker), 'worker to enter initialize')
    const serverPid = Number(await readFile(marker, 'utf8'))
    const launcherPid = Number(await readFile(join(root, 'launcher-pid'), 'utf8'))
    pool.closeAll()
    pool.closeAll()
    await Promise.all([serverPid, launcherPid].map(waitForProcessExit))
    for (const result of await waiting) {
      assert.equal(result.status, 'rejected')
      assert.match(result.reason.message, /plugin unloaded/)
    }
    await assert.rejects(pool.withProc(root, tool), /plugin unloaded/)
    assert.equal(tool.mock.callCount(), 0)
  } finally {
    await rm(gate)
    await waiting
    pool.closeAll()
  }
})

test('closeAll prevents dispatch to an already acquired warm worker', async (t) => {
  const { root, config } = await setup(t)
  const pool = new ProcPool(config)
  try {
    const view = await pool.withProc(root, (proc) => proc.callTool('unica.view', {}))
    const { pid, launcherPid } = view.structuredContent.data
    const tool = t.mock.fn()
    const queued = pool.withProc(root, tool)
    pool.closeAll()
    await assert.rejects(queued, /plugin unloaded/)
    assert.equal(tool.mock.callCount(), 0)
    await Promise.all([pid, launcherPid].map(waitForProcessExit))
  } finally {
    pool.closeAll()
  }
})

test('a pooled workspace still answers calls after a background engine HTTP 503', {
  skip: process.platform === 'win32' && 'the cached MCP fixture uses a POSIX shebang',
}, async (t) => {
  const { root, config } = await setup(t)
  // Use a cached executable fixture and the real delivery path. A test preload
  // supplies the HTTP response to the launcher without opening a socket.
  delete process.env.UNICA_LAUNCH_SELFTEST_COMMAND
  const target = process.platform === 'win32' ? 'win-x64' : `${process.platform}-${process.arch}`
  const core = join(config.runtimeCacheDir, 'unica', 'test--cached', target)
  await mkdir(core, { recursive: true })
  await cp(bootstrapSource, join(root, 'bootstrap'), { recursive: true })
  await writeFile(join(core, '.ready.json'), '{}')
  // This test runs in the POSIX CI job. Use the fixture as the executable
  // entrypoint, so the launcher takes its normal background-delivery branch.
  const entrypoint = 'server.mjs'
  await writeFile(join(core, entrypoint), '#!/usr/bin/env node\n' + await readFile(fixture, 'utf8'), { mode: 0o755 })
  const artifacts = {
    unica: { version: 'test', targets: { [target]: { asset: { sha256: 'cached' }, entrypoint } } },
    'v8-runner': { version: 'test', targets: { [target]: { asset: { name: 'engine.zip', url: 'https://example.invalid/engine', sha256: 'unused' } } } },
  }
  await writeFile(join(root, 'runtime-manifest.json'), JSON.stringify({ artifacts }))
  const previousOptions = process.env.NODE_OPTIONS
  const preload = pathToFileURL(join(import.meta.dirname, 'fixtures/engine-http-503.mjs'))
  process.env.NODE_OPTIONS = '--import=' + preload.href
  const pool = new ProcPool({ ...config, pluginRoot: root, artifactDelivery: 'background' })
  try {
    const view = (proc) => proc.callTool('unica.view', {}).then((result) => result.structuredContent.data)
    const first = await pool.withProc(root, view)
    assert.equal(first.workspaceRoot, root)
    await writeFile(join(root, 'release-engine-download'), '')
    const afterFailure = await pool.withProc(root, async (proc) => {
      await waitFor(() => /v8-runner delivery failed: .*HTTP 503/.test(proc.stderrTail()), 'engine delivery failure')
      return view(proc)
    })
    assert.deepEqual(afterFailure, { ...first, calls: 2 })
    assert.deepEqual(await readdir(config.runtimeCacheDir), ['unica'])
  } finally {
    pool.closeAll()
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previousOptions
  }
})
