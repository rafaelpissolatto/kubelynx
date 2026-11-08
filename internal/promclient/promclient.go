// Package promclient builds the Prometheus API client KubeLynx queries Beyla's
// flow metrics through, including its optional authentication: a bearer-token
// file, or HTTP Basic auth with a password file.
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

// Auth modes reported by Client.AuthMode, for the startup log.
const (
	AuthNone        = "none"
	AuthBearerFile  = "bearer-file"
	AuthBasicFile   = "basic-file"
	AuthURLUserinfo = "url-userinfo"
)

// Options configures New. Only URL is required; at most one auth mode may be
// set (credentials embedded in URL count as one, alongside the bearer file and
// the Basic-auth pair).
type Options struct {
	// URL is the base URL of the Prometheus HTTP API.
	URL string
	// BearerTokenFile, when set, sends "Authorization: Bearer <token>" read
	// from this file.
	BearerTokenFile string
	// BasicAuthUsername and BasicAuthPasswordFile, set together, send HTTP
	// Basic auth with the password read from the file.
	BasicAuthUsername     string
	BasicAuthPasswordFile string
}

// Client is a Prometheus API client that also reports how it was configured,
// in a form that is safe to log.
type Client struct {
	promv1.API
	redactedURL string
	authMode    string
}

// RedactedURL returns the configured Prometheus URL with any password
// embedded in it replaced, so it can be logged.
func (c *Client) RedactedURL() string { return c.redactedURL }

// AuthMode returns which credential the client sends: AuthNone,
// AuthBearerFile, AuthBasicFile or AuthURLUserinfo.
func (c *Client) AuthMode() string { return c.authMode }

// New returns a Prometheus API client for opts.URL. Credential files are
// checked here, so a misconfigured Secret mount fails at startup, and then
// re-read on every request, so a rotated Secret applies without a restart.
// No error ever contains a credential: URLs are redacted and credential files
// are named but never quoted.
func New(opts Options) (*Client, error) {
	if opts.URL == "" {
		return nil, errors.New("prometheus URL is required")
	}
	u, err := url.Parse(opts.URL)
	if err != nil {
		// url.Parse's own error quotes the raw URL, and its inner error can
		// quote part of a malformed password (e.g. as an "invalid port"), so
		// neither is safe to surface when the URL carries userinfo.
		if strings.Contains(opts.URL, "@") {
			return nil, fmt.Errorf("invalid prometheus URL %q (are special characters in its credentials percent-encoded?)", redactUnparsed(opts.URL))
		}
		var uerr *url.Error
		if errors.As(err, &uerr) {
			err = uerr.Err
		}
		return nil, fmt.Errorf("invalid prometheus URL %q: %w", opts.URL, err)
	}
	redacted := u.Redacted()
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("prometheus URL %q must use http or https", redacted)
	}

	bearer := opts.BearerTokenFile != ""
	basic := opts.BasicAuthUsername != "" || opts.BasicAuthPasswordFile != ""
	switch {
	case opts.BasicAuthUsername != "" && opts.BasicAuthPasswordFile == "":
		return nil, errors.New("prometheus basic auth username is set but no password file is")
	case opts.BasicAuthUsername == "" && opts.BasicAuthPasswordFile != "":
		return nil, errors.New("prometheus basic auth password file is set but no username is")
	case basic && bearer:
		return nil, errors.New("prometheus bearer token file and basic auth are mutually exclusive; configure only one")
	case basic && u.User != nil:
		return nil, fmt.Errorf("prometheus URL %q already carries credentials; remove them or the basic auth settings, not both", redacted)
	}

	c := &Client{redactedURL: redacted, authMode: AuthNone}
	if u.User != nil {
		// Go's HTTP client sends URL userinfo as Basic auth by itself.
		c.authMode = AuthURLUserinfo
	}
	cfg := promapi.Config{Address: opts.URL}
	var cred *credentialFile
	switch {
	case bearer:
		c.authMode = AuthBearerFile
		cred = &credentialFile{path: opts.BearerTokenFile, kind: "bearer token", apply: func(req *http.Request, token string) {
			req.Header.Set("Authorization", "Bearer "+token)
		}}
	case basic:
		c.authMode = AuthBasicFile
		username := opts.BasicAuthUsername
		cred = &credentialFile{path: opts.BasicAuthPasswordFile, kind: "basic auth password", apply: func(req *http.Request, password string) {
			req.SetBasicAuth(username, password)
		}}
	}
	if cred != nil {
		// Fail fast on a misconfigured Secret mount rather than on the first
		// query, where it would read as "Prometheus unreachable" in the UI.
		if _, err := cred.read(); err != nil {
			return nil, err
		}
		if u.Scheme == "http" {
			slog.Warn("sending prometheus "+cred.kind+" over plain HTTP", "prometheus", redacted)
		}
		cfg.RoundTripper = &credentialFileRoundTripper{cred: cred, host: u.Host, next: promapi.DefaultRoundTripper}
	}

	client, err := promapi.NewClient(cfg)
	if err != nil {
		return nil, err
	}
	c.API = promv1.NewAPI(client)
	return c, nil
}

// credentialFile is a secret kept in a file (typically a mounted Kubernetes
// Secret) and how to put it on a request.
type credentialFile struct {
	path  string
	kind  string // for messages, e.g. "bearer token"
	apply func(req *http.Request, secret string)
}

// read returns the whitespace-trimmed contents of the file. Errors name the
// file but never include its contents.
func (c *credentialFile) read() (string, error) {
	b, err := os.ReadFile(c.path)
	if err != nil {
		return "", fmt.Errorf("reading prometheus %s file %s: %w", c.kind, c.path, err)
	}
	secret := strings.TrimSpace(string(b))
	if secret == "" {
		return "", fmt.Errorf("prometheus %s file %s is empty", c.kind, c.path)
	}
	return secret, nil
}

// credentialFileRoundTripper puts the credential on each request to host,
// re-reading it every time so a rotated Kubernetes Secret takes effect without
// a restart — the same semantics as Prometheus's own bearer_token_file and
// basic_auth.password_file.
type credentialFileRoundTripper struct {
	cred *credentialFile
	host string // the configured Prometheus host; the only one that gets the credential
	next http.RoundTripper
}

func (rt *credentialFileRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	// Redirects can lead anywhere, including via same-host hops after leaving
	// the configured host, so check the destination itself rather than the
	// previous hop.
	if req.URL.Host != rt.host {
		return rt.next.RoundTrip(req)
	}
	secret, err := rt.cred.read()
	if err != nil {
		return nil, err
	}
	req = req.Clone(req.Context())
	rt.cred.apply(req, secret)
	return rt.next.RoundTrip(req)
}

// redactUnparsed hides the userinfo of a URL that url.Parse rejected. Without
// a parse, the userinfo can't be located exactly (an unencoded '#', '/' or '@'
// in a password moves the apparent boundaries), so everything between the
// scheme and the last '@' is hidden, erring towards hiding too much.
func redactUnparsed(raw string) string {
	at := strings.LastIndex(raw, "@")
	if at < 0 {
		return raw
	}
	prefix := ""
	if i := strings.Index(raw, "://"); i >= 0 && i < at {
		prefix = raw[:i+3]
	}
	return prefix + "xxxxx" + raw[at:]
}
