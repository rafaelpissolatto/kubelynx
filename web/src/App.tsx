import { useEffect, useMemo, useState } from 'react'
import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './App.css'
import { fetchNamespaces, fetchTopology, type Graph } from './lib/topology'
import { layoutGraph } from './lib/layout'
import { WorkloadNode } from './components/WorkloadNode'
import { NamespaceBand } from './components/NamespaceBand'
import { NamespaceMultiSelect } from './components/NamespaceMultiSelect'

const DEFAULT_NAMESPACE = 'default'
const DEFAULT_REFRESH_INTERVAL_MS = 15000
const nodeTypes = { workload: WorkloadNode, namespaceBand: NamespaceBand }

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; nodes: Node[]; edges: Edge[]; graph: Graph }

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
  const [state, setState] = useState<LoadState>({ status: 'loading' })
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

  const namespaceParam = selectedNamespaces.join(',')

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })

    fetchTopology(namespaceParam)
      .then(async (graph) => {
        const { nodes, edges } = await layoutGraph(graph)
        if (!cancelled) setState({ status: 'ready', nodes, edges, graph })
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
  }, [namespaceParam])

  // Polls /api/topology on refreshIntervalMs while not paused, updating the
  // rendered graph in place without disturbing the current LoadState —
  // separate from the effect above so toggling `paused` never re-triggers
  // the initial loading transition and the last-rendered graph stays put.
  useEffect(() => {
    if (paused) return

    let cancelled = false
    const id = setInterval(() => {
      // A failed background refresh doesn't replace the last-rendered graph
      // with an error screen — it just logs and tries again next tick.
      fetchTopology(namespaceParam)
        .then(async (graph) => {
          const { nodes, edges } = await layoutGraph(graph)
          if (!cancelled) setState({ status: 'ready', nodes, edges, graph })
        })
        .catch((err: unknown) => {
          console.error('background topology refresh failed', err)
        })
    }, refreshIntervalMs)

    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [namespaceParam, refreshIntervalMs, paused])

  const summary = useMemo(() => {
    if (state.status !== 'ready') return null
    return `${state.graph.nodes.length} workloads · ${state.graph.edges.length} flows`
  }, [state])

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
        <button
          type="button"
          className="app__refresh-toggle"
          onClick={() => setPaused((p) => !p)}
          aria-pressed={paused}
        >
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        {summary && <span className="app__summary">{summary}</span>}
      </header>
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
            edges={state.edges}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
          </ReactFlow>
        )}
      </main>
    </div>
  )
}

export default App
