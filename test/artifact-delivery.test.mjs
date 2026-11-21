import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { apply } from '../dsh-unica-plugin/host/index.js'
import { resolveConfig } from '../dsh-unica-plugin/host/lib/config.js'
import { UnicaProc } from '../dsh-unica-plugin/host/lib/proc.js'

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

async function waitFor(predicate, description) {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for ' + description)
    await delay(10)
  }
}

async function setup(t, mode, delivery = 'background') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'unica-artifact-')))
  const cleanups = []
  t.after(async () => {
    for (const close of cleanups.reverse()) close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const cache = join(root, 'cache')
  const target = { win32: 'win', darwin: 'darwin', linux: 'linux' }[process.platform] + '-' + process.arch
  const entrypoint = 'fixture-runtime'
  const bundle = join(root, 'bundle')
  await mkdir(bundle)
  await writeFile(join(bundle, entrypoint), 'fixture core')
  const archive = join(root, 'core.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', bundle, entrypoint])
  const coreHash = sha256(await readFile(archive))
  const engineHash = sha256('fixture engine')
  const artifacts = {
    unica: { version: 'test', targets: { [target]: {
      asset: { name: 'core.tar.gz', url: 'https://example.invalid/core.tar.gz', sha256: coreHash },
      entrypoint, files: [{ path: entrypoint, sha256: sha256('fixture core'), executable: true }],
    } } },
    'v8-runner': { version: 'test', targets: { [target]: {
      asset: { name: 'engine', url: 'https://example.invalid/engine', sha256: engineHash },
      install: { strategy: 'file', as: 'engine' }, entrypoint: 'engine',
    } } },
  }
  if (mode === 'unreadable') artifacts['bsl-analyzer'] = artifacts['v8-runner']
  await cp(new URL('../dsh-unica-plugin/bootstrap/', import.meta.url), join(root, 'bootstrap'), { recursive: true })
  await writeFile(join(root, 'runtime-manifest.json'), JSON.stringify({ artifacts }))

  const config = resolveConfig({
    nodePath: process.execPath, pluginRoot: root, probeCwd: root, runtimeCacheDir: cache,
    providerStateDir: join(root, 'state'), startupTimeoutMs: 1000, coldStartTimeoutMs: 15_000,
    artifactDelivery: mode ? delivery : 'off',
  })
  if (mode) {
    const core = join(cache, 'unica', `test--${coreHash}`, target)
    await mkdir(core, { recursive: true })
    await copyFile(join(bundle, entrypoint), join(core, entrypoint))
    await writeFile(join(core, '.ready.json'), '{}')
  }
  const previous = { ...process.env }
  process.env.UNICA_LAUNCH_SELFTEST_COMMAND = ''
  process.env.NODE_OPTIONS = [previous.NODE_OPTIONS, '--import=' + new URL('./fixtures/launcher-artifacts.mjs', import.meta.url).href]
    .filter(Boolean).join(' ')
  process.env.UNICA_TEST_ARTIFACTS = JSON.stringify({
    root, mode, deniedPath: join(cache, 'v8-runner', `test--${engineHash}`, target, 'engine'), server: join(import.meta.dirname, 'fixtures/workspace-server.mjs'),
  })
  t.after(() => {
    for (const key of ['NODE_OPTIONS', 'UNICA_TEST_ARTIFACTS', 'UNICA_LAUNCH_SELFTEST_COMMAND']) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })
  return { root, config, cleanups, engine: join(cache, 'v8-runner', `test--${engineHash}`, target) }
}

