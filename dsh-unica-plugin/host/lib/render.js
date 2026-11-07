/** Extract the text a model should read from an MCP result value. */
export function resultText(value) {
  const content = Array.isArray(value?.content) ? value.content : []
  const texts = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
  if (texts.length > 0) return texts.join('\n')

  const images = content.filter((block) => block?.type === 'image').map((block) => `[image ${block.mimeType ?? ''}]`)
  if (images.length > 0) return images.join('\n')

  if (value?.structuredContent !== undefined) return JSON.stringify(value.structuredContent, null, 2)
  return ''
}

/** Canonical value and its text projection for a `tools/call` result. */
export function normalizeResult(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const value = {
    content,
    ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
  }
  return { value, text: resultText(value) }
}
