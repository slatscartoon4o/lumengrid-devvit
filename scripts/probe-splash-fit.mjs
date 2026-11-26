/**
 * Feed-card fit probe.
 *
 * The showcase captures `splash.html` at 800×640 with a 2× device scale — a
 * size no real Reddit surface ever uses.  In the wild the interactive post is
 * embedded in an iframe roughly 480–512 CSS px tall on desktop, and shorter
 * still on a phone.  `body.no-scroll` hides whatever falls outside that box,
 * so a root container taller than the iframe does not scroll — it silently
 * clips, and the thing that gets clipped is whatever sits last: the Play
 * button.
 *
 * This probe navigates the production bundle at the sizes Reddit actually
 * gives us and asserts, numerically:
 *
 *   1. the Play button is fully inside the viewport,
 *   2. nothing overflows the document (scrollHeight within 2px of clientHeight),
 *   3. the gap between the header block and the footer block is not a void —
 *      a `justify-between` root in a too-tall container pushes the footer to
 *      the floor and leaves a hole in the middle, which is what a judge sees.
 *
 * It is also the anti-regression test for the fix: restoring
 * `min-h-[560px]` turns every assertion red.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 41731;
const BASE = `http://127.0.0.1:${PORT}`;

/** Reuse a server the developer already has running, otherwise start one. */
async function waitForServer(timeoutMs = 1200) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    }
    await sleep(150);
  }
  return false;
}

async function acquireServer() {
  if (await waitForServer()) return null;
  const child = spawn(process.execPath, ['dist-local/server/local-server.cjs'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LUMENGRID_PORT: String(PORT) },
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  const startedAt = Date.now();
  while (Date.now() - startedAt < 40000) {
    if (await waitForServer(500)) return child;
  }
  child.kill();
  throw new Error('the preview server never became ready');
}

/**
 * Sizes a real Reddit web view gives the feed card.
 *
 * `reddit-real-desktop` is not a guess: it is the measured box of
 * `devvit2-custom-post` on `r/lumengrid_game_dev2` (732 × 512), reported back
 * from a real browser session.  The others bracket it — the iframe height is
 * set by Reddit's layout and varies with viewport, so the card has to survive
 * the whole range rather than one number.
 */
const VIEWPORTS = [
  { name: 'reddit-real-desktop', width: 732, height: 512 },
  { name: 'reddit-desktop-embed', width: 640, height: 480 },
  { name: 'reddit-mobile-embed', width: 390, height: 420 },
  { name: 'reddit-mobile-embed-short', width: 390, height: 360 },
];

/** A hole taller than this between header and footer reads as a void. */
const MAX_VOID_RATIO = 0.18;
/** Slack for sub-pixel rounding between scrollHeight and clientHeight. */
const OVERFLOW_SLACK = 2;

const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`  FAIL  ${message}`);
};
const pass = (message) => console.log(`  ok    ${message}`);

async function measure(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, height: b.height, left: b.left, right: b.right, width: b.width };
    };
    const doc = document.documentElement;
    const root = document.getElementById('root');
    const play = document.querySelector('[data-testid="play-button"]');
    const splash = document.querySelector('[data-testid="splash"]');
    const header = splash?.firstElementChild;
    const footer = splash?.lastElementChild;

    /*
     * The largest run of genuinely empty vertical space.
     *
     * Measuring "gap between header and footer" cannot tell a black hole from
     * evenly distributed breathing room — a card with generous padding above
     * and below scores the same as one with a 180px void in the middle.  This
     * composites every visible box into an interval list and takes the biggest
     * uncovered band, which is what the eye actually reads as emptiness.
     */
    let largestVoid = 0;
    let voidAt = null;
    if (splash) {
      const spans = [];
      for (const el of splash.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
        const b = el.getBoundingClientRect();
        // Ignore zero-area box-model artefacts; they are not ink.
        if (b.height >= 1 && b.width >= 1) spans.push([b.top, b.bottom]);
      }
      spans.sort((a, b) => a[0] - b[0]);
      const top = splash.getBoundingClientRect().top;
      const bottom = splash.getBoundingClientRect().bottom;
      let cursor = top;
      for (const [start, end] of spans) {
        if (start > cursor) {
          const run = start - cursor;
          if (run > largestVoid) {
            largestVoid = run;
            voidAt = cursor;
          }
        }
        if (end > cursor) cursor = end;
      }
      if (bottom > cursor) {
        const run = bottom - cursor;
        if (run > largestVoid) {
          largestVoid = run;
          voidAt = cursor;
        }
      }
    }

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollHeight: doc.scrollHeight,
      clientHeight: doc.clientHeight,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      rootBox: rect(root),
      splashBox: rect(splash),
      headerBox: header ? rect(header) : null,
      footerBox: footer ? rect(footer) : null,
      playBox: rect(play),
      largestVoid: Math.round(largestVoid),
      voidAt: voidAt === null ? null : Math.round(voidAt),
    };
  });
}

