/**
 * The optical board.
 *
 * Rendering strategy: one SVG, two layers.
 *
 *   - The **underlay** draws the slab, grid, sockets and furniture.  It changes
 *     only when the puzzle or the player's placement changes.
 *   - The **beam layer** draws every traced segment as three stacked strokes:
 *     a wide soft glow, a mid saturated band, and a thin white core.  That
 *     three-stroke recipe is what makes a line read as *light* — a single
 *     coloured stroke always looks like a coloured line.
 *
 * Interaction is deliberately tolerant: a tap on a socket places the currently
 * selected element, a tap on an existing element rotates it, and a tap with the
 * eraser removes it.  Every affordance is also reachable by keyboard, because a
 * puzzle that stops at "mouse only" is not really accessible.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  BOARD_H,
  BOARD_W,
  CH_BLUE,
  CH_GREEN,
  CH_RED,
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
  cellParam0,
  cellParam1,
  maskName,
} from '../../shared/types';
import type { Puzzle } from '../../shared/types';
import { crystalStatuses, trace } from '../../shared/optics';

const CELL = 56;
const PAD = 18;
const SIZE = BOARD_W * CELL + PAD * 2;

const COLOUR: Record<number, string> = {
  [CH_RED]: '#ff4d63',
  [CH_GREEN]: '#3dffa0',
  [CH_BLUE]: '#4d8dff',
  [CH_RED | CH_GREEN]: '#ffd84d',
  [CH_RED | CH_BLUE]: '#e05cff',
  [CH_GREEN | CH_BLUE]: '#3fe8e0',
  [CH_RED | CH_GREEN | CH_BLUE]: '#ffffff',
};

export type Tool = 'mirror' | 'splitter' | 'erase';

type Props = {
  readonly puzzle: Puzzle;
  readonly placements: Uint8Array;
  readonly tool: Tool;
  readonly onPlace: (cellIndex: number, code: number) => void;
  readonly onRemove: (cellIndex: number) => void;
  readonly hintCell: number | null;
  readonly disabled?: boolean;
  readonly showSolutionOnSockets?: boolean;
};

const cx = (x: number): number => PAD + x * CELL + CELL / 2;
const cy = (y: number): number => PAD + y * CELL + CELL / 2;

/** Turn a path of cell indices into an SVG polyline, entering from `entryDir`. */
function pathData(path: ReadonlyArray<readonly [number, number]>, previous: { x: number; y: number } | null): string {
  if (path.length === 0) return '';
  const parts: string[] = [];
  const first = path[0];
  if (!first) return '';
  const start = previous ? { x: cx(previous.x), y: cy(previous.y) } : { x: cx(first[0]), y: cy(first[1]) };
  parts.push(`M ${start.x} ${start.y}`);
  for (const [x, y] of path) {
    parts.push(`L ${cx(x)} ${cy(y)}`);
  }
  return parts.join(' ');
}

/** Which direction does the beam leave a cell in? */
function exitDir(path: ReadonlyArray<readonly [number, number]>, index: number, entryDir: number): number {
  const [x, y] = path[index] ?? [0, 0];
  const next = path[index + 1];
  if (!next) return entryDir;
  const dx = next[0] - x;
  const dy = next[1] - y;
  if (dx === 1) return DIR_RIGHT;
  if (dx === -1) return DIR_LEFT;
  if (dy === 1) return DIR_DOWN;
  if (dy === -1) return DIR_UP;
  return entryDir;
}

