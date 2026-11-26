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

/**
 * The subset of `globalThis.devvit` this bundle needs.
 *
 * Devvit injects this object into every web view.  It carries the signed
 * request token and the per-entrypoint URLs, both of which are required to
 * reach our own server: the platform rejects `/api/*` requests that do not
 * carry `?token=<devvit.token>` (they come back 401 "missing authorization
 * header"), and the entrypoint URL is what tells us which origin to ask.
 *
 * Absent in a local preview, where same-origin relative fetches just work.
 *
 * @see node_modules/@devvit/shared-types/client/devvit-global.d.ts
 */
type DevvitRuntime = {
  token?: string;
  entrypoints?: Record<string, string>;
};

declare global {
  interface Window {
    // Provided by Devvit at runtime; absent in a local preview.
    devvit?: DevvitRuntime;
  }
}

/** Devvit's runtime object, if we are inside a real Reddit web view. */
function devvitRuntime(): DevvitRuntime | undefined {
  return typeof window === 'undefined' ? undefined : window.devvit;
}

/**
 * Origin that serves our `/api/*` routes.
 *
 * Inside Reddit the web view can be hosted on a different origin than the app
 * server, so a bare relative fetch hits the wrong host and comes back 401
 * "missing authorization header" — the failure the first playtest deploy
 * produced.  The entrypoint URLs Devvit hands us are on the app server, so any
 * one of them gives us the right origin.
 *
 * `devvit.entrypoints` can legitimately be `{}`: `@devvit/web-view-scripts`
 * builds it as `clientData?.appConfig?.entrypoints ?? {}`.  Falling straight
 * back to `window.location.origin` there would recreate the bug in exactly the
 * case we are guarding against, so when we know we are inside Reddit but were
 * given no entrypoints, we return `undefined` and let the caller decide.
 */
function apiOrigin(): string | undefined {
  const entrypoints = devvitRuntime()?.entrypoints;
  if (entrypoints) {
    for (const url of Object.values(entrypoints)) {
      try {
        return new URL(url, window.location.href).origin;
      } catch {
        // Try the next one.
      }
    }
  }
  // A local preview has no `devvit` global at all, and there same-origin
  // relative fetches are correct.
  return devvitRuntime() ? undefined : window.location.origin;
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

/** Build the absolute URL for an `/api/*` path, carrying Devvit's request token. */
function apiUrl(path: string): string {
  // `path` may already carry its own query string; let URL parse it, then add
  // Devvit's token alongside whatever the caller asked for.
  const origin = apiOrigin();
  const url = origin ? new URL(`/api${path}`, origin) : new URL(`/api${path}`, window.location.href);
  // Only needed when Devvit gave us one; a local preview has no token and the
  // dev server does not ask for it.
  const token = devvitRuntime()?.token;
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

/** Fetch helper that always returns parsed JSON or throws a readable error. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
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
