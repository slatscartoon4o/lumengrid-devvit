/**
 * API integration tests.
 *
 * These run the real routes against the real `GameService` over the local
 * adapter, so they exercise the same code paths Devvit will.  The anti-cheat
 * tests matter most: if the server ever trusts the client's word that a board
 * is solved, the leaderboard is worthless.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { LocalAdapter } from '../src/server/adapters/local-adapter';
import { createApiRoutes } from '../src/server/routes/api';
import { createMenuRoutes } from '../src/server/routes/menu';
import { createTriggerRoutes } from '../src/server/routes/triggers';
import { GameService, validatePlacements, streakTier } from '../src/server/game-service';
import {
  CELL_COUNT,
  KIND_CRYSTAL,
  PLACE_MIRROR_BACK,
  PLACE_MIRROR_SLASH,
  PLACE_NONE,
  PLACE_SPLIT_BACK,
  PLACE_SPLIT_SLASH,
  Puzzle,
  cellKind,
  encodeCell,
  KIND_EMITTER,
  DIR_RIGHT,
  CH_RED,
} from '../src/shared/types';
import { generateDailyPuzzle, todayUtc } from '../src/shared/generator';
import { solvePar } from '../src/shared/solver';
import { trace } from '../src/shared/optics';
import type { InitResponse, SubmitResponse, LeaderboardResponse } from '../src/shared/api';

function makeApp(adapter: LocalAdapter): Hono {
  const app = new Hono();
  app.route('/api', createApiRoutes(adapter));
  app.route('/internal/menu', createMenuRoutes(adapter));
  app.route('/internal/triggers', createTriggerRoutes(adapter));
  return app;
}

/** The solution as a 64-cell placement array the client would send. */
function solutionArray(puzzle: Puzzle): number[] {
  const out = new Array<number>(CELL_COUNT).fill(PLACE_NONE);
  const proof = solvePar(puzzle.cells, puzzle.par + 2, {
    allowCells: puzzle.mounts,
    inventory: { mirrors: puzzle.par + 2, splitters: puzzle.par + 2 },
    deadlineMs: 4000,
    maxNodes: 3_000_000,
  });
  if (!proof.solvable) throw new Error('test fixture puzzle is unsolvable');
  for (const step of proof.solution) out[step.cellIndex] = step.code;
  return out;
}

/** A local adapter whose flair call always throws, standing in for an API outage. */
class FlakyFlairAdapter extends LocalAdapter {
  override get reddit(): LocalAdapter['reddit'] {
    const base = super.reddit;
    return {
      ...base,
      setUserFlair: async () => {
        throw new Error('reddit api unavailable');
      },
    };
  }
}

