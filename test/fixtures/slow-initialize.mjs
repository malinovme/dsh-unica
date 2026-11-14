// Make a 30-second initialize deadline expire immediately in the self-test child.
import { basename } from 'node:path'

if (basename(process.argv[1] ?? '') === 'selftest.js') {
  const schedule = globalThis.setTimeout
  globalThis.setTimeout = (callback, delay, ...args) =>
    schedule(callback, delay === 30_000 ? 1 : delay, ...args)
}
