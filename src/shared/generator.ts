/**
 * LumenGrid daily puzzle generator.
 *
 * ## The board model: optical sockets
 *
 * Each level is an 8×8 obsidian optical board with fixed furniture — laser
 * emitters, target crystals, impassable walls, colour filters — plus a small
 * set of highlighted **optical sockets**.  The player builds only on sockets.
 * That single constraint buys three things at once:
 *
 *   1. **Readable boards.**  Seven lit sockets read at a glance; sixty-four
 *      empty cells do not.
 *   2. **Exactly-computable Par.**  The solver enumerates
 *      `sockets × 4 elements × depth` instead of `64 × 4 × depth`, so the *true*
 *      minimum is cheap to prove — no heuristics, no sampling.
 *   3. **Honest hints.**  A hint can point at one socket.
 *
 * ## Construction: author the circuit, then strip it
 *
 * Each theme has its own geometric recipe — a single bouncing beam, a splitter
 * that forks into two gems, two coloured emitters that meet on one mixed-colour
 * crystal.  The recipe lays down a circuit that provably lights every crystal;
 * we then erase the elements and hand the player the furniture.  Finally the
 * exhaustive solver proves the true minimum on the socket set, and *that*
 * becomes Par — so a player who finds a cleverer route than the author is
 * rewarded for it.
 *
 * ## Determinism
 *
 * `generateDailyPuzzle(d)` is a pure function of the date string.  The seed is
 * `fnv1a("lumengrid:v5:" + d)` and all randomness flows from one
 * `mulberry32` stream, so two machines produce identical boards.
 */

import {
  BOARD_H,
  BOARD_W,
  CELL_COUNT,
  CH_BLUE,
  CH_CYAN,
  CH_GREEN,
  CH_MAGENTA,
  CH_RED,
  CH_WHITE,
  CH_YELLOW,
  DIR_DOWN,
  DIR_LEFT,
  DIR_RIGHT,
  DIR_UP,
  DX,
  DY,
  KIND_CRYSTAL,
  KIND_EMITTER,
  KIND_FILTER,
  KIND_WALL,
  PLACE_MIRROR_BACK,
  PLACE_MIRROR_SLASH,
  PLACE_SPLIT_BACK,
  PLACE_SPLIT_SLASH,
  Puzzle,
  PuzzleSummary,
  cellKind,
  encodeCell,
} from './types';
import { fnv1a, mulberry32, type Rng } from './rng';
import { solvePar } from './solver';
import { trace } from './optics';

/** Bumped whenever generation semantics change the boards we ship. */
export const GENERATOR_VERSION = 5;

export const SEASON_START = '2026-11-01';
export const SEASON_DAYS = 365;

export type DayTheme = {
  readonly index: number;
  readonly short: string;
  readonly theme: string;
  readonly minPar: number;
  readonly maxPar: number;
  readonly crystals: number;
  readonly socketCount: number;
  readonly builder: 'path' | 'split' | 'mix';
  readonly filters: boolean;
};

export const WEEK: readonly DayTheme[] = [
  { index: 0, short: 'MON', theme: 'Warm-up: trace the beam', minPar: 2, maxPar: 2, crystals: 1, socketCount: 5, builder: 'path', filters: false },
  { index: 1, short: 'TUE', theme: 'Two bounces', minPar: 2, maxPar: 2, crystals: 1, socketCount: 5, builder: 'path', filters: false },
  { index: 2, short: 'WED', theme: 'First split: one beam, two gems', minPar: 3, maxPar: 3, crystals: 2, socketCount: 6, builder: 'split', filters: false },
  { index: 3, short: 'THU', theme: 'Alchemy: mix two colours', minPar: 2, maxPar: 3, crystals: 1, socketCount: 6, builder: 'mix', filters: false },
  { index: 4, short: 'FRI', theme: 'Filters: let the right light through', minPar: 3, maxPar: 3, crystals: 2, socketCount: 6, builder: 'split', filters: true },
  { index: 5, short: 'SAT', theme: 'Satellite array: light two gems', minPar: 4, maxPar: 4, crystals: 2, socketCount: 7, builder: 'path', filters: true },
  { index: 6, short: 'SUN', theme: 'Master circuit', minPar: 4, maxPar: 4, crystals: 3, socketCount: 8, builder: 'path', filters: true },
];

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function dateToUtcDay(dateStr: string): number {
  const parts = dateStr.split('-');
  return Math.floor(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) / 86400000);
}

