/**
 * Best-effort parsing of *incomplete* JSON — the heart of progressive
 * streaming render: after tool-call argument deltas we salvage a coherent
 * object out of whatever prefix the model has emitted so far.
 *
 * Single pass: a small state machine walks the prefix once, remembers the
 * last position where the text can be cut and closed, then parses at most
 * twice. (Chopping a character at a time and re-parsing was O(n²) per delta,
 * which showed up as jank on phones while long specs streamed in.)
 */

interface Frame {
  arr: boolean
  /** What the container expects next. */
  state: 'key' | 'colon' | 'value' | 'comma'
}

const SCALAR = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/
const isSpace = (ch: string): boolean => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t'
const isDelimiter = (ch: string): boolean => ch === ',' || ch === '}' || ch === ']' || isSpace(ch)

function tryParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/**
 * Parse a prefix of JSON. Unterminated containers are closed, a value string
 * still being written is kept (so text appears as it streams), and dangling
 * keys/commas are dropped. Returns null until the prefix holds a value.
 */
export function parsePartialJson<T>(text: string): T | null {
  const start = text.search(/\S/)
  if (start < 0) return null
  if (text[start] !== '{' && text[start] !== '[') return tryParse<T>(text)

  const stack: Frame[] = []
  const closers = (): string => {
    let s = ''
    for (let k = stack.length - 1; k >= 0; k--) s += stack[k].arr ? ']' : '}'
    return s
  }
  let safePos = -1
  let safeClose = ''
  const markSafe = (pos: number): void => {
    safePos = pos
    safeClose = closers()
  }

  let inString = false
  let isKey = false
  let escaped = false
  let i = start
  const n = text.length

  scan: for (; i < n; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') {
        inString = false
        const top = stack[stack.length - 1]
        if (isKey) top.state = 'colon'
        else {
          top.state = 'comma'
          markSafe(i + 1)
        }
      }
      continue
    }
    if (isSpace(ch)) continue

    const top = stack[stack.length - 1]
    if (!top) {
      if (safePos >= 0) break // root value already closed
      stack.push({ arr: ch === '[', state: ch === '[' ? 'value' : 'key' })
      markSafe(i + 1)
      continue
    }

    const close = (): void => {
      stack.pop()
      const parent = stack[stack.length - 1]
      if (parent) parent.state = 'comma'
      markSafe(i + 1)
    }

    switch (top.state) {
      case 'key':
        if (ch === '"') {
          inString = true
          isKey = true
        } else if (ch === '}') close()
        else break scan
        continue
      case 'colon':
        if (ch !== ':') break scan
        top.state = 'value'
        continue
      case 'comma':
        if (ch === ',') top.state = top.arr ? 'value' : 'key'
        else if (ch === (top.arr ? ']' : '}')) close()
        else break scan
        continue
      case 'value': {
        if (ch === '"') {
          inString = true
          isKey = false
        } else if (ch === '{' || ch === '[') {
          top.state = 'comma'
          stack.push({ arr: ch === '[', state: ch === '[' ? 'value' : 'key' })
          markSafe(i + 1)
        } else if (ch === ']' && top.arr) close()
        else {
          let j = i
          while (j < n && !isDelimiter(text[j])) j++
          if (!SCALAR.test(text.slice(i, j))) break scan
          top.state = 'comma'
          markSafe(j)
          i = j - 1
        }
        continue
      }
    }
  }

  // A value string still streaming: keep what has arrived so far.
  if (inString && !isKey) {
    let end = n
    if (escaped) end -= 1
    const tail = /\\u[0-9a-fA-F]{0,3}$/.exec(text.slice(Math.max(0, end - 6), end))
    if (tail) end -= tail[0].length
    const value = tryParse<T>(text.slice(0, end) + '"' + closers())
    if (value !== null) return value
  }
  return safePos >= 0 ? tryParse<T>(text.slice(0, safePos) + safeClose) : null
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
