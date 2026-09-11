// Validates the workflow structurally, so a typo in the CI definition is caught
// locally rather than as a red run on GitHub.
//
//   node tools/validate-workflow.mjs [path-to-workflow]
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadYaml, yamlWithJsTag } from './lib/yaml.mjs'

const WORKFLOW = resolve(
  process.argv[2] ?? join(dirname(dirname(fileURLToPath(import.meta.url))), '..', '.github', 'workflows', 'checks.yml'),
)

const yaml = loadYaml(process.argv.slice(3).map((p) => resolve(p)))
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
