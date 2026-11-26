# Devpost submission — LumenGrid

Copy-paste source for the submission form. Every claim below was verified against the source, and
the numbers match `npm test` and `ffprobe` output exactly.

---

## Elevator pitch (one sentence)

A daily optical laser puzzle where eight-by-eight obsidian boards, coloured beams and mirrors are the
same for every player in the world — and the comment you post afterwards tells people how well you did
without telling them how.

---

## Inspiration

Daily puzzle games work because everyone is stuck on the same thing at the same time. But most of them
live outside Reddit, so the conversation happens somewhere else — in a Discord, in a group chat, in a
screenshot posted to a different app.

Reddit already *is* the place where a few hundred thousand people argue about the same thing on the
same day. A daily puzzle belongs there natively, not embedded in it. So the design question was never
"how do we port a puzzle game to Reddit" — it was "what does a puzzle look like when the comment
section is part of the game loop?"

That question drove every decision:

- The share is a **comment in the post you are already reading**, posted as you, spoiler-free.
- The leaderboard ships with a **distribution**, because "am I good at this" is a different question
  from "am I better than the person above me".
- The community can **author levels**, and the server refuses to publish anything it cannot prove
  beatable — so the front page never carries a broken puzzle.

---

## What it does

Every day at 00:00 UTC a new board appears. An emitter fires a coloured beam; one or more crystals
need light of an exact colour; between them sit five to eight optical sockets — the only cells you may
build on. You place mirrors and splitters into those sockets, rotating them until every crystal is
lit.

Beams carry RGB channels and channels superpose. A red beam crossing a green beam is yellow at the
crossing. Crystals ask for a specific mix, so by the weekend you are routing one beam through three
gems while a filter strips the wrong channel out.

Solve it and you get a **Par** badge — 💎 under par, ⚡ exactly on par, ✨ over — a percentile against
everyone else who solved today, and a streak that tiers up into user flair.

### The week is a difficulty curve

| Day | Theme | Par | Crystals | Sockets |
| --- | --- | --- | --- | --- |
| Mon | Warm-up: trace the beam | 2 | 1 | 5 |
| Tue | Two bounces | 2 | 1 | 5 |
| Wed | First split: one beam, two gems | 3 | 2 | 6 |
| Thu | Alchemy: mix two colours | 2–3 | 1 | 6 |
| Fri | Filters: let the right light through | 3 | 2 | 6 |
| Sat | Satellite array: light two gems | 4 | 2 | 7 |
| Sun | Master circuit | 4 | 3 | 8 |

Monday is solvable in two taps by someone who has never played. Sunday is a three-crystal routing
problem with a filter in the path. The curve repeats weekly, so a newcomer can join on any Monday and
be fluent by the weekend.

---

## How we built it

**Devvit Web, not Blocks.** `devvit.json` declares an inline `default` entrypoint (the feed card, which
renders a live board before anyone taps) and a full-screen `game` entrypoint. The server is Hono on
`@devvit/web/server`; the client is React 19. One codebase, four tsconfig projects, no iframe tricks
and no external hosting.

**A shared core that cannot drift.** `src/shared/` — the optics tracer, the solver, the generator, the
share-card builder, the wire contract — compiles unchanged into the client, the Devvit server and the
local preview server. The wire types live in a single file, so changing the API breaks the build
rather than the game.

**Optics.** RGB channels are traced independently and then OR-ed at each cell. A beam that crosses
itself, two beams that cross each other, and a splitter that forks a beam all fall out of the same
loop, because the tracer is a per-channel state machine with a visited set of
`(index × 4 + direction) × 3 + channel`.

**Par is proven, not estimated.** This is the load-bearing decision. Par drives the badge, the
histogram and the leaderboard; if it were a heuristic it would be wrong on some days, and every player
who beat it would be told they did not beat it.

Two things make an *exact* solver affordable inside a request:

1. **The build zone is declared.** Levels list `mounts` — typically five to eight sockets. Exhausting
   `C(8,4)·4⁴` configurations takes a millisecond; the same depth over 64 free cells does not.
2. **Iterative deepening with no heuristic pruning.** `solve()` explores every configuration of size
   `0, 1, …, d−1` before accepting a solution of size `d`, so the returned Par is the true optimum.
   Nothing in the search can rule out a smaller answer.

The 365-day test re-proves this for every day of the season, independently of the generator.

**Hints that respect what you already built.** The hint endpoint does not replay a stored answer. It
re-solves the rest of the board around the player's existing elements, passed to the solver as
`pinned` — which both fixes them in place and removes their cells from the build zone. A hint
therefore *extends* your work instead of contradicting it, even if you built something the level's
author never imagined.

**Anti-cheat.** The client sends its 64 placement codes; the server ignores any claim that the board
is solved and re-runs the tracer itself. Elements outside `mounts`, elements stacked on furniture and
out-of-range codes are all rejected. A first solve drives the streak and the solve count; replaying a
day can improve your score but never double-counts.

**Sound with no assets.** Every cue is a few oscillators and an envelope. The palette is a major
pentatonic scale, so any two cues that overlap are consonant, and each crystal that lights climbs one
scale degree — solving a board resolves into a chord rather than a jingle.

