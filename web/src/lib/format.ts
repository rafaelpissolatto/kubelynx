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
