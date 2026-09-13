import { useCallback, useEffect, useMemo, useState } from 'react'
import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './App.css'
import {
  fetchNamespaces,
  fetchProtocols,
  fetchTopology,
  flowId,
  type Graph,
  type ProtocolFilter as ProtocolFilterValue,
} from './lib/topology'
import { layoutGraph } from './lib/layout'
import { WorkloadNode } from './components/WorkloadNode'
import { NamespaceBand } from './components/NamespaceBand'
import { NamespaceMultiSelect } from './components/NamespaceMultiSelect'
import { ProtocolFilter } from './components/ProtocolFilter'
import { FlowsTable } from './components/FlowsTable'
import { FlowDetailPanel } from './components/FlowDetailPanel'

const SELECTED_FLOW_STROKE = '#f2c078'
const UNSELECTED_FLOW_OPACITY = 0.35

const DEFAULT_NAMESPACE = 'default'
const DEFAULT_PROTOCOL: ProtocolFilterValue = 'all'
const DEFAULT_REFRESH_INTERVAL_MS = 15000
const nodeTypes = { workload: WorkloadNode, namespaceBand: NamespaceBand }

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; nodes: Node[]; edges: Edge[]; graph: Graph }

async function loadTopology(namespace: string, protocol: ProtocolFilterValue) {
  const graph = await fetchTopology(namespace, protocol)
  const { nodes, edges } = await layoutGraph(graph)
  return { nodes, edges, graph }
}

function App() {
  const [selectedNamespaces, setSelectedNamespaces] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get('namespace')
    return raw ? raw.split(',') : [DEFAULT_NAMESPACE]
  })
  const [namespaces, setNamespaces] = useState<string[]>([])
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
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // Identifies the flow selected in either the table or the graph — see
  // flowId — so the two stay in sync no matter which one triggered it.
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null)
  // Configurable via ?refreshInterval=<ms>, same convention as ?namespace=.
  const [refreshIntervalMs] = useState(() => {
    const raw = Number(new URLSearchParams(window.location.search).get('refreshInterval'))
    return raw > 0 ? raw : DEFAULT_REFRESH_INTERVAL_MS
  })
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    let cancelled = false

    fetchNamespaces()
      .then((res) => {
        if (!cancelled) {
          setNamespaces(res.namespaces)
          setAllNamespacesValue(res.all)
          setMaxNamespaces(res.max)
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

  const namespaceParam = selectedNamespaces.join(',')

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    setSelectedFlowId(null)

    loadTopology(namespaceParam, protocol)
      .then((result) => {
        if (!cancelled) setState({ status: 'ready', ...result })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Failed to load topology',
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [namespaceParam, protocol])

  // A failed background refresh doesn't replace the last-rendered graph with
  // an error screen — it just logs and leaves the graph as-is (issue #8
  // owns proper error/empty-state UX).
  const refreshInBackground = useCallback(
    (cancelledRef: { current: boolean }) => {
      loadTopology(namespaceParam, protocol)
        .then((result) => {
          if (!cancelledRef.current) setState({ status: 'ready', ...result })
        })
        .catch((err: unknown) => {
          console.error('background topology refresh failed', err)
        })
    },
    [namespaceParam, protocol],
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
  const renderedEdges = useMemo(() => {
    if (state.status !== 'ready') return []
    if (!selectedFlowId) return state.edges
    return state.edges.map((edge) =>
      edge.id === selectedFlowId
        ? { ...edge, zIndex: 1, style: { ...edge.style, stroke: SELECTED_FLOW_STROKE } }
        : { ...edge, style: { ...edge.style, opacity: UNSELECTED_FLOW_OPACITY } },
    )
  }, [state, selectedFlowId])

  function toggleSelectedFlow(id: string) {
    setSelectedFlowId((prev) => (prev === id ? null : id))
  }

  function handleTogglePause() {
    if (paused) {
      // Resuming restarts the polling loop — refresh right away rather than
      // leaving the user staring at a stale graph until the next tick.
      refreshInBackground({ current: false })
    }
    setPaused((p) => !p)
  }

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__brand">KubeLynx</span>
        <NamespaceMultiSelect
          namespaces={namespaces}
          allValue={allNamespacesValue}
          max={maxNamespaces}
          selected={selectedNamespaces}
          onChange={setSelectedNamespaces}
        />
        <ProtocolFilter protocols={protocols} selected={protocol} onChange={setProtocol} />
        <button
          type="button"
          className="app__refresh-toggle"
          onClick={handleTogglePause}
          aria-pressed={paused}
        >
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        {summary && <span className="app__summary">{summary}</span>}
      </header>
      <div className="app__body">
        <main className="app__canvas">
          {state.status === 'loading' && <div className="app__status">Loading topology…</div>}
          {state.status === 'error' && (
            <div className="app__status app__status--error">{state.message}</div>
          )}
          {state.status === 'ready' && state.nodes.length === 0 && (
            <div className="app__status">
              No workload traffic observed in "{selectedNamespaces.join(', ')}" yet.
            </div>
          )}
          {state.status === 'ready' && state.nodes.length > 0 && (
            <ReactFlow
              nodes={state.nodes}
              edges={renderedEdges}
              nodeTypes={nodeTypes}
              fitView
              proOptions={{ hideAttribution: true }}
              onEdgeClick={(_, edge) => toggleSelectedFlow(edge.id)}
              onPaneClick={() => setSelectedFlowId(null)}
            >
              <Background />
            </ReactFlow>
          )}
        </main>
        <aside className="app__flows-panel">
          <FlowsTable
            flows={state.status === 'ready' ? state.graph.edges : []}
            selectedId={selectedFlowId}
            onSelect={toggleSelectedFlow}
          />
          <FlowDetailPanel flow={selectedFlow} />
        </aside>
      </div>
    </div>
  )
}

export default App
