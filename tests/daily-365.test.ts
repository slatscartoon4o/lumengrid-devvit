/**
 * The 365-day acceptance test.
 *
 * This is the level-design contract, enforced in CI: for every date in the
 * shipped season, the generator must produce a genuinely solvable board whose
 * Par is exactly right and whose shape matches the weekday's theme.  If any one
 * of these drifts, players would open a dead level — the single worst failure
 * a daily game can have.
 */
import { describe, expect, it } from 'vitest';
import {
  generateDailyPuzzle,
  shiftDate,
  SEASON_START,
  SEASON_DAYS,
  WEEK,
  dayIndexForDate,
  editionForDate,
  isValidDateString,
  utcDayToDateString,
  dateToUtcDay,
} from '../src/shared/generator';
import {
  CELL_COUNT,
  KIND_CRYSTAL,
  KIND_EMITTER,
  cellKind,
} from '../src/shared/types';
import { trace } from '../src/shared/optics';
import { solvePar } from '../src/shared/solver';

const NONE = new Uint8Array(CELL_COUNT);

describe('date helpers', () => {
  it('round-trips dates', () => {
    for (const d of ['2026-01-01', '2026-02-28', '2026-12-09', '2027-10-31']) {
      expect(isValidDateString(d)).toBe(true);
      expect(utcDayToDateString(dateToUtcDay(d))).toBe(d);
    }
  });

  it('rejects malformed dates', () => {
    expect(isValidDateString('2026-13-01')).toBe(false);
    expect(isValidDateString('2026-02-30')).toBe(false);
    expect(isValidDateString('2026-1-1')).toBe(false);
    expect(isValidDateString('nope')).toBe(false);
  });

  it('maps weekday indices correctly', () => {
    // 2026-11-02 is a Monday, 2026-11-08 a Sunday.
    expect(dayIndexForDate('2026-11-02')).toBe(0);
    expect(dayIndexForDate('2026-11-08')).toBe(6);
    expect(WEEK.length).toBe(7);
  });

  it('numbers editions from the season start', () => {
    expect(editionForDate(SEASON_START)).toBe(1);
    expect(editionForDate(shiftDate(SEASON_START, 1))).toBe(2);
  });
});

describe('365-day daily puzzle sweep', () => {
  it(`generates ${SEASON_DAYS} solvable, non-trivial, theme-correct levels`, () => {
    const failures: string[] = [];
    let maxGenMs = 0;
    let slowestDate = '';

    for (let offset = 0; offset < SEASON_DAYS; offset++) {
      const date = shiftDate(SEASON_START, offset);
      const theme = WEEK[dayIndexForDate(date)];
      if (!theme) throw new Error(`no theme for ${date}`);

      const startedAt = Date.now();
      const puzzle = generateDailyPuzzle(date);
      const elapsed = Date.now() - startedAt;
      if (elapsed > maxGenMs) {
        maxGenMs = elapsed;
        slowestDate = date;
      }

      const where = `${date} (${theme.short})`;

      // --- shape -----------------------------------------------------------
      if (puzzle.cells.length !== CELL_COUNT) failures.push(`${where}: cells length`);
      if (puzzle.id !== date) failures.push(`${where}: id mismatch`);
      if (puzzle.dayIndex !== theme.index) failures.push(`${where}: dayIndex`);

      const crystals = puzzle.cells.filter((c) => cellKind(c) === KIND_CRYSTAL).length;
      const emitters = puzzle.cells.filter((c) => cellKind(c) === KIND_EMITTER).length;
      if (crystals !== theme.crystals) {
        failures.push(`${where}: ${crystals} crystals, want ${theme.crystals}`);
      }
      if (emitters < 1) failures.push(`${where}: no emitters`);

      // --- not a freebie ---------------------------------------------------
      if (trace(puzzle.cells, NONE).solved) failures.push(`${where}: solved with zero elements`);

      // --- par within the theme band ---------------------------------------
      if (puzzle.par < theme.minPar) failures.push(`${where}: par ${puzzle.par} < ${theme.minPar}`);
      if (puzzle.par > theme.maxPar) failures.push(`${where}: par ${puzzle.par} > ${theme.maxPar}`);

      // --- the published Par is the *true* minimum -------------------------
      // Re-prove it here, independently of the generator's own verification,
      // so a generator bug can never quietly publish a wrong Par.
      const proof = solvePar(puzzle.cells, theme.maxPar, {
        allowCells: puzzle.mounts,
        inventory: { mirrors: theme.maxPar, splitters: theme.maxPar },
        deadlineMs: 2500,
        maxNodes: 2_000_000,
      });
      if (!proof.solvable) {
        failures.push(`${where}: no solution found on the socket set`);
      } else if (proof.par !== puzzle.par) {
        failures.push(`${where}: published par ${puzzle.par} but solver says ${proof.par}`);
      }

      // --- the build zone is sane ------------------------------------------
      if (puzzle.mounts.length !== theme.socketCount) {
        failures.push(`${where}: ${puzzle.mounts.length} sockets, want ${theme.socketCount}`);
      }
      for (const mount of puzzle.mounts) {
        const code = puzzle.cells[mount];
        if (code === undefined) {
          failures.push(`${where}: socket out of range`);
          continue;
        }
        const kind = cellKind(code);
        if (kind === KIND_EMITTER) failures.push(`${where}: socket on an emitter`);
        if (kind === KIND_CRYSTAL) failures.push(`${where}: socket on a crystal`);
      }
    }

    expect(failures).toEqual([]);
    // A single day must generate fast enough to serve from a serverless
    // request with room to spare.
    expect(maxGenMs).toBeLessThan(1500);
    expect(slowestDate.length).toBeGreaterThan(0);
  });

  it('is deterministic: the same date always yields the same board', () => {
    for (const date of ['2026-11-02', '2026-11-08', '2027-03-17', '2027-10-31']) {
      const a = generateDailyPuzzle(date);
      const b = generateDailyPuzzle(date);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('successive days differ', () => {
    const seen = new Set<string>();
    for (let offset = 0; offset < 14; offset++) {
      const puzzle = generateDailyPuzzle(shiftDate(SEASON_START, offset));
      const key = JSON.stringify(puzzle.cells);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('every weekday has a distinct theme name', () => {
    const names = new Set(WEEK.map((d) => d.theme));
    expect(names.size).toBe(7);
  });

  it('pars rise across the week', () => {
    const average = WEEK.map((day) => (day.minPar + day.maxPar) / 2);
    expect(average[0]).toBeLessThan(average[2] as number);
    expect(average[2]).toBeLessThan(average[6] as number);
  });
});

describe('last-7-days archive', () => {
  it('every date in the archive window generates', () => {
    const today = '2026-12-09';
    for (let back = 0; back < 7; back++) {
      const date = shiftDate(today, -back);
      const puzzle = generateDailyPuzzle(date);
      expect(puzzle.id).toBe(date);
      expect(puzzle.par).toBeGreaterThanOrEqual(2);
    }
  });
});
