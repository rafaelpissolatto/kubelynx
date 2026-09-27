# KubeLynx ships as one image: the Go binary embeds the Vite-built frontend
# (docs/adr/0001-single-image-packaging.md).

# --- Frontend ---
FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- Backend, with the frontend embedded (-tags embedui, see web/embed_none.go) ---
FROM golang:1.26.5-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
COPY web/*.go web/
COPY --from=web /src/web/dist web/dist
RUN CGO_ENABLED=0 go build -trimpath -tags embedui -ldflags="-s -w" -o /out/kubelynx ./cmd/kubelynx

# --- Runtime ---
FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.source="https://github.com/rafaelpissolatto/kubelynx" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.description="Kubernetes workload traffic graph from Beyla network metrics in Prometheus"
COPY --from=build /out/kubelynx /kubelynx
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/kubelynx"]
