import { PROTOCOL_FILTERS, type ProtocolFilter as ProtocolFilterValue } from '../lib/topology'

interface ProtocolFilterProps {
  selected: ProtocolFilterValue
  onChange: (protocol: ProtocolFilterValue) => void
}

const LABELS: Record<ProtocolFilterValue, string> = {
  all: 'All',
  http: 'HTTP',
  grpc: 'gRPC',
  tcp: 'TCP',
}

export function ProtocolFilter({ selected, onChange }: ProtocolFilterProps) {
  return (
    <div className="protocol-filter" role="group" aria-label="Protocol filter">
      {PROTOCOL_FILTERS.map((protocol) => (
        <button
          key={protocol}
          type="button"
          className="protocol-filter__chip"
          aria-pressed={protocol === selected}
          onClick={() => onChange(protocol)}
        >
          {LABELS[protocol]}
        </button>
      ))}
    </div>
  )
}
