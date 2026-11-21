import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

test('packaging requires the artifact delivery module', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'unica-package-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const plugin = join(dir, 'plugin')
  await cp(resolve(import.meta.dirname, '../dsh-unica-plugin'), plugin, { recursive: true })
  const build = archive => spawnSync(process.execPath, [join(plugin, 'package.mjs'), '--out', archive], { encoding: 'utf8' })

  const required = 'bootstrap/artifact-delivery.mjs'
  const complete = join(dir, 'complete.tar.gz')
  const success = build(complete)
  assert.equal(success.status, 0, success.stderr)
  const manifest = JSON.parse(await readFile(complete + '.sha256.json', 'utf8'))
  assert.ok(manifest.contents.includes(required))

  await rm(join(plugin, required))
  const incomplete = join(dir, 'incomplete.tar.gz')
  const failure = build(incomplete)
  assert.equal(failure.status, 1, failure.stdout + failure.stderr)
  assert.match(failure.stderr, /refusing to package: bootstrap\/artifact-delivery\.mjs is missing/)
  for (const path of [incomplete, incomplete + '.sha256.json']) {
    await assert.rejects(readFile(path), { code: 'ENOENT' })
  }
})
