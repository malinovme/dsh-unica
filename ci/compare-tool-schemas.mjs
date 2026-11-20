// Compare live MCP catalogs from two unpacked port releases or working trees.
import { tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { resolveConfig } from '../dsh-unica-plugin/host/lib/config.js'
import { UnicaProc } from '../dsh-unica-plugin/host/lib/proc.js'

async function catalog(pluginRoot) {
  const config = resolveConfig({ pluginRoot, nodePath: process.execPath, artifactDelivery: 'off' })
  const proc = new UnicaProc({ cwd: realpathSync(tmpdir()), config })
  try {
    // Older unpacked releases expose MCP over stdio without the launcher readiness message.
    await proc.start(undefined, { legacyLauncher: true })
    const schemas = new Map()
    const cursors = new Set()
    let cursor
    do {
      const page = await proc.request('tools/list', cursor === undefined ? {} : { cursor }, { timeoutMs: config.startupTimeoutMs })
      for (const { name, inputSchema } of page.tools) {
        if (!name || !inputSchema || schemas.has(name)) throw new Error(`invalid or duplicate tool: ${name}`)
        schemas.set(name, inputSchema)
      }
      cursor = page.nextCursor
      if (cursor !== undefined) {
        if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error('invalid or repeated tools/list cursor')
        cursors.add(cursor)
      }
    } while (cursor !== undefined)
    return { version: proc.serverInfo?.version, schemas }
  } catch (error) {
    throw new Error(`${pluginRoot}: ${error.message}\n${proc.stderrTail()}`, { cause: error })
  } finally {
    proc.close('schema comparison complete')
  }
}

function schemaChanges(before, after, path = '') {
  if (isDeepStrictEqual(before, after)) return []
  if (path.endsWith('/required') && [before, after].every(value => value === undefined || Array.isArray(value))) {
    const added = (after ?? []).filter(key => !(before ?? []).includes(key)).sort()
    const removed = (before ?? []).filter(key => !(after ?? []).includes(key)).sort()
    return added.length || removed.length ? [{ path, added, removed }] : []
  }
  if (before && after && typeof before === 'object' && typeof after === 'object' &&
      Array.isArray(before) === Array.isArray(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    return keys.flatMap(key => {
      const pointer = path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1')
      return schemaChanges(Object.hasOwn(before, key) ? before[key] : undefined,
        Object.hasOwn(after, key) ? after[key] : undefined, pointer)
    })
  }
  return [{ path, before, after }]
}

const roots = process.argv.slice(2)
if (roots.length !== 2) throw new Error('Usage: node ci/compare-tool-schemas.mjs OLD_PLUGIN_ROOT NEW_PLUGIN_ROOT')
const old = await catalog(roots[0])
const next = await catalog(roots[1])
const added = [...next.schemas.keys()].filter(name => !old.schemas.has(name)).sort()
const removed = [...old.schemas.keys()].filter(name => !next.schemas.has(name)).sort()
const changed = []
for (const name of [...old.schemas.keys()].sort()) {
  if (!next.schemas.has(name)) continue
  const changes = schemaChanges(old.schemas.get(name), next.schemas.get(name))
  if (changes.length) changed.push({ name, changes })
}
console.log(JSON.stringify({
  from: { version: old.version, tools: old.schemas.size },
  to: { version: next.version, tools: next.schemas.size },
  added, removed, changed,
}, null, 2))
