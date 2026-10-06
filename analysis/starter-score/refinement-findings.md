# Starter Score refinement: decisions, holds, and remaining judgment calls

The revised mechanic is more credible, but these runs do not establish perfect
roster decisions. The strongest improvements are reduced redundant QB drafting,
more patience with proven early-season starters, continuity for injury cover,
and better interpretation of offensive-line statistics.

The [interactive review](refinement-report.html) has a role filter, every flagged
hold, healthy depth-slot changes, pre-decision scores, and opportunity counts.
The [revised league report](league-refined-report.html) includes every team's
weekly QB history and draft choices. Original evidence remains in
[the earlier findings](league-findings.md) and [original report](league-report.html).

## How I judged the original switches

The sustained slumps and reversals after substantial stretches of games were
plausible. Chicago's original 2027 change followed seven games, with a return
nine games later. That is meaningfully different from alternating starters
after every poor outing. Injury-associated starts also need to be distinguished
from deliberately replacing the depth-chart leader.

The four healthy changes after only one game were the least convincing.
Denver's original 2028 veteran lost the job after an opening win with
25/36 passing, 255 yards, two TDs and two interceptions. The successor was
promising, but the new game's evidence displaced too much prior success.
The exact old Denver situation is now a regression test: the veteran retains
the job. Later generated Denver seasons are different stochastic histories,
not a replay of that exact game.

## Changes made

- An established previous season supplies extra confidence early in the new
  season. That extra confidence fades over eight full-game equivalents of
  opportunities. Recent form also ramps in over four equivalents, rather than
  immediately diluting a successful prior season with a near-neutral form estimate.
- A proven QB can receive up to two additional continuity points from prior
  success, reduced by new evidence and rebuilding priorities. This remains part
  of the same bounded 0–100 score. There is no fixed minimum starting stint.
- The highest available players on the existing depth chart receive continuity
  while covering injuries. Previously, healthy backups competing behind an
  injured QB had no incumbent preference. Availability follows the game's
  play-through-injuries rules.
- The MVP bonus recognizes current `actAs: "mvp", rank: 1` records as well as
  legacy awards. Runners-up do not get the winner's bonus.
- The draft's extra talent value now receives the same diminishing returns as
  the candidate's place in the position group. A third QB no longer receives an
  unconditional talent premium. Exceptional upgrades remain possible, and
  positional importance still weights team decisions.
- OL block wins use a 60% neutral baseline instead of 70%. In the intermediate
  generated sample, 50–59-rated starting linemen averaged about 60% and 66%
  across the two leagues. The engine records individual block contests, not a
  real-world team protection-success statistic. Sacks allowed are penalized
  against pass-block attempts: `70 × sacks allowed / pass-block attempts`.
  Running more no longer dilutes the same pass-protection failure.

The controlled tests rejected a blanket increase in QB continuity: it protected
a struggling rookie too long and blocked a credible breakout. Lowering the OL
baseline alone also failed the sustained-sack scenario; the final sack treatment
corrects that. Those intermediate versions are not the final scorer.

## Final generated-league comparison

Both versions use two generated 32-team leagues, seeds 20261005 and 20261006,
three seasons per league, and a 100-yard field. Each version covers 192
team-seasons and 1,710 games, including playoffs. These are game-generated
fictional rosters. Changed decisions change subsequent random draws, so this is
not a paired comparison of identical later games or players.

| Measure                                               | Original | Revised |
| ----------------------------------------------------- | -------: | ------: |
| Healthy QB changes during the regular season          |       17 |       9 |
| Healthy QB changes after just the opener              |        4 |       1 |
| Immediate healthy A → B → A reversals                 |        0 |       0 |
| Maximum healthy QB changes in a team-season           |        2 |       1 |
| First-round QBs across six drafts                     |       44 |      12 |
| Team-drafts selecting multiple QBs, all rounds        |       12 |       2 |
| First-round QB picks with a productive-incumbent flag |        8 |       0 |
| MVPs still starting at the following opener           |      6/6 |     6/6 |

The productive-incumbent flag requires 200 passing attempts and at least +3
performance points. Zero flags does not prove every draft choice is optimal.
There was one first-round kicker, Phoenix at pick 31 in 2028, and no
first-round punters. The specialist discount is not a categorical ban.

The remaining opener benching was Atlanta in 2027, seed 20261006. Its 31-year-old
QB #729 went 26/45 for 186 yards, one TD and four interceptions. Before the
decision, his score was 59.59 including continuity; 23-year-old #59 scored 60.84.
The team was rebuilding and already had a close competition. This is more
defensible than the original Denver switch, but still an aggressive judgment
call. The model deliberately permits it rather than enforcing a cooldown.

