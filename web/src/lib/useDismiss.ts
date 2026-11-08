import { useEffect, type RefObject } from 'react'

export type DismissReason = 'escape' | 'outside'

// Closes a header popover (Settings ▾, the namespace picker, and later
// Display ▾ from #76) the same way everywhere: Escape anywhere in the
// document, a pointer press outside `rootRef`, or keyboard focus moving out
// of it. Only listens while `open`, so idle menus cost nothing.
//
// `onDismiss` should be stable (useCallback) — it's an effect dependency.
export function useDismiss(
  rootRef: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: (reason: DismissReason) => void,
) {
  useEffect(() => {
    if (!open) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onDismiss('escape')
    }

    function onPointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) return
      onDismiss('outside')
    }

    // relatedTarget is null when the whole window loses focus (alt-tab);
    // that shouldn't close the menu, only tabbing to another control should.
    function onFocusOut(event: FocusEvent) {
      const next = event.relatedTarget as Node | null
      if (next && !rootRef.current?.contains(next)) onDismiss('outside')
    }

    const root = rootRef.current
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    root?.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
      root?.removeEventListener('focusout', onFocusOut)
    }
  }, [rootRef, open, onDismiss])
}

// Returns focus to a menu's trigger after it closes. Escape always does;
// an outside click only does when the click didn't land on something that
// takes focus itself (another control, a graph node) — the press has to
// finish first, hence the deferral past mousedown's default focus change.
export function restoreFocus(trigger: HTMLElement | null, reason: DismissReason) {
  if (!trigger) return
  if (reason === 'escape') {
    trigger.focus()
    return
  }
  setTimeout(() => {
    if (document.activeElement === document.body || document.activeElement === null) {
      trigger.focus({ preventScroll: true })
    }
  }, 0)
}
