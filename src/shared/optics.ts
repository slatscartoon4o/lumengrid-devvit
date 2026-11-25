/**
 * LumenGrid optics engine.
 *
 * A pure, allocation-light simulator for the 8x8 optical board.
 *
 * Design notes that matter for correctness:
 *
 *  1. **Colour channels propagate independently.**  A beam is traced once per
 *     colour channel (R / G / B) and the resulting per-cell masks are OR-ed
 *     together at the end.  This is exactly the linear-superposition law real
 *     optics obeys, and it is what makes "red arrives from the left, blue
 *     arrives from above, the crystal sees magenta" fall out for free instead
 *     of needing special cases at crossings.
 *
 *  2. **The visited set is keyed on (cell, direction, channel)** — at most
 *     8 * 8 * 4 * 3 = 768 states — so any mirror loop terminates in bounded
 *     time no matter how pathological the board is.
 *
 *  3. **Splitters pass the incoming beam straight through *and* reflect it 90°.**
 *     A `\` splitter sends the through-beam down and the reflected beam right,
 *     etc.  The two outgoing beams carry the same channel(s) as the incoming.
 */

import {
  BOARD_H,
  BOARD_W,
  CELL_COUNT,
  CH_BLUE,
  CH_GREEN,
  CH_RED,
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
  PLACE_NONE,
  PLACE_SPLIT_BACK,
  PLACE_SPLIT_SLASH,
  cellKind,
  cellParam0,
  cellParam1,
} from './types';

export type CellMask = number;

/** Result of tracing every emitter once. */
export type TraceResult = {
  /** `mask[y * BOARD_W + x]` — every colour channel that reached this cell. */
  readonly lit: Uint8Array;
  /** 1 when this cell had at least one beam *enter* it (used for glow effects). */
  readonly touched: Uint8Array;
  /** A polyline per continuous beam segment, for rendering. */
  readonly segments: BeamSegment[];
  /** Number of crystals fully satisfied (mask matches requirement). */
  readonly satisfied: number;
  /** Number of crystals on the board. */
  readonly crystalCount: number;
  /** 1 when every crystal is satisfied. */
  readonly solved: boolean;
};

export type BeamSegment = {
  /** Cell coordinates (x, y) the beam traversed, in order.  Consecutive cells. */
  readonly path: ReadonlyArray<readonly [number, number]>;
  /** Colour mask of the beam along this segment. */
  readonly mask: number;
  /** Stable id so React can animate without remounting. */
  readonly id: number;
};

const STATE_COUNT = CELL_COUNT * 4 * 3;

/** Which channels this colour-channel index corresponds to. */
const CHANNEL_BIT: readonly number[] = [CH_RED, CH_GREEN, CH_BLUE];

/**
 * Reflect a direction through a mirror.
 * A `/` mirror maps right→up, down→left, left→down, up→right.
 * A `\` mirror maps right→down, down→right, left→up, up→left.
 */
function reflect(dir: number, slash: boolean): number {
  if (slash) {
    switch (dir) {
      case DIR_RIGHT:
        return DIR_UP;
      case DIR_UP:
        return DIR_RIGHT;
      case DIR_LEFT:
        return DIR_DOWN;
      default:
        return DIR_LEFT;
    }
  }
  switch (dir) {
    case DIR_RIGHT:
      return DIR_DOWN;
    case DIR_DOWN:
      return DIR_RIGHT;
    case DIR_LEFT:
      return DIR_UP;
    default:
      return DIR_LEFT;
  }
}

