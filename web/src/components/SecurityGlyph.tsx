import type { EdgeSecurityVariant } from '../lib/flowSecurity'

// Lock glyphs for a flow's mTLS status (issue #90), drawn in a 14×14 box
// centred on the origin so the edge badge, the legend, the flows table and
// the flow detail all share one shape. Colors come from currentColor, set by
// .security-glyph--<variant> in App.css from the --edge-mtls/-plaintext/
// -mixed tokens; the shapes alone already tell the three apart:
// - mtls: closed shackle, solid body.
// - plaintext: shackle swung open, solid body.
// - mixed: closed shackle, half-filled body.
const SHACKLE_CLOSED = 'M -3 -0.5 V -3 A 3 3 0 0 1 3 -3 V -0.5'
const SHACKLE_OPEN = 'M -3 -0.5 V -3 A 3 3 0 0 1 3 -3 V -4.5'

export function SecurityGlyphShape({ variant }: { variant: EdgeSecurityVariant }) {
  return (
    <g className={`security-glyph security-glyph--${variant}`}>
      <path
        d={variant === 'plaintext' ? SHACKLE_OPEN : SHACKLE_CLOSED}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
      {variant === 'mixed' ? (
        <>
          <rect x={-4.25} y={-0.25} width={8.5} height={6} rx={1} fill="none" stroke="currentColor" strokeWidth={1.5} />
          <rect x={-4.25} y={-0.25} width={4.25} height={6} rx={1} fill="currentColor" />
        </>
      ) : (
        <rect x={-5} y={-1} width={10} height={7.5} rx={1.5} fill="currentColor" />
      )}
    </g>
  )
}

// The glyph as a standalone inline icon, for HTML contexts. Decorative: the
// text beside it always says the same thing.
export function SecurityIcon({ variant }: { variant: EdgeSecurityVariant }) {
  return (
    <svg className="security-icon" width={12} height={12} viewBox="-7 -7 14 14" aria-hidden="true" focusable="false">
      <SecurityGlyphShape variant={variant} />
    </svg>
  )
}
