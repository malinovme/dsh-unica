import { existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

const calls = []
const cancelled = []
if (process.env.FIXTURE_REFUSED_CACHE) {
  if (process.env.UNICA_RUNTIME_CACHE_DIR === process.env.FIXTURE_REFUSED_CACHE) {
    console.error('open daemon provider state root: Access is denied (os error 5)')
    process.exit(1)
  }
  if (process.env.FIXTURE_RETRY === 'refused') process.exit(1)
}

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize' && existsSync('hold-initialize')) {
    writeFileSync('launcher-pid', String(process.ppid))
    writeFileSync('initialize-started', String(process.pid))
    while (existsSync('hold-initialize')) await delay(10)
  }
  if (method === 'notifications/cancelled') cancelled.push(params.requestId)
  if (method === 'tools/call') {
    calls.push({ id, name: params.name })
    if (params.name === 'hold') continue
    if (params.name === 'history') {
      console.log(JSON.stringify({ jsonrpc: '2.0', id, result: { calls, cancelled } }))
      continue
    }
  }
  if (id === undefined) continue
  const replies = {
    initialize: { serverInfo: { name: 'workspace-fixture' } },
    'tools/list': { tools: [{ name: 'unica.view' }] },
    'tools/call': { content: [], structuredContent: { data: { workspaceRoot: process.cwd(), pid: process.pid, launcherPid: process.ppid, calls: calls.length } } },
  }
  console.log(JSON.stringify({ jsonrpc: '2.0', id, result: replies[method] }))
}
