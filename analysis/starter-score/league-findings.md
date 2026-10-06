# Generated-league audit — October 5, 2026

Tested football Starter Score behavior at commit `90dc95b54`. The audit adds observation and reporting code; it does not tune the production AI in response to these results.

## Scope

Two independently generated 32-team football leagues, seeds 20261005 and 20261006, each played 2026–2028 and continued through the 2029 opening day. The normal roster generator, player development, game simulation, injuries, trades, draft, re-signing, retirements and free agency ran. All teams were AI controlled, on 100-yard fields. There were 1,632 regular-season games and 78 playoff games: **1,710 games and 192 team-seasons**.

The standard Node test environment uses placeholder names, so the report identifies players by ID. It uses in-memory IndexedDB and suppresses UI notifications. Ratings and box scores were not injected. This is not an NFL roster import, a stock-AI comparison, or a test of the 50-yard field.

## Lineup stability is encouraging

- 142 changes in the actual starting quarterback between consecutive regular-season games.
- 121 were associated with injury/return from injury; 4 with a roster change; 17 occurred with both quarterbacks available in both pregame snapshots.
- 180 of 192 team-seasons had no healthy QB change. The maximum was two healthy changes in one team-season.
- No healthy A → B → A reversal with only one intervening game.
- All six MVPs retained a starting depth-chart position the following opening day.
- Four healthy changes occurred immediately after the season opener. Low overall churn does not mean every individual decision had enough patience.

“Healthy” is a descriptive availability filter, not proof that performance alone caused a change. Role depth changes are counted independently of injury replacements. Score breakdowns are captured after the AI has established the pregame depth order, so the newly chosen starter may already have the continuity bonus.

### Examples from generated play

- **Brooklyn, 2027, seed 20261006:** rookie QB #2322 (22 years old, 47 overall) started five games, going 0–5 with 746 passing yards, 2 TD and 4 INT. QB #99 replaced him for games 6–12. The rookie returned for game 13 after the alternative also struggled and the rookie had produced additional passing touchdowns off the bench. This is a plausible bench-and-return pattern without weekly oscillation.
- **Chicago, 2027, seed 20261005:** QB #912 lost the job for game 8 at 2–5. QB #128 held it for nine games before #912 regained it in game 17. Again, this is a sustained trial rather than a one-game reversal.
- **Denver, 2028, seed 20261005:** QB #22 was replaced by young QB #2288 after winning the opener while passing for 255 yards, 2 TD and 2 INT. They both had 60 overall. This is a case to review for overly abrupt succession despite the otherwise stable aggregate result.

## Drafting still fails some of the intended roster-building behavior

Quarterbacks accounted for **44 of 192 first-round selections (22.9%)**, about 7.3 per draft. Eight selections occurred with an incumbent who had at least 200 passing attempts and at least +3 performance points in the scorer. That flag alone does not establish a bad pick, but inspection finds clear concerns:

- **Indianapolis, 2027, seed 20261006:** a 26-year-old, 86-overall QB #0 had 3,779 passing yards, 27 TD, 11 INT and 516 rushing yards in 14 starts, with a contract through 2028. The team nevertheless drafted QBs in rounds one and two. Its next opening roster contained four QBs.
- **Las Vegas, 2027, seed 20261006:** 22-year-old QB #2285 had just produced 4,636 passing yards, 35 TD and 6 INT in 17 starts. The team took another first-round QB the next draft.
- Across all rounds, 12 team-draft instances selected multiple QBs. One final-opening roster contained six QBs.
- No kickers or punters were selected in round one. Positional discounts work in this sample, but position balance is still skewed: 57 OL and 44 QB selections versus only 4 WR and 2 TE selections.

The unconditional best-player-available term in `prepareFootballRoster` still adds `incoming.score * ROLE_WEIGHTS[pos] * 0.2`, even when marginal roster improvement is tiny. Its interaction with the draft selection exponent of 40 is a tuning suspect. These runs did not isolate its causal contribution.

## Post-draft free agency looks more defensible

Only two first-round-QB cases were followed by a different QB free-agent signing during that offseason/preseason. Both signed veterans for about $3m, lost their prior primary QBs, and opened with the drafted rookie as the depth leader. These look like backup acquisitions, not expensive attempts to replace the rookie. Additional drafted QBs are tracked separately from those free-agent signings.

## Every role was observed

Changes in starting depth-slot membership over 192 team-seasons were QB 15, RB 22, WR 89, TE 25, OL 165, DL 68, LB 34, CB 11, S 16, K 8, P 3, KR 40 and PR 25. Multi-starter roles have more opportunities for change; the HTML report also divides by compared slots. These are depth-chart membership changes, not every on-field substitution. CB/S stability does not validate coverage evaluation: the engine still lacks the coverage-failure evidence discussed in the earlier scenario audit.

## Integration bug found: MVP recognition

The live award records use `{ name: "Most Valuable Player", actAs: "mvp", rank: 1 }`. The Starter Score recognition code currently checks the older `award.type === "Most Valuable Player"` representation. Therefore the intended MVP-specific bonus was absent in these runs, even though all six MVPs remained starters through the other score components. Earlier synthetic fixtures used the old representation and missed this. A repair must recognize rank-one modern awards as well as legacy awards, without granting the bonus to runners-up.

## Assessment

The single-score approach produced credible lineup stability and several useful benching/recovery patterns. The broader roster-building goal is **not yet met**: redundant quarterback drafting remains substantial. The next changes should address the draft's residual talent value at already-covered roles, repeated investment in young QBs, the award-format mismatch, and the handful of abrupt opening-week decisions. These observations should become regression cases before retuning. More leagues and a stock-AI control would be needed to claim a general improvement in realism.

## Evidence and reproduction

- `league-report.html`: every team's weekly QB decisions, all-position changes, MVP retention and every first-round QB case.
- `league-20261005.json.gz` and `league-20261006.json.gz`: compressed raw observations, generated player histories and transactions.
- `league-summary.json.gz`: derived metrics and weekly histories.

Run one seed in PowerShell (repeat for the other seed):

```powershell
$env:STARTER_SCORE_SEED = '20261005'
$env:STARTER_SCORE_YEARS = '3'
$env:STARTER_SCORE_LEAGUE_REPORT = 'analysis/starter-score/league-20261005.json'
pnpm exec vitest run --project football src/test/starterScoreLeague.football.test.ts --disableConsoleIntercept
Remove-Item Env:STARTER_SCORE_SEED, Env:STARTER_SCORE_YEARS, Env:STARTER_SCORE_LEAGUE_REPORT
```

Regenerate the analysis from the checked-in compressed observations:

```powershell
node tools/analysis/analyzeStarterScoreLeagues.ts analysis/starter-score/league-20261005.json.gz analysis/starter-score/league-20261006.json.gz
```
