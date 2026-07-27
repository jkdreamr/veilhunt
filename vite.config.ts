import { defineConfig } from 'vite';

const SERVER_PORT = Number(process.env.VEIL_SERVER_PORT ?? 8787);

export default defineConfig(({ mode }) => ({
  root: '.',
  publicDir: 'public',
  build: {
    // The e2e build enables `window.__VEIL_HUNT_TEST__`, so it must never land
    // in dist/client — otherwise running the test suite would leave a
    // hook-enabled bundle behind for the next `npm run start` to serve.
    outDir: mode === 'e2e' ? 'dist/e2e-client' : 'dist/client',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5188,
    strictPort: false,
    proxy: {
      '/socket.io': {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        ws: true,
        changeOrigin: false,
      },
      '/health': `http://127.0.0.1:${SERVER_PORT}`,
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5189,
  },
}));
