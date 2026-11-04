import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist-renderer'),
    emptyOutDir: true,
    // Don't minify in dev; minify for production
    minify: process.env.NODE_ENV === 'production' ? 'esbuild' : false,
    // A desktop app loads its bundle from disk, so one large chunk is fine.
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/renderer/index.html')
    }
  },
  server: {
    // Dev server for hot reload during development
    port: 5173,
    strictPort: true
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer')
    }
  }
});
