import { useReactFlow } from '@xyflow/react'

// How far one press moves the viewport, in screen pixels — independent of
// zoom level so the control feels equally responsive whether zoomed in or
// out (React Flow's viewport x/y are already screen-space translation, not
// world-space, so no zoom compensation is needed).
const PAN_STEP = 150

export function PanControls() {
  const { getViewport, setViewport } = useReactFlow()

  // Panning "up" reveals content above the current view, which means
  // sliding the content itself down (y increases) — and so on for the other
  // three directions, each the mirror image of the direction it reveals.
  function pan(dx: number, dy: number) {
    const { x, y, zoom } = getViewport()
    setViewport({ x: x + dx, y: y + dy, zoom }, { duration: 150 })
  }

  return (
    <div className="pan-controls" role="group" aria-label="Pan controls">
      <button
        type="button"
        className="pan-controls__btn pan-controls__btn--up"
        aria-label="Pan up"
        onClick={() => pan(0, PAN_STEP)}
      >
        ▲
      </button>
      <button
        type="button"
        className="pan-controls__btn pan-controls__btn--left"
        aria-label="Pan left"
        onClick={() => pan(PAN_STEP, 0)}
      >
        ◀
      </button>
      <button
        type="button"
        className="pan-controls__btn pan-controls__btn--right"
        aria-label="Pan right"
        onClick={() => pan(-PAN_STEP, 0)}
      >
        ▶
      </button>
      <button
        type="button"
        className="pan-controls__btn pan-controls__btn--down"
        aria-label="Pan down"
        onClick={() => pan(0, -PAN_STEP)}
      >
        ▼
      </button>
    </div>
  )
}