export function trace(
  cells: ArrayLike<number>,
  placements: ArrayLike<number>
): TraceResult {
  const lit = new Uint8Array(CELL_COUNT);
  const touched = new Uint8Array(CELL_COUNT);
  const visited = new Uint8Array(STATE_COUNT);

  const segments: BeamSegment[] = [];
  let segmentId = 0;
  let satisfied = 0;
  let crystalCount = 0;

  // Pre-scan crystals once.
  for (let i = 0; i < CELL_COUNT; i++) {
    const code = cells[i] ?? 0;
    if (cellKind(code) === KIND_CRYSTAL) crystalCount++;
  }

  for (let channel = 0; channel < 3; channel++) {
    const bit = CHANNEL_BIT[channel] ?? 0;

    for (let start = 0; start < CELL_COUNT; start++) {
      const code = cells[start] ?? 0;
      if (cellKind(code) !== KIND_EMITTER) continue;
      const emitterMask = cellParam1(code);
      if ((emitterMask & bit) === 0) continue;

      const startDir = cellParam0(code) & 3;

      // A beam starts *in* the emitter cell heading out.  The emitter cell
      // itself glows with its own channel(s).
      lit[start] = (lit[start] ?? 0) | bit;
      touched[start] = 1;

      let x = start % BOARD_W;
      let y = Math.floor(start / BOARD_W);
      let dir = startDir;

      let path: Array<readonly [number, number]> = [[x, y]];
      let guard = 0;

      for (;;) {
        if (guard++ > 4096) break; // belt-and-braces; visited set should catch this first

        const nx = x + (DX[dir] ?? 0);
        const ny = y + (DY[dir] ?? 0);

        // Leaving the board ends this beam.
        if (nx < 0 || ny < 0 || nx >= BOARD_W || ny >= BOARD_H) {
          if (path.length > 1) {
            segments.push({ path, mask: bit, id: segmentId++ });
          }
          break;
        }

        const index = ny * BOARD_W + nx;
        const stateKey = (index * 4 + dir) * 3 + channel;
        if (visited[stateKey] === 1) {
          // We have been here in this exact state before: the rest of the beam
          // is a loop we already recorded.  Stop and emit what we have.
          if (path.length > 1) {
            segments.push({ path, mask: bit, id: segmentId++ });
          }
          break;
        }
        visited[stateKey] = 1;

        const cellCode = cells[index] ?? 0;
        const kind = cellKind(cellCode);

        if (kind === KIND_WALL) {
          // Blocked immediately; the wall cell is not lit.
          if (path.length > 1) {
            segments.push({ path, mask: bit, id: segmentId++ });
          }
          break;
        }

        // Beam enters this cell.
        x = nx;
        y = ny;
        path.push([x, y] as const);
        touched[index] = 1;

        if (kind === KIND_FILTER) {
          const filterMask = cellParam0(cellCode);
          if ((filterMask & bit) === 0) {
            // This colour is absorbed by the filter.
            segments.push({ path, mask: bit, id: segmentId++ });
            break;
          }
        }

        lit[index] = (lit[index] ?? 0) | bit;

        if (kind === KIND_CRYSTAL) {
          // Crystals are transparent: the beam continues through them.
        }

        const place = placements[index] ?? PLACE_NONE;
        if (place === PLACE_MIRROR_SLASH || place === PLACE_MIRROR_BACK) {
          dir = reflect(dir, place === PLACE_MIRROR_SLASH);
          segments.push({ path, mask: bit, id: segmentId++ });
          path = [[x, y] as const];
          continue;
        }
        if (place === PLACE_SPLIT_SLASH || place === PLACE_SPLIT_BACK) {
          const slash = place === PLACE_SPLIT_SLASH;
          const reflected = reflect(dir, slash);
          segments.push({ path, mask: bit, id: segmentId++ });
          path = [[x, y] as const];
          // Queue the reflected branch by tracing it inline (iteratively).
          traceBranch(
            x,
            y,
            reflected,
            channel,
            bit,
            cells,
            placements,
            visited,
            lit,
            touched,
            segments,
            () => segmentId++
          );
          continue; // the through-beam keeps going in `dir`
        }
      }
    }
  }

  // Now that all beams are traced, count satisfied crystals.
  for (let i = 0; i < CELL_COUNT; i++) {
    const code = cells[i] ?? 0;
    if (cellKind(code) !== KIND_CRYSTAL) continue;
    const need = cellParam0(code);
    if (need !== 0 && (lit[i] ?? 0) === need) satisfied++;
  }

  return {
    lit,
    touched,
    segments,
    satisfied,
    crystalCount,
    solved: crystalCount > 0 && satisfied === crystalCount,
  };
}

