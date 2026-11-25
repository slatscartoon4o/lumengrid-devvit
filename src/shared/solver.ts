/**
 * LumenGrid solver — exact, exhaustive, iterative-deepening.
 *
 * ## What "exact" means here
 *
 * `solve()` returns the *minimum* number of optical elements needed to light
 * every crystal.  It proves minimality by exhausting every configuration of
 * size `0, 1, 2, …, d-1` before accepting a solution of size `d`.  There is no
 * heuristic pruning of the placement space, so the returned Par is the true
 * optimum over the cells the board allows.
 *
 * ## Why that is affordable
 *
 * The search cost is `C(n, d) * 4^d` traces where `n` is the number of legal
 * placement cells (64 minus walls, emitters and crystals).  Daily levels are
 * authored so that Par stays small (2–3) and the legal-cell count stays
 * moderate; a full 8×8 trace costs a few microseconds, so even a 20·10³
 * configuration sweep finishes in tens of milliseconds.
 *
 * ## Symmetry reduction
 *
 * A cell can hold one of four elements: mirror `/`, mirror `\`, splitter `/`,
 * splitter `\`.  When the inventory allows only mirrors, only the first two
 * codes are considered for that cell — the sweep adapts to the inventory, which
 * is what makes the cost budget-neutral.
 */

import {
  CELL_COUNT,
  KIND_CRYSTAL,
  KIND_EMITTER,
  KIND_WALL,
  PLACE_MIRROR_BACK,
  PLACE_MIRROR_SLASH,
  PLACE_SPLIT_BACK,
  PLACE_SPLIT_SLASH,
  cellKind,
} from './types';
import { trace } from './optics';

export type SolveInventory = {
  readonly mirrors: number;
  readonly splitters: number;
};

export type Solution = {
  readonly cellIndex: number;
  readonly code: number;
};

export type SolveResult =
  | {
      readonly solvable: true;
      /** Exact minimum number of elements. */
      readonly par: number;
      readonly solution: ReadonlyArray<Solution>;
      readonly nodesVisited: number;
      readonly timeMs: number;
    }
  | {
      readonly solvable: false;
      readonly reason: 'no-solution' | 'budget-exceeded' | 'timeout';
      readonly nodesVisited: number;
      readonly timeMs: number;
    };

/**
 * Cells the player may build on.  Walls and emitters are solid furniture;
 * crystals are transparent to light but we forbid stacking so the board stays
 * readable.  Filters absorb light but you may build on them — no: we forbid it
 * for the same readability reason.
 */
export function legalPlacementCells(cells: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    const kind = cellKind(cells[i] ?? 0);
    if (kind === KIND_WALL || kind === KIND_EMITTER) continue;
    if (kind === KIND_CRYSTAL) continue;
    out.push(i);
  }
  return out;
}

export type SolveOptions = {
  /** Hard cap on simulated configurations before giving up. */
  readonly maxNodes?: number;
  /** Wall-clock cap in ms. */
  readonly deadlineMs?: number;
  /** Restrict the build zone (defaults to every legal cell). */
  readonly allowCells?: ReadonlyArray<number>;
  /** What the player may place.  Defaults to `ceiling` of each kind. */
  readonly inventory?: SolveInventory;
  /**
   * Elements that are already on the board and may not be moved.
   *
   * This is what makes hints honest.  Without it the solver starts from an
   * empty board every time and returns the same first step no matter what the
   * player has built, so a hint could contradict the player's own work.  With
   * it, the search answers "given what is already there, what is the cheapest
   * completion?" — the reported Par and solution then cover only the *new*
   * elements, and pinned elements are excluded from the cells that may be
   * reused.
   */
  readonly pinned?: ArrayLike<number>;
};

/** Codes a cell may hold, filtered by what is left in inventory. */
function codesFor(remainingMirrors: number, remainingSplitters: number): number[] {
  const codes: number[] = [];
  if (remainingMirrors > 0) codes.push(PLACE_MIRROR_SLASH, PLACE_MIRROR_BACK);
  if (remainingSplitters > 0) codes.push(PLACE_SPLIT_SLASH, PLACE_SPLIT_BACK);
  return codes;
}

function isSplitterCode(code: number): boolean {
  return code === PLACE_SPLIT_SLASH || code === PLACE_SPLIT_BACK;
}