test('the native bridge passes the configured or inherited artifact delivery mode to the runtime', async (t) => {
  const { root } = await setup(t)
  const originalMode = process.env.UNICA_ARTIFACT_DELIVERY
  t.after(() => {
    if (originalMode === undefined) delete process.env.UNICA_ARTIFACT_DELIVERY
    else process.env.UNICA_ARTIFACT_DELIVERY = originalMode
  })
  process.env.UNICA_LAUNCH_SELFTEST_COMMAND = JSON.stringify([process.execPath, join(import.meta.dirname, 'fixtures/workspace-server.mjs')])
  for (const [inherited, configured, expected] of [
    [undefined, undefined, 'background'], ['off', undefined, 'off'], ['eager', undefined, 'eager'],
    ['off', 'eager', 'eager'], ['eagerr', 'background', 'background'],
  ]) {
    if (inherited === undefined) delete process.env.UNICA_ARTIFACT_DELIVERY
    else process.env.UNICA_ARTIFACT_DELIVERY = inherited
    const config = resolveConfig({ nodePath: process.execPath, pluginRoot: root, artifactDelivery: configured })
    const proc = new UnicaProc({ cwd: root, config })
    try {
      await proc.start()
      assert.equal((await proc.callTool('artifact-delivery', {})).structuredContent.mode, expected)
    } finally {
      proc.close()
    }
  }

  const diagnostic = /artifactDelivery.*background.*eager.*off/
  process.env.UNICA_ARTIFACT_DELIVERY = 'off'
  assert.throws(() => resolveConfig({ artifactDelivery: 'eagerr' }), diagnostic)
  process.env.UNICA_ARTIFACT_DELIVERY = 'eagerr'
  assert.throws(() => resolveConfig({}), diagnostic)
  const direct = spawnSync(process.execPath, [join(root, 'bootstrap', 'launch.mjs'), root], { encoding: 'utf8' })
  assert.equal(direct.status, 1)
  assert.match(direct.stderr, diagnostic)
})

for (const delivery of ['background', 'eager']) {
  test(delivery + ' isolates a read error in an existing engine cache', async (t) => {
    const { root, config, cleanups, engine } = await setup(t, 'unreadable', delivery)
    await mkdir(engine, { recursive: true })
    await writeFile(join(engine, 'engine'), 'fixture engine', { mode: 0o755 })
    await writeFile(join(engine, '.ready.json'), '{}')
    await writeFile(join(root, 'release-engine'), '')
    const warnings = []
    const proc = new UnicaProc({ cwd: root, config, log: { warn: message => warnings.push(message) } })
    cleanups.push(() => proc.close())
    const failure = /v8-runner delivery failed: .*EACCES/
    if (delivery === 'eager') {
      await assert.rejects(proc.start(), failure)
    } else {
      await proc.start()
      assert.equal((await proc.callTool('unica.view', {})).structuredContent.data.workspaceRoot, root)
      await waitFor(() => warnings.some(message => failure.test(message)), 'engine cache diagnostic')
      const other = engine.replace('v8-runner', 'bsl-analyzer')
      await waitFor(() => existsSync(join(other, '.ready.json')), 'delivery of the other engine')
      assert.equal(await readFile(join(other, 'engine'), 'utf8'), 'fixture engine')
    }
  })
}

for (const mode of ['recover', 'corrupt', 'unavailable']) {
  test(`eager engine delivery ${mode === 'recover' ? 'waits for success' : `rejects ${mode}`}`, async (t) => {
    const { root, config, cleanups, engine } = await setup(t, mode, 'eager')
    const proc = new UnicaProc({ cwd: root, config })
    cleanups.push(() => proc.close())
    const startup = proc.start()
    await waitFor(() => existsSync(join(root, 'engine-attempts')), 'engine download')
    assert.equal(existsSync(join(engine, '.ready.json')), false)
    await writeFile(join(root, 'release-engine'), '')
    if (mode === 'recover') {
      await startup
      assert.equal(await readFile(join(engine, 'engine'), 'utf8'), 'fixture engine')
      assert.ok(existsSync(join(engine, '.ready.json')))
    } else {
      await assert.rejects(startup, mode === 'corrupt' ? /v8-runner delivery failed: .*checksum mismatch/ : /v8-runner delivery failed: .*HTTP 503/)
      assert.equal(existsSync(engine), false)
      assert.equal(proc.alive, false)
    }
    const attempts = (await readFile(join(root, 'engine-attempts'), 'utf8')).trim().split('\n')
    assert.equal(attempts.length, { recover: 2, corrupt: 1, unavailable: 3 }[mode])
  })
}

