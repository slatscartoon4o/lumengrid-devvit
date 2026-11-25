/**
 * Showcase capture.
 *
 * Drives the *real* production bundle in Chromium and produces everything the
 * Devpost submission needs:
 *
 *   - six screenshots at the sizes judges will look at (feed card, desktop
 *     game, victory card, phone, community studio, leaderboard);
 *   - a 45–58 second H.264 demo video;
 *   - hard layout assertions — no horizontal overflow, no vertical overflow on
 *     desktop, every control reachable — at 1280×800 and 390×844;
 *   - a zero-console-error guarantee.
 *
 * It starts and stops its own copy of the preview server, so `npm run showcase`
 * is the only command a reviewer needs.
 *
 * The board is solved by asking the *server* for hints — the same solver players
 * get — and then the placements are replayed through the UI with real mouse
 * clicks.  Nothing is injected into the page and no state is faked: what the
 * video shows is what a player does.
 */

import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, resolve } from 'node:path';

const PORT = 41731;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = resolve('docs/screenshots');
const DEMO = resolve('docs/demo');
const VIDEO_WORK = resolve('docs/demo/.capture');
const FFMPEG = process.env.LUMENGRID_FFMPEG ?? 'ffmpeg';

const failures = [];
const notes = [];

const fail = (message) => {
  failures.push(message);
  console.error(`  FAIL  ${message}`);
};
const pass = (message) => console.log(`  ok    ${message}`);

/* ------------------------------------------------------------------ server */

function ensureDirs() {
  for (const dir of [SHOTS, DEMO]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  rmSync(VIDEO_WORK, { recursive: true, force: true });
  mkdirSync(VIDEO_WORK, { recursive: true });
}

async function waitForServer(timeoutMs = 40000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    }
    await sleep(300);
  }
  return false;
}

