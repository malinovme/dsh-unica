// Hold delivery until the test has received a tool response from the live core.
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

globalThis.fetch = async () => {
  while (!existsSync('release-engine-download')) await delay(10)
  return new Response(null, { status: 503 })
}
