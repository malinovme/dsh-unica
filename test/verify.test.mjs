import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { resolveConfig } from '../dsh-unica-plugin/host/lib/config.js'
import { UnicaProc } from '../dsh-unica-plugin/host/lib/proc.js'
import { loadYaml } from '../dsh-unica-plugin/tools/lib/yaml.mjs'

const plugin = resolve(import.meta.dirname, '../dsh-unica-plugin')
const fixture = join(import.meta.dirname, 'fixtures/workspace-server.mjs')
const fakeServer = JSON.stringify([process.execPath, fixture])

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'unica-verify-test-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function run(script, args, env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, UNICA_LAUNCH_SELFTEST_COMMAND: fakeServer, ...env },
    encoding: 'utf8', timeout: 15_000,
  })
  if (result.error) throw result.error
  return result
}

test('cold install uses its cold-start deadline for initialize', (t) => {
  const home = tempDir(t)
  const preload = pathToFileURL(join(import.meta.dirname, 'fixtures/slow-initialize.mjs'))
  const result = run(join(plugin, 'install.mjs'), ['--dsh-home', home, '--target', 'profile', '--verify', '--verify-cwd', home], {
    NODE_OPTIONS: '--import=' + preload.href,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /ok +serverInfo workspace-fixture/)
})

test('manual verification uses each merged bridge config before publishing either target', t => {
  const home = tempDir(t)
  const standard = join(home, 'standard.yml')
  writeFileSync(standard, [
    '- insert:', '    - id: preset-standard', '      config:', '        plugins:',
    '          - id: persona', '            config:', '              suffix: Your working directory is {{cwd}}.',
  ].join('\n'))
  const args = ['--dsh-home', home, '--standard', standard, '--verify-cwd', home]
  const install = (...flags) => run(join(plugin, 'install.mjs'), [...args, ...flags])
  const initial = install('--target', 'preset')
  assert.equal(initial.status, 0, initial.stdout + initial.stderr)
  const preset = join(home, 'profiles/web/cordis.patch.yml')
  const standalone = join(home, 'profiles/headless/cordis.patch.yml')
  const original = readFileSync(preset, 'utf8')
  for (const [option, diagnostic] of [
    ['nodePath: ' + JSON.stringify(join(home, 'deleted-node')), /deleted-node.*ENOENT/i],
    ['maxProcesses: 0', /maxProcesses must be a positive integer/],
    ['nodePath: !!js process.execPath', /cannot verify dynamic !!js option nodePath/],
  ]) {
    const customized = original.replace('maxProcesses: 4', option)
    assert.notEqual(customized, original)
    writeFileSync(preset, customized)
    const checked = install('--target', 'both', '--verify')
    assert.notEqual(checked.status, 0)
    assert.match(checked.stdout + checked.stderr, diagnostic)
    assert.equal(readFileSync(preset, 'utf8'), customized)
    assert.equal(existsSync(standalone), false)
  }
  const valid = original.replace('maxProcesses: 4', 'nodePath: ' + JSON.stringify(process.execPath))
  writeFileSync(preset, valid)
  const checked = install('--target', 'both', '--verify')
  assert.equal(checked.status, 0, checked.stdout + checked.stderr)
  assert.ok(readFileSync(preset, 'utf8').includes('nodePath: ' + JSON.stringify(process.execPath)))
  assert.ok(existsSync(standalone))
})

test('manual verification rejects an explicit tool error but accepts a successful view without a root', t => {
  const home = tempDir(t)
  const patch = join(home, 'profiles/headless/cordis.patch.yml')
  const verify = env => run(join(plugin, 'install.mjs'),
    ['--dsh-home', home, '--target', 'profile', '--verify', '--verify-cwd', home], env)
  const failed = verify({ FIXTURE_VIEW_ERROR: 'fixture workspace unavailable' })
  assert.equal(failed.status, 1)
  assert.match(failed.stdout + failed.stderr, /unica.view failed: fixture workspace unavailable/)
  assert.equal(existsSync(patch), false)
  const ok = verify({ FIXTURE_NO_ROOT: '1' })
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  assert.match(ok.stdout, /reported no root/)
  assert.ok(existsSync(patch))
})

test('cancelled calls never reach the server and in-flight cancellations identify the request', async (t) => {
  const cwd = tempDir(t)
  const previous = process.env.UNICA_LAUNCH_SELFTEST_COMMAND
  process.env.UNICA_LAUNCH_SELFTEST_COMMAND = fakeServer
  const proc = new UnicaProc({ cwd, config: resolveConfig({ nodePath: process.execPath, toolCallTimeoutMs: 3000 }) })
  try {
    await proc.start()
    await assert.rejects(proc.callTool('never-send', {}, { signal: AbortSignal.abort() }), /cancel/i)
    const controller = new AbortController()
    const pending = proc.callTool('hold', {}, { signal: controller.signal })
    const snapshot = await proc.callTool('history', {})
    const held = snapshot.calls.find((call) => call.name === 'hold')
    assert.ok(held)
    assert.ok(!snapshot.calls.some((call) => call.name === 'never-send'))
    controller.abort()
    await assert.rejects(pending, /cancel/i)
    assert.deepEqual((await proc.callTool('history', {})).cancelled, [held.id])
    await assert.rejects(proc.callTool('hold', {}, { timeoutMs: 30 }), /timed out/)
    const history = await proc.callTool('history', {})
    assert.deepEqual(history.cancelled, history.calls.filter((call) => call.name === 'hold').map((call) => call.id))
  } finally {
    proc.close('test finished', { tree: true })
    if (previous === undefined) delete process.env.UNICA_LAUNCH_SELFTEST_COMMAND
    else process.env.UNICA_LAUNCH_SELFTEST_COMMAND = previous
  }
})

test('an invalid verify cwd does not relocate the selected cache', (t) => {
  const home = tempDir(t)
  const cache = join(home, 'chosen-cache')
  const result = run(join(plugin, 'install.mjs'), ['--target', 'profile', '--dsh-home', home,
    '--cache-dir', cache, '--verify', '--verify-cwd', join(home, 'missing')])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /not a directory/)
  assert.doesNotMatch(result.stdout, /testing .*runtimes/)
  assert.equal(existsSync(join(home, 'profiles/headless/cordis.patch.yml')), false)
})

