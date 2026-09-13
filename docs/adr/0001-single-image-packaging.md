# Single container image, backend embeds the frontend

KubeLynx ships as one container image: the Go backend serves its own API and the Vite-built React frontend, embedded into the binary via Go's `embed` package. We considered the more common split of a separate frontend (nginx-served) and backend API image, but rejected it — this is a single-purpose, single-replica visualization tool, not a system that needs independent scaling or release cadences for its UI versus its API. One image keeps the Helm chart to a single Deployment and halves the ops surface, matching the "lightweight" goal.
