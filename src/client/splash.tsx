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
    <div
      className="mx-auto grid h-full w-full max-w-[640px] grid-rows-[auto_minmax(0,1fr)_auto] gap-2 px-4 py-3"
      data-testid="splash"
    >
      <div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-[7px] bg-gradient-to-br from-[#7ee0ff] to-[#ffd591] text-[13px] font-black text-[#06121a]">
              L
            </span>
            <span className="text-[13px] font-semibold tracking-tight text-white">LumenGrid</span>
          </div>
          <span className="eyebrow numeric">#{edition}</span>
        </div>
      </div>

      {/*
       * The middle row is the only one that flexes.  Reddit chooses the
       * iframe height (measured: 512px on desktop, ~420 on a phone), and the
       * first version of this card hard-coded `min-h-[600px]` — so the Play
       * button sat at y=561, 49px below the frame, invisible to every judge.
       * `minmax(0,1fr)` plus `items-center` lets this row absorb whatever
       * height is left and split the slack evenly above and below, instead of
       * pushing it into one black band under the header.
       */}
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        {error ? (
          <div className="slab col-span-2 rounded-xl p-4 text-center" role="alert">
            <p className="text-sm text-[#ffc1c8]">LumenGrid could not load</p>
            <p className="mt-1 text-[11px] text-white/40">{error}</p>
          </div>
        ) : !init ? (
          <div className="slab col-span-2 animate-pulse rounded-xl" style={{ height: 120 }} data-testid="splash-loading" />
        ) : (
          <>
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
            {/*
             * A single `clamp()` feeds both axes, so the box is square by
             * construction rather than by `aspect-square`.
             *
             * `aspect-square` is not enough here: this sits in a CSS Grid
             * `auto` track, which sizes itself from the item's *intrinsic*
             * width — and `max-width: 46%` does not contribute to intrinsic
             * sizing.  Pair that with `height: 100%` and the frame renders as
             * a tall thin column (measured 110×240 at 732×512) with the board
             * floating in the middle of it.  Deriving width and height from
             * the same expression removes the chance for the two axes to
             * disagree, in any track, at any viewport.
             *
             * `38vh` is the flex term: the card's height is set by Reddit's
             * iframe, not by us, so `vh` is the only length that tracks the
             * space actually available.
             */}
            <div className="board-frame h-[clamp(116px,38vh,210px)] w-[clamp(116px,38vh,210px)] shrink-0 overflow-hidden">
              <BoardThumbnail puzzle={init.puzzle} fill />
            </div>
          </>
        )}
      </div>

      {init && (
        <div className="space-y-2">
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
