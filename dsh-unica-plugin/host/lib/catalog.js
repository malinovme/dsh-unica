import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { canonicalPath } from './config.js'
import { UnicaProc } from './proc.js'

/** The DSH catalog probe and the self-test must resolve the same directory. */
export function catalogCwd(config) {
  return canonicalPath(config.probeCwd ?? tmpdir())
}

/**
 * Ask one unica process for its tool list. Schemas are workspace-independent,
 * so the probe runs in a neutral directory and is closed as soon as the list
 * arrives; per-directory processes start lazily on the first real call.
 */
export async function loadCatalog(config, log, signal, { closeTree = false } = {}) {
  signal?.throwIfAborted()
  const probe = new UnicaProc({ cwd: catalogCwd(config), config, log, closeTree })
  try {
    await probe.start(signal)
    const tools = await probe.listTools({ signal, timeoutMs: config.startupTimeoutMs })
    log?.info?.(`unica-native: ${tools.length} tools from unica ${probe.serverInfo?.version ?? '?'}`)
    return tools
  } finally {
    probe.close('tool catalog probe is done')
  }
}

/** Retry a failed activation probe without holding up the rest of the DSH profile. */
export async function retryCatalog(config, log, signal, error) {
  for (const waitMs of [1000, 3000]) {
    log.warn(`unica-native: tool catalog unavailable: ${error.message}; retrying in ${waitMs} ms`)
    await delay(waitMs, undefined, { signal })
    try {
      return await loadCatalog(config, log, signal)
    } catch (failure) {
      signal.throwIfAborted()
      error = failure
    }
  }
  throw error
}
