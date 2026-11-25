/**
 * Victory card.
 *
 * The moment a player solves, this is the only thing between them and the
 * comments section, so it is the most important screen in the game.  It leads
 * with the badge (💎 / ⚡ / ✨), then the one number that makes a daily puzzle
 * feel social — "you beat N% of today's players" — and only then the histogram,
 * which is the part people screenshot.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Puzzle } from '../../shared/types';
import type { ParBadge } from '../../shared/share';
import { parBadgeText, formatDuration } from '../../shared/share';

type Props = {
  readonly puzzle: Puzzle;
  readonly placed: number;
  readonly badge: ParBadge;
  readonly seconds: number;
  readonly streak: number;
  readonly percentile: number;
  readonly histogram: ReadonlyArray<number>;
  readonly solves: number;
  readonly commentText: string;
  readonly busy: boolean;
  readonly onShare: () => void;
  readonly onCopy: () => void;
  readonly onClose: () => void;
  readonly onReplay: () => void;
};

const BADGE_STYLE: Record<ParBadge, { ring: string; text: string; glow: string }> = {
  under: { ring: 'border-[#8ff0ff]/60', text: 'text-[#a9f3ff]', glow: 'shadow-[0_0_70px_-18px_rgba(126,224,255,0.85)]' },
  par: { ring: 'border-[#ffd591]/60', text: 'text-[#ffdca6]', glow: 'shadow-[0_0_70px_-18px_rgba(255,195,107,0.85)]' },
  over: { ring: 'border-white/25', text: 'text-white/85', glow: 'shadow-[0_0_60px_-22px_rgba(255,255,255,0.5)]' },
};

export function VictoryModal({
  puzzle,
  placed,
  badge,
  seconds,
  streak,
  percentile,
  histogram,
  solves,
  commentText,
  busy,
  onShare,
  onCopy,
  onClose,
  onReplay,
}: Props): React.ReactElement {
  const [showCard, setShowCard] = useState(false);
  const style = BADGE_STYLE[badge];

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const peak = useMemo(() => Math.max(1, ...histogram), [histogram]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 p-3 backdrop-blur-sm sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="victory-title"
      data-testid="victory-modal"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="pop-in w-full max-w-[560px] overflow-hidden rounded-2xl border border-white/10 bg-[#0b0d15] shadow-[0_40px_120px_-40px_rgba(0,0,0,0.95)]">
        <div className={`border-b border-white/8 bg-gradient-to-b from-white/6 to-transparent px-5 pt-6 pb-5 text-center ${style.glow}`}>
          <div className="eyebrow mb-2">LumenGrid solved</div>
          <div className={`mx-auto mb-3 inline-flex items-center gap-2 rounded-full border ${style.ring} bg-white/5 px-4 py-1.5 ${style.text} text-sm font-semibold`}>
            {parBadgeText(badge)}
          </div>
          <h2 id="victory-title" className="text-xl font-semibold tracking-tight text-white sm:text-2xl">
            {placed} <span className="text-white/45">/</span> {puzzle.par} elements
          </h2>
          <p className="mt-1 text-sm text-white/55">
            {formatDuration(seconds)} · {solves} solvers today
          </p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="eyebrow">You beat</span>
              <span className="numeric text-lg font-semibold text-[#a9f3ff]">{percentile}%</span>
            </div>
            <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#7ee0ff] to-[#ffd591] transition-[width] duration-700"
                style={{ width: `${percentile}%` }}
              />
            </div>
            <div className="eyebrow mb-1.5">Element count distribution</div>
            <div className="flex h-16 items-end gap-1.5" data-testid="victory-histogram">
              {histogram.map((count, index) => {
                const isYou = index === placed;
                const height = Math.max(3, (count / peak) * 100);
                return (
                  <div key={index} className="flex flex-1 flex-col items-center gap-1">
                    <div
                      className={`w-full rounded-t-[3px] ${isYou ? 'bg-[#ffd591]' : 'bg-[#7ee0ff]/45'}`}
                      style={{ height: `${height}%` }}
                      title={`${count} players used ${index}`}
                    />
                    <span className={`numeric text-[10px] ${isYou ? 'text-[#ffd591]' : 'text-white/35'}`}>{index}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {streak > 1 && (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-[#ffd591]/25 bg-[#ffd591]/8 px-3 py-2 text-sm text-[#ffe0b8]">
              🔥 {streak}-day streak — come back tomorrow to keep it alive
            </div>
          )}

          {showCard ? (
            <div className="rounded-xl border border-white/10 bg-black/40 p-3">
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-white/85" data-testid="share-card-text">
                {commentText}
              </pre>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-white/8 px-5 py-4">
          <button className="btn btn-primary flex-1" onClick={onShare} disabled={busy} data-testid="share-comment">
            {busy ? 'Posting…' : '💬 Share to comments'}
          </button>
          <button className="btn flex-1" onClick={onCopy} data-testid="copy-card">
            📋 Copy card
          </button>
          <button className="btn" onClick={() => setShowCard((v) => !v)} aria-pressed={showCard} data-testid="victory-preview">
            {showCard ? 'Hide preview' : 'Preview'}
          </button>
          <button className="btn" onClick={onReplay}>
            ↺ Replay
          </button>
          <button className="btn btn-lumen" onClick={onClose} data-testid="victory-close">
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
