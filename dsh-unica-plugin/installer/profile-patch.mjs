/** Adds `indent` to every non-empty line; blank lines stay blank. */
export function indentBlock(text, indent) {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : indent + line))
    .join('\n')
}

/** Leading-space width of a line. */
function indentWidth(line) {
  return line.match(/^( *)/)[1].length
}

/** Last line index (exclusive) of the entry, including any trailing comments. */
function findEntryEnd(lines, at) {
  for (let i = at + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue
    if (indentWidth(lines[i]) === 0 && !lines[i].startsWith('#')) return i
  }
  return lines.length
}

/** Match an id row without interpreting any other YAML content. */
function idRow(line, indent, id) {
  const prefix = `${indent}- id:`
  if (!line.startsWith(prefix)) return undefined
  const value = line.slice(prefix.length).match(/^\s+(?:'([^']*)'|"([^"]*)"|([^\s#]+))(?:\s+(#.*))?\s*$/)
  if (!value || (value[1] ?? value[2] ?? value[3]) !== id) return undefined
  return { comment: value[4] }
}

// Walk only direct children of a block. Deeper lines can contain arbitrary
// YAML, including persona text that happens to look like a bridge row.
function children(lines, parent) {
  if (parent === undefined) return []
  const width = indentWidth(lines[parent])
  const result = []
  let childWidth
  for (let i = parent + 1; i < lines.length; i++) {
    const trimmed = lines[i].trimStart()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = indentWidth(lines[i])
    if (indent <= width) break
    childWidth ??= indent
    if (indent === childWidth) result.push(i)
  }
  return result
}

