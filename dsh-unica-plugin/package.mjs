// Packages the DSH port for transfer to another machine.
//
//   node package.mjs [--out <file.tar.gz>]
//
// There is one archive now. Upstream 0.13 stopped shipping per-platform bootstrap
// binaries, and this port replaced them with a Node launcher that fetches the
// runtime itself — so the old slim/full split described the same bytes twice. What
// stays out is only what is machine-specific or regenerable: `node_modules`, the
// build report, and the archive's own output.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const PLUGIN_ROOT = resolve(import.meta.dirname ?? '.')
const outArg = process.argv.indexOf('--out')
const OUT = resolve(outArg === -1 ? join(PLUGIN_ROOT, '..', 'dsh-plugin-unica.tar.gz') : process.argv[outArg + 1])

// Only machine-specific and regenerable paths are excluded. install.mjs rewrites
// every absolute path for the target machine anyway, so nothing here is needed
// to install elsewhere.
const EXCLUDE_DIRS = new Set(['node_modules'])
const EXCLUDE_FILES = new Set(['build-report.json', '.package-filelist.txt'])

async function* walk(dir, rel = '') {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    const r = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue
      yield* walk(abs, r)
    } else if (!EXCLUDE_FILES.has(r)) {
      yield { abs, rel: r }
    }
  }
}

const files = []
for await (const f of walk(PLUGIN_ROOT)) files.push(f)
files.sort((a, b) => a.rel.localeCompare(b.rel))

// An archive that cannot start its MCP server is worse than no archive, so prove
// the two files the launcher needs are in it instead of assuming.
for (const required of ['install.mjs', 'bootstrap/launch.mjs', 'runtime-manifest.json', 'tool-map.json']) {
  if (!files.some((f) => f.rel === required)) throw new Error(`refusing to package: ${required} is missing`)
}

let raw = 0
for (const f of files) raw += (await stat(f.abs)).size

const fileList = join(PLUGIN_ROOT, '.package-filelist.txt')
await writeFile(fileList, `${files.map((f) => f.rel).join('\n')}\n`, 'utf8')
await mkdir(dirname(OUT), { recursive: true })
try {
  execFileSync('tar', ['-czf', OUT, '-C', PLUGIN_ROOT, '-T', fileList], { stdio: 'inherit' })
} finally {
  await unlink(fileList)
}

const gz = await readFile(OUT)
const sha = createHash('sha256').update(gz).digest('hex')
const metadata = JSON.parse(await readFile(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
const manifest = {
  archive: OUT,
  sha256: sha,
  bytes: gz.length,
  uncompressedBytes: raw,
  version: metadata.version,
  upstreamVersion: metadata.unica?.upstreamVersion,
  mcpTools: metadata.unica?.mcpTools,
  skills: metadata.unica?.skills,
  fileCount: files.length,
  install: 'unpack, then: node install.mjs [--target preset|profile|both] [--verify]',
  contents: files.map((f) => f.rel),
}
const manifestPath = `${OUT}.sha256.json`
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

console.log(`packaged ${files.length} files, ${(raw / 1048576).toFixed(2)} MB raw -> ${(gz.length / 1048576).toFixed(2)} MB gz`)
console.log(`  archive : ${OUT}`)
console.log(`  manifest: ${manifestPath}`)
console.log(`  sha256  : ${sha}`)
