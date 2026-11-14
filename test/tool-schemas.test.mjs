import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

test('compare live catalogs across pages and report changes to required arguments', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'schema comparison '))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  async function fixture(version, required, extra) {
    const plugin = join(root, version)
    await mkdir(join(plugin, 'bootstrap'), { recursive: true })
    const pages = [
      { tools: [{ name: 'edit', inputSchema: { type: 'object', properties: { form: { type: 'object', required } } } }], nextCursor: 'more' },
      { tools: [{ name: extra, inputSchema: { type: 'object' } },
        { name: 'stable', inputSchema: { type: 'object', required: version === 'old' ? ['a', 'b'] : ['b', 'a'] } }] },
    ]
    await writeFile(join(plugin, 'bootstrap/launch.mjs'), `
      import { createInterface } from 'node:readline'
      const pages = ${JSON.stringify(pages)}
      for await (const line of createInterface({ input: process.stdin })) {
        const { id, method, params } = JSON.parse(line)
        if (id === undefined) continue
        const result = method === 'initialize' ? { serverInfo: { version: ${JSON.stringify(version)} } }
          : pages[params.cursor === 'more' ? 1 : 0]
        console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))
      }
    `)
    return plugin
  }
  const old = await fixture('old', ['preview'], 'removed')
  const next = await fixture('new', ['executionToken'], 'added')
  const { stdout } = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, '../ci/compare-tool-schemas.mjs'), old, next,
  ], { timeout: 15_000 })
  assert.deepEqual(JSON.parse(stdout), {
    from: { version: 'old', tools: 3 }, to: { version: 'new', tools: 3 },
    added: ['added'], removed: ['removed'],
    changed: [{ name: 'edit', changes: [{ path: '/properties/form/required', added: ['executionToken'], removed: ['preview'] }] }],
  })
})
