import { defineConfig } from 'vite';

export default defineConfig({
  // Chemins relatifs : le build peut être servi depuis n'importe quel dossier.
  base: './',
  server: { port: 5173, open: false },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000, // Phaser pèse ~1,2 Mo : avertissement inutile
  },
});
