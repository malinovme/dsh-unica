import { spawn } from 'node:child_process'
import { join } from 'node:path'

const CLIENT_INFO = { name: 'dsh-unica-native', version: '0.1.0' }
const PROTOCOL_VERSION = '2025-06-18'

/**
 * One stdio MCP connection to unica, owned by a working directory.
 *
 * unica speaks newline-delimited JSON-RPC on stdin/stdout (no Content-Length
 * framing) and has no shutdown method, so closing is a signal.
 */
export class UnicaProc {
  #child
  #pending = new Map()
  #nextId = 1
  #buffer = ''
  #stderr = []
  #closing = false
  #closed = false

  constructor({ cwd, config, log }) {
    this.cwd = cwd
    this.config = config
    this.log = log
  }

  get alive() {
    return this.#child !== undefined && this.#child.exitCode === null && !this.#closed
  }

  async start(signal) {
    const launcher = join(this.config.pluginRoot, 'bootstrap', 'launch.mjs')
    const env = {
      ...process.env,
      UNICA_RUNTIME_CACHE_DIR: this.config.runtimeCacheDir,
      UNICA_PROVIDER_STATE_DIR: this.config.providerStateDir,
      UNICA_ARTIFACT_DELIVERY: this.config.artifactDelivery,
    }

    this.#child = spawn(this.config.nodePath, [launcher, this.config.pluginRoot], {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk) => this.#onData(chunk))
    this.#child.stderr.setEncoding('utf8')
    this.#child.stderr.on('data', (chunk) => {
      this.#stderr.push(chunk)
      if (this.#stderr.length > 50) this.#stderr.shift()
    })
    this.#child.on('error', (error) => this.#failAll(error))
    this.#child.on('exit', (code, signal) => {
      this.#closed = true
      this.#failAll(new Error(`unica process exited (code=${code}, signal=${signal})`))
    })

    const result = await this.request(
      'initialize',
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      { signal, timeoutMs: this.config.startupTimeoutMs },
    )
    this.notify('notifications/initialized', {})
    this.serverInfo = result?.serverInfo
    return result
  }

  async listTools(options) {
    const result = await this.request('tools/list', {}, options)
    const tools = Array.isArray(result?.tools) ? result.tools : []
    if (tools.length === 0) throw new Error('unica listed no tools')
    return tools
  }

  callTool(name, args, options) {
    return this.request('tools/call', { name, arguments: args ?? {} }, options)
  }

  request(method, params, { signal, timeoutMs = this.config.toolCallTimeoutMs } = {}) {
    if (!this.alive) return Promise.reject(new Error('unica process is not running'))
    const id = this.#nextId++
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settle(id, () => reject(new Error(`unica ${method} timed out after ${timeoutMs} ms`)))
      }, timeoutMs)
      const onAbort = () => {
        this.#settle(id, () => reject(new Error(`unica ${method} was canceled`)))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      this.#pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })

      this.#child.stdin.write(`${frame}\n`, (error) => {
        if (error) this.#settle(id, () => reject(error))
      })
    })
  }

  notify(method, params) {
    if (!this.alive) return
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /** Stop the process; pending calls fail with the reason. */
  close(reason = 'unica process closed') {
    if (this.#closing) return
    this.#closing = true
    this.#failAll(new Error(reason))
    const child = this.#child
    if (child === undefined || child.exitCode !== null) return
    child.kill('SIGTERM')
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 2000)
    killTimer.unref?.()
  }

  stderrTail() {
    return this.#stderr.join('').trim()
  }

  #onData(chunk) {
    this.#buffer += chunk
    for (;;) {
      const newline = this.#buffer.indexOf('\n')
      if (newline === -1) break
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line.length === 0) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.log?.warn?.(`unica-native: unparsable frame from unica: ${line.slice(0, 200)}`)
        continue
      }
      if (message.id === undefined) continue
      const pending = this.#pending.get(message.id)
      if (pending === undefined) continue
      this.#pending.delete(message.id)
      if (message.error !== undefined) {
        pending.reject(new Error(`${pending.method}: ${message.error.message ?? JSON.stringify(message.error)}`))
      } else {
        pending.resolve(message.result)
      }
    }
  }

  #settle(id, action) {
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#pending.delete(id)
    action()
  }

  #failAll(error) {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const call of pending) call.reject(error)
  }
}
