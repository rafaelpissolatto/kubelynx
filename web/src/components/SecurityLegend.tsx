import { Panel } from '@xyflow/react'
import type { EdgeSecurityVariant } from '../lib/flowSecurity'
import { SecurityIcon } from './SecurityGlyph'

interface SecurityLegendProps {
  // Display ▾ → Highlight plaintext edges. Off, the canvas draws plaintext
  // and mixed edges plainly, so the legend lists only what's still drawn.
  highlightPlaintext: boolean
}

const ROWS: { variant: EdgeSecurityVariant; text: string }[] = [
  { variant: 'mtls', text: 'mTLS' },
  { variant: 'plaintext', text: 'Plaintext' },
  { variant: 'mixed', text: 'Mixed mTLS / plaintext' },
]

// Key for the mTLS edge styling (issue #90), in the canvas's top-right
// corner (Controls hold bottom-left, the minimap bottom-right). App.tsx
// renders it only when at least one flow carries Flow.security, so a Beyla
// graph never shows it. Real text beside each sample, not icons alone.
export function SecurityLegend({ highlightPlaintext }: SecurityLegendProps) {
  const rows = highlightPlaintext ? ROWS : ROWS.filter((row) => row.variant === 'mtls')
  return (
    <Panel position="top-right" className="security-legend">
      <section aria-label="Edge mTLS legend">
        <ul className="security-legend__list">
          {rows.map(({ variant, text }) => (
            <li key={variant} className="security-legend__row">
              <svg className="security-legend__sample" width={28} height={8} aria-hidden="true" focusable="false">
                <line x1={1} y1={4} x2={27} y2={4} className={`security-legend__line security-legend__line--${variant}`} />
              </svg>
              <SecurityIcon variant={variant} />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      </section>
    </Panel>
  )
}
