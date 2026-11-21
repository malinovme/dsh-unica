import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const repo = resolve(import.meta.dirname, '..')
const mirrors = 'https://mirror.invalid/assets'
const releases = 'https://github.com/malinovme/dsh-unica/releases/download/'
const asset = '/dsh-plugin-unica.tar.gz'

test('POSIX selects the explicit version, mirror or Latest independently of VERSION', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'unica-source-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const preload = join(dir, 'latest.mjs')
  await writeFile(preload, "globalThis.fetch = async () => { console.error('LOOKUP'); return {ok:true,json:async()=>({tag_name:'vLatest'})} }")
  await writeFile(join(dir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await writeFile(join(dir, 'curl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  for (const [version, mirror, url] of [['', '', releases + 'vLatest'], ['vPinned', '', releases + 'vPinned'], ['', mirrors, mirrors]]) {
    const result = spawnSync('sh', [join(repo, 'install.sh')], { encoding: 'utf8',
      env: { ...process.env, PATH: dir + delimiter + process.env.PATH, UNICA_DSH_HOME: dir, UNICA_INSTALL_DIR: join(dir, 'plugin'),
        VERSION: 'project-1.2.3', UNICA_VERSION: version, UNICA_BASE_URL: mirror, NODE_OPTIONS: '--import=' + pathToFileURL(preload).href } })
    assert.ok(result.stdout.includes(url + asset), result.stdout + result.stderr)
  }
})

test('PowerShell consults GitHub only when installing Latest without a mirror', { skip: process.platform !== 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'unica-source-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [options, url, lookup] of [
    ['', releases + 'vLatest', true], ['-Version vPinned', releases + 'vPinned', false], ['-BaseUrl ' + mirrors, mirrors, false],
  ]) {
    const script = [
      "function gh { [Console]::WriteLine('LOOKUP'); return 'vLatest' }",
      "function Invoke-RestMethod { throw 'unexpected API request' }",
      "function Invoke-WebRequest { param($Uri,$OutFile,[switch]$UseBasicParsing) throw ('download intercepted: ' + $Uri) }",
      "& $env:TEST_INSTALLER -DshHome $env:TEST_DSH_HOME -Profile web -NoVerify " + options,
    ].join('\n')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', env: { ...process.env, TEST_INSTALLER: join(repo, 'install.ps1'), TEST_DSH_HOME: dir, UNICA_INSTALL_DIR: join(dir, 'plugin') } })
    assert.ok(result.stdout.includes(url + asset), result.stdout + result.stderr)
    assert.equal(result.stdout.includes('LOOKUP'), lookup)
  }
})
