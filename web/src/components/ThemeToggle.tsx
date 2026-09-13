import { THEMES, type Theme } from '../lib/theme'

interface ThemeToggleProps {
  selected: Theme
  onChange: (theme: Theme) => void
}

const LABELS: Record<Theme, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System',
}

export function ThemeToggle({ selected, onChange }: ThemeToggleProps) {
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {THEMES.map((theme) => (
        <button
          key={theme}
          type="button"
          className="theme-toggle__chip"
          aria-pressed={theme === selected}
          onClick={() => onChange(theme)}
        >
          {LABELS[theme]}
        </button>
      ))}
    </div>
  )
}
