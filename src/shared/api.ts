/**
 * The wire contract between the Devvit server (or the local preview server) and
 * the React client.  Both sides import these types so a change to the API breaks
 * the build rather than the game.
 */

import type { Puzzle, PuzzleSummary } from './types';
import type { ParBadge } from './share';

export type ErrorResponse = {
  readonly status: 'error';
  readonly message: string;
};

export type Profile = {
  readonly username: string;
  readonly streak: number;
  readonly bestStreak: number;
  readonly totalSolved: number;
  /** Elements used on each recent day, most recent first. */
  readonly recent: ReadonlyArray<{ readonly date: string; readonly placed: number; readonly par: number }>;
  readonly hasPlayedToday: boolean;
};

export type CommunityStats = {
  /** Today's total solves. */
  readonly solves: number;
  /** Index = element count, value = number of players.  Length is `par + 4`. */
  readonly histogram: ReadonlyArray<number>;
  /** Percentile of a player who used `index` elements. */
  readonly playerPercentile: number;
  /** Top players today, best first. */
  readonly top: ReadonlyArray<{ readonly username: string; readonly placed: number; readonly seconds: number }>;
};

export type InitResponse = {
  readonly status: 'ok';
  readonly today: string;
  readonly puzzle: Puzzle;
  readonly summary: PuzzleSummary;
  readonly profile: Profile;
  readonly community: CommunityStats;
  /** True when running under the local preview server rather than Reddit. */
  readonly localMode: boolean;
  /** Short list of past puzzles the player may replay (most recent first). */
  readonly archive: ReadonlyArray<PuzzleSummary>;
  /** Feature switches the server decides (e.g. UGC enabled in this sub). */
  readonly features: { readonly ugc: boolean; readonly flair: boolean };
};

export type PuzzleResponse = {
  readonly status: 'ok';
  readonly puzzle: Puzzle;
  readonly summary: PuzzleSummary;
};

export type SubmitRequest = {
  readonly date: string;
  /** 64 placement codes, row-major. Sent so the server can re-run the engine. */
  readonly placements: ReadonlyArray<number>;
  readonly seconds: number;
};

export type SubmitResponse = {
  readonly status: 'ok';
  readonly accepted: boolean;
  readonly solved: boolean;
  readonly placed: number;
  readonly par: number;
  readonly badge: ParBadge;
  readonly streak: number;
  readonly bestStreak: number;
  readonly percentile: number;
  readonly histogram: ReadonlyArray<number>;
  readonly solves: number;
  /**
   * The day's top solvers *after* this submission, so the client can show the
   * player their new standing without a round trip or a reload.
   *
   * The client must not sort this itself: the ordering and the tie-breaking
   * live in the server's sorted set, and a browser-side re-sort would be a
   * second implementation of the same rule, free to drift.
   */
  readonly top: ReadonlyArray<{ readonly username: string; readonly placed: number; readonly seconds: number }>;
  readonly reason?: string;
};

export type ShareCommentRequest = {
  readonly date: string;
  readonly placed: number;
  readonly par: number;
  readonly seconds: number;
};

export type ShareCommentResponse = {
  readonly status: 'ok';
  readonly posted: boolean;
  /** The exact text that was (or would have been) posted. */
  readonly text: string;
  readonly message: string;
};

export type HintRequest = {
  readonly date: string;
  readonly placements: ReadonlyArray<number>;
};

export type HintResponse = {
  readonly status: 'ok';
  readonly found: boolean;
  /** Cell index of the next element the player should place. */
  readonly cellIndex: number | null;
  /** Placement code to put there. */
  readonly code: number | null;
  /** How many elements the remaining solution needs. */
  readonly remaining: number;
  readonly message: string;
};

export type UgcVerifyRequest = {
  readonly cells: ReadonlyArray<number>;
  readonly mounts: ReadonlyArray<number>;
  readonly title: string;
};

export type UgcVerifyResponse = {
  readonly status: 'ok';
  readonly valid: boolean;
  readonly par: number;
  readonly solvable: boolean;
  readonly crystals: number;
  readonly reason: string;
};

export type UgcPublishRequest = {
  readonly cells: ReadonlyArray<number>;
  readonly mounts: ReadonlyArray<number>;
  readonly title: string;
};

export type UgcPublishResponse = {
  readonly status: 'ok';
  readonly published: boolean;
  readonly id: string;
  readonly message: string;
  /** Deep link to the new post, when running on Reddit. */
  readonly url: string;
};

export type LeaderboardResponse = {
  readonly status: 'ok';
  readonly date: string;
  readonly community: CommunityStats;
  readonly profile: Profile;
};
