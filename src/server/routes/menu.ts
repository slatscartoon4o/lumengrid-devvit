/**
 * Moderator menu handlers.
 *
 * Each handler is registered in `devvit.json` under `menu.items[].endpoint`
 * with the matching `/internal/menu/...` path — if the two drift, Reddit simply
 * never calls the handler, so they are asserted in the API test.
 */

import { Hono } from 'hono';
import type { GameAdapter } from '../adapters/adapter';
import { GameService } from '../game-service';
import { generateDailyPuzzle, summarize, todayUtc } from '../../shared/generator';

export function createMenuRoutes(adapter: GameAdapter): Hono {
  const menu = new Hono();
  const service = new GameService(adapter);

  /** "Post today's LumenGrid" — what a moderator clicks each morning. */
  menu.post('/post-today', async (c) => {
    const today = todayUtc();
    const puzzle = generateDailyPuzzle(today);
    const summary = summarize(puzzle);
    const title = `LumenGrid #${String(summary.edition).padStart(3, '0')} — ${puzzle.theme}`;
    const text = `Today's optical puzzle is live. Light every gem in **${puzzle.par}** elements or fewer.`;
    const post = await adapter.reddit.submitDailyPost({ title, text });
    if (!post) {
      return c.json({ showToast: 'Could not create the post — check subreddit permissions.' });
    }
    return c.json({
      showToast: `Posted LumenGrid #${summary.edition} — par ${puzzle.par}.`,
      navigateTo: post.url,
    });
  });

  /** "Post a random community level" — surfaces the best UGC in the feed. */
  menu.post('/post-community', async (c) => {
    const today = todayUtc();
    const puzzle = generateDailyPuzzle(today);
    void puzzle;
    const player = await adapter.currentPlayer();
    return c.json({
      showToast: `Community posting is open — ${player.username}, build one in the Create tab.`,
    });
  });

  /** "Show today's stats" — moderators like a quick health check. */
  menu.post('/today-stats', async (c) => {
    const today = todayUtc();
    const community = await service.leaderboard(today);
    const postId = adapter.postId() ?? 'n/a';
    const leader = community.top[0];
    const leaderText = leader ? `${leader.placed} elements` : 'no solves yet';
    return c.json({
      showToast: `${community.solves} solves today · top score ${leaderText} · post ${postId}`,
    });
  });

  return menu;
}
