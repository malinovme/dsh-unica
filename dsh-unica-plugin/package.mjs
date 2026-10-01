// Packages the DSH port for transfer to another machine.
//
//   node package.mjs [--out <file.tar.gz>] [--include-bootstrap]
//
// The bootstrap binaries (~9 MB of the ~11 MB total) are EXCLUDED by default.
// They are third-party prebuilt binaries carrying their own licenses (see
// ATTRIBUTIONS.md), and any given machine needs only its own target's binary.
// A recipient either already has the upstream package or fetches it from the
// release, so shipping all three by default would distribute bytes nobody
// asked for AND widen the license surface for no benefit. Use
// --include-bootstrap for a fully self-contained archive, which is what a
// restricted-network install needs.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const PLUGIN_ROOT = resolve(import.meta.dirname ?? '.')
const INCLUDE_BOOTSTRAP = process.argv.includes('--include-bootstrap')
const outArg = process.argv.indexOf('--out')
const OUT = resolve(outArg === -1 ? join(PLUGIN_ROOT, '..', 'dsh-plugin-unica.tar.gz') : process.argv[outArg + 1])

// Only machine-specific and regenerable paths are excluded. install.mjs rewrites
// every absolute path for the target machine anyway, so nothing here is needed
// to install elsewhere.
const EXCLUDE_DIRS = new Set(['node_modules'])
const BOOTSTRAP_REL = 'bootstrap/bin'

// Windows-built releases must still contain a runnable POSIX launcher.
if ((await readFile(join(PLUGIN_ROOT, 'bootstrap', 'launch.sh'))).includes(13)) {
  throw new Error('bootstrap/launch.sh must use LF line endings — refusing to package')
}

async function* walk(dir, rel = '') {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    const r = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue
      if (!INCLUDE_BOOTSTRAP && r === BOOTSTRAP_REL) continue
      yield* walk(abs, r)
    } else {
      yield { abs, rel: r }
    }
  }
}

const files = []
for await (const f of walk(PLUGIN_ROOT)) files.push(f)
files.sort((a, b) => a.rel.localeCompare(b.rel))

// A silent exclusion bug would ship an archive that cannot start its MCP server,
// so prove the exclusion actually happened instead of assuming it.
if (!INCLUDE_BOOTSTRAP && files.some((f) => f.rel.startsWith(`${BOOTSTRAP_REL}/`))) {
  throw new Error('bootstrap exclusion failed — refusing to package')
}
if (INCLUDE_BOOTSTRAP) {
  const targets = files.filter((f) => f.rel.startsWith(`${BOOTSTRAP_REL}/`)).length
  if (targets === 0) throw new Error('--include-bootstrap requested but no bootstrap binaries were found')
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
const manifest = {
  archive: OUT,
  sha256: sha,
  bytes: gz.length,
  uncompressedBytes: raw,
  includesBootstrap: INCLUDE_BOOTSTRAP,
  fileCount: files.length,
  install: 'unpack, then: node install.mjs [--target preset|profile|both]',
  contents: files.map((f) => f.rel),
}
const manifestPath = `${OUT}.sha256.json`
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

console.log(`packaged ${files.length} files, ${(raw / 1048576).toFixed(2)} MB raw -> ${(gz.length / 1048576).toFixed(2)} MB gz`)
console.log(`  archive : ${OUT}`)
console.log(`  manifest: ${manifestPath}`)
console.log(`  sha256  : ${sha}`)
console.log(`  bootstrap included: ${INCLUDE_BOOTSTRAP}`)