export function utcDayToDateString(day: number): string {
  const date = new Date(day * 86400000);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 0 = Monday … 6 = Sunday. */
export function dayIndexForDate(dateStr: string): number {
  // 1970-01-01 was a Thursday, index 3 in a Monday-first week.
  return (((dateToUtcDay(dateStr) + 3) % 7) + 7) % 7;
}

export function todayUtc(): string {
  return utcDayToDateString(Math.floor(Date.now() / 86400000));
}

export function shiftDate(dateStr: string, deltaDays: number): string {
  return utcDayToDateString(dateToUtcDay(dateStr) + deltaDays);
}

export function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return utcDayToDateString(dateToUtcDay(value)) === value;
}

export function editionForDate(dateStr: string): number {
  return dateToUtcDay(dateStr) - dateToUtcDay(SEASON_START) + 1;
}

export function isInSeason(dateStr: string): boolean {
  const edition = editionForDate(dateStr);
  return edition >= 1 && edition <= SEASON_DAYS;
}

export function summarize(puzzle: Puzzle): PuzzleSummary {
  return {
    id: puzzle.id,
    dayIndex: puzzle.dayIndex,
    theme: puzzle.theme,
    par: puzzle.par,
    edition: editionForDate(puzzle.id),
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const idx = (x: number, y: number): number => y * BOARD_W + x;
const xOf = (index: number): number => index % BOARD_W;
const yOf = (index: number): number => Math.floor(index / BOARD_W);
const inBounds = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < BOARD_W && y < BOARD_H;

/** Reflect a direction through a mirror. `\` maps right→down; `/` maps right→up. */
function reflectDir(dir: number, slash: boolean): number {
  if (slash) {
    if (dir === DIR_RIGHT) return DIR_UP;
    if (dir === DIR_UP) return DIR_RIGHT;
    if (dir === DIR_LEFT) return DIR_DOWN;
    return DIR_LEFT;
  }
  if (dir === DIR_RIGHT) return DIR_DOWN;
  if (dir === DIR_DOWN) return DIR_RIGHT;
  if (dir === DIR_LEFT) return DIR_UP;
  return DIR_LEFT;
}

/** Cells a beam would cross from (x, y) heading `dir`, stopping at walls/blocked. */
function walkForward(
  cells: ReadonlyArray<number>,
  x: number,
  y: number,
  dir: number,
  blocked: ReadonlySet<number> = new Set<number>()
): number[] {
  const out: number[] = [];
  let cx = x;
  let cy = y;
  for (let guard = 0; guard < 32; guard++) {
    const nx = cx + (DX[dir] ?? 0);
    const ny = cy + (DY[dir] ?? 0);
    if (!inBounds(nx, ny)) break;
    const index = idx(nx, ny);
    if (cellKind(cells[index] ?? 0) === KIND_WALL) break;
    if (blocked.has(index)) break;
    out.push(index);
    cx = nx;
    cy = ny;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Circuit recipes
// ---------------------------------------------------------------------------

type Candidate = {
  readonly cells: number[];
  readonly mounts: number[];
  readonly solution: ReadonlyMap<number, number>;
};

function emptyBoard(): number[] {
  return new Array<number>(CELL_COUNT).fill(0);
}

/** Pick `count` distinct cells not in `taken`. */
function sampleCells(rng: Rng, count: number, taken: ReadonlySet<number>): number[] {
  const pool: number[] = [];
  for (let i = 0; i < CELL_COUNT; i++) if (!taken.has(i)) pool.push(i);
  rng.shuffle(pool);
  return pool.slice(0, Math.max(0, count));
}

const BORDER_SIDES = [0, 1, 2, 3] as const;

type EmitterSpot = { x: number; y: number; dir: number };

function borderSpot(rng: Rng, side: number): EmitterSpot {
  const offset = 1 + rng.int(BOARD_W - 2);
  if (side === 0) return { x: 0, y: offset, dir: DIR_RIGHT };
  if (side === 1) return { x: BOARD_W - 1, y: offset, dir: DIR_LEFT };
  if (side === 2) return { x: offset, y: 0, dir: DIR_DOWN };
  return { x: offset, y: BOARD_H - 1, dir: DIR_UP };
}

/**
 * **Path circuit.**  One emitter, `mirrors` reflections, a crystal where the
 * beam finally comes to rest.  Par equals `mirrors` (verified by the solver).
 */
function planPathCircuit(rng: Rng, mirrors: number): Candidate | null {
  for (let tries = 0; tries < 60; tries++) {
    const cells = emptyBoard();
    const taken = new Set<number>();
    const mounts: number[] = [];
    const solution = new Map<number, number>();

    const spot = borderSpot(rng, rng.int(4));
    cells[idx(spot.x, spot.y)] = encodeCell(KIND_EMITTER, spot.dir, CH_RED);
    taken.add(idx(spot.x, spot.y));

    let cx = spot.x;
    let cy = spot.y;
    let cd = spot.dir;
    let ok = true;

    for (let m = 0; m < mirrors; m++) {
      const ahead = walkForward(cells, cx, cy, cd).filter((i) => !taken.has(i));
      if (ahead.length < 2) {
        ok = false;
        break;
      }
      const take = 1 + rng.int(Math.min(ahead.length - 1, 4));
      const mount = ahead[take - 1];
      if (mount === undefined) {
        ok = false;
        break;
      }
      // Turn either way, but never back along the beam.
      const slash = rng.next() < 0.5;
      const nd = reflectDir(cd, slash);
      // The outgoing ray must have somewhere to go.
      if (walkForward(cells, xOf(mount), yOf(mount), nd, taken).length < 1) {
        // Try the other orientation before giving up.
        const alt = reflectDir(cd, !slash);
        if (walkForward(cells, xOf(mount), yOf(mount), alt, taken).length < 1) {
          ok = false;
          break;
        }
        solution.set(mount, !slash ? PLACE_MIRROR_SLASH : PLACE_MIRROR_BACK);
        mounts.push(mount);
        taken.add(mount);
        cx = xOf(mount);
        cy = yOf(mount);
        cd = alt;
        continue;
      }
      solution.set(mount, slash ? PLACE_MIRROR_SLASH : PLACE_MIRROR_BACK);
      mounts.push(mount);
      taken.add(mount);
      cx = xOf(mount);
      cy = yOf(mount);
      cd = nd;
    }
    if (!ok) continue;

    const tail = walkForward(cells, cx, cy, cd, taken);
    if (tail.length < 1) continue;
    const crystal = tail[tail.length - 1];
    if (crystal === undefined || solution.has(crystal)) continue;
    cells[crystal] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    taken.add(crystal);

    const placements = new Uint8Array(CELL_COUNT);
    for (const [index, code] of solution) placements[index] = code;
    if (!trace(cells, placements).solved) continue;

    const extra = sampleCells(rng, Math.max(0, 5 - mounts.length), taken);
    for (const cell of extra) mounts.push(cell);
    return { cells, mounts, solution };
  }
  return null;
}

/**
 * **Split circuit.**  Emitter → two steering mirrors → splitter, whose two
 * outgoing branches each end in a crystal.  Par is 3.
 */
function planSplitCircuit(rng: Rng): Candidate | null {
  for (let tries = 0; tries < 120; tries++) {
    const cells = emptyBoard();
    const taken = new Set<number>();
    const mounts: number[] = [];
    const solution = new Map<number, number>();

    const spot = borderSpot(rng, rng.int(4));
    cells[idx(spot.x, spot.y)] = encodeCell(KIND_EMITTER, spot.dir, CH_RED);
    taken.add(idx(spot.x, spot.y));

    // 1) First steering mirror on the emitter's own ray.
    const ray1 = walkForward(cells, spot.x, spot.y, spot.dir).filter((i) => !taken.has(i));
    if (ray1.length < 3) continue;
    const m1 = ray1[1 + rng.int(Math.min(ray1.length - 2, 4))];
    if (m1 === undefined) continue;
    const slash1 = rng.next() < 0.5;
    const dir2 = reflectDir(spot.dir, slash1);
    if (walkForward(cells, xOf(m1), yOf(m1), dir2, taken).length < 3) continue;
    solution.set(m1, slash1 ? PLACE_MIRROR_SLASH : PLACE_MIRROR_BACK);
    mounts.push(m1);
    taken.add(m1);

    // 2) Second steering mirror.
    const ray2 = walkForward(cells, xOf(m1), yOf(m1), dir2).filter((i) => !taken.has(i));
    if (ray2.length < 3) continue;
    const m2 = ray2[1 + rng.int(Math.min(ray2.length - 2, 3))];
    if (m2 === undefined) continue;
    const slash2 = rng.next() < 0.5;
    const dir3 = reflectDir(dir2, slash2);
    if (walkForward(cells, xOf(m2), yOf(m2), dir3, taken).length < 3) continue;
    solution.set(m2, slash2 ? PLACE_MIRROR_SLASH : PLACE_MIRROR_BACK);
    mounts.push(m2);
    taken.add(m2);

    // 3) Splitter further along the third ray.
    const ray3 = walkForward(cells, xOf(m2), yOf(m2), dir3).filter((i) => !taken.has(i));
    if (ray3.length < 2) continue;
    const sp = ray3[rng.int(Math.min(ray3.length - 1, 3))];
    if (sp === undefined) continue;
    const slash3 = rng.next() < 0.5;
    solution.set(sp, slash3 ? PLACE_SPLIT_SLASH : PLACE_SPLIT_BACK);
    mounts.push(sp);
    taken.add(sp);

    const throughDir = dir3;
    const sideDir = reflectDir(dir3, slash3);
    const tRun = walkForward(cells, xOf(sp), yOf(sp), throughDir, taken);
    const sRun = walkForward(cells, xOf(sp), yOf(sp), sideDir, taken);
    if (tRun.length < 1 || sRun.length < 1) continue;

    const c1 = tRun[tRun.length - 1];
    const c2 = sRun[sRun.length - 1];
    if (c1 === undefined || c2 === undefined || c1 === c2) continue;
    if (solution.has(c1) || solution.has(c2)) continue;
    cells[c1] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    cells[c2] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    taken.add(c1);
    taken.add(c2);

    const placements = new Uint8Array(CELL_COUNT);
    for (const [index, code] of solution) placements[index] = code;
    if (!trace(cells, placements).solved) continue;

    for (const cell of sampleCells(rng, Math.max(0, 6 - mounts.length), taken)) mounts.push(cell);
    return { cells, mounts, solution };
  }
  return null;
}

/**
 * **Mix circuit.**  Two coloured emitters, one mirror each, converging on a
 * single crystal that needs their combined colour.  Par is 2 (or 3 when the
 * geometry forces an extra bounce).
 */
function planMixCircuit(rng: Rng): Candidate | null {
  const combos = [
    { a: CH_RED, b: CH_GREEN, need: CH_YELLOW },
    { a: CH_RED, b: CH_BLUE, need: CH_MAGENTA },
    { a: CH_GREEN, b: CH_BLUE, need: CH_CYAN },
  ];
  const combo = rng.pick(combos);

  for (let tries = 0; tries < 150; tries++) {
    const cells = emptyBoard();
    const taken = new Set<number>();
    const mounts: number[] = [];
    const solution = new Map<number, number>();

    const sideA = rng.pick(BORDER_SIDES);
    let sideB = rng.pick(BORDER_SIDES);
    let guardB = 0;
    while (sideB === sideA && guardB++ < 8) sideB = rng.pick(BORDER_SIDES);

    const A = borderSpot(rng, sideA);
    const B = borderSpot(rng, sideB);
    if (A.x === B.x && A.y === B.y) continue;
    cells[idx(A.x, A.y)] = encodeCell(KIND_EMITTER, A.dir, combo.a);
    cells[idx(B.x, B.y)] = encodeCell(KIND_EMITTER, B.dir, combo.b);
    taken.add(idx(A.x, A.y));
    taken.add(idx(B.x, B.y));

    // Where the two unbent rays cross.
    const rayA = walkForward(cells, A.x, A.y, A.dir);
    const rayB = walkForward(cells, B.x, B.y, B.dir);
    const setB = new Set(rayB);
    const crossings = rayA.filter((i) => setB.has(i) && !taken.has(i));
    if (crossings.length === 0) continue;

    // Route A: one bounce on A's ray that aims at a crossing cell.
    let routeA: { mount: number; slash: boolean; crystal: number } | null = null;
    for (const mount of rayA) {
      if (taken.has(mount)) continue;
      for (const slash of [true, false]) {
        const nd = reflectDir(A.dir, slash);
        const path = walkForward(cells, xOf(mount), yOf(mount), nd, taken);
        for (const crystal of crossings) {
          if (crystal !== mount && path.includes(crystal)) {
            routeA = { mount, slash, crystal };
            break;
          }
        }
        if (routeA) break;
      }
      if (routeA) break;
    }
    if (!routeA) continue;

    // Route B: one bounce on B's ray that aims at the *same* crystal.
    let routeB: { mount: number; slash: boolean } | null = null;
    for (const mount of rayB) {
      if (taken.has(mount) || mount === routeA.mount) continue;
      for (const slash of [true, false]) {
        const nd = reflectDir(B.dir, slash);
        const path = walkForward(cells, xOf(mount), yOf(mount), nd, taken);
        if (path.includes(routeA.crystal) && mount !== routeA.crystal) {
          routeB = { mount, slash };
          break;
        }
      }
      if (routeB) break;
    }
    if (!routeB) continue;

    solution.set(routeA.mount, routeA.slash ? PLACE_MIRROR_SLASH : PLACE_MIRROR_BACK);
    solution.set(routeB.mount, routeB.slash ? PLACE_MIRROR_SLASH : PLACE_MIRROR_BACK);
    mounts.push(routeA.mount, routeB.mount);
    taken.add(routeA.mount);
    taken.add(routeB.mount);
    cells[routeA.crystal] = encodeCell(KIND_CRYSTAL, combo.need, 0);
    taken.add(routeA.crystal);

    const placements = new Uint8Array(CELL_COUNT);
    for (const [index, code] of solution) placements[index] = code;
    if (!trace(cells, placements).solved) continue;

    for (const cell of sampleCells(rng, Math.max(0, 6 - mounts.length), taken)) mounts.push(cell);
    return { cells, mounts, solution };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Decoration
// ---------------------------------------------------------------------------

/**
 * Add extra crystals that the authored solution *already* lights.  Crystals are
 * transparent, so a gem dropped on a lit cell costs the player nothing yet
 * reads as a richer board.  Each candidate is verified against the trace, so a
 * decoration can never create an impossible gem.
 */
function addFreeCrystals(
  rng: Rng,
  cells: number[],
  solution: ReadonlyMap<number, number>,
  taken: ReadonlySet<number>,
  wanted: number
): number {
  if (wanted <= 0) return 0;
  const placements = new Uint8Array(CELL_COUNT);
  for (const [index, code] of solution) placements[index] = code;
  const probe = trace(cells, placements);

  const candidates: number[] = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    if (cells[i] !== 0) continue;
    if (taken.has(i)) continue;
    if ((probe.lit[i] ?? 0) !== CH_RED) continue;
    if ((probe.touched[i] ?? 0) === 0) continue;
    candidates.push(i);
  }
  rng.shuffle(candidates);

  let added = 0;
  for (const index of candidates) {
    if (added >= wanted) break;
    cells[index] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    added++;
  }
  return added;
}

/**
 * Add non-breaking walls and (optionally) one colour filter sitting on a beam
 * path.  Every change is verified against the authored solution, so decoration
 * can never break a level.
 */
function decorate(
  rng: Rng,
  cells: number[],
  solution: ReadonlyMap<number, number>,
  wallCount: number,
  filterMask: number | null
): void {
  const stillSolved = (): boolean => {
    const placements = new Uint8Array(CELL_COUNT);
    for (const [index, code] of solution) placements[index] = code;
    return trace(cells, placements).solved;
  };
  const before = cells.slice();
  const protectedSet = new Set<number>(solution.keys());

  let walls = 0;
  for (let attempt = 0; attempt < 200 && walls < wallCount; attempt++) {
    const index = rng.int(CELL_COUNT);
    if (cells[index] !== 0) continue;
    if (protectedSet.has(index)) continue;
    cells[index] = encodeCell(KIND_WALL, 0, 0);
    if (!stillSolved()) cells[index] = 0;
    else walls++;
  }

  if (filterMask !== null) {
    const placements = new Uint8Array(CELL_COUNT);
    for (const [index, code] of solution) placements[index] = code;
    const probe = trace(cells, placements);
    const candidates: number[] = [];
    for (let i = 0; i < CELL_COUNT; i++) {
      if (cells[i] !== 0) continue;
      if (!(probe.touched[i] ?? 0)) continue;
      if (protectedSet.has(i)) continue;
      candidates.push(i);
    }
    if (candidates.length > 0) {
      const chosen = rng.pick(candidates);
      cells[chosen] = encodeCell(KIND_FILTER, filterMask, 0);
      if (!stillSolved()) cells[chosen] = 0;
    }
  }

  if (!stillSolved()) {
    for (let i = 0; i < CELL_COUNT; i++) cells[i] = before[i] ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function planCandidate(rng: Rng, theme: DayTheme): Candidate | null {
  if (theme.builder === 'split') return planSplitCircuit(rng);
  if (theme.builder === 'mix') {
    const mix = planMixCircuit(rng);
    // Thursday occasionally serves a longer path when the mix geometry is
    // awkward, so the week does not feel repetitive.
    if (mix) return mix;
    return planPathCircuit(rng, 3);
  }
  if (theme.builder === 'path' && theme.crystals >= 2) {
    // Saturday / Sunday: a long path with several gems dropped along it.  Par
    // is the number of mirrors, so cutting the path short is impossible.
    const path = planPathCircuit(rng, 4);
    if (path) return path;
    return planPathCircuit(rng, 3);
  }
  return planPathCircuit(rng, theme.minPar);
}

/** Pure function of `dateStr`.  Results are memoised per process. */
const cache = new Map<string, Puzzle>();

export function generateDailyPuzzle(dateStr: string): Puzzle {
  const cached = cache.get(dateStr);
  if (cached) return cached;

  const dayIndex = dayIndexForDate(dateStr);
  const theme = WEEK[dayIndex] ?? (WEEK[0] as DayTheme);
  const baseSeed = fnv1a(`lumengrid:v${GENERATOR_VERSION}:${dateStr}`);

  for (let attemptNumber = 0; attemptNumber < 90; attemptNumber++) {
    const rng = mulberry32((baseSeed + Math.imul(attemptNumber, 0x9e3779b1)) >>> 0);
    const puzzle = tryGenerateOnce(rng, theme, dateStr);
    if (puzzle) {
      cache.set(dateStr, puzzle);
      return puzzle;
    }
  }

  const fallback = fallbackPuzzle(dateStr, theme);
  cache.set(dateStr, fallback);
  return fallback;
}

function tryGenerateOnce(rng: Rng, theme: DayTheme, dateStr: string): Puzzle | null {
  const candidate = planCandidate(rng, theme);
  if (!candidate) return null;

  const { cells, solution } = candidate;
  const taken = new Set<number>(candidate.mounts);
  for (let i = 0; i < CELL_COUNT; i++) if (cells[i] !== 0) taken.add(i);
  // Sockets may not coincide with furniture.
  const mounts = candidate.mounts.filter((cell) => cells[cell] === 0);

  // Top up to the theme's gem count using cells the solution already lights.
  let crystals = 0;
  for (let i = 0; i < CELL_COUNT; i++) if (cellKind(cells[i] ?? 0) === KIND_CRYSTAL) crystals++;
  if (crystals < theme.crystals) {
    crystals += addFreeCrystals(rng, cells, solution, taken, theme.crystals - crystals);
  }
  if (crystals !== theme.crystals) return null;

  decorate(
    rng,
    cells,
    solution,
    theme.index >= 4 ? 3 + rng.int(5) : 2 + rng.int(3),
    theme.filters ? (rng.next() < 0.5 ? CH_RED : CH_WHITE) : null
  );

  // Never a freebie, and never broken by decoration.
  if (trace(cells, new Uint8Array(CELL_COUNT)).solved) return null;
  const authoredPlacements = new Uint8Array(CELL_COUNT);
  for (const [index, code] of solution) authoredPlacements[index] = code;
  if (!trace(cells, authoredPlacements).solved) return null;
  if (solution.size < theme.minPar) return null;

  // Sockets must all be empty.
  const cleanMounts = mounts.filter((cell) => cells[cell] === 0);
  if (cleanMounts.length < theme.socketCount) {
    // Pad with random empties so the build zone always feels deliberate.
    const padTaken = new Set<number>([...taken, ...cleanMounts]);
    const pad = sampleCells(rng, theme.socketCount - cleanMounts.length, padTaken);
    for (const cell of pad) if (cells[cell] === 0) cleanMounts.push(cell);
  }
  if (cleanMounts.length < theme.socketCount) return null;

  const verify = solvePar(cells, theme.maxPar, {
    deadlineMs: theme.index >= 4 ? 1200 : 700,
    maxNodes: 800_000,
    allowCells: cleanMounts,
    inventory: { mirrors: theme.maxPar, splitters: theme.maxPar },
  });
  if (!verify.solvable) return null;
  if (verify.par < theme.minPar) return null;

  return {
    id: dateStr,
    dayIndex: theme.index,
    theme: theme.theme,
    par: verify.par,
    cells,
    mounts: cleanMounts.slice().sort((a, b) => a - b),
    version: GENERATOR_VERSION,
  };
}

/**
 * A hand-authored level used only if the random generator cannot satisfy the
 * theme for a given date.  Always solvable: emitter (0,2) → `\` at (5,2) →
 * down to the crystal at (5,6).
 */
export function fallbackPuzzle(dateStr: string, theme: DayTheme): Puzzle {
  const cells = emptyBoard();
  cells[idx(0, 2)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
  cells[idx(5, 6)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
  cells[idx(0, 6)] = encodeCell(KIND_WALL, 0, 0);
  cells[idx(7, 0)] = encodeCell(KIND_WALL, 0, 0);
  return {
    id: dateStr,
    dayIndex: theme.index,
    theme: theme.theme,
    par: 1,
    cells,
    mounts: [idx(5, 2), idx(3, 4), idx(2, 5)],
    version: GENERATOR_VERSION,
  };
}

export type { Puzzle };
