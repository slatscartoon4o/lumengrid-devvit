/**
 * Community level studio.
 *
 * The killer feature for a community-minded game: let players *make* the
 * puzzle.  The studio is a small editor over the same board model — drop an
 * emitter, a crystal, some sockets, walls — and a button that calls the solver
 * on the server.  Publishing posts the level to the subreddit as a new
 * interactive post authored by the player.
 *
 * The editor deliberately refuses to publish anything the solver cannot verify,
 * so the community can never post an impossible level (which would be a
 * permanent, visible embarrassment on a subreddit).
 */

import { useCallback, useMemo, useState } from 'react';
import {
  BOARD_H,
  BOARD_W,
  CELL_COUNT,
  CH_BLUE,
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
  KIND_WALL,
  cellKind,
  encodeCell,
} from '../../shared/types';
import { api, toast } from '../lib/bridge';
import type { UgcPublishResponse, UgcVerifyResponse } from '../../shared/api';

type Brush = 'emitter' | 'crystal' | 'socket' | 'wall' | 'erase';

const COLOURS = [
  { mask: CH_RED, name: 'Red', swatch: '#ff4d63' },
  { mask: CH_GREEN, name: 'Green', swatch: '#3dffa0' },
  { mask: CH_BLUE, name: 'Blue', swatch: '#4d8dff' },
  { mask: CH_YELLOW, name: 'Yellow', swatch: '#ffd84d' },
  { mask: CH_MAGENTA, name: 'Magenta', swatch: '#e05cff' },
  { mask: CH_WHITE, name: 'White', swatch: '#f2f5ff' },
];

const DIRS = [
  { dir: DIR_RIGHT, name: '→', label: 'Right' },
  { dir: DIR_DOWN, name: '↓', label: 'Down' },
  { dir: DIR_LEFT, name: '←', label: 'Left' },
  { dir: DIR_UP, name: '↑', label: 'Up' },
];

const CELL = 44;

type Props = {
  readonly onPublished: (id: string) => void;
};

