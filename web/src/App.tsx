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
