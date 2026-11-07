// Locates the DSH installation, so tools can reach what it ships (js-yaml, the
// shipped preset compositions, the preset declaration schema) without the plugin
// depending on them.
//
// Two layouts have to be understood, because the harness arrives two ways:
//
//   - **on disk** — a `node_modules` a launcher put there: `npx @deepseek-ai/dsh`,
//     a global install, a checkout. Everything is an ordinary path.
//   - **inside an Electron bundle** — DSH Desktop packs the whole harness into
//     `<install>/resources/app.asar`, where `dsh/node_modules/@deepseek-ai/*`
//     holds the packages. Nothing there is a path on disk: the files live inside
//     one archive, so they are read through the asar header instead.
//
// A port that understood only the first layout fails on Desktop with the preset
// template "not found" while it sits in plain sight inside the bundle, which is
// exactly what happened. Both layouts are handled here so callers never care
// which one is in use.
//
// Deliberately subprocess-free: spawning `where.exe` is denied inside a
// sandboxed DSH session (EPERM), and PATH scanning needs no spawn.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, sep } from 'node:path'

/**
 * Directories that contain a `node_modules` with the harness in it.
 * `DSH_INSTALL_ROOT` wins; otherwise the `dsh` shim found on PATH is traced back
 * to the directory that owns its `node_modules`.
 *
 * @returns candidate roots, most explicit first
 */
export function harnessRoots() {
  const roots = []
  const explicit = process.env.DSH_INSTALL_ROOT
  if (explicit !== undefined && explicit !== '') {
    // An asar path or a bundle's `resources` directory is accepted here too, so
    // one variable serves both layouts.
    const asar = normalizeAsarPath(explicit)
    if (asar !== undefined) return [asar.resources]
    roots.push(explicit)
  }
  // Windows environment variable names are case-insensitive; Node keeps the
  // original spelling, so `process.env.PATH` may be undefined while `Path` is set.
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path')
  const tail = `.bin${sep}`
  for (const entry of (process.env[pathKey] ?? '').split(delimiter)) {
    // A shim directory ends with `node_modules/.bin`, and npm does not always
    // append a trailing separator, so match the tail with and without it.
    const at = entry.endsWith(tail) ? entry.length - tail.length : entry.endsWith('.bin') ? entry.length - '.bin'.length : -1
    const prefix = `node_modules${sep}`
    if (at > 0 && entry.slice(0, at).endsWith(prefix)) roots.push(entry.slice(0, at - prefix.length))
  }
  return [...new Set(roots)]
}

/** Every `node_modules` directory the harness might have been installed into. */
export function harnessNodeModules() {
  return harnessRoots().map((root) => join(root, 'node_modules'))
}

/**
 * Normalises a path that may name an Electron bundle, its `resources`
 * directory, or the asar itself into `{ resources, asar }`.
 *
 * @returns the pair, or `undefined` when the path holds no asar
 */
function normalizeAsarPath(candidate) {
  const paths = [candidate, join(candidate, 'app.asar'), join(candidate, 'resources', 'app.asar')]
  for (const asar of paths) {
    if (!asar.endsWith('.asar') || !existsSync(asar)) continue
    // An `.asar` is a file; a directory of that name would be something else.
    try {
      if (!statSync(asar).isFile()) continue
    } catch {
      continue
    }
    return { resources: asar.slice(0, -'app.asar'.length).replace(/[\\/]$/, ''), asar }
  }
  return undefined
}

/**
 * The Desktop bundle's asar, if this machine has one.
 *
 * Searched rather than assumed: the app directory carries the product name, and
 * an installed app can sit in any of the usual places per platform.
 *
 * @returns `{ resources, asar }`, or `undefined`
 */
