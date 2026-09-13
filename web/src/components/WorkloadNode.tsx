import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { Workload } from '../lib/topology'

export type WorkloadNodeType = { data: { workload: Workload } }

export function WorkloadNode({ data }: NodeProps & WorkloadNodeType) {
  const { workload } = data
  return (
    <div className="workload-node">
      <Handle type="target" position={Position.Left} />
      <div className="workload-node__name" title={workload.name}>
        {workload.name}
      </div>
      {workload.ownerKind && <span className="workload-node__badge">{workload.ownerKind}</span>}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
