import { defineConfig } from 'vite'

// A static site: relative asset paths so dist/ works from any host or sub-path.
export default defineConfig({
  base: './',
  server: { port: 5180, strictPort: true },
  preview: { port: 5181, strictPort: true },
  build: {
    target: 'es2022',
    // three.js is most of the bundle; one chunk for it keeps the page script small.
    rollupOptions: { output: { manualChunks: { three: ['three'] } } },
    chunkSizeWarningLimit: 900,
  },
})