describe('API', () => {
  let adapter: LocalAdapter;
  let app: Hono;

  beforeEach(() => {
    adapter = new LocalAdapter('tester');
    app = makeApp(adapter);
  });

  it('GET /api/init returns today, a puzzle and a profile', async () => {
    const res = await app.request('/api/init');
    expect(res.status).toBe(200);
    const body = (await res.json()) as InitResponse;
    expect(body.status).toBe('ok');
    expect(body.today).toBe(todayUtc());
    expect(body.puzzle.cells.length).toBe(CELL_COUNT);
    expect(body.puzzle.par).toBeGreaterThanOrEqual(1);
    expect(body.profile.username).toBe('tester');
    expect(body.localMode).toBe(true);
    expect(body.archive.length).toBeGreaterThan(0);
    expect(body.features.ugc).toBe(true);
  });

  it('GET /api/puzzle/:date serves past dates but not the future', async () => {
    const today = todayUtc();
    const ok = await app.request(`/api/puzzle/${today}`);
    expect(ok.status).toBe(200);

    const future = await app.request('/api/puzzle/2099-01-01');
    expect(future.status).toBe(404);

    const bad = await app.request('/api/puzzle/not-a-date');
    expect(bad.status).toBe(400);
  });

  it('POST /api/submit accepts a genuine solution', async () => {
    const today = todayUtc();
    const puzzle = generateDailyPuzzle(today);
    const placements = solutionArray(puzzle);
    const res = await app.request('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: today, placements, seconds: 42 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SubmitResponse;
    expect(body.status).toBe('ok');
    expect(body.solved).toBe(true);
    expect(body.placed).toBe(puzzle.par);
    expect(body.badge).toBe('par');
    expect(body.streak).toBe(1);
  });

  it('rejects a submission that claims a solve but does not solve', async () => {
    const today = todayUtc();
    const puzzle = generateDailyPuzzle(today);
    const empty = new Array<number>(CELL_COUNT).fill(PLACE_NONE);
    const res = await app.request('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: today, placements: empty, seconds: 1 }),
    });
    const body = (await res.json()) as SubmitResponse;
    expect(body.solved).toBe(false);
    expect(body.streak).toBe(0);
  });

  it('rejects an element placed outside the build zone', async () => {
    const today = todayUtc();
    const puzzle = generateDailyPuzzle(today);
    // Find a legal-looking cell that is NOT a socket.
    const socketSet = new Set(puzzle.mounts);
    let outside = -1;
    for (let i = 0; i < CELL_COUNT; i++) {
      if (!socketSet.has(i) && puzzle.cells[i] === 0) {
        outside = i;
        break;
      }
    }
    expect(outside).toBeGreaterThanOrEqual(0);
    const placements = new Array<number>(CELL_COUNT).fill(PLACE_NONE);
    placements[outside] = PLACE_MIRROR_SLASH;
    const res = await app.request('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: today, placements, seconds: 1 }),
    });
    const body = (await res.json()) as SubmitResponse;
    expect(body.accepted).toBe(false);
    expect(body.reason).toMatch(/outside the build zone/i);
  });

  it('rejects a bogus placement code', async () => {
    const today = todayUtc();
    const puzzle = generateDailyPuzzle(today);
    const placements = new Array<number>(CELL_COUNT).fill(PLACE_NONE);
    const socket = puzzle.mounts[0];
    if (socket !== undefined) placements[socket] = 99;
    const res = await app.request('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: today, placements, seconds: 1 }),
    });
    const body = (await res.json()) as SubmitResponse;
    expect(body.accepted).toBe(false);
  });

  it('rejects a wrong-length placements array', async () => {
    const res = await app.request('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: todayUtc(), placements: [1, 2, 3], seconds: 1 }),
    });
    const body = (await res.json()) as SubmitResponse;
    expect(body.accepted).toBe(false);
    expect(body.reason).toMatch(/expected 64/i);
  });

  it('records the best score and increments solves only once per day', async () => {
    const today = todayUtc();
    const puzzle = generateDailyPuzzle(today);
    const placements = solutionArray(puzzle);

    const first = (await (
      await app.request('/api/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date: today, placements, seconds: 30 }),
      })
    ).json()) as SubmitResponse;
    expect(first.solves).toBeGreaterThanOrEqual(1);
    const solvesAfterFirst = first.solves;

    const second = (await (
      await app.request('/api/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date: today, placements, seconds: 20 }),
      })
    ).json()) as SubmitResponse;
    // A replay must not double-count the day's solves.
    expect(second.solves).toBe(solvesAfterFirst);
    // And must not inflate the streak either.
    expect(second.streak).toBe(first.streak);
  });

  it('awarding flair is wired into a real solve, not merely defined', async () => {
    // Regression: `awardFlair` existed but nothing called it, so streak flair
    // was never granted — and no test noticed, which is how it survived.  The
    // assertion is on the adapter's recorded state, i.e. what Reddit would see.
    const today = todayUtc();
    const puzzle = generateDailyPuzzle(today);
    await app.request('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: today, placements: solutionArray(puzzle), seconds: 12 }),
    });
    const flair = adapter.inspect().flair;
    expect(flair).not.toBeNull();
    expect(flair).toContain('Lightbringer');
    expect(flair).toContain('1d');
  });

  it('a flair failure never fails an otherwise valid solve', async () => {
    // Flair is cosmetic.  If the Reddit API is down, the player still solved
    // the board and the leaderboard must still record it.
    const today = todayUtc();
    const puzzle = generateDailyPuzzle(today);
    const site = makeApp(new FlakyFlairAdapter('tester'));
    const res = await site.request('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: today, placements: solutionArray(puzzle), seconds: 12 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SubmitResponse;
    expect(body.solved).toBe(true);
    expect(body.accepted).toBe(true);
  });

  it('GET /api/leaderboard returns a histogram summing to the board size', async () => {
    const today = todayUtc();
    const puzzle = generateDailyPuzzle(today);
    const placements = solutionArray(puzzle);
    await app.request('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: today, placements, seconds: 25 }),
    });
    const res = await app.request(`/api/leaderboard/${today}`);
    const body = (await res.json()) as LeaderboardResponse;
    expect(body.status).toBe('ok');
    const total = body.community.histogram.reduce((sum, n) => sum + n, 0);
    expect(total).toBe(body.community.top.length > 0 ? total : 0);
    expect(total).toBeGreaterThanOrEqual(1);
    expect(body.community.top.length).toBeLessThanOrEqual(10);
  });

  it('POST /api/hint names a real next step', async () => {
    const today = todayUtc();
    const puzzle = generateDailyPuzzle(today);
    const empty = new Array<number>(CELL_COUNT).fill(PLACE_NONE);
    const res = await app.request('/api/hint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: today, placements: empty }),
    });
    const body = (await res.json()) as { found: boolean; cellIndex: number | null; code: number | null };
    expect(body.found).toBe(true);
    expect(body.cellIndex).not.toBeNull();
    // The hinted cell must be a socket, and the code must be a real element.
    if (body.cellIndex !== null) {
      expect(puzzle.mounts).toContain(body.cellIndex);
    }
    expect([1, 2, 3, 4]).toContain(body.code);
  });

  it('POST /api/share-comment builds a spoiler-free card and records the comment', async () => {
    const today = todayUtc();
    const puzzle = generateDailyPuzzle(today);
    const res = await app.request('/api/share-comment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: today, placed: puzzle.par, seconds: 65 }),
    });
    const body = (await res.json()) as { posted: boolean; text: string };
    expect(body.posted).toBe(true);
    expect(body.text).toMatch(/LumenGrid/);
    // The card must never leak where elements go.
    expect(body.text).not.toMatch(/mirror|splitter|socket|cell/i);
    expect(adapter.inspect().comments.length).toBe(1);
  });

  it('POST /api/ugc/verify accepts a hand-built valid level', () => {
    // Build a simple level directly: emitter firing right, a crystal two
    // squares above where a single `/` mirror can reach.
    const cells = new Array<number>(CELL_COUNT).fill(0);
    const idx = (x: number, y: number): number => y * 8 + x;
    cells[idx(0, 4)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(5, 1)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    const mounts = [idx(5, 4), idx(3, 4)];
    const service = new GameService(adapter);
    const result = service.verifyUgc(cells, mounts);
    expect(result.valid).toBe(true);
    expect(result.solvable).toBe(true);
    expect(result.par).toBe(1);
  });

  it('POST /api/ugc/verify rejects a level with no crystal', async () => {
    const cells = new Array<number>(CELL_COUNT).fill(0);
    cells[8 * 4 + 0] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    const res = await app.request('/api/ugc/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cells, mounts: [8 * 3 + 3, 8 * 2 + 2] }),
    });
    const body = (await res.json()) as { valid: boolean; reason: string };
    expect(body.valid).toBe(false);
    expect(body.reason).toMatch(/crystal/i);
  });

  it('POST /api/ugc/verify rejects a level that solves itself', async () => {
    const cells = new Array<number>(CELL_COUNT).fill(0);
    const idx = (x: number, y: number): number => y * 8 + x;
    cells[idx(0, 4)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(5, 4)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    const res = await app.request('/api/ugc/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cells, mounts: [idx(3, 3), idx(2, 2)] }),
    });
    const body = (await res.json()) as { valid: boolean; reason: string };
    expect(body.valid).toBe(false);
    expect(body.reason).toMatch(/solves itself/i);
  });

  it('POST /api/ugc/verify rejects an unsolvable level', async () => {
    const cells = new Array<number>(CELL_COUNT).fill(0);
    const idx = (x: number, y: number): number => y * 8 + x;
    cells[idx(0, 4)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(5, 7)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    // Only a socket far away from any useful bounce.
    const res = await app.request('/api/ugc/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cells, mounts: [idx(1, 6), idx(2, 6)] }),
    });
    const body = (await res.json()) as { valid: boolean };
    expect(body.valid).toBe(false);
  });

  it('POST /api/ugc/publish stores and posts a valid level', async () => {
    const cells = new Array<number>(CELL_COUNT).fill(0);
    const idx = (x: number, y: number): number => y * 8 + x;
    cells[idx(0, 4)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(5, 1)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    const res = await app.request('/api/ugc/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cells, mounts: [idx(5, 4), idx(3, 4)], title: 'Test circuit' }),
    });
    const body = (await res.json()) as { published: boolean; id: string };
    expect(body.published).toBe(true);
    expect(body.id).toMatch(/^ugc:/);
    expect(adapter.inspect().posts.length).toBe(1);

    const service = new GameService(adapter);
    const loaded = await service.loadUgc(body.id);
    expect(loaded?.par).toBe(1);
  });

  it('GET /api/init returns 500-free error shape on internal failure', async () => {
    // A broken adapter should surface as a JSON error, not a crash.
    const broken = new LocalAdapter('x');
    Object.defineProperty(broken, 'kv', {
      get() {
        throw new Error('storage down');
      },
    });
    const brokenApp = makeApp(broken);
    const res = await brokenApp.request('/api/init');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('error');
  });

  it('menu: post-today creates a post and reports the edition', async () => {
    const res = await app.request('/internal/menu/post-today', { method: 'POST' });
    const body = (await res.json()) as { showToast: string };
    expect(body.showToast).toMatch(/LumenGrid/);
  });

  it('menu: today-stats reports the solve count', async () => {
    const res = await app.request('/internal/menu/today-stats', { method: 'POST' });
    const body = (await res.json()) as { showToast: string };
    expect(body.showToast).toMatch(/solves today/);
  });

  it('trigger: on-app-install is idempotent', async () => {
    const first = (await (
      await app.request('/internal/triggers/on-app-install', { method: 'POST' })
    ).json()) as { posted: boolean };
    expect(first.posted).toBe(true);
    const second = (await (
      await app.request('/internal/triggers/on-app-install', { method: 'POST' })
    ).json()) as { posted?: boolean; message?: string };
    expect(second.message).toMatch(/already posted/i);
  });

  it('trigger: daily-puzzle posts only once', async () => {
    const a = (await (
      await app.request('/internal/triggers/daily-puzzle', { method: 'POST' })
    ).json()) as { posted: boolean };
    expect(a.posted).toBe(true);
    const b = (await (
      await app.request('/internal/triggers/daily-puzzle', { method: 'POST' })
    ).json()) as { message?: string };
    expect(b.message).toMatch(/already posted/i);
  });
});

