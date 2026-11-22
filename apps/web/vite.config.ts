import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: { conditions: ['development'] },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/c/': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks: { react: ['react', 'react-dom'], query: ['@tanstack/react-query'] },
      },
    },
  },
  worker: { format: 'es' },
});
