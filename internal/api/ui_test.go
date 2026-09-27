package api_test

import (
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/rafaelpissolatto/kubelynx/internal/api"
)

func TestUIHandler_NotEmbedded_Returns503WithHint(t *testing.T) {
	rec := httptest.NewRecorder()

	api.UIHandler(nil, false).ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))

	if rec.Code != 503 {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "frontend not embedded") {
		t.Errorf("body = %q, want it to explain the frontend isn't embedded", rec.Body.String())
	}
}

// builtUI mimics the shape of Vite's web/dist output.
var builtUI = fstest.MapFS{
	"index.html":        {Data: []byte("<!doctype html><title>KubeLynx</title>")},
	"assets/app-abc.js": {Data: []byte("console.log('app')")},
	"favicon.ico":       {Data: []byte("ico")},
}

func serveUI(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	api.UIHandler(builtUI, true).ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
	return rec
}

func TestUIHandler_Root_ServesIndexWithoutCaching(t *testing.T) {
	rec := serveUI(t, "/")

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "<title>KubeLynx</title>") {
		t.Errorf("body = %q, want index.html", rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("Cache-Control = %q, want no-cache", cc)
	}
}

func TestUIHandler_HashedAsset_CachedImmutably(t *testing.T) {
	rec := serveUI(t, "/assets/app-abc.js")

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got, want := rec.Header().Get("Cache-Control"), "public, max-age=31536000, immutable"; got != want {
		t.Errorf("Cache-Control = %q, want %q", got, want)
	}
}

func TestUIHandler_UnknownPath_FallsBackToIndex(t *testing.T) {
	rec := serveUI(t, "/some/deep/link")

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "<title>KubeLynx</title>") {
		t.Errorf("body = %q, want index.html", rec.Body.String())
	}
}

func TestUIHandler_UnknownAPIPath_Returns404(t *testing.T) {
	rec := serveUI(t, "/api/unknown")

	if rec.Code != 404 {
		t.Errorf("status = %d, want 404", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "<title>KubeLynx</title>") {
		t.Error("unknown API path was answered with index.html")
	}
}

func TestUIHandler_MissingHashedAsset_Returns404(t *testing.T) {
	// e.g. a stale tab asking for the previous release's bundle: answering
	// with index.html would get cached as that asset for a year.
	rec := serveUI(t, "/assets/app-old.js")

	if rec.Code != 404 {
		t.Errorf("status = %d, want 404", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); strings.Contains(cc, "immutable") {
		t.Errorf("Cache-Control = %q on a 404, want it not cached immutably", cc)
	}
}

func TestUIHandler_AssetsDirectory_Returns404NotListing(t *testing.T) {
	rec := serveUI(t, "/assets/")

	if rec.Code != 404 {
		t.Errorf("status = %d, want 404; body: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "app-abc.js") {
		t.Error("response lists the bundle's files")
	}
}