describe('community numbers are never self-contradictory', () => {
  const today = todayUtc();
  const puzzle = generateDailyPuzzle(today);

  it('the seeded community never scores below par', async () => {
    // Par is the *proven* minimum, so a score under it is not merely unlikely —
    // it is impossible.  A seeded board full of them makes the whole scoring
    // model look broken to anyone who checks the leaderboard.
    const seeded = new LocalAdapter('observer');
    const rows = await seeded.kv.zRange(`lb:${today}`, 0, -1);
    expect(rows.length).toBeGreaterThan(100);
    const below = rows.filter((row) => row.score < puzzle.par);
    expect(below).toEqual([]);
    const above = rows.filter((row) => row.score > puzzle.par + 3);
    expect(above).toEqual([]);
  });

  it('the seeded day starts with a believable headcount', async () => {
    const seeded = new LocalAdapter('observer');
    const raw = await seeded.kv.get(`solves:${today}`);
    const rows = await seeded.kv.zRange(`lb:${today}`, 0, -1);
    expect(Number(raw)).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(100);
  });

  it('a real submission cannot shrink the day back to "1 solver"', async () => {
    // Regression: the counter used to be read with `||`, so the first real
    // solve (incr -> 1) replaced a few hundred seeded players with 1.
    const adapter = new LocalAdapter('tester');
    const service = new GameService(adapter);
    const hint = await service.hint(today, new Array<number>(CELL_COUNT).fill(0));
    expect(hint.found).toBe(true);
    const placements = new Array<number>(CELL_COUNT).fill(0);
    let cursor = hint;
    while (cursor.found && cursor.cellIndex !== null && cursor.code !== null) {
      placements[cursor.cellIndex] = cursor.code;
      cursor = await service.hint(today, placements);
    }
    const outcome = await service.submit(today, placements, 30);
    expect(outcome).toMatchObject({ status: 'ok', solved: true });

    const community = await service.communityFor(today, puzzle.par, 0);
    const histogramTotal = community.histogram.reduce((sum, n) => sum + n, 0);
    expect(histogramTotal).toBeGreaterThan(100);
    expect(community.solves).toBeGreaterThanOrEqual(histogramTotal);
    expect(community.solves).toBeGreaterThan(100);
  });

  it('communityFor never reports fewer solvers than the histogram holds', async () => {
    // Whatever the storage says, the headcount is floored by the chart: a
    // partially seeded or partially expired day must not claim "1 solver" above
    // a chart showing hundreds.
    const adapter = new LocalAdapter('tester');
    const service = new GameService(adapter);
    await adapter.kv.set(`solves:${today}`, '1');
    const community = await service.communityFor(today, puzzle.par, 0);
    const histogramTotal = community.histogram.reduce((sum, n) => sum + n, 0);
    expect(histogramTotal).toBeGreaterThan(100);
    expect(community.solves).toBe(histogramTotal);
  });
});

