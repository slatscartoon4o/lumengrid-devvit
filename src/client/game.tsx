import './index.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CELL_COUNT,
  PLACE_MIRROR_BACK,
  PLACE_MIRROR_SLASH,
  PLACE_NONE,
  PLACE_SPLIT_BACK,
  PLACE_SPLIT_SLASH,
  Puzzle,
} from '../shared/types';
import type {
  HintResponse,
  InitResponse,
  SubmitResponse,
} from '../shared/api';
import { trace } from '../shared/optics';
import { buildShareCard, formatDuration, parBadge } from '../shared/share';
import { OpticsBoard, type Tool } from './components/OpticsBoard';
import { VictoryModal } from './components/VictoryModal';
import { LeaderboardPanel } from './components/LeaderboardPanel';
import { UgcStudio } from './components/UgcStudio';
import { api, copyText, expandGame, isReddit, onToast, toast } from './lib/bridge';
import { isMuted, play, prime, resetScale, toggleMuted } from './lib/audio';

type Tab = 'play' | 'archive' | 'create' | 'board';

const TABS: ReadonlyArray<{ id: Tab; label: string; icon: string }> = [
  { id: 'play', label: 'Today', icon: '◉' },
  { id: 'archive', label: 'Archive', icon: '🗓' },
  { id: 'create', label: 'Create', icon: '✎' },
  { id: 'board', label: 'Leaders', icon: '🏆' },
];

