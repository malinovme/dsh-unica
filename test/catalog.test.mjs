import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { apply } from '../dsh-unica-plugin/host/index.js'

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for ' + predicate)
    await delay(20)
  }
}

async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'unica-catalog-')))
  const gate = join(root, 'hold-initialize')
  await writeFile(gate, '')
  const previous = process.env.UNICA_LAUNCH_SELFTEST_COMMAND
  process.env.UNICA_LAUNCH_SELFTEST_COMMAND = JSON.stringify([process.execPath, join(import.meta.dirname, 'fixtures/workspace-server.mjs')])
  const cleanups = [], registered = [], warnings = [], errors = []
  const unload = () => { for (const dispose of cleanups.splice(0).reverse()) dispose() }
  t.after(async () => {
    unload()
    if (previous === undefined) delete process.env.UNICA_LAUNCH_SELFTEST_COMMAND
    else process.env.UNICA_LAUNCH_SELFTEST_COMMAND = previous
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const ctx = {
    workingDirectory: { ensure: () => root },
    tools: { register(tool) { registered.push(tool); return () => {} } },
    effect(setup) { cleanups.push(setup()) },
    logger: { warn: msg => warnings.push(msg), error: msg => errors.push(msg) },
  }
  const start = startupTimeoutMs => apply(ctx, { nodePath: process.execPath, probeCwd: root, startupTimeoutMs })
  return { root, gate, registered, warnings, errors, unload, start }
}

test('a timed-out activation registers one usable tool after the probe recovers', async (t) => {
  const { root, gate, registered, warnings, start } = await setup(t)
  await start(1500)
  assert.match(warnings[0], /initialize timed out/)
  assert.equal(registered.length, 0)
  await rm(gate)
  await waitFor(() => registered.length > 0)
  assert.equal(registered.length, 1)
  const reply = await registered[0].execute({}, { agent: { session: 'same-session' } })
  assert.equal(reply.structuredContent.data.workspaceRoot, root)
})

test('unloading during the retry delay prevents a second probe', async (t) => {
  const { root, registered, warnings, unload, start } = await setup(t)
  await start(1500)
  assert.equal(warnings.length, 1)
  unload()
  const marker = join(root, 'initialize-started')
  await rm(marker)
  await delay(1600)
  assert.equal(existsSync(marker), false)
  assert.deepEqual(registered, [])
})

test('unloading during initialize stops the catalog probe and cancels registration', async (t) => {
  const { root, registered, warnings, unload, start } = await setup(t)
  const activation = start(15_000)
  const marker = join(root, 'initialize-started')
  await waitFor(() => existsSync(marker))
  const pids = await Promise.all([marker, join(root, 'launcher-pid')].map(async file => Number(await readFile(file, 'utf8'))))
  unload()
  await activation
  for (const pid of pids) {
    assert.ok(pid > 0)
    await waitFor(() => {
      try { process.kill(pid, 0); return false }
      catch (error) { if (error.code === 'ESRCH') return true; throw error }
    })
  }
  assert.deepEqual(registered, [])
  assert.deepEqual(warnings, [])
})

test('persistent catalog failures stop after two retries and report the cause', async (t) => {
  const { start, warnings, errors, registered } = await setup(t)
  await start(200)
  await waitFor(() => errors.length > 0)
  assert.equal(warnings.length, 2)
  assert.match(errors[0], /initialize timed out after 200 ms/)
  assert.deepEqual(registered, [])
})