for (const unload of [false, true]) {
  test(unload ? 'unload stops a probe during cold delivery' : 'slow cold delivery gets its own deadline and registers tools', async (t) => {
    const { root, config, cleanups } = await setup(t)
    const registered = []
    const activation = apply({
      effect(setup) { cleanups.push(setup()) },
      tools: { register(tool) { registered.push(tool); return () => {} } },
      workingDirectory: { ensure: () => root },
    }, config)
    const attempts = join(root, 'core-attempts')
    await waitFor(() => existsSync(attempts), 'core download')
    if (unload) {
      const pid = Number(await readFile(attempts, 'utf8'))
      cleanups.pop()()
      await activation
      await waitFor(() => {
        try { process.kill(pid, 0); return false }
        catch (error) { if (error.code === 'ESRCH') return true; throw error }
      }, 'launcher exit')
      assert.equal(registered.length, 0)
    } else {
      await delay(config.startupTimeoutMs + 200)
      assert.equal(registered.length, 0)
      await writeFile(join(root, 'release-core'), '')
      await activation
      assert.equal(registered.length, 1)
      assert.equal((await readFile(attempts, 'utf8')).trim().split('\n').length, 1)
    }
  })
}

for (const peerPublishes of [true, false]) {
  test(`cold core HTTP 503 ${peerPublishes ? 'uses a ready peer installation' : 'reports the failure for an incomplete cache'}`, async (t) => {
    const { root, config, cleanups } = await setup(t)
    const cwd = join(root, 'delayed')
    await mkdir(cwd)
    await writeFile(join(cwd, 'fail-core'), '')
    const delayed = new UnicaProc({ cwd, config })
    cleanups.push(() => delayed.close())
    const started = delayed.start()
    const result = peerPublishes ? started : assert.rejects(started, /HTTP 503/)
    await waitFor(() => existsSync(join(cwd, 'core-requested')), 'first core request')
    if (peerPublishes) {
      await writeFile(join(root, 'release-core'), '')
      const peer = new UnicaProc({ cwd: root, config })
      cleanups.push(() => peer.close())
      await peer.start()
      assert.equal((await peer.callTool('unica.view', {})).structuredContent.data.workspaceRoot, root)
    } else {
      const { artifacts } = JSON.parse(await readFile(join(root, 'runtime-manifest.json')))
      const [target, descriptor] = Object.entries(artifacts.unica.targets)[0]
      const incomplete = join(config.runtimeCacheDir, 'unica', `test--${descriptor.asset.sha256}`, target)
      await mkdir(incomplete, { recursive: true })
      await writeFile(join(incomplete, '.ready.json'), '{}')
    }
    await writeFile(join(cwd, 'release-failure'), '')
    await result
    if (peerPublishes) assert.equal((await delayed.callTool('unica.view', {})).structuredContent.data.workspaceRoot, cwd)
  })
}

test('a stalled cold delivery expires before initialize', async (t) => {
  const { root, config, cleanups } = await setup(t)
  const proc = new UnicaProc({ cwd: root, config: { ...config, coldStartTimeoutMs: 1500, startupTimeoutMs: 5000 } })
  cleanups.push(() => proc.close())
  await assert.rejects(proc.start(), /runtime preparation timed out after 1500 ms/)
  assert.equal(proc.alive, false)
})

for (const mode of ['recover', 'corrupt', 'unavailable']) {
  test(`background engine delivery handles ${mode} without restarting the server`, async (t) => {
    const { root, config, cleanups, engine } = await setup(t, mode)
    const warnings = []
    const proc = new UnicaProc({ cwd: root, config, log: { warn: warning => warnings.push(warning) } })
    cleanups.push(() => proc.close())
    await proc.start()
    const view = async () => (await proc.callTool('unica.view', {})).structuredContent.data
    const first = await view()
    await writeFile(join(root, 'release-engine'), '')
    if (mode === 'recover') {
      await waitFor(() => existsSync(join(engine, '.ready.json')), 'engine publication after HTTP 503')
      assert.equal(await readFile(join(engine, 'engine'), 'utf8'), 'fixture engine')
      assert.deepEqual(warnings, [])
    } else {
      await waitFor(() => warnings.length > 0, 'engine failure in DSH log')
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], mode === 'corrupt' ? /v8-runner delivery failed: .*checksum mismatch/ : /v8-runner delivery failed: .*HTTP 503/)
      assert.equal(existsSync(engine), false)
    }
    const attempts = (await readFile(join(root, 'engine-attempts'), 'utf8')).trim().split('\n')
    assert.equal(attempts.length, { recover: 2, corrupt: 1, unavailable: 3 }[mode])
    assert.deepEqual(await view(), { ...first, calls: 2 })
  })
}
