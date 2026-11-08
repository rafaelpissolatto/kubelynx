import type { Flow } from '../lib/topology'
import { formatRate } from '../lib/format'
import { mtlsDescription, mtlsStatusText, securityGlyphVariant } from '../lib/flowSecurity'
import { SecurityIcon } from './SecurityGlyph'

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

  // Istio flows only (issue #90): a Beyla flow has no security value, so no
  // row at all rather than "unknown".
  const mtls = mtlsStatusText(flow)
  const glyph = securityGlyphVariant(flow)

  return (
    <div className="flow-detail">
      <div className="flow-detail__title">
        {flow.source} → {flow.target}
      </div>
      <div className="flow-detail__meta">
        {[flow.protocol, flow.port].filter(Boolean).join(' · ') || 'unknown protocol/port'} ·{' '}
        {formatRate(flow.rate, flow.metric)}
      </div>
      {mtls !== null && (
        <div className="flow-detail__security" title={mtlsDescription(flow) ?? undefined}>
          {glyph && <SecurityIcon variant={glyph} />}
          mTLS: {mtls}
        </div>
      )}
      <pre className="flow-detail__query">{flow.query}</pre>
    </div>
  )
}
