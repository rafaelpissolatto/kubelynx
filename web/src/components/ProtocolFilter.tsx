import type { ProtocolFilter as ProtocolFilterValue } from '../lib/topology'

interface ProtocolFilterProps {
  protocols: ProtocolFilterValue[]
  selected: ProtocolFilterValue
  onChange: (protocol: ProtocolFilterValue) => void
}

const LABELS: Record<string, string> = {
  all: 'All',
  http: 'HTTP',
  grpc: 'gRPC',
  tcp: 'TCP',
}

function label(protocol: ProtocolFilterValue): string {
  return LABELS[protocol] ?? protocol.toUpperCase()
}

export function ProtocolFilter({ protocols, selected, onChange }: ProtocolFilterProps) {
  return (
    <div className="protocol-filter" role="group" aria-label="Protocol filter">
      {protocols.map((protocol) => (
        <button
          key={protocol}
          type="button"
          className="protocol-filter__chip"
          aria-pressed={protocol === selected}
          onClick={() => onChange(protocol)}
        >
          {label(protocol)}
        </button>
      ))}
    </div>
  )
}
