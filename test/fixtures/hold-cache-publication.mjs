// Loaded by the test launchers. Pause immediately before their first write
// to the final directory, whether the publisher removes it or renames into it.
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { existsSync } from 'node:fs'

const { UNICA_TEST_PUBLISH_DIR: destination } = process.env
async function hold(path) {
  if (path !== destination) return
  await fs.writeFile('waiting-to-publish', '')
  while (!existsSync('continue-publication')) await delay(20)
}

const { rename, rm } = fs
fs.rename = async (from, to) => {
  await hold(to)
  return rename(from, to)
}
fs.rm = async (path, options) => {
  await hold(path)
  return rm(path, options)
}
syncBuiltinESMExports()
