/**
 * The bridge to the Reddit host.
 *
 * Inside Reddit the page runs in an iframe with a `window.parent` that
 * implements Devvit's client message protocol.  In a plain browser there is no
 * parent, so every call degrades into a local behaviour — that is what lets the
 * exact same bundle run for the Playwright showcase and for a judge who just
 * opens `npm run preview`.
 *
 * This file is the *only* place the client talks to `@devvit/web/client`.
 */

import { showToast as devvitShowToast, requestExpandedMode } from '@devvit/web/client';

declare global {
  interface Window {
    // Provided by Devvit at runtime; absent in a local preview.
    __DEVIT__?: unknown;
  }
}

/** True when we are inside a real Reddit post rather than a local preview. */
export function isReddit(): boolean {
  try {
    return window.parent !== window && typeof window.parent !== 'undefined';
  } catch {
    // Cross-origin parent access throws — which still means we are embedded.
    return true;
  }
}

/** Where to send the player when they should see the full game. */
const GAME_URL = '/game.html';

/**
 * Open the expanded (full-screen) game view.
 *
 * `requestExpandedMode` must be called from inside a real user gesture *and*
 * with the native event, so callers pass whatever they have.  Anything that is
 * not an event (missing, or a synthetic one) falls back to a plain navigation,
 * which is exactly what the local preview needs.
 */
export function expandGame(event?: Event | { nativeEvent?: Event } | null): void {
  if (isReddit()) {
    const native =
      event && 'nativeEvent' in event && event.nativeEvent instanceof Event
        ? event.nativeEvent
        : event instanceof Event
          ? event
          : null;
    if (native instanceof MouseEvent) {
      try {
        requestExpandedMode(native, 'game');
        return;
      } catch {
        // Hosts can reject this outside a true gesture; fall through.
      }
    }
  }
  window.location.assign(GAME_URL);
}

/** Toast that works in both worlds. */
export function toast(text: string): void {
  if (isReddit()) {
    try {
      devvitShowToast(text);
      return;
    } catch {
      // Fall through.
    }
  }
  pushLocalToast(text);
}

type ToastListener = (text: string) => void;
const listeners = new Set<ToastListener>();

export function onToast(listener: ToastListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function pushLocalToast(text: string): void {
  for (const listener of listeners) listener(text);
}

/** Copy text, with a graceful fallback for browsers that refuse the clipboard. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // execCommand still works in more embedded contexts than the async API.
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Fetch helper that always returns parsed JSON or throws a readable error. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`server returned non-JSON (${response.status}): ${text.slice(0, 120)}`);
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `request failed (${response.status})`;
    throw new Error(message);
  }
  return parsed as T;
}