/**
 * Trace a single branch (used for the reflected half of a splitter) until it
 * terminates.  Iterative to keep the stack flat.
 */
function traceBranch(
  startX: number,
  startY: number,
  startDir: number,
  channel: number,
  bit: number,
  cells: ArrayLike<number>,
  placements: ArrayLike<number>,
  visited: Uint8Array,
  lit: Uint8Array,
  touched: Uint8Array,
  segments: BeamSegment[],
  nextId: () => number
): void {
  let x = startX;
  let y = startY;
  let dir = startDir;
  let path: Array<readonly [number, number]> = [[x, y]];
  let guard = 0;

  for (;;) {
    if (guard++ > 4096) break;

    const nx = x + (DX[dir] ?? 0);
    const ny = y + (DY[dir] ?? 0);

    if (nx < 0 || ny < 0 || nx >= BOARD_W || ny >= BOARD_H) {
      if (path.length > 1) segments.push({ path, mask: bit, id: nextId() });
      return;
    }

    const index = ny * BOARD_W + nx;
    const stateKey = (index * 4 + dir) * 3 + channel;
    if (visited[stateKey] === 1) {
      if (path.length > 1) segments.push({ path, mask: bit, id: nextId() });
      return;
    }
    visited[stateKey] = 1;

    const cellCode = cells[index] ?? 0;
    const kind = cellKind(cellCode);

    if (kind === KIND_WALL) {
      if (path.length > 1) segments.push({ path, mask: bit, id: nextId() });
      return;
    }

    x = nx;
    y = ny;
    path.push([x, y] as const);
    touched[index] = 1;

    if (kind === KIND_FILTER) {
      const filterMask = cellParam0(cellCode);
      if ((filterMask & bit) === 0) {
        segments.push({ path, mask: bit, id: nextId() });
        return;
      }
    }

    lit[index] = (lit[index] ?? 0) | bit;

    const place = placements[index] ?? PLACE_NONE;
    if (place === PLACE_MIRROR_SLASH || place === PLACE_MIRROR_BACK) {
      dir = reflect(dir, place === PLACE_MIRROR_SLASH);
      segments.push({ path, mask: bit, id: nextId() });
      path = [[x, y] as const];
      continue;
    }
    if (place === PLACE_SPLIT_SLASH || place === PLACE_SPLIT_BACK) {
      const slash = place === PLACE_SPLIT_SLASH;
      const reflected = reflect(dir, slash);
      segments.push({ path, mask: bit, id: nextId() });
      path = [[x, y] as const];
      // Recurse one level: nested splitters are supported.  Depth is bounded by
      // the visited set because each state can only be entered once.
      traceBranch(
        x,
        y,
        reflected,
        channel,
        bit,
        cells,
        placements,
        visited,
        lit,
        touched,
        segments,
        nextId
      );
      continue;
    }
  }
}

/** Convenience: which crystals are satisfied / which are not. */
export type CrystalStatus = {
  readonly index: number;
  readonly need: number;
  readonly got: number;
  readonly ok: boolean;
};

export function crystalStatuses(
  cells: ArrayLike<number>,
  result: TraceResult
): CrystalStatus[] {
  const out: CrystalStatus[] = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    const code = cells[i] ?? 0;
    if (cellKind(code) !== KIND_CRYSTAL) continue;
    const need = cellParam0(code);
    const got = result.lit[i] ?? 0;
    out.push({ index: i, need, got, ok: need !== 0 && got === need });
  }
  return out;
}

/** Re-export the cell constants the renderer needs so callers import one module. */
export {
  KIND_CRYSTAL,
  KIND_EMITTER,
  KIND_FILTER,
  KIND_WALL,
  cellKind,
  cellParam0,
  cellParam1,
};

export const DIRECTIONS = { Right: DIR_RIGHT, Down: DIR_DOWN, Left: DIR_LEFT, Up: DIR_UP };
