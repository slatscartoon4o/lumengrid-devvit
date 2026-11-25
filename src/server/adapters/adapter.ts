/**
 * The storage + Reddit surface the game needs, expressed as one interface.
 *
 * There are two implementations: `devvit-adapter` (real `@devvit/web/server`:
 * Redis, the Reddit API, the post context) and `local-adapter` (in-memory Redis
 * and a simulated subreddit, so the whole game can be played and recorded
 * without a Reddit login).
 *
 * Everything above this line — routes, scoring, streaks, leaderboards — is
 * written once and runs unchanged in both worlds, which is what makes the local
 * Playwright run an honest rehearsal of production.
 */

export type Player = {
  readonly username: string;
};

export type QuickPost = {
  readonly title: string;
  readonly text: string;
};

export type SubmittedPost = {
  readonly id: string;
  readonly url: string;
};

export type FlairResult = {
  readonly ok: boolean;
  readonly detail: string;
};

export type GameAdapter = {
  /** The current player, if we can identify them. */
  currentPlayer(): Promise<Player>;
  /** The post this app view is attached to, if any. */
  postId(): string | null;
  /** True when running under Devvit (vs. the local preview server). */
  isReddit(): boolean;

  /** Redis-style string storage, namespaced by the adapter. */
  kv: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    incr(key: string): Promise<number>;
    /** Sorted-set style leaderboard: score is the element count, low wins. */
    zAdd(key: string, member: string, score: number): Promise<void>;
    zRange(key: string, start: number, stop: number): Promise<Array<{ member: string; score: number }>>;
    zCard(key: string): Promise<number>;
    /** Delete every key matching a prefix (used when the day rolls over). */
    cleanup(prefix: string): Promise<void>;
  };

  /** Reddit surfacing: comments, custom posts, flair.  All best-effort. */
  reddit: {
    submitComment(postId: string, text: string, asUser: boolean): Promise<{ ok: boolean; detail: string }>;
    submitCustomPost(title: string, text: string, asUser: boolean): Promise<SubmittedPost | null>;
    setUserFlair(text: string): Promise<FlairResult>;
    /** Post a plain "today's level" post; used by the daily job. */
    submitDailyPost(post: QuickPost): Promise<SubmittedPost | null>;
  };
};

/** Raised by adapters when the operation is not available in this environment. */
export class AdapterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterUnavailableError';
  }
}
