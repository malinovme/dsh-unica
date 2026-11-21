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

async function setup(t, { workingDirectory, defaultCwd } = {}) {
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
    workingDirectory: workingDirectory ?? { ensure: () => root },
    tools: { register(tool) { registered.push(tool); return () => {} } },
    effect(setup) { cleanups.push(setup()) },
    logger: { warn: msg => warnings.push(msg), error: msg => errors.push(msg) },
  }
  const start = (startupTimeoutMs, serverName) => apply(ctx, { nodePath: process.execPath, probeCwd: root, startupTimeoutMs, serverName, defaultCwd })
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

test('activation registers and invokes tools from later pages', async (t) => {
  const { root, gate, registered, start } = await setup(t)
  await rm(gate)
  await writeFile(join(root, 'paginate-tools'), '')
  await start(1500)
  assert.equal(registered.length, 2)
  const second = registered.find(tool => tool.name.includes('second'))
  assert.ok(second)
  const reply = await second.execute({}, { agent: { session: 'second-page' } })
  assert.equal(reply.structuredContent.data.name, 'unica.second')
})

test('activation rejects a repeated catalog cursor', async (t) => {
  const { root, gate, registered, warnings, errors, start } = await setup(t)
  await rm(gate)
  await writeFile(join(root, 'paginate-tools'), '')
  await writeFile(join(root, 'repeat-cursor'), '')
  await start(1500)
  await waitFor(() => errors.length > 0)
  assert.equal(warnings.length, 2)
  assert.match(errors[0], /invalid or repeated tools\/list cursor/)
  assert.deepEqual(registered, [])
})

for (const serverName of ['unica', 'team']) {
  test(`the form editing skill resolves and calls the registered apply tool on ${serverName}`, async (t) => {
    const { root, gate, registered, start } = await setup(t)
    await rm(gate)
    await writeFile(join(root, 'form-tools'), '')
    await start(1500, serverName)
    const skill = await readFile(new URL('../dsh-unica-plugin/skills/unica-form-edit/SKILL.md', import.meta.url), 'utf8')
    assert.match(skill, /Skill tool: <имя из примера>/)
    const skillName = skill.match(/`(mcp__unica__unica_apply_[0-9a-f]+)`/)?.[1]
    assert.ok(skillName)
    const tool = registered.find(tool => tool.name === skillName || tool.description.split('\n').includes(`Skill tool: ${skillName}`))
    assert.ok(tool, `no registered tool for ${skillName}`)
    assert.ok(tool.name.startsWith(`mcp__${serverName}__`))
    assert.match(tool.description, /Plan or commit a change/)
    const reply = await tool.execute({}, { agent: { session: 'form-edit' } })
    assert.equal(reply.structuredContent.data.name, 'unica.apply')
  })
}

test('a failed session lookup never sends a call to the default project', async t => {
  let projected
  const defaultCwd = await mkdtemp(join(tmpdir(), 'unica-default-'))
  const workingDirectory = {
    ensure() { throw new Error('ensure unavailable') },
    get() {
      if (projected === undefined) throw new Error('projection unavailable')
      return projected
    },
  }
  const { gate, registered, root, start } = await setup(t, { workingDirectory, defaultCwd })
  t.after(() => rm(defaultCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  await rm(gate)
  await start(3000)
  const call = exec => registered[0].execute({}, exec).then(reply => reply.structuredContent.data)
  const session = { agent: { session: 'project-A' } }
  const before = await call({})
  assert.equal(before.calls, 1)
  await assert.rejects(call(session), /session working directory/i)

  projected = root
  const recovered = await call(session)
  assert.equal(recovered.workspaceRoot, root)
  assert.equal(recovered.calls, 1)

  const after = await call({})
  assert.equal(after.pid, before.pid)
  assert.equal(after.calls, 2)

  // A failed lookup followed by an empty projection is still a failure.
  projected = null
  await assert.rejects(call(session), /session working directory/i)
  workingDirectory.ensure = () => ''
  await assert.rejects(call(session), /session working directory/i)
  // The session explicitly has no project in either source.
  workingDirectory.ensure = () => undefined
  const unassigned = await call(session)
  assert.equal(unassigned.pid, before.pid)
  assert.equal(unassigned.calls, 3)
})

test('cancelling the session lookup prevents a fallback lookup', async t => {
  const controller = new AbortController()
  let fallbackCalls = 0
  const workingDirectory = {
    ensure() {
      controller.abort(new Error('session cancelled'))
      throw controller.signal.reason
    },
    get() { fallbackCalls++; return undefined },
  }
  const { gate, registered, start } = await setup(t, { workingDirectory })
  await rm(gate)
  await start(3000)
  await assert.rejects(registered[0].execute({}, { agent: { session: 'project-A' }, signal: controller.signal }),
    error => error === controller.signal.reason)
  assert.equal(fallbackCalls, 0)
})
