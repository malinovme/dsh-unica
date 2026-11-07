import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The plugin root (`dsh-unica-plugin/`) that ships `bootstrap/launch.mjs`. */
export const DEFAULT_PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const DEFAULTS = {
  serverName: 'unica',
  nodePath: 'node',
  artifactDelivery: 'background',
  probeCwd: null,
  defaultCwd: null,
  maxProcesses: 4,
  idleMs: 10 * 60 * 1000,
  startupTimeoutMs: 30 * 1000,
  toolCallTimeoutMs: 10 * 60 * 1000,
}

/**
 * Resolve symlinks in the longest existing prefix.
 *
 * unica refuses a state root whose path still carries a symlink (macOS `/tmp`
 * is the common one): the daemon dies with `open daemon provider state root:
 * Not a directory`. Canonicalizing before the path reaches unica avoids it.
 */
export function canonicalPath(value) {
  let current = resolve(value)
  const tail = []
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(value)
      tail.push(basename(current))
      current = parent
    }
  }
}

/** Expand a leading `~` and make the path absolute and symlink-free. */
export function expandPath(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  return canonicalPath(expanded)
}

function positiveInteger(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value <= 0) throw new Error(`unica-native: ${field} must be a positive integer`)
  return value
}

/**
 * Validate the row config and fill defaults. Throwing here fails the plugin row
 * at activation, which is better than a half-working bridge.
 */
export function resolveConfig(raw, { pluginRoot = DEFAULT_PLUGIN_ROOT } = {}) {
  const config = raw ?? {}
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')

  return {
    serverName: config.serverName ?? DEFAULTS.serverName,
    nodePath: config.nodePath ?? DEFAULTS.nodePath,
    pluginRoot: expandPath(config.pluginRoot) ?? pluginRoot,
    runtimeCacheDir:
      expandPath(config.runtimeCacheDir) ??
      expandPath(process.env.UNICA_RUNTIME_CACHE_DIR) ??
      join(home, 'unica', 'runtimes'),
    providerStateDir:
      expandPath(config.providerStateDir) ??
      expandPath(process.env.UNICA_PROVIDER_STATE_DIR) ??
      join(home, 'unica', 'provider-state'),
    artifactDelivery: config.artifactDelivery ?? DEFAULTS.artifactDelivery,
    probeCwd: expandPath(config.probeCwd) ?? DEFAULTS.probeCwd,
    defaultCwd: expandPath(config.defaultCwd) ?? DEFAULTS.defaultCwd,
    maxProcesses: positiveInteger(config.maxProcesses, DEFAULTS.maxProcesses, 'maxProcesses'),
    idleMs: positiveInteger(config.idleMs, DEFAULTS.idleMs, 'idleMs'),
    startupTimeoutMs: positiveInteger(config.startupTimeoutMs, DEFAULTS.startupTimeoutMs, 'startupTimeoutMs'),
    toolCallTimeoutMs: positiveInteger(config.toolCallTimeoutMs, DEFAULTS.toolCallTimeoutMs, 'toolCallTimeoutMs'),
  }
}
