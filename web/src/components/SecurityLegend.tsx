import { useState } from 'react'
import { Panel } from '@xyflow/react'
import type { LegendStyle } from '../lib/flowSecurity'
import { EdgeLegendSample } from './FloatingEdge'

interface SecurityLegendProps {
  // The edge styles on the canvas right now (lib/flowSecurity.ts
  // legendStyles), so every drawn edge has exactly one row and no row
  // describes something the canvas isn't showing (#105).
  styles: readonly LegendStyle[]
  // Whether the legend starts expanded. App.tsx starts it collapsed on the
  // stacked phone layout (#97), where an open legend would cover edges.
  defaultOpen: boolean
}

const TEXT: Record<LegendStyle, string> = {
  mtls: 'mTLS',
  plaintext: 'Plaintext',
  mixed: 'Mixed mTLS / plaintext',
  unknown: 'mTLS unknown',
  plain: 'Plaintext or mixed (not highlighted)',
}

// Key for the mTLS edge styling (issues #90, #105), in the canvas's
// top-right corner (Controls hold bottom-left, the minimap bottom-right).
// App.tsx renders it only when some drawn edge is an Istio flow, so a Beyla
// graph never shows it. Each sample is drawn by EdgeLegendSample with the
// edge's own classes, line, arrowhead and badge, so it can't drift from the
// canvas; real text sits beside each sample, not icons alone. A native
// <details> disclosure, so it can be folded out of the way (keyboard and
// screen reader support come with the element).
export function SecurityLegend({ styles, defaultOpen }: SecurityLegendProps) {
  const [open, setOpen] = useState(defaultOpen)
  if (styles.length === 0) return null
  return (
    <Panel position="top-right" className="security-legend">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="security-legend__summary">mTLS legend</summary>
        <ul className="security-legend__list" aria-label="Edge mTLS legend">
          {styles.map((style) => (
            <li key={style} className="security-legend__row">
              <EdgeLegendSample variant={style === 'plain' ? null : style} />
              <span>{TEXT[style]}</span>
            </li>
          ))}
        </ul>
      </details>
    </Panel>
  )
}
