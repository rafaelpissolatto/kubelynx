package topology

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
)

// Protocol filter values BuildTopology accepts. beyla_network_flow_bytes_total
// only reports L3/L4 attributes (transport is "TCP" or "UDP"; there's no
// application-protocol label), so HTTP and GRPC aren't label matches — they're
// classified from dst_port via ProtocolClasses, a configurable heuristic
// rather than genuine protocol detection. See issue #6.
const (
	ProtocolAll  = "all"
	ProtocolHTTP = "http"
	ProtocolGRPC = "grpc"
	ProtocolTCP  = "tcp"
)

// ValidProtocols lists every value BuildTopology's protocol filter accepts.
var ValidProtocols = []string{ProtocolAll, ProtocolHTTP, ProtocolGRPC, ProtocolTCP}

// IsValidProtocol reports whether protocol is one of ValidProtocols.
func IsValidProtocol(protocol string) bool {
	return slices.Contains(ValidProtocols, protocol)
}

// ProtocolClasses maps the ProtocolHTTP and ProtocolGRPC filter values to the
// destination ports that count as each, for clusters whose workloads follow
// those conventions. Operators whose workloads use non-default ports can
// override it via LoadProtocolClasses.
type ProtocolClasses struct {
	HTTPPorts []string `json:"http"`
	GRPCPorts []string `json:"grpc"`
}

// DefaultProtocolClasses returns the built-in HTTP/gRPC port classification,
// covering common conventional ports for each.
func DefaultProtocolClasses() ProtocolClasses {
	return ProtocolClasses{
		HTTPPorts: []string{"80", "443", "3000", "5000", "8000", "8080", "8443"},
		GRPCPorts: []string{"50051", "9090"},
	}
}

// LoadProtocolClasses reads a ProtocolClasses port mapping from the JSON file
// at path, e.g. {"http": ["80","8080"], "grpc": ["50051"]}. An empty path
// returns DefaultProtocolClasses unchanged.
func LoadProtocolClasses(path string) (ProtocolClasses, error) {
	if path == "" {
		return DefaultProtocolClasses(), nil
	}

	// Path comes from an operator-set CLI flag, not from a request.
	data, err := os.ReadFile(path) // #nosec G304 -- operator-supplied config file path
	if err != nil {
		return ProtocolClasses{}, fmt.Errorf("reading protocol classes file %s: %w", path, err)
	}

	var classes ProtocolClasses
	if err := json.Unmarshal(data, &classes); err != nil {
		return ProtocolClasses{}, fmt.Errorf("parsing protocol classes file %s: %w", path, err)
	}
	return classes, nil
}
