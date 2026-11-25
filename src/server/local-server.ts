/**
 * Local preview server.
 *
 * Serves the built client out of `dist-local/client` and the same API the Devvit
 * runtime serves, backed by the in-memory adapter.  This is what the Playwright
 * showcase drives and what a judge can run with `npm run preview`.
 *
 * Port 41731 is deliberately unusual: the project conventions forbid 80/8000/
 * 8080/3001 and friends, and 41731 is unlikely to collide with anything else on
 * a reviewer's machine.
 */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LocalAdapter } from './adapters/local-adapter';
import { createApiRoutes } from './routes/api';
import { createMenuRoutes } from './routes/menu';
import { createTriggerRoutes } from './routes/triggers';

const PORT = Number(process.env.LUMENGRID_PORT ?? 41731);

// The bundle is CommonJS, where `import.meta.url` is unavailable — resolve the
// client folder from the working directory instead, which is the project root
// both for `npm run preview` and for the showcase script.
const clientDir = resolve(process.cwd(), 'dist-local', 'client');
if (!existsSync(clientDir)) {
  console.error(`[lumengrid] client bundle missing at ${clientDir}. Run: npm run build:preview`);
  process.exit(1);
}

const adapter = new LocalAdapter(process.env.LUMENGRID_PLAYER ?? 'You');
const app = new Hono();

app.route('/api', createApiRoutes(adapter));
app.route('/internal/menu', createMenuRoutes(adapter));
app.route('/internal/triggers', createTriggerRoutes(adapter));

// Health probe used by the showcase script to know when to start driving.
app.get('/healthz', (c) => c.json({ status: 'ok', mode: 'local', port: PORT }));

app.use('/*', serveStatic({ root: clientDir }));

app.get('/*', (c) => {
  // Any unknown path falls back to the splash page so deep links keep working.
  return c.redirect('/splash.html');
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[lumengrid] local preview ready on http://127.0.0.1:${info.port}`);
  console.log(`[lumengrid] splash: http://127.0.0.1:${info.port}/splash.html`);
  console.log(`[lumengrid] game:   http://127.0.0.1:${info.port}/game.html`);
});
