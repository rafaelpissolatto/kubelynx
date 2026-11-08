import { useMemo, useState } from 'react'
import { flowId, type Flow } from '../lib/topology'
import { formatRate } from '../lib/format'
import { matchesFlowFilter } from '../lib/flowFilter'

interface FlowsTableProps {
  flows: Flow[]
  // Flows the Display ▾ low-traffic cutoff keeps off the graph (issue #76).
  // They stay listed — the table is the complete record — but muted, with a
  // count above the table, and selecting one draws it on the graph anyway.
  hiddenIds?: Set<string>
  selectedId: string | null
  onSelect: (id: string) => void
}

export function FlowsTable({ flows, hiddenIds, selectedId, onSelect }: FlowsTableProps) {
  const [filterText, setFilterText] = useState('')

  // Filtering happens before sorting so it never disturbs the rate
  // descending order among whatever flows still match.
  const filtered = useMemo(
    () => flows.filter((flow) => matchesFlowFilter(flow, filterText)),
    [flows, filterText],
  )
  // Sorted on every render rather than once when the graph loads, so a
  // background refresh's updated rates keep the ordering current without
  // extra state to keep in sync. Sorts on the raw rate regardless of metric
  // (REQ-004) — a graph can mix byte-rate and request-rate flows (e.g. an
  // Istio source's TCP vs. HTTP/gRPC edges), so this is a within-column
  // ordering convenience, not a claim that the two units are comparable.
  const sorted = useMemo(() => [...filtered].sort((a, b) => b.rate - a.rate), [filtered])

  if (flows.length === 0) {
    return <p className="flows-table__empty">No flows to show.</p>
  }

  return (
    <div className="flows-table__container">
      <input
        type="text"
        className="flows-table__filter"
        placeholder="Filter by source or destination…"
        aria-label="Filter flows"
        value={filterText}
        onChange={(e) => setFilterText(e.target.value)}
      />
      {hiddenIds && hiddenIds.size > 0 && (
        <p className="flows-table__note">
          {hiddenIds.size} of {flows.length} flows hidden on the graph. Select one to show it.
        </p>
      )}
      {sorted.length === 0 ? (
        <p className="flows-table__empty">No flows match "{filterText}".</p>
      ) : (
        <table className="flows-table">
          <colgroup>
            <col />
            <col className="flows-table__col--port" />
            <col className="flows-table__col--bytes" />
          </colgroup>
          <thead>
            <tr>
              <th className="flows-table__head-cell">Flow</th>
              <th className="flows-table__head-cell">Port</th>
              <th className="flows-table__head-cell">Rate</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((flow) => {
              const id = flowId(flow)
              const selected = id === selectedId
              const hidden = hiddenIds?.has(id) ?? false
              return (
                <tr
                  key={id}
                  className={hidden ? 'flows-table__row flows-table__row--hidden' : 'flows-table__row'}
                  title={hidden ? 'Hidden on the graph (Display: hide low-traffic flows)' : undefined}
                  aria-selected={selected}
                  onClick={() => onSelect(id)}
                >
                  <td
                    className="flows-table__cell flows-table__flow-cell"
                    title={`${flow.source} → ${flow.target}`}
                  >
                    {flow.source} → {flow.target}
                  </td>
                  <td className="flows-table__cell">{flow.port || '—'}</td>
                  <td className="flows-table__cell">{formatRate(flow.rate, flow.metric)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
