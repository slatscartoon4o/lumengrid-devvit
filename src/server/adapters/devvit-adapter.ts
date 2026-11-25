/**
 * Devvit adapter — the real thing.
 *
 * Only this file touches `@devvit/web/server`.  Keeping the imports in one
 * place means the rest of the server can be unit-tested with the local adapter,
 * and a Devvit API change has exactly one place to land.
 */

import { context, redis, reddit } from '@devvit/web/server';
import type { GameAdapter, Player, QuickPost, SubmittedPost, FlairResult } from './adapter';

export function createDevvitAdapter(): GameAdapter {
  return {
    async currentPlayer(): Promise<Player> {
      const username = await reddit.getCurrentUsername();
      return { username: username ?? 'anonymous' };
    },

    postId(): string | null {
      return context.postId ?? null;
    },

    isReddit(): boolean {
      return true;
    },

    kv: {
      async get(key: string): Promise<string | null> {
        const value = await redis.get(key);
        return value ?? null;
      },
      async set(key: string, value: string): Promise<void> {
        await redis.set(key, value);
      },
      async incr(key: string): Promise<number> {
        return redis.incrBy(key, 1);
      },
      async zAdd(key: string, member: string, score: number): Promise<void> {
        await redis.zAdd(key, { member, score });
      },
      async zRange(
        key: string,
        start: number,
        stop: number
      ): Promise<Array<{ member: string; score: number }>> {
        const rows = await redis.zRange(key, start, stop, { by: 'rank' });
        return rows.map((row) => ({ member: row.member, score: row.score }));
      },
      async zCard(key: string): Promise<number> {
        return redis.zCard(key);
      },
      async cleanup(prefix: string): Promise<void> {
        // Devvit's Redis has no SCAN; the daily job uses a well-known key list
        // instead of a prefix sweep, so this is a no-op on Reddit.
        void prefix;
      },
    },

    reddit: {
      async submitComment(postId: string, text: string, asUser: boolean): Promise<{ ok: boolean; detail: string }> {
        try {
          await reddit.submitComment({
            id: postId as `t3_${string}`,
            text,
            runAs: asUser ? 'USER' : 'APP',
          });
          return { ok: true, detail: 'comment posted' };
        } catch (error) {
          return { ok: false, detail: error instanceof Error ? error.message : 'comment failed' };
        }
      },

      async submitCustomPost(title: string, text: string, asUser: boolean): Promise<SubmittedPost | null> {
        try {
          const subreddit = context.subredditName;
          if (!subreddit) return null;
          const post = await reddit.submitCustomPost({
            subredditName: subreddit,
            title,
            entry: 'default',
            textFallback: { text },
            runAs: asUser ? 'USER' : 'APP',
          });
          const id = typeof post?.id === 'string' ? post.id : '';
          const url = id ? `https://reddit.com/comments/${id.replace(/^t3_/, '')}` : '';
          return { id, url };
        } catch {
          return null;
        }
      },

      async setUserFlair(text: string): Promise<FlairResult> {
        try {
          await reddit.setUserFlair({
            text,
            username: (await reddit.getCurrentUsername()) ?? '',
            subredditName: context.subredditName ?? '',
          });
          return { ok: true, detail: text };
        } catch (error) {
          return { ok: false, detail: error instanceof Error ? error.message : 'flair failed' };
        }
      },

      async submitDailyPost(post: QuickPost): Promise<SubmittedPost | null> {
        try {
          const subreddit = context.subredditName;
          if (!subreddit) return null;
          const created = await reddit.submitCustomPost({
            subredditName: subreddit,
            title: post.title,
            entry: 'default',
            textFallback: { text: post.text },
          });
          const id = typeof created?.id === 'string' ? created.id : '';
          return { id, url: id ? `https://reddit.com/comments/${id.replace(/^t3_/, '')}` : '' };
        } catch {
          return null;
        }
      },
    },
  };
}
