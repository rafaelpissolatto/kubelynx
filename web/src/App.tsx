import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './App.css'
import {
  fetchConfig,
  fetchNamespaces,
  fetchProtocols,
  fetchSources,
  fetchTopology,
  flowId,
  TopologyError,
  type Graph,
  type ProtocolFilter as ProtocolFilterValue,
  type SourceFilter,
} from './lib/topology'
import {
  finishLayout,
  planLayout,
  syncNamespaceBands,
  type NamespaceBandData,
  type WorkloadNodeData,
} from './lib/layout'
import type { Size } from './lib/bandPacking'
import { WorkloadNode } from './components/WorkloadNode'
import { NamespaceBand } from './components/NamespaceBand'
import { NamespaceMultiSelect } from './components/NamespaceMultiSelect'
import { ProtocolFilter } from './components/ProtocolFilter'
import { SourceSelector } from './components/SourceSelector'
import { FlowsTable } from './components/FlowsTable'
import { FlowDetailPanel } from './components/FlowDetailPanel'
import { SettingsMenu } from './components/SettingsMenu'
import { DisplayMenu } from './components/DisplayMenu'
import { RefreshStatus } from './components/RefreshStatus'
import { WorkloadPanel } from './components/WorkloadPanel'
import { touchesWorkload } from './lib/workloadSelection'
import { graphEmphasis, loadFocusMode, saveFocusMode } from './lib/graphEmphasis'
import { WorkloadSearch } from './components/WorkloadSearch'
import { SemanticZoom, ZoomReadout } from './components/ZoomControls'
import { canvasKeyAction } from './lib/canvasKeys'
import { FloatingEdge } from './components/FloatingEdge'
import {
  clampFlowsPanelWidth,
  loadFlowsPanelWidth,
  saveFlowsPanelWidth,
  MIN_FLOWS_PANEL_WIDTH,
  MAX_FLOWS_PANEL_WIDTH,
} from './lib/resizablePanel'
import { loadTheme, saveTheme, resolveTheme, type Theme } from './lib/theme'
import {
  loadBandArrangement,
  saveBandArrangement,
  type BandArrangement,
} from './lib/bandArrangement'
import {
  loadNodePositions,
  saveNodePositions,
  clearNodePositions,
  loadEdgeRoutes,
  saveEdgeRoutes,
  loadBandShape,
  saveBandShape,
  positionScopeKey,
  type NodePositionMap,
} from './lib/nodePositions'
import type { EdgeRoute } from './lib/edgeRoute'
import {
  EdgeDisplayContext,
  hiddenFlowIds,
  loadDisplayOptions,
  saveDisplayOptions,
  type DisplayOptions,
} from './lib/displayOptions'

const FLOWS_PANEL_RESIZE_STEP = 20

// Fallback used only until the --accent custom property has been read from
// the DOM once (see accentColor below) — matches the dark theme's default.
const DEFAULT_ACCENT = '#b79cff'
// Zoom a search jump settles at (issue #77) when the view is further out
// than this; a closer view is kept as-is and only panned.
const SEARCH_JUMP_MIN_ZOOM = 1
const SEARCH_JUMP_DURATION_MS = 300
// Viewport animation for keyboard pan/zoom (0 under reduced motion).
const CANVAS_KEY_DURATION_MS = 120

const DEFAULT_NAMESPACE = 'default'
const DEFAULT_PROTOCOL: ProtocolFilterValue = 'all'
// Only used until /api/config answers (or if it fails): the backend's
// --refresh-interval, 15s by default, is the real source of truth.
const DEFAULT_REFRESH_INTERVAL_MS = 15000
const nodeTypes = { workload: WorkloadNode, namespaceBand: NamespaceBand }
const edgeTypes = { floating: FloatingEdge }

// 'unreachable' (a 502 from TopologyHandler: BuildTopology couldn't complete
// its Prometheus query) and 'invalid' (a 400: the request itself was
// rejected, e.g. too many namespaces) get visually and textually distinct
// treatment — conflating either with a plain empty graph, or with each
// other, hides genuinely different problems behind one generic message.
type ErrorKind = 'unreachable' | 'invalid' | 'unknown'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; kind: ErrorKind; message: string }
  // fetchedAt drives the header's "updated Ns ago" (issue #74).
  | { status: 'ready'; nodes: Node[]; edges: Edge[]; graph: Graph; fetchedAt: number }

// `/` focuses search from anywhere except a place the user is typing.
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.closest('input, textarea, select') !== null
}

// Keeps React Flow's object identity for anything whose class doesn't change,
// so an unchanged node or edge isn't handed to React Flow as new.
function withClass<T extends { className?: string }>(item: T, className: string | undefined): T {
  return (item.className ?? undefined) === className ? item : { ...item, className }
}

function positionsToRecord(positions: Map<string, { x: number; y: number }>): NodePositionMap {
  return Object.fromEntries(positions)
}