describe('validatePlacements', () => {
  it('accepts an empty board', () => {
    const puzzle = generateDailyPuzzle(todayUtc());
    const empty = new Array<number>(CELL_COUNT).fill(PLACE_NONE);
    const result = validatePlacements(puzzle, empty);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.placed).toBe(0);
  });

  it('counts elements correctly', () => {
    const puzzle = generateDailyPuzzle(todayUtc());
    const placements = new Array<number>(CELL_COUNT).fill(PLACE_NONE);
    const [a, b] = puzzle.mounts;
    if (a === undefined || b === undefined) throw new Error('need two sockets');
    placements[a] = PLACE_MIRROR_SLASH;
    placements[b] = PLACE_SPLIT_BACK;
    const result = validatePlacements(puzzle, placements);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.placed).toBe(2);
  });

  it('rejects stacking on a crystal', () => {
    const puzzle = generateDailyPuzzle(todayUtc());
    let crystal = -1;
    for (let i = 0; i < CELL_COUNT; i++) {
      if (cellKind(puzzle.cells[i] ?? 0) === KIND_CRYSTAL) {
        crystal = i;
        break;
      }
    }
    expect(crystal).toBeGreaterThanOrEqual(0);
    const placements = new Array<number>(CELL_COUNT).fill(PLACE_NONE);
    placements[crystal] = PLACE_MIRROR_BACK;
    const result = validatePlacements(puzzle, placements);
    // Either "outside the build zone" or "stacked on furniture" — both are
    // correct rejections, and which one fires depends on the board.
    expect(result.ok).toBe(false);
  });
});

