/**
 * Determinate progress for the top rendering gauge.
 *
 * A turn has two visible phases: waiting for the model (text, API calls) and
 * the render_ui argument stream. Waiting has no measurable work, so it creeps
 * on elapsed time toward a low ceiling; streaming is measured against the size
 * the finished spec historically has. The number never reaches 100 on its own —
 * only a final spec completes the turn — so the bar always has somewhere to go.
 */

/** Assumed spec size until a final screen in this session teaches us better. */
export const DEFAULT_SPEC_CHARS = 4000

/** Waiting-phase ceiling: where the bar parks while nothing streams yet. */
export const CREEP_CEIL = 15

/** Elapsed ms at which the waiting creep reaches its ceiling. */
export const CREEP_MS = 8000

/** Streaming ceiling: the last 2% is reserved for the final spec arriving. */
export const STREAM_CEIL = 98

export interface RenderProgressInput {
  /** Milliseconds since the turn started. */
  elapsed: number
  /** render_ui argument characters streamed so far; 0 while still waiting. */
  chars: number
  /** EMA of final spec lengths from earlier renders; 0 = unknown. */
  specChars: number
}

/** 0–100, never 100: see the module note above. */
export function renderProgress(input: RenderProgressInput): number {
  const { elapsed, chars, specChars } = input
  if (chars > 0) {
    const target = specChars > 0 ? specChars : DEFAULT_SPEC_CHARS
    return Math.min(STREAM_CEIL, CREEP_CEIL + (83 * chars) / target)
  }
  return Math.min(CREEP_CEIL, (CREEP_CEIL * Math.max(0, elapsed)) / CREEP_MS)
}

/** Exponentially track the length of finished specs: 70% old, 30% new. */
export function nextSpecChars(prev: number, chars: number): number {
  if (!Number.isFinite(prev) || prev <= 0) return chars
  return Math.round(prev * 0.7 + chars * 0.3)
}
