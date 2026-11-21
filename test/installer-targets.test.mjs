import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const installer = resolve(import.meta.dirname, '../dsh-unica-plugin/install.mjs')
async function tempHome(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'unica install targets ')))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

test('the manual installer rejects unknown and missing targets before writing', async t => {
  const home = await tempHome(t)
  for (const args of [['--target', 'presett'], ['--target=presett'], ['--target'], ['--target='], ['--target', '--verify']]) {
    const result = spawnSync(process.execPath, [installer, '--dsh-home', home, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stderr, /--target.*preset.*profile.*both/)
    assert.deepEqual(await readdir(home), [])
  }
})

for (const existing of [false, true]) {
  test('both targets recover from a failed second rename with ' + (existing ? 'an existing' : 'a new') + ' first profile', async t => {
    const home = await tempHome(t)
    const first = join(home, 'profiles', 'headless', 'cordis.patch.yml')
    const second = join(home, 'profiles', 'web', 'cordis.patch.yml')
    const original = Buffer.from('# Пользовательская настройка\r\n')
    await mkdir(dirname(first), { recursive: true })
    await mkdir(second, { recursive: true })
    if (existing) await writeFile(first, original)
    const standard = join(home, 'standard.yml')
    await writeFile(standard, [
      '- insert:', '    - id: preset-standard', '      config:', '        plugins:',
      '          - id: persona', '            config:', '              suffix: Your working directory is {{cwd}}.',
    ].join('\n'))
    const preload = join(home, 'fail-second-rename.mjs')
    await writeFile(preload, `
      import fs from 'node:fs/promises'
      import { syncBuiltinESMExports } from 'node:module'
      const rename = fs.rename
      fs.rename = async (from, to) => {
        if (to === process.env.SECOND_PROFILE) {
          if (!(await fs.readFile(process.env.FIRST_PROFILE, 'utf8')).includes('- id: unica-native')) {
            throw new Error('first profile was not published')
          }
          throw new Error('second profile rename failed')
        }
        return rename(from, to)
      }
      syncBuiltinESMExports()
    `)
    const args = [installer, '--dsh-home', home, '--standard', standard, '--target', 'both']
    // A directory in place of the second patch must be caught during preparation.
    const invalid = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.equal(invalid.status, 1)
    assert.match(invalid.stderr, /expected a regular profile file/)
    if (existing) assert.deepEqual(await readFile(first), original)
    else assert.equal(existsSync(first), false)
    await rm(second, { recursive: true })
    await writeFile(second, original)
    const failed = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, ...args], {
      env: { ...process.env, FIRST_PROFILE: first, SECOND_PROFILE: second }, encoding: 'utf8',
    })
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /second profile rename failed/)
    assert.equal(existsSync(first), existing)
    if (existing) assert.deepEqual(await readFile(first), original)
    assert.deepEqual(await readFile(second), original)
    assert.deepEqual(await readdir(dirname(first)), existing ? ['cordis.patch.yml'] : [])
    assert.deepEqual(await readdir(dirname(second)), ['cordis.patch.yml'])
    const retry = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.equal(retry.status, 0, retry.stdout + retry.stderr)
    assert.match(await readFile(first, 'utf8'), /- id: unica-native/)
    assert.match(await readFile(second, 'utf8'), /- id: preset-unica-1c/)
  })
}
