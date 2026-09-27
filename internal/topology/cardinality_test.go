package topology_test

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

func TestDefaultPortCardinality(t *testing.T) {
	cardinality := topology.DefaultPortCardinality()
	if len(cardinality.AllowedTCPPorts) == 0 {
		t.Error("DefaultPortCardinality().AllowedTCPPorts is empty")
	}
}

func TestLoadPortCardinality_EmptyPathReturnsDefaults(t *testing.T) {
	cardinality, err := topology.LoadPortCardinality("")
	if err != nil {
		t.Fatalf(`LoadPortCardinality("") error: %v`, err)
	}
	if !reflect.DeepEqual(cardinality, topology.DefaultPortCardinality()) {
		t.Errorf("LoadPortCardinality(\"\") = %+v, want defaults %+v", cardinality, topology.DefaultPortCardinality())
	}
}

func TestLoadPortCardinality_ReadsOverridesFromFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "port-cardinality.json")
	if err := os.WriteFile(path, []byte(`{"tcp":["80","443","8080"]}`), 0o600); err != nil {
		t.Fatalf("writing fixture file: %v", err)
	}

	cardinality, err := topology.LoadPortCardinality(path)
	if err != nil {
		t.Fatalf("LoadPortCardinality(%q) error: %v", path, err)
	}
	want := topology.PortCardinality{AllowedTCPPorts: []string{"80", "443", "8080"}}
	if !reflect.DeepEqual(cardinality, want) {
		t.Errorf("LoadPortCardinality(%q) = %+v, want %+v", path, cardinality, want)
	}
}

func TestLoadPortCardinality_MissingFileErrors(t *testing.T) {
	_, err := topology.LoadPortCardinality(filepath.Join(t.TempDir(), "does-not-exist.json"))
	if err == nil {
		t.Fatal("LoadPortCardinality with missing file: want error, got nil")
	}
}

func TestLoadPortCardinality_InvalidJSONErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "port-cardinality.json")
	if err := os.WriteFile(path, []byte(`not json`), 0o600); err != nil {
		t.Fatalf("writing fixture file: %v", err)
	}

	_, err := topology.LoadPortCardinality(path)
	if err == nil {
		t.Fatal("LoadPortCardinality with invalid JSON: want error, got nil")
	}
}
