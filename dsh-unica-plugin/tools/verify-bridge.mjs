// Verifies the launcher's text fallback: a successful tools/call whose payload
// lives only in `structuredContent` must reach a text-only client as text, while
// everything else must pass through byte for byte.
//
//   node tools/verify-bridge.mjs          # fake server conformance + live probe
//   node tools/verify-bridge.mjs --fake   # fake server only (no runtime needed)
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const launcher = join(pluginRoot, 'bootstrap', 'launch.mjs')
const fakeOnly = process.argv.includes('--fake')
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
    failures.push(name)
  }
}

/** Speaks newline-delimited JSON-RPC to a launcher child and collects responses. */
async function converse({ env, requests, timeoutMs = 120_000 }) {
  const child = spawn(process.execPath, [launcher, pluginRoot], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  const responses = []
  const awaited = new Set(requests.map((request) => request.id).filter((id) => id !== undefined))
  let pending = ''
  const done = new Promise((settle) => {
    const timer = setTimeout(() => settle(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      pending += chunk
      let newline
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.trim() === '') continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          message = { __unparsed: line }
        }
        responses.push(message)
        if (message.id !== undefined) awaited.delete(message.id)
      }
      if (awaited.size === 0) {
        clearTimeout(timer)
        settle(null)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => process.stderr.write(String(chunk)))
    child.on('error', (error) => {
      clearTimeout(timer)
      settle(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      settle(new Error(`launcher exited (code ${code}) before every response arrived`))
    })
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`)
  })
  const error = await done
  child.stdin.end()
  child.kill()
  if (error !== null && error !== undefined) throw error
  return responses
}

// --- fake server -----------------------------------------------------------
// Reproduces the 0.13 shape exactly: empty content + structured payload on
// success, text content on failure, and one unparsed noise line.
const scratch = await mkdtemp(join(tmpdir(), 'unica-bridge-'))
const fakeServer = join(scratch, 'fake-server.mjs')
await writeFile(
  fakeServer,
  `let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim() === '') continue
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
    if (request.method === 'initialize') {
      reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } })
    } else if (request.method === 'tools/call' && request.params.name === 'unica.ok') {
      reply({ content: [], structuredContent: { ok: true, data: { executionToken: 'tok-1', text: 'Кириллица', cwd: process.cwd() } }, isError: false })
    } else if (request.method === 'tools/call' && request.params.name === 'unica.bad') {
      reply({ content: [{ type: 'text', text: '{"summary":"refused"}' }], structuredContent: { ok: false }, isError: true })
    } else if (request.method === 'tools/call' && request.params.name === 'unica.empty') {
      reply({ content: [], isError: false })
    } else {
      reply({ content: [{ type: 'text', text: 'already textual' }], isError: false })
    }
  }
})
process.stdout.write('not json at all\\n')
`,
  'utf8',
)

const fakeRun = await converse({
  env: {
    UNICA_LAUNCH_SELFTEST_COMMAND: JSON.stringify([process.execPath, fakeServer]),
    UNICA_BRIDGE_TEXT_FALLBACK: '1',
  },
  requests: [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'unica.ok', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'unica.bad', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'unica.empty', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'unica.textual', arguments: {} } },
  ],
})

console.log('text fallback (fake server):')
const byId = new Map(fakeRun.filter((m) => m.id !== undefined).map((m) => [m.id, m]))
const okResult = byId.get(2)?.result
check(
  'structured-only success becomes one text block',
  Array.isArray(okResult?.content) && okResult.content.length === 1 && okResult.content[0].type === 'text',
)
check(
  'that text carries the structured payload, Cyrillic intact',
  typeof okResult?.content?.[0]?.text === 'string' &&
    okResult.content[0].text.includes('tok-1') &&
    okResult.content[0].text.includes('Кириллица'),
)
check('structuredContent is preserved untouched', okResult?.structuredContent?.ok === true)
check('isError flag is preserved', okResult?.isError === false)
const badResult = byId.get(3)?.result
check(
  'failure keeps its own text and gains no duplicate',
  Array.isArray(badResult?.content) && badResult.content.length === 1 && badResult.content[0].text.includes('refused'),
)
check('failure isError stays true', badResult?.isError === true)
const emptyResult = byId.get(4)?.result
check(
  'empty result without structuredContent is left empty',
  Array.isArray(emptyResult?.content) && emptyResult.content.length === 0,
)
check(
  'already-textual result is untouched',
  byId.get(5)?.result?.content?.[0]?.text === 'already textual',
)
check('initialize is untouched', byId.get(1)?.result?.serverInfo?.name === 'fake')

const rawRun = await converse({
  env: {
    UNICA_LAUNCH_SELFTEST_COMMAND: JSON.stringify([process.execPath, fakeServer]),
    UNICA_BRIDGE_TEXT_FALLBACK: '0',
  },
  requests: [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'unica.ok', arguments: {} } },
  ],
})
const rawOk = rawRun.find((m) => m.id === 2)?.result
check(
  'UNICA_BRIDGE_TEXT_FALLBACK=0 restores raw empty content',
  Array.isArray(rawOk?.content) && rawOk.content.length === 0 && rawOk.structuredContent?.ok === true,
)

if (fakeOnly) {
  await rm(scratch, { recursive: true, force: true })
  console.log(failures.length === 0 ? '\nbridge conformance: PASS' : `\nbridge conformance: FAIL (${failures.length})`)
  process.exit(failures.length === 0 ? 0 : 1)
}

// --- live runtime ----------------------------------------------------------
// A real unica server must now hand the model a visible answer for a call that
// used to arrive as "(... returned no model-visible content)".
const runtimeCache = process.env.UNICA_RUNTIME_CACHE_DIR ?? join(pluginRoot, '..', '.dsh-cache', 'runtimes')
const stateDir = process.env.UNICA_PROVIDER_STATE_DIR ?? join(pluginRoot, '..', '.dsh-cache', 'verify-state')
// The runtime expects its state root to exist; it does not create it.
await mkdir(resolve(stateDir), { recursive: true })

console.log('\ntext fallback (live runtime):')
const liveRun = await converse({
  env: {
    UNICA_RUNTIME_CACHE_DIR: resolve(runtimeCache),
    UNICA_PROVIDER_STATE_DIR: resolve(stateDir),
    UNICA_BRIDGE_TEXT_FALLBACK: '1',
  },
  requests: [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-bridge', version: '0' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'unica.view', arguments: {} } },
  ],
  timeoutMs: 600_000,
})
const liveResult = liveRun.find((m) => m.id === 2)?.result
const liveText = liveResult?.content?.[0]?.text ?? ''
check('live unica.view returns visible text', liveText.length > 0)
check('the text names the workspace root', liveText.includes('workspaceRoot') || liveText.includes('sourceSets'))
check('live structuredContent is still present', liveResult?.structuredContent !== undefined)

// The workspace pin is a launcher-level promise — the directory the server is
// started in — so it is checked against a fake child rather than the runtime,
// which resolves its own workspace (it climbs to the enclosing repository) and
// keeps a daemon whose lifecycle would make this check flaky.
console.log('\nworkspace pin:')
const pinDir = join(resolve(stateDir), 'pin-probe')
await rm(pinDir, { recursive: true, force: true }).catch(() => {})
await mkdir(pinDir, { recursive: true })
const pinnedRun = await converse({
  env: {
    UNICA_LAUNCH_SELFTEST_COMMAND: JSON.stringify([process.execPath, fakeServer]),
    UNICA_BRIDGE_TEXT_FALLBACK: '1',
    UNICA_WORKSPACE_ROOT: pinDir, // deliberately not the session workspace
  },
  requests: [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'unica.ok', arguments: {} } },
  ],
})
const pinnedCwd = String(pinnedRun.find((m) => m.id === 2)?.result?.structuredContent?.data?.cwd ?? '')
check(
  'UNICA_WORKSPACE_ROOT replaces the inherited launch directory',
  pinnedCwd.toLowerCase().replaceAll('/', '\\') === pinDir.toLowerCase(),
  `child cwd=${pinnedCwd}`,
)
await rm(pinDir, { recursive: true, force: true }).catch(() => {})

await rm(scratch, { recursive: true, force: true }).catch(() => {})
console.log(failures.length === 0 ? '\nall checks: PASS' : `\nall checks: FAIL (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
