/**
 * Game service — every rule that matters, independent of where it runs.
 *
 * The routes are thin: they validate shapes, call into this service, and turn
 * the result into JSON.  All the scoring, streak, leaderboard and anti-cheat
 * logic lives here so it is directly unit-testable and identical on Devvit and
 * in the local preview.
 */

import {
  CELL_COUNT,
  PLACE_MIRROR_SLASH,
  PLACE_NONE,
  PLACE_SPLIT_BACK,
  PLACE_SPLIT_SLASH,
  Puzzle,
  cellKind,
  KIND_CRYSTAL,
} from '../shared/types';
import { trace } from '../shared/optics';
import { solvePar } from '../shared/solver';
import {
  editionForDate,
  generateDailyPuzzle,
  isInSeason,
  isValidDateString,
  shiftDate,
  todayUtc,
  summarize,
} from '../shared/generator';
import { parBadge, percentileFromHistogram, type ParBadge } from '../shared/share';
import type {
  CommunityStats,
  InitResponse,
  Profile,
  SubmitResponse,
  UgcVerifyResponse,
} from '../shared/api';
import type { GameAdapter } from './adapters/adapter';
import { buildShareCard } from '../shared/share';

const ARCHIVE_DAYS = 7;
const TOP_N = 10;

const KEY = {
  solved: (date: string, user: string) => `solved:${date}:${user}`,
  result: (date: string, user: string) => `result:${date}:${user}`,
  streak: (user: string) => `streak:${user}`,
  best: (user: string) => `best:${user}`,
  total: (user: string) => `total:${user}`,
  leaderboard: (date: string) => `lb:${date}`,
  solves: (date: string) => `solves:${date}`,
  dayIndex: (date: string) => `hist:${date}`,
  lastPlayed: (user: string) => `lastPlayed:${user}`,
  ugc: (id: string) => `ugc:${id}`,
  ugcIndex: `ugc:index`,
};

