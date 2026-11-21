// Self-test for the native bridge: starts unica in a given directory, lists the
// tool catalog and reads `unica.view {}` without DSH. Used by `install.mjs
// --verify` and by hand while developing:
//
//   node host/selftest.js --cwd /path/to/project
//
import { resolveConfig } from './lib/config.js'
import { canonicalCwd } from './lib/pool.js'
import { UnicaProc } from './lib/proc.js'
import { catalogCwd, loadCatalog } from './lib/catalog.js'
import { resultText } from './lib/render.js'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function reportedRoot(view) {
  const root = view.structuredContent?.data?.workspaceRoot
  if (root !== undefined) return root
  for (const block of view.content ?? []) {
    if (block?.type !== 'text') continue
    try {
      const textRoot = JSON.parse(block.text)?.data?.workspaceRoot
      if (textRoot !== undefined) return textRoot
    } catch {
      // Tools may include human-readable messages alongside the JSON envelope.
    }
  }
}

const requested = flag('--cwd') ?? process.cwd()
const cwd = canonicalCwd(requested)
if (cwd === undefined) {
  console.error(`unica-native selftest: not a directory: ${requested}`)
  process.exit(2)
}

const startupTimeout = flag('--startup-timeout-ms')
const coldStartTimeout = flag('--cold-start-timeout-ms')
const config = resolveConfig({
  defaultCwd: cwd,
  coldStartTimeoutMs: coldStartTimeout === undefined ? undefined : Number(coldStartTimeout),
  startupTimeoutMs: startupTimeout === undefined ? undefined : Number(startupTimeout),
  ...JSON.parse(flag('--config-json') ?? '{}'),
})
const proc = new UnicaProc({ cwd, config, closeTree: true, log: { info() {}, warn: console.error, error: console.error } })
const startedAt = Date.now()

try {
  if (catalogCwd(config) !== cwd) await loadCatalog(config, proc.log, undefined, { closeTree: true })
  await proc.start()
  const tools = await proc.listTools({ timeoutMs: config.startupTimeoutMs })
  const view = await proc.callTool('unica.view', {})
  if (view.isError === true) throw new Error(`unica.view failed: ${resultText(view) || 'tool returned isError'}`)
  const root = reportedRoot(view)

  // `ok` answers the installer's question — will the tools work here? — and the
  // tool catalog answers it. The catalog arrives even in a directory unica will
  // not adopt as a workspace: a protected one such as C:\Windows\System32 reports
  // no workspaceRoot at all, yet lists all eleven tools. Workspace matching is a
  // separate fact in `workspace`, and only a *mismatch* is a bridge defect.
  const workspace = root === undefined ? 'not reported' : root === cwd ? 'matched' : 'mismatched'
  const report = {
    ok: tools.length > 0 && workspace !== 'mismatched',
    cwd,
    root,
    workspace,
    tools: tools.length,
    ms: Date.now() - startedAt,
    server: proc.serverInfo ?? null,
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) {
    console.error(
      workspace === 'mismatched'
        ? `unica-native selftest: workspace root ${root} does not match ${cwd}`
        : `unica-native selftest: unica listed no tools in ${cwd}`,
    )
    process.exitCode = 1
  }
} catch (error) {
  console.error(`unica-native selftest: ${error?.message ?? String(error)}`)
  const tail = proc.stderrTail()
  if (tail && !error.message?.endsWith(tail)) console.error(tail)
  process.exitCode = 1
} finally {
  // The self-test is a one-shot probe: it must leave nothing running. With a
  // plain close on Windows only the Node launcher dies, and the runtime's daemon
  // survives, keeps the console it inherited and holds provider-state locks — the
  // installer then looks hung after it has already finished.
  proc.close('selftest is done')
}
