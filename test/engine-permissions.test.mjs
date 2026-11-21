import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { resolveConfig } from '../dsh-unica-plugin/host/lib/config.js'
import { UnicaProc } from '../dsh-unica-plugin/host/lib/proc.js'

const unix = { skip: process.platform === 'win32', timeout: 20_000 }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const badUrl = 'data:text/plain,wrong-asset'

async function setup(t, name) {
  const root = await mkdtemp(join(tmpdir(), 'unica-engine-mode-'))
  const cache = join(root, 'cache')
  const workers = []
  t.after(async () => {
    for (const worker of workers) worker.close()
    await rm(root, { recursive: true, force: true })
  })
  const target = process.platform + '-' + process.arch
  const manifest = { artifacts: {} }
  const manifestPath = join(root, 'runtime-manifest.json')
  async function cacheArtifact(artifactName, descriptor, script, mode) {
    manifest.artifacts[artifactName] = { version: 'test', targets: { [target]: descriptor } }
    const dir = join(cache, artifactName, 'test--' + descriptor.asset.sha256, target)
    const executable = join(dir, descriptor.entrypoint)
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, script)
    await chmod(executable, mode)
    await writeFile(join(dir, '.ready.json'), '{}')
    return executable
  }

  await mkdir(join(root, 'bootstrap'))
  await copyFile(new URL('../dsh-unica-plugin/bootstrap/launch.mjs', import.meta.url), join(root, 'bootstrap/launch.mjs'))
  const server = new URL('./fixtures/workspace-server.mjs', import.meta.url)
  const core = '#!/usr/bin/env node\nimport ' + JSON.stringify(server.href) + '\n'
  await cacheArtifact('unica', { asset: { sha256: sha256(core) }, entrypoint: 'core.mjs' }, core, 0o700)

  const script = "#!/bin/sh\necho '" + name + " ready'\n"
  const descriptor = { asset: { name, sha256: sha256(script), url: badUrl },
    entrypoint: name, install: { strategy: 'file', as: name } }
  if (name === 'v8-runner') {
    descriptor.entrypoint = 'bin/v8-runner'
    descriptor.install = { strategy: 'archive' }
    const buildDir = join(root, 'build')
    await mkdir(join(buildDir, 'bin'), { recursive: true })
    await writeFile(join(buildDir, descriptor.entrypoint), script, { mode: 0o700 })
    const archive = execFileSync('tar', ['-czf', '-', '-C', buildDir, 'bin'])
    descriptor.asset = { name: 'v8-runner.tar.gz', sha256: sha256(archive),
      url: 'data:application/octet-stream;base64,' + archive.toString('base64') }
  }
  const executable = await cacheArtifact(name, descriptor, script, 0o640)
  await writeFile(manifestPath, JSON.stringify(manifest))
  async function disableDownload() {
    descriptor.asset.url = badUrl
    await writeFile(manifestPath, JSON.stringify(manifest))
  }
  function worker(artifactDelivery = 'eager', log) {
    const config = resolveConfig({ pluginRoot: root, runtimeCacheDir: cache, artifactDelivery,
      providerStateDir: join(root, 'state'), nodePath: process.execPath })
    const proc = new UnicaProc({ cwd: root, config, log })
    workers.push(proc)
    return proc
  }
  return { disableDownload, executable, worker }
}

for (const name of ['bsl-analyzer', 'v8-runner']) {
  test(name + ' recovers its execute bit and reuses the repaired cache offline', unix, async (t) => {
    const { disableDownload, executable, worker } = await setup(t, name)
    await Promise.all([worker().start(), worker().start()])
    assert.equal((await stat(executable)).mode & 0o777, 0o740)
    assert.equal(execFileSync(executable, { encoding: 'utf8' }).trim(), name + ' ready')

    // An archive re-download would now fail its pinned digest.
    await disableDownload()
    await worker().start()
  })

  test(name + ' with changed cache bytes remains non-executable', unix, async (t) => {
    const { executable, worker } = await setup(t, name)
    await writeFile(executable, '#!/bin/sh\necho changed\n')
    await assert.rejects(worker().start(), error =>
      error.message.includes(name + ' delivery failed') && error.message.includes('checksum mismatch'))
    assert.equal((await stat(executable)).mode & 0o111, 0)
  })
}

test('an unverified archive cannot grant execute; background mode still serves calls', unix, async (t) => {
  const { disableDownload, executable, worker } = await setup(t, 'v8-runner')
  await disableDownload()
  const warning = Promise.withResolvers()
  const proc = worker('background', { warn: warning.resolve })
  await proc.start()
  assert.match(await warning.promise, /v8-runner delivery failed: .*checksum mismatch/)
  assert.equal((await stat(executable)).mode & 0o111, 0)
  assert.deepEqual(await proc.listTools(), [{ name: 'unica.view' }])
})
