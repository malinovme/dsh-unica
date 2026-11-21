import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveConfig } from '../dsh-unica-plugin/host/lib/config.js'
import { ProcPool } from '../dsh-unica-plugin/host/lib/pool.js'
import { UnicaProc } from '../dsh-unica-plugin/host/lib/proc.js'

test('a startup failure reaches the DSH pool log with a bounded stderr tail', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'unica-startup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'provider-state')
  const diagnostic = 'Access denied opening ' + path
  const script = `process.stdin.once('data', () => {
    const log = 'old diagnostic\\n' + 'x'.repeat(8000) + '\\n' + process.argv[1]
    process.stderr.write(log, () => process.exit(1))
  })`
  const previous = process.env.UNICA_LAUNCH_SELFTEST_COMMAND
  process.env.UNICA_LAUNCH_SELFTEST_COMMAND = JSON.stringify([process.execPath, '-e', script, diagnostic])
  t.after(() => {
    if (previous === undefined) delete process.env.UNICA_LAUNCH_SELFTEST_COMMAND
    else process.env.UNICA_LAUNCH_SELFTEST_COMMAND = previous
  })
  const errors = []
  const pool = new ProcPool(resolveConfig({ nodePath: process.execPath }), { error: text => errors.push(text) })
  t.after(() => pool.closeAll())
  await assert.rejects(pool.withProc(root, () => assert.fail('worker started')), error =>
    error.message.includes('code=1') && error.message.includes(diagnostic))
  assert.equal(errors.length, 1)
  assert.ok(errors[0].includes(diagnostic))
  assert.ok(!errors[0].includes('old diagnostic'))
  assert.ok(errors[0].length < 5000)
})

for (const corrupt of [false, true]) {
  test('recover cached core execute permission with ' + (corrupt ? 'incorrect' : 'matching') + ' digest',
    { skip: process.platform === 'win32' }, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'unica-core-mode-'))
      t.after(() => rm(root, { recursive: true, force: true }))
      const config = resolveConfig({ pluginRoot: root, runtimeCacheDir: join(root, 'cache'),
        providerStateDir: join(root, 'state'), artifactDelivery: 'off', nodePath: process.execPath })
      const script = '#!/usr/bin/env node\nimport ' + JSON.stringify(new URL('./fixtures/workspace-server.mjs', import.meta.url).href) + '\n'
      const digest = createHash('sha256').update(script).digest('hex')
      const target = process.platform + '-' + process.arch
      const entrypoint = 'test-core.mjs'
      const descriptor = { asset: { sha256: digest }, entrypoint, files: [{ path: entrypoint, sha256: digest, executable: true }] }
      const coreDir = join(config.runtimeCacheDir, 'unica', 'test--' + digest, target)
      await mkdir(coreDir, { recursive: true })
      await mkdir(join(root, 'bootstrap'))
      await copyFile(new URL('../dsh-unica-plugin/bootstrap/launch.mjs', import.meta.url), join(root, 'bootstrap/launch.mjs'))
      await writeFile(join(root, 'runtime-manifest.json'), JSON.stringify({ artifacts: { unica: { version: 'test', targets: { [target]: descriptor } } } }))
      await writeFile(join(coreDir, '.ready.json'), '{}')
      const core = join(coreDir, entrypoint)
      await writeFile(core, corrupt ? script + '// modified' : script)
      await chmod(core, 0o640)
      const proc = new UnicaProc({ cwd: root, config })
      t.after(() => proc.close())
      if (corrupt) {
        await assert.rejects(proc.start(), error => error.message.includes('checksum mismatch') && error.message.includes(core))
        assert.equal((await stat(core)).mode & 0o777, 0o640)
      } else {
        await proc.start()
        assert.equal(proc.serverInfo.name, 'workspace-fixture')
        assert.equal((await stat(core)).mode & 0o777, 0o740)
      }
    })
}
