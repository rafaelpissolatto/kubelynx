import { describe, expect, it } from 'vitest'
import type { Flow } from './topology'
import {
  edgeSecurityVariant,
  graphHasSecurity,
  mtlsDescription,
  mtlsPercent,
  mtlsStatusText,
  securityGlyphVariant,
  sourceReportsSecurity,
} from './flowSecurity'

const base: Flow = {
  source: 'mesh-backend/backend',
  target: 'mesh-backend/db',
  protocol: 'http',
  rate: 12.5,
  metric: 'requests',
  query: 'q',
}
const beyla: Flow = { ...base, metric: 'bytes' }
const mtls: Flow = { ...base, security: 'mutual_tls' }
const plaintext: Flow = { ...base, security: 'none' }
const mixed: Flow = { ...base, security: 'mixed', mtlsRatio: 0.8 }
const unknown: Flow = { ...base, security: 'unknown' }

describe('mtlsPercent', () => {
  it('rounds the ratio to a whole percentage', () => {
    expect(mtlsPercent(0.8)).toBe(80)
    expect(mtlsPercent(0.125)).toBe(13)
    expect(mtlsPercent(0)).toBe(0)
    expect(mtlsPercent(1)).toBe(100)
  })

  it('clamps out-of-range ratios', () => {
    expect(mtlsPercent(-0.2)).toBe(0)
    expect(mtlsPercent(1.4)).toBe(100)
  })

  it('returns null when the ratio is missing or not finite', () => {
    expect(mtlsPercent(undefined)).toBeNull()
    expect(mtlsPercent(Number.NaN)).toBeNull()
  })
})

describe('mtlsStatusText', () => {
  it('labels each Istio status', () => {
    expect(mtlsStatusText(mtls)).toBe('yes')
    expect(mtlsStatusText(plaintext)).toBe('no')
    expect(mtlsStatusText(mixed)).toBe('mixed (80 %)')
    expect(mtlsStatusText(unknown)).toBe('unknown')
  })

  it('says just "mixed" when the ratio is absent', () => {
    expect(mtlsStatusText({ ...base, security: 'mixed' })).toBe('mixed')
  })

  it('returns null for a Beyla flow, which has no security value', () => {
    expect(mtlsStatusText(beyla)).toBeNull()
    expect(mtlsDescription(beyla)).toBeNull()
  })

  it('never says secure/insecure', () => {
    for (const flow of [mtls, plaintext, mixed, unknown]) {
      expect(`${mtlsStatusText(flow)} ${mtlsDescription(flow)}`).not.toMatch(/secure/i)
    }
  })
})

describe('mtlsDescription', () => {
  it('spells out the mixed split', () => {
    expect(mtlsDescription(mixed)).toBe('Mixed: 80 % mTLS, 20 % plaintext')
    expect(mtlsDescription(plaintext)).toBe('Plaintext (no mTLS)')
  })
})

describe('edgeSecurityVariant', () => {
  it('maps each status to its edge style while the highlight is on', () => {
    expect(edgeSecurityVariant(mtls, true)).toBe('mtls')
    expect(edgeSecurityVariant(plaintext, true)).toBe('plaintext')
    expect(edgeSecurityVariant(mixed, true)).toBe('mixed')
    expect(edgeSecurityVariant(unknown, true)).toBeNull()
  })

  it('drops the plaintext/mixed highlight when off but keeps the mTLS lock', () => {
    expect(edgeSecurityVariant(mtls, false)).toBe('mtls')
    expect(edgeSecurityVariant(plaintext, false)).toBeNull()
    expect(edgeSecurityVariant(mixed, false)).toBeNull()
    expect(edgeSecurityVariant(unknown, false)).toBeNull()
  })

  it('never styles a Beyla edge, or an edge without a flow', () => {
    expect(edgeSecurityVariant(beyla, true)).toBeNull()
    expect(edgeSecurityVariant(undefined, true)).toBeNull()
  })

  it('gives table/detail glyphs regardless of the display toggle', () => {
    expect(securityGlyphVariant(plaintext)).toBe('plaintext')
    expect(securityGlyphVariant(unknown)).toBeNull()
    expect(securityGlyphVariant(beyla)).toBeNull()
  })
})

describe('graphHasSecurity', () => {
  it('is false for an empty or all-Beyla graph', () => {
    expect(graphHasSecurity([])).toBe(false)
    expect(graphHasSecurity([beyla, beyla])).toBe(false)
  })

  it('is true once any flow carries a security value, unknown included', () => {
    expect(graphHasSecurity([beyla, unknown])).toBe(true)
    expect(graphHasSecurity([mtls])).toBe(true)
  })
})

describe('sourceReportsSecurity', () => {
  it('is true only for istio', () => {
    expect(sourceReportsSecurity('istio')).toBe(true)
    expect(sourceReportsSecurity('beyla')).toBe(false)
    expect(sourceReportsSecurity('')).toBe(false)
  })
})
