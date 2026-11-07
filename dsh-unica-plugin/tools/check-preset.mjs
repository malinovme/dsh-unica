// Checks a generated agent preset: it must parse as YAML, carry both port rows,
// and keep the session rules in the persona suffix.
//
//   node tools/check-preset.mjs [<profile-patch.yml>|--composition <agent.cordis.yml>]
//
// Two shapes are accepted, because DSH changed its mind about what a preset is:
//
//   - a profile patch (DSH 0.2.0+): the preset is a `@deepseek-ai/dsh-agent-preset`
//     row inside `cordis.patch.yml`, and its composition lives in
//     `config.plugins`. This is what the installer generates now, and the
//     default argument targets the profile it writes.
//   - a bare composition (DSH 0.1.x): a top-level row list, as written to
//     `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml` by older installs.
//
// Extra arguments are roots to resolve js-yaml from, so CI can use a /tmp
// install without touching the repository's own (absent) node_modules.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkPreset } from './lib/preset-checks.mjs'

const argv = process.argv.slice(2)
const compAt = argv.indexOf('--composition')
const compositionArg = compAt === -1 ? undefined : argv[compAt + 1]
const positional = argv.filter((a, i) => !a.startsWith('--') && (compAt === -1 || i !== compAt + 1))

const target =
  compositionArg !== undefined
    ? { path: resolve(compositionArg), kind: 'composition' }
    : {
        path: resolve(positional[0] ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'), 'profiles', 'web', 'cordis.patch.yml')),
        kind: 'patch',
      }
if (!existsSync(target.path)) {
  throw new Error(`preset not found: ${target.path}\nusage: node tools/check-preset.mjs [<profile-patch.yml>|--composition <agent.cordis.yml>]`)
}
const searchDirs = (compositionArg !== undefined ? argv.slice(compAt + 2) : positional.slice(1)).filter((a) => !a.startsWith('--')).map((p) => resolve(p))

const result = checkPreset(target.path, searchDirs, target.kind)
console.log(`preset      : ${target.path}`)
console.log(`shape       : ${target.kind === 'patch' ? 'profile patch row' : 'bare composition'}`)
console.log(`row id      : ${result.rowId}`)
console.log(`preset id   : ${result.presetId}`)
console.log(`display name: ${result.name}`)
console.log(`rows        : ${result.rows}`)
console.log(`ids         : ${result.ids.join(', ')}`)
console.log(`bridge      : ${result.bridgeEntry}`)
console.log(`plugin root : ${result.pluginRoot}`)
console.log(`cache/state : ${result.cacheDir} | ${result.stateDir}`)
console.log(`rules kept  : executionToken, unica.check, unica.docs, engine on first use`)
console.log('\nYAML, rows and session rules all verified')
