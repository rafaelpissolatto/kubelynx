import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { NamespaceMultiSelect } from './NamespaceMultiSelect'

const ALL = 'all'
const THRESHOLD = 6
const WARNING = /may render slowly/

// Stateful harness: the picker is controlled, so this plays App's part.
function Harness({
  namespaces,
  initial,
  threshold = THRESHOLD,
}: {
  namespaces: string[]
  initial: string[]
  threshold?: number
}) {
  const [selected, setSelected] = useState(initial)
  return (
    <>
      <NamespaceMultiSelect
        namespaces={namespaces}
        allValue={ALL}
        warnThreshold={threshold}
        selected={selected}
        onChange={setSelected}
      />
      <div data-testid="selected">{selected.join(',')}</div>
    </>
  )
}

const unrelated = Array.from({ length: 10 }, (_, i) => `group${i}-app`)

function setup(props: Parameters<typeof Harness>[0]) {
  // delay: null skips user-event's per-event setTimeout; keeps the suite fast.
  const user = userEvent.setup({ delay: null })
  render(<Harness {...props} />)
  return { user }
}

const checkbox = (name: string) => screen.getByRole('checkbox', { name })
const selectMatching = () => screen.getByRole('button', { name: /select all matching/i })
const warning = () => screen.queryByText(WARNING)
const selectedValue = () => screen.getByTestId('selected').textContent

async function check(user: ReturnType<typeof userEvent.setup>, names: string[]) {
  for (const name of names) await user.click(checkbox(name))
}

