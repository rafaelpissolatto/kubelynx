import { useCallback, useRef, useState } from 'react'
import { restoreFocus, useDismiss, type DismissReason } from '../lib/useDismiss'
import { ChevronDown } from './HeaderMenu'

interface NamespaceMultiSelectProps {
  namespaces: string[]
  allValue: string | null
  max: number
  selected: string[]
  onChange: (selected: string[]) => void
}

// A checkbox-based multi-select rather than a plain <select multiple> —
// selection is capped at `max` namespaces at once (server-enforced too) so
// a large cluster can't be scoped into a graph too big for the browser to
// lay out and render (see issue #14). "All namespaces" is only offered when
// the cluster itself has few enough namespaces to be safe.
export function NamespaceMultiSelect({
  namespaces,
  allValue,
  max,
  selected,
  onChange,
}: NamespaceMultiSelectProps) {
  // <details> stays the element (native toggle on click/Enter/Space), but
  // its open state is mirrored here so it closes like the other header
  // menus: Escape, outside click, or tabbing away.
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDetailsElement>(null)
  const summaryRef = useRef<HTMLElement>(null)
  const dismiss = useCallback((reason: DismissReason) => {
    setOpen(false)
    restoreFocus(summaryRef.current, reason)
  }, [])
  useDismiss(rootRef, open, dismiss)

  const isAllSelected = allValue !== null && selected.includes(allValue)
  const allOptionAvailable = allValue !== null && namespaces.length <= max

  const summary = isAllSelected
    ? 'All namespaces'
    : selected.length === 1
      ? selected[0]
      : `${selected.length} namespaces`

  function toggleAll() {
    if (isAllSelected) {
      onChange(namespaces.slice(0, 1))
    } else if (allValue !== null) {
      onChange([allValue])
    }
  }

  function toggleNamespace(ns: string) {
    if (isAllSelected) {
      onChange([ns])
      return
    }
    if (selected.includes(ns)) {
      if (selected.length === 1) return // keep at least one namespace selected
      onChange(selected.filter((s) => s !== ns))
    } else {
      if (selected.length >= max) return // at the selection cap
      onChange([...selected, ns])
    }
  }

  return (
    <details
      className="namespace-multiselect"
      ref={rootRef}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        ref={summaryRef}
        className="header-control namespace-multiselect__summary"
        aria-label={`Namespaces: ${summary}`}
      >
        <span className="namespace-multiselect__value">{summary}</span>
        <ChevronDown />
      </summary>
      <div className="namespace-multiselect__panel">
        {allOptionAvailable && (
          <label className="namespace-multiselect__option">
            <input type="checkbox" checked={isAllSelected} onChange={toggleAll} />
            All namespaces
          </label>
        )}
        {!allOptionAvailable && allValue !== null && (
          <p className="namespace-multiselect__hint">
            Too many namespaces to select all at once — pick up to {max}.
          </p>
        )}
        {namespaces.map((ns) => {
          const checked = isAllSelected || selected.includes(ns)
          const disabled = !isAllSelected && !selected.includes(ns) && selected.length >= max
          return (
            <label
              key={ns}
              className="namespace-multiselect__option"
              aria-disabled={disabled || undefined}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => toggleNamespace(ns)}
              />
              {ns}
            </label>
          )
        })}
        {!isAllSelected && (
          <p className="namespace-multiselect__count">
            {selected.length} / {max} selected
          </p>
        )}
      </div>
    </details>
  )
}
