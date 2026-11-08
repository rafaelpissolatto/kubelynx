// Keyboard navigation for the focused graph canvas (issue #81), replacing
// the on-canvas pan arrows. Pure key -> action mapping; App.tsx applies the
// action to React Flow's viewport.

export type CanvasKeyAction =
  | { type: 'pan'; dx: number; dy: number }
  | { type: 'zoomIn' }
  | { type: 'zoomOut' }
  | { type: 'fit' }

// Screen pixels per arrow press, independent of zoom (React Flow's viewport
// x/y are a screen-space translation); Shift moves a bigger step.
const PAN_STEP = 80
const PAN_STEP_LARGE = 240

// The viewport moves opposite to the direction looked in: ArrowUp reveals
// what's above, so the content slides down (y increases).
const PAN_DIRECTIONS: Record<string, [number, number]> = {
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
  ArrowLeft: [1, 0],
  ArrowRight: [-1, 0],
}

// null for anything that isn't a canvas key, including chords with Ctrl,
// Meta or Alt, so browser zoom (Ctrl +/-) and other shortcuts pass through.
export function canvasKeyAction(event: {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): CanvasKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  const direction = PAN_DIRECTIONS[event.key]
  if (direction) {
    const step = event.shiftKey ? PAN_STEP_LARGE : PAN_STEP
    return { type: 'pan', dx: direction[0] * step, dy: direction[1] * step }
  }
  // '=' is the unshifted '+' key on most layouts.
  if (event.key === '+' || event.key === '=') return { type: 'zoomIn' }
  if (event.key === '-' || event.key === '_') return { type: 'zoomOut' }
  if (event.key === '0') return { type: 'fit' }
  return null
}
