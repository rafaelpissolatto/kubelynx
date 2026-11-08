import { describe, expect, it } from 'vitest'
import {
  commonPrefix,
  dismissWarning,
  initialWarningState,
  isBroadSelection,
  matchingNamespaces,
  namespacePrefix,
  nextWarningState,
  type WarningState,
} from './namespacePrefix'

const ALL = 'all'
const THRESHOLD = 6

// Distinct prefixes, so any n of them form an unrelated selection.
const unrelated = (n: number) => Array.from({ length: n }, (_, i) => `group${i}-app`)

describe('namespacePrefix', () => {
  it('takes the segment before the first dash', () => {
    expect(namespacePrefix('team-a-dev')).toBe('team')
    expect(namespacePrefix('kube-system')).toBe('kube')
  })

  it('returns the whole name when there is no dash', () => {
    expect(namespacePrefix('default')).toBe('default')
  })

  it('treats a leading dash as an empty prefix', () => {
    expect(namespacePrefix('-odd')).toBe('')
  })
})

describe('commonPrefix', () => {
  it('is null for an empty list', () => {
    expect(commonPrefix([])).toBeNull()
  })

  it('returns the shared prefix', () => {
    expect(commonPrefix(['team-a-dev', 'team-a-prod', 'team-b-qa'])).toBe('team')
  })

  it('is null when prefixes differ', () => {
    expect(commonPrefix(['team-a-dev', 'demo-backend'])).toBeNull()
  })
})

describe('isBroadSelection', () => {
  const cluster = unrelated(20)

  it('is not broad at threshold - 1 unrelated namespaces', () => {
    expect(isBroadSelection(unrelated(THRESHOLD - 1), ALL, cluster, THRESHOLD)).toBe(false)
  })

  it('is broad at exactly the threshold of unrelated namespaces', () => {
    expect(isBroadSelection(unrelated(THRESHOLD), ALL, cluster, THRESHOLD)).toBe(true)
  })

  it('is never broad when every namespace shares one prefix, however many', () => {
    const team = Array.from({ length: 50 }, (_, i) => `team-${i}`)
    expect(isBroadSelection(team, ALL, team, THRESHOLD)).toBe(false)
  })

  it('treats 4x team-a-* + 2x team-b-* as related: both groups are "team" under rule (A)', () => {
    const mixed = ['team-a-1', 'team-a-2', 'team-a-3', 'team-a-4', 'team-b-1', 'team-b-2']
    expect(mixed).toHaveLength(THRESHOLD)
    expect(isBroadSelection(mixed, ALL, mixed, THRESHOLD)).toBe(false)
  })

  it('is broad when one namespace from another group joins a large same-prefix selection', () => {
    const selection = ['team-a', 'team-b', 'team-c', 'team-d', 'team-e', 'demo-backend']
    expect(isBroadSelection(selection, ALL, cluster, THRESHOLD)).toBe(true)
  })

  it('is never broad with threshold 0 (warning off)', () => {
    expect(isBroadSelection(unrelated(50), ALL, cluster, 0)).toBe(false)
    expect(isBroadSelection([ALL], ALL, cluster, 0)).toBe(false)
  })

  it('treats "all namespaces" as broad once the cluster has threshold namespaces', () => {
    expect(isBroadSelection([ALL], ALL, unrelated(THRESHOLD - 1), THRESHOLD)).toBe(false)
    expect(isBroadSelection([ALL], ALL, unrelated(THRESHOLD), THRESHOLD)).toBe(true)
  })

  it('treats "all namespaces" as broad even when the cluster shares one prefix', () => {
    const team = Array.from({ length: THRESHOLD }, (_, i) => `team-${i}`)
    expect(isBroadSelection([ALL], ALL, team, THRESHOLD)).toBe(true)
  })

  it('is not broad with 0 namespaces in the cluster', () => {
    expect(isBroadSelection([ALL], ALL, [], THRESHOLD)).toBe(false)
    expect(isBroadSelection(['default'], ALL, [], THRESHOLD)).toBe(false)
  })
})

describe('matchingNamespaces', () => {
  const cluster = ['demo-backend', 'demo-frontend', 'team-a-dev', 'team-a-prod', 'team-b-dev']

  it('matches the filter text, case-insensitively, in cluster order', () => {
    expect(matchingNamespaces(cluster, ' DEV ', ['demo-backend'], ALL)).toEqual([
      'team-a-dev',
      'team-b-dev',
    ])
  })

  it('returns nothing when the filter matches nothing', () => {
    expect(matchingNamespaces(cluster, 'nope', ['demo-backend'], ALL)).toEqual([])
  })

  it('without a filter, matches the selection’s prefix group', () => {
    expect(matchingNamespaces(cluster, '', ['team-a-dev'], ALL)).toEqual([
      'team-a-dev',
      'team-a-prod',
      'team-b-dev',
    ])
  })

  it('without a filter, matches nothing when the selection spans groups', () => {
    expect(matchingNamespaces(cluster, '', ['team-a-dev', 'demo-backend'], ALL)).toEqual([])
  })

  it('without a filter, matches nothing while "all namespaces" is selected', () => {
    expect(matchingNamespaces(cluster, '', [ALL], ALL)).toEqual([])
  })

  it('matches nothing in an empty cluster', () => {
    expect(matchingNamespaces([], '', ['default'], ALL)).toEqual([])
    expect(matchingNamespaces([], 'x', ['default'], ALL)).toEqual([])
  })
})

describe('warning state', () => {
  // Feeds a sequence of selection sizes (unrelated namespaces) through the
  // state machine, returning whether the banner was visible after each.
  function run(sizes: number[], dismissAfter: number[] = []): boolean[] {
    let state: WarningState = initialWarningState(false)
    return sizes.map((n, i) => {
      state = nextWarningState(state, isBroadSelection(unrelated(n), ALL, [], THRESHOLD))
      const visible = state.visible
      if (dismissAfter.includes(i)) state = dismissWarning(state)
      return visible
    })
  }

  it('shows nothing below the threshold', () => {
    expect(run([1, 3, THRESHOLD - 1])).toEqual([false, false, false])
  })

  it('shows on the upward crossing to exactly the threshold', () => {
    expect(run([THRESHOLD - 1, THRESHOLD])).toEqual([false, true])
  })

  it('stays shown, without a new crossing, while above the threshold', () => {
    expect(run([THRESHOLD - 1, THRESHOLD, THRESHOLD + 1])).toEqual([false, true, true])
  })

  it('does not come back at threshold + 1 after being dismissed', () => {
    expect(run([THRESHOLD - 1, THRESHOLD, THRESHOLD + 1], [1])).toEqual([false, true, false])
  })

  it('shows again after dropping below the threshold and crossing again', () => {
    expect(run([THRESHOLD, THRESHOLD - 1, THRESHOLD], [0])).toEqual([true, false, true])
  })

  it('shows immediately when the first selection is already broad', () => {
    expect(initialWarningState(true)).toEqual({ broad: true, visible: true })
  })

  it('dismissing a hidden banner is a no-op', () => {
    const state = initialWarningState(false)
    expect(dismissWarning(state)).toBe(state)
  })
})
