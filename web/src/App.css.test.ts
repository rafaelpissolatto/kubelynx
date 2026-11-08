import { describe, expect, it } from 'vitest'
import css from './App.css?raw'

// The header chips (theme, display, bands, protocol, source) share selector
// groups for their hover / selected / focus states. #87: when the groups were
// merged, one member lost its qualifier, so every band chip matched the
// "selected" rule and all of them looked pressed. Guard against a chip in a
// state group that doesn't carry that group's state.

const STATE_QUALIFIERS = [":hover", "[aria-pressed='true']", ':focus-visible'] as const

function selectorGroups(source: string): string[][] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...withoutComments.matchAll(/([^{}]+)\{/g)]
    .map((match) => match[1].trim())
    .filter((selector) => !selector.startsWith('@'))
    .map((selector) => selector.split(',').map((part) => part.trim()))
}

describe('App.css chip state selectors', () => {
  const chipGroups = selectorGroups(css).filter((group) =>
    group.some((selector) => /__chip\b/.test(selector)),
  )

  it.each(STATE_QUALIFIERS)('every chip in a %s group carries the qualifier', (qualifier) => {
    const groups = chipGroups.filter((group) => group.some((s) => s.endsWith(qualifier)))
    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) {
      const unqualified = group.filter((s) => /__chip\b/.test(s) && !s.endsWith(qualifier))
      expect(unqualified, `group: ${group.join(', ')}`).toEqual([])
    }
  })

  it('covers the band arrangement chip in each state group', () => {
    for (const qualifier of STATE_QUALIFIERS) {
      expect(css).toContain(`.band-arrangement-toggle__chip${qualifier}`)
    }
  })
})
