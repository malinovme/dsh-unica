import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'

const plugin = resolve(import.meta.dirname, '../dsh-unica-plugin')
const launcher = join(plugin, 'bootstrap/launch.mjs')

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'unica-test-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('reinstall preserves the user rows on both sides of Unica', (t) => {
  const home = tempDir(t)
  const patch = join(home, 'profiles/headless/cordis.patch.yml')
  mkdirSync(dirname(patch), { recursive: true })
  const before = '    - id: before\n      name: user-before\n      config: |\n        # Literal text'
  const after = '    # User configuration\n    - id: after\n      config:\n        paths:\n          - custom'
  const old = '    - id: unica-native\n# Old bridge configuration\n      name: old-bridge'
  writeFileSync(patch, ['- insert:', before, old, after, ''].join('\n').replaceAll('\n', '\r\n'))
  const install = () => execFileSync(process.execPath, [join(plugin, 'install.mjs'), '--dsh-home', home, '--target', 'profile'])
  install()
  const installed = readFileSync(patch, 'utf8')
  assert.ok(installed.includes([before, after].join('\n').replaceAll('\n', '\r\n')), 'both user rows and their settings survive')
  assert.doesNotMatch(installed, /old-bridge/)
  assert.equal(installed.match(/- id: unica-native\r?$/gm)?.length, 1)
  install()
  assert.equal(readFileSync(patch, 'utf8'), installed)
})

test('native bridge uses the session directory despite an inherited workspace pin', (t) => {
  const dir = tempDir(t)
  const cwd = join(dir, 'session')
  mkdirSync(cwd)
  const env = {
    ...process.env,
    UNICA_WORKSPACE_ROOT: dir,
    UNICA_LAUNCH_SELFTEST_COMMAND: JSON.stringify([process.execPath, join(import.meta.dirname, 'fixtures/workspace-server.mjs')]),
    UNICA_BRIDGE_TEXT_FALLBACK: '1',
  }
  const report = execFileSync(process.execPath, [join(plugin, 'host/selftest.js'), '--cwd', cwd], {
    env, encoding: 'utf8', timeout: 10_000, stdio: 'pipe',
  })
  assert.equal(JSON.parse(report).root, cwd)
})

test('a background engine HTTP failure leaves the cached core serving', async (t) => {
  const dir = tempDir(t)
  const cache = join(dir, 'cache')
  const target = process.platform === 'win32' ? 'win-x64' : `${process.platform}-${process.arch}`
  const coreDir = join(cache, 'unica', 'test--cached', target)
  mkdirSync(coreDir, { recursive: true })
  symlinkSync(dirname(process.execPath), join(coreDir, 'bin'), 'junction')
  writeFileSync(join(coreDir, '.ready.json'), '{}')
  const artifacts = {
    unica: { version: 'test', targets: { [target]: { asset: { sha256: 'cached' }, entrypoint: join('bin', basename(process.execPath)) } } },
    'v8-runner': { version: 'test', targets: { [target]: { asset: { name: 'engine.zip', url: 'https://example.invalid/engine', sha256: 'unused' } } } },
  }
  writeFileSync(join(dir, 'runtime-manifest.json'), JSON.stringify({ artifacts }))
  const mockFetch = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = async () => new Response(null, { status: 503 })')
  const child = spawn(process.execPath, ['--import', mockFetch, launcher, dir], {
    env: {
      ...process.env, UNICA_RUNTIME_CACHE_DIR: cache, UNICA_ARTIFACT_DELIVERY: 'background',
      UNICA_WORKSPACE_ROOT: dir, UNICA_LAUNCH_SELFTEST_COMMAND: '', UNICA_BRIDGE_TEXT_FALLBACK: '1',
    },
    timeout: 10_000,
  })
  let stderr = ''
  let stdout = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk
    // Ask the stand-in core to respond only after the failed download.
    if (!child.stdin.writableEnded && /HTTP 503/.test(stderr)) child.stdin.end('console.log("core answered")\n')
  })
  child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') throw error })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, stderr)
  assert.match(stderr, /v8-runner delivery failed: .*HTTP 503/)
  assert.equal(stdout.trim(), 'core answered')
  assert.deepEqual(readdirSync(cache), ['unica'])
})
