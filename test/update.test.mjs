import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const repo = resolve(import.meta.dirname, '..')
const asset = 'dsh-plugin-unica.tar.gz'
const powershell = process.env.UNICA_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh')
const hasPowerShell = process.platform === 'win32' || !!process.env.UNICA_TEST_POWERSHELL ||
  spawnSync(powershell, ['-NoProfile', '-Command', 'exit 0']).status === 0
const oldProfile = '# Existing profile\n- id: user-settings\n'
const entrypoint = `
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const arg = (flag) => process.argv[process.argv.indexOf(flag) + 1]
const patch = join(arg('--dsh-home'), 'profiles', arg('--profile'), 'cordis.patch.yml')
mkdirSync(dirname(patch), { recursive: true })
writeFileSync(patch, dirname(fileURLToPath(import.meta.url)))
if (process.env.FIXTURE_HOLD) {
  writeFileSync(process.env.FIXTURE_HOLD, String(process.pid))
  setInterval(() => {}, 1000)
}
if (process.env.FIXTURE_FAIL === '1') process.exit(37)
`

for (const wrapper of ['sh', 'ps1']) {
  const skip = wrapper === 'sh' ? process.platform === 'win32' : !hasPowerShell
  test('release updates through install.' + wrapper, { skip }, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'unica-update-')))
    t.after(() => rm(root, { recursive: true, force: true }))
    const source = join(root, 'source')
    await mkdir(source)
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'dsh-plugin-unica' }))
    async function archive(name) {
      const file = join(root, name + '.tar.gz')
      execFileSync('tar', ['-czf', file, '-C', source, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
      return readFile(file)
    }
    const incomplete = await archive('missing-installer')
    await writeFile(join(source, 'install.mjs'), entrypoint)
    const release = await archive('release')
    let payload = release
    let invalidChecksum = false
    const server = createServer((req, res) => {
      if (req.url === '/' + asset) return res.end(payload)
      if (req.url === '/' + asset + '.sha256.json') {
        const sha256 = invalidChecksum ? '0'.repeat(64) : createHash('sha256').update(payload).digest('hex')
        return res.end(JSON.stringify({ sha256 }))
      }
      res.writeHead(404).end()
    })
    await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok))
    t.after(() => new Promise((ok) => server.close(ok)))
    const url = 'http://127.0.0.1:' + server.address().port
    for (const scenario of ['checksum-mismatch', 'corrupt', 'missing-installer', 'failed-upgrade', 'failed-first-install', 'success', 'unrelated-directory', 'update-in-progress', 'interrupted-after-backup', 'killed-updater', 'committed-update']) {
      await t.test(scenario, async () => {
        const dir = join(root, scenario)
        const install = join(dir, 'plugin with spaces')
        const home = join(dir, 'dsh home')
        const profile = join(home, 'profiles/web/cordis.patch.yml')
        const transaction = join(dir, '.' + basename(install) + '.update')
        if (scenario === 'update-in-progress') {
          await mkdir(transaction, { recursive: true })
          await writeFile(join(transaction, 'owner'), 'another updater')
        }
        await mkdir(dirname(profile), { recursive: true })
        if (scenario !== 'failed-first-install') {
          await writeFile(profile, oldProfile)
          await mkdir(install)
          await writeFile(join(install, 'old.txt'), 'old')
          if (scenario !== 'unrelated-directory') {
            await writeFile(join(install, 'install.mjs'), '// old installer')
            await writeFile(join(install, 'package.json'), JSON.stringify({ name: 'dsh-plugin-unica' }))
          }
        }
        payload = scenario === 'corrupt' ? Buffer.from('damaged archive') : scenario === 'missing-installer' ? incomplete : release
        invalidChecksum = scenario === 'checksum-mismatch'
        const env = { ...process.env, UNICA_BASE_URL: url, UNICA_INSTALL_DIR: install, UNICA_DSH_HOME: home,
          UNICA_PROFILE: 'web', UNICA_VERIFY: '0', FIXTURE_FAIL: scenario.startsWith('failed') ? '1' : '0' }
        const command = wrapper === 'sh' ? 'sh' : powershell
        const args = wrapper === 'sh' ? [join(repo, 'install.sh')] : [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'install.ps1'), '-BaseUrl', url, '-Version', 'local',
          '-Profile', 'web', '-DshHome', home, '-NoVerify',
        ]
        const retry = extra => run(command, args, { env: { ...env, ...extra }, timeout: 30_000 })
        if (scenario === 'killed-updater') {
          const hold = join(dir, 'fixture.pid')
          const interrupted = retry({ FIXTURE_HOLD: hold })
          const stopped = assert.rejects(interrupted)
          let pid
          try {
            for (let attempts = 0; attempts < 200 && !pid; attempts++) {
              pid = Number(await readFile(hold, 'utf8').catch(() => ''))
              if (!pid) await delay(50)
            }
            assert.ok(pid, 'candidate must have changed the profile')
            await assert.rejects(retry({}), /another updater/)
            const hostExited = new Promise(resolve => interrupted.child.once('exit', resolve))
            interrupted.child.kill('SIGKILL')
            await hostExited
            // The install.mjs child may outlive its shell. Its write access
            // must expire before rollback can start.
            await assert.rejects(retry({}), /another updater|still active/)
            assert.equal(await readFile(profile, 'utf8'), install)
          } finally {
            if (pid) { try { process.kill(pid, 'SIGKILL') } catch (err) { if (err.code !== 'ESRCH') throw err } }
            interrupted.child.kill('SIGKILL')
            await stopped
          }
          await rm(hold, { force: true })
        }
        if (scenario === 'interrupted-after-backup' || scenario === 'committed-update') {
          // Durable on-disk states immediately after the first rename, or
          // after committing a successful update but before cleanup.
          await mkdir(transaction)
          await writeFile(join(transaction, 'journal-v1'), profile)
          await writeFile(join(transaction, 'prepared'), '')
          await writeFile(join(transaction, 'profile'), oldProfile)
          await rename(install, join(transaction, 'previous'))
          if (scenario === 'interrupted-after-backup') {
            await mkdir(join(transaction, 'new'))
          } else {
            await mkdir(install)
            await writeFile(join(install, 'install.mjs'), entrypoint)
            await writeFile(join(install, 'package.json'), '{"name":"dsh-plugin-unica"}')
            await writeFile(profile, 'committed settings')
            await writeFile(join(transaction, 'committed'), '')
          }
        }
        if (['interrupted-after-backup', 'killed-updater', 'committed-update'].includes(scenario)) {
          // Fail the new update before publishing anything. This exposes the
          // state restored by recovery, including the previously edited profile.
          invalidChecksum = true
          await assert.rejects(retry({}), /checksum mismatch/i)
          invalidChecksum = false
          if (scenario === 'committed-update') {
            assert.equal(await readFile(profile, 'utf8'), 'committed settings')
            assert.equal(await readFile(join(install, 'install.mjs'), 'utf8'), entrypoint)
          } else {
            assert.equal(await readFile(profile, 'utf8'), oldProfile)
            assert.equal(await readFile(join(install, 'old.txt'), 'utf8'), 'old')
          }
          await assert.rejects(readdir(transaction), { code: 'ENOENT' })
          payload = release
          await retry({})
          assert.equal(await readFile(profile, 'utf8'), install)
          await assert.rejects(readdir(transaction), { code: 'ENOENT' })
          return
        }
        const update = run(command, args, { env, timeout: 30_000 })
        if (scenario === 'success') {
          await update
          assert.equal(await readFile(profile, 'utf8'), install)
          assert.equal(await readFile(join(install, 'install.mjs'), 'utf8'), entrypoint)
          await assert.rejects(readFile(join(install, 'old.txt')), { code: 'ENOENT' })
        } else {
          if (invalidChecksum) await assert.rejects(update, /checksum mismatch/i)
          else await assert.rejects(update, scenario.startsWith('failed') ? { code: 37 } : undefined)
          if (scenario === 'failed-first-install') {
            await assert.rejects(readdir(install), { code: 'ENOENT' })
            await assert.rejects(readFile(profile), { code: 'ENOENT' })
          } else {
            assert.equal(await readFile(join(install, 'old.txt'), 'utf8'), 'old')
            assert.equal(await readFile(profile, 'utf8'), oldProfile)
            if (scenario !== 'unrelated-directory') assert.equal(await readFile(join(install, 'install.mjs'), 'utf8'), '// old installer')
          }
        }
        const expected = scenario === 'failed-first-install' ? [basename(home)] : [basename(home), basename(install)]
        if (scenario === 'update-in-progress') {
          assert.equal(await readFile(join(transaction, 'owner'), 'utf8'), 'another updater')
          expected.push(basename(transaction))
        }
        expected.push(basename(transaction) + '.lock')
        assert.deepEqual((await readdir(dir)).sort(), expected.sort())
      })
    }
  })
}
