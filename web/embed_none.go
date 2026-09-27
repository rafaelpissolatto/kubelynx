//go:build !embedui

// Package web holds the Vite frontend and, in release builds, embeds its
// built output (dist/) into the Go binary so KubeLynx ships as one image
// (docs/adr/0001-single-image-packaging.md).
//
// Embedding sits behind the embedui build tag because dist/ is gitignored:
// an untagged build (go test ./..., go run ./cmd/kubelynx) works on a fresh
// clone with no frontend built, and serves the UI via "npm run dev" instead.
// The Dockerfile's build stage is the only place that sets the tag.
package web

import "io/fs"

// Assets reports that no frontend is embedded in this build.
func Assets() (fs.FS, bool) { return nil, false }