## Other positions and possible missed changes

The audit examined 42,432 team-role decisions, including decisions to keep a
starter. There were zero instances of an available reserve having a higher
pre-sort score than a selected starter. This verifies execution, not the
correctness of every underlying score.

| Role | Healthy starting-depth slot replacements |
| ---- | ---------------------------------------: |
| QB   |                                        9 |
| RB   |                                       11 |
| WR   |                                       93 |
| TE   |                                       21 |
| OL   |                                      139 |
| DL   |                                       71 |
| LB   |                                       22 |
| CB   |                                       13 |
| S    |                                        9 |
| K    |                                        1 |
| P    |                                        0 |
| KR   |                                       31 |
| PR   |                                       10 |

These exclude injury-associated changes and newly acquired replacements.
They count membership in the starting depth slots, not reorderings within a
multi-player unit or every on-field substitution. There are five starting OL,
three WR, and four DL; their totals should not be compared directly with one QB.

**A plausible OL change:** San Francisco, 2026, seed 20261005, promoted #301
over #313 before game eight. The incumbent had allowed eight sacks in 255 pass
blocks, with a −6.72 performance contribution. His score was 48.09; the younger
reserve scored 49.54. The reserve's six blocking opportunities supplied only
+0.11 performance points. This was a response to sustained failure plus the
reserve's developmental value, not an outsized reward for a tiny cameo.

**A reasonable QB hold:** Charlotte, 2026, seed 20261006, kept 22-year-old #32
despite poor production. Before the finale he had 11 passing TDs, nine
interceptions, 204 rushing yards and two rushing TDs. The higher-rated,
33-year-old backup had also been inefficient in his opportunities. Rookie
investment and rebuilding priorities explain the choice; overall alone would
have favored the veteran.

**An arguable missed TE change:** Houston, 2027, seed 20261005, retained
22-year-old #2289 through the finale. Reserve #420 produced 380 receiving yards
on 40 targets versus the starter's 378 on 63, and the combined receiving/blocking
performance contributions were +3.91 versus −4.37. The starter still scored
53.99 to 48.35 because of stronger attributes, potential and second-round
investment. Both had meaningful opportunities. This is a real example of
developmental patience potentially going too far, and a useful next tuning
target. It is not a selection bug or a reason to remove all rookie patience.

**A misleading RB “miss”:** Miami, 2028, seed 20261006, had a productive
35-year-old reserve #658 behind 25-year-old #1120. Before game 12, the veteran
had 387 rushing yards and 553 receiving yards; the starter had 377 and 160.
Receiving mattered substantially in the veteran's score. The rebuilding age
penalty left him narrowly behind, 53.07 to 53.86. But he already had 160
rushing-plus-target opportunities to the starter's 132. He was heavily involved
despite the depth label. Simply counting starts would misdiagnose this case.

The review includes 310 player-pair cases flagged for sustained poor starter
production with a reasonably comparable reserve, plus 97 weekly flags for
productive reserves. Many flags span repeated weeks or reflect two mediocre
alternatives. They are inspection candidates, not 407 established mistakes.
The 46 flagged QB-hold weeks contained no reserve with even one full-game
equivalent of positive current-season measured performance.

Defensive interpretation remains limited: quiet CB/S statistics are not negative
coverage evidence, and DL/LB production has a modest negative floor. Zero
poor-production flags at those roles follows the conservative grading rules;
it does not prove there are no missed defensive changes. Return roles use their
own return opportunities; general offensive fumbles are not falsely assigned
to returns.

## Controlled checks and validation

The final [controlled trajectories](refined-scenarios.json) retain these results:

- Proven veteran, sustained slump: replaced after eight games.
- Unproven QB, sustained slump: replaced after three games.
- Two poor games followed by recovery: no change.
- Struggling first-rounder with viable veteran reserve: replaced after eight games.
- Struggling first-rounder with weak reserve: retains the job.
- Sustained OL protection failure, three sacks per 35 pass blocks: replaced after eight games.
- Maximum changes across the 30 QB stress scenarios: three in 17 games.

The ordinary suite passes 557 tests with 13 skipped. Both opt-in final
three-season runs pass, including a fresh-observation check across the trade
deadline. Repository lint/type checks and the football production build pass.
The observer's initial trade-deadline mistake was corrected and those stale
captures were replaced; no conclusions here use that stale evidence.

See the repository README for reproduction commands. Raw final evidence is in
`league-refined-20261005.json.gz` and `league-refined-20261006.json.gz`; derived
decision details are in `league-refinement-decisions.json.gz`. The sample is
small, the review thresholds are heuristic, and long-term cap/dynasty balance
and 50-yard-field tuning were not established by this experiment.
