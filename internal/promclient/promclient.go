// Package promclient builds the Prometheus API client KubeLynx queries Beyla's
// flow metrics through, including its optional bearer-token authentication.
package promclient

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"

	promapi "github.com/prometheus/client_golang/api"
	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"
)

// New returns a Prometheus API client for baseURL. When bearerTokenFile is
// set, every request carries "Authorization: Bearer <token>" read from it.
func New(baseURL, bearerTokenFile string) (promv1.API, error) {
	if baseURL == "" {
		return nil, errors.New("prometheus URL is required")
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("invalid prometheus URL %q: %w", baseURL, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("prometheus URL %q must use http or https", baseURL)
	}

	cfg := promapi.Config{Address: baseURL}
	if bearerTokenFile != "" {
		// Fail fast on a misconfigured Secret mount rather than on the first
		// query, where it would read as "Prometheus unreachable" in the UI.
		token, err := readToken(bearerTokenFile)
		if err != nil {
			return nil, err
		}
		if token == "" {
			return nil, fmt.Errorf("prometheus bearer token file %s is empty", bearerTokenFile)
		}
		if u.Scheme == "http" {
			slog.Warn("sending prometheus bearer token over plain HTTP", "prometheus", baseURL)
		}
		cfg.RoundTripper = &bearerFileRoundTripper{path: bearerTokenFile, host: u.Host, next: promapi.DefaultRoundTripper}
	}

	client, err := promapi.NewClient(cfg)
	if err != nil {
		return nil, err
	}
	return promv1.NewAPI(client), nil
}

// bearerFileRoundTripper sets "Authorization: Bearer <token>" on each
// request to host, re-reading the token from path every time so a rotated
// Kubernetes Secret takes effect without a restart — the same semantics as
// Prometheus's own bearer_token_file.
type bearerFileRoundTripper struct {
	path string
	host string // the configured Prometheus host; the only one that gets the token
	next http.RoundTripper
}

func (rt *bearerFileRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	// Redirects can lead anywhere, including via same-host hops after leaving
	// the configured host, so check the destination itself rather than the
	// previous hop.
	if req.URL.Host != rt.host {
		return rt.next.RoundTrip(req)
	}
	token, err := readToken(rt.path)
	if err != nil {
		return nil, err
	}
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+token)
	return rt.next.RoundTrip(req)
}

// readToken returns the whitespace-trimmed contents of path. Errors name the
// path but never include the file's contents.
func readToken(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("reading prometheus bearer token file %s: %w", path, err)
	}
	return strings.TrimSpace(string(b)), nil
}
