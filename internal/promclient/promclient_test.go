package promclient_test

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
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

	prom, err := promclient.New(promclient.Options{URL: srv.URL})
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

	prom, err := promclient.New(promclient.Options{URL: srv.URL, BearerTokenFile: path})
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

	prom, err := promclient.New(promclient.Options{URL: srv.URL, BearerTokenFile: path})
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
			_, err := promclient.New(promclient.Options{URL: "http://prometheus.example:9090", BearerTokenFile: tt.path})
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
			_, err := promclient.New(promclient.Options{URL: tt.url})
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

	prom, err := promclient.New(promclient.Options{URL: redirector.URL, BearerTokenFile: path})
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

	prom, err := promclient.New(promclient.Options{URL: srv.URL, BearerTokenFile: path})
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

	prom, err := promclient.New(promclient.Options{URL: redirector.URL, BearerTokenFile: path})
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

// basicHeader is what a server should receive for HTTP Basic auth.
func basicHeader(user, password string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+password))
}

// withUserinfo returns rawURL with user:password embedded in it.
func withUserinfo(t *testing.T, rawURL, user, password string) string {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parsing %q: %v", rawURL, err)
	}
	u.User = url.UserPassword(user, password)
	return u.String()
}

func TestNew_BasicAuth_SendsTrimmedBasicHeader(t *testing.T) {
	srv, auths := newRecordingServer(t)
	path := writeTokenFile(t, "  Complex#pass:1\n")

	prom, err := promclient.New(promclient.Options{URL: srv.URL, BasicAuthUsername: "root@example.com", BasicAuthPasswordFile: path})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := query(t, prom); err != nil {
		t.Fatalf("query: %v", err)
	}

	want := basicHeader("root@example.com", "Complex#pass:1")
	if len(*auths) != 1 || (*auths)[0] != want {
		t.Errorf("Authorization headers = %q, want [%q]", *auths, want)
	}
}

func TestNew_BasicAuthPasswordFileRotated_NextRequestUsesNewPassword(t *testing.T) {
	srv, auths := newRecordingServer(t)
	path := writeTokenFile(t, "old")

	prom, err := promclient.New(promclient.Options{URL: srv.URL, BasicAuthUsername: "kubelynx", BasicAuthPasswordFile: path})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := query(t, prom); err != nil {
		t.Fatalf("first query: %v", err)
	}
	if err := os.WriteFile(path, []byte("new"), 0o600); err != nil {
		t.Fatalf("rotating password file: %v", err)
	}
	if err := query(t, prom); err != nil {
		t.Fatalf("second query: %v", err)
	}

	want := []string{basicHeader("kubelynx", "old"), basicHeader("kubelynx", "new")}
	if fmt.Sprint(*auths) != fmt.Sprint(want) {
		t.Errorf("Authorization headers = %q, want %q", *auths, want)
	}
}

func TestNew_BasicAuthPasswordFileUnusable_FailsAtStartup(t *testing.T) {
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
			_, err := promclient.New(promclient.Options{URL: "http://prometheus.example:9090", BasicAuthUsername: "kubelynx", BasicAuthPasswordFile: tt.path})
			if err == nil {
				t.Fatal("New returned no error")
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error = %q, want it to contain %q", err, tt.wantErr)
			}
		})
	}
}

func TestNew_BasicAuthPasswordFileGoneAfterStartup_QueryFailsWithoutReachingPrometheus(t *testing.T) {
	tests := []struct {
		name   string
		breakf func(path string) error
	}{
		{name: "removed", breakf: os.Remove},
		{name: "emptied", breakf: func(path string) error { return os.WriteFile(path, nil, 0o600) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv, auths := newRecordingServer(t)
			path := writeTokenFile(t, "s3cret-password")

			prom, err := promclient.New(promclient.Options{URL: srv.URL, BasicAuthUsername: "kubelynx", BasicAuthPasswordFile: path})
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			if err := tt.breakf(path); err != nil {
				t.Fatalf("breaking password file: %v", err)
			}

			err = query(t, prom)
			if err == nil {
				t.Fatal("query succeeded, want an error")
			}
			if len(*auths) != 0 {
				t.Errorf("Prometheus received %d requests, want 0", len(*auths))
			}
		})
	}
}

func TestNew_BasicAuthCrossHostRedirect_DoesNotForwardCredentials(t *testing.T) {
	other, otherAuths := newRecordingServer(t)
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+r.URL.RequestURI(), http.StatusFound)
	}))
	t.Cleanup(redirector.Close)
	path := writeTokenFile(t, "s3cret-password")

	prom, err := promclient.New(promclient.Options{URL: redirector.URL, BasicAuthUsername: "kubelynx", BasicAuthPasswordFile: path})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := query(t, prom); err != nil {
		t.Fatalf("query: %v", err)
	}

	if len(*otherAuths) != 1 || (*otherAuths)[0] != "" {
		t.Errorf("redirect target received Authorization headers %q, want one empty header", *otherAuths)
	}
}

