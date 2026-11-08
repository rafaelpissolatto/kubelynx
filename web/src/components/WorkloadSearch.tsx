import { useId, type RefObject } from 'react'

interface WorkloadSearchProps {
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  onQueryChange: (query: string) => void
  matchCount: number
  // Position of the match last stepped to with Enter, or -1 before the
  // first Enter (or once that workload stops matching).
  currentIndex: number
  onStep: (direction: 1 | -1) => void
}

// Header search (issue #77). Escape is deliberately not handled here: App's
// window-level handler clears the search first and the selection second,
// wherever focus happens to be.
export function WorkloadSearch({
  inputRef,
  query,
  onQueryChange,
  matchCount,
  currentIndex,
  onStep,
}: WorkloadSearchProps) {
  const statusId = useId()
  const active = query.trim() !== ''
  let status = ''
  if (active) {
    if (matchCount === 0) status = 'No matches'
    else if (currentIndex >= 0) status = `${currentIndex + 1} of ${matchCount}`
    else status = matchCount === 1 ? '1 match' : `${matchCount} matches`
  }

  return (
    <div className="workload-search" data-active={active || undefined}>
      <input
        ref={inputRef}
        type="text"
        className="workload-search__input"
        value={query}
        placeholder="Find workload"
        aria-label="Find workload by namespace/name. Enter steps through matches."
        aria-describedby={statusId}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || matchCount === 0) return
          event.preventDefault()
          onStep(event.shiftKey ? -1 : 1)
        }}
      />
      <span
        id={statusId}
        className={matchCount === 0 ? 'workload-search__status workload-search__status--none' : 'workload-search__status'}
        role="status"
      >
        {status}
      </span>
      {!active && (
        <kbd className="workload-search__hint" aria-hidden="true" title="Press / to search">
          /
        </kbd>
      )}
    </div>
  )
}
