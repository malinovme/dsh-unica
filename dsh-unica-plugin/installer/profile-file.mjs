import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, open, readFile, readlink, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { editProfilePatch } from './profile-patch.mjs'

// Rename the target of a user-managed symlink, including a link to a new file.
async function destination(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  let target
  try {
    target = await readlink(path)
  } catch (error) {
    if (error.code === 'ENOENT') return path
    throw error
  }
  return destination(resolve(dirname(path), target))
}

async function replaceFile(path, content, mode) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', mode ?? 0o666)
  try {
    try {
      await file.writeFile(content, 'utf8')
      if (mode !== undefined) await file.chmod(mode)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary)
    throw error
  }
}

/** Apply all edits for one profile in memory, then publish the complete file once. */
export async function updateProfileFile(path, edits, { dryRun = false } = {}) {
  const target = await destination(path)
  let original = ''
  let mode
  try {
    const info = await stat(target)
    if (!info.isFile()) throw new Error(`expected a regular profile file at ${target}`)
    mode = info.mode & 0o777
    original = await readFile(target, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  let content = original
  const reports = []
  for (const edit of edits) {
    const result = editProfilePatch(content, edit)
    content = result.content
    reports.push({ label: edit.label, ids: result.ids, notes: result.notes })
  }
  if (!dryRun && content !== original) {
    if (mode !== undefined) await access(target, constants.W_OK)
    else await mkdir(dirname(target), { recursive: true })
    await replaceFile(target, content, mode)
  }
  return reports
}
