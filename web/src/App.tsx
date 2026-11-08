import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type EdgeMarker,
  type Node,
  type NodeChange,
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
import { layoutGraph, syncNamespaceBands, type NamespaceBandData, type WorkloadNodeData } from './lib/layout'
import { WorkloadNode } from './components/WorkloadNode'
import { NamespaceBand } from './components/NamespaceBand'
import { NamespaceMultiSelect } from './components/NamespaceMultiSelect'
import { ProtocolFilter } from './components/ProtocolFilter'
import { SourceSelector } from './components/SourceSelector'
import { FlowsTable } from './components/FlowsTable'
import { FlowDetailPanel } from './components/FlowDetailPanel'
import { WorkloadPanel } from './components/WorkloadPanel'
import { touchesWorkload } from './lib/workloadSelection'
import { ThemeToggle } from './components/ThemeToggle'
import { BandArrangementToggle } from './components/BandArrangementToggle'
import { PanControls } from './components/PanControls'
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
  positionScopeKey,
  type NodePositionMap,
} from './lib/nodePositions'
import type { EdgeRoute } from './lib/edgeRoute'

const FLOWS_PANEL_RESIZE_STEP = 20

// Fallback used only until the --accent custom property has been read from
// the DOM once (see accentColor below) — matches the dark theme's default.
const DEFAULT_ACCENT = '#b79cff'
const UNSELECTED_FLOW_OPACITY = 0.35

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
  | { status: 'ready'; nodes: Node[]; edges: Edge[]; graph: Graph }

function positionsToRecord(positions: Map<string, { x: number; y: number }>): NodePositionMap {
  return Object.fromEntries(positions)
}

