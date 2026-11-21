import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

test('rebuilding inside the source excludes previous outputs and preserves a verified release on failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'unica-package-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const plugin = join(dir, 'plugin')
  await cp(resolve(import.meta.dirname, '../dsh-unica-plugin'), plugin, { recursive: true })
  const archive = join(plugin, 'dist/plugin.tar.gz')
  const checksum = archive + '.sha256.json'
  const build = () => spawnSync(process.execPath, ['package.mjs', '--out', archive], { cwd: plugin, encoding: 'utf8' })
  for (let i = 0; i < 2; i++) {
    const result = build()
    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(await readFile(checksum))
    const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    assert.equal(list.status, 0, list.stderr)
    assert.deepEqual(list.stdout.trim().split(/\r?\n/), manifest.contents)
    assert.ok(!manifest.contents.some(file => file.startsWith('dist/')))
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), manifest.sha256)
  }
  const previous = await Promise.all([readFile(archive), readFile(checksum)])
  // Manifest generation fails after tar has already produced and verified the candidate.
  await writeFile(join(plugin, 'package.json'), '{invalid')
  assert.notEqual(build().status, 0)
  assert.deepEqual(await Promise.all([readFile(archive), readFile(checksum)]), previous)
})
