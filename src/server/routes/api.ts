/**
 * HTTP routes.
 *
 * Thin by design: every handler validates the request shape, delegates to
 * `GameService`, and returns JSON.  A factory because the service is injected —
 * the Devvit entry point passes the real adapter, the local preview server
 * passes the in-memory one.
 */

import { Hono } from 'hono';
import type { GameAdapter } from '../adapters/adapter';
import { GameService } from '../game-service';
import { isValidDateString } from '../../shared/generator';
import type { ErrorResponse } from '../../shared/api';

type JsonBody = Record<string, unknown>;

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<JsonBody | null> {
  try {
    const body = await c.req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as JsonBody;
    return null;
  } catch {
    return null;
  }
}

function numberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null;
    out.push(item);
  }
  return out;
}

function str(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function createApiRoutes(adapter: GameAdapter): Hono {
  const api = new Hono();
  const service = new GameService(adapter);

  api.get('/init', async (c) => {
    try {
      return c.json(await service.init());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'init failed';
      return c.json<ErrorResponse>({ status: 'error', message }, 500);
    }
  });

  api.get('/puzzle/:date', async (c) => {
    const date = c.req.param('date');
    if (!isValidDateString(date)) {
      return c.json<ErrorResponse>({ status: 'error', message: 'date must be YYYY-MM-DD' }, 400);
    }
    const puzzle = await service.puzzle(date);
    if (!puzzle) {
      return c.json<ErrorResponse>(
        { status: 'error', message: 'that puzzle is not available yet' },
        404
      );
    }
    return c.json({
      status: 'ok' as const,
      puzzle,
      summary: {
        id: puzzle.id,
        dayIndex: puzzle.dayIndex,
        theme: puzzle.theme,
        par: puzzle.par,
        edition: 0,
      },
    });
  });

  api.post('/submit', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json<ErrorResponse>({ status: 'error', message: 'invalid JSON body' }, 400);
    const date = str(body.date, 10);
    if (!isValidDateString(date)) {
      return c.json<ErrorResponse>({ status: 'error', message: 'bad date' }, 400);
    }
    const placements = numberArray(body.placements);
    if (!placements) {
      return c.json<ErrorResponse>({ status: 'error', message: 'placements must be a number array' }, 400);
    }
    const seconds = typeof body.seconds === 'number' && Number.isFinite(body.seconds) ? body.seconds : 0;
    const result = await service.submit(date, placements, Math.max(0, Math.min(86400, seconds)));
    return c.json(result);
  });

  api.get('/leaderboard/:date', async (c) => {
    const date = c.req.param('date');
    if (!isValidDateString(date)) {
      return c.json<ErrorResponse>({ status: 'error', message: 'bad date' }, 400);
    }
    const community = await service.leaderboard(date);
    const player = await adapter.currentPlayer();
    const profile = await service.profileFor(player.username, date);
    return c.json({ status: 'ok' as const, date, community, profile });
  });

  api.post('/share-comment', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json<ErrorResponse>({ status: 'error', message: 'invalid JSON body' }, 400);
    const date = str(body.date, 10);
    if (!isValidDateString(date)) {
      return c.json<ErrorResponse>({ status: 'error', message: 'bad date' }, 400);
    }
    const placed = typeof body.placed === 'number' ? Math.round(body.placed) : 0;
    const seconds = typeof body.seconds === 'number' ? Math.round(body.seconds) : 0;
    const result = await service.shareComment(date, placed, seconds);
    return c.json({ status: 'ok' as const, ...result });
  });

  api.post('/hint', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json<ErrorResponse>({ status: 'error', message: 'invalid JSON body' }, 400);
    const date = str(body.date, 10);
    const placements = numberArray(body.placements) ?? [];
    const result = await service.hint(date, placements);
    return c.json({ status: 'ok' as const, ...result });
  });

  api.post('/ugc/verify', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json<ErrorResponse>({ status: 'error', message: 'invalid JSON body' }, 400);
    const cells = numberArray(body.cells);
    const mounts = numberArray(body.mounts);
    if (!cells || !mounts) {
      return c.json<ErrorResponse>({ status: 'error', message: 'cells and mounts are required' }, 400);
    }
    return c.json(service.verifyUgc(cells, mounts));
  });

  api.post('/ugc/publish', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json<ErrorResponse>({ status: 'error', message: 'invalid JSON body' }, 400);
    const cells = numberArray(body.cells);
    const mounts = numberArray(body.mounts);
    if (!cells || !mounts) {
      return c.json<ErrorResponse>({ status: 'error', message: 'cells and mounts are required' }, 400);
    }
    const title = str(body.title, 80) || 'Untitled optical circuit';
    const result = await service.publishUgc(title, cells, mounts);
    return c.json({ status: 'ok' as const, ...result });
  });

  return api;
}
