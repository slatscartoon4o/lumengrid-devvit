/**
 * LumenGrid — shared type definitions.
 *
 * Everything in `src/shared` runs unchanged in three places: the Reddit client
 * iframe, the Devvit serverless backend, and the local preview server.  So it
 * must never import Node or browser-only modules.
 */

/** Board is a fixed 8x8 grid — small enough to reason about, big enough to be interesting. */
export const BOARD_W = 8;
export const BOARD_H = 8;
export const CELL_COUNT = BOARD_W * BOARD_H;

/**
 * Directions, in clockwise order starting at +x.
 *  0 = right (+x)   1 = down (+y)   2 = left (-x)   3 = up (-y)
 */
export const DIR_RIGHT = 0;
export const DIR_DOWN = 1;
export const DIR_LEFT = 2;
export const DIR_UP = 3;

export const DX = [1, 0, -1, 0];
export const DY = [0, 1, 0, -1];

/** Colour channels are a 3-bit mask. */
export const CH_RED = 1;
export const CH_GREEN = 2;
export const CH_BLUE = 4;
export const CH_YELLOW = CH_RED | CH_GREEN;
export const CH_MAGENTA = CH_RED | CH_BLUE;
export const CH_CYAN = CH_GREEN | CH_BLUE;
export const CH_WHITE = CH_RED | CH_GREEN | CH_BLUE;

export const CHANNEL_NAMES = ['red', 'green', 'blue'] as const;

/** Human readable name of a colour mask, used by the UI and the share card. */
export function maskName(mask: number): string {
  switch (mask) {
    case CH_RED:
      return 'Red';
    case CH_GREEN:
      return 'Green';
    case CH_BLUE:
      return 'Blue';
    case CH_YELLOW:
      return 'Yellow';
    case CH_MAGENTA:
      return 'Magenta';
    case CH_CYAN:
      return 'Cyan';
    case CH_WHITE:
      return 'White';
    default:
      return 'None';
  }
}

export function maskEmoji(mask: number): string {
  switch (mask) {
    case CH_RED:
      return '🟥';
    case CH_GREEN:
      return '🟩';
    case CH_BLUE:
      return '🟦';
    case CH_YELLOW:
      return '🟨';
    case CH_MAGENTA:
      return '🟪';
    case CH_CYAN:
      return '🟦';
    case CH_WHITE:
      return '⬜';
    default:
      return '⬛';
  }
}

/**
 * Cell kinds.  Packed into a single number per cell on the wire:
 *   `code = kind + param0 * 8 + param1 * 64`
 * with `kind < 8`, `param0 < 8`, `param1 < 8` — so every cell is a small int.
 */
export const KIND_EMPTY = 0;
export const KIND_WALL = 1;
export const KIND_EMITTER = 2;
export const KIND_FILTER = 3;
export const KIND_CRYSTAL = 4;

export function encodeCell(kind: number, param0 = 0, param1 = 0): number {
  return kind + param0 * 8 + param1 * 64;
}
export function cellKind(code: number): number {
  return code & 7;
}
export function cellParam0(code: number): number {
  return (code >> 3) & 7;
}
export function cellParam1(code: number): number {
  return (code >> 6) & 7;
}

export type PieceKind = 'mirror' | 'splitter';
export type Orient = 'slash' | 'backslash';

export type Placement = {
  readonly x: number;
  readonly y: number;
  readonly piece: PieceKind;
  readonly orient: Orient;
};

/** Compact per-cell placement code used by the simulator: 0 = empty. */
export const PLACE_NONE = 0;
export const PLACE_MIRROR_SLASH = 1;
export const PLACE_MIRROR_BACK = 2;
export const PLACE_SPLIT_SLASH = 3;
export const PLACE_SPLIT_BACK = 4;

export function placementCode(piece: PieceKind, orient: Orient): number {
  if (piece === 'mirror') return orient === 'slash' ? PLACE_MIRROR_SLASH : PLACE_MIRROR_BACK;
  return orient === 'slash' ? PLACE_SPLIT_SLASH : PLACE_SPLIT_BACK;
}

export function codeToPlacement(index: number, code: number): Placement {
  const piece: PieceKind = code <= 2 ? 'mirror' : 'splitter';
  const orient: Orient = code === 1 || code === 3 ? 'slash' : 'backslash';
  return { x: index % BOARD_W, y: Math.floor(index / BOARD_W), piece, orient };
}

/** A fully specified daily (or community) puzzle. */
export type Puzzle = {
  /** `YYYY-MM-DD` for daily puzzles, `ugc:<id>` for community levels. */
  readonly id: string;
  /** 0..6 for Mon..Sun, or the difficulty tier for UGC. */
  readonly dayIndex: number;
  readonly theme: string;
  /** Minimum number of optical elements needed to light every crystal. */
  readonly par: number;
  /** 64 packed cell codes, row-major. */
  readonly cells: number[];
  /**
   * Cells the player is allowed to build on ("optical sockets").  Restricting
   * the build zone keeps the board readable, makes Par exactly checkable, and
   * turns a 64-cell search into a 9-cell one.
   */
  readonly mounts: number[];
  /** Generator schema version — bumped whenever generation semantics change. */
  readonly version: number;
  /** Present on community levels. */
  readonly author?: string;
};

export type PuzzleSummary = {
  readonly id: string;
  readonly dayIndex: number;
  readonly theme: string;
  readonly par: number;
  readonly edition: number;
};