// What the graph on screen was laid out with: the persisted-positions scope
// (positionScopeKey — for 'auto' it includes the resolved band shape, issue
// #81), that shape, and the positions and ELK routes now in effect, kept in
// sync by every layout run and every drag so a refresh or drag doesn't need
// to round-trip through storage. `scope` is null before the first layout of
// a namespace/arrangement/filter selection, so that one reads from storage.
type LayoutMemory = {
  scope: string | null
  shapeKey: string | null
  positions: NodePositionMap
  routes: Map<string, EdgeRoute>
}

const EMPTY_LAYOUT_MEMORY: LayoutMemory = { scope: null, shapeKey: null, positions: {}, routes: new Map() }

function saveLayoutMemory(namespace: string, memory: LayoutMemory) {
  if (!memory.scope) return
  saveNodePositions(memory.scope, memory.positions)
  saveEdgeRoutes(memory.scope, memory.routes)
  saveBandShape(namespace, memory.shapeKey)
}

async function loadTopology(
  namespace: string,
  protocol: ProtocolFilterValue,
  source: SourceFilter,
  bandArrangement: BandArrangement,
  canvas: Size,
  memory: LayoutMemory,
) {
  const graph = await fetchTopology(namespace, protocol, source)
  // The shape on screen is preferred, so a refresh keeps the arrangement
  // (and with it the scope its positions are saved under) unless it has
  // become clearly worse for the canvas.
  const plan = await planLayout(graph, bandArrangement, canvas, memory.shapeKey)
  const scope = positionScopeKey(namespace, plan.arrangementKey)
  // The in-memory copy is current for the scope already on screen (it has
  // the latest drags); any other scope is read from storage.
  const known =
    scope === memory.scope ? memory : { positions: loadNodePositions(scope), routes: loadEdgeRoutes(scope) }
  const { nodes, edges, positions, routes } = finishLayout(plan, known.positions, known.routes)
  const nextMemory: LayoutMemory = { scope, shapeKey: plan.shapeKey, positions: positionsToRecord(positions), routes }
  return { nodes, edges, graph, fetchedAt: Date.now(), memory: nextMemory }
}

// Status codes TopologyHandler (internal/api/topology.go) responds with:
// 502 when BuildTopology itself failed (Prometheus unreachable, or a query
// it ran failed), 400 when the request was rejected before querying at all
// (too many namespaces, an invalid protocol).
const HTTP_BAD_REQUEST = 400
const HTTP_BAD_GATEWAY = 502

function classifyTopologyError(err: unknown): { kind: ErrorKind; message: string } {
  if (err instanceof TopologyError) {
    if (err.status === HTTP_BAD_GATEWAY) return { kind: 'unreachable', message: err.message }
    if (err.status === HTTP_BAD_REQUEST) return { kind: 'invalid', message: err.message }
  }
  return { kind: 'unknown', message: err instanceof Error ? err.message : 'Failed to load topology' }
}

