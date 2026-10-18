import type { CardNode } from '../spec'

/**
 * Responsive placement for the 12-column card grid.
 *
 * The LLM lays a page out once, for a desktop-width grid (x/y/w/h). Real apps
 * reflow on smaller screens, so the runtime derives tablet and phone layouts
 * from that single spec instead of asking the model for three:
 *
 *   lg (desktop)  the spec as written — explicit columns, row spans
 *   md (tablet)   bands of small cards keep sharing a row, wide splits
 *                 (8/4, 9/3) stack, centered forms widen
 *   sm (phone)    one column, except KPI pairs and title + action rows
 *
 * Breakpoints are measured on the grid's own border box (not the window), so
 * a sidebar or split view pushes the content to the narrower layout naturally
 * — and the per-breakpoint padding can't feed back into the measurement.
 */

export type Breakpoint = 'sm' | 'md' | 'lg'

/** Minimum container widths (px) for each breakpoint. */
export const BREAKPOINT_MIN = { md: 600, lg: 920 } as const

export function breakpointFor(width: number): Breakpoint {
  if (width >= BREAKPOINT_MIN.lg) return 'lg'
  if (width >= BREAKPOINT_MIN.md) return 'md'
  return 'sm'
}

export interface Placement {
  /** CSS `grid-column` value. */
  column: string
  /** CSS `grid-row` value (desktop row spans only). */
  row?: string
  alignSelf?: 'center' | 'start'
  justifySelf?: 'start' | 'center' | 'end'
  /** Cap for centered single-column content (auth / form pages). */
  maxWidth?: number
  /** Inline controls should stretch to their cell (phone CTA rows). */
  fill?: boolean
}

export interface PlacedNode {
  node: CardNode
  /** Index in the original layout array (stable React key fallback). */
  index: number
  placement: Placement
}

/** Components that size to their content and sit beside a block (header actions). */
const INLINE = new Set(['Button', 'Badge', 'Chip', 'Link', 'Avatar', 'Spinner'])
/** Blocks that still read well two-up on a phone. */
const COMPACT = new Set(['StatCard'])
/** Max width for a lone centered column: ~440px login card up to ~800px form. */
const centeredMax = (w: number): number => Math.max(440, w * 100)

const isInline = (n: CardNode): boolean => INLINE.has(n.name)

