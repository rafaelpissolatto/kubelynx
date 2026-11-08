import { useId } from 'react'
import { flowId, type Flow, type Workload } from '../lib/topology'
import { formatRate } from '../lib/format'
import { rateTotals, splitWorkloadId, workloadFlows } from '../lib/workloadSelection'

interface WorkloadPanelProps {
  workloadId: string
  // null once the workload has dropped out of the latest refresh — the
  // selection is kept (it comes back if traffic resumes) but the panel says
  // it's no longer observed instead of silently showing empty lists.
  workload: Workload | null
  flows: Flow[]
  source: string
  selectedFlowId: string | null
  onSelectFlow: (id: string) => void
  // One-hop focus mode (issue #77): whether the graph dims everything outside
  // this workload's direct neighborhood.
  focusMode: boolean
  onFocusModeChange: (on: boolean) => void
  onClose: () => void
}

// Issue #75: what one Workload talks to, split by direction. A node is always
// a Workload (CONTEXT.md) — never labeled a Service here.
export function WorkloadPanel({
  workloadId,
  workload,
  flows,
  source,
  selectedFlowId,
  onSelectFlow,
  focusMode,
  onFocusModeChange,
  onClose,
}: WorkloadPanelProps) {
  const headingId = useId()
  const { namespace, name } = workload ?? splitWorkloadId(workloadId)
  const { inbound, outbound } = workloadFlows(workload ? flows : [], workloadId)

  return (
    <section className="workload-panel" aria-labelledby={headingId}>
      <div className="workload-panel__nav">
        <button type="button" className="workload-panel__back" onClick={onClose}>
          ← All flows
        </button>
        <button
          type="button"
          className="workload-panel__focus"
          aria-pressed={focusMode}
          title={focusMode ? 'Show the whole graph at full strength' : 'Dim everything but this workload and its direct peers'}
          onClick={() => onFocusModeChange(!focusMode)}
        >
          <span className="workload-panel__focus-box" aria-hidden="true" />
          Focus neighbors
        </button>
      </div>
      <div className="workload-panel__header">
        <h2 className="workload-panel__name" id={headingId} title={name}>
          {name}
        </h2>
        <dl className="workload-panel__facts">
          <div>
            <dt>Namespace</dt>
            <dd>{namespace || '—'}</dd>
          </div>
          <div>
            <dt>Kind</dt>
            <dd>{workload?.ownerKind || '—'}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{source || '—'}</dd>
          </div>
        </dl>
      </div>
      {workload ? (
        <>
          <PeerList
            title="Inbound"
            flows={inbound}
            peerOf={(flow) => flow.source}
            namespace={namespace}
            selectedFlowId={selectedFlowId}
            onSelectFlow={onSelectFlow}
          />
          <PeerList
            title="Outbound"
            flows={outbound}
            peerOf={(flow) => flow.target}
            namespace={namespace}
            selectedFlowId={selectedFlowId}
            onSelectFlow={onSelectFlow}
          />
        </>
      ) : (
        <p className="workload-panel__notice" role="status">
          <strong>No longer observed.</strong> The latest refresh has no traffic to or from this
          workload. It stays selected and reappears here if its traffic resumes.
        </p>
      )}
    </section>
  )
}

interface PeerListProps {
  title: string
  flows: Flow[]
  peerOf: (flow: Flow) => string
  // The selected workload's namespace: peers in it are shown by name alone,
  // peers elsewhere carry their namespace so cross-namespace hops (e.g. an
  // Istio waypoint or ztunnel in istio-system) stay unambiguous.
  namespace: string
  selectedFlowId: string | null
  onSelectFlow: (id: string) => void
}

function PeerList({ title, flows, peerOf, namespace, selectedFlowId, onSelectFlow }: PeerListProps) {
  const headingId = useId()
  const totals = rateTotals(flows)

  return (
    <section className="workload-panel__section" aria-labelledby={headingId}>
      <div className="workload-panel__section-head">
        <h3 className="workload-panel__section-title" id={headingId}>
          {title} <span className="workload-panel__count">{flows.length}</span>
        </h3>
        {totals.length > 0 && (
          <span className="workload-panel__totals" aria-label={`${title} total`}>
            {totals.map((total) => formatRate(total.rate, total.metric)).join(' · ')}
          </span>
        )}
      </div>
      {flows.length === 0 ? (
        <p className="workload-panel__empty">No {title.toLowerCase()} flows observed.</p>
      ) : (
        <ul className="workload-panel__peers">
          {flows.map((flow) => {
            const id = flowId(flow)
            const peer = splitWorkloadId(peerOf(flow))
            // "TCP :8080", like the node's port badges; Beyla's aggregated
            // bucket isn't a real port, so it reads "TCP multiple".
            const port = flow.port && (/^\d+$/.test(flow.port) ? `:${flow.port}` : flow.port)
            const protocolPort = [flow.protocol, port].filter(Boolean).join(' ')
            return (
              <li key={id}>
                <button
                  type="button"
                  className="workload-panel__peer"
                  aria-pressed={id === selectedFlowId}
                  title={`${flow.source} → ${flow.target}`}
                  onClick={() => onSelectFlow(id)}
                >
                  <span className="workload-panel__peer-name">
                    {peer.name}
                    {peer.namespace && peer.namespace !== namespace && (
                      <span className="workload-panel__peer-ns">{peer.namespace}</span>
                    )}
                  </span>
                  <span className="workload-panel__peer-port">{protocolPort || '—'}</span>
                  <span className="workload-panel__peer-rate">{formatRate(flow.rate, flow.metric)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
