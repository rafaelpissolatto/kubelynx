import type { NodeProps } from '@xyflow/react'
import type { NamespaceBandData } from '../lib/layout'

export function NamespaceBand({ data }: NodeProps & { data: NamespaceBandData }) {
  return (
    <div className="namespace-band">
      <span className="namespace-band__label">{data.namespace}</span>
    </div>
  )
}
