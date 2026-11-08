import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Flow } from '../lib/topology'
import { FlowsTable } from './FlowsTable'
import { FlowDetailPanel } from './FlowDetailPanel'

const flow = (target: string, rate: number, extra: Partial<Flow> = {}): Flow => ({
  source: 'mesh-backend/backend',
  target: `mesh-backend/${target}`,
  protocol: 'http',
  port: '8080',
  rate,
  metric: 'requests',
  query: 'q',
  ...extra,
})

const istioFlows: Flow[] = [
  flow('db', 40, { security: 'mutual_tls' }),
  flow('cache', 30, { security: 'none' }),
  flow('queue', 20, { security: 'mixed', mtlsRatio: 0.8 }),
  flow('legacy', 10, { security: 'unknown' }),
]
const beylaFlows: Flow[] = [flow('db', 40, { metric: 'bytes' })]

function renderTable(flows: Flow[], source: string) {
  render(<FlowsTable flows={flows} selectedId={null} onSelect={vi.fn()} source={source} />)
}

const mtlsCells = () => screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[3]?.textContent)

describe('FlowsTable mTLS column', () => {
  it('shows an mTLS column for the Istio source, rows sorted by rate', () => {
    renderTable(istioFlows, 'istio')
    expect(screen.getByRole('columnheader', { name: 'mTLS' })).toBeInTheDocument()
    expect(mtlsCells()).toEqual(['yes', 'no', 'mixed (80 %)', 'unknown'])
  })

  it('has no mTLS column at all for the Beyla source', () => {
    renderTable(beylaFlows, 'beyla')
    expect(screen.queryByRole('columnheader', { name: 'mTLS' })).not.toBeInTheDocument()
    expect(within(screen.getAllByRole('row')[1]).getAllByRole('cell')).toHaveLength(3)
  })

  it('keeps the column while filtering', async () => {
    const user = userEvent.setup({ delay: null })
    renderTable(istioFlows, 'istio')
    await user.type(screen.getByRole('textbox', { name: 'Filter flows' }), 'queue')
    expect(mtlsCells()).toEqual(['mixed (80 %)'])
  })
})

describe('FlowDetailPanel mTLS row', () => {
  it('shows the mTLS status for an Istio flow', () => {
    render(<FlowDetailPanel flow={istioFlows[2]} />)
    expect(screen.getByText('mTLS: mixed (80 %)')).toBeInTheDocument()
  })

  it('shows nothing about mTLS for a Beyla flow', () => {
    render(<FlowDetailPanel flow={beylaFlows[0]} />)
    expect(screen.queryByText(/mTLS/)).not.toBeInTheDocument()
  })
})
