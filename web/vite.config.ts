import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Forwards to `go run ./cmd/kubelynx` during local development.
      '/api': 'http://localhost:8080',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Vitest stubs CSS to '' by default (even `?raw`); App.css.test.ts reads
    // the real stylesheet to guard the shared chip selector groups (#87).
    css: { include: [/\/src\/App\.css\b/] },
    // jsdom + user-event component tests are slow on a loaded CI runner.
    testTimeout: 20000,
  },
})
