package promclient_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"

	"github.com/rafaelpissolatto/kubelynx/internal/promclient"
)

// newRecordingServer returns a fake Prometheus that answers label-values
// queries and records the Authorization header of every request it receives.
func newRecordingServer(t *testing.T) (*httptest.Server, *[]string) {
	t.Helper()
	var auths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auths = append(auths, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"success","data":["a"]}`)
	}))
	t.Cleanup(srv.Close)
	return srv, &auths
}

func writeTokenFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("writing token file: %v", err)
	}
	return path
}

func query(t *testing.T, prom promv1.API) error {
	t.Helper()
	_, _, err := prom.LabelValues(context.Background(), "__name__", nil, time.Time{}, time.Time{})
	return err
}

func TestNew_NoTokenFile_SendsNoAuthorizationHeader(t *testing.T) {
	srv, auths := newRecordingServer(t)

	prom, err := promclient.New(srv.URL, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := query(t, prom); err != nil {
		t.Fatalf("query: %v", err)
	}

	if len(*auths) != 1 || (*auths)[0] != "" {
		t.Errorf("Authorization headers = %q, want one empty header", *auths)
	}
}

func TestNew_TokenFile_SendsTrimmedBearerHeader(t *testing.T) {
	srv, auths := newRecordingServer(t)
	path := writeTokenFile(t, "  s3cret-token\n")

	prom, err := promclient.New(srv.URL, path)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := query(t, prom); err != nil {
		t.Fatalf("query: %v", err)
	}

	if len(*auths) != 1 || (*auths)[0] != "Bearer s3cret-token" {
		t.Errorf("Authorization headers = %q, want [\"Bearer s3cret-token\"]", *auths)
	}
}

func TestNew_TokenFileRotated_NextRequestUsesNewToken(t *testing.T) {
	srv, auths := newRecordingServer(t)
	path := writeTokenFile(t, "old")

	prom, err := promclient.New(srv.URL, path)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := query(t, prom); err != nil {
		t.Fatalf("first query: %v", err)
	}
	if err := os.WriteFile(path, []byte("new"), 0o600); err != nil {
		t.Fatalf("rotating token file: %v", err)
	}
	if err := query(t, prom); err != nil {
		t.Fatalf("second query: %v", err)
	}

	want := []string{"Bearer old", "Bearer new"}
	if fmt.Sprint(*auths) != fmt.Sprint(want) {
		t.Errorf("Authorization headers = %q, want %q", *auths, want)
	}
}

func TestNew_TokenFileUnusable_FailsAtStartup(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		wantErr string
	}{
		{name: "missing file", path: filepath.Join(t.TempDir(), "absent"), wantErr: "absent"},
		{name: "whitespace-only file", path: writeTokenFile(t, "  \n"), wantErr: "is empty"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := promclient.New("http://prometheus.example:9090", tt.path)
			if err == nil {
				t.Fatal("New returned no error")
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error = %q, want it to contain %q", err, tt.wantErr)
			}
		})
	}
}

func TestNew_ValidatesPrometheusURL(t *testing.T) {
	tests := []struct {
		url     string
		wantErr bool
	}{
		{url: "", wantErr: true},
		{url: "://bad", wantErr: true},
		{url: "ftp://prometheus.example:9090", wantErr: true},
		{url: "http://prometheus.monitoring.svc:9090", wantErr: false},
		{url: "https://prometheus.example", wantErr: false},
	}
	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			_, err := promclient.New(tt.url, "")
			if gotErr := err != nil; gotErr != tt.wantErr {
				t.Errorf("New(%q) error = %v, wantErr %v", tt.url, err, tt.wantErr)
			}
		})
	}
}

func TestNew_CrossHostRedirect_DoesNotForwardToken(t *testing.T) {
	other, otherAuths := newRecordingServer(t)
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+r.URL.RequestURI(), http.StatusFound)
	}))
	t.Cleanup(redirector.Close)
	path := writeTokenFile(t, "s3cret-token")

	prom, err := promclient.New(redirector.URL, path)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// The label-values call is a GET, so the redirect is followed.
	if err := query(t, prom); err != nil {
		t.Fatalf("query: %v", err)
	}

	if len(*otherAuths) != 1 || (*otherAuths)[0] != "" {
		t.Errorf("redirect target received Authorization headers %q, want one empty header", *otherAuths)
	}
}

func TestNew_TokenFileRemovedAfterStartup_QueryFailsWithoutReachingPrometheus(t *testing.T) {
	srv, auths := newRecordingServer(t)
	path := writeTokenFile(t, "s3cret-token")

	prom, err := promclient.New(srv.URL, path)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatalf("removing token file: %v", err)
	}

	if err := query(t, prom); err == nil {
		t.Fatal("query succeeded, want an error")
	}
	if len(*auths) != 0 {
		t.Errorf("Prometheus received %d requests, want 0", len(*auths))
	}
}

func TestNew_CrossHostRedirectChain_NeverForwardsToken(t *testing.T) {
	// A redirects to B, which redirects to itself once before answering: the
	// B→B hop is same-host, but the token was only ever meant for A.
	var otherAuths []string
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		otherAuths = append(otherAuths, r.Header.Get("Authorization"))
		if r.URL.Query().Get("hop") == "" {
			http.Redirect(w, r, r.URL.Path+"?hop=2", http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"success","data":["a"]}`)
	}))
	t.Cleanup(other.Close)
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+r.URL.Path, http.StatusFound)
	}))
	t.Cleanup(redirector.Close)
	path := writeTokenFile(t, "s3cret-token")

	prom, err := promclient.New(redirector.URL, path)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := query(t, prom); err != nil {
		t.Fatalf("query: %v", err)
	}

	want := []string{"", ""}
	if fmt.Sprint(otherAuths) != fmt.Sprint(want) {
		t.Errorf("redirect target received Authorization headers %q, want %q", otherAuths, want)
	}
}
