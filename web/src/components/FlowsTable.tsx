import { useMemo, useState } from 'react'
import { flowId, type Flow } from '../lib/topology'
import { formatBytesPerSecond } from '../lib/format'
import { matchesFlowFilter } from '../lib/flowFilter'

interface FlowsTableProps {
  flows: Flow[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export function FlowsTable({ flows, selectedId, onSelect }: FlowsTableProps) {
  const [filterText, setFilterText] = useState('')

  // Filtering happens before sorting so it never disturbs the bytes/s
  // descending order among whatever flows still match.
  const filtered = useMemo(
    () => flows.filter((flow) => matchesFlowFilter(flow, filterText)),
    [flows, filterText],
  )
  // Sorted on every render rather than once when the graph loads, so a
  // background refresh's updated rates keep the ordering current without
  // extra state to keep in sync.
  const sorted = useMemo(
    () => [...filtered].sort((a, b) => b.bytesPerSecond - a.bytesPerSecond),
    [filtered],
  )

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
              <th className="flows-table__head-cell">Bytes/s</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((flow) => {
              const id = flowId(flow)
              const selected = id === selectedId
              return (
                <tr
                  key={id}
                  className="flows-table__row"
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
                  <td className="flows-table__cell">{formatBytesPerSecond(flow.bytesPerSecond)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
