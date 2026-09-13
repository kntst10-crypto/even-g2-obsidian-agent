import { defineConfig } from 'vite';
export default defineConfig({
  root: 'client', base: './',
  define: { __RELAY_ORIGIN__: JSON.stringify(process.env.RELAY_ORIGIN || 'https://relay.example.invalid') },
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
});
