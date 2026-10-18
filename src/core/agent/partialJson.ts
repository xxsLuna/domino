/**
 * Best-effort parsing of *incomplete* JSON — the heart of progressive
 * streaming render: after every tool-call argument delta we try to salvage
 * a coherent object out of whatever prefix the model has emitted so far.
 */

/** Close open strings/brackets so the text becomes structurally balanced. */
function closeStructure(text: string): string {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }
  let out = text
  if (inString && !escaped) out += '"'
  else if (inString && escaped) out += '"'
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i]
  return out
}

/**
 * Parse a prefix of JSON. Returns the value once the prefix is coherent,
 * otherwise null. Chops at most `maxChop` trailing characters — enough to
 * drop a dangling `:`/`,`/partial literal.
 */
export function parsePartialJson<T>(text: string, maxChop = 200): T | null {
  if (!text.trim()) return null
  const limit = Math.min(maxChop, text.length)
  for (let chop = 0; chop <= limit; chop++) {
    const slice = text.slice(0, text.length - chop)
    if (!slice.trim()) break
    try {
      return JSON.parse(closeStructure(slice)) as T
    } catch {
      /* chop a trailing character and retry */
    }
  }
  return null
}

/**
 * Extract the `spec` object out of partial render_ui arguments
 * (`{"spec": {...` while still streaming) without needing the wrapper closed.
 */
export function extractPartialSpec(args: string): unknown | null {
  const keyed = /"spec"\s*:\s*\{/.exec(args)
  if (keyed) {
    const braceAt = args.indexOf('{', keyed.index + keyed[0].length - 1)
    if (braceAt >= 0) {
      const parsed = parsePartialJson<unknown>(args.slice(braceAt))
      if (parsed !== null) return parsed
    }
  }
  // Fallback: the whole argument blob might be the spec itself — but only
  // claim it once it looks like a spec (otherwise `{` alone would parse as {}).
  const trimmed = args.trimStart()
  if (trimmed.startsWith('{')) {
    const parsed = parsePartialJson<Record<string, unknown>>(args)
    if (parsed && ['version', 'page', 'pages'].some((k) => k in parsed)) return parsed
  }
  return null
}
