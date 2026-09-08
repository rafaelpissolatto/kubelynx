import { useEffect, useMemo, useState } from 'react'
import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './App.css'
import { fetchTopology, type Graph } from './lib/topology'
import { layoutGraph } from './lib/layout'
import { WorkloadNode } from './components/WorkloadNode'

const DEFAULT_NAMESPACE = 'default'
const nodeTypes = { workload: WorkloadNode }

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; nodes: Node[]; edges: Edge[]; graph: Graph }

function App() {
  const [namespace] = useState(
    () => new URLSearchParams(window.location.search).get('namespace') ?? DEFAULT_NAMESPACE,
  )
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false

    fetchTopology(namespace)
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
  }, [namespace])

  const summary = useMemo(() => {
    if (state.status !== 'ready') return null
    return `${state.graph.nodes.length} workloads · ${state.graph.edges.length} flows`
  }, [state])

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__brand">KubeLynx</span>
        <span className="app__namespace">ns {namespace}</span>
        {summary && <span className="app__summary">{summary}</span>}
      </header>
      <main className="app__canvas">
        {state.status === 'loading' && <div className="app__status">Loading topology…</div>}
        {state.status === 'error' && (
          <div className="app__status app__status--error">{state.message}</div>
        )}
        {state.status === 'ready' && state.nodes.length === 0 && (
          <div className="app__status">No workload traffic observed in "{namespace}" yet.</div>
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
