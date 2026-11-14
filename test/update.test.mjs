import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const arg = (flag) => process.argv[process.argv.indexOf(flag) + 1]
const patch = join(arg('--dsh-home'), 'profiles', arg('--profile'), 'cordis.patch.yml')
mkdirSync(dirname(patch), { recursive: true })
writeFileSync(patch, dirname(fileURLToPath(import.meta.url)))
if (process.env.FIXTURE_HOLD) {
  writeFileSync(process.env.FIXTURE_HOLD, String(process.pid))
  const timer = setInterval(() => { if (existsSync(process.env.FIXTURE_HOLD + '.finish')) clearInterval(timer) }, 25)
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
    const editedProfile = oldProfile + '# settings edited during update\n'
    const scenarios = [
      'checksum-mismatch', 'corrupt', 'missing-installer', 'failed-upgrade', 'failed-first-install',
      'first-install', 'success', 'unrelated-directory', 'update-in-progress', 'interrupted-after-backup',
      'killed-updater', 'committed-update', 'edited-during-update', 'interrupted-publication',
      'legacy-profile-conflict', wrapper === 'ps1' ? 'reused-pid' : 'claim-collision',
    ]
    if (wrapper === 'ps1' && process.platform === 'win32') scenarios.push('busy-previous-at-commit')
    for (const scenario of scenarios) {
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
        await mkdir(dir, { recursive: true })
        if (!['first-install', 'failed-first-install'].includes(scenario)) {
          await mkdir(dirname(profile), { recursive: true })
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
        if (scenario === 'busy-previous-at-commit') {
          const hold = join(dir, 'installer-ready')
          const ready = join(dir, 'backup-open')
          const update = retry({ FIXTURE_HOLD: hold })
          // Hold a real Windows handle without delete sharing until cleanup
          // has started, as can happen when another process reads the backup.
          const reader = run(powershell, ['-NoProfile', '-Command', `
            $ErrorActionPreference = 'Stop'
            while (-not [IO.File]::Exists($env:INSTALLER_READY)) { Start-Sleep -Milliseconds 25 }
            $file = [IO.File]::OpenRead((Join-Path $env:TRANSACTION 'previous/old.txt'))
            try {
              [IO.File]::WriteAllText($env:BACKUP_OPEN, '')
              [IO.File]::WriteAllText("$env:INSTALLER_READY.finish", '')
              while (-not [IO.File]::Exists((Join-Path $env:TRANSACTION 'committed'))) { Start-Sleep -Milliseconds 25 }
              Start-Sleep -Milliseconds 900
            } finally { $file.Dispose() }
          `], { env: { ...env, INSTALLER_READY: hold, BACKUP_OPEN: ready, TRANSACTION: transaction }, timeout: 20_000 })
          try {
            await Promise.all([reader, update])
          } finally {
            reader.child.kill()
            update.child.kill()
          }
          assert.equal(await readFile(ready, 'utf8'), '')
          assert.equal(await readFile(profile, 'utf8'), install)
          assert.equal(await readFile(join(install, 'install.mjs'), 'utf8'), entrypoint)
          assert.deepEqual((await readdir(dir)).filter(name => name === basename(transaction) || name.startsWith('.unica-finished-')), [])
          return
        }
        if (scenario === 'claim-collision') {
          // A legacy updater can claim even an empty directory while we download.
          const claim = () => { mkdirSync(transaction); server.off('request', claim) }
          server.prependListener('request', claim)
          await assert.rejects(retry({}), /cannot claim transaction/)
          assert.deepEqual(await readdir(transaction), [])
          assert.equal(await readFile(profile, 'utf8'), oldProfile)
          return
        }
        if (scenario === 'killed-updater' || scenario === 'edited-during-update') {
          const hold = join(dir, 'fixture.pid')
          const interrupted = retry({ FIXTURE_HOLD: hold })
          const stopped = scenario === 'edited-during-update' ? assert.rejects(interrupted, /profile changed during update/) : assert.rejects(interrupted)
          let pid
          try {
            for (let attempts = 0; attempts < 200 && !pid; attempts++) {
              pid = Number(await readFile(hold, 'utf8').catch(() => ''))
              if (!pid) await delay(50)
            }
            assert.ok(pid, 'candidate must have written its draft')
            assert.equal(await readFile(profile, 'utf8'), oldProfile)
            if (scenario === 'edited-during-update') {
              await writeFile(profile, editedProfile)
              await writeFile(hold + '.finish', '')
              await stopped
              assert.equal(await readFile(profile, 'utf8'), editedProfile)
              assert.equal(await readFile(join(install, 'old.txt'), 'utf8'), 'old')
              return
            }
            await assert.rejects(retry({}), /another updater/)
            const hostExited = new Promise(resolve => interrupted.child.once('exit', resolve))
            interrupted.child.kill('SIGKILL')
            await hostExited
            // The install.mjs child may outlive its shell. Its write access
            // must expire before rollback can start.
            await assert.rejects(retry({}), /another updater|still active/)
            assert.equal(await readFile(profile, 'utf8'), oldProfile)
            await writeFile(profile, editedProfile)
          } finally {
            if (pid && scenario === 'killed-updater') { try { process.kill(pid, 'SIGKILL') } catch (err) { if (err.code !== 'ESRCH') throw err } }
            interrupted.child.kill('SIGKILL')
            await stopped
          }
          await rm(hold, { force: true })
        }
        if (['interrupted-after-backup', 'committed-update', 'reused-pid', 'interrupted-publication', 'legacy-profile-conflict'].includes(scenario)) {
          // Durable on-disk states immediately after the first rename, or
          // after committing a successful update but before cleanup.
          await mkdir(transaction)
          await writeFile(join(transaction, scenario === 'interrupted-publication' ? 'journal-v2' : 'journal-v1'), profile)
          await writeFile(join(transaction, 'prepared'), '')
          await writeFile(join(transaction, 'profile'), oldProfile)
          await rename(install, join(transaction, 'previous'))
          if (scenario === 'interrupted-after-backup' || scenario === 'reused-pid') {
            await mkdir(join(transaction, 'new'))
            await writeFile(profile, editedProfile)
            if (scenario === 'reused-pid') {
              const pidFile = join(transaction, 'old.ticket.pid')
              await writeFile(pidFile, String(process.pid))
              await utimes(pidFile, new Date(0), new Date(0))
            }
          } else if (scenario === 'legacy-profile-conflict') {
            await mkdir(install)
            await writeFile(profile, editedProfile)
          } else if (scenario === 'interrupted-publication') {
            const draftDir = wrapper === 'ps1' ? join(dirname(profile), '.unica-profile-' + 'a'.repeat(32)) : join(transaction, 'draft')
            await mkdir(draftDir)
            await writeFile(join(draftDir, 'cordis.patch.yml'), 'verified settings')
            if (wrapper === 'ps1') await writeFile(join(transaction, 'draft-name'), basename(draftDir))
            await writeFile(join(transaction, 'publishing-profile'), '')
            await mkdir(install)
            await writeFile(join(install, 'install.mjs'), entrypoint)
            await writeFile(join(install, 'package.json'), '{"name":"dsh-plugin-unica"}')
          } else {
            await mkdir(install)
            await writeFile(join(install, 'install.mjs'), entrypoint)
            await writeFile(join(install, 'package.json'), '{"name":"dsh-plugin-unica"}')
            await writeFile(profile, 'committed settings')
            await writeFile(join(transaction, 'committed'), '')
          }
        }
        if (['interrupted-after-backup', 'killed-updater', 'committed-update', 'reused-pid', 'interrupted-publication', 'legacy-profile-conflict'].includes(scenario)) {
          // Fail the new update before publishing anything. This exposes the
          // state restored by recovery, including the previously edited profile.
          invalidChecksum = true
          await assert.rejects(retry({}), /checksum mismatch/i)
          invalidChecksum = false
          if (scenario === 'committed-update' || scenario === 'interrupted-publication') {
            assert.equal(await readFile(profile, 'utf8'), scenario === 'committed-update' ? 'committed settings' : 'verified settings')
            assert.equal(await readFile(join(install, 'install.mjs'), 'utf8'), entrypoint)
          } else {
            assert.equal(await readFile(profile, 'utf8'), editedProfile)
            assert.equal(await readFile(join(install, 'old.txt'), 'utf8'), 'old')
          }
          await assert.rejects(readdir(transaction), { code: 'ENOENT' })
          if (scenario === 'legacy-profile-conflict') {
            const copies = (await readdir(dir)).filter(name => name.startsWith('.unica-profile-backup'))
            assert.equal(copies.length, 1)
            assert.equal(await readFile(join(dir, copies[0], 'cordis.patch.yml'), 'utf8'), oldProfile)
          }
          payload = release
          await retry({})
          assert.equal(await readFile(profile, 'utf8'), install)
          await assert.rejects(readdir(transaction), { code: 'ENOENT' })
          return
        }
        const update = run(command, args, { env, timeout: 30_000 })
        if (scenario === 'success' || scenario === 'first-install') {
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
        const expected = scenario === 'failed-first-install' ? (wrapper === 'ps1' ? [basename(home)] : []) : [basename(home), basename(install)]
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
