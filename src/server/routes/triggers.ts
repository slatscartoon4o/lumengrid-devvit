/**
 * Lifecycle triggers and the daily scheduler.
 *
 * `onAppInstall` seeds the subreddit with today's puzzle so the game is playable
 * the moment a moderator installs it.  The scheduler route is what Reddit calls
 * every day to publish the new edition; it is idempotent, so a retry after a
 * timeout cannot double-post.
 */

import { Hono } from 'hono';
import type { GameAdapter } from '../adapters/adapter';
import { generateDailyPuzzle, summarize, todayUtc } from '../../shared/generator';

export function createTriggerRoutes(adapter: GameAdapter): Hono {
  const triggers = new Hono();

  triggers.post('/on-app-install', async (c) => {
    const today = todayUtc();
    const puzzle = generateDailyPuzzle(today);
    const summary = summarize(puzzle);

    // Idempotency guard: if we already posted today's edition, do nothing.
    const guardKey = `posted:${today}`;
    const already = await adapter.kv.get(guardKey);
    if (already) {
      return c.json({ status: 'ok', message: 'today already posted', edition: summary.edition });
    }

    const post = await adapter.reddit.submitDailyPost({
      title: `LumenGrid #${String(summary.edition).padStart(3, '0')} — ${puzzle.theme}`,
      text: `Light every gem in **${puzzle.par}** elements or fewer. New puzzle every day at 00:00 UTC.`,
    });
    if (post) await adapter.kv.set(guardKey, post.id);

    return c.json({
      status: 'ok',
      edition: summary.edition,
      posted: Boolean(post),
    });
  });

  /** The scheduler hits this once a day (see `devvit.json` → `scheduler.tasks`). */
  triggers.post('/daily-puzzle', async (c) => {
    const today = todayUtc();
    const puzzle = generateDailyPuzzle(today);
    const summary = summarize(puzzle);
    const guardKey = `posted:${today}`;
    const already = await adapter.kv.get(guardKey);
    if (already) {
      return c.json({ status: 'ok', message: 'already posted', edition: summary.edition });
    }
    const post = await adapter.reddit.submitDailyPost({
      title: `LumenGrid #${String(summary.edition).padStart(3, '0')} — ${puzzle.theme}`,
      text: `Light every gem in **${puzzle.par}** elements or fewer.`,
    });
    if (post) await adapter.kv.set(guardKey, post.id);
    return c.json({ status: 'ok', edition: summary.edition, posted: Boolean(post) });
  });

  return triggers;
}
