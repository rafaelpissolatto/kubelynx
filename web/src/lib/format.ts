import type { Metric } from './topology'

const BYTE_RATE_UNITS = ['B/s', 'KB/s', 'MB/s', 'GB/s']

export function formatBytesPerSecond(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s'

  let value = bytesPerSecond
  let unitIndex = 0
  while (value >= 1024 && unitIndex < BYTE_RATE_UNITS.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${BYTE_RATE_UNITS[unitIndex]}`
}

// No unit-prefix scaling (K/M/...) the way formatBytesPerSecond does: a
// request rate rarely gets large enough in practice to need it, and ADR 0002
// / issue #61 only call for a plain "N req/s" label.
export function formatRequestsPerSecond(requestsPerSecond: number): string {
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) return '0 req/s'
  return `${requestsPerSecond.toFixed(requestsPerSecond < 10 ? 1 : 0)} req/s`
}

// formatRate dispatches on a Flow's Metric (ADR 0002's Flow.Rate +
// Flow.Metric) instead of every call site assuming "bytes" — the one place
// that decides which formatter a rate gets, so a byte rate and a request
// rate can never be mislabeled as each other (REQ-003/TASK-004).
export function formatRate(rate: number, metric: Metric): string {
  switch (metric) {
    case 'requests':
      return formatRequestsPerSecond(rate)
    case 'bytes':
    default:
      return formatBytesPerSecond(rate)
  }
}
