import type { Flow, SourceFilter } from './topology'

// Pure helpers for a Flow's mTLS status (issue #90): what the flow detail,
// flows table, edges and legend say and draw for it. Only Istio flows carry
// Flow.security; a Beyla flow has none, and every helper here returns
// null/false for it so Beyla renders exactly as before (CONTEXT.md, "Flow
// security"). Wording is "mTLS" / "plaintext", never "secure/insecure".

// The source whose flows carry Flow.security (ADR 0002's amendment). The
// flows table keys its mTLS column off the *active* source, as issue #90
// asks, rather than off the data, so an Istio graph always has the column.
export const ISTIO_SOURCE: SourceFilter = 'istio'

export function sourceReportsSecurity(source: SourceFilter): boolean {
  return source === ISTIO_SOURCE
}

// Whether any flow carries a security value — gates the canvas legend, so a
// Beyla graph (no flow has the field) shows none.
export function graphHasSecurity(flows: readonly Flow[]): boolean {
  return flows.some((flow) => flow.security !== undefined)
}

// mtlsRatio as a whole percentage, clamped to 0..100. null when absent or
// not a finite number.
export function mtlsPercent(ratio: number | undefined): number | null {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null
  return Math.min(100, Math.max(0, Math.round(ratio * 100)))
}

// The short status text the flow detail ("mTLS: …") and the flows table's
// mTLS column show: yes / no / mixed (NN %) / unknown. null for a flow with
// no security value (Beyla). A mixed flow without a usable ratio is just
// "mixed".
export function mtlsStatusText(flow: Flow): string | null {
  switch (flow.security) {
    case undefined:
      return null
    case 'mutual_tls':
      return 'yes'
    case 'none':
      return 'no'
    case 'mixed': {
      const pct = mtlsPercent(flow.mtlsRatio)
      return pct === null ? 'mixed' : `mixed (${pct} %)`
    }
    default:
      return 'unknown'
  }
}

// A longer description for tooltips and the edge badge's <title>.
export function mtlsDescription(flow: Flow): string | null {
  switch (flow.security) {
    case undefined:
      return null
    case 'mutual_tls':
      return 'mTLS'
    case 'none':
      return 'Plaintext (no mTLS)'
    case 'mixed': {
      const pct = mtlsPercent(flow.mtlsRatio)
      return pct === null ? 'Mixed mTLS and plaintext' : `Mixed: ${pct} % mTLS, ${100 - pct} % plaintext`
    }
    default:
      return 'mTLS status unknown'
  }
}

// How an edge is drawn for its mTLS status. Each variant pairs a glyph with
// a stroke pattern or badge, so none relies on color alone:
// - 'mtls': closed-lock badge; the line itself is unchanged.
// - 'plaintext': open-lock badge, dashed line, warning tint.
// - 'mixed': half-lock badge, dash-dot line, amber tint.
// null means "draw the edge as usual": Beyla (no security), 'unknown', and
// plaintext/mixed while Display ▾ → Highlight plaintext edges is off.
export type EdgeSecurityVariant = 'mtls' | 'plaintext' | 'mixed'

// The Display toggle governs only the plaintext/mixed *highlight*; the mTLS
// lock stays when it's off, since it marks the expected state rather than
// calling attention to a problem — and turning the toggle off should quiet
// the warnings, not erase positive information.
export function edgeSecurityVariant(flow: Flow | undefined, highlightPlaintext: boolean): EdgeSecurityVariant | null {
  switch (flow?.security) {
    case 'mutual_tls':
      return 'mtls'
    case 'none':
      return highlightPlaintext ? 'plaintext' : null
    case 'mixed':
      return highlightPlaintext ? 'mixed' : null
    default:
      return null
  }
}

// The glyph a flows-table cell or the flow detail shows next to its text
// (the text itself is the primary, non-color cue). null for unknown/absent.
export function securityGlyphVariant(flow: Flow): EdgeSecurityVariant | null {
  return edgeSecurityVariant(flow, true)
}
