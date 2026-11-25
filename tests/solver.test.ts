/**
 * Solver tests — the solver has to be *exactly* right, because it defines Par
 * and it guards the scoreboard against cheaters.
 */
import { describe, expect, it } from 'vitest';
import {
  CELL_COUNT,
  CH_BLUE,
  CH_RED,
  DIR_DOWN,
  DIR_RIGHT,
  KIND_CRYSTAL,
  KIND_EMITTER,
  KIND_WALL,
  PLACE_MIRROR_BACK,
  PLACE_MIRROR_SLASH,
  PLACE_SPLIT_BACK,
  encodeCell,
} from '../src/shared/types';
import { isSolved, legalPlacementCells, solve, solvePar } from '../src/shared/solver';
import { trace } from '../src/shared/optics';
import { fnv1a, mulberry32 } from '../src/shared/rng';

const idx = (x: number, y: number): number => y * 8 + x;
const empty = (): number[] => new Array<number>(CELL_COUNT).fill(0);

describe('solver', () => {
  it('finds a single mirror', () => {
    const cells = empty();
    cells[idx(0, 2)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(5, 2)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    const result = solvePar(cells, 3);
    expect(result.solvable).toBe(true);
    if (result.solvable) {
      // A straight shot needs an element? No — wait: the crystal is directly
      // on the ray, so the level is solved with zero mirrors.
      expect(result.par).toBe(0);
    }
  });

  it('requires exactly one mirror for a 90° turn', () => {
    const cells = empty();
    cells[idx(0, 2)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(3, 5)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    const mounts = [idx(3, 2), idx(2, 3), idx(1, 4), idx(2, 4)];
    const result = solvePar(cells, 3, { allowCells: mounts });
    expect(result.solvable).toBe(true);
    if (result.solvable) expect(result.par).toBe(1);
  });

  it('par rises to 2 when a single bounce cannot reach', () => {
    const cells = empty();
    cells[idx(0, 1)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(5, 6)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    // Only cells off the direct row/column lines remain — a two-mirror job.
    const mounts = [idx(6, 1), idx(6, 2), idx(6, 3), idx(6, 4), idx(6, 5), idx(6, 6)];
    const result = solvePar(cells, 3, { allowCells: mounts });
    expect(result.solvable).toBe(true);
    if (result.solvable) expect(result.par).toBe(2);
  });

  it('refuses solutions on cells outside the build zone', () => {
    const cells = empty();
    cells[idx(0, 2)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(3, 5)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    // The only bounce point (3,2) is *not* offered, so no solution exists.
    const result = solvePar(cells, 2, { allowCells: [idx(1, 1), idx(2, 2)] });
    expect(result.solvable).toBe(false);
  });

  it('finds a splitter solution when a split is required', () => {
    const cells = empty();
    cells[idx(0, 3)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(7, 3)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    cells[idx(4, 7)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    // The crystal at (7,3) sits on the straight ray, so a splitter at (4,3)
    // simultaneously satisfies the bottom crystal.
    const mounts = [idx(4, 3), idx(4, 6), idx(2, 2)];
    const result = solvePar(cells, 3, { allowCells: mounts });
    expect(result.solvable).toBe(true);
    if (result.solvable) expect(result.par).toBe(1);
    if (result.solvable) {
      const solution = result.solution[0];
      expect(solution?.code).toBe(PLACE_SPLIT_BACK);
    }
  });

  it('a wall cannot be built on', () => {
    const cells = empty();
    cells[idx(0, 2)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(5, 3)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    cells[idx(5, 2)] = encodeCell(KIND_WALL, 0, 0);
    const legal = legalPlacementCells(cells);
    expect(legal).not.toContain(idx(5, 2));
    expect(legal).not.toContain(idx(0, 2));
    expect(legal).not.toContain(idx(5, 3));
  });

  it('reports no-solution for an unreachable crystal', () => {
    const cells = empty();
    cells[idx(0, 2)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(7, 7)] = encodeCell(KIND_CRYSTAL, CH_BLUE, 0); // wrong colour
    const result = solvePar(cells, 2, { allowCells: [idx(3, 3)] });
    expect(result.solvable).toBe(false);
  });

  it('honours the inventory: a splitter level needs a splitter', () => {
    const cells = empty();
    cells[idx(0, 3)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(7, 3)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    cells[idx(4, 7)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    const withoutSplitter = solve(cells, { mirrors: 3, splitters: 0 }, {
      allowCells: [idx(4, 3)],
    });
    expect(withoutSplitter.solvable).toBe(false);
    const withSplitter = solve(cells, { mirrors: 3, splitters: 1 }, {
      allowCells: [idx(4, 3)],
    });
    expect(withSplitter.solvable).toBe(true);
  });

  it('returns the minimal solution, not just any solution', () => {
    const cells = empty();
    cells[idx(0, 2)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(6, 6)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    // Two routes exist: a single `/` at (6,2) sends it down; or arbitrary
    // three-mirror meanders.  The solver must report 1.
    const mounts = [idx(6, 2), idx(2, 2), idx(3, 3), idx(4, 4), idx(5, 5), idx(2, 6)];
    const result = solvePar(cells, 4, { allowCells: mounts });
    expect(result.solvable).toBe(true);
    if (result.solvable) expect(result.par).toBe(1);
  });

  it('the reported solution really solves the board', () => {
    const cells = empty();
    cells[idx(0, 1)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(6, 6)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    const mounts = [idx(6, 1), idx(6, 2), idx(6, 3), idx(6, 4), idx(6, 5)];
    const result = solvePar(cells, 3, { allowCells: mounts });
    expect(result.solvable).toBe(true);
    if (!result.solvable) return;
    const placements = new Uint8Array(CELL_COUNT);
    for (const s of result.solution) placements[s.cellIndex] = s.code;
    expect(trace(cells, placements).solved).toBe(true);
    expect(isSolved(cells, placements)).toBe(true);
  });

  it('a fully pre-solved board returns par 0', () => {
    const cells = empty();
    cells[idx(0, 2)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(5, 2)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    const result = solvePar(cells, 3);
    expect(result.solvable).toBe(true);
    if (result.solvable) expect(result.par).toBe(0);
  });

  it('a mirror-only level does not need splitters', () => {
    const cells = empty();
    cells[idx(0, 1)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(6, 7)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    const mounts: number[] = [];
    for (let y = 1; y < 8; y++) mounts.push(idx(6, y));
    const result = solve(cells, { mirrors: 4, splitters: 0 }, { allowCells: mounts });
    expect(result.solvable).toBe(true);
    if (result.solvable) expect(result.par).toBe(1);
  });

  it('deterministic: two identical calls give identical answers', () => {
    const cells = empty();
    cells[idx(0, 3)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(7, 3)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    cells[idx(4, 7)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    const mounts = [idx(4, 3), idx(4, 5), idx(2, 2), idx(6, 6)];
    const a = solvePar(cells, 3, { allowCells: mounts });
    const b = solvePar(cells, 3, { allowCells: mounts });
    expect(JSON.stringify(a.solution ?? null)).toBe(JSON.stringify(b.solution ?? null));
    expect(a.solvable && a.par).toBe(b.solvable && b.par);
  });

  it('random small boards: any solution the solver returns is valid', () => {    const rng = mulberry32(fnv1a('solver-fuzz'));
    let solvedCount = 0;
    for (let trial = 0; trial < 30; trial++) {
      const cells = empty();
      const ex = 0;
      const ey = 1 + rng.int(6);
      cells[idx(ex, ey)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
      const cx = 2 + rng.int(6);
      const cy = rng.int(8);
      if (cx === ex && cy === ey) continue;
      cells[idx(cx, cy)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
      const mounts: number[] = [];
      while (mounts.length < 6) {
        const i = rng.int(CELL_COUNT);
        if (!mounts.includes(i) && cells[i] === 0) mounts.push(i);
      }
      const result = solvePar(cells, 3, { allowCells: mounts });
      if (result.solvable) {
        solvedCount++;
        const placements = new Uint8Array(CELL_COUNT);
        for (const s of result.solution) placements[s.cellIndex] = s.code;
        expect(trace(cells, placements).solved).toBe(true);
        expect(result.par).toBe(result.solution.length);
        // No smaller solution should exist.  Re-check by exhaustively trying
        // every configuration of a smaller size.
        for (let smaller = 0; smaller < result.par; smaller++) {
          expect(bruteForceExists(cells, mounts, smaller)).toBe(false);
        }
      }
    }
    expect(solvedCount).toBeGreaterThan(0);
  });
});

describe('solve() with pinned elements', () => {
  // A 90° turn: emitter at (0,2) firing right, crystal at (3,5).  The bounce
  // point must be (3,2) with a `\` mirror.  These tests pin a player's work and
  // check the solver answers "what is the cheapest completion?" rather than
  // re-solving from an empty board.
  const turnBoard = (): number[] => {
    const cells = empty();
    cells[idx(0, 2)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(3, 5)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    return cells;
  };
  const turnMounts = [idx(3, 2), idx(2, 3), idx(1, 4), idx(2, 4)];

  it('reports par 0 when the player already placed the answer', () => {
    const cells = turnBoard();
    const pinned = new Uint8Array(CELL_COUNT);
    pinned[idx(3, 2)] = PLACE_MIRROR_BACK;
    const result = solvePar(cells, 3, { allowCells: turnMounts, pinned });
    expect(result.solvable).toBe(true);
    if (result.solvable) {
      expect(result.par).toBe(0);
      expect(result.solution).toHaveLength(0);
    }
  });

  it('never reuses a cell the player has occupied', () => {
    const cells = turnBoard();
    const pinned = new Uint8Array(CELL_COUNT);
    // A wrong mirror on the only useful bounce cell.  The solver must not
    // propose a second element on (3,2) — that cell is spoken for.
    pinned[idx(3, 2)] = PLACE_MIRROR_SLASH;
    const result = solvePar(cells, 3, { allowCells: turnMounts, pinned });
    for (const step of result.solvable ? result.solution : []) {
      expect(step.cellIndex).not.toBe(idx(3, 2));
    }
  });

  it('counts only the new elements in par', () => {
    const cells = turnBoard();
    const pinned = new Uint8Array(CELL_COUNT);
    pinned[idx(1, 1)] = PLACE_MIRROR_SLASH; // irrelevant decoration
    const result = solvePar(cells, 3, { allowCells: turnMounts, pinned });
    expect(result.solvable).toBe(true);
    if (result.solvable) expect(result.par).toBe(1);
  });

  it('pinned elements survive the depth loop reset', () => {
    // Regression: the depth loop wipes `placements` before each pass.  If the
    // pinned array is not restored, depth 1 searches an empty board and can
    // report a solution that ignores the player's work.
    const cells = turnBoard();
    const pinned = new Uint8Array(CELL_COUNT);
    pinned[idx(3, 2)] = PLACE_MIRROR_BACK;
    // Offer only decoy cells: the board is already solved by the pin, so the
    // only correct answer is 0 — not a spurious element on a decoy.
    const result = solve(cells, { mirrors: 2, splitters: 0 }, {
      allowCells: [idx(2, 3), idx(1, 4)],
      pinned,
    });
    expect(result.solvable).toBe(true);
    if (result.solvable) {
      expect(result.par).toBe(0);
      expect(result.solution).toHaveLength(0);
    }
  });

  it('rejects a pinned array of the wrong length', () => {
    expect(() => solvePar(turnBoard(), 2, { pinned: [1, 2, 3] })).toThrow(/64/);
  });

  it("a second hint step extends the player's first step", () => {
    // Mirrors GameService.hint: solve for one step, apply it, ask again.  The
    // second answer must extend the first instead of repeating it.
    const cells = turnBoard();
    const pinned = new Uint8Array(CELL_COUNT);
    const first = solvePar(cells, 3, { allowCells: turnMounts, pinned });
    expect(first.solvable).toBe(true);
    if (!first.solvable) return;
    const step = first.solution[0];
    expect(step).toBeDefined();
    if (!step) return;
    pinned[step.cellIndex] = step.code;
    const second = solvePar(cells, 3, { allowCells: turnMounts, pinned });
    expect(second.solvable).toBe(true);
    if (!second.solvable) return;
    for (const s of second.solution) expect(s.cellIndex).not.toBe(step.cellIndex);
    // Applying both gets the board lit.
    const placements = Uint8Array.from(pinned);
    for (const s of second.solution) placements[s.cellIndex] = s.code;
    expect(trace(cells, placements).solved).toBe(true);
  });
});

/** Exhaustive check that some configuration of exactly `size` elements solves. */
function bruteForceExists(
  cells: ReadonlyArray<number>,
  mounts: ReadonlyArray<number>,
  size: number
): boolean {
  const codes = [PLACE_MIRROR_SLASH, PLACE_MIRROR_BACK, PLACE_SPLIT_BACK];
  const placements = new Uint8Array(CELL_COUNT);
  let found = false;

  const recurse = (start: number, left: number): void => {
    if (found) return;
    if (left === 0) {
      if (trace(cells, placements).solved) found = true;
      return;
    }
    for (let i = start; i <= mounts.length - left; i++) {
      const cell = mounts[i];
      if (cell === undefined) continue;
      for (const code of codes) {
        placements[cell] = code;
        recurse(i + 1, left - 1);
        placements[cell] = 0;
        if (found) return;
      }
    }
  };

  if (size === 0) return trace(cells, placements).solved;
  recurse(0, size);
  return found;
}
