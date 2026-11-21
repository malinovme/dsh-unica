import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { editProfilePatch } from '../dsh-unica-plugin/installer/profile-patch.mjs'

for (const [style, eol, quote] of [['LF', '\n', "'"], ['CRLF', '\r\n', '"']]) {
  test(`reinstall preserves a quoted id annotation and neighboring ${style} user rows`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'unica-quoted-profile-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'profiles/headless/cordis.patch.yml')
    const install = (...flags) => execFileSync(process.execPath, [
      resolve(import.meta.dirname, '../dsh-unica-plugin/install.mjs'), '--dsh-home', dir, '--target', 'profile', ...flags,
    ])
    install()
    const userRows = [
      '    # Local project rules',
      '    - id: custom-bridge',
      '      disabled: !!js process.platform === "win32"',
      '      config:',
      '        instructions: |',
      '          - id: unica-native',
      '          # Literal model-visible text',
    ].join(eol)
    const id = '    - id: unica-native'
    const initial = (await readFile(path, 'utf8')).split(/\r?\n/).join(eol)
    const header = '- insert:  # local project'
    const customized = initial.replace('- insert:', header).replace(id + eol, userRows + eol + '    - id: ' + quote + 'unica-native' + quote + '  # project bridge' + eol)
    assert.notEqual(customized, initial)
    await writeFile(path, customized)
    install('--dry-run')
    assert.equal(await readFile(path, 'utf8'), customized)
    install()
    const updated = await readFile(path, 'utf8')
    assert.match(updated, /^    - id: unica-native +# project bridge\r?$/m)
    assert.equal(updated.match(/^    - id: ['"]?unica-native['"]?\b/gm)?.length, 1)
    assert.ok(updated.includes(header + eol + userRows + eol))
    assert.equal(updated.includes('\r\n'), style === 'CRLF')
    if (style === 'CRLF') assert.doesNotMatch(updated, /(?<!\r)\n/)
    install()
    assert.equal(await readFile(path, 'utf8'), updated)
  })
}

test('migration removes all quoted top-level duplicates and retired ids', () => {
  const edit = { block: '- id: unica-native\n  name: new-bridge', legacyIds: ['mcp-unica'] }
  const raw = [
    '- id: "unica-native" # preferred annotation',
    '  name: old-1',
    '  config:',
    '    note: |',
    '      # Literal text in the replaced value',
    "- id: 'unica-native' # another annotation",
    '  name: old-2',
    "- id: 'mcp-unica' # retired annotation",
    '  name: retired',
    '- insert:',
    '    - id: "mcp-unica"',
    '      name: retired',
    '      instructions: |',
    '        # Literal text in the retired value',
    '    - id: unica-native#different',
    '      instructions: |',
    '        Text with trailing spaces' + '  ',
  ].join('\n')
  const { content } = editProfilePatch(raw, edit)
  assert.match(content, /^    - id: unica-native +# preferred annotation$/m)
  assert.match(content, /^# another annotation$/m)
  assert.match(content, /^# retired annotation$/m)
  assert.doesNotMatch(content, /old-[12]|name: retired|id: ['"]?mcp-unica|Literal text/)
  assert.ok(content.includes('    - id: unica-native#different\n      instructions: |\n        Text with trailing spaces  \n'))
  assert.equal(editProfilePatch(content, edit).content, content)
})

test('removing the last child of a commented insert preserves its comment without an empty insert', () => {
  const raw = '- insert: # keep this explanation\n    - id: unica-native\n      name: old\n'
  const edit = { block: '- id: unica-native\n  name: new' }
  const { content } = editProfilePatch(raw, edit)
  assert.equal(content.match(/^- insert:/gm)?.length, 1)
  assert.match(content, /^# keep this explanation$/m)
  assert.equal(editProfilePatch(content, edit).content, content)
})

test('reinstallation resolves reordered ids at the item level and retains user options', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'unica-reordered-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const install = () => execFileSync(process.execPath, [resolve(import.meta.dirname, '../dsh-unica-plugin/install.mjs'),
    '--dsh-home', dir, '--target', 'profile'])
  install()
  const path = join(dir, 'profiles/headless/cordis.patch.yml')
  const initial = await readFile(path, 'utf8')
  const neighbor = '    - name: other\n      config:\n        id: unica-native\n      id: neighbor'
  const changed = initial.replace(/    - id: unica-native\r?\n      name: (.+)/,
    neighbor + '\n    - name: $1\n      id: unica-native  # my bridge').replace('maxProcesses: 4', 'maxProcesses: 2')
  assert.ok(changed.includes('# my bridge'))
  await writeFile(path, changed)
  install()
  const updated = await readFile(path, 'utf8')
  assert.equal(updated.match(/^(?:    - |      )id: unica-native\b/gm)?.length, 1)
  assert.match(updated, /maxProcesses: 2\b/)
  assert.ok(updated.includes(neighbor))
  assert.ok(updated.includes('# my bridge'))
  install()
  assert.equal(await readFile(path, 'utf8'), updated)
})
