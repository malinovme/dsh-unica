import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { editProfilePatch } from '../dsh-unica-plugin/installer/profile-patch.mjs'
import { updateProfileFile } from '../dsh-unica-plugin/installer/profile-file.mjs'

const edit = { block: '- id: unica-native\n  name: new-bridge', legacyIds: ['mcp-unica'] }

async function directory(t) {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'unica-profile-')))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

test('migration retains user comments, !!js expressions and CRLF on successive edits', () => {
  const user = [
    '# Project settings', '- id: custom', '  disabled: !!js process.platform === "win32"',
    '  config:', '    instructions: |', '      # Literal text', '      Keep both lines',
  ].join('\r\n')
  const original = '- id: mcp-unica\r\n  name: retired\r\n' + user + '\r\n'
  const { content, ids } = editProfilePatch(original, edit)
  assert.ok(content.includes(user))
  assert.doesNotMatch(content, /retired|mcp-unica|(?<!\r)\n/)
  assert.deepEqual(ids, ['unica-native'])
  assert.equal(editProfilePatch(content, edit).content, content)
})

test('replacing a profile preserves its mode and readers of the previous version', async (t) => {
  const path = join(await directory(t), 'cordis.patch.yml')
  const original = '- id: mine\n  name: kept\n'
  await fs.writeFile(path, original, { mode: 0o600 })
  const mode = (await fs.stat(path)).mode
  const reader = await fs.open(path)
  try {
    await updateProfileFile(path, [edit])
    assert.equal(await reader.readFile('utf8'), original)
  } finally {
    await reader.close()
  }
  assert.equal(await fs.readFile(path, 'utf8'), editProfilePatch(original, edit).content)
  const installed = await fs.stat(path)
  assert.equal(installed.mode, mode)
  await updateProfileFile(path, [edit])
  assert.equal((await fs.stat(path)).ino, installed.ino)
})

test('rename failure leaves the original profile and removes the staged file', async (t) => {
  const dir = await directory(t)
  const path = join(dir, 'cordis.patch.yml')
  const original = '# Original profile\n'
  await fs.writeFile(path, original)
  const expected = editProfilePatch(original, edit).content
  const rename = t.mock.method(fs, 'rename', async (from, to) => {
    assert.equal(dirname(from), dir)
    assert.equal(to, path)
    assert.equal(await fs.readFile(from, 'utf8'), expected)
    assert.equal(await fs.readFile(to, 'utf8'), original)
    throw new Error('simulated rename failure')
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(updateProfileFile(path, [edit]), /simulated rename failure/)
  } finally {
    rename.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(await fs.readFile(path, 'utf8'), original)
  assert.deepEqual(await fs.readdir(dir), ['cordis.patch.yml'])
})

test('dry-run and a failing second edit publish nothing', async (t) => {
  const dir = await directory(t)
  const path = join(dir, 'new-profile/cordis.patch.yml')
  assert.deepEqual((await updateProfileFile(path, [edit], { dryRun: true }))[0].ids, ['unica-native'])
  assert.deepEqual(await fs.readdir(dir), [])
  await assert.rejects(updateProfileFile(path, [edit, { block: 'invalid' }]), /top-level/)
  assert.deepEqual(await fs.readdir(dir), [])
})

test('an existing or dangling profile symlink keeps pointing at its managed file',
  { skip: process.platform === 'win32' && 'creating file symlinks can require elevation' }, async (t) => {
    const dir = await directory(t)
    const path = join(dir, 'cordis.patch.yml')
    await fs.symlink('managed.yml', path)
    for (const name of ['a', 'b']) {
      await updateProfileFile(path, [{ block: '- id: ' + name + '\n  name: plugin' }])
      assert.equal(await fs.readlink(path), 'managed.yml')
      assert.ok((await fs.readFile(join(dir, 'managed.yml'), 'utf8')).includes('- id: ' + name))
    }
  })

test('both targets sharing a profile are staged before either is published', async (t) => {
  const dir = await directory(t)
  const path = join(dir, 'profiles/shared/cordis.patch.yml')
  await fs.mkdir(dirname(path), { recursive: true })
  const original = '# Project profile\n'
  await fs.writeFile(path, original)
  const standard = join(dir, 'standard.yml')
  const args = [resolve(import.meta.dirname, '../dsh-unica-plugin/install.mjs'), '--target', 'both',
    '--profile', 'shared', '--dsh-home', dir, '--standard', standard]
  await fs.writeFile(standard, 'no preset here')
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), /standard composition/)
  assert.equal(await fs.readFile(path, 'utf8'), original)

  await fs.writeFile(standard, [
    '- insert:', '    - id: preset-standard', '      config:', '        plugins:',
    '          - id: persona', '            config:', '              suffix: Your working directory is {{cwd}}.',
  ].join('\n'))
  execFileSync(process.execPath, args)
  const installed = await fs.readFile(path, 'utf8')
  assert.match(installed, /^    - id: unica-native$/m)
  assert.match(installed, /^    - id: preset-unica-1c$/m)
  execFileSync(process.execPath, args)
  assert.equal(await fs.readFile(path, 'utf8'), installed)
})
