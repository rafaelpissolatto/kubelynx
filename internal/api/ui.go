package api

import (
	"io/fs"
	"net/http"
	"strings"
)

// UIHandler serves the built frontend from assets. embedded is false when the
// binary was built without the frontend (see package web), in which case
// every request gets a 503 pointing at how to get a UI.
func UIHandler(assets fs.FS, embedded bool) http.Handler {
	if !embedded {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, `frontend not embedded: build with -tags embedui (or run "npm run dev" in web/)`, http.StatusServiceUnavailable)
		})
	}
	files := http.FileServerFS(assets)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Vite content-hashes everything under assets/, so those names change
		// whenever their content does; everything else (index.html, icons)
		// keeps its name across releases and must be revalidated.
		isAsset := strings.HasPrefix(r.URL.Path, "/assets/")

		if name := strings.TrimPrefix(r.URL.Path, "/"); name != "" {
			if info, err := fs.Stat(assets, strings.TrimSuffix(name, "/")); err != nil || info.IsDir() {
				// API routes and hashed assets have no page to fall back to:
				// a missing one is a real 404. Directories are never listed.
				if isAsset || strings.HasPrefix(r.URL.Path, "/api/") {
					http.NotFound(w, r)
					return
				}
				// Anything else gets the app shell, so a deep link never 404s.
				// The UI keeps its state in query params today, but this keeps
				// that a frontend-only choice.
				r = r.Clone(r.Context())
				r.URL.Path = "/"
				isAsset = false
			}
		}

		if isAsset {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}