export function UgcStudio({ onPublished }: Props): React.ReactElement {
  const [cells, setCells] = useState<number[]>(() => new Array<number>(CELL_COUNT).fill(0));
  const [mounts, setMounts] = useState<number[]>([]);
  const [brush, setBrush] = useState<Brush>('emitter');
  const [mask, setMask] = useState<number>(CH_RED);
  const [dir, setDir] = useState<number>(DIR_RIGHT);
  const [title, setTitle] = useState<string>('My optical circuit');
  const [verifying, setVerifying] = useState(false);
  const [verdict, setVerdict] = useState<UgcVerifyResponse | null>(null);
  const [publishing, setPublishing] = useState(false);

  const mountSet = useMemo(() => new Set(mounts), [mounts]);

  const paint = useCallback(
    (index: number) => {
      setVerdict(null);
      setCells((prev) => {
        const next = prev.slice();
        if (brush === 'erase') {
          next[index] = 0;
          return next;
        }
        if (brush === 'socket') {
          next[index] = 0;
          return next;
        }
        if (brush === 'emitter') next[index] = encodeCell(KIND_EMITTER, dir, mask);
        else if (brush === 'crystal') next[index] = encodeCell(KIND_CRYSTAL, mask, 0);
        else if (brush === 'wall') next[index] = encodeCell(KIND_WALL, 0, 0);
        return next;
      });

      setMounts((prev) => {
        const has = prev.includes(index);
        if (brush === 'socket') {
          if (has) return prev.filter((c) => c !== index);
          return [...prev, index];
        }
        // Anything other than a socket clears the socket flag on that cell.
        if (has) return prev.filter((c) => c !== index);
        return prev;
      });
    },
    [brush, dir, mask]
  );

  const verify = useCallback(async () => {
    setVerifying(true);
    try {
      const result = await api<UgcVerifyResponse>('/ugc/verify', {
        method: 'POST',
        body: JSON.stringify({ cells, mounts, title }),
      });
      setVerdict(result);
      if (result.valid) toast(`Verified — par ${result.par}`);
      else toast(result.reason);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'verification failed');
    } finally {
      setVerifying(false);
    }
  }, [cells, mounts, title]);

  const publish = useCallback(async () => {
    setPublishing(true);
    try {
      const result = await api<UgcPublishResponse>('/ugc/publish', {
        method: 'POST',
        body: JSON.stringify({ cells, mounts, title }),
      });
      if (result.published) {
        toast('Posted your level to the subreddit!');
        onPublished(result.id);
      } else {
        toast(result.message);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'publish failed');
    } finally {
      setPublishing(false);
    }
  }, [cells, mounts, title, onPublished]);

  const clearAll = useCallback(() => {
    setCells(new Array<number>(CELL_COUNT).fill(0));
    setMounts([]);
    setVerdict(null);
  }, []);

  return (
    /**
     * Phone: brushes, grid, then the action row — one readable column.
     * Desktop: the grid takes the wide column and every control moves to a
     * side rail, so the whole studio fits an 800px-tall window without
     * scrolling while the player is actually drawing.
     */
    <div
      className="flex flex-col gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_290px] lg:items-start"
      data-testid="ugc-studio"
    >
      <div className="lg:col-start-1 lg:row-start-1">
        <div className="overflow-hidden rounded-xl border border-white/8 bg-[#05060a] p-1.5">
          <div
            className="grid touch-manipulation"
            style={{ gridTemplateColumns: `repeat(${BOARD_W}, minmax(0, 1fr))` }}
            role="grid"
            aria-label="Level editor"
          >
            {Array.from({ length: CELL_COUNT }, (_, index) => {
              const code = cells[index] ?? 0;
              const kind = cellKind(code);
              const isSocket = mountSet.has(index);
              return (
                <button
                  key={index}
                  type="button"
                  className={`relative aspect-square border border-white/4 transition-colors ${
                    isSocket ? 'bg-[#7ee0ff]/10' : 'bg-white/[0.015] hover:bg-white/[0.05]'
                  }`}
                  onClick={() => paint(index)}
                  aria-label={`cell ${index % BOARD_W + 1}, ${Math.floor(index / BOARD_W) + 1}`}
                >
                  {isSocket && (
                    <span className="pointer-events-none absolute inset-[18%] rounded-[4px] border border-dashed border-[#7ee0ff]/60" />
                  )}
                  {kind === KIND_EMITTER && (
                    <span
                      className="pointer-events-none absolute inset-[22%] rounded-full"
                      style={{
                        background: COLOURS.find((c) => c.mask === ((code >> 6) & 7))?.swatch ?? '#fff',
                        opacity: 0.9,
                      }}
                    />
                  )}
                  {kind === KIND_CRYSTAL && (
                    <span
                      className="pointer-events-none absolute inset-[26%] rotate-45"
                      style={{ background: COLOURS.find((c) => c.mask === ((code >> 3) & 7))?.swatch ?? '#fff' }}
                    />
                  )}
                  {kind === KIND_WALL && <span className="pointer-events-none absolute inset-[20%] rounded-[3px] bg-white/12" />}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 lg:col-start-2 lg:row-start-1">
        <div className="rounded-xl border border-white/8 bg-white/[0.025] p-3">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {(
              [
                ['emitter', '◉ Emitter'],
                ['crystal', '◆ Crystal'],
                ['socket', '⌷ Socket'],
                ['wall', '▨ Wall'],
                ['erase', '⌫ Erase'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`btn px-2.5 py-1 text-[11px] ${brush === value ? 'border-[#7ee0ff]/60 bg-[#7ee0ff]/12 text-[#c9f3ff]' : ''}`}
                aria-pressed={brush === value}
                onClick={() => setBrush(value)}
                data-testid={`brush-${value}`}
              >
                {label}
              </button>
            ))}
          </div>

          {brush === 'emitter' && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-white/40">Aim</span>
              {DIRS.map((d) => (
                <button
                  key={d.dir}
                  type="button"
                  className={`btn h-7 w-7 justify-center p-0 text-xs ${dir === d.dir ? 'border-[#7ee0ff]/60 text-[#c9f3ff]' : ''}`}
                  aria-label={d.label}
                  onClick={() => setDir(d.dir)}
                >
                  {d.name}
                </button>
              ))}
            </div>
          )}

          {(brush === 'emitter' || brush === 'crystal') && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-white/40">Colour</span>
              {COLOURS.map((c) => (
                <button
                  key={c.mask}
                  type="button"
                  className={`h-6 w-6 rounded-full border-2 transition-transform ${mask === c.mask ? 'scale-110 border-white' : 'border-white/20'}`}
                  style={{ background: c.swatch }}
                  aria-label={c.name}
                  onClick={() => setMask(c.mask)}
                />
              ))}
            </div>
          )}

          <p className="text-[10px] leading-relaxed text-white/35">
            Sockets are where players may build. Aim for 3–8 sockets, then press Verify — the solver proves the level is
            beatable and finds its par.
          </p>
        </div>

        <input
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white/90 outline-none placeholder:text-white/25 focus:border-[#7ee0ff]/50"
          value={title}
          maxLength={60}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Name your level"
          aria-label="Level title"
        />

        {verdict && (
          <div
            className={`rounded-lg border px-3 py-2 text-xs ${
              verdict.valid
                ? 'border-[#3dffa0]/30 bg-[#3dffa0]/8 text-[#b6ffd8]'
                : 'border-[#ff4d63]/30 bg-[#ff4d63]/8 text-[#ffc1c8]'
            }`}
            data-testid="ugc-verdict"
          >
            {verdict.valid ? `✅ Verified — par ${verdict.par}, ${verdict.crystals} crystals` : `⚠️ ${verdict.reason}`}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button className="btn flex-1" onClick={verify} disabled={verifying} data-testid="ugc-verify">
            {verifying ? 'Solving…' : '🔍 Verify'}
          </button>
          <button className="btn btn-primary flex-1" onClick={publish} disabled={publishing} data-testid="ugc-publish">
            {publishing ? 'Posting…' : '🚀 Publish to subreddit'}
          </button>
          <button className="btn" onClick={clearAll}>
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}

export const __testing = { CELL };
void BOARD_H;