---

## The four Reddit-native features

These are the parts that would not exist if this were a web game with a Reddit skin.

### 1. One-click spoiler-free sharing

The victory card posts a comment **as the player**, in the post they are already reading, via
`reddit.submitComment({ runAs: 'USER' })`. It says how many elements you used and how long you took —
never where you put them.

```
🔆 LumenGrid #025 — ⚡ Perfect Par
🟥🟥  ·  3/3 elements  ·  2m 14s
🔥 4-day streak
Can you light every gem with fewer?
```

The coloured squares are the day's crystal palette — one square per crystal, in the colour each one
needs. A spoiler-free hint at the puzzle's colour theme, and a way for a reader to tell at a glance
whether they played the same board.

### 2. A leaderboard with a distribution, not just a ranking

The histogram is derived from the Redis sorted set rather than a separate counter, so it can never
drift out of step with the board. "Using 4 elements would beat 82% of today's solvers" is computed
live, and clicking a bar tells you what that many elements would have bought you.

### 3. Community levels the server refuses to break

Any player can open **Create**, paint an emitter, a crystal and some sockets, and press *Verify*. The
server runs the same exact solver and refuses to publish anything it cannot prove beatable — so a
subreddit never gets a permanently broken puzzle on its front page. Publishing calls
`reddit.submitCustomPost({ runAs: 'USER' })`, so the level appears as a real interactive post
authored by that player.

### 4. Flair and moderator tooling

Streaks tier up through `Lightbringer` (day 1) → `Beam Rider` (3 days) → `Prism Adept` (7) →
`Lumen Master` (30), and the flair carries the badge (💎 / ⚡ / ✨) plus the streak count. Three subreddit
menu items give moderators *Post today's puzzle*, *Post a community level* and
*Show today's stats*; an `onAppInstall` trigger posts the first puzzle, and a `0 0 * * *` scheduler
task handles every day after. The scheduler only *posts* — it never decides the puzzle, which comes
from `fnv1a("lumengrid:v5:" + date)`.

---

## Polish, measured rather than claimed

The showcase script (`npm run showcase`) drives a real Chromium against the production bundle and
**fails the build** on any of the following:

- a viewport overflows horizontally (390×844 and 1280×800 both asserted)
- the board does not fit a phone's first screen
- any control is smaller than 20px
- the share card leaks a board coordinate
- the victory timer never advanced
- the solver rejects the studio's sample level
- any console error or uncaught exception appears

It writes the six screenshots and re-encodes the demo video. The staged desktop board is not
posed: it is discovered per-day by enumerating socket builds, filtered through the **server's real
solver**, and then re-verified in the real client — so the screenshot can never show a state the
engine does not produce.

Responsive design is one column on a phone and two columns on desktop, per panel — the leaderboard's
ten-row solver list and its chart sit side by side on desktop, because stacking them pushes the last
row off an 800px screen and the whole point of the panel is that the ranking is visible at a glance.

---

## Challenges we ran into

**A hint that solved the board for you.** The first hint implementation replayed a canned solution and
never looked at what the player had already built. Early testing produced the worst possible failure:
press Hint on an empty board and it declares "solved in 1 element (par 3)", then press it again and it
says the current elements block every route. The fix was not a patch on the hint endpoint — it was a
new `pinned` mode in the solver itself, which fixes the player's elements in place and removes their
cells from the build zone, so the search only ever reasons about the part of the board still open.
Six new solver tests and four new API tests cover it.

**Percentage bar heights that silently rendered as nothing.** A `height: X%` bar inside a
`flex flex-col` whose own height depends on its children resolves to zero. The chart drew fine in
isolation and vanished in the real layout. Both charts now compute explicit pixel heights, and the
showcase script measures the rendered pixels of every bar rather than trusting the DOM structure —
which caught a real bug where the `data-testid` had been attached to the button wrapper rather than
the fill.

**Making Par provable at request speed.** An exact solver over a 64-cell board is not affordable.
Declaring `mounts` turned the problem into a nine-cell search, which is cheap enough to run inside a
request and cheap enough to run 365 times in the test suite (28 seconds for the full season).

**Flair that existed but was never granted.** `awardFlair` was written, correct, and completely
unreachable: nothing called it. Every player's streak silently went unbadged. It survived review
because dead-but-correct code looks identical to working code on inspection — and because the tier
thresholds were duplicated in three places (the implementation, the README, the submission draft),
where all three drifted out of step with each other. The fix was to hoist the ladder into one exported
pure function, call it from the submit path, and pin its boundaries with a test that fails if the
thresholds move. Verified by reverting the call and watching the new test go red.

