package topology_test

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

func TestIsValidProtocol(t *testing.T) {
	for _, p := range []string{topology.ProtocolAll, topology.ProtocolHTTP, topology.ProtocolGRPC, topology.ProtocolTCP} {
		if !topology.IsValidProtocol(p) {
			t.Errorf("IsValidProtocol(%q) = false, want true", p)
		}
	}
	if topology.IsValidProtocol("udp") {
		t.Error(`IsValidProtocol("udp") = true, want false`)
	}
}

func TestDefaultProtocolClasses(t *testing.T) {
	classes := topology.DefaultProtocolClasses()
	if len(classes.HTTPPorts) == 0 {
		t.Error("DefaultProtocolClasses().HTTPPorts is empty")
	}
	if len(classes.GRPCPorts) == 0 {
		t.Error("DefaultProtocolClasses().GRPCPorts is empty")
	}
}

func TestLoadProtocolClasses_EmptyPathReturnsDefaults(t *testing.T) {
	classes, err := topology.LoadProtocolClasses("")
	if err != nil {
		t.Fatalf("LoadProtocolClasses(\"\") error: %v", err)
	}
	if !reflect.DeepEqual(classes, topology.DefaultProtocolClasses()) {
		t.Errorf("LoadProtocolClasses(\"\") = %+v, want defaults %+v", classes, topology.DefaultProtocolClasses())
	}
}

func TestLoadProtocolClasses_ReadsOverridesFromFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "protocol-classes.json")
	if err := os.WriteFile(path, []byte(`{"http":["8081"],"grpc":["50052"]}`), 0o600); err != nil {
		t.Fatalf("writing fixture file: %v", err)
	}

	classes, err := topology.LoadProtocolClasses(path)
	if err != nil {
		t.Fatalf("LoadProtocolClasses(%q) error: %v", path, err)
	}
	want := topology.ProtocolClasses{HTTPPorts: []string{"8081"}, GRPCPorts: []string{"50052"}}
	if !reflect.DeepEqual(classes, want) {
		t.Errorf("LoadProtocolClasses(%q) = %+v, want %+v", path, classes, want)
	}
}

func TestLoadProtocolClasses_MissingFileErrors(t *testing.T) {
	_, err := topology.LoadProtocolClasses(filepath.Join(t.TempDir(), "does-not-exist.json"))
	if err == nil {
		t.Fatal("LoadProtocolClasses with missing file: want error, got nil")
	}
}

func TestLoadProtocolClasses_InvalidJSONErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "protocol-classes.json")
	if err := os.WriteFile(path, []byte(`not json`), 0o600); err != nil {
		t.Fatalf("writing fixture file: %v", err)
	}

	_, err := topology.LoadProtocolClasses(path)
	if err == nil {
		t.Fatal("LoadProtocolClasses with invalid JSON: want error, got nil")
	}
}
