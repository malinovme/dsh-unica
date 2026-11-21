import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

const plugin = resolve(import.meta.dirname, '../dsh-unica-plugin')

function startRelay(t, script) {
  const proc = spawn(process.execPath, [resolve(plugin, 'bootstrap/launch.mjs'), plugin], {
    env: { ...process.env, UNICA_BRIDGE_TEXT_FALLBACK: '1', UNICA_WORKSPACE_ROOT: '',
      UNICA_LAUNCH_SELFTEST_COMMAND: JSON.stringify([process.execPath, '-e', script]) },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, killSignal: 'SIGKILL',
  })
  t.after(() => proc.kill('SIGKILL'))
  return { proc, closed: once(proc, 'close') }
}

test('the last MCP response is complete for immediate and delayed readers', async (t) => {
  const script = `
    const result = { content: [], structuredContent: { data: 'x'.repeat(2 * 1024 * 1024) } }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 12, result }) + '\\n', () => {
      console.error('server finished writing')
    })
  `
  const digests = []
  for (const delayed of [false, true]) {
    const { proc, closed } = startRelay(t, script)
    if (delayed) {
      await once(proc.stderr, 'data')
      await delay(1500)
      assert.equal(proc.exitCode, null, 'launcher exited before the client read the final response')
    }
    const chunks = []
    for await (const chunk of proc.stdout) chunks.push(chunk)
    assert.deepEqual(await closed, [0, null])
    const wire = Buffer.concat(chunks)
    assert.equal(wire.at(-1), 10)
    const frame = JSON.parse(wire)
    assert.equal(frame.id, 12)
    assert.equal(frame.result.structuredContent.data.length, 2 * 1024 * 1024)
    assert.deepEqual(JSON.parse(frame.result.content[0].text), frame.result.structuredContent)
    digests.push(createHash('sha256').update(wire).digest('hex'))
  }
  assert.equal(digests[0], digests[1])
})

test('a paused reader also slows a server sending many frames', async (t) => {
  const count = 256
  const line = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { text: 'x'.repeat(65_536) } }) + '\n'
  const script = `
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { text: 'x'.repeat(65536) } }) + '\\n'
    async function send() {
      console.error('begin')
      for (let i = 0; i < ${count}; i++) {
        if (!process.stdout.write(line)) await require('node:events').once(process.stdout, 'drain')
      }
      console.error('done')
    }
    send()
  `
  const { proc, closed } = startRelay(t, script)
  let progress = ''
  proc.stderr.setEncoding('utf8').on('data', chunk => { progress += chunk })
  await once(proc.stderr, 'data')
  await delay(1500)
  assert.doesNotMatch(progress, /done/, 'server completed 16 MiB of writes to a paused client')
  let bytes = 0
  for await (const chunk of proc.stdout) bytes += chunk.length
  assert.deepEqual(await closed, [0, null])
  assert.match(progress, /done/)
  assert.equal(bytes, Buffer.byteLength(line) * count)
})
