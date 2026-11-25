/**
 * Synthesised sound.
 *
 * Every cue is a few oscillators and an envelope — no audio files, which means
 * zero download weight inside the feed and no licensing surface.  The palette is
 * a pentatonic scale so any two sounds the game plays at once are consonant,
 * and a crystal igniting lifts the pitch by one scale degree: the whole board
 * resolving is a chord rather than a jingle.
 *
 * Audio is created lazily on first user gesture (mobile browsers block
 * `AudioContext` until then) and can be muted, which is persisted per browser.
 */

const SCALE = [0, 2, 4, 7, 9]; // major pentatonic semitone offsets
const BASE = 523.25; // C5

type Cue =
  | { kind: 'place'; crystal?: boolean }
  | { kind: 'rotate' }
  | { kind: 'remove' }
  | { kind: 'victory' }
  | { kind: 'error' }
  | { kind: 'ui' };

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = readMuted();
let ignited = 0;

function readMuted(): boolean {
  try {
    return window.localStorage.getItem('lumengrid:muted') === '1';
  } catch {
    return false;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(next: boolean): void {
  muted = next;
  try {
    window.localStorage.setItem('lumengrid:muted', next ? '1' : '0');
  } catch {
    // Storage may be unavailable in a private window; the in-memory flag still
    // works for the session.
  }
  if (master && ctx) {
    master.gain.setTargetAtTime(next ? 0 : 0.9, ctx.currentTime, 0.02);
  }
}

export function toggleMuted(): boolean {
  setMuted(!muted);
  return muted;
}

function ensureContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function note(freq: number, start: number, duration: number, gain: number, type: OscillatorType = 'sine'): void {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0, start);
  env.gain.linearRampToValueAtTime(gain, start + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(env);
  env.connect(master);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function semi(degrees: number): number {
  const octave = Math.floor(degrees / SCALE.length);
  const step = SCALE[((degrees % SCALE.length) + SCALE.length) % SCALE.length] ?? 0;
  return BASE * Math.pow(2, octave + step / 12);
}

export function play(cue: Cue): void {
  const audio = ensureContext();
  if (!audio || muted) return;
  const now = audio.currentTime;

  switch (cue.kind) {
    case 'place':
      if (cue.crystal) {
        // A crystal just came alive: climb the scale.
        const degree = Math.min(ignited, 9);
        ignited++;
        note(semi(degree), now, 0.5, 0.16, 'triangle');
        note(semi(degree) * 2, now + 0.02, 0.32, 0.06, 'sine');
      } else {
        note(196, now, 0.1, 0.1, 'triangle');
      }
      break;
    case 'rotate':
      note(392, now, 0.07, 0.07, 'square');
      break;
    case 'remove':
      note(147, now, 0.1, 0.08, 'triangle');
      break;
    case 'victory': {
      ignited = 0;
      const chord = [0, 2, 4, 7];
      chord.forEach((degree, index) => {
        note(semi(degree + 5), now + index * 0.055, 0.9, 0.1, 'triangle');
        note(semi(degree + 5) * 2, now + index * 0.055 + 0.01, 0.6, 0.035, 'sine');
      });
      note(semi(12), now + 0.25, 1.4, 0.05, 'sine');
      break;
    }
    case 'error':
      note(174, now, 0.12, 0.09, 'sawtooth');
      note(155, now + 0.08, 0.16, 0.07, 'sawtooth');
      break;
    case 'ui':
      note(659, now, 0.05, 0.04, 'sine');
      break;
  }
}

/** Called when the board resets so the next crystal starts the scale over. */
export function resetScale(): void {
  ignited = 0;
}

/** Warm up audio during a real click so the first sound is not delayed. */
export function prime(): void {
  ensureContext();
}