export function harnessAsar() {
  const explicit = process.env.DSH_INSTALL_ROOT
  if (explicit !== undefined && explicit !== '') {
    const found = normalizeAsarPath(explicit)
    if (found !== undefined) return found
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const name = 'DeepSeek Harness'
  const candidates = [
    join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', name, 'resources'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', name, 'resources'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', name, 'resources'),
    join('/Applications', `${name}.app`, 'Contents', 'Resources'),
    join(home, 'Applications', `${name}.app`, 'Contents', 'Resources'),
    join('/usr', 'lib', 'deepseek-harness', 'resources'),
    join('/opt', name, 'resources'),
  ]
  for (const candidate of candidates) {
    const found = normalizeAsarPath(candidate)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Reads the asar's file table.
 *
 * The format is a pickle header: a UInt32 payload size at offset 12, then that
 * many bytes of JSON describing a tree of `files`, where each file carries
 * `offset` and `size` as decimal strings relative to the end of the header.
 *
 * @returns `{ fd, header, base }`
 */
function openAsar(asar) {
  const fd = readFileSync(asar)
  // The pickle header is [u32 4][u32 headerSize][u32 payloadSize][u32 jsonSize]
  // followed by the JSON and padding to a 4-byte boundary. File offsets are
  // relative to the END OF THE PICKLE, i.e. 8 + headerSize — not to the end of
  // the JSON: the padding is real, and skipping it shifts every extracted byte.
  const headerSize = fd.readUInt32LE(4)
  const jsonSize = fd.readUInt32LE(12)
  if (headerSize < jsonSize + 8) throw new Error(`invalid asar header in ${asar}: headerSize ${headerSize} < jsonSize ${jsonSize} + 8`)
  const header = JSON.parse(fd.subarray(16, 16 + jsonSize).toString('utf8'))
  return { fd, header, base: 8 + headerSize }
}

/** Resolves `a/b/c` inside an asar tree to its file entry, or `undefined`. */
function asarEntry(header, internal) {
  const node = asarNode(header, internal)
  return node?.files === undefined ? node : undefined
}

/** Resolves `a/b/c` inside an asar tree to its node, file or directory. */
function asarNode(header, internal) {
  let node = header
  for (const part of internal.split('/')) {
    if (part === '') continue
    node = node?.files?.[part]
    if (node === undefined) return undefined
  }
  return node
}

/**
 * Reads one file from inside the Desktop bundle.
 *
 * @param internal - path inside the archive, e.g. `dsh/node_modules/@deepseek-ai/dsh-web-app/package.json`
 * @param bundle - the asar to read; defaults to the one this machine has
 * @returns the bytes, or `undefined` when the archive or the entry is absent
 */
export function readAsarFile(internal, bundle = harnessAsar()) {
  if (bundle === undefined) return undefined
  const opened = openAsar(bundle.asar)
  const entry = asarEntry(opened.header, internal)
  if (entry === undefined) return undefined
  const offset = Number(entry.offset)
  const size = Number(entry.size)
  return opened.fd.subarray(opened.base + offset, opened.base + offset + size)
}

/**
 * Names of the files (not directories) directly inside a bundle directory.
 *
 * @param internal - directory path inside the archive
 * @returns file names, or an empty list without a bundle
 */
export function asarDirectoryFiles(internal, bundle = harnessAsar()) {
  if (bundle === undefined) return []
  const node = asarNode(openAsar(bundle.asar).header, internal)
  if (node?.files === undefined) return []
  return Object.entries(node.files)
    .filter(([, value]) => value.files === undefined)
    .map(([name]) => name)
}

/**
 * Lists the harness packages inside the Desktop bundle.
 *
 * @returns package names under `@deepseek-ai`, or an empty list without a bundle
 */
export function asarHarnessPackages(bundle = harnessAsar()) {
  if (bundle === undefined) return []
  const scope = asarNode(openAsar(bundle.asar).header, 'dsh/node_modules/@deepseek-ai')
  return scope === undefined ? [] : Object.keys(scope.files ?? {}).sort()
}

/** The package an import specifier names: `@scope/name` or `name`. */
function packageOfSpecifier(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

/** Package dirs inside the bundle, keyed by package name. */
function asarPackageDirs(bundle) {
  const opened = openAsar(bundle.asar)
  const root = asarNode(opened.header, 'dsh/node_modules')
  const dirs = new Map()
  for (const [name, node] of Object.entries(root?.files ?? {})) {
    if (name.startsWith('@')) {
      for (const child of Object.keys(node.files ?? {})) dirs.set(`${name}/${child}`, `dsh/node_modules/${name}/${child}`)
    } else if (node.files !== undefined) {
      dirs.set(name, `dsh/node_modules/${name}`)
    }
  }
  return dirs
}

/** Bare `from '...'` / `import('...')` specifiers in a JavaScript file. */
function bareSpecifiers(source) {
  const out = new Set()
  for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) out.add(match[1])
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.add(match[1])
  return [...out].filter((s) => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('node:') && !s.startsWith('cordis:'))
}

/** Every file of an asar subtree, as `[relativePath, bytes]`. */
function asarSubtreeFiles(opened, node) {
  const files = []
  const walk = (current, prefix) => {
    for (const [name, child] of Object.entries(current.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (child.files !== undefined) walk(child, path)
      else {
        const offset = Number(child.offset)
        const size = Number(child.size)
        files.push([path, opened.fd.subarray(opened.base + offset, opened.base + offset + size)])
      }
    }
  }
  walk(node, '')
  return files
}

/** The closure of packages a set of JavaScript files reaches by bare specifier. */
function packageClosure(entryBytes, opened, packages) {
  const written = new Set()
  const queue = []
  for (const bytes of entryBytes) {
    for (const specifier of bareSpecifiers(bytes.toString('utf8'))) queue.push(specifier)
  }
  const files = []
  while (queue.length > 0) {
    const specifier = queue.shift()
    const name = packageOfSpecifier(specifier)
    if (written.has(name)) continue
    written.add(name)
    const packageDir = packages.get(name)
    if (packageDir === undefined) continue
    const node = asarNode(opened.header, packageDir)
    if (node === undefined) continue
    for (const [rel, bytes] of asarSubtreeFiles(opened, node)) {
      files.push([`entry/node_modules/${name}/${rel}`, bytes])
      if (rel.endsWith('.js') || rel.endsWith('.mjs') || rel.endsWith('.cjs')) {
        for (const nested of bareSpecifiers(bytes.toString('utf8'))) queue.push(nested)
      }
    }
  }
  return files
}

/**
 * Copies one package out of the bundle so `createRequire` can load it.
 *
 * `@deepseek-ai` packages are ESM and reach each other by bare specifier, so
 * their closure is copied as well; a CommonJS package such as js-yaml stands
 * alone and only its own files are written.
 *
 * @param name - package name, `@scope/name` or `name`
 * @param dir - directory to write into
 * @param bundle - the bundle to read from
 * @returns the directory holding the copied package
 */
export function materializePackage(name, dir, bundle = harnessAsar()) {
  if (bundle === undefined) throw new Error(`no Desktop bundle found to take ${name} from`)
  const opened = openAsar(bundle.asar)
  const packages = asarPackageDirs(bundle)
  const packageDir = packages.get(name)
  if (packageDir === undefined) throw new Error(`the Desktop bundle carries no package ${name}`)
  const node = asarNode(opened.header, packageDir)
  const files = []
  const own = asarSubtreeFiles(opened, node)
  for (const [rel, bytes] of own) files.push([`node_modules/${name}/${rel}`, bytes])
  const isEsm = own.some(([rel]) => rel === 'package.json') && !own.some(([rel]) => rel.endsWith('.cjs'))
  if (name.startsWith('@deepseek-ai/') || isEsm) {
    files.push(...packageClosure(own.map(([, bytes]) => bytes), opened, packages))
  }
  for (const [rel, bytes] of files) {
    const target = join(dir, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
  }
  return join(dir, 'node_modules', name)
}

/**
 * Writes the module closure a bundled harness entry point needs onto disk.
 *
 * Plain Node cannot import from inside an asar, so the Desktop harness is made
 * runnable by materialising the packages it reaches. Layout matters: the entry
 * is written into `<dir>/entry/entry.mjs` and the packages into
 * `<dir>/entry/node_modules/...`, which is where Node looks first for both a
 * bare specifier and a `dsh/...` subpath — so no import in the extracted code
 * has to be rewritten, and the result stays a faithful copy of the bundle.
 *
 * @param entryInternal - entry point inside the archive, e.g. `dsh/lib/dump-config-*.js`
 * @param dir - directory to extract into; created if missing
 * @param bundle - the bundle to read from
 * @returns `{ entry, packages }` where `entry` is the path to import
 */
export function materializeHarness(entryInternal, dir, bundle = harnessAsar()) {
  if (bundle === undefined) throw new Error('no Desktop bundle found to materialise')
  const opened = openAsar(bundle.asar)
  const packages = asarPackageDirs(bundle)
  const segments = entryInternal.split('/')
  const entryName = segments.at(-1)
  const files = []
  const written = new Set()

  // The entry point and its own directory first: it reaches sibling modules by
  // relative path, and those are not packages, so no dependency scan finds them.
  const ownDir = asarNode(opened.header, segments.slice(0, -1).join('/'))
  for (const [rel, bytes] of asarSubtreeFiles(opened, ownDir)) {
    if (rel.includes('/')) continue
    files.push([`entry/${rel}`, bytes])
  }
  const queue = []
  for (const [, bytes] of files) {
    if (bytes === undefined) continue
    for (const specifier of bareSpecifiers(bytes.toString('utf8'))) queue.push(specifier)
  }

  while (queue.length > 0) {
    const specifier = queue.shift()
    const name = packageOfSpecifier(specifier)
    if (written.has(name)) continue
    written.add(name)
    const packageDir = packages.get(name)
    if (packageDir === undefined) continue
    const node = asarNode(opened.header, packageDir)
    if (node === undefined) continue
    for (const [rel, bytes] of asarSubtreeFiles(opened, node)) {
      files.push([`entry/node_modules/${name}/${rel}`, bytes])
      if (rel.endsWith('.js') || rel.endsWith('.mjs') || rel.endsWith('.cjs')) {
        for (const nested of bareSpecifiers(bytes.toString('utf8'))) queue.push(nested)
      }
    }
  }

  mkdirSync(dir, { recursive: true })
  for (const [rel, bytes] of files) {
    const target = join(dir, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
  }
  return { entry: join(dir, `entry/${entryName}`), packages: [...written].sort() }
}

