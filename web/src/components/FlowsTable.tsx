import { useMemo } from 'react'
import { flowId, type Flow } from '../lib/topology'
import { formatBytesPerSecond } from '../lib/format'

interface FlowsTableProps {
  flows: Flow[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export function FlowsTable({ flows, selectedId, onSelect }: FlowsTableProps) {
  // Sorted by bytes/s descending on every render rather than once when the
  // graph loads, so a background refresh's updated rates keep the ordering
  // current without extra state to keep in sync.
  const sorted = useMemo(() => [...flows].sort((a, b) => b.bytesPerSecond - a.bytesPerSecond), [flows])

  if (sorted.length === 0) {
    return <p className="flows-table__empty">No flows to show.</p>
  }

  return (
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
  )
}
