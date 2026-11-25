/**
 * Spoiler-free share cards.
 *
 * The point of a share card is that someone who has not played yet can read it
 * and feel invited — so it may never reveal the solution.  It carries: the
 * puzzle number, a colour strip of what each gem needed, a Par badge, the time
 * taken and the streak.  Nothing about where the elements went.
 */

import { CH_BLUE, CH_CYAN, CH_GREEN, CH_MAGENTA, CH_RED, CH_WHITE, CH_YELLOW, Puzzle, cellKind, KIND_CRYSTAL, cellParam0, maskEmoji } from './types';
import { editionForDate } from './generator';

export type RunOutcome = {
  /** Elements the player actually placed. */
  readonly placed: number;
  /** The level's Par. */
  readonly par: number;
  /** Seconds from first tap to solve. */
  readonly seconds: number;
  /** Consecutive-day streak *including* this solve. */
  readonly streak: number;
  /** Player's personal best streak. */
  readonly best: number;
};

export type ParBadge = 'under' | 'par' | 'over';

export function parBadge(placed: number, par: number): ParBadge {
  if (placed < par) return 'under';
  if (placed === par) return 'par';
  return 'over';
}

export function parBadgeText(badge: ParBadge): string {
  if (badge === 'under') return '💎 Under Par';
  if (badge === 'par') return '⚡ Perfect Par';
  return '✨ Solved';
}

/** The colour sequence the crystals demanded — the "what was I asked for" strip. */
export function crystalPalette(puzzle: Puzzle): string[] {
  const out: string[] = [];
  for (let i = 0; i < puzzle.cells.length; i++) {
    const code = puzzle.cells[i] ?? 0;
    if (cellKind(code) !== KIND_CRYSTAL) continue;
    out.push(maskEmoji(cellParam0(code)));
  }
  return out;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

/** A compact, copy-pasteable block for the comments section. */
export function buildShareCard(puzzle: Puzzle, run: RunOutcome): string {
  const edition = editionForDate(puzzle.id);
  const badge = parBadge(run.placed, run.par);
  const palette = crystalPalette(puzzle).join('');
  const lines = [
    `🔆 LumenGrid #${String(edition).padStart(3, '0')} — ${parBadgeText(badge)}`,
    `${palette}  ·  ${run.placed}/${run.par} elements  ·  ${formatDuration(run.seconds)}`,
  ];
  if (run.streak > 1) {
    lines.push(`🔥 ${run.streak}-day streak${run.streak >= run.best ? ' (personal best!)' : ''}`);
  }
  lines.push('Can you light every gem with fewer?');
  return lines.join('\n');
}

/** Same content, one line, for tight UI spots such as toasts. */
export function buildShareLine(puzzle: Puzzle, run: RunOutcome): string {
  const edition = editionForDate(puzzle.id);
  const badge = parBadge(run.placed, run.par);
  const emoji = badge === 'under' ? '💎' : badge === 'par' ? '⚡' : '✨';
  return `LumenGrid #${String(edition).padStart(3, '0')} ${emoji} ${run.placed}/${run.par} elements in ${formatDuration(run.seconds)}`;
}

/** Structured payload for the API/client, kept separate from prose. */
export type SharePayload = {
  readonly edition: number;
  readonly date: string;
  readonly placed: number;
  readonly par: number;
  readonly seconds: number;
  readonly streak: number;
  readonly badge: ParBadge;
  readonly palette: string[];
  readonly text: string;
};

export function buildSharePayload(puzzle: Puzzle, run: RunOutcome): SharePayload {
  return {
    edition: editionForDate(puzzle.id),
    date: puzzle.id,
    placed: run.placed,
    par: run.par,
    seconds: run.seconds,
    streak: run.streak,
    badge: parBadge(run.placed, run.par),
    palette: crystalPalette(puzzle),
    text: buildShareCard(puzzle, run),
  };
}

/**
 * Percentage of today's players you beat, derived from a placement histogram.
 * Beating someone means using *fewer* elements (ties count as "ahead of" for a
 * generous, Reddit-friendly feel).
 */
export function percentileFromHistogram(histogram: ReadonlyArray<number>, yourValue: number): number {
  let total = 0;
  let better = 0;
  for (let i = 0; i < histogram.length; i++) {
    const count = histogram[i] ?? 0;
    total += count;
    if (i >= yourValue) better += count;
  }
  if (total === 0) return 100;
  return Math.max(1, Math.min(100, Math.round((better / total) * 100)));
}

export const MASKS = { CH_RED, CH_GREEN, CH_BLUE, CH_YELLOW, CH_MAGENTA, CH_CYAN, CH_WHITE };
