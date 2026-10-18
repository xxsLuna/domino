import { z } from 'zod'

/**
 * UiSpec — the JSON tree the LLM emits to describe a rendered screen.
 * Every node has a `name` (the registered component name) and is laid out
 * on the 12-column card grid via `grid`.
 */

export const gridSchema = z.object({
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(999),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(50)
})

export type GridPlacement = z.infer<typeof gridSchema>

export interface CardNode {
  /** Component name as registered (e.g. "Button", "Table", "StatCard"). */
  name: string
  /** Unique id inside a page. Generated when omitted. */
  id?: string
  props?: Record<string, unknown>
  grid?: GridPlacement
  children?: CardNode[]
}

export interface PageSpec {
  id: string
  /** Human-readable page name shown in the toolbar. */
  name: string
  layout: CardNode[]
}

export interface UiSpec {
  version: 1
  /** Current page id. */
  page: string
  pages: PageSpec[]
}

/** An interaction captured from a rendered component, sent to the agent. */
export interface ActionEvent {
  pageId: string
  nodeId: string
  nodeName: string
  event: string
  data?: Record<string, unknown>
}

const cardNodeSchema: z.ZodType<CardNode> = z.lazy(() =>
  z.object({
    name: z.string().min(1),
    id: z.string().optional(),
    props: z.record(z.unknown()).optional(),
    grid: gridSchema.optional(),
    children: z.array(cardNodeSchema).optional()
  })
)

export const pageSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  layout: z.array(cardNodeSchema)
})

export const uiSpecSchema = z.object({
  version: z.literal(1),
  page: z.string().min(1),
  pages: z.array(pageSpecSchema).min(1)
})

/**
 * Tolerant parse used for LLM output: unknown fields are stripped,
 * structural problems throw. Ensures `page` exists in `pages`.
 */
export function validateUiSpec(input: unknown): UiSpec {
  const spec = uiSpecSchema.parse(input) as UiSpec
  if (!spec.pages.some((p) => p.id === spec.page)) {
    spec.page = spec.pages[0].id
  }
  return spec
}

/** Best-effort parse for streaming deltas (returns null until coherent). */
export function tryValidateUiSpec(input: unknown): UiSpec | null {
  try {
    return validateUiSpec(input)
  } catch {
    return null
  }
}

export function findPage(spec: UiSpec, pageId: string): PageSpec | undefined {
  return spec.pages.find((p) => p.id === pageId)
}

export function* iterateNodes(nodes: CardNode[]): Generator<CardNode> {
  for (const node of nodes) {
    yield node
    if (node.children) yield* iterateNodes(node.children)
  }
}

/** Stable key describing "which screen this is" for the session render cache. */
export function screenCacheKey(pageId: string, contextHash: string): string {
  return `${pageId}::${contextHash}`
}