export function Game(): React.ReactElement {
  const [init, setInit] = useState<InitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('play');
  const [tool, setTool] = useState<Tool>('mirror');
  const [placements, setPlacements] = useState<Uint8Array>(() => new Uint8Array(CELL_COUNT));
  const [history, setHistory] = useState<Uint8Array[]>([]);
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(false);
  const [victory, setVictory] = useState<SubmitResponse | null>(null);
  const [hintCell, setHintCell] = useState<number | null>(null);
  const [hintText, setHintText] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [muted, setMutedState] = useState(isMuted());
  const [viewing, setViewing] = useState<Puzzle | null>(null);
  const [localToasts, setLocalToasts] = useState<Array<{ id: number; text: string }>>([]);
  const toastId = useRef(0);
  const submittedRef = useRef(false);

  const puzzle = viewing ?? init?.puzzle ?? null;
  const isToday = puzzle !== null && init !== null && puzzle.id === init.today;

  // --- load ---------------------------------------------------------------
  useEffect(() => {
    void (async () => {
      try {
        const data = await api<InitResponse>('/init');
        setInit(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'could not load today\'s puzzle');
      }
    })();
  }, []);

  // --- local toast surface (the Devvit toast only exists inside Reddit) ---
  useEffect(() => onToast((text) => {
    const id = toastId.current++;
    setLocalToasts((prev) => [...prev, { id, text }]);
    window.setTimeout(() => setLocalToasts((prev) => prev.filter((t) => t.id !== id)), 2600);
  }), []);

  // --- timer --------------------------------------------------------------
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const resetBoard = useCallback(() => {
    setPlacements(new Uint8Array(CELL_COUNT));
    setHistory([]);
    setHintCell(null);
    setHintText('');
    setSeconds(0);
    setRunning(false);
    setVictory(null);
    submittedRef.current = false;
    resetScale();
  }, []);

  const switchPuzzle = useCallback((next: Puzzle | null) => {
    setViewing(next);
    resetBoard();
  }, [resetBoard]);

  // --- board interaction --------------------------------------------------
  const pushHistory = useCallback((next: Uint8Array) => {
    setHistory((prev) => [...prev.slice(-40), placements]);
    setPlacements(next);
  }, [placements]);

  const onPlace = useCallback(
    (cellIndex: number, code: number) => {
      if (!puzzle || victory) return;
      prime();
      if (!running) setRunning(true);
      const next = Uint8Array.from(placements);
      next[cellIndex] = code;
      pushHistory(next);
      const before = trace(puzzle.cells, placements).satisfied;
      const after = trace(puzzle.cells, next).satisfied;
      const litNew = after > before;
      const isSplitter = code === PLACE_SPLIT_BACK || code === PLACE_SPLIT_SLASH;
      const rotated = (placements[cellIndex] ?? PLACE_NONE) !== PLACE_NONE && code !== PLACE_NONE;
      if (rotated) play({ kind: 'rotate' });
      else play({ kind: 'place', crystal: litNew });
      void isSplitter;
      if (litNew) setHintCell(null);
    },
    [placements, puzzle, pushHistory, running, victory]
  );

  const onRemove = useCallback(
    (cellIndex: number) => {
      if (!puzzle || victory) return;
      if ((placements[cellIndex] ?? PLACE_NONE) === PLACE_NONE) return;
      const next = Uint8Array.from(placements);
      next[cellIndex] = PLACE_NONE;
      pushHistory(next);
      play({ kind: 'remove' });
    },
    [placements, puzzle, pushHistory, victory]
  );

  const undo = useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last) setPlacements(last);
      return prev.slice(0, -1);
    });
    play({ kind: 'ui' });
  }, []);

  const placedCount = useMemo(() => {
    let count = 0;
    for (let i = 0; i < CELL_COUNT; i++) if ((placements[i] ?? 0) !== PLACE_NONE) count++;
    return count;
  }, [placements]);

  const live = useMemo(
    () => (puzzle ? trace(puzzle.cells, placements) : null),
    [puzzle, placements]
  );

  // --- submit when solved -------------------------------------------------
  const submit = useCallback(
    async (finalPlacements: Uint8Array) => {
      if (!puzzle) return;
      setBusy(true);
      try {
        const result = await api<SubmitResponse>('/submit', {
          method: 'POST',
          body: JSON.stringify({
            date: puzzle.id,
            placements: Array.from(finalPlacements),
            seconds,
          }),
        });
        if (result.accepted && result.solved) {
          setRunning(false);
          setVictory(result);
          play({ kind: 'victory' });
          setInit((prev) =>
            prev
              ? {
                  ...prev,
                  community: {
                    ...prev.community,
                    solves: result.solves,
                    histogram: result.histogram,
                    // The server re-read the board after writing our score, so
                    // this already includes us.  Taking it from the response
                    // rather than sorting locally keeps one ranking rule.
                    top: result.top,
                  },
                  profile: {
                    ...prev.profile,
                    streak: result.streak,
                    bestStreak: result.bestStreak,
                  },
                }
              : prev
          );
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : 'could not record your solve');
      } finally {
        setBusy(false);
      }
    },
    [puzzle, seconds]
  );

  useEffect(() => {
    if (!live?.solved || victory || !puzzle || submittedRef.current) return;
    submittedRef.current = true;
    void submit(placements);
  }, [live?.solved, placements, puzzle, submit, victory]);

  const requestHint = useCallback(async () => {
    if (!puzzle) return;
    try {
      const response = await api<HintResponse>('/hint', {
        method: 'POST',
        body: JSON.stringify({ date: puzzle.id, placements: Array.from(placements) }),
      });
      if (response.found && response.cellIndex !== null) {
        setHintCell(response.cellIndex);
        setHintText(response.message);
        toast(response.message);
      } else {
        setHintText(response.message);
        toast(response.message);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'hint unavailable');
    }
  }, [placements, puzzle]);

  const shareComment = useCallback(async () => {
    if (!puzzle || !victory || !init) return;
    setBusy(true);
    try {
      const res = await api<{ posted: boolean; text: string; message: string }>('/share-comment', {
        method: 'POST',
        body: JSON.stringify({ date: puzzle.id, placed: victory.placed, seconds }),
      });
      toast(res.posted ? 'Posted your result to the comments 💬' : res.message);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'could not post');
    } finally {
      setBusy(false);
    }
  }, [init, puzzle, seconds, victory]);

  /**
   * The share card, built once.
   *
   * The preview, the Copy button and the comment the server posts must be the
   * same string. They were three separate templates before this, and all three
   * disagreed: the server's had the edition number and crystal palette, the
   * preview had the streak and closing line, and Copy had neither. A player
   * previewed one thing, copied another, and posted a third.
   */
  const shareCardText = useMemo(() => {
    if (!puzzle || !victory) return '';
    return buildShareCard(puzzle, {
      placed: victory.placed,
      par: victory.par,
      seconds,
      streak: victory.streak,
      best: victory.bestStreak,
    });
  }, [puzzle, victory, seconds]);

  const copyCard = useCallback(async () => {
    if (!shareCardText) return;
    const ok = await copyText(shareCardText);
    toast(ok ? 'Copied to clipboard' : 'Clipboard unavailable');
  }, [shareCardText]);

  const loadArchive = useCallback(
    async (date: string) => {
      try {
        const res = await api<{ puzzle: Puzzle }>(`/puzzle/${date}`);
        switchPuzzle(res.puzzle);
        setTab('play');
        toast(`Loaded ${date}`);
      } catch (err) {
        toast(err instanceof Error ? err.message : 'could not load that day');
      }
    },
    [switchPuzzle]
  );

  // --- render -------------------------------------------------------------
  if (error) {
    return (
      <Shell>
        <div className="slab rounded-2xl p-6 text-center" role="alert">
          <p className="mb-1 text-sm font-semibold text-[#ffc1c8]">Could not start LumenGrid</p>
          <p className="text-xs text-white/50">{error}</p>
          <button className="btn mt-4" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </Shell>
    );
  }

  if (!init || !puzzle || !live) {
    return (
      <Shell>
        <div className="slab animate-pulse rounded-2xl p-6" data-testid="game-loading">
          <div className="mb-3 h-4 w-1/3 rounded bg-white/10" />
          <div className="aspect-square w-full rounded-xl bg-white/6" />
          <div className="mt-3 h-9 rounded-lg bg-white/8" />
        </div>
      </Shell>
    );
  }

  const badge = parBadge(victory?.placed ?? placedCount, puzzle.par);

  return (
    <Shell>
      {/* ---------- header ---------- */}
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-[#7ee0ff] to-[#ffd591] text-[15px] font-black text-[#06121a]">
            L
          </span>
          <div>
            <h1 className="text-[15px] font-semibold leading-tight tracking-tight text-white">LumenGrid</h1>
            <p className="text-[10px] leading-tight text-white/40">
              {viewing ? `${puzzle.dayIndex}` && `Archive · ${puzzle.id}` : `Daily optical puzzle · par ${puzzle.par}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {viewing && (
            <button className="btn px-2.5 py-1 text-[11px]" onClick={() => switchPuzzle(null)} data-testid="back-to-today">
              ← Today
            </button>
          )}
          <button
            className="btn h-8 w-8 justify-center p-0"
            onClick={() => {
              const next = toggleMuted();
              setMutedState(next);
              if (!next) play({ kind: 'ui' });
            }}
            aria-label={muted ? 'Unmute sound' : 'Mute sound'}
            aria-pressed={muted}
            data-testid="mute-toggle"
          >
            {muted ? '🔇' : '🔊'}
          </button>
        </div>
      </header>

      {/* ---------- tabs ---------- */}
      <nav className="mb-3 flex gap-1 overflow-x-auto pb-0.5" role="tablist" aria-label="Sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className="tab shrink-0"
            onClick={() => {
              setTab(item.id);
              play({ kind: 'ui' });
            }}
            data-testid={`tab-${item.id}`}
          >
            <span aria-hidden="true" className="mr-1 opacity-70">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      {tab === 'play' && (
        /**
         * Phone: one column, board first, everything else stacked under it.
         * Desktop: two columns — the board takes whatever width is left, the
         * controls sit in a fixed rail.  That is what lets an 8×8 grid use a
         * 1280px viewport instead of sitting in a phone-wide strip.
         */
        <div
          className="flex flex-col gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_252px] lg:items-start lg:gap-4"
          data-testid="panel-play"
        >
          <div className="lg:col-start-1 lg:row-start-1">
            <OpticsBoard
              puzzle={puzzle}
              placements={placements}
              tool={tool}
              onPlace={onPlace}
              onRemove={onRemove}
              hintCell={hintCell}
              disabled={Boolean(victory)}
            />
          </div>

          <div className="flex flex-col gap-2 lg:col-start-2 lg:row-start-1">
            <div className="grid grid-cols-3 gap-2 lg:grid-cols-1">
              <Metric label="Elements" value={`${placedCount}/${puzzle.par}`} tone={placedCount > puzzle.par ? 'warn' : 'normal'} />
              <Metric label="Crystals" value={`${live.satisfied}/${live.crystalCount}`} tone={live.solved ? 'good' : 'normal'} />
              <Metric label="Time" value={formatDuration(seconds)} />
            </div>

            <div className="flex flex-wrap items-center gap-1.5" data-testid="toolbar">
              {(
                [
                  ['mirror', '◤ Mirror', '◤'],
                  ['splitter', '◈ Splitter', '◈'],
                  ['erase', '⌫ Erase', '⌫'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={`btn px-2.5 py-1.5 text-[11px] ${tool === value ? 'border-[#7ee0ff]/60 bg-[#7ee0ff]/12 text-[#c9f3ff]' : ''}`}
                  aria-pressed={tool === value}
                  onClick={() => setTool(value)}
                  data-testid={`tool-${value}`}
                >
                  {label}
                </button>
              ))}
              <div className="ml-auto flex gap-1.5">
                <button className="btn px-2.5 py-1.5 text-[11px]" onClick={undo} disabled={history.length === 0} data-testid="undo">
                  ↶ Undo
                </button>
                <button className="btn px-2.5 py-1.5 text-[11px]" onClick={resetBoard} data-testid="reset">
                  ↺ Reset
                </button>
                <button className="btn btn-lumen px-2.5 py-1.5 text-[11px]" onClick={requestHint} data-testid="hint">
                  ✦ Hint
                </button>
              </div>
            </div>

            {hintText && (
              <p className="rounded-lg border border-[#7ee0ff]/25 bg-[#7ee0ff]/8 px-3 py-2 text-[11px] text-[#c9f3ff]" data-testid="hint-text">
                {hintText}
              </p>
            )}

            <p className="text-center text-[10px] leading-relaxed text-white/30 lg:text-left">
              Tap a socket to place · tap again to rotate · light every crystal
              {isToday ? ' · new puzzle at 00:00 UTC' : ''}
            </p>

            {!isReddit() && (
              <p className="text-center text-[10px] text-white/20 lg:text-left" data-testid="local-badge">
                Local preview · same engine, simulated community
              </p>
            )}
          </div>
        </div>
      )}

      {tab === 'archive' && (
        <div className="space-y-2" data-testid="panel-archive">
          <p className="eyebrow">Last seven editions</p>
          {init.archive.length === 0 && <p className="text-sm text-white/40">No earlier editions yet.</p>}
          {init.archive.map((entry) => (
            <button
              key={entry.id}
              className="slab flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
              onClick={() => void loadArchive(entry.id)}
              data-testid={`archive-${entry.id}`}
            >
              <span className="numeric grid h-9 w-12 shrink-0 place-items-center rounded-lg bg-white/6 text-sm font-semibold text-white/80">
                #{String(entry.edition).padStart(3, '0')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-white/85">{entry.theme}</span>
                <span className="block text-[10px] text-white/35">
                  {entry.id} · par {entry.par}
                </span>
              </span>
              <span className="text-white/25">›</span>
            </button>
          ))}
        </div>
      )}

      {tab === 'create' && (
        <UgcStudio
          onPublished={(id) => {
            toast(`Community level ${id} is live`);
            setTab('play');
          }}
        />
      )}

      {tab === 'board' && (
        <LeaderboardPanel puzzle={puzzle} community={init.community} profile={init.profile} />
      )}

      {victory && (
        <VictoryModal
          puzzle={puzzle}
          placed={victory.placed}
          badge={victory.badge}
          seconds={seconds}
          streak={victory.streak}
          percentile={victory.percentile}
          histogram={victory.histogram}
          solves={victory.solves}
          commentText={shareCardText}
          busy={busy}
          onShare={() => void shareComment()}
          onCopy={() => void copyCard()}
          onClose={() => setVictory(null)}
          onReplay={resetBoard}
        />
      )}

      {/* local toasts */}
      <div className="pointer-events-none fixed bottom-3 left-1/2 z-[60] flex w-[min(92vw,420px)] -translate-x-1/2 flex-col items-center gap-1.5">
        {localToasts.map((item) => (
          <div key={item.id} className="toast w-full rounded-lg px-3 py-2 text-center text-[12px] text-white/90">
            {item.text}
          </div>
        ))}
      </div>

      {badge === 'under' && !victory && placedCount > 0 && live.solved && null}
    </Shell>
  );
}

function Shell({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return (
    <div
      className="mx-auto min-h-screen w-full max-w-[560px] px-3 pb-8 pt-3 sm:px-4 lg:max-w-[900px]"
      data-testid="game-shell"
    >
      {children}
    </div>
  );
}

function Metric({
  label,
  value,
  tone = 'normal',
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'normal' | 'good' | 'warn';
}): React.ReactElement {
  const colour = tone === 'good' ? 'text-[#3dffa0]' : tone === 'warn' ? 'text-[#ffd591]' : 'text-white';
  return (
    <div className="slab-inset rounded-lg px-2.5 py-1.5">
      <div className="eyebrow text-[9px]">{label}</div>
      <div className={`numeric text-[15px] font-semibold leading-tight ${colour}`} data-testid={`metric-${label.toLowerCase()}`}>
        {value}
      </div>
    </div>
  );
}

// Keep the placement code table referenced so tree-shaking cannot drop the
// constants the engine relies on being co-located with the client.
export const __codes = { PLACE_MIRROR_SLASH, PLACE_MIRROR_BACK, PLACE_SPLIT_SLASH, PLACE_SPLIT_BACK };

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<Game />);
}

void expandGame;
