import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveConfig } from '../dsh-unica-plugin/host/lib/config.js'
import { UnicaProc } from '../dsh-unica-plugin/host/lib/proc.js'

test('two cold launchers initialize without replacing the first published runtime', { timeout: 240_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'unica-publish-')))
  const cache = join(root, 'cache')
  const target = process.platform === 'win32' ? 'win-x64' : `${process.platform}-${process.arch}`
  const { artifacts: { unica } } = JSON.parse(await readFile(new URL('../dsh-unica-plugin/runtime-manifest.json', import.meta.url)))
  const directory = join(cache, 'unica', `${unica.version}--${unica.targets[target].asset.sha256}`, target)
  const workers = []
  const launches = []
  async function workspace(name) {
    const cwd = join(root, name)
    const state = join(root, name + '-state')
    await Promise.all([mkdir(cwd), mkdir(state)])
    const worker = new UnicaProc({ cwd, config: resolveConfig({
      nodePath: process.execPath, runtimeCacheDir: cache, providerStateDir: state,
      artifactDelivery: 'off', startupTimeoutMs: 180_000,
    }) })
    workers.push(worker)
    return worker
  }
  function start(worker) {
    const launch = worker.start().catch(error => {
      throw new Error(`${error.message}\n${worker.stderrTail()}`, { cause: error })
    })
    launches.push(launch)
    return launch
  }

  try {
    const first = await workspace('first')
    const second = await workspace('second')
    const preload = new URL('./fixtures/hold-cache-publication.mjs', import.meta.url)
    const previous = process.env.NODE_OPTIONS
    const oldDestination = process.env.UNICA_TEST_PUBLISH_DIR
    let firstStart, secondStart
    try {
      process.env.NODE_OPTIONS = [previous, '--import=' + preload.href].filter(Boolean).join(' ')
      process.env.UNICA_TEST_PUBLISH_DIR = directory
      firstStart = start(first)
      secondStart = start(second)
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previous
      if (oldDestination === undefined) delete process.env.UNICA_TEST_PUBLISH_DIR
      else process.env.UNICA_TEST_PUBLISH_DIR = oldDestination
    }

    // Both launchers see a cold cache. Keep the second staged until the first
    // is already serving, so the stale check/removal race is deterministic.
    const controller = new AbortController()
    async function waitForStaging() {
      while (!workers.every(worker => existsSync(join(worker.cwd, 'waiting-to-publish')))) {
        await delay(30, undefined, { signal: controller.signal })
      }
    }
    try {
      const prematureStart = Promise.race(launches).then(() => assert.fail('launcher bypassed the publication barrier'))
      await Promise.race([waitForStaging(), prematureStart])
    } finally {
      controller.abort()
    }
    assert.ok(!existsSync(directory))
    await writeFile(join(first.cwd, 'continue-publication'), '')
    await firstStart
    const witness = join(directory, 'first-publisher.txt')
    await writeFile(witness, 'original')
    await writeFile(join(second.cwd, 'continue-publication'), '')
    await secondStart

    for (const worker of workers) {
      assert.equal(worker.serverInfo.version, unica.version)
      const view = await worker.callTool('unica.view', {})
      assert.equal(view.structuredContent.data.workspaceRoot, worker.cwd)
    }
    assert.equal(await readFile(witness, 'utf8'), 'original', 'first published runtime was replaced')
    assert.deepEqual(await readdir(cache), ['unica'])
  } finally {
    for (const worker of workers) worker.close('test finished', { tree: true })
    await Promise.allSettled(launches)
    await rm(root, { recursive: true, force: true, maxRetries: 8 })
  }
})
