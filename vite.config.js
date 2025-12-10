import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3131',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:3131',
        ws: true
      },
      '/test': {
        target: 'http://localhost:3131',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist'
  }
});


