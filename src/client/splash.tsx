import './index.css';

import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { InitResponse } from '../shared/api';
import { api, expandGame } from './lib/bridge';
import { prime } from './lib/audio';
import { BoardThumbnail } from './components/OpticsBoard';

/**
 * The feed card.
 *
 * This is the first — and often only — thing most Redditors will ever see, so it
 * has to do three jobs in roughly 640px of height:
 *
 *   1. show a *live* board with beams already running, so the game looks alive
 *      before anyone taps;
 *   2. say what the puzzle is in one line (par, edition, theme);
 *   3. give one obvious button to open the full game.
 *
 * It stays light: no audio, no timer, no solver — just the init payload and the
 * board renderer.
 */
export function Splash(): React.ReactElement {
  const [init, setInit] = useState<InitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<InitResponse>('/init');
        setInit(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'could not load the puzzle');
      }
    })();
  }, []);

  const edition = init ? String(init.summary.edition).padStart(3, '0') : '···';
  const par = init?.puzzle.par ?? 0;
  const solves = init?.community.solves ?? 0;
  const streak = init?.profile.streak ?? 0;

  const blurb = useMemo(() => (init ? init.puzzle.theme : 'Loading today\'s light…'), [init]);

  return (
    <div className="mx-auto flex min-h-[560px] w-full max-w-[640px] flex-col justify-between px-4 py-4 sm:min-h-[600px]" data-testid="splash">
      <div>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-[7px] bg-gradient-to-br from-[#7ee0ff] to-[#ffd591] text-[13px] font-black text-[#06121a]">
              L
            </span>
            <span className="text-[13px] font-semibold tracking-tight text-white">LumenGrid</span>
          </div>
          <span className="eyebrow numeric">#{edition}</span>
        </div>

        {error ? (
          <div className="slab rounded-xl p-4 text-center" role="alert">
            <p className="text-sm text-[#ffc1c8]">LumenGrid could not load</p>
            <p className="mt-1 text-[11px] text-white/40">{error}</p>
          </div>
        ) : !init ? (
          <div className="slab animate-pulse rounded-xl" style={{ height: 300 }} data-testid="splash-loading" />
        ) : (
          <div className="grid grid-cols-[1fr_auto] items-center gap-3">
            <div className="min-w-0">
              <h2 className="text-[19px] font-semibold leading-tight tracking-tight text-white">
                Light every crystal
              </h2>
              <p className="mt-0.5 truncate text-[11px] text-white/45">{blurb}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Pill label="Par" value={String(par)} />
                <Pill label="Solved" value={`${solves}`} />
                {streak > 0 && <Pill label="Streak" value={`${streak}d`} tone="amber" />}
              </div>
            </div>
            <div className="board-frame shrink-0" style={{ width: 150 }}>
              <BoardThumbnail puzzle={init.puzzle} size={150} />
            </div>
          </div>
        )}
      </div>

      {init && (
        <div className="mt-3 space-y-2">
          <div className="grid grid-cols-3 gap-1.5">
            <MiniStat label="Elements" value={`≤${par}`} />
            <MiniStat label="Today" value={`${solves}`} />
            <MiniStat label="Your best" value={init.profile.bestStreak > 0 ? `${init.profile.bestStreak}d` : '—'} />
          </div>
          <button
            className="btn btn-primary w-full py-2.5 text-sm"
            onClick={(event) => {
              prime();
              expandGame(event);
            }}
            data-testid="play-button"
          >
            ▶ Play today&apos;s puzzle
          </button>
          <p className="text-center text-[10px] text-white/30">
            {init.profile.hasPlayedToday
              ? 'Already solved today · Replay to beat par, or explore the Archive'
              : 'One puzzle a day · everyone plays the same board'}
          </p>
        </div>
      )}
    </div>
  );
}

function Pill({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'amber';
}): React.ReactElement {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${
        tone === 'amber' ? 'border-[#ffd591]/30 bg-[#ffd591]/10 text-[#ffe0b8]' : 'border-white/10 bg-white/5 text-white/65'
      }`}
    >
      <span className="opacity-55">{label}</span>
      <span className="numeric font-semibold">{value}</span>
    </span>
  );
}

function MiniStat({ label, value }: { readonly label: string; readonly value: string }): React.ReactElement {
  return (
    <div className="slab-inset rounded-lg px-2 py-1.5 text-center">
      <div className="numeric text-[13px] font-semibold leading-tight text-white/90">{value}</div>
      <div className="text-[9px] uppercase tracking-wider text-white/35">{label}</div>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<Splash />);
}
