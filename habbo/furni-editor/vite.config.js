// Furni editor: npx vite -c habbo/furni-editor/vite.config.js (dev), npx vite build -c habbo/furni-editor/vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  plugins: [react()],
  server: {
    port: 8097,
    host: '127.0.0.1',
    fs: { allow: [path.resolve(here, '../..')] },
    // The hotel's furni definitions (part colours, names) from the CMS API, same-origin (it sends no CORS header).
    // HOTEL_SITE=http://localhost:5080 for a local CMS.
    proxy: {
      '/hotel-api': {
        target: process.env.HOTEL_SITE ?? 'https://habbo-danmark.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/hotel-api/, '/api/hotel'),
      },
    },
  },
  build: { outDir: path.resolve(here, 'dist'), emptyOutDir: true, target: 'es2020' },
});
