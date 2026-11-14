import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_FLOWS_PANEL_WIDTH,
  MAX_FLOWS_PANEL_WIDTH,
  MIN_CANVAS_WIDTH,
  MIN_FLOWS_PANEL_WIDTH,
  STACKED_LAYOUT_MAX_WIDTH,
  clampFlowsPanelWidth,
  isStackedLayout,
  loadFlowsPanelWidth,
  saveFlowsPanelWidth,
} from './resizablePanel'

afterEach(() => {
  localStorage.clear()
})

describe('stacked layout breakpoint', () => {
  it('is derived from the panel and canvas minimums', () => {
    expect(STACKED_LAYOUT_MAX_WIDTH).toBe(MIN_FLOWS_PANEL_WIDTH + MIN_CANVAS_WIDTH)
    expect(STACKED_LAYOUT_MAX_WIDTH).toBe(760)
  })

  it('stacks below 760px only', () => {
    expect(isStackedLayout(360)).toBe(true)
    expect(isStackedLayout(390)).toBe(true)
    expect(isStackedLayout(759)).toBe(true)
    expect(isStackedLayout(760)).toBe(false)
    expect(isStackedLayout(1440)).toBe(false)
  })
})

describe('clampFlowsPanelWidth', () => {
  it('pins the panel to its minimum below the breakpoint, where the layout stacks', () => {
    expect(clampFlowsPanelWidth(500, 390)).toBe(MIN_FLOWS_PANEL_WIDTH)
    expect(clampFlowsPanelWidth(100, 390)).toBe(MIN_FLOWS_PANEL_WIDTH)
  })

  it('leaves the canvas exactly its minimum at the breakpoint', () => {
    const width = clampFlowsPanelWidth(500, 760)
    expect(width).toBe(MIN_FLOWS_PANEL_WIDTH)
    expect(760 - width).toBe(MIN_CANVAS_WIDTH)
  })

  it('keeps the canvas at least its minimum above the breakpoint', () => {
    expect(clampFlowsPanelWidth(600, 1000)).toBe(1000 - MIN_CANVAS_WIDTH)
    expect(clampFlowsPanelWidth(400, 1000)).toBe(400)
  })

  it('caps at the panel max and floors at the panel min on a wide viewport', () => {
    expect(clampFlowsPanelWidth(5000, 1920)).toBe(MAX_FLOWS_PANEL_WIDTH)
    expect(clampFlowsPanelWidth(10, 1920)).toBe(MIN_FLOWS_PANEL_WIDTH)
  })
})

describe('flows panel width persistence', () => {
  it('defaults when nothing is stored', () => {
    expect(loadFlowsPanelWidth()).toBe(DEFAULT_FLOWS_PANEL_WIDTH)
  })

  it('round-trips a saved width independent of the viewport', () => {
    saveFlowsPanelWidth(600)
    // Not clamped to the current window, so a phone-width load doesn't lose
    // the desktop width.
    expect(loadFlowsPanelWidth()).toBe(600)
  })

  it('bounds a stored value to the panel min/max', () => {
    saveFlowsPanelWidth(9999)
    expect(loadFlowsPanelWidth()).toBe(MAX_FLOWS_PANEL_WIDTH)
    saveFlowsPanelWidth(1)
    expect(loadFlowsPanelWidth()).toBe(MIN_FLOWS_PANEL_WIDTH)
  })

  it('defaults on a garbage stored value', () => {
    localStorage.setItem('kubelynx.flowsPanelWidth', 'wide')
    expect(loadFlowsPanelWidth()).toBe(DEFAULT_FLOWS_PANEL_WIDTH)
  })
})
