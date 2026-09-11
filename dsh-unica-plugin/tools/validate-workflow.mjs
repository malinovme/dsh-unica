// Validates the workflow structurally, so a typo in the CI definition is caught
// locally rather than as a red run on GitHub.
//
//   node tools/validate-workflow.mjs [path-to-workflow]
//   node tools/validate-workflow.mjs [path-to-workflow] [js-yaml-root ...]
//
// Arguments are told apart by what they are, not by position: one that resolves
// to an existing file is the workflow, everything else is a js-yaml search root.
// A positional convention cannot be used here, because PowerShell drops an empty
// argument entirely, which would shift a root into the workflow slot.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadYaml, yamlWithJsTag } from './lib/yaml.mjs'

const argv = process.argv.slice(2).filter((a) => a !== '')
const workflowArg = argv.find((a) => {
  const p = resolve(a)
  return existsSync(p) && p.endsWith('.yml')
})
const searchArgs = argv.filter((a) => a !== workflowArg)

const WORKFLOW = resolve(
  workflowArg ?? join(dirname(dirname(fileURLToPath(import.meta.url))), '..', '.github', 'workflows', 'checks.yml'),
)

// Printed always: a failure here is usually a resolution or path problem, and
// seeing both inputs turns a red run into a one-line diagnosis.
console.log(`workflow    : ${WORKFLOW}`)
console.log(`search roots: ${searchArgs.length > 0 ? searchArgs.join(', ') : '(ambient + harness)'}`)

const yaml = loadYaml(searchArgs.map((p) => resolve(p)))
const doc = yaml.load(readFileSync(WORKFLOW, 'utf8'), { schema: yamlWithJsTag(yaml) })
console.log('name       :', doc.name)
console.log('triggers   :', Object.keys(doc.on).join(', '))
console.log('permissions:', JSON.stringify(doc.permissions))
console.log('jobs       :')

let runs = 0
for (const [id, job] of Object.entries(doc.jobs)) {
  const os = job['runs-on']
  console.log(`  ${id}  (runs-on: ${os}, steps: ${job.steps.length})`)
  for (const step of job.steps) {
    if (step.run !== undefined) {
      runs += 1
      console.log(`      run  : ${step.run.split('\n')[0]}`)
    } else if (step.uses !== undefined) {
      console.log(`      uses : ${step.uses}`)
    }
  }
}

// The checks must actually assert something: a workflow of only `echo` would be
// green forever.
if (runs === 0) throw new Error('workflow defines no run steps')
if (!doc.jobs['posix-modes']) throw new Error('the file-mode guard job is missing')
console.log(`\nOK: ${Object.keys(doc.jobs).length} jobs, ${runs} run steps`)
