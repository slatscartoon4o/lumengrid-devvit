/**
 * Local adapter — the rehearsal stage.
 *
 * Implements the same interface as the Devvit adapter over plain in-memory
 * structures, so the entire game (scoring, streaks, leaderboards, comment
 * sharing, UGC publishing) runs in a normal browser with no Reddit login.  That
 * is what the Playwright showcase drives, and what a judge can run with
 * `npm run preview`.
 *
 * The seeded community numbers are deliberately realistic — a few hundred
 * solves, a bell-shaped Par histogram — so the UI is exercised the way it will
 * look on a live day rather than against an empty chart.
 */

import type {
  FlairResult,
  GameAdapter,
  Player,
  QuickPost,
  SubmittedPost,
} from './adapter';
import { mulberry32, fnv1a } from '../../shared/rng';
import { generateDailyPuzzle } from '../../shared/generator';

type ZSet = Map<string, number>;

function todayKey(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

/** Names that read like real Redditors, so the seeded board does not look fake. */
const HANDLES = [
  'lumenlark', 'prism_pete', 'obsidian_owl', 'beamrider', 'glimmergeek',
  'refraction', 'crystalcat', 'photonpanda', 'mirror_maven', 'wavelength',
  'spectral_sam', 'glowbug', 'optic_otter', 'laserdash', 'brightside',
  'chroma_kid', 'raytrace', 'splitter_sue', 'halcyon_hue', 'quartzqueen',
  'tintinnabulum', 'violet_vibe', 'amber_alex', 'lumen_lee', 'prismatic',
];

export class LocalAdapter implements GameAdapter {
  private readonly store = new Map<string, string>();
  private readonly zsets = new Map<string, ZSet>();
  private readonly comments: Array<{ postId: string; text: string; asUser: boolean }> = [];
  private readonly posts: Array<{ id: string; title: string; url: string }> = [];
  private flair: string | null = null;
  private readonly player: string;
  private readonly localPostId = 't3_local_preview';

  /**
   * @param options.seed  Whether to pre-populate the community.  Tests that
   *   assert *what the player's own submission does to the leaderboard* pass
   *   `false`: against 180–300 seeded players a par score need not crack the
   *   top ten, so the same assertion would pass or fail depending on the day's
   *   random seed — a flaky test with a real signal buried inside it.
   */
  constructor(playerName = 'You', options: { seed?: boolean } = {}) {
    this.player = playerName;
    if (options.seed !== false) this.seedCommunity();
  }

  /**
   * Seed a plausible day of community activity.
   *
   * Two details matter for the preview to look like a real day rather than a
   * mock:
   *
   *   1. Scores are drawn from `[par, par + 3]`.  Nothing below Par is
   *      possible — Par is the *proven* minimum — so a seeded 2 on a Par 3
   *      board would put an impossible run at the top of the leaderboard and
   *      make the whole scoring model look broken to anyone who checks.
   *   2. The `solves:` counter is initialised here.  `GameService` treats that
   *      counter as authoritative for the day's headcount, so leaving it unset
   *      meant the first real submission (`incr` → "1") replaced a few hundred
   *      seeded players with "1 solvers".
   */
  private seedCommunity(): void {
    const date = todayKey();
    const seed = fnv1a(`lumengrid-local:${date}`);
    const rng = mulberry32(seed);
    const board = this.zsets.get(`lb:${date}`) ?? new Map<string, number>();
    this.zsets.set(`lb:${date}`, board);

    const par = generateDailyPuzzle(date).par;
    const count = 180 + rng.int(120);
    for (let i = 0; i < count; i++) {
      const name = `${HANDLES[rng.int(HANDLES.length)] ?? 'player'}${rng.int(900) + 100}`;
      // Bell-ish, but never cheaper than Par: most players land one or two over,
      // a skilled tail hits Par exactly.
      const roll = (rng.next() + rng.next() + rng.next()) / 3;
      const placed = par + Math.round(roll * 3);
      board.set(name, Math.min(par + 3, Math.max(par, placed)));
    }

    this.store.set(`solves:${date}`, String(board.size));
  }

  async currentPlayer(): Promise<Player> {
    return { username: this.player };
  }

  postId(): string | null {
    return this.localPostId;
  }

  isReddit(): boolean {
    return false;
  }

  get kv(): GameAdapter['kv'] {
    return {
      get: async (key: string) => this.store.get(key) ?? null,
      set: async (key: string, value: string) => {
        this.store.set(key, value);
      },
      incr: async (key: string) => {
        const current = Number(this.store.get(key) ?? '0');
        const next = current + 1;
        this.store.set(key, String(next));
        return next;
      },
      zAdd: async (key: string, member: string, score: number) => {
        const set = this.zsets.get(key) ?? new Map<string, number>();
        set.set(member, score);
        this.zsets.set(key, set);
      },
      zRange: async (key: string, start: number, stop: number) => {
        const set = this.zsets.get(key) ?? new Map<string, number>();
        const entries: Array<[string, number]> = [...set.entries()];
        const sorted = entries.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
        const end = stop < 0 ? sorted.length + stop : stop;
        return sorted.slice(start, end + 1).map(([member, score]) => ({ member, score }));
      },
      zCard: async (key: string) => (this.zsets.get(key)?.size ?? 0),
      cleanup: async (prefix: string) => {
        for (const key of [...this.store.keys()]) {
          if (key.startsWith(prefix)) this.store.delete(key);
        }
        for (const key of [...this.zsets.keys()]) {
          if (key.startsWith(prefix)) this.zsets.delete(key);
        }
      },
    };
  }

  get reddit(): GameAdapter['reddit'] {
    return {
      submitComment: async (postId: string, text: string, asUser: boolean) => {
        this.comments.push({ postId, text, asUser });
        return { ok: true, detail: `recorded locally (${text.length} chars)` };
      },
      submitCustomPost: async (title: string, text: string) => {
        const id = `t3_local_${this.posts.length + 1}`;
        this.posts.push({ id, title, url: `#/local-post/${id}` });
        void text;
        return { id, url: `#/local-post/${id}` };
      },
      setUserFlair: async (text: string): Promise<FlairResult> => {
        this.flair = text;
        return { ok: true, detail: text };
      },
      submitDailyPost: async (post: QuickPost): Promise<SubmittedPost | null> => {
        const id = `t3_local_${this.posts.length + 1}`;
        this.posts.push({ id, title: post.title, url: `#/local-post/${id}` });
        return { id, url: `#/local-post/${id}` };
      },
    };
  }

  /** Test/inspection hooks — the showcase script asserts against these. */
  inspect(): {
    comments: Array<{ postId: string; text: string; asUser: boolean }>;
    posts: Array<{ id: string; title: string; url: string }>;
    flair: string | null;
  } {
    return { comments: this.comments, posts: this.posts, flair: this.flair };
  }
}
