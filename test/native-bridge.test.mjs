import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { apply } from '../dsh-unica-plugin/host/index.js'
import { resolveConfig } from '../dsh-unica-plugin/host/lib/config.js'
import { ProcPool } from '../dsh-unica-plugin/host/lib/pool.js'
import { UnicaProc } from '../dsh-unica-plugin/host/lib/proc.js'

const fixture = join(import.meta.dirname, 'fixtures/workspace-server.mjs')
const launcher = resolve(import.meta.dirname, '../dsh-unica-plugin/bootstrap/launch.mjs')

async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'unica-native-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previous = process.env.UNICA_LAUNCH_SELFTEST_COMMAND
  process.env.UNICA_LAUNCH_SELFTEST_COMMAND = JSON.stringify([process.execPath, fixture])
  t.after(() => {
    if (previous === undefined) delete process.env.UNICA_LAUNCH_SELFTEST_COMMAND
    else process.env.UNICA_LAUNCH_SELFTEST_COMMAND = previous
  })
  const config = resolveConfig({
    nodePath: process.execPath, probeCwd: root, runtimeCacheDir: join(root, 'cache'),
    providerStateDir: join(root, 'state'), startupTimeoutMs: 10_000, toolCallTimeoutMs: 3000,
  })
  return { root, config }
}

async function waitFor(predicate, description, timeout = 5000) {
  const end = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= end) assert.fail('Timed out waiting for ' + description)
    await delay(10)
  }
}

// Exercise the registered tool and the real pipeline from DSH session to child stdio.
async function registerView(t, config, sessions) {
  const tools = []
  const cleanups = []
  t.after(() => { for (const dispose of cleanups.reverse()) dispose() })
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
  const { root, config } = await setup(t)
  const first = join(root, 'first')
  const second = join(root, 'second')
  await Promise.all([mkdir(first), mkdir(second)])
  const view = await registerView(t, config, new Map([['a', first], ['b', second]]))
  const [a, b] = await Promise.all([view('a'), view('b')])
  assert.equal(a.workspaceRoot, first)
  assert.equal(b.workspaceRoot, second)
  assert.deepEqual([a.calls, b.calls], [1, 1])
  assert.notEqual(a.pid, b.pid)
  const [againB, againA] = await Promise.all([view('b'), view('a')])
  assert.deepEqual(againA, { ...a, calls: 2 })
  assert.deepEqual(againB, { ...b, calls: 2 })
})

test('cancelling a caller during initialize leaves the shared startup available to its peer', async (t) => {
  const { root, config } = await setup(t)
  const cwd = join(root, 'project')
  await mkdir(cwd)
  const gate = join(cwd, 'hold-initialize')
  await writeFile(gate, '')
  const view = await registerView(t, config, new Map([['first', cwd], ['peer', cwd]]))
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

test('a pooled workspace still answers calls after a background engine HTTP 503', {
  skip: process.platform === 'win32' && 'the cached MCP fixture uses a POSIX shebang',
}, async (t) => {
  const { root, config } = await setup(t)
  // Use a cached executable fixture and the real delivery path. A test preload
  // supplies the HTTP response to the launcher without opening a socket.
  delete process.env.UNICA_LAUNCH_SELFTEST_COMMAND
  const target = process.platform === 'win32' ? 'win-x64' : `${process.platform}-${process.arch}`
  const core = join(config.runtimeCacheDir, 'unica', 'test--cached', target)
  const bootstrap = join(root, 'bootstrap')
  await Promise.all([mkdir(core, { recursive: true }), mkdir(bootstrap)])
  await copyFile(launcher, join(bootstrap, 'launch.mjs'))
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
