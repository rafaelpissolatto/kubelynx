import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { Workload } from '../lib/topology'

export type WorkloadNodeType = { data: { workload: Workload } }

export function WorkloadNode({ data }: NodeProps & WorkloadNodeType) {
  const { workload } = data
  return (
    <div className="workload-node">
      {/* Invisible — FloatingEdge (lib/floatingEdge.ts) computes each edge's
          actual attachment point from node geometry rather than a fixed
          handle, so these only exist to satisfy React Flow's node/edge
          wiring, not to be seen. */}
      <Handle type="target" position={Position.Left} className="workload-node__handle" />
      <div className="workload-node__name" title={workload.name}>
        {workload.name}
      </div>
      {workload.ownerKind && <span className="workload-node__badge">{workload.ownerKind}</span>}
      <Handle type="source" position={Position.Right} className="workload-node__handle" />
    </div>
  )
}
