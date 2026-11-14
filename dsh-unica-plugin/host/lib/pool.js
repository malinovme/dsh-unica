import { realpathSync, statSync } from 'node:fs'
import { addAbortListener } from 'node:events'
import { resolve } from 'node:path'
import { UnicaProc } from './proc.js'

const UNLOADED = 'unica-native plugin unloaded'

/** Canonicalize an absolute directory; keep the resolved path when it is missing. */
export function canonicalCwd(cwd) {
  const absolute = resolve(cwd)
  try {
    if (!statSync(absolute).isDirectory()) return undefined
    return realpathSync.native(absolute)
  } catch {
    return undefined
  }
}

/**
 * A pool of unica processes keyed by working directory.
 *
 * The bridge never shares a process between directories: unica fixes its
 * workspace at startup, so a process is the workspace. Idle processes are
 * reaped; a busy one is never evicted.
 */
export class ProcPool {
  #entries = new Map()
  #pending = new Map()
  #timer
  #closed = false

  constructor(config, log) {
    this.config = config
    this.log = log
    this.#timer = setInterval(() => this.#reap(), Math.min(config.idleMs, 60_000))
    this.#timer.unref?.()
  }

  /** Run `fn` against the process for `cwd`, creating it on demand. */
  async withProc(cwd, fn, signal) {
    const entry = await this.#acquire(cwd, signal)
    if (this.#closed) throw new Error(UNLOADED)
    signal?.throwIfAborted()
    entry.busy += 1
    entry.lastUsed = Date.now()
    try {
      return await fn(entry.proc)
    } finally {
      entry.busy -= 1
      entry.lastUsed = Date.now()
    }
  }

  async #acquire(cwd, signal) {
    if (this.#closed) throw new Error(UNLOADED)
    signal?.throwIfAborted()
    const existing = this.#entries.get(cwd)
    if (existing !== undefined && existing.proc.alive) return existing

    let pending = this.#pending.get(cwd)
    if (pending === undefined) {
      const proc = new UnicaProc({ cwd, config: this.config, log: this.log })
      const started = this.#start(cwd, proc).finally(() => this.#pending.delete(cwd))
      pending = { proc, started }
      this.#pending.set(cwd, pending)
    }
    const { started } = pending
    if (!signal) return started

    // Only this caller stops waiting. Other calls may need the same handshake.
    let listener
    const aborted = new Promise((_, reject) => {
      listener = addAbortListener(signal, () => reject(signal.reason))
    })
    try {
      return await Promise.race([started, aborted])
    } finally {
      listener[Symbol.dispose]()
    }
  }

  async #start(cwd, proc) {
    const stale = this.#entries.get(cwd)
    if (stale !== undefined) {
      stale.proc.close('unica process was replaced')
      this.#entries.delete(cwd)
    }
    this.#makeRoom()

    try {
      await proc.start()
      if (this.#closed) throw new Error(UNLOADED)
      const entry = { proc, busy: 0, lastUsed: Date.now() }
      this.#entries.set(cwd, entry)
      this.log?.info?.(`unica-native: started unica in ${cwd}`)
      return entry
    } catch (error) {
      proc.close('unica process failed to start')
      if (!this.#closed) this.log?.error?.(`unica-native: failed to start unica in ${cwd}: ${error.message}`)
      throw error
    }
  }

  /** Evict idle processes until there is room for one more. */
  #makeRoom() {
    while (this.#entries.size >= this.config.maxProcesses) {
      const victim = [...this.#entries.entries()]
        .filter(([, entry]) => entry.busy === 0)
        .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0]
      if (victim === undefined) {
        this.log?.warn?.(
          `unica-native: ${this.#entries.size} unica processes are busy; exceeding maxProcesses=${this.config.maxProcesses}`,
        )
        return
      }
      const [cwd, entry] = victim
      entry.proc.close('unica process evicted because the pool is full')
      this.#entries.delete(cwd)
      this.log?.info?.(`unica-native: evicted idle unica in ${cwd}`)
    }
  }

  #reap() {
    const now = Date.now()
    for (const [cwd, entry] of this.#entries) {
      if (entry.busy > 0 || now - entry.lastUsed <= this.config.idleMs) continue
      entry.proc.close('unica process closed after idle timeout')
      this.#entries.delete(cwd)
      this.log?.info?.(`unica-native: closed idle unica in ${cwd}`)
    }
  }

  closeAll() {
    this.#closed = true
    clearInterval(this.#timer)
    for (const { proc } of this.#pending.values()) proc.close(UNLOADED)
    for (const { proc } of this.#entries.values()) proc.close(UNLOADED)
    this.#pending.clear()
    this.#entries.clear()
  }
}