function App() {
  const [selectedNamespaces, setSelectedNamespaces] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get('namespace')
    return raw ? raw.split(',') : [DEFAULT_NAMESPACE]
  })
  const [namespaces, setNamespaces] = useState<string[]>([])
  // Distinguishes "haven't heard back from /api/namespaces yet" from "heard
  // back, and it's empty" — the latter, combined with a zero-node topology
  // result, is the signal that no beyla_network_flow_bytes_total series has
  // ever been observed (see the empty-state rendering below), not merely
  // that the current namespace/protocol selection has no traffic right now.
  const [namespacesLoaded, setNamespacesLoaded] = useState(false)
  // The "all namespaces" sentinel value /api/topology?namespace= accepts,
  // and the cap on simultaneously selected namespaces it enforces — both
  // sourced from /api/namespaces rather than hardcoded, so the frontend
  // never has to agree on these values with the backend independently.
  const [allNamespacesValue, setAllNamespacesValue] = useState<string | null>(null)
  const [maxNamespaces, setMaxNamespaces] = useState(1)
  const [protocols, setProtocols] = useState<ProtocolFilterValue[]>([DEFAULT_PROTOCOL])
  const [protocol, setProtocol] = useState<ProtocolFilterValue>(() => {
    return new URLSearchParams(window.location.search).get('protocol') || DEFAULT_PROTOCOL
  })
  const [sources, setSources] = useState<SourceFilter[]>([])
  // Empty until either a ?source= URL override or /api/sources' `default`
  // field resolves it (see the fetchSources effect below) — unlike protocol,
  // there's no source value the frontend can assume is always valid before
  // hearing back from the backend (REQ-001), so this starts unset rather
  // than guessing "beyla".
  const [source, setSource] = useState<SourceFilter>(() => {
    return new URLSearchParams(window.location.search).get('source') || ''
  })
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // Identifies the flow selected in either the table or the graph — see
  // flowId — so the two stay in sync no matter which one triggered it.
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null)
  // The selected Workload node (issue #75), by workload ID — the same ID the
  // graph's nodes and Flow.source/target use, so it survives a background
  // refresh (which rebuilds every node object) as long as the workload is
  // still observed. App owns it rather than React Flow's per-node `selected`
  // flag; renderedNodes below derives that flag from it. Independent of
  // selectedFlowId: a workload and one of its flows can be selected at once.
  const [selectedWorkloadId, setSelectedWorkloadId] = useState<string | null>(null)
  // Search (issue #77): the raw query, and the workload last stepped to with
  // Enter — an ID rather than an index, so a refresh that adds or drops
  // matches doesn't shift which one the next Enter moves on from.
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCursor, setSearchCursor] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // One-hop focus mode (issue #77) around the selected workload; on by
  // default, toggled from the Workload panel.
  const [focusMode, setFocusMode] = useState(loadFocusMode)
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null)
  // The backend's --refresh-interval (see the /api/config effect below) sets
  // the default; ?refreshInterval=<ms> overrides it, same convention as
  // ?namespace=.
  const [refreshIntervalOverrideMs] = useState(() => {
    const raw = Number(new URLSearchParams(window.location.search).get('refreshInterval'))
    return raw > 0 ? raw : null
  })
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(
    refreshIntervalOverrideMs ?? DEFAULT_REFRESH_INTERVAL_MS,
  )
  const [paused, setPaused] = useState(false)
  const [flowsPanelWidth, setFlowsPanelWidth] = useState(() =>
    loadFlowsPanelWidth(window.innerWidth),
  )
  const [theme, setTheme] = useState<Theme>(loadTheme)
  // Only consulted when theme === 'system' (see resolveTheme) — tracked as
  // state, rather than read once, so an OS-level light/dark switch updates
  // the app live without needing a reload.
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const resolvedTheme = resolveTheme(theme, systemPrefersDark)
  const appRef = useRef<HTMLDivElement>(null)
  // Edge stroke color is set inline (React Flow edge style), which can't
  // reference a CSS custom property directly — so the selected-flow stroke
  // is read from --accent after each theme change instead of duplicating
  // its light/dark values by hand, keeping App.css the single source of
  // truth for the accent color.
  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT)
  const [bandArrangement, setBandArrangement] = useState<BandArrangement>(loadBandArrangement)
  // Display ▾ (issue #76): applied on top of the laid-out graph, never fed
  // into layout or the fetch, so changing one never re-runs either.
  const [displayOptions, setDisplayOptions] = useState<DisplayOptions>(loadDisplayOptions)
  // Persisted positions and ELK routes (issues #43, #39) for the layout on
  // screen — see LayoutMemory. Routes are fed back into the next layout so an
  // edge keeps a route that still fits its persisted endpoints when ELK's
  // fresh one no longer does (selectRoutes in lib/layout.ts).
  const layoutMemoryRef = useRef<LayoutMemory>(EMPTY_LAYOUT_MEMORY)
  // The graph pane: its size drives the 'auto' band shape (issue #81), and
  // it takes keyboard focus for panning and zooming.
  const canvasRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (!appRef.current) return
    const value = getComputedStyle(appRef.current).getPropertyValue('--accent').trim()
    if (value) setAccentColor(value)
  }, [resolvedTheme])

  useEffect(() => {
    if (refreshIntervalOverrideMs !== null) return
    let cancelled = false

    fetchConfig()
      .then((res) => {
        if (!cancelled && res.refreshIntervalMs > 0) setRefreshIntervalMs(res.refreshIntervalMs)
      })
      .catch((err) => {
        // Not worth an error state: polling just keeps the built-in default.
        console.error('loading /api/config failed', err)
      })

    return () => {
      cancelled = true
    }
  }, [refreshIntervalOverrideMs])

  function handleThemeChange(next: Theme) {
    setTheme(next)
    saveTheme(next)
  }

  function handleBandArrangementChange(next: BandArrangement) {
    setBandArrangement(next)
    saveBandArrangement(next)
  }

  function handleDisplayOptionsChange(next: DisplayOptions) {
    setDisplayOptions(next)
    saveDisplayOptions(next)
  }

  useEffect(() => {
    let cancelled = false

    fetchNamespaces()
      .then((res) => {
        if (!cancelled) {
          setNamespaces(res.namespaces)
          setAllNamespacesValue(res.all)
          setMaxNamespaces(res.max)
          setNamespacesLoaded(true)
        }
      })
      .catch((err: unknown) => {
        console.error('failed to load namespaces', err)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    fetchProtocols()
      .then((res) => {
        if (!cancelled) setProtocols(res.protocols)
      })
      .catch((err: unknown) => {
        console.error('failed to load protocols', err)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    fetchSources()
      .then((res) => {
        if (cancelled) return
        setSources(res.sources)
        // A ?source= URL override (or a selection already in flight) wins
        // over the backend's default — only fills in the default when
        // nothing has picked a source yet.
        setSource((prev) => prev || res.default)
      })
      .catch((err: unknown) => {
        console.error('failed to load sources', err)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const namespaceParam = selectedNamespaces.join(',')

  // The canvas's current size in screen pixels; the window's as a fallback
  // before it has mounted.
  const canvasSize = useCallback((): Size => {
    const rect = canvasRef.current?.getBoundingClientRect()
    return rect && rect.width > 0 && rect.height > 0
      ? { width: rect.width, height: rect.height }
      : { width: window.innerWidth, height: window.innerHeight }
  }, [])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    setSelectedFlowId(null)
    setSelectedWorkloadId(null)
    // Persisted positions are per namespace scope *and* (resolved) band
    // arrangement (see positionScopeKey), so switching arrangement re-lays
    // out (issue #51); loadTopology reads them for whichever scope applies.
    // The shape this scope was last shown in is preferred, so a reload
    // lands on the same grid (and the positions dragged in it) unless the
    // canvas has changed enough to make another one clearly better.
    layoutMemoryRef.current = { ...EMPTY_LAYOUT_MEMORY, shapeKey: loadBandShape(namespaceParam) }

    loadTopology(namespaceParam, protocol, source, bandArrangement, canvasSize(), layoutMemoryRef.current)
      .then(({ memory, ...result }) => {
        if (cancelled) return
        layoutMemoryRef.current = memory
        saveLayoutMemory(namespaceParam, memory)
        setState({ status: 'ready', ...result })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', ...classifyTopologyError(err) })
        }
      })

    return () => {
      cancelled = true
    }
  }, [namespaceParam, protocol, source, bandArrangement, canvasSize])

  // A failed background refresh doesn't replace the last-rendered graph with
  // an error screen — it just logs and leaves the graph as-is; the
  // unreachable/invalid/empty states above only ever come from the initial
  // (or namespace/protocol/band-arrangement-change-triggered) load.
  const refreshInBackground = useCallback(
    (cancelledRef: { current: boolean }) => {
      loadTopology(namespaceParam, protocol, source, bandArrangement, canvasSize(), layoutMemoryRef.current)
        .then(({ memory, ...result }) => {
          if (cancelledRef.current) return
          layoutMemoryRef.current = memory
          saveLayoutMemory(namespaceParam, memory)
          setState({ status: 'ready', ...result })
        })
        .catch((err: unknown) => {
          console.error('background topology refresh failed', err)
        })
    },
    [namespaceParam, protocol, source, bandArrangement, canvasSize],
  )

  // Polls /api/topology on refreshIntervalMs while not paused, updating the
  // rendered graph in place without disturbing the current LoadState —
  // separate from the effect above so toggling `paused` never re-triggers
  // the initial loading transition and the last-rendered graph stays put.
  useEffect(() => {
    if (paused) return

    const cancelledRef = { current: false }
    const id = setInterval(() => refreshInBackground(cancelledRef), refreshIntervalMs)

    return () => {
      cancelledRef.current = true
      clearInterval(id)
    }
  }, [refreshIntervalMs, paused, refreshInBackground])

  const summary = useMemo(() => {
    if (state.status !== 'ready') return null
    return `${state.graph.nodes.length} workloads · ${state.graph.edges.length} flows`
  }, [state])

  const selectedFlow = useMemo(() => {
    if (state.status !== 'ready' || !selectedFlowId) return null
    return state.graph.edges.find((flow) => flowId(flow) === selectedFlowId) ?? null
  }, [state, selectedFlowId])

  const selectedWorkload = useMemo(() => {
    if (state.status !== 'ready' || !selectedWorkloadId) return null
    return state.graph.nodes.find((workload) => workload.id === selectedWorkloadId) ?? null
  }, [state, selectedWorkloadId])

  // Everything search, focus mode and flow selection dim, in one place (see
  // lib/graphEmphasis.ts). Recomputed from the latest graph, so it follows
  // workloads appearing or disappearing on a background refresh.
  const emphasis = useMemo(() => {
    if (state.status !== 'ready') return null
    return graphEmphasis(state.graph, searchQuery, selectedWorkloadId, selectedFlowId, focusMode)
  }, [state, searchQuery, selectedWorkloadId, selectedFlowId, focusMode])
  const searchMatchIds = useMemo(() => new Set(emphasis?.matches ?? []), [emphasis])

  // React Flow's `selected` flag and the dim/match classes are derived here
  // rather than stored in state.nodes: a background refresh replaces every
  // node object, and selection or dimming must never feed back into layout
  // or persisted positions. Dimming is a class (opacity in App.css), so it
  // can't move or resize anything. Namespace bands are containers and are
  // never dimmed.
  const renderedNodes = useMemo(() => {
    if (state.status !== 'ready') return []
    const litNodes = emphasis?.litNodes ?? null
    if (!selectedWorkloadId && !litNodes) return state.nodes
    return state.nodes.map((node) => {
      if (node.type !== 'workload') return node
      const classes = []
      if (litNodes && !litNodes.has(node.id)) classes.push('is-dimmed')
      if (searchMatchIds.has(node.id)) classes.push('is-match')
      const styled = withClass(node, classes.length ? classes.join(' ') : undefined)
      return node.id === selectedWorkloadId ? { ...styled, selected: true } : styled
    })
  }, [state, emphasis, searchMatchIds, selectedWorkloadId])

  // Flows the low-traffic cutoff takes off the canvas (recomputed on every
  // refresh, per Flow.metric — see hiddenFlowIds). They stay in the flows
  // table, marked, with a count; a hidden flow selected from there is drawn
  // anyway so the selection is never invisible.
  const hiddenFlows = useMemo(
    () => (state.status === 'ready' ? hiddenFlowIds(state.graph.edges, displayOptions.lowTrafficCutoff) : new Set<string>()),
    [state, displayOptions.lowTrafficCutoff],
  )

  const renderedEdges = useMemo(() => {
    if (state.status !== 'ready') return []
    // The low-traffic cutoff (#76) removes edges first; emphasis (#77) then
    // dims what's left. A hidden flow that's selected is drawn anyway.
    const edges =
      hiddenFlows.size === 0 ? state.edges : state.edges.filter((edge) => !hiddenFlows.has(edge.id) || edge.id === selectedFlowId)
    const litEdges = emphasis?.litEdges ?? null
    if (!litEdges) return edges
    return edges.map((edge) => {
      if (edge.id === selectedFlowId) {
        return {
          ...edge,
          selected: true,
          zIndex: 1,
          // FloatingEdge's direction marks follow this stroke too.
          style: { ...edge.style, stroke: accentColor },
        }
      }
      // A selected flow is accented and the rest recede, so a selection made
      // from the table (which has no notion of edge geometry) is still
      // visible on the graph. .is-dimmed sits on the edge's <g>, so the line, #79's chevron and
      // arrowhead, the label and the traffic dots all recede together.
      const dimmed = withClass(edge, litEdges.has(edge.id) ? undefined : 'is-dimmed')
      return selectedFlowId ? { ...dimmed, selected: false } : dimmed
    })
  }, [state, hiddenFlows, emphasis, selectedFlowId, accentColor])

  const { edgeLabels, trafficAnimation } = displayOptions
  const edgeDisplay = useMemo(() => ({ edgeLabels, trafficAnimation }), [edgeLabels, trafficAnimation])

  const searchCurrentIndex = searchCursor ? (emphasis?.matches.indexOf(searchCursor) ?? -1) : -1

  function handleSearchQueryChange(query: string) {
    setSearchQuery(query)
    setSearchCursor(null)
  }

  // Enter / Shift+Enter: select the next or previous match through the same
  // entry point a click uses, and bring it into view. Viewport only — no
  // node moves, so persisted positions and ELK routes stay as they are.
  function stepSearch(direction: 1 | -1) {
    const matches = emphasis?.matches ?? []
    if (matches.length === 0) return
    const from = searchCursor ? matches.indexOf(searchCursor) : -1
    const index =
      from < 0 ? (direction === 1 ? 0 : matches.length - 1) : (from + direction + matches.length) % matches.length
    const id = matches[index]
    setSearchCursor(id)
    selectWorkload(id)
    const node = flowInstance?.getInternalNode(id)
    if (!flowInstance || !node) return
    const width = node.measured.width ?? 0
    const height = node.measured.height ?? 0
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    flowInstance.setCenter(
      node.internals.positionAbsolute.x + width / 2,
      node.internals.positionAbsolute.y + height / 2,
      {
        zoom: Math.max(flowInstance.getZoom(), SEARCH_JUMP_MIN_ZOOM),
        duration: reduceMotion ? 0 : SEARCH_JUMP_DURATION_MS,
      },
    )
  }

  function handleFocusModeChange(on: boolean) {
    setFocusMode(on)
    saveFocusMode(on)
  }

  function toggleSelectedFlow(id: string) {
    setSelectedFlowId((prev) => (prev === id ? null : id))
  }

  // The one entry point for selecting a workload — node click, keyboard
  // (Enter/Space on a focused node), and #77's search (Enter) all go through
  // it. A selected flow survives only if it belongs to the new workload.
  function selectWorkload(id: string) {
    setSelectedWorkloadId(id)
    if (state.status !== 'ready') return
    setSelectedFlowId((prev) => {
      if (!prev) return prev
      const flow = state.graph.edges.find((f) => flowId(f) === prev)
      return flow && touchesWorkload(flow, id) ? prev : null
    })
  }

  const clearSelection = useCallback(() => {
    setSelectedWorkloadId(null)
    setSelectedFlowId(null)
  }, [])

  function handleEdgeClick(_event: unknown, edge: Edge) {
    toggleSelectedFlow(edge.id)
    // Clicking a flow elsewhere on the graph leaves the workload's panel;
    // one of its own flows keeps it open, with the flow detail beneath.
    if (selectedWorkloadId && edge.source !== selectedWorkloadId && edge.target !== selectedWorkloadId) {
      setSelectedWorkloadId(null)
    }
  }

  // Escape peels back one layer per press: the search first, then the
  // selection. `/` jumps to search unless the user is already typing.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') {
        if (searchQuery) {
          setSearchQuery('')
          setSearchCursor(null)
        } else {
          clearSelection()
        }
        return
      }
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isTextEntry(event.target)) {
        event.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [clearSelection, searchQuery])

  // Conservative by construction: while /api/namespaces hasn't resolved yet
  // (or failed), this stays false, so a zero-node topology result renders as
  // the less-alarming "no traffic right now" rather than risking a false
  // "misconfigured" warning.
  const noTrafficEverObserved = namespacesLoaded && namespaces.length === 0
  const hasGraph = state.status === 'ready' && state.nodes.length > 0

  // Drags widen the panel toward the left (the handle sits on its left
  // edge), so a decreasing clientX as the pointer moves left translates to
  // an increasing width — the reverse of a handle on the right edge. Only
  // mouseup persists to localStorage — writing on every mousemove would
  // otherwise hit storage dozens of times per drag for no benefit, since
  // only the final width matters for restoring it later.
  function handleResizeStart(startEvent: React.MouseEvent) {
    startEvent.preventDefault()
    const startX = startEvent.clientX
    const startWidth = flowsPanelWidth
    let latestWidth = startWidth

    function onMouseMove(moveEvent: MouseEvent) {
      latestWidth = clampFlowsPanelWidth(startWidth + (startX - moveEvent.clientX), window.innerWidth)
      setFlowsPanelWidth(latestWidth)
    }

    function onMouseUp() {
      saveFlowsPanelWidth(latestWidth)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  // Mirrors the drag direction: ArrowLeft moves the handle left (widens the
  // panel), ArrowRight moves it right (narrows it) — matching a role=
  // "separator" control's expected keyboard operability.
  function handleResizeKeyDown(event: React.KeyboardEvent) {
    let delta = 0
    if (event.key === 'ArrowLeft') delta = FLOWS_PANEL_RESIZE_STEP
    else if (event.key === 'ArrowRight') delta = -FLOWS_PANEL_RESIZE_STEP
    else return

    event.preventDefault()
    const width = clampFlowsPanelWidth(flowsPanelWidth + delta, window.innerWidth)
    setFlowsPanelWidth(width)
    saveFlowsPanelWidth(width)
  }

  function handleTogglePause() {
    if (paused) {
      // Resuming restarts the polling loop — refresh right away rather than
      // leaving the user staring at a stale graph until the next tick.
      refreshInBackground({ current: false })
    }
    setPaused((p) => !p)
  }

  // Keeps drags smooth (React Flow's own drag interaction needs position
  // changes reflected back into the controlled `nodes` prop as they
  // happen), but only the final drop position — via onNodeDragStop below —
  // gets persisted, so a drag-in-progress doesn't hit storage every frame.
  // syncNamespaceBands keeps bands and workloads together on every change:
  // dragging a band moves its workloads, dragging a workload re-fits its band.
  //
  // Select changes never reach state.nodes: selection lives in
  // selectedWorkloadId (see renderedNodes). A select:true — from a click
  // (selectNodesOnDrag is off, so a drag never selects) or Enter/Space on a
  // focused node — selects that workload; React Flow's select:false
  // side-effects (pane or edge clicks) are ignored, since onPaneClick,
  // handleEdgeClick and Escape already decide deselection explicitly.
  function handleNodesChange(changes: NodeChange[]) {
    const selected = changes.findLast((change) => change.type === 'select' && change.selected)
    if (selected && selected.type === 'select') selectWorkload(selected.id)
    const layoutChanges = changes.filter((change) => change.type !== 'select')
    if (layoutChanges.length === 0) return
    setState((prev) => {
      if (prev.status !== 'ready') return prev
      const nodes = applyNodeChanges(layoutChanges, prev.nodes)
      return { ...prev, nodes: syncNamespaceBands(prev.nodes, nodes) }
    })
  }

  // Persists the dropped position immediately (issue #43): it's merged into
  // the same known-positions map a background refresh reads from, so the
  // very next poll reuses it instead of running that node back through
  // auto-layout.
  // A dropped namespace band persists every workload it carried. `state` may
  // lag the final drag frame by one render, so members are shifted by the
  // band's remaining delta rather than read as-is.
  function handleNodeDragStop(_event: unknown, _node: Node, draggedNodes: Node[]) {
    const positions: NodePositionMap = {}
    for (const dragged of draggedNodes) {
      if (dragged.type !== 'namespaceBand') {
        positions[dragged.id] = dragged.position
        continue
      }
      if (state.status !== 'ready') continue
      const namespace = (dragged.data as NamespaceBandData).namespace
      const staleBand = state.nodes.find((n) => n.id === dragged.id)
      const dx = dragged.position.x - (staleBand?.position.x ?? dragged.position.x)
      const dy = dragged.position.y - (staleBand?.position.y ?? dragged.position.y)
      for (const member of state.nodes) {
        if (member.type !== 'workload' || (member.data as WorkloadNodeData).workload.namespace !== namespace) continue
        positions[member.id] = { x: member.position.x + dx, y: member.position.y + dy }
      }
    }
    const memory = layoutMemoryRef.current
    layoutMemoryRef.current = { ...memory, positions: { ...memory.positions, ...positions } }
    saveLayoutMemory(namespaceParam, layoutMemoryRef.current)
  }

  // Discards every persisted position for the current scope and re-lays-out
  // the graph already in hand from scratch, then persists the fresh
  // auto-layout as the new baseline so it, in turn, stays stable across the
  // next refresh. 'auto' re-picks its band shape for the canvas as it is
  // now (no preference for the old one), so Rearrange after resizing the
  // window also re-fits the arrangement.
  function handleRearrange() {
    if (state.status !== 'ready') return
    const { graph, fetchedAt } = state
    if (layoutMemoryRef.current.scope) clearNodePositions(layoutMemoryRef.current.scope)
    planLayout(graph, bandArrangement, canvasSize()).then((plan) => {
      const scope = positionScopeKey(namespaceParam, plan.arrangementKey)
      clearNodePositions(scope)
      const { nodes, edges, positions, routes } = finishLayout(plan)
      layoutMemoryRef.current = { scope, shapeKey: plan.shapeKey, positions: positionsToRecord(positions), routes }
      saveLayoutMemory(namespaceParam, layoutMemoryRef.current)
      setState({ status: 'ready', nodes, edges, graph, fetchedAt })
    })
  }

  // Keyboard navigation on the focused canvas (issue #81, replacing the
  // on-canvas pan arrows): arrows pan, + / - zoom, 0 fits. Keys aimed at a
  // workload (React Flow moves a focused node with the arrows; Enter/Space
  // select it, #75) or typed into a field are left alone, and `/` and
  // Escape (#77) aren't canvas keys, so they still reach the window handler.
  function handleCanvasKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (!flowInstance || event.defaultPrevented || isTextEntry(event.target)) return
    if (event.target instanceof Element && event.target.closest('.react-flow__node')) return
    const action = canvasKeyAction(event)
    if (!action) return
    event.preventDefault()
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : CANVAS_KEY_DURATION_MS
    if (action.type === 'pan') {
      const { x, y, zoom } = flowInstance.getViewport()
      flowInstance.setViewport({ x: x + action.dx, y: y + action.dy, zoom }, { duration })
    } else if (action.type === 'zoomIn') flowInstance.zoomIn({ duration })
    else if (action.type === 'zoomOut') flowInstance.zoomOut({ duration })
    else flowInstance.fitView({ duration })
  }

  // React Flow's pane swallows mousedown (d3-zoom), so clicking empty canvas
  // wouldn't otherwise give it focus; do it explicitly so arrow keys work
  // right after a click. focusVisible: false keeps the focus ring a
  // keyboard-only cue (browsers that ignore the option may still show it).
  function handleCanvasPointerDown(event: React.PointerEvent<HTMLElement>) {
    if (event.target instanceof Element && event.target.closest('.react-flow__pane')) {
      canvasRef.current?.focus({ preventScroll: true, focusVisible: false })
    }
  }

  return (
    <div className="app" data-theme={resolvedTheme} ref={appRef}>
      {/* Four zones, left to right (issue #74): scope (which data), search,
          view (how it's drawn + refresh), settings (app preferences). */}
      <header className="app__header">
        <span className="app__brand">
          <img className="app__logo" src="/logo.svg" alt="" width={24} height={24} />
          <span className="app__brand-name">KubeLynx</span>
        </span>
        <div className="app__zone app__zone--scope" role="group" aria-label="Data scope">
          <NamespaceMultiSelect
            namespaces={namespaces}
            allValue={allNamespacesValue}
            max={maxNamespaces}
            selected={selectedNamespaces}
            onChange={setSelectedNamespaces}
          />
          <SourceSelector sources={sources} selected={source} onChange={setSource} />
          <ProtocolFilter protocols={protocols} selected={protocol} onChange={setProtocol} />
        </div>
        <div className="app__zone app__zone--search" role="search">
          <WorkloadSearch
            inputRef={searchInputRef}
            query={searchQuery}
            onQueryChange={handleSearchQueryChange}
            matchCount={emphasis?.matches.length ?? 0}
            currentIndex={searchCurrentIndex}
            onStep={stepSearch}
          />
        </div>
        {/* Quiet status line: what the current scope returned. */}
        <span className="app__summary">{summary}</span>
        <div className="app__zone app__zone--view" role="group" aria-label="View">
          <DisplayMenu options={displayOptions} onChange={handleDisplayOptionsChange} />
          <button
            type="button"
            className="header-control"
            onClick={handleRearrange}
            disabled={state.status !== 'ready'}
            title="Discard manually-placed positions and re-run auto-layout"
          >
            Rearrange
          </button>
          <button
            type="button"
            className="header-control app__pause-toggle"
            onClick={handleTogglePause}
            aria-pressed={paused}
            title={paused ? 'Resume automatic refresh' : 'Stop automatic refresh'}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <RefreshStatus updatedAt={state.status === 'ready' ? state.fetchedAt : null} paused={paused} />
        </div>
        <div className="app__zone app__zone--settings">
          <SettingsMenu
            theme={theme}
            onThemeChange={handleThemeChange}
            bandArrangement={bandArrangement}
            onBandArrangementChange={handleBandArrangementChange}
          />
        </div>
      </header>
      <div className="app__body">
        <main
          ref={canvasRef}
          className="app__canvas"
          data-namespace-bands={displayOptions.namespaceBands ? 'shown' : 'hidden'}
          // Focusable only while there's a graph to navigate.
          tabIndex={hasGraph ? 0 : undefined}
          aria-label={hasGraph ? 'Topology graph' : undefined}
          aria-keyshortcuts={hasGraph ? 'ArrowUp ArrowDown ArrowLeft ArrowRight + - 0' : undefined}
          onKeyDown={hasGraph ? handleCanvasKeyDown : undefined}
          onPointerDown={hasGraph ? handleCanvasPointerDown : undefined}
        >
          {state.status === 'loading' && (
            <div className="app__status app__status--loading">
              <span className="app__spinner" aria-hidden="true" />
              <span>Loading topology…</span>
            </div>
          )}
          {state.status === 'error' && state.kind === 'unreachable' && (
            <div className="app__status app__status--error">
              <strong>Prometheus unreachable.</strong> {state.message}
            </div>
          )}
          {state.status === 'error' && state.kind === 'invalid' && (
            <div className="app__status app__status--warning">{state.message}</div>
          )}
          {state.status === 'error' && state.kind === 'unknown' && (
            <div className="app__status app__status--error">{state.message}</div>
          )}
          {state.status === 'ready' && state.nodes.length === 0 && noTrafficEverObserved && (
            <div className="app__status app__status--warning">
              <strong>No traffic data found.</strong> Prometheus has no{' '}
              <code>beyla_network_flow_bytes_total</code> series at all — check that Beyla's
              network metrics feature is enabled and exporting the k8s_src/dst_namespace and
              k8s_src/dst_owner_name attributes KubeLynx relies on.
            </div>
          )}
          {state.status === 'ready' && state.nodes.length === 0 && !noTrafficEverObserved && (
            <div className="app__status">
              No workload traffic observed in "{selectedNamespaces.join(', ')}" yet.
            </div>
          )}
          {hasGraph && (
            <EdgeDisplayContext.Provider value={edgeDisplay}>
              <ReactFlow
                nodes={renderedNodes}
                edges={renderedEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                fitView
                proOptions={{ hideAttribution: true }}
                selectNodesOnDrag={false}
                onNodesChange={handleNodesChange}
                onNodeDragStop={handleNodeDragStop}
                onEdgeClick={handleEdgeClick}
                onPaneClick={clearSelection}
                onInit={setFlowInstance}
              >
                <Background color="var(--rf-background-dot)" />
                <SemanticZoom target={canvasRef} />
                <Controls showInteractive={false}>
                  <ZoomReadout />
                </Controls>
              </ReactFlow>
            </EdgeDisplayContext.Provider>
          )}
        </main>
        <div
          className="app__flows-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize flows panel"
          aria-valuenow={flowsPanelWidth}
          aria-valuemin={MIN_FLOWS_PANEL_WIDTH}
          aria-valuemax={MAX_FLOWS_PANEL_WIDTH}
          tabIndex={0}
          onMouseDown={handleResizeStart}
          onKeyDown={handleResizeKeyDown}
        />
        <aside className="app__flows-panel" style={{ width: flowsPanelWidth }}>
          {selectedWorkloadId ? (
            <WorkloadPanel
              workloadId={selectedWorkloadId}
              workload={selectedWorkload}
              flows={state.status === 'ready' ? state.graph.edges : []}
              source={source}
              selectedFlowId={selectedFlowId}
              onSelectFlow={toggleSelectedFlow}
              focusMode={focusMode}
              onFocusModeChange={handleFocusModeChange}
              onClose={() => setSelectedWorkloadId(null)}
            />
          ) : (
            <FlowsTable
              flows={state.status === 'ready' ? state.graph.edges : []}
              hiddenIds={hiddenFlows}
              selectedId={selectedFlowId}
              onSelect={toggleSelectedFlow}
            />
          )}
          <FlowDetailPanel flow={selectedFlow} />
        </aside>
      </div>
    </div>
  )
}

export default App
