import { BaseEdge, useInternalNode, getSmoothStepPath, type EdgeProps } from '@xyflow/react'
import { getEdgeParams } from '../lib/floatingEdge'

// Corner radius for the elbow bend — larger than smoothstep's tiny default
// so turns read as a deliberate curve rather than a sharp right angle.
const BORDER_RADIUS = 16

export function FloatingEdge({ id, source, target, markerEnd, style, label }: EdgeProps) {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)

  if (!sourceNode || !targetNode) return null

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(sourceNode, targetNode)

  const [path] = getSmoothStepPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos,
    borderRadius: BORDER_RADIUS,
  })

  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} label={label} />
}
