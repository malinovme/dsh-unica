// Exercise the real DSH registry, agent, working directory and native executor.
// Only the stdio MCP peer is a fixture; no model credentials or 1C installation are needed.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as bridge from '../dsh-unica-plugin/host/index.js'

assert.ok(process.env.DSH_INSTALL_ROOT, 'set DSH_INSTALL_ROOT to the isolated npm prefix')
const prefix = resolve(process.env.DSH_INSTALL_ROOT)
const require = createRequire(join(prefix, 'package.json'))
const pkg = JSON.parse(await readFile(join(prefix, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
assert.equal(pkg.version, '0.2.2-rc.1')

async function load(name) {
  return import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href)
}
const { Context } = await load('cordis')
const ctx = new Context()
const root = await realpath(await mkdtemp(join(tmpdir(), 'unica-min-dsh-')))
const cwd = join(root, 'session workspace')
const toolMap = JSON.parse(await readFile(new URL('../dsh-unica-plugin/tool-map.json', import.meta.url), 'utf8'))
try {
  await mkdir(cwd)
  process.env.UNICA_LAUNCH_SELFTEST_COMMAND = JSON.stringify([process.execPath, join(import.meta.dirname, '../test/fixtures/workspace-server.mjs')])
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-fs-local', 'dsh-system-prompt', 'dsh-tools',
    'dsh-working-directory', 'dsh-llm', 'dsh-agent', 'dsh-agent-loop', 'dsh-tool-executor-native']) {
    const module = await load(name)
    await ctx.plugin(module.default ?? module, {})
  }
  await ctx.plugin(bridge, { nodePath: process.execPath, probeCwd: root,
    runtimeCacheDir: join(root, 'cache'), providerStateDir: join(root, 'state'), startupTimeoutMs: 10_000 })
  const handle = await ctx.agents.create({ sessionId: 'compatibility', meta: { cwd } })
  try {
    const name = toolMap['unica.view']
    assert.ok(ctx.tools.get(name, handle.agent), 'unica.view must be visible in the DSH agent registry')
    assert.equal(await ctx.workingDirectory.ensure(handle.agent), cwd)
    const { results } = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: 'view', name, arguments: '{}' }],
      agent: handle.agent, signal: AbortSignal.timeout(15_000),
    })
    assert.equal(results.length, 1)
    const [{ result }] = results
    assert.equal(result.isError, false, JSON.stringify(result.error))
    assert.equal(result.value.structuredContent.data.workspaceRoot, cwd)
    assert.equal(JSON.parse(result.content[0].text).data.workspaceRoot, cwd)
    console.log(`DSH ${pkg.version}: native executor called ${name} in its session workspace`)
  } finally {
    await handle.dispose()
  }
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
}
