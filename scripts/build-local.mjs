/**
 * Bundle the local preview server.
 *
 * The Devvit build bundles `src/server/index.ts` into `dist/server/index.cjs`
 * for Reddit's runtime.  The local preview needs the *other* entry point
 * (`local-server.ts`) bundled the same way, into `dist-local/server`, so
 * `node dist-local/server/local-server.cjs` runs with no toolchain.
 *
 * Bundling rather than running through `tsx` keeps the preview honest: what
 * Playwright drives is a real production build, not a dev-mode transpile.
 */

import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist-local/server', { recursive: true, force: true });

await build({
  entryPoints: ['src/server/local-server.ts'],
  outfile: 'dist-local/server/local-server.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  minify: false,
  // Everything that lives in node_modules is external: the local server runs on
  // the same machine that installed them, so bundling them would only bloat the
  // artefact and complicate debugging.
  packages: 'external',
  logLevel: 'info',
});

console.log('local preview server bundled → dist-local/server/local-server.cjs');