interface Item {
  node: CardNode
  index: number
  x: number
  w: number
  h: number
  y: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** Sort by row then column; nodes without `grid` keep their array position. */
function toItems(nodes: CardNode[]): Item[] {
  let prevY = 0
  const items = nodes.map((node, index) => {
    const g = node.grid
    const x = g ? clamp(g.x, 0, 11) : 0
    const y = g ? g.y : prevY
    prevY = y
    return {
      node,
      index,
      x,
      // Unplaced nodes are full-width and sort after placed siblings of the same row.
      w: g ? clamp(g.w, 1, 12 - x) : 12,
      h: g ? clamp(g.h, 1, 24) : 1,
      y,
      sortX: g ? x : 99
    }
  })
  items.sort((a, b) => a.y - b.y || a.sortX - b.sortX || a.index - b.index)
  return items
}

function bands(items: Item[]): Item[][] {
  const out: Item[][] = []
  for (const item of items) {
    const last = out[out.length - 1]
    if (last && last[0].y === item.y) last.push(item)
    else out.push([item])
  }
  return out
}

const span = (n: number): string => `span ${n}`

function desktop(band: Item[]): PlacedNode[] {
  const hasInline = band.some((i) => isInline(i.node))
  const single = band.length === 1 ? band[0] : null
  const centered = single && !isInline(single.node) && single.x > 0 && single.x + single.w < 12
  return band.map((i) => {
    const p: Placement = { column: `${i.x + 1} / span ${i.w}`, row: span(i.h) }
    if (hasInline && i.h === 1) p.alignSelf = 'center'
    if (isInline(i.node) && i.x > 0 && i.x + i.w >= 12) p.justifySelf = 'end'
    if (centered) {
      p.justifySelf = 'center'
      p.maxWidth = centeredMax(i.w)
    }
    return { node: i.node, index: i.index, placement: p }
  })
}

/** Even split for a run of inline controls on a narrow screen. */
function inlineRow(inlines: Item[]): PlacedNode[] {
  const n = inlines.length
  const each = n <= 3 ? 12 / n : 6
  return inlines.map((i) => ({
    node: i.node,
    index: i.index,
    placement: { column: span(each), fill: i.node.name === 'Button' }
  }))
}

function reflow(band: Item[], bp: 'sm' | 'md'): PlacedNode[] {
  const blocks = band.filter((i) => !isInline(i.node))
  const inlines = band.filter((i) => isInline(i.node))
  const place = (i: Item, p: Placement): PlacedNode => ({
    node: i.node,
    index: i.index,
    placement: p
  })

  // Only inline controls (an action row): tablets keep the desktop split.
  if (blocks.length === 0) {
    if (bp === 'md') {
      return band.map((i) =>
        place(i, {
          column: `${i.x + 1} / span ${i.w}`,
          justifySelf: i.x > 0 && i.x + i.w >= 12 ? 'end' : undefined
        })
      )
    }
    return inlineRow(inlines)
  }

  // Title + actions header row.
  if (blocks.length === 1 && inlines.length > 0) {
    const block = blocks[0]
    if (bp === 'md') {
      const sizes = inlines.map((i) => clamp(i.w, 2, 4))
      const rest = 12 - sizes.reduce((a, b) => a + b, 0)
      if (rest >= 6) {
        return band.map((i) =>
          i === block
            ? place(i, { column: span(rest), alignSelf: 'center' })
            : place(i, {
                column: span(sizes[inlines.indexOf(i)]),
                alignSelf: 'center',
                justifySelf: i.x > block.x ? 'end' : 'start'
              })
        )
      }
    } else if (inlines.length === 1) {
      const inline = inlines[0]
      return band.map((i) =>
        i === inline
          ? place(i, {
              column: span(5),
              alignSelf: 'center',
              justifySelf: i.x > block.x ? 'end' : 'start'
            })
          : place(i, { column: span(7), alignSelf: 'center' })
      )
    }
    return [place(block, { column: span(12) }), ...inlineRow(inlines)]
  }

  // A lone block: centered narrow content widens, everything else goes full width.
  if (blocks.length === 1) {
    const b = blocks[0]
    const centered = b.x > 0 && b.x + b.w < 12 && b.w <= 8
    if (centered && bp === 'md') {
      const s = clamp(b.w + 2 + (b.w % 2), 8, 12)
      return [
        place(b, {
          column: `${(12 - s) / 2 + 1} / span ${s}`,
          justifySelf: 'center',
          maxWidth: centeredMax(b.w)
        })
      ]
    }
    return [
      place(
        b,
        centered
          ? { column: span(12), justifySelf: 'center', maxWidth: centeredMax(b.w) }
          : { column: span(12) }
      )
    ]
  }

  // Several blocks in one row: card rows (KPIs, 3-up cards) or a content split.
  const n = blocks.length
  const allSmall = blocks.every((b) => b.w <= 3)
  let sizes: number[]
  if (bp === 'md') {
    if (n >= 5) sizes = blocks.map(() => 4)
    else if (allSmall && n === 4) sizes = blocks.map(() => 6)
    else if (blocks.every((b) => b.w <= 6)) {
      const total = blocks.reduce((a, b) => a + b.w, 0)
      sizes = blocks.map((b) => clamp(Math.round((b.w * 12) / total), 3, 12))
    } else sizes = blocks.map(() => 12)
  } else {
    const twoUp = blocks.every((b) => COMPACT.has(b.node.name) || b.w <= 3)
    sizes = blocks.map(() => (twoUp ? 6 : 12))
  }
  return band.map((i) =>
    isInline(i.node)
      ? place(i, {
          column: span(bp === 'md' ? clamp(i.w, 3, 6) : 6),
          fill: i.node.name === 'Button'
        })
      : place(i, { column: span(sizes[blocks.indexOf(i)]) })
  )
}

/** Compute grid placement for every top-level node at a breakpoint, in render order. */
export function placeNodes(nodes: CardNode[], bp: Breakpoint): PlacedNode[] {
  const out: PlacedNode[] = []
  for (const band of bands(toItems(nodes))) {
    out.push(...(bp === 'lg' ? desktop(band) : reflow(band, bp)))
  }
  return out
}
