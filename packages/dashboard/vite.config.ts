import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev only: in production the gateway serves dist/ on the same origin.
// The proxy rewrites Host and Origin so the gateway's Host/Origin guards see their own origin.
const target = process.env.VITE_PROXY ?? 'http://gateway.127.0.0.1.nip.io:8080';
const proxy = { target, changeOrigin: true, headers: { origin: new URL(target).origin } };

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': proxy, '/mcp': proxy } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
