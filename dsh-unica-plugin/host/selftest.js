// Self-test for the native bridge: starts unica in a given directory, lists the
// tool catalog and reads `unica.view {}` without DSH. Used by `install.mjs
// --verify` and by hand while developing:
//
//   node host/selftest.js --cwd /path/to/project
//
import { resolveConfig } from './lib/config.js'
import { canonicalCwd } from './lib/pool.js'
import { UnicaProc } from './lib/proc.js'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const requested = flag('--cwd') ?? process.cwd()
const cwd = canonicalCwd(requested)
if (cwd === undefined) {
  console.error(`unica-native selftest: not a directory: ${requested}`)
  process.exit(2)
}

const config = resolveConfig({ defaultCwd: cwd })
const proc = new UnicaProc({ cwd, config, log: { info() {}, warn: console.error, error: console.error } })
const startedAt = Date.now()

try {
  await proc.start()
  const tools = await proc.listTools({ timeoutMs: config.startupTimeoutMs })
  const view = await proc.callTool('unica.view', {}, { timeoutMs: 60_000 })
  const text = (view.content ?? []).find((block) => block?.type === 'text')?.text ?? ''
  let root
  try {
    root = JSON.parse(text)?.data?.workspaceRoot
  } catch {
    root = undefined
  }

  const report = {
    ok: root === cwd,
    cwd,
    root,
    tools: tools.length,
    ms: Date.now() - startedAt,
    server: proc.serverInfo ?? null,
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) {
    console.error(`unica-native selftest: workspace root ${root} does not match ${cwd}`)
    process.exitCode = 1
  }
} catch (error) {
  console.error(`unica-native selftest: ${error?.message ?? String(error)}`)
  const tail = proc.stderrTail()
  if (tail.length > 0) console.error(tail)
  process.exitCode = 1
} finally {
  proc.close('selftest is done')
}
