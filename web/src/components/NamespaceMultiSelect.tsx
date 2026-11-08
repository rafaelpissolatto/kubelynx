import { useCallback, useRef, useState, type KeyboardEvent } from 'react'
import {
  dismissWarning,
  initialWarningState,
  isBroadSelection,
  matchingNamespaces,
  nextWarningState,
} from '../lib/namespacePrefix'
import { restoreFocus, useDismiss, type DismissReason } from '../lib/useDismiss'
import { ChevronDown } from './HeaderMenu'

interface NamespaceMultiSelectProps {
  namespaces: string[]
  allValue: string | null
  // From /api/config (--namespace-warn-threshold); 0 turns the warning off.
  warnThreshold: number
  selected: string[]
  onChange: (selected: string[]) => void
}

// A checkbox-based multi-select rather than a plain <select multiple>, with
// a filter box and a "Select all matching" action. There's no cap on how
// many namespaces can be selected (issue #86): a broad selection, i.e. at
// least warnThreshold namespaces from different prefix groups (or "All
// namespaces" on a cluster that big), gets a dismissible, non-blocking
// warning instead. See lib/namespacePrefix.ts for the rules.
export function NamespaceMultiSelect({
  namespaces,
  allValue,
  warnThreshold,
  selected,
  onChange,
}: NamespaceMultiSelectProps) {
  // <details> stays the element (native toggle on click/Enter/Space), but
  // its open state is mirrored here so it closes like the other header
  // menus: Escape, outside click, or tabbing away.
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const rootRef = useRef<HTMLDetailsElement>(null)
  const summaryRef = useRef<HTMLElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const dismiss = useCallback((reason: DismissReason) => {
    setOpen(false)
    restoreFocus(summaryRef.current, reason)
  }, [])
  useDismiss(rootRef, open, dismiss)

  const isAllSelected = allValue !== null && selected.includes(allValue)
  const selectedCount = isAllSelected ? namespaces.length : selected.length

  // Once per upward crossing: adjusted during render (not in an effect) so
  // the banner appears in the same paint as the checkbox change.
  const broad = isBroadSelection(selected, allValue, namespaces, warnThreshold)
  const [warning, setWarning] = useState(() => initialWarningState(broad))
  if (warning.broad !== broad) setWarning(nextWarningState(warning, broad))

  const needle = filter.trim().toLowerCase()
  const visibleNamespaces =
    needle === '' ? namespaces : namespaces.filter((ns) => ns.toLowerCase().includes(needle))
  const matching = matchingNamespaces(namespaces, filter, selected, allValue)
  // "All namespaces" already includes every match, so there's nothing to add.
  const toAdd = isAllSelected ? [] : matching.filter((ns) => !selected.includes(ns))

  const summary = isAllSelected
    ? 'All namespaces'
    : selected.length === 1
      ? selected[0]
      : `${selected.length} namespaces`

  function toggleAll() {
    if (isAllSelected) {
      if (namespaces.length === 0) return // keep at least one selected
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
      onChange([...selected, ns])
    }
  }

  function selectAllMatching() {
    if (toAdd.length > 0) onChange([...selected, ...toAdd])
  }

  // Focus moves to the filter box first: the dismiss button is about to
  // unmount, and focus falling to <body> would read as tabbing away.
  function dismissBanner() {
    filterRef.current?.focus()
    setWarning(dismissWarning)
  }

  function onDismissKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'Escape') return
    // Dismiss the banner only; don't let useDismiss close the whole panel.
    event.preventDefault()
    event.stopPropagation()
    dismissBanner()
  }

  const matchingLabel = needle !== '' ? `“${filter.trim()}”` : null

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
        <div className="namespace-multiselect__tools">
          <input
            ref={filterRef}
            type="search"
            className="namespace-multiselect__filter"
            placeholder="Filter namespaces"
            aria-label="Filter namespaces"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <button
            type="button"
            className="namespace-multiselect__select-matching"
            disabled={toAdd.length === 0}
            onClick={selectAllMatching}
            title={
              matchingLabel
                ? `Add every namespace containing ${matchingLabel}`
                : 'Add every namespace sharing the selection’s prefix (the part before the first “-”)'
            }
          >
            Select all matching{toAdd.length > 0 ? ` (${toAdd.length})` : ''}
          </button>
        </div>
        <div
          className="namespace-multiselect__warning-region"
          role="status"
          aria-live="polite"
        >
          {warning.visible && (
            <div className="namespace-multiselect__warning">
              <span>
                {isAllSelected
                  ? `All ${selectedCount} namespaces are selected.`
                  : `You've selected ${selectedCount} namespaces from different groups.`}{' '}
                Large graphs may render slowly.
              </span>
              <button
                type="button"
                className="namespace-multiselect__warning-dismiss"
                aria-label="Dismiss namespace warning"
                onClick={dismissBanner}
                onKeyDown={onDismissKeyDown}
              >
                ×
              </button>
            </div>
          )}
        </div>
        <div className="namespace-multiselect__list">
          {allValue !== null && (
            <label className="namespace-multiselect__option">
              <input type="checkbox" checked={isAllSelected} onChange={toggleAll} />
              All namespaces
            </label>
          )}
          {namespaces.length === 0 ? (
            <p className="namespace-multiselect__hint">No namespaces observed yet.</p>
          ) : visibleNamespaces.length === 0 ? (
            <p className="namespace-multiselect__hint">No namespaces match {matchingLabel}.</p>
          ) : (
            visibleNamespaces.map((ns) => (
              <label key={ns} className="namespace-multiselect__option">
                <input
                  type="checkbox"
                  checked={isAllSelected || selected.includes(ns)}
                  onChange={() => toggleNamespace(ns)}
                />
                {ns}
              </label>
            ))
          )}
        </div>
        {!isAllSelected && (
          <p className="namespace-multiselect__count">{selected.length} selected</p>
        )}
      </div>
    </details>
  )
}