function nativeConfig(lines, id) {
  function field(parent, key) {
    return children(lines, parent).find(i => lines[i].trim().replace(/\s+#.*$/, '') === key + ':')
  }
  if (id === 'unica-native') return field(0, 'config')
  if (id === 'preset-unica-1c') {
    const plugins = field(field(0, 'config'), 'plugins')
    const bridge = children(lines, plugins).find(i => idRow(lines[i].trimStart(), '', 'unica-native'))
    return field(bridge, 'config')
  }
}

// Only generated paths belong to the installer. Carry the user's other
// bridge options as source text, without parsing or evaluating !!js.
const USER_OPTIONS = new Set([
  'maxProcesses', 'idleMs', 'coldStartTimeoutMs', 'startupTimeoutMs', 'toolCallTimeoutMs',
  'serverName', 'nodePath', 'artifactDelivery', 'probeCwd', 'defaultCwd',
])

function optionKey(line) {
  const key = line.trimStart().match(/^(?:'([^']+)'|"([^"]+)"|(\w+))\s*:(?:\s|$)/)
  return key && (key[1] ?? key[2] ?? key[3])
}

function preserveBridgeOptions(generated, previous, id) {
  if (!previous || (id !== 'unica-native' && id !== 'preset-unica-1c')) return generated
  const saved = new Map()
  for (const i of children(previous, nativeConfig(previous, id))) {
    const key = optionKey(previous[i])
    if (!USER_OPTIONS.has(key)) continue
    const width = indentWidth(previous[i])
    let end = i + 1
    while (end < previous.length && (!previous[end].trim() || indentWidth(previous[end]) > width)) end++
    while (end > i + 1 && !previous[end - 1].trim()) end--
    saved.set(key, previous.slice(i, end).map(line => line.slice(width)).join('\n'))
  }
  if (!saved.size) return generated

  const lines = generated.split('\n')
  const fields = children(lines, nativeConfig(lines, id))
  if (!fields.length) return generated
  const indent = ' '.repeat(indentWidth(lines[fields[0]]))
  for (const i of fields) {
    const key = optionKey(lines[i])
    if (saved.has(key)) {
      lines[i] = indentBlock(saved.get(key), indent)
      saved.delete(key)
    }
  }
  lines.splice(fields.at(-1) + 1, 0, ...Array.from(saved.values(), value => indentBlock(value, indent)))
  return lines.join('\n')
}

// Carry the annotation on a managed id to its replacement. Preserve extra
// annotations from old duplicates, or from retired ids, at their source.
function retainComment(match, indent, annotation) {
  if (!match.comment) return []
  if (annotation && !annotation.comment) {
    annotation.comment = match.comment
    return []
  }
  return [indent + match.comment]
}

/**
 * Removes top-level entries with this id, keeping everything else intact.
 *
 * @returns the new file text, or `undefined` when the id has no top-level entry
 */
function removeTopLevelEntries(text, id, annotation) {
  const lines = text.split('\n')
  const kept = []
  let removed = false
  for (let i = 0; i < lines.length; i++) {
    const match = idRow(lines[i], '', id)
    if (!match) {
      kept.push(lines[i])
      continue
    }
    let end = findEntryEnd(lines, i)
    // A section comment immediately before the next row belongs to that row.
    while (end > i + 1 && (lines[end - 1].trim() === '' || lines[end - 1].startsWith('#'))) end--
    if (annotation) annotation.previous ??= lines.slice(i, end)
    kept.push(...retainComment(match, '', annotation))
    i = end - 1
    removed = true
  }
  return removed ? kept.join('\n') : undefined
}

/**
 * Splits a generated block into its top-level `- id:` entries.
 *
 * A patch addresses entries by id, so every entry has to be applied on its own:
 * upserting a block of two entries as one unit would append one of them twice.
 */
function splitEntries(block) {
  const lines = block.trimEnd().split('\n')
  const starts = []
  for (let i = 0; i < lines.length; i += 1) {
    if (/^- id: \S/.test(lines[i])) starts.push(i)
  }
  if (starts.length === 0) throw new Error('an entry block without a top-level `- id:` row cannot be applied by id')
  return starts.map((start, n) => lines.slice(start, n + 1 < starts.length ? starts[n + 1] : lines.length).join('\n').replace(/\s*$/, ''))
}

const insertHeader = /^- insert:(?:[ \t]+(#.*))?[ \t]*$/

/**
 * Drops the child row `id` from every `- insert:` list that carries it.
 *
 * @returns `{ text, removed }`
 */
function removeInsertChild(text, id, annotation) {
  const lines = text.split('\n')
  const out = []
  let removed = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (!insertHeader.test(lines[i])) {
      out.push(lines[i])
      continue
    }
    const end = findEntryEnd(lines, i)
    const payload = lines.slice(i + 1, end)
    let width = 0
    for (const line of payload) {
      if (line.trim() !== '' && !line.trimStart().startsWith('#')) {
        width = indentWidth(line)
        break
      }
    }
    const indent = ' '.repeat(width)
    const kept = []
    for (let j = 0; j < payload.length; j += 1) {
      const match = width > 0 && idRow(payload[j], indent, id)
      if (match) {
        const start = j
        kept.push(...retainComment(match, indent, annotation))
        // Indented content can include literal lines starting with '#'.
        // Keep section comments at the sequence indentation for the next row.
        for (let next = j + 1; next < payload.length; next += 1) {
          const line = payload[next]
          if (line.trim() === '') continue
          if (indentWidth(line) <= width) {
            if (line.trimStart().startsWith('#')) continue
            break
          }
          j = next
        }
        if (annotation) annotation.previous ??= payload.slice(start, j + 1)
        removed += 1
        continue
      }
      kept.push(payload[j])
    }
    out.push(lines[i], ...kept)
    i = end - 1
  }
  return { text: out.join('\n'), removed }
}

/**
 * Drops `- insert:` entries that no longer hold any child.
 *
 * Taking a row out of a list can leave its empty parent behind, and an empty
 * `insert:` is an entry DSH cannot make sense of.
 *
 * @returns `{ text, removed }`
 */
function removeEmptyInserts(text) {
  const lines = text.split('\n')
  const out = []
  let removed = 0
  for (let i = 0; i < lines.length; i += 1) {
    const header = insertHeader.exec(lines[i])
    if (header) {
      let j = i + 1
      while (j < lines.length && (lines[j].trim() === '' || lines[j].trimStart().startsWith('#'))) j += 1
      if (j >= lines.length || /^- /.test(lines[j])) {
        removed += 1
        if (header[1]) out.push(header[1])
        // Swallow the blank separator this entry owned, so no double blank line
        // is left where it stood.
        while (i + 1 < lines.length && lines[i + 1].trim() === '') i += 1
        continue
      }
    }
    out.push(lines[i])
  }
  return { text: out.join('\n'), removed }
}

/**
 * Normalises a profile patch before editing it.
 *
 * Every anchor in this file ends a line, and a Windows editor writes CRLF, so a
 * `^`-to-`$` match would silently miss — which once produced a duplicate
 * `mcp-unica` row instead of an error. The BOM some editors prepend is dropped
 * for the same reason: it would sit in front of the first entry.
 *
 * @returns `{ text, eol }` where eol is restored on the way out
 */
function normalizePatch(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return { text: text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), eol }
}

/** Merge generated rows into the original source, without parsing or evaluating !!js. */
export function editProfilePatch(raw, { banner = '', block, legacyIds = [] }) {
  const { text: existing, eol } = normalizePatch(raw)
  const rows = splitEntries(block)
  const ids = rows.map((row) => /^- id: (\S+)$/m.exec(row)[1])

  let text = existing
  const notes = []
  // A native-only release replaces the old MCP row: leaving it would register a
  // second set of tools under the same names.
  for (const legacy of legacyIds) {
    const stripped = removeInsertChild(text, legacy)
    if (stripped.removed > 0) {
      text = stripped.text
      notes.push(`${legacy}: removed the retired MCP row`)
    }
    const dropped = removeTopLevelEntries(text, legacy)
    if (dropped !== undefined) {
      text = dropped
      notes.push(`${legacy}: removed the retired top-level row`)
    }
  }
  for (const [i, id] of ids.entries()) {
    const annotation = {}
    const stripped = removeInsertChild(text, id, annotation)
    if (stripped.removed > 0) {
      text = stripped.text
      notes.push(`${id}: rewritten from a nested \`- insert:\` child`)
    }
    const deduped = removeTopLevelEntries(text, id, annotation)
    if (deduped !== undefined) {
      text = deduped
      notes.push(`${id}: replaced a top-level entry, which a patch cannot declare`)
    }
    rows[i] = preserveBridgeOptions(rows[i], annotation.previous, id)
    if (annotation.comment) rows[i] = rows[i].replace(/^[^\n]+/, line => line + '  ' + annotation.comment)
  }

  const entry = `- insert:\n${indentBlock(rows.join('\n\n'), '    ')}`
  text = `${text.replace(/\n*$/, '')}\n\n${entry}\n`
  text = removeEmptyInserts(text).text
  if (existing.trim() === '') text = `${banner}${text}`

  return { content: eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text, ids, notes }
}
