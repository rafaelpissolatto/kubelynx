import type { NodeProps } from '@xyflow/react'
import type { NamespaceBandData } from '../lib/layout'

export function NamespaceBand({ data }: NodeProps & { data: NamespaceBandData }) {
  return (
    <div className="namespace-band">
      {/* The band's drag handle (see dragHandle in lib/layout.ts): dragging
          the header moves the whole namespace, workloads included. */}
      <div className="namespace-band__header" title="Drag to move this namespace">
        <span className="namespace-band__label">{data.namespace}</span>
      </div>
    </div>
  )
}
