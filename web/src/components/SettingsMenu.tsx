import type { Theme } from '../lib/theme'
import type { BandArrangement } from '../lib/bandArrangement'
import { HeaderMenu, HeaderMenuSection } from './HeaderMenu'
import { ThemeToggle } from './ThemeToggle'
import { BandArrangementToggle } from './BandArrangementToggle'

interface SettingsMenuProps {
  theme: Theme
  onThemeChange: (theme: Theme) => void
  bandArrangement: BandArrangement
  onBandArrangementChange: (arrangement: BandArrangement) => void
}

// App-level preferences that persist across reloads (both are saved to
// localStorage by App.tsx's handlers) and are rarely changed, so they live
// behind Settings ▾ instead of on the main bar (issue #74).
export function SettingsMenu({
  theme,
  onThemeChange,
  bandArrangement,
  onBandArrangementChange,
}: SettingsMenuProps) {
  return (
    <HeaderMenu label="Settings" align="end">
      <HeaderMenuSection title="Theme">
        <ThemeToggle selected={theme} onChange={onThemeChange} />
      </HeaderMenuSection>
      <HeaderMenuSection
        title="Namespace bands"
        hint="How bands are placed when more than one namespace is shown."
      >
        <BandArrangementToggle selected={bandArrangement} onChange={onBandArrangementChange} />
      </HeaderMenuSection>
    </HeaderMenu>
  )
}
