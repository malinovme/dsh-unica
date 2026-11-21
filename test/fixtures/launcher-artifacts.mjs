import childProcess from 'node:child_process'
import fs from 'node:fs'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

if (basename(process.argv[1] ?? '') === 'launch.mjs') {
  const { root, server, mode, deniedPath } = JSON.parse(process.env.UNICA_TEST_ARTIFACTS)
  // The real launcher verifies and unpacks the archive. Replace its dummy
  // executable with the portable MCP fixture when it is time to start it.
  const spawn = childProcess.spawn
  childProcess.spawn = (command, args, options) => basename(command) === 'fixture-runtime'
    ? spawn(process.execPath, [server], options)
    : spawn(command, args, options)
  if (mode === 'unreadable') {
    // Inject a permission error for one already-published engine on every OS.
    const stat = fs.statSync
    fs.statSync = (file, ...args) => {
      if (file === deniedPath) throw Object.assign(new Error('EACCES: cannot stat ' + file), { code: 'EACCES' })
      return stat(file, ...args)
    }
  }
  syncBuiltinESMExports()

  let engineAttempts = 0
  globalThis.fetch = async (url) => {
    if (url.endsWith('/core.tar.gz')) {
      if (existsSync('fail-core')) {
        writeFileSync('core-requested', '')
        while (!existsSync('release-failure')) await delay(10)
        return new Response(null, { status: 503 })
      }
      appendFileSync(join(root, 'core-attempts'), String(process.pid) + '\n')
      while (!existsSync(join(root, 'release-core'))) await delay(10)
      return new Response(readFileSync(join(root, 'core.tar.gz')))
    }

    appendFileSync(join(root, 'engine-attempts'), 'request\n')
    ++engineAttempts
    while (!existsSync(join(root, 'release-engine'))) await delay(10)
    if (mode === 'unavailable' || (mode === 'recover' && engineAttempts === 1)) {
      return new Response(null, { status: 503 })
    }
    return new Response(mode === 'corrupt' ? 'wrong bytes' : 'fixture engine')
  }
}