export function OpticsBoard({
  puzzle,
  placements,
  tool,
  onPlace,
  onRemove,
  hintCell,
  disabled = false,
  showSolutionOnSockets = false,
}: Props): React.ReactElement {
  const [hover, setHover] = useState<number | null>(null);
  // `null` until the keyboard is actually used: drawing a focus ring on (0,0)
  // at first paint looks like a stray selection box on an untouched board.
  const [focused, setFocused] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const result = useMemo(() => trace(puzzle.cells, placements), [puzzle.cells, placements]);
  const statuses = useMemo(() => crystalStatuses(puzzle.cells, result), [puzzle.cells, result]);
  const socketSet = useMemo(() => new Set(puzzle.mounts), [puzzle.mounts]);

  /** Crystals that just lit up since the previous render, for the pop animation. */
  const litKeys = useMemo(
    () => statuses.map((s) => `${s.index}:${s.ok ? 1 : 0}`).join('|'),
    [statuses]
  );

  const cellFromEvent = useCallback((event: React.PointerEvent<SVGSVGElement>): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const scale = SIZE / rect.width;
    const px = (event.clientX - rect.left) * scale;
    const py = (event.clientY - rect.top) * scale;
    const gx = Math.floor((px - PAD) / CELL);
    const gy = Math.floor((py - PAD) / CELL);
    if (gx < 0 || gy < 0 || gx >= BOARD_W || gy >= BOARD_H) return null;
    return gy * BOARD_W + gx;
  }, []);

  const activate = useCallback(
    (index: number) => {
      if (disabled) return;
      const current = placements[index] ?? PLACE_NONE;
      if (tool === 'erase') {
        if (current !== PLACE_NONE) onRemove(index);
        return;
      }
      if (!socketSet.has(index)) return;
      if (current === PLACE_NONE) {
        onPlace(index, tool === 'mirror' ? PLACE_MIRROR_SLASH : PLACE_SPLIT_SLASH);
        return;
      }
      // Existing element: rotate it.  Mirrors cycle / ↔ \; splitters the same.
      const next: Record<number, number> = {
        [PLACE_MIRROR_SLASH]: PLACE_MIRROR_BACK,
        [PLACE_MIRROR_BACK]: PLACE_MIRROR_SLASH,
        [PLACE_SPLIT_SLASH]: PLACE_SPLIT_BACK,
        [PLACE_SPLIT_BACK]: PLACE_SPLIT_SLASH,
      };
      onPlace(index, next[current] ?? PLACE_NONE);
    },
    [disabled, onPlace, onRemove, placements, socketSet, tool]
  );

  const handleKey = useCallback(
    (event: React.KeyboardEvent<SVGSVGElement>) => {
      // Keyboard navigation starts from wherever the ring last was; on the very
      // first keypress it starts at the top-left.
      const from = focused ?? 0;
      const gx = from % BOARD_W;
      const gy = Math.floor(from / BOARD_W);
      const move = (dx: number, dy: number): void => {
        const nx = Math.max(0, Math.min(BOARD_W - 1, gx + dx));
        const ny = Math.max(0, Math.min(BOARD_H - 1, gy + dy));
        setFocused(ny * BOARD_W + nx);
      };
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          move(-1, 0);
          break;
        case 'ArrowRight':
          event.preventDefault();
          move(1, 0);
          break;
        case 'ArrowUp':
          event.preventDefault();
          move(0, -1);
          break;
        case 'ArrowDown':
          event.preventDefault();
          move(0, 1);
          break;
        case 'Enter':
        case ' ':
          event.preventDefault();
          activate(from);
          break;
        case 'Backspace':
        case 'Delete':
          if (focused !== null) {
            event.preventDefault();
            onRemove(focused);
          }
          break;
        default:
          break;
      }
    },
    [activate, focused, onRemove]
  );

  return (
    <div className="board-frame w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="block h-auto w-full touch-manipulation"
        role="grid"
        aria-label={`LumenGrid optical board, ${puzzle.mounts.length} build sockets, ${statuses.length} crystals`}
        tabIndex={0}
        onKeyDown={handleKey}
        onPointerDown={(event) => {
          const cell = cellFromEvent(event);
          if (cell === null) return;
          // A mouse/touch player does not need the keyboard ring; clear it so
          // the board stays clean while they play.
          setFocused(null);
          activate(cell);
        }}
        onBlur={() => setFocused(null)}
        onPointerMove={(event) => setHover(cellFromEvent(event))}
        onPointerLeave={() => setHover(null)}
        data-testid="optics-board"
        data-solved={result.solved ? '1' : '0'}
        data-lit-crystals={String(result.satisfied)}
        data-crystals={String(result.crystalCount)}
      >
        <defs>
          {Object.entries(COLOUR).map(([mask, colour]) => (
            <radialGradient key={mask} id={`crystal-${mask}`} cx="50%" cy="42%" r="55%">
              <stop offset="0%" stopColor={colour} stopOpacity="0.95" />
              <stop offset="55%" stopColor={colour} stopOpacity="0.4" />
              <stop offset="100%" stopColor={colour} stopOpacity="0" />
            </radialGradient>
          ))}
          <filter id="beam-blur" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="5.5" />
          </filter>
          <filter id="soft-blur" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="2.2" />
          </filter>
        </defs>

        {/* --- slab & grid --- */}
        <rect x={0} y={0} width={SIZE} height={SIZE} fill="#05060a" />
        <g stroke="rgba(255,255,255,0.045)" strokeWidth={1}>
          {Array.from({ length: BOARD_W + 1 }, (_, i) => (
            <line key={`v${i}`} x1={PAD + i * CELL} y1={PAD} x2={PAD + i * CELL} y2={PAD + BOARD_H * CELL} />
          ))}
          {Array.from({ length: BOARD_H + 1 }, (_, i) => (
            <line key={`h${i}`} x1={PAD} y1={PAD + i * CELL} x2={PAD + BOARD_W * CELL} y2={PAD + i * CELL} />
          ))}
        </g>

        {/* --- sockets --- */}
        <g>
          {puzzle.mounts.map((index) => {
            const x = cx(index % BOARD_W);
            const y = cy(Math.floor(index / BOARD_W));
            const occupied = (placements[index] ?? PLACE_NONE) !== PLACE_NONE;
            if (occupied) return null;
            const isHint = hintCell === index;
            return (
              <g key={`socket-${index}`}>
                <rect
                  x={x - CELL / 2 + 7}
                  y={y - CELL / 2 + 7}
                  width={CELL - 14}
                  height={CELL - 14}
                  rx={9}
                  fill={isHint ? 'rgba(126,224,255,0.16)' : 'rgba(126,224,255,0.045)'}
                  stroke={isHint ? 'rgba(126,224,255,0.95)' : 'rgba(126,224,255,0.34)'}
                  strokeWidth={isHint ? 2 : 1.2}
                  strokeDasharray={isHint ? '5 4' : '3 4'}
                  className={isHint ? '' : 'socket-breathe'}
                />
                <circle cx={x} cy={y} r={2.2} fill="rgba(126,224,255,0.5)" />
              </g>
            );
          })}
        </g>

        {/* --- furniture --- */}
        <g>
          {puzzle.cells.map((code, index) => {
            const kind = cellKind(code);
            if (kind === 0) return null;
            const x = cx(index % BOARD_W);
            const y = cy(Math.floor(index / BOARD_W));
            if (kind === KIND_WALL) {
              return (
                <g key={`cell-${index}`}>
                  <rect
                    x={x - CELL / 2 + 2}
                    y={y - CELL / 2 + 2}
                    width={CELL - 4}
                    height={CELL - 4}
                    rx={6}
                    fill="#11141d"
                    stroke="rgba(255,255,255,0.07)"
                  />
                  <path
                    d={`M ${x - 9} ${y - 9} L ${x + 9} ${y + 9} M ${x + 9} ${y - 9} L ${x - 9} ${y + 9}`}
                    stroke="rgba(255,255,255,0.13)"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                  />
                </g>
              );
            }
            if (kind === KIND_EMITTER) {
              const dir = cellParam0(code);
              const mask = cellParam1(code);
              const colour = COLOUR[mask] ?? '#ffffff';
              const angle = [0, 90, 180, 270][dir] ?? 0;
              return (
                <g key={`cell-${index}`}>
                  <circle cx={x} cy={y} r={19} fill={colour} opacity={0.12} />
                  <circle cx={x} cy={y} r={13} fill="#0a0c13" stroke={colour} strokeWidth={2.2} />
                  <g transform={`rotate(${angle} ${x} ${y})`}>
                    <path d={`M ${x - 4} ${y - 7} L ${x + 7} ${y} L ${x - 4} ${y + 7} Z`} fill={colour} />
                  </g>
                </g>
              );
            }
            if (kind === KIND_FILTER) {
              const mask = cellParam0(code);
              const colour = COLOUR[mask] ?? '#ffffff';
              return (
                <g key={`cell-${index}`}>
                  <rect
                    x={x - CELL / 2 + 4}
                    y={y - CELL / 2 + 4}
                    width={CELL - 8}
                    height={CELL - 8}
                    rx={5}
                    fill={colour}
                    opacity={0.13}
                    stroke={colour}
                    strokeOpacity={0.6}
                    strokeWidth={1.4}
                  />
                  <text
                    x={x}
                    y={y + 4}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight={700}
                    fill={colour}
                    opacity={0.9}
                  >
                    {maskName(mask).slice(0, 3).toUpperCase()}
                  </text>
                </g>
              );
            }
            return null;
          })}
        </g>

        {/* --- crystals --- */}
        <g>
          {statuses.map((status) => {
            const x = cx(status.index % BOARD_W);
            const y = cy(Math.floor(status.index / BOARD_W));
            const need = status.need;
            const colour = COLOUR[need] ?? '#ffffff';
            const ok = status.ok;
            return (
              <g key={`crystal-${status.index}-${litKeys.length}`}>
                {ok && (
                  <circle cx={x} cy={y} r={34} fill={`url(#crystal-${need})`} className="crystal-ignite" />
                )}
                <path
                  d={`M ${x} ${y - 16} L ${x + 13} ${y} L ${x} ${y + 16} L ${x - 13} ${y} Z`}
                  fill={ok ? colour : '#0c0f16'}
                  fillOpacity={ok ? 0.85 : 1}
                  stroke={colour}
                  strokeWidth={ok ? 2 : 1.4}
                  strokeOpacity={ok ? 1 : 0.55}
                  className={ok ? '' : 'crystal-idle'}
                />
                <path
                  d={`M ${x} ${y - 16} L ${x} ${y + 16} M ${x - 13} ${y} L ${x + 13} ${y}`}
                  stroke={ok ? '#ffffff' : colour}
                  strokeOpacity={ok ? 0.5 : 0.2}
                  strokeWidth={1}
                />
              </g>
            );
          })}
        </g>

        {/* --- beams --- */}
        <g>
          {result.segments.map((segment) => {
            const points = pathData(segment.path, null);
            if (!points) return null;
            const colour = COLOUR[segment.mask] ?? '#ffffff';
            return (
              <g key={`beam-${segment.id}`}>
                <path
                  d={points}
                  fill="none"
                  stroke={colour}
                  strokeWidth={13}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.22}
                  filter="url(#beam-blur)"
                />
                <path
                  d={points}
                  fill="none"
                  stroke={colour}
                  strokeWidth={3.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.92}
                />
                <path
                  d={points}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth={1.35}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.9}
                />
                <path
                  d={points}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth={2.6}
                  strokeLinecap="round"
                  className="beam-pulse"
                  opacity={0.55}
                />
              </g>
            );
          })}
        </g>

        {/* --- placed elements --- */}
        <g>
          {Array.from(placements).map((code, index) => {
            if (code === PLACE_NONE) return null;
            const x = cx(index % BOARD_W);
            const y = cy(Math.floor(index / BOARD_W));
            const isSplitter = code === PLACE_SPLIT_SLASH || code === PLACE_SPLIT_BACK;
            const isSlash = code === PLACE_MIRROR_SLASH || code === PLACE_SPLIT_SLASH;
            const active = hover === index;
            return (
              <g key={`place-${index}`}>
                <circle
                  cx={x}
                  cy={y}
                  r={CELL / 2 - 5}
                  fill={active ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.035)'}
                  stroke={active ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)'}
                  strokeWidth={1.3}
                />
                {isSplitter && (
                  <line
                    x1={x - 15}
                    y1={y + 15}
                    x2={x + 15}
                    y2={y - 15}
                    stroke="rgba(126,224,255,0.5)"
                    strokeWidth={7}
                    strokeLinecap="round"
                    opacity={0.5}
                  />
                )}
                <line
                  x1={isSlash ? x - 14 : x - 14}
                  y1={isSlash ? y + 14 : y - 14}
                  x2={isSlash ? x + 14 : x + 14}
                  y2={isSlash ? y - 14 : y + 14}
                  stroke="#f4f7ff"
                  strokeWidth={isSplitter ? 3 : 4}
                  strokeLinecap="round"
                />
                <circle cx={x} cy={y} r={2} fill="#7ee0ff" />
              </g>
            );
          })}
        </g>

        {/* --- hint pulse --- */}
        {hintCell !== null && (
          <rect
            x={cx(hintCell % BOARD_W) - CELL / 2 + 4}
            y={cy(Math.floor(hintCell / BOARD_W)) - CELL / 2 + 4}
            width={CELL - 8}
            height={CELL - 8}
            rx={10}
            fill="none"
            stroke="#7ee0ff"
            strokeWidth={2.5}
            opacity={0.95}
          />
        )}

        {/* --- keyboard focus ring (only once the keyboard is in use) --- */}
        {focused !== null && (
          <rect
            x={cx(focused % BOARD_W) - CELL / 2 + 2}
            y={cy(Math.floor(focused / BOARD_W)) - CELL / 2 + 2}
            width={CELL - 4}
            height={CELL - 4}
            rx={10}
            fill="none"
            stroke="rgba(255,255,255,0.55)"
            strokeWidth={2}
            strokeDasharray="6 4"
            opacity={0.9}
            pointerEvents="none"
          />
        )}

        {showSolutionOnSockets && hintCell !== null && (
          <circle cx={cx(hintCell % BOARD_W)} cy={cy(Math.floor(hintCell / BOARD_W))} r={6} fill="#7ee0ff" />
        )}
      </svg>
    </div>
  );
}