/** Reuse a server the developer already has running, otherwise start one. */
async function acquireServer() {
  if (await waitForServer(1200)) {
    notes.push('reused the preview server already listening on 41731');
    return null;
  }
  const child = spawn(process.execPath, ['dist-local/server/local-server.cjs'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LUMENGRID_PORT: String(PORT) },
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  if (!(await waitForServer())) {
    child.kill();
    throw new Error('the preview server never became ready');
  }
  return child;
}

/* ---------------------------------------------------------------- helpers */

function collectErrors(page, bucket) {
  page.on('console', (message) => {
    if (message.type() === 'error') bucket.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => bucket.push(`pageerror: ${error.message}`));
}

/**
 * Layout assertions shared by every screen.
 *
 * `allowScrollY` is how much vertical scrolling a screen may legitimately have.
 * Desktop is held to zero because judges see it in a fixed 1280×800 frame; a
 * phone is allowed to scroll (thumb-first design), but never sideways.
 */
async function assertLayout(page, label, { allowScrollY = 0 } = {}) {
  const metrics = await page.evaluate(() => {
    const el = document.documentElement;
    return {
      overflowX: el.scrollWidth - el.clientWidth,
      overflowY: el.scrollHeight - el.clientHeight,
    };
  });

  if (metrics.overflowX > 1) fail(`${label}: horizontal overflow ${metrics.overflowX}px`);
  else pass(`${label}: no horizontal overflow (${metrics.overflowX}px)`);

  if (metrics.overflowY > allowScrollY) {
    fail(`${label}: vertical overflow ${metrics.overflowY}px (allowed ${allowScrollY}px)`);
  } else pass(`${label}: vertical ${metrics.overflowY}px (allowed ${allowScrollY}px)`);

  const tiny = await page.evaluate(() =>
    [...document.querySelectorAll('button, [role="tab"], a, input')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.height < 20;
      })
      .map((el) => `${el.tagName.toLowerCase()}(${(el.textContent ?? '').trim().slice(0, 14)})`)
  );
  if (tiny.length > 0) fail(`${label}: ${tiny.length} control(s) under 20px tall — ${tiny.slice(0, 4).join(', ')}`);
  else pass(`${label}: every visible control is at least 20px tall`);
}

/** Ask the hint endpoint for the next element until the board is solved. */
async function planSolution(date) {
  const placements = new Array(64).fill(0);
  for (let step = 0; step < 8; step++) {
    const res = await fetch(`${BASE}/api/hint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date, placements }),
    });
    if (!res.ok) throw new Error(`hint failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    if (!body.found || body.cellIndex === null || body.code === null) break;
    placements[body.cellIndex] = body.code;
  }
  return placements;
}

/** Click one board cell, addressed in grid coordinates. */
async function clickCell(page, x, y) {
  const box = await page.getByTestId('optics-board').boundingBox();
  if (!box) throw new Error('the board is not on screen');
  const cellSize = box.width / 8;
  await page.mouse.click(box.x + x * cellSize + cellSize / 2, box.y + y * cellSize + cellSize / 2);
}

/**
 * Replay a solved placement list through the UI.
 *
 * Tapping an empty socket with the mirror tool drops a `/` mirror; tapping it
 * again rotates to `\`.  Splitters behave the same way.  So a desired code maps
 * to (tool, taps): 1 → mirror×1, 2 → mirror×2, 3 → splitter×1, 4 → splitter×2.
 */
async function playSolution(page, placements, { pauseMs = 200 } = {}) {
  for (let index = 0; index < placements.length; index++) {
    const code = placements[index];
    if (!code) continue;
    const x = index % 8;
    const y = Math.floor(index / 8);
    const splitter = code === 3 || code === 4;
    const taps = code === 1 || code === 3 ? 1 : 2;

    await page.getByTestId(splitter ? 'tool-splitter' : 'tool-mirror').click();
    await clickCell(page, x, y);
    if (taps === 2) {
      await sleep(90);
      await clickCell(page, x, y);
    }
    await sleep(pauseMs);
  }
}

/* ------------------------------------------------------------ app actions */

/**
 * Paint the starter level used by the studio screenshot and the demo.
 *
 * The layout is deliberately a real two-bounce puzzle rather than something
 * that solves itself:
 *
 *   emitter at (1,1) firing **down** · crystal at (4,4)
 *   sockets at (1,3) and (4,3) — a `\` at each turns down→right then right→down
 *
 * Par is 2, and the server's solver proves it before the screenshot is taken.
 * A third socket at (6,6) is a decoy so the board does not look staged.
 */
async function buildSampleLevel(page) {
  const cells = page.locator('[data-testid="ugc-studio"] [role="grid"] button');
  const at = (x, y) => cells.nth(y * 8 + x);

  await page.getByTestId('brush-emitter').click();
  await page.getByRole('button', { name: 'Down', exact: true }).click();
  await at(1, 1).click();

  await page.getByTestId('brush-crystal').click();
  await at(4, 4).click();

  await page.getByTestId('brush-socket').click();
  await at(1, 3).click();
  await at(4, 3).click();
  await at(6, 6).click();
}

/* ------------------------------------------------------------------- main */

async function main() {
  ensureDirs();

  if (!existsSync(resolve('dist-local/client/splash.html'))) {
    throw new Error('dist-local/client is missing — run: npm run build:preview');
  }

  const server = await acquireServer();
  const browser = await chromium.launch();

  try {
    /* ------------------------------------------------------- 1. feed card */
    console.log('\n[1/6] feed card — 800x640');
    {
      const context = await browser.newContext({ viewport: { width: 800, height: 640 }, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors = [];
      collectErrors(page, errors);

      await page.goto(`${BASE}/splash.html`, { waitUntil: 'networkidle' });
      await page.getByTestId('splash').waitFor();
      await page.getByTestId('play-button').waitFor();
      const board = page.getByTestId('splash').locator('svg');
      if ((await board.count()) === 0) fail('feed card: no board preview rendered');
      else pass('feed card: live board preview rendered');
      await sleep(700);

      await assertLayout(page, 'feed card', { allowScrollY: 4 });
      await page.screenshot({ path: join(SHOTS, '1-splash-feed.png') });

      if (errors.length > 0) fail(`feed card: ${errors[0]}`);
      else pass('feed card: zero console errors');
      await context.close();
    }

    const init = await (await fetch(`${BASE}/api/init`)).json();
    const today = init.today;
    const solution = await planSolution(today);
    const used = solution.filter((code) => code !== 0).length;
    if (used === 0) fail('the hint endpoint could not produce a solution for today');
    notes.push(`${today} — hint solver returned a ${used}-element solution`);
    pass(`today's puzzle solved in ${used} elements (par ${init.puzzle.par})`);

    /* ------------------------------------------------- 2. desktop + 3. win */
    console.log('\n[2/6] desktop game — 1280x800');
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors = [];
      collectErrors(page, errors);

      await page.goto(`${BASE}/game.html`, { waitUntil: 'networkidle' });
      await page.getByTestId('optics-board').waitFor();
      await sleep(800);

      const box = await page.getByTestId('optics-board').boundingBox();
      if (!box) fail('desktop: board not rendered');
      else if (box.width < 480) fail(`desktop: board only ${Math.round(box.width)}px wide on a 1280px screen`);
      else pass(`desktop: board is ${Math.round(box.width)}px wide`);

      await assertLayout(page, 'desktop game', { allowScrollY: 0 });
      await page.screenshot({ path: join(SHOTS, '2-game-desktop.png') });

      if (errors.length > 0) fail(`desktop game: ${errors[0]}`);
      else pass('desktop game: zero console errors');

      console.log('\n[3/6] victory + share card — 1280x800');
      // The clock starts on the first placement, so space the clicks out a
      // little — otherwise the card reads "0s", which looks like a broken timer
      // in a screenshot a judge will stare at.
      await sleep(600);
      await playSolution(page, solution, { pauseMs: 1400 });
      await page.getByTestId('victory-modal').waitFor({ timeout: 20000 });

      const heading = (await page.getByTestId('victory-modal').textContent()) ?? '';
      if (!heading.includes('elements')) fail('victory card: element count missing');
      else pass('victory card: shows elements used');
      for (const bad of ['NaN', 'undefined', 'Infinity']) {
        if (heading.includes(bad)) fail(`victory card: stray "${bad}" in the text`);
      }
      // A frozen 0s on the victory card means the clock never started.
      if (/(^|\s)0s(\s|$)/.test(heading)) fail('victory card: the timer read 0s — the run clock never advanced');
      else pass('victory card: the run clock advanced');
      await sleep(900);
      await page.screenshot({ path: join(SHOTS, '3-victory-share.png') });

      // The share text must be spoiler-free: it may carry the element count,
      // but never a cell coordinate or an orientation.
      await page.getByTestId('victory-preview').click();
      const card = (await page.getByTestId('share-card-text').textContent()) ?? '';
      if (/\(\s*\d+\s*,\s*\d+\s*\)/.test(card) || /mirror\s*[/\\]|splitter\s*[/\\]/i.test(card)) {
        fail('share card leaks the solution (coordinates or orientations)');
      } else pass('share card: spoiler-free (counts the score, never the layout)');
      notes.push(`share card text: ${JSON.stringify(card.replace(/\n/g, ' ⏎ '))}`);

      await context.close();
    }

    /* ------------------------------------------------------- 4. mobile game */
    console.log('\n[4/6] mobile game — 390x844');
    {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      const errors = [];
      collectErrors(page, errors);

      await page.goto(`${BASE}/game.html`, { waitUntil: 'networkidle' });
      await page.getByTestId('optics-board').waitFor();
      await sleep(700);

      const box = await page.getByTestId('optics-board').boundingBox();
      if (!box) fail('mobile: board not rendered');
      else if (box.width < 320) fail(`mobile: board only ${Math.round(box.width)}px wide`);
      else pass(`mobile: board is ${Math.round(box.width)}px wide`);

      // The whole board must be visible without scrolling on a phone.
      if (box && (box.y < 0 || box.y + box.height > 844)) {
        fail(`mobile: board spans ${Math.round(box.y)}–${Math.round(box.y + box.height)}, outside the 844px viewport`);
      } else pass('mobile: board fully inside the first screen');

      await assertLayout(page, 'mobile game', { allowScrollY: 60 });
      await page.screenshot({ path: join(SHOTS, '4-game-mobile.png') });

      if (errors.length > 0) fail(`mobile game: ${errors[0]}`);
      else pass('mobile game: zero console errors');
      await context.close();
    }

    /* ---------------------------------------------- 5. community studio */
    console.log('\n[5/6] community studio — 1280x800');
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors = [];
      collectErrors(page, errors);

      await page.goto(`${BASE}/game.html`, { waitUntil: 'networkidle' });
      await page.getByTestId('tab-create').click();
      await page.getByTestId('ugc-studio').waitFor();
      await sleep(350);

      await buildSampleLevel(page);
      await page.getByTestId('ugc-verify').click();
      await page.getByTestId('ugc-verdict').waitFor({ timeout: 15000 });
      await sleep(500);

      const verdict = (await page.getByTestId('ugc-verdict').textContent()) ?? '';
      if (!/Verified/.test(verdict)) fail(`studio: the solver rejected the sample level — ${verdict.slice(0, 80)}`);
      else pass(`studio: solver verified the authored level (${verdict.replace(/\s+/g, ' ').slice(0, 46)})`);

      await assertLayout(page, 'studio', { allowScrollY: 0 });
      await page.screenshot({ path: join(SHOTS, '5-ugc-studio.png') });

      if (errors.length > 0) fail(`studio: ${errors[0]}`);
      else pass('studio: zero console errors');
      await context.close();
    }

    /* ------------------------------------------------------ 6. leaderboard */
    console.log('\n[6/6] leaderboard — 1280x800');
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors = [];
      collectErrors(page, errors);

      await page.goto(`${BASE}/game.html`, { waitUntil: 'networkidle' });
      await page.getByTestId('tab-board').click();
      await page.getByTestId('leaderboard-panel').waitFor();
      await sleep(500);

      const bars = await page.getByTestId('leaderboard-histogram').locator('button').count();
      if (bars < 3) fail(`leaderboard: only ${bars} histogram buckets`);
      else pass(`leaderboard: ${bars} histogram buckets`);

      const rows = await page.getByTestId('leaderboard-top').locator('li').count();
      if (rows === 0) fail('leaderboard: no solvers listed');
      else pass(`leaderboard: ${rows} solvers listed`);

      // Selecting a bar must explain itself rather than silently highlight.
      await page.getByTestId('leaderboard-histogram').locator('button').nth(3).click();
      await sleep(300);
      const explanation = await page.getByTestId('leaderboard-panel').getByText(/would beat/i).count();
      if (explanation === 0) fail('leaderboard: clicking a bar did not explain it');
      else pass('leaderboard: bar selection explains the percentile');

      await assertLayout(page, 'leaderboard', { allowScrollY: 0 });
      await page.screenshot({ path: join(SHOTS, '6-leaderboard.png') });

      if (errors.length > 0) fail(`leaderboard: ${errors[0]}`);
      else pass('leaderboard: zero console errors');
      await context.close();
    }

    /* -------------------------------------------------------- demo video */
    console.log('\n[demo] recording the walkthrough');
    await recordDemo(browser, solution);

    /* ----------------------------------------------------------- summary */
    console.log('\n-----------------------------------------------------------');
    for (const note of notes) console.log(`  · ${note}`);
    if (failures.length > 0) {
      console.error(`\n${failures.length} check(s) failed:`);
      for (const message of failures) console.error(`  FAIL  ${message}`);
      process.exitCode = 1;
    } else {
      console.log('\nAll layout, interaction and console checks passed.');
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }
}

/* -------------------------------------------------------------- recording */

async function recordDemo(browser, solution) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    recordVideo: { dir: VIDEO_WORK, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  const errors = [];
  collectErrors(page, errors);
  const startedAt = Date.now();

  // 1. The feed card, unhurried — this is the first thing a Redditor sees.
  await page.goto(`${BASE}/splash.html`, { waitUntil: 'networkidle' });
  await page.getByTestId('play-button').waitFor();
  await sleep(5000);

  // 2. Expand into the game.
  await page.getByTestId('play-button').click();
  await page.waitForURL(/game\.html/, { timeout: 15000 });
  await page.getByTestId('optics-board').waitFor();
  await sleep(2600);

  // 3. Ask for a hint so viewers see the coaching, then build the solution.
  await page.getByTestId('hint').click();
  await page.getByTestId('hint-text').waitFor({ timeout: 10000 });
  await sleep(3200);

  await playSolution(page, solution, { pauseMs: 2100 });

  // 4. Victory, then copy the share card.
  await page.getByTestId('victory-modal').waitFor({ timeout: 20000 });
  await sleep(4200);
  await page.getByTestId('victory-preview').click();
  await sleep(2600);
  await page.getByTestId('copy-card').click();
  await sleep(1700);
  await page.getByTestId('victory-close').click();
  await sleep(1000);

  // 5. Leaderboard, including one interactive histogram bar.
  await page.getByTestId('tab-board').click();
  await page.getByTestId('leaderboard-panel').waitFor();
  await sleep(1500);
  const bars = page.getByTestId('leaderboard-histogram').locator('button');
  if ((await bars.count()) > 3) await bars.nth(3).click();
  await sleep(4400);

  // 6. Community studio: author a level and have the solver verify it.
  await page.getByTestId('tab-create').click();
  await page.getByTestId('ugc-studio').waitFor();
  await sleep(1900);
  await buildSampleLevel(page);
  await sleep(1300);
  await page.getByTestId('ugc-verify').click();
  await page.getByTestId('ugc-verdict').waitFor({ timeout: 15000 });
  await sleep(4400);

  // 7. Back to the feed card, so the loop closes where it opened.
  await page.goto(`${BASE}/splash.html`, { waitUntil: 'networkidle' });
  await sleep(3600);

  console.log(`  recorded ${((Date.now() - startedAt) / 1000).toFixed(1)}s of interaction`);
  await context.close();

  const raw = readdirSync(VIDEO_WORK).find((name) => name.endsWith('.webm'));
  if (!raw) {
    fail('demo: Playwright produced no video');
    return;
  }
  const source = join(VIDEO_WORK, raw);
  const webm = join(DEMO, 'lumengrid-demo.webm');
  renameSync(source, webm);

  const mp4 = join(DEMO, 'lumengrid-demo.mp4');
  const encoded = await encodeMp4(webm, mp4);
  if (!encoded) return;

  const duration = probeDuration(mp4);
  const mb = (statSync(mp4).size / (1024 * 1024)).toFixed(1);
  notes.push(`demo video: ${mp4} (${mb} MB, H.264, ${duration.toFixed(1)}s)`);
  pass(`demo video encoded — ${mp4} (${mb} MB, ${duration.toFixed(1)}s)`);

  // Devpost asks for a 45–58 second clip.  Anything outside that is a failure,
  // not a judgement call: too short and judges have not seen the loop, too long
  // and it will not be watched.
  if (duration < 45) fail(`demo: video is ${duration.toFixed(1)}s, under the 45s minimum`);
  else if (duration > 58) fail(`demo: video is ${duration.toFixed(1)}s, over the 58s maximum`);

  if (errors.length > 0) fail(`demo: ${errors[0]}`);
  else pass('demo: zero console errors while recording');
}

/** Container duration in seconds, read with ffprobe. */
function probeDuration(file) {
  const probe = FFMPEG.replace(/ffmpeg(\.exe)?$/i, (match) => (match.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));
  const out = spawnSync(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
    encoding: 'utf8',
  });
  const value = Number.parseFloat((out.stdout ?? '').trim());
  return Number.isFinite(value) ? value : 0;
}

/** Convert Playwright's WebM into the H.264 MP4 that Devpost expects. */
async function encodeMp4(source, target) {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', source,
    '-vf', 'scale=1280:800:flags=lanczos,fps=30',
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-preset', 'slow',
    '-crf', '22',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-an',
    target,
  ];
  const ok = await new Promise((resolveRun) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', () => resolveRun(false));
    child.on('exit', (code) => {
      if (code !== 0) console.error(stderr.slice(-600));
      resolveRun(code === 0);
    });
  });

  if (!ok) {
    fail(`demo: ffmpeg could not encode the MP4 (set LUMENGRID_FFMPEG to a full path if it is not on PATH)`);
    return false;
  }
  const bytes = statSync(target).size;
  if (bytes < 200_000) {
    fail(`demo: encoded video looks empty (${bytes} bytes)`);
    return false;
  }
  return true;
}

await main();
