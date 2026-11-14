/**
 * Recovering the record behind a selected row that carried no id.
 *
 * A List/Table whose rows are baked into props (the model copied the records
 * it had just fetched instead of binding `{"$data": …}`) renders fine but
 * selects blind: the row has no `id`, so `state.selected` stays unset and
 * every `{selected}` source — the detail's `GET /notes/{selected}`, the
 * delete rule — has nothing to resolve, leaving the opened page blank.
 *
 * The [data] snapshots usually still hold the very records the row shows, so
 * the row can be mapped BACK to its record: one whose scalar fields cover
 * EVERY value the row displayed is that record. Anything weaker (or two
 * candidates) is ambiguous and recovers nothing — a wrong id is worse than
 * none, and the turn-based path still answers for the row as before.
 */

/** The field names APIs use for a record's identity. */
const ID_KEYS = ['id', 'key', '_id', 'uuid', 'slug']

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** The record's identity under the names APIs use, as a string. */
function scalarId(rec: Record<string, unknown>): string | null {
  for (const k of ID_KEYS) {
    const v = rec[k]
    if (typeof v === 'string' && v !== '') return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return null
}

/** A scalar field's displayable text, matching how cells were rendered. */
function scalarText(v: unknown): string | null {
  if (typeof v === 'string' && v.trim() !== '') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

/**
 * What the pressed row showed: the visible cells (Table) and title (List),
 * plus any scalar fields the select event carried whole. The row's own words
 * are the claim this recovery is tested against.
 */
function visibleCells(data: Record<string, unknown> | undefined): string[] {
  if (!data) return []
  const out: string[] = []
  const add = (v: unknown): void => {
    const s = scalarText(v)
    if (s !== null && !out.includes(s)) out.push(s)
  }
  if (isRecord(data.row)) for (const v of Object.values(data.row)) add(v)
  add(data.title)
  if (isRecord(data.record)) for (const v of Object.values(data.record)) add(v)
  return out
}

/** Every record array a source snapshot holds (the array itself, or its fields'). */
function recordArrays(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (isRecord(value)) {
    const out: Record<string, unknown>[] = []
    for (const v of Object.values(value)) if (Array.isArray(v)) out.push(...v.filter(isRecord))
    return out
  }
  return []
}

/** Every value the row showed appears among the record's scalar fields. */
function covers(rec: Record<string, unknown>, cells: readonly string[]): boolean {
  const values = new Set<string>()
  for (const v of Object.values(rec)) {
    const s = scalarText(v)
    if (s !== null) values.add(s)
  }
  return cells.every((c) => values.has(c))
}

/**
 * The record a no-id select was really about, found in the live [data]
 * snapshots. Returns its id and the record itself (the true source row,
 * richer than the baked copy), or null when no single record accounts for
 * the whole row.
 */
export function recoverRowIdentity(
  data: Record<string, unknown> | undefined,
  snaps: Record<string, unknown>
): { id: string; record: Record<string, unknown> } | null {
  const cells = visibleCells(data)
  if (cells.length === 0) return null
  let hit: { id: string; record: Record<string, unknown> } | null = null
  for (const value of Object.values(snaps)) {
    for (const rec of recordArrays(value)) {
      const id = scalarId(rec)
      if (id === null || !covers(rec, cells)) continue
      if (hit !== null && hit.id !== id) return null // two records fit: no safe answer
      hit = hit ?? { id, record: rec }
    }
  }
  return hit
}