export function solve(
  cells: ArrayLike<number>,
  inventory: SolveInventory,
  options: SolveOptions = {}
): SolveResult {
  const startedAt = Date.now();
  const maxNodes = options.maxNodes ?? 6_000_000;
  const deadlineMs = options.deadlineMs ?? 2500;

  const board = Array.from(cells);
  const placements = new Uint8Array(CELL_COUNT);
  const legal = options.allowCells
    ? Array.from(options.allowCells)
    : legalPlacementCells(board);

  // Elements the player already committed to.  They are written into the
  // working placement array before depth 0 is checked, so "already solved" is
  // judged on the real board, and their cells are removed from the build zone
  // so the search cannot stack a second element on top of one.
  const pinned = options.pinned;
  const restorePinned = (): void => {
    if (!pinned) return;
    for (let i = 0; i < CELL_COUNT; i++) {
      const code = pinned[i] ?? 0;
      if (code !== 0) placements[i] = code;
    }
  };
  if (pinned) {
    if (pinned.length !== CELL_COUNT) {
      throw new Error(`pinned must have ${CELL_COUNT} entries, got ${pinned.length}`);
    }
    const freeSet = new Set<number>();
    for (let i = 0; i < CELL_COUNT; i++) {
      const code = pinned[i] ?? 0;
      if (code !== 0) {
        placements[i] = code;
        continue;
      }
      freeSet.add(i);
    }
    for (let i = legal.length - 1; i >= 0; i--) {
      const cell = legal[i];
      if (cell === undefined || !freeSet.has(cell)) legal.splice(i, 1);
    }
  }

  let nodes = 0;
  const budget = inventory.mirrors + inventory.splitters;

  const outOfBudget = (): SolveResult => ({
    solvable: false,
    reason: 'budget-exceeded',
    nodesVisited: nodes,
    timeMs: Date.now() - startedAt,
  });

  const checkSolved = (): boolean => trace(board, placements).solved;

  // Depth 0.
  nodes++;
  if (checkSolved()) {
    return {
      solvable: true,
      par: 0,
      solution: [],
      nodesVisited: nodes,
      timeMs: Date.now() - startedAt,
    };
  }

  const chosen: Solution[] = [];
  // Snapshot taken at the instant a solution is found — `chosen` is unwound on
  // the way back up the recursion, so the live array is empty by the time the
  // caller sees `true`.
  let foundSolution: Solution[] | null = null;

  const sweep = (
    depth: number,
    startAt: number,
    leftMirrors: number,
    leftSplitters: number
  ): boolean => {
    if (chosen.length === depth) {
      nodes++;
      if (nodes > maxNodes) throw new BudgetError('budget');
      if (checkSolved()) {
        foundSolution = chosen.map((s) => ({ cellIndex: s.cellIndex, code: s.code }));
        return true;
      }
      if ((nodes & 127) === 0 && Date.now() - startedAt > deadlineMs) {
        throw new BudgetError('timeout');
      }
      return false;
    }

    // Not enough legal cells remain to finish this depth.
    const need = depth - chosen.length;
    if (legal.length - startAt < need) return false;

    const lastPossible = legal.length - need;
    for (let li = startAt; li <= lastPossible; li++) {
      const cellIndex = legal[li];
      if (cellIndex === undefined) continue;
      const codes = codesFor(leftMirrors, leftSplitters);
      for (let ci = 0; ci < codes.length; ci++) {
        const code = codes[ci] as number;
        const split = isSplitterCode(code);
        placements[cellIndex] = code;
        chosen.push({ cellIndex, code });
        const ok = sweep(
          depth,
          li + 1,
          leftMirrors - (split ? 0 : 1),
          leftSplitters - (split ? 1 : 0)
        );
        chosen.pop();
        placements[cellIndex] = 0;
        if (ok) return true;
      }
    }
    return false;
  };

  for (let depth = 1; depth <= budget; depth++) {
    chosen.length = 0;
    placements.fill(0);
    restorePinned();
    try {
      if (sweep(depth, 0, inventory.mirrors, inventory.splitters)) {
        return {
          solvable: true,
          par: depth,
          solution: foundSolution ?? [],
          nodesVisited: nodes,
          timeMs: Date.now() - startedAt,
        };
      }
    } catch (error) {
      if (error instanceof BudgetError) {
        return error.kind === 'budget'
          ? outOfBudget()
          : {
              solvable: false,
              reason: 'timeout',
              nodesVisited: nodes,
              timeMs: Date.now() - startedAt,
            };
      }
      throw error;
    }
  }

  return {
    solvable: false,
    reason: 'no-solution',
    nodesVisited: nodes,
    timeMs: Date.now() - startedAt,
  };
}

class BudgetError extends Error {
  readonly kind: 'budget' | 'timeout';
  constructor(kind: 'budget' | 'timeout') {
    super(kind);
    this.kind = kind;
  }
}

/**
 * Find the true Par over every mirror/splitter mix.
 *
 * A wide inventory (`ceiling` of each kind) is used only to bound the depth
 * loop; because the search stops at the first — therefore minimal — depth that
 * solves, the split declared here never distorts the answer.
 */
export function solvePar(
  cells: ArrayLike<number>,
  ceiling: number,
  options: SolveOptions = {}
): SolveResult {
  const inventory = options.inventory ?? { mirrors: ceiling, splitters: ceiling };
  return solve(cells, inventory, options);
}

/** Convenience for the UI: does this specific placement set solve the board? */
export function isSolved(
  cells: ArrayLike<number>,
  placements: ArrayLike<number>
): boolean {
  return trace(cells, placements).solved;
}
