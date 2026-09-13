import { useCallback, useEffect, useMemo, useState } from 'react'
import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './App.css'
import {
  fetchNamespaces,
  fetchProtocols,
  fetchTopology,
  flowId,
  TopologyError,
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

async function loadTopology(namespace: string, protocol: ProtocolFilterValue) {
  const graph = await fetchTopology(namespace, protocol)
  const { nodes, edges } = await layoutGraph(graph)
  return { nodes, edges, graph }
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
          setState({ status: 'error', ...classifyTopologyError(err) })
        }
      })

    return () => {
      cancelled = true
    }
  }, [namespaceParam, protocol])

  // A failed background refresh doesn't replace the last-rendered graph with
  // an error screen — it just logs and leaves the graph as-is; the
  // unreachable/invalid/empty states above only ever come from the initial
  // (or namespace/protocol-change-triggered) load.
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

  // Conservative by construction: while /api/namespaces hasn't resolved yet
  // (or failed), this stays false, so a zero-node topology result renders as
  // the less-alarming "no traffic right now" rather than risking a false
  // "misconfigured" warning.
  const noTrafficEverObserved = namespacesLoaded && namespaces.length === 0

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
