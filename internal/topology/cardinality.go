package topology

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
)

// Research (issue #38): before implementing this server-side, we checked
// whether Beyla itself (the eBPF agent producing beyla_network_flow_bytes_total)
// can bound port cardinality natively. Beyla's attributes.select config (see
// dev/beyla/10-configmap.yaml) only supports choosing which attribute NAMES
// are reported per metric (include/exclude by name or wildcard, e.g.
// dropping dst.port entirely) — it has no value-level filtering (e.g. "only
// report dst.port when it's 80 or 443") and no way to roll up excluded
// values into a single bucket instead of dropping the attribute outright.
// So Beyla can only give us "every port" or "no port", neither of which
// satisfies "known ports individually, everything else aggregated as
// multiple". That rules out a Beyla-config fix, so the allow-list and
// aggregation are implemented here instead, in BuildTopology.

// MultiplePorts is the port value BuildTopology assigns to an edge that
// aggregates traffic across ports outside the configured cardinality bound
// (see PortCardinality and boundedPort), rather than one edge per port.
const MultiplePorts = "multiple"

// dnsPort is the only UDP port BuildTopology itemizes individually; every
// other UDP port collapses into MultiplePorts. Unlike the TCP allow-list,
// this isn't operator-configurable — DNS is the one UDP case issue #38 calls
// out by name, and the ephemeral/dynamic ports it's guarding against are a
// TCP-and-general-UDP problem, not something that varies by cluster the way
// "which TCP ports are your applications' well-known ports" does.
const dnsPort = "53"

// PortCardinality bounds the per-port detail BuildTopology retains for TCP
// traffic. A TCP flow whose destination port is in AllowedTCPPorts keeps its
// own edge; every other TCP port is folded into a single MultiplePorts edge
// per (source, target, protocol) pair. This mirrors ProtocolClasses: a
// built-in default operators can override via LoadPortCardinality, following
// the same pattern as LoadProtocolClasses.
type PortCardinality struct {
	AllowedTCPPorts []string `json:"tcp"`
}

// DefaultPortCardinality returns the built-in TCP allow-list, covering
// common well-known and conventional application ports.
func DefaultPortCardinality() PortCardinality {
	return PortCardinality{
		AllowedTCPPorts: []string{
			"20", "21", "22", "25", "53", "80", "110", "143", "443",
			"465", "587", "993", "995",
			"3000", "3306", "5000", "5432", "6379",
			"8000", "8080", "8443", "9090", "9200", "27017", "50051",
		},
	}
}

// LoadPortCardinality reads a PortCardinality allow-list from the JSON file
// at path, e.g. {"tcp": ["80","443","8080"]}. An empty path returns
// DefaultPortCardinality unchanged.
func LoadPortCardinality(path string) (PortCardinality, error) {
	if path == "" {
		return DefaultPortCardinality(), nil
	}

	// Path comes from an operator-set CLI flag, not from a request.
	data, err := os.ReadFile(path) // #nosec G304 -- operator-supplied config file path
	if err != nil {
		return PortCardinality{}, fmt.Errorf("reading port cardinality file %s: %w", path, err)
	}

	var cardinality PortCardinality
	if err := json.Unmarshal(data, &cardinality); err != nil {
		return PortCardinality{}, fmt.Errorf("parsing port cardinality file %s: %w", path, err)
	}
	return cardinality, nil
}

// boundedPort maps a series' raw (protocol, port) pair to the port value
// BuildTopology groups edges by: port unchanged for TCP ports in
// cardinality.AllowedTCPPorts and for UDP's DNS port, MultiplePorts for
// everything else on TCP or UDP. A missing port or a protocol other than TCP
// or UDP (including "", an attribute-degraded series) passes port through
// unchanged, since there's nothing to bound.
func boundedPort(protocol, port string, cardinality PortCardinality) string {
	if port == "" {
		return port
	}
	switch protocol {
	case "TCP":
		if slices.Contains(cardinality.AllowedTCPPorts, port) {
			return port
		}
		return MultiplePorts
	case "UDP":
		if port == dnsPort {
			return port
		}
		return MultiplePorts
	default:
		return port
	}
}

// portExclusionMatcher renders the PromQL matcher fragment (without
// enclosing braces) that drill-down queries for a MultiplePorts edge use to
// scope to exactly the ports BuildTopology folded into it, or "" when no
// such restriction applies (e.g. TCP with an empty allow-list, where every
// TCP port already collapses into MultiplePorts).
func portExclusionMatcher(protocol string, cardinality PortCardinality) string {
	switch protocol {
	case "TCP":
		if pattern := portPattern(cardinality.AllowedTCPPorts); pattern != "" {
			return fmt.Sprintf("dst_port!~%q", pattern)
		}
		return ""
	case "UDP":
		return fmt.Sprintf("dst_port!=%q", dnsPort)
	default:
		return ""
	}
}
