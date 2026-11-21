import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogCwd, loadCatalog, retryCatalog } from './lib/catalog.js'
import { resolveConfig } from './lib/config.js'
import { DEFAULT_SERVER_NAME, publicToolName } from './lib/naming.js'
import { ProcPool, canonicalCwd } from './lib/pool.js'
import { normalizeResult } from './lib/render.js'

export const name = 'unica-native'
export const inject = ['tools', 'workingDirectory']

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PLUGIN_ROOT = resolve(here, '..')

function makeLogger(ctx) {
  const logger = ctx.logger
  const write = (level, message) => {
    console.error(message)
    if (typeof logger?.[level] === 'function') logger[level](message)
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}

/**
 * Resolve the working directory for one call.
 *
 * The agent carries the session, and the session projection carries the current
 * directory — the same source `bash` uses. `ensure` validates that the directory
 * still exists; `get` is the fallback when validation loses a race.
 */
async function resolveCwd(ctx, exec, config, log) {
  const { agent, signal } = exec
  signal?.throwIfAborted()
  if (agent == null) return config.defaultCwd ?? undefined
  let unassigned = false
  const sessionPath = value => typeof value === 'string' && isAbsolute(value) ? canonicalCwd(value) : undefined
  try {
    const ensured = await ctx.workingDirectory.ensure(agent, signal)
    unassigned = ensured == null
    const path = sessionPath(ensured)
    if (path) return path
  } catch (error) {
    signal?.throwIfAborted()
    log.warn(`unica-native: workingDirectory.ensure failed: ${error?.message ?? String(error)}`)
  }
  signal?.throwIfAborted()
  try {
    const current = ctx.workingDirectory.get(agent.session)
    const path = sessionPath(current)
    if (path) return path
    if (unassigned && current == null) return config.defaultCwd ?? undefined
  } catch (error) {
    throw new Error(`unica-native: cannot determine session working directory: ${error?.message ?? String(error)}`, { cause: error })
  }
  throw new Error('unica-native: cannot determine session working directory')
}

function createToolDefinition({ tool, publicName, ctx, config, pool, log }) {
  const rawName = tool.name
  const description = typeof tool.description === 'string' ? tool.description : `unica ${rawName}`
  // The bundled skills use the default DSH names. Expose the exact lookup key
  // in the live catalog when this bridge has a different namespace.
  const skillName = publicToolName(DEFAULT_SERVER_NAME, rawName)
  return {
    name: publicName,
    description: publicName === skillName ? description : `Skill tool: ${skillName}\n${description}`,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: {} },
          structuredContent: {},
        },
        required: ['content'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: normalizeResult(value).text }],
    },
    async execute(args, exec = {}) {
      const cwd = await resolveCwd(ctx, exec, config, log)
      if (cwd === undefined) {
        throw new Error('unica-native: the session has no working directory and defaultCwd is not configured')
      }
      const result = await pool.withProc(
        cwd,
        (proc) => proc.callTool(rawName, args, { signal: exec.signal, timeoutMs: config.toolCallTimeoutMs }),
        exec.signal,
      )
      const { value, text } = normalizeResult(result)
      if (result?.isError === true) throw new Error(text.length > 0 ? text : `unica ${rawName} failed`)
      return value
    },
  }
}

/**
 * Activation: learn the tool schemas once, then register the same tool names the
 * MCP row exposes. Calls resolve their workspace per invocation, so one profile
 * can serve any number of sessions in different directories.
 */
export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig, { pluginRoot: DEFAULT_PLUGIN_ROOT })
  const log = makeLogger(ctx)
  const pool = new ProcPool(config, log)
  const activation = new AbortController()
  const { signal } = activation
  const disposers = []
  ctx.effect(() => () => {
    activation.abort()
    pool.closeAll()
    for (const dispose of disposers.splice(0)) dispose()
  })

  function register(tools) {
    if (signal.aborted) return
    for (const tool of tools) {
      const publicName = publicToolName(config.serverName, tool.name)
      disposers.push(ctx.tools.register(createToolDefinition({ tool, publicName, ctx, config, pool, log })))
    }
    log.info(`unica-native: registered ${disposers.length} tools (probe cwd ${catalogCwd(config)})`)
  }

  let tools
  try {
    tools = await loadCatalog(config, log, signal)
  } catch (error) {
    if (!signal.aborted) {
      void retryCatalog(config, log, signal, error).then(register).catch((failure) => {
        if (!signal.aborted) log.error(`unica-native: tool catalog activation failed: ${failure.message}`)
      })
    }
    return
  }
  register(tools)
}
