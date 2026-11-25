/**
 * Leaderboard panel.
 *
 * Three things a Redditor wants to know after solving: where they rank, how
 * today's distribution looks, and how their own streak is doing.  The histogram
 * here is interactive — clicking a bar says what that many elements bought you —
 * because a static chart on a daily puzzle invites the question and then ignores
 * it.
 */

import { useMemo, useState } from 'react';
import type { CommunityStats, Profile } from '../../shared/api';
import type { Puzzle } from '../../shared/types';
import { percentileFromHistogram } from '../../shared/share';

type Props = {
  readonly puzzle: Puzzle;
  readonly community: CommunityStats;
  readonly profile: Profile;
};

export function LeaderboardPanel({ puzzle, community, profile }: Props): React.ReactElement {
  const [selected, setSelected] = useState<number | null>(null);
  const peak = useMemo(() => Math.max(1, ...community.histogram), [community.histogram]);
  const myToday = profile.recent.find((row) => row.par === puzzle.par)?.placed ?? null;

  // Explicit pixel heights — see the same note in VictoryModal.  A percentage
  // height inside a `flex flex-col` whose own height depends on its children
  // resolves to zero, which silently blanks the whole chart.
  const TRACK_PX = 62;
  const barPx = (count: number): number =>
    count === 0 ? 2 : Math.max(6, Math.round((count / peak) * TRACK_PX));

  return (
    /**
     * Phone: one column — the numbers, then the chart, then the names.
     * Desktop: two columns, because a 10-row solver list and a chart stacked on
     * top of each other push the last row off an 800px screen, and the whole
     * point of this panel is that the ranking is visible at a glance.
     */
    <div
      className="flex flex-col gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start"
      data-testid="leaderboard-panel"
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Streak" value={profile.streak} suffix={profile.streak === 1 ? 'day' : 'days'} accent="amber" />
          <Stat label="Best" value={profile.bestStreak} suffix={profile.bestStreak === 1 ? 'day' : 'days'} />
          <Stat label="Solved" value={profile.totalSolved} suffix="total" />
        </div>

        <div className="rounded-xl border border-white/8 bg-white/[0.025] p-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="eyebrow">Today's distribution</span>
            <span className="numeric text-xs text-white/40">{community.solves} solvers</span>
          </div>
          <div className="flex items-end gap-1.5" data-testid="leaderboard-histogram">
            {community.histogram.map((count, index) => {
              const isMine = myToday === index;
              const isSelected = selected === index;
              return (
                <button
                  key={index}
                  type="button"
                  onClick={() => setSelected(isSelected ? null : index)}
                  className="group flex flex-1 flex-col items-center justify-end gap-1"
                  style={{ height: TRACK_PX + 20 }}
                  aria-label={`${count} players used ${index} elements${isMine ? ' — that is you' : ''}`}
                >
                  <span className="numeric text-[9px] text-white/0 transition-colors group-hover:text-white/55">
                    {count}
                  </span>
                  <div
                    className={`w-full rounded-t-[3px] transition-colors ${
                      isMine
                        ? 'bg-[#ffd591]'
                        : isSelected
                          ? 'bg-[#7ee0ff]'
                          : 'bg-[#7ee0ff]/35 group-hover:bg-[#7ee0ff]/60'
                    }`}
                    style={{ height: `${barPx(count)}px` }}
                    data-testid="leaderboard-bar"
                    data-bar-count={count}
                  />
                  <span className={`numeric text-[10px] ${isMine ? 'text-[#ffd591]' : 'text-white/35'}`}>{index}</span>
                </button>
              );
            })}
          </div>
          {selected !== null && (
            <p className="mt-2 rounded-lg bg-black/35 px-2.5 py-1.5 text-[11px] leading-relaxed text-white/65">
              Using <span className="font-semibold text-white">{selected}</span> elements would beat{' '}
              <span className="font-semibold text-[#a9f3ff]">
                {percentileFromHistogram(community.histogram, selected)}%
              </span>{' '}
              of today's solvers.
            </p>
          )}
        </div>

        {profile.recent.length > 0 && (
          <div className="rounded-xl border border-white/8 bg-white/[0.025] p-3">
            <div className="eyebrow mb-2">Your recent runs</div>
            <div className="space-y-1.5">
              {profile.recent.map((row) => (
                <div key={row.date} className="flex items-center gap-2 text-xs">
                  <span className="numeric w-20 text-white/40">{row.date.slice(5)}</span>
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/8">
                    <div
                      className={`h-full rounded-full ${row.placed <= row.par ? 'bg-[#7ee0ff]' : 'bg-white/40'}`}
                      style={{ width: `${Math.min(100, (row.par / Math.max(1, row.placed)) * 100)}%` }}
                    />
                  </div>
                  <span className="numeric w-10 text-right text-white/60">
                    {row.placed}/{row.par}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-white/8 bg-white/[0.025]">
        <div className="flex items-center justify-between border-b border-white/6 px-3 py-2">
          <span className="eyebrow">Today's top solvers</span>
          <span className="numeric text-[11px] text-white/35">par {puzzle.par}</span>
        </div>
        {community.top.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-white/40">No solvers yet — be the first.</p>
        ) : (
          <ol className="divide-y divide-white/5" data-testid="leaderboard-top">
            {community.top.map((row, index) => (
              <li key={`${row.username}-${index}`} className="flex items-center gap-2.5 px-3 py-1.5">
                <span
                  className={`numeric w-5 text-center text-xs font-semibold ${
                    index === 0 ? 'text-[#ffd591]' : index === 1 ? 'text-[#d9dee8]' : index === 2 ? 'text-[#c9a17a]' : 'text-white/30'
                  }`}
                >
                  {index + 1}
                </span>
                <span
                  className={`flex-1 truncate text-sm ${
                    row.username === profile.username ? 'font-semibold text-[#a9f3ff]' : 'text-white/80'
                  }`}
                >
                  u/{row.username}
                  {row.username === profile.username && <span className="ml-1.5 text-[10px] text-white/40">you</span>}
                </span>
                <span className="numeric text-sm text-white/70">{row.placed}</span>
                <span className="text-[10px] text-white/30">elements</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  suffix,
  accent,
}: {
  readonly label: string;
  readonly value: number;
  readonly suffix: string;
  readonly accent?: 'amber';
}): React.ReactElement {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.025] px-2.5 py-2">
      <div className="eyebrow mb-0.5 text-[9px]">{label}</div>
      <div className={`numeric text-lg font-semibold leading-tight ${accent === 'amber' ? 'text-[#ffd591]' : 'text-white'}`}>
        {value}
      </div>
      <div className="text-[10px] text-white/35">{suffix}</div>
    </div>
  );
}
