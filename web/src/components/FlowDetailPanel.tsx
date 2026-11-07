import type { Flow } from '../lib/topology'
import { formatRate } from '../lib/format'

interface FlowDetailPanelProps {
  flow: Flow | null
}

export function FlowDetailPanel({ flow }: FlowDetailPanelProps) {
  if (!flow) {
    return (
      <div className="flow-detail flow-detail--empty">
        Select a flow to see the PromQL query behind it.
      </div>
    )
  }

  return (
    <div className="flow-detail">
      <div className="flow-detail__title">
        {flow.source} → {flow.target}
      </div>
      <div className="flow-detail__meta">
        {[flow.protocol, flow.port].filter(Boolean).join(' · ') || 'unknown protocol/port'} ·{' '}
        {formatRate(flow.rate, flow.metric)}
      </div>
      <pre className="flow-detail__query">{flow.query}</pre>
    </div>
  )
}
