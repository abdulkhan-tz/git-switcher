import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `pnpm dev` expects `gsw ui --port 4321 --no-open` running for the API.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:4321' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
