import { useCallback, useId, useRef, useState, type ReactNode } from 'react'
import { restoreFocus, useDismiss, type DismissReason } from '../lib/useDismiss'

interface HeaderMenuProps {
  // Visible trigger text, e.g. "Settings". Also names the panel.
  label: string
  // Which trigger edge the panel lines up with; 'end' keeps a menu at the
  // right of the header from running off-screen.
  align?: 'start' | 'end'
  children: ReactNode
}

// A text button with a chevron that toggles a panel of controls below it —
// the disclosure pattern (aria-expanded/aria-controls), not role="menu",
// because the panels hold ordinary form-like controls (chip groups) that
// keep their own Tab order. Settings ▾ uses it; Display ▾ (#76) is meant to
// as well, so both behave identically.
export function HeaderMenu({ label, align = 'start', children }: HeaderMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  const dismiss = useCallback((reason: DismissReason) => {
    setOpen(false)
    restoreFocus(triggerRef.current, reason)
  }, [])
  useDismiss(rootRef, open, dismiss)

  return (
    <div className="header-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="header-control header-menu__trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <ChevronDown />
      </button>
      <div
        id={panelId}
        className={`header-menu__panel header-menu__panel--${align}`}
        role="group"
        aria-label={label}
        hidden={!open}
      >
        {children}
      </div>
    </div>
  )
}

interface HeaderMenuSectionProps {
  title: string
  hint?: string
  children: ReactNode
}

export function HeaderMenuSection({ title, hint, children }: HeaderMenuSectionProps) {
  return (
    <section className="header-menu__section">
      <h2 className="header-menu__heading">{title}</h2>
      {children}
      {hint && <p className="header-menu__hint">{hint}</p>}
    </section>
  )
}

// Single stroke icon used for every header dropdown; decorative only, the
// text label carries the meaning.
export function ChevronDown() {
  return (
    <svg
      className="header-control__chevron"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 4.5 6 7.5 9 4.5" />
    </svg>
  )
}
