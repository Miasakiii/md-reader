import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      external: [
        /^@tauri-apps\/api\/.*$/,
        /^@tauri-apps\/plugin-.*$/,
      ],
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
