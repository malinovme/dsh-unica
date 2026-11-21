import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, realpathSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

const calls = []
const cancelled = []
let serverRequest
function toolPage(cursor) {
  const first = { tools: [{ name: 'unica.view' }] }
  if (existsSync('form-tools')) first.tools.push({ name: 'unica.apply', description: 'Plan or commit a change.' })
  if (!existsSync('paginate-tools')) return first
  if (cursor === undefined) return { ...first, nextCursor: 'more' }
  if (cursor !== 'more') throw new Error('unexpected tools/list cursor: ' + cursor)
  const second = { tools: [{ name: 'unica.second' }] }
  if (existsSync('repeat-cursor')) second.nextCursor = 'more'
  return second
}

if (process.env.FIXTURE_REFUSED_CACHE) {
  if (process.env.UNICA_RUNTIME_CACHE_DIR === process.env.FIXTURE_REFUSED_CACHE) {
    console.error('open daemon provider state root: Access is denied (os error 5)')
    process.exit(1)
  }
  if (process.env.FIXTURE_RETRY === 'refused') process.exit(1)
}

for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line)
  const { id, method, params } = frame
  if (serverRequest && method === undefined) {
    serverRequest.replies.push(frame)
    if (serverRequest.replies.length === 2) {
      console.log(JSON.stringify({ jsonrpc: '2.0', id: serverRequest.id, result: serverRequest.replies }))
      serverRequest = undefined
    }
    continue
  }
  if (method === 'tools/list') {
    if (process.env.FIXTURE_CATALOG_TRACE) appendFileSync(process.env.FIXTURE_CATALOG_TRACE, realpathSync.native('.') + '\n')
    if (process.env.FIXTURE_REFUSED_PROBE_CWD === realpathSync.native('.')) {
      console.log(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'catalog unavailable in ' + process.cwd() } }))
      continue
    }
  }
  if (method === 'initialize' && existsSync('hold-initialize')) {
    writeFileSync('launcher-pid', String(process.ppid))
    writeFileSync('initialize-started', String(process.pid))
    while (existsSync('hold-initialize')) await delay(10)
  }
  if (method === 'notifications/cancelled') cancelled.push(params.requestId)
  if (method === 'tools/call') {
    calls.push({ id, name: params.name })
    if (params.name === 'hold-shutdown') {
      process.on('SIGTERM', () => writeFileSync('sigterm-received', ''))
      // Outlive stdin EOF to model a server stuck during shutdown.
      setTimeout(() => process.exit(1), 30_000)
      const daemon = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
      daemon.unref()
      const result = { pid: process.pid, launcherPid: process.ppid, daemonPid: daemon.pid }
      console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))
      continue
    }
    if (params.name === 'server-requests') {
      serverRequest = { id, replies: [] }
      console.log(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }))
      console.log(JSON.stringify({ jsonrpc: '2.0', id: 'unknown', method: 'unknown/method' }))
      console.log(JSON.stringify({ jsonrpc: '2.0', method: 'unknown/notification' }))
      continue
    }
    if (params.name === 'artifact-delivery') {
      console.log(JSON.stringify({ jsonrpc: '2.0', id, result: { structuredContent: { mode: process.env.UNICA_ARTIFACT_DELIVERY } } }))
      continue
    }
    if (params.name === 'unica.view' && process.env.FIXTURE_VIEW_REPLY) {
      console.log(JSON.stringify({ jsonrpc: '2.0', id, result: JSON.parse(process.env.FIXTURE_VIEW_REPLY) }))
      continue
    }
    if (params.name === 'unica.view' && process.env.FIXTURE_VIEW_ERROR) {
      const result = { isError: true, content: [{ type: 'text', text: process.env.FIXTURE_VIEW_ERROR }] }
      console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))
      continue
    }
    if (params.name === 'unica.view' && process.env.FIXTURE_NO_ROOT) {
      console.log(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '{}' }] } }))
      continue
    }
    if (params.name === 'hold') continue
    if (params.name === 'history') {
      console.log(JSON.stringify({ jsonrpc: '2.0', id, result: { calls, cancelled } }))
      continue
    }
  }
  if (id === undefined) continue
  const replies = {
    initialize: { serverInfo: { name: 'workspace-fixture' } },
    'tools/list': method === 'tools/list' && toolPage(params.cursor),
    'tools/call': { content: [], structuredContent: { data: { workspaceRoot: process.cwd(), pid: process.pid, launcherPid: process.ppid, calls: calls.length, name: params?.name } } },
  }
  console.log(JSON.stringify({ jsonrpc: '2.0', id, result: replies[method] }))
}
