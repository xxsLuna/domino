import { hashContext } from '../session/session'
import type { KeyValueStorage } from '../session/prefs'

/**
 * API response schema memory.
 *
 * Remembering "which keys of which types this endpoint returned" lets the
 * runtime (a) tell the model what shapes earlier screens were built from, and
 * (b) detect when the same endpoint answers with keys added/removed/changed —
 * a cached screen built on the old shape is then invalid and must be redone.
 */

/** Longest type map kept per response: beyond this, shape diffing still works on what fits. */
const MAX_SCHEMA_KEYS = 50

/**
 * Endpoints remembered per domino. Path-parameter endpoints (`/leads/42`,
 * `/leads/43`, …) each take a slot, so without a cap the book would outgrow
 * localStorage on its own.
 */
const MAX_ENDPOINTS = 60

/**
 * Path expansion budget: root keys, one level of nesting, and the fields of
 * the first element of an array — enough for Table columns (`items[].name`)
 * without letting a deep payload blow up the prompt.
 */
const MAX_SCHEMA_DEPTH = 3

export interface SchemaDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

/** One remembered endpoint shape, persisted per domino. */
export interface RememberedSchema {
  fields: Record<string, string>
  at: number
}

/** endpoint key (`METHOD /path`) → remembered shape. */
export type SchemaBook = Record<string, RememberedSchema>

/** Stable identity of an API endpoint for schema memory. */
export function endpointKey(method: string | undefined, path: string): string {
  return `${(method ?? 'GET').toUpperCase()} ${path}`
}

/**
 * A flat `path → type` map of a response body: root keys, nested object keys
 * (`config.theme`), and first-element fields of arrays (`rows[].status`).
 * Values are type labels: `string`, `number`, `boolean`, `null`, `object`,
 * `array`, `array<object>`, `array<string>`, …
 */
export function describeApiSchema(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  describeValue(value, '', 1, out)
  return out
}

function describeValue(
  value: unknown,
  path: string,
  depth: number,
  out: Record<string, string>
): void {
  if (Object.keys(out).length >= MAX_SCHEMA_KEYS) return
  if (Array.isArray(value)) {
    out[path || 'value'] = arrayLabel(value)
    const first = value.find((el) => el !== null && el !== undefined)
    if (isPlainObject(first) && depth < MAX_SCHEMA_DEPTH) {
      describeObject(first, path ? `${path}[]` : 'value[]', depth + 1, out)
    }
    return
  }
  const obj = isPlainObject(value) ? value : null
  if (obj) {
    describeObject(obj, path, depth, out)
    return
  }
  out[path || 'value'] = typeLabel(value)
}

function describeObject(
  obj: Record<string, unknown>,
  path: string,
  depth: number,
  out: Record<string, string>
): void {
  for (const [key, value] of Object.entries(obj)) {
    if (Object.keys(out).length >= MAX_SCHEMA_KEYS) return
    const child = path ? `${path}.${key}` : key
    if (value !== null && typeof value === 'object') {
      // Deeper than the budget: record the subtree's type, don't expand it.
      if (depth >= MAX_SCHEMA_DEPTH) {
        out[child] = Array.isArray(value) ? arrayLabel(value) : 'object'
      } else {
        describeValue(value, child, depth + 1, out)
      }
    } else {
      out[child] = typeLabel(value)
    }
  }
}

/** `array<object>` / `array<string>` / `array` — labels only, never expands. */
function arrayLabel(value: unknown[]): string {
  const first = value.find((el) => el !== null && el !== undefined)
  return first === undefined ? 'array' : `array<${typeLabel(first)}>`
}

function typeLabel(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (isPlainObject(value)) return 'object'
  return typeof value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A short identity of a type map for cache invalidation: same keys/types in
 * any order → same hash. Not cryptographic — it only has to notice change.
 */
export function hashSchema(fields: Record<string, string>): string {
  const keys = Object.keys(fields).sort()
  const canonical = keys.map((k) => `${k}:${fields[k]}`).join('|')
  return hashContext(canonical)
}

/** Keys added / removed / type-changed between two shapes of the same endpoint. */
export function diffApiSchema(
  prev: Record<string, string>,
  next: Record<string, string>
): SchemaDiff {
  const diff: SchemaDiff = { added: [], removed: [], changed: [] }
  for (const key of Object.keys(next)) {
    if (!(key in prev)) diff.added.push(key)
    else if (prev[key] !== next[key]) diff.changed.push(key)
  }
  for (const key of Object.keys(prev)) {
    if (!(key in next)) diff.removed.push(key)
  }
  return diff
}

export function hasSchemaChange(diff: SchemaDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0
}

/** Endpoint → fields view of a book, the shape engine/prompt options take. */
export function bookFields(book: SchemaBook): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const [endpoint, remembered] of Object.entries(book)) out[endpoint] = remembered.fields
  return out
}

export function schemasKey(dominoId: string): string {
  return `domino:schemas:${dominoId}`
}

/** Record one response shape, evicting the least recently seen endpoint past the cap. */
export function rememberSchema(
  book: SchemaBook,
  endpoint: string,
  fields: Record<string, string>
): SchemaBook {
  const next: SchemaBook = { ...book, [endpoint]: { fields, at: Date.now() } }
  const keys = Object.keys(next)
  if (keys.length <= MAX_ENDPOINTS) return next
  // Oldest first (insertion order breaks same-millisecond ties); drop the excess.
  const oldest = keys.sort((a, b) => next[a].at - next[b].at).slice(0, keys.length - MAX_ENDPOINTS)
  for (const key of oldest) delete next[key]
  return next
}

/** Load a persisted book; any unreadable or malformed entry is simply forgotten. */
export async function loadSchemaBook(
  storage: KeyValueStorage,
  dominoId: string
): Promise<SchemaBook> {
  let raw: string | null = null
  try {
    raw = await storage.get(schemasKey(dominoId))
  } catch {
    return {}
  }
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const book: SchemaBook = {}
    for (const [endpoint, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as { fields?: unknown; at?: unknown } | null
      if (!v || typeof v !== 'object') continue
      if (typeof v.at !== 'number' || !v.fields || typeof v.fields !== 'object') continue
      book[endpoint] = { fields: v.fields as Record<string, string>, at: v.at }
    }
    return book
  } catch {
    return {}
  }
}

/** Persist a book; a storage failure must never break the session. */
export async function saveSchemaBook(
  storage: KeyValueStorage,
  dominoId: string,
  book: SchemaBook
): Promise<void> {
  try {
    await storage.set(schemasKey(dominoId), JSON.stringify(book))
  } catch {
    /* next successful save picks it up */
  }
}

/**
 * `# Known API responses` payload for the system prompt: one line per
 * endpoint, sorted for stability, truncated to `maxChars` total so memory of
 * past responses can never crowd out the rules.
 */
export function formatKnownSchemas(
  fields: Record<string, Record<string, string>>,
  maxChars = 2000
): string {
  const lines: string[] = []
  let used = 0
  for (const endpoint of Object.keys(fields).sort()) {
    const entry = Object.entries(fields[endpoint])
    if (!entry.length) continue
    const body = entry.map(([k, t]) => `${k}: ${t}`).join(', ')
    let line = `- ${endpoint} → {${body}}`
    if (line.length > 300) line = `${line.slice(0, 299)}…}`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}
