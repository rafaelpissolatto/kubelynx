import type { SourceFilter } from '../lib/topology'

interface SourceSelectorProps {
  sources: SourceFilter[]
  selected: SourceFilter
  onChange: (source: SourceFilter) => void
}

const LABELS: Record<string, string> = {
  beyla: 'Beyla',
  istio: 'Istio',
}

function label(source: SourceFilter): string {
  return LABELS[source] ?? source
}

// Mirrors ProtocolFilter's structure/styling (GUD-001): a chip group where
// clicking a chip calls back with the chosen value. Renders nothing once
// there's only a single source to pick from — a one-option toggle that can
// never change anything isn't a useful control, and this is also the shape
// /api/sources returns before it's heard back at all (see App.tsx's initial
// state), so this avoids a flash of a single disabled-looking chip.
export function SourceSelector({ sources, selected, onChange }: SourceSelectorProps) {
  if (sources.length <= 1) return null

  return (
    <div className="source-selector" role="group" aria-label="Metrics source">
      {sources.map((source) => (
        <button
          key={source}
          type="button"
          className="source-selector__chip"
          aria-pressed={source === selected}
          onClick={() => onChange(source)}
        >
          {label(source)}
        </button>
      ))}
    </div>
  )
}