async function loadTopology(
  namespace: string,
  protocol: ProtocolFilterValue,
  source: SourceFilter,
  bandArrangement: BandArrangement,
  knownPositions: NodePositionMap,
  knownRoutes: Map<string, EdgeRoute>,
) {
  const graph = await fetchTopology(namespace, protocol, source)
  const { nodes, edges, positions, routes } = await layoutGraph(graph, bandArrangement, knownPositions, knownRoutes)
  return { nodes, edges, graph, positions, routes }
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
  // Mirrors what's in localStorage for the current position scope (see
  // lib/nodePositions.ts) — read fresh whenever the namespace scope changes,
  // then kept in sync by every layout run and every drag so a "Rearrange"
  // or drag doesn't need to round-trip through storage to take effect.
  const nodePositionsRef = useRef<NodePositionMap>({})
  // Same, for the ELK route each edge was last drawn with (issue #39): fed
  // back into the next layout so an edge keeps a route that still fits its
  // persisted endpoints when ELK's fresh one no longer does (see
  // selectRoutes in lib/layout.ts).
  const edgeRoutesRef = useRef<Map<string, EdgeRoute>>(new Map())

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
  // Persisted positions are per namespace scope *and* band arrangement (see
  // positionScopeKey), so switching arrangement re-lays out (issue #51).
  const positionScope = positionScopeKey(namespaceParam, bandArrangement)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    setSelectedFlowId(null)
    setSelectedWorkloadId(null)
    nodePositionsRef.current = loadNodePositions(positionScope)
    edgeRoutesRef.current = loadEdgeRoutes(positionScope)

    loadTopology(namespaceParam, protocol, source, bandArrangement, nodePositionsRef.current, edgeRoutesRef.current)
      .then(({ positions, routes, ...result }) => {
        if (cancelled) return
        nodePositionsRef.current = positionsToRecord(positions)
        edgeRoutesRef.current = routes
        saveNodePositions(positionScope, nodePositionsRef.current)
        saveEdgeRoutes(positionScope, routes)
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
  }, [namespaceParam, positionScope, protocol, source, bandArrangement])

  // A failed background refresh doesn't replace the last-rendered graph with
  // an error screen — it just logs and leaves the graph as-is; the
  // unreachable/invalid/empty states above only ever come from the initial
  // (or namespace/protocol/band-arrangement-change-triggered) load.
  const refreshInBackground = useCallback(
    (cancelledRef: { current: boolean }) => {
      loadTopology(namespaceParam, protocol, source, bandArrangement, nodePositionsRef.current, edgeRoutesRef.current)
        .then(({ positions, routes, ...result }) => {
          if (cancelledRef.current) return
          nodePositionsRef.current = positionsToRecord(positions)
          edgeRoutesRef.current = routes
          saveNodePositions(positionScope, nodePositionsRef.current)
          saveEdgeRoutes(positionScope, routes)
          setState({ status: 'ready', ...result })
        })
        .catch((err: unknown) => {
          console.error('background topology refresh failed', err)
        })
    },
    [namespaceParam, positionScope, protocol, source, bandArrangement],
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

  // Highlights the selected flow's edge and dims the rest, so a selection
  // made from the table (which has no notion of edge geometry) is still
  // visible on the graph — and vice versa, via ReactFlow's onEdgeClick below.
  const selectedWorkload = useMemo(() => {
    if (state.status !== 'ready' || !selectedWorkloadId) return null
    return state.graph.nodes.find((workload) => workload.id === selectedWorkloadId) ?? null
  }, [state, selectedWorkloadId])

  // React Flow's `selected` flag is derived here rather than stored in
  // state.nodes: a background refresh replaces every node object, and
  // selection must never feed back into layout or persisted positions — only
  // the one selected node gets a new object, everything else passes through.
  const renderedNodes = useMemo(() => {
    if (state.status !== 'ready') return []
    if (!selectedWorkloadId) return state.nodes
    return state.nodes.map((node) => (node.id === selectedWorkloadId ? { ...node, selected: true } : node))
  }, [state, selectedWorkloadId])

  const renderedEdges = useMemo(() => {
    if (state.status !== 'ready') return []
    if (!selectedFlowId) {
      if (!selectedWorkloadId) return state.edges
      // A selected workload with no flow picked yet: its own flows stay at
      // full strength and the rest recede, so the panel's lists are easy to
      // trace on the graph.
      return state.edges.map((edge) =>
        edge.source === selectedWorkloadId || edge.target === selectedWorkloadId
          ? edge
          : { ...edge, style: { ...edge.style, opacity: UNSELECTED_FLOW_OPACITY } },
      )
    }
    return state.edges.map((edge) =>
      edge.id === selectedFlowId
        ? {
            ...edge,
            selected: true,
            zIndex: 1,
            style: { ...edge.style, stroke: accentColor },
            // The arrowhead is a separate SVG marker keyed by color, so it
            // needs the accent color too or it stays muted.
            markerEnd: { ...(edge.markerEnd as EdgeMarker), color: accentColor },
          }
        : { ...edge, selected: false, style: { ...edge.style, opacity: UNSELECTED_FLOW_OPACITY } },
    )
  }, [state, selectedFlowId, selectedWorkloadId, accentColor])

  function toggleSelectedFlow(id: string) {
    setSelectedFlowId((prev) => (prev === id ? null : id))
  }

  // The one entry point for selecting a workload — node click, keyboard
  // (Enter/Space on a focused node), and later #77's search all go through
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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented) clearSelection()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [clearSelection])

  // Conservative by construction: while /api/namespaces hasn't resolved yet
  // (or failed), this stays false, so a zero-node topology result renders as
  // the less-alarming "no traffic right now" rather than risking a false
  // "misconfigured" warning.
  const noTrafficEverObserved = namespacesLoaded && namespaces.length === 0

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
    nodePositionsRef.current = { ...nodePositionsRef.current, ...positions }
    saveNodePositions(positionScope, nodePositionsRef.current)
  }

  // Discards every persisted position for the current namespace scope and
  // re-lays-out the graph already in hand from scratch, then persists the
  // fresh auto-layout as the new baseline so it, in turn, stays stable
  // across the next refresh.
  function handleRearrange() {
    if (state.status !== 'ready') return
    const graph = state.graph
    clearNodePositions(positionScope)
    layoutGraph(graph, bandArrangement, {}).then(({ nodes, edges, positions, routes }) => {
      nodePositionsRef.current = positionsToRecord(positions)
      edgeRoutesRef.current = routes
      saveNodePositions(positionScope, nodePositionsRef.current)
      saveEdgeRoutes(positionScope, routes)
      setState({ status: 'ready', nodes, edges, graph })
    })
  }

  return (
    <div className="app" data-theme={resolvedTheme} ref={appRef}>
      <header className="app__header">
        <span className="app__brand">
          <img className="app__logo" src="/logo.svg" alt="" width={24} height={24} />
          KubeLynx
        </span>
        <NamespaceMultiSelect
          namespaces={namespaces}
          allValue={allNamespacesValue}
          max={maxNamespaces}
          selected={selectedNamespaces}
          onChange={setSelectedNamespaces}
        />
        <ProtocolFilter protocols={protocols} selected={protocol} onChange={setProtocol} />
        <SourceSelector sources={sources} selected={source} onChange={setSource} />
        <BandArrangementToggle selected={bandArrangement} onChange={handleBandArrangementChange} />
        <button
          type="button"
          className="app__refresh-toggle"
          onClick={handleRearrange}
          disabled={state.status !== 'ready'}
          title="Discard manually-placed positions and re-run auto-layout"
        >
          ⤢ Rearrange
        </button>
        <button
          type="button"
          className="app__refresh-toggle"
          onClick={handleTogglePause}
          aria-pressed={paused}
        >
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <ThemeToggle selected={theme} onChange={handleThemeChange} />
        {summary && <span className="app__summary">{summary}</span>}
      </header>
      <div className="app__body">
        <main className="app__canvas">
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
          {state.status === 'ready' && state.nodes.length > 0 && (
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
            >
              <Background color="var(--rf-background-dot)" />
              <Controls showInteractive={false} />
              <PanControls />
            </ReactFlow>
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
              onClose={() => setSelectedWorkloadId(null)}
            />
          ) : (
            <FlowsTable
              flows={state.status === 'ready' ? state.graph.edges : []}
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
