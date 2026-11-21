import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
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

const standardPreset = [
  '- insert:', '    - id: preset-standard', '      config:', '        plugins:',
  '          - id: persona', '            config:', '              suffix: Your working directory is {{cwd}}.',
]

test('a failed native verification leaves both manual installation targets untouched', async t => {
  const home = await tempHome(t)
  const first = join(home, 'profiles/headless/cordis.patch.yml')
  const second = join(home, 'profiles/web/cordis.patch.yml')
  const original = Buffer.from('# User settings\r\n')
  await mkdir(dirname(first), { recursive: true })
  await writeFile(first, original)
  const standard = join(home, 'standard.yml')
  await writeFile(standard, standardPreset.join('\n'))
  // A regular file as the working directory makes the self-test fail before any network access.
  const result = spawnSync(process.execPath, [installer, '--dsh-home', home, '--target', 'both',
    '--standard', standard, '--verify', '--verify-cwd', standard], { encoding: 'utf8' })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout + result.stderr, /not a directory/i)
  assert.deepEqual(await readFile(first), original)
  assert.equal(existsSync(second), false)
})

test('LF and CRLF standard templates install the same preset without modifying the template', async t => {
  const home = await tempHome(t)
  const profile = join(home, 'profiles/web/cordis.patch.yml')
  const standard = join(home, 'standard.yml')
  let first
  for (const eol of ['\n', '\r\n']) {
    const source = standardPreset.join(eol) + eol
    await writeFile(standard, source)
    const result = spawnSync(process.execPath, [installer, '--dsh-home', home, '--target', 'preset',
      '--standard', standard], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const installed = await readFile(profile, 'utf8')
    assert.match(installed, /Unica rules for this session/)
    if (first !== undefined) assert.equal(installed, first)
    first = installed
    assert.equal(await readFile(standard, 'utf8'), source)
    await rm(profile)
  }
})

test('reinstall from a new plugin root retains distinct host and preset bridge settings', async t => {
  const home = await tempHome(t)
  const profile = join(home, 'profiles', 'shared', 'cordis.patch.yml')
  const standard = join(home, 'standard.yml')
  await writeFile(standard, [
    '- insert:', '    - id: preset-standard', '      config:', '        plugins:',
    '          - id: persona', '            config:', '              suffix: Your working directory is {{cwd}}.',
  ].join('\n'))
  const args = ['--target', 'both', '--profile', 'shared', '--dsh-home', home, '--standard', standard]
  const install = (script, cache) => {
    const run = spawnSync(process.execPath, [script, ...args, '--cache-dir', cache], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
  }
  const oldCache = join(home, 'old-cache')
  install(installer, oldCache)
  const initial = await readFile(profile, 'utf8')
  const settings = []
  const customized = initial.replace(/^( +)maxProcesses: 4$/gm, (_, indent) => {
    const n = settings.length + 1
    const block = [
      indent + 'maxProcesses: ' + n + '  # local limit',
      indent + 'coldStartTimeoutMs: ' + n * 15000,
      indent + 'startupTimeoutMs: ' + n * 10000,
      indent + 'artifactDelivery: off',
      indent + 'nodePath: !!js >-',
      indent + '  process.execPath',
    ].join('\n')
    settings.push(block)
    return block
  }).replace(/toolCallTimeoutMs: 600000/g, 'toolCallTimeoutMs: 45321')
    .replace(/idleMs: 600000/g, 'idleMs: 12345')
  assert.equal(settings.length, 2)
  await writeFile(profile, customized)
  const movedRoot = join(home, 'new-plugin')
  const newCache = join(home, 'new-cache')
  await cp(dirname(installer), movedRoot, { recursive: true })
  const movedInstaller = join(movedRoot, 'install.mjs')
  install(movedInstaller, newCache)
  const updated = await readFile(profile, 'utf8')
  for (const block of settings) {
    for (const line of block.split('\n')) assert.ok(updated.split('\n').includes(line), line)
  }
  assert.equal(updated.match(/toolCallTimeoutMs: 45321/g)?.length, 2)
  assert.equal(updated.match(/idleMs: 12345/g)?.length, 2)
  for (const field of ['pluginRoot: ' + JSON.stringify(movedRoot),
    'runtimeCacheDir: ' + JSON.stringify(join(newCache, 'runtimes')),
    'providerStateDir: ' + JSON.stringify(join(newCache, 'provider-state')),
    'name: ' + JSON.stringify(pathToFileURL(join(movedRoot, 'host/index.js')).href)]) {
    assert.equal(updated.split(field).length - 1, 2, field)
  }
  install(movedInstaller, newCache)
  assert.equal(await readFile(profile, 'utf8'), updated)
})

test('valued installer options reject a missing argument before writing', async t => {
  const home = await tempHome(t)
  for (const args of [['--profile', '--verify'], ['--standard'], ['--cache-dir='], ['--arch', '--dry-run']]) {
    const result = spawnSync(process.execPath, [installer, '--dsh-home', home, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.ok(result.stderr.includes(args[0].split('=')[0] + ' requires a value'), result.stderr)
    assert.deepEqual(await readdir(home), [])
  }
  for (const profile of [['--profile=shared'], ['--profile', 'shared']]) {
    const result = spawnSync(process.execPath, [installer, '--target', 'profile', '--dsh-home', home, ...profile], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(join(home, 'profiles/shared/cordis.patch.yml')))
  }
})
