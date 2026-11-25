/**
 * Devvit server entry point.
 *
 * This is the only file that knows about `@devvit/web/server`'s Hono host
 * (`serve` / `createServer` / `getServerPort`).  Routes and business logic live
 * elsewhere so the whole app is testable without the Devvit runtime.
 */

import { serve } from '@hono/node-server';
import { createServer, getServerPort } from '@devvit/web/server';
import { Hono } from 'hono';
import { createDevvitAdapter } from './adapters/devvit-adapter';
import { createApiRoutes } from './routes/api';
import { createMenuRoutes } from './routes/menu';
import { createTriggerRoutes } from './routes/triggers';

const adapter = createDevvitAdapter();

const app = new Hono();
const internal = new Hono();

internal.route('/menu', createMenuRoutes(adapter));
internal.route('/triggers', createTriggerRoutes(adapter));

app.route('/api', createApiRoutes(adapter));
app.route('/internal', internal);

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
