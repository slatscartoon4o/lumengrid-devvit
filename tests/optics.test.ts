import { describe, expect, it } from 'vitest';
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
  encodeCell,
} from '../src/shared/types';
import { crystalStatuses, trace } from '../src/shared/optics';

const idx = (x: number, y: number): number => y * BOARD_W + x;
const empty = (): number[] => new Array<number>(CELL_COUNT).fill(0);

describe('optics engine', () => {
  it('trace straight line reaches the far edge', () => {
    const cells = empty();
    cells[idx(0, 3)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    const result = trace(cells, new Uint8Array(CELL_COUNT));
    expect(result.lit[idx(0, 3)]! & CH_RED).toBe(CH_RED);
    expect(result.lit[idx(7, 3)]! & CH_RED).toBe(CH_RED);
    // Nothing off the row
    expect(result.lit[idx(7, 2)]! & CH_RED).toBe(0);
  });

  it('a / mirror reflects right-going light upward', () => {
    const cells = empty();
    cells[idx(0, 5)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    const placements = new Uint8Array(CELL_COUNT);
    placements[idx(3, 5)] = PLACE_MIRROR_SLASH;
    const result = trace(cells, placements);
    expect(result.lit[idx(3, 5)]! & CH_RED).toBe(CH_RED);
    expect(result.lit[idx(3, 0)]! & CH_RED).toBe(CH_RED);
    expect(result.lit[idx(7, 5)]! & CH_RED).toBe(0);
  });

  it('a \\ mirror reflects right-going light downward', () => {
    const cells = empty();
    cells[idx(0, 1)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    const placements = new Uint8Array(CELL_COUNT);
    placements[idx(4, 1)] = PLACE_MIRROR_BACK;
    const result = trace(cells, placements);
    expect(result.lit[idx(4, 7)]! & CH_RED).toBe(CH_RED);
  });

  it('a splitter sends the beam both through and reflected', () => {
    const cells = empty();
    cells[idx(0, 4)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    const placements = new Uint8Array(CELL_COUNT);
    placements[idx(3, 4)] = PLACE_SPLIT_BACK;
    const result = trace(cells, placements);
    // Through branch continues right
    expect(result.lit[idx(7, 4)]! & CH_RED).toBe(CH_RED);
    // Reflected branch goes down
    expect(result.lit[idx(3, 7)]! & CH_RED).toBe(CH_RED);
  });

  it('a wall blocks the beam', () => {
    const cells = empty();
    cells[idx(0, 2)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(4, 2)] = encodeCell(KIND_WALL, 0, 0);
    const result = trace(cells, new Uint8Array(CELL_COUNT));
    expect(result.lit[idx(3, 2)]! & CH_RED).toBe(CH_RED);
    expect(result.lit[idx(4, 2)]! & CH_RED).toBe(0);
    expect(result.lit[idx(5, 2)]! & CH_RED).toBe(0);
  });

  it('a filter blocks a colour it does not pass', () => {
    const cells = empty();
    cells[idx(0, 2)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(4, 2)] = encodeCell(KIND_FILTER, CH_BLUE, 0);
    const result = trace(cells, new Uint8Array(CELL_COUNT));
    expect(result.lit[idx(3, 2)]! & CH_RED).toBe(CH_RED);
    // The filter itself absorbs red, so it is not lit with red.
    expect(result.lit[idx(4, 2)]! & CH_RED).toBe(0);
    expect(result.lit[idx(5, 2)]! & CH_RED).toBe(0);
  });

  it('a filter passes a colour it does allow', () => {
    const cells = empty();
    cells[idx(0, 2)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(4, 2)] = encodeCell(KIND_FILTER, CH_RED, 0);
    const result = trace(cells, new Uint8Array(CELL_COUNT));
    expect(result.lit[idx(4, 2)]! & CH_RED).toBe(CH_RED);
    expect(result.lit[idx(6, 2)]! & CH_RED).toBe(CH_RED);
  });

  it('crossing beams mix colours at the shared cell', () => {
    const cells = empty();
    cells[idx(0, 3)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(3, 0)] = encodeCell(KIND_EMITTER, DIR_DOWN, CH_BLUE);
    const result = trace(cells, new Uint8Array(CELL_COUNT));
    // (3,3) receives red from left and blue from above.
    expect(result.lit[idx(3, 3)]! & CH_RED).toBe(CH_RED);
    expect(result.lit[idx(3, 3)]! & CH_BLUE).toBe(CH_BLUE);
    expect(result.lit[idx(3, 3)]! & CH_WHITE).toBe(CH_RED | CH_BLUE);
  });

  it('a crystal is satisfied only when it receives exactly its colour', () => {
    const cells = empty();
    cells[idx(0, 3)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(5, 3)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    const result = trace(cells, new Uint8Array(CELL_COUNT));
    expect(result.solved).toBe(true);

    // Change the crystal to require blue → unsolved.
    cells[idx(5, 3)] = encodeCell(KIND_CRYSTAL, CH_BLUE, 0);
    const result2 = trace(cells, new Uint8Array(CELL_COUNT));
    expect(result2.solved).toBe(false);
  });

  it('red crystal does not accept red+green (mixed) light', () => {
    const cells = empty();
    cells[idx(0, 3)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(3, 0)] = encodeCell(KIND_EMITTER, DIR_DOWN, CH_GREEN);
    cells[idx(3, 3)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    const result = trace(cells, new Uint8Array(CELL_COUNT));
    expect(result.lit[idx(3, 3)]! & CH_YELLOW).toBe(CH_YELLOW);
    expect(result.solved).toBe(false);
  });

  it('magneta crystal accepts red+blue mixed light', () => {
    const cells = empty();
    cells[idx(0, 3)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(3, 0)] = encodeCell(KIND_EMITTER, DIR_DOWN, CH_BLUE);
    cells[idx(3, 3)] = encodeCell(KIND_CRYSTAL, CH_MAGENTA, 0);
    const result = trace(cells, new Uint8Array(CELL_COUNT));
    expect(result.solved).toBe(true);
  });

  it('a tiny mirror loop terminates quickly', () => {
    const cells = empty();
    cells[idx(3, 3)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    const placements = new Uint8Array(CELL_COUNT);
    // / then \ bounces light back and forth forever
    placements[idx(3, 4)] = PLACE_MIRROR_BACK;
    placements[idx(4, 4)] = PLACE_MIRROR_SLASH;
    placements[idx(4, 3)] = PLACE_MIRROR_BACK;
    placements[idx(3, 3)] = PLACE_NONE;
    const start = Date.now();
    const result = trace(cells, placements);
    expect(Date.now() - start).toBeLessThan(100);
    expect(result.lit[idx(4, 4)]! & CH_RED).toBe(CH_RED);
  });

  it('full four-mirror ring terminates and lights every loop cell', () => {
    const cells = empty();
    // Emitter outside the loop firing right into a mirror at (2,2).
    cells[idx(0, 2)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    const placements = new Uint8Array(CELL_COUNT);
    // Rectangular loop corners (2,2)→(2,5)→(5,5)→(5,2)→back to (2,2)
    //   right → down  at (2,2):  '\'
    //   down  → right at (2,5):  '\'
    //   right → up    at (5,5):  '/'
    //   up    → left  at (5,2):  '\'   (closes the loop)
    placements[idx(2, 2)] = PLACE_MIRROR_BACK;
    placements[idx(2, 5)] = PLACE_MIRROR_BACK;
    placements[idx(5, 5)] = PLACE_MIRROR_SLASH;
    placements[idx(5, 2)] = PLACE_MIRROR_BACK;
    const result = trace(cells, placements);
    expect(result.lit[idx(2, 2)]! & CH_RED).toBe(CH_RED);
    expect(result.lit[idx(2, 4)]! & CH_RED).toBe(CH_RED);
    expect(result.lit[idx(4, 5)]! & CH_RED).toBe(CH_RED);
    expect(result.lit[idx(5, 3)]! & CH_RED).toBe(CH_RED);
    expect(result.lit[idx(4, 2)]! & CH_RED).toBe(CH_RED);
  });

  it('nested splitters are supported', () => {
    const cells = empty();
    cells[idx(0, 4)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    const placements = new Uint8Array(CELL_COUNT);
    placements[idx(2, 4)] = PLACE_SPLIT_BACK; // through right, reflect down
    placements[idx(2, 6)] = PLACE_SPLIT_BACK; // reflect right again
    const result = trace(cells, placements);
    expect(result.lit[idx(7, 4)]! & CH_RED).toBe(CH_RED);
    expect(result.lit[idx(2, 7)]! & CH_RED).toBe(CH_RED);
    expect(result.lit[idx(7, 6)]! & CH_RED).toBe(CH_RED);
  });

  it('crystalStatuses reports the gap for each crystal', () => {
    const cells = empty();
    cells[idx(0, 1)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    cells[idx(4, 1)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    cells[idx(4, 4)] = encodeCell(KIND_CRYSTAL, CH_GREEN, 0);
    const result = trace(cells, new Uint8Array(CELL_COUNT));
    const statuses = crystalStatuses(cells, result);
    expect(statuses).toHaveLength(2);
    expect(statuses[0]?.ok).toBe(true);
    expect(statuses[1]?.ok).toBe(false);
    expect(statuses[1]?.got).toBe(0);
  });

  it('an empty board is never solved', () => {
    const cells = empty();
    const result = trace(cells, new Uint8Array(CELL_COUNT));
    expect(result.solved).toBe(false);
    expect(result.crystalCount).toBe(0);
  });

  it('an emitter with multiple colours emits all of them', () => {
    const cells = empty();
    cells[idx(0, 3)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_WHITE);
    cells[idx(6, 3)] = encodeCell(KIND_CRYSTAL, CH_WHITE, 0);
    const result = trace(cells, new Uint8Array(CELL_COUNT));
    expect(result.solved).toBe(true);
    expect(result.lit[idx(6, 3)]).toBe(CH_WHITE);
  });

  it('a filter can turn white light into a single colour', () => {
    const cells = empty();
    cells[idx(0, 3)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_WHITE);
    cells[idx(3, 3)] = encodeCell(KIND_FILTER, CH_RED, 0);
    cells[idx(6, 3)] = encodeCell(KIND_CRYSTAL, CH_RED, 0);
    const result = trace(cells, new Uint8Array(CELL_COUNT));
    expect(result.solved).toBe(true);
    expect(result.lit[idx(6, 3)]).toBe(CH_RED);
  });

  it('an emitter pointing off the board contributes nothing', () => {
    const cells = empty();
    cells[idx(0, 3)] = encodeCell(KIND_EMITTER, DIR_LEFT, CH_RED);
    const result = trace(cells, new Uint8Array(CELL_COUNT));
    expect(result.solved).toBe(false);
    // Only the emitter cell is lit (by itself, from the start of the trace).
    let litCount = 0;
    for (let i = 0; i < CELL_COUNT; i++) if ((result.lit[i] ?? 0) !== 0) litCount++;
    expect(litCount).toBeLessThanOrEqual(1);
  });

  it('the board dimensions are stable', () => {
    expect(BOARD_W).toBe(8);
    expect(BOARD_H).toBe(8);
    expect(CELL_COUNT).toBe(64);
  });

  it('cell codes round-trip', () => {
    const code = encodeCell(KIND_FILTER, CH_CYAN, 3);
    expect(cellKind(code)).toBe(KIND_FILTER);
    expect((code >> 3) & 7).toBe(CH_CYAN);
    expect((code >> 6) & 7).toBe(3);
  });

  it('a beam fully contained in a splitter loop terminates', () => {
    const cells = empty();
    cells[idx(1, 1)] = encodeCell(KIND_EMITTER, DIR_RIGHT, CH_RED);
    const placements = new Uint8Array(CELL_COUNT);
    // Build a closed 4-splitter cage around the emitter.
    placements[idx(2, 1)] = PLACE_SPLIT_BACK;
    placements[idx(2, 3)] = PLACE_SPLIT_BACK;
    placements[idx(4, 3)] = PLACE_SPLIT_SLASH;
    placements[idx(4, 1)] = PLACE_SPLIT_SLASH;
    const t0 = Date.now();
    const result = trace(cells, placements);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(result.lit[idx(2, 2)]! & CH_RED).toBe(CH_RED);
  });
});

// Re-export so this file type-checks against the constant import list.
const _unused = [DIR_UP, DIR_LEFT, DIR_DOWN];
void _unused;
