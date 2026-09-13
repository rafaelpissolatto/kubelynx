import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Forwards to `go run ./cmd/kubelynx` during local development.
      '/api': 'http://localhost:8080',
    },
  },
})
