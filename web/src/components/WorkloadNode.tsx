import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { WorkloadNodeData } from '../lib/layout'

export type WorkloadNodeType = { data: WorkloadNodeData }

export function WorkloadNode({ data }: NodeProps & WorkloadNodeType) {
  const { workload, ports } = data
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
      {/* Ports this workload receives traffic on (lib/layout.ts's
          workloadPorts), so they're readable on the block itself instead of
          only via hover-gated edge labels. */}
      {ports.length > 0 && (
        <div className="workload-node__ports">
          {ports.map((port) => (
            <span
              key={port}
              className={
                // Itemized ports read "TCP :80"; the aggregate bucket reads
                // "TCP multiple" (see portLabel in lib/layout.ts).
                port.includes(':') ? 'workload-node__badge' : 'workload-node__badge workload-node__badge--aggregate'
              }
            >
              {port}
            </span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="workload-node__handle" />
    </div>
  )
}
