// Run the same requests as the tutorial against a fresh copy, without a DSH session.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../dsh-unica-plugin/host/lib/config.js'
import { UnicaProc } from '../dsh-unica-plugin/host/lib/proc.js'

const args = process.argv.slice(2)
assert.ok(!args.length || (args.length === 1 && args[0] === '--build'), 'Usage: node examples/verify-price-extension.mjs [--build]')
const build = args.length > 0
const sample = join(import.meta.dirname, 'price-extension')
const request = async name => JSON.parse(await readFile(join(sample, 'requests', `${name}.json`), 'utf8'))
const cwd = await realpath(await mkdtemp(join(tmpdir(), 'unica-price-')))
const proc = new UnicaProc({ cwd, config: resolveConfig({ nodePath: process.execPath, startupTimeoutMs: 300_000,
  artifactDelivery: build ? 'eager' : 'off' }) })

async function call(name, args) {
  const read = async (tool, params) => {
    const r = await proc.callTool(`unica.${tool}`, params)
    const body = r.structuredContent ?? JSON.parse(r.content[0].text)
    assert.ok(!r.isError && body.ok, `unica.${tool}: ${JSON.stringify(body)}`)
    return body.data
  }
  let data = await read(name, args)
  if (data.task) {
    const { taskId } = data.task
    const deadline = Date.now() + 10 * 60_000
    do {
      assert.ok(Date.now() < deadline, `Timeout: unica.${name}, taskId=${taskId}`)
      data = await read('task.result', { taskId, waitMs: 5000 })
    } while (data.task)
  }
  return data
}

let completed = false
try {
  for (const file of ['src', 'ext', 'v8project.yaml']) await cp(join(sample, file), join(cwd, file), { recursive: true })
  console.log(`Рабочая копия: ${cwd}`)
  await proc.start()
  const workspace = await call('view', {})
  assert.deepEqual(workspace.sourceSets.map(s => [s.name, s.kind]), [['main', 'configuration'], ['tutorial', 'extension']])

  const search = await request('search')
  const { totals, matches } = await call('search', search)
  assert.equal(totals.matches, 2)
  assert.equal(totals.files, 2)
  assert.deepEqual(matches.map(m => m.at).sort(), [
    `${search.scope}.Form.Форма.Module.Form.Method.РассчитатьНаСервере.Body#L9`,
    `${search.scope}.Module.Object.Method.РассчитатьСумму.Body#L2`,
  ])
  console.log('Поиск: объявление функции и один вызов из формы.')

  const edit = await request('edit-form')
  const item = edit.ops[0].args.items[0]
  const relativeForm = 'DataProcessors/Учебное_РасчетЦены/Forms/Форма/Ext/Form.xml'
  const formFile = join(cwd, 'ext', relativeForm)
  const before = await readFile(formFile)
  assert.ok(!before.includes(item.name))
  const plan = await call('apply', edit)
  assert.equal(plan.mode, 'preview')
  assert.ok(plan.executionToken)
  const token = { executionToken: plan.executionToken }
  const diff = await call('diff', token)
  assert.equal(diff.truncated, false)
  assert.deepEqual([...new Set(diff.chunks.map(c => c.path))], [relativeForm])
  assert.ok(diff.chunks.some(c => c.side === 'after' && c.content.includes(item.title)))
  assert.deepEqual(await readFile(formFile), before, 'Предпросмотр изменил исходный файл')
  assert.equal((await call('apply', token)).mode, 'published')
  assert.ok((await readFile(formFile)).includes(item.title))
  await call('view', { at: `${edit.at}.Item.${item.name}` })
  for (const [at, validator] of [[edit.at, 'form'], ['tutorial:Configuration', 'cfe']]) {
    const verdict = await call('check', { at })
    assert.ok(verdict.validators.includes(validator))
    assert.equal(verdict.status, 'passed')
  }
  console.log('Форма: план сохранил исходник, токен добавил надпись; form и cfe: passed.')

  if (build) {
    const make = await request('make')
    const output = join(cwd, make.args.output)
    const preview = await call('run', make)
    assert.equal(preview.dryRun, true)
    assert.equal(preview.providerDispatched, false)
    assert.equal(preview.plan.sourceSet, 'tutorial')
    assert.deepEqual(preview.plan.artifact, { kind: 'cfe', path: make.args.output })
    assert.ok(!existsSync(output))
    console.log('План сборки: tutorial → build/out/Учебное.cfe, файл ещё не создан.')
    const result = await call('run', { ...make, dryRun: false })
    assert.equal(result.providerDispatched, true)
    assert.equal(result.artifact.kind, 'cfe')
    assert.equal(result.artifact.path, make.args.output)
    const bytes = await readFile(output)
    assert.ok(bytes.length > 0)
    assert.equal(bytes.length, result.artifact.size)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), result.artifact.sha256)
    console.log(`Готово: ${output} (${bytes.length} байт), SHA-256 совпадает с отчётом Unica.`)
  }
  completed = true
} finally {
  proc.close()
  if (completed && !build) await rm(cwd, { recursive: true, force: true, maxRetries: 5 })
  else console.log(`Копия сохранена: ${cwd}`)
}
