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

/**
 * Removes the top-level entry with this id, keeping everything else intact.
 *
 * @returns the new file text, or `undefined` when the id has no top-level entry
 */
function removeTopLevelEntry(text, id) {
  const lines = text.split('\n')
  const at = lines.indexOf(`- id: ${id}`)
  if (at === -1) return undefined
  let end = findEntryEnd(lines, at)
  // A section comment immediately before the next row belongs to that row.
  while (end > at + 1 && (lines[end - 1].trim() === '' || lines[end - 1].startsWith('#'))) end--
  lines.splice(at, end - at)
  return lines.join('\n')
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

/**
 * Drops the child row `id` from every `- insert:` list that carries it.
 *
 * @returns `{ text, removed }`
 */
function removeInsertChild(text, id) {
  const lines = text.split('\n')
  const out = []
  let removed = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (indentWidth(lines[i]) !== 0 || lines[i] !== '- insert:') {
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
    const child = `${indent}- id: ${id}`
    const kept = []
    for (let j = 0; j < payload.length; j += 1) {
      if (width > 0 && payload[j] === child) {
        // The row owns the comment block directly above it.
        while (kept.length > 0 && kept.at(-1).startsWith(`${indent}#`)) kept.pop()
        // Comments can appear at any indentation inside the row. Advance
        // through its last field, leaving the next row and its comments intact.
        for (let next = j + 1; next < payload.length; next += 1) {
          const line = payload[next]
          if (line.trim() === '' || line.trimStart().startsWith('#')) continue
          if (indentWidth(line) <= width) break
          j = next
        }
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
    if (/^- insert:\s*$/.test(lines[i])) {
      let j = i + 1
      while (j < lines.length && (lines[j].trim() === '' || lines[j].trimStart().startsWith('#'))) j += 1
      if (j >= lines.length || /^- /.test(lines[j])) {
        removed += 1
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
    const dropped = removeTopLevelEntry(text, legacy)
    if (dropped !== undefined) {
      text = dropped
      notes.push(`${legacy}: removed the retired top-level row`)
    }
  }
  for (const id of ids) {
    const stripped = removeInsertChild(text, id)
    if (stripped.removed > 0) {
      text = stripped.text
      notes.push(`${id}: rewritten from a nested \`- insert:\` child`)
    }
    const deduped = removeTopLevelEntry(text, id)
    if (deduped !== undefined) {
      text = deduped
      notes.push(`${id}: replaced a top-level entry, which a patch cannot declare`)
    }
  }

  const entry = `- insert:\n${indentBlock(rows.join('\n\n'), '    ')}`
  text = `${text.replace(/[ \t]*\n*$/, '')}\n\n${entry}\n`
  text = removeEmptyInserts(text).text
  if (existing.trim() === '') text = `${banner}${text}`

  return { content: eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text, ids, notes }
}
