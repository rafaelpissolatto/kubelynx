import {
  EDGE_LABEL_MODES,
  LOW_TRAFFIC_CUTOFFS,
  type DisplayOptions,
  type EdgeLabelMode,
  type LowTrafficCutoff,
} from '../lib/displayOptions'
import { HeaderMenu, HeaderMenuSection } from './HeaderMenu'

interface DisplayMenuProps {
  options: DisplayOptions
  onChange: (options: DisplayOptions) => void
}

const EDGE_LABEL_LABELS: Record<EdgeLabelMode, string> = {
  none: 'None',
  rate: 'Rate',
  port: 'Port',
}

const CUTOFF_LABELS: Record<LowTrafficCutoff, string> = {
  0: 'Off',
  25: '25%',
  50: '50%',
  75: '75%',
}

interface ChoiceProps<T> {
  label: string
  choices: readonly T[]
  selected: T
  text: (choice: T) => string
  onChange: (choice: T) => void
}

// The same segmented control the bar and Settings use (aria-pressed chips in
// one bordered track), generic over the choice type.
function Choice<T extends string | number | boolean>({ label, choices, selected, text, onChange }: ChoiceProps<T>) {
  return (
    <div className="display-choice" role="group" aria-label={label}>
      {choices.map((choice) => (
        <button
          key={String(choice)}
          type="button"
          className="display-choice__chip"
          aria-pressed={choice === selected}
          onClick={() => onChange(choice)}
        >
          {text(choice)}
        </button>
      ))}
    </div>
  )
}

const ON_OFF = [true, false] as const
const onOffText = (on: boolean) => (on ? 'On' : 'Off')
const showHideText = (show: boolean) => (show ? 'Show' : 'Hide')

// How the graph is drawn (issue #76): edge labels, traffic animation,
// low-traffic edges, namespace bands, and the minimap (#81). Built on HeaderMenu exactly like
// SettingsMenu; App.tsx persists every change.
export function DisplayMenu({ options, onChange }: DisplayMenuProps) {
  const set = <K extends keyof DisplayOptions>(key: K, value: DisplayOptions[K]) =>
    onChange({ ...options, [key]: value })

  return (
    <HeaderMenu label="Display">
      <HeaderMenuSection title="Edge labels" hint="Shown on the hovered or selected flow.">
        <Choice
          label="Edge labels"
          choices={EDGE_LABEL_MODES}
          selected={options.edgeLabels}
          text={(mode) => EDGE_LABEL_LABELS[mode]}
          onChange={(mode) => set('edgeLabels', mode)}
        />
      </HeaderMenuSection>
      <HeaderMenuSection title="Traffic animation">
        <Choice
          label="Traffic animation"
          choices={ON_OFF}
          selected={options.trafficAnimation}
          text={onOffText}
          onChange={(on) => set('trafficAnimation', on)}
        />
      </HeaderMenuSection>
      <HeaderMenuSection
        title="Hide low-traffic flows"
        hint="Hides the lowest-rate share, ranked separately for bytes and requests. Workloads stay."
      >
        <Choice
          label="Hide low-traffic flows"
          choices={LOW_TRAFFIC_CUTOFFS}
          selected={options.lowTrafficCutoff}
          text={(cutoff) => CUTOFF_LABELS[cutoff]}
          onChange={(cutoff) => set('lowTrafficCutoff', cutoff)}
        />
      </HeaderMenuSection>
      <HeaderMenuSection title="Namespace bands">
        <Choice
          label="Namespace bands"
          choices={ON_OFF}
          selected={options.namespaceBands}
          text={showHideText}
          onChange={(show) => set('namespaceBands', show)}
        />
      </HeaderMenuSection>
      <HeaderMenuSection title="Minimap">
        <Choice
          label="Minimap"
          choices={ON_OFF}
          selected={options.minimap}
          text={showHideText}
          onChange={(show) => set('minimap', show)}
        />
      </HeaderMenuSection>
    </HeaderMenu>
  )
}