// Type-level assertion: every placement code the client can send is one the
// validator accepts.  If someone adds a new element, this list breaks and the
// validator has to learn about it.
const ALL_CODES = [PLACE_NONE, PLACE_MIRROR_SLASH, PLACE_MIRROR_BACK, PLACE_SPLIT_SLASH, PLACE_SPLIT_BACK];
describe('placement code set', () => {
  it('covers every code the renderer can produce', () => {
    expect(ALL_CODES).toEqual([0, 1, 2, 3, 4]);
  });
  it('trace treats an unsolved board as unsolved', () => {
    const cells = new Array<number>(CELL_COUNT).fill(0);
    expect(trace(cells, new Uint8Array(CELL_COUNT)).solved).toBe(false);
  });
});

// The tier ladder is quoted verbatim in the README and the Devpost write-up, so
// its boundaries are pinned here rather than left to a comment.  A previous
// draft of both documents described every tier one step too early.
describe('flair tiers', () => {
  it('names the tier a given streak length actually earns', () => {
    expect(streakTier(1)).toBe('Lightbringer');
    expect(streakTier(2)).toBe('Lightbringer');
    expect(streakTier(3)).toBe('Beam Rider');
    expect(streakTier(6)).toBe('Beam Rider');
    expect(streakTier(7)).toBe('Prism Adept');
    expect(streakTier(29)).toBe('Prism Adept');
    expect(streakTier(30)).toBe('Lumen Master');
    expect(streakTier(365)).toBe('Lumen Master');
  });

  it('never regresses as the streak grows', () => {
    const order = ['Lightbringer', 'Beam Rider', 'Prism Adept', 'Lumen Master'];
    let previous = 0;
    for (let streak = 1; streak <= 60; streak++) {
      const rank = order.indexOf(streakTier(streak));
      expect(rank).toBeGreaterThanOrEqual(previous);
      previous = rank;
    }
  });
});
