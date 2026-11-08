import { useEffect, useState } from 'react'

interface RefreshStatusProps {
  // When the graph on screen was last fetched (ms since epoch); null until
  // the first load finishes.
  updatedAt: number | null
  paused: boolean
}

const TICK_MS = 1000

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

// The quiet "updated Ns ago" next to Pause/Resume. Deliberately not an
// aria-live region: it changes every second and would be noise to a screen
// reader; the absolute time is in the title for anyone who wants it.
export function RefreshStatus({ updatedAt, paused }: RefreshStatusProps) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (updatedAt === null) return
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [updatedAt])

  if (updatedAt === null) return null

  const age = formatAge(Math.max(0, now - updatedAt))
  return (
    <time
      className="refresh-status"
      dateTime={new Date(updatedAt).toISOString()}
      title={`Last updated ${new Date(updatedAt).toLocaleTimeString()}`}
    >
      {paused ? `Paused · updated ${age}` : `Updated ${age}`}
    </time>
  )
}