function check(name, m) {
  const vh = m.viewport.height;
  const tag = `[${name}]`;

  if (!m.playBox) {
    fail(`${tag} no [data-testid="play-button"] in the DOM`);
    return;
  }

  const bottom = Math.round(m.playBox.bottom);
  if (m.playBox.bottom <= vh + 0.5) {
    pass(`${tag} play button bottom ${bottom}px ≤ viewport ${vh}px`);
  } else {
    fail(`${tag} play button bottom ${bottom}px is ${Math.round(m.playBox.bottom - vh)}px BELOW the ${vh}px viewport — clipped`);
  }

  if (m.playBox.top >= -0.5 && m.playBox.height >= 20) {
    pass(`${tag} play button top ${Math.round(m.playBox.top)}px, height ${Math.round(m.playBox.height)}px`);
  } else {
    fail(`${tag} play button not reachable: top ${Math.round(m.playBox.top)}px height ${Math.round(m.playBox.height)}px`);
  }

  const overflow = m.scrollHeight - m.clientHeight;
  if (overflow <= OVERFLOW_SLACK) {
    pass(`${tag} no vertical overflow (scrollHeight ${m.scrollHeight} vs clientHeight ${m.clientHeight})`);
  } else {
    fail(`${tag} overflows vertically by ${overflow}px (scrollHeight ${m.scrollHeight}, clientHeight ${m.clientHeight})`);
  }

  if (m.scrollWidth <= m.clientWidth + OVERFLOW_SLACK) {
    pass(`${tag} no horizontal overflow`);
  } else {
    fail(`${tag} overflows horizontally by ${m.scrollWidth - m.clientWidth}px`);
  }

  /*
   * No single empty band may exceed ~18% of the frame.
   *
   * 18% is chosen from the design, not to make the test pass: three stacked
   * rows (kicker / board+blurb / controls) with 8px gaps and 12px padding
   * genuinely leave slack, and a compact card should spend it evenly.  What it
   * must not do is concentrate it — the pre-fix card had 263px of solid black
   * between the header and the stats on a 512px frame, which is what "the card
   * looks half-empty" meant in the screenshots.
   */
  const limit = Math.round(vh * MAX_VOID_RATIO);
  if (m.largestVoid <= limit) {
    pass(`${tag} largest empty band ${m.largestVoid}px ≤ ${limit}px`);
  } else {
    fail(`${tag} ${m.largestVoid}px of solid empty space at y=${m.voidAt} (limit ${limit}px on a ${vh}px view) — the card reads as half-empty`);
  }

  // The card must actually fill the frame, not float in it.
  if (m.splashBox) {
    const fill = Math.round((m.splashBox.bottom - Math.max(0, m.splashBox.top)) / vh * 100);
    if (fill >= 85) pass(`${tag} card fills ${fill}% of the frame`);
    else fail(`${tag} card only fills ${fill}% of a ${vh}px frame — a visible black band`);
  }
}

async function main() {
  const server = await acquireServer();

  const browser = await chromium.launch();
  try {
    for (const vp of VIEWPORTS) {
      console.log(`\n${vp.name} — ${vp.width}x${vp.height}`);
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      const consoleErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => consoleErrors.push(String(err)));

      await page.goto(`${BASE}/splash.html`, { waitUntil: 'networkidle' });
      // The card is server-driven; wait for the real button rather than a timer.
      await page.waitForSelector('[data-testid="play-button"]', { timeout: 10000 });

      const m = await measure(page);
      check(vp.name, m);
      if (consoleErrors.length) fail(`[${vp.name}] console errors: ${consoleErrors.join(' | ')}`);
      else pass(`[${vp.name}] zero console errors`);

      await context.close();
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log('');
  if (failures.length) {
    console.error(`${failures.length} assertion(s) failed`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`all ${VIEWPORTS.length} viewports fit the feed card`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
