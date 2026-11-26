/**
 * `devvit.json` is a build input the TypeScript compiler never reads.
 *
 * A permission block that the schema rejects does not fail `npm test`, `tsc`,
 * `eslint` or `npm run build` — it fails the moment someone runs a Devvit CLI
 * command, which is the worst time to find out.  That is exactly what
 * happened: `permissions.reddit.enableUserFlair` is not a field the schema
 * accepts, so both `oneOf` branches rejected the object and the CLI refused to
 * start with "permissions.reddit is not exactly one from [subschema 0],
 * [subschema 1]".  Nothing in the test suite noticed, because nothing in the
 * test suite read the file.
 *
 * These tests parse the *real* file with the *real* schema the CLI uses, so a
 * wrong key fails here first.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseAppConfigJson } from '@devvit/shared-types/schemas/config-file.v1';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readConfigJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(root, 'devvit.json'), 'utf8')) as Record<string, unknown>;
}

describe('devvit.json', () => {
  it('parses under the same schema the Devvit CLI validates against', () => {
    // `false` = the config must be fully initialised.  Passing `true` here
    // would let missing required fields through, which is the opposite of the
    // point.
    expect(() => parseAppConfigJson(readConfigJson(), false)).not.toThrow();
  });

  it('declares the Reddit scopes that make runAs:"USER" legal', () => {
    // This is the load-bearing permission for the game's central feature: the
    // victory card posts a comment *as the player*.  `Comment.submit` calls
    // `assertUserScope(SUBMIT_COMMENT)` when `runAs` is `'USER'`, and that
    // reads `asUserScopes` out of the build output — which
    // `build-pack/esbuild/dependency-spec-util.js` populates from
    // `permissions.reddit.asUser` and from nothing else.  Drop either entry and
    // the share silently downgrades to an app-authored comment.
    const config = parseAppConfigJson(readConfigJson(), false);
    const scopes = config.permissions.reddit.asUser as number[];

    // The enum is numeric after parsing (SUBMIT_POST = 1, SUBMIT_COMMENT = 2),
    // so assert on the count and let a separate check pin the names.
    expect(scopes).toHaveLength(2);
    const names = (config.json.permissions as { reddit: { asUser: string[] } }).reddit.asUser;
    expect(names).toEqual(expect.arrayContaining(['SUBMIT_POST', 'SUBMIT_COMMENT']));
  });

  it('enables the plugins the server actually calls', () => {
    // Each of these is a build-time gate: if the plugin is not `use`d, the
    // import resolves but the call throws at runtime, on Reddit, in the
    // installed app — not here.
    const config = parseAppConfigJson(readConfigJson(), false);
    expect(config.permissions.redis).toBe(true); // the leaderboard, streaks, solves
    expect(config.permissions.reddit.enable).toBe(true); // comments, posts, flair
    expect(config.server).toBeDefined(); // the Hono server
    expect(config.post?.entrypoints.default).toBeDefined(); // the feed card
  });

  it('keeps the scheduler and the install trigger wired to real routes', () => {
    const config = parseAppConfigJson(readConfigJson(), false);
    expect(config.triggers?.onAppInstall).toBe('/internal/triggers/on-app-install');
    expect(config.scheduler?.tasks['daily-puzzle']?.cron).toBe('0 0 * * *');
    expect(config.scheduler?.tasks['daily-puzzle']?.endpoint).toBe('/internal/triggers/daily-puzzle');
  });

  it('gives every menu item a moderator audience and an endpoint', () => {
    const config = parseAppConfigJson(readConfigJson(), false);
    const items = config.menu?.items ?? [];
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const item of items) {
      expect(item.forUserType).toBe('moderator');
      expect(item.endpoint.startsWith('/internal/menu/')).toBe(true);
    }
  });
});