**A config file that nothing validated.** `devvit.json` is not TypeScript, so it is the one file in
the project that `tsc`, ESLint and the test suite all pass over. It carried a permission key the
schema does not accept; every local check stayed green, and the failure surfaced only when the CLI
was asked to do something — as `permissions.reddit is not exactly one from [subschema 0],[subschema
1]`, which names the failing subschema and not the offending key. Chasing it down mattered beyond the
crash: the schema's own prose says `asUser` "is not currently in use, please set scope to `user`
instead", which reads as though the two are alternatives. They are not. `build-pack`'s
`dependency-spec-util.js` populates the runtime's `asUserScopes` from `permissions.reddit.asUser` and
reads `scope` nowhere, and `Comment.submit` calls `assertUserScope(SUBMIT_COMMENT)` before it will run
as the player. Had we taken the prose at face value and dropped `asUser`, the game's headline feature
— the comment posted *as you* — would have quietly degraded to an app-authored comment, with no error
on the way. `tests/config.test.ts` now parses the real file with the CLI's own schema.

**The Play button that was 49 pixels below the fold.** Everything the showcase checked, it passed —
because it opened the feed card at 800×640, a size no Reddit surface actually uses. Reddit sizes the
interactive-post iframe itself, and on a real desktop embed that frame is 512px tall. The card's root
carried `min-h-[600px]`, and `body.no-scroll` meant the overflow was clipped rather than scrollable,
so the single most important element on the only screen most judges would ever see — **▶ Play today's
puzzle** — sat at y=561, invisible and unclickable, with 263px of black band above it. It took a
real-device measurement to find, because every local viewport we had tested was taller than the one
Reddit gives us. The fix is structural rather than a nudge: the card is now a three-row grid whose
middle row is `minmax(0,1fr)` and whose preview board is the one element that flexes with the
available height. `npm run probe:splash` now asserts, at 732×512, 640×480, 390×420 and 390×360, that
the Play button is inside the viewport, that nothing overflows, and that no single empty band exceeds
18% of the frame — and restoring the old `min-h` turns eight of those assertions red.

**And then the fix broke something else.** Sizing the board with `aspect-square` inside the grid's
`auto` track looked right in isolation and rendered as a 110×240 column in the real frame — the track
sizes from the item's intrinsic width, which `max-width` does not contribute to, while `height: 100%`
stretches to the track. The board floated in the middle of a tall thin strip. The screenshot that
caught it came from a real device, not from any test we had; the probe was then extended to assert
square-within-2px, width ≥ 120px and full containment, and reverting the fix turns twelve assertions
red. The lesson is not "be careful with grid" — it is that a viewport assertion set is only as good as
the list of things it measures, and the list grew every time a human looked at a picture.

---

## Accomplishments we are proud of

- **Par is exact on all 365 days**, proven by a test that regenerates and re-solves every puzzle
  independently of the generator.
- **The hint never contradicts the player**, because it is a solver constraint rather than a stored
  answer.
- **The share card cannot spoil**, and the showcase asserts that no coordinate ever reaches it.
- **A community level cannot be published broken**, because the server re-proves every submission.
- **The feed card is verified at the sizes Reddit actually gives it** — down to a 360px phone embed —
  and the Play button is asserted to be inside the frame at every one of them, after a real-device
  measurement caught it 49px below the fold.
- **The flair ladder lives in exactly one function**, is called from the solve path, and has its
  boundaries pinned by a test — after an audit found it defined but never granted.
- **100 automated tests**, including an optics suite cross-checked against brute force and a full
  season sweep of the daily generator.

---

## What we learned

Declaring the build zone (`mounts`) was worth more than any solver optimisation. It turned an
intractable exactness problem into a cheap one, and the exactness is what the whole social layer rests
on — you cannot run a fair histogram, a meaningful badge or a percentile against an estimated Par.

The second lesson was that a hint is a *solver* problem, not a *content* problem. The instinct is to
store a solution per level and reveal it one step at a time. That fails the moment a player builds
something the author did not imagine. Re-solving the open part of the board around the player's fixed
elements costs one solver option and is correct in every case.

The third lesson came out of the flair audit: **a fact written down in three places is a fact that
will be wrong in two of them.** The tier thresholds existed as source code, as README prose and as
submission copy, and the copy had drifted one tier out of step. The durable fix is not "be more
careful when writing docs" — it is to have one exported function that is the single source of truth,
and a test whose only job is to fail if it changes. Anything a document quotes should be something a
test already asserts.

---

## What's next

The season is generated to 2026-11-01 + 365 days. Next is making the community side deeper: a
browsing view for community levels, per-author par accuracy, and a weekly digest posted by the
scheduler that surfaces the hardest board of the week and the players who matched par on it.

---

## Built with

`Devvit Web` · `@devvit/web` 0.15.6 · `React` 19.3 · `Hono` 4.13 · `TypeScript` 6.0 · `Vite` 8 ·
`Tailwind CSS` 4.3 · `Vitest` · `Playwright` · `Redis` (Devvit-managed)

---

## Repository

Public: <https://github.com/slatscartoon4o/lumengrid-devvit>

Local preview needs no Reddit account:

```bash
npm install
npm run build:preview
npm run preview   # http://127.0.0.1:41731
```

The local server implements the same `GameAdapter` interface as the Devvit one over an in-memory store
seeded with ~200 realistic community solves, so the leaderboard, histogram, percentile and streak
maths are exercised exactly as they will be on Reddit.
