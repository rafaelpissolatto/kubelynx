package topology_test

import (
	"testing"

	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

func TestIsValidSource(t *testing.T) {
	for _, s := range []string{topology.SourceBeyla, topology.SourceIstio} {
		if !topology.IsValidSource(s) {
			t.Errorf("IsValidSource(%q) = false, want true", s)
		}
	}
	if topology.IsValidSource("prometheus") {
		t.Error(`IsValidSource("prometheus") = true, want false`)
	}
	if topology.IsValidSource("") {
		t.Error(`IsValidSource("") = true, want false (BuildTopology treats "" as a convenience default, not a valid selector value)`)
	}
}