test('relocation commits the fallback only after a successful retry', (t) => {
  const dir = tempDir(t)
  const copy = join(dir, 'plugin')
  cpSync(plugin, copy, { recursive: true })
  for (const retry of ['refused', 'ok']) {
    const home = join(dir, retry)
    const result = run(join(copy, 'install.mjs'), ['--target', 'profile', '--dsh-home', home, '--verify'], {
      FIXTURE_REFUSED_CACHE: join(home, 'unica/runtimes'), FIXTURE_RETRY: retry,
    })
    assert.equal(result.status, retry === 'ok' ? 0 : 1, result.stdout + result.stderr)
    const patch = join(home, 'profiles/headless/cordis.patch.yml')
    if (retry === 'refused') {
      assert.equal(existsSync(patch), false)
    } else {
      const rows = loadYaml([]).load(readFileSync(patch, 'utf8'))[0].insert
      assert.equal(rows[0].config.runtimeCacheDir, join(dir, '.unica-cache/runtimes'))
    }
  }
})

test('both profile targets round-trip apostrophes in every generated path', (t) => {
  const dir = tempDir(t)
  const copy = join(dir, "Unica's plugin")
  const home = join(dir, "O'Brien")
  cpSync(plugin, copy, { recursive: true })
  const standard = join(dir, 'standard.yml')
  writeFileSync(standard, [
    '- insert:', '    - id: preset-standard', '      config:', '        plugins:',
    '          - id: persona', '            config:', '              suffix: Your working directory is {{cwd}}.',
  ].join('\n'))
  const result = run(join(copy, 'install.mjs'), ['--dsh-home', home, '--target', 'both', '--standard', standard])
  assert.equal(result.status, 0, result.stderr)
  const yaml = loadYaml([])
  for (const profile of ['headless', 'web']) {
    const rows = yaml.load(readFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8'))[0].insert
    const [bridge, skills] = profile === 'web' ? rows[0].config.plugins.slice(-2) : rows
    assert.equal(bridge.name, pathToFileURL(join(copy, 'host/index.js')).href)
    assert.equal(bridge.config.pluginRoot, copy)
    assert.equal(bridge.config.runtimeCacheDir, join(home, 'unica/runtimes'))
    assert.equal(bridge.config.providerStateDir, join(home, 'unica/provider-state'))
    assert.deepEqual(skills.config.customSkillDirs, [join(copy, 'skills')])
  }
})

test('web verification requires its shipped registry and standard preset, and checks Unica rows in their own preset', (t) => {
  const home = tempDir(t)
  const profile = join(home, 'profiles/web')
  mkdirSync(profile, { recursive: true })
  // Give the real loader a profile with no bundles. Only the patch rows can appear.
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'fixture', dsh: { profile: { bundles: [] } } }))
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const children = [{ id: 'unica-native', name: 'fixture-bridge' }, { id: 'skill-filesystem-unica', name: 'fixture-skills' }]
  const preset = { id: 'preset-unica-1c', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'unica-1c', plugins: children } }
  const verify = (rows) => {
    writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]))
    return run(join(plugin, 'tools/verify-install.mjs'), [home, 'web'])
  }
  const missing = verify([preset])
  assert.equal(missing.status, 1, missing.stdout + missing.stderr)
  assert.match(missing.stdout + missing.stderr, /agent-preset-registry/)
  const registry = { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry' }
  const standard = { id: 'preset-standard', name: preset.name, config: { id: 'standard', plugins: children } }
  const noStandard = verify([registry, preset])
  assert.equal(noStandard.status, 1, noStandard.stdout + noStandard.stderr)
  assert.match(noStandard.stdout + noStandard.stderr, /preset-standard/)
  const misplaced = verify([registry, standard, { ...preset, config: { ...preset.config, plugins: [] } }])
  assert.equal(misplaced.status, 1, misplaced.stdout + misplaced.stderr)
  assert.match(misplaced.stdout + misplaced.stderr, /unica-native/)
})
