/**
 * Build configuration.
 *
 * Two build modes:
 *
 *   `vite build`          — the Devvit bundle.  The official `@devvit/start/vite`
 *                           plugin reads `devvit.json` and emits `dist/client`
 *                           plus `dist/server/index.cjs`, which is exactly what
 *                           `devvit upload` expects.
 *
 *   `vite build --mode preview` — the *same client bundle*, plus a standalone Hono
 *                           server in `dist-local/server` that serves it over the
 *                           in-memory adapter.  This is what the Playwright
 *                           showcase and `npm run preview` use, so the thing
 *                           being recorded is byte-identical to what ships.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { devvit } from '@devvit/start/vite';
import { resolve } from 'node:path';

const CONFIG_DIR = import.meta.dirname;

export default defineConfig(({ mode }) => {
  const local = mode === 'preview';

  if (local) {
    return {
      plugins: [react(), tailwind()],
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      // `root` is the client directory so the emitted HTML lands flat in
      // `dist-local/client/` — the local server serves that folder as its web
      // root, and a nested `src/client/` prefix would break every relative
      // asset path.
      root: resolve(CONFIG_DIR, 'src/client'),
      publicDir: false,
      build: {
        outDir: resolve(CONFIG_DIR, 'dist-local/client'),
        emptyOutDir: true,
        assetsDir: 'assets',
        rollupOptions: {
          input: {
            splash: resolve(CONFIG_DIR, 'src/client/splash.html'),
            game: resolve(CONFIG_DIR, 'src/client/game.html'),
          },
        },
      },
    };
  }

  return {
    plugins: [react(), tailwind(), devvit({ logLevel: 'warn' })],
  };
});