func TestNew_BasicAuthCrossHostRedirectChain_NeverForwardsCredentials(t *testing.T) {
	// Same shape as the bearer chain test: A → B → B, and only A may see
	// the credentials.
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
	path := writeTokenFile(t, "s3cret-password")

	prom, err := promclient.New(promclient.Options{URL: redirector.URL, BasicAuthUsername: "kubelynx", BasicAuthPasswordFile: path})
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

func TestNew_ConflictingOrPartialAuth_FailsAtStartup(t *testing.T) {
	password := writeTokenFile(t, "s3cret-password")
	token := writeTokenFile(t, "s3cret-token")
	const promURL = "http://prometheus.example:9090"
	tests := []struct {
		name string
		opts promclient.Options
	}{
		{name: "username without password file", opts: promclient.Options{URL: promURL, BasicAuthUsername: "kubelynx"}},
		{name: "password file without username", opts: promclient.Options{URL: promURL, BasicAuthPasswordFile: password}},
		{name: "bearer and basic", opts: promclient.Options{URL: promURL, BearerTokenFile: token, BasicAuthUsername: "kubelynx", BasicAuthPasswordFile: password}},
		{name: "URL userinfo and basic", opts: promclient.Options{URL: "http://user:url-s3cret@prometheus.example:9090", BasicAuthUsername: "kubelynx", BasicAuthPasswordFile: password}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := promclient.New(tt.opts)
			if err == nil {
				t.Fatal("New returned no error")
			}
			if strings.Contains(err.Error(), "s3cret") {
				t.Errorf("error %q contains a credential", err)
			}
		})
	}
}

func TestNew_URLUserinfo_StillSentAsBasicAuth(t *testing.T) {
	srv, auths := newRecordingServer(t)

	prom, err := promclient.New(promclient.Options{URL: withUserinfo(t, srv.URL, "root@example.com", "Complex#pass")})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := query(t, prom); err != nil {
		t.Fatalf("query: %v", err)
	}

	want := basicHeader("root@example.com", "Complex#pass")
	if len(*auths) != 1 || (*auths)[0] != want {
		t.Errorf("Authorization headers = %q, want [%q]", *auths, want)
	}
}

func TestNew_URLUserinfo_ConstructorErrorsNeverContainPassword(t *testing.T) {
	for _, rawURL := range []string{
		"ftp://user:url-s3cret@prometheus.example:9090",
		// An unencoded '#' makes url.Parse read "url-s3cret" as a port.
		"http://user:url-s3cret#x@prometheus.example:9090",
		"http://user:url-s3cret%zz@prometheus.example:9090",
	} {
		t.Run(rawURL, func(t *testing.T) {
			_, err := promclient.New(promclient.Options{URL: rawURL})
			if err == nil {
				t.Fatal("New returned no error")
			}
			if strings.Contains(err.Error(), "s3cret") {
				t.Errorf("error %q contains the password", err)
			}
		})
	}
}

func TestNew_URLUserinfo_QueryErrorNeverContainsPassword(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	srv.Close() // nothing listens there any more, so the query fails

	prom, err := promclient.New(promclient.Options{URL: withUserinfo(t, srv.URL, "kubelynx", "url-s3cret")})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	err = query(t, prom)
	if err == nil {
		t.Fatal("query succeeded, want an error")
	}
	if strings.Contains(err.Error(), "url-s3cret") {
		t.Errorf("query error %q contains the password", err)
	}
}

func TestNew_ReportsRedactedURLAndAuthMode(t *testing.T) {
	password := writeTokenFile(t, "s3cret-password")
	token := writeTokenFile(t, "s3cret-token")
	tests := []struct {
		name     string
		opts     promclient.Options
		wantURL  string
		wantAuth string
	}{
		{name: "none", opts: promclient.Options{URL: "http://prometheus.example:9090"},
			wantURL: "http://prometheus.example:9090", wantAuth: "none"},
		{name: "bearer file", opts: promclient.Options{URL: "https://prometheus.example", BearerTokenFile: token},
			wantURL: "https://prometheus.example", wantAuth: "bearer-file"},
		{name: "basic file", opts: promclient.Options{URL: "https://prometheus.example", BasicAuthUsername: "kubelynx", BasicAuthPasswordFile: password},
			wantURL: "https://prometheus.example", wantAuth: "basic-file"},
		{name: "URL userinfo", opts: promclient.Options{URL: "http://root%40example.com:url-s3cret@prometheus.example:5080/api/default/prometheus"},
			wantURL: "http://root%40example.com:xxxxx@prometheus.example:5080/api/default/prometheus", wantAuth: "url-userinfo"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			prom, err := promclient.New(tt.opts)
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			if got := prom.RedactedURL(); got != tt.wantURL {
				t.Errorf("RedactedURL() = %q, want %q", got, tt.wantURL)
			}
			if got := prom.AuthMode(); got != tt.wantAuth {
				t.Errorf("AuthMode() = %q, want %q", got, tt.wantAuth)
			}
		})
	}
}
