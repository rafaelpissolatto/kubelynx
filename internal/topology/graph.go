// Package topology builds KubeLynx's Graph (Workload nodes + Flow edges) by
// querying Prometheus for Beyla's beyla_network_flow_bytes_total series.
package topology

// Graph is the JSON shape served by /api/topology.
type Graph struct {
	Nodes []Workload `json:"nodes"`
	Edges []Flow     `json:"edges"`
}

// Workload is a Kubernetes owner object (Deployment, ReplicaSet, DaemonSet,
// or StatefulSet) plus its namespace — see CONTEXT.md's "Workload" entry.
type Workload struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	OwnerKind string `json:"ownerKind,omitempty"`
}

// Flow is a directed edge between two Workloads, backed by one
// beyla_network_flow_bytes_total series.
type Flow struct {
	Source         string  `json:"source"`
	Target         string  `json:"target"`
	Protocol       string  `json:"protocol,omitempty"`
	Port           string  `json:"port,omitempty"`
	BytesPerSecond float64 `json:"bytesPerSecond"`
	Query          string  `json:"query"`
}
