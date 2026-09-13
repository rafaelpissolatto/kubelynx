import { BAND_ARRANGEMENTS, type BandArrangement } from '../lib/bandArrangement'

interface BandArrangementToggleProps {
  selected: BandArrangement
  onChange: (arrangement: BandArrangement) => void
}

const LABELS: Record<BandArrangement, string> = {
  vertical: 'Vertical',
  horizontal: 'Horizontal',
  auto: 'Auto',
}

export function BandArrangementToggle({ selected, onChange }: BandArrangementToggleProps) {
  return (
    <div className="band-arrangement-toggle" role="group" aria-label="Namespace band arrangement">
      {BAND_ARRANGEMENTS.map((arrangement) => (
        <button
          key={arrangement}
          type="button"
          className="band-arrangement-toggle__chip"
          aria-pressed={arrangement === selected}
          onClick={() => onChange(arrangement)}
        >
          {LABELS[arrangement]}
        </button>
      ))}
    </div>
  )
}
