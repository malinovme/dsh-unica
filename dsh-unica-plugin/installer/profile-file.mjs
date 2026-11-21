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
    if (error.code === 'ENOENT' && dirname(path) !== path) {
      return join(await destination(dirname(path)), basename(path))
    }
    throw error
  }
  return destination(resolve(dirname(path), target))
}

async function stageFile(path, content, mode) {
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
    return temporary
  } catch (error) {
    await unlink(temporary)
    throw error
  }
}

async function readProfile(path) {
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`expected a regular profile file at ${path}`)
    const original = await readFile(path)
    return { path, original, content: original.toString('utf8'), mode: info.mode & 0o777 }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { path, original: null, content: '' }
  }
}

async function assertContents(path, expected) {
  let current
  try {
    current = await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT' && expected === null) return
    throw error
  }
  if (expected === null || !current.equals(expected)) throw new Error(`profile changed during installation: ${path}`)
}

/** Stage every destination first. Keep a rollback copy until all renames succeed. */
async function publishProfiles(changes) {
  const temporary = new Set()
  const published = []
  try {
    for (const profile of changes) {
      const { path, original, mode, content } = profile
      if (original === null) await mkdir(dirname(path), { recursive: true })
      else await access(path, constants.W_OK)
      profile.staged = await stageFile(path, content, mode)
      temporary.add(profile.staged)
      if (original !== null && profile !== changes.at(-1)) {
        profile.backup = await stageFile(path, original, mode)
        temporary.add(profile.backup)
      }
    }
    for (const profile of changes) {
      await assertContents(profile.path, profile.original)
      await rename(profile.staged, profile.path)
      temporary.delete(profile.staged)
      published.push(profile)
    }
  } catch (error) {
    const failures = []
    for (const profile of published.reverse()) {
      try {
        await assertContents(profile.path, Buffer.from(profile.content))
        if (profile.original === null) await unlink(profile.path)
        else await rename(profile.backup, profile.path)
      } catch (failure) {
        const saved = profile.backup ? `; original saved in ${profile.backup}` : ''
        failures.push(`could not restore ${profile.path}: ${failure.message}${saved}`)
      }
      temporary.delete(profile.backup)
    }
    if (failures.length) throw new Error([error.message, ...failures].join('\n'), { cause: error })
    throw error
  } finally {
    await Promise.all([...temporary].map(path => unlink(path)))
  }
}

export async function prepareProfileFiles(updates) {
  const profiles = new Map()
  const reports = new Map()
  const targets = new Map()
  for (const [path, edits] of updates) {
    // Two profile names may be symlinks to the same managed patch.
    const target = await destination(path)
    if (!profiles.has(target)) profiles.set(target, await readProfile(target))
    const profile = profiles.get(target)
    targets.set(path, profile)
    const entries = []
    for (const edit of edits) {
      const result = editProfilePatch(profile.content, edit)
      profile.content = result.content
      entries.push({ label: edit.label, ids: result.ids, notes: result.notes, customBridgeId: result.customBridgeId })
    }
    reports.set(path, entries)
  }
  async function publish() {
    const changed = [...profiles.values()].filter(p => p.content !== (p.original?.toString('utf8') ?? ''))
    await publishProfiles(changed)
  }
  return { reports, targets, publish }
}

export async function updateProfileFiles(updates, options) {
  const plan = await prepareProfileFiles(updates)
  if (!options?.dryRun) await plan.publish()
  return plan.reports
}

export async function updateProfileFile(path, edits, options) {
  return (await updateProfileFiles([[path, edits]], options)).get(path)
}
