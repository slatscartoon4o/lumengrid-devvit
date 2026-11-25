/**
 * Probe: after a player solves *in the page*, does the leaderboard show them?
 *
 * Reading the code suggested a gap.  `SubmitResponse` carries no `top`, and the
 * client merges only `solves` and `histogram` into its community state after a
 * solve.  A player who solves and then taps Leaders therefore renders a
 * top-solvers list built from the pre-solve snapshot.  If their score is good
 * enough to enter the top ten, the one moment they most want to see their name
 * is the moment it is missing.
 *
 * This drives the real UI — real taps on the real board — and then reads the
 * list without reloading, because reloading is the thing a player does not do.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 41741;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/init`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

/** Walk the hint endpoint to a full solution — the engine's own answer. */
async function fetchSolution(date) {
  const placements = new Array(64).fill(0);
  for (let step = 0; step < 12; step++) {
    const res = await fetch(`${BASE}/api/hint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date, placements }),
    });
    const hint = await res.json();
    if (!hint.found) break;
    placements[hint.cellIndex] = hint.code;
  }
  return placements;
}

async function clickCell(page, x, y) {
  const box = await page.getByTestId('optics-board').boundingBox();
  if (!box) throw new Error('board not on screen');
  const cell = box.width / 8;
  await page.mouse.click(box.x + x * cell + cell / 2, box.y + y * cell + cell / 2);
}

/** Replay a placement list through the real board, exactly as a player would. */
async function playSolution(page, placements, pauseMs = 150) {
  for (let index = 0; index < placements.length; index++) {
    const code = placements[index];
    if (!code) continue;
    const splitter = code === 3 || code === 4;
    const taps = code === 1 || code === 3 ? 1 : 2;
    await page.getByTestId(splitter ? 'tool-splitter' : 'tool-mirror').click();
    await clickCell(page, index % 8, Math.floor(index / 8));
    if (taps === 2) {
      await sleep(80);
      await clickCell(page, index % 8, Math.floor(index / 8));
    }
    await sleep(pauseMs);
  }
}

/** Names in the top list, read from the `u/<name>` anchor text only. */
async function topNames(page) {
  return page.getByTestId('leaderboard-top').locator('li').evaluateAll((lis) =>
    lis.map((li) => {
      const span = li.querySelector('span.truncate');
      return span ? span.textContent.trim().replace(/^u\//, '').replace(/you$/, '').trim() : null;
    }).filter(Boolean)
  );
}

async function main() {
  const server = spawn(process.execPath, ['dist-local/server/local-server.cjs'], {
    env: { ...process.env, LUMENGRID_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (d) => (serverErr += d.toString()));
  if (!(await waitForServer())) {
    console.error('server did not start\n' + serverErr);
    server.kill();
    process.exit(1);
  }

  const init = await (await fetch(`${BASE}/api/init`)).json();
  const date = init.today ?? init.puzzle.id;
  const me = init.profile.username;
  const par = init.puzzle.par;
  const before = init.community.top.map((r) => r.username);
  console.log(`date=${date}  me=${me}  par=${par}`);
  console.log(`top before (${before.length}): ${before.join(', ')}`);
  console.log(`me already in top? ${before.includes(me)}`);

  const placements = await fetchSolution(date);
  console.log(`solution: ${placements.filter((c) => c !== 0).length} elements`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`${BASE}/game.html`);
  await page.getByTestId('game-shell').waitFor({ timeout: 20000 });
  await sleep(600);

  await playSolution(page, placements);
  await sleep(1600);

  const won = await page.getByTestId('victory-modal').isVisible().catch(() => false);
  console.log(`victory modal shown: ${won}`);
  // The modal is a real dialog and blocks the tab bar — dismiss it the way a
  // player does before going to look at the leaderboard.
  if (won) await page.getByTestId('victory-close').click();
  await sleep(500);

  // Tap Leaders — no reload.  This is the real player path.
  await page.getByTestId('tab-board').click();
  await page.getByTestId('leaderboard-panel').waitFor({ timeout: 20000 });
  await sleep(700);

  const after = await topNames(page);
  const inTopLive = after.includes(me);
  console.log(`top after  (${after.length}): ${after.join(', ')}`);
  console.log(`\n>>> me in top WITHOUT reload? ${inTopLive}`);

  let ok = true;
  if (!inTopLive) {
    console.error('FAIL: solved, tapped Leaders, and the player is absent from the top list');
    ok = false;
  }

  // And with a reload, for contrast: a reload changing the answer would mean the
  // live path and the server disagree about who is on the board.
  await page.reload();
  await page.getByTestId('game-shell').waitFor({ timeout: 20000 });
  await page.getByTestId('tab-board').click();
  await page.getByTestId('leaderboard-panel').waitFor({ timeout: 20000 });
  await sleep(700);
  const reloaded = await topNames(page);
  const inTopReloaded = reloaded.includes(me);
  console.log(`top reload (${reloaded.length}): ${reloaded.join(', ')}`);
  console.log(`>>> me in top WITH reload?    ${inTopReloaded}`);

  if (inTopLive !== inTopReloaded) {
    console.error('FAIL: the live path and a reload disagree about the player ranking');
    ok = false;
  }

  if (errors.length) {
    console.error(`FAIL: page errors — ${errors.slice(0, 3).join(' | ')}`);
    ok = false;
  }

  await browser.close();
  server.kill();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
