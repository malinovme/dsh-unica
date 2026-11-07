import { tmpdir } from 'node:os'
import { UnicaProc } from './proc.js'

/**
 * Ask one unica process for its tool list. Schemas are workspace-independent,
 * so the probe runs in a neutral directory and is closed as soon as the list
 * arrives; per-directory processes start lazily on the first real call.
 */
export async function loadCatalog(config, log) {
  const probe = new UnicaProc({ cwd: config.probeCwd ?? tmpdir(), config, log })
  try {
    await probe.start()
    const tools = await probe.listTools({ timeoutMs: config.startupTimeoutMs })
    log?.info?.(`unica-native: ${tools.length} tools from unica ${probe.serverInfo?.version ?? '?'}`)
    return tools
  } finally {
    probe.close('tool catalog probe is done')
  }
}
