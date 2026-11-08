import { useEffect, type RefObject } from 'react'
import { useStore } from '@xyflow/react'

// Below this zoom, workload names at their designed 13px would render under
// ~11px on screen. SemanticZoom switches the canvas to compact detail there
// (issue #81): see .app__canvas[data-detail='compact'] in App.css.
const COMPACT_ZOOM = 11 / 13

// Quantized so a zoom gesture re-renders this a bounded number of times.
const useZoom = () => useStore((s) => Math.round(s.transform[2] * 100) / 100)

// Semantic zoom (issue #81). Publishes the current zoom on `target` (the
// canvas element around React Flow) as --zoom and data-detail, which
// App.css uses to keep workload names and namespace labels at a legible
// on-screen size and to drop the kind/port badges once they'd be too small
// to read. CSS only: node boxes
// keep their laid-out size, so layout, persisted positions and edge routes
// are untouched. Renders nothing.
export function SemanticZoom({ target }: { target: RefObject<HTMLElement | null> }) {
  const zoom = useZoom()
  useEffect(() => {
    const element = target.current
    if (!element) return
    element.style.setProperty('--zoom', String(zoom))
    element.setAttribute('data-detail', zoom < COMPACT_ZOOM ? 'compact' : 'full')
    return () => {
      element.style.removeProperty('--zoom')
      element.removeAttribute('data-detail')
    }
  }, [target, zoom])
  return null
}