describe('NamespaceMultiSelect', () => {
  it('renders with 0 namespaces: empty text, "Select all matching" disabled, no warning', () => {
    setup({ namespaces: [], initial: ['default'] })
    expect(screen.getByText('No namespaces observed yet.')).toBeInTheDocument()
    expect(selectMatching()).toBeDisabled()
    expect(warning()).toBeNull()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('shows empty-state text and disables "Select all matching" when the filter matches nothing', async () => {
    const { user } = setup({ namespaces: unrelated, initial: [unrelated[0]] })
    await user.type(screen.getByRole('searchbox', { name: 'Filter namespaces' }), 'nope')
    expect(screen.getByText('No namespaces match “nope”.')).toBeInTheDocument()
    expect(selectMatching()).toBeDisabled()
  })

  it('never disables an option and has no selection cap', async () => {
    const { user } = setup({ namespaces: unrelated, initial: [unrelated[0]] })
    await check(user, unrelated.slice(1))
    expect(selectedValue()?.split(',')).toHaveLength(unrelated.length)
    for (const ns of unrelated) expect(checkbox(ns)).toBeEnabled()
    expect(screen.getByText(`${unrelated.length} selected`)).toBeInTheDocument()
  })

  it('shows no warning at threshold - 1 unrelated namespaces', async () => {
    const { user } = setup({ namespaces: unrelated, initial: [unrelated[0]] })
    await check(user, unrelated.slice(1, THRESHOLD - 1))
    expect(warning()).toBeNull()
  })

  it('warns once at exactly the threshold, inside a polite live region', async () => {
    const { user } = setup({ namespaces: unrelated, initial: [unrelated[0]] })
    await check(user, unrelated.slice(1, THRESHOLD))
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(within(status).getByText(WARNING)).toHaveTextContent(
      `You've selected ${THRESHOLD} namespaces from different groups.`,
    )
    expect(screen.getAllByText(WARNING)).toHaveLength(1)
  })

  it('does not steal focus from the checkbox that crossed the threshold', async () => {
    const { user } = setup({ namespaces: unrelated, initial: [unrelated[0]] })
    await check(user, unrelated.slice(1, THRESHOLD))
    expect(warning()).not.toBeNull()
    expect(checkbox(unrelated[THRESHOLD - 1])).toHaveFocus()
  })

  it('stays dismissed at threshold + 1, then reappears after dropping below and crossing again', async () => {
    const { user } = setup({ namespaces: unrelated, initial: [unrelated[0]] })
    await check(user, unrelated.slice(1, THRESHOLD))
    await user.click(screen.getByRole('button', { name: 'Dismiss namespace warning' }))
    expect(warning()).toBeNull()

    await check(user, [unrelated[THRESHOLD]]) // threshold + 1
    expect(warning()).toBeNull()

    await check(user, [unrelated[THRESHOLD], unrelated[THRESHOLD - 1]]) // back to threshold - 1
    expect(warning()).toBeNull()

    await check(user, [unrelated[THRESHOLD - 1]]) // threshold again
    expect(warning()).not.toBeNull()
  })

  it('dismisses with Escape on the dismiss button without closing the panel', async () => {
    const { user } = setup({ namespaces: unrelated, initial: [unrelated[0]] })
    const details = document.querySelector('details')!
    await user.click(screen.getByText(unrelated[0], { selector: 'span' }))
    expect(details.open).toBe(true)

    await check(user, unrelated.slice(1, THRESHOLD))
    screen.getByRole('button', { name: 'Dismiss namespace warning' }).focus()
    await user.keyboard('{Escape}')
    expect(warning()).toBeNull()
    expect(details.open).toBe(true)
    expect(screen.getByRole('searchbox', { name: 'Filter namespaces' })).toHaveFocus()
  })

  it('shows no warning for many namespaces sharing one prefix', async () => {
    const team = Array.from({ length: 12 }, (_, i) => `team-${i}`)
    const { user } = setup({ namespaces: team, initial: [team[0]] })
    await user.click(selectMatching())
    expect(selectedValue()?.split(',')).toHaveLength(team.length)
    expect(warning()).toBeNull()
  })

  it('treats 4x team-a-* + 2x team-b-* at the threshold as related (rule A: both are "team")', async () => {
    const mixed = ['team-a-1', 'team-a-2', 'team-a-3', 'team-a-4', 'team-b-1', 'team-b-2']
    const { user } = setup({ namespaces: mixed, initial: [mixed[0]] })
    await check(user, mixed.slice(1))
    expect(warning()).toBeNull()
  })

  it('"Select all matching" adds every namespace matching the filter', async () => {
    const cluster = ['demo-backend', 'team-a-dev', 'team-a-prod', 'team-b-dev']
    const { user } = setup({ namespaces: cluster, initial: ['demo-backend'] })
    await user.type(screen.getByRole('searchbox', { name: 'Filter namespaces' }), 'dev')
    expect(screen.queryByRole('checkbox', { name: 'team-a-prod' })).toBeNull()
    await user.click(selectMatching())
    expect(selectedValue()).toBe('demo-backend,team-a-dev,team-b-dev')
    expect(selectMatching()).toBeDisabled() // nothing left to add
  })

  it('never warns with threshold 0', async () => {
    const { user } = setup({ namespaces: unrelated, initial: [unrelated[0]], threshold: 0 })
    await check(user, unrelated.slice(1))
    await user.click(checkbox('All namespaces'))
    expect(warning()).toBeNull()
  })

  it('always offers "All namespaces" and warns when the cluster is at the threshold', async () => {
    const { user } = setup({ namespaces: unrelated, initial: [unrelated[0]] })
    await user.click(checkbox('All namespaces'))
    expect(selectedValue()).toBe(ALL)
    expect(warning()).toHaveTextContent(`All ${unrelated.length} namespaces are selected.`)
  })

  it('does not warn for "All namespaces" on a cluster below the threshold', async () => {
    const small = unrelated.slice(0, THRESHOLD - 1)
    const { user } = setup({ namespaces: small, initial: [small[0]] })
    await user.click(checkbox('All namespaces'))
    expect(warning()).toBeNull()
  })

  it('keeps at least one namespace selected', async () => {
    const { user } = setup({ namespaces: unrelated, initial: [unrelated[0]] })
    await user.click(checkbox(unrelated[0]))
    expect(selectedValue()).toBe(unrelated[0])
    expect(checkbox(unrelated[0])).toBeChecked()
  })
})