export type PlacementValidation =
  | { readonly ok: true; readonly placements: Uint8Array; readonly placed: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate a client's placement array.  The client sends 64 codes; every code
 * must be a known element and must sit on a declared socket.  This is the
 * server-side half of anti-cheat: we never trust the client's claim that the
 * board is solved, we re-run the engine.
 */
export function validatePlacements(
  puzzle: Puzzle,
  raw: ReadonlyArray<number>
): PlacementValidation {
  if (raw.length !== CELL_COUNT) {
    return { ok: false, reason: `expected ${CELL_COUNT} cells, got ${raw.length}` };
  }
  const sockets = new Set<number>(puzzle.mounts);
  const placements = new Uint8Array(CELL_COUNT);
  let placed = 0;
  for (let i = 0; i < CELL_COUNT; i++) {
    const code = raw[i] ?? 0;
    if (!Number.isInteger(code) || code < PLACE_NONE || code > PLACE_SPLIT_BACK) {
      return { ok: false, reason: `bad placement code ${String(code)} at ${i}` };
    }
    if (code === PLACE_NONE) continue;
    if (!sockets.has(i)) {
      return { ok: false, reason: `element placed outside the build zone at ${i}` };
    }
    if (cellKind(puzzle.cells[i] ?? 0) !== 0) {
      // Filters are transparent but not buildable; crystals/emitters/walls are
      // furniture.  Nothing may stack.
      return { ok: false, reason: `element stacked on furniture at ${i}` };
    }
    placements[i] = code;
    placed++;
  }
  return { ok: true, placements, placed };
}

export type SubmitOutcome = SubmitResponse;

export class GameService {
  constructor(private readonly adapter: GameAdapter) {}

  private get kv(): GameAdapter['kv'] {
    return this.adapter.kv;
  }

  async init(): Promise<InitResponse> {
    const today = todayUtc();
    const puzzle = generateDailyPuzzle(today);
    const player = await this.adapter.currentPlayer();
    const [profile, community] = await Promise.all([
      this.profileFor(player.username, today),
      this.communityFor(today, puzzle.par, 0),
    ]);
    return {
      status: 'ok',
      today,
      puzzle,
      summary: summarize(puzzle),
      profile,
      community,
      localMode: !this.adapter.isReddit(),
      archive: this.archive(today),
      features: { ugc: true, flair: this.adapter.isReddit() },
    };
  }

  archive(today: string): InitResponse['archive'] {
    const out: Array<InitResponse['archive'][number]> = [];
    for (let back = 1; back <= ARCHIVE_DAYS; back++) {
      const date = shiftDate(today, -back);
      if (!isInSeason(date)) break;
      out.push(summarize(generateDailyPuzzle(date)));
    }
    return out;
  }

  async puzzle(date: string): Promise<Puzzle | null> {
    if (!isValidDateString(date)) return null;
    const today = todayUtc();
    // Anything in the season, plus a small look-ahead so preview builds work
    // on the day before the season opens.
    if (!isInSeason(date) && date !== today) return null;
    // Refuse to serve the future: a daily game must not leak tomorrow's board.
    if (date > today) return null;
    return generateDailyPuzzle(date);
  }

  async profileFor(username: string, today: string): Promise<Profile> {
    const [streakRaw, bestRaw, totalRaw, lastPlayed, todayResult] = await Promise.all([
      this.kv.get(KEY.streak(username)),
      this.kv.get(KEY.best(username)),
      this.kv.get(KEY.total(username)),
      this.kv.get(KEY.lastPlayed(username)),
      this.kv.get(KEY.result(today, username)),
    ]);
    const recent: Array<{ date: string; placed: number; par: number }> = [];
    for (let back = 0; back < 5; back++) {
      const date = shiftDate(today, -back);
      const raw = await this.kv.get(KEY.result(date, username));
      if (!raw) continue;
      const parsed = safeParse(raw);
      if (parsed && typeof parsed.placed === 'number' && typeof parsed.par === 'number') {
        recent.push({ date, placed: parsed.placed, par: parsed.par });
      }
    }
    return {
      username,
      streak: Number(streakRaw ?? '0') || 0,
      bestStreak: Number(bestRaw ?? '0') || 0,
      totalSolved: Number(totalRaw ?? '0') || 0,
      recent,
      hasPlayedToday: Boolean(todayResult) || lastPlayed === today,
    };
  }

  async communityFor(date: string, par: number, yourValue: number): Promise<CommunityStats> {
    const [solvesRaw, top] = await Promise.all([
      this.kv.get(KEY.solves(date)),
      this.kv.zRange(KEY.leaderboard(date), 0, TOP_N - 1),
    ]);
    const histogram = await this.histogramFor(date, par);
    const solves = Math.max(Number(solvesRaw ?? '0') || 0, histogram.reduce((sum, n) => sum + n, 0));
    return {
      solves,
      histogram,
      playerPercentile: yourValue > 0 ? percentileFromHistogram(histogram, yourValue) : 100,
      top: top.map((row) => ({
        username: row.member,
        placed: row.score,
        seconds: 0,
      })),
    };
  }

  /**
   * The histogram is *derived* from the leaderboard's scores rather than kept as
   * a separate counter, so it can never drift out of step with the board (a
   * separate counter would have to be updated on every write and rolled back on
   * every failure).
   */
  async histogramFor(date: string, par: number): Promise<number[]> {
    const buckets = par + 5;
    const histogram = new Array<number>(buckets).fill(0);
    const rows = await this.kv.zRange(KEY.leaderboard(date), 0, -1);
    for (const row of rows) {
      const index = Math.max(0, Math.min(buckets - 1, Math.round(row.score)));
      histogram[index] = (histogram[index] ?? 0) + 1;
    }
    return histogram;
  }

  async submit(
    date: string,
    rawPlacements: ReadonlyArray<number>,
    seconds: number
  ): Promise<SubmitOutcome | { status: 'error'; message: string }> {
    const puzzle = await this.puzzle(date);
    if (!puzzle) return { status: 'error', message: 'unknown or unavailable puzzle date' };

    const validation = validatePlacements(puzzle, rawPlacements);
    if (!validation.ok) {
      return {
        status: 'ok',
        accepted: false,
        solved: false,
        placed: 0,
        par: puzzle.par,
        badge: 'over',
        streak: 0,
        bestStreak: 0,
        percentile: 0,
        histogram: await this.histogramFor(date, puzzle.par),
        solves: 0,
        reason: validation.reason,
      };
    }

    const traceResult = trace(puzzle.cells, validation.placements);
    if (!traceResult.solved) {
      return {
        status: 'ok',
        accepted: true,
        solved: false,
        placed: validation.placed,
        par: puzzle.par,
        badge: 'over',
        streak: 0,
        bestStreak: 0,
        percentile: 0,
        histogram: await this.histogramFor(date, puzzle.par),
        solves: 0,
        reason: 'not all crystals lit',
      };
    }

    const player = await this.adapter.currentPlayer();
    const username = player.username;

    // Record the run.  A *first* solve of the day drives the streak and the
    // leaderboard; replaying a solved day can improve the score but never
    // double-counts, so farming is pointless.
    const alreadySolved = await this.kv.get(KEY.solved(date, username));
    const isFirstToday = !alreadySolved;

    await this.kv.set(
      KEY.result(date, username),
      JSON.stringify({ placed: validation.placed, par: puzzle.par, seconds, at: Date.now() })
    );
    await this.kv.set(KEY.solved(date, username), '1');
    await this.kv.set(KEY.lastPlayed(username), date);

    // Leaderboard: keep the player's *best* element count for the day.
    const boardKey = KEY.leaderboard(date);
    const existing = await this.kv.zRange(boardKey, 0, -1);
    const mine = existing.find((row) => row.member === username);
    if (!mine || validation.placed < mine.score) {
      await this.kv.zAdd(boardKey, username, validation.placed);
    }

    if (isFirstToday) {
      await this.kv.incr(KEY.solves(date));
      await this.kv.incr(KEY.total(username));
    }

    // --- streak ----------------------------------------------------------
    const yesterday = shiftDate(date, -1);
    const [streakRaw, bestRaw, playedYesterday] = await Promise.all([
      this.kv.get(KEY.streak(username)),
      this.kv.get(KEY.best(username)),
      this.kv.get(KEY.solved(yesterday, username)),
    ]);
    let streak = Number(streakRaw ?? '0') || 0;
    if (isFirstToday) {
      // Streak only advances on the first solve of a given day, and only when
      // the previous day was also solved (or this is the very first solve).
      streak = playedYesterday ? streak + 1 : 1;
      const best = Math.max(Number(bestRaw ?? '0') || 0, streak);
      await this.kv.set(KEY.streak(username), String(streak));
      await this.kv.set(KEY.best(username), String(best));
    }
    const bestStreak = Math.max(Number(bestRaw ?? '0') || 0, streak);

    const histogram = await this.histogramFor(date, puzzle.par);
    const solvesRaw = await this.kv.get(KEY.solves(date));
    // Never report fewer solvers than the histogram actually contains: the
    // counter and the sorted set are written separately, so a partially seeded
    // or partially expired day could otherwise claim "1 solver" above a chart
    // showing hundreds.
    const solves = Math.max(Number(solvesRaw ?? '0') || 0, histogram.reduce((sum, n) => sum + n, 0));

    const badge: ParBadge = parBadge(validation.placed, puzzle.par);

    // Grant the streak flair.  Awaited, because `awardFlair` catches its own
    // failures — so this cannot reject, and a Reddit API hiccup can never turn
    // a legitimate solve into an error.
    await this.awardFlair(streak, badge);

    return {
      status: 'ok',
      accepted: true,
      solved: true,
      placed: validation.placed,
      par: puzzle.par,
      badge,
      streak,
      bestStreak,
      percentile: percentileFromHistogram(histogram, validation.placed),
      histogram,
      solves,
    };
  }

  async leaderboard(date: string): Promise<CommunityStats> {
    const puzzle = await this.puzzle(date);
    const par = puzzle?.par ?? 4;
    return this.communityFor(date, par, 0);
  }

  /**
   * A single-step hint: re-solve the *remaining* problem from where the player
   * is, and name one element of that solution.  Because it re-solves rather
   * than replaying a stored answer, hints stay useful even after the player has
   * built something the author never imagined.
   */
  async hint(
    date: string,
    rawPlacements: ReadonlyArray<number>
  ): Promise<{ found: boolean; cellIndex: number | null; code: number | null; remaining: number; message: string }> {
    const puzzle = await this.puzzle(date);
    if (!puzzle) return { found: false, cellIndex: null, code: null, remaining: 0, message: 'unknown puzzle' };

    const validation = validatePlacements(puzzle, rawPlacements);
    if (!validation.ok) {
      return { found: false, cellIndex: null, code: null, remaining: 0, message: validation.reason };
    }

    const usedSockets = new Set<number>();
    for (let i = 0; i < CELL_COUNT; i++) if (validation.placements[i]) usedSockets.add(i);
    const freeSockets = puzzle.mounts.filter((cell) => !usedSockets.has(cell));

    // Already lit: say so rather than reporting a routing failure.
    if (trace(puzzle.cells, validation.placements).solved) {
      return { found: false, cellIndex: null, code: null, remaining: 0, message: 'every crystal is already lit' };
    }

    if (freeSockets.length === 0) {
      return { found: false, cellIndex: null, code: null, remaining: 0, message: 'no sockets left — undo something' };
    }

    // Solve the rest of the board around what the player already placed.
    // `pinned` keeps their elements fixed and payable, so the returned step
    // always *extends* their work instead of replaying a canned opening.
    const result = solvePar(
      puzzle.cells,
      Math.min(freeSockets.length, 6),
      {
        allowCells: freeSockets,
        inventory: { mirrors: 6, splitters: 6 },
        pinned: validation.placements,
        deadlineMs: 900,
        maxNodes: 400_000,
      }
    );
    if (!result.solvable || result.solution.length === 0) {
      return {
        found: false,
        cellIndex: null,
        code: null,
        remaining: 0,
        message: 'current elements block every route — try undoing one',
      };
    }

    const step = result.solution[0];
    if (!step) {
      return { found: false, cellIndex: null, code: null, remaining: 0, message: 'no step' };
    }
    const kind = step.code === PLACE_SPLIT_BACK || step.code === PLACE_SPLIT_SLASH ? 'splitter' : 'mirror';
    const orient = step.code === PLACE_MIRROR_SLASH || step.code === PLACE_SPLIT_SLASH ? '/' : '\\';
    const x = step.cellIndex % 8;
    const y = Math.floor(step.cellIndex / 8);
    return {
      found: true,
      cellIndex: step.cellIndex,
      code: step.code,
      remaining: result.solution.length,
      message: `Try a ${kind} ${orient} at (${x + 1}, ${y + 1})`,
    };
  }

  /** Validate a community-designed level. */
  verifyUgc(
    cells: ArrayLike<number>,
    mounts: ReadonlyArray<number>
  ): UgcVerifyResponse {
    const fail = (reason: string): UgcVerifyResponse => ({
      status: 'ok',
      valid: false,
      par: 0,
      solvable: false,
      crystals: 0,
      reason,
    });

    if (cells.length !== CELL_COUNT) return fail(`board must be ${CELL_COUNT} cells`);
    if (mounts.length < 2) return fail('place at least two optical sockets');
    if (mounts.length > 12) return fail('twelve sockets is the maximum');

    const board = Array.from(cells);
    let crystals = 0;
    let emitters = 0;
    let walls = 0;
    for (let i = 0; i < CELL_COUNT; i++) {
      const code = board[i] ?? 0;
      if (!Number.isInteger(code) || code < 0) return fail('corrupt cell');
      const kind = cellKind(code);
      if (kind === KIND_CRYSTAL) crystals++;
      if (kind === 2) emitters++;
      if (kind === 1) walls++;
    }
    if (emitters === 0) return fail('a level needs at least one emitter');
    if (crystals === 0) return fail('a level needs at least one crystal');

    const socketSet = new Set<number>();
    for (const cell of mounts) {
      if (!Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT) return fail('socket out of range');
      if (socketSet.has(cell)) return fail('duplicate socket');
      socketSet.add(cell);
      if (board[cell] !== 0) return fail('a socket must be on an empty cell');
    }

    // Never allow a level that solves itself.
    if (trace(board, new Uint8Array(CELL_COUNT)).solved) return fail('this level solves itself — remove a crystal or add a wall');

    const result = solvePar(board, 6, {
      allowCells: Array.from(socketSet),
      inventory: { mirrors: 6, splitters: 6 },
      deadlineMs: 1500,
      maxNodes: 600_000,
    });
    if (!result.solvable) {
      void walls;
      return { ...fail('no solution exists on these sockets'), crystals };
    }
    if (result.par < 1) return { ...fail('level needs at least one element'), crystals };

    return {
      status: 'ok',
      valid: true,
      par: result.par,
      solvable: true,
      crystals,
      reason: `verified — par ${result.par} with ${result.solution.length} elements`,
    };
  }

  /** Persist a community level and post it to the subreddit. */
  async publishUgc(
    title: string,
    cells: ReadonlyArray<number>,
    mounts: ReadonlyArray<number>
  ): Promise<{ published: boolean; id: string; message: string; url: string }> {
    const check = this.verifyUgc(cells, mounts);
    if (!check.valid) {
      return { published: false, id: '', message: check.reason, url: '' };
    }
    const player = await this.adapter.currentPlayer();
    const id = `ugc:${Date.now().toString(36)}`;
    const puzzle: Puzzle = {
      id,
      dayIndex: 0,
      theme: title.slice(0, 60) || 'Community level',
      par: check.par,
      cells: Array.from(cells),
      mounts: Array.from(mounts),
      version: 1,
      author: player.username,
    };
    await this.kv.set(KEY.ugc(id), JSON.stringify(puzzle));
    const indexRaw = await this.kv.get(KEY.ugcIndex);
    const index: string[] = indexRaw ? (safeParse(indexRaw) as string[] | null) ?? [] : [];
    index.unshift(id);
    await this.kv.set(KEY.ugcIndex, JSON.stringify(index.slice(0, 200)));

    const postTitle = `LumenGrid Community #${editionForDate(todayUtc())} — ${puzzle.theme} (Par ${puzzle.par})`;
    const postBody = `A community-built optical puzzle by u/${player.username}. Can you light every gem in ${puzzle.par} elements?`;
    const posted = await this.adapter.reddit.submitCustomPost(postTitle, postBody, true);

    return {
      published: true,
      id,
      message: posted ? 'posted to the subreddit' : 'saved (could not post to Reddit)',
      url: posted?.url ?? '',
    };
  }

  async loadUgc(id: string): Promise<Puzzle | null> {
    const raw = await this.kv.get(KEY.ugc(id));
    if (!raw) return null;
    const parsed = safeParse(raw);
    if (!parsed || !Array.isArray(parsed.cells) || !Array.isArray(parsed.mounts)) return null;
    return parsed as unknown as Puzzle;
  }

  /** Build the exact comment a share action will post. */
  shareTextFor(puzzle: Puzzle, placed: number, seconds: number, streak: number): string {
    return buildShareCard(puzzle, { placed, par: puzzle.par, seconds, streak, best: streak });
  }

  async shareComment(
    date: string,
    placed: number,
    seconds: number
  ): Promise<{ posted: boolean; text: string; message: string }> {
    const puzzle = await this.puzzle(date);
    if (!puzzle) return { posted: false, text: '', message: 'unknown puzzle' };
    const player = await this.adapter.currentPlayer();
    const streak = Number((await this.kv.get(KEY.streak(player.username))) ?? '0') || 0;
    const text = this.shareTextFor(puzzle, placed, seconds, streak);
    const postId = this.adapter.postId();
    if (!postId) return { posted: false, text, message: 'no post context to comment on' };
    const result = await this.adapter.reddit.submitComment(postId, text, true);
    return { posted: result.ok, text, message: result.detail };
  }

  /** Flair is a nice-to-have: any failure is swallowed and reported, never thrown. */
  async awardFlair(streak: number, badge: ParBadge): Promise<{ ok: boolean; detail: string }> {
    try {
      const mark = badge === 'under' ? '💎' : badge === 'par' ? '⚡' : '✨';
      return await this.adapter.reddit.setUserFlair(`${mark} ${streakTier(streak)} · ${streak}d`);
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'flair failed' };
    }
  }
}

/**
 * The flair ladder.
 *
 * Exported and pure so the tier boundaries can be tested directly: getting
 * these thresholds wrong is invisible in play (a player simply sees a tier name
 * they cannot verify) but shows up immediately in any write-up that quotes them.
 * The thresholds live here and nowhere else.
 */
export function streakTier(streak: number): string {
  if (streak >= 30) return 'Lumen Master';
  if (streak >= 7) return 'Prism Adept';
  if (streak >= 3) return 'Beam Rider';
  return 'Lightbringer';
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
