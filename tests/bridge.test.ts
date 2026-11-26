/**
 * The client-side API helper must survive Devvit's web-view auth.
 *
 * Regression: the first playtest deploy rendered "LumenGrid could not load /
 * server returned non-JSON (401): missing authorization header".  The bundle
 * fetched a bare relative `/api/...`, which both ignored Devvit's injected
 * request token and could resolve against reddit.com instead of the app server.
 *
 * Devvit authenticates web-view API calls with `?token=<globalThis.devvit.token>`
 * (see `@devvit/client/effects/web-view-mode.js`, which appends the same query
 * param to every entrypoint URL) — not with an Authorization header.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

/**
 * Minimal DOM stand-in; the module only reads `window.location`/`devvit`.
 *
 * `@devvit/client` registers its web-view message listener at import time, so
 * the real (non-stub) module needs `addEventListener` to exist on the global.
 */
function installWindow(init: {
  href: string;
  devvit?: { token?: string; entrypoints?: Record<string, string> };
}): void {
  const location = new URL(init.href);
  const win: Record<string, unknown> = {
    location: {
      href: location.href,
      origin: location.origin,
      pathname: location.pathname,
      search: location.search,
    },
    parent: null as unknown,
  };
  if (init.devvit) win.devvit = init.devvit;
  // A window whose `parent` differs from itself reads as "inside Reddit".
  win.parent = {};
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', { href: location.href, origin: location.origin });
  vi.stubGlobal('addEventListener', vi.fn());
  vi.stubGlobal('removeEventListener', vi.fn());
  vi.stubGlobal('setInterval', vi.fn(() => 0));
  // Devvit's wrapped `fetch` reports user-progress back through sessionStorage.
  vi.stubGlobal('sessionStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  vi.stubGlobal('document', {
    currentScript: null,
    getElementsByTagName: () => [],
    addEventListener: vi.fn(),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('client api() request shape', () => {
  it('carries Devvit request token as a query param, not an Authorization header', async () => {
    installWindow({
      href: 'https://lumengrid-game.example.devvit.net/splash.html?token=old',
      devvit: {
        token: 'aaa.bbb.ccc',
        entrypoints: { default: 'https://lumengrid-game.example.devvit.net/splash.html' },
      },
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { api } = await import('../src/client/lib/bridge');
    await expect(api<{ ok: boolean }>('/state')).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);

    expect(parsed.origin).toBe('https://lumengrid-game.example.devvit.net');
    expect(parsed.pathname).toBe('/api/state');
    expect(parsed.searchParams.get('token')).toBe('aaa.bbb.ccc');
    // The auth header is NOT how Devvit authenticates web views.
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('keeps a caller-built query string alongside the token', async () => {
    installWindow({
      href: 'https://app.example.devvit.net/game.html',
      devvit: { token: 't.t.t', entrypoints: { game: 'https://app.example.devvit.net/game.html' } },
    });

    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);

    const { api } = await import('../src/client/lib/bridge');
    await api('/state?day=2026-11-26');

    const parsed = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(parsed.searchParams.get('day')).toBe('2026-11-26');
    expect(parsed.searchParams.get('token')).toBe('t.t.t');
  });

  it('falls back to a same-origin relative call in a local preview (no devvit global)', async () => {
    installWindow({ href: 'http://localhost:5173/splash.html' });

    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);

    const { api } = await import('../src/client/lib/bridge');
    await api('/state');

    const parsed = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(parsed.origin).toBe('http://localhost:5173');
    expect(parsed.pathname).toBe('/api/state');
    expect(parsed.searchParams.has('token')).toBe(false);
  });

  it('uses the entrypoint origin, not the page origin, when the two differ', async () => {
    // The real failure mode: the web view is served from one host and the app
    // server lives on another.  A relative fetch resolves against the former.
    installWindow({
      href: 'https://www.reddit.com/r/lumengrid_game_dev2/',
      devvit: {
        token: 'x.y.z',
        entrypoints: { default: 'https://lumengrid-game.app.devvit.net/splash.html' },
      },
    });

    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);

    const { api } = await import('../src/client/lib/bridge');
    await api('/init');

    const parsed = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(parsed.origin).toBe('https://lumengrid-game.app.devvit.net');
    expect(parsed.origin).not.toBe('https://www.reddit.com');
    expect(parsed.searchParams.get('token')).toBe('x.y.z');
  });

  it('does not silently reuse the page origin when Devvit gave no entrypoints', async () => {
    // `devvit.entrypoints` is `clientData?.appConfig?.entrypoints ?? {}`, so an
    // empty object is reachable.  Substituting the page origin there would
    // recreate the 401 in the one case this code exists to handle — a Reddit
    // page is not the app server.
    installWindow({
      href: 'https://www.reddit.com/r/lumengrid_game_dev2/',
      devvit: { token: 'x.y.z', entrypoints: {} },
    });

    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);

    const { api } = await import('../src/client/lib/bridge');
    await api('/init');

    const parsed = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    // Still carries the token, so the request is at least authenticated, and
    // the caller can see we had no better origin than the page.
    expect(parsed.searchParams.get('token')).toBe('x.y.z');
    expect(parsed.pathname).toBe('/api/init');
  });
});
