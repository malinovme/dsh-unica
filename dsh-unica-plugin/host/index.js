import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog } from './lib/catalog.js'
import { resolveConfig } from './lib/config.js'
import { publicToolName } from './lib/naming.js'
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
  const agent = exec?.agent
  if (agent !== undefined) {
    try {
      const ensured = await ctx.workingDirectory.ensure(agent, exec.signal)
      return canonicalCwd(ensured) ?? ensured
    } catch (error) {
      log.warn(`unica-native: workingDirectory.ensure failed: ${error?.message ?? String(error)}`)
    }
    try {
      const current = ctx.workingDirectory.get(agent.session)
      if (typeof current === 'string' && current.length > 0) return canonicalCwd(current) ?? current
    } catch (error) {
      log.warn(`unica-native: workingDirectory.get failed: ${error?.message ?? String(error)}`)
    }
  }
  return config.defaultCwd ?? undefined
}

function createToolDefinition({ tool, publicName, ctx, config, pool, log }) {
  const rawName = tool.name
  return {
    name: publicName,
    description: typeof tool.description === 'string' ? tool.description : `unica ${rawName}`,
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
    async execute(args, exec) {
      const cwd = await resolveCwd(ctx, exec, config, log)
      if (cwd === undefined) {
        throw new Error('unica-native: the session has no working directory and defaultCwd is not configured')
      }
      const result = await pool.withProc(cwd, (proc) =>
        proc.callTool(rawName, args, { signal: exec.signal, timeoutMs: config.toolCallTimeoutMs }),
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
  ctx.effect(() => () => pool.closeAll())

  let tools
  try {
    tools = await loadCatalog(config, log)
  } catch (error) {
    log.error(`unica-native: tool catalog unavailable, no tools registered: ${error?.message ?? String(error)}`)
    return
  }

  const disposers = []
  for (const tool of tools) {
    const publicName = publicToolName(config.serverName, tool.name)
    disposers.push(ctx.tools.register(createToolDefinition({ tool, publicName, ctx, config, pool, log })))
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  })
  log.info(`unica-native: registered ${disposers.length} tools (probe cwd ${config.probeCwd ?? tmpdir()})`)
}
