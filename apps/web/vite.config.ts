import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.API_PORT ?? 3080}`, changeOrigin: false, xfwd: true } },
  },
  build: { outDir: 'dist', sourcemap: true, assetsInlineLimit: 0 },
});
