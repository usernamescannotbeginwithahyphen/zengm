# Basketball GM, Football GM, ZenGM Baseball, and ZenGM Hockey

Single-player sports simulation games. Make trades, set rosters, draft players,
and try to build the next dynasty, all from within your web browser. The games
are implemented entirely in client-side JavaScript, backed by IndexedDB.

Copyright (C) ZenGM, LLC. All rights reserved.

Email: <jeremy@zengm.com>

Website: <https://zengm.com/>

Development: <https://github.com/zengm-games/zengm>

Discussion:

- [Discord](https://zengm.com/discord/)
- Reddit: [Basketball GM](https://www.reddit.com/r/BasketballGM/),
  [Football GM](https://www.reddit.com/r/Football_GM/),
  [ZenGM Baseball](https://www.reddit.com/r/ZenGMBaseball/),
  [ZenGM Hockey](https://www.reddit.com/r/ZenGMHockey/)

## Who is this for?

If you just want to play a game, go to <https://zengm.com/>. Instructions below
are for developers who want to run a copy locally so they can make changes to
the code.

## License and contributor license agreement

**This project is NOT open source, but it is also not completely closed. Please
see [LICENSE.md](LICENSE.md) for details.**

If you want to contribute code to this project, you must sign a contributor
license agreement. There are separate forms for individuals and entities (such
as corporations):

- [Individual CLA](CLA-individual.md) (this is probably what you want)
- [Entity CLA](CLA-entity.md)

Make a copy of the form, fill in your information at the bottom, and send an
email to jeremy@zengm.com with the subject line, "Contributor License Agreement
from YOUR_NAME_HERE (GITHUB_USERNAME_HERE)".

## Setup

First install [Node.js](https://nodejs.org/) 24 and [pnpm](https://pnpm.io/) 11.

Then install the dependencies:

    pnpm install

and start the dev server, which watches the source code for changes:

    node --run dev

The `dev` script will tell you a URL to open in your browser to view the game,
<http://localhost:3000> unless that port is already in use.

By default this builds the basketball version of the game. For other sports, set
the `SPORT` environment variable to `football`, `baseball`, or `hockey`, like:

    SPORT=football node --run dev

### Custom football field length

In this fork, go to **New League > Customize settings > Game Simulation** and
set **Field Length (yards)** to **50** for a shorter indoor-style field. The
default is 100 yards; whole-number lengths from 50 to 150 are supported.
Set **Kickoff Touchback Yard Line** to **10** for an indoor-style starting spot.
Both options are available at league creation without enabling God Mode.
Existing leagues can change them in League Settings with God Mode enabled.

Field length affects the simulation, scoring, possession changes, penalties,
kick distances, and live field display. Kickoff and ordinary touchback spots
scale with field length. End zones remain 10 yards deep; extra points are
snapped 15 yards from goal and two-point attempts from 2 yards. This does not
implement the other arena football rules, such as eight-player teams or nets.
Old leagues and saved play-by-play without a field length use 100 yards.

On Windows PowerShell, start the football version with:

```powershell
$env:SPORT = "football"
node --run dev
```

### Hidden football Starter Score

Football AI teams use one hidden **0–100 Starter Score per player and role**
for depth charts and roster decisions. It combines scouted role ability,
age and potential, current and prior-season performance, recent form,
contract and draft investment, incumbent continuity, and team direction.
A losing rebuilding team gives more weight to a young successor; a winning
team is more inclined to retain a productive veteran. Rookie patience fades
with time and can be overcome by a substantial improvement.

Drafting, free agency, trades, cuts, and re-signing compare the same scores
across each position group. Starting slots receive full weight, backups less,
and surplus depth very little. Positional value weights those improvements;
kickers and punters receive an additional draft discount. Salary caps,
contract affordability, and trade market prices still apply. Scores are
computed for the evaluating team, so another team's investment does not
automatically become the buyer's investment.

The feature is automatic for football AI teams, with no visible rating or
new setting. User-controlled depth charts retain their existing behavior.
Existing leagues work immediately using their recorded stats; subsequent
games also save a small recent-form history in `footballForm`. DNPs do not
count as poor performance, and small samples receive less weight. The final
Starter Score is recalculated rather than saved, keeping it current after
transactions and changes in team goals.

Behavior tests cover veteran continuity, breakouts, rookie patience,
benching and recovery, succession, roster depth, positional draft value,
duplicate free-agent signings, and trades. Defensive performance evidence is
deliberately modest because the game lacks coverage-target data. The weights
are initial tuning, not a guarantee of any particular historical outcome.

The [scenario audit](analysis/starter-score/report.html) contains 55 synthetic
trajectories, weekly score curves, all-position stat checks, and roster-building
comparisons against the original model. It uses the production scorer and depth
sorter with controlled dummy stats, rather than simulating whole leagues.
Recent form retains 82% of its previous value per full appearance, and an
incumbent keeps a minimum continuity bonus even during poor play. There is no
hard minimum starting stint. QB rushing, RB receiving, TE blocking, and recorded
defensive disruptions contribute alongside each role's primary production.

To reproduce the earlier scenario report in PowerShell (this overwrites its
revised dataset with the current scorer):

```powershell
$env:STARTER_SCORE_REPORT_PATH = 'analysis/starter-score/after.json'
pnpm exec vitest run --project football src/worker/core/team/starterScoreScenarios.football.test.ts
Remove-Item Env:STARTER_SCORE_REPORT_PATH
node tools/analysis/renderStarterScoreReport.ts
```

The [generated-league findings](analysis/starter-score/league-findings.md) and
[full league report](analysis/starter-score/league-report.html) exercise the
normal roster generator and autoplay for two independent three-season leagues.
The audit found stable lineups but excessive QB drafting and an MVP award-format
mismatch. The findings include reproducible commands and compressed evidence.
This longer integration experiment is opt-in through
`STARTER_SCORE_LEAGUE_REPORT`; it is skipped by the ordinary test suite.

The [refinement audit](analysis/starter-score/refinement-report.html) and
[interpretation](analysis/starter-score/refinement-findings.md) compare that
baseline with a revised scorer. Proven QB performance now carries more early
season confidence, active injury replacements receive continuity, current-format
MVP awards are recognized, and redundant draft talent receives diminishing
returns. OL block-win grades are calibrated to the simulation's individual
blocking stats; sacks allowed are measured against pass-block opportunities.
The all-position audit captures scores before sorting, checks for stale
observations after the trade deadline, and flags both struggling starters and
productive reserves for review. A flag is not automatically a mistaken lineup.

To regenerate the revised evidence, run the following for each seed (20261005
and 20261006), then analyze both files:

```powershell
$env:STARTER_SCORE_SEED = '20261005'
$env:STARTER_SCORE_YEARS = '3'
$env:STARTER_SCORE_LEAGUE_REPORT = "analysis/starter-score/league-refined-$env:STARTER_SCORE_SEED.json"
pnpm exec vitest run --project football src/test/starterScoreLeague.football.test.ts --disableConsoleIntercept
Remove-Item Env:STARTER_SCORE_LEAGUE_REPORT
# Repeat with seed 20261006, then:
$env:STARTER_SCORE_ANALYSIS_PREFIX = 'league-refined'
node tools/analysis/analyzeStarterScoreLeagues.ts analysis/starter-score/league-refined-20261005.json analysis/starter-score/league-refined-20261006.json
node tools/analysis/reviewStarterScoreDecisions.ts analysis/starter-score/league-refined-20261005.json analysis/starter-score/league-refined-20261006.json
Remove-Item Env:STARTER_SCORE_ANALYSIS_PREFIX
```

Use `STARTER_SCORE_REPORT_PATH=analysis/starter-score/refined-scenarios.json`
with the scenario test to refresh the matching controlled trajectories. The
older `before.json`, `after.json`, and original league evidence remain available
for comparison. Equal seeds do not imply identical later opponents or outcomes
once different AI decisions change the random stream.

### Recruitment audit, October 6, 2026

The [recruitment findings](analysis/starter-score/recruitment-findings.html)
compare four generated leagues and 12 drafts per version. Every first-round
pick records all available prospects and the current roster, so position
distribution can be compared with the talent actually generated. The supplied
real-world position percentages are an approximate reference, not draft quotas.

Draft priority now gives exceptional Starter Scores more talent value relative
to modest improvements at weak positions. Blocked backups retain the previous
ceiling on their talent premium. A young QB can receive additional draft
opportunity behind an aging starter when no comparable young successor exists.
This changes recruitment; the underlying Starter Score and lineup rules remain
unchanged. Regression tests cover a stronger WR versus a smaller OL need,
major holes that still justify need-based drafting, succession without duplicate
investment, and a first-round QB sitting behind a productive veteran.

The revised runs observe the following opening week too: six of 38 first-round
QBs were healthy backups in their actual opener. The baseline has actual games
for only the first two drafted cohorts, so its actual-start percentage is not a
matched comparison. The report distinguishes preseason charts from starts.
WR remains underselected (18 of 384 picks) and multiple-QB drafts increased
from nine to 13, all with the second QB in round three or later. This is a
partial improvement, not a claim of finished position or salary-cap balance.

To reproduce the current version, run the following for each seed 20261005
through 20261008. The baseline used production scorer commit `376be7167`.

```powershell
$env:STARTER_SCORE_RECRUITMENT = '1'
$env:STARTER_SCORE_SEED = '20261005'
$env:STARTER_SCORE_YEARS = '3'
$env:STARTER_SCORE_LEAGUE_REPORT = "analysis/starter-score/league-recruitment-final-$env:STARTER_SCORE_SEED.json"
pnpm exec vitest run --project football src/test/starterScoreLeague.football.test.ts --disableConsoleIntercept
Remove-Item Env:STARTER_SCORE_LEAGUE_REPORT, Env:STARTER_SCORE_RECRUITMENT
# After all four seeds:
$env:STARTER_SCORE_RECRUITMENT_PREFIX = 'league-recruitment-after'
$env:STARTER_SCORE_PACK_RECRUITMENT = '1'
node tools/analysis/auditStarterScoreRecruitment.ts analysis/starter-score/league-recruitment-final-20261005.json analysis/starter-score/league-recruitment-final-20261006.json analysis/starter-score/league-recruitment-final-20261007.json analysis/starter-score/league-recruitment-final-20261008.json
Remove-Item Env:STARTER_SCORE_PACK_RECRUITMENT, Env:STARTER_SCORE_RECRUITMENT_PREFIX
node tools/analysis/compareStarterScoreRecruitment.ts
```

The audit also accepts the checked-in `.json.gz` evidence. These compressed
recruitment files preserve candidate pools, roster checkpoints, QB starts,
draft records and awards; unrelated box-score fields are omitted. They feed
`auditStarterScoreRecruitment.ts`, not the earlier weekly all-position analyzer.
The `league-recruitment-before-*` files preserve the unchanged baseline.

## Other dev info

### Tests

TypeScript and ESLint are used to enforce some coding standards. To run them on
the entire codebase, run:

    node --run lint

Integration and unit tests spread out through the codebase in \*.test.ts files.
Coverage is not great. They can be run from the command line with:

    node --run test

Like the dev command, you can stick `SPORT=football ` or whatever in front of
this command to run it for a non-basketball sport.

### Git workflow

If you want to contribute changes back to the project, first create a fork on
GitHub. Then make your changes in a new branch. Confirm that the tests
(hopefully including new ones you wrote!) and lint scripts all pass. Finally,
send me a pull request.

It's also probably a good idea to [create an issue on
GitHub](https://github.com/zengm-games/zengm/issues) or [send me a
message](https://zengm.com/contact/) before you start working on something. I
don't want you to spend lots of time on something that I don't want to put in
the game!

### Code overview

This is a single-page app that runs almost entirely client-side by storing data
in IndexedDB. The core of the game runs inside a Shared Worker (or a Web Worker
in crappy browsers that don't support Shared Workers), and then each open tab
runs only UI code that talks to the worker. The UI code is in the `src/ui`
folder and the core game code is in the `src/worker` folder. They communicate
through the `toUI` and `toWorker` functions.

The UI is built with React and Bootstrap.

In the worker, data is ultimately stored in IndexedDB, but for performance and
cross-browser compatibility reasons, a cache (implemented in
`src/worker/db/Cache.ts`) sits on top of the database containing all commonly
accessed data. The idea is that IndexedDB should only be accessed for uncommon
situations, like viewing stats from past seasons. For simulating games and
viewing current data, only the cache should be necessary.

The cache is overly complicated because (1) the values it returns are mutable,
so you better not mess with them accidentally, and (2) when you do purposely
mutate a value (like updating a player's stats), you need to remember to always
write it back to the cache manually by calling `idb.cache.*.put`.

In both the worker and UI processes, there is a global variable `self.bbgm`
which gives you access to many of the internal functions of the game from
within your browser.

### Shared Worker debugging

As mentioned above, the core of a game runs in a Shared Worker. This makes
debugging a little tricky. For instance, in Chrome, if you `console.log`
something inside the Shared Worker, you won't see it in the normal JS console.
Instead, you need to go to chrome://inspect/#workers and click "Inspect" under
<http://localhost/gen/worker.js>.

In any browser, if you have two tabs open and you reload one of them, the worker
process will not reload. So make sure you close all tabs except one before
reloading if you want to see changes in the worker.

### Thank you BrowserStack

Shout out to [BrowserStack](https://www.browserstack.com/) for helping with
cross-browser testing.