/** A tiny read-only render used by the feed splash and the victory card. */
export function BoardThumbnail({
  puzzle,
  placements,
  size = 132,
}: {
  readonly puzzle: Puzzle;
  readonly placements?: Uint8Array;
  readonly size?: number;
}): React.ReactElement {
  const result = useMemo(
    () => trace(puzzle.cells, placements ?? new Uint8Array(puzzle.cells.length)),
    [puzzle.cells, placements]
  );
  const cell = SIZE / BOARD_W;
  const scale = size / SIZE;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true" className="shrink-0">
      <g transform={`scale(${1})`}>
        <rect x={0} y={0} width={SIZE} height={SIZE} rx={12} fill="#05060a" />
        <g stroke="rgba(255,255,255,0.04)">
          {Array.from({ length: BOARD_W + 1 }, (_, i) => (
            <line key={i} x1={i * cell} y1={0} x2={i * cell} y2={SIZE} />
          ))}
          {Array.from({ length: BOARD_H + 1 }, (_, i) => (
            <line key={`h${i}`} x1={0} y1={i * cell} x2={SIZE} y2={i * cell} />
          ))}
        </g>
        {result.segments.map((segment) => {
          const colour = COLOUR[segment.mask] ?? '#ffffff';
          return (
            <path
              key={segment.id}
              d={pathData(segment.path, null)}
              fill="none"
              stroke={colour}
              strokeWidth={9}
              opacity={0.55}
              strokeLinecap="round"
            />
          );
        })}
        {result.segments.map((segment) => (
          <path
            key={`core-${segment.id}`}
            d={pathData(segment.path, null)}
            fill="none"
            stroke="#ffffff"
            strokeWidth={2.4}
            opacity={0.85}
            strokeLinecap="round"
          />
        ))}
        {puzzle.cells.map((code, index) => {
          const kind = cellKind(code);
          if (kind === 0) return null;
          const x = (index % BOARD_W) * cell + cell / 2;
          const y = Math.floor(index / BOARD_W) * cell + cell / 2;
          if (kind === KIND_EMITTER) {
            const colour = COLOUR[cellParam1(code)] ?? '#fff';
            return <circle key={index} cx={x} cy={y} r={cell * 0.34} fill={colour} opacity={0.85} />;
          }
          if (kind === KIND_CRYSTAL) {
            const need = cellParam0(code);
            const colour = COLOUR[need] ?? '#fff';
            const ok = (result.lit[index] ?? 0) === need && need !== 0;
            return (
              <path
                key={index}
                d={`M ${x} ${y - cell * 0.4} L ${x + cell * 0.32} ${y} L ${x} ${y + cell * 0.4} L ${x - cell * 0.32} ${y} Z`}
                fill={ok ? colour : '#151922'}
                stroke={colour}
                strokeWidth={1.6}
                opacity={ok ? 1 : 0.7}
              />
            );
          }
          if (kind === KIND_WALL) {
            return (
              <rect
                key={index}
                x={x - cell * 0.38}
                y={y - cell * 0.38}
                width={cell * 0.76}
                height={cell * 0.76}
                rx={4}
                fill="#141821"
                opacity={0.9}
              />
            );
          }
          if (kind === KIND_FILTER) {
            const colour = COLOUR[cellParam0(code)] ?? '#fff';
            return (
              <rect
                key={index}
                x={x - cell * 0.34}
                y={y - cell * 0.34}
                width={cell * 0.68}
                height={cell * 0.68}
                rx={3}
                fill={colour}
                opacity={0.3}
                stroke={colour}
              />
            );
          }
          return null;
        })}
      </g>
      <rect x={0} y={0} width={SIZE} height={SIZE} rx={12} fill="none" stroke="rgba(255,255,255,0.08)" transform={`scale(${scale})`} />
    </svg>
  );
}

/** Exported for tests: which way a beam leaves a cell. */
export const __testing = { exitDir, pathData };
