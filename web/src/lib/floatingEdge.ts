import { Position, type InternalNode } from '@xyflow/react'

// Standard React Flow "floating edge" geometry: rather than anchoring at a
// fixed handle, each edge computes where it actually crosses the node's
// border along the line to the other node's center. This is what lets
// several edges touching the same node fan out naturally (each has a
// slightly different angle to its other endpoint) without needing a
// pre-allocated ladder of discrete handles on every node.
function getNodeIntersection(intersectionNode: InternalNode, targetNode: InternalNode) {
  const { width, height } = intersectionNode.measured
  const intersectionNodePosition = intersectionNode.internals.positionAbsolute
  const targetPosition = targetNode.internals.positionAbsolute

  const w = (width ?? 0) / 2
  const h = (height ?? 0) / 2

  const x2 = intersectionNodePosition.x + w
  const y2 = intersectionNodePosition.y + h
  const x1 = targetPosition.x + (targetNode.measured.width ?? 0) / 2
  const y1 = targetPosition.y + (targetNode.measured.height ?? 0) / 2

  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h)
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h)
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1)
  const xx3 = a * xx1
  const yy3 = a * yy1
  const x = w * (xx3 + yy3) + x2
  const y = h * (-xx3 + yy3) + y2

  return { x, y }
}

function getEdgePosition(node: InternalNode, intersectionPoint: { x: number; y: number }): Position {
  const { x: nx, y: ny } = node.internals.positionAbsolute
  const width = node.measured.width ?? 0
  const height = node.measured.height ?? 0
  const px = Math.round(intersectionPoint.x)
  const py = Math.round(intersectionPoint.y)

  if (px <= Math.round(nx) + 1) return Position.Left
  if (px >= Math.round(nx + width) - 1) return Position.Right
  if (py <= Math.round(ny) + 1) return Position.Top
  if (py >= Math.round(ny + height) - 1) return Position.Bottom
  return Position.Top
}

export function getEdgeParams(source: InternalNode, target: InternalNode) {
  const sourceIntersectionPoint = getNodeIntersection(source, target)
  const targetIntersectionPoint = getNodeIntersection(target, source)

  return {
    sx: sourceIntersectionPoint.x,
    sy: sourceIntersectionPoint.y,
    tx: targetIntersectionPoint.x,
    ty: targetIntersectionPoint.y,
    sourcePos: getEdgePosition(source, sourceIntersectionPoint),
    targetPos: getEdgePosition(target, targetIntersectionPoint),
  }
}
