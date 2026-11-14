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
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const PLUGIN_ROOT = resolve(import.meta.dirname ?? '.')
const outArg = process.argv.indexOf('--out')
const OUT = resolve(outArg === -1 ? join(PLUGIN_ROOT, '..', 'dsh-plugin-unica.tar.gz') : process.argv[outArg + 1])

// Only machine-specific and regenerable paths are excluded. install.mjs rewrites
// every absolute path for the target machine anyway, so nothing here is needed
// to install elsewhere.
const EXCLUDE_DIRS = new Set(['node_modules'])
const EXCLUDE_FILES = new Set(['build-report.json', '.package-filelist.txt'])

// What the operating system leaves behind, as opposed to source.
//
// Two different things produce it. A Mac writes an AppleDouble sidecar (`._name`)
// next to a file whenever it copies one onto a filesystem without resource forks,
// Finder drops `.DS_Store` into any folder it opened, and `unzip` creates
// `__MACOSX`; those can sit in a working tree and must not be walked into the
// file list. And a macOS `tar` adds `._name` members of its own for a file's
// extended attributes, even when the file list never mentioned them — that is how
// the 0.15.0.3 archive ended up with a dozen members its manifest does not
// describe. The walk skips the first kind; COPYFILE_DISABLE below stops the
// second, and the member check after packaging proves both worked.
function isOsMetadata(name) {
  return name === '.DS_Store' || name === '__MACOSX' || name.startsWith('._')
}

// A release built on Windows must still ship a launcher every host can run. The
// file that used to need this was upstream's `launch.sh`; 0.13 removed it, so the
// check moves to the Node launcher, which `sh` no longer reads but which is still
// compared byte-for-byte against the published checksum.
if ((await readFile(join(PLUGIN_ROOT, 'bootstrap', 'launch.mjs'), 'utf8')).includes('\r')) {
  throw new Error('bootstrap/launch.mjs must use LF line endings — refusing to package')
}

async function* walk(dir, rel = '') {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    const r = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name) || isOsMetadata(e.name)) continue
      yield* walk(abs, r)
    } else if (!EXCLUDE_FILES.has(r) && !isOsMetadata(e.name)) {
      yield { abs, rel: r }
    }
  }
}

const files = []
for await (const f of walk(PLUGIN_ROOT)) files.push(f)
files.sort((a, b) => a.rel.localeCompare(b.rel))

// An archive that cannot start its bridge is worse than no archive, so prove the
// files the launcher and the Host plugin need are in it instead of assuming.
for (const required of [
  'install.mjs',
  'installer/profile-patch.mjs',
  'installer/profile-file.mjs',
  'bootstrap/launch.mjs',
  'host/index.js',
  'host/selftest.js',
  'runtime-manifest.json',
  'tool-map.json',
]) {
  if (!files.some((f) => f.rel === required)) throw new Error(`refusing to package: ${required} is missing`)
}

let raw = 0
for (const f of files) raw += (await stat(f.abs)).size

const fileList = join(PLUGIN_ROOT, '.package-filelist.txt')
await writeFile(fileList, `${files.map((f) => f.rel).join('\n')}\n`, 'utf8')
await mkdir(dirname(OUT), { recursive: true })
try {
  execFileSync('tar', ['-czf', OUT, '-C', PLUGIN_ROOT, '-T', fileList], {
    stdio: 'inherit',
    // bsdtar on macOS honours this and stops writing AppleDouble members; GNU tar
    // on Linux ignores the variable, which is why it is set rather than branched
    // on. Without it a Mac build adds a `._name` member per file — dead weight
    // that also hides the drift from the manifest.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
} finally {
  await unlink(fileList)
}

// The write side is now guarded twice; this is the read-back that proves it. The
// archive has to contain exactly the files the manifest will list, so a host whose
// `tar` invents members fails here instead of at unpack time on a user's machine.
const members = execFileSync('tar', ['-tzf', OUT], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
const noise = members.filter((member) => isOsMetadata(basename(member)))
if (members.length !== files.length || noise.length > 0) {
  await unlink(OUT)
  throw new Error(
    `refusing to publish: the archive has ${members.length} members but ${files.length} were packaged` +
      (noise.length > 0 ? `, ${noise.length} of them OS metadata (e.g. ${noise[0]})` : ''),
  )
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
  tools: metadata.unica?.tools,
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
