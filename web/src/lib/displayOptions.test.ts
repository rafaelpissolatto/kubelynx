import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_DISPLAY_OPTIONS, loadDisplayOptions, saveDisplayOptions } from './displayOptions'

const KEY = 'kubelynx.display'

afterEach(() => {
  localStorage.clear()
})

describe('display options persistence', () => {
  it('defaults highlightPlaintext to on', () => {
    expect(DEFAULT_DISPLAY_OPTIONS.highlightPlaintext).toBe(true)
    expect(loadDisplayOptions().highlightPlaintext).toBe(true)
  })

  it('round-trips highlightPlaintext under the shared storage key', () => {
    saveDisplayOptions({ ...DEFAULT_DISPLAY_OPTIONS, highlightPlaintext: false })
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').highlightPlaintext).toBe(false)
    expect(loadDisplayOptions().highlightPlaintext).toBe(false)
  })

  it('falls back to on when the stored value predates the option', () => {
    localStorage.setItem(KEY, JSON.stringify({ edgeLabels: 'rate', minimap: true }))
    const options = loadDisplayOptions()
    expect(options.highlightPlaintext).toBe(true)
    // The other fields still load: parsing is field by field.
    expect(options.edgeLabels).toBe('rate')
    expect(options.minimap).toBe(true)
  })

  it('falls back to on for a malformed value without discarding the rest', () => {
    localStorage.setItem(KEY, JSON.stringify({ highlightPlaintext: 'no', trafficAnimation: false }))
    const options = loadDisplayOptions()
    expect(options.highlightPlaintext).toBe(true)
    expect(options.trafficAnimation).toBe(false)
  })

  it('returns the defaults for unparseable JSON', () => {
    localStorage.setItem(KEY, '{not json')
    expect(loadDisplayOptions()).toEqual(DEFAULT_DISPLAY_OPTIONS)
  })
})
