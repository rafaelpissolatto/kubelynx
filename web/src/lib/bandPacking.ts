import type { BandArrangement } from './bandArrangement'

// How namespace bands are placed relative to each other (issue #81).
// 'rows' fills each line left to right and stacks lines top to bottom;
// 'columns' fills each line top to bottom and sets lines side by side. One
// line of 'columns' is the classic vertical stack, one line of 'rows' the
// classic horizontal strip; more lines wrap the bands into a grid. Bands
// keep their (alphabetical) order either way, so a namespace is always
// found where reading order says it is.
export type BandShape = { flow: 'rows' | 'columns'; lines: number }

export type Size = { width: number; height: number }
export type Point = { x: number; y: number }

export const VERTICAL: BandShape = { flow: 'columns', lines: 1 }
export const HORIZONTAL: BandShape = { flow: 'rows', lines: 1 }

// Stable text form, used in the persisted-positions scope key (see
// positionScopeKey): 'vertical', 'horizontal', 'rows2', 'columns3', …
export function bandShapeKey(shape: BandShape): string {
  if (shape.lines === 1) return shape.flow === 'columns' ? 'vertical' : 'horizontal'
  return `${shape.flow}${shape.lines}`
}

// Beyond 100% a fit gains nothing worth trading a simpler shape for: names
// are already at their designed size.
const USEFUL_ZOOM = 1
// Shapes this close to the best fit count as equally good, and the simpler
// one (fewer lines, then vertical before horizontal) wins.
const TIE_TOLERANCE = 0.03
// On a refresh, the shape already on screen is kept while it's still this
// close to the best: a workload appearing shouldn't reshuffle every band.
const KEEP_TOLERANCE = 0.15

// Splits `lengths` (in order) into at most `lines` consecutive groups,
// minimising the longest group (sum of lengths plus `gap` between items) —
// the classic linear-partition DP. Returns each group's end index
// (exclusive).
function partition(lengths: number[], lines: number, gap: number): number[] {
  const n = lengths.length
  const k = Math.min(lines, n)
  const prefix = [0]
  for (const length of lengths) prefix.push(prefix[prefix.length - 1] + length)
  const span = (from: number, to: number) => prefix[to] - prefix[from] + gap * (to - from - 1)
  // best[j][i]: minimal longest group splitting the first i items into j groups.
  const best: number[][] = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(Infinity))
  const cut: number[][] = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(0))
  best[0][0] = 0
  for (let j = 1; j <= k; j++) {
    for (let i = j; i <= n; i++) {
      for (let p = j - 1; p < i; p++) {
        const cost = Math.max(best[j - 1][p], span(p, i))
        if (cost < best[j][i]) {
          best[j][i] = cost
          cut[j][i] = p
        }
      }
    }
  }
  const ends: number[] = []
  for (let j = k, i = n; j > 0; j--) {
    ends.unshift(i)
    i = cut[j][i]
  }
  return ends
}

// Places bands for one shape: returns each band's top-left corner and the
// bounding box of the whole arrangement.
export function placeBands(sizes: Size[], shape: BandShape, gap: number): { origins: Point[]; bounds: Size } {
  const rows = shape.flow === 'rows'
  const main = (s: Size) => (rows ? s.width : s.height)
  const cross = (s: Size) => (rows ? s.height : s.width)
  const ends = partition(sizes.map(main), shape.lines, gap)
  const origins: Point[] = []
  let crossOffset = 0
  let mainExtent = 0
  let start = 0
  for (const end of ends) {
    let mainOffset = 0
    let lineCross = 0
    for (let i = start; i < end; i++) {
      origins.push(rows ? { x: mainOffset, y: crossOffset } : { x: crossOffset, y: mainOffset })
      mainOffset += main(sizes[i]) + gap
      lineCross = Math.max(lineCross, cross(sizes[i]))
    }
    mainExtent = Math.max(mainExtent, mainOffset - gap)
    crossOffset += lineCross + gap
    start = end
  }
  const crossExtent = Math.max(0, crossOffset - gap)
  return { origins, bounds: rows ? { width: mainExtent, height: crossExtent } : { width: crossExtent, height: mainExtent } }
}

// The zoom at which `bounds` just fits `canvas` (React Flow's fitView
// padding is a constant factor, so it doesn't change which shape wins).
function fitZoom(bounds: Size, canvas: Size): number {
  if (bounds.width <= 0 || bounds.height <= 0) return USEFUL_ZOOM
  return Math.min(canvas.width / bounds.width, canvas.height / bounds.height)
}

function candidates(count: number): BandShape[] {
  const shapes: BandShape[] = [VERTICAL, HORIZONTAL]
  for (let lines = 2; lines < count; lines++) {
    shapes.push({ flow: 'rows', lines }, { flow: 'columns', lines })
  }
  return shapes
}

// Resolves a BandArrangement to a concrete shape. Explicit 'vertical' and
// 'horizontal' are taken as-is. 'auto' tries the single stack, the single
// strip and every wrapped grid of rows or columns, and keeps whichever lets
// the whole graph fit the canvas at the largest zoom — so a wide, short
// canvas with many namespaces gets a grid rather than a thin strip whose
// text is unreadable (issue #81). `preferred` (the shape already on screen)
// is kept while it's within KEEP_TOLERANCE of the best, so refreshes don't
// flip the arrangement over a small change in band sizes.
export function resolveBandShape(
  arrangement: BandArrangement,
  sizes: Size[],
  canvas: Size,
  gap: number,
  preferred: string | null = null,
): BandShape {
  if (arrangement === 'vertical') return VERTICAL
  if (arrangement === 'horizontal') return HORIZONTAL
  const scored = candidates(sizes.length).map((shape) => ({
    shape,
    score: Math.min(USEFUL_ZOOM, fitZoom(placeBands(sizes, shape, gap).bounds, canvas)),
  }))
  const best = Math.max(...scored.map((c) => c.score))
  const kept = preferred ? scored.find((c) => bandShapeKey(c.shape) === preferred) : undefined
  if (kept && kept.score >= best * (1 - KEEP_TOLERANCE)) return kept.shape
  return scored.find((c) => c.score >= best * (1 - TIE_TOLERANCE))!.shape
}
