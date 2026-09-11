// Locates the DSH installation, so tools can reach the packages it ships
// (js-yaml, dsh-agent-presets) without the plugin depending on them.
//
// Deliberately subprocess-free: spawning `where.exe` is denied inside a
// sandboxed DSH session (EPERM), and PATH scanning needs no spawn.
import { delimiter, join, sep } from 'node:path'

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
  if (explicit !== undefined && explicit !== '') roots.push(explicit)
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
